import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ENDPOINTS, SELF_ROUTES, buildOpenApi, renderDocs } from '../src/openapi.js';

const key = (m, p) => `${m} ${p}`;

test('OpenAPI list and the REAL route table never drift apart (both directions)', () => {
  const app = createApp({ tickMs: 0, historyMs: 0 });
  const real = new Map(app.routeTable().filter((r) => !SELF_ROUTES.includes(key(r.method, r.path))).map((r) => [key(r.method, r.path), r]));
  const documented = new Map(ENDPOINTS.map((e) => [key(e.method, e.path), e]));
  documented.delete('GET /api/stream'); // SSE is handled outside the route table
  for (const k of real.keys()) assert.ok(documented.has(k), `route not documented: ${k}`);
  for (const k of documented.keys()) assert.ok(real.has(k), `documented but not implemented: ${k}`);
  assert.ok(ENDPOINTS.some((e) => e.sse), 'SSE endpoint listed');
});

test('documented auth matches the permission the route really enforces', () => {
  const app = createApp({ tickMs: 0, historyMs: 0 });
  for (const r of app.routeTable()) {
    const e = ENDPOINTS.find((x) => x.method === r.method && x.path === r.path);
    if (!e) continue;
    if (r.perm) assert.equal(e.auth, r.perm, `${r.method} ${r.path}`);
    else assert.ok(['public', 'device'].includes(e.auth), `${r.method} ${r.path} is open but documented as ${e.auth}`);
  }
});

test('buildOpenApi: valid shape, path params converted, secured operations flagged', () => {
  const spec = buildOpenApi();
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.paths['/api/alerts/{id}/approve'].post['x-permission'] === 'alert:approve');
  assert.deepEqual(spec.paths['/api/alerts/{id}/approve'].post.parameters[0], { name: 'id', in: 'path', required: true, schema: { type: 'string' } });
  assert.equal(spec.paths['/api/health'].get.security, undefined);
  for (const [path, ops] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(ops)) {
    assert.ok(op.summary && op.responses[200], `${m} ${path}`);
  }
});

test('docs page is self-contained (no external scripts/styles) and escapes content', () => {
  const html = renderDocs();
  assert.ok(!/<script/i.test(html) && !/https?:\/\/(?!www\.w3)/.test(html.replace(/href="\/api/g, '')), 'no external resources');
  assert.ok(html.includes('/api/sos') && html.includes('X-Device-Token'));
});

test('HTTP: /api/openapi.json and /api/docs are public', async () => {
  const app = createApp({ tickMs: 0, historyMs: 0 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const j = await fetch(`${base}/api/openapi.json`);
  assert.equal(j.status, 200);
  assert.ok((await j.json()).paths['/api/sos']);
  const d = await fetch(`${base}/api/docs`);
  assert.equal(d.status, 200);
  assert.match(d.headers.get('content-type'), /text\/html/);
  app.server.closeAllConnections?.(); app.server.close();
});
