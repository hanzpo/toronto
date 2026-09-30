// Pure meshing functions used by the tile worker. All output coordinates are
// tile-local three.js axes: x = E - tx·S, y = elevation (datum m), z = -(N - ty·S).
import type { TypedArray } from '../data/tbn';
import { EAVE_FRAC, H_ROW, H_SHED, orientHouses } from './houseFront';

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
  /** roof sanity counts for this tile (workers/houseFront.ts houseRoofQa), read by __qa.extra */
  qa?: import('./houseFront').HouseQa;
}

export interface TileMeshes {
  terrain: MeshBuf;
  /** level-0 vector ground (workers/ground.ts); replaces `terrain` when present */
  vground?: MeshBuf | null;
  /** open cuts / portal approaches (level 0): floor query for heightAt */
  cuts?: import('./ground').CutBuf | null;
  /** embankment fills (level 0, ground.ts buildGround `emb`): surface queries */
  emb?: Float32Array | null;
  heights: Float32Array; // G*G metres
  grid: number;
  ground: Uint8Array;
  minH: number;
  maxH: number;
  buildings: MeshBuf | null;
  /** building footprints for camera collision / label occlusion (level 0) */
  collide?: import('./collide').FootprintBuf | null;
  /** roads, sidewalks and (appended) rail: one draw; rail indices start at `railStart` */
  roads: MeshBuf | null;
  railStart: number;
  /** index count of the near-only prefix of `roads` (curb faces, tactile plates: sub-pixel beyond a few hundred m) */
  roadNear?: number;
  /** levels 1–2: start of the half-resolution index range appended to `terrain` (0 = none) */
  terrainCoarse?: number;
  houses: HouseBuf | null;
  street: import('./street').StreetBuf | null;
  /** far-field canopy clumps (level 1; VEG_STRIDE records, tile-local) */
  canopy: Float32Array | null;
  /** street props / parking lots (level 0), consumed by PropsLayer */
  props: import('./props').PropsBuf | null;
  /** rooftop equipment, construction sites, laneways (level 0), consumed by UrbanLayer */
  urban?: import('./urban').UrbanBuf | null;
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

/**
 * Move the triangles of the given road surfaces (rm.y = cls + 16·oneway + 32·surf)
 * to the front of the index range [0, end), keeping the order within each part.
 * Returns the index count of that prefix: far tiles draw from there on.
 */
export function frontSurfaces(m: MeshBuf, end: number, surfs: ReadonlySet<number>): number {
  const rm = m.attrs?.rm;
  if (!rm) return 0;
  const idx = m.index, a = rm.array, st = rm.size;
  const near: number[] = [], rest: number[] = [];
  for (let i = 0; i < end; i += 3) {
    const surf = Math.floor(a[idx[i] * st + 1] / 32);
    (surfs.has(surf) ? near : rest).push(idx[i], idx[i + 1], idx[i + 2]);
  }
  if (!near.length) return 0;
  idx.set(near, 0);
  idx.set(rest, near.length);
  return near.length;
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
  const skirtBase: number[] = [];
  for (const e of edges) {
    const base = b.nv;
    skirtBase.push(base);
    for (const vi of e) {
      b.v(b.pos[vi * 3], b.pos[vi * 3 + 1] - skirt, b.pos[vi * 3 + 2], b.nrm[vi * 4] / 127, b.nrm[vi * 4 + 1] / 127, b.nrm[vi * 4 + 2] / 127);
    }
    for (let k = 0; k < G - 1; k++) {
      const t0 = e[k], t1 = e[k + 1], s0 = base + k, s1 = base + k + 1;
      b.t(t0, s0, s1); b.t(t0, s1, t1); // both windings (skirts are seen from either side)
      b.t(t0, s1, s0); b.t(t0, t1, s1);
    }
  }
  // far LOD (levels 1–2): the same vertices at every 2nd grid line, appended after
  // the full index range (TileManager draws from `coarseStart` for far tiles; the
  // skirts hide the T-junctions against full-detail neighbours)
  let coarseStart = 0;
  if (level >= 1 && (G - 1) % 2 === 0) {
    coarseStart = b.ni;
    for (let j = 0; j < G - 1; j += 2) {
      for (let i = 0; i < G - 1; i += 2) {
        const a = j * G + i, bb = a + 2, cc = a + 2 * G + 2, d = a + 2 * G;
        b.t(a, bb, cc);
        b.t(a, cc, d);
      }
    }
    edges.forEach((e, q) => {
      const base = skirtBase[q];
      for (let k = 0; k < G - 1; k += 2) {
        const t0 = e[k], t1 = e[k + 2], s0 = base + k, s1 = base + k + 2;
        b.t(t0, s0, s1); b.t(t0, s1, t1);
        b.t(t0, s1, s0); b.t(t0, t1, s1);
      }
    });
  }
  return { mesh: b.finish()!, heights: h, minH, maxH, coarseStart };
}

// --------------------------------------------------------------------------- buildings
// (facade-attributed extrusion lives in ./buildings)
export { buildBuildings } from './buildings';

export { buildRoads, buildRail } from './roads';

// --------------------------------------------------------------------------- houses

export function extractHouses(a: Record<string, TypedArray>, suppress: Set<number>, originE = 0, originN = 0, names?: string[]): HouseBuf | null {
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
  const hb: HouseBuf = {
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
  // face each house to its street and pick a Toronto archetype (./houseFront)
  orientHouses(hb, a, originE, originN, osm ? Float64Array.from(keep, (k) => osm[k]) : undefined, names);
  return hb;
}

/**
 * Footprints the house pass classed as houses but that aren't: longer than
 * 25 m, narrower than 3.5 m, or long and narrow (aspect > 4 under 6 m wide:
 * main-street shops, lane-side sheds, rows mis-tagged). They are appended to
 * the tile's extruded buildings (flat roof, generic kind → storefronts,
 * parapets, rooftop kit) and dropped from the house instances. Mutates `a`
 * (b_* arrays) — call before buildBuildings / props / collide.
 */
export function promoteNonHouses(a: Record<string, TypedArray>, hb: HouseBuf): { hb: HouseBuf; n: number } {
  const bad: number[] = [];
  for (let i = 0; i < hb.count; i++) {
    if (hb.type[i] === H_SHED) continue;
    const F = hb.len[i], D = hb.wid[i];
    const L = Math.max(F, D), W = Math.min(F, D);
    // a terrace of row houses fronting the street along its long side is still houses
    if (hb.type[i] === H_ROW && F >= D && W >= 6 && W <= 16 && L <= 60) continue;
    if (L > 25 || W < 3.5 || (L / W > 4 && W < 6)) bad.push(i);
  }
  if (!bad.length) return { hb, n: 0 };
  const nB0 = a.b_ring_off ? a.b_ring_off.length - 1 : 0;
  const nR0 = a.b_vert_off ? a.b_vert_off.length - 1 : 0;
  const nV0 = a.b_xy ? a.b_xy.length / 2 : 0;
  const n = bad.length;
  const grow = <T extends TypedArray>(src: T | undefined, Ctor: new (n: number) => T, extra: number): T => {
    const o = new Ctor((src?.length ?? 0) + extra);
    if (src) (o as unknown as { set(x: ArrayLike<number>): void }).set(src as ArrayLike<number>);
    return o;
  };
  const ringOff = grow(a.b_ring_off as Uint32Array | undefined, Uint32Array, nB0 ? n : n + 1);
  const vertOff = grow(a.b_vert_off as Uint32Array | undefined, Uint32Array, nR0 ? n : n + 1);
  const xy = grow(a.b_xy as Float32Array | undefined, Float32Array, n * 8);
  const H = grow(a.b_height as Float32Array | undefined, Float32Array, n), MIN = grow(a.b_min as Float32Array | undefined, Float32Array, n);
  const BASE = grow(a.b_base as Float32Array | undefined, Float32Array, n), KIND = grow(a.b_kind as Uint8Array | undefined, Uint8Array, n);
  const ROOF = grow(a.b_roof as Uint8Array | undefined, Uint8Array, n), COL = grow(a.b_color as Uint32Array | undefined, Uint32Array, n);
  const OSM = grow(a.b_osm as Float64Array | undefined, Float64Array, n);
  bad.forEach((i, j) => {
    const b = nB0 + j, r = nR0 + j, v = nV0 + j * 4;
    ringOff[b] = r; ringOff[b + 1] = r + 1;
    vertOff[r] = v; vertOff[r + 1] = v + 4;
    const ca = Math.cos(hb.angle[i]), sa = Math.sin(hb.angle[i]);
    const hx = hb.len[i] / 2, hy = hb.wid[i] / 2, cx = hb.xy[i * 2], cy = hb.xy[i * 2 + 1];
    // CCW outer ring: local (x along angle, y = depth toward the back)
    [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].forEach(([u, w], k) => {
      xy[(v + k) * 2] = cx + ca * u - sa * w; xy[(v + k) * 2 + 1] = cy + sa * u + ca * w;
    });
    // a flat-roofed block about as tall as the house's eaves (2–4 storeys)
    H[b] = Math.min(14, Math.max(6.5, hb.height[i] * (EAVE_FRAC[hb.type[i]] ?? 0.7) + 1.2));
    MIN[b] = 0; BASE[b] = hb.base[i]; KIND[b] = 0; ROOF[b] = 0; COL[b] = 0;
    OSM[b] = -(4e12 + Math.round(cx * 16) * 65536 + Math.round(cy * 16)); // synthetic, stable id
  });
  Object.assign(a, { b_ring_off: ringOff, b_vert_off: vertOff, b_xy: xy, b_height: H, b_min: MIN, b_base: BASE, b_kind: KIND, b_roof: ROOF, b_color: COL, b_osm: OSM });
  // drop them from the house instances
  const keep: number[] = [];
  const isBad = new Uint8Array(hb.count);
  for (const i of bad) isBad[i] = 1;
  for (let i = 0; i < hb.count; i++) if (!isBad[i]) keep.push(i);
  const pick = <T extends Float32Array | Uint8Array>(src: T, stride = 1): T => {
    const o = new (src.constructor as new (n: number) => T)(keep.length * stride);
    keep.forEach((k, j) => { for (let s = 0; s < stride; s++) o[j * stride + s] = src[k * stride + s]; });
    return o;
  };
  return {
    hb: {
      count: keep.length, xy: pick(hb.xy, 2), base: pick(hb.base), angle: pick(hb.angle), len: pick(hb.len), wid: pick(hb.wid),
      height: pick(hb.height), type: pick(hb.type), variant: pick(hb.variant),
    },
    n,
  };
}
