// Street-level occlusion horizon: a 360° azimuth table of how high nearby
// buildings block the view, built on the CPU from the level-0 building
// footprints around the camera (workers/collide.ts). Far tiles whose whole
// content stays under it are not drawn (TileManager).
//
// Everything is conservative:
// - an occluder only covers the azimuth bins that lie entirely inside its
//   angular span (a connected footprint seen from outside covers its whole
//   span), at slopes (tan of elevation) from its lowest bottom edge to its
//   lowest top edge as seen from anywhere within `SLACK` m of the build eye;
// - only closed, flat-roofed prisms occlude (pitched roofs, stations,
//   stadiums, parking decks, construction and landmark replacements don't),
//   houses up to half their ridge height (below the eaves);
// - two floors: bins remember the highest top among occluders reaching down
//   to FLOOR_A and FLOOR_B, and a tile is tested against the floor below its
//   own lowest point;
// - occluders are nearer than R_OCC, tested tiles farther.
// The table is valid while the eye stays within SLACK of where it was built.
import type { FootprintBuf } from '../workers/collide';
import { OCC_HOUSE, OCC_SOLID } from '../workers/collide';

const BINS = 1440;
const BIN = (2 * Math.PI) / BINS;
/** occluders nearer than this (m); tested boxes must be at least this far */
export const R_OCC = 700;
/** eye movement the table stays valid for (m) */
const SLACK = 2;
/** slope floors (tan elevation below the eye) */
const FLOOR_A = -0.012, FLOOR_B = -0.04;

export class Horizon {
  /** per bin: highest occluded slope reaching down to FLOOR_A / FLOOR_B (−∞ = open) */
  private topA = new Float32Array(BINS);
  private topB = new Float32Array(BINS);
  valid = false;
  e = 0; n = 0; h = 0;
  /** footprints used by the last build (diagnostics) */
  used = 0;
  private az: number[] = [];

  /** does the table still hold for an eye at (e, n, h)? */
  holds(e: number, n: number, h: number): boolean {
    return this.valid && Math.hypot(e - this.e, n - this.n, h - this.h) < SLACK;
  }

  begin(e: number, n: number, h: number) {
    this.e = e; this.n = n; this.h = h;
    this.topA.fill(-Infinity);
    this.topB.fill(-Infinity);
    this.valid = true;
    this.used = 0;
  }

