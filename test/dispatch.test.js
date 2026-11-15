import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { haversine } from '../src/geo.js';

function setup(opts = {}) {
  const clock = { t: 50_000_000 };
  const app = createApp({ now: () => clock.t, tickMs: 0, historyMs: 0, moveMs: 0, tokenSecret: 'k', ...opts });
  return { ...app, clock };
}
const NAS = { lat: 40.4093, lng: 49.8330 };
const YAS = { lat: 40.3850, lng: 49.8150 };

/** a verified cluster with the given SOS types, all at one spot */
function cluster(app, types, pos = NAS) {
  types.forEach((type, i) => app.store.addSos({ citizenId: `c${i}`, type, ...pos, accuracy: 10 }, { ip: `ip-${i}`, deviceId: `c${i}`, verified: true }));
  return app.store.alerts.find((a) => a.type === 'SOS_CLUSTER' && a.status === 'open');
}
const brigade = (app, id) => app.store.brigades.get(id);
const setStatus = (app, filter, status) => { for (const b of app.store.brigades.values()) if (filter(b)) b.status = status; };
const nearestOfKind = (app, kind, center) => [...app.store.brigades.values()].filter((b) => b.kind === kind).sort((a, b) => haversine(a.home, center) - haversine(b.home, center))[0];

/* ================= automatic, type-aware choice ================= */
test('the brigade KIND follows the emergency: fire -> fire, medical -> medical, collapse/flood -> rescue', () => {
  for (const [type, kind] of [['FIRE', 'fire'], ['MEDICAL', 'medical'], ['COLLAPSE', 'rescue'], ['FLOOD', 'rescue']]) {
    const app = setup();
    const alert = cluster(app, [type, type, type, type]);
    const plan = app.crisis.plan(alert);
    assert.equal(plan.brigade.kind, kind, type);
    assert.equal(plan.brigade.match, 'exact');
    assert.equal(plan.brigade.id, nearestOfKind(app, kind, NAS).id, `${type}: nearest brigade of that kind`);
    assert.equal(plan.wantedKind, kind);
  }
});

test('mixed clusters: the dominant type wins; an exact tie goes to the life-threatening one (medical first)', () => {
  const kindFor = (types) => { const app = setup(); return app.crisis.plan(cluster(app, types)).brigade.kind; };
  assert.equal(kindFor(['FIRE', 'FIRE', 'FIRE', 'MEDICAL']), 'fire');
  assert.equal(kindFor(['MEDICAL', 'MEDICAL', 'MEDICAL', 'FIRE']), 'medical');
  assert.equal(kindFor(['FIRE', 'FIRE', 'MEDICAL', 'MEDICAL']), 'medical', 'tie -> MEDICAL');
  assert.equal(kindFor(['COLLAPSE', 'COLLAPSE', 'FIRE', 'FLOOD']), 'rescue');
});

test('crowd control (overcrowded point) asks for a rescue brigade', () => {
  const app = setup();
  app.store.setOccupancy('p1', 7700);
  const alert = app.store.alerts.find((a) => a.type === 'POINT_OVERCROWD');
  const plan = app.crisis.plan(alert);
  assert.equal(plan.brigade.kind, 'rescue');
  assert.equal(plan.brigade.match, 'exact');
});

test('when the right kind is busy: a substitute kind is proposed and flagged; when nothing suitable is free: any kind, flagged', () => {
  const app = setup();
  const alert = cluster(app, ['FIRE', 'FIRE', 'FIRE', 'FIRE']);
  setStatus(app, (b) => b.kind === 'fire', 'dispatched');
  let plan = app.crisis.plan(alert);
  assert.equal(plan.brigade.kind, 'rescue');
  assert.equal(plan.brigade.match, 'secondary');
  setStatus(app, (b) => b.kind === 'rescue', 'offline');
  plan = app.crisis.plan(alert);
  assert.equal(plan.brigade.kind, 'medical');
  assert.equal(plan.brigade.match, 'any');
});

test('reserved accessible transport is never picked automatically for an ordinary alert (but is offered to the dispatcher)', () => {
  const app = setup();
  const alert = cluster(app, ['MEDICAL', 'MEDICAL', 'MEDICAL', 'MEDICAL']);
  setStatus(app, (b) => b.kind !== 'accessible_transport', 'offline');
  const plan = app.crisis.plan(alert);
  assert.equal(plan.brigade, null, 'no automatic choice');
  assert.deepEqual(plan.candidates.map((c) => c.match), ['special', 'special']);
});

