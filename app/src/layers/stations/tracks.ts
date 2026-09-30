// Segment grid over the loaded rail route polylines (transit patterns, which
// are map-matched onto the OSM tracks and carry the grade profile), used to
// snap curated platforms onto the exact track the trains run on.
import type { Mode } from '../../transit';

export interface Poly { xyz: Float32Array; cum: Float64Array; mode: Mode; route: string }

export interface Hit { poly: number; seg: number; t: number; d: number; x: number; y: number }

export class TrackIndex {
  polys: Poly[] = [];
  private grid = new Map<number, number[]>();
  private cell = 200;

  private key(cx: number, cy: number) { return (cx + 4096) * 8192 + (cy + 4096); }

  add(mode: Mode, route: string, xyz: Float32Array) {
    const n = xyz.length / 3;
    if (n < 2) return;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xyz[3 * i] - xyz[3 * i - 3], xyz[3 * i + 1] - xyz[3 * i - 2]);
    const pi = this.polys.length;
    this.polys.push({ xyz, cum, mode, route });
    for (let i = 0; i < n - 1; i++) {
      const x0 = xyz[3 * i], y0 = xyz[3 * i + 1], x1 = xyz[3 * i + 3], y1 = xyz[3 * i + 4];
      const cx0 = Math.floor(Math.min(x0, x1) / this.cell), cx1 = Math.floor(Math.max(x0, x1) / this.cell);
      const cy0 = Math.floor(Math.min(y0, y1) / this.cell), cy1 = Math.floor(Math.max(y0, y1) / this.cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const k = this.key(cx, cy);
        let a = this.grid.get(k);
        if (!a) this.grid.set(k, (a = []));
        a.push(pi, i);
      }
    }
  }

  /** nearest point on each polyline passing `ok` within r of (e, n), nearest first */
  near(e: number, n: number, r: number, ok: (p: Poly) => boolean): Hit[] {
    const best = new Map<number, Hit>();
    const c0x = Math.floor((e - r) / this.cell), c1x = Math.floor((e + r) / this.cell);
    const c0y = Math.floor((n - r) / this.cell), c1y = Math.floor((n + r) / this.cell);
    for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) {
      const a = this.grid.get(this.key(cx, cy));
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) {
        const pi = a[k], si = a[k + 1];
        const p = this.polys[pi];
        if (!ok(p)) continue;
        const x0 = p.xyz[3 * si], y0 = p.xyz[3 * si + 1], x1 = p.xyz[3 * si + 3], y1 = p.xyz[3 * si + 4];
        const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((e - x0) * dx + (n - y0) * dy) / L2)) : 0;
        const x = x0 + dx * t, y = y0 + dy * t;
        const d = Math.hypot(e - x, n - y);
        if (d > r) continue;
        const cur = best.get(pi);
        if (!cur || d < cur.d) best.set(pi, { poly: pi, seg: si, t, d, x, y });
      }
    }
    return [...best.values()].sort((a, b) => a.d - b.d);
  }

  /** point (E, N, z) and unit tangent at arc length s along poly (clamped) */
  at(pi: number, s: number): { e: number; n: number; z: number; tx: number; ty: number } {
    const p = this.polys[pi];
    const n = p.cum.length;
    s = Math.max(0, Math.min(p.cum[n - 1], s));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (p.cum[m] <= s) lo = m; else hi = m;
    }
    const L = p.cum[hi] - p.cum[lo] || 1;
    const t = (s - p.cum[lo]) / L;
    const a = 3 * lo, b = 3 * hi;
    const tx = (p.xyz[b] - p.xyz[a]) / L, ty = (p.xyz[b + 1] - p.xyz[a + 1]) / L;
    return { e: p.xyz[a] + (p.xyz[b] - p.xyz[a]) * t, n: p.xyz[a + 1] + (p.xyz[b + 1] - p.xyz[a + 1]) * t, z: p.xyz[a + 2] + (p.xyz[b + 2] - p.xyz[a + 2]) * t, tx, ty };
  }

  /** smoothed unit tangent (±w m) */
  tangent(pi: number, s: number, w = 6): [number, number] {
    const a = this.at(pi, s - w), b = this.at(pi, s + w);
    let tx = b.e - a.e, ty = b.n - a.n;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    return [tx, ty];
  }

  arc(pi: number, seg: number, t: number): number {
    const p = this.polys[pi];
    return p.cum[seg] + (p.cum[seg + 1] - p.cum[seg]) * t;
  }

  length(pi: number): number {
    const c = this.polys[pi].cum;
    return c[c.length - 1];
  }
}
