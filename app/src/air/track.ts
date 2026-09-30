// Analytic flight tracks. A movement (arrival or departure) is turned into a
// time-stamped polyline (E, N, elev, yaw, pitch, bank, speed, phase, flags)
// once, then sampled at any sim time — scrubbing needs no simulation state.
//
// Arrival: enter ~180 km out on the origin's bearing (via a corner fix at big
// airports) -> turn onto a straight final -> 3° glideslope -> flare ->
// touchdown -> decelerate on the runway -> exit -> taxi to the stand.
// Departure: pushback + pivot -> taxi to the runway entry -> line up, hold ->
// takeoff roll, rotate -> climb straight out -> turn towards the destination
// -> climb, disappearing ~180 km out.
import type { Airport } from './airport';
import type { RunwayJson, StandJson } from './data';
import type { AircraftSpec } from '../models/aircraft';

export const PH = {
  PARKED: 0, PUSHBACK: 1, TAXI_OUT: 2, HOLD: 3, TAKEOFF: 4, CLIMB: 5, CRUISE: 6,
  DESCENT: 7, APPROACH: 8, LANDING: 9, ROLLOUT: 10, TAXI_IN: 11,
} as const;
export const PHASE_LABEL = ['At gate', 'Pushback', 'Taxi to runway', 'Holding / line-up', 'Takeoff', 'Climb', 'Cruise', 'Descent', 'Approach', 'Landing', 'Landing roll', 'Taxi to gate'];

export const FL_GEAR = 1, FL_LANDING = 2, FL_TAXI = 4, FL_STROBE = 8;

export interface Track {
  n: number;
  t: Float64Array; e: Float64Array; nn: Float64Array; h: Float32Array;
  yaw: Float32Array; pitch: Float32Array; bank: Float32Array; v: Float32Array;
  phase: Uint8Array; flags: Uint8Array;
  t0: number; t1: number;
}

export interface Pose {
  e: number; n: number; h: number; yaw: number; pitch: number; bank: number; v: number; phase: number; flags: number;
}

const DEG = Math.PI / 180;
const G = 9.81;
const EXIT_R = 180000; // tracks start / end this far from the airport (m)

interface GP { x: number; y: number; h: number; vmax: number; dec: number; ph: number }

// ------------------------------------------------------------------ geometry helpers

function filletPath(pts: GP[], radius: number, alat: number): GP[] {
  if (pts.length < 3) return pts;
  const out: GP[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], p = pts[i], b = pts[i + 1];
    const d1x = p.x - a.x, d1y = p.y - a.y, d2x = b.x - p.x, d2y = b.y - p.y;
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    if (l1 < 0.5 || l2 < 0.5) { if (l1 >= 0.5) out.push(p); continue; }
    const u1x = d1x / l1, u1y = d1y / l1, u2x = d2x / l2, u2y = d2y / l2;
    const cross = u1x * u2y - u1y * u2x, dot = u1x * u2x + u1y * u2y;
    const th = Math.atan2(cross, dot); // signed turn
    const ath = Math.abs(th);
    if (ath < 3 * DEG) { out.push(p); continue; }
    let t = radius * Math.tan(ath / 2);
    t = Math.min(t, l1 * 0.48, l2 * 0.48);
    const r = t / Math.tan(ath / 2);
    const sx = p.x - u1x * t, sy = p.y - u1y * t;
    // centre: left normal for left turns
    const s = Math.sign(th);
    const cx = sx - u1y * r * s, cy = sy + u1x * r * s;
    const a0 = Math.atan2(sy - cy, sx - cx);
    const steps = Math.max(2, Math.ceil(ath / (7 * DEG)));
    const vArc = Math.max(2.5, Math.sqrt(alat * r));
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + (th * k) / steps;
      out.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, h: p.h, vmax: Math.min(p.vmax, vArc), dec: p.dec, ph: p.ph });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** speed profile + times along a ground polyline; returns relative times (s) */
