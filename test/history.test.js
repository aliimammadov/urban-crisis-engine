import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { History } from '../src/history.js';

function setup(opts = {}) {
  const clock = { t: 20_000_000 };
  const app = createApp({ now: () => clock.t, tickMs: 0, historyMs: 0, ...opts });
  return { ...app, clock };
}
const NAS = { lat: 40.4093, lng: 49.8330 };

test('history: events create frames (throttled to one per second), timer-style force always records', () => {
  const app = setup();
  app.clock.t += 1500; // the constructor already recorded a frame at t0
  const n0 = app.history.frames.length;
  app.store.addSos({ citizenId: 'a', type: 'FIRE', ...NAS }, { ip: 'x', deviceId: 'a' });
  app.store.addSos({ citizenId: 'b', type: 'FIRE', ...NAS }, { ip: 'x', deviceId: 'b' });
  assert.equal(app.history.frames.length, n0 + 1, 'second event in the same second is throttled');
  app.clock.t += 1500;
  app.store.addSos({ citizenId: 'c', type: 'FIRE', ...NAS }, { ip: 'x', deviceId: 'c' });
  assert.equal(app.history.frames.length, n0 + 2);
  app.history.record({ force: true });
  assert.equal(app.history.frames.length, n0 + 3);
});

test('history: frames contain what the map needs and no identifiers', () => {
  const app = setup();
  app.store.addSos({ citizenId: 'secret-id', type: 'MEDICAL', ...NAS }, { ip: '203.0.113.5', deviceId: 'secret-id' });
  const f = app.history.record({ force: true });
  assert.equal(f.sos.length, 1);
  assert.deepEqual(f.sos[0].slice(2), ['MEDICAL']);
  assert.ok(f.points.length >= 9 && f.brigades.length === 6);
  const json = JSON.stringify(f);
  assert.ok(!json.includes('secret-id') && !json.includes('203.0.113.5'));
});

test('history: bounded in size and in time; flood frames are capped', () => {
  const h = new History({ now: () => 1_000_000, sos: [], points: new Map(), brigades: new Map(), alerts: [] }, null, { maxFrames: 5, minGapMs: 0 });
  for (let i = 0; i < 12; i++) h.record({ force: true });
  assert.equal(h.frames.length, 5);

  const app = setup();
  for (let i = 0; i < 400; i++) app.store.addSos({ citizenId: `f${i}`, type: 'FIRE', ...NAS }, { ip: `ip-${i}`, deviceId: `f${i}`, verified: true });
  const f = app.history.record({ force: true });
  assert.ok(f.sos.length <= 150);
  assert.ok(f.sosTotal >= 300, 'real total is still reported');
});

test('history: since() windows by minutes; reset clears it', () => {
  const app = setup();
  app.history.record({ force: true });
  app.clock.t += 30 * 60_000; app.history.record({ force: true });
  assert.equal(app.history.since(10).length, 1);
  assert.ok(app.history.since(120).length >= 2);
  app.store.reset();
  assert.equal(app.history.frames.length, 1, 'only the frame recorded for the reset itself');
});

test('history: captures the alert lifecycle (open -> approved) for replay', () => {
  const app = setup();
  ['a', 'b', 'c', 'd'].forEach((id) => app.store.addSos({ citizenId: id, type: 'FIRE', ...NAS, accuracy: 10 }, { ip: `ip-${id}`, deviceId: id }));
  app.clock.t += 2000;
  const f1 = app.history.record({ force: true });
  assert.ok(f1.alerts.some((a) => a[1] === 'SOS_CLUSTER' && a[3] === 'open'));
  app.crisis.approve(app.store.alerts[0].id);
  app.clock.t += 2000;
  const f2 = app.history.record({ force: true });
  assert.ok(f2.alerts.some((a) => a[3] === 'approved'));
  assert.ok(f2.brigades.some((b) => b[1] === 'dispatched'));
});

test('HTTP: history endpoint needs dashboard rights', async () => {
  const app = setup();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/dashboard/history`)).status, 401);
  const r = await fetch(`${base}/api/dashboard/history?minutes=60`, { headers: { Authorization: 'Bearer observer-demo' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.frames) && j.frames.length >= 1);
  app.server.closeAllConnections?.(); app.server.close();
});
