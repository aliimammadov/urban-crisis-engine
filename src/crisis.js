import { AppError } from './errors.js';
import { centroid, haversine, nearest } from './geo.js';

export const DEFAULT_RULES = Object.freeze({
  clusterRadiusM: 500,
  windowMs: 5 * 60 * 1000,
  minDistinctReporters: 4,
  overcrowdPct: 95,
  undoWindowMs: 10_000,       // dispatcher may revert an approval for this long
  brigadeSpeedMPerMin: 600,   // ~36 km/h, used for ETA estimates
});

export const ALERT_ACTION = 'RED_DISPATCH_AND_OPEN_POINT';

/**
 * Critical Crisis Algorithm.
 *  Rule A: >= minDistinctReporters different citizens send SOS within windowMs, either
 *          inside one district or inside clusterRadiusM of each other.
 *  Rule B: an assembly point exceeds overcrowdPct occupancy.
 * Both raise a RED alert; a dispatcher approves with one click (approve()).
 * Rules are plain config, so thresholds can be changed at runtime (Challenge Drop friendly).
 */
export class CrisisEngine {
  constructor(store, rules = {}) {
    this.store = store;
    this.rules = { ...DEFAULT_RULES, ...rules };
  }

  setRules(patch) {
    this.rules = { ...this.rules, ...patch };
    return this.rules;
  }

  /** Re-evaluates all rules. Idempotent: never creates duplicate alerts for the same situation. */
  evaluate({ focus } = {}) {
    const created = [...this.#evalClusters(focus), ...this.#evalOvercrowd()];
    for (const a of created) this.store.emit('alert', a);
    if (created.length) this.store.emit('change', 'alert');
    return created;
  }

  /**
   * Candidate groups. With `focus` (the SOS that just arrived) only the groups that
   * can have changed are built: O(window) instead of O(window^2) - important under load.
   * Without focus (manual/periodic re-evaluation) every SOS is a centre.
   */
  #candidateGroups(recent, focus) {
    const { clusterRadiusM } = this.rules;
    const groups = [];
    const centres = focus ? [focus] : recent;
    for (const s of centres) groups.push(recent.filter((o) => haversine(s, o) <= clusterRadiusM));
    const districts = new Set(centres.map((s) => s.districtId).filter(Boolean));
    for (const id of districts) groups.push(recent.filter((o) => o.districtId === id));
    return groups;
  }

  #evalClusters(focus) {
    const { windowMs, minDistinctReporters } = this.rules;
    const recent = this.store.recentOpenSos(windowMs);
    if (recent.length < minDistinctReporters) return [];
    const created = [];
    const openClusters = () => this.store.alerts.filter((a) => a.type === 'SOS_CLUSTER' && a.status === 'open');