function groundTimes(pts: GP[], v0: number, v1: number, acc: number): { t: number[]; v: number[] } {
  const n = pts.length;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const v = pts.map((p) => p.vmax);
  v[0] = Math.min(v[0], v0);
  v[0] = v0;
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * acc * (s[i] - s[i - 1])));
  v[n - 1] = Math.min(v[n - 1], v1);
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * pts[i].dec * (s[i + 1] - s[i])));
  const t = [0];
  for (let i = 1; i < n; i++) {
    const ds = s[i] - s[i - 1];
    const vm = (v[i] + v[i - 1]) / 2;
    t.push(t[i - 1] + (ds < 1e-6 ? 0 : vm > 0.25 ? ds / vm : Math.sqrt((2 * ds) / Math.max(acc, 0.3))));
  }
  return { t, v };
}

/** steer from `start` along `dir` for `straight` m, then turn (radius R) towards targets; stop EXIT_R from centre */
function airPath(sx: number, sy: number, dx: number, dy: number, straight: number, targets: [number, number][], R: number, cx: number, cy: number): [number, number, number][] {
  let px = sx, py = sy;
  let hd = Math.atan2(dy, dx);
  let d = 0, ti = 0;
  const pts: [number, number, number][] = [[px, py, 0]];
  for (let guard = 0; guard < 4000; guard++) {
    const ds = d < 25000 ? 150 : 500;
    if (d >= straight && targets.length) {
      const [tx, ty] = targets[ti];
      const want = Math.atan2(ty - py, tx - px);
      let diff = want - hd;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const mt = ds / R;
      hd += Math.max(-mt, Math.min(mt, diff));
      if (ti < targets.length - 1 && Math.hypot(tx - px, ty - py) < 5000) ti++;
    }
    px += Math.cos(hd) * ds; py += Math.sin(hd) * ds; d += ds;
    pts.push([px, py, d]);
    if (d > straight && Math.hypot(px - cx, py - cy) >= EXIT_R) break;
  }
  return pts;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
function ramp(d: number, pts: [number, number][]): number {
  if (d <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (d <= pts[i][0]) return lerp(pts[i - 1][1], pts[i][1], (d - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]));
  return pts[pts.length - 1][1];
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

// ------------------------------------------------------------------ builder

class Acc {
  t: number[] = []; e: number[] = []; n: number[] = []; h: number[] = [];
  yaw: (number | null)[] = []; v: number[] = []; ph: number[] = []; fl: number[] = [];
  push(t: number, e: number, n: number, h: number, v: number, ph: number, fl: number, yaw: number | null = null) {
    this.t.push(t); this.e.push(e); this.n.push(n); this.h.push(h); this.v.push(v); this.ph.push(ph); this.fl.push(fl); this.yaw.push(yaw);
  }
  finish(): Track {
    // drop non-increasing times
    const keep: number[] = [];
    for (let i = 0; i < this.t.length; i++) if (!keep.length || this.t[i] > this.t[keep[keep.length - 1]] + 1e-3) keep.push(i);
    const n = keep.length;
    const tr: Track = {
      n, t: new Float64Array(n), e: new Float64Array(n), nn: new Float64Array(n), h: new Float32Array(n),
      yaw: new Float32Array(n), pitch: new Float32Array(n), bank: new Float32Array(n), v: new Float32Array(n),
      phase: new Uint8Array(n), flags: new Uint8Array(n), t0: 0, t1: 0,
    };
    keep.forEach((k, i) => {
      tr.t[i] = this.t[k]; tr.e[i] = this.e[k]; tr.nn[i] = this.n[k]; tr.h[i] = this.h[k]; tr.v[i] = this.v[k];
      tr.phase[i] = this.ph[k]; tr.flags[i] = this.fl[k];
    });
    // yaw: explicit where given, else from motion direction (forward)
    const yawIn = keep.map((k) => this.yaw[k]);
    let last = 0;
    for (let i = 0; i < n; i++) {
      if (yawIn[i] !== null) { last = yawIn[i]!; tr.yaw[i] = last; continue; }
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const de = tr.e[b] - tr.e[a], dn = tr.nn[b] - tr.nn[a];
      if (Math.hypot(de, dn) > 0.05) last = Math.atan2(dn, de);
      tr.yaw[i] = last;
    }
    // unwrap
    for (let i = 1; i < n; i++) {
      let d = tr.yaw[i] - tr.yaw[i - 1];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      tr.yaw[i] = tr.yaw[i - 1] + d;
    }
    // pitch (flight path + angle of attack) and bank (coordinated turn)
    const pitch = new Float32Array(n), bank = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const ds = Math.hypot(tr.e[b] - tr.e[a], tr.nn[b] - tr.nn[a]);
      const air = tr.phase[i] >= PH.CLIMB && tr.phase[i] <= PH.LANDING;
      if (!air || ds < 1) continue;
      const gamma = Math.atan2(tr.h[b] - tr.h[a], ds);
      const v = tr.v[i];
      const aoa = tr.phase[i] === PH.CLIMB ? lerp(7.5, 2.5, (v - 75) / 80) * DEG : lerp(5.5, 1.5, (v - 65) / 70) * DEG;
      pitch[i] = gamma + aoa;
      const k = (tr.yaw[b] - tr.yaw[a]) / ds;
      bank[i] = Math.max(-30 * DEG, Math.min(30 * DEG, -Math.atan((v * v * k) / G)));
    }
    // smooth over ±2.5 s so rotation / flare / roll-in are gradual
    const W = 2.5;
    let lo = 0, hi = 0, sp = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      while (hi < n && tr.t[hi] <= tr.t[i] + W) { sp += pitch[hi]; sb += bank[hi]; hi++; }
      while (tr.t[lo] < tr.t[i] - W) { sp -= pitch[lo]; sb -= bank[lo]; lo++; }
      const c = hi - lo;
      tr.pitch[i] = sp / c; tr.bank[i] = sb / c;
    }
    tr.t0 = tr.t[0]; tr.t1 = tr.t[n - 1];
    return tr;
  }
}

