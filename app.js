/* Haiti Infrastructure Plan — interactive map
 * Plain ES module, no build step. MapLibre GL is loaded as a global from unpkg in index.html.
 */
import { t, setLang, getLang, pickInitialLang, LANGS, locale } from './i18n.js?v=20261114a';

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
  toll: { color: '#FDE047', swatch: 'square' },
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
  'Ferry terminal': 'mode.terminal', 'River bridge': 'mode.river', 'Toll station': 'mode.toll',
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
  if (p.subtitle === 'DR') return t('sub.dr');
  if (p.about) return t(`about.${p.about}.sub`);
  return p.subtitle;
}
const INFRA = ['station', 'toll', 'terminal', 'rivercross'];
const ESSENTIAL = ['city', 'border']; // these stay on with All off
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
const flatCoords = (g) => ({ Point: [g.coordinates], LineString: g.coordinates, Polygon: g.coordinates[0], MultiLineString: g.coordinates.flat(1), MultiPolygon: g.coordinates.flat(2) })[g.type] ?? [];

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
  tab: 'plan',
  devThemes: new Set(),
  devStatus: new Set(['proposed']), // Existing starts off: open data can mislead (e.g. water kiosks)
  pop: false,
  page: null, // open page in the panel: 'coll:<key>', 'trip' or 'numbers'
  trip: { from: null, to: null },
};
let plan, depts, byId;
let tour = null; // guided tour state while it runs
let dev, popData, stats, devById = new Map();

// ---------------------------------------------------------------------------
// Map style
// ---------------------------------------------------------------------------
// Haitian place names stay in their local (French) form, or Kreyòl when that language is chosen.
const osmName = () => (getLang() === 'ht' ? ['coalesce', ['get', 'name:ht'], ['get', 'name:fr'], ['get', 'name']] : ['coalesce', ['get', 'name:fr'], ['get', 'name']]);
const osmCountryName = () => ['coalesce', ['get', `name:${getLang()}`], ['get', 'name:en'], ['get', 'name']];
const style = {
  version: 8,
  // A round Earth when zoomed out (it flattens to a normal map as you zoom in), with sky and haze at the horizon.
  projection: { type: 'globe' },
  sky: {
    'sky-color': '#0b1a2e',
    'horizon-color': '#2b4a6b',
    'fog-color': '#1d3349',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.85,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  },
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
// A saved whole-globe view (e.g. a reload during the opening swoop) counts as no view, so the swoop replays.
const hadView = Number(location.hash.match(/(?:^#|&)v=([\d.]+)/)?.[1] ?? 0) >= 3;
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
  // A first visit starts on the whole globe and swoops down to Haiti (see the end of the load handler).
  center: hadView ? [-72.75, 18.95] : [-45, 12],
  zoom: hadView ? (PHONE.matches ? 6.2 : 7.2) : PHONE.matches ? 0.6 : 1.4,
  pitch: 0,
  minZoom: 0.5,
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
// MapLibre 5 reports "Multi…" geometries by their own type, so each test accepts both forms.
const geomIs = (t) => ['in', ['geometry-type'], ['literal', [t, `Multi${t}`]]];
const isLine = geomIs('LineString');
const isPoly = geomIs('Polygon');
const isPoint = geomIs('Point');
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
  { id: 'labels-national', filter: ['all', isPoint, tierIs('national'), ['!', inCats(INFRA)]], type: 'symbol', minzoom: 4.8, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10.5, 10, 13.5], 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.8, 'text-max-width': 10, 'text-optional': true }, paint: { 'text-color': ['match', ['get', 'category'], 'water', '#A5F3FC', 'site', '#FED7AA', '#FFFFFF'], 'text-halo-color': '#05070a', 'text-halo-width': 1.6 } },
];
const INTERACTIVE = ['haz-quakes', 'dev-points-main', 'dev-points-minor', 'points-infra', 'points-national', 'points-local', 'dev-lines-solid', 'dev-lines-dashed', 'lines-dashed', 'lines-national', 'lines-local', 'water-fill', 'site-fill', 'dev-fill', 'haz-storms'];

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
  map.setFilter('dept-tint', ['==', ['get', 'name'], state.dept ?? '']);
  map.setLayoutProperty('rivers-osm', 'visibility', state.hidden.has('water') ? 'none' : 'visible');
  if (map.getLayer('rivers-labels')) map.setLayoutProperty('rivers-labels', 'visibility', state.hidden.has('water') ? 'none' : 'visible');
  const sel = state.dept && depts.features.find((f) => f.properties.name === state.dept);
  map.getSource('dept-mask').setData({ type: 'FeatureCollection', features: sel ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...sel.geometry.coordinates.map((poly) => poly[0])] } }] : [] });
  map.setLayoutProperty('rail-marks', 'visibility', state.rail ? 'visible' : 'none');
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
const getJSON = (u) => fetch(u).then((r) => r.json());
const dataReady = Promise.all([getJSON('data/plan.geojson'), getJSON('data/departments.geojson'), getJSON('data/dev.geojson'), getJSON('data/pop.json'), getJSON('data/stats.json'), getJSON('data/rivers.geojson'), getJSON('data/airports.geojson').catch(() => ({ features: [] }))]);
let rivers;

