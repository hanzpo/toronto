// Station geometry from the curated records: platforms snapped onto the
// tracks the trains run on, tactile edges, canopies / shelters, name boards,
// underground station boxes (walls, lit ceiling, TTC name tiles), surface
// entrances (TTC stair wells + sign posts, entrance pavilions) and bus-bay
// canopies. Everything is low-poly and emitted into three buffers per
// station (lit surface, unlit underground, textured signs) that the layer
// merges across nearby stations.
import type { Mode } from '../../transit';
import { SLOTS, type Slot } from './signs';
import { HEAVY, type LevelRec, type PlatRec, type StationRec } from './data';
import type { Poly, TrackIndex } from './tracks';
import { buildAllen } from './allen';

/** Allen Road station structures (./allen.ts); ?allen=0 turns them off (debug) */
const ALLEN_ON = !(typeof location !== 'undefined' && /[?&]allen=0\b/.test(location.search));

export type RGB = [number, number, number];
type V3 = [number, number, number];

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const lin = (c: RGB): RGB => c.map((v) => Math.pow(v, 2.2)) as RGB;
const C = {
  concrete: lin(hex(0xbab6ad)),
  concreteDark: lin(hex(0x8b877f)),
  edgeWhite: lin(hex(0xe8e6df)),
  tactile: lin(hex(0xf0c419)),
  roof: lin(hex(0xd4d7da)),
  roofUnder: lin(hex(0x7d838a)),
  steel: lin(hex(0x5b6168)),
  steelLight: lin(hex(0x9aa0a6)),
  glass: lin(hex(0x8fb3c4)),
  glassDark: lin(hex(0x4c6470)),
  goGreen: lin(hex(0x3d8b37)),
  upOrange: lin(hex(0xe8641b)),
  viaYellow: lin(hex(0xffd400)),
  ttcRed: lin(hex(0xda251d)),
  stairDark: lin(hex(0x2d2f33)),
  stairStep: lin(hex(0x6a6d72)),
  railing: lin(hex(0xb8bdc2)),
  asphalt: lin(hex(0x55575a)),
};

export class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  get tris() { return this.idx.length / 3; }

  quad(a: V3, b: V3, c: V3, d: V3, col: RGB, n?: V3, uv?: [number, number, number, number]) {
    let nn = n;
    if (!nn) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
      const l = Math.hypot(x, y, z) || 1;
      nn = [x / l, y / l, z / l];
    }
    const v = this.pos.length / 3;
    for (const p of [a, b, c, d]) { this.pos.push(p[0], p[1], p[2]); this.nrm.push(nn[0], nn[1], nn[2]); this.col.push(col[0], col[1], col[2]); }
    if (uv) this.uv.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
    this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }

  /** quad facing along +normal (winding fixed to match n) */
  face(a: V3, b: V3, c: V3, d: V3, col: RGB, n: V3, uv?: [number, number, number, number]) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    if (x * n[0] + y * n[1] + z * n[2] < 0) {
      this.quad(a, d, c, b, col, n, uv ? [uv[0], uv[1], uv[2], uv[3]] : undefined);
      if (uv) {
        // d,c,b ordering flips u: fix the 4 uv pairs just pushed
        const k = this.uv.length - 8;
        this.uv[k] = uv[0]; this.uv[k + 1] = uv[1];
        this.uv[k + 2] = uv[0]; this.uv[k + 3] = uv[3];
        this.uv[k + 4] = uv[2]; this.uv[k + 5] = uv[3];
        this.uv[k + 6] = uv[2]; this.uv[k + 7] = uv[1];
      }
    } else this.quad(a, b, c, d, col, n, uv);
  }
}

export interface Built {
  id: string;
  oe: number; on: number;
  lit: Geo;
  under: Geo;
  signs: Geo;
  boxes: StationBox[];
  /** geometry depends on terrain heights that weren't loaded yet */
  pending: boolean;
  /** label anchor elevation */
  labelH: number;
  /** clearance QA: platforms built, track centrelines found inside a platform envelope (edge − E) */
  qa: { platforms: number; intrusions: { lat: number; e: number; n: number }[]; columns?: [number, number][] };
}

/**
 * Underground station box geometry (for the cab-view tunnel code, see
 * `stationBoxesNear` in StationsLayer). Lateral offsets are measured along
 * the left normal of the path direction; heights relative to rail.
 */
export interface StationBox {
  id: string;
  name: string;
  mode: Mode;
  line?: string;
  /** reference-track samples, 4 m apart: E, N, rail elevation (datum m) */
  path: Float64Array;
  left: number;
  right: number;
  floor: number;
  ceiling: number;
  platforms: { a: number; b: number; top: number }[];
  /** TTC wall tile colour (0xRRGGBB) */
  wall: number;
}

interface Sample { e: number; n: number; z: number; nx: number; ny: number; s: number }

export interface BuildEnv {
  tracks: TrackIndex;
  /** every track of the rail network (sidings, freight, unused platforms' tracks) for clearance clipping */
  allTracks: TrackIndex | null;
  heightAt(e: number, n: number): number;
  hasHeights(e: number, n: number): boolean;
  wall: number;
  brand: 'ttc' | 'go' | 'up' | 'via' | 'lrt';
}

const EDGE: Record<string, number> = { subway: 1.6, lrt: 1.45, commuter_rail: 1.65, airport_rail: 1.65, intercity_rail: 1.65 };

function modeOk(lv: LevelRec): (p: Poly) => boolean {
  const heavy = HEAVY.has(lv.mode);
  const route = (lv.mode === 'subway' || lv.mode === 'lrt') && lv.line ? `ttc:${lv.line}` : null;
  return (p) => (heavy ? HEAVY.has(p.mode) : p.mode === lv.mode) && (!route || p.route === route);
}

interface PlatformPlan { ref: number; s0: number; s1: number; a: number; b: number; trackA: boolean; trackB: boolean; type: 'island' | 'side' }

