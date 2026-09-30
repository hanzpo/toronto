// Street furniture: instanced trees (OSM + procedural street/park trees), street
// lights (emissive at night) and traffic signal heads, for level-0 tiles within
// ~1.5 km of the camera. Placements come from the tile worker (workers/street.ts).
//
// Signals run a simple fixed-time two-phase plan off the sim clock until
// something drives them: `setSignal(junctionOsmId, armAngleRad | null, state)`
// (state 0 red · 1 yellow · 2 green) overrides a junction (or one approach);
// `clearSignals()` returns to the built-in plan.
import * as THREE from 'three/webgpu';
import {
  attribute, float, fract, uniform, vec3, vec4, cameraPosition, modelWorldMatrix, positionLocal, length, smoothstep, vertexColor,
  mix, select, abs, max, uv,
} from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import type { StreetBuf } from '../workers/street';
import { U } from '../render/uniforms';
import { baseTone } from '../render/tiles/materials';
import { useApp } from '../state/store';
import { broadleaf, conifer, mastArm, mastHead, signalPole, streetLight } from './street/geometry';

/** fraction of broadleaf trees showing autumn colour (set from the sim date) */
const FALL = uniform(0);

const RADIUS = 1500; // furniture is loaded for L0 tiles this close (m)
const NEAR_TREES = 260; // detailed tree meshes inside this distance
const LAMP_MAX = 900;

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
  // foliage (alpha ≈ 0.05): per-instance tint from the seed in ipos.w; early-autumn colours by date
  const seed = ipos.w;
  const foliage = select(vc.a.greaterThan(0.03).and(vc.a.lessThan(0.1)), float(1), float(0));
  const broad = select(vc.a.lessThan(0.065), float(1), float(0)); // conifers (0.08) never turn
  const v = fract(seed.mul(13.1)).mul(0.35).add(0.8);
  const green = vec3(fract(seed.mul(7.3)).mul(0.3).add(0.85), fract(seed.mul(3.7)).mul(0.15).add(0.95), fract(seed.mul(5.9)).mul(0.35).add(0.75)).mul(v);
  const autumn = mix(vec3(1.9, 1.15, 0.45), vec3(2.2, 0.8, 0.35), fract(seed.mul(97.0)));
  const tint = select(fract(seed.mul(31.7)).lessThan(FALL.mul(broad)), autumn, green);
  m.colorNode = baseTone(mix(vc.rgb, vc.rgb.mul(tint), foliage));
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
  geo: THREE.BufferGeometry; mat: THREE.Material; parent: THREE.Object3D; name: string; shadow: boolean;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, name: string, shadow: boolean) {
    this.geo = geo; this.mat = mat; this.parent = parent; this.name = name; this.shadow = shadow;
    this.cap = cap;
    this.entries = new Int32Array(cap);
    this.ipos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.mesh = this.make(cap);
  }
  private make(cap: number) {
    const g = this.geo.clone();
    this.ipos = new THREE.InstancedBufferAttribute(this.ipos.array.length >= cap * 4 ? this.ipos.array : grow(this.ipos.array as Float32Array, cap * 4), 4);
    this.ipos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('ipos', this.ipos);
    const m = new THREE.InstancedMesh(g, this.mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = this.shadow;
    m.receiveShadow = true;
    m.name = this.name;
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
    this.mesh.instanceMatrix.needsUpdate = true;
    this.ipos.needsUpdate = true;
    this.dirty = false;
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
  private nearTrees!: Pool;
  private nearConifers!: Pool;
  private nearAt = new THREE.Vector3(Infinity, 0, 0);
  private nearDirty = true;
  /** per signal instance: [tileKey, junction id, phase, angle] for the controller */
  private overrides = new Map<string, number>();
  private lastSig = -1;

  async init(engine: Engine) {
    this.engine = engine;
    this.group.name = 'street';
    engine.scene.add(this.group);
    const farTree = furnitureMaterial('treesFar', { near: NEAR_TREES, far: RADIUS }, null);
    const nearTree = furnitureMaterial('treesNear', { far: NEAR_TREES + 20 }, null);
    const lampMat = furnitureMaterial('lamps', { far: LAMP_MAX }, 'lamp');
    const poleMat = furnitureMaterial('signalPoles', { far: 1200 }, null);
    const sigMat = furnitureMaterial('signalHeads', { far: 1200 }, 'signal');
    const P = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string, shadow: boolean) => new Pool(geo, mat, cap, this.group, name, shadow);
    this.pools = {
      trees: P(broadleaf(1), farTree, 8192, 'treesFar', false),
      conifers: P(conifer(1), farTree, 2048, 'conifersFar', false),
      lamps: P(streetLight(), lampMat, 2048, 'streetLights', true),
      glows: P(glowDisc(), glowMaterial(), 2048, 'lampGlow', false),
      poles: P(signalPole(), sigMat, 512, 'signalPoles', true),
      masts: P(mastArm(), poleMat, 512, 'signalMasts', true),
      heads: P(mastHead(), sigMat, 512, 'signalMastHeads', true),
    };
    this.nearTrees = new Pool(broadleaf(0), nearTree, 2048, this.group, 'treesNear', true);
    this.nearConifers = new Pool(conifer(0), nearTree, 512, this.group, 'conifersNear', true);
    Object.assign(window as object, { __street: this });
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
    const layers = useApp.getState().layers as Record<string, boolean>;
    this.group.visible = layers.roads !== false;
    if (!this.group.visible) return;
    const cam = ctx.cameraPos;
    const E = cam.x, Nn = -cam.z;
    if (this.anchorVer !== ctx.anchor.version) {
      this.anchorVer = ctx.anchor.version;
      const o = ctx.anchor.origin;
      for (const p of [...Object.values(this.pools), this.nearTrees, this.nearConifers]) p.mesh.position.set(o.x, 0, o.z);
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
    // near-tree LOD set
    if (this.nearDirty || Math.hypot(cam.x - this.nearAt.x, cam.z - this.nearAt.z) > 25 || Math.abs(cam.y - this.nearAt.y) > 40) this.rebuildNear(cam);
    FALL.value = this.fall(ctx.simMs);
    this.signals(ctx);
    for (const p of [...Object.values(this.pools), this.nearTrees, this.nearConifers]) p.flush();
  }

  private add(key: string, e0: number, n0: number, data: StreetBuf) {
    const rec: TileRec = { key, e0, n0, data, owners: new Map() };
    const nT = data.trees.length / 6;
    let broad = 0;
    for (let i = 0; i < nT; i++) if (data.trees[i * 6 + 4] !== 1) broad++;
    const own = (p: Pool, n: number) => { if (!n) return; const o: Owner = { key, slots: new Int32Array(0) }; o.slots = p.alloc(o, n); rec.owners.set(p, o); };
    own(this.pools.trees, broad);
    own(this.pools.conifers, nT - broad);
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
    p.dirty = true;
  }

  /** fraction of trees in autumn colour for the sim date (late Sep → Nov) */
  private fall(simMs: number) {
    const d = new Date(simMs);
    const doy = d.getUTCMonth() * 30.5 + d.getUTCDate();
    return doy < 262 ? 0 : doy < 305 ? ((doy - 262) / 43) ** 1.5 * 0.65 : doy < 330 ? 0.65 : 0;
  }

  private write(rec: TileRec) {
    const o = this.engine.anchor.origin;
    const ox = rec.e0 - o.x, on = rec.n0 + o.z; // anchor-relative (origin.z = -N)
    const d = rec.data;
    const tr = rec.owners.get(this.pools.trees), co = rec.owners.get(this.pools.conifers);
    let bi = 0, ci = 0;
    for (let i = 0; i < d.trees.length / 6; i++) {
      const x = d.trees[i * 6], y = d.trees[i * 6 + 1], z = d.trees[i * 6 + 2], s = d.trees[i * 6 + 3], k = d.trees[i * 6 + 4], seed = d.trees[i * 6 + 5];
      const conif = k === 1;
      if (conif && co) this.put(this.pools.conifers, co.slots[ci++], ox + x, z, -(on + y), seed * 6.28, s, s * (0.9 + seed * 0.3), s, seed);
      else if (!conif && tr) this.put(this.pools.trees, tr.slots[bi++], ox + x, z, -(on + y), seed * 6.28, s, s * (0.85 + seed * 0.35), s, seed);
    }
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
    const pools = [this.nearTrees, this.nearConifers];
    for (const p of pools) p.clear();
    const R = NEAR_TREES + 60;
    const E = cam.x, Nn = -cam.z;
    const dummy: Owner = { key: 'near', slots: new Int32Array(0) };
    const add = (p: Pool, x: number, y: number, z: number, a: number, sx: number, sy: number, seed: number) => {
      p.ensure(p.count + 1);
      const k = p.count++;
      p.owners[k] = dummy;
      p.mesh.count = p.count;
      this.put(p, k, x, y, z, a, sx, sy, sx, seed);
    };
    for (const rec of this.tiles.values()) {
      if (E < rec.e0 - R || E > rec.e0 + 1024 + R || Nn < rec.n0 - R || Nn > rec.n0 + 1024 + R) continue;
      const d = rec.data.trees;
      for (let i = 0; i < d.length / 6; i++) {
        const e = rec.e0 + d[i * 6], n = rec.n0 + d[i * 6 + 1];
        if (Math.abs(e - E) > R || Math.abs(n - Nn) > R || Math.hypot(e - E, n - Nn, d[i * 6 + 2] - cam.y) > R) continue;
        const s = d[i * 6 + 3], seed = d[i * 6 + 5], conif = d[i * 6 + 4] === 1;
        add(conif ? this.nearConifers : this.nearTrees, e - o.x, d[i * 6 + 2], -n - o.z, seed * 6.28, s, s * (conif ? 0.9 + seed * 0.3 : 0.85 + seed * 0.35), seed);
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
    poles.ipos.needsUpdate = true;
    heads.ipos.needsUpdate = true;
  }

  dispose() {
    for (const p of [...Object.values(this.pools), this.nearTrees, this.nearConifers]) p.dispose();
    this.group.removeFromParent();
  }
}
