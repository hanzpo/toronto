// Street props and parking lots (placements from workers/props.ts) plus TTC
// stop poles and shelters from the live transit feed. Level-0 tiles within
// ~700 m of the camera; one instanced draw per prop kind; small props collapse
// beyond their own range in the vertex shader. Static parked cars: 30-triangle
// stand-ins for the whole range, full models (shadow casters) within ~110 m.
import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, vec4, cameraPosition, modelWorldMatrix, positionLocal, positionGeometry, length, smoothstep, vertexColor,
  mix, select, uv, texture, floor, mod, fract, sin, pow, clamp, dot, normalView, positionViewDirection, step,
} from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { U } from '../render/uniforms';
import { baseTone } from '../render/tiles/materials';
import { useApp } from '../state/store';
import type { PropsBuf } from '../workers/props';
import { K, PSTRIDE } from '../workers/props';
import * as G from './props/geometry';
import { LOT_TYPES, lotOccupancy } from './parkingOcc';
import { clock } from '../state/clock';
import { CAR_VARIANTS, carLowGeometries, carPalette } from './traffic/models';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const RADIUS = 700;
const NEAR_CARS = 110;
const STOP_R = 380;

// ---------------------------------------------------------------------------- materials

/** instance window: collapse instances outside [near, far] to their origin */
function windowed(win: { near?: number; far: number }) {
  const ipos = attribute('ipos', 'vec4');
  const d = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(ipos.xyz, 1)).xyz));
  let k: N = float(1).sub(smoothstep(win.far * 0.85, win.far, d));
  if (win.near) k = k.mul(smoothstep(win.near * 0.92, win.near, d));
  return { ipos, pos: ipos.xyz.add(positionLocal.sub(ipos.xyz).mul(k)) };
}

function propMaterial(name: string, win: { near?: number; far: number }) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = name;
  const { ipos, pos } = windowed(win);
  m.positionNode = pos;
  const vc = vertexColor();
  const tag = vc.a;
  const variant = ipos.w;
  const tint = select(variant.lessThan(0.5), vec3(0.05, 0.2, 0.55), select(variant.lessThan(1.5), vec3(0.08, 0.35, 0.1), vec3(0.12, 0.12, 0.12)));
  const isTint = step(0.25, tag).mul(step(tag, 0.35));
  m.colorNode = baseTone(mix(vc.rgb, tint, isTint));
  const lamp = step(0.95, tag);
  const panel = step(0.55, tag).mul(step(tag, 0.65));
  (m as unknown as { emissiveNode: N }).emissiveNode = vec3(1.0, 0.9, 0.72).mul(lamp.mul(U.night).mul(3))
    .add(vc.rgb.mul(panel).mul(U.night.mul(1.4).add(0.08)));
  return m;
}

/** draped ground paint (lot asphalt, stripes, islands, driveways): vertex colour + grain, pulled toward the camera to win over the terrain */
function groundMaterial() {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = 'lotsAndDriveways';
  const wp = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  const toCam = cameraPosition.sub(wp);
  const d = length(toCam);
  m.positionNode = positionLocal.add(toCam.div(d).mul(d.mul(0.0022).add(0.05).min(d.mul(0.5))));
  const vc = vertexColor();
  const wpos = vec2(wp.x, wp.z);
  const n1 = fract(sin(floor(wpos.x.div(0.6)).mul(12.9898).add(floor(wpos.y.div(0.6)).mul(78.233))).mul(43758.5453));
  const n2 = fract(sin(floor(wpos.x.div(4.7)).mul(12.9898).add(floor(wpos.y.div(4.7)).mul(78.233))).mul(43758.5453));
  const c = pow(vec3(vc.r, vc.g, vc.b), vec3(2.2)).mul(n1.mul(0.1).add(0.95)).mul(n2.mul(0.14).add(0.93));
  m.colorNode = baseTone(c);
  return m;
}

