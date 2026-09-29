// Instanced markers / vehicles that keep a minimum on-screen size, so they
// stay visible from 50+ km. One draw call per overlay. Positions are stored in
// world space (f64) and uploaded anchor-relative (floating origin).
import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, vec3, vec4, float, max, length, cos, sin, positionGeometry, normalLocal, mix } from 'three/tsl';
import type { Engine } from '../../engine/Engine';
import type { FrameContext } from '../../engine/types';
import type { DepthMode } from './LineOverlay';

export type MarkerShape = 'box' | 'train' | 'bus' | 'disc' | 'diamond';

export interface MarkerOverlayOptions {
  name?: string;
  capacity?: number;
  shape?: MarkerShape | THREE.BufferGeometry;
  /** real-world size in metres: [length (along heading), height, width] */
  size?: [number, number, number];
  /** minimum on-screen length in CSS pixels */
  minPixels?: number;
  depthMode?: DepthMode;
  /** metres added to elevation */
  lift?: number;
}

function shapeGeometry(shape: MarkerShape): THREE.BufferGeometry {
  switch (shape) {
    case 'disc': return new THREE.CylinderGeometry(0.5, 0.5, 1, 20).translate(0, 0.5, 0);
    case 'diamond': return new THREE.OctahedronGeometry(0.5).translate(0, 0.5, 0);
    case 'train': {
      // long box with a tapered nose (+x)
      const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) if (p.getX(i) > 0 && p.getY(i) > 0.5) p.setX(i, 0.42);
      g.computeVertexNormals();
      return g;
    }
    case 'bus':
    case 'box':
    default: return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  }
}

/**
 * Usage:
 *   const trains = new MarkerOverlay(engine, { capacity: 2000, shape: 'train', size: [150, 4.5, 3.2], minPixels: 7 });
 *   trains.setMarker(i, e, n, elev, headingRadCCWfromEast, 0x3e8a36);  // for i < count
 *   trains.setCount(n); trains.commit();
 *   // each frame in your layer: trains.update(ctx)
 */
export class MarkerOverlay {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  count = 0;
  private world: Float64Array; // E, N, elev per marker
  private iPos: THREE.InstancedBufferAttribute; // x, y, z (anchor-relative three coords), heading
  private iCol: THREE.InstancedBufferAttribute;
  private geom: THREE.InstancedBufferGeometry;
  private camRel = uniform(new THREE.Vector3());
  private pixelScale = uniform(1000);
  private minPx = uniform(6);
  private anchorVersion = -1;
  private anchor = new THREE.Vector3();
  private opts: Required<Omit<MarkerOverlayOptions, 'shape'>>;
  private lastOnTop: boolean | null = null;
  private dirty = false;

  constructor(engine: Engine, opts: MarkerOverlayOptions = {}) {
    this.opts = { name: 'markers', capacity: 1024, size: [12, 3.5, 3], minPixels: 6, depthMode: 'auto', lift: 0.5, ...opts } as Required<Omit<MarkerOverlayOptions, 'shape'>>;
    this.capacity = this.opts.capacity;
    const base = opts.shape instanceof THREE.BufferGeometry ? opts.shape : shapeGeometry(opts.shape ?? 'box');
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('normal', base.attributes.normal);
    // optional per-vertex colours + livery mask (app/src/models): the instance
    // colour only tints vertices with livery = 1
    const hasVC = !!base.attributes.color, hasLiv = !!base.attributes.livery;
    if (hasVC) g.setAttribute('color', base.attributes.color);
    if (hasLiv) g.setAttribute('livery', base.attributes.livery);
    this.world = new Float64Array(this.capacity * 3);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.iCol = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.iPos.setUsage(THREE.DynamicDrawUsage);
    this.iCol.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.iPos);
    g.setAttribute('iCol', this.iCol);
    g.instanceCount = 0;
    this.geom = g;

