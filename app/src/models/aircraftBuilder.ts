// Parametric low-poly airliner geometry (see models/aircraft.ts for the specs
// and AIRCRAFT_REFERENCE.md for the dimensions they come from).
//
// Frame (metres): +x forward, +y up, +z right (starboard). Origin = main
// landing-gear contact point, so the aircraft pitches about its main gear and
// sits on y = 0 with the gear down.
//
// Vertex attributes (5 buffers — the renderer adds one interleaved
// per-instance buffer; WebGPU allows 8 vertex buffers / 16 attributes):
//   position, normal
//   color  vec3  linear base colour for fixed parts (grey wing, tyres, glass …)
//   surf   vec4  (typeRow·8 + part, a, b, c) — part-specific shading coords:
//                fuselage: (dy = y − window-row centre [m], u = station / length,
//                           vn = (y − local centre) / local half height)
//                fin:      (tail-art u, v, 0)
//   anim   vec4  (pivot xyz, kind) — per-vertex rigid motion evaluated in the
//                vertex shader from per-instance gear / flap / prop / spoiler
//                values (ANIM kinds below). Pivots are per vertex, so a swept
//                flap rotates about its own hinge at every span station.
import * as THREE from 'three/webgpu';
import type { AircraftSpec } from './aircraft';

export const PART = { FIXED: 0, FUSE: 1, TAIL: 2, BELLY: 3, ACCENT: 4, ENGINE: 5, GEAR: 6, GLASS: 7 } as const;

/**
 * Per-vertex motion kinds (anim.w). g = gear extension 0 (up) … 1 (down).
 *  NOSE_GEAR   rotate about z through the pivot by (1−g)·90° (swings forward)
 *  MAIN_IN     rotate about x by (1−g)·90° towards the centreline (sign of pivot z)
 *  MAIN_FWD    rotate about z by +(1−g)·90° (turboprop gear folding forward)
 *  MAIN_AFT    rotate about z by −(1−g)·90°
 *  DOOR_TRANSIT  belly door hinged along x, open only while the gear moves
 *  DOOR_DOWN     door open while the gear is down (closes at g < 0.25)
 *  PROP        rotate about x by the instance propeller angle
 *  FLAP / SLAT / SPOILER  rotate about z by +flaps·32° / −flaps·22° / −spoiler·50°
 * Gear kinds collapse onto their pivot when fully retracted (hidden in the well).
 */
export const ANIM = {
  NONE: 0, NOSE_GEAR: 1, MAIN_IN: 2, MAIN_FWD: 3, MAIN_AFT: 4, DOOR_TRANSIT: 5, DOOR_DOWN: 6,
  PROP: 7, FLAP: 8, SLAT: 9, SPOILER: 10,
} as const;

type V3 = THREE.Vector3;
type C3 = [number, number, number];
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;
const lin = (hex: number): C3 => {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};
export const COL = {
  white: lin(0xf2f3f4), wing: lin(0xc4c9cf), wingDark: lin(0xa3aab2), walk: lin(0x8e959c), glass: lin(0x141a22),
  dark: lin(0x24272c), gear: lin(0x8b9097), strut: lin(0xc9ccd0), tyre: lin(0x141517), hub: lin(0x6d7278),
  metal: lin(0xb8bcc2), lip: lin(0xd9dcdf), fan: lin(0x2a2e33), exhaust: lin(0x4a4d52), prop: lin(0x1d1f22),
  well: lin(0x3b3f45), spinner: lin(0xe6e8ea),
};

// ------------------------------------------------------------------ mesh builder

class MB {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  srf: number[] = [];
  anm: number[] = [];
  idx: number[] = [];
  c: C3 = COL.white;
  part = 0;
  row = 0;
  surf: ((p: V3) => [number, number, number]) | null = null;
  kind = 0;
  pivot: V3 = V(0, 0, 0);
  /** per-row pivots for the next grid() (flaps / slats) */
  rowPivots: V3[] | null = null;

  set(c: C3, part: number, kind = 0, pivot?: V3, surf: MB['surf'] = null) {
    this.c = c; this.part = part; this.kind = kind; this.pivot = pivot ?? V(0, 0, 0); this.surf = surf; this.rowPivots = null;
    return this;
  }

  get nv() { return this.pos.length / 3; }

  vert(p: V3, n: V3, pivot = this.pivot) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.col.push(this.c[0], this.c[1], this.c[2]);
    const s = this.surf ? this.surf(p) : [0, 0, 0];
    this.srf.push(this.row * 8 + this.part, s[0], s[1], s[2]);
    this.anm.push(pivot.x, pivot.y, pivot.z, this.kind);
    return this.nv - 1;
  }

  /**
   * Quad grid through rows of points (rows[i][j]); `wrap` closes each row into
   * a loop. Smooth normals from finite differences, oriented away from each
   * row's centroid (or along `hint`).
   */
  grid(rows: V3[][], wrap: boolean, hint?: V3) {
    const R = rows.length, C = rows[0].length;
    const ns: V3[][] = [];
    let score = 0;
    const du = V(0, 0, 0), dv = V(0, 0, 0), cen = V(0, 0, 0);
    for (let i = 0; i < R; i++) {
      cen.set(0, 0, 0);
      for (const p of rows[i]) cen.add(p);
      cen.divideScalar(C);
      const out: V3[] = [];
      for (let j = 0; j < C; j++) {
        const jp = wrap ? (j + 1) % C : Math.min(C - 1, j + 1), jm = wrap ? (j - 1 + C) % C : Math.max(0, j - 1);
        const ip = Math.min(R - 1, i + 1), im = Math.max(0, i - 1);
        du.subVectors(rows[i][jp], rows[i][jm]);
        dv.subVectors(rows[ip][j], rows[im][j]);
        const n = du.clone().cross(dv);
        if (n.lengthSq() < 1e-12) {
          // degenerate (tip ring): borrow from the neighbour row
          const k = i === 0 ? 1 : i - 1;
          du.subVectors(rows[k][jp], rows[k][jm]);
          n.copy(du).cross(dv);
        }
        n.normalize();
        score += hint ? n.dot(hint) : n.dot(rows[i][j].clone().sub(cen));
        out.push(n);
      }
      ns.push(out);
    }
    const flip = score < 0;
    const base = this.nv;
    for (let i = 0; i < R; i++) {
      const pv = this.rowPivots ? this.rowPivots[i] : this.pivot;
      for (let j = 0; j < C; j++) this.vert(rows[i][j], flip ? ns[i][j].negate() : ns[i][j], pv);
    }
    const cols = wrap ? C : C - 1;
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < cols; j++) {
        const a = base + i * C + j, b = base + i * C + ((j + 1) % C), d = a + C, e = b + C;
        if (flip) this.idx.push(a, d, b, b, d, e);
        else this.idx.push(a, b, d, b, e, d);
      }
    }
  }

  /** flat convex polygon; `hint` picks the facing side */
  poly(pts: V3[], hint: V3, pivot = this.pivot) {
    const n = V(0, 0, 0);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y);
    }
    if (n.lengthSq() < 1e-14) return;
    n.normalize();
    const flip = n.dot(hint) < 0;
    if (flip) n.negate();
    const base = pts.map((q) => this.vert(q, n, pivot));
    for (let i = 1; i < pts.length - 1; i++) {
      if (flip) this.idx.push(base[0], base[i + 1], base[i]);
      else this.idx.push(base[0], base[i], base[i + 1]);
    }
  }

  poly2(pts: V3[], hint: V3) {
    this.poly(pts, hint);
    this.poly(pts, hint.clone().negate());
  }

  /** mirror vertices/triangles emitted since (v0, i0) across z = 0 */
  mirror(v0: number, i0: number) {
    const v1 = this.nv, i1 = this.idx.length;
    const off = v1 - v0;
    for (let v = v0; v < v1; v++) {
      this.pos.push(this.pos[v * 3], this.pos[v * 3 + 1], -this.pos[v * 3 + 2]);
      this.nrm.push(this.nrm[v * 3], this.nrm[v * 3 + 1], -this.nrm[v * 3 + 2]);
      this.col.push(this.col[v * 3], this.col[v * 3 + 1], this.col[v * 3 + 2]);
      this.srf.push(this.srf[v * 4], this.srf[v * 4 + 1], this.srf[v * 4 + 2], this.srf[v * 4 + 3]);
      this.anm.push(this.anm[v * 4], this.anm[v * 4 + 1], -this.anm[v * 4 + 2], this.anm[v * 4 + 3]);
    }
    for (let i = i0; i < i1; i += 3) {
      this.idx.push(this.idx[i] - v0 + v0 + off, this.idx[i + 2] + off, this.idx[i + 1] + off);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(this.srf), 4));
    g.setAttribute('anim', new THREE.BufferAttribute(new Float32Array(this.anm), 4));
    const n = this.nv;
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ shapes

