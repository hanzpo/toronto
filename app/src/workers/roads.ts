// Street-level meshing (docs/ROADS.md): road ribbons with per-vertex cross
// sections from the network model (pipeline/tpipe/roadnet.py), curbs, raised
// sidewalks with boulevards / paver bands, junction surfaces with curb returns,
// corner sidewalks, tactile plates, medians, highway barriers, bridge
// structures (deck, fascia, soffit, parapets, piers / bents, abutments,
// trusses), embankments, level-crossing props and rail / streetcar track.
// Output coordinates are tile-local three.js axes (x = E, y = elev, z = -N).
// The street shader (render/tiles/roadMaterial.ts) paints asphalt, concrete,
// pavers, markings and track procedurally from these attributes:
//
//   rd = (u, v, eL, eR)   u across (m, + left of travel), v along (m, stroke-continuous),
//                         eL / eR edge-line offsets left / right of the centreline
//   rm = (mk, code, lw, fx)  mk marking bits (roadnet MK_*), code = cls + 16·oneway + 32·surf,
//                         lw nominal lane width, fx extra bits (FX_*)
//   jn = (dPrev, dNext, featPrev, featNext)  along-distance to the previous / next
//        junction or crossing; feat = type·100 + radius (see FEAT_*)
//   color = sRGB tint; alpha = depth priority × 25 (see roadMaterial pull)
import type { TypedArray } from '../data/tbn';
import type { MeshBuf } from './meshing';

export interface Terrain {
  cell: number;
  S: number;
  at(e: number, n: number): number;
}

// surfaces (shader switches on these)
export const SURF_ROAD = 0, SURF_SIDEWALK = 1, SURF_CURB = 2, SURF_BARRIER = 3, SURF_PATH = 4,
  SURF_PAVERS = 5, SURF_STEEL = 6, SURF_BALLAST = 7, SURF_STRUCT = 8, SURF_TACTILE = 9, SURF_GRASS = 10,
  SURF_GRAVEL = 11, SURF_PANEL = 12, SURF_WOOD = 13, SURF_PAINT = 14;
// feature types in jn.zw
export const FEAT_NONE = 0, FEAT_JUNCTION = 1, FEAT_SIGNAL = 2, FEAT_ZEBRA = 3, FEAT_LINES = 4, FEAT_STOP = 5,
  FEAT_PXO = 6, FEAT_RAIL = 7;
// rm.w extra bits
export const FX_LINK = 1, FX_RUMBLE = 2, FX_SHARROW = 4, FX_STAIRS = 8, FX_CYCLE = 16, FX_DIVIDED = 32;
// per-vertex flags (tpipe.roadnet V_*)
const V_BRIDGE = 1, V_TUNNEL = 2, V_GRADED = 4, V_EMBED = 8;
const ST_GIRDER = 1, ST_PORTAL = 2, ST_HAMMER = 3, ST_TRUSS = 4, ST_ARCH = 5, ST_FOOT = 6, ST_RAIL = 7, ST_GRASS = 10;
// sidewalk bits (tpipe.roadnet SW_*)
export const SW_L = 1, SW_R = 2, BLVD_L = 4, BLVD_R = 8, PAVERS = 16, MEDIAN_L = 32;
// road flags
const F_ONEWAY = 1, F_BRIDGE = 2, F_LINK = 8, F_LOT = 32, F_DUP = 64;
const FAR = 1e4;

export const ROAD_W_DEFAULT = [24, 18, 14, 12, 10, 8, 5, 5, 2.2, 3];
export const SIDEWALK_W = [0, 0, 3.2, 2.8, 2.4, 1.9, 1.6];
const CURB_H = 0.15;
export const BLVD_W = 1.8;
export const PAVER_W = 0.9;
// ground classes where roads get curbs + sidewalks when OSM doesn't say otherwise (old tiles)
const URBAN = new Set([2, 4, 5, 6, 11, 12, 17, 18, 19, 21, 22]);

// ---------------------------------------------------------------------------- builder

export class RoadBuilder {
  pos: Float32Array; nrm: Int8Array; col: Uint8Array; rd: Float32Array; rm: Float32Array; jn: Float32Array; idx: Uint32Array;
  nv = 0; ni = 0;
  constructor(vcap = 4096, icap = 8192) {
    this.pos = new Float32Array(vcap * 3); this.nrm = new Int8Array(vcap * 4); this.col = new Uint8Array(vcap * 4);
    this.rd = new Float32Array(vcap * 4); this.rm = new Float32Array(vcap * 4); this.jn = new Float32Array(vcap * 4); this.idx = new Uint32Array(icap);
  }
  private growV(n: number) {
    if (this.nv + n <= this.pos.length / 3) return;
    const cap = Math.max((this.pos.length / 3) * 2, this.nv + n);
    const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, k: number): T => {
      const b = new (a.constructor as new (n: number) => T)(cap * k); b.set(a); return b;
    };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 4); this.col = g(this.col, 4); this.rd = g(this.rd, 4); this.rm = g(this.rm, 4); this.jn = g(this.jn, 4);
  }
  /** current per-vertex state written by v() */
  c = [255, 255, 255, 0];
  code = 0;
  /** edge-line offsets (left, right) for rd.zw */
  eL = 0; eR = 0;
  mk = 0; lw = 3.5; fx = 0;
  j = [FAR, FAR, 0, 0];
  n = [0, 1, 0];
  /** legacy: half width (sets eL = eR) */
  set hw(h: number) { this.eL = h; this.eR = h; }
  v(x: number, y: number, z: number, u: number, along: number): number {
    this.growV(1);
    const i = this.nv++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 4] = Math.round(this.n[0] * 127); this.nrm[i * 4 + 1] = Math.round(this.n[1] * 127); this.nrm[i * 4 + 2] = Math.round(this.n[2] * 127);
    this.col[i * 4] = this.c[0]; this.col[i * 4 + 1] = this.c[1]; this.col[i * 4 + 2] = this.c[2]; this.col[i * 4 + 3] = this.c[3];
    this.rd[i * 4] = u; this.rd[i * 4 + 1] = along; this.rd[i * 4 + 2] = this.eL; this.rd[i * 4 + 3] = this.eR;
    this.rm[i * 4] = this.mk; this.rm[i * 4 + 1] = this.code; this.rm[i * 4 + 2] = this.lw; this.rm[i * 4 + 3] = this.fx;
    this.jn[i * 4] = this.j[0]; this.jn[i * 4 + 1] = this.j[1]; this.jn[i * 4 + 2] = this.j[2]; this.jn[i * 4 + 3] = this.j[3];
    return i;
  }
  t(a: number, b: number, c: number) {
    if (this.ni + 3 > this.idx.length) { const q = new Uint32Array(Math.max(this.idx.length * 2, this.ni + 3)); q.set(this.idx); this.idx = q; }
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  /** quad a-b-c-d (CCW seen from the front) */
  q(a: number, b: number, c: number, d: number) { this.t(a, b, c); this.t(a, c, d); }
  /** reset per-surface state to plain (no markings) */
  plain(surf: number, rgb: number[], prio: number, cls = 0) {
    this.code = cls + 32 * surf; this.mk = 0; this.fx = 0; this.lw = 3.5; this.j = [FAR, FAR, 0, 0];
    this.c = [rgb[0], rgb[1], rgb[2], Math.round(prio * 25)];
  }
  /** axis-aligned-ish box: centre (x, n), yaw, half sizes, from y0 to y1 (no bottom face) */
  box(x: number, n: number, y0: number, y1: number, ang: number, hl: number, hw: number, surf: number, rgb: number[], prio: number) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const P = (a: number, b: number) => [x + ca * a - sa * b, n + sa * a + ca * b];
    const cs = [P(hl, hw), P(-hl, hw), P(-hl, -hw), P(hl, -hw)];
    this.plain(surf, rgb, prio);
    for (let k = 0; k < 4; k++) {
      const p = cs[k], q = cs[(k + 1) % 4];
      const ex = q[0] - p[0], en = q[1] - p[1], l = Math.hypot(ex, en) || 1;
      this.n = [en / l, 0, ex / l];
      const a = this.v(p[0], y0, -p[1], 0, 0), b = this.v(q[0], y0, -q[1], l, 0), c = this.v(q[0], y1, -q[1], l, y1 - y0), d = this.v(p[0], y1, -p[1], 0, y1 - y0);
      this.q(a, d, c, b);
    }
    this.n = [0, 1, 0];
    const t = cs.map((p) => this.v(p[0], y1, -p[1], 0, 0));
    this.q(t[0], t[1], t[2], t[3]);
  }
  finish(): MeshBuf | null {
    if (this.ni === 0) return null;
    const index = this.nv < 65536 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    return {
      position: this.pos.slice(0, this.nv * 3), normal: this.nrm.slice(0, this.nv * 4), color: this.col.slice(0, this.nv * 4), index,
      attrs: {
        rd: { array: this.rd.slice(0, this.nv * 4), size: 4 }, rm: { array: this.rm.slice(0, this.nv * 4), size: 4 },
        jn: { array: this.jn.slice(0, this.nv * 4), size: 4 },
      },
    };
  }
}

// ---------------------------------------------------------------------------- polyline helpers

/** per-vertex attributes carried along a run (interpolated when clipping / refining) */
const NUM = ['z', 's', 'el', 'er', 'pl', 'pr', 'lw', 'dz', 'wl', 'wr'] as const;
const DISC = ['mk', 'vf', 'sw'] as const;
/** A run: polyline points with world-continuous along-distance s and per-vertex attributes. */
interface Run { x: number[]; y: number[]; z: number[]; s: number[]; el: number[]; er: number[]; pl: number[]; pr: number[]; lw: number[]; dz: number[]; wl: number[]; wr: number[]; mk: number[]; vf: number[]; sw: number[] }
const newRun = (): Run => ({ x: [], y: [], z: [], s: [], el: [], er: [], pl: [], pr: [], lw: [], dz: [], wl: [], wr: [], mk: [], vf: [], sw: [] });

interface Src { xyz: Float32Array; ws?: Uint8Array; s?: Float32Array; el?: Float32Array; er?: Float32Array; pl?: Float32Array; pr?: Float32Array; lw?: Float32Array; dz?: Float32Array; mk?: Uint32Array; vf?: Uint8Array; sw?: Uint8Array; hw: number; v0: number; mk0: number; lw0: number }

