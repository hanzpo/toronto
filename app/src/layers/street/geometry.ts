// Low-poly street furniture archetypes (unit-ish, metres). Vertex colour alpha
// marks emissive parts: 1 = lamp lens, 0.2/0.4/0.6 = signal lens red/yellow/green.
import * as THREE from 'three/webgpu';

type V3 = [number, number, number];

export class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  private push(p: V3, n: V3, c: number[]) { this.pos.push(...p); this.nrm.push(...n); this.col.push(c[0], c[1], c[2], c[3] ?? 0); }
  tri(a: V3, b: V3, c: V3, rgba: number[], n?: V3) {
    if (!n) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      n = [nx, ny, nz];
    }
    this.push(a, n, rgba); this.push(b, n, rgba); this.push(c, n, rgba);
  }
  quad(a: V3, b: V3, c: V3, d: V3, rgba: number[]) { this.tri(a, b, c, rgba); this.tri(a, c, d, rgba); }
  /** axis-aligned box [x0,x1]×[y0,y1]×[z0,z1] */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, rgba: number[], bottom = false) {
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], rgba); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], rgba); // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], rgba); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], rgba); // -x
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], rgba); // +y
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], rgba);
  }
  /** vertical prism (n sides) centred at (x, z) from y0 to y1, radii r0 (bottom) r1 (top), smooth normals */
  prism(x: number, z: number, y0: number, y1: number, r0: number, r1: number, n: number, c0: number[], c1 = c0) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const P = (a: number, r: number, y: number): V3 => [x + Math.cos(a) * r, y, z - Math.sin(a) * r];
      const N = (a: number): V3 => { const s = (r0 - r1) / (y1 - y0); const l = Math.hypot(1, s); return [Math.cos(a) / l, s / l, -Math.sin(a) / l]; };
      this.push(P(a0, r0, y0), N(a0), c0); this.push(P(a1, r0, y0), N(a1), c0); this.push(P(a1, r1, y1), N(a1), c1);
      this.push(P(a0, r0, y0), N(a0), c0); this.push(P(a1, r1, y1), N(a1), c1); this.push(P(a0, r1, y1), N(a0), c1);
    }
  }
  /** blobby crown: subdivided icosahedron scaled to an ellipsoid with per-vertex jitter and bottom shading */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, detail: number, top: number[], bot: number[], seed: number) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const p = g.getAttribute('position');
    const jit = (x: number, y: number, z: number) => 1 + 0.13 * Math.sin(x * 5.1 + seed) * Math.sin(y * 4.3 + seed * 1.7) * Math.sin(z * 4.7 + seed * 2.3);
    for (let i = 0; i < p.count; i += 3) {
      const v: V3[] = [];
      for (let k = 0; k < 3; k++) {
        const x = p.getX(i + k), y = p.getY(i + k), z = p.getZ(i + k);
        const j = jit(x, y, z);
        v.push([cx + x * rx * j, cy + y * ry * j, cz + z * rz * j]);
      }
      for (let k = 0; k < 3; k++) {
        const y = p.getY(i + k);
        const t = Math.max(0, Math.min(1, (y + 1) / 2));
        const c = [bot[0] + (top[0] - bot[0]) * t, bot[1] + (top[1] - bot[1]) * t, bot[2] + (top[2] - bot[2]) * t, top[3]];
        // smooth-ish normal from the sphere direction (soft foliage shading)
        const x = p.getX(i + k), z = p.getZ(i + k);
        const l = Math.hypot(x / rx, y / ry, z / rz) || 1;
        this.push(v[k], [x / rx / l, y / ry / l, z / rz / l], c);
      }
    }
    g.dispose();
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    g.computeBoundingSphere();
    return g;
  }
}

// colours in linear-ish 0..1 (the material converts nothing: these are linear)
const BARK = [0.13, 0.1, 0.08, 0];
const BARK_HI = [0.17, 0.13, 0.1, 0];
// alpha 0.05 tags foliage (tinted per instance in the shader)
const LEAF_TOP = [0.13, 0.21, 0.08, 0.05];
const LEAF_BOT = [0.045, 0.08, 0.035, 0.05];
const NEEDLE_TOP = [0.09, 0.17, 0.09, 0.08];
const NEEDLE_BOT = [0.035, 0.07, 0.04, 0.08];
const POLE = [0.33, 0.34, 0.35, 0];
const DARK = [0.035, 0.037, 0.04, 0];

