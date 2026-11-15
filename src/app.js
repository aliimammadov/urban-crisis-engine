import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as seed from './seed.js';
import { AppError } from './errors.js';
import { Store, SOS_TYPES } from './store.js';
import { RoadGraph, RoutingService } from './routing.js';
import { EvacuationService } from './evacuation.js';
import { CrisisEngine } from './crisis.js';
import { Auth } from './auth.js';
import { RateLimiter } from './ratelimit.js';
import { dict, resolveLang, t } from './i18n.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MAX_BODY = 16 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/**
 * Builds the whole system. Everything is injectable (clock, seed, tokens, limits)
 * so tests can run it in-process with a fake clock.
 */
export function createApp({
  now = () => Date.now(),
  data = seed,
  auth = new Auth(),
  rules = {},
  limits = {},
  routingTimeoutMs = 700,
} = {}) {
  const store = new Store(data, { now });
  const graph = new RoadGraph([...data.districts, ...data.points]);
  const routing = new RoutingService(graph, store.chaos, { timeoutMs: routingTimeoutMs });
  const evacuation = new EvacuationService(store, routing);
  const crisis = new CrisisEngine(store, rules);

  // Re-evaluate crisis rules whenever SOS or occupancy change (cheap: windows are small).
  store.on('change', (kind, payload) => {
    if (kind === 'sos') crisis.evaluate({ focus: payload });
    else if (kind === 'occupancy') crisis.evaluate();
  });

  const sosLimiter = new RateLimiter({ capacity: limits.sosBurst ?? 10, refillPerSec: limits.sosPerSec ?? 0.5, now });
  const apiLimiter = new RateLimiter({ capacity: limits.apiBurst ?? 200, refillPerSec: limits.apiPerSec ?? 100, now });

  // ---- SSE live feed -------------------------------------------------------
  const clients = new Set();
  let pending = null;
  const broadcast = () => {
    pending = null;
    if (!clients.size) return;
    const payload = `event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
    for (const res of clients) res.write(payload);
  };
  store.on('change', () => { if (!pending) pending = setTimeout(broadcast, 150); }); // coalesce bursts
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15_000);
  heartbeat.unref();

  // ---- routes --------------------------------------------------------------
  const routes = [];
  const route = (method, path, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), opts, handler });
  };

  route('GET', '/api/health', () => ({ ok: true, time: now() }));
  route('GET', '/api/i18n/:lang', (c) => ({ lang: resolveLang(c.params.lang), messages: dict[resolveLang(c.params.lang)] }));
  route('GET', '/api/config', () => ({ sosTypes: SOS_TYPES, languages: Object.keys(dict), rules: crisis.rules }));
  route('GET', '/api/districts', () => store.districts);
  route('GET', '/api/points', () => store.listPoints({ activeOnly: true }));
  route('GET', '/api/roads', () => graph.listEdges());

  route('GET', '/api/evacuation', async (c) => {
    const q = c.url.searchParams;
    const lat = q.has('lat') ? Number(q.get('lat')) : NaN;
    const lng = q.has('lng') ? Number(q.get('lng')) : NaN;
    return evacuation.recommend({ lat, lng, district: q.get('district') });
  });

  route('POST', '/api/sos', { limiter: sosLimiter }, (c) => {
    const sos = store.addSos(c.body);
    return { status: 201, body: { id: sos.id, status: sos.status, createdAt: sos.createdAt, districtId: sos.districtId } };
  });

  route('POST', '/api/safe', (c) => {
    const lat = c.body.lat; const lng = c.body.lng;
    return store.markSafe(c.body.citizenId, typeof lat === 'number' ? { lat, lng } : null);
  });

  route('POST', '/api/points/:id/checkin', (c) => store.checkin(c.body.citizenId, c.params.id));

  // dispatcher / admin
  route('GET', '/api/dashboard', { perm: 'dashboard' }, () => store.snapshot());
  route('POST', '/api/alerts/:id/approve', { perm: 'alert:approve' }, (c) => crisis.approve(c.params.id, c.role));
  route('POST', '/api/roads/:id/close', { perm: 'road:write' }, (c) => setRoad(c.params.id, true));
  route('POST', '/api/roads/:id/open', { perm: 'road:write' }, (c) => setRoad(c.params.id, false));
  route('POST', '/api/roads/:id/congestion', { perm: 'road:write' }, (c) => {
    const e = graph.setCongestion(c.params.id, Number(c.body.factor));
    if (!e) throw new AppError(404, 'ROAD_NOT_FOUND');
    store.emit('change', 'road');
    return e;
  });
  route('POST', '/api/brigades/:id/status', { perm: 'brigade:write' }, (c) => store.setBrigadeStatus(c.params.id, c.body.status));

  // admin simulation / ops
  route('POST', '/api/sim/occupancy', { perm: '*' }, (c) => store.setOccupancy(c.body.pointId, Number(c.body.occupied)));
  route('POST', '/api/sim/chaos', { perm: '*' }, (c) => {
    if (typeof c.body.externalDown === 'boolean') store.chaos.externalDown = c.body.externalDown;
    if (Number.isFinite(c.body.externalLatencyMs)) store.chaos.externalLatencyMs = Math.max(0, c.body.externalLatencyMs);
    store.emit('change', 'chaos');
    return store.chaos;
  });
  route('POST', '/api/sim/rules', { perm: '*' }, (c) => crisis.setRules(c.body));
  route('POST', '/api/sim/reset', { perm: '*' }, () => {
    for (const e of graph.edges.values()) { e.closed = false; e.congestion = 1; }
    store.reset();
    return { ok: true };
  });

  function setRoad(id, closed) {
    const e = graph.setClosed(id, closed);
    if (!e) throw new AppError(404, 'ROAD_NOT_FOUND');
    store.emit('change', 'road');
    return { id: e.id, closed: e.closed };
  }

  // ---- http plumbing -------------------------------------------------------
  const send = (res, status, body, headers = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(data);
  };

  const readBody = (req) => new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > MAX_BODY) { reject(new AppError(413, 'PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(parsed && typeof parsed === 'object' ? parsed : {});
      } catch { reject(new AppError(400, 'BAD_JSON')); }
    });
    req.on('error', reject);
  });

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname === '/dispatcher' ? 'dispatcher.html' : pathname === '/mobile' ? 'mobile.html' : pathname.slice(1);
    const full = normalize(join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, { error: 'NOT_FOUND' });
    try {
      const buf = await readFile(full);
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    } catch {
      send(res, 404, { error: 'NOT_FOUND' });
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const lang = resolveLang(url.searchParams.get('lang') ?? req.headers['accept-language']);
    const fail = (err) => {
      const e = err instanceof AppError ? err : new AppError(500, 'INTERNAL');
      if (!(err instanceof AppError)) console.error(err);
      const headers = e.status === 429 ? { 'Retry-After': '2' } : {};
      send(res, e.status, { error: e.code, message: t(lang, `err.${e.code}`) }, headers);
    };

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') throw new AppError(404, 'NOT_FOUND');
        return await serveStatic(req, res, url.pathname);
      }

      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!apiLimiter.take(ip)) throw new AppError(429, 'RATE_LIMITED');

      // SSE stream (dispatcher)
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const role = auth.roleFor(req, url);
        if (!role) throw new AppError(401, 'UNAUTHORIZED');
        if (!auth.can(role, 'dashboard')) throw new AppError(403, 'FORBIDDEN');
        if (clients.size >= 500) throw new AppError(429, 'RATE_LIMITED');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }

      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new AppError(404, 'NOT_FOUND');

      let role = 'citizen';
      if (r.opts.perm) {
        role = auth.roleFor(req, url);
        if (!role) throw new AppError(401, 'UNAUTHORIZED');
        if (!auth.can(role, r.opts.perm)) throw new AppError(403, 'FORBIDDEN');
      }
      if (r.opts.limiter && !r.opts.limiter.take(ip)) throw new AppError(429, 'RATE_LIMITED');

      const body = req.method === 'POST' ? await readBody(req) : {};
      const params = r.re.exec(url.pathname).groups ?? {};
      const out = await r.handler({ req, url, params, body, role, lang });
      if (out && typeof out === 'object' && 'status' in out && 'body' in out) return send(res, out.status, out.body);
      return send(res, 200, out);
    } catch (err) {
      return fail(err);
    }
  }

  const server = http.createServer(handler);
  server.keepAliveTimeout = 5000;
  return { server, store, graph, routing, evacuation, crisis, auth, handler };
}