map.on('load', async () => {
  let airports;
  [plan, depts, dev, popData, stats, rivers, airports] = await dataReady;
  // Airports (tools/build-airports.mjs) join the Development features as their own theme.
  dev.features.push(...airports.features);
  for (const f of dev.features) {
    f._bbox = bboxOf(flatCoords(f.geometry));
    devById.set(f.properties.id, f);
  }
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

  // Selected-department spotlight: everything outside is darkened, the department gets a light tint.
  map.addSource('dept-mask', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'dept-mask', type: 'fill', source: 'dept-mask', paint: { 'fill-color': '#000000', 'fill-opacity': 0.5 } });
  map.addLayer({ id: 'dept-tint', type: 'fill', source: 'depts', filter: ['==', ['get', 'name'], ''], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.06 } });
  map.addSource('rivers', { type: 'geojson', data: rivers });
  map.addLayer({ id: 'rivers-osm', type: 'line', source: 'rivers', minzoom: 6.5, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#22D3EE', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 12, 2] } });
  map.addLayer({ id: 'dept-line', type: 'line', source: 'depts', paint: { 'line-color': '#ffffff', 'line-opacity': 0.32, 'line-width': 1, 'line-dasharray': [3, 2] } });
  map.addLayer({ id: 'dept-focus', type: 'line', source: 'depts', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-opacity': 0.9 } });

  for (const L of DATA_LAYERS) {
    if (L.type === 'symbol') continue;
    map.addLayer({ id: L.id, type: L.type, source: 'plan', filter: L.filter, ...(L.minzoom ? { minzoom: L.minzoom } : {}), ...(L.layout ? { layout: L.layout } : {}), paint: L.paint });
  }

  addDevLayers();
  addHazardLayers();

  // Hover + selection highlights sit above lines, below labels.
  map.addLayer({ id: 'hover-line', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': widthPlus(4) } });
  map.addLayer({ id: 'sel-glow', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': catColor, 'line-width': widthPlus(10), 'line-blur': 6, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'sel-line', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': catColor, 'line-width': widthPlus(2) } });
  map.addLayer({ id: 'sel-dash', type: 'line', source: 'plan', filter: ['==', ['get', 'id'], -1], paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 12, 2.5], 'line-dasharray': [0, 4, 3] } });
  map.addLayer({ id: 'sel-point', type: 'circle', source: 'plan', filter: ['==', ['get', 'id'], -1], paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  addHighlightLayers();

  map.addLayer({ id: 'dept-labels', type: 'symbol', source: 'dept-labels', minzoom: 5.5, maxzoom: 9.2, layout: { 'text-field': ['upcase', ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-letter-spacing': 0.22, 'text-allow-overlap': false }, paint: { 'text-color': '#ffffff', 'text-opacity': 0.5, 'text-halo-color': '#05070a', 'text-halo-width': 1.2 } });
  for (const L of DATA_LAYERS) {
    if (L.type !== 'symbol') continue;
    map.addLayer({ id: L.id, type: 'symbol', source: 'plan', filter: L.filter, ...(L.minzoom ? { minzoom: L.minzoom } : {}), layout: L.layout, paint: L.paint });
  }

  map.addLayer({ id: 'dev-labels', type: 'symbol', source: 'dev', minzoom: 9.2, filter: ['all', ['==', ['get', 'status'], 'proposed'], isPoint], layout: { 'text-field': devLabelExpr(), 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 10, 'text-optional': true }, paint: { 'text-color': devColor, 'text-halo-color': '#05070a', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'rivers-labels', type: 'symbol', source: 'rivers', minzoom: 9.5, layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 10.5, 'symbol-spacing': 500 }, paint: { 'text-color': '#A5F3FC', 'text-halo-color': '#05070a', 'text-halo-width': 1.3 } });
  if (state.terrain) map.setTerrain({ source: 'dem', exaggeration: 1.5 });
  // Bigger map labels on phones.
  if (PHONE.matches) {
    for (const layer of map.getStyle().layers) {
      if (layer.type !== 'symbol') continue;
      const size = map.getLayoutProperty(layer.id, 'text-size');
      if (typeof size === 'number') map.setLayoutProperty(layer.id, 'text-size', size * 1.25);
      else if (Array.isArray(size) && size[0] === 'interpolate') map.setLayoutProperty(layer.id, 'text-size', size.map((v, i) => (i > 2 && i % 2 === 0 && typeof v === 'number' ? v * 1.25 : v)));
    }
  }
  applyFilters();
  applyDevFilters();
  buildPanel();
  wireMap();
  animateDash();

  const fRaw = new URLSearchParams(location.hash.slice(1)).get('f');
  const f = fRaw && /^d\d+$/.test(fRaw) ? fRaw : Number(fRaw);
  if (typeof f === 'string' && devById.has(f)) {
    setTab('dev');
    const p = devById.get(f).properties;
    state.devThemes.add(p.theme);
    applyDevFilters();
    renderDevPanel();
    select(f, { move: !hadView });
  } else if (f && byId.has(f)) select(f, { move: !hadView });
  else if (!hadView) {
    // Let the globe draw for a moment, then swoop down to Haiti.
    const swoop = () => {
      if (swoop.done || state.selected != null) return;
      swoop.done = true;
      const cam = safeCam(HAITI_BOUNDS, { padding: PHONE.matches ? { top: 40, left: 2, right: 44, bottom: 170 } : pad() });
      if (cam) map.flyTo({ ...cam, pitch: PHONE.matches ? 0 : 38, bearing: PHONE.matches ? 0 : -4, duration: 4800, curve: 1.6, essential: true });
    };
    map.once('idle', () => setTimeout(swoop, 500));
    setTimeout(swoop, 2500);
  }
  if (!f) setTimeout(maybeShowHint, hadView ? 1500 : 6500);
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
  zoomOut: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M8 11h6"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>',
  route: '<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/></svg>',
};

// Small line icons that label kinds of things: routes, places, themes, hazards and the facts on cards.
const ICO = {
  car: '<path d="M4 16v-4l2.2-5h11.6L20 12v4"/><path d="M3 16h18M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>',
  train: '<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 16l-1.5 4M15 16l1.5 4M8 19h8"/><circle cx="9" cy="13" r=".7"/><circle cx="15" cy="13" r=".7"/>',
  bus: '<rect x="5" y="3" width="14" height="15" rx="2.5"/><path d="M5 11h14M8 21v-3M16 21v-3"/><circle cx="8.5" cy="14.5" r=".7"/><circle cx="15.5" cy="14.5" r=".7"/>',
  road: '<path d="M8 3 4 21M16 3l4 18M12 4v3M12 11v3M12 18v2"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21Z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  mapf: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.2"/><path d="M15.6 14.3A5 5 0 0 1 21 19"/>',
  hospital: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.6-1-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 3 5.8 1.5 5.8 4.3 0 1.3-1.3 2.1-3 2.1-1.3 0-2.4-.5-3-1.5M12 6v1.8M12 16.3V18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  mountain: '<path d="m2 20 7-12 4 6 2-3 7 9Z"/>',
  tunnel: '<path d="m2 20 7-12 4 6 2-3 7 9Z"/><path d="M9 20v-3a2 2 0 0 1 4 0v3"/>',
  bridge: '<path d="M2 8h20M4 8v12M20 8v12M2 20h20M4 8c3 5 5 6 8 6s5-1 8-6M8 12v8M16 12v8"/>',
  ship: '<path d="M3 15h18l-2.5 5h-13Z"/><path d="M6 15V9h12v6M12 4v5M9 6h6"/>',
  anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 13a7 7 0 0 0 14 0M8 11h8"/>',
  ring: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>',
  station: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  island: '<path d="M3 18c3-2 6-2 9 0s6 2 9 0"/><path d="M8 15c0-3 2-5 4-5s4 2 4 5"/><path d="M12 10V4l4 2-4 2"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  city: '<path d="M3 21h18M5 21V8l5-3v16M10 21V10h9v11M13 13h3M13 16h3"/>',
  town: '<path d="M4 11 12 4l8 7v9H4Z"/><path d="M10 20v-5h4v5"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  leaf: '<path d="M5 19c0-8 6-14 15-14 0 9-6 15-14 15"/><path d="M5 19c3-4 6-6 9-7"/>',
  pipe: '<path d="M3 7h10v6h8M3 11h6v6h12"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17v.01"/>',
  tree: '<path d="M12 22v-6M12 2 6 10h3l-4 6h14l-4-6h3Z"/>',
  storm: '<circle cx="12" cy="12" r="2.5"/><path d="M12 3C7 3 4 6 4 9M12 21c5 0 8-3 8-6M4.5 15c.5 4 3.5 6 7.5 6M19.5 9C19 5 16 3 12 3"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
  quake: '<path d="M2 12h4l2-5 3 10 3-12 2 7h6"/>',
  depth: '<path d="M12 4v13M6 11l6 6 6-6M4 20h16"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  home: '<path d="M4 11 12 4l8 7v9H4Z"/>',
  plane: '<path d="M10.5 3.5a1.5 1.5 0 0 1 3 0V9l7 4v2l-7-2v4.5l2 1.5v1.5l-3.5-1-3.5 1V19l2-1.5V13l-7 2v-2l7-4Z"/>',
};
const ico = (name) => (ICO[name] ? `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICO[name]}</svg>` : '');
const CAT_ICON = { corridor: 'train', trunk: 'train', bridge: 'bridge', ferry: 'ship', ring: 'ring', urban: 'bus', feeder: 'road', station: 'station', terminal: 'anchor', rivercross: 'bridge', toll: 'coin', water: 'drop', border: 'flag', city: 'city', town: 'town', site: 'shield' };
const THEME_ICON = { energy: 'bolt', water: 'drop', sanitation: 'pipe', agri: 'leaf', housing: 'home', economy: 'briefcase', connectivity: 'wifi', health: 'hospital', resilience: 'alert', environment: 'tree', strategic: 'shield', air: 'plane' };
const ENG_ICON = { surface: 'road', mountain: 'mountain', viaduct: 'bridge', tunnel: 'tunnel' };

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
// Smart zoom (in place of "my location"): zoomed out → zoom in on what you're looking at (or the selected
// item); zoomed in → back out to all of Haiti. The icon shows which way the next tap goes.
const ZOOM_SPLIT = 9;
class ZoomToggleControl {
  onAdd() {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    el.innerHTML = '<button class="ctl" id="btnZoomT"></button>';
    el.querySelector('#btnZoomT').onclick = zoomToggle;
    map.on('zoomend', updateZoomToggle);
    setTimeout(updateZoomToggle);
    return el;
  }
  onRemove() {}
}
map.addControl(new ZoomToggleControl(), 'top-right');
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
  closeSelection.saved = null;
  clearSelection();
  setDept(null, { move: false });
  fitView(HAITI_BOUNDS, { padding: pad(), pitch: state.terrain ? 38 : 0, bearing: 0, duration: 1400 });
}

function pad() {
  if (tour && PHONE.matches) return { top: 230, bottom: 40, left: 24, right: 64 };
  if (tour) return { top: 60, bottom: 220, left: state.collapsed ? 60 : $('#panel').getBoundingClientRect().right + 40, right: 80 };
  if (state.collapsed) return { top: 60, bottom: 60, left: 60, right: 70 };
  if (PHONE.matches) {
    // Use the sheet's target height (it may still be animating).
    const st = $('#panel').dataset.state;
    const h = st === 'peek' ? 152 : window.innerHeight * (st === 'tall' ? 0.75 : 0.52);
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
    if (id && hazById.has(id)) {
      const p = hazById.get(id).properties;
      tip.innerHTML = p.kind === 'storm' ? `${esc(p.name || t('haz.unnamed'))} ${p.year}<small>${esc(stormCat(p.cat))}</small>` : `${esc(p.label)}<small>${esc(p.place ?? '')}</small>`;
      tip.style.left = `${e.point.x}px`;
      tip.style.top = `${e.point.y}px`;
      tip.hidden = false;
    } else if (id && devById.has(id)) {
      const p = devById.get(id).properties;
      tip.innerHTML = `${esc(devName(p))}<small>${esc(t(p.status === 'proposed' ? 'dev.proposed' : 'dev.existing'))}</small>`;
      tip.style.left = `${e.point.x}px`;
      tip.style.top = `${e.point.y}px`;
      tip.hidden = false;
    } else if (id) {
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
    else if (state.selected) closeSelection();
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

// Camera moves: each tap moves only as much as it needs to, at one steady speed.
const MOVE = { duration: 1200, essential: true };
const NO_PAD = { top: 0, bottom: 0, left: 0, right: 0 };
function nearestPointOn(coords, p) {
  let best = coords[0], bd = Infinity;
  const sx = Math.cos(rad(p[1]));
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const ax = (a[0] - p[0]) * sx, ay = a[1] - p[1], bx = (b[0] - p[0]) * sx, by = b[1] - p[1];
    const dx = bx - ax, dy = by - ay;
    const t = clamp(-(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-12), 0, 1);
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bd) [bd, best] = [d, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]];
  }
  return best;
}
// opts.whole: frame the entire feature (the "Zoom to" button). Otherwise, if framing it would pull the
// camera far out, ease out at most ~1 zoom level and centre on the part of the feature nearest the view.
function fitFeature(f, opts = {}) {
  const { whole, ...rest } = opts;
  const pitch = state.terrain ? 45 : 0;
  if (f.geometry.type === 'Point') {
    const target = rest.zoom ?? (f.properties.tier === 'local' ? 12.5 : 11.5);
    map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), target), pitch, padding: pad(), ...MOVE, ...rest, zoom: Math.max(map.getZoom(), target) });
    return;
  }
  const b = f._bbox;
  const bounds = [[b[0], b[1]], [b[2], b[3]]];
  clearPadding();
  const cam = safeCam(bounds, { padding: pad(), maxZoom: 13.5 });
  const cur = map.getZoom();
  if (!whole && cam && cam.zoom < cur - 1) {
    const coords = flatCoords(f.geometry);
    const c = map.getCenter();
    map.easeTo({ center: nearestPointOn(coords.length > 1 ? coords : [coords[0], coords[0]], [c.lng, c.lat]), zoom: cur - 1, pitch, padding: pad(), ...MOVE, ...rest });
    return;
  }
  if (cam) map.fitBounds(bounds, { padding: pad(), maxZoom: 13.5, pitch, ...MOVE, ...rest });
}

const saveView = () => ({ center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), padding: map.getPadding() });
function select(id, { move = true } = {}) {
  if (tour) endTour();
  if (move && state.selected == null && !closeSelection.saved) closeSelection.saved = saveView();
  if (typeof id === 'string' && hazById.has(id)) return selectHaz(id, { move });
  if (typeof id === 'string' && devById.has(id)) return selectDev(id, { move });
  const f = byId.get(id);
  if (!f) return;
  stopFly();
  clearDevSelection();
  // A city or town picked anywhere (map, search) opens its department, so the panel always reads
  // departments → cities → details. The view to return to is the one from before this tap.
  if (!PHONE.matches && !state.page && ['city', 'town', 'station'].includes(f.properties.category) && f.properties.dept && state.dept !== f.properties.dept) {
    const back = closeSelection.saved ?? saveView();
    if (state.tab !== 'plan') setTab('plan');
    setDept(f.properties.dept, { move: false });
    setDept.saved = back;
    closeSelection.saved = back;
  }
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
  setTab(state.tab);
  placeDetail();
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
  openedPage();
  if (move) requestAnimationFrame(() => fitFeature(f));
}

// A selected item is its own "page": on phones its details replace the panel's home view, and the
// browser/phone Back button closes it and returns home. One history entry per visit, however many
// items are opened in a row.
function openedPage() {
  // Picked from search: close the keyboard and step the sheet down so the map shows the item.
  if (PHONE.matches && document.activeElement === $('#search')) {
    $('#search').blur();
    setSheet('half');
  }
  if (!history.state?.sel) history.pushState({ ...(history.state ?? {}), sel: true }, '', location.href);
  hideHintIfShown();
  syncPage();
  $('#panelBody').scrollTop = 0;
}
function setFocus() {
  const page = !!state.page && !$('#page').hidden;
  const focus = PHONE.matches && ((state.selected != null && !$('#detail').hidden) || page);
  $('#panel').classList.toggle('focus', focus);
  // Phones: an open department is a screen of its own (Back, departments, its cities, its card).
  $('#panel').classList.toggle('deptmode', PHONE.matches && !focus && !!state.dept && state.tab === 'plan' && $('#results').hidden);
}
// Back steps are driven by what the new history entry says should be open.
window.addEventListener('popstate', () => {
  const hs = history.state ?? {};
  if (!hs.sel && state.selected != null) closeSelection({ fromBack: true });
  if ((hs.page ?? null) !== state.page) renderPage(hs.page ?? null);
  if (!hs.dept && state.dept) setDept(null, { fromBack: true });
  if (closeDept.pending) {
    if (hs.dept || hs.sel) return history.back();
    closeDept.pending = false;
  }
  if (leaveToHome.fn) {
    if (hs.sel || hs.page) return history.back();
    const fn = leaveToHome.fn;
    leaveToHome.fn = null;
    fn();
  }
});

// Closing (✕, Back, Escape, tapping empty map) returns the camera to where it was before the first selection.
function closeSelection({ fromBack = false } = {}) {
  // Let the history step do the closing, so Back and ✕ always agree.
  if (!fromBack && history.state?.sel) return history.back();
  const v = closeSelection.saved;
  closeSelection.saved = null;
  clearSelection();
  if (v) map.flyTo({ ...MOVE, ...v });
}

function clearSelection() {
  state.selected = null;
  clearDevSelection();
  for (const l of ['sel-glow', 'sel-line', 'sel-dash', 'sel-point']) map.getLayer(l) && map.setFilter(l, ['==', ['get', 'id'], -1]);
  setHashParam('f', null);
  $('#detail').hidden = true;
  $('#detail').innerHTML = '';
  if (profileMarker) profileMarker.remove();
  showSec(null);
  placeDetail();
}

// With a department open, the panel reads top to bottom: departments → its cities → details.
// A selected place in that department shows its details in place of the department card.
function placeDetail() {
  const det = $('#detail');
  const inDept = !PHONE.matches && !state.page && state.dept && state.tab === 'plan' && !det.hidden;
  if (inDept && det.parentElement !== $('#deptSlot')) $('#deptSlot').appendChild(det);
  if (!inDept && det.parentElement !== $('#panelBody')) $('#panelBody').insertBefore(det, $('#home'));
  $('#deptCard').hidden = !!inDept;
  $('#stats').hidden = !!state.dept;
  // The three main actions sit under an open department (after its cities and card), else under the stats.
  const acts = document.querySelector('.home-actions');
  const anchor = state.dept ? $('#deptCard') : $('#stats');
  if (acts.previousElementSibling !== anchor) anchor.after(acts);
  acts.classList.toggle('in-dept', !!state.dept);
  document.querySelectorAll('#deptCities .chip').forEach((c) => c.classList.toggle('on', Number(c.dataset.id) === state.selected));
  if (inDept) $('#depts').scrollIntoView({ block: 'start', behavior: 'smooth' });
  syncPage();
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

const itemId = (v) => (/^d\d+$/.test(v) ? v : Number(v));

function itemHTML(f, right) {
  if (devById.has(f.properties.id)) return devItemHTML(f);
  const p = f.properties;
  const sub = [displaySub(p), p.dept].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || catOne(p.category);
  return `<li><button class="item" data-id="${p.id}" style="--c:${CATS[p.category].color}">
      <span class="ico-c">${ico(CAT_ICON[p.category])}</span>
      <span class="t"><b>${esc(displayName(p))}</b><small>${esc(sub)}</small></span>
      <span class="k">${right ?? (p.km ? fmtKm(p.km) : '')}${right == null && f.geometry.type === 'LineString' && engKind(p) ? `<small class="cost-k">≈ ${fmtMoney(routeMid(f))}</small>` : ''}</span></button></li>`;
}

function renderDetail(f) {
  const p = f.properties;
  const cat = CATS[p.category];
  const g = f.geometry;
  const isLineF = g.type === 'LineString';
  const token = ++selectToken;
  // Each fact may do something when tapped: explain itself (info), open something (nav) or copy.
  const facts = [];
  if (g.type === 'Point') facts.push([`${g.coordinates[1].toFixed(4)}, ${g.coordinates[0].toFixed(4)}`, t('fact.latlon'), 'copy', 'pin']);
  if (p.km) facts.push([fmtKm(p.km), t(g.type === 'Polygon' ? 'fact.perimeter' : 'fact.length'), null, 'ruler']);
  if (p.mode) facts.push([modeText(p), t('fact.mode'), engKind(p) ? 'mode' : null, CAT_ICON[p.category] ?? 'road']);
  facts.push([p.dept ?? t('fact.crossBorder'), t('fact.dept'), p.dept ? 'dept' : null, 'mapf']);
  const badges = [`<button class="badge tap info" data-act="tier">${t(p.tier === 'local' ? 'badge.local' : 'badge.national')}</button>`];
  if (p.tunnel) badges.push(`<button class="badge tunnel tap info" data-act="tunnel">${t('badge.tunnel')} · ${esc(tunnelName(p.tunnel))}</button>`);
  if (p.mode === RAIL_MODE) badges.push(`<button class="badge rail tap info" data-act="rail">${t('badge.rail')}</button>`);
  if (p.about) badges.push(`<span class="badge proposed">${t(`about.${p.about}.badge`)}</span>`);
  const gm = g.type === 'Point'
    ? `https://www.google.com/maps/search/?api=1&query=${g.coordinates[1]},${g.coordinates[0]}`
    : isLineF
      ? `https://www.google.com/maps/dir/?api=1&origin=${g.coordinates[0][1]},${g.coordinates[0][0]}&destination=${g.coordinates.at(-1)[1]},${g.coordinates.at(-1)[0]}`
      : `https://www.google.com/maps/search/?api=1&query=${(f._bbox[1] + f._bbox[3]) / 2},${(f._bbox[0] + f._bbox[2]) / 2}`;
  const conns = connections(f);
  const place = stats?.places[p.id] && ['city', 'town', 'station'].includes(p.category);
  const el = $('#detail');
  el.innerHTML = `
    <div class="detail-top">${backBtn()}<span class="pill" style="--c:${cat.color}">${ico(CAT_ICON[p.category])}${esc(catOne(p.category))}</span></div>
    <h2>${esc(displayName(p))}</h2>
    ${displaySub(p) ? `<p class="sub">${esc(displaySub(p))}</p>` : ''}
    <div class="badges">${badges.join('')}</div>
    ${p.about ? `<p class="note">${t(`about.${p.about}`)}</p>` : ''}
    ${place ? glanceHTML(f, conns) : ''}
    ${p.derived ? `<p class="note">${t(`note.${p.category}`)}${p.serves ? `<br><b>${t('note.serves')}</b> ${esc(p.serves)}` : ''}</p>` : ''}
    <div class="facts" ${place ? 'hidden' : ''}>${facts.slice(0, 3).map(([v, k, act, icon]) => factHTML(v, k, act, '', icon)).join('')}</div>
    <div class="actions">
      ${['city', 'town'].includes(p.category) ? `<button class="btn primary" id="btnTrip">${ICONS.route} ${t('btn.tripFrom')}</button>` : ''}
      ${isLineF && p.km > 2 ? `<button class="btn primary" id="btnFly">${ICONS.fly} ${t('btn.fly')}</button>` : ''}
      <button class="btn" id="btnZoom">${ICONS.zoom} ${t('btn.zoom')}</button>
      <a class="btn" href="${gm}" target="_blank" rel="noopener">${ICONS.map} ${t(isLineF ? 'btn.today' : 'btn.gmaps')}</a>
      <button class="btn" id="btnShareF">${ICONS.share} ${t('btn.share')}</button>
    </div>
    ${isLineF && p.category === 'ferry' ? engineeringHTML(f, null, null) : ''}
    ${isLineF && !['border', 'ferry'].includes(p.category) ? `<div class="profile" id="profile"><div class="profile-head"><h3>${t('prof.title')}</h3><span>${esc(fmtKm(p.km))}</span></div><div class="loading">${t('prof.measuring')}</div></div>` : ''}
    ${conns.length ? `<p class="sub-head">${t(g.type === 'Point' ? 'list.within3' : 'list.connects')}</p><ul class="list">${conns.map((c) => itemHTML(c)).join('')}</ul>` : ''}
  `;
  el.hidden = false;
  el.querySelector('#detailClose').onclick = closeSelection;
  el.querySelector('#btnZoom').onclick = () => fitFeature(f, { whole: true });
  el.querySelector('#btnShareF').onclick = () => share(displayName(p));
  el.querySelector('#btnFly')?.addEventListener('click', () => flyAlong(f));
  el.querySelector('#btnTrip')?.addEventListener('click', () => {
    state.trip.from = canonicalPlace(p.id);
    openPage('trip');
  });
  wireActs(el, f);
  el.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(itemId(b.dataset.id))));
  el.querySelectorAll('.planned .chip').forEach((b) => (b.onclick = () => select(b.dataset.id)));
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

  box.insertAdjacentHTML('afterend', engineeringHTML(f, s, sm));

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
  // Mouse: hover to read. Finger: press and drag along the graph; the reading stays where you lift off.
  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    onMove(e);
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || svg.hasPointerCapture(e.pointerId)) onMove(e);
  });
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
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
      fitFeature(f, { duration: 2000, whole: true });
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
  $('#depts').querySelectorAll('.chip').forEach((c) => (c.onclick = () => (state.dept === c.dataset.d ? closeDept() : setDept(c.dataset.d))));
  $('#clearDept').onclick = closeDept;

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

  // Plan | Development tabs
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => (b.onclick = () => {
    if (state.page) closePage();
    setTab(b.dataset.tab);
  }));
  $('#btnTripHome').onclick = () => openPage('trip');
  $('#btnNumbers').onclick = () => openPage('numbers');
  $('#btnTour').onclick = startTour;
  $('#popToggle').onclick = togglePop;
  $('#popToggle').onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), togglePop());
  $('#popHint').textContent = t('dev.popHint', { n: fmtPeople(popData.total) });
  document.querySelectorAll('.status-chips .chip').forEach((c) => (c.onclick = () => {
    const st = c.dataset.status;
    state.devStatus.has(st) ? state.devStatus.delete(st) : state.devStatus.add(st);
    if (!state.devStatus.size) state.devStatus.add(st === 'existing' ? 'proposed' : 'existing');
    applyDevFilters();
    renderDevPanel();
  }));
  renderDevPanel();
  renderHazards();

  // Hide / show the panel (remembered on this device).
  $('#collapseBtn').onclick = () => setCollapsed(true);
  $('#edgeTab').onclick = () => {
    if (panelResize.dragged) return (panelResize.dragged = false);
    setCollapsed(!state.collapsed);
  };
  panelResize();
  $('#edgeTab').title = t('panel.hide');
  $('#allLayers').onclick = () => {
    const optional = CAT_KEYS.filter((k) => !ESSENTIAL.includes(k));
    const anyOn = optional.some((k) => !state.hidden.has(k)) || state.rail;
    optional.forEach((k) => (anyOn ? state.hidden.add(k) : state.hidden.delete(k)));
    state.rail = !anyOn;
    applyFilters();
    renderLayers();
  };
  $('#allThemes').onclick = () => {
    if (state.devThemes.size) state.devThemes.clear();
    else Object.keys(DEV_THEMES).forEach((k) => state.devThemes.add(k));
    applyDevFilters();
    renderDevPanel();
  };
  $('#openPanel').onclick = () => setCollapsed(false);
  try {
    if (localStorage.getItem('panelCollapsed') === '1') setCollapsed(true);
  } catch {
    /* storage unavailable */
  }

  // Sheet handle (phone)
  $('#sheetHandle').onclick = () => {
    const s = $('#panel').dataset.state;
    setSheet(s === 'full' ? 'peek' : 'full');
  };
  // Map (floating, bottom middle, shown while the panel fills the screen): hide the panel to show the
  // whole map. The "Haiti Plan" button then appears in the same spot to bring it back.
  $('#mapBtn').onclick = () => {
    setSheet('peek');
    setCollapsed(true);
  };
  // Drag the sheet by its handle, title or tabs: it follows the finger. Up → all the way to the top.
  // Down → back to the small view, or off the screen (the "Haiti Plan" button brings it back).
  // A tap on a tab still works; only a real drag moves the sheet.
  let drag = null;
  let suppressClick = false;
  const sheet = $('#panel');
  // The item's header is a drag zone too: on phones it replaces the title box while something is open.
  const ZONES = '.sheet-handle, .brand-row, .tabs, .detail-top, #detail > h2, #page > h2, .deptmode #home .block-head, #deptBack';
  {
    const z = sheet;
    z.addEventListener('pointerdown', (e) => {
      if (!PHONE.matches || !e.target.closest(ZONES)) return;
      suppressClick = false;
      drag = { y: e.clientY, h: sheet.getBoundingClientRect().height, state: sheet.dataset.state, moved: false, z, id: e.pointerId };
    });
    z.addEventListener('pointermove', (e) => {
      if (!drag || drag.z !== z) return;
      drag.lastY = e.clientY;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) > 8) {
        drag.moved = true;
        z.setPointerCapture(drag.id);
        sheet.style.transition = 'none';
      }
      if (drag.moved) sheet.style.height = `${clamp(drag.h - dy, 40, window.innerHeight)}px`;
    });
    const end = (e) => {
      if (!drag || drag.z !== z) return;
      const { moved } = drag;
      const vh = window.innerHeight;
      // Height of the sheet where the finger let go.
      // Use the last real finger position: a cancelled touch can report a bogus position.
      const released = clamp(drag.h - ((drag.lastY ?? drag.y) - drag.y), 0, vh);
      sheet.style.transition = '';
      sheet.style.height = '';
      drag = null;
      if (!moved) return;
      // Swallow only the click that ends this drag (if the browser sends one), never a later tap.
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 350);
      // Snap to whichever size is closest to where the finger let go: hidden, small, middle or full.
      const snaps = [['hidden', 40], ['peek', 152], ['half', vh * 0.52], ['tall', vh * 0.75], ['full', vh]];
      const [name] = snaps.reduce((a, b) => (Math.abs(b[1] - released) < Math.abs(a[1] - released) ? b : a));
      if (name === 'hidden') {
        setSheet('peek');
        setCollapsed(true);
      } else setSheet(name);
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  }
  sheet.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tour) return endTour();
    if (e.key === 'Escape' && document.activeElement === document.body) {
      stopFly();
      closeSelection();
    }
  });
}

