// Articulated consist placement: every car / module of a train, streetcar or
// articulated bus is placed individually along the pattern shape by distance,
// oriented by the chord between its two pivot points (bogies / axles, or the
// module's own ends for suspended / single-truck articulated modules), so
// consists bend around curves like the real thing.
import { consistFor, consistLength, type CarSpec, type ConsistSpec } from '../../models/consists';
import type { Mode, PatternShape, RouteMeta } from '../../transit';

export interface ConsistLayout {
  spec: ConsistSpec;
  cars: CarSpec[];
  /** total length (m) */
  length: number;
  /** per car: distance from the consist front to the car centre (m) */
  centre: Float32Array;
  /** per car: pivot offsets from the car centre along +x (m): rear, front */
  pivR: Float32Array;
  pivF: Float32Array;
  width: number;
}

const layouts = new Map<string, ConsistLayout>();

export function layoutFor(mode: Mode, route: RouteMeta | undefined): ConsistLayout {
  const key = `${mode}|${route?.agency ?? ''}|${route?.short ?? ''}`;
  let l = layouts.get(key);
  if (l) return l;
  const spec = consistFor(mode, route ? { agency: route.agency, short: route.short } : undefined);
  const n = spec.cars.length;
  const centre = new Float32Array(n), pivR = new Float32Array(n), pivF = new Float32Array(n);
  let x = 0;
  let width = 0;
  spec.cars.forEach((c, i) => {
    const [L, , W] = c.size;
    width = Math.max(width, W);
    centre[i] = x + L / 2;
    x += L + (spec.gaps[i] ?? 0);
    const b = c.bogies;
    if (b && b[1] - b[0] > 1) {
      pivR[i] = b[0]; pivF[i] = b[1];
    } else {
      // suspended module / single truck: the articulation joints at its ends steer it
      pivR[i] = -L / 2; pivF[i] = L / 2;
    }
  });
  l = { spec, cars: spec.cars, length: consistLength(spec), centre, pivR, pivF, width };
  layouts.set(key, l);
  return l;
}

/** Surface height at (e, n) — the rendered terrain. */
export type GroundFn = (e: number, n: number) => number;

/** Snap near-grade shape heights onto the rendered surface; keep bridges/tunnels. */
export function surfaceZ(z: number, g: number): number {
  const d = Math.abs(z - g);
  if (d <= 2.5) return g;
  if (d >= 3.5) return z;
  const w = d - 2.5; // blend 2.5..3.5 m so a portal ramp does not step
  return g + (z - g) * w;
}

/** One placed car: bottom-centre position, heading (rad CCW from +E), pitch. */
export interface CarPose { e: number; n: number; z: number; heading: number; pitch: number }

const _p = [0, 0, 0], _q = [0, 0, 0], _t = [0, 0];

/**
 * Pose of car i of `lay` whose consist front is at distance `front` along
 * `shape`. `dir` = +1 normally (-1 for a consist running backwards along the
 * path). `lat` = lateral offset (m) to the right of the direction of travel.
 */
export function placeCar(shape: PatternShape, lay: ConsistLayout, i: number, front: number, ground: GroundFn | null, out: CarPose, dir = 1, lat = 0): CarPose {
  const sc = front - dir * lay.centre[i];
  const sr = sc + dir * lay.pivR[i];
  const sf = sc + dir * lay.pivF[i];
  const a = shape.point(sr, _p);
  const b = shape.point(sf, _q);
  if (lat) {
    // lateral offset to the right of travel (buses: lane centre instead of the road centreline)
    const k = lat * dir;
    shape.direction(sr, _t); a[0] += _t[1] * k; a[1] -= _t[0] * k;
    shape.direction(sf, _t); b[0] += _t[1] * k; b[1] -= _t[0] * k;
  }
  let za = a[2], zb = b[2];
  if (ground) {
    za = surfaceZ(za, ground(a[0], a[1]));
    zb = surfaceZ(zb, ground(b[0], b[1]));
  }
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const hd = Math.hypot(dx, dy);
  // body centre on the pivot chord (car-local x = 0)
  const span = lay.pivF[i] - lay.pivR[i];
  const u = span > 1e-6 ? -lay.pivR[i] / span : 0.5;
  out.e = a[0] + dx * u;
  out.n = a[1] + dy * u;
  out.z = za + (zb - za) * u;
  if (hd > 1e-4) out.heading = Math.atan2(dy, dx);
  out.pitch = hd > 1e-4 ? Math.atan2(zb - za, hd) : 0;
  return out;
}

/** Right-of-centreline offset per MODE_ID: GTFS bus shapes follow road centrelines. */
export const LANE_OFFSET = [0, 0, 0, 0, 0, 0, 1.8];