/** default nose-profile stations (fraction of the nose length) */
export const PROF_T = [0, 0.03, 0.08, 0.15, 0.25, 0.38, 0.52, 0.68, 0.84, 1];
/** Catmull-Rom through (T[i], v[i]), clamped ends */
function cr(T: number[], v: number[], t: number) {
  const n = T.length;
  if (t <= T[0]) return v[0];
  if (t >= T[n - 1]) return v[n - 1];
  let i = 0;
  while (i < n - 2 && t > T[i + 1]) i++;
  const u = (t - T[i]) / (T[i + 1] - T[i]);
  const p0 = v[Math.max(0, i - 1)], p1 = v[i], p2 = v[i + 1], p3 = v[Math.min(n - 1, i + 2)];
  // tangents scaled to the local interval (non-uniform knots)
  const d0 = T[i + 1] - T[i];
  const m1 = i > 0 ? ((p2 - p0) / (T[i + 1] - T[i - 1])) * d0 : p2 - p1;
  const m2 = i + 2 < n ? ((p3 - p1) / (T[i + 2] - T[i])) * d0 : p2 - p1;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}

/** superellipse ease 0→1 with a round start (p = 2: quarter circle) */
const se = (t: number, p: number) => Math.pow(Math.max(0, 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), p)), 1 / p);

// airfoil: chord fractions, upper / lower surface offsets (× thickness)
const AF_F = [0, 0.015, 0.06, 0.15, 0.3, 0.45, 0.62, 0.8, 1];
const AF_U = [0, 0.34, 0.6, 0.82, 0.93, 0.9, 0.74, 0.44, 0.03];
const AF_L = [0, -0.32, -0.45, -0.52, -0.52, -0.44, -0.28, -0.13, -0.01];
const AF_S = [0, 0.38, 0.6, 0.8, 0.93, 0.96, 0.84, 0.54, 0.04]; // symmetric (fins, pylons)
const afAt = (tab: number[], f: number) => {
  for (let i = 1; i < AF_F.length; i++) {
    if (f <= AF_F[i] + 1e-9) {
      const t = (f - AF_F[i - 1]) / (AF_F[i] - AF_F[i - 1]);
      return tab[i - 1] + (tab[i] - tab[i - 1]) * t;
    }
  }
  return tab[tab.length - 1];
};

interface Sec {
  /** leading-edge point */
  le: V3;
  chord: number;
  /** thickness / chord */
  tc: number;
  /** unit chord direction (LE → TE) and thickness direction */
  dir?: V3;
  up?: V3;
}

/**
 * Loft an airfoil piece (chord range c0..c1) through spanwise sections.
 * `sym` = symmetric section (fin / pylon), `coarse` = LOD sampling.
 */
function airfoil(b: MB, secs: Sec[], c0: number, c1: number, sym: boolean, coarse = false, capEnds = true) {
  const fr = [c0];
  for (const f of coarse ? [0.35] : AF_F) if (f > c0 + 0.02 && f < c1 - 0.02) fr.push(f);
  fr.push(c1);
  const rows: V3[][] = [];
  for (const s of secs) {
    const dir = s.dir ?? V(-1, 0, 0), up = s.up ?? V(0, 1, 0);
    const T = s.tc * s.chord;
    const at = (f: number, tab: number[]) => s.le.clone().addScaledVector(dir, f * s.chord).addScaledVector(up, T * afAt(tab, f) * (sym ? 0.5 : 1));
    const ring: V3[] = [];
    for (const f of fr) ring.push(at(f, sym ? AF_S : AF_U));
    for (let k = fr.length - 1; k >= 0; k--) ring.push(sym ? at(fr[k], AF_S).addScaledVector(up, -T * afAt(AF_S, fr[k])) : at(fr[k], AF_L));
    rows.push(ring);
  }
  b.grid(rows, true);
  if (capEnds) {
    const pv = b.rowPivots;
    const out0 = secs[0].le.clone().sub(secs[1].le).normalize();
    const out1 = secs[secs.length - 1].le.clone().sub(secs[secs.length - 2].le).normalize();
    b.poly(rows[0], out0, pv ? pv[0] : b.pivot);
    b.poly(rows[rows.length - 1], out1, pv ? pv[pv.length - 1] : b.pivot);
  }
}

/** ring loft around an axis parallel to x: rings [x, y, z, ry (top), rz, ryBottom?] */
function tube(b: MB, rings: [number, number, number, number, number, number?][], seg: number, cap0 = false, cap1 = false) {
  const rows: V3[][] = [];
  for (const [x, y, z, ry, rz, ryb] of rings) {
    const ring: V3[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const c = Math.cos(a);
      ring.push(V(x, y + c * (c < 0 && ryb !== undefined ? ryb : ry), z + Math.sin(a) * rz));
    }
    rows.push(ring);
  }
  b.grid(rows, true);
  if (cap0) b.poly(rows[0], V(rings[0][0] < rings[1][0] ? -1 : 1, 0, 0));
  if (cap1) { const n = rings.length; b.poly(rows[n - 1], V(rings[n - 1][0] > rings[n - 2][0] ? 1 : -1, 0, 0)); }
}

/** cylinder between two points (struts, axles, tyres) */
function cyl(b: MB, a: V3, c: V3, r: number, seg: number, caps = true, r2 = r) {
  const ax = c.clone().sub(a);
  const len = ax.length();
  if (len < 1e-4) return;
  ax.divideScalar(len);
  const t1 = Math.abs(ax.y) < 0.9 ? V(0, 1, 0).cross(ax).normalize() : V(1, 0, 0).cross(ax).normalize();
  const t2 = ax.clone().cross(t1);
  const ring = (p: V3, rr: number) => Array.from({ length: seg }, (_, j) => {
    const q = (j / seg) * Math.PI * 2;
    return p.clone().addScaledVector(t1, Math.cos(q) * rr).addScaledVector(t2, Math.sin(q) * rr);
  });
  const r0 = ring(a, r), r1 = ring(c, r2);
  b.grid([r0, r1], true);
  if (caps) { b.poly(r0, ax.clone().negate()); b.poly(r1, ax); }
}

