import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { haversine } from '../src/geo.js';
import { RateLimiter } from '../src/ratelimit.js';

function setup(opts = {}) {
  const clock = { t: 1_000_000 };
  const app = createApp({ now: () => clock.t, ...opts });
  return { ...app, clock };
}
const NASIMI = { lat: 40.4093, lng: 49.8330 };
const sos = (app, citizenId, pos = NASIMI, type = 'FIRE') => app.store.addSos({ citizenId, type, ...pos });

test('haversine: ~111km per degree latitude', () => {
  const d = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(d - 111195) < 300);
});

test('road graph is connected: every point reachable from every district', () => {
  const { graph, store } = setup();
  for (const d of store.districts) {
    for (const p of store.points.values()) {
      assert.ok(graph.shortestPath(d.id, p.id), `${d.id} -> ${p.id}`);
    }
  }
});

test('closing a road changes the path; closing everything around a node blocks it', () => {
  const { graph } = setup();
  const base = graph.shortestPath('nasimi', 'p7');
  graph.setClosed(base.edgeIds[0], true);
  const alt = graph.shortestPath('nasimi', 'p7');
  assert.ok(alt === null || !alt.edgeIds.includes(base.edgeIds[0]));
  for (const eid of graph.adj.get('p7')) graph.setClosed(eid, true);
  assert.equal(graph.shortestPath('nasimi', 'p7'), null);
});

// ---- Critical crisis algorithm ------------------------------------------
test('rule A: 4 distinct reporters within 500m / 5 min => one RED alert', () => {
  const app = setup();
  ['c1', 'c2', 'c3'].forEach((c) => sos(app, c));
  assert.equal(app.store.alerts.length, 0, '3 reporters is not enough');
  sos(app, 'c4', { lat: NASIMI.lat + 0.001, lng: NASIMI.lng });
  const alerts = app.store.alerts.filter((a) => a.type === 'SOS_CLUSTER');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'red');
  assert.equal(alerts[0].reporters, 4);
  sos(app, 'c5');
  assert.equal(app.store.alerts.filter((a) => a.type === 'SOS_CLUSTER').length, 1, 'no duplicates');
  assert.equal(app.store.alerts[0].reporters, 5, 'existing alert grows');
});

test('rule A: same citizen spamming does not count as distinct reporters', () => {
  const app = setup();
  for (let i = 0; i < 10; i++) sos(app, 'same-person');
  assert.equal(app.store.alerts.length, 0);
});

test('rule A: SOS older than 5 minutes are outside the window', () => {
  const app = setup();
  sos(app, 'c1'); sos(app, 'c2'); sos(app, 'c3');
  app.clock.t += 6 * 60 * 1000;
  sos(app, 'c4');
  assert.equal(app.store.alerts.length, 0);
});

test('rule A: far apart SOS in different districts do not trigger', () => {
  const app = setup();
  sos(app, 'c1', { lat: 40.4093, lng: 49.8330 });
  sos(app, 'c2', { lat: 40.4600, lng: 49.8200 });
  sos(app, 'c3', { lat: 40.4400, lng: 49.9400 });
  sos(app, 'c4', { lat: 40.3550, lng: 49.8350 });
  assert.equal(app.store.alerts.length, 0);
});

test('rule B: occupancy > 95% raises alert, exactly 95% does not', () => {
  const app = setup();
  const p = app.store.points.get('p3');
  app.store.setOccupancy('p3', p.capacity * 0.95);
  assert.equal(app.store.alerts.length, 0);
  app.store.setOccupancy('p3', p.capacity * 0.96);
  assert.equal(app.store.alerts.length, 1);
  assert.equal(app.store.alerts[0].type, 'POINT_OVERCROWD');
  app.store.setOccupancy('p3', p.capacity * 0.97);
  assert.equal(app.store.alerts.length, 1, 'no duplicate');
});

test('approve: dispatches nearest free brigade, opens nearest reserve point, idempotent', () => {
  const app = setup();
  ['c1', 'c2', 'c3', 'c4'].forEach((c) => sos(app, c));
  const alert = app.store.alerts[0];
  const res = app.crisis.approve(alert.id, 'dispatcher');
  assert.equal(res.status, 'approved');
  assert.ok(res.result.brigadeId);
  assert.ok(res.result.openedPointId);
  assert.equal(app.store.brigades.get(res.result.brigadeId).status, 'dispatched');
  assert.equal(app.store.points.get(res.result.openedPointId).active, true);
  const again = app.crisis.approve(alert.id, 'dispatcher');
  assert.deepEqual(again.result, res.result);
  assert.equal([...app.store.brigades.values()].filter((b) => b.status === 'dispatched').length, 1);
});

