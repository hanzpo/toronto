// Unified at-grade surface (docs/SURFACE.md, `?surf=1`): one watertight mesh per
// level-0 tile built by the pipeline (pipeline/tpipe/surface.py) as a planar
// partition of surface classes with one conformed height field. It replaces the
// terrain, vector ground, road ribbons, junction surfaces, sidewalks, medians and
// track beds. Two index groups share the vertices: group 0 is drawn by the ground
// material (land cover, water, walls, banks; `gd` attribute), group 1 by the
// street material without depth pull (asphalt / concrete / pavers / ballast with
// markings from `rd rm jn` + colour, projected onto this mesh).
//
// Also here: the exact surface height query (placement, heightAt), rails draped
// on the surface for at-grade track, and the bridge-only filters that keep the
// road / rail meshers drawing structures (decks, parapets, piers) only.
import type { TypedArray } from '../data/tbn';
import { TerrainSampler, type MeshBuf } from './meshing';
import earcut from 'earcut';
import { RoadBuilder, SURF_STEEL } from './roads';

export interface SurfMesh extends MeshBuf {
  /** [start, count, materialIndex] index ranges: 0 ground material, 1 street material */
  groups: [number, number, number][];
}

/** triangle buckets over the tile for point queries (top surface only) */
export interface SurfIndex {
  pos: Float32Array; // three axes, tile-local
  idx: Uint32Array | Uint16Array;
  /** bucket offsets [(B*B)+1] into `tris` */
  off: Uint32Array;
  tris: Uint32Array;
  B: number;
  S: number;
  /** surface class per vertex */
  cls: Uint8Array;
}

const BUCKETS = 64;
const RUN_STREET = 16, RUN_WALL = 32;
/** vertical faces (walls, banks, curb faces, skirts): never answer a height query */
const WALLC_ = new Set([30, 33, 34, 80]);
const SC_CURBFACE = 80;
const FAR = 1e4;

/** unsigned LEB128 stream -> numbers */
function unvarint(b: Uint8Array): Float64Array {
  let n = 0;
  for (let i = 0; i < b.length; i++) if (!(b[i] & 0x80)) n++;
  const out = new Float64Array(n);
  let cur = 0, mul = 1, k = 0;
  for (let i = 0; i < b.length; i++) {
    cur += (b[i] & 0x7f) * mul;
    if (b[i] & 0x80) mul *= 128;
    else { out[k++] = cur; cur = 0; mul = 1; }
  }
  return out;
}
const unzz = (v: number) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

/**
 * earcut of a face (outer loop, then holes; local 2D coords) keeping every loop vertex: earcut drops
 * exactly collinear points, so each dropped run is re-inserted by splitting the triangle on that loop
 * edge. Mirrors pipeline/tpipe/surface.py earcut_full (the pipeline verified these faces).
 */
function earcutFull(pts: number[], sizes: number[]): number[] {
  const holes: number[] = [];
  let acc = 0;
  for (let i = 0; i < sizes.length - 1; i++) { acc += sizes[i]; holes.push(acc); }
  const t = earcut(pts, holes.length ? holes : undefined, 2);
  const tris: number[][] = [];
  for (let i = 0; i < t.length; i += 3) tris.push([t[i], t[i + 1], t[i + 2]]);
  const used = new Set(t);
  let start = 0;
  for (const n of sizes) {
    const idx: number[] = [];
    for (let i = start; i < start + n; i++) idx.push(i);
    start += n;
    let k0 = idx.findIndex((i) => used.has(i));
    if (k0 < 0) continue;
    let j = k0;
    for (;;) {
      const a = idx[j];
      const chain: number[] = [];
      let j2 = (j + 1) % n;
      while (!used.has(idx[j2])) { chain.push(idx[j2]); j2 = (j2 + 1) % n; }
      const b = idx[j2];
      if (chain.length) {
        let hit = -1, he = 0;
        for (let ti = 0; ti < tris.length && hit < 0; ti++) {
          for (let e = 0; e < 3; e++) {
            const u = tris[ti][e], w = tris[ti][(e + 1) % 3];
            if ((u === a && w === b) || (u === b && w === a)) { hit = ti; he = e; break; }
          }
        }
        if (hit >= 0) {
          const tr = tris[hit];
          const u = tr[he], c = tr[(he + 2) % 3];
          const ch = u === a ? [a, ...chain, b] : [b, ...chain.slice().reverse(), a];
          tris[hit] = [ch[0], ch[1], c];
          for (let q = 1; q < ch.length - 1; q++) tris.push([ch[q], ch[q + 1], c]);
        }
      }
      j = j2;
      if (j === k0) break;
    }
    k0 = 0;
  }
  const out: number[] = [];
  for (const [p, q, r] of tris) {
    const cr = (pts[2 * q] - pts[2 * p]) * (pts[2 * r + 1] - pts[2 * p + 1]) - (pts[2 * r] - pts[2 * p]) * (pts[2 * q + 1] - pts[2 * p + 1]);
    if (cr >= 0) out.push(p, q, r); else out.push(p, r, q);
  }
  return out;
}

