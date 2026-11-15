import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Sessions } from '../src/session.js';
import { effectiveTrust, geoAssess, isExempt, penalizeTrust, rewardTrust, TRUST } from '../src/trust.js';
import { detectBots } from '../src/botdetect.js';

function setup(opts = {}) {
  const clock = { t: 1_000_000 };
  const app = createApp({ now: () => clock.t, tokenSecret: 'test-secret', ...opts });
  return { ...app, clock };
}
const NAS = { lat: 40.4093, lng: 49.8330 };
// helper: one SOS from a given device / ip
const send = (app, id, { ip = '198.51.100.1', verified = false, pos = NAS, type = 'FIRE', accuracy = 10 } = {}) =>
  app.store.addSos({ citizenId: id, type, ...pos, accuracy }, { ip, deviceId: id, verified });
const open = (app) => app.store.alerts.filter((a) => a.status === 'open');

// ---------------- trust.js ----------------
test('trust: unsigned and brand-new devices are capped; established verified ones are exempt', () => {
  assert.equal(effectiveTrust(0.9, 10 * 60_000, true), 0.9);
  assert.equal(effectiveTrust(0.9, 10 * 60_000, false), 0.2);
  assert.equal(effectiveTrust(0.9, 60_000, true), 0.3);
  const now = 10_000_000;
  assert.equal(isExempt({ verified: true, firstSeen: now - 3 * 60_000, trust: 0.5 }, now), true);
  assert.equal(isExempt({ verified: true, firstSeen: now - 30_000, trust: 0.5 }, now), false, 'too new');
  assert.equal(isExempt({ verified: false, firstSeen: now - 9e6, trust: 0.9 }, now), false, 'unsigned');
  assert.equal(isExempt({ verified: true, firstSeen: now - 9e6, trust: 0.3 }, now), false, 'low trust');
});

test('trust: reward/penalty stay inside [min,max]', () => {
  let t = TRUST.start;
  for (let i = 0; i < 30; i++) t = penalizeTrust(t);
  assert.equal(t, TRUST.min);
  for (let i = 0; i < 40; i++) t = rewardTrust(t);
  assert.equal(t, TRUST.max);
});

test('geoAssess: far outside the city = out_of_area; missing accuracy = weak but not flagged', () => {
  assert.deepEqual(geoAssess(40_000, 10), { weight: 0, flag: 'out_of_area' });
  assert.deepEqual(geoAssess(2_000, null), { weight: 0.4, flag: null });
  assert.deepEqual(geoAssess(2_000, 900), { weight: 0.4, flag: null });
  assert.deepEqual(geoAssess(2_000, 15), { weight: 1, flag: null });
});

// ---------------- session.js ----------------
test('sessions: tokens verify, tampering and garbage do not, ids are kept for reputation', () => {
  const s = new Sessions('k');
  const { deviceId, token } = s.issue();
  assert.equal(s.verify(token), deviceId);
  assert.equal(s.verify(token.slice(0, -2) + 'xx'), null);
  assert.equal(s.verify(`other-device-123.${token.split('.').pop()}`), null);
  assert.equal(s.verify(undefined), null);
  assert.equal(s.verify('nodots'), null);
  assert.equal(s.issue(deviceId).deviceId, deviceId, 'same id re-signed');
  assert.notEqual(s.issue('bad id with spaces').deviceId, 'bad id with spaces');
  assert.equal(new Sessions('other').verify(token), null, 'different secret');
});

// ---------------- botdetect.js ----------------
test('botdetect: needs two signals AND a culprit; surge without culprit is not an attack', () => {
  const now = 5_000_000;
  const devices = new Map();
  // 25 reports in the last minute from 25 different IPs: burst only -> not an attack
  const crowd = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, ts: now - i * 1000, ip: `ip${i}`, deviceId: `d${i}` }));
  const v1 = detectBots(crowd, now, devices, {});
  assert.equal(v1.attack, false);
  assert.equal(v1.suspiciousIds.size, 0);
  // same volume from ONE ip with 25 devices: burst + ip_concentration -> attack
  const flood = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, ts: now - i * 1000, ip: 'evil', deviceId: `x${i}` }));
  const v2 = detectBots(flood, now, devices, {});
  assert.equal(v2.attack, true);
  assert.ok(v2.signals.some((s) => s.code === 'burst') && v2.signals.some((s) => s.code === 'ip_concentration'));
  assert.equal(v2.suspiciousIds.size, 25);
});

