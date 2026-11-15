import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { signJwt, verifyJwt } from '../src/jwt.js';

import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, loadKeys } from '../src/keystore.js';
import { Auth } from '../src/auth.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const KEYS = generateKeys();

// ---------------- JWT (Ed25519) ----------------
test('jwt: valid token round-trips, expired / tampered / alg=none / foreign key / HS256 confusion are rejected', () => {
  const now = 1_700_000_000_000;
  const tok = signJwt({ sub: 'a', role: 'admin' }, KEYS.privateKey, { ttlSec: 60, now });
  assert.equal(verifyJwt(tok, KEYS.publicKey, { now: now + 1000 }).sub, 'a');
  assert.equal(verifyJwt(tok, KEYS.publicKey, { now: now + 61_000 }), null, 'expired');
  assert.equal(verifyJwt(tok, generateKeyPairSync('ed25519').publicKey, { now }), null, 'signed by another key');
  const [h, p, s] = tok.split('.');
  const forged = b64({ sub: 'a', role: 'admin', exp: 9_999_999_999, jti: 'x' });
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, KEYS.publicKey, { now }), null, 'payload changed');
  assert.equal(verifyJwt(`${b64({ alg: 'none', typ: 'JWT' })}.${p}.`, KEYS.publicKey, { now }), null, 'alg none');
  // classic algorithm-confusion attack: HS256 token "signed" with the public key text
  const hs = b64({ alg: 'HS256', typ: 'JWT' });
  const pub = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyJwt(`${hs}.${p}.${createHmac('sha256', pub).update(`${hs}.${p}`).digest('base64url')}`, KEYS.publicKey, { now }), null, 'HS256 confusion');
  assert.equal(verifyJwt('a.b', KEYS.publicKey), null);
  assert.equal(verifyJwt('x'.repeat(5000), KEYS.publicKey), null);
  const noExpToken = signJwt({ sub: 'a' }, KEYS.privateKey, { now });
  const [h2, p2] = noExpToken.split('.');
  const body = b64({ sub: 'a', role: 'admin' }); // no exp
  assert.equal(verifyJwt(`${h2}.${body}.${noExpToken.split('.')[2]}`, KEYS.publicKey, { now }), null, 'exp is mandatory / signature does not match');
  assert.ok(p2);
});

test('keystore: keys are created on first start, stored privately and survive a restart (no secret to configure)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'));
  const file = join(dir, 'sub', 'keys.json');
  try {
    const first = loadKeys(file);
    assert.equal(statSync(file).mode & 0o077, 0, 'file is private to the owner');
    const token = new Auth({ keys: first }).login('dispatcher', 'dispatcher-demo').token;
    const second = loadKeys(file); // "restart"
    assert.equal(new Auth({ keys: second }).identify({ headers: { authorization: `Bearer ${token}` } })?.sub, 'dispatcher', 'old token still valid after restart');
    assert.equal(second.deviceSecret, first.deviceSecret);
    assert.equal(new Auth({ keys: generateKeys() }).identify({ headers: { authorization: `Bearer ${token}` } }), null, 'other server keys do not accept it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------- HTTP: login, RBAC, revocation ----------------
async function start(opts = {}) {
  const app = createApp({ tickMs: 0, historyMs: 0, moveMs: 0, tokenSecret: 'k', staticTokens: false, ...opts });
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

test('Referrer-Policy still sends the origin (OpenStreetMap blocks tile requests without a Referer)', async () => {
  const s = await start();
  try {
    const r = await s.call('GET', '/dispatcher');
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  } finally { await s.stop(); }
});

test('keystore: a platform-supplied key (SIGNING_KEY_PEM) gives every instance the same keys', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const a = loadKeys(null, { SIGNING_KEY_PEM: pem }); const b = loadKeys(null, { SIGNING_KEY_PEM: pem.replace(/\n/g, '\\n') });
  assert.equal(a.deviceSecret, b.deviceSecret);
  const token = new Auth({ keys: a }).login('admin', 'admin-demo').token;
  assert.equal(new Auth({ keys: b }).identify({ headers: { authorization: `Bearer ${token}` } })?.role, 'admin');
  assert.throws(() => loadKeys(null, { SIGNING_KEY_PEM: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
});
