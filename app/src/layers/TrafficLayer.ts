// Agent-based local traffic + pedestrians (Rust/wasm in a worker, results via
// SharedArrayBuffer) rendered with instancing, the region-wide congestion
// overlay (statistical tier), and a player-drivable car.
//
// Headings in this API are radians counter-clockwise from +E (east).
import * as THREE from 'three/webgpu';
import { attribute, cos, float, mix, mod, sin, step, vec3, positionLocal, abs as tslAbs } from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { U } from '../render/uniforms';
import { clock } from '../state/clock';
import { useApp } from '../state/store';
import {
  CAR_FLAG, CAR_STRIDE, H, HEADER_BYTES, HF, MAX_CARS, MAX_PEDS, PED_STRIDE, SAB_BYTES, SLOT_BYTES, SLOT_HEADER,
  type FromWorker, type TickMsg, type ToWorker,
} from '../sim/protocol';
import { carGeometries, carPalette, pedestrianGeometry, shirtPalette } from './traffic/models';
import { CongestionOverlay } from './traffic/congestion';

export interface PlayerInput { throttle: number; brake: number; steer: number; handbrake: boolean }
export interface PlayerState { e: number; n: number; elev: number; heading: number; speed: number; pitch: number; onRoad: boolean; roadName: string | null; carId: number }
export interface TrafficStats { cars: number; peds: number; targetCars: number; targetPeds: number; stepMs: number; stepAvgMs: number; fillMs: number; substeps: number; tiles: number; pendingTiles: number; fast: boolean }

/** anything exposing transit stop positions (TransitLayer) */
interface StopSource { system: { stops(): { x: Float64Array; y: Float64Array; z: Float32Array }; stopCount?: number } }

const HIDE_ALTITUDE = 6000;
const KINDS = 6;
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

class Pool {
  mesh: THREE.InstancedMesh;
  col: THREE.InstancedBufferAttribute;
  extra: THREE.InstancedBufferAttribute;
  count = 0;
  constructor(geom: THREE.BufferGeometry, mat: THREE.Material, cap: number, extraSize: number, extraName: string, parent: THREE.Object3D, name: string) {
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.extra = new THREE.InstancedBufferAttribute(new Float32Array(cap * extraSize), extraSize);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.extra.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iCol', this.col);
    geom.setAttribute(extraName, this.extra);
    this.mesh = new THREE.InstancedMesh(geom, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    this.col.clearUpdateRanges(); this.col.addUpdateRange(0, this.count * 3); this.col.needsUpdate = true;
    this.extra.clearUpdateRanges(); this.extra.addUpdateRange(0, this.count * this.extra.itemSize); this.extra.needsUpdate = true;
  }
}

function carMaterial(): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = 'traffic-cars';
  const vc = attribute('color', 'vec3');
  const tint = attribute('tint', 'float');
  const lamp = attribute('lamp', 'float');
  const iCol = attribute('iCol', 'vec3');
  const iFlags = attribute('iFlags', 'float');
  m.colorNode = mix(vc, vc.mul(iCol), tint);
  const brake = mod(iFlags, 2);
  const head = step(0.5, lamp).mul(step(lamp, 1.5));
  const tail = step(1.5, lamp);
  const night = U.night;
  (m as unknown as { emissiveNode: unknown }).emissiveNode = vec3(1.0, 0.9, 0.7).mul(head).mul(night.mul(3.0))
    .add(vec3(1.0, 0.05, 0.02).mul(tail).mul(night.mul(1.2).add(brake.mul(2.2))));
  return m;
}

