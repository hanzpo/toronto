import { CARRIAGE_KINDS, WALK_KINDS, oneway, type Mat } from './assets';
import { legDir, legPt } from './build';
import type { Ctx, LegLane } from './ctx';
import {
  type V2, add, angle, arcPoints, bezier, dist, dot, filletLines, left, lineX, mul, norm, sub, wrap2Pi, wrapPi,
} from './geom';
import type { P3 } from './mesh';
import type { LaneOut, Leg, Node } from './model';

const STRAIGHT = Math.PI - 0.2;
const CURB_H = 0.15;
const PAINT = 0.012;

interface Corner {
  i: number;
  j: number;
  arc: boolean;
  ti: number;
  tj: number;
  c?: V2;
  R?: number;
  P?: V2;
  tPi?: number;
  tPj?: number;
  wrap?: { wa: number; wb: number };
}

interface NodeGeo {
  corners: Corner[];
  cw: number;
  tw: Map<Leg, { left: number; right: number }>;
}

const geo = new WeakMap<Node, NodeGeo>();

const fam = (l: Leg) => l.seg.asset.family;
const isRoad = (l: Leg) => fam(l) === 'road';
const isRail = (l: Leg) => fam(l) === 'rail' || fam(l) === 'subway';
const isTram = (l: Leg) => fam(l) === 'tram';
const isPath = (l: Leg) => fam(l) === 'path' || fam(l) === 'platform';

export function classify(ctx: Ctx, n: Node) {
  const L = n.legs;
  if (L.length === 0) return;
  if (L.length === 1) { n.kind = 'end'; return; }
  const roads = L.filter(isRoad), rails = L.filter(isRail), trams = L.filter(isTram), paths = L.filter(isPath);
  if (roads.length === 0 && paths.length === 0) {
    if (L.length === 2) n.kind = 'continue';
    else if (L.length === 4 && opposite(L[0], L[2]) && opposite(L[1], L[3])) n.kind = 'diamond';
    else n.kind = 'switch';
    return;
  }
  if (roads.length && rails.length) {
    n.kind = 'level_crossing';
    if (rails.some((l) => fam(l) === 'subway')) ctx.review.push({ at: n.p, kind: 'level_crossing_on_subway', note: n.desc.id });
    if (roads.some((l) => l.seg.asset.rank === 0)) ctx.review.push({ at: n.p, kind: 'level_crossing_on_freeway', note: n.desc.id });
    return;
  }
  if (roads.length && trams.length) { n.kind = 'tram_crossing'; return; }
  if (roads.length === 2 && paths.length > 0) { n.kind = 'crosswalk'; return; }
  if (roads.length === 0) {
    n.kind = L.length === 2 && L[0].seg.asset === L[1].seg.asset ? 'continue' : 'path_junction';
    return;
  }
  if (L.length === 2) {
    n.kind = L[0].seg.asset === L[1].seg.asset ? 'continue' : 'transition';
    return;
  }
  const allOne = roads.every((l) => oneway(l.seg.asset));
  let shallow = false;
  for (let i = 0; i < L.length; i++) {
    const d = wrap2Pi(L[(i + 1) % L.length].ang - L[i].ang);
    if (d < 0.6) shallow = true;
  }
  n.kind = allOne && shallow ? 'merge' : 'junction';
  if (n.kind === 'junction' && n.control === 'auto') {
    const ranks = roads.map((l) => l.seg.asset.rank).sort((a, b) => a - b);
    const tram = roads.some((l) => l.seg.lay.some((b) => b.band.lanes?.some((q) => q.track)));
    const major = ranks.filter((r) => r <= 3).length, mid = ranks.filter((r) => r <= 4).length;
    if (ranks[0] === 0) { n.control = 'none'; ctx.review.push({ at: n.p, kind: 'junction_on_freeway', note: n.desc.id }); }
    else if (tram || major >= 3 || (major >= 1 && mid >= 4)) n.control = 'signal';
    else if (ranks[ranks.length - 1] > ranks[0]) n.control = 'stop';
    else n.control = 'allstop';
  }
}

function opposite(a: Leg, b: Leg) {
  return Math.abs(wrapPi(a.ang - b.ang - Math.PI)) < 0.35;
}

function crosswalkWidth(n: Node) {
  return n.control === 'signal' ? 3.5 : 3.0;
}

export function setbacks(ctx: Ctx, n: Node) {
  const L = n.legs;
  for (const l of L) l.cut = null;
  switch (n.kind) {
    case 'end': {
      for (const l of L) { l.setback = 0; l.tStop = 0; l.tExit = 0; l.markEnd = 1; }
      return;
    }
    case 'continue': {
      const [a, b] = L;
      const t = norm(sub(a.u, b.u));
      const d = left(t);
      for (const l of L) { l.cut = { p: n.p, d }; l.setback = 0; l.tStop = 0; l.tExit = 0; l.markEnd = 0; }
      return;
    }
    case 'switch': case 'diamond': {
      for (const l of L) { l.setback = 0; l.tStop = 0; l.tExit = 0; l.markEnd = 0; }
      return;
    }
    case 'level_crossing': case 'tram_crossing': case 'crosswalk': {
      crossingSetbacks(ctx, n);
      return;
    }
    case 'merge': {
      mergeSetbacks(ctx, n);
      return;
    }
    default: boxSetbacks(ctx, n);
  }
}

function boxSetbacks(_ctx: Ctx, n: Node) {
  const L = n.legs;
  const k = L.length;
  const curbed = n.kind === 'junction' || n.kind === 'path_junction';
  const corners: Corner[] = [];
  const t = L.map(() => 0.5);
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const a = L[i], b = L[j];
    const D = wrap2Pi(b.ang - a.ang);
    const pi = add(n.p, mul(a.n, a.curbL)), pj = add(n.p, mul(b.n, b.curbR));
    const c: Corner = { i, j, arc: false, ti: 0, tj: 0 };
    if (curbed && D < STRAIGHT && D > 0.12) {
      const R = Math.max(1, Math.min(a.seg.asset.radius || 1.5, b.seg.asset.radius || 1.5));
      const f = filletLines(pi, a.u, pj, b.u, R, 1, -1);
      if (f && f.tp > -0.01 && f.tq > -0.01) {
        c.arc = true; c.c = f.c; c.R = R; c.ti = Math.max(0, f.tp); c.tj = Math.max(0, f.tq);
      }
    }
    if (!c.arc && D < Math.PI - 0.02) {
      const x = lineX(pi, a.u, pj, b.u);
      if (x && x.t > 0 && x.u > 0) { c.ti = x.t + 0.5; c.tj = x.u + 0.5; }
    }
    if (D < STRAIGHT) {
      const x = lineX(add(n.p, mul(a.n, a.rowL)), a.u, add(n.p, mul(b.n, b.rowR)), b.u);
      if (x && x.t > 0 && x.u > 0) { c.P = add(add(n.p, mul(a.n, a.rowL)), mul(a.u, x.t)); c.tPi = x.t; c.tPj = x.u; }
    }
    if (c.arc && c.R) {
      const wa = Math.abs(a.rowL - a.curbL), wb = Math.abs(b.curbR - b.rowR);
      if (c.R - Math.max(wa, wb) > 0.6) { c.wrap = { wa, wb }; c.P = undefined; c.tPi = undefined; c.tPj = undefined; }
    }
    corners.push(c);
    t[i] = Math.max(t[i], c.ti);
    t[j] = Math.max(t[j], c.tj);
  }
  const cw = n.kind === 'junction' ? crosswalkWidth(n) : 0;
  const tw = new Map<Leg, { left: number; right: number }>();
  for (let i = 0; i < k; i++) {
    const l = L[i];
    l.setback = t[i];
    const hasCw = n.kind === 'junction' && (l.seg.asset.crosswalk !== 'none' || n.control === 'signal' || n.control === 'allstop');
    l.crosswalk = hasCw;
    const cwi = hasCw ? cw : 0;
    l.tExit = t[i] + cwi;
    l.tStop = n.kind === 'junction' && n.control !== 'none' ? l.tExit + 1.6 : l.tExit;
    l.markEnd = l.tStop;
    const cl = corners[i], cr = corners[(i - 1 + k) % k];
    const twl = Math.max(t[i] + cwi, cl.tPi ?? 0), twr = Math.max(t[i] + cwi, cr.tPj ?? 0);
    tw.set(l, { left: twl, right: twr });
    if (n.kind === 'junction') {
      l.bandT = l.bands.map((b) => {
        if (WALK_KINDS.has(b.band.kind)) return b.r >= l.curbL - 0.01 ? twl : twr;
        const grp = raisedGroups(l).find((g) => g.includes(b));
        if (grp) return l.tStop + 0.6 + noseR(grp);
        return t[i];
      });
    }
  }
  geo.set(n, { corners, cw, tw });
}

