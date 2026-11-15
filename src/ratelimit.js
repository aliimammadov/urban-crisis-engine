/** Token-bucket limiter keyed by client id. Cheap, in-memory, self-cleaning. */
export class RateLimiter {
  constructor({ capacity, refillPerSec, now = () => Date.now(), maxKeys = 50_000 }) {
    this.maxKeys = maxKeys;
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map();
    this.lastSweep = now();
  }

  take(key) {
    const t = this.now();
    this.#sweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) { let n = this.maxKeys / 10; for (const k of this.buckets.keys()) { this.buckets.delete(k); if (--n <= 0) break; } } // drop the oldest 10 %
      b = { tokens: this.capacity, at: t }; this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  #sweep(t) {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (t - b.at > 120_000) this.buckets.delete(k);
  }
}