/** Lateral positions (relative to the nearest track's left normal) of parallel tracks around a point. */
function parallelTracks(tr: TrackIndex, e: number, n: number, r: number, ok: (p: Poly) => boolean, ux: number, uy: number) {
  const hits = tr.near(e, n, r, ok);
  if (!hits.length) return null;
  const ref = hits[0];
  const sRef = tr.arc(ref.poly, ref.seg, ref.t);
  const [tx, ty] = tr.tangent(ref.poly, sRef);
  if (Math.abs(tx * ux + ty * uy) < 0.8) {
    // nearest track isn't parallel to the platform: pick the nearest parallel one
    const alt = hits.find((h) => { const s = tr.arc(h.poly, h.seg, h.t); const [ax, ay] = tr.tangent(h.poly, s); return Math.abs(ax * ux + ay * uy) > 0.9; });
    if (!alt) return null;
    return parallelFrom(tr, hits, alt, ok);
  }
  return parallelFrom(tr, hits, ref, ok);
}

function parallelFrom(tr: TrackIndex, hits: ReturnType<TrackIndex['near']>, ref: ReturnType<TrackIndex['near']>[number], _ok: (p: Poly) => boolean) {
  const sRef = tr.arc(ref.poly, ref.seg, ref.t);
  const [tx, ty] = tr.tangent(ref.poly, sRef);
  const nx = -ty, ny = tx;
  const lats: number[] = [0];
  for (const h of hits) {
    if (h.poly === ref.poly) continue;
    const s = tr.arc(h.poly, h.seg, h.t);
    const [qx, qy] = tr.tangent(h.poly, s);
    if (Math.abs(qx * tx + qy * ty) < 0.94) continue;
    lats.push((h.x - ref.x) * nx + (h.y - ref.y) * ny);
  }
  lats.sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const o of lats) if (!uniq.length || o - uniq[uniq.length - 1] > 1.4) uniq.push(o);
  return { ref: ref.poly, sRef, x: ref.x, y: ref.y, nx, ny, lats: uniq };
}

function planPlatforms(env: BuildEnv, lv: LevelRec): PlatformPlan[] {
  const tr = env.tracks;
  const ok = modeOk(lv);
  const E = EDGE[lv.mode] ?? 1.6;
  const out: PlatformPlan[] = [];
  const brg = (b: number) => [Math.sin((b * Math.PI) / 180), Math.cos((b * Math.PI) / 180)] as const;
  const clampS = (ref: number, sc: number, len: number): [number, number] => {
    const total = tr.length(ref);
    let s0 = sc - len / 2, s1 = sc + len / 2;
    if (s0 < 0) { s1 = Math.min(total, s1 - s0); s0 = 0; }
    if (s1 > total) { s0 = Math.max(0, s0 - (s1 - total)); s1 = total; }
    return [s0, s1];
  };
  if (lv.plats.length) {
    for (const p of lv.plats) out.push(...planCurated(env, lv, p, ok, E, brg, clampS));
    if (out.length) return out;
  }
  // no curated platform geometry: lay out from the tracks by the curated layout
  const [ux, uy] = brg(lv.bearing);
  const pt = parallelTracks(tr, lv.c[0], lv.c[1], HEAVY.has(lv.mode) ? 220 : 140, ok, ux, uy);
  if (!pt) return out;
  const [s0, s1] = clampS(pt.ref, pt.sRef, lv.len);
  const L = pt.lats.filter((o) => Math.abs(o) < (HEAVY.has(lv.mode) ? 40 : 20));
  const W = lv.mode === 'subway' ? 4 : lv.mode === 'lrt' ? 3.5 : 5;
  const side = (lat: number, dir: 1 | -1) => out.push(dir > 0
    ? { ref: pt.ref, s0, s1, a: lat + E, b: lat + E + W, trackA: true, trackB: false, type: 'side' }
    : { ref: pt.ref, s0, s1, a: lat - E - W, b: lat - E, trackA: false, trackB: true, type: 'side' });
  if (L.length === 1) {
    const stationSide = (lv.c[0] - pt.x) * pt.nx + (lv.c[1] - pt.y) * pt.ny >= 0 ? 1 : -1;
    if (lv.layout === 'side' && !HEAVY.has(lv.mode)) { side(L[0], -1); side(L[0], 1); }
    else side(L[0], stationSide as 1 | -1);
    return out;
  }
  if (lv.layout === 'island' || lv.layout === 'mixed') {
    // island between the widest-spaced adjacent pair; if the tracks are too
    // close for one (single-bore / shared alignment), spread them
    let bi = -1, bg = 0;
    for (let i = 0; i < L.length - 1; i++) { const g = L[i + 1] - L[i]; if (g > bg) { bg = g; bi = i; } }
    if (bi >= 0 && bg >= 2 * E + 3) {
      out.push({ ref: pt.ref, s0, s1, a: L[bi] + E, b: L[bi + 1] - E, trackA: true, trackB: true, type: 'island' });
      return out;
    }
  }
  side(L[0], -1);
  side(L[L.length - 1], 1);
  return out;
}

