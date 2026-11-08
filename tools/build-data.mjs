// Builds the map's data files from the master-plan specs.
//   node tools/build-data.mjs
// Reads  source/haitiProjectSpecs.js  (the 305-item plan exported from Google Earth / KML)
//        source/departments.json      (Natural Earth admin-1 outlines for Haiti, public domain)
// Writes data/plan.geojson and data/departments.geojson

import { readFileSync, writeFileSync } from 'node:fs';
import { HAITI_PROJECT_SPECS } from '../source/haitiProjectSpecs.js';

const departments = JSON.parse(readFileSync(new URL('../source/departments.json', import.meta.url)));

// Short explanations for some sites, by original label; the text itself is translated in i18n-ux.js (about.<key>).
const ABOUT = { 'Beloc Potential NC Site': 'beloc', 'MSP(Maximum Security Prison)': 'msp', MSP: 'msp' };

// Light clean-up of display names. The originals are kept in `original`.
const RENAMES = {
  'Bigest metal mines': 'Biggest metal mines',
  'Beloc Potential NC Site': 'Beloc',
  'Jeremie to Port Salue': 'Jérémie to Port-Salut',
  'Port Salue to Cayes': 'Port-Salut to Les Cayes',
  'Cayes to Jeremie': 'Les Cayes to Jérémie',
  'Saint-Mark to PAP': 'Saint-Marc to Port-au-Prince',
  'Anse A pitre to Jacmel': 'Anse-à-Pitre to Jacmel',
  'Jacmel to P-Goave': 'Jacmel to Petit-Goâve',
  'Jacmel to PAP': 'Jacmel to Port-au-Prince',
  'Jacmel to Cayes': 'Jacmel to Les Cayes',
  'PAP to Jimani(DR)': 'Port-au-Prince to Jimaní (DR)',
  'AZUEI LAKE': 'Lake Azuéi',
  'Miragoane Lake': 'Lake Miragoâne',
  'Miragoane Small Lake': 'Small Lake Miragoâne',
  'FORT LIBERTE BAY': 'Fort-Liberté Bay',
  'FLB BRIDGE': 'Fort-Liberté Bay Bridge',
  'BRIDGE Cayes to Ile a Vache': 'Bridge: Les Cayes to Île-à-Vache',
  'HAITI-DR Border': 'Haiti–DR border (north)',
  'DR-Haiti Border': 'Haiti–DR border (centre)',
  Border: 'Haiti–DR border (south)',
  'MSP(Maximum Security Prison)': 'MSP — Maximum Security Prison',
  MSP: 'MSP — Maximum Security Prison',
};

const DEPT_HINTS = {
  Ouest: 'Ouest', Nord: 'Nord', 'Nord-Est': 'Nord-Est', 'Nord-Ouest': 'Nord-Ouest', Centre: 'Centre',
  Artibonite: 'Artibonite', "Grand'Anse": "Grand'Anse", Nippes: 'Nippes', Sud: 'Sud', 'Sud-Est': 'Sud-Est',
  'PAP Metro': 'Ouest',
  'PAP Grid': 'Ouest', 'Cap Grid': 'Nord', 'Cayes Grid': 'Sud', 'Gonaïves Grid': 'Artibonite', 'St-Marc Grid': 'Artibonite',
  'Hinche Grid': 'Centre', 'Jacmel Grid': 'Sud-Est', 'Jérémie Grid': "Grand'Anse", 'Miragoâne Grid': 'Nippes',
  'Ouanaminthe Grid': 'Nord-Est', 'Port-de-Paix Grid': 'Nord-Ouest',
};

const CATEGORY_ORDER = ['corridor', 'trunk', 'bridge', 'ferry', 'ring', 'urban', 'feeder', 'station', 'toll', 'terminal', 'rivercross', 'water', 'border', 'city', 'town', 'site'];
const PAP_LINES = /^LOCAL: (Route de Delmas|Airport & Tabarre Line|Coastal Metro Line|Bourdon)/;

