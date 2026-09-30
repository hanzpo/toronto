// Rail / bus car kit: lofted car bodies with cab noses, glazing, doors,
// bogies, pantographs and roof equipment. Every function here builds ONE car
// (a unit of a consist) in metres (x = forward, origin at the car centre on the
// rail / road surface) and returns the builder; `finish()` normalises to the
// unit-box convention used by MarkerOverlay / consists.
//
// Dimensions: see REFERENCE.md next to this file.
import type * as THREE from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
import { MeshBuilder, paint, sectionZ, type Paint, type RGB, type Station, type V2 } from './builder';

// ------------------------------------------------------------------ palette
export const P = {
  glass: paint(0x10151a, { glass: 1 }),
  glassTint: paint(0x1d262d, { glass: 1 }),
  black: paint(0x141517),
  rubber: paint(0x0c0d0e),
  under: paint(0x26282b),
  bogie: paint(0x2a2b2d),
  wheel: paint(0x4d4239),
  steelWheel: paint(0x6d6a66),
  roofGrey: paint(0x8f9498),
  grille: paint(0x3a3e42),
  white: paint(0xf1f2ef),
  offWhite: paint(0xdfe1df),
  silver: paint(0xb9bec3),
  silverDark: paint(0x8b9197),
  frame: paint(0x6c7075),
  ttcRed: paint(0xd8261c),
  ttcRedDark: paint(0xa81d16),
  goGreen: paint(0x10955a),
  goGreenDark: paint(0x0b6e42),
  upGold: paint(0x8e8558),
  upOrange: paint(0xf07a1f),
  upSilver: paint(0xbfc2c4),
  charcoal: paint(0x33373b),
  viaGrey: paint(0xbdc1c4),
  viaMid: paint(0x6f747a),
  viaYellow: paint(0xffc20e),
  lrtWhite: paint(0xe8e9e6),
  lrtGrey: paint(0x7b8085),
  yellow: paint(0xf2c200),
  tint: paint(0xffffff, { liv: 1 }),
  // lamps / signs (emissive slots)
  head: paint(0xfff3d2, { lamp: 1 }),
  headOff: paint(0xd9d6cc),
  tail: paint(0xc3140c, { lamp: 2 }),
  tailOff: paint(0x5a100c),
  indL: paint(0xff9a1a, { lamp: 3 }),
  indR: paint(0xff9a1a, { lamp: 4 }),
  sign: paint(0xffa21a, { sign: 1 }),
  signWhite: paint(0xe8f0ff, { sign: 1 }),
  markerBlue: paint(0x3a78ff),
};

export type Dir = 1 | -1;

// ------------------------------------------------------------------ body + noses
export interface Nose {
  /** x offset beyond the body end for each half-section point */
  prof: number[];
  /** z scale at the nose tip per section point (or one value) */
  taper: number | number[];
  /** colour of the front strips by strip mid height */
  front(y: number): RGB | null;
  /** colour of the nose side surfaces (seg 0 = next to the body … 2 = tip) */
  side(y: number, seg: number): RGB;
}

export interface Body {
  L: number;
  half: V2[];
  side(y: number): RGB;
  /** cab noses at the front (+x) / back (−x) end */
  front?: Nose;
  back?: Nose;
  /** flat end colour (no nose) */
  end?: RGB;
  /** set back of a flat end from ±L/2 (room for the gangway diaphragm) */
  endInset?: number;
  /** gangway diaphragm on flat ends: half width, y0, y1 */
  gangway?: [number, number, number];
  /** underside colour (needed when `bottom` varies) */
  underside?: RGB;
  /** extra body stations with a raised bottom (BiLevel drop centre): [x, bottomY] ascending */
  bottom?: [number, number][];
  low?: boolean;
}

export interface BodyInfo {
  xb0: number; xb1: number;
  zAt(y: number): number;
  /** x of the nose surface at height y (front if dir = 1) */
  noseX(dir: Dir, y: number): number;
  /** half width of the nose front face at height y */
  noseZ(dir: Dir, y: number): number;
}

