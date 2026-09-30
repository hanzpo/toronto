// Vegetation placement (tile worker). Deterministic: every choice is hashed
// from tile + feature ids, so a tile always grows the same trees.
//
// Level 0 (1024 m tiles, 4 m land-cover raster, roads, buildings, houses):
//   · OSM trees (species from the genus tag when mapped)
//   · street trees: per block one planted species (City practice) with species
//     spacing, boulevard beyond the sidewalk on residential streets, tree pits
//     at the curb only on commercial frontages; none within the sight triangle
//     of a junction, in front of driveways, at lamps, in travel lanes
//   · yards: front-yard tree / foundation shrubs, 0–3 backyard trees behind
//     each house, cedar hedges along some rear / side lot lines
//   · parks, ravines, cemeteries, wetlands: raster scatter with grove noise,
//     ravine species mix, understory + edge shrubs, willows by water, High
//     Park's black-oak savanna
// Level 1 (4096 m tiles, 16 m raster): canopy clumps for the far field.
//
// Output: VEG_STRIDE records (species.ts) sorted into 64 m cells × family so
// the renderer can move whole cells between LOD pools.
import type { TypedArray } from '../data/tbn';
import { BLVD_L, BLVD_R, BLVD_W, PAVER_W, PAVERS, ROAD_W_DEFAULT, SIDEWALK_W, SW_L, SW_R, type StreetRoad, type Terrain } from './roads';
import { familyOf, GENUS, S, SPECIES, VEG_STRIDE } from '../layers/vegetation/species';

export const VEG_CELLS = 16; // per tile side (64 m cells)

export function rnd(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** smooth value noise (0..1) on a `scale` m lattice, world coordinates */
function vnoise(x: number, y: number, scale: number, salt: number): number {
  const fx = x / scale, fy = y / scale;
  const i = Math.floor(fx), j = Math.floor(fy);
  const u = fx - i, v = fy - j;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = rnd(i, j, salt), b = rnd(i + 1, j, salt), c = rnd(i, j + 1, salt), d = rnd(i + 1, j + 1, salt);
  return (a + (b - a) * su) * (1 - sv) + (c + (d - c) * su) * sv;
}

type Mix = [number, number][];
function pick(mix: Mix, r: number): number {
  let t = 0;
  for (const [, w] of mix) t += w;
  let x = r * t;
  for (const [s, w] of mix) { x -= w; if (x <= 0) return s; }
  return mix[mix.length - 1][0];
}

// species mixes (weights ≈ share of plantings)
const STREET_RES: Mix = [[S.NORWAY, 22], [S.LOCUST, 13], [S.LINDEN, 12], [S.SILVER, 9], [S.SUGAR, 10], [S.PLANE, 6], [S.OAK, 5], [S.COLUMNAR, 5], [S.ORNAMENTAL, 6], [S.BLUE_SPRUCE, 2], [S.BEECH, 2]];
const STREET_PIT: Mix = [[S.LOCUST, 42], [S.LINDEN, 22], [S.PLANE, 12], [S.COLUMNAR, 10], [S.NORWAY, 5], [S.ORNAMENTAL, 9]];
const STREET_ART: Mix = [[S.LOCUST, 25], [S.PLANE, 15], [S.LINDEN, 18], [S.NORWAY, 16], [S.SILVER, 8], [S.OAK, 6], [S.COLUMNAR, 12]];
const STREET_SUB: Mix = [[S.LINDEN, 18], [S.LOCUST, 18], [S.NORWAY, 10], [S.SUGAR, 12], [S.ORNAMENTAL, 14], [S.COLUMNAR, 10], [S.OAK, 6], [S.SILVER, 4], [S.BLUE_SPRUCE, 3], [S.PLANE, 3]];
const YARD: Mix = [[S.NORWAY, 18], [S.SILVER, 9], [S.SUGAR, 7], [S.SPRUCE, 7], [S.BLUE_SPRUCE, 8], [S.CEDAR, 10], [S.ORNAMENTAL, 12], [S.LINDEN, 4], [S.OAK, 4], [S.LOCUST, 5], [S.PINE, 5], [S.COLUMNAR, 5], [S.BEECH, 2]];
const PARK: Mix = [[S.NORWAY, 12], [S.SUGAR, 12], [S.SILVER, 8], [S.OAK, 12], [S.PLANE, 6], [S.LOCUST, 7], [S.LINDEN, 7], [S.SPRUCE, 7], [S.PINE, 9], [S.BEECH, 5], [S.ORNAMENTAL, 5], [S.COLUMNAR, 2], [S.CEDAR, 3]];
const FOREST: Mix = [[S.SUGAR, 22], [S.NORWAY, 7], [S.OAK, 15], [S.BEECH, 12], [S.HEMLOCK, 11], [S.PINE, 8], [S.LINDEN, 6], [S.SPRUCE, 4], [S.CEDAR, 5], [S.SILVER, 5]];
const SAVANNA: Mix = [[S.OAK, 62], [S.SUGAR, 7], [S.PINE, 10], [S.NORWAY, 5], [S.LINDEN, 4], [S.BEECH, 3], [S.CEDAR, 3], [S.SPRUCE, 6]];
const WET: Mix = [[S.WILLOW, 30], [S.CEDAR, 25], [S.SILVER, 30], [S.SPRUCE, 5], [S.OAK, 10]];
const CEMETERY: Mix = [[S.NORWAY, 14], [S.SUGAR, 10], [S.OAK, 10], [S.SPRUCE, 12], [S.BLUE_SPRUCE, 6], [S.PINE, 10], [S.CEDAR, 8], [S.PLANE, 5], [S.LINDEN, 6], [S.BEECH, 6], [S.COLUMNAR, 5], [S.ORNAMENTAL, 8]];

const OSM_NUDGE = [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [3, 0], [-3, 0], [0, 3], [0, -3]];

/** High Park (black-oak savanna), world E, N, radius (m) */
const HIGH_PARK = [-6480, -745, 950];

/** Toronto downtown distance beyond which neighbourhoods are post-war / newer (younger, smaller trees) */
const SUBURB_R = 13000;

export interface VegSeg { x0: number; y0: number; x1: number; y1: number; hw: number; cls: number }

export interface VegEnv {
  S: number; tx: number; ty: number;
  terr: Terrain;
  ground: Uint8Array;
  /** raw tile arrays (r_* roads, l_* rail, p_* points, j_* junctions): the exclusion index uses the unclipped geometry */
  a: Record<string, TypedArray>;
  gAt(x: number, y: number): number;
  inBuilding(x: number, y: number, margin: number): boolean;
  airfield(x: number, y: number): boolean;
  /** road segments near a point (24 m grid cell) */
  roadsAt(x: number, y: number): VegSeg[] | undefined;
  streets: StreetRoad[];
  /** lamp posts placed so far (stride 5: x, n, …) */
  lamps: number[];
  houses: { xy: Float32Array; angle: Float32Array; len: Float32Array; wid: Float32Array; type?: Uint8Array } | null;
  osm: { kind: Uint8Array; xy: Float32Array; v?: Uint8Array } | null;
  /** exclusion index already built for this tile (street.ts shares it) */
  ex?: Exclusion;
}

export interface VegBuf {
  /** VEG_STRIDE records, sorted by (cell, family) */
  veg: Float32Array;
  /** bucket starts: bucket b = cell·2 + family, VEG_CELLS²·2 + 1 entries */
  cells: Uint32Array;
}

/** uniform-grid point set (spacing / exclusion tests) */
class Points {
  private m = new Map<number, number[]>();
  private size: number;
  constructor(size: number) { this.size = size; }
  private k(i: number, j: number) { return (i + 512) * 4096 + (j + 512); }
  add(x: number, y: number, r: number) {
    const key = this.k(Math.floor(x / this.size), Math.floor(y / this.size));
    let c = this.m.get(key);
    if (!c) { c = []; this.m.set(key, c); }
    c.push(x, y, r);
  }
  /** any point closer than (its r + r) … capped by the grid size */
  near(x: number, y: number, r: number): boolean {
    const i0 = Math.floor(x / this.size), j0 = Math.floor(y / this.size);
    for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) {
      const c = this.m.get(this.k(i, j));
      if (!c) continue;
      for (let q = 0; q < c.length; q += 3) {
        const d = r + c[q + 2];
        const dx = c[q] - x, dy = c[q + 1] - y;
        if (dx * dx + dy * dy < d * d) return true;
      }
    }
    return false;
  }
}

