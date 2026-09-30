// Waterfront life: Toronto Island ferries on the City timetable, the Billy
// Bishop airport ferry across the Western Gap, water taxis, Harbourfront tour
// boats, pleasure boats sailing the harbour / off the lakeshore (density by
// season × hour × weekday × weather), boats moored in every Lake Ontario
// marina (hauled out in winter), lakers on the Welland – Hamilton – Toronto
// lanes and at their berths, the fireboat and Coast Guard cutters.
//
// Data: data/water/ferries.json (pipeline/tpipe/ferries.py). Everything is
// evaluated analytically from sim time each frame; boats are instanced per
// model (layers/water/pools.ts). Clicking a boat selects it through the app
// store ({ kind: 'boat', label }), shown by the generic selection panel.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { torontoParts } from '../state/clock';
import { useApp } from '../state/store';
import { boatModel, type BoatKey } from '../models/boats';
import { BoatPools, F_NAV, F_WIN } from './water/pools';
import { R_OCC } from '../engine/horizon';
import { Path, hash01, trapezoid } from './water/path';
import {
  AIRPORT, ROUTE_NAME, VESSELS, afloatFraction, boatingFactor, planDay, seawayOpen, weatherOf,
  type DayPlan, type RouteId, type Weather,
} from './water/schedule';

// ------------------------------------------------------------------ data types
interface FerriesJson {
  level: number;
  routes: { id: string; name: string; pts: [number, number][] }[];
  terminals: { name: string; p: [number, number] }[];
  marinas: { name: string | null; c: [number, number]; kind: string; boats: [number, number, number, number][] }[];
  zones: { id: string; name: string; peak: number; loops: [number, number][][] }[];
  tours: { id: string; name: string; loop: [number, number][] }[];
  lanes: { id: string; pts: [number, number][] }[];
  berths: { id: string; kind: string; name: string; len: number; p: [number, number]; h: number }[];
}

interface Drawn { e: number; n: number; yaw: number; len: number; label: string }

const PICK_PX = 12;
/** water taxi stand (Harbourfront, foot of York St.) and the point off its slip */
const TAXI_STAND: [number, number] = [258, -1512];
const TAXI_OUT: [number, number] = [258, -1770];
const LAKER_TINTS = [0x7b1e1e, 0x1b1d22, 0x2b3f63, 0x3c4046, 0x5a1a1a];
const HULL_STRIPES = [0x1e3a6e, 0x1c1d20, 0x9a1d1d, 0x1f5a3a, 0x2f6fb0, 0x5b1830, 0xc8c8c8];
const RUNABOUT_COLS = [0xd23a2a, 0x1f4f9a, 0xf2f2f2, 0x222222, 0x2a8a6a, 0xe0b020];

const _p = { e: 0, n: 0, h: 0 };
const _c = new THREE.Color();

export class WaterLifeLayer implements Layer {
  readonly id = 'water-life';
  readonly pools = new BoatPools();
  private engine!: Engine;
  private data: FerriesJson | null = null;
  private level = -0.3;
  private routes = new Map<string, Path>();
  private taxiPaths: { dest: string; path: Path }[] = [];
  private loops = new Map<string, Path[]>();
  private tours: Path[] = [];
  private lanes: { id: string; path: Path }[] = [];
  private dayKey = -1;
  private plan: DayPlan | null = null;
  private weather: Weather = { good: 1, windDir: 4, wind: 5, label: 'fair' };
  private marinaLabels: string[][] = [];
  /** boats drawn last frame (for picking) */
  drawn: Drawn[] = [];
  private nDrawn = 0;
  private ctx: FrameContext | null = null;
  private down: { x: number; y: number; t: number; btn: number } | null = null;
  private vp = new THREE.Matrix4();
  /** counters for QA / debug */
  stats = { ferries: 0, moving: 0, moored: 0, lakers: 0 };
  /** shown/hidden state of gated boats (spawn / retire only out of view) */
  private shown = new Map<number, boolean>();
  private lastSimMs = NaN;

  private dataRoot: string;
  constructor(dataRoot: string) { this.dataRoot = dataRoot; }

