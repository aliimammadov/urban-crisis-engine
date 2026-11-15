import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { NEEDS, normalizeProfile, sanitizeNeeds } from '../src/priority.js';

function setup(opts = {}) {
  const clock = { t: 30_000_000 };
  const app = createApp({ now: () => clock.t, tickMs: 0, historyMs: 0, tokenSecret: 'k', ...opts });
  return { ...app, clock };
}
const NAS = { lat: 40.4093, lng: 49.8330 };
const YAS = { lat: 40.3850, lng: 49.8150 };

/** a signed device that declared the priority role */
function priorityDevice(app, id = 'wheel-1', needs = ['wheelchair']) {
  app.store.setProfile(id, { role: 'priority', needs });
  return { ip: `ip-${id}`, deviceId: id, verified: true, profile: app.store.getProfile(id) };
}
const prioSos = (app, id = 'wheel-1', pos = YAS, needs) => app.store.addSos({ citizenId: id, type: 'MEDICAL', ...pos, accuracy: 10 }, priorityDevice(app, id, needs));
const alerts = (app, type, status = 'open') => app.store.alerts.filter((a) => a.type === type && a.status === status);

// ---------------- role / profile ----------------
test('profile: role must be known; priority needs at least one VALID need; citizen clears needs', () => {
  assert.deepEqual(normalizeProfile({ role: 'priority', needs: ['wheelchair', 'junk', 'wheelchair'] }), { role: 'priority', needs: ['wheelchair'] });
  assert.deepEqual(normalizeProfile({ role: 'citizen', needs: ['wheelchair'] }), { role: 'citizen', needs: [] });
  for (const bad of [null, {}, { role: 'admin' }, { role: 'priority' }, { role: 'priority', needs: ['nope'] }, { role: 'priority', needs: 'wheelchair' }]) {
    assert.throws(() => normalizeProfile(bad), { code: 'INVALID_PROFILE' }, JSON.stringify(bad));
  }
  assert.deepEqual(sanitizeNeeds(['wheelchair', 'x', 5, null]), ['wheelchair']);
  assert.deepEqual(sanitizeNeeds('wheelchair'), []);
  assert.deepEqual(NEEDS, ['wheelchair', 'reduced_mobility', 'medical_transport']);
});

// ---------------- automatic Priority #1 ----------------
test('priority role: ONE verified SOS = immediate Critical Priority #1 alert (no 4-reporter rule)', () => {
  const app = setup();
  const s = prioSos(app);
  assert.equal(s.priority, 1);
  assert.deepEqual(s.needs, ['wheelchair']);
  const a = alerts(app, 'PRIORITY_SOS');
  assert.equal(a.length, 1);
  assert.equal(a[0].priority, 1);
  assert.equal(a[0].level, 'red');
  assert.equal(a[0].sosId, s.id);
  assert.equal(a[0].action, 'DISPATCH_ACCESSIBLE_TRANSPORT');
});

test('a normal citizen\'s single SOS is standard priority and raises no alert', () => {
  const app = setup();
  const s = app.store.addSos({ citizenId: 'x', type: 'FIRE', ...NAS, accuracy: 10 }, { ip: 'i', deviceId: 'x', verified: true });
  assert.equal(s.priority, 2);
  assert.equal(app.store.alerts.length, 0);
});

test('an UNSIGNED device cannot claim priority (profile is ignored without a verified identity)', () => {
  const app = setup();
  app.store.setProfile('ghost', { role: 'priority', needs: ['wheelchair'] });
  const s = app.store.addSos({ citizenId: 'ghost', type: 'MEDICAL', ...YAS, accuracy: 10 }, { ip: 'i', deviceId: 'ghost', verified: false, profile: app.store.getProfile('ghost') });
  assert.equal(s.priority, 2);
  assert.equal(alerts(app, 'PRIORITY_SOS').length, 0);
});

test('a quarantined priority SOS (out of area) does not auto-escalate, but is kept for the dispatcher', () => {
  const app = setup();
  const s = prioSos(app, 'far-away', { lat: 41.7, lng: 44.8 });
  assert.equal(s.quarantined, true);
  assert.equal(alerts(app, 'PRIORITY_SOS').length, 0);
  assert.equal(app.store.sos.includes(s), true);
  app.store.guard.release(s.id);            // dispatcher says it is real
  app.crisis.tick();
  assert.equal(alerts(app, 'PRIORITY_SOS').length, 1);
});

