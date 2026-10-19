// Local tunnel / track geometry around a player-attached vehicle (cab, chase
// and window views). Only a window of the pattern path near the vehicle is
// built (rebuilt as it moves); everything is merged into one vertex-coloured
// mesh plus a few instanced furniture meshes.
//
// Cross-section (TTC references in docs/STATIONS.md "Cab-view tunnel"):
// - the section follows the tracks, not a fixed width: the parallel tracks of
//   the same kind through each cross-section come from the rail network
//   (railNet.ts). Tracks up to GROUP_GAP apart share one cut-and-cover box
//   whose walls stand BOX_SIDE (2.05 m) beyond the outer track centres —
//   8.5 m wide over the usual 4.45 m track spacing, 4.65 m high (floor to
//   soffit), a row of clad steel columns between the tracks;
// - a track alone (twin further than GROUP_GAP, i.e. its own bore) is a
//   single-track tube in the bored sections (TUBES: North Yonge 4.9 m,
//   TYSSE 5.4 m, Line 4 5.2 m, Line 5 5.75 m internal diameter) with a
//   walkway on the cross-passage side, else a 4.3 m single-track box;
// - underground station boxes are drawn by the stations layer
//   (stationBoxesNear, layers/stations/build.ts): the tunnel stops at the box
//   ends and closes them with headwalls that have the running tunnels'
//   openings.
// Furniture: rails + tie pattern, TTC covered third rail (away from the
// platform, gaps at switches), cable trays, light fixtures every 10 m (with
// matching light pools in the shader), ring joints in tubes and construction
// joints in boxes (shader), wayside signals at the rail sim's block
// boundaries (150 m per edge, restarting at every graph node; aspects from
// the other trains' positions), emergency exits every 250 m (door, green EXIT
// sign, blue emergency-power light; cross-passage doors in tubes).
import * as THREE from 'three/webgpu';
import { abs, attribute, exp, float, floor, fract, length, max, min, mix, positionView, smoothstep, step, vec3, vec4 } from 'three/tsl';
import type { Mode } from '../transit';
import type { PatternPath } from './path';
import { stationBoxesNear, type StationBox } from '../layers/StationsLayer';
import { BOX_SIDE } from '../layers/stations/build';
import { nodesNear, parallelLats, railNet, type NetKind, type RailNet } from './railNet';

type P2 = number[];

const STEP = 4;
const BACK = 220;
const AHEAD = 650;
const END_EXT = 110;
const REBUILD = 90;

/** tracks this close (m) share one box */
const GROUP_GAP = 6.8;
/** running box: floor, soffit (relative to the rail), haunch */
const FLOOR = -0.35;
const SOFFIT = 4.3;
const HAUNCH = 0.35;
/** rail gauge half (1495 mm TTC gauge) */
const G2 = 0.7475;
/** third rail centre from the track centre (m), cover board height */
const THIRD = 1.43;
/** light fixture spacing (m) and phase (fixtures at s ≡ LIGHT_PHASE) */
const LIGHT_EVERY = 10;
const LIGHT_PHASE = 5;
const EXIT_EVERY = 250;
const BLOCK: Record<NetKind, number> = { 0: 800, 1: 150, 2: 150, 3: 120 };

/**
 * Bored single-track tube sections between consecutive stations (base names,
 * alphabetical) → internal diameter (m). Transit Toronto / Wikipedia: North
 * Yonge extension shield / TBM tunnels Eglinton–Lawrence–York Mills–Sheppard
 * (4.9 m ID, 0.6 m rings), TYSSE Sheppard West–Vaughan (6.0–6.1 m bore, ≈5.4 m
 * ID), Line 4 Sheppard (TBM, ≈5.2 m), Line 1 under Queen's Park (bored),
 * Line 5 Eglinton Crosstown Keelesdale–Laird (6.5 m bore, ≈5.75 m ID).
 */
const TUBES = new Map<string, number>();
{
  const add = (d: number, ...names: string[]) => { for (let i = 0; i + 1 < names.length; i++) TUBES.set([names[i], names[i + 1]].sort().join('|'), d); };
  add(4.9, 'eglinton', 'lawrence', 'york mills', 'sheppard-yonge');
  add(5.4, 'sheppard west', 'downsview park', 'finch west', 'york university', 'pioneer village', 'highway 407', 'vaughan metropolitan centre');
  add(5.2, 'sheppard-yonge', 'bayview', 'bessarion', 'leslie', 'don mills');
  add(5.2, "queen's park", 'museum');
  add(5.75, 'keelesdale', 'caledonia', 'fairbank', 'oakwood', 'cedarvale', 'forest hill', 'chaplin', 'avenue', 'eglinton', 'mount pleasant', 'leaside', 'laird');
}
const baseName = (s: string) => s.split(' - ')[0].replace(/\s+(Station|Stn)$/i, '').replace(/\s+LRT$/i, '').trim().toLowerCase();

const enum T { OPEN = 0, BOX = 1, TUBE = 2, BOX1 = 3 }

// sRGB colours
const COL = {
  concrete: 0x9d998f, // matches the portal trench walls (render/tiles/groundMaterial.ts class 34)
  head: 0x8a867d,
  lining: 0x8f8d87,
  floor: 0x3b3834,
  walkway: 0xa39f96,
  railSide: 0x6d6a66,
  railHead: 0xc9c6c0,
  tray: 0x7b7e80,
  cable: 0x2b2b2d,
  third: 0x55544f,
  board: 0xb49c62,
};

/** surface kinds for the shader (tuv.z): 1 tube lining · 2 box concrete · 3 track bed · 4 plain · 5 unlit-pool (above ground / in stations) */
const K_TUBE = 1, K_BOX = 2, K_BED = 3, K_PLAIN = 4, K_OPEN = 5;

export interface TunnelEnv {
  heightAt(e: number, n: number): number;
  dataRoot(): string;
  /** other trains near the path: centre E/N, heading (rad CCW from +E), length */
  trains(out: { e: number; n: number; heading: number; length: number }[]): number;
}

interface Sec {
  t: T;
  L: number; R: number;
  D: number;
  /** nearest parallel track left (<0) / right (>0) within 12 m, NaN none */
  twL: number; twR: number;
  /** third rail side (+1 right, −1 left, 0 none) */
  third: number;
}

/** item emitted per segment: profile polyline in (x right, y up) rail-relative coords */
interface Prof { pts: P2; col: number; kind: number }

