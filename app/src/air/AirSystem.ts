// Schedule-driven air traffic: loads airports + daily schedules and, for any
// sim time, yields every visible aircraft pose (airborne, taxiing, parked).
//
// Time model: an "air day" runs 03:00 -> 27:00 local. Each rotation (an
// aircraft's arrival + the departure it operates next) belongs to one air day;
// a departure time earlier than its arrival means next morning (overnight at
// the stand). At time τ we evaluate air days D-1, D and D+1, each with its own
// weekday/weekend profile and runway configuration, so overnight aircraft
// carry across the day boundary.
import { Airport } from './airport';
import type { AirportsFile, ScheduleFile, Place } from './data';
import { buildArrival, buildDeparture, sampleTrack, standPose, PH, type Pose, type Track } from './track';
import { AIRCRAFT, aircraftModel } from '../models/aircraft';
import { torontoParts } from '../state/clock';

export type AirProfile = 'weekday' | 'saturday' | 'sunday';
const DAY0 = 3 * 3600;
const PRE_ARR = 60 * 60; // start considering an arrival this long before touchdown
const POST_ARR = 35 * 60;
const PRE_DEP = 45 * 60;
const POST_DEP = 40 * 60;
const BUILD_BUDGET_MS = 6;

export interface AirPlane {
  /** unique per rotation instance: `${dayNum}:${icao}:${rot}` */
  key: string;
  icao: string;
  rot: number;
  dayNum: number;
  profile: AirProfile;
  kind: 'arr' | 'dep' | 'park';
  type: string;
  airline: string;
  pose: Pose;
}

export interface FlightInfo {
  airport: string;
  airportName: string;
  airline: string;
  airlineName: string;
  type: string;
  typeName: string;
  kind: 'arr' | 'dep' | 'park';
  callsign: string;
  flight: string;
  other: Place | null;
  otherCode: string;
  sched: number;
  stand: string;
  runway: string;
  next?: { callsign: string; flight: string; other: Place | null; otherCode: string; sched: number };
}

/** operating carriers that fly under a partner's flight numbers */
const MARKETING: Record<string, string> = { JZA: 'AC', ROU: 'AC' };
const DISPLAY_NAME: Record<string, string> = { JZA: 'Air Canada Express (Jazz)', ROU: 'Air Canada Rouge' };

interface CacheEntry { tr: Track; used: number }

