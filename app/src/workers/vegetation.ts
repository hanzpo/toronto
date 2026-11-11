// Vegetation placement (tile worker). Deterministic: every choice is hashed
// from tile + feature ids, so a tile always grows the same trees.
//
// Level 0 (1024 m tiles, 4 m land-cover raster, the network build of the tile, buildings, houses;
// run in the network worker, net/worker.ts):
//   · OSM trees (species from the genus tag when mapped)
//   · street trees: the network engine's tree slots (boulevards, furniture
//     bands), one planted species per block (City practice) picked from the
//     frontage behind them
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
import type { Built } from '../net/core/model';
import type { Terrain } from './farNet';
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

export interface StreetTree { x: number; y: number; small: boolean }

export interface VegEnv {
  S: number; tx: number; ty: number;
  terr: Terrain;
  ground: Uint8Array;
  gAt(x: number, y: number): number;
  inBuilding(x: number, y: number, margin: number): boolean;
  airfield(x: number, y: number): boolean;
  /** carriageway segments near a point (24 m grid cell) */
  roadsAt(x: number, y: number): VegSeg[] | undefined;
  /** the network engine's tree slots (tile-local) */
  streetTrees: StreetTree[];
  houses: { xy: Float32Array; angle: Float32Array; len: Float32Array; wid: Float32Array; type?: Uint8Array } | null;
  osm: { kind: Uint8Array; xy: Float32Array; v?: Uint8Array } | null;
  ex: Exclusion;
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

const EX_ROAD = 0, EX_HIGHWAY = 1, EX_BRIDGE = 2, EX_RAIL = 3, EX_DISC = 4, EX_JBOX = 5;
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
      if (type === EX_RAIL || type === EX_DISC || type === EX_JBOX) continue;
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
          // coarse junction box (sight-line clearance for plants); furniture uses the exact surfaces
          case EX_JBOX: if (!pit && d < e + t) return true; break;
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

const ROAD_W_MIN = [10, 10, 7, 6, 6, 5, 3.5, 3, 2.2, 3];

/** Exclusion index from the far road / rail arrays of a tile (net/bake.ts): carriageway half-widths, track beds. */
export function farExclusion(a: Record<string, TypedArray>, widen: number, maxClass: number): Exclusion {
  const ex = new Exclusion();
  for (const p of ['r', 'l'] as const) {
    const off = a[`${p}_off`] as Uint32Array | undefined, xyz = a[`${p}_xyz`] as Float32Array | undefined, vf = a[`${p}_vf`] as Uint8Array | undefined;
    if (!off || !xyz) continue;
    const cls = a[`${p}_class`] as Uint8Array, wid = a.r_width as Float32Array | undefined;
    for (let i = 0; i < off.length - 1; i++) {
      const c = cls[i];
      if (p === 'r' && c > maxClass) continue;
      const hw = p === 'r' ? (Math.max(wid?.[i] ?? 0, ROAD_W_MIN[c] ?? 3) * widen) / 2 : 0;
      const type = p === 'l' ? EX_RAIL : c <= 1 ? EX_HIGHWAY : EX_ROAD;
      for (let k = off[i]; k < off[i + 1] - 1; k++) {
        if (vf && vf[k] & vf[k + 1] & 2) continue;
        ex.add(xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 3], xyz[k * 3 + 4], hw, hw, type);
      }
    }
  }
  return ex;
}

/**
 * Exclusion index from the network build of a tile (world coordinates in, tile-local out): every
 * vehicle lane and turning path at its width (highway lanes with the clear zone, decks with the
 * crown clearance), sidewalks and paths as walk bands (tree pits only), rail and tram track beds.
 */