function planCurated(env: BuildEnv, _lv: LevelRec, p: PlatRec, ok: (p: Poly) => boolean, E: number,
  brg: (b: number) => readonly [number, number], clampS: (ref: number, sc: number, len: number) => [number, number]): PlatformPlan[] {
  const tr = env.tracks;
  const [ux, uy] = brg(p.b);
  const pt = parallelTracks(tr, p.c[0], p.c[1], p.w / 2 + 9, ok, ux, uy);
  if (!pt) return [];
  // platform centre in the reference frame
  const lc = (p.c[0] - pt.x) * pt.nx + (p.c[1] - pt.y) * pt.ny;
  // the reference hit is the platform centre's projection onto the track
  const [s0, s1] = clampS(pt.ref, pt.sRef, Math.max(p.len, p.lenFull ?? 0));
  const lats = pt.lats;
  let left: number | null = null, right: number | null = null;
  for (const o of lats) {
    if (o > lc && (left === null || o < left)) left = o;
    if (o < lc && (right === null || o > right)) right = o;
  }
  if (p.type === 'island') {
    if (left !== null && right !== null && left - right >= 2 * E + 2) {
      return [{ ref: pt.ref, s0, s1, a: right + E, b: left - E, trackA: true, trackB: true, type: 'island' }];
    }
    const t = left !== null && (right === null || left - lc < lc - right) ? left : right;
    if (t === null) return [];
    return t > lc
      ? [{ ref: pt.ref, s0, s1, a: t - E - p.w, b: t - E, trackA: false, trackB: true, type: 'side' }]
      : [{ ref: pt.ref, s0, s1, a: t + E, b: t + E + p.w, trackA: true, trackB: false, type: 'side' }];
  }
  // side: platform on the far side of its nearest track
  const t = left !== null && (right === null || left - lc < lc - right) ? left : right!;
  if (t === null || Math.abs(t - lc) > p.w / 2 + 6) return [];
  return t > lc
    ? [{ ref: pt.ref, s0, s1, a: t - E - p.w, b: t - E, trackA: false, trackB: true, type: 'side' }]
    : [{ ref: pt.ref, s0, s1, a: t + E, b: t + E + p.w, trackA: true, trackB: false, type: 'side' }];
}

/** arc position + signed lateral offset of point p relative to polyline `ref` (within 80 m) */
function project(tr: TrackIndex, ref: number, p: { e: number; n: number }): { s: number; lat: number } | null {
  const h = tr.near(p.e, p.n, 80, () => true).find((x) => x.poly === ref);
  if (!h) return null;
  const s = tr.arc(ref, h.seg, h.t);
  const [tx, ty] = tr.tangent(ref, s);
  return { s, lat: (p.e - h.x) * -ty + (p.n - h.y) * tx };
}

/**
 * Keep a platform clear of every other track (network tracks the trains of
 * this level don't use: sidings, freight bypasses, other lines): edges stay
 * ≥ E from any parallel track centreline except the ones it serves.
 */
function clipToTracks(env: BuildEnv, pl: PlatformPlan, E: number): PlatformPlan | null {
  const all = env.allTracks;
  if (!all) return pl;
  const tr = env.tracks;
  let { a, b } = pl;
  for (const f of [0.05, 0.3, 0.5, 0.7, 0.95]) {
    const s = pl.s0 + (pl.s1 - pl.s0) * f;
    const p = tr.at(pl.ref, s);
    const [tx, ty] = tr.tangent(pl.ref, s);
    const nx = -ty, ny = tx;
    for (const h of all.near(p.e, p.n, Math.max(Math.abs(a), Math.abs(b)) + E + 2, () => true)) {
      const sh = all.arc(h.poly, h.seg, h.t);
      const [qx, qy] = all.tangent(h.poly, sh, 4);
      if (Math.abs(qx * tx + qy * ty) < 0.9) continue;
      const lat = (h.x - p.e) * nx + (h.y - p.n) * ny;
      if (Math.abs(lat - (a - E)) < 1.0 || Math.abs(lat - (b + E)) < 1.0) continue; // the tracks it serves
      if (lat <= a - E || lat >= b + E) continue;
      // a track inside the platform envelope: cut the platform back on that side
      if (lat - a < b - lat) { a = lat + E; pl = { ...pl, trackA: true }; } else { b = lat - E; pl = { ...pl, trackB: true }; }
    }
  }
  if (b - a < 1.8) return null;
  return { ...pl, a, b };
}

function trackWithin(env: BuildEnv, e: number, n: number, r: number): boolean {
  const all = env.allTracks;
  return !!all && all.near(e, n, r, () => true).length > 0;
}

/** network track centrelines (any direction) closer than E − 0.15 m to the platform body */
function intrusions(env: BuildEnv, pl: PlatformPlan, E: number): { lat: number; e: number; n: number; s: number }[] {
  const all = env.allTracks;
  if (!all) return [];
  const tr = env.tracks;
  const out: { lat: number; e: number; n: number; s: number }[] = [];
  const n = Math.max(3, Math.ceil((pl.s1 - pl.s0) / 10));
  for (let k = 0; k <= n; k++) {
    const s = pl.s0 + ((pl.s1 - pl.s0) * k) / n;
    const p = tr.at(pl.ref, s);
    const [tx, ty] = tr.tangent(pl.ref, s);
    const nx = -ty, ny = tx;
    const a = pl.a, b = pl.b;
    for (const h of all.near(p.e, p.n, Math.max(Math.abs(a), Math.abs(b)) + E, () => true)) {
      const along = (h.x - p.e) * tx + (h.y - p.n) * ty;
      if (Math.abs(along) > 5) continue;
      const lat = (h.x - p.e) * nx + (h.y - p.n) * ny;
      if (Math.abs(lat - (a - E)) < 1.0 || Math.abs(lat - (b + E)) < 1.0) continue;
      if (lat > a - E + 0.15 && lat < b + E - 0.15) { out.push({ lat, e: h.x, n: h.y, s }); break; }
    }
  }
  return out;
}

function samples(tr: TrackIndex, ref: number, s0: number, s1: number, step: number): Sample[] {
  const nSeg = Math.max(2, Math.ceil((s1 - s0) / step));
  const out: Sample[] = [];
  for (let i = 0; i <= nSeg; i++) {
    const s = s0 + ((s1 - s0) * i) / nSeg;
    const p = tr.at(ref, s);
    const [tx, ty] = tr.tangent(ref, s);
    out.push({ e: p.e, n: p.n, z: p.z, nx: -ty, ny: tx, s });
  }
  // rail elevation is smoothed over the platform (stations are level)
  const zm = out.reduce((a, q) => a + q.z, 0) / out.length;
  const flat = Math.max(...out.map((q) => Math.abs(q.z - zm))) < 1.2;
  if (flat) for (const q of out) q.z = zm;
  return out;
}

// --------------------------------------------------------------------------------- builder

