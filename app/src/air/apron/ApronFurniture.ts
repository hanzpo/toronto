// Apron furniture for one airport (docs/AIR.md "Apron"): passenger boarding bridges that
// dock at the forward left door(s) of the aircraft parked on their stand and retract when
// it leaves, ground support equipment (staged in the stand's equipment box, plus a
// turnaround set around every parked aircraft and a tug during pushback) and floodlight
// masts with their night glow / light pools. All instanced: ~6 bridge draws, 7 GSE draws,
// 1 mast draw, 2 night-only draws.
//
// Coordinates are relative to the airport origin (three: x = E - E0, z = -(N - N0)), like
// the surface meshes; the group sits at the origin.
import * as THREE from 'three/webgpu';
import {
  float, vec3, vec4, uv, length, smoothstep, instancedBufferAttribute, cameraPosition, modelWorldMatrix, min, max, positionGeometry,
} from 'three/tsl';
import type { FrameContext } from '../../engine/types';
import { U } from '../../render/uniforms';
import { AIRCRAFT, aircraftModel } from '../../models/aircraft';
import { PH } from '../track';
import type { AirSystem } from '../AirSystem';
import {
  GSE_KINDS, gseGeometry, tunnelGeometry, linkGeometry, rotundaGeometry, cabGeometry, legsGeometry, bogieGeometry,
  mastGeometry, apronMaterial, BRIDGE_FLOOR, MAST_H, type GseKind,
} from './models';

export interface ApronData {
  icao: string | null;
  /** 9 floats per bridge: rotunda x, ground h, z · parked cab x, z · stand · door · facade x, z */
  jb: Float32Array;
  /** 5 floats: x, ground h, z, yaw (rad, CCW from +E), kind */
  gse: Float32Array;
  /** 3 floats: x, ground h, z */
  mast: Float32Array;
  /** service-road centrelines (x, h, z per vertex) for moving GSE */
  paths: Float32Array[];
  origin: [number, number];
}

type Mover = { path: number; speed: number; phase: number; kind: 'train' | 'fuel' | 'cater' | 'belt' | 'push'; carts: number };
type Path = { xyz: Float32Array; cum: Float32Array; L: number };
type Placed = { k: GseKind; x: number; y: number; z: number; yaw: number };

const SERVICE_MAX = 64; // parked aircraft with a turnaround set drawn at once
const DOCK_RATE = 1 / 45; // bridge travel: full stow ↔ dock in 45 s (sim)

interface Bridge {
  rx: number; gh: number; rz: number;
  sx: number; sz: number;
  stand: number; door: number;
  fx: number; fz: number;
  /** 0 parked … 1 docked */
  k: number;
  /** docking target (three x, z of the door; sill height; outward normal of the fuselage) */
  tx: number; tz: number; th: number; nx: number; nz: number;
  has: boolean;
  dirty: boolean;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX');
const _p = new THREE.Vector3(), _s = new THREE.Vector3();

function inst(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, name: string, shadow = true): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  m.count = 0;
  m.name = name;
  m.castShadow = shadow;
  m.receiveShadow = true;
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return m;
}

function setM(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, yaw: number, pitch = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(0, yaw, pitch, 'YZX');
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  m.setMatrixAt(i, _m);
}

let shared: {
  mat: THREE.Material; gse: Record<GseKind, THREE.BufferGeometry>;
  tunnel: THREE.BufferGeometry; link: THREE.BufferGeometry; rot: THREE.BufferGeometry; cab: THREE.BufferGeometry;
  legs: THREE.BufferGeometry; bogie: THREE.BufferGeometry; mast: THREE.BufferGeometry;
} | null = null;
function assets() {
  if (!shared) {
    const gse = {} as Record<GseKind, THREE.BufferGeometry>;
    for (const k of GSE_KINDS) gse[k] = gseGeometry(k);
    shared = {
      mat: apronMaterial('apron-furniture'), gse,
      tunnel: tunnelGeometry(), link: linkGeometry(), rot: rotundaGeometry(), cab: cabGeometry(),
      legs: legsGeometry(), bogie: bogieGeometry(), mast: mastGeometry(),
    };
  }
  return shared;
}