function interpBy(half: V2[], vals: number[], y: number): number {
  for (let i = 0; i < half.length - 1; i++) {
    const ya = half[i][1], yb = half[i + 1][1];
    if ((y - ya) * (y - yb) <= 0 && yb !== ya) return vals[i] + ((y - ya) / (yb - ya)) * (vals[i + 1] - vals[i]);
  }
  return y <= half[0][1] ? vals[0] : vals[vals.length - 1];
}

const tap = (n: Nose, i: number) => (typeof n.taper === 'number' ? n.taper : n.taper[i]);

export function railBody(b: MeshBuilder, d: Body): BodyInfo {
  const half = d.half;
  const noseLen = (n?: Nose) => (n ? Math.max(...n.prof) : 0);
  const inset = d.endInset ?? 0.12;
  const xb0 = -d.L / 2 + (d.back ? noseLen(d.back) : inset);
  const xb1 = d.L / 2 - (d.front ? noseLen(d.front) : inset);
  const mids = half.map((_, i) => (i < half.length - 1 ? (half[i][1] + half[i + 1][1]) / 2 : 0));

  // ---- body (with optional drop-centre bottom)
  const withBottom = (x: number, by: number): Station => ({
    x,
    pts: half.map(([z, y], i) => {
      if (i === 0) return [z, by] as [number, number];
      return [z, Math.max(y, by + 0.02 * i)] as [number, number];
    }),
  });
  const body: Station[] = [];
  if (d.bottom) for (const [x, by] of d.bottom) body.push(withBottom(Math.min(Math.max(x, xb0), xb1), by));
  else body.push({ x: xb0, pts: half }, { x: xb1, pts: half });
  const endCol = d.end ?? d.side(2);
  b.loft(body, (_s, e) => d.side(mids[e]), {
    bottom: d.underside,
    front: d.front ? undefined : () => endCol,
    back: d.back ? undefined : () => endCol,
  });

  // ---- noses
  const ts = d.low ? [0, 1] : [0, 0.5, 0.82, 1];
  const nose = (n: Nose, dir: Dir) => {
    const xEnd = dir > 0 ? xb1 : xb0;
    const base = dir > 0 ? body[body.length - 1] : body[0];
    const st: Station[] = ts.map((t) => ({
      x: xEnd,
      pts: base.pts.map((p, i) => {
        const s = 1 - (1 - tap(n, i)) * Math.pow(t, 2.2);
        return [p[0] * s, p[1], xEnd + dir * n.prof[i] * t] as [number, number, number];
      }),
    }));
    const nseg = ts.length - 1;
    const segOf = (k: number) => (d.low ? 2 : k);
    if (dir > 0) {
      b.loft(st, (s, e) => n.side(mids[e], segOf(s)), { front: (e) => n.front(mids[e]) });
    } else {
      st.reverse();
      b.loft(st, (s, e) => n.side(mids[e], segOf(nseg - 1 - s)), { back: (e) => n.front(mids[e]) });
    }
  };
  if (d.front) nose(d.front, 1);
  if (d.back) nose(d.back, -1);

  // ---- gangway diaphragms on flat ends
  if (d.gangway && !d.low) {
    const [hw, y0, y1] = d.gangway;
    if (!d.front) b.box(xb1, d.L / 2, y0, y1, -hw, hw, P.rubber, 0, 'bottom back');
    if (!d.back) b.box(-d.L / 2, xb0, y0, y1, -hw, hw, P.rubber, 0, 'bottom front');
  }

  return {
    xb0, xb1,
    zAt: (y) => sectionZ(half, y),
    noseX: (dir, y) => {
      const n = dir > 0 ? d.front : d.back;
      const xEnd = dir > 0 ? xb1 : xb0;
      return n ? xEnd + dir * interpBy(half, n.prof, y) : xEnd;
    },
    noseZ: (dir, y) => {
      const n = dir > 0 ? d.front : d.back;
      const s = n ? interpBy(half, half.map((_, i) => tap(n, i)), y) : 1;
      return sectionZ(half, y) * s;
    },
  };
}

