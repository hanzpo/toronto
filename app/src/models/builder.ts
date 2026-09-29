// Tiny low-poly mesh builder for vehicle / station geometry.
// Flat-shaded faces with per-vertex colour and a per-vertex `livery` weight
// (0 = baked colour, 1 = multiplied by a per-instance tint).
//
// Coordinates while building are metres: x = along the vehicle (+x = front),
// y = up, z = across (models are left/right symmetric).
import * as THREE from 'three/webgpu';

export type RGB = [number, number, number];
export type V2 = [number, number];

export function rgb(hex: number): RGB {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  // store linear so MeshStandardMaterial / node colour matches the sRGB hex
  return [c.r, c.g, c.b];
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  liv: number[] = [];
  idx: number[] = [];

  get vertexCount() { return this.pos.length / 3; }
  get triCount() { return this.idx.length / 3; }

  /** Flat polygon (convex, or `tris` given). `hint` = rough outward direction, fixes winding. */
  poly(pts: THREE.Vector3[], color: RGB, liv = 0, hint?: THREE.Vector3, tris?: number[]) {
    if (pts.length < 3) return;
    _a.subVectors(pts[1], pts[0]);
    _b.subVectors(pts[2], pts[0]);
    _n.crossVectors(_a, _b);
    // robust normal (Newell) for polygons whose first 3 points are collinear
    if (_n.lengthSq() < 1e-12 || pts.length > 3) {
      _n.set(0, 0, 0);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        _n.x += (p.y - q.y) * (p.z + q.z);
        _n.y += (p.z - q.z) * (p.x + q.x);
        _n.z += (p.x - q.x) * (p.y + q.y);
      }
    }
    if (_n.lengthSq() < 1e-12) return;
    _n.normalize();
    let flip = false;
    if (hint && _n.dot(hint) < 0) { flip = true; _n.negate(); }
    const base = this.vertexCount;
    for (const p of pts) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.col.push(color[0], color[1], color[2]);
      this.liv.push(liv);
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
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    if (!skip.includes('top')) this.quad(V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1), color, liv, UP);
    if (!skip.includes('bottom')) this.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), color, liv, DOWN);
    if (!skip.includes('front')) this.quad(V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1), V(x1, y0, z1), color, liv, PX);
    if (!skip.includes('back')) this.quad(V(x0, y0, z0), V(x0, y1, z0), V(x0, y1, z1), V(x0, y0, z1), color, liv, NX);
    if (!skip.includes('right')) this.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), color, liv, PZ);
    if (!skip.includes('left')) this.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0), color, liv, NZ);
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
      this.quad(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y0, z0), new THREE.Vector3(x1, y1, z1), new THREE.Vector3(x0, y1, z1),
        c, liv, new THREE.Vector3(0, my, mz));
    }
    const capC = typeof color === 'function' ? color(-1) : color;
    if (caps === 'both' || caps === 'front') this.poly(sec.map(([z, y]) => new THREE.Vector3(x1, y, z)), capC, liv, PX);
    if (caps === 'both' || caps === 'back') this.poly(sec.map(([z, y]) => new THREE.Vector3(x0, y, z)), capC, liv, NX);
  }

  /**
   * Side profile (x, y) polygon extruded across z ∈ [-hw, hw]. Each profile
   * edge i is coloured `edgeColor(i)`, the two flat sides `sideColor`.
   */
  extrudeZ(profile: V2[], hw: number, edgeColor: (i: number) => RGB, sideColor: RGB, liv = 0, edgeLiv?: (i: number) => number) {
    const n = profile.length;
    const area = signedArea(profile);
    for (let i = 0; i < n; i++) {
      const [x0, y0] = profile[i], [x1, y1] = profile[(i + 1) % n];
      if (Math.hypot(x1 - x0, y1 - y0) < 1e-4) continue;
      // outward 2D normal for a CCW polygon is (dy, -dx)
      const s = area > 0 ? 1 : -1;
      const hint = new THREE.Vector3((y1 - y0) * s, -(x1 - x0) * s, 0);
      this.quad(new THREE.Vector3(x0, y0, -hw), new THREE.Vector3(x1, y1, -hw), new THREE.Vector3(x1, y1, hw), new THREE.Vector3(x0, y0, hw),
        edgeColor(i), edgeLiv ? edgeLiv(i) : liv, hint);
    }
    const tris = THREE.ShapeUtils.triangulateShape(profile.map(([x, y]) => new THREE.Vector2(x, y)), []).flat();
    this.poly(profile.map(([x, y]) => new THREE.Vector3(x, y, hw)), sideColor, liv, PZ, tris);
    this.poly(profile.map(([x, y]) => new THREE.Vector3(x, y, -hw)), sideColor, liv, NZ, tris);
  }

  /**
   * Decal band on both sides of a car body with half-section `half` (right
   * side, bottom→top): the part of the surface with y ∈ [y0, y1], x ∈ [x0, x1],
   * lifted `eps` off the surface.
   */
  band(half: V2[], x0: number, x1: number, y0: number, y1: number, color: RGB, liv = 0, eps = 0.03) {
    for (let i = 0; i < half.length - 1; i++) {
      const [za, ya] = half[i], [zb, yb] = half[i + 1];
      if (yb - ya < 1e-4) continue;
      const lo = Math.max(y0, ya), hi = Math.min(y1, yb);
      if (hi - lo < 1e-4) continue;
      const zl = za + ((lo - ya) / (yb - ya)) * (zb - za);
      const zh = za + ((hi - ya) / (yb - ya)) * (zb - za);
      // outward normal of the edge (right side): (dz, dy) rotated -> (dy, -dz) in (z, y)
      const ez = zb - za, ey = yb - ya, L = Math.hypot(ez, ey);
      const nz = ey / L, ny = -ez / L;
      for (const s of [1, -1]) {
        const off = (z: number) => s * (z + nz * eps);
        const hint = new THREE.Vector3(0, ny, s * nz);
        this.quad(new THREE.Vector3(x0, lo + ny * eps, off(zl)), new THREE.Vector3(x1, lo + ny * eps, off(zl)),
          new THREE.Vector3(x1, hi + ny * eps, off(zh)), new THREE.Vector3(x0, hi + ny * eps, off(zh)), color, liv, hint);
      }
    }
  }

  /** Flat strip on the roof (y = top + eps), z ∈ [-hz, hz]. */
  roof(x0: number, x1: number, y: number, hz: number, color: RGB, liv = 0) {
    this.quad(new THREE.Vector3(x0, y, -hz), new THREE.Vector3(x1, y, -hz), new THREE.Vector3(x1, y, hz), new THREE.Vector3(x0, y, hz), color, liv, UP);
  }

  /** Quad on the vertical plane x = const (front / back decal), facing `dir` (+1 / -1). */
  endDecal(x: number, dir: 1 | -1, y0: number, y1: number, hz: number, color: RGB, liv = 0) {
    this.quad(new THREE.Vector3(x, y0, -hz), new THREE.Vector3(x, y1, -hz), new THREE.Vector3(x, y1, hz), new THREE.Vector3(x, y0, hz), color, liv,
      new THREE.Vector3(dir, 0, 0));
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
  const right = half;
  const out: V2[] = [];
  // bottom edge runs left→right; go CCW when viewed from +x: right side up, left side down
  for (const p of right) out.push(p);
  for (let i = right.length - 1; i >= 0; i--) {
    const [z, y] = right[i];
    if (Math.abs(z) < 1e-6) continue; // centre point shared
    out.push([-z, y]);
  }
  return out;
}