/** street-name blades: green face with the name from the canvas atlas */
function bladeMaterial(atlas: THREE.Texture) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = 'streetBlades';
  const { ipos, pos } = windowed({ far: 260 });
  m.positionNode = pos;
  const vc = vertexColor();
  const slot = ipos.w;
  const col = mod(slot, ATLAS_COLS), row = floor(slot.div(ATLAS_COLS));
  const u = uv();
  const auv = vec2(col.add(u.x).div(ATLAS_COLS), float(1).sub(row.add(1).div(ATLAS_ROWS)).add(u.y.div(ATLAS_ROWS)));
  const face = step(0.75, vc.a).mul(step(0, slot));
  const tex = texture(atlas, auv).rgb;
  m.colorNode = baseTone(mix(vc.rgb, tex, face));
  // retro-reflective sheeting reads bright in headlights / street light at night
  (m as unknown as { emissiveNode: N }).emissiveNode = tex.mul(face).mul(U.night.mul(0.25));
  return m;
}

/** parked cars: model vertex colour × body paint, glass reflection */
function carMaterial(win: { near?: number; far: number }) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = 'parkedCars';
  const { pos } = windowed(win);
  m.positionNode = pos;
  const vc = attribute('color', 'vec3');
  const lg = attribute('lg', 'vec2');
  const paint = attribute('icol', 'vec3');
  m.colorNode = baseTone(vc.mul(mix(vec3(1, 1, 1), paint, lg.x)));
  const f = pow(float(1).sub(clamp(dot(normalView, positionViewDirection), 0, 1)), 3);
  (m as unknown as { emissiveNode: N }).emissiveNode = mix(vec3(U.skyHorizon as N), vec3(U.skyZenith as N), 0.35).mul(lg.y).mul(f.mul(0.3).add(0.03)).mul(float(1).sub(U.night.mul(0.85)));
  void positionGeometry;
  return m;
}

function packCar(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  const n = g.attributes.position.count;
  c.setAttribute('position', g.attributes.position);
  c.setAttribute('normal', g.attributes.normal);
  c.setAttribute('color', g.attributes.color);
  const lg = new Float32Array(n * 2);
  const liv = (g.attributes.livery ?? g.attributes.tint) as THREE.BufferAttribute | undefined, gl = g.attributes.glass as THREE.BufferAttribute | undefined;
  for (let i = 0; i < n; i++) { lg[i * 2] = liv ? liv.getX(i) : 0; lg[i * 2 + 1] = gl ? gl.getX(i) : 0; }
  c.setAttribute('lg', new THREE.BufferAttribute(lg, 2));
  if (g.index) c.setIndex(g.index);
  return c;
}

// ---------------------------------------------------------------------------- name atlas

const ATLAS_COLS = 6, ATLAS_ROWS = 16, SLOT_W = 320, SLOT_H = 64;

class NameAtlas {
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  slots = new Map<string, number>();
  constructor() {
    this.canvas.width = ATLAS_COLS * SLOT_W; this.canvas.height = ATLAS_ROWS * SLOT_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.fillStyle = '#0f6b3d';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
  }
  get full() { return this.slots.size >= ATLAS_COLS * ATLAS_ROWS; }
  reset() { this.slots.clear(); }
  slot(name: string): number {
    let s = this.slots.get(name);
    if (s !== undefined) return s;
    if (this.full) return -1;
    s = this.slots.size;
    this.slots.set(name, s);
    const x = (s % ATLAS_COLS) * SLOT_W, y = Math.floor(s / ATLAS_COLS) * SLOT_H, c = this.ctx;
    c.fillStyle = '#0f6b3d'; c.fillRect(x, y, SLOT_W, SLOT_H);
    c.strokeStyle = '#f4f4f0'; c.lineWidth = 3; c.strokeRect(x + 4, y + 4, SLOT_W - 8, SLOT_H - 8);
    c.fillStyle = '#f7f7f2';
    c.font = 'bold 38px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const w = c.measureText(name).width, max = SLOT_W - 26;
    c.save();
    c.translate(x + SLOT_W / 2, y + SLOT_H / 2 + 2);
    if (w > max) c.scale(max / w, 1);
    c.fillText(name, 0, 0);
    c.restore();
    this.tex.needsUpdate = true;
    return s;
  }
}

