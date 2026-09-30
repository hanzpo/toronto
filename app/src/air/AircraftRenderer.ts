// Instanced aircraft rendering: one InstancedMesh per aircraft type sharing a
// single lit node material (per-instance livery colours by model part, gear
// retraction), plus additive sprite lights (nav, strobes, beacon, landing).
// Positions are anchor-relative (floating origin); far aircraft are scaled up
// to a minimum on-screen size so they stay visible from the regional view.
import * as THREE from 'three/webgpu';
import { Fn, attribute, vec3, vec4, float, mix, positionLocal, instancedBufferAttribute, uv, smoothstep, length, max } from 'three/tsl';
import type { FrameContext } from '../engine/types';
import { aircraftModel, PART, type AircraftModel } from '../models/aircraft';
import { liveryOf } from './liveries';
import { U } from '../render/uniforms';
import { FL_GEAR, FL_LANDING, FL_STROBE, FL_TAXI } from './track';
import type { AirPlane } from './AirSystem';

const CAP = 200;
const LIGHT_CAP = 6000;

interface TypeMesh {
  model: AircraftModel;
  mesh: THREE.InstancedMesh;
  /** interleaved per-instance data: 5 livery colours (rgb) + gear (1) = 16 floats */
  data: THREE.InstancedInterleavedBuffer;
  count: number;
}

export interface DrawnPlane { idx: number; e: number; n: number; h: number; yaw: number; pitch: number; len: number; scale: number }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0, 'YZX');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

export class AircraftRenderer {
  readonly root = new THREE.Group();
  private material: THREE.MeshStandardNodeMaterial;
  private types = new Map<string, TypeMesh>();
  private lights: THREE.Sprite;
  private lPos: THREE.InstancedBufferAttribute;
  private lCol: THREE.InstancedBufferAttribute;
  private lSize: THREE.InstancedBufferAttribute;
  private lCount = 0;
  /** planes drawn last frame (for picking), index into the AirSystem planes array */
  drawn: DrawnPlane[] = [];
  minPixels = 15;
  groundMinPixels = 3;