export class TunnelBuilder {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private inst: THREE.InstancedMesh[] = [];
  private lamps: THREE.InstancedMesh | null = null;
  private signs: THREE.Object3D[] = [];
  private path: PatternPath | null = null;
  private center = -1e9;
  private material: THREE.MeshBasicNodeMaterial;
  private lightMat: THREE.MeshBasicNodeMaterial;
  private furnMat: THREE.MeshBasicNodeMaterial;
  private glowMat: THREE.MeshBasicNodeMaterial;
  private signCache = new Map<string, THREE.CanvasTexture>();
  private env: TunnelEnv;
  private mode: Mode = 'subway';
  private vehLen = 138;
  /** sample positions of the current window + underground flag per sample */
  private sArr = new Float64Array(0);
  private under = new Uint8Array(0);
  private builtAt = 0;
  private firstBuildAt = 0;
  private builtWithNet = false;
  private boxSig = '';
  private lastCheck = 0;
  /** signals of the current window: path distance, lamp instance base */
  private signals: { s: number; k: number }[] = [];
  private aspectT = 0;
  private trainBuf: { e: number; n: number; heading: number; length: number }[] = [];
  /** stats of the last build (tris, draws) */
  stats = { tris: 0, draws: 0, signals: 0 };

  constructor(env: TunnelEnv) {
    this.env = env;
    this.group.name = 'interact-tunnel';
    const fade = float(1).sub(smoothstep(float(30), float(520), length(positionView))).mul(0.97).add(0.03);
    // main surfaces: vertex colour × light pools × joints / ties / grime
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const col = attribute('color', 'vec3');
    const tuv = attribute('tuv', 'vec4');
    const s = tuv.x, u = tuv.y, kind = tuv.z, h = tuv.w;
    const d = length(positionView);
    const pat = float(1).sub(smoothstep(float(22), float(70), d));
    const fl = fract(s.sub(LIGHT_PHASE).div(LIGHT_EVERY));
    const dl = min(fl, fl.oneMinus()).mul(LIGHT_EVERY);
    // dim tunnel (≈12 % between fixtures), a ~2.5 m pool of light under each fixture
    const pool = exp(dl.mul(dl).mul(-1 / 3.2));
    const lit = mix(float(0.12).add(pool.mul(0.78)), float(1), step(4.5, kind));
    const isTube = step(0.5, kind).mul(step(kind, 1.5));
    const isBox = step(1.5, kind).mul(step(kind, 2.5));
    const isBed = step(2.5, kind).mul(step(kind, 3.5));
    // tube: 1.5 m rings, 7 segments per ring with staggered longitudinal joints
    const fr = fract(s.div(1.5));
    const ring = float(1).sub(smoothstep(float(0.012), float(0.035), min(fr, fr.oneMinus()).mul(1.5)));
    const fs = fract(u.div(2.35).add(floor(s.div(1.5)).mul(0.5)));
    const lon = float(1).sub(smoothstep(float(0.01), float(0.03), min(fs, fs.oneMinus()).mul(2.35)));
    // box: construction joints every 9.14 m (30 ft), darker grime low on the walls
    const fb = fract(s.div(9.14));
    const vj = float(1).sub(smoothstep(float(0.015), float(0.045), min(fb, fb.oneMinus()).mul(9.14)));
    const grime = float(1).sub(smoothstep(float(0), float(1.6), h)).mul(0.22).mul(isBox);
    // track bed: ties every 0.61 m under the track (|u| < 1.25)
    const ft = fract(s.div(0.61));
    const tie = float(1).sub(smoothstep(float(0.1), float(0.125), min(ft, ft.oneMinus()).mul(0.61)))
      .mul(float(1).sub(smoothstep(float(1.2), float(1.3), abs(u)))).mul(isBed).mul(pat);
    const joints = max(max(ring, lon.mul(0.6)).mul(isTube), vj.mul(isBox).mul(0.7)).mul(pat);
    const base = mix(col, vec3(0.075, 0.055, 0.04), tie);
    const shade = float(1).sub(joints.mul(0.22)).sub(grime);
    m.colorNode = vec4(base.mul(shade).mul(lit).mul(fade), 1);
    this.material = m;
    // light fixtures (warm white diffusers)
    const lm = new THREE.MeshBasicNodeMaterial();
    lm.colorNode = vec4(float(2.3), float(2.1), float(1.7), 1);
    this.lightMat = lm;
    // furniture (instance colour × distance fade)
    const fm = new THREE.MeshBasicNodeMaterial();
    fm.colorNode = vec4(fade, fade, fade, 1);
    this.furnMat = fm;
    // glowing lamps / signs (instance colour, no fade)
    const gm = new THREE.MeshBasicNodeMaterial();
    gm.colorNode = vec4(1, 1, 1, 1);
    this.glowMat = gm;
  }

  setPath(path: PatternPath | null, mode: Mode, vehLen: number) {
    if (path !== this.path) this.center = -1e9;
    this.path = path;
    this.firstBuildAt = 0;
    this.mode = mode;
    this.vehLen = vehLen;
    if (!path) this.clear();
  }

  /** true if the track at s is underground (per current window) */
  isUnder(s: number): boolean {
    const S = this.sArr;
    if (!S.length || s < S[0] || s > S[S.length - 1]) return false;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    return this.under[s - S[lo] < S[hi] - s ? lo : hi] === 1;
  }

  update(s: number) {
    if (!this.path) return;
    const now = performance.now();
    // Terrain tiles may still be streaming in right after a takeover (heights
    // fall back to 0), which misclassifies underground track. Keep rebuilding
    // for a while so the tube appears once the terrain has loaded; also when
    // the rail network or the station boxes become available.
    const settling = now - this.firstBuildAt < 20000 && now - this.builtAt > 1500;
    let dirty = Math.abs(s - this.center) >= REBUILD || settling;
    if (!dirty && now - this.lastCheck > 1000) {
      this.lastCheck = now;
      if (!this.builtWithNet && railNet(this.env.dataRoot())) dirty = true;
      else if (this.boxSignature(s) !== this.boxSig) dirty = true;
    }
    if (dirty) {
      this.center = s;
      this.build(s);
    }
    this.updateAspects(s, now);
  }

  clear() {
    this.mesh?.geometry.dispose();
    this.mesh?.removeFromParent();
    this.mesh = null;
    for (const im of this.inst) { im.geometry.dispose(); im.dispose(); im.removeFromParent(); }
    this.inst = [];
    this.lamps = null;
    this.signals = [];
    for (const o of this.signs) {
      o.removeFromParent();
      const mm = o as THREE.Mesh;
      mm.geometry?.dispose();
      (mm.material as THREE.Material)?.dispose();
    }
    this.signs = [];
    this.center = -1e9;
    this.stats = { tris: 0, draws: 0, signals: 0 };
  }

  private underground(): boolean {
    const m = this.mode;
    return m === 'subway' || m === 'lrt' || m === 'airport_rail' || m === 'commuter_rail' || m === 'intercity_rail' || m === 'streetcar';
  }

