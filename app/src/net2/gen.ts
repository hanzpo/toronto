// Primitive network generation (docs/NETWORK.md): segments swept from their NetAsset
// cross-sections, nodes generated from their legs. Input: data/net2/primnet.json
// (tpipe.primnet). Everything here is derived from the asset bands, the band layout
// along the edge (platform widenings) and the node legs -- nothing is read from OSM.
//
// Output: one vertex-coloured triangle soup in a local frame (x = E - ox, y = z, z = -(N - oy)).
import earcut from 'earcut';
import { genRail, type RailNet } from './rail';
import { C, materialFor, type Mat } from './materials';

export interface Band { kind: string; w: number; h?: number; dir?: number; classes?: string[]; track?: number; tracks?: number[]; surface?: string }
export interface Asset { id: string; bands: Band[]; offsets: number[]; curb_radius: number; draw?: boolean }
export interface Platform { s0: number; s1: number; side: number; w: number; h: number; band: number; stop: string }
/** an edge's sweep (tpipe.primgeom): sections at stations s; U = band-boundary offsets (+ left):
 *  building line L, the left edge of every band, the right edge of the last band, building line R */
export interface Idx { nb: number; bldgL: number; walkL: number; cwL: number; cwR: number; walkR: number; bldgR: number }
export interface Sweep { s: number[]; c: number[][]; n: number[][]; U: number[][]; H: number[][]; kinds: string[]; idx: Idx }
export interface Edge { id: number; asset: string; name: string; cls: number; a: number; b: number; xyz: number[][]; platforms: Platform[]; sweep: Sweep | null }
export interface NodeMesh { kind: 'junction' | 'transition' | 'end'; legs: { edge: number; end: number }[]; ret?: number[][][]; walk?: number[][][]; bldg?: number[][][]; fok?: boolean[]; ok?: boolean; par?: boolean[]; fix?: Record<string, number[][][]>; boxfix?: number[][][] | null; patch?: { p: number[][]; z: number[]; t: number[][]; b: number[][] } | null; bz?: number[]; retz?: number[][]; walkz?: number[][]; bldgz?: number[][]; row?: { q: number[][]; za: number; zb: number } | null; trans?: { c: number[][]; n: number[][]; U: number[][]; H: number[]; kinds: string[] } }
export interface NNode { id: number; xyz: number[]; type: string; signal: boolean; mesh: NodeMesh }
export interface Ped { kind: string; xyz: number[][]; width: number }
export interface Mark { kind: string; xyz: number[][] }
export interface PrimNet { bbox: number[]; assets: Asset[]; edges: Edge[]; nodes: NNode[]; ped: Ped[]; marks: Mark[]; poles: number[][]; tram_special_work: { piece: number; xyz: number[][]; nodes: number[] }[] }

// surfaces, markings and trackwork materials: net2/materials.ts (linear albedo + material id)
type RGB = Mat;
const H_WALK = 0.15;          // sidewalk / curb top above the carriageway

export class Soup {
  pos: number[] = []; col: number[] = []; nrm: number[] = [];
  ox: number; oy: number;
  constructor(ox: number, oy: number) { this.ox = ox; this.oy = oy; }
  v(e: number, n: number, z: number) { return [e - this.ox, z, -(n - this.oy)]; }
  tri(a: number[], b: number[], c: number[], rgb: RGB) {
    // counter-clockwise seen from above in (E, N) -> three.js (x, y, -z) keeps it front-facing up
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    // surfaces face up: wind them counter-clockwise seen from above (a double-sided material flips
    // the normal of back faces, which drew wrongly wound pieces dark)
    if (ny < -0.3) { nx = -nx; ny = -ny; nz = -nz; const t = b; b = c; c = t; }
    for (const p of [a, b, c]) { this.pos.push(p[0], p[1], p[2]); this.col.push(rgb[0], rgb[1], rgb[2], rgb[3]); this.nrm.push(nx, ny, nz); }
  }
  quad(a: number[], b: number[], c: number[], d: number[], rgb: RGB) { this.tri(a, b, c, rgb); this.tri(a, c, d, rgb); }
  /** double-sided quad (vertical faces) */
  wall(a: number[], b: number[], c: number[], d: number[], rgb: RGB) { this.quad(a, b, c, d, rgb); this.quad(a, d, c, b, rgb); }
}

