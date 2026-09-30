// Street props (tile worker, level 0): fire hydrants, litter bins, newspaper
// boxes, Canada Post boxes, benches, bike rings, Green P pay stations, planters,
// street-name blades at junctions, hydro poles + wire spans in older
// neighbourhoods, highway guide signs at ramps, house bins, and parking lots
// (asphalt pads, stall stripes, light standards, parked cars). OSM furniture
// nodes (SPEC p_kind 20+) are used where mapped; procedural placement fills in.
// Deterministic (hash-seeded). Rendered by layers/PropsLayer.ts.
import type { TypedArray } from '../data/tbn';
import type { StreetRoad, Terrain } from './roads';
import type { HouseBuf, MeshBuf } from './meshing';
import { district, obb, shopDistrict } from './buildings';
import { era } from './houseFront';

/** prop kinds (PropsLayer pools) */
export const K = {
  HYDRANT: 0, BIN: 1, NEWS: 2, POSTBOX: 3, BENCH: 4, BIKERING: 5, PAYSTATION: 6, PLANTER: 7,
  BLADE: 8, HYDRO: 9, WIRE: 10, HWYSIGN: 11, HOUSEBIN: 12, LOT: 13, STRIPE: 14, LOTLIGHT: 15,
  CAR: 16, BIKESHARE: 17, BUSPOLE: 18, SHELTER: 19, DRIVEWAY: 20,
} as const;
export const PROP_KINDS = 21;
/** record stride: kind, x, n (local E,N), z (elevation), angle (rad CCW from +E, prop faces along it), sx, p0, p1 */
export const PSTRIDE = 8;

export interface PropsBuf {
  items: Float32Array;
  /** street names referenced by blades (p0 / p1 index this list, -1 = none) */
  names: string[];
  /** road segments for snapping runtime transit stops: x0, y0, x1, y1, hw, cls */
  segs: Float32Array;
  /** draped ground paint: parking-lot asphalt, stall stripes, islands, driveways (tile-local three coords) */
  ground: MeshBuf | null;
}

function rnd(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

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

interface Seg { x0: number; y0: number; x1: number; y1: number; hw: number; cls: number }
function segDist(s: Seg, x: number, y: number): number {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / l2)) : 0;
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

const ABBR: [RegExp, string][] = [
  [/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bRoad\b/g, 'Rd'], [/\bBoulevard\b/g, 'Blvd'], [/\bDrive\b/g, 'Dr'],
  [/\bCrescent\b/g, 'Cres'], [/\bCourt\b/g, 'Crt'], [/\bPlace\b/g, 'Pl'], [/\bTerrace\b/g, 'Terr'], [/\bParkway\b/g, 'Pkwy'],
  [/\bGardens\b/g, 'Gdns'], [/\bSquare\b/g, 'Sq'], [/\bCircle\b/g, 'Cir'], [/\bLane\b/g, 'Lane'], [/\bWest\b/g, 'W'], [/\bEast\b/g, 'E'],
  [/\bNorth\b/g, 'N'], [/\bSouth\b/g, 'S'],
];
export function abbreviate(n: string): string {
  let s = n;
  for (const [r, a] of ABBR) s = s.replace(r, a);
  return s;
}