function pushLerp(r: Run, S: Src, i: number, j: number, t: number, sAlong: number) {
  const L = (A: ArrayLike<number> | undefined, dflt: number) => (A ? A[i] + (A[j] - A[i]) * t : dflt);
  r.x.push(S.xyz[i * 3] + (S.xyz[j * 3] - S.xyz[i * 3]) * t);
  r.y.push(S.xyz[i * 3 + 1] + (S.xyz[j * 3 + 1] - S.xyz[i * 3 + 1]) * t);
  r.z.push(S.xyz[i * 3 + 2] + (S.xyz[j * 3 + 2] - S.xyz[i * 3 + 2]) * t);
  r.s.push(S.s ? L(S.s, 0) : sAlong);
  r.el.push(L(S.el, S.hw)); r.er.push(L(S.er, S.hw)); r.pl.push(L(S.pl, S.hw)); r.pr.push(L(S.pr, S.hw));
  r.lw.push(L(S.lw, S.lw0)); r.dz.push(L(S.dz, 0));
  // sidewalk width to the building line (decimetres per side, 0 = default)
  const W = (c: number) => (S.ws ? (S.ws[i * 2 + c] + (S.ws[j * 2 + c] - S.ws[i * 2 + c]) * t) / 10 : 0);
  r.wl.push(W(0)); r.wr.push(W(1));
  const k = t < 0.5 ? i : j;
  r.mk.push(S.mk ? S.mk[k] : S.mk0); r.vf.push(S.vf ? S.vf[k] : 0); r.sw.push(S.sw ? S.sw[k] : 0);
}

/** clip a polyline to [lo, hi]² (Liang–Barsky per segment); returns inside runs */
function clipRuns(S: Src, a: number, b: number, lo: number, hi: number): Run[] {
  const xyz = S.xyz;
  const runs: Run[] = [];
  let cur: Run | null = null;
  let s = S.v0;
  for (let i = a; i < b - 1; i++) {
    const x0 = xyz[i * 3], y0 = xyz[i * 3 + 1];
    const x1 = xyz[i * 3 + 3], y1 = xyz[i * 3 + 4];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    let t0 = 0, t1 = 1;
    const p = [-dx, dx, -dy, dy], q = [x0 - lo, hi - x0, y0 - lo, hi - y0];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (Math.abs(p[k]) < 1e-12) { if (q[k] < 0) { ok = false; break; } continue; }
      const r = q[k] / p[k];
      if (p[k] < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (ok && (t1 - t0 > 1e-9 || len < 1e-6)) {
      if (!cur || t0 > 1e-9) {
        cur = newRun();
        runs.push(cur);
        pushLerp(cur, S, i, i + 1, t0, s + len * t0);
      }
      pushLerp(cur, S, i, i + 1, t1, s + len * t1);
      if (t1 < 1 - 1e-9) cur = null;
    } else {
      cur = null;
    }
    s += len;
  }
  return runs.filter((r) => r.x.length >= 2 && Math.abs(r.s[r.s.length - 1] - r.s[0]) > 0.05);
}

function pushRunLerp(out: Run, r: Run, i: number, t: number) {
  const j = Math.min(i + 1, r.x.length - 1);
  out.x.push(r.x[i] + (r.x[j] - r.x[i]) * t); out.y.push(r.y[i] + (r.y[j] - r.y[i]) * t);
  for (const k of NUM) (out[k] as number[]).push((r[k] as number[])[i] + ((r[k] as number[])[j] - (r[k] as number[])[i]) * t);
  for (const k of DISC) (out[k] as number[]).push((r[k] as number[])[t < 0.5 ? i : j]);
}

/**
 * Insert vertices where the centreline crosses the terrain triangulation
 * (grid lines x = i·c, y = j·c and the diagonals x − y = k·c) plus any extra
 * along-distances in `cuts`, so draped geometry follows the rendered terrain.
 */
function refine(r: Run, cell: number, cuts: number[], maxSeg: number): Run {
  const out = newRun();
  pushRunLerp(out, r, 0, 0);
  const ts: number[] = [];
  for (let i = 0; i < r.x.length - 1; i++) {
    const x0 = r.x[i], y0 = r.y[i], x1 = r.x[i + 1], y1 = r.y[i + 1], s0 = r.s[i], s1 = r.s[i + 1];
    ts.length = 0;
    const drape = !(r.vf[i] & V_BRIDGE) || !(r.vf[i + 1] & V_BRIDGE);
    if (drape) {
      const lines = (a0: number, a1: number) => {
        if (Math.abs(a1 - a0) < 1e-9) return;
        const lo = Math.min(a0, a1) / cell, hi = Math.max(a0, a1) / cell;
        for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
          const t = (k * cell - a0) / (a1 - a0);
          if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
        }
      };
      lines(x0, x1); lines(y0, y1); lines(x0 - y0, x1 - y1);
    }
    if (Math.abs(s1 - s0) > 1e-6) for (const c of cuts) if (c > Math.min(s0, s1) + 0.01 && c < Math.max(s0, s1) - 0.01) ts.push((c - s0) / (s1 - s0));
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / maxSeg);
    for (let k = 1; k < n; k++) ts.push(k / n);
    ts.sort((p, q) => p - q);
    let last = 0;
    for (const t of ts) {
      if (t - last < 1e-3) continue;
      pushRunLerp(out, r, i, t);
      last = t;
    }
    pushRunLerp(out, r, i + 1, 0);
  }
  return out;
}

/** left offset unit-ish vectors (miter-scaled) per vertex */
function offsets(r: { x: number[]; y: number[] }): { ox: number[]; oy: number[]; tx: number[]; ty: number[] } {
  const n = r.x.length;
  const ox: number[] = new Array(n), oy: number[] = new Array(n), tx: number[] = new Array(n), ty: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // skip zero-length neighbours (duplicated lane-change vertices)
    let i0 = i - 1; while (i0 >= 0 && Math.hypot(r.x[i] - r.x[i0], r.y[i] - r.y[i0]) < 1e-4) i0--;
    let i1 = i + 1; while (i1 < n && Math.hypot(r.x[i1] - r.x[i], r.y[i1] - r.y[i]) < 1e-4) i1++;
    let d0x = 0, d0y = 0, d1x = 0, d1y = 0;
    if (i0 >= 0) { d0x = r.x[i] - r.x[i0]; d0y = r.y[i] - r.y[i0]; const l = Math.hypot(d0x, d0y); d0x /= l; d0y /= l; }
    if (i1 < n) { d1x = r.x[i1] - r.x[i]; d1y = r.y[i1] - r.y[i]; const l = Math.hypot(d1x, d1y); d1x /= l; d1y /= l; }
    if (i0 < 0) { d0x = d1x; d0y = d1y; }
    if (i1 >= n) { d1x = d0x; d1y = d0y; }
    let sx = d0x + d1x, sy = d0y + d1y;
    const sl = Math.hypot(sx, sy);
    if (sl < 1e-6) { sx = d1x || 1; sy = d1y; } else { sx /= sl; sy /= sl; }
    const px = -sy, py = sx;
    const m = 1 / Math.max(0.5, Math.abs(px * -d1y + py * d1x) || 1);
    ox[i] = px * m; oy[i] = py * m; tx[i] = sx; ty[i] = sy;
  }
  return { ox, oy, tx, ty };
}

// ---------------------------------------------------------------------------- junctions / crossings

interface JArm { ang: number; r: number; hw: number; flags: number }
interface Junction { x: number; y: number; flags: number; osm: number; cl: number; arms: JArm[] }

const hkey = (x: number, y: number) => `${Math.round(x * 20)},${Math.round(y * 20)}`;

export function readJunctions(a: Record<string, TypedArray>): Junction[] {
  const xy = a.j_xy as Float32Array | undefined;
  if (!xy) return [];
  const off = a.j_arm_off as Uint32Array, ang = a.j_arm_ang as Float32Array, r = a.j_arm_r as Float32Array;
  const hw = a.j_arm_hw as Float32Array, af = a.j_arm_flags as Uint8Array, fl = a.j_flags as Uint8Array, osm = a.j_osm as Float64Array;
  const cl = a.j_cl as Float64Array | undefined;
  const out: Junction[] = [];
  for (let i = 0; i < xy.length / 2; i++) {
    const arms: JArm[] = [];
    for (let k = off[i]; k < off[i + 1]; k++) arms.push({ ang: ang[k], r: r[k], hw: hw[k], flags: af[k] });
    out.push({ x: xy[i * 2], y: xy[i * 2 + 1], flags: fl[i], osm: osm[i], cl: cl ? cl[i] : osm[i], arms });
  }
  return out;
}

function armFor(j: Junction, dx: number, dy: number): JArm | null {
  const a = Math.atan2(dy, dx);
  let best: JArm | null = null, bd = 0.6;
  for (const arm of j.arms) {
    const d = Math.abs(Math.atan2(Math.sin(a - arm.ang), Math.cos(a - arm.ang)));
    if (d < bd) { bd = d; best = arm; }
  }
  return best;
}

/** feature at a run vertex: code for the side before and after the vertex */
interface Feat { s: number; before: number; after: number; cutBefore: number; cutAfter: number; signal: boolean }

const featCode = (type: number, r: number) => type * 100 + Math.min(99, Math.max(0, Math.round(r * 10) / 10));

// ---------------------------------------------------------------------------- roads

export interface StreetRoad {
  /** sidewalk/curb lines usable for street furniture (tile-local E,N) */
  x: number[]; y: number[]; s: number[];
  ox: number[]; oy: number[];
  hw: number; cls: number; side: number; // side bitmask 1 left, 2 right (sidewalks drawn)
  ws: number;
  /** along-ranges [s0, s1] clear of junction boxes */
  clear: [number, number][];
  urban: boolean;
  bridge?: boolean;
  /** per-vertex pavement half widths left / right (network-model tiles) */
  pl?: number[]; pr?: number[];
  /** per-vertex sidewalk bits (SW_L, SW_R, BLVD_L, BLVD_R, PAVERS) */
  sw?: number[];
  /** per-vertex road surface elevation */
  z?: number[];
}

export interface RoadOut { mesh: MeshBuf | null; count: number; streets: StreetRoad[]; junctions: Junction[] }

interface Seg2 { x0: number; y0: number; x1: number; y1: number; hw: number; z: number }

/** coarse spatial hash of at-grade carriageways / tracks (pier and prop placement) */
class SegGrid {
  cell = 32; m = new Map<number, Seg2[]>();
  add(s: Seg2) {
    const c = this.cell, pad = s.hw + 2;
    const x0 = Math.floor((Math.min(s.x0, s.x1) - pad) / c), x1 = Math.floor((Math.max(s.x0, s.x1) + pad) / c);
    const y0 = Math.floor((Math.min(s.y0, s.y1) - pad) / c), y1 = Math.floor((Math.max(s.y0, s.y1) + pad) / c);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) {
      const k = i * 100003 + j; let l = this.m.get(k); if (!l) this.m.set(k, (l = [])); l.push(s);
    }
  }
  /** true if (x, y) lies within any segment's half width + margin, below height zTop */
  hit(x: number, y: number, margin: number, zTop: number): boolean {
    const l = this.m.get(Math.floor(x / this.cell) * 100003 + Math.floor(y / this.cell));
    if (!l) return false;
    for (const s of l) {
      if (s.z > zTop) continue;
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / l2));
      if (Math.hypot(x - s.x0 - dx * t, y - s.y0 - dy * t) < s.hw + margin) return true;
    }
    return false;
  }
}