function pedMaterial(): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = 'traffic-peds';
  const vc = attribute('color', 'vec3');
  const tint = attribute('tint', 'float');
  const iCol = attribute('iCol', 'vec3');
  const anim = attribute('iAnim', 'vec3'); // phase, heading, moving
  const swing = attribute('swing', 'float');
  m.colorNode = mix(vc, vc.mul(iCol), tint);
  // limb swing along the walking direction + a small bob (instanced space)
  const s = sin(anim.x);
  const fwd = vec3(cos(anim.y), float(0), sin(anim.y).negate());
  const off = fwd.mul(swing.mul(s).mul(0.28).mul(anim.z));
  const bob = tslAbs(s).mul(0.035).mul(anim.z);
  m.positionNode = positionLocal.add(off).add(vec3(0, bob, 0));
  return m;
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
  private cars: Pool[] = [];
  private peds!: Pool;
  private ticksSent = 0;
  private stopsCount = 0;
  private stopsAt = -1e9;
  private accSim = 0;
  private accReal = 0;
  private stopSource: StopSource | null;
  private congestion: CongestionOverlay | null = null;
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
    this.group.name = 'traffic';
    engine.scene.add(this.group);
    const geoms = carGeometries();
    const cm = carMaterial();
    for (let k = 0; k < KINDS; k++) this.cars.push(new Pool(geoms[k], cm, MAX_CARS, 1, 'iFlags', this.group, `cars-${k}`));
    this.peds = new Pool(pedestrianGeometry(), pedMaterial(), MAX_PEDS, 3, 'iAnim', this.group, 'pedestrians');
    this.peds.mesh.castShadow = false;
    this.congestion = new CongestionOverlay(engine);
    this.congestion.bind((m) => this.post(m));

    if (typeof SharedArrayBuffer === 'undefined' || !crossOriginIsolated) {
      console.warn('[traffic] SharedArrayBuffer unavailable (page not cross-origin isolated): traffic disabled');
      return;
    }
    this.sab = new SharedArrayBuffer(SAB_BYTES);
    this.hdr = new Int32Array(this.sab, 0, 64);
    this.hf = new Float64Array(this.sab, 0, 32);
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
      case 'majorsGeom': this.congestion?.setGeometry(m); break;
      case 'majorsRatio': this.congestion?.setRatios(m.ratio); break;
    }
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
      if (u[o + 7] === id) return { e: f[o] + oe, n: f[o + 1] + on, elev: f[o + 2], heading: f[o + 3], speed: f[o + 5] };
    }
    return null;
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

  private snapshot() {
    if (!this.hdr) return null;
    const slot = Atomics.load(this.hdr, H.SLOT);
    const seq = Atomics.load(this.hdr, H.SEQ);
    if (seq === 0) return null;
    const base = HEADER_BYTES + slot * SLOT_BYTES;
    const si = new Int32Array(this.sab, base, 2);
    const sf = new Float64Array(this.sab, base, 4);
    const count = si[0], pedCount = si[1];
    return {
      seq, count, pedCount, oe: sf[1], on: sf[2], simMs: sf[3],
      f: new Float32Array(this.sab, base + SLOT_HEADER, count * CAR_STRIDE),
      u: new Uint32Array(this.sab, base + SLOT_HEADER, count * CAR_STRIDE),
      pf: new Float32Array(this.sab, base + SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4, pedCount * PED_STRIDE),
      pu: new Uint32Array(this.sab, base + SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4, pedCount * PED_STRIDE),
    };
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
    if (this.playerActive) {
      const i = this.input;
      m.player = {
        throttle: i.throttle, brake: i.brake, steer: i.steer, handbrake: i.handbrake,
        groundZ: this.engine.heightAt(pl?.e ?? focusE, pl?.n ?? focusN),
      };
    }
    this.post(m);
    this.ticksSent++;
    this.accSim = 0;
    this.accReal = 0;
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
      const s = this.stopSource.system.stops();
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
    // snapshot origin → anchor-relative
    const offE = snap.oe - ax, offN = snap.on + az;
    const dtx = THREE.MathUtils.clamp((clock.simMs - snap.simMs) / 1000, 0, 0.12);
    const { f, u, count } = snap;
    for (const p of this.cars) p.count = 0;
    for (let i = 0; i < count; i++) {
      const o = i * CAR_STRIDE;
      const meta = u[o + 6];
      const kind = meta & 0xff;
      const pool = this.cars[kind < KINDS ? kind : 0];
      const k = pool.count++;
      const h = f[o + 3], p = f[o + 4], v = f[o + 5];
      const ch = Math.cos(h), sh = Math.sin(h), cp = Math.cos(p), sp = Math.sin(p);
      const adv = (meta >> 16) & CAR_FLAG.PLAYER ? 0 : v * dtx;
      const x = f[o] + offE + ch * adv;
      const y = f[o + 2] + 0.04;
      const z = -(f[o + 1] + offN + sh * adv);
      const m = pool.mesh.instanceMatrix.array as Float32Array;
      const b = k * 16;
      // Ry(h) · Rz(p), column-major
      m[b] = ch * cp; m[b + 1] = sp; m[b + 2] = -sh * cp; m[b + 3] = 0;
      m[b + 4] = -ch * sp; m[b + 5] = cp; m[b + 6] = sh * sp; m[b + 7] = 0;
      m[b + 8] = sh; m[b + 9] = 0; m[b + 10] = ch; m[b + 11] = 0;
      m[b + 12] = x; m[b + 13] = y; m[b + 14] = z; m[b + 15] = 1;
      const c = carPalette[(meta >> 8) & 0xff & 15];
      const ca = pool.col.array as Float32Array;
      ca[k * 3] = c.r; ca[k * 3 + 1] = c.g; ca[k * 3 + 2] = c.b;
      (pool.extra.array as Float32Array)[k] = (meta >> 16) & 0xff;
    }
    for (const p of this.cars) p.commit();

    const { pf, pu, pedCount } = snap;
    const pool = this.peds;
    pool.count = 0;
    const m = pool.mesh.instanceMatrix.array as Float32Array;
    const ca = pool.col.array as Float32Array;
    const an = pool.extra.array as Float32Array;
    for (let i = 0; i < pedCount; i++) {
      const o = i * PED_STRIDE;
      const k = pool.count++;
      const h = pf[o + 3];
      const ch = Math.cos(h), sh = Math.sin(h);
      const b = k * 16;
      m[b] = ch; m[b + 1] = 0; m[b + 2] = -sh; m[b + 3] = 0;
      m[b + 4] = 0; m[b + 5] = 1; m[b + 6] = 0; m[b + 7] = 0;
      m[b + 8] = sh; m[b + 9] = 0; m[b + 10] = ch; m[b + 11] = 0;
      m[b + 12] = pf[o] + offE; m[b + 13] = pf[o + 2] + 0.15; m[b + 14] = -(pf[o + 1] + offN); m[b + 15] = 1;
      const meta = pu[o + 5];
      const c = shirtPalette[(meta & 0xff) % shirtPalette.length];
      ca[k * 3] = c.r; ca[k * 3 + 1] = c.g; ca[k * 3 + 2] = c.b;
      const state = (meta >> 8) & 0xff;
      an[k * 3] = pf[o + 4]; an[k * 3 + 1] = h; an[k * 3 + 2] = state === 0 || state === 2 ? 1 : 0;
    }
    pool.commit();
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('blur', this.onBlur);
    this.worker?.terminate();
    this.worker = null;
    for (const p of [...this.cars, this.peds]) {
      p.mesh.geometry.dispose();
      p.mesh.dispose();
    }
    this.group.removeFromParent();
    this.congestion?.dispose();
  }
}
