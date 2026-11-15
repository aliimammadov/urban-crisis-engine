import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { runScenario, SCENARIO_NAMES } from '../src/scenarios.js';

function setup() {
  const app = createApp({ tickMs: 0 });
  const run = (name) => runScenario(name, { store: app.store, graph: app.graph, resetAll: () => { for (const e of app.graph.edges.values()) { e.closed = false; } app.store.reset(); } });
  return { ...app, run };
}
const open = (app, type) => app.store.alerts.filter((a) => a.type === type && a.status === 'open');

test('scenario cluster: one red SOS_CLUSTER alert from 4 verified devices', () => {
  const app = setup(); app.run('cluster');
  assert.equal(open(app, 'SOS_CLUSTER').length, 1);
  assert.equal(open(app, 'SOS_CLUSTER')[0].reporters, 4);
});

test('scenario fake_flood: attack recognised, signals quarantined, NO alert', () => {
  const app = setup(); app.run('fake_flood');
  const snap = app.store.snapshot();
  assert.equal(snap.abuse.attack, true);
  assert.ok(snap.quarantinedTotal >= 30);
  assert.equal(open(app, 'SOS_CLUSTER').length, 0);
  assert.equal(app.store.sos.length, 40, 'nothing dropped');
});

test('scenario mass_event: surge detected, nobody quarantined, alerts raised', () => {
  const app = setup(); app.run('mass_event');
  const snap = app.store.snapshot();
  assert.equal(snap.quarantinedTotal, 0);
  assert.equal(snap.abuse.surge, true);
  assert.ok(open(app, 'SOS_CLUSTER').length >= 1);
});

test('scenario filling: amber warning before 95 %', () => {
  const app = setup(); app.run('filling');
  const w = open(app, 'POINT_FILLING');
  assert.equal(w.length, 1);
  assert.ok(w[0].etaMin <= 10);
  assert.equal(open(app, 'POINT_OVERCROWD').length, 0);
});

test('scenario overcrowd / api_outage / road_block / reset', () => {
  const app = setup();
  app.run('overcrowd');
  assert.equal(open(app, 'POINT_OVERCROWD').length, 1);
  app.run('api_outage');
  assert.equal(app.store.chaos.externalDown, true);
  app.run('road_block');
  assert.ok([...app.graph.edges.values()].filter((e) => e.closed).length >= 1);
  app.run('reset');
  assert.equal(app.store.alerts.length, 0);
  assert.equal(app.store.chaos.externalDown, false);
  assert.ok([...app.graph.edges.values()].every((e) => !e.closed));
});

test('every listed scenario runs without throwing; unknown name is a 404', () => {
  for (const n of SCENARIO_NAMES) { const app = setup(); assert.doesNotThrow(() => app.run(n), n); }
  assert.throws(() => setup().run('nope'), { code: 'SCENARIO_NOT_FOUND' });
});

test('scenario i18n: every scenario has a title + description in all languages', async () => {
  const { dict } = await import('../src/i18n.js');
  for (const lang of Object.keys(dict)) for (const n of SCENARIO_NAMES) {
    assert.ok(dict[lang][`sc.${n}.title`], `${lang} ${n} title`);
    assert.ok(dict[lang][`sc.${n}.desc`], `${lang} ${n} desc`);
  }
});

test('HTTP: scenarios are admin-only', async () => {
  const app = createApp({ tickMs: 0 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (token, body) => fetch(`${base}/api/sim/scenario`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await call('dispatcher-demo', { name: 'cluster' })).status, 403);
  assert.equal((await call('admin-demo', { name: 'cluster' })).status, 200);
  assert.equal((await call('admin-demo', { name: 'nope' })).status, 404);
  const list = await (await fetch(`${base}/api/sim/scenarios`, { headers: { Authorization: 'Bearer admin-demo' } })).json();
  assert.deepEqual(list, SCENARIO_NAMES);
  app.server.closeAllConnections?.(); app.server.close();
});