export function buildProps(
  a: Record<string, TypedArray>, names: string[], streets: StreetRoad[],
  junctions: { x: number; y: number; flags: number; osm: number; arms: { ang: number; r: number; hw: number }[] }[],
  terr: Terrain, ground: Uint8Array, houses: HouseBuf | null, tx: number, ty: number,
): PropsBuf {
  const S = terr.S;
  const oE = tx * S, oN = ty * S;
  const out: number[] = [];
  const inTile = (x: number, y: number) => x >= 0 && x < S && y >= 0 && y < S;
  const gAt = (x: number, y: number) => ground[Math.min(255, Math.max(0, Math.floor((y / S) * 256))) * 256 + Math.min(255, Math.max(0, Math.floor((x / S) * 256)))];
  const push = (k: number, x: number, y: number, ang: number, sx = 1, p0 = 0, p1 = 0, z = terr.at(x, y)) => {
    out.push(k, x, y, z, ang, sx, p0, p1);
  };
  const gm = new GroundMesh(terr);

  // ---- obstacles
  const segs = new Grid<Seg>(24);
  const segList: number[] = [];
  const off = a.r_off as Uint32Array | undefined, rxyz = a.r_xyz as Float32Array | undefined;
  const rcls = a.r_class as Uint8Array | undefined, rw = a.r_width as Float32Array | undefined, rfl = a.r_flags as Uint8Array | undefined;
  const rname = a.r_name as Uint16Array | undefined;
  if (off && rxyz && rcls) {
    for (let r = 0; r < off.length - 1; r++) {
      if (rfl && rfl[r] & 4) continue;
      const hw = (rw?.[r] ?? 8) / 2, c = rcls[r];
      for (let k = off[r]; k < off[r + 1] - 1; k++) {
        const s: Seg = { x0: rxyz[k * 3], y0: rxyz[k * 3 + 1], x1: rxyz[k * 3 + 3], y1: rxyz[k * 3 + 4], hw, cls: c };
        const m = hw + 3;
        segs.add(Math.min(s.x0, s.x1) - m, Math.min(s.y0, s.y1) - m, Math.max(s.x0, s.x1) + m, Math.max(s.y0, s.y1) + m, s);
        if (c <= 5 || c === 7) segList.push(s.x0, s.y0, s.x1, s.y1, hw, c);
      }
    }
  }
  const onRoad = (x: number, y: number, margin: number) => {
    const c = segs.at(x, y);
    if (c) for (const s of c) if (s.cls <= 7 && segDist(s, x, y) < s.hw + margin) return true;
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
      blds.add(x0 - 1, y0 - 1, x1 + 1, y1 + 1, p);
    }
  }
  const hGrid = new Grid<number>(32);
  if (houses) for (let i = 0; i < houses.count; i++) {
    const r = Math.hypot(houses.len[i], houses.wid[i]) / 2 + 1;
    hGrid.add(houses.xy[i * 2] - r, houses.xy[i * 2 + 1] - r, houses.xy[i * 2] + r, houses.xy[i * 2 + 1] + r, i);
  }
  const inBuilding = (x: number, y: number, m = 0.3) => {
    const c = blds.at(x, y);
    if (c) for (const p of c) if (inPoly(p, x, y) || inPoly(p, x + m, y) || inPoly(p, x - m, y) || inPoly(p, x, y + m) || inPoly(p, x, y - m)) return true;
    const h = hGrid.at(x, y);
    if (h && houses) for (const i of h) {
      const dx = x - houses.xy[i * 2], dy = y - houses.xy[i * 2 + 1];
      const ca = Math.cos(houses.angle[i]), sa = Math.sin(houses.angle[i]);
      const u = dx * ca + dy * sa, v = dx * sa - dy * ca;
      if (Math.abs(u) < houses.len[i] / 2 + m && Math.abs(v) < houses.wid[i] / 2 + m + 1.2) return true;
    }
    return false;
  };
  // placed props (spacing check)
  const placed = new Grid<[number, number]>(16);
  const free = (x: number, y: number, r: number) => {
    const c = placed.at(x, y);
    if (c) for (const [px, py] of c) if (Math.hypot(px - x, py - y) < r) return false;
    return true;
  };
  const claim = (x: number, y: number) => placed.add(x - 2, y - 2, x + 2, y + 2, [x, y]);
  // junction boxes flare beyond the street centrelines (turn lanes, corner radii, streetcar curves)
  const jGrid = new Grid<[number, number, number]>(32);
  for (const jn of junctions) {
    const r = Math.max(8, ...jn.arms.map((q) => Math.max(q.r, q.hw))) + 6;
    jGrid.add(jn.x - r, jn.y - r, jn.x + r, jn.y + r, [jn.x, jn.y, r]);
  }
  const inJunction = (x: number, y: number) => { const c = jGrid.at(x, y); return !!c && c.some(([jx, jy, r]) => Math.hypot(x - jx, y - jy) < r); };
  const ok = (x: number, y: number, r = 1.2, margin = 0.6) => inTile(x, y) && !onRoad(x, y, margin) && !inJunction(x, y) && !inBuilding(x, y) && free(x, y, r);

  // ---- OSM furniture nodes
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined, pv = a.p_var as Uint8Array | undefined;
  const osmCount = new Map<number, number>();
  const faceRoad = (x: number, y: number): { ang: number; d: number; s: Seg | null } => {
    let best: Seg | null = null, bd = 30;
    for (const c of [segs.at(x, y)]) if (c) for (const s of c) { if (s.cls > 7) continue; const d = segDist(s, x, y) - s.hw; if (d < bd) { bd = d; best = s; } }
    if (!best) return { ang: 0, d: 99, s: null };
    const dx = best.x1 - best.x0, dy = best.y1 - best.y0, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - best.x0) * dx + (y - best.y0) * dy) / l2));
    return { ang: Math.atan2(best.y0 + dy * t - y, best.x0 + dx * t - x), d: bd, s: best };
  };
  if (pk && pxy) {
    for (let i = 0; i < pk.length; i++) {
      const k = pk[i];
      if (k < 20 || k > 29) continue;
      const x = pxy[i * 2], y = pxy[i * 2 + 1];
      if (!inTile(x, y)) continue;
      osmCount.set(k, (osmCount.get(k) ?? 0) + 1);
      const f = faceRoad(x, y);
      const v = pv ? pv[i] : 0;
      claim(x, y);
      switch (k) {
        case 20: { // bike-share dock: a row of docks parallel to the curb
          const n = Math.max(6, Math.min(v || 15, 31));
          const ex = -Math.sin(f.ang), ey = Math.cos(f.ang);
          for (let d = 0; d < n; d++) {
            const o = (d - (n - 1) / 2) * 0.9;
            push(K.BIKESHARE, x + ex * o, y + ey * o, f.ang, 1, d === 0 ? 1 : 0, rnd(i, d) < 0.65 ? 1 : 0);
          }
          break;
        }
        case 21: push(K.POSTBOX, x, y, f.ang); break;
        case 22: push(K.BENCH, x, y, f.ang); break;
        case 23: push(K.BIN, x, y, f.ang, 1, v); break;
        case 24: push(K.HYDRANT, x, y, f.ang); break;
        case 25: break; // bus stops come from the live transit feed (PropsLayer), which knows every TTC / 905 stop
        case 26: push(K.NEWS, x, y, f.ang, 1, (rnd(i) * 4) | 0); break;
        case 27: push(K.BIKERING, x, y, f.ang + Math.PI / 2); break;
        case 29: push(K.PAYSTATION, x, y, f.ang); break;
      }
    }
  }
  const osmHas = (k: number) => (osmCount.get(k) ?? 0) >= 3;

  // ---- along urban streets: hydrants, bins, news boxes, post boxes, rings, pay stations, planters, hydro poles
  const tileE = oE + S / 2, tileN = oN + S / 2;
  const dist = district(tileE, tileN);
  let ri = 0;
  for (const r of streets) {
    ri++;
    if (!r.urban || r.cls < 2 || r.cls > 5 || r.x.length < 2) continue;
    const at = (s: number) => {
      let k = 0;
      while (k < r.s.length - 2 && r.s[k + 1] < s) k++;
      const t = Math.max(0, Math.min(1, (s - r.s[k]) / Math.max(1e-6, r.s[k + 1] - r.s[k])));
      const ox = r.ox[k] + (r.ox[k + 1] - r.ox[k]) * t, oy = r.oy[k] + (r.oy[k + 1] - r.oy[k]) * t;
      const l = Math.hypot(ox, oy) || 1;
      return { x: r.x[k] + (r.x[k + 1] - r.x[k]) * t, y: r.y[k] + (r.y[k + 1] - r.y[k]) * t, nx: ox / l, ny: oy / l };
    };
    const mid = at(r.s[r.s.length - 1] / 2);
    const E0 = oE + mid.x, N0 = oN + mid.y;
    const ew = era(E0, N0, rnd(ri, 7));
    const main = r.cls <= 3;
    const commercial = (main && (ew === 0 || gAt(mid.x, mid.y) === 5)) || shopDistrict(E0, N0);
    const core = district(E0, N0).core > 0.5;
    const seed = Math.round(r.x[0] * 7 + r.y[0] * 13);
    for (const sd of [1, -1]) {
      const hasSW = (r.side & (sd === 1 ? 1 : 2)) !== 0;
      const curb = r.hw + (hasSW ? 0.55 : 1.0); // furniture zone just behind the curb
      const back = r.hw + (hasSW ? Math.max(1.2, r.ws - 0.4) : 2.2);
      const P = (s: number, o: number) => { const p = at(s); return { x: p.x + sd * p.nx * o, y: p.y + sd * p.ny * o, fa: Math.atan2(-sd * p.ny, -sd * p.nx) }; };
      for (const [c0, c1] of r.clear) {
        const len = c1 - c0;
        if (len < 6) continue;
        // hydrants: ~every 90 m, one side per stretch alternating (Toronto red body, yellow bonnet)
        if (!osmHas(24) && (sd === 1) === ((seed & 1) === 0)) {
          for (let s = c0 + 6 + rnd(seed, 1) * 30; s < c1 - 4; s += 85 + rnd(seed, s | 0) * 20) {
            const p = P(s, curb);
            if (ok(p.x, p.y, 3)) { push(K.HYDRANT, p.x, p.y, p.fa); claim(p.x, p.y); }
          }
        }
        if (commercial && hasSW) {
          // litter bins near the block ends, newspaper boxes and post boxes at corners
          for (const [s, first] of [[c0 + 9, true], [c1 - 9, false]] as [number, boolean][]) {
            if (len < 26) break;
            const rr = rnd(seed, sd * 7 + (first ? 1 : 2), ri);
            if (!osmHas(23) && rr < 0.8) { const p = P(s, curb + 0.1); if (ok(p.x, p.y)) { push(K.BIN, p.x, p.y, p.fa, 1, rr < 0.4 ? 1 : 0); claim(p.x, p.y); } }
            if (!osmHas(26) && rr > 0.55) { const p = P(s + (first ? 2.2 : -2.2), curb + 0.2); if (ok(p.x, p.y)) { push(K.NEWS, p.x, p.y, p.fa, 1, (rr * 97) % 4 | 0); claim(p.x, p.y); } }
            if (!osmHas(21) && rr > 0.86) { const p = P(s + (first ? 4 : -4), curb + 0.1); if (ok(p.x, p.y)) { push(K.POSTBOX, p.x, p.y, p.fa); claim(p.x, p.y); } }
          }
          // post-and-ring bike stands, Green P pay-and-display, planters (downtown)
          if (!osmHas(27)) for (let s = c0 + 12; s < c1 - 8; s += 22 + rnd(seed, s | 0, 3) * 10) {
            const p = P(s, curb + 0.05);
            if (ok(p.x, p.y, 2)) { push(K.BIKERING, p.x, p.y, p.fa + Math.PI / 2); claim(p.x, p.y); }
          }
          if (main && !core) for (let s = c0 + 25; s < c1 - 10; s += 70) {
            const p = P(s, curb + 0.05);
            if (rnd(seed, s | 0, 5) < 0.6 && ok(p.x, p.y, 2)) { push(K.PAYSTATION, p.x, p.y, p.fa); claim(p.x, p.y); }
          }
          if (core) for (let s = c0 + 18; s < c1 - 10; s += 30) {
            const p = P(s, curb + 0.3);
            if (rnd(seed, s | 0, 9) < 0.35 && ok(p.x, p.y, 2.5)) { push(K.PLANTER, p.x, p.y, p.fa + Math.PI / 2); claim(p.x, p.y); }
          }
          // benches (streetcar/bus corridors), facing the road, at the building side
          if (!osmHas(22) && len > 40 && rnd(seed, sd, 11) < 0.35) {
            const p = P(c0 + len * 0.5, back);
            if (ok(p.x, p.y, 2)) { push(K.BENCH, p.x, p.y, p.fa + Math.PI); claim(p.x, p.y); }
          }
        }
      }
    }
    // hydro poles + wires: one side of older residential streets (and inner-suburb arterials)
    const wantPoles = (r.cls === 5 && ew <= 1 && rnd(seed, 21) < 0.85) || (r.cls >= 3 && r.cls <= 4 && ew === 1 && rnd(seed, 22) < 0.5) ||
      (r.cls === 4 && ew === 0 && !commercial && rnd(seed, 23) < 0.4);
    if (wantPoles && dist.core < 0.5) {
      const sd = rnd(seed, 24) < 0.5 ? 1 : -1;
      const hasSW = (r.side & (sd === 1 ? 1 : 2)) !== 0;
      const o = r.hw + (hasSW ? 0.5 : 1.4);
      let prev: { x: number; y: number; z: number } | null = null;
      const span = 34 + rnd(seed, 25) * 8;
      for (const [c0, c1] of r.clear) {
        prev = null;
        for (let s = c0 + 4; s < c1 - 2; s += span) {
          const p = at(s);
          const x = p.x + sd * p.nx * o, y = p.y + sd * p.ny * o;
          if (!inTile(x, y) || inBuilding(x, y, 0.2) || onRoad(x, y, 0.1)) { prev = null; continue; }
          const z = terr.at(x, y);
          const fa = Math.atan2(-sd * p.ny, -sd * p.nx);
          push(K.HYDRO, x, y, fa, 1, rnd(seed, s | 0, 26) < 0.18 ? 1 : 0, 0, z);
          claim(x, y);
          if (prev) {
            const dx = x - prev.x, dy = y - prev.y, L = Math.hypot(dx, dy);
            push(K.WIRE, prev.x, prev.y, Math.atan2(dy, dx), L, z - prev.z, fa, prev.z);
          }
          prev = { x, y, z };
        }
      }
    }
  }

  // ---- street-name blades at junctions of named streets (pole on one corner, one blade per street)
  const nameIdx = new Map<number, number>();
  const bladeNames: string[] = [];
  const nm = (i: number) => {
    if (i === 0xffff || !names[i]) return -1;
    let k = nameIdx.get(i);
    if (k === undefined) { k = bladeNames.length; bladeNames.push(abbreviate(names[i])); nameIdx.set(i, k); }
    return k;
  };
  if (off && rxyz && rcls && rname) {
    const vmap = new Map<string, { r: number; k: number }[]>();
    const hk = (x: number, y: number) => `${Math.round(x * 20)},${Math.round(y * 20)}`;
    for (let r = 0; r < off.length - 1; r++) {
      if (rcls[r] < 1 || rcls[r] > 5 || rname[r] === 0xffff) continue;
      for (let k = off[r]; k < off[r + 1]; k++) {
        const key = hk(rxyz[k * 3], rxyz[k * 3 + 1]);
        const l = vmap.get(key);
        if (l) l.push({ r, k }); else vmap.set(key, [{ r, k }]);
      }
    }
    for (const jn of junctions) {
      if (!inTile(jn.x, jn.y) || jn.arms.length < 3) continue;
      const hits = vmap.get(hk(jn.x, jn.y));
      if (!hits) continue;
      // one direction per distinct name
      const seen = new Map<number, number>();
      for (const { r, k } of hits) {
        if (seen.has(rname[r])) continue;
        const k2 = k + 1 < off[r + 1] ? k + 1 : k - 1;
        seen.set(rname[r], Math.atan2(rxyz[k2 * 3 + 1] - rxyz[k * 3 + 1], rxyz[k2 * 3] - rxyz[k * 3]));
      }
      if (seen.size < 2) continue;
      const [[n1, a1], [n2, a2]] = [...seen.entries()];
      // corner: between the first two arms, beyond the junction box
      const arms = [...jn.arms].sort((p, q) => p.ang - q.ang);
      const pickArm = Math.floor(rnd(Math.round(jn.x * 3), Math.round(jn.y * 3)) * arms.length);
      const A = arms[pickArm], B = arms[(pickArm + 1) % arms.length];
      let bis = Math.atan2(Math.sin(A.ang) + Math.sin(B.ang), Math.cos(A.ang) + Math.cos(B.ang));
      if (Math.cos(B.ang - A.ang) < -0.99) bis = A.ang + Math.PI / 2;
      const rr = Math.max(A.r, B.r, A.hw, B.hw) + 1.6;
      for (const f of [1, 1.35, 0.8]) {
        const x = jn.x + Math.cos(bis) * rr * f, y = jn.y + Math.sin(bis) * rr * f;
        if (!inTile(x, y) || onRoad(x, y, 0.4) || inBuilding(x, y) || !free(x, y, 1.5)) continue; // corners sit at the junction box edge
        // sx carries the second street's direction relative to the first
        push(K.BLADE, x, y, a1, a2 - a1, nm(n1), nm(n2));
        claim(x, y);
        break;
      }
    }
  }

  // ---- highway guide signs at motorway / trunk ramps (gore sign facing traffic)
  if (off && rxyz && rcls && rfl) {
    for (let r = 0; r < off.length - 1; r++) {
      if (!(rfl[r] & 8) || rcls[r] > 1) continue;
      const k0 = off[r], k1 = off[r] + 1;
      if (k1 >= off[r + 1]) continue;
      const x = rxyz[k0 * 3], y = rxyz[k0 * 3 + 1];
      if (!inTile(x, y)) continue;
      const dir = Math.atan2(rxyz[k1 * 3 + 1] - y, rxyz[k1 * 3] - x);
      // 40 m back along the approach, on the right shoulder
      const bx = x - Math.cos(dir) * 40 + Math.sin(dir) * 9, by = y - Math.sin(dir) * 40 - Math.cos(dir) * 9;
      if (!inTile(bx, by) || onRoad(bx, by, 0.5) || !free(bx, by, 60)) continue;
      push(K.HWYSIGN, bx, by, dir + Math.PI, 1, (rnd(r) * 4) | 0);
      claim(bx, by);
    }
  }

  // ---- houses: driveways to the street, bins at the curb on some lots
  if (houses) {
    for (let i = 0; i < houses.count; i++) {
      const t = houses.type[i];
      if (t === 5) continue;
      const ca = Math.cos(houses.angle[i]), sa = Math.sin(houses.angle[i]);
      // local +x → (ca, sa); local +z (front) → (sa, -ca)
      const fx = sa, fy = -ca;
      const F = houses.len[i], D = houses.wid[i];
      const hx = houses.xy[i * 2], hy = houses.xy[i * 2 + 1];
      const f = faceRoad(hx + fx * D / 2, hy + fy * D / 2);
      if (!f.s || f.d > 25) continue;
      const setback = Math.max(0, f.d - 0.3);
      const garage = t === 4 || t === 7 || t === 8 ? 1 : 0;
      // driveway beside (old city: side drive on wide lots) or in front of the garage
      const ux = garage ? (t === 8 ? 0.28 : t === 7 ? 0.25 : 0.34) : (t === 3 || t === 6 ? -0.62 : 0);
      const hasDrive = garage || t === 3 || t === 6 || rnd(i, 31) >= 0.8; // narrow old-city lots: walkway only
      if (hasDrive && setback > 2) {
        const w = t === 8 ? 5.6 : 3.1;
        const cx = hx + ca * ux * F + fx * (D / 2 + setback / 2), cy = hy + sa * ux * F + fy * (D / 2 + setback / 2);
        if (inTile(cx, cy)) {
          const L2 = (setback + 0.4) / 2, W2 = w / 2;
          const conc = rnd(i, 32) < 0.35;
          gm.quad([[cx - ca * W2 - fx * L2, cy - sa * W2 - fy * L2], [cx + ca * W2 - fx * L2, cy + sa * W2 - fy * L2],
            [cx + ca * W2 + fx * L2, cy + sa * W2 + fy * L2], [cx - ca * W2 + fx * L2, cy - sa * W2 + fy * L2]], conc ? DRIVE_CONC : DRIVE_ASPH, 0.05);
        }
        // a parked car in some driveways
        if (setback > 6 && rnd(i, 33) < 0.7) {
          const px = hx + ca * ux * F + fx * (D / 2 + Math.min(setback - 3, 3.5)), py = hy + sa * ux * F + fy * (D / 2 + Math.min(setback - 3, 3.5));
          // home overnight, often away by day (rank vs. the home schedule, layers/parkingOcc.ts)
          if (inTile(px, py)) push(K.CAR, px, py, Math.atan2(fy, fx) + (rnd(i, 34) < 0.5 ? 0 : Math.PI), carTag(LOT.HOME, rnd(i, 39)), (rnd(i, 35) * 4) | 0, (rnd(i, 36) * 16) | 0);
        }
      }
      // collection-day bins (blue recycling, green organics, grey garbage) at the curb
      if (setback > 3 && rnd(i, 37) < 0.22) {
        const bx = hx + ca * (ux + 0.2) * F + fx * (D / 2 + setback - 0.6), by = hy + sa * (ux + 0.2) * F + fy * (D / 2 + setback - 0.6);
        if (ok(bx, by, 1, 0.2)) { push(K.HOUSEBIN, bx, by, Math.atan2(fy, fx), 1, (rnd(i, 38) * 3) | 0); claim(bx, by); }
      }
    }
  }

  // ---- parking lots from the ground raster (class 11): rows of stalls along the lot's principal axis
  parkingLots(a, ground, S, inBuilding, onRoad, push, gm, tx, ty);

  return { items: Float32Array.from(out), names: bladeNames, segs: Float32Array.from(segList), ground: gm.finish() };
}