test('priority alert withdraws when the person cancels or marks themselves safe', () => {
  const app = setup();
  const s = prioSos(app, 'w1');
  app.store.cancelSos(s.id, 'w1');
  app.crisis.tick();
  assert.equal(alerts(app, 'PRIORITY_SOS').length, 0);
  prioSos(app, 'w2');
  assert.equal(alerts(app, 'PRIORITY_SOS').length, 1);
  app.store.markSafe('w2');
  app.crisis.tick();
  assert.equal(alerts(app, 'PRIORITY_SOS').length, 0);
});

test('each priority SOS gets its own alert and they are not duplicated by re-evaluation', () => {
  const app = setup();
  prioSos(app, 'w1'); prioSos(app, 'w2', YAS);
  app.crisis.tick(); app.crisis.evaluate(); app.crisis.tick();
  assert.equal(alerts(app, 'PRIORITY_SOS').length, 2);
});

// ---------------- dispatch of accessible transport ----------------
test('plan/approve: nearest ACCESSIBLE TRANSPORT is dispatched, no reserve point opened, plan == result', () => {
  const app = setup();
  prioSos(app);
  const alert = alerts(app, 'PRIORITY_SOS')[0];
  const plan = app.crisis.plan(alert);
  assert.equal(plan.brigade.kind, 'accessible_transport');
  assert.equal(plan.brigade.fallback, false);
  assert.equal(plan.point, null);
  assert.ok(plan.accessiblePoint && plan.accessiblePoint.distanceM > 0);
  const res = app.crisis.approve(alert.id);
  assert.equal(res.result.brigadeId, plan.brigade.id);
  assert.equal(res.result.openedPointId, null);
  assert.equal(res.result.accessible, true);
  assert.equal(app.store.brigades.get(plan.brigade.id).status, 'dispatched');
  assert.ok([...app.store.points.values()].filter((p) => !p.active).length === 4, 'no reserve point was opened');
  app.crisis.undo(alert.id);
  assert.equal(app.store.brigades.get(plan.brigade.id).status, 'available');
});

test('no free accessible transport -> nearest medical brigade as a flagged fallback; none at all -> null', () => {
  const app = setup();
  for (const b of app.store.brigades.values()) if (b.kind === 'accessible_transport') b.status = 'dispatched';
  prioSos(app);
  const alert = alerts(app, 'PRIORITY_SOS')[0];
  const plan = app.crisis.plan(alert);
  assert.equal(plan.brigade.kind, 'medical');
  assert.equal(plan.brigade.fallback, true);
  assert.equal(app.crisis.approve(alert.id).result.fallback, true);

  const b = setup();
  for (const x of b.store.brigades.values()) if (x.kind !== 'fire' && x.kind !== 'rescue') x.status = 'offline';
  prioSos(b);
  const a2 = alerts(b, 'PRIORITY_SOS')[0];
  assert.equal(b.crisis.plan(a2).brigade, null);
  assert.equal(b.crisis.approve(a2.id).result.brigadeId, null, 'approval does not crash when nothing is free');
});

test('after approval the citizen sees help is on the way (stage 3 + ETA)', () => {
  const app = setup();
  const s = prioSos(app);
  assert.equal(app.store.sosStatus(s.id).stage, 2);
  app.crisis.approve(alerts(app, 'PRIORITY_SOS')[0].id);
  const st = app.store.sosStatus(s.id);
  assert.equal(st.stage, 3);
  assert.equal(st.priority, 1);
  assert.ok(st.etaMin >= 1);
});

test('priority alerts are included in the dashboard snapshot with plan + needs; KPI counts them', () => {
  const app = setup();
  prioSos(app, 'w1', YAS, ['wheelchair', 'medical_transport']);
  const snap = app.crisis.decorate(app.store.snapshot());
  const a = snap.alerts.find((x) => x.type === 'PRIORITY_SOS');
  assert.deepEqual(a.needs, ['wheelchair', 'medical_transport']);
  assert.ok(a.plan.brigade && a.plan.accessiblePoint);
  assert.equal(snap.priorityOpen, 1);
  assert.equal(snap.sos.find((s) => s.priority === 1).needs.length, 2);
});

