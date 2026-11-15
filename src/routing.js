import { haversine, nearest } from './geo.js';
import { CircuitBreaker, CircuitOpenError, ExternalApiError, RouteCache, withTimeout } from './resilience.js';

// Deterministic stand-in for sidewalk data: ~14 % of segments have stairs / steep slope / no kerb ramp.
function hashPct(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % 100;
}
export const STEP_FREE_THRESHOLD = 14;

/**
 * Simulated road network. Nodes are districts + assembly points; edges are built
 * with a minimum spanning tree (guarantees connectivity) plus k-nearest neighbours.
 */
export class RoadGraph {
  constructor(nodes, { k = 3 } = {}) {
    this.nodes = new Map(nodes.map((n) => [n.id, { id: n.id, lat: n.lat, lng: n.lng }]));
    this.edges = new Map(); // id -> {id,a,b,length,closed,congestion}
    this.adj = new Map([...this.nodes.keys()].map((id) => [id, []]));
    this.#build(k);
    this.buildMatrix();
  }

  #addEdge(a, b) {
    const key = [a, b].sort().join('~');
    if (this.edges.has(key)) return;
    const length = haversine(this.nodes.get(a), this.nodes.get(b));
    this.edges.set(key, { id: key, a, b, length, closed: false, congestion: 1, stepFree: hashPct(key) >= STEP_FREE_THRESHOLD });
    this.adj.get(a).push(key);
    this.adj.get(b).push(key);
  }

  #build(k) {
    const ids = [...this.nodes.keys()];
    if (ids.length < 2) return;
    // Prim MST
    const inTree = new Set([ids[0]]);
    while (inTree.size < ids.length) {
      let best = null;
      for (const a of inTree) {
        for (const b of ids) {
          if (inTree.has(b)) continue;
          const d = haversine(this.nodes.get(a), this.nodes.get(b));
          if (!best || d < best.d) best = { a, b, d };
        }
      }
      this.#addEdge(best.a, best.b);
      inTree.add(best.b);
    }
    // kNN for redundancy (so closing one road usually leaves an alternative)
    for (const a of ids) {
      ids
        .filter((b) => b !== a)
        .map((b) => ({ b, d: haversine(this.nodes.get(a), this.nodes.get(b)) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, k)
        .forEach(({ b }) => this.#addEdge(a, b));
    }
  }

  /**
   * Static backup data: all-pairs shortest paths over the road network with every road OPEN
   * (Floyd-Warshall, computed once at start-up). It answers route questions with no external call and no search;
   * callers must still check the result against CURRENT closures (see RoutingService).
   */
  buildMatrix() {
    const ids = [...this.nodes.keys()];
    const n = ids.length;
    const idx = new Map(ids.map((id, i) => [id, i]));
    const dist = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
    const next = Array.from({ length: n }, () => Array(n).fill(-1));
    for (const e of this.edges.values()) {
      const a = idx.get(e.a); const b = idx.get(e.b);
      dist[a][b] = dist[b][a] = e.length; next[a][b] = b; next[b][a] = a;
    }
    for (let i = 0; i < n; i++) next[i][i] = i;
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (dist[i][k] + dist[k][j] < dist[i][j]) { dist[i][j] = dist[i][k] + dist[k][j]; next[i][j] = next[i][k]; }
    }
    this.matrix = { ids, idx, dist, next };
  }

  matrixPath(fromId, toId) {
    const m = this.matrix;
    const a = m?.idx.get(fromId); const b = m?.idx.get(toId);
    if (a == null || b == null || m.next[a][b] === -1) return null;
    const nodeIds = [fromId];
    const edgeIds = [];
    let cur = a;
    while (cur !== b) {
      const nx = m.next[cur][b];
      edgeIds.push([m.ids[cur], m.ids[nx]].sort().join('~'));
      nodeIds.push(m.ids[nx]);
      cur = nx;
    }
    return { nodeIds, edgeIds, length: m.dist[a][b] };
  }

  getEdge(id) {
    return this.edges.get(id) ?? null;
  }

  setClosed(id, closed) {
    const e = this.edges.get(id);
    if (!e) return null;
    e.closed = closed;
    return e;
  }

  setStepFree(id, stepFree) {
    const e = this.edges.get(id);
    if (!e) return null;
    e.stepFree = !!stepFree;
    return e;
  }

  setCongestion(id, factor) {
    const e = this.edges.get(id);
    if (!e) return null;
    e.congestion = Math.max(1, factor);
    return e;
  }

  nearestNode(pos) {
    return nearest(pos, [...this.nodes.values()])?.item ?? null;
  }

  listEdges() {
    return [...this.edges.values()].map((e) => ({
      id: e.id,
      closed: e.closed,
      stepFree: e.stepFree,
      congestion: e.congestion,
      from: this.nodes.get(e.a),
      to: this.nodes.get(e.b),
    }));
  }

  /** Dijkstra. useTraffic=true weights edges by congestion (live data); false = static lengths. */
  shortestPath(fromId, toId, { useTraffic = true, accessible = false } = {}) {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    const dist = new Map([[fromId, 0]]);
    const prev = new Map();
    const done = new Set();
    while (true) {
      let u = null;
      let best = Infinity;
      for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; u = id; }
      if (u === null) return null;
      if (u === toId) break;
      done.add(u);
      for (const eid of this.adj.get(u)) {
        const e = this.edges.get(eid);
        if (e.closed || (accessible && !e.stepFree)) continue; // accessible mode: only step-free segments
        const v = e.a === u ? e.b : e.a;
        if (done.has(v)) continue;
        const w = e.length * (useTraffic ? e.congestion : 1);
        const nd = best + w;
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { u, eid }); }
      }
    }
    const nodeIds = [toId];
    const edgeIds = [];
    let cur = toId;
    while (cur !== fromId) {
      const p = prev.get(cur);
      edgeIds.unshift(p.eid);
      nodeIds.unshift(p.u);
      cur = p.u;
    }
    const length = edgeIds.reduce((s, id) => s + this.edges.get(id).length, 0);
    return { nodeIds, edgeIds, length };
  }
}

