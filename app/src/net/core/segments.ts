import type { Mat } from './assets';
import type { Ctx, Variant } from './ctx';
import type { Seg } from './model';
import { offsetLine, type PathPt } from './path';
import { PORTAL, crown } from './terrain';

const MARK_Z = 0.025;

export function segRange(seg: Seg) {
  return { sa: seg.legA.setback, sb: seg.path.length - seg.legB.setback };
}

export function edge(seg: Seg, lat: number, h: number | ((s: number) => number), s0: number, s1: number, clip = true): PathPt[] {
  let pts = seg.path.offset(lat, s0, s1);
  if (clip) {
    if (seg.legA.cut && s0 <= seg.legA.setback + 1e-6) pts = offsetLine(pts, seg.legA.cut, 'start');
    if (seg.legB.cut && s1 >= seg.path.length - seg.legB.setback - 1e-6) pts = offsetLine(pts, seg.legB.cut, 'end');
  }
  return pts.map((p) => ({ ...p, z: p.z + (typeof h === 'number' ? h : h(p.s)) }));
}

export function variantAt(ctx: Ctx, seg: Seg, s: number): Variant['kind'] {
  for (const v of ctx.variants.get(seg) ?? []) if (s >= v.s0 && s <= v.s1) return v.kind;
  return 'grade';
}

export function buildSegment(ctx: Ctx, seg: Seg) {
  const { sa, sb } = segRange(seg);
  if (sb - sa < 0.05) return;
  const a = seg.asset;
  const lay = seg.lay;
  const sink = ctx.sink;

  const rng = (k: number): [number, number] => bandRange(seg, k, sa, sb);
  for (let i = 0; i < lay.length; i++) {
    const b = lay[i];
    const [b0, b1] = rng(i);
    if (b1 - b0 < 0.05) continue;
    const right = edge(seg, b.r, b.hr, b0, b1);
    const leftE = edge(seg, b.l, b.hl, b0, b1);
    sink.strip(b.band.mat as Mat, right, leftE, b.r, b.l);
    if (i < lay.length - 1) {
      const nb = lay[i + 1];
      const dh = b.hr - nb.hl;
      const [c0, c1] = rng(i + 1);
      const f0 = Math.max(b0, c0), f1 = Math.min(b1, c1);
      if (Math.abs(dh) > 0.01 && f1 - f0 > 0.05) {
        const top = edge(seg, b.r, Math.max(b.hr, nb.hl), f0, f1);
        sink.wall(faceMat(b.band.kind, nb.band.kind), top, Math.abs(dh), dh > 0);
      }
      for (const [x0, x1, hi, lo] of [[b0, c0, b, nb], [c1, b1, b, nb], [c0, b0, nb, b], [b1, c1, nb, b]] as const) {
        if (x1 - x0 < 0.05) continue;
        const h = hi === b ? b.hr : nb.hl;
        const hl = lo === b ? b.hr : nb.hl;
        if (h - hl < 0.01) continue;
        const top = edge(seg, b.r, h, x0, x1);
        sink.wall(faceMat(b.band.kind, nb.band.kind), top, h - hl, hi === b);
      }
    }
  }

  const vars = ctx.variants.get(seg) ?? [];
  const outerL = lay[0], outerR = lay[lay.length - 1];
  const gradeRanges = complement(vars.filter((v) => v.kind === 'bridge' || v.kind === 'tunnel'), sa, sb);
  const skirtMat: Mat = a.family === 'platform' ? 'platform' : a.family === 'rail' || a.family === 'subway' ? 'ballast' : 'dirt';
  for (const [s0, s1] of gradeRanges) {
    sink.wall(skirtMat, edge(seg, outerL.l, outerL.hl, s0, s1), a.skirt, false);
    sink.wall(skirtMat, edge(seg, outerR.r, outerR.hr, s0, s1), a.skirt, true);
  }
  for (const v of vars) {
    const s0 = Math.max(sa, v.s0), s1 = Math.min(sb, v.s1);
    if (s1 - s0 < 0.5) continue;
    if (v.kind === 'bridge') bridge(ctx, seg, s0, s1);
    if (v.kind === 'tunnel') tunnel(ctx, seg, s0, s1);
    if (v.kind === 'wall') walls(ctx, seg, s0, s1);
  }

  markings(ctx, seg, sa, sb);
  lanes(ctx, seg, sa, sb);
  slots(ctx, seg, sa, sb);
}