type RGBA = [number, number, number];
const ASPHALT: RGBA = [74, 74, 76], ASPHALT_OLD: RGBA = [98, 97, 94], PAINT: RGBA = [226, 224, 214], PAINT_Y: RGBA = [222, 186, 60];
const ISLAND: RGBA = [96, 128, 70], CURB: RGBA = [170, 167, 160];
const DRIVE_ASPH: RGBA = [58, 58, 60], DRIVE_CONC: RGBA = [158, 155, 148];

/** flat, terrain-draped ground paint (tile-local E,N in; three coords out), vertex coloured, normals up */
class GroundMesh {
  pos: number[] = []; col: number[] = []; idx: number[] = [];
  terr: Terrain;
  constructor(terr: Terrain) { this.terr = terr; }
  v(x: number, y: number, c: RGBA, lift: number) {
    this.pos.push(x, this.terr.at(x, y) + lift, -y);
    this.col.push(c[0], c[1], c[2], 255);
    return this.pos.length / 3 - 1;
  }
  /** convex polygon (E,N points, any winding) as a fan */
  poly(p: number[][], c: RGBA, lift: number) {
    if (p.length < 3) return;
    let area = 0;
    for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; area += p[i][0] * q[1] - q[0] * p[i][1]; }
    const ids = p.map(([x, y]) => this.v(x, y, c, lift));
    for (let i = 1; i < ids.length - 1; i++) {
      // CCW in E,N = up-facing in three
      if (area > 0) this.idx.push(ids[0], ids[i], ids[i + 1]); else this.idx.push(ids[0], ids[i + 1], ids[i]);
    }
  }
  quad(p: number[][], c: RGBA, lift: number) { this.poly(p, c, lift); }
  /** oriented rectangle centred at (x, y), long axis along angle */
  rect(x: number, y: number, ang: number, L: number, W: number, c: RGBA, lift: number) {
    const ux = Math.cos(ang) * L / 2, uy = Math.sin(ang) * L / 2, vx = -Math.sin(ang) * W / 2, vy = Math.cos(ang) * W / 2;
    this.poly([[x - ux - vx, y - uy - vy], [x + ux - vx, y + uy - vy], [x + ux + vx, y + uy + vy], [x - ux + vx, y - uy + vy]], c, lift);
  }
  finish(): MeshBuf | null {
    if (!this.idx.length) return null;
    const n = this.pos.length / 3;
    const normal = new Int8Array(n * 4);
    for (let i = 0; i < n; i++) normal[i * 4 + 1] = 127;
    return {
      position: Float32Array.from(this.pos), normal, color: Uint8Array.from(this.col),
      index: n < 65536 ? Uint16Array.from(this.idx) : Uint32Array.from(this.idx),
    };
  }
}

