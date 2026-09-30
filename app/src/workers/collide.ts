// Compact building footprints for main-thread queries (camera collision,
// label occlusion): outer rings only, tile-local x/y, plus the absolute
// bottom/top elevation (datum m). Level-0 tiles only. Houses (instanced
// archetypes) are added as their oriented rectangles.
import type { TypedArray } from '../data/tbn';

export interface FootprintBuf {
  count: number;
  /** ring i owns vertices [off[i], off[i+1]) of xy */
  off: Uint32Array;
  xy: Float32Array;
  /** per footprint: bottom and top elevation (datum m) */
  bottom: Float32Array;
  top: Float32Array;
  /**
   * per footprint, for view occlusion (engine/horizon.ts): OCC_SOLID = drawn as
   * a closed flat-roofed prism from bottom to top; OCC_HOUSE = house archetype
   * (walls reach at least half the ridge height); 0 = don't occlude with it
   * (pitched / domed roofs, stations, stadiums, parking decks, construction,
   * landmark replacements)
   */
  occ?: Uint8Array;
}

export const OCC_SOLID = 1, OCC_HOUSE = 2;
/** building kinds that may be open or see-through (b_kind): station sheds, stadiums, parking decks, canopies, construction */
const OPEN_KINDS = new Set([9, 12, 14, 15, 16]);

/** buildings lower than this are ignored (sheds, canopies you can see under) */
const MIN_HEIGHT = 3;

export function extractFootprints(a: Record<string, TypedArray>, suppress: Set<number>): FootprintBuf | null {
  const off: number[] = [0];
  const xy: number[] = [];
  const bottom: number[] = [];
  const top: number[] = [];
  const occ: number[] = [];
  const ringOff = a.b_ring_off as Uint32Array | undefined;
  if (ringOff && ringOff.length > 1) {
    const vertOff = a.b_vert_off as Uint32Array, bxy = a.b_xy as Float32Array;
    const H = a.b_height as Float32Array, MIN = a.b_min as Float32Array | undefined, BASE = a.b_base as Float32Array;
    const KIND = a.b_kind as Uint8Array | undefined;
    const OSM = a.b_osm as Float64Array | undefined;
    const nB = ringOff.length - 1;
    for (let i = 0; i < nB; i++) {
      // buildings replaced by landmark models stay in: the landmark occupies
      // the same volume (Royal York, the towers …) — except station outlines
      // (Union's covers the open train shed and platforms)
      const r0 = ringOff[i];
      if (ringOff[i + 1] <= r0) continue;
      if (KIND && KIND[i] === 9 && suppress.size && OSM && suppress.has(OSM[i]) && ringArea(bxy, vertOff[r0], vertOff[r0 + 1]) > 20000) continue;
      const h = H[i];
      if (!(h >= MIN_HEIGHT)) continue;
      // roof/canopy-only structures (kind 15) are open underneath
      if (KIND && KIND[i] === 15) continue;
      const va = vertOff[r0], vb = vertOff[r0 + 1];
      if (vb - va < 3) continue;
      for (let v = va; v < vb; v++) xy.push(bxy[2 * v], bxy[2 * v + 1]);
      off.push(xy.length / 2);
      const minH = MIN ? Math.min(MIN[i], h - 0.5) : 0;
      bottom.push(minH > 2 ? BASE[i] + minH : BASE[i] - 3);
      top.push(BASE[i] + h);
      const ROOF = a.b_roof as Uint8Array | undefined;
      occ.push(ROOF && ROOF[i] === 0 && !(KIND && OPEN_KINDS.has(KIND[i])) && !(suppress.size && OSM && suppress.has(OSM[i])) ? OCC_SOLID : 0);
    }
  }
  const hxy = a.h_xy as Float32Array | undefined;
  if (hxy && hxy.length >= 2) {
    const n = hxy.length / 2;
    const ang = a.h_angle as Float32Array, len = a.h_len as Float32Array, wid = a.h_wid as Float32Array;
    const hh = a.h_height as Float32Array, base = a.h_base as Float32Array;
    const osm = a.h_osm as Float64Array | undefined;
    for (let i = 0; i < n; i++) {
      if (suppress.size && osm && suppress.has(osm[i])) continue;
      const c = Math.cos(ang[i]), s = Math.sin(ang[i]);
      const hl = (len ? len[i] : 10) / 2, hw = (wid ? wid[i] : 8) / 2;
      const cx = hxy[2 * i], cy = hxy[2 * i + 1];
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) xy.push(cx + c * u * hl - s * v * hw, cy + s * u * hl + c * v * hw);
      off.push(xy.length / 2);
      bottom.push(base[i] - 3);
      top.push(base[i] + (hh ? hh[i] : 8));
      occ.push(OCC_HOUSE);
    }
  }
  if (off.length < 2) return null;
  return {
    count: off.length - 1,
    off: Uint32Array.from(off),
    xy: Float32Array.from(xy),
    bottom: Float32Array.from(bottom),
    top: Float32Array.from(top),
    occ: Uint8Array.from(occ),
  };
}

function ringArea(xy: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let v = a, w = b - 1; v < b; w = v++) s += xy[2 * w] * xy[2 * v + 1] - xy[2 * v] * xy[2 * w + 1];
  return Math.abs(s) / 2;
}
