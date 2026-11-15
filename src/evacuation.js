import { AppError } from './errors.js';
import { haversine, isValidCoord } from './geo.js';

export const FULL_PCT = 90; // spec: reroute when assembly point is 90% full

export function pointStatus(pct) {
  if (pct >= FULL_PCT) return 'full';
  if (pct >= 75) return 'filling';
  return 'open';
}

/**
 * Recommends assembly points + evacuation route for a location.
 * If the geographically nearest point is full (>=90%) or unreachable (roads closed),
 * the next best reachable point is recommended and `rerouted` explains why.
 */
export class EvacuationService {
  constructor(store, routing, { candidates = 5 } = {}) {
    this.store = store;
    this.routing = routing;
    this.candidates = candidates;
  }

  async recommend({ lat, lng, district }) {
    let origin;
    if (isValidCoord(lat, lng)) {
      origin = { lat, lng };
    } else if (district) {
      const d = this.store.districts.find((x) => x.id === district);
      if (!d) throw new AppError(404, 'DISTRICT_NOT_FOUND');
      origin = { lat: d.lat, lng: d.lng };
    } else {
      throw new AppError(400, 'INVALID_COORDS');
    }

    const ranked = this.store
      .listPoints({ activeOnly: true })
      .map((p) => ({ p, straight: haversine(origin, p) }))
      .sort((a, b) => a.straight - b.straight)
      .slice(0, this.candidates);

    const routes = await Promise.all(ranked.map(({ p }) => this.routing.route(origin, p)));

    const points = ranked.map(({ p, straight }, i) => {
      const r = routes[i];
      const status = r.blocked ? 'unreachable' : pointStatus(p.occupancyPct);
      // proactive: with the current inflow, how full will it be when the citizen arrives?
      const rate = this.store.occupancyRate(p.id);
      const projectedPct = r.blocked || rate == null || rate <= 0 ? p.occupancyPct
        : Math.min(100, Math.round(((p.occupied + rate * r.etaMin) / p.capacity) * 1000) / 10);
      const fillingFast = !r.blocked && p.occupancyPct < FULL_PCT && projectedPct >= FULL_PCT;
      return {
        id: p.id, type: p.type, name: p.name, lat: p.lat, lng: p.lng,
        capacity: p.capacity, occupied: p.occupied, occupancyPct: p.occupancyPct, projectedPct, fillingFast,
        status, straightDistanceM: Math.round(straight),
        route: r.blocked ? null : { geometry: r.geometry, distanceM: r.distanceM, etaMin: r.etaMin, source: r.source },
      };
    });

    const usable = points.filter((p) => p.status === 'open' || p.status === 'filling');
    // points that will still have room on arrival come first, then by distance
    usable.sort((a, b) => Number(a.fillingFast) - Number(b.fillingFast) || a.route.distanceM - b.route.distanceM);
    const recommended = usable[0] ?? null;

    // Explain a reroute relative to the nearest-by-air point
    const nearestPoint = points[0] ?? null;
    let rerouted = null;
    if (nearestPoint && recommended && recommended.id !== nearestPoint.id) {
      const reasons = [];
      if (nearestPoint.status === 'full') reasons.push('POINT_FULL');
      if (nearestPoint.status === 'unreachable') reasons.push('ROAD_BLOCKED');
      if (nearestPoint.fillingFast) reasons.push('POINT_FILLING_FAST');
      rerouted = {
        fromPointId: nearestPoint.id,
        reasons: reasons.length ? reasons : ['SHORTER_ROUTE'],
      };
    }

    return {
      origin,
      recommendedPointId: recommended?.id ?? null,
      rerouted,
      noSafePoint: !recommended,
      points,
    };
  }
}
