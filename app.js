/* Haiti Infrastructure Plan — interactive map
 * Plain ES module, no build step. MapLibre GL is loaded as a global from unpkg in index.html.
 */
import { t, setLang, getLang, pickInitialLang, LANGS, locale } from './i18n.js';

const maplibregl = window.maplibregl;
setLang(pickInitialLang());

// ---------------------------------------------------------------------------
// Categories (order = drawing / list order)
// ---------------------------------------------------------------------------
const CATS = {
  corridor: { color: '#34D399', swatch: 'rail', road: true },
  trunk: { color: '#F5A524', swatch: 'rail', road: true },
  bridge: { color: '#7DD3FC', swatch: 'line', road: true },
  ferry: { color: '#7DD3FC', swatch: 'dash', road: true },
  ring: { color: '#B794F6', swatch: 'ring', road: true },
  urban: { color: '#F9A8D4', swatch: 'thin', road: true },
  feeder: { color: '#FDE68A', swatch: 'thin', road: true },
  station: { color: '#E9D5FF', swatch: 'square' },
  terminal: { color: '#7DD3FC', swatch: 'square' },
  rivercross: { color: '#67E8F9', swatch: 'square' },
  water: { color: '#22D3EE', swatch: 'line' },
  border: { color: '#F43F5E', swatch: 'dash' },
  city: { color: '#FFFFFF', swatch: 'dot' },
  town: { color: '#CBD5E1', swatch: 'dot' },
  site: { color: '#FB923C', swatch: 'dot' },
};
// Category names in the current language: [plural, singular, hint].
const catLabel = (k) => t(`cat.${k}`)[0];
const catOne = (k) => t(`cat.${k}`)[1];
const catHint = (k) => t(`cat.${k}`)[2];
// Modes are stored in English in the data; this maps them to translation keys.
const MODE_KEY = {
  'Rail + highway': 'mode.rail', 'Bridge + island road': 'mode.bridgeIsland', 'Fixed bridge': 'mode.bridge',
  'Express Ro-Ro ferry': 'mode.ferry', 'Ring highway + rail gates': 'mode.ringNat', 'Municipal bypass road': 'mode.ringLocal',
  'Urban arterial / BRT': 'mode.urban', 'Regional road': 'mode.feeder', 'Rail + bus transfer station': 'mode.station',
  'Ferry terminal': 'mode.terminal', 'River bridge': 'mode.river',
};
const tunnelName = (s) => s.replace(/\s*base tunnels?$/i, '');
const modeText = (p) => (p.mode ? t(MODE_KEY[p.mode] ?? p.mode) : null);
// Derived points get their names built in the current language.
function displayName(p) {
  if (p.category === 'terminal') return t('name.terminal') + p.place;
  if (p.category === 'rivercross') return t('name.river') + p.river;
  return p.name;
}
function displaySub(p) {
  if (p.category === 'station') return `${p.city} Périphérique · ${t('mode.station')}`;
  if (p.category === 'terminal') return `${p.serves} · ${catHint('ferry')}`;
  return p.subtitle;
}
const INFRA = ['station', 'terminal', 'rivercross'];
const RAIL_MODE = 'Rail + highway';
const CAT_KEYS = Object.keys(CATS);
const ROAD_CATS = CAT_KEYS.filter((k) => CATS[k].road);
const LOCAL_MINZOOM = 8.6;
const HAITI_BOUNDS = [[-74.55, 17.95], [-71.6, 20.12]];
const PHONE = window.matchMedia('(max-width: 760px)');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtKm = (km) => (km == null ? '—' : km < 10 ? `${km.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km` : `${Math.round(km).toLocaleString(locale())} km`);
const fmtM = (m) => `${Math.round(m).toLocaleString(locale())} m`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}
function cumulative(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
  return out;
}
function along(coords, cum, d) {
  if (d <= 0) return coords[0];
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] >= d) {
      const seg = cum[i] - cum[i - 1] || 1;
      const t = (d - cum[i - 1]) / seg;
      return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t];
    }
  }
  return coords.at(-1);
}
function bearing([lon1, lat1], [lon2, lat2]) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
// Planar point-to-segment distance in km (fine at this scale).
function distToLineKm(p, coords) {
  const kx = 111.32 * Math.cos(rad(p[1]));
  const ky = 110.57;
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p[0]) * kx, ay = (coords[i - 1][1] - p[1]) * ky;
    const bx = (coords[i][0] - p[0]) * kx, by = (coords[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    const t = clamp(-(ax * dx + ay * dy) / len2, 0, 1);
    const cx = ax + t * dx, cy = ay + t * dy;
    best = Math.min(best, Math.hypot(cx, cy));
  }
  return best;
}
function bboxOf(coords) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
}
const flatCoords = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0] : g.coordinates.flat(2));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  hidden: new Set(),
  dept: null,
  selected: null,
  hover: null,
  localAlways: false,
  terrain: true,
  base: 'satellite',
  collapsed: false,
  rail: true,
};
let plan, depts, byId;

