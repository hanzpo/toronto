// Tiny low-poly mesh builder for vehicle / station geometry.
// Flat-shaded faces with per-vertex colour and per-vertex material tags:
//   livery 0|1  multiplied by a per-instance tint (route / agency / body colour)
//   lamp   0 none, 1 headlight, 2 tail/brake, 3 indicator-left, 4 indicator-right
//   sign   0|1  destination / route sign (glows)
//   glass  0|1  glazing (low roughness, fresnel sky reflection)
// Tags ride on the colour: `paint(hex, { glass: 1 })` returns an RGB tuple
// carrying them, so every drawing call accepts a Paint wherever it takes RGB.
//
// Coordinates while building are metres: x = along the vehicle (+x = front),
// y = up, z = across (+z = right-hand side when facing +x).
import * as THREE from 'three/webgpu';

export type RGB = [number, number, number];
export type V2 = [number, number];
export interface PaintTags { liv?: number; lamp?: number; sign?: number; glass?: number }
export type Paint = RGB & PaintTags;

export function rgb(hex: number): RGB {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  // store linear so MeshStandardMaterial / node colour matches the sRGB hex
  return [c.r, c.g, c.b];
}

/** Colour + material tags (see file header). */
export function paint(hex: number, tags: PaintTags = {}): Paint {
  return Object.assign(rgb(hex), tags);
}

