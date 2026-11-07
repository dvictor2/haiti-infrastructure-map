// Development layers: existing infrastructure from open data, plus screening-level proposals placed by
// transparent rules (population, terrain, water, the plan's network). Writes:
//   data/dev.geojson   existing + proposed features (energy, water, sanitation, agriculture, housing, economy,
//                      connectivity, health, resilience, environment)
//   data/pop.json      population grid (2 km cells) for the density layer
//   data/stats.json    people near each city/town/station, and per department
//
//   sh tools/fetch-sources.sh      # once: downloads WorldPop, GEM faults, OpenStreetMap extract
//   node tools/build-dev.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createDem } from './dem.mjs';
import { haversine, kx, KY, pointInRing, r5 } from './geo.mjs';

const RAW = new URL('./.cache/raw/', import.meta.url);
const read = (u) => JSON.parse(readFileSync(u));
const plan = read(new URL('../data/plan.geojson', import.meta.url));
const depts = read(new URL('../data/departments.geojson', import.meta.url));
const osm = read(new URL('osm.json', RAW));
const gem = read(new URL('faults.geojson', RAW));
const cables = read(new URL('../source/submarine-cables-haiti.geojson', import.meta.url));

const D = 1 / 120; // 1 km cell size in degrees (WorldPop land grid)
const round = (v, n = 0) => Math.round(v * 10 ** n) / 10 ** n;

// ---------------------------------------------------------------------------
// Spatial helpers
// ---------------------------------------------------------------------------
const B = 0.05; // bucket size in degrees (~5.5 km)
const bkey = (lon, lat) => `${Math.floor(lon / B)},${Math.floor(lat / B)}`;

class SegIndex {
  constructor() {
    this.b = new Map();
  }
  add(coords, ref) {
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], c = coords[i];
      const x0 = Math.floor(Math.min(a[0], c[0]) / B), x1 = Math.floor(Math.max(a[0], c[0]) / B);
      const y0 = Math.floor(Math.min(a[1], c[1]) / B), y1 = Math.floor(Math.max(a[1], c[1]) / B);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!this.b.has(k)) this.b.set(k, []);
        this.b.get(k).push([a, c, ref]);
      }
    }
    return this;
  }
  // Nearest segment within maxKm: { d, pt, ref } or { d: Infinity }.
  nearest(p, maxKm = 30) {
    const sx = kx(p[1]);
    const bx = Math.floor(p[0] / B), by = Math.floor(p[1] / B);
    let best = { d: Infinity };
    const seen = new Set();
    for (let r = 0; r * B * 105 <= maxKm + B * 111; r++) {
      for (let x = bx - r; x <= bx + r; x++) for (let y = by - r; y <= by + r; y++) {
        if (Math.max(Math.abs(x - bx), Math.abs(y - by)) !== r) continue;
        for (const s of this.b.get(`${x},${y}`) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const [a, c, ref] = s;
          const ax = (a[0] - p[0]) * sx, ay = (a[1] - p[1]) * KY, cx = (c[0] - p[0]) * sx, cy = (c[1] - p[1]) * KY;
          const dx = cx - ax, dy = cy - ay;
          const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-12)));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d < best.d) best = { d, pt: [a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])], ref };
        }
      }
      if (best.d <= r * B * 105) break; // nothing closer can be further out
    }
    return best.d <= maxKm ? best : { d: Infinity };
  }
}

class PointIndex {
  constructor(items, get = (x) => x.p) {
    this.b = new Map();
    this.get = get;
    for (const it of items) {
      const k = bkey(...get(it));
      if (!this.b.has(k)) this.b.set(k, []);
      this.b.get(k).push(it);
    }
  }
  within(p, km) {
    const out = [];
    const r = Math.ceil(km / (B * 105)) + 1;
    const bx = Math.floor(p[0] / B), by = Math.floor(p[1] / B);
    for (let x = bx - r; x <= bx + r; x++) for (let y = by - r; y <= by + r; y++) {
      for (const it of this.b.get(`${x},${y}`) ?? []) if (haversine(p, this.get(it)) <= km) out.push(it);
    }
    return out;
  }
  nearest(p, maxKm = 60) {
    let best = null, bd = Infinity;
    for (const it of this.within(p, maxKm)) {
      const d = haversine(p, this.get(it));
      if (d < bd) [best, bd] = [it, d];
    }
    return best ? { it: best, d: bd } : null;
  }
}

const offset = (p, dxKm, dyKm) => [p[0] + dxKm / kx(p[1]), p[1] + dyKm / KY];
const squareAt = (lon, lat, h = D / 2) => [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]].map(r5)];

