import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CircuitBreaker, CircuitOpenError, ExternalApiError, RouteCache, withTimeout } from '../src/resilience.js';
import { RoadGraph, RoutingService } from '../src/routing.js';
import { createApp } from '../src/app.js';
import { installProcessGuards } from '../src/guards.js';
import * as seed from '../src/seed.js';

const NAS = { lat: 40.4093, lng: 49.8330 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boom = (status = 503) => async () => { throw new ExternalApiError('http', status, 'Service Unavailable'); };

/* ============================== circuit breaker ============================== */
function breaker(opts = {}) {
  const clock = { t: 1_000_000 };
  const b = new CircuitBreaker({ failureThreshold: 3, openMs: 10_000, maxOpenMs: 40_000, now: () => clock.t, ...opts });
  const transitions = [];
  b.on('transition', (t) => transitions.push(`${t.from}>${t.to}`));
  return { b, clock, transitions };
}
const fails = async (b, n) => { for (let i = 0; i < n; i++) await b.call(boom()).catch(() => {}); };

test('breaker: stays closed below the threshold, opens on N consecutive failures, a success resets the streak', async () => {
  const { b, transitions } = breaker();
  await fails(b, 2);
  assert.equal(b.state, 'closed');
  assert.equal(await b.call(async () => 'ok'), 'ok');
  await fails(b, 2);
  assert.equal(b.state, 'closed', 'the success reset the streak');
  await fails(b, 1);
  assert.equal(b.state, 'open');
  assert.deepEqual(transitions, ['closed>open']);
  assert.equal(b.status().lastError.status, 503);
  assert.equal(b.status().lastError.kind, 'http');
});

test('breaker: while open the dependency is NOT called at all (instant CircuitOpenError)', async () => {
  const { b, clock } = breaker();
  await fails(b, 3);
  let called = 0;
  for (let i = 0; i < 5; i++) {
    await assert.rejects(b.call(async () => { called += 1; }), (e) => e instanceof CircuitOpenError && e.retryInMs > 0);
  }
  assert.equal(called, 0);
  assert.equal(b.status().shortCircuited, 5);
  assert.equal(b.status().retryInMs, 10_000);
  clock.t += 4000;
  assert.equal(b.status().retryInMs, 6000);
});

test('breaker: after the cool-down ONE trial call is allowed; success closes, failure re-opens with a longer cool-down (capped)', async () => {
  const { b, clock, transitions } = breaker();
  await fails(b, 3);
  clock.t += 10_000;
  assert.equal(await b.call(async () => 'back'), 'back');
  assert.equal(b.state, 'closed');
  assert.deepEqual(transitions, ['closed>open', 'open>half_open', 'half_open>closed']);

  await fails(b, 3);                      // open again, base cool-down
  clock.t += 10_000; await b.call(boom()).catch(() => {}); // trial fails
  assert.equal(b.state, 'open');
  assert.equal(b.status().retryInMs, 20_000, 'doubled');
  clock.t += 20_000; await b.call(boom()).catch(() => {});
  assert.equal(b.status().retryInMs, 40_000);
  clock.t += 40_000; await b.call(boom()).catch(() => {});
  assert.equal(b.status().retryInMs, 40_000, 'capped at maxOpenMs');
  clock.t += 40_000; await b.call(async () => 1);
  assert.equal(b.currentOpenMs, 10_000, 'a recovery resets the back-off');
});

test('breaker: half-open lets exactly one probe through; concurrent callers are short-circuited', async () => {
  const { b, clock } = breaker();
  await fails(b, 3);
  clock.t += 10_000;
  let release; const slow = new Promise((r) => { release = r; });
  const probe = b.call(() => slow);
  assert.equal(b.state, 'half_open');
  await assert.rejects(b.call(async () => 'second'), CircuitOpenError);
  release('done');
  assert.equal(await probe, 'done');
  assert.equal(b.state, 'closed');
});

test('breaker: a burst of simultaneous failures opens it once; late failures do not extend the cool-down', async () => {
  const { b, transitions } = breaker();
  await Promise.all(Array.from({ length: 8 }, () => b.call(boom()).catch(() => {})));
  assert.equal(b.state, 'open');
  assert.equal(b.status().openCount, 1);
  assert.equal(b.status().failures, 8);
  assert.equal(b.status().retryInMs, 10_000);
  assert.deepEqual(transitions, ['closed>open']);
  b.reset();
  assert.equal(b.state, 'closed');
  assert.equal(b.status().failures, 0);
});

/* ============================== deadline / cache ============================== */
test('withTimeout: an answer slower than the deadline is a timeout error, and the abandoned call can never become an unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = (r) => seen.push(r);
  process.on('unhandledRejection', onUnhandled);
  const late = new Promise((_, rej) => setTimeout(() => rej(new Error('too late')), 60));
  await assert.rejects(withTimeout(late, 20), (e) => e.kind === 'timeout' && e instanceof ExternalApiError);
  assert.equal(await withTimeout(Promise.resolve(7), 20), 7);
  await sleep(120);
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(seen, []);
});