function crossingSetbacks(_ctx: Ctx, n: Node) {
  const roads = n.legs.filter(isRoad);
  const others = n.legs.filter((l) => !isRoad(l));
  for (const r of roads) {
    let ext = 0;
    for (const o of others) {
      const s = Math.abs(Math.sin(wrapPi(o.ang - r.ang))) || 1;
      const half = (o.rowL - o.rowR) / 2;
      const along = dot(sub(o.o, n.p), r.u);
      ext = Math.max(ext, along + (half + (n.kind === 'crosswalk' ? 0.2 : 0.8)) / Math.max(0.3, s));
    }
    r.setback = Math.max(0.5, ext);
    if (n.kind === 'crosswalk') {
      r.setback = Math.max(1.5, ext);
      r.tExit = r.setback;
      r.tStop = r.setback + 2.0;
    } else {
      r.tExit = r.setback;
      r.tStop = r.setback + 3.0;
    }
    r.markEnd = r.tStop;
  }
  for (const o of others) {
    let ext = 0;
    for (const r of roads) {
      const s = Math.abs(Math.sin(wrapPi(o.ang - r.ang))) || 1;
      const half = Math.max(Math.abs(r.rowL), Math.abs(r.rowR));
      ext = Math.max(ext, (half + 0.05) / Math.max(0.3, s));
    }
    o.setback = ext;
    o.tExit = ext;
    o.tStop = ext + 2;
    o.markEnd = ext;
  }
}

export function buildNode(ctx: Ctx, n: Node) {
  switch (n.kind) {
    case 'junction': case 'path_junction': case 'transition':
      boxNode(ctx, n);
      return;
    case 'merge':
      mergeNode(ctx, n);
      return;
    case 'continue':
      continueNode(ctx, n);
      return;
    case 'end':
      endNode(ctx, n);
      return;
    case 'switch': case 'diamond':
      railNode(ctx, n);
      return;
    case 'level_crossing': case 'tram_crossing': case 'crosswalk':
      crossingNode(ctx, n);
      return;
  }
}

const zAt = (l: Leg, t: number) => legPt(l, t, 0).z;

function nodeZ(n: Node, p: V2): number {
  let ws = 0, zs = 0;
  for (const l of n.legs) {
    const q = legPt(l, l.setback, 0);
    const w = 1 / Math.max(0.5, dist(p, q)) ** 2;
    ws += w; zs += w * q.z;
  }
  return ws ? zs / ws : n.z;
}

function at(l: Leg, t: number, lat: number, dz = 0): P3 {
  const p = legPt(l, t, lat);
  return { x: p.x, y: p.y, z: p.z + dz };
}

function boxNode(ctx: Ctx, n: Node) {
  const g = geo.get(n);
  if (!g) return;
  const L = n.legs;
  const k = L.length;
  const curbed = n.kind === 'junction';
  const roadMat: Mat = n.kind === 'path_junction' ? (L[0].seg.asset.bands[0].mat as Mat) : 'asphalt';
  const ring: P3[] = [];
  const curbPaths: P3[][] = [];
  for (let i = 0; i < k; i++) {
    const a = L[i];
    const c = g.corners[i];
    const b = L[c.j];
    ring.push(at(a, a.setback, a.curbR), at(a, a.setback, a.curbL));
    const path: P3[] = [];
    if (k > 1) {
      const Lb = at(a, a.setback, a.curbL), Rb = at(b, b.setback, b.curbR);
      if (c.arc && c.c && c.R) {
        const Ti = at(a, c.ti, a.curbL), Tj = at(b, c.tj, b.curbR);
        const a0 = angle(sub(Ti, c.c)), a1 = angle(sub(Tj, c.c));
        const arc = arcPoints(c.c, c.R, a0, a1, false, 0.12);
        path.push(Lb);
        if (dist(Lb, Ti) > 0.05) path.push(Ti);
        const zi = Ti.z, zj = Tj.z;
        arc.forEach((p, q) => { if (q > 0 && q < arc.length - 1) path.push({ ...p, z: zi + ((zj - zi) * q) / (arc.length - 1) }); });
        path.push(Tj);
        if (dist(Rb, Tj) > 0.05) path.push(Rb);
      } else {
        path.push(Lb, Rb);
      }
      for (let q = 1; q < path.length - 1; q++) ring.push(path[q]);
    }
    curbPaths.push(path);
  }
  for (const p of ring) p.z = nodeZ(n, p);
  ctx.sink.poly(roadMat, dedupe(ring));
  ctx.footprints.push({ pts: ring.map((p) => ({ ...p })), kind: 'node', slope: 0.5, wall: false });

  for (let i = 0; i < k && k > 1; i++) {
    const a = L[i], c = g.corners[i], b = L[c.j];
    const path = curbPaths[i].map((p) => ({ ...p, z: nodeZ(n, p) }));
    if (!curbed && n.kind !== 'path_junction') {
      transitionWalk(ctx, n, a, b, c);
      continue;
    }
    if (n.kind === 'path_junction') continue;
    const twA = g.tw.get(a)!.left, twB = g.tw.get(b)!.right;
    const walk: P3[] = [];
    const cwA = at(a, twA, a.curbL), cwB = at(b, twB, b.curbR);
    walk.push(cwA, ...path, cwB);
    const rowB = at(b, twB, b.rowR), rowA = at(a, twA, a.rowL);
    const outerPts: P3[] = [rowB];
    if (c.wrap && c.c && c.R) {
      const Ti = legPt(a, c.ti, a.curbL), Tj = legPt(b, c.tj, b.curbR);
      const a0 = angle(sub(Tj, c.c)), a1 = angle(sub(Ti, c.c));
      outerPts.push(at(b, c.tj, b.rowR));
      const arc = arcPoints(c.c, 1, a0, a1, true, 0.12);
      arc.forEach((p, q) => {
        const f = q / (arc.length - 1);
        const r = c.R! - (c.wrap!.wb + (c.wrap!.wa - c.wrap!.wb) * f);
        const d = { x: p.x - c.c!.x, y: p.y - c.c!.y };
        outerPts.push({ x: c.c!.x + d.x * r, y: c.c!.y + d.y * r, z: 0 });
      });
      outerPts.push(at(a, c.ti, a.rowL));
    } else if (c.P && (c.tPj ?? 0) <= twB + 0.01 && (c.tPi ?? 0) <= twA + 0.01) outerPts.push({ ...c.P, z: 0 });
    outerPts.push(rowA);
    walk.push(...outerPts);
    for (const p of walk) p.z = nodeZ(n, p) + CURB_H;
    const ramps = curbRamp(a, b, g, walk);
    ctx.sink.poly('concrete', dedupe(walk));
    ctx.footprints.push({ pts: walk.map((p) => ({ ...p })), kind: 'node', slope: 0.5, wall: false });
    const curbTop = [cwA, ...path, cwB].map((p) => ({ ...p, z: nodeZ(n, p) + CURB_H }));
    for (const p of curbTop) p.z -= ramps(p);
    ctx.sink.wall('curb', curbTop.map((p, q) => ({ ...p, s: q })), (q) => Math.max(0.005, curbTop[q].z - nodeZ(n, curbTop[q])), true);
    const outer = outerPts.map((p) => ({ ...p, z: nodeZ(n, p) + CURB_H }));
    ctx.sink.wall('dirt', outer.map((p, q) => ({ ...p, s: q })), 0.6, true);
  }

  if (curbed) {
    medianNoses(ctx, n);
    junctionMarkings(ctx, n, g);
    junctionLanes(ctx, n, g);
    junctionProps(ctx, n, g);
  } else if (n.kind === 'merge' || n.kind === 'transition') {
    mergeLanes(ctx, n);
  } else if (n.kind === 'path_junction') {
    pathLinks(ctx, n);
  }
}