// ---------------------------------------------------------------------------
// Inputs from the plan
// ---------------------------------------------------------------------------
const P = plan.features.map((f) => f);
const by = (cat) => P.filter((f) => f.properties.category === cat);
const railLines = P.filter((f) => f.properties.mode === 'Rail + highway');
const natRings = P.filter((f) => f.properties.category === 'ring' && f.properties.tier === 'national');
const rivers = P.filter((f) => f.properties.category === 'water' && f.geometry.type === 'LineString');
const lakes = P.filter((f) => f.properties.category === 'water' && f.geometry.type === 'Polygon').map((f) => f.geometry.coordinates[0]);
const places = [...by('city'), ...by('town')];
const stations = by('station');
const inLake = (p) => lakes.some((r) => pointInRing(p, r));

// OpenStreetMap helpers
const osmEls = osm.elements;
const tagOf = (e) => e.tags ?? {};
function centerOf(e) {
  if (e.lat != null) return [e.lon, e.lat];
  const g = e.geometry ?? (e.members ?? []).flatMap((m) => m.geometry ?? []);
  if (g.length) return [g.reduce((s, q) => s + q.lon, 0) / g.length, g.reduce((s, q) => s + q.lat, 0) / g.length];
  if (e.bounds) return [(e.bounds.minlon + e.bounds.maxlon) / 2, (e.bounds.minlat + e.bounds.maxlat) / 2];
  return null;
}
const wayCoords = (e) => (e.geometry ?? []).filter(Boolean).map((q) => [q.lon, q.lat]);
const riverWays = read(new URL('rivers.json', RAW)).elements.filter((e) => e.tags?.name).map((e) => ({ name: e.tags.name, c: wayCoords(e) })).filter((w) => w.c.length > 1);
const riverLen = {};
for (const w of riverWays) riverLen[w.name] = (riverLen[w.name] ?? 0) + w.c.slice(1).reduce((s, q, i) => s + haversine(w.c[i], q), 0);
const canals = osmEls.filter((e) => e.type === 'way' && tagOf(e).waterway === 'canal').map(wayCoords).filter((c) => c.length > 1);

// Indexes
const railIdx = new SegIndex();
railLines.forEach((f) => railIdx.add(f.geometry.coordinates, f));
const backboneIdx = new SegIndex();
[...railLines, ...natRings].forEach((f) => backboneIdx.add(f.geometry.coordinates, f));
const waterIdx = new SegIndex();
rivers.forEach((f) => waterIdx.add(f.geometry.coordinates, f.properties.name));
canals.forEach((c) => waterIdx.add(c, 'canal'));
riverWays.forEach((w) => waterIdx.add(w.c, w.name));
const haitiFaults = gem.features.filter((f) => f.geometry && JSON.stringify(f.geometry.coordinates).match(/-7[1-4]\.\d+,1[89]\.\d+|-7[1-4]\.\d+,17\.[5-9]/));
const faultLines = haitiFaults.flatMap((f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates).map((c) => ({ c, name: f.properties.name && f.properties.name !== '[rename]' ? f.properties.name : null, slip: f.properties.slip_type })));
const faultIdx = new SegIndex();
faultLines.forEach((l) => faultIdx.add(l.c, l));

