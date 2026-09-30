// Street-level meshing: road ribbons with junction-aware marking attributes,
// curbs + raised sidewalks, highway barriers, bridge parapets and rail/tram
// tracks. Output coordinates are tile-local three.js axes (x = E, y = elev,
// z = -N). The road shader (render/tiles/roadMaterial.ts) draws asphalt,
// lane lines, crosswalks and stop bars procedurally from these attributes:
//
//   rd = (u, v, halfWidth, code)   u across (m, +left of travel), v along (m, world-continuous)
//        code = cls + 16·min(lanes,15) + 256·oneway + 512·surf
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
  SURF_PAVERS = 5, SURF_STEEL = 6, SURF_BALLAST = 7, SURF_STRUCT = 8;
// feature types in jn.zw
export const FEAT_NONE = 0, FEAT_JUNCTION = 1, FEAT_SIGNAL = 2, FEAT_ZEBRA = 3, FEAT_LINES = 4, FEAT_STOP = 5;
const FAR = 1e4;

export const ROAD_W_DEFAULT = [24, 18, 14, 12, 10, 8, 5, 5, 2.2, 3];
const SIDEWALK_W = [0, 0, 3.2, 2.8, 2.4, 1.9];
const CURB_H = 0.15;
// ground classes where roads get curbs + sidewalks when OSM doesn't say otherwise
const URBAN = new Set([2, 4, 5, 6, 11, 12, 17, 18, 19, 21, 22]);

// ---------------------------------------------------------------------------- builder

export class RoadBuilder {
  pos: Float32Array; nrm: Int8Array; col: Uint8Array; rd: Float32Array; jn: Float32Array; idx: Uint32Array;
  nv = 0; ni = 0;
  constructor(vcap = 4096, icap = 8192) {
    this.pos = new Float32Array(vcap * 3); this.nrm = new Int8Array(vcap * 4); this.col = new Uint8Array(vcap * 4);
    this.rd = new Float32Array(vcap * 4); this.jn = new Float32Array(vcap * 4); this.idx = new Uint32Array(icap);
  }
  private growV(n: number) {
    if (this.nv + n <= this.pos.length / 3) return;
    const cap = Math.max((this.pos.length / 3) * 2, this.nv + n);
    const g = <T extends Float32Array | Int8Array | Uint8Array>(a: T, k: number): T => {
      const b = new (a.constructor as new (n: number) => T)(cap * k); b.set(a); return b;
    };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 4); this.col = g(this.col, 4); this.rd = g(this.rd, 4); this.jn = g(this.jn, 4);
  }
  /** current per-vertex state written by v() */
  c = [255, 255, 255, 0];
  code = 0;
  hw = 0;
  j = [FAR, FAR, 0, 0];
  n = [0, 1, 0];
  v(x: number, y: number, z: number, u: number, along: number): number {
    this.growV(1);
    const i = this.nv++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 4] = Math.round(this.n[0] * 127); this.nrm[i * 4 + 1] = Math.round(this.n[1] * 127); this.nrm[i * 4 + 2] = Math.round(this.n[2] * 127);
    this.col[i * 4] = this.c[0]; this.col[i * 4 + 1] = this.c[1]; this.col[i * 4 + 2] = this.c[2]; this.col[i * 4 + 3] = this.c[3];
    this.rd[i * 4] = u; this.rd[i * 4 + 1] = along; this.rd[i * 4 + 2] = this.hw; this.rd[i * 4 + 3] = this.code;
    this.jn[i * 4] = this.j[0]; this.jn[i * 4 + 1] = this.j[1]; this.jn[i * 4 + 2] = this.j[2]; this.jn[i * 4 + 3] = this.j[3];
    return i;
  }
  t(a: number, b: number, c: number) {
    if (this.ni + 3 > this.idx.length) { const q = new Uint32Array(Math.max(this.idx.length * 2, this.ni + 3)); q.set(this.idx); this.idx = q; }
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }
  /** quad a-b-c-d (CCW seen from the front) */
  q(a: number, b: number, c: number, d: number) { this.t(a, b, c); this.t(a, c, d); }
  finish(): MeshBuf | null {
    if (this.ni === 0) return null;
    const index = this.nv < 65536 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    return {
      position: this.pos.slice(0, this.nv * 3), normal: this.nrm.slice(0, this.nv * 4), color: this.col.slice(0, this.nv * 4), index,
      attrs: { rd: { array: this.rd.slice(0, this.nv * 4), size: 4 }, jn: { array: this.jn.slice(0, this.nv * 4), size: 4 } },
    };
  }
}