function curbRamp(a: Leg, b: Leg, g: NodeGeo, walk: P3[]): (p: P3) => number {
  if (!a.crosswalk && !b.crosswalk) return () => 0;
  const spots: { p: V2; r: number }[] = [];
  if (a.crosswalk) spots.push({ p: legPt(a, a.setback + g.cw / 2, a.curbL), r: g.cw / 2 + 0.6 });
  if (b.crosswalk) spots.push({ p: legPt(b, b.setback + g.cw / 2, b.curbR), r: g.cw / 2 + 0.6 });
  const drop = (p: P3) => {
    let d = 0;
    for (const s of spots) {
      const q = dist(p, s.p);
      if (q < s.r) d = Math.max(d, CURB_H - 0.02);
      else if (q < s.r + 1.2) d = Math.max(d, (CURB_H - 0.02) * (1 - (q - s.r) / 1.2));
    }
    return d;
  };
  for (const p of walk) p.z -= drop(p);
  return drop;
}

function transitionWalk(ctx: Ctx, n: Node, a: Leg, b: Leg, c: Corner) {
  void c;
  const aw = a.bands.filter((x) => WALK_KINDS.has(x.band.kind));
  const bw = b.bands.filter((x) => WALK_KINDS.has(x.band.kind));
  if (!aw.length || !bw.length) {
    const lo = [at(a, a.setback, a.curbL), at(b, b.setback, b.curbR)].map((p) => ({ ...p, z: nodeZ(n, p) }));
    ctx.sink.wall('dirt', lo.map((p, q) => ({ ...p, s: q })), a.seg.asset.skirt, true);
    return;
  }
  const quad = [at(a, a.setback, a.curbL), at(b, b.setback, b.curbR), at(b, b.setback, b.rowR), at(a, a.setback, a.rowL)];
  for (const p of quad) p.z = nodeZ(n, p) + CURB_H;
  ctx.sink.poly('concrete', quad);
  const curb = [quad[0], quad[1]].map((p, q) => ({ ...p, s: q }));
  ctx.sink.wall('curb', curb, CURB_H, true);
  ctx.sink.wall('dirt', [quad[2], quad[3]].map((p, q) => ({ ...p, s: q })), 0.6, true);
}

function raisedGroups(l: Leg): Leg['bands'][] {
  const raised = (b: Leg['bands'][number]) => CARRIAGE_KINDS.has(b.band.kind) && (b.hl > 0.05 || b.hr > 0.05);
  const groups: Leg['bands'][] = [];
  for (const b of l.bands) {
    if (!raised(b)) continue;
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[g.length - 1].r - b.l) < 0.01) g.push(b); else groups.push([b]);
  }
  return groups;
}

function noseR(grp: Leg['bands']) {
  return Math.min(1.2, (grp[0].l - grp[grp.length - 1].r) / 2);
}

function medianNoses(ctx: Ctx, n: Node) {
  for (const l of n.legs) {
    for (const grp of raisedGroups(l)) {
      const L0 = grp[0].l, R0 = grp[grp.length - 1].r;
      const w = L0 - R0;
      const rr = noseR(grp);
      void w;
      const t0 = l.setback, t1 = l.tStop + 0.6, tc = t1 + rr;
      if (t1 <= t0) continue;
      ctx.sink.poly('asphalt', [at(l, t0, R0), at(l, tc, R0), at(l, tc, L0), at(l, t0, L0)]);
      for (const b of grp) {
        const cap: P3[] = [];
        const corner = (cx: number, from: number, to: number) => {
          for (let q = 0; q <= 6; q++) {
            const th = from + ((to - from) * q) / 6;
            cap.push(at(l, tc - Math.sin(th) * rr, cx + Math.cos(th) * rr, b.hl));
          }
        };
        const left = Math.abs(b.l - L0) < 0.01, right = Math.abs(b.r - R0) < 0.01;
        if (right) corner(b.r + rr, Math.PI, Math.PI / 2); else cap.push(at(l, tc, b.r, b.hl));
        if (left) corner(b.l - rr, Math.PI / 2, 0); else cap.push(at(l, tc, b.l, b.hl));
        cap.unshift(at(l, tc, b.r, b.hl));
        cap.push(at(l, tc, b.l, b.hl));
        ctx.sink.poly(b.band.mat as Mat, dedupe(cap));
        const edge = cap.slice(1, cap.length - 1);
        if (edge.length > 1) ctx.sink.wall('curb', edge.map((p, q) => ({ ...p, s: q })), b.hl, true);
      }
    }
  }
}

function junctionMarkings(ctx: Ctx, n: Node, g: NodeGeo) {
  for (const l of n.legs) {
    const inbound = (ctx.legLanes.get(l) ?? []).filter((q) => q.inbound && q.lane.kind === 'drive');
    if (l.crosswalk) {
      const style = l.seg.asset.crosswalk === 'zebra' || n.control === 'signal' ? 'zebra' : 'lines';
      const t0 = l.setback, t1 = l.setback + g.cw;
      if (style === 'zebra') {
        const w = l.curbL - l.curbR;
        const bars = Math.floor((w - 0.6) / 1.2);
        const off = (w - bars * 1.2 + 0.6) / 2;
        for (let q = 0; q < bars; q++) {
          const lat = l.curbR + off + q * 1.2;
          const r = [at(l, t0 + 0.15, lat, PAINT), at(l, t1 - 0.15, lat, PAINT)];
          const lf = [at(l, t0 + 0.15, lat + 0.6, PAINT), at(l, t1 - 0.15, lat + 0.6, PAINT)];
          ctx.sink.strip('paint_white', r, lf, 0, 1);
        }
      } else {
        for (const t of [t0 + 0.1, t1 - 0.25]) {
          const r = [at(l, t, l.curbR, PAINT), at(l, t, l.curbL, PAINT)];
          const lf = [at(l, t + 0.15, l.curbR, PAINT), at(l, t + 0.15, l.curbL, PAINT)];
          ctx.sink.strip('paint_white', lf, r, 0, 1);
        }
      }
    }
    if (n.control !== 'none' && inbound.length) {
      const lats = inbound.map((q) => q.lat);
      const ws = inbound.map((q) => q.w);
      const hi = Math.max(...lats.map((v, q) => v + ws[q] / 2)), lo = Math.min(...lats.map((v, q) => v - ws[q] / 2));
      const t = l.tStop - 0.6;
      const bar = n.control === 'signal' ? 0.45 : 0.6;
      const r = [at(l, t, lo + 0.15, PAINT), at(l, t, hi - 0.1, PAINT)];
      const lf = [at(l, t + bar, lo + 0.15, PAINT), at(l, t + bar, hi - 0.1, PAINT)];
      ctx.sink.strip('paint_white', lf, r, 0, 1);
    }
  }
}

function movement(a: Leg, b: Leg) {
  return wrapPi(b.ang - (a.ang + Math.PI));
}

function curve(p0: P3, d0: V2, p3: P3, d3: V2, kind: 'through' | 'turn'): P3[] {
  const ch = dist(p0, p3);
  const th = Math.abs(wrapPi(angle(d3) - angle(d0)));
  let k0 = ch * (kind === 'through' ? 0.33 : 0.39), k3 = k0;
  if (kind === 'turn' && th > 0.3) {
    const x = lineX(p0, d0, p3, mul(d3, -1));
    if (x && x.t > 0 && x.u > 0) {
      const f = (4 / 3) * Math.tan(th / 4) / Math.max(1e-3, Math.tan(th / 2));
      k0 = Math.min(x.t * Math.max(0.55, f * 1.0), ch);
      k3 = Math.min(x.u * Math.max(0.55, f * 1.0), ch);
      const r = Math.min(x.t, x.u);
      const extra0 = x.t - r, extra3 = x.u - r;
      if (extra0 > 0.5 || extra3 > 0.5) {
        const q0 = add(p0, mul(d0, extra0)), q3 = sub(p3, mul(d3, extra3));
        const kk = r * (4 / 3) * Math.tan(th / 4);
        const out: P3[] = [];
        if (extra0 > 0.5) out.push(p0);
        const z0 = p0.z, z3 = p3.z;
        const N = Math.max(8, Math.ceil(r * th / 0.6));
        for (let i = 0; i <= N; i++) {
          const q = bezier(q0, add(q0, mul(d0, kk)), sub(q3, mul(d3, kk)), q3, i / N);
          out.push({ ...q, z: z0 + (z3 - z0) * ((extra0 + (r * th * i) / N) / (extra0 + r * th + extra3)) });
        }
        if (extra3 > 0.5) out.push(p3);
        return out;
      }
    }
  }
  const p1 = add(p0, mul(d0, k0)), p2 = sub(p3, mul(d3, k3));
  const N = Math.max(6, Math.ceil(ch / 0.8));
  const out: P3[] = [];
  for (let i = 0; i <= N; i++) {
    const q = bezier(p0, p1, p2, p3, i / N);
    out.push({ ...q, z: p0.z + (p3.z - p0.z) * (i / N) });
  }
  return out;
}

