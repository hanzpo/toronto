import { type V2, add, dist, mul, norm, sub, cross, left, wrapPi, angle } from './geom';

export interface PathPt { x: number; y: number; z: number; s: number }
export interface Frame { x: number; y: number; z: number; tx: number; ty: number; grade: number }

const ARC_STEP = (3 * Math.PI) / 180;
const MAX_STEP = 6;

export function fillet(pts: V2[], r: number, minEnd = 0): V2[] {
  if (pts.length < 3 || r <= 0) return densify(pts);
  const out: V2[] = [pts[0]];
  const segLen = pts.slice(1).map((p, i) => dist(p, pts[i]));
  const use: number[] = new Array(pts.length).fill(0);
  const want: number[] = new Array(pts.length).fill(0);
  for (let i = 1; i < pts.length - 1; i++) {
    const d1 = norm(sub(pts[i], pts[i - 1])), d2 = norm(sub(pts[i + 1], pts[i]));
    const th = Math.abs(wrapPi(angle(d2) - angle(d1)));
    want[i] = th < 1e-4 ? 0 : r * Math.tan(th / 2);
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const before = i === 1 ? segLen[0] - minEnd : segLen[i - 1] * (want[i] / Math.max(1e-9, want[i] + want[i - 1]));
    const after = i === pts.length - 2 ? segLen[i] - minEnd : segLen[i] * (want[i] / Math.max(1e-9, want[i] + want[i + 1]));
    use[i] = Math.max(0, Math.min(want[i], before, after));
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d1 = norm(sub(p, pts[i - 1])), d2 = norm(sub(pts[i + 1], p));
    const t = use[i];
    if (t < 1e-3) { out.push(p); continue; }
    const th = wrapPi(angle(d2) - angle(d1));
    const rr = t / Math.tan(Math.abs(th) / 2);
    const a = sub(p, mul(d1, t));
    const side = th > 0 ? 1 : -1;
    const c = add(a, mul(left(d1), side * rr));
    const a0 = angle(sub(a, c));
    const n = Math.max(2, Math.ceil(Math.abs(th) / ARC_STEP) + 1);
    for (let k = 0; k < n; k++) {
      const ang = a0 + (th * k) / (n - 1);
      out.push({ x: c.x + rr * Math.cos(ang), y: c.y + rr * Math.sin(ang) });
    }
  }
  out.push(pts[pts.length - 1]);
  return densify(out);
}

export function densify(pts: V2[], step = MAX_STEP): V2[] {
  const out: V2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = dist(a, b);
    if (d < 1e-6) continue;
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

export function hermite(a: V2, ta: V2, b: V2, tb: V2, k = 0.4): V2[] {
  const d = dist(a, b);
  const p1 = add(a, mul(norm(ta), d * k)), p2 = sub(b, mul(norm(tb), d * k));
  const n = Math.max(8, Math.ceil(d / 1.5));
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y,
    });
  }
  return out;
}

export function turnout(a: V2, dir: V2, side: number, radius: number, length: number, tail = 0): V2[] {
  const d = norm(dir);
  const n = mul(left(d), side);
  const out: V2[] = [];
  const th = length / radius;
  const steps = Math.max(8, Math.ceil(length / 1.5));
  for (let i = 0; i <= steps; i++) {
    const a1 = (th * i) / steps;
    out.push(add(a, add(mul(d, radius * Math.sin(a1)), mul(n, radius * (1 - Math.cos(a1))))));
  }
  if (tail > 0) {
    const e = out[out.length - 1];
    const de = add(mul(d, Math.cos(th)), mul(n, Math.sin(th)));
    out.push(add(e, mul(de, tail)));
  }
  return out;
}

export class Path {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly s: Float64Array;
  readonly length: number;

  constructor(pts: V2[], zAt: (s: number) => number) {
    const clean: V2[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (dist(pts[i], clean[clean.length - 1]) > 1e-4) clean.push(pts[i]);
    if (clean.length < 2) clean.push({ x: clean[0].x + 1e-3, y: clean[0].y });
    this.n = clean.length;
    this.x = new Float64Array(this.n);
    this.y = new Float64Array(this.n);
    this.z = new Float64Array(this.n);
    this.s = new Float64Array(this.n);
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      if (i > 0) s += dist(clean[i], clean[i - 1]);
      this.x[i] = clean[i].x; this.y[i] = clean[i].y; this.s[i] = s;
    }
    this.length = s;
    for (let i = 0; i < this.n; i++) this.z[i] = zAt(this.s[i]);
  }

  index(s: number) {
    let lo = 0, hi = this.n - 1;
    if (s <= 0) return 0;
    if (s >= this.length) return this.n - 2;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    return lo;
  }