// ---------------------------------------------------------------------------
// Population grid + terrain per cell
// ---------------------------------------------------------------------------
const rows = readFileSync(new URL('hti_pd_2020_1km_UNadj_ASCII_XYZ.csv', RAW), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
const cellArea = (lat) => D * kx(lat) * D * KY;
// People per cell from Kontur 2023 (400 m hexagons, building-based); WorldPop only supplies the land grid.
const kontur = read(new URL('kontur-points.json', RAW));
const cellKey = (lon, lat) => `${Math.floor(lon / D)},${Math.floor(lat / D)}`;
const people = new Map();
for (const [lon, lat, v] of kontur) people.set(cellKey(lon, lat), (people.get(cellKey(lon, lat)) ?? 0) + v);
const TOTAL = Math.round(kontur.reduce((s, k) => s + k[2], 0));

const dem = createDem(10);
await dem.preload(rows.map(([x, y]) => [x, y]), 1);
const E = (p) => dem.elevation(p[0], p[1]);

console.time('cells');
const cells = rows.map(([lon, lat], i) => {
  const p = [lon, lat];
  const pop = people.get(cellKey(lon, lat)) ?? 0;
  const dens = pop / cellArea(lat);
  const h = 0.0035;
  const ex = (dem.elevation(lon + h, lat) - dem.elevation(lon - h, lat)) / (2 * h * kx(lat));
  const ey = (dem.elevation(lon, lat + h) - dem.elevation(lon, lat - h)) / (2 * h * KY);
  return {
    i, p, ix: Math.floor(lon / D), iy: Math.floor(lat / D),
    dens, pop, elev: E(p),
    slope: Math.hypot(ex, ey) / 10, // m per km → %
    dRail: railIdx.nearest(p, 40).d,
    dWater: waterIdx.nearest(p, 15).d,
    dFault: faultIdx.nearest(p, 20).d,
    lake: inLake(p),
  };
});
console.timeEnd('cells');
const cellIdx = new PointIndex(cells);
const cellAt = new Map(cells.map((c) => [`${c.ix},${c.iy}`, c]));
const popWithin = (p, km) => cellIdx.within(p, km).reduce((s, c) => s + c.pop, 0);
const densAt = (p) => cellIdx.nearest(p, 1.5)?.it.dens ?? 0;
const dry = (p) => E(p) >= 2 && !inLake(p);

// Clusters of grid cells (8-neighbour).
function clusters(list) {
  const set = new Map(list.map((c) => [`${c.ix},${c.iy}`, c]));
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const k0 = `${c.ix},${c.iy}`;
    if (seen.has(k0)) continue;
    const group = [];
    const stack = [c];
    seen.add(k0);
    while (stack.length) {
      const q = stack.pop();
      group.push(q);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = `${q.ix + dx},${q.iy + dy}`;
        if (set.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push(set.get(k));
        }
      }
    }
    out.push(group);
  }
  return out;
}
const centroid = (group, w = (c) => c.pop) => {
  const W = group.reduce((s, c) => s + w(c), 0) || group.length;
  return [group.reduce((s, c) => s + c.p[0] * (w(c) || 1), 0) / (W || 1), group.reduce((s, c) => s + c.p[1] * (w(c) || 1), 0) / (W || 1)];
};
const nearestPlace = (p, km = 25) => {
  let best = null, bd = Infinity;
  for (const f of places) {
    const d = haversine(p, f.geometry.coordinates);
    if (d < bd && d <= km) [best, bd] = [f, d];
  }
  return best ? best.properties.name : null;
};
const deptOf = (p) => depts.features.find((f) => f.geometry.coordinates.some((poly) => pointInRing(p, poly[0])))?.properties.name ?? null;

// ---------------------------------------------------------------------------
// Output collection
// ---------------------------------------------------------------------------
const out = [];
let nid = 0;
const add = (props, geometry) => {
  const p = geometry.type === 'Point' ? geometry.coordinates : null;
  out.push({ type: 'Feature', properties: { id: `d${++nid}`, dept: p ? deptOf(p) : props.dept ?? null, ...props }, geometry: p ? { type: 'Point', coordinates: r5(p) } : geometry });
};

// ---------------------------------------------------------------------------
// Stats: people near places, per department
// ---------------------------------------------------------------------------
const stats = { places: {}, depts: {}, total: TOTAL, year: 2023, source: 'Kontur' };
for (const f of [...places, ...stations]) {
  const p = f.geometry.coordinates;
  stats.places[f.properties.id] = { p5: Math.round(popWithin(p, 5)), p10: Math.round(popWithin(p, 10)), p25: Math.round(popWithin(p, 25)) };
}
for (const c of cells) {
  const d = deptOf(c.p) ?? 'other';
  stats.depts[d] = (stats.depts[d] ?? 0) + c.pop;
}
for (const k of Object.keys(stats.depts)) stats.depts[k] = Math.round(stats.depts[k]);