function laneEnd(l: LegLane): P3 {
  const p = l.inbound ? l.lane.pts[l.lane.pts.length - 1] : l.lane.pts[0];
  return { ...p };
}

function junctionLanes(ctx: Ctx, n: Node, g: NodeGeo) {
  const L = n.legs;
  const groups: number[] = groupAxes(n);
  const plan = n.control === 'signal' ? { node: n.desc.id, groups: [] as { lanes: number[]; peds: number[] }[], green: 24, amber: 3.5, allRed: 2 } : null;
  const nG = Math.max(...groups) + 1;
  if (plan) for (let q = 0; q < nG; q++) plan.groups.push({ lanes: [], peds: [] });
  const tramMoves = new Set((n.desc.tram ?? []).map(([a, b]) => `${a}>${b}`));
  for (let i = 0; i < L.length; i++) {
    const a = L[i];
    const ins = (ctx.legLanes.get(a) ?? []).filter((q) => q.inbound && q.lane.kind === 'drive').sort((p, q) => q.lat - p.lat);
    const tramIns = (ctx.legLanes.get(a) ?? []).filter((q) => q.inbound && q.def.track && (q.lane.kind === 'tram' || q.lane.cls.includes('tram')));
    for (let j = 0; j < L.length; j++) {
      if (i === j) continue;
      const b = L[j];
      const phi = movement(a, b);
      const kind = Math.abs(phi) < 0.55 ? 'through' : phi < 0 && phi > -2.6 ? 'right' : phi > 0 && phi < 2.6 ? 'left' : 'u';
      if (kind === 'u') continue;
      const outs = (ctx.legLanes.get(b) ?? []).filter((q) => !q.inbound && q.lane.kind === 'drive').sort((p, q) => p.lat - q.lat);
      if (ins.length && outs.length) {
        const pairs: [LegLane, LegLane][] = [];
        if (kind === 'through') ins.forEach((e, q) => pairs.push([e, outs[Math.min(q, outs.length - 1)]]));
        else if (kind === 'right') pairs.push([ins[0], outs[0]]);
        else pairs.push([ins[ins.length - 1], outs[outs.length - 1]]);
        for (const [e, x] of pairs) {
          const pts = curve(laneEnd(e), mul(a.u, -1), laneEnd(x), b.u, kind === 'through' ? 'through' : 'turn');
          const cls = e.lane.cls.filter((c) => c !== 'tram' && x.lane.cls.includes(c));
          const lane = ctx.lane({ kind: 'drive', cls, pts, width: Math.min(e.w, x.w), speed: kind === 'through' ? e.lane.speed : Math.min(e.lane.speed, 6), node: n.desc.id, bidir: false });
          (lane as LaneOut & { turn?: string }).turn = kind;
          ctx.link(e.lane, lane);
          ctx.link(lane, x.lane);
          if (plan) { plan.groups[groups[i]].lanes.push(lane.id); lane.signal = { node: n.desc.id, group: groups[i] }; }
        }
      }
      for (const e of tramIns) {
        const ok = kind === 'through' ? !n.desc.tram || tramMoves.has(`${a.seg.desc.id}>${b.seg.desc.id}`) : tramMoves.has(`${a.seg.desc.id}>${b.seg.desc.id}`);
        if (!ok) continue;
        const touts = (ctx.legLanes.get(b) ?? []).filter((q) => !q.inbound && q.def.track);
        if (!touts.length) continue;
        const x = touts.reduce((best, q) => (kind === 'right' ? q.lat < best.lat : kind === 'left' ? q.lat > best.lat : Math.abs(q.lat + e.lat) < Math.abs(best.lat + e.lat)) ? q : best);
        const pts = curve(trackEnd(ctx, e, a), mul(a.u, -1), trackEnd(ctx, x, b), b.u, kind === 'through' ? 'through' : 'turn');
        const lane = ctx.lane({ kind: 'tram', cls: ['tram'], pts, width: 2.6, speed: kind === 'through' ? 8 : 4, node: n.desc.id, bidir: false, track: 'embedded', gauge: e.lane.gauge });
        const ee = laneEnd(e), xx = laneEnd(x);
        lane.pts = [ee, ...pts.filter((p) => dist(p, ee) > 0.3 && dist(p, xx) > 0.3), xx];
        ctx.link(e.lane, lane);
        ctx.link(lane, x.lane);
        ctx.tracks.push({ kind: 'embedded', gauge: e.lane.gauge ?? 1.495, pts: pts.map((p) => ({ ...p, z: nodeZ(n, p) + 0.004 })), lane: lane.id, flush: true });
        if (plan) { plan.groups[groups[i]].lanes.push(lane.id); lane.signal = { node: n.desc.id, group: groups[i] }; }
      }
    }
  }
  pedLinks(ctx, n, g, groups, plan);
  if (plan) ctx.signals.push(plan);
  if (n.control === 'stop' || n.control === 'allstop') {
    const top = Math.min(...L.map((l) => l.seg.asset.rank));
    for (const l of L) {
      const stop = n.control === 'allstop' || l.seg.asset.rank > top;
      for (const q of ctx.legLanes.get(l) ?? []) if (q.inbound && q.lane.kind === 'drive') (q.lane as LaneOut & { stopSign?: boolean }).stopSign = stop;
    }
  }
}

function trackEnd(_ctx: Ctx, q: LegLane, l: Leg): P3 {
  const p = legPt(l, l.setback, q.lat);
  return { x: p.x, y: p.y, z: p.z };
}

function groupAxes(n: Node): number[] {
  const L = n.legs;
  const g = L.map(() => -1);
  let next = 0;
  for (let i = 0; i < L.length; i++) {
    if (g[i] >= 0) continue;
    g[i] = next;
    let best = -1, bd = 0.6;
    for (let j = 0; j < L.length; j++) {
      if (j === i || g[j] >= 0) continue;
      const d = Math.abs(wrapPi(L[i].ang - L[j].ang - Math.PI));
      if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0) g[best] = next;
    next++;
  }
  return g;
}

function pedLinks(ctx: Ctx, n: Node, g: NodeGeo, groups: number[], plan: { groups: { peds: number[] }[] } | null) {
  const L = n.legs;
  const k = L.length;
  const walkOf = (l: Leg, side: 'left' | 'right') => {
    const ws = (ctx.legLanes.get(l) ?? []).filter((q) => q.lane.kind === 'walk');
    if (!ws.length) return null;
    return ws.reduce((b, q) => (side === 'left' ? (q.lat > b.lat ? q : b) : (q.lat < b.lat ? q : b)));
  };
  const corner: (LaneOut | null)[] = [];
  for (let i = 0; i < k; i++) {
    const a = L[i], c = g.corners[i], b = L[c.j];
    const wa = walkOf(a, 'left'), wb = walkOf(b, 'right');
    const pa = at(a, g.tw.get(a)!.left, wa ? wa.lat : (a.curbL + a.rowL) / 2, CURB_H);
    const pb = at(b, g.tw.get(b)!.right, wb ? wb.lat : (b.curbR + b.rowR) / 2, CURB_H);
    const mid = c.c && c.R ? add(c.c, mul(norm(sub(mul(add(pa, pb), 0.5), c.c)), Math.max(0.5, c.R - 1.6))) : mul(add(pa, pb), 0.5);
    const pts = [pa, { ...mid, z: nodeZ(n, mid) + CURB_H }, pb];
    const lane = ctx.lane({ kind: 'walk', cls: ['ped'], pts, width: 2, speed: 1.3, node: n.desc.id, bidir: true });
    if (wa) ctx.link(wa.lane, lane);
    if (wb) ctx.link(lane, wb.lane);
    corner.push(lane);
  }
  for (let i = 0; i < k; i++) {
    const l = L[i];
    if (!l.crosswalk) continue;
    const t = l.setback + g.cw / 2;
    const r = at(l, t, l.curbR - 0.3, CURB_H - 0.13), lf = at(l, t, l.curbL + 0.3, CURB_H - 0.13);
    const lane = ctx.lane({ kind: 'walk', cls: ['ped'], pts: [r, lf], width: g.cw, speed: 1.3, node: n.desc.id, bidir: true, crosswalk: true });
    const cl = corner[i], cr = corner[(i - 1 + k) % k];
    if (cr) ctx.link(cr, lane);
    if (cl) ctx.link(lane, cl);
    if (plan) {
      for (let q = 0; q < plan.groups.length; q++) if (q !== groups[i]) plan.groups[q].peds.push(lane.id);
      lane.signal = { node: n.desc.id, group: -1 };
    }
  }
}

