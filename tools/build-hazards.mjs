// Hurricane history for the Hazards layer: every North Atlantic tropical cyclone since 1950 whose track passed
// within 250 km of Haiti (storms that close still bring deadly flooding rains, e.g. Sandy 2012, Melissa 2025), from NOAA NCEI IBTrACS v04r01 (public domain).
// Run: node tools/build-hazards.mjs  →  data/storms.json
// Earthquakes and active storms are fetched live by the app (USGS and NOAA allow it from the browser).
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { haversine } from './geo.mjs';

const RAW = new URL('./.cache/raw/', import.meta.url);
mkdirSync(RAW, { recursive: true });
// The full North Atlantic file, plus the global "last 3 years" file, which is updated sooner.
const BASE = 'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/';
const FILES = ['ibtracs.NA.list.v04r01.csv', 'ibtracs.last3years.list.v04r01.csv'];
for (const name of FILES) {
  const file = new URL(name, RAW);
  if (existsSync(file)) continue;
  console.log(`downloading ${name}…`);
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`IBTrACS ${name}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

// Points along Haiti's borders and coast, to measure how close a storm came.
const depts = JSON.parse(readFileSync(new URL('../data/departments.geojson', import.meta.url)));
const HAITI = depts.features.flatMap((f) => f.geometry.coordinates.flatMap((poly) => poly[0].filter((_, i) => i % 3 === 0)));
const nearHaiti = (p) => {
  if (p[0] < -78 || p[0] > -68 || p[1] < 14.5 || p[1] > 23) return Infinity;
  let best = Infinity;
  for (const h of HAITI) best = Math.min(best, haversine(p, h));
  return best;
};

const byStorm = new Map();
for (const name of FILES) {
const lines = readFileSync(new URL(name, RAW), 'utf8').split('\n');
const head = lines[0].split(',').map((s) => s.trim());
const col = (n) => head.indexOf(n);
const I = { sid: col('SID'), season: col('SEASON'), basin: col('BASIN'), name: col('NAME'), time: col('ISO_TIME'), lat: col('LAT'), lon: col('LON'), wind: col('USA_WIND'), sshs: col('USA_SSHS'), nature: col('NATURE') };
const seen = new Set();
for (let i = 2; i < lines.length; i++) {
  const c = lines[i].split(',');
  if (c.length < head.length / 2) continue;
  const season = Number(c[I.season]);
  if (!(season >= 1950) || c[I.basin] !== 'NA') continue;
  // A storm already read from an earlier file is skipped, so its points are not doubled.
  if (byStorm.has(c[I.sid]) && !seen.has(c[I.sid])) continue;
  seen.add(c[I.sid]);
  const p = { t: c[I.time], lat: Number(c[I.lat]), lon: Number(c[I.lon]), wind: Number(c[I.wind]) || null, sshs: Number(c[I.sshs]), nature: c[I.nature] };
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
  if (!byStorm.has(c[I.sid])) byStorm.set(c[I.sid], { sid: c[I.sid], season, name: c[I.name].trim(), pts: [] });
  byStorm.get(c[I.sid]).pts.push(p);
}
}

const storms = [];
for (const s of byStorm.values()) {
  let closest = Infinity, near = null;
  let catNear = -9, windNear = 0;
  for (const p of s.pts) {
    const d = nearHaiti([p.lon, p.lat]);
    if (d < closest) [closest, near] = [d, p];
    if (d <= 250) {
      if (p.sshs > catNear) catNear = p.sshs;
      if (p.wind > windNear) windNear = p.wind;
    }
  }
  if (closest > 250 || catNear < -1) continue; // keep tropical depressions and stronger
  // Track around the Caribbean, every 6 hours.
  const inBox = (p) => p.lon > -95 && p.lon < -50 && p.lat > 8 && p.lat < 35;
  const first = s.pts.findIndex(inBox);
  const last = s.pts.length - 1 - [...s.pts].reverse().findIndex(inBox);
  const track = s.pts.slice(first, last + 1).filter((p, i, a) => /(00|06|12|18):00:00$/.test(p.t) || i === 0 || i === a.length - 1);
  storms.push({
    id: s.sid,
    name: s.name === 'NOT_NAMED' || s.name === 'UNNAMED' ? '' : s.name[0] + s.name.slice(1).toLowerCase(),
    year: s.season,
    cat: catNear, // Saffir-Simpson category near Haiti: -1 depression, 0 tropical storm, 1-5 hurricane
    wind: windNear || null, // knots
    km: Math.round(closest),
    date: near.t.slice(0, 10),
    coords: track.map((p) => [Math.round(p.lon * 100) / 100, Math.round(p.lat * 100) / 100]),
  });
}
storms.sort((a, b) => b.year - a.year);
writeFileSync(new URL('../data/storms.json', import.meta.url), JSON.stringify({ source: 'NOAA NCEI IBTrACS v04r01', storms }));
const n = (c) => storms.filter((s) => s.cat === c).length;
console.log(`storms: ${storms.length} (depressions ${n(-1)}, storms ${n(0)}, cat1 ${n(1)}, cat2 ${n(2)}, cat3 ${n(3)}, cat4 ${n(4)}, cat5 ${n(5)})`);
console.log(storms.filter((s) => s.cat >= 3).map((s) => `${s.name} ${s.year} c${s.cat} ${s.km}km`).join(', '));