// ---------------------------------------------------------------------------
// EXISTING infrastructure (OpenStreetMap, curated)
// ---------------------------------------------------------------------------
const named = (e) => tagOf(e).name;
for (const e of osmEls) {
  const t = tagOf(e);
  const c = centerOf(e);
  if (!c) continue;
  if (t.power === 'plant') {
    const src = t['plant:source'] ?? t['generator:source'] ?? null;
    add({ theme: 'energy', kind: 'plant', status: 'existing', name: t.name ?? null, source: src, mw: parseFloat(t['plant:output:electricity']) || null, src: 'osm' }, { type: 'Point', coordinates: c });
  } else if (t.power === 'substation') {
    add({ theme: 'energy', kind: 'substation', status: 'existing', name: t.name ?? null, src: 'osm' }, { type: 'Point', coordinates: c });
  } else if (t.power === 'line' && e.type === 'way') {
    add({ theme: 'energy', kind: 'powerline', status: 'existing', name: t.name ?? null, voltage: t.voltage ?? null, src: 'osm' }, { type: 'LineString', coordinates: wayCoords(e).map(r5) });
  } else if (t.waterway === 'canal' && e.type === 'way') {
    add({ theme: 'water', kind: 'canal', status: 'existing', name: t.name ?? null, src: 'osm' }, { type: 'LineString', coordinates: wayCoords(e).map(r5) });
  } else if (['water_works', 'water_tower', 'reservoir_covered'].includes(t.man_made)) {
    add({ theme: 'water', kind: 'waterpoint', status: 'existing', name: t.name ?? null, sub: t.man_made, src: 'osm' }, { type: 'Point', coordinates: c });
  } else if ((t.waterway === 'dam' || t.man_made === 'dam') && /p[ée]ligre/i.test(t.name ?? '')) {
    add({ theme: 'water', kind: 'dam', status: 'existing', name: t.name, src: 'osm' }, { type: 'Point', coordinates: c });
  } else if (t.amenity === 'hospital') {
    add({ theme: 'health', kind: 'hospital', status: 'existing', name: t.name ?? null, major: /h[oô]pital|hospital|centre hospitalier|\bCHU\b|\bHUEH\b/i.test(t.name ?? ''), src: 'osm' }, { type: 'Point', coordinates: c });
  } else if (t.amenity === 'university') {
    add({ theme: 'health', kind: 'university', status: 'existing', name: t.name ?? null, src: 'osm' }, { type: 'Point', coordinates: c });
  } else if (t.landuse === 'industrial' && /parc industriel|zone franche|codevi|caracol|cimenterie|terminal p[ée]trolier|moulins d'ha|brasserie nationale/i.test(t.name ?? '')) {
    add({ theme: 'economy', kind: 'industrial', status: 'existing', name: t.name, src: 'osm' }, { type: 'Point', coordinates: c });
  } else if (t.harbour === 'yes' && named(e) && !/marina/i.test(t.leisure ?? '') ? true : t.harbour === 'yes' && /Port/.test(t.name ?? '')) {
    add({ theme: 'economy', kind: 'port', status: 'existing', name: t.name, src: 'osm' }, { type: 'Point', coordinates: c });
  } else if ((t.boundary === 'national_park' || t.boundary === 'protected_area' || (t.leisure === 'nature_reserve' && e.type !== 'node')) && t.name && e.type !== 'node') {
    const lines = e.type === 'way' ? [wayCoords(e)] : (e.members ?? []).filter((m) => m.geometry).map((m) => m.geometry.map((q) => [q.lon, q.lat]));
    const flat = lines.flat();
    if (flat.length < 4) continue;
    const xs = flat.map((q) => q[0]), ys = flat.map((q) => q[1]);
    const spanKm = haversine([Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]);
    if (spanKm < 1.5) continue;
    add({ theme: 'environment', kind: 'protected', status: 'existing', name: t.name, src: 'osm', dept: deptOf(c) }, { type: 'MultiLineString', coordinates: lines.map((l) => l.map(r5)) });
    add({ theme: 'environment', kind: 'protectedLabel', status: 'existing', name: t.name, src: 'osm' }, { type: 'Point', coordinates: c });
  }
}
// Port-au-Prince thermal plants are missing from OpenStreetMap; added at approximate locations.
add({ theme: 'energy', kind: 'plant', status: 'existing', name: 'Varreux', source: 'oil', approx: true, src: 'known' }, { type: 'Point', coordinates: [-72.334, 18.574] });
add({ theme: 'energy', kind: 'plant', status: 'existing', name: 'Carrefour', source: 'oil', approx: true, src: 'known' }, { type: 'Point', coordinates: [-72.4104, 18.531] });

// Submarine cables (TeleGeography)
for (const f of cables.features) {
  if (f.properties.landing) add({ theme: 'connectivity', kind: 'landing', status: 'existing', name: f.properties.name, src: 'telegeography' }, f.geometry);
  else add({ theme: 'connectivity', kind: 'cable', status: 'existing', name: f.properties.name, src: 'telegeography' }, f.geometry);
}

// Active faults (GEM)
for (const l of faultLines) add({ theme: 'resilience', kind: 'fault', status: 'existing', name: l.name, slip: l.slip, src: 'gem' }, { type: 'LineString', coordinates: l.c.map(r5) });

// ---------------------------------------------------------------------------
// PROPOSED — screening rules
// ---------------------------------------------------------------------------
// Cities that need water and sanitation plants: every city/town with ≥ 40,000 people within 5 km,
// skipping one that sits within 5 km of a larger one already chosen.
const cityTargets = [];
for (const f of [...places].sort((a, b) => stats.places[b.properties.id].p5 - stats.places[a.properties.id].p5)) {
  const s = stats.places[f.properties.id];
  if (s.p5 < 40000) continue;
  if (cityTargets.some((c) => haversine(c.p, f.geometry.coordinates) < 5)) continue;
  cityTargets.push({ f, p: f.geometry.coordinates, name: f.properties.name, pop: s.p5, pop10: s.p10, elev: E(f.geometry.coordinates) });
}