function setCollapsed(on) {
  state.collapsed = on;
  $('#panel').classList.toggle('collapsed', on);
  $('#panel').setAttribute('aria-hidden', on);
  $('#openPanel').hidden = !on || !PHONE.matches; // on desktop the edge tab reopens the panel
  $('#edgeTab').classList.toggle('collapsed', on);
  $('#edgeTab').setAttribute('aria-label', t(on ? 'panel.show' : 'panel.hide'));
  $('#edgeTab').title = t(on ? 'panel.show' : 'panel.hide');
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
    [Math.round(railKm).toLocaleString(locale()) + ' km', t('stat.rail'), 'trunks', 'train'],
    [rings, t('stat.rings', { n: micro }), 'rings', 'ring'],
    [tot.station.count, t('stat.stations'), 'stations', 'station'],
    [islands.size, t('stat.islands'), 'islands', 'island'],
  ].map(([b, s, k, i]) => `<button class="stat tap nav" data-coll="${k}"><b>${b}</b><span>${ico(i)}${s}</span></button>`).join('');
  $('#stats').querySelectorAll('[data-coll]').forEach((b) => (b.onclick = () => openPage(`coll:${b.dataset.coll}`)));

}

function renderLayers() {
  const tot = catTotals(plan.features);
  const anyOn = CAT_KEYS.filter((k) => !ESSENTIAL.includes(k)).some((k) => !state.hidden.has(k)) || state.rail;
  $('#allLayers').textContent = t(anyOn ? 'layers.allOff' : 'layers.allOn');
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

// An open department is its own step in the history: Back (button or phone) closes it.
function closeDept() {
  if (history.state?.dept) {
    closeDept.pending = true;
    history.back();
  } else setDept(null);
}
function setDept(name, { move = true, fromBack = false } = {}) {
  if (name && !fromBack) {
    const hs = history.state ?? {};
    if (!hs.dept) history.pushState({ ...hs, dept: name }, '', location.href);
    else if (hs.dept !== name) history.replaceState({ ...hs, dept: name }, '', location.href);
  }
  // Details of something outside the newly chosen department would sit in the wrong place.
  const cur = state.selected != null && (byId.get(state.selected) ?? devById.get(state.selected));
  if (name && cur && cur.properties.dept !== name) clearSelection();
  // Remember the view before the first department is opened, and return to it when the department is closed.
  const prevDept = state.dept;
  if (name && !prevDept) setDept.saved = closeSelection.saved ?? saveView();
  if (name && !prevDept) closeSelection.saved = null;
  // Closing the department also closes a city or route opened inside it.
  if (!name && prevDept && state.selected != null) {
    closeSelection.saved = null;
    clearSelection();
  }
  if (!name && prevDept && move && setDept.saved) map.flyTo({ ...MOVE, ...setDept.saved });
  if (!name) setDept.saved = null;
  state.dept = name;
  applyFilters();
  $('#depts').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.d === name));
  $('#depts').classList.toggle('compact', !!name);
  $('#deptBack').hidden = !name;
  const card = $('#deptCard');
  if (!name) {
    card.innerHTML = '';
    $('#deptCities').innerHTML = '';
    placeDetail();
    return;
  }
  const feats = plan.features.filter((f) => f.properties.dept === name);
  const tt = catTotals(feats);
  const roadKm = ROAD_CATS.reduce((s, k) => s + tt[k].km, 0);
  const towns = tt.city.count + tt.town.count;
  // Main cities and towns of the department, largest first.
  const seen = new Set();
  const cities = feats
    .filter((f) => ['city', 'town'].includes(f.properties.category))
    .sort((a, b) => (stats?.places[b.properties.id]?.p5 ?? 0) - (stats?.places[a.properties.id]?.p5 ?? 0))
    .filter((f) => { const k = norm(f.properties.name.replace(/\s*\(.*\)$/, '')); return seen.has(k) ? false : seen.add(k); })
    .slice(0, 12);
  const routes = feats.filter((f) => ROAD_CATS.includes(f.properties.category) && f.properties.tier === 'national').sort((a, b) => b.properties.km - a.properties.km).slice(0, 8);
  card.innerHTML = `<div class="dept-card">
    <h3>${esc(name)}</h3>
    <p>${stats?.depts[name] ? `<b>${t('dev.deptPeople', { n: fmtPeople(stats.depts[name]) })}</b> · ` : ''}${t('dept.summary', { n: feats.length, km: fmtKm(roadKm), towns })}</p>
    <p class="dept-cost">${ico('coin')}${t('dept.cost', { cost: fmtMoney(feats.filter((f) => f.geometry.type === 'LineString' && engKind(f.properties)).reduce((sum, f) => sum + routeMid(f), 0)) })}</p>
    <div class="bar">${ROAD_CATS.filter((k) => tt[k].km).map((k) => `<span style="--c:${CATS[k].color};width:${(tt[k].km / roadKm) * 100}%" title="${catLabel(k)}: ${fmtKm(tt[k].km)}"></span>`).join('')}</div>
    <div class="legend-row legs">${ROAD_CATS.filter((k) => tt[k].km).map((k) => `<button class="leg nav" data-coll="cat-${k}@${esc(name)}" style="--c:${CATS[k].color}">${ico(CAT_ICON[k])}${catLabel(k)} ${fmtKm(tt[k].km)}</button>`).join('')}</div>
    ${routes.length ? `<p class="sub-head">${t('list.main')}</p><ul class="list">${routes.map((f) => itemHTML(f)).join('')}</ul>` : ''}
  </div>`;
  $('#deptCities').innerHTML = cities.length ? `<p class="sub-head" style="margin:12px 0 6px">${t('dept.cities')}</p><div class="depts compact city-chips">${cities.map((f) => `<button class="chip ${state.selected === f.properties.id ? 'on' : ''}" data-id="${f.properties.id}">${esc(f.properties.name.replace(/\s*\(.*\)$/, ''))}</button>`).join('')}</div>` : '';
  $('#deptCities').querySelectorAll('.chip').forEach((b) => (b.onclick = () => (state.selected === Number(b.dataset.id) ? closeSelection() : select(Number(b.dataset.id)))));
  card.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(itemId(b.dataset.id))));
  card.querySelectorAll('[data-coll]').forEach((b) => (b.onclick = () => openPage(`coll:${b.dataset.coll}`)));
  placeDetail();
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
  if (PHONE.matches) $('#panelBody').scrollTop = 0;
  else $('#depts').scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (move) {
    const d = depts.features.find((f) => f.properties.name === name);
    const b = bboxOf(d.geometry.coordinates.flat(2));
    const pd = pad();
    const cam = safeCam([[b[0], b[1]], [b[2], b[3]]], { padding: { ...pd, top: 20, bottom: PHONE.matches ? pd.bottom : 20, right: 40 } });
    // A touch closer than an exact fit: the department fills the view, its edges may crop slightly.
    if (cam) map.flyTo({ center: cam.center, zoom: cam.zoom + 0.1, pitch: state.terrain ? 30 : 0, bearing: 0, padding: NO_PAD, ...MOVE });
  }
}

function runSearch(q) {
  const box = $('#results');
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) {
    box.hidden = true;
    setTab(state.tab);
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
  for (const f of dev?.features ?? []) {
    const p = f.properties;
    if (p.kind === 'protectedLabel' || (!p.name && p.status === 'existing')) continue;
    const hay = norm(`${devName(p)} ${p.name ?? ''} ${p.place ?? ''} ${p.dept ?? ''} ${t(`theme.${p.theme}`)[0]}`);
    if (terms.every((w) => hay.includes(w))) hits.push([(norm(devName(p)).startsWith(terms[0]) ? 5 : 20) + (p.status === 'existing' ? 5 : 0), f]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  box.innerHTML = hits.length
    ? `<p class="results-head">${hits.length === 1 ? t('res.one') : t('res.count', { n: hits.length })}</p><ul class="list">${hits.slice(0, 40).map(([, f]) => itemHTML(f)).join('')}</ul>`
    : `<p class="empty">${t('res.none', { q: esc(q) })}</p>`;
  box.hidden = false;
  $('#home').hidden = true;
  $('#devHome').hidden = true;
  syncPage();
  box.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(itemId(b.dataset.id))));
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
  updateZoomToggle();
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
  setLang(code, { remember: true });
  applyStaticText();
  const label = LANGS.find((l) => l.code === code)?.label;
  if (!plan) return;
  $('#popHint').textContent = t('dev.popHint', { n: fmtPeople(popData.total) });
  renderStats();
  renderLayers();
  if (state.dept) setDept(state.dept, { move: false });
  if (state.selected && byId.has(state.selected)) renderDetail(byId.get(state.selected));
  if (state.selected && devById.has(state.selected)) renderDevDetail(devById.get(state.selected));
  renderDevPanel();
  if (map.getLayer('dev-labels')) map.setLayoutProperty('dev-labels', 'text-field', devLabelExpr());
  if ($('#search').value) runSearch($('#search').value);
  if (state.page) renderPage(state.page, { move: false, keep: true });
  renderHazards();
  if (state.selected && hazById.has(state.selected)) renderHazDetail(hazById.get(state.selected));
  changeLang.busy = true;
  if (tour) showStep(tour.i);
  else if (!$('#tour').hidden) maybeShowHint(true);
  changeLang.busy = false;
  if (map.getLayer('labels-infra')) map.setLayoutProperty('labels-infra', 'text-field', infraLabel());
  for (const id of ['osm-water', 'osm-towns', 'osm-islands', 'osm-villages', 'osm-suburbs']) map.getLayer(id) && map.setLayoutProperty(id, 'text-field', osmName());
  map.getLayer('osm-airports') && map.setLayoutProperty('osm-airports', 'text-field', ['concat', '✈ ', osmName()]);
  map.getLayer('osm-country') && map.setLayoutProperty('osm-country', 'text-field', osmCountryName());
  toast(label);
}

applyStaticText();

// ---------------------------------------------------------------------------
// Development layers
// ---------------------------------------------------------------------------
const DEV_THEMES = {
  energy: '#FACC15',
  water: '#38BDF8',
  sanitation: '#D6A26B',
  agri: '#84CC16',
  housing: '#FB7185',
  economy: '#E879F9',
  connectivity: '#818CF8',
  air: '#93C5FD',
  health: '#2DD4BF',
  resilience: '#EF4444',
  environment: '#22C55E',
  strategic: '#94A3B8',
};
const devColor = ['match', ['get', 'theme'], ...Object.entries(DEV_THEMES).flat(), '#ffffff'];
const MINOR_KINDS = ['clinic', 'waterKiosk', 'waterTower', 'substation', 'university'];
const devLabelExpr = () => ['match', ['get', 'kind'], ...DEV_KIND_KEYS.flatMap((k) => [k, ['concat', t(`kind.${k}`), ' · ', ['coalesce', ['get', 'place'], '']]]), ['coalesce', ['get', 'place'], '']];
const DEV_KIND_KEYS = ['securityPost', 'coastGuard', 'protectZone', 'defenceBase', 'researchAgri', 'seismicStation', 'solar', 'wind', 'hydro', 'microgrid', 'waterPlant', 'sewagePlant', 'agriHub', 'portHub', 'dryPort', 'borderZone', 'techHub', 'ruralHub', 'healthGap', 'faultCross', 'airportUpgrade', 'airportHub', 'airportNew'];