// ---------------------------------------------------------------------------
// Map style
// ---------------------------------------------------------------------------
// Haitian place names stay in their local (French) form, or Kreyòl when that language is chosen.
const osmName = () => (getLang() === 'ht' ? ['coalesce', ['get', 'name:ht'], ['get', 'name:fr'], ['get', 'name']] : ['coalesce', ['get', 'name:fr'], ['get', 'name']]);
const osmCountryName = () => ['coalesce', ['get', `name:${getLang()}`], ['get', 'name:en'], ['get', 'name']];
const style = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    osm: {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
      attribution: 'Labels © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="https://openfreemap.org">OpenFreeMap</a>',
    },
    streets: {
      type: 'raster',
      tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png`),
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    },
    dem: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Terrain: Mapzen, AWS Open Data',
    },
    demShade: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } },
    { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.88, 'raster-contrast': 0.08 } },
    { id: 'streets', type: 'raster', source: 'streets', layout: { visibility: 'none' } },
    { id: 'hillshade', type: 'hillshade', source: 'demShade', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3b3f46' } },
    ...osmLabelLayers(),
  ],
};

// Read before the map is created: MapLibre writes its own `v=` into the hash on start-up.
const hadView = /(^|[#&])v=/.test(location.hash);
// Place, water, peak and airport names from OpenStreetMap vector tiles.
// The island-wide "Hispaniola" / "Española" label is filtered out on purpose.
function osmLabelLayers() {
  const halo = { 'text-halo-color': '#05070a', 'text-halo-width': 1.4 };
  const name = osmName();
  const notIsland = ['!', ['in', ['get', 'name'], ['literal', ['Hispaniola', 'La Española', 'Española', 'Hispaniola Island', 'Isla La Española', 'Haïti / Hispaniola']]]];
  return [
    { id: 'osm-water', type: 'symbol', source: 'osm', 'source-layer': 'water_name', minzoom: 7, filter: ['in', ['get', 'class'], ['literal', ['bay', 'lake', 'strait', 'lagoon']]], layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 11, 'text-max-width': 8 }, paint: { 'text-color': '#9EDCF0', ...halo } },
    { id: 'osm-peak-dot', type: 'circle', source: 'osm', 'source-layer': 'mountain_peak', minzoom: 8.5, filter: ['all', ['has', 'name'], ['>', ['coalesce', ['get', 'ele'], 0], 900]], paint: { 'circle-radius': 2.5, 'circle-color': '#F5F5F4', 'circle-stroke-color': '#05070a', 'circle-stroke-width': 1 } },
    { id: 'osm-peaks', type: 'symbol', source: 'osm', 'source-layer': 'mountain_peak', minzoom: 8.5, filter: ['all', ['has', 'name'], ['>', ['coalesce', ['get', 'ele'], 0], 900]], layout: { 'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['concat', ['to-string', ['get', 'ele']], ' m'], { 'font-scale': 0.85 }], 'text-font': ['Noto Sans Italic'], 'text-size': 10.5, 'text-anchor': 'top', 'text-offset': [0, 0.5], 'text-optional': true }, paint: { 'text-color': '#E7E5E4', ...halo } },
    { id: 'osm-airports', type: 'symbol', source: 'osm', 'source-layer': 'aerodrome_label', minzoom: 8.5, filter: ['has', 'name'], layout: { 'text-field': ['concat', '✈ ', name], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'top', 'text-max-width': 9, 'text-optional': true }, paint: { 'text-color': '#BAE6FD', ...halo } },
    ...[
      ['osm-country', ['country'], 0, 8, 12],
      ['osm-towns', ['city', 'town'], 8.5, 24, 11.5],
      ['osm-islands', ['island'], 9, 24, 11],
      ['osm-villages', ['village'], 10.5, 24, 10.5],
      ['osm-suburbs', ['suburb', 'neighbourhood', 'quarter'], 12.5, 24, 10.5],
    ].map(([id, classes, minzoom, maxzoom, size]) => ({
      id, type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom, maxzoom,
      filter: ['all', notIsland, ['in', ['get', 'class'], ['literal', classes]]],
      layout: { 'text-field': id === 'osm-country' ? osmCountryName() : name, 'text-font': ['Noto Sans Regular'], 'text-size': size, 'text-max-width': 8, ...(id === 'osm-country' ? { 'text-transform': 'uppercase', 'text-letter-spacing': 0.15 } : {}) },
      paint: { 'text-color': id === 'osm-country' ? '#CBD5E1' : '#E2E8F0', 'text-opacity': 0.9, ...halo },
    })),
  ];
}

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [-72.75, 18.95],
  zoom: PHONE.matches ? 6.2 : 7.2,
  pitch: 0,
  minZoom: 4,
  maxPitch: 75,
  hash: 'v',
  attributionControl: { compact: true },
  dragRotate: true,
});
window.__map = map; // handy for debugging in the console

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------
const catColor = ['match', ['get', 'category'], ...CAT_KEYS.flatMap((k) => [k, CATS[k].color]), '#ffffff'];
const widthAt = (z) => {
  const w = { 6: [2.2, 2.2, 2.2, 1.6, 1.7, 1, 1, 1.3, 1.4], 12: [5.5, 5.5, 5, 3.2, 4, 2.8, 2.8, 3, 2.6] }[z];
  return ['match', ['get', 'category'], 'corridor', w[0], 'trunk', w[1], 'bridge', w[2], 'ferry', w[3], 'ring', w[4], 'feeder', w[5], 'urban', w[6], 'water', w[7], 'border', w[8], 1.5];
};
const lineWidth = ['interpolate', ['linear'], ['zoom'], 6, widthAt(6), 12, widthAt(12), 16, ['*', 1.6, widthAt(12)]];
const widthPlus = (n6, n12 = n6) => ['interpolate', ['linear'], ['zoom'], 6, ['+', n6, widthAt(6)], 12, ['+', n12, widthAt(12)], 16, ['+', n12, ['*', 1.6, widthAt(12)]]];
const casingWidth = widthPlus(2, 3);
const infraLabel = () => ['match', ['get', 'category'], 'terminal', ['concat', t('name.terminal'), ['get', 'place']], 'rivercross', ['concat', t('name.river'), ['get', 'river']], ['get', 'name']];
const isLine = ['==', ['geometry-type'], 'LineString'];
const isPoly = ['==', ['geometry-type'], 'Polygon'];
const isPoint = ['==', ['geometry-type'], 'Point'];
const inCats = (list) => ['in', ['get', 'category'], ['literal', list]];
const tierIs = (t) => ['==', ['get', 'tier'], t];

// Each data layer: id → base filter. Visibility/department filters are added on top.
const DATA_LAYERS = [
  { id: 'water-fill', filter: ['all', isPoly, inCats(['water'])], type: 'fill', paint: { 'fill-color': '#22D3EE', 'fill-opacity': 0.32 } },
  { id: 'site-fill', filter: ['all', isPoly, inCats(['site'])], type: 'fill', paint: { 'fill-color': '#FB923C', 'fill-opacity': 0.3 } },
  { id: 'site-outline', filter: ['all', isPoly, inCats(['site'])], type: 'line', paint: { 'line-color': '#FB923C', 'line-width': 1.5 } },
  { id: 'casing-local', filter: ['all', isLine, tierIs('local'), ['!', inCats(['ferry', 'border'])]], type: 'line', minzoom: LOCAL_MINZOOM, local: true, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#05070a', 'line-opacity': 0.5, 'line-width': casingWidth } },
  { id: 'lines-local', filter: ['all', isLine, tierIs('local'), ['!', inCats(['ferry', 'border'])]], type: 'line', minzoom: LOCAL_MINZOOM, local: true, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': catColor, 'line-width': lineWidth } },
  { id: 'casing-national', filter: ['all', isLine, tierIs('national'), ['!', inCats(['ferry', 'border'])]], type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#05070a', 'line-opacity': 0.55, 'line-width': casingWidth } },
  { id: 'lines-national', filter: ['all', isLine, tierIs('national'), ['!', inCats(['ferry', 'border'])]], type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': catColor, 'line-width': lineWidth } },
  { id: 'casing-dashed', filter: ['all', isLine, inCats(['ferry', 'border'])], type: 'line', layout: { 'line-join': 'round' }, paint: { 'line-color': '#05070a', 'line-opacity': 0.5, 'line-width': casingWidth } },
  { id: 'lines-dashed', filter: ['all', isLine, inCats(['ferry', 'border'])], type: 'line', layout: { 'line-join': 'round' }, paint: { 'line-color': catColor, 'line-width': lineWidth, 'line-dasharray': [2, 1.2] } },
  { id: 'rail-marks', filter: ['all', isLine, ['==', ['get', 'mode'], RAIL_MODE]], type: 'line', layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 12, 1.6], 'line-dasharray': [2, 3] } },
  { id: 'points-infra', filter: ['all', isPoint, inCats(INFRA)], type: 'circle', minzoom: 8.6, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.5, 3.5, 13, 6], 'circle-color': ['match', ['get', 'category'], 'station', '#1e1533', 'terminal', '#0c2a3a', '#082f35'], 'circle-stroke-color': catColor, 'circle-stroke-width': 2.5 } },
  { id: 'points-local', filter: ['all', isPoint, tierIs('local')], type: 'circle', minzoom: 9.4, local: true, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 5], 'circle-color': catColor, 'circle-stroke-color': '#0d1117', 'circle-stroke-width': 1.5 } },
  { id: 'points-national', filter: ['all', isPoint, tierIs('national'), ['!', inCats(INFRA)]], type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['match', ['get', 'category'], 'water', 2.5, 4], 12, ['match', ['get', 'category'], 'water', 4, 7]], 'circle-color': catColor, 'circle-stroke-color': '#0d1117', 'circle-stroke-width': 2 } },
  { id: 'labels-lines', filter: ['all', isLine, tierIs('national'), inCats(['corridor', 'trunk', 'bridge', 'ferry', 'ring', 'water'])], type: 'symbol', minzoom: 8.4, layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5, 'text-max-angle': 30, 'symbol-spacing': 420, 'text-padding': 4 }, paint: { 'text-color': catColor, 'text-halo-color': '#05070a', 'text-halo-width': 1.6 } },
  { id: 'labels-local', filter: ['all', isPoint, tierIs('local')], type: 'symbol', minzoom: 10.2, local: true, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-max-width': 9, 'text-optional': true }, paint: { 'text-color': '#E2E8F0', 'text-halo-color': '#05070a', 'text-halo-width': 1.5 } },
  { id: 'labels-infra', filter: ['all', isPoint, inCats(INFRA)], type: 'symbol', minzoom: 10.6, layout: { 'text-field': infraLabel(), 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-max-width': 9, 'text-optional': true }, paint: { 'text-color': catColor, 'text-halo-color': '#05070a', 'text-halo-width': 1.5 } },
  { id: 'labels-national', filter: ['all', isPoint, tierIs('national'), ['!', inCats(INFRA)]], type: 'symbol', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10.5, 10, 13.5], 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.8, 'text-max-width': 10, 'text-optional': true }, paint: { 'text-color': ['match', ['get', 'category'], 'water', '#A5F3FC', 'site', '#FED7AA', '#FFFFFF'], 'text-halo-color': '#05070a', 'text-halo-width': 1.6 } },
];
const INTERACTIVE = ['points-infra', 'points-national', 'points-local', 'lines-dashed', 'lines-national', 'lines-local', 'water-fill', 'site-fill'];

function catFilter() {
  const hidden = [...state.hidden];
  return hidden.length ? ['!', inCats(hidden)] : true;
}
function deptOpacity(on = 1, off = 0.16) {
  return state.dept ? ['case', ['==', ['get', 'dept'], state.dept], on, off] : on;
}
function applyFilters() {
  if (!map.getSource('plan')) return;
  for (const L of DATA_LAYERS) {
    map.setFilter(L.id, ['all', L.filter, catFilter()]);
    const prop = { fill: 'fill-opacity', line: 'line-opacity', circle: 'circle-opacity', symbol: 'text-opacity' }[L.type];
    const base = L.paint[prop] ?? 1;
    map.setPaintProperty(L.id, prop, typeof base === 'number' ? deptOpacity(base, base * 0.16) : base);
    if (L.type === 'circle') map.setPaintProperty(L.id, 'circle-stroke-opacity', deptOpacity(1, 0.16));
    if (L.local) map.setLayerZoomRange(L.id, state.localAlways ? 0 : L.minzoom, 24);
  }
  map.setFilter('dept-focus', ['==', ['get', 'name'], state.dept ?? '']);
  map.setLayoutProperty('rail-marks', 'visibility', state.rail ? 'visible' : 'none');
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
const dataReady = Promise.all([fetch('data/plan.geojson').then((r) => r.json()), fetch('data/departments.geojson').then((r) => r.json())]);

map.on('load', async () => {
  [plan, depts] = await dataReady;
  byId = new Map();
  for (const f of plan.features) {
    const coords = flatCoords(f.geometry);
    f._bbox = bboxOf(coords);
    if (f.geometry.type === 'LineString') f._cum = cumulative(f.geometry.coordinates);
    byId.set(f.properties.id, f);
  }

  map.addSource('plan', { type: 'geojson', data: plan });
  map.addSource('depts', { type: 'geojson', data: depts });
  map.addSource('dept-labels', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: depts.features.filter((f) => f.properties.label).map((f) => ({ type: 'Feature', properties: { name: f.properties.name }, geometry: { type: 'Point', coordinates: f.properties.label } })) },
  });

  map.addLayer({ id: 'dept-line', type: 'line', source: 'depts', paint: { 'line-color': '#ffffff', 'line-opacity': 0.32, 'line-width': 1, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'dept-focus', type: 'line', source: 'depts', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-opacity': 0.9 } });

  for (const L of DATA_LAYERS) {
    if (L.type === 'symbol') continue;
    map.addLayer({ id: L.id, type: L.type, source: 'plan', filter: L.filter, ...(L.minzoom ? { minzoom: L.minzoom } : {}), ...(L.layout ? { layout: L.layout } : {}), paint: L.paint });
  }

  // Hover + selection highlights sit above lines, below labels.
  map.addLayer({ id: 'hover-line', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': widthPlus(4) } });
  map.addLayer({ id: 'sel-glow', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': catColor, 'line-width': widthPlus(10), 'line-blur': 6, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': catColor, 'line-width': widthPlus(2) } });
  map.addLayer({ id: 'sel-dash', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 12, 2.5], 'line-dasharray': [0, 4, 3] } });
  map.addLayer({ id: 'sel-point', type: 'circle', source: 'plan', filter: ['==', ['get', 'id'], -1], paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });

  map.addLayer({ id: 'dept-labels', type: 'symbol', source: 'dept-labels', maxzoom: 9.2, layout: { 'text-field': ['upcase', ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-letter-spacing': 0.22, 'text-allow-overlap': false }, paint: { 'text-color': '#ffffff', 'text-opacity': 0.5, 'text-halo-color': '#05070a', 'text-halo-width': 1.2 } });
  for (const L of DATA_LAYERS) {
    if (L.type !== 'symbol') continue;
    map.addLayer({ id: L.id, type: 'symbol', source: 'plan', filter: L.filter, ...(L.minzoom ? { minzoom: L.minzoom } : {}), layout: L.layout, paint: L.paint });
  }

  if (state.terrain) map.setTerrain({ source: 'dem', exaggeration: 1.5 });
  applyFilters();
  buildPanel();
  wireMap();
  animateDash();

  const f = Number(new URLSearchParams(location.hash.slice(1)).get('f'));
  if (f && byId.has(f)) select(f, { move: !hadView });
  else if (!hadView) {
    map.jumpTo({ center: [-72.7, 19.0], zoom: PHONE.matches ? 4.6 : 5.4 });
    map.fitBounds(HAITI_BOUNDS, { padding: PHONE.matches ? { top: 40, left: 2, right: 44, bottom: 170 } : pad(), pitch: PHONE.matches ? 0 : 38, bearing: PHONE.matches ? 0 : -4, duration: 2600, essential: true });
  }
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
const ICONS = {
  layers: '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v7h14v-7"/></svg>',
  zoom: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M11 8v6M8 11h6"/></svg>',
  fly: '<svg viewBox="0 0 24 24"><path d="M3 20c5-2 7-6 9-10s4-6 9-7"/><circle cx="21" cy="3" r="0.5"/><path d="m14 4 7-1-1 7"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
};

class ButtonsControl {
  onAdd() {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    el.innerHTML = `
      <button class="ctl ${state.terrain ? 'on' : ''}" id="btn3d" aria-pressed="${state.terrain}">3D</button>
      <button class="ctl" id="btnBase">${ICONS.map}</button>
      <button class="ctl" id="btnHome">${ICONS.home}</button>
      <button class="ctl" id="btnShare">${ICONS.share}</button>`;
    el.querySelector('#btn3d').onclick = toggleTerrain;
    el.querySelector('#btnBase').onclick = toggleBase;
    el.querySelector('#btnHome').onclick = resetView;
    el.querySelector('#btnShare').onclick = () => share();
    return el;
  }
  onRemove() {}
}
class LangControl {
  onAdd() {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group lang-ctl';
    el.innerHTML = `<button class="ctl" id="btnLang" aria-haspopup="true" aria-expanded="false">${ICONS.globe}<span id="langCode"></span></button>
      <div class="lang-menu" id="langMenu" role="menu" hidden>${LANGS.map((l) => `<button role="menuitemradio" data-lang="${l.code}">${l.label}</button>`).join('')}</div>`;
    const btn = el.querySelector('#btnLang');
    const menu = el.querySelector('#langMenu');
    const close = () => {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector(`[data-lang="${getLang()}"]`)?.focus();
    };
    menu.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = () => {
      close();
      if (b.dataset.lang !== getLang()) changeLang(b.dataset.lang);
    }));
    document.addEventListener('click', (e) => !el.contains(e.target) && close());
    el.addEventListener('keydown', (e) => e.key === 'Escape' && (close(), btn.focus()));
    return el;
  }
  onRemove() {}
}
map.addControl(new LangControl(), 'top-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new ButtonsControl(), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false, fitBoundsOptions: { maxZoom: 13 } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

function toggleTerrain() {
  state.terrain = !state.terrain;
  map.setTerrain(state.terrain ? { source: 'dem', exaggeration: 1.5 } : null);
  const b = $('#btn3d');
  b.classList.toggle('on', state.terrain);
  b.setAttribute('aria-pressed', state.terrain);
  if (state.terrain && map.getPitch() < 20) map.easeTo({ pitch: 50, duration: 900 });
  if (!state.terrain) map.easeTo({ pitch: 0, duration: 900 });
}
function toggleBase() {
  state.base = state.base === 'satellite' ? 'streets' : 'satellite';
  const sat = state.base === 'satellite';
  map.setLayoutProperty('satellite', 'visibility', sat ? 'visible' : 'none');
  map.setLayoutProperty('streets', 'visibility', sat ? 'none' : 'visible');
  map.setLayoutProperty('hillshade', 'visibility', sat ? 'none' : 'visible');
  applyControlText();
  toast(t(sat ? 'toast.sat' : 'toast.streets'));
}
function resetView() {
  stopFly();
  clearSelection();
  setDept(null, { move: false });
  map.fitBounds(HAITI_BOUNDS, { padding: pad(), pitch: state.terrain ? 38 : 0, bearing: 0, duration: 1400 });
}

function pad() {
  if (state.collapsed) return { top: 60, bottom: 60, left: 60, right: 70 };
  if (PHONE.matches) {
    // Use the sheet's target height (it may still be animating).
    const st = $('#panel').dataset.state;
    const h = st === 'peek' ? 152 : window.innerHeight * 0.52;
    return { top: 60, left: 24, right: 64, bottom: h + 16 };
  }
  return { top: 60, bottom: 60, left: $('#panel').getBoundingClientRect().right + 40, right: 80 };
}

// ---------------------------------------------------------------------------
// Map interaction
// ---------------------------------------------------------------------------
function pickAt(point) {
  const r = PHONE.matches ? 14 : 6;
  const hits = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: INTERACTIVE.filter((id) => map.getLayer(id)) });
  if (!hits.length) return null;
  const rank = (f) => (f.geometry.type === 'Point' ? 0 : f.layer.type === 'line' ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b));
  return hits[0].properties.id;
}

function wireMap() {
  const tip = $('#tooltip');
  const hoverable = window.matchMedia('(hover: hover)').matches;
  map.on('mousemove', (e) => {
    if (!hoverable || flying) return;
    const id = pickAt(e.point);
    if (id !== state.hover) {
      state.hover = id;
      map.setFilter('hover-line', ['==', ['get', 'id'], id ?? -1]);
    }
    map.getCanvas().style.cursor = id ? 'pointer' : '';
    if (id) {
      const p = byId.get(id).properties;
      tip.innerHTML = `${esc(displayName(p))}<small>${[p.km ? fmtKm(p.km) : null, modeText(p) ?? catOne(p.category)].filter(Boolean).map(esc).join(' · ')}</small>`;
      tip.style.left = `${e.point.x}px`;
      tip.style.top = `${e.point.y}px`;
      tip.hidden = false;
    } else tip.hidden = true;
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    tip.hidden = true;
    map.setFilter('hover-line', ['==', ['get', 'id'], -1]);
    state.hover = null;
  });
  map.on('click', (e) => {
    const id = pickAt(e.point);
    if (id) select(id, { move: true, fromMap: true });
    else if (state.selected) clearSelection();
  });
  // Any user gesture cancels a fly-along.
  for (const ev of ['mousedown', 'touchstart', 'wheel']) map.getCanvasContainer().addEventListener(ev, () => flying && stopFly(), { passive: true });
}

// Marching-ants dash on the selected route.
function animateDash() {
  const seq = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
  let step = -1;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  const tick = (ts) => {
    const s = Math.floor(ts / 70) % seq.length;
    if (s !== step && state.selected && map.getLayer('sel-dash')) {
      map.setPaintProperty('sel-dash', 'line-dasharray', seq[s]);
      step = s;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
let selectToken = 0;
let profileMarker = null;

function setHashParam(key, val) {
  const params = location.hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith(`${key}=`));
  if (val != null) params.push(`${key}=${val}`);
  history.replaceState(history.state, '', `${location.pathname}${location.search}#${params.join('&')}`);
}

