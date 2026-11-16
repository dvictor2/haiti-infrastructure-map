// Buildings drawn properly, up close (zoom 16 and closer, 3D on). Farther out the map keeps its plain blocks.
//
// What is drawn, for every building outline in data/buildings (the same outlines the blocks use):
//   small houses     four walls and a two-sided sloped roof with a small overhang
//   bigger buildings their real outline, a flat roof set just below the wall tops
//   walls            rows of windows, one row per floor, in a few quiet plaster and concrete tones
//   roofs            on the satellite background, each roof is painted with the satellite photo of that same roof
//                    (the tiles the map already shows); on the street map, a plain roof colour
//   shadows          real ones, from one sun (the same sun as models3d.js)
//
// What is NOT real: heights are estimates (see tools/build-buildings.mjs), windows are generic and wall colours are
// invented. It is a believable look for a screening-level map, not a survey.
//
// Never on trees: before a building is drawn, the photo under its roof is checked. Mostly leaves: the building is
// left out (the photo shows trees there). Mostly deep shade: it is drawn with a plain roof instead of the photo.
//
// How it follows the map: the country is cut into squares (zoom-16 tiles, about 580 m). The squares within reach
// of the map's centre are built one at a time while the map rests, and dropped when the map has moved away.
// Everything fades out toward the edge of reach, so there is no hard line where the drawn buildings stop.
//
// One MapLibre custom layer, one three.js scene in metres around an anchor point near the view:
//   scene axes  x = east, y = up, z = south   (MapLibre's getMatrixForModel convention)
import * as THREE from 'three';

const SUN = new THREE.Vector3(0.5, 1, 0.35).normalize(); // as in models3d.js
const CELL_Z = 16, TILE_Z = 14, PHOTO_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const MIN_AREA = 30; // m²: sheds and lean-tos stay as the photo shows them (a calmer town)
const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
const col = (list) => list.map((c) => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; });
// Quiet tones only: whites, creams and concrete greys.
const WALLS = col(['#f2ede3', '#f2ede3', '#ece5d6', '#e6dfd0', '#dcd7cc', '#d1ccc2', '#c6c1b7']);
const TIN = col(['#aeb1b4', '#aeb1b4', '#9fa4a9', '#b8b4ab', '#a08478']), SLAB = col(['#c9c5bc', '#c1bdb4', '#cfcbc2']);

// ---- reading the building tiles (vector tiles, just what is needed) ----------------------------------------------
function vint(p) { let v = 0, m = 1, b; do { b = p.buf[p.pos++]; v += (b & 0x7f) * m; m *= 128; } while (b >= 0x80); return v; }
function fields(buf, fn) {
  const p = { buf, pos: 0 };
  while (p.pos < buf.length) {
    const key = vint(p), f = Math.floor(key / 8), w = key & 7;
    if (w === 0) fn(f, vint(p));
    else if (w === 2) { const l = vint(p); fn(f, buf.subarray(p.pos, p.pos + l)); p.pos += l; }
    else if (w === 5) p.pos += 4; else if (w === 1) p.pos += 8; else return;
  }
}
const zz = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);
// → [{ ring: [[x, y] in tile units], h, m, x }] and the tile's extent
function readTile(buf) {
  const out = []; let extent = 4096;
  fields(buf, (f, layer) => {
    if (f !== 3) return;
    const keys = [], vals = [], feats = [];
    fields(layer, (g, v) => {
      if (g === 3) keys.push(new TextDecoder().decode(v)); else if (g === 5) extent = v; else if (g === 2) feats.push(v);
      else if (g === 4) { let val = null; fields(v, (a, b) => { val = b; }); vals.push(val); }
    });
    for (const fb of feats) {
      const F = { ring: null };
      fields(fb, (g, v) => {
        if (g === 2) { const p = { buf: v, pos: 0 }; while (p.pos < v.length) { const k = vint(p), x = vint(p); F[keys[k]] = vals[x]; } }
        else if (g === 4) {
          const p = { buf: v, pos: 0 }, ring = []; let x = 0, y = 0, rings = 0;
          while (p.pos < v.length) {
            const c = vint(p), cmd = c & 7, n = c >> 3;
            if (cmd === 7) continue;
            if (cmd === 1 && ++rings > 1) break; // the outer ring is enough
            for (let i = 0; i < n; i++) { x += zz(vint(p)); y += zz(vint(p)); ring.push([x, y]); }
          }
          F.ring = ring;
        }
      });
      if (F.ring && F.ring.length >= 3) out.push(F);
    }
  });
  return { feats: out, extent };
}