function fmtPeople(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 })} M`;
  if (n >= 10000) return (Math.round(n / 1000) * 1000).toLocaleString(locale());
  if (n >= 1000) return (Math.round(n / 100) * 100).toLocaleString(locale());
  return Math.round(n).toLocaleString(locale());
}

function addDevLayers() {
  map.addSource('dev', { type: 'geojson', data: dev });
  map.addSource('pop', { type: 'geojson', data: { type: 'FeatureCollection', features: popData.points.map(([x, y, v]) => ({ type: 'Feature', properties: { v }, geometry: { type: 'Point', coordinates: [x, y] } })) } });
  const before = 'casing-local';
  map.addLayer({ id: 'pop-heat', type: 'heatmap', source: 'pop', maxzoom: 14, layout: { visibility: 'none' }, paint: {
    'heatmap-weight': ['interpolate', ['linear'], ['get', 'v'], 0, 0, 3000, 0.35, 30000, 1],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.9, 11, 2],
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 9, 9, 22, 12, 60],
    'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(250,204,21,0.35)', 0.4, 'rgba(245,158,11,0.6)', 0.7, 'rgba(239,68,68,0.75)', 1, 'rgba(255,255,255,0.9)'],
    'heatmap-opacity': 0.75,
  } }, before);
  map.addLayer({ id: 'dev-fill', type: 'fill', source: 'dev', filter: isPoly, paint: { 'fill-color': devColor, 'fill-opacity': ['match', ['get', 'kind'], 'floodZone', 0.42, 0.3] } }, before);
  const lineBase = { type: 'line', source: 'dev', layout: { 'line-join': 'round', 'line-cap': 'round' } };
  map.addLayer({ ...lineBase, id: 'dev-lines-solid', filter: ['in', ['get', 'kind'], ['literal', ['powerline', 'canal', 'runway']]], paint: { 'line-color': devColor, 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, ['match', ['get', 'kind'], 'runway', 2.5, 0.8], 12, ['match', ['get', 'kind'], 'runway', 9, 2.2], 15, ['match', ['get', 'kind'], 'runway', 40, 3]] } });
  map.addLayer({ ...lineBase, id: 'dev-lines-dashed', layout: { 'line-join': 'round' }, filter: ['in', ['get', 'kind'], ['literal', ['cable', 'fault', 'protected']]], paint: { 'line-color': devColor, 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 12, 2.4], 'line-dasharray': [2.5, 1.6] } });
  // Utility backbones laid in the same right of way as the rail + highway corridors (offset either side).
  const corridor = ['==', ['get', 'mode'], RAIL_MODE];
  map.addLayer({ id: 'backbone-power', type: 'line', source: 'plan', layout: { visibility: 'none', 'line-join': 'round' }, filter: corridor, paint: { 'line-color': DEV_THEMES.energy, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 12, 2], 'line-offset': ['interpolate', ['linear'], ['zoom'], 6, 3, 12, 7], 'line-dasharray': [4, 2] } });
  map.addLayer({ id: 'backbone-fiber', type: 'line', source: 'plan', layout: { visibility: 'none', 'line-join': 'round' }, filter: ['any', corridor, ['all', ['==', ['get', 'category'], 'ring'], ['==', ['get', 'tier'], 'national']]], paint: { 'line-color': DEV_THEMES.connectivity, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 12, 2], 'line-offset': ['interpolate', ['linear'], ['zoom'], 6, -3, 12, -7], 'line-dasharray': [1, 1.5] } });
  const pt = isPoint;
  const proposed = ['==', ['get', 'status'], 'proposed'];
  const circlePaint = {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['case', proposed, 4.5, 2.5], 12, ['case', proposed, 9, 5.5]],
    'circle-color': ['case', proposed, devColor, '#0d1117'],
    'circle-stroke-color': ['case', proposed, '#ffffff', devColor],
    'circle-stroke-width': ['case', proposed, 2, 2],
  };
  // Dots only appear from about department zoom, so the country view stays clean.
  map.addLayer({ id: 'dev-points-minor', type: 'circle', source: 'dev', minzoom: 10, filter: ['all', pt, ['in', ['get', 'kind'], ['literal', MINOR_KINDS]]], paint: circlePaint });
  map.addLayer({ id: 'dev-points-main', type: 'circle', source: 'dev', minzoom: 8, filter: ['all', pt, ['!=', ['get', 'kind'], 'protectedLabel'], ['!', ['in', ['get', 'kind'], ['literal', MINOR_KINDS]]]], paint: circlePaint });
  map.addLayer({ id: 'dev-sel', type: 'circle', source: 'dev', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'dev-sel-line', type: 'line', source: 'dev', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ffffff', 'line-width': 1.4 } });
}

const DEV_LAYERS = ['dev-fill', 'dev-lines-solid', 'dev-lines-dashed', 'dev-points-minor', 'dev-points-main', 'dev-labels'];
const DEV_BASE = {};
function applyDevFilters() {
  if (!map.getSource('dev')) return;
  const themes = ['literal', [...state.devThemes]];
  const status = ['literal', [...state.devStatus]];
  for (const id of DEV_LAYERS) {
    if (!map.getLayer(id)) continue;
    DEV_BASE[id] ??= map.getFilter(id);
    map.setFilter(id, ['all', DEV_BASE[id], ['in', ['get', 'theme'], themes], ['in', ['get', 'status'], status]]);
  }
  const showProposed = state.devStatus.has('proposed');
  map.setLayoutProperty('backbone-power', 'visibility', state.devThemes.has('energy') && showProposed ? 'visible' : 'none');
  map.setLayoutProperty('backbone-fiber', 'visibility', state.devThemes.has('connectivity') && showProposed ? 'visible' : 'none');
  map.setLayoutProperty('pop-heat', 'visibility', state.pop ? 'visible' : 'none');
}

function togglePop() {
  state.pop = !state.pop;
  applyDevFilters();
  renderDevPanel();
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('#home').hidden = tab !== 'plan' || !$('#results').hidden || !!state.page;
  $('#devHome').hidden = tab !== 'dev' || !$('#results').hidden || !!state.page;
  syncPage();
  if (tab === 'dev' && !setTab.opened) {
    setTab.opened = true;
    if (!state.devThemes.size) ['energy', 'water', 'agri', 'housing', 'air'].forEach((k) => state.devThemes.add(k));
    applyDevFilters();
  }
  renderDevPanel();
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
}

function renderDevPanel() {
  if (!dev) return;
  const counts = {};
  for (const f of dev.features) {
    const p = f.properties;
    if (p.kind === 'protectedLabel') continue;
    counts[p.theme] ??= { existing: 0, proposed: 0 };
    counts[p.theme][p.status]++;
  }
  counts.energy.proposed += 1; // the power backbone
  counts.connectivity.proposed += 1; // the fibre backbone
  $('#allThemes').textContent = t(state.devThemes.size ? 'layers.allOff' : 'layers.allOn');
  $('#devCountKey').innerHTML = t('dev.countKey');
  $('#popToggle').classList.toggle('off', !state.pop);
  $('#popToggle').setAttribute('aria-checked', String(state.pop));
  document.querySelectorAll('.status-chips .chip').forEach((c) => c.classList.toggle('on', state.devStatus.has(c.dataset.status)));
  $('#devThemes').innerHTML = Object.entries(DEV_THEMES).map(([k, color]) => {
    const [name, hint] = t(`theme.${k}`);
    const on = state.devThemes.has(k);
    const c = counts[k] ?? { existing: 0, proposed: 0 };
    return `<li class="layer ${on ? '' : 'off'}" data-k="${k}" role="switch" tabindex="0" aria-checked="${on}">
      <span class="swatch theme-ico" style="--c:${color}">${ico(THEME_ICON[k])}</span>
      <span class="layer-name">${esc(name)}<small>${esc(hint)}</small></span>
      <span class="layer-meta">${c.existing ? `${fmtPeople(c.existing)} · ` : ''}${c.proposed ? `<b style="color:${color}">${c.proposed}</b>` : ''}</span>
      <span class="switch"></span></li>`;
  }).join('');
  $('#devThemes').querySelectorAll('.layer').forEach((li) => {
    const toggle = () => {
      const k = li.dataset.k;
      state.devThemes.has(k) ? state.devThemes.delete(k) : state.devThemes.add(k);
      applyDevFilters();
      renderDevPanel();
    };
    li.onclick = toggle;
    li.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle());
  });
  $('#methodBody').innerHTML = Object.keys(DEV_THEMES).map((k) => `<p><b>${esc(t(`theme.${k}`)[0])}.</b> ${esc(t(`method.${k}`))}</p>`).join('');
}

function devName(p) {
  if (p.status === 'proposed') return p.place ? `${t(`kind.${p.kind}`)} · ${p.place}` : t(`kind.${p.kind}`);
  return p.name ?? t(`kind.${p.kind}`);
}

function devItemHTML(f) {
  const p = f.properties;
  const sub = [t(p.status === 'proposed' ? 'dev.proposed' : 'dev.existing'), t(`theme.${p.theme}`)[0], p.dept].filter(Boolean).join(' · ');
  return `<li><button class="item" data-id="${p.id}" style="--c:${DEV_THEMES[p.theme]}">
      <span class="ico-c">${ico(THEME_ICON[p.theme])}</span>
      <span class="t"><b>${esc(devName(p))}</b><small>${esc(sub)}</small></span>
      <span class="k"></span></button></li>`;
}

function devWhy(p) {
  if (p.status === 'existing') {
    if (p.approx) return t('dev.approx');
    if (p.kind === 'fault') return t('why.fault', { slip: p.slip ?? '—' });
    return t('dev.mapped', { src: t(`src.${p.src}`) });
  }
  const v = {
    ...p,
    serves: fmtPeople(p.serves), people: fmtPeople(p.people), load: fmtPeople(p.load),
    km: p.km?.toLocaleString(locale()), km2: p.km2?.toLocaleString(locale()), rail: p.rail?.toLocaleString(locale()),
    river: '', coast: '', landing: '',
    fault: p.fault ?? t('kind.fault').toLowerCase(),
    ring: p.ring ?? '',
  };
  if (p.kind === 'waterPlant' && p.river && p.river !== 'canal') v.river = t('why.waterRiver', { river: p.river });
  if (p.kind === 'sewagePlant' && p.coast) v.coast = t('why.sewageCoast');
  if (p.kind === 'techHub' && p.landing) v.landing = t('why.techLanding', { landing: p.landing });
  if (p.kind === 'borderZone' && !p.corridor) return t('why.borderMarket', v);
  if (p.kind === 'airportUpgrade') {
    const w = { ...v, runway: p.runway?.toLocaleString(locale()), current: p.current?.toLocaleString(locale()) ?? '—', field: p.field };
    if (p.island) return t('why.airportIsland', w);
    if (p.strategic) return t('why.airportStrategic', w);
    return t('why.airportUpgrade', { ...w, capital: p.capital ?? p.place });
  }
  if (['airportNew', 'airportHub'].includes(p.kind)) v.runway = p.runway?.toLocaleString(locale());
  if (p.kind === 'airportNew' && p.capital) return t('why.airportCapital', v);
  if (p.kind === 'runway') return t('why.runway', { ...v, runway: p.runway?.toLocaleString(locale()) });
  return t(`why.${p.kind}`, v);
}

function devFacts(p) {
  const km = (v) => (v == null ? '—' : `${v.toLocaleString(locale())} km`);
  const m = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString(locale())} m`);
  const F = {
    solar: [['≈50 MW', 'fact.capacity'], [km(p.rail), 'fact.toCorridor'], [fmtPeople(p.load), 'fact.people']],
    wind: [[m(p.elev), 'fact.elevation']],
    hydro: [[m(p.head), 'fact.drop'], [km(p.riverKm), 'fact.river']],
    microgrid: [[fmtPeople(p.people), 'fact.people']],
    waterPlant: [[fmtPeople(p.serves), 'fact.serves'], [m(p.head), 'fact.head'], [km(p.km), 'fact.distance']],
    sewagePlant: [[fmtPeople(p.serves), 'fact.serves'], [m(p.drop), 'fact.drop'], [km(p.km), 'fact.distance']],
    agriZone: [[`${p.km2} km²`, 'fact.area'], [fmtPeople(p.people), 'fact.people']],
    agriHub: [[`${p.km2} km²`, 'fact.area'], [km(p.rail), 'fact.toCorridor']],
    tod: [[`${p.km2} km²`, 'fact.area'], [fmtPeople(p.people), 'fact.people']],
    newTown: [[`${p.km2} km²`, 'fact.area'], [km(p.km), 'fact.distance'], [km(p.rail), 'fact.toCorridor']],
    techHub: [[fmtPeople(p.people), 'fact.people']],
    ruralHub: [[km(p.km), 'fact.fromFibre'], [fmtPeople(p.people), 'fact.people']],
    healthGap: [[fmtPeople(p.people), 'fact.people'], [km(p.km), 'fact.toHospital']],
    faultCross: [[p.fault ?? '—', 'fact.fault']],
    floodZone: [[fmtPeople(p.people), 'fact.people'], [`${p.km2} km²`, 'fact.area']],
    borderZone: p.people ? [[fmtPeople(p.people), 'fact.people']] : [],
    defenceBase: [[km(p.km), 'fact.distance'], [km(p.rail), 'fact.toCorridor']],
    researchAgri: [[`${p.km2} km²`, 'fact.area']],
    seismicStation: [[p.fault ?? '—', 'fact.fault']],
    mineralBelt: [[`${p.km2} km²`, 'fact.area']],
    forestZone: [[`${p.km2} km²`, 'fact.area']],
    plant: [[p.source ?? '—', 'fact.type'], ...(p.mw ? [[`${p.mw} MW`, 'fact.capacity']] : [])],
    airportIntl: [[p.runway ? m(p.runway) : '—', 'fact.runway'], [t(`surf.${p.surface}`) === `surf.${p.surface}` ? p.surface ?? '—' : t(`surf.${p.surface}`), 'fact.surface'], ...(p.iata ? [[p.iata, 'fact.iata']] : [])],
    airfield: [[p.runway ? m(p.runway) : '—', 'fact.runway'], [p.surface ? (t(`surf.${p.surface}`) === `surf.${p.surface}` ? p.surface : t(`surf.${p.surface}`)) : '—', 'fact.surface'], ...(p.iata ? [[p.iata, 'fact.iata']] : [])],
    // Island strips: people within 15 km would count the mainland across the channel, so no count there.
    airportUpgrade: [[m(p.runway), 'fact.runwayPlan'], [p.current ? m(p.current) : '—', 'fact.runwayNow'], ...(p.island ? [] : [[fmtPeople(p.people), 'fact.people15']])],
    airportHub: [[m(p.runway), 'fact.runwayPlan'], [fmtPeople(p.people), 'fact.people60'], [km(p.rail), 'fact.toCorridor']],
    airportNew: [[m(p.runway), 'fact.runwayPlan'], [fmtPeople(p.people), 'fact.peopleGain'], [km(p.rail), 'fact.toCorridor']],
    runway: [[m(p.runway), 'fact.runwayPlan']],
  }[p.kind] ?? [];
  const facts = F.map(([v, k]) => [v, t(k)]);
  if (facts.length < 3 && p.dept) facts.push([p.dept, t('fact.dept')]);
  return facts.slice(0, 3);
}

function clearDevSelection() {
  for (const l of ['haz-sel-line', 'haz-sel-pt']) map.getLayer(l) && map.setFilter(l, ['==', ['get', 'id'], '']);
  if (!map.getLayer('dev-sel')) return;
  map.setFilter('dev-sel', ['==', ['get', 'id'], '']);
  map.setFilter('dev-sel-line', ['==', ['get', 'id'], '']);
}

function selectDev(id, { move = true } = {}) {
  if (tour) endTour();
  const f = devById.get(id);
  stopFly();
  clearSelection();
  state.selected = id;
  const p = f.properties;
  // Make sure the chosen feature is visible.
  if (!state.devThemes.has(p.theme) || !state.devStatus.has(p.status)) {
    state.devThemes.add(p.theme);
    state.devStatus.add(p.status);
    applyDevFilters();
    renderDevPanel();
  }
  const isPt = f.geometry.type === 'Point';
  map.setFilter('dev-sel', isPt ? ['==', ['get', 'id'], id] : ['==', ['get', 'id'], '']);
  map.setFilter('dev-sel-line', isPt ? ['==', ['get', 'id'], ''] : ['==', ['get', 'id'], id]);
  setHashParam('f', id);
  if (state.collapsed) setCollapsed(false);
  $('#search').value = '';
  $('#results').hidden = true;
  setTab(state.tab);
  renderDevDetail(f);
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
  openedPage();
  if (move) requestAnimationFrame(() => fitFeature(f, isPt ? { zoom: Math.max(map.getZoom(), 11) } : {}));
}

function renderDevDetail(f) {
  const p = f.properties;
  const color = DEV_THEMES[p.theme];
  const g = f.geometry;
  const c = g.type === 'Point' ? g.coordinates : [(f._bbox[0] + f._bbox[2]) / 2, (f._bbox[1] + f._bbox[3]) / 2];
  const gm = `https://www.google.com/maps/search/?api=1&query=${c[1].toFixed(5)},${c[0].toFixed(5)}`;
  const facts = devFacts(p);
  const el = $('#detail');
  el.innerHTML = `
    <div class="detail-top">${backBtn()}<span class="pill" style="--c:${color}">${ico(THEME_ICON[p.theme])}${esc(t(`kind.${p.kind}`))}</span></div>
    <h2>${esc(devName(p))}</h2>
    <div class="badges">
      <span class="badge ${p.status}">${t(p.status === 'proposed' ? 'dev.proposed' : 'dev.existing')}</span>
      <span class="badge">${esc(t(`theme.${p.theme}`)[0])}</span>
    </div>
    <p class="note">${esc(devWhy(p))}</p>
    ${facts.length ? `<div class="facts">${facts.map(([v, k]) => factHTML(v, esc(k), k === t('fact.dept') && v === p.dept ? 'dept' : null, '', k === t('fact.dept') ? 'mapf' : null)).join('')}</div>` : '<div style="height:12px"></div>'}
    <div class="actions">
      <button class="btn" id="btnZoom">${ICONS.zoom} ${t('btn.zoom')}</button>
      <a class="btn" href="${gm}" target="_blank" rel="noopener">${ICONS.map} ${t('btn.gmaps')}</a>
      <button class="btn" id="btnShareF">${ICONS.share} ${t('btn.share')}</button>
    </div>
    ${p.status === 'proposed' ? `<p class="source">${esc(t('dev.screening'))}</p>` : ''}
    <p class="source">${esc(t('dev.source', { src: p.status === 'proposed' ? t('src.rules') : t(`src.${p.src}`) }))}</p>`;
  el.hidden = false;
  el.querySelector('#detailClose').onclick = closeSelection;
  el.querySelector('#btnZoom').onclick = () => fitFeature(f, g.type === 'Point' ? { zoom: 13 } : { whole: true });
  el.querySelector('#btnShareF').onclick = () => share(devName(p));
  wireActs(el, f);
}

