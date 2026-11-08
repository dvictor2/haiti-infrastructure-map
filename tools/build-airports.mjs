// Airports for the Development tab: existing airfields from OpenStreetMap, and screening-level proposals.
// Run: node tools/build-airports.mjs  →  data/airports.geojson
//
// Rules (all distances straight-line):
//  1. Existing: every aerodrome mapped in OpenStreetMap, with its mapped runway length and surface.
//  2. Upgrades: each department gets one regional airport with a 1,800 m paved runway (regional turboprops
//     and small jets): the airfield nearest its capital, if one lies within 35 km. Môle-Saint-Nicolas is
//     included for its strategic deep-water bay; island airstrips get a paved all-weather runway (1,200 m).
//  3. National cargo & backup airport: one flat site for a 3,200 m runway, within 10 km of a planned rail
//     station or rail line, 50–150 km from Port-au-Prince and over 60 km from Cap-Haïtien, chosen for the
//     most people within 60 km. It gives the country a second long runway if Port-au-Prince closes.
//  4. New regional airports (2,000 m): first for every department capital with no airport within 30 km, on the
//     flattest suitable site within 20 km of it; then wherever many people still live over 45 km from any
//     airport with a paved runway of 1,200 m or more, while each new airport brings at least 150,000 people
//     within 45 km (at most 3 more).
// A suitable site: on land, below 250 m, a runway-length strip in one of 8 directions whose ground varies by
// no more than 20 m and that stays at least 300 m from mapped rivers, and not inside a dense town (cell under
// 3,000 people per km²).
import { readFileSync, writeFileSync } from 'node:fs';
import { createDem } from './dem.mjs';
import { haversine, distToLine, pointInRing, kx, KY } from './geo.mjs';

const read = (u) => JSON.parse(readFileSync(new URL(u, import.meta.url)));
const osm = read('./.cache/raw/airports.json').elements;
const plan = read('../data/plan.geojson').features;
const depts = read('../data/departments.geojson').features;
const pop = read('../data/pop.json').points; // [lon, lat, people]
const dem = createDem(11);
const riverLines = read('../data/rivers.geojson').features.flatMap((f) => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]));
const riverBoxes = riverLines.map((c) => [Math.min(...c.map((q) => q[0])) - 0.01, Math.min(...c.map((q) => q[1])) - 0.01, Math.max(...c.map((q) => q[0])) + 0.01, Math.max(...c.map((q) => q[1])) + 0.01]);
const nearRiver = (q) => riverLines.some((c, i) => { const b = riverBoxes[i]; return q[0] > b[0] && q[0] < b[2] && q[1] > b[1] && q[1] < b[3] && distToLine(q, c) < 0.3; });

const places = plan.filter((f) => ['city', 'town'].includes(f.properties.category));
// Inside a department polygon, or (on the coast, just outside the outline) the department of the nearest town.
const deptAt = (p) => depts.find((d) => d.geometry.coordinates.some((poly) => pointInRing(p, poly[0])))?.properties.name
  ?? places.reduce((b, f) => { const d = haversine(p, f.geometry.coordinates); return d < b.d ? { d, dept: f.properties.dept } : b; }, { d: Infinity }).dept ?? null;
const inHaiti = (p) => depts.some((d) => d.geometry.coordinates.some((poly) => pointInRing(p, poly[0])));
const CAPITALS = { Artibonite: 'Gonaïves', Centre: 'Hinche', "Grand'Anse": 'Jérémie', Nippes: 'Miragoâne', Nord: 'Cap-Haïtien', 'Nord-Est': 'Fort-Liberté', 'Nord-Ouest': 'Port-de-Paix', Ouest: 'Port-au-Prince', Sud: 'Les Cayes', 'Sud-Est': 'Jacmel' };
const capitalAt = (name) => places.find((f) => f.properties.category === 'city' && f.properties.name.startsWith(name))?.geometry.coordinates ?? places.find((f) => f.properties.name.startsWith(name))?.geometry.coordinates;
const nearestPlace = (p) => places.reduce((b, f) => { const d = haversine(p, f.geometry.coordinates); return d < b.d ? { d, name: f.properties.name.replace(/\s*\(.*\)$/, '') } : b; }, { d: Infinity }).name;
const stations = plan.filter((f) => f.properties.category === 'station').map((f) => f.geometry.coordinates);
const railLines = plan.filter((f) => f.properties.mode === 'Rail + highway').map((f) => f.geometry.coordinates);
const toRail = (p) => Math.min(...stations.map((s) => haversine(p, s)), ...railLines.map((c) => distToLine(p, c)));
const toStation = (p) => Math.min(...stations.map((s) => haversine(p, s)));
const popWithin = (p, km, filter = () => true) => pop.reduce((s, q) => (filter(q) && haversine(p, q) <= km ? s + q[2] : s), 0);
const offset = (p, dx, dy) => [p[0] + dx / kx(p[1]), p[1] + dy / KY];

