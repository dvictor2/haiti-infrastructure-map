// Hand-picked redraws of routes found wrong in the route review (review/NOTES.md, Nov 2026).
// Each route keeps its two connecting ends and follows today's road corridor through the listed towns
// (OSRM / OpenStreetMap, FOSSGIS public server), smoothed so it reads as a rail + highway line, not every bend.
//   #7  Saint-Marc – PAP:       no loop out to the Saint-Marc headland; follows the coast road (RN1).
//   #10 Port-Salut – Les Cayes: starts in Port-Salut itself (it began 12.8 km away on the cape); low road by Torbeck.
//   #41 Hinche – Cap-Haïtien:   by Pignon, Saint-Raphaël and the Grande Rivière du Nord valley, east of the Citadelle national park.
// Cap-Haïtien airport (Nov 2026): the ring (#54), the airport loop (#279) and #41 crossed runway 05/23 and the
// Porte Hinche station (#312) sat inside the airport fence. Each is redrawn to keep 100 m outside the fence
// (OpenStreetMap outline in source/cap-haitien-airport.json), going round the airport's north end; #41 now
// ends on the ring east of the airport; the build then gives it one shared station with #38 (Porte Fort-Liberté / Hinche).
// Knock-on changes: #4 now ends in Port-Salut (its last 12 km ran on to the empty cape only to meet the old #10),
// and the Côte des Arcadins feeder (#106) is joined onto the new #7.
// Run: node tools/redraw-routes.mjs  →  source/route-redraws.json  (then node tools/build-data.mjs and the rest)
import { readFileSync, writeFileSync } from 'node:fs';
import { simplify, r5, haversine, pointInRing, kx, KY, densify, nearestOnLine, distToLine } from './geo.mjs';
import { onLand } from './coast.mjs';
import { createDem } from './dem.mjs';

const plan = JSON.parse(readFileSync(new URL('../data/plan.geojson', import.meta.url)));
const line = (id) => plan.features.find((f) => f.properties.id === id).geometry.coordinates;
const pin = (n) => plan.features.find((f) => f.geometry.type === 'Point' && f.properties.name === n).geometry.coordinates;

const dev = JSON.parse(readFileSync(new URL('../data/dev.geojson', import.meta.url)));
const airport = JSON.parse(readFileSync(new URL('../source/cap-haitien-airport.json', import.meta.url)));
const FENCE = [airport.fence];
const FENCE_GAP = 0.1; // km to keep clear of the airport fence
const citadelle = dev.features.find((f) => /Citadelle/.test(f.properties.name)).geometry.coordinates;

const dem = createDem(12);

