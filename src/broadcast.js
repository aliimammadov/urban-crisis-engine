// Dispatcher -> citizens mass notification ("move to point X", "shelter in place", "all clear", custom text).
// Pull model: the app polls GET /api/broadcasts with its own position, so the server never stores where
// citizens are. Reach (devices that fetched) and acknowledgements are counted per broadcast.
import { AppError } from './errors.js';
import { haversine, isValidCoord, nearest } from './geo.js';

export const DEFAULT_SEVERITY = { evacuate: 'critical', shelter: 'warning', avoid_area: 'warning', all_clear: 'info', custom: null };
export const BROADCAST_TYPES = Object.keys(DEFAULT_SEVERITY);
const SEVERITIES = ['info', 'warning', 'critical'];
const MAX_ITEMS = 200;
const MAX_KEYS = 5000;

const cleanText = (t) => {
  if (!t || typeof t !== 'object') return {};
  const out = {};
  for (const l of ['az', 'en', 'ru']) if (typeof t[l] === 'string' && t[l].trim()) out[l] = t[l].trim().slice(0, 280);
  return out;
};

export class Broadcasts {
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.items = [];
    this.seq = 0;
  }

  clear() { this.items = []; }

  #target(t) {
    if (!t || t.kind === 'all' || t === 'all') return { kind: 'all' };
    if (t.kind === 'districts') {
      const ids = [...new Set(Array.isArray(t.districts) ? t.districts : [])];
      if (!ids.length || ids.some((id) => !this.store.districts.some((d) => d.id === id))) throw new AppError(400, 'INVALID_BROADCAST');
      return { kind: 'districts', districts: ids };
    }
    if (t.kind === 'radius') {
      const { lat, lng, radiusM } = t;
      if (!isValidCoord(lat, lng) || !Number.isFinite(radiusM) || radiusM < 100 || radiusM > 50_000) throw new AppError(400, 'INVALID_BROADCAST');
      return { kind: 'radius', lat, lng, radiusM };
    }
    throw new AppError(400, 'INVALID_BROADCAST');
  }

  create(input, actor = 'dispatcher') {
    if (!input || !BROADCAST_TYPES.includes(input.type)) throw new AppError(400, 'INVALID_BROADCAST');
    const type = input.type;
    const severity = DEFAULT_SEVERITY[type] ?? (SEVERITIES.includes(input.severity) ? input.severity : 'warning');
    const target = this.#target(input.target);
    const text = cleanText(input.text);
    if (type === 'custom' && !Object.keys(text).length) throw new AppError(400, 'INVALID_BROADCAST');
    let pointId = null;
    if (type === 'evacuate') {
      const p = this.store.points.get(input.pointId);
      if (!p || !p.active) throw new AppError(400, 'INVALID_BROADCAST');
      pointId = p.id;
    }
    const mins = Number.isFinite(input.expiresInMin) ? Math.max(1, Math.min(720, input.expiresInMin)) : 30;
    const now = this.now();
    const b = {
      id: `bc${++this.seq}`, type, severity, target, pointId, text, actor,
      createdAt: now, expiresAt: now + mins * 60_000, status: 'active', reach: new Set(), acks: new Set(),
    };
    // "all clear" retracts the warnings it covers
    if (type === 'all_clear') for (const o of this.items) if (o.status === 'active' && o.type !== 'all_clear' && this.#covers(target, o.target)) o.status = 'cancelled';
    this.items.push(b);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    this.store.emit('change', 'broadcast');
    return this.summary(b);
  }

  #covers(a, b) {
    if (a.kind === 'all') return true;
    if (a.kind === 'districts' && b.kind === 'districts') return b.districts.every((d) => a.districts.includes(d));
    if (a.kind === 'radius' && b.kind === 'radius') return a.radiusM >= haversine(a, b) + b.radiusM;
    return false;
  }

  #matches(b, pos) {
    if (b.target.kind === 'all') return true;
    if (!pos) return false; // location-targeted messages need a known position
    if (b.target.kind === 'districts') return b.target.districts.includes(this.store.nearestDistrict(pos)?.id);
    return haversine(b.target, pos) <= b.target.radiusM;
  }

  #live(b) { return b.status === 'active' && this.now() < b.expiresAt; }

  /** What one citizen should see. `pos` may be null; `accessible` swaps an evacuation point without a ramp. */
  forClient({ pos = null, accessible = false, key }) {
    const out = [];
    for (const b of this.items) {
      if (!this.#live(b) || !this.#matches(b, pos)) continue;
      if (b.reach.size < MAX_KEYS) b.reach.add(key);
      let point = null;
      let substituted = false;
      if (b.pointId) {
        let p = this.store.points.get(b.pointId);
        if (accessible && !p.accessible) {
          const alt = nearest(pos ?? p, [...this.store.points.values()].filter((x) => x.active && x.accessible))?.item;
          if (alt) { p = alt; substituted = true; }
        }
        point = { id: p.id, name: p.name, lat: p.lat, lng: p.lng, accessible: !!p.accessible, access: p.access ?? [] };
      }
      out.push({ id: b.id, type: b.type, severity: b.severity, createdAt: b.createdAt, expiresAt: b.expiresAt, text: b.text, point, substituted });
    }
    return out.reverse(); // newest first
  }

  ack(id, key) {
    const b = this.items.find((x) => x.id === id);
    if (!b) throw new AppError(404, 'BROADCAST_NOT_FOUND');
    if (b.acks.size < MAX_KEYS) { b.acks.add(key); b.reach.add(key); }
    return { id: b.id, acks: b.acks.size };
  }

  cancel(id) {
    const b = this.items.find((x) => x.id === id);
    if (!b) throw new AppError(404, 'BROADCAST_NOT_FOUND');
    if (b.status === 'active') { b.status = 'cancelled'; this.store.emit('change', 'broadcast'); }
    return this.summary(b);
  }

  /** Dispatcher view (counts only, never the device keys). */
  summary(b) {
    return {
      id: b.id, type: b.type, severity: b.severity, target: b.target, pointId: b.pointId, text: b.text, actor: b.actor,
      createdAt: b.createdAt, expiresAt: b.expiresAt, status: this.#live(b) ? 'active' : b.status === 'cancelled' ? 'cancelled' : 'expired',
      reach: b.reach.size, acks: b.acks.size,
    };
  }

  recent(limit = 8) {
    return this.items.slice(-limit).reverse().map((b) => this.summary(b));
  }
}
