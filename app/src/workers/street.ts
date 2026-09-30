// Street furniture placement (tile worker): OSM trees / lamps + procedural
// street trees, park/forest trees, street lights along urban roads and traffic
// signal heads at signalized junctions. Deterministic (hash-seeded), so the
// same tile always produces the same furniture.
import type { TypedArray } from '../data/tbn';
import type { StreetRoad, Terrain } from './roads';

export interface StreetBuf {
  /** stride 6: x, n (tile-local E, N), z (datum), scale, kind (0 broadleaf · 1 conifer · 2 small), seed (0..1) */
  trees: Float32Array;
  /** stride 5: x, n, z, angle (rad CCW from +E: direction the lamp arm points), height */
  lamps: Float32Array;
  /** stride 7: x, n, z, angle (heads face this way), junction index, phase (0 | 1), mast length */
  signals: Float32Array;
  /** OSM node id per junction index used by `signals` */
  signalIds: Float64Array;
}

const TREE = 6, LAMP = 5, SIG = 7;

function rnd(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** uniform-grid spatial hash of items with a bounding radius */
class Grid<T> {
  cells = new Map<number, T[]>();
  size: number;
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
  at(x: number, y: number): T[] | undefined {
    return this.cells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size)));
  }
}

interface Seg { x0: number; y0: number; x1: number; y1: number; hw: number }

function segDist(s: Seg, x: number, y: number): number {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - s.x0) * dx + (y - s.y0) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (s.x0 + dx * t), y - (s.y0 + dy * t));
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