// Replace the stretch of a line that comes within FENCE_GAP of the airport with a path round the fence.
const nearFence = (p) => pointInRing(p, airport.fence) || distToLine(p, airport.fence) < FENCE_GAP;
async function clearAirport(c) {
  // Prefer rejoining well clear of the fence; fall back to closer if no clear path exists that way.
  for (const rejoin of [0.4, 0.2]) {
    try { return await clearAirportAt(c, rejoin); } catch (e) { if (rejoin === 0.2) throw e; }
  }
}
async function clearAirportAt(c, rejoin) {
  const bad = c.slice(1).map((p, i) => densify([c[i], p], 0.02).some(nearFence));
  let a = bad.indexOf(true), b = bad.lastIndexOf(true) + 1;
  if (a < 0) return c; // already clear
  // Start the detour a little further out so it can curve round instead of hooking back.
  const roomy = (p) => !pointInRing(p, airport.fence) && distToLine(p, airport.fence) >= 0.3;
  while (a > 0 && !roomy(c[a])) a--;
  // Rejoin well clear of the fence, so the line carries straight on instead of dipping back towards it.
  while (b < c.length - 1 && (pointInRing(c[b], airport.fence) || distToLine(c[b], airport.fence) < rejoin)) b++;
  const round = await low([c[a], c[b]], FENCE, 400, FENCE_GAP);
  return [...c.slice(0, a), ...smoothClear(round), ...c.slice(b + 1)].map(r5);
}
// Grid paths come out stepped: straighten them as much as possible, then round the corners (Chaikin),
// as long as the result still keeps clear of the fence.
const clear = (l) => densify(l, 0.02).every((p) => !nearFence(p));
function chaikin(l) {
  const o = [l[0]];
  for (let i = 0; i < l.length - 1; i++) {
    const [p, q] = [l[i], l[i + 1]];
    o.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
  }
  o.push(l.at(-1));
  return o;
}
function smoothClear(path) {
  let best = path;
  for (const tol of [0.15, 0.1, 0.06, 0.03]) {
    const s = simplify(path, tol);
    if (clear(s)) { best = s; break; }
  }
  for (let k = 0; k < 3; k++) {
    const s = chaikin(best);
    if (!clear(s)) break;
    best = s;
  }
  return best;
}
// Start from the shape before any redraw (automatic fix if there is one, else the original drawing), so a re-run
// gives the same result.
const FIXES = JSON.parse(readFileSync(new URL('../source/geometry-fixes.json', import.meta.url)));
const { HAITI_PROJECT_SPECS } = await import('../source/haitiProjectSpecs.js');
const orig = (id) => FIXES[id] ?? HAITI_PROJECT_SPECS[id - 1].path.map(r5);
// The ring crossed the airport out to a hairpin at its east end and came back along the coast just north of it.
// Close the ring on the airport's north-west side instead: from the last point before the crossing, straight to
// the first point of the coastal return that is well clear of the airport, dropping the hairpin.
const TIP = airport.fence.reduce((m, p) => (p[1] > m[1] ? p : m)); // the fence's northern tip
function closeRing(c) {
  const bad = c.slice(1).map((p, i) => densify([c[i], p], 0.02).some(nearFence));
  let a = bad.indexOf(true);
  if (a < 0) return null;
  const roomy = (p) => !pointInRing(p, airport.fence) && distToLine(p, airport.fence) >= 0.3;
  while (a > 0 && !roomy(c[a])) a--;
  let e = bad.lastIndexOf(true) + 1;
  while (e < c.length - 1 && !(roomy(c[e]) && c[e][0] < TIP[0] - 0.004)) e++;
  return { a, e };
}
let ring54;
{
  const c = orig(54);
  const cut = closeRing(c);
  const path = await low([c[cut.a], c[cut.e]], FENCE, 400, FENCE_GAP);
  ring54 = [...c.slice(0, cut.a), ...smoothClear(path), ...c.slice(cut.e + 1)].map(r5);
}
const loop279 = await clearAirport(orig(279));
// The shared Porte for #41 (Hinche) and #38 (Fort-Liberté): the ring point nearest the airport's north tip, by the
// terminal. Both lines come round the tip, outside the fence, to reach it.
const CAP_STATION = r5(nearestOnLine(TIP, ring54).pt);
// Both trunks share one path round the tip, to a junction east of the airport, then split.
const JUNCTION = [TIP[0] + 0.006, TIP[1] - 0.003];
const SHARED = smoothClear(await low([CAP_STATION, JUNCTION], FENCE, 400, FENCE_GAP)).map(r5);