/** parked-car occupancy tag (record `sx`): 2 + 2·lot type + rank, rank ∈ [0, 1). The props layer
 *  shows the car while rank < the type's occupancy at the sim time (layers/parkingOcc.ts). sx < 2
 *  (legacy records) = always shown. */
export const carTag = (type: number, rank: number) => 2 + 2 * type + Math.min(0.999, Math.max(0, rank));

interface LotInfo { id: number; area: number; cx: number; cy: number; ux: number; uy: number; u0: number; u1: number; v0: number; v1: number; type: number }

/** what a lot serves, from the nearest non-house building (SPEC b_kind) or the land use around it */
function lotType(a: Record<string, TypedArray>, ground: Uint8Array, S: number, cx: number, cy: number, area: number): number {
  const ro = a.b_ring_off as Uint32Array | undefined, vo = a.b_vert_off as Uint32Array | undefined, bxy = a.b_xy as Float32Array | undefined;
  const kind = a.b_kind as Uint8Array | undefined;
  let best = -1, bd = 90;
  if (ro && vo && bxy && kind) {
    for (let i = 0; i < ro.length - 1; i++) {
      const k = kind[i];
      if (k === 1 || k === 11 || k === 15) continue;
      const s0 = vo[ro[i]], s1 = vo[ro[i] + 1];
      for (let v = s0; v < s1; v++) {
        const d = Math.hypot(bxy[v * 2] - cx, bxy[v * 2 + 1] - cy);
        if (d < bd) { bd = d; best = k; }
      }
    }
  }
  switch (best) {
    case 4: case 12: return LOT.RETAIL;
    case 3: case 5: case 6: case 7: case 8: return LOT.WORK;
    case 2: return LOT.HOME;
    case 10: case 13: return LOT.H24;
    case 9: return area > 2500 ? LOT.COMMUTER : LOT.H24;
    case 14: return LOT.WORK;
  }
  const g = ground[Math.min(255, Math.max(0, Math.floor((cy / S) * 256))) * 256 + Math.min(255, Math.max(0, Math.floor((cx / S) * 256)))];
  return g === 4 ? LOT.HOME : g === 6 || g === 17 ? LOT.WORK : LOT.RETAIL;
}
/** lot types (layers/parkingOcc.ts schedules) */
export const LOT = { RETAIL: 0, WORK: 1, HOME: 2, H24: 3, COMMUTER: 4 } as const;

