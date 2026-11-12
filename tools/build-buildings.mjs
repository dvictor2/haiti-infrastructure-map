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
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Reader, tileId, buildArchive } from './pmtiles-lite.mjs';

const RELEASE = '2026-10-21.0';
const SRC = `https://tiles.overturemaps.org/${RELEASE}/buildings.pmtiles`;
const ROOT = new URL('..', import.meta.url).pathname;
const RAW = ROOT + 'tools/.cache/buildings/raw/', OUT = ROOT + 'data/buildings/';
const Z = 14, N = 2 ** Z, EXTENT_M = 40075016.686;
const MAX_PART = 30e6; // bytes per file: GitHub warns above 50 MB and refuses above 100 MB

const x2lon = (x) => (x / N) * 360 - 180, y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;
const lon2x = (lon) => Math.floor(((lon + 180) / 360) * N), lat2y = (lat) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * N);
const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };

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
  if (area < 25) return 2.6 + r * 0.5;
  if (area < 120) return (r < 0.62 ? 1 : r < 0.95 ? 2 : 3) * STOREY + 0.2;
  if (area < 400) return (r < 0.35 ? 1 : r < 0.8 ? 2 : 3) * STOREY + 0.4;
  if (area < 1500) return 5 + r * 4.5;
  return 7 + r * 4;
}
// 0 pale concrete, 1 concrete, 2 weathered concrete, 3 sheet metal, 4 rusted sheet, 5 blue sheet
function guessRoof(area, r) {
  if (area < 60) return r < 0.3 ? 3 : r < 0.55 ? 4 : r < 0.8 ? 1 : r < 0.93 ? 2 : 5;
  if (area < 400) return r < 0.34 ? 0 : r < 0.62 ? 1 : r < 0.78 ? 2 : r < 0.89 ? 3 : r < 0.96 ? 4 : 5;
  return r < 0.4 ? 3 : r < 0.6 ? 0 : r < 0.78 ? 1 : r < 0.9 ? 5 : 2;
}

// ---- 4. one tile -----------------------------------------------------------------------------------------------
const stat = { buildings: 0, height: 0, floors: 0, parts: 0, onPads: 0, rawBytes: 0, outBytes: 0 };
function convert(gz, x, y, pads) {
  const layers = []; fields(zlib.gunzipSync(gz), (f, v) => f === 3 && layers.push(parseLayer(v)));
  const lat = y2lat(y + 0.5), feats = [], valIndex = new Map(), vals = [];
  const val = (n) => { if (!valIndex.has(n)) { valIndex.set(n, vals.length); vals.push(n); } return valIndex.get(n); };
  let extent = 4096;
  for (const L of layers) {
    const part = L.name === 'building_part'; if (!part && L.name !== 'building') continue;
    extent = L.extent; const unit = (EXTENT_M * Math.cos((lat * Math.PI) / 180)) / N / L.extent;
    for (const fb of L.features) {
      const F = parseFeature(fb, L), P = F.props;
      if (F.type !== 3 || !F.geom || P.is_underground === true || (!part && P.has_parts === true)) continue;
      const m = measure(F.geom), area = m.area * unit * unit; if (area < 4) continue;
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
      stat.buildings++; feats.push({ tags, geom: F.geom });
    }
  }
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
an estimated height and roof colour. The outlines come from the sources; the heights and roof colours are
estimates added here (almost no building in Haiti has a recorded height) and are screening-level only. Buildings
standing on the map's 3D model places are marked so the map can leave them out.
`);
console.log(stat, `total ${(stat.outBytes / 1e6).toFixed(1)} MB (was ${(stat.rawBytes / 1e6).toFixed(1)} MB)`);