type ZF = (e: number, n: number, z: number) => number;

function frame(P: number[][]) {
  const nl: number[][] = [];
  for (let k = 0; k < P.length; k++) {
    const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    nl.push([-dy, dx]);
  }
  return { nl };
}

function kindRGB(kind: string, b?: Band): RGB { return materialFor(kind, b); }

/** section points of sweep row k: band boundary j -> [x, y]; z (one per row, from the model) */
function rowPts(sw: Sweep, k: number): number[][] {
  const c = sw.c[k], n = sw.n[k];
  return sw.U[k].map((u) => [c[0] + n[0] * u, c[1] + n[1] * u]);
}

/** the band of interval j (0 and nb+1 are the frontage bands) */
function bandOf(a: Asset, j: number): Band | undefined { return j >= 2 && j <= a.bands.length + 1 ? a.bands[j - 2] : undefined; }

/** sweep an edge: every band interval between consecutive section rows, curb faces where adjacent
 *  heights differ, lane markings. Row 0 / last row are the leg rings the nodes are built from. */
export function sweepEdge(S: Soup, e: Edge, a: Asset, zAt: ZF) {
  const sw = e.sweep;
  if (!sw || sw.s.length < 2) return;
  const R = sw.s.map((_, k) => rowPts(sw, k));
  const Z = sw.c.map((c) => zAt(c[0], c[1], c[2]));
  const nI = sw.U[0].length - 1;
  for (let k = 0; k < R.length - 1; k++) {
    for (let j = 0; j < nI; j++) {
      const w0 = sw.U[k][j] - sw.U[k][j + 1], w1 = sw.U[k + 1][j] - sw.U[k + 1][j + 1];
      if (w0 < 0.005 && w1 < 0.005) continue;
      const h0 = sw.H[k][j], h1 = sw.H[k + 1][j];
      const rgb = h0 === 0 && sw.kinds[j] === 'transit_row' ? C.asphalt : kindRGB(sw.kinds[j], bandOf(a, j));
      S.quad(S.v(R[k][j][0], R[k][j][1], Z[k] + h0), S.v(R[k][j + 1][0], R[k][j + 1][1], Z[k] + h0),
        S.v(R[k + 1][j + 1][0], R[k + 1][j + 1][1], Z[k + 1] + h1), S.v(R[k + 1][j][0], R[k + 1][j][1], Z[k + 1] + h1), rgb);
    }
    // curb faces: boundary j between intervals j-1 and j
    for (let j = 1; j < nI; j++) {
      const ha = [sw.H[k][j - 1], sw.H[k + 1][j - 1]], hb = [sw.H[k][j], sw.H[k + 1][j]];
      if (ha[0] === hb[0] && ha[1] === hb[1]) continue;
      const p = R[k][j], q = R[k + 1][j];
      S.wall(S.v(p[0], p[1], Z[k] + Math.min(ha[0], hb[0])), S.v(q[0], q[1], Z[k + 1] + Math.min(ha[1], hb[1])),
        S.v(q[0], q[1], Z[k + 1] + Math.max(ha[1], hb[1])), S.v(p[0], p[1], Z[k] + Math.max(ha[0], hb[0])), C.curb);
    }
    // lane lines: white dashes between same-direction lanes, double yellow between directions
    for (let bi = 0; bi < a.bands.length - 1; bi++) {
      const b0 = a.bands[bi], b1 = a.bands[bi + 1];
      if (b0.kind !== 'lane' || b1.kind !== 'lane') continue;
      const same = (b0.dir ?? 1) === (b1.dir ?? 1);
      if (sw.s[k] - sw.s[0] < 7 || sw.s[sw.s.length - 1] - sw.s[k + 1] < 7) continue;
      if (same && Math.floor(sw.s[k] / 3) % 3 !== 0) continue;
      const j = bi + 3;
      const c0 = sw.c[k], n0 = sw.n[k], c1 = sw.c[k + 1], n1 = sw.n[k + 1];
      const u0 = sw.U[k][j], u1 = sw.U[k + 1][j];
      const lines = same ? [[0.05, -0.05]] : [[0.2, 0.1], [-0.1, -0.2]];
      for (const [p, q] of lines) {
        const P = (c: number[], n: number[], u: number, z: number) => S.v(c[0] + n[0] * u, c[1] + n[1] * u, z + 0.012);
        S.quad(P(c0, n0, u0 + p, Z[k]), P(c0, n0, u0 + q, Z[k]), P(c1, n1, u1 + q, Z[k + 1]), P(c1, n1, u1 + p, Z[k + 1]), same ? C.white : C.yellow);
      }
    }
  }
  // platforms: the part of the widened ROW on the stop's side, raised, tactile at the track edge
  for (const p of e.platforms) {
    const j = p.band + 2;
    for (let k = 0; k < R.length - 1; k++) {
      if (sw.s[k] < p.s0 || sw.s[k + 1] > p.s1) continue;
      const top = H_WALK + p.h;
      const ed = (kk: number) => (p.side > 0 ? sw.U[kk][j] : sw.U[kk][j + 1]);
      const P = (kk: number, u: number, z: number) => S.v(sw.c[kk][0] + sw.n[kk][0] * u, sw.c[kk][1] + sw.n[kk][1] * u, z);
      const eA = ed(k), eB = ed(k + 1), iA = eA - p.side * p.w, iB = eB - p.side * p.w;
      S.quad(P(k, eA, Z[k] + top), P(k, iA, Z[k] + top), P(k + 1, iB, Z[k + 1] + top), P(k + 1, eB, Z[k + 1] + top), C.platform);
      S.wall(P(k, iA, Z[k]), P(k + 1, iB, Z[k + 1]), P(k + 1, iB, Z[k + 1] + top), P(k, iA, Z[k] + top), C.curb);
      S.wall(P(k, eA, Z[k]), P(k + 1, eB, Z[k + 1]), P(k + 1, eB, Z[k + 1] + top), P(k, eA, Z[k] + top), C.curb);
      const tA = iA + p.side * 0.6, tB = iB + p.side * 0.6;
      S.quad(P(k, iA, Z[k] + top + 0.005), P(k, tA, Z[k] + top + 0.005), P(k + 1, tB, Z[k + 1] + top + 0.005), P(k + 1, iB, Z[k + 1] + top + 0.005), C.tactile);
    }
  }
}

