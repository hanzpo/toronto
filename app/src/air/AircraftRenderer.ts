// Instanced aircraft rendering: two instanced meshes per aircraft type (detailed
// + far LOD) sharing one lit node material, plus additive sprite lights (nav,
// strobes, beacon, landing / taxi).
//
// Material (see models/aircraftBuilder.ts for the vertex attributes):
//  • vertex stage: rigid per-vertex motion from the `anim` attribute — gear legs
//    fold into their wells, bay doors open / close, flaps + slats deploy,
//    ground spoilers rise, propellers spin — driven by per-instance values
//  • fragment stage: livery paint on the fuselage (belly split, cheatline,
//    rear wrap), procedural cabin windows + door outlines from a per-type decal
//    row (aircraftDecalTexture), tail art from the Canvas atlas, glass fresnel,
//    lit cabin windows at night.
// Per-instance data: one interleaved buffer of 9 vec4 (WebGPU: ≤ 8 vertex
// buffers per draw — geometry uses 5, + this one; 14 of 16 vertex attributes):
//   i0 fuse.rgb, gear   i1 tail.rgb, far   i2 belly.rgb, flaps   i3 accent.rgb, prop angle
//   i4 engine.rgb, spoiler   i5 stripe.rgb, art + 256·lit   i6 bellyLine, cheatY, cheatW, wrap code
//   i7 position (anchor-relative) + scale   i8 rotation quaternion
// Positions are anchor-relative (floating origin); far aircraft are scaled up
// to a minimum on-screen size so they stay visible from the regional view.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, vec2, vec3, vec4, float, mix, positionGeometry, normalLocal, instancedBufferAttribute, uv, smoothstep,
  length, max, min, abs, floor, sign, cos, sin, step, fract, texture, fwidth, clamp, dot, normalView, positionViewDirection, pow, cross,
  normalGeometry,
} from 'three/tsl';
import type { FrameContext } from '../engine/types';
import { aircraftModel, aircraftDecalTexture, PART, ANIM, TYPE_CODES, type AircraftModel } from '../models/aircraft';
import { liveryOf, tailArtTexture, ART_CELLS } from './liveries';
import { U } from '../render/uniforms';
import { FL_GEAR, FL_LANDING, FL_STROBE, FL_TAXI, PH } from './track';
import type { AirPlane } from './AirSystem';

const CAP = 200;
const LIGHT_CAP = 6000;
const STRIDE = 36;
const NVEC = 9;
/** gear cycle time (sim seconds) */
const GEAR_T = 9;

// TSL node (loosely typed: the generic node typings fight arithmetic chains)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

interface Lod {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  data: THREE.InstancedInterleavedBuffer;
  count: number;
}
interface TypeMesh {
  model: AircraftModel;
  hi: Lod;
  lo: Lod;
  /** an instance is within shadow range this frame */
  near: boolean;
}

export interface DrawnPlane { idx: number; e: number; n: number; h: number; yaw: number; pitch: number; len: number; scale: number }

const _q = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0, 'YZX');
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * rotate v about z by az, then about x by ax. Written from scalar components of
 * the input (nesting two vec3 joins and swizzling the inner one miscompiled).
 */
function rotZX(v: N, az: N, ax: N): N {
  const c1 = cos(az), s1 = sin(az), c2 = cos(ax), s2 = sin(ax);
  const x1 = v.x.mul(c1).sub(v.y.mul(s1));
  const y1 = v.x.mul(s1).add(v.y.mul(c1));
  const z1 = v.z;
  return vec3(x1, y1.mul(c2).sub(z1.mul(s2)), y1.mul(s2).add(z1.mul(c2)));
}

