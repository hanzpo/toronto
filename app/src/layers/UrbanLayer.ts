// Urban detail (placements from workers/urban.ts + workers/rooftops.ts):
// rooftop equipment, construction sites with slewing tower cranes, laneway
// garages / fences / poles / bins. Level-0 tiles; one instanced draw per item
// kind, refilled with the instances inside each kind's own range as the camera
// moves (small rooftop kit ≤ 350 m, rooftop units ≤ 1.2 km, cranes and towers
// in progress as far as level-0 tiles go). Crane jibs slew on the CPU (a few
// dozen matrices a frame); their aviation lights blink red at night.
import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, vec4, cameraPosition, modelWorldMatrix, positionLocal, positionGeometry, length, smoothstep, vertexColor,
  mix, texture, floor, mod, fract, sin, step, abs, max, fwidth, clamp,
} from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { U } from '../render/uniforms';
import { baseTone } from '../render/tiles/materials';
import { useApp } from '../state/store';
import { UK, URBAN_KINDS, USTRIDE, type UrbanBuf } from '../workers/urban';
import * as G from './urban/geometry';
import { houseBin, hydroPole, planter, wireSpan } from './props/geometry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

// ---------------------------------------------------------------------------- palettes (sRGB hex, rows of a 16 × 16 table)

const PAL: number[][] = [
  /* 0 crane      */[0xf2c200, 0xc8102e, 0xeeeee8, 0xf07d00],
  /* 1 umbrella   */[0xf4f1ea, 0x1f3b5c, 0xb3261e, 0x2e5e3a, 0x222222, 0xd9a441],
  /* 2 formwork   */[0xf2c500, 0xf5a200, 0xc62828, 0xe9e9e4, 0x1d3f7a, 0x2b2b2b],
  /* 3 hoarding   */[0xb89c72, 0x0c1424, 0xf0efe9, 0x121212, 0x1f4a33, 0x2a5a8a, 0xb89c72, 0x163a6b,
    /* accents */ 0x6b5436, 0xf2f2ee, 0x0f8f8a, 0xf2f2ee, 0xe9e5d6, 0xf2b705, 0xd8342c, 0xf2f2ee],
  /* 4 trailer    */[0xefeee8, 0xd8cfb8, 0xc9ccce],
  /* 5 toilet     */[0x1f5fa8, 0x2e7d32],
  /* 6 dumpster   */[0x1f4f9c, 0x2e6b30, 0xa33a2a],
  /* 7 excavator  */[0xf2b705, 0xe8a800],
  /* 8 garage     */[0xd9d2c4, 0xb9b4a8, 0x8e5a44, 0x7a7f82, 0xe6e0d0, 0x9b6b52, 0x5d6a5e, 0xc8c3b6, 0xa45c45, 0xdcd6c8, 0x6e7478, 0xbfb09a,
    0x8d8a84, 0xe2dccf, 0x7d4b3b, 0xa9a59c],
  /* 9 door       */[0xf2f0ea, 0xe8e0cc, 0x6b4a34, 0x8a8d8f, 0x2f4a38, 0x222426, 0x7a2a22, 0x2c3e5a, 0xd8d4c8, 0x9c9a94, 0xb5a17a, 0x4e5a63,
    0xeeeeea, 0x5a3b2b, 0xc9c5ba, 0x3a3c3e],
  /* 10 graffiti  */[0xff4fa3, 0x28c7d9, 0x9ae53a, 0xff8a1e, 0x8f5bd6, 0xffe14a, 0x1e1e1e, 0xf2f2f2],
  /* 11 fence     */[0xa27b56, 0x9a948a, 0x44534a, 0xc2a47a],
  /* 12 bins      */[0x1f4f9c, 0x2e6b30, 0x2b2b2b],
  /* 13 plain     */[0xffffff],
];
const P_ROWS = 16;

