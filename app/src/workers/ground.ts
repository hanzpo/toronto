// Vector ground for level-0 tiles (docs/SPEC.md, "Vector ground").
//
// The pipeline (pipeline/tpipe/ground.py) ships the land cover as a planar
// partition of hole-free polygons plus water levels and typed shorelines. Here
// every polygon is clipped to the terrain grid (per cell, then per cell
// triangle) and triangulated, so each output triangle lies inside a single
// terrain triangle: the drawn ground is exactly the surface that roads,
// buildings and agents are placed on (TerrainSampler), with sub-metre polygon
// edges instead of the 4 m raster. Water is drawn flat at its own level (rivers
// follow a level field), and shores get banks: dockwalls, armour-stone
// revetments, beaches or natural earth banks. Everything is one mesh / one
// draw per tile; the per-vertex `gd` attribute (class, a, b, c) drives the
// material (render/tiles/groundMaterial.ts):
//   land     (class, 0, 0, 0)
//   pitches  (class, u, v, hl·4·1024 + hw·4)   frame-local metres + frame size
//   water    (1, shore distance m, nearest shore type, kind 0 lake · 1 pond · 2 river)
//   banks    (30 + type-1, along m, height above water m, 0)
//   portals  (34 wall · 35 floor · 36 mouth · 37 headwall, along m, height m, 0)
import earcut from 'earcut';
import type { TypedArray } from '../data/tbn';
import type { MeshBuf, TerrainSampler } from './meshing';

export const G_WATER = 1;
export const BANK_BASE = 30; // 30 dockwall · 31 revetment · 32 beach · 33 natural bank
export const PORTAL_WALL = 34, PORTAL_FLOOR = 35, PORTAL_MOUTH = 36, PORTAL_HEAD = 37, PORTAL_RAIL = 38, EMB_GRASS = 39;
const FRAMED = new Set([19, 24, 25, 26]);
const LAKE_LEVELS = [-0.3, 99.2];

// ------------------------------------------------------------------ builder

