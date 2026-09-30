// Pure meshing functions used by the tile worker. All output coordinates are
// tile-local three.js axes: x = E - tx·S, y = elevation (datum m), z = -(N - ty·S).
import earcut from 'earcut';
import type { TypedArray } from '../data/tbn';

export interface MeshBuf {
  position: Float32Array;
  /** snorm8 normals, stride 4 (xyz + pad) */
  normal: Int8Array;
  /** unorm8 RGBA vertex colours (optional) */
  color?: Uint8Array;
  index: Uint32Array | Uint16Array;
  /** extra float attributes (e.g. road marking data) */
  attrs?: Record<string, { array: Float32Array; size: number }>;
}

export interface HouseBuf {
  count: number;
  xy: Float32Array; // local E,N
  base: Float32Array;
  angle: Float32Array;
  len: Float32Array;
  wid: Float32Array;
  height: Float32Array;
  type: Uint8Array;
  variant: Uint8Array;
}

export interface TileMeshes {
  terrain: MeshBuf;
  heights: Float32Array; // G*G metres
  grid: number;
  ground: Uint8Array;
  minH: number;
  maxH: number;
  buildings: MeshBuf | null;
  /** roads, sidewalks and (appended) rail: one draw; rail indices start at `railStart` */
  roads: MeshBuf | null;
  railStart: number;
  houses: HouseBuf | null;
  street: import('./street').StreetBuf | null;
  counts: { buildings: number; houses: number; roads: number; rails: number };
}

/**
 * Concatenate two meshes with identical attribute layouts (roads + rail share
 * the street material, so they become one draw call per tile).
 */
export function concatMeshes(a: MeshBuf | null, b: MeshBuf | null): MeshBuf | null {
  if (!a || !b) return a ?? b;
  const na = a.position.length / 3, nb = b.position.length / 3;
  const cat = <T extends Float32Array | Int8Array | Uint8Array>(x: T, y: T): T => {
    const o = new (x.constructor as new (n: number) => T)(x.length + y.length);
    o.set(x); o.set(y, x.length);
    return o;
  };
  const n = na + nb;
  const index = n < 65536 ? new Uint16Array(a.index.length + b.index.length) : new Uint32Array(a.index.length + b.index.length);
  index.set(a.index);
  for (let i = 0; i < b.index.length; i++) index[a.index.length + i] = b.index[i] + na;
  const out: MeshBuf = { position: cat(a.position, b.position), normal: cat(a.normal, b.normal), index };
  if (a.color && b.color) out.color = cat(a.color, b.color);
  if (a.attrs && b.attrs) {
    out.attrs = {};
    for (const k in a.attrs) if (b.attrs[k]) out.attrs[k] = { array: cat(a.attrs[k].array, b.attrs[k].array), size: a.attrs[k].size };
  }
  return out;
}

// --------------------------------------------------------------------------- growable builder

class Builder {
  pos: Float32Array;
  nrm: Int8Array;
  col: Uint8Array | null;
  idx: Uint32Array;
  nv = 0;
  ni = 0;
  constructor(vcap = 4096, icap = 8192, color = true) {
    this.pos = new Float32Array(vcap * 3);
    this.nrm = new Int8Array(vcap * 4);
    this.col = color ? new Uint8Array(vcap * 4) : null;
    this.idx = new Uint32Array(icap);
  }
  private growV(n: number) {
    if (this.nv + n <= this.pos.length / 3) return;
    const cap = Math.max((this.pos.length / 3) * 2, this.nv + n);
    const p = new Float32Array(cap * 3); p.set(this.pos); this.pos = p;
    const q = new Int8Array(cap * 4); q.set(this.nrm); this.nrm = q;
    if (this.col) { const c = new Uint8Array(cap * 4); c.set(this.col); this.col = c; }
  }
  private growI(n: number) {
    if (this.ni + n <= this.idx.length) return;
    const cap = Math.max(this.idx.length * 2, this.ni + n);
    const q = new Uint32Array(cap); q.set(this.idx); this.idx = q;
  }
  reserve(nv: number, ni: number) { this.growV(nv); this.growI(ni); }
  /** add vertex, returns index. n* are unit floats, rgb 0..255 */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, r = 255, g = 255, b = 255): number {
    this.growV(1);
    const i = this.nv++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 4] = Math.round(nx * 127); this.nrm[i * 4 + 1] = Math.round(ny * 127); this.nrm[i * 4 + 2] = Math.round(nz * 127);
    if (this.col) { this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = 255; }
    return i;
  }
  t(a: number, b: number, c: number) {
    this.growI(3);
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  finish(): MeshBuf | null {
    if (this.ni === 0) return null;
    const index = this.nv < 65536 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    return {
      position: this.pos.slice(0, this.nv * 3),
      normal: this.nrm.slice(0, this.nv * 4),
      color: this.col ? this.col.slice(0, this.nv * 4) : undefined,
      index,
    };
  }
}

