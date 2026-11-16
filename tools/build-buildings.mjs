// Builds data/buildings/*.pmtiles: every mapped building in Haiti as small vector tiles for the 3D buildings layer.
//
//   node tools/build-buildings.mjs            (downloads what is missing into tools/.cache/buildings/raw, then builds)
//
// Source: Overture Maps "buildings" theme (OpenStreetMap + Google Open Buildings + Microsoft ML Buildings),
// licence ODbL / CC BY 4.0. Credit on the map: © OpenStreetMap, Overture Maps Foundation, Google, Microsoft.
// Only zoom 14 is kept (the map draws buildings from zoom 14 up and stretches these tiles beyond that).
//
// Overture's tiles carry a 36-letter id and a source list on every building, which makes one Port-au-Prince tile
// 2 MB. Here each building keeps only its outline and three small numbers:
//   h  height in decimetres. Real height or floor count where someone recorded one (almost nowhere in Haiti);
//      otherwise an ESTIMATE from the footprint's size, spread by the building's id. Screening-level.
//   c  roof colour, 0-5 (see ROOF in app.js). An estimate too: sizes and a spread, not what the roof really is.
//   m  base height in decimetres, only for building parts that start above the ground.
//   x  1 when the building stands on the painted ground of one of the 3D model places (tools/model-pads.json),
//      so the map can leave it out there.
//
// Three places a building is never drawn (the owner's rule): on a street, on water, on lone trees.
//   Streets and water come from the same Overture release ("transportation" and "base" themes, both OpenStreetMap
//   data, ODbL): an outline that reaches into a road's width, or into the sea, a lake, a river, a stream or a
//   drain, is left out. They are downloaded next to the buildings (tools/.cache/buildings/roads and /base).
//   Trees: the trust and built-up rules below drop lone machine-found outlines; up close the map also checks the
//   satellite photo under each roof (buildings3d.js).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Reader, tileId, buildArchive } from './pmtiles-lite.mjs';

const RELEASE = '2026-10-21.0';
const SRC = `https://tiles.overturemaps.org/${RELEASE}/buildings.pmtiles`;
const ROOT = new URL('..', import.meta.url).pathname;
const RAW = ROOT + 'tools/.cache/buildings/raw/', OUT = ROOT + 'data/buildings/';
const ROADS = ROOT + 'tools/.cache/buildings/roads/', BASE = ROOT + 'tools/.cache/buildings/base/';
const theme = (t) => `https://tiles.overturemaps.org/${RELEASE}/${t}.pmtiles`;
const Z = 14, N = 2 ** Z, EXTENT_M = 40075016.686;
const MAX_PART = 30e6; // bytes per file: GitHub warns above 50 MB and refuses above 100 MB

const x2lon = (x) => (x / N) * 360 - 180, y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;
const lon2x = (lon) => Math.floor(((lon + 180) / 360) * N), lat2y = (lat) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * N);
const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };

// Machine-found outlines (Google Open Buildings, Microsoft ML Buildings) include trees, rocks and crop patches taken
// for roofs. People-traced OpenStreetMap buildings are always kept. A machine-found one is kept when the machine was
// sure (Google confidence ≥ SURE), or when it stands within NEAR_M metres of a trusted building (a real village or
// town has some). Lone, unsure boxes in fields and forest are dropped.
const SURE = 0.8, NEAR_M = 60;
// 3D buildings belong to towns and villages, not to empty hills and forest: a building is kept only where at least
// MIN_NEAR other kept buildings stand in the 3×3 block of CELL_M-metre cells around it (a 300 m square), so lone
// houses and small scatters in the countryside are left to the satellite photo.
const CELL_M = 100, MIN_NEAR = 25;
const MX = 111320 * Math.cos((19 * Math.PI) / 180), MY = 110540; // metres per degree, near Haiti's middle
const density = new Map(); // cell → number of kept buildings (filled by the first pass)
const cellKey = (cx, cy) => cx * 1000003 + cy;
let firstPass = true;
// Half the width a road takes up, in metres, by its class. Foot paths, steps and cycle paths are not streets:
// in dense quarters they run between (and are mapped across) the houses, so they clear nothing.
const ROAD_HALF = { motorway: 6, trunk: 5.5, primary: 5, secondary: 4.5, tertiary: 4, residential: 3, unclassified: 3, living_street: 2.5, unknown: 2.5, service: 2, pedestrian: 2, track: 1.8 };
// Half the width of water drawn as a line, by its kind; water drawn as an area clears whatever touches it.
const WATER_HALF = { river: 7, canal: 3.5, stream: 3, drain: 2, ditch: 1.5 };
const NOT_WATER = new Set(['swimming_pool', 'fountain', 'human_made']); // small basins inside a property
const PAD_MARGIN = 8; // metres around a model place's painted ground that are also kept clear
// Is the point within `m` metres of the ring's edge?
function nearRing(ring, lon, lat, m) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][0] - lon) * kx, ay = (ring[j][1] - lat) * ky, bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(ax + t * dx, ay + t * dy) < m) return true;
  }
  return false;
}