// ---------------------------------------------------------------------------
// Engineering & cost card for routes; "at a glance" card for cities
// ---------------------------------------------------------------------------
// Indicative unit costs in US$ million per km by section type, and design assumptions per kind of route.
// Order-of-magnitude figures from typical international costs; not a budget.
const ENG = {
  rail: { spec: 'spec.rail', grade: 0.025, cost: { surface: 14, viaduct: 45, tunnel: 90 }, car: 90, train: 130, tunnels: true },
  ringNat: { spec: 'spec.ringNat', grade: 0.05, cost: { surface: 10, viaduct: 35, tunnel: 70 }, car: 70, tunnels: true },
  ringLocal: { spec: 'spec.ringLocal', grade: 0.07, cost: { surface: 3, viaduct: 15, mountain: 6 }, car: 50 },
  urban: { spec: 'spec.urban', grade: 0.07, cost: { surface: 6, viaduct: 25, mountain: 10 }, car: 30 },
  feeder: { spec: 'spec.feeder', grade: 0.08, cost: { surface: 1.5, viaduct: 12, mountain: 3.5 }, car: 50 },
  bridge: { spec: 'spec.bridge', grade: 0.05, cost: { surface: 3, viaduct: 40 }, car: 60 },
  ferry: { spec: 'spec.ferry' },
};
const ENG_COLORS = { surface: '#34D399', viaduct: '#7DD3FC', tunnel: '#F5A524', mountain: '#FB7185' };
function engKind(p) {
  if (p.mode === RAIL_MODE) return 'rail';
  if (p.category === 'ring') return p.tier === 'local' ? 'ringLocal' : 'ringNat';
  return ENG[p.category] ? p.category : null;
}
const fmtB = (v) => (v / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 });
const fmtRange = (a, b) => (a >= 1000 ? `$${fmtB(a)}–${fmtB(b)} B` : b >= 1000 ? `$${Math.round(a)} M–${fmtB(b)} B` : `$${Math.round(a)}–${Math.round(b)} M`);
const fmtMoney = (m) => (m >= 1000 ? `$${(m / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })} B` : `$${Math.round(m).toLocaleString(locale())} M`);
const fmtMin = (h) => (h >= 1 ? `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}` : `${Math.max(1, Math.round(h * 60))} min`);

function engineeringHTML(f, s, sm) {
  const p = f.properties;
  const k = engKind(p);
  if (!k) return '';
  const e = ENG[k];
  const km = p.km ?? 0;
  const parts = {};
  if (k === 'ferry') {
    // Two drive-on terminals plus vessels.
    return `<div class="eng">
      <div class="profile-head"><h3>${t('eng.title')}</h3></div>
      <p class="eng-spec">${esc(t(e.spec))}</p>
      <div class="eng-tiles"><div class="cost tap info" data-act="ferry" role="button" tabindex="0"><b>${fmtRange(25, 45)}</b><span>${ico('coin')}${t('eng.cost')}</span></div><div class="tap info" data-act="ferry" role="button" tabindex="0"><b>${fmtMin(km / 30 + 0.5)}</b><span>${ico('ship')}${t('eng.crossing')}</span></div></div>
      <p class="source">${t('eng.costNote')}</p></div>`;
  }
  // A grade-limited track line through the terrain: where the ground is far above it → tunnel (or a
  // mountain section for ordinary roads); far below it or under water → viaduct / bridge; else at grade.
  const n = sm.length;
  const types = [];
  const dx = n > 1 ? (s[1].d - s[0].d) * 1000 : 1000;
  const g = e.grade * dx;
  // Start from the terrain averaged over a few km (a line follows the land's broad shape), then
  // limit its grade in both directions so it stays close to the ground.
  const win = Math.max(1, Math.round((e.tunnels ? 1500 : 400) / dx));
  const avg = sm.map((_, i) => {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) (sum += sm[j]), c++;
    return sum / c;
  });
  const F = avg.slice(), Bk = avg.slice();
  for (let i = 1; i < n; i++) F[i] = clamp(avg[i], F[i - 1] - g, F[i - 1] + g);
  for (let i = n - 2; i >= 0; i--) Bk[i] = clamp(avg[i], Bk[i + 1] - g, Bk[i + 1] + g);
  for (let i = 0; i < n; i++) {
    const diff = sm[i] - (F[i] + Bk[i]) / 2;
    // Embankments up to 25 m and cuttings up to 40 m count as at-grade construction.
    const type = s[i].e <= 0 || diff < -25 ? 'viaduct' : diff > 40 ? (e.tunnels ? 'tunnel' : 'mountain') : 'surface';
    parts[type] = (parts[type] ?? 0) + 1;
    types.push(type);
  }
  // Where each kind of section lies, as map lines (tap a legend entry to see them).
  const runs = {};
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && types[j + 1] === types[i]) j++;
    (runs[types[i]] ??= []).push(s.slice(Math.max(0, i - 1), Math.min(n, j + 2)).map((v) => v.p));
    i = j + 1;
  }
  f._secs = runs;
  // Shares of the sampled points, applied to the route's measured length.
  for (const key of Object.keys(parts)) parts[key] = (parts[key] / n) * km;
  // Use the precomputed construction mix (tools/build-numbers.mjs) when there is one, so this card, the lists
  // and Plan in numbers all show the same cost. The live profile still places the sections on the map.
  const pre = numbers?.routes[p.id];
  if (pre) {
    for (const key of Object.keys(parts)) delete parts[key];
    Object.assign(parts, pre);
  }
  const mid = Object.entries(parts).reduce((sum, [key, len]) => sum + len * (e.cost[key] ?? e.cost.surface), 0);
  const order = ['surface', 'mountain', 'viaduct', 'tunnel'].filter((key) => parts[key] > 0.05);
  f._eng = { kind: k, parts, mid, order };
  const tile = (b, label) => `<div class="tap info" data-act="speed" role="button" tabindex="0"><b>${b}</b><span>${label}</span></div>`;
  const times = [tile(fmtMin(km / e.car), ico('car') + t('eng.car'))];
  if (e.train) times.push(tile(fmtMin(km / e.train), ico('train') + t('eng.train')));
  return `<div class="eng">
    <div class="profile-head"><h3>${t('eng.title')}</h3></div>
    <p class="eng-spec">${esc(t(e.spec))}</p>
    <div class="bar">${order.map((key) => `<span style="--c:${ENG_COLORS[key]};width:${(parts[key] / km) * 100}%" title="${t(`eng.${key}`)}"></span>`).join('')}</div>
    <div class="legend-row legs" title="${esc(t('ex.sec'))}">${order.map((key) => `<button class="leg" data-act="sec" data-k="${key}" style="--c:${ENG_COLORS[key]}">${ico(ENG_ICON[key])}${t(`eng.${key}`)} ${fmtKm(parts[key])}</button>`).join('')}</div>
    <div class="eng-tiles">
      <div class="cost tap info" data-act="cost" role="button" tabindex="0"><b>${fmtRange(mid * 0.7, mid * 1.5)}</b><span>${ico('coin')}${t('eng.cost')}</span></div>
      ${times.join('')}
    </div>
    <p class="source">${t('eng.costNote')}</p>
  </div>`;
}

function glanceHTML(f, conns) {
  const p = f.properties;
  const st = stats.places[p.id];
  const here = f.geometry.coordinates;
  let hosp = null, hospId = null;
  for (const h of dev?.features ?? []) {
    if (h.properties.kind !== 'hospital') continue;
    const d = haversine(here, h.geometry.coordinates);
    if (hosp == null || d < hosp) [hosp, hospId] = [d, h.properties.id];
  }
  const key = norm(p.name.replace(/\s*\(.*\)$/, '').split(/\s*[—\/·]\s*/)[0]);
  const planned = (dev?.features ?? []).filter((d) => d.properties.status === 'proposed' && d.geometry.type === 'Point' && d.properties.place && norm(d.properties.place).startsWith(key) && haversine(here, d.geometry.coordinates) < 20).slice(0, 8);
  return `<div class="glance">
    <div class="eng-tiles three">
      ${[['p5', 'city.p5'], ['p10', 'city.p10'], ['p25', 'city.p25']].map(([k, l]) => `<div class="tap info" data-act="people" role="button" tabindex="0"><b>${fmtPeople(st[k])}</b><span>${ico('people')}${t(l)}</span></div>`).join('')}
    </div>
    <div class="facts">
      ${factHTML(p.dept ?? '—', t('fact.dept'), p.dept ? 'dept' : null, '', 'mapf')}
      ${factHTML(conns.length, t('city.routes'), conns.length ? 'routes' : null, '', 'road')}
      ${factHTML(hosp == null ? '—' : fmtKm(hosp), t('city.hospital'), hospId ? 'hospital' : null, hospId ? `data-id="${hospId}"` : '', 'hospital')}
    </div>
    ${planned.length ? `<p class="sub-head">${t('city.planned')}</p><div class="depts compact planned">${planned.map((d) => `<button class="chip" data-id="${d.properties.id}" style="border-color:${DEV_THEMES[d.properties.theme]}">${esc(t(`kind.${d.properties.kind}`))}</button>`).join('')}</div>` : ''}
  </div>`;
}

// ===========================================================================
// Tappable details: explanations, highlights, shortcuts
// ===========================================================================
const EMPTY = { type: 'FeatureCollection', features: [] };

// A fact tile. act: what a tap does (info = explain, nav = open something, copy = copy the value).
function factHTML(v, label, act, extra = '', icon = null) {
  if (icon) label = `${ico(icon)}${label}`;
  const kind = { dept: 'nav', routes: 'nav', hospital: 'nav', copy: 'copy' }[act] ?? 'info';
  const attrs = act ? ` class="fact tap ${kind}" data-act="${act}" role="button" tabindex="0" ${extra}` : ' class="fact"';
  return `<div${attrs}><b title="${esc(v)}">${esc(v)}</b><span>${label}</span></div>`;
}

// Opens a short explanation right under the row of tiles or tags that was tapped; tapping again closes it.
function explainAt(x, key, html) {
  const host = x.closest('.facts, .badges, .eng-tiles, .legend-row') ?? x.parentElement;
  const next = host.nextElementSibling;
  host.querySelectorAll('.on').forEach((n) => n.classList.remove('on'));
  if (next?.classList.contains('explain')) {
    const same = next.dataset.k === key;
    next.remove();
    if (same) return;
  }
  host.insertAdjacentHTML('afterend', `<div class="explain" data-k="${key}">${html}</div>`);
  x.classList.add('on');
}

// The details card is re-filled for every item, so its listeners are attached once and read the current item.
function wireActs(el, f) {
  el._actItem = f;
  if (el._actWired) return;
  el._actWired = true;
  const run = (x) => onAct(x, el._actItem, el);
  el.addEventListener('click', (e) => {
    const x = e.target.closest('[data-act]');
    if (x && el.contains(x)) run(x);
  });
  el.addEventListener('keydown', (e) => {
    const x = e.target.closest?.('[data-act][role="button"]');
    if (x && (e.key === 'Enter' || e.key === ' ')) (e.preventDefault(), run(x));
  });
}

function onAct(x, f, el) {
  const p = f.properties;
  const act = x.dataset.act;
  const k = engKind(p);
  if (act === 'copy') {
    const v = x.querySelector('b').textContent;
    navigator.clipboard?.writeText(v).then(() => toast(t('toast.coords')), () => toast(v));
  } else if (act === 'dept') goDept(p.dept);
  else if (act === 'mode') explainAt(x, act, esc(t(ENG[k].spec)));
  else if (act === 'tier') explainAt(x, act, t(p.tier === 'local' ? 'ex.local' : 'ex.national'));
  else if (act === 'rail') explainAt(x, act, t('ex.rail'));
  else if (act === 'tunnel') {
    const has = !!f._secs?.tunnel;
    explainAt(x, act, `${t('ex.tunnel', { name: esc(tunnelName(p.tunnel)) })}${has ? ` ${t('ex.tunnelMap')}` : ''}`);
    if (has) showSec(x.classList.contains('on') ? 'tunnel' : null);
  } else if (act === 'sec') showSec(secShown === x.dataset.k ? null : x.dataset.k, true);
  else if (act === 'cost') explainAt(x, act, costHTML(f));
  else if (act === 'speed') explainAt(x, act, `${t('ex.speed', { car: ENG[k].car })}${ENG[k].train ? ` ${t('ex.speedTrain', { train: ENG[k].train })}` : ''}`);
  else if (act === 'ferry') explainAt(x, act, t('ex.ferry'));
  else if (act === 'people') explainAt(x, act, t('ex.people'));
  else if (act === 'routes') el.querySelector('.list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else if (act === 'hospital') select(x.dataset.id);
}

function costHTML(f) {
  const { kind, parts, mid, order } = f._eng;
  const c = ENG[kind].cost;
  const rows = order.map((key) => {
    const per = c[key] ?? c.surface;
    return `<tr><td><i style="--c:${ENG_COLORS[key]}"></i>${t(`eng.${key}`)}</td><td>${fmtKm(parts[key])}</td><td>× $${per} M/km</td><td>${fmtMoney(parts[key] * per)}</td></tr>`;
  }).join('');
  return `<table class="calc">${rows}<tr class="total"><td colspan="3">${t('ex.costTotal')}</td><td>${fmtMoney(mid)}</td></tr></table><p>${t('ex.costRange')}</p>`;
}

// Highlight layers: 'hl' for pages (lists, trips, the tour), 'sec' for one kind of construction on a route.
function addHighlightLayers() {
  map.addSource('hl', { type: 'geojson', data: EMPTY });
  map.addSource('sec', { type: 'geojson', data: EMPTY });
  const lineL = { type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' } };
  map.addSource('today', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'today-line', type: 'line', source: 'today', layout: { 'line-join': 'round' }, paint: { 'line-color': '#FCA5A5', 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [2, 1.6] } }, 'sel-glow');
  map.addLayer({ ...lineL, id: 'hl-glow', source: 'hl', filter: isLine, paint: { 'line-color': ['get', 'c'], 'line-width': widthPlus(12), 'line-blur': 7, 'line-opacity': 0.55 } }, 'sel-glow');
  map.addLayer({ ...lineL, id: 'hl-line', source: 'hl', filter: isLine, paint: { 'line-color': ['get', 'c'], 'line-width': widthPlus(2.5) } }, 'sel-glow');
  map.addLayer({ id: 'hl-point', type: 'circle', source: 'hl', filter: isPoint, paint: { 'circle-radius': 10, 'circle-color': ['get', 'c'], 'circle-opacity': 0.3, 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 2.5 } });
  map.addLayer({ ...lineL, id: 'sec-glow', source: 'sec', paint: { 'line-color': ['get', 'c'], 'line-width': 18, 'line-blur': 9, 'line-opacity': 0.7 } });
  map.addLayer({ ...lineL, id: 'sec-line', source: 'sec', paint: { 'line-color': ['get', 'c'], 'line-width': 6 } });
}
function setHL(feats = [], color) {
  map.getSource('hl')?.setData({ type: 'FeatureCollection', features: feats.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: { category: f.properties.category, c: color ?? f.properties.c ?? CATS[f.properties.category]?.color ?? '#ffffff' } })) });
}
function fitFeats(feats, opts = {}) {
  const b = bboxOf(feats.flatMap((f) => flatCoords(f.geometry)));
  if (!Number.isFinite(b[0])) return;
  fitView([[b[0], b[1]], [b[2], b[3]]], { padding: pad(), maxZoom: 12, pitch: state.terrain ? 30 : 0, bearing: 0, ...MOVE, ...opts });
}