test('candidates: only FREE brigades, best match first then nearest, with ETA and distance; amber alerts have none', () => {
  const app = setup();
  const alert = cluster(app, ['FIRE', 'FIRE', 'FIRE', 'FIRE']);
  app.store.brigades.get('b2').status = 'dispatched';
  const c = app.crisis.candidates(alert);
  assert.equal(c.length, 7, '8 brigades minus the busy one');
  assert.ok(!c.some((x) => x.id === 'b2'));
  const rank = { exact: 0, secondary: 1, any: 2, special: 3 };
  for (let i = 1; i < c.length; i++) {
    const [p, q] = [c[i - 1], c[i]];
    assert.ok(rank[p.match] < rank[q.match] || (rank[p.match] === rank[q.match] && p.distanceM <= q.distanceM), `${p.id} before ${q.id}`);
  }
  assert.ok(c.every((x) => x.etaMin >= 1 && x.distanceM > 0 && x.kind && x.name));
  assert.equal(c[0].kind, 'fire', 'the other fire brigade (b5) leads');

  const a2 = setup();
  a2.clock.t += 120_000; a2.store.setOccupancy('p3', 640); // +120/min since the initial sample -> forecast warning
  const amber = a2.store.alerts.find((x) => x.level === 'amber');
  assert.ok(amber, 'test premise: an amber alert exists');
  assert.deepEqual(a2.crisis.candidates(amber), []);
});

test('without a manual choice approve() does exactly what plan() promised', () => {
  const app = setup();
  const alert = cluster(app, ['FIRE', 'FIRE', 'COLLAPSE', 'FIRE']);
  const plan = app.crisis.plan(alert);
  const res = app.crisis.approve(alert.id);
  assert.equal(res.result.brigadeId, plan.brigade.id);
  assert.equal(res.result.manual, false);
  assert.equal(res.result.match, 'exact');
  assert.equal(res.result.etaMin, plan.brigade.etaMin);
});

/* ================= dispatcher override ================= */
test('override: the dispatcher can send ANY free brigade; the automatic one stays untouched; it is flagged manual', () => {
  const app = setup();
  const alert = cluster(app, ['FIRE', 'FIRE', 'FIRE', 'FIRE']);
  const auto = app.crisis.plan(alert).brigade.id;
  const res = app.crisis.approve(alert.id, 'dispatcher', { brigadeId: 'b4' }); // Rescue-2 instead of the fire brigade
  assert.equal(res.result.brigadeId, 'b4');
  assert.equal(res.result.manual, true);
  assert.equal(res.result.match, 'secondary');
  assert.equal(brigade(app, 'b4').status, 'dispatched');
  assert.equal(brigade(app, auto).status, 'available');
  assert.equal(res.result.etaMin >= 1, true);
  assert.ok(brigade(app, 'b4').move.durationMs > 0, 'it really moves');
});

test('override with the same brigade the system proposed is not "manual"; a reserved vehicle may be chosen on purpose', () => {
  const app = setup();
  const alert = cluster(app, ['MEDICAL', 'MEDICAL', 'MEDICAL', 'MEDICAL']);
  const auto = app.crisis.plan(alert).brigade.id;
  assert.equal(app.crisis.approve(alert.id, 'd', { brigadeId: auto }).result.manual, false);
  const b = setup();
  const a2 = cluster(b, ['MEDICAL', 'MEDICAL', 'MEDICAL', 'MEDICAL']);
  const res = b.crisis.approve(a2.id, 'd', { brigadeId: 'b7' });
  assert.equal(res.result.manual, true);
  assert.equal(res.result.match, 'special');
});

test('override validation: unknown, busy, non-string and amber alerts are refused and change NOTHING', () => {
  const app = setup();
  const alert = cluster(app, ['FIRE', 'FIRE', 'FIRE', 'FIRE']);
  const snapshot = () => JSON.stringify([...app.store.brigades.values()].map((b) => [b.id, b.status]));
  const before = snapshot();
  assert.throws(() => app.crisis.approve(alert.id, 'd', { brigadeId: 'nope' }), { code: 'BRIGADE_NOT_FOUND' });
  assert.throws(() => app.crisis.approve(alert.id, 'd', { brigadeId: 42 }), { code: 'INVALID_BRIGADE' });
  app.store.brigades.get('b4').status = 'dispatched';
  assert.throws(() => app.crisis.approve(alert.id, 'd', { brigadeId: 'b4' }), { code: 'BRIGADE_NOT_AVAILABLE' });
  app.store.brigades.get('b4').status = 'available';
  assert.equal(snapshot(), before);
  assert.equal(alert.status, 'open', 'the alert stays open after a refused override');

  const f = setup();
  f.clock.t += 120_000; f.store.setOccupancy('p3', 640);
  const amber = f.store.alerts.find((x) => x.level === 'amber');
  assert.ok(amber, 'test premise: an amber alert exists');
  assert.throws(() => f.crisis.approve(amber.id, 'd', { brigadeId: 'b1' }), { code: 'INVALID_BRIGADE' });
});