/** a prepared run: refined geometry with offsets and elevations */
interface Prep {
  run: Run; ox: number[]; oy: number[]; tx: number[]; ty: number[];
  zc: number[]; zl: number[]; zr: number[]; structZ: number[];
  /** per-vertex cross-section mode (0 draped · 1 flat · 2 structure), roads only */
  zm?: number[];
  c: number; f: number; feats: Feat[]; lift: number;
  /** path sub-kind (osm_extract SUBKIND), surface code, cycleway bits */
  sub?: number; surf?: number; cyc?: number;
}

const struct = (vf: number) => vf >> 4;

export function buildRoads(a: Record<string, TypedArray>, terr: Terrain, level: number, ground: Uint8Array | null): RoadOut {
  const off = a.r_off as Uint32Array | undefined;
  const junctions = level === 0 ? readJunctions(a) : [];
  if (!off || off.length < 2) return { mesh: null, count: 0, streets: [], junctions };
  const xyz = a.r_xyz as Float32Array, cls = a.r_class as Uint8Array, wid = a.r_width as Float32Array, flags = a.r_flags as Uint8Array;
  const lanesA = a.r_lanes as Uint8Array | undefined, sideA = a.r_side as Uint8Array | undefined, v0A = a.r_v0 as Float32Array | undefined;
  const net = !!a.r_el;
  const subA = a.r_sub as Uint8Array | undefined, surfA = a.r_surf as Uint8Array | undefined, cycA = a.r_cyc as Uint8Array | undefined;
  const n = off.length - 1;
  const S = terr.S;
  const b = new RoadBuilder(xyz.length / 3 * 10, xyz.length / 3 * 30);
  const widen = [1, 1.6, 3.2][level] ?? 1;
  const streets: StreetRoad[] = [];

  // junction + crossing lookup by exact vertex position
  const jmap = new Map<string, Junction>();
  for (const j of junctions) jmap.set(hkey(j.x, j.y), j);
  const xmap = new Map<string, number>();
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined, pv = a.p_var as Uint8Array | undefined;
  if (level === 0 && pk && pxy && pv) {
    for (let i = 0; i < pk.length; i++) {
      const k = hkey(pxy[i * 2], pxy[i * 2 + 1]);
      if (pk[i] === 2 && pv[i] > 0) xmap.set(k, pv[i] === 1 ? FEAT_ZEBRA : pv[i] === 3 ? FEAT_PXO : FEAT_LINES);
      else if (pk[i] === 5) xmap.set(k, FEAT_RAIL);
    }
  }

  const groundAt = (x: number, y: number) => {
    if (!ground) return 0;
    const i = Math.min(255, Math.max(0, Math.floor((x / S) * 256))), j = Math.min(255, Math.max(0, Math.floor((y / S) * 256)));
    return ground[j * 256 + i];
  };
  const nBuilt = ((a.b_ring_off as Uint32Array | undefined)?.length ?? 1) - 1 + ((a.h_xy as Float32Array | undefined)?.length ?? 0) / 2;
  const urbanSet = nBuilt > 150 ? new Set([...URBAN, 0]) : URBAN;

  // ---- pass 1: prepare every run (geometry, elevation, features)
  const preps: Prep[] = [];
  const atGrade = new SegGrid();
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = flags ? flags[i] : 0;
    if (f & (F_LOT | F_DUP)) continue;
    const c = cls[i] ?? 5;
    let w = wid && wid[i] > 0 ? wid[i] : ROAD_W_DEFAULT[c] ?? 6;
    w = Math.max(w, c <= 1 ? 10 : 2) * widen;
    const hw = w / 2;
    const lanes = level === 0 && lanesA ? Math.min(15, lanesA[i]) : 0;
    const src: Src = {
      xyz, s: a.r_s as Float32Array | undefined, el: a.r_el as Float32Array | undefined, er: a.r_er as Float32Array | undefined,
      pl: a.r_pl as Float32Array | undefined, pr: a.r_pr as Float32Array | undefined, lw: a.r_lw as Float32Array | undefined,
      dz: a.r_dz as Float32Array | undefined, mk: a.r_mk as Uint32Array | undefined, vf: a.r_vf as Uint8Array | undefined,
      sw: a.r_sw as Uint8Array | undefined, ws: a.r_ws as Uint8Array | undefined, hw, v0: v0A ? v0A[i] : 0,
      mk0: (f & F_ONEWAY) ? Math.max(lanes, 1) : (Math.ceil(lanes / 2) | (Math.floor(lanes / 2) << 4)), lw0: 3.5,
    };
    const runs = clipRuns(src, off[i], off[i + 1], -0.01, S + 0.01);
    if (!runs.length) continue;
    count++;
    for (const run0 of runs) {
      if (!net) { // old tiles: flags per piece
        for (let k = 0; k < run0.x.length; k++) {
          run0.vf[k] = (f & F_BRIDGE ? V_BRIDGE | V_GRADED : 0) | (f & 4 ? V_TUNNEL : 0);
          if (level > 0) { run0.el[k] = run0.er[k] = run0.pl[k] = run0.pr[k] = hw; }
        }
      } else if (level > 0) {
        for (let k = 0; k < run0.x.length; k++) { run0.pl[k] *= widen; run0.pr[k] *= widen; run0.el[k] *= widen; run0.er[k] *= widen; }
      }
      // ---- features along the run (junctions, marked crossings)
      const feats: Feat[] = [];
      if (level === 0 && c <= 7) {
        for (let k = 0; k < run0.x.length; k++) {
          const key = hkey(run0.x[k], run0.y[k]);
          const j = jmap.get(key);
          if (j) {
            // duplicated (lane-change) vertices: one feature only
            if (feats.length && Math.abs(feats[feats.length - 1].s - run0.s[k]) < 0.01) continue;
            let kp = k - 1; while (kp >= 0 && Math.hypot(run0.x[kp] - run0.x[k], run0.y[kp] - run0.y[k]) < 1e-3) kp--;
            let kn = k + 1; while (kn < run0.x.length && Math.hypot(run0.x[kn] - run0.x[k], run0.y[kn] - run0.y[k]) < 1e-3) kn++;
            const pa = kp >= 0 ? armFor(j, run0.x[kp] - run0.x[k], run0.y[kp] - run0.y[k]) : null;
            const na = kn < run0.x.length ? armFor(j, run0.x[kn] - run0.x[k], run0.y[kn] - run0.y[k]) : null;
            const sig = (j.flags & 1) !== 0;
            const typ = (arm: JArm | null) => (arm && arm.flags & 2 ? FEAT_JUNCTION : sig ? FEAT_SIGNAL : arm && arm.flags & 1 ? FEAT_STOP : FEAT_JUNCTION);
            const rb = pa ? pa.r : hw, ra = na ? na.r : hw;
            feats.push({ s: run0.s[k], before: featCode(typ(pa), rb), after: featCode(typ(na), ra), cutBefore: rb, cutAfter: ra, signal: sig });
            continue;
          }
          const xt = xmap.get(key);
          if (xt) feats.push({ s: run0.s[k], before: featCode(xt, 0), after: featCode(xt, 0), cutBefore: 0, cutAfter: 0, signal: false });
        }
        // crossings right next to a signalized junction are drawn by the junction
        for (let k = feats.length - 1; k >= 0; k--) {
          const ft = feats[k];
          const ftype = Math.floor(ft.before / 100);
          if (ftype !== FEAT_ZEBRA && ftype !== FEAT_LINES && ftype !== FEAT_PXO) continue;
          if (feats.some((o) => o.signal && Math.abs(o.s - ft.s) < Math.max(o.cutBefore, o.cutAfter) + 10)) feats.splice(k, 1);
        }
        feats.sort((p, q) => (p.s - q.s));
      }
      const cuts: number[] = [];
      for (const ft of feats) { cuts.push(ft.s); if (ft.cutBefore) cuts.push(ft.s - ft.cutBefore); if (ft.cutAfter) cuts.push(ft.s + ft.cutAfter); }
      const run = refine(run0, terr.cell, cuts, level === 0 ? (c >= 8 ? 30 : 20) : Math.max(25, terr.cell));
      const nv = run.x.length;
      const { ox, oy, tx, ty } = offsets(run);
      const zc: number[] = new Array(nv), zl: number[] = new Array(nv), zr: number[] = new Array(nv), structZ: number[] = new Array(nv);
      const zm: number[] = new Array(nv); // cross-section: 0 draped · 1 flat (graded) · 2 structure / absolute
      for (let k = 0; k < nv; k++) {
        const x = run.x[k], y = run.y[k];
        const t0 = terr.at(x, y);
        const vf = run.vf[k];
        const br = (vf & V_BRIDGE) !== 0;
        const dz = net ? run.dz[k] : 0;
        // blend: draped + dz near the ground, the solved absolute profile higher up / on decks
        const wAbs = br ? 1 : (vf & V_GRADED) ? Math.min(1, Math.max(0, (dz - 1.5) / 3)) : 0;
        // draped part never below the drawn ground (the solve's at-grade floor is ground - 0.15 m:
        // a road 0.12 m under the terrain showed as grass bands where the graded flag toggles)
        const zDr = t0 + ((vf & V_GRADED) ? ((vf & V_TUNNEL) ? dz : Math.max(dz, 0)) : 0);
        zc[k] = zDr + (run.z[k] - zDr) * wAbs;
        structZ[k] = zc[k];
        const hl = run.pl[k], hr = run.pr[k];
        zm[k] = br || (vf & V_TUNNEL) ? 2 : wAbs > 0.99 || (vf & V_GRADED && dz > 0.3) ? 1 : 0;
        if (wAbs > 0.99 || (vf & V_GRADED && dz > 0.3)) {
          zl[k] = zr[k] = zc[k];
          // graded (flat) cross-section on a side slope: the 32 m terrain triangles can rise
          // above the pavement edge (grass bands across DVP lanes, cars on the bank) -- the
          // high edge follows the drawn ground up instead (cars ride that ground)
          if (!br && !(vf & V_TUNNEL)) {
            zl[k] = Math.max(zc[k], terr.at(x + ox[k] * hl, y + oy[k] * hl) + 0.02);
            zr[k] = Math.max(zc[k], terr.at(x - ox[k] * hr, y - oy[k] * hr) + 0.02);
          }
          continue;
        }
        zl[k] = terr.at(x + ox[k] * hl, y + oy[k] * hl) + (zc[k] - t0);
        zr[k] = terr.at(x - ox[k] * hr, y - oy[k] * hr) + (zc[k] - t0);
      }
      const lift = (c <= 7 ? 0.03 + (9 - c) * 0.004 : 0.02);
      preps.push({ run, ox, oy, tx, ty, zc, zl, zr, zm, structZ, c, f, feats, lift, sub: subA ? subA[i] : 0, surf: surfA ? surfA[i] : 0, cyc: cycA ? cycA[i] : 0 });
      // at-grade segments (for pier avoidance)
      for (let k = 0; k < nv - 1; k++) {
        if (run.vf[k] & (V_BRIDGE | V_TUNNEL)) continue;
        atGrade.add({ x0: run.x[k], y0: run.y[k], x1: run.x[k + 1], y1: run.y[k + 1], hw: Math.max(run.pl[k], run.pr[k]), z: zc[k] });
      }
    }
  }
  // rail at grade (piers must not land on tracks)
  {
    const lo = a.l_off as Uint32Array | undefined, lx = a.l_xyz as Float32Array | undefined, lvf = a.l_vf as Uint8Array | undefined;
    const lfl = a.l_flags as Uint8Array | undefined;
    if (lo && lx) for (let i = 0; i < lo.length - 1; i++) {
      for (let k = lo[i]; k < lo[i + 1] - 1; k++) {
        const vf = lvf ? lvf[k] : (lfl && lfl[i] & 6 ? V_BRIDGE : 0);
        if (vf & (V_BRIDGE | V_TUNNEL)) continue;
        atGrade.add({ x0: lx[k * 3], y0: lx[k * 3 + 1], x1: lx[k * 3 + 3], y1: lx[k * 3 + 4], hw: 2.2, z: lx[k * 3 + 2] });
      }
    }
  }

  // ---- pass 2: emit
  for (const P of preps) {
    const { run, ox, oy, zc, zl, zr, c, f, feats, lift } = P;
    const nv = run.x.length;
    const oneway = (f & F_ONEWAY) !== 0;
    const link = (f & F_LINK) !== 0;
    // surface + tint
    let surf = SURF_ROAD;
    let tint = [255, 255, 255];
    let fx = link ? FX_LINK : 0;
    if (c === 8) {
      // paths: surface from OSM (asphalt paths read light grey, concrete walks, pavers, gravel, boardwalk)
      const sf = P.surf ?? 0;
      surf = sf === 1 ? SURF_SIDEWALK : sf === 2 ? SURF_PAVERS : sf === 3 ? SURF_GRAVEL : sf === 4 ? SURF_WOOD : SURF_PATH;
      tint = sf === 3 ? [255, 236, 206] : P.sub === 2 ? [200, 196, 192] : [236, 232, 226];
      if (P.sub === 2) fx |= FX_CYCLE;
      if (P.sub === 4) fx |= FX_STAIRS;
    } else if (c === 9) { surf = SURF_GRAVEL; tint = [255, 236, 206]; }
    else if (c === 7) surf = SURF_PAVERS;
    if (level > 0) { surf = SURF_ROAD; tint = [255, 255, 255]; }
    if (c <= 1 && !link && level === 0) fx |= FX_RUMBLE;
    if (((P.cyc ?? 0) & 15) === 3 || ((P.cyc ?? 0) >> 4) === 3) fx |= FX_SHARROW;
    const prio = c <= 7 ? 5.5 - c * 0.5 : c === 8 ? 1.5 : 1;
    const code0 = c + 16 * (oneway ? 1 : 0);
    // spans between features
    const fs = feats.map((ft) => ft.s);
    const spanOf = (sv: number) => { let k = 0; while (k < fs.length && fs[k] <= sv + 1e-4) k++; return k; };
    b.n = [0, 1, 0];
    // ---- road surface: columns L(pavement) [C] R(pavement)
    // interior columns on wide carriageways: the surface follows the 32 m terrain triangles across
    // (a ridge between the two edges would otherwise show through as grass bands across lanes)
    const wid0 = run.pl[0] + run.pr[0];
    const zm = P.zm;
    const colZ = (k: number, x: number, y: number, t0: number) => {
      const m = zm ? zm[k] : 0;
      if (m === 2) return zc[k];
      if (m === 1) return Math.max(zc[k], terr.at(x, y) + 0.02);
      return terr.at(x, y) + (zc[k] - t0);
    };
    let nIn = level === 0 && c <= 7 && !run.vf.every((v) => (v & V_BRIDGE) !== 0) ? (wid0 >= 18 ? 3 : wid0 >= 9 ? 1 : 0) : 0;
    if (nIn) {
      // only where the ground actually bulges above the straight edge-to-edge section
      let need = false;
      for (let k = 0; k < nv && !need; k++) {
        if (zm && zm[k] === 2) continue;
        const x = run.x[k], y = run.y[k], hl = run.pl[k], hr = run.pr[k], t0 = terr.at(x, y);
        for (let q = 1; q <= 3 && !need; q++) {
          const fr = q / 4, u = hl - (hl + hr) * fr;
          const px = x + ox[k] * u, py = y + oy[k] * u;
          if (colZ(k, px, py, t0) - (zl[k] + (zr[k] - zl[k]) * fr) > 0.06) need = true;
        }
      }
      if (!need) nIn = 0;
    }
    let prevIdx: number[] | null = null;
    let prevSpan = -1;
    for (let k = 0; k < nv; k++) {
      const vf = run.vf[k];
      const tun = (vf & V_TUNNEL) !== 0 && k > 0 && (run.vf[k - 1] & V_TUNNEL) !== 0;
      if (tun) { prevIdx = null; continue; }
      const sv = run.s[k];
      const br = (vf & V_BRIDGE) !== 0;
      b.eL = run.el[k]; b.eR = run.er[k]; b.mk = run.mk[k]; b.lw = run.lw[k]; b.fx = fx | (run.sw[k] & MEDIAN_L ? FX_DIVIDED : 0);
      b.code = code0 + 32 * surf;
      b.c = [tint[0], tint[1], tint[2], Math.round((br ? Math.max(prio, 6) : prio) * 25)];
      const onFeat = fs.findIndex((q) => Math.abs(q - sv) < 1e-3);
      const spans = onFeat >= 0 ? [onFeat, onFeat + 1] : [spanOf(sv)];
      for (const sp of spans) {
        const fp = sp > 0 ? feats[sp - 1] : null, fn = sp < feats.length ? feats[sp] : null;
        b.j = [fp ? sv - fp.s : FAR, fn ? fn.s - sv : FAR, fp ? fp.after : 0, fn ? fn.before : 0];
        const x = run.x[k], y = run.y[k];
        const hl = run.pl[k], hr = run.pr[k];
        const cur = [b.v(x + ox[k] * hl, zl[k] + lift, -(y + oy[k] * hl), hl, sv)];
        if (nIn) {
          const t0 = terr.at(x, y);
          for (let q = 1; q <= nIn; q++) {
            const u = hl - ((hl + hr) * q) / (nIn + 1); // lateral offset, + left
            const px = x + ox[k] * u, py = y + oy[k] * u;
            cur.push(b.v(px, colZ(k, px, py, t0) + lift, -py, u, sv));
          }
        }
        cur.push(b.v(x - ox[k] * hr, zr[k] + lift, -(y - oy[k] * hr), -hr, sv));
        if (prevIdx && prevSpan === sp) {
          for (let q = cur.length - 1; q > 0; q--) b.q(prevIdx[q], cur[q], cur[q - 1], prevIdx[q - 1]);
        }
        prevIdx = cur; prevSpan = sp;
      }
    }
    b.j = [FAR, FAR, 0, 0]; b.fx = 0; b.mk = 0;
    // ---- clear along-ranges (outside junction boxes)
    const clear: [number, number][] = [];
    {
      let s0 = run.s[0];
      for (const ft of feats) {
        const e = ft.s - ft.cutBefore;
        if (e - s0 > 0.5) clear.push([s0, e]);
        s0 = Math.max(s0, ft.s + ft.cutAfter);
      }
      if (run.s[nv - 1] - s0 > 0.5) clear.push([s0, run.s[nv - 1]]);
    }
    // ---- sidewalks (bits per vertex from the network model; old tiles: tag / land-use heuristic)
    let swAll = 0;
    const ws = SIDEWALK_W[c] ?? 0;
    let builtUp = false;
    if (level === 0 && c >= 2 && c <= 6) {
      if (net) {
        for (let k = 0; k < nv; k++) swAll |= run.sw[k];
      } else if (c <= 5 && !link && !(f & F_BRIDGE)) {
        const side = sideA ? sideA[0] : 0; void side;
        const m = Math.floor(nv / 2);
        let urban = 0;
        for (const k of [0, m, nv - 1]) if (urbanSet.has(groundAt(run.x[k], run.y[k]))) urban++;
        builtUp = urban >= 2;
        if (builtUp) { swAll = SW_L | SW_R; for (let k = 0; k < nv; k++) run.sw[k] = swAll; }
      }
      if (swAll) builtUp = true;
      for (const sd of [1, -1]) {
        const bit = sd === 1 ? SW_L : SW_R;
        if (!(swAll & bit)) continue;
        for (const [ca, cb] of clear) {
          // sub-ranges where this side has a sidewalk
          let st = -1;
          for (let k = 0; k <= nv; k++) {
            const on = k < nv && run.s[k] >= ca - 1e-3 && run.s[k] <= cb + 1e-3 && (run.sw[k] & bit) !== 0;
            if (on && st < 0) st = k;
            if (!on && st >= 0) {
              const s0 = Math.max(ca, run.s[st]), s1 = Math.min(cb, run.s[k - 1]);
              if (s1 - s0 > 0.5) sidewalk(b, P, sd, s0, s1, ws, c, terr);
              st = -1;
            }
          }
        }
      }
    }
    const hwAvg = (run.pl[0] + run.pr[0]) / 2;
    if (level === 0 || c <= 3) {
      const anyBridge = run.vf.some((v) => (v & V_BRIDGE) !== 0);
      streets.push({
        x: run.x, y: run.y, s: run.s, ox, oy, hw: hwAvg, cls: c, side: swAll & 3, ws, clear, urban: builtUp || swAll !== 0,
        bridge: anyBridge, pl: run.pl, pr: run.pr, sw: run.sw, z: zc,
      });
    }
    if (level !== 0) continue;
    // ---- motorway median barrier (left pavement edge of one-way carriageways)
    if (c <= 1 && oneway && !link) {
      for (const [k0, k1] of vRanges(run, (k) => !(run.vf[k] & V_TUNNEL))) {
        wallStrip(b, P, k0, k1, (k) => run.pl[k] - 0.3, 0.3, 0.2, 0.85, [205, 202, 196], SURF_BARRIER, 6, zl);
      }
    }
    // ---- steel beam guardrail on the right of freeways where the verge is a steep bank up or a drop
    //      (OTM / MTO roadside design: a barrier where the side slope is steeper than ~1:3)
    if (c <= 1) {
      const bank = new Array(nv).fill(false);
      for (let k = 0; k < nv; k++) {
        if (run.vf[k] & (V_BRIDGE | V_TUNNEL)) continue;
        const l = Math.hypot(ox[k], oy[k]) || 1;
        const m = run.pr[k] + 4;
        const gx = run.x[k] - (ox[k] / l) * m, gy = run.y[k] - (oy[k] / l) * m;
        bank[k] = Math.abs(terr.at(gx, gy) - zr[k]) > 1.3;
      }
      // close short gaps, drop short runs
      for (const [k0, k1] of vRanges(run, (k) => !bank[k])) {
        if (k0 > 0 && k1 < nv - 1 && run.s[k1 + 1] - run.s[k0 - 1] < 25 && !(run.vf[k0] & (V_BRIDGE | V_TUNNEL))) for (let k = k0; k <= k1; k++) bank[k] = true;
      }
      for (const [k0, k1] of vRanges(run, (k) => bank[k])) {
        if (run.s[k1] - run.s[k0] < 20) continue;
        wallStrip(b, P, k0, k1, (k) => -(run.pr[k] - 0.25), 0.1, 0.1, 0.8, [176, 180, 182], SURF_BARRIER, 6, zr);
      }
    }
    // ---- bridge structures
    for (const [k0, k1] of vRanges(run, (k) => (run.vf[k] & V_BRIDGE) !== 0)) bridge(b, P, k0, k1, ws, terr, atGrade);
    // ---- embankments / retaining walls where the solved profile leaves the ground
    embankment(b, P, swAll, ws, terr);
  }

  // ---- junction surfaces, corner sidewalks, curbs, tactile plates, medians, level-crossing props
  if (level === 0) {
    junctionSurfaces(b, a, terr);
    medians(b, a, terr);
  }
  return { mesh: b.finish(), count, streets, junctions };
}