/** the leg ring of an edge at a node, in leaving order (left to right): the SAME points as the
 *  sweep's first / last row (rowPts), with the index map and the leaving tangent */
export function legRing(e: Edge, end: number, zAt: ZF) {
  const sw = e.sweep!;
  const k = end === 0 ? 0 : sw.s.length - 1;
  let pts = rowPts(sw, k);
  const c = sw.c[k], n = sw.n[k];
  const z = zAt(c[0], c[1], c[2]);
  let t = [n[1], -n[0]];
  const I = sw.idx, m = sw.U[k].length - 1;
  let idx = { cwL: I.cwL, cwR: I.cwR, walkL: I.walkL, walkR: I.walkR, bldgL: I.bldgL, bldgR: I.bldgR };
  let H = sw.H[k];
  if (end === 1) {
    pts = pts.slice().reverse(); t = [-t[0], -t[1]];
    idx = { cwL: m - I.cwR, cwR: m - I.cwL, walkL: m - I.walkR, walkR: m - I.walkL, bldgL: m - I.bldgR, bldgR: m - I.bldgL };
    H = H.slice().reverse();
  }
  return { pts, z, idx, t, H, kinds: end === 1 ? sw.kinds.slice().reverse() : sw.kinds };
}

function tri(S: Soup, poly: number[][], zs: number[], rgb: RGB) {
  const flat: number[] = [];
  for (const p of poly) flat.push(p[0], p[1]);
  const ids = earcut(flat);
  for (let t = 0; t < ids.length; t += 3) {
    const A = poly[ids[t]], B = poly[ids[t + 1]], Cc = poly[ids[t + 2]];
    S.tri(S.v(A[0], A[1], zs[ids[t]]), S.v(B[0], B[1], zs[ids[t + 1]]), S.v(Cc[0], Cc[1], zs[ids[t + 2]]), rgb);
  }
}


