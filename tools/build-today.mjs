// "Why this corridor": the same trip on TODAY's roads, for every rail + highway corridor.
// Drive distance and time from OSRM (OpenStreetMap data, FOSSGIS public server), the highest point and total climb
// of that road from the terrain tiles, and the straight-line distance between the two ends.
// Run: node tools/build-today.mjs  →  data/today.json   (about 1 request a second; ~1 minute)
import { readFileSync, writeFileSync } from 'node:fs';
import { createDem } from './dem.mjs';
import { haversine, densify } from './geo.mjs';

const read = (u) => JSON.parse(readFileSync(new URL(u, import.meta.url)));
const plan = read('../data/plan.geojson');
const RAIL = 'Rail + highway';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const routes = plan.features.filter((f) => f.geometry.type === 'LineString' && f.properties.mode === RAIL);

const out = {};
const geoms = new Map();
for (const f of routes) {
  const c = f.geometry.coordinates;
  const [a, b] = [c[0], c.at(-1)].map((p) => p.map((v) => v.toFixed(5)).join(','));
  const url = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${a};${b}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'haiti-infrastructure-map build script' } });
    const j = await res.json();
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.code);
    const snap = Math.max(...j.waypoints.map((w) => w.distance)) / 1000;
    const r = j.routes[0];
    out[f.properties.id] = { km: +(r.distance / 1000).toFixed(1), min: Math.round(r.duration / 60), snapKm: +snap.toFixed(1), crowKm: +haversine(c[0], c.at(-1)).toFixed(1) };
    geoms.set(f.properties.id, r.geometry.coordinates);
    console.log(f.properties.id, f.properties.name, out[f.properties.id]);
  } catch (e) {
    console.log(f.properties.id, f.properties.name, 'no route:', e.message);
  }
  await wait(1100);
}

// Highest point and total climb along today's road (smoothed, so map noise doesn't count as climbing).
const dem = createDem(11);
const pts = new Map([...geoms].map(([id, c]) => [id, densify(c, 0.2)]));
await dem.preload([...pts.values()].flat(), 1);
for (const [id, c] of pts) {
  const e = c.map((p) => Math.max(0, dem.elevation(...p))).filter((v) => !Number.isNaN(v));
  const sm = e.map((_, i) => { let s = 0, k = 0; for (let j = Math.max(0, i - 3); j <= Math.min(e.length - 1, i + 3); j++) (s += e[j]), k++; return s / k; });
  let climb = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i] > sm[i - 1]) climb += sm[i] - sm[i - 1];
  out[id].topM = Math.round(Math.max(...sm) / 10) * 10;
  out[id].climbM = Math.round(climb / 10) * 10;
}
writeFileSync(new URL('../data/today.json', import.meta.url), JSON.stringify({ source: 'OSRM (routing.openstreetmap.de) on OpenStreetMap data; terrain: Mapzen/AWS', built: new Date().toISOString().slice(0, 10), routes: out }));
console.log('wrote', Object.keys(out).length, 'routes');