/** Decal on a nose front face: rectangle y0..y1 × z (zc ± hz), following the rake. */
export function noseDecal(b: MeshBuilder, info: BodyInfo, dir: Dir, y0: number, y1: number, zc: number, hz: number, c: RGB, eps = 0.015) {
  const x0 = info.noseX(dir, y0) + dir * eps, x1 = info.noseX(dir, y1) + dir * eps;
  b.poly([vec(x0, y0, zc - hz), vec(x0, y0, zc + hz), vec(x1, y1, zc + hz), vec(x1, y1, zc - hz)], c, 0, vec(dir, 0, 0));
}

/** Convex polygon [z, y] on a nose front face. */
export function nosePoly(b: MeshBuilder, info: BodyInfo, dir: Dir, pts: V2[], c: RGB, eps = 0.015) {
  b.poly(pts.map(([z, y]) => vec(info.noseX(dir, y) + dir * eps, y, z)), c, 0, vec(dir, 0, 0));
}

/** Octagonal lamp on a nose face. */
export function noseLamp(b: MeshBuilder, info: BodyInfo, dir: Dir, y: number, z: number, r: number, c: RGB, eps = 0.02) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const yy = y + Math.sin(a) * r;
    pts.push(vec(info.noseX(dir, yy) + dir * eps, yy, z + Math.cos(a) * r));
  }
  b.poly(pts, c, 0, vec(dir, 0, 0));
}

function vec(x: number, y: number, z: number) { return new Vector3(x, y, z); }

// ------------------------------------------------------------------ running gear / roof kit
/** Two-axle rail bogie. `zw` = outer face of the wheels, frame outboard of the wheels when `outboard`. */
export function railBogie(b: MeshBuilder, xc: number, wb: number, r: number, zw: number, opts: { outboard?: boolean; top?: number; low?: boolean; wheel?: RGB } = {}) {
  const top = opts.top ?? r * 2.1;
  const wc = opts.wheel ?? P.wheel;
  if (opts.low) {
    b.box(xc - wb / 2 - r, xc + wb / 2 + r, 0.05, top, -zw, zw, P.bogie, 0, 'bottom');
    return;
  }
  for (const ax of [xc - wb / 2, xc + wb / 2]) {
    for (const s of [1, -1] as const) {
      b.disc(ax, r, r, s * zw, s, wc, 10);
      b.disc(ax, r, r * 0.35, s * (zw + 0.01), s, P.bogie, 6);
    }
  }
  // wheel-set mass between the wheels (hides the see-through)
  b.box(xc - wb / 2 - r * 0.6, xc + wb / 2 + r * 0.6, r * 0.35, top, -zw + 0.12, zw - 0.12, P.bogie, 0, 'bottom');
  const fz0 = opts.outboard ? zw + 0.02 : zw - 0.22, fz1 = opts.outboard ? zw + 0.16 : zw - 0.08;
  for (const s of [1, -1]) {
    const z0 = s > 0 ? fz0 : -fz1, z1 = s > 0 ? fz1 : -fz0;
    // side frame: deep in the middle, thinner over the axle boxes
    b.box(xc - wb / 2 - r * 0.55, xc + wb / 2 + r * 0.55, r * 0.75, r * 1.45, z0, z1, P.bogie, 0, 'bottom');
    b.box(xc - wb / 2 + r * 0.55, xc + wb / 2 - r * 0.55, r * 0.35, r * 0.8, z0, z1, P.bogie, 0, 'bottom top');
    // axle boxes
    for (const ax of [xc - wb / 2, xc + wb / 2]) {
      const zo = s * (opts.outboard ? zw + 0.18 : zw + 0.06);
      b.box(ax - 0.16, ax + 0.16, r * 0.7, r * 1.3, Math.min(s * zw, zo), Math.max(s * zw, zo), P.under, 0, 'bottom');
    }
  }
}

