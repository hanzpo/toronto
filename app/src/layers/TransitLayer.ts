// Timetable transit: route lines (analytics) and every scheduled vehicle the
// network sim does not drive. Near the camera the sim (net/SimLayer) takes the
// trips over and draws them; it hides them here through `overrides`.
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
import { CarPools, FLAG_BRAKE } from './transit/pools';
import type { PatternShape } from '../transit/shape';

const NEAR = 2600;
const LOW_DETAIL = 450;

interface ModeStyle { key: AnalyticsKey; size: [number, number, number]; lineWidth: number; minPixels: number }

const STYLE: Record<Mode, ModeStyle> = {
  subway: { key: 'subway', size: [138, 3.7, 3.1], lineWidth: 5, minPixels: 9 },
  lrt: { key: 'lrt', size: [60, 3.7, 2.65], lineWidth: 4, minPixels: 8 },
  streetcar: { key: 'streetcar', size: [30.2, 3.8, 2.54], lineWidth: 2.5, minPixels: 6 },
  commuter_rail: { key: 'go', size: [305, 4.8, 3.0], lineWidth: 4, minPixels: 10 },
  airport_rail: { key: 'upx', size: [76, 4.3, 3.1], lineWidth: 4, minPixels: 8 },
  intercity_rail: { key: 'via', size: [180, 4.3, 3.1], lineWidth: 3, minPixels: 9 },
  bus: { key: 'bus', size: [12.2, 3.2, 2.6], lineWidth: 1.2, minPixels: 3 },
};
const MODE_LIST = Object.keys(STYLE) as Mode[];

function hex(c: string): number {
  return parseInt(c.replace('#', ''), 16) || 0x888888;
}

export interface TripOverride {
  x: number; y: number; z: number; heading: number;
  mode: Mode; route: number;
  pattern?: number;
  dist?: number;
  dir?: 1 | -1;
}

interface DrawnPose { x: number; y: number; z: number; heading: number; length: number }

export class TransitLayer implements Layer {
  readonly id = 'transit';
  readonly system: TransitSystem;
  /** trip -> pose drawn instead of the timetable (player-operated), or null to hide the trip */
  readonly overrides = new Map<number, TripOverride | null>();
  /** trip -> outline kind (render/overlay/OutlineSet: 1 hover, 2 selected) */
  readonly highlight = new Map<number, number>();
  hideLines = false;
  /** trips the network sim drives and draws itself */
  simOwns: ((trip: number) => boolean) | null = null;
  lastT = 0;
  stats = { cars: 0, near: 0 };
  /** pickable vehicle spans drawn this frame: [trip, e0, n0, e1, n1, z] × pickCount */
  pickSegs = new Float64Array(6 * 4096);
  pickCount = 0;

