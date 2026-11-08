// Cleans up route geometry so it reads like a real network:
//   1. Land routes that run over the sea or through a lake are moved back onto the nearest shore,
//      keeping to one side of the water for each stretch (so a road follows the coast or lakeshore).
//   2. Route ends that stop just short of another route or ring are snapped onto it.
// Bridges, ferries, rivers, lakes and the border are left exactly as drawn.
//
//   node tools/build-data.mjs --raw     # plan.geojson from the original drawing
//   node tools/fix-geometry.mjs         # writes source/geometry-fixes.json + docs/geometry-fixes.md
//   node tools/build-data.mjs           # rebuilds with the fixes applied
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { preload, elevation } from './dem.mjs';
import { LAND_CATS, SEA_LEVEL, densify, nearestOnLine, pointInRing, haversine, kx, KY, r5 } from './geo.mjs';
import { onLand, landId } from './coast.mjs';

const plan = JSON.parse(readFileSync(new URL('../data/plan.geojson', import.meta.url)));
// Mapped lakes and bays. Shallow bays read as land in the elevation model, so their outlines are used too.
const lakes = plan.features.filter((f) => f.geometry.type === 'Polygon' && f.properties.category === 'water').map((f) => f.geometry.coordinates[0]);
const land = plan.features.filter((f) => f.geometry.type === 'LineString' && LAND_CATS.includes(f.properties.category) && !f.properties.derived);

await preload(land.flatMap((f) => f.geometry.coordinates), 8);

const LAND_MIN = 1; // metres above sea level that counts as safely dry when moving a point
const INLAND = 0.12; // km to stay back from the shoreline
const inLake = (p) => lakes.some((r) => pointInRing(p, r));
// "Wet" = clearly below sea level in the elevation model, inside a mapped lake, or outside the OpenStreetMap
// coastline (shallow bays like Jacmel's read as about 0 m in the elevation model, so the coastline catches them).
// Flat coastal plains read as about 0 m, so the sea threshold sits a little below that.
// The coastline test can be switched off, so each route can be fixed both ways and the better result kept.
let useCoast = true;
// The island(s) the route being fixed was drawn on; land on any other island (or islet) does not count as dry.
let home = null;
const isWater = (p) => !(elevation(p[0], p[1]) >= SEA_LEVEL) || inLake(p) || (useCoast && !onLand(p));
const isDry = (p) => elevation(p[0], p[1]) >= LAND_MIN && !inLake(p) && (!useCoast || (onLand(p) && (!home || home.has(landId(p)))));
const offset = (p, dxKm, dyKm) => [p[0] + dxKm / kx(p[1]), p[1] + dyKm / KY];

// Nearest dry point to p, searching only directions within ±75° of `prefer` (unit vector) when given.
function nearestLand(p, prefer) {
  for (let r = 0.04; r <= 8; r += r < 1 ? 0.04 : 0.1) {
    let best = null;
    const n = Math.max(16, Math.round(r * 40));
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      const v = [Math.cos(a), Math.sin(a)];
      if (prefer && v[0] * prefer[0] + v[1] * prefer[1] < 0.26) continue;
      const q = offset(p, v[0] * r, v[1] * r);
      if (isDry(q)) {
        const score = prefer ? -(v[0] * prefer[0] + v[1] * prefer[1]) : 0;
        if (!best || score < best.score) best = { q, v, score };
      }
    }
    if (best) {
      // Step a little further inland when that is still dry.
      const deeper = offset(best.q, best.v[0] * INLAND, best.v[1] * INLAND);
      return isDry(deeper) ? deeper : best.q;
    }
  }
  return null;
}

// Which side of a water stretch to follow: the side with land closest to the stretch's middle.
function sideFor(run) {
  const a = run[0], b = run.at(-1);
  const dx = (b[0] - a[0]) * kx(a[1]), dy = (b[1] - a[1]) * KY;
  const len = Math.hypot(dx, dy) || 1;
  const normal = [-dy / len, dx / len];
  const mid = run[Math.floor(run.length / 2)];
  const dist = (sign) => {
    for (let r = 0.04; r <= 8; r += 0.04) if (isDry(offset(mid, normal[0] * r * sign, normal[1] * r * sign))) return r;
    return Infinity;
  };
  if (len < 0.05) return null;
  return dist(1) <= dist(-1) ? normal : [-normal[0], -normal[1]];
}

