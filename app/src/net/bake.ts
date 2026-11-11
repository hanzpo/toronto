import { assetWidth, carriageway, type Asset, type VClass } from './core/assets';
import { build, prepare } from './core/build';
import type { Ctx } from './core/ctx';
import type { NetDesc } from './core/desc';
import type { LaneOut, Seg } from './core/model';
import type { TypedArray } from '../data/tbn';

export interface BakeTile extends NetDesc { tile: [number, number] }

export const VF_BRIDGE = 1, VF_TUNNEL = 2;
export const F_ONEWAY = 1, F_BRIDGE = 2, F_TUNNEL = 4;
export const RAIL_CLASS = { rail: 0, subway: 1, tram: 4 } as const;
export const PATH_CLASS = 8;

export interface Piece {
  seg: string;
  road: boolean;
  cls: number;
  w: number;
  name: string;
  oneway: boolean;
  fwd: number;
  pts: number[];
  dz: number[];
  vf: number[];
}

export interface LaneRec {
  key: string;
  kind: number;
  cls: number;
  bidir: boolean;
  rank: number;
  group: string;
  rail: number;
  speed: number;
  pts: number[];
  vf: number[];
  next: string[];
}

export type Arrays = Record<string, TypedArray>;

const CLS_BIT: Record<VClass, number> = { car: 1, bus: 2, truck: 4, tram: 8, rail: 16, subway: 32, bike: 64, ped: 128 };

const laneKey = (l: LaneOut) => {
  const a = l.pts[0], b = l.pts[l.pts.length - 1];
  return `${l.kind}|${a.x.toFixed(1)},${a.y.toFixed(1)}|${b.x.toFixed(1)},${b.y.toFixed(1)}`;
};

function vfAt(ctx: Ctx, seg: Seg, s: number): number {
  let f = 0;
  for (const v of ctx.variants.get(seg) ?? []) {
    if (s < v.s0 - 1e-6 || s > v.s1 + 1e-6) continue;
    if (v.kind === 'bridge') f |= VF_BRIDGE;
    if (v.kind === 'tunnel') f |= VF_TUNNEL;
  }
  return f;
}

function pieceClass(a: Asset): { road: boolean; cls: number } | null {
  if (a.family === 'road') return { road: true, cls: Math.min(6, a.rank) };
  if (a.family === 'path') return { road: true, cls: PATH_CLASS };
  if (a.family === 'rail') return { road: false, cls: RAIL_CLASS.rail };
  if (a.family === 'subway') return { road: false, cls: RAIL_CLASS.subway };
  if (a.family === 'tram') return { road: false, cls: RAIL_CLASS.tram };
  return null;
}

function fwdLanes(a: Asset): number {
  let n = 0;
  for (const b of a.bands) for (const l of b.lanes ?? []) if (l.dir === 1 && l.cls.includes('car')) n++;
  return n;
}

function segPiece(ctx: Ctx, seg: Seg): Piece | null {
  const pc = pieceClass(seg.asset);
  if (!pc) return null;
  const c = carriageway(seg.asset);
  const p = seg.path;
  const pts: number[] = [], vf: number[] = [], dz: number[] = [];
  for (let i = 0; i < p.n; i++) {
    pts.push(p.x[i], p.y[i], p.z[i]);
    vf.push(vfAt(ctx, seg, p.s[i]));
    const g = ctx.terrainAt(p.x[i], p.y[i]);
    dz.push(g === null ? 0 : p.z[i] - g);
  }
  const fwd = fwdLanes(seg.asset);
  return {
    seg: seg.desc.id, ...pc, w: c ? c.l - c.r : assetWidth(seg.asset), name: seg.desc.name ?? '',
    oneway: seg.dir !== 'both' && !seg.asset.bands.some((b) => b.lanes?.some((l) => l.dir === -1 && l.cls.includes('car'))), fwd, pts, dz, vf,
  };
}