let _tbl: THREE.DataTexture | null = null;
function paletteTex(): THREE.DataTexture {
  if (_tbl) return _tbl;
  const d = new Float32Array(16 * P_ROWS * 4);
  PAL.forEach((row, r) => row.forEach((c, i) => {
    const f = (v: number) => Math.pow(v / 255, 2.2);
    d.set([f((c >> 16) & 255), f((c >> 8) & 255), f(c & 255), 1], (r * 16 + i) * 4);
  }));
  const t = new THREE.DataTexture(d, 16, P_ROWS, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return (_tbl = t);
}

// ---------------------------------------------------------------------------- materials

interface MatOpts { far: number; near?: number; row: number; double?: boolean; garage?: boolean; hoard?: boolean; boards?: boolean }

const hash2 = (a: N, b: N): N => fract(sin(a.mul(12.9898).add(b.mul(78.233))).mul(43758.5453));
const box1 = (x: N, a: N, b: N, w: N): N => smoothstep(a.sub(w), a.add(w), x).mul(float(1).sub(smoothstep(b.sub(w), b.add(w), x)));

function urbanMaterial(name: string, o: MatOpts): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = name;
  if (o.double) m.side = THREE.DoubleSide;
  const tbl = paletteTex();
  // collapse instances beyond `far` (the CPU range matches)
  const ipos = attribute('ipos', 'vec4');
  const d = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(ipos.xyz, 1)).xyz));
  let k: N = float(1).sub(smoothstep(o.far * 0.85, o.far, d));
  if (o.near) k = k.mul(smoothstep(o.near * 0.9, o.near, d));
  m.positionNode = ipos.xyz.add(positionLocal.sub(ipos.xyz).mul(k));
  const vc = vertexColor();
  const tag: N = vc.a;
  const variant: N = floor(ipos.w.add(0.5));
  const n = PAL[o.row].length;
  const pal = (row: number, idx: N): N => texture(tbl, vec2(floor(mod(idx, PAL[row].length)).add(0.5).div(16), (row + 0.5) / P_ROWS)).rgb;
  const is = (t: number) => step(t - 0.04, tag).mul(step(tag, t + 0.04));
  const tint = pal(o.row, mod(variant, n));
  let col: N = mix(vc.rgb, tint, is(0.3));
  const pg = positionGeometry;
  if (o.boards) {
    // vertical boards: gaps + per-board weathering
    const bu = pg.x.div(0.145);
    const gap = box1(fract(bu), float(0), float(0.1), max(fwidth(bu), 0.001)).mul(float(1).sub(smoothstep(0.25, 0.5, fwidth(bu))));
    const tone = hash2(floor(bu), variant.add(3)).sub(0.5).mul(0.18);
    col = mix(col, tint.mul(float(1).add(tone)).mul(float(1).sub(gap.mul(0.45))), is(0.75));
  }
  if (o.garage) {
    // body tint (row 8) from the variant, door colour (row 9), sectional grooves, graffiti on some (bit 4)
    const dv = mod(variant, 16);
    const body = pal(8, dv.mul(7).add(3));
    col = mix(col, body, is(0.3));
    const doorC = pal(9, dv);
    const gy = pg.y.div(0.54);
    const groove = box1(fract(gy), float(0), float(0.07), max(fwidth(gy), 0.001)).mul(float(1).sub(smoothstep(0.3, 0.6, fwidth(gy))));
    let door: N = doorC.mul(float(1).sub(groove.mul(0.3)));
    // graffiti: bubbly letter shapes with a dark outline (procedural, per door)
    const gs = floor(variant.div(16)).mod(2);
    const sd = hash2(variant, float(7.1)).mul(20);
    const u = pg.z.mul(1.1), v = pg.y.mul(1.25);
    const f1 = sin(u.mul(2.6).add(sin(v.mul(3.3).add(sd)).mul(1.2)).add(sd.mul(0.7)));
    const f2 = sin(v.mul(4.6).add(sin(u.mul(2.1).add(sd.mul(1.3))).mul(1.4)));
    const f = f1.mul(f2);
    const inBand = box1(pg.y, float(0.35), float(1.75), float(0.02)).mul(box1(pg.z, float(-1.25), float(1.25), float(0.02)));
    const fill = step(0.18, f).mul(inBand), line = step(0.08, f).mul(step(f, 0.18)).mul(inBand);
    const gc = mix(pal(10, sd), pal(10, sd.add(3)), step(0.5, fract(u.mul(0.35).add(v.mul(0.2)))));
    door = mix(door, gc, fill.mul(gs));
    door = mix(door, vec3(0.02, 0.02, 0.025), line.mul(gs));
    col = mix(col, door, is(0.7));
  }
  if (o.hoard) {
    // per-site scheme (variant 0-7): 0 plywood · 1 navy + type · 2 white + band + image · 3 black + type
    // · 4 green · 5 mural · 6 plywood + posters · 7 blue + band
    const s = mod(variant, 8);
    const baseC = pal(3, s), acc = pal(3, s.add(8));
    const x = pg.x.add(3.66), y = pg.y; // 0..7.32, 0..2.44
    const w = max(fwidth(x), 0.002);
    const isS = (k: number) => step(k - 0.5, s).mul(step(s, k + 0.5));
    let c: N = baseC;
    // plywood: sheet joints every 1.22 m + grain
    const joint = box1(fract(x.div(1.22)), float(0), float(0.012), w.div(1.22));
    const grain = hash2(floor(x.mul(3)), floor(y.mul(0.5))).sub(0.5).mul(0.12);
    const ply = baseC.mul(float(1).add(grain)).mul(float(1).sub(joint.mul(0.5)));
    c = mix(c, ply, isS(0).add(isS(6)));
    // type rows (developer name, "coming soon", web address)
    const gx = x.div(0.32);
    const glyph = step(0.35, hash2(floor(gx), s.add(11))).mul(box1(fract(gx), float(0.12), float(0.88), w.div(0.32)));
    const typeZ = box1(y, float(1.45), float(1.95), w).mul(box1(x, float(0.6), float(5.2), w)).add(box1(y, float(0.55), float(0.75), w).mul(box1(x, float(0.6), float(3.4), w)));
    c = mix(c, acc, glyph.mul(clamp(typeZ, 0, 1)).mul(isS(1).add(isS(3)).add(isS(7))));
    // white hoarding: colour band at the foot, rendering / image block
    const band = step(y, 0.55).add(box1(y, float(2.2), float(2.44), w));
    c = mix(c, acc, clamp(band, 0, 1).mul(isS(2).add(isS(7))));
    const img = box1(x, float(3.9), float(6.9), w).mul(box1(y, float(0.8), float(2.05), w));
    const sky = mix(vec3(0.25, 0.4, 0.6), vec3(0.55, 0.62, 0.66), smoothstep(0.8, 2.05, y));
    const tower = box1(x, float(4.9), float(5.7), w).mul(step(y, 1.95));
    c = mix(c, mix(sky, vec3(0.2, 0.24, 0.28), tower), img.mul(isS(2)));
    // mural: soft colour fields
    const mu = sin(x.mul(0.9).add(sin(y.mul(1.7)).mul(1.5))).mul(0.5).add(0.5), mv = sin(y.mul(2.1).add(x.mul(0.4))).mul(0.5).add(0.5);
    const mural = mix(mix(vec3(0.8, 0.3, 0.1), vec3(0.1, 0.45, 0.6), mu), vec3(0.95, 0.75, 0.2), mv.mul(0.5));
    c = mix(c, mural, isS(5));
    // posters (on plywood): overlapping bills at eye level
    const px = floor(x.div(0.62)), py = floor(y.div(0.9));
    const posterZ = box1(y, float(0.9), float(2.1), w).mul(box1(fract(x.div(0.62)), float(0.04), float(0.96), w.div(0.62)));
    const pc = mix(vec3(0.85, 0.82, 0.75), mix(vec3(0.7, 0.1, 0.1), vec3(0.08, 0.1, 0.2), hash2(px, py)), step(0.4, hash2(px.add(1), py)));
    c = mix(c, pc, posterZ.mul(isS(6)).mul(step(0.3, hash2(px, s))));
    col = mix(col, c, is(0.8));
  }
  m.colorNode = baseTone(col);
  // emissive: warm lamps at night, blinking red aviation lights (always faintly visible)
  const night = U.night;
  const blink = step(0.45, fract(U.time.mul(0.5).add(variant.mul(0.137)).add(ipos.x.mul(0.013))));
  const red = vec3(1.0, 0.05, 0.03).mul(is(0.9)).mul(night.mul(4).mul(blink).add(0.25));
  // lamps (tag 1) always on at night; garage lamps (tag 0.97) on about half the garages (variant bit 5)
  const lampOn = mix(float(1), floor(variant.div(32)).mod(2), is(0.97).mul(o.garage ? 1 : 0));
  const lamp = vec3(1.0, 0.78, 0.5).mul(step(0.955, tag)).mul(lampOn).mul(night.mul(1.3));
  (m as unknown as { emissiveNode: N }).emissiveNode = red.add(lamp).mul(float(1).sub(U.analytics.mul(0.7)));
  void abs;
  return m;
}

