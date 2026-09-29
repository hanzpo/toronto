// Player-operated transit vehicle: detached from the schedule, simulated along
// its pattern shape by distance. Notched traction/brake, curve speed limits,
// station stops with doors + dwell, schedule deviation and a simple block
// signal derived from the scheduled trains ahead.
import type { Mode, TripInfo, VehicleBuffers } from '../transit';
import type { PatternPath, PathStop } from './path';

export interface ModeDyn {
  /** max traction accel at low speed (m/s²) */
  accel: number;
  /** speed (m/s) above which traction falls off ∝ 1/v */
  baseSpeed: number;
  /** full service brake (m/s²) */
  brake: number;
  emergency: number;
  /** line speed (m/s) */
  vmax: number;
  /** lateral accel for curve limits (m/s²) */
  lat: number;
  vmin: number;
  /** stopping tolerance around the stop mark (m) */
  tol: number;
  length: number;
  /** passenger flow (pax/s all doors) */
  flow: number;
  capacity: number;
  doorTime: number;
  /** eye height above the rail/road (m) */
  eye: number;
  /** half chord for curve radius estimation (m) */
  chord: number;
}

const kmh = (v: number) => v / 3.6;

export const DYN: Record<Mode, ModeDyn> = {
  subway: { accel: 1.1, baseSpeed: kmh(35), brake: 1.2, emergency: 1.6, vmax: kmh(80), lat: 1.0, vmin: kmh(15), tol: 5, length: 138, flow: 6, capacity: 1100, doorTime: 3, eye: 2.55, chord: 30 },
  lrt: { accel: 1.2, baseSpeed: kmh(35), brake: 1.3, emergency: 2.5, vmax: kmh(80), lat: 1.0, vmin: kmh(15), tol: 4, length: 60, flow: 4, capacity: 400, doorTime: 3, eye: 2.6, chord: 25 },
  streetcar: { accel: 1.3, baseSpeed: kmh(30), brake: 1.4, emergency: 2.8, vmax: kmh(50), lat: 0.9, vmin: kmh(10), tol: 4, length: 30.2, flow: 3, capacity: 250, doorTime: 2.5, eye: 2.4, chord: 10 },
  commuter_rail: { accel: 0.55, baseSpeed: kmh(40), brake: 0.8, emergency: 1.2, vmax: kmh(145), lat: 1.0, vmin: kmh(25), tol: 10, length: 305, flow: 12, capacity: 1800, doorTime: 4, eye: 3.4, chord: 70 },
  airport_rail: { accel: 0.9, baseSpeed: kmh(45), brake: 1.0, emergency: 1.4, vmax: kmh(145), lat: 1.0, vmin: kmh(25), tol: 8, length: 76, flow: 4, capacity: 300, doorTime: 3, eye: 3.0, chord: 60 },
  intercity_rail: { accel: 0.5, baseSpeed: kmh(50), brake: 0.8, emergency: 1.2, vmax: kmh(160), lat: 1.0, vmin: kmh(25), tol: 12, length: 180, flow: 4, capacity: 500, doorTime: 4, eye: 3.4, chord: 70 },
  bus: { accel: 1.3, baseSpeed: kmh(25), brake: 1.5, emergency: 3.5, vmax: kmh(60), lat: 1.4, vmin: kmh(10), tol: 5, length: 12.2, flow: 1.5, capacity: 70, doorTime: 2, eye: 2.3, chord: 12 },
};

export const MAX_NOTCH = 4;
export const EB = -5;

export type DoorState = 'closed' | 'opening' | 'open' | 'closing';