const _n = new THREE.Vector3();
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A loft station: half-section points [z, y] (z ≥ 0, bottom → top centre), optional per-point x override [z, y, x]. */
export interface Station { x: number; pts: ([number, number] | [number, number, number])[] }

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  liv: number[] = [];
  lamp: number[] = [];
  sign: number[] = [];
  glass: number[] = [];
  idx: number[] = [];
  /** extra per-vertex float attributes: current value (set before drawing) */
  extra: Record<string, number> = {};
  private extraData: Record<string, number[]> = {};

  get vertexCount() { return this.pos.length / 3; }
  get triCount() { return this.idx.length / 3; }

  /** Register / set an extra float attribute (e.g. pedestrian `limb`). */
  setExtra(name: string, value: number) {
    if (!this.extraData[name]) this.extraData[name] = new Array(this.vertexCount).fill(0);
    this.extra[name] = value;
  }

  /** Flat polygon (convex, or `tris` given). `hint` = rough outward direction, fixes winding. */
  poly(pts: THREE.Vector3[], color: RGB, liv = 0, hint?: THREE.Vector3, tris?: number[]) {
    // drop consecutive duplicates (collapsed loft vertices)
    if (!tris) {
      const u: THREE.Vector3[] = [];
      for (const p of pts) if (!u.length || u[u.length - 1].distanceToSquared(p) > 1e-10) u.push(p);
      while (u.length > 1 && u[0].distanceToSquared(u[u.length - 1]) < 1e-10) u.pop();
      pts = u;
    }
    if (pts.length < 3) return;
    _n.set(0, 0, 0);
    // Newell normal (robust for collinear leading points / near-planar quads)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      _n.x += (p.y - q.y) * (p.z + q.z);
      _n.y += (p.z - q.z) * (p.x + q.x);
      _n.z += (p.x - q.x) * (p.y + q.y);
    }
    if (_n.lengthSq() < 1e-14) return;
    _n.normalize();
    let flip = false;
    if (hint && _n.dot(hint) < 0) { flip = true; _n.negate(); }
    const base = this.vertexCount;
    const p = color as Paint;
    const lv = Math.max(liv, p.liv ?? 0), lm = p.lamp ?? 0, sg = p.sign ?? 0, gl = p.glass ?? 0;
    for (const q of pts) {
      this.pos.push(q.x, q.y, q.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.col.push(color[0], color[1], color[2]);
      this.liv.push(lv);
      this.lamp.push(lm);
      this.sign.push(sg);
      this.glass.push(gl);
      for (const k in this.extraData) this.extraData[k].push(this.extra[k] ?? 0);
    }
    const t = tris ?? fan(pts.length);
    for (let i = 0; i < t.length; i += 3) {
      if (flip) this.idx.push(base + t[i], base + t[i + 2], base + t[i + 1]);
      else this.idx.push(base + t[i], base + t[i + 1], base + t[i + 2]);
    }
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: RGB, liv = 0, hint?: THREE.Vector3) {
    this.poly([a, b, c, d], color, liv, hint);
  }

  /** Axis-aligned box. `skip` omits faces by name ('bottom' is usually invisible). */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: RGB, liv = 0, skip = 'bottom') {
    if (!skip.includes('top')) this.quad(V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1), color, liv, UP);
    if (!skip.includes('bottom')) this.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), color, liv, DOWN);
    if (!skip.includes('front')) this.quad(V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1), V(x1, y0, z1), color, liv, PX);
    if (!skip.includes('back')) this.quad(V(x0, y0, z0), V(x0, y1, z0), V(x0, y1, z1), V(x0, y0, z1), color, liv, NX);
    if (!skip.includes('right')) this.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), color, liv, PZ);
    if (!skip.includes('left')) this.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0), color, liv, NZ);
  }

  /** Box with a tapered top (top rectangle inset by `ix` along x and `iz` across). */
  taperBox(x0: number, x1: number, y0: number, y1: number, hz: number, ix: number, iz: number, color: RGB, zc = 0, skip = 'bottom') {
    const b = [V(x0, y0, zc - hz), V(x1, y0, zc - hz), V(x1, y0, zc + hz), V(x0, y0, zc + hz)];
    const t = [V(x0 + ix, y1, zc - hz + iz), V(x1 - ix, y1, zc - hz + iz), V(x1 - ix, y1, zc + hz - iz), V(x0 + ix, y1, zc + hz - iz)];
    if (!skip.includes('top')) this.quad(t[0], t[1], t[2], t[3], color, 0, UP);
    if (!skip.includes('bottom')) this.quad(b[0], b[1], b[2], b[3], color, 0, DOWN);
    this.quad(b[0], b[1], t[1], t[0], color, 0, NZ);
    this.quad(b[2], b[3], t[3], t[2], color, 0, PZ);
    if (!skip.includes('front')) this.quad(b[1], b[2], t[2], t[1], color, 0, PX);
    if (!skip.includes('back')) this.quad(b[3], b[0], t[0], t[3], color, 0, NX);
  }

  /** Convex cross-section (z, y), full polygon, extruded along x from x0 to x1. */
  extrudeX(sec: V2[], x0: number, x1: number, color: RGB | ((edge: number) => RGB), liv = 0, caps: 'both' | 'none' | 'front' | 'back' = 'both') {
    const [cz, cy] = centre(sec);
    const n = sec.length;
    for (let i = 0; i < n; i++) {
      const [z0, y0] = sec[i], [z1, y1] = sec[(i + 1) % n];
      if (Math.hypot(z1 - z0, y1 - y0) < 1e-4) continue;
      const mz = (z0 + z1) / 2 - cz, my = (y0 + y1) / 2 - cy;
      const c = typeof color === 'function' ? color(i) : color;
      this.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z1), V(x0, y1, z1), c, liv, V(0, my, mz));
    }
    const capC = typeof color === 'function' ? color(-1) : color;
    if (caps === 'both' || caps === 'front') this.poly(sec.map(([z, y]) => V(x1, y, z)), capC, liv, PX);
    if (caps === 'both' || caps === 'back') this.poly(sec.map(([z, y]) => V(x0, y, z)), capC, liv, NX);
  }

  /** Convex (x, y) side profile extruded across z ∈ [z0, z1]; `edge(i)` colours profile edge i, `side` the two flat faces. */
  extrudeZ(profile: V2[], hw: number, edgeColor: (i: number) => RGB, sideColor: RGB, liv = 0, edgeLiv?: (i: number) => number, zc = 0) {
    const n = profile.length;
    const area = signedArea(profile);
    for (let i = 0; i < n; i++) {
      const [x0, y0] = profile[i], [x1, y1] = profile[(i + 1) % n];
      if (Math.hypot(x1 - x0, y1 - y0) < 1e-4) continue;
      const s = area > 0 ? 1 : -1;
      const hint = V((y1 - y0) * s, -(x1 - x0) * s, 0);
      this.quad(V(x0, y0, zc - hw), V(x1, y1, zc - hw), V(x1, y1, zc + hw), V(x0, y0, zc + hw),
        edgeColor(i), edgeLiv ? edgeLiv(i) : liv, hint);
    }
    const tris = THREE.ShapeUtils.triangulateShape(profile.map(([x, y]) => new THREE.Vector2(x, y)), []).flat();
    this.poly(profile.map(([x, y]) => V(x, y, zc + hw)), sideColor, liv, PZ, tris);
    this.poly(profile.map(([x, y]) => V(x, y, zc - hw)), sideColor, liv, NZ, tris);
  }

  /**
   * Loft through stations (increasing x). Each station is a right half-section
   * listed bottom → top centre with the same point count; the left side is
   * mirrored. `paint(seg, edge)` colours the quad between stations seg/seg+1 on
   * section edge `edge` (null = skip). Caps: `front(edge)` / `back(edge)` colour
   * horizontal strips across the first / last station (null = skip).
   */
  loft(st: Station[], paint: (seg: number, edge: number, side: 1 | -1) => RGB | null,
    caps: { front?: (edge: number) => RGB | null; back?: (edge: number) => RGB | null; bottom?: RGB } = {}) {
    const P = (s: Station, j: number, side: number) => {
      const p = s.pts[j];
      return V(p[2] ?? s.x, p[1], p[0] * side);
    };
    const m = st[0].pts.length;
    for (let i = 0; i < st.length - 1; i++) {
      for (let j = 0; j < m - 1; j++) {
        for (const side of [1, -1] as const) {
          const c = paint(i, j, side);
          if (!c) continue;
          const A = P(st[i], j, side), B = P(st[i], j + 1, side), C = P(st[i + 1], j + 1, side), D = P(st[i + 1], j, side);
          // right side: A→D along +x, A→B up the section ⇒ normal +z (outward)
          if (side > 0) this.poly([A, D, C, B], c);
          else this.poly([A, B, C, D], c);
        }
      }
    }
    if (caps.bottom) {
      for (let i = 0; i < st.length - 1; i++) {
        const A = P(st[i], 0, 1), B = P(st[i + 1], 0, 1), C = P(st[i + 1], 0, -1), D = P(st[i], 0, -1);
        this.poly([A, D, C, B], caps.bottom, 0, DOWN);
      }
    }
    const cap = (s: Station, f: (edge: number) => RGB | null, dir: 1 | -1) => {
      for (let j = 0; j < m - 1; j++) {
        const c = f(j);
        if (!c) continue;
        const R0 = P(s, j, 1), R1 = P(s, j + 1, 1), L1 = P(s, j + 1, -1), L0 = P(s, j, -1);
        // R0→R1 up, R1→L1 towards -z: normal = y × -z = -x ⇒ reverse for the front
        if (dir > 0) this.poly([L0, L1, R1, R0], c);
        else this.poly([R0, R1, L1, L0], c);
      }
    };
    if (caps.front) cap(st[st.length - 1], caps.front, 1);
    if (caps.back) cap(st[0], caps.back, -1);
  }

  /**
   * Decal band on both sides of a car body with half-section `half` (right
   * side, bottom→top): the part of the surface with y ∈ [y0, y1], x ∈ [x0, x1],
   * lifted `eps` off the surface. `side`: 1 right only, -1 left only, 0 both.
   */
  band(half: V2[], x0: number, x1: number, y0: number, y1: number, color: RGB, liv = 0, eps = 0.03, side: 0 | 1 | -1 = 0) {
    for (let i = 0; i < half.length - 1; i++) {
      const [za, ya] = half[i], [zb, yb] = half[i + 1];
      if (yb - ya < 1e-4) continue;
      const lo = Math.max(y0, ya), hi = Math.min(y1, yb);
      if (hi - lo < 1e-4) continue;
      const zl = za + ((lo - ya) / (yb - ya)) * (zb - za);
      const zh = za + ((hi - ya) / (yb - ya)) * (zb - za);
      const ez = zb - za, ey = yb - ya, L = Math.hypot(ez, ey);
      const nz = ey / L, ny = -ez / L;
      for (const s of [1, -1]) {
        if (side && s !== side) continue;
        const off = (z: number) => s * (z + nz * eps);
        const hint = V(0, ny, s * nz);
        this.quad(V(x0, lo + ny * eps, off(zl)), V(x1, lo + ny * eps, off(zl)),
          V(x1, hi + ny * eps, off(zh)), V(x0, hi + ny * eps, off(zh)), color, liv, hint);
      }
    }
  }

  /** Flat polygon (x, y) on the side plane z = ±z (outward). side: 1 right, -1 left, 0 both. */
  sidePoly(pts: V2[], z: number, color: RGB, side: 0 | 1 | -1 = 0) {
    for (const s of [1, -1]) {
      if (side && s !== side) continue;
      this.poly(pts.map(([x, y]) => V(x, y, s * z)), color, 0, V(0, 0, s));
    }
  }

  /** Rectangle with chamfered corners on the side plane. */
  sideWindow(x0: number, x1: number, y0: number, y1: number, z: number, color: RGB, r = 0.12, side: 0 | 1 | -1 = 0) {
    r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
    if (r <= 0.001) { this.sidePoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z, color, side); return; }
    this.sidePoly([[x0 + r, y0], [x1 - r, y0], [x1, y0 + r], [x1, y1 - r], [x1 - r, y1], [x0 + r, y1], [x0, y1 - r], [x0, y0 + r]], z, color, side);
  }

  /** Flat polygon (z, y) on the plane x = const facing dir. */
  endPoly(pts: V2[], x: number, dir: 1 | -1, color: RGB) {
    this.poly(pts.map(([z, y]) => V(x, y, z)), color, 0, V(dir, 0, 0));
  }

  /** Flat strip on the roof (y = top + eps), z ∈ [-hz, hz]. */
  roof(x0: number, x1: number, y: number, hz: number, color: RGB, liv = 0) {
    this.quad(V(x0, y, -hz), V(x1, y, -hz), V(x1, y, hz), V(x0, y, hz), color, liv, UP);
  }

  /** Quad on the vertical plane x = const (front / back decal), facing `dir` (+1 / -1). */
  endDecal(x: number, dir: 1 | -1, y0: number, y1: number, hz: number, color: RGB, liv = 0, zc = 0) {
    this.quad(V(x, y0, zc - hz), V(x, y1, zc - hz), V(x, y1, zc + hz), V(x, y0, zc + hz), color, liv, V(dir, 0, 0));
  }

  /** n-gon disc in the x-y plane at z, facing ±z (sign of `face`). */
  disc(xc: number, yc: number, r: number, z: number, face: 1 | -1, color: RGB, n = 10, rot = 0) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      pts.push(V(xc + Math.cos(a) * r, yc + Math.sin(a) * r, z));
    }
    this.poly(pts, color, 0, V(0, 0, face));
  }

  /**
   * Road wheel on both sides: tyre tread + sidewall + rim + hub. `zo` = outer face |z|.
   */
  wheelPair(xc: number, r: number, width: number, zo: number, tyre: RGB, rim: RGB, rimR = 0.62, n = 10, sides: 0 | 1 | -1 = 0) {
    for (const s of [1, -1] as const) {
      if (sides && s !== sides) continue;
      const zi = s * (zo - width), zO = s * zo;
      const ring = (z: number, rr: number) => Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + Math.PI / n;
        return V(xc + Math.cos(a) * rr, r + Math.sin(a) * rr, z);
      });
      const A = ring(zi, r), B = ring(zO, r);
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n;
        const mid = (i + 0.5) / n * Math.PI * 2 + Math.PI / n;
        this.quad(A[i], A[k], B[k], B[i], tyre, 0, V(Math.cos(mid), Math.sin(mid), 0));
      }
      this.poly(B, tyre, 0, V(0, 0, s));
      this.poly(ring(zO + s * 0.012, r * rimR), rim, 0, V(0, 0, s));
      this.poly(ring(zO + s * 0.02, r * rimR * 0.35).filter((_, i) => i % 2 === 0), tyre, 0, V(0, 0, s));
    }
  }

  /**
   * Final geometry. With `size`, positions are divided by it after recentring
   * so that x ∈ [-.5, .5], y ∈ [0, 1], z ∈ [-.5, .5] (unit vehicle). Normals
   * stay in metre space: MarkerOverlay scales back by the same size, so they
   * are correct after instancing.
   */
  build(size?: [number, number, number], xCentre = 0): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(this.pos);
    if (size) {
      for (let i = 0; i < p.length; i += 3) {
        p[i] = (p[i] - xCentre) / size[0];
        p[i + 1] = p[i + 1] / size[1];
        p[i + 2] = p[i + 2] / size[2];
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('livery', new THREE.BufferAttribute(new Float32Array(this.liv), 1));
    g.setAttribute('lamp', new THREE.BufferAttribute(new Float32Array(this.lamp), 1));
    g.setAttribute('sign', new THREE.BufferAttribute(new Float32Array(this.sign), 1));
    g.setAttribute('glass', new THREE.BufferAttribute(new Float32Array(this.glass), 1));
    for (const k in this.extraData) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(this.extraData[k]), 1));
    const nV = this.vertexCount;
    g.setIndex(nV > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    if (size) g.userData.size = [...size];
    return g;
  }
}