// ---------------------------------------------------------------------------- pools

class Pool {
  mesh: THREE.InstancedMesh;
  cap: number;
  count = 0;
  ipos!: THREE.InstancedBufferAttribute;
  geo: THREE.BufferGeometry; mat: THREE.Material; parent: THREE.Object3D; name: string; shadow: boolean;
  range: number;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, name: string, range: number, shadow = false) {
    this.geo = geo; this.mat = mat; this.parent = parent; this.name = name; this.shadow = shadow; this.range = range;
    this.cap = cap;
    this.mesh = this.make(cap);
  }
  private make(cap: number) {
    const g = this.geo.clone();
    const old = this.ipos?.array as Float32Array | undefined;
    this.ipos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    if (old) (this.ipos.array as Float32Array).set(old.subarray(0, Math.min(old.length, cap * 4)));
    g.setAttribute('ipos', this.ipos);
    const m = new THREE.InstancedMesh(g, this.mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = this.shadow;
    m.receiveShadow = true;
    m.name = this.name;
    m.visible = false;
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
    this.parent.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.mesh = m;
    this.cap = cap;
  }
  clear() { this.count = 0; }
  append(): number { this.ensure(this.count + 1); return this.count++; }
  flush() {
    const n = this.count;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, n * 16); im.needsUpdate = true;
    this.ipos.clearUpdateRanges(); this.ipos.addUpdateRange(0, n * 4); this.ipos.needsUpdate = true;
  }
  dispose() { this.parent.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.dispose(); }
}