// --------------------------------------------------------------------------- terrain

export class TerrainSampler {
  cell: number;
  h: Float32Array; G: number; S: number;
  constructor(h: Float32Array, G: number, S: number) {
    this.h = h; this.G = G; this.S = S;
    this.cell = S / (G - 1);
  }
  /** height at local (e, n) matching the rendered triangulation */
  at(e: number, n: number): number {
    const G = this.G, c = this.cell, h = this.h;
    let fx = e / c, fy = n / c;
    fx = Math.min(Math.max(fx, 0), G - 1.0001);
    fy = Math.min(Math.max(fy, 0), G - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const h00 = h[j * G + i], h10 = h[j * G + i + 1], h01 = h[(j + 1) * G + i], h11 = h[(j + 1) * G + i + 1];
    if (u >= v) return h00 + u * (h10 - h00) + v * (h11 - h10);
    return h00 + v * (h01 - h00) + u * (h11 - h01);
  }
}

export function buildTerrain(hdm: Int16Array, G: number, S: number, level: number) {
  const n = G * G;
  const h = new Float32Array(n);
  let minH = Infinity, maxH = -Infinity;
  for (let k = 0; k < n; k++) {
    h[k] = hdm[k] / 10;
    if (h[k] < minH) minH = h[k];
    if (h[k] > maxH) maxH = h[k];
  }
  const c = S / (G - 1);
  const skirt = [12, 40, 160][level] ?? 40;
  const b = new Builder(n + 4 * G, (G - 1) * (G - 1) * 6 + 4 * (G - 1) * 12, false);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const hl = h[j * G + Math.max(i - 1, 0)], hr = h[j * G + Math.min(i + 1, G - 1)];
      const hd = h[Math.max(j - 1, 0) * G + i], hu = h[Math.min(j + 1, G - 1) * G + i];
      const dx = (hr - hl) / (c * ((i > 0 && i < G - 1) ? 2 : 1));
      const dn = (hu - hd) / (c * ((j > 0 && j < G - 1) ? 2 : 1));
      const inv = 1 / Math.hypot(dx, 1, dn);
      b.v(i * c, h[j * G + i], -j * c, -dx * inv, inv, dn * inv);
    }
  }
  for (let j = 0; j < G - 1; j++) {
    for (let i = 0; i < G - 1; i++) {
      const a = j * G + i, bb = a + 1, cc = a + G + 1, d = a + G;
      b.t(a, bb, cc);
      b.t(a, cc, d);
    }
  }
  // skirts: 4 edges, each a strip hanging `skirt` metres below the edge
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k < G; k++) {
    edges[0].push(k); // south
    edges[1].push((G - 1) * G + k); // north
    edges[2].push(k * G); // west
    edges[3].push(k * G + G - 1); // east
  }
  for (const e of edges) {
    const base = b.nv;
    for (const vi of e) {
      b.v(b.pos[vi * 3], b.pos[vi * 3 + 1] - skirt, b.pos[vi * 3 + 2], b.nrm[vi * 4] / 127, b.nrm[vi * 4 + 1] / 127, b.nrm[vi * 4 + 2] / 127);
    }
    for (let k = 0; k < G - 1; k++) {
      const t0 = e[k], t1 = e[k + 1], s0 = base + k, s1 = base + k + 1;
      b.t(t0, s0, s1); b.t(t0, s1, t1); // both windings (skirts are seen from either side)
      b.t(t0, s1, s0); b.t(t0, t1, s1);
    }
  }
  return { mesh: b.finish()!, heights: h, minH, maxH };
}