function fixWater(coords, closed) {
  let pts = densify(coords, 0.08);
  let moved = 0;
  for (let pass = 0; pass < 6; pass++) {
    if (pass) pts = densify(pts, 0.08);
    const wet = pts.map(isWater);
    if (!wet.some(Boolean)) break;
    let i = 0;
    while (i < pts.length) {
      if (!wet[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < pts.length && wet[j + 1]) j++;
      const run = pts.slice(Math.max(0, i - 1), Math.min(pts.length, j + 2));
      const side = sideFor(run);
      for (let k = i; k <= j; k++) {
        const q = nearestLand(pts[k], side) ?? nearestLand(pts[k], null);
        if (q) {
          pts[k] = q;
          moved++;
        }
      }
      i = j + 1;
    }
    // Light smoothing so shoreline points don't zigzag; ends stay put.
    const sm = pts.map((p, k) => {
      if ((!closed && (k === 0 || k === pts.length - 1)) || k === 0 || k === pts.length - 1) return p;
      const a = pts[k - 1], b = pts[k + 1];
      const q = [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
      return isWater(q) ? p : q;
    });
    pts = sm;
  }
  if (closed) pts[pts.length - 1] = pts[0];
  return { coords: simplifyDry(pts, 0.025), moved };
}

// Douglas–Peucker that never lets a shortcut cut back across water.
function simplifyDry(coords, tol) {
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    let max = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = nearestOnLine(coords[i], [coords[a], coords[b]]).d;
      if (d > max) [max, idx] = [d, i];
    }
    if (max > tol || wetKm([coords[a], coords[b]]) > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

// Rings keep their compact shape: wet parts are pulled in toward the town centre until dry,
// so a coastal Périphérique becomes a "D" along the shore instead of looping around the bay.
// The town a ring is drawn around (its centre is in the sea when the ring loops over a bay, e.g. Miragoâne).
const towns = plan.features.filter((f) => f.geometry.type === 'Point' && ['city', 'town'].includes(f.properties.category)).map((f) => f.geometry.coordinates);
function fixRing(coords) {
  const n = coords.length - 1;
  let center = [coords.slice(0, n).reduce((s, p) => s + p[0], 0) / n, coords.slice(0, n).reduce((s, p) => s + p[1], 0) / n];
  if (isWater(center)) {
    const inside = towns.filter((t) => pointInRing(t, coords) && !isWater(t)).sort((a, b) => haversine(a, center) - haversine(b, center));
    if (inside[0]) center = inside[0];
  }
  const pts = densify(coords, 0.08).map((p) => {
    if (!isWater(p)) return p;
    for (let t = 0.97; t >= 0.05; t -= 0.03) {
      const q = [center[0] + (p[0] - center[0]) * t, center[1] + (p[1] - center[1]) * t];
      if (isDry(q)) {
        const q2 = [center[0] + (p[0] - center[0]) * (t - 0.04), center[1] + (p[1] - center[1]) * (t - 0.04)];
        return isDry(q2) ? q2 : q;
      }
    }
    return nearestLand(p, null) ?? p;
  });
  pts[pts.length - 1] = pts[0];
  return simplifyDry(pts, 0.02);
}

// Remove needle-like spikes (left where a point was pushed onto a narrow headland), then round
// the corners with Chaikin smoothing. Every change is kept only if the line stays dry.
function angleAt(a, p, b) {
  const sx = kx(p[1]);
  const v1 = [(a[0] - p[0]) * sx, (a[1] - p[1]) * KY], v2 = [(b[0] - p[0]) * sx, (b[1] - p[1]) * KY];
  const c = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}
function tidy(coords, closed) {
  let pts = coords.slice();
  for (let changed = true, guard = 0; changed && guard < 200; guard++) {
    changed = false;
    for (let i = 1; i < pts.length - 1; i++) {
      if (angleAt(pts[i - 1], pts[i], pts[i + 1]) < 50 && wetKm([pts[i - 1], pts[i + 1]]) === 0) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  for (let it = 0; it < 2; it++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    out.push(pts.at(-1));
    if (closed) out[out.length - 1] = out[0];
    if (wetKm(out) <= wetKm(pts) + 0.01) pts = out;
  }
  return simplifyDry(pts, 0.012);
}

const wetKm = (coords) => {
  const pts = densify(coords, 0.1);
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    const mid = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
    if (isWater(mid)) km += haversine(pts[i - 1], pts[i]);
  }
  return km;
};

// ---- 1. Water
const fixed = new Map(); // id -> coords
const report = [];
const lineKm = (c) => c.slice(1).reduce((s, p, i) => s + haversine(c[i], p), 0);
for (const f of land) {
  const c = f.geometry.coordinates;
  const closed = f.properties.category === 'ring';
  const run = () => tidy(closed ? fixWater(fixRing(c), true).coords : fixWater(c, false).coords, closed);
  // 1. Elevation-only fix (sea well below 0 m, lakes) — the long-standing method.
  useCoast = false;
  const elevBefore = wetKm(c);
  const plain = elevBefore >= 0.05 ? run() : c;
  // 2. Coastline-aware fix, which also catches shallow bays. Kept only when it is clearly better:
  //    less water by the coastline and no big detour (mangrove shores can make it scribble).
  useCoast = true;
  home = new Set(densify(c, 0.2).map(landId).filter((x) => x != null));
  const before = wetKm(c);
  if (before < 0.05) continue;
  const plainWet = wetKm(plain);
  // For rings, also try only pulling the wet parts toward the town (no shoreline search), which stays clean
  // around bays full of small mangrove islets; keep the drier of the two.
  let coast = run();
  let coastWet = wetKm(coast);
  if (closed) {
    const pulled = tidy(fixRing(c), true);
    const pulledWet = wetKm(pulled);
    if (pulledWet < coastWet || lineKm(coast) > lineKm(plain) * 1.15 + 0.3) [coast, coastWet] = [pulled, pulledWet];
  }
  // …and it must stay on the island(s) it was drawn on: never jump across a channel (e.g. onto La Tortue).
  const strays = densify(coast, 0.2).some((q) => { const id = landId(q); return id != null && !home.has(id); });
  const better = coastWet < plainWet - 0.05 && lineKm(coast) <= lineKm(plain) * 1.15 + 0.3 && !strays;
  if (process.env.DEBUG_FIX && f.properties.name.includes(process.env.DEBUG_FIX)) console.log("DEBUG", f.properties.name, { plainWet, coastWet, plainKm: lineKm(plain), coastKm: lineKm(coast), strays, home: [...home] });
  const coords = better ? coast : plain;
  if (coords === c) continue;
  const after = better ? coastWet : plainWet;
  fixed.set(f.properties.id, coords);
  report.push({ id: f.properties.id, name: f.properties.name, cat: f.properties.category, tier: f.properties.tier, water: [before, after] });
}

home = null;

// ---- 2. Loose ends: snap to the nearest other route or ring within reach.
const geom = (f) => fixed.get(f.properties.id) ?? f.geometry.coordinates;
// Bridges and ferries that stop in open water (e.g. the Tortue ferry, drawn ending mid-channel) are extended
// to the nearest shore, so their terminals sit on land.
const landings = [];
for (const f of plan.features.filter((x) => x.geometry.type === 'LineString' && ['bridge', 'ferry'].includes(x.properties.category))) {
  const c = [...geom(f)];
  let changed = false;
  for (const end of [c.length - 1, 0]) {
    if (!isWater(c[end])) continue;
    const q = nearestLand(c[end], null);
    if (!q || haversine(q, c[end]) > 6) continue;
    landings.push({ name: f.properties.name, km: haversine(q, c[end]) });
    if (end === 0) c.unshift(q);
    else c.push(q);
    changed = true;
  }
  if (changed) fixed.set(f.properties.id, c);
}
if (landings.length) console.log('crossings extended to shore:', landings.map((l) => `${l.name} (${l.km.toFixed(1)} km)`).join('; '));
const targets = plan.features.filter((f) => f.geometry.type === 'LineString' && !['water', 'border'].includes(f.properties.category) && !f.properties.derived);
const SNAP_MAX = 2; // km: further than this, the end is a real terminus (a village, a border post)
const SNAP_MIN = 0.03;
const snaps = [];
// Two passes: a route's end can move after a neighbour that was snapped onto it moves too.
const crossings = plan.features.filter((f) => f.geometry.type === 'LineString' && ['bridge', 'ferry'].includes(f.properties.category));
for (let pass = 0; pass < 2; pass++) for (const f of [...land, ...crossings]) {
  if (f.properties.category === 'ring') continue;
  const overWater = ['bridge', 'ferry'].includes(f.properties.category);
  const c = [...geom(f)];
  let changed = false;
  // The far end first: adding a connector at the start shifts every index after it.
  for (const end of [c.length - 1, 0]) {
    let best = null;
    for (const o of targets) {
      if (o === f || (overWater && ['bridge', 'ferry'].includes(o.properties.category))) continue;
      const n = nearestOnLine(c[end], geom(o));
      // Prefer a Périphérique when one is close: trunks end on the ring, not inside the city.
      const bias = o.properties.category === 'ring' ? 0.4 : 0;
      if (n.d - bias < (best ? best.d - best.bias : Infinity)) best = { ...n, bias, to: o.properties.name };
    }
    // Bridges and ferries cross water by design, so only their landing point has to be dry.
    if (best && best.d > SNAP_MIN && best.d <= SNAP_MAX && !isWater(best.pt) && (overWater || wetKm([c[end], best.pt]) < 0.05)) {
      // Short gaps: move the end onto the other route. Longer ones: keep the original end (often a town)
      // and add a connector from it to the network.
      if (best.d < 0.4) c[end] = best.pt;
      else if (end === 0) c.unshift(best.pt);
      else c.push(best.pt);
      changed = true;
      snaps.push({ id: f.properties.id, name: f.properties.name, end: end ? 'end' : 'start', km: best.d, to: best.to });
    }
  }
  if (changed) fixed.set(f.properties.id, c.map(r5));
}

for (const [id, c] of fixed) fixed.set(id, c.map(r5));
writeFileSync(new URL('../source/geometry-fixes.json', import.meta.url), JSON.stringify(Object.fromEntries(fixed)));

// ---- Report
mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
const km = (v) => `${v.toFixed(1)} km`;
const totBefore = report.reduce((s, r) => s + r.water[0], 0);
const totAfter = report.reduce((s, r) => s + r.water[1], 0);
const md = [
  '# Geometry fixes',
  '',
  'Generated by `tools/fix-geometry.mjs`. The original drawing is unchanged in `source/haitiProjectSpecs.js`; the corrected shapes are in `source/geometry-fixes.json` and are applied by `tools/build-data.mjs`.',
  '',
  `- Routes moved off the water: **${report.length}** (over water before: ${km(totBefore)}, after: ${km(totAfter)})`,
  `- Route ends connected to the network: **${snaps.length}**`,
  '',
  '## Routes moved back onto land',
  '',
  '| Route | Type | Over water before | After |',
  '| :-- | :-- | --: | --: |',
  ...report.sort((a, b) => b.water[0] - a.water[0]).map((r) => `| ${r.name} | ${r.cat} (${r.tier}) | ${km(r.water[0])} | ${km(r.water[1])} |`),
  '',
  '## Route ends snapped to the network',
  '',
  '| Route | End | Gap closed | Joined to |',
  '| :-- | :-- | --: | :-- |',
  ...snaps.sort((a, b) => b.km - a.km).map((s) => `| ${s.name} | ${s.end} | ${(s.km * 1000).toFixed(0)} m | ${s.to} |`),
  '',
];
writeFileSync(new URL('../docs/geometry-fixes.md', import.meta.url), md.join('\n'));
console.log(`moved off water: ${report.length} routes (${km(totBefore)} → ${km(totAfter)}); ends snapped: ${snaps.length}`);
for (const r of report.filter((r) => r.water[1] > 0.1)) console.log('  still wet:', r.name, km(r.water[1]));
