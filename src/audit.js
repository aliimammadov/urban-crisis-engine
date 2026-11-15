// Decision journal: who decided what, when. Human decisions + system alert events.
// Deliberately holds NO IPs, tokens or citizen identifiers (it is shown on the dispatcher panel).
export class Audit {
  constructor({ now = () => Date.now(), max = 1000 } = {}) {
    this.now = now;
    this.max = max;
    this.items = [];
    this.seq = 0;
  }

  record({ actor, action, target = null, details = {} }) {
    const entry = { id: ++this.seq, t: this.now(), actor, action, target, details };
    this.items.push(entry);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return entry;
  }

  /** Newest first. */
  recent(limit = 20) {
    const n = Math.max(1, Math.min(Number(limit) || 20, 200));
    return this.items.slice(-n).reverse();
  }

  clear() { this.items = []; }
}