export function netExclusion(b: Built, ox: number, oy: number, terr: Terrain): Exclusion {
  const ex = new Exclusion();
  for (const l of b.lanes) {
    const hw = l.width / 2;
    for (let k = 0; k < l.pts.length - 1; k++) {
      const p = l.pts[k], q = l.pts[k + 1];
      const x0 = p.x - ox, y0 = p.y - oy, x1 = q.x - ox, y1 = q.y - oy;
      if (l.kind === 'walk' || l.kind === 'bike') { ex.seg(x0, y0, x1, y1, 0, 0, 0, 0, -hw, l.width, -hw, l.width, EX_ROAD); continue; }
      if (l.kind === 'rail' || (l.kind === 'tram' && !l.cls.includes('car'))) { ex.add(x0, y0, x1, y1, 0, 0, EX_RAIL); continue; }
      const deck = (p.z + q.z) / 2 - terr.at((x0 + x1) / 2, (y0 + y1) / 2) > 3;
      ex.add(x0, y0, x1, y1, hw, hw, deck ? EX_BRIDGE : l.speed > 20.5 ? EX_HIGHWAY : EX_ROAD);
    }
  }
  return ex;
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
  const ex = env.ex;
  const trunks = new Points(8); // trees (trunk + crown clearance)
  const drives = new Segs(16);

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

  // ------------------------------------------------------------ street trees (the network engine's tree slots)
  // one planted species per block (~80 m cell), from the frontage behind the trees
  for (let i = 0; i < env.streetTrees.length; i++) {
    const st = env.streetTrees[i];
    const x = st.x, y = st.y;
    const bk = (Math.floor((e0 + x) / 80) * 92821) ^ (Math.floor((n0 + y) / 80) * 68917);
    const probe = gAt(x, y);
    const pit = probe === 5 || probe === 6 || probe === 11 || probe === 21;
    const mix = pit ? STREET_PIT : suburb ? STREET_SUB : probe === 4 || probe === 0 ? STREET_RES : STREET_ART;
    const main = pick(mix, rnd(bk, 1));
    const age = (suburb ? 0.55 : 0.7) + rnd(bk, 2) * 0.4;
    const k = tx * 7907 + ty * 104723 + i * 31;
    const sp = st.small ? pick([[S.ORNAMENTAL, 3], [S.COLUMNAR, 2]], rnd(k, 1)) : rnd(k, 4) < 0.7 ? main : pick(mix, rnd(k, 5));
    const s0 = SPECIES[sp];
    const h = Math.max(1.5, (s0.h[0] + (s0.h[1] - s0.h[0]) * rnd(k, 1, 31)) * (pit ? 0.75 : 1) * age * (0.85 + rnd(k, 6) * 0.3));
    const w = Math.max(1, h * (s0.w[0] + (s0.w[1] - s0.w[0]) * rnd(k, 2, 31)));
    push(x, y, rnd(k, 3, 31), h, w, sp);
    trunks.add(x, y, Math.max(1.2, w * 0.22));
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
  const ex = farExclusion(a, 1.6, 3);
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

// ---------------------------------------------------------------------------- level 0 from the network build

class Grid<T> {
  cells = new Map<number, T[]>();
  readonly size: number;
  constructor(size: number) { this.size = size; }
  private k(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }
  add(x0: number, y0: number, x1: number, y1: number, item: T) {
    const s = this.size;
    for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) {
      for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
        const key = this.k(i, j);
        let c = this.cells.get(key);
        if (!c) { c = []; this.cells.set(key, c); }
        c.push(item);
      }
    }
  }
  at(x: number, y: number): T[] | undefined { return this.cells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size))); }
}

interface Poly { xy: Float32Array; a: number; b: number }