  private netKind(): NetKind {
    return this.mode === 'subway' ? 1 : this.mode === 'lrt' ? 2 : this.mode === 'streetcar' ? 3 : 0;
  }

  private boxSignature(s: number): string {
    if (!this.path || !this.underground()) return '';
    const p = this.path.point(s, [0, 0, 0]);
    return stationBoxesNear(p[0], p[1], 900).map((b) => b.id + b.path.length).join(',');
  }

  // ------------------------------------------------------------------------------ build
  private build(sc: number) {
    const path = this.path!;
    this.clear();
    this.builtAt = performance.now();
    if (!this.firstBuildAt) this.firstBuildAt = this.builtAt;
    this.center = sc;
    const net = railNet(this.env.dataRoot());
    this.builtWithNet = !!net;
    const kindNet = this.netKind();
    const underground = this.underground();
    const isRail = this.mode !== 'bus';
    const s0 = Math.max(-END_EXT, sc - BACK), s1 = Math.min(path.length + END_EXT, sc + AHEAD);
    const origin = path.point(sc, [0, 0, 0]);
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const boxes = underground ? stationBoxesNear(ox, oy, 900) : [];
    this.boxSig = boxes.map((b) => b.id + b.path.length).join(',');

    // ---- sample positions: every STEP m + the station box ends
    const sl: number[] = [];
    for (let s = s0; s <= s1 + 1e-6; s += STEP) sl.push(s);
    const tmp = [0, 0, 0];
    for (const b of boxes) {
      const m = b.path.length / 3;
      for (const i of [0, m - 1]) {
        const e = b.path[3 * i], n = b.path[3 * i + 1];
        const se = nearestS(path, e, n, s0, s1, Math.max(Math.abs(b.left), Math.abs(b.right)) + 4, tmp);
        if (se !== null) sl.push(se);
      }
    }
    sl.sort((a, b) => a - b);
    const S = sl.filter((s, i) => i === 0 || s - sl[i - 1] > 0.3);
    const n = S.length;

    // ---- per-sample frame, depth, sections
    const pe = new Float64Array(n), pn = new Float64Array(n), pz = new Float64Array(n);
    const rx = new Float64Array(n), ry = new Float64Array(n);
    const under = new Uint8Array(n);
    const secs: Sec[] = new Array(n);
    const lats: number[] = [];
    const p = [0, 0, 0], a = [0, 0, 0], bb = [0, 0, 0];
    const realStops = path.stops.filter((q) => !q.virtual);
    const stopKeys = realStops.map((q) => baseName(q.name));
    for (let k = 0; k < n; k++) {
      const s = S[k];
      path.pointX(s, p); path.pointX(s - 3, a); path.pointX(s + 3, bb);
      const dx = bb[0] - a[0], dy = bb[1] - a[1];
      const hl = Math.hypot(dx, dy) || 1;
      rx[k] = dy / hl; ry[k] = -dx / hl;
      pe[k] = p[0]; pn[k] = p[1];
      const g = this.env.heightAt(p[0], p[1]);
      const u = underground && g - p[2] > 4.5;
      under[k] = u ? 1 : 0;
      // heavy rail runs at the network model's track z, which is also where the tiles draw it
      // (docs/ROADS.md "Source of truth"); street-running track follows the draped road surface
      const own = this.mode === 'subway' || this.mode === 'commuter_rail' || this.mode === 'airport_rail' || this.mode === 'intercity_rail';
      pz[k] = !own && !u && Math.abs(p[2] - g) < 2.5 ? g + 0.08 : p[2];
      // parallel tracks of this kind through the cross-section (right-positive)
      let others: number[] = [];
      if (net) {
        parallelLats(net, p[0], p[1], dx / hl, dy / hl, 16, kindNet, lats);
        let self = 0, bd = Infinity;
        for (const l of lats) if (Math.abs(l) < bd) { bd = Math.abs(l); self = l; }
        if (bd < 1.2) others = lats.filter((l) => Math.abs(l - self) > 1.2).map((l) => l - self);
        else others = lats.slice();
      } else if (this.mode === 'subway') others = [-4.45];
      let xL = 0, xR = 0;
      const neg = others.filter((l) => l < 0).sort((x, y) => y - x), pos = others.filter((l) => l > 0).sort((x, y) => x - y);
      for (const l of neg) { if (xL - l <= GROUP_GAP) xL = l; else break; }
      for (const l of pos) { if (l - xR <= GROUP_GAP) xR = l; else break; }
      const twL = neg.length && neg[0] > -12 ? neg[0] : NaN, twR = pos.length && pos[0] < 12 ? pos[0] : NaN;
      const D = this.tubeAt(s, realStops, stopKeys);
      const t = xL < 0 || xR > 0 ? T.BOX : D > 0 ? T.TUBE : T.BOX1;
      secs[k] = { t: u ? t : T.OPEN, L: xL - BOX_SIDE, R: xR + BOX_SIDE, D, twL, twR, third: 1 };
    }
    // fill 1–2 sample holes in the underground flag
    for (let k = 1; k < n - 2; k++) if (!under[k] && under[k - 1] && (under[k + 1] || under[k + 2])) { under[k] = 1; if (secs[k].t === T.OPEN) secs[k].t = secs[k - 1].t; }
    // drop section-type runs shorter than 3 samples (switch throats, mapping jitter)
    for (let k = 1; k < n; k++) {
      if (secs[k].t === secs[k - 1].t || secs[k].t === T.OPEN) continue;
      let j = k;
      while (j < n && secs[j].t === secs[k].t) j++;
      if (j - k < 3 && j < n && secs[j].t === secs[k - 1].t) for (let q = k; q < j; q++) Object.assign(secs[q], { t: secs[k - 1].t, D: secs[k - 1].D, L: secs[k - 1].L, R: secs[k - 1].R });
    }
    // box widths: smooth over ±1 sample of the same type
    const L0 = secs.map((q) => q.L), R0 = secs.map((q) => q.R);
    for (let k = 1; k < n - 1; k++) {
      if (secs[k - 1].t !== secs[k].t || secs[k + 1].t !== secs[k].t) continue;
      secs[k].L = Math.min(L0[k], (L0[k - 1] + L0[k] + L0[k + 1]) / 3);
      secs[k].R = Math.max(R0[k], (R0[k - 1] + R0[k] + R0[k + 1]) / 3);
    }
    for (const q of secs) if (q.t === T.BOX1) { q.L = -BOX_SIDE - 0.1; q.R = BOX_SIDE + 0.1; }
    this.sArr = Float64Array.from(S);
    this.under = under;

    // ---- station boxes: which segments lie inside one, platform sides
    const segBox = new Int16Array(Math.max(0, n - 1)).fill(-1);
    const boxX: ({ c0: number; sg: number } | null)[] = new Array(n).fill(null);
    for (let k = 0; k + 1 < n; k++) {
      if (!under[k] || !under[k + 1]) continue;
      const sm = (S[k] + S[k + 1]) / 2;
      path.pointX(sm, p);
      for (let bi = 0; bi < boxes.length; bi++) {
        const q = boxLocal(boxes[bi], p[0], p[1]);
        if (q && q.inside) { segBox[k] = bi; break; }
      }
    }
    const nodes = net ? this.pathNodes(net, path, s0 - 400, s1 + 400) : [];
    const switchNear = (s: number, r: number) => nodes.some((q) => q.sw && Math.abs(q.s - s) < r);
    for (let k = 0; k < n; k++) {
      const bi = segBox[Math.min(k, n - 2)] >= 0 ? segBox[Math.min(k, n - 2)] : k > 0 ? segBox[k - 1] : -1;
      let third = 1;
      if (bi >= 0) {
        const b = boxes[bi];
        const q = boxLocal(b, pe[k], pn[k]);
        if (q) {
          const c0 = (q.fx - pe[k]) * rx[k] + (q.fy - pn[k]) * ry[k];
          const sg = q.nx * rx[k] + q.ny * ry[k] >= 0 ? 1 : -1;
          boxX[k] = { c0, sg };
          let right = false, left = false;
          for (const pl of b.platforms) {
            const xa = c0 + sg * pl.a, xb = c0 + sg * pl.b;
            const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
            if (lo > 0.5 && lo < 4) right = true;
            if (hi < -0.5 && hi > -4) left = true;
          }
          third = right && left ? 0 : right ? -1 : 1;
        }
      }
      if (switchNear(S[k], 22)) third = 0;
      secs[k].third = third;
    }

    // ---- geometry
    const pos: number[] = [], col: number[] = [], tuv: number[] = [], idx: number[] = [];
    const c = new THREE.Color();
    const W = (k: number, x: number, y: number): [number, number, number] => [pe[k] + rx[k] * x - ox, pz[k] + y - oz, -(pn[k] + ry[k] * x - oy)];
    const quad = (k0: number, k1: number, xa0: number, ya0: number, xb0: number, yb0: number, xa1: number, ya1: number, xb1: number, yb1: number,
      hex: number, kind: number, u0: number, u1: number) => {
      c.setHex(hex);
      const v = pos.length / 3;
      const verts: [number, number, number, number, number][] = [[k0, xa0, ya0, u0, S[k0]], [k0, xb0, yb0, u1, S[k0]], [k1, xb1, yb1, u1, S[k1]], [k1, xa1, ya1, u0, S[k1]]];
      for (const [k, x, y, u, s] of verts) {
        const w = W(k, x, y);
        pos.push(w[0], w[1], w[2]);
        col.push(c.r, c.g, c.b);
        tuv.push(s, u, kind, y);
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };
    const emit = (k0: number, k1: number, A: Prof[], B: Prof[]) => {
      for (let i = 0; i < A.length && i < B.length; i++) {
        const a0 = A[i].pts, b0 = B[i].pts;
        if (a0.length !== b0.length) continue;
        let u = 0;
        for (let j = 0; j + 3 < a0.length; j += 2) {
          const du = Math.hypot(a0[j + 2] - a0[j], a0[j + 3] - a0[j + 1]);
          const uu0 = A[i].kind === K_BED ? a0[j] : u, uu1 = A[i].kind === K_BED ? a0[j + 2] : u + du;
          quad(k0, k1, a0[j], a0[j + 1], a0[j + 2], a0[j + 3], b0[j], b0[j + 1], b0[j + 2], b0[j + 3], A[i].col, A[i].kind, uu0, uu1);
          u += du;
        }
      }
    };

    for (let k = 0; k + 1 < n; k++) {
      const inBox = segBox[k] >= 0;
      const un = under[k] === 1 && under[k + 1] === 1 && underground;
      const t = un ? secs[k].t : T.OPEN;
      const kind = !un || inBox ? K_OPEN : 0;
      // structure (walls, floor, trays, walkway)
      if (un && !inBox) emit(k, k + 1, this.shell(secs[k], t), this.shell(secs[k + 1], t));
      // rails (ours everywhere; the neighbours' in shared boxes and stations)
      if (isRail) {
        const ours: Prof[] = [...railProf(-G2, kind), ...railProf(G2, kind)];
        emit(k, k + 1, ours, ours);
        if (un && (inBox || t === T.BOX)) {
          for (const side of ['twL', 'twR'] as const) {
            const x0 = secs[k][side], x1 = secs[k + 1][side];
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || Math.abs(x0 - x1) > 0.6) continue;
            emit(k, k + 1, [...railProf(x0 - G2, kind), ...railProf(x0 + G2, kind), bedProf(x0, kind)], [...railProf(x1 - G2, kind), ...railProf(x1 + G2, kind), bedProf(x1, kind)]);
          }
        }
        if (un) {
          if (inBox) emit(k, k + 1, [bedProf(0, K_BED)], [bedProf(0, K_BED)]);
          // covered third rail
          const th = secs[k].third;
          if (th !== 0 && th === secs[k + 1].third && this.mode !== 'streetcar') emit(k, k + 1, thirdProf(th, kind), thirdProf(th, kind));
        }
      }
      // headwalls: section type changes and station box ends
      if (k > 0 && under[k] && underground) {
        const prevIn = segBox[k - 1] >= 0, prevT = under[k - 1] ? secs[k - 1].t : T.OPEN;
        if (prevIn !== inBox && un && prevT !== T.OPEN) {
          const bi = inBox ? segBox[k] : segBox[k - 1];
          const tt = inBox ? prevT : t;
          const out = secs[inBox ? k - 1 : Math.min(n - 1, k + 1)];
          const qh = { ...secs[k], L: Math.min(out.L, secs[k].L), R: Math.max(out.R, secs[k].R), D: secs[k].D || out.D };
          if (tt !== T.OPEN) this.boxHeadwall(k, boxes[bi], boxX[k], qh, tt, others(secs[k]), quadTri(pos, col, tuv, idx, W, k, S[k]));
        } else if (!inBox && !prevIn && un && prevT !== T.OPEN && prevT !== t && (prevT === T.TUBE || t === T.TUBE)) {
          headwall(outline(secs[k], prevT), [outline(secs[k], t)], quadTri(pos, col, tuv, idx, W, k, S[k]));
        }
      }
    }
    // end caps where the window ends underground (dark, slightly oversized)
    for (const k of [0, n - 1]) {
      if (!under[k] || !underground) continue;
      const kk = k === 0 ? 0 : n - 2;
      if (segBox[kk] >= 0) continue;
      const o = outline(secs[k], secs[k].t === T.OPEN ? T.BOX1 : secs[k].t).map((v, i) => (i % 2 ? (v - 1.5) * 1.3 + 1.5 : v * 1.3));
      headwall(o, [], quadTri(pos, col, tuv, idx, W, k, S[k], 0x000000));
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('tuv', new THREE.Float32BufferAttribute(tuv, 4));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.position.set(ox, oz, -oy);
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.mesh = mesh;
      this.stats.tris += idx.length / 3;
      this.stats.draws++;
    }

    // ---- end-of-line walls where an underground line terminates in the window
    for (const [atEnd, k] of [[s1 >= path.length + END_EXT, n - 1], [s0 <= -END_EXT, 0]] as const) {
      if (!atEnd || !under[k]) continue;
      const pose = path.pose(k ? path.length + END_EXT - 4 : 4 - END_EXT);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 12, 16), new THREE.MeshStandardMaterial({ color: 0x55524d, roughness: 0.95 }));
      wall.position.set(pose.e, pose.z + 4, -pose.n);
      wall.rotation.y = pose.heading;
      this.group.add(wall);
      this.signs.push(wall);
    }

    // ---- instanced furniture
    if (underground) this.furniture(path, S, secs, under, segBox, pe, pn, pz, rx, ry, nodes, ox, oy, oz, switchNear);

    // ---- stopping markers (where the front of the train stops)
    if (isRail) {
      for (const st of realStops) {
        if (st.dist < s0 - 100 || st.dist > s1 + 100) continue;
        const sm = st.dist + this.vehLen / 2;
        const k = nearestK(S, sm);
        const un = k >= 0 && under[k] === 1;
        const sec = k >= 0 ? secs[k] : null;
        const x = un && sec ? Math.min(1.95, (sec.t === T.TUBE ? tubeHalf(sec.D, 2.4) : sec.R) - 0.12) : 2.2;
        this.addMarker(path, sm, x, un);
      }
    }
  }

  /** internal diameter of the bored tube at s, 0 = not a bored section */
  private tubeAt(s: number, stops: { dist: number }[], keys: string[]): number {
    if (!stops.length) return 0;
    let i = 0;
    while (i + 1 < stops.length && stops[i + 1].dist <= s) i++;
    const j = s < stops[0].dist ? 0 : Math.min(stops.length - 1, i + 1);
    const i0 = s < stops[0].dist ? 0 : i;
    if (i0 === j) return 0;
    return TUBES.get([keys[i0], keys[j]].sort().join('|')) ?? 0;
  }

  /** structure profiles of one cross-section of type t (same point counts for the same type) */
  private shell(q: Sec, t: T): Prof[] {
    const out: Prof[] = [];
    if (t === T.BOX || t === T.BOX1) {
      const { L, R } = q;
      out.push({ pts: [L, FLOOR, L, SOFFIT - HAUNCH, L + HAUNCH, SOFFIT, R - HAUNCH, SOFFIT, R, SOFFIT - HAUNCH, R, FLOOR], col: COL.concrete, kind: K_BOX });
      out.push({ pts: [L, FLOOR, R, FLOOR], col: COL.floor, kind: K_BED });
      // cable trays on both walls (3 tiers, lip up)
      for (const y of [2.15, 2.45, 2.75]) {
        out.push({ pts: [R, y, R - 0.32, y, R - 0.32, y + 0.08], col: COL.tray, kind: K_PLAIN });
        out.push({ pts: [L, y, L + 0.32, y, L + 0.32, y + 0.08], col: COL.tray, kind: K_PLAIN });
        out.push({ pts: [R - 0.04, y + 0.005, R - 0.26, y + 0.005], col: COL.cable, kind: K_PLAIN });
      }
      return out;
    }
    if (t === T.TUBE) {
      const r = (q.D || 5.2) / 2, yc = -1.0 + r;
      const a0 = Math.asin((FLOOR - yc) / r); // right bottom (negative)
      const pts: number[] = [];
      const N = 22;
      for (let i = 0; i <= N; i++) {
        const ang = a0 + ((Math.PI - 2 * a0) * i) / N;
        pts.push(r * Math.cos(ang), yc + r * Math.sin(ang));
      }
      out.push({ pts, col: COL.lining, kind: K_TUBE });
      const xf = r * Math.cos(a0);
      out.push({ pts: [-xf, FLOOR, xf, FLOOR], col: COL.floor, kind: K_BED });
      // walkway on the cross-passage side (left, towards the twin bore)
      const yw = 0.85, xw = -Math.sqrt(r * r - (yw - yc) * (yw - yc));
      out.push({ pts: [xw, yw, -1.78, yw, -1.78, FLOOR], col: COL.walkway, kind: K_BOX });
      // cable trays on the right wall
      for (const y of [2.0, 2.3]) {
        const xt = Math.sqrt(r * r - (y - yc) * (y - yc));
        out.push({ pts: [xt, y, xt - 0.3, y, xt - 0.3, y + 0.08], col: COL.tray, kind: K_PLAIN });
        out.push({ pts: [xt - 0.04, y + 0.005, xt - 0.24, y + 0.005], col: COL.cable, kind: K_PLAIN });
      }
      return out;
    }
    return out;
  }

  /** openings of the tracks outside our group at a station box end (same rules as ours) */
  private boxHeadwall(k: number, b: StationBox, bx: { c0: number; sg: number } | null, q: Sec, t: T, extra: number[], tri: (pts: number[], faces: number[][]) => void) {
    if (!bx) return;
    const xa = bx.c0 + bx.sg * b.right, xb = bx.c0 + bx.sg * b.left;
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    const top = b.ceiling;
    const contour = [lo, FLOOR, hi, FLOOR, hi, top, lo, top];
    const holes = [outline(q, t)];
    // other tracks' openings: a shared box for our group already covers the twins in it
    for (const x of extra) {
      if (x - 2.4 < lo || x + 2.4 > hi) continue;
      const o = outline({ ...q, L: x - BOX_SIDE - (t === T.BOX1 ? 0.1 : 0), R: x + BOX_SIDE + (t === T.BOX1 ? 0.1 : 0) }, t === T.TUBE ? T.TUBE : T.BOX1).map((v, i) => (i % 2 === 0 && t === T.TUBE ? v + x : v));
      holes.push(o);
    }
    headwall(contour, holes.filter((h, i) => i === 0 || !overlaps(h, holes.slice(0, i))), tri);
    void k;
  }

  /** graph nodes on our path (edge boundaries): path distance, switch flag */
  private pathNodes(net: RailNet, path: PatternPath, sa: number, sb: number): { s: number; sw: boolean }[] {
    const out: { s: number; sw: boolean }[] = [];
    const p = [0, 0, 0], q = [0, 0, 0];
    const lo = Math.max(0, sa), hi = Math.min(path.length, sb);
    for (let s = lo; s < hi; s += STEP) {
      path.point(s, p); path.point(Math.min(path.length, s + STEP), q);
      const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1;
      for (const i of nodesNear(net, p[0] + dx / 2, p[1] + dy / 2, STEP)) {
        const ex = net.nodes[3 * i] - p[0], ey = net.nodes[3 * i + 1] - p[1];
        const al = (ex * dx + ey * dy) / L, lat = (ex * dy - ey * dx) / L;
        if (al < -0.01 || al > L + 0.01 || Math.abs(lat) > 0.8) continue;
        const sn = s + al;
        if (out.some((o) => Math.abs(o.s - sn) < 2)) continue;
        out.push({ s: sn, sw: (net.nodeFlags[i] & 3) !== 0 });
      }
    }
    return out.sort((x, y) => x.s - y.s);
  }

  private furniture(path: PatternPath, S: number[], secs: Sec[], under: Uint8Array, segBox: Int16Array,
    pe: Float64Array, pn: Float64Array, pz: Float64Array, rx: Float64Array, ry: Float64Array,
    nodes: { s: number; sw: boolean }[], ox: number, oy: number, oz: number, switchNear: (s: number, r: number) => boolean) {
    const n = S.length;
    const at = (s: number) => {
      const k = nearestK(S, s);
      if (k < 0 || k >= n - 1 && S[k] < s) return null;
      const kk = Math.min(k, n - 2);
      if (!under[kk] || !under[kk + 1]) return null;
      return { k, seg: kk, sec: secs[k], inBox: segBox[kk] >= 0 };
    };
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const put = (list: THREE.Matrix4[], s: number, x: number, y: number, sx: number, sy: number, sz: number) => {
      const p = path.pointX(s, [0, 0, 0]);
      const k = nearestK(S, s);
      const e = p[0] + rx[k] * x, nn = p[1] + ry[k] * x;
      const z = pz[k] + (p[2] - path.pointX(S[k], [0, 0, 0])[2]);
      q.setFromAxisAngle(up, Math.atan2(ry[k], rx[k]));
      list.push(new THREE.Matrix4().compose(v.set(e - ox, z + y - oz, -(nn - oy)), q, sc.set(sx, sy, sz)));
    };
    const s0 = S[0], s1 = S[n - 1];
    // light fixtures every LIGHT_EVERY m (right upper wall)
    const lights: THREE.Matrix4[] = [];
    for (let s = Math.ceil((s0 - LIGHT_PHASE) / LIGHT_EVERY) * LIGHT_EVERY + LIGHT_PHASE; s < s1; s += LIGHT_EVERY) {
      const a = at(s);
      if (!a || a.inBox || a.sec.t === T.OPEN) continue;
      if (a.sec.t === T.TUBE) {
        const y = 3.0;
        put(lights, s, tubeHalf(a.sec.D, y) - 0.1, y, 0.14, 0.1, 1.2);
      } else put(lights, s, a.sec.R - 0.07, 3.55, 0.12, 0.1, 1.2);
    }
    // centre columns between the tracks of a shared box (steady spacing, clear of switches)
    const cols: THREE.Matrix4[] = [];
    for (let s = Math.ceil(s0 / 4.5) * 4.5; s < s1; s += 4.5) {
      const a = at(s);
      if (!a || a.inBox || a.sec.t !== T.BOX) continue;
      const tw = Number.isFinite(a.sec.twL) && a.sec.L < a.sec.twL - 1 ? a.sec.twL : Number.isFinite(a.sec.twR) && a.sec.R > a.sec.twR + 1 ? a.sec.twR : NaN;
      if (!Number.isFinite(tw) || Math.abs(tw) < 4.0 || Math.abs(tw) > 5.6 || switchNear(s, 40)) continue;
      const k = a.k, kp = Math.max(0, k - 3), kn = Math.min(n - 1, k + 3);
      const steady = [kp, kn].every((j) => Math.abs((tw < 0 ? secs[j].twL : secs[j].twR) - tw) < 0.25);
      if (!steady) continue;
      put(cols, s, tw / 2, FLOOR, 0.32, SOFFIT - FLOOR, 0.32);
    }
    // wayside signals at the sim's block boundaries (right side, facing the train)
    const sigs: number[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i].s, b = nodes[i + 1].s, L = b - a;
      const nb = Math.max(1, Math.ceil(L / BLOCK[this.netKind()]));
      for (let j = 0; j < nb; j++) sigs.push(a + (L * j) / nb);
    }
    if (nodes.length) sigs.push(nodes[nodes.length - 1].s);
    const heads: THREE.Matrix4[] = [], lampM: THREE.Matrix4[] = [];
    this.signals = [];
    for (const s of sigs) {
      if (s < s0 || s > s1) continue;
      const a = at(s);
      if (!a || a.sec.t === T.OPEN) continue;
      let x: number;
      if (a.inBox) { if (a.sec.third === -1) continue; x = 1.95; } // no signal on a right-hand platform
      else x = a.sec.t === T.TUBE ? tubeHalf(a.sec.D, 2.0) - 0.28 : a.sec.R - 0.28;
      const y = 1.55;
      put(heads, s, x, y, 0.3, 0.78, 0.22); // head (centre y)
      put(heads, s, x + 0.12, y - 0.8, 0.06, 1.2, 0.06); // bracket to the floor
      for (let l = 0; l < 3; l++) put(lampM, s - 0.12, x, y + 0.22 - l * 0.22, 0.16, 0.16, 0.02);
      this.signals.push({ s, k: this.signals.length * 3 });
    }
    // emergency exits every EXIT_EVERY m: door (+ cross-passage door in tubes), green EXIT sign, blue light
    const doors: THREE.Matrix4[] = [], exitG: THREE.Matrix4[] = [], blue: THREE.Matrix4[] = [];
    for (let s = Math.ceil((s0 - 125) / EXIT_EVERY) * EXIT_EVERY + 125; s < s1; s += EXIT_EVERY) {
      const a = at(s);
      if (!a || a.inBox || a.sec.t === T.OPEN) continue;
      if (a.sec.t === T.TUBE) {
        const r = (a.sec.D || 5.2) / 2, yc = -1 + r;
        const xd = -Math.sqrt(r * r - (1.9 - yc) * (1.9 - yc)) + 0.06;
        put(doors, s, xd, 0.85 + 1.05, 0.12, 2.1, 1.1);
        put(exitG, s, xd + 0.1, 3.2, 0.04, 0.22, 0.6);
        put(blue, s + 1.2, xd + 0.1, 2.9, 0.1, 0.12, 0.12);
      } else {
        const xd = a.sec.R - 0.02;
        put(doors, s, xd, 0.3 + 1.05, 0.12, 2.1, 1.1);
        put(exitG, s, xd - 0.06, 2.95 - 0.35, 0.04, 0.22, 0.6);
        put(blue, s + 1.3, xd - 0.06, 2.3, 0.1, 0.12, 0.12);
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mk = (list: THREE.Matrix4[], mat: THREE.Material, hex: number, k = 1) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(box.clone(), mat, list.length);
      const cc = new THREE.Color(hex).multiplyScalar(k);
      list.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, cc); });
      im.position.set(ox, oz, -oy);
      im.frustumCulled = false;
      this.group.add(im);
      this.inst.push(im);
      this.stats.draws++;
      this.stats.tris += 12 * list.length;
      return im;
    };
    mk(lights, this.lightMat, 0xffffff);
    mk(cols, this.furnMat, 0x6a665f);
    mk(heads, this.furnMat, 0x1b1c1e);
    mk(doors, this.furnMat, 0x4d5a52);
    mk(exitG, this.glowMat, 0x19d45a, 1.6);
    mk(blue, this.glowMat, 0x2c5cff, 2.2);
    this.lamps = mk(lampM, this.glowMat, 0x0a0a0a);
    this.stats.signals = this.signals.length;
    box.dispose();
    this.aspectT = 0;
  }

  /**
   * Signal aspects from the other trains: a signal protecting a block that a
   * train occupies shows red, the one before it yellow, the others green;
   * signals behind our front are red (our own train).
   */
  private updateAspects(sCentre: number, now: number) {
    const lamps = this.lamps, path = this.path;
    if (!lamps || !path || !this.signals.length || now - this.aspectT < 400) return;
    this.aspectT = now;
    const front = sCentre + this.vehLen / 2;
    const occ: [number, number][] = [];
    const cnt = this.env.trains(this.trainBuf);
    const S = this.sArr;
    const p = [0, 0, 0];
    for (let i = 0; i < cnt; i++) {
      const t = this.trainBuf[i];
      const sn = nearestS(path, t.e, t.n, S[0] - 200, S[S.length - 1] + 200, 2.5, p);
      if (sn === null) continue;
      occ.push([sn - t.length / 2, sn + t.length / 2]);
    }
    const sig = this.signals;
    const aspect = new Array<number>(sig.length).fill(0); // 0 green · 1 yellow · 2 red
    for (let i = 0; i < sig.length; i++) {
      if (sig[i].s < front - 1) { aspect[i] = 2; continue; }
      const end = i + 1 < sig.length ? sig[i + 1].s : sig[i].s + 150;
      if (occ.some(([a, b]) => b > sig[i].s && a < end)) aspect[i] = 2;
    }
    for (let i = 0; i + 1 < sig.length; i++) if (aspect[i] === 0 && aspect[i + 1] === 2 && sig[i + 1].s >= front) aspect[i] = 1;
    const on = [new THREE.Color(0x20ff60).multiplyScalar(2.2), new THREE.Color(0xffc400).multiplyScalar(2.2), new THREE.Color(0xff2a1a).multiplyScalar(2.4)];
    const off = new THREE.Color(0x101010);
    for (let i = 0; i < sig.length; i++) {
      // lamps top → bottom: green, yellow, red
      for (let l = 0; l < 3; l++) lamps.setColorAt(sig[i].k + l, aspect[i] === l ? on[l] : off);
    }
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  }

  private addMarker(path: PatternPath, s: number, x: number, under: boolean) {
    const pose = path.pose(s, 3);
    const tex = this.signTexture('▼STOP', true);
    const m = new THREE.MeshBasicNodeMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), m);
    const rxv = Math.sin(pose.heading), ryv = -Math.cos(pose.heading);
    const g = this.env.heightAt(pose.e, pose.n);
    const own = this.mode === 'subway' || this.mode === 'commuter_rail' || this.mode === 'airport_rail' || this.mode === 'intercity_rail';
    const z = own || under || Math.abs(pose.z - g) > 2.5 ? pose.z : g;
    mesh.position.set(pose.e + rxv * x, z + 2.2, -(pose.n + ryv * x));
    mesh.rotation.y = pose.heading - Math.PI / 2;
    this.group.add(mesh);
    this.signs.push(mesh);
    if (!under) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.95, 0.08), new THREE.MeshBasicNodeMaterial({ color: 0x777777 }));
      post.position.set(pose.e + rxv * x, z + 0.95, -(pose.n + ryv * x));
      this.group.add(post);
      this.signs.push(post);
    }
  }

  private signTexture(text: string, marker = false): THREE.CanvasTexture {
    const key = (marker ? 'm:' : 's:') + text;
    let t = this.signCache.get(key);
    if (t) return t;
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#ffd400'; c.fillRect(0, 0, 128, 128);
    c.fillStyle = '#111'; c.fillRect(10, 10, 108, 108);
    c.fillStyle = '#ffd400'; c.font = 'bold 44px Overpass, Helvetica, sans-serif'; c.textAlign = 'center';
    c.fillText('STOP', 64, 80);
    t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.signCache.set(key, t);
    return t;
  }

  dispose() {
    this.clear();
    this.material.dispose();
    this.lightMat.dispose();
    this.furnMat.dispose();
    this.glowMat.dispose();
    for (const t of this.signCache.values()) t.dispose();
    this.group.removeFromParent();
  }
}