// ---------- 1. existing airfields ----------
const centre = (e) => e.center ?? (e.lat ? { lat: e.lat, lon: e.lon } : e.bounds ? { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 } : null);
const runways = osm.filter((e) => e.tags.aeroway === 'runway' && e.geometry).map((e) => {
  const g = e.geometry.map((p) => [p.lon, p.lat]);
  let m = 0;
  for (let i = 1; i < g.length; i++) m += haversine(g[i - 1], g[i]);
  return { g, m: Math.round(m * 1000), surface: e.tags.surface ?? null };
});
const seen = new Set();
const fields = [];
for (const e of osm.filter((x) => x.tags.aeroway === 'aerodrome')) {
  const c = centre(e);
  if (!c || seen.has(e.tags.name)) continue;
  seen.add(e.tags.name);
  const p = [c.lon, c.lat];
  const rw = runways.filter((r) => distToLine(p, r.g) < 3).sort((a, b) => b.m - a.m)[0];
  const intl = /international/i.test(e.tags['aerodrome:type'] ?? '') || /International/.test(e.tags.name ?? '');
  const paved = rw && /concrete|asphalt|paved/.test(rw.surface ?? '');
  fields.push({ p, name: e.tags.name, iata: e.tags.iata ?? null, intl, runway: rw?.m ?? null, surface: rw?.surface ?? null, paved });
}

// ---------- 2. upgrades ----------
const ISLAND = /Anse-à-Galets|Île-à-Vache|Tortue/;
const STRATEGIC = /Môle/;
for (const f of fields) f.pop15 = Math.round(popWithin(f.p, 15));
const regional = new Set();
for (const [dept, cap] of Object.entries(CAPITALS)) {
  const c = capitalAt(cap);
  if (!c) continue;
  const near = fields.filter((f) => haversine(f.p, c) <= 35 && deptAt(f.p) === dept).sort((a, b) => haversine(a.p, c) - haversine(b.p, c))[0];
  if (near && !near.intl) (regional.add(near), (near.capital = cap));
}
for (const f of fields) {
  if (f.intl) continue;
  const target = ISLAND.test(f.name) ? Math.max(1200, f.runway ?? 0) : regional.has(f) || STRATEGIC.test(f.name) ? 1800 : null;
  if (target && (!f.paved || (f.runway ?? 0) < target)) f.upgrade = target;
}
const served = () => [...fields.filter((f) => (f.paved && f.runway >= 1200) || f.upgrade).map((f) => f.p), ...picked.map((s) => s.p)];

// ---------- candidate sites ----------
await dem.preload(pop.map((q) => [q[0], q[1]]), 3);
const flatFor = (p, lenKm) => {
  let best = null;
  for (let a = 0; a < 180; a += 22.5) {
    const r = (a * Math.PI) / 180;
    const pts = [];
    for (let d = -lenKm / 2; d <= lenKm / 2 + 1e-9; d += 0.2) pts.push(offset(p, Math.cos(r) * d, Math.sin(r) * d));
    const z = pts.map((q) => dem.elevation(...q));
    if (z.some((v) => !(v > 1))) continue;
    if (pts.some(nearRiver)) continue;
    const range = Math.max(...z) - Math.min(...z);
    if (!best || range < best.range) best = { range, dir: a, ends: [pts[0], pts.at(-1)] };
  }
  return best && best.range <= 20 ? best : null;
};
const cells = pop.filter((q) => inHaiti([q[0], q[1]])); // land cells inside Haiti
const dense = new Set(cells.filter((q) => q[2] > 3000).map((q) => `${q[0].toFixed(3)},${q[1].toFixed(3)}`));
const candidates = [];
for (const q of cells) {
  const p = [q[0], q[1]];
  if (dense.has(`${q[0].toFixed(3)},${q[1].toFixed(3)}`)) continue;
  const z = dem.elevation(...p);
  if (!(z > 1 && z < 250)) continue;
  const rail = toRail(p);
  if (rail > 15) continue;
  candidates.push({ p, z, rail });
}
console.log('candidate cells', candidates.length);

// ---------- 3. national cargo & backup airport ----------
const PAP = fields.find((f) => f.iata === 'PAP').p;
const CAP = fields.find((f) => f.iata === 'CAP').p;
const picked = [];
{
  const opts = candidates.filter((c) => c.rail <= 10 && haversine(c.p, PAP) >= 50 && haversine(c.p, PAP) <= 150 && haversine(c.p, CAP) > 60)
    .map((c) => ({ ...c, people: popWithin(c.p, 60) }))
    .sort((a, b) => b.people - a.people);
  for (const c of opts) {
    const flat = flatFor(c.p, 3.2);
    if (flat) { picked.push({ ...c, kind: 'airportHub', runway: 3200, flat }); break; }
  }
}

