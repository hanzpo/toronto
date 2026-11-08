import type { LaneOut } from '../core/model';

export type TripKind = 1 | 2 | 3;

interface Seg { lane: number; i: number }

export class LaneIndex {
  private grid = new Map<number, Seg[]>();
  private cum: Float64Array[] = [];
  private ends: [{ lane: number; dir: 1 | -1 }[], { lane: number; dir: 1 | -1 }[]][] = [];
  readonly lanes: LaneOut[];
  constructor(lanes: LaneOut[]) {
    this.lanes = lanes;
    const C = 25;
    lanes.forEach((l, li) => {
      const c = new Float64Array(l.pts.length);
      for (let i = 1; i < l.pts.length; i++) c[i] = c[i - 1] + Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].y - l.pts[i - 1].y);
      this.cum[li] = c;
      for (let i = 0; i < l.pts.length - 1; i++) {
        const a = l.pts[i], b = l.pts[i + 1];
        const x0 = Math.floor(Math.min(a.x, b.x) / C), x1 = Math.floor(Math.max(a.x, b.x) / C);
        const y0 = Math.floor(Math.min(a.y, b.y) / C), y1 = Math.floor(Math.max(a.y, b.y) / C);
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
          const k = gx * 100003 + gy;
          let arr = this.grid.get(k);
          if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push({ lane: li, i });
        }
      }
    });
    const near = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y) < 0.5;
    lanes.forEach((l, li) => {
      const a = l.pts[0], b = l.pts[l.pts.length - 1];
      const e0: { lane: number; dir: 1 | -1 }[] = [], e1: { lane: number; dir: 1 | -1 }[] = [];
      const cands = new Set([...l.next, ...l.prev]);
      for (const j of cands) {
        const o = lanes[j];
        const oa = o.pts[0], ob = o.pts[o.pts.length - 1];
        if (l.next.includes(j) && !l.bidir && !o.bidir) { e1.push({ lane: j, dir: 1 }); continue; }
        if (near(b, oa)) e1.push({ lane: j, dir: 1 }); else if (near(b, ob) && o.bidir) e1.push({ lane: j, dir: -1 });
        if (l.bidir) { if (near(a, ob)) e0.push({ lane: j, dir: -1 }); else if (near(a, oa) && o.bidir) e0.push({ lane: j, dir: 1 }); }
      }
      this.ends[li] = [e0, e1];
    });
  }

  ok(l: LaneOut, kind: TripKind) {
    if (kind === 1) return l.kind === 'drive' && l.cls.includes('bus');
    if (kind === 2) return l.cls.includes('tram');
    return l.kind === 'rail';
  }

  near(x: number, y: number, r: number, kind: TripKind, hx: number, hy: number) {
    const C = 25;
    const out: { lane: number; dir: 1 | -1; d: number; s: number }[] = [];
    const seen = new Set<number>();
    for (let gx = Math.floor((x - r) / C); gx <= Math.floor((x + r) / C); gx++) for (let gy = Math.floor((y - r) / C); gy <= Math.floor((y + r) / C); gy++) {
      for (const sg of this.grid.get(gx * 100003 + gy) ?? []) {
        const l = this.lanes[sg.lane];
        if (!this.ok(l, kind)) continue;
        const a = l.pts[sg.i], b = l.pts[sg.i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
        if (L2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
        const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
        if (d > r) continue;
        const L = Math.sqrt(L2);
        const c = (dx * hx + dy * hy) / L;
        let dir: 1 | -1 = 1;
        if (c < 0.5) { if (l.bidir && c < -0.5) dir = -1; else continue; }
        const key = sg.lane * 2 + (dir > 0 ? 1 : 0);
        const s = this.cum[sg.lane][sg.i] + t * L;
        if (seen.has(key)) { const e = out.find((q) => q.lane === sg.lane && q.dir === dir)!; if (d < e.d) { e.d = d; e.s = s; } continue; }
        seen.add(key);
        out.push({ lane: sg.lane, dir, d, s });
      }
    }
    return out.sort((p, q) => p.d - q.d);
  }

  len(lane: number) { const c = this.cum[lane]; return c[c.length - 1]; }

  path(from: { lane: number; dir: 1 | -1 }, to: { lane: number; dir: 1 | -1 }, kind: TripKind, maxLen = 450): { lane: number; dir: 1 | -1 }[] | null {
    const key = (s: { lane: number; dir: number }) => s.lane * 2 + (s.dir > 0 ? 1 : 0);
    const prev = new Map<number, { lane: number; dir: 1 | -1 } | null>([[key(from), null]]);
    let frontier = [{ s: from, d: 0 }];
    while (frontier.length) {
      const nx: typeof frontier = [];
      for (const { s, d } of frontier) {
        for (const e of this.ends[s.lane][s.dir > 0 ? 1 : 0]) {
          const st = { lane: e.lane, dir: e.dir };
          if (prev.has(key(st)) || !this.ok(this.lanes[e.lane], kind)) continue;
          prev.set(key(st), s);
          if (e.lane === to.lane && e.dir === to.dir) {
            const out: { lane: number; dir: 1 | -1 }[] = [];
            let c: { lane: number; dir: 1 | -1 } | null = st;
            while (c && !(c.lane === from.lane && c.dir === from.dir)) { out.push(c); c = prev.get(key(c)) ?? null; }
            return out.reverse();
          }
          const nd = d + this.len(e.lane);
          if (nd < maxLen) nx.push({ s: st, d: nd });
        }
      }
      frontier = nx;
    }
    return null;
  }
}

export interface MatchedTrip { lanes: number[]; dirs: number[]; d: number; stopStep: number[]; stopD: number[]; stopDep: number[] }

export function matchTrip(ix: LaneIndex, kind: TripKind, pts: Float32Array, dist: Float32Array, start: number, stops: { dist: number; dep: number }[]): MatchedTrip | null {
  const r = kind === 3 ? 4 : kind === 2 ? 3.5 : 6;
  const steps: { lane: number; dir: 1 | -1 }[] = [];
  const at: { step: number; s: number; dist: number }[] = [];
  let d0 = 0;
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1];
    const j = Math.min(n - 1, i + 1), k = Math.max(0, i - 1);
    let hx = pts[j * 3] - pts[k * 3], hy = pts[j * 3 + 1] - pts[k * 3 + 1];
    const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
    const c = ix.near(x, y, r, kind, hx, hy);
    if (!c.length) continue;
    const cur = steps[steps.length - 1];
    const same = cur && c.find((q) => q.lane === cur.lane && q.dir === cur.dir);
    if (same) { at.push({ step: steps.length - 1, s: same.s, dist: dist[i] }); continue; }
    if (!cur) {
      steps.push({ lane: c[0].lane, dir: c[0].dir });
      d0 = c[0].dir > 0 ? c[0].s : ix.len(c[0].lane) - c[0].s;
      at.push({ step: 0, s: c[0].s, dist: dist[i] });
      continue;
    }
    let joined = false;
    for (const q of c.slice(0, 4)) {
      const p = ix.path(cur, { lane: q.lane, dir: q.dir }, kind);
      if (p) { steps.push(...p); at.push({ step: steps.length - 1, s: q.s, dist: dist[i] }); joined = true; break; }
    }
    if (!joined && steps.length > 3) break;
  }
  if (!steps.length) return null;
  const firstDist = at[0]?.dist ?? start;
  const startD = Math.max(0, d0 + (start - firstDist));
  const stopStep: number[] = [], stopD: number[] = [], stopDep: number[] = [];
  let k = 0;
  for (const st of stops) {
    if (st.dist < start) continue;
    let best = -1, bd = Infinity;
    for (let q = k; q < at.length; q++) {
      const dd = Math.abs(at[q].dist - st.dist);
      if (dd < bd) { bd = dd; best = q; }
      if (at[q].dist > st.dist + 40) break;
    }
    if (best < 0 || bd > 25) continue;
    k = best;
    const a = at[best];
    const l = steps[a.step];
    const along = l.dir > 0 ? a.s : ix.len(l.lane) - a.s;
    stopStep.push(a.step);
    stopD.push(along + (st.dist - a.dist));
    stopDep.push(st.dep);
  }
  return { lanes: steps.map((s) => s.lane), dirs: steps.map((s) => s.dir), d: startD, stopStep, stopD, stopDep };
}