/** index ranges [k0, k1] of consecutive run vertices satisfying pred */
function vRanges(run: Run, pred: (k: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let st = -1;
  for (let k = 0; k <= run.x.length; k++) {
    const on = k < run.x.length && pred(k);
    if (on && st < 0) st = k;
    if (!on && st >= 0) { if (k - 1 > st) out.push([st, k - 1]); st = -1; }
  }
  return out;
}

/** interpolate a run at along-distance s (clamped), returns [index, t] */
function locate(run: Run, s: number): [number, number] {
  const n = run.s.length;
  if (s <= run.s[0]) return [0, 0];
  if (s >= run.s[n - 1]) return [n - 2, 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (run.s[m] <= s) lo = m; else hi = m; }
  const t = (s - run.s[lo]) / Math.max(1e-9, run.s[lo + 1] - run.s[lo]);
  return [lo, t];
}

function sidewalk(b: RoadBuilder, P: Prep, sd: number, s0: number, s1: number, ws: number, cls: number, terr: Terrain) {
  const { run, ox, oy, zl, zr, lift } = P;
  interface Pt { x: number; y: number; ox: number; oy: number; ze: number; s: number; e: number; sw: number; br: boolean; zc: number; wb: number }
  const pts: Pt[] = [];
  const at = (s: number) => {
    const [k, t] = locate(run, s);
    const L = (A: number[]) => A[k] + (A[k + 1] - A[k]) * t;
    const kk = t < 0.5 ? k : k + 1;
    pts.push({ x: L(run.x), y: L(run.y), ox: L(ox), oy: L(oy), ze: sd > 0 ? L(zl) : L(zr), s, e: sd > 0 ? L(run.pl) : L(run.pr),
      sw: run.sw[kk], br: (run.vf[kk] & V_BRIDGE) !== 0, zc: L(P.zc), wb: sd > 0 ? L(run.wl) : L(run.wr) });
  };
  at(s0);
  for (let k = 0; k < run.s.length; k++) if (run.s[k] > s0 + 0.05 && run.s[k] < s1 - 0.05) at(run.s[k]);
  at(s1);
  if (pts.length < 2) return;
  const blvdBit = sd > 0 ? BLVD_L : BLVD_R;
  // bands from the curb outward: [pavers | boulevard grass] then walk
  const bands: { w: number; surf: number; rgb: number[] }[] = [];
  const p0 = pts[Math.floor(pts.length / 2)];
  if (p0.sw & blvdBit && !p0.br) bands.push({ w: BLVD_W, surf: SURF_GRASS, rgb: [255, 255, 255] });
  else if (p0.sw & PAVERS) bands.push({ w: PAVER_W, surf: SURF_PAVERS, rgb: [214, 196, 186] });
  bands.push({ w: ws, surf: SURF_SIDEWALK, rgb: [255, 255, 255] });
  const lift0 = lift;
  // curb face (normal toward the road)
  b.plain(SURF_CURB, [255, 255, 255], 7, cls);
  const curbB: number[] = [], curbT: number[] = [];
  const yTop: number[] = [];
  for (const p of pts) {
    const l = Math.hypot(p.ox, p.oy) || 1;
    const ex = p.x + sd * p.ox * p.e, ey = p.y + sd * p.oy * p.e;
    const yi = p.ze + lift0 + CURB_H;
    yTop.push(yi);
    b.n = [-sd * p.ox / l, 0, sd * p.oy / l];
    curbB.push(b.v(ex, p.ze + lift0 - 0.05, -ey, sd * p.e, p.s));
    curbT.push(b.v(ex, yi, -ey, sd * p.e, p.s));
  }
  for (let k = 0; k < pts.length - 1; k++) {
    if (sd > 0) b.q(curbB[k], curbB[k + 1], curbT[k + 1], curbT[k]); else b.q(curbB[k + 1], curbB[k], curbT[k], curbT[k + 1]);
  }
  // bands (flat tops; the last band falls gently to the ground at its outer edge unless on a deck)
  let inner = 0;
  const outerY: number[] = pts.map(() => 0);
  for (let bi = 0; bi < bands.length; bi++) {
    const bd = bands[bi];
    b.plain(bd.surf, bd.rgb, 7, cls);
    b.hw = 0;
    const A: number[] = [], B: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      b.eL = p.e + inner; b.eR = p.e + inner;
      const last_ = bi === bands.length - 1;
      // downtown main streets: the walk reaches the building line
      const bw = last_ && p.wb > 0 ? Math.max(bd.w, p.wb - inner) : bd.w;
      const u0 = p.e + inner, u1 = p.e + inner + bw;
      const ax = p.x + sd * p.ox * u0, ay = p.y + sd * p.oy * u0;
      const qx = p.x + sd * p.ox * u1, qy = p.y + sd * p.oy * u1;
      const yi = yTop[k];
      const last = bi === bands.length - 1;
      const yo = p.br || !last ? yi : Math.max(terr.at(qx, qy) + lift0, yi - CURB_H - 0.02);
      b.n = [0, 1, 0];
      A.push(b.v(ax, yi, -ay, sd * u0, p.s));
      B.push(b.v(qx, yo, -qy, sd * u1, p.s));
      if (last) outerY[k] = yo;
    }
    for (let k = 0; k < pts.length - 1; k++) {
      if (sd > 0) b.q(A[k], A[k + 1], B[k + 1], B[k]); else b.q(A[k + 1], A[k], B[k], B[k + 1]);
    }
    inner += bd.w;
  }
  // end caps
  b.plain(SURF_CURB, [255, 255, 255], 7, cls);
  for (const [pi, dir] of [[0, -1], [pts.length - 1, 1]] as [number, number][]) {
    const p = pts[pi];
    const l = Math.hypot(p.ox, p.oy) || 1;
    const tx = p.oy / l * -1, ty = p.ox / l; void tx; void ty;
    const ex = p.x + sd * p.ox * p.e, ey = p.y + sd * p.oy * p.e;
    const qx = p.x + sd * p.ox * (p.e + inner), qy = p.y + sd * p.oy * (p.e + inner);
    const dx = qx - ex, dy = qy - ey, dl = Math.hypot(dx, dy) || 1;
    b.n = [dir * (dy / dl) * sd, 0, dir * (dx / dl) * sd];
    const yb = p.ze + lift - 0.05;
    const a0 = b.v(ex, yb, -ey, sd * p.e, p.s), a1 = b.v(ex, yTop[pi], -ey, sd * p.e, p.s);
    const a2 = b.v(qx, outerY[pi], -qy, sd * (p.e + inner), p.s), a3 = b.v(qx, Math.min(yb, outerY[pi]) - 0.2, -qy, sd * (p.e + inner), p.s);
    if (dir * sd > 0) b.q(a0, a3, a2, a1); else b.q(a0, a1, a2, a3);
  }
}

