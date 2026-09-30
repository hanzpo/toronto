// Street furniture: street lights (emissive at night) and traffic signal heads,
// for level-0 tiles within ~1.5 km of the camera, plus the vegetation system
// (layers/vegetation: trees, shrubs, hedges to the horizon). Placements come
// from the tile worker (workers/street.ts, workers/vegetation.ts).
//
// Signals run a simple fixed-time two-phase plan off the sim clock until
// something drives them: `setSignal(junctionOsmId, armAngleRad | null, state)`
// (state 0 red · 1 yellow · 2 green) overrides a junction (or one approach);
// `clearSignals()` returns to the built-in plan.
import * as THREE from 'three/webgpu';
import {
  attribute, float, vec3, vec4, cameraPosition, modelWorldMatrix, positionLocal, length, smoothstep, vertexColor,
  mix, select, abs, max, uv,
} from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import type { StreetBuf } from '../workers/street';
import { U } from '../render/uniforms';
import { baseTone } from '../render/tiles/materials';
import { useApp } from '../state/store';
import { mastArm, mastHead, signalPole, streetLight } from './street/geometry';
import { Vegetation } from './vegetation/Vegetation';

const RADIUS = 1500; // furniture is loaded for L0 tiles this close (m)
const LAMP_MAX = 900;
/** lamps / signal hardware cast shadows through shadow-only proxies within this range */
const NEAR_SHADOW = 320;
/** object layer rendered only by the sun's shadow camera (see Atmosphere) */
export const SHADOW_ONLY_LAYER = 1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** material: linear vertex colours × instance colour; alpha codes emissive parts; distance window culling */
function furnitureMaterial(name: string, win: { near?: number; far: number }, emissive: 'lamp' | 'signal' | null) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = name;
  const ipos = attribute('ipos', 'vec4');
  // collapse instances outside [near, far] to their origin (smoothly shrinking)
  const center = ipos.xyz;
  const d = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(center, 1)).xyz));
  let k: N = float(1).sub(smoothstep(win.far * 0.85, win.far, d));
  if (win.near) k = k.mul(smoothstep(win.near * 0.92, win.near, d));
  m.positionNode = center.add(positionLocal.sub(center).mul(k));
  const vc = vertexColor();
  m.colorNode = baseTone(vc.rgb);
  if (emissive === 'lamp') {
    const lit = select(vc.a.greaterThan(0.9), float(1), float(0));
    (m as unknown as { emissiveNode: N }).emissiveNode = vec3(1.0, 0.82, 0.55).mul(lit.mul(U.night).mul(3));
  } else if (emissive === 'signal') {
    // lens tag 0.2 red · 0.4 yellow · 0.6 green; state 0/1/2 in ipos.w
    const state = ipos.w;
    const tag = vc.a;
    const isLens = select(tag.greaterThan(0.1), float(1), float(0));
    const idx = tag.mul(5).sub(1); // 0 red, 1 yellow, 2 green
    const on = select(abs(idx.sub(state)).lessThan(0.5), float(1), float(0)).mul(isLens);
    const hue = select(idx.lessThan(0.5), vec3(1, 0.1, 0.05), select(idx.lessThan(1.5), vec3(1, 0.55, 0.05), vec3(0.1, 1, 0.55)));
    (m as unknown as { emissiveNode: N }).emissiveNode = hue.mul(on).mul(max(U.night.mul(4), 1.6));
    m.colorNode = baseTone(mix(vc.rgb, hue.mul(0.12), isLens));
  }
  return m;
}

// ---------------------------------------------------------------------------- instance pool

interface Owner { key: string; slots: Int32Array }