let secShown = null;
function showSec(k, move = false) {
  secShown = k;
  const f = state.selected != null && byId?.get(state.selected);
  const runs = k && f?._secs?.[k];
  map.getSource('sec')?.setData(runs ? { type: 'FeatureCollection', features: runs.map((c) => ({ type: 'Feature', properties: { c: ENG_COLORS[k] }, geometry: { type: 'LineString', coordinates: c } })) } : EMPTY);
  document.querySelectorAll('#detail .leg').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  if (runs && move) fitFeats(runs.map((c) => ({ geometry: { type: 'LineString', coordinates: c } })), { maxZoom: 13 });
}

// ===========================================================================
// Smart zoom button
// ===========================================================================
function updateZoomToggle() {
  const b = $('#btnZoomT');
  if (!b) return;
  const zoomIn = map.getZoom() < ZOOM_SPLIT;
  b.innerHTML = zoomIn ? ICONS.zoom : ICONS.zoomOut;
  b.title = t(zoomIn ? 'ctl.zoomIn' : 'ctl.zoomOut');
  b.setAttribute('aria-label', b.title);
}
function zoomToggle() {
  stopFly();
  if (map.getZoom() < ZOOM_SPLIT) {
    const f = state.selected != null && (byId?.get(state.selected) ?? devById.get(state.selected));
    const center = f ? (f.geometry.type === 'Point' ? f.geometry.coordinates : nearestPointOn(flatCoords(f.geometry), [map.getCenter().lng, map.getCenter().lat])) : map.getCenter();
    map.flyTo({ center, zoom: clamp(map.getZoom() + 2.5, 9.5, 12), pitch: state.terrain ? 45 : 0, padding: pad(), ...MOVE });
  } else {
    fitView(HAITI_BOUNDS, { padding: pad(), pitch: state.terrain ? 38 : 0, bearing: 0, ...MOVE });
  }
}

// ===========================================================================
// Pages in the panel: lists, trip planner, plan in numbers. Each has its own Back step.
// ===========================================================================
let numbers = null;
getJSON('data/numbers.json').then((d) => {
  numbers = d;
  if (state.page === 'numbers') renderPage('numbers', { move: false, keep: true });
}).catch(() => {});

function openPage(name) {
  stopFly();
  if (tour) endTour();
  hideHintIfShown();
  if (state.selected != null) {
    closeSelection.saved = null;
    clearSelection();
  }
  const hs = history.state ?? {};
  if (hs.page === name && !hs.sel) return renderPage(name);
  // A page opened from an item replaces it in the history; otherwise it is a new step.
  if (hs.sel) history.replaceState({ page: name }, '', location.href);
  else history.pushState({ page: name }, '', location.href);
  renderPage(name);
}
function closePage() {
  if (history.state?.page) history.back();
  else renderPage(null);
}
// Close whatever is open (item and/or page) and then run fn on the home view.
function leaveToHome(fn) {
  closeSelection.saved = null;
  renderPage.saved = null;
  const hs = history.state ?? {};
  if (hs.sel || hs.page) {
    leaveToHome.fn = fn;
    history.back();
  } else {
    clearSelection();
    renderPage(null);
    fn();
  }
}
function goDept(name) {
  leaveToHome(() => {
    if (state.tab !== 'plan') setTab('plan');
    setDept(name);
  });
}

function syncPage() {
  const box = $('#page');
  if (!box) return;
  box.hidden = !state.page || state.selected != null || !$('#results').hidden;
  setFocus();
}

function renderPage(name, { move = true, keep = false } = {}) {
  const box = $('#page');
  if (!state.page && name) renderPage.saved = saveView();
  state.page = name;
  setHL([]);
  setToday(null);
  if (!name) {
    box.innerHTML = '';
    if (renderPage.saved) map.flyTo({ ...MOVE, ...renderPage.saved });
    renderPage.saved = null;
    setTab(state.tab);
    return;
  }
  const i = name.indexOf(':');
  const type = i < 0 ? name : name.slice(0, i);
  const key = i < 0 ? '' : name.slice(i + 1);
  const page = PAGES[type];
  box.innerHTML = `<div class="detail-top page-top">${backBtn('pageBack')}</div>${page.html(key)}`;
  box.querySelector('#pageBack').onclick = closePage;
  if (state.collapsed) setCollapsed(false);
  setTab(state.tab);
  page.wire?.(box, key, move);
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
  if (!keep) $('#panelBody').scrollTop = 0;
}

// The same Back button everywhere: item cards, pages and departments.
const backBtn = (id = 'detailClose') => `<button class="back-btn" id="${id}">${ICONS.back}<span>${t('btn.back')}</span></button>`;

// ---------- Lists ----------
const ISLAND_RX = /vache|cayemite|tortue|gonave/;
function collSet(key) {
  const [k, dept] = key.split('@');
  const cat = (f) => f.properties.category;
  let feats;
  if (k === 'trunks') feats = plan.features.filter((f) => ['corridor', 'trunk'].includes(cat(f)));
  else if (k === 'rings') feats = plan.features.filter((f) => cat(f) === 'ring');
  else if (k === 'stations') feats = plan.features.filter((f) => cat(f) === 'station');
  else if (k === 'islands') feats = plan.features.filter((f) => ['bridge', 'ferry', 'terminal'].includes(cat(f)) || (cat(f) === 'corridor' && ISLAND_RX.test(norm(`${f.properties.name} ${f.properties.original}`))));
  else feats = plan.features.filter((f) => cat(f) === k.replace(/^cat-/, ''));
  if (dept) feats = feats.filter((f) => f.properties.dept === dept);
  return feats.sort((a, b) => (a.properties.tier === 'local') - (b.properties.tier === 'local') || a.properties.sort - b.properties.sort || (b.properties.km ?? 0) - (a.properties.km ?? 0));
}
function collText(key) {
  const [k, dept] = key.split('@');
  const named = ['trunks', 'rings', 'stations', 'islands'].includes(k);
  const c = k.replace(/^cat-/, '');
  const title = named ? t(`coll.${k}`) : catLabel(c);
  return { title: dept ? `${title} · ${dept}` : title, note: named ? t(`coll.${k}.note`) : catHint(c) };
}
const PAGES = {
  coll: {
    html(key) {
      const feats = collSet(key);
      const { title, note } = collText(key);
      const km = feats.reduce((s, f) => s + (f.geometry.type === 'LineString' ? f.properties.km ?? 0 : 0), 0);
      return `<h2>${esc(title)}</h2>
        <p class="sub">${t('coll.count', { n: feats.length })}${km ? ` · ${fmtKm(km)}` : ''}</p>
        ${note ? `<p class="note">${esc(note)}</p>` : ''}
        <ul class="list" style="margin-top:14px">${feats.map((f) => itemHTML(f)).join('')}</ul>`;
    },
    wire(box, key, move) {
      const feats = collSet(key);
      setHL(feats);
      if (move) fitFeats(feats);
      box.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(itemId(b.dataset.id))));
    },
  },
  numbers: { html: numbersHTML, wire: wireNumbers },
  trip: { html: tripHTML, wire: wireTrip },
};

// ---------- Plan in numbers ----------
function routeMid(f) {
  const p = f.properties;
  const k = engKind(p);
  if (!k) return 0;
  if (k === 'ferry') return 35;
  const c = ENG[k].cost;
  const parts = numbers?.routes[p.id] ?? { surface: p.km ?? 0 };
  return Object.entries(parts).reduce((s, [key, len]) => s + len * (c[key] ?? c.surface), 0);
}
const numSort = { key: 'people', dir: -1 };
function numbersHTML() {
  if (!numbers) return `<h2>${t('num.title')}</h2><p class="note">${t('num.loading')}</p>`;
  const lines = plan.features.filter((f) => f.geometry.type === 'LineString' && ROAD_CATS.includes(f.properties.category));
  let mid = 0;
  const sec = { surface: 0, mountain: 0, viaduct: 0, tunnel: 0 };
  for (const f of lines) {
    mid += routeMid(f);
    for (const [k, v] of Object.entries(numbers.routes[f.properties.id] ?? {})) sec[k] += v;
  }
  const natKm = lines.filter((f) => f.properties.tier === 'national').reduce((s, f) => s + f.properties.km, 0);
  const localKm = lines.filter((f) => f.properties.tier === 'local').reduce((s, f) => s + f.properties.km, 0);
  const secTot = Object.values(sec).reduce((a, b) => a + b, 0) || 1;
  const order = ['surface', 'mountain', 'viaduct', 'tunnel'].filter((k) => sec[k] > 0.5);
  const tot = catTotals(plan.features);
  const cv = numbers.cover.total;
  const pct = (a, b) => `${Math.round((100 * a) / (b || 1))}%`;
  // Department table
  const names = depts.features.map((f) => f.properties.name);
  const rows = names.map((name) => {
    const feats = lines.filter((f) => f.properties.dept === name);
    const c = numbers.cover[name] ?? {};
    return { name, people: stats.depts[name] ?? c.people ?? 0, km: feats.reduce((s, f) => s + f.properties.km, 0), cost: feats.reduce((s, f) => s + routeMid(f), 0), st: c.people ? c.st5 / c.people : 0 };
  });
  rows.sort((a, b) => (numSort.key === 'name' ? a.name.localeCompare(b.name) * -numSort.dir : (a[numSort.key] - b[numSort.key]) * numSort.dir));
  const between = lines.filter((f) => !f.properties.dept).reduce((s, f) => s + routeMid(f), 0);
  const col = (key, label) => `<th><button data-sort="${key}" class="${numSort.key === key ? 'on' : ''}">${label}${numSort.key === key ? (numSort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`;
  return `<h2>${t('num.title')}</h2>
    <p class="sub">${t('num.sub')}</p>
    <div class="eng" style="margin-top:14px">
      <div class="eng-tiles">
        <div class="cost"><b>${fmtRange(mid * 0.7, mid * 1.5)}</b><span>${ico('coin')}${t('num.cost')}</span></div>
        <div><b>${fmtKm(natKm)}</b><span>${ico('train')}${t('num.nat')}</span></div>
        <div><b>${fmtKm(localKm)}</b><span>${ico('road')}${t('num.local')}</span></div>
      </div>
      <p class="sub-head" style="margin-top:12px">${t('num.build')}</p>
      <div class="bar">${order.map((k) => `<span style="--c:${ENG_COLORS[k]};width:${(sec[k] / secTot) * 100}%"></span>`).join('')}</div>
      <div class="legend-row">${order.map((k) => `<span style="--c:${ENG_COLORS[k]}"><i></i>${t(`eng.${k}`)} ${fmtKm(sec[k])}</span>`).join('')}</div>
      <p class="source" style="margin:0">${t('eng.costNote')}</p>
    </div>
    <p class="sub-head">${t('num.people')}</p>
    <div class="eng-tiles two">
      <div><b>${pct(cv.road10, cv.people)}</b><span>${ico('people')}${t('num.road10')}</span></div>
      <div><b>${pct(cv.st5, cv.people)}</b><span>${ico('station')}${t('num.st5')}</span></div>
    </div>
    <p class="sub-head" style="margin-top:16px">${t('num.byType')}</p>
    <ul class="list">${ROAD_CATS.map((k) => `<li><button class="item" data-coll="cat-${k}" style="--c:${CATS[k].color}"><span class="ico-c">${ico(CAT_ICON[k])}</span><span class="t"><b>${catLabel(k)}</b><small>${esc(catHint(k))}</small></span><span class="k">${tot[k].count} · ${fmtKm(tot[k].km)}</span></button></li>`).join('')}</ul>
    <p class="sub-head" style="margin-top:16px">${t('num.depts')}</p>
    <p class="source" style="margin:0 0 6px">${t('num.deptHint')}</p>
    <div class="table-wrap"><table class="dept-table">
      <thead><tr>${col('name', t('num.col.dept'))}${col('people', t('num.col.people'))}${col('km', t('num.col.km'))}${col('cost', t('num.col.cost'))}${col('st', t('num.col.st'))}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-dept="${esc(r.name)}" tabindex="0"><td>${esc(r.name)}</td><td>${fmtPeople(r.people)}</td><td>${fmtKm(r.km)}</td><td>${fmtMoney(r.cost)}</td><td>${Math.round(r.st * 100)}%</td></tr>`).join('')}
      <tr class="muted"><td>${t('num.between')}</td><td></td><td></td><td>${fmtMoney(between)}</td><td></td></tr></tbody>
    </table></div>`;
}
function wireNumbers(box, key, move) {
  if (move) fitView(HAITI_BOUNDS, { padding: pad(), pitch: state.terrain ? 30 : 0, bearing: 0, ...MOVE });
  box.querySelectorAll('[data-coll]').forEach((b) => (b.onclick = () => openPage(`coll:${b.dataset.coll}`)));
  box.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.sort;
    numSort.dir = numSort.key === k ? -numSort.dir : k === 'name' ? 1 : -1;
    numSort.key = k;
    renderPage('numbers', { move: false, keep: true });
  }));
  box.querySelectorAll('tr[data-dept]').forEach((r) => {
    r.onclick = () => goDept(r.dataset.dept);
    r.onkeydown = (e) => e.key === 'Enter' && goDept(r.dataset.dept);
  });
}

// ---------- Trip planner ----------
const TRIP_ROADS = ['corridor', 'trunk', 'bridge', 'ferry', 'ring', 'urban', 'feeder'];
const placeKey = (name) => norm(name.replace(/\s*\(.*\)$/, ''));
let placesCache = null;
function tripPlaces() {
  if (placesCache) return placesCache;
  const seen = new Map();
  for (const f of plan.features) {
    if (!['city', 'town'].includes(f.properties.category)) continue;
    const k = placeKey(f.properties.name);
    if (!seen.has(k) || f.properties.category === 'city') seen.set(k, f);
  }
  placesCache = [...seen.values()].sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  return placesCache;
}
function canonicalPlace(id) {
  const f = byId.get(id);
  return tripPlaces().find((g) => placeKey(g.properties.name) === placeKey(f.properties.name))?.properties.id ?? id;
}
// Nearest point on a line, with its distance along the line (km).
function projectOn(f, p) {
  const c = f.geometry.coordinates, cum = f._cum;
  const sx = 111.32 * Math.cos(rad(p[1])), sy = 110.57;
  let best = { dist: Infinity };
  for (let i = 1; i < c.length; i++) {
    const ax = (c[i - 1][0] - p[0]) * sx, ay = (c[i - 1][1] - p[1]) * sy;
    const bx = (c[i][0] - p[0]) * sx, by = (c[i][1] - p[1]) * sy;
    const dx = bx - ax, dy = by - ay;
    const u = clamp(-(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-12), 0, 1);
    const dist = Math.hypot(ax + u * dx, ay + u * dy);
    if (dist < best.dist) best = { dist, d: cum[i - 1] + u * (cum[i] - cum[i - 1]), pt: [c[i - 1][0] + u * (c[i][0] - c[i - 1][0]), c[i - 1][1] + u * (c[i][1] - c[i - 1][1])] };
  }
  return best;
}
const tripSpeed = (p) => (p.category === 'ferry' ? 30 : ENG[engKind(p)]?.car ?? 50);

// Road graph of the planned network. Lines are cut wherever another line ends on them and where a town
// sits next to them; nodes closer than ~1 km merge.
let graph = null;
function buildGraph() {
  const lines = plan.features.filter((f) => f.geometry.type === 'LineString' && TRIP_ROADS.includes(f.properties.category));
  const nodes = [];
  const cells = new Map();
  const TOL = 0.9;
  const nodeAt = (pt) => {
    const cx = Math.floor(pt[0] / 0.01), cy = Math.floor(pt[1] / 0.01);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const n of cells.get(`${cx + i},${cy + j}`) ?? []) if (haversine(nodes[n].pt, pt) < TOL) return n;
    nodes.push({ pt, edges: [] });
    const key = `${cx},${cy}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(nodes.length - 1);
    return nodes.length - 1;
  };
  const near = (f, p, padDeg) => p[0] > f._bbox[0] - padDeg && p[0] < f._bbox[2] + padDeg && p[1] > f._bbox[1] - padDeg && p[1] < f._bbox[3] + padDeg;
  const cuts = new Map(lines.map((f) => [f, [{ d: 0, pt: f.geometry.coordinates[0] }, { d: f._cum.at(-1), pt: f.geometry.coordinates.at(-1) }]]));
  const ends = lines.flatMap((f) => [f.geometry.coordinates[0], f.geometry.coordinates.at(-1)]);
  for (const f of lines) {
    const total = f._cum.at(-1);
    for (const e of ends) {
      if (!near(f, e, 0.02)) continue;
      const r = projectOn(f, e);
      if (r.dist < TOL && r.d > 0.3 && r.d < total - 0.3) cuts.get(f).push({ d: r.d, pt: e });
    }
  }
  const placeAt = new Map();
  for (const pl of tripPlaces()) {
    const pt = pl.geometry.coordinates;
    let best = null;
    for (const f of lines) {
      if (!near(f, pt, 0.06)) continue;
      const r = projectOn(f, pt);
      // Prefer a national route when one passes close by, so trips start on the main network.
      r.score = r.dist + (f.properties.tier === 'local' ? 1.5 : 0);
      if (!best || r.score < best.r.score) best = { f, r };
    }
    if (best && best.r.dist < 5) cuts.get(best.f).push({ d: best.r.d, pt: best.r.pt, place: pl.properties.id, access: best.r.dist });
  }
  for (const f of lines) {
    const list = cuts.get(f).sort((a, b) => a.d - b.d);
    const ids = list.map((c) => nodeAt(c.pt));
    list.forEach((c, i) => c.place != null && placeAt.set(c.place, { node: ids[i], access: c.access }));
    for (let i = 1; i < list.length; i++) {
      if (ids[i] === ids[i - 1]) continue;
      const km = list[i].d - list[i - 1].d;
      const e = { a: ids[i - 1], b: ids[i], f, d0: list[i - 1].d, d1: list[i].d, km, hrs: km / tripSpeed(f.properties) + (f.properties.category === 'ferry' ? 0.5 : 0) };
      nodes[e.a].edges.push(e);
      nodes[e.b].edges.push(e);
    }
  }
  return { nodes, placeAt };
}
function findTrip(fromId, toId) {
  graph ??= buildGraph();
  const A = graph.placeAt.get(fromId), B = graph.placeAt.get(toId);
  if (!A || !B) return null;
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Array(n).fill(null);
  const done = new Uint8Array(n);
  dist[A.node] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === B.node) break;
    done[u] = 1;
    for (const e of graph.nodes[u].edges) {
      const v = e.a === u ? e.b : e.a;
      if (dist[u] + e.hrs < dist[v]) [dist[v], prev[v]] = [dist[u] + e.hrs, { e, from: u }];
    }
  }
  if (A.node !== B.node && !prev[B.node]) return null;
  const steps = [];
  for (let v = B.node; v !== A.node; v = prev[v].from) steps.unshift({ ...prev[v].e, fwd: prev[v].e.b === v });
  return { steps, access: (A.access ?? 0) + (B.access ?? 0) };
}
function sliceLine(f, a, b) {
  const c = f.geometry.coordinates, cum = f._cum;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const out = [along(c, cum, lo)];
  for (let i = 0; i < c.length; i++) if (cum[i] > lo && cum[i] < hi) out.push(c[i]);
  out.push(along(c, cum, hi));
  return a <= b ? out : out.reverse();
}