// ---------------------------------------------------------------------------- pool

interface Owner { slots: Int32Array }

class Pool {
  mesh: THREE.InstancedMesh;
  cap: number;
  count = 0;
  ipos!: THREE.InstancedBufferAttribute;
  icol: THREE.InstancedBufferAttribute | null = null;
  owners: (Owner | null)[] = [];
  entries: Int32Array;
  lo = Infinity; hi = -1;
  geo: THREE.BufferGeometry; mat: THREE.Material; parent: THREE.Object3D; name: string; shadow: boolean; withColor: boolean;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, name: string, shadow = false, withColor = false) {
    this.geo = geo; this.mat = mat; this.parent = parent; this.name = name; this.shadow = shadow; this.withColor = withColor;
    this.cap = cap;
    this.entries = new Int32Array(cap);
    this.mesh = this.make(cap);
  }
  mark(s: number) { if (s < this.lo) this.lo = s; if (s > this.hi) this.hi = s; }
  private make(cap: number) {
    const g = this.geo.clone();
    const old = this.ipos?.array as Float32Array | undefined, oldC = this.icol?.array as Float32Array | undefined;
    this.ipos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    if (old) (this.ipos.array as Float32Array).set(old.subarray(0, Math.min(old.length, cap * 4)));
    g.setAttribute('ipos', this.ipos);
    if (this.withColor) {
      this.icol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      if (oldC) (this.icol.array as Float32Array).set(oldC.subarray(0, Math.min(oldC.length, cap * 3)));
      g.setAttribute('icol', this.icol);
    }
    const m = new THREE.InstancedMesh(g, this.mat, cap);
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
    this.parent.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.mesh = m;
    const e = new Int32Array(cap); e.set(this.entries); this.entries = e;
    this.cap = cap;
    this.lo = 0; this.hi = this.count - 1;
  }
  alloc(owner: Owner, n: number): Int32Array {
    this.ensure(this.count + n);
    const s = new Int32Array(n);
    for (let j = 0; j < n; j++) { const k = this.count++; s[j] = k; this.owners[k] = owner; this.entries[k] = j; }
    this.mesh.count = this.count;
    return s;
  }
  free(owner: Owner) {
    const mA = this.mesh.instanceMatrix.array as Float32Array, pA = this.ipos.array as Float32Array, cA = this.icol?.array as Float32Array | undefined;
    for (let j = 0; j < owner.slots.length; j++) {
      const s = owner.slots[j], last = this.count - 1;
      if (s !== last) {
        mA.copyWithin(s * 16, last * 16, last * 16 + 16);
        pA.copyWithin(s * 4, last * 4, last * 4 + 4);
        if (cA) cA.copyWithin(s * 3, last * 3, last * 3 + 3);
        this.mark(s);
        const o = this.owners[last]!, e = this.entries[last];
        o.slots[e] = s; this.owners[s] = o; this.entries[s] = e;
      }
      this.owners[last] = null;
      this.count--;
    }
    this.mesh.count = this.count;
  }
  clear() { this.count = 0; this.mesh.count = 0; this.owners.length = 0; }
  flush() {
    if (this.hi < this.lo) return;
    const lo = this.lo, n = Math.min(this.hi, this.cap - 1) - lo + 1;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(lo * 16, n * 16); im.needsUpdate = true;
    this.ipos.clearUpdateRanges(); this.ipos.addUpdateRange(lo * 4, n * 4); this.ipos.needsUpdate = true;
    if (this.icol) { this.icol.clearUpdateRanges(); this.icol.addUpdateRange(lo * 3, n * 3); this.icol.needsUpdate = true; }
    this.lo = Infinity; this.hi = -1;
  }
  dispose() { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.dispose(); }
}

// ---------------------------------------------------------------------------- layer