// ---- look --------------------------------------------------------------------------------------------------------
function facadeTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const x = i * 128, y = j * 128;
    g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(x, y + 120, 128, 8); // the floor slab's edge
    g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(x, y, 128, 3);
    const wx = x + 40, wy = y + 34, ww = 48, wh = 58;
    g.fillStyle = '#e9e6df'; g.fillRect(wx - 5, wy - 5, ww + 10, wh + 10); // frame
    g.fillStyle = (i + j) % 2 ? '#39424c' : '#2c343c'; g.fillRect(wx, wy, ww, wh); // glass
    g.fillStyle = 'rgba(150,180,205,0.45)'; g.fillRect(wx, wy, ww, 16); // sky in the glass
    g.fillStyle = '#e9e6df'; g.fillRect(wx + ww / 2 - 2, wy, 4, wh);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(wx - 7, wy + wh + 5, ww + 14, 5); // the sill's shadow
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(0.5, 0.5); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
// Smallest rectangle around a ring (tries each edge's direction); a = long axis, b = a turned a quarter left.
function obb(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L < 0.5) continue;
    const a = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], b = [-a[1], a[0]];
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const r of pts) { const u = r[0] * a[0] + r[1] * a[1], v = r[0] * b[0] + r[1] * b[1]; a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, a, b, la: (a1 - a0) / 2, lb: (b1 - b0) / 2, c: [(a[0] * (a0 + a1)) / 2 + (b[0] * (b0 + b1)) / 2, (a[1] * (a0 + a1)) / 2 + (b[1] * (b0 + b1)) / 2] };
  }
  if (best && best.lb > best.la) best = { ...best, a: best.b, b: [-best.a[0], -best.a[1]], la: best.lb, lb: best.la };
  return best;
}

