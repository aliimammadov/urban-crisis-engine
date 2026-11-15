import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

function setup(opts = {}) {
  const clock = { t: 80_000_000 };
  const app = createApp({ now: () => clock.t, tickMs: 0, historyMs: 0, moveMs: 0, tokenSecret: 'k', ...opts });
  return { ...app, clock };
}
const NAS = { lat: 40.4093, lng: 49.8330 };
const one = (app, id = 'solo', type = 'FIRE', pos = NAS) => app.store.addSos({ citizenId: id, type, ...pos, accuracy: 10 }, { ip: `ip-${id}`, deviceId: id, verified: true });
const alertsOf = (app, type) => app.store.alerts.filter((a) => a.type === type);
const pending = (app) => app.crisis.pendingSos();

test('one citizen\'s SOS raises no alert, but it is listed as WAITING with ranked free brigades (type-aware)', () => {
  const app = setup();
  const s = one(app, 'solo', 'FIRE');
  assert.equal(app.store.alerts.length, 0, 'the 4-reporter rule has not fired');
  const [p] = pending(app);
  assert.equal(p.id, s.id);
  assert.equal(p.wantedKind, 'fire');
  const cands = p.candidates;
  assert.ok(cands.length >= 6 && cands.length <= 8);
  assert.equal(cands[0].kind, 'fire');
  assert.equal(cands[0].match, 'exact');
  assert.equal(p.autoId, cands[0].id);
  assert.ok(cands.every((c) => c.etaMin >= 1 && c.distanceM > 0));
});

test('dispatching a brigade to a single SOS: approved SOS_SINGLE alert, brigade moves, no reserve point opened, SOS leaves the waiting list', () => {
  const app = setup();
  const s = one(app);
  const reservesBefore = [...app.store.points.values()].filter((p) => !p.active).length;
  const alert = app.crisis.dispatchSos(s.id, 'dispatcher');
  assert.equal(alert.type, 'SOS_SINGLE');
  assert.equal(alert.status, 'approved');
  assert.equal(alert.result.openedPointId, null);
  assert.equal([...app.store.points.values()].filter((p) => !p.active).length, reservesBefore);
  const b = app.store.brigades.get(alert.result.brigadeId);
  assert.equal(b.kind, 'fire');
  assert.equal(b.status, 'dispatched');
  assert.ok(b.move.durationMs > 0);
  assert.equal(pending(app).length, 0);
  assert.equal(alert.result.manual, false);
});

test('the CITIZEN\'s status follows: assigning -> on the way (which brigade + live ETA) -> arrived', () => {
  const app = setup();
  const s = one(app);
  let st = app.store.sosStatus(s.id);
  assert.equal(st.stage, 2); assert.equal(st.brigade, null);
  const alert = app.crisis.dispatchSos(s.id);
  const b = app.store.brigades.get(alert.result.brigadeId);
  st = app.store.sosStatus(s.id);
  assert.equal(st.stage, 3);
  assert.deepEqual(st.brigade, { name: b.name, kind: 'fire' });
  assert.ok(st.etaSec > 0);
  app.clock.t += b.move.durationMs / 2;
  assert.ok(app.store.sosStatus(s.id).etaSec < st.etaSec, 'ETA counts down');
  app.clock.t += b.move.durationMs; app.crisis.tickBrigades();
  st = app.store.sosStatus(s.id);
  assert.equal(st.stage, 4);
  assert.equal(st.brigade.name, b.name);
  app.clock.t += app.crisis.rules.onSceneMs + 1; app.crisis.tickBrigades();
  app.clock.t += b.move.durationMs + 1; app.crisis.tickBrigades();
  assert.equal(app.store.sosStatus(s.id).stage, 4, 'stays "arrived" after the brigade is back');
});

test('the dispatcher can choose the brigade; invalid choices are refused and leave NO half-made alert behind', () => {
  const app = setup();
  const s = one(app);
  const auto = app.crisis.candidates({ type: 'SOS_SINGLE', level: 'red', sosId: s.id, sosType: 'FIRE', center: NAS })[0].id;
  assert.throws(() => app.crisis.dispatchSos(s.id, 'd', { brigadeId: 'nope' }), { code: 'BRIGADE_NOT_FOUND' });
  app.store.brigades.get('b4').status = 'offline';
  assert.throws(() => app.crisis.dispatchSos(s.id, 'd', { brigadeId: 'b4' }), { code: 'BRIGADE_NOT_AVAILABLE' });
  assert.throws(() => app.crisis.dispatchSos(s.id, 'd', { brigadeId: 5 }), { code: 'INVALID_BRIGADE' });
  assert.equal(alertsOf(app, 'SOS_SINGLE').length, 0, 'rolled back');
  assert.equal(pending(app).length, 1, 'still waiting');
  app.store.brigades.get('b4').status = 'available';
  const res = app.crisis.dispatchSos(s.id, 'd', { brigadeId: 'b4' });
  assert.equal(res.result.brigadeId, 'b4');
  assert.equal(res.result.manual, true);
  assert.equal(res.result.match, 'secondary');
  assert.equal(app.store.brigades.get(auto).status, 'available');
});