test('RouteCache: TTL expiry, LRU eviction, recency refresh', () => {
  const clock = { t: 0 };
  const c = new RouteCache({ max: 2, ttlMs: 1000, now: () => clock.t });
  c.set('a', 1); c.set('b', 2);
  assert.equal(c.get('a').value, 1);       // a is now the most recent
  c.set('c', 3);                            // evicts b (least recently used)
  assert.equal(c.get('b'), null);
  assert.equal(c.get('a').value, 1);
  clock.t = 1500;
  assert.equal(c.get('a'), null, 'expired');
  assert.equal(c.size <= 2, true);
});

/* ============================== static matrix ============================== */
const mkGraph = () => new RoadGraph([...seed.districts, ...seed.points]);

test('static matrix equals a live shortest-path search for every pair of nodes (it is a faithful backup)', () => {
  const g = mkGraph();
  let pairs = 0;
  for (const a of g.nodes.keys()) for (const b of g.nodes.keys()) {
    const m = g.matrixPath(a, b); const d = g.shortestPath(a, b, { useTraffic: false });
    assert.ok(Math.abs(m.length - d.length) < 1e-6, `${a}->${b}`);
    assert.equal(m.nodeIds[0], a); assert.equal(m.nodeIds.at(-1), b);
    assert.ok(m.edgeIds.every((id) => g.getEdge(id)));
    pairs += 1;
  }
  assert.equal(pairs, g.nodes.size ** 2);
  assert.equal(g.matrixPath('nope', 'nasimi'), null);
});

/* ============================== routing tiers ============================== */
function mk(opts = {}) {
  const graph = mkGraph();
  const chaos = { mode: 'ok', externalDown: false, externalLatencyMs: 0 };
  const clock = { t: 5_000_000 };
  const br = new CircuitBreaker({ failureThreshold: 3, openMs: 10_000, now: () => clock.t });
  const routing = new RoutingService(graph, chaos, { timeoutMs: 40, now: () => clock.t, breaker: br, ...opts });
  const set = (mode) => { chaos.mode = mode; chaos.externalDown = mode === 'http503'; chaos.externalLatencyMs = mode === 'slow' ? 400 : 0; };
  return { graph, chaos, clock, br, routing, set };
}
const P = (id) => seed.points.find((p) => p.id === id);

test('routing: healthy -> external, the route is remembered; an outage then serves the REMEMBERED route (cache) flagged degraded', async () => {
  const { routing, set } = mk();
  const ok = await routing.route(NAS, P('p5'));
  assert.equal(ok.source, 'external'); assert.equal(ok.degraded, false);
  assert.equal(routing.cache.size, 1);
  set('http503');
  const r = await routing.route(NAS, P('p5'));
  assert.equal(r.source, 'cache'); assert.equal(r.degraded, true); assert.equal(r.reason, 'http');
  assert.equal(r.ageSec, 0);
  assert.equal(r.distanceM, ok.distanceM, 'same numbers as the live answer');
  assert.deepEqual(r.geometry, ok.geometry);
});

test('routing: no cached route for the pair -> the static matrix answers (still a full route + distance + ETA)', async () => {
  const { routing, set } = mk();
  set('http503');
  const r = await routing.route(NAS, P('p7'));
  assert.equal(r.source, 'matrix');
  assert.ok(r.geometry.length >= 3 && r.distanceM > 0 && r.etaMin >= 1 && !r.blocked);
});

test('routing: a remembered route over a road that has since been CLOSED is rejected (never send people into a closed road)', async () => {
  const { routing, graph, set } = mk();
  const ok = await routing.route(NAS, P('p5'));
  set('http503');
  graph.setClosed(ok.edgeIds[0], true);
  const r = await routing.route(NAS, P('p5'));
  assert.notEqual(r.source, 'cache');
  assert.ok(!r.blocked && !r.edgeIds.includes(ok.edgeIds[0]), 'the closed road is avoided');
});