/** segments (driveways) with a distance query */
class Segs {
  private m = new Map<number, number[]>();
  private size: number;
  constructor(size: number) { this.size = size; }
  private k(i: number, j: number) { return (i + 512) * 4096 + (j + 512); }
  add(x0: number, y0: number, x1: number, y1: number) {
    const s = this.size;
    for (let j = Math.floor(Math.min(y0, y1) / s); j <= Math.floor(Math.max(y0, y1) / s); j++) {
      for (let i = Math.floor(Math.min(x0, x1) / s); i <= Math.floor(Math.max(x0, x1) / s); i++) {
        const key = this.k(i, j);
        let c = this.m.get(key);
        if (!c) { c = []; this.m.set(key, c); }
        c.push(x0, y0, x1, y1);
      }
    }
  }
  near(x: number, y: number, r: number): boolean {
    const i0 = Math.floor(x / this.size), j0 = Math.floor(y / this.size);
    for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) {
      const c = this.m.get(this.k(i, j));
      if (!c) continue;
      for (let q = 0; q < c.length; q += 4) {
        const ax = c[q], ay = c[q + 1], dx = c[q + 2] - ax, dy = c[q + 3] - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        if (Math.hypot(x - ax - dx * t, y - ay - dy * t) < r) return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------- exclusion index

const EX_ROAD = 0, EX_HIGHWAY = 1, EX_BRIDGE = 2, EX_RAIL = 3, EX_DISC = 4;
/** largest clearance a query adds beyond an item's half-width (crown radius + clear zone + bands) */
const EX_PAD = 22;
const ST = 13; // item stride

/**
 * Where plants and street furniture may not stand, from the geometry the
 * road / rail meshing draws: carriageways with their per-vertex pavement edges
 * (`r_pl` left / `r_pr` right: asymmetric one-way pairs, tapers, merges; all
 * classes incl. service roads, paths, ramps and decks), the sidewalk band on
 * each side (`r_sw`: behind a grass boulevard or a paver strip where drawn),
 * the junction surfaces (`js_*` triangles), rail tracks (tunnels excluded),
 * junction boxes and marked crossings. Roads of the neighbouring tiles within
 * 40 m of the border (`xr_*`, width only) count with a safety margin.
 *
 * Clearances (trunk radius t, crown radius c; e = pavement edge on the point's side):
 *   street / path       trunk off the pavement: d ≥ e + t, and off the sidewalk band
 *                       [e + b, e + b + w] (b = boulevard / paver strip); tree pits and
 *                       furniture (`pit`) may stand on the sidewalk
 *   motorway / trunk    no crown over the lanes or shoulder: d ≥ e + max(t, c) + 2.5
 *   bridge deck         no crown under or through the deck: d ≥ e + max(t, c) + 1
 *   rail track          d ≥ max(3.2 + t, c + 1)  (ballast shoulder, crown off the tracks)
 *   junction surface    t clear of the triangle; junction box / crossing disc: d ≥ r + t
 */
export class Exclusion {
  private cells = new Map<number, number[]>();
  /** x0 y0 x1 y1 · pavement half-width left (start, end), right (start, end) · left band, left walk · right band, right walk · type */
  private it: number[] = [];
  private tris: number[] = [];
  private tcells = new Map<number, number[]>();
  private size = 16;
  /** the tile carries its neighbours' border pieces (xr_* / xl_*) */
  hasBorder = false;
  private k(i: number, j: number) { return (i + 1024) * 8192 + (j + 1024); }
  private cover(map: Map<number, number[]>, x0: number, y0: number, x1: number, y1: number, id: number) {
    const s = this.size;
    for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) {
      for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
        const key = this.k(i, j);
        let c = map.get(key);
        if (!c) { c = []; map.set(key, c); }
        c.push(id);
      }
    }
  }
  seg(x0: number, y0: number, x1: number, y1: number, l0: number, l1: number, r0: number, r1: number,
    bl: number, wl: number, br: number, wr: number, type: number) {
    const id = this.it.length / ST;
    this.it.push(x0, y0, x1, y1, l0, l1, r0, r1, bl, wl, br, wr, type);
    const m = Math.max(l0, l1, r0, r1) + Math.max(bl + wl, br + wr) + EX_PAD;
    this.cover(this.cells, Math.min(x0, x1) - m, Math.min(y0, y1) - m, Math.max(x0, x1) + m, Math.max(y0, y1) + m, id);
  }
  add(x0: number, y0: number, x1: number, y1: number, hwL: number, hwR: number, type: number) {
    this.seg(x0, y0, x1, y1, hwL, hwL, hwR, hwR, 0, 0, 0, 0, type);
  }
  disc(x: number, y: number, r: number) { this.add(x, y, x, y, r, r, EX_DISC); }
  tri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
    const id = this.tris.length / 6;
    this.tris.push(ax, ay, bx, by, cx, cy);
    const m = 4;
    this.cover(this.tcells, Math.min(ax, bx, cx) - m, Math.min(ay, by, cy) - m, Math.max(ax, bx, cx) + m, Math.max(ay, by, cy) + m, id);
  }
  /** inside a junction surface, or within r of one */
  onJunction(x: number, y: number, r: number): boolean {
    const ids = this.tcells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size)));
    if (!ids) return false;
    const T = this.tris;
    for (const id of ids) {
      const q = id * 6;
      const ax = T[q], ay = T[q + 1], bx = T[q + 2], by = T[q + 3], cx = T[q + 4], cy = T[q + 5];
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
      const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) return true;
      if (r > 0 && (sd(x, y, ax, ay, bx, by) < r || sd(x, y, bx, by, cx, cy) < r || sd(x, y, cx, cy, ax, ay) < r)) return true;
    }
    return false;
  }
  /**
   * Depth (m) of the point inside the nearest drawn pavement edge on its side,
   * over all at-grade items (> 0 inside a carriageway; for furniture placement)
   */
  pavementDepth(x: number, y: number): number {
    const ids = this.cells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size)));
    let best = -Infinity;
    if (!ids) return best;
    const it = this.it;
    for (const id of ids) {
      const q = id * ST, type = it[q + 12];
      if (type === EX_RAIL || type === EX_DISC) continue;
      const g = this.geom(q, x, y);
      best = Math.max(best, g.e - g.d);
    }
    return best;
  }
  private geom(q: number, x: number, y: number) {
    const it = this.it;
    const x0 = it[q], y0 = it[q + 1], dx = it[q + 2] - x0, dy = it[q + 3] - y0;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
    const d = Math.hypot(x - x0 - dx * u, y - y0 - dy * u);
    const left = dx * (y - y0) - dy * (x - x0) > 0;
    const e = left ? it[q + 4] + (it[q + 5] - it[q + 4]) * u : it[q + 6] + (it[q + 7] - it[q + 6]) * u;
    const b = left ? it[q + 8] : it[q + 10], w = left ? it[q + 9] : it[q + 11];
    return { d, e, b, w };
  }
  /** true when a plant (trunk radius t, crown radius c) at x, y violates any clearance */
  blocked(x: number, y: number, t: number, c: number, pit = false): boolean {
    const ids = this.cells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size)));
    if (ids) {
      const it = this.it;
      for (const id of ids) {
        const q = id * ST, type = it[q + 12];
        const { d, e, b, w } = this.geom(q, x, y);
        switch (type) {
          case EX_ROAD:
            if (d < e + t) return true;
            if (!pit && w > 0 && d > e + b - t && d < e + b + w + t) return true;
            break;
          case EX_HIGHWAY: if (d < e + Math.max(t, c) + 2.5) return true; break;
          case EX_BRIDGE: if (d < e + Math.max(t, c) + 1) return true; break;
          case EX_RAIL: if (d < Math.max(3.2 + t, c + 1.0)) return true; break;
          default: if (d < e + t) return true;
        }
      }
    }
    return this.onJunction(x, y, t);
  }
}