export function bandRange(seg: Seg, k: number, sa: number, sb: number): [number, number] {
  const n = seg.lay.length;
  const ta = seg.legA.bandT?.[k];
  const tb = seg.legB.bandT?.[n - 1 - k];
  return [Math.max(sa, ta ?? sa), Math.min(sb, tb !== undefined ? seg.path.length - tb : sb)];
}

function faceMat(k1: string, k2: string): Mat {
  if (k1 === 'ballast' || k2 === 'ballast' || k1 === 'track' || k2 === 'track') return 'ballast';
  if (k1 === 'platform' || k2 === 'platform') return 'platform';
  return 'curb';
}

function complement(vs: { s0: number; s1: number }[], sa: number, sb: number): [number, number][] {
  const out: [number, number][] = [];
  let s = sa;
  for (const v of [...vs].sort((p, q) => p.s0 - q.s0)) {
    if (v.s0 > s) out.push([s, Math.min(v.s0, sb)]);
    s = Math.max(s, v.s1);
  }
  if (s < sb) out.push([s, sb]);
  return out.filter(([p, q]) => q - p > 0.05);
}

function bridge(ctx: Ctx, seg: Seg, s0: number, s1: number) {
  const a = seg.asset, lay = seg.lay, sink = ctx.sink;
  const L = lay[0], R = lay[lay.length - 1];
  const dd = a.deckDepth;
  const le = edge(seg, L.l, L.hl, s0, s1), re = edge(seg, R.r, R.hr, s0, s1);
  sink.wall('deck', le, dd, false);
  sink.wall('deck', re, dd, true);
  const lb = le.map((p) => ({ ...p, z: p.z - dd })), rb = re.map((p) => ({ ...p, z: p.z - dd }));
  sink.strip('deck', lb, rb, 0, 1);
  if (a.family === 'road' || a.family === 'path') {
    ctx.linear.push({ kind: 'parapet', pts: edge(seg, L.l - 0.25, L.hl, s0, s1), h: 1.0 });
    ctx.linear.push({ kind: 'parapet', pts: edge(seg, R.r + 0.25, R.hr, s0, s1), h: 1.0 });
  } else {
    ctx.linear.push({ kind: 'handrail', pts: edge(seg, L.l - 0.1, L.hl, s0, s1), h: 1.1 });
    ctx.linear.push({ kind: 'handrail', pts: edge(seg, R.r + 0.1, R.hr, s0, s1), h: 1.1 });
  }
  const span = a.family === 'rail' ? 28 : 32;
  const len = s1 - s0;
  const n = Math.max(0, Math.round(len / span) - 1);
  const W = L.l - R.r;
  for (let k = 1; k <= n; k++) {
    const s = s0 + (len * k) / (n + 1);
    const f = seg.path.at(s);
    const g = ctx.terrainAt(f.x, f.y) ?? f.z - 8;
    const top = f.z - dd;
    if (top - g < 0.5) continue;
    const below = blockedBelow(ctx, seg, f.x, f.y);
    if (below === 'lane') continue;
    ctx.props.push({ kind: 'pier', x: f.x, y: f.y, z: g, h: Math.atan2(f.ty, f.tx), p: { height: top - g, width: W * 0.8, thin: below === 'median' ? 1 : 0 } });
  }
  for (const s of [s0, s1]) {
    const f = seg.path.at(s);
    const g = ctx.terrainAt(f.x, f.y);
    if (g === null || f.z - dd - g < 0.3) continue;
    const nx = -f.ty, ny = f.tx;
    const top = [
      { x: f.x + nx * L.l, y: f.y + ny * L.l, z: f.z - dd, s: 0 },
      { x: f.x + nx * R.r, y: f.y + ny * R.r, z: f.z - dd, s: W },
    ];
    const bot = top.map((p) => ({ ...p, z: (ctx.terrainAt(p.x, p.y) ?? g) - 1 }));
    sink.wallBetween('wall', s === s0 ? top : [...top].reverse(), s === s0 ? bot : [...bot].reverse(), true);
  }
}

