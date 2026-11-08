// Plan-wide numbers for the "Plan in numbers" page: construction mix for every route (same method as the
// Engineering & cost card in app.js) and how many people live near the new network, by department.
// Run: node tools/build-numbers.mjs  →  data/numbers.json
import { readFileSync, writeFileSync } from 'node:fs';
import { createDem } from './dem.mjs';
import { haversine, distToLine, pointInRing } from './geo.mjs';

const read = (u) => JSON.parse(readFileSync(new URL(u, import.meta.url)));
const plan = read('../data/plan.geojson');
const depts = read('../data/departments.geojson');
const pop = read('../data/pop.json');
const RAIL = 'Rail + highway';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Keep in step with ENG in app.js.
const ENG = {
  rail: { grade: 0.025, tunnels: true },
  ringNat: { grade: 0.05, tunnels: true },
  ringLocal: { grade: 0.07 },
  urban: { grade: 0.07 },
  feeder: { grade: 0.08 },
  bridge: { grade: 0.05 },
};
function engKind(p) {
  if (p.mode === RAIL) return 'rail';
  if (p.category === 'ring') return p.tier === 'local' ? 'ringLocal' : 'ringNat';
  return ENG[p.category] ? p.category : null;
}
function cumulative(c) {
  const out = [0];
  for (let i = 1; i < c.length; i++) out.push(out[i - 1] + haversine(c[i - 1], c[i]));
  return out;
}
function along(c, cum, d) {
  for (let i = 1; i < c.length; i++) {
    if (cum[i] >= d) {
      const tt = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * tt, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * tt];
    }
  }
  return c.at(-1);
}

const dem = createDem(11);
const routes = plan.features.filter((f) => f.geometry.type === 'LineString' && engKind(f.properties));
const samples = new Map();
for (const f of routes) {
  const c = f.geometry.coordinates;
  const cum = cumulative(c);
  const total = cum.at(-1);
  const n = clamp(Math.round(total * 5), 40, 180);
  samples.set(f, Array.from({ length: n + 1 }, (_, i) => ({ d: (total * i) / n, p: along(c, cum, (total * i) / n) })));
}
await dem.preload([...samples.values()].flat().map((s) => s.p), 1);

const out = { routes: {}, cover: {} };
for (const f of routes) {
  const p = f.properties;
  const e = ENG[engKind(p)];
  const s = samples.get(f).map((v) => ({ ...v, e: dem.elevation(...v.p) })).filter((v) => !Number.isNaN(v.e));
  if (s.length < 5) continue;
  const elev = s.map((v) => Math.max(0, v.e));
  const sm = elev.map((_, i) => (elev[Math.max(0, i - 1)] + elev[i] + elev[Math.min(elev.length - 1, i + 1)]) / 3);
  const n = sm.length;
  const dx = (s[1].d - s[0].d) * 1000;
  const g = e.grade * dx;
  const win = Math.max(1, Math.round((e.tunnels ? 1500 : 400) / dx));
  const avg = sm.map((_, i) => {
    let sum = 0, k = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) (sum += sm[j]), k++;
    return sum / k;
  });
  const F = avg.slice(), Bk = avg.slice();
  for (let i = 1; i < n; i++) F[i] = clamp(avg[i], F[i - 1] - g, F[i - 1] + g);
  for (let i = n - 2; i >= 0; i--) Bk[i] = clamp(avg[i], Bk[i + 1] - g, Bk[i + 1] + g);
  const parts = {};
  for (let i = 0; i < n; i++) {
    const diff = sm[i] - (F[i] + Bk[i]) / 2;
    const type = s[i].e <= 0 || diff < -25 ? 'viaduct' : diff > 40 ? (e.tunnels ? 'tunnel' : 'mountain') : 'surface';
    parts[type] = (parts[type] ?? 0) + 1;
  }
  for (const k of Object.keys(parts)) parts[k] = Math.round(((parts[k] / n) * (p.km ?? 0)) * 10) / 10;
  out.routes[p.id] = parts;
}

// People near the network: within 5 km of a ring station, and within 10 km of a national route.
const stations = plan.features.filter((f) => f.properties.category === 'station').map((f) => f.geometry.coordinates);
const natLines = plan.features
  .filter((f) => f.geometry.type === 'LineString' && f.properties.tier === 'national' && ['corridor', 'trunk', 'ring', 'bridge', 'feeder'].includes(f.properties.category))
  .map((f) => f.geometry.coordinates);
const deptOf = (pt) => depts.features.find((d) => d.geometry.coordinates.some((poly) => pointInRing(pt, poly[0])))?.properties.name ?? 'other';
const cover = { total: { people: 0, st5: 0, road10: 0 } };
for (const [x, y, v] of pop.points) {
  const pt = [x, y];
  const d = deptOf(pt);
  cover[d] ??= { people: 0, st5: 0, road10: 0 };
  const near5 = stations.some((s) => haversine(pt, s) <= 5);
  const near10 = natLines.some((c) => distToLine(pt, c) <= 10);
  for (const b of [cover.total, cover[d]]) {
    b.people += v;
    if (near5) b.st5 += v;
    if (near10) b.road10 += v;
  }
}
for (const b of Object.values(cover)) for (const k of Object.keys(b)) b[k] = Math.round(b[k]);
out.cover = cover;
writeFileSync(new URL('../data/numbers.json', import.meta.url), JSON.stringify(out));
console.log('routes', Object.keys(out.routes).length, 'cover', JSON.stringify(cover.total));
