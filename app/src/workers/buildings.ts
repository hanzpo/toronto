// Extruded buildings (tile worker): walls, roofs and the facade attributes the
// facade shader (render/tiles/facadeMaterial.ts) turns into windows, storefronts,
// lobbies, loading doors and cornices. Geometry stays low-poly — the only extra
// geometry is shop awnings and plaza canopies on street-facing storefront walls.
//
// Per-vertex attributes (besides position / normal / colour):
//   fac   vec4  u (m along the wall), h (m above the building base), L (wall length m), H (wall top above base m)
//   fcode vec2  code = style + 16·front + 64·seed(0..255), unit width (m) of the shop / lobby rhythm
// front: 0 plain · 1 storefront band · 2 office lobby · 3 loading doors
import earcut from 'earcut';
import type { TypedArray } from '../data/tbn';
import type { MeshBuf } from './meshing';

// facade styles (must match facadeMaterial.ts STYLE table)
export const ST = {
  BRICK: 0, STONE: 1, GLASS: 2, CONDO: 3, PRECAST: 4, RIBBON: 5, STUCCO: 6, METAL: 7,
  PARKING: 8, LOFT: 9, BLANK: 10, HOUSE: 11, MODERN: 12, ROOF: 13, CANOPY: 14, AWNING: 15,
} as const;
const F_NONE = 0, F_SHOP = 1, F_LOBBY = 2, F_DOCK = 3;

// --------------------------------------------------------------------------- helpers

function hash32(x: number): number {
  let h = (x * 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return h >>> 0;
}
function rnd(a: number, b = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const pick = <T>(arr: readonly T[], r: number): T => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

function shade(rgb: number, f: number): [number, number, number] {
  return [
    Math.min(255, Math.round(((rgb >> 16) & 255) * f)),
    Math.min(255, Math.round(((rgb >> 8) & 255) * f)),
    Math.min(255, Math.round((rgb & 255) * f)),
  ];
}

function tame(rgb: number): number {
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  const k = 0.55;
  const f = (c: number) => Math.round(Math.min(255, (l + (c - l) * k) * 0.92 + 14));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

function ringArea(xy: ArrayLike<number>, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) {
    const j = i + 1 < b ? i + 1 : a;
    s += xy[i * 2] * xy[j * 2 + 1] - xy[j * 2] * xy[i * 2 + 1];
  }
  return s / 2;
}

interface OBB { cx: number; cy: number; ux: number; uy: number; L: number; W: number }

/** min-area oriented rectangle using ring edge directions; u = long axis */
function obb(xy: ArrayLike<number>, a: number, b: number): OBB {
  let best: OBB | null = null;
  let bestA = Infinity;
  for (let i = a; i < b; i++) {
    const j = i + 1 < b ? i + 1 : a;
    let dx = xy[j * 2] - xy[i * 2], dy = xy[j * 2 + 1] - xy[i * 2 + 1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-3) continue;
    dx /= l; dy /= l;
    let min0 = Infinity, max0 = -Infinity, min1 = Infinity, max1 = -Infinity;
    for (let k = a; k < b; k++) {
      const p = xy[k * 2] * dx + xy[k * 2 + 1] * dy;
      const q = -xy[k * 2] * dy + xy[k * 2 + 1] * dx;
      if (p < min0) min0 = p; if (p > max0) max0 = p;
      if (q < min1) min1 = q; if (q > max1) max1 = q;
    }
    const area = (max0 - min0) * (max1 - min1);
    if (area < bestA) {
      bestA = area;
      const cp = (min0 + max0) / 2, cq = (min1 + max1) / 2;
      const L0 = max0 - min0, W0 = max1 - min1;
      const cx = cp * dx - cq * dy, cy = cp * dy + cq * dx;
      best = L0 >= W0 ? { cx, cy, ux: dx, uy: dy, L: L0, W: W0 } : { cx, cy, ux: -dy, uy: dx, L: W0, W: L0 };
    }
  }
  return best ?? { cx: xy[a * 2], cy: xy[a * 2 + 1], ux: 1, uy: 0, L: 1, W: 1 };
}

function insetOuterRings(xy: Float32Array, ringOff: Uint32Array, vertOff: Uint32Array, H: Float32Array, OSM: Float64Array | undefined): Float32Array {
  const out = xy.slice();
  const nB = ringOff.length - 1;
  for (let i = 0; i < nB; i++) {
    const r0 = ringOff[i];
    if (ringOff[i + 1] <= r0) continue;
    const s = vertOff[r0], e = vertOff[r0 + 1], n = e - s;
    if (n < 3) continue;
    const h = hash32(Math.abs(OSM ? OSM[i] : i) || i);
    const d = 0.02 + Math.min(H[i], 300) * 0.0008 + (h & 7) * 0.004;
    const sign = ringArea(xy, s, e) > 0 ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const ip = s + ((k + n - 1) % n), ic = s + k, inx = s + ((k + 1) % n);
      let e1x = xy[ic * 2] - xy[ip * 2], e1y = xy[ic * 2 + 1] - xy[ip * 2 + 1];
      let e2x = xy[inx * 2] - xy[ic * 2], e2y = xy[inx * 2 + 1] - xy[ic * 2 + 1];
      const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
      e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
      const n1x = -e1y * sign, n1y = e1x * sign, n2x = -e2y * sign, n2y = e2x * sign;
      let mx = n1x + n2x, my = n1y + n2y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) continue;
      mx /= ml; my /= ml;
      const k2 = d / Math.max(0.35, mx * n1x + my * n1y);
      out[ic * 2] += mx * k2; out[ic * 2 + 1] += my * k2;
    }
  }
  return out;
}

// --------------------------------------------------------------------------- builder with facade attributes

type RGB = [number, number, number];