export interface MovementCtx {
  ap: Airport;
  rwy: RunwayJson;
  stand: StandJson;
  spec: AircraftSpec;
  noseX: number;
  /** touchdown (arrival) / start of takeoff roll (departure), air-day seconds */
  time: number;
  /** true bearing (deg) towards the other airport */
  bearing: number;
  key: string;
  /** corner-post arrival fixes (big airports) */
  corners: boolean;
}

function rwyVec(r: RunwayJson) {
  const hd = r.hdg * DEG;
  return { ux: Math.sin(hd), uy: Math.cos(hd) };
}

export function standPose(stand: StandJson, noseX: number, h: number): Pose {
  const [hx, hy] = stand.hdg;
  const off = Math.max(2, noseX - 3);
  return { e: stand.pos[0] - hx * off, n: stand.pos[1] - hy * off, h, yaw: Math.atan2(hy, hx), pitch: 0, bank: 0, v: 0, phase: PH.PARKED, flags: FL_GEAR };
}

function rwyElev(r: RunwayJson, along: number) {
  return lerp(r.thr[2], r.end[2], along / r.len);
}

function bearingVec(brgDeg: number) {
  const b = brgDeg * DEG;
  return [Math.sin(b), Math.cos(b)];
}

function cornerFix(ap: Airport, brg: number): [number, number] {
  const q = Math.round((brg - 45) / 90) * 90 + 45;
  const [bx, by] = bearingVec(q);
  return [ap.j.pos[0] + bx * 65000, ap.j.pos[1] + by * 65000];
}