/** Pieces for every segment of a tile description (context included), and the prepared context. */
export function tilePieces(desc: BakeTile): { ctx: Ctx; pieces: Piece[] } {
  const ctx = prepare(desc);
  const pieces: Piece[] = [];
  for (const s of ctx.segs) {
    const pc = segPiece(ctx, s);
    if (pc) pieces.push(pc);
  }
  return { ctx, pieces };
}

function laneFlags(ctx: Ctx | undefined, seg: Seg | undefined, l: LaneOut): number[] {
  if (!ctx || !seg) return l.pts.map(() => 0);
  const p = seg.path;
  const cum = [0];
  for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(l.pts[i].x - l.pts[i - 1].x, l.pts[i].y - l.pts[i - 1].y));
  const L = cum[cum.length - 1] || 1;
  const a = l.pts[0];
  const rev = Math.hypot(a.x - p.x[p.n - 1], a.y - p.y[p.n - 1]) < Math.hypot(a.x - p.x[0], a.y - p.y[0]);
  return cum.map((c) => vfAt(ctx, seg, (rev ? 1 - c / L : c / L) * p.length));
}

function lateral(seg: Seg, l: LaneOut): { lat: number; dir: 1 | -1 } {
  const m = l.pts[Math.floor(l.pts.length / 2)];
  const p = seg.path;
  let best = 0, bd = Infinity;
  for (let i = 0; i < p.n; i++) {
    const d = Math.hypot(p.x[i] - m.x, p.y[i] - m.y);
    if (d < bd) { bd = d; best = p.s[i]; }
  }
  const f = p.at(best);
  const a = l.pts[0], b = l.pts[l.pts.length - 1];
  const dir = (b.x - a.x) * f.tx + (b.y - a.y) * f.ty >= 0 ? 1 : -1;
  return { lat: (m.x - f.x) * -f.ty + (m.y - f.y) * f.tx, dir };
}

function railKind(l: LaneOut): number {
  if (l.cls.includes('subway')) return 1;
  if (l.cls.includes('rail')) return 0;
  return l.kind === 'drive' || l.track === 'embedded' ? 3 : 2;
}

/**
 * Vehicle lanes (drive, tram, rail) of a block of tiles, built from the merged descriptions as the
 * sim builds them; only lanes whose segment or node a block tile owns.
 */
