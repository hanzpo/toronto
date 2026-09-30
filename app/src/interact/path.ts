// Pattern geometry for one trip: the shape polyline (absolute world E/N/z),
// cumulative distance, stop distances and a pre-computed curve speed limit.
// Geometry comes from the public TransitSystem.patternShape() API.
import type { TransitSystem, TripInfo } from '../transit';

export interface PathStop {
  stop: number;
  name: string;
  dist: number;
  arr: number;
  dep: number;
  virtual: boolean;
}

export interface Pose {
  e: number;
  n: number;
  z: number;
  /** rad CCW from +E */
  heading: number;
  pitch: number;
}

const LIMIT_STEP = 10; // m

export class PatternPath {
  readonly pattern: number;
  readonly xyz: Float64Array;
  readonly dist: Float64Array;
  readonly length: number;
  readonly stops: PathStop[];
  /** curve speed limit (m/s) every LIMIT_STEP m, filled by computeCurveLimits */
  curveLimit: Float32Array = new Float32Array(0);
  private hint = 0;

  constructor(pattern: number, xyz: Float64Array, stops: PathStop[]) {
    this.pattern = pattern;
    this.xyz = xyz;
    const n = xyz.length / 3;
    this.dist = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      this.dist[i] = this.dist[i - 1] + Math.hypot(xyz[3 * i] - xyz[3 * i - 3], xyz[3 * i + 1] - xyz[3 * i - 2]);
    }
    this.length = this.dist[n - 1] ?? 0;
    this.stops = stops;
  }

  /** index of the segment containing s */
  private seg(s: number): number {
    const D = this.dist;
    const n = D.length;
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

  /** point at distance s (clamped) → out [e, n, z] */
  point(s: number, out: number[] | Float64Array = [0, 0, 0]): number[] | Float64Array {
    s = Math.max(0, Math.min(this.length, s));
    const a = this.seg(s);
    const P = this.xyz, D = this.dist;
    const L = D[a + 1] - D[a];
    const t = L > 0 ? (s - D[a]) / L : 0;
    const i = 3 * a;
    out[0] = P[i] + (P[i + 3] - P[i]) * t;
    out[1] = P[i + 1] + (P[i + 4] - P[i + 1]) * t;
    out[2] = P[i + 2] + (P[i + 5] - P[i + 2]) * t;
    return out;
  }

  /** like point(), but continues straight past either end of the path */
  pointX(s: number, out: number[] | Float64Array = [0, 0, 0]): number[] | Float64Array {
    if (s >= 0 && s <= this.length) return this.point(s, out);
    const q = this.pose(s, 6, _px);
    out[0] = q.e; out[1] = q.n; out[2] = q.z;
    return out;
  }

  /** position + heading/pitch from points ±half m around s (like the runtime) */
  pose(s: number, half = 6, out: Pose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 }): Pose {
    // The direction window slides to stay inside the path, and positions past
    // either end are extrapolated along it — at a terminus the cab (train
    // front) can sit beyond the last shape vertex.
    const len = this.length;
    const w = Math.min(2 * half, len);
    const sa = Math.min(Math.max(s - half, 0), len - w);
    const b = this.point(sa, _b);
    const c = this.point(sa + w, _c);
    const dx = c[0] - b[0], dy = c[1] - b[1], dz = c[2] - b[2];
    const hd = Math.hypot(dx, dy);
    if (hd > 1e-3) {
      out.heading = Math.atan2(dy, dx);
      out.pitch = Math.atan2(dz, hd);
    }
    const p = this.point(s, _a);
    const over = s > len ? s - len : s < 0 ? s : 0;
    const k = over && w > 0 ? over / w : 0;
    out.e = p[0] + dx * k; out.n = p[1] + dy * k; out.z = p[2] + dz * k;
    return out;
  }

  /** Curve speed limits from the circumradius of points ±half m apart (long chords ignore small track jogs). */
  computeCurveLimits(latAccel: number, vmax: number, vmin: number, half = 15) {
    const n = Math.ceil(this.length / LIMIT_STEP) + 1;
    const lim = new Float32Array(n);
    const p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const s = k * LIMIT_STEP;
      this.point(s - half, p0); this.point(s, p1); this.point(s + half, p2);
      const a = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const b = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const c = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
      const cross = Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]));
      const R = cross > 1e-6 ? (a * b * c) / (2 * cross) : 1e9;
      lim[k] = Math.max(vmin, Math.min(vmax, Math.sqrt(latAccel * R)));
    }
    // smooth: a limit applies over the whole curve (min over ±20 m)
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let m = lim[k];
      for (let j = -2; j <= 2; j++) { const q = k + j; if (q >= 0 && q < n && lim[q] < m) m = lim[q]; }
      out[k] = Math.round(m * 3.6 / 5) * 5 / 3.6 || vmin; // posted in 5 km/h steps
    }
    this.curveLimit = out;
  }

  limitAt(s: number): number {
    const L = this.curveLimit;
    if (!L.length) return 1e9;
    const k = Math.max(0, Math.min(L.length - 1, Math.round(s / LIMIT_STEP)));
    return L[k];
  }

  /** Lowest limit in (s, s+range] with the distance to where it starts. */
  nextLowerLimit(s: number, range: number, current: number): { v: number; at: number } | null {
    const L = this.curveLimit;
    let best: { v: number; at: number } | null = null;
    for (let d = LIMIT_STEP; d <= range; d += LIMIT_STEP) {
      const k = Math.round((s + d) / LIMIT_STEP);
      if (k >= L.length) break;
      if (L[k] < current - 0.5 && (!best || L[k] < best.v)) best = { v: L[k], at: d };
    }
    return best;
  }
}

const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0];

const cache = new Map<number, PatternPath>();
let cacheSys: TransitSystem | null = null;
let cacheTrips = -1;

/** Path of a trip's pattern with the trip's stop times. */
export function pathForTrip(sys: TransitSystem, info: TripInfo): PatternPath | null {
  if (cacheSys !== sys || cacheTrips !== sys.tripCount) { cache.clear(); cacheSys = sys; cacheTrips = sys.tripCount; }
  const shape = sys.patternShape(info.pattern);
  if (!shape) return null;
  const stops: PathStop[] = info.stops.map((s) => ({ stop: s.stop, name: s.name, dist: s.dist, arr: s.arr, dep: s.dep, virtual: s.virtual }));
  let base = cache.get(info.pattern);
  if (!base) {
    base = new PatternPath(info.pattern, shape.toFloat64(), []);
    cache.set(info.pattern, base);
  }
  // share geometry, own the stops (times differ per trip)
  const path = Object.create(base) as PatternPath;
  (path as { stops: PathStop[] }).stops = stops;
  return path;
}

const _px: Pose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