/** vector parking polygons (gp_class 11, docs/SPEC.md vector ground) → local E,N rings */
function vectorLots(a: Record<string, TypedArray>, S: number): Float32Array[] | null {
  const off = a.gp_off as Uint32Array | undefined, gxy = a.gp_xy as Uint16Array | undefined, cls = a.gp_class as Uint8Array | undefined;
  if (!off || !gxy || !cls || !cls.length) return null;
  const out: Float32Array[] = [];
  const k = S / 65535;
  for (let p = 0; p < cls.length; p++) {
    if (cls[p] !== 11) continue;
    const n = off[p + 1] - off[p];
    if (n < 3) continue;
    const r = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) r[i] = gxy[off[p] * 2 + i] * k;
    out.push(r);
  }
  return out;
}

/**
 * Parking lots: stalls striped on both sides of each aisle — mapped parking aisles (tile arrays
 * k_*, svc 1) when present, else 18 m modules (stall · 7 m aisle · stall) along the lot's long
 * axis — landscaped islands at row ends, light standards down the aisles and parked cars (every
 * stall a candidate, shown by time of day and what the lot serves). Lots come from the vector
 * ground (gp_class 11 polygons: exact outlines, the asphalt is already drawn by the ground) or,
 * without it, from the class-11 ground raster (paved here, marching-squares edges).
 */