// --------------------------------------------------------------------------------- helpers

function railProf(x: number, kind: number): Prof[] {
  const w = 0.036, h = 0.16;
  return [
    { pts: [x - w, 0, x - w, h], col: COL.railSide, kind: kind || K_PLAIN },
    { pts: [x - w, h, x + w, h], col: COL.railHead, kind: kind || K_PLAIN },
    { pts: [x + w, h, x + w, 0], col: COL.railSide, kind: kind || K_PLAIN },
  ];
}

/** track bed strip under a track (tie pattern in the shader, centred on the track) */
function bedProf(x: number, kind: number): Prof {
  return { pts: [x - 1.3, FLOOR + 0.01, x + 1.3, FLOOR + 0.01], col: COL.floor, kind: kind === K_OPEN ? K_OPEN : K_BED };
}

/** covered third rail: rail on insulators, cover board above (side +1 right, −1 left) */
function thirdProf(side: number, kind: number): Prof[] {
  const x = side * THIRD, o = side;
  return [
    { pts: [x - 0.04, 0.02, x - 0.04, 0.15, x + 0.04, 0.15, x + 0.04, 0.02], col: COL.third, kind: kind || K_PLAIN },
    { pts: [x - o * 0.2, 0.3, x + o * 0.22, 0.3, x + o * 0.22, 0.17], col: COL.board, kind: kind || K_PLAIN },
  ];
}