/** model heights of a corner curve's interior points (primgeom curve_z, exported per node) through
 *  the renderer's z function: the pipeline owns the vertical curves, the client only reads them */
function curveZ(pts: number[][], zs: number[] | undefined, zAt: ZF): number[] {
  return pts.map((p, k) => zAt(p[0], p[1], zs?.[k] ?? 0));
}

/** junction box surface: the primnet patch mesh with its heights (primgeom box_patch: outline from
 *  the leg rings and return vertical curves, interior the harmonic / n-sided Coons interpolant) */
function patchSurface(S: Soup, pt: { p: number[][]; z: number[]; t: number[][] }, zAt: ZF, rgb: RGB) {
  const v = pt.p.map((p, i) => S.v(p[0], p[1], zAt(p[0], p[1], pt.z[i])));
  for (const [a, b, c] of pt.t) S.tri(v[a], v[b], v[c], rgb);
}

/** junction node mesh, only from its legs' rings and the curves between them (primnet node mesh) */
export function genNode(S: Soup, nd: NNode, E: Map<number, Edge>, zAt: ZF) {
  const M = nd.mesh;
  if (!M || M.kind === 'end') return;
  const rings = M.legs.map((l) => (E.get(l.edge)?.sweep ? legRing(E.get(l.edge)!, l.end, zAt) : null));
  if (rings.some((r) => !r)) return;
  const R = rings as ReturnType<typeof legRing>[];
  if (M.kind === 'transition') {
    // swept along the model centreline between the two rings (primgeom transition_rows)
    const T = M.trans;
    if (!T) return;
    const P = (k: number, u: number, h: number) => { const c = T.c[k], n = T.n[k]; return S.v(c[0] + n[0] * u, c[1] + n[1] * u, zAt(c[0], c[1], c[2]) + h); };
    for (let k = 0; k < T.c.length - 1; k++) {
      for (let j = 0; j < T.U[0].length - 1; j++) {
        const h = T.H[j];
        S.quad(P(k, T.U[k][j], h), P(k, T.U[k][j + 1], h), P(k + 1, T.U[k + 1][j + 1], h), P(k + 1, T.U[k + 1][j], h), kindRGB(T.kinds[j]));
      }
      for (let j = 1; j < T.U[0].length - 1; j++) {
        if (T.H[j - 1] === T.H[j]) continue;
        const lo = Math.min(T.H[j - 1], T.H[j]), hi = Math.max(T.H[j - 1], T.H[j]);
        S.wall(P(k, T.U[k][j], lo), P(k + 1, T.U[k + 1][j], lo), P(k + 1, T.U[k + 1][j], hi), P(k, T.U[k][j], hi), C.curb);
      }
    }
    return;
  }
  const n = R.length;
  const box: number[][] = [], bz: number[] = [];
  const par = M.par ?? [];
  for (let i = 0; i < n; i++) {
    const L = R[i], Rn = R[(i + 1) % n];
    const k0 = par[(i - 1 + n) % n] ? L.idx.bldgR : L.idx.cwR, k1 = par[i] ? L.idx.bldgL : L.idx.cwL;
    for (let k = k0; k >= k1; k--) { box.push(L.pts[k]); bz.push(L.z); }
    if (par[i]) {      // near-parallel neighbours: outer edge to outer edge (primgeom node_mesh box_of)
      const A = L.pts[L.idx.bldgL], B = Rn.pts[Rn.idx.bldgR];
      for (let q = 1; q <= 4; q++) { const t = q / 5; box.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); bz.push((L.z + Rn.z) / 2); }
      continue;
    }
    const ret = M.ret![i];
    box.push(...ret); bz.push(...curveZ(ret, M.retz?.[i], zAt));
  }
  // transit_row through an unsignalized junction: raised slab from leg to leg, curb faces both sides
  if (M.row) {
    const [al, ar, bl, br] = M.row.q, za = M.row.za + H_WALK, zb = M.row.zb + H_WALK;
    S.quad(S.v(al[0], al[1], za), S.v(ar[0], ar[1], za), S.v(bl[0], bl[1], zb), S.v(br[0], br[1], zb), C.row);
    S.wall(S.v(al[0], al[1], za - H_WALK), S.v(br[0], br[1], zb - H_WALK), S.v(br[0], br[1], zb), S.v(al[0], al[1], za), C.curb);
    S.wall(S.v(ar[0], ar[1], za - H_WALK), S.v(bl[0], bl[1], zb - H_WALK), S.v(bl[0], bl[1], zb), S.v(ar[0], ar[1], za), C.curb);
  }
  if (M.boxfix) { const zm = bz.reduce((p, q) => p + q, 0) / bz.length; for (const q of M.boxfix) tri(S, q, q.map(() => zm), C.asphalt); }
  else if (M.patch) patchSurface(S, M.patch, zAt, C.asphalt);
  else tri(S, box, bz, C.asphalt);
  for (let i = 0; i < n; i++) {
    const L = R[i], Rn = R[(i + 1) % n];
    const ret = M.ret![i], wk = M.walk![i], bd = M.bldg![i];
    if (M.par && M.par[i]) continue;          // near-parallel neighbours: straight closure, no corner
    // walk corner: leg i cwL -> walkL, walk curve, leg j walkR -> cwR, return reversed
    const poly: number[][] = [], z: number[] = [];
    for (let k = L.idx.cwL; k >= L.idx.walkL; k--) { poly.push(L.pts[k]); z.push(L.z + H_WALK); }
    const wz = curveZ(wk, M.walkz?.[i], zAt);
    const rz = curveZ(ret, M.retz?.[i], zAt);
    poly.push(...wk); z.push(...wz.map((v) => v + H_WALK));
    for (let k = Rn.idx.walkR; k >= Rn.idx.cwR; k--) { poly.push(Rn.pts[k]); z.push(Rn.z + H_WALK); }
    const rr = ret.slice().reverse();
    poly.push(...rr); z.push(...rz.slice().reverse().map((v) => v + H_WALK));
    const fix = M.fix?.[String(i)];
    if (fix) for (const q of fix) tri(S, q, q.map(() => (L.z + Rn.z) / 2 + H_WALK), C.concrete);
    else tri(S, poly, z, C.concrete);
    // curb face along the whole return: from the box z to the walk z
    const line = [L.pts[L.idx.cwL], ...ret, Rn.pts[Rn.idx.cwR]];
    const lz = [L.z, ...rz, Rn.z];
    for (let k = 0; k < line.length - 1; k++) {
      const p = line[k], q = line[k + 1];
      S.wall(S.v(p[0], p[1], lz[k]), S.v(q[0], q[1], lz[k + 1]), S.v(q[0], q[1], lz[k + 1] + H_WALK), S.v(p[0], p[1], lz[k] + H_WALK), C.curb);
    }
    // frontage corner (clamped away where its building-line curve crosses: primgeom node_mesh fok)
    if (M.fok && M.fok[i] === false) continue;
    const fp = [L.pts[L.idx.walkL], L.pts[L.idx.bldgL], ...bd, Rn.pts[Rn.idx.bldgR], Rn.pts[Rn.idx.walkR], ...wk.slice().reverse()];
    const bz2 = curveZ(bd, M.bldgz?.[i], zAt);
    const fz = [L.z, L.z, ...bz2, Rn.z, Rn.z, ...wz.slice().reverse()].map((v) => v + H_WALK);
    tri(S, fp, fz, C.pavers);
  }
}