class FBuilder {
  pos: Float32Array; nrm: Int8Array; col: Uint8Array; fac: Float32Array; fcd: Float32Array; idx: Uint32Array;
  nv = 0; ni = 0;
  // current facade record applied to new vertices
  u = 0; h0 = 0; L = 0; H = 0; code = 0; unit = 0;
  constructor(vcap: number, icap: number) {
    this.pos = new Float32Array(vcap * 3); this.nrm = new Int8Array(vcap * 4); this.col = new Uint8Array(vcap * 4);
    this.fac = new Float32Array(vcap * 4); this.fcd = new Float32Array(vcap * 2); this.idx = new Uint32Array(icap);
  }
  private growV(n: number) {
    if (this.nv + n <= this.pos.length / 3) return;
    const cap = Math.max((this.pos.length / 3) * 2, this.nv + n);
    const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, s: number): T => { const o = new (a.constructor as new (n: number) => T)(cap * s); o.set(a); return o; };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 4); this.col = g(this.col, 4); this.fac = g(this.fac, 4); this.fcd = g(this.fcd, 2);
  }
  /** vertex with facade coordinates (u along wall, y absolute → h relative to h0) */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB, u: number): number {
    this.growV(1);
    const i = this.nv++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 4] = Math.round(nx * 127); this.nrm[i * 4 + 1] = Math.round(ny * 127); this.nrm[i * 4 + 2] = Math.round(nz * 127);
    this.col[i * 4] = c[0]; this.col[i * 4 + 1] = c[1]; this.col[i * 4 + 2] = c[2]; this.col[i * 4 + 3] = 255;
    this.fac[i * 4] = u; this.fac[i * 4 + 1] = y - this.h0; this.fac[i * 4 + 2] = this.L; this.fac[i * 4 + 3] = this.H;
    this.fcd[i * 2] = this.code; this.fcd[i * 2 + 1] = this.unit;
    return i;
  }
  t(a: number, b: number, c: number) {
    if (this.ni + 3 > this.idx.length) { const q = new Uint32Array(this.idx.length * 2); q.set(this.idx); this.idx = q; }
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  finish(): MeshBuf | null {
    if (this.ni === 0) return null;
    const index = this.nv < 65536 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    return {
      position: this.pos.slice(0, this.nv * 3), normal: this.nrm.slice(0, this.nv * 4), color: this.col.slice(0, this.nv * 4), index,
      attrs: { fac: { array: this.fac.slice(0, this.nv * 4), size: 4 }, fcode: { array: this.fcd.slice(0, this.nv * 2), size: 2 } },
    };
  }
}

/** vertical quad (x0,n0)->(x1,n1) in E,N; outward normal to the right of travel (CCW ring) */
function wall(b: FBuilder, x0: number, n0: number, x1: number, n1: number, y0a: number, y1a: number, y0b: number, y1b: number, c: RGB) {
  const dx = x1 - x0, dn = n1 - n0;
  const l = Math.hypot(dx, dn);
  if (l < 1e-4) return;
  const ne = dn / l, nn = -dx / l;
  const i0 = b.v(x0, y0a, -n0, ne, 0, -nn, c, 0);
  const i1 = b.v(x1, y0b, -n1, ne, 0, -nn, c, l);
  const i2 = b.v(x1, y1b, -n1, ne, 0, -nn, c, l);
  const i3 = b.v(x0, y1a, -n0, ne, 0, -nn, c, 0);
  b.t(i0, i1, i2); b.t(i0, i2, i3);
}

/** triangle given as [x, y, n] points (CCW from outside); u per vertex */
function tri(b: FBuilder, p: number[][], c: RGB, u: [number, number, number] = [0, 0, 0]) {
  const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = -(p[1][2] - p[0][2]);
  const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = -(p[2][2] - p[0][2]);
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const i0 = b.v(p[0][0], p[0][1], -p[0][2], nx, ny, nz, c, u[0]);
  const i1 = b.v(p[1][0], p[1][1], -p[1][2], nx, ny, nz, c, u[1]);
  const i2 = b.v(p[2][0], p[2][1], -p[2][2], nx, ny, nz, c, u[2]);
  b.t(i0, i1, i2);
}