/** closed outline (x, y pairs) of a section's opening */
function outline(q: Sec, t: T): number[] {
  if (t === T.TUBE) {
    const r = (q.D || 5.2) / 2, yc = -1.0 + r;
    const a0 = Math.asin((FLOOR - yc) / r);
    const out: number[] = [];
    const N = 22;
    for (let i = 0; i <= N; i++) { const ang = a0 + ((Math.PI - 2 * a0) * i) / N; out.push(r * Math.cos(ang), yc + r * Math.sin(ang)); }
    return out;
  }
  const { L, R } = q;
  return [L, FLOOR, R, FLOOR, R, SOFFIT - HAUNCH, R - HAUNCH, SOFFIT, L + HAUNCH, SOFFIT, L, SOFFIT - HAUNCH];
}

function others(q: Sec): number[] {
  const o: number[] = [];
  if (Number.isFinite(q.twL) && q.twL < q.L) o.push(q.twL);
  if (Number.isFinite(q.twR) && q.twR > q.R) o.push(q.twR);
  return o;
}

function bbox(h: number[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < h.length; i += 2) { x0 = Math.min(x0, h[i]); x1 = Math.max(x1, h[i]); y0 = Math.min(y0, h[i + 1]); y1 = Math.max(y1, h[i + 1]); }
  return { x0, x1, y0, y1 };
}

