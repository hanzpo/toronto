// Low-poly models for the urban layer (metres; origin on the ground / roof
// deck; +x = the item's facing). Vertex colour alpha tags (UrbanLayer
// materials): 0 plain · 0.3 tinted by the instance variant (per-pool palette)
// · 0.6 backlit panel · 0.7 garage door (sectional panels + graffiti) · 0.75
// board fence · 0.8 hoarding face (per-site scheme) · 0.9 red aviation light
// (blinks at night) · 1 warm lamp.
import type * as THREE from 'three/webgpu';
import { Geo } from '../street/geometry';

type V3 = [number, number, number];
type C = number[];
const lin = (hex: number, a = 0): C => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map((v) => Math.pow(v, 2.2)).concat(a);

const TINT = [1, 1, 1, 0.3];
const GALV = lin(0xa7aaa8), DARK = lin(0x2a2c2e), BLACK = lin(0x151617), CONC = lin(0xa8a49b);
const RED_LIGHT = [0.6, 0.02, 0.02, 0.9], LAMP = [1, 0.92, 0.75, 1];

/** square beam between two points (4 sides, no caps) */
function beam(g: Geo, a: V3, b: V3, w: number, c: C) {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  if (l < 1e-4) return;
  const t: V3 = [d[0] / l, d[1] / l, d[2] / l];
  // any perpendicular
  const up: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let p: V3 = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]];
  const pl = Math.hypot(...p); p = [p[0] / pl * w / 2, p[1] / pl * w / 2, p[2] / pl * w / 2];
  const q: V3 = [(t[1] * p[2] - t[2] * p[1]), (t[2] * p[0] - t[0] * p[2]), (t[0] * p[1] - t[1] * p[0])];
  const off = (o: V3, s1: number, s2: number): V3 => [o[0] + p[0] * s1 + q[0] * s2, o[1] + p[1] * s1 + q[1] * s2, o[2] + p[2] * s1 + q[2] * s2];
  const corners: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let k = 0; k < 4; k++) {
    const [s1, s2] = corners[k], [t1, t2] = corners[(k + 1) % 4];
    g.quad(off(a, s1, s2), off(b, s1, s2), off(b, t1, t2), off(a, t1, t2), c);
  }
}

/** flat strip (double-sided material) between two points, width w, lying in the plane containing `nrm` as its normal */
function strip(g: Geo, a: V3, b: V3, w: number, nrm: V3, c: C) {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  let s: V3 = [d[1] * nrm[2] - d[2] * nrm[1], d[2] * nrm[0] - d[0] * nrm[2], d[0] * nrm[1] - d[1] * nrm[0]];
  const sl = Math.hypot(...s) || 1; s = [s[0] / sl * w / 2, s[1] / sl * w / 2, s[2] / sl * w / 2];
  g.quad([a[0] - s[0], a[1] - s[1], a[2] - s[2]], [b[0] - s[0], b[1] - s[1], b[2] - s[2]], [b[0] + s[0], b[1] + s[1], b[2] + s[2]], [a[0] + s[0], a[1] + s[1], a[2] + s[2]], c);
}

function light(g: Geo, x: number, y: number, z: number, r = 0.25, c: C = RED_LIGHT) { g.box(x - r, y - r, z - r, x + r, y + r, z + r, c, true); }

// ---------------------------------------------------------------------------- rooftops

/** packaged rooftop unit (2.4 × 1.25 × 1.6 m): curb, casing, louvres, two condenser fans on top */
export function rtu(): THREE.BufferGeometry {
  const g = new Geo();
  const body = lin(0xbdbcb4), louv = lin(0x7c7d7a);
  g.box(-1.2, 0, -0.8, 1.2, 1.25, 0.8, body);
  g.box(-1.21, 0.4, -0.81, 0.2, 1.0, 0.81, louv);
  for (const x of [-0.6, 0.55]) g.quad([x - 0.4, 1.26, 0.4], [x + 0.4, 1.26, 0.4], [x + 0.4, 1.26, -0.4], [x - 0.4, 1.26, -0.4], DARK);
  g.box(0.9, 1.25, -0.3, 1.1, 1.45, 0.3, body);
  return g.build();
}