// ---------------- accessible evacuation route ----------------
test('seed sanity: every district has a step-free route to at least one accessible point', () => {
  const app = setup();
  const accessible = [...app.store.points.values()].filter((p) => p.accessible && p.active);
  assert.ok(accessible.length >= 4);
  for (const d of app.store.districts) {
    const ok = accessible.some((p) => app.graph.shortestPath(d.id, p.id, { accessible: true }));
    assert.ok(ok, `${d.id} has no accessible route`);
  }
});

test('accessible mode: only accessible points are offered and the route uses ONLY step-free segments', async () => {
  const app = setup();
  const r = await app.evacuation.recommend({ ...NAS, accessible: true });
  assert.equal(r.accessible, true);
  assert.equal(r.needsTransport, true);
  assert.ok(r.points.length > 0 && r.points.every((p) => p.accessible), 'only accessible points');
  const rec = r.points.find((p) => p.id === r.recommendedPointId);
  assert.ok(rec.access.includes('ramp') || rec.access.includes('lift'));
  assert.equal(rec.route.accessible, true);
  const path = await app.routing.route(NAS, app.store.points.get(rec.id), { accessible: true });
  assert.ok(path.edgeIds.length > 0);
  for (const id of path.edgeIds) assert.equal(app.graph.getEdge(id).stepFree, true, `edge ${id} is not step-free`);
});

test('the nearest point has stairs -> accessible user is routed elsewhere with reason NOT_ACCESSIBLE', async () => {
  const app = setup();
  const normal = await app.evacuation.recommend({ ...NAS });
  const nearest = app.store.points.get(normal.points[0].id);
  assert.equal(nearest.accessible, false, 'test premise: nearest point to Nasimi is not accessible');
  const r = await app.evacuation.recommend({ ...NAS, accessible: true });
  assert.notEqual(r.recommendedPointId, nearest.id);
  assert.ok(r.rerouted.reasons.includes('NOT_ACCESSIBLE'));
  assert.equal(r.rerouted.fromPointId, nearest.id);
});

test('normal users are unaffected: they may be sent to a point without a ramp', async () => {
  const app = setup();
  const r = await app.evacuation.recommend({ ...NAS });
  assert.equal(r.accessible, false);
  assert.equal(r.needsTransport, false);
  assert.equal(r.points.some((p) => !p.accessible), true);
});

test('no step-free route anywhere -> noAccessibleRoute + needsTransport (transport must come to the person)', async () => {
  const app = setup();
  for (const e of app.graph.edges.values()) e.stepFree = false;
  const r = await app.evacuation.recommend({ ...NAS, accessible: true });
  assert.equal(r.noAccessibleRoute, true);
  assert.equal(r.recommendedPointId, null);
  assert.equal(r.needsTransport, true);
  // priority alert still has a vehicle plan, and says there is no accessible point
  prioSos(app);
  const plan = app.crisis.plan(alerts(app, 'PRIORITY_SOS')[0]);
  assert.equal(plan.accessiblePoint, null);
  assert.ok(plan.brigade);
});

test('accessible routing falls back safely when the external map API is down', async () => {
  const app = setup();
  app.store.chaos.externalDown = true;
  const r = await app.evacuation.recommend({ ...NAS, accessible: true });
  const rec = r.points.find((p) => p.id === r.recommendedPointId);
  assert.equal(rec.route.source, 'fallback');
  assert.equal(rec.route.accessible, true);
});