export function buildStation(st: StationRec, env: BuildEnv, lineBullets: string[]): Built {
  const oe = st.c[0], on = st.c[1];
  const lit = new Geo(), under = new Geo(), signs = new Geo();
  const P = (e: number, n: number, z: number): V3 => [e - oe, z, -(n - on)];
  const boxes: StationBox[] = [];
  let pending = false;
  let labelH = -Infinity;
  const tr = env.tracks;
  const surfacePlatformsAt: { e: number; n: number }[] = [];
  const qa: Built['qa'] = { platforms: 0, intrusions: [] };

  for (const lv of st.levels) {
    if (lv.landmark) continue;
    const plans = planPlatforms(env, lv).map((pl) => clipToTracks(env, pl, EDGE[lv.mode] ?? 1.6)).filter((pl): pl is PlatformPlan => !!pl);
    for (let i = 0; i < plans.length; i++) {
      // switches / crossovers at the platform ends: end the platform before them
      let pl = plans[i];
      for (let it = 0; it < 4; it++) {
        const bad = intrusions(env, pl, EDGE[lv.mode] ?? 1.6);
        if (!bad.length) break;
        const L = pl.s1 - pl.s0;
        const x = bad[0].s;
        if (x - pl.s0 < 0.35 * L) pl = { ...pl, s0: x + 4 };
        else if (pl.s1 - x < 0.35 * L) pl = { ...pl, s1: x - 4 };
        else break;
      }
      plans[i] = pl;
      qa.platforms++;
      qa.intrusions.push(...intrusions(env, pl, EDGE[lv.mode] ?? 1.6));
    }
    if (!plans.length) continue;
    const heavy = HEAVY.has(lv.mode);
    const E = EDGE[lv.mode] ?? 1.6;
    // underground: the curated grade, confirmed by the actual rail depth
    const mid = plans[0];
    const pm = tr.at(mid.ref, (mid.s0 + mid.s1) / 2);
    if (!env.hasHeights(pm.e, pm.n)) pending = true;
    const ground = env.heightAt(pm.e, pm.n);
    const isUnder = lv.grade === 'underground' && ground - pm.z > 3.5;
    labelH = Math.max(labelH, isUnder ? ground : Math.max(ground, pm.z + 4));
    const g = isUnder ? under : lit;
    const H = lv.h;
    // box extents over all platforms of this level (in the first plan's frame)
    let boxA = Infinity, boxB = -Infinity, boxS0 = Infinity, boxS1 = -Infinity;
    const boxPlats: { a: number; b: number; top: number }[] = [];
    for (const pl of plans) {
      const S = samples(tr, pl.ref, pl.s0, pl.s1, heavy ? 12 : 8);
      const Q = (i: number, lat: number, dy: number): V3 => { const q = S[i]; return P(q.e + q.nx * lat, q.n + q.ny * lat, q.z + dy); };
      const up: V3 = [0, 1, 0];
      const bottom = isUnder ? -0.3 : lv.grade === 'elevated' ? -1.2 : -0.35;
      const ta = pl.trackA ? pl.a + 0.6 : pl.a, tb = pl.trackB ? pl.b - 0.6 : pl.b;
      const wa = pl.trackA ? ta + 0.1 : ta, wb = pl.trackB ? tb - 0.1 : tb;
      const conc = C.concrete;
      for (let i = 0; i < S.length - 1; i++) {
        // top: concrete, white safety line, yellow tactile strip at the track edges
        g.face(Q(i, wa, H), Q(i + 1, wa, H), Q(i + 1, wb, H), Q(i, wb, H), conc, up);
        if (pl.trackA) {
          g.face(Q(i, pl.a, H), Q(i + 1, pl.a, H), Q(i + 1, ta, H), Q(i, ta, H), C.tactile, up);
          g.face(Q(i, ta, H), Q(i + 1, ta, H), Q(i + 1, wa, H), Q(i, wa, H), C.edgeWhite, up);
        }
        if (pl.trackB) {
          g.face(Q(i, tb, H), Q(i + 1, tb, H), Q(i + 1, pl.b, H), Q(i, pl.b, H), C.tactile, up);
          g.face(Q(i, wb, H), Q(i + 1, wb, H), Q(i + 1, tb, H), Q(i, tb, H), C.edgeWhite, up);
        }
        const q = S[i];
        g.face(Q(i, pl.a, bottom), Q(i + 1, pl.a, bottom), Q(i + 1, pl.a, H), Q(i, pl.a, H), C.concreteDark, [-q.nx, 0, q.ny]);
        g.face(Q(i, pl.b, bottom), Q(i + 1, pl.b, bottom), Q(i + 1, pl.b, H), Q(i, pl.b, H), C.concreteDark, [q.nx, 0, -q.ny]);
      }
      const last = S.length - 1;
      const t0 = S[0], tl = S[last];
      g.face(Q(0, pl.a, bottom), Q(0, pl.b, bottom), Q(0, pl.b, H), Q(0, pl.a, H), C.concreteDark, [-t0.ny, 0, -t0.nx]);
      g.face(Q(last, pl.a, bottom), Q(last, pl.b, bottom), Q(last, pl.b, H), Q(last, pl.a, H), C.concreteDark, [tl.ny, 0, tl.nx]);

      const w = pl.b - pl.a;
      const midLat = (pl.a + pl.b) / 2;
      const along = (i: number): V3 => [S[i].ny, 0, S[i].nx];
      const sMid = (pl.s0 + pl.s1) / 2;
      if (isUnder) {
        // lateral box extent: platform plus the adjacent track(s) and a walkway
        // express this platform in the box frame (the first plan's reference track)
        const ref0 = plans[0].ref;
        let da = 0, s0 = pl.s0, s1 = pl.s1;
        if (pl.ref !== ref0) {
          const pa = project(tr, ref0, tr.at(pl.ref, pl.s0)), pb = project(tr, ref0, tr.at(pl.ref, pl.s1));
          const pmid = tr.at(pl.ref, (pl.s0 + pl.s1) / 2), qm = project(tr, ref0, pmid);
          if (!pa || !pb || !qm || Math.abs(pb.s - pa.s) > 3 * (pl.s1 - pl.s0) + 20) continue;
          s0 = Math.min(pa.s, pb.s); s1 = Math.max(pa.s, pb.s);
          da = qm.lat;
          // the other track may run the opposite way: flip lateral order
          const [t0x, t0y] = tr.tangent(ref0, qm.s), [t1x, t1y] = tr.tangent(pl.ref, (pl.s0 + pl.s1) / 2);
          if (t0x * t1x + t0y * t1y < 0) { const a = -pl.b, b = -pl.a; boxA = Math.min(boxA, da + a - (pl.trackB ? 2 * E + 0.6 : 0.2)); boxB = Math.max(boxB, da + b + (pl.trackA ? 2 * E + 0.6 : 0.2)); boxS0 = Math.min(boxS0, s0); boxS1 = Math.max(boxS1, s1); boxPlats.push({ a: da + a, b: da + b, top: H }); continue; }
        }
        boxA = Math.min(boxA, da + (pl.trackA ? pl.a - 2 * E - 0.6 : pl.a - 0.2));
        boxB = Math.max(boxB, da + (pl.trackB ? pl.b + 2 * E + 0.6 : pl.b + 0.2));
        boxS0 = Math.min(boxS0, s0); boxS1 = Math.max(boxS1, s1);
        boxPlats.push({ a: da + pl.a, b: da + pl.b, top: H });
        continue;
      }
      surfacePlatformsAt.push({ e: pm.e, n: pm.n });
      // ---- Allen Road median stations: enclosure, roof, concourses (./allen.ts) replace the canopy
      if (ALLEN_ON && lv.structure && pl.trackA && pl.trackB) {
        const total = tr.length(pl.ref);
        const SX = samples(tr, pl.ref, Math.max(0, pl.s0 - 45), Math.min(total, pl.s1 + 45), 4);
        const res = buildAllen(lv.structure, {
          g, S: SX, s0: pl.s0, s1: pl.s1, a: pl.a, b: pl.b, E, H, P,
          heightAt: (e, n) => env.heightAt(e, n),
          trackNear: (e, n, r) => trackWithin(env, e, n, r),
        });
        qa.columns = (qa.columns ?? []).concat(res.cols);
      }
      // ---- canopy
      let canopyLen = 0;
      if (heavy) canopyLen = lv.canopy_len ?? Math.min(pl.s1 - pl.s0, lv.mode === 'airport_rail' ? 90 : lv.mode === 'intercity_rail' ? 40 : Math.max(60, (pl.s1 - pl.s0) * 0.4));
      else if (lv.mode === 'subway') canopyLen = pl.s1 - pl.s0; // Kipling, Davisville, Wilson…: covered platforms
      else if (lv.mode === 'lrt') canopyLen = Math.min(28, pl.s1 - pl.s0);
      if (ALLEN_ON && lv.structure) canopyLen = 0;
      if (canopyLen > 0 && w >= 2.4) {
        const roofY = H + (heavy ? 3.9 : 3.3);
        const ca = pl.trackA ? pl.a + 0.35 : pl.a - 0.2, cb = pl.trackB ? pl.b - 0.35 : pl.b + 0.2;
        const trim = lv.mode === 'commuter_rail' ? C.goGreen : lv.mode === 'airport_rail' ? C.upOrange : lv.mode === 'intercity_rail' ? C.viaYellow : lv.mode === 'lrt' ? C.steelLight : C.ttcRed;
        const postLat = pl.trackA && pl.trackB ? midLat : pl.trackA ? pl.b - 0.6 : pl.a + 0.6;
        let lastPost = -1e9;
        for (let i = 0; i < S.length - 1; i++) {
          const sm = (S[i].s + S[i + 1].s) / 2;
          if (Math.abs(sm - sMid) > canopyLen / 2) continue;
          const q = S[i];
          g.face(Q(i, ca, roofY + 0.28), Q(i + 1, ca, roofY + 0.28), Q(i + 1, cb, roofY + 0.28), Q(i, cb, roofY + 0.28), C.roof, up);
          g.face(Q(i, ca, roofY), Q(i + 1, ca, roofY), Q(i + 1, cb, roofY), Q(i, cb, roofY), C.roofUnder, [0, -1, 0]);
          g.face(Q(i, ca, roofY), Q(i + 1, ca, roofY), Q(i + 1, ca, roofY + 0.28), Q(i, ca, roofY + 0.28), trim, [-q.nx, 0, q.ny]);
          g.face(Q(i, cb, roofY), Q(i + 1, cb, roofY), Q(i + 1, cb, roofY + 0.28), Q(i, cb, roofY + 0.28), trim, [q.nx, 0, -q.ny]);
          if (S[i].s - lastPost >= (heavy ? 12 : 9)) {
            lastPost = S[i].s;
            // never on or next to a track (crossovers, other lines): ≥ 2.2 m clearance
            if (!trackWithin(env, q.e + q.nx * postLat, q.n + q.ny * postLat, 2.2)) post(g, Q(i, postLat, H), 0.26, roofY - H, C.steel);
          }
        }
        // canopy end caps
        const iA = S.findIndex((q) => Math.abs(q.s - sMid) <= canopyLen / 2 + 0.01);
        let iB = -1;
        for (let i = S.length - 1; i >= 0; i--) if (Math.abs(S[i].s - sMid) <= canopyLen / 2 + 0.01) { iB = i; break; }
        if (iA >= 0 && iB > iA) {
          for (const [i, sg] of [[iA, -1], [Math.min(iB, S.length - 1), 1]] as const) {
            const q = S[i];
            g.face(Q(i, ca, roofY), Q(i, cb, roofY), Q(i, cb, roofY + 0.28), Q(i, ca, roofY + 0.28), trim, [sg * q.ny, 0, sg * q.nx]);
          }
        }
      }
      // ---- GO / UP waiting shelters and tunnel stair/elevator head (island platforms)
      if (heavy && w >= 3.2) {
        const im = Math.floor(S.length / 2);
        const sw = Math.min(2.4, w - 1.2);
        for (const off of [-0.32, 0.32]) {
          const i = Math.max(0, Math.min(S.length - 1, Math.round(im + off * S.length)));
          oriented(g, Q(i, midLat, H), along(i), 7, sw, 0, 2.5, C.glass);
          oriented(g, Q(i, midLat, H), along(i), 7.4, sw + 0.3, 2.5, 2.75, C.steel);
        }
        if (pl.trackA && pl.trackB && w >= 5) {
          const i = Math.max(0, Math.min(S.length - 1, Math.round(im - 0.12 * S.length)));
          oriented(g, Q(i, midLat, H), along(i), 8, Math.min(4, w - 1.4), 0, 3.3, C.glassDark);
          oriented(g, Q(i, midLat, H), along(i), 8.6, Math.min(4.6, w - 0.8), 3.3, 3.55, C.roof);
          signQuad(signs, Q(i, midLat, H + 3.6), along(i), 1.6, 0.8, lv.mode === 'airport_rail' ? 'uplog' : 'golog', P);
        }
      }
      // ---- LRT shelter
      if (lv.mode === 'lrt' && w >= 2.4) {
        const i = Math.floor(S.length / 2);
        oriented(g, Q(i, midLat, H), along(i), 6, Math.min(1.8, w - 0.8), 0, 2.4, C.glass);
      }
      // ---- light standards along GO platforms
      if (heavy) {
        for (let i = 1; i < S.length - 1; i += 2) {
          const sm = S[i].s;
          if (Math.abs(sm - sMid) < canopyLen / 2 + 4) continue;
          const lat = pl.trackA && pl.trackB ? midLat : pl.trackA ? pl.b - 0.5 : pl.a + 0.5;
          post(g, Q(i, lat, H), 0.14, 5.5, C.steelLight);
          oriented(g, Q(i, lat, H), along(i), 0.9, 0.35, 5.3, 5.55, C.steel);
        }
      }
      // ---- name boards on posts every ~45 m (both faces)
      const slot: Slot = heavy ? 'go' : 'board';
      const boardW = heavy ? 3.4 : 3.0;
      const step = Math.max(1, Math.round(45 / ((pl.s1 - pl.s0) / (S.length - 1))));
      for (let i = Math.max(1, Math.floor(step / 2)); i < S.length - 1; i += step) {
        const lat = pl.trackA && pl.trackB ? midLat : pl.trackA ? pl.b - 0.9 : pl.a + 0.9;
        const c = Q(i, lat, H);
        const d = along(i);
        post(g, [c[0] + d[0] * (boardW / 2 - 0.2), c[1], c[2] + d[2] * (boardW / 2 - 0.2)], 0.1, 2.3, C.steel);
        post(g, [c[0] - d[0] * (boardW / 2 - 0.2), c[1], c[2] - d[2] * (boardW / 2 - 0.2)], 0.1, 2.3, C.steel);
        signPanel(signs, [c[0], c[1] + 2.3, c[2]], d, boardW, boardW * 0.2, slot);
      }
    }
    if (isUnder && boxS1 - boxS0 > 400) { boxS1 = boxS0 + 400; }
    if (isUnder && boxA < boxB && boxB - boxA < 60) {
      const ref = plans[0].ref;
      buildBox(under, signs, tr, ref, boxS0 - 6, boxS1 + 6, boxA - 0.6, boxB + 0.6, env.wall, H, P);
      const S4 = samples(tr, ref, boxS0 - 6, boxS1 + 6, 4);
      const path = new Float64Array(S4.length * 3);
      S4.forEach((q, i) => { path[3 * i] = q.e; path[3 * i + 1] = q.n; path[3 * i + 2] = q.z; });
      boxes.push({ id: st.id, name: st.name, mode: lv.mode, line: lv.line, path, left: boxB + 0.6, right: boxA - 0.6, floor: -0.3, ceiling: 5.8, platforms: boxPlats, wall: env.wall });
    }
  }

  // ---- surface entrances
  const lvC = st.levels.map((l) => l.c);
  for (const en of st.ents) {
    if (en.k === 'underground' || en.k === 'path' || env.brand === 'lrt') continue;
    const [e, n] = en.p;
    if (!env.hasHeights(e, n)) { pending = true; continue; }
    const h = env.heightAt(e, n);
    // stairs descend toward the station
    let tx = 0, ty = 1;
    if (en.b !== undefined) { tx = Math.sin((en.b * Math.PI) / 180); ty = Math.cos((en.b * Math.PI) / 180); }
    else {
      let best = Infinity;
      for (const c of lvC) { const d = Math.hypot(c[0] - e, c[1] - n); if (d < best && d > 1) { best = d; tx = (c[0] - e) / d; ty = (c[1] - n) / d; } }
    }
    const d3: V3 = [tx, 0, -ty];
    const base = P(e, n, h);
    const ttc = env.brand === 'ttc';
    if (en.k === 'stair' && ttc) {
      stairwell(lit, base, d3, 2.6, 6.5);
      // sign post at the head of the stairs
      const sp: V3 = [base[0] - d3[0] * 3.9 + d3[2] * 1.7, base[1], base[2] - d3[2] * 3.9 - d3[0] * 1.7];
      post(lit, sp, 0.12, 3.0, C.steel);
      signBox(signs, lit, [sp[0], sp[1] + 3.0, sp[2]], [d3[2], 0, -d3[0]], 1.0, 0.5, 'ttc');
    } else if (en.k === 'pavilion' || (en.k === 'stair' && !ttc) || en.k === 'elevator') {
      const L = en.k === 'elevator' ? 3 : 7, W = en.k === 'elevator' ? 3 : 4.6;
      oriented(lit, base, d3, L, W, -0.2, 3.2, C.glass);
      oriented(lit, base, d3, L + 0.8, W + 0.8, 3.2, 3.5, C.steel);
      // door (dark) on the street side
      const fx = base[0] - d3[0] * (L / 2 + 0.02), fz = base[2] - d3[2] * (L / 2 + 0.02);
      const rx = d3[2], rz = -d3[0];
      lit.face([fx - rx * 0.9, base[1], fz - rz * 0.9], [fx + rx * 0.9, base[1], fz + rz * 0.9], [fx + rx * 0.9, base[1] + 2.3, fz + rz * 0.9], [fx - rx * 0.9, base[1] + 2.3, fz - rz * 0.9], C.stairDark, [-d3[0], 0, -d3[2]]);
      signBox(signs, lit, [fx - d3[0] * 0.3, base[1] + 3.55, fz - d3[2] * 0.3], [rx, 0, rz], 1.8, 0.9, ttc ? 'ttc' : env.brand === 'up' ? 'uplog' : env.brand === 'via' ? 'vialog' : 'golog');
    } else if (en.k === 'building') {
      // entrance inside a building: a free-standing sign post at the door
      post(lit, base, 0.1, 2.7, C.steel);
      signBox(signs, lit, [base[0], base[1] + 2.7, base[2]], [d3[2], 0, -d3[0]], 0.8, 0.4, ttc ? 'ttc' : env.brand === 'up' ? 'uplog' : 'golog');
    }
  }

  // ---- bus terminal canopies
  for (const b of st.bus) {
    const [e, n] = b.c;
    if (!env.hasHeights(e, n)) { pending = true; continue; }
    const h = env.heightAt(e, n);
    const d: V3 = [Math.sin((b.b * Math.PI) / 180), 0, -Math.cos((b.b * Math.PI) / 180)];
    const L = Math.min(60, b.l * 0.6), W = 4;
    const c = P(e, n, h);
    oriented(lit, c, d, L, W + 1, -0.3, 0.18, C.concrete);
    oriented(lit, c, d, L + 1, W + 2, 3.6, 3.85, C.roof);
    for (let x = -L / 2 + 2; x <= L / 2 - 2; x += 8) post(lit, [c[0] + d[0] * x, c[1] + 0.18, c[2] + d[2] * x], 0.25, 3.45, C.steel);
  }
  if (!Number.isFinite(labelH)) labelH = env.hasHeights(oe, on) ? env.heightAt(oe, on) : 0;
  void lineBullets; void surfacePlatformsAt;
  return { id: st.id, oe, on, lit, under, signs, boxes, pending, labelH, qa };
}