/** quad of 4 three-space points, oriented so its normal faces `face` (three-space); u per vertex */
function quadFacing(b: FBuilder, P: number[][], face: [number, number, number], c: RGB, u: number[]) {
  const ax = P[1][0] - P[0][0], ay = P[1][1] - P[0][1], az = P[1][2] - P[0][2];
  const bx = P[2][0] - P[0][0], by = P[2][1] - P[0][1], bz = P[2][2] - P[0][2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const flip = nx * face[0] + ny * face[1] + nz * face[2] < 0;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  const ids = P.map((p, k) => b.v(p[0], p[1], p[2], nx, ny, nz, c, u[k]));
  if (flip) { b.t(ids[0], ids[2], ids[1]); b.t(ids[0], ids[3], ids[2]); }
  else { b.t(ids[0], ids[1], ids[2]); b.t(ids[0], ids[2], ids[3]); }
}

// --------------------------------------------------------------------------- palettes

const BRICK_RED = [0x9b4f3c, 0xa65d45, 0x8c4a3a, 0xb36b4f, 0x9e5a48, 0x7f4535, 0xa8664e];
const BRICK_BUFF = [0xd2b98e, 0xc9ad80, 0xd9c7a2, 0xbfa27a];
const PAINTED = [0xe6e1d6, 0x3b4248, 0x6d8272, 0xcdb58f, 0x5a3b35, 0xe9dcc0, 0x8a9aa6, 0x2e3a33, 0xd8cfc0];
const STONE_C = [0xcfc6b0, 0xbfb49c, 0xd8d0bd, 0xa89d88, 0xc4bca8];
const GLASS_SPANDREL = [0x3c4a55, 0x2c3640, 0x5b6a73, 0x33443f, 0x6d7a82, 0x1f2a33, 0x4a5a66, 0x8a969c];
const CONDO_C = [0xe4e4e0, 0xd9dadb, 0xcfd2d4, 0xe8e2d6, 0xb9bec2, 0x3a3f44];
const PRECAST_C = [0xc9c3b6, 0xb8b2a6, 0xd8d2c4, 0xa9a397, 0xcbc0ab, 0xb5ac9a];
const STUCCO_C = [0xe8dcc4, 0xd8c8aa, 0xefe8da, 0xd9d2c4, 0xc9b99c, 0xe2d6bf];
const METAL_C = [0xb9bec2, 0xd9d8d2, 0x8b9aa5, 0x6f7a73, 0xc9c6bb, 0x9aa3a8, 0x5d6b78, 0xe2e0d8];
const PARK_C = [0xb8b6b0, 0xc4c0b7, 0xa9a7a2];
const MODERN_C = [0xcfcac0, 0xb9b3a8, 0x9da3a6, 0xd8d4cb, 0x8f8a82];
const HOUSE_C = [0xb98a74, 0xa8796a, 0xdccbab, 0xe8e3d8, 0xc8cdcf, 0xaab3b8, 0x9e7566];
const ROOF_FLAT = [0x8e8d89, 0x9c9a95, 0x6c6b68, 0xb2b0aa, 0x7b7a76, 0xc9c8c2, 0x5d5c5a];
const PITCHED_ROOF = [0x6f5f55, 0x7a6a5c, 0x5e5c5a, 0x6b4f45, 0x707070, 0x5c6168, 0x4a4643];
const AWNING_C = [0x1f5a3a, 0x8b1e24, 0x1d2f55, 0x222222, 0xb5471f, 0x2d6b6b, 0x5b2a4a, 0xc9a227, 0x3f3f3f, 0x7a1515];
const CANOPY_C = [0xe8e4da, 0xd4cfc4, 0x9aa0a4, 0x5a6168, 0xc2b8a4];

// --------------------------------------------------------------------------- district model

/** pre-war City of Toronto (and the old inner suburbs' main streets): E, N box tests */
export function district(e: number, n: number): { old: number; core: number } {
  // old city: roughly Humber → Victoria Park, the lake → Eglinton (softened edges)
  const ox = Math.min(e + 9000, 7500 - e), oy = Math.min(n + 2500, 6200 - n);
  const old = Math.max(0, Math.min(1, Math.min(ox, oy) / 1200 + 0.5));
  // downtown core / financial district + the Yonge corridor
  const cx = Math.min(e + 2200, 1700 - e), cy = Math.min(n + 1600, 1300 - n);
  let core = Math.max(0, Math.min(1, Math.min(cx, cy) / 400 + 0.5));
  // North York centre, Yonge & Eglinton, Mississauga City Centre, Scarborough Centre: tower clusters
  for (const [ce, cn, r] of [[-400, 13500, 1200], [-300, 5600, 900], [-19800, 3000, 1400], [11200, 11400, 1100]] as const) {
    const d = Math.hypot(e - ce, n - cn);
    core = Math.max(core, Math.max(0, Math.min(1, (r - d) / 400 + 0.5)) * 0.8);
  }
  return { old, core };
}

interface Style { style: number; color: number }

function chooseStyle(kind: number, H: number, area: number, old: boolean, core: boolean, g: number, r: number, r2: number): Style {
  const c = (arr: number[]) => pick(arr, r2);
  const brick = (): Style => ({ style: ST.BRICK, color: r2 < 0.62 ? pick(BRICK_RED, r2 / 0.62) : r2 < 0.8 ? pick(BRICK_BUFF, (r2 - 0.62) / 0.18) : pick(PAINTED, (r2 - 0.8) / 0.2) });
  const loft = (): Style => ({ style: ST.LOFT, color: r2 < 0.8 ? pick(BRICK_RED, r2 / 0.8) : pick(BRICK_BUFF, (r2 - 0.8) / 0.2) });
  const S = (style: number, arr: number[]): Style => ({ style, color: c(arr) });
  switch (kind) {
    case 14: return S(ST.PARKING, PARK_C);
    case 15: return S(ST.BLANK, CANOPY_C);
    case 11: return S(ST.BLANK, r < 0.5 ? METAL_C : STUCCO_C);
    case 1: return old ? (r < 0.8 ? { style: ST.HOUSE, color: pick(BRICK_RED.concat(BRICK_BUFF), r2) } : S(ST.HOUSE, HOUSE_C)) : S(ST.HOUSE, HOUSE_C);
    case 5:
      if (old && H < 30 && r < 0.6) return loft();
      return r < 0.75 || area > 4000 ? S(ST.METAL, METAL_C) : S(ST.PRECAST, PRECAST_C);
    case 6: case 7: case 8:
      if (old) return r < 0.5 ? S(ST.STONE, STONE_C) : r < 0.85 ? brick() : S(ST.MODERN, MODERN_C);
      return r < 0.5 ? S(ST.MODERN, MODERN_C) : r < 0.75 ? brick() : S(ST.PRECAST, PRECAST_C);
    case 10: return r < 0.6 ? S(ST.MODERN, MODERN_C) : r < 0.85 ? S(ST.PRECAST, PRECAST_C) : S(ST.GLASS, GLASS_SPANDREL);
    case 9: return r < 0.5 ? S(ST.GLASS, GLASS_SPANDREL) : S(ST.MODERN, MODERN_C);
    case 12: return r < 0.5 ? S(ST.MODERN, MODERN_C) : S(ST.METAL, METAL_C);
    case 3: case 13:
      if (H > 30) return core || r < 0.6 ? (r < 0.8 ? S(ST.GLASS, GLASS_SPANDREL) : S(ST.RIBBON, PRECAST_C)) : S(ST.RIBBON, PRECAST_C);
      if (old) return r < 0.5 ? brick() : r < 0.8 ? S(ST.RIBBON, PRECAST_C) : S(ST.GLASS, GLASS_SPANDREL);
      return r < 0.4 ? S(ST.GLASS, GLASS_SPANDREL) : r < 0.8 ? S(ST.RIBBON, PRECAST_C) : S(ST.STUCCO, STUCCO_C);
    case 4:
      if (area > 3500) return r < 0.6 ? S(ST.METAL, METAL_C) : S(ST.STUCCO, STUCCO_C);
      if (old) return r < 0.75 ? brick() : S(ST.STUCCO, STUCCO_C);
      return r < 0.7 ? S(ST.STUCCO, STUCCO_C) : brick();
    case 2:
      if (H > 40) return core || (!old && r < 0.35) || (old && r < 0.7) ? S(ST.CONDO, CONDO_C) : S(ST.PRECAST, PRECAST_C);
      if (H > 12) return old ? (r < 0.45 ? brick() : r < 0.75 ? S(ST.CONDO, CONDO_C) : S(ST.PRECAST, PRECAST_C)) : (r < 0.6 ? S(ST.PRECAST, PRECAST_C) : r < 0.8 ? brick() : S(ST.CONDO, CONDO_C));
      return old ? brick() : r < 0.5 ? S(ST.STUCCO, STUCCO_C) : brick();
    default: // generic
      if (H > 45) return core ? (r < 0.55 ? S(ST.GLASS, GLASS_SPANDREL) : S(ST.CONDO, CONDO_C)) : (r < 0.5 ? S(ST.PRECAST, PRECAST_C) : r < 0.8 ? S(ST.CONDO, CONDO_C) : S(ST.GLASS, GLASS_SPANDREL));
      if (H > 16) return old ? (r < 0.35 ? loft() : r < 0.6 ? S(ST.PRECAST, PRECAST_C) : r < 0.85 ? S(ST.CONDO, CONDO_C) : S(ST.RIBBON, PRECAST_C)) : (r < 0.6 ? S(ST.PRECAST, PRECAST_C) : S(ST.RIBBON, PRECAST_C));
      if (area < 50) return S(ST.BLANK, r < 0.5 ? STUCCO_C : METAL_C);
      if (g === 6 || (!old && area > 2500)) return S(ST.METAL, METAL_C);
      if (old) return area > 1500 && r < 0.5 ? loft() : brick();
      return g === 5 ? (r < 0.7 ? S(ST.STUCCO, STUCCO_C) : brick()) : r < 0.5 ? brick() : S(ST.STUCCO, STUCCO_C);
  }
}

/** neighbourhoods where shops line residential side streets (Kensington Market, Chinatown's side streets, Baldwin Village) */
export function shopDistrict(e: number, n: number): boolean {
  return (e > -1600 && e < -1330 && n > -120 && n < 170) || (e > -1330 && e < -1100 && n > -40 && n < 120);
}

// --------------------------------------------------------------------------- road frontage

export interface RSeg { x0: number; y0: number; x1: number; y1: number; hw: number; cls: number }

export class SegGrid {
  cells = new Map<number, RSeg[]>();
  size: number;
  constructor(size: number) { this.size = size; }
  private k(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }
  add(s: RSeg, m: number) {
    const z = this.size;
    for (let j = Math.floor((Math.min(s.y0, s.y1) - m) / z); j <= Math.floor((Math.max(s.y0, s.y1) + m) / z); j++)
      for (let i = Math.floor((Math.min(s.x0, s.x1) - m) / z); i <= Math.floor((Math.max(s.x0, s.x1) + m) / z); i++) {
        const key = this.k(i, j);
        const c = this.cells.get(key);
        if (c) c.push(s); else this.cells.set(key, [s]);
      }
  }
  at(x: number, y: number) { return this.cells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size))); }
}