/** mushroom exhaust fan on a curb */
export function exhaustFan(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.45, 0, -0.45, 0.45, 0.35, 0.45, GALV);
  g.prism(0, 0, 0.35, 0.62, 0.3, 0.3, 8, lin(0x8c8f8e));
  g.prism(0, 0, 0.62, 0.8, 0.5, 0.18, 8, GALV);
  return g.build();
}

/** roof hatch: curb + lid */
export function hatch(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.55, 0, -0.55, 0.55, 0.45, 0.55, lin(0x9ea19f));
  g.box(-0.6, 0.45, -0.6, 0.6, 0.52, 0.6, lin(0x7d807e));
  return g.build();
}

/** plumbing vent stacks + a gooseneck */
export function vents(): THREE.BufferGeometry {
  const g = new Geo();
  g.prism(0, 0, 0, 0.7, 0.07, 0.07, 5, DARK);
  g.prism(0.5, 0.3, 0, 0.45, 0.05, 0.05, 5, DARK);
  g.prism(-0.3, 0.2, 0, 0.9, 0.12, 0.12, 6, GALV);
  g.box(-0.42, 0.9, 0.08, -0.18, 1.0, 0.32, GALV);
  return g.build();
}

/** cooling tower / chiller on an office roof (4.5 × 3.3 × 3.2 m) */
export function coolingTower(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-2.25, 0, -1.6, 2.25, 0.3, 1.6, DARK);
  g.box(-2.2, 0.3, -1.55, 2.2, 3.0, 1.55, lin(0x9aa3a2));
  g.box(-2.21, 0.5, -1.56, 2.21, 2.2, 1.56, lin(0x6f7775));
  for (const x of [-1.1, 1.1]) { g.prism(x, 0, 3.0, 3.6, 0.95, 0.95, 10, lin(0x5f6664)); g.prism(x, 0, 3.6, 3.62, 0.9, 0.9, 10, BLACK); }
  return g.build();
}

/** wooden water tank on a steel stand (the few that survive on old lofts) */
export function waterTank(): THREE.BufferGeometry {
  const g = new Geo();
  const wood = lin(0x6f5a44), steel = lin(0x3c3a36);
  for (const [x, z] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) g.box(x - 0.1, 0, z - 0.1, x + 0.1, 3.4, z + 0.1, steel);
  g.box(-1.9, 3.3, -1.9, 1.9, 3.5, 1.9, steel);
  g.prism(0, 0, 3.5, 8.0, 2.2, 2.2, 12, wood, lin(0x7d6750));
  for (const y of [4.3, 5.4, 6.5, 7.5]) g.prism(0, 0, y, y + 0.08, 2.23, 2.23, 12, steel);
  g.prism(0, 0, 8.0, 9.6, 2.35, 0.12, 12, lin(0x3b3b3a));
  return g.build();
}

/** patio umbrella (tinted canopy) over a small table */
export function umbrella(): THREE.BufferGeometry {
  const g = new Geo();
  g.prism(0, 0, 0, 2.3, 0.03, 0.03, 5, lin(0xd8d6d0));
  g.prism(0, 0, 1.95, 2.45, 1.4, 0.05, 8, TINT);
  g.prism(0, 0, 1.94, 1.95, 1.4, 1.4, 8, TINT);
  g.prism(0, 0, 0, 0.72, 0.05, 0.05, 5, DARK);
  g.prism(0, 0, 0.72, 0.76, 0.45, 0.45, 8, lin(0xe6e4de));
  for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) g.box(Math.cos(a) * 0.8 - 0.2, 0, Math.sin(a) * 0.8 - 0.2, Math.cos(a) * 0.8 + 0.2, 0.45, Math.sin(a) * 0.8 + 0.2, lin(0x2d2f31));
  return g.build();
}

/** brick chimney with a cap (base below the roof surface) */
export function chimney(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.4, 0, -0.5, 0.4, 2.3, 0.5, lin(0x8a4a3a));
  g.box(-0.46, 2.3, -0.56, 0.46, 2.42, 0.56, lin(0x8e8a82));
  g.prism(0.12, 0, 2.42, 2.7, 0.1, 0.1, 5, DARK);
  return g.build();
}