test('routing: a matrix path that crosses a closed road is rejected too; the live local graph finds a way around', async () => {
  const { routing, graph, set } = mk();
  set('http503');
  const start = graph.nearestNode(NAS);
  const m = graph.matrixPath(start.id, 'p7');
  graph.setClosed(m.edgeIds[0], true);
  const r = await routing.route(NAS, P('p7'));
  assert.equal(r.source, 'local');
  assert.ok(!r.edgeIds.includes(m.edgeIds[0]));
});

test('routing: accessible (step-free) routes never use the matrix; a remembered accessible route is reused only if still step-free', async () => {
  const { routing, graph, set } = mk();
  const target = P('p5'); // accessible point
  const live = await routing.route(NAS, target, { accessible: true });
  assert.equal(live.source, 'external');
  set('http503');
  const again = await routing.route(NAS, target, { accessible: true });
  assert.equal(again.source, 'cache');
  graph.setStepFree(live.edgeIds[0], false);
  const rerouted = await routing.route(NAS, target, { accessible: true });
  assert.equal(rerouted.source, 'local');
  for (const id of rerouted.edgeIds) assert.equal(graph.getEdge(id).stepFree, true);
});

test('routing: when no tier can find a way the point is reported unreachable — never an exception', async () => {
  const { routing, graph, set } = mk();
  set('http503');
  for (const id of graph.adj.get('p7')) graph.setClosed(id, true);
  const r = await routing.route(NAS, P('p7'));
  assert.equal(r.blocked, true); assert.equal(r.degraded, true);
  assert.equal(r.distanceM, Infinity);
});

test('routing: after N failures the breaker OPENS and the dependency is no longer called (instant answers)', async () => {
  const { routing, br, set } = mk();
  set('http503');
  for (let i = 0; i < 3; i++) await routing.route(NAS, P('p5'));
  assert.equal(br.state, 'open');
  const callsBefore = br.status().calls;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await routing.route(NAS, P('p5'));
  assert.ok(performance.now() - t0 < 200, 'fallback is instant');
  assert.equal(br.status().calls, callsBefore, 'the external API was not touched');
  assert.equal(br.status().shortCircuited, 20);
  assert.equal(routing.status().mode, 'offline-fallback');
});

test('routing: an API that answers after the deadline (>5 s in the brief) counts as an outage: timeout -> fallback -> breaker opens -> instant', async () => {
  const { routing, br, set } = mk();
  set('slow'); // sleeps 400 ms vs a 40 ms deadline here (6 s vs 1.5 s in production)
  const t0 = performance.now();
  const r = await routing.route(NAS, P('p5'));
  assert.ok(performance.now() - t0 < 300, 'did not wait for the slow answer');
  assert.ok(['matrix', 'local'].includes(r.source)); assert.equal(r.reason, 'timeout');
  assert.equal(br.status().lastError.kind, 'timeout');
  await routing.route(NAS, P('p5')); await routing.route(NAS, P('p5'));
  assert.equal(br.state, 'open');
  const t1 = performance.now();
  await routing.route(NAS, P('p5'));
  assert.ok(performance.now() - t1 < 20, 'open circuit: no waiting at all');
});

test('routing: network errors are classified and handled the same way', async () => {
  const { routing, br, set } = mk();
  set('ok'); routing.chaos.mode = 'error';
  const r = await routing.route(NAS, P('p5'));
  assert.equal(r.degraded, true); assert.equal(r.reason, 'network');
  assert.equal(br.status().lastError.kind, 'network');
});

test('routing: recovery. After the cool-down one trial goes to the API; success -> external again and the circuit closes; failure keeps it open', async () => {
  const { routing, br, clock, set } = mk();
  set('http503');
  for (let i = 0; i < 3; i++) await routing.route(NAS, P('p5'));
  assert.equal(br.state, 'open');
  clock.t += 10_000;
  let r = await routing.route(NAS, P('p5'));          // trial, still down
  assert.equal(br.state, 'open'); assert.equal(r.degraded, true);
  assert.equal(br.status().retryInMs, 20_000);
  clock.t += 20_000; set('ok');
  r = await routing.route(NAS, P('p5'));               // trial succeeds
  assert.equal(r.source, 'external'); assert.equal(br.state, 'closed');
  assert.equal(routing.summarize([r]).mode, 'online');
});