test('approving an already approved alert is idempotent even with a different brigadeId (nothing else is dispatched)', () => {
  const app = setup();
  const alert = cluster(app, ['FIRE', 'FIRE', 'FIRE', 'FIRE']);
  app.crisis.approve(alert.id);
  const again = app.crisis.approve(alert.id, 'd', { brigadeId: 'b4' });
  assert.equal(again.result.manual, false);
  assert.equal(brigade(app, 'b4').status, 'available');
});

test('undo frees the manually chosen brigade', () => {
  const app = setup();
  const alert = cluster(app, ['FIRE', 'FIRE', 'FIRE', 'FIRE']);
  app.crisis.approve(alert.id, 'd', { brigadeId: 'b4' });
  app.crisis.undo(alert.id);
  assert.equal(brigade(app, 'b4').status, 'available');
  assert.equal(brigade(app, 'b4').move, undefined);
});

test('priority alerts: accessible transport first, then medical; the dispatcher can still overrule', () => {
  const app = setup();
  app.store.setProfile('w', { role: 'priority', needs: ['wheelchair'] });
  app.store.addSos({ citizenId: 'w', type: 'MEDICAL', ...YAS, accuracy: 8 }, { ip: 'x', deviceId: 'w', verified: true, profile: app.store.getProfile('w') });
  const alert = app.store.alerts.find((a) => a.type === 'PRIORITY_SOS');
  const c = app.crisis.candidates(alert);
  assert.deepEqual(c.slice(0, 4).map((x) => x.match), ['exact', 'exact', 'secondary', 'secondary']);
  assert.ok(c.slice(0, 2).every((x) => x.kind === 'accessible_transport'));
  assert.ok(c.slice(4).every((x) => x.match === 'special'));
  const res = app.crisis.approve(alert.id, 'd', { brigadeId: 'b3' }); // a medical brigade on purpose
  assert.equal(res.result.manual, true);
  assert.equal(res.result.fallback, true);
  assert.equal(res.result.accessible, true);
});

/* ================= HTTP + journal ================= */
test('HTTP: approve with brigadeId, rights, error codes, plan.candidates on the dashboard, journal says "manual"', async () => {
  const app = setup();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, { body, token } = {}) => fetch(base + path, { method: body || path.includes('approve') ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const alert = cluster(app, ['FIRE', 'FIRE', 'FIRE', 'FIRE']);

  const dash = await (await call('/api/dashboard', { token: 'dispatcher-demo' })).json();
  const a = dash.alerts.find((x) => x.id === alert.id);
  assert.ok(a.plan.candidates.length >= 5 && a.plan.candidates[0].kind === 'fire' && a.plan.wantedKind === 'fire');

  assert.equal((await call(`/api/alerts/${alert.id}/approve`, { body: { brigadeId: 'b4' } })).status, 401);
  assert.equal((await call(`/api/alerts/${alert.id}/approve`, { body: { brigadeId: 'b4' }, token: 'observer-demo' })).status, 403);
  assert.equal((await call(`/api/alerts/${alert.id}/approve`, { body: { brigadeId: 'zzz' }, token: 'dispatcher-demo' })).status, 404);
  assert.equal((await call(`/api/alerts/${alert.id}/approve`, { body: { brigadeId: 7 }, token: 'dispatcher-demo' })).status, 400);
  app.store.brigades.get('b4').status = 'offline';
  const busy = await call(`/api/alerts/${alert.id}/approve`, { body: { brigadeId: 'b4' }, token: 'dispatcher-demo' });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, 'BRIGADE_NOT_AVAILABLE');
  app.store.brigades.get('b4').status = 'available';

  const ok = await call(`/api/alerts/${alert.id}/approve`, { body: { brigadeId: 'b4' }, token: 'dispatcher-demo' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.brigadeId, 'b4');
  const journal = (await (await call('/api/decisions', { token: 'dispatcher-demo' })).json()).decisions.find((d) => d.action === 'alert.approve');
  assert.equal(journal.details.manual, true);
  assert.equal(journal.details.brigadeId, 'b4');
  assert.equal((await call('/api/alerts/nope/approve', { token: 'dispatcher-demo' })).status, 404);
  app.server.closeAllConnections?.(); app.server.close();
});