const WALK_M_PER_MIN = 80; // ~4.8 km/h

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * Routing facade that survives the failure of the external map/routing API (HTTP 503, network error, or no answer
 * within the deadline). Order of preference for every request:
 *   external  live API (traffic-aware), guarded by a circuit breaker and a hard deadline
 *   cache     the last successful route between the same two network nodes (only if every segment is still usable)
 *   matrix    static all-pairs matrix computed from the local road network (only if every segment is still usable)
 *   local     live search on the local road graph with the CURRENT closures / step-free limits
 * Only when no tier finds a way is the point reported as unreachable. route() never throws.
 */
export class RoutingService {
  constructor(graph, chaosState, { timeoutMs = 1500, now = () => Date.now(), breaker, cache } = {}) {
    this.graph = graph;
    this.chaos = chaosState; // live reference: {mode, externalDown, externalLatencyMs}
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.breaker = breaker ?? new CircuitBreaker({ now });
    this.cache = cache ?? new RouteCache({ now });
    this.resetStats();
  }

  resetStats() {
    this.stats = { bySource: { external: 0, cache: 0, matrix: 0, local: 0, error: 0, blocked: 0 }, internalErrors: 0, lastFallbackAt: null, lastSource: null };
  }

  reset() { this.breaker.reset(); this.cache.clear(); this.resetStats(); }