export function buildArrival(m: MovementCtx): Track {
  const { ap, rwy, stand, spec } = m;
  const { ux, uy } = rwyVec(rwy);
  const rnd = hash01(m.key);
  const aim = spec.cls === 'turboprop' ? 230 : 330;
  const tdx = rwy.thr[0] + ux * aim, tdy = rwy.thr[1] + uy * aim;
  const tdh = rwyElev(rwy, aim);
  const vref = spec.vref;
  const dec = spec.cls === 'wide' ? 1.7 : spec.cls === 'turboprop' ? 2.2 : 1.95;

  // ---- ground: rollout -> exit -> taxi -> stand
  const need = aim + (vref * vref - 16 * 16) / (2 * dec) + 80;
  const exits = rwy.exits.filter((x) => Math.abs(x[2]) <= 100);
  let ex = exits.find((x) => x[1] >= need && Math.abs(x[2]) < 60) ?? exits.find((x) => x[1] >= need) ?? exits[exits.length - 1];
  if (!ex) ex = [rwy.entry ?? 0, rwy.len, 90];
  const exitSpeed = Math.abs(ex[2]) < 50 ? 18 : 11;
  const exitNode = ex[0];
  const pts: GP[] = [];
  const A = ap;
  pts.push({ x: tdx, y: tdy, h: tdh, vmax: vref, dec, ph: PH.ROLLOUT });
  // rollout along the centreline to abeam the exit node
  const exAlong = ex[1];
  pts.push({ x: rwy.thr[0] + ux * exAlong, y: rwy.thr[1] + uy * exAlong, h: rwyElev(rwy, exAlong), vmax: exitSpeed, dec: 1.0, ph: PH.TAXI_IN });
  const route = A.route(exitNode, stand.node);
  for (let i = 1; i < route.length; i++) {
    const k = route[i];
    pts.push({ x: A.E[k], y: A.N[k], h: A.H[k], vmax: 11, dec: 1.0, ph: PH.TAXI_IN });
  }
  const park = standPose(stand, m.noseX, A.H[stand.node]);
  pts.push({ x: park.e, y: park.n, h: park.h, vmax: 2.5, dec: 0.6, ph: PH.TAXI_IN });
  const gpts = filletPath(pts, 38, 1.0);
  // the runway part keeps its decel; the rollout phase ends where the speed drops to taxi speed
  const gt = groundTimes(gpts, vref, 0, 0.7);

  // ---- air (built backwards from touchdown)
  const cx = ap.j.pos[0], cy = ap.j.pos[1];
  const [bx, by] = bearingVec(m.bearing);
  const far: [number, number] = [cx + bx * 320000, cy + by * 320000];
  const targets: [number, number][] = m.corners ? [cornerFix(ap, m.bearing), far] : [far];
  const straight = (spec.cls === 'turboprop' ? 11000 : 16000) + rnd * 7000;
  const back = airPath(tdx, tdy, -ux, -uy, straight, targets, spec.cls === 'turboprop' ? 2600 : 3300, cx, cy);
  const gs = Math.tan(3 * DEG);
  const cruise = spec.cls === 'turboprop' ? 7300 : 11000;
  const hOf = (d: number) => {
    if (d < 300) return 300 * gs * Math.pow(d / 300, 1.6);
    if (d < 17000) return d * gs;
    return Math.min(cruise, 17000 * gs + (d - 17000) * 0.042);
  };
  const tp = spec.cls === 'turboprop';
  const vOf = (d: number) => ramp(d, [[0, vref], [5000, vref + 3], [15000, vref + 22], [50000, tp ? 105 : 128], [120000, tp ? 140 : 205]]);
  const air: { t: number; x: number; y: number; h: number; v: number; ph: number }[] = [];
  let tAcc = 0;
  for (let i = 0; i < back.length; i++) {
    const [x, y, d] = back[i];
    if (i > 0) { const ds = d - back[i - 1][2]; tAcc += ds / ((vOf(d) + vOf(back[i - 1][2])) / 2); }
    const hh = hOf(d);
    const ph = d < 1500 ? PH.LANDING : d < 20000 ? PH.APPROACH : PH.DESCENT;
    air.push({ t: -tAcc, x, y, h: tdh + hh, v: vOf(d), ph });
  }

  const acc = new Acc();
  const T = m.time;
  for (let i = air.length - 1; i >= 1; i--) {
    const a = air[i];
    const agl = a.h - tdh;
    const fl = FL_STROBE | (agl < 800 ? FL_GEAR : 0) | (agl < 3000 ? FL_LANDING : 0);
    acc.push(T + a.t, a.x, a.y, a.h, a.v, a.ph, fl);
  }
  for (let i = 0; i < gpts.length; i++) {
    const p = gpts[i];
    const v = gt.v[i];
    const ph = p.ph === PH.ROLLOUT || v > 20 ? PH.ROLLOUT : PH.TAXI_IN;
    const fl = FL_GEAR | (ph === PH.ROLLOUT ? FL_LANDING | FL_STROBE : FL_TAXI);
    acc.push(T + gt.t[i], p.x, p.y, p.h, v, ph, fl);
  }
  return acc.finish();
}

