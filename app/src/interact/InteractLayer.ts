// Interaction + agent takeover: picking/selection, camera modes (follow, cab,
// passenger), operating a transit vehicle, walking and riding. Registered as a
// Layer; takes over the camera by wrapping CameraController.update while a
// non-free mode is active. Exposed as window.__interact.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { MarkerOverlay } from '../render/overlay/MarkerOverlay';
import { LineOverlay } from '../render/overlay/LineOverlay';
import { clock } from '../state/clock';
import { useApp } from '../state/store';
import type { TransitLayer } from '../layers/TransitLayer';
import { MODES, STATE_DWELL, type Mode, type TripInfo, type VehicleState } from '../transit';
import { pathForTrip, type PatternPath, type Pose } from './path';
import { DYN, EB, MAX_NOTCH, TrainOperator } from './operate';
import { TunnelBuilder } from './tunnel';
import { Walker } from './walker';
import { useInteract, type CamMode, type WalkInfo } from './state';
import { beep, doorChime, doorsOpen, horn } from './audio';

const WIDTH: Record<Mode, number> = { subway: 3.1, lrt: 2.65, streetcar: 2.54, commuter_rail: 3.0, airport_rail: 3.1, intercity_rail: 3.1, bus: 2.6 };
const PICK_PX = 12;

type View = 'cab' | 'chase' | 'ride';

/** Duck-typed hooks of the (optional) TrafficLayer. */
interface TrafficApi {
  id: string;
  pickCar?(e: number, n: number, r: number): unknown;
  takeOverNearestCar?(e: number, n: number): Promise<boolean> | boolean;
  takeOverCar?(id: number): Promise<boolean> | boolean;
  getPlayer?(): { e: number; n: number; elev?: number; heading?: number; speed?: number; roadName?: string | null } | null;
  setPlayerInput?(inp: { throttle: number; brake: number; steer: number; handbrake?: boolean }): void;
  releasePlayer?(): void;
}

export interface PickResult {
  kind: 'vehicle' | 'stop' | 'car';
  trip?: number;
  stop?: number;
  car?: unknown;
  label: string;
  sub?: string;
}

export class InteractLayer implements Layer {
  readonly id = 'interact';
  private engine!: Engine;
  private transit!: TransitLayer;
  private dom!: HTMLElement;
  private tip!: HTMLDivElement;
  private pin!: MarkerOverlay;
  private stopMarks!: MarkerOverlay;
  private routeHi!: LineOverlay;
  private routeHiUnder!: LineOverlay;
  private hiRoute: number | null = null;
  readonly tunnel: TunnelBuilder;
  private walker: Walker | null = null;

  // camera rig
  mode: CamMode = 'free';
  view: View = 'chase';
  trip: number | null = null;
  private tripInfo: TripInfo | null = null;
  private path: PatternPath | null = null;
  op: TrainOperator | null = null;
  private yaw = 0; // follow orbit yaw offset (rad) relative to behind-the-vehicle
  private pitch = 0.32;
  private dist = 120;
  private lookYaw = 0;
  private lookPitch = 0;
  private lastLook = 0;
  private camSmooth: { e: number; n: number; z: number; le: number; ln: number; lz: number } | null = null;
  private savedFov = 50;
  private boardedFromWalk = false;
  private drivingCar = false;

  // input
  private keys = new Set<string>();
  private down: { x: number; y: number; t: number; btn: number; lx: number; ly: number } | null = null;
  private mouse: { x: number; y: number; moved: boolean } = { x: -1, y: -1, moved: false };
  private hover: PickResult | null = null;
  private time = 0;
  private uiAcc = 0;
  private stopsCache: { index: Int32Array; x: Float64Array; y: Float64Array; z: Float32Array; mode: Uint8Array } | null = null;
  private stopsTrips = -1;
  private stopGrid = new Map<number, number[]>();
  private visStops: number[] = []; // indices into stopsCache
  private visAcc = 1;
  private vsTmp: VehicleState | null = null;
  private pose: Pose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
  private walkNear: { trip: number; label: string } | null = null;

  constructor() {
    this.tunnel = new TunnelBuilder((e, n) => this.engine.heightAt(e, n));
  }

  async init(engine: Engine) {
    this.engine = engine;
    const t = engine.layers.find((l) => l.id === 'transit') as TransitLayer | undefined;
    if (!t) throw new Error('InteractLayer needs the TransitLayer');
    this.transit = t;
    this.dom = engine.renderer.domElement;
    engine.scene.add(this.tunnel.group);

    this.pin = new MarkerOverlay(engine, { name: 'sel-pin', capacity: 1, shape: 'diamond', size: [5, 7, 5], minPixels: 13, depthMode: 'onTop', lift: 14 });
    const discGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 16).translate(0, 0.5, 0);
    this.stopMarks = new MarkerOverlay(engine, { name: 'stops', capacity: 4000, shape: discGeo, size: [8, 1.2, 8], minPixels: 5, lift: 0.3 });
    this.routeHiUnder = new LineOverlay(engine, { name: 'route-hi-under', width: 11, depthMode: 'onTop', lift: 6, order: 128 });
    this.routeHi = new LineOverlay(engine, { name: 'route-hi', width: 6, depthMode: 'onTop', lift: 6, order: 129 });

    this.tip = document.createElement('div');
    this.tip.className = 'pick-tip';
    this.tip.style.display = 'none';
    this.dom.parentElement?.appendChild(this.tip);