function classify(spec) {
  const n = spec.label;
  const local = spec.tier === 'local';
  if (spec.type === 'pin') {
    if (/lake|lac\b|bay|trou caiman/i.test(n)) return 'water';
    if (local) return 'town';
    if (/\((Ouest|Nord|Nord-Est|Nord-Ouest|Centre|Artibonite|Grand'Anse|Nippes|Sud|Sud-Est)\)$/.test(n) || /Île|Gonâve|Belladère/.test(n)) return 'city';
    return 'site';
  }
  if (spec.color === 'red') return 'border';
  if (spec.color === 'cyan') return 'water';
  if (spec.type === 'area') return spec.color === 'cyan' ? 'water' : 'site';
  if (/^(RING BELTWAY|LOCAL RING)\b|Périphérique/i.test(n)) return 'ring';
  if (/ISLAND LINK|FERRY/i.test(n)) return 'ferry';
  if (/BRIDGE/i.test(n)) return 'bridge';
  if (/ISLAND SPINE/i.test(n)) return 'corridor';
  if (local) return /Grid\)/.test(n) || PAP_LINES.test(n) ? 'urban' : 'feeder';
  if (spec.color === 'green') return 'corridor';
  return 'trunk';
}

function cleanName(raw) {
  let name = RENAMES[raw] ?? raw;
  let subtitle = '';
  const localTag = name.match(/^LOCAL\s*\(([^)]*Grid)\):/)?.[1] ?? '';
  name = name
    .replace(/^PROPOSED\s+/i, '')
    .replace(/^RING BELTWAY:\s*/i, '')
    .replace(/^LOCAL RING:\s*/i, '')
    .replace(/^LOCAL(\s*\([^)]*\))?:\s*/i, '')
    .replace(/^(RIVER|LAKE):\s*/i, '');
  // "North (Seg 1): Saint-Marc to Gonaïves (Artibonite Plain)" → name + subtitle
  const colon = name.match(/^([^:]{2,60}):\s*(.+)$/);
  if (colon) {
    subtitle = colon[1].trim();
    name = colon[2].trim();
  }
  const paren = name.match(/^(.*?)\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)\s*$/);
  if (paren && paren[1].length > 2) {
    subtitle = subtitle ? `${subtitle} · ${paren[2]}` : paren[2];
    name = paren[1];
  }
  const tidy = (t) => t.replace(/\b([A-Z][A-Z-]{3,})\b/g, (w) => w[0] + w.slice(1).toLowerCase()).replace(/(\d)km\b/g, '$1 km');
  if (!subtitle && localTag) subtitle = localTag;
  const fix = (t) => tidy(t.trim()).replace(/Môle Saint-Nicolas/g, 'Môle-Saint-Nicolas');
  return { name: fix(name), subtitle: fix(subtitle) };
}

const R = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const lengthKm = (path) => path.slice(1).reduce((s, p, i) => s + haversine(path[i], p), 0);

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function deptAt(pt) {
  for (const f of departments.features) {
    for (const poly of f.geometry.coordinates) {
      if (pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h))) return f.properties.name;
    }
  }
  // Offshore (islands, bridges): nearest department label point.
  let best = null;
  let bestD = Infinity;
  for (const f of departments.features) {
    for (const poly of f.geometry.coordinates) {
      for (const v of poly[0]) {
        const d = haversine(pt, v);
        if (d < bestD) { bestD = d; best = f.properties.name; }
      }
    }
  }
  return best;
}
function deptFor(spec, coords) {
  const hint = spec.label.match(/\(([^()]+)\)\s*$/)?.[1] ?? spec.label.match(/^LOCAL \(([^)]+)\)/)?.[1];
  if (hint && DEPT_HINTS[hint.replace(/ Local$/, '')]) return DEPT_HINTS[hint.replace(/ Local$/, '')];
  if (spec.type === 'pin') return deptAt(coords);
  const pts = spec.type === 'area' ? coords[0] : coords;
  return deptAt(pts[Math.floor(pts.length / 2)]);
}
// Base tunnels named in the plan (from the route names and the Antigravity handoff).
function tunnelFor(label) {
  if (/^Cayes to Jeremie$/i.test(label)) return 'Camp-Perrin & Macaya base tunnels';
  const m = label.match(/(Morne-à-Cabrit|Massif du Nord|Montagnes Noires) Tunnel/);
  return m ? `${m[1]} base tunnel` : undefined;
}