// ---------------------------------------------------------------------------- polyline helpers

/** A run: polyline points (x, n, z) with world-continuous along-distance s. */
interface Run { x: number[]; y: number[]; z: number[]; s: number[] }

/** clip a polyline to [lo, hi]² (Liang–Barsky per segment); returns inside runs */
function clipRuns(xyz: Float32Array, a: number, b: number, v0: number, lo: number, hi: number): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  let s = v0;
  for (let i = a; i < b - 1; i++) {
    const x0 = xyz[i * 3], y0 = xyz[i * 3 + 1], z0 = xyz[i * 3 + 2];
    const x1 = xyz[i * 3 + 3], y1 = xyz[i * 3 + 4], z1 = xyz[i * 3 + 5];
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
    if (ok && t1 - t0 > 1e-9) {
      if (!cur || t0 > 1e-9) {
        cur = { x: [], y: [], z: [], s: [] };
        runs.push(cur);
        cur.x.push(x0 + dx * t0); cur.y.push(y0 + dy * t0); cur.z.push(z0 + (z1 - z0) * t0); cur.s.push(s + len * t0);
      }
      cur.x.push(x0 + dx * t1); cur.y.push(y0 + dy * t1); cur.z.push(z0 + (z1 - z0) * t1); cur.s.push(s + len * t1);
      if (t1 < 1 - 1e-9) cur = null;
    } else {
      cur = null;
    }
    s += len;
  }
  return runs.filter((r) => r.x.length >= 2 && r.s[r.s.length - 1] - r.s[0] > 0.05);
}

/**
 * Insert vertices where the centreline crosses the terrain triangulation
 * (grid lines x = i·c, y = j·c and the diagonals x − y = k·c) plus any extra
 * along-distances in `cuts`, so draped geometry follows the rendered terrain.
 */
function refine(r: Run, cell: number, cuts: number[], drape: boolean): Run {
  const out: Run = { x: [r.x[0]], y: [r.y[0]], z: [r.z[0]], s: [r.s[0]] };
  const ts: number[] = [];
  for (let i = 0; i < r.x.length - 1; i++) {
    const x0 = r.x[i], y0 = r.y[i], x1 = r.x[i + 1], y1 = r.y[i + 1], s0 = r.s[i], s1 = r.s[i + 1];
    ts.length = 0;
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
    for (const c of cuts) {
      if (c > s0 + 0.01 && c < s1 - 0.01) ts.push((c - s0) / (s1 - s0));
    }
    // cap segment length (bridge profiles; far levels are coarse anyway)
    const n = Math.ceil((s1 - s0) / Math.max(25, cell));
    for (let k = 1; k < n; k++) ts.push(k / n);
    ts.sort((p, q) => p - q);
    let last = 0;
    for (const t of ts) {
      if (t - last < 1e-3) continue;
      out.x.push(x0 + (x1 - x0) * t); out.y.push(y0 + (y1 - y0) * t); out.z.push(r.z[i] + (r.z[i + 1] - r.z[i]) * t); out.s.push(s0 + (s1 - s0) * t);
      last = t;
    }
    out.x.push(x1); out.y.push(y1); out.z.push(r.z[i + 1]); out.s.push(s1);
  }
  return out;
}

