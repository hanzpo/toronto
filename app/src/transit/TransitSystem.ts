// Analytic transit runtime: every vehicle position is a pure function of sim time.
// Framework-free; usable on the main thread or in a worker. See docs/TRANSIT.md.

import { gunzip } from '../data/tbn.ts';
import {
  decodeFeed, MODE_ID, MODES,
  type Mode, type Profile, type RouteMeta, type TransitFeed, type TransitIndex,
} from './format.ts';
import { MODE_ACCEL, segmentMotion } from './motion.ts';
import { PatternShape } from './shape.ts';

export const DAY = 86400;

/** Vehicle states. */
export const STATE_MOVING = 0;
export const STATE_DWELL = 1;

/** Source of index.json and the binary feeds (already gunzipped). */
export interface TransitLoader {
  json(file: string): Promise<unknown>;
  binary(file: string): Promise<ArrayBuffer | null>;
}

export function fetchLoader(baseUrl = '/data/transit/'): TransitLoader {
  return {
    async json(file) {
      const r = await fetch(baseUrl + file);
      if (!r.ok) throw new Error(`${file}: ${r.status}`);
      return r.json();
    },
    async binary(file) {
      const r = await fetch(baseUrl + file);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${file}: ${r.status}`);
      return gunzip(r);
    },
  };
}

export interface LoadOptions {
  modes?: Mode[]; // only keep files that can contain these modes (rail/bus split)
  agencies?: string[];
  kinds?: ('rail' | 'bus')[];
  /** called after each file is decoded (rail files are loaded first) */
  onFeed?: (agency: string, kind: 'rail' | 'bus') => void;
  /** awaited before the (large) bus files are fetched, e.g. until the first view has loaded */
  beforeBus?: () => Promise<void>;
}

/** Reusable SoA output of evaluate(). Only the first `count` entries are valid. */
export interface VehicleBuffers {
  count: number;
  capacity: number;
  x: Float64Array; // world E (m)
  y: Float64Array; // world N (m)
  z: Float32Array; // elevation (datum m)
  heading: Float32Array; // rad, CCW from +E in the E/N plane
  pitch: Float32Array; // rad, positive = climbing
  speed: Float32Array; // m/s
  dist: Float32Array; // distance along the pattern shape (m)
  route: Int32Array; // global route index (TransitSystem.routes)
  trip: Int32Array; // global trip index
  pattern: Int32Array; // global pattern index
  mode: Uint8Array; // MODE_ID
  state: Uint8Array; // STATE_MOVING | STATE_DWELL
  prevStop: Int32Array; // global stop index (== nextStop while dwelling)
  nextStop: Int32Array;
  fraction: Float32Array; // 0..1 distance fraction between prevStop and nextStop
}

export interface VehicleState {
  trip: number; route: number; pattern: number; mode: Mode;
  x: number; y: number; z: number; heading: number; pitch: number; speed: number; dist: number;
  state: number; prevStop: number; nextStop: number; fraction: number;
}

export interface TripStop {
  stop: number; // global stop index
  name: string;
  arr: number; // seconds since service-day midnight (may exceed 86400)
  dep: number;
  dist: number; // along shape (m)
  virtual: boolean; // bbox-edge pass-through point, not a real stop
}

export interface TripInfo {
  trip: number;
  agency: string;
  route: number;
  routeMeta: RouteMeta;
  mode: Mode;
  headsign: string;
  name: string; // train number for rail where available
  pattern: number;
  start: number;
  end: number;
  stops: TripStop[];
}

export interface Arrival {
  trip: number;
  route: number;
  headsign: string;
  arr: number; // seconds relative to the queried service day (previous-day trips shifted by -86400)
  dep: number;
}

export interface RouteLine {
  route: number;
  meta: RouteMeta;
  /** polylines, xyz triples relative to `origin` (f32) */
  lines: Float32Array[];
}

export interface ModeLines {
  mode: Mode;
  /** polyline i spans vertices [offsets[i], offsets[i+1]) */
  offsets: Uint32Array;
  xyz: Float32Array; // relative to origin
  route: Int32Array; // global route index per polyline
}

interface FeedRt {
  f: TransitFeed;
  tripBase: number;
  patBase: number;
  stopBase: number;
  routeMap: Int32Array; // local route -> global
  // lazily built indexes
  stopPatOff?: Uint32Array;
  stopPatVal?: Uint32Array; // pattern
  stopPatK?: Uint32Array; // position of the stop within the pattern
  patTripOff?: Uint32Array;
  patTripVal?: Uint32Array;
  /** per pattern: shape bounding box minX, minY, maxX, maxY (lazy, for evaluate culling) */
  patBox?: Float32Array;
}

const HALF_LEN = 6; // m: heading/pitch from positions ±HALF_LEN along the shape

export class TransitSystem {
  readonly loader: TransitLoader;
  index: TransitIndex | null = null;
  profile: Profile | null = null;
  /** union of routes of loaded feeds (plus all routes from index.json) */
  routes: RouteMeta[] = [];
  private routeIdx = new Map<string, number>();
  private feeds: FeedRt[] = [];
  tripCount = 0;
  patternCount = 0;
  stopCount = 0;
  /** evaluate() only emits vehicles whose mode bit is set (bit = 1 << MODE_ID) */
  modeMask = 0x7f;
  /** Output of evaluate(). The object is reused; its arrays are replaced if capacity grows, so read them each frame. */
  readonly vehicles: VehicleBuffers;
  private tmp = new Float64Array(2);
  private shapeCache = new Map<number, PatternShape>();
  private sx = 0; private sy = 0; private sz = 0;

  constructor(loader: TransitLoader = fetchLoader()) {
    this.loader = loader;
    this.vehicles = allocBuffers(4096);
  }

  // ------------------------------------------------------------------ loading
  async loadIndex(): Promise<TransitIndex> {
    if (!this.index) {
      this.index = (await this.loader.json('index.json')) as TransitIndex;
      for (const r of this.index.routes) this.addRoute(r);
    }
    return this.index;
  }

  static profileForDate(date: Date): Profile {
    const d = date.getDay();
    return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday';
  }

  /** Loads the profile matching `date`'s weekday (if not already loaded). */
  async setProfileForDate(date: Date, opts: LoadOptions = {}): Promise<Profile> {
    const p = TransitSystem.profileForDate(date);
    if (p !== this.profile) await this.load(p, opts);
    return p;
  }

  /** Replace the loaded data with `profile`. Rail files load before bus files. */
  async load(profile: Profile, opts: LoadOptions = {}): Promise<void> {
    const index = await this.loadIndex();
    const wantKinds = new Set(opts.kinds ?? ['rail', 'bus']);
    if (opts.modes) {
      const m = new Set(opts.modes);
      if (!opts.modes.some((x) => x !== 'bus')) wantKinds.delete('rail');
      // streetcar routes may run replacement buses -> bus files needed for 'bus' only
      if (!m.has('bus')) wantKinds.delete('bus');
      this.modeMask = opts.modes.reduce((acc, x) => acc | (1 << MODE_ID[x]), 0);
    } else {
      this.modeMask = 0x7f;
    }
    const jobs: { agency: string; kind: 'rail' | 'bus'; file: string }[] = [];
    for (const kind of ['rail', 'bus'] as const) {
      if (!wantKinds.has(kind)) continue;
      for (const a of index.agencies) {
        if (opts.agencies && !opts.agencies.includes(a.id)) continue;
        const fm = a.profiles[profile]?.files[kind];
        if (fm) jobs.push({ agency: a.id, kind, file: fm.file });
      }
    }
    this.clear();
    this.profile = profile;
    const rail = jobs.filter((j) => j.kind === 'rail');
    const bus = jobs.filter((j) => j.kind === 'bus');
    for (const group of [rail, bus]) {
      if (group === bus && bus.length && opts.beforeBus) await opts.beforeBus();
      const bufs = await Promise.all(group.map((j) => this.loader.binary(j.file)));
      for (let i = 0; i < group.length; i++) {
        const b = bufs[i];
        if (!b) continue;
        // one feed per task: decoding every file back to back is a multi-100 ms long task
        if (i > 0) await new Promise<void>((r) => setTimeout(r, 0));
        this.addFeed(decodeFeed(b));
        opts.onFeed?.(group[i].agency, group[i].kind);
      }
    }
  }

  clear(): void {
    this.feeds = [];
    this.shapeCache.clear();
    this.tripCount = this.patternCount = this.stopCount = 0;
    this.vehicles.count = 0;
  }

  /** Add an already-decoded feed (e.g. from a worker or a node test). */
  addFeed(f: TransitFeed): void {
    const routeMap = new Int32Array(f.routes.length);
    f.routes.forEach((r, i) => (routeMap[i] = this.addRoute(r)));
    this.feeds.push({ f, tripBase: this.tripCount, patBase: this.patternCount, stopBase: this.stopCount, routeMap });
    this.tripCount += f.tripStart.length;
    this.patternCount += f.patStopOff.length - 1;
    this.stopCount += f.stopXYZ.length / 3;
  }

  private addRoute(r: RouteMeta): number {
    let i = this.routeIdx.get(r.id);
    if (i === undefined) {
      i = this.routes.length;
      this.routes.push(r);
      this.routeIdx.set(r.id, i);
    }
    return i;
  }

  routeIndex(id: string): number {
    return this.routeIdx.get(id) ?? -1;
  }

  setModes(modes: Mode[] | null): void {
    this.modeMask = modes ? modes.reduce((acc, x) => acc | (1 << MODE_ID[x]), 0) : 0x7f;
  }

  // --------------------------------------------------------------- evaluation
  /**
   * Positions of all active vehicles at `t` = seconds since local midnight of the
   * current service day. Trips of the previous service day still running after
   * midnight are included (evaluated at t + 86400 against the same profile).
   */
  evaluate(t: number): VehicleBuffers {
    const out = this.vehicles;
    out.count = 0;
    for (const fr of this.feeds) {
      this.evalFeed(fr, t, out);
      if (fr.f.maxEnd > DAY && t < fr.f.maxEnd - DAY) this.evalFeed(fr, t + DAY, out);
    }
    return out;
  }

  /**
   * Skip trips whose whole pattern lies outside this box (E/N metres) in
   * evaluate(), e.g. far beyond anything drawn at street level; null = all.
   */
  setEvalBounds(b: [number, number, number, number] | null): void {
    this.evalBounds = b;
  }
  private evalBounds: [number, number, number, number] | null = null;

  private patternBoxes(fr: FeedRt): Float32Array {
    if (fr.patBox) return fr.patBox;
    const f = fr.f, nP = f.patStopOff.length - 1;
    const box = new Float32Array(nP * 4);
    for (let p = 0; p < nP; p++) {
      const g = f.patShape[p], v0 = f.shapeOff[g], v1 = f.shapeOff[g + 1];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let v = v0; v < v1; v++) {
        const x = f.shapeXYZ[v * 3], y = f.shapeXYZ[v * 3 + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      box[p * 4] = x0; box[p * 4 + 1] = y0; box[p * 4 + 2] = x1; box[p * 4 + 3] = y1;
    }
    return (fr.patBox = box);
  }

  private evalFeed(fr: FeedRt, tt: number, out: VehicleBuffers): void {
    const f = fr.f;
    const start = f.tripStart;
    const lo = lowerBound(start, tt - f.maxDuration);
    const hi = upperBound(start, tt);
    const mask = this.modeMask;
    const eb = this.evalBounds;
    const box = eb ? this.patternBoxes(fr) : null;
    for (let i = lo; i < hi; i++) {
      if (f.tripEnd[i] < tt) continue;
      const p = f.tripPattern[i];
      if (!(mask & (1 << f.patMode[p]))) continue;
      if (box && eb && (box[p * 4] > eb[2] || box[p * 4 + 2] < eb[0] || box[p * 4 + 1] > eb[3] || box[p * 4 + 3] < eb[1])) continue;
      if (out.count >= out.capacity) growBuffers(out);
      this.evalTrip(fr, i, tt, out, out.count);
      out.count++;
    }
  }

  /** Evaluate trip i (feed-local) at feed time tt into slot `k`. */
  private evalTrip(fr: FeedRt, i: number, tt: number, out: VehicleBuffers, k: number): void {
    const f = fr.f;
    const p = f.tripPattern[i];
    const tp = f.tripTp[i];
    const o = f.tpOff[tp];
    const n = f.tpOff[tp + 1] - o;
    const so = f.patStopOff[p];
    const rel = tt - f.tripStart[i];
    const arr = f.tpArr;
    // last stop with arrival <= rel
    let a = 0, b = n - 1;
    while (a < b) {
      const m = (a + b + 1) >> 1;
      if (arr[o + m] <= rel) a = m; else b = m - 1;
    }
    const s0 = a;
    const dep0 = f.tpDep[o + s0];
    const mode = f.patMode[p];
    let s: number;
    let speed = 0;
    let state: number;
    let nextK: number;
    let frac = 0;
    if (rel < dep0 || s0 === n - 1) {
      s = f.patStopDist[so + s0];
      state = STATE_DWELL;
      nextK = s0;
    } else {
      const d0 = f.patStopDist[so + s0];
      const d1 = f.patStopDist[so + s0 + 1];
      const T = arr[o + s0 + 1] - dep0;
      const L = d1 - d0;
      const linear = f.patStopFlag[so + s0] !== 0 || f.patStopFlag[so + s0 + 1] !== 0;
      segmentMotion(L, T, rel - dep0, MODE_ACCEL[mode], linear, this.tmp);
      s = d0 + this.tmp[0];
      speed = this.tmp[1];
      state = STATE_MOVING;
      nextK = s0 + 1;
      frac = L > 0 ? this.tmp[0] / L : 1;
    }
    const g = f.patShape[p];
    const v0 = f.shapeOff[g];
    const v1 = f.shapeOff[g + 1];
    const len = f.shapeDist[v1 - 1];
    const hint = this.sample(f, v0, v1, s, v0);
    const x = this.sx, y = this.sy, z = this.sz;
    const h1 = this.sample(f, v0, v1, Math.max(0, s - HALF_LEN), v0);
    const ax = this.sx, ay = this.sy, az = this.sz;
    this.sample(f, v0, v1, Math.min(len, s + HALF_LEN), hint > h1 ? h1 : hint);
    const dx = this.sx - ax, dy = this.sy - ay;
    const hd = Math.sqrt(dx * dx + dy * dy);
    out.x[k] = x;
    out.y[k] = y;
    out.z[k] = z;
    out.heading[k] = Math.atan2(dy, dx);
    out.pitch[k] = hd > 1e-3 ? Math.atan2(this.sz - az, hd) : 0;
    out.speed[k] = speed;
    out.dist[k] = s;
    out.route[k] = fr.routeMap[f.patRoute[p]];
    out.trip[k] = fr.tripBase + i;
    out.pattern[k] = fr.patBase + p;
    out.mode[k] = mode;
    out.state[k] = state;
    out.prevStop[k] = fr.stopBase + f.patStop[so + s0];
    out.nextStop[k] = fr.stopBase + f.patStop[so + nextK];
    out.fraction[k] = frac;
  }

  /** Point at distance s along shape vertices [v0, v1); result in sx/sy/sz. Returns segment start index. */
  private sample(f: TransitFeed, v0: number, v1: number, s: number, from: number): number {
    const D = f.shapeDist;
    const P = f.shapeXYZ;
    let a = from, b = v1 - 1;
    // binary search: last vertex with D <= s
    while (a < b) {
      const m = (a + b + 1) >> 1;
      if (D[m] <= s) a = m; else b = m - 1;
    }
    if (a >= v1 - 1) a = v1 - 2;
    if (a < v0) a = v0;
    const L = D[a + 1] - D[a];
    const t = L > 0 ? Math.min(1, Math.max(0, (s - D[a]) / L)) : 0;
    const i = 3 * a;
    this.sx = P[i] + (P[i + 3] - P[i]) * t;
    this.sy = P[i + 1] + (P[i + 4] - P[i + 1]) * t;
    this.sz = P[i + 2] + (P[i + 5] - P[i + 2]) * t;
    return a;
  }

  // ------------------------------------------------------------ shape access
  /**
   * The shape polyline of a (global) pattern, for sampling positions by
   * distance (`vehicles.dist`). Cached; the arrays are views into the feed.
   */
  patternShape(pattern: number): PatternShape | null {
    let ps = this.shapeCache.get(pattern);
    if (ps) return ps;
    const fr = this.findFeed(pattern, 'patBase');
    if (!fr) return null;
    const f = fr.f;
    const p = pattern - fr.patBase;
    if (p < 0 || p >= f.patStopOff.length - 1) return null;
    const g = f.patShape[p];
    const a = f.shapeOff[g], b = f.shapeOff[g + 1];
    ps = new PatternShape(pattern, f.shapeXYZ.subarray(3 * a, 3 * b), f.shapeDist.subarray(a, b));
    this.shapeCache.set(pattern, ps);
    return ps;
  }

  /** Mode of a (global) pattern (vehicles use the pattern mode, see docs/TRANSIT.md). */
  patternMode(pattern: number): Mode | null {
    const fr = this.findFeed(pattern, 'patBase');
    return fr ? MODES[fr.f.patMode[pattern - fr.patBase]] : null;
  }

  /** Global pattern index of a trip (-1 if unknown). */
  tripPattern(trip: number): number {
    const fr = this.feedOfTrip(trip);
    return fr ? fr.patBase + fr.f.tripPattern[trip - fr.tripBase] : -1;
  }

  // ------------------------------------------------------------------ queries
  private feedOfTrip(trip: number): FeedRt | null {
    return this.findFeed(trip, 'tripBase');
  }

  private findFeed(idx: number, key: 'tripBase' | 'patBase' | 'stopBase'): FeedRt | null {
    const fs = this.feeds;
    for (let i = fs.length - 1; i >= 0; i--) if (idx >= fs[i][key]) return fs[i];
    return null;
  }

  /** State of one trip at time t (or null if not running). Allocates; not for per-frame bulk use. */
  vehicleAt(trip: number, t: number): VehicleState | null {
    const fr = this.feedOfTrip(trip);
    if (!fr) return null;
    const i = trip - fr.tripBase;
    const f = fr.f;
    for (const tt of [t, t + DAY, t - DAY]) {
      if (tt < f.tripStart[i] || tt > f.tripEnd[i]) continue;
      const tmp = allocBuffers(1);
      this.evalTrip(fr, i, tt, tmp, 0);
      return {
        trip, route: tmp.route[0], pattern: tmp.pattern[0], mode: MODES[tmp.mode[0]],
        x: tmp.x[0], y: tmp.y[0], z: tmp.z[0], heading: tmp.heading[0], pitch: tmp.pitch[0],
        speed: tmp.speed[0], dist: tmp.dist[0], state: tmp.state[0],
        prevStop: tmp.prevStop[0], nextStop: tmp.nextStop[0], fraction: tmp.fraction[0],
      };
    }
    return null;
  }

  tripInfo(trip: number): TripInfo | null {
    const fr = this.feedOfTrip(trip);
    if (!fr) return null;
    const f = fr.f;
    const i = trip - fr.tripBase;
    const p = f.tripPattern[i];
    const tp = f.tripTp[i];
    const o = f.tpOff[tp];
    const n = f.tpOff[tp + 1] - o;
    const so = f.patStopOff[p];
    const st = f.tripStart[i];
    const stops: TripStop[] = [];
    for (let k = 0; k < n; k++) {
      const ls = f.patStop[so + k];
      stops.push({
        stop: fr.stopBase + ls, name: f.stopNames[ls],
        arr: st + f.tpArr[o + k], dep: st + f.tpDep[o + k],
        dist: f.patStopDist[so + k], virtual: f.patStopFlag[so + k] !== 0,
      });
    }
    const route = fr.routeMap[f.patRoute[p]];
    return {
      trip, agency: f.agency, route, routeMeta: this.routes[route], mode: MODES[f.patMode[p]],
      headsign: f.headsigns[f.patHeadsign[p]], name: f.tripNames?.[i] ?? '',
      pattern: fr.patBase + p, start: st, end: f.tripEnd[i], stops,
    };
  }

  /** Next `n` departures/arrivals at a stop from time t (includes previous-day trips after midnight). */
  arrivalsAt(stop: number, t: number, n = 10): Arrival[] {
    const fr = this.findFeed(stop, 'stopBase');
    if (!fr) return [];
    this.buildStopIndex(fr);
    const f = fr.f;
    const ls = stop - fr.stopBase;
    const res: Arrival[] = [];
    for (let q = fr.stopPatOff![ls]; q < fr.stopPatOff![ls + 1]; q++) {
      const p = fr.stopPatVal![q];
      const k = fr.stopPatK![q];
      if (f.patStopFlag[f.patStopOff[p] + k]) continue;
      for (let r = fr.patTripOff![p]; r < fr.patTripOff![p + 1]; r++) {
        const i = fr.patTripVal![r];
        const o = f.tpOff[f.tripTp[i]];
        const a = f.tripStart[i] + f.tpArr[o + k];
        const d = f.tripStart[i] + f.tpDep[o + k];
        for (const shift of [0, -DAY]) {
          if (d + shift >= t) {
            res.push({ trip: fr.tripBase + i, route: fr.routeMap[f.patRoute[p]], headsign: f.headsigns[f.patHeadsign[p]], arr: a + shift, dep: d + shift });
          }
        }
      }
    }
    res.sort((x, y) => x.dep - y.dep);
    return res.slice(0, n);
  }

  private buildStopIndex(fr: FeedRt): void {
    if (fr.stopPatOff) return;
    const f = fr.f;
    const nStops = f.stopXYZ.length / 3;
    const nPat = f.patStopOff.length - 1;
    const cnt = new Uint32Array(nStops + 1);
    for (let q = 0; q < f.patStop.length; q++) cnt[f.patStop[q] + 1]++;
    for (let s = 0; s < nStops; s++) cnt[s + 1] += cnt[s];
    const val = new Uint32Array(f.patStop.length);
    const kk = new Uint32Array(f.patStop.length);
    const fill = cnt.slice(0, nStops);
    for (let p = 0; p < nPat; p++) {
      for (let q = f.patStopOff[p]; q < f.patStopOff[p + 1]; q++) {
        const s = f.patStop[q];
        val[fill[s]] = p;
        kk[fill[s]++] = q - f.patStopOff[p];
      }
    }
    fr.stopPatOff = cnt; fr.stopPatVal = val; fr.stopPatK = kk;
    const pc = new Uint32Array(nPat + 1);
    const nT = f.tripStart.length;
    for (let i = 0; i < nT; i++) pc[f.tripPattern[i] + 1]++;
    for (let p = 0; p < nPat; p++) pc[p + 1] += pc[p];
    const pv = new Uint32Array(nT);
    const pf = pc.slice(0, nPat);
    for (let i = 0; i < nT; i++) pv[pf[f.tripPattern[i]]++] = i;
    fr.patTripOff = pc; fr.patTripVal = pv;
  }

  /** Stop position (world E, N, z) into `out`. */
  stopPosition(stop: number, out: Float64Array | number[] = new Float64Array(3)): Float64Array | number[] {
    const fr = this.findFeed(stop, 'stopBase')!;
    const l = stop - fr.stopBase;
    out[0] = fr.f.stopXYZ[3 * l];
    out[1] = fr.f.stopXYZ[3 * l + 1];
    out[2] = fr.f.stopXYZ[3 * l + 2];
    return out;
  }

  stopName(stop: number): string {
    const fr = this.findFeed(stop, 'stopBase');
    return fr ? fr.f.stopNames[stop - fr.stopBase] : '';
  }

  stopId(stop: number): string {
    const fr = this.findFeed(stop, 'stopBase');
    return fr ? `${fr.f.agency}:${fr.f.stopIds[stop - fr.stopBase]}` : '';
  }

  /**
   * All loaded stops as SoA (virtual bbox-edge points excluded), optionally
   * filtered by the modes serving them. `mode` is the "highest" mode serving the
   * stop (lowest MODE_ID). Coordinates relative to `origin`.
   */
  stops(opts: { modes?: Mode[]; origin?: [number, number] } = {}): {
    index: Int32Array; x: Float64Array; y: Float64Array; z: Float32Array; mode: Uint8Array;
  } {
    const mm = opts.modes ? opts.modes.reduce((a, m) => a | (1 << MODE_ID[m]), 0) : 0x7f;
    const [ox, oy] = opts.origin ?? [0, 0];
    const best = new Uint8Array(this.stopCount).fill(255);
    for (const fr of this.feeds) {
      const f = fr.f;
      const nPat = f.patStopOff.length - 1;
      for (let p = 0; p < nPat; p++) {
        const m = f.patMode[p];
        for (let q = f.patStopOff[p]; q < f.patStopOff[p + 1]; q++) {
          if (f.patStopFlag[q]) continue;
          const s = fr.stopBase + f.patStop[q];
          if (m < best[s]) best[s] = m;
        }
      }
    }
    const idx: number[] = [];
    for (let s = 0; s < this.stopCount; s++) if (best[s] !== 255 && mm & (1 << best[s])) idx.push(s);
    const n = idx.length;
    const r = { index: Int32Array.from(idx), x: new Float64Array(n), y: new Float64Array(n), z: new Float32Array(n), mode: new Uint8Array(n) };
    const tmp = new Float64Array(3);
    idx.forEach((s, i) => {
      this.stopPosition(s, tmp);
      r.x[i] = tmp[0] - ox; r.y[i] = tmp[1] - oy; r.z[i] = tmp[2]; r.mode[i] = best[s];
    });
    return r;
  }

  /** Unique shapes used by each route (loaded feeds), for overlay lines. */
  routeLines(opts: { modes?: Mode[]; origin?: [number, number] } = {}): RouteLine[] {
    const [ox, oy] = opts.origin ?? [0, 0];
    const mm = opts.modes ? opts.modes.reduce((a, m) => a | (1 << MODE_ID[m]), 0) : 0x7f;
    const byRoute = new Map<number, RouteLine>();
    for (const fr of this.feeds) {
      const f = fr.f;
      const seen = new Set<number>();
      const nPat = f.patStopOff.length - 1;
      for (let p = 0; p < nPat; p++) {
        if (!(mm & (1 << f.patMode[p]))) continue;
        const g = f.patShape[p];
        const route = fr.routeMap[f.patRoute[p]];
        const key = g * 4096 + f.patRoute[p];
        if (seen.has(key)) continue;
        seen.add(key);
        let rl = byRoute.get(route);
        if (!rl) byRoute.set(route, (rl = { route, meta: this.routes[route], lines: [] }));
        const a = f.shapeOff[g], b = f.shapeOff[g + 1];
        const xyz = f.shapeXYZ.slice(3 * a, 3 * b);
        for (let v = 0; v < b - a; v++) {
          xyz[3 * v] = f.shapeXYZ[3 * (a + v)] - ox;
          xyz[3 * v + 1] = f.shapeXYZ[3 * (a + v) + 1] - oy;
        }
        rl.lines.push(xyz);
      }
    }
    return [...byRoute.values()];
  }

  /** All route polylines of one mode concatenated (for a single line-segments draw). */
  linesByMode(mode: Mode, origin: [number, number] = [0, 0]): ModeLines {
    const rls = this.routeLines({ modes: [mode], origin });
    const lines: Float32Array[] = [];
    const routes: number[] = [];
    for (const rl of rls) for (const l of rl.lines) { lines.push(l); routes.push(rl.route); }
    const offsets = new Uint32Array(lines.length + 1);
    lines.forEach((l, i) => (offsets[i + 1] = offsets[i] + l.length / 3));
    const xyz = new Float32Array(offsets[lines.length] * 3);
    lines.forEach((l, i) => xyz.set(l, offsets[i] * 3));
    return { mode, offsets, xyz, route: Int32Array.from(routes) };
  }

  /** Loaded feeds summary (agency, kind, trips). */
  feedsInfo(): { agency: string; kind: string; profile: string; date: string; trips: number }[] {
    return this.feeds.map((fr) => ({ agency: fr.f.agency, kind: fr.f.kind, profile: fr.f.profile, date: fr.f.date, trips: fr.f.tripStart.length }));
  }
}

// ---------------------------------------------------------------------- utils
function lowerBound(a: Int32Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1; else hi = m;
  }
  return lo;
}

function upperBound(a: Int32Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= v) lo = m + 1; else hi = m;
  }
  return lo;
}

function allocBuffers(n: number): VehicleBuffers {
  return {
    count: 0, capacity: n,
    x: new Float64Array(n), y: new Float64Array(n), z: new Float32Array(n),
    heading: new Float32Array(n), pitch: new Float32Array(n), speed: new Float32Array(n), dist: new Float32Array(n),
    route: new Int32Array(n), trip: new Int32Array(n), pattern: new Int32Array(n),
    mode: new Uint8Array(n), state: new Uint8Array(n),
    prevStop: new Int32Array(n), nextStop: new Int32Array(n), fraction: new Float32Array(n),
  };
}

function growBuffers(b: VehicleBuffers): void {
  const n = b.capacity * 2;
  const nb = allocBuffers(n);
  for (const k of Object.keys(nb) as (keyof VehicleBuffers)[]) {
    const src = b[k];
    if (typeof src === 'number') continue;
    (nb[k] as typeof src).set(src as never);
    (b as unknown as Record<string, unknown>)[k] = nb[k];
  }
  b.capacity = n;
}
