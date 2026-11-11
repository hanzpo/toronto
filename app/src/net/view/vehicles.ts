import * as THREE from 'three/webgpu';
import { carLowGeometries, carPalette, carVariantsForKind, pedestrianGeometries, shirtPalette } from '../../layers/traffic/models';
import { CarPools } from '../../layers/transit/pools';
import { layoutFor, type ConsistLayout } from '../../layers/transit/consist';
import type { Mode, RouteMeta } from '../../transit';
import type { Anchor } from '../../engine/types';
import { Pool, carMaterial, hash01, packCar, packPed, pedMaterial } from './fleet';

const HEAD = 7;
const CAR = 0, BUS = 1, TRAM = 2, TRAIN = 3, PED = 4;
const DELAY = 90;
const MAX_CARS = 3000, MAX_PEDS = 4000;

interface Body { kind: number; variant: number; trip: number; v: number; flags: number; pts: Float32Array }
interface Frame { t: number; bodies: Map<number, Body> }

export interface TripMeta { mode: Mode; route: RouteMeta | undefined; color: THREE.Color }

function parse(t: number, f: Float32Array): Frame {
  const bodies = new Map<number, Body>();
  let i = 0;
  while (i + HEAD <= f.length) {
    const n = f[i + 6];
    const body: Body = { kind: f[i + 1], variant: f[i + 2], trip: f[i + 3], v: f[i + 4], flags: f[i + 5], pts: f.subarray(i + HEAD, i + HEAD + n * 3) };
    bodies.set(f[i], body);
    i += HEAD + n * 3;
  }
  return { t, bodies };
}

export class NetVehicles {
  readonly group = new THREE.Group();
  private frames: Frame[] = [];
  private cars: Pool[] = [];
  private carsLo: Pool[] = [];
  private kindVariants: number[][] = [];
  private peds: Pool[] = [];
  private consists = new CarPools();
  private phase = new Map<number, number>();
  private tmp = new Float32Array(600);
  private white = new THREE.Color(1, 1, 1);

  constructor() {
    this.group.name = 'net-vehicles';
    const cm = carMaterial();
    for (let k = 0; k < 6; k++) {
      const idx: number[] = [];
      for (const v of carVariantsForKind(k)) {
        idx.push(this.cars.length);
        this.cars.push(new Pool(packCar(v.geometry()), cm, MAX_CARS, this.group, `cars-${v.key}`));
      }
      this.kindVariants.push(idx);
    }
    for (const [k, g] of carLowGeometries().entries()) {
      const p = new Pool(packCar(g), cm, MAX_CARS, this.group, `carsLo-${k}`);
      p.mesh.castShadow = false;
      this.carsLo.push(p);
    }
    const pm = pedMaterial();
    for (const [i, g] of pedestrianGeometries().entries()) {
      const p = new Pool(packPed(g), pm, MAX_PEDS, this.group, `peds-${i}`, 3);
      p.mesh.castShadow = false;
      this.peds.push(p);
    }
    this.group.add(this.consists.group);
  }

  push(t: number, agents: Float32Array) {
    this.frames.push(parse(t, agents));
    while (this.frames.length > 4) this.frames.shift();
  }

  update(now: number, anchor: Anchor, camE: number, camN: number, dt: number, meta: (trip: number) => TripMeta | null) {
    const rt = now - DELAY;
    const F = this.frames;
    if (!F.length) return;
    let f0 = F[0], f1 = F[F.length - 1];
    for (let i = 0; i < F.length - 1; i++) if (F[i].t <= rt && F[i + 1].t >= rt) { f0 = F[i]; f1 = F[i + 1]; break; }
    const a = f1.t > f0.t ? Math.max(0, Math.min(1, (rt - f0.t) / (f1.t - f0.t))) : 1;
    const ax = anchor.origin.x, az = anchor.origin.z;
    this.group.position.set(ax, 0, az);
    for (const p of this.cars) p.count = 0;
    for (const p of this.carsLo) p.count = 0;
    for (const p of this.peds) p.count = 0;
    this.consists.begin();
    const seen = new Set<number>();
    for (const [id, b1] of f1.bodies) {
      const b0 = f0.bodies.get(id);
      const n = b1.pts.length / 3;
      if (this.tmp.length < n * 3) this.tmp = new Float32Array(n * 3);
      const P = this.tmp;
      if (b0 && b0.pts.length === b1.pts.length && a < 1) {
        for (let k = 0; k < n * 3; k++) P[k] = b0.pts[k] + (b1.pts[k] - b0.pts[k]) * a;
      } else P.set(b1.pts);
      const x0 = P[0], y0 = P[1];
      const d = Math.hypot(x0 - camE, y0 - camN);
      if (b1.kind === CAR) {
        const fx = P[0], fy = P[1], fz = P[2], bx = P[3], by = P[4], bz = P[5];
        const h = Math.atan2(fy - by, fx - bx), L = Math.hypot(fx - bx, fy - by) || 1;
        const pitch = Math.atan2(fz - bz, L);
        const cx = (fx + bx) / 2, cy = (fy + by) / 2, cz = (fz + bz) / 2;
        const vars = this.kindVariants[(b1.variant | 0) % 6];
        const hv = hash01(id);
        const pool = d > 220 ? this.carsLo[(b1.variant | 0) % 6] : this.cars[vars[Math.floor(hv * vars.length)]];
        this.put(pool, cx - ax, cz, -cy - az, h, pitch, carPalette[Math.floor(hash01(id * 7 + 3) * carPalette.length)], b1.flags);
        continue;
      }
      if (b1.kind === PED) {
        if (d > 350) continue;
        const h = Math.atan2(P[1] - P[4], P[0] - P[3]);
        const ph = (this.phase.get(id) ?? hash01(id) * 6.28) + dt * b1.v * 3.6;
        this.phase.set(id, ph);
        seen.add(id);
        const pool = this.peds[Math.floor(hash01(id * 3 + 1) * this.peds.length)];
        const k = this.put(pool, P[0] - ax, P[2], -P[1] - az, h, 0, shirtPalette[Math.floor(hash01(id * 5) * shirtPalette.length)], 0);
        if (k >= 0 && pool.extra) { const e = pool.extra.array as Float32Array; e[k * 3] = ph; e[k * 3 + 1] = h; e[k * 3 + 2] = b1.v > 0.2 ? 1 : 0; }
        continue;
      }
      const m = b1.trip >= 0 ? meta(b1.trip) : null;
      const mode: Mode = m?.mode ?? (b1.kind === BUS ? 'bus' : b1.kind === TRAM ? 'streetcar' : b1.variant === 1 ? 'subway' : 'commuter_rail');
      const lay = layoutFor(mode, m?.route);
      this.placeConsist(lay, P, n, ax, az, d > 400, m?.color ?? this.white, b1.flags);
    }
    for (const id of this.phase.keys()) if (!seen.has(id)) this.phase.delete(id);
    for (const p of this.cars) p.commit();
    for (const p of this.carsLo) p.commit();
    for (const p of this.peds) p.commit();
    this.consists.commit();
    void TRAIN;
  }