function fitFeature(f, opts = {}) {
  if (f.geometry.type === 'Point') {
    map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), f.properties.tier === 'local' ? 12.5 : 11), pitch: state.terrain ? 50 : 0, padding: pad(), duration: 1400, essential: true, ...opts });
  } else {
    const b = f._bbox;
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad(), maxZoom: 13.5, pitch: state.terrain ? 45 : 0, duration: 1400, essential: true, ...opts });
  }
}

function select(id, { move = true } = {}) {
  const f = byId.get(id);
  if (!f) return;
  stopFly();
  state.selected = id;
  const isPt = f.geometry.type === 'Point';
  for (const l of ['sel-glow', 'sel-line', 'sel-dash']) map.setFilter(l, isPt ? ['==', ['get', 'id'], -1] : ['all', ['==', ['get', 'id'], id], ['!=', ['geometry-type'], 'Point']]);
  map.setFilter('sel-point', isPt ? ['==', ['get', 'id'], id] : ['==', ['get', 'id'], -1]);
  setHashParam('f', id);
  // A hidden category or an unrevealed local feature should still be visible once chosen.
  if (state.hidden.has(f.properties.category)) {
    state.hidden.delete(f.properties.category);
    applyFilters();
    renderLayers();
  }
  if (state.collapsed) setCollapsed(false);
  $('#search').value = '';
  $('#results').hidden = true;
  renderDetail(f);
  $('#home').hidden = false;
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
  $('#panelBody').scrollTop = 0;
  if (move) requestAnimationFrame(() => fitFeature(f));
}