// Each route is a list of pieces: { road: [towns…] } follows today's road; { low: [a, b], avoid } takes the
// lowest, gentlest path over the ground (where no road fits), keeping out of the `avoid` areas.
const REDRAW = {
  // Road to the Cabaret plain, then straight down the plain to the end (the road swings east over the Rivière Grise twice).
  7: [{ road: [line(7)[0], [-72.30004, 18.66818]] }, { low: [[-72.30004, 18.66818], line(7).at(-1)] }],
  10: [{ low: [pin('Port-Salut'), line(10).at(-1)], steep: 150 }],
  41: [
    { road: [line(41)[0], pin('Pignon'), pin('Saint-Raphaël')] },
    { low: [pin('Saint-Raphaël'), pin('Grande-Rivière-du-Nord')], avoid: citadelle },
    { low: [pin('Grande-Rivière-du-Nord'), JUNCTION], avoid: [...citadelle, ...FENCE], gap: FENCE_GAP },
    { fixed: [...SHARED].reverse() },
  ],
};
// Smoothing drops road bends smaller than about 250 m, less where that would cut across a bay.
const TOLS = [0.25, 0.12, 0.06, 0.03, 0];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function road(via) {
  const q = via.map((p) => p.map((v) => v.toFixed(5)).join(',')).join(';');
  const url = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${q}?overview=full&geometries=geojson`;
  const j = await (await fetch(url, { headers: { 'User-Agent': 'haiti-infrastructure-map build script' } })).json();
  if (j.code !== 'Ok') throw new Error(j.code);
  await wait(1100);
  const c = j.routes[0].geometry.coordinates;
  c[0] = via[0];
  c[c.length - 1] = via.at(-1);
  return c;
}

// Lowest-cost path on a 150 m grid: distance, plus a heavy charge for every metre climbed or dropped
// (a train wants under ~3%), never into the sea or an `avoid` area.
async function low([a, b], avoid, steep = 400, gap = 0) {
  const STEP = 0.15, PAD = 5;
  const lat0 = (a[1] + b[1]) / 2;
  const dx = STEP / kx(lat0), dy = STEP / KY;
  const x0 = Math.min(a[0], b[0]) - PAD / kx(lat0), y0 = Math.min(a[1], b[1]) - PAD / KY;
  const W = Math.ceil((Math.max(a[0], b[0]) + PAD / kx(lat0) - x0) / dx), H = Math.ceil((Math.max(a[1], b[1]) + PAD / KY - y0) / dy);
  const at = (i) => [x0 + (i % W) * dx, y0 + Math.floor(i / W) * dy];
  await dem.preload(Array.from({ length: Math.ceil(W / 20) * Math.ceil(H / 20) }, (_, k) => at((Math.floor(k / Math.ceil(W / 20)) * 20) * W + (k % Math.ceil(W / 20)) * 20)), 3);
  const elev = new Float32Array(W * H), bad = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const p = at(i);
    elev[i] = dem.elevation(...p);
    bad[i] = !(elev[i] >= 1) || (avoid && avoid.some((r) => pointInRing(p, r) || (gap && distToLine(p, r) < gap))) ? 1 : 0;
  }
  const cell = (p) => Math.round((p[1] - y0) / dy) * W + Math.round((p[0] - x0) / dx);
  const s = cell(a), t = cell(b);
  bad[s] = bad[t] = 0;
  const cost = new Float64Array(W * H).fill(Infinity), prev = new Int32Array(W * H).fill(-1);
  const heap = [[0, s]];
  cost[s] = 0;
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.length) {
    const [c, i] = pop();
    if (i === t) break;
    if (c > cost[i]) continue;
    const x = i % W, y = Math.floor(i / W);
    for (const [ox, oy] of NB) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (bad[j]) continue;
      const d = STEP * Math.hypot(ox, oy);
      const grade = Math.abs(elev[j] - elev[i]) / (d * 1000);
      const nc = c + d * (1 + 40 * grade + (grade > 0.03 ? steep * (grade - 0.03) : 0));
      if (nc < cost[j]) { cost[j] = nc; prev[j] = i; push([nc, j]); }
    }
  }
  if (prev[t] < 0) throw new Error('no low path');
  const path = [];
  for (let i = t; i >= 0; i = prev[i]) path.push(at(i));
  path.reverse();
  path[0] = a;
  path[path.length - 1] = b;
  return path;
}

const out = {};
for (const [id, pieces] of Object.entries(REDRAW)) {
  let c = [];
  let tail = null; // a fixed last piece is attached unchanged after smoothing
  for (const pc of pieces) {
    if (pc.fixed) { tail = pc.fixed; continue; }
    const part = pc.road ? await road(pc.road) : await low(pc.low, pc.avoid, pc.steep, pc.gap);
    c = c.length ? c.concat(part.slice(1)) : part;
  }
  // Today's coast road itself grazes the mapped shoreline in places; the smoothed line may be no wetter than that.
  const wetKm = async (l) => {
    const pts = densify(l, 0.05);
    await dem.preload(pts, 1);
    return pts.filter((p) => !onLand(p) || !(dem.elevation(...p) >= -1)).length * 0.05;
  };
  const allowed = (await wetKm(c)) + 0.05;
  for (const tol of TOLS) {
    out[id] = simplify(c, tol).map(r5);
    if ((await wetKm(out[id])) <= allowed) break;
  }
  if (tail) out[id] = [...out[id], ...tail.slice(1)];
  const km = out[id].slice(1).reduce((s, p, i) => s + haversine(out[id][i], p), 0);
  console.log(`#${id}: ${out[id].length} points, ${km.toFixed(1)} km`);
}
// #4 Jérémie – Port-Salut: stop in Port-Salut (the line runs cape → Port-Salut → Jérémie).
{
  const c4 = line(4), ps = pin('Port-Salut');
  const k = c4.reduce((best, p, i) => (haversine(p, ps) < haversine(c4[best], ps) ? i : best), 0);
  out[4] = [ps, ...c4.slice(k + 1)].map(r5);
}
// #106 Côte des Arcadins feeder: its far end met the old #7 loop; join it onto the new #7.
{
  const c = line(106).slice();
  c[c.length - 1] = r5(nearestOnLine(c.at(-1), out[7]).pt);
  out[106] = c;
}
out[54] = ring54;
// #38 Cap-Haïtien – Fort-Liberté starts at the same Porte and comes round the tip, outside the fence.
{
  const o = orig(38);
  const on = await low([JUNCTION, o[1]], FENCE, 400, FENCE_GAP);
  out[38] = [...SHARED, ...smoothClear(on).slice(1), ...o.slice(2)].map(r5);
}
out[279] = loop279;
console.log('#41 now ends on the ring at', CAP_STATION);
// Two local lines started on the old #41 / #38 paths near the airport; extend each to its nearest point on the new line.
for (const [id, on] of [[203, out[41]], [281, out[38]]]) {
  const c = orig(id);
  out[id] = [r5(nearestOnLine(c[0], on).pt), ...c];
}
writeFileSync(new URL('../source/route-redraws.json', import.meta.url), JSON.stringify(out));