// --------------------------------------------------------------------------------- pieces

function post(g: Geo, p: V3, w: number, h: number, c: RGB) {
  const x0 = p[0] - w / 2, x1 = p[0] + w / 2, z0 = p[2] - w / 2, z1 = p[2] + w / 2, y0 = p[1], y1 = p[1] + h;
  g.face([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], c, [0, 0, -1]);
  g.face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], c, [0, 0, 1]);
  g.face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], c, [-1, 0, 0]);
  g.face([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], c, [1, 0, 0]);
}

/** box centred at c (three coords), long axis d (unit, horizontal), y relative to c */
function oriented(g: Geo, c: V3, d: V3, len: number, wid: number, y0: number, y1: number, col: RGB) {
  const r: V3 = [d[2], 0, -d[0]];
  const hl = len / 2, hw = wid / 2;
  const K = (a: number, s: number, y: number): V3 => [c[0] + d[0] * a + r[0] * s, c[1] + y, c[2] + d[2] * a + r[2] * s];
  g.face(K(-hl, -hw, y1), K(hl, -hw, y1), K(hl, hw, y1), K(-hl, hw, y1), col, [0, 1, 0]);
  g.face(K(-hl, hw, y0), K(hl, hw, y0), K(hl, hw, y1), K(-hl, hw, y1), col, r);
  g.face(K(-hl, -hw, y0), K(hl, -hw, y0), K(hl, -hw, y1), K(-hl, -hw, y1), col, [-r[0], 0, -r[2]]);
  g.face(K(hl, -hw, y0), K(hl, hw, y0), K(hl, hw, y1), K(hl, -hw, y1), col, d);
  g.face(K(-hl, -hw, y0), K(-hl, hw, y0), K(-hl, hw, y1), K(-hl, -hw, y1), col, [-d[0], 0, -d[2]]);
}