interface TileRec { key: string; e0: number; n0: number; items: Float32Array; byKind: Int32Array[] }

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** how far each kind is drawn (m) — matches its material's fade window */
const RANGE: Record<number, number> = {
  [UK.VENT]: 220, [UK.TOILET]: 250, [UK.BIN]: 200,
  [UK.HATCH]: 320, [UK.FAN]: 360, [UK.PLANTER]: 320, [UK.FENCE]: 320,
  [UK.UMBRELLA]: 600, [UK.CHIMNEY]: 700, [UK.DORMER]: 700, [UK.HOARD]: 650, [UK.DUMPSTER]: 500, [UK.TRAILER]: 800,
  [UK.EXCAVATOR]: 800, [UK.GARAGE]: 650, [UK.POLE]: 650, [UK.WIRE]: 450,
  [UK.RTU]: 1000, [UK.COOLING]: 1600, [UK.WATERTANK]: 1800,
  // lattice cranes hand over to the far silhouettes at CRANE_NEAR *horizontal* distance, but the
  // material collapses per instance by 3D distance: at 520 a jib 150+ m up (farther than its mast
  // base) shrank toward its pivot while the mast shrank less, leaving jib + counterweights floating
  // in the sky. Keep the near window beyond any 3D distance a near crane can have.
  [UK.MAST_H]: 900, [UK.JIB_H]: 900, [UK.MAST_L]: 900, [UK.JIB_L]: 900, [UK.CORE]: 4000, [UK.SLAB]: 550, [UK.FORMWORK]: 4000,
};
/** rooftop kit: drawn over shorter ranges near the ground, and not at all on roofs above the eye (behind the parapet) */
const ROOFTOP = new Set<number>([UK.RTU, UK.FAN, UK.HATCH, UK.VENT, UK.UMBRELLA, UK.PLANTER, UK.COOLING, UK.WATERTANK, UK.CHIMNEY, UK.DORMER]);
const SEEN_FROM_BELOW = new Set<number>([UK.COOLING, UK.WATERTANK, UK.CHIMNEY, UK.DORMER]);
/** near → far LOD switch distance (horizontal) for kinds with a far stand-in */
const FAR_AT: Record<number, number> = { [UK.SLAB]: 500 };
const RMAX = 6000;
/** `?urban=0` hides the layer (A/B perf checks) */
const URBAN_OFF = new URLSearchParams(location.search).get('urban') === '0';
/** lattice cranes inside this distance, solid silhouettes beyond */
const CRANE_NEAR = 480;

