import { EventEmitter } from 'node:events';
import { AppError } from './errors.js';
import { haversine, isValidCoord, nearest } from './geo.js';

export const SOS_TYPES = ['FIRE', 'COLLAPSE', 'FLOOD', 'MEDICAL'];
const MAX_SOS = 50_000;

const pct = (p) => (p.capacity > 0 ? (p.occupied / p.capacity) * 100 : 100);

/** In-memory state of the city. Emits 'change' on any mutation, 'alert' on new alerts. */
export class Store extends EventEmitter {
  constructor(seed, { now = () => Date.now(), cancelWindowMs = 60_000 } = {}) {
    super();
    this.now = now;
    this.cancelWindowMs = cancelWindowMs;
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
    this.profiles = new Map(); // deviceId -> {role, needs, updatedAt}  (priority-SOS role)
    this.checkins = new Map(); // citizenId -> pointId
    this.alerts = [];
    // mutate in place: RoutingService holds a live reference to this object
    this.chaos ??= {};
    Object.assign(this.chaos, { externalDown: false, externalLatencyMs: 0 });
    this.seq = 0;
    this.occSamples = new Map(); // pointId -> [{t, occ}] for inflow-rate forecasts
    for (const p of this.points.values()) this.recordOccupancy(p.id);
    this.quarantineVersion = 0; // bumped by AbuseGuard whenever a SOS is (un)quarantined
    this.guard?.reset?.();
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

  addSos({ citizenId, type, lat, lng, note, accuracy }, meta = {}) {
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
      // abuse-guard inputs (never exposed to dashboards: see publicSos)
      deviceId: meta.deviceId ?? citizenId.trim(),
      ip: meta.ip ?? 'local',
      verified: !!meta.verified,
      accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(accuracy, 100_000) : null,
      quarantined: false,
      flags: [],
      // Priority #1 only for a SIGNED device whose profile role is "priority" (self-declared special-care need)
      priority: meta.verified && meta.profile?.role === 'priority' ? 1 : 2,
      needs: meta.verified && meta.profile?.role === 'priority' ? [...meta.profile.needs] : [],
    };
    this.sos.push(sos);
    if (this.sos.length > MAX_SOS) this.sos.splice(0, this.sos.length - MAX_SOS);
    this.safe.delete(sos.citizenId);
    this.guard?.assess(sos); // may flag/quarantine BEFORE crisis rules run
    this.emit('change', 'sos', sos);
    return sos;
  }

  getProfile(deviceId) {
    return this.profiles.get(deviceId) ?? null;
  }

  /** Stores an already-validated profile (see priority.js). */
  setProfile(deviceId, { role, needs }) {
    const p = { role, needs: [...needs], updatedAt: this.now() };
    this.profiles.set(deviceId, p);
    this.emit('change', 'profile');
    return p;
  }

  findSos(id) {
    for (let i = this.sos.length - 1; i >= 0; i--) if (this.sos[i].id === id) return this.sos[i];
    throw new AppError(404, 'SOS_NOT_FOUND');
  }

  /** Citizen retracts their own SOS shortly after sending ("I sent it by mistake"). */
  cancelSos(id, citizenId) {
    const s = this.findSos(id);
    if (typeof citizenId !== 'string' || s.citizenId !== citizenId.trim()) throw new AppError(403, 'FORBIDDEN');
    if (s.status !== 'open') throw new AppError(409, 'SOS_NOT_OPEN');
    if (this.now() - s.createdAt > this.cancelWindowMs) throw new AppError(409, 'CANCEL_EXPIRED');
    s.status = 'cancelled';
    this.emit('change', 'sos-cancel');
    return { id: s.id, status: s.status };
  }