export function roadGrid(a: Record<string, TypedArray>): SegGrid | null {
  const off = a.r_off as Uint32Array | undefined;
  if (!off || off.length < 2) return null;
  const xyz = a.r_xyz as Float32Array, cls = a.r_class as Uint8Array, wid = a.r_width as Float32Array, fl = a.r_flags as Uint8Array;
  const g = new SegGrid(32);
  for (let r = 0; r < off.length - 1; r++) {
    const c = cls[r];
    if (c > 7 || c === 6 || c === 0 || c === 1 || (fl[r] & (4 | 8))) continue; // no motorways/trunks, service, paths, tunnels, ramps
    const hw = (wid?.[r] ?? 8) / 2;
    for (let k = off[r]; k < off[r + 1] - 1; k++) {
      g.add({ x0: xyz[k * 3], y0: xyz[k * 3 + 1], x1: xyz[k * 3 + 3], y1: xyz[k * 3 + 4], hw, cls: c }, 80);
    }
  }
  return g;
}

/** nearest parallel road in front of a wall: curb distance and class */
export function frontage(g: SegGrid, mx: number, my: number, nx: number, ny: number, ex: number, ey: number, halfLen: number, maxSet: number): { d: number; cls: number } | null {
  const c = g.at(mx + nx * Math.min(maxSet, 30), my + ny * Math.min(maxSet, 30));
  if (!c) return null;
  let best: { d: number; cls: number } | null = null;
  for (const s of c) {
    let dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    const l = Math.hypot(dx, dy);
    if (l < 0.5) continue;
    dx /= l; dy /= l;
    if (Math.abs(dx * ex + dy * ey) < 0.82) continue;
    // intersection of the wall normal ray with the segment line
    const den = nx * -dy + ny * dx; // cross(n, d)
    if (Math.abs(den) < 1e-3) continue;
    const wx = s.x0 - mx, wy = s.y0 - my;
    const t = (wx * -dy + wy * dx) / den; // along normal
    const sAlong = (wx * ny - wy * nx) / den; // along segment (negative of param)
    const segT = -sAlong;
    // accept when the ray hits the segment, or the segment passes within half the wall length laterally
    const lat = segT < 0 ? -segT : segT > l ? segT - l : 0;
    if (lat > Math.max(2, halfLen * 0.6)) continue;
    if (t <= 0) continue;
    const d = t - s.hw;
    if (d > maxSet || d < -2) continue;
    if (!best || d < best.d || (Math.abs(d - best.d) < 3 && s.cls < best.cls)) best = { d, cls: s.cls };
  }
  return best;
}