// ---- 1. download ----------------------------------------------------------------------------------------------
async function download() {
  const depts = JSON.parse(fs.readFileSync(ROOT + 'data/departments.geojson'));
  const rings = []; for (const f of depts.features) for (const poly of f.geometry.coordinates) rings.push(poly[0]);
  const inHaiti = (x, y) => rings.some((r) => inRing(r, x, y));
  const want = [];
  for (let x = lon2x(-74.6); x <= lon2x(-71.55); x++) for (let y = lat2y(20.2); y <= lat2y(17.9); y++) {
    let hit = false; // the tile widened by 60% on every side, sampled on a grid (the department outlines are simplified)
    for (let i = 0; i <= 6 && !hit; i++) for (let j = 0; j <= 6 && !hit; j++) hit = inHaiti(x2lon(x - 0.6 + (i * 2.2) / 6), y2lat(y - 0.6 + (j * 2.2) / 6));
    if (hit) want.push([x, y]);
  }
  fs.mkdirSync(RAW, { recursive: true });
  const have = new Set(fs.readdirSync(RAW));
  if (have.has('_complete')) return;
  const todo = want.filter(([x, y]) => !have.has(`${x}-${y}.gz`));
  console.log(`tiles over Haiti: ${want.length}, to download: ${todo.length}`);
  const r = await new Reader(SRC).init();
  let i = 0, n = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < todo.length) {
      const [x, y] = todo[i++]; const e = await r.entry(tileId(Z, x, y));
      if (e) { const f = `${RAW}${x}-${y}.gz`; fs.writeFileSync(f + '.tmp', await r.tile(e)); fs.renameSync(f + '.tmp', f); }
      if (++n % 500 === 0) console.log(`  ${n} / ${todo.length}`);
    }
  }));
  fs.writeFileSync(RAW + '_complete', RELEASE);
}

// Roads (zoom 14) and water (zoom 13, the deepest that theme goes) for every tile that has buildings.
async function downloadMore() {
  const names = fs.readdirSync(RAW).filter((f) => f.endsWith('.gz')).map((f) => f.slice(0, -3).split('-').map(Number));
  for (const [dir, t, shift] of [[ROADS, 'transportation', 0], [BASE, 'base', 1]]) {
    fs.mkdirSync(dir, { recursive: true });
    const have = new Set(fs.readdirSync(dir));
    if (have.has('_complete')) continue;
    const todo = [...new Set(names.map(([x, y]) => `${x >> shift}-${y >> shift}`))].filter((k) => !have.has(k + '.gz'));
    console.log(`${t}: ${todo.length} tiles to download`);
    const r = await new Reader(theme(t)).init();
    let i = 0, n = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (i < todo.length) {
        const k = todo[i++], [x, y] = k.split('-').map(Number), e = await r.entry(tileId(Z - shift, x, y));
        const f = `${dir}${k}.gz`; fs.writeFileSync(f + '.tmp', e ? await r.tile(e) : Buffer.alloc(0)); fs.renameSync(f + '.tmp', f);
        if (++n % 500 === 0) console.log(`  ${n} / ${todo.length}`);
      }
    }));
    fs.writeFileSync(dir + '_complete', RELEASE);
  }
}

