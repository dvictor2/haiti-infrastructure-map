// Real 3D models at a few places in the plan, from free models made by 3D artists (see ASSET_CREDITS.md):
//   rail     Gonaïves · Porte Saint-Marc station: platform, canopies, track, masts and a train that comes and goes
//   airport  the new national airport (Petite-Rivière-de-l'Artibonite): an A320 lining up and taking off
//   wind     a wind farm with turning blades
//   solar    a block of solar panel rows
//   ship     a container ship sailing in to Port-au-Prince harbour, turning and sailing out again
//
// app.js imports this file (and three.js) only once the map is zoomed in near one of the places, and each
// place loads its own models only when the map is near it. Nothing is drawn below zoom 14.
//
// One MapLibre custom layer shares the map's WebGL context and depth buffer (so terrain hides models
// correctly). Each place is a small three.js scene in metres around its own origin:
//   scene axes  x = east, y = up, z = south   (MapLibre's getMatrixForModel convention)
//   models      metres, +Y up, +Z forward
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const MODELS = 'assets/models/';
const MIN_ZOOM = 14;
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();
// Each file is fetched and parsed once; callers clone what they place.
const loadModel = (n) => {
  if (!cache.has(n)) cache.set(n, loader.loadAsync(`${MODELS}${n}.glb`).then((g) => g.scene));
  return cache.get(n);
};

const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
// Heading (radians, clockwise from north) of a direction given as east/north.
const heading = (e, n) => Math.atan2(e, n);
// Rotation about Y that turns a model's +Z (forward) to face `brg`.
const yaw = (brg) => Math.PI - brg;
const smooth = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// Look: one sun, a small sky to reflect, soft painted shadows
// ---------------------------------------------------------------------------
const SUN = new THREE.Vector3(0.5, 1, 0.35).normalize(); // high tropical sun from the south-east (x east, y up, z south)
const SUN_FLAT = Math.hypot(SUN.x, SUN.z);
const SHADOW_DIR = [-SUN.x / SUN_FLAT, SUN.z / SUN_FLAT]; // east/north direction shadows fall in (west-north-west)
const SHADOW_LEN = SUN_FLAT / SUN.y; // metres of shadow per metre of height (about 0.6)
const SUN_LIGHT = 3.0, FILL_LIGHT = 0.15, SKY_LIGHT = 0.6;

// The sky the models reflect and are lit by: a blue dome, a pale horizon, warm ground and a sun disc, blurred
// once into an environment map (no file to download). Without it metal parts (steel, hulls, solar glass) have
// nothing to reflect and draw black. Built in the layer's prerender, see addModels3D.
let ENV = null;
function buildEnv(renderer) {
  const sky = new THREE.Scene();
  const geo = new THREE.SphereGeometry(40, 32, 16);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
  const zenith = [0.36, 0.5, 0.8], horizon = [0.92, 0.95, 1.0], ground = [0.36, 0.33, 0.27]; // linear colours
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 40;
    const to = h >= 0 ? zenith : ground, t = Math.pow(Math.abs(h), h >= 0 ? 0.45 : 0.35);
    for (let k = 0; k < 3; k++) col[i * 3 + k] = horizon[k] + (to[k] - horizon[k]) * t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  sky.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const disc = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(40, 37, 32) }));
  disc.position.copy(SUN).multiplyScalar(36);
  sky.add(disc);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(sky, 0, 0.1, 100).texture;
  pmrem.dispose();
  geo.dispose();
  return tex;
}

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x7a6a50, FILL_LIGHT));
  const sun = new THREE.DirectionalLight(0xfff4e0, SUN_LIGHT);
  sun.position.copy(SUN);
  scene.add(sun);
}

// Soft pictures, drawn once: 'blob' (a soft rounded box), 'plane' (fuselage, wings, tail) and 'wake'.
// Row 0 of the picture is the front (+Z) of the object it lies under.
const shadowTex = {};
function softTex(kind) {
  if (shadowTex[kind]) return shadowTex[kind];
  const N = 64, px = new Uint8Array(N * N * 4);
  const box = (x, t, cx, ct, hx, ht, r) => Math.hypot(Math.max(Math.abs(x - cx) - hx + r, 0), Math.max(Math.abs(t - ct) - ht + r, 0)) - r; // distance outside a rounded box
  const soft = kind === 'plane' ? 0.1 : 0.3;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N) * 2 - 1, t = 1 - ((j + 0.5) / N) * 2;
      const d = kind === 'plane' ? Math.min(box(x, t, 0, 0, 0.1, 0.9, 0.1), box(x, t, 0, -0.04, 0.86, 0.09, 0.06), box(x, t, 0, -0.84, 0.3, 0.05, 0.04)) : box(x, t, 0, 0, 0.68, 0.68, 0.3);
      let a = 1 - smooth(Math.max(0, Math.min(1, d / soft + 0.5)));
      if (kind === 'wake') {
        // A wake: narrow and bright at the stern (front of the picture), spreading and fading astern.
        const far = (1 - t) / 2, half = 0.16 + 0.7 * far;
        a = Math.max(0, 1 - far) ** 1.6 * (1 - smooth(Math.min(1, Math.abs(x) / half))) * smooth(Math.min(1, far * 12));
      }
      px.set([255, 255, 255, Math.round(a * 255)], (j * N + i) * 4);
    }
  }
  const tex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return (shadowTex[kind] = tex);
}
// A flat soft shadow, `w` metres wide and `l` metres long (along the object's +Z).
function shadowMesh(kind, w, l, opacity, color = 0x000000) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: softTex(kind), color, transparent: true, opacity, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}
// Lays a shadow on the terrain at a local point, tilted to the slope there, turned to `rot` about the vertical.
const _n = new THREE.Vector3(), _q = new THREE.Quaternion();
function layOnGround(mesh, en, rot, ctx, lift = 0.5, d = 10) {
  const h0 = ctx.ground(en), hE = ctx.ground([en[0] + d, en[1]]), hN = ctx.ground([en[0], en[1] + d]);
  _n.set(-(hE - h0) / d, 1, (hN - h0) / d).normalize();
  mesh.position.set(en[0], h0 + lift, -en[1]);
  mesh.quaternion.setFromUnitVectors(Y, _n).multiply(_q.setFromAxisAngle(Y, rot));
}