test('approve: works even when no brigade/reserve left (result nulls, no crash)', () => {
  const app = setup();
  for (const b of app.store.brigades.values()) b.status = 'offline';
  for (const p of app.store.points.values()) p.active = true;
  ['c1', 'c2', 'c3', 'c4'].forEach((c) => sos(app, c));
  const res = app.crisis.approve(app.store.alerts[0].id);
  assert.deepEqual(res.result, { brigadeId: null, openedPointId: null, etaMin: null, manual: false, match: null });
});

test('marking safe resolves the citizen SOS', () => {
  const app = setup();
  sos(app, 'c1');
  const r = app.store.markSafe('c1', NASIMI);
  assert.equal(r.resolvedSos, 1);
  assert.equal(app.store.zoneCounts().nasimi, 0);
});

// ---- Evacuation recommendations ------------------------------------------
test('evacuation: recommends nearest open point with a route', async () => {
  const app = setup();
  const r = await app.evacuation.recommend(NASIMI);
  assert.ok(r.recommendedPointId);
  const rec = r.points.find((p) => p.id === r.recommendedPointId);
  assert.ok(rec.route.geometry.length >= 2);
  assert.equal(rec.route.source, 'external');
});

test('evacuation: point >=90% full => alternative recommended with POINT_FULL reason', async () => {
  const app = setup();
  const first = (await app.evacuation.recommend(NASIMI)).recommendedPointId;
  app.store.setOccupancy(first, app.store.points.get(first).capacity * 0.9);
  const r = await app.evacuation.recommend(NASIMI);
  assert.notEqual(r.recommendedPointId, first);
  assert.ok(r.rerouted.reasons.includes('POINT_FULL'));
});

test('evacuation: unreachable point (all its roads closed) is skipped with ROAD_BLOCKED', async () => {
  const app = setup();
  const first = (await app.evacuation.recommend(NASIMI)).points[0].id;
  for (const eid of app.graph.adj.get(first)) app.graph.setClosed(eid, true);
  const r = await app.evacuation.recommend(NASIMI);
  assert.equal(r.points.find((p) => p.id === first).status, 'unreachable');
  assert.notEqual(r.recommendedPointId, first);
  assert.ok(r.rerouted.reasons.includes('ROAD_BLOCKED'));
});

test('evacuation: external routing API down => fallback source, still works', async () => {
  const app = setup();
  app.store.chaos.externalDown = true;
  const r = await app.evacuation.recommend(NASIMI);
  const route = r.points.find((p) => p.id === r.recommendedPointId).route;
  assert.ok(['cache', 'matrix', 'local'].includes(route.source), route.source);
  assert.equal(r.routing.degraded, true);
});

test('evacuation: slow external API times out => fallback', async () => {
  const app = setup({ routingTimeoutMs: 50 });
  app.store.chaos.externalLatencyMs = 400;
  const r = await app.evacuation.recommend(NASIMI);
  assert.ok(['cache', 'matrix', 'local'].includes(r.points[0].route.source), r.points[0].route.source);
});

test('evacuation: invalid coordinates rejected, district fallback works', async () => {
  const app = setup();
  await assert.rejects(app.evacuation.recommend({ lat: 999, lng: 0 }), { code: 'INVALID_COORDS' });
  const r = await app.evacuation.recommend({ district: 'sabail' });
  assert.ok(r.recommendedPointId);
});

test('every point full => noSafePoint', async () => {
  const app = setup();
  for (const p of app.store.points.values()) app.store.setOccupancy(p.id, p.capacity);
  const r = await app.evacuation.recommend(NASIMI);
  assert.equal(r.noSafePoint, true);
  assert.equal(r.recommendedPointId, null);
});

test('checkin: full point rejected, switching points moves the count', () => {
  const app = setup();
  app.store.checkin('x', 'p3');
  const before = app.store.points.get('p3').occupied;
  app.store.checkin('x', 'p5');
  assert.equal(app.store.points.get('p3').occupied, before - 1);
  app.store.setOccupancy('p4', app.store.points.get('p4').capacity);
  assert.throws(() => app.store.checkin('y', 'p4'), { code: 'POINT_FULL' });
});

test('rate limiter refills over time', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.ok(rl.take('a')); assert.ok(rl.take('a')); assert.ok(!rl.take('a'));
  t += 1000;
  assert.ok(rl.take('a'));
  assert.ok(rl.take('b'), 'separate key');
});