export const UP = new THREE.Vector3(0, 1, 0);
export const DOWN = new THREE.Vector3(0, -1, 0);
export const PX = new THREE.Vector3(1, 0, 0);
export const NX = new THREE.Vector3(-1, 0, 0);
export const PZ = new THREE.Vector3(0, 0, 1);
export const NZ = new THREE.Vector3(0, 0, -1);

function fan(n: number): number[] {
  const t: number[] = [];
  for (let i = 1; i < n - 1; i++) t.push(0, i, i + 1);
  return t;
}

function centre(pts: V2[]): V2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

function signedArea(pts: V2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Full convex section (z, y) from a right half-section listed bottom → top centre. */
export function mirrorSection(half: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of half) out.push(p);
  for (let i = half.length - 1; i >= 0; i--) {
    const [z, y] = half[i];
    if (Math.abs(z) < 1e-6) continue; // centre point shared
    out.push([-z, y]);
  }
  return out;
}

/** z of a half-section at height y (outermost). */
export function sectionZ(half: V2[], y: number): number {
  for (let i = 0; i < half.length - 1; i++) {
    const [za, ya] = half[i], [zb, yb] = half[i + 1];
    if ((y - ya) * (y - yb) <= 0 && yb !== ya) return za + ((y - ya) / (yb - ya)) * (zb - za);
  }
  return y < half[0][1] ? half[0][0] : 0;
}

export function triangleCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}