class Pool {
  mesh: THREE.InstancedMesh;
  cap: number;
  count = 0;
  ipos: THREE.InstancedBufferAttribute;
  owners: (Owner | null)[] = [];
  entries: Int32Array;
  dirty = false;
  /** slot range written since the last flush (uploads only that range) */
  lo = Infinity;
  hi = -1;
  mark(s: number) { if (s < this.lo) this.lo = s; if (s > this.hi) this.hi = s; this.dirty = true; }
  geo: THREE.BufferGeometry; mat: THREE.Material; parent: THREE.Object3D; name: string; shadow: boolean; shadowOnly: boolean;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, name: string, shadow: boolean, shadowOnly = false) {
    this.geo = geo; this.mat = mat; this.parent = parent; this.name = name; this.shadow = shadow; this.shadowOnly = shadowOnly;
    this.cap = cap;
    this.entries = new Int32Array(cap);
    this.ipos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.mesh = this.make(cap);
  }
  private make(cap: number) {
    const g = this.geo.clone();
    this.ipos = new THREE.InstancedBufferAttribute(this.ipos.array.length >= cap * 4 ? this.ipos.array : grow(this.ipos.array as Float32Array, cap * 4), 4);
    g.setAttribute('ipos', this.ipos);
    const m = new THREE.InstancedMesh(g, this.mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = this.shadow;
    m.receiveShadow = !this.shadowOnly;
    m.name = this.name;
    if (this.shadowOnly) m.layers.set(SHADOW_ONLY_LAYER);
    this.parent.add(m);
    return m;
  }
  ensure(n: number) {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    const old = this.mesh;
    const m = this.make(cap);
    (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    m.position.copy(old.position);
    m.count = this.count;
    m.visible = old.visible;
    this.parent.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.mesh = m;
    const e = new Int32Array(cap); e.set(this.entries); this.entries = e;
    this.cap = cap;
  }
  alloc(owner: Owner, n: number): Int32Array {
    this.ensure(this.count + n);
    const s = new Int32Array(n);
    for (let j = 0; j < n; j++) { const k = this.count++; s[j] = k; this.owners[k] = owner; this.entries[k] = j; }
    this.mesh.count = this.count;
    this.dirty = true;
    return s;
  }
  free(owner: Owner) {
    const mA = this.mesh.instanceMatrix.array as Float32Array, pA = this.ipos.array as Float32Array;
    for (let j = 0; j < owner.slots.length; j++) {
      const s = owner.slots[j], last = this.count - 1;
      if (s !== last) {
        mA.copyWithin(s * 16, last * 16, last * 16 + 16);
        pA.copyWithin(s * 4, last * 4, last * 4 + 4);
        this.mark(s);
        const o = this.owners[last]!, e = this.entries[last];
        o.slots[e] = s; this.owners[s] = o; this.entries[s] = e;
      }
      this.owners[last] = null;
      this.count--;
    }
    this.mesh.count = this.count;
    this.dirty = true;
  }
  clear() { this.count = 0; this.mesh.count = 0; this.owners.length = 0; this.dirty = true; }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.hi < this.lo) return;
    const lo = this.lo, n = Math.min(this.hi, this.cap - 1) - lo + 1;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(lo * 16, n * 16); im.needsUpdate = true;
    this.ipos.clearUpdateRanges(); this.ipos.addUpdateRange(lo * 4, n * 4); this.ipos.needsUpdate = true;
    this.lo = Infinity; this.hi = -1;
  }
  dispose() { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.dispose(); }
}

function grow(a: Float32Array, n: number) { const b = new Float32Array(n); b.set(a); return b; }

// ---------------------------------------------------------------------------- layer

interface TileRec {
  key: string; e0: number; n0: number; data: StreetBuf;
  owners: Map<Pool, Owner>;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);


/** unit disc (radius 1) on the ground for night-time lamp light pools */
function glowDisc(): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  g.deleteAttribute('normal');
  return g;
}

function glowMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.name = 'lampGlow';
  const ipos = attribute('ipos', 'vec4');
  const center = ipos.xyz;
  const d = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(center, 1)).xyz));
  const k = float(1).sub(smoothstep(LAMP_MAX * 0.85, LAMP_MAX, d)).mul(select(U.night.greaterThan(0.02), float(1), float(0)));
  // lift toward the camera a little so the pool never hides under the road surface
  const lp = center.add(positionLocal.sub(center).mul(k));
  const wp = modelWorldMatrix.mul(vec4(lp, 1)).xyz;
  const toCam = cameraPosition.sub(wp);
  m.positionNode = lp.add(toCam.normalize().mul(0.4));
  const r = uv().sub(0.5).length().mul(2);
  const fall = float(1).sub(smoothstep(0, 1, r)).pow(2);
  m.colorNode = vec3(1.0, 0.72, 0.4).mul(fall.mul(U.night).mul(0.22));
  m.opacityNode = float(1);
  return m;
}