function tripHTML() {
  const places = tripPlaces();
  const byDept = {};
  for (const f of places) (byDept[f.properties.dept ?? '—'] ??= []).push(f);
  const opts = (sel) => `<option value="">${t('trip.choose')}</option>${Object.keys(byDept).sort().map((d) => `<optgroup label="${esc(d)}">${byDept[d].map((f) => `<option value="${f.properties.id}" ${f.properties.id === sel ? 'selected' : ''}>${esc(f.properties.name)}</option>`).join('')}</optgroup>`).join('')}`;
  return `<h2>${t('trip.title')}</h2>
    <p class="sub">${t('trip.sub')}</p>
    <div class="trip-form">
      <label><span>${t('trip.from')}</span><select id="tripFrom">${opts(state.trip.from)}</select></label>
      <button class="icon-btn" id="tripSwap" title="${t('trip.swap')}" aria-label="${t('trip.swap')}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg></button>
      <label><span>${t('trip.to')}</span><select id="tripTo">${opts(state.trip.to)}</select></label>
    </div>
    <div id="tripOut"></div>`;
}
function wireTrip(box, key, move) {
  const from = box.querySelector('#tripFrom'), to = box.querySelector('#tripTo');
  from.onchange = () => ((state.trip.from = Number(from.value) || null), runTrip(true));
  to.onchange = () => ((state.trip.to = Number(to.value) || null), runTrip(true));
  box.querySelector('#tripSwap').onclick = () => {
    [state.trip.from, state.trip.to] = [state.trip.to, state.trip.from];
    from.value = state.trip.from ?? '';
    to.value = state.trip.to ?? '';
    runTrip(true);
  };
  runTrip(move);
}
function runTrip(move) {
  const out = $('#tripOut');
  if (!out) return;
  const { from, to } = state.trip;
  const ends = [from, to].filter(Boolean).map((id) => byId.get(id));
  setHL(ends, '#ffffff');
  setToday(null);
  if (!from || !to) {
    out.innerHTML = '';
    if (move && ends.length) fitFeature(ends[0]);
    return;
  }
  if (from === to) return (out.innerHTML = `<p class="note">${t('trip.same')}</p>`);
  const r = findTrip(from, to);
  if (!r) return (out.innerHTML = `<p class="note">${t('trip.none')}</p>`);
  // Group consecutive pieces of the same route into one leg.
  const legs = [];
  for (const s of r.steps) {
    const last = legs.at(-1);
    if (last && last.f === s.f) (last.km += s.km), (last.hrs += s.hrs), last.pieces.push(s);
    else legs.push({ f: s.f, km: s.km, hrs: s.hrs, pieces: [s] });
  }
  const accessKm = r.access * 1.3;
  const km = legs.reduce((a, l) => a + l.km, 0) + accessKm;
  const car = legs.reduce((a, l) => a + l.hrs, 0) + accessKm / 30;
  const train = legs.reduce((a, l) => a + (l.f.properties.mode === RAIL_MODE ? l.km / ENG.rail.train : l.hrs), 0) + accessKm / 30;
  const usesRail = legs.some((l) => l.f.properties.mode === RAIL_MODE && l.km > 5);
  let tun = 0, via = 0;
  for (const l of legs) {
    const parts = numbers?.routes[l.f.properties.id];
    if (!parts || !l.f.properties.km) continue;
    tun += ((parts.tunnel ?? 0) * l.km) / l.f.properties.km;
    via += ((parts.viaduct ?? 0) * l.km) / l.f.properties.km;
  }
  const ferry = legs.some((l) => l.f.properties.category === 'ferry');
  out.innerHTML = `<div id="tripToday" class="compare-wrap"><p class="note">${t('trip.checking')}</p></div>
    <div class="eng" style="margin-top:14px">
      <div class="eng-tiles">
        <div><b>${fmtMin(car)}</b><span>${ico('car')}${t('eng.car')}</span></div>
        ${usesRail ? `<div><b>${fmtMin(train)}</b><span>${ico('train')}${t('trip.withTrain')}</span></div>` : ''}
        <div><b>${fmtKm(km)}</b><span>${ico('ruler')}${t('fact.length')}</span></div>
      </div>
      ${tun > 0.5 || via > 0.5 ? `<p class="note" style="margin-top:4px">${t('trip.built', { tun: fmtKm(tun), via: fmtKm(via) })}</p>` : ''}
      ${ferry ? `<p class="note" style="margin-top:4px">${t('trip.ferry')}</p>` : ''}
      <p class="source" style="margin:8px 0 0">${t('trip.note')}</p>
    </div>
    <div class="actions" style="margin:-4px 0 16px"><button class="btn primary" id="tripFly">${ICONS.fly} ${t('btn.fly')}</button></div>
    <p class="sub-head">${t('trip.steps')}</p>
    <ul class="list">${legs.map((l) => itemHTML(l.f, fmtKm(l.km))).join('')}</ul>`;
  out.querySelectorAll('.item').forEach((b) => (b.onclick = () => select(itemId(b.dataset.id))));
  const pathFeats = r.steps.map((s) => ({ geometry: { type: 'LineString', coordinates: sliceLine(s.f, s.fwd ? s.d0 : s.d1, s.fwd ? s.d1 : s.d0) }, properties: { category: s.f.properties.category, c: '#ffffff' } }));
  setHL([...pathFeats, ...ends], '#ffffff');
  if (move) fitFeats(pathFeats);
  // The whole trip as one line, so the camera can fly it from start to finish.
  const coords = [];
  for (const pf of pathFeats) for (const c of pf.geometry.coordinates) if (!coords.length || haversine(coords.at(-1), c) > 0.005) coords.push(c);
  const trip = {
    geometry: { type: 'LineString', coordinates: coords },
    properties: { name: `${byId.get(from).properties.name} → ${byId.get(to).properties.name}`, category: 'corridor' },
    _cum: cumulative(coords),
    _bbox: bboxOf(coords),
  };
  out.querySelector('#tripFly').onclick = () => flyAlong(trip);
  compareToday(byId.get(from), byId.get(to), usesRail ? train : car, usesRail);
}

// ===========================================================================
// Guided tour and first-visit hint
// ===========================================================================
const byName = (rx, cat) => plan.features.filter((f) => (!cat || f.properties.category === cat) && rx.test(f.properties.name));
const TOUR = [
  () => {
    setHL(collSet('trunks'));
    fitView(HAITI_BOUNDS, { padding: pad(), pitch: state.terrain ? 30 : 0, bearing: 0, ...MOVE, duration: 1800 });
  },
  () => {
    const ring = byName(/^Port-au-Prince Périphérique/, 'ring');
    const sts = plan.features.filter((f) => f.properties.category === 'station' && ring[0] && distToLineKm(f.geometry.coordinates, ring[0].geometry.coordinates) < 2);
    setHL([...ring, ...sts]);
    fitFeats(ring, { maxZoom: 11.5, duration: 2200 });
  },
  () => {
    const feats = plan.features.filter((f) => f.properties.tunnel);
    setHL(feats);
    fitFeats(feats, { duration: 2200 });
  },
  () => {
    const feats = collSet('islands');
    setHL(feats);
    fitFeats(feats, { duration: 2200 });
  },
  () => {
    setHL([]);
    state.devThemes = new Set(['energy', 'water', 'agri', 'housing']);
    state.devStatus = new Set(['proposed']);
    applyDevFilters();
    renderDevPanel();
    map.flyTo({ center: [-72.55, 19.2], zoom: 9.4, pitch: state.terrain ? 40 : 0, bearing: 0, padding: pad(), ...MOVE, duration: 2200 });
  },
  () => {
    tourRestoreDev();
    setHL([]);
    fitView(HAITI_BOUNDS, { padding: pad(), pitch: state.terrain ? 30 : 0, bearing: 0, ...MOVE, duration: 2000 });
  },
];
function startTour() {
  hideHint();
  const begin = () => {
    tour = { i: 0, devThemes: new Set(state.devThemes), devStatus: new Set(state.devStatus), collapsed: state.collapsed };
    if (state.dept) setDept(null, { move: false });
    if (PHONE.matches) {
      setSheet('peek');
      $('#panel').classList.add('collapsed'); // hidden for the tour without changing the saved preference
      $('#openPanel').hidden = true;
    }
    showStep(0);
  };
  if (state.selected != null || state.page) leaveToHome(begin);
  else begin();
}
function tourRestoreDev() {
  if (!tour) return;
  state.devThemes = new Set(tour.devThemes);
  state.devStatus = new Set(tour.devStatus);
  applyDevFilters();
  renderDevPanel();
}
function showStep(i) {
  tour.i = i;
  const n = TOUR.length;
  const box = $('#tour');
  const last = i === n - 1;
  const railKm = plan.features.filter((f) => ['corridor', 'trunk'].includes(f.properties.category)).reduce((s, f) => s + f.properties.km, 0);
  box.innerHTML = `<div class="tour-top"><span class="tour-step">${i + 1} / ${n}</span><button class="icon-btn" id="tourX" aria-label="${t('tour.close')}">${ICONS.close}</button></div>
    <h3>${t(`tour.${i + 1}.t`)}</h3>
    <p>${t(`tour.${i + 1}.p`, { km: fmtKm(railKm) })}</p>
    <div class="tour-dots">${TOUR.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
    ${last ? `<div class="tour-btns wrap"><button class="btn primary" id="tourTrip">${ICONS.route} ${t('btn.trip')}</button><button class="btn" id="tourNum">${t('btn.numbers')}</button></div>` : ''}
    <div class="tour-btns">${i ? `<button class="btn" id="tourPrev">${t('tour.prev')}</button>` : '<span></span>'}<button class="btn ${last ? '' : 'primary'}" id="tourNext">${t(last ? 'tour.done' : 'tour.next')}</button></div>`;
  box.hidden = false;
  box.querySelector('#tourX').onclick = endTour;
  box.querySelector('#tourPrev')?.addEventListener('click', () => showStep(i - 1));
  box.querySelector('#tourNext').onclick = () => (last ? endTour() : showStep(i + 1));
  box.querySelector('#tourTrip')?.addEventListener('click', () => (endTour(), openPage('trip')));
  box.querySelector('#tourNum')?.addEventListener('click', () => (endTour(), openPage('numbers')));
  if (!changeLang.busy) TOUR[i]();
}
function endTour() {
  if (!tour) return;
  tourRestoreDev();
  setHL([]);
  const { collapsed } = tour;
  tour = null;
  $('#tour').hidden = true;
  if (PHONE.matches) {
    $('#panel').classList.toggle('collapsed', collapsed);
    $('#openPanel').hidden = !collapsed;
    if (!collapsed) setSheet('peek');
  }
}

function maybeShowHint(again = false) {
  let seen = false;
  try {
    seen = localStorage.getItem('hintSeen') === '1';
  } catch {
    /* storage unavailable */
  }
  if ((seen && !again) || tour || state.selected != null || state.page) return;
  const box = $('#tour');
  box.innerHTML = `<div class="tour-top"><span class="tour-step">${t('hint.t')}</span><button class="icon-btn" id="hintX" aria-label="${t('tour.close')}">${ICONS.close}</button></div>
    <p>${t('hint.p')}${PHONE.matches ? ` ${t('hint.pPhone')}` : ''}</p>
    <div class="tour-btns"><button class="btn" id="hintOk">${t('hint.ok')}</button><button class="btn primary" id="hintTour">${t('hint.tour')}</button></div>`;
  box.hidden = false;
  box.classList.add('hint');
  box.querySelector('#hintX').onclick = hideHint;
  box.querySelector('#hintOk').onclick = hideHint;
  box.querySelector('#hintTour').onclick = startTour;
}
function hideHint() {
  const box = $('#tour');
  box.classList.remove('hint');
  if (!tour) box.hidden = true;
  try {
    localStorage.setItem('hintSeen', '1');
  } catch {
    /* storage unavailable */
  }
}

function hideHintIfShown() {
  if ($('#tour')?.classList.contains('hint')) hideHint();
}

// MapLibre's fitBounds adds the map's own padding (left over from earlier eased moves) to the padding it is
// given, which can exceed a phone screen. Drop the map's padding first without moving the view, then fit.
function clearPadding() {
  const pd = map.getPadding();
  if (!pd.top && !pd.bottom && !pd.left && !pd.right) return;
  map.stop();
  const c = map.getCanvas();
  map.jumpTo({ center: map.unproject([c.clientWidth / 2, c.clientHeight / 2]), padding: NO_PAD });
}
function fitView(bounds, opts) {
  clearPadding();
  if (safeCam(bounds, { padding: opts.padding })) map.fitBounds(bounds, opts);
}
// MapLibre 5 throws (instead of returning nothing) when the padding leaves no room; retry without the
// map's leftover padding, and give up quietly if it still does not fit.
function safeCam(bounds, opts) {
  try {
    return map.cameraForBounds(bounds, opts);
  } catch {
    clearPadding();
    try {
      return map.cameraForBounds(bounds, opts);
    } catch {
      return undefined;
    }
  }
}