function wheel(b: MB, c: V3, r: number, w: number, seg: number) {
  b.c = COL.tyre;
  const a = c.clone().setZ(c.z - w / 2), d = c.clone().setZ(c.z + w / 2);
  // tyre with a rounded shoulder, hub caps
  const ring = (z: number, rr: number) => Array.from({ length: seg }, (_, j) => {
    const q = (j / seg) * Math.PI * 2;
    return V(c.x + Math.cos(q) * rr, c.y + Math.sin(q) * rr, z);
  });
  const rows = [ring(a.z, r * 0.78), ring(a.z + w * 0.12, r * 0.97), ring(d.z - w * 0.12, r * 0.97), ring(d.z, r * 0.78)];
  b.grid(rows, true);
  b.c = COL.hub;
  b.poly(rows[0], V(0, 0, -1));
  b.poly(rows[3], V(0, 0, 1));
}

// ------------------------------------------------------------------ aircraft

export interface AircraftPoints {
  wingTipL: V3; wingTipR: V3; tail: V3; beaconTop: V3; beaconBottom: V3;
  landing: V3; nose: V3; taxi: V3;
  /** x of nose / tail relative to origin */
  noseX: number; tailX: number;
  /** fin centre (model frame) and tail-art square size (m) */
  finCentre: V3; finArt: number;
}

export interface BuiltAircraft { geometry: THREE.BufferGeometry; low: THREE.BufferGeometry; points: AircraftPoints }

export function buildAircraft(s: AircraftSpec, row: number): BuiltAircraft {
  const hi = build(s, row, false);
  const lo = build(s, row, true);
  return { geometry: hi.geo, low: lo.geo, points: hi.points };
}