type PoolKey = 'hydrant' | 'bin' | 'news' | 'postbox' | 'bench' | 'ring' | 'pay' | 'planter' | 'bladePole' | 'blade' | 'hydro' | 'hydroT' | 'wire'
  | 'hwy' | 'houseBin' | 'lotLight' | 'carFar' | 'dock' | 'dockBike' | 'terminal';

interface TileRec { key: string; e0: number; n0: number; data: PropsBuf; bladeSlots: Int16Array; ground: THREE.Mesh | null }

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

interface StopSource { system?: { tripCount: number; stops(o?: { modes?: string[] }): { index: Int32Array; x: Float64Array; y: Float64Array; z: Float32Array; mode: Uint8Array } } }

export class PropsLayer implements Layer {
  readonly id = 'props';
  private engine!: Engine;
  private group = new THREE.Group();
  private tiles = new Map<string, TileRec>();
  private anchorVer = -1;
  private pools = {} as Record<PoolKey, Pool>;
  private carNear: Pool[] = [];
  private stopPoles!: Pool;
  private stopShelters!: Pool;
  private atlas!: NameAtlas;
  private groundMat!: THREE.Material;
  /** CPU range per pool (m); matches the shader fade window of its material */
  private range = new Map<Pool, number>();
  private nearAt = new THREE.Vector3(Infinity, 0, 0);
  /** parked-car occupancy per lot type (parkingOcc.ts), refreshed ~1 Hz; a change re-picks the cars */
  private lotOcc = new Float32Array(LOT_TYPES).fill(-1);
  private lotOccAt = 0;
  private nearDirty = true;
  private stopsAt = new THREE.Vector3(Infinity, 0, 0);
  /** TTC stop poles / shelters placed around the camera (world E/N boxes, for walker collisions) */
  readonly stopSolids: { e: number; n: number; h: number; hl: number; hw: number }[] = [];
  private stops: { x: Float64Array; y: Float64Array; mode: Uint8Array; n: number; trips: number } | null = null;
  private stopGrid = new Map<number, number[]>();

