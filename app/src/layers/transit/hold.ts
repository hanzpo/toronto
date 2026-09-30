// Local "hold" for surface transit near the camera. The timetable is analytic,
// so a streetcar or bus would happily drive through the cars queued in front
// of it. Near the focus, each surface vehicle looks ahead along its heading
// for obstacles (traffic-sim cars, red signals, the transit vehicle ahead in
// the same lane). If one is in the way its rendered distance along the shape
// is capped behind it with a smooth IDM-like deceleration; the delay it builds
// up is recovered afterwards at ≤ +20 % of the scheduled speed (never a jump).
// Vehicles far from the focus stay pure-schedule.
import { CAR_STRIDE } from '../../sim/protocol';

/** A surface transit vehicle as other simulations see it (front-centre position). */
export interface GroundVeh {
  e: number;
  n: number;
  /** rad CCW from +E */
  heading: number;
  length: number;
  width: number;
  speed: number;
  trip: number;
  /** rail vehicle (streetcar / LRT) */
  rail?: boolean;
  /** doors open (Toronto: traffic stops behind a streetcar with open doors); undefined = unknown */
  doorsOpen?: boolean;
}

/** Duck-typed obstacle queries of the TrafficLayer (all optional). */
export interface TrafficQueries {
  queryAhead?(e: number, n: number, heading: number, lookahead: number, halfWidth: number): number | null;
  signalAhead?(e: number, n: number, heading: number, lookahead: number): number | null;
}

interface HoldState {
  d: number; // rendered distance along the shape (m, consist centre)
  v: number; // rendered speed (m/s)
  seen: number; // frame stamp
  blocked: number; // seconds continuously blocked
}

export interface HoldInput {
  trip: number;
  sched: number; // scheduled distance (consist centre)
  schedSpeed: number;
  mode: number; // MODE_ID
  length: number;
  width: number;
  /** front-centre position and heading of the vehicle at its current rendered distance */
  e: number; n: number; heading: number;
}

// cruise speed to recover delay, comfortable / max braking (m/s²), per MODE_ID
const CRUISE = [16, 14, 11, 20, 20, 20, 12];
const ACCEL = [1.0, 1.0, 1.1, 0.6, 0.8, 0.5, 1.2];
const BRAKE = 1.6;
const BRAKE_MAX = 4.0;
const MIN_GAP = 2.5; // m kept to the obstacle
const CAR_HALF_LEN = 2.3, CAR_HALF_W = 0.95;
const GIVE_UP = 90; // s: a vehicle blocked this long ignores traffic (failsafe against sim deadlocks)
const CELL = 40;

export class HoldController {
  private states = new Map<number, HoldState>();
  private frame = 0;
  /** traffic cars this frame: e, n, heading per car, bucketed */
  private carE = new Float64Array(0);
  private carN = new Float64Array(0);
  private carCount = 0;
  private grid = new Map<number, number[]>();
  private veh: GroundVeh[] = [];
  private vehGrid = new Map<number, number[]>();
  /** diagnostics */
  held = 0;

  /** Rendered distance for a trip (or the schedule's if it is not held). */
  dist(trip: number, sched: number): number {
    const s = this.states.get(trip);
    return s ? Math.min(s.d, sched) : sched;
  }

  speed(trip: number, schedSpeed: number): number {
    return this.states.get(trip)?.v ?? schedSpeed;
  }

  isHeld(trip: number): boolean {
    return this.states.has(trip);
  }

  clear() {
    this.states.clear();
  }

  /** Start a frame: snapshot the obstacles. `veh` = surface transit vehicles near the focus. */
  begin(traffic: unknown, veh: GroundVeh[]) {
    this.frame++;
    this.veh = veh;
    this.vehGrid.clear();
    veh.forEach((v, i) => bucket(this.vehGrid, v.e, v.n, i));
    this.grid.clear();
    this.carCount = 0;
    const tq = traffic as TrafficQueries | null;
    if (tq && !tq.queryAhead) this.snapshotTraffic(traffic);
  }

  /** fallback when the traffic layer has no queryAhead(): read its car snapshot */
  private snapshotTraffic(traffic: unknown) {
    const snap = (traffic as { snapshot?: () => { f: Float32Array; count: number; oe: number; on: number } | null }).snapshot?.call(traffic);
    if (!snap) return;
    const { f, count, oe, on } = snap;
    if (this.carE.length < count) { this.carE = new Float64Array(count * 2); this.carN = new Float64Array(count * 2); }
    for (let i = 0; i < count; i++) {
      const o = i * CAR_STRIDE;
      const e = f[o] + oe, n = f[o + 1] + on;
      this.carE[i] = e; this.carN[i] = n;
      bucket(this.grid, e, n, i);
    }
    this.carCount = count;
  }

  private carsAhead(e: number, n: number, h: number, look: number, halfW: number): number | null {
    if (!this.carCount) return null;
    const c = Math.cos(h), s = Math.sin(h);
    let best: number | null = null;
    forCells(this.grid, e, n, c, s, look, (i) => {
      const dx = this.carE[i] - e, dy = this.carN[i] - n;
      const along = dx * c + dy * s;
      if (along < -CAR_HALF_LEN || along > look + CAR_HALF_LEN) return;
      const lat = -dx * s + dy * c;
      if (Math.abs(lat) > halfW + CAR_HALF_W) return;
      const d = Math.max(0, along - CAR_HALF_LEN);
      if (best === null || d < best) best = d;
    });
    return best;
  }