/** left offset unit-ish vectors (miter-scaled) per vertex */
function offsets(r: Run): { ox: number[]; oy: number[]; tx: number[]; ty: number[] } {
  const n = r.x.length;
  const ox: number[] = new Array(n), oy: number[] = new Array(n), tx: number[] = new Array(n), ty: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, n - 1);
    let d0x = r.x[i] - r.x[i0], d0y = r.y[i] - r.y[i0];
    let d1x = r.x[i1] - r.x[i], d1y = r.y[i1] - r.y[i];
    const l0 = Math.hypot(d0x, d0y), l1 = Math.hypot(d1x, d1y);
    if (l1 > 1e-6) { d1x /= l1; d1y /= l1; }
    if (l0 > 1e-6) { d0x /= l0; d0y /= l0; } else { d0x = d1x; d0y = d1y; }
    if (l1 <= 1e-6) { d1x = d0x; d1y = d0y; }
    let sx = d0x + d1x, sy = d0y + d1y;
    const sl = Math.hypot(sx, sy);
    if (sl < 1e-6) { sx = d1x; sy = d1y; } else { sx /= sl; sy /= sl; }
    const px = -sy, py = sx;
    const m = 1 / Math.max(0.5, Math.abs(px * -d1y + py * d1x) || 1);
    ox[i] = px * m; oy[i] = py * m; tx[i] = sx; ty[i] = sy;
  }
  return { ox, oy, tx, ty };
}

// ---------------------------------------------------------------------------- junctions / crossings

interface JArm { ang: number; r: number; hw: number; flags: number }
interface Junction { x: number; y: number; flags: number; osm: number; arms: JArm[] }

const hkey = (x: number, y: number) => `${Math.round(x * 20)},${Math.round(y * 20)}`;