function modeFor(category, spec) {
  const local = spec.tier === 'local';
  switch (category) {
    case 'corridor':
    case 'trunk':
      return 'Rail + highway';
    case 'bridge':
      return /spine/i.test(spec.label) || /Ile a Vache/i.test(spec.label) ? 'Bridge + island road' : 'Fixed bridge';
    case 'ferry':
      return 'Express Ro-Ro ferry';
    case 'ring':
      return local ? 'Municipal bypass road' : 'Ring highway + rail gates';
    case 'urban':
      return 'Urban arterial / BRT';
    case 'feeder':
      return 'Regional road';
    default:
      return null;
  }
}
const r5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

// Corrected shapes from tools/fix-geometry.mjs (skipped with --raw, which rebuilds from the original drawing).
const RAW = process.argv.includes('--raw');
let FIXES = {};
try {
  if (!RAW) FIXES = JSON.parse(readFileSync(new URL('../source/geometry-fixes.json', import.meta.url)));
} catch {
  /* no fixes yet */
}

const features = HAITI_PROJECT_SPECS.map((spec, i) => {
  const category = classify(spec);
  const { name, subtitle } = cleanName(spec.label);
  let geometry;
  let km = null;
  if (spec.type === 'pin') {
    geometry = { type: 'Point', coordinates: r5([spec.longitude, spec.latitude]) };
  } else if (FIXES[i + 1] && spec.type === 'route') {
    geometry = { type: 'LineString', coordinates: FIXES[i + 1] };
    km = lengthKm(FIXES[i + 1]);
  } else if (spec.type === 'area') {
    const ring = spec.ring.map(r5);
    if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) ring.push(ring[0]);
    geometry = { type: 'Polygon', coordinates: [ring] };
    km = lengthKm(ring);
  } else {
    geometry = { type: 'LineString', coordinates: spec.path.map(r5) };
    km = lengthKm(spec.path);
  }
  const dept = category === 'border' ? null : deptFor(spec, geometry.coordinates);
  return {
    type: 'Feature',
    id: i + 1,
    properties: {
      id: i + 1,
      name,
      subtitle,
      original: spec.label,
      category,
      tier: spec.tier === 'local' ? 'local' : 'national',
      kind: spec.type,
      dept,
      km: km == null ? null : Math.round(km * 10) / 10,
      sort: CATEGORY_ORDER.indexOf(category),
      mode: modeFor(category, spec),
      tunnel: tunnelFor(spec.label),
      ...(ABOUT[spec.label] ? { about: ABOUT[spec.label] } : {}),
    },
    geometry,
  };
});

// The Haiti–DR border was drawn as three pieces; join them into one continuous line (north to south).
{
  const parts = features.filter((f) => f.properties.category === 'border');
  if (parts.length > 1) {
    const segs = parts.map((f) => f.geometry.coordinates.slice());
    const start = segs.reduce((a, b) => (Math.max(b[0][1], b.at(-1)[1]) > Math.max(a[0][1], a.at(-1)[1]) ? b : a));
    if (start[0][1] < start.at(-1)[1]) start.reverse();
    let line = start.slice();
    const rest = segs.filter((s) => s !== start);
    while (rest.length) {
      const end = line.at(-1);
      let best = 0, flip = false, bd = Infinity;
      rest.forEach((s, i) => {
        const d0 = haversine(end, s[0]), d1 = haversine(end, s.at(-1));
        if (d0 < bd) [bd, best, flip] = [d0, i, false];
        if (d1 < bd) [bd, best, flip] = [d1, i, true];
      });
      const s = rest.splice(best, 1)[0];
      line = line.concat(flip ? s.reverse() : s);
    }
    const keep = parts[0];
    keep.geometry.coordinates = line;
    keep.properties.name = 'Haiti–DR border';
    keep.properties.subtitle = '';
    keep.properties.km = Math.round(lengthKm(line) * 10) / 10;
    for (const f of parts.slice(1)) features.splice(features.indexOf(f), 1);
  }
}