/** TTC sidewalk stairwell: dark opening with step stripes, railings on three sides */
function stairwell(g: Geo, c: V3, d: V3, wid: number, len: number) {
  const r: V3 = [d[2], 0, -d[0]];
  const hl = len / 2, hw = wid / 2;
  const K = (a: number, s: number, y: number): V3 => [c[0] + d[0] * a + r[0] * s, c[1] + y, c[2] + d[2] * a + r[2] * s];
  const y = 0.04;
  g.face(K(-hl, -hw, y), K(hl, -hw, y), K(hl, hw, y), K(-hl, hw, y), C.stairDark, [0, 1, 0]);
  for (let a = -hl + 0.5; a < hl - 0.2; a += 0.55) {
    const f = (a + hl) / len;
    const col: RGB = C.stairStep.map((v) => v * (1 - 0.7 * f)) as RGB;
    g.face(K(a, -hw + 0.1, y + 0.005), K(a + 0.08, -hw + 0.1, y + 0.005), K(a + 0.08, hw - 0.1, y + 0.005), K(a, hw - 0.1, y + 0.005), col, [0, 1, 0]);
  }
  // low walls / railings: two long sides and the far end
  const rh = 1.05, t = 0.12;
  oriented(g, K(0, -hw - t / 2, 0), d, len, t, 0, rh, C.railing);
  oriented(g, K(0, hw + t / 2, 0), d, len, t, 0, rh, C.railing);
  oriented(g, K(hl + t / 2, 0, 0), d, t, wid + 2 * t, 0, rh, C.railing);
  // TTC red handrail cap
  oriented(g, K(0, -hw - t / 2, 0), d, len, t * 1.4, rh, rh + 0.06, C.ttcRed);
  oriented(g, K(0, hw + t / 2, 0), d, len, t * 1.4, rh, rh + 0.06, C.ttcRed);
}

