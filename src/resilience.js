// Resilience toolkit for flaky external dependencies (the map / routing API).
import { EventEmitter } from 'node:events';

/** kind: 'http' (e.g. 503) | 'timeout' | 'network' */
export class ExternalApiError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.name = 'ExternalApiError';
    this.kind = kind;
    this.status = status;
  }
}

export class CircuitOpenError extends Error {
  constructor(retryInMs) {
    super('circuit open');
    this.name = 'CircuitOpenError';
    this.kind = 'circuit_open';
    this.retryInMs = retryInMs;
  }
}

/**
 * Deadline for a promise. The loser of the race is always observed, so a late rejection of the
 * abandoned call can never become an "unhandled rejection".
 */
export function withTimeout(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new ExternalApiError('timeout', 0, `no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Circuit breaker.
 *   closed     normal: calls go through; `failureThreshold` consecutive failures open the circuit.
 *   open       calls are NOT attempted (instant CircuitOpenError) until the cool-down is over.
 *   half_open  after the cool-down exactly ONE trial call is allowed; success closes the circuit,
 *              failure re-opens it with a longer cool-down (exponential back-off, capped).
 * Failures that finish after the circuit is already open do not extend the cool-down.
 */
export class CircuitBreaker extends EventEmitter {
  constructor({ failureThreshold = 3, openMs = 10_000, maxOpenMs = 30_000, now = () => Date.now(), name = 'routing' } = {}) {
    super();
    Object.assign(this, { failureThreshold, baseOpenMs: openMs, maxOpenMs, now, name });
    this.reset();
  }

  reset() {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.currentOpenMs = this.baseOpenMs;
    this.nextRetryAt = null;
    this.openedAt = null;
    this.trialInFlight = false;
    this.stats = { calls: 0, successes: 0, failures: 0, shortCircuited: 0, openCount: 0, lastError: null, lastSuccessAt: null, lastFailureAt: null };
  }

  #to(to, reason) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.emit('transition', { name: this.name, from, to, reason, at: this.now() });
  }

  #open(reason) {
    this.openedAt = this.now();
    this.nextRetryAt = this.openedAt + this.currentOpenMs;
    this.stats.openCount += 1;
    this.#to('open', reason);
  }

  async call(fn) {
    if (this.state === 'open') {
      if (this.now() >= this.nextRetryAt) this.#to('half_open', 'cool-down over');
      else { this.stats.shortCircuited += 1; throw new CircuitOpenError(this.nextRetryAt - this.now()); }
    }
    let trial = false;
    if (this.state === 'half_open') {
      if (this.trialInFlight) { this.stats.shortCircuited += 1; throw new CircuitOpenError(0); } // one probe at a time
      this.trialInFlight = true; trial = true;
    }
    this.stats.calls += 1;
    try {
      const r = await fn();
      this.#success();
      return r;
    } catch (err) {
      this.#failure(err);
      throw err;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }

  #success() {
    this.stats.successes += 1; this.stats.lastSuccessAt = this.now();
    if (this.state === 'half_open') { this.currentOpenMs = this.baseOpenMs; this.consecutiveFailures = 0; this.#to('closed', 'trial call succeeded'); }
    else if (this.state === 'closed') this.consecutiveFailures = 0;
    // a late success while open changes nothing
  }

  #failure(err) {
    this.stats.failures += 1; this.stats.lastFailureAt = this.now();
    this.stats.lastError = { kind: err?.kind ?? 'error', status: err?.status ?? null, message: String(err?.message ?? err).slice(0, 120), at: this.now() };
    if (this.state === 'half_open') {
      this.currentOpenMs = Math.min(this.maxOpenMs, this.currentOpenMs * 2);
      this.#open('trial call failed');
    } else if (this.state === 'closed') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) this.#open(`${this.consecutiveFailures} consecutive failures`);
    }
    // a late failure while open is only counted
  }

  /** Demo/ops helper: end the cool-down now, so the very next call is the trial request. */
  allowProbeNow() {
    if (this.state === 'open') this.nextRetryAt = this.now();
  }

  status() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      retryInMs: this.state === 'open' ? Math.max(0, this.nextRetryAt - this.now()) : 0,
      openedAt: this.openedAt,
      ...this.stats,
    };
  }
}

/** Small LRU + TTL cache for last known good routes. */
export class RouteCache {
  constructor({ max = 500, ttlMs = 15 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { max, ttlMs, now });
    this.map = new Map();
  }

  get size() { return this.map.size; }
  clear() { this.map.clear(); }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); // evict least recently used
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    const ageMs = this.now() - e.at;
    if (ageMs > this.ttlMs) { this.map.delete(key); return null; }
    this.map.delete(key); this.map.set(key, e); // refresh recency
    return { value: e.value, ageMs };
  }
}
