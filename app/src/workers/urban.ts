// Urban detail (tile worker, level 0): rooftop equipment (placed by
// workers/rooftops.ts while the buildings are extruded), construction sites
// (tower cranes, hoarding, site trailers, concrete cores with climbing
// formwork, excavators) and Toronto laneways (rear garages facing the lane,
// board fences, hydro poles with wire spans, bins). Deterministic per tile.
// Rendered by layers/UrbanLayer.ts (one instanced draw per item kind).
//
// References: Toronto laneways (~2,400, City of Toronto laneway suites study;
// e.g. the lanes behind College St in Little Italy and Harbord St in the
// Annex) — single-car garages 3–3.5 m wide set on the lane line, 1.8 m board
// fences, wooden hydro poles; construction — Liebherr / Wolff / Potain tower
// cranes (hammerhead jibs 50–75 m, luffers 40–60 m), 2.4 m plywood or
// branded hoarding (City of Toronto hoarding guidelines), stacked site offices.
import type { TypedArray } from '../data/tbn';
import type { HouseBuf } from './meshing';
import { district } from './buildings';

/** item kinds (UrbanLayer pools) */
export const UK = {
  RTU: 0, FAN: 1, HATCH: 2, VENT: 3, WATERTANK: 4, UMBRELLA: 5, PLANTER: 6, COOLING: 7, CHIMNEY: 8, DORMER: 9,
  MAST_H: 10, JIB_H: 11, MAST_L: 12, JIB_L: 13, CORE: 14, SLAB: 15, FORMWORK: 16, HOARD: 17, TRAILER: 18,
  TOILET: 19, DUMPSTER: 20, EXCAVATOR: 21, GARAGE: 22, FENCE: 23, POLE: 24, WIRE: 25, BIN: 26, RAILING: 27,
} as const;
export const URBAN_KINDS = 28;
/** record: kind, x, n (tile-local E, N), z (elevation), angle (rad CCW from +E; the item's +x points along it), sx, sy, sz, variant */
export const USTRIDE = 9;

export interface UrbanBuf {
  items: Float32Array;
}

export function rnd(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function pushItem(out: number[], k: number, x: number, n: number, z: number, ang: number, sx = 1, sy = 1, sz = 1, v = 0) {
  out.push(k, x, n, z, ang, sx, sy, sz, v);
}

// ---------------------------------------------------------------------------- spatial helpers

class Grid<T> {
  cells = new Map<number, T[]>();
  size: number;
  constructor(size: number) { this.size = size; }
  private k(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }
  add(x0: number, y0: number, x1: number, y1: number, item: T) {
    const s = this.size;
    for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++)
      for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
        const key = this.k(i, j);
        const c = this.cells.get(key);
        if (c) c.push(item); else this.cells.set(key, [item]);
      }
  }
  at(x: number, y: number) { return this.cells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size))); }
}

