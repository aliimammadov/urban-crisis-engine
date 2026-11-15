import { AppError } from './errors.js';
import { centroid, haversine, nearest } from './geo.js';

export const DEFAULT_RULES = Object.freeze({
  clusterRadiusM: 500,
  windowMs: 5 * 60 * 1000,
  minDistinctReporters: 4,
  overcrowdPct: 95,
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

  /** One-click decision: dispatch nearest free brigade + open nearest reserve assembly point. */
  approve(alertId, actor = 'dispatcher') {
    const alert = this.store.alerts.find((a) => a.id === alertId);
    if (!alert) throw new AppError(404, 'ALERT_NOT_FOUND');
    if (alert.status === 'approved') return alert; // idempotent
    if (alert.status !== 'open') throw new AppError(409, 'ALERT_NOT_OPEN');

    const free = [...this.store.brigades.values()].filter((b) => b.status === 'available');
    const b = nearest(alert.center, free)?.item ?? null;
    if (b) {
      b.status = 'dispatched';
      b.target = { ...alert.center };
      b.alertId = alert.id;
    }
    const reserves = [...this.store.points.values()].filter((p) => !p.active);
    const np = nearest(alert.center, reserves)?.item ?? null;
    if (np) np.active = true;

    alert.status = 'approved';
    alert.approvedAt = this.store.now();
    alert.approvedBy = actor;
    alert.result = { brigadeId: b?.id ?? null, openedPointId: np?.id ?? null };
    this.store.emit('change', 'alert');
    return alert;
  }
}