function sd(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - ax - dx * u, y - ay - dy * u);
}

/**
 * Exclusion index for a tile from its raw arrays (unclipped pieces, so roads
 * just beyond the tile edge count) plus the neighbours' border pieces. `widen`
 * matches the meshing's far-level road widening.
 */
export function buildExclusion(a: Record<string, TypedArray>, _streets: StreetRoad[] | null, widen = 1, maxClass = 9): Exclusion {
  const ex = new Exclusion();
  addRoads(ex, a, 'r', widen, maxClass, 0);
  addRoads(ex, a, 'xr', widen, maxClass, 1.2); // no per-vertex edges: symmetric width + margin
  for (const p of ['l', 'xl']) {
    const lo = a[`${p}_off`] as Uint32Array | undefined, lx = a[`${p}_xyz`] as Float32Array | undefined, lf = a[`${p}_flags`] as Uint8Array | undefined;
    if (!lo || !lx) continue;
    for (let i = 0; i < lo.length - 1; i++) {
      if (lf && lf[i] & 4) continue;
      for (let k = lo[i]; k < lo[i + 1] - 1; k++) ex.add(lx[k * 3], lx[k * 3 + 1], lx[k * 3 + 3], lx[k * 3 + 4], 0, 0, EX_RAIL);
    }
  }
  ex.hasBorder = !!a.xr_off || !!a.xl_off;
  const jxy = a.j_xy as Float32Array | undefined, jao = a.j_arm_off as Uint32Array | undefined, jar = a.j_arm_r as Float32Array | undefined;
  if (jxy && jao && jar) {
    for (let i = 0; i < jxy.length / 2; i++) {
      let r = 0;
      for (let k = jao[i]; k < jao[i + 1]; k++) r = Math.max(r, jar[k]);
      ex.disc(jxy[i * 2], jxy[i * 2 + 1], r * widen + 1.5);
    }
  }
  const js = a.js_xy as Float32Array | undefined, jt = a.js_tri as Uint32Array | undefined;
  if (js && jt) for (let i = 0; i + 2 < jt.length; i += 3) {
    const A = jt[i] * 2, B = jt[i + 1] * 2, C = jt[i + 2] * 2;
    ex.tri(js[A], js[A + 1], js[B], js[B + 1], js[C], js[C + 1]);
  }
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined;
  if (pk && pxy) for (let i = 0; i < pk.length; i++) if (pk[i] === 2) ex.disc(pxy[i * 2], pxy[i * 2 + 1], 5);
  return ex;
}

