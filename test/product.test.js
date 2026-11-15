import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { parseSms } from '../src/sms.js';
import { runScenario } from '../src/scenarios.js';

function setup(opts = {}) {
  const clock = { t: 40_000_000 };
  const app = createApp({ now: () => clock.t, tickMs: 0, historyMs: 0, moveMs: 0, tokenSecret: 'k', ...opts });
  return { ...app, clock };
}
const NAS = { lat: 40.4093, lng: 49.8330 };
const YAS = { lat: 40.3850, lng: 49.8150 };
const SEC = 1000;
const sos = (app, id, pos = NAS) => app.store.addSos({ citizenId: id, type: 'FIRE', ...pos, accuracy: 10 }, { ip: `ip-${id}`, deviceId: id, verified: true });
const cluster = (app, pos = NAS) => { ['a', 'b', 'c', 'd'].forEach((i) => sos(app, i, pos)); return app.store.alerts.find((a) => a.status === 'open'); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* ============================== brigade lifecycle ============================== */
test('lifecycle: dispatched -> on_scene -> returning -> available, position interpolated on the way', () => {
  const app = setup();
  const alert = cluster(app);
  const { result } = app.crisis.approve(alert.id);
  const b = app.store.brigades.get(result.brigadeId);
  assert.equal(b.status, 'dispatched');
  const dur = b.move.durationMs;
  assert.ok(dur >= 3000);

  app.clock.t += dur / 2;
  let v = app.store.brigadeView(b);
  assert.ok(near(v.lat, (b.home.lat + alert.center.lat) / 2, 1e-4) && near(v.lng, (b.home.lng + alert.center.lng) / 2, 1e-4), 'halfway');
  assert.ok(v.progress > 0.45 && v.progress < 0.55);
  assert.ok(v.etaSec > 0);

  app.clock.t += dur / 2 + 10;
  app.crisis.tickBrigades();
  assert.equal(b.status, 'on_scene');
  v = app.store.brigadeView(b);
  assert.ok(near(v.lat, alert.center.lat) && near(v.lng, alert.center.lng), 'at the scene');

  app.clock.t += app.crisis.rules.onSceneMs + 10;
  app.crisis.tickBrigades();
  assert.equal(b.status, 'returning');
  assert.ok(b.move && near(b.move.to.lat, b.home.lat));

  app.clock.t += b.move.durationMs + 10;
  app.crisis.tickBrigades();
  assert.equal(b.status, 'available');
  assert.equal(b.alertId, undefined);
  assert.equal(b.move, undefined);
  const home = app.store.brigadeView(b);
  assert.ok(near(home.lat, b.home.lat) && near(home.lng, b.home.lng), 'back at base');
});

test('lifecycle: a returning brigade is NOT available for a new dispatch; after returning it is', () => {
  const app = setup();
  const res = app.crisis.approve(cluster(app).id).result;
  const b = app.store.brigades.get(res.brigadeId);
  app.clock.t += b.move.durationMs + 1; app.crisis.tickBrigades();
  app.clock.t += app.crisis.rules.onSceneMs + 1; app.crisis.tickBrigades();
  assert.equal(b.status, 'returning');
  const free = [...app.store.brigades.values()].filter((x) => x.status === 'available').map((x) => x.id);
  assert.ok(!free.includes(b.id));
  app.clock.t += b.move.durationMs + 1; app.crisis.tickBrigades();
  assert.equal(b.status, 'available');
});

test('lifecycle: brigadeTimeScale speeds the whole mission up', () => {
  const slow = setup(); const fast = setup({ rules: { brigadeTimeScale: 10 } });
  const bs = slow.store.brigades.get(slow.crisis.approve(cluster(slow).id).result.brigadeId);
  const bf = fast.store.brigades.get(fast.crisis.approve(cluster(fast).id).result.brigadeId);
  assert.ok(bf.move.durationMs < bs.move.durationMs / 5, `${bf.move.durationMs} vs ${bs.move.durationMs}`);
  fast.clock.t += bf.move.durationMs + 1; fast.crisis.tickBrigades();
  fast.clock.t += fast.crisis.rules.onSceneMs / 10 + 1; fast.crisis.tickBrigades();
  assert.equal(bf.status, 'returning', 'scene time is scaled as well');
});

test('lifecycle: undo inside the window frees the brigade at base; manual statuses behave', () => {
  const app = setup();
  const alert = cluster(app);
  const res = app.crisis.approve(alert.id).result;
  const b = app.store.brigades.get(res.brigadeId);
  app.clock.t += 2000;
  app.crisis.undo(alert.id);
  assert.equal(b.status, 'available');
  assert.equal(b.move, undefined);
  assert.ok(near(app.store.brigadeView(b).lat, b.home.lat));

  app.crisis.approve(alert.id);
  app.store.setBrigadeStatus(b.id, 'available');
  assert.equal(b.status, 'available');
  assert.equal(b.target, undefined);
  assert.throws(() => app.store.setBrigadeStatus(b.id, 'flying'), { code: 'INVALID_STATUS' });
  app.store.setBrigadeStatus(b.id, 'returning');
  assert.equal(app.store.brigades.get(b.id).status, 'returning');
});

test('lifecycle: tickBrigades emits only while something moves (idle system stays quiet)', () => {
  const app = setup();
  let changes = 0; app.store.on('change', (k) => { if (k === 'brigade') changes += 1; });
  app.crisis.tickBrigades(); assert.equal(changes, 0);
  app.crisis.approve(cluster(app).id);
  app.crisis.tickBrigades(); assert.ok(changes >= 1);
});

test('citizen progress: stage 3 with a shrinking ETA, stage 4 on scene and after the mission', () => {
  const app = setup();
  const mine = sos(app, 'mine');
  ['b', 'c', 'd'].forEach((i) => sos(app, i));
  assert.equal(app.store.sosStatus(mine.id).stage, 2);
  const res = app.crisis.approve(app.store.alerts.find((a) => a.status === 'open').id).result;
  const b = app.store.brigades.get(res.brigadeId);
  const s1 = app.store.sosStatus(mine.id);
  assert.equal(s1.stage, 3);
  assert.ok(s1.etaSec > 0);
  app.clock.t += (b.move.durationMs / 2);
  const s2 = app.store.sosStatus(mine.id);
  assert.ok(s2.etaSec < s1.etaSec, 'ETA counts down');
  app.clock.t += b.move.durationMs; app.crisis.tickBrigades();
  assert.equal(app.store.sosStatus(mine.id).stage, 4);
  app.clock.t += app.crisis.rules.onSceneMs + 1; app.crisis.tickBrigades();
  assert.equal(app.store.sosStatus(mine.id).stage, 4, 'still "arrived" while the brigade returns');
  app.clock.t += b.move.durationMs + 1; app.crisis.tickBrigades();
  assert.equal(app.store.sosStatus(mine.id).stage, 4, 'and after it is back at base');
});

test('lifecycle: dashboard + history carry live brigade position, progress and ETA', () => {
  const app = setup();
  const res = app.crisis.approve(cluster(app).id).result;
  const b = app.store.brigades.get(res.brigadeId);
  app.clock.t += b.move.durationMs / 2;
  const view = app.store.snapshot().brigades.find((x) => x.id === b.id);
  assert.ok(view.progress > 0.4 && view.etaSec > 0 && view.home && view.target);
  const f = app.history.record({ force: true });
  const row = f.brigades.find((x) => x[0] === b.id);
  assert.equal(row[1], 'dispatched');
  assert.ok(row.length === 4 && Math.abs(row[2] - b.home.lat) > 1e-5, 'frame has the interpolated position');
});

test('lifecycle: accessible transport for a priority SOS moves too', () => {
  const app = setup();
  app.store.setProfile('w', { role: 'priority', needs: ['wheelchair'] });
  app.store.addSos({ citizenId: 'w', type: 'MEDICAL', ...YAS, accuracy: 8 }, { ip: 'x', deviceId: 'w', verified: true, profile: app.store.getProfile('w') });
  const res = app.crisis.approve(app.store.alerts.find((a) => a.type === 'PRIORITY_SOS').id).result;
  const b = app.store.brigades.get(res.brigadeId);
  assert.equal(b.kind, 'accessible_transport');
  assert.ok(b.move.durationMs > 0);
});

/* ============================== decision journal ============================== */
async function http(app) {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, path, { body, token, headers = {} } = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const close = () => { app.server.closeAllConnections?.(); app.server.close(); };
  return { call, close };
}

test('journal: human decisions and system alert events are recorded without any identifiers', async () => {
  const app = setup();
  const { call, close } = await http(app);
  cluster(app);
  const alert = app.store.alerts[0];
  await call('POST', `/api/alerts/${alert.id}/approve`, { token: 'dispatcher-demo' });
  await call('POST', `/api/alerts/${alert.id}/undo`, { token: 'dispatcher-demo' });
  const roads = await (await call('GET', '/api/roads')).json();
  await call('POST', `/api/roads/${roads[0].id}/close`, { token: 'dispatcher-demo' });
  await call('POST', `/api/brigades/b1/status`, { token: 'dispatcher-demo', body: { status: 'offline' } });
  await call('POST', '/api/sim/scenario', { token: 'admin-demo', body: { name: 'overcrowd' } });

  const j = await (await call('GET', '/api/decisions?limit=50', { token: 'observer-demo' })).json();
  const actions = j.decisions.map((d) => d.action);
  for (const a of ['alert.created', 'alert.approve', 'alert.undo', 'road.close', 'brigade.status', 'sim.scenario']) assert.ok(actions.includes(a), a);
  const approve = j.decisions.find((d) => d.action === 'alert.approve');
  assert.equal(approve.actor, 'dispatcher');
  assert.equal(approve.target, alert.id);
  assert.ok(approve.details.brigadeId);
  assert.equal(j.decisions.find((d) => d.action === 'alert.created').actor, 'system');
  assert.equal(j.decisions[0].t >= j.decisions.at(-1).t, true, 'newest first');
  const json = JSON.stringify(j);
  assert.ok(!/ip-a|127\.0\.0\.1|dispatcher-demo|admin-demo/.test(json), 'no ip / token / citizen id in the journal');
  assert.equal((await call('GET', '/api/decisions')).status, 401);
  assert.equal((await call('GET', '/api/decisions?limit=1', { token: 'admin-demo' }).then((r) => r.json())).decisions.length, 1);
  close();
});

test('journal: failed (rejected) actions are not logged as decisions; snapshot carries the latest ones', async () => {
  const app = setup();
  const { call, close } = await http(app);
  const before = app.audit.items.length;
  assert.equal((await call('POST', '/api/alerts/nope/approve', { token: 'dispatcher-demo' })).status, 404);
  assert.equal((await call('POST', '/api/alerts/nope/approve', { token: 'observer-demo' })).status, 403);
  const added = app.audit.items.slice(before);
  assert.ok(!added.some((d) => d.action === 'alert.approve'), 'a failed action is never logged as a decision');
  assert.deepEqual(added.map((d) => d.action), ['auth.denied'], 'the refused attempt of the observer is recorded as a security event');
  assert.equal(added[0].actor, 'observer'); assert.equal(added[0].details.needs, 'alert:approve');
  cluster(app);
  assert.ok(app.store.snapshot && app.crisis.decorate(app.store.snapshot()) && true);
  const dash = await (await call('GET', '/api/dashboard', { token: 'dispatcher-demo' })).json();
  assert.ok(Array.isArray(dash.decisions) && dash.decisions.some((d) => d.action === 'alert.created'));
  close();
});

/* ============================== mass notification ============================== */
test('broadcast: validation', () => {
  const app = setup(); const b = app.broadcasts;
  for (const bad of [null, {}, { type: 'nope' }, { type: 'evacuate', target: { kind: 'all' } }, { type: 'evacuate', target: { kind: 'all' }, pointId: 'r1' /* inactive reserve */ },
    { type: 'custom', target: { kind: 'all' } }, { type: 'custom', target: { kind: 'all' }, text: { az: '   ' } },
    { type: 'shelter', target: { kind: 'districts', districts: ['atlantis'] } }, { type: 'shelter', target: { kind: 'districts', districts: [] } },
    { type: 'shelter', target: { kind: 'radius', lat: 40.4, lng: 49.8, radiusM: 5 } }, { type: 'shelter', target: { kind: 'radius', lat: 99, lng: 49.8, radiusM: 500 } }, { type: 'shelter', target: { kind: 'zone' } }]) {
    assert.throws(() => b.create(bad), { code: 'INVALID_BROADCAST' }, JSON.stringify(bad));
  }
  const ok = b.create({ type: 'custom', severity: 'critical', target: { kind: 'all' }, text: { az: 'x'.repeat(500), en: 'hello' } });
  assert.equal(ok.severity, 'critical');
  assert.equal(b.items[0].text.az.length, 280, 'text capped');
  assert.equal(b.create({ type: 'evacuate', severity: 'info', target: { kind: 'all' }, pointId: 'p5' }).severity, 'critical', 'evacuate is always critical');
});

test('broadcast: targeting by city / district / radius, and location-less clients only get city-wide notices', () => {
  const app = setup(); const b = app.broadcasts;
  b.create({ type: 'shelter', target: { kind: 'all' } });
  b.create({ type: 'avoid_area', target: { kind: 'districts', districts: ['yasamal'] } });
  b.create({ type: 'custom', target: { kind: 'radius', lat: NAS.lat, lng: NAS.lng, radiusM: 1000 }, text: { az: 'salam' } });
  const types = (pos) => b.forClient({ pos, key: 'k' }).map((x) => x.type).sort();
  assert.deepEqual(types(null), ['shelter']);
  assert.deepEqual(types(YAS), ['avoid_area', 'shelter']);
  assert.deepEqual(types(NAS), ['custom', 'shelter']);
  assert.deepEqual(types({ lat: 40.6, lng: 49.0 }), ['shelter']);
});

test('broadcast: an accessible user is moved from a point without a ramp to the nearest accessible one', () => {
  const app = setup(); const b = app.broadcasts;
  assert.equal(app.store.points.get('p3').accessible, false);
  b.create({ type: 'evacuate', target: { kind: 'all' }, pointId: 'p3' });
  const normal = b.forClient({ pos: NAS, key: 'n' })[0];
  assert.equal(normal.point.id, 'p3');
  assert.equal(normal.substituted, false);
  const acc = b.forClient({ pos: NAS, accessible: true, key: 'a' })[0];
  assert.notEqual(acc.point.id, 'p3');
  assert.equal(acc.point.accessible, true);
  assert.equal(acc.substituted, true);
  b.create({ type: 'evacuate', target: { kind: 'all' }, pointId: 'p5' }); // already accessible: kept
  assert.equal(b.forClient({ pos: NAS, accessible: true, key: 'a' })[0].substituted, false);
});

test('broadcast: expiry, cancellation, and "all clear" only retracts what it covers', () => {
  const app = setup(); const b = app.broadcasts;
  const e = b.create({ type: 'shelter', target: { kind: 'all' }, expiresInMin: 5 });
  assert.equal(b.forClient({ pos: NAS, key: 'k' }).length, 1);
  app.clock.t += 6 * 60_000;
  assert.equal(b.forClient({ pos: NAS, key: 'k' }).length, 0);
  assert.equal(b.summary(b.items[0]).status, 'expired');

  const all = b.create({ type: 'shelter', target: { kind: 'all' } });
  const yas = b.create({ type: 'avoid_area', target: { kind: 'districts', districts: ['yasamal'] } });
  b.create({ type: 'all_clear', target: { kind: 'districts', districts: ['yasamal'] } }); // covers yasamal only
  const active = () => b.forClient({ pos: YAS, key: 'k' }).map((x) => x.type).sort();
  assert.deepEqual(active(), ['all_clear', 'shelter'], 'the district clear retracted the district warning but not the city-wide one');
  b.create({ type: 'all_clear', target: { kind: 'all' } });
  assert.deepEqual(active(), ['all_clear', 'all_clear']);
  assert.equal(b.cancel(all.id).status, 'cancelled');
  assert.throws(() => b.cancel('bc999'), { code: 'BROADCAST_NOT_FOUND' });
  assert.ok(e && yas);
});

test('broadcast: reach/ack are counted per distinct device and the dispatcher summary never exposes device keys', () => {
  const app = setup(); const b = app.broadcasts;
  const sent = b.create({ type: 'shelter', target: { kind: 'all' } });
  for (const k of ['d1', 'd2', 'd1']) b.forClient({ pos: NAS, key: k });
  b.forClient({ pos: null, key: 'd3' });
  assert.equal(b.summary(b.items[0]).reach, 3);
  b.ack(sent.id, 'd1'); b.ack(sent.id, 'd1'); b.ack(sent.id, 'd9');
  const s = b.summary(b.items[0]);
  assert.equal(s.acks, 2);
  assert.equal(s.reach, 4, 'acking counts as reached');
  assert.ok(!JSON.stringify(s).includes('d1'));
  assert.throws(() => b.ack('nope', 'x'), { code: 'BROADCAST_NOT_FOUND' });
});

test('broadcast HTTP: dispatcher sends (rights enforced), citizens poll with their position, ack, journal + snapshot', async () => {
  const app = setup();
  const { call, close } = await http(app);
  const body = { type: 'evacuate', target: { kind: 'districts', districts: ['nasimi'] }, pointId: 'p3', expiresInMin: 10 };
  assert.equal((await call('POST', '/api/broadcasts', { body })).status, 401);
  assert.equal((await call('POST', '/api/broadcasts', { body, token: 'observer-demo' })).status, 403);
  assert.equal((await call('POST', '/api/broadcasts', { body: { type: 'zzz' }, token: 'dispatcher-demo' })).status, 400);
  const made = await call('POST', '/api/broadcasts', { body, token: 'dispatcher-demo' });
  assert.equal(made.status, 201);
  const id = (await made.json()).id;

  const poll = async (q, headers) => (await (await call('GET', `/api/broadcasts${q}`, { headers })).json()).broadcasts;
  assert.equal((await poll('')).length, 0, 'no position: a district-targeted notice is not delivered');
  assert.equal((await poll(`?lat=${YAS.lat}&lng=${YAS.lng}`)).length, 0, 'other district');
  const mine = await poll(`?lat=${NAS.lat}&lng=${NAS.lng}`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].point.id, 'p3');
  const acc = await poll(`?lat=${NAS.lat}&lng=${NAS.lng}&accessible=1`);
  assert.equal(acc[0].substituted, true);

  // a priority device gets the accessible variant automatically
  const { token } = await (await call('POST', '/api/session', { body: {} })).json();
  await call('POST', '/api/profile', { headers: { 'X-Device-Token': token }, body: { role: 'priority', needs: ['wheelchair'] } });
  assert.equal((await poll(`?lat=${NAS.lat}&lng=${NAS.lng}`, { 'X-Device-Token': token }))[0].substituted, true);

  assert.equal((await call('POST', `/api/broadcasts/${id}/ack`)).status, 200);
  const dash = await (await call('GET', '/api/dashboard', { token: 'dispatcher-demo' })).json();
  const row = dash.broadcasts.find((x) => x.id === id);
  assert.ok(row.reach >= 2 && row.acks === 1 && row.status === 'active');
  const actions = (await (await call('GET', '/api/decisions', { token: 'dispatcher-demo' })).json()).decisions.map((d) => d.action);
  assert.ok(actions.includes('broadcast.send'));
  assert.equal((await call('POST', `/api/broadcasts/${id}/cancel`, { token: 'dispatcher-demo' })).status, 200);
  assert.equal((await poll(`?lat=${NAS.lat}&lng=${NAS.lng}`)).length, 0, 'withdrawn');
  assert.equal((await call('POST', `/api/broadcasts/nope/ack`)).status, 404);
  close();
});

