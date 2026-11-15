import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { signJwt, verifyJwt } from '../src/jwt.js';

const SECRET = 'unit-test-secret';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ---------------- JWT ----------------
test('jwt: valid token round-trips, expired / tampered / alg=none / wrong secret are rejected', () => {
  const now = 1_700_000_000_000;
  const tok = signJwt({ sub: 'a', role: 'admin' }, SECRET, { ttlSec: 60, now });
  assert.equal(verifyJwt(tok, SECRET, { now: now + 1000 }).sub, 'a');
  assert.equal(verifyJwt(tok, SECRET, { now: now + 61_000 }), null, 'expired');
  assert.equal(verifyJwt(tok, 'other', { now }), null, 'wrong secret');
  const [h, p, s] = tok.split('.');
  const forged = b64({ sub: 'a', role: 'admin', exp: 9_999_999_999, jti: 'x' });
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, SECRET, { now }), null, 'payload changed');
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`;
  assert.equal(verifyJwt(none, SECRET, { now }), null, 'alg none');
  const hs512 = b64({ alg: 'HS512', typ: 'JWT' });
  assert.equal(verifyJwt(`${hs512}.${p}.${createHmac('sha512', SECRET).update(`${hs512}.${p}`).digest('base64url')}`, SECRET, { now }), null, 'other alg');
  assert.equal(verifyJwt('a.b', SECRET), null);
  assert.equal(verifyJwt('x'.repeat(5000), SECRET), null);
  const noExp = `${h}.${b64({ sub: 'a', role: 'admin' })}`;
  assert.equal(verifyJwt(`${noExp}.${createHmac('sha256', SECRET).update(noExp).digest('base64url')}`, SECRET, { now }), null, 'exp is mandatory');
});

// ---------------- HTTP: login, RBAC, revocation ----------------
async function start(opts = {}) {
  const app = createApp({ tickMs: 0, historyMs: 0, moveMs: 0, tokenSecret: 'k', jwtSecret: SECRET, staticTokens: false, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, path, { body, token, headers } = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const login = async (username, password) => (await (await call('POST', '/api/auth/login', { body: { username, password } })).json());
  return { app, base, call, login, stop: () => new Promise((r) => { app.stop?.(); app.server.close(r); app.server.closeAllConnections?.(); }) };
}

test('RBAC matrix: who may do what (JWT)', async () => {
  const s = await start();
  try {
    const tokens = { admin: (await s.login('admin', 'admin-demo')).token, dispatcher: (await s.login('dispatcher', 'dispatcher-demo')).token, observer: (await s.login('observer', 'observer-demo')).token };
    const hit = async (role, method, path, body) => (await s.call(method, path, { token: tokens[role], body })).status;
    // read dashboard: every staff role
    for (const r of ['admin', 'dispatcher', 'observer']) assert.equal(await hit(r, 'GET', '/api/dashboard'), 200, r);
    assert.equal((await s.call('GET', '/api/dashboard')).status, 401, 'anonymous');
    // critical actions
    assert.equal(await hit('observer', 'POST', '/api/alerts/none/approve', {}), 403);
    assert.equal(await hit('dispatcher', 'POST', '/api/alerts/none/approve', {}), 404, 'allowed, alert just does not exist');
    assert.equal(await hit('observer', 'POST', '/api/sos/none/dispatch', {}), 403);
    assert.equal(await hit('observer', 'POST', '/api/broadcasts', { type: 'info' }), 403);
    // admin-only (simulation)
    assert.equal(await hit('dispatcher', 'POST', '/api/sim/scenario', { name: 'cluster' }), 403);
    assert.equal(await hit('admin', 'POST', '/api/sim/scenario', { name: 'cluster' }), 200);
    // an opaque string (old static token) no longer works
    assert.equal((await s.call('GET', '/api/dashboard', { token: 'admin-demo' })).status, 401);
    // denied attempts are in the journal
    const j = (await (await s.call('GET', '/api/decisions', { token: tokens.admin })).json()).decisions;
    assert.ok(j.some((d) => d.action === 'auth.denied'));
  } finally { await s.stop(); }
});

test('login: wrong password / unknown user give the same answer; logout revokes the token at once', async () => {
  const s = await start();
  try {
    const a = await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } });
    const b = await s.call('POST', '/api/auth/login', { body: { username: 'ghost', password: 'nope' } });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.deepEqual(await a.json(), await b.json());
    const { token, role, permissions } = await s.login('dispatcher', 'dispatcher-demo');
    assert.equal(role, 'dispatcher'); assert.ok(permissions.includes('alert:approve'));
    assert.equal((await s.call('GET', '/api/auth/me', { token })).status, 200);
    assert.equal((await s.call('POST', '/api/auth/logout', { token })).status, 200);
    assert.equal((await s.call('GET', '/api/dashboard', { token })).status, 401, 'revoked');
  } finally { await s.stop(); }
});

test('login brute force is rate limited', async () => {
  const s = await start();
  try {
    const codes = [];
    for (let i = 0; i < 30; i++) codes.push((await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: `bad${i}` } })).status);
    assert.ok(codes.includes(429), codes.join());
    assert.equal(codes[0], 401);
  } finally { await s.stop(); }
});

test('stream ticket: single use, tied to a signed-in user; raw JWT in the URL is not accepted', async () => {
  const s = await start();
  try {
    const { token } = await s.login('observer', 'observer-demo');
    assert.equal((await s.call('POST', '/api/auth/stream-ticket')).status, 401);
    const { ticket } = await (await s.call('POST', '/api/auth/stream-ticket', { token })).json();
    const ac = new AbortController();
    const ok = await fetch(`${s.base}/api/stream?ticket=${ticket}`, { signal: ac.signal });
    assert.equal(ok.status, 200); ac.abort();
    assert.equal((await fetch(`${s.base}/api/stream?ticket=${ticket}`)).status, 401, 'used once');
    assert.equal((await fetch(`${s.base}/api/stream?token=${token}`)).status, 401);
  } finally { await s.stop(); }
});

// ---------------- SOS shield ----------------
// the test client opens real sockets: send in waves so the OS accept queue is not the thing being tested
async function wave(n, size, fn) { const out = []; for (let i = 0; i < n; i += size) out.push(...await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, k) => fn(i + k)))); return out; }
const sos = (s, body, headers) => s.call('POST', '/api/sos', { body: { type: 'FIRE', lat: 40.4093, lng: 49.833, accuracy: 10, ...body }, headers });

test('rate limit: one address cannot hammer /api/sos; SOS from other addresses still pass', async () => {
  const s = await start({ trustProxy: true });
  try {
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push((await sos(s, { citizenId: `spam-${i}` }, { 'X-Forwarded-For': '198.51.100.9' })).status);
    assert.ok(codes.filter((c) => c === 429).length >= 20, codes.join());
    assert.equal((await sos(s, { citizenId: 'real' }, { 'X-Forwarded-For': '198.51.100.77' })).status, 201);
  } finally { await s.stop(); }
});

test('duplicate filter: the same device repeating the same SOS is merged, not multiplied', () => {
  const app = createApp({ tickMs: 0, historyMs: 0, moveMs: 0, tokenSecret: 'k' });
  const send = () => { const meta = { ip: '198.51.100.1', deviceId: 'dev-1', verified: true }; const r = app.store.addSos({ citizenId: 'dev-1', type: 'FIRE', lat: 40.4093, lng: 49.833, accuracy: 10 }, meta); return { r, meta }; };
  const first = send(); const again = send(); const third = send();
  assert.equal(again.meta.duplicate, true);
  assert.equal(again.r.id, first.r.id);
  assert.equal(third.r.repeats, 2);
  assert.equal(app.store.sos.length, 1);
  // another type from the same device is a new report
  app.store.addSos({ citizenId: 'dev-1', type: 'MEDICAL', lat: 40.4093, lng: 49.833, accuracy: 10 }, { ip: '198.51.100.1', deviceId: 'dev-1', verified: true });
  assert.equal(app.store.sos.length, 2);
});

test('flood: 600 fake SOS → protection mode on, nothing dropped silently, no false alert, dashboard stays fast (<300 ms avg)', async () => {
  const s = await start({ trustProxy: true });
  try {
    const { token } = await s.login('dispatcher', 'dispatcher-demo');
    const post = (i) => sos(s, { citizenId: `bot-${i}`, type: ['FIRE', 'COLLAPSE', 'FLOOD', 'MEDICAL'][i % 4], lat: 40.4093 + (i % 7) * 1e-4 }, { 'X-Forwarded-For': `203.0.113.${i % 250}` });
    const lat = [];
    const timed = async (fn) => { const t = performance.now(); const r = await fn(); lat.push(performance.now() - t); return r; };
    const flood = wave(600, 40, (i) => timed(() => post(i)));
    const reads = [];
    for (let i = 0; i < 20; i++) { reads.push(timed(() => s.call('GET', '/api/dashboard', { token }))); await new Promise((r) => setTimeout(r, 10)); }
    const res = await flood; await Promise.all(reads);
    const codes = res.map((r) => r.status);
    assert.ok(codes.every((c) => [201, 200, 429].includes(c)), [...new Set(codes)].join());
    assert.ok(codes.filter((c) => c === 429).length > 0, 'rate limit engaged');
    const snap = await (await s.call('GET', '/api/dashboard', { token })).json();
    assert.equal(snap.protection.flood, true);
    assert.equal(snap.alerts.filter((a) => a.status === 'open' && a.type === 'SOS_CLUSTER').length, 0, 'fakes raise no alert');
    const avg = lat.reduce((a, b) => a + b, 0) / lat.length;
    assert.ok(avg < 300, `average latency ${avg.toFixed(1)} ms`);
  } finally { await s.stop(); }
});

test('flood does not block a genuine signed device', async () => {
  const s = await start({ trustProxy: true });
  try {
    await wave(400, 40, (i) => sos(s, { citizenId: `bot-${i}` }, { 'X-Forwarded-For': `203.0.113.${i % 250}` }));
    const sess = await (await s.call('POST', '/api/session', { body: {} })).json();
    const r = await sos(s, { type: 'MEDICAL' }, { 'X-Device-Token': sess.token ?? sess.deviceToken, 'X-Forwarded-For': '198.51.100.200' });
    assert.equal(r.status, 201);
  } finally { await s.stop(); }
});