function polarSearch(center, rMin, rMax, score) {
  let best = null;
  for (let r = rMin; r <= rMax; r += 0.5) {
    for (let k = 0; k < 36; k++) {
      const a = (k / 36) * 2 * Math.PI;
      const q = offset(center, Math.cos(a) * r, Math.sin(a) * r);
      const s = score(q, r);
      if (s != null && (!best || s > best.s)) best = { q, s, r };
    }
  }
  return best;
}
const slopeAt = (q) => {
  const h = 0.003;
  const ex = (E([q[0] + h, q[1]]) - E([q[0] - h, q[1]])) / (2 * h * kx(q[1]));
  const ey = (E([q[0], q[1] + h]) - E([q[0], q[1] - h])) / (2 * h * KY);
  return Math.hypot(ex, ey) / 10;
};
const nearSea = (q, km = 1.5) => [0, 60, 120, 180, 240, 300].some((a) => E(offset(q, Math.cos((a * Math.PI) / 180) * km, Math.sin((a * Math.PI) / 180) * km)) < -1);

const waterSites = [];
for (const c of cityTargets) {
  // Drinking water: treatment + reservoir uphill of the city so water reaches homes by gravity.
  const w = polarSearch(c.p, 2, 10, (q, r) => {
    const e = E(q);
    if (!dry(q) || e < c.elev + 30 || e > c.elev + 260 || slopeAt(q) > 25 || densAt(q) > 1000) return null;
    const river = waterIdx.nearest(q, 3);
    return Math.min(e - c.elev, 120) - r * 6 + (river.d < 2 ? 25 : 0) - densAt(q) / 100;
  });
  if (w) {
    const river = waterIdx.nearest(w.q, 3);
    waterSites.push(w.q);
    add({ theme: 'water', kind: 'waterPlant', status: 'proposed', place: c.name, serves: c.pop, head: round(E(w.q) - c.elev), km: round(w.r, 1), river: typeof river.ref === 'string' && river.ref !== 'canal' ? river.ref : river.ref === 'canal' ? 'canal' : null }, { type: 'Point', coordinates: w.q });
  }
  // Wastewater: treatment downhill of the city, away from homes, ideally near the coast or a river outlet.
  const s = polarSearch(c.p, 1.5, 8, (q, r) => {
    const e = E(q);
    if (!dry(q) || e > Math.max(c.elev - 2, 0) + 15 || slopeAt(q) > 6 || densAt(q) > 600) return null;
    if (w && haversine(q, w.q) < 3) return null;
    return (c.elev - e) * 0.4 - r * 4 - densAt(q) / 80 + (nearSea(q) ? 10 : 0);
  });
  if (s) add({ theme: 'sanitation', kind: 'sewagePlant', status: 'proposed', place: c.name, serves: c.pop, drop: round(c.elev - E(s.q)), km: round(s.r, 1), coast: nearSea(s.q) }, { type: 'Point', coordinates: s.q });
}

// Agriculture: flat, low, irrigable land with a rural population.
const agriCells = cells.filter((c) => c.slope < 4 && c.elev > 1 && c.elev < 450 && c.dens >= 20 && c.dens <= 1000 && c.dWater < 4 && !c.lake);
const ANCHORS = [
  ['Artibonite Valley', [-72.55, 19.2]], ['Plaine du Nord', [-72.25, 19.65]], ['Plaine de Maribahoux', [-71.95, 19.6]],
  ['Plaine du Cul-de-Sac', [-72.15, 18.6]], ['Plateau Central', [-72.0, 19.1]], ['Plaine des Cayes', [-73.8, 18.25]],
  ['Plaine de Léogâne', [-72.62, 18.5]], ["Plaine de l'Arcahaie", [-72.45, 18.75]], ['Plaine des Gonaïves', [-72.65, 19.45]],
  ['Plaine de Saint-Raphaël', [-72.2, 19.43]], ['Plaine de Mirebalais–Lascahobas', [-72.0, 18.85]], ['Plaine de Fond-des-Nègres', [-73.38, 18.38]], ['Vallée de Jacmel', [-72.53, 18.3]],
];
const agriSet = new Set();
for (const g of clusters(agriCells).filter((g) => g.length >= 20).sort((a, b) => b.length - a.length)) {
  const ctr = centroid(g, () => 1);
  const anchor = ANCHORS.map(([n, p]) => [n, haversine(ctr, p)]).sort((a, b) => a[1] - b[1])[0];
  const zone = anchor[1] < 30 ? anchor[0] : nearestPlace(ctr, 30) ?? 'Agricultural plain';
  const area = g.reduce((s, c) => s + cellArea(c.p[1]), 0);
  g.forEach((c) => agriSet.add(c.i));
  add({ theme: 'agri', kind: 'agriZone', status: 'proposed', place: zone, km2: round(area), people: Math.round(g.reduce((s, c) => s + c.pop, 0)), dept: deptOf(ctr) }, { type: 'MultiPolygon', coordinates: g.map((c) => squareAt(...c.p)) });
  const hub = g.reduce((a, b) => (b.dRail < a.dRail ? b : a));
  add({ theme: 'agri', kind: 'agriHub', status: 'proposed', place: zone, km2: round(area), rail: round(hub.dRail, 1) }, { type: 'Point', coordinates: hub.p });
}