// Painted ground for a place, as map layers draped on the terrain under the models: pads (cleared, graded or
// paved ground), paths (service tracks) and shadows of things that do not move. Sizes are in metres.
//   features: [{ k: 'pad', ring: [[e, n], ...], c: colour, o: opacity }
//              { k: 'path' | 'shadow', line: [[e, n], ...], w: width in metres, c: colour, o: opacity }]
function groundLayers(ctx, id, features) {
  const { map } = ctx;
  if (map.getSource(id)) return;
  const ll = (en) => ctx.toLngLat(en).toArray();
  const data = {
    type: 'FeatureCollection',
    features: features.map(({ k, ring, line, ...props }) => ({
      type: 'Feature',
      properties: { k, ...props },
      geometry: ring ? { type: 'Polygon', coordinates: [[...ring, ring[0]].map(ll)] } : { type: 'LineString', coordinates: line.map(ll) },
    })),
  };
  // Pixels per metre at a zoom (512 px tiles), so line widths can be given in metres.
  const ppm = (z) => 2 ** z / (78271.517 * Math.cos((ctx.lat * Math.PI) / 180));
  const metres = (m) => ['interpolate', ['exponential', 2], ['zoom'], 10, ['*', m, ppm(10)], 24, ['*', m, ppm(24)]];
  const before = map.getLayer('models-3d') ? 'models-3d' : undefined;
  map.addSource(id, { type: 'geojson', data });
  map.addLayer({ id: `${id}-pad`, type: 'fill', source: id, minzoom: 13, filter: ['==', ['get', 'k'], 'pad'], paint: { 'fill-color': ['get', 'c'], 'fill-opacity': ['get', 'o'] } }, before);
  map.addLayer({ id: `${id}-path`, type: 'line', source: id, minzoom: 13, filter: ['==', ['get', 'k'], 'path'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-opacity': ['get', 'o'], 'line-width': metres(['get', 'w']), 'line-blur': metres(['*', ['get', 'w'], 0.25]) } }, before);
  map.addLayer({ id: `${id}-shadow`, type: 'line', source: id, minzoom: 13, filter: ['==', ['get', 'k'], 'shadow'], paint: { 'line-color': '#000000', 'line-opacity': ['get', 'o'], 'line-width': metres(['get', 'w']), 'line-blur': metres(['*', ['get', 'w'], 0.45]) } }, before);
}
const rect = (e0, n0, e1, n1) => [[e0, n0], [e1, n0], [e1, n1], [e0, n1]];

// Local metres around an origin, via Web Mercator (exact at the scale of one place).
function frame(origin) {
  const o = maplibregl.MercatorCoordinate.fromLngLat(origin);
  const mPerUnit = 1 / o.meterInMercatorCoordinateUnits();
  return {
    toLocal: ([lng, lat]) => {
      const c = maplibregl.MercatorCoordinate.fromLngLat([lng, lat]);
      return [(c.x - o.x) * mPerUnit, (o.y - c.y) * mPerUnit];
    },
    toLngLat: ([e, n]) => new maplibregl.MercatorCoordinate(o.x + e / mPerUnit, o.y - n / mPerUnit).toLngLat(),
  };
}

// A polyline in local metres, with lookup by distance along it.
function polyline(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum.at(-1);
  const at = (s) => {
    s = Math.max(0, Math.min(L, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  return { L, at };
}

// Placement helpers for one scene (or a group in it).
function placer(scene) {
  const matrix = (e, n, h, rot = 0, s = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(e, h, -n), new THREE.Quaternion().setFromAxisAngle(Y, rot), new THREE.Vector3(s, s, s));
  return {
    matrix,
    // A copy of a model at a matrix.
    place(model, m) {
      const o = model.clone();
      o.applyMatrix4(m);
      o.traverse((x) => (x.frustumCulled = false));
      scene.add(o);
      return o;
    },
    // Many copies of a model as instanced meshes: one draw call per part, however many copies.
    instance(model, mats) {
      model.updateMatrixWorld(true);
      model.traverse((o) => {
        if (!o.isMesh) return;
        const im = new THREE.InstancedMesh(o.geometry, o.material, mats.length);
        mats.forEach((m, i) => im.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(m, o.matrixWorld)));
        im.frustumCulled = false;
        scene.add(im);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Rail: station + train
// ---------------------------------------------------------------------------
const TRAIN = { cruise: 25, accel: 0.55, dwell: 25, approach: 2600, layover: 12 }; // m/s, m/s², s, m, s
async function buildRail({ station, line }, ctx) {
  const [power, trailer, platform, ramp, canopy, track, mast, shelter, board] = await Promise.all(
    ['train-power-car', 'train-trailer-car', 'platform-island', 'platform-ramp', 'platform-canopy', 'track-6m', 'catenary-mast', 'platform-shelter', 'departure-board'].map(loadModel),
  );
  const scene = new THREE.Scene();
  lights(scene);
  // Everything that is built (track, platform, masts, the bank under them) sits in one group on a straight
  // grade line fitted to the ground, like a real railway formation; see `fit` below.
  const formation = new THREE.Group();
  formation.matrixAutoUpdate = false;
  scene.add(formation);
  const P = placer(formation), PS = placer(scene);
  const { L, at } = polyline(line.map(ctx.toLocal)); // the line ends at the station
  const end = at(L), back = at(L - 60);
  const dir = [(end[0] - back[0]) / 60, (end[1] - back[1]) / 60];
  const right = [dir[1], -dir[0]];
  const fwd = yaw(heading(dir[0], dir[1])), bwd = fwd + Math.PI;
  // u = metres along the line (0 = station end, negative = back down the line), v = metres to the right.
  const en = (u, v) => [end[0] + dir[0] * u + right[0] * v, end[1] + dir[1] * u + right[1] * v];
  const M = (u, v, h, rot) => P.matrix(...en(u, v), h, rot);

  const RAIL_TOP = 0.55; // train wheels sit on the rails of the track model
  const PLAT_LEN = 132, PLAT_V = -(3.1 + 1.75); // platform edge 1.75 m from the track centre, on the left
  const platStart = -8 - PLAT_LEN; // the platform ends 8 m before the station point
  P.instance(track, Array.from({ length: 50 }, (_, i) => M(-300 + i * 6, 0, 0, fwd)));
  P.instance(platform, Array.from({ length: PLAT_LEN / 6 }, (_, i) => M(platStart + i * 6, PLAT_V, 0, fwd)));
  P.place(ramp, M(platStart, PLAT_V, 0, bwd));
  P.instance(canopy, [0, 1, 2, 3].map((i) => M(platStart + 48 + i * 12, PLAT_V, 0, fwd)));
  P.place(shelter, M(platStart + 30, PLAT_V, 1.65, fwd));
  P.place(board, M(platStart + 106, PLAT_V, 1.65, fwd));
  P.instance(mast, Array.from({ length: 7 }, (_, i) => M(-290 + i * 48, 3.4, 0, fwd)));

  // The bank the formation stands on: a ballast-coloured bed whose sides run down into the ground, so nothing
  // hangs in the air where the land falls away. Top v = -8.8..4.9, sides at 1:1, tapering out at the far end.
  {
    const TOP = [-8.8, 4.9], U0 = -304, U1 = 4, D = 7;
    const c = (u, v, h) => { const [e, n] = en(u, v); return [e, h, -n]; };
    const t = [c(U0, TOP[0], -0.03), c(U1, TOP[0], -0.03), c(U1, TOP[1], -0.03), c(U0, TOP[1], -0.03)];
    const b = [c(U0 - 3 * D, TOP[0] - D, -D), c(U1 + D, TOP[0] - D, -D), c(U1 + D, TOP[1] + D, -D), c(U0 - 3 * D, TOP[1] + D, -D)];
    const quads = [[t[0], t[3], t[2], t[1]], [t[0], t[1], b[1], b[0]], [t[1], t[2], b[2], b[1]], [t[2], t[3], b[3], b[2]], [t[3], t[0], b[0], b[3]]];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(quads.flatMap(([p, q, r, w]) => [p, q, r, p, r, w]).flat(), 3));
    geo.computeVertexNormals();
    const bank = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8f8672, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
    bank.frustumCulled = false;
    formation.add(bank);
  }
  // Soft shade on the platform under each canopy.
  for (let i = 0; i < 4; i++) {
    const sh = shadowMesh('blob', 7.4, 13.5, 0.3);
    sh.applyMatrix4(M(platStart + 48 + i * 12 + 1.3, PLAT_V - 0.9, 1.69, fwd));
    formation.add(sh);
  }
  // Painted ground: the cleared strip the bank stands on, and the bank's shadow on its far side from the sun.
  const side = SHADOW_DIR[0] * right[0] + SHADOW_DIR[1] * right[1] < 0 ? -1 : 1; // which side the shadow falls
  const edge = side < 0 ? -13.5 : 9.5;
  groundLayers(ctx, 'm3d-rail-ground', [
    { k: 'pad', ring: [en(-328, -13.5), en(11, -13.5), en(11, 9.5), en(-328, 9.5)], c: '#8f8672', o: 0.8 },
    { k: 'shadow', line: [en(-322, edge), en(8, edge)], w: 6, o: 0.25 },
  ]);

  // The grade line: height a + b * u, the straight line closest to the ground along the last 300 m, lifted so
  // the formation is never below the ground. Read again every second or so (terrain tiles keep arriving, and
  // the relief scale changes with zoom); the group is sheared, so masts and walls stay upright.
  const grade = { a: 0, b: 0, at: (u) => grade.a + grade.b * u, last: -1e9 };
  const fit = () => {
    const pts = [];
    for (let u = -300; u <= 0; u += 20) pts.push([u, Math.max(...[-8, -3, 0, 4].map((v) => ctx.ground(en(u, v))))]);
    const n = pts.length, su = pts.reduce((x, p) => x + p[0], 0), sh = pts.reduce((x, p) => x + p[1], 0);
    const suu = pts.reduce((x, p) => x + p[0] * p[0], 0), suh = pts.reduce((x, p) => x + p[0] * p[1], 0);
    const b = Math.max(-0.02, Math.min(0.02, (n * suh - su * sh) / (n * suu - su * su)));
    let a = (sh - b * su) / n;
    a += Math.max(...pts.map(([u, h]) => h - (a + b * u))) + 0.15;
    if (Math.abs(a - grade.a) < 0.01 && Math.abs(b - grade.b) < 1e-5) return;
    Object.assign(grade, { a, b });
    const k = dir[0] * end[0] + dir[1] * end[1];
    formation.matrix.set(1, 0, 0, 0, b * dir[0], 1, -b * dir[1], a - b * k, 0, 0, 1, 0, 0, 0, 0, 1);
    formation.matrixWorldNeedsUpdate = true;
  };

  // Power car, three passenger cars, power car (push-pull, so it can leave the way it came).
  const cars = [[power, 20.4], [trailer, 25.7], [trailer, 25.7], [trailer, 25.7], [power, 20.4, true]].map(([m, len, flip]) => {
    const o = PS.place(m, new THREE.Matrix4());
    const sh = shadowMesh('blob', 5.4, len + 2.5, 0.5); // the dark under and beside each car
    sh.position.y = 0.06;
    o.add(sh);
    return { len, flip, o };
  });
  const sStop = L - 10;
  const brakeDist = TRAIN.cruise ** 2 / (2 * TRAIN.accel);
  const tCruise = (TRAIN.approach - brakeDist) / TRAIN.cruise, tBrake = TRAIN.cruise / TRAIN.accel;
  const runT = tCruise + tBrake;
  const cycle = runT * 2 + TRAIN.dwell + TRAIN.layover;
  const toGo = (t) => (t < tCruise ? TRAIN.approach - TRAIN.cruise * t : 0.5 * TRAIN.accel * Math.max(0, tBrake - (t - tCruise)) ** 2);
  const state = (t) => {
    if (ctx.reducedMotion) return sStop;
    t %= cycle;
    if (t < runT) return sStop - toGo(t);
    if (t < runT + TRAIN.dwell) return sStop;
    if (t < runT * 2 + TRAIN.dwell) return sStop - toGo(runT * 2 + TRAIN.dwell - t); // leaving the way it came
    return null;
  };
  const q = new THREE.Quaternion();
  return {
    scene,
    // Start with the train braking into the station (about 20 s from stopping), so the first look shows it arriving.
    t0: tCruise + 25,
    update(time) {
      if (performance.now() - grade.last > 1200) {
        grade.last = performance.now();
        fit();
      }
      const front = state(time);
      let s = front;
      for (const c of cars) {
        c.o.visible = front != null;
        if (front == null) continue;
        // Each car sits between its two ends on the line, so it follows curves.
        const a = at(s), b = at(s - c.len), mid = at(s - c.len / 2);
        // On the formation the car rides the rails; further out it runs on the ground, easing between the two.
        const u = s - c.len / 2 - L, w = smooth(Math.max(0, Math.min(1, (u + 360) / 60)));
        const h = (w < 1 ? (1 - w) * (ctx.ground(mid) + 0.2) : 0) + (w > 0 ? w * (grade.at(Math.max(u, -304)) + RAIL_TOP) : 0);
        c.o.position.set(mid[0], h, -mid[1]);
        c.o.quaternion.copy(q.setFromAxisAngle(Y, yaw(heading(a[0] - b[0], a[1] - b[1]) + (c.flip ? Math.PI : 0))));
        s -= c.len + 0.6;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Airport: an A320 lines up, rolls, lifts off and climbs away
// ---------------------------------------------------------------------------
async function buildAirport({ runway, item }, ctx) {
  const plane = await loadModel('plane-a320');
  const scene = new THREE.Scene();
  lights(scene);
  const P = placer(scene);
  const a = ctx.toLocal(runway[0]), b = ctx.toLocal(runway[1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const rot = yaw(heading(dir[0], dir[1]));
  const o = P.place(plane, new THREE.Matrix4());
  // Runway surface: 45 m of asphalt with edge and dashed centre lines, painted onto the terrain as map layers
  // (so it follows the ground exactly, under the plane).
  const r = [dir[1], -dir[0]];
  const ll = (u, v) => ctx.toLngLat([a[0] + dir[0] * u + r[0] * v, a[1] + dir[1] * u + r[1] * v]).toArray();
  const W = 22.5;
  ctx.map.addSource('m3d-runway', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { k: 'surface' }, geometry: { type: 'Polygon', coordinates: [[ll(-20, -W), ll(len + 20, -W), ll(len + 20, W), ll(-20, W), ll(-20, -W)]] } },
        { type: 'Feature', properties: { k: 'centre' }, geometry: { type: 'LineString', coordinates: [ll(60, 0), ll(len - 60, 0)] } },
        { type: 'Feature', properties: { k: 'edge' }, geometry: { type: 'MultiLineString', coordinates: [[ll(0, -W + 1), ll(len, -W + 1)], [ll(0, W - 1), ll(len, W - 1)]] } },
        // Threshold "piano keys" at both ends.
        ...[0, len - 30].flatMap((u) => [-15, -9, -3, 3, 9, 15].map((v) => ({ type: 'Feature', properties: { k: 'key' }, geometry: { type: 'Polygon', coordinates: [[ll(u, v - 1.5), ll(u + 30, v - 1.5), ll(u + 30, v + 1.5), ll(u, v + 1.5), ll(u, v - 1.5)]] } }))),
        // Touchdown-zone bars (150, 300 and 600 m in) and the two big aiming-point blocks (400 m in), from both ends.
        ...[0, 1].flatMap((far) => {
          const U = (u, l) => (far ? [len - u - l, len - u] : [u, u + l]);
          const bar = ([u0, u1], v0, v1) => ({ type: 'Feature', properties: { k: 'key' }, geometry: { type: 'Polygon', coordinates: [[ll(u0, v0), ll(u1, v0), ll(u1, v1), ll(u0, v1), ll(u0, v0)]] } });
          return [
            ...[150, 300, 600].flatMap((u) => [-1, 1].flatMap((sgn) => [5, 8, 11].map((v) => bar(U(u, 22.5), sgn * v, sgn * (v + 1.8))))),
            ...[-1, 1].map((sgn) => bar(U(400, 45), sgn * 6, sgn * 13)),
          ];
        }),
      ],
    },
  });
  const beforeId = ctx.map.getLayer('models-3d') ? 'models-3d' : undefined;
  ctx.map.addLayer({ id: 'm3d-runway', type: 'fill', source: 'm3d-runway', minzoom: 12, filter: ['==', ['get', 'k'], 'surface'], paint: { 'fill-color': '#3a3d42', 'fill-opacity': 0.96 } }, beforeId);
  ctx.map.addLayer({ id: 'm3d-runway-keys', type: 'fill', source: 'm3d-runway', minzoom: 13, filter: ['==', ['get', 'k'], 'key'], paint: { 'fill-color': '#ececec' } }, beforeId);
  ctx.map.addLayer({ id: 'm3d-runway-lines', type: 'line', source: 'm3d-runway', minzoom: 13, filter: ['in', ['get', 'k'], ['literal', ['centre', 'edge']]], paint: { 'line-color': '#ececec', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 0.3, 18, 3.5], 'line-dasharray': ['case', ['==', ['get', 'k'], 'centre'], ['literal', [6, 4]], ['literal', [1, 0]]] } }, beforeId);
  // The rest of the airfield, on the terminal's side of the runway and beside the end the plane takes off
  // from: paved shoulders, a taxiway with two links to the runway, an apron, and three planes parked on it.
  // (No terminal building yet: that needs a model.)
  const hubEN = item ? ctx.toLocal(item.geometry.coordinates) : [a[0] + r[0], a[1] + r[1]];
  const SIDE = (hubEN[0] - a[0]) * r[0] + (hubEN[1] - a[1]) * r[1] < 0 ? -1 : 1;
  const en = (u, v) => [a[0] + dir[0] * u + r[0] * v * SIDE, a[1] + dir[1] * u + r[1] * v * SIDE];
  const strip = (u0, u1, v0, v1, c, o = 0.96) => ({ k: 'pad', ring: [en(u0, v0), en(u1, v0), en(u1, v1), en(u0, v1)], c, o });
  const TAXI = 150, APRON = [300, 760, 173, 310]; // taxiway centre line (m from the runway's); apron u0, u1, v0, v1
  const GATES = [400, 530, 660].map((u) => en(u, 245));
  groundLayers(ctx, 'm3d-airport-ground', [
    strip(-20, len + 20, W, W + 7.5, '#57595c'), strip(-20, len + 20, -W - 7.5, -W, '#57595c'),
    strip(140, 920, TAXI - 11.5, TAXI + 11.5, '#46494e'),
    strip(140, 163, W + 7.5, TAXI - 11.5, '#46494e'), strip(897, 920, W + 7.5, TAXI - 11.5, '#46494e'),
    strip(...APRON, '#4d5055'),
    { k: 'path', line: [en(151.5, W + 2), en(151.5, TAXI), en(908.5, TAXI), en(908.5, W + 2)], w: 0.5, c: '#e0b83a', o: 0.95 },
    ...GATES.map((g, i) => ({ k: 'path', line: [en(400 + i * 130, TAXI), en(400 + i * 130, 262)], w: 0.4, c: '#e0b83a', o: 0.9 })),
    ...[APRON[0] + 6, APRON[1] - 6].map((u) => ({ k: 'path', line: [en(u, APRON[2] + 6), en(u, APRON[3] - 6)], w: 0.4, c: '#ececec', o: 0.8 })),
  ]);
  const gateRot = yaw(heading(r[0] * SIDE, r[1] * SIDE)); // parked nose-in, facing away from the runway
  const parked = GATES.map((g) => {
    const o2 = P.place(plane, new THREE.Matrix4());
    o2.rotation.y = gateRot;
    const sh = shadowMesh('plane', 39, 39, 0.45);
    scene.add(sh);
    return { en: g, o: o2, sh };
  });
  let parkedAt = -1e9;
  const park = () => {
    if (performance.now() - parkedAt < 1500) return; // ground heights keep arriving for a while
    parkedAt = performance.now();
    for (const k of parked) {
      k.o.position.set(k.en[0], ctx.ground(k.en), -k.en[1]);
      layOnGround(k.sh, k.en, gateRot, ctx, 0.5, 14);
    }
  };
  const ACC = 1.6, VR = 75, CLIMB_V = 80, CLIMB_RATE = 9; // m/s², m/s, m/s, m/s
  const HOLD = 14, tRoll = VR / ACC, dRoll = (VR * VR) / (2 * ACC), CLIMB = 45, GAP = 8;
  const cycle = HOLD + tRoll + CLIMB + GAP;
  const start = 160; // lined up 160 m in from the runway end
  const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  const shadow = shadowMesh('plane', 39, 39, 0.45);
  scene.add(shadow);
  return {
    scene,
    t0: 4,
    update(time) {
      park();
      let t = ctx.reducedMotion ? 0 : time % cycle, d = 0, alt = 0, pitch = 0;
      if (t < HOLD) d = 0;
      else if ((t -= HOLD) < tRoll) d = 0.5 * ACC * t * t;
      else if ((t -= tRoll) < CLIMB) {
        d = dRoll + CLIMB_V * t;
        alt = CLIMB_RATE * t * smooth(Math.min(1, t / 6));
        pitch = THREE.MathUtils.degToRad(9) * smooth(Math.min(1, t / 3));
      } else {
        o.visible = shadow.visible = false;
        return;
      }
      o.visible = shadow.visible = true;
      const s = start + d;
      const p = [a[0] + dir[0] * s, a[1] + dir[1] * s];
      const ground = ctx.ground(a); // the climb-out is measured from the runway, not the hills below it
      o.position.set(p[0], (alt ? ground : Math.max(0, ctx.ground(p))) + alt, -p[1]);
      o.quaternion.copy(q1.setFromAxisAngle(Y, rot)).multiply(q2.setFromAxisAngle(X, -pitch));
      // Its shadow stays on the ground: it slides away from the sun, spreads and fades as the plane climbs.
      const off = alt * SHADOW_LEN;
      layOnGround(shadow, [p[0] + SHADOW_DIR[0] * off, p[1] + SHADOW_DIR[1] * off], rot, ctx, 0.5, 14);
      shadow.scale.setScalar(1 + alt / 250);
      shadow.material.opacity = 0.45 / (1 + alt / 70);
    },
  };
}

// ---------------------------------------------------------------------------
// Wind farm: 3 × 3 turbines, rotors facing the easterly trade winds, blades turning
// ---------------------------------------------------------------------------
async function buildWind({ center }, ctx) {
  const model = await loadModel('wind-turbine');
  const scene = new THREE.Scene();
  lights(scene);
  const SCALE = 6.5; // the model is 20 m tall; a modern turbine is about 130 m (here: hub 85 m, rotor 88 m across)
  // Rotor centre in model units: the point the three blade tips are equally far from (6.73 units). It is not the
  // middle of the blades' bounding box (0.02, 14.81, 1.09), which made the rotor swing round the nacelle.
  const HUB = new THREE.Vector3(0.005, 13.13, 1.03);
  const turbines = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      // Rows run north-south across the wind; 420 m apart (about 5.5 rotor widths), staggered.
      const e = i * 420, n = j * 420 + (i % 2 ? 210 : 0);
      const t = model.clone();
      const blades = t.getObjectByName('Windturbine_Blades_1');
      const pivot = new THREE.Group();
      pivot.position.copy(HUB);
      blades.parent.add(pivot);
      blades.position.sub(HUB);
      pivot.add(blades);
      t.scale.setScalar(SCALE);
      t.rotation.y = yaw(Math.PI / 2); // rotor (+Z side of the model) faces east
      t.traverse((x) => (x.frustumCulled = false));
      scene.add(t);
      turbines.push({ t, pivot, en: [e, n], phase: Math.random() * 6.28 });
    }
  }
  // Painted ground: a crane pad and foundation at each turbine, the service track that links them, and each
  // tower's shadow (the turning rotor only leaves a faint blur at the end of it).
  const hub = HUB.y * SCALE, tip = [SHADOW_DIR[0] * hub * SHADOW_LEN, SHADOW_DIR[1] * hub * SHADOW_LEN];
  const circle = ([e, n], r) => Array.from({ length: 20 }, (_, i) => [e + r * Math.cos((i / 20) * 6.2832), n + r * Math.sin((i / 20) * 6.2832)]);
  const ground = [];
  for (const i of [-1, 0, 1]) {
    const row = turbines.filter((w) => w.en[0] === i * 420).sort((a, b) => a.en[1] - b.en[1]);
    ground.push({ k: 'path', line: row.map((w) => [w.en[0] + 14, w.en[1]]), w: 5, c: '#cbbd9c', o: 0.9 });
  }
  ground.push({ k: 'path', line: [[-406, 210], [14, 0], [434, 210]], w: 5, c: '#cbbd9c', o: 0.9 }); // links the three rows
  for (const { en: [e, n] } of turbines) {
    ground.push({ k: 'pad', ring: rect(e + 6, n - 16, e + 50, n + 16), c: '#cbbd9c', o: 0.92 });
    ground.push({ k: 'pad', ring: circle([e, n], 10), c: '#b9b4a8', o: 0.95 });
    ground.push({ k: 'shadow', line: [[e, n], [e + tip[0], n + tip[1]]], w: 7, o: 0.5 });
    ground.push({ k: 'shadow', line: [[e + tip[0] * 0.85, n + tip[1] * 0.85], [e + tip[0] * 1.2, n + tip[1] * 1.2]], w: 50, o: 0.16 });
  }
  groundLayers(ctx, 'm3d-wind-ground', ground);
  return {
    scene,
    t0: 0,
    update(time) {
      for (const w of turbines) {
        w.t.position.set(w.en[0], ctx.ground(w.en), -w.en[1]);
        if (!ctx.reducedMotion) w.pivot.rotation.z = w.phase + time * 1.25; // about 12 turns a minute
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Solar: rows of panels facing south
// ---------------------------------------------------------------------------
async function buildSolar({ center }, ctx) {
  const model = await loadModel('solar-panel');
  const scene = new THREE.Scene();
  lights(scene);
  const P = placer(scene);
  const S = 0.0242; // the model is 165 units wide; one panel table here is 4 m wide
  const ROWS = 12, COLS = 30, ROW = 7, COL = 4.2;
  const spots = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) spots.push([(c - (COLS - 1) / 2) * COL, (r - (ROWS - 1) / 2) * ROW]);
  const mats = () => spots.map(([e, n]) => P.matrix(e, n, ctx.ground([e, n]) + 0.4, yaw(Math.PI) + SOLAR_TURN, S));
  // Each table is drawn as one flat card carrying a picture of the model's glass face (2 triangles instead
  // of the model's 1,854: 720 for the block instead of about 667,000). The picture is taken once, in a frame.
  const card = await ctx.inFrame((renderer) => panelCard(renderer, model));
  const cards = new THREE.InstancedMesh(card.geometry, card.material, spots.length);
  cards.frustumCulled = false;
  mats().forEach((m, i) => cards.setMatrixAt(i, m));
  scene.add(cards);
  // Painted ground: the cleared pad the block stands on, a track round it, and a line of shade behind each row.
  const HW = (COLS * COL) / 2, HN = ((ROWS - 1) * ROW) / 2;
  groundLayers(ctx, 'm3d-solar-ground', [
    { k: 'pad', ring: rect(-HW - 12, -HN - 12, HW + 12, HN + 12), c: '#a89b78', o: 0.6 },
    { k: 'path', line: [...rect(-HW - 7, -HN - 7, HW + 7, HN + 7), [-HW - 7, -HN - 7]], w: 3.5, c: '#c4b693', o: 0.8 },
    ...Array.from({ length: ROWS }, (_, r) => {
      const n = (r - (ROWS - 1) / 2) * ROW + 1.1 + SHADOW_DIR[1] * 0.9;
      return { k: 'shadow', line: [[-HW + SHADOW_DIR[0] * 0.9, n], [HW + SHADOW_DIR[0] * 0.9, n]], w: 2.4, o: 0.38 };
    }),
  ]);
  let last = -10;
  const born = performance.now();
  return {
    scene,
    t0: 0,
    // The site slopes: each table sits on the ground under it. Heights are read again for the first half
    // minute, while the terrain tiles arrive.
    update() {
      const time = (performance.now() - born) / 1000; // by the clock, so a frozen test time still settles
      if (time - last < 2 || time > 40) return;
      last = time;
      mats().forEach((m, i) => cards.setMatrixAt(i, m));
      cards.instanceMatrix.needsUpdate = true;
    },
    // Nothing here moves: frames are only needed while the ground heights settle.
    still: true,
  };
}
// A flat stand-in for the solar panel model: finds the model's glass face (the plane most of its upward
// faces lie in), photographs the model square-on to that face into a small texture, and returns a card of
// the same size and tilt. Must run inside a frame (ctx.inFrame), because it draws with the map's GL context.
function panelCard(renderer, model) {
  model.updateMatrixWorld(true);
  const tris = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position, ix = o.geometry.index;
    const v = (i) => new THREE.Vector3().fromBufferAttribute(p, ix ? ix.getX(i) : i).applyMatrix4(o.matrixWorld);
    for (let i = 0; i < (ix ? ix.count : p.count); i += 3) tris.push([v(i), v(i + 1), v(i + 2)]);
  });
  const normal = ([a, b, c]) => new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)); // length = 2 x area
  const up = tris.map(normal).filter((n) => n.y > 0).reduce((s, n) => s.add(n), new THREE.Vector3()).normalize();
  const ux = new THREE.Vector3().crossVectors(Y, up).normalize(), uy = new THREE.Vector3().crossVectors(up, ux);
  // The face: triangles lying in that plane. Their spread gives the card's size and height.
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  let top = -Infinity;
  for (const t of tris) {
    const n = normal(t);
    if (n.dot(up) < 0.97 * n.length()) continue;
    for (const p of t) {
      const u = p.dot(ux), w = p.dot(uy);
      lo[0] = Math.min(lo[0], u); hi[0] = Math.max(hi[0], u); lo[1] = Math.min(lo[1], w); hi[1] = Math.max(hi[1], w);
      top = Math.max(top, p.dot(up));
    }
  }
  const at = (u, w, h) => new THREE.Vector3().addScaledVector(ux, u).addScaledVector(uy, w).addScaledVector(up, h);
  const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], size = [hi[0] - lo[0], hi[1] - lo[1]];
  // The photograph: the model's own colours, unlit (the card is lit like any other surface afterwards).
  const shot = new THREE.Scene(), copy = model.clone();
  copy.traverse((o) => o.isMesh && (o.material = new THREE.MeshBasicMaterial({ map: o.material.map, color: o.material.color })));
  shot.add(copy);
  const cam = new THREE.OrthographicCamera(-size[0] / 2, size[0] / 2, size[1] / 2, -size[1] / 2, 0, size[0] * 4);
  cam.up.copy(uy);
  cam.position.copy(at(mid[0], mid[1], top + size[0]));
  cam.lookAt(at(mid[0], mid[1], top));
  const rt = new THREE.WebGLRenderTarget(256, 128, { colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x2a2e36, 1);
  renderer.clear();
  renderer.render(shot, cam);
  renderer.setRenderTarget(null);
  rt.texture.anisotropy = 4;
  const corners = [at(lo[0], lo[1], top), at(hi[0], lo[1], top), at(hi[0], hi[1], top), at(lo[0], hi[1], top)];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((c) => c.toArray()), 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(corners.flatMap(() => up.toArray()), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return { geometry, material: new THREE.MeshStandardMaterial({ map: rt.texture, metalness: 0.8, roughness: 0.3, side: THREE.DoubleSide }) };
}
const SOLAR_TURN = 0; // set from the test render if the model's front is not +Z

// ---------------------------------------------------------------------------
// Ship: sails in to the harbour, waits, swings round, sails out
// ---------------------------------------------------------------------------
async function buildShip({ dock, sea }, ctx) {
  const model = await loadModel('container-ship');
  const scene = new THREE.Scene();
  lights(scene);
  const SCALE = 1.4; // the model is 91 m long; a Caribbean container feeder is about 125-140 m
  const BOW = 1; // the model's bow points along +X
  const wrap = new THREE.Group();
  const ship = model.clone();
  ship.rotation.y = BOW > 0 ? -Math.PI / 2 : Math.PI / 2; // bow to +Z
  ship.scale.setScalar(SCALE);
  ship.position.y = -4.2 * SCALE; // waterline about 4 m up the model's hull
  ship.traverse((x) => (x.frustumCulled = false));
  wrap.add(ship);
  scene.add(wrap);
  // Its shadow on the water, on the side away from the sun (the hull's middle is 17 m ahead of the model's origin).
  const MID = 12.3 * SCALE, shadow = shadowMesh('blob', 34, 150, 0.42);
  scene.add(shadow);
  // Its wake: a pale trail behind the stern (33 m behind the model's origin), stronger the faster it goes.
  const STERN = 33.3 * SCALE, WAKE = 230, wake = shadowMesh('wake', 44, WAKE, 0, 0xe8f4f2);
  wake.position.set(0, 0.5, -(STERN + WAKE / 2 - 6));
  wrap.add(wake);
  const d = ctx.toLocal(dock), s = ctx.toLocal(sea);
  const len = Math.hypot(d[0] - s[0], d[1] - s[1]);
  const inDir = [(d[0] - s[0]) / len, (d[1] - s[1]) / len];
  const V = 7, DEC = 0.06; // m/s cruise, m/s² braking
  const brake = (V * V) / (2 * DEC), tBrake = V / DEC, tCruise = (len - brake) / V, run = tCruise + tBrake;
  const DOCK1 = 20, TURN = 40, DOCK2 = 10, GAP = 10;
  const cycle = run * 2 + DOCK1 + TURN + DOCK2 + GAP;
  // Distance from the sea point, t seconds into the arrival run.
  const inAt = (t) => (t < tCruise ? V * t : len - 0.5 * DEC * Math.max(0, tBrake - (t - tCruise)) ** 2);
  const hin = heading(inDir[0], inDir[1]);
  const speedIn = (t) => (t < tCruise ? V : DEC * Math.max(0, tBrake - (t - tCruise))); // m/s, t seconds into the arrival run
  return {
    scene,
    t0: run - 55, // start with the ship about 90 m off the berth and still moving, so the first look has it in frame
    update(time) {
      let t = ctx.reducedMotion ? run + 1 : time % cycle, x, h;
      let v = 0;
      if (t < run) [x, h, v] = [inAt(t), hin, speedIn(t)];
      else if ((t -= run) < DOCK1) [x, h] = [len, hin];
      else if ((t -= DOCK1) < TURN) [x, h] = [len, hin + Math.PI * smooth(t / TURN)];
      else if ((t -= TURN) < DOCK2) [x, h] = [len, hin + Math.PI];
      else if ((t -= DOCK2) < run) [x, h, v] = [inAt(run - t), hin + Math.PI, speedIn(run - t)];
      else {
        wrap.visible = shadow.visible = false;
        return;
      }
      wrap.visible = shadow.visible = true;
      const p = [s[0] + inDir[0] * x, s[1] + inDir[1] * x];
      wrap.position.set(p[0], 0, -p[1]); // sea level: the scene origin is at sea level for this place
      wrap.rotation.y = yaw(h);
      wake.material.opacity = 0.5 * Math.min(1, v / V) ** 0.7;
      wake.visible = v > 0.05;
      shadow.position.set(p[0] + Math.sin(h) * MID + SHADOW_DIR[0] * 7, 0.6, -(p[1] + Math.cos(h) * MID + SHADOW_DIR[1] * 7));
      shadow.rotation.y = yaw(h);
    },
  };
}

const BUILDERS = { rail: buildRail, airport: buildAirport, wind: buildWind, solar: buildSolar, ship: buildShip };

// ---------------------------------------------------------------------------
// The custom layer: renders each nearby place with its own origin.
// `places`: [{ type, center: [lng, lat], radius (degrees), seaLevel?, ...type options }]
// ---------------------------------------------------------------------------
export function addModels3D(map, { places, before, reducedMotion = false }) {
  const camera = new THREE.Camera();
  let renderer = null;
  // Work that draws with the map's GL context (taking a picture of a model, say) has to happen inside a
  // frame: builders hand it to ctx.inFrame and get the result back once prerender has run it.
  const jobs = [];
  const inFrame = (fn) => new Promise((resolve, reject) => {
    jobs.push(() => { try { resolve(fn(renderer)); } catch (e) { reject(e); } });
    map.triggerRepaint();
  });
  // A place that is still only needs a frame now and then (one timer at a time).
  let waiting = false;
  const frameIn = (ms) => {
    if (waiting) return;
    waiting = true;
    setTimeout(() => { waiting = false; map.triggerRepaint(); }, ms);
  };
  const t0 = performance.now();
  const sites = places.map((p) => {
    const f = frame(p.center);
    const site = { ...p, ...f, state: 'idle', elev0: 0 };
    site.ctx = {
      ...f,
      lat: p.center[1],
      map,
      inFrame,
      reducedMotion,
      // Ground height (m) at a local point, relative to this place's origin.
      ground: (en) => (map.queryTerrainElevation(f.toLngLat(en)) ?? 0) - site.elev0,
    };
    return site;
  });
  const isNear = (s, c) => Math.abs(c.lng - s.center[0]) < s.radius && Math.abs(c.lat - s.center[1]) < s.radius;
  const layer = {
    id: 'models-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      renderer.toneMapping = THREE.NeutralToneMapping; // bright whites roll off instead of clipping flat
    },
    // The sky map is drawn once into its own textures. MapLibre calls prerender before it starts the frame's
    // own drawing and puts its GL state back afterwards, which makes this the safe place to do it.
    prerender() {
      if (!renderer || (ENV && !jobs.length)) return;
      ENV ??= buildEnv(renderer);
      for (const job of jobs.splice(0)) job();
      renderer.resetState();
    },
    render(gl, args) {
      if (map.getZoom() < MIN_ZOOM) return;
      const c = map.getCenter();
      let moving = false, settling = false;
      for (const s of sites) {
        if (!isNear(s, c)) continue;
        if (s.state === 'idle') {
          // First time near this place: load its models (the next frames draw it once they arrive).
          s.state = 'loading';
          BUILDERS[s.type](s, s.ctx)
            .then((built) => Object.assign(s, built, { state: 'ready', readyAt: performance.now(), start: performance.now() - built.t0 * 1000 }))
            .catch((e) => ((s.state = 'failed'), console.warn(`3D models for ${s.type} not loaded:`, e)));
          continue;
        }
        if (s.state !== 'ready') continue;
        if (ENV && s.scene.environment !== ENV) {
          s.scene.environment = ENV;
          s.scene.environmentIntensity = SKY_LIGHT;
        }
        // Places on the water sit at sea level; the rest sit on the terrain under their origin.
        s.elev0 = s.seaLevel ? 0 : map.queryTerrainElevation(s.center) ?? 0;
        // window.__m3dT (seconds) is a test hook to freeze every animation at a given moment.
        s.update(window.__m3dT ?? (performance.now() - s.start) / 1000);
        const mm = map.transform.getMatrixForModel(s.center, s.elev0);
        camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(new THREE.Matrix4().fromArray(mm));
        renderer.resetState();
        renderer.render(s.scene, camera);
        // A place with moving parts needs every frame; a still one (or reduced motion) only a look now and
        // then for its first minute, while ground heights settle.
        if (!s.still && !reducedMotion) moving = true;
        else if (performance.now() - s.readyAt < 60000) settling = true;
      }
      if (moving) map.triggerRepaint();
      else if (settling || sites.some((s) => s.state === 'loading')) frameIn(400);
    },
  };
  window.__m3dSites = sites; // for tests and debugging
  map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
  // Credit the model makers in the map's attribution line (CC BY asks for it), via an empty source + layer.
  map.addSource('models-3d-credit', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    attribution: '3D models: 3DAssets.dev (CC0), Sketchfab artists (CC BY 4.0) · <a href="https://github.com/dvictor2/haiti-infrastructure-map/blob/main/ASSET_CREDITS.md" target="_blank" rel="noopener">credits</a>',
  });
  map.addLayer({ id: 'models-3d-credit', type: 'circle', source: 'models-3d-credit' });
  return layer;
}
