// Schedule-driven transit: route lines (analytics) + every active vehicle.
// Positions come straight from the timetable at the current sim time, so
// scrubbing/speeding the clock needs no simulation state.
//
// Near the camera (< NEAR m) every car / module of a vehicle is drawn on its
// own (layers/transit/: consist placement along a path, one instanced mesh per
// car type) sitting on the rendered terrain. Trains, streetcars and LRT within
// the rail radius are agents of the rail sim (sim/src/rail.rs) and buses near
// the focus agents of the road sim (sim/src/bus.rs): they are drawn from the
// sims' published paths instead of the timetable. Far away each vehicle is one
// marker: true size in normal mode, min-pixel size in analytics mode (where the
// route lines show too).
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { LineOverlay } from '../render/overlay/LineOverlay';
import { MarkerOverlay } from '../render/overlay/MarkerOverlay';
import { VEHICLE_MODELS } from '../models/vehicles';
import { clock } from '../state/clock';
import { useApp, type AnalyticsKey } from '../state/store';
import { MODES, MODE_ID, STATE_DWELL, TransitSystem, fetchLoader, type Mode, type Profile } from '../transit';
import { LANE_OFFSET, layoutFor, placeCar, type CarPose, type ConsistLayout } from './transit/consist';
import type { GroundVeh } from './transit/ground';
import { CarPools, FLAG_BRAKE, FLAG_OFF } from './transit/pools';
import { PatternShape } from '../transit/shape';
import { BUS_FLAG, BUS_STRIDE, RAIL_FLAG, RAIL_STRIDE } from '../sim/protocol';

/** The traffic layer's view of the rail agents (sim/src/rail.rs, via the shared buffer). */
interface BusSnap { count: number; oe: number; on: number; simMs: number; f: Float32Array; u: Uint32Array; path: Float32Array }
interface RailSource {
  railProfile: Profile | null;
  railFeedsProfile: string;
  simRadius?: number;
  busSnapshot?(): BusSnap | null;
  requestBuses?(spawn: { trip: number; pat: number; len: number; front: number; v: number; arr: Float64Array; dep: Float64Array }[], patterns: { id: number; xy: Float64Array; stopD: Float32Array; stopFlag: Uint8Array }[], retrip?: { old: number; trip: number; pat: number; arr: Float64Array; dep: Float64Array }[], pullout?: { trip: number; pat: number; len: number; arr: Float64Array; dep: Float64Array; gx: number; gy: number }[], pullin?: { trip: number; gx: number; gy: number }[]): void;
  railSnapshot(): { count: number; oe: number; on: number; simMs: number; feeds: string[]; f: Float32Array; u: Uint32Array; path: Float32Array } | null;
}

export type { GroundVeh } from './transit/ground';

/** m from the camera within which vehicles are drawn car by car */
const NEAR = 2600;
/** m beyond which the per-car low-detail geometry is used */
const LOW_DETAIL = 450;
/** m from the focus within which surface vehicles are held behind obstacles */
const HOLD_RADIUS = 1400;
const SURFACE = (1 << MODE_ID.bus) | (1 << MODE_ID.streetcar) | (1 << MODE_ID.lrt);

interface ModeStyle {
  key: AnalyticsKey;
  /** real vehicle size [length, height, width] m */
  size: [number, number, number];
  lineWidth: number;
  minPixels: number;
  shape: 'train' | 'bus';
}

const STYLE: Record<Mode, ModeStyle> = {
  subway: { key: 'subway', size: [138, 3.7, 3.1], lineWidth: 5, minPixels: 9, shape: 'train' },
  lrt: { key: 'lrt', size: [60, 3.7, 2.65], lineWidth: 4, minPixels: 8, shape: 'train' },
  streetcar: { key: 'streetcar', size: [30.2, 3.8, 2.54], lineWidth: 2.5, minPixels: 6, shape: 'train' },
  commuter_rail: { key: 'go', size: [305, 4.8, 3.0], lineWidth: 4, minPixels: 10, shape: 'train' },
  airport_rail: { key: 'upx', size: [76, 4.3, 3.1], lineWidth: 4, minPixels: 8, shape: 'train' },
  intercity_rail: { key: 'via', size: [180, 4.3, 3.1], lineWidth: 3, minPixels: 9, shape: 'train' },
  bus: { key: 'bus', size: [12.2, 3.2, 2.6], lineWidth: 1.2, minPixels: 3, shape: 'bus' },
};

const MODE_LIST = Object.keys(STYLE) as Mode[];
/** transit MODE_ID (index into MODES) -> Mode */
const MODE_LIST_BY_ID: readonly Mode[] = MODES;

function hex(c: string): number {
  return parseInt(c.replace('#', ''), 16) || 0x888888;
}

/** A player-driven pose drawn instead of a trip's scheduled position. */
export interface TripOverride {
  x: number; y: number; z: number; heading: number;
  mode: Mode; route: number;
  /** with pattern + dist (consist centre along the pattern shape) the vehicle is drawn car by car */
  pattern?: number;
  dist?: number;
  /** -1 when running backwards along the pattern */
  dir?: 1 | -1;
}

export class TransitLayer implements Layer {
  readonly id = 'transit';
  readonly system: TransitSystem;
  /** trip -> pose drawn instead of the schedule (player-operated), or null to hide the trip */
  readonly overrides = new Map<number, TripOverride | null>();
  /** trip -> outline kind (render/overlay/OutlineSet: 1 hover, 2 selected), set by the InteractLayer */
  readonly highlight = new Map<number, number>();
  /** drawn[i] = 1 if slot i of system.vehicles was drawn last frame (for picking) */
  drawn = new Uint8Array(0);
  /** service-day seconds of the last evaluate() */
  lastT = 0;
  /** hide the route lines (e.g. while the camera is inside a vehicle) */
  hideLines = false;
  private lines = new Map<Mode, LineOverlay>();
  private markers = new Map<Mode, MarkerOverlay>();
  private routeColor: number[] = [];
  private profile: Profile | null = null;
  private loading = false;
  private linesBuilt = new Set<Mode>();
  private ready = false;
  private engine!: Engine;
  private pools = new CarPools();
  private routeTint: THREE.Color[] = [];
  /** rendered distance per vehicle slot (schedule, or held behind an obstacle) */
  private rdist = new Float64Array(0);
  /** surface vehicles near the focus this frame (for the traffic sim and the hold logic) */
  private ground: (GroundVeh & { slot: number })[] = [];
  private groundN = 0;
  private prevSpeed = new Map<number, number>();
  private nextSpeed = new Map<number, number>();
  private pose: CarPose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
  private ax = 0; private az = 0;
  private evalBox: [number, number, number, number] = [0, 0, 0, 0];
  /** global trip -> rail agent record index this frame (-1: managed by the sim but not placed yet) */
  private agents = new Map<number, number>();
  /** global trip -> bus agent record index this frame */
  private busAgents = new Map<number, number>();
  private busSnap: BusSnap | null = null;
  private busSent = new Set<number>();
  private busAsked = new Map<number, number>();
  private busAskAt = 0;
  private upcoming: number[] = [];
  /** records of trains parked in depots */
  private parked: number[] = [];
  private railSnap: ReturnType<RailSource['railSnapshot']> = null;
  /** rail agents drawn this frame */
  agentCount = 0;
  /** stats: cars drawn individually / vehicles held; dupes = trips drawn by more than one representation (must stay 0) */
  stats = { cars: 0, held: 0, near: 0, dupes: 0 };
  /**
   * Pick segments of everything drawn this frame: per car / marker [trip, ax, ay, bx, by, z]
   * (world E/N of its two ends, elevation of the roof line) — `pickCount` entries.
   */
  pickSegs = new Float64Array(6 * 4096);
  /** vehicles near the camera this / last frame (identity -> position) for the pop counter */
  private seen = new Map<string, [number, number]>();
  private seenPrev = new Map<string, [number, number]>();
  private camPrev: [number, number, number, number] | null = null;
  /** timetable vehicles drawn this / last frame (no pop-in / pop-out in view) */
  private schedNow = new Set<number>();
  private schedPrev = new Set<number>();
  /** vehicles whose trip ended in view: kept (standing) until unseen */
  private linger = new Map<number, { pattern: number; dist: number; mode: Mode; route: number; since: number }>();
  private schedLast = new Map<number, { pattern: number; dist: number; mode: Mode; route: number }>();
  /** off until the first frames after load / jumps (everything may appear then) */
  private popArmed = false;
  private camFwd: [number, number] = [1, 0];
  private popT = 0;
  /** vehicles that appeared / vanished in plain view (< 2 km, in the view cone): must stay 0 */
  popStats = { spawn: 0, despawn: 0, examples: [] as { kind: string; e: number; n: number; key: string }[] };
  pickCount = 0;
  /** trip -> pose of the vehicle as drawn this frame (centre, heading, length) */
  private drawnPose = new Map<number, { x: number; y: number; z: number; heading: number; length: number }>();
  private posePool: { x: number; y: number; z: number; heading: number; length: number }[] = [];