// ---- 2. vector-tile reading and writing (just what is needed) ---------------------------------------------------
function reader(buf) { return { buf, pos: 0, end: buf.length }; }
function vint(p) { let v = 0, m = 1, b; do { b = p.buf[p.pos++]; v += (b & 0x7f) * m; m *= 128; } while (b >= 0x80); return v; }
function fields(buf, fn) {
  const p = reader(buf);
  while (p.pos < p.end) {
    const key = vint(p), f = Math.floor(key / 8), w = key & 7;
    if (w === 0) fn(f, vint(p));
    else if (w === 2) { const l = vint(p); fn(f, buf.subarray(p.pos, p.pos + l)); p.pos += l; }
    else if (w === 5) { fn(f, buf.readFloatLE(p.pos)); p.pos += 4; }
    else if (w === 1) { fn(f, buf.readDoubleLE(p.pos)); p.pos += 8; }
    else throw new Error('wire type ' + w);
  }
}
function parseLayer(buf) {
  const L = { name: '', keys: [], values: [], features: [], extent: 4096 };
  fields(buf, (f, v) => {
    if (f === 1) L.name = v.toString(); else if (f === 3) L.keys.push(v.toString()); else if (f === 5) L.extent = v;
    else if (f === 4) { let val = null; fields(v, (g, x) => { val = g === 1 ? x.toString() : g === 7 ? x !== 0 : g === 6 ? (x % 2 ? -(x + 1) / 2 : x / 2) : x; }); L.values.push(val); }
    else if (f === 2) L.features.push(v);
  });
  return L;
}
function parseFeature(buf, L) {
  const F = { type: 0, geom: null, props: {} };
  fields(buf, (f, v) => {
    if (f === 3) F.type = v; else if (f === 4) F.geom = v;
    else if (f === 2) { const p = reader(v); while (p.pos < p.end) { const k = vint(p), x = vint(p); F.props[L.keys[k]] = L.values[x]; } }
  });
  return F;
}
// Area (tile units squared, outer rings minus holes) and the mean corner of the first ring.
function measure(geom) {
  const p = reader(geom); let x = 0, y = 0, sx = 0, sy = 0, area = 0, ring = [], cx = 0, cy = 0, first = true;
  const zz = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);
  const close = () => {
    if (ring.length < 3) return; let a = 0, mx = 0, my = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]; mx += ring[i][0]; my += ring[i][1]; }
    area += a / 2; if (first) { cx = mx / ring.length; cy = my / ring.length; first = false; }
  };
  while (p.pos < p.end) {
    const c = vint(p), cmd = c & 7, n = c >> 3;
    if (cmd === 7) { close(); ring = []; x = sx; y = sy; continue; }
    for (let i = 0; i < n; i++) { x += zz(vint(p)); y += zz(vint(p)); if (cmd === 1) { ring = []; sx = x; sy = y; } ring.push([x, y]); }
  }
  return { area: Math.abs(area), cx, cy };
}
// Every ring or line of a geometry as [[x, y], ...] in tile units.
function rings(geom) {
  const p = reader(geom), out = []; let x = 0, y = 0, cur = null;
  const zz = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);
  while (p.pos < p.end) {
    const c = vint(p), cmd = c & 7, n = c >> 3;
    if (cmd === 7) continue;
    for (let i = 0; i < n; i++) { x += zz(vint(p)); y += zz(vint(p)); if (cmd === 1) out.push((cur = [])); cur.push([x, y]); }
  }
  return out;
}
const readGz = (f) => { try { const b = fs.readFileSync(f); return b.length ? zlib.gunzipSync(b) : null; } catch { return null; } };
const layersOf = (buf, want) => { const out = []; if (buf) fields(buf, (f, v) => { if (f === 3) { const L = parseLayer(v); if (L.name === want) out.push(L); } }); return out; };
const boxOf = (pts) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [x, y] of pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } return [a, b, c, d]; };
// Streets and water of one building tile, in that tile's own units: lines as segments with a half-width, in a grid.
const baseCache = new Map();
function surroundings(x, y, unit) {
  const CELL = 128, grid = new Map(), areas = [];
  const add = (a, b, w) => {
    const s = { a, b, w };
    for (let i = Math.floor((Math.min(a[0], b[0]) - w) / CELL); i <= Math.floor((Math.max(a[0], b[0]) + w) / CELL); i++)
      for (let j = Math.floor((Math.min(a[1], b[1]) - w) / CELL); j <= Math.floor((Math.max(a[1], b[1]) + w) / CELL); j++) { const k = i * 4099 + j; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s); }
  };
  for (const L of layersOf(readGz(`${ROADS}${x}-${y}.gz`), 'segment')) for (const fb of L.features) {
    const F = parseFeature(fb, L), w = F.props.subtype === 'road' ? ROAD_HALF[F.props.class] : 0;
    if (F.type !== 2 || !w || !F.geom) continue;
    for (const line of rings(F.geom)) for (let i = 1; i < line.length; i++) add(line[i - 1], line[i], w / unit);
  }
  const bk = `${x >> 1}-${y >> 1}`;
  if (!baseCache.has(bk)) { if (baseCache.size > 8) baseCache.delete(baseCache.keys().next().value); baseCache.set(bk, layersOf(readGz(`${BASE}${bk}.gz`), 'water').map((L) => L.features.map((fb) => parseFeature(fb, L)).filter((F) => F.geom).map((F) => ({ type: F.type, props: F.props, rings: rings(F.geom).map((r) => r.map(([px, py]) => [px * (8192 / L.extent), py * (8192 / L.extent)])) })))); }
  const ox = (x & 1) * 4096, oy = (y & 1) * 4096;
  for (const feats of baseCache.get(bk)) for (const F of feats) {
    const local = F.rings.map((r) => r.map(([px, py]) => [px - ox, py - oy]));
    if (F.type === 2) { const w = WATER_HALF[F.props.class] ?? WATER_HALF[F.props.subtype] ?? 2; for (const line of local) for (let i = 1; i < line.length; i++) { const a = line[i - 1], b = line[i]; if (Math.max(a[0], b[0]) > -200 && Math.min(a[0], b[0]) < 4296 && Math.max(a[1], b[1]) > -200 && Math.min(a[1], b[1]) < 4296) add(a, b, w / unit); } }
    else if (F.type === 3 && !NOT_WATER.has(F.props.class) && !NOT_WATER.has(F.props.subtype)) { const box = boxOf(local.flat()); if (box[2] > -50 && box[0] < 4146 && box[3] > -50 && box[1] < 4146) areas.push({ rings: local, box }); }
  }
  return { CELL, grid, areas };
}
const ptSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]); };
const cross = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
// Does the outline reach into a street's or a stream's width, or touch a water area?
function blocked(ring, S) {
  const box = boxOf(ring), seen = new Set();
  for (let i = Math.floor(box[0] / S.CELL); i <= Math.floor(box[2] / S.CELL); i++) for (let j = Math.floor(box[1] / S.CELL); j <= Math.floor(box[3] / S.CELL); j++)
    for (const s of S.grid.get(i * 4099 + j) ?? []) {
      if (seen.has(s)) continue; seen.add(s);
      if (inRing(ring, s.a[0], s.a[1]) || inRing(ring, s.b[0], s.b[1])) return 'line';
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const p = ring[m], q = ring[k];
        if (cross(s.a, s.b, p, q) || Math.min(ptSeg(p, s.a, s.b), ptSeg(q, s.a, s.b), ptSeg(s.a, p, q), ptSeg(s.b, p, q)) < s.w) return 'line';
      }
    }
  for (const A of S.areas) {
    if (box[2] < A.box[0] || box[0] > A.box[2] || box[3] < A.box[1] || box[1] > A.box[3]) continue;
    const wet = ([px, py]) => A.rings.reduce((n, r) => n + (inRing(r, px, py) ? 1 : 0), 0) % 2 === 1; // even-odd: islands are holes
    if (ring.some(wet)) return 'area';
  }
  return null;
}