export class UrbanLayer implements Layer {
  readonly id = 'urban';
  private engine!: Engine;
  private group = new THREE.Group();
  private tiles = new Map<string, TileRec>();
  private anchorVer = -1;
  private pools: (Pool | null)[] = [];
  /** far-LOD stand-ins (solid crane silhouettes) by kind, used beyond the near pool's range */
  private far: (Pool | null)[] = [];
  private at = new THREE.Vector3(Infinity, 0, 0);
  private dirty = true;
  /** jib slots to animate: pool, slot, X, Y, Z (anchor-relative), yaw0, speed, phase, scale */
  private jibs: { p: Pool; s: number; x: number; y: number; z: number; a0: number; sp: number; ph: number; sc: number; luff: boolean }[] = [];

  async init(engine: Engine) {
    this.engine = engine;
    this.group.name = 'urban';
    engine.scene.add(this.group);
    const g = this.group;
    const mats = new Map<string, THREE.Material>();
    const mat = (o: MatOpts) => {
      const key = JSON.stringify(o);
      let m = mats.get(key);
      if (!m) { m = urbanMaterial(`urban-${o.row}-${o.far}`, o); mats.set(key, m); }
      return m;
    };
    const P = (k: number, geo: THREE.BufferGeometry, o: Omit<MatOpts, 'far'>, cap: number, shadow = false) => {
      const far = RANGE[k] ?? 500;
      this.pools[k] = new Pool(geo, mat({ ...o, far }), cap, g, `urban-${k}`, far, shadow);
    };
    const plain = { row: 13 };
    P(UK.RTU, G.rtu(), plain, 1024, true);
    P(UK.FAN, G.exhaustFan(), plain, 512);
    P(UK.HATCH, G.hatch(), plain, 256);
    P(UK.VENT, G.vents(), plain, 256);
    P(UK.WATERTANK, G.waterTank(), plain, 8, true);
    P(UK.UMBRELLA, G.umbrella(), { row: 1 }, 64);
    P(UK.PLANTER, planter(), plain, 128);
    P(UK.COOLING, G.coolingTower(), plain, 64, true);
    P(UK.CHIMNEY, G.chimney(), plain, 256);
    P(UK.DORMER, G.dormer(), plain, 128);
    P(UK.MAST_H, G.craneMast(), { row: 0, double: true }, 32);
    P(UK.MAST_L, G.craneMast(), { row: 0, double: true }, 32);
    P(UK.JIB_H, G.craneTopHammer(), { row: 0, double: true }, 32);
    P(UK.JIB_L, G.craneTopLuffer(), { row: 0, double: true }, 32);
    const F = (k: number, geo: THREE.BufferGeometry) => {
      this.far[k] = new Pool(geo, mat({ row: 0, near: CRANE_NEAR - 40, far: RMAX }), 32, g, `urban-far-${k}`, RMAX);
    };
    F(UK.MAST_H, G.craneMastFar()); F(UK.MAST_L, G.craneMastFar());
    F(UK.JIB_H, G.craneTopHammerFar()); F(UK.JIB_L, G.craneTopLufferFar());
    this.far[UK.SLAB] = new Pool(G.slabFar(), mat({ row: 13, near: FAR_AT[UK.SLAB] - 30, far: 4000 }), 256, g, 'urban-far-slab', 4000, true);
    P(UK.CORE, G.core(), plain, 32, true);
    P(UK.SLAB, G.slab(), plain, 512, true);
    P(UK.FORMWORK, G.formwork(), { row: 2, double: true }, 32, true);
    P(UK.HOARD, G.hoarding(), { row: 3, hoard: true }, 512);
    P(UK.TRAILER, G.trailer(), { row: 4 }, 64);
    P(UK.TOILET, G.toilet(), { row: 5 }, 64);
    P(UK.DUMPSTER, G.dumpster(), { row: 6 }, 32);
    P(UK.EXCAVATOR, G.excavator(), { row: 7 }, 32);
    P(UK.GARAGE, G.garage(), { row: 8, garage: true }, 512, true);
    P(UK.FENCE, G.fence(), { row: 11, boards: true }, 1024);
    P(UK.POLE, hydroPole(false), plain, 256);
    P(UK.WIRE, wireSpan(), plain, 256);
    P(UK.BIN, houseBin(), { row: 12 }, 256);
    Object.assign(window as object, { __urban: this });
  }