/** gabled dormer facing +x; the back runs 2.6 m into the roof. y scaled by roof pitch */
export function dormer(): THREE.BufferGeometry {
  const g = new Geo();
  const wall = lin(0xe8e4da), roof = lin(0x55504b), win = lin(0x1c2227);
  const w = 1.05, h = 1.7, r = 2.4;
  g.box(-2.6, 0, -w, 0, h, w, wall);
  g.quad([0.01, 0.45, -0.55], [0.01, 0.45, 0.55], [0.01, 1.45, 0.55], [0.01, 1.45, -0.55], win);
  g.tri([0, h, -w], [0, h, w], [0, r, 0], wall);
  g.quad([0.15, h - 0.05, w + 0.12], [-2.6, h - 0.05, w + 0.12], [-2.6, r + 0.05, 0], [0.15, r + 0.05, 0], roof);
  g.quad([0.15, r + 0.05, 0], [-2.6, r + 0.05, 0], [-2.6, h - 0.05, -w - 0.12], [0.15, h - 0.05, -w - 0.12], roof);
  return g.build();
}

// ---------------------------------------------------------------------------- tower cranes

/** hammerhead / luffer mast: 2 m lattice, 60 m tall (instances scale y), concrete footing */
export function craneMast(): THREE.BufferGeometry {
  const g = new Geo();
  const H = 60, s = 1.0, sec = 3;
  g.box(-2.5, -0.5, -2.5, 2.5, 1.0, 2.5, CONC);
  const cs: [number, number][] = [[-s, -s], [s, -s], [s, s], [-s, s]];
  for (const [x, z] of cs) beam(g, [x, 0.9, z], [x, H, z], 0.18, TINT);
  for (let y = 0.9, i = 0; y < H - 0.1; y += sec, i++) {
    const y1 = Math.min(H, y + sec);
    for (let k = 0; k < 4; k++) {
      const [x0, z0] = cs[k], [x1, z1] = cs[(k + 1) % 4];
      const nrm: V3 = [(x0 + x1) / 2, 0, (z0 + z1) / 2];
      if (i % 2) strip(g, [x0, y, z0], [x1, y1, z1], 0.1, nrm, TINT);
      else strip(g, [x1, y, z1], [x0, y1, z0], 0.1, nrm, TINT);
      strip(g, [x0, y, z0], [x1, y, z1], 0.08, nrm, TINT);
    }
  }
  // climbing ladder cage hint + mid-mast light
  light(g, s + 0.2, H * 0.5, 0, 0.18);
  return g.build();
}

/** triangular lattice jib along +x from x0 to x1 (bottom chords at y0, z ±hw; top chord at y0 + ht) */
function latticeJib(g: Geo, x0: number, x1: number, y0: number, hw: number, ht: number, taper: number, sec: number) {
  const n = Math.max(1, Math.round((x1 - x0) / sec));
  const P = (i: number) => {
    const x = x0 + ((x1 - x0) * i) / n;
    const f = 1 - taper * (i / n);
    return { x, bz: hw * f, ty: y0 + ht * f };
  };
  const a = P(0), b = P(n);
  beam(g, [a.x, y0, -a.bz], [b.x, y0, -b.bz], 0.14, TINT);
  beam(g, [a.x, y0, a.bz], [b.x, y0, b.bz], 0.14, TINT);
  beam(g, [a.x, a.ty, 0], [b.x, b.ty, 0], 0.14, TINT);
  for (let i = 0; i < n; i++) {
    const p = P(i), q = P(i + 1);
    const z = i % 2 ? 1 : -1;
    strip(g, [p.x, y0, -p.bz * z], [q.x, q.ty, 0], 0.08, [0, 1, -z * 0.6], TINT);
    strip(g, [p.x, y0, p.bz * z], [q.x, q.ty, 0], 0.08, [0, 1, z * 0.6], TINT);
    strip(g, [p.x, y0, -p.bz], [q.x, y0, q.bz * (i % 2 ? -1 : 1)], 0.08, [0, 1, 0], TINT);
  }
}

