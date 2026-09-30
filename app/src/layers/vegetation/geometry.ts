// Vegetation template geometry. Templates are species-neutral: the vertex
// shader (material.ts) places every vertex from per-vertex template data and
// per-instance species parameters, so one draw covers every species of a
// family at one LOD.
//
// attributes
//   position  lobed foliage: unit offset inside its lobe · trunk / limb: (cos θ, t, sin θ)
//             tiered foliage: (cos θ, 0, sin θ)
//   normal    template normal (shading is recomputed in the shader)
//   va        lobed foliage: lobe centre (crown unit space), lobe radius · limb: target lobe centre, 0
//             tiered: (height fraction of the vertex, ring height fraction of its whorl, ring factor, whorl index / n)
//   vb        (kind: 0 trunk · 1 limb · 2 foliage, ambient occlusion, lobe hash, 0)
import * as THREE from 'three/webgpu';

class T {
  pos: number[] = []; nrm: number[] = []; va: number[] = []; vb: number[] = [];
  v(p: number[], n: number[], a: number[], b: number[]) { this.pos.push(...p); this.nrm.push(...n); this.va.push(...a); this.vb.push(...b); }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('va', new THREE.Float32BufferAttribute(this.va, 4));
    g.setAttribute('vb', new THREE.Float32BufferAttribute(this.vb, 4));
    return g;
  }
  get tris() { return this.pos.length / 9; }
}

/** unit icosahedron (detail 0 or 1) triangles, outward winding */
function ico(detail: number): number[][] {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  const out: number[][] = [];
  for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
  g.dispose();
  return out;
}

/** trunk: n-sided open cylinder, t ∈ [0, 1] along the axis (shader scales / tapers) */
function trunk(t: T, n: number) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = -Math.sin(a0), c1 = Math.cos(a1), s1 = -Math.sin(a1);
    const q = (c: number, s: number, y: number) => t.v([c, y, s], [c, 0, s], [0, 0, 0, 0], [0, 0.7 + 0.3 * y, 0, 0]);
    q(c0, s0, 0); q(c1, s1, 0); q(c1, s1, 1);
    q(c0, s0, 0); q(c1, s1, 1); q(c0, s0, 1);
  }
}

/** limb from the crown base toward lobe centre `lc` (3-sided) */
function limb(t: T, lc: number[]) {
  const n = 3;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = -Math.sin(a0), c1 = Math.cos(a1), s1 = -Math.sin(a1);
    const q = (c: number, s: number, y: number) => t.v([c, y, s], [c, 0, s], [lc[0], lc[1], lc[2], 0], [1, 0.75, 0, 0]);
    q(c0, s0, 0); q(c1, s1, 0); q(c1, s1, 1);
    q(c0, s0, 0); q(c1, s1, 1); q(c0, s0, 1);
  }
}

/** foliage lobe at crown-unit centre `lc`, radius r */
function lobe(t: T, lc: number[], r: number, tris: number[][], hash: number) {
  const L = Math.hypot(lc[0], lc[1], lc[2]);
  const out = L > 1e-3 ? [lc[0] / L, lc[1] / L, lc[2] / L] : [0, 1, 0];
  for (let i = 0; i < tris.length; i++) {
    const d = tris[i];
    // AO: faces toward the crown centre and the underside are darker
    const outward = L > 1e-3 ? d[0] * out[0] + d[1] * out[1] + d[2] * out[2] : d[1] * 0.5;
    const hy = Math.max(0, Math.min(1, (lc[1] + d[1] * r + 1) / 2));
    const ao = (0.5 + 0.5 * Math.max(0, Math.min(1, 0.5 + 0.5 * outward))) * (0.62 + 0.38 * hy);
    t.v(d, d, [lc[0], lc[1], lc[2], r], [2, ao, hash, 0]);
  }
}

/** lobe centres: a Fibonacci shell plus a core, crown-unit space (the union reaches ≈ 1) */
function lobeCentres(n: number, shell: number): number[][] {
  const out: number[][] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 0.92 - (i / (n - 1)) * 1.6; // bias upward: crowns are fuller on top
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * ga;
    out.push([Math.cos(a) * r * shell, y * shell, Math.sin(a) * r * shell]);
  }
  return out;
}

/** the crown's lobes (crown-unit centre, radius): shared by both lobed LODs so they match */
function crownLobes(): [number[], number][] {
  const cs = lobeCentres(12, 0.56);
  cs.push([0, 0.3, 0], [0.05, -0.15, -0.05]);
  return cs.map((c, i) => [c, i >= 12 ? 0.52 : c[1] < -0.2 ? 0.44 : 0.5]);
}