  update(ctx: FrameContext) {
    const eng = this.engine;
    const layers = useApp.getState().layers as Record<string, boolean>;
    this.group.visible = layers.buildings !== false && !URBAN_OFF;
    if (!this.group.visible) return;
    const cam = ctx.cameraPos;
    const E = cam.x, Nn = -cam.z;
    if (this.anchorVer !== ctx.anchor.version) {
      this.anchorVer = ctx.anchor.version;
      const o = ctx.anchor.origin;
      for (const p of [...this.pools, ...this.far]) if (p) p.mesh.position.set(o.x, 0, o.z);
      this.dirty = true;
    }
    // level-0 tiles in reach (cranes / towers in progress are seen from far)
    const want = new Set<string>();
    for (const t of eng.tiles.drawn) {
      if (t.L !== 0 || !t.urban) continue;
      const dx = Math.max(0, Math.abs(E - (t.tx + 0.5) * t.S) - t.S / 2), dy = Math.max(0, Math.abs(Nn - (t.ty + 0.5) * t.S) - t.S / 2);
      if (Math.hypot(dx, dy) < RMAX) want.add(t.key);
    }
    for (const k of [...this.tiles.keys()]) if (!want.has(k)) { this.tiles.delete(k); this.dirty = true; }
    for (const t of eng.tiles.drawn) {
      if (!want.has(t.key) || this.tiles.has(t.key) || !t.urban) continue;
      this.tiles.set(t.key, this.index(t.key, t.tx * t.S, t.ty * t.S, t.urban));
      this.dirty = true;
    }
    if (this.dirty || Math.hypot(cam.x - this.at.x, cam.z - this.at.z) > 25 || Math.abs(cam.y - this.at.y) > 20) this.rebuild(cam, ctx.altitude);
    this.slew(ctx.time);
    this.registerQa();
  }

  /** __qa.extra counters: house roof sanity over the drawn level-0 tiles (workers/houseFront.ts houseRoofQa) */
  private registerQa() {
    const qa = (window as unknown as { __qa?: { extra?: Record<string, () => unknown> } }).__qa;
    if (!qa || qa.extra?.houseRoofSpike) return;
    const eng = this.engine;
    const sum = (k: 'roofSpike' | 'tallHouse' | 'overlapBuilding') => () => {
      let count = 0;
      const examples: unknown[] = [];
      for (const t of eng.tiles.drawn) {
        const q = t.L === 0 ? t.houses?.qa : undefined;
        if (!q) continue;
        count += q[k];
        for (const x of q.examples) if (x[2] === k && examples.length < 20) examples.push({ e: x[0], n: x[1] });
      }
      return { count, examples };
    };
    qa.extra = { ...(qa.extra ?? {}), houseRoofSpike: sum('roofSpike'), houseTooTall: sum('tallHouse'), houseInBuilding: sum('overlapBuilding') };
  }

  /** per-kind item lists of a tile (so a rebuild skips whole tile × kind groups out of range) */
  private index(key: string, e0: number, n0: number, data: UrbanBuf): TileRec {
    const it = data.items, n = it.length / USTRIDE;
    const counts = new Int32Array(URBAN_KINDS);
    for (let i = 0; i < n; i++) counts[it[i * USTRIDE] | 0]++;
    const byKind = Array.from(counts, (c) => new Int32Array(c));
    counts.fill(0);
    for (let i = 0; i < n; i++) { const k = it[i * USTRIDE] | 0; byKind[k][counts[k]++] = i; }
    return { key, e0, n0, items: it, byKind };
  }

  private put(p: Pool, slot: number, x: number, y: number, z: number, ang: number, sx: number, sy: number, sz: number, w: number) {
    _p.set(x, y, z);
    _q.setFromAxisAngle(_up, ang);
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    _m.toArray(p.mesh.instanceMatrix.array as Float32Array, slot * 16);
    const ip = p.ipos.array as Float32Array;
    ip[slot * 4] = x; ip[slot * 4 + 1] = y; ip[slot * 4 + 2] = z; ip[slot * 4 + 3] = w;
  }

