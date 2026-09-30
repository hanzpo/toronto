// Agent-based local traffic + pedestrians (Rust/wasm in a worker, results via
// SharedArrayBuffer) rendered with instancing, the region-wide congestion
// overlay (statistical tier), and a player-drivable car.
//
// Ground contact: agents sit on the *rendered* terrain (GroundSampler) unless
// the sim flags them as on a bridge / in a tunnel, where the graph elevation is
// used; cars pitch and roll with the surface under their wheels.
//
// Interop (window.__traffic):
//   queryAhead(e, n, heading, lookahead, halfWidth)  distance to the nearest car in a corridor
//   signalAhead(e, n, heading, lookahead)             distance to a red/amber stop line
// Surface transit (window.__transit.groundVehicles) is fed to the sim every
// tick as moving obstacles; the sim's signal states drive window.__street.
//
// Headings in this API are radians counter-clockwise from +E (east).
import * as THREE from 'three/webgpu';
import { attribute, clamp, cos, dot, float, floor, fract, mix, mod, normalView, positionGeometry, positionLocal, positionViewDirection, pow, sin, step, vec3, abs as tslAbs } from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { U } from '../render/uniforms';
import { clock } from '../state/clock';
import { useApp } from '../state/store';
import {
  CAR_FLAG, CAR_STRIDE, H, HEADER_BYTES, HF, HF_COUNT, MAX_CARS, MAX_PEDS, OB_FLAG, OB_STRIDE, PED_STRIDE, RAIL_OFFSET, RAIL_PATH_OFFSET, RAIL_RADIUS, RAIL_STRIDE, BUS_OFFSET, BUS_PATH_OFFSET, BUS_STRIDE, SAB_BYTES, SIG_OFFSET, SIG_STRIDE,
  OVERLAP_CAUSES, SLOT_BYTES, SLOT_HEADER, type FromWorker, type TickMsg, type ToWorker,
} from '../sim/protocol';
import { CAR_LENGTH, carLowGeometries, carPalette, carVariantsForKind, pedestrianGeometries, pedestrianLowGeometry, shirtPalette, type CarVariant } from './traffic/models';
import { CongestionOverlay } from './traffic/congestion';
import { GroundSampler } from './traffic/ground';

export interface PlayerInput { throttle: number; brake: number; steer: number; handbrake: boolean }
export interface PlayerState { e: number; n: number; elev: number; heading: number; speed: number; pitch: number; onRoad: boolean; roadName: string | null; carId: number }
export interface TrafficStats { cars: number; peds: number; targetCars: number; targetPeds: number; stepMs: number; stepAvgMs: number; fillMs: number; substeps: number; tiles: number; pendingTiles: number; fast: boolean }

/** anything exposing transit stop positions (TransitLayer) */
interface StopSource {
  system: { stops(opts?: { modes?: string[] }): { x: Float64Array; y: Float64Array; z: Float32Array }; stopCount?: number };
  groundVehicles?(out: GroundVeh[]): number;
}
interface GroundVeh { e: number; n: number; heading: number; length: number; width: number; speed: number; trip: number; doorsOpen?: boolean; rail?: boolean }
/** StreetLayer's signal-head hook (window.__street) */
interface StreetSignals {
  setSignal(junctionOsmId: number, armAngle: number | null, state: 0 | 1 | 2): void;
  listSignals(): { junction: number; armAngle: number; e: number; n: number }[];
}

const HIDE_ALTITUDE = 6000;
const KINDS = 6;
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
/** body half widths per kind (m), matching the sim */
const HALF_W = [0.92, 0.9, 0.98, 1.01, 1.0, 1.25];
/** road surface above the terrain (roads.ts lift ≈ 0.03 + (9 − class)·0.004) */
const ROAD_LIFT = 0.06;
/** raised sidewalk top above the terrain at the curb (lift + 15 cm curb) */
const WALK_LIFT = 0.2;
/** detailed ground contact (pitch / roll from 4 samples) within this range of the camera */
const NEAR_GROUND = 700;
const AMBER = 4, ALL_RED = 2;
/** detail rings (× view scale): full car models (shadow casters) inside CAR_NEAR, box stand-ins beyond */
const CAR_NEAR = 320;
/** full pedestrians inside PED_NEAR, simple figures to PED_FAR, none beyond (sub-pixel) */
const PED_NEAR = 170;
const PED_FAR = 650;

/**
 * Instance pools: attributes keep the default (static) usage on purpose. In
 * three's WebGPU renderer DynamicDrawUsage re-uploads the whole buffer for
 * every render pass (main + shadow), ignoring update ranges; static usage
 * uploads once per `needsUpdate`, limited to the update range.
 */
class Pool {
  mesh: THREE.InstancedMesh;
  /** rgb tint + flags (WebGPU allows only 8 vertex buffers: attributes are packed) */
  col: THREE.InstancedBufferAttribute;
  extra: THREE.InstancedBufferAttribute | null;
  count = 0;
  constructor(geom: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, name: string, extra = 0) {
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    geom.setAttribute('iColF', this.col);
    this.extra = null;
    if (extra) {
      this.extra = new THREE.InstancedBufferAttribute(new Float32Array(cap * extra), extra);
      geom.setAttribute('iAnim', this.extra);
    }
    this.mesh = new THREE.InstancedMesh(geom, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = name;
    parent.add(this.mesh);
  }
  commit() {
    this.mesh.count = this.count;
    if (!this.count) return;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, this.count * 16); im.needsUpdate = true;
    this.col.clearUpdateRanges(); this.col.addUpdateRange(0, this.count * 4); this.col.needsUpdate = true;
    if (this.extra) { this.extra.clearUpdateRanges(); this.extra.addUpdateRange(0, this.count * this.extra.itemSize); this.extra.needsUpdate = true; }
  }
}

/** Copy of a model geometry with the per-vertex tags packed into one vec4 (livery, lamp, sign, glass). */
function packCar(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  const n = g.attributes.position.count;
  c.setAttribute('position', g.attributes.position);
  c.setAttribute('normal', g.attributes.normal);
  c.setAttribute('color', g.attributes.color);
  const tags = new Float32Array(n * 4);
  (['livery', 'lamp', 'sign', 'glass'] as const).forEach((k, j) => {
    const a = (g.attributes[k] ?? (k === 'livery' ? g.attributes.tint : undefined)) as THREE.BufferAttribute | undefined;
    if (a) for (let i = 0; i < n; i++) tags[i * 4 + j] = a.getX(i);
  });
  c.setAttribute('tags', new THREE.BufferAttribute(tags, 4));
  if (g.index) c.setIndex(g.index);
  c.computeBoundingSphere();
  return c;
}