/* ============================== SMS fallback ============================== */
test('sms parser: intents, types, needs, districts, coordinates, diacritics and language', () => {
  const app = setup(); const D = app.store.districts;
  let p = parseSms('SOS YANGIN NESIMI', D);
  assert.deepEqual([p.intent, p.type, p.districtId, p.lang], ['sos', 'FIRE', 'nasimi', 'az']);
  p = parseSms('sos yanğın Nəsimi', D);  // Azerbaijani letters, lower case
  assert.deepEqual([p.intent, p.type, p.districtId], ['sos', 'FIRE', 'nasimi']);
  p = parseSms('help fire nasimi', D);
  assert.deepEqual([p.type, p.lang], ['FIRE', 'en']);
  p = parseSms('SOS 40.4093, 49.8330', D);
  assert.deepEqual(p.pos, { lat: 40.4093, lng: 49.833 });
  assert.equal(p.fromCoords, true);
  p = parseSms('SOS 40,4093 49,8330 sel', D);
  assert.equal(p.type, 'FLOOD');
  assert.deepEqual(p.pos, { lat: 40.4093, lng: 49.833 });
  assert.deepEqual(parseSms('SOS ELIL ARABASI YASAMAL', D).needs, ['wheelchair']);
  assert.deepEqual(parseSms('HELP wheelchair transport yasamal', D).needs.sort(), ['medical_transport', 'wheelchair']);
  assert.equal(parseSms('SOS NESIMI', D).type, 'MEDICAL', 'an unlabeled call is treated as medical');
  assert.equal(parseSms('TEHLUKESIZEM', D).intent, 'safe');
  assert.equal(parseSms('SAFE', D).intent, 'safe');
  assert.equal(parseSms('YER NESIMI', D).intent, 'point');
  assert.equal(parseSms('salam necesen', D).intent, 'unknown');
  assert.equal(parseSms('SOS YANGIN', D).pos, null);
  assert.equal(parseSms('SOS 99.5 200.1', D).pos, null, 'invalid coordinates are rejected');
});