/** hammerhead slewing part: turntable, cab, tower head with pendants, 60 m jib (x-scaled), counter-jib with ballast, trolley + hook */
export function craneTopHammer(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-1.3, 0, -1.3, 1.3, 1.6, 1.3, TINT);
  // cab
  g.box(0.2, 0.2, 1.3, 2.4, 2.6, 3.1, lin(0xe9e9e4));
  g.box(2.41, 1.1, 1.4, 2.45, 2.4, 3.0, lin(0x1d2a33));
  // tower head (A-frame) to the apex
  const apex: V3 = [0, 11, 0];
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) beam(g, [x, 1.6, z], apex, 0.16, TINT);
  // jib + counter-jib
  latticeJib(g, 1.3, 60, 1.6, 0.9, 1.9, 0.55, 3);
  beam(g, [-1.3, 1.6, -0.9], [-17, 1.6, -0.9], 0.2, TINT);
  beam(g, [-1.3, 1.6, 0.9], [-17, 1.6, 0.9], 0.2, TINT);
  g.box(-17, 1.4, -1.0, -1.3, 1.6, 1.0, lin(0x6c6e70));
  g.box(-17.2, 1.6, -1.4, -13.2, 4.8, 1.4, CONC); // ballast blocks
  g.box(-12.5, 1.6, -0.8, -9.5, 3.0, 0.8, lin(0x4a4d50)); // hoist winch
  // pendants: apex → jib and counter-jib
  strip(g, apex, [34, 3.1, 0], 0.07, [0, 0, 1], DARK);
  strip(g, apex, [-16, 1.7, 0], 0.07, [0, 0, 1], DARK);
  // trolley, hoist line and hook block
  g.box(24, 1.0, -0.8, 26, 1.6, 0.8, DARK);
  strip(g, [25, 1.0, 0], [25, -22, 0], 0.05, [0, 0, 1], BLACK);
  g.box(24.5, -23.2, -0.35, 25.5, -22, 0.35, lin(0xf2c200));
  // aviation lights
  light(g, apex[0], apex[1] + 0.3, 0, 0.3);
  light(g, 60, 1.8, 0, 0.3);
  light(g, -17.2, 5.0, 0, 0.25);
  return g.build();
}

/** luffer slewing part: machinery house with ballast, A-frame, jib raised ~62° (uniformly scaled) */
export function craneTopLuffer(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-1.4, 0, -1.4, 1.4, 1.2, 1.4, TINT);
  g.box(-9, 1.2, -1.8, 2.2, 4.4, 1.8, TINT); // machinery house
  g.box(-9.4, 1.2, -1.9, -7.2, 5.4, 1.9, CONC); // ballast
  g.box(1.2, 1.5, 1.8, 3.2, 4.1, 3.4, lin(0xe9e9e4)); // cab
  g.box(3.21, 2.4, 1.9, 3.25, 3.9, 3.3, lin(0x1d2a33));
  const apex: V3 = [-2.2, 14, 0];
  for (const [x, z] of [[-4.5, -1.6], [-4.5, 1.6], [0.2, -1.6], [0.2, 1.6]]) beam(g, [x, 4.4, z], apex, 0.16, TINT);
  // jib: square lattice, 55 m at 62°
  const L = 55, th = (62 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const base: V3 = [1.6, 3.0, 0];
  const at = (t: number, dy: number, dz: number): V3 => [base[0] + c * t - s * dy, base[1] + s * t + c * dy, dz];
  const hw = 0.8;
  for (const [dy, dz] of [[-hw, -hw], [-hw, hw], [hw, hw], [hw, -hw]]) beam(g, at(0, dy, dz), at(L, dy * 0.5, dz * 0.5), 0.14, TINT);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const t0 = (L * i) / n, t1 = (L * (i + 1)) / n, f0 = 1 - 0.5 * (i / n), f1 = 1 - 0.5 * ((i + 1) / n);
    const z = i % 2 ? 1 : -1;
    strip(g, at(t0, -hw * f0, -hw * f0 * z), at(t1, -hw * f1, hw * f1 * z), 0.08, [s, -c, 0], TINT);
    strip(g, at(t0, hw * f0, -hw * f0 * z), at(t1, hw * f1, hw * f1 * z), 0.08, [s, -c, 0], TINT);
    strip(g, at(t0, -hw * f0, hw * f0 * z), at(t1, hw * f1, hw * f1 * z), 0.08, [0, 0, 1], TINT);
    strip(g, at(t0, -hw * f0, -hw * f0 * z), at(t1, hw * f1, -hw * f1 * z), 0.08, [0, 0, 1], TINT);
  }
  // luffing ropes from the A-frame to the jib, hoist line + hook at the tip
  strip(g, apex, at(L * 0.62, hw, 0), 0.07, [0, 0, 1], DARK);
  const tip = at(L, 0, 0);
  strip(g, tip, [tip[0], tip[1] - 38, 0], 0.05, [0, 0, 1], BLACK);
  g.box(tip[0] - 0.5, tip[1] - 39.2, -0.35, tip[0] + 0.5, tip[1] - 38, 0.35, lin(0xf2c200));
  light(g, apex[0], apex[1] + 0.3, 0, 0.3);
  light(g, tip[0], tip[1] + 0.4, 0, 0.3);
  return g.build();
}