function blockedBelow(ctx: Ctx, seg: Seg, x: number, y: number): 'lane' | 'median' | null {
  for (const o of ctx.segs) {
    if (o === seg) continue;
    const w = (o.lay[0].l - o.lay[o.lay.length - 1].r) / 2 + 1.5;
    const bx = Math.min(...[o.path.x[0], o.path.x[o.path.n - 1]]) - 200, ex = Math.max(o.path.x[0], o.path.x[o.path.n - 1]) + 200;
    if (x < bx || x > ex) continue;
    const pr = o.path.project({ x, y });
    if (pr.d >= w) continue;
    const band = o.lay.find((b) => pr.lat <= b.l && pr.lat >= b.r);
    if (band && (band.band.kind === 'barrier' || band.band.kind === 'median') && band.band.w >= 0.8) return 'median';
    return 'lane';
  }
  return null;
}

function tunnel(ctx: Ctx, seg: Seg, s0: number, s1: number) {
  const lay = seg.lay, sink = ctx.sink;
  const L = lay[0], R = lay[lay.length - 1];
  const H = crown(seg);
  const le = edge(seg, L.l + 0.3, 0, s0, s1), re = edge(seg, R.r - 0.3, 0, s0, s1);
  const lt = le.map((p) => ({ ...p, z: p.z + H })), rt = re.map((p) => ({ ...p, z: p.z + H }));
  sink.wall('tunnel', lt, H + 1.2, true);
  sink.wall('tunnel', rt, H + 1.2, false);
  sink.strip('tunnel', lt, rt, 0, 1);
  for (const [s, end] of [[s0, 0], [s1, 1]] as const) {
    if ((end === 0 && s0 <= seg.legA.setback + 0.1) || (end === 1 && s1 >= seg.path.length - seg.legB.setback - 0.1)) {
      const nd = end === 0 ? seg.legA.node : seg.legB.node;
      if (nd.legs.length > 1) continue;
    }
    const f = seg.path.at(s);
    const nx = -f.ty, ny = f.tx;
    const W = L.l - R.r + 1.6;
    const g = Math.max(ctx.terrainAt(f.x, f.y) ?? f.z + H + 2, f.z + H + 1);
    const pts = [
      { x: f.x + nx * (W / 2 + 0.8), y: f.y + ny * (W / 2 + 0.8) },
      { x: f.x - nx * (W / 2 + 0.8), y: f.y - ny * (W / 2 + 0.8) },
    ];
    const top = pts.map((p, i) => ({ ...p, z: g + 0.6, s: i * W }));
    const bot = pts.map((p, i) => ({ ...p, z: f.z + H, s: i * W }));
    sink.wallBetween('wall', end === 0 ? [...top].reverse() : top, end === 0 ? [...bot].reverse() : bot, true);
    const r0 = end === 0 ? s : s - PORTAL - 1.5, r1 = end === 0 ? s + PORTAL + 1.5 : s;
    const rl = edge(seg, W / 2 + 0.8, H + 0.45, r0, r1, false), rr = edge(seg, -(W / 2 + 0.8), H + 0.45, r0, r1, false);
    sink.strip('wall', rr, rl, 0, 1);
  }
}