/** unit octahedron triangles, rotated (lobes of the mid LOD: no aligned diamonds), scaled to an icosahedron's volume */
function octa(rot: number): number[][] {
  const g = new THREE.OctahedronGeometry(1.2, 0);
  g.rotateX(rot * 2.1).rotateY(rot * 3.7).rotateZ(rot * 1.3);
  const p = g.getAttribute('position');
  const out: number[][] = [];
  for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
  g.dispose();
  return out;
}

/** LOBED family, high detail: 14 lobes (detail-0 icosahedra) + 6-sided trunk + 4 limbs ≈ 336 tris */
export function lobedHigh(): THREE.BufferGeometry {
  const t = new T();
  trunk(t, 6);
  const ic = ico(0);
  const lobes = crownLobes();
  lobes.forEach(([c, r], i) => lobe(t, c, r, ic, (i * 0.618) % 1));
  for (const k of [1, 4, 7, 10]) limb(t, lobes[k][0]);
  const g = t.build();
  g.userData.tris = t.tris;
  return g;
}

/**
 * LOBED family, mid detail: the high LOD decimated — the same 14 lobes (same
 * centres, radii, per-lobe hashes, so the same jitter, colour and shading) as
 * octahedra, 3-sided trunk, no limbs ≈ 118 tris
 */
export function lobedMid(): THREE.BufferGeometry {
  const t = new T();
  trunk(t, 3);
  crownLobes().forEach(([c, r], i) => lobe(t, c, r, octa(i * 0.618 + 0.3), (i * 0.618) % 1));
  const g = t.build();
  g.userData.tris = t.tris;
  return g;
}

/**
 * TIERED family (spruce, cedar, hemlock): whorls of branches as star-edged
 * cones stacked up the stem, with a skirt underneath.
 */
function tiered(tiers: number, pts: number, trunkSides: number): THREE.BufferGeometry {
  const t = new T();
  trunk(t, trunkSides);
  const n = pts * 2; // star: alternating tip / notch
  for (let k = 0; k < tiers; k++) {
    // whorl ring height fraction (bottom ring at 0) and apex above it
    const y0 = (k / tiers) * 0.94;
    const y1 = Math.min(1, y0 + (1.9 / tiers));
    const yu = Math.max(0, y0 - 0.25 / tiers); // underside centre (a little lower: branches droop)
    const f = k / Math.max(1, tiers - 1);
    for (let i = 0; i < n; i++) {
      const a0 = ((i + (k % 2) * 0.5) / n) * Math.PI * 2, a1 = ((i + 1 + (k % 2) * 0.5) / n) * Math.PI * 2;
      const r0 = i % 2 === 0 ? 1 : 0.84, r1 = (i + 1) % 2 === 0 ? 1 : 0.84;
      const d0 = [Math.cos(a0), 0, -Math.sin(a0)], d1 = [Math.cos(a1), 0, -Math.sin(a1)];
      const aoTop = 0.72 + 0.28 * f, aoRing = 0.6 + 0.25 * f, aoIn = 0.38 + 0.2 * f;
      // upper cone: ring → apex
      const nr = (d: number[]) => { const l = Math.hypot(d[0], 0.9, d[2]); return [d[0] / l, 0.9 / l, d[2] / l]; };
      t.v(d0, nr(d0), [y0, y0, r0, k / tiers], [2, aoRing, k * 0.37 % 1, 0]);
      t.v(d1, nr(d1), [y0, y0, r1, k / tiers], [2, aoRing, k * 0.37 % 1, 0]);
      t.v([0, 0, 0], [0, 1, 0], [y1, y0, 0, k / tiers], [2, aoTop, k * 0.37 % 1, 0]);
      // underside: ring → stem (dark)
      const nd = (d: number[]) => { const l = Math.hypot(d[0], 0.6, d[2]); return [d[0] / l, -0.6 / l, d[2] / l]; };
      t.v(d1, nd(d1), [y0, y0, r1, k / tiers], [2, aoRing * 0.8, k * 0.37 % 1, 0]);
      t.v(d0, nd(d0), [y0, y0, r0, k / tiers], [2, aoRing * 0.8, k * 0.37 % 1, 0]);
      t.v([0, 0, 0], [0, -1, 0], [yu + 0.3 / tiers, y0, 0, k / tiers], [2, aoIn, k * 0.37 % 1, 0]);
    }
  }
  const g = t.build();
  g.userData.tris = t.tris;
  return g;
}

/** ≈ 12 + 7 whorls × 2 × 14 ≈ 208 tris */
export const tieredHigh = () => tiered(7, 7, 6);
/** the high LOD decimated: the same 7 whorls with 4-point stars ≈ 6 + 7 × 2 × 8 = 118 tris */
export const tieredMid = () => tiered(7, 4, 3);

/** camera-facing impostor quad: position.xy = (u ∈ [−1, 1], v ∈ [0, 1]) */
export function impostorQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.userData.tris = 2;
  return g;
}