export interface Seg { x0: number; y0: number; x1: number; y1: number; hw: number; cls: number }
function segDist(s: Seg, x: number, y: number): number {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / l2)) : 0;
  return Math.hypot(x - (s.x0 + dx * t), y - (s.y0 + dy * t));
}
export function inRing(xy: ArrayLike<number>, a: number, b: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = a, j = b - 1; i < b; j = i++) {
    const xi = xy[i * 2], yi = xy[i * 2 + 1], xj = xy[j * 2], yj = xy[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------- laneways

const ALLEY_SVC = 3;

/** alley centreline segments for frontage tests (buildings / sheds facing a lane) */
export function alleySegs(a: Record<string, TypedArray>, originE: number, originN: number, names?: string[]): Seg[] {
  const off = a.r_off as Uint32Array | undefined, xyz = a.r_xyz as Float32Array | undefined, wid = a.r_width as Float32Array | undefined;
  if (!off || !xyz) return [];
  const segs: Seg[] = [];
  for (const r of alleyPiecesAt(a, originE, originN, names)) {
    const hw = Math.min(3, (wid?.[r] ?? 4) / 2);
    for (let k = off[r]; k < off[r + 1] - 1; k++) segs.push({ x0: xyz[k * 3], y0: xyz[k * 3 + 1], x1: xyz[k * 3 + 3], y1: xyz[k * 3 + 4], hw, cls: 6 });
  }
  return segs;
}

/**
 * Road pieces that are laneways: `service=alley` (r_svc 3) when the tile has
 * the service subtype; otherwise named "Lane …" service roads, or unnamed
 * service roads ≥ 25 m long in the pre-war city (optionally only where
 * `homes` says there are houses alongside).
 */
export function alleyPiecesAt(a: Record<string, TypedArray>, originE: number, originN: number, names?: string[], homes?: (x: number, y: number) => boolean): number[] {
  const off = a.r_off as Uint32Array | undefined, cls = a.r_class as Uint8Array | undefined;
  if (!off || !cls || off.length < 2) return [];
  const svc = a.r_svc as Uint8Array | undefined, fl = a.r_flags as Uint8Array | undefined, wid = a.r_width as Float32Array | undefined;
  const nm = a.r_name as Uint16Array | undefined, xyz = a.r_xyz as Float32Array;
  const out: number[] = [];
  for (let r = 0; r < off.length - 1; r++) {
    if (cls[r] !== 6 || (fl && fl[r] & (2 | 4))) continue;
    if (svc) { if (svc[r] === ALLEY_SVC) out.push(r); continue; }
    const name = nm && names && nm[r] !== 0xffff ? names[nm[r]] ?? '' : '';
    if (/^Lane\b/.test(name)) { out.push(r); continue; }
    if (name || (wid && wid[r] > 6)) continue;
    const k = off[r], k2 = off[r + 1] - 1;
    const len = Math.hypot(xyz[k2 * 3] - xyz[k * 3], xyz[k2 * 3 + 1] - xyz[k * 3 + 1]);
    if (len < 25) continue; // short unnamed stubs are driveways
    if (district(originE + xyz[k * 3], originN + xyz[k * 3 + 1]).old < 0.7) continue;
    if (homes && !homes((xyz[k * 3] + xyz[k2 * 3]) / 2, (xyz[k * 3 + 1] + xyz[k2 * 3 + 1]) / 2)) continue;
    out.push(r);
  }
  return out;
}

/** nearest alley in front of a wall (for garage doors on lane-facing walls): distance from the wall to the lane edge */
export function alleyFront(segs: Seg[] | SegIndex, mx: number, my: number, nx: number, ny: number, maxD: number): number | null {
  const list = Array.isArray(segs) ? segs : segs.near(mx + nx * 2, my + ny * 2);
  if (!list) return null;
  let best: number | null = null;
  for (const s of list) {
    let dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    const l = Math.hypot(dx, dy);
    if (l < 0.5) continue;
    dx /= l; dy /= l;
    if (Math.abs(dx * nx + dy * ny) > 0.45) continue; // lane must run along the wall
    const den = nx * -dy + ny * dx;
    if (Math.abs(den) < 1e-3) continue;
    const wx = s.x0 - mx, wy = s.y0 - my;
    const t = (wx * -dy + wy * dx) / den;
    const segT = -((wx * ny - wy * nx) / den);
    if (segT < -2 || segT > l + 2 || t <= 0) continue;
    const d = t - s.hw;
    if (d > maxD || d < -1.5) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

export class SegIndex {
  g = new Grid<Seg>(24);
  constructor(segs: Seg[], margin: number) {
    for (const s of segs) this.g.add(Math.min(s.x0, s.x1) - margin, Math.min(s.y0, s.y1) - margin, Math.max(s.x0, s.x1) + margin, Math.max(s.y0, s.y1) + margin, s);
  }
  near(x: number, y: number) { return this.g.at(x, y); }
}

// ---------------------------------------------------------------------------- construction: a tower going up

/**
 * A concrete tower under construction: core walls (elevator / stair core)
 * ahead of the floor slabs, slabs on columns, a self-climbing formwork screen
 * wrapping the top floors (PERI / Doka style, often in the developer's
 * colours), and a tower crane beside the core. (cx, cy) centre, `ang` long
 * axis, L × W slab footprint, z base elevation, h current height.
 */
export function towerInProgress(out: number[], cx: number, cy: number, ang: number, L: number, W: number, z: number, h: number, seed: number, crane: boolean, core01: number) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const floorH = 3.05;
  const nFl = Math.max(1, Math.floor((h - 4) / floorH));
  const slabTop = nFl * floorH;
  // slabs: one per floor (columns under each)
  for (let f = 1; f <= nFl; f++) pushItem(out, UK.SLAB, cx, cy, z + (f - 1) * floorH, ang, L, floorH, W, f === nFl ? 1 : 0);
  // core: 9 × 7 m, 2–4 floors ahead of the slabs
  const cL = Math.min(10, L * 0.4), cW = Math.min(8, W * 0.45);
  const coreH = slabTop + floorH * (2 + Math.floor(rnd(seed, 3) * 3));
  pushItem(out, UK.CORE, cx, cy, z, ang, cL, coreH, cW, 0);
  // climbing screen over the top 3 floors (+ the core top)
  if (nFl >= 5) {
    const scH = floorH * 3 + 1.2;
    pushItem(out, UK.FORMWORK, cx, cy, z + slabTop - floorH * 3 + 0.2, ang, L + 1.2, scH, W + 1.2, (rnd(seed, 4) * 6) | 0);
  }
  if (crane) {
    // luffer beside the core on dense downtown sites, else a hammerhead
    const luff = rnd(seed, 5) < 0.35 + core01 * 0.4;
    const off = L * 0.5 + 3.5;
    const s = rnd(seed, 6) < 0.5 ? 1 : -1;
    const x = cx + ca * off * s, y = cy + sa * off * s;
    const mast = Math.max(coreH + 14, 38 + rnd(seed, 7) * 20);
    craneAt(out, x, y, z, mast, luff, seed);
  }
}

/** a tower crane: mast + slewing top (jib yaw animated by the layer); variant = colour · 4 + jib length step */
export function craneAt(out: number[], x: number, y: number, z: number, mast: number, luff: boolean, seed: number) {
  const col = (rnd(seed, 11) * 4) | 0; // 0 yellow · 1 red/white · 2 white · 3 orange
  const jib = luff ? 0.75 + rnd(seed, 12) * 0.25 : 0.8 + rnd(seed, 12) * 0.35; // × 60 m
  pushItem(out, luff ? UK.MAST_L : UK.MAST_H, x, y, z, rnd(seed, 13) * Math.PI * 2, 1, mast / 60, 1, col);
  // jib record: angle = initial yaw, sx = jib scale, sy = slew speed (rad/s, signed), sz = slew phase
  const speed = (0.03 + rnd(seed, 14) * 0.05) * (rnd(seed, 15) < 0.5 ? -1 : 1);
  pushItem(out, luff ? UK.JIB_L : UK.JIB_H, x, y, z + mast, rnd(seed, 16) * Math.PI * 2, jib, speed, rnd(seed, 17) * 100, col);
}

// ---------------------------------------------------------------------------- main

interface Terr { at(e: number, n: number): number; S: number }

export function buildUrban(a: Record<string, TypedArray>, names: string[], roofItems: number[], terr: Terr, ground: Uint8Array,
  houses: HouseBuf | null, tx: number, ty: number): UrbanBuf {
  const S = terr.S;
  const oE = tx * S, oN = ty * S;
  const out = roofItems;
  const inTile = (x: number, y: number) => x >= 0 && x < S && y >= 0 && y < S;

  // ---- obstacles: roads, buildings, houses
  const segs = new Grid<Seg>(24);
  const off = a.r_off as Uint32Array | undefined, rxyz = a.r_xyz as Float32Array | undefined;
  const rcls = a.r_class as Uint8Array | undefined, rw = a.r_width as Float32Array | undefined, rfl = a.r_flags as Uint8Array | undefined;
  if (off && rxyz && rcls) {
    for (let r = 0; r < off.length - 1; r++) {
      if (rfl && rfl[r] & 4) continue;
      const c = rcls[r];
      if (c > 7) continue;
      const hw = (rw?.[r] ?? 8) / 2;
      for (let k = off[r]; k < off[r + 1] - 1; k++) {
        const s: Seg = { x0: rxyz[k * 3], y0: rxyz[k * 3 + 1], x1: rxyz[k * 3 + 3], y1: rxyz[k * 3 + 4], hw, cls: c };
        const m = hw + 3;
        segs.add(Math.min(s.x0, s.x1) - m, Math.min(s.y0, s.y1) - m, Math.max(s.x0, s.x1) + m, Math.max(s.y0, s.y1) + m, s);
      }
    }
  }
  const onRoad = (x: number, y: number, margin: number) => {
    const c = segs.at(x, y);
    if (c) for (const s of c) if (segDist(s, x, y) < s.hw + margin) return true;
    return false;
  };
  interface Poly { a: number; b: number; h: number; x0: number; y0: number; x1: number; y1: number }
  const blds = new Grid<Poly>(32);
  const ro = a.b_ring_off as Uint32Array | undefined, vo = a.b_vert_off as Uint32Array | undefined, bxy = a.b_xy as Float32Array | undefined;
  const bH = a.b_height as Float32Array | undefined;
  const tall: [number, number, number][] = [];
  if (ro && vo && bxy) {
    for (let i = 0; i < ro.length - 1; i++) {
      const r0 = ro[i];
      if (ro[i + 1] <= r0) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = vo[r0]; k < vo[r0 + 1]; k++) { const x = bxy[k * 2], y = bxy[k * 2 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const p: Poly = { a: vo[r0], b: vo[r0 + 1], h: bH ? bH[i] : 8, x0, y0, x1, y1 };
      blds.add(x0 - 1, y0 - 1, x1 + 1, y1 + 1, p);
      if (p.h >= 40) tall.push([(x0 + x1) / 2, (y0 + y1) / 2, p.h]);
    }
  }
  const hGrid = new Grid<number>(32);
  if (houses) for (let i = 0; i < houses.count; i++) {
    const r = Math.hypot(houses.len[i], houses.wid[i]) / 2 + 1;
    hGrid.add(houses.xy[i * 2] - r, houses.xy[i * 2 + 1] - r, houses.xy[i * 2] + r, houses.xy[i * 2 + 1] + r, i);
  }
  const inBuilding = (x: number, y: number, m = 0.3) => {
    const c = blds.at(x, y);
    if (c && bxy) for (const p of c) {
      if (x < p.x0 - m || x > p.x1 + m || y < p.y0 - m || y > p.y1 + m) continue;
      if (inRing(bxy, p.a, p.b, x, y) || inRing(bxy, p.a, p.b, x + m, y) || inRing(bxy, p.a, p.b, x - m, y) || inRing(bxy, p.a, p.b, x, y + m) || inRing(bxy, p.a, p.b, x, y - m)) return true;
    }
    const h = hGrid.at(x, y);
    if (h && houses) for (const i of h) {
      const dx = x - houses.xy[i * 2], dy = y - houses.xy[i * 2 + 1];
      const ca = Math.cos(houses.angle[i]), sa = Math.sin(houses.angle[i]);
      const u = dx * ca + dy * sa, v = dx * sa - dy * ca;
      if (Math.abs(u) < houses.len[i] / 2 + m && Math.abs(v) < houses.wid[i] / 2 + m) return true;
    }
    return false;
  };
  const placed = new Grid<[number, number, number]>(16);
  const free = (x: number, y: number, r: number) => {
    const c = placed.at(x, y);
    if (c) for (const [px, py, pr] of c) if (Math.hypot(px - x, py - y) < r + pr) return false;
    return true;
  };
  const claim = (x: number, y: number, r: number) => placed.add(x - r, y - r, x + r, y + r, [x, y, r]);

  // ---------------------------------------------------------------- laneways
  if (off && rxyz) {
    const nm = a.r_name as Uint16Array | undefined;
    // unmapped-subtype fallback: a lane has houses along it
    const homes = (x: number, y: number) => {
      let n = 0;
      for (const dx of [-24, 0, 24]) for (const dy of [-24, 0, 24]) n += hGrid.at(x + dx, y + dy)?.length ?? 0;
      return n >= 4;
    };
    for (const r of alleyPiecesAt(a, oE, oN, names, homes)) {
      const hw = Math.max(1.8, Math.min(3, (rw?.[r] ?? 4) / 2));
      const seed = (Math.round(rxyz[off[r] * 3] * 7) * 131 + Math.round(rxyz[off[r] * 3 + 1] * 13)) ^ (nm ? nm[r] : 0);
      // cumulative length along the piece
      const k0 = off[r], k1 = off[r + 1];
      const cum: number[] = [0];
      for (let k = k0 + 1; k < k1; k++) cum.push(cum[cum.length - 1] + Math.hypot(rxyz[k * 3] - rxyz[k * 3 - 3], rxyz[k * 3 + 1] - rxyz[k * 3 - 2]));
      const total = cum[cum.length - 1];
      if (total < 12) continue;
      const at = (s: number) => {
        let k = 0;
        while (k < cum.length - 2 && cum[k + 1] < s) k++;
        const t = Math.max(0, Math.min(1, (s - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k])));
        const i0 = k0 + k, i1 = i0 + 1;
        const dx = rxyz[i1 * 3] - rxyz[i0 * 3], dy = rxyz[i1 * 3 + 1] - rxyz[i0 * 3 + 1], l = Math.hypot(dx, dy) || 1;
        return { x: rxyz[i0 * 3] + dx * t, y: rxyz[i0 * 3 + 1] + dy * t, ux: dx / l, uy: dy / l };
      };
      // utility poles + wire spans down one side (Toronto Hydro runs its secondary lines along the lanes)
      const poleSide = rnd(seed, 1) < 0.5 ? 1 : -1;
      let prev: { x: number; y: number; z: number } | null = null;
      const span = 30 + rnd(seed, 2) * 8;
      for (let s = 3 + rnd(seed, 3) * 8; s < total - 2; s += span) {
        const p = at(s);
        const nx = p.uy * poleSide, ny = -p.ux * poleSide; // right of travel × side
        const x = p.x + nx * (hw + 0.35), y = p.y + ny * (hw + 0.35);
        if (!inTile(x, y) || inBuilding(x, y, 0.25)) { prev = null; continue; }
        const z = terr.at(x, y);
        pushItem(out, UK.POLE, x, y, z, Math.atan2(-ny, -nx), 1, 0.9, 1, 0);
        claim(x, y, 0.6);
        if (prev) {
          const dx = x - prev.x, dy = y - prev.y;
          // wire: sx = span length, sy = rise (z − previous z)
          pushItem(out, UK.WIRE, prev.x, prev.y, prev.z, Math.atan2(dy, dx), Math.hypot(dx, dy), z - prev.z, 0.9, 0);
        }
        prev = { x, y, z };
      }
      // lots along both sides: garage / fence (+ gate) / open parking pad, bins
      for (const side of [1, -1]) {
        let s = 1.5 + rnd(seed, 20 + side) * 3;
        let lot = 0;
        while (s < total - 2) {
          lot++;
          const lotW = 5.2 + rnd(seed, lot, 30 + side) * 3.2; // old-city lots: 5–8.5 m frontage
          const sm = s + lotW / 2;
          if (sm > total - 1.5) break;
          const p = at(sm);
          const nx = p.uy * side, ny = -p.ux * side;
          const ang = Math.atan2(ny, nx); // outward from the lane
          const edge = hw + 0.25;
          const bx = p.x + nx * edge, by = p.y + ny * edge;
          const r = rnd(seed, lot, 40 + side);
          s += lotW;
          if (!inTile(bx, by)) continue;
          // an existing (mapped) garage or building on the lane line: the facade / house shader gives it a door
          if (inBuilding(bx + nx * 1.2, by + ny * 1.2, 0.4) || inBuilding(bx - p.ux * (lotW / 2 - 0.5) + nx * 1, by - p.uy * (lotW / 2 - 0.5) + ny * 1, 0.2)
            || inBuilding(bx + p.ux * (lotW / 2 - 0.5) + nx * 1, by + p.uy * (lotW / 2 - 0.5) + ny * 1, 0.2)) continue;
          if (onRoad(bx + nx * 3, by + ny * 3, 0.3)) continue; // a street, not a back yard
          const zz = terr.at(bx, by);
          // garage: needs ~6.5 m of free yard behind the lane line
          let deep = true;
          for (const d of [2, 4, 6.5]) for (const o of [-1.4, 1.4]) {
            const qx = bx + nx * d + p.ux * o, qy = by + ny * d + p.uy * o;
            if (inBuilding(qx, qy, 0.3) || onRoad(qx, qy, 0.2)) deep = false;
          }
          if (deep && r < 0.42 && lotW > 5.4) {
            const gw = lotW > 7.8 && rnd(seed, lot, 50) < 0.4 ? 5.8 : 3.3; // double or single
            const gx = bx + nx * 3.05, gy = by + ny * 3.05;
            // variant: bits 0-3 door colour, bit 4 graffiti (tasteful: ~1 in 7), bit 5 flat vs shed roof
            const v = ((rnd(seed, lot, 51) * 16) | 0) | (rnd(seed, lot, 52) < 0.15 ? 16 : 0) | (rnd(seed, lot, 53) < 0.35 ? 32 : 0);
            pushItem(out, UK.GARAGE, gx, gy, zz, ang + Math.PI, 1, 1, gw / 3.3, v);
            claim(gx, gy, 3);
            // fence stubs filling the rest of the lot line
            const rest = (lotW - gw) / 2;
            if (rest > 0.8) for (const o of [-1, 1]) {
              const cxf = bx + p.ux * o * (gw / 2 + rest / 2), cyf = by + p.uy * o * (gw / 2 + rest / 2);
              pushItem(out, UK.FENCE, cxf, cyf, terr.at(cxf, cyf), Math.atan2(p.uy, p.ux), rest / 2.4, 1, 1, seed & 1);
            }
          } else if (r < 0.82) {
            // board fence along the lot line, with a gate on some
            const n = Math.max(1, Math.round(lotW / 2.4));
            const seg = lotW / n;
            const gate = rnd(seed, lot, 54) < 0.5 ? (rnd(seed, lot, 55) * n) | 0 : -1;
            const style = rnd(seed, lot, 56) < 0.88 ? (seed & 1) : 2 + (seed & 1); // 0/1 boards (fresh / weathered) · 2/3 chain-link / painted
            for (let q = 0; q < n; q++) {
              if (q === gate) continue;
              const o = -lotW / 2 + seg * (q + 0.5);
              const fx = bx + p.ux * o, fy = by + p.uy * o;
              if (onRoad(fx, fy, 0.1)) continue;
              pushItem(out, UK.FENCE, fx, fy, terr.at(fx, fy), Math.atan2(p.uy, p.ux), seg / 2.4, rnd(seed, lot, 57 + q) < 0.2 ? 0.8 : 1, 1, style);
            }
          }
          // collection bins set out at the lane line
          if (r > 0.3 && rnd(seed, lot, 60) < 0.35) {
            const nb = 1 + ((rnd(seed, lot, 61) * 3) | 0);
            for (let q = 0; q < nb; q++) {
              const o = (rnd(seed, lot, 62) - 0.5) * (lotW - 2) + q * 0.72;
              const x = bx - nx * 0.55 + p.ux * o, y = by - ny * 0.55 + p.uy * o;
              if (!inTile(x, y) || !free(x, y, 0.3)) continue;
              pushItem(out, UK.BIN, x, y, terr.at(x, y), ang + Math.PI + (rnd(seed, lot, 63 + q) - 0.5) * 0.5, 1, 1, 1, (q + ((rnd(seed, lot, 64) * 3) | 0)) % 3);
              claim(x, y, 0.35);
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- construction sites (ground class 18)
  const R = 256, px = S / R;
  const isC = (i: number, j: number) => i >= 0 && j >= 0 && i < R && j < R && ground[j * R + i] === 18;
  const label = new Int32Array(R * R).fill(-1);
  const comps: number[][] = [];
  const stack: number[] = [];
  for (let s0 = 0; s0 < R * R; s0++) {
    if (label[s0] >= 0 || ground[s0] !== 18) continue;
    const id = comps.length, cells: number[] = [];
    stack.length = 0; stack.push(s0); label[s0] = id;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const i = c % R, j = (c / R) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (!isC(ii, jj)) continue;
        const k = jj * R + ii;
        if (label[k] < 0) { label[k] = id; stack.push(k); }
      }
    }
    comps.push(cells);
  }
  const inSite = (x: number, y: number, id: number) => {
    const i = Math.floor(x / px), j = Math.floor(y / px);
    return i >= 0 && j >= 0 && i < R && j < R && label[j * R + i] === id;
  };
  const siteSeed0 = tx * 7919 + ty * 104729;
  // Toronto's crane count peaked around 2022 at ~250 region-wide (RLB Crane Index), dense in the core:
  // at most ~8 per km² tile and never two masts within 60 m
  const cranesAt: [number, number][] = [];
  const craneOK = (x: number, y: number) => cranesAt.length < 8 && cranesAt.every(([cx, cy]) => Math.hypot(cx - x, cy - y) > 60);
  // big sites first (they're the ones that get cranes when the cap binds)
  const order = comps.map((_, i) => i).sort((p, q) => comps[q].length - comps[p].length);
  for (const id of order) {
    const cells = comps[id];
    const area = cells.length * px * px;
    if (area < 350) continue;
    // principal axes (PCA over the cells)
    let mx = 0, my = 0;
    for (const c of cells) { mx += c % R; my += (c / R) | 0; }
    mx /= cells.length; my /= cells.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const c of cells) { const dx = c % R - mx, dy = ((c / R) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const cxw = (mx + 0.5) * px, cyw = (my + 0.5) * px;
    for (const c of cells) {
      const x = (c % R + 0.5) * px - cxw, y = (((c / R) | 0) + 0.5) * px - cyw;
      const u = x * ux + y * uy, v = x * vx + y * vy;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const Ls = u1 - u0 + px, Ws = v1 - v0 + px;
    const ocx = cxw + ux * (u0 + u1) / 2 + vx * (v0 + v1) / 2, ocy = cyw + uy * (u0 + u1) / 2 + vy * (v0 + v1) / 2;
    const seed = siteSeed0 + Math.round(ocx) * 31 + Math.round(ocy) * 17;
    const E = oE + ocx, N = oN + ocy;
    const dist = district(E, N);
    let tallNear = 0;
    for (const [x, y, h] of tall) if (Math.hypot(x - ocx, y - ocy) < 350) tallNear = Math.max(tallNear, h);
    const P = (u: number, v: number): [number, number] => [ocx + ux * u + vx * v, ocy + uy * u + vy * v];
    // how built-up the surroundings are (tower sites and cranes follow density)
    const dens = Math.max(dist.core, tallNear >= 45 ? 1 : tallNear >= 25 ? 0.6 : 0, dist.old * 0.55);
    const okAt = (x: number, y: number, m: number) => inTile(x, y) && inSite(x, y, id) && !inBuilding(x, y, m) && !onRoad(x, y, 0.5) && free(x, y, m);
    const huge = area > 25000;
    // tower sites: dense districts, or next to existing towers
    const towerSite = !huge && area >= 700 && Ws >= 18 && rnd(seed, 1) < 0.2 + dens * 0.75;
    // ---- hoarding around the site (vector outline when the tile has one, else the raster edge)
    hoarding(a, S, id, label, out, terr, onRoad, inBuilding, seed);
    // ---- tower(s) under construction + cranes
    let cranes = 0;
    if (towerSite) {
      const nT = area > 7000 && Ls > 70 ? 2 : 1;
      for (let t = 0; t < nT; t++) {
        const uc = nT === 1 ? 0 : (t === 0 ? -Ls / 4 : Ls / 4);
        const [x, y] = P(uc, 0);
        const L = Math.min(34, Math.max(18, (nT === 1 ? Ls : Ls / 2) * 0.6)), W = Math.min(26, Math.max(15, Ws * 0.55));
        if (!okAt(x, y, 4)) continue;
        const withCrane = craneOK(x, y);
        if (withCrane) cranesAt.push([x, y]);
        // stage: early (core + a few floors) to topping out
        const tgt = tallNear >= 45 ? Math.max(60, tallNear * (0.7 + rnd(seed, 20 + t) * 0.6)) : 30 + rnd(seed, 21 + t) * 60 * (0.4 + dist.core);
        const h = Math.max(8, tgt * (0.12 + rnd(seed, 22 + t) * 0.8));
        towerInProgress(out, x, y, th, L, W, terr.at(x, y), h, seed + t * 101, withCrane, dist.core);
        claim(x, y, Math.hypot(L, W) / 2 + 5);
        if (withCrane) cranes++;
      }
    }
    // extra cranes on big sites (mid-rise blocks, podiums, the waterfront precincts)
    const want = rnd(seed, 2) > 0.25 + dens * 0.7 ? 0 : huge ? 1 + (rnd(seed, 3) < 0.4 ? 1 : 0) : area > 4000 ? 1 + (rnd(seed, 3) < 0.35 ? 1 : 0) : area > 1500 && rnd(seed, 4) < 0.45 ? 1 : 0;
    const goal = Math.min(3, cranes + want);
    for (let c = 0; cranes < goal && c < 8; c++) {
      const [x, y] = P((rnd(seed, 30 + c) - 0.5) * Ls * 0.7, (rnd(seed, 40 + c) - 0.5) * Ws * 0.6);
      if (!okAt(x, y, 4) || !craneOK(x, y)) continue;
      cranesAt.push([x, y]);
      craneAt(out, x, y, terr.at(x, y), 32 + rnd(seed, 50 + c) * 28, rnd(seed, 51 + c) < 0.25, seed + c * 13);
      claim(x, y, 4);
      cranes++;
      if (cranes >= 3) break;
    }
    // ---- site offices (stacked on tower sites), toilets, a roll-off bin, excavators on open ground
    const edgeSpot = (u: number, v: number) => {
      for (let k = 0; k < 6; k++) {
        const f = 1 - k * 0.12;
        const [x, y] = P(u * f, v * f);
        if (okAt(x, y, 3)) return [x, y] as [number, number];
      }
      return null;
    };
    const sgn = rnd(seed, 60) < 0.5 ? 1 : -1;
    const tr = edgeSpot(sgn * (Ls / 2 - 8), (Ws / 2 - 3.5) * (rnd(seed, 61) < 0.5 ? 1 : -1));
    if (tr) {
      const stackN = towerSite && rnd(seed, 62) < 0.7 ? 2 : 1;
      for (let q = 0; q < (area > 3000 ? 2 : 1); q++) {
        const x = tr[0] + ux * q * 13, y = tr[1] + uy * q * 13;
        if (q && !okAt(x, y, 2)) break;
        for (let st = 0; st < stackN; st++) pushItem(out, UK.TRAILER, x, y, terr.at(tr[0], tr[1]) + st * 2.75, th, 1, 1, 1, (rnd(seed, 63) * 3) | 0);
        claim(x, y, 6.5);
      }
      for (let q = 0; q < 2 + (area > 5000 ? 1 : 0); q++) {
        const x = tr[0] - ux * (8 + q * 1.3) * sgn, y = tr[1] - uy * (8 + q * 1.3) * sgn;
        if (okAt(x, y, 0.7)) { pushItem(out, UK.TOILET, x, y, terr.at(x, y), th + Math.PI / 2, 1, 1, 1, (rnd(seed, 64) * 2) | 0); claim(x, y, 0.7); }
      }
    }
    const db = edgeSpot(-sgn * (Ls / 2 - 6), (Ws / 2 - 3) * (rnd(seed, 65) < 0.5 ? 1 : -1));
    if (db) { pushItem(out, UK.DUMPSTER, db[0], db[1], terr.at(db[0], db[1]), th, 1, 1, 1, (rnd(seed, 66) * 3) | 0); claim(db[0], db[1], 3.5); }
    if (!towerSite || huge) {
      const nEx = huge ? 3 : area > 2500 ? 1 + (rnd(seed, 67) < 0.5 ? 1 : 0) : rnd(seed, 67) < 0.6 ? 1 : 0;
      for (let q = 0; q < nEx; q++) {
        const [x, y] = P((rnd(seed, 70 + q) - 0.5) * Ls * 0.6, (rnd(seed, 80 + q) - 0.5) * Ws * 0.5);
        if (!okAt(x, y, 4)) continue;
        pushItem(out, UK.EXCAVATOR, x, y, terr.at(x, y), rnd(seed, 90 + q) * Math.PI * 2, 1, 1, 1, (rnd(seed, 91 + q) * 2) | 0);
        claim(x, y, 4.5);
      }
    }
  }

  return { items: Float32Array.from(out) };
}

/**
 * Site hoarding: 2.4 m panels along the site boundary where it borders
 * anything that isn't the site (street, sidewalk, neighbours). Vector ground
 * polygons (gp_class 18) give the real outline; else the 4 m raster edge.
 * Panels are HOARD items: sx = length / 7.32 m, variant = site colour scheme.
 */
function hoarding(a: Record<string, TypedArray>, S: number, id: number, label: Int32Array, out: number[],
  terr: Terr, onRoad: (x: number, y: number, m: number) => boolean, inBuilding: (x: number, y: number, m?: number) => boolean, seed: number) {
  const R = 256, px = S / R;
  const lab = (x: number, y: number) => {
    const i = Math.floor(x / px), j = Math.floor(y / px);
    return i >= 0 && j >= 0 && i < R && j < R ? label[j * R + i] : -2;
  };
  const scheme = (rnd(seed, 200) * 8) | 0;
  const edges: number[] = [];
  const gpOff = a.gp_off as Uint32Array | undefined, gpXy = a.gp_xy as Uint16Array | undefined, gpC = a.gp_class as Uint8Array | undefined;
  if (gpOff && gpXy && gpC) {
    const q = S / 65535;
    for (let p = 0; p < gpC.length; p++) {
      if (gpC[p] !== 18) continue;
      const s = gpOff[p], e = gpOff[p + 1];
      // this polygon belongs to the component?
      let cx = 0, cy = 0;
      for (let k = s; k < e; k++) { cx += gpXy[k * 2] * q; cy += gpXy[k * 2 + 1] * q; }
      cx /= e - s; cy /= e - s;
      let hit = false;
      for (let k = s; k < e && !hit; k++) {
        const x = gpXy[k * 2] * q, y = gpXy[k * 2 + 1] * q;
        const mx = (x + cx) / 2, my = (y + cy) / 2;
        if (lab(mx, my) === id) hit = true;
      }
      if (!hit && lab(cx, cy) !== id) continue;
      for (let k = s; k < e; k++) {
        const k2 = k + 1 < e ? k + 1 : s;
        edges.push(gpXy[k * 2] * q, gpXy[k * 2 + 1] * q, gpXy[k2 * 2] * q, gpXy[k2 * 2 + 1] * q);
      }
    }
  }
  if (!edges.length) {
    // raster boundary (marching squares over cell centres, one segment per boundary cell)
    for (let j = -1; j < R; j++) for (let i = -1; i < R; i++) {
      const A = lab((i + 0.5) * px, (j + 0.5) * px) === id, B = lab((i + 1.5) * px, (j + 0.5) * px) === id;
      const C = lab((i + 1.5) * px, (j + 1.5) * px) === id, D = lab((i + 0.5) * px, (j + 1.5) * px) === id;
      const n = +A + +B + +C + +D;
      if (n === 0 || n === 4) continue;
      const cx = (k: number) => (k + 0.5) * px;
      const mids: [number, number][] = [];
      const corners: [number, number, boolean][] = [[cx(i), cx(j), A], [cx(i + 1), cx(j), B], [cx(i + 1), cx(j + 1), C], [cx(i), cx(j + 1), D]];
      for (let k = 0; k < 4; k++) {
        const p = corners[k], q2 = corners[(k + 1) % 4];
        if (p[2] !== q2[2]) mids.push([(p[0] + q2[0]) / 2, (p[1] + q2[1]) / 2]);
      }
      if (mids.length === 2) edges.push(mids[0][0], mids[0][1], mids[1][0], mids[1][1]);
    }
  }
  const PANEL = 7.32;
  for (let e = 0; e < edges.length; e += 4) {
    const x0 = edges[e], y0 = edges[e + 1], x1 = edges[e + 2], y1 = edges[e + 3];
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L < 0.8) continue;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    // tile border edges belong to the clip, not the site
    const onBorder = (Math.abs(x0 - x1) < 0.05 && (x0 < 0.05 || x0 > S - 0.05)) || (Math.abs(y0 - y1) < 0.05 && (y0 < 0.05 || y0 > S - 0.05));
    if (onBorder) continue;
    // outward = the side that is not the site (vote over three samples, 3 m out)
    const nlx = -uy, nly = ux;
    let outL = 0, outR = 0;
    for (const t of [0.25, 0.5, 0.75]) {
      const qx = x0 + ux * L * t, qy = y0 + uy * L * t;
      if (lab(qx + nlx * 3, qy + nly * 3) !== id) outL++;
      if (lab(qx - nlx * 3, qy - nly * 3) !== id) outR++;
    }
    if (Math.abs(outL - outR) < 2) continue; // interior split edge (hole cuts) or noise
    const ox = outL > outR ? nlx : -nlx, oy = outL > outR ? nly : -nly;
    // the panel model's +z (painted / branded face) is to the right of its +x: flip so it faces out
    const ang = Math.atan2(uy, ux) + (uy * ox - ux * oy > 0 ? 0 : Math.PI);
    const n = Math.max(1, Math.ceil(L / PANEL));
    const seg = L / n;
    for (let k = 0; k < n; k++) {
      // panels sit ~0.3 m inside the lot line; skip the bits across a carriageway or through a building
      const px2 = x0 + ux * seg * (k + 0.5) - ox * 0.3, py2 = y0 + uy * seg * (k + 0.5) - oy * 0.3;
      if (px2 < 0 || py2 < 0 || px2 >= S || py2 >= S) continue;
      if (onRoad(px2, py2, 0.2) || inBuilding(px2, py2, 0.2)) continue;
      pushItem(out, UK.HOARD, px2, py2, terr.at(px2, py2), ang, (seg + 0.05) / PANEL, 1, 1, scheme);
    }
  }
}