test('sms: SOS creates a verified SMS-sourced signal; the phone number is never stored', () => {
  const app = setup();
  const r = app.sms.handle({ from: '+994501234567', text: 'SOS YANGIN NESIMI' });
  assert.equal(r.intent, 'sos');
  assert.match(r.reply, /SOS qəbul edildi/);
  assert.match(r.reply, /Nəsimi/);
  const s = app.store.findSos(r.sosId);
  assert.equal(s.source, 'sms');
  assert.equal(s.verified, true);
  assert.equal(s.type, 'FIRE');
  assert.ok(s.deviceId.startsWith('sms-'));
  const dump = JSON.stringify([...app.store.sos, ...app.store.profiles, app.store.snapshot()]);
  assert.ok(!dump.includes('994501234567') && !dump.includes('501234567'), 'no phone number anywhere');
  assert.equal(app.sms.deviceFor('+994 50 123 45 67'), s.deviceId, 'the same number always maps to the same anonymous id');
  assert.equal(r.reply.includes('{'), false, 'no unfilled placeholders');
  assert.equal(app.sms.handle({ from: '+994709999999', text: 'help fire nasimi' }).reply.startsWith('SOS received'), true, 'English reply to an English message');
});

test('sms: four different numbers raise a red alert and nobody is quarantined (gateway is not a bot IP)', () => {
  const app = setup();
  for (let i = 0; i < 4; i++) app.sms.handle({ from: `+99450000000${i}`, text: 'SOS YANGIN YASAMAL' });
  assert.equal(app.store.alerts.filter((a) => a.type === 'SOS_CLUSTER' && a.status === 'open').length, 1);
  assert.equal(app.store.snapshot().quarantinedTotal, 0);
  // even a big SMS burst from many numbers is never mistaken for an IP-concentration attack
  const big = setup();
  for (let i = 0; i < 30; i++) { big.clock.t += 300; big.sms.handle({ from: `+9945077${String(10000 + i)}`, text: 'SOS SEL NESIMI' }); }
  assert.equal(big.store.snapshot().quarantinedTotal, 0);
});

