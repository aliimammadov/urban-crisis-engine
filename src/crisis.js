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
  // --- brigade lifecycle ---
  brigadeTimeScale: 1,        // demo speed-up: 10 = everything on the road happens 10x faster
  onSceneMs: 5 * 60_000,      // how long a brigade works at the scene before returning
});

export const ALERT_ACTION = 'RED_DISPATCH_AND_OPEN_POINT';
export const PRIORITY_ACTION = 'DISPATCH_ACCESSIBLE_TRANSPORT';

// Which kind of brigade an emergency needs, best first. Anything else free is still offered (as a worse match).
const KIND_PREF = { FIRE: ['fire', 'rescue'], MEDICAL: ['medical'], COLLAPSE: ['rescue', 'fire'], FLOOD: ['rescue', 'fire'] };
const TIE_ORDER = ['MEDICAL', 'FIRE', 'COLLAPSE', 'FLOOD']; // when a cluster mixes types equally, the life-threatening one wins
const MATCH = ['exact', 'secondary', 'any', 'special'];

/**
 * Critical Crisis Algorithm.
 *  Rule A: >= minDistinctReporters different citizens send SOS within windowMs, either
 *          inside one district or inside clusterRadiusM of each other.
 *  Rule B: an assembly point exceeds overcrowdPct occupancy.
 * Both raise a RED alert; a dispatcher approves with one click (approve()).
 * Rules are plain config, so thresholds can be changed at runtime (Challenge Drop friendly).
 */