function addRoads(ex: Exclusion, a: Record<string, TypedArray>, p: string, widen: number, maxClass: number, margin: number) {
  const off = a[`${p}_off`] as Uint32Array | undefined, xyz = a[`${p}_xyz`] as Float32Array | undefined;
  const cls = a[`${p}_class`] as Uint8Array | undefined, wid = a[`${p}_width`] as Float32Array | undefined, fl = a[`${p}_flags`] as Uint8Array | undefined;
  const pl = a[`${p}_pl`] as Float32Array | undefined, pr = a[`${p}_pr`] as Float32Array | undefined;
  const sw = a[`${p}_sw`] as Uint8Array | undefined, vf = a[`${p}_vf`] as Uint8Array | undefined;
  if (!off || !xyz || !cls) return;
  for (let i = 0; i < off.length - 1; i++) {
    const f = fl ? fl[i] : 0;
    const c = cls[i] ?? 5;
    if (f & 4 || c > maxClass) continue; // tunnels: trees may grow above
    let w = wid && wid[i] > 0 ? wid[i] : ROAD_W_DEFAULT[c] ?? 6;
    w = Math.max(w, c <= 1 ? 10 : 2) * widen;
    const hw = w / 2 + margin;
    const ws = SIDEWALK_W[c] ?? 0;
    for (let k = off[i]; k < off[i + 1] - 1; k++) {
      if (vf && ((vf[k] | vf[k + 1]) & 2)) continue; // tunnel section
      const bridge = (f & 2) !== 0 || (vf ? ((vf[k] | vf[k + 1]) & 1) !== 0 : false);
      const type = bridge ? EX_BRIDGE : c <= 1 ? EX_HIGHWAY : EX_ROAD;
      const e = (A: Float32Array | undefined, j: number) => (A && A[j] > 0 && Number.isFinite(A[j]) ? A[j] * widen + margin : hw);
      // sidewalk bands per side: [boulevard grass | pavers] then the walk (roads.ts sidewalk())
      let bl = 0, wl = 0, br = 0, wr = 0;
      if (ws > 0 && c >= 2 && c <= 6) {
        const bits = sw ? (sw[k] | sw[k + 1]) : p === 'xr' ? SW_L | SW_R : 0;
        if (bits & SW_L) { wl = ws; bl = bits & BLVD_L ? BLVD_W : bits & PAVERS ? PAVER_W : 0; }
        if (bits & SW_R) { wr = ws; br = bits & BLVD_R ? BLVD_W : bits & PAVERS ? PAVER_W : 0; }
      }
      ex.seg(xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 3], xyz[k * 3 + 4], e(pl, k), e(pl, k + 1), e(pr, k), e(pr, k + 1), bl, wl, br, wr, type);
    }
  }
}

function segDist(s: VegSeg, x: number, y: number) {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / l2)) : 0;
  const px = s.x0 + dx * t, py = s.y0 + dy * t;
  return { d: Math.hypot(x - px, y - py), px, py };
}

// land-cover classes (SPEC): 0 land · 1 water · 2 park · 3 forest · 4 residential · 5 commercial · 6 industrial ·
// 7 farmland · 8 sand · 9 road · 10 rail · 11 parking · 12 cemetery · 13 golf · 14 aeroway · 15 major road ·
// 16 wetland · 17 institutional · 18 construction · 19 pitch · 20 runway · 21 plaza · 22 building · 23 airfield grass
const NO_TREE = new Set([1, 9, 10, 14, 15, 18, 19, 20, 21, 22, 23]);