  constructor(dataRoot: string) {
    this.system = new TransitSystem(fetchLoader(`${dataRoot}/transit/`));
  }

  async init(engine: Engine) {
    this.engine = engine;
    engine.scene.add(this.pools.group);
    await this.system.loadIndex();
    for (const m of MODE_LIST) {
      const s = STYLE[m];
      this.lines.set(m, new LineOverlay(engine, { name: `lines-${m}`, width: s.lineWidth, lift: 3, order: m === 'bus' ? 1 : 2 }));
      this.markers.set(m, new MarkerOverlay(engine, {
        name: `veh-${m}`, capacity: m === 'bus' ? 6000 : 800, shape: VEHICLE_MODELS[m].geometry(), size: VEHICLE_MODELS[m].size,
        minPixels: s.minPixels, lift: 0.2,
      }));
    }
    this.ready = true;
    void this.ensureProfile();
  }

  private currentProfile(): Profile {
    const o = useApp.getState().dayTypeOverride;
    if (o) return o;
    const wd = clock.serviceDay().weekday;
    return wd === 0 ? 'sunday' : wd === 6 ? 'saturday' : 'weekday';
  }

  private async ensureProfile() {
    const p = this.currentProfile();
    if (p === this.profile || this.loading) return;
    this.loading = true;
    try {
      // bus schedules (most of the bytes) wait for the first view's tiles
      await this.system.load(p, { onFeed: () => this.onFeedLoaded(), beforeBus: () => this.firstView() });
      this.profile = p;
      this.onFeedLoaded();
    } finally {
      this.loading = false;
    }
  }