/** Pedestrian geometry with (tint, limb, pivot) packed into one vec3. */
function packPed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = new THREE.BufferGeometry();
  const n = g.attributes.position.count;
  c.setAttribute('position', g.attributes.position);
  c.setAttribute('normal', g.attributes.normal);
  c.setAttribute('color', g.attributes.color);
  const t = new Float32Array(n * 3);
  (['tint', 'limb', 'pivot'] as const).forEach((k, j) => {
    const a = (g.attributes[k] ?? (k === 'tint' ? g.attributes.livery : undefined)) as THREE.BufferAttribute | undefined;
    if (a) for (let i = 0; i < n; i++) t[i * 3 + j] = a.getX(i);
  });
  c.setAttribute('tlp', new THREE.BufferAttribute(t, 3));
  if (g.index) c.setIndex(g.index);
  c.computeBoundingSphere();
  return c;
}

/**
 * Vehicle shading of models/material.ts (vehicleMaterial) reading the packed
 * `tags` / `iColF` attributes. Instance flags: 1 brake, 4 / 8 indicators, 16 headlights.
 */
function carMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.05 });
  m.name = 'traffic-cars';
  const vc = attribute('color', 'vec3');
  const tags = attribute('tags', 'vec4');
  const inst = attribute('iColF', 'vec4');
  const liv = tags.x, lamp = tags.y, sign = tags.z, glass = tags.w;
  const flags = inst.w;
  const bit = (v: number) => step(0.5, mod(floor(flags.div(v)), 2));
  const is = (k: number) => step(k - 0.5, lamp).mul(step(lamp, k + 0.5));
  const night = U.night;
  const blink = step(0.5, fract(U.time.mul(1.5)));
  const head = is(1).mul(float(0.25).add(night.mul(2.8)).add(bit(16).mul(1.5)));
  const tail = is(2).mul(night.mul(1.1).add(bit(1).mul(2.4)));
  const ind = is(3).mul(bit(4)).add(is(4).mul(bit(8))).mul(blink).mul(2.5);
  const emissive = vec3(1.0, 0.93, 0.78).mul(head)
    .add(vec3(1.0, 0.06, 0.03).mul(tail))
    .add(vec3(1.0, 0.5, 0.05).mul(ind))
    .add(vec3(1.0, 0.62, 0.12).mul(sign.mul(float(0.3).add(night.mul(1.4)))));
  const f = pow(float(1).sub(clamp(dot(normalView, positionViewDirection), 0, 1)), 3);
  const sky = mix(U.skyHorizon, U.skyZenith, 0.35);
  const refl = sky.mul(glass).mul(f.mul(0.32).add(0.03)).mul(float(1).sub(night.mul(0.85)));
  m.colorNode = vc.mul(mix(vec3(1, 1, 1), inst.xyz, liv));
  m.roughnessNode = mix(float(0.5), float(0.08), glass);
  m.metalnessNode = mix(float(0.12), float(0.0), glass);
  m.emissiveNode = emissive.add(refl);
  return m;
}

/** Pedestrians: clothing tint + limb walk cycle (models/traffic pedestrianWalkNode, packed attributes). */
function pedMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  m.name = 'traffic-peds';
  const vc = attribute('color', 'vec3');
  const tlp = attribute('tlp', 'vec3');
  const inst = attribute('iColF', 'vec4');
  const a = attribute('iAnim', 'vec3'); // phase, heading (unused), moving
  m.colorNode = vc.mul(mix(vec3(1, 1, 1), inst.xyz, tlp.x));
  const limb = tlp.y, pivot = tlp.z;
  // limb rotation about the shoulder / hip pivot, computed in model space and
  // added to the (already instanced) positionLocal, rotated by the heading
  const p = positionGeometry;
  const s = sin(a.x).mul(a.z);
  const isL = (k: number) => float(1).sub(tslAbs(limb.sub(k)).min(1));
  const ang = s.mul(isL(3).mul(0.45).sub(isL(4).mul(0.45)).sub(isL(1).mul(0.35)).add(isL(2).mul(0.35)));
  const dy = p.y.sub(pivot);
  const c = cos(ang), sn = sin(ang);
  const limbMask = limb.min(1);
  const ddx = p.x.mul(c).sub(dy.mul(sn)).sub(p.x).mul(limbMask);
  const ddy = pivot.add(p.x.mul(sn)).add(dy.mul(c)).sub(p.y).mul(limbMask).add(tslAbs(sin(a.x)).mul(0.03).mul(a.z));
  const hc = cos(a.y), hs = sin(a.y);
  m.positionNode = positionLocal.add(vec3(ddx.mul(hc), ddy, ddx.mul(hs).negate()));
  return m;
}