// A message under construction: small numbers collect in `n`, finished pieces in `parts`.
class Msg {
  constructor() { this.parts = []; this.n = []; }
  v(v) { while (v >= 128) { this.n.push((v % 128) | 0x80); v = Math.floor(v / 128); } this.n.push(v); return this; }
  flush() { if (this.n.length) { this.parts.push(Buffer.from(this.n)); this.n = []; } }
  bytes(field, b) { this.v(field * 8 + 2).v(b.length); this.flush(); this.parts.push(b); return this; }
  done() { this.flush(); return Buffer.concat(this.parts); }
}

// ---- 3. height and roof colour ---------------------------------------------------------------------------------
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const STOREY = 3.1;
// With no recorded height: small footprints are one-storey houses, middle ones one to three storeys, large ones
// (schools, churches, markets, sheds) a single tall storey or two. r is a steady 0-1 number from the building's id.
function guessHeight(area, r) {
  // Calm, even heights by size (no random spread): random heights made towns look jumbled.
  if (area < 150) return STOREY;
  if (area < 400) return 2 * STOREY;
  if (area < 1500) return 7;
  return 9;
}
// 0 pale concrete, 1 concrete, 2 weathered concrete, 3 sheet metal, 4 rusted sheet, 5 blue sheet
function guessRoof(area, r) {
  if (area < 60) return r < 0.3 ? 3 : r < 0.55 ? 4 : r < 0.8 ? 1 : r < 0.93 ? 2 : 5;
  if (area < 400) return r < 0.34 ? 0 : r < 0.62 ? 1 : r < 0.78 ? 2 : r < 0.89 ? 3 : r < 0.96 ? 4 : 5;
  return r < 0.4 ? 3 : r < 0.6 ? 0 : r < 0.78 ? 1 : r < 0.9 ? 5 : 2;
}

