import { EventEmitter } from 'node:events';
import { AppError } from './errors.js';
import { haversine, isValidCoord, nearest } from './geo.js';

export const SOS_TYPES = ['FIRE', 'COLLAPSE', 'FLOOD', 'MEDICAL'];
const MAX_SOS = 50_000;

const pct = (p) => (p.capacity > 0 ? (p.occupied / p.capacity) * 100 : 100);

/** In-memory state of the city. Emits 'change' on any mutation, 'alert' on new alerts. */
export class Store extends EventEmitter {
  constructor(seed, { now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.seed = seed;
    this.reset();
  }

  reset() {
    const s = this.seed;
    this.districts = s.districts.map((d) => ({ ...d }));
    this.points = new Map(s.points.map((p) => [p.id, { ...p }]));
    this.brigades = new Map(s.brigades.map((b) => [b.id, { ...b }]));
    this.sos = [];
    this.safe = new Map();
    this.checkins = new Map(); // citizenId -> pointId
    this.alerts = [];
    // mutate in place: RoutingService holds a live reference to this object
    this.chaos ??= {};
    Object.assign(this.chaos, { externalDown: false, externalLatencyMs: 0 });
    this.seq = 0;
    this.emit('change', 'reset');
  }

  nextId(prefix) {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  pointView(p) {
    return { ...p, occupancyPct: Math.round(pct(p) * 10) / 10 };
  }

  listPoints({ activeOnly = false } = {}) {
    const all = [...this.points.values()].map((p) => this.pointView(p));
    return activeOnly ? all.filter((p) => p.active) : all;
  }

  getPoint(id) {
    const p = this.points.get(id);
    if (!p) throw new AppError(404, 'POINT_NOT_FOUND');
    return p;
  }

  nearestDistrict(pos) {
    return nearest(pos, this.districts)?.item ?? null;
  }

  addSos({ citizenId, type, lat, lng, note }) {
    if (typeof citizenId !== 'string' || !citizenId.trim() || citizenId.length > 64) {
      throw new AppError(400, 'INVALID_CITIZEN_ID');
    }
    if (!SOS_TYPES.includes(type)) throw new AppError(400, 'INVALID_SOS_TYPE');
    if (!isValidCoord(lat, lng)) throw new AppError(400, 'INVALID_COORDS');
    const sos = {
      id: this.nextId('s'),
      citizenId: citizenId.trim(),
      type,
      lat,
      lng,
      note: typeof note === 'string' ? note.slice(0, 280) : '',
      districtId: this.nearestDistrict({ lat, lng })?.id ?? null,
      createdAt: this.now(),
      status: 'open',
    };
    this.sos.push(sos);
    if (this.sos.length > MAX_SOS) this.sos.splice(0, this.sos.length - MAX_SOS);
    this.safe.delete(sos.citizenId);
    this.emit('change', 'sos', sos);
    return sos;
  }

  markSafe(citizenId, pos) {
    if (typeof citizenId !== 'string' || !citizenId.trim()) throw new AppError(400, 'INVALID_CITIZEN_ID');
    const id = citizenId.trim();
    let resolved = 0;
    for (const s of this.sos) {
      if (s.citizenId === id && s.status === 'open') { s.status = 'resolved'; resolved += 1; }
    }
    const rec = { citizenId: id, at: this.now(), lat: pos?.lat ?? null, lng: pos?.lng ?? null };
    this.safe.set(id, rec);
    this.emit('change', 'safe');
    return { ...rec, resolvedSos: resolved };
  }

  setOccupancy(pointId, occupied) {
    const p = this.getPoint(pointId);
    if (!Number.isFinite(occupied) || occupied < 0) throw new AppError(400, 'INVALID_OCCUPANCY');
    p.occupied = Math.min(Math.round(occupied), p.capacity);
    this.emit('change', 'occupancy');
    return this.pointView(p);
  }

  checkin(citizenId, pointId) {
    if (typeof citizenId !== 'string' || !citizenId.trim()) throw new AppError(400, 'INVALID_CITIZEN_ID');
    const id = citizenId.trim();
    const p = this.getPoint(pointId);
    if (!p.active) throw new AppError(409, 'POINT_CLOSED');
    if (this.checkins.get(id) === pointId) return this.pointView(p);
    if (p.occupied >= p.capacity) throw new AppError(409, 'POINT_FULL');
    const prev = this.checkins.get(id);
    if (prev) this.points.get(prev).occupied = Math.max(0, this.points.get(prev).occupied - 1);
    p.occupied += 1;
    this.checkins.set(id, pointId);
    this.emit('change', 'occupancy');
    return this.pointView(p);
  }

  setBrigadeStatus(id, status) {
    const b = this.brigades.get(id);
    if (!b) throw new AppError(404, 'BRIGADE_NOT_FOUND');
    if (!['available', 'dispatched', 'on_scene', 'offline'].includes(status)) {
      throw new AppError(400, 'INVALID_STATUS');
    }
    b.status = status;
    if (status === 'available') { delete b.target; delete b.alertId; }
    this.emit('change', 'brigade');
    return { ...b };
  }

  recentOpenSos(windowMs) {
    const cutoff = this.now() - windowMs;
    const out = [];
    // sos[] is chronological: scan from the newest and stop at the window edge
    for (let i = this.sos.length - 1; i >= 0 && this.sos[i].createdAt >= cutoff; i--) {
      if (this.sos[i].status === 'open') out.push(this.sos[i]);
    }
    return out.reverse();
  }

  /** Counts per district of currently open SOS (for the zone panel). */
  zoneCounts() {
    const out = Object.fromEntries(this.districts.map((d) => [d.id, 0]));
    for (const s of this.sos) if (s.status === 'open' && s.districtId) out[s.districtId] += 1;
    return out;
  }

  snapshot() {
    const openSos = this.sos.filter((s) => s.status === 'open');
    const zones = this.zoneCounts();
    return {
      time: this.now(),
      points: this.listPoints(),
      brigades: [...this.brigades.values()].map((b) => ({ ...b })),
      sos: openSos.slice(-300),
      sosTotalOpen: openSos.length,
      zones: this.districts.map((d) => ({ id: d.id, name: d.name, lat: d.lat, lng: d.lng, openSos: zones[d.id] })),
      alerts: this.alerts.filter((a) => a.status === 'open').concat(
        this.alerts.filter((a) => a.status !== 'open').slice(-10),
      ),
      safeCount: this.safe.size,
      chaos: { ...this.chaos },
    };
  }
}

export { pct as occupancyPct };
export { haversine };