// --------------------------------------------------------------------------- buildings

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
    const sign = ringArea(xy, s, e) > 0 ? 1 : -1; // CCW: inward = left of travel
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

// wall / roof palettes per b_kind (slightly desaturated, cartographic)
const WALL: number[] = [
  0xd9d4cb, // 0 generic
  0xe4d8c4, // 1 house
  0xcfc6ba, // 2 apartments
  0xbfc7cf, // 3 office/commercial
  0xdccfbf, // 4 retail
  0xc9c4bb, // 5 industrial
  0xd8cdb8, // 6 civic
  0xd6c3a8, // 7 education
  0xd9ccb3, // 8 religious
  0xc7c1b6, // 9 transport
  0xe0dcd6, // 10 hospital
  0xbdb4a8, // 11 garage/shed
  0xc8ccd0, // 12 stadium
  0xcbc4bb, // 13 hotel
  0xb8b6b2, // 14 parking
  0xc9cbcc, // 15 roof/canopy
];
const ROOF: number[] = [
  0xa9a7a2, 0x8a7d70, 0x9c9894, 0x9aa0a6, 0xa7a29a, 0xa3a3a0, 0x9e978d, 0x958a7e,
  0x8c8378, 0x9a978f, 0xb2b0ac, 0x8c8a86, 0xb4b8bc, 0x9d9a95, 0x8f8e8b, 0xb0b3b5,
];
const PITCHED_ROOF = [0x6f5f55, 0x7a6a5c, 0x5e5c5a, 0x6b4f45, 0x707070, 0x5c6168];

function hash32(x: number): number {
  let h = (x * 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return h >>> 0;
}

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
  const k = 0.4; // keep 40% of the chroma
  const f = (c: number) => Math.round(Math.min(255, (l + (c - l) * k) * 0.92 + 20));
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
      best = L0 >= W0
        ? { cx, cy, ux: dx, uy: dy, L: L0, W: W0 }
        : { cx, cy, ux: -dy, uy: dx, L: W0, W: L0 };
    }
  }
  return best ?? { cx: xy[a * 2], cy: xy[a * 2 + 1], ux: 1, uy: 0, L: 1, W: 1 };
}

type RGB = [number, number, number];

/** vertical quad from (x0,n0)->(x1,n1), outward normal to the right of travel for CCW rings */
function wall(b: Builder, x0: number, n0: number, x1: number, n1: number, y0a: number, y1a: number, y0b: number, y1b: number, c: RGB) {
  const dx = x1 - x0, dn = n1 - n0;
  const l = Math.hypot(dx, dn);
  if (l < 1e-4) return;
  // outward normal for CCW ring (E,N): (dn, -dx)/l ; three: (nx, 0, -nN)
  const ne = dn / l, nn = -dx / l;
  // slight vertical darkening toward the ground for depth cues
  const lo: RGB = [c[0] * 0.86, c[1] * 0.86, c[2] * 0.88];
  const i0 = b.v(x0, y0a, -n0, ne, 0, -nn, lo[0], lo[1], lo[2]);
  const i1 = b.v(x1, y0b, -n1, ne, 0, -nn, lo[0], lo[1], lo[2]);
  const i2 = b.v(x1, y1b, -n1, ne, 0, -nn, c[0], c[1], c[2]);
  const i3 = b.v(x0, y1a, -n0, ne, 0, -nn, c[0], c[1], c[2]);
  b.t(i0, i1, i2); b.t(i0, i2, i3);
}

