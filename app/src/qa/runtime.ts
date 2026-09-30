// Runtime QA hooks (window.__qa): read-only counters sampled from the live
// layers, plus camera helpers for the visual QA tour / viewpoint sweep
// (app/qa/). Nothing here changes layer state except the camera.
//
//   __qa.sample({ radius })   counters around the camera focus (default 600 m)
//   __qa.watch(seconds)       sample every 0.5 s, max / avg per counter
//   __qa.reset()              forget long frames seen so far
//   __qa.issues(url?)         load + cache data/qa/issues.json
//   __qa.goto(idOrIndex)      fly to an issue (its `view`), returns it
//   __qa.gotoPose(pose)       jump to {e, n, h?, dist, heading°, pitch°}
//   __qa.ready(timeoutMs)     resolves when no tiles are pending
//
// Counters (each {count, examples[≤20]}):
//   carOverlap          sim car bodies (OBBs) intersecting each other
//   carBelowGround      car elevation < rendered terrain − 0.3 m (not bridge/tunnel)
//   transitOverlap      surface transit vehicles intersecting each other or cars
//   transitBelowGround  rendered transit cars 0.3–3 m under the terrain (deeper = tunnel)
//   vehicleOffRoad      car / bus centre outside every carriageway ribbon (L0 roads,
//                       classes 0–7, no tunnels); streetcar / LRT centre > 2.5 m from a track
//   vehicleWrongWay     car / surface transit heading > 90° off a one-way ribbon under it
//   vehicleLeftSide     centre on the left half of a two-way ribbon (≥ 2 lanes, ≥ 7 m wide)
//                       relative to its heading (right-hand traffic); junction boxes
//                       (overlapping ribbons of different roads) are skipped
//   vehicleDoubleRender far marker drawn within 12 m of a rendered consist car
//                       (a vehicle shown by two representations in one frame)
//   longFrames          frames > 40 ms since the last sample / reset (count, maxMs)
//   extra.houseRoofSpike   house roofs rising > min(5 m, 0.6 × span) above the eaves (drawn L0 tiles;
//   extra.houseTooTall     house ridges > 14 m;   registered by layers/UrbanLayer.ts from
//   extra.houseInBuilding  house boxes inside an extruded footprint;   workers/houseFront.ts houseRoofQa)
import type { Engine } from '../engine/Engine';
import { fetchTbn } from '../data/tbn';
import { CAR_LENGTH } from '../layers/traffic/models';

const HALF_W = [0.92, 0.9, 0.98, 1.01, 1.0, 1.25];
const ROAD_W_DEFAULT = [24, 18, 14, 12, 10, 8, 5, 5, 2.2, 3];
const TILE = 1024;
const CELL = 32;
const MAX_EX = 20;
const TRACK_TOL = 2.5;
const ROAD_TOL = 0.3;
const DOUBLE_R = 12;

interface Example { e: number; n: number; [k: string]: unknown }
interface Counter { count: number; examples: Example[] }
export interface QaSample {
  at: number; focus: { e: number; n: number }; radius: number;
  cars: number; transit: number;
  carOverlap: Counter; carBelowGround: Counter; transitOverlap: Counter; transitBelowGround: Counter;
  vehicleOffRoad: Counter; vehicleWrongWay: Counter; vehicleLeftSide: Counter; vehicleDoubleRender: Counter; longFrames: Counter & { maxMs: number };
  tilesReady: boolean;
  extra?: Record<string, Counter>;
}
export interface Pose { e: number; n: number; h?: number; z?: number; dist?: number; heading?: number; pitch?: number }
interface Issue { id: string; cat: string; rank: number; e: number; n: number; z?: number; view?: { dist?: number; heading?: number; pitch?: number } }

// ---------------------------------------------------------------- duck types
interface Snap { count: number; oe: number; on: number; f: Float32Array; u: Uint32Array }
interface TrafficLike { snapshot(): Snap | null }
interface GroundVeh { e: number; n: number; heading: number; length: number; width: number; speed: number; trip: number }
interface PoolLike { count: number; geom: { boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null; computeBoundingBox(): void }; mesh: { instanceMatrix: { array: ArrayLike<number> } } }
interface TransitLike {
  system: { tripInfo(trip: number): { mode: string } | null };
  groundVehicles(out: GroundVeh[]): number;
  markers?: Map<string, { count: number; world?: Float64Array }>;
  pools?: { group: { position: { x: number; z: number } }; pools?: Map<string, PoolLike> };
}