export function placeVegetation(env: VegEnv): VegBuf {
  const { S: T, tx, ty, terr, gAt } = env;
  const out: number[] = [];
  const e0 = tx * T, n0 = ty * T;
  const distDT = Math.hypot(e0 + T / 2, n0 + T / 2);
  const suburb = distDT > SUBURB_R;
  const hp = Math.hypot(e0 + T / 2 - HIGH_PARK[0], n0 + T / 2 - HIGH_PARK[1]) < HIGH_PARK[2] + T;
  const inTile = (x: number, y: number) => x >= 0 && x < T && y >= 0 && y < T;
  const ex = env.ex ?? buildExclusion(env.a, env.streets);
  const trunks = new Points(8); // trees (trunk + crown clearance)
  const drives = new Segs(16);
  const lampPts = new Points(8);
  for (let i = 0; i < env.lamps.length; i += 5) lampPts.add(env.lamps[i], env.lamps[i + 1], 1.5);

  const nearWater = (x: number, y: number, r: number) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (gAt(x + Math.cos(a) * r, y + Math.sin(a) * r) === 1) return true;
    }
    return gAt(x, y) === 1;
  };
  const railNear = (x: number, y: number) => gAt(x, y) === 10 || gAt(x + 6, y) === 10 || gAt(x - 6, y) === 10 || gAt(x, y + 6) === 10 || gAt(x, y - 6) === 10;
  /**
   * every plant goes through here: land cover at the trunk (no water, roads,
   * rail land, platforms, pitches, construction, airfields), clearances from the
   * exclusion index, buildings. `plaza`: mapped (OSM) trees may stand in plazas.
   */
  const allowed = (x: number, y: number, t: number, c: number, o: { pit?: boolean; plaza?: boolean; bld?: number } = {}) => {
    if (!inTile(x, y)) return false;
    const g = gAt(x, y);
    if (NO_TREE.has(g) && !(o.plaza && g === 21)) return false;
    if (railNear(x, y) || env.airfield(x, y)) return false;
    // tiles built before border pieces existed: a carriageway or track just
    // outside the tile is invisible here, so keep a clear band along the edges
    if (!ex.hasBorder) {
      const de = Math.min(x, y, T - x, T - y);
      if (de < Math.max(6, t + 4.5, c + 8)) return false;
    }
    if (ex.blocked(x, y, t, c, o.pit)) return false;
    return !env.inBuilding(x, y, o.bld ?? Math.max(1.2, c * 0.3));
  };
  const push = (x: number, y: number, seed: number, h: number, w: number, sp: number, extra = 0) => {
    out.push(x, y, terr.at(x, y), seed, h, w, sp, extra);
  };
  /** a tree of species `sp`, age factor `age` (1 = mature); false when the spot is excluded */
  const tree = (x: number, y: number, sp: number, age: number, k: number, o: { pit?: boolean; plaza?: boolean } = {}) => {
    const s = SPECIES[sp];
    const h = Math.max(1.5, (s.h[0] + (s.h[1] - s.h[0]) * rnd(k, 1, 31)) * age);
    const w = Math.max(1, h * (s.w[0] + (s.w[1] - s.w[0]) * rnd(k, 2, 31)) * (0.9 + 0.2 * age));
    if (!allowed(x, y, 0.45 + s.trunk * h, w / 2, o)) return false;
    push(x, y, rnd(k, 3, 31), h, w, sp);
    trunks.add(x, y, Math.max(1.2, w * 0.22));
    return true;
  };
  const shrub = (x: number, y: number, h: number, w: number, seed: number) => {
    if (!allowed(x, y, w * 0.4, w / 2, { bld: 0.3 })) return false;
    push(x, y, seed, h, w, S.SHRUB);
    return true;
  };
  const hedge = (cx: number, cy: number, ang: number, len: number, h: number, thick: number, k: number) => {
    const L = Math.max(1, Math.min(60, Math.round(len)));
    const ca = Math.cos(ang), sa = Math.sin(ang);
    if (!allowed(cx, cy, thick / 2 + 0.3, thick / 2, { bld: 0.3 })) return false;
    for (let q = 0; q <= L; q += 2) {
      const f = q - L / 2;
      if (!allowed(cx + ca * f, cy + sa * f, thick / 2 + 0.3, thick / 2, { bld: 0.3 })) return false;
    }
    let a = Math.atan2(sa, ca); // −π..π
    if (a >= Math.PI) a -= 2 * Math.PI;
    push(cx, cy, rnd(k, 4, 33), h, thick, S.HEDGE, 8 * L + a + Math.PI);
    return true;
  };

  // ------------------------------------------------------------ OSM trees
  const osm = env.osm;
  if (osm) {
    for (let i = 0; i < osm.kind.length; i++) {
      if (osm.kind[i] !== 3) continue;
      const x = osm.xy[i * 2], y = osm.xy[i * 2 + 1];
      if (!inTile(x, y)) continue;
      const v = osm.v ? osm.v[i] : 0;
      const k = tx * 7919 + ty * 104729 + i;
      let sp = GENUS[(v >> 1) & 15] ?? -1;
      if (sp < 0) sp = v & 1 ? pick([[S.SPRUCE, 5], [S.PINE, 4], [S.BLUE_SPRUCE, 2], [S.CEDAR, 2]], rnd(k, 5)) : pick(gAt(x, y) === 2 || gAt(x, y) === 3 ? PARK : STREET_RES, rnd(k, 5));
      // mapped trees are sometimes off by a few metres (onto a carriageway or
      // track): try the spot, then small nudges; drop the tree if none is clear
      const age = 0.6 + rnd(k, 6) * 0.45;
      for (const [dx, dy] of OSM_NUDGE) if (tree(x + dx, y + dy, sp, age, k, { plaza: true })) break;
    }
  }

  // ------------------------------------------------------------ houses: fronts, driveways, yards, hedges
  const H = env.houses;
  if (H) {
    const n = H.xy.length / 2;
    for (let i = 0; i < n; i++) {
      const cx = H.xy[i * 2], cy = H.xy[i * 2 + 1];
      if (!inTile(cx, cy)) continue;
      const type = H.type ? H.type[i] : 0;
      if (type > 3) continue; // garages / sheds / other
      const k = tx * 131071 + ty * 8191 + i * 7;
      const ca = Math.cos(H.angle[i]), sa = Math.sin(H.angle[i]);
      // front = house axis facing the nearest street (classes ≤ 5)
      let best: { d: number; px: number; py: number } | null = null;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const c = env.roadsAt(cx + di * 24, cy + dj * 24);
        if (c) for (const s of c) {
          if (s.cls > 5) continue;
          const r = segDist(s, cx, cy);
          const d = r.d - s.hw;
          if (!best || d < best.d) best = { d, px: r.px, py: r.py };
        }
      }
      let fx: number, fy: number, depth: number, width: number;
      const along = best ? (best.px - cx) * ca + (best.py - cy) * sa : 0;
      const across = best ? -(best.px - cx) * sa + (best.py - cy) * ca : 1;
      if (Math.abs(along) > Math.abs(across)) { fx = ca * Math.sign(along); fy = sa * Math.sign(along); depth = H.len[i]; width = H.wid[i]; }
      else { fx = -sa * Math.sign(across || 1); fy = ca * Math.sign(across || 1); depth = H.wid[i]; width = H.len[i]; }
      const lx = -fy, ly = fx; // lateral
      const toRoad = best ? best.d : 12;
      const at = (f: number, l: number): [number, number] => [cx + fx * f + lx * l, cy + fy * f + ly * l];
      const side = rnd(k, 1) < 0.5 ? -1 : 1;
      // driveway (side of the house, to the street): detached mostly, semis half, rows rarely
      const pDrive = [0.75, 0.95, 0.5, 0.15][type] ?? 0;
      if (best && rnd(k, 2) < pDrive) {
        const [ax, ay] = at(depth / 2 - 4, side * (width / 2 + 1.6));
        const [bx, by] = at(depth / 2 + toRoad + 1, side * (width / 2 + 1.6));
        drives.add(ax, ay, bx, by);
      }
      const young = suburb ? 0.72 : 1;
      // front yard: a tree opposite the driveway, foundation shrubs
      if (toRoad > 7 && rnd(k, 3) < (suburb ? 0.45 : 0.3)) {
        const [x, y] = at(depth / 2 + Math.min(toRoad - 3.5, 3 + rnd(k, 4) * 3), -side * width * (0.15 + rnd(k, 5) * 0.2));
        if (!drives.near(x, y, 2.5) && !trunks.near(x, y, 2)) {
          tree(x, y, pick(suburb ? [[S.ORNAMENTAL, 30], [S.BLUE_SPRUCE, 15], [S.COLUMNAR, 12], [S.LINDEN, 10], [S.SUGAR, 12], [S.NORWAY, 8], [S.CEDAR, 13]] : YARD, rnd(k, 6)), (0.55 + rnd(k, 7) * 0.4) * young, k + 1);
        }
      }
      if (toRoad > 3 && rnd(k, 8) < 0.6) {
        const nS = 1 + Math.floor(rnd(k, 9) * 3);
        for (let q = 0; q < nS; q++) {
          const u = (rnd(k, 10 + q) - 0.5) * (width - 1.6);
          if (Math.abs(u) < 1) continue;
          const [x, y] = at(depth / 2 + 1.1, u);
          if (drives.near(x, y, 1.5)) continue;
          const kk = k * 13 + q;
          if (rnd(kk, 1) < 0.25) tree(x, y, S.CEDAR, 0.28 + rnd(kk, 2) * 0.12, kk);
          else shrub(x, y, 0.8 + rnd(kk, 4) * 0.9, 1 + rnd(kk, 5) * 0.9, rnd(kk, 3));
        }
      }
      // backyard trees
      const r0 = rnd(k, 20);
      const nB = r0 < 0.2 ? 0 : r0 < 0.55 ? 1 : r0 < 0.85 ? 2 : 3;
      for (let q = 0; q < nB; q++) {
        const kk = k * 31 + q;
        const [x, y] = at(-(depth / 2 + 3 + rnd(kk, 1) * 10), (rnd(kk, 2) - 0.5) * width * 1.3);
        if (drives.near(x, y, 2) || trunks.near(x, y, 2.5)) continue;
        const sp = nearWater(x, y, 20) && rnd(kk, 3) < 0.4 ? S.WILLOW : pick(YARD, rnd(kk, 4));
        tree(x, y, sp, (0.55 + rnd(kk, 5) * 0.5) * young, kk);
      }
      // backyard shrubs along the side lot lines
      if (rnd(k, 21) < 0.5) {
        const [x, y] = at(-(depth / 2 + 6 + rnd(k, 22) * 8), (rnd(k, 23) < 0.5 ? -1 : 1) * (width / 2 + 0.6));
        shrub(x, y, 1.2 + rnd(k, 25) * 1.2, 1.4 + rnd(k, 26) * 1.2, rnd(k, 24));
      }
      // cedar hedges: rear lot line, side lot line
      const pRear = type <= 1 ? 0.24 : 0.1;
      if (rnd(k, 30) < pRear) {
        const back = depth / 2 + 13 + rnd(k, 31) * 4;
        const [x, y] = at(-back, 0);
        hedge(x, y, Math.atan2(ly, lx), width + 3.5, 1.8 + rnd(k, 32) * 1.1, 0.9 + rnd(k, 33) * 0.5, k);
      }
      if (type <= 1 && rnd(k, 34) < 0.13) {
        const off = -side * (width / 2 + 1.4);
        const f0 = depth / 2 - 1, f1 = -(depth / 2 + 8);
        const [x, y] = at((f0 + f1) / 2, off);
        hedge(x, y, Math.atan2(fy, fx), f0 - f1, 1.6 + rnd(k, 35) * 1.0, 0.8 + rnd(k, 36) * 0.4, k + 5);
      }
    }
  }

  // ------------------------------------------------------------ street trees
  let ri = 0;
  for (const r of env.streets) {
    ri++;
    if (!r.urban || r.cls < 2 || r.cls > 5) continue;
    /** centreline point, miter offset (as the meshing uses it), unit normal, pavement edge and sidewalk bits of side sd at s */
    const at = (s: number, sd: number) => {
      let k = 0;
      while (k < r.s.length - 2 && r.s[k + 1] < s) k++;
      const t = Math.max(0, Math.min(1, (s - r.s[k]) / Math.max(1e-6, r.s[k + 1] - r.s[k])));
      const ox = r.ox[k] + (r.ox[k + 1] - r.ox[k]) * t, oy = r.oy[k] + (r.oy[k + 1] - r.oy[k]) * t;
      const l = Math.hypot(ox, oy) || 1;
      const E = sd > 0 ? r.pl : r.pr;
      const e = E ? E[k] + (E[k + 1] - E[k]) * t : r.hw;
      const sw = r.sw ? r.sw[t < 0.5 ? k : k + 1] : r.side;
      const x = r.x[k] + (r.x[k + 1] - r.x[k]) * t, y = r.y[k] + (r.y[k + 1] - r.y[k]) * t;
      // curb line point (edge along the miter offset), then outward along the unit normal
      return { cx: x + sd * ox * e, cy: y + sd * oy * e, nx: ox / l, ny: oy / l, sw };
    };
    const rk = tx * 92821 + ty * 68917 + ri * 131;
    for (const sd of [1, -1]) {
      const bit = sd === 1 ? SW_L : SW_R, blvdBit = sd === 1 ? BLVD_L : BLVD_R;
      const hasSW = r.sw ? r.sw.some((v) => (v & bit) !== 0) : (r.side & bit) !== 0;
      const ws = hasSW ? r.ws : 0;
      let blk = 0;
      for (const [c0, c1] of r.clear) {
        blk++;
        const bk = rk + sd * 7 + blk * 1013;
        // frontage type from the land cover just behind the curb
        const mid = at((c0 + c1) / 2, sd);
        const probe = gAt(mid.cx + sd * mid.nx * (ws + 3), mid.cy + sd * mid.ny * (ws + 3));
        const pit = hasSW && (probe === 5 || probe === 6 || probe === 11 || probe === 21);
        if (r.cls === 2 && !pit && probe !== 4 && probe !== 2 && probe !== 17) continue; // arterials: only pits / residential / park frontage
        const mix = pit ? STREET_PIT : suburb ? STREET_SUB : r.cls <= 3 ? STREET_ART : STREET_RES;
        const main = pick(mix, rnd(bk, 1));
        const age = (suburb ? 0.55 : 0.7) + rnd(bk, 2) * 0.4; // block planting age
        const fill = pit ? 0.72 : probe === 4 || probe === 0 ? 0.8 : probe === 2 || probe === 17 ? 0.75 : probe === 12 ? 0.6 : 0.25;
        const big = main === S.PLANE || main === S.OAK || main === S.SILVER || main === S.SUGAR;
        const step = (pit ? 8.5 : big ? 11.5 : main === S.COLUMNAR || main === S.ORNAMENTAL ? 7.5 : 9.5) + rnd(bk, 3) * 1.5;
        // sight triangle: no trees within ~10 m of the junction box
        for (let s = c0 + 10 + rnd(bk, 4) * step * 0.5; s < c1 - 10; s += step) {
          const kk = bk * 97 + Math.round(s);
          if (rnd(kk, 1) > fill) continue;
          const js = s + (rnd(kk, 2) - 0.5) * 1.2;
          const p = at(js, sd);
          // pits: in the paver strip / sidewalk by the curb; boulevards: mid-boulevard;
          // otherwise behind the sidewalk (or the road edge where there is none)
          const onWalk = (p.sw & bit) !== 0;
          const off = pit ? 1.0 : onWalk && p.sw & blvdBit ? BLVD_W / 2 : onWalk ? (p.sw & PAVERS ? PAVER_W : 0) + ws + 1.4 + rnd(kk, 3) * 0.8 : 2.6 + rnd(kk, 3) * 0.8;
          const x = p.cx + sd * p.nx * off, y = p.cy + sd * p.ny * off;
          if (!inTile(x, y) || drives.near(x, y, 3) || lampPts.near(x, y, 1.8) || trunks.near(x, y, 2.5)) continue;
          const sp = rnd(kk, 4) < 0.7 ? main : pick(mix, rnd(kk, 5));
          tree(x, y, sp, (pit ? 0.75 : 1) * age * (0.85 + rnd(kk, 6) * 0.3), kk, { pit, plaza: pit });
        }
      }
    }
  }

  // ------------------------------------------------------------ land cover scatter (4 m raster)
  const px = T / 256;
  const g = env.ground;
  const cap = 26000;
  for (let j = 0; j < 256 && out.length / VEG_STRIDE < cap; j++) {
    for (let i = 0; i < 256; i++) {
      const c = g[j * 256 + i];
      let dTree = 0, dShrub = 0, dSmall = 0;
      let mix: Mix = PARK;
      const x = (i + rnd(i, j, 22 + tx)) * px, y = (j + rnd(i, j, 23 + ty)) * px;
      const X = e0 + x, Y = n0 + y;
      switch (c) {
        case 3: { // forest / ravine
          const edge = g[j * 256 + Math.min(255, i + 2)] !== 3 || g[j * 256 + Math.max(0, i - 2)] !== 3 || g[Math.min(255, j + 2) * 256 + i] !== 3 || g[Math.max(0, j - 2) * 256 + i] !== 3;
          dTree = 0.15; dSmall = 0.035; dShrub = edge ? 0.22 : 0.07; mix = FOREST; break;
        }
        case 2: { const nz = vnoise(X, Y, 70, 5); dTree = 0.028 * Math.max(0, nz * 2.2 - 0.5); dShrub = 0.006; break; }
        case 12: dTree = 0.05; mix = CEMETERY; break;
        case 13: { const nz = vnoise(X, Y, 45, 6); dTree = 0.035 * Math.max(0, nz * 2.6 - 1.2); break; }
        case 16: dTree = 0.04; dShrub = 0.15; mix = WET; break;
        case 17: dTree = 0.01; dShrub = 0.004; break;
        case 4: dTree = 0.006; break;
        case 0: dTree = 0.005; mix = suburb ? YARD : PARK; break;
        case 5: dTree = 0.0015; break;
        case 6: dTree = 0.0012; break;
        case 7: dTree = 0.0006; break;
        case 8: dTree = 0.002; mix = WET; break;
        default: continue;
      }
      if (hp && (c === 2 || c === 3 || c === 0) && Math.hypot(X - HIGH_PARK[0], Y - HIGH_PARK[1]) < HIGH_PARK[2]) {
        mix = SAVANNA;
        if (c === 2) dTree = Math.max(dTree, 0.03 * vnoise(X, Y, 60, 9) + 0.01);
      }
      const k = (tx * 256 + i) * 65537 + ty * 256 + j;
      const r = rnd(k, 21);
      if (r < dTree + dSmall) {
        if (trunks.near(x, y, 1.5)) continue;
        if (c === 4 && env.inBuilding(x, y, 6)) continue; // residential fallback: open lawns only
        const small = r >= dTree;
        const wet = (c === 3 || c === 2) && nearWater(x, y, 14);
        const sp = wet && rnd(k, 24) < 0.4 ? pick(WET, rnd(k, 25)) : small ? pick([[S.ORNAMENTAL, 4], [S.SUGAR, 3], [S.HEMLOCK, 2], [S.BEECH, 2], [S.CEDAR, 1]], rnd(k, 26)) : pick(mix, rnd(k, 26));
        tree(x, y, sp, small ? 0.35 + rnd(k, 27) * 0.25 : 0.7 + rnd(k, 27) * 0.4, k);
      } else if (r < dTree + dSmall + dShrub) {
        shrub(x, y, 0.9 + rnd(k, 29) * 1.8, 1.3 + rnd(k, 30) * 1.8, rnd(k, 28));
      }
    }
  }
  return bucket(out, T);
}