/** Beam between two points in the x-y plane, centred on z = zc. */
export function beam(b: MeshBuilder, x0: number, y0: number, x1: number, y1: number, zc: number, hw: number, t: number, c: RGB) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  const nx = (-dy / L) * t / 2, ny = (dx / L) * t / 2;
  const A = (s: number, z: number, e: 0 | 1) => vec((e ? x1 : x0) + nx * s, (e ? y1 : y0) + ny * s, zc + z);
  b.quad(A(1, -hw, 0), A(1, -hw, 1), A(1, hw, 1), A(1, hw, 0), c, 0, vec(nx, ny, 0));
  b.quad(A(-1, -hw, 0), A(-1, -hw, 1), A(-1, hw, 1), A(-1, hw, 0), c, 0, vec(-nx, -ny, 0));
  b.quad(A(1, hw, 0), A(1, hw, 1), A(-1, hw, 1), A(-1, hw, 0), c, 0, vec(0, 0, 1));
  b.quad(A(1, -hw, 0), A(1, -hw, 1), A(-1, -hw, 1), A(-1, -hw, 0), c, 0, vec(0, 0, -1));
}

/** Single-arm pantograph raised to `head` (m above rail), base on the roof at y. Knee points to −x·dir. */
export function pantograph(b: MeshBuilder, x: number, y: number, head: number, dir: Dir = 1, low = false) {
  b.box(x - 0.7, x + 0.7, y, y + 0.12, -0.5, 0.5, P.under);
  const h = head - y - 0.25;
  const kx = x - dir * 1.35, ky = y + 0.2 + h * 0.5;
  if (!low) {
    beam(b, x + dir * 0.5, y + 0.2, kx, ky, -0.28, 0.035, 0.07, P.black);
    beam(b, x + dir * 0.5, y + 0.2, kx, ky, 0.28, 0.035, 0.07, P.black);
  }
  beam(b, kx, ky, x + dir * 0.1, head - 0.08, 0, 0.04, 0.06, P.black);
  b.box(x - 0.12 + dir * 0.1, x + 0.12 + dir * 0.1, head - 0.08, head, -0.85, 0.85, P.black, 0, 'bottom');
}

/** Roof equipment pod (HVAC / resistor fairing). */
export function roofPod(b: MeshBuilder, x0: number, x1: number, y0: number, y1: number, hz: number, c: RGB, grille?: RGB) {
  b.taperBox(x0, x1, y0, y1, hz, Math.min(0.25, (x1 - x0) / 4), Math.min(0.12, hz / 3), c);
  if (grille) b.roof(x0 + 0.35, x1 - 0.35, y1 + 0.005, hz * 0.6, grille);
}

/** Door on the side plane: frame + two leaves + windows. side: 1 right (+z), −1 left, 0 both. */
export function sideDoor(b: MeshBuilder, info: BodyInfo, xc: number, w: number, y0: number, y1: number, opt: {
  frame: RGB; leaf: RGB; win?: [number, number]; side?: 0 | 1 | -1; leaves?: 1 | 2; eps?: number; winColor?: RGB; low?: boolean;
}) {
  const z = info.zAt((y0 + y1) / 2) + (opt.eps ?? 0.02);
  const side = opt.side ?? 0;
  if (opt.low) { b.sideWindow(xc - w / 2, xc + w / 2, y0, y1, z, opt.leaf, 0, side); return; }
  b.sideWindow(xc - w / 2 - 0.05, xc + w / 2 + 0.05, y0, y1 + 0.05, z, opt.frame, 0.06, side);
  const n = opt.leaves ?? 2;
  const lw = (w - 0.03 * (n - 1)) / n;
  for (let k = 0; k < n; k++) {
    const a = xc - w / 2 + k * (lw + 0.03);
    b.sideWindow(a, a + lw, y0 + 0.01, y1, z + 0.006, opt.leaf, 0.03, side);
    if (opt.win) b.sideWindow(a + 0.09, a + lw - 0.09, opt.win[0], opt.win[1], z + 0.012, opt.winColor ?? P.glass, 0.08, side);
  }
}

// ------------------------------------------------------------------ finishing
export interface Built { geometry: THREE.BufferGeometry; size: [number, number, number] }

export function finish(b: MeshBuilder, L: number, H: number, W: number): THREE.BufferGeometry {
  return b.build([L, H, W]);
}

export type { Paint, V2 };