function build(s: AircraftSpec, row: number, low: boolean): { geo: THREE.BufferGeometry; points: AircraftPoints } {
  const b = new MB();
  b.row = row;
  const L = s.fus.len ?? s.length;
  const W = s.fus.w, H = s.fus.h;
  const R = W / 2, RH = H / 2;
  const mainFromNose = s.gear.nose + s.gear.base;
  const X = (fromNose: number) => mainFromNose - fromNose;
  const cy = s.fus.belly + RH;
  const Ln = s.fus.nose, Lt = s.fus.tail;
  const tp = s.cls === 'turboprop';

  // ---------------------------------------------------------------- fuselage profile
  const yTip = cy + s.fus.tipY * RH;
  const endTop = cy + (s.fus.endY + s.fus.endR) * RH, endBot = cy + (s.fus.endY - s.fus.endR) * RH;
  const [pT, pB, pW] = s.fus.noseShape;
  const P = s.fus.prof;
  const PT = P?.T ?? PROF_T;
  const fus = (sn: number) => {
    let top: number, bot: number, hw: number;
    if (sn < Ln && P) {
      const t = Math.max(0, sn / Ln);
      top = cy + RH * cr(PT, P.top, t);
      bot = cy + RH * cr(PT, P.bot, t);
      hw = Math.max(0.03, R * cr(PT, P.w, t));
    } else if (sn < Ln) {
      const t = Math.max(0, sn / Ln);
      top = yTip + (cy + RH - yTip) * se(t, pT);
      bot = yTip - (yTip - (cy - RH)) * se(t, pB);
      hw = Math.max(0.03, R * se(t, pW));
    } else if (sn > L - Lt) {
      const t = Math.min(1, (sn - (L - Lt)) / Lt);
      top = cy + RH + (endTop - (cy + RH)) * Math.pow(t, s.fus.tailTop);
      bot = cy - RH + (endBot - (cy - RH)) * Math.pow(t, 1.12);
      hw = R + (s.fus.endR * RH - R) * Math.pow(t, 1.25);
    } else { top = cy + RH; bot = cy - RH; hw = R; }
    return { y: (top + bot) / 2, hh: Math.max(0.03, (top - bot) / 2), hw };
  };
  /** surface point at station sn (m from nose), angle a (rad, 0 = top, + towards +z), offset along the normal */
  const fp = (sn: number, a: number, off = 0) => {
    const f = fus(sn);
    const n = V(0, Math.cos(a) / f.hh, Math.sin(a) / f.hw).normalize();
    return V(X(sn), f.y + Math.cos(a) * f.hh, Math.sin(a) * f.hw).addScaledVector(n, off);
  };
  const winY = cy + s.win.y;
  const fusSurf = (p: V3): [number, number, number] => {
    const sn = mainFromNose - p.x;
    const f = fus(Math.min(L, Math.max(0, sn)));
    return [p.y - winY, sn / L, (p.y - f.y) / f.hh];
  };

  // stations
  const noseT = low ? [0, 0.12, 0.45, 1] : P
    ? Array.from(new Set([...PT, ...PT.slice(0, 6).map((t, i) => (t + PT[i + 1]) / 2)])).sort((a, c) => a - c)
    : [0, 0.015, 0.05, 0.1, 0.17, 0.26, 0.37, 0.5, 0.64, 0.8, 1];
  const tailT = low ? [0, 0.5, 1] : [0, 0.12, 0.26, 0.4, 0.55, 0.7, 0.85, 1];
  const st: number[] = [];
  for (const t of noseT) st.push(t * Ln);
  if (!low) st.push(Ln + (L - Lt - Ln) * 0.5);
  for (const t of tailT) st.push(L - Lt + t * Lt);
  const SEG = low ? 8 : 22;
  {
    b.set(COL.white, PART.FUSE, 0, undefined, fusSurf);
    const rows: V3[][] = [];
    for (let i = st.length - 1; i >= 0; i--) {
      const f = fus(st[i]);
      const ring: V3[] = [];
      for (let j = 0; j < SEG; j++) {
        const a = (j / SEG) * Math.PI * 2;
        // slightly squarer lower lobe (floor beams / cargo hold)
        const c = Math.cos(a), sn = Math.sin(a);
        const sq = c < 0 ? 1 + 0.04 * Math.sin(2 * a) ** 2 : 1;
        ring.push(V(X(st[i]), f.y + c * f.hh, sn * f.hw * sq));
      }
      rows.push(ring);
    }
    b.grid(rows, true);
    // APU exhaust
    b.set(COL.dark, PART.FIXED);
    b.poly(rows[0].map((p) => p.clone().setX(p.x + 0.01)), V(-1, 0, 0));
  }

  // ---------------------------------------------------------------- cockpit windows
  // Panes are small grids that follow the nose surface (flat quads would sink
  // into the curvature). Corners are [ds, dy, crown] in metres from the
  // windshield's lower front point (spec.ck: station, height above the centre
  // line, size scale); crown corners sit on the nose crown line at that station.
  if (!low) {
    b.set(COL.glass, PART.GLASS);
    const [sc, yb, k] = s.ck;
    const crownY = (sn: number) => { const f = fus(sn); return f.y + f.hh; };
    const panes: [number, number][][] = s.panes
      ? s.panes.map((pn) => pn.map(([sn, y]) => [sn, y === null ? crownY(sn) - 0.02 : cy + y] as [number, number]))
      : COCKPIT[s.cockpit].map((pane) => pane.map(([ds, dy, crn]) => {
        const sn = sc + ds * k;
        return [sn, crn ? crownY(sn) - 0.02 : cy + yb + dy * k] as [number, number];
      }));
    for (const cs of panes) {
      const n = 3;
      const rows: V3[][] = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const row: V3[] = [];
        for (let j = 0; j <= n; j++) {
          const v = j / n;
          // bilinear: c0 front-bottom, c1 rear-bottom, c2 rear-top, c3 front-top
          const sn = (cs[0][0] * (1 - u) + cs[1][0] * u) * (1 - v) + (cs[3][0] * (1 - u) + cs[2][0] * u) * v;
          const y = (cs[0][1] * (1 - u) + cs[1][1] * u) * (1 - v) + (cs[3][1] * (1 - u) + cs[2][1] * u) * v;
          const f = fus(sn);
          const h = Math.max(-0.98, Math.min(0.995, (y - f.y) / f.hh));
          row.push(fp(sn, Math.max(5 * DEG, Math.acos(h)), 0.02));
        }
        rows.push(row);
      }
      const v0 = b.nv, i0 = b.idx.length;
      b.grid(rows, false, V(0.3, 0.3, 1));
      b.mirror(v0, i0);
    }
  }

  // ---------------------------------------------------------------- wing
  const w = s.wing;
  const half = s.span / 2 - (w.tipDev === 'none' || w.tipDev === 'raked' ? 0 : 0.15);
  const rootY = w.high ? cy + RH * 0.86 : cy + w.y * RH;
  const secAtRoot = fus(w.x + w.root * 0.4);
  const zr = w.high ? R * 0.35 : Math.max(0.3, secAtRoot.hw * Math.sqrt(Math.max(0, 1 - ((rootY - secAtRoot.y) / secAtRoot.hh) ** 2)) - 0.1);
  const sweep = w.sweep * DEG, dih = w.dih * DEG;
  const leX = (z: number) => X(w.x) - Math.tan(sweep) * (z - zr) - (w.tipDev === 'raked' ? rake(z) : 0);
  const rakeStart = half - Math.max(2.5, s.span * 0.06);
  function rake(z: number) { return z > rakeStart ? ((z - rakeStart) ** 2 / (half - rakeStart)) * 0.9 : 0; }
  const wy = (z: number) => rootY + Math.tan(dih) * (z - zr);
  const zk = w.kink > 0 ? zr + (half - zr) * w.kink : zr;
  const teRootX = X(w.x) - w.root;
  const teTipX = leX(half) - w.tip;
  const teX = (z: number) => {
    if (w.kink > 0 && z <= zk) return teRootX - (z - zr) * Math.tan(w.teSweepIn * DEG);
    const zk0 = w.kink > 0 ? zk : zr;
    const x0 = w.kink > 0 ? teRootX - (zk - zr) * Math.tan(w.teSweepIn * DEG) : teRootX;
    return x0 + (teTipX - x0) * ((z - zk0) / (half - zk0));
  };
  const chordAt = (z: number) => Math.max(0.3, leX(z) - teX(z));
  const tcAt = (z: number) => w.tc * (1 - 0.32 * ((z - zr) / (half - zr)));
  const upv = V(0, Math.cos(dih), -Math.sin(dih));
  const wsec = (z: number, ext = 0): Sec => ({ le: V(leX(z) + ext, wy(z), z), chord: chordAt(z) + ext, tc: tcAt(z), up: upv });
  const eng = s.eng;
  const engZ = eng.mount === 'wing' ? eng.z : 0;
  const zA = zr + (half - zr) * (tp ? 0.62 : 0.7); // aileron start
  const zSlat = eng.mount === 'wing' && !tp ? engZ + eng.d * 0.7 : zr + (half - zr) * 0.25;
  const hasSlats = !tp && s.cls !== 'regional' ? true : s.code !== 'CRJ9' && !tp;
  const stations = low
    ? Array.from(new Set([zr, ...(w.kink > 0 ? [zk] : []), half].map((z) => +z.toFixed(3)))).sort((a, c) => a - c)
    : Array.from(new Set([zr, ...(w.kink > 0 ? [zk] : []), ...(hasSlats ? [zSlat] : []), zA, half].map((z) => +z.toFixed(3)))).sort((a, c) => a - c);
  const FLAP = tp ? 0.7 : 0.74, SLATC = 0.13;
  let tipLE = V(leX(half), wy(half), half);
  {
    const v0 = b.nv, i0 = b.idx.length;
    for (let k = 0; k < stations.length - 1; k++) {
      const z0 = stations[k], z1 = stations[k + 1];
      const secs = low ? [wsec(z0), wsec(z1)] : [wsec(z0), wsec((z0 + z1) / 2), wsec(z1)];
      const slat = !low && hasSlats && z0 >= zSlat - 0.01;
      const flap = !low && z1 <= zA + 0.01;
      if (low) {
        b.set(COL.wing, PART.FIXED);
        airfoil(b, secs, 0, 1, false, true, k === stations.length - 2);
        continue;
      }
      // leading edge: slat (moving) or fixed
      b.set(COL.metal, PART.FIXED);
      if (slat) {
        b.kind = ANIM.SLAT;
        b.rowPivots = secs.map((q) => q.le.clone().addScaledVector(V(-1, 0, 0), q.chord * 0.3).addScaledVector(upv, -q.chord * 0.1));
      }
      airfoil(b, secs, 0, SLATC, false, false, true);
      b.set(COL.wing, PART.FIXED);
      airfoil(b, secs, SLATC, FLAP, false, false, false);
      if (flap) {
        b.set(COL.wing, PART.FIXED, ANIM.FLAP);
        b.rowPivots = secs.map((q) => q.le.clone().addScaledVector(V(-1, 0, 0), q.chord * (FLAP - 0.02)).addScaledVector(upv, -q.chord * q.tc * 1.4));
      } else b.set(COL.wingDark, PART.FIXED);
      airfoil(b, secs, FLAP, 1, false, false, true);
    }
    if (!low) {
      // tip cap
      b.set(COL.wing, PART.FIXED);
    }
    // winglet / tip device
    tipLE = V(leX(half), wy(half), half);
    const tc = chordAt(half);
    if (w.tipDev !== 'none' && w.tipDev !== 'raked') {
      b.set(COL.white, PART.TAIL);
      const h = w.tipH;
      const secs: Sec[] = [];
      const n = low ? 1 : 5;
      const cant = w.tipCant ?? (w.tipDev === 'small' ? 20 : w.tipDev === 'curved' ? 12 : 8); // deg from vertical (outward)
      const radius = w.tipDev === 'blended' || w.tipDev === 'curved' ? Math.min(1.4, h * 0.45) : w.tipDev === 'sharklet' ? 0.7 : 0.4;
      const back = w.tipSweep ?? 38;
      const topChord = tc * (w.tipDev === 'small' ? 0.45 : 0.32);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        // curve: arc of `radius` then straight up (canted)
        const arcLen = (Math.PI / 2 - cant * DEG) * radius;
        const total = arcLen + (h - radius);
        const d = t * total;
        let y: number, z: number, ang: number;
        if (d < arcLen) {
          ang = d / radius; // 0 horizontal → up
          y = radius * (1 - Math.cos(ang)); z = radius * Math.sin(ang);
        } else {
          ang = Math.PI / 2 - cant * DEG;
          const rest = d - arcLen;
          y = radius * (1 - Math.cos(ang)) + rest * Math.sin(ang); z = radius * Math.sin(ang) + rest * Math.cos(ang);
        }
        const chord = tc + (topChord - tc) * Math.min(1, y / h * 1.05 + t * 0.2);
        const le = V(tipLE.x - Math.tan(back * DEG) * y - (tc - chord) * 0.15, tipLE.y + y, half + z);
        secs.push({ le, chord, tc: 0.09 });
      }
      // thickness direction: perpendicular to the local span direction in the y-z plane
      for (let i = 0; i < secs.length; i++) {
        const a = secs[Math.max(0, i - 1)].le, c = secs[Math.min(secs.length - 1, i + 1)].le;
        const sp = V(0, c.y - a.y, c.z - a.z).normalize();
        secs[i].up = V(0, sp.z, -sp.y);
      }
      airfoil(b, secs, 0, 1, false, low, true);
      if (w.tipDev === 'split' && !low) {
        // MAX lower (ventral) tip
        const d0 = { le: V(tipLE.x - tc * 0.12, tipLE.y - 0.05, half - 0.05), chord: tc * 0.7, tc: 0.09, up: V(0, 0.2, 1).normalize() };
        const d1 = { le: V(tipLE.x - tc * 0.12 - 0.7, tipLE.y - 1.1, half + 0.35), chord: tc * 0.28, tc: 0.09, up: V(0, 0.3, 1).normalize() };
        airfoil(b, [d0, d1], 0, 1, false, false, true);
      }
    }
    b.mirror(v0, i0);
  }
  const tipTopX = tipLE.x - chordAt(half) * 0.4;

  // wing-to-body fairing (low wings)
  if (!w.high) {
    b.set(COL.white, PART.BELLY);
    const x0 = w.x - w.root * 0.22, x1 = w.x + w.root * 1.28;
    const fr = low ? [0, 0.3, 0.7, 1] : [0, 0.08, 0.2, 0.4, 0.6, 0.8, 0.92, 1];
    const rings: [number, number, number, number, number, number?][] = [];
    for (const t of fr) {
      const sn = x1 - (x1 - x0) * t;
      const f = fus(sn);
      const e = Math.sin(Math.PI * Math.pow(t, t < 0.5 ? 0.9 : 1.2)); // bulge
      const e2 = Math.max(0.05, Math.pow(e, 0.6));
      rings.push([X(sn), f.y - RH * 0.28 * e2, 0, RH * 0.8 * e2 + 0.02, f.hw * (0.62 + 0.42 * e2), f.hh * 0.28 * e2 + RH * 0.62 * e2 + 0.05]);
    }
    if (!low) tube(b, rings, 16);
  }

  // ---------------------------------------------------------------- engines
  const engNodes: V3[] = [];
  {
    const r = eng.d / 2;
    const v0 = b.nv, i0 = b.idx.length;
    if (eng.mount === 'wing') {
      const z = eng.z;
      const xLip = X(eng.x);
      if (eng.kind === 'fan') {
        const ey = eng.y ?? Math.max(r + 0.45, wy(z) - r * 1.05);
        engNodes.push(V(xLip, ey, z));
        fanNacelle(b, xLip, ey, z, eng, low);
        // pylon
        if (!low) {
          b.set(COL.wing, PART.FIXED);
          const lx = leX(z), yw = wy(z) - tcAt(z) * chordAt(z) * 0.35;
          const top: Sec = { le: V(Math.min(lx + 0.6, xLip - eng.len * 0.25), yw + 0.3, z), chord: Math.max(eng.len * 0.9, chordAt(z) * 0.62), tc: 0.1, up: V(0, 0, 1) };
          const bot: Sec = { le: V(xLip - eng.len * 0.2, ey + r * 0.8, z), chord: eng.len * 1.05, tc: 0.1, up: V(0, 0, 1) };
          airfoil(b, [bot, top], 0, 1, true, false, false);
        }
      } else {
        // turboprop nacelle slung under a high wing, extending aft past the trailing edge (houses the main gear)
        const ey = eng.y ?? wy(z) - r * 0.35;
        engNodes.push(V(xLip, ey, z));
        propNacelle(b, xLip, ey, z, eng, wy(z), teX(z), low);
      }
    } else {
      // aft-mounted (CRJ): nacelles on stub pylons beside the rear fuselage
      const xLip = X(eng.x);
      const ey = eng.y ?? cy + RH * 0.35;
      const z = eng.z;
      engNodes.push(V(xLip, ey, z));
      fanNacelle(b, xLip, ey, z, eng, low);
      b.set(COL.wing, PART.FIXED);
      const f = fus(eng.x + eng.len * 0.5);
      const pz = f.hw * 0.7;
      airfoil(b, [
        { le: V(xLip - eng.len * 0.3, ey + 0.05, pz), chord: eng.len * 0.5, tc: 0.12, up: V(0, 1, 0) },
        { le: V(xLip - eng.len * 0.3, ey + 0.05, z - r * 0.7), chord: eng.len * 0.5, tc: 0.12, up: V(0, 1, 0) },
      ], 0, 1, true, low, false);
    }
    b.mirror(v0, i0);
  }

  // ---------------------------------------------------------------- tail
  const top = cy + RH;
  const fin = s.fin;
  const finRootY = fus(fin.x + fin.root * 0.3).y + fus(fin.x + fin.root * 0.3).hh - 0.25;
  const finTopY = s.height;
  const finH = finTopY - finRootY;
  const finLE0 = V(X(fin.x), finRootY, 0);
  const finLE1 = V(finLE0.x - Math.tan(fin.sweep * DEG) * finH, finTopY, 0);
  const finCentre = V((finLE0.x - fin.root * 0.5 + finLE1.x - fin.tip * 0.5) / 2, finRootY + finH * 0.5, 0);
  const finArt = Math.max(finH, fin.root) * 1.08;
  {
    b.set(COL.white, PART.TAIL, 0, undefined, (p) => [0.5 + (finCentre.x - p.x) / finArt, 0.5 + (p.y - finCentre.y) / finArt, 0]);
    const secs: Sec[] = [];
    const n = low ? 1 : 3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const le = finLE0.clone().lerp(finLE1, t);
      secs.push({ le, chord: fin.root + (fin.tip - fin.root) * t, tc: fin.tc ?? 0.11, up: V(0, 0, 1) });
    }
    // extend the root down into the fuselage
    secs[0] = { ...secs[0], le: secs[0].le.clone().add(V(Math.tan(fin.sweep * DEG) * 0.4, -0.4, 0)) };
    airfoil(b, secs, 0, 1, true, low, true);
    if (fin.dorsal && !low) {
      // dorsal fillet
      const d = fin.dorsal;
      airfoil(b, [
        { le: V(finLE0.x + d, top - 0.2 - (fus(fin.x - d).hh < RH ? RH - fus(fin.x - d).hh : 0), 0), chord: d + fin.root * 0.3, tc: 0.05, up: V(0, 0, 1) },
        { le: V(finLE0.x - Math.tan(fin.sweep * DEG) * finH * 0.14, finRootY + finH * 0.14, 0), chord: fin.root * 0.4, tc: 0.06, up: V(0, 0, 1) },
      ], 0, 1, true, false, false);
    }
    if (fin.t && !low && tp) {
      // bullet fairing at the fin tip (Q400)
      b.set(COL.white, PART.TAIL);
      tube(b, [[finLE1.x - fin.tip * 1.05, finTopY - 0.05, 0, 0.05, 0.05], [finLE1.x - fin.tip * 0.6, finTopY - 0.05, 0, 0.2, 0.2], [finLE1.x + 0.3, finTopY - 0.05, 0, 0.16, 0.16], [finLE1.x + 0.9, finTopY - 0.05, 0, 0.02, 0.02]], 8);
    }
  }
  // horizontal stabiliser
  {
    const hs = s.hs;
    const v0 = b.nv, i0 = b.idx.length;
    b.set(COL.wing, PART.FIXED);
    let rl: V3;
    if (fin.t) rl = V(finLE1.x - fin.tip * 0.02, finTopY - 0.12, 0.05);
    else { const f = fus(hs.x + hs.root * 0.4); rl = V(X(hs.x), f.y + hs.y * f.hh, Math.max(0.2, f.hw * 0.55)); }
    const hsHalf = hs.span / 2;
    const tl = V(rl.x - Math.tan(hs.sweep * DEG) * (hsHalf - rl.z), rl.y + Math.tan(hs.dih * DEG) * (hsHalf - rl.z), hsHalf);
    const secs: Sec[] = [{ le: rl, chord: hs.root, tc: 0.1 }, { le: tl, chord: hs.tip, tc: 0.08 }];
    airfoil(b, secs, 0, 1, false, low, true);
    b.mirror(v0, i0);
  }

  // ---------------------------------------------------------------- landing gear
  const g = s.gear;
  const tyreR = g.tyre / 2, noseR = g.noseTyre / 2;
  if (!low) {
    const seg = 10;
    // ---- nose gear (retracts forward)
    const xn = X(g.nose);
    const fN = fus(g.nose);
    const bellyN = fN.y - fN.hh;
    const pivN = V(xn - 0.1, bellyN + Math.min(0.55, fN.hh * 0.35), 0);
    b.set(COL.strut, PART.GEAR, ANIM.NOSE_GEAR, pivN);
    const axleN = V(xn, noseR, 0);
    cyl(b, pivN, axleN.clone().add(V(-0.05, noseR * 0.7, 0)), 0.09, 6);
    b.c = COL.gear;
    cyl(b, axleN.clone().add(V(0.05, noseR * 0.6, 0)), axleN.clone().add(V(-0.05, noseR * 0.2, 0)), 0.07, 6, false);
    b.set(COL.tyre, PART.GEAR, ANIM.NOSE_GEAR, pivN);
    for (const sg of [-1, 1]) wheel(b, V(axleN.x, noseR, sg * (noseR * 0.62 + 0.08)), noseR, noseR * 0.62, seg);
    // nose bay doors (hinged along the bay edges, open while the gear is down)
    const bayL = pivN.x - axleN.x + noseR * 2 + 0.4;
    const bayW = Math.min(fN.hw * 0.55, noseR * 1.35 + 0.15);
    {
      b.set(COL.white, PART.FUSE, ANIM.DOOR_TRANSIT, V(0, bellyN - 0.02, bayW), fusSurf);
      const v0 = b.nv, i0 = b.idx.length;
      const x0 = pivN.x + 0.3, x1 = pivN.x + 0.3 - bayL;
      const hz = bayW;
      b.pivot = V(0, bellyN - 0.015, hz);
      b.poly([V(x0, bellyN - 0.02, 0.03), V(x1, bellyN - 0.02, 0.03), V(x1, bellyN - 0.02 + hz * hz * 0.02, hz), V(x0, bellyN - 0.02 + hz * hz * 0.02, hz)], V(0, -1, 0));
      b.poly([V(x0, bellyN - 0.005, 0.03), V(x1, bellyN - 0.005, 0.03), V(x1, bellyN - 0.005, hz), V(x0, bellyN - 0.005, hz)], V(0, 1, 0));
      b.mirror(v0, i0);
    }
    // ---- main gear
    const nac = tp && !g.sponson;
    if (g.sponson) {
      // sponson fairings low on the fuselage sides (house the main gear)
      const v0s = b.nv, i0s = b.idx.length;
      b.set(COL.white, PART.BELLY);
      const fz = fus(mainFromNose).hw * 0.72, fy = s.fus.belly + 0.55;
      tube(b, [[-3.2, fy + 0.2, fz, 0.12, 0.12], [-2.2, fy, fz + 0.1, 0.5, 0.5, 0.5], [-0.5, fy, fz + 0.35, 0.62, 0.62, 0.62],
        [1.4, fy, fz + 0.3, 0.6, 0.58, 0.6], [2.8, fy + 0.1, fz, 0.35, 0.3, 0.35], [3.6, fy + 0.2, fz - 0.2, 0.06, 0.06]], 12);
      b.mirror(v0s, i0s);
    }
    const mz = g.track / 2;
    const nWheels = g.main;
    const v0 = b.nv, i0 = b.idx.length;
    let piv: V3;
    let kind: number = ANIM.MAIN_IN;
    if (nac) {
      // turboprop: legs retract into the engine nacelles
      const en = engNodes[0];
      // pivot above the axle; the leg folds fore / aft into the nacelle belly
      piv = V(0.25, en.y - eng.d * 0.25, mz);
      kind = g.retract === 'fwd' ? ANIM.MAIN_FWD : ANIM.MAIN_AFT;
    } else if (g.sponson) {
      // ATR-style: short legs folding inward into fuselage-side sponsons
      piv = V(0.1, s.fus.belly + 0.75, mz);
    } else {
      const zz = Math.min(mz, half * 0.5);
      piv = V(0.15, wy(zz) - tcAt(zz) * chordAt(zz) * 0.3, mz);
    }
    const legLen = piv.y - tyreR;
    b.set(COL.strut, PART.GEAR, kind, piv);
    const axleY = tyreR;
    const bogie = nWheels >= 4;
    const axles = nWheels === 6 ? [-1, 0, 1] : nWheels === 4 ? [-0.5, 0.5] : [0];
    const bogieLen = nWheels === 6 ? g.tyre * 2.3 : g.tyre * 1.45;
    const legBot = V(nac ? 0 : piv.x, axleY + (bogie ? 0.25 : tyreR * 0.35), mz);
    cyl(b, piv, legBot, Math.max(0.1, g.tyre * 0.13), 6);
    // side / drag brace towards the fuselage (moves with the leg)
    b.c = COL.gear;
    if (!nac) cyl(b, V(piv.x - 0.1, piv.y - legLen * 0.45, mz), V(piv.x - 0.1, piv.y - 0.1, mz - Math.min(legLen * 0.6, 1.2)), 0.06, 5);
    else cyl(b, V(piv.x, piv.y - legLen * 0.45, mz), V(piv.x + (g.retract === 'fwd' ? -1 : 1) * legLen * 0.45, piv.y - 0.05, mz), 0.07, 5);
    if (bogie) cyl(b, V(bogieLen / 2 + 0.2, axleY + 0.05, mz), V(-bogieLen / 2 - 0.2, axleY + 0.05, mz), 0.1, 6);
    b.set(COL.tyre, PART.GEAR, kind, piv);
    const wsp = g.tyre * 0.36 + 0.12; // half spacing between the pair
    for (const a of axles) {
      for (const sg of [-1, 1]) wheel(b, V(a * bogieLen, tyreR, mz + sg * wsp), tyreR, g.tyre * 0.3, seg);
    }
    // leg fairing door (outboard side of the leg, closes the well when retracted)
    if (!nac && g.doors) {
      b.set(COL.white, PART.BELLY, kind, piv);
      const dz = mz + 0.22;
      const dw = Math.min(1.4, g.tyre * 1.2);
      b.poly2([V(piv.x + dw / 2, piv.y - 0.05, dz), V(piv.x - dw / 2, piv.y - 0.05, dz), V(piv.x - dw / 2, piv.y - legLen * 0.62, dz), V(piv.x + dw / 2, piv.y - legLen * 0.62, dz)], V(0, 0, 1));
      // belly well doors (sequence doors: open only while the gear travels)
      const f = fus(mainFromNose);
      const by = f.y - f.hh;
      const hz = Math.min(f.hw * 0.62, 1.5);
      const dl = bogie ? bogieLen + g.tyre + 0.6 : g.tyre * 1.4;
      b.set(COL.white, PART.FUSE, ANIM.DOOR_TRANSIT, V(0, by - 0.02, hz), fusSurf);
      b.poly([V(dl / 2, by - 0.02, 0.05), V(-dl / 2, by - 0.02, 0.05), V(-dl / 2, by + 0.04, hz), V(dl / 2, by + 0.04, hz)], V(0, -1, 0));
    }
    // turboprop nacelle gear doors
    if (nac) {
      const en = engNodes[0];
      const dl = eng.len * 0.42;
      const x0 = piv.x + (g.retract === 'fwd' ? 0.4 : -0.1), x1 = x0 - dl;
      const by = en.y - eng.d * 0.42;
      for (const sg of [-1, 1]) {
        const hz = mz + sg * eng.d * 0.33;
        b.set(COL.white, PART.ENGINE, ANIM.DOOR_DOWN, V(0, by, hz));
        b.poly2([V(x0, by, mz), V(x1, by, mz), V(x1, by, hz), V(x0, by, hz)], V(0, -1, 0));
      }
    }
    b.mirror(v0, i0);
  }

  const geo = b.build();
  const tailEnd = X(L);
  const points: AircraftPoints = {
    wingTipL: V(tipTopX, tipLE.y + 0.05, -half - 0.12),
    wingTipR: V(tipTopX, tipLE.y + 0.05, half + 0.12),
    tail: V(tailEnd - 0.05, endTop - s.fus.endR * RH, 0),
    beaconTop: V(X(w.x + w.root * 0.3), top + 0.18, 0),
    beaconBottom: V(X(w.x - 1), cy - RH - (w.high ? 0.12 : 0.35), 0),
    landing: w.high ? V(engNodes[0]?.x ?? 0, (engNodes[0]?.y ?? cy) - eng.d * 0.3, (engNodes[0]?.z ?? 3) - eng.d * 0.7) : V(leX(zr + 1.2) - 0.4, wy(zr + 1.2) - 0.2, zr + 1.2),
    nose: V(X(g.nose) + 0.1, noseR * 2 + 0.35, 0),
    taxi: V(X(g.nose) + 0.15, noseR * 2 + 0.5, 0),
    noseX: X(0), tailX: tailEnd,
    finCentre, finArt,
  };
  return { geo, points };
}