/** sort records into (cell, family) buckets */
function bucket(out: number[], T: number): VegBuf {
  const n = out.length / VEG_STRIDE;
  const NB = VEG_CELLS * VEG_CELLS * 2;
  const key = new Uint16Array(n);
  const counts = new Uint32Array(NB + 1);
  const cs = T / VEG_CELLS;
  for (let i = 0; i < n; i++) {
    const ci = Math.min(VEG_CELLS - 1, Math.max(0, Math.floor(out[i * VEG_STRIDE] / cs)));
    const cj = Math.min(VEG_CELLS - 1, Math.max(0, Math.floor(out[i * VEG_STRIDE + 1] / cs)));
    const b = (cj * VEG_CELLS + ci) * 2 + familyOf(out[i * VEG_STRIDE + 6]);
    key[i] = b;
    counts[b + 1]++;
  }
  for (let b = 0; b < NB; b++) counts[b + 1] += counts[b];
  const pos = counts.slice(0, NB);
  const veg = new Float32Array(n * VEG_STRIDE);
  for (let i = 0; i < n; i++) {
    const d = pos[key[i]]++;
    for (let q = 0; q < VEG_STRIDE; q++) veg[d * VEG_STRIDE + q] = out[i * VEG_STRIDE + q];
  }
  return { veg, cells: counts };
}

