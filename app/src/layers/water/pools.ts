// Instanced boat rendering for the WaterLifeLayer: one InstancedMesh per boat
// model (every boat of a type is an instance → one draw call per type), additive
// sprite nav lights at night, and cheap shader foam wakes. Instance matrices are
// anchor-relative (floating origin): `root` sits at the anchor.
import * as THREE from 'three/webgpu';
import {
  attribute, clamp, dot, exp, float, floor, fract, instancedBufferAttribute, length, max, mix, mod, normalView,
  positionViewDirection, pow, sin, smoothstep, step, uv, vec3, vec4, abs, cameraPosition, modelWorldMatrix, positionGeometry, min,
} from 'three/tsl';
import { U } from '../../render/uniforms';
import { boatModel, type BoatKey, type BoatModel } from '../../models/boats';
import { CULL } from '../../engine/view';

/** instance flag bits */
export const F_NAV = 16; // navigation lights on
export const F_WIN = 4; // cabin windows lit (manned)

type N = ReturnType<typeof float>;

function boatMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  m.name = 'boats';
  const vc = attribute('color', 'vec3');
  const tags = attribute('tags', 'vec4');
  const inst = attribute('iColF', 'vec4');
  const liv = tags.x, lamp = tags.y, sign = tags.z, glass = tags.w;
  const flags = inst.w as unknown as N;
  const bit = (v: number) => step(0.5, mod(floor(flags.div(v)), 2));
  const is = (k: number) => step(k - 0.5, lamp).mul(step(lamp, k + 0.5));
  const night = U.night;
  const nav = bit(F_NAV).mul(night.mul(3).add(0.15));
  const emissive = vec3(1, 0.95, 0.85).mul(is(1)).add(vec3(1, 0.08, 0.04).mul(is(2))).add(vec3(0.1, 1, 0.3).mul(is(3))).mul(nav)
    .add(vec3(1.0, 0.72, 0.38).mul(sign).mul(bit(F_WIN)).mul(night.mul(1.3)));
  const f = pow(float(1).sub(clamp(dot(normalView, positionViewDirection), 0, 1)), 3);
  const sky = mix(U.skyHorizon, U.skyZenith, 0.35);
  const refl = sky.mul(glass).mul(f.mul(0.35).add(0.04)).mul(float(1).sub(night.mul(0.85)));
  m.colorNode = vc.mul(mix(vec3(1, 1, 1), inst.xyz, liv));
  m.roughnessNode = mix(float(0.55), float(0.08), glass);
  m.metalnessNode = mix(float(0.05), float(0.0), glass);
  m.emissiveNode = emissive.add(refl);
  return m;
}

/** Geometry with livery/lamp/sign/glass packed into one vec4 (WebGPU vertex-buffer limit). */
function packGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  const n = g.attributes.position.count;
  c.setAttribute('position', g.attributes.position);
  c.setAttribute('normal', g.attributes.normal);
  c.setAttribute('color', g.attributes.color);
  const tags = new Float32Array(n * 4);
  (['livery', 'lamp', 'sign', 'glass'] as const).forEach((k, j) => {
    const a = g.attributes[k] as THREE.BufferAttribute | undefined;
    if (a) for (let i = 0; i < n; i++) tags[i * 4 + j] = a.getX(i);
  });
  c.setAttribute('tags', new THREE.BufferAttribute(tags, 4));
  if (g.index) c.setIndex(g.index);
  c.computeBoundingSphere();
  return c;
}

class Pool {
  mesh: THREE.InstancedMesh;
  col: THREE.InstancedBufferAttribute;
  count = 0;
  /** distance (m) from the shadow frustum centre of the nearest boat added this frame */
  nearest = Infinity;
  capacity: number;
  readonly model: BoatModel;
  readonly geom: THREE.BufferGeometry;
  readonly mat: THREE.Material;
  readonly parent: THREE.Object3D;
  constructor(model: BoatModel, geom: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D) {
    this.model = model; this.geom = geom; this.mat = mat; this.parent = parent;
    this.capacity = cap;
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    geom.setAttribute('iColF', this.col);
    this.mesh = this.make(cap);
  }
  private make(cap: number) {
    const mesh = new THREE.InstancedMesh(this.geom, this.mat, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `boat-${this.model.key}`;
    this.parent.add(mesh);
    return mesh;
  }
  grow() {
    const cap = this.capacity * 2;
    const old = this.mesh;
    const c = new Float32Array(cap * 4); c.set(this.col.array as Float32Array);
    this.col = new THREE.InstancedBufferAttribute(c, 4);
    this.geom.setAttribute('iColF', this.col);
    const mesh = this.make(cap);
    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    old.removeFromParent();
    old.dispose();
    this.mesh = mesh;
    this.capacity = cap;
  }
  commit(shadows: boolean, reach: number) {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    // the instanced pool draws every boat into the shadow map: only while one is
    // inside the sun's shadow frustum (the camera focus ± its half-size)
    this.mesh.castShadow = shadows && (!CULL || this.nearest < reach);
    if (!this.count) return;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, this.count * 16); im.needsUpdate = true;
    this.col.clearUpdateRanges(); this.col.addUpdateRange(0, this.count * 4); this.col.needsUpdate = true;
  }
}