test('routing: a bug inside one fallback tier falls through to the next; a bug in ALL of them still never throws', async () => {
  const { routing, graph, set } = mk();
  set('http503');
  const realMatrix = graph.matrixPath.bind(graph);
  graph.matrixPath = () => { throw new Error('matrix exploded'); };
  const silence = console.error; console.error = () => {};
  try {
    const r = await routing.route(NAS, P('p7'));
    assert.equal(r.source, 'local', 'fell through to the live local graph');
    assert.ok(routing.stats.internalErrors >= 1);
    const realSp = graph.shortestPath.bind(graph);
    graph.shortestPath = () => { throw new Error('graph exploded'); };
    const dead = await routing.route(NAS, P('p7'));
    assert.equal(dead.blocked, true); assert.equal(dead.source, 'error');
    graph.shortestPath = realSp;
  } finally { console.error = silence; graph.matrixPath = realMatrix; }
});

test('routing: summarize()/status() describe the mode for the apps', async () => {
  const { routing, set } = mk();
  const ok = await routing.route(NAS, P('p5'));
  assert.deepEqual(routing.summarize([ok]), { mode: 'online', degraded: false, sources: ['external'], breaker: 'closed', retryInMs: 0, reason: null, cacheAgeSec: null });
  set('http503');
  const c = await routing.route(NAS, P('p5')); const m = await routing.route(NAS, P('p7'));
  assert.equal(routing.status().mode, 'online', 'two failures: the circuit is still closed, only these answers are flagged');
  await routing.route(NAS, P('p6'));
  const s = routing.summarize([c, m]);
  assert.equal(s.mode, 'offline-fallback'); assert.deepEqual(s.sources.sort(), ['cache', 'matrix']); assert.equal(s.reason, 'http'); assert.equal(s.cacheAgeSec, 0);
  const st = routing.status();
  assert.equal(st.mode, 'offline-fallback');
  assert.ok(st.served.external === 1 && st.served.cache === 1 && st.served.matrix === 2);
  routing.reset();
  assert.equal(routing.status().served.external, 0); assert.equal(routing.cache.size, 0);
});

/* ============================== whole application ============================== */
function app(opts = {}) {
  const clock = { t: 70_000_000 };
  const a = createApp({ now: () => clock.t, tickMs: 0, historyMs: 0, moveMs: 0, tokenSecret: 'k', routingTimeoutMs: 40, breaker: { failureThreshold: 3, openMs: 10_000 }, ...opts });
  return { ...a, clock };
}

test('application: for EVERY failure mode the citizen request succeeds, flagged offline/backup; numbers match the live ones', async () => {
  for (const mode of ['http503', 'slow', 'error']) {
    const a = app();
    const live = await a.evacuation.recommend(NAS);
    assert.equal(live.routing.mode, 'online');
    a.store.setChaos({ mode });
    if (mode === 'slow') a.store.chaos.externalLatencyMs = 300;
    const r = await a.evacuation.recommend(NAS);
    assert.ok(r.recommendedPointId, mode);
    assert.equal(r.routing.degraded, true, mode);
    assert.equal(r.routing.mode, 'offline-fallback');
    assert.ok(r.points.every((p) => !p.route || p.route.degraded === true || ['cache', 'matrix', 'local'].includes(p.route.source)));
    const liveRec = live.points.find((p) => p.id === live.recommendedPointId);
    const rec = r.points.find((p) => p.id === live.recommendedPointId);
    assert.equal(rec.route.distanceM, liveRec.route.distanceM, `${mode}: same distance from backup data`);
  }
});

test('application: a flood of simultaneous citizen requests during an outage all complete; no unhandled rejection; bounded time', async () => {
  const a = app();
  a.store.setChaos({ mode: 'http503' });
  const seen = []; const on = (r) => seen.push(r); process.on('unhandledRejection', on);
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => a.evacuation.recommend({ lat: NAS.lat + (i % 7) * 0.003, lng: NAS.lng + (i % 5) * 0.003 })));
  await sleep(50); process.off('unhandledRejection', on);
  assert.ok(results.every((r) => r.recommendedPointId && r.routing.degraded));
  assert.deepEqual(seen, []);
  assert.ok(performance.now() - t0 < 2000, `took ${Math.round(performance.now() - t0)} ms`);
  assert.equal(a.breaker.state, 'open');
});