// ---------------- integration with the crisis engine ----------------
test('demo-compat: 4 different ids from ONE ip still raise the red alert (single signal only)', () => {
  const app = setup();
  ['a', 'b', 'c', 'd'].forEach((id) => send(app, id));
  assert.equal(open(app).length, 1);
});

test('fake flood: 30 ids from one IP are quarantined, never raise an alert, stay visible to the dispatcher', () => {
  const app = setup();
  for (let i = 0; i < 30; i++) { app.clock.t += 500; send(app, `bot${i}`, { ip: '6.6.6.6' }); }
  assert.equal(open(app).length, 0, 'no alert from a flood');
  const snap = app.store.snapshot();
  assert.ok(snap.quarantinedTotal >= 20, `quarantined=${snap.quarantinedTotal}`);
  assert.equal(snap.abuse.attack, true);
  assert.ok(snap.abuse.signals.some((s) => s.code === 'ip_concentration'));
  assert.ok(snap.quarantined.every((s) => s.flags.includes('bot_attack') || s.flags.includes('low_trust')));
  assert.equal(app.store.sos.length, 30, 'nothing was dropped');
});

test('an alert raised before the flood was recognised withdraws itself once its evidence is quarantined', () => {
  const app = setup({ rules: { ipDeviceLimit: 6 } });
  ['a', 'b', 'c', 'd'].forEach((id) => send(app, id, { ip: '6.6.6.6' }));
  assert.equal(open(app).length, 1, 'looks real at first');
  for (let i = 0; i < 24; i++) { app.clock.t += 400; send(app, `x${i}`, { ip: '6.6.6.6' }); }
  assert.equal(open(app).length, 0, 'withdrawn');
  assert.ok(app.store.alerts.some((a) => a.status === 'expired'));
});

test('a genuine mass event from many IPs raises alerts and quarantines nobody', () => {
  const app = setup();
  for (let i = 0; i < 40; i++) { app.clock.t += 400; send(app, `p${i}`, { ip: `ip-${i}` }); }
  assert.equal(app.store.snapshot().quarantinedTotal, 0);
  assert.ok(open(app).length >= 1);
});

test('verified, established devices behind a shared IP (NAT) are not quarantined', () => {
  const app = setup();
  const ids = Array.from({ length: 8 }, (_, i) => `nat-device-${i}`);
  for (const id of ids) app.store.guard.device(id, true);
  app.clock.t += 3 * 60_000; // devices are now established (>2 min)
  for (const id of ids) for (let k = 0; k < 3; k++) { app.clock.t += 800; send(app, id, { ip: '9.9.9.9', verified: true }); }
  assert.equal(app.store.snapshot().quarantinedTotal, 0);
  assert.ok(open(app).length >= 1);
});

test('out-of-area coordinates are flagged + quarantined (cannot trigger an alert)', () => {
  const app = setup();
  const far = { lat: 41.7, lng: 44.8 }; // Tbilisi
  ['a', 'b', 'c', 'd'].forEach((id) => send(app, id, { pos: far }));
  assert.equal(open(app).length, 0);
  assert.ok(app.store.sos.every((s) => s.flags.includes('out_of_area') && s.quarantined));
});

test('release: dispatcher overrides a quarantine and the SOS counts again', () => {
  const app = setup();
  const far = { lat: 41.7, lng: 44.8 };
  const odd = send(app, 'odd', { pos: far });
  assert.equal(odd.quarantined, true);
  app.store.guard.release(odd.id);
  assert.equal(app.store.findSos(odd.id).quarantined, false);
  assert.ok(app.store.findSos(odd.id).flags.includes('released'));
  // released SOS is not re-quarantined by later analysis
  send(app, 'x1'); send(app, 'x2');
  assert.equal(app.store.findSos(odd.id).quarantined, false);
});

test('security mode (requireVerified): unsigned SOS no longer escalate, signed ones do', () => {
  const app = setup();
  app.crisis.setRules({ requireVerified: true });
  ['a', 'b', 'c', 'd'].forEach((id) => send(app, id, { ip: `ip-${id}` }));
  assert.equal(open(app).length, 0);
  ['v1', 'v2', 'v3', 'v4'].forEach((id) => send(app, id, { verified: true, ip: `ip-${id}` }));
  assert.equal(open(app).length, 1);
});