export function aircraftMaterial(): THREE.MeshStandardNodeMaterial {
  const col = attribute('color', 'vec3');
  const surf = attribute('surf', 'vec4');
  const anim = attribute('anim', 'vec4');
  const i0 = attribute('i0', 'vec4'), i1 = attribute('i1', 'vec4'), i2 = attribute('i2', 'vec4'), i3 = attribute('i3', 'vec4');
  const i4 = attribute('i4', 'vec4'), i5 = attribute('i5', 'vec4'), i6 = attribute('i6', 'vec4');
  // instance transform: position (anchor-relative) + uniform scale, rotation quaternion
  const iPos = attribute('i7', 'vec4'), iRot = attribute('i8', 'vec4');
  const qrot = (v: N): N => v.add(cross(iRot.xyz, cross(iRot.xyz, v).add(v.mul(iRot.w))).mul(2));
  const gear = i0.w, far = i1.w, flaps = i2.w, prop = i3.w, spoil = i4.w;
  const code = surf.x;
  const row = floor(code.div(8).add(0.01));
  const part = code.sub(row.mul(8));
  const is = (k: number) => float(1).sub(step(0.5, abs(part.sub(k))));

  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.12 });
  m.name = 'aircraft';

  // ---------------------------------------------------------------- vertex motion
  // (instancing is done here, not by InstancedMesh: NodeMaterial applies the
  // instance matrix *before* positionNode, which would break model-space pivots)
  m.positionNode = Fn(() => {
    const kind = anim.w;
    const piv = anim.xyz;
    const p = positionGeometry;
    const k = (n: number) => float(1).sub(step(0.5, abs(kind.sub(n))));
    const up = float(1).sub(gear);
    const openT = clamp(min(gear, up).mul(6), 0, 1);
    const openD = smoothstep(0.0, 0.25, gear);
    const rel = p.sub(piv);
    const az = k(ANIM.NOSE_GEAR).mul(up).mul(1.62)
      .add(k(ANIM.MAIN_FWD).mul(up).mul(1.57))
      .sub(k(ANIM.MAIN_AFT).mul(up).mul(1.57))
      .add(k(ANIM.FLAP).mul(flaps).mul(0.56))
      .sub(k(ANIM.SLAT).mul(flaps).mul(0.38))
      .sub(k(ANIM.SPOILER).mul(spoil).mul(0.87));
    const ax = k(ANIM.MAIN_IN).mul(up).mul(1.57).mul(sign(piv.z))
      .add(k(ANIM.DOOR_TRANSIT).mul(openT).mul(1.45).mul(sign(rel.z)))
      .add(k(ANIM.DOOR_DOWN).mul(openD).mul(1.45).mul(sign(rel.z)))
      .add(k(ANIM.PROP).mul(prop));
    const r1 = rotZX(rel, az, ax);
    // stowed gear collapses onto its pivot (hidden in the well)
    const isGear = k(ANIM.NOSE_GEAR).add(k(ANIM.MAIN_IN)).add(k(ANIM.MAIN_FWD)).add(k(ANIM.MAIN_AFT));
    const hide = isGear.mul(step(gear, 0.015));
    const local = piv.add(r1.mul(float(1).sub(hide)));
    normalLocal.assign(qrot(rotZX(normalGeometry, az, ax)));
    return qrot(local.mul(iPos.w)).add(iPos.xyz);
  })();

  // ---------------------------------------------------------------- paint
  const decal = aircraftDecalTexture();
  const art = tailArtTexture();
  const rows = TYPE_CODES.length * 2;
  let winMask: N = float(0);
  {
    const fuse = i0.xyz, tail = i1.xyz, belly = i2.xyz, accent = i3.xyz, engine = i4.xyz, stripe = i5.xyz;
    const bellyLine = i6.x, cheatY = i6.y, cheatW = i6.z, wrapCode = i6.w;
    // ---- fuselage
    const dy = surf.y, u = surf.z, vn = surf.w;
    const aav = fwidth(vn).mul(0.8).add(0.004);
    let c: N = mix(fuse, belly, smoothstep(bellyLine.add(aav), bellyLine.sub(aav), vn));
    const cheat = float(1).sub(smoothstep(cheatW.sub(aav), cheatW.add(aav), abs(vn.sub(cheatY)))).mul(step(0.001, cheatW)).mul(step(0.1, u));
    c = mix(c, stripe, cheat);
    const wcode = floor(wrapCode.div(10));
    const wrapU = wrapCode.sub(wcode.mul(10));
    const band = fract(wcode.mul(0.5)).mul(2); // bit 0
    const rev = step(1.5, wcode); // bit 1
    const slope = mix(float(0.1), float(-0.06), rev);
    const edge = u.sub(wrapU.sub(slope.mul(vn.sub(0.3))));
    const aau = fwidth(u).mul(0.8).add(0.0005);
    const wrapM = smoothstep(aau.negate(), aau, edge).mul(step(wrapU, 5));
    c = mix(c, stripe, wrapM);
    const bandM = smoothstep(aau.negate(), aau, edge.add(0.035)).mul(float(1).sub(wrapM)).mul(band).mul(step(0.1, vn.negate().add(1)));
    c = mix(c, tail, bandM.mul(step(wrapU, 5)));
    // windows + doors
    const v0 = row.mul(2).add(0.5).div(rows), v1 = row.mul(2).add(1.5).div(rows);
    const pat = texture(decal, vec2(u, v0));
    const par = texture(decal, vec2(0.5, v1));
    const halfW = par.x.mul(0.5), halfH = par.y.mul(0.5), pitch = par.z, cargoH = par.w.mul(4);
    const dx = float(1).sub(pat.x).mul(pitch).mul(0.5);
    const rad = halfW.mul(0.95);
    const qx = dx.sub(halfW.sub(rad)), qy = abs(dy).sub(halfH.sub(rad));
    const sd = length(max(vec2(qx, qy), 0)).add(min(max(qx, qy), 0)).sub(rad);
    const fp = fwidth(dy).add(0.002);
    const hasWin = step(0.004, pat.x);
    let win: N = float(1).sub(smoothstep(fp.negate(), fp, sd)).mul(hasWin);
    // far: fade to the average window-band coverage
    const avg = step(abs(dy), halfH).mul(halfW.mul(2).div(pitch)).mul(0.8).mul(hasWin);
    win = mix(win, avg, smoothstep(halfW.mul(0.4), halfW.mul(2.5), fp));
    const dk = floor(pat.z.mul(8).add(0.5));
    const z = positionGeometry.z;
    const isK = (n: number) => float(1).sub(step(0.5, abs(dk.sub(n))));
    const lo = isK(1).mul(-1.05).add(isK(2).mul(-0.4)).add(isK(3).mul(cargoH.negate().sub(1.25))).add(isK(4).mul(-1.1));
    const hi = isK(1).mul(0.85).add(isK(2).mul(0.6)).add(isK(3).mul(-1.25)).add(isK(4).mul(1.7));
    const sideOk = float(1).sub(isK(3).mul(step(z, 0))).sub(isK(4).mul(step(0, z)));
    const dyIn = min(dy.sub(lo), hi.sub(dy));
    const dxIn = pat.y.mul(0.6);
    const dd = min(dxIn, dyIn);
    const inside = step(0, dyIn).mul(step(0.002, pat.y)).mul(step(0.5, dk)).mul(sideOk);
    const line = inside.mul(float(1).sub(smoothstep(0.025, fp.add(0.03), dd)));
    const doorFade = float(1).sub(smoothstep(0.03, 0.12, fp));
    c = mix(c, c.mul(0.5), line.mul(doorFade));
    c = mix(c, vec3(0.035, 0.045, 0.06), win);
    const fus = c;
    // ---- tail fin with art
    const artIdx = i5.w.sub(step(255.5, i5.w).mul(256));
    const cell = vec2(artIdx.sub(floor(artIdx.div(ART_CELLS)).mul(ART_CELLS)), floor(artIdx.div(ART_CELLS)));
    const au = clamp(surf.y, 0.01, 0.99), av = clamp(surf.z, 0.01, 0.99);
    const tuv = vec2(cell.x.add(au).div(ART_CELLS), float(1).sub(cell.y.add(1).sub(av).div(ART_CELLS)));
    const ta = texture(art, tuv);
    const hasArt = step(-0.5, artIdx);
    const fin = mix(tail, ta.xyz, ta.w.mul(hasArt));
    // ---- assemble by part
    let out: N = col;
    out = mix(out, fus, is(PART.FUSE));
    out = mix(out, fin, is(PART.TAIL));
    out = mix(out, belly.mul(0.3).add(fuse.mul(0.7)), is(PART.BELLY).mul(step(bellyLine, -0.5)));
    out = mix(out, belly, is(PART.BELLY).mul(step(-0.5, bellyLine)));
    out = mix(out, accent, is(PART.ACCENT));
    out = mix(out, engine, is(PART.ENGINE));
    // far icons: dark on the day map
    const farDay = vec3(0.02, 0.035, 0.08);
    m.colorNode = vec4(mix(out, farDay, far.mul(float(1).sub(U.analytics))), 1);
    winMask = win.mul(is(PART.FUSE));
  }

  // glass: cockpit (part GLASS) + cabin windows
  const glassM = is(PART.GLASS);
  m.roughnessNode = mix(float(0.3), float(0.08), glassM).sub(is(PART.GEAR).mul(-0.2));
  m.metalnessNode = mix(float(0.1), float(0.0), glassM).add(is(PART.FIXED).mul(0.15));
  {
    const farAn = vec3(0.45, 0.62, 1.0);
    const lit = step(255.5, i5.w);
    // cabin windows glow at night (recomputed cheaply: dark window colour = window mask)
    const c = attribute('color', 'vec3');
    const f = pow(float(1).sub(clamp(dot(normalView, positionViewDirection), 0, 1)), 3);
    const sky = mix(U.skyHorizon, U.skyZenith, 0.35);
    const glass = sky.mul(glassM).mul(f.mul(0.4).add(0.04)).mul(float(1).sub(U.night.mul(0.85)));
    // fin logo lights + faint apron glow keep liveries readable at night
    const logo = is(PART.TAIL).mul(lit).mul(U.night).mul(0.18);
    const cabin = vec3(1.0, 0.78, 0.5).mul(winMask).mul(U.night).mul(lit.mul(0.6).add(0.15));
    m.emissiveNode = farAn.mul(far).mul(U.analytics).mul(0.9)
      .add(glass)
      .add(cabin)
      .add(i1.xyz.mul(logo))
      .add(c.mul(U.night).mul(0.05));
  }
  return m;
}

