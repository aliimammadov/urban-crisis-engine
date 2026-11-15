import { AppError } from './errors.js';
import { centroid, haversine, nearest } from './geo.js';

export const DEFAULT_RULES = Object.freeze({
  clusterRadiusM: 500,
  windowMs: 5 * 60 * 1000,
  minDistinctReporters: 4,
  overcrowdPct: 95,
  undoWindowMs: 10_000,       // dispatcher may revert an approval for this long
  brigadeSpeedMPerMin: 600,   // ~36 km/h, used for ETA estimates
  // --- abuse / security (see abuse.js) ---
  requireVerified: false,     // true = only signed-device SOS count for auto-escalation ("security mode")
  quarantineEnabled: true,    // false = flag suspicious SOS but still count them
  ipDeviceLimit: 6,           // distinct devices behind one IP before it counts as a bot signal
  burstMin: 20,               // SOS per minute that count as a burst signal
  // --- stability + proactive forecast ---
  clearPct: 90,               // an overcrowd alert only clears below this (hysteresis, avoids flapping around 95%)
  overcrowdCooldownMs: 5 * 60_000, // after approval, no new overcrowd alert for the same point...
  overcrowdForcePct: 98,      // ...unless it gets this full
  forecastHorizonMin: 10,     // warn when a point will pass overcrowdPct within this many minutes
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

  /** Validated runtime change of thresholds (unknown keys / wrong types are rejected). */
  setRules(patch) {
    if (!patch || typeof patch !== 'object') throw new AppError(400, 'INVALID_RULE');
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_RULES) || typeof v !== typeof DEFAULT_RULES[k]) throw new AppError(400, 'INVALID_RULE');
      if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) throw new AppError(400, 'INVALID_RULE');
    }
    this.rules = { ...this.rules, ...patch };
    this.store.emit('change', 'rules');
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

  /** Reporters of an alert that are not quarantined (resolved/cancelled still count: they WERE in danger). */
  #liveReporters(ids) {
    const set = new Set(ids);
    const people = new Set();
    for (const s of this.store.sos.slice(-5000)) if (set.has(s.id) && !s.quarantined) people.add(s.citizenId);
    return people.size;
  }

  /** An open cluster alert whose evidence was quarantined (fake flood) withdraws itself. */
  #expireQuarantined() {
    if (this.seenQuarantine === this.store.quarantineVersion) return; // nothing changed: skip the scan
    this.seenQuarantine = this.store.quarantineVersion;
    for (const a of this.store.alerts) {
      if (a.type !== 'SOS_CLUSTER' || a.status !== 'open') continue;
      a.reporters = this.#liveReporters(a.sosIds);
      if (a.reporters < this.rules.minDistinctReporters) a.status = 'expired';
    }
  }

  #evalClusters(focus) {
    const { windowMs, minDistinctReporters, requireVerified } = this.rules;
    this.#expireQuarantined();
    const recent = this.store.recentOpenSos(windowMs, { verifiedOnly: requireVerified });
    if (recent.length < minDistinctReporters) return [];
    const created = [];
    const openClusters = () => this.store.alerts.filter((a) => a.type === 'SOS_CLUSTER' && a.status === 'open');

    // SOS already handled by an approved alert are not fresh evidence: after a dispatch, extra signals
    // from the same area must not spawn a duplicate red alert (a NEW cluster of fresh reporters still does).
    const handled = new Set();
    for (const a of this.store.alerts) if (a.type === 'SOS_CLUSTER' && a.status === 'approved') for (const id of a.sosIds) handled.add(id);

    for (const full of this.#candidateGroups(recent, focus)) {
      const group = full.filter((s) => !handled.has(s.id));
      const reporters = new Set(group.map((s) => s.citizenId));
      if (reporters.size < minDistinctReporters) continue;
      const ids = group.map((s) => s.id);
      const existing = openClusters().find((a) => a.sosIds.some((id) => ids.includes(id)));
      if (existing) {
        const merged = new Set([...existing.sosIds, ...ids]);
        existing.sosIds = [...merged];
        existing.reporters = this.#liveReporters(merged);
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
    const { overcrowdPct, clearPct, overcrowdCooldownMs, overcrowdForcePct, forecastHorizonMin } = this.rules;
    const created = [];
    const now = this.store.now();
    const cooling = (type, pointId) => this.store.alerts.some(
      (a) => a.type === type && a.pointId === pointId && a.status === 'approved' && now - a.approvedAt < overcrowdCooldownMs,
    );
    for (const p of this.store.listPoints({ activeOnly: true })) {
      const find = (type) => this.store.alerts.find((a) => a.type === type && a.pointId === p.id && a.status === 'open');
      const red = find('POINT_OVERCROWD');
      const amber = find('POINT_FILLING');
      if (p.occupancyPct > overcrowdPct) {
        if (amber) amber.status = 'expired'; // the warning came true: superseded by the red alert
        if (red) { red.occupancyPct = p.occupancyPct; continue; }
        if (cooling('POINT_OVERCROWD', p.id) && p.occupancyPct < overcrowdForcePct) continue;
        created.push(this.#newAlert({
          type: 'POINT_OVERCROWD', center: { lat: p.lat, lng: p.lng },
          districtId: this.store.nearestDistrict(p)?.id ?? null, pointId: p.id, occupancyPct: p.occupancyPct,
        }));
        continue;
      }
      if (red) {
        if (p.occupancyPct < clearPct) red.status = 'expired'; // resolved on its own (hysteresis: not at 94.9%)
        else red.occupancyPct = p.occupancyPct;
        continue;
      }
      // proactive: will it pass the threshold soon?
      const eta = this.store.minutesToPct(p.id, overcrowdPct);
      const wants = eta != null && eta > 0 && eta <= forecastHorizonMin && !cooling('POINT_FILLING', p.id);
      const rate = this.store.occupancyRate(p.id);
      if (wants && !amber) {
        created.push(this.#newAlert({
          type: 'POINT_FILLING', level: 'amber', action: 'OPEN_RESERVE_POINT',
          center: { lat: p.lat, lng: p.lng }, districtId: this.store.nearestDistrict(p)?.id ?? null,
          pointId: p.id, occupancyPct: p.occupancyPct, etaMin: Math.max(1, Math.round(eta)), ratePerMin: Math.round(rate),
        }));
      } else if (amber && !wants) amber.status = 'expired';
      else if (amber) Object.assign(amber, { occupancyPct: p.occupancyPct, etaMin: Math.max(1, Math.round(eta)), ratePerMin: Math.round(rate) });
    }
    return created;
  }

  /** Cheap time-driven pass (no SOS scan): forecasts and expiries change as time passes, not only on events. */
  tick() {
    const created = this.#evalOvercrowd();
    this.#expireQuarantined();
    for (const a of created) this.store.emit('alert', a);
    if (created.length) this.store.emit('change', 'alert');
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
    const free = alert.level === 'amber' ? [] : [...this.store.brigades.values()].filter((b) => b.status === 'available');
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
    this.store.guard?.reward(alert.sosIds ?? []); // corroborated reporters gain trust
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