// ---------------------------------------------------------------------------
// Derived features (computed from the plan's own geometry and rules)
// ---------------------------------------------------------------------------
const kxy = (lat) => [111.32 * Math.cos((lat * Math.PI) / 180), 110.57];
function distToLine(p, coords) {
  const [kx, ky] = kxy(p[1]);
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p[0]) * kx, ay = (coords[i - 1][1] - p[1]) * ky;
    const bx = (coords[i][0] - p[0]) * kx, by = (coords[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-12)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const plain = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const ALIASES = [[/\bpap\b/, 'port-au-prince'], [/\bst-marc\b/, 'saint-marc'], [/^cayes\b/, 'les cayes'], [/\bjeremie\b/, 'jeremie']];
function placeKey(s) {
  let t = plain(s).replace(/\(.*?\)/g, '').replace(/\bvia\b.*$/, '').replace(/corridor/g, '').trim();
  for (const [re, v] of ALIASES) t = t.replace(re, v);
  return t;
}
function prettyPlace(s) {
  return s.replace(/\(.*?\)/g, '').replace(/\bvia\b.*$/i, '').replace(/\bCorridor\b/g, '').replace(/^PAP$/, 'Port-au-Prince').replace(/^Cayes$/, 'Les Cayes').replace(/\s+/g, ' ').trim();
}
const compass = (c, p) => {
  const a = (Math.atan2(p[1] - c[1], (p[0] - c[0]) * Math.cos((c[1] * Math.PI) / 180)) * 180) / Math.PI;
  return ['Est', 'Nord-Est', 'Nord', 'Nord-Ouest', 'Ouest', 'Sud-Ouest', 'Sud', 'Sud-Est'][Math.round(((a + 360) % 360) / 45) % 8];
};
let nextId = HAITI_PROJECT_SPECS.length + 1;
const derived = [];
const pointFeature = (props, coords) => {
  const id = nextId++;
  derived.push({
    type: 'Feature',
    id,
    properties: { id, tier: 'national', kind: 'pin', km: null, original: '', derived: true, sort: CATEGORY_ORDER.indexOf(props.category), dept: deptAt(coords), ...props },
    geometry: { type: 'Point', coordinates: r5(coords) },
  });
};

// 1. Ring stations ("Portes"): where a national rail + highway trunk meets a national Périphérique.
const rings = features.filter((f) => f.properties.category === 'ring' && f.properties.tier === 'national');
const trunks = features.filter((f) => ['corridor', 'trunk'].includes(f.properties.category) && f.geometry.type === 'LineString');
for (const ring of rings) {
  const rc = ring.geometry.coordinates;
  const center = [rc.reduce((s, p) => s + p[0], 0) / rc.length, rc.reduce((s, p) => s + p[1], 0) / rc.length];
  const city = ring.properties.name.replace(/\s*Périphérique$/, '');
  const hits = [];
  for (const t of trunks) {
    const c = t.geometry.coordinates;
    for (const end of [c[0], c.at(-1)]) {
      if (distToLine(end, rc) > 0.6) continue;
      const parts = t.properties.name.split(/\s+(?:to|↔)\s+/i);
      const other = parts.find((p) => !placeKey(p).includes(placeKey(city).slice(0, 6))) ?? null;
      hits.push({ p: end, dest: other ? prettyPlace(other) : null, route: t.properties.name });
    }
  }
  const clusters = [];
  for (const h of hits) {
    const c = clusters.find((k) => haversine(k.p, h.p) < 1.2);
    if (c) c.items.push(h);
    else clusters.push({ p: h.p, items: [h] });
  }
  for (const c of clusters) {
    const dests = [...new Set(c.items.map((i) => i.dest).filter(Boolean))];
    const label = dests.length ? dests.slice(0, 2).join(' / ') + (dests.length > 2 ? ` +${dests.length - 2}` : '') : compass(center, c.p);
    pointFeature({
      category: 'station',
      name: `${city} · Porte ${label}`,
      subtitle: `${city} Périphérique · rail & bus transfer station`,
      mode: 'Rail + bus transfer station',
      city,
      serves: [...new Set(c.items.map((i) => i.route))].join(' · '),
    }, c.p);
  }
}

// 2. Ro-Ro ferry terminals at both ends of each ferry crossing.
for (const f of features.filter((x) => x.properties.category === 'ferry')) {
  const c = f.geometry.coordinates;
  const parts = f.properties.name.split(/\s+to\s+/i).map(prettyPlace);
  [c[0], c.at(-1)].forEach((p, i) => {
    pointFeature({
      category: 'terminal',
      name: `Ro-Ro terminal: ${parts[i] ?? (i ? 'island side' : 'mainland side')}`,
      subtitle: `${f.properties.name} · roll-on / roll-off vehicle & freight ferry`,
      mode: 'Ferry terminal',
      place: parts[i] ?? '',
      serves: f.properties.name,
    }, p);
  });
}

// 3. River bridges: where a national trunk or Périphérique crosses a mapped river.
function segX(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}
const rivers = features.filter((f) => f.properties.category === 'water' && f.geometry.type === 'LineString');
const crossers = features.filter((f) => f.geometry.type === 'LineString' && f.properties.tier === 'national' && ['corridor', 'trunk', 'ring'].includes(f.properties.category));
const crossings = [];
for (const rv of rivers) {
  const rc = rv.geometry.coordinates;
  for (const rd of crossers) {
    const dc = rd.geometry.coordinates;
    for (let i = 1; i < rc.length; i++) {
      for (let j = 1; j < dc.length; j++) {
        const x = segX(rc[i - 1], rc[i], dc[j - 1], dc[j]);
        if (!x) continue;
        const near = crossings.find((k) => k.river === rv.properties.name && haversine(k.p, x) < 1.5);
        if (near) near.routes.add(rd.properties.name);
        else crossings.push({ p: x, river: rv.properties.name, routes: new Set([rd.properties.name]) });
      }
    }
  }
}
for (const k of crossings) {
  const routes = [...k.routes];
  pointFeature({
    category: 'rivercross',
    name: `Bridge over ${k.river.replace(/\s*\(.*\)$/, '')}`,
    subtitle: routes.join(' · '),
    mode: 'River bridge',
    river: k.river.replace(/\s*\(.*\)$/, ''),
    serves: routes.join(' · '),
  }, k.p);
}
// 4. Toll stations (péages) where a national rail + highway corridor passes from one department to another.
const tolls = [];
for (const t of trunks) {
  const c = t.geometry.coordinates;
  let prev = null, prevDept = null;
  for (let i = 1; i < c.length; i++) {
    const n = Math.max(1, Math.ceil(haversine(c[i - 1], c[i]) / 0.3));
    for (let k = 0; k <= n; k++) {
      const p = [c[i - 1][0] + ((c[i][0] - c[i - 1][0]) * k) / n, c[i - 1][1] + ((c[i][1] - c[i - 1][1]) * k) / n];
      const d = deptAt(p);
      if (prevDept && d && d !== prevDept) {
        const at = [(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2];
        const nearRing = rings.some((r) => distToLine(at, r.geometry.coordinates) < 3);
        const pair = [prevDept, d].sort().join('|');
        if (!nearRing && !tolls.some((x) => haversine(x.p, at) < 4 || (x.route === t.properties.name && x.pair === pair))) tolls.push({ p: at, from: prevDept, to: d, route: t.properties.name, pair });
      }
      if (d) [prev, prevDept] = [p, d];
    }
  }
}
for (const x of tolls) {
  pointFeature({ category: 'toll', name: `Péage ${x.from} – ${x.to}`, subtitle: x.route, mode: 'Toll station', from: x.from, to: x.to, serves: x.route }, x.p);
}
features.push(...derived);

writeFileSync(new URL('../data/plan.geojson', import.meta.url), JSON.stringify({ type: 'FeatureCollection', features }));
writeFileSync(new URL('../data/departments.geojson', import.meta.url), JSON.stringify(departments));

const summary = {};
for (const f of features) {
  const k = f.properties.category;
  summary[k] ??= { count: 0, km: 0 };
  summary[k].count++;
  summary[k].km += f.properties.km ?? 0;
}
console.log(features.length, 'features');
for (const [k, v] of Object.entries(summary)) console.log(k.padEnd(9), String(v.count).padStart(4), `${Math.round(v.km)} km`);