  constructor() {
    this.root.name = 'air';
    const part = attribute('part', 'float');
    const col = attribute('color', 'vec3');
    const c0 = attribute('iFuse', 'vec3'), c1 = attribute('iTail', 'vec3'), c2 = attribute('iBelly', 'vec3');
    const c3 = attribute('iAccent', 'vec3'), c4 = attribute('iEngine', 'vec3');
    // iGear packs gear-down (1) + 0.5 * far-view factor (0..0.9)
    const gv = attribute('iGear', 'float');
    const gear = gv.greaterThanEqual(0.99).select(float(1), float(0));
    const far = gv.sub(gear).mul(2);
    // far aircraft read as solid icons: dark on the day map, glowing on the analytics map
    const farDay = vec3(0.02, 0.035, 0.08), farAn = vec3(0.45, 0.62, 1.0);
    const is = (k: number) => float(1).sub(smoothstep(0.25, 0.5, part.sub(k).abs()));
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0.15 });
    m.name = 'aircraft';
    m.colorNode = Fn(() => {
      const c = mix(mix(mix(mix(mix(col, c0, is(PART.FUSE)), c1, is(PART.TAIL)), c2, is(PART.BELLY)), c3, is(PART.ACCENT)), c4, is(PART.ENGINE));
      return vec4(mix(c, farDay, far.mul(float(1).sub(U.analytics))), 1);
    })();
    // far icons glow on the analytics map; at night a faint self-illumination (apron floodlights / logo
    // lights) keeps liveries readable next to the lit city
    m.emissiveNode = farAn.mul(far).mul(U.analytics).mul(0.9).add(vec3(col).mul(U.night).mul(0.07));
    // retracted gear collapses to the origin (degenerate, invisible)
    m.positionNode = Fn(() => positionLocal.mul(mix(float(1), gear, is(PART.GEAR))))();
    this.material = m;

    // lights: additive camera-facing sprites
    this.lPos = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP * 3), 3);
    this.lCol = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP * 3), 3);
    this.lSize = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP), 1);
    for (const a of [this.lPos, this.lCol, this.lSize]) a.setUsage(THREE.DynamicDrawUsage);
    const lm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    lm.name = 'aircraft-lights';
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
    this.lights.name = 'aircraft-lights';
    this.root.add(this.lights);
  }

  private typeMesh(code: string): TypeMesh {
    let t = this.types.get(code);
    if (t) return t;
    const model = aircraftModel(code);
    const g = model.geometry.clone();
    // one interleaved vertex buffer (WebGPU allows only 8 vertex buffers per pipeline)
    const data = new THREE.InstancedInterleavedBuffer(new Float32Array(CAP * 16), 16);
    data.setUsage(THREE.DynamicDrawUsage);
    ['iFuse', 'iTail', 'iBelly', 'iAccent', 'iEngine'].forEach((n, k) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(data, 3, k * 3)));
    g.setAttribute('iGear', new THREE.InterleavedBufferAttribute(data, 1, 15));
    const mesh = new THREE.InstancedMesh(g, this.material, CAP);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `aircraft-${code}`;
    this.root.add(mesh);
    t = { model, mesh, data, count: 0 };
    this.types.set(code, t);
    return t;
  }

  /** write instances for planes[0..count) */
  update(ctx: FrameContext, planes: AirPlane[], count: number, visible: boolean, selectedKey: string | null) {
    const anchor = ctx.anchor.origin;
    this.root.position.copy(anchor);
    for (const t of this.types.values()) t.count = 0;
    this.lCount = 0;
    this.drawn.length = 0;
    this.root.visible = visible;
    if (!visible) { this.flush(); return; }
    const cam = ctx.cameraPos;
    const night = 1 - ctx.daylight;
    const time = ctx.time;
    for (let i = 0; i < count; i++) {
      const pl = planes[i];
      const t = this.typeMesh(pl.type);
      if (t.count >= CAP) continue;
      const k = t.count++;
      const p = pl.pose;
      const x = p.e - anchor.x, y = p.h, z = -p.n - anchor.z;
      const dist = Math.hypot(p.e - cam.x, p.h - cam.y, -p.n - cam.z);
      const L = t.model.spec.length;
      const onGround = p.phase < 5 || p.phase >= 10;
      const minPx = pl.key === selectedKey ? 16 : pl.kind === 'park' ? 0 : onGround ? this.groundMinPixels : this.minPixels;
      const s = Math.max(1, (minPx * dist) / (ctx.pixelScale * L));
      _eul.set(p.bank, p.yaw, p.pitch, 'YZX');
      _q.setFromEuler(_eul);
      _p.set(x, y, z);
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      t.mesh.setMatrixAt(k, _m);
      const liv = liveryOf(pl.airline);
      const arr = t.data.array as Float32Array;
      const o = k * 16;
      const set = (j: number, hex: number) => { _c.setHex(hex); arr[o + j * 3] = _c.r; arr[o + j * 3 + 1] = _c.g; arr[o + j * 3 + 2] = _c.b; };
      set(0, liv.fuse); set(1, liv.tail); set(2, liv.belly); set(3, liv.accent); set(4, liv.engine);
      arr[o + 15] = (p.flags & FL_GEAR ? 1 : 0) + 0.45 * smooth01((s - 2.5) / 5);
      this.drawn.push({ idx: i, e: p.e, n: p.n, h: p.h, yaw: p.yaw, pitch: p.pitch, len: L * s, scale: s });

      // ---- lights
      const pts = t.model.points;
      const lit = pl.kind !== 'park';
      const lightScale = (w: number, minPx: number) => Math.max(w, (minPx * dist) / ctx.pixelScale);
      const addLight = (lp: THREE.Vector3, hex: number, worldSize: number, pxMin: number, gain = 1) => {
        if (this.lCount >= LIGHT_CAP) return;
        _v.copy(lp).multiplyScalar(s).applyQuaternion(_q);
        const j = this.lCount++;
        this.lPos.setXYZ(j, x + _v.x, y + _v.y, z + _v.z);
        _c.setHex(hex);
        this.lCol.setXYZ(j, _c.r * gain, _c.g * gain, _c.b * gain);
        this.lSize.setX(j, lightScale(worldSize, pxMin));
      };
      const navGain = 0.25 + night * 0.9;
      if (lit || night > 0.3) {
        // navigation lights (steady): red left, green right, white tail
        if (night > 0.15 || dist < 3000) {
          addLight(pts.wingTipL, 0xff2a1a, 1.2, 2.5 * (0.5 + night), navGain);
          addLight(pts.wingTipR, 0x22ff55, 1.2, 2.5 * (0.5 + night), navGain);
          addLight(pts.tail, 0xffffff, 1.0, 2 * (0.5 + night), navGain * 0.8);
        }
      }
      if (lit) {
        // anti-collision beacon (red, ~1 Hz) whenever engines run
        const ph = (time + (i % 7) * 0.13) % 1;
        if (ph < 0.12) addLight(pts.beaconTop, 0xff1a0d, 1.6, 3.5 + 2 * night, 0.6 + night);
        else if (ph > 0.5 && ph < 0.62) addLight(pts.beaconBottom, 0xff1a0d, 1.6, 3.5 + 2 * night, 0.6 + night);
        // strobes (white double flash)
        if (p.flags & FL_STROBE) {
          const sp = (time * 0.83 + (i % 5) * 0.21) % 1;
          if (sp < 0.05 || (sp > 0.1 && sp < 0.15)) {
            addLight(pts.wingTipL, 0xffffff, 2.2, 5 + 3 * night, 0.8 + night);
            addLight(pts.wingTipR, 0xffffff, 2.2, 5 + 3 * night, 0.8 + night);
          }
        }
        // landing / taxi lights
        if (p.flags & (FL_LANDING | FL_TAXI)) {
          const land = (p.flags & FL_LANDING) !== 0;
          addLight(pts.landing, 0xfff4dc, land ? 5 : 2, (land ? 9 : 4) * (0.35 + night), (land ? 1.4 : 0.7) * (0.3 + night * 1.6));
          if (land && night > 0.3) addLight(pts.nose, 0xfff4dc, 2.5, 5, 0.9 * night);
          if (land) { _v2.copy(pts.landing).setZ(-pts.landing.z); addLight(_v2, 0xfff4dc, 5, 9 * (0.35 + night), 1.4 * (0.3 + night * 1.6)); }
        }
      }
    }
    this.flush();
  }

  private flush() {
    for (const t of this.types.values()) {
      t.mesh.count = t.count;
      if (t.count) {
        t.mesh.instanceMatrix.needsUpdate = true;
        t.mesh.instanceMatrix.clearUpdateRanges();
        t.mesh.instanceMatrix.addUpdateRange(0, t.count * 16);
        t.data.clearUpdateRanges(); t.data.addUpdateRange(0, t.count * 16); t.data.needsUpdate = true;
      }
      t.mesh.visible = t.count > 0;
    }
    this.lights.count = this.lCount;
    this.lights.visible = this.lCount > 0;
    if (this.lCount) {
      for (const [a, w] of [[this.lPos, 3], [this.lCol, 3], [this.lSize, 1]] as const) {
        a.clearUpdateRanges(); a.addUpdateRange(0, this.lCount * w); a.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const t of this.types.values()) { t.mesh.geometry.dispose(); t.mesh.removeFromParent(); }
    this.material.dispose();
    (this.lights.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}