// ---- 4. one tile -----------------------------------------------------------------------------------------------
const stat = { onStreetOrStream: 0, onWater: 0, sparse: 0, dropped: 0, keptNear: 0, buildings: 0, height: 0, floors: 0, parts: 0, onPads: 0, rawBytes: 0, outBytes: 0 };
function convert(gz, x, y, pads) {
  const layers = []; fields(zlib.gunzipSync(gz), (f, v) => f === 3 && layers.push(parseLayer(v)));
  const lat = y2lat(y + 0.5), feats = [], valIndex = new Map(), vals = [];
  const val = (n) => { if (!valIndex.has(n)) { valIndex.set(n, vals.length); vals.push(n); } return valIndex.get(n); };
  let extent = 4096, around = null;
  for (const L of layers) {
    const part = L.name === 'building_part'; if (!part && L.name !== 'building') continue;
    extent = L.extent; const unit = (EXTENT_M * Math.cos((lat * Math.PI) / 180)) / N / L.extent;
    for (const fb of L.features) {
      const F = parseFeature(fb, L), P = F.props;
      if (F.type !== 3 || !F.geom || P.is_underground === true || (!part && P.has_parts === true)) continue;
      const m = measure(F.geom), area = m.area * unit * unit; if (area < 4) continue;
      // never on a street, never on water (the outline is in this tile's units, and so are its streets and water)
      around ??= surroundings(x, y, unit * (L.extent / 4096));
      const outline = rings(F.geom)[0].map(([px, py]) => [px * (4096 / L.extent), py * (4096 / L.extent)]);
      const why = blocked(outline, around);
      if (why) { stat[why === 'line' ? 'onStreetOrStream' : 'onWater']++; continue; }
      let trust = true;
      if (!part && P['@geometry_source'] && P['@geometry_source'] !== 'OpenStreetMap') {
        let conf = null;
        try { conf = JSON.parse(P.sources).find((s) => s.confidence != null)?.confidence ?? null; } catch { /* no source list */ }
        trust = conf != null && conf >= SURE;
      }
      const hsh = hash(String(P.id ?? `${x}/${y}/${feats.length}`)), r1 = (hsh & 0xffff) / 65536, r2 = (hsh >>> 16) / 65536;
      let h;
      if (typeof P.height === 'number' && P.height > 1) { h = P.height; stat.height++; }
      else if (typeof P.num_floors === 'number' && P.num_floors > 0) { h = P.num_floors * STOREY + 0.3; stat.floors++; }
      else h = part ? 6 : guessHeight(area, r1);
      const tags = [0, val(Math.round(Math.min(h, 200) * 2) * 5), 1, val(guessRoof(area, r2))];
      if (part) { stat.parts++; if (P.min_height > 0) tags.push(2, val(Math.round(P.min_height * 10))); }
      if (pads.length) {
        const lon = x2lon(x + m.cx / L.extent), la = y2lat(y + m.cy / L.extent);
        if (pads.some((p) => lon > p.box[0] && lon < p.box[2] && la > p.box[1] && la < p.box[3] && (inRing(p.ring, lon, la) || nearRing(p.ring, lon, la, PAD_MARGIN)))) { tags.push(3, val(1)); stat.onPads++; }
      }
      feats.push({ tags, geom: F.geom, trust, px: m.cx * unit, py: m.cy * unit, lon: x2lon(x + m.cx / L.extent), lat: y2lat(y + m.cy / L.extent) });
    }
  }
  // Keep unsure machine-found boxes only near a trusted building (grid lookup, NEAR_M cells).
  const grid = new Map(), key = (gx, gy) => gx * 100003 + gy;
  for (const f of feats) if (f.trust) { const k = key(Math.floor(f.px / NEAR_M), Math.floor(f.py / NEAR_M)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(f); }
  const kept = feats.filter((f) => {
    if (f.trust) return true;
    const gx = Math.floor(f.px / NEAR_M), gy = Math.floor(f.py / NEAR_M);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const o of grid.get(key(gx + i, gy + j)) ?? []) if (Math.hypot(o.px - f.px, o.py - f.py) <= NEAR_M) { stat.keptNear++; return true; }
    stat.dropped++;
    return false;
  });
  // First pass: only count where the kept buildings are. Second pass: keep those in built-up places.
  const cellOf = (f) => [Math.floor((f.lon * MX) / CELL_M), Math.floor((f.lat * MY) / CELL_M)];
  if (firstPass) {
    for (const f of kept) { const [cx, cy] = cellOf(f), k = cellKey(cx, cy); density.set(k, (density.get(k) ?? 0) + 1); }
    return null;
  }
  const built = kept.filter((f) => {
    const [cx, cy] = cellOf(f); let n = -1;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) n += density.get(cellKey(cx + i, cy + j)) ?? 0;
    if (n >= MIN_NEAR) return true;
    stat.sparse++;
    return false;
  });
  feats.length = 0; feats.push(...built); stat.buildings += built.length;
  if (!feats.length) return null;
  const layer = new Msg().v(15 * 8).v(2).bytes(1, Buffer.from('b'));
  for (const f of feats) { const t = new Msg(); f.tags.forEach((n) => t.v(n)); layer.bytes(2, new Msg().bytes(2, t.done()).v(3 * 8).v(3).bytes(4, f.geom).done()); }
  for (const k of ['h', 'c', 'm', 'x']) layer.bytes(3, Buffer.from(k));
  for (const v of vals) layer.bytes(4, new Msg().v(5 * 8).v(v).done());
  layer.v(5 * 8).v(extent);
  const tile = new Msg().bytes(3, layer.done()).done();
  return zlib.gzipSync(tile, { level: 9 });
}

