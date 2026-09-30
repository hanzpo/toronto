// Schedule-driven transit: route lines (analytics) + every active vehicle.
// Positions come straight from the timetable at the current sim time, so
// scrubbing/speeding the clock needs no simulation state.
//
// Near the camera (< NEAR m) every car / module of a vehicle is drawn on its
// own (layers/transit/: consist placement along the pattern shape, one
// instanced mesh per car type) sitting on the rendered terrain, and surface
// vehicles near the focus are held behind obstacles (traffic, red signals,
// the vehicle ahead) — see transit/hold.ts. Far away each vehicle is one
// min-pixel-size marker.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { LineOverlay } from '../render/overlay/LineOverlay';
import { MarkerOverlay } from '../render/overlay/MarkerOverlay';
import { VEHICLE_MODELS } from '../models/vehicles';
import { clock } from '../state/clock';
import { useApp, type AnalyticsKey } from '../state/store';
import { MODES, MODE_ID, STATE_DWELL, TransitSystem, fetchLoader, type Mode, type PatternShape, type Profile } from '../transit';
import { LANE_OFFSET, layoutFor, placeCar, type CarPose, type ConsistLayout } from './transit/consist';
import { HoldController, type GroundVeh, type TrafficQueries } from './transit/hold';
import { CarPools, FLAG_BRAKE } from './transit/pools';

