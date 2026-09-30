// House instances (tile worker): turn each footprint's oriented box into a
// Toronto house archetype facing its street. Local +z of the archetype is the
// front (door, porch, garage), local x the frontage along the street.
//
// Archetypes (render/tiles/houses.ts HOUSE_TYPES):
//   0 bay-and-gable (old city, narrow, front gable + bay window + porch)
//   1 semi-detached pair · 2 row / townhouses · 3 postwar bungalow
//   4 suburban 2-storey with attached garage · 5 garage / shed
//   6 Annex house (large 2½-storey, verandah) · 7 split-level · 8 large suburban (double garage)
import type { TypedArray } from '../data/tbn';
import { district, frontage, roadGrid } from './buildings';
import type { HouseBuf } from './meshing';
import { SegIndex, alleyFront, alleySegs } from './urban';

export const H_BAYGABLE = 0, H_SEMI = 1, H_ROW = 2, H_BUNGALOW = 3, H_SUBURBAN = 4, H_SHED = 5, H_ANNEX = 6, H_SPLIT = 7, H_LARGE = 8;

function rnd(a: number, b = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Built-up era of a place: old city (pre-war), inner suburb (City of Toronto, postwar), outer (905 subdivisions) */
export function era(e: number, n: number, r: number): 0 | 1 | 2 {
  const d = district(e, n);
  if (r < d.old) return 0;
  return e > -21000 && e < 25000 && n > -3000 && n < 16800 ? 1 : 2;
}

export function orientHouses(hb: HouseBuf, a: Record<string, TypedArray>, originE: number, originN: number, osm?: Float64Array, names?: string[]) {
  const g = roadGrid(a);
  let lanes: SegIndex | undefined;
  for (let i = 0; i < hb.count; i++) {
    const cx = hb.xy[i * 2], cy = hb.xy[i * 2 + 1];
    const th = hb.angle[i];
    const L = hb.len[i], W = hb.wid[i];
    const seed = osm ? Math.abs(osm[i]) % 2147483647 : i * 7919 + hb.variant[i];
    const t0 = hb.type[i];
    if (t0 === 5) {
      hb.type[i] = H_SHED;
      // laneway garages: turn the garage door (archetype +z) to the lane it sits on
      if (lanes === undefined) lanes = new SegIndex(alleySegs(a, originE, originN, names), 8);
      const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
      let best = Infinity;
      for (const [nx, ny, he, F, D] of [[ux, uy, L / 2, W, L], [-ux, -uy, L / 2, W, L], [vx, vy, W / 2, L, W], [-vx, -vy, W / 2, L, W]]) {
        const d = alleyFront(lanes, cx + nx * he, cy + ny * he, nx, ny, 4);
        if (d !== null && d < best) { best = d; hb.angle[i] = Math.atan2(ny, nx) + Math.PI / 2; hb.len[i] = F; hb.wid[i] = D; }
      }
      continue;
    }
    // front side: the box side facing the nearest parallel street
    const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
    let bestD = Infinity, bestK = 2;
    if (g) {
      const sides: [number, number, number, number][] = [[ux, uy, L / 2, W], [-ux, -uy, L / 2, W], [vx, vy, W / 2, L], [-vx, -vy, W / 2, L]];
      for (let k = 0; k < 4; k++) {
        const [nx, ny, he, sl] = sides[k];
        const f = frontage(g, cx + nx * he, cy + ny * he, nx, ny, -ny, nx, sl / 2, 45);
        if (f && f.d < bestD - 0.5) { bestD = f.d; bestK = k; }
      }
    }
    let nx: number, ny: number, F: number, D: number;
    if (bestK === 0) { nx = ux; ny = uy; F = W; D = L; }
    else if (bestK === 1) { nx = -ux; ny = -uy; F = W; D = L; }
    else if (bestK === 2) { nx = vx; ny = vy; F = L; D = W; }
    else { nx = -vx; ny = -vy; F = L; D = W; }
    hb.angle[i] = Math.atan2(ny, nx) + Math.PI / 2;
    hb.len[i] = F; hb.wid[i] = D;
    const r = rnd(seed, 1), r2 = rnd(seed, 2);
    const ew = era(originE + cx, originN + cy, rnd(seed, 3));
    let t: number;
    if (t0 === 3) t = H_ROW;
    else if (t0 === 2) t = H_SEMI;
    else if (t0 === 1) t = ew === 0 ? H_ANNEX : ew === 1 ? (r < 0.5 ? H_SUBURBAN : H_LARGE) : H_LARGE;
    else if (t0 === 4) {
      if (ew === 0) t = F < 7.5 ? H_BAYGABLE : r < 0.6 ? H_BUNGALOW : H_BAYGABLE;
      else if (ew === 1) t = r < 0.85 ? H_BUNGALOW : H_SPLIT;
      else t = r < 0.5 ? H_SUBURBAN : H_BUNGALOW;
    } else {
      if (ew === 0) t = F < 8.5 ? H_BAYGABLE : r < 0.5 ? H_ANNEX : H_BAYGABLE;
      else if (ew === 1) t = r < 0.45 ? H_BUNGALOW : r < 0.75 ? H_SPLIT : H_SUBURBAN;
      else t = r < 0.72 ? H_SUBURBAN : r < 0.88 ? H_LARGE : H_SPLIT;
    }
    // footprints too small / too wide for the archetype fall back
    if ((t === H_SUBURBAN || t === H_LARGE) && F < 8) t = ew === 2 ? H_ROW : H_BUNGALOW;
    if (t === H_ROW && F < 9) t = H_BAYGABLE;
    if (t === H_SEMI && F < 7) t = H_BAYGABLE;
    hb.type[i] = t;
    // storey heights (ridge above base) per archetype, keeping tagged heights within reason
    const h = hb.height[i];
    const clampH = (lo: number, hi: number) => { hb.height[i] = Math.min(hi, Math.max(lo, h)); };
    switch (t) {
      case H_BAYGABLE: clampH(9.5 + r2 * 1.5, 12.5); break;
      case H_ANNEX: clampH(11, 14); break;
      case H_SEMI: clampH(9, 12); break;
      case H_ROW: clampH(7.5, 12); break;
      case H_BUNGALOW: clampH(5.2, 6.6); break;
      case H_SUBURBAN: clampH(8.2, 10); break;
      case H_LARGE: clampH(9, 11); break;
      case H_SPLIT: clampH(6.8, 8.2); break;
    }
    // cap the roof: ≤ ~50° over the half span and ≤ 5 m above the eaves; if that would squash the
    // walls below two storeys, a narrow front-gable becomes a low side-gabled row house instead
    {
      const e = EAVE_FRAC[t], cap = maxRise(t, F, D), H = hb.height[i];
      if (H * (1 - e) > cap) {
        const H1 = cap / (1 - e), minEave = t === H_BUNGALOW || t === H_SPLIT ? 2.8 : 5.2;
        if (e * H1 >= minEave) hb.height[i] = H1;
        else if (t === H_BAYGABLE || t === H_ANNEX) { hb.type[i] = H_ROW; hb.height[i] = Math.min(H, maxRise(H_ROW, F, D) / (1 - EAVE_FRAC[H_ROW]), 12); }
        else hb.height[i] = Math.max(H1, minEave / e);
      }
    }
    hb.variant[i] = (hb.variant[i] & 0xfc) | (Math.floor(r2 * 4) & 3);
  }
}

// ---------------------------------------------------------------------------- roof sanity (QA)

/** eave height as a fraction of the ridge height per archetype (render/tiles/houses.ts walls(g, eave)) */
export const EAVE_FRAC = [0.64, 0.64, 0.84, 0.56, 0.8, 0.9, 0.6, 0.55, 0.78];
/** the horizontal run a roof rises over: front gable spans the frontage, side gables the depth, hips the short side */
export function roofSpan(t: number, F: number, D: number): number {
  return t === H_BAYGABLE ? F : t === H_SEMI || t === H_ROW ? D : Math.min(F, D);
}
/** max ridge rise above the eaves: ~50° pitch over the half span, and never more than 5 m */
export function maxRise(t: number, F: number, D: number): number {
  return Math.min(5, 0.6 * roofSpan(t, F, D));
}

export interface HouseQa { roofSpike: number; tallHouse: number; overlapBuilding: number; examples: [number, number, string][] }

/**
 * Per-tile house roof checks: roofs rising more than `maxRise` (spikes), ridges
 * above 14 m (taller than any Toronto house type), and house boxes that run
 * into an extruded building's footprint (poking through a neighbour's wall).
 */
export function houseRoofQa(hb: HouseBuf, a: Record<string, TypedArray>, originE: number, originN: number): HouseQa {
  const q: HouseQa = { roofSpike: 0, tallHouse: 0, overlapBuilding: 0, examples: [] };
  const ro = a.b_ring_off as Uint32Array | undefined, vo = a.b_vert_off as Uint32Array | undefined, bxy = a.b_xy as Float32Array | undefined;
  const cells = new Map<number, number[]>();
  const key = (x: number, y: number) => Math.floor(x / 32) * 4099 + Math.floor(y / 32);
  if (ro && vo && bxy) for (let i = 0; i < ro.length - 1; i++) {
    if (ro[i + 1] <= ro[i]) continue;
    const s = vo[ro[i]], e = vo[ro[i] + 1];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = s; k < e; k++) { x0 = Math.min(x0, bxy[k * 2]); x1 = Math.max(x1, bxy[k * 2]); y0 = Math.min(y0, bxy[k * 2 + 1]); y1 = Math.max(y1, bxy[k * 2 + 1]); }
    for (let gx = Math.floor(x0 / 32); gx <= Math.floor(x1 / 32); gx++) for (let gy = Math.floor(y0 / 32); gy <= Math.floor(y1 / 32); gy++) {
      const k = gx * 4099 + gy; const c = cells.get(k); if (c) c.push(i); else cells.set(k, [i]);
    }
  }
  const inBld = (x: number, y: number) => {
    const c = cells.get(key(x, y));
    if (!c || !ro || !vo || !bxy) return false;
    for (const i of c) {
      const s = vo[ro[i]], e = vo[ro[i] + 1];
      let inside = false;
      for (let p = s, r = e - 1; p < e; r = p++) {
        const xi = bxy[p * 2], yi = bxy[p * 2 + 1], xj = bxy[r * 2], yj = bxy[r * 2 + 1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
  const ex = (i: number, what: string) => { if (q.examples.length < 20) q.examples.push([Math.round(originE + hb.xy[i * 2]), Math.round(originN + hb.xy[i * 2 + 1]), what]); };
  for (let i = 0; i < hb.count; i++) {
    const t = hb.type[i], H = hb.height[i], F = hb.len[i], D = hb.wid[i];
    if (t === H_SHED) continue;
    const rise = H * (1 - (EAVE_FRAC[t] ?? 0.6));
    if (rise > maxRise(t, F, D) + 0.05) { q.roofSpike++; ex(i, 'roofSpike'); }
    if (H > 14) { q.tallHouse++; ex(i, 'tallHouse'); }
    // local +x along angle (frontage F), +z depth D; sample points 0.6 m inside the box corners
    const ca = Math.cos(hb.angle[i]), sa = Math.sin(hb.angle[i]);
    const cx = hb.xy[i * 2], cy = hb.xy[i * 2 + 1];
    let hit = false;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
      const lu = u * (F / 2 - 0.6), lv = v * (D / 2 - 0.6);
      if (inBld(cx + ca * lu + sa * lv, cy + sa * lu - ca * lv)) { hit = true; break; }
    }
    if (hit) { q.overlapBuilding++; ex(i, 'overlapBuilding'); }
  }
  return q;
}
