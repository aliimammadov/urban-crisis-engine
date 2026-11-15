import { haversine, nearest } from './geo.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('ROUTING_TIMEOUT')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Routing facade with graceful degradation:
 *   1. "external" provider (simulated map/traffic API; honours live congestion, can be down/slow)
 *   2. local fallback (static graph, still honours road closures)
 *   3. straight-line estimate (last resort, flagged as such)
 */
export class RoutingService {
  constructor(graph, chaosState, { timeoutMs = 700 } = {}) {
    this.graph = graph;
    this.chaos = chaosState; // live reference: {externalDown, externalLatencyMs}
    this.timeoutMs = timeoutMs;
  }

  async #external(fromId, toId, opts) {
    if (this.chaos.externalDown) throw new Error('EXTERNAL_DOWN');
    if (this.chaos.externalLatencyMs > 0) await sleep(this.chaos.externalLatencyMs);
    return this.graph.shortestPath(fromId, toId, { useTraffic: true, ...opts });
  }

  /** @returns {Promise<{source:string, blocked:boolean, geometry:Array, distanceM:number, etaMin:number}>} */
  async route(origin, target, { accessible = false } = {}) {
    const start = this.graph.nearestNode(origin);
    const end = this.graph.nodes.get(target.id) ?? this.graph.nearestNode(target);
    let path;
    let source = 'external';
    try {
      path = await withTimeout(this.#external(start.id, end.id, { accessible }), this.timeoutMs);
    } catch {
      source = 'fallback';
      path = this.graph.shortestPath(start.id, end.id, { useTraffic: false, accessible });
    }
    if (!path) {
      return { source, blocked: true, geometry: [], distanceM: Infinity, etaMin: Infinity };
    }
    const geometry = [
      { lat: origin.lat, lng: origin.lng },
      ...path.nodeIds.map((id) => ({ lat: this.graph.nodes.get(id).lat, lng: this.graph.nodes.get(id).lng })),
      { lat: target.lat, lng: target.lng },
    ];
    const distanceM = Math.round(
      haversine(origin, this.graph.nodes.get(start.id)) + path.length + haversine(this.graph.nodes.get(end.id), target),
    );
    return { source, blocked: false, accessible, geometry, distanceM, etaMin: Math.max(1, Math.round(distanceM / WALK_M_PER_MIN)), edgeIds: path.edgeIds };
  }
}