// ===========================================================================
// Today vs. the plan: the same trip on today's roads (OSRM routing on OpenStreetMap, FOSSGIS server)
// ===========================================================================
const todayCache = new Map();
function setToday(geom) {
  map.getSource('today')?.setData(geom ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geom }] } : EMPTY);
}
async function compareToday(fromF, toF, planHrs, usesRail) {
  const key = `${fromF.properties.id}-${toF.properties.id}`;
  const box = () => (state.trip.from === fromF.properties.id && state.trip.to === toF.properties.id ? $('#tripToday') : null);
  let r = todayCache.get(key);
  if (!r) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 9000);
      const [a, b] = [fromF, toF].map((f) => f.geometry.coordinates.map((v) => v.toFixed(5)).join(','));
      const res = await fetch(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${a};${b}?overview=simplified&geometries=geojson`, { signal: ctl.signal });
      clearTimeout(timer);
      const j = await res.json();
      if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.code);
      r = { hrs: j.routes[0].duration / 3600, km: j.routes[0].distance / 1000, geom: j.routes[0].geometry };
      todayCache.set(key, r);
    } catch {
      box()?.remove();
      return;
    }
  }
  const el = box();
  if (!el) return;
  const gain = r.hrs - planHrs;
  el.innerHTML = `<div class="compare">
      <div class="cmp today"><span>${ico('car')}${t('trip.todayBy')}</span><b>${fmtMin(r.hrs)}</b><small>${fmtKm(r.km)}</small></div>
      <div class="cmp-arrow" aria-hidden="true">→</div>
      <div class="cmp plan"><span>${ico(usesRail ? 'train' : 'car')}${t('trip.withPlan')}</span><b>${fmtMin(planHrs)}</b><small>${t(usesRail ? 'trip.withTrain' : 'eng.car')}</small></div>
    </div>
    ${gain > 0.15 ? `<p class="cmp-gain">${t('trip.faster', { time: fmtMin(gain) })}</p>` : ''}
    <p class="source" style="margin:6px 0 0">${t('trip.todayNote')}</p>`;
  setToday(r.geom);
}

// ===========================================================================
// Hazards: hurricane tracks (NOAA IBTrACS, built by tools/build-hazards.mjs), active storms (NOAA NHC map
// service) and earthquakes (USGS catalog, fetched live). Shown from the Development tab.
// ===========================================================================
const hazById = new Map();
state.haz = { storms: false, quakes: false };
const haz = { storms: null, quakes: null, live: null, status: {} };
const STORM_COLORS = { '-1': '#7DD3FC', 0: '#FACC15', 1: '#FDBA74', 2: '#FB923C', 3: '#F97316', 4: '#EF4444', 5: '#D946EF' };
const stormColorExpr = ['match', ['get', 'cat'], ...Object.entries(STORM_COLORS).flatMap(([k, v]) => [Number(k), v]), '#FACC15'];
const stormCat = (c) => (c < 0 ? t('haz.td') : c === 0 ? t('haz.ts') : t('haz.cat', { n: c }));
const fmtDate = (d) => new Date(d).toLocaleDateString(locale(), { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function addHazardLayers() {
  for (const id of ['haz-storms', 'haz-quakes', 'haz-live']) map.addSource(id, { type: 'geojson', data: EMPTY });
  const hidden = { visibility: 'none' };
  const before = 'casing-local';
  map.addLayer({ id: 'haz-storms', type: 'line', source: 'haz-storms', layout: { ...hidden, 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': stormColorExpr, 'line-width': ['interpolate', ['linear'], ['get', 'cat'], -1, 1.2, 0, 1.6, 5, 4], 'line-opacity': 0.8 } }, before);
  map.addLayer({ id: 'haz-live-cone', type: 'fill', source: 'haz-live', filter: isPoly, layout: hidden, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 } }, before);
  map.addLayer({ id: 'haz-live-track', type: 'line', source: 'haz-live', filter: isLine, layout: hidden, paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } }, before);
  map.addLayer({ id: 'haz-sel-line', type: 'line', source: 'haz-storms', filter: ['==', ['get', 'id'], ''], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 } }, before);
  const magR = ['interpolate', ['exponential', 1.8], ['get', 'mag'], 4.5, 2.5, 6, 7, 7.5, 16];
  map.addLayer({ id: 'haz-quakes', type: 'circle', source: 'haz-quakes', layout: hidden, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['*', 0.7, magR], 10, ['*', 1.5, magR]],
    'circle-color': ['interpolate', ['linear'], ['get', 'yr'], 1900, '#FDE68A', 1990, '#FB923C', 2026, '#EF4444'],
    'circle-opacity': 0.55, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.8,
  } });
  map.addLayer({ id: 'haz-quake-labels', type: 'symbol', source: 'haz-quakes', filter: ['>=', ['get', 'mag'], 6.5], layout: { ...hidden, 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': PHONE.matches ? 13 : 11, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#FECACA', 'text-halo-color': '#05070a', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'haz-sel-pt', type: 'circle', source: 'haz-quakes', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
}

async function loadStorms() {
  if (haz.storms) return;
  haz.status.storms = 'loading';
  try {
    const d = await getJSON('data/storms.json');
    haz.storms = d.storms.map((s, i) => {
      const f = { type: 'Feature', properties: { id: `hs${i}`, kind: 'storm', name: s.name, year: s.year, cat: s.cat, wind: s.wind, km: s.km, date: s.date }, geometry: { type: 'LineString', coordinates: s.coords } };
      // Frame the part of the track around Haiti, not the whole journey across the Atlantic.
      const near = s.coords.filter(([x, y]) => x > -79 && x < -67 && y > 15 && y < 23);
      f._bbox = bboxOf(near.length > 1 ? near : s.coords);
      hazById.set(f.properties.id, f);
      return f;
    });
    // Strongest drawn last, so they sit on top.
    map.getSource('haz-storms').setData({ type: 'FeatureCollection', features: [...haz.storms].sort((a, b) => a.properties.cat - b.properties.cat) });
    haz.status.storms = 'ok';
  } catch {
    haz.status.storms = 'error';
  }
}
async function loadLiveStorms() {
  haz.status.live = 'loading';
  renderHazards();
  const BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
  // Atlantic storm slots AT1–AT5: forecast track and cone layers.
  const ids = [7, 8, 33, 34, 59, 60, 85, 86, 111, 112];
  try {
    const parts = await Promise.all(ids.map((id) => fetch(`${BASE}/${id}/query?where=1%3D1&outFields=*&f=geojson`).then((r) => r.json()).catch(() => null)));
    const feats = parts.flatMap((p) => p?.features ?? []).filter((f) => f.geometry);
    haz.live = feats;
    const p = feats[0]?.properties ?? {};
    haz.liveName = p.STORMNAME ?? p.stormname ?? p.NAME ?? p.name ?? null;
    map.getSource('haz-live').setData({ type: 'FeatureCollection', features: feats });
    haz.status.live = 'ok';
  } catch {
    haz.status.live = 'error';
  }
  renderHazards();
}
async function loadQuakes() {
  if (haz.quakes) return;
  haz.status.quakes = 'loading';
  renderHazards();
  try {
    const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=16.5&maxlatitude=21.2&minlongitude=-75.8&maxlongitude=-68&minmagnitude=4.5&starttime=1900-01-01&orderby=time';
    const d = await getJSON(url);
    haz.quakes = d.features.map((q, i) => {
      const [lon, lat, depth] = q.geometry.coordinates;
      const yr = new Date(q.properties.time).getUTCFullYear();
      const mag = Math.round(q.properties.mag * 10) / 10;
      const f = { type: 'Feature', properties: { id: `hq${i}`, kind: 'quake', mag, yr, time: q.properties.time, place: q.properties.place, url: q.properties.url, depth, label: `M${mag.toFixed(1)} · ${yr}` }, geometry: { type: 'Point', coordinates: [lon, lat] } };
      f._bbox = [lon, lat, lon, lat];
      hazById.set(f.properties.id, f);
      return f;
    });
    // Smaller and older drawn first, so big recent ones stay on top.
    map.getSource('haz-quakes').setData({ type: 'FeatureCollection', features: [...haz.quakes].sort((a, b) => a.properties.mag - b.properties.mag) });
    haz.status.quakes = 'ok';
  } catch {
    haz.status.quakes = 'error';
  }
}

async function toggleHaz(k) {
  state.haz[k] = !state.haz[k];
  const on = state.haz[k];
  const vis = (ids) => ids.forEach((id) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  renderHazards();
  if (k === 'storms') {
    if (on) {
      await loadStorms();
      loadLiveStorms();
      // Storm tracks make sense from a little higher up.
      if (map.getZoom() > 6.2) fitView([[-80, 14.5], [-66, 23.5]], { padding: pad(), pitch: 0, bearing: 0, ...MOVE });
    }
    vis(['haz-storms', 'haz-live-cone', 'haz-live-track']);
  } else {
    if (on) await loadQuakes();
    vis(['haz-quakes', 'haz-quake-labels']);
  }
  renderHazards();
}

function renderHazards() {
  const ul = $('#hazards');
  if (!ul) return;
  const meta = (k, n) => (haz.status[k] === 'loading' ? t('haz.loading') : haz.status[k] === 'error' ? '—' : n ?? '');
  ul.innerHTML = [
    ['storms', t('haz.storms'), t('haz.stormsHint'), ico('storm'), meta('storms', haz.storms?.length), '#F97316'],
    ['quakes', t('haz.quakes'), t('haz.quakesHint'), ico('quake'), meta('quakes', haz.quakes?.length), '#EF4444'],
  ].map(([k, name, hint, sw, m, col]) => `<li class="layer ${state.haz[k] ? '' : 'off'}" data-h="${k}" role="switch" tabindex="0" aria-checked="${state.haz[k]}">
      <span class="swatch theme-ico" style="--c:${col}">${sw}</span>
      <span class="layer-name">${esc(name)}<small>${esc(hint)}</small></span>
      <span class="layer-meta">${m}</span><span class="switch"></span></li>`).join('');
  ul.querySelectorAll('[data-h]').forEach((li) => {
    li.onclick = () => toggleHaz(li.dataset.h);
    li.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleHaz(li.dataset.h));
  });
  const notes = [];
  if (state.haz.storms) {
    notes.push(`<div class="haz-legend">${[-1, 0, 1, 2, 3, 4, 5].map((c) => [c, STORM_COLORS[c]]).map(([c, col]) => `<span style="--c:${col}"><i></i>${c < 0 ? 'TD' : c == 0 ? 'TS' : `Cat ${c}`}</span>`).join('')}</div>`);
    const live = haz.status.live === 'loading' ? t('haz.loading') : haz.status.live === 'error' ? t('haz.unavailable') : haz.live?.length ? `<b>${esc(t('haz.live', { name: haz.liveName ?? '' }))}</b> ${esc(t('haz.liveNote'))}` : t('haz.noLive');
    notes.push(`<p class="count-key">${live}</p>`);
  }
  if (state.haz.quakes && haz.status.quakes === 'error') notes.push(`<p class="count-key">${t('haz.unavailable')}</p>`);
  $('#hazNote').innerHTML = notes.join('');
}

function selectHaz(id, { move = true } = {}) {
  if (tour) endTour();
  const f = hazById.get(id);
  stopFly();
  clearSelection();
  state.selected = id;
  const isPt = f.geometry.type === 'Point';
  map.setFilter('haz-sel-pt', ['==', ['get', 'id'], isPt ? id : '']);
  map.setFilter('haz-sel-line', ['==', ['get', 'id'], isPt ? '' : id]);
  if (state.collapsed) setCollapsed(false);
  $('#search').value = '';
  $('#results').hidden = true;
  setTab(state.tab);
  renderHazDetail(f);
  if (PHONE.matches && $('#panel').dataset.state === 'peek') setSheet('half');
  openedPage();
  if (move) requestAnimationFrame(() => (isPt ? fitFeature(f, { zoom: Math.max(map.getZoom(), 8.5) }) : fitFeature(f, { whole: true })));
}

function renderHazDetail(f) {
  const p = f.properties;
  const el = $('#detail');
  const storm = p.kind === 'storm';
  const color = storm ? STORM_COLORS[p.cat] : '#FCA5A5';
  const facts = storm
    ? [[stormCat(p.cat), t('haz.catNear'), 'storm'], [p.wind ? `${Math.round(p.wind * 1.852)} km/h` : '—', t('haz.windNear'), 'wind'], [`${p.km} km`, t('haz.closest'), 'ruler']]
    : [[`M ${p.mag.toFixed(1)}`, t('haz.mag'), 'quake'], [`${Math.round(p.depth)} km`, t('haz.depth'), 'depth'], [String(p.yr), t('haz.date'), 'calendar']];
  el.innerHTML = `
    <div class="detail-top">${backBtn()}<span class="pill" style="--c:${color}">${ico(storm ? 'storm' : 'quake')}${t(storm ? 'haz.storm' : 'haz.quake')}</span></div>
    <h2>${esc(storm ? `${p.name || t('haz.unnamed')} ${p.year}` : `M ${p.mag.toFixed(1)} · ${p.yr}`)}</h2>
    <p class="sub">${esc(storm ? `${t('haz.when')}: ${fmtDate(p.date)}` : `${fmtDate(p.time)}${p.place ? ` · ${p.place}` : ''}`)}</p>
    <div class="facts">${facts.map(([v, k, i]) => factHTML(v, k, null, '', i)).join('')}</div>
    <div class="actions">
      <button class="btn" id="btnZoom">${ICONS.zoom} ${t('btn.zoom')}</button>
      ${storm ? '' : `<a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${ICONS.map} ${t('haz.usgs')}</a>`}
    </div>
    <p class="note">${t(storm ? 'haz.stormNote' : 'haz.quakeNote')}</p>
    <p class="source" style="margin-top:10px">${storm ? 'NOAA NCEI IBTrACS v04r01' : 'USGS ComCat'}</p>`;
  el.hidden = false;
  el.querySelector('#detailClose').onclick = closeSelection;
  el.querySelector('#btnZoom').onclick = () => fitFeature(f, f.geometry.type === 'Point' ? { zoom: 10 } : { whole: true });
}

// ---------------------------------------------------------------------------
// Computers: drag the panel's right edge (or its edge tab) to make it wider, up to the whole screen.
// A plain click on the tab still hides / shows the panel. The width is remembered on this device.
// ---------------------------------------------------------------------------
function panelResize() {
  if (PHONE.matches) return;
  const root = document.documentElement;
  const MIN = 340;
  const max = () => window.innerWidth - 24;
  const setW = (w, save) => {
    const v = Math.round(clamp(w, MIN, max()));
    root.style.setProperty('--panel-w', `${v}px`);
    $('#panel').classList.toggle('wide', v > 620);
    if (save) {
      try {
        localStorage.setItem('panelW', String(v));
      } catch {
        /* storage unavailable */
      }
    }
  };
  try {
    const saved = Number(localStorage.getItem('panelW'));
    if (saved) setW(saved, false);
  } catch {
    /* storage unavailable */
  }
  const grip = document.createElement('div');
  grip.className = 'panel-resizer';
  grip.title = t('panel.resize');
  $('#panel').appendChild(grip);
  $('#edgeTab').title = `${$('#edgeTab').title} · ${t('panel.resize')}`;
  for (const el of [grip, $('#edgeTab')]) {
    el.addEventListener('pointerdown', (e) => {
      if (state.collapsed || e.button !== 0) return;
      const x0 = e.clientX, w0 = $('#panel').getBoundingClientRect().width;
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 4) return;
        moved = true;
        document.body.classList.add('resizing');
        // Within 60 px of the right edge it snaps to the full screen.
        const w = w0 + ev.clientX - x0;
        setW(w > max() - 60 ? max() : w, false);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing');
        if (moved) {
          panelResize.dragged = el.id === 'edgeTab';
          setW($('#panel').getBoundingClientRect().width, true);
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
  grip.addEventListener('dblclick', () => setW(380, true));
  window.addEventListener('resize', () => setW($('#panel').getBoundingClientRect().width, false));
}
