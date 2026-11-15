// SOS flood protection: rate-limit lanes + flood detection + counters for the dispatcher.
//
// Lanes (who is limited by what):
//   signed device   -> its own bucket per DEVICE (a crowd behind one Wi-Fi/NAT address is not punished as a group)
//   unsigned caller -> bucket per IP address, plus one GLOBAL bucket shared by all unsigned callers
//                      (a botnet with thousands of addresses still cannot push more than the global budget)
// Flood mode: when SOS attempts in the last 10 s exceed `floodThreshold`, unsigned SOS are still accepted
// (never dropped) but quarantined, so fakes cannot raise alerts or bury the dispatcher's lists.
import { EventEmitter } from 'node:events';
import { RateLimiter } from './ratelimit.js';

const SLOTS = 60;

export class SosShield extends EventEmitter {
  constructor({ now = () => Date.now(), limits = {} } = {}) {
    super();
    this.now = now;
    this.cfg = {
      floodThreshold: limits.floodThreshold ?? 150, // attempts per 10 s
      floodHoldMs: limits.floodHoldMs ?? 60_000,
    };
    this.ip = new RateLimiter({ capacity: limits.sosBurst ?? 10, refillPerSec: limits.sosPerSec ?? 0.5, now });
    this.device = new RateLimiter({ capacity: limits.deviceBurst ?? 6, refillPerSec: limits.devicePerSec ?? 0.2, now });
    this.global = new RateLimiter({ capacity: limits.globalBurst ?? 120, refillPerSec: limits.globalPerSec ?? 40, now });
    this.reset();
  }

  reset() {
    this.slots = Array.from({ length: SLOTS }, () => ({ sec: -1, attempts: 0, accepted: 0, limited: 0, duplicates: 0 }));
    this.floodUntil = 0;
    this.totals = { attempts: 0, accepted: 0, limited: 0, duplicates: 0, floods: 0 };
  }

  #slot() {
    const sec = Math.floor(this.now() / 1000);
    const s = this.slots[sec % SLOTS];
    if (s.sec !== sec) Object.assign(s, { sec, attempts: 0, accepted: 0, limited: 0, duplicates: 0 });
    return s;
  }

  #sum(key, seconds) {
    const sec = Math.floor(this.now() / 1000);
    let n = 0;
    for (const s of this.slots) if (s.sec > sec - seconds && s.sec <= sec) n += s[key];
    return n;
  }

  floodActive() { return this.now() < this.floodUntil; }

  /** Call for EVERY incoming SOS request, before the body is read. */
  admit({ ip, deviceId }) {
    const slot = this.#slot();
    slot.attempts += 1; this.totals.attempts += 1;
    // flood detection looks at raw attempts, including the ones we are about to refuse
    if (this.#sum('attempts', 10) > this.cfg.floodThreshold) {
      const was = this.floodActive();
      this.floodUntil = this.now() + this.cfg.floodHoldMs;
      if (!was) { this.totals.floods += 1; this.emit('flood', { on: true, attemptsPer10s: this.#sum('attempts', 10) }); }
    }
    const ok = deviceId ? this.device.take(deviceId) : this.ip.take(ip) && this.global.take('unsigned');
    if (!ok) { slot.limited += 1; this.totals.limited += 1; return { ok: false }; }
    return { ok: true, flood: this.floodActive() && !deviceId };
  }

  note(kind) { // 'accepted' | 'duplicates'
    this.#slot()[kind] += 1; this.totals[kind] += 1;
  }

  /** For periodic checks: reports the end of a flood exactly once. */
  tick() {
    if (this.floodUntil && !this.floodActive()) { this.floodUntil = 0; this.emit('flood', { on: false }); }
  }

  stats() {
    return {
      flood: this.floodActive(),
      floodEndsInSec: this.floodActive() ? Math.ceil((this.floodUntil - this.now()) / 1000) : 0,
      last60s: { attempts: this.#sum('attempts', 60), accepted: this.#sum('accepted', 60), rateLimited: this.#sum('limited', 60), duplicates: this.#sum('duplicates', 60) },
      attemptsPer10s: this.#sum('attempts', 10),
      totals: { ...this.totals },
    };
  }
}