/** a solid wall (barrier/parapet) centred at lateral offset u(k) over run vertices k0..k1 */
function wallStrip(b: RoadBuilder, P: Prep, k0: number, k1: number, u: (k: number) => number, wBase: number, wTop: number, h: number,
  rgb: number[], surf: number, prio: number, z: number[]) {
  const { run, ox, oy, lift } = P;
  b.plain(surf, rgb, prio);
  const cols: number[][] = [];
  for (let k = k0; k <= k1; k++) {
    const l = Math.hypot(ox[k], oy[k]) || 1;
    const nx = ox[k] / l, ny = oy[k] / l;
    const uk = u(k);
    const m = Math.hypot(ox[k], oy[k]);
    const cx = run.x[k] + nx * uk * m, cy = run.y[k] + ny * uk * m;
    const y0 = z[k] + lift - 0.1, y1 = z[k] + lift + h;
    const V = (d: number, y: number, nn: number[]) => { b.n = nn; b.eL = b.eR = Math.abs(uk); return b.v(cx + nx * d, y, -(cy + ny * d), uk + d, run.s[k]); };
    cols.push([
      V(wBase, y0, [nx, 0.25, -ny]), V(wTop, y1, [nx, 0.25, -ny]),
      V(wTop, y1, [0, 1, 0]), V(-wTop, y1, [0, 1, 0]),
      V(-wTop, y1, [-nx, 0.25, ny]), V(-wBase, y0, [-nx, 0.25, ny]),
    ]);
  }
  for (let k = 0; k < cols.length - 1; k++) {
    const A = cols[k], B = cols[k + 1];
    b.q(A[0], A[1], B[1], B[0]);
    b.q(A[2], A[3], B[3], B[2]);
    b.q(A[4], A[5], B[5], B[4]);
  }
}

// ---------------------------------------------------------------------------- structures