/** broadleaf street tree, ~9 m tall at scale 1. `lod` 0 near, 1 far */
export function broadleaf(lod: number): THREE.BufferGeometry {
  const g = new Geo();
  if (lod === 0) {
    g.prism(0, 0, -0.3, 3.2, 0.2, 0.14, 6, BARK, BARK_HI);
    g.prism(0.2, 0.1, 2.6, 4.4, 0.09, 0.05, 4, BARK_HI); // limb
    g.blob(0, 5.6, 0, 3.1, 2.6, 3.1, 1, LEAF_TOP, LEAF_BOT, 1.3);
    g.blob(0.9, 6.8, -0.6, 2.1, 1.9, 2.1, 1, LEAF_TOP, LEAF_BOT, 4.1);
    g.blob(-1.1, 6.2, 0.8, 1.9, 1.6, 1.9, 0, LEAF_TOP, LEAF_BOT, 2.2);
  } else {
    g.prism(0, 0, -0.3, 3.0, 0.22, 0.16, 3, BARK);
    g.blob(0, 5.9, 0, 3.3, 2.9, 3.3, 0, LEAF_TOP, LEAF_BOT, 1.3);
  }
  return g.build();
}

export function conifer(lod: number): THREE.BufferGeometry {
  const g = new Geo();
  const n = lod === 0 ? 7 : 4;
  g.prism(0, 0, -0.3, 1.6, 0.18, 0.12, lod === 0 ? 5 : 3, BARK);
  g.prism(0, 0, 1.2, 5.5, 2.4, 0.9, n, NEEDLE_BOT, NEEDLE_TOP);
  g.prism(0, 0, 4.2, 9.5, 1.7, 0.0, n, NEEDLE_BOT, NEEDLE_TOP);
  return g.build();
}

/** cobra-head street light: pole along +y, arm toward local +x (the road). Height 1 = 8.5 m (scaled in y). */
export function streetLight(): THREE.BufferGeometry {
  const g = new Geo();
  g.prism(0, 0, -0.3, 8.5, 0.13, 0.08, 6, POLE);
  g.box(-0.04, 8.25, -0.04, 2.1, 8.37, 0.04, POLE);
  g.box(1.75, 8.12, -0.17, 2.45, 8.36, 0.17, [0.42, 0.43, 0.44, 0], true);
  // lens (emissive)
  g.quad([1.8, 8.11, 0.14], [1.8, 8.11, -0.14], [2.4, 8.11, -0.14], [2.4, 8.11, 0.14], [0.9, 0.88, 0.8, 1]);
  return g.build();
}

/** signal pole with a pole-mounted head facing local +x, and the mast arm root toward local +z */
export function signalPole(): THREE.BufferGeometry {
  const g = new Geo();
  g.prism(0, 0, -0.3, 6.3, 0.14, 0.11, 8, POLE);
  signalHead(g, 0.2, 2.6, 0);
  // push-button box
  g.box(-0.12, 1.0, 0.1, 0.05, 1.25, 0.2, [0.3, 0.26, 0.05, 0]);
  return g.build();
}

/** mast arm: unit length along local +z at 6 m height (scaled in z per instance) */
export function mastArm(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.07, 5.95, 0, 0.07, 6.1, 1, POLE);
  return g.build();
}

/** head hanging from the end of a mast arm, facing local +x */
export function mastHead(): THREE.BufferGeometry {
  const g = new Geo();
  g.box(-0.02, 5.7, -0.02, 0.02, 6.0, 0.02, DARK);
  signalHead(g, 0.0, 4.55, 0);
  return g.build();
}

function signalHead(g: Geo, x: number, y: number, z: number) {
  // housing 0.36 wide, 1.05 tall, backplate
  g.box(x - 0.14, y, z - 0.18, x + 0.14, y + 1.05, z + 0.18, DARK, true);
  g.box(x - 0.17, y - 0.08, z - 0.3, x - 0.13, y + 1.13, z + 0.3, [0.05, 0.05, 0.05, 0]);
  const lens = [[0.2, y + 0.87], [0.4, y + 0.52], [0.6, y + 0.18]] as const;
  for (const [tag, cy] of lens) {
    const r = 0.11, n = 8, fx = x + 0.145;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      g.tri([fx, cy, z], [fx, cy + Math.sin(a0) * r, z - Math.cos(a0) * r], [fx, cy + Math.sin(a1) * r, z - Math.cos(a1) * r], [0.05, 0.05, 0.05, tag], [1, 0, 0]);
    }
    // visor
    g.box(x + 0.14, cy + 0.1, z - 0.13, x + 0.3, cy + 0.13, z + 0.13, DARK);
  }
}