    for (const group of this.#candidateGroups(recent, focus)) {
      const reporters = new Set(group.map((s) => s.citizenId));
      if (reporters.size < minDistinctReporters) continue;
      const ids = group.map((s) => s.id);
      const existing = openClusters().find((a) => a.sosIds.some((id) => ids.includes(id)));
      if (existing) {
        const merged = new Set([...existing.sosIds, ...ids]);
        existing.sosIds = [...merged];
        existing.reporters = new Set(
          this.store.sos.filter((s) => merged.has(s.id)).map((s) => s.citizenId),
        ).size;
        continue;
      }
      const center = centroid(group);
      created.push(this.#newAlert({
        type: 'SOS_CLUSTER',
        center,
        districtId: this.store.nearestDistrict(center)?.id ?? null,
        sosIds: ids,
        reporters: reporters.size,
        sosTypes: [...new Set(group.map((s) => s.type))],
      }));
    }
    return created;
  }

  #evalOvercrowd() {
    const created = [];
    for (const p of this.store.listPoints({ activeOnly: true })) {
      const open = this.store.alerts.find(
        (a) => a.type === 'POINT_OVERCROWD' && a.pointId === p.id && a.status === 'open',
      );
      if (p.occupancyPct > this.rules.overcrowdPct) {
        if (open) { open.occupancyPct = p.occupancyPct; continue; }
        created.push(this.#newAlert({
          type: 'POINT_OVERCROWD',
          center: { lat: p.lat, lng: p.lng },
          districtId: this.store.nearestDistrict(p)?.id ?? null,
          pointId: p.id,
          occupancyPct: p.occupancyPct,
        }));
      } else if (open) {
        open.status = 'expired'; // situation resolved on its own
      }
    }
    return created;
  }

  #newAlert(fields) {
    const alert = {
      id: this.store.nextId('a'),
      level: 'red',
      action: ALERT_ACTION,
      status: 'open',
      createdAt: this.store.now(),
      ...fields,
    };
    this.store.alerts.push(alert);
    return alert;
  }

  /** What approve() WOULD do, without doing it (shown to the dispatcher before the click). */
  plan(alert) {
    const free = [...this.store.brigades.values()].filter((b) => b.status === 'available');
    const b = nearest(alert.center, free);
    const reserves = [...this.store.points.values()].filter((p) => !p.active);
    const np = nearest(alert.center, reserves);
    return {
      brigade: b ? { id: b.item.id, name: b.item.name, etaMin: this.#eta(b.distance) } : null,
      point: np ? { id: np.item.id, name: np.item.name, capacity: np.item.capacity } : null,
    };
  }

  #eta(distanceM) {
    return Math.max(1, Math.round(distanceM / this.rules.brigadeSpeedMPerMin));
  }

  /** One-click decision: dispatch nearest free brigade + open nearest reserve assembly point. */
  approve(alertId, actor = 'dispatcher') {
    const alert = this.store.alerts.find((a) => a.id === alertId);
    if (!alert) throw new AppError(404, 'ALERT_NOT_FOUND');
    if (alert.status === 'approved') return alert; // idempotent
    if (alert.status !== 'open') throw new AppError(409, 'ALERT_NOT_OPEN');

    const p = this.plan(alert);
    const b = p.brigade ? this.store.brigades.get(p.brigade.id) : null;
    if (b) {
      b.status = 'dispatched';
      b.target = { ...alert.center };
      b.alertId = alert.id;
    }
    const np = p.point ? this.store.points.get(p.point.id) : null;
    if (np) np.active = true;

    alert.status = 'approved';
    alert.approvedAt = this.store.now();
    alert.approvedBy = actor;
    alert.result = { brigadeId: b?.id ?? null, openedPointId: np?.id ?? null, etaMin: p.brigade?.etaMin ?? null };
    this.store.emit('change', 'alert');
    return alert;
  }

  /** Reverts an approval inside rules.undoWindowMs (brigade freed, reserve point closed again). */
  undo(alertId) {
    const alert = this.store.alerts.find((a) => a.id === alertId);
    if (!alert) throw new AppError(404, 'ALERT_NOT_FOUND');
    if (alert.status !== 'approved') throw new AppError(409, 'ALERT_NOT_APPROVED');
    if (this.store.now() - alert.approvedAt > this.rules.undoWindowMs) throw new AppError(409, 'UNDO_EXPIRED');

    const b = this.store.brigades.get(alert.result.brigadeId);
    if (b && b.alertId === alert.id) { b.status = 'available'; delete b.target; delete b.alertId; }
    const np = this.store.points.get(alert.result.openedPointId);
    if (np && np.occupied === 0) np.active = false;

    alert.status = 'open';
    delete alert.approvedAt; delete alert.approvedBy; delete alert.result;
    this.store.emit('change', 'alert');
    return alert;
  }

  /** Adds dispatcher-facing extras to a store snapshot: plan, SOS type counts, undo timer. */
  decorate(snap) {
    const recent = this.store.sos.slice(-2000);
    snap.alerts = snap.alerts.map((a) => {
      const out = { ...a };
      if (a.type === 'SOS_CLUSTER') {
        const ids = new Set(a.sosIds);
        out.typeCounts = {};
        for (const s of recent) if (ids.has(s.id)) out.typeCounts[s.type] = (out.typeCounts[s.type] ?? 0) + 1;
      }
      if (a.status === 'open') out.plan = this.plan(a);
      if (a.status === 'approved') out.undoMsLeft = Math.max(0, a.approvedAt + this.rules.undoWindowMs - this.store.now());
      return out;
    });
    return snap;
  }
}