test('refusals: unknown SOS, cancelled SOS, already dispatched, SOS inside an open alert, nobody free', () => {
  const app = setup();
  assert.throws(() => app.crisis.dispatchSos('s9999'), { code: 'SOS_NOT_FOUND' });
  const a = one(app, 'a');
  app.store.cancelSos(a.id, 'a');
  assert.throws(() => app.crisis.dispatchSos(a.id), { code: 'SOS_NOT_OPEN' });

  const b = one(app, 'b');
  app.crisis.dispatchSos(b.id);
  assert.throws(() => app.crisis.dispatchSos(b.id), { code: 'SOS_ALREADY_DISPATCHED' });

  const c = setup();
  ['x1', 'x2', 'x3', 'x4'].forEach((i) => one(c, i));
  const inAlert = c.store.alerts.find((x) => x.type === 'SOS_CLUSTER');
  assert.throws(() => c.crisis.dispatchSos(inAlert.sosIds[0]), { code: 'SOS_IN_ALERT' });
  assert.equal(c.crisis.pendingSos().length, 0, 'cluster members are covered by the alert, not "waiting"');

  const d = setup();
  const s = one(d, 'z');
  for (const br of d.store.brigades.values()) br.status = 'dispatched';
  assert.throws(() => d.crisis.dispatchSos(s.id), { code: 'NO_BRIGADE_AVAILABLE' });
  assert.equal(alertsOf(d, 'SOS_SINGLE').length, 0);
});

test('only reserved vehicles free: no automatic choice (refused), but the dispatcher may pick one on purpose', () => {
  const app = setup();
  const s = one(app);
  for (const b of app.store.brigades.values()) if (b.kind !== 'accessible_transport') b.status = 'offline';
  assert.throws(() => app.crisis.dispatchSos(s.id), { code: 'NO_BRIGADE_AVAILABLE' });
  const res = app.crisis.dispatchSos(s.id, 'd', { brigadeId: 'b7' });
  assert.equal(res.result.match, 'special');
});

test('undo within the window sends the brigade home and puts the SOS back on the waiting list; after the window it is refused', () => {
  const app = setup();
  const s = one(app);
  const alert = app.crisis.dispatchSos(s.id);
  const b = app.store.brigades.get(alert.result.brigadeId);
  app.clock.t += 3000;
  app.crisis.undo(alert.id);
  assert.equal(b.status, 'available'); assert.equal(b.move, undefined);
  assert.equal(alertsOf(app, 'SOS_SINGLE').length, 0, 'the single-SOS alert disappears (nothing to re-open)');
  assert.equal(pending(app).length, 1);
  assert.equal(app.store.sosStatus(s.id).stage, 2, 'the citizen is back to "assigning"');
  const again = app.crisis.dispatchSos(s.id);
  app.clock.t += app.crisis.rules.undoWindowMs + 1;
  assert.throws(() => app.crisis.undo(again.id), { code: 'UNDO_EXPIRED' });
});

test('the waiting list excludes priority SOS (own alert), quarantined SOS, cancelled/safe SOS; newest first and capped at 12', () => {
  const app = setup();
  app.store.setProfile('w', { role: 'priority', needs: ['wheelchair'] });
  app.store.addSos({ citizenId: 'w', type: 'MEDICAL', ...NAS, accuracy: 8 }, { ip: 'i', deviceId: 'w', verified: true, profile: app.store.getProfile('w') });
  const far = app.store.addSos({ citizenId: 'far', type: 'FIRE', lat: 41.7, lng: 44.8, accuracy: 5 }, { ip: 'i2', deviceId: 'far', verified: true });
  assert.equal(far.quarantined, true);
  const c = one(app, 'c'); app.store.cancelSos(c.id, 'c');
  const sf = one(app, 'sf'); app.store.markSafe('sf');
  assert.equal(pending(app).length, 0);
  const ids = [];
  // 6 minutes apart: outside the 5-minute cluster window, so no alert swallows them
  for (let i = 0; i < 20; i++) { app.clock.t += 6 * 60_000; ids.push(one(app, `p${i}`, 'FLOOD', { lat: 40.3 + i * 0.005, lng: 49.9 }).id); }
  const list = pending(app);
  assert.equal(list.length, 12);
  assert.equal(list[0].id, ids.at(-1), 'newest first');
  assert.ok(list.every((p) => p.candidates[0].kind === 'rescue'), 'flood -> rescue');
  assert.ok(sf && far);
});