// ------------------------------------------------------------------ engines

function fanNacelle(b: MB, xLip: number, y: number, z: number, e: AircraftSpec['eng'], low: boolean) {
  const r = e.d / 2, len = e.len;
  const flat = e.flat ? 0.8 : 1; // 737NG / MAX flattened lower lip
  const seg = low ? 7 : 18;
  const core = e.core ?? 0.55; // core cowl radius / nacelle radius
  const fanLen = len * (e.short ? 0.62 : 0.72); // fan cowl length (then core cowl + plug)
  b.set(COL.white, PART.ENGINE);
  // outer cowl, from the nozzle forward to the lip, then into the intake
  const rings: [number, number, number, number, number, number?][] = low
    ? [[xLip - fanLen, y, z, r * 0.84, r * 0.84], [xLip - len * 0.3, y, z, r, r, r * flat], [xLip, y, z, r * 0.9, r * 0.9, r * 0.9 * flat]]
    : [
      [xLip - fanLen, y, z, r * 0.8, r * 0.8],
      [xLip - fanLen * 0.75, y, z, r * 0.93, r * 0.93, r * 0.93 * flat],
      [xLip - len * 0.32, y, z, r, r, r * flat],
      [xLip - len * 0.1, y, z, r * 0.98, r * 0.98, r * 0.98 * flat],
      [xLip - 0.03, y, z, r * 0.92, r * 0.92, r * 0.92 * flat],
    ];
  tube(b, rings, seg, false, false);
  if (!low) {
    // intake lip (bright metal) and duct
    b.set(COL.lip, PART.FIXED);
    tube(b, [[xLip - 0.03, y, z, r * 0.92, r * 0.92, r * 0.92 * flat], [xLip, y, z, r * 0.86, r * 0.86, r * 0.86 * flat], [xLip - 0.12, y, z, r * 0.8, r * 0.8, r * 0.8 * flat]], seg);
    b.set(COL.fan, PART.FIXED);
    tube(b, [[xLip - 0.12, y, z, r * 0.8, r * 0.8, r * 0.8 * flat], [xLip - r * 0.45, y, z, r * 0.78, r * 0.78, r * 0.78 * flat]], seg);
    const fx = xLip - r * 0.45;
    b.poly(Array.from({ length: seg }, (_, j) => { const a = (j / seg) * Math.PI * 2; return V(fx, y + Math.cos(a) * r * 0.78 * (Math.cos(a) < 0 ? flat : 1), z + Math.sin(a) * r * 0.78); }), V(1, 0, 0));
    // spinner
    b.set(COL.dark, PART.FIXED);
    tube(b, [[fx, y, z, r * 0.22, r * 0.22], [fx + r * 0.3, y, z, 0.02, 0.02]], 8);
    // fan exhaust (inside of the nozzle) + core cowl + plug
    b.set(COL.exhaust, PART.FIXED);
    const xn = xLip - fanLen;
    const chev = e.chevron ? 1 : 0;
    const ringN: V3[] = [], ringI: V3[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const zig = chev ? (j % 2 ? -0.12 : 0.05) : 0;
      ringN.push(V(xn + zig, y + Math.cos(a) * r * 0.8, z + Math.sin(a) * r * 0.8));
      ringI.push(V(xn + 0.5, y + Math.cos(a) * r * 0.74, z + Math.sin(a) * r * 0.74));
    }
    b.grid([ringN, ringI], true, undefined);
    b.set(COL.metal, PART.FIXED);
    tube(b, [[xn + 0.4, y, z, r * core * 1.05, r * core * 1.05], [xLip - len, y, z, r * core * 0.72, r * core * 0.72]], 12);
    b.set(COL.exhaust, PART.FIXED);
    tube(b, [[xLip - len + 0.02, y, z, r * core * 0.72, r * core * 0.72], [xLip - len - r * 0.7, y, z, 0.04, 0.04]], 10);
  } else {
    b.set(COL.fan, PART.FIXED);
    b.poly(Array.from({ length: seg }, (_, j) => { const a = (j / seg) * Math.PI * 2; return V(xLip - 0.02, y + Math.cos(a) * r * 0.86, z + Math.sin(a) * r * 0.86); }), V(1, 0, 0));
    b.set(COL.exhaust, PART.FIXED);
    tube(b, [[xLip - fanLen, y, z, r * 0.8, r * 0.8], [xLip - len - r * 0.4, y, z, 0.05, 0.05]], 5);
  }
}