// Solar parks: flat, lightly populated land near a rail + highway corridor (grid follows the corridor),
// not on the irrigable plains, not on a fault. Spread across the country.
const solar = [];
for (const c of cells
  .filter((c) => c.slope < 3 && c.elev > 3 && c.elev < 450 && c.dens < 150 && c.dRail < 6 && c.dWater > 1.5 && c.dFault > 1 && !c.lake && !agriSet.has(c.i))
  .map((c) => ({ c, s: -c.dRail * 2 - c.dens / 20 - c.slope * 3 + popWithin(c.p, 30) / 1e5 }))
  .sort((a, b) => b.s - a.s)) {
  if (solar.length >= 10) break;
  if (solar.some((s) => haversine(s.p, c.c.p) < 30)) continue;
  solar.push(c.c);
  add({ theme: 'energy', kind: 'solar', status: 'proposed', place: nearestPlace(c.c.p, 30), mw: 50, rail: round(c.c.dRail, 1), load: Math.round(popWithin(c.c.p, 30)) }, { type: 'Point', coordinates: c.c.p });
}

// Wind: indicative measurement sites in areas exposed to the trade winds.
const WIND_ZONES = [
  ['Môle-Saint-Nicolas plateau', [-73.45, 19.7, -73.1, 19.95], true],
  ['Anse-Rouge coast', [-73.05, 19.55, -72.75, 19.75], false],
  ['Lac Azuéi basin', [-72.1, 18.45, -71.85, 18.6], false],
  ['Île de la Tortue ridge', [-72.95, 20.0, -72.6, 20.1], true],
];
for (const [zone, [x0, y0, x1, y1], ridge] of WIND_ZONES) {
  const cand = cells.filter((c) => c.p[0] >= x0 && c.p[0] <= x1 && c.p[1] >= y0 && c.p[1] <= y1 && c.slope < 10 && c.dens < 150 && c.elev > 3 && !c.lake);
  if (!cand.length) continue;
  const best = cand.reduce((a, b) => ((ridge ? b.elev > a.elev : b.dens < a.dens) ? b : a));
  add({ theme: 'energy', kind: 'wind', status: 'proposed', place: zone, elev: round(best.elev) }, { type: 'Point', coordinates: best.p });
}

// Small hydro: run-of-river reaches on larger rivers (OpenStreetMap riverbeds): 30–150 m of drop over 3 km,
// low enough that the river has a real catchment above it.
const fineDem = createDem(12);
const hydro = [];
const hydroCand = [];
for (const w of riverWays.filter((w) => riverLen[w.name] >= 40)) {
  await fineDem.preload(w.c, 1);
  const pts = [];
  for (let i = 1; i < w.c.length; i++) {
    const n = Math.max(1, Math.ceil(haversine(w.c[i - 1], w.c[i]) / 0.25));
    for (let k = 0; k < n; k++) pts.push([w.c[i - 1][0] + ((w.c[i][0] - w.c[i - 1][0]) * k) / n, w.c[i - 1][1] + ((w.c[i][1] - w.c[i - 1][1]) * k) / n]);
  }
  const el = pts.map((q) => fineDem.elevation(q[0], q[1]));
  for (let i = 0; i + 12 < pts.length; i++) {
    const drop = Math.abs(el[i] - el[i + 12]);
    const low = Math.min(el[i], el[i + 12]);
    if (drop >= 30 && drop <= 150 && low >= 20 && low <= 600) hydroCand.push({ q: pts[i + 6], drop, name: w.name, score: drop * Math.log(riverLen[w.name]) });
  }
}
for (const k of hydroCand.sort((a, b) => b.score - a.score)) {
  if (hydro.length >= 14) break;
  if (hydro.filter((h) => h.name === k.name).length >= 2 || hydro.some((h) => haversine(h.q, k.q) < 15)) continue;
  hydro.push(k);
  add({ theme: 'energy', kind: 'hydro', status: 'proposed', place: k.name, head: round(k.drop), riverKm: round(riverLen[k.name]) }, { type: 'Point', coordinates: k.q });
}

// Island microgrids: solar + battery where a grid connection by sea is not practical.
for (const f of by('city').filter((f) => /Île|Gonâve|Cayemite|Vache/.test(f.properties.name))) {
  add({ theme: 'energy', kind: 'microgrid', status: 'proposed', place: f.properties.name.replace(/\s*\(.*\)$/, ''), people: stats.places[f.properties.id]?.p10 ?? null }, { type: 'Point', coordinates: f.geometry.coordinates });
}