export type { GroundVeh } from './transit/hold';

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
  private hold = new HoldController();
  /** rendered distance per vehicle slot (schedule, or held behind an obstacle) */
  private rdist = new Float64Array(0);
  /** surface vehicles near the focus this frame (for the traffic sim and the hold logic) */
  private ground: (GroundVeh & { slot: number })[] = [];
  private groundN = 0;
  private prevSpeed = new Map<number, number>();
  private nextSpeed = new Map<number, number>();
  private pose: CarPose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
  private ax = 0; private az = 0;
  /** stats: cars drawn individually / vehicles held */
  stats = { cars: 0, held: 0, near: 0 };

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
      await this.system.load(p, { onFeed: () => this.onFeedLoaded() });
      this.profile = p;
      this.onFeedLoaded();
    } finally {
      this.loading = false;
    }
  }

  private onFeedLoaded() {
    this.routeColor = this.system.routes.map((r) => hex(r.color));
    this.routeTint = this.routeColor.map((c) => new THREE.Color(c));
    this.linesBuilt.clear();
    this.hold.clear();
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
    // route lines per analytics toggle
    for (const m of MODE_LIST) {
      const on = an[STYLE[m].key];
      const ov = this.lines.get(m)!;
      if (on && !this.linesBuilt.has(m) && this.system.tripCount > 0) this.buildLines(m);
      ov.setVisible(on && !this.hideLines);
      ov.update(ctx);
    }
    // vehicles
    const counts = new Map<Mode, number>();
    for (const m of MODE_LIST) counts.set(m, 0);
    const ax = ctx.anchor.origin.x, az = ctx.anchor.origin.z;
    this.ax = ax; this.az = az;
    this.pools.group.position.set(ax, 0, az);
    this.pools.begin();
    this.groundN = 0;
    this.stats.near = 0;
    if (an.vehicles && this.system.tripCount > 0) {
      this.lastT = clock.serviceDay().sec;
      const v = this.system.evaluate(this.lastT);
      const near = ctx.altitude < 3000;
      if (this.drawn.length < v.capacity) this.drawn = new Uint8Array(v.capacity);
      if (this.rdist.length < v.capacity) this.rdist = new Float64Array(v.capacity);
      this.drawn.fill(0, 0, v.count);
      const camE = ctx.cameraPos.x, camN = -ctx.cameraPos.z;
      const fE = ctx.focus.x, fN = -ctx.focus.z;
      const H = (e: number, n: number) => this.engine.heightAt(e, n);
      // --- surface vehicles near the focus: obstacles + hold
      const holdDt = ctx.simDt;
      const holdOn = near && holdDt > 0 && holdDt < 0.75;
      if (!holdOn && holdDt !== 0) this.hold.clear();
      for (let i = 0; i < v.count; i++) {
        this.rdist[i] = v.dist[i];
        if (!near || !(SURFACE & (1 << v.mode[i]))) continue;
        if (Math.abs(v.x[i] - fE) > HOLD_RADIUS || Math.abs(v.y[i] - fN) > HOLD_RADIUS) continue;
        if (this.overrides.has(v.trip[i])) continue;
        const shape = this.system.patternShape(v.pattern[i]);
        if (!shape) continue;
        const lay = layoutFor(MODE_LIST_BY_ID[v.mode[i]], this.system.routes[v.route[i]]);
        const d = this.hold.dist(v.trip[i], v.dist[i]);
        this.rdist[i] = d;
        const front = d + lay.length / 2;
        const p = shape.point(front, _p);
        if (Math.abs(p[2] - H(p[0], p[1])) > 4) continue; // tunnel / elevated: not in traffic
        const dir = shape.direction(front, _d);
        const lat = LANE_OFFSET[v.mode[i]];
        this.pushGround(p[0] + dir[1] * lat, p[1] - dir[0] * lat, Math.atan2(dir[1], dir[0]), lay, this.hold.speed(v.trip[i], v.speed[i]), v.trip[i], i);
      }
      const traffic = this.traffic();
      if (holdOn) {
        this.hold.begin(traffic, this.ground.slice(0, this.groundN));
        for (let k = 0; k < this.groundN; k++) {
          const g = this.ground[k];
          const i = g.slot;
          this.rdist[i] = this.hold.step({
            trip: g.trip, sched: v.dist[i], schedSpeed: v.speed[i], mode: v.mode[i],
            length: g.length, width: g.width, e: g.e, n: g.n, heading: g.heading,
          }, holdDt, traffic);
        }
        this.hold.end();
      }
      this.stats.held = this.hold.held;
      // --- draw
      const next = this.nextSpeed;
      next.clear();
      for (let i = 0; i < v.count; i++) {
        const mode = MODE_LIST_BY_ID[v.mode[i]];
        if (!mode) continue;
        if (!near && !an[STYLE[mode].key]) continue;
        if (this.overrides.size && this.overrides.has(v.trip[i])) continue;
        this.drawn[i] = 1;
        const color = this.routeColor[v.route[i]] ?? 0xffffff;
        const dc = Math.hypot(v.x[i] - camE, v.y[i] - camN);
        if (near && dc < NEAR) {
          const shape = this.system.patternShape(v.pattern[i]);
          if (shape) {
            const lay = layoutFor(mode, this.system.routes[v.route[i]]);
            const trip = v.trip[i];
            const sp = this.hold.speed(trip, v.speed[i]);
            const prev = this.prevSpeed.get(trip) ?? sp;
            next.set(trip, sp);
            const braking = sp < 0.2 || v.state[i] === STATE_DWELL || sp < prev - 0.01;
            this.drawConsist(shape, lay, this.rdist[i] + lay.length / 2, 1, this.routeTint[v.route[i]] ?? _white, dc > LOW_DETAIL, braking ? FLAG_BRAKE : 0, LANE_OFFSET[v.mode[i]]);
            this.stats.near++;
            continue;
          }
        }
        const mk = this.markers.get(mode)!;
        const k = counts.get(mode)!;
        if (k >= mk.capacity) continue;
        mk.setMarker(k, v.x[i], v.y[i], v.z[i], v.heading[i], color);
        counts.set(mode, k + 1);
      }
      this.nextSpeed = this.prevSpeed;
      this.prevSpeed = next;
    }
    for (const o of this.overrides.values()) {
      if (!o) continue;
      if (o.pattern !== undefined && o.dist !== undefined) {
        const shape = this.system.patternShape(o.pattern);
        const dc = Math.hypot(o.x - ctx.cameraPos.x, o.y + ctx.cameraPos.z);
        if (shape && dc < NEAR) {
          const lay = layoutFor(o.mode, this.system.routes[o.route]);
          const dir = o.dir ?? 1;
          this.drawConsist(shape, lay, o.dist + dir * lay.length / 2, dir, this.routeTint[o.route] ?? _white, dc > LOW_DETAIL, 0, LANE_OFFSET[MODE_ID[o.mode]]);
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
    this.pools.commit();
    this.stats.cars = this.pools.instances;
    for (const m of MODE_LIST) {
      const mk = this.markers.get(m)!;
      mk.setCount(counts.get(m)!);
      mk.commit();
      mk.update(ctx);
    }
  }

  private pushGround(e: number, n: number, heading: number, lay: ConsistLayout, speed: number, trip: number, slot: number) {
    let g = this.ground[this.groundN];
    if (!g) this.ground.push((g = { e: 0, n: 0, heading: 0, length: 0, width: 0, speed: 0, trip: 0, slot: 0 }));
    g.e = e; g.n = n; g.heading = heading; g.length = lay.length; g.width = lay.width; g.speed = speed; g.trip = trip; g.slot = slot;
    this.groundN++;
  }

  private drawConsist(shape: PatternShape, lay: ConsistLayout, front: number, dir: 1 | -1, tint: THREE.Color, low: boolean, flags: number, lat: number) {
    const H = (e: number, n: number) => this.engine.heightAt(e, n);
    const pose = this.pose;
    for (let c = 0; c < lay.cars.length; c++) {
      placeCar(shape, lay, c, front, H, pose, dir, lat);
      this.pools.add(lay.cars[c], low, pose.e - this.ax, pose.z, -pose.n - this.az, pose.heading, pose.pitch, tint, flags);
    }
  }

  private traffic(): TrafficQueries | null {
    return (this.engine.layers.find((l) => l.id === 'traffic') as unknown as TrafficQueries | undefined) ?? null;
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
    }
    return this.groundN;
  }

  /** Rendered distance of a trip along its pattern (the schedule's unless it is held behind an obstacle). */
  displayDist(trip: number, schedDist: number): number {
    return this.hold.dist(trip, schedDist);
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

const _p = [0, 0, 0], _d = [0, 0];
const _white = new THREE.Color(0xffffff);