export function readJunctions(a: Record<string, TypedArray>): Junction[] {
  const xy = a.j_xy as Float32Array | undefined;
  if (!xy) return [];
  const off = a.j_arm_off as Uint32Array, ang = a.j_arm_ang as Float32Array, r = a.j_arm_r as Float32Array;
  const hw = a.j_arm_hw as Float32Array, af = a.j_arm_flags as Uint8Array, fl = a.j_flags as Uint8Array, osm = a.j_osm as Float64Array;
  const out: Junction[] = [];
  for (let i = 0; i < xy.length / 2; i++) {
    const arms: JArm[] = [];
    for (let k = off[i]; k < off[i + 1]; k++) arms.push({ ang: ang[k], r: r[k], hw: hw[k], flags: af[k] });
    out.push({ x: xy[i * 2], y: xy[i * 2 + 1], flags: fl[i], osm: osm[i], arms });
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
}

export interface RoadOut { mesh: MeshBuf | null; count: number; streets: StreetRoad[]; junctions: Junction[] }

export function buildRoads(a: Record<string, TypedArray>, terr: Terrain, level: number, ground: Uint8Array | null): RoadOut {
  const off = a.r_off as Uint32Array | undefined;
  const junctions = level === 0 ? readJunctions(a) : [];
  if (!off || off.length < 2) return { mesh: null, count: 0, streets: [], junctions };
  const xyz = a.r_xyz as Float32Array, cls = a.r_class as Uint8Array, wid = a.r_width as Float32Array, flags = a.r_flags as Uint8Array;
  const lanesA = a.r_lanes as Uint8Array | undefined, sideA = a.r_side as Uint8Array | undefined, v0A = a.r_v0 as Float32Array | undefined;
  const n = off.length - 1;
  const S = terr.S;
  const b = new RoadBuilder(xyz.length / 3 * 8, xyz.length / 3 * 24);
  const widen = [1, 1.6, 3.2][level] ?? 1;
  const streets: StreetRoad[] = [];

  // junction + crossing lookup by exact vertex position
  const jmap = new Map<string, Junction>();
  for (const j of junctions) jmap.set(hkey(j.x, j.y), j);
  const xmap = new Map<string, number>();
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined, pv = a.p_var as Uint8Array | undefined;
  if (level === 0 && pk && pxy && pv) for (let i = 0; i < pk.length; i++) if (pk[i] === 2 && pv[i] > 0) xmap.set(hkey(pxy[i * 2], pxy[i * 2 + 1]), pv[i] === 1 ? FEAT_ZEBRA : FEAT_LINES);

  const groundAt = (x: number, y: number) => {
    if (!ground) return 0;
    const i = Math.min(255, Math.max(0, Math.floor((x / S) * 256))), j = Math.min(255, Math.max(0, Math.floor((y / S) * 256)));
    return ground[j * 256 + i];
  };

  // built-up tile: untagged ("land") ground counts as urban (suburbs often lack landuse polygons)
  const nBuilt = ((a.b_ring_off as Uint32Array | undefined)?.length ?? 1) - 1 + ((a.h_xy as Float32Array | undefined)?.length ?? 0) / 2;
  const urbanSet = nBuilt > 150 ? new Set([...URBAN, 0]) : URBAN;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = flags ? flags[i] : 0;
    if (f & 4) continue; // tunnel
    const c = cls[i] ?? 5;
    const bridge = (f & 2) !== 0;
    const link = (f & 8) !== 0;
    const oneway = (f & 1) !== 0;
    let w = wid && wid[i] > 0 ? wid[i] : ROAD_W_DEFAULT[c] ?? 6;
    w = Math.max(w, c <= 1 ? 10 : 2) * widen;
    const hw = w / 2;
    const lanes = level === 0 && lanesA ? Math.min(15, lanesA[i]) : 0;
    const side = sideA ? sideA[i] : 0;
    const v0 = v0A ? v0A[i] : 0;
    const runs = clipRuns(xyz, off[i], off[i + 1], v0, -0.01, S + 0.01);
    if (!runs.length) continue;
    count++;
    // surface + tint
    let surf = SURF_ROAD;
    let tint = [255, 255, 255];
    if (c === 8) { surf = side === 6 ? SURF_SIDEWALK : SURF_PATH; tint = side === 6 ? [255, 255, 255] : [236, 230, 222]; }
    else if (c === 9) { surf = SURF_PATH; tint = [255, 232, 196]; }
    else if (c === 7) { surf = SURF_PAVERS; }
    if (level > 0) { surf = SURF_ROAD; tint = [255, 255, 255]; }
    const prio = bridge ? 6 : c <= 7 ? 5.5 - c * 0.5 : c === 8 ? 1.5 : 1;
    const code = c + 16 * lanes + 256 * (oneway ? 1 : 0) + 512 * surf;
    const lift = bridge ? 0.1 : 0.03 + (9 - c) * 0.004;
    const markable = level === 0 && c <= 7;
    for (const run0 of runs) {
      // ---- features along the run (junctions, marked crossings)
      const feats: Feat[] = [];
      if (markable) {
        for (let k = 0; k < run0.x.length; k++) {
          const key = hkey(run0.x[k], run0.y[k]);
          const j = jmap.get(key);
          if (j) {
            const pa = k > 0 ? armFor(j, run0.x[k - 1] - run0.x[k], run0.y[k - 1] - run0.y[k]) : null;
            const na = k < run0.x.length - 1 ? armFor(j, run0.x[k + 1] - run0.x[k], run0.y[k + 1] - run0.y[k]) : null;
            const sig = (j.flags & 1) !== 0;
            const typ = (arm: JArm | null) => (sig ? FEAT_SIGNAL : arm && arm.flags & 1 ? FEAT_STOP : FEAT_JUNCTION);
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
          if (ftype !== FEAT_ZEBRA && ftype !== FEAT_LINES) continue;
          if (feats.some((o) => o.signal && Math.abs(o.s - ft.s) < Math.max(o.cutBefore, o.cutAfter) + 10)) feats.splice(k, 1);
        }
      }
      // sidewalks: urban roads classes 2-5, not links/bridges; OSM sidewalk tags respected
      let sw = 0; // bitmask 1 left 2 right
      const ws = (SIDEWALK_W[c] ?? 0);
      let builtUp = false;
      if (level === 0 && c >= 2 && c <= 5 && !bridge && !link) {
        const m = Math.floor(run0.x.length / 2);
        let urban = 0;
        for (const k of [0, m, run0.x.length - 1]) if (urbanSet.has(groundAt(run0.x[k], run0.y[k]))) urban++;
        builtUp = urban >= 2;
        if (side === 2) sw = 1; else if (side === 3) sw = 2; else if (side === 4) sw = 3;
        // untagged / separately mapped: curb + sidewalk where the land around is built up
        else if ((side === 0 || side === 5) && builtUp) sw = 3;
      }
      // cut points for sidewalk ends at junction boxes
      const cuts: number[] = [];
      for (const ft of feats) { cuts.push(ft.s); if (ft.cutBefore) cuts.push(ft.s - ft.cutBefore); if (ft.cutAfter) cuts.push(ft.s + ft.cutAfter); }
      const run = refine(run0, terr.cell, cuts, !bridge);
      const nv = run.x.length;
      const { ox, oy, tx, ty } = offsets(run);
      const zc: number[] = new Array(nv), zl: number[] = new Array(nv), zr: number[] = new Array(nv);
      for (let k = 0; k < nv; k++) {
        if (bridge) { zc[k] = zl[k] = zr[k] = run.z[k]; continue; }
        zc[k] = terr.at(run.x[k], run.y[k]);
        zl[k] = terr.at(run.x[k] + ox[k] * hw, run.y[k] + oy[k] * hw);
        zr[k] = terr.at(run.x[k] - ox[k] * hw, run.y[k] - oy[k] * hw);
      }
      // feature context per vertex: split into spans between features
      const fs = feats.map((ft) => ft.s);
      const spanOf = (sv: number) => { let k = 0; while (k < fs.length && fs[k] <= sv + 1e-4) k++; return k; }; // features before
      b.hw = hw;
      b.code = code;
      b.n = [0, 1, 0];
      b.c = [tint[0], tint[1], tint[2], Math.round(prio * 25)];
      // ---- road surface: 2-3 columns (L, [C,] R), duplicated at feature boundaries
      const wide = hw >= 5 && !bridge && level === 0;
      let prevIdx: number[] | null = null;
      let prevSpan = -1;
      for (let k = 0; k < nv; k++) {
        const sv = run.s[k];
        // a vertex exactly on a feature belongs to both spans
        const onFeat = fs.findIndex((q) => Math.abs(q - sv) < 1e-3);
        const spans = onFeat >= 0 ? [onFeat, onFeat + 1] : [spanOf(sv)];
        for (const sp of spans) {
          const fp = sp > 0 ? feats[sp - 1] : null, fn = sp < feats.length ? feats[sp] : null;
          b.j = [fp ? sv - fp.s : FAR, fn ? fn.s - sv : FAR, fp ? fp.after : 0, fn ? fn.before : 0];
          const x = run.x[k], y = run.y[k];
          const L = b.v(x + ox[k] * hw, zl[k] + lift, -(y + oy[k] * hw), hw, sv);
          const R = b.v(x - ox[k] * hw, zr[k] + lift, -(y - oy[k] * hw), -hw, sv);
          // wide roads get a centre column so the surface follows the terrain across
          const cur = wide ? [L, b.v(x, zc[k] + lift, -y, 0, sv), R] : [L, R, R];
          if (prevIdx && prevSpan === sp) {
            if (wide) {
              b.q(prevIdx[2], cur[2], cur[1], prevIdx[1]);
              b.q(prevIdx[1], cur[1], cur[0], prevIdx[0]);
            } else b.q(prevIdx[1], cur[1], cur[0], prevIdx[0]);
          }
          prevIdx = cur; prevSpan = sp;
        }
      }
      b.j = [FAR, FAR, 0, 0];
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
      // ---- curbs + sidewalks
      if (sw) {
        for (const sd of [1, -1]) {
          if (!(sw & (sd === 1 ? 1 : 2))) continue;
          for (const [ca, cb] of clear) sidewalk(b, run, ox, oy, tx, ty, zl, zr, terr, hw, ws, sd, ca, cb, lift, c);
        }
      }
      if (level === 0 || c <= 3) streets.push({ x: run.x, y: run.y, s: run.s, ox, oy, hw, cls: c, side: sw, ws, clear, urban: builtUp || sw !== 0 });
      // ---- motorway median barrier (left edge of one-way carriageways)
      if (level === 0 && c <= 1 && oneway && !link && !bridge) {
        wallStrip(b, run, ox, oy, zl, hw - 0.35, 0.3, 0.2, 0.85, [205, 202, 196], SURF_BARRIER, 6, lift);
      }
      // ---- bridge decks: side fascia + parapets
      if (bridge && c <= 8) {
        const depth = level === 0 ? 1.4 : 2.5;
        for (const sd of [1, -1]) deckSide(b, run, ox, oy, zc, hw, sd, depth, lift);
        if (level === 0) {
          wallStrip(b, run, ox, oy, zc, hw - 0.15, 0.3, 0.25, 1.05, [196, 192, 186], SURF_STRUCT, 6.5, lift);
          wallStrip(b, run, ox, oy, zc, -(hw - 0.15), 0.3, 0.25, 1.05, [196, 192, 186], SURF_STRUCT, 6.5, lift);
        }
      }
    }
  }
  return { mesh: b.finish(), count, streets, junctions };
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

function sidewalk(b: RoadBuilder, run: Run, ox: number[], oy: number[], tx: number[], ty: number[], zl: number[], zr: number[], terr: Terrain,
  hw: number, ws: number, sd: number, s0: number, s1: number, lift: number, cls: number) {
  // sample points: run vertices inside (s0, s1) plus exact ends
  const pts: { x: number; y: number; ox: number; oy: number; tx: number; ty: number; ze: number; s: number }[] = [];
  const at = (s: number) => {
    const [k, t] = locate(run, s);
    const L = (A: number[]) => A[k] + (A[k + 1] - A[k]) * t;
    pts.push({ x: L(run.x), y: L(run.y), ox: L(ox), oy: L(oy), tx: L(tx), ty: L(ty), ze: sd > 0 ? L(zl) : L(zr), s });
  };
  at(s0);
  for (let k = 0; k < run.s.length; k++) if (run.s[k] > s0 + 0.05 && run.s[k] < s1 - 0.05) at(run.s[k]);
  at(s1);
  if (pts.length < 2) return;
  const top: number[] = [], topO: number[] = [], curbB: number[] = [], curbT: number[] = [];
  b.hw = hw;
  b.code = cls + 512 * SURF_SIDEWALK;
  b.c = [255, 255, 255, 7 * 25];
  const yTop: number[] = [], yOut: number[] = [];
  for (const p of pts) {
    const ex = p.x + sd * p.ox * hw, ey = p.y + sd * p.oy * hw;
    const qx = p.x + sd * p.ox * (hw + ws), qy = p.y + sd * p.oy * (hw + ws);
    const yi = p.ze + lift + CURB_H;
    // outer edge meets the ground (a gentle 15 cm fall across the walk: no outer wall needed)
    const yo = Math.max(terr.at(qx, qy) + lift, yi - CURB_H - 0.02);
    yTop.push(yi); yOut.push(yo);
    b.code = cls + 512 * SURF_SIDEWALK;
    b.n = [0, 1, 0];
    top.push(b.v(ex, yi, -ey, sd * hw, p.s));
    topO.push(b.v(qx, yo, -qy, sd * (hw + ws), p.s));
    // curb face (normal toward the road)
    b.code = cls + 512 * SURF_CURB;
    const l = Math.hypot(p.ox, p.oy) || 1;
    b.n = [-sd * p.ox / l, 0, sd * p.oy / l];
    curbB.push(b.v(ex, p.ze + lift - 0.05, -ey, sd * hw, p.s));
    curbT.push(b.v(ex, yi, -ey, sd * hw, p.s));
  }
  for (let k = 0; k < pts.length - 1; k++) {
    // winding: left side (sd=1) runs along +s with outer at +left
    if (sd > 0) {
      b.q(top[k], top[k + 1], topO[k + 1], topO[k]);
      b.q(curbB[k], curbB[k + 1], curbT[k + 1], curbT[k]);
    } else {
      b.q(top[k + 1], top[k], topO[k], topO[k + 1]);
      b.q(curbB[k + 1], curbB[k], curbT[k], curbT[k + 1]);
    }
  }
  // end caps (facing along -t at the start, +t at the end)
  b.code = cls + 512 * SURF_CURB;
  for (const [pi, dir] of [[0, -1], [pts.length - 1, 1]] as [number, number][]) {
    const p = pts[pi];
    const ex = p.x + sd * p.ox * hw, ey = p.y + sd * p.oy * hw;
    const qx = p.x + sd * p.ox * (hw + ws), qy = p.y + sd * p.oy * (hw + ws);
    b.n = [dir * p.tx, 0, -dir * p.ty];
    const yb = p.ze + lift - 0.05;
    const a0 = b.v(ex, yb, -ey, sd * hw, p.s), a1 = b.v(ex, yTop[pi], -ey, sd * hw, p.s);
    const a2 = b.v(qx, yOut[pi], -qy, sd * (hw + ws), p.s), a3 = b.v(qx, Math.min(yb, yOut[pi]) - 0.2, -qy, sd * (hw + ws), p.s);
    if (dir * sd > 0) b.q(a0, a3, a2, a1); else b.q(a0, a1, a2, a3);
  }
}

/** a solid wall (barrier/parapet) centred at lateral offset `u` */
function wallStrip(b: RoadBuilder, run: Run, ox: number[], oy: number[], z: number[], u: number, wBase: number, wTop: number, h: number,
  rgb: number[], surf: number, prio: number, lift: number) {
  const n = run.x.length;
  b.code = 512 * surf;
  b.hw = Math.abs(u);
  b.c = [rgb[0], rgb[1], rgb[2], prio * 25];
  const cols: number[][] = [];
  for (let k = 0; k < n; k++) {
    const l = Math.hypot(ox[k], oy[k]) || 1;
    const nx = ox[k] / l, ny = oy[k] / l;
    const cx = run.x[k] + nx * u, cy = run.y[k] + ny * u;
    const y0 = z[k] + lift - 0.1, y1 = z[k] + lift + h;
    const P = (d: number, y: number, nn: number[]) => { b.n = nn; return b.v(cx + nx * d, y, -(cy + ny * d), u + d, run.s[k]); };
    // +side face, top, -side face
    cols.push([
      P(wBase, y0, [nx, 0.25, -ny]), P(wTop, y1, [nx, 0.25, -ny]),
      P(wTop, y1, [0, 1, 0]), P(-wTop, y1, [0, 1, 0]),
      P(-wTop, y1, [-nx, 0.25, ny]), P(-wBase, y0, [-nx, 0.25, ny]),
    ]);
  }
  for (let k = 0; k < n - 1; k++) {
    const A = cols[k], B = cols[k + 1];
    b.q(A[0], A[1], B[1], B[0]);
    b.q(A[2], A[3], B[3], B[2]);
    b.q(A[4], A[5], B[5], B[4]);
  }
}

function deckSide(b: RoadBuilder, run: Run, ox: number[], oy: number[], z: number[], hw: number, sd: number, depth: number, lift: number) {
  const n = run.x.length;
  b.code = 512 * SURF_STRUCT;
  b.hw = hw;
  b.c = [178, 172, 164, 6 * 25];
  const top: number[] = [], bot: number[] = [];
  for (let k = 0; k < n; k++) {
    const l = Math.hypot(ox[k], oy[k]) || 1;
    b.n = [sd * ox[k] / l, 0, -sd * oy[k] / l];
    const x = run.x[k] + sd * ox[k] * hw, y = run.y[k] + sd * oy[k] * hw;
    top.push(b.v(x, z[k] + lift + 0.02, -y, sd * hw, run.s[k]));
    bot.push(b.v(x, z[k] - depth, -y, sd * hw, run.s[k]));
  }
  for (let k = 0; k < n - 1; k++) {
    if (sd > 0) b.q(bot[k], top[k], top[k + 1], bot[k + 1]); else b.q(bot[k], bot[k + 1], top[k + 1], top[k]);
  }
}

// ---------------------------------------------------------------------------- rail

const RAIL_BALLAST = [150, 140, 128];
const RAIL_STEEL = [118, 112, 106];

export function buildRail(a: Record<string, TypedArray>, terr: Terrain, level: number): { mesh: MeshBuf | null; count: number } {
  const off = a.l_off as Uint32Array | undefined;
  if (!off || off.length < 2) return { mesh: null, count: 0 };
  const xyz = a.l_xyz as Float32Array, cls = a.l_class as Uint8Array, flags = a.l_flags as Uint8Array;
  const n = off.length - 1;
  const S = terr.S;
  const b = new RoadBuilder(xyz.length / 3 * 10, xyz.length / 3 * 30);
  const widen = [1, 2, 4][level] ?? 1;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = flags ? flags[i] : 0;
    if (f & 4) continue; // tunnels (most subway) hidden in normal view
    const c = cls[i] ?? 0;
    const tram = c === 4;
    if (tram && level > 0) continue; // streetcar track reads as part of the road from afar
    const bridge = (f & 2) !== 0;
    for (const run0 of clipRuns(xyz, off[i], off[i + 1], 0, -0.01, S + 0.01)) {
      const run = refine(run0, terr.cell, [], !bridge);
      const nv = run.x.length;
      const { ox, oy } = offsets(run);
      const z = run.x.map((x, k) => (bridge ? run.z[k] : terr.at(x, run.y[k])));
      count++;
      if (!tram) {
        const hwB = ((c === 1 ? 2.8 : 3.6) * widen) / 2;
        const bc = c === 2 ? [140, 134, 128] : c === 3 ? [140, 140, 130] : RAIL_BALLAST;
        ribbonCols(b, run, ox, oy, z, hwB, c + 512 * SURF_BALLAST, bc, 0.5, bridge ? 0.35 : 0.02);
        if (bridge) for (const sd of [1, -1]) deckSide(b, run, ox, oy, z, hwB, sd, 1.6, 0.35);
      }
      if (level === 0) {
        // two rails, standard gauge 1.435 m (TTC streetcar 1.495 m)
        const g = tram ? 0.7475 : 0.7175;
        for (const s of [-g, g]) {
          const lift = tram ? 0.16 : bridge ? 0.5 : 0.18;
          railLine(b, run, ox, oy, z, s, 0.055, c + 512 * SURF_STEEL, RAIL_STEEL, tram ? 8 : 2, lift);
        }
      }
      void nv;
    }
  }
  return { mesh: b.finish(), count };
}

function ribbonCols(b: RoadBuilder, run: Run, ox: number[], oy: number[], z: number[], hw: number, code: number, rgb: number[], prio: number, lift: number) {
  b.code = code; b.hw = hw; b.n = [0, 1, 0]; b.c = [rgb[0], rgb[1], rgb[2], Math.round(prio * 25)]; b.j = [FAR, FAR, 0, 0];
  let prev: number[] | null = null;
  for (let k = 0; k < run.x.length; k++) {
    const x = run.x[k], y = run.y[k];
    const cur = [b.v(x + ox[k] * hw, z[k] + lift, -(y + oy[k] * hw), hw, run.s[k]), b.v(x - ox[k] * hw, z[k] + lift, -(y - oy[k] * hw), -hw, run.s[k])];
    if (prev) b.q(prev[1], cur[1], cur[0], prev[0]);
    prev = cur;
  }
}

function railLine(b: RoadBuilder, run: Run, ox: number[], oy: number[], z: number[], u: number, hw: number, code: number, rgb: number[], prio: number, lift: number) {
  b.code = code; b.hw = hw; b.n = [0, 1, 0]; b.c = [rgb[0], rgb[1], rgb[2], Math.round(prio * 25)]; b.j = [FAR, FAR, 0, 0];
  let prev: number[] | null = null;
  for (let k = 0; k < run.x.length; k++) {
    const l = Math.hypot(ox[k], oy[k]) || 1;
    const nx = ox[k] / l, ny = oy[k] / l;
    const cx = run.x[k] + nx * u, cy = run.y[k] + ny * u;
    const cur = [b.v(cx + nx * hw, z[k] + lift, -(cy + ny * hw), hw, run.s[k]), b.v(cx - nx * hw, z[k] + lift, -(cy - ny * hw), -hw, run.s[k])];
    if (prev) b.q(prev[1], cur[1], cur[0], prev[0]);
    prev = cur;
  }
}
