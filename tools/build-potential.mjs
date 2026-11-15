// "Potential": resources identified by the government or official studies (not our proposals), and the
// realignment of our own hydro proposals onto the government's hydropower sites.
// Run after tools/build-dev.mjs:  node tools/build-potential.mjs
// Inputs: source/potential-bme-2018.json (BME 2018 notice text, facts only), source/potential-bme-2018-map.json (symbols
// and oil zones read from the notice's maps) and source/hydro-potential-phe.json
// (PNUD / EdH / MTPTC hydropower map, positions read from its grid). Output: data/dev.geojson (rewritten).
import { readFileSync, writeFileSync } from 'node:fs';
import { haversine, pointInRing } from './geo.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const devUrl = new URL('../data/dev.geojson', import.meta.url);
const dev = JSON.parse(readFileSync(devUrl));
const plan = read('../data/plan.geojson');
const depts = read('../data/departments.geojson');
const rivers = read('../data/rivers.geojson');
const bme = read('../source/potential-bme-2018.json');
const phe = read('../source/hydro-potential-phe.json');
const bmeMap = read('../source/potential-bme-2018-map.json');

const deptOf = (q) => depts.features.find((f) => f.geometry.coordinates.some((poly) => pointInRing(q, poly[0])))?.properties.name ?? null;
const towns = plan.features.filter((f) => ['city', 'town'].includes(f.properties.category));
const nearestTown = (q) => towns.map((f) => [f.properties.name.replace(/\s*\(.*\)$/, ''), haversine(q, f.geometry.coordinates)]).sort((a, b) => a[1] - b[1])[0][0];
const riverPts = rivers.features.flatMap((f) => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates).flatMap((c) => c.map((q) => [q, f.properties.name])));
const nearestRiver = (q) => riverPts.reduce((b, [p, n]) => { const d = haversine(q, p); return d < b.d ? { d, n } : b; }, { d: Infinity });

// Start from what build-dev made: drop an earlier run's potential items and restore its realignment.
dev.features = dev.features.filter((f) => f.properties.status !== 'potential' || f.properties.kind === 'mineralBelt');
let next = Math.max(...dev.features.map((f) => Number(String(f.properties.id).slice(1)) || 0), 2999) + 1;
const add = (props, coords) => dev.features.push({ type: 'Feature', properties: { id: `d${next++}`, status: 'potential', ...props, dept: props.dept ?? deptOf(coords) }, geometry: { type: 'Point', coordinates: coords } });

// 1. Hydro: keep our proposals that sit on (within 9 km of) a government site; the study-backed Estère stays;
//    drop the rest. Government sites we did not pick become "potential".
const sites = phe.sites.map((s) => ({ ...s, used: false }));
dev.features = dev.features.filter((f) => {
  const p = f.properties;
  if (p.kind !== 'hydro' || p.status !== 'proposed') return true;
  const near = sites.map((s) => [s, haversine(s.at, f.geometry.coordinates)]).sort((a, b) => a[1] - b[1])[0];
  if (near && near[1] <= 9) { near[0].used = true; p.basis = 'phe'; p.govKm = Math.round(near[1] * 10) / 10; return true; }
  if (/Estère/.test(p.place)) { p.basis = 'study'; p.mw = 22; return true; }
  return false;
});
for (const s of sites.filter((s) => !s.used)) {
  const r = nearestRiver(s.at);
  add({ theme: 'energy', kind: 'hydro', place: r.d < 3 ? r.n : nearestTown(s.at), count: s.count > 1 ? s.count : undefined, src: 'phe', approx: true }, s.at);
}

// 2. Wind: the BME notice confirms about 50 MW around Lac Azuéi (3E study with the BME, 2008).
for (const f of dev.features) if (f.properties.kind === 'wind' && /Azu/.test(f.properties.place)) Object.assign(f.properties, { mw: 50, basis: 'bme2018' });

// 3. The Massif du Nord gold–copper belt is the government's own finding, not our proposal.
for (const f of dev.features) if (f.properties.kind === 'mineralBelt') Object.assign(f.properties, { status: 'potential', theme: 'mining', src: 'bme2018' });

// 4. Resources named in the BME notice's text, placed on the matching symbol of the BME map when one is close
//    (same kind, nearest pairs first, one symbol per site); then the map's other symbols.
const THEME = { lignite: 'energy', oil: 'energy', tarSand: 'energy', hotSpring: 'water' };
const KM = { hotSpring: 20 };
const mapSites = bmeMap.sites.map((m) => ({ ...m, used: false }));
const pairs = [];
const same = (a, b) => a === b || (b === 'goldCopper' && (a === 'gold' || a === 'copper'));
// A measured deposit takes the big symbol before a nearby showing does (+6 km handicap for showings).
bme.sites.forEach((t, i) => mapSites.forEach((m, j) => { if (same(t.kind, m.kind)) { const d = haversine(t.at, m.at); if (d <= (KM[t.kind] ?? 12)) pairs.push([d + (t.grade === 'showing' ? 6 : 0), i, j]); } }));
const placed = new Map();
for (const [, i, j] of pairs.sort((a, b) => a[0] - b[0])) if (!placed.has(i) && !mapSites[j].used) { placed.set(i, mapSites[j].at); mapSites[j].used = true; }
bme.sites.forEach((s, i) => {
  const { at, theme, ...rest } = s;
  add({ theme: theme ?? THEME[s.kind] ?? 'mining', ...rest, place: s.name, src: 'bme2018', approx: true, onMap: placed.has(i) }, placed.get(i) ?? at);
});
for (const m of mapSites.filter((m) => !m.used)) add({ theme: THEME[m.kind] ?? 'mining', kind: m.kind, grade: m.grade, place: nearestTown(m.at), src: 'bme2018', approx: true, onMap: true }, m.at);

// 5. Zones of oil interest (BME map, 2018). Not confirmed: the notice says 11 wells (1945–1977) were inconclusive.
const ZONE_NAMES = { 1: "Bassin de l'Artibonite · Plateau Central", 2: 'Île de la Gonâve · Cul-de-Sac', 3: 'Banc de Rochelois (Nippes)' };
for (const z of bmeMap.zones) dev.features.push({ type: 'Feature', properties: { id: `d${next++}`, status: 'potential', theme: 'energy', kind: 'oilZone', zone: z.zone, place: ZONE_NAMES[z.zone], src: 'bme2018', approx: true, dept: null }, geometry: { type: 'Polygon', coordinates: [z.ring] } });

writeFileSync(devUrl, JSON.stringify(dev));
const n = (st) => dev.features.filter((f) => f.properties.status === st).length;
console.log(`dev.geojson: ${n('proposed')} proposed, ${n('potential')} potential, ${n('existing')} existing`);
console.log('hydro proposed:', dev.features.filter((f) => f.properties.kind === 'hydro' && f.properties.status === 'proposed').map((f) => `${f.properties.place} (${f.properties.basis}${f.properties.govKm != null ? ' ' + f.properties.govKm + ' km' : ''})`).join(', '));