function inPoly(p: Poly, x: number, y: number): boolean {
  let inside = false;
  const xy = p.xy;
  for (let i = p.a, j = p.b - 1; i < p.b; j = i++) {
    const xi = xy[i * 2], yi = xy[i * 2 + 1], xj = xy[j * 2], yj = xy[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Trees, shrubs and hedges of a level-0 tile: land cover, OSM trees, buildings and houses from the
 * tile arrays (tile-local), roads, rail and street-tree slots from the network build (world).
 */
export function placeNetTile(a: Record<string, TypedArray>, b: Built, tx: number, ty: number, S: number, terr: Terrain): VegBuf {
  const ground = a.ground as Uint8Array;
  const ox = tx * S, oy = ty * S;
  const gAt = (x: number, y: number) => ground[Math.min(255, Math.max(0, Math.floor((y / S) * 256))) * 256 + Math.min(255, Math.max(0, Math.floor((x / S) * 256)))];
  const airfield = (x: number, y: number) => {
    for (const [dx, dy] of [[0, 0], [24, 0], [-24, 0], [0, 24], [0, -24]]) {
      const g = gAt(x + dx, y + dy);
      if (g === 14 || g === 20 || g === 23) return true;
    }
    return false;
  };
  const roads = new Grid<VegSeg>(24);
  for (const l of b.lanes) {
    if (l.kind !== 'drive') continue;
    const hw = l.width / 2;
    for (let k = 0; k < l.pts.length - 1; k++) {
      const s: VegSeg = { x0: l.pts[k].x - ox, y0: l.pts[k].y - oy, x1: l.pts[k + 1].x - ox, y1: l.pts[k + 1].y - oy, hw, cls: l.speed > 20.5 ? 1 : 4 };
      const m = hw + 4;
      roads.add(Math.min(s.x0, s.x1) - m, Math.min(s.y0, s.y1) - m, Math.max(s.x0, s.x1) + m, Math.max(s.y0, s.y1) + m, s);
    }
  }
  const blds = new Grid<Poly>(32);
  const ro = a.b_ring_off as Uint32Array | undefined, vo = a.b_vert_off as Uint32Array | undefined, bxy = a.b_xy as Float32Array | undefined;
  if (ro && vo && bxy) {
    for (let i = 0; i < ro.length - 1; i++) {
      const r0 = ro[i];
      if (ro[i + 1] <= r0) continue;
      const p: Poly = { xy: bxy, a: vo[r0], b: vo[r0 + 1] };
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = p.a; k < p.b; k++) { const x = bxy[k * 2], y = bxy[k * 2 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      blds.add(x0 - 2, y0 - 2, x1 + 2, y1 + 2, p);
    }
  }
  const xo = a.xb_off as Uint32Array | undefined, xxy = a.xb_xy as Float32Array | undefined;
  if (xo && xxy) {
    for (let i = 0; i < xo.length - 1; i++) {
      const p: Poly = { xy: xxy, a: xo[i], b: xo[i + 1] };
      if (p.b - p.a < 3) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = p.a; k < p.b; k++) { const x = xxy[k * 2], y = xxy[k * 2 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      blds.add(x0 - 2, y0 - 2, x1 + 2, y1 + 2, p);
    }
  }
  const houses = new Grid<number>(32);
  const hxy = a.h_xy as Float32Array | undefined, hang = a.h_angle as Float32Array | undefined, hl = a.h_len as Float32Array | undefined, hwd = a.h_wid as Float32Array | undefined;
  if (hxy && hang && hl && hwd) {
    for (let i = 0; i < hxy.length / 2; i++) {
      const r = Math.hypot(hl[i], hwd[i]) / 2 + 2;
      houses.add(hxy[i * 2] - r, hxy[i * 2 + 1] - r, hxy[i * 2] + r, hxy[i * 2 + 1] + r, i);
    }
  }
  const inBuilding = (x: number, y: number, m: number) => {
    const c = blds.at(x, y);
    if (c) for (const p of c) if (inPoly(p, x, y) || (m > 0 && (inPoly(p, x + m, y) || inPoly(p, x - m, y) || inPoly(p, x, y + m) || inPoly(p, x, y - m)))) return true;
    const h = houses.at(x, y);
    if (h && hxy && hang && hl && hwd) {
      for (const i of h) {
        const dx = x - hxy[i * 2], dy = y - hxy[i * 2 + 1];
        const ca = Math.cos(hang[i]), sa = Math.sin(hang[i]);
        const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
        if (Math.abs(u) < hl[i] / 2 + m + 0.5 && Math.abs(v) < hwd[i] / 2 + m + 0.5) return true;
      }
    }
    return false;
  };
  const streetTrees: StreetTree[] = [];
  for (const p of b.props) if (p.kind === 'tree' || p.kind === 'tree_small') streetTrees.push({ x: p.x - ox, y: p.y - oy, small: p.kind === 'tree_small' });
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined, pv = a.p_var as Uint8Array | undefined;
  return placeVegetation({
    S, tx, ty, terr, ground, gAt, inBuilding, airfield, streetTrees, ex: netExclusion(b, ox, oy, terr),
    roadsAt: (x, y) => roads.at(x, y),
    houses: hxy && hang && hl && hwd ? { xy: hxy, angle: hang, len: hl, wid: hwd, type: a.h_type as Uint8Array | undefined } : null,
    osm: pk && pxy ? { kind: pk, xy: pxy, v: pv } : null,
  });
}