// Housing: transit-oriented development around each ring station (buildable land within 2.5 km).
const builtSet = new Set();
for (const st of stations) {
  const g = cellIdx.within(st.geometry.coordinates, 2.5).filter((c) => c.slope < 10 && c.elev > 4 && c.dFault > 0.5 && !c.lake && !agriSet.has(c.i) && !builtSet.has(c.i));
  if (g.length < 3) continue;
  g.forEach((c) => builtSet.add(c.i));
  add({ theme: 'housing', kind: 'tod', status: 'proposed', place: st.properties.name, ring: st.properties.city, km2: round(g.reduce((s, c) => s + cellArea(c.p[1]), 0), 1), people: Math.round(g.reduce((s, c) => s + c.pop, 0)), dept: st.properties.dept }, { type: 'MultiPolygon', coordinates: g.map((c) => squareAt(...c.p)) });
}
// New town candidates near the two largest metro areas, to take pressure off the core.
const metros = [['Port-au-Prince', [-72.335, 18.54], 2], ['Cap-Haïtien', [-72.2, 19.757], 1]];
for (const [metro, mp, n] of metros) {
  const picks = [];
  const cand = cells
    .filter((c) => { const d = haversine(c.p, mp); return d > 15 && d < 45 && c.slope < 6 && c.dens < 250 && c.elev > 10 && c.elev < 250 && c.dRail < 3 && c.dFault > 2 && !c.lake && !agriSet.has(c.i); })
    .map((c) => ({ c, s: -c.dens / 50 - c.slope - c.dRail * 2 + cellIdx.within(c.p, 3).filter((x) => x.slope < 6 && !agriSet.has(x.i) && x.dens < 400).length * 0.5 }))
    .sort((a, b) => b.s - a.s);
  for (const { c } of cand) {
    if (picks.length >= n) break;
    if (picks.some((p) => haversine(p, c.p) < 15)) continue;
    picks.push(c.p);
    const g = cellIdx.within(c.p, 3).filter((x) => x.slope < 6 && !agriSet.has(x.i) && x.dens < 400 && !x.lake && x.elev > 4);
    add({ theme: 'housing', kind: 'newTown', status: 'proposed', place: nearestPlace(c.p, 20) ?? metro, metro, km: round(haversine(c.p, mp)), km2: round(g.reduce((s, x) => s + cellArea(x.p[1]), 0), 1), rail: round(c.dRail, 1), dept: deptOf(c.p) }, { type: 'MultiPolygon', coordinates: g.map((x) => squareAt(...x.p)) });
  }
}

// Economy: port-logistics hubs on coastal Périphériques, a central dry port, border trade zones, digital hubs.
for (const ring of natRings) {
  const city = ring.properties.name.replace(/\s*Périphérique$/, '');
  const st = stations.filter((s) => s.properties.city === city);
  if (!st.length) continue;
  const coastal = ring.geometry.coordinates.some((q) => nearSea(q, 1.2));
  if (coastal) {
    const low = st.reduce((a, b) => (E(b.geometry.coordinates) < E(a.geometry.coordinates) ? b : a));
    add({ theme: 'economy', kind: 'portHub', status: 'proposed', place: city, porte: low.properties.name }, { type: 'Point', coordinates: low.geometry.coordinates });
  }
}
{
  const hinche = stations.filter((s) => s.properties.city === 'Hinche');
  if (hinche.length) {
    const hub = hinche.reduce((a, b) => ((b.properties.serves ?? '').split('·').length > (a.properties.serves ?? '').split('·').length ? b : a));
    add({ theme: 'economy', kind: 'dryPort', status: 'proposed', place: 'Hinche', routes: hinche.length }, { type: 'Point', coordinates: hinche[0].geometry.coordinates.map((v, i) => (v + hub.geometry.coordinates[i]) / 2) });
  }
}
const borderPts = [
  ['Belladère', by('city').find((f) => /Belladère/.test(f.properties.name))?.geometry.coordinates],
  ['Malpasse', P.find((f) => /Jimaní/.test(f.properties.name) && f.geometry.type === 'LineString')?.geometry.coordinates.at(-1)],
  ['Anse-à-Pitre', by('city').find((f) => /Anse-à-Pitre/.test(f.properties.name))?.geometry.coordinates],
];
for (const [name, p] of borderPts) if (p) add({ theme: 'economy', kind: 'borderZone', status: 'proposed', place: name }, { type: 'Point', coordinates: p });
for (const [name, p, landing] of [['Port-au-Prince', [-72.3, 18.555], 'Port-au-Prince'], ['Cap-Haïtien', [-72.19, 19.735], null]]) {
  add({ theme: 'economy', kind: 'techHub', status: 'proposed', place: name, landing, people: Math.round(popWithin(p, 25)) }, { type: 'Point', coordinates: p });
}