// ---- Redesign features: plan preview, undo, SOS cancel/status ---------------
test('plan: previews brigade + reserve point + ETA without changing state', () => {
  const app = setup();
  ['c1', 'c2', 'c3', 'c4'].forEach((c) => sos(app, c));
  const alert = app.store.alerts[0];
  const plan = app.crisis.plan(alert);
  assert.ok(plan.brigade.id && plan.brigade.etaMin >= 1);
  assert.ok(plan.point.id && plan.point.capacity > 0);
  assert.equal(app.store.brigades.get(plan.brigade.id).status, 'available');
  assert.equal(app.store.points.get(plan.point.id).active, false);
  const res = app.crisis.approve(alert.id);
  assert.equal(res.result.brigadeId, plan.brigade.id, 'approve does exactly what plan promised');
  assert.equal(res.result.openedPointId, plan.point.id);
  assert.equal(res.result.etaMin, plan.brigade.etaMin);
});

test('undo: inside 10s restores brigade + closes point + reopens alert; after 10s refused', () => {
  const app = setup();
  ['c1', 'c2', 'c3', 'c4'].forEach((c) => sos(app, c));
  const alert = app.store.alerts[0];
  const { result } = app.crisis.approve(alert.id);
  app.clock.t += 5_000;
  app.crisis.undo(alert.id);
  assert.equal(alert.status, 'open');
  assert.equal(app.store.brigades.get(result.brigadeId).status, 'available');
  assert.equal(app.store.points.get(result.openedPointId).active, false);
  app.crisis.approve(alert.id);
  app.clock.t += 11_000;
  assert.throws(() => app.crisis.undo(alert.id), { code: 'UNDO_EXPIRED' });
  assert.throws(() => app.crisis.undo('nope'), { code: 'ALERT_NOT_FOUND' });
});

test('undo: not allowed for an alert that was never approved', () => {
  const app = setup();
  ['c1', 'c2', 'c3', 'c4'].forEach((c) => sos(app, c));
  assert.throws(() => app.crisis.undo(app.store.alerts[0].id), { code: 'ALERT_NOT_APPROVED' });
});

test('decorate: dashboard alerts carry plan, SOS type counts and undo timer', () => {
  const app = setup();
  sos(app, 'c1', NASIMI, 'FIRE'); sos(app, 'c2', NASIMI, 'FIRE'); sos(app, 'c3', NASIMI, 'MEDICAL'); sos(app, 'c4', NASIMI, 'COLLAPSE');
  let a = app.crisis.decorate(app.store.snapshot()).alerts[0];
  assert.deepEqual(a.typeCounts, { FIRE: 2, MEDICAL: 1, COLLAPSE: 1 });
  assert.ok(a.plan.brigade);
  app.crisis.approve(a.id);
  app.clock.t += 3_000;
  a = app.crisis.decorate(app.store.snapshot()).alerts[0];
  assert.equal(a.undoMsLeft, 7_000);
});

test('cancelSos: owner can cancel within window; others and late attempts cannot', () => {
  const app = setup();
  const s = sos(app, 'owner');
  assert.throws(() => app.store.cancelSos(s.id, 'someone-else'), { code: 'FORBIDDEN' });
  assert.equal(app.store.cancelSos(s.id, 'owner').status, 'cancelled');
  assert.equal(app.store.zoneCounts().nasimi, 0, 'cancelled SOS no longer counts');
  assert.throws(() => app.store.cancelSos(s.id, 'owner'), { code: 'SOS_NOT_OPEN' });
  const late = sos(app, 'owner2');
  app.clock.t += 61_000;
  assert.throws(() => app.store.cancelSos(late.id, 'owner2'), { code: 'CANCEL_EXPIRED' });
  assert.throws(() => app.store.cancelSos('s9999', 'x'), { code: 'SOS_NOT_FOUND' });
});

test('cancelled SOS do not contribute to a cluster alert', () => {
  const app = setup();
  const a = sos(app, 'c1'); sos(app, 'c2'); sos(app, 'c3');
  app.store.cancelSos(a.id, 'c1');
  sos(app, 'c4');
  assert.equal(app.store.alerts.length, 0, 'only 3 live reporters');
});

test('sosStatus: stage 2 while assigning, stage 3 with ETA after approval, 0 when cancelled', () => {
  const app = setup();
  const mine = sos(app, 'c1'); ['c2', 'c3', 'c4'].forEach((c) => sos(app, c));
  assert.equal(app.store.sosStatus(mine.id).stage, 2);
  app.crisis.approve(app.store.alerts[0].id);
  const st = app.store.sosStatus(mine.id);
  assert.equal(st.stage, 3);
  assert.ok(st.etaMin >= 1);
  const other = sos(app, 'z', { lat: 40.46, lng: 49.82 });
  app.store.cancelSos(other.id, 'z');
  assert.equal(app.store.sosStatus(other.id).stage, 0);
});