  /** add a tile's footprints (tile origin e0, n0) */
  add(fp: FootprintBuf, e0: number, n0: number, houses: boolean) {
    const occ = fp.occ;
    if (!occ) return;
    const E = this.e - e0, N = this.n - n0, eye = this.h;
    const az = this.az;
    for (let i = 0; i < fp.count; i++) {
      const kind = occ[i];
      if (kind !== OCC_SOLID && !(houses && kind === OCC_HOUSE)) continue;
      const a = fp.off[i], b = fp.off[i + 1];
      if (b - a < 3) continue;
      // quick reject by the first vertex (footprints are small)
      const fx = fp.xy[2 * a] - E, fy = fp.xy[2 * a + 1] - N;
      if (fx * fx + fy * fy > (R_OCC - 150) * (R_OCC - 150)) continue;
      let dmax = 0, dmin = Infinity;
      az.length = 0;
      const ref = Math.atan2(fy, fx);
      let lo = 0, hi = 0;
      for (let v = a; v < b; v++) {
        const x = fp.xy[2 * v] - E, y = fp.xy[2 * v + 1] - N;
        const d = Math.hypot(x, y);
        if (d > dmax) dmax = d;
        let t = Math.atan2(y, x) - ref;
        if (t > Math.PI) t -= 2 * Math.PI; else if (t < -Math.PI) t += 2 * Math.PI;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
        // nearest point of the edge v → v+1
        const w = v + 1 < b ? v + 1 : a;
        const x2 = fp.xy[2 * w] - E, y2 = fp.xy[2 * w + 1] - N;
        const ex = x2 - x, ey = y2 - y, l2 = ex * ex + ey * ey;
        const s = l2 > 0 ? Math.min(1, Math.max(0, -(x * ex + y * ey) / l2)) : 0;
        const dd = Math.hypot(x + ex * s, y + ey * s);
        if (dd < dmin) dmin = dd;
      }
      // eye inside / against it, or a footprint wrapping around the eye: skip
      if (dmin < SLACK + 1 || hi - lo > Math.PI * 0.8 || dmax >= R_OCC) continue;
      // parallax of an eye up to SLACK away shrinks the span
      const shrink = Math.asin(Math.min(1, SLACK / dmin)) + 1e-4;
      lo += shrink; hi -= shrink;
      if (hi - lo < BIN) continue;
      const bottom = fp.bottom[i];
      let top = fp.top[i];
      if (kind === OCC_HOUSE) top = bottom + 3 + 0.5 * Math.max(0, top - bottom - 3);
      // slopes seen from any eye within SLACK (distance ±SLACK, height ±SLACK)
      const tNum = top - (eye + SLACK);
      const sTop = tNum >= 0 ? tNum / (dmax + SLACK) : tNum / Math.max(0.5, dmin - SLACK);
      const bNum = bottom - (eye - SLACK);
      const sBot = bNum <= 0 ? bNum / (dmax + SLACK) : bNum / Math.max(0.5, dmin - SLACK);
      if (sBot > FLOOR_A || sTop <= FLOOR_A) continue;
      // bins entirely inside [ref + lo, ref + hi]
      const b0 = Math.ceil((ref + lo) / BIN), b1 = Math.floor((ref + hi) / BIN) - 1;
      const toB = sBot <= FLOOR_B;
      for (let k = b0; k <= b1; k++) {
        const q = ((k % BINS) + BINS) % BINS;
        if (sTop > this.topA[q]) this.topA[q] = sTop;
        if (toB && sTop > this.topB[q]) this.topB[q] = sTop;
      }
      this.used++;
    }
  }

  /**
   * Is everything inside the box (E/N extent, elevations z0 … z1) hidden from
   * an eye at (e, n, h) within SLACK of the build eye? False when unsure.
   */
  hides(e: number, n: number, h: number, e0: number, n0: number, e1: number, n1: number, z0: number, z1: number): boolean {
    if (!this.valid) return false;
    const dx = Math.max(0, e0 - e, e - e1), dy = Math.max(0, n0 - n, n - n1);
    const dmin = Math.hypot(dx, dy);
    if (dmin < R_OCC) return false;
    // lowest / highest slope of the box from the eye
    const zl = z0 - h, zh = z1 - h;
    const dmaxBox = Math.hypot(Math.max(Math.abs(e0 - e), Math.abs(e1 - e)), Math.max(Math.abs(n0 - n), Math.abs(n1 - n)));
    const sLow = zl >= 0 ? zl / dmaxBox : zl / dmin;
    const sHigh = zh >= 0 ? zh / dmin : zh / dmaxBox;
    const tab = sLow >= FLOOR_A ? this.topA : sLow >= FLOOR_B ? this.topB : null;
    if (!tab) return false;
    // azimuth span of the box corners (the eye is outside it)
    const cx = (e0 + e1) / 2 - e, cy = (n0 + n1) / 2 - n;
    const ref = Math.atan2(cy, cx);
    let lo = 0, hi = 0;
    for (let c = 0; c < 4; c++) {
      const x = (c & 1 ? e1 : e0) - e, y = (c & 2 ? n1 : n0) - n;
      let t = Math.atan2(y, x) - ref;
      if (t > Math.PI) t -= 2 * Math.PI; else if (t < -Math.PI) t += 2 * Math.PI;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    // the table was built from an eye up to SLACK away
    const pad = Math.asin(Math.min(1, (SLACK + Math.hypot(e - this.e, n - this.n)) / dmin));
    const b0 = Math.floor((ref + lo - pad) / BIN), b1 = Math.floor((ref + hi + pad) / BIN);
    if (b1 - b0 >= BINS) return false;
    for (let k = b0; k <= b1; k++) {
      if (tab[((k % BINS) + BINS) % BINS] < sHigh) return false;
    }
    return true;
  }
}