const LIGHT_CAP = 6000;
const WAKE_CAP = 512;
const LIGHT_HEX = { w: 0xfff6e8, r: 0xff2a1a, g: 0x22ff66, y: 0xffc27a } as const;

export class BoatPools {
  readonly root = new THREE.Group();
  private pools = new Map<BoatKey, Pool>();
  private material = boatMaterial();
  // lights
  private lights: THREE.Sprite;
  private lPos: THREE.InstancedBufferAttribute;
  private lCol: THREE.InstancedBufferAttribute;
  private lSize: THREE.InstancedBufferAttribute;
  private lCount = 0;
  // wakes
  private wake: THREE.Mesh;
  private wPos: THREE.BufferAttribute;
  private wUv: THREE.BufferAttribute;
  private wakeK: THREE.BufferAttribute;
  private wCount = 0;
  /** last matrix written (for light placement) */
  private m = new Float32Array(16);

  constructor() {
    this.root.name = 'water-life';
    // ---- sprite lights
    this.lPos = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP * 3), 3);
    this.lCol = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP * 3), 3);
    this.lSize = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP), 1);
    const lm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    lm.name = 'boat-lights';
    lm.positionNode = instancedBufferAttribute(this.lPos);
    lm.scaleNode = instancedBufferAttribute(this.lSize);
    const d = length(uv().sub(0.5)).mul(2);
    const core = float(1).sub(smoothstep(0.0, 1.0, d));
    const glow = max(core.mul(core).mul(core), float(0));
    const lc = instancedBufferAttribute(this.lCol) as unknown as ReturnType<typeof vec3>;
    lm.colorNode = vec4(lc.mul(glow).mul(1.6), glow);
    lm.fog = false;
    this.lights = new THREE.Sprite(lm);
    this.lights.count = 0;
    this.lights.frustumCulled = false;
    this.lights.renderOrder = 5;
    this.lights.name = 'boat-lights';
    this.root.add(this.lights);

    // ---- wakes: one dynamic mesh, 4 vertices per wake (anchor-relative positions)
    const g = new THREE.BufferGeometry();
    this.wPos = new THREE.BufferAttribute(new Float32Array(WAKE_CAP * 12), 3);
    this.wUv = new THREE.BufferAttribute(new Float32Array(WAKE_CAP * 8), 2);
    this.wakeK = new THREE.BufferAttribute(new Float32Array(WAKE_CAP * 16), 4);
    for (const a of [this.wPos, this.wUv, this.wakeK]) a.setUsage(THREE.DynamicDrawUsage);
    const nrm = new Float32Array(WAKE_CAP * 12);
    for (let i = 0; i < WAKE_CAP * 4; i++) nrm[i * 3 + 1] = 1;
    const idx = new Uint16Array(WAKE_CAP * 6);
    for (let k = 0; k < WAKE_CAP; k++) idx.set([k * 4, k * 4 + 2, k * 4 + 1, k * 4, k * 4 + 3, k * 4 + 2], k * 6);
    g.setAttribute('position', this.wPos);
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', this.wUv);
    g.setAttribute('wk', this.wakeK);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.wake = new THREE.Mesh(g, wakeMaterial());
    this.wake.frustumCulled = false;
    this.wake.renderOrder = 2;
    this.wake.name = 'boat-wakes';
    this.root.add(this.wake);
  }

  private pool(key: BoatKey): Pool {
    let p = this.pools.get(key);
    if (!p) {
      const model = boatModel(key);
      p = new Pool(model, packGeometry(model.geometry), this.material, 32, this.root);
      this.pools.set(key, p);
    }
    return p;
  }

  begin() {
    for (const p of this.pools.values()) { p.count = 0; p.nearest = Infinity; }
    this.lCount = 0;
    this.wCount = 0;
  }

  /**
   * Add a boat. x, y, z anchor-relative three coords of the waterline centre;
   * yaw = heading (rad, math angle from +E towards +N); pitch (bow up +), roll
   * (starboard down +); s uniform scale. Returns the model (for lights).
   */
  add(key: BoatKey, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, s: number, tint: THREE.Color, flags: number, dist = 0): BoatModel {
    const p = this.pool(key);
    if (dist < p.nearest) p.nearest = dist;
    if (p.count >= p.capacity) p.grow();
    const k = p.count++;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Ry(yaw) · Rz(pitch) · Rx(roll), columns = images of the model axes
    const m = this.m;
    // Rz(p)·Rx(r): x' = (cp, sp, 0); y' = (-sp·cr, cp·cr, sr); z' = (sp·sr, -cp·sr, cr)
    const ax = [cp, sp, 0], ay = [-sp * cr, cp * cr, sr], az = [sp * sr, -cp * sr, cr];
    // Ry(yaw): (x, y, z) → (x·cy + z·sy, y, -x·sy + z·cy)
    const ry = (v: number[], o: number) => { m[o] = (v[0] * cy + v[2] * sy) * s; m[o + 1] = v[1] * s; m[o + 2] = (-v[0] * sy + v[2] * cy) * s; m[o + 3] = 0; };
    ry(ax, 0); ry(ay, 4); ry(az, 8);
    m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
    (p.mesh.instanceMatrix.array as Float32Array).set(m, k * 16);
    const c = p.col.array as Float32Array;
    c[k * 4] = tint.r; c[k * 4 + 1] = tint.g; c[k * 4 + 2] = tint.b; c[k * 4 + 3] = flags;
    return p.model;
  }

  /** Sprite lights of the boat just added (uses its matrix). kinds: which light colours to show. */
  lightsFor(model: BoatModel, dist: number, pixelScale: number, gain: number, only?: 'anchor') {
    const m = this.m;
    for (const l of model.lights) {
      if (only === 'anchor' && !(l.c === 'w' && l.p[1] > 2)) continue;
      if (this.lCount >= LIGHT_CAP) return;
      const [px, py, pz] = l.p;
      const j = this.lCount++;
      this.lPos.setXYZ(j, m[0] * px + m[4] * py + m[8] * pz + m[12], m[1] * px + m[5] * py + m[9] * pz + m[13], m[2] * px + m[6] * py + m[10] * pz + m[14]);
      const hex = LIGHT_HEX[l.c];
      const g = l.c === 'y' ? gain * 0.7 : gain;
      this.lCol.setXYZ(j, ((hex >> 16) & 255) / 255 * g, ((hex >> 8) & 255) / 255 * g, (hex & 255) / 255 * g);
      const minPx = l.c === 'y' ? 2.5 : 3;
      this.lSize.setX(j, Math.max(l.c === 'y' ? 3 : 1.2, (minPx * dist) / pixelScale));
    }
  }

  /** Wake behind a moving boat: bow at (x, z), heading yaw, hull length/beam (m), speed (m/s). */
  addWake(x: number, y: number, z: number, yaw: number, len: number, beam: number, speed: number, seed: number) {
    if (this.wCount >= WAKE_CAP || speed < 0.4) return;
    const k = this.wCount++;
    const wl = len * (1.6 + Math.min(speed, 8) * 0.9) + 20; // wake length (m)
    const hw = wl * 0.36 + beam * 0.5; // Kelvin half-angle ~19.5°
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // forward (three) = (cy, 0, -sy), starboard = (sy, 0, cy); quad: bow edge → wl astern
    const P = this.wPos.array as Float32Array, T = this.wUv.array as Float32Array, W = this.wakeK.array as Float32Array;
    const corners: [number, number, number, number][] = [[0, -1, 0, 0], [0, 1, 0, 1], [-1, 1, 1, 1], [-1, -1, 1, 0]];
    corners.forEach(([f, sd, u, v], j) => {
      const i = k * 4 + j;
      P[i * 3] = x + cy * wl * f + sy * hw * sd;
      P[i * 3 + 1] = y;
      P[i * 3 + 2] = z - sy * wl * f + cy * hw * sd;
      T[i * 2] = u; T[i * 2 + 1] = v;
      W[i * 4] = Math.max(0.18, Math.min(1, (speed - 0.8) / 6)); // intensity
      W[i * 4 + 1] = len / wl; // hull fraction of the wake quad
      W[i * 4 + 2] = beam / (2 * hw); // hull half-width fraction
      W[i * 4 + 3] = seed % 97;
    });
  }

  commit(shadowsNear: boolean, reach = Infinity) {
    for (const p of this.pools.values()) p.commit(shadowsNear, reach);
    this.lights.count = this.lCount;
    this.lights.visible = this.lCount > 0;
    if (this.lCount) {
      for (const [a, w] of [[this.lPos, 3], [this.lCol, 3], [this.lSize, 1]] as const) {
        a.clearUpdateRanges(); a.addUpdateRange(0, this.lCount * w); a.needsUpdate = true;
      }
    }
    this.wake.geometry.setDrawRange(0, this.wCount * 6);
    this.wake.visible = this.wCount > 0;
    if (this.wCount) {
      for (const [a, w] of [[this.wPos, 12], [this.wUv, 8], [this.wakeK, 16]] as const) {
        a.clearUpdateRanges(); a.addUpdateRange(0, this.wCount * w); a.needsUpdate = true;
      }
    }
  }

  get instances(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.count;
    return n;
  }

  dispose() {
    for (const p of this.pools.values()) { p.geom.dispose(); p.mesh.dispose(); }
    this.material.dispose();
    (this.lights.material as THREE.Material).dispose();
    this.wake.geometry.dispose();
    (this.wake.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}

/**
 * Foam wake: a Kelvin "V" (two diverging arms at ~19.5°) plus the turbulent
 * propeller wash along the centreline, broken up by scrolling procedural noise
 * and fading with distance astern. uv.x = 0 at the bow → 1 at the wake's end,
 * uv.y = 0..1 across (0.5 = centreline).
 */
function wakeMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.name = 'boat-wake';
  // depth pull toward the camera (screen position unchanged) so the foam wins
  // against the tile water surface, whose local level can sit a little higher
  // (the mesh is only translated to the anchor, so a world offset is an object offset)
  const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const toCam = cameraPosition.sub(wp);
  const dc = length(toCam);
  m.positionNode = positionGeometry.add(toCam.div(dc).mul(min(dc.mul(0.0015).add(0.6), dc.mul(0.5))));
  const wk = attribute('wk', 'vec4');
  const inten = wk.x, hullF = wk.y, beamF = wk.z, seed = wk.w;
  const t = uv().x as unknown as N; // along
  const s = abs(uv().y.sub(0.5)).mul(2) as unknown as N; // 0 centre → 1 edge
  // arms: |s| grows linearly with t (edge of the quad at t = 1)
  const armS = t.mul(0.97).add(beamF.mul(float(1).sub(t)));
  const arm = exp(pow(s.sub(armS).div(t.mul(0.06).add(0.018)), 2).negate());
  // transverse ripples between the arms
  const ripple = sin(t.mul(90).sub(U.time.mul(3)).add(seed)).mul(0.5).add(0.5).mul(step(s, armS)).mul(0.25);
  // centreline wash (starts at the stern)
  const astern = smoothstep(hullF.mul(0.85), hullF.add(0.02), t);
  const washW = beamF.mul(1.1).add(t.mul(0.12));
  const wash = exp(pow(s.div(washW), 2).negate()).mul(astern);
  // noise: cheap hash of a scrolling lattice
  const nx = t.mul(160).add(U.time.mul(0.6)).add(seed), ny = s.mul(24);
  const noise = fract(sin(floor(nx).mul(12.9898).add(floor(ny).mul(78.233)).add(seed)).mul(43758.5453));
  const fade = pow(float(1).sub(t), 1.6);
  const a = arm.mul(0.85).add(wash.mul(1.1)).add(ripple.mul(0.35)).mul(noise.mul(0.5).add(0.5)).mul(fade).mul(inten);
  const daylight = float(1).sub(U.night.mul(0.75));
  m.colorNode = vec4(vec3(0.93, 0.96, 0.98).mul(daylight), clamp(a, 0, 0.85));
  return m;
}