test('application: HTTP — health shows the dependency, admin switches modes, citizens keep being served, recovery is automatic and journalled', async () => {
  const a = app();
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${a.server.address().port}`;
  const call = (method, path, { body, token } = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const evac = async () => { const r = await call('GET', `/api/evacuation?lat=${NAS.lat}&lng=${NAS.lng}`); assert.equal(r.status, 200); return r.json(); };
  try {

  let h = await (await call('GET', '/api/health')).json();
  assert.equal(h.mode, 'online'); assert.equal(h.dependencies.routing.breaker.state, 'closed');
  await evac(); // warm the cache

  assert.equal((await call('POST', '/api/sim/chaos', { body: { mode: 'http503' } })).status, 401);
  assert.equal((await call('POST', '/api/sim/chaos', { body: { mode: 'http503' }, token: 'dispatcher-demo' })).status, 403);
  assert.equal((await call('POST', '/api/sim/chaos', { body: { mode: 'nonsense' }, token: 'admin-demo' })).status, 400);
  const set = await (await call('POST', '/api/sim/chaos', { body: { mode: 'http503' }, token: 'admin-demo' })).json();
  assert.equal(set.mode, 'http503'); assert.equal(set.externalDown, true);

  for (let i = 0; i < 2; i++) { const e = await evac(); assert.equal(e.routing.degraded, true); assert.ok(e.recommendedPointId); }
  h = await (await call('GET', '/api/health')).json();
  assert.equal(h.mode, 'offline-fallback'); assert.equal(h.dependencies.routing.breaker.state, 'open');
  assert.equal(h.dependencies.routing.breaker.lastError.status, 503);
  const dash = await (await call('GET', '/api/dashboard', { token: 'observer-demo' })).json();
  assert.equal(dash.deps.routing.mode, 'offline-fallback');

  a.clock.t += 10_000; // cool-down over
  await call('POST', '/api/sim/chaos', { body: { mode: 'ok' }, token: 'admin-demo' });
  const probe = await evac(); // ONE trial goes to the API; the other routes of this response still come from backup data
  assert.equal(probe.routing.degraded, true);
  assert.ok(probe.recommendedPointId);
  const back = await evac();
  assert.equal(back.routing.mode, 'online');
  assert.equal(back.routing.degraded, false);
  h = await (await call('GET', '/api/health')).json();
  assert.equal(h.dependencies.routing.breaker.state, 'closed');

  const actions = (await (await call('GET', '/api/decisions?limit=50', { token: 'dispatcher-demo' })).json()).decisions.map((d) => d.action);
  assert.ok(actions.includes('routing.degraded') && actions.includes('routing.recovered'), actions.join());
  } finally { a.server.closeAllConnections?.(); a.server.close(); }
});

test('application: legacy chaos flags keep working and map onto a mode; reset restores a healthy system', async () => {
  const a = app();
  assert.equal(a.store.setChaos({ externalDown: true }).mode, 'http503');
  assert.equal(a.store.setChaos({ externalDown: false, externalLatencyMs: 500 }).mode, 'slow');
  assert.equal(a.store.setChaos({ externalLatencyMs: 0 }).mode, 'ok');
  assert.throws(() => a.store.setChaos({ mode: 'weird' }), { code: 'INVALID_CHAOS' });
  a.store.setChaos({ mode: 'http503' });
  for (let i = 0; i < 3; i++) await a.evacuation.recommend(NAS);
  assert.equal(a.breaker.state, 'open');
  a.store.reset();
  assert.equal(a.breaker.state, 'closed');
  assert.equal(a.store.chaos.mode, 'ok');
  assert.equal(a.routing.cache.size, 0);
});

test('process guards: stray rejections / exceptions are logged and counted, the process is not terminated', () => {
  const proc = new EventEmitter(); const logs = [];
  const stats = installProcessGuards(proc, { error: (...x) => logs.push(x) });
  proc.emit('unhandledRejection', new Error('late rejection'));
  proc.emit('uncaughtException', new Error('stray throw'));
  assert.deepEqual([stats.unhandledRejections, stats.uncaughtExceptions], [1, 1]);
  assert.match(stats.last, /stray throw/);
  assert.equal(logs.length, 2);
});