  at(s: number): Frame {
    const i = this.index(s);
    const s0 = this.s[i], s1 = this.s[i + 1];
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const dx = this.x[i + 1] - this.x[i], dy = this.y[i + 1] - this.y[i];
    const l = Math.hypot(dx, dy) || 1;
    let tx = dx / l, ty = dy / l;
    const blend = 0.5;
    if (t < blend && i > 0) {
      const px = this.x[i] - this.x[i - 1], py = this.y[i] - this.y[i - 1], pl = Math.hypot(px, py) || 1;
      const w = 0.5 - t;
      tx = tx * (1 - w) + (px / pl) * w; ty = ty * (1 - w) + (py / pl) * w;
    } else if (t > 1 - blend && i < this.n - 2) {
      const nx = this.x[i + 2] - this.x[i + 1], ny = this.y[i + 2] - this.y[i + 1], nl = Math.hypot(nx, ny) || 1;
      const w = t - 0.5;
      tx = tx * (1 - w) + (nx / nl) * w; ty = ty * (1 - w) + (ny / nl) * w;
    }
    const tl = Math.hypot(tx, ty) || 1;
    return {
      x: this.x[i] + dx * t, y: this.y[i] + dy * t, z: this.z[i] + (this.z[i + 1] - this.z[i]) * t,
      tx: tx / tl, ty: ty / tl, grade: (this.z[i + 1] - this.z[i]) / Math.max(1e-6, s1 - s0),
    };
  }

  tangentAt(i: number): V2 {
    const a = Math.max(0, i - 1), b = Math.min(this.n - 1, i + 1);
    return norm({ x: this.x[b] - this.x[a], y: this.y[b] - this.y[a] });
  }

  stations(s0: number, s1: number): number[] {
    const out = [s0];
    for (let i = 0; i < this.n; i++) if (this.s[i] > s0 + 0.05 && this.s[i] < s1 - 0.05) out.push(this.s[i]);
    out.push(s1);
    return out;
  }

  offset(o: number, s0: number, s1: number): PathPt[] {
    return this.stations(s0, s1).map((s) => {
      const f = this.at(s);
      return { x: f.x - f.ty * o, y: f.y + f.tx * o, z: f.z, s };
    });
  }

  project(p: V2): { s: number; lat: number; d: number } {
    let best = { s: 0, lat: 0, d: Infinity };
    for (let i = 0; i < this.n - 1; i++) {
      const ax = this.x[i], ay = this.y[i];
      const dx = this.x[i + 1] - ax, dy = this.y[i + 1] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / l2)) : 0;
      const qx = ax + dx * t, qy = ay + dy * t;
      const d = Math.hypot(p.x - qx, p.y - qy);
      if (d < best.d) {
        const l = Math.sqrt(l2) || 1;
        best = { s: this.s[i] + t * l, lat: cross({ x: dx / l, y: dy / l }, { x: p.x - qx, y: p.y - qy }), d };
      }
    }
    return best;
  }

  points(): V2[] {
    const out: V2[] = [];
    for (let i = 0; i < this.n; i++) out.push({ x: this.x[i], y: this.y[i] });
    return out;
  }
}

export function profileFn(ctrl: { s: number; z: number }[], rv: number): (s: number) => number {
  const c = [...ctrl].sort((a, b) => a.s - b.s);
  if (c.length === 1) return () => c[0].z;
  const pts = fillet(c.map((p) => ({ x: p.s, y: p.z })), rv);
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.y);
  return (s: number) => {
    if (s <= xs[0]) return zs[0];
    if (s >= xs[xs.length - 1]) return zs[zs.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= s) lo = m; else hi = m; }
    const t = (s - xs[lo]) / Math.max(1e-9, xs[hi] - xs[lo]);
    return zs[lo] + (zs[hi] - zs[lo]) * t;
  };
}

export function offsetLine(pts: PathPt[], cut: { p: V2; d: V2 } | null, end: 'start' | 'end'): PathPt[] {
  if (!cut || pts.length < 2) return pts;
  const side = (q: V2) => cross(cut.d, { x: q.x - cut.p.x, y: q.y - cut.p.y });
  const keepSign = end === 'start' ? side(pts[pts.length - 1]) : side(pts[0]);
  const out: PathPt[] = [];
  if (end === 'start') {
    let i = 0;
    while (i < pts.length - 1 && Math.sign(side(pts[i])) !== Math.sign(keepSign)) i++;
    if (i > 0) {
      const a = pts[i - 1], b = pts[i];
      const sa = side(a), sb = side(b);
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, s: a.s + (b.s - a.s) * t });
    }
    for (; i < pts.length; i++) out.push(pts[i]);
  } else {
    let i = pts.length - 1;
    while (i > 0 && Math.sign(side(pts[i])) !== Math.sign(keepSign)) i--;
    for (let k = 0; k <= i; k++) out.push(pts[k]);
    if (i < pts.length - 1) {
      const a = pts[i], b = pts[i + 1];
      const sa = side(a), sb = side(b);
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, s: a.s + (b.s - a.s) * t });
    }
  }
  return out.length >= 2 ? out : pts;
}