  async init(engine: Engine) {
    this.engine = engine;
    this.group.name = 'props';
    engine.scene.add(this.group);
    this.atlas = new NameAtlas();
    this.groundMat = groundMaterial();
    const g = this.group;
    const P = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string, shadow = false, col = false) => new Pool(geo, mat, cap, g, name, shadow, col);
    const R_SMALL = 220, R_MID = 400, R_TALL = 650, R_SIGN = 1800;
    const small = propMaterial('propsSmall', { far: R_SMALL });
    const mid = propMaterial('propsMid', { far: R_MID });
    const tall = propMaterial('propsTall', { far: R_TALL });
    const signs = propMaterial('propsSigns', { far: R_SIGN });
    const mats = new Map<THREE.Material, number>([[small, R_SMALL], [mid, R_MID], [tall, R_TALL], [signs, R_SIGN]]);
    const carLo = carLowGeometries();
    this.pools = {
      hydrant: P(G.hydrant(), small, 512, 'hydrants'),
      bin: P(G.litterBin(), small, 256, 'litterBins'),
      news: P(G.newsBoxes(), small, 128, 'newsBoxes'),
      postbox: P(G.postBox(), small, 128, 'postBoxes'),
      bench: P(G.bench(), small, 128, 'benches'),
      ring: P(G.bikeRing(), small, 512, 'bikeRings'),
      pay: P(G.payStation(), small, 128, 'payStations'),
      planter: P(G.planter(), mid, 128, 'planters'),
      bladePole: P(G.bladePole(), mid, 256, 'bladePoles'),
      blade: P(G.blade(), bladeMaterial(this.atlas.tex), 128, 'streetBlades'),
      hydro: P(G.hydroPole(false), tall, 512, 'hydroPoles'),
      hydroT: P(G.hydroPole(true), tall, 128, 'hydroPolesTx'),
      wire: P(G.wireSpan(), tall, 512, 'hydroWires'),
      hwy: P(G.highwaySign(), signs, 32, 'highwaySigns'),
      houseBin: P(G.houseBin(), small, 256, 'houseBins'),
      lotLight: P(G.lotLight(), tall, 128, 'lotLights'),
      carFar: P(packCar(carLo[0]), carMaterial({ near: NEAR_CARS, far: 620 }), 1024, 'parkedCarsFar', false, true),
      dock: P(G.bikeDock(false, false), small, 128, 'bikeDocks'),
      dockBike: P(G.bikeDock(false, true), small, 256, 'bikeDocksBike'),
      terminal: P(G.bikeDock(true, false), small, 32, 'bikeTerminals'),
    };
    const nearMat = carMaterial({ far: NEAR_CARS + 10 });
    for (const k of ['sedan', 'hatchback', 'suv', 'minivan']) {
      const v = CAR_VARIANTS.find((x) => x.key === k) ?? CAR_VARIANTS[0];
      this.carNear.push(P(packCar(v.geometry()), nearMat, 128, `parkedCars-${k}`, true, true));
    }
    for (const p of Object.values(this.pools)) this.range.set(p, mats.get(p.mat) ?? 300);
    this.range.set(this.pools.blade, 250);
    this.range.set(this.pools.carFar, 620);
    for (const p of this.carNear) this.range.set(p, NEAR_CARS);
    this.stopPoles = P(G.busPole(), mid, 128, 'ttcStopPoles');
    this.stopShelters = P(G.shelter(), mid, 64, 'ttcShelters', true);
    Object.assign(window as object, { __props: this });
  }

  private allPools(): Pool[] {
    return [...Object.values(this.pools), ...this.carNear, this.stopPoles, this.stopShelters];
  }

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
      for (const p of this.allPools()) p.mesh.position.set(o.x, 0, o.z);
      this.nearDirty = true;
      this.stopsAt.set(Infinity, 0, 0);
    }
    const want = new Set<string>();
    if (ctx.altitude < 900) {
      for (const t of eng.tiles.drawn) {
        if (t.L !== 0 || !t.props) continue;
        const dx = Math.max(0, Math.abs(E - (t.tx + 0.5) * t.S) - t.S / 2), dy = Math.max(0, Math.abs(Nn - (t.ty + 0.5) * t.S) - t.S / 2);
        const d = Math.hypot(dx, dy, Math.max(0, ctx.altitude - 50));
        if (d < RADIUS + (this.tiles.has(t.key) ? 150 : 0)) want.add(t.key);
      }
    }
    for (const [k, rec] of this.tiles) if (!want.has(k)) this.remove(rec);
    for (const t of eng.tiles.drawn) if (want.has(t.key) && !this.tiles.has(t.key) && t.props) this.add(t.key, t.tx * t.S, t.ty * t.S, t.props);
    if (performance.now() - this.lotOccAt > 1000) {
      this.lotOccAt = performance.now();
      const p = clock.parts(), o = lotOccupancy(p.secOfDay, p.weekday, new Float32Array(LOT_TYPES));
      if (o.some((v, i) => Math.abs(v - this.lotOcc[i]) > 0.01)) { this.lotOcc.set(o); this.nearDirty = true; }
    }
    if (this.nearDirty || Math.hypot(cam.x - this.nearAt.x, cam.z - this.nearAt.z) > 20 || Math.abs(cam.y - this.nearAt.y) > 30) this.rebuild(cam);
    if (Math.hypot(cam.x - this.stopsAt.x, cam.z - this.stopsAt.z) > 40 || (ctx.frame % 120 === 0 && !this.stops)) this.rebuildStops(cam, ctx.altitude);
    for (const p of this.allPools()) p.flush();
  }

  // ------------------------------------------------------------------ tiles

  private poolFor(k: number, p0: number, p1: number): Pool | null {
    const P = this.pools;
    switch (k) {
      case K.HYDRANT: return P.hydrant; case K.BIN: return P.bin; case K.NEWS: return P.news; case K.POSTBOX: return P.postbox;
      case K.BENCH: return P.bench; case K.BIKERING: return P.ring; case K.PAYSTATION: return P.pay; case K.PLANTER: return P.planter;
      case K.BLADE: return P.bladePole; case K.HYDRO: return p0 ? P.hydroT : P.hydro; case K.WIRE: return P.wire;
      case K.HWYSIGN: return P.hwy; case K.HOUSEBIN: return P.houseBin;
      case K.LOTLIGHT: return P.lotLight; case K.CAR: return P.carFar;
      case K.BIKESHARE: return p0 ? P.terminal : p1 ? P.dockBike : P.dock;
      default: return null;
    }
  }

  private add(key: string, e0: number, n0: number, data: PropsBuf) {
    const rec: TileRec = { key, e0, n0, data, bladeSlots: new Int16Array(data.names.length), ground: null };
    if (data.ground) {
      const m = data.ground, g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
      g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(m.normal, 4), 3, 0, true));
      g.setAttribute('color', new THREE.BufferAttribute(m.color!, 4, true));
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.groundMat);
      mesh.name = 'lotsAndDriveways';
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      mesh.position.set(e0, 0, -n0); // world placement, like the tile groups
      rec.ground = mesh;
      this.group.add(mesh);
    }
    this.assignNames(rec);
    this.tiles.set(key, rec);
    this.nearDirty = true;
  }

  private assignNames(rec: TileRec) {
    for (let i = 0; i < rec.data.names.length; i++) {
      let s = this.atlas.slot(rec.data.names[i]);
      if (s < 0) {
        // atlas full: start over with the names of the tiles in range
        this.atlas.reset();
        for (const t of this.tiles.values()) if (t !== rec) for (let j = 0; j < t.data.names.length; j++) t.bladeSlots[j] = this.atlas.slot(t.data.names[j]);
        s = this.atlas.slot(rec.data.names[i]);
        this.nearDirty = true;
      }
      rec.bladeSlots[i] = s;
    }
  }

  private remove(rec: TileRec) {
    if (rec.ground) { this.group.remove(rec.ground); rec.ground.geometry.dispose(); }
    this.tiles.delete(rec.key);
    this.nearDirty = true;
  }

  private put(p: Pool, slot: number, x: number, y: number, z: number, ang: number, sx: number, sy: number, sz: number, w = 0) {
    _p.set(x, y, z);
    _q.setFromAxisAngle(_up, ang);
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    _m.toArray(p.mesh.instanceMatrix.array as Float32Array, slot * 16);
    const ip = p.ipos.array as Float32Array;
    ip[slot * 4] = x; ip[slot * 4 + 1] = y; ip[slot * 4 + 2] = z; ip[slot * 4 + 3] = w;
  }

  private append(p: Pool): number {
    p.ensure(p.count + 1);
    const s = p.count++;
    p.mesh.count = p.count;
    return s;
  }

  /**
   * Refill every prop pool with the instances inside its own range (props are
   * only uploaded near the camera, so counts scale with range², not tile area).
   */
  private rebuild(cam: THREE.Vector3) {
    this.nearAt.copy(cam);
    this.nearDirty = false;
    const pools = [...Object.values(this.pools), ...this.carNear];
    for (const p of pools) p.clear();
    const o = this.engine.anchor.origin;
    const E = cam.x, Nn = -cam.z, H = cam.y;
    const RMAX = 1900;
    for (const rec of this.tiles.values()) {
      if (E < rec.e0 - RMAX || E > rec.e0 + 1024 + RMAX || Nn < rec.n0 - RMAX || Nn > rec.n0 + 1024 + RMAX) continue;
      const ox = rec.e0 - o.x, on = rec.n0 + o.z;
      const it = rec.data.items, n = it.length / PSTRIDE;
      for (let i = 0; i < n; i++) {
        const b = i * PSTRIDE;
        const k = it[b], x = it[b + 1], y = it[b + 2], z = it[b + 3], a = it[b + 4], sx = it[b + 5], p0 = it[b + 6], p1 = it[b + 7];
        let e = rec.e0 + x, nn = rec.n0 + y;
        if (k === K.WIRE) { e += Math.cos(a) * sx / 2; nn += Math.sin(a) * sx / 2; }
        const dx = e - E, dy = nn - Nn;
        if (Math.abs(dx) > RMAX || Math.abs(dy) > RMAX) continue;
        const d = Math.hypot(dx, dy, z - H);
        let p: Pool | null;
        if (k === K.CAR) {
          // sx = 2 + 2·lot type + rank (workers/props.ts carTag): parked only while rank < occupancy
          if (sx >= 2) { const ty = Math.floor((sx - 2) / 2); if (sx - 2 - 2 * ty >= (this.lotOcc[ty] ?? 1)) continue; }
          p = d < NEAR_CARS ? this.carNear[(p0 | 0) % this.carNear.length] : this.pools.carFar;
        }
        else p = this.poolFor(k, p0, p1);
        if (!p || d > (this.range.get(p) ?? 300)) continue;
        const X = ox + x, Z = -(on + y);
        const s = this.append(p);
        switch (k) {
          case K.WIRE: {
            // sheared transform: unit span along x from this pole to the next (base elevation z, rise p0)
            const L = sx, dz = p0, ca = Math.cos(a), sa = Math.sin(a);
            _m.set(L * ca, 0, sa, X, dz, 1, 0, z, -L * sa, 0, ca, Z, 0, 0, 0, 1);
            _m.toArray(p.mesh.instanceMatrix.array as Float32Array, s * 16);
            const ip = p.ipos.array as Float32Array;
            ip[s * 4] = X + L * ca / 2; ip[s * 4 + 1] = z + 10; ip[s * 4 + 2] = Z - L * sa / 2; ip[s * 4 + 3] = 0;
            break;
          }
          case K.BLADE: {
            this.put(p, s, X, z, Z, a, 1, 1, 1);
            const bl = this.pools.blade;
            const n1 = p0 >= 0 ? rec.bladeSlots[p0] : -1, n2 = p1 >= 0 ? rec.bladeSlots[p1] : -1;
            const s1 = this.append(bl), s2 = this.append(bl);
            this.put(bl, s1, X, z + 3.15, Z, a, 1, 1, 1, n1);
            this.put(bl, s2, X, z + 3.42, Z, a + sx, 1, 1, 1, n2);
            // window test from the pole foot, like the pole
            (bl.ipos.array as Float32Array)[s1 * 4 + 1] = z; (bl.ipos.array as Float32Array)[s2 * 4 + 1] = z;
            break;
          }
          case K.CAR: {
            this.put(p, s, X, z, Z, a, 1, 1, 1, p0);
            const c = carPalette[(p1 | 0) % carPalette.length], ca = p.icol!.array as Float32Array;
            ca[s * 3] = c.r; ca[s * 3 + 1] = c.g; ca[s * 3 + 2] = c.b;
            break;
          }
          default: this.put(p, s, X, z, Z, a, 1, 1, 1, p0);
        }
      }
    }
    for (const p of pools) if (p.count) { p.lo = 0; p.hi = p.count - 1; }
  }

  // ------------------------------------------------------------------ TTC stops (live feed)

  private loadStops(): boolean {
    const src = (window as unknown as { __transit?: StopSource }).__transit;
    const sys = src?.system;
    if (!sys || typeof sys.stops !== 'function') return false;
    if (this.stops && this.stops.trips === sys.tripCount) return true;
    const s = sys.stops({ modes: ['bus', 'streetcar'] });
    this.stops = { x: s.x, y: s.y, mode: s.mode, n: s.x.length, trips: sys.tripCount };
    this.stopGrid.clear();
    for (let i = 0; i < s.x.length; i++) {
      const k = Math.floor(s.x[i] / 200) * 100003 + Math.floor(s.y[i] / 200);
      const l = this.stopGrid.get(k);
      if (l) l.push(i); else this.stopGrid.set(k, [i]);
    }
    return true;
  }

  private rebuildStops(cam: THREE.Vector3, alt: number) {
    this.stopsAt.copy(cam);
    this.stopPoles.clear(); this.stopShelters.clear();
    this.stopSolids.length = 0;
    if (alt > 500 || !this.loadStops() || !this.stops) return;
    const o = this.engine.anchor.origin;
    const E = cam.x, Nn = -cam.z;
    const st = this.stops;
    const dummy: Owner = { slots: new Int32Array(0) };
    const add = (p: Pool, x: number, y: number, z: number, a: number) => {
      p.ensure(p.count + 1);
      const s = p.count++;
      p.owners[s] = dummy; p.mesh.count = p.count;
      this.put(p, s, x - o.x, z, -y - o.z, a, 1, 1, 1);
      const shelter = p === this.stopShelters;
      this.stopSolids.push({ e: x, n: y, h: a, hl: shelter ? 0.85 : 0.07, hw: shelter ? 1.95 : 0.07 });
    };
    for (let gi = Math.floor((E - STOP_R) / 200); gi <= Math.floor((E + STOP_R) / 200); gi++) {
      for (let gj = Math.floor((Nn - STOP_R) / 200); gj <= Math.floor((Nn + STOP_R) / 200); gj++) {
        const l = this.stopGrid.get(gi * 100003 + gj);
        if (!l) continue;
        for (const i of l) {
          const e = st.x[i], n = st.y[i];
          if (Math.hypot(e - E, n - Nn) > STOP_R) continue;
          const rec = this.tiles.get(`0/${Math.floor(e / 1024)}/${Math.floor(n / 1024)}`) ?? [...this.tiles.values()].find((t) => e >= t.e0 && e < t.e0 + 1024 && n >= t.n0 && n < t.n0 + 1024);
          if (!rec) continue;
          // snap to the nearest street: pole just behind the curb, facing the road
          const lx = e - rec.e0, ly = n - rec.n0, sg = rec.data.segs;
          let bd = 40, bx = 0, by = 0, bhw = 0, bcls = 5;
          for (let k = 0; k < sg.length; k += 6) {
            const x0 = sg[k], y0 = sg[k + 1], dx = sg[k + 2] - x0, dy = sg[k + 3] - y0, l2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((lx - x0) * dx + (ly - y0) * dy) / l2));
            const px = x0 + dx * t, py = y0 + dy * t, d = Math.hypot(lx - px, ly - py) - sg[k + 4];
            if (d < bd) { bd = d; bx = px; by = py; bhw = sg[k + 4]; bcls = sg[k + 5]; }
          }
          if (bd >= 40) continue;
          let nx = lx - bx, ny = ly - by;
          const nl = Math.hypot(nx, ny);
          if (nl < 0.01) continue;
          nx /= nl; ny /= nl;
          const toRoad = Math.atan2(-ny, -nx);
          const pe = rec.e0 + bx + nx * (bhw + 0.7), pn = rec.n0 + by + ny * (bhw + 0.7);
          const h = this.engine.heightAt(pe, pn);
          add(this.stopPoles, pe, pn, h, toRoad);
          const hash = Math.abs(Math.sin(e * 0.1313 + n * 0.7171) * 43758.5453) % 1;
          if (hash < (bcls <= 3 ? 0.6 : 0.2)) {
            const se = rec.e0 + bx + nx * (bhw + 2.6), sn = rec.n0 + by + ny * (bhw + 2.6);
            // shelter's long side along the street, opening toward the road
            add(this.stopShelters, se - Math.cos(toRoad + Math.PI / 2) * 3, sn - Math.sin(toRoad + Math.PI / 2) * 3, this.engine.heightAt(se, sn), toRoad);
          }
        }
      }
    }
  }

  dispose() {
    for (const p of this.allPools()) p.dispose();
    this.group.removeFromParent();
  }
}