  private put(pool: Pool, x: number, y: number, z: number, h: number, pitch: number, color: THREE.Color, flags: number): number {
    if (pool.count >= (pool.mesh.instanceMatrix.count)) return -1;
    const k = pool.count++;
    const ch = Math.cos(h), sh = Math.sin(h), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const m = pool.mesh.instanceMatrix.array as Float32Array;
    const o = k * 16;
    m[o] = ch * cp; m[o + 1] = sp; m[o + 2] = -sh * cp; m[o + 3] = 0;
    m[o + 4] = -ch * sp; m[o + 5] = cp; m[o + 6] = sh * sp; m[o + 7] = 0;
    m[o + 8] = sh; m[o + 9] = 0; m[o + 10] = ch; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    const c = pool.col.array as Float32Array;
    c[k * 4] = color.r; c[k * 4 + 1] = color.g; c[k * 4 + 2] = color.b; c[k * 4 + 3] = flags;
    return k;
  }

  private at(P: Float32Array, n: number, s: number, out: number[]) {
    const step = 3;
    const f = Math.max(0, Math.min(n - 1.001, s / step));
    const i = Math.floor(f), t = f - i;
    out[0] = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t;
    out[1] = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t;
    out[2] = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t;
  }

  private placeConsist(lay: ConsistLayout, P: Float32Array, n: number, ax: number, az: number, low: boolean, color: THREE.Color, flags: number) {
    const fp = [0, 0, 0], rp = [0, 0, 0];
    for (let i = 0; i < lay.cars.length; i++) {
      const c = lay.centre[i];
      const half = lay.cars[i].size[0] / 2;
      const pf = lay.pivF[i] || half * 0.7, pr = lay.pivR[i] || -half * 0.7;
      this.at(P, n, c - pf, fp);
      this.at(P, n, c - pr, rp);
      const h = Math.atan2(fp[1] - rp[1], fp[0] - rp[0]);
      const L = Math.hypot(fp[0] - rp[0], fp[1] - rp[1]) || 1;
      const pitch = Math.atan2(fp[2] - rp[2], L);
      const mx = (fp[0] + rp[0]) / 2, my = (fp[1] + rp[1]) / 2, mz = (fp[2] + rp[2]) / 2;
      const off = (pf + pr) / 2;
      const cx = mx - Math.cos(h) * off, cy = my - Math.sin(h) * off;
      this.consists.add(lay.cars[i], low, cx - ax, mz, -cy - az, h, pitch, color, flags | (i === 0 ? 16 : 0));
    }
  }

  dispose() {
    this.consists.dispose();
    this.group.removeFromParent();
  }
}

export interface BodyPose { id: number; kind: number; e: number; n: number; z: number; h: number; len: number }

export function bodies(f: Float32Array): BodyPose[] {
  const out: BodyPose[] = [];
  let i = 0;
  while (i + HEAD <= f.length) {
    const n = f[i + 6], p = i + HEAD, q = p + (n - 1) * 3;
    const len = Math.hypot(f[p] - f[q], f[p + 1] - f[q + 1]);
    out.push({ id: f[i], kind: f[i + 1], e: (f[p] + f[q]) / 2, n: (f[p + 1] + f[q + 1]) / 2, z: f[p + 2], h: Math.atan2(f[p + 1] - f[q + 1], f[p] - f[q]), len: Math.max(len, 0.5) });
    i += HEAD + n * 3;
  }
  return out;
}

export function transitSpans(f: Float32Array): { trip: number; ae: number; an: number; be: number; bn: number; z: number }[] {
  const out: { trip: number; ae: number; an: number; be: number; bn: number; z: number }[] = [];
  let i = 0;
  while (i + HEAD <= f.length) {
    const n = f[i + 6], p = i + HEAD, q = p + (n - 1) * 3, trip = f[i + 3];
    if (trip >= 0 && f[i + 1] !== 0 && f[i + 1] !== 4) out.push({ trip, ae: f[p], an: f[p + 1], be: f[q], bn: f[q + 1], z: Math.max(f[p + 2], f[q + 2]) + 2 });
    i += HEAD + n * 3;
  }
  return out;
}