function clearSelection() {
  state.selected = null;
  for (const l of ['sel-glow', 'sel-line', 'sel-dash', 'sel-point']) map.getLayer(l) && map.setFilter(l, ['==', ['get', 'id'], -1]);
  setHashParam('f', null);
  $('#detail').hidden = true;
  $('#detail').innerHTML = '';
  if (profileMarker) profileMarker.remove();
}

function connections(f) {
  const out = [];
  const g = f.geometry;
  const pad = 0.05;
  const [x0, y0, x1, y1] = f._bbox;
  for (const o of plan.features) {
    if (o === f || o.geometry.type !== 'LineString' || o.properties.category === 'border') continue;
    const b = o._bbox;
    if (b[2] < x0 - pad || b[0] > x1 + pad || b[3] < y0 - pad || b[1] > y1 + pad) continue;
    const oc = o.geometry.coordinates;
    let hit = false;
    if (g.type === 'Point') hit = distToLineKm(g.coordinates, oc) < 3;
    else if (g.type === 'LineString') {
      const c = g.coordinates;
      hit = distToLineKm(oc[0], c) < 0.8 || distToLineKm(oc.at(-1), c) < 0.8 || distToLineKm(c[0], oc) < 0.8 || distToLineKm(c.at(-1), oc) < 0.8;
    }
    if (hit) out.push(o);
  }
  out.sort((a, b) => a.properties.sort - b.properties.sort || (b.properties.km ?? 0) - (a.properties.km ?? 0));
  return out.slice(0, 12);
}