class GB {
  pos = new Float32Array(3 * 8192);
  nrm = new Int8Array(4 * 8192);
  gd = new Float32Array(4 * 8192);
  idx = new Uint32Array(3 * 8192);
  nv = 0;
  ni = 0;
  private growV(n: number) {
    if (this.nv + n <= this.pos.length / 3) return;
    const cap = Math.max((this.pos.length / 3) * 2, this.nv + n);
    const p = new Float32Array(cap * 3); p.set(this.pos); this.pos = p;
    const q = new Int8Array(cap * 4); q.set(this.nrm); this.nrm = q;
    const g = new Float32Array(cap * 4); g.set(this.gd); this.gd = g;
  }
  private growI(n: number) {
    if (this.ni + n <= this.idx.length) return;
    const q = new Uint32Array(Math.max(this.idx.length * 2, this.ni + n)); q.set(this.idx); this.idx = q;
  }
  /** vertex at tile-local E, N, elevation y (three axes: x = e, z = -n) */
  v(e: number, n: number, y: number, nx: number, ny: number, nz: number, c: number, a: number, b: number, d: number): number {
    this.growV(1);
    const i = this.nv++;
    this.pos[i * 3] = e; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = -n;
    this.nrm[i * 4] = Math.round(nx * 127); this.nrm[i * 4 + 1] = Math.round(ny * 127); this.nrm[i * 4 + 2] = Math.round(nz * 127);
    this.gd[i * 4] = c; this.gd[i * 4 + 1] = a; this.gd[i * 4 + 2] = b; this.gd[i * 4 + 3] = d;
    return i;
  }
  t(a: number, b: number, c: number) {
    this.growI(3);
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  finish(): MeshBuf | null {
    if (!this.ni) return null;
    const index = this.nv < 65536 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    return {
      position: this.pos.slice(0, this.nv * 3), normal: this.nrm.slice(0, this.nv * 4), index,
      attrs: { gd: { array: this.gd.slice(0, this.nv * 4), size: 4 } },
    };
  }
}

// ------------------------------------------------------------------ clipping

/** Sutherland–Hodgman: keep the part of polygon `src` (n points, flat xy) where a·x + b·y + c ≥ 0. */
function clipHalf(src: Float64Array, n: number, a: number, b: number, c: number, dst: Float64Array): number {
  if (n < 3) return 0;
  let m = 0;
  let px = src[2 * n - 2], py = src[2 * n - 1];
  let pd = a * px + b * py + c;
  for (let k = 0; k < n; k++) {
    const x = src[2 * k], y = src[2 * k + 1];
    const d = a * x + b * y + c;
    if (d >= 0) {
      if (pd < 0) { const t = pd / (pd - d); dst[m++] = px + (x - px) * t; dst[m++] = py + (y - py) * t; }
      dst[m++] = x; dst[m++] = y;
    } else if (pd >= 0) {
      const t = pd / (pd - d); dst[m++] = px + (x - px) * t; dst[m++] = py + (y - py) * t;
    }
    px = x; py = y; pd = d;
  }
  return m / 2;
}

function area2(p: Float64Array, n: number): number {
  let s = 0;
  for (let k = 0, j = n - 1; k < n; j = k++) s += (p[2 * j] * p[2 * k + 1] - p[2 * k] * p[2 * j + 1]);
  return s;
}

let scratch: Float64Array[] = [];
function buf(k: number, n: number): Float64Array {
  if (!scratch[k] || scratch[k].length < n) scratch[k] = new Float64Array(Math.max(n, 256) * 2);
  return scratch[k];
}

interface Surface {
  /** height + normal at tile-local e, n */
  at(e: number, n: number, out: Float64Array): void;
}

/**
 * Clip one polygon ring (flat local E/N) to grid cells of size `cell` and emit
 * triangles so none crosses a cell edge or the cell's SW→NE diagonal.
 */
function emitPolygon(b: GB, ring: Float64Array, n: number, S: number, cell: number, surf: Surface,
  attr: (e: number, nn: number, out: Float64Array) => void) {
  const G1 = Math.round(S / cell);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const x = ring[2 * k], y = ring[2 * k + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const i0 = Math.max(0, Math.floor(x0 / cell)), i1 = Math.min(G1 - 1, Math.ceil(x1 / cell) - 1);
  const j0 = Math.max(0, Math.floor(y0 / cell)), j1 = Math.min(G1 - 1, Math.ceil(y1 / cell) - 1);
  const hn = new Float64Array(4), ga = new Float64Array(4);
  // shared grid-corner vertices for full cells of this polygon
  const corner = new Map<number, number>();
  const vert = (e: number, nn: number) => {
    surf.at(e, nn, hn);
    ga[3] = 0;
    attr(e, nn, ga);
    return b.v(e, nn, hn[0], hn[1], hn[2], hn[3], ga[0], ga[1], ga[2], ga[3]);
  };
  const cornerV = (i: number, j: number) => {
    const key = j * 4096 + i;
    let v = corner.get(key);
    if (v === undefined) { v = vert(i * cell, j * cell); corner.set(key, v); }
    return v;
  };
  const full = cell * cell * 2; // area2 of a full cell
  const tri = new Float64Array(6);
  for (let j = j0; j <= j1; j++) {
    const sb = buf(0, n * 2 + 8), s1 = buf(1, n * 2 + 8);
    let m = clipHalf(ring, n, 0, 1, -j * cell, s1);
    m = clipHalf(s1, m, 0, -1, (j + 1) * cell, sb);
    if (m < 3) continue;
    for (let i = i0; i <= i1; i++) {
      const c1 = buf(2, m * 2 + 8), cc = buf(3, m * 2 + 8);
      let q = clipHalf(sb, m, 1, 0, -i * cell, c1);
      q = clipHalf(c1, q, -1, 0, (i + 1) * cell, cc);
      if (q < 3) continue;
      const A = area2(cc, q);
      if (Math.abs(A) < 1e-6) continue;
      if (Math.abs(A - full) < full * 1e-5) {
        const sw = cornerV(i, j), se = cornerV(i + 1, j), ne = cornerV(i + 1, j + 1), nw = cornerV(i, j + 1);
        b.t(sw, se, ne); b.t(sw, ne, nw);
        continue;
      }
      // split along the SW→NE diagonal: x − y + (y0 − x0) ≥ 0 is the SE half
      const cx = i * cell, cy = j * cell;
      for (const sgn of [1, -1]) {
        const h = buf(4, q * 2 + 8);
        const k = clipHalf(cc, q, sgn, -sgn, sgn * (cy - cx), h);
        if (k < 3) continue;
        const Ah = area2(h, k);
        if (Math.abs(Ah) < 1e-6) continue;
        if (Math.abs(Ah - full / 2) < full * 1e-5) {
          if (sgn > 0) b.t(cornerV(i, j), cornerV(i + 1, j), cornerV(i + 1, j + 1));
          else b.t(cornerV(i, j), cornerV(i + 1, j + 1), cornerV(i, j + 1));
          continue;
        }
        const flat = Array.from(h.subarray(0, 2 * k));
        const ids = earcut(flat, undefined, 2);
        if (!ids.length) continue;
        const base: number[] = new Array(k);
        for (let t = 0; t < k; t++) base[t] = vert(flat[2 * t], flat[2 * t + 1]);
        for (let t = 0; t < ids.length; t += 3) {
          const a = ids[t], bb = ids[t + 1], c = ids[t + 2];
          tri[0] = flat[2 * a]; tri[1] = flat[2 * a + 1]; tri[2] = flat[2 * bb]; tri[3] = flat[2 * bb + 1]; tri[4] = flat[2 * c]; tri[5] = flat[2 * c + 1];
          const s = area2(tri, 3);
          if (Math.abs(s) < 1e-7) continue;
          if (s > 0) b.t(base[a], base[bb], base[c]); else b.t(base[a], base[c], base[bb]);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ shores

interface Shores {
  n: number;
  /** segment endpoints (local) and type */
  ax: Float64Array; ay: Float64Array; bx: Float64Array; by: Float64Array; type: Uint8Array;
  bins: Map<number, number[]>;
}
const BIN = 32;

function shoreIndex(a: Record<string, TypedArray>, S: number): Shores | null {
  const off = a.sh_off as Uint32Array | undefined;
  if (!off || off.length < 2) return null;
  const xy = a.sh_xy as Uint16Array, typ = a.sh_type as Uint8Array;
  const q = S / 65535;
  let n = 0;
  for (let r = 0; r + 1 < off.length; r++) n += Math.max(0, off[r + 1] - off[r] - 1);
  const s: Shores = { n, ax: new Float64Array(n), ay: new Float64Array(n), bx: new Float64Array(n), by: new Float64Array(n), type: new Uint8Array(n), bins: new Map() };
  let k = 0;
  for (let r = 0; r + 1 < off.length; r++) {
    for (let v = off[r]; v + 1 < off[r + 1]; v++, k++) {
      s.ax[k] = xy[2 * v] * q; s.ay[k] = xy[2 * v + 1] * q; s.bx[k] = xy[2 * v + 2] * q; s.by[k] = xy[2 * v + 3] * q; s.type[k] = typ[r];
      const bx0 = Math.floor((Math.min(s.ax[k], s.bx[k]) - BIN) / BIN), bx1 = Math.floor((Math.max(s.ax[k], s.bx[k]) + BIN) / BIN);
      const by0 = Math.floor((Math.min(s.ay[k], s.by[k]) - BIN) / BIN), by1 = Math.floor((Math.max(s.ay[k], s.by[k]) + BIN) / BIN);
      for (let bj = by0; bj <= by1; bj++) for (let bi = bx0; bi <= bx1; bi++) {
        const key = bj * 1000 + bi;
        let l = s.bins.get(key);
        if (!l) s.bins.set(key, (l = []));
        l.push(k);
      }
    }
  }
  return s;
}

/** distance (m, ≤ 32) to the nearest shore segment and its type */
function shoreDist(s: Shores | null, x: number, y: number, out: Float64Array) {
  out[0] = 32; out[1] = 0;
  if (!s) return;
  const l = s.bins.get(Math.floor(y / BIN) * 1000 + Math.floor(x / BIN));
  if (!l) return;
  let best = 32 * 32, bt = 0;
  for (const k of l) {
    const ex = s.bx[k] - s.ax[k], ey = s.by[k] - s.ay[k];
    const L = ex * ex + ey * ey;
    let t = L > 0 ? ((x - s.ax[k]) * ex + (y - s.ay[k]) * ey) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = s.ax[k] + ex * t - x, dy = s.ay[k] + ey * t - y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bt = s.type[k]; }
  }
  out[0] = Math.sqrt(best); out[1] = bt;
}

// ------------------------------------------------------------------ main

function hash(x: number, y: number) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** bank profile per shore type: horizontal run per metre of drop, max run, bottom below water */
const BANK: Record<number, { slope: number; cap: number; below: number }> = {
  1: { slope: 0.03, cap: 0.15, below: 1.2 }, // dockwall: vertical concrete
  2: { slope: 1.4, cap: 4.5, below: 1.0 }, // revetment: armour stone
  3: { slope: 6.0, cap: 7.0, below: 0.5 }, // beach: sand running under the water
  4: { slope: 1.0, cap: 3.0, below: 0.8 }, // natural earth bank
};

export function buildGround(a: Record<string, TypedArray>, terr: TerrainSampler, raster?: Uint8Array): MeshBuf | null {
  const off = a.gp_off as Uint32Array | undefined;
  if (!off || off.length < 2) return null;
  const S = terr.S, G = terr.G, c = terr.cell, H = terr.h;
  const xy = a.gp_xy as Uint16Array, cls = a.gp_class as Uint8Array;
  const q = S / 65535;
  const b = new GB();

  // grid normals (as buildTerrain) for smooth shading, bilinearly interpolated
  const gn = new Float32Array(G * G * 3);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const hl = H[j * G + Math.max(i - 1, 0)], hr = H[j * G + Math.min(i + 1, G - 1)];
    const hd = H[Math.max(j - 1, 0) * G + i], hu = H[Math.min(j + 1, G - 1) * G + i];
    const dx = (hr - hl) / (c * ((i > 0 && i < G - 1) ? 2 : 1));
    const dn = (hu - hd) / (c * ((j > 0 && j < G - 1) ? 2 : 1));
    const inv = 1 / Math.hypot(dx, 1, dn);
    gn[(j * G + i) * 3] = -dx * inv; gn[(j * G + i) * 3 + 1] = inv; gn[(j * G + i) * 3 + 2] = dn * inv;
  }
  const land: Surface = {
    at(e, n, o) {
      o[0] = terr.at(e, n);
      let fx = e / c, fy = n / c;
      fx = Math.min(Math.max(fx, 0), G - 1.0001); fy = Math.min(Math.max(fy, 0), G - 1.0001);
      const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      let nx = 0, ny = 0, nz = 0;
      for (const [di, dj, w] of [[0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)], [0, 1, (1 - u) * v], [1, 1, u * v]] as const) {
        const k = ((j + dj) * G + i + di) * 3;
        nx += gn[k] * w; ny += gn[k + 1] * w; nz += gn[k + 2] * w;
      }
      const L = Math.hypot(nx, ny, nz) || 1;
      o[1] = nx / L; o[2] = ny / L; o[3] = nz / L;
    },
  };

  // water levels
  const wLevel = new Map<number, number>();
  const wp = a.gw_poly as Uint32Array | undefined, wl = a.gw_level as Int16Array | undefined;
  if (wp && wl) for (let k = 0; k < wp.length; k++) wLevel.set(wp[k], wl[k]);
  const field = a.gw_field as Int16Array | undefined;
  const fieldAt = (e: number, n: number) => {
    if (!field) return 0;
    const fc = S / 32;
    let fx = e / fc, fy = n / fc;
    fx = Math.min(Math.max(fx, 0), 31.9999); fy = Math.min(Math.max(fy, 0), 31.9999);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const f = (ii: number, jj: number) => field[jj * 33 + ii] / 10;
    return (f(i, j) * (1 - u) + f(i + 1, j) * u) * (1 - v) + (f(i, j + 1) * (1 - u) + f(i + 1, j + 1) * u) * v;
  };
  const shores = shoreIndex(a, S);

  // frames
  const frames = new Map<number, number>();
  const fp = a.gf_poly as Uint32Array | undefined, gf = a.gf as Float32Array | undefined;
  if (fp && gf) for (let k = 0; k < fp.length; k++) frames.set(fp[k], k);

  let ringBuf = new Float64Array(2048);
  const sd = new Float64Array(2);
  for (let p = 0; p + 1 < off.length; p++) {
    const n = off[p + 1] - off[p];
    if (n < 3) continue;
    if (ringBuf.length < 2 * n) ringBuf = new Float64Array(4 * n);
    for (let k = 0; k < n; k++) { ringBuf[2 * k] = xy[2 * (off[p] + k)] * q; ringBuf[2 * k + 1] = xy[2 * (off[p] + k) + 1] * q; }
    const k0 = cls[p];
    if (k0 === G_WATER) {
      const lv = wLevel.get(p);
      const flat = lv !== undefined && lv !== -32768;
      const level = flat ? lv / 10 : 0;
      const kind = !flat ? 2 : LAKE_LEVELS.some((x) => Math.abs(x - level) < 0.05) ? 0 : 1;
      const surf: Surface = { at(e, nn, o) { o[0] = flat ? level : fieldAt(e, nn); o[1] = 0; o[2] = 1; o[3] = 0; } };
      emitPolygon(b, ringBuf, n, S, 32, surf, (e, nn, o) => {
        shoreDist(shores, e, nn, sd);
        o[0] = G_WATER; o[1] = sd[0]; o[2] = sd[1]; o[3] = kind;
      });
      continue;
    }
    const fk = FRAMED.has(k0) ? frames.get(p) : undefined;
    if (fk !== undefined && gf) {
      const cx = gf[fk * 5], cy = gf[fk * 5 + 1], ang = gf[fk * 5 + 2], hl = gf[fk * 5 + 3], hw = gf[fk * 5 + 4];
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const pack = Math.min(1023, Math.round(hl * 4)) * 1024 + Math.min(1023, Math.round(hw * 4));
      emitPolygon(b, ringBuf, n, S, c, land, (e, nn, o) => {
        const dx = e - cx, dy = nn - cy;
        o[0] = k0; o[1] = dx * ca + dy * sa; o[2] = -dx * sa + dy * ca; o[3] = pack;
      });
      continue;
    }
    emitPolygon(b, ringBuf, n, S, c, land, (_e, _n, o) => { o[0] = k0; o[1] = 0; o[2] = 0; });
  }
  banks(b, a, terr, S);
  const cuts = cutData(a, S);
  if (cuts) portals(b, cuts, terr);
  if (raster) {
    embankments(b, a.r_off as Uint32Array, a.r_xyz as Float32Array, a.r_flags as Uint8Array, a.r_class as Uint8Array, a.r_width as Float32Array, terr, raster, false);
    embankments(b, a.l_off as Uint32Array, a.l_xyz as Float32Array, a.l_flags as Uint8Array, a.l_class as Uint8Array, null, terr, raster, true);
  }
  skirts(b, terr);
  return b.finish();
}

// ------------------------------------------------------------------ open cuts / tunnel portals

/** Cut polygons + the track runs inside them (tile-local), shared with the main thread for heightAt. */
export interface CutBuf {
  /** ring vertex offsets, flat local E/N, per-edge type (0 wall · 1 portal · 2 open) */
  off: Uint32Array; xy: Float32Array; type: Uint8Array;
  /** track runs: offsets, flat local E/N/z (rail level, datum m), rail kind (0 rail · 1 subway · 2 LRT · 3 tram) */
  toff: Uint32Array; txyz: Float32Array; tkind: Uint8Array;
  /** bbox per ring (minE, minN, maxE, maxN) */
  box: Float32Array;
}

const MOUTH_H = [7.0, 5.0, 5.6, 5.6];
const BALLAST = 0.25; // floor (ballast top) below the rail level

export function cutData(a: Record<string, TypedArray>, S: number): CutBuf | null {
  const off = a.pc_off as Uint32Array | undefined, toff = a.pt_off as Uint32Array | undefined;
  if (!off || off.length < 2 || !toff || toff.length < 2) return null;
  const q = S / 65535, xy16 = a.pc_xy as Uint16Array;
  const xy = new Float32Array(xy16.length);
  for (let k = 0; k < xy16.length; k++) xy[k] = xy16[k] * q;
  const box = new Float32Array((off.length - 1) * 4);
  for (let r = 0; r + 1 < off.length; r++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let v = off[r]; v < off[r + 1]; v++) {
      x0 = Math.min(x0, xy[2 * v]); x1 = Math.max(x1, xy[2 * v]); y0 = Math.min(y0, xy[2 * v + 1]); y1 = Math.max(y1, xy[2 * v + 1]);
    }
    box.set([x0, y0, x1, y1], r * 4);
  }
  return {
    off: off.slice(), xy, type: (a.pc_type as Uint8Array).slice(),
    toff: toff.slice(), txyz: (a.pt_xyz as Float32Array).slice(), tkind: (a.pt_kind as Uint8Array).slice(), box,
  };
}

const _near = { z: 0, kind: 0, d: 0, tx: 1, ty: 0 };
/** rail level (datum m) and kind of the nearest track point to local (x, y) */
function nearestTrack(c: CutBuf, x: number, y: number) {
  let best = Infinity;
  for (let r = 0; r + 1 < c.toff.length; r++) {
    for (let v = c.toff[r]; v + 1 < c.toff[r + 1]; v++) {
      const ax = c.txyz[3 * v], ay = c.txyz[3 * v + 1], bx = c.txyz[3 * v + 3], by = c.txyz[3 * v + 4];
      const ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey;
      let t = L > 0 ? ((x - ax) * ex + (y - ay) * ey) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = ax + ex * t - x, dy = ay + ey * t - y, d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        _near.z = c.txyz[3 * v + 2] + (c.txyz[3 * v + 5] - c.txyz[3 * v + 2]) * t;
        _near.kind = c.tkind[r];
        const l = Math.sqrt(L) || 1;
        _near.tx = ex / l; _near.ty = ey / l;
      }
    }
  }
  _near.d = Math.sqrt(best);
  return _near;
}

function inRing(c: CutBuf, r: number, x: number, y: number): boolean {
  let inside = false;
  for (let v = c.off[r], w = c.off[r + 1] - 1; v < c.off[r + 1]; w = v++) {
    const xi = c.xy[2 * v], yi = c.xy[2 * v + 1], xj = c.xy[2 * w], yj = c.xy[2 * w + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Floor of an open cut at tile-local (x, y) — the rail level trains run on — or NaN outside every cut. */
export function cutFloor(c: CutBuf, x: number, y: number): number {
  for (let r = 0; r + 1 < c.off.length; r++) {
    const b = c.box;
    if (x < b[r * 4] || y < b[r * 4 + 1] || x > b[r * 4 + 2] || y > b[r * 4 + 3]) continue;
    if (inRing(c, r, x, y)) return nearestTrack(c, x, y).z;
  }
  return NaN;
}

function portals(b: GB, c: CutBuf, terr: TerrainSampler) {
  const floorAt = (x: number, y: number) => nearestTrack(c, x, y).z - BALLAST;
  // floor
  for (let r = 0; r + 1 < c.off.length; r++) {
    const n = c.off[r + 1] - c.off[r];
    if (n < 3) continue;
    const flat = Array.from(c.xy.subarray(2 * c.off[r], 2 * c.off[r + 1]));
    const ids = earcut(flat, undefined, 2);
    const base: number[] = [];
    for (let k = 0; k < n; k++) base.push(b.v(flat[2 * k], flat[2 * k + 1], floorAt(flat[2 * k], flat[2 * k + 1]), 0, 1, 0, PORTAL_FLOOR, 0, 0, 0));
    for (let t = 0; t < ids.length; t += 3) {
      const i0 = ids[t], i1 = ids[t + 1], i2 = ids[t + 2];
      const s = (flat[2 * i1] - flat[2 * i0]) * (flat[2 * i2 + 1] - flat[2 * i0 + 1]) - (flat[2 * i2] - flat[2 * i0]) * (flat[2 * i1 + 1] - flat[2 * i0 + 1]);
      if (s >= 0) b.t(base[i0], base[i1], base[i2]); else b.t(base[i0], base[i2], base[i1]);
    }
  }
  // walls, headwalls, mouths (faces toward the cut interior = left of the CCW ring)
  const quad = (x0: number, y0: number, x1: number, y1: number, b0: number, t0: number, b1: number, t1: number, cls: number, along: number, len: number) => {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L; // interior side
    const v0 = b.v(x0, y0, b0, nx, 0, -ny, cls, along, b0, 0), v1 = b.v(x1, y1, b1, nx, 0, -ny, cls, along + len, b1, 0);
    const v2 = b.v(x1, y1, t1, nx, 0, -ny, cls, along + len, t1, 0), v3 = b.v(x0, y0, t0, nx, 0, -ny, cls, along, t0, 0);
    b.t(v0, v2, v1); b.t(v0, v3, v2);
  };
  const COPING = 0.45;
  for (let r = 0; r + 1 < c.off.length; r++) {
    const o = c.off[r], n = c.off[r + 1] - o;
    let along = 0;
    for (let k = 0; k < n; k++) {
      const typ = c.type[o + k];
      const ax = c.xy[2 * (o + k)], ay = c.xy[2 * (o + k) + 1];
      const bx = c.xy[2 * (o + (k + 1) % n)], by = c.xy[2 * (o + (k + 1) % n) + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (typ === 2 || L < 1e-3) { along += L; continue; }
      const steps = Math.max(1, Math.ceil(L / 4));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps;
        const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
        const f0 = floorAt(x0, y0), f1 = floorAt(x1, y1);
        const g0 = terr.at(x0, y0), g1 = terr.at(x1, y1);
        const top0 = Math.max(g0, f0) + COPING, top1 = Math.max(g1, f1) + COPING;
        const seg = L / steps;
        if (typ === 1) {
          const h = MOUTH_H[nearestTrack(c, (x0 + x1) / 2, (y0 + y1) / 2).kind] ?? 5.5;
          const m0 = Math.min(f0 + BALLAST + h, top0), m1 = Math.min(f1 + BALLAST + h, top1);
          quad(x0, y0, x1, y1, f0 - 0.1, m0, f1 - 0.1, m1, PORTAL_MOUTH, along, seg);
          quad(x0, y0, x1, y1, m0, top0 + 0.4, m1, top1 + 0.4, PORTAL_HEAD, along, seg);
        } else {
          quad(x0, y0, x1, y1, f0 - 0.1, top0, f1 - 0.1, top1, PORTAL_WALL, along, seg);
          // outer face of the parapet (seen from the street), leaning onto the ground
          quad(x1, y1, x0, y0, g1 - 0.2, top1, g0 - 0.2, top0, PORTAL_WALL, along + seg, -seg);
        }
        along += seg;
      }
    }
  }
  // rails on the floor (the street layer skips tunnel-tagged track)
  for (let r = 0; r + 1 < c.toff.length; r++) {
    const g = c.tkind[r] === 3 ? 0.7475 : 0.7175;
    for (const side of [-g, g]) {
      let prev: number[] | null = null;
      const v0 = c.toff[r], v1 = c.toff[r + 1] - 1;
      for (let v = v0; v <= v1; v = v < v1 && v + 3 > v1 ? v1 : v + 3) {
        const x = c.txyz[3 * v], y = c.txyz[3 * v + 1], z = c.txyz[3 * v + 2];
        const w = Math.min(v + 1, c.toff[r + 1] - 1), u = Math.max(v - 1, c.toff[r]);
        const dx = c.txyz[3 * w] - c.txyz[3 * u], dy = c.txyz[3 * w + 1] - c.txyz[3 * u + 1], L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L, ny = dx / L;
        const cx = x + nx * side, cy = y + ny * side;
        const ids = [
          b.v(cx - nx * 0.036, cy - ny * 0.036, z - BALLAST, 0, 1, 0, PORTAL_RAIL, 0, 0, 0),
          b.v(cx - nx * 0.036, cy - ny * 0.036, z, 0, 1, 0, PORTAL_RAIL, 0, 0, 0),
          b.v(cx + nx * 0.036, cy + ny * 0.036, z, 0, 1, 0, PORTAL_RAIL, 0, 0, 0),
          b.v(cx + nx * 0.036, cy + ny * 0.036, z - BALLAST, 0, 1, 0, PORTAL_RAIL, 0, 0, 0),
        ];
        if (prev) for (let k = 0; k < 3; k++) {
          // outward-facing sides + top (strip runs along the track; both sides are seen)
          b.t(prev[k], ids[k], ids[k + 1]); b.t(prev[k], ids[k + 1], prev[k + 1]);
        }
        prev = ids;
        if (v === v1) break;
      }
    }
  }
}

/** Banks along typed shores: from the land edge down below the water, leaning into the water. */
function banks(b: GB, a: Record<string, TypedArray>, terr: TerrainSampler, S: number) {
  const off = a.sh_off as Uint32Array | undefined;
  if (!off || off.length < 2) return;
  const xy = a.sh_xy as Uint16Array, zz = a.sh_z as Int16Array, typ = a.sh_type as Uint8Array;
  const q = S / 65535;
  for (let r = 0; r + 1 < off.length; r++) {
    const t = typ[r], prof = BANK[t];
    if (!prof) continue;
    const v0 = off[r], n = off[r + 1] - v0;
    if (n < 2) continue;
    const X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
    for (let k = 0; k < n; k++) { X[k] = xy[2 * (v0 + k)] * q; Y[k] = xy[2 * (v0 + k) + 1] * q; Z[k] = zz[v0 + k] / 10; }
    // water is on the left of the direction of travel
    const NX = new Float64Array(n), NY = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let nx = 0, ny = 0;
      for (const s of [k - 1, k]) {
        if (s < 0 || s + 1 >= n) continue;
        const dx = X[s + 1] - X[s], dy = Y[s + 1] - Y[s], L = Math.hypot(dx, dy) || 1;
        nx += -dy / L; ny += dx / L;
      }
      const L = Math.hypot(nx, ny) || 1;
      NX[k] = nx / L; NY[k] = ny / L;
    }
    const rows = t === 2 ? 3 : 2; // revetments get a jittered middle row (rocks)
    const cls = BANK_BASE + t - 1;
    let along = 0;
    let prev: number[] | null = null;
    for (let k = 0; k < n; k++) {
      if (k > 0) along += Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]);
      const top = terr.at(X[k], Y[k]);
      const bot = Z[k] - prof.below;
      const drop = Math.max(0.2, top - bot);
      const run = Math.min(prof.cap, drop * prof.slope);
      const ids: number[] = [];
      for (let rr = 0; rr < rows; rr++) {
        const f = rr / (rows - 1);
        let h = top + (bot - top) * f, o = run * f;
        if (rows === 3 && rr === 1) {
          const j = hash(X[k] * 1.7, Y[k] * 1.3);
          o += (j - 0.5) * 1.2;
          h += (hash(Y[k], X[k]) - 0.5) * 0.6;
        }
        // outward (toward water, up) normal of the bank face
        const nl = Math.hypot(drop, run) || 1;
        const nh = drop / nl, nv = Math.max(run / nl, 0.05);
        ids.push(b.v(X[k] + NX[k] * o, Y[k] + NY[k] * o, h, NX[k] * nh, nv, -NY[k] * nh, cls, along, h - Z[k], 0));
      }
      if (prev) {
        for (let rr = 0; rr + 1 < rows; rr++) {
          // facing the water (left side): winding so the face points along +normal
          b.t(prev[rr], ids[rr + 1], prev[rr + 1]);
          b.t(prev[rr], ids[rr], ids[rr + 1]);
        }
      }
      prev = ids;
    }
  }
}

/** 12 m skirts under the tile edges (hide cracks against coarser neighbours), both windings */
function skirts(b: GB, terr: TerrainSampler) {
  const G = terr.G, c = terr.cell, H = terr.h, drop = 12;
  const edges: [number, number][][] = [[], [], [], []];
  for (let k = 0; k < G; k++) {
    edges[0].push([k, 0]); edges[1].push([k, G - 1]); edges[2].push([0, k]); edges[3].push([G - 1, k]);
  }
  for (const ed of edges) {
    let pt = -1, pb = -1;
    for (const [i, j] of ed) {
      const y = H[j * G + i];
      const t = b.v(i * c, j * c, y, 0, 1, 0, 0, 0, 0, 0);
      const bo = b.v(i * c, j * c, y - drop, 0, 1, 0, 0, 0, 0, 0);
      if (pt >= 0) { b.t(pt, bo, pb); b.t(pt, t, bo); b.t(pt, pb, bo); b.t(pt, bo, t); }
      pt = t; pb = bo;
    }
  }
}

// ------------------------------------------------------------------ embankments

/** fill under a deck from this clearance up (m); beyond EMB_MAX the bridge stands on an abutment */
const EMB_MIN = 0.5, EMB_MAX = 5.5;
const EMB_TOP = 0.35; // fill top below the deck surface

/**
 * Earth embankments under low bridge decks: where a bridge's deck (the z the
 * road / rail mesher draws it at) is less than EMB_MAX above the ground, the
 * approach is a grass-sloped fill (1:2 roads, 1:1.5 rail) up to the deck; the
 * fill ends at a concrete abutment where the span starts. Never over water.
 */
function embankments(b: GB, off: Uint32Array | undefined, xyz: Float32Array | undefined, flags: Uint8Array | undefined,
  cls: Uint8Array | undefined, width: Float32Array | null, terr: TerrainSampler, raster: Uint8Array, rail: boolean) {
  if (!off || !xyz || !flags || off.length < 2) return;
  const S = terr.S;
  const water = (x: number, y: number) => {
    const i = Math.min(255, Math.max(0, Math.floor((x / S) * 256))), j = Math.min(255, Math.max(0, Math.floor((y / S) * 256)));
    return raster[j * 256 + i] === G_WATER;
  };
  for (let w = 0; w + 1 < off.length; w++) {
    if (!(flags[w] & 2) || (flags[w] & 4)) continue;
    const c = cls ? cls[w] : 0;
    if (!rail && c > 5) continue; // footbridges / service: no fill
    if (rail && c > 3) continue;
    const hw = rail ? 2.6 : Math.max(3, (width ? width[w] : 8) / 2 + 0.6);
    const slope = rail ? 1.5 : 2.0;
    // densified samples inside the tile
    const P: number[] = [];
    for (let v = off[w]; v + 1 < off[w + 1]; v++) {
      const x0 = xyz[3 * v], y0 = xyz[3 * v + 1], z0 = xyz[3 * v + 2], x1 = xyz[3 * v + 3], y1 = xyz[3 * v + 4], z1 = xyz[3 * v + 5];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
      for (let k = v === off[w] ? 0 : 1; k <= n; k++) {
        const t = k / n;
        P.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t);
      }
    }
    const n = P.length / 3;
    if (n < 2) continue;
    let prev: number[] | null = null;
    let prevOn = false;
    for (let k = 0; k < n; k++) {
      const x = P[3 * k], y = P[3 * k + 1], z = P[3 * k + 2];
      const inside = x >= -1 && y >= -1 && x <= S + 1 && y <= S + 1;
      const kk = Math.min(k + 1, n - 1), kp = Math.max(k - 1, 0);
      let tx = P[3 * kk] - P[3 * kp], ty = P[3 * kk + 1] - P[3 * kp + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const nx = -ty, ny = tx;
      const g = terr.at(x, y);
      const top = z - EMB_TOP;
      const clr = top - g;
      const on = inside && clr > EMB_MIN - EMB_TOP && clr < EMB_MAX && !water(x, y);
      if (!on) {
        // abutment where a fill meets the open span
        if (prevOn && prev && inside && clr >= EMB_MAX) abut(b, prev);
        prev = null; prevOn = false;
        continue;
      }
      // cross-section: toeL, topL, topR, toeR (toe where the 1:slope face meets the ground, 2 iterations)
      const ids: number[] = [];
      const pts: [number, number, number][] = [];
      for (const sd of [1, -1]) {
        let run = hw + clr * slope, gz = g;
        for (let it = 0; it < 2; it++) {
          gz = terr.at(x + nx * sd * run, y + ny * sd * run);
          run = hw + Math.max(0, top - gz) * slope;
        }
        const tox = x + nx * sd * run, toy = y + ny * sd * run;
        const toe: [number, number, number] = [tox, toy, terr.at(tox, toy) - 0.15];
        const tp: [number, number, number] = [x + nx * sd * hw, y + ny * sd * hw, top];
        if (sd === 1) { pts.push(toe, tp); } else { pts.push(tp, toe); }
      }
      // normals: left face leans +n, right face -n
      const L = Math.hypot(1, slope);
      const nh = 1 / L, nv = slope / L;
      ids.push(b.v(pts[0][0], pts[0][1], pts[0][2], nx * nh, nv, -ny * nh, EMB_GRASS, 0, 0, 0));
      ids.push(b.v(pts[1][0], pts[1][1], pts[1][2], nx * nh, nv, -ny * nh, EMB_GRASS, 0, 0, 0));
      ids.push(b.v(pts[2][0], pts[2][1], pts[2][2], -nx * nh, nv, ny * nh, EMB_GRASS, 0, 0, 0));
      ids.push(b.v(pts[3][0], pts[3][1], pts[3][2], -nx * nh, nv, ny * nh, EMB_GRASS, 0, 0, 0));
      ids.push(b.v(pts[1][0], pts[1][1], pts[1][2], 0, 1, 0, rail ? PORTAL_FLOOR : EMB_GRASS, 0, 0, 0));
      ids.push(b.v(pts[2][0], pts[2][1], pts[2][2], 0, 1, 0, rail ? PORTAL_FLOOR : EMB_GRASS, 0, 0, 0));
      if (prev) {
        // travel direction t, left = +n: faces toeL→topL (left slope), topL→topR (top), topR→toeR (right slope)
        const quads: [number, number][] = [[0, 1], [4, 5], [2, 3]];
        for (const [p0, p1] of quads) {
          b.t(prev[p0], ids[p1], ids[p0]);
          b.t(prev[p0], prev[p1], ids[p1]);
        }
      } else if (k > 0) {
        // fill starts after an open span: abutment facing back along the road
        abut(b, ids, true);
      }
      prev = ids; prevOn = true;
    }
  }
}

/** vertical concrete end face of a fill (cross-section ids: toeL, topL, topR, toeR, ...) */
function abut(b: GB, ids: number[], back = false) {
  const P = (i: number) => [b.pos[3 * i], -b.pos[3 * i + 2], b.pos[3 * i + 1]]; // E, N, elevation
  const [tl, ptl, ptr, tr] = [P(ids[0]), P(ids[1]), P(ids[2]), P(ids[3])];
  const lo = Math.min(tl[2], tr[2]) - 0.3;
  const q = [
    b.v(ptl[0], ptl[1], lo, 0, 0, 0, PORTAL_HEAD, 0, 0, 0), b.v(ptl[0], ptl[1], ptl[2] + 0.3, 0, 0, 0, PORTAL_HEAD, 0, 0, 0),
    b.v(ptr[0], ptr[1], ptr[2] + 0.3, 0, 0, 0, PORTAL_HEAD, 0, 0, 0), b.v(ptr[0], ptr[1], lo, 0, 0, 0, PORTAL_HEAD, 0, 0, 0),
  ];
  // both windings (cheap, and the face is seen from the span side)
  b.t(q[0], q[1], q[2]); b.t(q[0], q[2], q[3]); b.t(q[0], q[2], q[1]); b.t(q[0], q[3], q[2]);
  void back; void tl; void tr;
}