  private engine!: Engine;
  private ready = false;
  private loading = false;
  private profile: Profile | null = null;
  private lines = new Map<Mode, LineOverlay>();
  private linesBuilt = new Set<Mode>();
  private markers = new Map<Mode, MarkerOverlay>();
  private pools = new CarPools();
  private routeColor: number[] = [];
  private routeTint: THREE.Color[] = [];
  private prevSpeed = new Map<number, number>();
  private nextSpeed = new Map<number, number>();
  private pose: CarPose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
  private ax = 0;
  private az = 0;
  private evalBox: [number, number, number, number] = [0, 0, 0, 0];
  private drawnPose = new Map<number, DrawnPose>();
  private lenCache = new Map<number, number>();

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
      await this.system.load(p, { onFeed: () => this.onFeedLoaded(), beforeBus: () => this.firstView() });
      this.profile = p;
      this.onFeedLoaded();
    } finally {
      this.loading = false;
    }
  }

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
    const specs = this.system.routeLines({ modes: [mode] }).flatMap((rl) =>
      rl.lines.map((pts, i) => ({ id: `${rl.meta.id}:${i}`, points: pts, color: hex(rl.meta.color) })),
    );
    this.lines.get(mode)!.set(specs);
    this.linesBuilt.add(mode);
  }

  update(ctx: FrameContext) {
    if (!this.ready) return;
    if (!this.loading && this.currentProfile() !== this.profile) void this.ensureProfile();
    const an = useApp.getState().analytics;
    const analytics = ctx.analyticsMode;
    for (const m of MODE_LIST) {
      const on = analytics && an[STYLE[m].key];
      const ov = this.lines.get(m)!;
      if (on && !this.linesBuilt.has(m) && this.system.tripCount > 0) this.buildLines(m);
      ov.setVisible(on && !this.hideLines);
      ov.update(ctx);
    }
    const markerPx = analytics ? 1 : 0;
    for (const m of MODE_LIST) this.markers.get(m)!.setMinPixels(STYLE[m].minPixels * markerPx);
    const counts = new Map<Mode, number>(MODE_LIST.map((m) => [m, 0]));
    this.ax = ctx.anchor.origin.x;
    this.az = ctx.anchor.origin.z;
    this.pools.group.position.set(this.ax, 0, this.az);
    this.pools.begin();
    this.drawnPose.clear();
    this.pickCount = 0;
    this.stats.near = 0;
    if (an.vehicles && this.system.tripCount > 0) this.drawSchedule(ctx, an, markerPx, counts);
    this.drawOverrides(ctx, counts);
    this.pools.commit();
    this.stats.cars = this.pools.instances;
    for (const m of MODE_LIST) {
      const mk = this.markers.get(m)!;
      mk.setCount(counts.get(m)!);
      mk.commit();
      mk.update(ctx);
    }
  }

  private drawSchedule(ctx: FrameContext, an: Record<AnalyticsKey, boolean>, markerPx: number, counts: Map<Mode, number>) {
    this.lastT = clock.serviceDay().sec;
    const camE = ctx.cameraPos.x, camN = -ctx.cameraPos.z;
    if (ctx.altitude < 1500) {
      const R = Math.max(ctx.view.r2 * 2.5, ctx.altitude * 40) + 2000;
      this.evalBox[0] = camE - R; this.evalBox[1] = camN - R; this.evalBox[2] = camE + R; this.evalBox[3] = camN + R;
      this.system.setEvalBounds(this.evalBox);
    } else this.system.setEvalBounds(null);
    const v = this.system.evaluate(this.lastT);
    const near = ctx.altitude < 3000;
    const markerMax = Math.max(ctx.view.r2 * 2.5, ctx.altitude * 40);
    const pxK = 1 / Math.max(1, ctx.pixelScale);
    const next = this.nextSpeed;
    next.clear();
    for (let i = 0; i < v.count; i++) {
      const mode = MODES[v.mode[i]];
      if (!mode) continue;
      if (!near && !an[STYLE[mode].key]) continue;
      const trip = v.trip[i];
      if (this.overrides.has(trip) || this.simOwns?.(trip)) continue;
      const dc = Math.hypot(v.x[i] - camE, v.y[i] - camN);
      if (dc > markerMax) continue;
      const sty = STYLE[mode];
      const rad = near && dc < NEAR ? sty.size[0] + 60 : Math.max(sty.size[0], sty.minPixels * markerPx * 2 * dc * pxK);
      if (!ctx.view.sphereEN(v.x[i], v.y[i], v.z[i], rad)) continue;
      if (near && dc < NEAR) {
        const shape = this.system.patternShape(v.pattern[i]);
        if (shape) {
          const lay = layoutFor(mode, this.system.routes[v.route[i]]);
          const sp = v.speed[i];
          const prev = this.prevSpeed.get(trip) ?? sp;
          next.set(trip, sp);
          const braking = sp < 0.2 || v.state[i] === STATE_DWELL || sp < prev - 0.01;
          const lat = this.laneOf(v.pattern[i], v.mode[i]);
          this.drawConsist(shape, lay, v.dist[i] + lay.length / 2, 1, this.routeTint[v.route[i]], dc > LOW_DETAIL, braking ? FLAG_BRAKE : 0, lat, trip, v.mode[i]);
          this.notePose(trip, shape, v.dist[i], lay.length, 1, lat);
          this.stats.near++;
          continue;
        }
      }
      const mk = this.markers.get(mode)!;
      const k = counts.get(mode)!;
      if (k >= mk.capacity) continue;
      mk.setMarker(k, v.x[i], v.y[i], v.z[i], v.heading[i], this.routeColor[v.route[i]] ?? 0xffffff);
      counts.set(mode, k + 1);
      this.pushPick(trip, v.x[i], v.y[i], v.z[i] + 2, v.heading[i], Math.max(sty.size[0], sty.minPixels * markerPx * dc * pxK));
      this.drawnPose.set(trip, { x: v.x[i], y: v.y[i], z: v.z[i], heading: v.heading[i], length: sty.size[0] });
    }
    this.nextSpeed = this.prevSpeed;
    this.prevSpeed = next;
  }

  private drawOverrides(ctx: FrameContext, counts: Map<Mode, number>) {
    for (const o of this.overrides.values()) {
      if (!o) continue;
      if (o.pattern !== undefined && o.dist !== undefined) {
        const shape = this.system.patternShape(o.pattern);
        const dc = Math.hypot(o.x - ctx.cameraPos.x, o.y + ctx.cameraPos.z);
        if (shape && dc < NEAR) {
          const lay = layoutFor(o.mode, this.system.routes[o.route]);
          const dir = o.dir ?? 1;
          this.drawConsist(shape, lay, o.dist + dir * lay.length / 2, dir, this.routeTint[o.route], dc > LOW_DETAIL, 0, LANE_OFFSET[MODE_ID[o.mode]], -1, MODE_ID[o.mode]);
          continue;
        }
      }
      const mk = this.markers.get(o.mode)!;
      const k = counts.get(o.mode)!;
      if (k >= mk.capacity) continue;
      mk.setMarker(k, o.x, o.y, o.z, o.heading, this.routeColor[o.route] ?? 0xffffff);
      counts.set(o.mode, k + 1);
    }
  }

  private notePose(trip: number, shape: PatternShape, centre: number, length: number, dir: 1 | -1, lat: number) {
    const q = shape.point(centre, _p);
    const d = shape.direction(centre, _d);
    const z = Math.max(q[2], this.engine.heightAt(q[0], q[1]) - 3);
    this.drawnPose.set(trip, { x: q[0] + d[1] * lat, y: q[1] - d[0] * lat, z, heading: Math.atan2(d[1] * dir, d[0] * dir), length });
  }

  private drawConsist(shape: PatternShape, lay: ConsistLayout, front: number, dir: 1 | -1, tint: THREE.Color | undefined, low: boolean, flags: number, lat: number, trip: number, mode: number) {
    const own = mode === MODE_ID.subway || mode === MODE_ID.commuter_rail || mode === MODE_ID.airport_rail || mode === MODE_ID.intercity_rail;
    const H = own ? null : (e: number, n: number) => this.engine.heightAt(e, n);
    const pose = this.pose;
    const hl = trip >= 0 ? this.highlight.get(trip) ?? 0 : 0;
    for (let c = 0; c < lay.cars.length; c++) {
      placeCar(shape, lay, c, front, H, pose, dir, lat);
      this.pools.add(lay.cars[c], low, pose.e - this.ax, pose.z, -pose.n - this.az, pose.heading, pose.pitch, tint ?? _white, flags, hl);
      if (trip >= 0) this.pushPick(trip, pose.e, pose.n, pose.z + lay.cars[c].size[1] * 0.6, pose.heading, lay.cars[c].size[0]);
    }
  }

  private laneOf(pattern: number, mode: number): number {
    return mode === MODE_ID.bus && this.system.patternInLane(pattern) ? 0 : LANE_OFFSET[mode];
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

  drawnVehicle(trip: number): DrawnPose | null {
    return this.drawnPose.get(trip) ?? null;
  }

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

  dispose() {
    for (const o of this.lines.values()) o.dispose();
    for (const o of this.markers.values()) o.dispose();
    this.pools.dispose();
  }
}

const _p = [0, 0, 0], _d = [0, 0];
const _white = new THREE.Color(0xffffff);
