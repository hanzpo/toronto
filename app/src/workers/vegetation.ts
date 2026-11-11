// Level-1 canopy (tile worker): tree clumps on the 16 m land-cover raster for the far field, kept
// off the roads and rail of the network model (far tile arrays, net/bake.ts). Deterministic: every
// choice is hashed from tile + pixel, so a tile always grows the same clumps.
import type { TypedArray } from '../data/tbn';
import type { Terrain } from './farNet';
import { S, SPECIES } from '../layers/vegetation/species';

function rnd(a: number, b = 0, c = 0): number {
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
const STREET_PIT: Mix = [[S.LOCUST, 42], [S.LINDEN, 22], [S.PLANE, 12], [S.COLUMNAR, 10], [S.NORWAY, 5], [S.ORNAMENTAL, 9]];
const YARD: Mix = [[S.NORWAY, 18], [S.SILVER, 9], [S.SUGAR, 7], [S.SPRUCE, 7], [S.BLUE_SPRUCE, 8], [S.CEDAR, 10], [S.ORNAMENTAL, 12], [S.LINDEN, 4], [S.OAK, 4], [S.LOCUST, 5], [S.PINE, 5], [S.COLUMNAR, 5], [S.BEECH, 2]];
const PARK: Mix = [[S.NORWAY, 12], [S.SUGAR, 12], [S.SILVER, 8], [S.OAK, 12], [S.PLANE, 6], [S.LOCUST, 7], [S.LINDEN, 7], [S.SPRUCE, 7], [S.PINE, 9], [S.BEECH, 5], [S.ORNAMENTAL, 5], [S.COLUMNAR, 2], [S.CEDAR, 3]];
const FOREST: Mix = [[S.SUGAR, 22], [S.NORWAY, 7], [S.OAK, 15], [S.BEECH, 12], [S.HEMLOCK, 11], [S.PINE, 8], [S.LINDEN, 6], [S.SPRUCE, 4], [S.CEDAR, 5], [S.SILVER, 5]];
const WET: Mix = [[S.WILLOW, 30], [S.CEDAR, 25], [S.SILVER, 30], [S.SPRUCE, 5], [S.OAK, 10]];
const CEMETERY: Mix = [[S.NORWAY, 14], [S.SUGAR, 10], [S.OAK, 10], [S.SPRUCE, 12], [S.BLUE_SPRUCE, 6], [S.PINE, 10], [S.CEDAR, 8], [S.PLANE, 5], [S.LINDEN, 6], [S.BEECH, 6], [S.COLUMNAR, 5], [S.ORNAMENTAL, 8]];

const ROAD_W_MIN = [10, 10, 7, 6, 6, 5, 3.5, 3, 2.2];

/** where a crown may not stand: carriageways (half width + crown + clear zone), rail beds; tunnels excluded */
class Exclusion {
  private cells = new Map<number, number[]>();
  private it: number[] = [];
  private size = 16;
  private k(i: number, j: number) { return (i + 1024) * 8192 + (j + 1024); }
  seg(x0: number, y0: number, x1: number, y1: number, hw: number, pad: number) {
    const id = this.it.length / 6;
    this.it.push(x0, y0, x1, y1, hw, pad);
    const m = hw + pad + 12, s = this.size;
    for (let j = Math.floor((Math.min(y0, y1) - m) / s); j <= Math.floor((Math.max(y0, y1) + m) / s); j++) {
      for (let i = Math.floor((Math.min(x0, x1) - m) / s); i <= Math.floor((Math.max(x0, x1) + m) / s); i++) {
        const key = this.k(i, j);
        let c = this.cells.get(key);
        if (!c) { c = []; this.cells.set(key, c); }
        c.push(id);
      }
    }
  }
  blocked(x: number, y: number, r: number): boolean {
    const ids = this.cells.get(this.k(Math.floor(x / this.size), Math.floor(y / this.size)));
    if (!ids) return false;
    const it = this.it;
    for (const id of ids) {
      const q = id * 6;
      const x0 = it[q], y0 = it[q + 1], dx = it[q + 2] - x0, dy = it[q + 3] - y0;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
      if (Math.hypot(x - x0 - dx * u, y - y0 - dy * u) < it[q + 4] + r + it[q + 5]) return true;
    }
    return false;
  }
}

function exclusion(a: Record<string, TypedArray>, widen: number, maxClass: number): Exclusion {
  const ex = new Exclusion();
  for (const p of ['r', 'l'] as const) {
    const off = a[`${p}_off`] as Uint32Array | undefined, xyz = a[`${p}_xyz`] as Float32Array | undefined, vf = a[`${p}_vf`] as Uint8Array | undefined;
    if (!off || !xyz) continue;
    const cls = a[`${p}_class`] as Uint8Array, wid = a.r_width as Float32Array | undefined;
    for (let i = 0; i < off.length - 1; i++) {
      const c = cls[i];
      if (p === 'r' && c > maxClass) continue;
      const hw = p === 'r' ? (Math.max(wid?.[i] ?? 0, ROAD_W_MIN[c] ?? 3) * widen) / 2 : 3.2;
      const pad = p === 'r' && c <= 1 ? 2.5 : 0;
      for (let k = off[i]; k < off[i + 1] - 1; k++) {
        if (vf && vf[k] & vf[k + 1] & 2) continue;
        ex.seg(xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 3], xyz[k * 3 + 4], hw, pad);
      }
    }
  }
  return ex;
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
  const ex = exclusion(a, 1.6, 3);
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
        let bad = ex.blocked(x, y, rr);
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
