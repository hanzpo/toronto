import type { Ctx } from './ctx';
import type { TerrainDesc } from './desc';
import { pointInPoly, polyDist } from './geom';
import type { Seg } from './model';
import { segRange, variantAt } from './segments';

const SINK = 0.05;
const SLOPE = 0.5;
const REACH = 40;

export function conformTerrain(ctx: Ctx, t: TerrainDesc) {
  const N = t.nx * t.ny;
  const lo = new Float32Array(N).fill(-Infinity);
  const hi = new Float32Array(N).fill(Infinity);
  const orig = t.h;
  const apply = (i: number, l: number, h: number) => {
    if (l > lo[i]) lo[i] = l;
    if (h < hi[i]) hi[i] = h;
  };

  for (const s of ctx.segs) stampSeg(ctx, t, s, apply);
  for (const f of ctx.footprints) {
    if (f.kind !== 'node') continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zmin = Infinity, zsum = 0;
    for (const p of f.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); zmin = Math.min(zmin, p.z); zsum += p.z; }
    const zm = zsum / f.pts.length;
    const r = REACH;
    const i0 = Math.max(0, Math.floor((x0 - r - t.x0) / t.cell)), i1 = Math.min(t.nx - 1, Math.ceil((x1 + r - t.x0) / t.cell));
    const j0 = Math.max(0, Math.floor((y0 - r - t.y0) / t.cell)), j1 = Math.min(t.ny - 1, Math.ceil((y1 + r - t.y0) / t.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const p = { x: t.x0 + i * t.cell, y: t.y0 + j * t.cell };
      const inside = pointInPoly(p, f.pts);
      const d = inside ? 0 : polyDist(p, f.pts);
      if (d > r) continue;
      if (d <= t.cell * 0.75) apply(j * t.nx + i, -Infinity, zmin - SINK);
      else apply(j * t.nx + i, zm - SLOPE * d, zm + SLOPE * d);
    }
  }

  const h = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = orig[i];
    if (lo[i] > hi[i]) v = hi[i];
    else v = Math.min(Math.max(v, lo[i]), hi[i]);
    h[i] = v;
  }
  ctx.terrainOut = { x0: t.x0, y0: t.y0, cell: t.cell, nx: t.nx, ny: t.ny, h };
}

function stampSeg(ctx: Ctx, t: TerrainDesc, s: Seg, apply: (i: number, l: number, h: number) => void) {
  const { sa, sb } = segRange(s);
  const lay = s.lay;
  const Lw = lay[0].l, Rw = lay[lay.length - 1].r;
  const minH = Math.min(...lay.map((b) => Math.min(b.hl, b.hr)));
  const edgeL = lay[0].hl, edgeR = lay[lay.length - 1].hr;
  const P = s.path;
  const cell = t.cell;
  const pad = cell * 0.75;
  const wall = (ctx.variants.get(s) ?? []).some((v) => v.kind === 'wall');
  void wall;
  for (let k = 0; k < P.n - 1; k++) {
    const s0 = P.s[k], s1 = P.s[k + 1];
    if (s1 < sa - 2 || s0 > sb + 2) continue;
    const ax = P.x[k], ay = P.y[k], bx = P.x[k + 1], by = P.y[k + 1];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    if (l < 1e-6) continue;
    const ux = dx / l, uy = dy / l;
    const r = Math.max(Math.abs(Lw), Math.abs(Rw)) + REACH;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - t.x0) / cell)), i1 = Math.min(t.nx - 1, Math.ceil((Math.max(ax, bx) + r - t.x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - t.y0) / cell)), j1 = Math.min(t.ny - 1, Math.ceil((Math.max(ay, by) + r - t.y0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = t.x0 + i * cell - ax, py = t.y0 + j * cell - ay;
      const along = px * ux + py * uy;
      if (along < -0.01 || along > l + 0.01) continue;
      const s_ = s0 + along;
      if (s_ < sa - 0.5 || s_ > sb + 0.5) continue;
      const kind = variantAt(ctx, s, s_);
      if (kind === 'bridge' || kind === 'tunnel') {
        const near = Math.min(Math.abs(s_ - sa), Math.abs(s_ - sb));
        void near;
        continue;
      }
      const lat = -px * uy + py * ux;
      const z = P.z[k] + (P.z[k + 1] - P.z[k]) * (along / l);
      const idx = j * t.nx + i;
      if (lat <= Lw + pad && lat >= Rw - pad) {
        apply(idx, -Infinity, z + minH - SINK);
        continue;
      }
      const d = lat > Lw ? lat - Lw : Rw - lat;
      const ze = z + (lat > Lw ? edgeL : edgeR);
      if (kind === 'wall') continue;
      const slope = SLOPE;
      apply(idx, ze - SINK - slope * d, ze + slope * d);
    }
  }
}