export function buildDeparture(m: MovementCtx): Track {
  const { ap, rwy, stand, spec } = m;
  const A = ap;
  const { ux, uy } = rwyVec(rwy);
  const rnd = hash01(m.key);
  const park = standPose(stand, m.noseX, A.H[stand.node]);

  // ---- ground (relative times from pushback start)
  const acc0: { t: number; x: number; y: number; h: number; v: number; ph: number; fl: number; yaw: number | null }[] = [];
  const sx = A.E[stand.node], sy = A.N[stand.node];
  const pushLen = Math.hypot(sx - park.e, sy - park.n);
  const pushT = 20 + pushLen / 1.3;
  const steps = Math.max(2, Math.ceil(pushLen / 5));
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    // ease in/out
    const tt = f * pushT;
    const g = f * f * (3 - 2 * f);
    acc0.push({ t: tt, x: park.e + (sx - park.e) * g, y: park.n + (sy - park.n) * g, h: lerp(park.h, A.H[stand.node], g), v: 1.3, ph: PH.PUSHBACK, fl: FL_GEAR, yaw: park.yaw });
  }
  const entry = rwy.entry ?? A.route(stand.node, stand.node)[0];
  const route = A.route(stand.node, entry);
  const pts: GP[] = [];
  for (const k of route) pts.push({ x: A.E[k], y: A.N[k], h: A.H[k], vmax: 11, dec: 0.8, ph: PH.TAXI_OUT });
  // line-up point on the centreline
  const ex = A.E[entry] - rwy.thr[0], ey = A.N[entry] - rwy.thr[1];
  const along = Math.max(0, ex * ux + ey * uy) + 35;
  const lx = rwy.thr[0] + ux * along, ly = rwy.thr[1] + uy * along;
  pts.push({ x: lx, y: ly, h: rwyElev(rwy, along), vmax: 3, dec: 0.8, ph: PH.TAXI_OUT });
  const gpts = filletPath(pts, 35, 1.0);
  const gt = groundTimes(gpts, 0, 0, 0.6);
  // pivot from the pushback heading to the first taxi direction
  const firstYaw = gpts.length > 1 ? Math.atan2(gpts[1].y - gpts[0].y, gpts[1].x - gpts[0].x) : park.yaw;
  let dyaw = firstYaw - park.yaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  const pivotT = 8 + Math.abs(dyaw) * 12;
  const t1 = pushT + 5;
  for (let k = 1; k <= 6; k++) {
    const f = k / 6;
    acc0.push({ t: t1 + f * pivotT, x: sx, y: sy, h: A.H[stand.node], v: 0, ph: PH.PUSHBACK, fl: FL_GEAR, yaw: park.yaw + dyaw * f * f * (3 - 2 * f) });
  }
  const t2 = t1 + pivotT + 25; // engine start / taxi clearance
  for (let i = 0; i < gpts.length; i++) {
    const p = gpts[i];
    acc0.push({ t: t2 + gt.t[i], x: p.x, y: p.y, h: p.h, v: gt.v[i], ph: PH.TAXI_OUT, fl: FL_GEAR | FL_TAXI, yaw: null });
  }
  const tLined = t2 + gt.t[gt.t.length - 1];
  const hold = 25 + rnd * 30;
  const rwyYaw = Math.atan2(uy, ux);
  acc0.push({ t: tLined + hold, x: lx, y: ly, h: rwyElev(rwy, along), v: 0, ph: PH.HOLD, fl: FL_GEAR | FL_STROBE | FL_LANDING, yaw: rwyYaw });
  const groundDur = tLined + hold;

  // ---- takeoff roll (t = 0 at brake release)
  const a = spec.cls === 'wide' ? 1.75 : spec.cls === 'turboprop' ? 2.3 : 2.05;
  const vlof = spec.vr + 4;
  const roll: typeof acc0 = [];
  const tRoll = vlof / a;
  for (let k = 1; k <= 24; k++) {
    const tt = (k / 24) * tRoll;
    const s = 0.5 * a * tt * tt;
    const al = along + s;
    roll.push({ t: tt, x: lx + ux * s, y: ly + uy * s, h: rwyElev(rwy, Math.min(al, rwy.len)), v: a * tt, ph: PH.TAKEOFF, fl: FL_GEAR | FL_LANDING | FL_STROBE, yaw: rwyYaw });
  }
  const sLof = 0.5 * a * tRoll * tRoll;
  const lofx = lx + ux * sLof, lofy = ly + uy * sLof;
  const lofh = rwyElev(rwy, Math.min(along + sLof, rwy.len));

  // ---- climb out
  const cx = ap.j.pos[0], cy = ap.j.pos[1];
  const [bx, by] = bearingVec(m.bearing);
  const straight = 4500 + rnd * 3500;
  const path = airPath(lofx, lofy, ux, uy, straight, [[cx + bx * 320000, cy + by * 320000]], spec.cls === 'turboprop' ? 2600 : 3300, cx, cy);
  const tp = spec.cls === 'turboprop';
  const cruise = tp ? 7300 : 11000;
  const hOf = (d: number) => Math.min(cruise, d < 12000 ? d * 0.085 : d < 45000 ? 1020 + (d - 12000) * 0.055 : 2835 + (d - 45000) * 0.04);
  const vOf = (d: number) => ramp(d, [[0, vlof], [3000, tp ? 75 : 88], [15000, tp ? 100 : 128], [100000, tp ? 150 : 210]]);
  let tAcc = tRoll;
  const air: typeof acc0 = [];
  for (let i = 1; i < path.length; i++) {
    const [x, y, d] = path[i];
    tAcc += (d - path[i - 1][2]) / ((vOf(d) + vOf(path[i - 1][2])) / 2);
    const hh = hOf(d);
    const fl = FL_STROBE | (hh < 250 ? FL_GEAR : 0) | (hh < 3000 ? FL_LANDING : 0);
    air.push({ t: tAcc, x, y, h: lofh + hh, v: vOf(d), ph: hh > 7000 && hh >= cruise - 50 ? PH.CRUISE : PH.CLIMB, fl, yaw: null });
  }

  const acc = new Acc();
  const T = m.time;
  for (const p of acc0) acc.push(T - groundDur + p.t, p.x, p.y, p.h, p.v, p.ph, p.fl, p.yaw);
  for (const p of roll) acc.push(T + p.t, p.x, p.y, p.h, p.v, p.ph, p.fl, p.yaw);
  for (const p of air) acc.push(T + p.t, p.x, p.y, p.h, p.v, p.ph, p.fl, p.yaw);
  return acc.finish();
}

/** sample a track at time t (clamped) */
export function sampleTrack(tr: Track, t: number, out: Pose): Pose {
  const T = tr.t;
  let lo = 0, hi = tr.n - 1;
  if (t <= T[0]) hi = 0;
  else if (t >= T[hi]) lo = hi;
  else {
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  }
  const f = hi === lo ? 0 : (t - T[lo]) / (T[hi] - T[lo]);
  out.e = tr.e[lo] + (tr.e[hi] - tr.e[lo]) * f;
  out.n = tr.nn[lo] + (tr.nn[hi] - tr.nn[lo]) * f;
  out.h = tr.h[lo] + (tr.h[hi] - tr.h[lo]) * f;
  out.yaw = tr.yaw[lo] + (tr.yaw[hi] - tr.yaw[lo]) * f;
  out.pitch = tr.pitch[lo] + (tr.pitch[hi] - tr.pitch[lo]) * f;
  out.bank = tr.bank[lo] + (tr.bank[hi] - tr.bank[lo]) * f;
  out.v = tr.v[lo] + (tr.v[hi] - tr.v[lo]) * f;
  out.phase = tr.phase[f < 0.5 ? lo : hi];
  out.flags = tr.flags[f < 0.5 ? lo : hi];
  return out;
}
