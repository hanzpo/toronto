import type { Ctx, Variant } from './ctx';
import { segX } from './geom';
import type { Seg } from './model';

const STEP = 2;

export function resolveStructures(ctx: Ctx) {
  const forced = new Map<Seg, Variant[]>();
  for (const s of ctx.segs) {
    const L = s.path.length;
    const out: Variant[] = [];
    for (const v of s.desc.variant ?? []) {
      const s0 = v.s0 <= 1 && v.s1 <= 1 && L > 1 ? v.s0 * L : v.s0;
      const s1 = v.s0 <= 1 && v.s1 <= 1 && L > 1 ? v.s1 * L : v.s1;
      if (v.kind !== 'auto') out.push({ s0, s1, kind: v.kind === 'grade' ? 'grade' : v.kind });
    }
    forced.set(s, out);
  }
  const over = crossings(ctx);
  for (const s of ctx.segs) {
    const L = s.path.length;
    const a = s.asset;
    const kinds: Variant['kind'][] = [];
    const n = Math.max(2, Math.ceil(L / STEP) + 1);
    for (let i = 0; i < n; i++) {
      const t = (L * i) / (n - 1);
      const f = s.path.at(t);
      const g = ctx.terrainAt(f.x, f.y);
      let k: Variant['kind'] = 'grade';
      if (g !== null) {
        const dz = f.z - g;
        if (dz > a.maxEmbank) k = 'bridge';
        else if (dz < -(a.maxCut + (a.family === 'road' ? 5.5 : 6.5))) k = 'tunnel';
      }
      kinds.push(k);
    }
    for (const r of over.get(s) ?? []) {
      for (let i = 0; i < n; i++) {
        const t = (L * i) / (n - 1);
        if (t >= r[0] && t <= r[1]) kinds[i] = 'bridge';
      }
    }
    let ranges = runs(kinds, L, n).filter((r) => r.kind !== 'grade');
    ranges = merge(ranges, a.family === 'road' ? 12 : 16);
    const f = forced.get(s)!;
    if (f.length) {
      const res: Variant[] = [];
      for (const r of ranges) {
        let pieces: Variant[] = [r];
        for (const q of f) pieces = pieces.flatMap((p) => cutOut(p, q));
        res.push(...pieces);
      }
      res.push(...f.filter((q) => q.kind !== 'grade'));
      ranges = res.sort((p, q) => p.s0 - q.s0);
    }
    ctx.variants.set(s, ranges.filter((r) => r.s1 - r.s0 > 1));
  }
}

function cutOut(p: Variant, q: Variant): Variant[] {
  if (q.s1 <= p.s0 || q.s0 >= p.s1) return [p];
  const out: Variant[] = [];
  if (q.s0 > p.s0) out.push({ ...p, s1: q.s0 });
  if (q.s1 < p.s1) out.push({ ...p, s0: q.s1 });
  return out;
}

function runs(k: Variant['kind'][], L: number, n: number): Variant[] {
  const out: Variant[] = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && k[j + 1] === k[i]) j++;
    const s0 = (L * Math.max(0, i - 0.5)) / (n - 1), s1 = (L * Math.min(n - 1, j + 0.5)) / (n - 1);
    out.push({ s0, s1, kind: k[i] });
    i = j + 1;
  }
  return out;
}

function merge(r: Variant[], gap: number): Variant[] {
  const out: Variant[] = [];
  for (const v of r) {
    const last = out[out.length - 1];
    if (last && last.kind === v.kind && v.s0 - last.s1 < gap) last.s1 = v.s1;
    else out.push({ ...v });
  }
  return out;
}

function crossings(ctx: Ctx): Map<Seg, [number, number][]> {
  const out = new Map<Seg, [number, number][]>();
  const segs = ctx.segs;
  const box = segs.map((s) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.path.n; i++) { x0 = Math.min(x0, s.path.x[i]); x1 = Math.max(x1, s.path.x[i]); y0 = Math.min(y0, s.path.y[i]); y1 = Math.max(y1, s.path.y[i]); }
    return { x0, y0, x1, y1 };
  });
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i], B = segs[j];
      if (box[i].x1 < box[j].x0 || box[j].x1 < box[i].x0 || box[i].y1 < box[j].y0 || box[j].y1 < box[i].y0) continue;
      if (A.desc.a === B.desc.a || A.desc.a === B.desc.b || A.desc.b === B.desc.a || A.desc.b === B.desc.b) continue;
      for (let p = 0; p < A.path.n - 1; p++) {
        for (let q = 0; q < B.path.n - 1; q++) {
          const x = segX(
            { x: A.path.x[p], y: A.path.y[p] }, { x: A.path.x[p + 1], y: A.path.y[p + 1] },
            { x: B.path.x[q], y: B.path.y[q] }, { x: B.path.x[q + 1], y: B.path.y[q + 1] },
          );
          if (!x) continue;
          const sa = A.path.s[p] + x.t * (A.path.s[p + 1] - A.path.s[p]);
          const sb = B.path.s[q] + x.u * (B.path.s[q + 1] - B.path.s[q]);
          const za = A.path.at(sa).z, zb = B.path.at(sb).z;
          const [up, lo, su, sl] = za >= zb ? [A, B, sa, sb] : [B, A, sb, sa];
          void sl;
          const dz = Math.abs(za - zb);
          const need = up.asset.deckDepth + lo.asset.clearance;
          if (dz < 0.5) {
            ctx.review.push({ at: x.p, kind: 'unresolved_crossing', note: `${A.desc.id} x ${B.desc.id} at grade without a shared node` });
            continue;
          }
          if (dz < need - 0.05) ctx.review.push({ at: x.p, kind: 'low_clearance', note: `${up.desc.id} over ${lo.desc.id}: ${dz.toFixed(2)} m < ${need.toFixed(2)} m` });
          const ang = Math.abs(Math.sin(Math.atan2(B.path.y[q + 1] - B.path.y[q], B.path.x[q + 1] - B.path.x[q]) - Math.atan2(A.path.y[p + 1] - A.path.y[p], A.path.x[p + 1] - A.path.x[p])));
          const half = (lo.lay[0].l - lo.lay[lo.lay.length - 1].r) / 2;
          const span = (half + 3) / Math.max(0.25, ang) + 4;
          const list = out.get(up) ?? [];
          list.push([su - span, su + span]);
          out.set(up, list);
        }
      }
    }
  }
  return out;
}