function junctionProps(ctx: Ctx, n: Node, g: NodeGeo) {
  const L = n.legs;
  const k = L.length;
  if (n.control === 'signal') {
    const groups = groupAxes(n);
    for (let i = 0; i < k; i++) {
      const a = L[i], c = g.corners[i], b = L[c.j];
      let p: V2;
      if (c.arc && c.c && c.R) {
        const Ti = legPt(a, c.ti, a.curbL), Tj = legPt(b, c.tj, b.curbR);
        const m = norm(sub(mul(add(Ti, Tj), 0.5), c.c));
        p = add(c.c, mul(m, Math.max(0.3, c.R - 0.8)));
      } else {
        p = legPt(b, b.setback + g.cw + 1.0, b.curbR - 0.8);
      }
      const reach = Math.max(0, Math.min(10, -b.curbR - 1.2));
      const opp = L.findIndex((x) => Math.abs(wrapPi(x.ang - b.ang - Math.PI)) < 0.6);
      ctx.prop('signal_pole', { ...p, z: nodeZ(n, p) + CURB_H }, b.ang + Math.PI, {
        arm: reach, armDir: b.ang + Math.PI / 2, group: opp >= 0 ? groups[opp] : groups[c.j], node: ctx.nodes.indexOf(n),
        side: a.ang + Math.PI, sideGroup: groups[i],
      });
    }
  } else if (n.control === 'stop' || n.control === 'allstop') {
    const top = Math.min(...L.map((l) => l.seg.asset.rank));
    for (const l of L) {
      if (n.control === 'stop' && l.seg.asset.rank <= top) continue;
      const p = legPt(l, l.tStop + 0.3, l.curbL + 0.6);
      ctx.prop('stop_sign', { ...p, z: zAt(l, l.tStop) + CURB_H }, l.ang, { allway: n.control === 'allstop' ? 1 : 0 });
    }
  }
}

function mergeLanes(ctx: Ctx, n: Node) {
  const ins: { l: LegLane; leg: Leg; key: number }[] = [];
  const outs: { l: LegLane; leg: Leg; key: number }[] = [];
  const ref = n.legs[0];
  const tref = norm(ref.u);
  for (const leg of n.legs) {
    for (const q of ctx.legLanes.get(leg) ?? []) {
      if (q.lane.kind !== 'drive') continue;
      const p = laneEnd(q);
      const key = -dot(sub(p, n.p), left(tref)) * (dot(leg.u, tref) > 0 ? 1 : 1);
      (q.inbound ? ins : outs).push({ l: q, leg, key });
    }
  }
  const pairDir = (A: typeof ins, B: typeof outs) => {
    if (!A.length || !B.length) return;
    const ia = [...A].sort((p, q) => p.key - q.key), ob = [...B].sort((p, q) => p.key - q.key);
    const travel = norm(sub(laneEnd(ob[0].l), laneEnd(ia[0].l)));
    const sgn = dot(left(travel), left(tref)) >= 0 ? 1 : -1;
    const A2 = sgn > 0 ? ia : [...ia].reverse(), B2 = sgn > 0 ? ob : [...ob].reverse();
    for (let q = 0; q < A2.length; q++) {
      const e = A2[q];
      const x = B2[Math.min(B2.length - 1, Math.round((q * (B2.length - 1)) / Math.max(1, A2.length - 1)))];
      const targets = A2.length < B2.length && q === A2.length - 1 ? B2.slice(q) : [x];
      for (const t of targets) {
        const pts = curve(laneEnd(e.l), mul(e.leg.u, -1), laneEnd(t.l), t.leg.u, 'through');
        const lane = ctx.lane({ kind: 'drive', cls: e.l.lane.cls, pts, width: e.l.w, speed: e.l.lane.speed, node: n.desc.id, bidir: false });
        ctx.link(e.l.lane, lane);
        ctx.link(lane, t.l.lane);
      }
    }
  };
  const fwdIns = ins.filter((q) => dot(q.leg.u, tref) < 0 || n.legs.length === 2);
  void fwdIns;
  const byTravel = new Map<string, { A: typeof ins; B: typeof outs }>();
  for (const e of ins) {
    const tv = mul(e.leg.u, -1);
    const k = dot(tv, tref) > 0 ? 'p' : 'n';
    if (!byTravel.has(k)) byTravel.set(k, { A: [], B: [] });
    byTravel.get(k)!.A.push(e);
  }
  for (const x of outs) {
    const k = dot(x.leg.u, tref) > 0 ? 'p' : 'n';
    if (!byTravel.has(k)) byTravel.set(k, { A: [], B: [] });
    byTravel.get(k)!.B.push(x);
  }
  for (const { A, B } of byTravel.values()) pairDir(A, B);
  if (n.kind === 'merge') gore(ctx, n);
  walkThrough(ctx, n);
}

function gore(ctx: Ctx, n: Node) {
  const g = geo.get(n);
  if (!g) return;
  for (const c of g.corners) {
    if (c.arc) continue;
    const a = n.legs[c.i], b = n.legs[c.j];
    const D = wrap2Pi(b.ang - a.ang);
    if (D > 0.6) continue;
    const pa = legPt(a, a.setback, a.curbL), pb = legPt(b, b.setback, b.curbR);
    const x = lineX(pa, mul(a.u, -1), pb, mul(b.u, -1));
    const tip = x && x.t > 0 ? add(pa, mul(a.u, -x.t)) : mul(add(pa, pb), 0.5);
    const z = nodeZ(n, tip) + PAINT;
    const tri = [{ ...pa, z: zAt(a, a.setback) + PAINT }, { ...pb, z: zAt(b, b.setback) + PAINT }, { ...tip, z }];
    const inset = (p: P3, q: P3) => ({ ...lerp3(p, q, 0.06) });
    const edgeW = 0.2;
    const A1 = tri[0], B1 = tri[1], T = tri[2];
    for (const [p, q] of [[A1, T], [B1, T]] as const) {
      const d = norm(sub(q, p));
      const nn = mul(left(d), edgeW / 2);
      ctx.sink.quad('paint_white', { ...add(p, nn), z: p.z }, { ...sub(p, nn), z: p.z }, { ...sub(q, nn), z: q.z }, { ...add(q, nn), z: q.z });
    }
    const len = dist(mul(add(A1, B1), 0.5), T);
    for (let t = 4; t < len - 2; t += 6) {
      const f = t / len;
      const l1 = lerp3(T, A1, 1 - f), r1 = lerp3(T, B1, 1 - f);
      const d = norm(sub(r1, l1));
      void inset;
      const l2 = add(l1, mul(norm(sub(T, l1)), 1.2)), r2 = add(r1, mul(norm(sub(T, r1)), 1.2));
      void d;
      ctx.sink.quad('paint_white', { ...l1, z }, { ...r1, z }, { ...r2, z }, { ...l2, z });
    }
  }
}

function lerp3(a: P3, b: P3, t: number): P3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function walkThrough(ctx: Ctx, n: Node) {
  const ws: { q: LegLane; leg: Leg }[] = [];
  for (const leg of n.legs) for (const q of ctx.legLanes.get(leg) ?? []) if (q.lane.kind === 'walk') ws.push({ q, leg });
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      if (ws[i].leg === ws[j].leg) continue;
      const pi = laneEnd(ws[i].q), pj = laneEnd(ws[j].q);
      const ei = ws[i].q.lane.pts, ej = ws[j].q.lane.pts;
      const di = Math.min(dist(ei[0], n.p), dist(ei[ei.length - 1], n.p));
      void di;
      const ai = dist(ei[0], pj) < dist(ei[ei.length - 1], pj) ? ei[0] : ei[ei.length - 1];
      const aj = dist(ej[0], pi) < dist(ej[ej.length - 1], pi) ? ej[0] : ej[ej.length - 1];
      if (dist(ai, aj) < 6) {
        const lane = ctx.lane({ kind: 'walk', cls: ['ped'], pts: [{ ...ai }, { ...aj }], width: 2, speed: 1.3, node: n.desc.id, bidir: true });
        ctx.link(ws[i].q.lane, lane);
        ctx.link(lane, ws[j].q.lane);
      }
    }
  }
}