function profileOf(weekday: number): AirProfile {
  return weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'weekday';
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** approximate inverse of the world projection (fine for bearings) */
function lonLat(e: number, n: number): [number, number] {
  const lat = 43.6532 + n / 111132;
  const lon = -79.3832 + e / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lon, lat];
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180, dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export class AirSystem {
  file: AirportsFile | null = null;
  airports = new Map<string, Airport>();
  schedules = new Map<AirProfile, ScheduleFile>();
  planes: AirPlane[] = [];
  count = 0;
  /** runway configuration name per airport for the current air day (for UI) */
  configName = new Map<string, string>();
  private cache = new Map<string, CacheEntry>();
  private frame = 0;
  private bearings = new Map<string, number>();
  private pool: AirPlane[] = [];
  private tmpPose: Pose = { e: 0, n: 0, h: 0, yaw: 0, pitch: 0, bank: 0, v: 0, phase: 0, flags: 0 };
  private base: string;

  constructor(dataRoot: string) {
    this.base = `${dataRoot}/air/`;
  }

  async load() {
    const get = async <T,>(f: string): Promise<T> => {
      const r = await fetch(this.base + f);
      if (!r.ok) throw new Error(`air: ${f} ${r.status}`);
      return r.json() as Promise<T>;
    };
    this.file = await get<AirportsFile>('airports.json');
    for (const a of this.file.airports) this.airports.set(a.icao, new Airport(a));
    const profs: AirProfile[] = ['weekday', 'saturday', 'sunday'];
    const s = await Promise.all(profs.map((p) => get<ScheduleFile>(`schedule_${p}.json`)));
    profs.forEach((p, i) => this.schedules.set(p, s[i]));
  }

  get ready() { return this.file !== null && this.schedules.size === 3; }

  place(code: string): Place | null { return this.file?.places[code] ?? null; }

  private bearingTo(icao: string, code: string): number {
    const k = icao + code;
    let b = this.bearings.get(k);
    if (b === undefined) {
      const ap = this.airports.get(icao)!;
      const p = this.place(code);
      const [lon, lat] = lonLat(ap.j.pos[0], ap.j.pos[1]);
      b = p ? bearing(lat, lon, p.lat, p.lon) : 0;
      this.bearings.set(k, b);
    }
    return b;
  }

  /** runway configuration index for a given air day (same "wind" for every airport) */
  configIndex(ap: Airport, dayNum: number): number {
    const r = hash01(`wind:${dayNum}`);
    let acc = 0;
    const cf = ap.j.configs;
    const tot = cf.reduce((s, c) => s + c.weight, 0);
    for (let i = 0; i < cf.length; i++) { acc += cf[i].weight / tot; if (r < acc) return i; }
    return 0;
  }

  /** air-day number (days since epoch of the local date) + seconds into the air day */
  static airDay(simMs: number): { dayNum: number; tau: number; weekday: number } {
    const p = torontoParts(simMs);
    let dayNum = Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
    let tau = p.secOfDay;
    let weekday = p.weekday;
    if (tau < DAY0) { tau += 86400; dayNum -= 1; weekday = (weekday + 6) % 7; }
    return { dayNum, tau, weekday };
  }

  private track(key: string, build: () => Track | null, budget: { t: number }): Track | null {
    const c = this.cache.get(key);
    if (c) { c.used = this.frame; return c.tr; }
    if (performance.now() > budget.t) return null;
    const tr = build();
    if (!tr) return null;
    this.cache.set(key, { tr, used: this.frame });
    return tr;
  }

  /** Evaluate every aircraft at sim time. Fills `planes[0..count)`. */
  evaluate(simMs: number): void {
    this.count = 0;
    if (!this.ready) return;
    this.frame++;
    const budget = { t: performance.now() + BUILD_BUDGET_MS };
    const { dayNum: D, tau, weekday } = AirSystem.airDay(simMs);
    for (let o = -1; o <= 1; o++) {
      const dn = D + o;
      const t = tau - o * 86400;
      const prof = profileOf((weekday + o + 7) % 7);
      const sch = this.schedules.get(prof)!;
      for (const [icao, s] of Object.entries(sch.airports)) {
        const ap = this.airports.get(icao);
        if (!ap) continue;
        const cfg = this.configIndex(ap, dn);
        if (o === 0) this.configName.set(icao, ap.j.configs[cfg]?.name ?? '');
        const R = s.rot;
        for (let i = 0; i < R.ta.length; i++) {
          const ta = R.ta[i];
          const td = R.td[i] < ta ? R.td[i] + 86400 : R.td[i];
          if (t < ta - PRE_ARR || t > td + POST_DEP) continue;
          const st = R.st[i];
          if (st < 0) continue;
          const type = s.types[R.ty[i]];
          const airline = s.airlines[R.al[i]];
          const model = aircraftModel(type);
          const stand = ap.stand(st);
          const keyBase = `${dn}:${icao}:${i}`;
          let pose: Pose | null = null;
          let kind: AirPlane['kind'] = 'park';
          if (t <= ta + POST_ARR) {
            const tr = this.track(`${keyBase}:a:${cfg}`, () => buildArrival({
              ap, rwy: ap.runwayFor(R.sa[i], cfg), stand, spec: model.spec, noseX: model.points.noseX,
              time: ta, bearing: this.bearingTo(icao, R.afrom[i]), key: keyBase + 'a', corners: icao === 'CYYZ',
            }), budget);
            if (!tr) continue;
            if (t < tr.t0) continue;
            if (t <= tr.t1) { pose = sampleTrack(tr, t, this.tmpPose); kind = 'arr'; }
          }
          if (!pose && t >= td - PRE_DEP) {
            const tr = this.track(`${keyBase}:d:${cfg}`, () => buildDeparture({
              ap, rwy: ap.runwayFor(R.sd[i], cfg), stand, spec: model.spec, noseX: model.points.noseX,
              time: td, bearing: this.bearingTo(icao, R.dto[i]), key: keyBase + 'd', corners: false,
            }), budget);
            if (!tr) continue;
            if (t > tr.t1) continue;
            if (t >= tr.t0) { pose = sampleTrack(tr, t, this.tmpPose); kind = 'dep'; }
          }
          if (!pose) pose = standPose(stand, model.points.noseX, ap.H[stand.node]);
          const pl = this.slot();
          pl.key = keyBase; pl.icao = icao; pl.rot = i; pl.dayNum = dn; pl.profile = prof;
          pl.kind = kind; pl.type = type; pl.airline = airline;
          Object.assign(pl.pose, pose);
        }
      }
    }
    // evict stale tracks
    if (this.frame % 120 === 0) {
      for (const [k, c] of this.cache) if (this.frame - c.used > 600) this.cache.delete(k);
    }
  }

  private slot(): AirPlane {
    let p = this.pool[this.count];
    if (!p) {
      p = { key: '', icao: '', rot: 0, dayNum: 0, profile: 'weekday', kind: 'park', type: '', airline: '', pose: { e: 0, n: 0, h: 0, yaw: 0, pitch: 0, bank: 0, v: 0, phase: 0, flags: 0 } };
      this.pool.push(p);
    }
    this.planes = this.pool;
    this.count++;
    return p;
  }

  /** Human-readable flight info for a plane (UI). */
  info(pl: { icao: string; rot: number; dayNum: number; profile: AirProfile; kind: AirPlane['kind'] }): FlightInfo | null {
    const sch = this.schedules.get(pl.profile);
    const s = sch?.airports[pl.icao];
    const ap = this.airports.get(pl.icao);
    if (!s || !ap || !this.file) return null;
    const R = s.rot, i = pl.rot;
    const al = s.airlines[R.al[i]];
    const type = s.types[R.ty[i]];
    const alInfo = this.file.airlines[al];
    const flightNo = (cs: string) => {
      const num = cs.slice(3).replace(/^0+/, '');
      const iata = MARKETING[al] ?? alInfo?.iata;
      return iata ? `${iata} ${num}` : cs;
    };
    const cfg = this.configIndex(ap, pl.dayNum);
    const arr = pl.kind === 'arr';
    const cs = arr ? R.acs[i] : R.dcs[i];
    const other = arr ? R.afrom[i] : R.dto[i];
    const info: FlightInfo = {
      airport: pl.icao, airportName: ap.j.name, airline: al, airlineName: DISPLAY_NAME[al] ?? alInfo?.name ?? al,
      type, typeName: AIRCRAFT[type]?.name ?? type, kind: pl.kind,
      callsign: cs, flight: flightNo(cs), other: this.place(other), otherCode: other,
      sched: arr ? R.ta[i] : R.td[i],
      stand: ap.stand(R.st[i])?.ref ?? '',
      runway: ap.runwayFor(arr ? R.sa[i] : R.sd[i], cfg).des,
    };
    if (pl.kind === 'park') {
      info.callsign = R.dcs[i]; info.flight = flightNo(R.dcs[i]); info.other = this.place(R.dto[i]); info.otherCode = R.dto[i];
      info.sched = R.td[i];
      info.runway = ap.runwayFor(R.sd[i], cfg).des;
      info.next = { callsign: R.acs[i], flight: flightNo(R.acs[i]), other: this.place(R.afrom[i]), otherCode: R.afrom[i], sched: R.ta[i] };
    }
    return info;
  }

  /** find the current pose of a plane by key (for follow / panel) */
  find(key: string): AirPlane | null {
    for (let i = 0; i < this.count; i++) if (this.planes[i].key === key) return this.planes[i];
    return null;
  }

  stats() {
    const out: Record<string, { movements: number; airborne: number; ground: number }> = {};
    for (const [prof, s] of this.schedules) {
      if (prof !== 'weekday') continue;
      for (const [icao, a] of Object.entries(s.airports)) out[icao] = { movements: a.rot.ta.length * 2, airborne: 0, ground: 0 };
    }
    for (let i = 0; i < this.count; i++) {
      const p = this.planes[i];
      const o = out[p.icao];
      if (!o) continue;
      const air = p.pose.phase >= PH.CLIMB && p.pose.phase <= PH.LANDING;
      if (air) o.airborne++; else o.ground++;
    }
    return out;
  }
}