export class CrisisEngine {
  constructor(store, rules = {}, { graph = null } = {}) {
    this.store = store;
    this.graph = graph;
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
    const created = [...this.#evalPriority(focus), ...this.#evalClusters(focus), ...this.#evalOvercrowd()];
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

  /**
   * Priority #1: ONE SOS from a verified special-care citizen is enough for an immediate alert
   * (no 4-reporter rule, no verified-only gate: the device is verified by definition).
   * Quarantined SOS (out of area, bot flood) still do not escalate automatically.
   */
  #evalPriority(focus) {
    const created = [];
    for (const a of this.store.alerts) {
      if (a.type !== 'PRIORITY_SOS' || a.status !== 'open') continue;
      const s = this.store.sos.find((x) => x.id === a.sosId);
      if (!s || s.status !== 'open' || s.quarantined) a.status = 'expired'; // cancelled / marked safe / quarantined
    }
    const candidates = focus ? [focus] : this.store.sos.slice(-2000);
    for (const s of candidates) {
      if (s.priority !== 1 || s.status !== 'open' || s.quarantined) continue;
      const exists = this.store.alerts.some((a) => a.type === 'PRIORITY_SOS' && a.sosId === s.id && a.status !== 'expired');
      if (exists) continue;
      created.push(this.#newAlert({
        type: 'PRIORITY_SOS', priority: 1, action: PRIORITY_ACTION,
        center: { lat: s.lat, lng: s.lng }, districtId: s.districtId, sosId: s.id, sosIds: [s.id], needs: [...s.needs], reporters: 1,
      }));
    }
    return created;
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
    const created = [...this.#evalPriority(null), ...this.#evalOvercrowd()];
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
    if (alert.type === 'PRIORITY_SOS') return this.#priorityPlan(alert);
    const cands = this.candidates(alert);
    const auto = cands.find((c) => c.match !== 'special'); // reserved vehicles (accessible transport) are never auto-picked here
    const reserves = [...this.store.points.values()].filter((p) => !p.active);
    const np = alert.type === 'SOS_SINGLE' ? null : nearest(alert.center, reserves); // one person: no new assembly point
    return {
      brigade: auto ? { id: auto.id, name: auto.name, kind: auto.kind, etaMin: auto.etaMin, match: auto.match } : null,
      wantedKind: alert.level === 'amber' ? null : (KIND_PREF[this.#wantedType(alert)] ?? ['rescue'])[0],
      candidates: cands,
      point: np ? { id: np.item.id, name: np.item.name, capacity: np.item.capacity } : null,
    };
  }

  /** The emergency type that decides which kind of brigade is wanted (null = crowd control -> rescue). */
  #wantedType(alert) {
    if (alert.type === 'SOS_SINGLE') return alert.sosType ?? this.store.sos.findLast((s) => s.id === alert.sosId)?.type ?? null;
    if (alert.type !== 'SOS_CLUSTER') return null;
    const ids = new Set(alert.sosIds ?? []);
    const counts = {};
    for (const s of this.store.sos.slice(-5000)) if (ids.has(s.id)) counts[s.type] = (counts[s.type] ?? 0) + 1;
    let best = null;
    for (const t of TIE_ORDER) if (counts[t] && (best === null || counts[t] > counts[best])) best = t;
    return best;
  }

  /**
   * Every free brigade, ranked for this alert: right kind first (then the second-best kind, then any other),
   * nearest first inside a rank. `special` = reserved for priority citizens (accessible transport).
   * This is what the dispatcher sees in the brigade picker; the first non-special entry is the automatic choice.
   */
  candidates(alert) {
    if (alert.level === 'amber') return [];
    const avail = [...this.store.brigades.values()].filter((b) => b.status === 'available');
    let rankOf;
    if (alert.type === 'PRIORITY_SOS') {
      rankOf = (b) => (b.kind === 'accessible_transport' ? 0 : b.kind === 'medical' ? 1 : 3);
    } else {
      const pref = KIND_PREF[this.#wantedType(alert)] ?? ['rescue'];
      rankOf = (b) => (b.kind === 'accessible_transport' ? 3 : pref.indexOf(b.kind) >= 0 ? pref.indexOf(b.kind) : 2);
    }
    return avail
      .map((b) => ({ b, rank: rankOf(b), distance: haversine(b.home, alert.center) }))
      .sort((x, y) => x.rank - y.rank || x.distance - y.distance)
      .map(({ b, rank, distance }) => ({ id: b.id, name: b.name, kind: b.kind, etaMin: this.#eta(distance), distanceM: Math.round(distance), match: MATCH[Math.min(rank, 3)] }));
  }

  /** Accessible transport first; if none is free, the nearest medical brigade (flagged as fallback). */
  #priorityPlan(alert) {
    const cands = this.candidates(alert);
    const v = cands.find((c) => c.match === 'exact' || c.match === 'secondary');
    return {
      brigade: v ? { id: v.id, name: v.name, kind: v.kind, etaMin: v.etaMin, fallback: v.match !== 'exact', match: v.match } : null,
      candidates: cands,
      point: null,
      accessiblePoint: this.#accessiblePoint(alert.center),
    };
  }

  /** Nearest accessible active point reachable over step-free roads, with the accessible route length. */
  #accessiblePoint(center) {
    if (!this.graph) return null;
    const start = this.graph.nearestNode(center);
    let best = null;
    for (const p of this.store.listPoints({ activeOnly: true })) {
      if (!p.accessible) continue;
      const path = this.graph.shortestPath(start.id, p.id, { accessible: true });
      if (!path) continue;
      const distanceM = Math.round(haversine(center, start) + path.length);
      if (!best || distanceM < best.distanceM) best = { id: p.id, name: p.name, distanceM, access: p.access ?? [] };
    }
    return best;
  }

  #scale() { return Math.max(0.1, this.rules.brigadeTimeScale || 1); }

  #eta(distanceM) {
    return Math.max(1, Math.round(distanceM / this.rules.brigadeSpeedMPerMin / this.#scale()));
  }

  #travelMs(distanceM) {
    return Math.max(3000, (distanceM / this.rules.brigadeSpeedMPerMin) * 60_000 / this.#scale());
  }

  /**
   * Brigade lifecycle: dispatched (moving) -> on_scene -> returning (moving) -> available.
   * Called every second by the app; cheap when nothing moves. Emits a change while anything is in motion
   * so dashboards animate smoothly.
   */
  tickBrigades() {
    const now = this.store.now();
    let moving = false;
    let transitioned = false;
    for (const b of this.store.brigades.values()) {
      if (b.status === 'dispatched' && b.move) {
        moving = true;
        if (now >= b.move.startedAt + b.move.durationMs) { b.status = 'on_scene'; b.onSceneAt = now; delete b.move; transitioned = true; }
      } else if (b.status === 'on_scene' && b.onSceneAt != null && b.alertId) {
        if (now - b.onSceneAt >= this.rules.onSceneMs / this.#scale()) {
          const dur = b.travelMs ?? 3000;
          b.status = 'returning';
          b.move = { from: { ...b.target }, to: { ...b.home }, startedAt: now, durationMs: dur };
          transitioned = true; moving = true;
        }
      } else if (b.status === 'returning' && b.move) {
        moving = true;
        if (now >= b.move.startedAt + b.move.durationMs) { this.store.resetBrigade(b); transitioned = true; }
      }
    }
    if (moving || transitioned) this.store.emit('change', 'brigade');
    return { moving, transitioned };
  }

  /** One-click decision: dispatch nearest free brigade + open nearest reserve assembly point. */
  approve(alertId, actor = 'dispatcher', { brigadeId } = {}) {
    const alert = this.store.alerts.find((a) => a.id === alertId);
    if (!alert) throw new AppError(404, 'ALERT_NOT_FOUND');
    if (alert.status === 'approved') return alert; // idempotent
    if (alert.status !== 'open') throw new AppError(409, 'ALERT_NOT_OPEN');

    const p = this.plan(alert);
    let b = p.brigade ? this.store.brigades.get(p.brigade.id) : null;
    // The dispatcher may overrule the automatic choice with any FREE brigade (their call, not ours).
    let manual = false;
    if (brigadeId != null) {
      if (typeof brigadeId !== 'string' || alert.level === 'amber') throw new AppError(400, 'INVALID_BRIGADE');
      const pick = this.store.brigades.get(brigadeId);
      if (!pick) throw new AppError(404, 'BRIGADE_NOT_FOUND');
      if (pick.status !== 'available') throw new AppError(409, 'BRIGADE_NOT_AVAILABLE');
      manual = pick.id !== b?.id;
      b = pick;
    }
    const match = b ? p.candidates.find((c) => c.id === b.id)?.match ?? 'any' : null;
    if (b) {
      const dist = haversine(b.home, alert.center);
      b.status = 'dispatched';
      b.target = { ...alert.center };
      b.alertId = alert.id;
      b.travelMs = this.#travelMs(dist);
      b.move = { from: { ...b.home }, to: { ...alert.center }, startedAt: this.store.now(), durationMs: b.travelMs };
      delete b.onSceneAt;
    }
    const np = p.point ? this.store.points.get(p.point.id) : null;
    if (np) np.active = true; // priority alerts have no point to open (they dispatch accessible transport)

    alert.status = 'approved';
    this.store.guard?.reward(alert.sosIds ?? []); // corroborated reporters gain trust
    alert.approvedAt = this.store.now();
    alert.approvedBy = actor;
    const etaMin = b ? this.#eta(haversine(b.home, alert.center)) : null;
    alert.result = { brigadeId: b?.id ?? null, openedPointId: np?.id ?? null, etaMin, manual, match };
    if (alert.type === 'PRIORITY_SOS') alert.result = { ...alert.result, accessible: true, fallback: !!b && b.kind !== 'accessible_transport', accessiblePointId: p.accessiblePoint?.id ?? null };
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
    if (b && b.alertId === alert.id) this.store.resetBrigade(b);
    const np = this.store.points.get(alert.result.openedPointId);
    if (np && np.occupied === 0) np.active = false;

    if (alert.type === 'SOS_SINGLE') { // nothing to re-open: the SOS goes back to the pending list
      const i = this.store.alerts.indexOf(alert);
      if (i >= 0) this.store.alerts.splice(i, 1);
      this.store.emit('change', 'alert');
      return { ...alert, status: 'cancelled' };
    }
    alert.status = 'open';
    delete alert.approvedAt; delete alert.approvedBy; delete alert.result;
    this.store.emit('change', 'alert');
    return alert;
  }

  /**
   * SOS that no alert covers yet (typically ONE person: the 4-reporter rule has not fired), newest first,
   * each with the ranked free brigades, so a dispatcher can send help to any individual signal.
   */
  pendingSos(limit = 12) {
    const covered = new Set();
    for (const a of this.store.alerts) if (a.status === 'open' || a.status === 'approved') for (const id of a.sosIds ?? []) covered.add(id);
    const out = [];
    const all = this.store.sos;
    for (let i = all.length - 1; i >= 0 && i >= all.length - 3000 && out.length < limit; i--) {
      const s = all[i];
      if (s.status !== 'open' || s.quarantined || covered.has(s.id)) continue;
      const cands = this.candidates({ type: 'SOS_SINGLE', level: 'red', sosId: s.id, sosIds: [s.id], sosType: s.type, center: { lat: s.lat, lng: s.lng } });
      out.push({
        id: s.id, type: s.type, districtId: s.districtId, lat: s.lat, lng: s.lng, note: s.note, createdAt: s.createdAt,
        verified: s.verified, source: s.source, priority: s.priority,
        wantedKind: (KIND_PREF[s.type] ?? ['rescue'])[0],
        autoId: cands.find((c) => c.match !== 'special')?.id ?? null,
        candidates: cands.slice(0, 8),
      });
    }
    return out;
  }

  /**
   * The dispatcher sends a brigade to ONE signal (no cluster needed). Creates an already-approved
   * alert of type SOS_SINGLE so the whole lifecycle (movement, ETA, citizen progress, undo, journal) is shared.
   */
  dispatchSos(sosId, actor = 'dispatcher', { brigadeId } = {}) {
    const s = this.store.findSos(sosId); // 404
    if (s.status !== 'open') throw new AppError(409, 'SOS_NOT_OPEN');
    const holder = this.store.alerts.find((a) => (a.status === 'open' || a.status === 'approved') && a.sosIds?.includes(sosId));
    if (holder) throw new AppError(409, holder.status === 'approved' ? 'SOS_ALREADY_DISPATCHED' : 'SOS_IN_ALERT');
    const probe = { type: 'SOS_SINGLE', level: 'red', sosId, sosIds: [sosId], sosType: s.type, center: { lat: s.lat, lng: s.lng } };
    const cands = this.candidates(probe);
    if (!cands.length || (!brigadeId && !cands.some((c) => c.match !== 'special'))) throw new AppError(409, 'NO_BRIGADE_AVAILABLE');
    const alert = this.#newAlert({
      type: 'SOS_SINGLE', action: 'DISPATCH_TO_SOS', center: probe.center, districtId: s.districtId,
      sosId, sosIds: [sosId], sosType: s.type, reporters: 1, needs: [...(s.needs ?? [])], priority: s.priority,
    });
    try { return this.approve(alert.id, actor, { brigadeId }); } catch (e) {
      const i = this.store.alerts.indexOf(alert);
      if (i >= 0) this.store.alerts.splice(i, 1); // never leave a half-made alert behind
      throw e;
    }
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
      if (a.sosId) out.sosState = recent.findLast((s) => s.id === a.sosId)?.status ?? null; // open | resolved (safe) | cancelled
      return out;
    });
    snap.pending = this.pendingSos(12);
    return snap;
  }
}