export class ApronFurniture {
  readonly root = new THREE.Group();
  private bridges: Bridge[] = [];
  private bm: Record<'link' | 'rot' | 'tunnel' | 'cab' | 'legs' | 'bogie', THREE.InstancedMesh>;
  private gm: Record<GseKind, THREE.InstancedMesh>;
  private staticN: Record<GseKind, number>;
  private mastMesh: THREE.InstancedMesh | null = null;
  private glow: THREE.Object3D[] = [];
  private siblings: number[][] = [];
  private lastSim = NaN;
  private svcKey = '';
  private service: Placed[] = [];
  private paths: Path[] = [];
  private movers: Mover[] = [];

  private d: ApronData;

  constructor(d: ApronData) {
    this.d = d;
    const A = assets();
    this.root.name = `apron:${d.icao}`;
    const nb = d.jb.length / 9;
    for (let i = 0; i < nb; i++) {
      const o = i * 9;
      const r = d.jb;
      this.bridges.push({
        rx: r[o], gh: r[o + 1], rz: r[o + 2], sx: r[o + 3], sz: r[o + 4], stand: r[o + 5], door: r[o + 6], fx: r[o + 7], fz: r[o + 8],
        k: 0, tx: 0, tz: 0, th: 0, nx: 0, nz: 0, has: false, dirty: true,
      });
    }
    this.bm = {
      link: inst(A.link, A.mat, nb, 'jb-link'), rot: inst(A.rot, A.mat, nb, 'jb-rotunda'), tunnel: inst(A.tunnel, A.mat, nb * 3, 'jb-tunnel'),
      cab: inst(A.cab, A.mat, nb, 'jb-cab'), legs: inst(A.legs, A.mat, nb, 'jb-legs', false), bogie: inst(A.bogie, A.mat, nb, 'jb-bogie', false),
    };
    if (nb) for (const m of Object.values(this.bm)) this.root.add(m);
    // GSE: static staging + turnaround sets
    const ng = d.gse.length / 5;
    const cnt = {} as Record<GseKind, number>;
    for (const k of GSE_KINDS) cnt[k] = 0;
    for (let i = 0; i < ng; i++) cnt[GSE_KINDS[d.gse[i * 5 + 4]] ?? 'tug']++;
    this.staticN = { ...cnt };
    this.setupMovers(d.paths);
    const nMov = this.movers.length;
    const extra: Record<GseKind, number> = { tug: 2, cart: 4, belt: 1, fuel: 1, cater: 1, push: 1, gpu: 0 };
    const extraMov: Record<GseKind, number> = { tug: nMov, cart: nMov * 3, belt: nMov, fuel: nMov, cater: nMov, push: nMov, gpu: 0 };
    this.gm = {} as Record<GseKind, THREE.InstancedMesh>;
    for (const k of GSE_KINDS) {
      this.gm[k] = inst(A.gse[k], A.mat, cnt[k] + extra[k] * SERVICE_MAX + extraMov[k], `gse-${k}`);
      this.root.add(this.gm[k]);
    }
    const fill = {} as Record<GseKind, number>;
    for (const k of GSE_KINDS) fill[k] = 0;
    for (let i = 0; i < ng; i++) {
      const o = i * 5, k = GSE_KINDS[d.gse[o + 4]] ?? 'tug';
      setM(this.gm[k], fill[k]++, d.gse[o], d.gse[o + 1], d.gse[o + 2], d.gse[o + 3]);
    }
    for (const k of GSE_KINDS) { this.gm[k].count = fill[k]; this.gm[k].instanceMatrix.needsUpdate = true; }
    // masts + night glow
    const nm = d.mast.length / 3;
    if (nm) {
      this.mastMesh = inst(A.mast, A.mat, nm, 'apron-masts');
      for (let i = 0; i < nm; i++) setM(this.mastMesh, i, d.mast[i * 3], d.mast[i * 3 + 1], d.mast[i * 3 + 2], (i * 0.7) % Math.PI);
      this.mastMesh.count = nm;
      this.root.add(this.mastMesh);
      this.glow = mastGlow(d.mast);
      for (const g of this.glow) this.root.add(g);
    }
  }