// ---------------------------------------------------------------------------- level 1 canopy

/** density of canopy clumps per 16 m pixel by land-cover class, and their mix */
const CANOPY: Record<number, [number, Mix]> = {
  3: [0.95, FOREST], 16: [0.45, WET], 2: [0.1, PARK], 12: [0.3, CEMETERY], 13: [0.08, PARK],
  4: [0.42, YARD], 0: [0.1, YARD], 17: [0.1, PARK], 7: [0.01, PARK], 5: [0.025, STREET_PIT], 6: [0.012, PARK], 19: [0.01, PARK],
};

/**
 * Far-field canopy for a level-1 tile: tree clumps (impostors only) on the
 * 16 m land-cover raster — ravines, valleys and the moraine read as forest,
 * older neighbourhoods as a broken canopy.
 */
export function buildCanopy(a: Record<string, TypedArray>, ground: Uint8Array, terr: Terrain, tx: number, ty: number, T: number): Float32Array {
  const out: number[] = [];
  // level-1 roads are classes ≤ 3, drawn 1.6× wide; rail as at level 0
  const ex = buildExclusion(a, null, 1.6, 3);
  const gAt = (x: number, y: number) => ground[Math.min(255, Math.max(0, Math.floor((y / T) * 256))) * 256 + Math.min(255, Math.max(0, Math.floor((x / T) * 256)))];
  const px = T / 256;
  const e0 = tx * T, n0 = ty * T;
  for (let j = 0; j < 256; j++) {
    for (let i = 0; i < 256; i++) {
      const c = ground[j * 256 + i];
      const d = CANOPY[c];
      if (!d) continue;
      const X = e0 + (i + 0.5) * px, Y = n0 + (j + 0.5) * px;
      let dens = d[0];
      if (c === 2 || c === 13) dens *= Math.max(0, vnoise(X, Y, 90, 5) * 2.4 - 0.6);
      const k = (tx * 256 + i) * 65537 + ty * 256 + j + 7;
      const nPix = Math.floor(dens + rnd(k, 1));
      for (let q = 0; q < nPix; q++) {
        const kk = k * 5 + q;
        const x = (i + rnd(kk, 2)) * px, y = (j + rnd(kk, 3)) * px;
        const sp = pick(d[1], rnd(kk, 4));
        const s = SPECIES[sp];
        // a clump of 2–3 crowns: wider than one tree
        const h = (s.h[0] + (s.h[1] - s.h[0]) * rnd(kk, 5)) * (c === 4 || c === 0 ? 0.85 : 1);
        const w = h * (s.w[0] + (s.w[1] - s.w[0]) * rnd(kk, 6)) * (c === 3 ? 1.35 : 1.25);
        // clumps keep their crowns off the (raster and vector) roads, rail and water
        const rr = w * 0.4;
        let bad = ex.blocked(x, y, rr, rr);
        for (let q = 0; q < 5 && !bad; q++) {
          const g = gAt(x + (q === 1 ? rr : q === 2 ? -rr : 0), y + (q === 3 ? rr : q === 4 ? -rr : 0));
          if (g === 1 || g === 9 || g === 10 || g === 15 || g === 20 || g === 14 || g === 23 || g === 22) bad = true;
        }
        if (bad) continue;
        out.push(x, y, terr.at(x, y), rnd(kk, 7), h, w, sp, 0);
      }
    }
  }
  return Float32Array.from(out);
}