    this.dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.dom.addEventListener('pointerleave', this.onLeave);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);

    // wrap the camera controller: our rig drives the camera in non-free modes
    const ctl = engine.controls;
    const orig = ctl.update.bind(ctl);
    ctl.update = (dt: number) => {
      this.preFrame(dt);
      if (this.mode === 'free') orig(dt);
      else this.rig(dt);
    };
    Object.assign(window as object, { __interact: this });
  }

  // ======================================================================= public API

  get system() { return this.transit.system; }

  now(): number { return clock.serviceDay().sec; }

  selectVehicle(trip: number | null) {
    const st = useApp.getState();
    if (trip === null) { st.select(null); return; }
    const info = this.system.tripInfo(trip);
    st.select({ kind: 'vehicle', id: String(trip), label: info ? `${info.routeMeta.short} ${info.headsign}` : `trip ${trip}` });
  }

  selectStop(stop: number | null) {
    const st = useApp.getState();
    if (stop === null) { st.select(null); return; }
    st.select({ kind: 'stop', id: String(stop), label: this.system.stopName(stop) });
    useInteract.getState().set({ highlightRoute: null });
  }

  highlightRoute(route: number | null) {
    if (route === this.hiRoute) return;
    this.hiRoute = route;
    useInteract.getState().set({ highlightRoute: route });
    if (route === null) { this.routeHi.clear(); this.routeHiUnder.clear(); return; }
    const meta = this.system.routes[route];
    const rls = this.system.routeLines({ modes: [meta.mode] }).filter((r) => r.route === route);
    const hi = rls.flatMap((rl) => rl.lines.map((pts, i) => ({ id: `${i}`, points: pts, color: meta.color })));
    this.routeHi.set(hi);
    this.routeHiUnder.set(hi.map((h) => ({ ...h, color: 0x0b0e13 })));
  }

  /** bounding box of a route's lines (for fly-to) */
  routeBounds(route: number): { e: number; n: number; size: number } | null {
    const meta = this.system.routes[route];
    if (!meta) return null;
    const rls = this.system.routeLines({ modes: [meta.mode] }).filter((r) => r.route === route);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const rl of rls) for (const l of rl.lines) for (let i = 0; i < l.length; i += 3) {
      x0 = Math.min(x0, l[i]); x1 = Math.max(x1, l[i]); y0 = Math.min(y0, l[i + 1]); y1 = Math.max(y1, l[i + 1]);
    }
    if (!isFinite(x0)) return null;
    return { e: (x0 + x1) / 2, n: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) };
  }

  /** Chase camera on a vehicle. */
  follow(trip: number) { this.attach(trip, 'follow', 'chase'); }
  /** Driver's-eye view of a scheduled vehicle. */
  cab(trip: number) { this.attach(trip, 'cab', 'cab'); }
  /** Passenger view (side window). */
  ride(trip: number) { this.attach(trip, 'ride', 'ride'); }

  /** Take control of a trip: detach it from the schedule. */
  operate(trip: number): boolean {
    const t = this.now();
    const info = this.system.tripInfo(trip);
    const vs = this.system.vehicleAt(trip, t);
    if (!info || !vs) { this.toast('That vehicle is not in service right now'); return false; }
    const path = pathForTrip(this.system, info);
    if (!path) return false;
    this.leave(false);
    const op = new TrainOperator(info, path, vs.dist, vs.speed, vs.state === STATE_DWELL, t);
    this.op = op;
    this.trip = trip;
    this.tripInfo = info;
    this.path = path;
    this.mode = 'operate';
    this.view = 'cab';
    this.enterRig();
    this.transit.overrides.set(trip, null);
    // realtime while driving
    const st = useApp.getState();
    st.setSpeedIndex(1);
    if (!st.playing) st.togglePlay();
    this.selectVehicle(trip);
    this.tunnel.setPath(path, info.mode, op.dyn.length);
    useInteract.getState().set({ mode: 'operate', trip, ride: null, walk: null });
    op.flash(vs.state === STATE_DWELL ? 'You have control — close doors (C) when ready' : 'You have control — W/S to notch, O/C doors', 5);
    return true;
  }

  /** Spawn the pedestrian at a point. */
  walkAt(e: number, n: number) {
    this.leave(false);
    if (!this.walker) {
      this.walker = new Walker();
      this.engine.scene.add(this.walker.group);
    }
    this.walker.group.visible = true;
    const h = this.engine.heightAt(e, n);
    // face the way the camera looks
    const cam = this.engine.controls.cur;
    this.walker.place(e, n, h, Math.PI / 2 - cam.heading);
    this.yaw = this.walker.heading;
    this.pitch = 0.28;
    this.dist = 7;
    this.mode = 'walk';
    this.view = 'chase';
    this.enterRig();
    const st = useApp.getState();
    st.setSpeedIndex(1);
    if (!st.playing) st.togglePlay();
    useInteract.getState().set({ mode: 'walk', trip: null, placing: false, op: null, ride: null });
  }

  /** Walker boards a dwelling vehicle. */
  board(trip: number) {
    const w = this.walker;
    this.attach(trip, 'ride', 'ride');
    this.boardedFromWalk = true;
    if (w) w.group.visible = false;
    this.toast(`Boarded — press E to get off at a stop · ] to speed up time`);
  }

  /** Walker gets off at the current stop. */
  alight() {
    const trip = this.trip;
    if (trip === null) return;
    const vs = this.system.vehicleAt(trip, this.now());
    const pose = this.pose;
    let e = pose.e, n = pose.n;
    let heading = pose.heading;
    const mode = this.tripInfo?.mode ?? 'bus';
    const under = vs ? this.engine.heightAt(vs.x, vs.y) - vs.z > 4.5 : false;
    if (vs && under) {
      // underground: come up at the station
      const p = this.system.stopPosition(vs.nextStop);
      e = p[0] + 6; n = p[1] + 6;
    } else {
      const off = WIDTH[mode] / 2 + 1.8;
      e += Math.sin(heading) * off; n += -Math.cos(heading) * off;
    }
    const name = vs ? this.system.stopName(vs.nextStop) : '';
    this.boardedFromWalk = false;
    this.walkAt(e, n);
    this.walker!.heading = heading;
    this.yaw = heading - 0.5; // look along the street, vehicle in view
    this.dist = 9;
    if (name) this.toast(`Arrived at ${name}`);
  }

  /** Try to take over the nearest car (TrafficLayer). Driving input is handled by the TrafficLayer. */
  async takeOverCar(e: number, n: number, carId?: number): Promise<boolean> {
    const tr = this.traffic();
    if (!tr?.takeOverNearestCar) { this.toast('Traffic simulation not loaded yet'); return false; }
    let ok = false;
    if (carId === undefined && tr.pickCar) {
      const id = tr.pickCar(e, n, 120);
      if (typeof id === 'number') carId = id;
    }
    try {
      ok = !!(await (carId !== undefined && tr.takeOverCar ? tr.takeOverCar(carId) : tr.takeOverNearestCar(e, n)));
    } catch (err) { console.warn(err); }
    if (!ok || !tr.getPlayer?.()) { this.toast('No car nearby — walk closer to a road'); return false; }
    this.leave(false);
    this.mode = 'drive';
    this.view = 'chase';
    this.drivingCar = true;
    this.yaw = 0; this.pitch = 0.22; this.dist = 16;
    this.enterRig();
    useInteract.getState().set({ mode: 'drive', trip: null, walk: null });
    this.toast('Driving — W/S throttle/brake, A/D steer, Space handbrake, Esc to exit');
    return true;
  }

  /** Enter "click the ground to place the walker" mode. */
  startPlacing() {
    useInteract.getState().set({ placing: true });
    this.toast('Click on the map to start walking there');
  }

  /** Back to the free bird's-eye camera. */
  exit() { this.leave(true); }

  setView(v: View) {
    if (this.mode === 'walk' || this.mode === 'drive' || this.mode === 'free') return;
    this.view = v;
    this.lookYaw = 0; this.lookPitch = 0;
    this.camSmooth = null;
    if (this.mode !== 'operate') {
      this.mode = v === 'cab' ? 'cab' : v === 'ride' ? 'ride' : 'follow';
      useInteract.getState().set({ mode: this.mode });
    }
    this.applyFov();
  }

  toast(msg: string) {
    useInteract.getState().set({ toast: msg });
    const m = msg;
    setTimeout(() => { if (useInteract.getState().toast === m) useInteract.getState().set({ toast: null }); }, 4000);
  }

  // ======================================================================= internals

  private traffic(): TrafficApi | null {
    return (this.engine.layers.find((l) => l.id === 'traffic') as unknown as TrafficApi) ?? null;
  }

  private attach(trip: number, mode: CamMode, view: View) {
    const info = this.system.tripInfo(trip);
    if (!info) return;
    const keepWalker = this.mode === 'walk';
    this.leave(false, keepWalker);
    this.trip = trip;
    this.tripInfo = info;
    this.path = pathForTrip(this.system, info);
    this.mode = mode;
    this.view = view;
    this.yaw = 0; this.pitch = 0.3;
    this.dist = Math.max(45, DYN[info.mode].length * 0.9);
    this.enterRig();
    this.tunnel.setPath(this.path, info.mode, DYN[info.mode].length);
    this.selectVehicle(trip);
    useInteract.getState().set({ mode, trip, op: null, walk: null });
  }

  private enterRig() {
    this.engine.controls.enabled = false;
    this.camSmooth = null;
    this.lookYaw = 0; this.lookPitch = 0;
    this.applyFov();
  }

  private applyFov() {
    if (useInteract.getState().view !== this.view) useInteract.getState().set({ view: this.view });
    const cam = this.engine.camera;
    const fov = this.mode === 'free' ? this.savedFov : this.view === 'cab' ? 58 : this.view === 'ride' ? 62 : 55;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  /** Leave the current mode. restore = put the free camera back. */
  private leave(restore: boolean, keepWalker = false) {
    const prev = this.mode;
    if (prev === 'free') { if (!keepWalker) this.hideWalker(); return; }
    if (this.op) {
      this.transit.overrides.delete(this.op.info.trip);
      this.op = null;
    }
    if (this.trip !== null) this.transit.overrides.delete(this.trip);
    if (this.drivingCar) {
      try { this.traffic()?.releasePlayer?.(); } catch { /* ignore */ }
      this.drivingCar = false;
    }
    if (!keepWalker && prev !== 'walk') this.hideWalker();
    if (prev === 'walk' && !keepWalker) this.hideWalker();
    this.boardedFromWalk = false;
    this.tunnel.setPath(null, 'subway', 0);
    const cam = this.engine.camera;
    this.mode = 'free';
    this.trip = null;
    this.tripInfo = null;
    this.path = null;
    this.applyFov();
    if (restore) {
      // free camera looking at what we were looking at
      const f = this.focusPoint();
      const dx = f.e - cam.position.x, dn = f.n + cam.position.z, dh = cam.position.y - f.h;
      const d = Math.max(20, Math.hypot(dx, dn, dh));
      const heading = Math.atan2(dx, dn);
      const pitch = Math.max(0.15, Math.asin(Math.max(-1, Math.min(1, dh / d))));
      const ctl = this.engine.controls;
      ctl.jumpTo({ e: f.e, n: f.n, h: this.engine.heightAt(f.e, f.n), dist: d, heading, pitch });
      void ctl.flyTo({ e: f.e, n: f.n, dist: Math.max(d, 450), pitch: Math.max(pitch, 0.55), heading }, 1.2);
    }
    this.engine.controls.enabled = true;
    useInteract.getState().set({ mode: 'free', trip: null, op: null, ride: null, walk: null });
  }

  private hideWalker() {
    if (this.walker) this.walker.group.visible = false;
  }

  private focusPoint(): { e: number; n: number; h: number } {
    if (this.walker?.group.visible) return { e: this.walker.e, n: this.walker.n, h: this.walker.h };
    const p = this.pose;
    const g = this.engine.heightAt(p.e, p.n);
    return { e: p.e, n: p.n, h: Math.max(p.z, g) };
  }

  /** Current pose of the attached vehicle (centre). Returns false if gone. */
  private targetPose(t: number): boolean {
    if (this.op) {
      this.op.path.pose(this.op.s, 6, this.pose);
      return true;
    }
    if (this.trip === null) return false;
    const vs = this.system.vehicleAt(this.trip, t);
    this.vsTmp = vs;
    if (!vs) return false;
    // held behind traffic? follow what is drawn, not the timetable ghost
    vs.dist = this.transit.displayDist(this.trip, vs.dist);
    if (this.path) this.path.pose(vs.dist, 6, this.pose);
    else Object.assign(this.pose, { e: vs.x, n: vs.y, z: vs.z, heading: vs.heading, pitch: vs.pitch });
    return true;
  }

  private currentDist(): number {
    if (this.op) return this.op.s;
    return this.vsTmp?.dist ?? 0;
  }

  // ------------------------------------------------------------------ per frame (before camera)

  private preFrame(dt: number) {
    this.time += dt;
    const t = this.now();
    const simDt = clock.lastDtSim;
    const op = this.op;
    if (op) {
      const vb = this.system.tripCount > 0 ? this.system.vehicles : null;
      const prevDoors = op.doors;
      op.step(Math.min(simDt, 2), t, vb);
      if (prevDoors !== op.doors) {
        if (op.doors === 'opening') doorsOpen();
        if (op.doors === 'closing') doorChime();
      }
      const p = op.path.pose(op.s, 6, this.pose);
      if (this.view !== 'chase') this.transit.overrides.set(op.info.trip, null);
      else this.transit.overrides.set(op.info.trip, { x: p.e, y: p.n, z: p.z, heading: p.heading, mode: op.mode, route: op.route, pattern: op.path.pattern, dist: op.s });
    }
    if (this.mode === 'walk' && this.walker) {
      const k = this.keys;
      const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      const right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      const run = k.has('ShiftLeft') || k.has('ShiftRight');
      this.walker.step(dt, fwd, right, this.yaw, run, (e, n) => this.engine.heightAt(e, n));
    }
  }

  // ------------------------------------------------------------------ camera rig

  private rig(dt: number) {
    const t = this.now();
    let eye: [number, number, number];
    let look: [number, number, number];
    const H = (e: number, n: number) => this.engine.heightAt(e, n);

    if (this.mode === 'walk' && this.walker) {
      const w = this.walker;
      // orbit behind the walker; yaw is the camera's look direction
      const cp = Math.cos(this.pitch);
      const d = this.dist;
      const le = w.e, ln = w.n, lz = w.h + 1.6;
      let ee = le - Math.cos(this.yaw) * cp * d, en = ln - Math.sin(this.yaw) * cp * d;
      let ez = lz + Math.sin(this.pitch) * d;
      ez = Math.max(ez, H(ee, en) + 0.6);
      // slightly over the right shoulder
      ee += Math.sin(this.yaw) * 0.6; en -= Math.cos(this.yaw) * 0.6;
      eye = [ee, en, ez];
      look = [le + Math.cos(this.yaw) * 4, ln + Math.sin(this.yaw) * 4, lz];
      this.setCam(eye, look, dt, 18);
      this.syncCtl(le, ln, w.h, d);
      return;
    }

    if (this.mode === 'drive') {
      const p = this.traffic()?.getPlayer?.();
      if (!p) { this.exit(); return; }
      const hd = p.heading ?? 0;
      const z = p.elev ?? H(p.e, p.n);
      const yaw = hd + this.yaw;
      const cp = Math.cos(this.pitch);
      eye = [p.e - Math.cos(yaw) * cp * this.dist, p.n - Math.sin(yaw) * cp * this.dist, z + 1.5 + Math.sin(this.pitch) * this.dist];
      eye[2] = Math.max(eye[2], H(eye[0], eye[1]) + 1);
      look = [p.e + Math.cos(hd) * 6, p.n + Math.sin(hd) * 6, z + 1.5];
      this.setCam(eye, look, dt, 6);
      this.syncCtl(p.e, p.n, z, this.dist);
      return;
    }

    if (!this.targetPose(t)) {
      // trip ended
      if (this.boardedFromWalk) { this.alight(); return; }
      this.toast('Trip ended');
      this.exit();
      return;
    }
    const pose = this.pose;
    const mode = this.tripInfo!.mode;
    const dyn = DYN[mode];
    // the consist actually drawn (car by car) sets where the cab is
    const L2 = (this.trip !== null ? this.transit.vehicleLength(this.trip) : 0) / 2 || dyn.length / 2;
    const s = this.currentDist();
    const reverse = this.op?.reverse ?? false;
    const dir = reverse ? -1 : 1;
    const path = this.path;
    const tmp = [0, 0, 0];
    const rail = (sAt: number, lift: number): [number, number, number] => {
      if (path) {
        // pose() extrapolates past the path ends (train front at a terminus)
        const q = path.pose(sAt, 6, _railPose);
        tmp[0] = q.e; tmp[1] = q.n; tmp[2] = q.z;
      } else { tmp[0] = pose.e; tmp[1] = pose.n; tmp[2] = pose.z; }
      // surface running: stay on top of the rendered terrain
      const g = H(tmp[0], tmp[1]);
      const z = tmp[2] < g - 4.5 ? tmp[2] : Math.max(tmp[2], g);
      return [tmp[0], tmp[1], z + lift];
    };
    const underground = H(pose.e, pose.n) - pose.z > 4.5;
    const idle = this.time - this.lastLook > 2.5;
    if (idle) { this.lookYaw *= Math.exp(-dt * 1.5); this.lookPitch *= Math.exp(-dt * 1.5); }

    if (this.view === 'cab') {
      const front = s + dir * (L2 - 1.2);
      eye = rail(front, dyn.eye);
      const ahead = rail(front + dir * Math.max(25, 12 + (this.op?.v ?? this.vsTmp?.speed ?? 0) * 1.2), dyn.eye - 0.4);
      const hd = Math.atan2(ahead[1] - eye[1], ahead[0] - eye[0]) + this.lookYaw;
      const dd = Math.hypot(ahead[0] - eye[0], ahead[1] - eye[1]);
      const pz = ahead[2] - eye[2] + Math.tan(this.lookPitch) * dd;
      look = [eye[0] + Math.cos(hd) * dd, eye[1] + Math.sin(hd) * dd, eye[2] + pz];
      this.setCam(eye, look, dt, 30);
    } else if (this.view === 'ride') {
      // seated by the left window looking out the right side
      const at = s - dir * L2 * 0.3;
      const c = rail(at, dyn.eye - 0.9);
      const hd = pose.heading + (reverse ? Math.PI : 0);
      const side = -WIDTH[mode] * 0.3;
      eye = [c[0] + Math.sin(hd) * side, c[1] - Math.cos(hd) * side, c[2]];
      const yaw = hd - Math.PI / 2 + 0.25 + this.lookYaw;
      look = [eye[0] + Math.cos(yaw) * 20, eye[1] + Math.sin(yaw) * 20, eye[2] - 1.2 + Math.tan(this.lookPitch) * 20];
      this.setCam(eye, look, dt, 30);
    } else if (underground && path) {
      // chase inside the tunnel: camera on the track behind the train
      const back = s - dir * (L2 + Math.min(this.dist * 0.25, 30));
      eye = rail(back, 3.4);
      look = rail(s + dir * L2 * 0.3, 1.6);
      this.setCam(eye, look, dt, 12);
    } else {
      // orbit chase
      const hd = pose.heading + (reverse ? Math.PI : 0);
      const yaw = hd + this.yaw;
      const cp = Math.cos(this.pitch);
      const c = rail(s, 2);
      eye = [c[0] - Math.cos(yaw) * cp * this.dist, c[1] - Math.sin(yaw) * cp * this.dist, c[2] + Math.sin(this.pitch) * this.dist];
      eye[2] = Math.max(eye[2], H(eye[0], eye[1]) + 2);
      look = c;
      this.setCam(eye, look, dt, 8);
    }
    this.syncCtl(pose.e, pose.n, pose.z, this.dist);
    // local track/tunnel geometry
    this.tunnel.update(s);
  }

  private setCam(eye: [number, number, number], look: [number, number, number], dt: number, rate: number) {
    let c = this.camSmooth;
    if (!c) c = this.camSmooth = { e: eye[0], n: eye[1], z: eye[2], le: look[0], ln: look[1], lz: look[2] };
    const k = 1 - Math.exp(-dt * rate);
    // big jumps (teleports): snap
    if (Math.hypot(eye[0] - c.e, eye[1] - c.n) > 400) { c.e = eye[0]; c.n = eye[1]; c.z = eye[2]; c.le = look[0]; c.ln = look[1]; c.lz = look[2]; }
    c.e += (eye[0] - c.e) * k; c.n += (eye[1] - c.n) * k; c.z += (eye[2] - c.z) * k;
    c.le += (look[0] - c.le) * k; c.ln += (look[1] - c.ln) * k; c.lz += (look[2] - c.lz) * k;
    const cam = this.engine.camera;
    cam.position.set(c.e, c.z, -c.n);
    cam.up.set(0, 1, 0);
    cam.lookAt(c.le, c.lz, -c.ln);
    cam.updateMatrixWorld();
  }

  private syncCtl(e: number, n: number, h: number, dist: number) {
    const ctl = this.engine.controls;
    ctl.cur.e = ctl.goal.e = e;
    ctl.cur.n = ctl.goal.n = n;
    ctl.cur.h = ctl.goal.h = h;
    ctl.cur.dist = ctl.goal.dist = dist;
    const cam = this.engine.camera;
    const dx = e - cam.position.x, dn = n + cam.position.z;
    if (Math.hypot(dx, dn) > 0.5) ctl.cur.heading = ctl.goal.heading = Math.atan2(dx, dn);
  }

  // ------------------------------------------------------------------ layer update (after camera)

  update(ctx: FrameContext) {
    const sys = this.system;
    if (sys.tripCount > 0 && this.stopsTrips !== sys.tripCount) this.buildStops();
    this.updateStopMarks(ctx);

    // hover
    if (this.mouse.moved && !this.down) {
      this.mouse.moved = false;
      this.hover = this.mode === 'free' || this.mode === 'follow' ? this.pick(this.mouse.x, this.mouse.y) : null;
      this.renderTip();
    }

    // selection ring follows the selected vehicle
    const sel = useApp.getState().selected;
    const t = this.transit.lastT || this.now();
    let ringOn = false;
    let selRing: Parameters<InteractLayer['showRing']>[2] = null;
    if (sel?.kind === 'vehicle' && (this.mode === 'free' || this.mode === 'follow')) {
      const trip = +sel.id;
      let x = 0, y = 0, z = 0, hd = 0, L = 30, found = false;
      if (this.op && this.op.info.trip === trip) {
        x = this.pose.e; y = this.pose.n; z = this.pose.z; hd = this.pose.heading; L = this.op.dyn.length; found = true;
      } else {
        const v = sys.vehicles;
        for (let i = 0; i < v.count; i++) {
          if (v.trip[i] !== trip) continue;
          x = v.x[i]; y = v.y[i]; z = v.z[i]; hd = v.heading[i]; L = DYN[MODES[v.mode[i]]].length; found = true;
          break;
        }
      }
      if (found) {
        ringOn = true;
        selRing = { L: L * 1.25, W: Math.max(L * 0.4, 12), x, y, z, hd, color: 0x4fd1ff };
        this.pin.setMarker(0, x, y, z + 6, hd + ctx.time, 0x4fd1ff);
      }
    } else if (sel?.kind === 'stop' && this.stopsCache) {
      const p = sys.stopPosition(+sel.id);
      ringOn = true;
      selRing = { L: 40, W: 40, x: p[0], y: p[1], z: Math.max(p[2], this.engine.heightAt(p[0], p[1])), hd: 0, color: 0x4fd1ff };
      this.pin.setMarker(0, p[0], p[1], Math.max(p[2], this.engine.heightAt(p[0], p[1])) + 6, ctx.time, 0x4fd1ff);
    }
    this.showRing('sel', ctx, selRing);
    this.pin.setCount(ringOn ? 1 : 0); this.pin.commit(); this.pin.update(ctx);

    // hover ring
    let hvRing: Parameters<InteractLayer['showRing']>[2] = null;
    const h = this.hover;
    if (h?.kind === 'vehicle' && h.trip !== undefined && !(sel?.kind === 'vehicle' && +sel.id === h.trip)) {
      const v = sys.vehicles;
      for (let i = 0; i < v.count; i++) {
        if (v.trip[i] !== h.trip) continue;
        const L = DYN[MODES[v.mode[i]]].length;
        hvRing = { L: L * 1.2, W: Math.max(L * 0.38, 10), x: v.x[i], y: v.y[i], z: v.z[i], hd: v.heading[i], color: 0xffffff };
        break;
      }
    } else if (h?.kind === 'stop' && h.stop !== undefined) {
      const p = sys.stopPosition(h.stop);
      hvRing = { L: 30, W: 30, x: p[0], y: p[1], z: Math.max(p[2], this.engine.heightAt(p[0], p[1])), hd: 0, color: 0xffffff };
    }
    this.showRing('hover', ctx, hvRing);

    // route highlight: search choice wins, else the selected vehicle's route
    const want = useInteract.getState().highlightRoute;
    if (want !== this.hiRoute) this.highlightRoute(want);
    const cp = ctx.cameraPos;
    const camUnder = this.engine.heightAt(cp.x, -cp.z) - cp.y > 2;
    const inside = this.mode !== 'free' && this.mode !== 'walk' && this.mode !== 'drive' && (this.view !== 'chase' || camUnder);
    document.body.classList.toggle('interact-inside', inside);
    document.body.classList.toggle('interact-ground', this.mode === 'walk' || this.mode === 'drive');
    this.routeHi.setVisible(!inside);
    this.routeHiUnder.setVisible(!inside);
    this.pin.setVisible(!inside);
    this.transit.hideLines = inside;
    // hide the vehicle we sit in (its body would block the camera)
    if (this.trip !== null && !this.op) {
      if (this.mode !== 'follow' && this.view !== 'chase') this.transit.overrides.set(this.trip, null);
      else this.transit.overrides.delete(this.trip);
    }
    this.routeHi.update(ctx);
    this.routeHiUnder.update(ctx);

    // UI telemetry at ~10 Hz
    this.uiAcc += ctx.dt;
    if (this.uiAcc > 0.1) {
      this.uiAcc = 0;
      this.pushUi(t);
    }
  }

  private ringCache = new Map<string, MarkerOverlay>();
  /** MarkerOverlay sizes are shader constants: keep one overlay per (kind, size). */
  private ringOf(kind: 'sel' | 'hover', L: number, W: number): MarkerOverlay {
    const key = `${kind}:${Math.round(L)}x${Math.round(W)}`;
    let m = this.ringCache.get(key);
    if (!m) {
      const g = new THREE.RingGeometry(0.44, 0.5, 48).rotateX(-Math.PI / 2);
      m = new MarkerOverlay(this.engine, { name: `ring-${key}`, capacity: 1, shape: g, size: [L, 1, W], minPixels: kind === 'sel' ? 30 : 24, depthMode: 'onTop', lift: 0.6 });
      this.ringCache.set(key, m);
    }
    return m;
  }

  private showRing(kind: 'sel' | 'hover', ctx: FrameContext, on: { L: number; W: number; x: number; y: number; z: number; hd: number; color: number } | null) {
    const want = on ? this.ringOf(kind, on.L, on.W) : null;
    for (const [k, m] of this.ringCache) {
      if (!k.startsWith(kind + ':')) continue;
      if (m === want) {
        m.setMarker(0, on!.x, on!.y, on!.z, on!.hd, on!.color);
        m.setCount(1);
      } else m.setCount(0);
      m.commit();
      m.update(ctx);
    }
  }

  private pushUi(t: number) {
    const ui = useInteract.getState();
    const op = this.op;
    if (op) {
      const ns = op.nextStop;
      const meta = op.info.routeMeta;
      const err = op.stopError();
      let departIn: number | null = null;
      if (op.doors !== 'closed' && ns) departIn = ns.dep - t;
      const b = op.boarding;
      ui.set({
        op: {
          trip: op.info.trip, route: meta.short, routeColor: meta.color, routeText: meta.textColor,
          headsign: op.info.headsign, mode: op.mode, speed: op.v, limit: op.currentLimit(),
          nextLimit: op.path.nextLowerLimit(op.s + op.dyn.length / 2, Math.max(300, (op.v * op.v) / op.dyn.brake * 1.5), op.currentLimit()),
          notch: op.notch, maxNotch: MAX_NOTCH, accel: op.a,
          nextStop: ns?.name ?? '—', nextStopDist: err ?? 0, stopTol: op.dyn.tol, canOpen: op.canOpen(),
          doors: op.doors,
          boarding: b ? { on: Math.round(b.on), off: Math.round(b.off), target: b.target, done: b.done } : null,
          deviation: op.doors !== 'closed' ? null : op.deviation(t), departIn,
          aspect: op.aspect, trainAhead: op.trainAhead, reverse: op.reverse,
          message: op.atcTrip ? 'ATC: emergency brake — train ahead!' : op.overspeed ? 'ATC: overspeed — brakes applied' : op.message,
          progress: op.path.length ? op.s / op.path.length : 0, finished: op.finished,
          inTunnel: this.tunnel.isUnder(op.s), view: this.view === 'cab' ? 'cab' : 'chase',
        },
      });
    } else if (ui.op) ui.set({ op: null });

    if ((this.mode === 'ride' || this.mode === 'cab' || this.mode === 'follow') && this.trip !== null && this.tripInfo) {
      const vs = this.vsTmp;
      const meta = this.tripInfo.routeMeta;
      const dwelling = !!vs && vs.state === STATE_DWELL;
      ui.set({
        ride: {
          trip: this.trip, route: meta.short, routeColor: meta.color, routeText: meta.textColor,
          headsign: this.tripInfo.headsign, nextStop: vs ? this.system.stopName(vs.nextStop) : '',
          dwelling, speed: vs?.speed ?? 0,
        },
      });
      if (this.boardedFromWalk) ui.set({ walk: { running: false, prompt: dwelling ? `Press E to get off at ${vs ? this.system.stopName(vs.nextStop) : ''}` : null, prompt2: null, nearStop: null, nearDeps: [] } });
    } else if (ui.ride) ui.set({ ride: null });

    if (this.mode === 'walk' && this.walker) this.updateWalkUi(t);
  }

  private updateWalkUi(t: number) {
    const w = this.walker!;
    const sys = this.system;
    const v = sys.vehicles;
    let best: { trip: number; d: number } | null = null;
    // near stop
    const ns = this.nearestStop(w.e, w.n, 60);
    for (let i = 0; i < v.count; i++) {
      if (v.speed[i] > 0.3) continue;
      const mode = MODES[v.mode[i]];
      const L2 = DYN[mode].length / 2;
      const dx = w.e - v.x[i], dy = w.n - v.y[i];
      if (Math.abs(dx) > 400 || Math.abs(dy) > 400) continue;
      const c = Math.cos(v.heading[i]), s = Math.sin(v.heading[i]);
      const along = Math.max(-L2, Math.min(L2, dx * c + dy * s));
      const px = v.x[i] + c * along, py = v.y[i] + s * along;
      let d = Math.hypot(w.e - px, w.n - py);
      const under = this.engine.heightAt(v.x[i], v.y[i]) - v.z[i] > 4.5;
      if (under) {
        // underground: be near the station entrance (stop position)
        if (v.state[i] !== STATE_DWELL) continue;
        const p = sys.stopPosition(v.nextStop[i]);
        d = Math.hypot(w.e - p[0], w.n - p[1]) - 40;
      } else if (d > 20) continue;
      if (d < 25 && (!best || d < best.d)) best = { trip: v.trip[i], d };
    }
    let prompt: string | null = null;
    if (best) {
      const info = sys.tripInfo(best.trip);
      if (info) prompt = `Press E to board ${info.routeMeta.short} ${info.routeMeta.mode === 'bus' || info.routeMeta.mode === 'streetcar' ? info.routeMeta.long + ' ' : ''}→ ${towards(info.headsign)}`;
      this.walkNear = { trip: best.trip, label: prompt ?? '' };
    } else this.walkNear = null;
    const tr = this.traffic();
    const prompt2 = tr?.takeOverNearestCar ? 'Press F to take over the nearest car' : null;
    const walk: WalkInfo = { running: w.speed > 3, prompt, prompt2, nearStop: ns >= 0 ? sys.stopName(ns) : null, nearDeps: [] };
    if (ns >= 0 && Math.floor(this.time * 2) % 2 === 0) {
      walk.nearDeps = sys.arrivalsAt(ns, t, 4).map((a) => {
        const r = sys.routes[a.route];
        return { route: r.short, color: r.color, text: r.textColor, headsign: a.headsign, min: Math.max(0, (a.dep - t) / 60) };
      });
    } else walk.nearDeps = useInteract.getState().walk?.nearDeps ?? [];
    useInteract.getState().set({ walk });
  }

  // ------------------------------------------------------------------ stops

  private buildStops() {
    this.stopsTrips = this.system.tripCount;
    this.stopsCache = this.system.stops();
    this.stopGrid.clear();
    const sc = this.stopsCache;
    for (let i = 0; i < sc.index.length; i++) {
      const key = cellKey(sc.x[i], sc.y[i]);
      let a = this.stopGrid.get(key);
      if (!a) this.stopGrid.set(key, (a = []));
      a.push(i);
    }
    this.visAcc = 1;
  }

  /** nearest stop (global index) within r m, or -1 */
  nearestStop(e: number, n: number, r: number, railOnly = false): number {
    const sc = this.stopsCache;
    if (!sc) return -1;
    let best = -1, bd = r;
    const cx = Math.floor(e / 200), cy = Math.floor(n / 200);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = this.stopGrid.get((cx + dx) * 100000 + (cy + dy));
      if (!a) continue;
      for (const i of a) {
        if (railOnly && sc.mode[i] === 6) continue;
        const d = Math.hypot(sc.x[i] - e, sc.y[i] - n);
        if (d < bd) { bd = d; best = sc.index[i]; }
      }
    }
    return best;
  }

  /** All stops of the same station (same base name within 500 m). */
  stationGroup(stop: number): number[] {
    const sc = this.stopsCache;
    if (!sc) return [stop];
    const base = this.system.stopName(stop).split(' - ')[0].trim();
    const p = this.system.stopPosition(stop);
    const out: number[] = [];
    const cx = Math.floor(p[0] / 200), cy = Math.floor(p[1] / 200);
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      for (const i of this.stopGrid.get((cx + dx) * 100000 + (cy + dy)) ?? []) {
        if (Math.hypot(sc.x[i] - p[0], sc.y[i] - p[1]) > 500) continue;
        if (this.system.stopName(sc.index[i]).split(' - ')[0].trim() === base) out.push(sc.index[i]);
      }
    }
    if (!out.includes(stop)) out.push(stop);
    return out;
  }

  private updateStopMarks(ctx: FrameContext) {
    const sc = this.stopsCache;
    this.visAcc += ctx.dt;
    if (sc && this.visAcc > 0.4) {
      this.visAcc = 0;
      const alt = ctx.altitude;
      const f = ctx.focus;
      const fe = f.x, fn = -f.z;
      const vis: number[] = [];
      const R = Math.min(12000, Math.max(1500, alt * 3));
      for (let i = 0; i < sc.index.length; i++) {
        const m = sc.mode[i];
        const rail = m !== 6 && m !== 2;
        const d = Math.hypot(sc.x[i] - fe, sc.y[i] - fn);
        if (rail ? alt < 9000 && d < R * 2 : alt < (m === 2 ? 1800 : 700) && d < (m === 2 ? 2500 : 1000)) vis.push(i);
        if (vis.length >= this.stopMarks.capacity) break;
      }
      this.visStops = vis;
      const colors = [0xf8c300, 0xf58025, 0xda251d, 0x3e8a36, 0xc5782b, 0xfdd005, 0x9aa7b8];
      vis.forEach((i, k) => {
        const g = this.engine.heightAt(sc.x[i], sc.y[i]);
        this.stopMarks.setMarker(k, sc.x[i], sc.y[i], Math.max(sc.z[i], g), 0, colors[sc.mode[i]] ?? 0xffffff);
      });
      this.stopMarks.setCount(vis.length);
      this.stopMarks.commit();
    }
    this.stopMarks.setVisible(this.mode === 'free' || this.mode === 'follow' || this.mode === 'walk');
    this.stopMarks.update(ctx);
  }

  // ------------------------------------------------------------------ picking

  private viewProj = new THREE.Matrix4();
  private invWorld = new THREE.Matrix4();

  /** Screen-space pick of vehicles and stops at client px (relative to canvas). */
  pick(cx: number, cy: number): PickResult | null {
    const eng = this.engine;
    const cam = eng.camera;
    const r = this.dom.getBoundingClientRect();
    const x = cx - r.left, y = cy - r.top;
    const W = r.width, Hh = r.height;
    this.invWorld.copy(cam.matrixWorld).invert();
    const m = this.viewProj.multiplyMatrices(cam.projectionMatrix, this.invWorld).elements;
    const proj = (e: number, n: number, z: number, out: number[]) => {
      const X = e, Y = z, Z = -n;
      const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
      if (w <= 0.01) return false;
      out[0] = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * W;
      out[1] = (-(m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5) * Hh;
      return true;
    };
    const a = [0, 0], b = [0, 0];
    let best: PickResult | null = null;
    let bd = PICK_PX;
    const v = this.system.vehicles;
    const drawn = this.transit.drawn;
    for (let i = 0; i < v.count; i++) {
      if (!drawn[i]) continue;
      const L2 = DYN[MODES[v.mode[i]]].length / 2;
      const c = Math.cos(v.heading[i]), s = Math.sin(v.heading[i]);
      const z = v.z[i] + 2;
      if (!proj(v.x[i] - c * L2, v.y[i] - s * L2, z, a)) continue;
      if (!proj(v.x[i] + c * L2, v.y[i] + s * L2, z, b)) continue;
      const d = segDist(x, y, a[0], a[1], b[0], b[1]);
      if (d < bd) { bd = d; best = { kind: 'vehicle', trip: v.trip[i], label: '' }; }
    }
    if (this.op) {
      const p = this.pose, L2 = this.op.dyn.length / 2;
      const c = Math.cos(p.heading), s = Math.sin(p.heading);
      if (proj(p.e - c * L2, p.n - s * L2, p.z + 2, a) && proj(p.e + c * L2, p.n + s * L2, p.z + 2, b)) {
        const d = segDist(x, y, a[0], a[1], b[0], b[1]);
        if (d < bd) { bd = d; best = { kind: 'vehicle', trip: this.op.info.trip, label: '' }; }
      }
    }
    const sc = this.stopsCache;
    if (sc) {
      let sd = best ? bd - 5 : PICK_PX;
      for (const i of this.visStops) {
        const g = eng.heightAt(sc.x[i], sc.y[i]);
        if (!proj(sc.x[i], sc.y[i], Math.max(sc.z[i], g), a)) continue;
        const d = Math.hypot(a[0] - x, a[1] - y);
        if (d < sd) { sd = d; best = { kind: 'stop', stop: sc.index[i], label: '' }; }
      }
    }
    const tr = this.traffic();
    if (!best && tr?.pickCar) {
      const gh = eng.pickGround(cx, cy);
      if (gh) {
        const mpp = Math.max(0.5, eng.controls.cur.dist / eng.ctx.pixelScale);
        try {
          const car = tr.pickCar(gh.e, gh.n, PICK_PX * mpp);
          if (car !== null && car !== undefined && car !== -1) best = { kind: 'car', car, label: 'Car', sub: 'click to take over' };
        } catch { /* ignore */ }
      }
    }
    if (best) this.labelPick(best);
    return best;
  }

  private labelPick(p: PickResult) {
    const sys = this.system;
    if (p.kind === 'vehicle' && p.trip !== undefined) {
      const info = sys.tripInfo(p.trip);
      if (info) {
        const r = info.routeMeta;
        p.label = `${r.short}${r.mode === 'bus' || r.mode === 'streetcar' ? ' ' + r.long : ''} → ${towards(info.headsign)}`;
        p.sub = `${modeLabel(info.mode)}${info.name ? ' · ' + info.name : ''}${this.op?.info.trip === p.trip ? ' · YOU' : ''}`;
      }
    } else if (p.kind === 'stop' && p.stop !== undefined) {
      p.label = sys.stopName(p.stop);
      const sc = this.stopsCache;
      const i = sc ? sc.index.indexOf(p.stop) : -1;
      p.sub = i >= 0 ? modeLabel(MODES[sc!.mode[i]]) + ' stop' : 'stop';
    }
  }

  private renderTip() {
    const h = this.hover;
    const tip = this.tip;
    if (!h) { tip.style.display = 'none'; this.dom.style.cursor = ''; return; }
    this.dom.style.cursor = 'pointer';
    let badge = '';
    if (h.kind === 'vehicle' && h.trip !== undefined) {
      const info = this.system.tripInfo(h.trip);
      if (info) badge = `<span class="pt-badge" style="background:${info.routeMeta.color};color:${info.routeMeta.textColor}">${esc(info.routeMeta.short)}</span>`;
    }
    tip.innerHTML = `${badge}<span class="pt-text"><b>${esc(h.label)}</b><small>${esc(h.sub ?? '')}</small></span>`;
    tip.style.display = 'flex';
    const r = this.dom.getBoundingClientRect();
    tip.style.transform = `translate(${this.mouse.x - r.left + 14}px, ${this.mouse.y - r.top + 14}px)`;
  }

  private click(cx: number, cy: number) {
    const ui = useInteract.getState();
    if (ui.placing) {
      const g = this.engine.pickGround(cx, cy);
      if (g) this.walkAt(g.e, g.n);
      return;
    }
    if (this.mode !== 'free' && this.mode !== 'follow') return;
    const p = this.pick(cx, cy);
    if (!p) { useApp.getState().select(null); useInteract.getState().set({ highlightRoute: null }); return; }
    if (p.kind === 'vehicle' && p.trip !== undefined) {
      this.selectVehicle(p.trip);
      const info = this.system.tripInfo(p.trip);
      useInteract.getState().set({ highlightRoute: info ? info.route : null });
      if (this.mode === 'follow') this.follow(p.trip);
    } else if (p.kind === 'stop' && p.stop !== undefined) {
      this.selectStop(p.stop);
    } else if (p.kind === 'car') {
      const g = this.engine.pickGround(cx, cy);
      if (g) void this.takeOverCar(g.e, g.n, typeof p.car === 'number' ? p.car : undefined);
    }
  }

  // ------------------------------------------------------------------ input handlers

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), btn: e.button, lx: e.clientX, ly: e.clientY };
  };

  private onMove = (e: PointerEvent) => {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.moved = true;
    const d = this.down;
    if (!d || this.mode === 'free') return;
    const dx = e.clientX - d.lx, dy = e.clientY - d.ly;
    d.lx = e.clientX; d.ly = e.clientY;
    this.lastLook = this.time;
    if (this.mode === 'walk') {
      this.yaw -= dx * 0.005;
      this.pitch = Math.max(-0.2, Math.min(1.2, this.pitch + dy * 0.004));
    } else if (this.view === 'cab' || this.view === 'ride') {
      this.lookYaw -= dx * 0.004;
      this.lookPitch = Math.max(-0.8, Math.min(0.8, this.lookPitch - dy * 0.004));
    } else {
      this.yaw -= dx * 0.005;
      this.pitch = Math.max(0.03, Math.min(1.45, this.pitch + dy * 0.004));
    }
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d) return;
    if (e.target !== this.dom) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved < 5 && performance.now() - d.t < 500 && d.btn === 0) this.click(e.clientX, e.clientY);
  };

  private onLeave = () => {
    this.hover = null;
    this.renderTip();
  };

  private onWheel = (e: WheelEvent) => {
    if (this.mode === 'free') return;
    e.preventDefault();
    const f = Math.exp(Math.max(-300, Math.min(300, e.deltaY)) * 0.0015);
    if (this.mode === 'walk') this.dist = Math.max(2.5, Math.min(60, this.dist * f));
    else if (this.view === 'chase') this.dist = Math.max(12, Math.min(3000, this.dist * f));
    else {
      const cam = this.engine.camera;
      cam.fov = Math.max(20, Math.min(80, cam.fov * f));
      cam.updateProjectionMatrix();
    }
  };

  private onBlur = () => { this.keys.clear(); };

  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };

  private onKey = (e: KeyboardEvent) => {
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    const code = e.code;
    const consume = () => { e.preventDefault(); e.stopPropagation(); };
    if (code === 'Escape') {
      if (useInteract.getState().placing) { useInteract.getState().set({ placing: false }); consume(); return; }
      if (this.mode !== 'free') { this.exit(); consume(); return; }
      if (useApp.getState().selected) { useApp.getState().select(null); useInteract.getState().set({ highlightRoute: null }); consume(); }
      return;
    }
    if (this.mode === 'free') return;
    this.keys.add(code);
    // view switching in all attached modes
    if (this.trip !== null && (code === 'Digit1' || code === 'Digit2' || code === 'Digit3')) {
      this.setView(code === 'Digit1' ? 'cab' : code === 'Digit2' ? 'chase' : 'ride');
      consume();
      return;
    }
    const op = this.op;
    if (this.mode === 'operate' && op) {
      if (e.repeat && code !== 'KeyW' && code !== 'KeyS' && code !== 'ArrowUp' && code !== 'ArrowDown') { consume(); return; }
      const t = this.now();
      switch (code) {
        case 'KeyW': case 'ArrowUp': if (!e.repeat) { op.notchUp(); beep(); } break;
        case 'KeyS': case 'ArrowDown': if (!e.repeat) { op.notchDown(); beep(); } break;
        case 'KeyN': op.neutral(); beep(); break;
        case 'KeyX': case 'Numpad0': case 'Backspace': op.emergency(); break;
        case 'KeyO': op.openDoors(t); break;
        case 'KeyC': op.closeDoors(); break;
        case 'Space': if (op.doors === 'open') op.closeDoors(); else if (op.doors === 'closed') op.openDoors(t); break;
        case 'KeyR': op.toggleReverse(); break;
        case 'KeyB': horn(op.mode); break;
        default: return;
      }
      consume();
      return;
    }
    if (this.mode === 'walk') {
      if (code === 'KeyE' && this.walkNear) { this.board(this.walkNear.trip); consume(); return; }
      if (code === 'KeyF' && this.walker) { void this.takeOverCar(this.walker.e, this.walker.n); consume(); return; }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'KeyZ', 'KeyX'].includes(code)) consume();
      return;
    }
    if (this.mode === 'ride' && this.boardedFromWalk) {
      if (code === 'KeyE') {
        const vs = this.vsTmp;
        if (vs && vs.state === STATE_DWELL) this.alight();
        else this.toast('Wait until the vehicle stops at a platform');
        consume();
      }
      return;
    }
    if (this.mode === 'drive') return; // the TrafficLayer reads the driving keys
    if (code === 'KeyT' && this.trip !== null) { this.operate(this.trip); consume(); }
  };

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    for (const m of this.ringCache.values()) m.dispose();
    this.pin.dispose(); this.stopMarks.dispose();
    this.routeHi.dispose(); this.routeHiUnder.dispose();
    this.tunnel.dispose();
    this.walker?.dispose();
    this.tip.remove();
  }
}

function cellKey(e: number, n: number) {
  return Math.floor(e / 200) * 100000 + Math.floor(n / 200);
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function modeLabel(m: Mode | string): string {
  return ({ subway: 'Subway', lrt: 'LRT', streetcar: 'Streetcar', commuter_rail: 'GO Train', airport_rail: 'UP Express', intercity_rail: 'VIA Rail', bus: 'Bus' } as Record<string, string>)[m] ?? m;
}

function towards(h: string) {
  const m = / towards (.+)$/i.exec(h);
  if (m) return m[1].split(' - ')[0].replace(/ Station$/i, ' Stn');
  const parts = h.split(' - ');
  return (parts.length > 1 && parts[0].length <= 4 ? parts.slice(1).join(' - ') : parts[0]).replace(/ Station$/i, ' Stn');
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export { EB };

const _railPose: Pose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