export function blockLanes(tiles: BakeTile[], prepared: Map<string, { ctx: Ctx; seg: Seg }>): LaneRec[] {
  const nmap = new Map<string, NetDesc['nodes'][number]>(), smap = new Map<string, NetDesc['segments'][number]>(), amap = new Map<string, object>();
  const ownS = new Set<string>(), ownN = new Set<string>();
  for (const d of tiles) {
    for (const n of d.nodes) nmap.set(n.id, n);
    for (const s of d.segments) smap.set(s.id, s);
    for (const a of d.assets ?? []) amap.set((a as { id: string }).id, a);
    for (const s of d.own?.segs ?? []) ownS.add(s);
    for (const n of d.own?.nodes ?? []) ownN.add(n);
  }
  const b = build({ nodes: [...nmap.values()], segments: [...smap.values()], assets: [...amap.values()] as NetDesc['assets'] }, { lanesOnly: true });
  const keys = b.lanes.map(laneKey);
  const veh = (l: LaneOut) => l.kind === 'drive' || l.kind === 'tram' || l.kind === 'rail';
  const flags = new Map<number, number[]>();
  const groups = new Map<string, { id: number; lat: number }[]>();
  const meta = new Map<number, { group: string }>();
  for (const l of b.lanes) {
    if (!veh(l) || !l.seg) continue;
    const pr = prepared.get(l.seg);
    flags.set(l.id, laneFlags(pr?.ctx, pr?.seg, l));
    if (!pr) continue;
    const { lat, dir } = lateral(pr.seg, l);
    const g = `${l.seg}|${dir}`;
    meta.set(l.id, { group: g });
    const arr = groups.get(g) ?? [];
    arr.push({ id: l.id, lat: lat * dir });
    groups.set(g, arr);
  }
  const rank = new Map<number, number>();
  for (const arr of groups.values()) {
    arr.sort((p, q) => p.lat - q.lat);
    arr.forEach((e, i) => rank.set(e.id, i));
  }
  for (const l of b.lanes) {
    if (!veh(l) || l.seg) continue;
    const pf = l.prev.map((j) => flags.get(j)).filter((f): f is number[] => !!f).map((f) => f[f.length - 1]);
    const nf = l.next.map((j) => flags.get(j)).filter((f): f is number[] => !!f).map((f) => f[0]);
    const all = [...pf, ...nf];
    const f = all.length ? all.reduce((x, y) => x & y) : 0;
    flags.set(l.id, l.pts.map(() => f));
  }
  const out: LaneRec[] = [];
  for (const l of b.lanes) {
    if (!veh(l)) continue;
    if (!(l.seg ? ownS.has(l.seg) : l.node ? ownN.has(l.node) : false)) continue;
    let cls = 0;
    for (const c of l.cls) cls |= CLS_BIT[c];
    out.push({
      key: keys[l.id], kind: l.kind === 'drive' ? 0 : l.kind === 'tram' ? 1 : 2, cls, bidir: l.bidir, rank: rank.get(l.id) ?? 255,
      group: meta.get(l.id)?.group ?? '', rail: l.kind === 'drive' && !l.cls.includes('tram') ? 255 : railKind(l), speed: l.speed,
      pts: l.pts.flatMap((p) => [p.x, p.y, p.z]), vf: flags.get(l.id)!, next: l.next.map((j) => keys[j]),
    });
  }
  return out;
}