/** double-sided panel standing on its bottom edge centre, face normal ⟂ d */
function signPanel(sg: Geo, c: V3, d: V3, w: number, h: number, slot: Slot) {
  const n: V3 = [d[2], 0, -d[0]];
  const hw = w / 2;
  const a: V3 = [c[0] - d[0] * hw, c[1], c[2] - d[2] * hw], b: V3 = [c[0] + d[0] * hw, c[1], c[2] + d[2] * hw];
  const o = 0.03;
  const uv = SLOTS[slot];
  // front (normal n): left→right = a→b when viewed from the n side means d = -right… keep text readable on both faces
  sg.face([b[0] + n[0] * o, b[1], b[2] + n[2] * o], [a[0] + n[0] * o, a[1], a[2] + n[2] * o], [a[0] + n[0] * o, a[1] + h, a[2] + n[2] * o], [b[0] + n[0] * o, b[1] + h, b[2] + n[2] * o], [1, 1, 1], n, uv);
  sg.face([a[0] - n[0] * o, a[1], a[2] - n[2] * o], [b[0] - n[0] * o, b[1], b[2] - n[2] * o], [b[0] - n[0] * o, b[1] + h, b[2] - n[2] * o], [a[0] - n[0] * o, a[1] + h, a[2] - n[2] * o], [1, 1, 1], [-n[0], 0, -n[2]], uv);
}