  async init(engine: Engine) {
    this.engine = engine;
    engine.scene.add(this.pools.root);
    const dom = engine.renderer.domElement;
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    try {
      const r = await fetch(`${this.dataRoot}/water/ferries.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.load(await r.json() as FerriesJson);
    } catch (e) {
      console.warn('water life data unavailable', e);
    }
  }

  private load(d: FerriesJson) {
    this.data = d;
    this.level = d.level ?? -0.3;
    for (const r of d.routes) this.routes.set(r.id, new Path(r.pts));
    // water taxis: stand → off the slip → join the second half of each island ferry route
    for (const id of ['centre', 'hanlans', 'wards'] as const) {
      const r = d.routes.find((x) => x.id === id);
      if (!r) continue;
      const path = new Path(r.pts);
      const tail = r.pts.filter((_, i) => path.cum[i] > path.length * 0.45);
      this.taxiPaths.push({ dest: ROUTE_NAME[id], path: new Path([TAXI_STAND, TAXI_OUT, ...tail]) });
    }
    for (const z of d.zones) this.loops.set(z.id, z.loops.filter((l) => l.length > 3).map((l) => new Path(l, true)));
    this.tours = d.tours.map((t) => new Path(t.loop, true));
    this.lanes = d.lanes.map((l) => ({ id: l.id, path: new Path(l.pts) }));
    this.marinaLabels = d.marinas.map((m) => {
      const where = m.name ?? 'marina';
      return [`Moored sailboat · ${where}`, `Moored motor cruiser · ${where}`];
    });
  }

  // ------------------------------------------------------------------ per frame
  update(ctx: FrameContext) {
    this.ctx = ctx;
    const d = this.data;
    this.pools.begin();
    this.nDrawn = 0;
    this.stats = { ferries: 0, moving: 0, moored: 0, lakers: 0 };
    if (!d) { this.pools.commit(false); return; }
    const p = torontoParts(ctx.simMs);
    const key = p.year * 10000 + p.month * 100 + p.day;
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.plan = planDay(p.month, p.day, p.weekday);
      this.weather = weatherOf(p.year, p.month, p.day, hash01);
    }
    const a = ctx.anchor.origin;
    this.pools.root.position.copy(a);
    const sec = p.secOfDay;
    // a time jump (scrubbing, URL time): let every gated boat snap to its new state
    const jump = Math.abs(ctx.simMs - this.lastSimMs) / 1000 > 600 + 30 * Math.abs(ctx.simDt);
    if (jump || Number.isNaN(this.lastSimMs)) this.shown.clear();
    this.lastSimMs = ctx.simMs;

    this.ferries(ctx, sec);
    this.airportFerry(ctx, sec);
    this.taxis(ctx, p.month, p.weekday, sec);
    this.tourBoats(ctx, p.month, sec);
    this.pleasure(ctx, p.month, p.weekday, sec);
    this.lakers(ctx, p.month, p.day, sec, key);
    this.specials(ctx);
    this.marinas(ctx, p.month, p.weekday, key);

    this.drawn.length = this.nDrawn;
    // shadow frustum half-size as render/atmosphere.ts sizes it (its corners: × √2, + a step of its sizing)
    this.pools.commit(ctx.altitude < 2500, Math.min(1800, Math.max(200, ctx.altitude * 1.2 + 150)) * 1.25 * 1.42 + 30);
  }

  /**
   * Draw one boat. Culls by range / frustum / pixel size, adds gentle heave,
   * pitch and roll, nav lights at night and a wake when under way.
   */
  private emit(ctx: FrameContext, key: BoatKey, e: number, n: number, yaw: number, speed: number, o: {
    len: number; beam: number; scale?: number; tint?: number; flags?: number; roll?: number; seed: number;
    label: string; range?: number; lights?: 'all' | 'anchor' | 'none';
  }) {
    const s = o.scale ?? 1;
    const L = o.len * s;
    const cx = ctx.cameraPos.x, cy = ctx.cameraPos.y, cz = ctx.cameraPos.z;
    const dx = e - cx, dz = -n - cz, dy = this.level - cy;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > (o.range ?? 9000)) return;
    if (L * ctx.pixelScale / Math.max(dist, 1) < 1.2) return;
    if (!ctx.view.sphereEN(e, n, this.level + L * 0.15, L * 0.6 + 6)) return;
    // street level: boats behind the nearby buildings (masts ≤ ~1.6 × length)
    const hz = this.engine.tiles.horizon;
    if (hz.valid && dist > R_OCC + L && hz.hides(cx, -cz, cy, e - L, n - L, e + L, n + L, this.level - 1, this.level + L * 1.7 + 3)) return;
    // swell: smaller boats move more
    const small = Math.max(0, Math.min(1, (40 - L) / 32));
    const t = ctx.time + o.seed * 7.3;
    const w = 1.4 + (o.seed % 5) * 0.12;
    const heave = (0.02 + 0.09 * small) * Math.sin(t * w);
    const pitch = (0.003 + 0.022 * small) * Math.sin(t * w * 0.83 + 1.1);
    const roll = (o.roll ?? 0) + (0.003 + 0.035 * small) * Math.sin(t * w * 0.61 + 2.3);
    const ax = ctx.anchor.origin.x, az = ctx.anchor.origin.z;
    const x = e - ax, z = -n - az, y = this.level + heave;
    _c.setHex(o.tint ?? 0xffffff, THREE.SRGBColorSpace);
    const night = 1 - ctx.daylight;
    const flags = o.flags ?? 0;
    // shadow reach: distance from the axis of the sun's (orthographic) shadow frustum,
    // which runs along the sun direction through the camera focus
    const vx = e - ctx.focus.x, vy = this.level - ctx.focus.y, vz = -n - ctx.focus.z, sd = ctx.sunDir;
    const along = vx * sd.x + vy * sd.y + vz * sd.z;
    const fd = Math.hypot(vx - along * sd.x, vy - along * sd.y, vz - along * sd.z) - L * 1.7;
    const model = this.pools.add(key, x, y, z, yaw, pitch, roll, s, _c, flags, fd);
    if (night > 0.15 && dist < 12000 && o.lights !== 'none') {
      const gain = 0.35 + night * 1.1;
      if (o.lights === 'anchor') this.pools.lightsFor(model, dist, ctx.pixelScale, gain, 'anchor');
      else if (flags & F_NAV) this.pools.lightsFor(model, dist, ctx.pixelScale, gain);
    }
    if (speed > 0.4 && dist < 7000) {
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      this.pools.addWake(x + c * L * 0.5, this.level + 0.04, z - sn * L * 0.5, yaw, L, model.beam * s, speed, o.seed);
    }
    if (speed > 0.4) this.stats.moving++;
    const dr = this.drawn[this.nDrawn] ?? (this.drawn[this.nDrawn] = { e: 0, n: 0, yaw: 0, len: 0, label: '' });
    this.nDrawn++;
    dr.e = e; dr.n = n; dr.yaw = yaw; dr.len = L; dr.label = o.label;
  }

  // ------------------------------------------------------------------ Island ferries
  private ferries(ctx: FrameContext, sec: number) {
    const plan = this.plan;
    if (!plan) return;
    const byVessel = new Map<string, typeof plan.trips>();
    for (const t of plan.trips) {
      let l = byVessel.get(t.vessel);
      if (!l) byVessel.set(t.vessel, (l = []));
      l.push(t);
    }
    const night = ctx.daylight < 0.5;
    const docked: { name: string; route: RouteId; label: string }[] = [];
    for (const [name, trips] of byVessel) {
      const v = VESSELS[name];
      const m = boatSize(v.model);
      const trip = trips.find((t) => sec >= t.dep && sec <= t.arrBack);
      if (!trip) {
        const next = trips.find((t) => t.dep > sec);
        docked.push({ name, route: trips[0].route, label: `${name} · ${v.note} — at Jack Layton Ferry Terminal${next ? `, next departure ${clockStr(next.dep)} to ${ROUTE_NAME[next.route]}` : ', off duty for the night'}` });
        continue;
      }
      const path = this.routes.get(trip.route);
      if (!path) continue;
      const s0 = m.len / 2 + 2, s1 = path.length - m.len / 2 - 2;
      const dest = ROUTE_NAME[trip.route];
      let s: number, speed = 0, yawFlip = false, label: string;
      if (sec < trip.arr) {
        const q = trapezoid(sec - trip.dep, trip.arr - trip.dep, 70);
        s = s0 + (s1 - s0) * q.f; speed = q.v * (s1 - s0);
        label = `${name} · ${v.note} — Jack Layton → ${dest}, departed ${clockStr(trip.dep)}, arrives ${clockStr(trip.arr)}`;
      } else if (sec < trip.depBack) {
        s = s1;
        label = `${name} · ${v.note} — docked at ${dest}, departs for the city ${clockStr(trip.depBack)}`;
      } else {
        const q = trapezoid(sec - trip.depBack, trip.arrBack - trip.depBack, 70);
        s = s1 - (s1 - s0) * q.f; speed = q.v * (s1 - s0); yawFlip = true;
        label = `${name} · ${v.note} — ${dest} → Jack Layton, arrives ${clockStr(trip.arrBack)}`;
      }
      path.at(s, _p);
      const yaw = _p.h + (yawFlip ? Math.PI : 0);
      this.emit(ctx, v.model, _p.e, _p.n, yaw, speed, {
        len: m.len, beam: m.beam, seed: hashStr(name), label, range: 20000,
        flags: F_NAV | (night ? F_WIN : 0),
      });
      this.stats.ferries++;
    }
    // off-duty / waiting vessels at the Jack Layton slips (own route's slip first, else a free one)
    const used = new Set<string>();
    const slots: RouteId[] = ['centre', 'wards', 'hanlans'];
    for (const n of plan.idle) docked.push({ name: n, route: 'centre', label: `${n} · ${VESSELS[n].note} — laid up at Jack Layton Ferry Terminal` });
    for (const dk of docked) {
      const slip = !used.has(dk.route) ? dk.route : slots.find((r) => !used.has(r));
      if (!slip) continue;
      used.add(slip);
      const path = this.routes.get(slip);
      if (!path) continue;
      const v = VESSELS[dk.name];
      const m = boatSize(v.model);
      path.at(m.len / 2 + 2, _p);
      this.emit(ctx, v.model, _p.e, _p.n, _p.h, 0, {
        len: m.len, beam: m.beam, seed: hashStr(dk.name), label: dk.label, range: 20000,
        flags: night ? F_WIN | F_NAV : 0,
      });
      this.stats.ferries++;
    }
  }

  private airportFerry(ctx: FrameContext, sec: number) {
    const path = this.routes.get('airport');
    if (!path) return;
    const m = boatSize('marilynBell');
    const s0 = Math.min(m.len / 2 + 2, path.length / 2), s1 = Math.max(path.length - m.len / 2 - 2, s0);
    let s = s0, speed = 0, yaw = 0, label: string;
    const on = sec >= AIRPORT.first - 60 && sec <= AIRPORT.last + AIRPORT.headway;
    if (!on) {
      path.at(s0, _p); yaw = _p.h;
      label = 'Marilyn Bell I · Billy Bishop airport ferry — tied up at the Bathurst St. terminal (service 5:15 a.m. – midnight)';
    } else {
      const k = Math.floor((sec - AIRPORT.first) / AIRPORT.headway);
      const t0 = AIRPORT.first + k * AIRPORT.headway, u = sec - t0;
      if (u >= 0 && u < AIRPORT.cross && t0 <= AIRPORT.last) {
        const q = trapezoid(u, AIRPORT.cross, 25);
        s = s0 + (s1 - s0) * q.f; speed = q.v * (s1 - s0);
        label = `Marilyn Bell I · Billy Bishop airport ferry — crossing the Western Gap to the airport (departed ${clockStr(t0)})`;
      } else if (u >= AIRPORT.cross && u < AIRPORT.backOffset) {
        s = s1; label = `Marilyn Bell I · Billy Bishop airport ferry — at the airport, departs ${clockStr(t0 + AIRPORT.backOffset)}`;
      } else if (u >= AIRPORT.backOffset && u < AIRPORT.backOffset + AIRPORT.cross) {
        const q = trapezoid(u - AIRPORT.backOffset, AIRPORT.cross, 25);
        s = s1 - (s1 - s0) * q.f; speed = q.v * (s1 - s0);
        label = 'Marilyn Bell I · Billy Bishop airport ferry — returning to the Bathurst St. terminal';
      } else {
        s = s0; label = `Marilyn Bell I · Billy Bishop airport ferry — at Bathurst St., departs ${clockStr(t0 + AIRPORT.headway)}`;
      }
      path.at(s, _p); yaw = _p.h;
    }
    this.emit(ctx, 'marilynBell', _p.e, _p.n, yaw, speed, {
      len: m.len, beam: m.beam, seed: 4242, label, range: 20000, flags: F_NAV | (ctx.daylight < 0.5 ? F_WIN : 0),
    });
    this.stats.ferries++;
  }

  // ------------------------------------------------------------------ water taxis
  private taxis(ctx: FrameContext, month: number, weekday: number, sec: number) {
    if (!this.taxiPaths.length) return;
    const summer = month >= 6 && month <= 8, shoulder = month === 5 || month === 9 || month === 10;
    if (!summer && !shoulder) return;
    const weekend = weekday === 0 || weekday === 6;
    const count = summer ? 6 : weekend ? 4 : 2;
    const open = summer ? 9 * 3600 : 10 * 3600, close = summer ? 23.5 * 3600 : 20 * 3600;
    const V = 7; // m/s ≈ 13.6 kn
    const m = boatSize('taxi');
    for (let k = 0; k < count; k++) {
      let t = open + k * 137;
      if (sec < t || sec > close) {
        // tied up at the stand, rafted side by side
        const path = this.taxiPaths[0].path;
        path.at(6 + k * 0.1, _p);
        const off = (k - count / 2) * 3.2;
        this.emit(ctx, 'taxi', _p.e + Math.cos(_p.h + Math.PI / 2) * off, _p.n + Math.sin(_p.h + Math.PI / 2) * off, _p.h, 0, {
          len: m.len, beam: m.beam, seed: 900 + k, label: 'Toronto Harbour water taxi — waiting at the Harbourfront stand', lights: 'none',
        });
        continue;
      }
      // replay the day's trips (deterministic) up to now
      for (let trip = 0; trip < 80; trip++) {
        const h = (x: number) => hash01(k, trip, x);
        const wait = 120 + h(1) * 360;
        const route = this.taxiPaths[Math.floor(h(2) * this.taxiPaths.length)];
        const T = route.path.length / V + 20;
        const stay = 120 + h(3) * 240;
        const s0 = 6, s1 = route.path.length - m.len / 2 - 3;
        const tOut = t + wait, tArr = tOut + T, tBack = tArr + stay, tHome = tBack + T;
        if (sec < tHome) {
          let s = s0, speed = 0, back = false, label: string;
          if (sec < tOut) label = `Toronto Harbour water taxi — boarding at Harbourfront for ${route.dest}`;
          else if (sec < tArr) { const q = trapezoid(sec - tOut, T, 18); s = s0 + (s1 - s0) * q.f; speed = q.v * (s1 - s0); label = `Toronto Harbour water taxi — to ${route.dest}`; }
          else if (sec < tBack) { s = s1; label = `Toronto Harbour water taxi — dropping off at ${route.dest}`; }
          else { const q = trapezoid(sec - tBack, T, 18); s = s1 - (s1 - s0) * q.f; speed = q.v * (s1 - s0); back = true; label = `Toronto Harbour water taxi — returning from ${route.dest}`; }
          route.path.at(s, _p);
          this.emit(ctx, 'taxi', _p.e, _p.n, _p.h + (back ? Math.PI : 0), speed, {
            len: m.len, beam: m.beam, seed: 900 + k, label, flags: F_NAV,
          });
          break;
        }
        t = tHome;
      }
    }
  }

  // ------------------------------------------------------------------ tour boats
  private tourBoats(ctx: FrameContext, month: number, sec: number) {
    if (!this.tours.length || month < 5 || month > 10) return;
    const fleet: { key: BoatKey; loop: number; offset: number; name: string }[] = [
      { key: 'tour', loop: 0, offset: 0, name: 'Harbourfront harbour cruise' },
      { key: 'tour', loop: 1, offset: 1800, name: 'Harbourfront harbour cruise' },
      { key: 'tour', loop: 1, offset: 0, name: 'Toronto Harbour Tours' },
    ];
    if (month >= 6 && month <= 9) fleet.push({ key: 'schooner', loop: 0, offset: 1800, name: 'Kajama · Great Lakes Schooner Co. tall-ship cruise' });
    const V = 3.2;
    fleet.forEach((b, i) => {
      const path = this.tours[b.loop % this.tours.length];
      const m = boatSize(b.key);
      const T = path.length / V;
      const first = 11 * 3600 + b.offset, last = 21 * 3600 + b.offset;
      const inHours = sec >= first - 1800 && sec <= last + T + 1800; // out of hours: not on the harbour
      if (!inHours) {
        path.at(0, _p);
        if (this.gate(ctx, 2e6 + i, false, _p.e, _p.n, m.len)) {
          this.emit(ctx, b.key, _p.e, _p.n, _p.h, 0, {
            len: m.len, beam: m.beam, seed: 300 + i, tint: b.key === 'tour' ? (i === 2 ? 0x1f4f9a : 0x1e3a6e) : 0xffffff,
            label: `${b.name} — off York Quay, finished for the day`, range: 14000,
          });
        }
        return;
      }
      const k = Math.max(0, Math.min(Math.floor((sec - first) / 3600), Math.floor((last - first) / 3600)));
      const t0 = first + k * 3600, u = sec - t0;
      let s = 0, speed = 0, label: string;
      if (u >= 0 && u < T) {
        const q = trapezoid(u, T, 60);
        s = path.length * q.f; speed = q.v * path.length;
        label = `${b.name} — 1-hour harbour tour, departed ${clockStr(t0)}`;
      } else {
        label = `${b.name} — boarding off York Quay, next departure ${clockStr(u < 0 ? t0 : t0 + 3600)}`;
      }
      path.at(s, _p);
      if (!this.gate(ctx, 2e6 + i, true, _p.e, _p.n, m.len)) return;
      this.emit(ctx, b.key, _p.e, _p.n, _p.h, speed, {
        len: m.len, beam: m.beam, seed: 300 + i, tint: b.key === 'tour' ? (i === 2 ? 0x1f4f9a : 0x1e3a6e) : 0xffffff,
        label, flags: F_NAV | (ctx.daylight < 0.5 ? F_WIN : 0), range: 14000,
      });
    });
  }

  // ------------------------------------------------------------------ pleasure boats
  private pleasure(ctx: FrameContext, month: number, weekday: number, sec: number) {
    const d = this.data!;
    const f = boatingFactor(month, weekday, sec / 3600, this.weather);
    const wind = this.weather;
    const windFrom = wind.windDir; // compass, radians
    const cx = ctx.cameraPos.x, cn = -ctx.cameraPos.z;
    for (const z of d.zones) {
      const loops = this.loops.get(z.id);
      if (!loops?.length) continue;
      // rough zone culling: nearest loop start within 12 km
      const l0 = loops[0];
      const zs = hashStr(z.id);
      const zk = 1e6 + (zs % 997) * 1000;
      if (Math.hypot(l0.pts[0] - cx, l0.pts[1] - cn) > 14000) {
        for (let i = 0; i < z.peak; i++) this.shown.delete(zk + i); // far away: re-sync on approach
        continue;
      }
      const N = Math.round(z.peak * f);
      for (let i = 0; i < z.peak; i++) {
        const h = (x: number) => hash01(zs, i, x);
        const r = h(1);
        const key: BoatKey = r < 0.55 ? 'sail' : r < 0.82 ? 'power' : 'runabout';
        const path = loops[Math.floor(h(2) * loops.length)];
        const v = key === 'sail' ? 2.0 + 1.6 * h(3) * (wind.wind / 6) : key === 'power' ? 5 + 4 * h(3) : 7 + 5 * h(3);
        const dir = h(6) < 0.5 ? 1 : -1;
        const s = h(4) * path.length + dir * v * sec;
        path.at(s, _p);
        const yaw = _p.h + (dir < 0 ? Math.PI : 0);
        const size = boatSize(key);
        if (!this.gate(ctx, zk + i, i < N, _p.e, _p.n, 15)) continue;
        const scale = key === 'runabout' ? 0.9 + 0.3 * h(5) : 0.75 + 0.55 * h(5);
        let roll = 0;
        if (key === 'sail') {
          // heel to leeward: wind from starboard (relative angle 0..π) → port side down (roll < 0)
          const headingCompass = Math.PI / 2 - yaw;
          const rel = windFrom - headingCompass;
          const sr = Math.sin(rel);
          roll = -Math.sign(sr) * Math.min(1, Math.abs(sr) * 1.5) * (0.06 + 0.22 * Math.min(1, wind.wind / 9));
        }
        const tint = key === 'runabout' ? RUNABOUT_COLS[Math.floor(h(7) * RUNABOUT_COLS.length)] : HULL_STRIPES[Math.floor(h(7) * HULL_STRIPES.length)];
        const label = `${key === 'sail' ? 'Sailboat' : key === 'power' ? 'Motor cruiser' : 'Bowrider'} · ${z.name}`;
        this.emit(ctx, key, _p.e, _p.n, yaw, v, { len: size.len, beam: size.beam, scale, tint, roll, seed: zs + i, label, flags: F_NAV });
      }
    }
  }

  // ------------------------------------------------------------------ lakers, fireboat, Coast Guard
  private lakers(ctx: FrameContext, month: number, day: number, sec: number, dayKey: number) {
    const d = this.data!;
    const m = boatSize('laker');
    const open = seawayOpen(month, day);
    const t = (dayKey % 100000) * 86400 + sec; // continuous across days
    if (open) {
      const perLane: Record<string, number> = { welland_hamilton: 2, welland_east: 2, welland_toronto: 1 };
      for (const { id, path } of this.lanes) {
        const n = perLane[id] ?? 1;
        for (let k = 0; k < n; k++) {
          const v = 5.8; // ~11 kn
          const dwell = 3 * 3600;
          const run = path.length / v;
          const cycle = 2 * run + 2 * dwell;
          const ph = (((t + hash01(hashStr(id), k, 1) * cycle) % cycle) + cycle) % cycle;
          let s: number, speed = 0, back = false, label: string;
          const name = LAKER_NAMES[(hashStr(id) + k) % LAKER_NAMES.length];
          if (ph < run) { const q = trapezoid(ph, run, 900); s = path.length * q.f; speed = q.v * path.length; label = `${name} · laker — ${laneLabel(id, false)}`; }
          else if (ph < run + dwell) { s = path.length; label = `${name} · laker — ${laneEnd(id)}`; }
          else if (ph < 2 * run + dwell) { const q = trapezoid(ph - run - dwell, run, 900); s = path.length * (1 - q.f); speed = q.v * path.length; back = true; label = `${name} · laker — ${laneLabel(id, true)}`; }
          else { s = 0; label = `${name} · laker — waiting at Port Weller for the Welland Canal locks`; }
          path.at(s, _p);
          this.emit(ctx, 'laker', _p.e, _p.n, _p.h + (back ? Math.PI : 0), speed, {
            len: m.len, beam: m.beam, seed: 700 + k + hashStr(id), tint: LAKER_TINTS[(hashStr(id) + k) % LAKER_TINTS.length],
            label, flags: F_NAV | F_WIN, range: 45000,
          });
          this.stats.lakers++;
        }
      }
    }
    for (let bi = 0; bi < d.berths.length; bi++) {
      const b = d.berths[bi];
      if (b.kind !== 'laker') continue;
      // winter lay-up: every lay-by berth taken; in season about half, changing daily
      const want = !open || hash01(hashStr(b.id), dayKey, 3) < 0.5;
      if (!this.gate(ctx, 3e6 + bi, want, b.p[0], b.p[1], b.len)) continue;
      const name = LAKER_NAMES[(hashStr(b.id) + 3) % LAKER_NAMES.length];
      this.emit(ctx, 'laker', b.p[0], b.p[1], b.h, 0, {
        len: m.len, beam: m.beam, scale: b.len / m.len, seed: hashStr(b.id), tint: LAKER_TINTS[hashStr(b.id) % LAKER_TINTS.length],
        label: `${name} · laker — ${open ? 'alongside' : 'winter lay-up'}, ${b.name}`, flags: F_NAV | F_WIN, range: 45000, lights: 'anchor',
      });
      this.stats.lakers++;
    }
  }

  private specials(ctx: FrameContext) {
    for (const b of this.data!.berths) {
      if (b.kind === 'fireboat') {
        const m = boatSize('fireboat');
        this.emit(ctx, 'fireboat', b.p[0], b.p[1], b.h, 0, {
          len: m.len, beam: m.beam, seed: 55, label: 'William Lyon Mackenzie · Toronto Fire Services fireboat — at Fire Station 334, Queens Quay W', lights: 'anchor', range: 14000,
        });
      } else if (b.kind === 'ccg') {
        const m = boatSize('ccg');
        this.emit(ctx, 'ccg', b.p[0], b.p[1], b.h, 0, {
          len: m.len, beam: m.beam, scale: b.len / m.len, seed: hashStr(b.id), label: `Canadian Coast Guard cutter — ${b.name}`, lights: 'anchor', range: 14000,
        });
      }
    }
  }

  // ------------------------------------------------------------------ marinas
  private marinas(ctx: FrameContext, month: number, weekday: number, dayKey: number) {
    const d = this.data!;
    // boats out on the water leave empty slips (a daily figure, so slips never empty in view)
    const out = boatingFactor(month, weekday, 14, this.weather) * 0.25;
    const afloat = afloatFraction(month) * (1 - out);
    const cx = ctx.cameraPos.x, cn = -ctx.cameraPos.z;
    const night = ctx.daylight < 0.5;
    const range = 9000;
    for (let mi = 0; mi < d.marinas.length; mi++) {
      const mar = d.marinas[mi];
      if (Math.hypot(mar.c[0] - cx, mar.c[1] - cn) > range + 1500) continue;
      const labels = this.marinaLabels[mi];
      for (let i = 0; i < mar.boats.length; i++) {
        const [e, n, h, L] = mar.boats[i];
        // winter: the few left in are the same boats every day (bubblers)
        if (hash01(mi, i, 17) > afloat) continue;
        const sail = hash01(mi, i, 5) < 0.58;
        const key: BoatKey = sail ? 'sailMoored' : 'power';
        const tint = HULL_STRIPES[Math.floor(hash01(mi, i, 6) * HULL_STRIPES.length)];
        const live = night && hash01(mi, i, dayKey) < 0.05; // liveaboards / evening crews
        this.emit(ctx, key, e, n, h, 0, {
          len: 10, beam: 3.4, scale: L / 10, tint, seed: mi * 1000 + i, label: labels[sail ? 0 : 1],
          flags: live ? F_WIN : 0, lights: live ? 'anchor' : 'none', range,
        });
        this.stats.moored++;
      }
    }
  }

  /**
   * Hysteresis for boats that come and go (leisure boats, tour boats, berthed
   * lakers): a boat's shown state only follows `want` while it is out of the
   * view frustum or more than 1.5 km from the camera, so nothing pops in view.
   */
  private gate(ctx: FrameContext, key: number, want: boolean, e: number, n: number, r: number): boolean {
    const cur = this.shown.get(key);
    if (cur === undefined || cur === want) { this.shown.set(key, want); return want; }
    const dx = e - ctx.cameraPos.x, dz = -n - ctx.cameraPos.z, dy = this.level - ctx.cameraPos.y;
    if (dx * dx + dy * dy + dz * dz > 1500 * 1500 || !ctx.view.sphereEN(e, n, this.level + r * 0.2, r)) {
      this.shown.set(key, want);
      return want;
    }
    return cur;
  }

  // ------------------------------------------------------------------ picking
  pick(clientX: number, clientY: number): Drawn | null {
    const ctx = this.ctx;
    if (!ctx || !this.nDrawn) return null;
    const cam = this.engine.camera;
    const r = this.engine.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const m = this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const proj = (e: number, n: number, h: number, out: number[]) => {
      const X = e, Y = h, Z = -n;
      const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
      if (w <= 0.01) return false;
      out[0] = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * r.width;
      out[1] = (-(m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5) * r.height;
      return true;
    };
    const a = [0, 0], b = [0, 0];
    let best: Drawn | null = null, bd = PICK_PX;
    for (let i = 0; i < this.nDrawn; i++) {
      const d = this.drawn[i];
      const c = Math.cos(d.yaw) * d.len * 0.45, s = Math.sin(d.yaw) * d.len * 0.45;
      const h = this.level + Math.min(3, d.len * 0.08);
      if (!proj(d.e + c, d.n + s, h, a) || !proj(d.e - c, d.n - s, h, b)) continue;
      const dist = segDist(x, y, a[0], a[1], b[0], b[1]);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), btn: e.button };
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.target !== this.engine.renderer.domElement || d.btn !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
    // registered after the InteractLayer's handler, so a boat hit wins over its "clicked nothing" deselect
    const hit = this.pick(e.clientX, e.clientY);
    if (hit) useApp.getState().select({ kind: 'boat', id: `${Math.round(hit.e)},${Math.round(hit.n)}`, label: hit.label });
  };

  dispose() {
    this.engine.renderer.domElement.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    this.pools.dispose();
  }
}

// ------------------------------------------------------------------ helpers
const SIZES: Partial<Record<BoatKey, { len: number; beam: number }>> = {};
function boatSize(k: BoatKey) {
  let s = SIZES[k];
  if (!s) { const m = boatModel(k); s = SIZES[k] = { len: m.len, beam: m.beam }; }
  return s;
}

function clockStr(sec: number) {
  const h = Math.floor(sec / 3600) % 24, m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Great Lakes fleet names (CSL, Algoma, Lower Lakes, McKeil) for the generic lakers
const LAKER_NAMES = ['Algoma Equinox', 'CSL Welland', 'Baie St. Paul', 'Algoma Guardian', 'Thunder Bay', 'Manitoulin', 'Algoma Innovator', 'Rt. Hon. Paul J. Martin', 'Mississagi', 'Evans Spirit'];

function laneLabel(id: string, back: boolean) {
  const to = id === 'welland_hamilton' ? 'Hamilton Harbour' : id === 'welland_toronto' ? 'Toronto' : 'Kingston / the St. Lawrence';
  return back ? `bound for Port Weller and the Welland Canal from ${to}` : `upbound from the Welland Canal to ${to}`;
}
function laneEnd(id: string) {
  return id === 'welland_hamilton' ? 'unloading in Hamilton Harbour' : id === 'welland_toronto' ? 'waiting off the Eastern Gap for Redpath Sugar' : 'leaving the region eastbound';
}
