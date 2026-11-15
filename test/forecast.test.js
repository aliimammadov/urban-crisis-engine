import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

function setup(opts = {}) {
  const clock = { t: 10_000_000 };
  const app = createApp({ now: () => clock.t, tickMs: 0, ...opts });
  return { ...app, clock };
}
const MIN = 60_000;
const NAS = { lat: 40.4093, lng: 49.8330 };
const sos = (app, id, pos = NAS) => app.store.addSos({ citizenId: id, type: 'FIRE', ...pos, accuracy: 10 }, { ip: `ip-${id}`, deviceId: id });
const alerts = (app, type, status = 'open') => app.store.alerts.filter((a) => a.type === type && a.status === status);

test('occupancyRate: null without enough data, else people per minute', () => {
  const app = setup();
  assert.equal(app.store.occupancyRate('p3'), null, 'only the initial sample');
  app.clock.t += 30_000; app.store.setOccupancy('p3', 500);
  assert.equal(app.store.occupancyRate('p3'), null, 'span < 60 s is too noisy');
  app.clock.t += 90_000; app.store.setOccupancy('p3', 640);
  assert.ok(Math.abs(app.store.occupancyRate('p3') - 120) < 0.01, `${app.store.occupancyRate('p3')}`); // (640-400)/2min
  assert.ok(Math.abs(app.store.minutesToPct('p3', 95) - 500 / 120) < 0.01);
});

test('forecast: a fast-filling point raises an AMBER warning before 95%', () => {
  const app = setup();
  app.clock.t += 2 * MIN; app.store.setOccupancy('p3', 640);   // 53%, +120/min
  const [w] = alerts(app, 'POINT_FILLING');
  assert.ok(w, 'warning raised');
  assert.equal(w.level, 'amber');
  assert.equal(w.etaMin, 4);
  assert.equal(alerts(app, 'POINT_OVERCROWD').length, 0, 'not red yet');
});

test('forecast: a slow inflow does not warn (ETA beyond the horizon)', () => {
  const app = setup();
  app.clock.t += 10 * MIN; app.store.setOccupancy('p3', 430); // +3/min -> hours
  assert.equal(alerts(app, 'POINT_FILLING').length, 0);
});

test('forecast: approving the amber warning opens a reserve point but dispatches NO brigade', () => {
  const app = setup();
  app.clock.t += 2 * MIN; app.store.setOccupancy('p3', 640);
  const w = alerts(app, 'POINT_FILLING')[0];
  const plan = app.crisis.plan(w);
  assert.equal(plan.brigade, null);
  assert.ok(plan.point);
  const res = app.crisis.approve(w.id);
  assert.equal(res.result.brigadeId, null);
  assert.ok(res.result.openedPointId);
  assert.equal(app.store.points.get(res.result.openedPointId).active, true);
  assert.ok([...app.store.brigades.values()].every((b) => b.status === 'available'));
});

test('forecast: warning withdraws when the inflow stops; red supersedes amber', () => {
  const app = setup();
  app.clock.t += 2 * MIN; app.store.setOccupancy('p3', 640);
  assert.equal(alerts(app, 'POINT_FILLING').length, 1);
  app.clock.t += 6 * MIN; app.crisis.tick(); // no new samples for 6 min -> rate unknown
  assert.equal(alerts(app, 'POINT_FILLING').length, 0);
  assert.equal(alerts(app, 'POINT_FILLING', 'expired').length, 1);

  const b = setup();
  b.clock.t += 2 * MIN; b.store.setOccupancy('p3', 700);
  assert.equal(alerts(b, 'POINT_FILLING').length, 1);
  b.store.setOccupancy('p3', 1170); // 97.5 %
  assert.equal(alerts(b, 'POINT_FILLING').length, 0, 'amber superseded');
  assert.equal(alerts(b, 'POINT_OVERCROWD').length, 1);
});

test('hysteresis: a red overcrowd alert stays open until occupancy falls below clearPct (90%)', () => {
  const app = setup();
  app.store.setOccupancy('p3', 1152);                      // 96 %
  assert.equal(alerts(app, 'POINT_OVERCROWD').length, 1);
  app.store.setOccupancy('p3', 1116);                      // 93 % -> still open
  assert.equal(alerts(app, 'POINT_OVERCROWD').length, 1);
  app.store.setOccupancy('p3', 1020);                      // 85 % -> clears
  assert.equal(alerts(app, 'POINT_OVERCROWD').length, 0);
  assert.equal(alerts(app, 'POINT_OVERCROWD', 'expired').length, 1);
});

test('cooldown: after approval the same point does not re-alert for 5 min unless it reaches 98%', () => {
  const app = setup();
  app.store.setOccupancy('p3', 1152);
  app.crisis.approve(alerts(app, 'POINT_OVERCROWD')[0].id);
  app.store.setOccupancy('p3', 960);                       // 80 %
  app.store.setOccupancy('p3', 1152);                      // 96 % again, within cooldown
  assert.equal(alerts(app, 'POINT_OVERCROWD').length, 0);
  app.store.setOccupancy('p3', 1188);                      // 99 % -> forced
  assert.equal(alerts(app, 'POINT_OVERCROWD').length, 1);

  const b = setup();
  b.store.setOccupancy('p3', 1152);
  b.crisis.approve(alerts(b, 'POINT_OVERCROWD')[0].id);
  b.store.setOccupancy('p3', 960);
  b.clock.t += 6 * MIN;
  b.store.setOccupancy('p3', 1152);                        // cooldown over
  assert.equal(alerts(b, 'POINT_OVERCROWD').length, 1);
});

test('no duplicate red alert for evidence already handled; a NEW cluster of fresh reporters still alerts', () => {
  const app = setup();
  ['a', 'b', 'c', 'd'].forEach((id) => sos(app, id));
  assert.equal(alerts(app, 'SOS_CLUSTER').length, 1);
  app.crisis.approve(alerts(app, 'SOS_CLUSTER')[0].id);
  sos(app, 'e');                                           // one more person after dispatch
  assert.equal(alerts(app, 'SOS_CLUSTER').length, 0, 'no duplicate');
  ['f', 'g', 'h'].forEach((id) => sos(app, id));           // e,f,g,h = 4 fresh reporters
  assert.equal(alerts(app, 'SOS_CLUSTER').length, 1, 'fresh cluster is a new emergency');
});

test('evacuation: a point that will be full on arrival is deprioritised with POINT_FILLING_FAST', async () => {
  const app = setup();
  const before = await app.evacuation.recommend(NAS);
  const nearest = before.points[0];
  const cap = app.store.points.get(nearest.id).capacity;
  app.clock.t += 1 * MIN + 1000;
  app.store.setOccupancy(nearest.id, Math.round(cap * 0.8)); // 80 % now, strong inflow
  const r = await app.evacuation.recommend(NAS);
  const p = r.points.find((x) => x.id === nearest.id);
  assert.equal(p.status, 'filling');
  assert.equal(p.fillingFast, true);
  assert.ok(p.projectedPct >= 90);
  assert.notEqual(r.recommendedPointId, nearest.id);
  assert.ok(r.rerouted.reasons.includes('POINT_FILLING_FAST'));
});