function propNacelle(b: MB, xLip: number, y: number, z: number, e: AircraftSpec['eng'], yWing: number, xTE: number, low: boolean) {
  const r = e.d / 2, len = e.len;
  const seg = low ? 8 : 14;
  b.set(COL.white, PART.ENGINE);
  // spinner at xLip; nacelle rises to meet the wing and runs aft past the trailing edge
  const tail = Math.min(xLip - len, xTE - 1.5);
  // deep nacelle (≈ 1.2 W × 1.6 H): top blends into the wing, belly holds the aft-folding main gear
  const rings: [number, number, number, number, number, number?][] = low
    ? [[tail, y + r * 0.3, z, r * 0.4, r * 0.4, r * 0.3], [xLip - len * 0.4, y, z, r * 1.15, r, r * 1.45], [xLip - 0.3, y, z, r * 0.62, r * 0.62]]
    : [
      [tail, yWing - r * 0.15, z, r * 0.25, r * 0.28, r * 0.2],
      [tail + len * 0.18, y + r * 0.05, z, r * 0.95, r * 0.8, r * 0.95],
      [xLip - len * 0.62, y, z, r * 1.15, r * 0.98, r * 1.42],
      [xLip - len * 0.36, y, z, r * 1.2, r * 1.0, r * 1.45],
      [xLip - len * 0.15, y, z, r * 1.05, r * 0.92, r * 1.2],
      [xLip - 0.35, y, z, r * 0.68, r * 0.66, r * 0.7],
    ];
  tube(b, rings, seg, true, true);
  if (low) return;
  // intake scoop under the spinner
  b.set(COL.dark, PART.FIXED);
  b.poly([V(xLip - 0.36, y - r * 0.55, z - r * 0.3), V(xLip - 0.36, y - r * 0.55, z + r * 0.3), V(xLip - 0.36, y - r * 0.85, z + r * 0.28), V(xLip - 0.36, y - r * 0.85, z - r * 0.28)], V(1, 0, 0));
  // exhaust stubs on the outboard side
  // propeller (spins about x through the spinner axis)
  const piv = V(xLip, y, z);
  b.set(COL.spinner, PART.ENGINE, ANIM.PROP, piv);
  tube(b, [[xLip - 0.36, y, z, r * 0.62, r * 0.62], [xLip - 0.05, y, z, r * 0.5, r * 0.5], [xLip + 0.45, y, z, r * 0.25, r * 0.25], [xLip + 0.75, y, z, 0.03, 0.03]], 10);
  b.set(COL.prop, PART.FIXED, ANIM.PROP, piv);
  const pr = e.prop!.d / 2;
  const nb = e.prop!.blades;
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + 0.25;
    const ca = Math.cos(a), sa = Math.sin(a);
    const radial = V(0, ca, sa), tang = V(0, -sa, ca);
    const at = (rr: number, wv: number, tw: number) => piv.clone().add(V(-0.1 - tw, 0, 0)).addScaledVector(radial, rr).addScaledVector(tang, wv);
    // wide paddle blade with pitch (reads from the side) and a swept tip
    const pts = [at(0.4, -0.13, 0.13), at(pr * 0.6, -0.2, 0.1), at(pr * 0.97, -0.08, 0.03), at(pr, 0.04, -0.01), at(pr * 0.62, 0.17, -0.09), at(0.4, 0.12, -0.11)];
    b.poly2(pts, V(1, 0, 0));
  }
}