function tri(b: Builder, p: number[][], c: RGB) {
  // p: 3 points [x, y, n]; computes face normal; emits in the given order (must be CCW seen from outside)
  const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = -(p[1][2] - p[0][2]);
  const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = -(p[2][2] - p[0][2]);
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const i0 = b.v(p[0][0], p[0][1], -p[0][2], nx, ny, nz, c[0], c[1], c[2]);
  const i1 = b.v(p[1][0], p[1][1], -p[1][2], nx, ny, nz, c[0], c[1], c[2]);
  const i2 = b.v(p[2][0], p[2][1], -p[2][2], nx, ny, nz, c[0], c[1], c[2]);
  b.t(i0, i1, i2);
}

export function buildBuildings(a: Record<string, TypedArray>, suppress: Set<number>, level: number): { mesh: MeshBuf | null; count: number } {
  const ringOff = a.b_ring_off as Uint32Array | undefined;
  if (!ringOff || ringOff.length < 2) return { mesh: null, count: 0 };
  const vertOff = a.b_vert_off as Uint32Array, xy0 = a.b_xy as Float32Array;
  // Anti z-fighting: OSM outlines, massing parts and duplicates often share wall
  // planes and roof heights. Every outer ring is inset by a tiny, height-ranked
  // amount (taller parts sit further back, so a podium wall wins over the tower
  // wall above it) plus a per-building hash term that breaks exact ties.
  const xy = insetOuterRings(xy0, a.b_ring_off as Uint32Array, vertOff, a.b_height as Float32Array, a.b_osm as Float64Array);
  const H = a.b_height as Float32Array, MIN = a.b_min as Float32Array, BASE = a.b_base as Float32Array;
  const KIND = a.b_kind as Uint8Array, ROOFT = a.b_roof as Uint8Array, COL = a.b_color as Uint32Array;
  const OSM = a.b_osm as Float64Array;
  const nB = ringOff.length - 1;
  const b = new Builder(nB * 24, nB * 48);
  let count = 0;
  const flat: number[] = [];
  const holes: number[] = [];
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
    const vari = 0.9 + ((h & 255) / 255) * 0.16;
    // OSM building:colour is often garish: blend it 55% toward a desaturated version of itself
    const wallRGB = COL && COL[i] ? tame(COL[i]) : WALL[kind] ?? WALL[0];
    const wc = shade(wallRGB, vari);
    let roofType = ROOFT ? ROOFT[i] : 0;
    // walls start below the base (min terrain under the footprint), so no
    // building floats where the rendered 32 m terrain dips below the DSM minimum
    const bottom = minH > 0.5 ? base + minH : base - 2.5;
    const top = base + height + (h & 15) * 0.004;
    const va = vertOff[r0], vb = vertOff[r0 + 1];
    const nOuter = vb - va;
    if (nOuter < 3) continue;
    const hasHoles = r1 - r0 > 1;
    // houses/small buildings without roof tags get a gable at level 0 for texture
    if (roofType === 0 && level === 0 && (kind === 1) && height < 14 && !hasHoles) roofType = 1;
    const roofRGB = roofType === 0 || roofType === 5 ? ROOF[kind] ?? ROOF[0] : PITCHED_ROOF[h % PITCHED_ROOF.length];
    const rc = shade(roofRGB, 0.94 + ((h >> 8) & 255) / 255 * 0.12);
    const flatBigRoof = roofType === 0;

    // ---- pitched roofs on (approximately) rectangular footprints: rebuild as OBB
    if (!flatBigRoof && !hasHoles && (roofType === 1 || roofType === 2 || roofType === 5)) {
      const o = obb(xy, va, vb);
      const area = Math.abs(ringArea(xy, va, vb));
      if (area / (o.L * o.W) > 0.72 && o.W > 2) {
        const pitch = roofType === 5 ? 0.25 : 0.62;
        const rh = Math.min(o.W * (roofType === 5 ? 1 : 0.5) * pitch, (height - minH) * 0.5);
        const eave = top - rh;
        const hl = o.L / 2, hw = o.W / 2;
        const ux = o.ux, uy = o.uy, vx = -uy, vy = ux;
        const P = (s: number, t: number): [number, number] => [o.cx + ux * s * hl + vx * t * hw, o.cy + uy * s * hl + vy * t * hw];
        const c00 = P(-1, -1), c10 = P(1, -1), c11 = P(1, 1), c01 = P(-1, 1); // CCW
        const corners = [c00, c10, c11, c01];
        if (roofType === 5) {
          // skillion: high side at t=+1
          const ys = [eave, eave, top, top];
          for (let k = 0; k < 4; k++) {
            const p = corners[k], q = corners[(k + 1) % 4];
            wall(b, p[0], p[1], q[0], q[1], bottom, ys[k], bottom, ys[(k + 1) % 4], wc);
          }
          tri(b, [[c00[0], eave, c00[1]], [c10[0], eave, c10[1]], [c11[0], top, c11[1]]], rc);
          tri(b, [[c00[0], eave, c00[1]], [c11[0], top, c11[1]], [c01[0], top, c01[1]]], rc);
          continue;
        }
        for (let k = 0; k < 4; k++) {
          const p = corners[k], q = corners[(k + 1) % 4];
          wall(b, p[0], p[1], q[0], q[1], bottom, eave, bottom, eave, wc);
        }
        const inset = roofType === 2 ? Math.min(hw, hl * 0.9) : 0;
        const ra = P(-1 + (inset / hl), 0), rb = P(1 - (inset / hl), 0);
        // long sides
        tri(b, [[c00[0], eave, c00[1]], [c10[0], eave, c10[1]], [rb[0], top, rb[1]]], rc);
        tri(b, [[c00[0], eave, c00[1]], [rb[0], top, rb[1]], [ra[0], top, ra[1]]], rc);
        tri(b, [[c11[0], eave, c11[1]], [c01[0], eave, c01[1]], [ra[0], top, ra[1]]], rc);
        tri(b, [[c11[0], eave, c11[1]], [ra[0], top, ra[1]], [rb[0], top, rb[1]]], rc);
        // ends: gable walls (wall colour) or hip faces (roof colour)
        const endC = roofType === 1 ? wc : rc;
        tri(b, [[c10[0], eave, c10[1]], [c11[0], eave, c11[1]], [rb[0], top, rb[1]]], endC);
        tri(b, [[c01[0], eave, c01[1]], [c00[0], eave, c00[1]], [ra[0], top, ra[1]]], endC);
        continue;
      }
    }

    // ---- generic extrusion: walls for every ring
    let wallTop = top;
    let roofMode: 'flat' | 'pyramid' | 'dome' = 'flat';
    if (!hasHoles && (roofType === 3 || roofType === 4 || roofType === 1 || roofType === 2)) {
      roofMode = roofType === 3 ? 'dome' : 'pyramid';
    }
    let cx = 0, cy = 0, rad = 0;
    if (roofMode !== 'flat') {
      for (let k = va; k < vb; k++) { cx += xy[k * 2]; cy += xy[k * 2 + 1]; }
      cx /= nOuter; cy /= nOuter;
      for (let k = va; k < vb; k++) rad = Math.max(rad, Math.hypot(xy[k * 2] - cx, xy[k * 2 + 1] - cy));
      const rh = Math.min(roofMode === 'dome' ? rad : rad * 0.6, (height - minH) * 0.6);
      wallTop = top - rh;
    }
    for (let r = r0; r < r1; r++) {
      const s = vertOff[r], e = vertOff[r + 1];
      const ccw = ringArea(xy, s, e) > 0;
      // outer should be CCW, holes CW; walls computed as if ring were CCW-outward
      const outwardFlip = r === r0 ? !ccw : ccw;
      for (let k = s; k < e; k++) {
        const k2 = k + 1 < e ? k + 1 : s;
        let x0 = xy[k * 2], n0 = xy[k * 2 + 1], x1 = xy[k2 * 2], n1 = xy[k2 * 2 + 1];
        if (outwardFlip) { [x0, x1] = [x1, x0]; [n0, n1] = [n1, n0]; }
        wall(b, x0, n0, x1, n1, bottom, wallTop, bottom, wallTop, wc);
      }
    }
    if (roofMode === 'flat') {
      flat.length = 0; holes.length = 0;
      for (let r = r0; r < r1; r++) {
        if (r > r0) holes.push(flat.length / 2);
        for (let k = vertOff[r]; k < vertOff[r + 1]; k++) flat.push(xy[k * 2], xy[k * 2 + 1]);
      }
      const tris = earcut(flat, holes.length ? holes : undefined, 2);
      const baseV = b.nv;
      const ccwOuter = ringArea(xy, va, vb) > 0;
      for (let k = 0; k < flat.length / 2; k++) b.v(flat[k * 2], wallTop, -flat[k * 2 + 1], 0, 1, 0, rc[0], rc[1], rc[2]);
      for (let k = 0; k < tris.length; k += 3) {
        // ensure CCW in E-N (up-facing): earcut preserves input orientation
        const A = tris[k], B = tris[k + 1], C = tris[k + 2];
        const cr = (flat[B * 2] - flat[A * 2]) * (flat[C * 2 + 1] - flat[A * 2 + 1]) - (flat[B * 2 + 1] - flat[A * 2 + 1]) * (flat[C * 2] - flat[A * 2]);
        if (cr >= 0) b.t(baseV + A, baseV + B, baseV + C); else b.t(baseV + A, baseV + C, baseV + B);
      }
      void ccwOuter;
      // underside for overhangs
      if (minH > 0.5) {
        const baseU = b.nv;
        for (let k = 0; k < flat.length / 2; k++) b.v(flat[k * 2], bottom, -flat[k * 2 + 1], 0, -1, 0, wc[0] * 0.7, wc[1] * 0.7, wc[2] * 0.7);
        for (let k = 0; k < tris.length; k += 3) {
          const A = tris[k], B = tris[k + 1], C = tris[k + 2];
          const cr = (flat[B * 2] - flat[A * 2]) * (flat[C * 2 + 1] - flat[A * 2 + 1]) - (flat[B * 2 + 1] - flat[A * 2 + 1]) * (flat[C * 2] - flat[A * 2]);
          if (cr >= 0) b.t(baseU + A, baseU + C, baseU + B); else b.t(baseU + A, baseU + B, baseU + C);
        }
      }
    } else {
      // pyramid / dome over the outer ring
      const rings = roofMode === 'dome' ? 5 : 1;
      const ccw = ringArea(xy, va, vb) > 0;
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

export { buildRoads, buildRail } from './roads';

// --------------------------------------------------------------------------- houses

export function extractHouses(a: Record<string, TypedArray>, suppress: Set<number>): HouseBuf | null {
  const xy = a.h_xy as Float32Array | undefined;
  if (!xy || xy.length < 2) return null;
  const n = xy.length / 2;
  const osm = a.h_osm as Float64Array | undefined;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (!(suppress.size && osm && suppress.has(osm[i]))) keep.push(i);
  const pick = <T extends Float32Array | Uint8Array>(src: T | undefined, Ctor: new (n: number) => T, stride = 1, def = 0): T => {
    const out = new Ctor(keep.length * stride);
    keep.forEach((k, j) => { for (let s = 0; s < stride; s++) out[j * stride + s] = src ? src[k * stride + s] : def; });
    return out;
  };
  return {
    count: keep.length,
    xy: pick(xy, Float32Array, 2),
    base: pick(a.h_base as Float32Array, Float32Array),
    angle: pick(a.h_angle as Float32Array, Float32Array),
    len: pick(a.h_len as Float32Array, Float32Array, 1, 10),
    wid: pick(a.h_wid as Float32Array, Float32Array, 1, 8),
    height: pick(a.h_height as Float32Array, Float32Array, 1, 8),
    type: pick(a.h_type as Uint8Array, Uint8Array),
    variant: pick(a.h_var as Uint8Array, Uint8Array),
  };
}