function pathLinks(ctx: Ctx, n: Node) {
  const ends: { q: LegLane; p: P3 }[] = [];
  for (const leg of n.legs) for (const q of ctx.legLanes.get(leg) ?? []) {
    if (q.lane.kind !== 'walk') continue;
    const pts = q.lane.pts;
    const p = dist(pts[0], n.p) < dist(pts[pts.length - 1], n.p) ? pts[0] : pts[pts.length - 1];
    ends.push({ q, p });
  }
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
    const lane = ctx.lane({ kind: 'walk', cls: ['ped', 'bike'], pts: [ends[i].p, { ...n.p, z: nodeZ(n, n.p) }, ends[j].p], width: 2, speed: 1.3, node: n.desc.id, bidir: true });
    ctx.link(ends[i].q.lane, lane);
    ctx.link(lane, ends[j].q.lane);
  }
}

function continueNode(ctx: Ctx, n: Node) {
  const [a, b] = n.legs;
  const la = ctx.legLanes.get(a) ?? [], lb = ctx.legLanes.get(b) ?? [];
  for (const q of la) {
    const cands = lb.filter((r) => r.lane.kind === q.lane.kind && (q.lane.bidir ? true : r.inbound !== q.inbound));
    if (!cands.length) continue;
    const r = cands.reduce((best, c) => (Math.abs(c.lat + q.lat) < Math.abs(best.lat + q.lat) ? c : best));
    if (Math.abs(r.lat + q.lat) > 1.5) continue;
    if (q.lane.bidir || q.lane.kind === 'walk') {
      if (!q.lane.next.includes(r.lane.id) && !r.lane.next.includes(q.lane.id)) ctx.link(q.lane, r.lane);
    } else if (q.inbound) ctx.link(q.lane, r.lane);
  }
}

function endNode(ctx: Ctx, n: Node) {
  const l = n.legs[0];
  if (isRail(l) || isTram(l)) {
    const p = legPt(l, 1.0, 0);
    ctx.prop('buffer_stop', { ...p, z: p.z }, l.ang + Math.PI);
    return;
  }
  const lay = l.bands;
  const sink = ctx.sink;
  for (const b of lay) {
    const r = at(l, l.setback, b.r, b.hr), lf = at(l, l.setback, b.l, b.hl);
    const d = l.seg.asset.skirt;
    sink.wallBetween('dirt', [lf, r], [{ ...lf, z: lf.z - d }, { ...r, z: r.z - d }], true);
  }
  for (const q of ctx.legLanes.get(l) ?? []) {
    if (q.lane.kind !== 'drive' || !q.inbound) continue;
    const outs = (ctx.legLanes.get(l) ?? []).filter((r) => !r.inbound && r.lane.kind === 'drive');
    if (!outs.length) continue;
    const x = outs.reduce((b, r) => (Math.abs(r.lat - q.lat) < Math.abs(b.lat - q.lat) ? r : b));
    const p0 = laneEnd(q), p3 = laneEnd(x);
    const mid = add(legPt(l, Math.max(0, l.setback - 0.5), (q.lat + x.lat) / 2), { x: 0, y: 0 });
    const pts = [p0, { ...mid, z: p0.z }, p3];
    const lane = ctx.lane({ kind: 'drive', cls: q.lane.cls, pts, width: 3, speed: 2, node: n.desc.id, bidir: false });
    ctx.link(q.lane, lane);
    ctx.link(lane, x.lane);
  }
}

function railNode(ctx: Ctx, n: Node) {
  const L = n.legs;
  const lanesOf = (l: Leg) => (ctx.legLanes.get(l) ?? []).filter((q) => q.lane.kind === 'rail' || q.lane.kind === 'tram');
  const allowed = new Set((n.desc.rail ?? []).map(([a, b]) => `${a}|${b}`));
  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j];
      const straightish = Math.abs(wrapPi(a.ang - b.ang - Math.PI)) < 0.45;
      if (!straightish) continue;
      if (n.desc.rail && !allowed.has(`${a.seg.desc.id}|${b.seg.desc.id}`) && !allowed.has(`${b.seg.desc.id}|${a.seg.desc.id}`)) continue;
      for (const qa of lanesOf(a)) for (const qb of lanesOf(b)) {
        if (qa.lane.bidir || qb.lane.bidir) { ctx.link(qa.lane, qb.lane); ctx.link(qb.lane, qa.lane); }
        else if (qa.inbound && !qb.inbound) ctx.link(qa.lane, qb.lane);
        else if (qb.inbound && !qa.inbound) ctx.link(qb.lane, qa.lane);
      }
    }
  }
  if (n.kind === 'switch' && L.length === 3) {
    let trunk = L[0], best = -1;
    for (const l of L) {
      const others = L.filter((o) => o !== l);
      const sc = Math.min(...others.map((o) => Math.abs(wrapPi(o.ang - l.ang))));
      if (sc > best) { best = sc; trunk = l; }
    }
    const branches = L.filter((o) => o !== trunk);
    const side = wrapPi(branches[0].ang - branches[1].ang) > 0 ? 1 : -1;
    void side;
    const div = branches.reduce((p, q) => (Math.abs(wrapPi(p.ang - trunk.ang - Math.PI)) > Math.abs(wrapPi(q.ang - trunk.ang - Math.PI)) ? p : q));
    const s = wrapPi(div.ang - (trunk.ang + Math.PI)) > 0 ? 1 : -1;
    const p = legPt(div, 3, 0);
    const q = legPt(trunk, 0.5, -s * 2.2);
    void p;
    ctx.prop('switch_machine', { ...q, z: q.z - 0.35 }, trunk.ang);
    const lanes = lanesOf(trunk);
    for (const l of lanes) (l.lane as LaneOut & { switchAt?: string }).switchAt = n.desc.id;
  }
}