  /** Progress shown to the citizen: stage 1 received, 2 assigning, 3 help on the way. */
  sosStatus(id) {
    const s = this.findSos(id);
    const dispatched = this.alerts.find((a) => a.status === 'approved' && a.sosIds?.includes(id));
    const stage = s.status === 'cancelled' ? 0 : dispatched ? 3 : 2;
    return {
      id: s.id, type: s.type, status: s.status, createdAt: s.createdAt, stage, priority: s.priority, needs: s.needs,
      etaMin: dispatched?.result?.etaMin ?? null,
      cancelMsLeft: s.status === 'open' ? Math.max(0, s.createdAt + this.cancelWindowMs - this.now()) : 0,
    };
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

  /** Samples feed the inflow-rate forecast. `occ`/`t` can be injected (scenarios backfill history). */
  recordOccupancy(pointId, occ, t = this.now()) {
    const p = this.points.get(pointId);
    if (!p) return;
    const arr = this.occSamples.get(pointId) ?? [];
    arr.push({ t, occ: occ ?? p.occupied });
    arr.sort((a, b) => a.t - b.t);
    const cutoff = this.now() - 15 * 60_000;
    while (arr.length > 2 && (arr[0].t < cutoff || arr.length > 300)) arr.shift();
    this.occSamples.set(pointId, arr);
  }

  /** People per minute entering the point over the window, or null when there is too little data. */
  occupancyRate(pointId, windowMs = 5 * 60_000, minSpanMs = 60_000) {
    const arr = this.occSamples.get(pointId);
    if (!arr || arr.length < 2) return null;
    const cutoff = this.now() - windowMs;
    const w = arr.filter((s) => s.t >= cutoff);
    if (w.length < 2) return null;
    const span = w[w.length - 1].t - w[0].t;
    if (span < minSpanMs) return null;
    return (w[w.length - 1].occ - w[0].occ) / (span / 60_000);
  }

  /** Minutes until the point reaches `pct` % at the current inflow rate (0 = already there, null = not filling). */
  minutesToPct(pointId, pct) {
    const p = this.points.get(pointId);
    const rate = this.occupancyRate(pointId);
    if (!p || rate == null) return null;
    const remaining = (pct / 100) * p.capacity - p.occupied;
    if (remaining <= 0) return 0;
    return rate > 0 ? remaining / rate : null;
  }

  setOccupancy(pointId, occupied) {
    const p = this.getPoint(pointId);
    if (!Number.isFinite(occupied) || occupied < 0) throw new AppError(400, 'INVALID_OCCUPANCY');
    p.occupied = Math.min(Math.round(occupied), p.capacity);
    this.recordOccupancy(pointId);
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
    this.recordOccupancy(pointId);
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

  /** Open SOS inside the window that may count for escalation (quarantined ones never do). */
  recentOpenSos(windowMs, { verifiedOnly = false } = {}) {
    const cutoff = this.now() - windowMs;
    const out = [];
    // sos[] is chronological: scan from the newest and stop at the window edge
    for (let i = this.sos.length - 1; i >= 0 && this.sos[i].createdAt >= cutoff; i--) {
      const s = this.sos[i];
      if (s.status === 'open' && !s.quarantined && (!verifiedOnly || s.verified)) out.push(s);
    }
    return out.reverse();
  }

  /** Counts per district of currently open SOS (for the zone panel). */
  zoneCounts() {
    const out = Object.fromEntries(this.districts.map((d) => [d.id, 0]));
    for (const s of this.sos) if (s.status === 'open' && !s.quarantined && s.districtId) out[s.districtId] += 1;
    return out;
  }

  /** Dashboard-safe view of an SOS: no IP, device or citizen identifiers. */
  publicSos(s) {
    return {
      id: s.id, type: s.type, lat: s.lat, lng: s.lng, note: s.note, districtId: s.districtId, createdAt: s.createdAt,
      status: s.status, verified: s.verified, trust: s.trust ?? null, flags: s.flags, quarantined: s.quarantined,
      priority: s.priority, needs: s.needs,
    };
  }

  snapshot() {
    const open = this.sos.filter((s) => s.status === 'open');
    const openSos = open.filter((s) => !s.quarantined);
    const quarantined = open.filter((s) => s.quarantined);
    const zones = this.zoneCounts();
    return {
      time: this.now(),
      points: this.listPoints(),
      brigades: [...this.brigades.values()].map((b) => ({ ...b })),
      sos: openSos.slice(-300).map((s) => this.publicSos(s)),
      sosTotalOpen: openSos.length,
      priorityOpen: openSos.filter((s) => s.priority === 1).length,
      quarantined: quarantined.slice(-50).map((s) => this.publicSos(s)),
      quarantinedTotal: quarantined.length,
      abuse: this.guard ? { ...this.guard.verdict } : null,
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
