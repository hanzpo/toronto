import type { Ctx } from './ctx';
import { segX } from './geom';
import type { LaneOut } from './model';

export function lengths(l: LaneOut): number[] {
  const out = [0];
  for (let i = 1; i < l.pts.length; i++) out.push(out[i - 1] + Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].y - l.pts[i - 1].y));
  return out;
}

export function linkLanes(ctx: Ctx) {
  const byNode = new Map<string, LaneOut[]>();
  for (const l of ctx.lanes) if (l.node) { const a = byNode.get(l.node) ?? []; a.push(l); byNode.set(l.node, a); }
  for (const lanes of byNode.values()) {
    const veh = lanes.filter((l) => l.kind !== 'walk');
    const cum = new Map<LaneOut, number[]>();
    for (const l of lanes) cum.set(l, lengths(l));
    for (let i = 0; i < lanes.length; i++) {
      for (let j = i + 1; j < lanes.length; j++) {
        const A = lanes[i], B = lanes[j];
        if (A.kind === 'walk' && B.kind === 'walk') continue;
        if (A.kind === 'walk' && !A.crosswalk) continue;
        if (B.kind === 'walk' && !B.crosswalk) continue;
        if (A.prev.length && B.prev.length && A.prev.some((p) => B.prev.includes(p)) && A.next.some((p) => B.next.includes(p))) continue;
        const ca = cum.get(A)!, cb = cum.get(B)!;
        let hit: { s: number; os: number } | null = null;
        for (let p = 0; p < A.pts.length - 1 && !hit; p++) {
          for (let q = 0; q < B.pts.length - 1; q++) {
            const x = segX(A.pts[p], A.pts[p + 1], B.pts[q], B.pts[q + 1]);
            if (!x) continue;
            hit = { s: ca[p] + x.t * (ca[p + 1] - ca[p]), os: cb[q] + x.u * (cb[q + 1] - cb[q]) };
            break;
          }
        }
        const merge = !hit && A.next.length && B.next.length && A.next[0] === B.next[0];
        if (merge) hit = { s: ca[ca.length - 1], os: cb[cb.length - 1] };
        if (!hit) continue;
        (A.conflicts ??= []).push({ lane: B.id, s: hit.s, os: hit.os });
        (B.conflicts ??= []).push({ lane: A.id, s: hit.os, os: hit.s });
      }
    }
    void veh;
  }
}