export interface InstanceState { gear: number; far: number; flaps: number; prop: number; spoiler: number; lit: boolean }

interface GearState { g: number; t: number; seen: number; air: number }

export class AircraftRenderer {
  readonly root = new THREE.Group();
  private material: THREE.MeshStandardNodeMaterial;
  private types = new Map<string, TypeMesh>();
  private lights: THREE.Sprite;
  private lPos: THREE.InstancedBufferAttribute;
  private lCol: THREE.InstancedBufferAttribute;
  private lSize: THREE.InstancedBufferAttribute;
  private lCount = 0;
  private gear = new Map<string, GearState>();
  private frame = 0;
  /** planes drawn last frame (for picking), index into the AirSystem planes array */
  drawn: DrawnPlane[] = [];
  minPixels = 15;
  groundMinPixels = 3;
  /** projected length (px) below which the far LOD is used */
  lodPixels = 90;

  constructor() {
    this.root.name = 'air';
    this.material = aircraftMaterial();

    // lights: additive camera-facing sprites
    this.lPos = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP * 3), 3);
    this.lCol = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP * 3), 3);
    this.lSize = new THREE.InstancedBufferAttribute(new Float32Array(LIGHT_CAP), 1);
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

  private lod(g: THREE.BufferGeometry, name: string): Lod {
    const geo = new THREE.InstancedBufferGeometry();
    for (const [k, a] of Object.entries(g.attributes)) geo.setAttribute(k, a);
    geo.setIndex(g.index);
    geo.instanceCount = 0;
    const data = new THREE.InstancedInterleavedBuffer(new Float32Array(CAP * STRIDE), STRIDE);
    data.setUsage(THREE.DynamicDrawUsage);
    for (let k = 0; k < NVEC; k++) geo.setAttribute(`i${k}`, new THREE.InterleavedBufferAttribute(data, 4, k * 4));
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    this.root.add(mesh);
    return { mesh, geo, data, count: 0 };
  }

  private typeMesh(code: string): TypeMesh {
    let t = this.types.get(code);
    if (t) return t;
    const model = aircraftModel(code);
    t = { model, hi: this.lod(model.geometry, `aircraft-${code}`), lo: this.lod(model.low, `aircraft-${code}-far`), near: false };
    this.types.set(code, t);
    return t;
  }

  /** smoothed gear extension from the (binary) gear flag, in sim time */
  private gearOf(key: string, flagDown: boolean, phase: number, simS: number): number {
    let s = this.gear.get(key);
    // departures: positive rate of climb → gear up ~3 s after liftoff (the track only drops the
    // gear flag at 250 m AGL); arrivals keep the track's flag (down below ~800 m AGL)
    const climbing = phase === PH.CLIMB || phase === PH.CRUISE;
    if (s && climbing && s.air < 0) s.air = simS;
    if (s && !climbing) s.air = -1;
    const down = climbing && s ? flagDown && simS - s.air < 3 : flagDown;
    const target = down ? 1 : 0;
    if (!s) { s = { g: target, t: simS, seen: this.frame, air: climbing ? simS - 60 : -1 }; this.gear.set(key, s); return target; }
    const dt = simS - s.t;
    s.t = simS; s.seen = this.frame;
    if (dt < 0 || dt > GEAR_T * 1.5) s.g = target; // scrub / jump: snap
    else s.g += Math.sign(target - s.g) * Math.min(Math.abs(target - s.g), dt / GEAR_T);
    return s.g;
  }

  /**
   * Write one instance. `st` = animation state (gear, flaps, spoiler, prop angle).
   * Public so the model gallery can drive the same path.
   */
  writeInstance(lod: Lod, k: number, pos: THREE.Vector3, q: THREE.Quaternion, scale: number, airline: string, st: InstanceState) {
    const liv = liveryOf(airline);
    const arr = lod.data.array as Float32Array;
    const o = k * STRIDE;
    const set = (j: number, hexv: number, w: number) => { _c.setHex(hexv); arr[o + j * 4] = _c.r; arr[o + j * 4 + 1] = _c.g; arr[o + j * 4 + 2] = _c.b; arr[o + j * 4 + 3] = w; };
    set(0, liv.fuse, st.gear);
    set(1, liv.tail, st.far);
    set(2, liv.belly, st.flaps);
    set(3, liv.accent, st.prop);
    set(4, liv.engine, st.spoiler);
    set(5, liv.stripe, liv.art + (st.lit ? 256 : 0));
    arr[o + 24] = liv.bellyLine;
    arr[o + 25] = liv.cheatY;
    arr[o + 26] = liv.cheatW;
    arr[o + 27] = liv.wrap > 1.5 ? 9 : liv.wrap + 10 * ((liv.wrapBand ? 1 : 0) + (liv.wrapRev ? 2 : 0));
    arr[o + 28] = pos.x; arr[o + 29] = pos.y; arr[o + 30] = pos.z; arr[o + 31] = scale;
    arr[o + 32] = q.x; arr[o + 33] = q.y; arr[o + 34] = q.z; arr[o + 35] = q.w;
  }

  /** gallery / debug: place a static instance (returns a handle for restate()) */
  addStatic(code: string, airline: string, matrix: THREE.Matrix4, st: InstanceState, low = false) {
    const t = this.typeMesh(code);
    const lod = low ? t.lo : t.hi;
    const k = lod.count++;
    t.near = true;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    matrix.decompose(pos, q, sc);
    this.writeInstance(lod, k, pos, q, sc.x, airline, st);
    this.flush();
    return { lod, k, pos, q, scale: sc.x, airline, model: t.model };
  }

  restate(h: ReturnType<AircraftRenderer['addStatic']>, st: InstanceState) {
    this.writeInstance(h.lod, h.k, h.pos, h.q, h.scale, h.airline, st);
    h.lod.data.needsUpdate = true;
  }

  /** write instances for planes[0..count) */
  update(ctx: FrameContext, planes: AirPlane[], count: number, visible: boolean, selectedKey: string | null) {
    const anchor = ctx.anchor.origin;
    this.root.position.copy(anchor);
    this.frame++;
    for (const t of this.types.values()) { t.hi.count = 0; t.lo.count = 0; t.near = false; }
    this.lCount = 0;
    this.drawn.length = 0;
    this.root.visible = visible;
    if (!visible) { this.flush(); return; }
    const cam = ctx.cameraPos;
    const night = 1 - ctx.daylight;
    const time = ctx.time;
    const simS = ctx.simMs / 1000;
    const realS = performance.now() / 1000;
    for (let i = 0; i < count; i++) {
      const pl = planes[i];
      const t = this.typeMesh(pl.type);
      const p = pl.pose;
      const x = p.e - anchor.x, y = p.h, z = -p.n - anchor.z;
      const dist = Math.hypot(p.e - cam.x, p.h - cam.y, -p.n - cam.z);
      const spec = t.model.spec;
      const L = spec.length;
      const onGround = p.phase < 5 || p.phase >= 10;
      const minPx = pl.key === selectedKey ? 16 : pl.kind === 'park' ? 0 : onGround ? this.groundMinPixels : this.minPixels;
      const s = Math.max(1, (minPx * dist) / (ctx.pixelScale * L));
      const gear = this.gearOf(pl.key, (p.flags & FL_GEAR) !== 0, p.phase, simS);
      // off-screen: no instance, no lights (the landing-light glow sprites are ~10 m)
      if (!ctx.view.sphere(p.e, p.h, -p.n, L * s * 0.6 + 12)) continue;
      const px = (ctx.pixelScale * L * s) / Math.max(1, dist);
      const lod = px >= this.lodPixels && s < 1.5 ? t.hi : t.lo;
      if (lod.count >= CAP) continue;
      const k = lod.count++;
      // only aircraft near the camera can land in the (≤ 1.8 km) shadow map
      if (dist < 2500) t.near = true;
      _eul.set(p.bank, p.yaw, p.pitch, 'YZX');
      _q.setFromEuler(_eul);
      _p.set(x, y, z);
      // high-lift + ground spoilers + props from phase and speed
      const ph = p.phase;
      let flaps = 0;
      if (ph === PH.TAXI_OUT || ph === PH.HOLD || ph === PH.TAKEOFF) flaps = 0.4;
      else if (ph === PH.CLIMB) flaps = 0.4 * clamp01((spec.vr + 45 - p.v) / 30);
      else if (ph === PH.APPROACH || ph === PH.LANDING) flaps = clamp01((spec.vref + 55 - p.v) / 45);
      else if (ph === PH.ROLLOUT) flaps = 1;
      const spoiler = ph === PH.ROLLOUT && p.v > 18 ? 1 : 0;
      const running = pl.kind !== 'park' && ph >= PH.TAXI_OUT;
      const prop = running ? (realS * 2.3 * Math.PI * 2 + i * 1.7) % (Math.PI * 2) : (i * 0.37) % 1;
      this.writeInstance(lod, k, _p, _q, s, pl.airline, {
        gear, far: 0.45 * smooth01((s - 2.5) / 5) * 2, flaps, prop, spoiler, lit: pl.kind !== 'park',
      });
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
        // anti-collision beacons (red, alternating top / bottom ~1 Hz) whenever engines run
        const bph = (time + (i % 7) * 0.13) % 1;
        if (bph < 0.12) addLight(pts.beaconTop, 0xff1a0d, 1.6, 3.5 + 2 * night, 0.6 + night);
        else if (bph > 0.5 && bph < 0.62) addLight(pts.beaconBottom, 0xff1a0d, 1.6, 3.5 + 2 * night, 0.6 + night);
        // strobes (white double flash on the wing tips, single on the tail cone)
        if (p.flags & FL_STROBE) {
          const sp = (time * 0.83 + (i % 5) * 0.21) % 1;
          if (sp < 0.05 || (sp > 0.1 && sp < 0.15)) {
            addLight(pts.wingTipL, 0xffffff, 2.2, 5 + 3 * night, 0.8 + night);
            addLight(pts.wingTipR, 0xffffff, 2.2, 5 + 3 * night, 0.8 + night);
            if (sp < 0.05) addLight(pts.tail, 0xffffff, 1.8, 4 + 2 * night, 0.7 + night);
          }
        }
        // landing lights (wing roots / turboprop nacelles) + nose-gear taxi light (only while the gear is down)
        if (p.flags & (FL_LANDING | FL_TAXI)) {
          const land = (p.flags & FL_LANDING) !== 0;
          if (land) {
            addLight(pts.landing, 0xfff4dc, 5, 9 * (0.35 + night), 1.4 * (0.3 + night * 1.6));
            _v2.copy(pts.landing).setZ(-pts.landing.z);
            addLight(_v2, 0xfff4dc, 5, 9 * (0.35 + night), 1.4 * (0.3 + night * 1.6));
          }
          if (gear > 0.9) addLight(pts.taxi, 0xfff4dc, land ? 3.5 : 2.5, (land ? 6 : 4) * (0.35 + night), (land ? 1.0 : 0.8) * (0.3 + night * 1.4));
        }
      }
    }
    // forget gear state of aircraft not seen for a while
    if (this.frame % 300 === 0) for (const [k, g] of this.gear) if (this.frame - g.seen > 600) this.gear.delete(k);
    this.flush();
  }

  private flushLod(l: Lod) {
    l.geo.instanceCount = l.count;
    if (l.count) {
      l.data.clearUpdateRanges(); l.data.addUpdateRange(0, l.count * STRIDE); l.data.needsUpdate = true;
    }
    l.mesh.visible = l.count > 0;
  }

  private flush() {
    for (const t of this.types.values()) {
      this.flushLod(t.hi); this.flushLod(t.lo);
      t.hi.mesh.castShadow = t.near;
      t.lo.mesh.castShadow = false;
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
    for (const t of this.types.values()) for (const l of [t.hi, t.lo]) { l.mesh.geometry.dispose(); l.mesh.removeFromParent(); }
    this.material.dispose();
    (this.lights.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}