  private transitAhead(me: HoldInput, look: number): number | null {
    const c = Math.cos(me.heading), s = Math.sin(me.heading);
    let best: number | null = null;
    forCells(this.vehGrid, me.e, me.n, c, s, look + 40, (i) => {
      const o = this.veh[i];
      if (o.trip === me.trip) return;
      const dh = Math.abs(Math.atan2(Math.sin(o.heading - me.heading), Math.cos(o.heading - me.heading)));
      if (dh > 0.7) return;
      const dx = o.e - me.e, dy = o.n - me.n;
      const along = dx * c + dy * s; // to the other's front
      if (along <= 0.5 || along > look + o.length) return;
      // lateral offset of the other's rear (its front may already be round a corner)
      const re = o.e - Math.cos(o.heading) * o.length, rn = o.n - Math.sin(o.heading) * o.length;
      const rx = re - me.e, ry = rn - me.n;
      const latF = Math.abs(-dx * s + dy * c), latR = Math.abs(-rx * s + ry * c);
      if (Math.min(latF, latR) > (me.width + o.width) * 0.35) return;
      const gap = Math.max(0, Math.min(along - o.length, rx * c + ry * s));
      if (best === null || gap < best) best = gap;
    });
    return best;
  }

  /**
   * Advance one held-or-not vehicle by `dt` sim seconds. Returns the distance
   * to render (≤ the schedule).
   */
  step(inp: HoldInput, dt: number, traffic: TrafficQueries | null): number {
    let st = this.states.get(inp.trip);
    const v0 = st ? st.v : inp.schedSpeed;
    const look = Math.min(90, Math.max(30, (v0 * v0) / (2 * BRAKE) + 25));
    const giveUp = st ? st.blocked > GIVE_UP : false;
    let ob: number | null = null;
    const halfW = inp.width * 0.45;
    if (!giveUp && traffic) {
      if (traffic.queryAhead) {
        try { ob = min(ob, traffic.queryAhead(inp.e, inp.n, inp.heading, look, halfW)); } catch { /* ignore */ }
      } else {
        ob = min(ob, this.carsAhead(inp.e, inp.n, inp.heading, look, halfW));
      }
      if (traffic.signalAhead) {
        try {
          const sg = traffic.signalAhead(inp.e, inp.n, inp.heading, look);
          // only stop for a signal we can still stop for comfortably
          if (sg !== null && (v0 * v0) / (2 * Math.max(sg - 1, 0.1)) < BRAKE_MAX * 0.75) ob = min(ob, sg);
        } catch { /* ignore */ }
      }
    }
    ob = min(ob, this.transitAhead(inp, look));
    const vObs = ob === null ? Infinity : Math.sqrt(2 * BRAKE * Math.max(0, ob - MIN_GAP));
    if (!st) {
      // unobstructed and on schedule: nothing to do
      if (vObs >= inp.schedSpeed - 0.05 || ob === null) return inp.sched;
      st = { d: inp.sched, v: inp.schedSpeed, seen: this.frame, blocked: 0 };
      this.states.set(inp.trip, st);
    }
    st.seen = this.frame;
    const gap = Math.max(0, inp.sched - st.d);
    const catchUp = Math.max(inp.schedSpeed * 1.2, Math.min(CRUISE[inp.mode] ?? 12, inp.schedSpeed + gap * 0.2));
    // never pass the scheduled position: approach it like a stop
    const vGhost = Math.sqrt(2 * BRAKE * gap) + inp.schedSpeed;
    const target = Math.min(catchUp, vGhost, vObs);
    let v = st.v;
    if (target > v) v = Math.min(target, v + (ACCEL[inp.mode] ?? 1) * dt);
    else v = Math.max(target, v - BRAKE_MAX * dt);
    let d = st.d + v * dt;
    if (ob !== null) d = Math.min(d, st.d + Math.max(0, ob - 1)); // never into the obstacle
    d = Math.min(d, inp.sched);
    st.v = (d - st.d) / Math.max(dt, 1e-6);
    if (v < st.v) st.v = v;
    st.d = d;
    st.blocked = vObs < 0.5 ? st.blocked + dt : 0;
    // back on schedule and free: drop the state
    if (inp.sched - st.d < 0.3 && vObs >= inp.schedSpeed && Math.abs(st.v - inp.schedSpeed) < 0.6) {
      this.states.delete(inp.trip);
      return inp.sched;
    }
    return st.d;
  }

  /** Drop states of vehicles not stepped this frame (left the radius / trip ended). */
  end() {
    let held = 0;
    for (const [k, s] of this.states) {
      if (s.seen !== this.frame) this.states.delete(k);
      else held++;
    }
    this.held = held;
  }
}

function min(a: number | null, b: number | null | undefined): number | null {
  if (b === null || b === undefined || !Number.isFinite(b)) return a;
  return a === null ? b : Math.min(a, b);
}

function key(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768);
}

function bucket(g: Map<number, number[]>, e: number, n: number, i: number) {
  const k = key(Math.floor(e / CELL), Math.floor(n / CELL));
  let a = g.get(k);
  if (!a) g.set(k, (a = []));
  a.push(i);
}

/** visit items in cells covering the segment from (e, n) along (c, s) for `len` m */
function forCells(g: Map<number, number[]>, e: number, n: number, c: number, s: number, len: number, f: (i: number) => void) {
  if (!g.size) return;
  const e2 = e + c * len, n2 = n + s * len;
  const x0 = Math.floor((Math.min(e, e2) - 6) / CELL), x1 = Math.floor((Math.max(e, e2) + 6) / CELL);
  const y0 = Math.floor((Math.min(n, n2) - 6) / CELL), y1 = Math.floor((Math.max(n, n2) + 6) / CELL);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const a = g.get(key(x, y));
      if (a) for (const i of a) f(i);
    }
  }
}