export class TrainOperator {
  readonly info: TripInfo;
  readonly path: PatternPath;
  readonly mode: Mode;
  readonly dyn: ModeDyn;
  readonly route: number;
  s: number;
  v: number;
  a = 0;
  notch = 0;
  reverse = false;
  doors: DoorState = 'closed';
  private doorT = 0;
  /** index into path.stops of the next stop to serve */
  stopIdx = 0;
  onboard: number;
  boarding: { on: number; off: number; target: number; targetOff: number; done: boolean } | null = null;
  message = '';
  private msgT = 0;
  finished = false;
  trainAhead: number | null = null;
  aspect: 'green' | 'yellow' | 'red' | 'none' = 'none';
  atcTrip = false;
  overspeed = false;
  /** seconds without overspeed enforcement (right after takeover) */
  graceT = 8;

  constructor(info: TripInfo, path: PatternPath, s: number, v: number, dwelling: boolean, t: number) {
    this.info = info;
    this.path = path;
    this.mode = info.mode;
    this.route = info.route;
    this.dyn = DYN[info.mode];
    path.computeCurveLimits(this.dyn.lat, this.dyn.vmax, this.dyn.vmin, this.dyn.chord);
    this.s = s;
    this.v = v;
    const stops = path.stops;
    // next stop: first real stop not yet passed
    let k = 0;
    while (k < stops.length && stops[k].dist < s - (dwelling ? this.dyn.tol : -1)) k++;
    this.stopIdx = k;
    this.onboard = Math.round(this.dyn.capacity * (0.25 + 0.35 * rushFactor(t)));
    if (dwelling && k < stops.length && Math.abs(stops[k].dist - s) <= this.dyn.tol) {
      this.doors = 'open';
      this.startBoarding(t);
      this.boarding!.on = Math.floor(this.boarding!.target * 0.6);
      this.boarding!.off = this.boarding!.targetOff;
    }
    this.skipVirtual();
  }

  get nextStop(): PathStop | null {
    return this.path.stops[this.stopIdx] ?? null;
  }

  private skipVirtual() {
    const st = this.path.stops;
    while (this.stopIdx < st.length && st[this.stopIdx].virtual) this.stopIdx++;
  }

  flash(msg: string, secs = 3) { this.message = msg; this.msgT = secs; }

  notchUp() {
    if (this.notch === EB) { this.notch = -MAX_NOTCH; return; }
    if (this.notch < MAX_NOTCH) this.notch++;
    if (this.notch > 0 && this.doors !== 'closed') this.flash('Doors open — traction interlocked');
  }
  notchDown() { if (this.notch > -MAX_NOTCH) this.notch--; else this.notch = EB; }
  neutral() { this.notch = 0; }
  emergency() { this.notch = EB; }

  toggleReverse() {
    if (this.v > 0.05) { this.flash('Stop before changing direction'); return; }
    this.reverse = !this.reverse;
    this.flash(this.reverse ? 'Reverser: REVERSE (max 10 km/h)' : 'Reverser: FORWARD');
  }

  currentLimit(): number {
    if (this.reverse) return kmh(10);
    const L2 = this.dyn.length / 2, p = this.path;
    return Math.min(p.limitAt(this.s + L2), p.limitAt(this.s), p.limitAt(this.s - L2));
  }

  /** Distance from the stop mark (+ = before the mark). */
  stopError(): number | null {
    const ns = this.nextStop;
    return ns ? ns.dist - this.s : null;
  }

  canOpen(): boolean {
    const e = this.stopError();
    return this.v < 0.1 && e !== null && Math.abs(e) <= this.dyn.tol && this.doors === 'closed';
  }

  openDoors(t: number) {
    if (this.doors !== 'closed') return;
    const e = this.stopError();
    if (this.v >= 0.1) { this.flash('Stop the train first'); return; }
    if (e === null || Math.abs(e) > this.dyn.tol) {
      this.flash(e !== null && e < 0 ? `Overrun by ${(-e).toFixed(1)} m — reverse (R) to back up` : 'Not at a platform');
      return;
    }
    this.doors = 'opening';
    this.doorT = this.dyn.doorTime;
    this.notch = Math.min(this.notch, 0);
    this.startBoarding(t);
  }