// ---------------------------------------------------------------- geometry
interface Box { e: number; n: number; h: number; hl: number; hw: number; id: number | string }
function obbOverlap(a: Box, b: Box): boolean {
  const dx = b.e - a.e, dy = b.n - a.n;
  if (dx * dx + dy * dy > (a.hl + a.hw + b.hl + b.hw) ** 2) return false;
  const axes = [a.h, a.h + Math.PI / 2, b.h, b.h + Math.PI / 2];
  for (const t of axes) {
    const ux = Math.cos(t), uy = Math.sin(t);
    const pa = a.hl * Math.abs(Math.cos(a.h) * ux + Math.sin(a.h) * uy) + a.hw * Math.abs(-Math.sin(a.h) * ux + Math.cos(a.h) * uy);
    const pb = b.hl * Math.abs(Math.cos(b.h) * ux + Math.sin(b.h) * uy) + b.hw * Math.abs(-Math.sin(b.h) * ux + Math.cos(b.h) * uy);
    if (Math.abs(dx * ux + dy * uy) > pa + pb) return false;
  }
  return true;
}
function overlapPairs(boxes: Box[], keep: (a: Box, b: Box) => boolean): [Box, Box][] {
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 50000) * 100003 + (j + 50000);
  boxes.forEach((b, k) => {
    const c = key(Math.floor(b.e / 20), Math.floor(b.n / 20));
    const l = grid.get(c); if (l) l.push(k); else grid.set(c, [k]);
  });
  const out: [Box, Box][] = [];
  boxes.forEach((a, k) => {
    const ci = Math.floor(a.e / 20), cj = Math.floor(a.n / 20);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const l = grid.get(key(ci + di, cj + dj));
      if (l) for (const m of l) if (m > k && keep(a, boxes[m]) && obbOverlap(a, boxes[m])) out.push([a, boxes[m]]);
    }
  });
  return out;
}
function segDist(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
  return Math.hypot(x - x0 - dx * t, y - y0 - dy * t);
}

// ---------------------------------------------------------------- road / track grid (own L0 tile reads)
/** segments (stride SEG): x0 y0 x1 y1 hw oneway lanes roadId (world; geometry runs in the travel direction of one-ways); per 32 m cell lists */
const SEG = 8;
interface SegGrid { road: Map<number, number[]>; track: Map<number, number[]>; seg: number[] }
const ckey = (i: number, j: number) => (i + 100000) * 200003 + (j + 100000);