export class StreetLayer implements Layer {
  readonly id = 'street';
  private engine!: Engine;
  private group = new THREE.Group();
  private tiles = new Map<string, TileRec>();
  private anchorVer = -1;
  private pools: Record<string, Pool> = {};
  /** trees, shrubs, hedges (own group: not tied to the roads toggle) */
  private veg!: Vegetation;
  /** shadow-only copies of the lamps / signal hardware near the camera (ring 0) */
  private shadowProxies: Record<'lamps' | 'poles' | 'masts' | 'heads', Pool> | null = null;
  private nearAt = new THREE.Vector3(Infinity, 0, 0);
  private nearDirty = true;
  /** per signal instance: [tileKey, junction id, phase, angle] for the controller */
  private overrides = new Map<string, number>();
  private lastSig = -1;

  async init(engine: Engine) {
    this.engine = engine;
    this.group.name = 'street';
    engine.scene.add(this.group);
    const lampMat = furnitureMaterial('lamps', { far: LAMP_MAX }, 'lamp');
    const poleMat = furnitureMaterial('signalPoles', { far: 1200 }, null);
    const sigMat = furnitureMaterial('signalHeads', { far: 1200 }, 'signal');
    const P = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string, shadow: boolean) => new Pool(geo, mat, cap, this.group, name, shadow);
    this.pools = {
      lamps: P(streetLight(), lampMat, 2048, 'streetLights', false),
      glows: P(glowDisc(), glowMaterial(), 2048, 'lampGlow', false),
      poles: P(signalPole(), sigMat, 512, 'signalPoles', false),
      masts: P(mastArm(), poleMat, 512, 'signalMasts', false),
      heads: P(mastHead(), sigMat, 512, 'signalMastHeads', false),
    };
    const S = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string) => new Pool(geo, mat, 128, this.group, name, true, true);
    this.shadowProxies = {
      lamps: S(streetLight(), lampMat, 'streetLightsShadow'),
      poles: S(signalPole(), sigMat, 'signalPolesShadow'),
      masts: S(mastArm(), poleMat, 'signalMastsShadow'),
      heads: S(mastHead(), sigMat, 'signalMastHeadsShadow'),
    };
    this.veg = new Vegetation(engine);
    void this.veg.prewarm();
    Object.assign(window as object, { __street: this });
  }

  private allPools(): Pool[] {
    return [...Object.values(this.pools), ...Object.values(this.shadowProxies ?? {})];
  }

  // ------------------------------------------------------------------ signal API

  /** Override a signal (state 0 red · 1 yellow · 2 green). armAngle (rad, CCW from +E, pointing away from the junction) selects one approach; null = all. */
  setSignal(junctionOsmId: number, armAngle: number | null, state: 0 | 1 | 2) {
    this.overrides.set(armAngle === null ? `${junctionOsmId}` : `${junctionOsmId}:${Math.round(((armAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) * 10)}`, state);
    this.lastSig = -1;
  }

  clearSignals() { this.overrides.clear(); this.lastSig = -1; }

  /** all signal approaches currently shown: junction OSM id, arm angle, world E/N */
  listSignals() {
    const out: { junction: number; armAngle: number; e: number; n: number }[] = [];
    for (const t of this.tiles.values()) {
      const s = t.data.signals;
      for (let i = 0; i < s.length / 7; i++) out.push({ junction: t.data.signalIds[s[i * 7 + 4]], armAngle: s[i * 7 + 3], e: t.e0 + s[i * 7], n: t.n0 + s[i * 7 + 1] });
    }
    return out;
  }

  // ------------------------------------------------------------------ per frame

  update(ctx: FrameContext) {
    const eng = this.engine;
    this.veg.update(ctx);
    const layers = useApp.getState().layers as Record<string, boolean>;
    this.group.visible = layers.roads !== false;
    if (!this.group.visible) return;
    const cam = ctx.cameraPos;
    const E = cam.x, Nn = -cam.z;
    if (this.anchorVer !== ctx.anchor.version) {
      this.anchorVer = ctx.anchor.version;
      const o = ctx.anchor.origin;
      for (const p of this.allPools()) p.mesh.position.set(o.x, 0, o.z);
      for (const t of this.tiles.values()) this.write(t);
      this.nearDirty = true;
    }
    // wanted tiles: drawn level-0 tiles within RADIUS (+hysteresis for ones we have)
    const want = new Set<string>();
    const hi = ctx.altitude > 2500;
    if (!hi) {
      for (const t of eng.tiles.drawn) {
        if (t.L !== 0 || !t.street) continue;
        const dx = Math.max(0, Math.abs(E - (t.tx + 0.5) * t.S) - t.S / 2), dy = Math.max(0, Math.abs(Nn - (t.ty + 0.5) * t.S) - t.S / 2);
        const d = Math.hypot(dx, dy, Math.max(0, ctx.altitude - 50));
        if (d < RADIUS + (this.tiles.has(t.key) ? 200 : 0)) want.add(t.key);
      }
    }
    for (const [k, rec] of this.tiles) if (!want.has(k)) this.remove(rec);
    for (const t of eng.tiles.drawn) {
      if (want.has(t.key) && !this.tiles.has(t.key) && t.street) this.add(t.key, t.tx * t.S, t.ty * t.S, t.street);
    }
    // near shadow proxies
    if (this.nearDirty || Math.hypot(cam.x - this.nearAt.x, cam.z - this.nearAt.z) > 25 || Math.abs(cam.y - this.nearAt.y) > 40) this.rebuildNear(cam);
    this.signals(ctx);
    for (const p of this.allPools()) p.flush();
  }

  private add(key: string, e0: number, n0: number, data: StreetBuf) {
    const rec: TileRec = { key, e0, n0, data, owners: new Map() };
    const own = (p: Pool, n: number) => { if (!n) return; const o: Owner = { key, slots: new Int32Array(0) }; o.slots = p.alloc(o, n); rec.owners.set(p, o); };
    own(this.pools.lamps, data.lamps.length / 5);
    own(this.pools.glows, data.lamps.length / 5);
    const nS = data.signals.length / 7;
    own(this.pools.poles, nS); own(this.pools.masts, nS); own(this.pools.heads, nS);
    this.tiles.set(key, rec);
    this.write(rec);
    this.nearDirty = true;
    this.lastSig = -1;
  }

  private remove(rec: TileRec) {
    for (const [p, o] of rec.owners) p.free(o);
    this.tiles.delete(rec.key);
    this.nearDirty = true;
    this.lastSig = -1;
  }

  private put(p: Pool, slot: number, x: number, y: number, z: number, ang: number, sx: number, sy: number, sz: number, w = 0) {
    _p.set(x, y, z);
    _q.setFromAxisAngle(_up, ang);
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    _m.toArray(p.mesh.instanceMatrix.array as Float32Array, slot * 16);
    const ip = p.ipos.array as Float32Array;
    ip[slot * 4] = x; ip[slot * 4 + 1] = y; ip[slot * 4 + 2] = z; ip[slot * 4 + 3] = w;
    p.mark(slot);
  }

  private write(rec: TileRec) {
    const o = this.engine.anchor.origin;
    const ox = rec.e0 - o.x, on = rec.n0 + o.z; // anchor-relative (origin.z = -N)
    const d = rec.data;
    const la = rec.owners.get(this.pools.lamps);
    if (la) for (let i = 0; i < d.lamps.length / 5; i++) {
      const x = d.lamps[i * 5], y = d.lamps[i * 5 + 1], z = d.lamps[i * 5 + 2], a = d.lamps[i * 5 + 3], h = d.lamps[i * 5 + 4];
      this.put(this.pools.lamps, la.slots[i], ox + x, z, -(on + y), a, 1, h / 8.5, 1);
    }
    const gl = rec.owners.get(this.pools.glows);
    if (gl) for (let i = 0; i < d.lamps.length / 5; i++) {
      const x = d.lamps[i * 5], y = d.lamps[i * 5 + 1], z = d.lamps[i * 5 + 2], a = d.lamps[i * 5 + 3], h = d.lamps[i * 5 + 4];
      // light pool centred under the lamp head (2.1 m out along the arm)
      const r = h * 1.15;
      this.put(this.pools.glows, gl.slots[i], ox + x + Math.cos(a) * 2.1, z + 0.45, -(on + y + Math.sin(a) * 2.1), 0, r, 1, r);
    }
    const po = rec.owners.get(this.pools.poles), ma = rec.owners.get(this.pools.masts), he = rec.owners.get(this.pools.heads);
    if (po && ma && he) for (let i = 0; i < d.signals.length / 7; i++) {
      const x = d.signals[i * 7], y = d.signals[i * 7 + 1], z = d.signals[i * 7 + 2], a = d.signals[i * 7 + 3], L = d.signals[i * 7 + 6];
      const X = ox + x, Z = -(on + y);
      this.put(this.pools.poles, po.slots[i], X, z, Z, a, 1, 1, 1);
      this.put(this.pools.masts, ma.slots[i], X, z, Z, a, 1, 1, L);
      // mast end: local +z maps to world (sin a, -cos a) in E,N
      const hx = X + Math.sin(a) * L, hz = Z + Math.cos(a) * L;
      this.put(this.pools.heads, he.slots[i], hx, z, hz, a, 1, 1, 1);
    }
  }

  private rebuildNear(cam: THREE.Vector3) {
    this.nearAt.copy(cam);
    this.nearDirty = false;
    const o = this.engine.anchor.origin;
    const pools = Object.values(this.shadowProxies ?? {});
    for (const p of pools) p.clear();
    const E = cam.x, Nn = -cam.z;
    const dummy: Owner = { key: 'near', slots: new Int32Array(0) };
    // shadow proxies for lamps and signal hardware in ring 0 (the far pools cast none)
    const sp = this.shadowProxies;
    if (!sp) return;
    const RS = NEAR_SHADOW;
    const put = (p: Pool, x: number, y: number, z: number, a: number, sx: number, sy: number, sz: number) => {
      p.ensure(p.count + 1);
      const k = p.count++;
      p.owners[k] = dummy;
      p.mesh.count = p.count;
      this.put(p, k, x, y, z, a, sx, sy, sz, 0);
    };
    for (const rec of this.tiles.values()) {
      if (E < rec.e0 - RS || E > rec.e0 + 1024 + RS || Nn < rec.n0 - RS || Nn > rec.n0 + 1024 + RS) continue;
      const ox = rec.e0 - o.x, on = rec.n0 + o.z;
      const la = rec.data.lamps;
      for (let i = 0; i < la.length / 5; i++) {
        const x = la[i * 5], y = la[i * 5 + 1];
        if (Math.hypot(rec.e0 + x - E, rec.n0 + y - Nn) > RS) continue;
        put(sp.lamps, ox + x, la[i * 5 + 2], -(on + y), la[i * 5 + 3], 1, la[i * 5 + 4] / 8.5, 1);
      }
      const sg = rec.data.signals;
      for (let i = 0; i < sg.length / 7; i++) {
        const x = sg[i * 7], y = sg[i * 7 + 1], z = sg[i * 7 + 2], a = sg[i * 7 + 3], L = sg[i * 7 + 6];
        if (Math.hypot(rec.e0 + x - E, rec.n0 + y - Nn) > RS) continue;
        const X = ox + x, Z = -(on + y);
        put(sp.poles, X, z, Z, a, 1, 1, 1);
        put(sp.masts, X, z, Z, a, 1, 1, L);
        put(sp.heads, X + Math.sin(a) * L, z, Z + Math.cos(a) * L, a, 1, 1, 1);
      }
    }
  }

  private signals(ctx: FrameContext) {
    // fixed-time plan: 30 s green, 4 s amber, 2 s all-red per phase (72 s cycle), offset per junction
    const t = ctx.simMs / 1000;
    const q = Math.floor(t * 4);
    if (q === this.lastSig) return;
    this.lastSig = q;
    const poles = this.pools.poles, heads = this.pools.heads;
    const A = poles.ipos.array as Float32Array, B = heads.ipos.array as Float32Array;
    for (const rec of this.tiles.values()) {
      const po = rec.owners.get(poles), he = rec.owners.get(heads);
      if (!po || !he) continue;
      const s = rec.data.signals;
      for (let i = 0; i < s.length / 7; i++) {
        const id = rec.data.signalIds[s[i * 7 + 4]];
        const phase = s[i * 7 + 5];
        const ang = s[i * 7 + 3];
        let st = this.overrides.get(`${id}:${Math.round((((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 10)}`) ?? this.overrides.get(`${id}`);
        if (st === undefined) {
          const off = (Math.abs(id) % 72);
          const c = (t + off) % 72;
          const local = phase ? (c + 36) % 72 : c;
          st = local < 30 ? 2 : local < 34 ? 1 : 0;
        }
        A[po.slots[i] * 4 + 3] = st; B[he.slots[i] * 4 + 3] = st;
      }
    }
    // signal states live in ipos.w of every slot: upload the whole (small) range at flush
    if (poles.count) { poles.mark(0); poles.mark(poles.count - 1); }
    if (heads.count) { heads.mark(0); heads.mark(heads.count - 1); }
  }

  dispose() {
    this.veg.dispose();
    for (const p of this.allPools()) p.dispose();
    this.group.removeFromParent();
  }
}