  closeDoors() {
    if (this.doors !== 'open') return;
    if (this.boarding && !this.boarding.done) this.flash('Passengers still boarding…', 1.5);
    this.doors = 'closing';
    this.doorT = this.dyn.doorTime;
  }

  private startBoarding(t: number) {
    const rf = rushFactor(t);
    const ns = this.nextStop;
    const isLast = this.stopIdx >= this.path.stops.length - 1;
    const busy = ns && /union|bloor|yonge|st george|kennedy|finch|kipling|spadina|king|dundas|queen|college/i.test(ns.name) ? 1.8 : 1;
    const targetOff = isLast ? this.onboard : Math.round(this.onboard * (0.08 + 0.12 * Math.random()) * busy);
    const target = isLast ? 0 : Math.round(this.dyn.capacity * (0.03 + 0.1 * rf * Math.random()) * busy);
    this.boarding = { on: 0, off: 0, target, targetOff, done: false };
  }

  /**
   * Advance by dt sim seconds. `vehicles` = this frame's scheduled vehicles (for
   * the train-ahead check).
   */
  step(dt: number, _t: number, vehicles: VehicleBuffers | null) {
    if (this.msgT > 0) { this.msgT -= dt; if (this.msgT <= 0) this.message = ''; }
    // doors
    if (this.doors === 'opening' || this.doors === 'closing') {
      this.doorT -= dt;
      if (this.doorT <= 0) {
        if (this.doors === 'opening') this.doors = 'open';
        else {
          this.doors = 'closed';
          this.boarding = null;
          const last = this.stopIdx >= this.path.stops.length - 1;
          if (last) { this.finished = true; this.flash('End of trip — well done!', 8); }
          else { this.stopIdx++; this.skipVirtual(); this.flash('Doors closed — clear to depart', 2.5); }
        }
      }
    }
    if (this.doors === 'open' && this.boarding && !this.boarding.done) {
      const b = this.boarding;
      const flow = this.dyn.flow * dt;
      if (b.off < b.targetOff) { const k = Math.min(b.targetOff - b.off, flow); b.off += k; this.onboard -= k; }
      else if (b.on < b.target) { const k = Math.min(b.target - b.on, flow); b.on += k; this.onboard += k; }
      else b.done = true;
    }

    if (vehicles) this.checkAhead(vehicles);

    // integrate in sub-steps
    const h = 0.05;
    let rest = dt;
    while (rest > 1e-6) {
      const d = Math.min(h, rest);
      rest -= d;
      this.integrate(d);
    }

    // missed stop: passed well beyond tolerance
    const ns = this.nextStop;
    if (ns && !this.reverse && this.s > ns.dist + this.dyn.tol + 25 && this.doors === 'closed') {
      this.flash(`Skipped ${ns.name}`, 4);
      this.stopIdx++;
      this.skipVirtual();
    }
    if (this.s >= this.path.length - 0.5 && this.v < 0.1 && !this.nextStop) this.finished = true;
  }