// ---- 5. build ---------------------------------------------------------------------------------------------------
await download();
await downloadMore();
// The painted ground of the 3D model places, widened a little (see the header). Optional.
let pads = [];
try {
  pads = JSON.parse(fs.readFileSync(ROOT + 'tools/model-pads.json')).pads.map((ring) => {
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const d = 0.0003; // the margin and a little more, in degrees
    return { ring, box: [Math.min(...xs) - d, Math.min(...ys) - d, Math.max(...xs) + d, Math.max(...ys) + d] };
  });
} catch { console.log('no tools/model-pads.json: no building is marked as standing on a model place'); }
const names = fs.readdirSync(RAW).filter((f) => f.endsWith('.gz')).map((f) => f.slice(0, -3).split('-').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
// First pass: where the buildings are (for the built-up rule); then the real conversion.
for (const [x, y] of names) convert(fs.readFileSync(`${RAW}${x}-${y}.gz`), x, y, []);
firstPass = false;
for (const k of Object.keys(stat)) stat[k] = 0;
const cols = new Map(); // x → [{id, data}]
for (const [x, y] of names) {
  const gz = fs.readFileSync(`${RAW}${x}-${y}.gz`); stat.rawBytes += gz.length;
  const data = convert(gz, x, y, pads); if (!data) continue;
  stat.outBytes += data.length; if (!cols.has(x)) cols.set(x, []); cols.get(x).push({ id: tileId(Z, x, y), data, x, y });
}
// West-to-east strips of whole tile columns, each under MAX_PART.
const parts = []; let cur = null;
for (const [x, tiles] of [...cols].sort((a, b) => a[0] - b[0])) {
  const size = tiles.reduce((s, t) => s + t.data.length, 0);
  if (!cur || cur.size + size > MAX_PART) parts.push((cur = { x0: x, x1: x, size: 0, tiles: [] }));
  cur.x1 = x; cur.size += size; cur.tiles.push(...tiles);
}
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const all = [...cols.values()].flat();
const bounds = [x2lon(Math.min(...all.map((t) => t.x))), y2lat(Math.max(...all.map((t) => t.y)) + 1), x2lon(Math.max(...all.map((t) => t.x)) + 1), y2lat(Math.min(...all.map((t) => t.y)))].map((v) => +v.toFixed(5));
const manifest = { release: RELEASE, zoom: Z, bounds, buildings: stat.buildings, parts: [] };
parts.forEach((p, i) => {
  p.tiles.sort((a, b) => a.id - b.id);
  const ys = p.tiles.map((t) => t.y), b = [x2lon(p.x0), y2lat(Math.max(...ys) + 1), x2lon(p.x1 + 1), y2lat(Math.min(...ys))];
  const file = `haiti-buildings-${i + 1}.pmtiles`;
  const buf = buildArchive(p.tiles, { minZoom: Z, maxZoom: Z, bounds: b, metadata: { name: 'Haiti buildings', attribution: '© OpenStreetMap, Overture Maps Foundation, Google, Microsoft', description: `Overture Maps ${RELEASE}, zoom ${Z}, heights and roof colours estimated`, vector_layers: [{ id: 'b', fields: { h: 'Number', c: 'Number', m: 'Number', x: 'Number' }, minzoom: Z, maxzoom: Z }] } });
  fs.writeFileSync(OUT + file, buf);
  manifest.parts.push({ file, x0: p.x0, x1: p.x1, bytes: buf.length });
  console.log(`${file}: columns ${p.x0}-${p.x1}, ${p.tiles.length} tiles, ${(buf.length / 1e6).toFixed(1)} MB`);
});
fs.writeFileSync(OUT + 'index.json', JSON.stringify(manifest, null, 1) + '\n');
// These files are a copy of an ODbL database, so they carry its licence with them.
fs.writeFileSync(OUT + 'LICENSE.md', `# Licence of the building files

The files in this folder (\`haiti-buildings-*.pmtiles\`, \`index.json\`) are a database of building outlines in Haiti,
derived from the Overture Maps "buildings" theme, release ${RELEASE}. They are made available under the
**Open Database License (ODbL) 1.0**: https://opendatacommons.org/licenses/odbl/1-0/

You may copy, share and adapt them if you credit the sources and share any adapted database under the same licence.

## Sources to credit

- © OpenStreetMap contributors (ODbL 1.0): https://www.openstreetmap.org/copyright
- Overture Maps Foundation: https://docs.overturemaps.org/attribution/
- Google Open Buildings (CC BY 4.0, also offered under ODbL 1.0): https://sites.research.google/gr/open-buildings/
- Microsoft Global ML Building Footprints (ODbL 1.0): https://github.com/microsoft/GlobalMLBuildingFootprints

## What was changed

Made by \`tools/build-buildings.mjs\`: only zoom 14 over Haiti is kept, and each building keeps its outline plus
an estimated height and roof colour. Outlines that reach into a mapped street, stream or other water are left out
(streets and water from the same Overture release, themes "transportation" and "base"), and so are lone or unsure
machine-found outlines outside built-up places. The outlines come from the sources; the heights and roof colours are
estimates added here (almost no building in Haiti has a recorded height) and are screening-level only. Buildings
standing on the map's 3D model places are marked so the map can leave them out.
`);
console.log(stat, `total ${(stat.outBytes / 1e6).toFixed(1)} MB (was ${(stat.rawBytes / 1e6).toFixed(1)} MB)`);
