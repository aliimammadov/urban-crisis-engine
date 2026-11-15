const EARTH_R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two {lat,lng} points. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function centroid(points) {
  if (!points.length) return null;
  const s = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: s.lat / points.length, lng: s.lng / points.length };
}

export function isValidCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

export function nearest(origin, items, getPos = (x) => x) {
  let best = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = haversine(origin, getPos(it));
    if (d < bestD) { bestD = d; best = it; }
  }
  return best ? { item: best, distance: bestD } : null;
}
