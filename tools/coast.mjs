// Land test from the OpenStreetMap coastline (tools/.cache/raw/coast.json, downloaded with
// tools/overpass-coast.txt). The elevation model reads shallow bays (Jacmel, Bainet…) as about sea level,
// so the coastline is the reliable way to tell sea from land along the shore.
import { existsSync, readFileSync } from 'node:fs';

const FILE = new URL('./.cache/raw/coast.json', import.meta.url);
export const hasCoast = existsSync(FILE);

// Join coastline ways that share end nodes into closed rings (Hispaniola, Gonâve, Tortue, the Cayemites…).
function rings() {
  const ways = JSON.parse(readFileSync(FILE)).elements.filter((e) => e.type === 'way' && e.geometry);
  const byStart = new Map();
  for (const w of ways) byStart.set(w.nodes[0], w);
  const used = new Set();
  const out = [];
  for (const w of ways) {
    if (used.has(w.id)) continue;
    const ids = [...w.nodes];
    const pts = w.geometry.map((g) => [g.lon, g.lat]);
    used.add(w.id);
    let guard = 0;
    while (ids.at(-1) !== ids[0] && guard++ < 100000) {
      const next = byStart.get(ids.at(-1));
      if (!next || used.has(next.id)) break;
      used.add(next.id);
      ids.push(...next.nodes.slice(1));
      pts.push(...next.geometry.slice(1).map((g) => [g.lon, g.lat]));
    }
    if (ids.at(-1) === ids[0] && pts.length > 3) out.push(pts);
  }
  return out;
}

// Edges bucketed by latitude band, so a ray-casting test only looks at nearby edges.
const BAND = 0.01;
const bands = new Map();
if (hasCoast) {
  for (const r of rings()) {
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i];
      const lo = Math.floor(Math.min(a[1], b[1]) / BAND), hi = Math.floor(Math.max(a[1], b[1]) / BAND);
      for (let k = lo; k <= hi; k++) {
        if (!bands.has(k)) bands.set(k, []);
        bands.get(k).push([a, b]);
      }
    }
  }
}

// Which island (coastline ring) a point is on: per-ring edge bands, smallest ring first.
const islands = [];
if (hasCoast) {
  for (const r of rings()) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const bandsR = new Map();
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], c = r[i];
      b[0] = Math.min(b[0], a[0]); b[1] = Math.min(b[1], a[1]); b[2] = Math.max(b[2], a[0]); b[3] = Math.max(b[3], a[1]);
      const lo = Math.floor(Math.min(a[1], c[1]) / BAND), hi = Math.floor(Math.max(a[1], c[1]) / BAND);
      for (let k = lo; k <= hi; k++) {
        if (!bandsR.has(k)) bandsR.set(k, []);
        bandsR.get(k).push([a, c]);
      }
    }
    islands.push({ b, bands: bandsR, area: (b[2] - b[0]) * (b[3] - b[1]) });
  }
  islands.sort((a, b) => a.area - b.area);
  islands.forEach((isl, i) => (isl.id = i));
}
export function landId([x, y]) {
  for (const isl of islands) {
    if (x < isl.b[0] || x > isl.b[2] || y < isl.b[1] || y > isl.b[3]) continue;
    let inside = false;
    for (const [a, c] of isl.bands.get(Math.floor(y / BAND)) ?? []) {
      if ((a[1] > y) !== (c[1] > y) && x < ((c[0] - a[0]) * (y - a[1])) / (c[1] - a[1]) + a[0]) inside = !inside;
    }
    if (inside) return isl.id;
  }
  return null;
}

// True when p is inside a coastline ring (on land). Without the coastline file, everything counts as land.
export function onLand([x, y]) {
  if (!hasCoast) return true;
  const edges = bands.get(Math.floor(y / BAND)) ?? [];
  let inside = false;
  for (const [a, b] of edges) {
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