test('sms: needs keywords make it a Priority #1 SOS with an immediate alert', () => {
  const app = setup();
  const r = app.sms.handle({ from: '+994501110000', text: 'SOS ELIL ARABASI YASAMAL' });
  assert.equal(r.priority, 1);
  assert.match(r.reply, /Kritik Prioritet #1/);
  assert.equal(app.store.alerts.filter((a) => a.type === 'PRIORITY_SOS' && a.status === 'open').length, 1);
});

test('sms: SAFE closes the open SOS, POINT answers with the nearest point, bad input gets help, missing location is asked for', () => {
  const app = setup();
  app.sms.handle({ from: '+994501110001', text: 'SOS YANGIN NESIMI' });
  assert.equal(app.store.zoneCounts().nasimi, 1);
  const safe = app.sms.handle({ from: '+994501110001', text: 'TEHLUKESIZEM' });
  assert.match(safe.reply, /təhlükəsiz/i);
  assert.equal(app.store.zoneCounts().nasimi, 0);
  assert.match(app.sms.handle({ from: '+994501110001', text: 'SAFE' }).reply, /No open SOS|Açıq SOS tapılmadı/);

  const pt = app.sms.handle({ from: '+994501110002', text: 'YER NESIMI' });
  assert.equal(pt.intent, 'point');
  assert.match(pt.reply, /Ən yaxın məntəqə: .+, \d+ m, doluluq [\d.]+%/);
  const acc = app.sms.handle({ from: '+994501110002', text: 'YER ELIL NESIMI' });
  assert.equal(app.store.points.get(acc.pointId).accessible, true, 'an accessible user is pointed to an accessible place');

  assert.match(app.sms.handle({ from: '+994501110003', text: 'salam' }).reply, /Komandalar/);
  const noLoc = app.sms.handle({ from: '+994501110004', text: 'SOS YANGIN' });
  assert.match(noLoc.reply, /Yeri başa düşmədik/);
  assert.equal(noLoc.sosId, undefined);
  assert.throws(() => app.sms.handle({ from: '', text: 'SOS' }), { code: 'INVALID_SMS' });
  assert.throws(() => app.sms.handle({ from: '+1', text: 'x'.repeat(400) }), { code: 'INVALID_SMS' });
});

test('sms: per-number rate limit (3 messages, then a polite refusal and no SOS)', () => {
  const app = setup();
  const out = [];
  for (let i = 0; i < 5; i++) out.push(app.sms.handle({ from: '+994501119999', text: 'SOS YANGIN NESIMI' }));
  assert.equal(out.filter((r) => r.sosId).length, 3);
  assert.equal(out[3].limited, true);
  assert.match(out[3].reply, /Çox mesaj/);
});

test('sms HTTP: the gateway must present its key; the admin simulator needs admin; config advertises the number', async () => {
  const app = setup({ smsGatewayKey: 'secret-gw', smsNumber: '7777' });
  const { call, close } = await http(app);
  const body = { from: '+994501110000', text: 'SOS YANGIN NESIMI' };
  assert.equal((await call('POST', '/api/sms/inbound', { body })).status, 401);
  assert.equal((await call('POST', '/api/sms/inbound', { body, headers: { 'X-Gateway-Key': 'wrong-key-xx' } })).status, 401);
  const ok = await call('POST', '/api/sms/inbound', { body, headers: { 'X-Gateway-Key': 'secret-gw' } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).intent, 'sos');
  assert.equal((await call('POST', '/api/sms/inbound', { body: { from: 'x' }, headers: { 'X-Gateway-Key': 'secret-gw' } })).status, 400);
  assert.equal((await call('POST', '/api/sim/sms', { body, token: 'dispatcher-demo' })).status, 403);
  assert.equal((await call('POST', '/api/sim/sms', { body: { from: '+994501110008', text: 'YER NESIMI' }, token: 'admin-demo' })).status, 200);
  assert.equal((await (await call('GET', '/api/config')).json()).sms.number, '7777');
  close();
});

test('scenarios sms_sos and broadcast_demo work through the real pipeline', () => {
  const app = setup();
  const deps = { store: app.store, graph: app.graph, resetAll: () => {}, sms: app.sms, broadcasts: app.broadcasts };
  runScenario('sms_sos', deps);
  assert.equal(app.store.alerts.filter((a) => a.type === 'SOS_CLUSTER' && a.status === 'open').length, 1);
  runScenario('broadcast_demo', deps);
  const got = app.broadcasts.forClient({ pos: NAS, accessible: true, key: 'k' });
  assert.equal(got.length, 1);
  assert.equal(got[0].point.id, 'p5');
});
