// One InstancedMesh per car geometry (and detail level): every car of every
// nearby transit vehicle is an instance, so a whole city's worth of articulated
// consists costs one draw call per distinct car type. Instance matrices are
// anchor-relative (floating origin) like the traffic layer.
import * as THREE from 'three/webgpu';
import type { CarSpec } from '../../models/consists';
import { packedVehicleMaterial } from '../../models/material';
import { OutlineSet } from '../../render/overlay/OutlineSet';

/** instance flag bits understood by vehicleMaterial */
export const FLAG_BRAKE = 1;
export const FLAG_HEAD = 16;
/** powered down: lamps and signs off (parked in a depot) */
export const FLAG_OFF = 32;

class Pool {
  mesh: THREE.InstancedMesh;
  col: THREE.InstancedBufferAttribute; // rgb tint + flags (WebGPU allows only 8 vertex buffers)
  count = 0;
  capacity: number;
  readonly geom: THREE.BufferGeometry;
  readonly mat: THREE.Material;
  readonly parent: THREE.Object3D;
  readonly shadows: boolean;
  constructor(geom: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, shadows: boolean, name: string) {
    this.geom = geom; this.mat = mat; this.parent = parent; this.shadows = shadows;
    this.capacity = cap;
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    geom.setAttribute('iColF', this.col);
    this.mesh = new THREE.InstancedMesh(geom, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = shadows;
    this.mesh.name = name;
    parent.add(this.mesh);
  }

  /** Double the capacity (rebuilds the mesh; keeps the current contents). */
  grow() {
    const cap = this.capacity * 2;
    const old = this.mesh;
    const m = new Float32Array(cap * 16); m.set(old.instanceMatrix.array as Float32Array);
    const c = new Float32Array(cap * 4); c.set(this.col.array as Float32Array);
    this.col = new THREE.InstancedBufferAttribute(c, 4);
    this.geom.setAttribute('iColF', this.col);
    const mesh = new THREE.InstancedMesh(this.geom, this.mat, cap);
    (mesh.instanceMatrix.array as Float32Array).set(m);
    mesh.frustumCulled = false;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = this.shadows;
    mesh.name = old.name;
    this.parent.add(mesh);
    old.removeFromParent();
    old.dispose();
    this.mesh = mesh;
    this.capacity = cap;
  }

  commit() {
    this.mesh.count = this.count;
    if (!this.count) return;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, this.count * 16); im.needsUpdate = true;
    this.col.clearUpdateRanges(); this.col.addUpdateRange(0, this.count * 4); this.col.needsUpdate = true;
  }
}

/**
 * Lit vehicle material (same shading as models/material.ts vehicleMaterial) but
 * reading the packed per-vertex `tags` and per-instance `iColF` attributes.
 */
function carMaterial(): THREE.MeshStandardNodeMaterial {
  return packedVehicleMaterial('transit-cars');
}

/** Metre-space copy of a unit car geometry (so instance matrices stay rigid). */
function metreGeometry(g: THREE.BufferGeometry, size: [number, number, number]): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  const src = g.attributes.position as THREE.BufferAttribute;
  const p = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) {
    p[i * 3] = src.getX(i) * size[0];
    p[i * 3 + 1] = src.getY(i) * size[1];
    p[i * 3 + 2] = src.getZ(i) * size[2];
  }
  c.setAttribute('position', new THREE.BufferAttribute(p, 3));
  c.setAttribute('normal', g.attributes.normal);
  if (g.attributes.color) c.setAttribute('color', g.attributes.color);
  else c.setAttribute('color', new THREE.BufferAttribute(new Float32Array(src.count * 3).fill(0.8), 3));
  // livery, lamp, sign, glass packed into one vec4
  const tags = new Float32Array(src.count * 4);
  (['livery', 'lamp', 'sign', 'glass'] as const).forEach((k, j) => {
    const a = g.attributes[k] as THREE.BufferAttribute | undefined;
    if (a) for (let i = 0; i < src.count; i++) tags[i * 4 + j] = a.getX(i);
  });
  c.setAttribute('tags', new THREE.BufferAttribute(tags, 4));
  if (g.index) c.setIndex(g.index);
  c.computeBoundingSphere();
  return c;
}

export class CarPools {
  readonly group = new THREE.Group();
  private pools = new Map<string, Pool>();
  private material: THREE.Material;
  /** selection / hover outlines (render/overlay/OutlineSet) */
  private outline: OutlineSet;

  constructor() {
    this.group.name = 'transit-cars';
    this.material = carMaterial();
    this.outline = new OutlineSet(this.group);
  }

  private pool(spec: CarSpec, low: boolean): Pool {
    const key = low && spec.lowGeometry ? `${spec.key}:lo` : spec.key;
    let p = this.pools.get(key);
    if (!p) {
      const g = low && spec.lowGeometry ? spec.lowGeometry() : spec.geometry();
      p = new Pool(metreGeometry(g, spec.size), this.material, 64, this.group, !low, `car-${key}`);
      this.pools.set(key, p);
    }
    return p;
  }

  begin() {
    for (const p of this.pools.values()) p.count = 0;
    this.outline.begin();
  }

  /** Add one car. Position is anchor-relative three.js coordinates (x = E, y = up, z = -N). */
  add(spec: CarSpec, low: boolean, x: number, y: number, z: number, heading: number, pitch: number, color: THREE.Color, flags: number, outline = 0) {
    const p = this.pool(spec, low);
    if (outline) this.outline.add(p.geom, x, y, z, heading, pitch, outline);
    if (p.count >= p.capacity) p.grow();
    const k = p.count++;
    const ch = Math.cos(heading), sh = Math.sin(heading), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const m = p.mesh.instanceMatrix.array as Float32Array;
    const b = k * 16;
    // Ry(heading) · Rz(pitch), column-major (x forward, z = right-hand side)
    m[b] = ch * cp; m[b + 1] = sp; m[b + 2] = -sh * cp; m[b + 3] = 0;
    m[b + 4] = -ch * sp; m[b + 5] = cp; m[b + 6] = sh * sp; m[b + 7] = 0;
    m[b + 8] = sh; m[b + 9] = 0; m[b + 10] = ch; m[b + 11] = 0;
    m[b + 12] = x; m[b + 13] = y; m[b + 14] = z; m[b + 15] = 1;
    const c = p.col.array as Float32Array;
    c[k * 4] = color.r; c[k * 4 + 1] = color.g; c[k * 4 + 2] = color.b; c[k * 4 + 3] = flags;
  }

  commit() {
    for (const p of this.pools.values()) p.commit();
    this.outline.commit();
  }

  /** instances drawn this frame */
  get instances(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.count;
    return n;
  }

  dispose() {
    for (const p of this.pools.values()) { p.geom.dispose(); p.mesh.dispose(); }
    this.material.dispose();
    this.outline.dispose();
    this.group.removeFromParent();
  }
}
