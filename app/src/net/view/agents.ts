import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const STRIDE = 9;
const CAR_COLORS = [0xd8d8d6, 0x24262b, 0x7c8590, 0x9b1f1f, 0x1f3f75, 0xf2f2ee, 0x3d4a3a, 0x8f8a80];

function colored(g: THREE.BufferGeometry, c: number) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const cc = new THREE.Color(c);
  for (let i = 0; i < n; i++) { col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

const box = (l: number, h: number, w: number, x: number, y: number, c: number) => colored(new THREE.BoxGeometry(l, h, w).translate(x, y, 0).toNonIndexed(), c);

function car(): THREE.BufferGeometry {
  return mergeGeometries([
    box(4.5, 0.75, 1.8, 0, 0.55, 0xffffff),
    box(2.4, 0.6, 1.6, -0.25, 1.22, 0xffffff),
    box(0.6, 0.62, 1.86, 0, 0.32, 0x1a1a1a),
  ]);
}

function bus(): THREE.BufferGeometry {
  return mergeGeometries([
    box(12, 2.6, 2.55, 0, 1.65, 0xf2f2ee),
    box(12.05, 0.35, 2.6, 0, 0.55, 0xc8232c),
    box(11.0, 0.9, 2.6, 0, 2.05, 0x2a3138),
  ]);
}

function tram(): THREE.BufferGeometry {
  return mergeGeometries([
    box(9.8, 2.7, 2.54, 0, 1.75, 0xd4202a),
    box(9.85, 0.9, 2.58, 0, 2.15, 0x22262b),
    box(9.85, 0.35, 2.58, 0, 0.55, 0x1c1d1f),
    box(9.0, 0.3, 1.6, 0, 3.25, 0x56595e),
  ]);
}

function train(): THREE.BufferGeometry {
  return mergeGeometries([
    box(25.4, 4.2, 3.0, 0, 2.9, 0x2f6d3c),
    box(25.45, 1.6, 3.04, 0, 3.6, 0xeceee9),
    box(25.45, 0.6, 3.04, 0, 2.2, 0x22262b),
    box(25.45, 0.6, 3.04, 0, 4.1, 0x22262b),
  ]);
}

function ped(): THREE.BufferGeometry {
  return mergeGeometries([box(0.3, 0.9, 0.45, 0, 1.25, 0xffffff), box(0.25, 0.8, 0.35, 0, 0.4, 0x2b2f38), box(0.22, 0.24, 0.22, 0, 1.85, 0xd9b38c)]);
}

export class AgentsView {
  group = new THREE.Group();
  private meshes: THREE.InstancedMesh[];
  private dummy = new THREE.Object3D();
  private col = new THREE.Color();

  constructor(max = 4000) {
    const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 });
    const geos = [car(), bus(), tram(), train(), ped()];
    this.meshes = geos.map((g) => {
      const m = new THREE.InstancedMesh(g, mat, max);
      m.count = 0;
      m.castShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.dummy.rotation.order = 'YZX';
  }

  update(f: Float32Array | number[]) {
    const counts = [0, 0, 0, 0, 0];
    const lens = [4.5, 12, 9.8, 25.4, 1];
    for (let i = 0; i + STRIDE <= f.length; i += STRIDE) {
      const k = f[i + 5] | 0;
      const m = this.meshes[k];
      if (!m) continue;
      const d = this.dummy;
      d.position.set(f[i], f[i + 2], -f[i + 1]);
      d.rotation.set(0, f[i + 3], f[i + 4]);
      const sx = k === 4 ? 1 : f[i + 6] / lens[k];
      d.scale.set(sx, 1, 1);
      d.updateMatrix();
      const n = counts[k]++;
      m.setMatrixAt(n, d.matrix);
      if (k === 0) m.setColorAt(n, this.col.set(CAR_COLORS[(f[i + 7] | 0) % CAR_COLORS.length]));
      else if (k === 4) m.setColorAt(n, this.col.setHSL(((f[i + 7] * 0.13) % 1), 0.35, 0.45));
      else m.setColorAt(n, this.col.set(0xffffff));
    }
    this.meshes.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
  }
}