function parkingLots(a: Record<string, TypedArray>, ground: Uint8Array, S: number, inBuilding: (x: number, y: number, m?: number) => boolean,
  onRoad: (x: number, y: number, m: number) => boolean,
  push: (k: number, x: number, y: number, ang: number, sx?: number, p0?: number, p1?: number, z?: number) => void, gm: GroundMesh, tx: number, ty: number) {
  const seed0 = tx * 7919 + ty * 104729;
  const lots: LotInfo[] = [];
  let inLot: (x: number, y: number) => boolean;
  let labelAt: (x: number, y: number) => number;
  const vpolys = vectorLots(a, S);
  if (vpolys) {
    // ---- vector lots: point-in-polygon on a 32 m grid of lot ids
    const grid = new Grid<number>(32);
    const polys: Poly[] = [];
    vpolys.forEach((r, id) => {
      const n = r.length / 2;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ar = 0, cx = 0, cy = 0;
      for (let i = 0; i < n; i++) {
        const x = r[i * 2], y = r[i * 2 + 1], j = (i + 1) % n;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        ar += x * r[j * 2 + 1] - r[j * 2] * y; cx += x; cy += y;
      }
      polys.push({ xy: r, a: 0, b: n });
      grid.add(x0, y0, x1, y1, id);
      const area = Math.abs(ar) / 2;
      const o = obb(r, 0, n);
      const vx = -o.uy, vy = o.ux;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const u = r[i * 2] * o.ux + r[i * 2 + 1] * o.uy, v = r[i * 2] * vx + r[i * 2 + 1] * vy;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      cx /= n; cy /= n;
      lots.push({ id, area, cx, cy, ux: o.ux, uy: o.uy, u0, u1, v0, v1, type: lotType(a, ground, S, cx, cy, area) });
    });
    labelAt = (x, y) => { const c = grid.at(x, y); if (c) for (const id of c) if (inPoly(polys[id], x, y)) return id; return -1; };
    inLot = (x, y) => labelAt(x, y) >= 0;
  } else {
    // ---- raster lots (class-11 pixels): components, pavement
    const R = 256, px = S / R;
    const isP = (i: number, j: number) => i >= 0 && j >= 0 && i < R && j < R && ground[j * R + i] === 11;
    const label = new Int32Array(R * R).fill(-1);
    const comps: number[][] = [];
    const stack: number[] = [];
    for (let s0 = 0; s0 < R * R; s0++) {
      if (label[s0] >= 0 || ground[s0] !== 11) continue;
      const id = comps.length, cells: number[] = [];
      stack.length = 0; stack.push(s0); label[s0] = id;
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        const i = c % R, j = (c / R) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (!isP(ii, jj)) continue;
          const k = jj * R + ii;
          if (label[k] < 0) { label[k] = id; stack.push(k); }
        }
      }
      comps.push(cells);
    }
    if (!comps.length) return;
    inLot = (x, y) => isP(Math.floor(x / px), Math.floor(y / px));
    labelAt = (x, y) => { const i = Math.floor(x / px), j = Math.floor(y / px); return i >= 0 && j >= 0 && i < R && j < R ? label[j * R + i] : -1; };
    const lotCol = (id: number): RGBA => (rnd(seed0, id, 1) < 0.35 ? ASPHALT_OLD : ASPHALT);
    const small = new Uint8Array(comps.length);
    comps.forEach((c, id) => { small[id] = c.length < 6 ? 1 : 0; });
    // pavement: marching squares over pixel centres (interior runs merged)
    const cx = (i: number) => (i + 0.5) * px;
    for (let j = -1; j < R; j++) {
      let run = -1, runId = -1;
      const flush = (iEnd: number) => {
        if (run < 0) return;
        gm.quad([[cx(run), cx(j)], [cx(iEnd), cx(j)], [cx(iEnd), cx(j + 1)], [cx(run), cx(j + 1)]], lotCol(runId), 0.035);
        run = -1;
      };
      for (let i = -1; i < R; i++) {
        const A = isP(i, j), B = isP(i + 1, j), C = isP(i + 1, j + 1), D = isP(i, j + 1);
        const id = A ? label[j * R + i] : B ? label[j * R + i + 1] : C ? label[(j + 1) * R + i + 1] : D ? label[(j + 1) * R + i] : -1;
        if (A && B && C && D) {
          if (run >= 0 && (id !== runId || i - run >= 8)) flush(i);
          if (run < 0) { run = i; runId = id; }
          continue;
        }
        flush(i);
        if (!(A || B || C || D) || small[id]) continue;
        const corners: [number, number, boolean][] = [[cx(i), cx(j), A], [cx(i + 1), cx(j), B], [cx(i + 1), cx(j + 1), C], [cx(i), cx(j + 1), D]];
        const poly: number[][] = [];
        for (let k = 0; k < 4; k++) {
          const p = corners[k], q = corners[(k + 1) % 4];
          if (p[2]) poly.push([p[0], p[1]]);
          if (p[2] !== q[2]) poly.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
        }
        gm.poly(poly, lotCol(id), 0.035);
      }
      flush(R - 1);
    }
    comps.forEach((cells, id) => {
      let mx = 0, my = 0;
      for (const c of cells) { mx += c % R; my += (c / R) | 0; }
      mx /= cells.length; my /= cells.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const c of cells) { const dx = c % R - mx, dy = ((c / R) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const c of cells) {
        const x = (c % R + 0.5) * px, y = (((c / R) | 0) + 0.5) * px;
        const u = x * ux + y * uy, v = x * vx + y * vy;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const area = cells.length * px * px, ccx = (mx + 0.5) * px, ccy = (my + 0.5) * px;
      lots.push({ id, area, cx: ccx, cy: ccy, ux, uy, u0, u1, v0, v1, type: lotType(a, ground, S, ccx, ccy, area) });
    });
  }
  if (!lots.length) return;

  // ---- stall rows (2.7 × 5.5 m stalls, Toronto zoning by-law 569-2013 minimum 2.6 × 5.6)
  const SW = 2.7, SL = 5.5, AISLE = 7;
  const lights: [number, number][] = [];
  const nearLight = (x: number, y: number) => lights.some(([lx, ly]) => Math.hypot(lx - x, ly - y) < 30);
  const stallOK = (x: number, y: number, ux: number, uy: number, vx: number, vy: number) => {
    for (const [du, dv] of [[0, 0], [0, 2.4], [0, -2.4], [1.2, 0], [-1.2, 0]]) {
      const qx = x + ux * du + vx * dv, qy = y + uy * du + vy * dv;
      if (!inLot(qx, qy) || inBuilding(qx, qy, 0.3) || onRoad(qx, qy, 0.2)) return false;
    }
    return true;
  };
  /** a row of stalls along direction (ux,uy) from `u0` to `u1` at offset `v` (stall centre) from the line through (ox,oy) */
  const row = (ox: number, oy: number, ux: number, uy: number, u0: number, u1: number, v: number, side: 1 | -1, lot: LotInfo, key: number) => {
    const vx = -uy * side, vy = ux * side;
    const ang = Math.atan2(uy, ux);
    let first = true, lastU = -1, cnt = 0;
    const stripe = (u: number) => gm.rect(ox + ux * u + vx * v, oy + uy * u + vy * v, ang + Math.PI / 2, SL, 0.12, PAINT, 0.07);
    // cars fill a lot from the stalls nearest the entrance / building first: rank grows along the row
    const bias = rnd(seed0, lot.id, 9) < 0.5 ? 1 : -1;
    for (let u = u0 + SW / 2; u <= u1 - SW / 2; u += SW) {
      const x = ox + ux * u + vx * v, y = oy + uy * u + vy * v;
      if (!stallOK(x, y, ux, uy, vx, vy)) {
        if (!first && cnt >= 4) gm.rect(ox + ux * (lastU + SW) + vx * v, oy + uy * (lastU + SW) + vy * v, ang, SW * 0.9, SL * 0.9, ISLAND, 0.06);
        first = true; cnt = 0;
        continue;
      }
      if (first) {
        stripe(u - SW / 2);
        if (rnd(seed0, key, u | 0) < 0.3 && inLot(x - ux * SW, y - uy * SW)) gm.rect(x - ux * SW, y - uy * SW, ang, SW * 0.9, SL * 0.9, ISLAND, 0.06);
      }
      first = false; lastU = u; cnt++;
      stripe(u + SW / 2);
      const k = key * 1000 + Math.round(u * 3);
      const along = (u - u0) / Math.max(1, u1 - u0);
      const rank = Math.min(0.999, rnd(seed0, k, 3) * 0.75 + (bias > 0 ? along : 1 - along) * 0.25);
      push(K.CAR, x, y, ang + (side === 1 ? Math.PI / 2 : -Math.PI / 2) + (rnd(seed0, k, 4) < 0.15 ? Math.PI : 0) + (rnd(seed0, k, 5) - 0.5) * 0.06,
        carTag(lot.type, rank), (rnd(seed0, k, 6) * 4) | 0, (rnd(seed0, k, 7) * 16) | 0);
    }
  };

  const kOff = a.k_off as Uint32Array | undefined, kXyz = a.k_xyz as Float32Array | undefined, kSvc = a.k_svc as Uint8Array | undefined;
  const aisleLots = new Set<number>();
  if (kOff && kXyz && kOff.length > 1) {
    // mapped aisles: stalls on both sides of every parking aisle segment inside a lot
    for (let r = 0; r < kOff.length - 1; r++) {
      if (kSvc && kSvc[r] !== 1) continue;
      for (let k = kOff[r]; k < kOff[r + 1] - 1; k++) {
        const x0 = kXyz[k * 3], y0 = kXyz[k * 3 + 1], x1 = kXyz[k * 3 + 3], y1 = kXyz[k * 3 + 4];
        const L = Math.hypot(x1 - x0, y1 - y0);
        if (L < SW * 3) continue;
        const lab = labelAt((x0 + x1) / 2, (y0 + y1) / 2);
        if (lab < 0) continue;
        aisleLots.add(lab);
        const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
        for (const side of [1, -1] as const) row(x0, y0, ux, uy, 2, L - 2, AISLE / 2 + SL / 2, side, lots[lab], r * 64 + (k - kOff[r]) * 2 + (side > 0 ? 0 : 1));
        for (let u = 12; u < L - 6; u += 36) {
          const lx = x0 + ux * u, ly = y0 + uy * u;
          if (!nearLight(lx, ly) && !inBuilding(lx, ly, 0.5)) { push(K.LOTLIGHT, lx - uy * 0, ly, Math.atan2(uy, ux)); lights.push([lx, ly]); }
        }
      }
    }
  }
  // unmapped lots: 18 m modules (stall · aisle · stall) along the long axis, centred across the lot
  for (const lot of lots) {
    if (lot.area < 600 || aisleLots.has(lot.id)) continue;
    const { ux, uy } = lot, vx = -uy, vy = ux;
    const MOD = SL * 2 + AISLE;
    const span = lot.v1 - lot.v0 - 2;
    if (span < SL + AISLE / 2) continue;
    const nMod = Math.max(1, Math.floor((span + 0.4) / (MOD + 0.4)));
    const vStart = lot.v0 + 1 + (span - (nMod * (MOD + 0.4) - 0.4)) / 2 + MOD / 2;
    for (let m = 0; m < nMod; m++) {
      const v = vStart + m * (MOD + 0.4);
      // aisle centreline: points (u, v) → E,N = u·(ux,uy) + v·(vx,vy)
      const ox = v * vx, oy = v * vy;
      for (const side of [1, -1] as const) row(ox, oy, ux, uy, lot.u0 + 1, lot.u1 - 1, AISLE / 2 + SL / 2, side, lot, lot.id * 4096 + m * 2 + (side > 0 ? 0 : 1));
      for (let u = lot.u0 + 10; u < lot.u1 - 5; u += 36) {
        const lx = ox + ux * u, ly = oy + uy * u;
        if (inLot(lx, ly) && !nearLight(lx, ly) && !inBuilding(lx, ly, 0.5)) { push(K.LOTLIGHT, lx, ly, Math.atan2(uy, ux)); lights.push([lx, ly]); }
      }
    }
  }
  void CURB; void PAINT_Y;
}