// ---------- 4. new regional airports ----------
for (const [dept, cap] of Object.entries(CAPITALS)) {
  const c = capitalAt(cap);
  if (!c || served().some((s) => haversine(s, c) <= 30)) continue;
  const near = candidates.filter((x) => haversine(x.p, c) <= 20 && deptAt(x.p) === dept).map((x) => ({ ...x, flat: flatFor(x.p, 2.0) })).filter((x) => x.flat)
    .sort((a, b) => a.flat.range - b.flat.range || haversine(a.p, c) - haversine(b.p, c));
  if (!near[0]) { console.log('no flat site near', cap); continue; }
  const S = served();
  const gap = cells.filter((q) => Math.min(...S.map((s) => haversine([q[0], q[1]], s))) > 45);
  picked.push({ ...near[0], kind: 'airportNew', runway: 2000, capital: cap, gain: gap.reduce((sum, q) => (haversine(near[0].p, q) <= 45 ? sum + q[2] : sum), 0) });
}
for (let round = 0; round < 3; round++) {
  const S = served();
  const gap = cells.filter((q) => Math.min(...S.map((s) => haversine([q[0], q[1]], s))) > 45);
  let best = null;
  for (const c of candidates) {
    if (S.some((s) => haversine(c.p, s) < 30)) continue;
    const gain = gap.reduce((sum, q) => (haversine(c.p, q) <= 45 ? sum + q[2] : sum), 0);
    if (!best || gain > best.gain) best = { ...c, gain };
  }
  if (!best || best.gain < 150000) break;
  // Flattest suitable site within 12 km of the best spot, keeping most of the gain.
  const near = candidates.filter((c) => haversine(c.p, best.p) <= 12 && !S.some((x) => haversine(c.p, x) < 30)).map((c) => ({ ...c, flat: flatFor(c.p, 2.0) })).filter((c) => c.flat).sort((a, b) => a.flat.range - b.flat.range || a.rail - b.rail);
  const site = near[0];
  if (!site) break;
  site.gain = gap.reduce((sum, q) => (haversine(site.p, q) <= 45 ? sum + q[2] : sum), 0);
  picked.push({ ...site, kind: 'airportNew', runway: 2000 });
}

// ---------- output ----------
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const out = [];
let n = 9001;
for (const f of fields) {
  out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: f.p.map(r5) }, properties: { id: `d${n++}`, theme: 'air', status: 'existing', kind: f.intl ? 'airportIntl' : 'airfield', name: f.name, iata: f.iata, runway: f.runway, surface: f.surface, dept: deptAt(f.p), src: 'osm' } });
}
for (const f of fields.filter((x) => x.upgrade)) {
  out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: f.p.map(r5) }, properties: { id: `d${n++}`, theme: 'air', status: 'proposed', kind: 'airportUpgrade', place: nearestPlace(f.p), field: f.name, capital: f.capital ?? null, runway: f.upgrade, current: f.runway, surface: f.surface, island: ISLAND.test(f.name), strategic: STRATEGIC.test(f.name), people: f.pop15, dept: deptAt(f.p) } });
}
for (const s of picked) {
  const p = s.p.map(r5);
  const props = { id: `d${n++}`, theme: 'air', status: 'proposed', kind: s.kind, place: s.capital ?? nearestPlace(s.p), capital: s.capital ?? null, runway: s.runway, elev: Math.round(s.z), rail: Math.round(toRail(s.p) * 10) / 10, dept: deptAt(s.p) };
  if (s.kind === 'airportHub') props.people = Math.round(popWithin(s.p, 60));
  else props.people = Math.round(s.gain);
  out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: props });
  // The runway itself, as a line.
  out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: s.flat.ends.map((q) => q.map(r5)) }, properties: { id: `d${n++}`, theme: 'air', status: 'proposed', kind: 'runway', place: props.place, runway: s.runway, dept: props.dept } });
}
writeFileSync(new URL('../data/airports.geojson', import.meta.url), JSON.stringify({ type: 'FeatureCollection', features: out }));
for (const f of out) {
  const p = f.properties;
  if (p.kind === 'runway') continue;
  console.log(p.status.padEnd(9), p.kind.padEnd(15), (p.name ?? p.field ?? p.place ?? '').slice(0, 44).padEnd(45), p.runway ?? '', p.current ? `(now ${p.current})` : '', p.people ? `people ${p.people}` : '', p.rail != null ? `rail ${p.rail} km` : '', p.elev != null ? `${p.elev} m` : '', p.dept);
}