  private integrate(dt: number) {
    const dyn = this.dyn;
    const v = this.v;
    let a = 0;
    const doorsClosed = this.doors === 'closed';
    let notch = this.notch;
    // ATC: emergency brake when running into the train ahead
    this.atcTrip = false;
    if (this.trainAhead !== null && !this.reverse) {
      const need = (v * v) / (2 * dyn.brake) + 15;
      if (this.trainAhead < need && v > 0.5) { notch = EB; this.atcTrip = true; }
    }
    // ATC overspeed: full service brake above limit + 6 km/h
    this.graceT = Math.max(0, this.graceT - dt);
    this.overspeed = this.graceT <= 0 && v > this.currentLimit() + kmh(6);
    if (this.overspeed) notch = Math.min(notch, -MAX_NOTCH);
    if (notch > 0 && doorsClosed) {
      const f = notch / MAX_NOTCH;
      a = dyn.accel * f * Math.min(1, dyn.baseSpeed / Math.max(v, 0.1));
      if (this.reverse && v > kmh(10)) a = 0;
    } else if (notch < 0) {
      const b = notch === EB ? dyn.emergency : dyn.brake * (-notch / MAX_NOTCH);
      a = -b;
    }
    if (!doorsClosed) a = Math.min(a, -dyn.brake); // door brake
    // running resistance + grade (grade sign flips in reverse)
    const pitch = this.path.pose(this.s, 8, _pose).pitch;
    const grade = 9.81 * Math.sin(pitch) * (this.reverse ? -1 : 1);
    const res = 0.006 + 0.00012 * v * v;
    let nv = v + (a - (v > 0 ? res : 0) - grade) * dt;
    if (a < 0 && nv < 0) nv = 0; // brakes hold
    if (nv < 0) nv = 0;
    if (!doorsClosed && nv < 0.05) nv = 0;
    this.v = nv;
    this.a = (nv - v) / dt;
    this.s += (this.reverse ? -1 : 1) * nv * dt;
    if (this.s < 0) { this.s = 0; this.v = 0; }
    if (this.s > this.path.length) { this.s = this.path.length; this.v = 0; this.flash('End of track'); }
  }

  /** Nearest scheduled vehicle ahead on (approximately) our path. */
  private checkAhead(vb: VehicleBuffers) {
    const samples = 160, step = 20;
    const s0 = this.s;
    const p = _p;
    let best = Infinity;
    const L2 = this.dyn.length / 2;
    for (let i = 0; i < vb.count; i++) {
      if (vb.trip[i] === this.info.trip) continue;
      if (vb.route[i] !== this.route) continue;
      if (vb.pattern[i] === this.path.pattern) {
        const g = vb.dist[i] - s0;
        if (g > 0 && g < best) best = g;
        continue;
      }
      // other patterns of the same route: match position to our path ahead
      for (let k = 1; k <= samples; k++) {
        const d = k * step;
        if (d > best) break;
        this.path.point(s0 + d, p);
        const dx = vb.x[i] - p[0], dy = vb.y[i] - p[1];
        if (dx * dx + dy * dy < 15 * 15) {
          // same direction?
          const h = this.path.pose(s0 + d, 6, _pose2).heading;
          if (Math.cos(h - vb.heading[i]) > 0.5 && d < best) best = d;
          break;
        }
      }
    }
    if (best === Infinity || best > samples * step) { this.trainAhead = null; this.aspect = 'green'; return; }
    // tail of the train ahead, our front
    const gap = best - 2 * L2;
    this.trainAhead = gap;
    const brakeDist = (this.v * this.v) / (2 * this.dyn.brake);
    this.aspect = gap < 80 + brakeDist * 0.5 ? 'red' : gap < 300 + brakeDist * 1.5 ? 'yellow' : 'green';
  }

  /** Scheduled time (s) at which the trip is due at distance s. */
  schedTimeAt(s: number): number {
    const st = this.path.stops;
    if (!st.length) return 0;
    if (s <= st[0].dist) return st[0].dep;
    for (let k = 0; k < st.length - 1; k++) {
      const a = st[k], b = st[k + 1];
      if (s <= b.dist) {
        const u = b.dist > a.dist ? (s - a.dist) / (b.dist - a.dist) : 1;
        return a.dep + (b.arr - a.dep) * u;
      }
    }
    return st[st.length - 1].arr;
  }

  deviation(t: number): number {
    return t - this.schedTimeAt(this.s);
  }
}

const _pose = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
const _pose2 = { e: 0, n: 0, z: 0, heading: 0, pitch: 0 };
const _p = [0, 0, 0];

/** 0 off-peak … 1 peak, by time of day (s). */
export function rushFactor(t: number): number {
  const h = (t / 3600) % 24;
  const g = (c: number, w: number) => Math.exp(-((h - c) * (h - c)) / (2 * w * w));
  return Math.min(1, 0.25 + g(8.2, 1.1) + g(17.4, 1.3) * 0.95);
}