function overlaps(h: number[], prev: number[][]): boolean {
  const a = bbox(h);
  return prev.some((p) => { const b = bbox(p); return a.x0 < b.x1 && b.x0 < a.x1; });
}

/**
 * Planar wall in a cross-section: `contour` minus `holes` (each clamped into
 * the contour's box). Holes larger than the contour in area swap roles, so a
 * box → tube change and a tube → box change both get the ring face.
 */
function headwall(contour: number[], holes: number[][], tri: (pts: number[], faces: number[][]) => void) {
  const area = (h: number[]) => { const b = bbox(h); return (b.x1 - b.x0) * (b.y1 - b.y0); };
  let outer = contour, inner = holes;
  if (holes.length === 1 && area(holes[0]) > area(contour)) { outer = holes[0]; inner = [contour]; }
  const b = bbox(outer);
  const clamp = (h: number[]) => h.map((v, i) => (i % 2 === 0 ? Math.min(b.x1 - 0.03, Math.max(b.x0 + 0.03, v)) : Math.min(b.y1 - 0.03, Math.max(b.y0 + 0.01, v))));
  const toV = (h: number[]) => { const o: THREE.Vector2[] = []; for (let i = 0; i < h.length; i += 2) o.push(new THREE.Vector2(h[i], h[i + 1])); return o; };
  const outerV = toV(outer), holesV = inner.map((h) => toV(clamp(h)));
  const faces = THREE.ShapeUtils.triangulateShape(outerV, holesV);
  const all: number[] = [];
  for (const v of outerV) all.push(v.x, v.y);
  for (const h of holesV) for (const v of h) all.push(v.x, v.y);
  tri(all, faces);
}