// ---------------- HTTP ----------------
test('HTTP: profile endpoints, automatic priority SOS, accessible route by token, dispatcher accessibility control', async () => {
  const app = setup();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, path, { body, headers = {} } = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

  assert.equal((await call('GET', '/api/profile')).status, 401, 'needs a signed device');
  assert.equal((await call('POST', '/api/profile', { body: { role: 'priority', needs: ['wheelchair'] } })).status, 401);
  const { token } = await (await call('POST', '/api/session', { body: {} })).json();
  const H = { 'X-Device-Token': token };
  assert.deepEqual((await (await call('GET', '/api/profile', { headers: H })).json()).role, 'citizen');
  assert.equal((await call('POST', '/api/profile', { headers: H, body: { role: 'priority', needs: [] } })).status, 400);
  const saved = await (await call('POST', '/api/profile', { headers: H, body: { role: 'priority', needs: ['wheelchair', 'junk'] } })).json();
  assert.deepEqual(saved.needs, ['wheelchair']);

  // evacuation: accessible mode is automatic for the priority device, not for anonymous callers
  const withToken = await (await call('GET', `/api/evacuation?lat=${NAS.lat}&lng=${NAS.lng}`, { headers: H })).json();
  assert.equal(withToken.accessible, true);
  assert.ok(withToken.points.every((p) => p.accessible));
  const anon = await (await call('GET', `/api/evacuation?lat=${NAS.lat}&lng=${NAS.lng}`)).json();
  assert.equal(anon.accessible, false);
  assert.equal((await (await call('GET', `/api/evacuation?lat=${NAS.lat}&lng=${NAS.lng}&accessible=1`)).json()).accessible, true);

  // SOS -> Priority #1 + alert, response says so
  const sos = await (await call('POST', '/api/sos', { headers: H, body: { type: 'MEDICAL', lat: YAS.lat, lng: YAS.lng } })).json();
  assert.equal(sos.priority, 1);
  assert.deepEqual(sos.needs, ['wheelchair']);
  const dash = await (await call('GET', '/api/dashboard', { headers: { Authorization: 'Bearer dispatcher-demo' } })).json();
  const alert = dash.alerts.find((a) => a.type === 'PRIORITY_SOS');
  assert.ok(alert && alert.plan.brigade.kind === 'accessible_transport');
  assert.equal(dash.priorityOpen, 1);
  const ok = await call('POST', `/api/alerts/${alert.id}/approve`, { headers: { Authorization: 'Bearer dispatcher-demo' } });
  assert.equal((await ok.json()).result.accessible, true);

  // inline needs: signed device may declare with the SOS (offline queue), unsigned may not, junk never rejects the SOS
  const t2 = (await (await call('POST', '/api/session', { body: {} })).json()).token;
  const inline = await (await call('POST', '/api/sos', { headers: { 'X-Device-Token': t2 }, body: { type: 'FIRE', lat: NAS.lat, lng: NAS.lng, needs: ['reduced_mobility', 'x'] } })).json();
  assert.equal(inline.priority, 1);
  const unsigned = await call('POST', '/api/sos', { body: { citizenId: 'curl', type: 'FIRE', lat: NAS.lat, lng: NAS.lng, needs: ['wheelchair'] } });
  assert.equal(unsigned.status, 201);
  assert.equal((await unsigned.json()).priority, 2);
  const junk = await call('POST', '/api/sos', { headers: { 'X-Device-Token': t2 }, body: { type: 'FIRE', lat: NAS.lat, lng: NAS.lng, needs: 'garbage' } });
  assert.equal(junk.status, 201, 'a malformed optional field must never reject an SOS');

  // removing the role
  await call('POST', '/api/profile', { headers: H, body: { role: 'citizen' } });
  assert.equal((await (await call('GET', '/api/evacuation?lat=40.4&lng=49.8', { headers: H })).json()).accessible, false);

  // roads: stepFree is visible and only road:write staff may change it
  const roads = await (await call('GET', '/api/roads')).json();
  assert.ok(roads.every((r) => typeof r.stepFree === 'boolean') && roads.some((r) => !r.stepFree));
  assert.equal((await call('POST', `/api/roads/${roads[0].id}/accessibility`, { body: { stepFree: false } })).status, 401);
  assert.equal((await call('POST', `/api/roads/${roads[0].id}/accessibility`, { headers: { Authorization: 'Bearer observer-demo' }, body: { stepFree: false } })).status, 403);
  const set = await (await call('POST', `/api/roads/${roads[0].id}/accessibility`, { headers: { Authorization: 'Bearer dispatcher-demo' }, body: { stepFree: false } })).json();
  assert.equal(set.stepFree, false);
  assert.equal((await call('POST', '/api/roads/nope/accessibility', { headers: { Authorization: 'Bearer dispatcher-demo' }, body: {} })).status, 404);
  app.server.closeAllConnections?.(); app.server.close();
});

test('scenario priority_sos raises a Priority #1 alert through the real pipeline', async () => {
  const { runScenario } = await import('../src/scenarios.js');
  const app = setup();
  runScenario('priority_sos', { store: app.store, graph: app.graph, resetAll: () => {} });
  const a = alerts(app, 'PRIORITY_SOS');
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].needs, ['wheelchair']);
});