const DECK_DEPTH: Record<number, number> = { [ST_GIRDER]: 1.5, [ST_PORTAL]: 2.2, [ST_HAMMER]: 2.0, [ST_TRUSS]: 2.4, [ST_ARCH]: 1.6, [ST_FOOT]: 0.7, [ST_RAIL]: 1.8 };
const PIER_SPACING: Record<number, number> = { [ST_GIRDER]: 32, [ST_PORTAL]: 20, [ST_HAMMER]: 42, [ST_TRUSS]: 84, [ST_ARCH]: 74, [ST_FOOT]: 26, [ST_RAIL]: 24 };
const CONCRETE = [196, 192, 186];
const SOFFIT = [150, 146, 140];
const STEEL_G = [120, 128, 132];

/** deck slab (fascia both sides + soffit), parapets, piers / bents, abutments, truss */
function bridge(b: RoadBuilder, P: Prep, k0: number, k1: number, ws: number, terr: Terrain, atGrade: SegGrid) {
  const { run, ox, oy, zc, lift, c } = P;
  const st0 = struct(run.vf[Math.floor((k0 + k1) / 2)]) || (c >= 8 ? ST_FOOT : ST_GIRDER);
  const depth = DECK_DEPTH[st0] ?? 1.5;
  // outer deck edges: pavement + sidewalk band (+ boulevard / pavers) + parapet
  const edge = (k: number, sd: number) => {
    const e = sd > 0 ? run.pl[k] : run.pr[k];
    const bit = sd > 0 ? SW_L : SW_R;
    return e + (run.sw[k] & bit ? ws + (run.sw[k] & PAVERS ? PAVER_W : 0) : 0) + 0.45;
  };
  const top: number[][] = [], bot: number[][] = [];
  // fascia (both sides) + soffit
  b.plain(SURF_STRUCT, CONCRETE, 6.5);
  for (const sd of [1, -1]) {
    const T: number[] = [], B: number[] = [];
    for (let k = k0; k <= k1; k++) {
      const l = Math.hypot(ox[k], oy[k]) || 1;
      const m = edge(k, sd);
      const x = run.x[k] + sd * ox[k] * m, y = run.y[k] + sd * oy[k] * m;
      b.n = [sd * ox[k] / l, 0, -sd * oy[k] / l];
      T.push(b.v(x, zc[k] + lift + 0.02, -y, sd * m, run.s[k]));
      B.push(b.v(x, zc[k] - depth, -y, sd * m, run.s[k]));
    }
    for (let k = 0; k < T.length - 1; k++) {
      if (sd > 0) b.q(B[k], T[k], T[k + 1], B[k + 1]); else b.q(B[k], B[k + 1], T[k + 1], T[k]);
    }
    top.push(T); bot.push(B);
  }
  b.plain(SURF_STRUCT, SOFFIT, 6.5);
  {
    const Lr: number[] = [], Rr: number[] = [];
    for (let k = k0; k <= k1; k++) {
      b.n = [0, -1, 0];
      const ml = edge(k, 1), mr = edge(k, -1);
      Lr.push(b.v(run.x[k] + ox[k] * ml, zc[k] - depth, -(run.y[k] + oy[k] * ml), ml, run.s[k]));
      Rr.push(b.v(run.x[k] - ox[k] * mr, zc[k] - depth, -(run.y[k] - oy[k] * mr), -mr, run.s[k]));
    }
    for (let k = 0; k < Lr.length - 1; k++) b.q(Lr[k], Lr[k + 1], Rr[k + 1], Rr[k]);
  }
  // parapets: jersey on freeways, concrete parapet with a rail on streets, railing on footbridges
  const foot = st0 === ST_FOOT;
  for (const sd of [1, -1]) {
    const uf = (k: number) => sd * (edge(k, sd) - 0.22);
    if (foot) wallStrip(b, P, k0, k1, uf, 0.06, 0.05, 1.3, [120, 124, 126], SURF_STRUCT, 6.5, zc);
    else wallStrip(b, P, k0, k1, uf, 0.3, 0.2, c <= 1 ? 1.07 : 1.0, CONCRETE, SURF_STRUCT, 6.5, zc);
  }
  // piers / bents at stroke-continuous spacing (so tiles agree), skipped where the ground is close
  const sp = PIER_SPACING[st0] ?? 30;
  const sA = run.s[k0], sB = run.s[k1];
  const first = Math.ceil((Math.min(sA, sB) + 4) / sp) * sp;
  for (let s = first; s < Math.max(sA, sB) - 4; s += sp) {
    placePier(b, P, s, st0, depth, edge, terr, atGrade, sp);
  }
  // truss: two side trusses over the deck
  if (st0 === ST_TRUSS) truss(b, P, k0, k1, edge);
  // abutments: a wall under each deck end that is above ground
  for (const k of [k0, k1]) {
    const g = terr.at(run.x[k], run.y[k]);
    if (zc[k] - depth - g < 0.4) continue;
    const ml = edge(k, 1), mr = edge(k, -1);
    const x0 = run.x[k] + ox[k] * ml, y0 = run.y[k] + oy[k] * ml, x1 = run.x[k] - ox[k] * mr, y1 = run.y[k] - oy[k] * mr;
    b.plain(SURF_STRUCT, CONCRETE, 6.5);
    const dir = k === k0 ? -1 : 1;
    b.n = [dir * P.tx[k], 0, -dir * P.ty[k]];
    const A = b.v(x0, zc[k] - depth, -y0, 0, 0), B = b.v(x1, zc[k] - depth, -y1, ml + mr, 0);
    const C = b.v(x1, terr.at(x1, y1) - 0.5, -y1, ml + mr, 3), D = b.v(x0, terr.at(x0, y0) - 0.5, -y0, 0, 3);
    b.q(A, B, C, D); b.q(A, D, C, B);
  }
}

function placePier(b: RoadBuilder, P: Prep, s: number, st: number, depth: number, edge: (k: number, sd: number) => number,
  terr: Terrain, atGrade: SegGrid, sp: number) {
  const { run, ox, oy } = P;
  // try the nominal spot, then shifted along the deck, to keep piers off roads / tracks below
  for (const dsh of [0, 5, -5, 9, -9, 13, -13]) {
    if (Math.abs(dsh) > sp * 0.4) continue;
    const ss = s + dsh;
    const [k, t] = locate(run, ss);
    const Lk = (A: number[]) => A[k] + (A[k + 1] - A[k]) * t;
    const x = Lk(run.x), y = Lk(run.y), zc = Lk(P.zc);
    const nx = Lk(ox), ny = Lk(oy);
    const l = Math.hypot(nx, ny) || 1;
    const ml = edge(t < 0.5 ? k : k + 1, 1), mr = edge(t < 0.5 ? k : k + 1, -1);
    const g = terr.at(x, y);
    const bottom = zc - depth;
    if (bottom - g < 1.6) return; // low deck: no pier (slab / culvert)
    const width = ml + mr;
    const cxOff = (ml - mr) / 2;
    const ang = Math.atan2(ny, nx);
    // column positions across the deck
    let cols: number[];
    if (st === ST_HAMMER || (st === ST_GIRDER && width < 13)) cols = [cxOff];
    else if (st === ST_FOOT) cols = [cxOff];
    else {
      const nc = Math.max(2, Math.min(4, Math.round(width / 11) + 1));
      cols = Array.from({ length: nc }, (_, i) => cxOff - width / 2 + 1.6 + (i * (width - 3.2)) / (nc - 1));
    }
    let clear = true;
    for (const cu of cols) {
      const px = x + (nx / l) * cu, py = y + (ny / l) * cu;
      if (atGrade.hit(px, py, 1.2, bottom - 2)) { clear = false; break; }
    }
    if (!clear) continue;
    const colW = st === ST_FOOT ? 0.35 : st === ST_HAMMER ? 1.1 : 0.6;
    const colL = st === ST_FOOT ? 0.35 : st === ST_HAMMER ? 1.6 : 0.9;
    const capH = st === ST_FOOT ? 0.4 : 1.2;
    for (const cu of cols) {
      const px = x + (nx / l) * cu, py = y + (ny / l) * cu;
      const gb = terr.at(px, py) - 0.5;
      b.box(px, py, gb, bottom - capH + 0.05, ang, colW, colL, SURF_STRUCT, CONCRETE, 6.5);
    }
    // cap beam across the deck (hammerhead: tapered look via a narrower cap)
    const capHalf = st === ST_HAMMER ? width / 2 - 0.5 : width / 2 - 0.3;
    b.box(x + (nx / l) * cxOff, y + (ny / l) * cxOff, bottom - capH, bottom, ang, capHalf, 0.8, SURF_STRUCT, CONCRETE, 6.5);
    return;
  }
}

function truss(b: RoadBuilder, P: Prep, k0: number, k1: number, edge: (k: number, sd: number) => number) {
  const { run, ox, oy, zc } = P;
  const H = 7.5, panel = 10;
  for (const sd of [1, -1]) {
    // top chord + diagonals as thin double-sided ribbons
    const pts: { x: number; y: number; z: number; s: number }[] = [];
    const sA = run.s[k0], sB = run.s[k1];
    for (let s = sA; s <= sB + 0.01; s += panel) {
      const [k, t] = locate(run, Math.min(s, sB));
      const Lk = (A: number[]) => A[k] + (A[k + 1] - A[k]) * t;
      const m = edge(t < 0.5 ? k : k + 1, sd) - 0.3;
      pts.push({ x: Lk(run.x) + sd * Lk(ox) * m, y: Lk(run.y) + sd * Lk(oy) * m, z: Lk(zc), s });
    }
    b.plain(SURF_STRUCT, STEEL_G, 6.5);
    const beam = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, w: number) => {
      // a vertical flat bar (double-sided) from p0 to p1
      b.n = [0, 1, 0];
      const A = b.v(x0, z0 - w, -y0, 0, 0), B = b.v(x1, z1 - w, -y1, 1, 0), C = b.v(x1, z1 + w, -y1, 1, 1), D = b.v(x0, z0 + w, -y0, 0, 1);
      b.q(A, B, C, D); b.q(A, D, C, B);
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      beam(p.x, p.y, p.z + H, q.x, q.y, q.z + H, 0.35);
      beam(p.x, p.y, p.z + 0.6, q.x, q.y, q.z + 0.6, 0.35);
      beam(p.x, p.y, p.z + (i % 2 ? H : 0.3), q.x, q.y, q.z + (i % 2 ? 0.3 : H), 0.25);
    }
    for (const p of pts) b.box(p.x, p.y, p.z, p.z + H, 0, 0.18, 0.18, SURF_STRUCT, STEEL_G, 6.5);
  }
}