/** integer hash → [0, 1) */
function hash01(x: number): number {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** light of a fixed-time plan (sim/src/signal.rs): 0 green · 1 amber · 2 red */
function planLight(p: Float64Array, o: number, tod: number, bearing: number): number {
  const offset = p[o + 3], axis = p[o + 4], ga = p[o + 5], gb = p[o + 6];
  let d = (bearing - axis) % Math.PI; if (d < 0) d += Math.PI;
  const phase = Math.min(d, Math.PI - d) <= Math.PI / 4 ? 0 : 1;
  const cyc = ga + gb + 2 * (AMBER + ALL_RED);
  let u = (tod + offset) % cyc; if (u < 0) u += cyc;
  const [start, green] = phase === 0 ? [0, ga] : [ga + AMBER + ALL_RED, gb];
  const x = u - start;
  return x >= 0 && x < green ? 0 : x >= green && x < green + AMBER ? 1 : 2;
}

export class TrafficLayer implements Layer {
  readonly id = 'traffic';
  /** set false to take over camera handling while driving */
  chaseCamera = true;
  /** force the car radius (m), e.g. for benchmarks; null = altitude-based */
  radiusOverride: number | null = null;
  /** main-thread ms spent filling instance buffers (exp. average) */
  private fillMs = 0;
  private engine!: Engine;
  private worker: Worker | null = null;
  private sab!: SharedArrayBuffer;
  private hdr!: Int32Array;
  private hf!: Float64Array;
  private ready = false;
  private group = new THREE.Group();
  /** car pools per model variant; kindVariants[kind] = pool indices */
  private cars: Pool[] = [];
  private variants: CarVariant[] = [];
  private kindVariants: number[][] = [];
  private peds: Pool[] = [];
  /** ring-1 stand-ins: one pool per sim kind / one for all pedestrians (no shadows) */
  private carsLo: Pool[] = [];
  private pedsLo: Pool | null = null;
  private ground!: GroundSampler;
  private ticksSent = 0;
  private stopsCount = 0;
  private stopsAt = -1e9;
  private accSim = 0;
  private accReal = 0;
  private stopSource: StopSource | null;
  private congestion: CongestionOverlay | null = null;
  /** smoothed elevation offsets (bridge ends / LOD changes) per car id */
  private zoff = new Map<number, number>();
  private zoffNext = new Map<number, number>();
  // transit obstacles
  private gv: GroundVeh[] = [];
  // queries
  private qSeq = -1;
  private qCars = { e: new Float64Array(0), n: new Float64Array(0), h: new Float32Array(0), hl: new Float32Array(0), hw: new Float32Array(0), count: 0 };
  private qGrid = new Map<number, number[]>();
  private sSeq = -1;
  private sGrid = new Map<number, number[]>();
  private sig = { e: new Float64Array(0), n: new Float64Array(0), b: new Float32Array(0), hw: new Float32Array(0), light: new Uint8Array(0), count: 0 };
  // signal heads (StreetLayer)
  private plans: Float64Array = new Float64Array(0);
  private planIndex = new Map<number, number>();
  private streetList: { junction: number; armAngle: number; e: number; n: number; plan: number }[] = [];
  private streetListAt = -1e9;
  private streetStates = new Map<string, number>();
  private streetAt = -1e9;
  // player
  private playerActive = false;
  private roadName: string | null = null;
  private input: PlayerInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private keys = new Set<string>();
  private keyboard = false;
  private waiters: ((ok: boolean) => void)[] = [];
  private statsLog = 0;
  private visible = true;

  constructor(stops: StopSource | null = null) {
    this.stopSource = stops;
  }

  async init(engine: Engine) {
    this.engine = engine;
    this.ground = new GroundSampler(engine.tiles);
    this.group.name = 'traffic';
    engine.scene.add(this.group);
    const cm = carMaterial();
    for (let k = 0; k < KINDS; k++) {
      const idx: number[] = [];
      for (const v of carVariantsForKind(k)) {
        idx.push(this.cars.length);
        this.variants.push(v);
        this.cars.push(new Pool(packCar(v.geometry()), cm, MAX_CARS, this.group, `cars-${v.key}`));
      }
      this.kindVariants.push(idx);
    }
    for (const [k, g] of carLowGeometries().entries()) {
      const p = new Pool(packCar(g), cm, MAX_CARS, this.group, `carsLo-${k}`);
      p.mesh.castShadow = false;
      this.carsLo.push(p);
    }
    const pm = pedMaterial();
    for (const [i, g] of pedestrianGeometries().entries()) {
      const p = new Pool(packPed(g), pm, MAX_PEDS, this.group, `pedestrians-${i}`, 3);
      p.mesh.castShadow = false;
      this.peds.push(p);
    }
    this.pedsLo = new Pool(packPed(pedestrianLowGeometry()), pm, MAX_PEDS, this.group, 'pedestriansLo', 3);
    this.pedsLo.mesh.castShadow = false;
    this.congestion = new CongestionOverlay(engine);
    this.congestion.bind((m) => this.post(m));

    if (typeof SharedArrayBuffer === 'undefined' || !crossOriginIsolated) {
      console.warn('[traffic] SharedArrayBuffer unavailable (page not cross-origin isolated): traffic disabled');
      return;
    }
    this.sab = new SharedArrayBuffer(SAB_BYTES);
    this.hdr = new Int32Array(this.sab, 0, 64);
    this.hf = new Float64Array(this.sab, 0, HF_COUNT);
    const w = new Worker(new URL('../sim/sim.worker.ts', import.meta.url), { type: 'module', name: 'traffic-sim' });
    w.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorker(ev.data);
    w.onerror = (e) => console.error('[traffic] worker error', e.message);
    this.worker = w;
    const man = engine.tiles.manifest as unknown as { build?: number; tiles?: Record<string, [number, number][]> };
    this.post({ type: 'init', sab: this.sab, dataRoot: engine.dataRoot, build: man.build ?? 0, tiles: man.tiles?.['0'] ?? [] });
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('blur', this.onBlur);
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }

  private onWorker(m: FromWorker) {
    switch (m.type) {
      case 'ready': this.ready = true; break;
      case 'error': console.error('[traffic] sim error:', m.message); break;
      case 'player':
        this.roadName = m.roadName;
        if (m.ok !== undefined) {
          this.setPlayerMode(m.ok);
          this.waiters.splice(0).forEach((f) => f(m.ok!));
        }
        break;
      case 'railFeeds': this.railFeeds = m.agencies; this.railFeedsProfile = m.profile; break;
      case 'railPlayer': this.railWaiters.splice(0).forEach((f) => f(m.ok)); break;
      case 'crossings': {
        // drive the crossing lights / gates (CrossingsLayer: window.__street.setCrossing)
        const w = window as unknown as { __street?: { setCrossing?: (id: number, s: 0 | 1 | 2) => void }; __crossings?: { setCrossing?: (id: number, s: 0 | 1 | 2) => void } };
        const set = w.__street?.setCrossing ?? w.__crossings?.setCrossing;
        for (let i = 0; i + 1 < m.data.length; i += 2) {
          this.crossingState.set(m.data[i], m.data[i + 1]);
          set?.(m.data[i], m.data[i + 1] as 0 | 1 | 2);
        }
        break;
      }
      case 'overlaps': {
        // QA: sim-side overlapping car bodies by cause (__qa.carOverlapCauses)
        const qa = (window as unknown as { __qa?: Record<string, unknown> }).__qa;
        if (qa) qa.carOverlapCauses = Object.fromEntries(OVERLAP_CAUSES.map((k, i) => [k, m.counts[i] ?? 0]));
        break;
      }
      case 'majorsGeom': this.congestion?.setGeometry(m); break;
      case 'majorsRatio': this.congestion?.setRatios(m.ratio); break;
      case 'plans':
        this.plans = m.plans;
        this.planIndex.clear();
        for (let i = 0; i < m.plans.length; i += 7) this.planIndex.set(m.plans[i], i);
        this.streetListAt = -1e9; // re-match signal heads
        break;
    }
  }

  // ------------------------------------------------------------------------ rail agents (sim/src/rail.rs)

  /** agency id per rail feed index of the published rail records */
  railFeeds: string[] = [];
  railFeedsProfile = '';
  /** service profile the rail agents follow (set by the TransitLayer) */
  railProfile: 'weekday' | 'saturday' | 'sunday' | null = null;
  railEnabled = true;
  /** level crossing states from the rail sim (osm node id -> 0 idle, 1 warning, 2 gates down) */
  crossingState = new Map<number, number>();
  private camDir = new THREE.Vector3();
  private railCmd: { cmd: number; emergency: boolean } | null = null;
  private railWaiters: ((ok: boolean) => void)[] = [];

  /** Latest rail agent records + body paths (views into the shared buffer), or null. */
  railSnapshot() {
    if (!this.hdr) return null;
    const seq = Atomics.load(this.hdr, H.SEQ);
    if (seq === 0) return null;
    const slot = Atomics.load(this.hdr, H.SLOT);
    const base = HEADER_BYTES + slot * SLOT_BYTES;
    const si = new Int32Array(this.sab, base, 12);
    const sf = new Float64Array(this.sab, base, 4);
    const count = si[9], pts = si[10];
    return {
      seq, count, oe: sf[1], on: sf[2], simMs: sf[3], feeds: this.railFeeds,
      f: new Float32Array(this.sab, base + RAIL_OFFSET, count * RAIL_STRIDE),
      u: new Uint32Array(this.sab, base + RAIL_OFFSET, count * RAIL_STRIDE),
      path: new Float32Array(this.sab, base + RAIL_PATH_OFFSET, pts * 3),
    };
  }

  /** car radius of the last tick (m, 0 = sim suspended) */
  simRadius = 0;
  private busQueue: { spawn: NonNullable<TickMsg['busSpawn']>; patterns: NonNullable<TickMsg['busPatterns']>; retrip: NonNullable<TickMsg['busRetrip']>; pullout: NonNullable<TickMsg['busPullout']>; pullin: NonNullable<TickMsg['busPullin']> } = { spawn: [], patterns: [], retrip: [], pullout: [], pullin: [] };

  /** queue bus trips to become agents (patterns once per id) / to continue as their block's next trip */
  requestBuses(spawn: NonNullable<TickMsg['busSpawn']>, patterns: NonNullable<TickMsg['busPatterns']>, retrip: NonNullable<TickMsg['busRetrip']> = [], pullout: NonNullable<TickMsg['busPullout']> = [], pullin: NonNullable<TickMsg['busPullin']> = []) {
    this.busQueue.spawn.push(...spawn);
    this.busQueue.patterns.push(...patterns);
    this.busQueue.retrip.push(...retrip);
    this.busQueue.pullout.push(...pullout);
    this.busQueue.pullin.push(...pullin);
  }

  /** Latest bus agent records + lane paths (views into the shared buffer), or null. */
  busSnapshot() {
    if (!this.hdr) return null;
    const seq = Atomics.load(this.hdr, H.SEQ);
    if (seq === 0) return null;
    const slot = Atomics.load(this.hdr, H.SLOT);
    const base = HEADER_BYTES + slot * SLOT_BYTES;
    const si = new Int32Array(this.sab, base, 12);
    const sf = new Float64Array(this.sab, base, 8);
    const count = si[11], pts = sf[6];
    return {
      count, oe: sf[1], on: sf[2], simMs: sf[3],
      f: new Float32Array(this.sab, base + BUS_OFFSET, count * BUS_STRIDE),
      u: new Uint32Array(this.sab, base + BUS_OFFSET, count * BUS_STRIDE),
      path: new Float32Array(this.sab, base + BUS_PATH_OFFSET, pts * 3),
    };
  }

  /** [trains, overlaps (total), overruns (total), turnbacks, pull-outs, pull-ins, parked] */
  railStats(): number[] {
    if (!this.hf) return [0, 0, 0, 0, 0, 0, 0];
    return [...[0, 1, 2, 3].map((i) => this.hf[HF.RAIL + i]), ...[0, 1, 2].map((i) => this.hf[HF.RAILX + i])];
  }

  /** player train state (RAILP fields), or null when not driving a train */
  railPlayerState(): Float64Array | null {
    if (!this.hf || !this.hf[HF.RAILP]) return null;
    return this.hf.subarray(HF.RAILP, HF.RAILP + 14);
  }

  /** The player drives trip `trip` (local index) of rail feed `agency`. */
  railPlayerAttach(agency: string, trip: number): Promise<boolean> {
    const feed = this.railFeeds.indexOf(agency);
    if (feed < 0 || !this.worker) return Promise.resolve(false);
    return new Promise((res) => {
      this.railWaiters.push(res);
      this.post({ type: 'railPlayer', feed, trip });
    });
  }

  railPlayerRelease() {
    this.railCmd = null;
    this.post({ type: 'railRelease' });
  }

  /** player train controller: cmd -1 (full service brake) .. 1 (full power) */
  setRailCommand(cmd: number, emergency = false) {
    this.railCmd = { cmd, emergency };
  }

  // ------------------------------------------------------------------------ public API

  /** Transit stop positions for waiting crowds (world E/N/elev). */
  setStops(x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>) {
    const xyz = new Float64Array(x.length * 3);
    for (let i = 0; i < x.length; i++) { xyz[i * 3] = x[i]; xyz[i * 3 + 1] = y[i]; xyz[i * 3 + 2] = z[i]; }
    this.post({ type: 'stops', xyz }, [xyz.buffer]);
  }

  /** Place the player car on the nearest drivable lane (resolves false if no road within ~400 m is loaded). */
  spawnPlayerCar(e: number, n: number, headingRad = 0): Promise<boolean> {
    return this.request({ type: 'spawnPlayer', e, n, heading: headingRad });
  }

  /** Convert the AI car nearest to (e, n) into the player car. */
  takeOverNearestCar(e: number, n: number, radius = 40): Promise<boolean> {
    const id = this.pickCar(e, n, radius);
    if (id === null) return Promise.resolve(false);
    return this.request({ type: 'takeOver', id });
  }

  /** Convert a specific AI car (id from pickCar) into the player car. */
  takeOverCar(id: number): Promise<boolean> {
    return this.request({ type: 'takeOver', id });
  }

  setPlayerInput(i: Partial<PlayerInput>) {
    Object.assign(this.input, i);
    this.keyboard = false;
  }

  getPlayer(): PlayerState | null {
    if (!this.playerActive || !this.hf || !this.hf[HF.PLAYER]) return null;
    const p = this.hf, b = HF.PLAYER;
    return { e: p[b + 1], n: p[b + 2], elev: p[b + 3], heading: p[b + 4], speed: p[b + 5], pitch: p[b + 6], onRoad: !!p[b + 7], roadName: this.roadName, carId: p[b + 11] };
  }

  /** Hand the car back to the AI (or remove it when off-road). */
  releasePlayer() {
    this.post({ type: 'releasePlayer' });
    this.setPlayerMode(false);
  }

  get isDriving() { return this.playerActive; }

  /** Id of the car nearest to (e, n) within `radius` m, or null. */
  pickCar(e: number, n: number, radius = 8): number | null {
    const snap = this.snapshot();
    if (!snap) return null;
    const { f, u, count, oe, on } = snap;
    let best = radius * radius, id: number | null = null;
    for (let i = 0; i < count; i++) {
      const o = i * CAR_STRIDE;
      const dx = f[o] + oe - e, dy = f[o + 1] + on - n;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; id = u[o + 7]; }
    }
    return id;
  }

  /** World position of a car by id (for following / selection). */
  carPosition(id: number): { e: number; n: number; elev: number; heading: number; speed: number } | null {
    const snap = this.snapshot();
    if (!snap) return null;
    const { f, u, count, oe, on } = snap;
    for (let i = 0; i < count; i++) {
      const o = i * CAR_STRIDE;
      if (u[o + 7] === id) {
        const e = f[o] + oe, n = f[o + 1] + on;
        const g = this.ground?.at(e, n);
        const elev = (u[o + 6] >>> 24) & 8 || !Number.isFinite(g) ? f[o + 2] : g + ROAD_LIFT;
        return { e, n, elev, heading: f[o + 3], speed: f[o + 5] };
      }
    }
    return null;
  }

  /**
   * Distance (m) from (e, n) along `heading` to the nearest car whose body
   * intersects the corridor [0, lookahead] × [−halfWidth, halfWidth], or null.
   * Uses the latest sim snapshot (extrapolated to now).
   */
  queryAhead(e: number, n: number, heading: number, lookahead: number, halfWidth: number): number | null {
    const q = this.carGrid();
    if (!q || !q.count) return null;
    const c = Math.cos(heading), s = Math.sin(heading);
    const CELL = 20;
    const ex = e + c * lookahead, ny = n + s * lookahead;
    const pad = halfWidth + 6;
    const x0 = Math.floor((Math.min(e, ex) - pad) / CELL), x1 = Math.floor((Math.max(e, ex) + pad) / CELL);
    const y0 = Math.floor((Math.min(n, ny) - pad) / CELL), y1 = Math.floor((Math.max(n, ny) + pad) / CELL);
    let best: number | null = null;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const list = this.qGrid.get(gx * 100003 + gy);
        if (!list) continue;
        for (const i of list) {
          const dx = q.e[i] - e, dy = q.n[i] - n;
          const a = dx * c + dy * s, b = -dx * s + dy * c;
          // extent of the car's box along / across the corridor
          const rc = Math.cos(q.h[i] - heading), rs = Math.sin(q.h[i] - heading);
          const ea = Math.abs(rc) * q.hl[i] + Math.abs(rs) * q.hw[i];
          const eb = Math.abs(rs) * q.hl[i] + Math.abs(rc) * q.hw[i];
          if (a + ea < 0 || a - ea > lookahead || Math.abs(b) - eb > halfWidth) continue;
          const d = Math.max(0, a - ea);
          if (best === null || d < best) best = d;
        }
      }
    }
    return best;
  }

  /**
   * Distance (m) from (e, n) along `heading` to the stop line of a signalised
   * approach travelled in that direction whose light is red or amber, or null.
   */
  signalAhead(e: number, n: number, heading: number, lookahead: number): number | null {
    const sg = this.signalGrid();
    if (!sg || !sg.count) return null;
    const c = Math.cos(heading), s = Math.sin(heading);
    const CELL = 50;
    const ex = e + c * lookahead, ny = n + s * lookahead;
    const x0 = Math.floor((Math.min(e, ex) - 20) / CELL), x1 = Math.floor((Math.max(e, ex) + 20) / CELL);
    const y0 = Math.floor((Math.min(n, ny) - 20) / CELL), y1 = Math.floor((Math.max(n, ny) + 20) / CELL);
    let best: number | null = null;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const list = this.sGrid.get(gx * 100003 + gy);
        if (!list) continue;
        for (const i of list) {
          if (sg.light[i] === 0) continue;
          const db = Math.abs(Math.atan2(Math.sin(sg.b[i] - heading), Math.cos(sg.b[i] - heading)));
          if (db > 0.6) continue;
          const dx = sg.e[i] - e, dy = sg.n[i] - n;
          const a = dx * c + dy * s, b = -dx * s + dy * c;
          if (a < 0 || a > lookahead || Math.abs(b) > sg.hw[i] + 1.5) continue;
          if (best === null || a < best) best = a;
        }
      }
    }
    return best;
  }

  stats(): TrafficStats {
    const snap = this.snapshot();
    if (!this.hdr) return { cars: 0, peds: 0, targetCars: 0, targetPeds: 0, stepMs: 0, stepAvgMs: 0, fillMs: 0, substeps: 0, tiles: 0, pendingTiles: 0, fast: false };
    return {
      cars: snap?.count ?? 0, peds: snap?.pedCount ?? 0,
      targetCars: this.hf[HF.TARGET_CARS], targetPeds: this.hf[HF.TARGET_PEDS],
      stepMs: this.hf[HF.STEP_MS], stepAvgMs: this.hf[HF.STEP_AVG], fillMs: this.fillMs, substeps: this.hdr[H.SUBSTEPS],
      tiles: this.hdr[H.TILES], pendingTiles: this.hdr[H.PENDING], fast: this.hdr[H.FAST] === 1,
    };
  }

  // ------------------------------------------------------------------------ internals

  private request(m: ToWorker): Promise<boolean> {
    if (!this.worker || !this.ready) return Promise.resolve(false);
    return new Promise((res) => { this.waiters.push(res); this.post(m); });
  }

  private setPlayerMode(on: boolean) {
    const was = this.playerActive;
    this.playerActive = on;
    if (on && !was) {
      this.keyboard = true;
      if (this.chaseCamera) {
        this.engine.controls.follow(() => {
          const p = this.getPlayer();
          return p ? { e: p.e, n: p.n, h: p.elev + 1.2 } : null;
        }, { dist: 17, pitch: 0.24 });
      }
    }
    if (!on && was) {
      this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
      this.keys.clear();
      if (this.chaseCamera && this.engine.controls.following) this.engine.controls.follow(null);
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.playerActive) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.code === 'Escape') { this.releasePlayer(); return; }
    if (!DRIVE_KEYS.has(e.code)) return;
    this.keys.add(e.code);
    this.keyboard = true;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!DRIVE_KEYS.has(e.code)) return;
    this.keys.delete(e.code);
    if (this.playerActive) e.stopImmediatePropagation();
  };

  private onBlur = () => this.keys.clear();

  private keyboardInput(dt: number) {
    if (!this.keyboard) return;
    const k = this.keys;
    const i = this.input;
    i.throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    i.brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    const want = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    // steer ramps (keyboard is binary)
    const rate = want === 0 ? 5 : 2.6;
    i.steer += THREE.MathUtils.clamp(want - i.steer, -rate * dt, rate * dt);
    i.handbrake = k.has('Space');
  }

  /** Latest published snapshot (views into the shared buffer). */
  snapshot() {
    if (!this.hdr) return null;
    const slot = Atomics.load(this.hdr, H.SLOT);
    const seq = Atomics.load(this.hdr, H.SEQ);
    if (seq === 0) return null;
    const base = HEADER_BYTES + slot * SLOT_BYTES;
    const si = new Int32Array(this.sab, base, 10);
    const sf = new Float64Array(this.sab, base, 4);
    const count = si[0], pedCount = si[1], sigCount = si[8];
    return {
      seq, count, pedCount, sigCount, oe: sf[1], on: sf[2], simMs: sf[3],
      f: new Float32Array(this.sab, base + SLOT_HEADER, count * CAR_STRIDE),
      u: new Uint32Array(this.sab, base + SLOT_HEADER, count * CAR_STRIDE),
      pf: new Float32Array(this.sab, base + SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4, pedCount * PED_STRIDE),
      pu: new Uint32Array(this.sab, base + SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4, pedCount * PED_STRIDE),
      sg: new Float32Array(this.sab, base + SIG_OFFSET, sigCount * SIG_STRIDE),
    };
  }

  /** spatial hash of the latest car bodies (rebuilt once per snapshot) */
  private carGrid() {
    const snap = this.snapshot();
    if (!snap) return null;
    if (snap.seq === this.qSeq) return this.qCars;
    this.qSeq = snap.seq;
    const q = this.qCars;
    const { f, u, count, oe, on } = snap;
    if (q.e.length < count) {
      const cap = Math.max(count, 1024) * 2;
      q.e = new Float64Array(cap); q.n = new Float64Array(cap); q.h = new Float32Array(cap); q.hl = new Float32Array(cap); q.hw = new Float32Array(cap);
    }
    const dtx = THREE.MathUtils.clamp((clock.simMs - snap.simMs) / 1000, 0, 0.12);
    this.qGrid.clear();
    for (let i = 0; i < count; i++) {
      const o = i * CAR_STRIDE;
      const kind = u[o + 6] & 0xff;
      const h = f[o + 3], adv = f[o + 5] * dtx;
      q.e[i] = f[o] + oe + Math.cos(h) * adv;
      q.n[i] = f[o + 1] + on + Math.sin(h) * adv;
      q.h[i] = h;
      q.hl[i] = (CAR_LENGTH[kind] ?? 4.7) / 2;
      q.hw[i] = HALF_W[kind] ?? 0.95;
      const k = Math.floor(q.e[i] / 20) * 100003 + Math.floor(q.n[i] / 20);
      const l = this.qGrid.get(k);
      if (l) l.push(i); else this.qGrid.set(k, [i]);
    }
    q.count = count;
    return q;
  }

  private signalGrid() {
    const snap = this.snapshot();
    if (!snap) return null;
    if (snap.seq === this.sSeq) return this.sig;
    this.sSeq = snap.seq;
    const s = this.sig;
    const { sg, sigCount, oe, on } = snap;
    if (s.e.length < sigCount) {
      const cap = sigCount * 2;
      s.e = new Float64Array(cap); s.n = new Float64Array(cap); s.b = new Float32Array(cap); s.hw = new Float32Array(cap); s.light = new Uint8Array(cap);
    }
    this.sGrid.clear();
    for (let i = 0; i < sigCount; i++) {
      const o = i * SIG_STRIDE;
      s.e[i] = sg[o] + oe; s.n[i] = sg[o + 1] + on; s.b[i] = sg[o + 2]; s.hw[i] = sg[o + 3]; s.light[i] = sg[o + 4];
      const k = Math.floor(s.e[i] / 50) * 100003 + Math.floor(s.n[i] / 50);
      const l = this.sGrid.get(k);
      if (l) l.push(i); else this.sGrid.set(k, [i]);
    }
    s.count = sigCount;
    return s;
  }

  /** surface transit near the focus → obstacle records for the sim */
  private transitObstacles(): Float64Array | undefined {
    const src = ((window as unknown as { __transit?: StopSource }).__transit ?? this.stopSource) as StopSource | null;
    if (!src || typeof src.groundVehicles !== 'function') return undefined;
    let n = 0;
    try { n = src.groundVehicles(this.gv); } catch { return undefined; }
    if (typeof n !== 'number') n = this.gv.length;
    n = Math.min(n, this.gv.length, 2000);
    const out = new Float64Array(n * OB_STRIDE);
    for (let i = 0; i < n; i++) {
      const g = this.gv[i], o = i * OB_STRIDE;
      out[o] = g.e; out[o + 1] = g.n; out[o + 2] = g.heading; out[o + 3] = g.length; out[o + 4] = g.width; out[o + 5] = g.speed;
      let fl = g.rail || g.length > 20 ? OB_FLAG.RAIL : 0;
      if (g.doorsOpen !== undefined) fl |= OB_FLAG.DOORS_KNOWN | (g.doorsOpen ? OB_FLAG.DOORS_OPEN : 0);
      out[o + 6] = fl;
    }
    return out;
  }

  private sendTick(ctx: FrameContext, radius: number, pedRadius: number) {
    const parts = clock.parts();
    const pl = this.playerActive ? this.getPlayer() : null;
    const focusE = pl ? pl.e : ctx.focus.x;
    const focusN = pl ? pl.n : -ctx.focus.z;
    const m: TickMsg = {
      type: 'tick', simMs: clock.simMs, tod: parts.secOfDay, weekday: parts.weekday,
      simDt: this.accSim, realDt: this.accReal, focusE, focusN, radius, pedRadius,
      originE: ctx.anchor.origin.x, originN: -ctx.anchor.origin.z,
    };
    const obst = radius > 0 ? this.transitObstacles() : undefined;
    if (this.railProfile) { m.railProfile = this.railProfile; m.railRadius = this.railEnabled ? RAIL_RADIUS : 0; }
    if (this.railCmd) m.railCmd = this.railCmd;
    const qa = (window as unknown as { __qa?: Record<string, unknown> }).__qa;
    if (qa && this.hf) {
      qa.carsTarget = Math.round(this.hf[HF.TARGET_CARS]); qa.carsActive = this.hf[HF.CARS];
      qa.pedsTarget = Math.round(this.hf[HF.TARGET_PEDS]); qa.pedsActive = this.hf[HF.PEDS];
      qa.carsStoppedInBox = this.hf[HF.BOX_STOPPED];
      const P = HF.PHASES;
      qa.simPhasesMs = { prep: this.hf[P], follow: this.hf[P + 1], laneAdvance: this.hf[P + 2], spawn: this.hf[P + 3], peds: this.hf[P + 4], output: this.hf[HF.OUT_MS], rail: this.hf[HF.RAIL_MS], total: this.hf[HF.STEP_AVG] };
    }
    this.simRadius = radius;
    if (this.busQueue.spawn.length || this.busQueue.retrip.length || this.busQueue.patterns.length || this.busQueue.pullout.length || this.busQueue.pullin.length) {
      m.busSpawn = this.busQueue.spawn; m.busPatterns = this.busQueue.patterns; m.busRetrip = this.busQueue.retrip; m.busPullout = this.busQueue.pullout; m.busPullin = this.busQueue.pullin;
      this.busQueue = { spawn: [], patterns: [], retrip: [], pullout: [], pullin: [] };
    }
    {
      const cam = this.engine.camera;
      cam.getWorldDirection(this.camDir);
      m.camera = [ctx.cameraPos.x, -ctx.cameraPos.z, this.camDir.x, -this.camDir.z];
    }
    const transfer: Transferable[] = [];
    if (obst) { m.obst = obst; transfer.push(obst.buffer); }
    if (this.playerActive) {
      const i = this.input;
      m.player = {
        throttle: i.throttle, brake: i.brake, steer: i.steer, handbrake: i.handbrake,
        groundZ: this.engine.heightAt(pl?.e ?? focusE, pl?.n ?? focusN),
      };
    }
    this.post(m, transfer);
    this.ticksSent++;
    this.accSim = 0;
    this.accReal = 0;
  }

  /** drive the StreetLayer's signal heads from the sim's plans */
  private driveStreetSignals(ctx: FrameContext) {
    const street = (window as unknown as { __street?: StreetSignals }).__street;
    if (!street || !this.plans.length || ctx.time - this.streetAt < 0.25) return;
    this.streetAt = ctx.time;
    if (ctx.time - this.streetListAt > 3) {
      this.streetListAt = ctx.time;
      const list = street.listSignals();
      this.streetList = [];
      for (const s of list) {
        let p = this.planIndex.get(s.junction);
        if (p === undefined) {
          // signal tagged on an approach node: nearest sim signal within 45 m
          let bd = 45 * 45;
          for (let i = 0; i < this.plans.length; i += 7) {
            const d = (this.plans[i + 1] - s.e) ** 2 + (this.plans[i + 2] - s.n) ** 2;
            if (d < bd) { bd = d; p = i; }
          }
        }
        if (p !== undefined) this.streetList.push({ ...s, plan: p });
      }
    }
    const tod = clock.parts().secOfDay;
    for (const s of this.streetList) {
      // the head on an arm faces traffic arriving along it (travel = arm + π)
      const light = planLight(this.plans, s.plan, tod, s.armAngle + Math.PI);
      const st = (2 - light) as 0 | 1 | 2;
      const k = `${s.junction}:${s.armAngle.toFixed(3)}`;
      if (this.streetStates.get(k) === st) continue;
      this.streetStates.set(k, st);
      street.setSignal(s.junction, s.armAngle, st);
    }
  }

  update(ctx: FrameContext) {
    const st = useApp.getState();
    const alt = ctx.altitude;
    this.congestion?.update(ctx, st.analytics.congestion);
    if (!this.worker || !this.ready) return;

    // transit feeds load progressively: resend stops when their count changes
    const sc = this.stopSource?.system.stopCount ?? 0;
    if (this.stopSource && sc > 0 && sc !== this.stopsCount && ctx.time - this.stopsAt > 5) {
      this.stopsCount = sc;
      this.stopsAt = ctx.time;
      // street-level stops only (subway / rail stations have their own platforms)
      const s = this.stopSource.system.stops({ modes: ['bus', 'streetcar'] });
      this.setStops(s.x, s.y, s.z);
    }

    const show = st.layers.roads && st.analytics.vehicles && (alt < HIDE_ALTITUDE || this.playerActive);
    const radius = show ? this.radiusOverride ?? THREE.MathUtils.clamp(1300 + alt * 0.35, 1300, 2500) : 0;
    const pedRadius = alt < 1200 ? 900 : 450;
    this.keyboardInput(ctx.dt);
    this.accSim += ctx.simDt;
    this.accReal += ctx.dt;
    // back-pressure: one tick in flight at a time (sim time accumulates meanwhile)
    if (Atomics.load(this.hdr, H.ACK) >= this.ticksSent) this.sendTick(ctx, radius, pedRadius);
    if (show && alt < 2500) this.driveStreetSignals(ctx);

    if (this.playerActive && this.chaseCamera && this.engine.controls.following) {
      const p = this.getPlayer();
      if (p && Math.abs(p.speed) > 0.5) {
        // camera heading: clockwise from north; look along the direction of travel
        const target = Math.PI / 2 - p.heading + (p.speed < 0 ? Math.PI : 0);
        this.engine.controls.goal.heading = this.engine.controls.cur.heading + Math.atan2(Math.sin(target - this.engine.controls.cur.heading), Math.cos(target - this.engine.controls.cur.heading));
      }
    }

    if (show !== this.visible) {
      this.visible = show;
      this.group.visible = show;
    }
    if (!show) return;
    const f0 = performance.now();
    this.fill(ctx);
    this.fillMs = this.fillMs * 0.95 + (performance.now() - f0) * 0.05;

    if (ctx.time - this.statsLog > 15 && (window as unknown as { __trafficLog?: boolean }).__trafficLog) {
      this.statsLog = ctx.time;
      console.info('[traffic]', this.stats());
    }
  }

  private fill(ctx: FrameContext) {
    const snap = this.snapshot();
    if (!snap) return;
    const ax = ctx.anchor.origin.x, az = ctx.anchor.origin.z;
    this.group.position.set(ax, 0, az);
    this.ground.begin();
    const G = this.ground;
    const camE = ctx.cameraPos.x, camN = -ctx.cameraPos.z;
    const near2 = NEAR_GROUND * NEAR_GROUND;
    const night = U.night.value > 0.35 ? CAR_FLAG_HEAD : 0;
    const kz = Math.min(1, ctx.dt * 4);
    // snapshot origin → anchor-relative
    const dtx = THREE.MathUtils.clamp((clock.simMs - snap.simMs) / 1000, 0, 0.12);
    const { f, u, count, oe, on } = snap;
    for (const p of this.cars) p.count = 0;
    for (const p of this.carsLo) p.count = 0;
    const prevZ = this.zoff, nextZ = this.zoffNext;
    nextZ.clear();
    const view = ctx.view;
    const carNear2 = (CAR_NEAR * view.scale) ** 2;
    for (let i = 0; i < count; i++) {
      const o = i * CAR_STRIDE;
      const meta = u[o + 6];
      const kind = meta & 0xff;
      const flags = (meta >>> 16) & 0xff;
      const gbits = meta >>> 24;
      const id = u[o + 7];
      const h = f[o + 3], v = f[o + 5];
      const ch = Math.cos(h), sh = Math.sin(h);
      const player = (flags & CAR_FLAG.PLAYER) !== 0;
      const adv = player ? 0 : v * dtx;
      const e = f[o] + oe + ch * adv, n = f[o + 1] + on + sh * adv;
      const simZ = f[o + 2];
      const len = CAR_LENGTH[kind] ?? 4.7;
      // frustum cull (generous radius: the sim elevation can differ from the drawn ground)
      if (!player && !view.sphereEN(e, n, simZ, len * 0.5 + 4)) continue;
      const dc2 = view.dist2EN(e, n, simZ);
      const lo = !player && dc2 > carNear2;
      let pool: Pool;
      if (lo) {
        pool = this.carsLo[kind < KINDS ? kind : 0];
      } else {
        const vars = this.kindVariants[kind < KINDS ? kind : 0];
        let vi = vars[0];
        if (vars.length > 1) {
          const r = hash01(id);
          // taxis are rare; other alternates split evenly
          if (this.variants[vars[1]].key === 'taxi') vi = r < 0.04 ? vars[1] : vars[0];
          else vi = vars[Math.floor(r * vars.length) % vars.length];
        }
        pool = this.cars[vi];
      }
      const k = pool.count++;
      const structure = (gbits & 8) !== 0;
      // ground contact
      let z: number, pitch = f[o + 4], roll = 0;
      const d2 = lo ? Infinity : (e - camE) ** 2 + (n - camN) ** 2;
      const gc = G.at(e, n);
      if (d2 < near2 && Number.isFinite(gc)) {
        let target: number;
        if (structure) {
          target = simZ + 0.1 - gc;
        } else {
          const da = len * 0.32, dw = (HALF_W[kind] ?? 0.95) * 0.85;
          const zf = G.at(e + ch * da, n + sh * da), zr = G.at(e - ch * da, n - sh * da);
          const zl = G.at(e - sh * dw, n + ch * dw), zR = G.at(e + sh * dw, n - ch * dw);
          pitch = Math.atan2(zf - zr, 2 * da);
          roll = Math.atan2(zR - zl, 2 * dw);
          target = (zf + zr + zl + zR) * 0.25 - gc + ROAD_LIFT;
        }
        const prev = prevZ.get(id);
        const off = prev === undefined || Math.abs(prev - target) > 6 ? target : prev + (target - prev) * kz;
        nextZ.set(id, off);
        z = gc + off;
      } else {
        z = structure || !Number.isFinite(gc) ? simZ + (structure ? 0.1 : 0.04) : gc + ROAD_LIFT;
      }
      // basis (E, N, U): forward F, right R (rolled), up = R × F
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const Fx = ch * cp, Fy = sh * cp, Fz = sp;
      const cr = Math.cos(roll), sr = Math.sin(roll);
      let Rx = sh * cr, Ry = -ch * cr, Rz = sr;
      let Ux = Ry * Fz - Rz * Fy, Uy = Rz * Fx - Rx * Fz, Uz = Rx * Fy - Ry * Fx;
      const ul = Math.hypot(Ux, Uy, Uz) || 1; Ux /= ul; Uy /= ul; Uz /= ul;
      // re-orthogonalise R = F × U
      Rx = Fy * Uz - Fz * Uy; Ry = Fz * Ux - Fx * Uz; Rz = Fx * Uy - Fy * Ux;
      const m = pool.mesh.instanceMatrix.array as Float32Array;
      const b = k * 16;
      // three: (E, U, −N); columns = forward, up, right
      m[b] = Fx; m[b + 1] = Fz; m[b + 2] = -Fy; m[b + 3] = 0;
      m[b + 4] = Ux; m[b + 5] = Uz; m[b + 6] = -Uy; m[b + 7] = 0;
      m[b + 8] = Rx; m[b + 9] = Rz; m[b + 10] = -Ry; m[b + 11] = 0;
      m[b + 12] = e - ax; m[b + 13] = z; m[b + 14] = -(n) - az; m[b + 15] = 1;
      const c = carPalette[(meta >> 8) & 0xff & 15];
      const ca = pool.col.array as Float32Array;
      ca[k * 4] = c.r; ca[k * 4 + 1] = c.g; ca[k * 4 + 2] = c.b;
      ca[k * 4 + 3] = (flags & 0x0f) | night;
    }
    this.zoff = nextZ; this.zoffNext = prevZ;
    for (const p of this.cars) p.commit();
    for (const p of this.carsLo) p.commit();

    const { pf, pu, pedCount } = snap;
    for (const p of this.peds) p.count = 0;
    const pedsLo = this.pedsLo!;
    pedsLo.count = 0;
    const pedNear2 = (PED_NEAR * view.scale) ** 2, pedFar2 = (PED_FAR * view.scale) ** 2;
    for (let i = 0; i < pedCount; i++) {
      const o = i * PED_STRIDE;
      const e = pf[o] + snap.oe, n = pf[o + 1] + snap.on;
      const dp2 = view.dist2EN(e, n, pf[o + 2]);
      if (dp2 > pedFar2 || !view.sphereEN(e, n, pf[o + 2] + 1, 3)) continue;
      const meta = pu[o + 5];
      const colour = meta & 0xff;
      const state = (meta >> 8) & 0xff;
      const structure = (meta >> 16) & 1;
      const pool = dp2 > pedNear2 ? pedsLo : this.peds[colour % this.peds.length];
      const k = pool.count++;
      const h = pf[o + 3];
      const ch = Math.cos(h), sh = Math.sin(h);
      const g = structure ? NaN : G.at(e, n);
      // on the raised sidewalk except while crossing the carriageway
      const y = Number.isFinite(g) ? g + (state === 2 ? ROAD_LIFT : WALK_LIFT) : pf[o + 2] + 0.15;
      const m = pool.mesh.instanceMatrix.array as Float32Array;
      const b = k * 16;
      m[b] = ch; m[b + 1] = 0; m[b + 2] = -sh; m[b + 3] = 0;
      m[b + 4] = 0; m[b + 5] = 1; m[b + 6] = 0; m[b + 7] = 0;
      m[b + 8] = sh; m[b + 9] = 0; m[b + 10] = ch; m[b + 11] = 0;
      m[b + 12] = e - ax; m[b + 13] = y; m[b + 14] = -n - az; m[b + 15] = 1;
      const c = shirtPalette[colour % shirtPalette.length];
      const ca = pool.col.array as Float32Array;
      ca[k * 4] = c.r; ca[k * 4 + 1] = c.g; ca[k * 4 + 2] = c.b; ca[k * 4 + 3] = 0;
      const an = pool.extra!.array as Float32Array;
      an[k * 3] = pf[o + 4]; an[k * 3 + 1] = h; an[k * 3 + 2] = state === 0 || state === 2 ? 1 : 0;
    }
    for (const p of this.peds) p.commit();
    pedsLo.commit();
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('blur', this.onBlur);
    this.worker?.terminate();
    this.worker = null;
    for (const p of [...this.cars, ...this.carsLo, ...this.peds, ...(this.pedsLo ? [this.pedsLo] : [])]) {
      p.mesh.geometry.dispose();
      p.mesh.dispose();
    }
    this.group.removeFromParent();
    this.congestion?.dispose();
  }
}

/** instance flag understood by the car material: headlights on */
const CAR_FLAG_HEAD = 16;