  /** resolves when the first tiles have loaded (or after 5 s) */
  private firstView(): Promise<void> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const poll = () => {
        const t = this.engine.tiles;
        if ((t.readyCount > 0 && !t.busy) || performance.now() - t0 > 5000) resolve();
        else setTimeout(poll, 100);
      };
      poll();
    });
  }

  private onFeedLoaded() {
    this.routeColor = this.system.routes.map((r) => hex(r.color));
    this.routeTint = this.routeColor.map((c) => new THREE.Color(c));
    this.linesBuilt.clear();
    this.lenCache.clear();
  }

  private buildLines(mode: Mode) {
    const overlay = this.lines.get(mode)!;
    const specs = this.system.routeLines({ modes: [mode] }).flatMap((rl) =>
      rl.lines.map((pts, i) => ({ id: `${rl.meta.id}:${i}`, points: pts, color: hex(rl.meta.color) })),
    );
    overlay.set(specs);
    this.linesBuilt.add(mode);
  }

  update(ctx: FrameContext) {
    if (!this.ready) return;
    if (!this.loading && this.currentProfile() !== this.profile) void this.ensureProfile();
    const st = useApp.getState();
    const an = st.analytics;
    // route lines per analytics toggle, in analytics mode only: in normal mode the coloured
    // overlays read as paint over the city (the vehicles themselves stay visible as models)
    const lineFade = ctx.analyticsMode ? 1 : 0;
    for (const m of MODE_LIST) {
      const on = an[STYLE[m].key] && lineFade > 0.01;
      const ov = this.lines.get(m)!;
      if (on && !this.linesBuilt.has(m) && this.system.tripCount > 0) this.buildLines(m);
      ov.setVisible(on && !this.hideLines);
      ov.setOpacity(lineFade);
      ov.update(ctx);
    }
    // min-pixel markers in analytics mode only; in normal mode far vehicles keep their true size
    // (enlarged markers read as coloured dots scattered over the city)
    const markerPx = ctx.analyticsMode ? 1 : 0;
    for (const m of MODE_LIST) this.markers.get(m)!.setMinPixels(STYLE[m].minPixels * markerPx);
    // vehicles
    const counts = new Map<Mode, number>();
    for (const m of MODE_LIST) counts.set(m, 0);
    const ax = ctx.anchor.origin.x, az = ctx.anchor.origin.z;
    this.ax = ax; this.az = az;
    this.pools.group.position.set(ax, 0, az);
    this.pools.begin();
    for (const p of this.drawnPose.values()) this.posePool.push(p);
    this.drawnPose.clear();
    this.pickCount = 0;
    let dupes = 0;
    this.groundN = 0;
    this.stats.near = 0;
    if (an.vehicles && this.system.tripCount > 0) {
      this.lastT = clock.serviceDay().sec;
      // low views: only evaluate trips whose route passes within reach of
      // anything drawn (markers stop at markerMax); from high up, everything
      if (ctx.altitude < 1500) {
        const R = Math.max(ctx.view.r2 * 2.5, ctx.altitude * 40) + 2000;
        const cE = ctx.cameraPos.x, cN = -ctx.cameraPos.z;
        this.evalBox[0] = cE - R; this.evalBox[1] = cN - R; this.evalBox[2] = cE + R; this.evalBox[3] = cN + R;
        this.system.setEvalBounds(this.evalBox);
      } else this.system.setEvalBounds(null);
      const v = this.system.evaluate(this.lastT);
      const near = ctx.altitude < 3000;
      const rail = this.railAgents();
      this.readBuses();
      this.applyDelays(v);
      if (this.drawn.length < v.capacity) this.drawn = new Uint8Array(v.capacity);
      if (this.rdist.length < v.capacity) this.rdist = new Float64Array(v.capacity);
      this.drawn.fill(0, 0, v.count);
      const camE = ctx.cameraPos.x, camN = -ctx.cameraPos.z;
      const fE = ctx.focus.x, fN = -ctx.focus.z;
      {
        const dir = this.engine.camera.getWorldDirection(_v3);
        const l = Math.hypot(dir.x, dir.z) || 1;
        this.camFwd = [dir.x / l, -dir.z / l];
        const jumped = !this.camPrev || Math.hypot(camE - this.camPrev[0], camN - this.camPrev[1]) > 150 || Math.abs(this.lastT - this.popT - ctx.simDt) > 5;
        this.popArmed = !jumped && this.schedPrev.size + this.agents.size > 0;
      }
      const H = (e: number, n: number) => this.engine.heightAt(e, n);
      // --- surface vehicles near the focus that the sims don't drive (yet): obstacles for
      // road traffic (buses, streetcars and LRT near the focus are sim agents)
      for (let i = 0; i < v.count; i++) {
        this.rdist[i] = v.dist[i];
        if (!near || !(SURFACE & (1 << v.mode[i]))) continue;
        if (Math.abs(v.x[i] - fE) > HOLD_RADIUS || Math.abs(v.y[i] - fN) > HOLD_RADIUS) continue;
        if (this.overrides.has(v.trip[i]) || this.agents.has(v.trip[i]) || this.busAgents.has(v.trip[i])) continue;
        const shape = this.system.patternShape(v.pattern[i]);
        if (!shape) continue;
        const lay = layoutFor(MODE_LIST_BY_ID[v.mode[i]], this.system.routes[v.route[i]]);
        const front = v.dist[i] + lay.length / 2;
        const p = shape.point(front, _p);
        if (Math.abs(p[2] - H(p[0], p[1])) > 4) continue; // tunnel / elevated: not in traffic
        const dir = shape.direction(front, _d);
        const lat = this.laneOf(v.pattern[i], v.mode[i]);
        this.pushGround(p[0] + dir[1] * lat, p[1] - dir[0] * lat, Math.atan2(dir[1], dir[0]), lay, v.speed[i], v.trip[i], i);
      }
      // --- draw
      const next = this.nextSpeed;
      next.clear();
      const view = ctx.view;
      // markers beyond this are hidden at street level (far below a pixel / behind the skyline)
      const markerMax = Math.max(view.r2 * 2.5, ctx.altitude * 40);
      const pxK = 1 / Math.max(1, ctx.pixelScale);
      for (let i = 0; i < v.count; i++) {
        const mode = MODE_LIST_BY_ID[v.mode[i]];
        if (!mode) continue;
        if (!near && !an[STYLE[mode].key]) continue;
        if (this.overrides.size && this.overrides.has(v.trip[i])) continue;
        if (this.agents.has(v.trip[i]) || this.busAgents.has(v.trip[i])) continue; // drawn from the sim below
        const dc = Math.hypot(v.x[i] - camE, v.y[i] - camN);
        // no pop-in: a timetable vehicle that did not exist last frame (trip starting at a
        // stop) does not materialise in plain view — it shows once unseen
        if (this.popArmed && !this.schedPrev.has(v.trip[i]) && dc < 2000 && this.inViewCone(v.x[i], v.y[i], camE, camN)) continue;
        this.schedNow.add(v.trip[i]);
        if (dc > markerMax) continue;
        const sty = STYLE[mode];
        // bounding radius: the consist (plus hold slack) or the min-pixel marker
        const rad = near && dc < NEAR ? sty.size[0] + 60 : Math.max(sty.size[0], sty.minPixels * markerPx * 2 * dc * pxK);
        if (!view.sphereEN(v.x[i], v.y[i], v.z[i], rad)) continue;
        this.drawn[i] = 1;
        const color = this.routeColor[v.route[i]] ?? 0xffffff;
        if (near && dc < NEAR) {
          const shape = this.system.patternShape(v.pattern[i]);
          if (shape) {
            const lay = layoutFor(mode, this.system.routes[v.route[i]]);
            const trip = v.trip[i];
            const sp = v.speed[i];
            const prev = this.prevSpeed.get(trip) ?? sp;
            next.set(trip, sp);
            const braking = sp < 0.2 || v.state[i] === STATE_DWELL || sp < prev - 0.01;
            this.drawConsist(shape, lay, this.rdist[i] + lay.length / 2, 1, this.routeTint[v.route[i]] ?? _white, dc > LOW_DETAIL, braking ? FLAG_BRAKE : 0, this.laneOf(v.pattern[i], v.mode[i]), trip, v.mode[i]);
            if (!this.notePose(trip, shape, this.rdist[i], lay.length, 1, this.laneOf(v.pattern[i], v.mode[i]))) dupes++;
            this.schedLast.set(trip, { pattern: v.pattern[i], dist: this.rdist[i], mode, route: v.route[i] });
            this.noteSeen('t' + trip, v.x[i], v.y[i], camE, camN);
            this.stats.near++;
            continue;
          }
        }
        const mk = this.markers.get(mode)!;
        const k = counts.get(mode)!;
        if (k >= mk.capacity) continue;
        mk.setMarker(k, v.x[i], v.y[i], v.z[i], v.heading[i], color);
        counts.set(mode, k + 1);
        this.pushPick(v.trip[i], v.x[i], v.y[i], v.z[i] + 2, v.heading[i], Math.max(sty.size[0], sty.minPixels * markerPx * dc * pxK));
        if (!this.notePoint(v.trip[i], v.x[i], v.y[i], v.z[i], v.heading[i], sty.size[0])) dupes++;
        this.noteSeen('t' + v.trip[i], v.x[i], v.y[i], camE, camN);
      }
      // no pop-out: a vehicle whose trip ended in plain view stands where it was until unseen
      for (const [trip, last] of this.schedLast) {
        if (this.schedNow.has(trip) || this.agents.has(trip) || this.busAgents.has(trip)) continue;
        if (this.schedPrev.has(trip) && !this.linger.has(trip)) this.linger.set(trip, { ...last, since: this.lastT });
      }
      for (const [trip, lg] of this.linger) {
        const shape = this.system.patternShape(lg.pattern);
        if (!shape || this.schedNow.has(trip) || this.lastT - lg.since > 900 || this.lastT < lg.since) { this.linger.delete(trip); continue; }
        const q = shape.point(lg.dist, _p);
        const dc = Math.hypot(q[0] - camE, q[1] - camN);
        if (!(dc < 2200 && this.inViewCone(q[0], q[1], camE, camN)) || !this.popArmed) { this.linger.delete(trip); continue; }
        const lay = layoutFor(lg.mode, this.system.routes[lg.route]);
        this.drawConsist(shape, lay, lg.dist + lay.length / 2, 1, this.routeTint[lg.route] ?? _white, dc > LOW_DETAIL, FLAG_BRAKE, LANE_OFFSET[MODE_ID[lg.mode]], trip, MODE_ID[lg.mode]);
        this.schedNow.add(trip);
        this.noteSeen('t' + trip, q[0], q[1], camE, camN);
      }
      const sp = this.schedPrev;
      this.schedPrev = this.schedNow;
      this.schedNow = sp;
      this.schedNow.clear();
      for (const k of this.schedLast.keys()) if (!this.schedPrev.has(k)) this.schedLast.delete(k);
      this.nextSpeed = this.prevSpeed;
      this.prevSpeed = next;
      // --- rail agents (signalled trains from the sim)
      if (rail) {
        const { f, u, path, oe, on } = rail;
        const adv = Math.min(0.15, Math.max(0, (clock.simMs - rail.simMs) / 1000));
        this.agentCount = 0;
        const list: [number, number][] = [...this.agents];
        for (const k of this.parked) list.push([-1, k]);
        for (const [trip, k] of list) {
          if (k < 0 || this.overrides.has(trip)) continue;
          const o = k * RAIL_STRIDE;
          const pat = trip >= 0 ? this.system.tripPattern(trip) : this.system.patternIndex(rail.feeds[f[o]] ?? '', 'rail', f[o + 8]);
          const mode = pat >= 0 ? this.system.patternMode(pat) : null;
          if (!mode || (!near && !an[STYLE[mode].key])) continue;
          const route = this.system.patternRoute(pat);
          const p0 = f[o + 10], pn = f[o + 11];
          if (pn < 2) continue;
          const shape = pathShape(path, p0, pn, oe, on);
          const lay = layoutFor(mode, this.system.routes[route]);
          const front = shape.length - 3 + f[o + 3] * adv;
          const c = shape.point(front - lay.length / 2, _p);
          const dc = Math.hypot(c[0] - camE, c[1] - camN);
          if (dc > markerMax) continue;
          const sty = STYLE[mode];
          const rad = near && dc < NEAR ? sty.size[0] + 20 : Math.max(sty.size[0], sty.minPixels * markerPx * 2 * dc * pxK);
          if (!view.sphereEN(c[0], c[1], c[2], rad)) continue;
          this.agentCount++;
          const flags = u[o + 5];
          this.noteSeen('a' + u[o + 9], c[0], c[1], camE, camN);
          // at-grade LRT agents are obstacles for road traffic
          if (near && (SURFACE & (1 << MODE_ID[mode])) && Math.abs(c[0] - fE) < HOLD_RADIUS && Math.abs(c[1] - fN) < HOLD_RADIUS) {
            const fp = shape.point(front, _q);
            if (Math.abs(fp[2] - this.engine.heightAt(fp[0], fp[1])) < 4) {
              const dd = shape.direction(front, _d);
              this.pushGround(fp[0], fp[1], Math.atan2(dd[1], dd[0]), lay, f[o + 3], trip, -1, true, (flags & RAIL_FLAG.DOORS) !== 0);
            }
          }
          if (near && dc < NEAR) {
            this.drawConsist(shape, lay, front, 1, this.routeTint[route] ?? _white, dc > LOW_DETAIL, trip < 0 ? FLAG_OFF : flags & RAIL_FLAG.BRAKE ? FLAG_BRAKE : 0, 0, trip, MODE_ID[mode]);
            if (!this.notePose(trip, shape, front - lay.length / 2, lay.length, 1, 0)) dupes++;
            this.stats.near++;
          } else {
            const mk = this.markers.get(mode)!;
            const kk = counts.get(mode)!;
            if (kk >= mk.capacity) continue;
            const d = shape.direction(front - lay.length / 2, _d);
            const hd = Math.atan2(d[1], d[0]);
            mk.setMarker(kk, c[0], c[1], c[2], hd, this.routeColor[route] ?? 0xffffff);
            counts.set(mode, kk + 1);
            this.pushPick(trip, c[0], c[1], c[2] + 2, hd, Math.max(lay.length, sty.minPixels * markerPx * dc * pxK));
            if (!this.notePoint(trip, c[0], c[1], c[2], hd, lay.length)) dupes++;
          }
        }
      }
    }
    if (an.vehicles && this.busSnap && this.busAgents.size) this.drawBuses(ctx, markerPx, counts);
    if (an.vehicles && this.system.tripCount > 0 && ctx.altitude < 3000) this.askBuses(ctx);
    for (const o of this.overrides.values()) {
      if (!o) continue;
      if (o.pattern !== undefined && o.dist !== undefined) {
        const shape = this.system.patternShape(o.pattern);
        const dc = Math.hypot(o.x - ctx.cameraPos.x, o.y + ctx.cameraPos.z);
        if (shape && dc < NEAR) {
          const lay = layoutFor(o.mode, this.system.routes[o.route]);
          const dir = o.dir ?? 1;
          this.drawConsist(shape, lay, o.dist + dir * lay.length / 2, dir, this.routeTint[o.route] ?? _white, dc > LOW_DETAIL, 0, LANE_OFFSET[MODE_ID[o.mode]], -1, MODE_ID[o.mode]);
          if (SURFACE & (1 << MODE_ID[o.mode])) {
            const p = shape.point(o.dist + dir * lay.length / 2, _p);
            const dd = shape.direction(o.dist + dir * lay.length / 2, _d);
            this.pushGround(p[0], p[1], Math.atan2(dd[1] * dir, dd[0] * dir), lay, 0, -1, -1);
          }
          continue;
        }
      }
      const mk = this.markers.get(o.mode)!;
      const k = counts.get(o.mode)!;
      if (k >= mk.capacity) continue;
      mk.setMarker(k, o.x, o.y, o.z, o.heading, this.routeColor[o.route] ?? 0xffffff);
      counts.set(o.mode, k + 1);
    }
    this.popCheck(ctx);
    this.pools.commit();
    this.stats.cars = this.pools.instances;
    this.stats.dupes = dupes;
    const qa = (globalThis as { __qa?: Record<string, unknown> }).__qa;
    if (qa) {
      qa.transitDupes = ((qa.transitDupes as number) || 0) + dupes;
      const rs = (this.traffic() as unknown as { railStats?(): number[] } | null)?.railStats?.();
      if (rs) { qa.railAgents = rs[0]; qa.trainOverlaps = rs[1]; qa.railOverruns = rs[2]; qa.railTurnbacks = rs[3]; qa.railPullouts = rs[4]; qa.railPullins = rs[5]; qa.railParked = rs[6]; qa.trainsHeldAtDepot = rs[7] ?? 0; }
      qa.vehicleSpawnInView = this.popStats.spawn + this.popStats.despawn;
      qa.vehicleSpawnInViewExamples = this.popStats.examples;
    }
    for (const m of MODE_LIST) {
      const mk = this.markers.get(m)!;
      mk.setCount(counts.get(m)!);
      mk.commit();
      mk.update(ctx);
    }
  }

  /** remember the drawn pose of a trip (false if it was already drawn this frame) */
  private notePoint(trip: number, x: number, y: number, z: number, heading: number, length: number): boolean {
    if (trip < 0) return true;
    if (this.drawnPose.has(trip)) return false;
    const p = this.posePool.pop() ?? { x: 0, y: 0, z: 0, heading: 0, length: 0 };
    p.x = x; p.y = y; p.z = z; p.heading = heading; p.length = length;
    this.drawnPose.set(trip, p);
    return true;
  }

  private notePose(trip: number, shape: PatternShape, centre: number, length: number, dir: 1 | -1, lat: number): boolean {
    const q = shape.point(centre, _p);
    const d = shape.direction(centre, _d);
    const hd = Math.atan2(d[1] * dir, d[0] * dir);
    const z = Math.max(q[2], this.engine.heightAt(q[0], q[1]) - 3);
    return this.notePoint(trip, q[0] + d[1] * lat, q[1] - d[0] * lat, z, hd, length);
  }

  /** Pose of a trip's vehicle as drawn this frame (centre, heading rad CCW from +E), or null. */
  drawnVehicle(trip: number): { x: number; y: number; z: number; heading: number; length: number } | null {
    return this.drawnPose.get(trip) ?? null;
  }

  /** trips handed back from the rail sim to the timetable: delay (s) when handed back */
  private delays = new Map<number, { d: number; t: number }>();
  private lastAgentDelay = new Map<number, number>();

  /**
   * A train that leaves the agent radius is drawn from the timetable again, shifted by
   * the delay it had (recovering 6 s per minute) so it does not jump ahead.
   */
  private applyDelays(v: import('../transit').VehicleBuffers) {
    const now = this.lastT;
    for (const [trip, d] of this.lastAgentDelay) {
      if (!this.agents.has(trip) && !this.busAgents.has(trip) && d > 5) this.delays.set(trip, { d, t: now });
    }
    this.lastAgentDelay.clear();
    const f = this.railSnap?.f;
    if (f) for (const [trip, k] of this.agents) if (k >= 0) this.lastAgentDelay.set(trip, f[k * RAIL_STRIDE + 6]);
    const bf = this.busSnap?.f;
    if (bf) for (const [trip, k] of this.busAgents) this.lastAgentDelay.set(trip, bf[k * BUS_STRIDE + 4]);
    if (!this.delays.size) return;
    for (let i = 0; i < v.count; i++) {
      const e = this.delays.get(v.trip[i]);
      if (!e) continue;
      if (this.agents.has(v.trip[i])) { this.delays.delete(v.trip[i]); continue; }
      const d = e.d - Math.max(0, now - e.t) * 0.1;
      if (d <= 1) { this.delays.delete(v.trip[i]); continue; }
      const vs = this.system.vehicleAt(v.trip[i], now - d);
      if (!vs) continue;
      v.x[i] = vs.x; v.y[i] = vs.y; v.z[i] = vs.z; v.heading[i] = vs.heading; v.dist[i] = vs.dist; v.speed[i] = vs.speed; v.state[i] = vs.state;
    }
    if (this.delays.size > 2000) this.delays.clear();
  }

  /** read the rail agents published by the traffic sim; fills `agents` */
  private railAgents() {
    this.agents.clear();
    const src = this.traffic() as unknown as Partial<RailSource> | null;
    if (!src || typeof src.railSnapshot !== 'function') return null;
    src.railProfile = this.profile;
    if (!this.profile || src.railFeedsProfile !== this.profile) return null;
    const snap = src.railSnapshot();
    this.railSnap = snap;
    if (!snap || !snap.count) return null;
    const { f, u, feeds } = snap;
    this.parked.length = 0;
    for (let k = 0; k < snap.count; k++) {
      const o = k * RAIL_STRIDE;
      const agency = feeds[f[o]];
      if (!agency) continue;
      if (f[o + 1] < 0) { this.parked.push(k); continue; } // stabled in a depot (no trip)
      const trip = this.system.tripIndex(agency, 'rail', f[o + 1]);
      if (trip < 0) continue;
      this.agents.set(trip, u[o + 5] & RAIL_FLAG.PENDING ? -1 : k);
    }
    return snap;
  }

  /**
   * Trips for tests / tools: running now, optionally of a route (id "go:..." or short name
   * like "KI" / "504"), near a point, only rail agents. Sorted by distance.
   */
  findTrips(q: { route?: string; near?: [number, number]; within?: number; agents?: boolean } = {}): { trip: number; route: string; headsign: string; agent: boolean; dist: number }[] {
    const s = this.system, v = s.vehicles, out = [];
    for (let i = 0; i < v.count; i++) {
      const r = s.routes[v.route[i]];
      if (q.route && r?.id !== q.route && r?.short !== q.route) continue;
      const agent = this.agents.has(v.trip[i]);
      if (q.agents && !agent) continue;
      const dist = q.near ? Math.hypot(v.x[i] - q.near[0], v.y[i] - q.near[1]) : 0;
      if (q.within !== undefined && dist > q.within) continue;
      const info = s.tripInfo(v.trip[i]);
      out.push({ trip: v.trip[i], route: r?.short ?? '', headsign: info?.headsign ?? '', agent, dist });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** global trip ids currently driven by the rail sim (-1 values = not placed yet) */
  get agentTrips(): number[] {
    return [...this.agents.keys()];
  }

  /**
   * The track under a rail agent as the sim publishes it (rear -> front, a few metres past
   * both ends) and its front / centre along it: what the rider cameras sample, so they sit on
   * the consist that is drawn whatever the timetable says. `trip` or, when that trip is no
   * longer driven (the train went on to its next trip / into service as empty stock), the sim
   * train `id`. Returns the trip it is running now (-1: not in service).
   */
  agentTrack(trip: number, id?: number): { shape: PatternShape; front: number; centre: number; speed: number; id: number; trip: number; length: number } | null {
    const snap = this.railSnap;
    if (!snap) return null;
    let k = this.agents.get(trip);
    let cur = trip;
    if ((k === undefined || k < 0) && id !== undefined) {
      k = undefined;
      for (let j = 0; j < snap.count; j++) {
        if (snap.u[j * RAIL_STRIDE + 9] !== id) continue;
        k = j;
        const agency = snap.feeds[snap.f[j * RAIL_STRIDE]];
        const loc = snap.f[j * RAIL_STRIDE + 1];
        cur = agency && loc >= 0 ? this.system.tripIndex(agency, 'rail', loc) : -1;
        break;
      }
    }
    if (k === undefined || k < 0) return null;
    const o = k * RAIL_STRIDE, f = snap.f;
    const p0 = f[o + 10], pn = f[o + 11];
    if (pn < 2) return null;
    const shape = pathShape(snap.path, p0, pn, snap.oe, snap.on);
    const adv = Math.min(0.15, Math.max(0, (clock.simMs - snap.simMs) / 1000));
    const front = shape.length - 3 + f[o + 3] * adv;
    const pat = cur >= 0 ? this.system.tripPattern(cur) : this.system.patternIndex(snap.feeds[f[o]] ?? '', 'rail', f[o + 8]);
    const mode = pat >= 0 ? this.system.patternMode(pat) : null;
    const length = mode ? layoutFor(mode, this.system.routes[this.system.patternRoute(pat)]).length : shape.length - 6;
    return { shape, front, centre: front - length / 2, speed: f[o + 3], id: snap.u[o + 9], trip: cur, length };
  }

  /** State of a rail-agent trip from the sim (null if the timetable drives it). */
  agentInfo(trip: number): { dist: number; speed: number; delay: number; dwell: boolean; doors: boolean; deadhead: boolean } | null {
    const k = this.agents.get(trip);
    if (k === undefined || k < 0 || !this.railSnap) return null;
    const o = k * RAIL_STRIDE, f = this.railSnap.f, fl = this.railSnap.u[o + 5];
    return { dist: f[o + 2], speed: f[o + 3], delay: f[o + 6], dwell: !!(fl & RAIL_FLAG.DWELL), doors: !!(fl & RAIL_FLAG.DOORS), deadhead: !Number.isFinite(f[o + 2]) };
  }

  private readBuses() {
    this.busAgents.clear();
    const src = this.traffic() as unknown as Partial<RailSource> | null;
    const snap = src?.busSnapshot?.() ?? null;
    this.busSnap = snap;
    if (!snap) return;
    for (let k = 0; k < snap.count; k++) this.busAgents.set(snap.f[k * BUS_STRIDE], k);
  }

  private drawBuses(ctx: FrameContext, markerPx: number, counts: Map<Mode, number>) {
    const snap = this.busSnap!;
    const { f, u, path, oe, on } = snap;
    const adv = Math.min(0.15, Math.max(0, (clock.simMs - snap.simMs) / 1000));
    const camE = ctx.cameraPos.x, camN = -ctx.cameraPos.z;
    const view = ctx.view;
    const pxK = 1 / Math.max(1, ctx.pixelScale);
    const markerMax = Math.max(view.r2 * 2.5, ctx.altitude * 40);
    for (const [trip, k] of this.busAgents) {
      if (this.overrides.has(trip)) continue;
      const o = k * BUS_STRIDE;
      const pat = this.system.tripPattern(trip);
      if (pat < 0) continue;
      const route = this.system.patternRoute(pat);
      const p0 = f[o + 6], pn = f[o + 7];
      if (pn < 2) continue;
      const shape = pathShape(path, p0, pn, oe, on);
      const lay = layoutFor('bus', this.system.routes[route]);
      const front = shape.length - 1 + Math.min(f[o + 2] * adv, 0.5);
      const c = shape.point(front - lay.length / 2, _p);
      const dc = Math.hypot(c[0] - camE, c[1] - camN);
      if (dc > markerMax) continue;
      const sty = STYLE.bus;
      const rad = dc < NEAR ? 20 : Math.max(sty.size[0], sty.minPixels * markerPx * 2 * dc * pxK);
      if (!view.sphereEN(c[0], c[1], c[2], rad)) continue;
      this.noteSeen('b' + trip, c[0], c[1], camE, camN);
      const flags = u[o + 3];
      if (dc < NEAR) {
        this.drawConsist(shape, lay, front, 1, this.routeTint[route] ?? _white, dc > LOW_DETAIL, flags & BUS_FLAG.BRAKE ? FLAG_BRAKE : 0, 0, trip);
        this.notePose(trip, shape, front - lay.length / 2, lay.length, 1, 0);
        this.stats.near++;
      } else {
        const mk = this.markers.get('bus')!;
        const kk = counts.get('bus')!;
        if (kk >= mk.capacity) continue;
        const d = shape.direction(front - lay.length / 2, _d);
        const hd = Math.atan2(d[1], d[0]);
        mk.setMarker(kk, c[0], c[1], c[2], hd, this.routeColor[route] ?? 0xffffff);
        counts.set('bus', kk + 1);
        this.notePoint(trip, c[0], c[1], c[2], hd, lay.length);
        this.pushPick(trip, c[0], c[1], c[2] + 2, hd, Math.max(lay.length, sty.minPixels * markerPx * dc * pxK));
      }
    }
  }

  /** hand scheduled buses near the focus to the traffic sim (it drives them on the road graph) */
  private askBuses(ctx: FrameContext) {
    const src = this.traffic() as unknown as Partial<RailSource> | null;
    if (!src?.requestBuses || !src.busSnapshot) return;
    const R = (src.simRadius ?? 0) * 0.8;
    if (R <= 0 || this.lastT - this.busAskAt < 0.5 && this.busAskAt <= this.lastT) return;
    this.busAskAt = this.lastT;
    const v = this.system.vehicles;
    const fE = ctx.focus.x, fN = -ctx.focus.z;
    const spawn: Parameters<NonNullable<RailSource['requestBuses']>>[0] = [];
    const pats: Parameters<NonNullable<RailSource['requestBuses']>>[1] = [];
    // buses that finished their trip continue as the next trip of their vehicle block
    const retrip: NonNullable<Parameters<NonNullable<RailSource['requestBuses']>>[2]> = [];
    const pullin: NonNullable<Parameters<NonNullable<RailSource['requestBuses']>>[4]> = [];
    const bs = this.busSnap;
    if (bs) {
      for (const [trip, k] of this.busAgents) {
        if (!(bs.u[k * BUS_STRIDE + 3] & BUS_FLAG.NIS)) continue;
        const nx = this.system.tripNext(trip);
        if (nx < 0) {
          // block over: back to the garage
          if (this.busAsked.has(-trip - 1e6)) continue;
          this.busAsked.set(-trip - 1e6, this.lastT);
          const agency = this.system.tripLocal(trip)?.agency;
          const q = bs.path.subarray((bs.f[k * BUS_STRIDE + 6] + bs.f[k * BUS_STRIDE + 7] - 1) * 3);
          const be = q[0] + bs.oe, bn = q[1] + bs.on;
          let g: (typeof GARAGES)[number] | null = null, gd = 12000;
          for (const x of GARAGES) {
            const d = Math.hypot(x[2] - be, x[3] - bn);
            if (x[0] === agency && d < gd) { gd = d; g = x; }
          }
          if (g && Math.hypot(g[2] - fE, g[3] - fN) < R) pullin.push({ trip, gx: g[2], gy: g[3] });
          continue;
        }
        if (this.busAgents.has(nx)) continue;
        const asked = this.busAsked.get(-nx - 1);
        if (asked !== undefined && Math.abs(this.lastT - asked) < 10) continue;
        this.busAsked.set(-nx - 1, this.lastT);
        const info = this.system.tripInfo(nx);
        if (!info || info.start - this.lastT > 2400) continue;
        const pat = info.pattern;
        const shape = this.system.patternShape(pat);
        if (!shape) continue;
        if (!this.busSent.has(pat)) {
          this.busSent.add(pat);
          const xy = new Float64Array(shape.count * 2);
          for (let q = 0; q < shape.count; q++) { xy[q * 2] = shape.xyz[q * 3]; xy[q * 2 + 1] = shape.xyz[q * 3 + 1]; }
          pats.push({ id: pat, xy, stopD: Float32Array.from(info.stops.map((x) => x.dist)), stopFlag: Uint8Array.from(info.stops.map((x) => (x.virtual ? 1 : 0))) });
        }
        retrip.push({ old: trip, trip: nx, pat, arr: Float64Array.from(info.stops.map((x) => x.arr)), dep: Float64Array.from(info.stops.map((x) => x.dep)) });
      }
    }
    for (let i = 0; i < v.count && spawn.length < 40; i++) {
      if (v.mode[i] !== MODE_ID.bus) continue;
      const trip = v.trip[i];
      if (this.busAgents.has(trip) || this.overrides.has(trip)) continue;
      if (Math.hypot(v.x[i] - fE, v.y[i] - fN) > R) continue;
      const asked = this.busAsked.get(trip);
      if (asked !== undefined && Math.abs(this.lastT - asked) < 4) continue;
      this.busAsked.set(trip, this.lastT);
      const info = this.system.tripInfo(trip);
      const shape = this.system.patternShape(v.pattern[i]);
      if (!info || !shape) continue;
      const lay = layoutFor('bus', info.routeMeta);
      if (!this.busSent.has(v.pattern[i])) {
        this.busSent.add(v.pattern[i]);
        const xy = new Float64Array(shape.count * 2);
        for (let k = 0; k < shape.count; k++) { xy[k * 2] = shape.xyz[k * 3]; xy[k * 2 + 1] = shape.xyz[k * 3 + 1]; }
        pats.push({ id: v.pattern[i], xy, stopD: Float32Array.from(info.stops.map((x) => x.dist)), stopFlag: Uint8Array.from(info.stops.map((x) => (x.virtual ? 1 : 0))) });
      }
      spawn.push({
        trip, pat: v.pattern[i], len: lay.length, front: v.dist[i] + lay.length / 2, v: v.speed[i],
        arr: Float64Array.from(info.stops.map((x) => x.arr)), dep: Float64Array.from(info.stops.map((x) => x.dep)),
      });
    }
    if (this.busAsked.size > 5000) this.busAsked.clear();
    // first trips of vehicle blocks near the focus leave their garage in time for the departure
    const pullout: NonNullable<Parameters<NonNullable<RailSource['requestBuses']>>[3]> = [];
    for (const trip of this.system.tripsStarting('bus', this.lastT, this.lastT + 900, this.upcoming)) {
      if (pullout.length >= 10) break;
      if (this.busAgents.has(trip) || this.busAsked.has(trip)) continue;
      if (this.system.tripPrev(trip) >= 0) continue;
      const info = this.system.tripInfo(trip);
      if (!info || !info.stops.length) continue;
      const sp = this.system.stopPosition(info.stops[0].stop);
      if (Math.hypot(sp[0] - fE, sp[1] - fN) > R) continue;
      let g: (typeof GARAGES)[number] | null = null, gd = 9000;
      for (const x of GARAGES) {
        if (x[0] !== info.agency) continue;
        const d = Math.hypot(x[2] - sp[0], x[3] - sp[1]);
        if (d < gd && Math.hypot(x[2] - fE, x[3] - fN) < R) { gd = d; g = x; }
      }
      if (!g) continue;
      const eta = (gd * 1.35) / 9 + 60;
      if (info.start - this.lastT > eta) continue; // not yet
      this.busAsked.set(trip, this.lastT);
      const shape = this.system.patternShape(info.pattern);
      if (!shape) continue;
      if (!this.busSent.has(info.pattern)) {
        this.busSent.add(info.pattern);
        const xy = new Float64Array(shape.count * 2);
        for (let q = 0; q < shape.count; q++) { xy[q * 2] = shape.xyz[q * 3]; xy[q * 2 + 1] = shape.xyz[q * 3 + 1]; }
        pats.push({ id: info.pattern, xy, stopD: Float32Array.from(info.stops.map((x) => x.dist)), stopFlag: Uint8Array.from(info.stops.map((x) => (x.virtual ? 1 : 0))) });
      }
      const lay = layoutFor('bus', info.routeMeta);
      pullout.push({ trip, pat: info.pattern, len: lay.length, arr: Float64Array.from(info.stops.map((x) => x.arr)), dep: Float64Array.from(info.stops.map((x) => x.dep)), gx: g[2], gy: g[3] });
    }
    if (spawn.length || retrip.length || pullout.length || pullin.length) src.requestBuses(spawn, pats, retrip, pullout, pullin);
  }

  /** Is this trip driven by the rail sim right now? */
  isAgent(trip: number): boolean {
    return this.agents.has(trip);
  }

  private pushGround(e: number, n: number, heading: number, lay: ConsistLayout, speed: number, trip: number, slot: number, rail?: boolean, doorsOpen?: boolean) {
    let g = this.ground[this.groundN];
    if (!g) this.ground.push((g = { e: 0, n: 0, heading: 0, length: 0, width: 0, speed: 0, trip: 0, slot: 0 }));
    g.e = e; g.n = n; g.heading = heading; g.length = lay.length; g.width = lay.width; g.speed = speed; g.trip = trip; g.slot = slot;
    g.rail = rail; g.doorsOpen = doorsOpen;
    this.groundN++;
  }

  private drawConsist(shape: PatternShape, lay: ConsistLayout, front: number, dir: 1 | -1, tint: THREE.Color, low: boolean, flags: number, lat: number, trip = -1, mode = -1) {
    // subway / commuter / airport / intercity rail run at the network model's track z as drawn
    // (docs/ROADS.md "Source of truth"); street-running vehicles snap to the draped road surface
    const own = mode === MODE_ID.subway || mode === MODE_ID.commuter_rail || mode === MODE_ID.airport_rail || mode === MODE_ID.intercity_rail;
    const H = own ? null : (e: number, n: number) => this.engine.heightAt(e, n);
    const pose = this.pose;
    const hl = trip >= 0 && this.highlight.size ? this.highlight.get(trip) ?? 0 : 0;
    for (let c = 0; c < lay.cars.length; c++) {
      placeCar(shape, lay, c, front, H, pose, dir, lat);
      this.pools.add(lay.cars[c], low, pose.e - this.ax, pose.z, -pose.n - this.az, pose.heading, pose.pitch, tint, flags, hl);
      if (trip >= 0) this.pushPick(trip, pose.e, pose.n, pose.z + lay.cars[c].size[1] * 0.6, pose.heading, lay.cars[c].size[0]);
    }
  }

  /** render-time lateral offset of a pattern (bus shapes not yet matched to road lanes) */
  private laneOf(pattern: number, mode: number): number {
    return mode === MODE_ID.bus && this.system.patternInLane(pattern) ? 0 : LANE_OFFSET[mode];
  }

  /** inside the camera's horizontal view cone (a little wider than the frustum) */
  private inViewCone(e: number, n: number, camE: number, camN: number): boolean {
    const dx = e - camE, dy = n - camN, d = Math.hypot(dx, dy);
    return d < 60 || (dx * this.camFwd[0] + dy * this.camFwd[1]) / d > 0.55;
  }

  private noteSeen(key: string, e: number, n: number, camE: number, camN: number) {
    if (Math.hypot(e - camE, n - camN) < 2500) this.seen.set(key, [e, n]);
  }

  /** compare the vehicles near the camera with last frame: appearing / vanishing in view */
  private popCheck(ctx: FrameContext) {
    const ce = ctx.cameraPos.x, cn = -ctx.cameraPos.z;
    const dir = this.engine.camera.getWorldDirection(_v3);
    let fx = dir.x, fy = -dir.z;
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    const prev = this.camPrev;
    this.camPrev = [ce, cn, fx, fy];
    const cur = this.seen;
    const old = this.seenPrev;
    // skip camera jumps and clock jumps (scrubbing / setTimeOfDay)
    const tJump = Math.abs(this.lastT - this.popT - ctx.simDt) > 5;
    this.popT = this.lastT;
    if (prev && !tJump && Math.hypot(ce - prev[0], cn - prev[1]) < 150 && ctx.simDt < 1) {
      const inCone = (e: number, n: number, c: [number, number, number, number]) => {
        const dx = e - c[0], dy = n - c[1], d = Math.hypot(dx, dy);
        return d < 2000 && (d < 40 || (dx * c[2] + dy * c[3]) / d > 0.85);
      };
      const appeared: [string, number, number][] = [], vanished: [string, number, number][] = [];
      for (const [k, p] of cur) if (!old.has(k) && inCone(p[0], p[1], prev) && inCone(p[0], p[1], this.camPrev)) appeared.push([k, p[0], p[1]]);
      for (const [k, p] of old) if (!cur.has(k) && inCone(p[0], p[1], prev) && inCone(p[0], p[1], this.camPrev)) vanished.push([k, p[0], p[1]]);
      // a representation swap (timetable <-> sim) moves the key but not the vehicle
      const near = (a: [string, number, number], list: [string, number, number][]) => list.some((b) => Math.hypot(a[1] - b[1], a[2] - b[2]) < 40);
      for (const a of appeared) if (!near(a, vanished)) { this.popStats.spawn++; if (this.popStats.examples.length < 20) this.popStats.examples.push({ kind: 'spawn', e: a[1], n: a[2], key: a[0] }); }
      for (const a of vanished) if (!near(a, appeared)) { this.popStats.despawn++; if (this.popStats.examples.length < 20) this.popStats.examples.push({ kind: 'despawn', e: a[1], n: a[2], key: a[0] }); }
    }
    this.seenPrev = cur;
    this.seen = old;
    this.seen.clear();
  }

  private pushPick(trip: number, e: number, n: number, z: number, heading: number, length: number) {
    if ((this.pickCount + 1) * 6 > this.pickSegs.length) {
      const b = new Float64Array(this.pickSegs.length * 2);
      b.set(this.pickSegs);
      this.pickSegs = b;
    }
    const o = this.pickCount * 6, c = Math.cos(heading) * length / 2, s = Math.sin(heading) * length / 2;
    const p = this.pickSegs;
    p[o] = trip; p[o + 1] = e - c; p[o + 2] = n - s; p[o + 3] = e + c; p[o + 4] = n + s; p[o + 5] = z;
    this.pickCount++;
  }

  private traffic(): object | null {
    return (this.engine.layers.find((l) => l.id === 'traffic') as object | undefined) ?? null;
  }

  // ------------------------------------------------------------------ public API

  /**
   * Surface transit vehicles (bus, streetcar, at-grade LRT) near the focus, for
   * the traffic sim to treat as obstacles. Fills `out` (objects reused if
   * present) and returns the count. Position = front-centre, heading rad CCW
   * from +E, as rendered this frame (including holds).
   */
  groundVehicles(out: GroundVeh[]): number {
    for (let k = 0; k < this.groundN; k++) {
      const g = this.ground[k];
      const o = out[k] ?? (out[k] = { e: 0, n: 0, heading: 0, length: 0, width: 0, speed: 0, trip: 0 });
      o.e = g.e; o.n = g.n; o.heading = g.heading; o.length = g.length; o.width = g.width; o.speed = g.speed; o.trip = g.trip;
      o.rail = g.rail; o.doorsOpen = g.doorsOpen;
    }
    return this.groundN;
  }

  /** Rendered distance of a trip along its pattern (the schedule's unless it is held behind an obstacle). */
  displayDist(trip: number, schedDist: number): number {
    const k = this.agents.get(trip);
    if (k !== undefined && k >= 0 && this.railSnap) {
      // rail agent: its centre along the pattern (NaN while on a turnback move)
      const o = k * RAIL_STRIDE, f = this.railSnap.f;
      if (Number.isFinite(f[o + 2])) return f[o + 2];
    }
    return schedDist;
  }

  /** Length (m) of the consist drawn for a trip. */
  vehicleLength(trip: number): number {
    let L = this.lenCache.get(trip);
    if (L === undefined) {
      const info = this.system.tripInfo(trip);
      L = info ? layoutFor(info.mode, info.routeMeta).length : 0;
      if (this.lenCache.size > 256) this.lenCache.clear();
      this.lenCache.set(trip, L);
    }
    return L;
  }
  private lenCache = new Map<number, number>();

  /** Front-to-back car layout for a mode / route (consist spec, lengths, pivots). */
  consistLayout(mode: Mode, route: number): ConsistLayout {
    return layoutFor(mode, this.system.routes[route]);
  }

  dispose() {
    for (const o of this.lines.values()) o.dispose();
    for (const o of this.markers.values()) o.dispose();
    this.pools.dispose();
  }
}

const _p = [0, 0, 0], _q = [0, 0, 0], _d = [0, 0];

/** consist path from a rail agent record: points rear -> front relative to (oe, on) */
function pathShape(path: Float32Array, p0: number, n: number, oe: number, on: number): PatternShape {
  const xyz = new Float32Array(n * 3);
  const dist = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (p0 + i) * 3;
    xyz[i * 3] = path[j] + oe; xyz[i * 3 + 1] = path[j + 1] + on; xyz[i * 3 + 2] = path[j + 2];
    if (i) acc += Math.hypot(path[j] - path[j - 3], path[j + 1] - path[j - 2]);
    dist[i] = acc;
  }
  return new PatternShape(-1, xyz, dist);
}
const _white = new THREE.Color(0xffffff);

