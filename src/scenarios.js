// Named demo scenarios for the dispatcher "Scenarios" panel. They drive the REAL pipeline
// (addSos -> abuse guard -> crisis rules), nothing is faked at the dashboard level.
import { AppError } from './errors.js';

export const SCENARIO_NAMES = ['cluster', 'fake_flood', 'mass_event', 'filling', 'overcrowd', 'api_outage', 'road_block', 'reset'];

// tiny deterministic PRNG so a scenario looks the same every run
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const jitter = (r, m) => (r() - 0.5) * 2 * m; // metres -> degrees below (approx)
const DEG = 1 / 111_000;
const TYPES = ['FIRE', 'COLLAPSE', 'FLOOD', 'MEDICAL'];

export function runScenario(name, { store, graph, resetAll }) {
  if (!SCENARIO_NAMES.includes(name)) throw new AppError(404, 'SCENARIO_NOT_FOUND');
  const r = rng(Date.now() & 0xffff);
  const now = store.now();
  const district = (id) => store.districts.find((d) => d.id === id);

  switch (name) {
    case 'cluster': {
      const d = district('nasimi');
      for (let i = 0; i < 4; i++) {
        store.addSos(
          { citizenId: `sim-cluster-${now}-${i}`, type: TYPES[i % 4], lat: d.lat + jitter(r, 120) * DEG, lng: d.lng + jitter(r, 120) * DEG, accuracy: 12 },
          { ip: `198.51.100.${10 + i}`, deviceId: `sim-cluster-${now}-${i}`, verified: true },
        );
      }
      return { name, count: 4 };
    }
    case 'fake_flood': {
      const d = district('xatai');
      for (let i = 0; i < 40; i++) {
        store.addSos(
          { citizenId: `sim-bot-${now}-${i}`, type: 'FIRE', lat: d.lat + jitter(r, 150) * DEG, lng: d.lng + jitter(r, 150) * DEG, accuracy: 10 },
          { ip: '203.0.113.66', deviceId: `sim-bot-${now}-${i}`, verified: false },
        );
      }
      return { name, count: 40 };
    }
    case 'mass_event': {
      for (let i = 0; i < 40; i++) {
        const d = store.districts[i % 4]; // spread over the first four districts
        store.addSos(
          { citizenId: `sim-crowd-${now}-${i}`, type: TYPES[Math.floor(r() * 4)], lat: d.lat + jitter(r, 250) * DEG, lng: d.lng + jitter(r, 250) * DEG, accuracy: 20 },
          { ip: `198.51.${100 + (i % 20)}.${20 + i}`, deviceId: `sim-crowd-${now}-${i}`, verified: true },
        );
      }
      return { name, count: 40 };
    }
    case 'filling': {
      const p = store.getPoint('p3');
      const target = Math.round(p.capacity * 0.7);
      const rate = p.capacity * 0.07; // +7 % of capacity per minute
      for (let i = 4; i >= 1; i--) store.recordOccupancy(p.id, Math.max(0, Math.round(target - rate * i)), now - i * 60_000);
      store.setOccupancy(p.id, target); // triggers the forecast
      return { name, pointId: p.id };
    }
    case 'overcrowd': {
      const p = store.getPoint('p1');
      store.setOccupancy(p.id, Math.round(p.capacity * 0.96));
      return { name, pointId: p.id };
    }
    case 'api_outage':
      store.chaos.externalDown = true;
      store.chaos.externalLatencyMs = 0;
      store.emit('change', 'chaos');
      return { name };
    case 'road_block': {
      const edges = graph.adj.get('nasimi') ?? [];
      for (const id of edges.slice(0, 2)) graph.setClosed(id, true);
      store.emit('change', 'road');
      return { name, closed: edges.slice(0, 2) };
    }
    case 'reset':
      resetAll();
      return { name };
    default:
      throw new AppError(404, 'SCENARIO_NOT_FOUND');
  }
}
