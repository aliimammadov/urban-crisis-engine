import { detectBots } from './botdetect.js';
import { geoAssess, effectiveTrust, penalizeTrust, rewardTrust, TRUST } from './trust.js';
import { nearest } from './geo.js';

const MAX_DEVICES = 50_000;

/**
 * Decides which SOS may count towards AUTOMATIC escalation.
 * Safety principle: a flagged/quarantined SOS is never dropped. It stays visible to the dispatcher
 * (marked), and a human can release it; it just does not trigger the red alert by itself.
 */
export class AbuseGuard {
  constructor(store, getRules) {
    this.store = store;
    this.rules = getRules;
    this.devices = new Map(); // deviceId -> {firstSeen, trust, verified, flagged}
    this.verdict = { attack: false, surge: false, signals: [], ratePerMin: 0, baselinePerMin: 1, at: 0 };
    this.lastAnalysis = -Infinity;
    this.penalized = new Set();
  }

  reset() {
    this.devices.clear();
    this.penalized.clear();
    this.lastAnalysis = -Infinity;
    this.verdict = { attack: false, surge: false, signals: [], ratePerMin: 0, baselinePerMin: 1, at: 0 };
  }

  device(id, verified) {
    let d = this.devices.get(id);
    if (!d) {
      if (this.devices.size >= MAX_DEVICES) for (const k of [...this.devices.keys()].slice(0, 10_000)) this.devices.delete(k);
      d = { firstSeen: this.store.now(), trust: TRUST.start, verified: !!verified, flagged: 0 };
      this.devices.set(id, d);
    } else if (verified) d.verified = true;
    return d;
  }

  /** Called synchronously by Store.addSos, BEFORE crisis rules are evaluated. */
  assess(sos) {
    const now = this.store.now();
    const d = this.device(sos.deviceId, sos.verified);
    sos.trust = Math.round(effectiveTrust(d.trust, now - d.firstSeen, d.verified) * 100) / 100;
    const near = nearest(sos, this.store.districts);
    const g = geoAssess(near ? near.distance : Infinity, sos.accuracy);
    sos.geoWeight = g.weight;
    if (g.flag) { sos.flags.push(g.flag); this.#quarantine(sos, null); }
    if (!sos.verified) sos.flags.push('unverified');
    if (d.trust <= TRUST.min + 0.05) this.#quarantine(sos, 'low_trust');
    this.analyze();
    return sos;
  }

  #quarantine(sos, reason) {
    if (sos.quarantined || sos.released) return;
    if (reason) sos.flags.push(reason);
    if (!this.rules().quarantineEnabled) return;
    sos.quarantined = true;
    this.store.quarantineVersion += 1;
    if (!this.penalized.has(sos.id)) {
      this.penalized.add(sos.id);
      const d = this.devices.get(sos.deviceId);
      if (d) { d.trust = penalizeTrust(d.trust); d.flagged += 1; }
    }
  }

  #window(now) {
    const out = [];
    const all = this.store.sos;
    for (let i = all.length - 1; i >= 0 && now - all[i].createdAt <= 35 * 60_000 && out.length < 5000; i--) out.push(all[i]);
    return out;
  }

  /** Re-runs bot detection. Cheap for small windows; throttled to 2/s when the window is huge (flood). */
  analyze(force = false) {
    const now = this.store.now();
    const win = this.#window(now);
    const recent = win.filter((s) => now - s.createdAt <= 5 * 60_000);
    if (!force && recent.length > 200 && now - this.lastAnalysis < 500) return this.verdict;
    this.lastAnalysis = now;
    const older = win.length - recent.length;
    const r = this.rules();
    const v = detectBots(
      recent.map((s) => ({ id: s.id, ts: s.createdAt, ip: s.ip, deviceId: s.deviceId })),
      now, this.devices,
      { baselinePerMin: older / 30, burstMin: r.burstMin, ipDeviceLimit: r.ipDeviceLimit },
    );
    if (v.attack) {
      for (const s of recent) if (v.suspiciousIds.has(s.id)) this.#quarantine(s, 'bot_attack');
    }
    this.verdict = { attack: v.attack, surge: v.surge, signals: v.signals, ratePerMin: v.ratePerMin, baselinePerMin: v.baselinePerMin, at: now };
    return this.verdict;
  }

  /** Human override: dispatcher says "this one is real". */
  release(sosId) {
    const s = this.store.findSos(sosId);
    s.quarantined = false;
    this.store.quarantineVersion += 1;
    s.released = true;
    if (!s.flags.includes('released')) s.flags.push('released');
    const d = this.devices.get(s.deviceId);
    if (d) d.trust = rewardTrust(d.trust, 0.1);
    return s;
  }

  /** Reporters of an approved alert were corroborated: raise their trust. */
  reward(sosIds) {
    const ids = new Set(sosIds);
    for (const s of this.store.sos.slice(-5000)) {
      if (!ids.has(s.id) || s.quarantined) continue;
      const d = this.devices.get(s.deviceId);
      if (d) d.trust = rewardTrust(d.trust);
    }
  }
}
