// Elevation lookups from Mapzen Terrarium tiles (AWS Open Data), with a disk cache.
// Ocean cells are below 0 m because the tiles include bathymetry.
import { inflateSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const CACHE = new URL('./.cache/', import.meta.url);
mkdirSync(CACHE, { recursive: true });

// Minimal PNG decoder for 8-bit RGB / RGBA, non-interlaced (what Terrarium tiles are).
function decodePng(buf) {
  let pos = 8;
  let width, height, colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  const elev = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) elev[i] = out[i * bpp] * 256 + out[i * bpp + 1] + out[i * bpp + 2] / 256 - 32768;
  return elev;
}

export function createDem(Z = 12) {
const tiles = new Map();
async function tile(x, y) {
  const key = `${Z}-${x}-${y}`;
  if (tiles.has(key)) return tiles.get(key);
  const file = new URL(`${key}.png`, CACHE);
  let buf;
  if (existsSync(file)) buf = readFileSync(file);
  else {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`);
    if (!res.ok) throw new Error(`tile ${key}: ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, buf);
  }
  const e = decodePng(buf);
  tiles.set(key, e);
  return e;
}

function tileXY(lon, lat) {
  const n = 2 ** Z;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n];
}

// Preload every tile a set of points touches (with a margin), so later lookups are synchronous.
async function preload(points, marginKm = 8) {
  const need = new Set();
  const m = marginKm / 111;
  for (const [lon, lat] of points) {
    for (const [dx, dy] of [[0, 0], [-m, -m], [m, m], [-m, m], [m, -m]]) {
      const [fx, fy] = tileXY(lon + dx, lat + dy);
      need.add(`${Math.floor(fx)},${Math.floor(fy)}`);
    }
  }
  const list = [...need].map((s) => s.split(',').map(Number));
  for (let i = 0; i < list.length; i += 16) await Promise.all(list.slice(i, i + 16).map(([x, y]) => tile(x, y)));
  return list.length;
}

function elevation(lon, lat) {
  const [fx, fy] = tileXY(lon, lat);
  const tx = Math.floor(fx), ty = Math.floor(fy);
  const e = tiles.get(`${Z}-${tx}-${ty}`);
  if (!e) return NaN;
  const px = Math.min(255, Math.floor((fx - tx) * 256)), py = Math.min(255, Math.floor((fy - ty) * 256));
  return e[py * 256 + px];
}

return { Z, preload, elevation, tileXY };
}

const rad = (d) => (d * Math.PI) / 180;
const fine = createDem(12);
export const Z = 12;
export const { preload, elevation, tileXY } = fine;
