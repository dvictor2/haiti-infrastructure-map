// Small geometry helpers shared by the data tools (lon/lat degrees, distances in km).
export const LAND_CATS = ['corridor', 'trunk', 'ring', 'urban', 'feeder'];
export const SEA_LEVEL = -1; // metres; Terrarium ocean cells are negative (bathymetry)

const rad = (d) => (d * Math.PI) / 180;
export function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}
export const kx = (lat) => 111.32 * Math.cos(rad(lat));
export const KY = 110.57;

export function densify(coords, stepKm) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    const n = Math.max(1, Math.ceil(haversine(a, b) / stepKm));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

// Nearest point on a polyline to p, with distance (km).
export function nearestOnLine(p, coords) {
  const sx = kx(p[1]);
  let best = { d: Infinity, pt: coords[0], seg: 0 };
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p[0]) * sx, ay = (coords[i - 1][1] - p[1]) * KY;
    const bx = (coords[i][0] - p[0]) * sx, by = (coords[i][1] - p[1]) * KY;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-12)));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, pt: [coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1])], seg: i };
  }
  return best;
}
export const distToLine = (p, coords) => nearestOnLine(p, coords).d;

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Douglas–Peucker simplification with a tolerance in km.
export function simplify(coords, tolKm) {
  if (coords.length < 3) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToLine(coords[i], [coords[a], coords[b]]);
      if (d > max) [max, idx] = [d, i];
    }
    if (max > tolKm) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}
export const r5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