/** Decode sf_* (format v3, docs/SURFACE.md "Tile arrays") into one mesh with two material groups. */
export function buildSurface(a: Record<string, TypedArray>, S: number): { mesh: SurfMesh; index: SurfIndex } | null {
  if (!a.sf_face || !a.sf_idx) return null;
  const z0 = (a.sf_z0 as Float32Array)[0];
  const npos = (a.sf_npos as Uint32Array)[0];
  // positions
  const dxy = unvarint(a.sf_pos as Uint8Array), dzv = unvarint(a.sf_pz as Uint8Array);
  const PX = new Float64Array(npos), PY = new Float64Array(npos), PZ = new Float64Array(npos);
  for (let i = 0, x = 0, y = 0, z = 0; i < npos; i++) {
    x += unzz(dxy[i]); y += unzz(dxy[npos + i]); z += unzz(dzv[i]);
    PX[i] = x / 32; PY[i] = y / 32; PZ[i] = z0 + z / 100;
  }
  // corners -> position index
  const code = unvarint(a.sf_idx as Uint8Array);
  const corner = new Uint32Array(code.length);
  for (let k = 0, hw = 0; k < code.length; k++) { const i = hw - code[k]; corner[k] = i; if (i === hw) hw++; }
  const run = a.sf_run as Uint8Array;
  const nrun = run.length / 2;
  const rcls = (r: number) => run[2 * r], rfl = (r: number) => run[2 * r + 1];
  const faceRun = unvarint(a.sf_face as Uint8Array), nl = a.sf_nl as Uint8Array, ln = unvarint(a.sf_ln as Uint8Array);
  const fk = a.sf_fk as Uint8Array, nt = a.sf_nt as Uint16Array, tl = (a.sf_tl as Uint8Array).length ? unvarint(a.sf_tl as Uint8Array) : new Float64Array(0);
  // street / extra vertex streams (consumed in first-appearance order)
  const su = a.sf_su as Int16Array, sv = a.sf_sv as Uint16Array, rv = a.sf_rv as Float32Array, se = a.sf_se as Int16Array;
  const smk = a.sf_smk as Uint32Array, scode = a.sf_scode as Uint16Array, slw = a.sf_slw as Uint8Array, sfx = a.sf_sfx as Uint8Array;
  const scol = a.sf_scol as Uint8Array, rjn = a.sf_rjn as Float32Array, rjv = a.sf_rjv as Uint8Array;
  const sjn = a.sf_sjn as Int16Array, sjf = a.sf_sjf as Uint16Array, gx = a.sf_gx as Uint16Array;
  let si = 0, ji = 0, ei = 0;
  // vertices: first appearance of (run, position)
  const vmap = new Map<number, number>();
  const vp: number[] = [], vr: number[] = [];
  const attr: number[] = []; // per vertex: gd 4 + rd 4 + rm 4 + jn 4 + col 4 = 20
  const vertex = (r: number, p: number) => {
    const key = r * 4194304 + p;
    let v = vmap.get(key);
    if (v !== undefined) return v;
    v = vp.length;
    vmap.set(key, v);
    vp.push(p); vr.push(r);
    const c = rcls(r), f = rfl(r);
    const o = attr.length;
    for (let k = 0; k < 20; k++) attr.push(0);
    attr[o] = c;
    if (f & RUN_STREET) {
      const u = su[si] / 50, vv = rv[r] + sv[si] / 10;
      attr[o + 4] = u; attr[o + 5] = vv; attr[o + 6] = se[2 * si] / 100; attr[o + 7] = se[2 * si + 1] / 100;
      attr[o + 8] = smk[si]; attr[o + 9] = scode[si]; attr[o + 10] = slw[si] / 10; attr[o + 11] = sfx[si];
      if (rjv[r]) {
        attr[o + 12] = sjn[2 * ji] / 10; attr[o + 13] = sjn[2 * ji + 1] / 10; attr[o + 14] = sjf[2 * ji] / 10; attr[o + 15] = sjf[2 * ji + 1] / 10;
        ji++;
      } else {
        const fpS = rjn[4 * r], fnS = rjn[4 * r + 1];
        attr[o + 12] = fpS > 1e8 ? FAR : vv - fpS; attr[o + 13] = fnS > 1e8 ? FAR : fnS - vv;
        attr[o + 14] = rjn[4 * r + 2]; attr[o + 15] = rjn[4 * r + 3];
      }
      for (let k = 0; k < 4; k++) attr[o + 16 + k] = scol[4 * si + k];
      si++;
    } else if (c === 1 || f & RUN_WALL) {
      if (c === 1) { attr[o + 1] = gx[ei] / 8; attr[o + 2] = 4; attr[o + 3] = f & 15; } // water: shore distance, natural bank, kind
      else attr[o + 1] = gx[ei] / 10; // walls: along
      ei++;
    }
    return v;
  };
  const triG: number[] = [], triS: number[] = [];
  let li = 0, ci = 0, ti = 0, ni = 0;
  for (let f = 0; f < faceRun.length; f++) {
    const r = faceRun[f];
    const sizes: number[] = [];
    let tot = 0;
    for (let k = 0; k < nl[f]; k++) { sizes.push(ln[li + k]); tot += ln[li + k]; }
    li += nl[f];
    const ids: number[] = new Array(tot);
    for (let k = 0; k < tot; k++) ids[k] = vertex(r, corner[ci + k]);
    const out = rfl(r) & RUN_STREET ? triS : triG;
    if (fk[f] === 0) {
      for (let j = 1; j + 1 < sizes[0]; j++) out.push(ids[0], ids[j], ids[j + 1]);
    } else if (fk[f] === 2) {
      const m = nt[ni++];
      for (let k = 0; k < 3 * m; k++) out.push(ids[tl[ti + k]]);
      ti += 3 * m;
    } else {
      const pts: number[] = [];
      for (let k = 0; k < tot; k++) { const p = corner[ci + k]; pts.push(PX[p], PY[p]); }
      const loc = earcutFull(pts, sizes);
      for (const k of loc) out.push(ids[k]);
    }
    ci += tot;
  }
  const n = vp.length;
  const pos = new Float32Array(n * 3);
  const gd = new Float32Array(n * 4), rd = new Float32Array(n * 4), rm = new Float32Array(n * 4), jnA = new Float32Array(n * 4);
  const color = new Uint8Array(n * 4);
  const vcls = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = vp[i];
    pos[3 * i] = PX[p]; pos[3 * i + 1] = PZ[p]; pos[3 * i + 2] = -PY[p];
    const o = 20 * i;
    for (let k = 0; k < 4; k++) { gd[4 * i + k] = attr[o + k]; rd[4 * i + k] = attr[o + 4 + k]; rm[4 * i + k] = attr[o + 8 + k]; jnA[4 * i + k] = attr[o + 12 + k]; color[4 * i + k] = attr[o + 16 + k]; }
    vcls[i] = attr[o];
  }
  void SC_CURBFACE; void nrun;
  // skirts: 3 m down along the tile border (both windings), so a neighbour drawn without a surface
  // (partial region, older tiles: the old ground) or at another height never shows a crack
  const onB = (v: number) => {
    const x = pos[3 * v], y = -pos[3 * v + 2];
    return x < 0.01 ? 1 : x > S - 0.01 ? 2 : y < 0.01 ? 4 : y > S - 0.01 ? 8 : 0;
  };
  const skirt: number[] = [];
  for (const T_ of [triG, triS]) {
    for (let t = 0; t < T_.length; t += 3) {
      if (WALLC_.has(vcls[T_[t]])) continue;
      for (let e = 0; e < 3; e++) {
        const a_ = T_[t + e], b_ = T_[t + (e + 1) % 3];
        const ba = onB(a_), bb = onB(b_);
        if (ba && ba === bb) skirt.push(a_, b_);
      }
    }
  }
  let nAll = n;
  const nsk = skirt.length; // two new vertices per border edge
  const grow = <T extends Float32Array | Int8Array | Uint8Array>(src: T, k: number): T => {
    const o = new (src.constructor as new (m: number) => T)((n + nsk) * k); o.set(src); return o;
  };
  const pos2 = grow(pos, 3), gd2 = grow(gd, 4), rd2 = grow(rd, 4), rm2 = grow(rm, 4), jn2 = grow(jnA, 4), col2 = grow(color, 4);
  const vcls2 = new Uint8Array(n + nsk); vcls2.set(vcls);
  for (let k = 0; k < skirt.length; k += 2) {
    const a_ = skirt[k], b_ = skirt[k + 1];
    const A_ = nAll++, B_ = nAll++;
    for (const [src, dst] of [[a_, A_], [b_, B_]]) {
      pos2[3 * dst] = pos[3 * src]; pos2[3 * dst + 1] = pos[3 * src + 1] - 3; pos2[3 * dst + 2] = pos[3 * src + 2];
      gd2[4 * dst] = 18; vcls2[dst] = 30; // bare earth; never a top-surface triangle for queries
    }
    triG.push(a_, B_, b_, a_, A_, B_, a_, b_, B_, a_, B_, A_);
  }
  const N = nAll;
  const tri = N < 65536 ? new Uint16Array(triG.length + triS.length) : new Uint32Array(triG.length + triS.length);
  tri.set(triG, 0); tri.set(triS, triG.length);
  const n0 = n;
  void n0;
  // smooth normals: area-weighted face normals per vertex
  const nf = new Float32Array(N * 3);
  for (let t = 0; t < tri.length; t += 3) {
    const i0 = tri[t], i1 = tri[t + 1], i2 = tri[t + 2];
    const ax = pos2[3 * i1] - pos2[3 * i0], ay = pos2[3 * i1 + 1] - pos2[3 * i0 + 1], az = pos2[3 * i1 + 2] - pos2[3 * i0 + 2];
    const bx = pos2[3 * i2] - pos2[3 * i0], by = pos2[3 * i2 + 1] - pos2[3 * i0 + 1], bz = pos2[3 * i2 + 2] - pos2[3 * i0 + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    for (const v of [i0, i1, i2]) { nf[3 * v] += cx; nf[3 * v + 1] += cy; nf[3 * v + 2] += cz; }
  }
  const normal = new Int8Array(N * 4);
  for (let i = 0; i < N; i++) {
    let x = nf[3 * i], y = nf[3 * i + 1], z = nf[3 * i + 2];
    const L = Math.hypot(x, y, z);
    if (L <= 1e-9) { x = 0; y = 1; z = 0; } else { x /= L; y /= L; z /= L; }
    normal[4 * i] = Math.round(x * 127); normal[4 * i + 1] = Math.round(y * 127); normal[4 * i + 2] = Math.round(z * 127);
  }
  const mesh: SurfMesh = {
    position: pos2, normal, color: col2, index: tri,
    attrs: { gd: { array: gd2, size: 4 }, rd: { array: rd2, size: 4 }, rm: { array: rm2, size: 4 }, jn: { array: jn2, size: 4 } },
    groups: [[0, triG.length, 0], [triG.length, triS.length, 1]],
  };
  // buckets of top-surface triangles (walls excluded: they are vertical)

  const Bn = BUCKETS, cs = S / Bn;
  const cnt = new Uint32Array(Bn * Bn + 1);
  const cells: number[] = [];
  for (let t = 0; t < tri.length / 3; t++) {
    if (WALLC_.has(vcls2[tri[3 * t]])) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = tri[3 * t + k], x = pos2[3 * v], y = -pos2[3 * v + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const i0 = Math.max(0, Math.floor(x0 / cs)), i1 = Math.min(Bn - 1, Math.floor(x1 / cs));
    const j0 = Math.max(0, Math.floor(y0 / cs)), j1 = Math.min(Bn - 1, Math.floor(y1 / cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { cnt[j * Bn + i + 1]++; cells.push(t, j * Bn + i); }
  }
  for (let k = 1; k < cnt.length; k++) cnt[k] += cnt[k - 1];
  const fill = cnt.slice(0, Bn * Bn);
  const tris = new Uint32Array(cells.length / 2);
  for (let k = 0; k < cells.length; k += 2) tris[fill[cells[k + 1]]++] = cells[k];
  return { mesh, index: { pos: pos2, idx: tri.slice(), off: cnt, tris, B: Bn, S, cls: vcls2 } };
}

/** exact surface height (datum m) at tile-local (x, y), NaN outside every top triangle */
export function surfaceHeight(s: SurfIndex, x: number, y: number): number {
  const cs = s.S / s.B;
  const i = Math.min(s.B - 1, Math.max(0, Math.floor(x / cs))), j = Math.min(s.B - 1, Math.max(0, Math.floor(y / cs)));
  const b = j * s.B + i;
  const P = s.pos, I = s.idx;
  let best = NaN;
  for (let k = s.off[b]; k < s.off[b + 1]; k++) {
    const t = s.tris[k];
    const a = I[3 * t], bb = I[3 * t + 1], c = I[3 * t + 2];
    const ax = P[3 * a], ay = -P[3 * a + 2], bx = P[3 * bb], by = -P[3 * bb + 2], cx = P[3 * c], cy = -P[3 * c + 2];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const z = l1 * P[3 * a + 1] + l2 * P[3 * bb + 1] + l3 * P[3 * c + 1];
    if (!(z <= best)) best = z; // highest top surface wins (there should be exactly one)
  }
  return best;
}

/** TerrainSampler that answers with the surface (props, trees, lamps, parked cars sit on it) */
export class SurfaceSampler extends TerrainSampler {
  s: SurfIndex;
  constructor(base: TerrainSampler, s: SurfIndex) {
    super(base.h, base.G, base.S);
    this.s = s;
  }
  at(e: number, n: number): number {
    const z = surfaceHeight(this.s, Math.min(Math.max(e, 0), this.S - 1e-3), Math.min(Math.max(n, 0), this.S - 1e-3));
    return Number.isNaN(z) ? super.at(e, n) : z;
  }
}

// ------------------------------------------------------------------ bridge-only filters

const V_BRIDGE = 1, V_TUNNEL = 2, V_GRADED = 4, V_EMBED = 8;
const R_VERT = ['r_s', 'r_el', 'r_er', 'r_pl', 'r_pr', 'r_lw', 'r_mk', 'r_vf', 'r_sw', 'r_dz'];
const R_PIECE = ['r_class', 'r_width', 'r_flags', 'r_lanes', 'r_side', 'r_v0', 'r_name', 'r_osm', 'r_layer', 'r_sub', 'r_surf', 'r_svc', 'r_cyc'];
const DROP = ['js_xy', 'js_tri', 'jw_xy', 'jw_tri', 'jc_off', 'jc_xy', 'jt_xy', 'jt_ang', 'jt_w', 'md_off', 'md_xyz', 'md_w', 'md_kind'];

/**
 * Copy of the tile arrays whose road (`pre = 'r'`) or rail (`'l'`) pieces keep only
 * their structure runs (bridge vertices + one approach vertex each side), draped
 * on the surface (dz 0, graded): the meshers then draw decks, parapets and piers
 * that start exactly where the at-grade surface ends. At-grade surfaces are dropped.
 */
export function structuresOnly(a: Record<string, TypedArray>, pre: 'r' | 'l'): Record<string, TypedArray> {
  const off = a[`${pre}_off`] as Uint32Array | undefined, vf = a[`${pre}_vf`] as Uint8Array | undefined;
  const out: Record<string, TypedArray> = { ...a };
  if (pre === 'r') for (const k of DROP) delete out[k];
  if (!off || !vf) return out;
  const xyz = a[`${pre}_xyz`] as Float32Array;
  const vert = pre === 'r' ? R_VERT : ['l_vf', 'l_dz'];
  const piece = pre === 'r' ? R_PIECE : ['l_class', 'l_flags', 'l_osm'];
  const runs: [number, number, number][] = []; // piece, v0, v1 (inclusive)
  for (let i = 0; i + 1 < off.length; i++) {
    let st = -1;
    for (let v = off[i]; v <= off[i + 1]; v++) {
      const on = v < off[i + 1] && (vf[v] & V_BRIDGE) !== 0;
      if (on && st < 0) st = v;
      if (!on && st >= 0) { runs.push([i, Math.max(off[i], st - 1), Math.min(off[i + 1] - 1, v)]); st = -1; }
    }
  }
  const nv = runs.reduce((s, r) => s + r[2] - r[1] + 1, 0);
  const noff = new Uint32Array(runs.length + 1);
  const nxyz = new Float32Array(nv * 3);
  const nvert: Record<string, TypedArray> = {};
  for (const k of vert) if (a[k]) nvert[k] = new (a[k].constructor as new (n: number) => TypedArray)(nv);
  const nws = a.r_ws && pre === 'r' ? new Uint8Array(nv * 2) : null;
  const npiece: Record<string, TypedArray> = {};
  for (const k of piece) if (a[k]) npiece[k] = new (a[k].constructor as new (n: number) => TypedArray)(runs.length);
  let w = 0;
  runs.forEach(([i, v0, v1], r) => {
    noff[r] = w;
    for (let v = v0; v <= v1; v++, w++) {
      nxyz[3 * w] = xyz[3 * v]; nxyz[3 * w + 1] = xyz[3 * v + 1]; nxyz[3 * w + 2] = xyz[3 * v + 2];
      for (const k of vert) if (nvert[k]) (nvert[k] as unknown as number[])[w] = (a[k] as unknown as number[])[v];
      if (nws) { nws[2 * w] = (a.r_ws as Uint8Array)[2 * v]; nws[2 * w + 1] = (a.r_ws as Uint8Array)[2 * v + 1]; }
      const f = nvert[`${pre}_vf`] as Uint8Array;
      if (!(f[w] & V_BRIDGE)) f[w] = (f[w] | V_GRADED) & ~V_TUNNEL;
      if (nvert[`${pre}_dz`]) (nvert[`${pre}_dz`] as Float32Array)[w] = 0;
    }
    for (const k of piece) if (npiece[k]) (npiece[k] as unknown as number[])[r] = (a[k] as unknown as number[])[i];
  });
  noff[runs.length] = w;
  out[`${pre}_off`] = noff;
  out[`${pre}_xyz`] = nxyz;
  Object.assign(out, nvert, npiece);
  if (nws) out.r_ws = nws;
  return out;
}

// ------------------------------------------------------------------ rails on the surface

const RAIL_STEEL = [118, 112, 106];

/**
 * Two rails per at-grade track, sitting on the surface: on ballast the rail head is
 * 0.16 m above the ballast top (tie + rail), on panels / pavement / embedded track
 * it is flush (grooved rail). The tie pattern is painted by the ballast shader.
 */
export function surfaceRails(a: Record<string, TypedArray>, s: SurfIndex, S: number): MeshBuf | null {
  const off = a.l_off as Uint32Array | undefined;
  if (!off || off.length < 2) return null;
  const xyz = a.l_xyz as Float32Array, vf = a.l_vf as Uint8Array | undefined, cls = a.l_class as Uint8Array;
  const b = new RoadBuilder(4096, 8192);
  const scls = s.cls;
  for (let i = 0; i + 1 < off.length; i++) {
    const c = cls[i];
    const tram = c === 4;
    const g = tram ? 0.7475 : 0.7175;
    // densify to <= 3 m
    const P: number[] = [];
    for (let v = off[i]; v + 1 < off[i + 1]; v++) {
      if (vf && (vf[v] | vf[v + 1]) & (V_BRIDGE | V_TUNNEL)) { P.push(NaN, NaN, 0); continue; }
      const x0 = xyz[3 * v], y0 = xyz[3 * v + 1], x1 = xyz[3 * v + 3], y1 = xyz[3 * v + 4];
      const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
      for (let k = 0; k <= m; k++) {
        if (k === 0 && P.length && P[P.length - 3] === x0 && P[P.length - 2] === y0) continue;
        P.push(x0 + (x1 - x0) * (k / m), y0 + (y1 - y0) * (k / m), vf && vf[v] & V_EMBED ? 1 : 0);
      }
    }
    for (const side of [-g, g]) {
      let prev: number[] | null = null;
      let sAlong = 0;
      for (let k = 0; k < P.length / 3; k++) {
        const x = P[3 * k], y = P[3 * k + 1];
        if (Number.isNaN(x)) { prev = null; continue; }
        const kp = Math.max(0, k - 1), kn = Math.min(P.length / 3 - 1, k + 1);
        let dx = P[3 * kn] - P[3 * kp], dy = P[3 * kn + 1] - P[3 * kp + 1];
        if (Number.isNaN(dx) || Number.isNaN(dy)) { dx = 1; dy = 0; }
        const L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L, ny = dx / L;
        const cx = x + nx * side, cy = y + ny * side;
        if (cx < -0.5 || cy < -0.5 || cx > S + 0.5 || cy > S + 0.5) { prev = null; continue; }
        if (k > 0 && !Number.isNaN(P[3 * k - 3])) sAlong += Math.hypot(x - P[3 * k - 3], y - P[3 * k - 2]);
        const z = surfaceHeight(s, Math.min(Math.max(cx, 0), S - 1e-3), Math.min(Math.max(cy, 0), S - 1e-3));
        if (Number.isNaN(z)) { prev = null; continue; }
        // on ballast (surface class 74) the rail stands on its ties; elsewhere it is set flush
        const onBallast = ballastAt(s, scls, cx, cy);
        const embedded = tram || !onBallast;
        const top = z + (embedded ? 0.012 : 0.16);
        const bot = embedded ? z - 0.02 : z - 0.02;
        const hw = embedded ? 0.04 : 0.036;
        b.code = c + 32 * SURF_STEEL; b.eL = b.eR = 0.055; b.n = [0, 1, 0];
        b.c = [RAIL_STEEL[0], RAIL_STEEL[1], RAIL_STEEL[2], Math.round((embedded ? 8 : 2) * 25)]; b.j = [1e4, 1e4, 0, 0];
        b.mk = embedded ? 1 : 0; b.fx = 0;
        const ids = [
          b.v(cx - nx * hw, bot, -(cy - ny * hw), -hw, sAlong), b.v(cx - nx * hw, top, -(cy - ny * hw), -hw, sAlong),
          b.v(cx + nx * hw, top, -(cy + ny * hw), hw, sAlong), b.v(cx + nx * hw, bot, -(cy + ny * hw), hw, sAlong),
        ];
        if (prev) for (let q = 0; q < 3; q++) { b.t(prev[q], ids[q], ids[q + 1]); b.t(prev[q], ids[q + 1], prev[q + 1]); }
        prev = ids;
      }
    }
  }
  return b.finish();
}

function ballastAt(s: SurfIndex, scls: Uint8Array, x: number, y: number): boolean {
  const cs = s.S / s.B;
  const i = Math.min(s.B - 1, Math.max(0, Math.floor(x / cs))), j = Math.min(s.B - 1, Math.max(0, Math.floor(y / cs)));
  const b = j * s.B + i;
  const P = s.pos, I = s.idx;
  for (let k = s.off[b]; k < s.off[b + 1]; k++) {
    const t = s.tris[k];
    const a = I[3 * t], bb = I[3 * t + 1], c = I[3 * t + 2];
    const ax = P[3 * a], ay = -P[3 * a + 2], bx = P[3 * bb], by = -P[3 * bb + 2], cx = P[3 * c], cy = -P[3 * c + 2];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    if (l1 < -1e-6 || l2 < -1e-6 || 1 - l1 - l2 < -1e-6) continue;
    const k2 = scls[a];
    return k2 === 74 || k2 === 75;
  }
  return false;
}

// ------------------------------------------------------------------ furniture on the surface

const SURF_BARRIER = 3, SURF_TACTILE = 9;
const F_ONEWAY = 1, F_LINK = 8, F_LOT = 32, F_DUP = 64;

/** mitred left offsets (unit-ish, scaled by the miter) per vertex, skipping zero-length segments */
function mitreOffsets(x: number[], y: number[]): { ox: number[]; oy: number[] } {
  const n = x.length, ox = new Array<number>(n), oy = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let i0 = i - 1; while (i0 >= 0 && Math.hypot(x[i] - x[i0], y[i] - y[i0]) < 1e-4) i0--;
    let i1 = i + 1; while (i1 < n && Math.hypot(x[i1] - x[i], y[i1] - y[i]) < 1e-4) i1++;
    let d0x = 0, d0y = 0, d1x = 0, d1y = 0;
    if (i0 >= 0) { d0x = x[i] - x[i0]; d0y = y[i] - y[i0]; const l = Math.hypot(d0x, d0y); d0x /= l; d0y /= l; }
    if (i1 < n) { d1x = x[i1] - x[i]; d1y = y[i1] - y[i]; const l = Math.hypot(d1x, d1y); d1x /= l; d1y /= l; }
    if (i0 < 0) { d0x = d1x; d0y = d1y; }
    if (i1 >= n) { d1x = d0x; d1y = d0y; }
    let sx = d0x + d1x, sy = d0y + d1y;
    const sl = Math.hypot(sx, sy);
    if (sl < 1e-6) { sx = d1x || 1; sy = d1y; } else { sx /= sl; sy /= sl; }
    const px = -sy, py = sx;
    const m = 1 / Math.max(0.5, Math.abs(px * -d1y + py * d1x) || 1);
    ox[i] = px * m; oy[i] = py * m;
  }
  return { ox, oy };
}

/**
 * Freeway median barriers (jersey, left pavement edge of one-way freeway / trunk carriageways),
 * steel beam guardrails (right edge, where the surface 4 m out is > 1.3 m above or below the
 * pavement: MTO roadside design) and cast-iron tactile plates at crosswalk ends (jt_*), all sitting
 * on the unified surface. These used to come with the ribbon mesher's at-grade roads.
 */
export function surfaceFurniture(a: Record<string, TypedArray>, s: SurfIndex, S: number): MeshBuf | null {
  const b = new RoadBuilder(4096, 8192);
  const H = (x: number, y: number) => {
    const z = surfaceHeight(s, Math.min(Math.max(x, 0), S - 1e-3), Math.min(Math.max(y, 0), S - 1e-3));
    return z;
  };
  const off = a.r_off as Uint32Array | undefined;
  if (off && a.r_pl) {
    const xyz = a.r_xyz as Float32Array, cls = a.r_class as Uint8Array, fl = a.r_flags as Uint8Array;
    const pl = a.r_pl as Float32Array, pr = a.r_pr as Float32Array, vf = a.r_vf as Uint8Array;
    for (let i = 0; i + 1 < off.length; i++) {
      if (cls[i] > 1 || fl[i] & (F_LOT | F_DUP)) continue;
      // densify to <= 4 m (barrier bases follow the surface)
      const X: number[] = [], Y: number[] = [], L: number[] = [], R: number[] = [], ok: boolean[] = [];
      for (let v = off[i]; v + 1 < off[i + 1]; v++) {
        const m = Math.max(1, Math.ceil(Math.hypot(xyz[3 * v + 3] - xyz[3 * v], xyz[3 * v + 4] - xyz[3 * v + 1]) / 4));
        for (let k = v === off[i] ? 0 : 1; k <= m; k++) {
          const t = k / m;
          X.push(xyz[3 * v] + (xyz[3 * v + 3] - xyz[3 * v]) * t); Y.push(xyz[3 * v + 1] + (xyz[3 * v + 4] - xyz[3 * v + 1]) * t);
          L.push(pl[v] + (pl[v + 1] - pl[v]) * t); R.push(pr[v] + (pr[v + 1] - pr[v]) * t);
          ok.push(!((vf[v] | vf[v + 1]) & 3)); // at grade only (decks carry their own parapets)
        }
      }
      if (X.length < 2) continue;
      const { ox, oy } = mitreOffsets(X, Y);
      const strip = (u: (k: number) => number, wBase: number, wTop: number, h: number, rgb: number[], mask: boolean[]) => {
        b.plain(SURF_BARRIER, rgb, 6);
        let prev: number[] | null = null;
        let along = 0;
        for (let k = 0; k < X.length; k++) {
          if (!mask[k]) { prev = null; continue; }
          if (k > 0) along += Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]);
          const l = Math.hypot(ox[k], oy[k]) || 1, nx = ox[k] / l, ny = oy[k] / l;
          const uk = u(k);
          const cx = X[k] + ox[k] * uk, cy = Y[k] + oy[k] * uk;
          const z = H(cx, cy);
          if (Number.isNaN(z)) { prev = null; continue; }
          const y0 = z - 0.05, y1 = z + h;
          const V = (d: number, yy: number, nn: number[]) => { b.n = nn; b.eL = b.eR = Math.abs(uk); return b.v(cx + nx * d, yy, -(cy + ny * d), uk + d, along); };
          const col = [
            V(wBase, y0, [nx, 0.25, -ny]), V(wTop, y1, [nx, 0.25, -ny]),
            V(wTop, y1, [0, 1, 0]), V(-wTop, y1, [0, 1, 0]),
            V(-wTop, y1, [-nx, 0.25, ny]), V(-wBase, y0, [-nx, 0.25, ny]),
          ];
          if (prev) { b.q(prev[0], prev[1], col[1], col[0]); b.q(prev[2], prev[3], col[3], col[2]); b.q(prev[4], prev[5], col[5], col[4]); }
          prev = col;
        }
      };
      if (fl[i] & F_ONEWAY && !(fl[i] & F_LINK)) strip((k) => L[k] - 0.3, 0.3, 0.2, 0.85, [205, 202, 196], ok);
      // guardrail where the verge 4 m out is a steep bank up or a drop
      const bank = X.map((_, k) => {
        if (!ok[k]) return false;
        const l = Math.hypot(ox[k], oy[k]) || 1;
        const ex = X[k] - ox[k] * R[k], ey = Y[k] - oy[k] * R[k];
        const gx = X[k] - (ox[k] / l) * (R[k] + 4), gy = Y[k] - (oy[k] / l) * (R[k] + 4);
        const ze = H(ex, ey), zg = H(gx, gy);
        return !Number.isNaN(ze) && !Number.isNaN(zg) && Math.abs(zg - ze) > 1.3;
      });
      // close gaps < 25 m, drop runs < 20 m
      const runs = (mask: boolean[]) => {
        const out: [number, number][] = [];
        let st = -1;
        for (let k = 0; k <= mask.length; k++) {
          const on = k < mask.length && mask[k];
          if (on && st < 0) st = k;
          if (!on && st >= 0) { out.push([st, k - 1]); st = -1; }
        }
        return out;
      };
      const cum = [0];
      for (let k = 1; k < X.length; k++) cum.push(cum[k - 1] + Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]));
      for (const [k0, k1] of runs(bank.map((v) => !v))) if (k0 > 0 && k1 < X.length - 1 && cum[k1 + 1] - cum[k0 - 1] < 25) for (let k = k0; k <= k1; k++) bank[k] = ok[k];
      for (const [k0, k1] of runs(bank)) if (cum[k1] - cum[k0] < 20) for (let k = k0; k <= k1; k++) bank[k] = false;
      strip((k) => -(R[k] - 0.25), 0.1, 0.1, 0.8, [176, 180, 182], bank);
    }
  }
  // tactile walking surface indicators: Toronto cast-iron plates, 0.61 m deep, 1.5 m wide
  const jt = a.jt_xy as Float32Array | undefined, ja = a.jt_ang as Float32Array | undefined;
  if (jt && ja) {
    b.plain(SURF_TACTILE, [255, 255, 255], 7.5);
    for (let i = 0; i < ja.length; i++) {
      const x = jt[i * 2], y = jt[i * 2 + 1], ang = ja[i];
      const z = H(x, y);
      if (Number.isNaN(z)) continue;
      const ca = Math.cos(ang), sa = Math.sin(ang), hl = 0.305, hw = 0.75;
      const P = (u: number, v: number) => [x + ca * u - sa * v, y + sa * u + ca * v];
      const c = [P(-hl, -hw), P(hl, -hw), P(hl, hw), P(-hl, hw)];
      b.n = [0, 1, 0];
      // each corner on the surface + 12 mm (the plate follows the ramp / crossfall)
      const idx = c.map((p, k) => b.v(p[0], H(p[0], p[1]) + 0.012 || z + 0.012, -p[1], k === 1 || k === 2 ? 0.61 : 0, k >= 2 ? 1.5 : 0));
      // CCW in plan = front-facing from above ((E, N, up) -> three is a proper rotation). The ribbon
      // mesher's plates (roads.ts junctionSurfaces) are wound the other way and never showed.
      b.q(idx[0], idx[1], idx[2], idx[3]);
    }
  }
  return b.finish();
}