function crossingNode(ctx: Ctx, n: Node) {
  const roads = n.legs.filter(isRoad);
  const others = n.legs.filter((l) => !isRoad(l));
  if (roads.length !== 2) { ctx.review.push({ at: n.p, kind: 'crossing_road_legs', note: `${n.desc.id}: ${roads.length} road legs` }); }
  const [r1, r2] = roads;
  if (r1 && r2) {
    const zz = (p: P3) => ({ ...p, z: n.z });
    const B1 = r1.bands, B2 = r2.bands;
    const same = B1.length === B2.length;
    for (let q = 0; q < B1.length; q++) {
      const b1 = B1[q];
      const b2 = same ? B2[B2.length - 1 - q] : null;
      const a0 = zz(at(r1, r1.setback, b1.r)), a1 = zz(at(r1, r1.setback, b1.l));
      const c0 = b2 ? zz(at(r2, r2.setback, b2.l)) : zz(at(r2, r2.setback, -b1.r));
      const c1 = b2 ? zz(at(r2, r2.setback, b2.r)) : zz(at(r2, r2.setback, -b1.l));
      const h0 = b1.hr, h1 = b1.hl;
      let mat = b1.band.mat as Mat;
      if (b1.band.kind === 'boulevard' || b1.band.kind === 'furniture' || b1.band.kind === 'verge') mat = 'concrete';
      if (b1.band.kind === 'median' || b1.band.kind === 'row_edge' || b1.band.kind === 'barrier') mat = 'asphalt';
      const lift = (p: P3, h: number) => ({ ...p, z: p.z + (CARRIAGE_KINDS.has(b1.band.kind) ? 0 : Math.max(0, h)) });
      const quad = [lift(a0, h0), lift(c0, h0), lift(c1, h1), lift(a1, h1)];
      ctx.sink.poly(mat, quad);
      if (q < B1.length - 1) {
        const nb = B1[q + 1];
        const dh = (CARRIAGE_KINDS.has(b1.band.kind) ? 0 : b1.hr) - (CARRIAGE_KINDS.has(nb.band.kind) ? 0 : nb.hl);
        if (Math.abs(dh) > 0.01) {
          const top = [lift(a0, h0), lift(c0, h0)].map((p, i) => ({ ...p, s: i }));
          ctx.sink.wall('curb', top, Math.abs(dh), dh > 0);
        }
      }
    }
    const o1 = [zz(at(r1, r1.setback, B1[0].l)), zz(at(r2, r2.setback, -B1[0].l))].map((p) => ({ ...p, z: p.z + Math.max(0, B1[0].hl) }));
    const o2 = [zz(at(r1, r1.setback, B1[B1.length - 1].r)), zz(at(r2, r2.setback, -B1[B1.length - 1].r))].map((p) => ({ ...p, z: p.z + Math.max(0, B1[B1.length - 1].hr) }));
    ctx.sink.wall('dirt', o1.map((p, i) => ({ ...p, s: i })), r1.seg.asset.skirt, false);
    ctx.sink.wall('dirt', o2.map((p, i) => ({ ...p, s: i })), r1.seg.asset.skirt, true);
    ctx.footprints.push({ pts: [at(r1, r1.setback, r1.rowR), at(r2, r2.setback, -r1.rowR), at(r2, r2.setback, -r1.rowL), at(r1, r1.setback, r1.rowL)].map(zz), kind: 'node', slope: 0.5, wall: false });

    for (const [ri, ro] of [[r1, r2], [r2, r1]] as const) {
      const ins = (ctx.legLanes.get(ri) ?? []).filter((q) => q.inbound && q.lane.kind === 'drive');
      const outs = (ctx.legLanes.get(ro) ?? []).filter((q) => !q.inbound && q.lane.kind === 'drive');
      for (const e of ins) {
        if (!outs.length) break;
        const x = outs.reduce((b, q) => (Math.abs(q.lat + e.lat) < Math.abs(b.lat + e.lat) ? q : b));
        const lane = ctx.lane({ kind: 'drive', cls: e.lane.cls, pts: [laneEnd(e), laneEnd(x)], width: e.w, speed: e.lane.speed, node: n.desc.id, bidir: false });
        lane.signal = { node: n.desc.id, group: 0 };
        ctx.link(e.lane, lane);
        ctx.link(lane, x.lane);
      }
      if (ins.length) {
        const hi = Math.max(...ins.map((q) => q.lat + q.w / 2)), lo = Math.min(...ins.map((q) => q.lat - q.w / 2));
        const t = ri.tStop - 0.6;
        if (n.kind !== 'crosswalk' || true) {
          const r = [zz(at(ri, t, lo + 0.15)), zz(at(ri, t, hi - 0.1))].map((p) => ({ ...p, z: zAt(ri, t) + PAINT }));
          const lf = [zz(at(ri, t + 0.45, lo + 0.15)), zz(at(ri, t + 0.45, hi - 0.1))].map((p) => ({ ...p, z: zAt(ri, t + 0.45) + PAINT }));
          ctx.sink.strip('paint_white', lf, r, 0, 1);
        }
        if (n.kind === 'level_crossing') {
          const p = legPt(ri, ri.setback + 0.6, ri.curbL + 0.7);
          ctx.prop('gate', { ...p, z: n.z + 0.15 }, ri.ang, { arm: Math.max(2.5, ri.curbL + 0.4), armDir: ri.ang - Math.PI / 2, node: ctx.nodes.indexOf(n) });
          const xing = legPt(ri, ri.tStop + 6, ri.curbL + 0.8);
          ctx.prop('crossbuck', { ...xing, z: zAt(ri, ri.tStop + 6) + 0.15 }, ri.ang, {});
        } else if (n.kind === 'tram_crossing') {
          const p = legPt(ri, ri.setback + 0.5, ri.curbL + 0.7);
          ctx.prop('signal_pole', { ...p, z: n.z + 0.15 }, ri.ang, { arm: Math.max(0, ri.curbL - 0.8), armDir: ri.ang - Math.PI / 2, node: ctx.nodes.indexOf(n), group: 0 });
        }
      }
    }
    const walksA = (ctx.legLanes.get(r1) ?? []).filter((q) => q.lane.kind === 'walk');
    const walksB = (ctx.legLanes.get(r2) ?? []).filter((q) => q.lane.kind === 'walk');
    for (const q of walksA) {
      const m = walksB.find((w) => Math.abs(w.lat + q.lat) < 1);
      if (!m) continue;
      const lane = ctx.lane({ kind: 'walk', cls: ['ped'], pts: [laneEnd(q), laneEnd(m)], width: 1.8, speed: 1.3, node: n.desc.id, bidir: true });
      ctx.link(q.lane, lane);
      ctx.link(lane, m.lane);
    }
  }

  const used = new Set<Leg>();
  for (const a of others) {
    if (used.has(a)) continue;
    const b = others.find((o) => o !== a && !used.has(o) && fam(o) === fam(a) && Math.abs(wrapPi(o.ang - a.ang - Math.PI)) < 0.4 && Math.abs(dot(sub(o.o, a.o), left(a.u))) < 0.8);
    if (!b) continue;
    used.add(a); used.add(b);
    const pa = legPt(a, a.setback, 0), pb = legPt(b, b.setback, 0);
    const za = n.z, zb = n.z;
    if (n.kind === 'crosswalk') {
      if (r1) {
        const pw = Math.max(2.4, a.rowL - a.rowR) + 0.6;
        const w = r1.curbL - r1.curbR;
        const bars = Math.floor((w - 0.6) / 1.2);
        const off = (w - bars * 1.2 + 0.6) / 2;
        const tc = dot(sub(n.p, r1.o), r1.u);
        for (let q = 0; q < bars; q++) {
          const lat = r1.curbR + off + q * 1.2;
          const r = [at(r1, tc - pw / 2, lat, PAINT), at(r1, tc + pw / 2, lat, PAINT)].map((p) => ({ ...p, z: n.z + PAINT }));
          const lf = [at(r1, tc - pw / 2, lat + 0.6, PAINT), at(r1, tc + pw / 2, lat + 0.6, PAINT)].map((p) => ({ ...p, z: n.z + PAINT }));
          ctx.sink.strip('paint_white', r, lf, 0, 1);
        }
        void pa; void pb; void za; void zb;
      }
      const wa = (ctx.legLanes.get(a) ?? []).filter((q) => q.lane.kind === 'walk');
      const wb = (ctx.legLanes.get(b) ?? []).filter((q) => q.lane.kind === 'walk');
      for (const q of wa) for (const m of wb) {
        const lane = ctx.lane({ kind: 'walk', cls: ['ped'], pts: [laneEnd(q), laneEnd(m)], width: 3, speed: 1.3, node: n.desc.id, bidir: true, crosswalk: true });
        ctx.link(q.lane, lane);
        ctx.link(lane, m.lane);
      }
      continue;
    }
    const tl = (ctx.legLanes.get(a) ?? []).filter((q) => q.def.track);
    for (const q of tl) {
      const m = (ctx.legLanes.get(b) ?? []).find((r) => r.def.track && Math.abs(r.lat + q.lat) < 0.5);
      if (!m) continue;
      const p0 = { ...legPt(a, a.setback, q.lat), z: n.z }, p1 = { ...legPt(b, b.setback, m.lat), z: n.z };
      const lane = ctx.lane({ kind: q.lane.kind, cls: q.lane.cls, pts: [p0, p1], width: 3, speed: q.lane.speed, node: n.desc.id, bidir: q.lane.bidir, track: 'embedded', gauge: q.lane.gauge });
      if (q.lane.bidir) { ctx.link(q.lane, lane); ctx.link(lane, m.lane); ctx.link(m.lane, lane); ctx.link(lane, q.lane); }
      else if (q.inbound) { ctx.link(q.lane, lane); ctx.link(lane, m.lane); }
      else { lane.pts.reverse(); ctx.link(m.lane, lane); ctx.link(lane, q.lane); }
      ctx.tracks.push({ kind: 'embedded', gauge: q.lane.gauge ?? 1.435, pts: [{ ...p0, z: n.z + 0.004 }, { ...p1, z: n.z + 0.004 }], lane: lane.id, flush: true });
      if (n.kind === 'level_crossing' && r1) {
        const d = norm(sub(p1, p0)), nn = left(d);
        const hw = 1.45;
        const qa = add(p0, mul(nn, hw)), qb = add(p1, mul(nn, hw)), qc = add(p1, mul(nn, -hw)), qd = add(p0, mul(nn, -hw));
        ctx.sink.quad('crossing_panel', { ...qd, z: n.z + 0.003 }, { ...qc, z: n.z + 0.003 }, { ...qb, z: n.z + 0.003 }, { ...qa, z: n.z + 0.003 });
      }
    }
  }
}