export function buildStreet(
  a: Record<string, TypedArray>, streets: StreetRoad[], junctions: { x: number; y: number; flags: number; osm: number; arms: { ang: number; r: number; hw: number }[] }[],
  terr: Terrain, ground: Uint8Array, tx: number, ty: number,
): StreetBuf {
  const S = terr.S;
  const trees: number[] = [], lamps: number[] = [], signals: number[] = [];
  const signalIds: number[] = [];
  const inTile = (x: number, y: number) => x >= 0 && x < S && y >= 0 && y < S;
  const gAt = (x: number, y: number) => ground[Math.min(255, Math.max(0, Math.floor((y / S) * 256))) * 256 + Math.min(255, Math.max(0, Math.floor((x / S) * 256)))];
  // no trees on airfields (aerodrome 14, runway/taxiway 20, airfield grass 23), checked with a
  // margin so none stand beside a runway edge either
  const airfield = (x: number, y: number) => {
    for (const [dx, dy] of [[0, 0], [24, 0], [-24, 0], [0, 24], [0, -24]]) {
      const g = gAt(x + dx, y + dy);
      if (g === 14 || g === 20 || g === 23) return true;
    }
    return false;
  };

  // ---- obstacles: road segments, buildings, houses
  const roads = new Grid<Seg>(24);
  for (const r of streets) {
    for (let k = 0; k < r.x.length - 1; k++) {
      const s: Seg = { x0: r.x[k], y0: r.y[k], x1: r.x[k + 1], y1: r.y[k + 1], hw: r.hw };
      const m = r.hw + 4;
      roads.add(Math.min(s.x0, s.x1) - m, Math.min(s.y0, s.y1) - m, Math.max(s.x0, s.x1) + m, Math.max(s.y0, s.y1) + m, s);
    }
  }
  const onRoad = (x: number, y: number, margin: number) => {
    const c = roads.at(x, y);
    if (c) for (const s of c) if (segDist(s, x, y) < s.hw + margin) return true;
    return false;
  };
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

  // ---- OSM points
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined, pv = a.p_var as Uint8Array | undefined;
  const osmTrees = new Grid<number>(16);
  const osmLamps = new Grid<number>(32);
  if (pk && pxy) {
    for (let i = 0; i < pk.length; i++) {
      const x = pxy[i * 2], y = pxy[i * 2 + 1];
      if (pk[i] === 3) {
        if (airfield(x, y)) continue;
        const r = rnd(tx * 131 + i, ty, 7);
        trees.push(x, y, terr.at(x, y), 0.75 + r * 0.55, pv && pv[i] === 1 ? 1 : 0, rnd(i, tx, ty));
        osmTrees.add(x - 5, y - 5, x + 5, y + 5, i);
      } else if (pk[i] === 4) {
        // face the nearest road
        let best: Seg | null = null, bd = 25;
        const c = roads.at(x, y);
        if (c) for (const s of c) { const d = segDist(s, x, y); if (d < bd) { bd = d; best = s; } }
        let ang = rnd(i, 3) * Math.PI * 2;
        if (best) {
          const dx = best.x1 - best.x0, dy = best.y1 - best.y0, l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - best.x0) * dx + (y - best.y0) * dy) / l2));
          ang = Math.atan2(best.y0 + dy * t - y, best.x0 + dx * t - x);
        }
        lamps.push(x, y, terr.at(x, y), ang, 8.5);
        osmLamps.add(x - 25, y - 25, x + 25, y + 25, i);
      }
    }
  }
  const nearOsmTree = (x: number, y: number) => {
    const c = osmTrees.at(x, y);
    if (c && pxy) for (const i of c) if (Math.hypot(pxy[i * 2] - x, pxy[i * 2 + 1] - y) < 5) return true;
    return false;
  };
  const nearOsmLamp = (x: number, y: number) => {
    const c = osmLamps.at(x, y);
    if (c && pxy) for (const i of c) if (Math.hypot(pxy[i * 2] - x, pxy[i * 2 + 1] - y) < 22) return true;
    return false;
  };

  // ---- procedural street trees and lamps along urban roads
  let ri = 0;
  for (const r of streets) {
    ri++;
    if (!r.urban || r.cls < 2 || r.cls > 5) continue;
    const at = (s: number) => {
      let k = 0;
      while (k < r.s.length - 2 && r.s[k + 1] < s) k++;
      const t = Math.max(0, Math.min(1, (s - r.s[k]) / Math.max(1e-6, r.s[k + 1] - r.s[k])));
      const ox = r.ox[k] + (r.ox[k + 1] - r.ox[k]) * t, oy = r.oy[k] + (r.oy[k + 1] - r.oy[k]) * t;
      const l = Math.hypot(ox, oy) || 1;
      return { x: r.x[k] + (r.x[k + 1] - r.x[k]) * t, y: r.y[k] + (r.y[k + 1] - r.y[k]) * t, nx: ox / l, ny: oy / l };
    };
    const lampStep = r.cls <= 3 ? 32 : 38;
    for (const sd of [1, -1]) {
      const hasSW = (r.side & (sd === 1 ? 1 : 2)) !== 0;
      const ws = hasSW ? r.ws : 0;
      for (const [c0, c1] of r.clear) {
        // lamps: just behind the curb; both sides staggered on arterials, one side on locals
        if (r.cls <= 3 || sd === 1) {
          const phase = sd === 1 ? 0 : lampStep / 2;
          const first = Math.ceil((c0 + 4 - phase) / lampStep) * lampStep + phase;
          for (let s = first; s < c1 - 4; s += lampStep) {
            const p = at(s);
            const lo = r.hw + (hasSW ? 0.6 : 1.2);
            const x = p.x + sd * p.nx * lo, y = p.y + sd * p.ny * lo;
            if (!inTile(x, y) || nearOsmLamp(x, y) || inBuilding(x, y, 0.3) || onRoad(x, y, 0.2)) continue;
            lamps.push(x, y, terr.at(x, y), Math.atan2(-sd * p.ny, -sd * p.nx), r.cls <= 3 ? 9.5 : 7.5);
          }
        }
        // trees: boulevard beyond the sidewalk (residential / parks) or pits in the sidewalk (commercial)
        if (r.cls < 3) continue;
        const step = 10 + rnd(ri, sd, 1) * 4;
        for (let s = Math.ceil((c0 + 6) / step) * step; s < c1 - 6; s += step) {
          const js = s + (rnd(ri, Math.round(s), sd) - 0.5) * 3;
          const p = at(js);
          const probe = gAt(p.x + sd * p.nx * (r.hw + ws + 2), p.y + sd * p.ny * (r.hw + ws + 2));
          const pit = hasSW && (probe === 5 || probe === 6 || probe === 11 || probe === 21);
          const prob = probe === 4 || probe === 0 ? 0.72 : probe === 2 ? 0.8 : probe === 17 || probe === 12 ? 0.55 : pit ? 0.3 : 0.2;
          if (rnd(ri, Math.round(s * 7), sd + 9) > prob) continue;
          const off = pit ? r.hw + 1.0 : r.hw + ws + (hasSW ? 1.3 : 2.5) + rnd(ri, Math.round(s), 5) * 1.2;
          const x = p.x + sd * p.nx * off, y = p.y + sd * p.ny * off;
          if (!inTile(x, y) || nearOsmTree(x, y) || onRoad(x, y, pit ? 0.5 : 1.0) || inBuilding(x, y, 2.0)) continue;
          const g = gAt(x, y);
          if (g === 1 || g === 10 || g === 20 || airfield(x, y)) continue;
          const sc = pit ? 0.6 + rnd(ri, s, 11) * 0.3 : 0.75 + rnd(ri, s, 12) * 0.6;
          trees.push(x, y, terr.at(x, y), sc, rnd(ri, s, 13) < 0.08 ? 1 : 0, rnd(ri, s, 14));
        }
      }
    }
  }

  // ---- parks, forests, cemeteries: scattered trees on the 4 m land-cover raster
  const DENS: Record<number, number> = { 3: 0.3, 2: 0.035, 12: 0.07, 13: 0.03, 16: 0.06 };
  const px = S / 256;
  let scatter = 0;
  for (let j = 0; j < 256 && scatter < 6000; j++) {
    for (let i = 0; i < 256; i++) {
      const g = ground[j * 256 + i];
      const d = DENS[g];
      if (!d || rnd(tx * 256 + i, ty * 256 + j, 21) > d) continue;
      const x = (i + rnd(i, j, 22)) * px, y = (j + rnd(i, j, 23)) * px;
      if (nearOsmTree(x, y) || onRoad(x, y, 1.5) || inBuilding(x, y, 1.5) || airfield(x, y)) continue;
      const conifer = g === 3 ? rnd(i, j, 24) < 0.3 : rnd(i, j, 24) < 0.1;
      trees.push(x, y, terr.at(x, y), (g === 3 ? 0.85 : 0.75) + rnd(i, j, 25) * 0.6, conifer ? 1 : 0, rnd(i, j, 26));
      scatter++;
    }
  }

  // ---- traffic signals: a pole on the far-right corner of every approach
  for (const jn of junctions) {
    if (!(jn.flags & 1) || !inTile(jn.x, jn.y)) continue;
    const ji = signalIds.length;
    signalIds.push(jn.osm);
    const a0 = jn.arms.length ? jn.arms[0].ang : 0;
    for (const arm of jn.arms) {
      const ca = Math.cos(arm.ang), sa = Math.sin(arm.ang);
      // traffic approaches along -arm direction; far side is beyond the junction
      const tX = -ca, tY = -sa;
      const rX = tY, rY = -tX; // right of travel
      const opp = jn.arms.reduce((best, o) => (Math.cos(o.ang - arm.ang) < Math.cos(best.ang - arm.ang) ? o : best), arm);
      const far = (opp !== arm ? opp.r : arm.r) + 1.8;
      const x = jn.x + tX * far + rX * (arm.hw + 1.2), y = jn.y + tY * far + rY * (arm.hw + 1.2);
      const phase = Math.abs(Math.sin(arm.ang - a0)) > 0.7 ? 1 : 0;
      signals.push(x, y, terr.at(x, y), arm.ang, ji, phase, Math.min(Math.max(arm.hw * 0.9, 2.5), 8));
    }
  }

  return { trees: Float32Array.from(trees), lamps: Float32Array.from(lamps), signals: Float32Array.from(signals), signalIds: Float64Array.from(signalIds) };
}

export const STREET_STRIDE = { TREE, LAMP, SIG };