// ------------------------------------------------------------------ cockpit window layouts
// right-side panes (mirrored), corners [ds, dy, crown?] in metres (× spec.ck scale) from the
// windshield's lower front point: front-bottom, rear-bottom, rear-top, front-top
export type Cockpit = 'airbus' | 'a220' | 'a350' | 'boeing' | 'b757' | 'b787' | 'ejet' | 'crj' | 'q400';
type Pane = [number, number, number][];
const WS = (rear: number, top: number, back: number): Pane => [[0, 0, 1], [rear, 0, 0], [rear + back, top, 0], [rear - 0.08, top, 1]];
const COCKPIT: Record<Cockpit, Pane[]> = {
  // A320 / A330: flat windshields, sliding DV window, small rear pane with a slanted aft edge
  airbus: [WS(0.55, 0.56, 0.2), [[0.64, 0, 0], [1.2, 0, 0], [1.2, 0.5, 0], [0.82, 0.55, 0]], [[1.28, 0, 0], [1.72, 0, 0], [1.52, 0.44, 0], [1.28, 0.49, 0]]],
  a220: [WS(0.6, 0.58, 0.2), [[0.7, 0, 0], [1.5, 0, 0], [1.34, 0.52, 0], [0.88, 0.57, 0]]],
  a350: [WS(0.6, 0.6, 0.2), [[0.7, 0, 0], [1.32, 0, 0], [1.32, 0.54, 0], [0.9, 0.59, 0]], [[1.4, 0, 0], [1.9, 0, 0], [1.66, 0.46, 0], [1.4, 0.52, 0]]],
  boeing: [WS(0.6, 0.52, 0.2), [[0.68, 0, 0], [1.25, 0, 0], [1.3, 0.47, 0], [0.86, 0.5, 0]], [[1.33, 0, 0], [1.86, 0, 0], [1.62, 0.4, 0], [1.37, 0.45, 0]]],
  b757: [WS(0.62, 0.54, 0.2), [[0.7, 0, 0], [1.28, 0, 0], [1.32, 0.48, 0], [0.9, 0.52, 0]], [[1.36, 0, 0], [1.9, 0, 0], [1.66, 0.42, 0], [1.4, 0.47, 0]]],
  b787: [WS(0.78, 0.62, 0.2), [[0.86, 0, 0], [1.78, 0, 0], [1.56, 0.5, 0], [1.05, 0.6, 0]]],
  ejet: [WS(0.6, 0.55, 0.2), [[0.68, 0, 0], [1.4, 0, 0], [1.26, 0.48, 0], [0.86, 0.53, 0]]],
  crj: [WS(0.55, 0.46, 0.15), [[0.62, 0, 0], [1.1, 0, 0], [1.1, 0.4, 0], [0.76, 0.44, 0]], [[1.16, 0, 0], [1.5, 0, 0], [1.34, 0.34, 0], [1.16, 0.38, 0]]],
  q400: [WS(0.58, 0.5, 0.15), [[0.66, 0, 0], [1.18, 0, 0], [1.18, 0.44, 0], [0.8, 0.48, 0]], [[1.24, 0, 0], [1.6, 0, 0], [1.44, 0.38, 0], [1.24, 0.42, 0]]],
};
