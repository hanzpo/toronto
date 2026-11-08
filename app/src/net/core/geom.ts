export interface V2 { x: number; y: number }

export const v2 = (x: number, y: number): V2 => ({ x, y });
export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: V2, k: number): V2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: V2, b: V2) => a.x * b.x + a.y * b.y;
export const cross = (a: V2, b: V2) => a.x * b.y - a.y * b.x;
export const len = (a: V2) => Math.hypot(a.x, a.y);
export const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: V2): V2 => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
export const left = (a: V2): V2 => ({ x: -a.y, y: a.x });
export const lerp2 = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const angle = (a: V2) => Math.atan2(a.y, a.x);
export const fromAngle = (t: number): V2 => ({ x: Math.cos(t), y: Math.sin(t) });
export const rot = (a: V2, t: number): V2 => { const c = Math.cos(t), s = Math.sin(t); return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }; };

export function wrapPi(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

export function wrap2Pi(a: number) {
  a %= 2 * Math.PI;
  return a < 0 ? a + 2 * Math.PI : a;
}

export function lineX(p: V2, d: V2, q: V2, e: V2): { t: number; u: number } | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9) return null;
  const w = sub(q, p);
  return { t: cross(w, e) / den, u: cross(w, d) / den };
}

export function segX(a: V2, b: V2, c: V2, d: V2): { t: number; u: number; p: V2 } | null {
  const r = lineX(a, sub(b, a), c, sub(d, c));
  if (!r || r.t < 0 || r.t > 1 || r.u < 0 || r.u > 1) return null;
  return { ...r, p: lerp2(a, b, r.t) };
}

export function closestOnSeg(p: V2, a: V2, b: V2): { t: number; d: number; q: V2 } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  const q = lerp2(a, b, t);
  return { t, d: dist(p, q), q };
}

export function arcPoints(c: V2, r: number, a0: number, a1: number, ccw: boolean, step = 0.25): V2[] {
  let sweep = a1 - a0;
  if (ccw) { while (sweep < 0) sweep += 2 * Math.PI; } else { while (sweep > 0) sweep -= 2 * Math.PI; }
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / step) + 1);
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const t = a0 + (sweep * i) / (n - 1);
    out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return out;
}

export function bezier(p0: V2, p1: V2, p2: V2, p3: V2, t: number): V2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

export function polyArea(p: V2[]) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x - p[i].x) * (p[j].y + p[i].y);
  return a / 2;
}

export function pointInPoly(p: V2, poly: V2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polyDist(p: V2, poly: V2[]) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, closestOnSeg(p, poly[j], poly[i]).d);
  return d;
}

export function filletLines(
  p: V2, d: V2, q: V2, e: V2, r: number, sideP: number, sideQ: number,
): { c: V2; tp: number; tq: number } | null {
  const np = mul(left(d), sideP * r), nq = mul(left(e), sideQ * r);
  const x = lineX(add(p, np), d, add(q, nq), e);
  if (!x) return null;
  return { c: add(add(p, np), mul(d, x.t)), tp: x.t, tq: x.u };
}
