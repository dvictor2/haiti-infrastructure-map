// Geometry check: which land routes run over sea or lakes, and which route ends don't touch the network.
//   node tools/qa-geometry.mjs [path/to/plan.geojson]
import { readFileSync } from 'node:fs';
import { preload, elevation } from './dem.mjs';
import { LAND_CATS, SEA_LEVEL, densify, distToLine, pointInRing, haversine } from './geo.mjs';
import { onLand } from './coast.mjs';

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? new URL('../data/plan.geojson', import.meta.url);
const plan = JSON.parse(readFileSync(file));
const lines = plan.features.filter((f) => f.geometry.type === 'LineString' && LAND_CATS.includes(f.properties.category));
const lakes = plan.features.filter((f) => f.geometry.type === 'Polygon' && f.properties.category === 'water');
const network = plan.features.filter((f) => f.geometry.type === 'LineString' && !['water', 'border'].includes(f.properties.category));

await preload(lines.flatMap((f) => f.geometry.coordinates), 2);

const rows = [];
let totalSea = 0, totalLake = 0;
for (const f of lines) {
  const pts = densify(f.geometry.coordinates, 0.1);
  let sea = 0, lake = 0;
  for (let i = 1; i < pts.length; i++) {
    const mid = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
    const step = haversine(pts[i - 1], pts[i]);
    if (elevation(...mid) < SEA_LEVEL || !onLand(mid)) sea += step;
    else if (lakes.some((l) => pointInRing(mid, l.geometry.coordinates[0]))) lake += step;
  }
  const c = f.geometry.coordinates;
  const gap = (end) => Math.min(...network.filter((o) => o !== f).map((o) => distToLine(end, o.geometry.coordinates)));
  const gaps = [gap(c[0]), gap(c.at(-1))];
  totalSea += sea;
  totalLake += lake;
  if (sea > 0.05 || lake > 0.05 || gaps.some((g) => g > 0.15)) rows.push({ id: f.properties.id, cat: f.properties.category, tier: f.properties.tier, name: f.properties.name, km: f.properties.km, sea: +sea.toFixed(2), lake: +lake.toFixed(2), gapA: +gaps[0].toFixed(2), gapB: +gaps[1].toFixed(2) });
}
rows.sort((a, b) => b.sea + b.lake - (a.sea + a.lake));
console.log(`land routes checked: ${lines.length}`);
console.log(`over sea: ${totalSea.toFixed(1)} km · through lakes: ${totalLake.toFixed(1)} km`);
console.log(`routes over water: ${rows.filter((r) => r.sea > 0.05 || r.lake > 0.05).length}`);
const ends = rows.filter((r) => r.cat !== 'ring').flatMap((r) => [r.gapA, r.gapB]);
console.log(`route ends 0.15–2 km short of the network: ${ends.filter((g) => g > 0.15 && g <= 2).length}`);
console.log(`route ends over 2 km from any other route (termini: villages, border posts, island tips): ${ends.filter((g) => g > 2).length}`);
if (process.argv.includes('--list')) for (const r of rows) console.log(JSON.stringify(r));