// ---------------------------------------------------------------------------- tower cranes, far LOD
// Beyond ~450 m the lattice members are sub-pixel: solid silhouettes (the jib
// reads as a line, as real ones do against the sky) with bigger aviation lights.

const BIG_RED = 0.9;

export function craneMastFar(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-1.0, 0, -1.0, 1.0, 60, 1.0, TINT);
  return g.build();
}

export function craneTopHammerFar(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-1.3, 0, -1.3, 1.3, 1.6, 1.3, TINT);
  g.box(0.2, 0.2, 1.3, 2.4, 2.6, 3.1, lin(0xe9e9e4));
  // jib: tapered triangular prism
  const x0 = 1.3, x1 = 60;
  const A: V3 = [x0, 1.6, -0.9], B: V3 = [x0, 1.6, 0.9], C: V3 = [x0, 3.5, 0];
  const A2: V3 = [x1, 1.6, -0.4], B2: V3 = [x1, 1.6, 0.4], C2: V3 = [x1, 2.45, 0];
  g.quad(A, A2, C2, C, TINT); g.quad(C, C2, B2, B, TINT); g.quad(B, B2, A2, A, TINT);
  g.box(-17, 1.4, -1.0, -1.3, 2.2, 1.0, TINT);
  g.box(-17.2, 1.6, -1.4, -13.2, 4.8, 1.4, CONC);
  // tower head pyramid
  g.tri([-1, 1.6, -1], [1, 1.6, -1], [0, 11, 0], TINT); g.tri([1, 1.6, -1], [1, 1.6, 1], [0, 11, 0], TINT);
  g.tri([1, 1.6, 1], [-1, 1.6, 1], [0, 11, 0], TINT); g.tri([-1, 1.6, 1], [-1, 1.6, -1], [0, 11, 0], TINT);
  const R = [0.6, 0.02, 0.02, BIG_RED];
  light(g, 0, 11.6, 0, 0.9, R); light(g, 60, 3.0, 0, 0.9, R); light(g, -17.2, 5.6, 0, 0.7, R);
  return g.build();
}

export function craneTopLufferFar(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-1.4, 0, -1.4, 1.4, 1.2, 1.4, TINT);
  g.box(-9, 1.2, -1.8, 2.2, 4.4, 1.8, TINT);
  g.box(-9.4, 1.2, -1.9, -7.2, 5.4, 1.9, CONC);
  const apex: V3 = [-2.2, 14, 0];
  g.tri([-4.5, 4.4, -1.6], [0.2, 4.4, -1.6], apex, TINT); g.tri([0.2, 4.4, 1.6], [-4.5, 4.4, 1.6], apex, TINT);
  const L = 55, th = (62 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const base: V3 = [1.6, 3.0, 0];
  const tip: V3 = [base[0] + c * L, base[1] + s * L, 0];
  beam(g, base, tip, 1.3, TINT);
  const R = [0.6, 0.02, 0.02, BIG_RED];
  light(g, apex[0], apex[1] + 0.6, 0, 0.9, R); light(g, tip[0], tip[1] + 0.8, 0, 0.9, R);
  return g.build();
}