// roofPhoto: false → the satellite photo is not used at all (no painted roofs, no tree check): every roof is plain.
export function addBuildings3D(map, { getTile, before, phone = false, roofPhoto = true }) {
  const REACH = phone ? 420 : 650, FROM = phone ? 16.2 : 16, PHOTO_Z = phone ? 17 : 18, MAX_CELLS = phone ? 6 : 12;
  const N16 = 2 ** CELL_Z, CELL_M0 = 40075016.686 / N16;
  const mode = { on: true, photo: true };
  const stats = { cells: 0, buildings: 0, onTrees: 0, plainRoofs: 0, triangles: 0 };
  // ---- scene ----
  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const fade = { uC: { value: new THREE.Vector2() }, uR: { value: REACH } };
  // Every material fades to nothing toward the edge of reach. A building fades as a whole, by the distance of its
  // own middle (aMid): fading each spot on its own left slivers of roof and wall standing at the edge, which showed
  // as stray pieces while the squares around them were still being built. The shadow sheet fades spot by spot.
  const fading = (m, whole = true) => { if (whole) m.defines = { ...m.defines, FADE_WHOLE: '' }; m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, fade);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp;\n#ifdef FADE_WHOLE\nattribute vec2 aMid;\n#endif').replace('#include <project_vertex>', '#include <project_vertex>\n#ifdef FADE_WHOLE\nvWp = (modelMatrix * vec4(aMid.x, 0.0, aMid.y, 1.0)).xyz;\n#else\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp; uniform vec2 uC; uniform float uR;').replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(uR * 0.78, uR, distance(vWp.xz, uC));');
  }; return m; };
  // (materials are flagged transparent so three.js draws them in renderOrder: the shadow sheet first, buildings over it)
  const wallMat = fading(new THREE.MeshLambertMaterial({ map: facadeTexture(), vertexColors: true, side: THREE.DoubleSide, transparent: true }));
  const plainMat = fading(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true }));
  const sheetMat = fading(new THREE.ShadowMaterial({ color: 0x0a0d18, opacity: 0.4, depthTest: false, depthWrite: false }), false);
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.6); sun.castShadow = true;
  const SPAN = REACH + 120, sc = sun.shadow.camera; sc.left = sc.bottom = -SPAN; sc.right = sc.top = SPAN; sc.near = 200; sc.far = 3200; sc.updateProjectionMatrix();
  sun.shadow.mapSize.set(phone ? 2048 : 4096, phone ? 2048 : 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.25; sun.shadow.radius = 2.5; sun.shadow.autoUpdate = false;
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xcfe0f5, 0x9c8f78, 0.95));
  let renderer = null, shadowDirty = true; const scratch = new THREE.WebGLRenderTarget(4, 4);

  // ---- where things are ----
  // The anchor: scene metres are measured from it. It is moved (and the squares re-placed) when the view has gone far.
  let anchor = null; // { lngLat, x, y (mercator), mPerUnit, elev }
  const setAnchor = (ll) => { const o = maplibregl.MercatorCoordinate.fromLngLat(ll); anchor = { lngLat: ll, x: o.x, y: o.y, mPerUnit: 1 / o.meterInMercatorCoordinateUnits(), elev: map.queryTerrainElevation(ll) ?? 0 }; };
  const place = (cell) => { cell.group.position.set((cell.ox - anchor.x) * anchor.mPerUnit, cell.elev - anchor.elev, (cell.oy - anchor.y) * anchor.mPerUnit); cell.group.updateMatrixWorld(true); };

  // ---- building tiles, read once each ----
  const tiles = new Map(); // "x/y" at zoom 14 → Promise<Map<cell key, features>>
  function tileCells(tx, ty) {
    const k = `${tx}/${ty}`;
    if (!tiles.has(k)) {
      if (tiles.size > 8) tiles.delete(tiles.keys().next().value);
      tiles.set(k, getTile(TILE_Z, tx, ty).then((buf) => {
        const cells = new Map(); if (!buf || !buf.length) return cells;
        const { feats, extent } = readTile(buf), n14 = 2 ** TILE_Z;
        for (const F of feats) {
          if (F.x || F.m) continue; // on a 3D model place, or a part that starts above the ground
          let cx = 0, cy = 0; const w = F.ring.map(([px, py]) => { const p = [(tx + px / extent) / n14, (ty + py / extent) / n14]; cx += p[0]; cy += p[1]; return p; });
          cx /= w.length; cy /= w.length;
          const ck = `${Math.floor(cx * N16)}/${Math.floor(cy * N16)}`;
          if (!cells.has(ck)) cells.set(ck, []);
          cells.get(ck).push({ w, cx, cy, h: (F.h ?? 31) / 10 });
        }
        return cells;
      }).catch(() => { tiles.delete(k); return new Map(); }));
    }
    return tiles.get(k);
  }
  // ---- the satellite photo over one square (with a margin of one photo tile all round) ----
  async function photoFor(cx, cy) {
    const s = 2 ** (PHOTO_Z - CELL_Z), x0 = cx * s - 1, y0 = cy * s - 1, n = s + 2;
    const c = document.createElement('canvas'); c.width = c.height = n * 256; const g = c.getContext('2d', { willReadFrequently: true });
    let ok = 0;
    await Promise.all([...Array(n * n)].map((_, k) => new Promise((done) => {
      const i = k % n, j = (k / n) | 0, im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { g.drawImage(im, i * 256, j * 256); ok++; done(); }; im.onerror = done;
      im.src = PHOTO_URL(PHOTO_Z, x0 + i, y0 + j);
    })));
    if (ok < n * n * 0.6) return null; // no photo to speak of: plain roofs
    const NP = 2 ** PHOTO_Z, px = (wx, wy) => [(wx * NP - x0) * 256, (wy * NP - y0) * 256];
    const data = g.getImageData(0, 0, c.width, c.height).data;
    // what the photo shows at a spot: 'leaf', 'dark' (deep shade) or 'roof'
    const kind = (wx, wy) => { const [x, y] = px(wx, wy), i = (Math.max(0, Math.min(c.height - 1, y | 0)) * c.width + Math.max(0, Math.min(c.width - 1, x | 0))) * 4, r = data[i], gr = data[i + 1], b = data[i + 2]; return gr > r + 6 && gr > b + 6 ? 'leaf' : r + gr + b < 165 ? 'dark' : 'roof'; };
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    return { tex, kind, uv: (wx, wy) => { const [x, y] = px(wx, wy); return [x / c.width, 1 - y / c.height]; } };
  }

  // ---- one square ----
  async function buildCell(cx, cy, old) {
    const feats = (await tileCells(cx >> 2, cy >> 2)).get(`${cx}/${cy}`) ?? [];
    const photo = old ? old.photo : feats.length && roofPhoto ? await photoFor(cx, cy).catch(() => null) : null;
    if (!settled()) return null; // the map moved on while the photo was loading: the ground may not be settled
    // the square's own frame: metres east/north of its middle
    const ox = (cx + 0.5) / N16, oy = (cy + 0.5) / N16, o = new maplibregl.MercatorCoordinate(ox, oy), mPerUnit = 1 / o.meterInMercatorCoordinateUnits(), oLL = o.toLngLat();
    const elev = map.queryTerrainElevation(oLL);
    if (elev == null) return null; // the ground is not loaded here yet: try again later
    const toLL = (e, n) => new maplibregl.MercatorCoordinate(ox + e / mPerUnit, oy - n / mPerUnit).toLngLat();
    const ground = (e, n) => (map.queryTerrainElevation(toLL(e, n)) ?? elev) - elev;
    const W = { p: [], n: [], uv: [], c: [], m: [] }, R = { p: [], n: [], uv: [], c: [], m: [] };
    let mid = [0, 0]; // the middle of the building being drawn (scene x, z), carried by each of its corners
    const V = (e, y, n) => [e, y, -n];
    const tri = (T, a, b, c, nrm, uvs, cols) => { T.p.push(...a, ...b, ...c); T.n.push(...nrm, ...nrm, ...nrm); T.uv.push(...uvs[0], ...uvs[1], ...uvs[2]); T.c.push(...cols[0], ...cols[1], ...cols[2]); T.m.push(...mid, ...mid, ...mid); };
    const quad = (T, a, b, c, d, nrm, uvs, cols) => { tri(T, a, b, c, nrm, [uvs[0], uvs[1], uvs[2]], [cols[0], cols[1], cols[2]]); tri(T, a, c, d, nrm, [uvs[0], uvs[2], uvs[3]], [cols[0], cols[2], cols[3]]); };
    const AO = 0.62, DEEP = 3, Z2 = [0, 0];
    const walls = (ring, gy, top, k) => {
      const floors = Math.max(1, Math.round(top / 3)), lo = k.map((v) => v * AO);
      ring.forEach((p, i) => {
        const q = ring[(i + 1) % ring.length], de = q[0] - p[0], dn = q[1] - p[1], L = Math.hypot(de, dn); if (L < 0.05) return;
        const bays = L < 2.4 ? 0 : Math.max(1, Math.round(L / 3.1)), nrm = [dn / L, 0, de / L];
        // below the ground (for slopes): plain and dark; above: windows, lighter upward (the dark of the street stays low)
        quad(W, V(p[0], gy - DEEP, p[1]), V(q[0], gy - DEEP, q[1]), V(q[0], gy, q[1]), V(p[0], gy, p[1]), nrm, [Z2, Z2, Z2, Z2], [lo, lo, lo, lo]);
        quad(W, V(p[0], gy, p[1]), V(q[0], gy, q[1]), V(q[0], gy + top, q[1]), V(p[0], gy + top, p[1]), nrm, [[0, 0], [bays, 0], [bays, floors], [0, floors]], [lo, lo, k, k]);
      });
    };
    let count = 0, onTrees = 0, plainRoofs = 0;
    for (const F of feats) {
      let ring = F.w.map(([wx, wy]) => [(wx - ox) * mPerUnit, (oy - wy) * mPerUnit]);
      if (Math.hypot(ring[0][0] - ring.at(-1)[0], ring[0][1] - ring.at(-1)[1]) < 0.01) ring.pop();
      if (ring.length < 3) continue;
      let A = 0, ce = 0, cn = 0; ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; A += p[0] * q[1] - q[0] * p[1]; ce += p[0]; cn += p[1]; }); A /= 2; ce /= ring.length; cn /= ring.length;
      if (Math.abs(A) < MIN_AREA) continue;
      if (A < 0) ring.reverse();
      // the photo under the roof, at nine spots: the middle, and part-way out to the corners
      let usePhoto = false;
      if (photo) {
        const wOf = (e, n) => [ox + e / mPerUnit, oy - n / mPerUnit], spots = [[ce, cn]];
        for (let k = 0; k < 8; k++) { const p = ring[Math.floor((k * ring.length) / 8)]; spots.push([ce + (p[0] - ce) * 0.6, cn + (p[1] - cn) * 0.6]); }
        const kinds = spots.map(([e, n]) => photo.kind(...wOf(e, n))), leaf = kinds.filter((k) => k === 'leaf').length, dark = kinds.filter((k) => k === 'dark').length;
        if (leaf >= 5) { onTrees++; continue; } // trees: no building is drawn here
        usePhoto = leaf + dark < 4;
      }
      if (!usePhoto) plainRoofs++;
      const r = hash(Math.round(F.cx * 4e7), Math.round(F.cy * 4e7)), r2 = hash(Math.round(F.cy * 4e7) + 3, Math.round(F.cx * 4e7));
      const wallC = WALLS[(r * WALLS.length) | 0], h = Math.max(2.6, F.h), gy = ground(ce, cn);
      const uvAt = (e, n) => (photo ? photo.uv(ox + e / mPerUnit, oy - n / mPerUnit) : Z2);
      // a roof corner carries the photo's place (uv) and a plain colour; a = 1 where the photo is used
      const box = h < 6 && Math.abs(A) < 150 ? obb(ring) : null;
      count++; mid = [ce, -cn];
      if (box && Math.abs(A) / box.area > 0.78 && box.lb > 1.5 && box.lb < 7 && r2 < 0.65) {
        // small house: four walls and a two-sided sloped roof with a small overhang
        const { a, b, la, lb, c } = box, P = (u, v) => [c[0] + a[0] * u + b[0] * v, c[1] + a[1] * u + b[1] * v];
        const rh = Math.min(2.2, Math.max(0.7, lb * 0.5)), eave = Math.max(2.3, h - rh), OV = 0.4, la2 = la + 0.3, lb2 = lb + OV, low = gy + eave - (rh * OV) / lb, yr = gy + eave + rh;
        walls([P(-la, -lb), P(la, -lb), P(la, lb), P(-la, lb)], gy, eave, wallC);
        for (const s of [1, -1]) { const g0 = P(s * la, -s * lb), g1 = P(s * la, s * lb), ap = P(s * la, 0); tri(W, V(g0[0], gy + eave, g0[1]), V(g1[0], gy + eave, g1[1]), V(ap[0], yr, ap[1]), [s * a[0], 0, -s * a[1]], [Z2, Z2, Z2], [wallC, wallC, wallC]); }
        const r0 = P(-la2, 0), r1 = P(la2, 0), k = TIN[(r2 * 1.5 * TIN.length) | 0] ?? TIN[0];
        for (const s of [1, -1]) {
          const e0 = P(-la2, s * lb2), e1 = P(la2, s * lb2), nl = Math.hypot(rh, lb), nrm = [(s * b[0] * rh) / nl, lb / nl, (-s * b[1] * rh) / nl];
          const pts = s > 0 ? [e1, e0, r0, r1] : [e0, e1, r1, r0], ys = [low, low, yr, yr];
          quad(R, ...pts.map((p, i) => V(p[0], ys[i], p[1])), nrm, pts.map((p) => (usePhoto ? uvAt(p[0], p[1]) : [-1, -1])), [k, k, k, k]);
        }
      } else {
        // bigger building: its real outline, a flat roof set a little below the wall tops (a parapet)
        walls(ring, gy, h, wallC);
        const k = SLAB[(r2 * SLAB.length) | 0], y = gy + h - 0.35;
        for (const t of THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p[0], p[1])), [])) {
          const [p, q, s] = t.map((i) => ring[i]);
          tri(R, V(p[0], y, p[1]), V(q[0], y, q[1]), V(s[0], y, s[1]), [0, 1, 0], [p, q, s].map((v) => (usePhoto ? uvAt(v[0], v[1]) : [-1, -1])), [k, k, k]);
        }
      }
    }
    const geo = (T) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(T.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(T.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(T.uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(T.c, 3)); g.setAttribute('aMid', new THREE.Float32BufferAttribute(T.m, 2)); return g; };
    const group = new THREE.Group(), meshes = [];
    if (count) {
      // Roofs: the photo where a corner has a place in it (uv ≥ 0), else that corner's plain colour.
      const roofMat = photo ? fading(new THREE.MeshLambertMaterial({ map: photo.tex, vertexColors: true, side: THREE.DoubleSide, transparent: true })) : plainMat;
      if (photo) { const base = roofMat.onBeforeCompile; roofMat.onBeforeCompile = (s) => { base(s); s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', '#ifdef USE_MAP\n if (vMapUv.x >= 0.0) diffuseColor.rgb = texture2D(map, vMapUv).rgb;\n#endif'); }; }
      const wall = new THREE.Mesh(geo(W), wallMat), roof = new THREE.Mesh(geo(R), roofMat);
      roof.userData = { photoMat: roofMat };
      // the ground that catches the shadows: an invisible sheet laid on the terrain
      const half = (CELL_M0 * Math.cos((oLL.lat * Math.PI) / 180)) / 2 + 30, G = 14, gp = new THREE.PlaneGeometry(half * 2, half * 2, G, G); gp.rotateX(-Math.PI / 2);
      const pos = gp.attributes.position; for (let i = 0; i < pos.count; i++) pos.setY(i, ground(pos.getX(i), -pos.getZ(i)) + 0.3);
      const sheet = new THREE.Mesh(gp, sheetMat); sheet.receiveShadow = true; sheet.renderOrder = 1;
      for (const m of [wall, roof]) { m.castShadow = m.receiveShadow = true; m.renderOrder = 2; }
      meshes.push(wall, roof, sheet);
      for (const m of meshes) { m.frustumCulled = false; group.add(m); }
    }
    return { key: `${cx}/${cy}`, cx, cy, ox, oy, oLL, elev, rebuilt: 0, group, meshes, roof: meshes[1], photo, count, onTrees, plainRoofs, triangles: (W.p.length + R.p.length) / 9 };
  }
  const dropCell = (cell, keepPhoto) => { scene.remove(cell.group); for (const m of cell.meshes) { m.geometry.dispose(); if (m.userData.photoMat && m.userData.photoMat !== plainMat) m.userData.photoMat.dispose(); } if (!keepPhoto) cell.photo?.tex.dispose(); };

  // ---- is the ground settled? ----
  // Ground heights are only to be trusted once the map has stopped, has asked for the terrain tiles of the new view
  // (it does that while drawing a frame, not when it stops) and has them. Read any earlier, MapLibre answers from a
  // coarser tile, or with 0 where it has none yet: buildings built on such a reading stand metres too low, and only
  // slivers of their roofs show through the ground until the square is built again.
  let stirred = 0, frames = 0; // when the view last changed or tiles were still coming; frames drawn since
  const stir = () => { stirred = performance.now(); frames = 0; };
  map.on('move', stir); map.on('terrain', stir);
  const settled = () => {
    if (map.isMoving() || !map.areTilesLoaded()) { stir(); return false; }
    if (frames < 3) { map.triggerRepaint(); return false; }
    return performance.now() - stirred > 250;
  };

  // ---- which squares, and when ----
  const cells = new Map(), failed = new Map(); let busy = false, timer = 0;
  const later = (ms) => { if (!timer) timer = setTimeout(() => { timer = 0; refresh(); }, ms); };
  const tally = () => { stats.cells = cells.size; stats.buildings = stats.onTrees = stats.plainRoofs = stats.triangles = 0; for (const c of cells.values()) { stats.buildings += c.count; stats.onTrees += c.onTrees; stats.plainRoofs += c.plainRoofs; stats.triangles += c.triangles; } };
  const applyMode = (cell) => { if (cell.roof) cell.roof.material = mode.photo ? cell.roof.userData.photoMat : plainMat; };
  async function refresh() {
    if (busy || !renderer || !mode.on || map.getZoom() < FROM) return;
    // Only while the ground is settled (see above).
    // (Not map.loaded(): the animated route lines keep the style busy long after the tiles are in.)
    if (!settled()) { later(300); return; }
    const c = map.getCenter(), m = maplibregl.MercatorCoordinate.fromLngLat(c), cellM = CELL_M0 * Math.cos((c.lat * Math.PI) / 180), fx = m.x * N16, fy = m.y * N16;
    if (!anchor || Math.hypot(m.x - anchor.x, m.y - anchor.y) * anchor.mPerUnit > 1200) { setAnchor([c.lng, c.lat]); for (const cell of cells.values()) place(cell); shadowDirty = true; }
    // squares the circle of reach touches, nearest first
    const want = [], span = Math.ceil(REACH / cellM) + 1;
    for (let i = -span; i <= span; i++) for (let j = -span; j <= span; j++) {
      const x = Math.floor(fx) + i, y = Math.floor(fy) + j, dx = Math.max(x - fx, 0, fx - x - 1), dy = Math.max(y - fy, 0, fy - y - 1);
      if (Math.hypot(dx, dy) * cellM < REACH) want.push({ x, y, d: Math.hypot(x + 0.5 - fx, y + 0.5 - fy) });
    }
    want.sort((a, b) => a.d - b.d); want.length = Math.min(want.length, MAX_CELLS);
    // drop the squares the view has left well behind
    for (const [k, cell] of cells) if (Math.hypot(cell.cx + 0.5 - fx, cell.cy + 0.5 - fy) * cellM > REACH + cellM * (cells.size > MAX_CELLS ? 0.9 : 1.6)) { dropCell(cell); cells.delete(k); shadowDirty = true; }
    // Every square keeps to the ground the map now draws. A small change (on steep ground the reading wobbles a
    // little with the view) just moves the square up or down; a real one (finer terrain arrived) has it built
    // again, keeping its photo, at most three times per square.
    let stale = null;
    for (const cell of cells.values()) {
      const e = map.queryTerrainElevation(cell.oLL), d = e == null ? 0 : Math.abs(e - cell.elev);
      if (d > 2.5 && cell.rebuilt < 3) stale = stale ?? cell;
      else if (d > 0.3) { cell.elev = e; place(cell); shadowDirty = true; map.triggerRepaint(); }
    }
    const next = stale ? { x: stale.cx, y: stale.cy } : want.find((w) => !cells.has(`${w.x}/${w.y}`) && (failed.get(`${w.x}/${w.y}`) ?? 0) < performance.now());
    if (!next) { tally(); if (cells.size) later(1500); return; } // (keeps an eye on the ground: 'idle' may never come while route lines animate)
    busy = true;
    try {
      const cell = await buildCell(next.x, next.y, stale);
      if (cell && stale) { cell.rebuilt = stale.rebuilt + 1; dropCell(stale, true); }
      if (cell) { cells.set(cell.key, cell); place(cell); applyMode(cell); scene.add(cell.group); shadowDirty = true; }
      else failed.set(`${next.x}/${next.y}`, performance.now() + 1500);
    } catch (e) { console.warn('3D buildings: a square was not built:', e); failed.set(`${next.x}/${next.y}`, performance.now() + 30000); }
    busy = false; tally();
    map.triggerRepaint();
    later(40); // the next square, after the map has had a frame
  }
  map.on('moveend', refresh); map.on('idle', refresh);

  const layer = {
    id: 'buildings-3d', type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.toneMapping = THREE.NoToneMapping;
      refresh();
    },
    // The shadow picture is drawn into its own texture before the map starts the frame (MapLibre puts its GL state
    // back after prerender). It is redrawn only when squares come or go, or the view has moved a good way.
    prerender() {
      frames++;
      if (!renderer || !anchor || !cells.size || !mode.on || map.getZoom() < FROM) return;
      const c = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter()), e = (c.x - anchor.x) * anchor.mPerUnit, s = (c.y - anchor.y) * anchor.mPerUnit;
      if (Math.hypot(e - sun.target.position.x, s - sun.target.position.z) > 90) shadowDirty = true;
      // the anchor's own ground height follows the live terrain
      const ae = map.queryTerrainElevation(anchor.lngLat);
      if (ae != null && Math.abs(ae - anchor.elev) > 0.05) { anchor.elev = ae; for (const cell of cells.values()) place(cell); shadowDirty = true; }
      if (!shadowDirty) return;
      shadowDirty = false;
      sun.target.position.set(e, 0, s); sun.position.copy(SUN).multiplyScalar(1600).add(sun.target.position); sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
      sun.shadow.needsUpdate = true;
      renderer.setRenderTarget(scratch); renderer.render(scene, camera); renderer.setRenderTarget(null); renderer.resetState();
    },
    render(gl, args) {
      if (!anchor || !cells.size || !mode.on || map.getZoom() < FROM) return;
      const c = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
      fade.uC.value.set((c.x - anchor.x) * anchor.mPerUnit, (c.y - anchor.y) * anchor.mPerUnit);
      const mm = map.transform.getMatrixForModel(anchor.lngLat, anchor.elev);
      camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(new THREE.Matrix4().fromArray(mm));
      renderer.resetState(); renderer.render(scene, camera);
    },
  };
  map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
  // The blocks' own layer (and with it the buildings' credit) is switched off up close, so the credit is carried
  // here too, via an empty source + layer (as models3d.js does for the model makers).
  map.addSource('buildings-3d-credit', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: map.getSource('bld')?.attribution ?? 'Buildings © OpenStreetMap, Overture Maps Foundation, Google, Microsoft' });
  map.addLayer({ id: 'buildings-3d-credit', type: 'circle', source: 'buildings-3d-credit' });
  return {
    from: FROM, stats,
    debug: { scene, cells, sun, fade, get renderer() { return renderer; }, get anchor() { return anchor; } }, // for tests
    // on: 3D is on; photo: the satellite background is showing (else roofs take their plain colour)
    setMode(next) { Object.assign(mode, next); for (const cell of cells.values()) applyMode(cell); if (mode.on) refresh(); map.triggerRepaint(); },
  };
}