// --------------------------------------------------------------------------- main

export function buildBuildings(a: Record<string, TypedArray>, suppress: Set<number>, level: number, originE = 0, originN = 0,
  terr?: { at(e: number, n: number): number }): { mesh: MeshBuf | null; count: number } {
  const ringOff = a.b_ring_off as Uint32Array | undefined;
  if (!ringOff || ringOff.length < 2) return { mesh: null, count: 0 };
  const vertOff = a.b_vert_off as Uint32Array, xy0 = a.b_xy as Float32Array;
  // Anti z-fighting: every outer ring is inset by a tiny height-ranked amount plus a per-building hash term.
  const xy = insetOuterRings(xy0, ringOff, vertOff, a.b_height as Float32Array, a.b_osm as Float64Array);
  const H = a.b_height as Float32Array, MIN = a.b_min as Float32Array, BASE = a.b_base as Float32Array;
  const KIND = a.b_kind as Uint8Array, ROOFT = a.b_roof as Uint8Array, COL = a.b_color as Uint32Array;
  const OSM = a.b_osm as Float64Array;
  const ground = a.ground as Uint8Array | undefined;
  const nB = ringOff.length - 1;
  const S = level === 0 ? 1024 : level === 1 ? 4096 : 16384;
  const roads = level === 0 ? roadGrid(a) : null;
  const b = new FBuilder(nB * 24, nB * 48);
  let count = 0;
  const flat: number[] = [];
  const holes: number[] = [];
  const edgeFront: number[] = [];
  const edgeUnit: number[] = [];
  const edgeD: number[] = [];
  for (let i = 0; i < nB; i++) {
    const osm = OSM ? OSM[i] : 0;
    if (suppress.size && suppress.has(osm)) continue;
    const r0 = ringOff[i], r1 = ringOff[i + 1];
    if (r1 <= r0) continue;
    count++;
    const base = BASE[i];
    const height = Math.max(H[i], 2.5);
    const minH = Math.min(MIN ? MIN[i] : 0, height - 0.5);
    const kind = KIND[i] ?? 0;
    const h = hash32(Math.abs(osm) || i);
    const r = rnd(h, 1), r2 = rnd(h, 2);
    const va = vertOff[r0], vb = vertOff[r0 + 1];
    const nOuter = vb - va;
    if (nOuter < 3) continue;
    const hasHoles = r1 - r0 > 1;
    const area = Math.abs(ringArea(xy, va, vb));
    // district + ground class at the footprint centroid
    let cx0 = 0, cy0 = 0;
    for (let k = va; k < vb; k++) { cx0 += xy[k * 2]; cy0 += xy[k * 2 + 1]; }
    cx0 /= nOuter; cy0 /= nOuter;
    const dist = district(originE + cx0, originN + cy0);
    const old = r < dist.old * 1.15 - 0.05, core = r2 < dist.core;
    const gcls = ground ? ground[Math.min(255, Math.max(0, Math.floor((cy0 / S) * 256))) * 256 + Math.min(255, Math.max(0, Math.floor((cx0 / S) * 256)))] : 0;
    const st = chooseStyle(kind, height, area, old, core, gcls, rnd(h, 3), rnd(h, 4));
    const vari = 0.93 + rnd(h, 5) * 0.12;
    const wallRGB = COL && COL[i] ? tame(COL[i]) : st.color;
    const wc = shade(wallRGB, vari);
    const seed = h & 255;
    b.h0 = base; b.H = height; b.unit = 0;
    const codeOf = (style: number, front: number) => style + 16 * front + 64 * seed;
    let roofType = ROOFT ? ROOFT[i] : 0;
    const bottom = minH > 0.5 ? base + minH : base - 2.5;
    const top = base + height + (h & 15) * 0.004;
    if (roofType === 0 && level === 0 && kind === 1 && height < 14 && !hasHoles) roofType = 1;
    const roofRGB = roofType === 0 || roofType === 5 ? pick(ROOF_FLAT, rnd(h, 6)) : pick(PITCHED_ROOF, rnd(h, 6));
    const rc = shade(roofRGB, 0.94 + rnd(h, 7) * 0.12);
    const roofCode = codeOf(ST.ROOF, 0);

    // ---- which outer edges front a street (storefront / lobby / loading), level 0 only
    edgeFront.length = 0; edgeUnit.length = 0; edgeD.length = 0;
    const ccwOuter = ringArea(xy, va, vb) > 0;
    const wantShops = level === 0 && roads && minH < 0.5 && height >= 3.2 && kind !== 1 && kind !== 11 && kind !== 14 && kind !== 15;
    for (let k = va; k < vb; k++) {
      edgeFront.push(F_NONE); edgeUnit.push(0); edgeD.push(0);
      if (!wantShops) continue;
      const k2 = k + 1 < vb ? k + 1 : va;
      let x0 = xy[k * 2], y0 = xy[k * 2 + 1], x1 = xy[k2 * 2], y1 = xy[k2 * 2 + 1];
      if (!ccwOuter) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
      const L = Math.hypot(x1 - x0, y1 - y0);
      if (L < 3.5) continue;
      const ex = (x1 - x0) / L, ey = (y1 - y0) / L, nx = ey, ny = -ex;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const retail = kind === 4 || (gcls === 5 && !old);
      const f = frontage(roads!, mx, my, nx, ny, ex, ey, L / 2, retail ? 75 : 16);
      if (!f) continue;
      let fr = F_NONE;
      let unit = 5 + rnd(h, 10 + k - va) * 2.5;
      if (kind === 4) { fr = F_SHOP; if (area > 2500) unit = 14 + rnd(h, 11) * 16; }
      else if (kind === 3 || kind === 13) {
        if (height > 22) { if (f.d < 25) { fr = F_LOBBY; unit = 1.6; } }
        else if (f.d < 12) fr = F_SHOP;
      } else if (kind === 0 || kind === 2) {
        const street = f.d < 9;
        if (street && f.cls <= 3 && height < 90 && (old || gcls === 5 || f.cls <= 2)) fr = height > 30 && kind === 0 && core ? F_LOBBY : F_SHOP;
        else if (street && f.cls === 4 && old && height < 20 && rnd(h, 12) < 0.45) fr = F_SHOP;
        else if (street && f.cls === 7) fr = F_SHOP;
        else if (street && f.cls <= 5 && shopDistrict(originE + cx0, originN + cy0) && height < 16 && rnd(h, 12) < 0.85) fr = F_SHOP;
        else if (!old && gcls === 5 && f.d < 75 && height < 12 && area > 250) { fr = F_SHOP; unit = 6 + rnd(h, 13) * 4; }
        else if (height > 40 && f.d < 20 && core) { fr = F_LOBBY; unit = 1.6; }
        if (fr === F_LOBBY) unit = 1.6;
      } else if (kind === 5 && st.style === ST.METAL && L > 12 && f.d < 60) { fr = F_DOCK; unit = 9 + rnd(h, 14) * 4; }
      else if ((kind === 6 || kind === 9 || kind === 10) && f.d < 20 && height > 8) { fr = F_LOBBY; unit = 1.8; }
      if (fr !== F_NONE) {
        const n = Math.max(1, Math.round(L / unit));
        edgeFront[k - va] = fr; edgeUnit[k - va] = L / n; edgeD[k - va] = f.d;
      }
    }

    // ---- pitched roofs on (approximately) rectangular footprints: rebuild as OBB
    if (roofType !== 0 && !hasHoles && (roofType === 1 || roofType === 2 || roofType === 5)) {
      const o = obb(xy, va, vb);
      if (area / (o.L * o.W) > 0.72 && o.W > 2) {
        const pitch = roofType === 5 ? 0.25 : 0.62;
        const rh = Math.min(o.W * (roofType === 5 ? 1 : 0.5) * pitch, (height - minH) * 0.5);
        const eave = top - rh;
        b.H = eave - base;
        const hl = o.L / 2, hw = o.W / 2;
        const ux = o.ux, uy = o.uy, vx = -uy, vy = ux;
        const P = (s: number, t: number): [number, number] => [o.cx + ux * s * hl + vx * t * hw, o.cy + uy * s * hl + vy * t * hw];
        const c00 = P(-1, -1), c10 = P(1, -1), c11 = P(1, 1), c01 = P(-1, 1);
        const corners = [c00, c10, c11, c01];
        b.code = codeOf(st.style, F_NONE);
        if (roofType === 5) {
          const ys = [eave, eave, top, top];
          for (let k = 0; k < 4; k++) {
            const p = corners[k], q = corners[(k + 1) % 4];
            b.L = Math.hypot(q[0] - p[0], q[1] - p[1]);
            wall(b, p[0], p[1], q[0], q[1], bottom, ys[k], bottom, ys[(k + 1) % 4], wc);
          }
          b.code = roofCode;
          tri(b, [[c00[0], eave, c00[1]], [c10[0], eave, c10[1]], [c11[0], top, c11[1]]], rc);
          tri(b, [[c00[0], eave, c00[1]], [c11[0], top, c11[1]], [c01[0], top, c01[1]]], rc);
          continue;
        }
        for (let k = 0; k < 4; k++) {
          const p = corners[k], q = corners[(k + 1) % 4];
          b.L = Math.hypot(q[0] - p[0], q[1] - p[1]);
          wall(b, p[0], p[1], q[0], q[1], bottom, eave, bottom, eave, wc);
        }
        const inset = roofType === 2 ? Math.min(hw, hl * 0.9) : 0;
        const ra = P(-1 + (inset / hl), 0), rb = P(1 - (inset / hl), 0);
        b.code = roofCode;
        tri(b, [[c00[0], eave, c00[1]], [c10[0], eave, c10[1]], [rb[0], top, rb[1]]], rc);
        tri(b, [[c00[0], eave, c00[1]], [rb[0], top, rb[1]], [ra[0], top, ra[1]]], rc);
        tri(b, [[c11[0], eave, c11[1]], [c01[0], eave, c01[1]], [ra[0], top, ra[1]]], rc);
        tri(b, [[c11[0], eave, c11[1]], [ra[0], top, ra[1]], [rb[0], top, rb[1]]], rc);
        if (roofType === 1) {
          // gable ends: wall material (the attic window row reads as a half storey)
          b.code = codeOf(st.style, F_NONE);
          b.L = o.W; b.H = top - base;
          tri(b, [[c10[0], eave, c10[1]], [c11[0], eave, c11[1]], [rb[0], top, rb[1]]], wc, [0, o.W, o.W / 2]);
          tri(b, [[c01[0], eave, c01[1]], [c00[0], eave, c00[1]], [ra[0], top, ra[1]]], wc, [0, o.W, o.W / 2]);
        } else {
          tri(b, [[c10[0], eave, c10[1]], [c11[0], eave, c11[1]], [rb[0], top, rb[1]]], rc);
          tri(b, [[c01[0], eave, c01[1]], [c00[0], eave, c00[1]], [ra[0], top, ra[1]]], rc);
        }
        continue;
      }
    }

    // ---- generic extrusion
    let wallTop = top;
    let roofMode: 'flat' | 'pyramid' | 'dome' = 'flat';
    if (!hasHoles && (roofType === 3 || roofType === 4 || roofType === 1 || roofType === 2)) roofMode = roofType === 3 ? 'dome' : 'pyramid';
    let cx = 0, cy = 0, rad = 0;
    if (roofMode !== 'flat') {
      cx = cx0; cy = cy0;
      for (let k = va; k < vb; k++) rad = Math.max(rad, Math.hypot(xy[k * 2] - cx, xy[k * 2 + 1] - cy));
      const rh = Math.min(roofMode === 'dome' ? rad : rad * 0.6, (height - minH) * 0.6);
      wallTop = top - rh;
    }
    b.H = wallTop - base;
    for (let rr = r0; rr < r1; rr++) {
      const s = vertOff[rr], e = vertOff[rr + 1];
      const ccw = ringArea(xy, s, e) > 0;
      const outwardFlip = rr === r0 ? !ccw : ccw;
      for (let k = s; k < e; k++) {
        const k2 = k + 1 < e ? k + 1 : s;
        let x0 = xy[k * 2], n0 = xy[k * 2 + 1], x1 = xy[k2 * 2], n1 = xy[k2 * 2 + 1];
        if (outwardFlip) { [x0, x1] = [x1, x0]; [n0, n1] = [n1, n0]; }
        b.L = Math.hypot(x1 - x0, n1 - n0);
        const fr = rr === r0 ? edgeFront[k - s] : F_NONE;
        b.unit = rr === r0 ? edgeUnit[k - s] : 0;
        b.code = codeOf(st.style, fr);
        wall(b, x0, n0, x1, n1, bottom, wallTop, bottom, wallTop, wc);
        // storefronts / lobbies meet the sidewalk: pave the frontage from the wall to the curb
        if ((fr === F_SHOP || fr === F_LOBBY) && terr && rr === r0) apron(b, x0, n0, x1, n1, Math.min(edgeD[k - s] - 0.2, 5), terr, seed);
        if (fr === F_SHOP && level === 0) shopFront(b, x0, n0, x1, n1, base, b.L, b.unit, h, st.style, old, kind, area, seed, shopDistrict(originE + cx0, originN + cy0) ? 0.65 : old ? 0.38 : 0.12);
      }
    }
    b.unit = 0;
    b.code = roofCode;
    if (roofMode === 'flat') {
      flat.length = 0; holes.length = 0;
      for (let rr = r0; rr < r1; rr++) {
        if (rr > r0) holes.push(flat.length / 2);
        for (let k = vertOff[rr]; k < vertOff[rr + 1]; k++) flat.push(xy[k * 2], xy[k * 2 + 1]);
      }
      const tris = earcut(flat, holes.length ? holes : undefined, 2);
      const baseV = b.nv;
      for (let k = 0; k < flat.length / 2; k++) b.v(flat[k * 2], wallTop, -flat[k * 2 + 1], 0, 1, 0, rc, 0);
      for (let k = 0; k < tris.length; k += 3) {
        const A = tris[k], B = tris[k + 1], C = tris[k + 2];
        const cr = (flat[B * 2] - flat[A * 2]) * (flat[C * 2 + 1] - flat[A * 2 + 1]) - (flat[B * 2 + 1] - flat[A * 2 + 1]) * (flat[C * 2] - flat[A * 2]);
        if (cr >= 0) b.t(baseV + A, baseV + B, baseV + C); else b.t(baseV + A, baseV + C, baseV + B);
      }
      if (minH > 0.5) {
        const baseU = b.nv;
        const uc: RGB = [wc[0] * 0.7, wc[1] * 0.7, wc[2] * 0.7];
        for (let k = 0; k < flat.length / 2; k++) b.v(flat[k * 2], bottom, -flat[k * 2 + 1], 0, -1, 0, uc, 0);
        for (let k = 0; k < tris.length; k += 3) {
          const A = tris[k], B = tris[k + 1], C = tris[k + 2];
          const cr = (flat[B * 2] - flat[A * 2]) * (flat[C * 2 + 1] - flat[A * 2 + 1]) - (flat[B * 2 + 1] - flat[A * 2 + 1]) * (flat[C * 2] - flat[A * 2]);
          if (cr >= 0) b.t(baseU + A, baseU + C, baseU + B); else b.t(baseU + A, baseU + B, baseU + C);
        }
      }
    } else {
      const rings = roofMode === 'dome' ? 5 : 1;
      const ccw = ccwOuter;
      const order: number[] = [];
      for (let k = 0; k < nOuter; k++) order.push(ccw ? va + k : vb - 1 - k);
      const rh = top - wallTop;
      let prev = order.map((k) => [xy[k * 2], wallTop, xy[k * 2 + 1]]);
      for (let s = 1; s <= rings; s++) {
        const t = s / rings;
        const f = roofMode === 'dome' ? Math.cos((t * Math.PI) / 2) : 1 - t;
        const y = roofMode === 'dome' ? wallTop + Math.sin((t * Math.PI) / 2) * rh : wallTop + t * rh;
        const cur = order.map((k) => [cx + (xy[k * 2] - cx) * f, y, cy + (xy[k * 2 + 1] - cy) * f]);
        for (let k = 0; k < nOuter; k++) {
          const k2 = (k + 1) % nOuter;
          if (s === rings) tri(b, [prev[k], prev[k2], [cx, top, cy]], rc);
          else { tri(b, [prev[k], prev[k2], cur[k2]], rc); tri(b, [prev[k], cur[k2], cur[k]], rc); }
        }
        prev = cur;
      }
    }
  }
  return { mesh: b.finish(), count };
}