test('quarantineEnabled=false: suspicious SOS are flagged but still count', () => {
  const app = setup();
  app.crisis.setRules({ quarantineEnabled: false });
  for (let i = 0; i < 30; i++) { app.clock.t += 500; send(app, `bot${i}`, { ip: '6.6.6.6' }); }
  assert.equal(app.store.snapshot().quarantinedTotal, 0);
  assert.ok(open(app).length >= 1);
});

test('approving an alert raises the trust of its reporters', () => {
  const app = setup();
  ['a', 'b', 'c', 'd'].forEach((id) => send(app, id, { verified: true }));
  const before = app.store.guard.devices.get('a').trust;
  app.crisis.approve(open(app)[0].id);
  assert.ok(app.store.guard.devices.get('a').trust > before);
});

test('setRules validates keys and types', () => {
  const app = setup();
  assert.throws(() => app.crisis.setRules({ nope: 1 }), { code: 'INVALID_RULE' });
  assert.throws(() => app.crisis.setRules({ minDistinctReporters: 'four' }), { code: 'INVALID_RULE' });
  assert.throws(() => app.crisis.setRules({ overcrowdPct: -5 }), { code: 'INVALID_RULE' });
  assert.equal(app.crisis.setRules({ minDistinctReporters: 3 }).minDistinctReporters, 3);
});

test('dashboard snapshot never leaks IPs, device ids or citizen ids', () => {
  const app = setup();
  send(app, 'secret-device-id', { ip: '203.0.113.7' });
  const json = JSON.stringify(app.store.snapshot());
  assert.ok(!json.includes('203.0.113.7'));
  assert.ok(!json.includes('secret-device-id'));
});

test('private / loopback / proxy addresses are never used for IP-concentration analysis (localhost load tests, LAN demos)', async () => {
  const { isPrivateIp, clientIp } = await import('../src/net.js');
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.9', 'fd00::1', 'unknown']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['198.51.100.1', '8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(isPrivateIp(ip), false, ip);
  const app = setup();
  for (let i = 0; i < 40; i++) { app.clock.t += 300; send(app, `local${i}`, { ip: '127.0.0.1' }); }
  assert.equal(app.store.snapshot().quarantinedTotal, 0, 'a localhost flood is not an attributable attack');
  const req = (xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '172.18.0.2' } });
  assert.equal(clientIp(req('203.0.113.9, 10.0.0.1'), true), '203.0.113.9');
  assert.equal(clientIp(req('203.0.113.9'), false), '172.18.0.2', 'X-Forwarded-For ignored unless TRUST_PROXY');
});

// ---------------- HTTP ----------------
test('HTTP: /api/session issues tokens; signed SOS is verified, forged/missing token is accepted as unverified', async () => {
  const app = setup();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const sess = await (await post('/api/session', {})).json();
  assert.ok(sess.token.startsWith(sess.deviceId));
  const payload = { citizenId: 'ignored-when-signed', type: 'FIRE', lat: 40.41, lng: 49.83 };
  const ok = await (await post('/api/sos', payload, { 'X-Device-Token': sess.token })).json();
  assert.equal(ok.verified, true);
  assert.equal(app.store.findSos(ok.id).citizenId, sess.deviceId, 'identity comes from the token, not the body');
  const forged = await post('/api/sos', { ...payload, citizenId: 'forger1' }, { 'X-Device-Token': sess.token.slice(0, -3) + 'abc' });
  assert.equal(forged.status, 201, 'a forged token must NEVER cause an SOS to be rejected');
  assert.equal((await forged.json()).verified, false);
  const none = await post('/api/sos', { ...payload, citizenId: 'curl-user' });
  assert.equal(none.status, 201);
  app.server.closeAllConnections?.(); app.server.close();
});

test('HTTP: session minting is rate limited; release needs dispatcher rights', async () => {
  const app = setup({ limits: { sessionBurst: 3, sessionPerSec: 0.001 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.equal((await fetch(`${base}/api/sos/s1/release`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/sos/s1/release`, { method: 'POST', headers: { Authorization: 'Bearer observer-demo' } })).status, 403);
  const far = app.store.addSos({ citizenId: 'odd', type: 'FIRE', lat: 41.7, lng: 44.8 }, { ip: 'x' });
  const rel = await fetch(`${base}/api/sos/${far.id}/release`, { method: 'POST', headers: { Authorization: 'Bearer dispatcher-demo' } });
  assert.equal(rel.status, 200);
  assert.equal((await rel.json()).quarantined, false);
  app.server.closeAllConnections?.(); app.server.close();
});