function box(S: Soup, x: number, y: number, z: number, r: number, h: number, rgb: RGB) {
  const c = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
  for (let k = 0; k < 4; k++) {
    const a = c[k], b = c[(k + 1) % 4];
    S.quad(S.v(a[0], a[1], z), S.v(b[0], b[1], z), S.v(b[0], b[1], z + h), S.v(a[0], a[1], z + h), rgb);
  }
}

function bar(S: Soup, p: number[], q: number[], z: number, r: number, rgb: RGB) {
  const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l * r, ny = dx / l * r;
  S.quad(S.v(p[0] + nx, p[1] + ny, z + r), S.v(q[0] + nx, q[1] + ny, z + r), S.v(q[0] - nx, q[1] - ny, z + r), S.v(p[0] - nx, p[1] - ny, z + r), rgb);
  S.wall(S.v(p[0] + nx, p[1] + ny, z - r), S.v(q[0] + nx, q[1] + ny, z - r), S.v(q[0] + nx, q[1] + ny, z + r), S.v(p[0] + nx, p[1] + ny, z + r), rgb);
}

/** streetcar rails: the model's tram geometry, grooved rails flush with the surface (1.495 m gauge) */
export function genTram(S: Soup, net: PrimNet, zAt: (e: number, n: number, z: number) => number) {
  for (const t of net.tram_special_work) {
    const P = t.xyz;
    if (P.length < 2) continue;
    const { nl } = frame(P);
    const z = P.map((p) => zAt(p[0], p[1], p[2]));
    for (const g of [-0.7475, 0.7475]) {
      // grooved rail flush with the pavement: 7 cm steel head, 4 cm groove on the gauge side
      const strips: [number, number, RGB][] = [[g - 0.035, g + 0.035, C.rail], [g - Math.sign(g) * 0.035, g - Math.sign(g) * 0.075, C.groove]];
      for (const [u0, u1, rgb] of strips) {
        const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
        for (let k = 0; k < P.length - 1; k++) {
          const a0 = S.v(P[k][0] + nl[k][0] * lo, P[k][1] + nl[k][1] * lo, z[k] + 0.016);
          const a1 = S.v(P[k][0] + nl[k][0] * hi, P[k][1] + nl[k][1] * hi, z[k] + 0.016);
          const b1 = S.v(P[k + 1][0] + nl[k + 1][0] * hi, P[k + 1][1] + nl[k + 1][1] * hi, z[k + 1] + 0.016);
          const b0 = S.v(P[k + 1][0] + nl[k + 1][0] * lo, P[k + 1][1] + nl[k + 1][1] * lo, z[k + 1] + 0.016);
          S.quad(a1, a0, b0, b1, rgb);
        }
      }
    }
  }
}