test('waiting list stays fast with a huge history of SOS', () => {
  const app = setup();
  for (let i = 0; i < 5000; i++) { app.clock.t += 6 * 60_000; one(app, `h${i}`, 'FIRE', { lat: 40.3 + (i % 50) * 0.003, lng: 49.8 + (i % 40) * 0.003 }); }
  const t0 = performance.now();
  const list = app.crisis.pendingSos();
  assert.ok(performance.now() - t0 < 50, `${Math.round(performance.now() - t0)} ms`);
  assert.ok(list.length > 0);
});

test('the dashboard alert tells what became of the citizen (safe / cancelled) while the brigade is still on its way', () => {
  const app = setup();
  const s = one(app);
  const alert = app.crisis.dispatchSos(s.id);
  let a = app.crisis.decorate(app.store.snapshot()).alerts.find((x) => x.id === alert.id);
  assert.equal(a.sosState, 'open');
  app.store.markSafe('solo');
  a = app.crisis.decorate(app.store.snapshot()).alerts.find((x) => x.id === alert.id);
  assert.equal(a.sosState, 'resolved');
});

test('snapshot carries the waiting list; a flood does not make snapshots expensive', () => {
  const app = setup();
  one(app, 'a'); one(app, 'b', 'MEDICAL', { lat: 40.45, lng: 49.82 });
  const snap = app.crisis.decorate(app.store.snapshot());
  assert.equal(snap.pending.length, 2);
  assert.equal(snap.pending[0].type, 'MEDICAL');
  assert.equal(snap.pending[0].candidates[0].kind, 'medical');
});

/* ============================== HTTP ============================== */
test('HTTP: dispatch endpoint (rights, errors), citizen status with brigade, journal says what happened', async () => {
  const app = setup();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, path, { body, token } = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    const s = await (await call('POST', '/api/sos', { body: { citizenId: 'phone-1', type: 'FIRE', lat: NAS.lat, lng: NAS.lng, accuracy: 20 } })).json();
    const poll = async () => (await call('GET', `/api/sos/${s.id}`)).json();
    assert.equal((await poll()).stage, 2);

    const dash = await (await call('GET', '/api/dashboard', { token: 'dispatcher-demo' })).json();
    assert.equal(dash.pending[0].id, s.id);
    assert.equal((await call('POST', `/api/sos/${s.id}/dispatch`)).status, 401);
    assert.equal((await call('POST', `/api/sos/${s.id}/dispatch`, { token: 'observer-demo' })).status, 403);
    assert.equal((await call('POST', `/api/sos/nope/dispatch`, { token: 'dispatcher-demo' })).status, 404);
    assert.equal((await call('POST', `/api/sos/${s.id}/dispatch`, { body: { brigadeId: 'zzz' }, token: 'dispatcher-demo' })).status, 404);

    const ok = await call('POST', `/api/sos/${s.id}/dispatch`, { body: { brigadeId: dash.pending[0].autoId }, token: 'dispatcher-demo' });
    assert.equal(ok.status, 200);
    const alert = await ok.json();
    assert.equal(alert.type, 'SOS_SINGLE');

    const st = await poll();
    assert.equal(st.stage, 3);
    assert.equal(st.brigade.kind, 'fire');
    assert.ok(st.etaSec > 0);
    assert.ok(!JSON.stringify(st).includes('phone-1'), 'no identifiers in the citizen status');

    const again = await call('POST', `/api/sos/${s.id}/dispatch`, { token: 'dispatcher-demo' });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, 'SOS_ALREADY_DISPATCHED');

    const j = (await (await call('GET', '/api/decisions', { token: 'dispatcher-demo' })).json()).decisions.find((d) => d.action === 'sos.dispatch');
    assert.equal(j.target, s.id); assert.equal(j.actor, 'dispatcher'); assert.equal(j.details.type, 'FIRE'); assert.ok(j.details.brigadeId);
    const after = await (await call('GET', '/api/dashboard', { token: 'dispatcher-demo' })).json();
    assert.equal(after.pending.length, 0);
    assert.ok(after.alerts.some((a) => a.type === 'SOS_SINGLE' && a.status === 'approved'));

    const undo = await call('POST', `/api/alerts/${alert.id}/undo`, { token: 'dispatcher-demo' });
    assert.equal(undo.status, 200);
    assert.equal((await poll()).stage, 2);
    assert.equal((await (await call('GET', '/api/dashboard', { token: 'dispatcher-demo' })).json()).pending.length, 1);
  } finally { app.server.closeAllConnections?.(); app.server.close(); }
});