export function simplify(pts: number[], vf: number[], tol: number): number[] {
  const n = pts.length / 3;
  if (n <= 2) return [...Array(n).keys()];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  for (let i = 1; i < n; i++) if (vf[i] !== vf[i - 1]) keep[i] = keep[i - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const ax = pts[a * 3], ay = pts[a * 3 + 1], dx = pts[b * 3] - ax, dy = pts[b * 3 + 1] - ay;
    const L = Math.hypot(dx, dy);
    let bi = -1, bd = -1;
    for (let i = a + 1; i < b; i++) {
      const qx = pts[i * 3] - ax, qy = pts[i * 3 + 1] - ay;
      const d = L > 1e-9 ? Math.abs(qx * dy - qy * dx) / L : Math.hypot(qx, qy);
      if (keep[i]) { stack.push([a, i], [i, b]); bi = -2; break; }
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi === -2) continue;
    if (bd > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Runs of a polyline inside the box [x0, x1] x [y0, y1], cut at the edges; z and dz interpolated, flags held. */
export function clip(pts: number[], dz: number[], vf: number[], x0: number, y0: number, x1: number, y1: number): { pts: number[]; dz: number[]; vf: number[] }[] {
  const n = pts.length / 3;
  const runs: { pts: number[]; dz: number[]; vf: number[] }[] = [];
  let cur: { pts: number[]; dz: number[]; vf: number[] } | null = null;
  const push = (r: { pts: number[]; dz: number[]; vf: number[] }, i: number, t: number, j: number) => {
    r.pts.push(pts[i * 3] + (pts[j * 3] - pts[i * 3]) * t, pts[i * 3 + 1] + (pts[j * 3 + 1] - pts[i * 3 + 1]) * t, pts[i * 3 + 2] + (pts[j * 3 + 2] - pts[i * 3 + 2]) * t);
    r.dz.push(dz[i] + (dz[j] - dz[i]) * t);
    r.vf.push(t < 0.5 ? vf[i] : vf[j]);
  };
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const ax = pts[i * 3 - 3], ay = pts[i * 3 - 2], bx = pts[i * 3], by = pts[i * 3 + 1];
      let t0 = 0, t1 = 1;
      const dx = bx - ax, dy = by - ay;
      const edge = (p: number, q: number) => {
        if (Math.abs(p) < 1e-12) return q >= 0;
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
        return true;
      };
      if (edge(-dx, ax - x0) && edge(dx, x1 - ax) && edge(-dy, ay - y0) && edge(dy, y1 - ay) && t1 > t0) {
        if (!cur) { cur = { pts: [], dz: [], vf: [] }; push(cur, i - 1, t0, i); }
        push(cur, i - 1, t1, i);
        if (t1 < 1) { runs.push(cur); cur = null; }
      } else if (cur) { runs.push(cur); cur = null; }
    }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.pts.length >= 6);
}

/** Tile arrays (tile-local E/N, absolute z) in the r_* / l_* layout the tile worker reads. */
export function farArrays(pieces: Piece[], x0: number, y0: number, S: number, tol: number): { arrays: Arrays; names: string[] } {
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const R = { off: [0], xyz: [] as number[], dz: [] as number[], vf: [] as number[], cls: [] as number[], fl: [] as number[], w: [] as number[], name: [] as number[], lanes: [] as number[] };
  const L = { off: [0], xyz: [] as number[], dz: [] as number[], vf: [] as number[], cls: [] as number[], fl: [] as number[] };
  for (const p of pieces) {
    for (const run of clip(p.pts, p.dz, p.vf, x0, y0, x0 + S, y0 + S)) {
      const keep = simplify(run.pts, run.vf, tol);
      if (keep.length < 2) continue;
      const T = p.road ? R : L;
      let any = 0, all = VF_TUNNEL;
      for (const i of keep) {
        T.xyz.push(run.pts[i * 3] - x0, run.pts[i * 3 + 1] - y0, run.pts[i * 3 + 2]);
        T.dz.push(run.dz[i]);
        T.vf.push(run.vf[i]);
        any |= run.vf[i];
        all &= run.vf[i];
      }
      T.off.push(T.xyz.length / 3);
      T.cls.push(p.cls);
      T.fl.push((p.oneway ? F_ONEWAY : 0) | (any & VF_BRIDGE ? F_BRIDGE : 0) | (all & VF_TUNNEL ? F_TUNNEL : 0));
      if (p.road) {
        R.w.push(p.w);
        R.lanes.push(Math.min(255, p.fwd * (p.oneway ? 1 : 2)));
        let k = 0xffff;
        if (p.name) { k = nameIdx.get(p.name) ?? names.length; if (k === names.length) { names.push(p.name); nameIdx.set(p.name, k); } }
        R.name.push(k);
      }
    }
  }
  const arrays: Arrays = {
    r_off: Uint32Array.from(R.off), r_xyz: Float32Array.from(R.xyz), r_dz: Float32Array.from(R.dz), r_vf: Uint8Array.from(R.vf),
    r_class: Uint8Array.from(R.cls), r_flags: Uint8Array.from(R.fl), r_width: Float32Array.from(R.w), r_lanes: Uint8Array.from(R.lanes), r_name: Uint16Array.from(R.name),
    l_off: Uint32Array.from(L.off), l_xyz: Float32Array.from(L.xyz), l_dz: Float32Array.from(L.dz), l_vf: Uint8Array.from(L.vf),
    l_class: Uint8Array.from(L.cls), l_flags: Uint8Array.from(L.fl),
  };
  return { arrays, names };
}

/** Drawn track centrelines (world E/N/z) by kind (0 rail · 1 subway · 2 LRT · 3 street tram), from the rail and tram lanes. */
export function railArrays(lanes: LaneRec[]): Arrays {
  const off = [0], xyz: number[] = [], vf: number[] = [], kind: number[] = [], fl: number[] = [];
  for (const l of lanes) {
    if (l.rail === 255) continue;
    xyz.push(...l.pts);
    vf.push(...l.vf);
    off.push(xyz.length / 3);
    kind.push(l.rail);
    let any = 0;
    for (const f of l.vf) any |= f;
    fl.push(any);
  }
  return { e_off: Uint32Array.from(off), e_xyz: Float32Array.from(xyz), e_vf: Uint8Array.from(vf), e_kind: Uint8Array.from(kind), e_flags: Uint8Array.from(fl) };
}

/** Vehicle lanes of a block for the transit matcher (world E/N/z). */
export function laneArrays(lanes: LaneRec[]): { arrays: Arrays; keys: string[]; next: string[]; groups: string[] } {
  const off = [0], xyz: number[] = [], vf: number[] = [], kind: number[] = [], cls: number[] = [], bidir: number[] = [], rank: number[] = [], rail: number[] = [], speed: number[] = [];
  const nxOff = [0], next: string[] = [], grp: number[] = [], groups: string[] = [];
  const gi = new Map<string, number>();
  for (const l of lanes) {
    xyz.push(...l.pts);
    vf.push(...l.vf);
    off.push(xyz.length / 3);
    kind.push(l.kind); cls.push(l.cls); bidir.push(l.bidir ? 1 : 0); rank.push(l.rank); rail.push(l.rail); speed.push(l.speed);
    next.push(...l.next);
    nxOff.push(next.length);
    if (l.group) {
      let k = gi.get(l.group);
      if (k === undefined) { k = groups.length; groups.push(l.group); gi.set(l.group, k); }
      grp.push(k);
    } else grp.push(0xffffffff);
  }
  return {
    arrays: {
      ln_off: Uint32Array.from(off), ln_xyz: Float32Array.from(xyz), ln_vf: Uint8Array.from(vf), ln_kind: Uint8Array.from(kind), ln_cls: Uint8Array.from(cls),
      ln_bidir: Uint8Array.from(bidir), ln_rank: Uint8Array.from(rank), ln_rail: Uint8Array.from(rail), ln_speed: Float32Array.from(speed),
      ln_next_off: Uint32Array.from(nxOff), ln_group: Uint32Array.from(grp),
    },
    keys: lanes.map((l) => l.key), next, groups,
  };
}

/** Major roads (ranks 0-2) for the region-wide congestion overlay (world E/N/z). */
export function majorArrays(pieces: Piece[], tol: number): { arrays: Arrays; names: string[] } {
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const off = [0], xyz: number[] = [], cls: number[] = [], lanes: number[] = [], oneway: number[] = [], len: number[] = [], name: number[] = [];
  for (const p of pieces) {
    if (!p.road || p.cls > 2 || p.vf.every((f) => f & VF_TUNNEL)) continue;
    const keep = simplify(p.pts, p.vf.map(() => 0), tol);
    let L = 0;
    for (let k = 0; k < keep.length; k++) {
      const i = keep[k];
      xyz.push(p.pts[i * 3], p.pts[i * 3 + 1], p.pts[i * 3 + 2]);
      if (k) { const j = keep[k - 1]; L += Math.hypot(p.pts[i * 3] - p.pts[j * 3], p.pts[i * 3 + 1] - p.pts[j * 3 + 1]); }
    }
    off.push(xyz.length / 3);
    cls.push(p.cls); lanes.push(Math.max(1, p.fwd)); oneway.push(p.oneway ? 1 : 0); len.push(L);
    let k = 0xffff;
    if (p.name) { k = nameIdx.get(p.name) ?? names.length; if (k === names.length) { names.push(p.name); nameIdx.set(p.name, k); } }
    name.push(k);
  }
  return {
    arrays: {
      s_off: Uint32Array.from(off), s_xyz: Float32Array.from(xyz), s_class: Uint8Array.from(cls), s_lanes: Uint8Array.from(lanes),
      s_oneway: Uint8Array.from(oneway), s_len: Float32Array.from(len), s_name: Uint16Array.from(name),
    },
    names,
  };
}