/** side slopes (grass, 1:2) or retaining walls where the road sits above the ground off a bridge */
function embankment(b: RoadBuilder, P: Prep, swAll: number, ws: number, terr: Terrain) {
  const { run, ox, oy, zc, lift, c } = P;
  const nv = run.x.length;
  const up = (k: number) => !(run.vf[k] & (V_BRIDGE | V_TUNNEL)) && (run.vf[k] & V_GRADED) !== 0 && zc[k] - terr.at(run.x[k], run.y[k]) > 0.35;
  for (const [k0, k1] of vRanges(run, up)) {
    const a0 = Math.max(0, k0 - 1), a1 = Math.min(nv - 1, k1 + 1);
    for (const sd of [1, -1]) {
      const bit = sd > 0 ? SW_L : SW_R;
      const wall = c >= 2 && c <= 6 && (swAll & 3) !== 0;
      const top: number[] = [], foot: number[] = [];
      if (wall) b.plain(SURF_STRUCT, CONCRETE, 6); else b.plain(SURF_GRASS, [255, 255, 255], 0.8);
      for (let k = a0; k <= a1; k++) {
        const m = (sd > 0 ? run.pl[k] : run.pr[k]) + (run.sw[k] & bit ? ws + 0.3 : 0.2);
        const l = Math.hypot(ox[k], oy[k]) || 1;
        const ex = run.x[k] + sd * ox[k] * m, ey = run.y[k] + sd * oy[k] * m;
        const zt = zc[k] + lift + (run.sw[k] & bit ? CURB_H : 0);
        const h = Math.max(0, zt - terr.at(ex, ey));
        const out = wall ? 0.05 : Math.min(2 * h, 30);
        const fx = ex + sd * (ox[k] / l) * out, fy = ey + sd * (oy[k] / l) * out;
        b.n = wall ? [sd * ox[k] / l, 0, -sd * oy[k] / l] : [0, 1, 0];
        top.push(b.v(ex, zt, -ey, sd * m, run.s[k]));
        foot.push(b.v(fx, terr.at(fx, fy) - (wall ? 0.4 : 0.1), -fy, sd * (m + out), run.s[k]));
      }
      for (let k = 0; k < top.length - 1; k++) {
        if (sd > 0) b.q(foot[k], top[k], top[k + 1], foot[k + 1]); else b.q(foot[k], foot[k + 1], top[k + 1], top[k]);
      }
    }
  }
}

// ---------------------------------------------------------------------------- junction surfaces etc.

/** subdivide a triangle until edges are <= maxE (drapes flat triangles on terrain) */
function subTris(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, maxE: number, out: number[], depth = 0, terr?: Terrain) {
  const ab = Math.hypot(bx - ax, by - ay), bc = Math.hypot(cx - bx, cy - by), ca = Math.hypot(ax - cx, ay - cy);
  const m = Math.max(ab, bc, ca);
  // split only where the terrain under the triangle is not planar (flat junctions stay 1 triangle)
  let flat = false;
  if (terr && m > maxE) {
    const ha = terr.at(ax, ay), hb = terr.at(bx, by), hcc = terr.at(cx, cy);
    const dev = (x: number, y: number, h: number) => Math.abs(terr.at(x, y) - h);
    flat = dev((ax + bx + cx) / 3, (ay + by + cy) / 3, (ha + hb + hcc) / 3) < 0.05
      && dev((ax + bx) / 2, (ay + by) / 2, (ha + hb) / 2) < 0.05
      && dev((bx + cx) / 2, (by + cy) / 2, (hb + hcc) / 2) < 0.05
      && dev((cx + ax) / 2, (cy + ay) / 2, (hcc + ha) / 2) < 0.05;
  }
  if (m <= maxE || depth > 4 || flat) { out.push(ax, ay, bx, by, cx, cy); return; }
  if (m === ab) { const mx = (ax + bx) / 2, my = (ay + by) / 2; subTris(ax, ay, mx, my, cx, cy, maxE, out, depth + 1, terr); subTris(mx, my, bx, by, cx, cy, maxE, out, depth + 1, terr); }
  else if (m === bc) { const mx = (bx + cx) / 2, my = (by + cy) / 2; subTris(ax, ay, bx, by, mx, my, maxE, out, depth + 1, terr); subTris(ax, ay, mx, my, cx, cy, maxE, out, depth + 1, terr); }
  else { const mx = (cx + ax) / 2, my = (cy + ay) / 2; subTris(ax, ay, bx, by, mx, my, maxE, out, depth + 1, terr); subTris(mx, my, bx, by, cx, cy, maxE, out, depth + 1, terr); }
}

function polyMesh(b: RoadBuilder, xy: Float32Array, tri: Uint32Array, terr: Terrain, yOff: number) {
  const tmp: number[] = [];
  b.n = [0, 1, 0];
  for (let t = 0; t < tri.length; t += 3) {
    const i0 = tri[t], i1 = tri[t + 1], i2 = tri[t + 2];
    tmp.length = 0;
    subTris(xy[i0 * 2], xy[i0 * 2 + 1], xy[i1 * 2], xy[i1 * 2 + 1], xy[i2 * 2], xy[i2 * 2 + 1], 10, tmp, 0, terr);
    for (let k = 0; k < tmp.length; k += 6) {
      const V = (x: number, y: number) => b.v(x, terr.at(x, y) + yOff, -y, 0, 0);
      // earcut output is CCW in (E, N); three.js z = -N flips it -> reverse
      b.t(V(tmp[k], tmp[k + 1]), V(tmp[k + 4], tmp[k + 5]), V(tmp[k + 2], tmp[k + 3]));
    }
  }
}

function junctionSurfaces(b: RoadBuilder, a: Record<string, TypedArray>, terr: Terrain) {
  const jsxy = a.js_xy as Float32Array | undefined, jstri = a.js_tri as Uint32Array | undefined;
  if (jsxy && jstri) {
    b.plain(SURF_ROAD, [255, 255, 255], 5.8, 3);
    b.code = 3 + 32 * SURF_ROAD; b.mk = 0; b.eL = b.eR = 0;
    polyMesh(b, jsxy, jstri, terr, 0.05);
  }
  const jwxy = a.jw_xy as Float32Array | undefined, jwtri = a.jw_tri as Uint32Array | undefined;
  if (jwxy && jwtri) {
    b.plain(SURF_SIDEWALK, [255, 255, 255], 7, 3);
    polyMesh(b, jwxy, jwtri, terr, 0.05 + CURB_H);
  }
  // curb faces along the curb returns (double-sided strip)
  const jco = a.jc_off as Uint32Array | undefined, jcxy = a.jc_xy as Float32Array | undefined;
  if (jco && jcxy) {
    b.plain(SURF_CURB, [255, 255, 255], 7, 3);
    for (let i = 0; i < jco.length - 1; i++) {
      let prev: number[] | null = null;
      let s = 0;
      for (let k = jco[i]; k < jco[i + 1]; k++) {
        const x = jcxy[k * 2], y = jcxy[k * 2 + 1];
        if (k > jco[i]) s += Math.hypot(x - jcxy[k * 2 - 2], y - jcxy[k * 2 - 1]);
        const g = terr.at(x, y);
        b.n = [0, 1, 0];
        // lines run with the road surface on their left (tpipe.roadnet orients them): face left
        const k2 = Math.min(k + 1, jco[i + 1] - 1), k1 = Math.max(k - 1, jco[i]);
        const dx = jcxy[k2 * 2] - jcxy[k1 * 2], dy = jcxy[k2 * 2 + 1] - jcxy[k1 * 2 + 1], dl = Math.hypot(dx, dy) || 1;
        b.n = [-dy / dl, 0, -dx / dl];
        const cur = [b.v(x, g, -y, 0, s), b.v(x, g + 0.05 + CURB_H, -y, 0, s)];
        if (prev) b.q(prev[0], prev[1], cur[1], cur[0]);
        prev = cur;
      }
    }
  }
  // tactile walking surface indicators: Toronto's cast-iron plates (dark, rust patina), 0.61 m deep
  const jt = a.jt_xy as Float32Array | undefined, ja = a.jt_ang as Float32Array | undefined;
  if (jt && ja) {
    b.plain(SURF_TACTILE, [255, 255, 255], 7.5);
    for (let i = 0; i < ja.length; i++) {
      const x = jt[i * 2], y = jt[i * 2 + 1], ang = ja[i];
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const g = terr.at(x, y) + 0.05 + CURB_H + 0.012;
      // plate: 0.61 m toward the road (along ang... pad centred on the ramp), 1.5 m wide along the curb
      const hl = 0.305, hwid = 0.75;
      const P = (u: number, v: number) => [x + ca * u - sa * v, y + sa * u + ca * v];
      const c = [P(-hl, -hwid), P(hl, -hwid), P(hl, hwid), P(-hl, hwid)];
      b.n = [0, 1, 0];
      const idx = c.map((p, k) => b.v(p[0], g, -p[1], k === 1 || k === 2 ? 0.61 : 0, k >= 2 ? 1.5 : 0));
      b.q(idx[0], idx[3], idx[2], idx[1]);
    }
  }
}

function medians(b: RoadBuilder, a: Record<string, TypedArray>, terr: Terrain) {
  const mo = a.md_off as Uint32Array | undefined, mx = a.md_xyz as Float32Array | undefined, mw = a.md_w as Float32Array | undefined;
  const mk = a.md_kind as Uint8Array | undefined;
  if (!mo || !mx || !mw || !mk) return;
  for (let i = 0; i < mo.length - 1; i++) {
    const r = { x: [] as number[], y: [] as number[] };
    for (let k = mo[i]; k < mo[i + 1]; k++) { r.x.push(mx[k * 3]); r.y.push(mx[k * 3 + 1]); }
    if (r.x.length < 2) continue;
    const { ox, oy } = offsets(r);
    const kind = mk[i];
    const topSurf = kind === 0 ? SURF_SIDEWALK : SURF_GRASS;
    const H = kind === 2 ? 0.12 : CURB_H + 0.02;
    const L: number[] = [], R: number[] = [], cL: number[] = [], cR: number[] = [];
    const cum: number[] = [0];
    for (let k = 1; k < r.x.length; k++) cum.push(cum[k - 1] + Math.hypot(r.x[k] - r.x[k - 1], r.y[k] - r.y[k - 1]));
    const tot = cum[cum.length - 1];
    let s = 0;
    for (let k = 0; k < r.x.length; k++) {
      // rounded / pointed noses at the ends (crosswalk refuges): taper over the last ~4 m
      const nose = Math.min(1, Math.max(0.12, Math.min(cum[k], tot - cum[k]) / 4));
      const w = (mw[mo[i] + k] / 2 - 0.02) * Math.sqrt(nose);
      s = cum[k];
      const l = Math.hypot(ox[k], oy[k]) || 1;
      const lx = r.x[k] + ox[k] / l * w, ly = r.y[k] + oy[k] / l * w, rx = r.x[k] - ox[k] / l * w, ry = r.y[k] - oy[k] / l * w;
      const gl = terr.at(lx, ly) + 0.05, gr = terr.at(rx, ry) + 0.05;
      b.plain(topSurf, [255, 255, 255], 6.8, 3);
      b.n = [0, 1, 0];
      L.push(b.v(lx, gl + H, -ly, w, s)); R.push(b.v(rx, gr + H, -ry, -w, s));
      b.plain(SURF_CURB, [255, 255, 255], 6.8, 3);
      b.n = [ox[k] / l, 0, -oy[k] / l];
      cL.push(b.v(lx, gl - 0.05, -ly, w, s), b.v(lx, gl + H, -ly, w, s));
      b.n = [-ox[k] / l, 0, oy[k] / l];
      cR.push(b.v(rx, gr - 0.05, -ry, -w, s), b.v(rx, gr + H, -ry, -w, s));
    }
    for (let k = 0; k < L.length - 1; k++) {
      b.q(R[k], R[k + 1], L[k + 1], L[k]);
      b.q(cL[2 * k], cL[2 * k + 2], cL[2 * k + 3], cL[2 * k + 1]);
      b.q(cR[2 * k + 2], cR[2 * k], cR[2 * k + 1], cR[2 * k + 3]);
    }
  }
}

