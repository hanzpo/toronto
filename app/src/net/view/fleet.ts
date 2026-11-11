import * as THREE from 'three/webgpu';
import { attribute, cos, float, mix, positionGeometry, positionLocal, sin, vec3, abs as tslAbs } from 'three/tsl';
import { packedVehicleMaterial } from '../../models/material';

export class Pool {
  mesh: THREE.InstancedMesh;
  /** rgb tint + flags (WebGPU allows only 8 vertex buffers: attributes are packed) */
  col: THREE.InstancedBufferAttribute;
  extra: THREE.InstancedBufferAttribute | null;
  count = 0;
  constructor(geom: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, name: string, extra = 0) {
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    geom.setAttribute('iColF', this.col);
    this.extra = null;
    if (extra) {
      this.extra = new THREE.InstancedBufferAttribute(new Float32Array(cap * extra), extra);
      geom.setAttribute('iAnim', this.extra);
    }
    this.mesh = new THREE.InstancedMesh(geom, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = name;
    parent.add(this.mesh);
  }
  commit() {
    this.mesh.count = this.count;
    if (!this.count) return;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, this.count * 16); im.needsUpdate = true;
    this.col.clearUpdateRanges(); this.col.addUpdateRange(0, this.count * 4); this.col.needsUpdate = true;
    if (this.extra) { this.extra.clearUpdateRanges(); this.extra.addUpdateRange(0, this.count * this.extra.itemSize); this.extra.needsUpdate = true; }
  }
}

/** Copy of a model geometry with the per-vertex tags packed into one vec4 (livery, lamp, sign, glass). */
export function packCar(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  const n = g.attributes.position.count;
  c.setAttribute('position', g.attributes.position);
  c.setAttribute('normal', g.attributes.normal);
  c.setAttribute('color', g.attributes.color);
  const tags = new Float32Array(n * 4);
  (['livery', 'lamp', 'sign', 'glass'] as const).forEach((k, j) => {
    const a = (g.attributes[k] ?? (k === 'livery' ? g.attributes.tint : undefined)) as THREE.BufferAttribute | undefined;
    if (a) for (let i = 0; i < n; i++) tags[i * 4 + j] = a.getX(i);
  });
  c.setAttribute('tags', new THREE.BufferAttribute(tags, 4));
  if (g.index) c.setIndex(g.index);
  c.computeBoundingSphere();
  return c;
}

/** Pedestrian geometry with (tint, limb, pivot) packed into one vec3. */
export function packPed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  const n = g.attributes.position.count;
  c.setAttribute('position', g.attributes.position);
  c.setAttribute('normal', g.attributes.normal);
  c.setAttribute('color', g.attributes.color);
  const t = new Float32Array(n * 3);
  (['tint', 'limb', 'pivot'] as const).forEach((k, j) => {
    const a = (g.attributes[k] ?? (k === 'tint' ? g.attributes.livery : undefined)) as THREE.BufferAttribute | undefined;
    if (a) for (let i = 0; i < n; i++) t[i * 3 + j] = a.getX(i);
  });
  c.setAttribute('tlp', new THREE.BufferAttribute(t, 3));
  if (g.index) c.setIndex(g.index);
  c.computeBoundingSphere();
  return c;
}

/**
 * Vehicle shading of models/material.ts (vehicleMaterial) reading the packed
 * `tags` / `iColF` attributes. Instance flags: 1 brake, 4 / 8 indicators, 16 headlights.
 */
export function carMaterial(): THREE.MeshStandardNodeMaterial {
  return packedVehicleMaterial('traffic-cars');
}

/** Pedestrians: clothing tint + limb walk cycle (models/traffic pedestrianWalkNode, packed attributes). */
export function pedMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  m.name = 'traffic-peds';
  const vc = attribute('color', 'vec3');
  const tlp = attribute('tlp', 'vec3');
  const inst = attribute('iColF', 'vec4');
  const a = attribute('iAnim', 'vec3'); // phase, heading (unused), moving
  m.colorNode = vc.mul(mix(vec3(1, 1, 1), inst.xyz, tlp.x));
  const limb = tlp.y, pivot = tlp.z;
  // limb rotation about the shoulder / hip pivot, computed in model space and
  // added to the (already instanced) positionLocal, rotated by the heading
  const p = positionGeometry;
  const s = sin(a.x).mul(a.z);
  const isL = (k: number) => float(1).sub(tslAbs(limb.sub(k)).min(1));
  const ang = s.mul(isL(3).mul(0.45).sub(isL(4).mul(0.45)).sub(isL(1).mul(0.35)).add(isL(2).mul(0.35)));
  const dy = p.y.sub(pivot);
  const c = cos(ang), sn = sin(ang);
  const limbMask = limb.min(1);
  const ddx = p.x.mul(c).sub(dy.mul(sn)).sub(p.x).mul(limbMask);
  const ddy = pivot.add(p.x.mul(sn)).add(dy.mul(c)).sub(p.y).mul(limbMask).add(tslAbs(sin(a.x)).mul(0.03).mul(a.z));
  const hc = cos(a.y), hs = sin(a.y);
  m.positionNode = positionLocal.add(vec3(ddx.mul(hc), ddy, ddx.mul(hs).negate()));
  return m;
}

/** integer hash → [0, 1) */
export function hash01(x: number): number {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