const PAVING: RGB = [184, 180, 172];

/** paved strip in front of a storefront wall (draped on the terrain, just under the sidewalk top) */
function apron(b: FBuilder, x0: number, n0: number, x1: number, n1: number, d: number, terr: { at(e: number, n: number): number }, seed: number) {
  if (d < 0.6) return;
  const L = Math.hypot(x1 - x0, n1 - n0);
  const ex = (x1 - x0) / L, en = (n1 - n0) / L, ne = en, nn = -ex;
  const segs = Math.max(1, Math.ceil(L / 8));
  const h0 = b.h0, code = b.code, H = b.H;
  b.code = ST.ROOF + 64 * seed; b.H = 999;
  for (let k = 0; k < segs; k++) {
    const u0 = (L * k) / segs, u1 = (L * (k + 1)) / segs;
    const P = (u: number, o: number) => { const e = x0 + ex * u + ne * o, n = n0 + en * u + nn * o; return [e, terr.at(e, n) + 0.1, n]; };
    const A = P(u0, -0.05), B = P(u1, -0.05), C = P(u1, d), D = P(u0, d);
    b.h0 = Math.min(A[1], B[1]);
    const ids = [A, B, C, D].map((p) => b.v(p[0], p[1], -p[2], 0, 1, 0, PAVING, 0));
    // CCW seen from above in E,N: outward normal is to the right of travel → A,B,C,D is clockwise; flip
    b.t(ids[0], ids[2], ids[1]); b.t(ids[0], ids[3], ids[2]);
  }
  b.h0 = h0; b.code = code; b.H = H;
}