function walls(ctx: Ctx, seg: Seg, s0: number, s1: number) {
  const lay = seg.lay, sink = ctx.sink;
  const L = lay[0], R = lay[lay.length - 1];
  for (const [lat, h, out] of [[L.l + 0.0, L.hl, false], [R.r - 0.0, R.hr, true]] as const) {
    const top = edge(seg, lat, h, s0, s1);
    const bot = top.map((p) => ({ ...p }));
    const ground = top.map((p) => ctx.terrainAt(p.x, p.y) ?? p.z);
    const hi = top.map((p, i) => ({ ...p, z: Math.max(p.z + 0.4, ground[i] + 0.4) }));
    const lo = bot.map((p, i) => ({ ...p, z: Math.min(p.z - 0.6, ground[i] - 0.6) }));
    sink.wallBetween('wall', hi, lo, out);
    const off = out ? 0.35 : -0.35;
    const back = edge(seg, lat - off, h, s0, s1).map((p, i) => ({ ...p, z: hi[i]?.z ?? p.z }));
    sink.strip('wall', out ? back : hi, out ? hi : back, 0, 1);
  }
}

function dashes(pts: PathPt[], dash: number, gap: number): PathPt[][] {
  const out: PathPt[][] = [];
  if (pts.length < 2) return out;
  const s0 = pts[0].s, s1 = pts[pts.length - 1].s;
  const L = s1 - s0;
  if (L < dash) return out;
  const period = dash + gap;
  const n = Math.max(1, Math.floor((L + gap) / period));
  const off = (L - (n * period - gap)) / 2;
  for (let k = 0; k < n; k++) {
    const a = s0 + off + k * period, b = a + dash;
    out.push(slice(pts, a, b));
  }
  return out;
}

export function slice(pts: PathPt[], a: number, b: number): PathPt[] {
  const out: PathPt[] = [];
  const at = (s: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      if (s >= pts[i].s && s <= pts[i + 1].s) {
        const t = (s - pts[i].s) / Math.max(1e-9, pts[i + 1].s - pts[i].s);
        const p = pts[i], q = pts[i + 1];
        return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t, s };
      }
    }
    return s <= pts[0].s ? pts[0] : pts[pts.length - 1];
  };
  out.push(at(a));
  for (const p of pts) if (p.s > a && p.s < b) out.push(p);
  out.push(at(b));
  return out;
}

export function paintLine(ctx: Ctx, seg: Seg, lat: number, h: number, s0: number, s1: number, w: number, mat: Mat, dash?: [number, number]) {
  if (s1 - s0 < 0.5) return;
  const r = edge(seg, lat - w / 2, h + MARK_Z, s0, s1, false);
  const l = edge(seg, lat + w / 2, h + MARK_Z, s0, s1, false);
  if (!dash) { ctx.sink.strip(mat, r, l, 0, 1); return; }
  const rs = dashes(r, dash[0], dash[1]), ls = dashes(l, dash[0], dash[1]);
  for (let i = 0; i < rs.length; i++) ctx.sink.strip(mat, rs[i], ls[i], 0, 1);
}

function markings(ctx: Ctx, seg: Seg, sa: number, sb: number) {
  const a = seg.asset;
  const s0 = Math.max(sa, seg.legA.markEnd), s1 = Math.min(sb, seg.path.length - seg.legB.markEnd);
  if (s1 - s0 < 1) return;
  const lay = seg.lay;
  const vars = ctx.variants.get(seg) ?? [];
  void vars;
  for (let i = 0; i < lay.length - 1; i++) {
    const b1 = lay[i], b2 = lay[i + 1];
    const k1 = b1.band.kind, k2 = b2.band.kind;
    const x = b1.r;
    const d1 = b1.band.lanes?.[0]?.dir, d2 = b2.band.lanes?.[0]?.dir;
    if (k1 === 'lane' && k2 === 'lane') {
      if (d1 === d2) {
        if (a.laneLines === 'white_dashed') paintLine(ctx, seg, x, 0, s0, s1, 0.12, 'paint_white', [3, 6]);
      } else {
        if (a.centre === 'double_yellow') {
          paintLine(ctx, seg, x + 0.1, 0, s0, s1, 0.1, 'paint_yellow');
          paintLine(ctx, seg, x - 0.1, 0, s0, s1, 0.1, 'paint_yellow');
        } else if (a.centre === 'yellow') paintLine(ctx, seg, x, 0, s0, s1, 0.12, 'paint_yellow');
        else if (a.centre === 'yellow_dashed') paintLine(ctx, seg, x, 0, s0, s1, 0.12, 'paint_yellow', [3, 6]);
        else if (a.centre === 'white_dashed') paintLine(ctx, seg, x, 0, s0, s1, 0.12, 'paint_white', [3, 6]);
      }
    } else if (a.edgeLines && (k1 === 'lane' || k2 === 'lane')) {
      const laneBand = k1 === 'lane' ? b1 : b2;
      const dir = laneBand.band.lanes?.[0]?.dir ?? 1;
      const laneOnLeft = k1 === 'lane';
      const isRightOfTravel = (dir === 1) === laneOnLeft;
      const off = laneOnLeft ? 0.2 : -0.2;
      paintLine(ctx, seg, x + off, 0, sa + 0.5, sb - 0.5, 0.15, isRightOfTravel ? 'paint_white' : 'paint_yellow');
    }
    if (k2 === 'bike' || k1 === 'bike') paintLine(ctx, seg, x, 0, s0, s1, 0.15, 'paint_white');
  }
}

