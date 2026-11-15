import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

let app; let base;
before(async () => {
  app = createApp({ limits: { sosBurst: 100, sosPerSec: 100 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

const call = async (method, path, { body, token, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), res };
};

test('GET /api/health', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('citizen flow: evacuation -> SOS -> safe', async () => {
  const e = await call('GET', '/api/evacuation?lat=40.4093&lng=49.8330');
  assert.equal(e.status, 200);
  assert.ok(e.json.recommendedPointId);
  const s = await call('POST', '/api/sos', { body: { citizenId: 'u1', type: 'MEDICAL', lat: 40.41, lng: 49.83 } });
  assert.equal(s.status, 201);
  const safe = await call('POST', '/api/safe', { body: { citizenId: 'u1' } });
  assert.equal(safe.status, 200);
  assert.equal(safe.json.resolvedSos, 1);
});

test('validation errors are localized', async () => {
  const az = await call('POST', '/api/sos', { body: { citizenId: 'u', type: 'NOPE', lat: 1, lng: 1 } });
  assert.equal(az.status, 400);
  assert.equal(az.json.error, 'INVALID_SOS_TYPE');
  const en = await call('POST', '/api/sos?lang=en', { body: { citizenId: 'u', type: 'NOPE', lat: 1, lng: 1 } });
  assert.equal(en.json.message, 'Invalid SOS type');
  assert.notEqual(az.json.message, en.json.message);
});

test('malformed JSON => 400, oversize => 413', async () => {
  const bad = await fetch(`${base}/api/sos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  const big = await fetch(`${base}/api/sos`, { method: 'POST', body: JSON.stringify({ note: 'x'.repeat(40_000) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('auth: dashboard needs token; roles are enforced', async () => {
  assert.equal((await call('GET', '/api/dashboard')).status, 401);
  assert.equal((await call('GET', '/api/dashboard', { token: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/api/dashboard', { token: 'dispatcher-demo' })).status, 200);
  assert.equal((await call('GET', '/api/dashboard', { token: 'observer-demo' })).status, 200);
  // observer is read-only
  assert.equal((await call('POST', '/api/roads/x/close', { token: 'observer-demo' })).status, 403);
  // dispatcher cannot use simulation/admin endpoints
  assert.equal((await call('POST', '/api/sim/reset', { token: 'dispatcher-demo' })).status, 403);
  assert.equal((await call('POST', '/api/sim/reset', { token: 'admin-demo' })).status, 200);
});

test('dispatcher flow: 4 SOS -> red alert on dashboard -> one-click approve', async () => {
  await call('POST', '/api/sim/reset', { token: 'admin-demo' });
  for (const id of ['a', 'b', 'c', 'd']) {
    await call('POST', '/api/sos', { body: { citizenId: id, type: 'COLLAPSE', lat: 40.4093, lng: 49.833 } });
  }
  const dash = await call('GET', '/api/dashboard', { token: 'dispatcher-demo' });
  const alert = dash.json.alerts.find((a) => a.status === 'open');
  assert.ok(alert, 'alert present');
  assert.equal(alert.level, 'red');
  const ok = await call('POST', `/api/alerts/${alert.id}/approve`, { token: 'dispatcher-demo' });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.result.brigadeId);
  assert.equal((await call('POST', '/api/alerts/nope/approve', { token: 'dispatcher-demo' })).status, 404);
});

test('road closure via API is reflected in evacuation routes', async () => {
  await call('POST', '/api/sim/reset', { token: 'admin-demo' });
  const before = await call('GET', '/api/evacuation?lat=40.4093&lng=49.8330');
  const rec = before.json.points.find((p) => p.id === before.json.recommendedPointId);
  const roads = (await call('GET', '/api/roads')).json;
  assert.ok(roads.length > 10);
  // find which edges the recommended route uses by closing all roads touching the point
  const touching = roads.filter((r) => r.from.id === rec.id || r.to.id === rec.id);
  for (const r of touching) await call('POST', `/api/roads/${r.id}/close`, { token: 'dispatcher-demo' });
  const after = await call('GET', '/api/evacuation?lat=40.4093&lng=49.8330');
  assert.notEqual(after.json.recommendedPointId, rec.id);
  assert.ok(after.json.rerouted.reasons.includes('ROAD_BLOCKED'));
});

test('external API outage (chaos) keeps citizen endpoint working', async () => {
  await call('POST', '/api/sim/reset', { token: 'admin-demo' });
  await call('POST', '/api/sim/chaos', { token: 'admin-demo', body: { externalDown: true } });
  const r = await call('GET', '/api/evacuation?lat=40.4093&lng=49.8330');
  assert.equal(r.status, 200);
  const rec = r.json.points.find((p) => p.id === r.json.recommendedPointId);
  assert.equal(rec.route.source, 'fallback');
  await call('POST', '/api/sim/reset', { token: 'admin-demo' });
});

test('i18n: all three languages share the same keys', async () => {
  const [az, en, ru] = await Promise.all(['az', 'en', 'ru'].map((l) => call('GET', `/api/i18n/${l}`)));
  const keys = (r) => Object.keys(r.json.messages).sort().join('|');
  assert.equal(keys(az), keys(en));
  assert.equal(keys(az), keys(ru));
});

test('SOS rate limiting kicks in for a flooding client', async () => {
  const limited = createApp({ limits: { sosBurst: 3, sosPerSec: 0.001 } });
  await new Promise((r) => limited.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${limited.server.address().port}/api/sos`;
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({ citizenId: `f${i}`, type: 'FIRE', lat: 40.4, lng: 49.8 }) });
    codes.push(r.status);
  }
  limited.server.closeAllConnections?.();
  limited.server.close();
  assert.deepEqual(codes, [201, 201, 201, 429, 429, 429]);
});

test('path traversal on static files is blocked', async () => {
  const r = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(r.status, 404);
  const idx = await fetch(`${base}/`);
  assert.ok([200, 404].includes(idx.status));
});

test('SSE stream requires auth', async () => {
  assert.equal((await fetch(`${base}/api/stream`)).status, 401);
});