function dedupe(p: P3[]): P3[] {
  const out: P3[] = [];
  for (const q of p) if (!out.length || dist(out[out.length - 1], q) > 0.02) out.push(q);
  while (out.length > 2 && dist(out[0], out[out.length - 1]) < 0.02) out.pop();
  return out;
}

export { legDir };

interface MergeGeo { main: Leg; wide: Leg; ramps: { leg: Leg; side: number; tip: P3; tMain: number }[]; merge: boolean }
const mgeo = new WeakMap<Node, MergeGeo>();

function laneDirs(ctx: Ctx, l: Leg) {
  let inb = 0, out = 0;
  for (const b of l.seg.lay) for (const q of b.band.lanes ?? []) {
    if (q.cls.includes('ped')) continue;
    const d = l.seg.dir === 'back' ? -q.dir : q.dir;
    if ((d === 1) === (l.end === 'b')) inb++; else out++;
  }
  void ctx;
  return { inb, out };
}

function mergeSetbacks(ctx: Ctx, n: Node) {
  const L = n.legs;
  let best = Infinity, M = L[0], W = L[1];
  for (let i = 0; i < L.length; i++) for (let j = 0; j < L.length; j++) {
    if (i === j) continue;
    const a = L[i], b = L[j];
    const da = laneDirs(ctx, a), db = laneDirs(ctx, b);
    if (!(da.inb > 0 && db.out > 0)) continue;
    const d = Math.abs(wrapPi(a.ang - b.ang - Math.PI)) - (b.curbL - b.curbR) * 1e-3;
    if (d < best) { best = d; M = a; W = b; }
  }
  const others = L.filter((l) => l !== M && l !== W);
  const merge = others.every((l) => laneDirs(ctx, l).inb > 0);
  if (!merge) {
    let best2 = Infinity;
    for (const a of L) for (const b of L) {
      if (a === b) continue;
      const da = laneDirs(ctx, a), db = laneDirs(ctx, b);
      if (!(da.inb > 0 && db.out > 0)) continue;
      const d = Math.abs(wrapPi(a.ang - b.ang - Math.PI)) - (a.curbL - a.curbR) * 1e-3;
      if (d < best2) { best2 = d; W = a; M = b; }
    }
  }
  const T = merge ? W.u : M.u;
  const ramps: MergeGeo['ramps'] = [];
  for (const l of L) {
    l.setback = 0; l.tStop = 0; l.tExit = 0; l.markEnd = 0; l.cut = null;
  }
  for (const R of L.filter((l) => l !== M && l !== W)) {
    const side = Math.sign(T.x * R.u.y - T.y * R.u.x) || -1;
    const mLat = side > 0 ? (dot(M.n, left(T)) > 0 ? M.curbL : M.curbR) : (dot(M.n, left(T)) > 0 ? M.curbR : M.curbL);
    const rLat = side > 0 ? (dot(R.n, left(T)) > 0 ? R.curbR : R.curbL) : (dot(R.n, left(T)) > 0 ? R.curbL : R.curbR);
    const pm = add(n.p, mul(M.n, mLat)), pr = add(n.p, mul(R.n, rLat));
    const x = lineX(pm, M.u, pr, R.u);
    let tR = 0, tM = 0;
    if (x && x.t > 0 && x.u > 0) { tM = x.t; tR = x.u; }
    R.setback = Math.min(tR, R.seg.path.length * 0.8);
    R.tStop = R.tExit = R.markEnd = R.setback;
    ramps.push({ leg: R, side, tip: { ...legPt(R, R.setback, rLat) }, tMain: tM });
  }
  mgeo.set(n, { main: M, wide: W, ramps, merge });
}

function mergeNode(ctx: Ctx, n: Node) {
  const g = mgeo.get(n);
  if (!g) return;
  const { main: M, wide: W } = g;
  const T = g.merge ? W.u : M.u;
  const lt = left(T);
  const latOf = (l: Leg, lat: number) => dot(sub(legPt(l, l.setback, lat), n.p), lt);
  for (const r of g.ramps) {
    const R = r.leg;
    const wOuter = r.side < 0 ? Math.min(latOf(W, W.curbL), latOf(W, W.curbR)) : Math.max(latOf(W, W.curbL), latOf(W, W.curbR));
    const wPt = add(n.p, mul(lt, wOuter));
    const rOuterLat = Math.abs(latOf(R, R.curbL) - wOuter) < Math.abs(latOf(R, R.curbR) - wOuter) ? R.curbL : R.curbR;
    const rInnerLat = rOuterLat === R.curbL ? R.curbR : R.curbL;
    const ro = legPt(R, R.setback, rOuterLat), ri = legPt(R, R.setback, rInnerLat);
    const mInner = r.side < 0 ? Math.min(latOf(M, M.curbL), latOf(M, M.curbR)) : Math.max(latOf(M, M.curbL), latOf(M, M.curbR));
    const mPt = add(n.p, mul(lt, mInner));
    const z = (p: V2) => nodeZ(n, p);
    const poly = [wPt, ro, ri, mPt].map((p) => ({ ...p, z: z(p) }));
    ctx.sink.poly('asphalt_dark', poly);
    ctx.footprints.push({ pts: poly.map((p) => ({ ...p })), kind: 'node', slope: 0.5, wall: false });
    ctx.sink.wall('dirt', [poly[0], poly[1]].map((p, q) => ({ ...p, s: q })), 1.0, r.side < 0 !== g.merge);
    const tipLane = add(ri, mul(sub(mPt, ri), 0.0));
    const conv = add(n.p, mul(lt, mInner - r.side * 0.2));
    const zz = z(conv) + PAINT;
    for (const [p, q] of [[tipLane, conv]] as const) {
      const d = norm(sub(q, p)), nn = mul(left(d), 0.1);
      ctx.sink.quad('paint_white', { ...sub(p, nn), z: z(p) + PAINT }, { ...sub(q, nn), z: zz }, { ...add(q, nn), z: zz }, { ...add(p, nn), z: z(p) + PAINT });
    }
  }
  const ins = (l: Leg) => (ctx.legLanes.get(l) ?? []).filter((q) => q.inbound && q.lane.kind === 'drive');
  const outs = (l: Leg) => (ctx.legLanes.get(l) ?? []).filter((q) => !q.inbound && q.lane.kind === 'drive');
  const posLat = (q: LegLane, l: Leg) => { const p = laneEnd(q); void l; return dot(sub(p, n.p), lt); };
  const srcLegs = g.merge ? [M, ...g.ramps.map((r) => r.leg)] : [W];
  const dstLegs = g.merge ? [W] : [M, ...g.ramps.map((r) => r.leg)];
  const src = srcLegs.flatMap((l) => ins(l).map((q) => ({ q, l, lat: posLat(q, l) })));
  const dst = dstLegs.flatMap((l) => outs(l).map((q) => ({ q, l, lat: posLat(q, l) })));
  const used = new Set<LegLane>();
  for (const e of src) {
    const near = dst.filter((x) => Math.abs(x.lat - e.lat) < 1.2);
    const targets = near.length ? near : [dst.reduce((b, x) => (Math.abs(x.lat - e.lat) < Math.abs(b.lat - e.lat) ? x : b))];
    for (const x of targets) {
      used.add(x.q);
      const p0 = laneEnd(e.q), p3 = laneEnd(x.q);
      if (dist(p0, p3) < 0.3) { ctx.link(e.q.lane, x.q.lane); continue; }
      const pts = curve(p0, mul(e.l.u, -1), p3, x.l.u, 'through');
      const lane = ctx.lane({ kind: 'drive', cls: e.q.lane.cls, pts, width: e.q.w, speed: e.q.lane.speed, node: n.desc.id, bidir: false });
      ctx.link(e.q.lane, lane);
      ctx.link(lane, x.q.lane);
    }
  }
}