  /** vehicles driving the apron service roads: tug trains, fuel / catering trucks, belt loaders */
  private setupMovers(paths: Float32Array[]) {
    let total = 0;
    for (const xyz of paths) {
      const n = xyz.length / 3;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xyz[i * 3] - xyz[i * 3 - 3], xyz[i * 3 + 2] - xyz[i * 3 - 1]);
      this.paths.push({ xyz, cum, L: cum[n - 1] });
      total += cum[n - 1];
    }
    const want = Math.min(48, Math.round(total / 380));
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < want && this.paths.length; i++) {
      // pick a path weighted by length
      let r = rnd() * total, p = 0;
      while (p < this.paths.length - 1 && r > this.paths[p].L) { r -= this.paths[p].L; p++; }
      const q = rnd();
      const kind: Mover['kind'] = q < 0.55 ? 'train' : q < 0.7 ? 'fuel' : q < 0.8 ? 'cater' : q < 0.9 ? 'belt' : 'push';
      this.movers.push({ path: p, speed: 4.5 + rnd() * 3.5, phase: rnd() * 1e5, kind, carts: 1 + Math.floor(rnd() * 3) });
    }
  }

  /** point on a path at ping-pong arc u (0 … 2L): position + travel direction (three x / z) */
  private sample(p: Path, u: number, out: number[]) {
    const L = p.L;
    u = ((u % (2 * L)) + 2 * L) % (2 * L);
    const fwd = u < L;
    const s = fwd ? u : 2 * L - u;
    let lo = 0, hi = p.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.cum[m] <= s) lo = m; else hi = m; }
    const seg = Math.max(1e-6, p.cum[hi] - p.cum[lo]), t = Math.min(1, Math.max(0, (s - p.cum[lo]) / seg));
    const X = p.xyz;
    const dx = X[hi * 3] - X[lo * 3], dz = X[hi * 3 + 2] - X[lo * 3 + 2], dl = Math.hypot(dx, dz) || 1;
    const sg = fwd ? 1 : -1;
    out[0] = X[lo * 3] + dx * t; out[1] = X[lo * 3 + 1] + (X[hi * 3 + 1] - X[lo * 3 + 1]) * t; out[2] = X[lo * 3 + 2] + dz * t;
    out[3] = (dx / dl) * sg; out[4] = (dz / dl) * sg;
  }

  /** stand siblings (MARS variants share a base number) for bridge docking */
  private sibs(sys: AirSystem): number[][] {
    if (this.siblings.length || !this.d.icao) return this.siblings;
    const ap = sys.airports.get(this.d.icao);
    if (!ap) return this.siblings;
    const base = (r: string) => (/^[A-Z]?\d+[A-Z]$/.test(r) ? r.slice(0, -1) : r);
    const by = new Map<string, number[]>();
    ap.j.stands.forEach((s, i) => { const b = base(s.ref); by.set(b, [...(by.get(b) ?? []), i]); });
    this.siblings = ap.j.stands.map((s) => by.get(base(s.ref)) ?? []);
    return this.siblings;
  }

  update(ctx: FrameContext, sys: AirSystem | null) {
    const night = 1 - ctx.daylight;
    for (const g of this.glow) g.visible = night > 0.05;
    const [ox, on] = this.d.origin;
    // parked / pushing-back aircraft of this airport by stand
    const parked = new Map<number, { e: number; n: number; h: number; yaw: number; type: string; phase: number; key: string }>();
    if (sys && this.d.icao && sys.ready) {
      for (let i = 0; i < sys.count; i++) {
        const pl = sys.planes[i];
        if (pl.icao !== this.d.icao) continue;
        const ph = pl.pose.phase;
        if (ph !== PH.PARKED && ph !== PH.PUSHBACK) continue;
        const R = sys.schedules.get(pl.profile)?.airports[pl.icao]?.rot;
        if (!R) continue;
        parked.set(R.st[pl.rot], { e: pl.pose.e, n: pl.pose.n, h: pl.pose.h, yaw: pl.pose.yaw, type: pl.type, phase: ph, key: pl.key });
      }
    }
    // ---- bridges
    const dtSim = Number.isFinite(this.lastSim) ? (ctx.simMs - this.lastSim) / 1000 : 1e9;
    this.lastSim = ctx.simMs;
    const snap = !(dtSim >= 0 && dtSim < 20);
    const sib = sys ? this.sibs(sys) : [];
    let any = false;
    this.bridges.forEach((b) => {
      let tgt = 0;
      b.has = false;
      const cands = b.stand >= 0 ? (sib[b.stand]?.length ? sib[b.stand] : [b.stand]) : [];
      for (const si of cands) {
        const p = parked.get(si);
        if (!p || p.phase !== PH.PARKED) continue;
        const spec = AIRCRAFT[p.type] ?? AIRCRAFT.A320;
        if (spec.cls === 'turboprop') continue;
        const pDoors = spec.doors.filter((d) => d[2] === 'P').map((d) => d[0]).sort((a, c) => a - c);
        if (b.door === 1 && (spec.cls !== 'wide' || pDoors.length < 2)) continue;
        const dx = pDoors[Math.min(b.door, pDoors.length - 1)] ?? 5;
        const noseX = aircraftModel(p.type).points.noseX;
        const fe = Math.cos(p.yaw), fn = Math.sin(p.yaw);
        const le = -fn, ln = fe;
        const half = spec.fus.w / 2;
        const de = p.e + fe * (noseX - dx) + le * half, dn = p.n + fn * (noseX - dx) + ln * half;
        const tx = de - ox, tz = -(dn - on);
        const reach = Math.hypot(tx - b.rx, tz - b.rz);
        if (reach < 9 || reach > 52) continue;
        // bridges reach a door from ahead of it / beside it on the left, never from behind the wing
        const ve = (b.rx + ox) - de, vn = (on - b.rz) - dn;
        if (ve * le + vn * ln < 0.3 * reach || ve * fe + vn * fn < -0.35 * reach) continue;
        b.tx = tx; b.tz = tz; b.th = p.h + spec.fus.belly + spec.fus.h * 0.4;
        b.nx = le; b.nz = -ln;
        b.has = true;
        tgt = 1;
        break;
      }
      const k0 = b.k;
      b.k = snap ? tgt : tgt > b.k ? Math.min(tgt, b.k + DOCK_RATE * dtSim) : Math.max(tgt, b.k - DOCK_RATE * 1.6 * dtSim);
      if (b.k !== k0 || b.dirty) { b.dirty = false; any = true; }
    });
    if (any) this.layoutBridges();
    // ---- turnaround GSE (rebuilt when the set of parked aircraft changes)
    const key = [...parked.entries()].map(([s, p]) => `${s}:${p.key}:${p.phase}`).join(',');
    if (key !== this.svcKey || [...parked.values()].some((p) => p.phase === PH.PUSHBACK)) {
      this.svcKey = key;
      this.layoutService(parked, ctx);
    }
    this.writeDynamic(ctx.simMs / 1000);
  }

  private layoutBridges() {
    const { link, rot, tunnel, cab, legs, bogie } = this.bm;
    let nl = 0, nt = 0;
    this.bridges.forEach((b, i) => {
      const floor0 = b.gh + BRIDGE_FLOOR;
      // parked cab: along the mapped bridge, slightly retracted, level with the rotunda
      const px = b.rx + (b.sx - b.rx) * 0.88, pz = b.rz + (b.sz - b.rz) * 0.88;
      const pyaw = Math.atan2(-(b.sz - b.rz), b.sx - b.rx);
      const e = b.k * b.k * (3 - 2 * b.k); // smoothstep travel
      // docked: cab bellows (local x = 2.0) against the fuselage side at the door
      const dcx = b.tx + b.nx * 2.05, dcz = b.tz + b.nz * 2.05;
      const dyaw = Math.atan2(b.nz, -b.nx); // local +x points into the fuselage (-n)
      const has = b.has || b.k > 0;
      const cx = has ? px + (dcx - px) * e : px, cz = has ? pz + (dcz - pz) * e : pz;
      const cfloor = has ? floor0 - 0.6 + (b.th - (floor0 - 0.6)) * e : floor0 - 0.6;
      let cyaw = pyaw;
      if (has) { let dy = dyaw - pyaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); cyaw = pyaw + dy * e; }
      setM(cab, i, cx, cfloor, cz, cyaw);
      // tunnel: rotunda edge → cab pivot (0.9 m behind the cab centre)
      const qx = cx - Math.cos(cyaw) * 0.9, qz = cz + Math.sin(cyaw) * 0.9;
      const dx = qx - b.rx, dz = qz - b.rz;
      const hl = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dz, dx);
      const ax = b.rx + (dx / hl) * 1.9, az = b.rz + (dz / hl) * 1.9;
      const L = Math.max(1, hl - 1.9);
      const dy = cfloor - floor0;
      const pitch = Math.atan2(dy, L);
      const L3 = Math.hypot(L, dy);
      const secs: [number, number, number][] = [[0, 0.42, 1], [0.32, 0.74, 1.06], [0.64, 1.0, 1.12]];
      for (const [s0, s1, sc] of secs) {
        const t0 = s0 * L3 - (s0 > 0 ? 0 : 0.1);
        setM(tunnel, nt++, ax + (dx / hl) * Math.cos(pitch) * t0, floor0 + Math.sin(pitch) * t0 - (sc - 1) * 1.2, az + (dz / hl) * Math.cos(pitch) * t0,
          yaw, pitch, (s1 - s0) * L3 + 0.2, sc, sc);
      }
      // drive column under the outer section
      const tw = 0.82 * L3;
      const wx = ax + (dx / hl) * Math.cos(pitch) * tw, wz = az + (dz / hl) * Math.cos(pitch) * tw;
      const wy = floor0 + Math.sin(pitch) * tw - 0.35;
      setM(bogie, i, wx, b.gh, wz, yaw);
      setM(legs, i, wx, b.gh + 1.3, wz, yaw, 0, 1, Math.max(0.3, wy - b.gh - 1.3), 1);
      setM(rot, i, b.rx, b.gh, b.rz, yaw);
      // fixed link from the terminal facade to the rotunda
      const lx = b.rx - b.fx, lz = b.rz - b.fz, ll = Math.hypot(lx, lz);
      if (ll > 3.5) setM(link, nl++, b.fx, floor0, b.fz, Math.atan2(-lz, lx), 0, ll - 2.0, 1, 1);
    });
    link.count = nl; tunnel.count = nt;
    rot.count = cab.count = legs.count = bogie.count = this.bridges.length;
    for (const m of Object.values(this.bm)) m.instanceMatrix.needsUpdate = true;
  }

  /** turnaround set around each parked aircraft (service side = right), tug on the nose during pushback */
  private layoutService(parked: Map<number, { e: number; n: number; h: number; yaw: number; type: string; phase: number; key: string }>, _ctx: FrameContext) {
    const [ox, on] = this.d.origin;
    this.service = [];
    const put = (k: GseKind, e: number, nn: number, h: number, yaw: number) => {
      this.service.push({ k, x: e - ox, y: h, z: -(nn - on), yaw });
    };
    let sets = 0;
    for (const p of parked.values()) {
      const spec = AIRCRAFT[p.type] ?? AIRCRAFT.A320;
      const noseX = aircraftModel(p.type).points.noseX;
      const fe = Math.cos(p.yaw), fn = Math.sin(p.yaw), re = fn, rn = -fe;
      const at = (x: number, side: number) => [p.e + fe * (noseX - x) + re * side, p.n + fn * (noseX - x) + rn * side] as const;
      const yawF = p.yaw, yawIn = p.yaw - Math.PI / 2; // along the fuselage / pointing into it from the right
      if (p.phase === PH.PUSHBACK) {
        const [e, nn] = at(-4.2, 0);
        put('push', e, nn, p.h, p.yaw + Math.PI);
        continue;
      }
      if (sets++ >= SERVICE_MAX) continue;
      const h = p.h, half = spec.fus.w / 2;
      const hsh = [...p.key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
      const cargo = spec.doors.filter((d) => d[2] === 'C').map((d) => d[0]);
      const pax = spec.doors.filter((d) => d[2] === 'P').map((d) => d[0]).sort((a, c) => a - c);
      const big = spec.cls === 'wide' || spec.cls === 'narrow';
      // belt loader nosed into the forward hold door, baggage tug + carts alongside
      const fwdC = cargo.length ? Math.min(...cargo) : spec.length * 0.3;
      if (spec.cls !== 'turboprop') {
        const [e, nn] = at(fwdC, half + 4.1);
        put('belt', e, nn, h, yawIn + Math.PI + 0.35);
      }
      const trainX = fwdC + 3;
      const [te, tn] = at(trainX - 2, half + 9.5);
      put('tug', te, tn, h, yawF);
      for (let c = 0; c < 1 + (hsh % 3); c++) {
        const [e, nn] = at(trainX + 2 + c * 3.6, half + 9.5);
        put('cart', e, nn, h, yawF);
      }
      // catering at the rear right door (big aircraft), fuel truck under the right wing
      if (big && pax.length >= 2 && hsh % 4 !== 0) {
        const [e, nn] = at(pax[pax.length - 1], half + 5.2);
        put('cater', e, nn, h, yawIn); // rear lift platform against the door
      }
      if (hsh % 3 !== 0) {
        const wx = spec.length * 0.46;
        // outboard of the engines (turboprops: clear of the propeller disc)
        const [e, nn] = at(wx, half + Math.max(spec.span * (spec.cls === 'turboprop' ? 0.36 : 0.22), 6) + 2);
        put('fuel', e, nn, h, yawF + Math.PI);
      }
    }
  }

  /** dynamic GSE each frame: cached turnaround sets + vehicles on the service roads */
  private writeDynamic(simS: number) {
    const n = { ...this.staticN };
    const put = (k: GseKind, x: number, y: number, z: number, yaw: number) => {
      const m = this.gm[k];
      if (n[k] >= m.instanceMatrix.count) return;
      setM(m, n[k]++, x, y, z, yaw);
    };
    for (const q of this.service) put(q.k, q.x, q.y, q.z, q.yaw);
    const o = [0, 0, 0, 0, 0];
    const LANE = 1.8;
    const place = (k: GseKind, p: Path, u: number) => {
      this.sample(p, u, o);
      put(k, o[0] - o[4] * LANE, o[1], o[2] + o[3] * LANE, Math.atan2(-o[4], o[3]));
    };
    for (const mv of this.movers) {
      const p = this.paths[mv.path];
      const u = mv.phase + mv.speed * simS;
      if (mv.kind === 'train') {
        place('tug', p, u);
        for (let c = 0; c < mv.carts; c++) place('cart', p, u - 3.3 - 3.6 * c);
      } else place(mv.kind, p, u);
    }
    for (const k of GSE_KINDS) {
      const m = this.gm[k], a = m.instanceMatrix;
      m.count = n[k];
      if (this.dynN[k] < 0) { a.clearUpdateRanges(); a.needsUpdate = true; } // first frame: upload the static part too
      else if (n[k] > this.staticN[k] || this.dynN[k] !== n[k]) {
        a.clearUpdateRanges();
        a.addUpdateRange(this.staticN[k] * 16, Math.max(0, n[k] - this.staticN[k]) * 16);
        a.needsUpdate = true;
      }
      this.dynN[k] = n[k];
    }
  }
  private dynN: Record<GseKind, number> = { tug: -1, cart: -1, belt: -1, fuel: -1, cater: -1, push: -1, gpu: -1 };

  dispose() {
    for (const m of [...Object.values(this.bm), ...Object.values(this.gm), ...(this.mastMesh ? [this.mastMesh] : [])]) m.dispose();
    for (const g of this.glow) {
      const o = g as THREE.Mesh;
      (o.material as THREE.Material).dispose();
      if (!(o as unknown as THREE.Sprite).isSprite) o.geometry.dispose();
    }
  }
}