/** thin sign box (lit geometry) with the logo on both faces; c = bottom centre, d = along the face */
function signBox(sg: Geo, g: Geo, c: V3, d: V3, w: number, h: number, slot: Slot) {
  oriented(g, c, d, w + 0.06, 0.12, -0.03, h + 0.03, C.steel);
  signPanel(sg, c, d, w, h, slot);
  void g;
}

/** horizontal logo on top of a structure, readable from both sides */
function signQuad(sg: Geo, c: V3, d: V3, w: number, h: number, slot: Slot, _P: unknown) {
  signPanel(sg, c, d, w, h, slot);
}

/** underground station box: floor, walls with tile band + name tiles, lit ceiling, end walls */
function buildBox(g: Geo, sg: Geo, tr: TrackIndex, ref: number, s0: number, s1: number, a: number, b: number, wall: number, H: number,
  P: (e: number, n: number, z: number) => V3) {
  const S = samples(tr, ref, s0, s1, 6);
  const Q = (i: number, lat: number, dy: number): V3 => { const q = S[i]; return P(q.e + q.nx * lat, q.n + q.ny * lat, q.z + dy); };
  const wallRGB = lin(hex(wall));
  const lightWall: RGB = [0.62, 0.6, 0.56];
  const dark: RGB = [0.08, 0.08, 0.08];
  const ceilY = 5.8, floorY = -0.3;
  const bandLo = H + 0.9, bandHi = H + 3.2;
  for (let i = 0; i < S.length - 1; i++) {
    const q = S[i];
    const lit = 0.85 + 0.25 * Math.sin(i * 1.7);
    const sc = (c: RGB, k = 1): RGB => [c[0] * k * lit, c[1] * k * lit, c[2] * k * lit];
    // floor (track bed)
    g.face(Q(i, a, floorY), Q(i + 1, a, floorY), Q(i + 1, b, floorY), Q(i, b, floorY), dark, [0, 1, 0]);
    // ceiling, with a light strip over each third
    g.face(Q(i, a, ceilY), Q(i + 1, a, ceilY), Q(i + 1, b, ceilY), Q(i, b, ceilY), sc([0.32, 0.32, 0.31]), [0, -1, 0]);
    for (const f of [0.3, 0.7]) {
      const l = a + (b - a) * f;
      g.face(Q(i, l - 0.25, ceilY - 0.05), Q(i + 1, l - 0.25, ceilY - 0.05), Q(i + 1, l + 0.25, ceilY - 0.05), Q(i, l + 0.25, ceilY - 0.05), [1.6, 1.52, 1.3], [0, -1, 0]);
    }
    // walls: lower dark band, TTC tile colour band, pale upper wall (both sides face inward)
    for (const [lat, nrm] of [[a, [q.nx, 0, -q.ny]], [b, [-q.nx, 0, q.ny]]] as [number, V3][]) {
      g.face(Q(i, lat, floorY), Q(i + 1, lat, floorY), Q(i + 1, lat, bandLo), Q(i, lat, bandLo), sc([0.18, 0.18, 0.18]), nrm);
      g.face(Q(i, lat, bandLo), Q(i + 1, lat, bandLo), Q(i + 1, lat, bandHi), Q(i, lat, bandHi), sc(wallRGB, 1.25), nrm);
      g.face(Q(i, lat, bandHi), Q(i + 1, lat, bandHi), Q(i + 1, lat, ceilY), Q(i, lat, ceilY), sc(lightWall), nrm);
    }
  }
  // end walls
  const last = S.length - 1;
  for (const [i, sgn] of [[0, 1], [last, -1]] as const) {
    const q = S[i];
    g.face(Q(i, a, floorY), Q(i, b, floorY), Q(i, b, ceilY), Q(i, a, ceilY), [0.2, 0.2, 0.2], [sgn * q.ny, 0, sgn * q.nx]);
  }
  // name tiles along both walls every ~18 m
  const perTile = Math.max(1, Math.round(18 / ((s1 - s0) / last)));
  for (let i = 1; i < last; i += perTile) {
    const q = S[i];
    for (const [lat, sgn] of [[a + 0.03, 1], [b - 0.03, -1]] as const) {
      const c = Q(i, lat, H + 1.55);
      const n: V3 = [sgn * q.nx, 0, -sgn * q.ny];
      const w = 3.6, h = 0.45;
      // text reads left→right for a viewer facing the wall (right = n × up … = (n.z, 0, -n.x))
      const r: V3 = [n[2] * w / 2, 0, -n[0] * w / 2];
      sg.face([c[0] - r[0], c[1], c[2] - r[2]], [c[0] + r[0], c[1], c[2] + r[2]], [c[0] + r[0], c[1] + h, c[2] + r[2]], [c[0] - r[0], c[1] + h, c[2] - r[2]], [1, 1, 1], n, SLOTS.tile);
    }
  }
}