/**
 * Awnings (old-city shops, per unit) or a continuous canopy with a sign fascia
 * (suburban plazas / big retail) along a storefront wall. Must agree with the
 * shader's shop layout: unit i spans u ∈ [i·unit, (i+1)·unit].
 */
function shopFront(b: FBuilder, x0: number, n0: number, x1: number, n1: number, base: number, L: number, unit: number, h: number,
  style: number, old: boolean, kind: number, area: number, seed: number, pAwning: number) {
  if (unit <= 0 || L < 3) return;
  const ex = (x1 - x0) / L, en = (n1 - n0) / L;
  const ne = en, nn = -ex; // outward (E,N)
  const P = (u: number, out: number, y: number) => [x0 + ex * u + ne * out, base + y, -(n0 + en * u + nn * out)];
  const outN: [number, number, number] = [ne, 0, -nn];
  const plaza = !old && (kind === 4 || area > 250) && rnd(h, 40) < 0.75;
  const nUnits = Math.max(1, Math.round(L / unit));
  if (plaza) {
    // continuous flat canopy with a deep fascia (strip plaza / big-box entrance)
    const d = 2.4 + rnd(h, 41) * 0.8, y0 = 3.3, y1 = 4.2;
    const c = shade(pick(CANOPY_C, rnd(h, 42)), 1);
    b.code = ST.CANOPY + 64 * seed; b.unit = unit;
    const u0 = 0.2, u1 = L - 0.2;
    quadFacing(b, [P(u0, 0, y0), P(u1, 0, y0), P(u1, d, y0), P(u0, d, y0)], [0, -1, 0], c, [u0, u1, u1, u0]); // soffit
    quadFacing(b, [P(u0, 0, y1), P(u1, 0, y1), P(u1, d, y1), P(u0, d, y1)], [0, 1, 0], c, [u0, u1, u1, u0]); // top
    quadFacing(b, [P(u0, d, y0), P(u1, d, y0), P(u1, d, y1), P(u0, d, y1)], outN, c, [u0, u1, u1, u0]); // fascia
    quadFacing(b, [P(u0, 0, y0), P(u0, d, y0), P(u0, d, y1), P(u0, 0, y1)], [-ex, 0, en], c, [0, 0, 0, 0]);
    quadFacing(b, [P(u1, 0, y0), P(u1, d, y0), P(u1, d, y1), P(u1, 0, y1)], [ex, 0, -en], c, [0, 0, 0, 0]);
    return;
  }
  if (style === ST.GLASS || style === ST.CONDO) pAwning *= 0.4;
  for (let i = 0; i < nUnits; i++) {
    if (rnd(h, 50 + i) > pAwning) continue;
    const ua = i * unit + 0.45, ub = (i + 1) * unit - 0.45;
    if (ub - ua < 1.5) continue;
    const proj = 1.1 + rnd(h, 70 + i) * 0.6, yTop = 3.05, yLow = 2.45, val = 0.28;
    const c = shade(pick(AWNING_C, rnd(h, 90 + i)), 1);
    b.code = ST.AWNING + 64 * seed; b.unit = unit;
    const A = P(ua, 0, yTop), B = P(ub, 0, yTop), C = P(ub, proj, yLow), D = P(ua, proj, yLow);
    quadFacing(b, [A, B, C, D], [outN[0], 1.5, outN[2]], c, [ua, ub, ub, ua]);
    quadFacing(b, [A, B, C, D], [-outN[0], -1.5, -outN[2]], shade((c[0] << 16) | (c[1] << 8) | c[2], 0.6), [ua, ub, ub, ua]);
    const E = P(ua, proj, yLow - val), F = P(ub, proj, yLow - val);
    quadFacing(b, [E, F, C, D], outN, c, [ua, ub, ub, ua]);
    quadFacing(b, [E, F, C, D], [-outN[0], 0, -outN[2]], c, [ua, ub, ub, ua]);
    // side cheeks
    quadFacing(b, [P(ua, 0, yTop), P(ua, proj, yLow), P(ua, proj, yLow - val), P(ua, 0, yTop - 0.02)], [-ex, 0, en], c, [0, 0, 0, 0]);
    quadFacing(b, [P(ub, 0, yTop), P(ub, proj, yLow), P(ub, proj, yLow - val), P(ub, 0, yTop - 0.02)], [ex, 0, -en], c, [0, 0, 0, 0]);
  }
}