/** night: glowing lamp heads (sprites) + a soft light pool on the apron under every mast */
function mastGlow(mast: Float32Array): THREE.Object3D[] {
  const n = mast.length / 3;
  const head = new Float32Array(n * 3), foot = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    head.set([mast[i * 3], mast[i * 3 + 1] + MAST_H - 1.4, mast[i * 3 + 2]], i * 3);
    foot.set([mast[i * 3], mast[i * 3 + 1], mast[i * 3 + 2]], i * 3);
  }
  // sprites
  const hp = new THREE.InstancedBufferAttribute(head, 3);
  const sm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  sm.name = 'mast-glow';
  const p = instancedBufferAttribute(hp) as unknown as ReturnType<typeof vec3>;
  const d = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(p, 1)).xyz));
  sm.positionNode = p;
  sm.scaleNode = max(float(7), d.mul(0.006));
  const r = length(uv().sub(0.5)).mul(2);
  const core = float(1).sub(smoothstep(0.0, 1.0, r));
  const glow = core.mul(core).mul(core);
  sm.colorNode = vec4(vec3(1.0, 0.93, 0.8).mul(glow).mul(2.2).mul(U.night).mul(float(1).sub(smoothstep(8000, 14000, d))), glow);
  sm.fog = false;
  const spr = new THREE.Sprite(sm);
  spr.count = n;
  spr.frustumCulled = false;
  spr.renderOrder = 6;
  spr.name = 'mast-glow';
  // light pools: flat discs pulled towards the camera like the markings, additive
  const disc = new THREE.PlaneGeometry(2, 2);
  disc.rotateX(-Math.PI / 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = disc.index;
  g.setAttribute('position', disc.getAttribute('position'));
  g.setAttribute('uv', disc.getAttribute('uv'));
  const fp = new THREE.InstancedBufferAttribute(foot, 3);
  g.setAttribute('foot', fp);
  g.instanceCount = n;
  const pm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  pm.name = 'mast-pool';
  const f = instancedBufferAttribute(fp) as unknown as ReturnType<typeof vec3>;
  const R = 58;
  const wp = f.add(positionGeometry.mul(R)).add(vec3(0, 0.05, 0));
  const toCam = cameraPosition.sub(modelWorldMatrix.mul(vec4(wp, 1)).xyz); // group: translation only
  const dc = length(toCam);
  pm.positionNode = wp.add(toCam.div(dc).mul(min(dc.mul(0.0008).add(0.45), dc.mul(0.5))));
  const rr = length(uv().sub(0.5)).mul(2);
  const fall = float(1).sub(smoothstep(0.0, 1.0, rr));
  pm.colorNode = vec4(vec3(1.0, 0.9, 0.72).mul(fall.mul(fall)).mul(0.22).mul(U.night), 1);
  pm.fog = false;
  const pool = new THREE.Mesh(g, pm);
  pool.frustumCulled = false;
  pool.renderOrder = 2;
  pool.name = 'mast-pools';
  return [spr, pool];
}