function itemHTML(f, right) {
  const p = f.properties;
  const sub = [displaySub(p), p.dept].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || catOne(p.category);
  return `<li><button class="item" data-id="${p.id}" style="--c:${CATS[p.category].color}">
      <span class="dotc"></span>
      <span class="t"><b>${esc(displayName(p))}</b><small>${esc(sub)}</small></span>
      <span class="k">${right ?? (p.km ? fmtKm(p.km) : '')}</span></button></li>`;
}

function renderDetail(f) {
  const p = f.properties;
  const cat = CATS[p.category];
  const g = f.geometry;
  const isLineF = g.type === 'LineString';
  const token = ++selectToken;
  const facts = [];
  if (g.type === 'Point') facts.push([`${g.coordinates[1].toFixed(4)}, ${g.coordinates[0].toFixed(4)}`, t('fact.latlon')]);
  if (p.km) facts.push([fmtKm(p.km), t(g.type === 'Polygon' ? 'fact.perimeter' : 'fact.length')]);
  if (p.mode) facts.push([modeText(p), t('fact.mode')]);
  facts.push([p.dept ?? t('fact.crossBorder'), t('fact.dept')]);
  const badges = [`<span class="badge">${t(p.tier === 'local' ? 'badge.local' : 'badge.national')}</span>`];
  if (p.tunnel) badges.push(`<span class="badge tunnel">${t('badge.tunnel')} · ${esc(tunnelName(p.tunnel))}</span>`);
  if (p.mode === RAIL_MODE) badges.push(`<span class="badge rail">${t('badge.rail')}</span>`);
  const gm = g.type === 'Point'
    ? `https://www.google.com/maps/search/?api=1&query=${g.coordinates[1]},${g.coordinates[0]}`
    : isLineF
      ? `https://www.google.com/maps/dir/?api=1&origin=${g.coordinates[0][1]},${g.coordinates[0][0]}&destination=${g.coordinates.at(-1)[1]},${g.coordinates.at(-1)[0]}`
      : `https://www.google.com/maps/search/?api=1&query=${(f._bbox[1] + f._bbox[3]) / 2},${(f._bbox[0] + f._bbox[2]) / 2}`;
  const conns = connections(f);
  const el = $('#detail');
  el.innerHTML = `
    <div class="detail-top">
      <span class="pill" style="--c:${cat.color}">${esc(catOne(p.category))}</span>
      <button class="icon-btn" id="detailClose" aria-label="${t('btn.close')}">${ICONS.close}</button>
    </div>
    <h2>${esc(displayName(p))}</h2>
    ${displaySub(p) ? `<p class="sub">${esc(displaySub(p))}</p>` : ''}
    <div class="badges">${badges.join('')}</div>
    ${p.derived ? `<p class="note">${t(`note.${p.category}`)}${p.serves ? `<br><b>${t('note.serves')}</b> ${esc(p.serves)}` : ''}</p>` : ''}
    <div class="facts">${facts.slice(0, 3).map(([v, k]) => `<div class="fact"><b title="${esc(v)}">${esc(v)}</b><span>${k}</span></div>`).join('')}</div>
    <div class="actions">
      ${isLineF && p.km > 2 ? `<button class="btn primary" id="btnFly">${ICONS.fly} ${t('btn.fly')}</button>` : ''}
      <button class="btn" id="btnZoom">${ICONS.zoom} ${t('btn.zoom')}</button>
      <a class="btn" href="${gm}" target="_blank" rel="noopener">${ICONS.map} ${t(isLineF ? 'btn.today' : 'btn.gmaps')}</a>
      <button class="btn" id="btnShareF">${ICONS.share} ${t('btn.share')}</button>
    </div>
    ${isLineF && !['border', 'ferry'].includes(p.category) ? `<div class="profile" id="profile"><div class="profile-head"><h3>${t('prof.title')}</h3><span>${esc(fmtKm(p.km))}</span></div><div class="loading">${t('prof.measuring')}</div></div>` : ''}
    ${conns.length ? `<p class="sub-head">${t(g.type === 'Point' ? 'list.within3' : 'list.connects')}</p><ul class="list">${conns.map((c) => itemHTML(c)).join('')}</ul>` : ''}
  `;
  el.hidden = false;
  el.querySelector('#detailClose').onclick = clearSelection;
  el.querySelector('#btnZoom').onclick = () => fitFeature(f);
  el.querySelector('#btnShareF').onclick = () => share(displayName(p));
  el.querySelector('#btnFly')?.addEventListener('click', () => flyAlong(f));
  el.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(Number(b.dataset.id))));
  if (isLineF && !['border', 'ferry'].includes(p.category)) renderProfile(f, token);
}