// Connectivity: places far from the fibre backbone (laid along rail + highway trunks and Périphériques).
for (const f of places) {
  const p = f.geometry.coordinates;
  const d = backboneIdx.nearest(p, 60).d;
  if (d > 8) add({ theme: 'connectivity', kind: 'ruralHub', status: 'proposed', place: f.properties.name.replace(/\s*\(.*\)$/, ''), km: round(d), people: stats.places[f.properties.id]?.p5 ?? null }, { type: 'Point', coordinates: p });
}

// Health: populated areas more than 12 km from any mapped hospital.
// OpenStreetMap tags many small clinics as hospitals; gaps are measured to real hospitals only.
const isHospital = (n) => /h[oô]pital|hospital|centre hospitalier|\bCHU\b|\bHUEH\b/i.test(n ?? '');
const hospitals = out.filter((f) => f.properties.kind === 'hospital' && isHospital(f.properties.name)).map((f) => ({ p: f.geometry.coordinates }));
const hospIdx = new PointIndex(hospitals);
const far = cells.filter((c) => c.dens > 80 && !(hospIdx.nearest(c.p, 15)));
for (const g of clusters(far).map((g) => ({ g, pop: g.reduce((s, c) => s + c.pop, 0) })).filter((x) => x.pop > 12000).sort((a, b) => b.pop - a.pop).slice(0, 15)) {
  const ctr = centroid(g.g);
  const near = places.map((f) => [f, haversine(ctr, f.geometry.coordinates)]).sort((a, b) => a[1] - b[1])[0];
  const at = near && near[1] < 8 ? near[0].geometry.coordinates : ctr;
  const dist = hospIdx.nearest(at, 80)?.d ?? null;
  add({ theme: 'health', kind: 'healthGap', status: 'proposed', place: near && near[1] < 15 ? near[0].properties.name.replace(/\s*\(.*\)$/, '') : nearestPlace(ctr, 30), people: Math.round(g.pop), km: dist ? round(dist) : null }, { type: 'Point', coordinates: at });
}

// Resilience: where rail + highway trunks cross an active fault, and densely built low-lying land.
function segX(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}
const crossings = [];
for (const f of railLines) {
  const rc = f.geometry.coordinates;
  for (const l of faultLines) {
    for (let i = 1; i < rc.length; i++) for (let j = 1; j < l.c.length; j++) {
      const x = segX(rc[i - 1], rc[i], l.c[j - 1], l.c[j]);
      if (x && !crossings.some((k) => haversine(k, x) < 2)) {
        crossings.push(x);
        add({ theme: 'resilience', kind: 'faultCross', status: 'proposed', place: f.properties.name, fault: l.name }, { type: 'Point', coordinates: x });
      }
    }
  }
}
const flood = cells.filter((c) => c.elev <= 5 && c.elev > -1 && c.dens > 600 && !c.lake);
for (const g of clusters(flood).filter((g) => g.length >= 2)) {
  const ctr = centroid(g);
  add({ theme: 'resilience', kind: 'floodZone', status: 'proposed', place: nearestPlace(ctr, 15) ?? '', people: Math.round(g.reduce((s, c) => s + c.pop, 0)), km2: round(g.reduce((s, c) => s + cellArea(c.p[1]), 0), 1), dept: deptOf(ctr) }, { type: 'MultiPolygon', coordinates: g.map((c) => squareAt(...c.p)) });
}

// ---------------------------------------------------------------------------
// Population grid for the density layer (2 km cells)
// ---------------------------------------------------------------------------
const G = 1 / 60;
const agg = new Map();
for (const c of cells) {
  const k = `${Math.floor(c.p[0] / G)},${Math.floor(c.p[1] / G)}`;
  agg.set(k, (agg.get(k) ?? 0) + c.pop);
}
const pop = [...agg].filter(([, v]) => v >= 5).map(([k, v]) => {
  const [x, y] = k.split(',').map(Number);
  return [round((x + 0.5) * G, 4), round((y + 0.5) * G, 4), Math.round(v)];
});

writeFileSync(new URL('../data/dev.geojson', import.meta.url), JSON.stringify({ type: 'FeatureCollection', features: out }));
writeFileSync(new URL('../data/pop.json', import.meta.url), JSON.stringify({ cell: G, year: 2023, total: TOTAL, points: pop }));
writeFileSync(new URL('../data/stats.json', import.meta.url), JSON.stringify(stats));

const tally = {};
for (const f of out) tally[`${f.properties.status} ${f.properties.theme}/${f.properties.kind}`] = (tally[`${f.properties.status} ${f.properties.theme}/${f.properties.kind}`] ?? 0) + 1;
console.log(tally);
console.log('cities with water/sewage targets:', cityTargets.map((c) => `${c.name} ${Math.round(c.pop / 1000)}k`).join(', '));
