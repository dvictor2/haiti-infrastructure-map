// A small PMTiles (version 3) reader and writer with no dependencies. Used by build-buildings.mjs.
// Format: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
import zlib from 'node:zlib';
export async function range(url, off, len, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
      if (r.status !== 206) throw new Error('status ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i >= tries) throw e; await new Promise((s) => setTimeout(s, 500 * (i + 1))); }
  }
}
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
export function parseHeader(b) {
  if (b.toString('latin1', 0, 7) !== 'PMTiles' || b[7] !== 3) throw new Error('not pmtiles v3');
  return { rootOff: u64(b, 8), rootLen: u64(b, 16), metaOff: u64(b, 24), metaLen: u64(b, 32), leafOff: u64(b, 40), leafLen: u64(b, 48), dataOff: u64(b, 56), dataLen: u64(b, 64),
    nAddr: u64(b, 72), nEntries: u64(b, 80), nContents: u64(b, 88), clustered: b[96], internalComp: b[97], tileComp: b[98], tileType: b[99], minZoom: b[100], maxZoom: b[101],
    bounds: [b.readInt32LE(102) / 1e7, b.readInt32LE(106) / 1e7, b.readInt32LE(110) / 1e7, b.readInt32LE(114) / 1e7] };
}
function readVarint(p) { let v = 0, m = 1, b; do { b = p.buf[p.pos++]; v += (b & 0x7f) * m; m *= 128; } while (b >= 0x80); return v; }
export function parseDir(raw, comp) {
  const buf = comp === 2 ? zlib.gunzipSync(raw) : raw; const p = { buf, pos: 0 }; const n = readVarint(p); const e = [];
  let id = 0; for (let i = 0; i < n; i++) { id += readVarint(p); e.push({ id, run: 0, len: 0, off: 0 }); }
  for (let i = 0; i < n; i++) e[i].run = readVarint(p);
  for (let i = 0; i < n; i++) e[i].len = readVarint(p);
  for (let i = 0; i < n; i++) { const v = readVarint(p); e[i].off = v === 0 && i > 0 ? e[i - 1].off + e[i - 1].len : v - 1; }
  return e;
}
function rotate(n, xy, rx, ry) { if (ry === 0) { if (rx === 1) { xy[0] = n - 1 - xy[0]; xy[1] = n - 1 - xy[1]; } const t = xy[0]; xy[0] = xy[1]; xy[1] = t; } }
export function tileId(z, x, y) {
  let acc = 0; for (let i = 0; i < z; i++) acc += 4 ** i;
  const n = 2 ** z; let d = 0; const xy = [x, y]; let s = n / 2;
  while (s >= 1) { const rx = (xy[0] & s) > 0 ? 1 : 0, ry = (xy[1] & s) > 0 ? 1 : 0; d += s * s * ((3 * rx) ^ ry); rotate(s, xy, rx, ry); s = s / 2; }
  return acc + d;
}
export class Reader {
  constructor(url) { this.url = url; this.dirs = new Map(); }
  async init() { const b = await range(this.url, 0, 16384); this.h = parseHeader(b); this.root = parseDir(b.subarray(this.h.rootOff, this.h.rootOff + this.h.rootLen), this.h.internalComp); return this; }
  static find(e, id) { let lo = 0, hi = e.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (e[m].id > id) hi = m - 1; else if (e[m].id < id) lo = m + 1; else return e[m]; }
    if (hi >= 0) { const c = e[hi]; if (c.run === 0 || id - c.id < c.run) return c; } return null; }
  async entry(id) {
    let dir = this.root;
    for (let depth = 0; depth < 4; depth++) {
      const e = Reader.find(dir, id); if (!e) return null; if (e.run > 0) return e;
      const k = e.off; if (!this.dirs.has(k)) this.dirs.set(k, range(this.url, this.h.leafOff + e.off, e.len).then((b) => parseDir(b, this.h.internalComp)));
      dir = await this.dirs.get(k);
    }
    return null;
  }
  async tile(e) { return range(this.url, this.h.dataOff + e.off, e.len); }
}
function varint(out, v) { while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); } out.push(v); }
export function serializeDir(entries) {
  const o = []; varint(o, entries.length); let last = 0;
  for (const e of entries) { varint(o, e.id - last); last = e.id; }
  for (const e of entries) varint(o, e.run);
  for (const e of entries) varint(o, e.len);
  entries.forEach((e, i) => varint(o, i > 0 && e.off === entries[i - 1].off + entries[i - 1].len ? 0 : e.off + 1));
  return zlib.gzipSync(Buffer.from(o), { level: 9 });
}
// tiles: [{id, data(Buffer, already tile-compressed)}], sorted by id.
export function buildArchive(tiles, { minZoom, maxZoom, bounds, tileComp = 2, metadata = {} }) {
  let off = 0; const entries = tiles.map((t) => { const e = { id: t.id, run: 1, len: t.data.length, off }; off += t.data.length; return e; });
  const dataLen = off; let root, leaves = Buffer.alloc(0);
  root = serializeDir(entries);
  if (root.length > 16384 - 127) {
    for (let per = 4096; ; per *= 2) {
      const parts = [], rootE = []; let lo = 0;
      for (let i = 0; i < entries.length; i += per) { const s = serializeDir(entries.slice(i, i + per)); rootE.push({ id: entries[i].id, run: 0, len: s.length, off: lo }); lo += s.length; parts.push(s); }
      root = serializeDir(rootE); leaves = Buffer.concat(parts); if (root.length <= 16384 - 127) break;
    }
  }
  const meta = zlib.gzipSync(Buffer.from(JSON.stringify(metadata)));
  const h = Buffer.alloc(127); h.write('PMTiles', 0, 'latin1'); h[7] = 3;
  const w = (o, v) => h.writeBigUInt64LE(BigInt(v), o);
  const rootOff = 127, metaOff = rootOff + root.length, leafOff = metaOff + meta.length, dataOff = leafOff + leaves.length;
  w(8, rootOff); w(16, root.length); w(24, metaOff); w(32, meta.length); w(40, leafOff); w(48, leaves.length); w(56, dataOff); w(64, dataLen);
  w(72, tiles.length); w(80, tiles.length); w(88, tiles.length);
  h[96] = 1; h[97] = 2; h[98] = tileComp; h[99] = 1; h[100] = minZoom; h[101] = maxZoom;
  const d = (v) => Math.round(v * 1e7); h.writeInt32LE(d(bounds[0]), 102); h.writeInt32LE(d(bounds[1]), 106); h.writeInt32LE(d(bounds[2]), 110); h.writeInt32LE(d(bounds[3]), 114);
  h[118] = maxZoom; h.writeInt32LE(d((bounds[0] + bounds[2]) / 2), 119); h.writeInt32LE(d((bounds[1] + bounds[3]) / 2), 123);
  return Buffer.concat([h, root, meta, leaves, ...tiles.map((t) => t.data)]);
}
