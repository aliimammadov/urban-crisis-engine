// "Time machine": compact snapshots of the situation so a dispatcher (or a jury) can replay how it developed.
// Frames hold only what the map needs (no identifiers), are recorded on events (throttled) and by a timer.
const MAX_FRAMES = 1440;      // 2 h at one frame per 5 s
const MAX_SOS_IN_FRAME = 150; // keeps a flood from bloating memory

export class History {
  constructor(store, graph, { minGapMs = 1000, maxFrames = MAX_FRAMES } = {}) {
    this.store = store;
    this.graph = graph;
    this.minGapMs = minGapMs;
    this.maxFrames = maxFrames;
    this.frames = [];
    this.last = -Infinity;
  }

  clear() { this.frames = []; this.last = -Infinity; }

  record({ force = false } = {}) {
    const now = this.store.now();
    if (!force && now - this.last < this.minGapMs) return null;
    this.last = now;
    const s = this.store;
    const open = s.sos.filter((x) => x.status === 'open');
    const live = open.filter((x) => !x.quarantined);
    const frame = {
      t: now,
      points: [...s.points.values()].map((p) => [p.id, p.occupied, p.active ? 1 : 0]),
      sos: live.slice(-MAX_SOS_IN_FRAME).map((x) => [x.lat, x.lng, x.type]),
      sosTotal: live.length,
      quarantined: open.length - live.length,
      alerts: s.alerts.filter((a) => a.status === 'open' || a.status === 'approved').slice(-20).map((a) => [a.id, a.type, a.level, a.status]),
      brigades: [...s.brigades.values()].map((b) => { const v = s.brigadeView(b); return [b.id, b.status, Math.round(v.lat * 1e5) / 1e5, Math.round(v.lng * 1e5) / 1e5]; }),
      closed: this.graph ? [...this.graph.edges.values()].filter((e) => e.closed).map((e) => e.id) : [],
    };
    this.frames.push(frame);
    if (this.frames.length > this.maxFrames) this.frames.splice(0, this.frames.length - this.maxFrames);
    return frame;
  }

  since(minutes = 120) {
    const cutoff = this.store.now() - Math.max(1, Math.min(minutes, 240)) * 60_000;
    return this.frames.filter((f) => f.t >= cutoff);
  }
}