function lanes(ctx: Ctx, seg: Seg, sa: number, sb: number) {
  const L = seg.path.length;
  const legA = seg.legA, legB = seg.legB;
  const regA: typeof ctx.legLanes extends Map<unknown, infer V> ? V : never = ctx.legLanes.get(legA) ?? [];
  const regB: typeof regA = ctx.legLanes.get(legB) ?? [];
  for (const b of seg.lay) {
    for (const def of b.band.lanes ?? []) {
      const lat = (b.l + b.r) / 2 + (def.off ?? 0);
      const w = def.off !== undefined ? 3 : b.l - b.r;
      const isTrack = !!def.track;
      const isWalk = def.cls.includes('ped') && def.cls.length <= 2;
      const kind = def.cls.includes('rail') || def.cls.includes('subway') ? 'rail' : def.cls.length === 1 && def.cls[0] === 'tram' ? 'tram' : isWalk ? 'walk' : 'drive';
      let dir = def.dir;
      if (seg.dir === 'back') dir = -dir as 1 | -1;
      const bidir = kind === 'rail' ? seg.dir === 'both' : kind === 'walk';
      const startT = dir === 1 ? (kind === 'drive' || kind === 'tram' ? legA.tExit : legA.setback) : (kind === 'drive' || kind === 'tram' ? legB.tExit : legB.setback);
      const endT = dir === 1 ? (kind === 'drive' || kind === 'tram' ? legB.tStop : legB.setback) : (kind === 'drive' || kind === 'tram' ? legA.tStop : legA.setback);
      let s0 = dir === 1 ? startT : endT;
      let s1 = dir === 1 ? L - endT : L - startT;
      s0 = Math.max(s0, isTrack || kind === 'walk' ? sa : 0);
      s1 = Math.min(s1, isTrack || kind === 'walk' ? sb : L);
      if (s1 - s0 < 0.2) { s0 = (s0 + s1) / 2 - 0.1; s1 = s0 + 0.2; }
      let pts = edge(seg, lat, b.hl, s0, s1, false);
      if (kind === 'walk') pts = edge(seg, lat, b.hl, sa, sb, true);
      if (dir === -1) pts = [...pts].reverse();
      const lane = ctx.lane({
        kind, cls: def.cls, pts: pts.map((p) => ({ x: p.x, y: p.y, z: p.z })), width: Math.min(w, 4), speed: (def.speed ?? seg.asset.speed) / 3.6,
        seg: seg.desc.id, bidir, track: def.track, gauge: seg.asset.gauge || 1.495, stopLine: kind === 'drive' || kind === 'tram',
      });
      regA.push({ lane, lat, inbound: dir === -1, def, w });
      regB.push({ lane, lat: -lat, inbound: dir === 1, def, w });
      if (isTrack) {
        let tp = edge(seg, lat, b.hl, sa, sb, true);
        if (def.track === 'embedded') tp = tp.map((p) => ({ ...p, z: p.z + 0.004 }));
        if (def.track === 'slab') tp = tp.map((p) => ({ ...p, z: p.z + 0.02 }));
        ctx.tracks.push({ kind: def.track!, gauge: seg.asset.gauge || 1.495, pts: tp.map((p) => ({ x: p.x, y: p.y, z: p.z })), lane: lane.id, flush: def.track === 'embedded' });
      }
    }
  }
  ctx.legLanes.set(legA, regA);
  ctx.legLanes.set(legB, regB);
}