  /** Simulated external provider. Honours the chaos switches (503 / network error / slow answer). */
  async #external(fromId, toId, opts) {
    const c = this.chaos;
    const mode = c.mode ?? (c.externalDown ? 'http503' : 'ok');
    if (c.externalDown || mode === 'http503') throw new ExternalApiError('http', 503, 'Service Unavailable');
    if (mode === 'error') throw new ExternalApiError('network', 0, 'ECONNRESET');
    const latency = c.externalLatencyMs > 0 ? c.externalLatencyMs : mode === 'slow' ? 6000 : 0;
    if (latency > 0) await sleep(latency);
    return this.graph.shortestPath(fromId, toId, { useTraffic: true, ...opts });
  }

  /** A remembered / precomputed path is only usable if every segment is open now (and step-free when required). */
  #usable(path, accessible) {
    return path.edgeIds.every((id) => { const e = this.graph.getEdge(id); return e && !e.closed && (!accessible || e.stepFree); });
  }

  /** @returns {Promise<{source:string, blocked:boolean, geometry:Array, distanceM:number, etaMin:number, degraded:boolean}>} */
  async route(origin, target, { accessible = false } = {}) {
    try {
      const r = await this.#route(origin, target, accessible);
      this.stats.bySource[r.blocked ? 'blocked' : r.source] += 1;
      this.stats.lastSource = r.source;
      if (r.source !== 'external') this.stats.lastFallbackAt = this.now();
      return r;
    } catch (err) {
      // defence in depth: a bug in a fallback tier must not take a citizen request down
      this.stats.internalErrors += 1; this.stats.bySource.error += 1; this.stats.lastSource = 'error';
      console.error('[routing] unexpected failure, reporting the point as unreachable:', err?.message ?? err);
      return { source: 'error', blocked: true, degraded: true, geometry: [], distanceM: Infinity, etaMin: Infinity };
    }
  }

  async #route(origin, target, accessible) {
    const start = this.graph.nearestNode(origin);
    const end = this.graph.nodes.get(target.id) ?? this.graph.nearestNode(target);
    const key = `${start.id}|${end.id}|${accessible ? 1 : 0}`;
    let path = null;
    let source = 'external';
    let ageMs = null;
    let reason = null;
    try {
      path = await this.breaker.call(() => withTimeout(this.#external(start.id, end.id, { accessible }), this.timeoutMs));
      if (path) this.cache.set(key, { ...path }); // remember the last good route
    } catch (err) {
      reason = err instanceof CircuitOpenError ? 'circuit_open' : err?.kind ?? 'error';
      // each tier is guarded on its own: a bug in one must fall through to the next, never to the user
      const guarded = (fn) => { try { return fn(); } catch (e) { this.stats.internalErrors += 1; console.error('[routing] fallback tier failed:', e?.message ?? e); return null; } };
      const hit = guarded(() => this.cache.get(key));
      if (hit && guarded(() => this.#usable(hit.value, accessible))) { path = hit.value; source = 'cache'; ageMs = hit.ageMs; }
      if (!path && !accessible) {
        const m = guarded(() => this.graph.matrixPath(start.id, end.id));
        if (m && guarded(() => this.#usable(m, false))) { path = m; source = 'matrix'; }
      }
      if (!path) { path = this.graph.shortestPath(start.id, end.id, { useTraffic: false, accessible }); source = 'local'; }
    }
    const degraded = source !== 'external';
    if (!path) return { source, blocked: true, degraded, reason, geometry: [], distanceM: Infinity, etaMin: Infinity };
    const geometry = [
      { lat: origin.lat, lng: origin.lng },
      ...path.nodeIds.map((id) => ({ lat: this.graph.nodes.get(id).lat, lng: this.graph.nodes.get(id).lng })),
      { lat: target.lat, lng: target.lng },
    ];
    const distanceM = Math.round(
      haversine(origin, this.graph.nodes.get(start.id)) + path.length + haversine(this.graph.nodes.get(end.id), target),
    );
    return {
      source, degraded, reason, ageSec: ageMs == null ? null : Math.round(ageMs / 1000), blocked: false, accessible,
      geometry, distanceM, etaMin: Math.max(1, Math.round(distanceM / WALK_M_PER_MIN)), edgeIds: path.edgeIds,
    };
  }

  /** What the citizen app needs to know about the routes of one response. */
  summarize(routes) {
    const sources = [...new Set(routes.map((r) => r.source))];
    const br = this.breaker.status();
    const degraded = routes.some((r) => r.degraded) || br.state !== 'closed';
    const cacheAges = routes.filter((r) => r.source === 'cache').map((r) => r.ageSec ?? 0);
    return {
      mode: degraded ? 'offline-fallback' : 'online',
      degraded,
      sources,
      breaker: br.state,
      retryInMs: br.retryInMs,
      reason: degraded ? br.lastError?.kind ?? null : null,
      cacheAgeSec: cacheAges.length ? Math.max(...cacheAges) : null,
    };
  }

  /** Dependency health for /api/health and the dispatcher. */
  status() {
    const br = this.breaker.status();
    return {
      // the mode follows the circuit: the moment a trial call succeeds the service is online again
      mode: br.state !== 'closed' ? 'offline-fallback' : 'online',
      breaker: br,
      cacheSize: this.cache.size,
      served: { ...this.stats.bySource },
      internalErrors: this.stats.internalErrors,
      timeoutMs: this.timeoutMs,
    };
  }
}
