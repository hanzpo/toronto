// Crisp, depth-correct selection / hover outlines on real vehicle geometry.
//
// Classic inverted hull: each highlighted car is drawn a second time with its
// back faces, expanded about its bounding-box centre by a constant number of
// screen pixels, in a flat colour. The car's own front faces cover the hull
// everywhere except a thin rim around the silhouette, and anything in front of
// the car (buildings, other vehicles) covers the rim too — so the outline is
// never drawn over the vehicle and never shows through walls. No blur, no
// additive light: a solid line.
//
// Articulated / multi-car consists: where a car touches a neighbour (another
// highlighted car within a few metres of one of its ends) that end is neither
// extended lengthwise nor is its end cap inflated, so the consist gets one
// continuous outline without lines across the roof at every joint.
//
// Usage (the owner adds cars each frame in the same coordinate frame as the
// drawn instances, i.e. as children of `parent`):
//   const o = new OutlineSet(parentGroup);
//   o.begin(); o.add(geometry, x, y, z, heading, pitch, OUTLINE_SELECTED); o.commit();
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, float, length, max, mix, modelWorldMatrix, normalGeometry, positionGeometry, step, uniform, vec3, vec4 } from 'three/tsl';

export const OUTLINE_NONE = 0;
export const OUTLINE_HOVER = 1;
export const OUTLINE_SELECTED = 2;

/** screen pixels per metre at 1 m distance (FrameContext.pixelScale); set once per frame */
const pixelScale = uniform(1000);
export function setOutlinePixelScale(px: number) {
  pixelScale.value = px;
}

const STYLE: Record<number, { color: number; px: number }> = {
  [OUTLINE_HOVER]: { color: 0xffffff, px: 1.5 },
  [OUTLINE_SELECTED]: { color: 0x4c9bff, px: 2.5 },
};

interface Slot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicNodeMaterial;
  center: { value: THREE.Vector3 };
  half: { value: THREE.Vector3 };
  px: { value: number };
  color: { value: THREE.Color };
  /** 1 = the +x / -x end is open (no neighbour): extend the outline past it */
  openPos: { value: number };
  openNeg: { value: number };
  kind: number;
}

const _box = new THREE.Box3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

export class OutlineSet {
  private slots: Slot[] = [];
  private used = 0;
  private boxes = new WeakMap<THREE.BufferGeometry, [THREE.Vector3, THREE.Vector3]>();
  private parent: THREE.Object3D;

  constructor(parent: THREE.Object3D) {
    this.parent = parent;
  }

  begin() {
    this.used = 0;
  }

  /** Outline one car. Position/heading/pitch as for CarPools.add (x forward, y up). */
  add(geom: THREE.BufferGeometry, x: number, y: number, z: number, heading: number, pitch: number, kind: number) {
    const st = STYLE[kind];
    if (!st) return;
    const s = this.slots[this.used] ?? this.slot();
    this.used++;
    let b = this.boxes.get(geom);
    if (!b) {
      geom.computeBoundingBox();
      _box.copy(geom.boundingBox!);
      b = [_box.getCenter(new THREE.Vector3()), _box.getSize(new THREE.Vector3()).multiplyScalar(0.5)];
      this.boxes.set(geom, b);
    }
    s.center.value.copy(b[0]);
    s.half.value.copy(b[1]);
    s.px.value = st.px;
    s.color.value.setHex(st.color);
    s.kind = kind;
    if (s.mesh.geometry !== geom) s.mesh.geometry = geom;
    // same basis as CarPools.add: Ry(heading) · Rz(pitch)
    s.mesh.position.set(x, y, z);
    s.mesh.rotation.set(0, heading, pitch, 'YXZ');
    s.mesh.visible = true;
  }

  commit() {
    const n = this.used;
    // neighbour test: another car of the same highlight whose centre sits just past one of our ends
    for (let i = 0; i < n; i++) {
      const a = this.slots[i];
      a.mesh.updateMatrix();
      _m.copy(a.mesh.matrix).invert();
      let pos = 1, neg = 1;
      const hx = a.half.value.x, cx = a.center.value.x;
      for (let j = 0; j < n && (pos || neg); j++) {
        if (j === i) continue;
        const b = this.slots[j];
        if (b.kind !== a.kind) continue;
        _v.copy(b.mesh.position).applyMatrix4(_m);
        if (Math.abs(_v.y) > 3 || Math.abs(_v.z) > 2.5) continue;
        const reach = hx + b.half.value.x + 3;
        const dx = _v.x - cx;
        if (dx > 0 && dx < reach) pos = 0;
        else if (dx < 0 && -dx < reach) neg = 0;
      }
      a.openPos.value = pos;
      a.openNeg.value = neg;
    }
    for (let i = n; i < this.slots.length; i++) this.slots[i].mesh.visible = false;
  }

  dispose() {
    for (const s of this.slots) { s.mat.dispose(); s.mesh.removeFromParent(); }
    this.slots.length = 0;
  }

  private slot(): Slot {
    const center = uniform(new THREE.Vector3());
    const half = uniform(new THREE.Vector3(1, 1, 1));
    const px = uniform(2);
    const color = uniform(new THREE.Color(0xffffff));
    const openPos = uniform(1);
    const openNeg = uniform(1);
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'vehicle-outline';
    m.side = THREE.BackSide;
    m.depthWrite = false;
    m.fog = false;
    m.toneMapped = false;
    m.positionNode = (() => {
      const wc = modelWorldMatrix.mul(vec4(center, 1)).xyz;
      const dist = length(cameraPosition.sub(wc));
      const w = px.mul(dist).div(pixelScale);
      const h = max(half, vec3(0.05, 0.05, 0.05));
      const d = positionGeometry.sub(center);
      // which end this vertex belongs to, and whether that end is open
      const open = mix(openNeg, openPos, step(0, d.x));
      // end-cap faces (normal along the car axis) of a closed end stay put
      const cap = step(0.7, abs(normalGeometry.x));
      const capOpen = mix(open, float(1), float(1).sub(cap));
      const k = vec3(open, capOpen, capOpen).mul(w).div(h);
      return center.add(d.mul(vec3(1, 1, 1).add(k)));
    })();
    m.colorNode = vec4(color, 1);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    mesh.name = 'vehicle-outline';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    this.parent.add(mesh);
    const s: Slot = { mesh, mat: m, center, half, px, color, openPos, openNeg, kind: 0 };
    this.slots.push(s);
    return s;
  }
}