  private rebuild(cam: THREE.Vector3, alt: number) {
    this.at.copy(cam);
    this.dirty = false;
    for (const p of this.pools) p?.clear();
    for (const p of this.far) p?.clear();
    this.jibs.length = 0;
    const o = this.engine.anchor.origin;
    const E = cam.x, Nn = -cam.z, H = cam.y;
    const roofK = Math.min(1, Math.max(0.2, (alt + 30) / 260));
    for (const rec of this.tiles.values()) {
      const dx = Math.max(0, Math.abs(E - (rec.e0 + 512)) - 512), dy = Math.max(0, Math.abs(Nn - (rec.n0 + 512)) - 512);
      const dTile = Math.hypot(dx, dy);
      const ox = rec.e0 - o.x, on = rec.n0 + o.z;
      const it = rec.items;
      for (let k = 0; k < URBAN_KINDS; k++) {
        const list = rec.byKind[k], pNear = this.pools[k], pFar = this.far[k] ?? null;
        if (!pNear || !list.length) continue;
        const roofKit = ROOFTOP.has(k), below = SEEN_FROM_BELOW.has(k);
        const range = pFar ? pFar.range : roofKit ? Math.max(120, pNear.range * roofK) : pNear.range;
        if (dTile > range) continue;
        const R2 = range * range;
        const farAt = FAR_AT[k] ?? CRANE_NEAR;
        for (let j = 0; j < list.length; j++) {
          const b = list[j] * USTRIDE;
          const x = it[b + 1], y = it[b + 2], z = it[b + 3], a = it[b + 4], sx = it[b + 5], sy = it[b + 6], sz = it[b + 7], v = it[b + 8];
          const ex = rec.e0 + x - E, ny = rec.n0 + y - Nn, ez = z - H;
          const d2 = ex * ex + ny * ny + ez * ez;
          if (d2 > R2) continue;
          if (roofKit && !below && z > H - 1.5) continue; // on a roof above the eye: hidden by the parapet
          // cranes: horizontal distance picks the LOD, so mast and jib always agree
          const p = pFar && ex * ex + ny * ny > farAt * farAt ? pFar : pNear;
          const X = ox + x, Z = -(on + y);
          const s = p.append();
          if (k === UK.WIRE) {
            // sheared transform: unit span along x from this pole to the next (rise sy), heights scaled by sz
            const L = sx, ca = Math.cos(a), sa = Math.sin(a);
            _m.set(L * ca, 0, sa, X, sy, sz, 0, z, -L * sa, 0, ca, Z, 0, 0, 0, 1);
            _m.toArray(p.mesh.instanceMatrix.array as Float32Array, s * 16);
            const ip = p.ipos.array as Float32Array;
            ip[s * 4] = X + L * ca / 2; ip[s * 4 + 1] = z + 9; ip[s * 4 + 2] = Z - L * sa / 2; ip[s * 4 + 3] = 0;
          } else if (k === UK.JIB_H || k === UK.JIB_L) {
            const luff = k === UK.JIB_L;
            this.jibs.push({ p, s, x: X, y: z, z: Z, a0: a, sp: sy, ph: sz, sc: sx, luff });
            this.put(p, s, X, z, Z, a, sx, luff ? sx : 1, luff ? sx : 1, v);
          } else {
            this.put(p, s, X, z, Z, a, sx, sy, sz, v);
          }
        }
      }
    }
    for (const p of this.pools) p?.flush();
    for (const p of this.far) p?.flush();
  }

  /** cranes slew back and forth between picks (yaw = a0 + A·sin(ωt + φ)) */
  private slew(t: number) {
    if (!this.jibs.length) return;
    const touched = new Set<Pool>();
    for (const j of this.jibs) {
      const A = 1.1, w = Math.abs(j.sp) / A;
      const yaw = j.a0 + Math.sign(j.sp) * A * Math.sin(w * t + j.ph);
      _p.set(j.x, j.y, j.z);
      _q.setFromAxisAngle(_up, yaw);
      _s.set(j.sc, j.luff ? j.sc : 1, j.luff ? j.sc : 1);
      _m.compose(_p, _q, _s);
      _m.toArray(j.p.mesh.instanceMatrix.array as Float32Array, j.s * 16);
      touched.add(j.p);
    }
    for (const p of touched) {
      const im = p.mesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, p.count * 16); im.needsUpdate = true;
    }
  }

  dispose() {
    for (const p of this.pools) p?.dispose();
    for (const p of this.far) p?.dispose();
    this.group.removeFromParent();
  }
}