/** triangle writer for a planar cross-section at sample k (shared vertex buffers) */
function quadTri(pos: number[], col: number[], tuv: number[], idx: number[], W: (k: number, x: number, y: number) => [number, number, number], k: number, s: number, hex = COL.head) {
  return (pts: number[], faces: number[][]) => {
    const c = new THREE.Color(hex);
    const v0 = pos.length / 3;
    for (let i = 0; i < pts.length; i += 2) {
      const w = W(k, pts[i], pts[i + 1]);
      pos.push(w[0], w[1], w[2]);
      col.push(c.r, c.g, c.b);
      tuv.push(s + pts[i] * 0.37, pts[i], hex === 0 ? K_PLAIN : K_BOX, pts[i + 1]);
    }
    for (const f of faces) idx.push(v0 + f[0], v0 + f[1], v0 + f[2]);
  };
}
/** nearest sample index to s (samples sorted) */
function nearestK(S: ArrayLike<number>, s: number): number {
  const n = S.length;
  if (!n) return -1;
  let lo = 0, hi = n - 1;
  if (s <= S[0]) return 0;
  if (s >= S[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  return s - S[lo] < S[hi] - s ? lo : hi;
}

/** half width of a tube (diameter D, invert 1.0 m below the rail) at height y */
function tubeHalf(D: number, y: number): number {
  const r = (D || 5.2) / 2, yc = -1 + r;
  return Math.sqrt(Math.max(0, r * r - (y - yc) * (y - yc)));
}

/** path distance of the point on the path nearest to (e, n) within [sa, sb] and lateral r, or null */
function nearestS(path: PatternPath, e: number, n: number, sa: number, sb: number, r: number, tmp: number[]): number | null {
  let best = Infinity, bs = 0;
  const a = Math.max(0, sa), b = Math.min(path.length, sb);
  for (let s = a; s <= b; s += 8) {
    path.point(s, tmp);
    const d = Math.hypot(tmp[0] - e, tmp[1] - n);
    if (d < best) { best = d; bs = s; }
  }
  if (best > r + 8) return null;
  // refine (golden-ish bisection over ±8 m)
  let lo = Math.max(a, bs - 8), hi = Math.min(b, bs + 8);
  for (let it = 0; it < 24; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    path.point(m1, tmp); const d1 = Math.hypot(tmp[0] - e, tmp[1] - n);
    path.point(m2, tmp); const d2 = Math.hypot(tmp[0] - e, tmp[1] - n);
    if (d1 < d2) hi = m2; else lo = m1;
  }
  const s = (lo + hi) / 2;
  path.point(s, tmp);
  return Math.hypot(tmp[0] - e, tmp[1] - n) <= r ? s : null;
}

/** position of (e, n) in a station box: along index, lateral (left +), inside flag, foot point + left normal */
function boxLocal(b: StationBox, e: number, n: number) {
  const P = b.path, m = P.length / 3;
  let best = Infinity, res: { j: number; lat: number; inside: boolean; fx: number; fy: number; nx: number; ny: number } | null = null;
  for (let i = 0; i + 1 < m; i++) {
    const ax = P[3 * i], ay = P[3 * i + 1], dx = P[3 * i + 3] - ax, dy = P[3 * i + 4] - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-6) continue;
    const L = Math.sqrt(L2);
    const t = ((e - ax) * dx + (n - ay) * dy) / L2;
    const tc = Math.max(0, Math.min(1, t));
    const fx = ax + dx * tc, fy = ay + dy * tc;
    const d = Math.hypot(e - fx, n - fy);
    if (d < best) {
      best = d;
      const nx = -dy / L, ny = dx / L;
      const lat = (e - fx) * nx + (n - fy) * ny;
      const j = i + t;
      res = { j, lat, inside: j >= 0 && j <= m - 1 && lat >= b.right - 0.3 && lat <= b.left + 0.3, fx, fy, nx, ny };
    }
  }
  return best < 40 ? res : null;
}
