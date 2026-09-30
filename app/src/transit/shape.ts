// Public sampling API for a pattern's shape polyline (absolute world E/N/z).
// Obtain one with TransitSystem.patternShape(pattern); it is cached and shared,
// so treat `xyz` / `dist` as read-only. Distances are horizontal metres along
// the shape (the same `dist` that TransitSystem.evaluate() reports).

export interface ShapePose {
  e: number;
  n: number;
  z: number;
  /** rad CCW from +E */
  heading: number;
  /** rad, positive = climbing */
  pitch: number;
}

export class PatternShape {
  readonly pattern: number;
  /** vertices (E, N, z) — a view into the decoded feed, do not mutate */
  readonly xyz: Float32Array;
  /** cumulative horizontal distance per vertex (starts at 0) */
  readonly dist: Float32Array;
  readonly length: number;
  readonly count: number;
  private hint = 0;

  constructor(pattern: number, xyz: Float32Array, dist: Float32Array) {
    this.pattern = pattern;
    this.xyz = xyz;
    this.dist = dist;
    this.count = dist.length;
    this.length = this.count ? dist[this.count - 1] : 0;
  }

  /** index of the segment [i, i+1] containing s (clamped) */
  segment(s: number): number {
    const D = this.dist;
    const n = this.count;
    let a = this.hint;
    if (a >= n - 1 || D[a] > s || D[a + 1] < s) {
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (D[m] <= s) lo = m; else hi = m - 1;
      }
      a = lo;
    }
    if (a >= n - 1) a = n - 2;
    if (a < 0) a = 0;
    this.hint = a;
    return a;
  }

  /**
   * Point at distance s → out [e, n, z]. Beyond either end the path continues
   * straight along the end segment (a train's cab can sit past the last vertex).
   */
  point(s: number, out: number[] | Float64Array = [0, 0, 0]): number[] | Float64Array {
    const P = this.xyz, D = this.dist;
    if (this.count < 2) {
      out[0] = P[0] ?? 0; out[1] = P[1] ?? 0; out[2] = P[2] ?? 0;
      return out;
    }
    const a = this.segment(s);
    const L = D[a + 1] - D[a];
    let t = L > 1e-6 ? (s - D[a]) / L : 0;
    if (a > 0 && t < 0) t = 0;
    if (a < this.count - 2 && t > 1) t = 1;
    const i = 3 * a;
    out[0] = P[i] + (P[i + 3] - P[i]) * t;
    out[1] = P[i + 1] + (P[i + 4] - P[i + 1]) * t;
    out[2] = P[i + 2] + (P[i + 5] - P[i + 2]) * t;
    return out;
  }

  /** Unit direction (horizontal) of the shape at s → out [dx, dy]. */
  direction(s: number, out: number[] | Float64Array = [0, 0]): number[] | Float64Array {
    const P = this.xyz;
    const a = this.segment(s);
    const i = 3 * a;
    const dx = P[i + 3] - P[i], dy = P[i + 4] - P[i + 1];
    const l = Math.hypot(dx, dy) || 1;
    out[0] = dx / l; out[1] = dy / l;
    return out;
  }

  /** Position at s with heading/pitch from the chord between s - half and s + half. */
  pose(s: number, half = 6, out: ShapePose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 }): ShapePose {
    const b = this.point(s - half, _b);
    const bx = b[0], by = b[1], bz = b[2];
    const c = this.point(s + half, _c);
    const dx = c[0] - bx, dy = c[1] - by, dz = c[2] - bz;
    const hd = Math.hypot(dx, dy);
    if (hd > 1e-3) {
      out.heading = Math.atan2(dy, dx);
      out.pitch = Math.atan2(dz, hd);
    }
    const p = this.point(s, _a);
    out.e = p[0]; out.n = p[1]; out.z = p[2];
    return out;
  }

  /** Copy of the geometry as f64 (e.g. for a path that is edited or offset). */
  toFloat64(): Float64Array {
    return Float64Array.from(this.xyz);
  }
}

const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0];