// ---------------------------------------------------------------------------
// Elevation profile (decodes Terrarium tiles directly so it works at any zoom)
// ---------------------------------------------------------------------------
const tileCache = new Map();
function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256).data);
      };
      img.onerror = () => resolve(null);
      img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`;
    }));
  }
  return tileCache.get(key);
}
function tileXY([lon, lat], z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n;
  return [x, y];
}
async function sampleElevations(f) {
  const coords = f.geometry.coordinates;
  const cum = f._cum;
  const total = cum.at(-1);
  const n = clamp(Math.round(total * 5), 40, 180);
  const pts = Array.from({ length: n + 1 }, (_, i) => ({ d: (total * i) / n, p: along(coords, cum, (total * i) / n) }));
  let z = 12;
  for (; z > 8; z--) {
    const set = new Set(pts.map(({ p }) => tileXY(p, z).map(Math.floor).join('/')));
    if (set.size <= 14) break;
  }
  const out = await Promise.all(pts.map(async ({ d, p }) => {
    const [fx, fy] = tileXY(p, z);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const data = await demTile(z, tx, ty);
    if (!data) return { d, e: null, p };
    const px = clamp(Math.floor((fx - tx) * 256), 0, 255), py = clamp(Math.floor((fy - ty) * 256), 0, 255);
    const i = (py * 256 + px) * 4;
    return { d, e: data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768, p };
  }));
  return out.filter((s) => s.e != null);
}

async function renderProfile(f, token) {
  const box = $('#profile');
  let s;
  try {
    s = await sampleElevations(f);
  } catch {
    s = [];
  }
  if (token !== selectToken || !box) return;
  if (s.length < 5) {
    box.querySelector('.loading').textContent = t('prof.unavailable');
    return;
  }
  const color = CATS[f.properties.category].color;
  const elev = s.map((v) => Math.max(0, v.e));
  const sm = elev.map((_, i) => (elev[Math.max(0, i - 1)] + elev[i] + elev[Math.min(elev.length - 1, i + 1)]) / 3);
  const maxE = Math.max(...sm);
  const minE = Math.min(...sm);
  let climb = 0, descent = 0, grade = 0;
  for (let i = 1; i < sm.length; i++) {
    const dz = sm[i] - sm[i - 1];
    if (dz > 0) climb += dz;
    else descent -= dz;
  }
  const win = Math.max(1, Math.ceil(0.4 / (s[1].d - s[0].d))); // ~400 m windows
  for (let i = win; i < sm.length; i++) {
    const run = (s[i].d - s[i - win].d) * 1000;
    if (run > 0) grade = Math.max(grade, Math.abs(sm[i] - sm[i - win]) / run);
  }
  const water = s.filter((v) => v.e <= 0).length / s.length > 0.08;
  const W = 320, H = 96, top = 8, bottom = 18;
  const total = s.at(-1).d;
  const yMax = Math.max(50, maxE * 1.1);
  const X = (d) => (d / total) * W;
  const Y = (e) => top + (1 - e / yMax) * (H - top - bottom);
  const line = sm.map((e, i) => `${i ? 'L' : 'M'}${X(s[i].d).toFixed(1)},${Y(e).toFixed(1)}`).join('');
  const peakI = sm.indexOf(maxE);
  box.innerHTML = `
    <div class="profile-head"><h3>${t('prof.title')}</h3><span>${esc(fmtKm(total))}${water ? ` · ${t('prof.water')}` : ''}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" id="profSvg" role="img" aria-label="${t('prof.title')}, ${t('prof.highest')} ${fmtM(maxE)}">
      <defs><linearGradient id="pg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".55"/><stop offset="1" stop-color="${color}" stop-opacity=".04"/></linearGradient></defs>
      <line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>
      <path d="${line}L${W},${Y(0)}L0,${Y(0)}Z" fill="url(#pg)"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(s[peakI].d)}" cy="${Y(maxE)}" r="2.8" fill="#fff"/>
      <line id="profCursor" x1="0" x2="0" y1="${top}" y2="${Y(0)}" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0"/>
      <text x="2" y="${H - 4}" fill="#6b7584" font-size="9">${t('prof.start')}</text>
      <text x="${W - 2}" y="${H - 4}" fill="#6b7584" font-size="9" text-anchor="end">${t('prof.end')}</text>
    </svg>
    <div class="profile-stats">
      <span>${t('prof.highest')} <b>${fmtM(maxE)}</b></span>
      <span>${t('prof.climb')} <b>${fmtM(climb)}</b></span>
      <span>${t('prof.steepest')} <b>${(grade * 100).toFixed(0)}%</b></span>
    </div>
    <p class="note" style="margin:8px 0 0">${f.properties.tunnel ? t('prof.noteTunnel', { tunnel: esc(t('tunnel.phrase', { name: tunnelName(f.properties.tunnel) })) }) : t('prof.note')}</p>
    <div class="profile-stats" id="profRead" style="margin-top:4px;min-height:16px"><span>${minE < 5 ? t('prof.nearSea') : t('prof.lowest', { m: fmtM(minE) })} · ${t('prof.descent', { m: fmtM(descent) })}</span></div>`;

  // Scrub the profile to see where you are on the map.
  const svg = box.querySelector('#profSvg');
  const cursor = box.querySelector('#profCursor');
  const read = box.querySelector('#profRead');
  const onMove = (ev) => {
    const r = svg.getBoundingClientRect();
    const frac = clamp((ev.clientX - r.left) / r.width, 0, 1);
    const i = Math.round(frac * (s.length - 1));
    cursor.setAttribute('x1', X(s[i].d));
    cursor.setAttribute('x2', X(s[i].d));
    cursor.setAttribute('opacity', 0.8);
    read.innerHTML = `<span>${t('prof.read', { km: `<b>${fmtKm(s[i].d)}</b>`, m: `<b>${fmtM(sm[i])}</b>` })}</span>`;
    if (!profileMarker) {
      const dot = document.createElement('div');
      dot.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #0d1117;box-shadow:0 0 0 2px rgba(255,255,255,.5)';
      profileMarker = new maplibregl.Marker({ element: dot });
    }
    profileMarker.setLngLat(s[i].p).addTo(map);
  };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerdown', onMove);
  svg.addEventListener('pointerleave', () => {
    cursor.setAttribute('opacity', 0);
    profileMarker?.remove();
  });
}

// ---------------------------------------------------------------------------
// Fly along a route
// ---------------------------------------------------------------------------
let flying = false;
let flyRaf = 0;
function stopFly() {
  if (!flying) return;
  flying = false;
  cancelAnimationFrame(flyRaf);
  map.off('moveend', flyStart);
  $('#flyBar').hidden = true;
}
let flyStart = () => {};
function flyAlong(f) {
  stopFly();
  const coords = f.geometry.coordinates;
  const cum = f._cum;
  const total = cum.at(-1);
  const dur = clamp(total * 230, 9000, 50000);
  const zoom = total < 12 ? 13.6 : total < 40 ? 12.6 : 11.8;
  const look = Math.max(1, total * 0.05);
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  let brg = bearing(coords[0], along(coords, cum, look));
  flying = true;
  if (!state.terrain) toggleTerrain();
  $('#flyLabel').textContent = t('fly.label', { name: displayName(f.properties) });
  $('#flyBar').hidden = false;
  if (PHONE.matches) setSheet('peek');
  let t0 = null;
  const step = (ts) => {
    if (!flying) return;
    t0 ??= ts;
    const t = Math.min(1, (ts - t0) / dur);
    const d = ease(t) * total;
    const p = along(coords, cum, d);
    const target = bearing(p, along(coords, cum, Math.min(total, d + look)));
    const diff = ((target - brg + 540) % 360) - 180;
    brg = (brg + diff * 0.05 + 360) % 360;
    map.jumpTo({ center: p, bearing: brg, pitch: 62, zoom });
    if (t < 1) flyRaf = requestAnimationFrame(step);
    else {
      stopFly();
      fitFeature(f, { duration: 2000 });
    }
  };
  flyStart = () => {
    if (flying) flyRaf = requestAnimationFrame(step);
  };
  map.once('moveend', flyStart);
  map.easeTo({ center: coords[0], zoom, pitch: 62, bearing: brg, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 1800, essential: true });
}
$('#flyStop').onclick = stopFly;

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function catTotals(features) {
  const t = Object.fromEntries(CAT_KEYS.map((k) => [k, { count: 0, km: 0 }]));
  for (const f of features) {
    t[f.properties.category].count++;
    t[f.properties.category].km += f.properties.km ?? 0;
  }
  return t;
}

function buildPanel() {
  renderStats();
  renderLayers();

  const names = depts.features.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b));
  $('#depts').innerHTML = names.map((n) => `<button class="chip" data-d="${esc(n)}">${esc(n)}</button>`).join('');
  $('#depts').querySelectorAll('.chip').forEach((c) => (c.onclick = () => setDept(state.dept === c.dataset.d ? null : c.dataset.d)));
  $('#clearDept').onclick = () => setDept(null);

  $('#localAlways').onchange = (e) => {
    state.localAlways = e.target.checked;
    applyFilters();
  };

  // Search
  const input = $('#search');
  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      runSearch('');
      input.blur();
    }
    if (e.key === 'Enter') $('#results .item')?.click();
  });
  input.addEventListener('focus', () => PHONE.matches && setSheet('full'));

  // Hide / show the panel (remembered on this device).
  $('#collapseBtn').onclick = () => setCollapsed(true);
  $('#openPanel').onclick = () => setCollapsed(false);
  try {
    if (localStorage.getItem('panelCollapsed') === '1') setCollapsed(true);
  } catch {
    /* storage unavailable */
  }

  // Sheet handle (phone)
  $('#sheetHandle').onclick = () => {
    const s = $('#panel').dataset.state;
    setSheet(s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek');
  };
  let y0 = null;
  $('#sheetHandle').addEventListener('touchstart', (e) => (y0 = e.touches[0].clientY), { passive: true });
  $('#sheetHandle').addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    const s = $('#panel').dataset.state;
    if (dy < -30) setSheet(s === 'peek' ? 'half' : 'full');
    if (dy > 30) setSheet(s === 'full' ? 'half' : 'peek');
    y0 = null;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.activeElement === document.body) {
      stopFly();
      clearSelection();
    }
  });
}

function setCollapsed(on) {
  state.collapsed = on;
  $('#panel').classList.toggle('collapsed', on);
  $('#panel').setAttribute('aria-hidden', on);
  $('#openPanel').hidden = !on;
  if (!on) $('#collapseBtn').focus({ preventScroll: true });
  else $('#openPanel').focus({ preventScroll: true });
  try {
    localStorage.setItem('panelCollapsed', on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

function setSheet(s) {
  if (!PHONE.matches) return;
  $('#panel').dataset.state = s;
}

function renderStats() {
  const tot = catTotals(plan.features);
  const railKm = tot.corridor.km + tot.trunk.km;
  const rings = plan.features.filter((f) => f.properties.category === 'ring' && f.properties.tier === 'national').length;
  const micro = plan.features.filter((f) => f.properties.category === 'ring' && f.properties.tier === 'local').length;
  const islands = new Set();
  for (const f of plan.features) {
    if (!['bridge', 'ferry', 'corridor'].includes(f.properties.category)) continue;
    const m = norm(f.properties.name + ' ' + f.properties.original).match(/vache|cayemite|tortue|gonave/g);
    m?.forEach((x) => islands.add(x));
  }
  $('#stats').innerHTML = [
    [Math.round(railKm).toLocaleString(locale()) + ' km', t('stat.rail')],
    [rings, t('stat.rings', { n: micro })],
    [tot.station.count, t('stat.stations')],
    [islands.size, t('stat.islands')],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');

}

function renderLayers() {
  const tot = catTotals(plan.features);
  $('#layers').innerHTML = CAT_KEYS.map((k) => {
    const c = CATS[k];
    const sw = { line: '<i></i>', rail: '<i class="rail"></i>', dash: '<i class="dash"></i>', thin: '<i class="thin"></i>', dot: '<i class="dot"></i>', ring: '<i class="ring"></i>', square: '<i class="square"></i>' }[c.swatch];
    const meta = tot[k].km > 0 && c.swatch !== 'dot' ? `${tot[k].count} · ${fmtKm(tot[k].km)}` : `${tot[k].count}`;
    return `<li class="layer ${state.hidden.has(k) ? 'off' : ''}" data-k="${k}" role="switch" tabindex="0" aria-checked="${!state.hidden.has(k)}">
      <span class="swatch" style="--c:${c.color}">${sw}</span>
      <span class="layer-name">${catLabel(k)}${catHint(k) ? `<small>${catHint(k)}</small>` : ''}</span>
      <span class="layer-meta">${meta}</span>
      <span class="switch"></span></li>`;
  }).join('') + `<li class="layer ${state.rail ? '' : 'off'}" data-k="__rail" role="switch" tabindex="0" aria-checked="${state.rail}">
      <span class="swatch" style="--c:#34D399"><i class="rail"></i></span>
      <span class="layer-name">${t('rail.label')}<small>${t('rail.hint')}</small></span>
      <span class="layer-meta"></span><span class="switch"></span></li>`;
  $('#layers').querySelectorAll('.layer').forEach((li) => {
    const toggle = () => {
      const k = li.dataset.k;
      if (k === '__rail') state.rail = !state.rail;
      else state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k);
      applyFilters();
      renderLayers();
    };
    li.onclick = toggle;
    li.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle());
  });
}

function setDept(name, { move = true } = {}) {
  state.dept = name;
  applyFilters();
  $('#depts').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.d === name));
  $('#clearDept').hidden = !name;
  const card = $('#deptCard');
  if (!name) {
    card.innerHTML = '';
    return;
  }
  const feats = plan.features.filter((f) => f.properties.dept === name);
  const tt = catTotals(feats);
  const roadKm = ROAD_CATS.reduce((s, k) => s + tt[k].km, 0);
  const towns = tt.city.count + tt.town.count;
  const routes = feats.filter((f) => ROAD_CATS.includes(f.properties.category) && f.properties.tier === 'national').sort((a, b) => b.properties.km - a.properties.km).slice(0, 8);
  card.innerHTML = `<div class="dept-card">
    <h3>${esc(name)}</h3>
    <p>${t('dept.summary', { n: feats.length, km: fmtKm(roadKm), towns })}</p>
    <div class="bar">${ROAD_CATS.filter((k) => tt[k].km).map((k) => `<span style="--c:${CATS[k].color};width:${(tt[k].km / roadKm) * 100}%" title="${catLabel(k)}: ${fmtKm(tt[k].km)}"></span>`).join('')}</div>
    <div class="legend-row">${ROAD_CATS.filter((k) => tt[k].km).map((k) => `<span style="--c:${CATS[k].color}"><i></i>${catLabel(k)} ${fmtKm(tt[k].km)}</span>`).join('')}</div>
    ${routes.length ? `<p class="sub-head">${t('list.main')}</p><ul class="list">${routes.map((f) => itemHTML(f)).join('')}</ul>` : ''}
  </div>`;
  card.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(Number(b.dataset.id))));
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (move) {
    const d = depts.features.find((f) => f.properties.name === name);
    const b = bboxOf(d.geometry.coordinates.flat(2));
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad(), pitch: state.terrain ? 40 : 0, duration: 1300 });
  }
}

function runSearch(q) {
  const box = $('#results');
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) {
    box.hidden = true;
    $('#home').hidden = false;
    return;
  }
  const hits = [];
  for (const f of plan.features) {
    const p = f.properties;
    const hay = norm(`${displayName(p)} ${p.name} ${displaySub(p)} ${p.dept} ${p.original} ${catLabel(p.category)} ${modeText(p) ?? ''} ${p.mode ?? ''} ${p.tunnel ?? ''}`);
    if (terms.every((w) => hay.includes(w))) {
      const score = (norm(displayName(p)).startsWith(terms[0]) ? 0 : 10) + p.sort + (p.tier === 'local' ? 5 : 0);
      hits.push([score, f]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  box.innerHTML = hits.length
    ? `<p class="results-head">${hits.length === 1 ? t('res.one') : t('res.count', { n: hits.length })}</p><ul class="list">${hits.slice(0, 40).map(([, f]) => itemHTML(f)).join('')}</ul>`
    : `<p class="empty">${t('res.none', { q: esc(q) })}</p>`;
  box.hidden = false;
  $('#home').hidden = true;
  box.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(Number(b.dataset.id))));
}

async function share(name) {
  const url = location.href;
  const title = name ? `${name} — ${t('app.title')}` : t('app.title');
  if (navigator.share && PHONE.matches) {
    try {
      await navigator.share({ title, url });
      return;
    } catch {
      /* cancelled */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(t('toast.copied'));
  } catch {
    toast(url);
  }
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
function applyControlText() {
  const set = (id, key) => {
    const b = $(id);
    if (b) {
      b.title = t(key);
      b.setAttribute('aria-label', t(key));
    }
  };
  set('#btn3d', 'ctl.terrain');
  set('#btnBase', state.base === 'satellite' ? 'ctl.toStreets' : 'ctl.toSat');
  set('#btnHome', 'ctl.home');
  set('#btnShare', 'ctl.share');
  set('#btnLang', 'ctl.lang');
  if ($('#langCode')) $('#langCode').textContent = getLang().toUpperCase();
  document.querySelectorAll('#langMenu [data-lang]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === getLang())));
}

function applyStaticText() {
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  $('#search').placeholder = t('search.placeholder');
  applyControlText();
}

function changeLang(code) {
  setLang(code);
  applyStaticText();
  const label = LANGS.find((l) => l.code === code)?.label;
  if (!plan) return;
  renderStats();
  renderLayers();
  if (state.dept) setDept(state.dept, { move: false });
  if (state.selected) renderDetail(byId.get(state.selected));
  if ($('#search').value) runSearch($('#search').value);
  if (map.getLayer('labels-infra')) map.setLayoutProperty('labels-infra', 'text-field', infraLabel());
  for (const id of ['osm-water', 'osm-towns', 'osm-islands', 'osm-villages', 'osm-suburbs']) map.getLayer(id) && map.setLayoutProperty(id, 'text-field', osmName());
  map.getLayer('osm-airports') && map.setLayoutProperty('osm-airports', 'text-field', ['concat', '✈ ', osmName()]);
  map.getLayer('osm-country') && map.setLayoutProperty('osm-country', 'text-field', osmCountryName());
  toast(label);
}

applyStaticText();