    const [L, H, W] = this.opts.size;
    this.minPx.value = this.opts.minPixels;
    const size = vec3(L, H, W);
    const iPos = attribute('iPos', 'vec4');
    const iCol = attribute('iCol', 'vec3');
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = this.opts.name;
    m.positionNode = Fn(() => {
      const off = iPos.xyz;
      const d = length(this.camRel.sub(off));
      // enforce a minimum on-screen size per axis (length >= minPx, height/width >= 45% of it)
      const minWorld = this.minPx.mul(d).div(this.pixelScale);
      const sz = max(size, vec3(minWorld, minWorld.mul(0.45), minWorld.mul(0.45)));
      const p = positionGeometry.mul(sz);
      const c = cos(iPos.w), sn = sin(iPos.w);
      const r = vec3(p.x.mul(c).add(p.z.mul(sn)), p.y, p.x.mul(sn).negate().add(p.z.mul(c)));
      return r.add(off);
    })();
    // cheap fake lighting so boxes read as 3D
    const vc = hasVC ? attribute('color', 'vec3') : vec3(1, 1, 1);
    const tint = hasLiv ? mix(vec3(1, 1, 1), iCol, attribute('livery', 'float')) : iCol;
    m.colorNode = vec4(vc.mul(tint).mul(mix(float(0.62), float(1.08), normalLocal.y.mul(0.5).add(0.5))), 1);
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 120;
    this.mesh.name = this.opts.name;
    engine.overlayRoot.add(this.mesh);
  }

  /** heading: radians counter-clockwise from +E (east); colour 0xRRGGBB */
  setMarker(i: number, e: number, n: number, elev: number, heading: number, color: number) {
    if (i >= this.capacity) return;
    this.world[i * 3] = e; this.world[i * 3 + 1] = n; this.world[i * 3 + 2] = elev;
    const a = this.iPos.array as Float32Array;
    a[i * 4] = e - this.anchor.x;
    a[i * 4 + 1] = elev + this.opts.lift;
    a[i * 4 + 2] = -n - this.anchor.z;
    a[i * 4 + 3] = heading;
    const c = this.iCol.array as Float32Array;
    _c.setHex(color);
    c[i * 3] = _c.r; c[i * 3 + 1] = _c.g; c[i * 3 + 2] = _c.b;
    this.dirty = true;
  }

  setCount(n: number) {
    this.count = Math.min(n, this.capacity);
    this.geom.instanceCount = this.count;
  }

  /** flag uploads (call after a batch of setMarker) */
  commit() {
    this.dirty = true;
  }

  setVisible(v: boolean) { this.mesh.visible = v; }

  update(ctx: FrameContext) {
    if (ctx.anchor.version !== this.anchorVersion) {
      this.anchorVersion = ctx.anchor.version;
      this.anchor.copy(ctx.anchor.origin);
      this.mesh.position.copy(this.anchor);
      const a = this.iPos.array as Float32Array;
      for (let i = 0; i < this.count; i++) {
        a[i * 4] = this.world[i * 3] - this.anchor.x;
        a[i * 4 + 2] = -this.world[i * 3 + 1] - this.anchor.z;
      }
      this.dirty = true;
    }
    if (this.dirty) {
      this.iPos.addUpdateRange(0, this.count * 4);
      this.iCol.addUpdateRange(0, this.count * 3);
      this.iPos.needsUpdate = true;
      this.iCol.needsUpdate = true;
      this.dirty = false;
    }
    this.camRel.value.copy(ctx.cameraPos).sub(this.anchor);
    this.pixelScale.value = ctx.pixelScale;
    const onTop = this.opts.depthMode === 'onTop' || (this.opts.depthMode === 'auto' && ctx.analyticsMode);
    if (onTop !== this.lastOnTop) {
      const mat = this.mesh.material as THREE.Material;
      mat.depthTest = !onTop;
      mat.needsUpdate = true;
      this.lastOnTop = onTop;
    }
  }

  dispose() {
    this.geom.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

const _c = new THREE.Color();