// ---------------------------------------------------------------------------- construction site

/** concrete core walls (unit box: x, z ∈ ±½, y ∈ [0, 1]) */
export function core(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.5, 0, -0.5, 0.5, 1, 0.5, lin(0xa3a098));
  g.box(-0.502, 0.985, -0.502, 0.502, 1.0, 0.502, lin(0x77746e));
  return g.build();
}

/** one floor: slab on a grid of columns (unit: x, z ∈ ±½; y ∈ [0, 1] = one storey) */
export function slab(): THREE.BufferGeometry {
  const g = new Geo();
  const conc = lin(0xb3afa6), col = lin(0x9d9a92);
  g.box(-0.5, 0.9, -0.5, 0.5, 1.0, 0.5, conc, true);
  for (const x of [-0.46, -0.15, 0.15, 0.46]) for (const z of [-0.44, 0, 0.44]) g.box(x - 0.012, 0, z - 0.016, x + 0.012, 0.9, z + 0.016, col);
  // perimeter safety rail (dark) on the slab edge
  for (const z of [-0.5, 0.5]) g.box(-0.5, 1.0, z - 0.002, 0.5, 1.33, z + 0.002, lin(0x3a3c3e));
  return g.build();
}

/** far LOD of a floor: the slab only */
export function slabFar(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.5, 0.9, -0.5, 0.5, 1.0, 0.5, lin(0xb3afa6), true);
  g.box(-0.46, 0, -0.44, 0.46, 0.9, 0.44, lin(0x55534f)); // dark interior read between the slabs
  return g.build();
}

/** self-climbing formwork / safety screen wrapping the top floors (unit box, sides only, tinted) */
export function formwork(): THREE.BufferGeometry {
  const g = new Geo();
  const P: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  for (let k = 0; k < 4; k++) {
    const [x0, z0] = P[k], [x1, z1] = P[(k + 1) % 4];
    g.quad([x0, 0, z0], [x1, 0, z1], [x1, 1, z1], [x0, 1, z0], TINT);
    // dark working-platform bands
    for (const y of [0.33, 0.66]) g.quad([x0, y, z0], [x1, y, z1], [x1, y + 0.04, z1], [x0, y + 0.04, z0], DARK);
  }
  return g.build();
}

/** plywood / branded hoarding: 7.32 m (3 sheets) × 2.44 m, +z = street face; studs behind */
export function hoarding(): THREE.BufferGeometry {
  const g = new Geo();
  const ply = lin(0xb89c72);
  const L = 3.66, H = 2.44;
  g.quad([-L, 0, 0.05], [L, 0, 0.05], [L, H, 0.05], [-L, H, 0.05], [1, 1, 1, 0.8]);
  g.quad([L, 0, -0.05], [-L, 0, -0.05], [-L, H, -0.05], [L, H, -0.05], ply);
  g.box(-L, H, -0.07, L, H + 0.06, 0.07, lin(0x5b5b58));
  for (let x = -L; x <= L + 0.01; x += 2.44) g.box(x - 0.045, 0, -0.35, x + 0.045, H, -0.05, lin(0x9a825e));
  return g.build();
}

/** stacked-able site office trailer (12.2 × 2.75 × 3.05 m), windows, door + steps */
export function trailer(): THREE.BufferGeometry {
  const g = new Geo();
  const win = lin(0x27323a);
  g.box(-6.1, 0.15, -1.52, 6.1, 2.75, 1.52, TINT);
  g.box(-6.1, 0, -1.4, 6.1, 0.15, 1.4, DARK);
  for (const x of [-4.2, -1.2, 2.6, 4.8]) {
    g.quad([x - 0.6, 1.2, 1.53], [x + 0.6, 1.2, 1.53], [x + 0.6, 2.1, 1.53], [x - 0.6, 2.1, 1.53], win);
    g.quad([x + 0.6, 1.2, -1.53], [x - 0.6, 1.2, -1.53], [x - 0.6, 2.1, -1.53], [x + 0.6, 2.1, -1.53], win);
  }
  g.quad([0.3, 0.2, 1.53], [1.2, 0.2, 1.53], [1.2, 2.2, 1.53], [0.3, 2.2, 1.53], lin(0x8a8f93));
  g.box(0.1, 0, 1.53, 1.4, 0.2, 2.4, lin(0x6d6f70));
  g.box(0.55, 2.3, 1.53, 0.95, 2.4, 1.6, LAMP);
  return g.build();
}

