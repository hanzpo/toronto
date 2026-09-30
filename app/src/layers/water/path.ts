// Polyline helpers for boat paths (world E, N metres).

export class Path {
  readonly pts: Float64Array; // e, n pairs
  readonly cum: Float64Array; // cumulative length at each vertex
  readonly length: number;
  readonly closed: boolean;

  constructor(pts: [number, number][], closed = false) {
    const p = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
    this.closed = closed;
    this.pts = new Float64Array(p.length * 2);
    this.cum = new Float64Array(p.length);
    let L = 0;
    for (let i = 0; i < p.length; i++) {
      this.pts[i * 2] = p[i][0];
      this.pts[i * 2 + 1] = p[i][1];
      if (i) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      this.cum[i] = L;
    }
    this.length = L;
  }

  /** position + heading (rad, from +E towards +N) at arc length s; wraps when closed */
  at(s: number, out: { e: number; n: number; h: number }) {
    const L = this.length;
    if (this.closed) s = ((s % L) + L) % L;
    else s = Math.max(0, Math.min(L, s));
    // binary search
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid; else hi = mid;
    }
    const seg = this.cum[hi] - this.cum[lo];
    const u = seg > 0 ? (s - this.cum[lo]) / seg : 0;
    const e0 = this.pts[lo * 2], n0 = this.pts[lo * 2 + 1], e1 = this.pts[hi * 2], n1 = this.pts[hi * 2 + 1];
    out.e = e0 + (e1 - e0) * u;
    out.n = n0 + (n1 - n0) * u;
    // smooth the heading across vertices (blend with the neighbour segment near the ends)
    let h = Math.atan2(n1 - n0, e1 - e0);
    const blend = 6;
    if (seg > 0) {
      const dEnd = seg - (s - this.cum[lo]), dStart = s - this.cum[lo];
      if (dEnd < blend && hi + 1 < this.cum.length) {
        const h2 = Math.atan2(this.pts[hi * 2 + 3] - n1, this.pts[hi * 2 + 2] - e1);
        h = lerpAngle(h, h2, 0.5 * (1 - dEnd / blend));
      } else if (dStart < blend && lo > 0) {
        const h0 = Math.atan2(n0 - this.pts[lo * 2 - 1], e0 - this.pts[lo * 2 - 2]);
        h = lerpAngle(h, h0, 0.5 * (1 - dStart / blend));
      }
    }
    out.h = h;
    return out;
  }

  reversed(): Path {
    const p: [number, number][] = [];
    for (let i = this.cum.length - 1; i >= 0; i--) p.push([this.pts[i * 2], this.pts[i * 2 + 1]]);
    return new Path(p, false);
  }
}

export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** deterministic hash → [0, 1) */
export function hash01(a: number, b = 0, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Distance along a trip of duration T (s) at time t (s) for a boat that
 * accelerates / decelerates over `ramp` seconds (trapezoidal speed).
 * Returns { s: fraction 0..1, v: speed as a fraction of L per second }.
 */
export function trapezoid(t: number, T: number, ramp: number): { f: number; v: number } {
  if (t <= 0) return { f: 0, v: 0 };
  if (t >= T) return { f: 1, v: 0 };
  const r = Math.min(ramp, T / 2);
  const vmax = 1 / (T - r); // area under the trapezoid = 1
  if (t < r) return { f: 0.5 * vmax * (t * t) / r, v: vmax * t / r };
  if (t > T - r) { const u = T - t; return { f: 1 - 0.5 * vmax * (u * u) / r, v: vmax * u / r }; }
  return { f: 0.5 * vmax * r + vmax * (t - r), v: vmax };
}