// ---------------------------------------------------------------------------- rail

const RAIL_BALLAST = [150, 140, 128];
const BALLAST_TOP = 0.25;
const RAIL_STEEL = [118, 112, 106];

export function buildRail(a: Record<string, TypedArray>, terr: Terrain, level: number): { mesh: MeshBuf | null; count: number } {
  const off = a.l_off as Uint32Array | undefined;
  if (!off || off.length < 2) return { mesh: null, count: 0 };
  const xyz = a.l_xyz as Float32Array, cls = a.l_class as Uint8Array, flags = a.l_flags as Uint8Array;
  const vfA = a.l_vf as Uint8Array | undefined, dzA = a.l_dz as Float32Array | undefined;
  const n = off.length - 1;
  const S = terr.S;
  const b = new RoadBuilder(xyz.length / 3 * 10, xyz.length / 3 * 30);
  const widen = [1, 2, 4][level] ?? 1;
  let count = 0;
  // streets below rail bridges: piers stay off the carriageway (+ a sidewalk's width)
  const roadGrid = new SegGrid();
  {
    const ro = a.r_off as Uint32Array | undefined, rx = a.r_xyz as Float32Array | undefined;
    const rvf = a.r_vf as Uint8Array | undefined, rpl = a.r_pl as Float32Array | undefined, rpr = a.r_pr as Float32Array | undefined;
    const rc = a.r_class as Uint8Array | undefined;
    if (level === 0 && ro && rx && rpl && rpr) for (let i = 0; i < ro.length - 1; i++) {
      if (rc && rc[i] >= 9) continue;
      for (let k = ro[i]; k < ro[i + 1] - 1; k++) {
        if (rvf && rvf[k] & (V_BRIDGE | V_TUNNEL)) continue;
        const hw = Math.max(rpl[k], rpr[k]) + (rc && rc[i] >= 8 ? 0.3 : 2.0);
        roadGrid.add({ x0: rx[k * 3], y0: rx[k * 3 + 1], x1: rx[k * 3 + 3], y1: rx[k * 3 + 4], hw, z: rx[k * 3 + 2] });
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const f = flags ? flags[i] : 0;
    const c = cls[i] ?? 0;
    const tram = c === 4;
    if (tram && level > 0) continue; // streetcar track reads as part of the road from afar
    const src: Src = { xyz, vf: vfA, dz: dzA, hw: 1.8, v0: 0, mk0: 0, lw0: 3.6 };
    for (const run0 of clipRuns(src, off[i], off[i + 1], -0.01, S + 0.01)) {
      if (!vfA) for (let k = 0; k < run0.x.length; k++) run0.vf[k] = (f & 2 ? V_BRIDGE | V_GRADED : 0) | (f & 4 ? V_TUNNEL : 0);
      if (run0.vf.every((v) => (v & V_TUNNEL) !== 0)) continue; // tunnels (most subway) hidden in normal view
      const run = refine(run0, terr.cell, [], level === 0 ? 10 : 30);
      const nv = run.x.length;
      const { ox, oy, tx, ty } = offsets(run);
      const z: number[] = new Array(nv);
      for (let k = 0; k < nv; k++) {
        const vf = run.vf[k];
        const t0 = terr.at(run.x[k], run.y[k]);
        const dz = dzA ? run.dz[k] : 0;
        const wAbs = vf & V_BRIDGE ? 1 : vf & V_GRADED ? Math.min(1, Math.max(0, (dz - 1.5) / 3)) : 0;
        const zDr = t0 + (vf & V_GRADED ? ((vf & V_TUNNEL) ? dz : Math.max(dz, 0)) : 0);
        z[k] = zDr + (run.z[k] - zDr) * wAbs;
      }
      count++;
      const P: Prep = { run, ox, oy, tx, ty, zc: z, zl: z, zr: z, structZ: z, c: 8, f, feats: [], lift: 0.35 };
      const vis = (k: number) => !((run.vf[k] & V_TUNNEL) && (k === 0 || run.vf[k - 1] & V_TUNNEL));
      const hwB = ((c === 1 ? 2.8 : 3.6) * widen) / 2;
      if (!tram) {
        for (const [k0, k1] of vRanges(run, vis)) {
          // ballast / grass bed / embedded panel per vertex
          ballast(b, P, k0, k1, hwB, c, level);
        }
        if (level === 0) {
          // raised approaches (graded above the ground off the span): grass fill slopes, so an
          // abutment never stands in the air with the track floating behind it
          for (let k = 0; k < nv; k++) if (!(run.vf[k] & V_BRIDGE)) { run.pl[k] = run.pr[k] = hwB + 0.2; run.sw[k] = 0; }
          embankment(b, { ...P, lift: 0.03 }, 0, 0, terr);
          for (const [k0, k1] of vRanges(run, (k) => (run.vf[k] & V_BRIDGE) !== 0)) {
            for (let k = k0; k <= k1; k++) { run.pl[k] = run.pr[k] = hwB + 0.6; run.sw[k] = 0; }
            const P2: Prep = { ...P, c: 9, lift: 0.35 };
            const st = struct(run.vf[Math.floor((k0 + k1) / 2)]);
            if (!st) for (let k = k0; k <= k1; k++) run.vf[k] |= ST_RAIL << 4;
            bridge(b, P2, k0, k1, 0, terr, roadGrid);
          }
        }
      }
      if (level === 0) {
        // two rails, standard gauge 1.435 m (TTC streetcar 1.495 m)
        const g = tram ? 0.7475 : 0.7175;
        for (const [k0, k1] of vRanges(run, vis)) {
          for (const s of [-g, g]) railLine(b, P, k0, k1, s, 0.055, c + 32 * SURF_STEEL, RAIL_STEEL, tram ? 8 : 2, tram);
        }
      }
    }
  }
  return { mesh: b.finish(), count };
}

function ballast(b: RoadBuilder, P: Prep, k0: number, k1: number, hw: number, c: number, level: number) {
  const { run, ox, oy, zc } = P;
  const bc = c === 2 ? [140, 134, 128] : c === 3 ? [140, 140, 130] : RAIL_BALLAST;
  const cols = (k: number, kind: number) => {
    const vf = run.vf[k];
    const br = (vf & V_BRIDGE) !== 0;
    const lift = kind === 2 ? 0.07 : br ? 0.35 : 0.03;
    const x = run.x[k], y = run.y[k];
    if (kind === 2) b.plain(SURF_PANEL, [255, 255, 255], 6.2, c);
    else if (kind === 1) b.plain(SURF_GRASS, [235, 255, 225], 7.1, c);
    else b.plain(SURF_BALLAST, bc, 0.5, c);
    b.eL = b.eR = hw;
    b.n = [0, 1, 0];
    const top = kind === 0 && level === 0 ? BALLAST_TOP : 0; // ballast shoulder profile
    const wTop = kind === 0 && level === 0 ? hw - 0.6 : hw;
    return [
      b.v(x + ox[k] * hw, zc[k] + lift, -(y + oy[k] * hw), hw, run.s[k]),
      b.v(x + ox[k] * wTop, zc[k] + lift + top, -(y + oy[k] * wTop), wTop, run.s[k]),
      b.v(x - ox[k] * wTop, zc[k] + lift + top, -(y - oy[k] * wTop), -wTop, run.s[k]),
      b.v(x - ox[k] * hw, zc[k] + lift, -(y - oy[k] * hw), -hw, run.s[k]),
    ];
  };
  const kindOf = (k: number) => (run.vf[k] & V_EMBED ? 2 : (run.vf[k] >> 4) === ST_GRASS ? 1 : 0);
  let prev: number[] | null = null;
  let prevKind = -1;
  for (let k = k0; k <= k1; k++) {
    const kind = kindOf(k);
    if (prev && prevKind !== kind) {
      const close = cols(k, prevKind);
      for (let q = 0; q < 3; q++) b.q(prev[q + 1], close[q + 1], close[q], prev[q]);
      prev = null;
    }
    const cur = cols(k, kind);
    if (prev) for (let q = 0; q < 3; q++) b.q(prev[q + 1], cur[q + 1], cur[q], prev[q]);
    prev = cur; prevKind = kind;
  }
}

function railLine(b: RoadBuilder, P: Prep, k0: number, k1: number, u: number, hw: number, code: number, rgb: number[], prio: number, tram: boolean) {
  const { run, ox, oy, zc } = P;
  let prev: number[] | null = null;
  for (let k = k0; k <= k1; k++) {
    const vf = run.vf[k];
    const embedded = tram || (vf & V_EMBED) !== 0;
    const lift = embedded ? 0.09 : (vf & V_BRIDGE ? 0.35 : 0.03) + BALLAST_TOP + 0.16;
    // embedded rail must win over junction surfaces (5.8) and track panels
    b.code = code; b.eL = b.eR = hw; b.n = [0, 1, 0]; b.c = [rgb[0], rgb[1], rgb[2], Math.round((embedded ? Math.max(prio, 8) : prio) * 25)]; b.j = [FAR, FAR, 0, 0];
    b.mk = embedded ? 1 : 0; b.fx = 0;
    const l = Math.hypot(ox[k], oy[k]) || 1;
    const nx = ox[k] / l, ny = oy[k] / l;
    const cx = run.x[k] + nx * u, cy = run.y[k] + ny * u;
    const cur = [b.v(cx + nx * hw, zc[k] + lift, -(cy + ny * hw), hw, run.s[k]), b.v(cx - nx * hw, zc[k] + lift, -(cy - ny * hw), -hw, run.s[k])];
    if (prev) b.q(prev[1], cur[1], cur[0], prev[0]);
    prev = cur;
  }
}