class Ground {
  private tiles = new Map<string, Promise<void>>();
  readonly g: SegGrid = { road: new Map(), track: new Map(), seg: [] };
  private root: string;
  constructor(root: string) { this.root = root; }
  ensure(e: number, n: number): Promise<void> {
    const tx0 = Math.floor(e / TILE), ty0 = Math.floor(n / TILE);
    const ps: Promise<void>[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${tx0 + dx}_${ty0 + dy}`;
      let p = this.tiles.get(k);
      if (!p) { p = this.load(tx0 + dx, ty0 + dy).catch(() => undefined); this.tiles.set(k, p); }
      ps.push(p);
    }
    return Promise.all(ps).then(() => undefined);
  }
  private roads = 0;
  private add(map: Map<number, number[]>, x0: number, y0: number, x1: number, y1: number, hw: number, oneway = 0, lanes = 0, road = -1) {
    const s = this.g.seg, idx = s.length / SEG;
    s.push(x0, y0, x1, y1, hw, oneway, lanes, road);
    const m = hw + TRACK_TOL;
    for (let j = Math.floor((Math.min(y0, y1) - m) / CELL); j <= Math.floor((Math.max(y0, y1) + m) / CELL); j++)
      for (let i = Math.floor((Math.min(x0, x1) - m) / CELL); i <= Math.floor((Math.max(x0, x1) + m) / CELL); i++) {
        const k = ckey(i, j); const l = map.get(k); if (l) l.push(idx); else map.set(k, [idx]);
      }
  }
  private async load(tx: number, ty: number) {
    const t = await fetchTbn(`${this.root}/tiles/0/${tx}_${ty}.bin.gz`);
    if (!t) return;
    const a = t.arrays, ox = tx * TILE, oy = ty * TILE;
    const off = a.r_off as Uint32Array | undefined, xyz = a.r_xyz as Float32Array | undefined;
    if (off && xyz) {
      const cls = a.r_class as Uint8Array, wid = a.r_width as Float32Array | undefined, fl = a.r_flags as Uint8Array | undefined, lanes = a.r_lanes as Uint8Array | undefined;
      for (let r = 0; r < off.length - 1; r++) {
        const c = cls[r] ?? 5;
        if (c > 7 || (fl && fl[r] & 4)) continue;
        let w = wid && wid[r] > 0 ? wid[r] : ROAD_W_DEFAULT[c] ?? 6;
        w = Math.max(w, c <= 1 ? 10 : 2);
        const ow = fl && fl[r] & 1 ? 1 : 0, ln = lanes ? lanes[r] : 0, rid = this.roads++;
        for (let k = off[r]; k < off[r + 1] - 1; k++)
          this.add(this.g.road, xyz[k * 3] + ox, xyz[k * 3 + 1] + oy, xyz[k * 3 + 3] + ox, xyz[k * 3 + 4] + oy, w / 2, ow, ln, rid);
      }
    }
    const lo = a.l_off as Uint32Array | undefined, lx = a.l_xyz as Float32Array | undefined;
    if (lo && lx) {
      for (let r = 0; r < lo.length - 1; r++)
        for (let k = lo[r]; k < lo[r + 1] - 1; k++)
          this.add(this.g.track, lx[k * 3] + ox, lx[k * 3 + 1] + oy, lx[k * 3 + 3] + ox, lx[k * 3 + 4] + oy, 0);
    }
  }
  /** distance outside the nearest ribbon edge (≤ 0 = inside); Infinity if none nearby */
  offRoad(e: number, n: number): number {
    const l = this.g.road.get(ckey(Math.floor(e / CELL), Math.floor(n / CELL)));
    if (!l) return Infinity;
    const s = this.g.seg;
    let best = Infinity;
    for (const i of l) best = Math.min(best, segDist(e, n, s[i * SEG], s[i * SEG + 1], s[i * SEG + 2], s[i * SEG + 3]) - s[i * SEG + 4]);
    return best;
  }
  /**
   * The ribbon under (e, n): the containing segment nearest its centreline, or null
   * when none contains the point or when ribbons of different roads with
   * directions > 30° apart overlap there (junction box: direction is ambiguous).
   * side: signed offset from the centreline (+ = left of the geometry direction).
   */
  roadAt(e: number, n: number): { dx: number; dy: number; hw: number; oneway: boolean; lanes: number; side: number } | null {
    const l = this.g.road.get(ckey(Math.floor(e / CELL), Math.floor(n / CELL)));
    if (!l) return null;
    const s = this.g.seg;
    let best = -1, bd = Infinity;
    const hits: number[] = [];
    for (const i of l) {
      const o = i * SEG;
      const d = segDist(e, n, s[o], s[o + 1], s[o + 2], s[o + 3]);
      if (d > s[o + 4]) continue;
      hits.push(i);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    const o = best * SEG;
    const L = Math.hypot(s[o + 2] - s[o], s[o + 3] - s[o + 1]) || 1;
    const dx = (s[o + 2] - s[o]) / L, dy = (s[o + 3] - s[o + 1]) / L;
    for (const i of hits) {
      const q = i * SEG;
      if (s[q + 7] === s[o + 7]) continue;
      const Lq = Math.hypot(s[q + 2] - s[q], s[q + 3] - s[q + 1]) || 1;
      if (Math.abs(((s[q + 2] - s[q]) * dx + (s[q + 3] - s[q + 1]) * dy) / Lq) < Math.cos(Math.PI / 6)) return null;
    }
    const side = -(e - s[o]) * dy + (n - s[o + 1]) * dx;
    return { dx, dy, hw: s[o + 4], oneway: s[o + 5] === 1, lanes: s[o + 6], side };
  }
  trackDist(e: number, n: number): number {
    const l = this.g.track.get(ckey(Math.floor(e / CELL), Math.floor(n / CELL)));
    if (!l) return Infinity;
    const s = this.g.seg;
    let best = Infinity;
    for (const i of l) best = Math.min(best, segDist(e, n, s[i * SEG], s[i * SEG + 1], s[i * SEG + 2], s[i * SEG + 3]));
    return best;
  }
}

// ---------------------------------------------------------------- the API
export function installQa(engine: Engine) {
  const w = window as unknown as Record<string, unknown>;
  const ground = new Ground(engine.dataRoot);
  let lastLongAt = -Infinity;
  let issueCache: { url: string; issues: Issue[] } | null = null;
  const gv: GroundVeh[] = [];
  const mk = (): Counter => ({ count: 0, examples: [] });
  const push = (c: Counter, ex: Example) => { c.count++; if (c.examples.length < MAX_EX) c.examples.push(ex); };
  const r1 = (v: number) => Math.round(v * 10) / 10;

  function focus() { const c = engine.controls.cur; return { e: c.e, n: c.n }; }

  function sample(opts: { radius?: number } = {}): QaSample {
    const R = opts.radius ?? 600;
    const f = focus();
    void ground.ensure(f.e, f.n);
    const near = (e: number, n: number) => Math.abs(e - f.e) < R && Math.abs(n - f.n) < R;
    const out: QaSample = {
      at: performance.now(), focus: { e: r1(f.e), n: r1(f.n) }, radius: R, cars: 0, transit: 0,
      carOverlap: mk(), carBelowGround: mk(), transitOverlap: mk(), transitBelowGround: mk(),
      vehicleOffRoad: mk(), vehicleWrongWay: mk(), vehicleLeftSide: mk(), vehicleDoubleRender: mk(), longFrames: { ...mk(), maxMs: 0 }, tilesReady: pending() === 0,
    };
    const haveGround = ground.g.seg.length > 0;
    // heading vs the ribbon under the vehicle: against a one-way, or on the left
    // half of a two-way road with a centre line (≥ 2 lanes, ribbon ≥ 7 m)
    const dirCheck = (e: number, n: number, h: number, ids: unknown[], kind: string) => {
      const r = ground.roadAt(e, n);
      if (!r) return;
      const c = Math.cos(h) * r.dx + Math.sin(h) * r.dy;
      if (r.oneway) { if (c < 0) push(out.vehicleWrongWay, { e: r1(e), n: r1(n), ids, kind }); return; }
      if (r.lanes >= 2 && r.hw * 2 >= 7 && Math.abs(c) > 0.5 && r.side * Math.sign(c) > 0.3)
        push(out.vehicleLeftSide, { e: r1(e), n: r1(n), ids, kind, offset: r1(Math.abs(r.side)) });
    };
    // ---- sim cars
    const cars: Box[] = [];
    const snap = (w.__traffic as TrafficLike | undefined)?.snapshot?.();
    if (snap) {
      const { f: fa, u, count, oe, on } = snap;
      for (let i = 0; i < count; i++) {
        const o = i * 8;
        const e = fa[o] + oe, n = fa[o + 1] + on;
        if (!near(e, n)) continue;
        const kind = u[o + 6] & 0xff, id = u[o + 7];
        const structure = ((u[o + 6] >>> 24) & 8) !== 0;
        const b: Box = { e, n, h: fa[o + 3], hl: (CAR_LENGTH[kind] ?? 4.7) / 2, hw: HALF_W[kind] ?? 0.95, id };
        cars.push(b);
        const g = engine.heightAt(e, n);
        const elev = structure || !Number.isFinite(g) ? fa[o + 2] : g + 0.06;
        if (!structure && Number.isFinite(g) && elev < g - 0.3) push(out.carBelowGround, { e: r1(e), n: r1(n), ids: [id], depth: r1(g - elev) });
        if (haveGround && !structure) {
          const d = ground.offRoad(e, n);
          if (d > ROAD_TOL) push(out.vehicleOffRoad, { e: r1(e), n: r1(n), ids: [id], kind: 'car', off: Number.isFinite(d) ? r1(d) : null });
          else dirCheck(e, n, fa[o + 3], [id], 'car');
        }
      }
      out.cars = cars.length;
      for (const [a, b] of overlapPairs(cars, () => true)) push(out.carOverlap, { e: r1((a.e + b.e) / 2), n: r1((a.n + b.n) / 2), ids: [a.id, b.id] });
    }
    // ---- surface transit
    const tr = w.__transit as TransitLike | undefined;
    if (tr?.groundVehicles) {
      let n = 0;
      try { n = tr.groundVehicles(gv); } catch { n = 0; }
      const boxes: Box[] = [];
      for (let k = 0; k < n; k++) {
        const g = gv[k];
        const e = g.e - Math.cos(g.heading) * g.length / 2, nn = g.n - Math.sin(g.heading) * g.length / 2;
        if (!near(e, nn)) continue;
        boxes.push({ e, n: nn, h: g.heading, hl: g.length / 2, hw: g.width / 2, id: `trip:${g.trip}` });
        if (haveGround) {
          const mode = g.trip >= 0 ? tr.system.tripInfo(g.trip)?.mode : undefined;
          const rail = mode === 'streetcar' || mode === 'lrt';
          const d = rail ? ground.trackDist(g.e, g.n) - TRACK_TOL : ground.offRoad(e, nn);
          if (d > ROAD_TOL) push(out.vehicleOffRoad, { e: r1(e), n: r1(nn), ids: [`trip:${g.trip}`], kind: mode ?? 'transit', off: Number.isFinite(d) ? r1(d) : null });
          else dirCheck(e, nn, g.heading, [`trip:${g.trip}`], mode ?? 'transit');
        }
      }
      out.transit = boxes.length;
      const all = boxes.concat(cars);
      const isT = (b: Box) => typeof b.id === 'string';
      for (const [a, b] of overlapPairs(all, (a, b) => isT(a) || isT(b))) push(out.transitOverlap, { e: r1((a.e + b.e) / 2), n: r1((a.n + b.n) / 2), ids: [a.id, b.id] });
    }
    // ---- rendered transit cars (pool instances): below ground + double representation
    const pools = tr?.pools?.pools;
    const inst: { e: number; n: number }[] = [];
    if (pools && tr?.pools) {
      const ax = tr.pools.group.position.x, az = tr.pools.group.position.z;
      for (const p of pools.values()) {
        if (!p.count) continue;
        if (!p.geom.boundingBox) p.geom.computeBoundingBox();
        const m = p.mesh.instanceMatrix.array;
        for (let k = 0; k < p.count; k++) {
          const b = k * 16;
          const e = m[b + 12] + ax, y = m[b + 13], n = -(m[b + 14] + az);
          if (!near(e, n)) continue;
          inst.push({ e, n });
          const g = engine.heightAt(e, n);
          const depth = g - y;
          if (Number.isFinite(g) && depth > 0.3 && depth < 3) push(out.transitBelowGround, { e: r1(e), n: r1(n), depth: r1(depth) });
        }
      }
    }
    if (tr?.markers && inst.length) {
      const grid = new Map<number, { e: number; n: number }[]>();
      for (const p of inst) { const k = ckey(Math.floor(p.e / DOUBLE_R), Math.floor(p.n / DOUBLE_R)); const l = grid.get(k); if (l) l.push(p); else grid.set(k, [p]); }
      for (const [mode, mo] of tr.markers) {
        const wd = mo.world;
        if (!wd) continue;
        for (let i = 0; i < mo.count; i++) {
          const e = wd[i * 3], n = wd[i * 3 + 1];
          if (!near(e, n)) continue;
          const ci = Math.floor(e / DOUBLE_R), cj = Math.floor(n / DOUBLE_R);
          let hit = false;
          for (let dj = -1; dj <= 1 && !hit; dj++) for (let di = -1; di <= 1 && !hit; di++)
            for (const p of grid.get(ckey(ci + di, cj + dj)) ?? []) if (Math.hypot(p.e - e, p.n - n) < DOUBLE_R) { hit = true; break; }
          if (hit) push(out.vehicleDoubleRender, { e: r1(e), n: r1(n), mode });
        }
      }
    }
    // ---- long frames
    for (const L of engine.perf.long) {
      if (L.at <= lastLongAt) continue;
      out.longFrames.count++;
      out.longFrames.maxMs = Math.max(out.longFrames.maxMs, Math.round(L.ms));
      if (out.longFrames.examples.length < MAX_EX) out.longFrames.examples.push({ e: r1(f.e), n: r1(f.n), ms: Math.round(L.ms), parts: L.parts });
    }
    if (engine.perf.long.length) lastLongAt = Math.max(lastLongAt, engine.perf.long[engine.perf.long.length - 1].at);
    // counters other modules registered on window.__qa (e.g. the transit agent):
    //   __qa.vehicleDoubleRender() → number | Counter overrides the inferred one;
    //   __qa.extra = { name: () => number | Counter } are added under out.extra
    const qa = w.__qa as Record<string, unknown> | undefined;
    const asCounter = (v: unknown): Counter | null =>
      typeof v === 'number' ? { count: v, examples: [] } : v && typeof v === 'object' && 'count' in v ? (v as Counter) : null;
    if (qa && typeof qa.vehicleDoubleRender === 'function') {
      try { const c = asCounter((qa.vehicleDoubleRender as () => unknown)()); if (c) out.vehicleDoubleRender = c; } catch { /* keep inferred */ }
    }
    if (qa && qa.extra && typeof qa.extra === 'object') {
      const ex: Record<string, Counter> = {};
      for (const [k, fn] of Object.entries(qa.extra as Record<string, unknown>)) {
        if (typeof fn !== 'function') continue;
        try { const c = asCounter(fn()); if (c) ex[k] = c; } catch { /* ignore */ }
      }
      out.extra = ex;
    }
    return out;
  }

  const COUNTERS = ['carOverlap', 'carBelowGround', 'transitOverlap', 'transitBelowGround', 'vehicleOffRoad', 'vehicleWrongWay', 'vehicleLeftSide', 'vehicleDoubleRender', 'longFrames'] as const;
  async function watch(seconds = 5, opts: { radius?: number } = {}) {
    const acc: Record<string, { max: number; sum: number }> = {};
    let n = 0, last: QaSample | null = null;
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      last = sample(opts); n++;
      for (const k of COUNTERS) { const a = (acc[k] ??= { max: 0, sum: 0 }); a.max = Math.max(a.max, last[k].count); a.sum += last[k].count; }
      await new Promise((r) => setTimeout(r, 500));
    }
    const res: Record<string, { max: number; avg: number }> = {};
    for (const k of COUNTERS) res[k] = { max: acc[k]?.max ?? 0, avg: n ? r1((acc[k]?.sum ?? 0) / n) : 0 };
    return { samples: n, counters: res, last };
  }

  function reset() {
    const L = engine.perf.long;
    lastLongAt = L.length ? L[L.length - 1].at : lastLongAt;
  }

  async function issues(url = `${engine.dataRoot}/qa/issues.json`): Promise<Issue[]> {
    if (issueCache?.url === url) return issueCache.issues;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const j = await res.json();
    issueCache = { url, issues: j.issues ?? [] };
    return issueCache.issues;
  }

  function gotoPose(p: Pose) {
    (w.__interact as { leave?: (b: boolean) => void } | undefined)?.leave?.(true);
    const h = p.h ?? p.z ?? engine.heightAt(p.e, p.n);
    const deg = Math.PI / 180;
    engine.controls.jumpTo({ e: p.e, n: p.n, h, dist: p.dist ?? 60, heading: (p.heading ?? 0) * deg, pitch: (p.pitch ?? 35) * deg });
    void ground.ensure(p.e, p.n);
    return p;
  }

  async function goto(which: string | number, url?: string) {
    const list = await issues(url);
    const it = typeof which === 'number' ? list[which] : list.find((x) => x.id === which);
    if (!it) throw new Error(`no issue ${which}`);
    gotoPose({ e: it.e, n: it.n, h: it.z, dist: it.view?.dist ?? 60, heading: it.view?.heading ?? 20, pitch: it.view?.pitch ?? 35 });
    return it;
  }

  function pending(): number {
    const app = w.__app as { getState(): { stats: { tilesPending: number } } } | undefined;
    return app?.getState().stats.tilesPending ?? 0;
  }

  /** resolves when no tiles are pending for 3 consecutive polls (or timeout) */
  async function ready(timeoutMs = 20000) {
    const t0 = performance.now();
    let ok = 0;
    await new Promise((r) => setTimeout(r, 300));
    while (performance.now() - t0 < timeoutMs) {
      ok = pending() === 0 ? ok + 1 : 0;
      if (ok >= 3) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const f = focus();
    await ground.ensure(f.e, f.n);
    return { pending: pending(), waitedMs: Math.round(performance.now() - t0) };
  }

  // extend (don't replace) an existing __qa so other modules' fields survive
  const api = { sample, watch, reset, issues, goto, gotoPose, ready, focus };
  w.__qa = Object.assign((w.__qa as object | undefined) ?? {}, api);
}