/** the whole slice */
export function generate(net: PrimNet, ox: number, oy: number, zAt: ZF): Soup {
  const S = new Soup(ox, oy);
  const assets = new Map(net.assets.map((a) => [a.id, a]));
  const E = new Map(net.edges.map((e) => [e.id, e]));
  for (const e of net.edges) {
    const a = assets.get(e.asset);
    if (!a || a.draw === false) continue;
    sweepEdge(S, e, a, zAt);
  }
  for (const nd of net.nodes) genNode(S, nd, E, zAt);
  for (const m of net.marks ?? []) {
    const q = m.xyz;
    S.quad(S.v(q[0][0], q[0][1], zAt(q[0][0], q[0][1], q[0][2])), S.v(q[1][0], q[1][1], zAt(q[1][0], q[1][1], q[1][2])),
      S.v(q[2][0], q[2][1], zAt(q[2][0], q[2][1], q[2][2])), S.v(q[3][0], q[3][1], zAt(q[3][0], q[3][1], q[3][2])), C.white);
  }
  for (const p of net.poles ?? []) {
    const z = zAt(p[0], p[1], p[2]);
    box(S, p[0], p[1], z, 0.12, 6.2, C.pole);
    bar(S, [p[0], p[1]], [p[3], p[4]], z + 6.0, 0.08, C.pole);
  }
  genTram(S, net, zAt);
  genRail(S, (net as unknown as { rail?: RailNet }).rail, zAt);
  return S;
}