function events(ctx: Ctx, seg: Seg, sa: number, sb: number) {
  const L = seg.path.length;
  for (const ev of seg.desc.events ?? []) {
    if (ev.kind !== 'bus_stop') continue;
    const s = Math.min(sb - 2, Math.max(sa + 2, ev.s <= 1 ? ev.s * L : ev.s));
    const side = ev.side ?? -1;
    const walk = seg.lay.filter((b) => b.band.kind === 'sidewalk' && (side > 0 ? b.l > 0 : b.r < 0));
    const carr = seg.lay.filter((b) => b.band.kind === 'lane');
    if (!walk.length || !carr.length) continue;
    const b = side > 0 ? walk[0] : walk[walk.length - 1];
    const curb = side > 0 ? b.r : b.l;
    const f = seg.path.at(s);
    const nx = -f.ty, ny = f.tx;
    const tang = Math.atan2(f.ty, f.tx);
    const face = side > 0 ? tang - Math.PI / 2 : tang + Math.PI / 2;
    const pole = curb + side * 0.5, shelter = (b.l + b.r) / 2 + side * 0.2;
    ctx.props.push({ kind: 'bus_stop', x: f.x + nx * pole, y: f.y + ny * pole, z: f.z + b.hl, h: face });
    if (b.band.w >= 2.2) {
      const g = seg.path.at(Math.max(sa + 2, s - 6));
      ctx.props.push({ kind: 'shelter', x: g.x - g.ty * shelter, y: g.y + g.tx * shelter, z: g.z + b.hl, h: face + Math.PI });
    }
  }
}

function slots(ctx: Ctx, seg: Seg, sa: number, sb: number) {
  events(ctx, seg, sa, sb);
  const vars = ctx.variants.get(seg) ?? [];
  for (const b of seg.lay) {
    for (const slot of b.band.slots ?? []) {
      const lat = (b.l + b.r) / 2 + (slot.at ?? 0) * (b.l - b.r);
      const h = b.hl + ((b.hr - b.hl) * 0.5);
      if (slot.continuous) {
        const pts = edge(seg, lat, h, sa, sb, true);
        ctx.linear.push({ kind: slot.kind === 'jersey' ? 'jersey' : 'fence', pts: pts.map((p) => ({ x: p.x, y: p.y, z: p.z })), h: slot.kind === 'jersey' ? 0.81 : 1.8 });
        continue;
      }
      const start = sa + 3, end = sb - 3;
      const phase = slot.phase ?? 0;
      let s = Math.ceil((start - phase) / slot.spacing) * slot.spacing + phase;
      for (; s <= end; s += slot.spacing) {
        const vk = variantOf(vars, s);
        if (vk === 'tunnel') continue;
        if (vk === 'bridge' && (slot.kind === 'tree' || slot.kind === 'tree_small' || slot.kind === 'hydrant')) continue;
        const f = seg.path.at(s);
        const x = f.x - f.ty * lat, y = f.y + f.tx * lat;
        const tang = Math.atan2(f.ty, f.tx);
        const along = slot.kind === 'canopy' || slot.kind === 'platform_lamp' || slot.kind === 'ocs_pole';
        const face = along ? tang : lat > 0 ? tang - Math.PI / 2 : tang + Math.PI / 2;
        ctx.props.push({ kind: slot.kind, x, y, z: f.z + h, h: face, p: { reach: Math.abs(lat) } });
      }
    }
  }
}

function variantOf(vs: Variant[], s: number) {
  for (const v of vs) if (s >= v.s0 && s <= v.s1) return v.kind;
  return 'grade';
}