/** portable toilet (tinted shell, white roof) */
export function toilet(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.55, 0, -0.55, 0.55, 2.2, 0.55, TINT);
  g.box(-0.6, 2.2, -0.6, 0.6, 2.35, 0.6, lin(0xe8e8e2));
  return g.build();
}

/** roll-off bin (6.4 × 1.8 × 2.4 m, sloped front) */
export function dumpster(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-2.9, 0.15, -1.2, 3.2, 1.8, 1.2, TINT);
  g.quad([-3.2, 0.15, 1.2], [-2.9, 0.15, 1.2], [-2.9, 1.8, 1.2], [-3.2, 1.8, 1.2], TINT);
  g.box(-3.2, 0, -1.0, 3.2, 0.15, 1.0, DARK);
  g.box(-2.8, 1.3, -1.21, 3.1, 1.8, 1.21, lin(0x5a4a38)); // debris heap
  return g.build();
}

/** tracked excavator (CAT-yellow), boom raised, bucket down */
export function excavator(): THREE.BufferGeometry {
  const g = new Geo();
  for (const z of [-1.3, 1.3]) g.box(-2.3, 0, z - 0.35, 2.3, 0.85, z + 0.35, BLACK);
  g.box(-1.2, 0.85, -0.9, 1.2, 1.1, 0.9, DARK);
  g.box(-2.2, 1.1, -1.35, 1.0, 2.2, 1.35, TINT); // house
  g.box(-2.4, 1.1, -1.3, -1.9, 2.1, 1.3, lin(0x3a3b3c)); // counterweight
  g.box(0.1, 2.2, 0.15, 1.3, 3.3, 1.3, TINT); // cab
  g.quad([1.31, 2.35, 0.25], [1.31, 2.35, 1.2], [1.31, 3.2, 1.2], [1.31, 3.2, 0.25], lin(0x1d2a33));
  const b0: V3 = [1.0, 2.0, -0.35], b1: V3 = [4.2, 4.4, -0.35], a1: V3 = [5.6, 1.0, -0.35];
  beam(g, b0, b1, 0.55, TINT);
  beam(g, b1, a1, 0.4, TINT);
  g.box(5.1, 0.2, -0.95, 6.1, 1.1, 0.25, DARK); // bucket
  return g.build();
}

// ---------------------------------------------------------------------------- laneways

/** Toronto laneway garage: 6.1 m deep (x), 3.3 m wide (z, instances scale for doubles), door on +x, lamp over the door */
export function garage(): THREE.BufferGeometry {
  const g = new Geo();
  const D = 3.05, W = 1.65;
  g.box(-D, 0, -W, D, 2.55, W, TINT);
  g.box(-D - 0.08, 2.55, -W - 0.08, D + 0.1, 2.72, W + 0.08, lin(0x5a5854)); // flat roof + flashing
  g.quad([D + 0.01, 0.0, W - 0.25], [D + 0.01, 0.0, -W + 0.25], [D + 0.01, 2.15, -W + 0.25], [D + 0.01, 2.15, W - 0.25], [1, 1, 1, 0.7]);
  g.box(D, 2.25, -0.1, D + 0.12, 2.36, 0.1, [1, 0.92, 0.75, 0.97]);
  return g.build();
}

/** 2.4 m board fence panel (1.8 m) with posts; x-scaled per instance */
export function fence(): THREE.BufferGeometry {
  const g = new Geo();
  const board = [1, 1, 1, 0.75];
  g.box(-1.2, 0, -0.025, 1.2, 1.8, 0.025, board);
  g.box(-1.2, 1.75, -0.06, 1.2, 1.82, 0.06, TINT);
  for (const x of [-1.2, 1.2]) g.box(x - 0.045, 0, -0.07, x + 0.045, 1.9, 0.07, TINT);
  return g.build();
}