/** bus garages [agency, name, E, N] (approximate site entrances; buses pull out / in here) */
const GARAGES: [string, string, number, number][] = [
  ['ttc', 'Arrow Road', -11902, 11877], ['ttc', 'Birchmount', 9205, 5817], ['ttc', 'Malvern', 11929, 15155],
  ['ttc', 'McNicoll', 7740, 17648], ['ttc', 'Mount Dennis', -8771, 4317], ['ttc', 'Queensway', -11365, -3568],
  ['ttc', 'Wilson', -5946, 8536], ['miway', 'Central Parkway', -20897, -6100], ['miway', 'Malton', -20376, 5897],
  ['yrt', 'Richmond Hill', 16, 21755], ['yrt', 'Newmarket', -6154, 45202], ['yrt', 'Vaughan', -11249, 16876],
  ['brampton', 'Clark', -27789, 6480], ['brampton', 'Sandalwood', -31159, 9717], ['drt', 'Westney (Ajax)', 28879, 22706],
  ['drt', 'Raleigh (Oshawa)', 40504, 28101], ['hsr', 'Mountain', -41194, -50782], ['grt', 'Northfield', -92829, -16270],
  ['grt', 'Strasburg', -88020, -25891], ['burlington', 'Harvester', -32161, -31388], ['oakville', 'South Service', -26461, -24746],
  ['go', 'Steeprock (bus)', -8035, 13649], ['go', 'Newmarket (bus)', -4792, 45090],
];
const _v3 = new THREE.Vector3();
