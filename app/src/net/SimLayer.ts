import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { simSpeed } from '../state/store';
import type { SimFrame, SimRegion, SimReply, SimTrips, TripIn } from './sim/simWorker';
import { clock } from '../state/clock';
import type { TransitLayer } from '../layers/TransitLayer';
import { NetVehicles, bodies, type TripMeta } from './view/vehicles';
import * as THREE from 'three/webgpu';

const S = 1024;
const RADIUS = 1200;
const MOVE = 700;

export class SimLayer implements Layer {
  readonly id = 'traffic';
  private engine!: Engine;
  private worker: Worker | null = null;
  private centre: { e: number; n: number } | null = null;
  private agents = new NetVehicles();
  private metaCache = new Map<number, TripMeta | null>();
  private frame: SimFrame | null = null;
  private nodeIdx = new Map<string, number>();
  private have: Set<string> = new Set();
  private sentSpeed = -1;
  private handed = new Set<number>();
  private pending = new Set<number>();
  private kept = new Set<number>();
  private nextHand = 0;

  init(engine: Engine) {
    this.engine = engine;
    this.have = engine.tiles.netTiles;
    this.worker = new Worker(new URL('./sim/simWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<SimFrame | SimTrips | SimReply | SimRegion>) => {
      if (ev.data.type === 'region') { this.keepOnly(new Set(ev.data.trips)); return; }
      if (ev.data.type === 'trips') { this.onTrips(ev.data); return; }
      if (ev.data.type === 'reply') { if (ev.data.player.length && this.frame) this.frame.player = ev.data.player; this.replies.get(ev.data.id)?.(ev.data.ok); this.replies.delete(ev.data.id); return; }
      if (ev.data.type !== 'frame') return;
      if (!this.frame || this.frame.nodes !== ev.data.nodes) {
        this.nodeIdx = new Map(ev.data.nodes.map((id, i) => [id, i]));
      }
      this.frame = ev.data;
      this.agents.push(ev.data.stamp, ev.data.agents);
    };
    engine.scene.add(this.agents.group);
  }

  signal(node: string, group: number): 'red' | 'amber' | 'green' {
    const f = this.frame;
    const i = this.nodeIdx.get(node);
    if (!f || i === undefined) return 'red';
    const s = f.sig[i * 4 + Math.max(0, Math.min(3, group))];
    return s === 2 ? 'green' : s === 1 ? 'amber' : 'red';
  }

  gate(node: string): number {
    const i = this.nodeIdx.get(node);
    return this.frame && i !== undefined ? this.frame.gates[i] : 0;
  }

  update(ctx: FrameContext) {
    if (!this.worker || !this.have.size) return;
    const sp = Math.min(20, simSpeed());
    if (sp !== this.sentSpeed) { this.worker.postMessage({ type: 'speed', speed: sp }); this.sentSpeed = sp; }
    const E = ctx.focus.x, N = -ctx.focus.z;
    if (ctx.altitude < 2500 && (!this.centre || Math.hypot(E - this.centre.e, N - this.centre.n) > MOVE)) {
      const tiles: [number, number][] = [];
      const r = Math.ceil(RADIUS / S);
      const cx = Math.floor(E / S), cy = Math.floor(N / S);
      for (let ty = cy - r; ty <= cy + r; ty++) for (let tx = cx - r; tx <= cx + r; tx++) {
        if (!this.have.has(`${tx}_${ty}`)) continue;
        const d = Math.hypot(Math.max(0, Math.abs(E - (tx + 0.5) * S) - S / 2), Math.max(0, Math.abs(N - (ty + 0.5) * S) - S / 2));
        if (d < RADIUS) tiles.push([tx, ty]);
      }
      if (tiles.length) {
        this.centre = { e: E, n: N };
        this.worker.postMessage({ type: 'region', root: `${this.engine.dataRoot}/net`, tiles, seed: (Math.random() * 1e9) | 0, speed: sp });
      }
    }
    if (this.centre && ctx.time > this.nextHand) {
      this.nextHand = ctx.time + 1.5;
      this.handoff();
    }
    if (this.frame) {
      const tl = this.transit();
      if (tl && !tl.sim) tl.sim = { paths: () => this.agents.paths, owns: (t) => this.handed.has(t) };
      this.agents.update(performance.timeOrigin + performance.now(), ctx.anchor, ctx.cameraPos.x, -ctx.cameraPos.z, ctx.dt, (trip) => this.meta(trip));
      this.agents.group.visible = ctx.altitude < 3000;
    }
  }

  private replies = new Map<number, (ok: boolean) => void>();
  private reqId = 1;
  private lastPlayer: { e: number; n: number } | null = null;

  private ask(m: object): Promise<boolean> {
    const id = this.reqId++;
    return new Promise((res) => { this.replies.set(id, res); this.worker?.postMessage({ ...m, id }); });
  }

  takeOverNearestCar(e: number, n: number, radius = 40): Promise<boolean> {
    return this.ask({ type: 'take', x: e, y: n, r: Math.max(radius, 60) });
  }

  takeOverCar(): Promise<boolean> {
    const p = this.picked;
    return p ? this.ask({ type: 'take', x: p.e, y: p.n, r: 6 }) : Promise.resolve(false);
  }

  private picked: { e: number; n: number } | null = null;

  pickCar(e: number, n: number, radius = 8): number | null {
    const f = this.frame?.agents;
    if (!f) return null;
    let best: { e: number; n: number; id: number } | null = null, bd = radius;
    for (const b of bodies(f)) {
      if (b.kind !== 0) continue;
      const d = Math.hypot(b.e - e, b.n - n);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return null;
    this.picked = { e: best.e, n: best.n };
    return best.id;
  }

  pickCarMajor(e: number, n: number, radius = 150): number | null {
    return this.pickCar(e, n, radius);
  }

  handles(trip: number): boolean { return this.handed.has(trip); }

  tripPose(trip: number): { e: number; n: number; z: number; h: number } | null { return this.agents.poses.get(trip) ?? null; }

  tripPath(trip: number): Float32Array | null { return this.agents.paths.get(trip) ?? null; }

  driveTrip(trip: number | null): boolean {
    this.worker?.postMessage({ type: 'driveTrip', trip: trip ?? -1 });
    return trip !== null && this.handed.has(trip);
  }

  setTripSpeed(v: number) { this.worker?.postMessage({ type: 'tripSpeed', v }); }

  drivenState(): { v: number; safe: number; gap: number } | null {
    const d = this.frame?.driven;
    return d && d.length >= 3 ? { v: d[0], safe: d[1], gap: d[2] } : null;
  }

  keepTrip(trip: number | null) {
    for (const t of this.kept) if (t !== trip) this.kept.delete(t);
    if (trip === null) return;
    this.kept.add(trip);
    if (this.handed.delete(trip)) this.worker?.postMessage({ type: 'drop', trip });
  }

  pickPed(e: number, n: number, radius = 3): { e: number; n: number; z: number; heading: number; colour: number } | null {
    const f = this.frame?.agents;
    if (!f) return null;
    for (const b of bodies(f)) if (b.kind === 4 && Math.hypot(b.e - e, b.n - n) < radius) return { e: b.e, n: b.n, z: b.z, heading: b.h, colour: 0x6b7a8f };
    return null;
  }

  removePedNear() {}

  getPlayer(): { e: number; n: number; elev: number; heading: number; speed: number; roadName: string | null; onRoad: boolean; surface: number; damage: number } | null {
    const p = this.frame?.player;
    if (!p || p.length < 6) return null;
    this.lastPlayer = { e: p[0], n: p[1] };
    return { e: p[0], n: p[1], elev: p[2], heading: p[3], speed: p[4], roadName: null, onRoad: p[5] > 0, surface: p[5] > 0 ? 1 : 0, damage: 0 };
  }

  setPlayerInput(inp: { throttle?: number; brake?: number; steer?: number; handbrake?: boolean }) {
    const p = this.lastPlayer;
    const ground = p ? this.engine.heightAt(p.e, p.n) : 0;
    this.worker?.postMessage({ type: 'input', throttle: inp.throttle ?? 0, brake: inp.brake ?? 0, steer: inp.steer ?? 0, handbrake: !!inp.handbrake, ground });
  }

  releasePlayer() { this.worker?.postMessage({ type: 'release' }); }

  setWalker(e: number, n: number, elev: number) { this.worker?.postMessage({ type: 'walker', x: e, y: n, z: elev }); }

  clearWalker() { this.worker?.postMessage({ type: 'clearWalker' }); }

  solidsNear(e: number, n: number, r: number, out: { e: number; n: number; h: number; hl: number; hw: number }[] = []) {
    out.length = 0;
    const f = this.frame?.agents;
    if (!f) return out;
    const W = [1.9, 2.6, 2.6, 3.0, 0];
    for (const b of bodies(f)) {
      if (b.kind === 4 || Math.hypot(b.e - e, b.n - n) > r + b.len) continue;
      out.push({ e: b.e, n: b.n, h: b.h, hl: b.len / 2, hw: W[b.kind] / 2 });
    }
    return out;
  }


  private meta(trip: number): TripMeta | null {
    let m = this.metaCache.get(trip);
    if (m !== undefined) return m;
    const sys = this.transit()?.system;
    const info = sys?.tripInfo(trip);
    m = info ? { mode: info.mode, route: info.routeMeta, color: new THREE.Color(info.routeMeta.color || '#ffffff') } : null;
    this.metaCache.set(trip, m);
    return m;
  }

  private transit(): TransitLayer | null {
    return (this.engine.layers.find((l) => l.id === 'transit') as unknown as TransitLayer) ?? null;
  }

  private keepOnly(keep: Set<number>) {
    this.handed.clear();
    for (const t of keep) this.own(t);
    this.pending.clear();
  }

  private onTrips(m: SimTrips) {
    for (const t of m.accepted) { this.own(t); this.pending.delete(t); }
    for (const t of m.done) this.handed.delete(t);
  }

  private own(t: number) {
    if (this.kept.has(t)) this.worker?.postMessage({ type: 'drop', trip: t });
    else this.handed.add(t);
  }

  private handoff() {
    const tr = this.transit();
    if (!tr || !this.worker || !this.centre) return;
    const sys = tr.system;
    if (!sys.tripCount) return;
    const R = RADIUS * 0.75;
    const box: [number, number, number, number] = [this.centre.e - R, this.centre.n - R, this.centre.e + R, this.centre.n + R];
    const sec = clock.serviceDay().sec;
    sys.setEvalBounds(box);
    const v = sys.evaluate(sec);
    const trips: TripIn[] = [];
    for (let i = 0; i < v.count; i++) {
      const trip = v.trip[i];
      if (this.handed.has(trip) || this.pending.has(trip) || this.kept.has(trip)) continue;
      if (v.x[i] < box[0] || v.x[i] > box[2] || v.y[i] < box[1] || v.y[i] > box[3]) continue;
      const mode = v.mode[i];
      const kind = mode === 6 ? 1 : mode === 1 || mode === 2 ? 2 : 3;
      const shape = sys.patternShape(v.pattern[i]);
      const info = sys.tripInfo(trip);
      if (!shape || !info) continue;
      const at = v.dist[i];
      const from = at - 20, to = Math.min(shape.length, at + 3000);
      const pts: number[] = [], dist: number[] = [];
      let last = -Infinity;
      for (let k = 0; k < shape.count; k++) {
        const dk = shape.dist[k];
        if (dk < from || dk > to) continue;
        if (dk - last > 5 && last > -Infinity) {
          for (let s = last + 5; s < dk; s += 5) { const p = shape.point(s); pts.push(p[0], p[1], p[2]); dist.push(s); }
        }
        pts.push(shape.xyz[k * 3], shape.xyz[k * 3 + 1], shape.xyz[k * 3 + 2]);
        dist.push(dk);
        last = dk;
      }
      if (pts.length < 6) continue;
      const stops = info.stops.filter((s) => !s.virtual && s.dist > at - 5).map((s) => ({ dist: s.dist, dep: s.dep }));
      trips.push({ trip, kind: kind as TripIn['kind'], variant: mode === 0 ? 1 : 0, pts: Float32Array.from(pts), dist: Float32Array.from(dist), at, v: v.speed[i], stops });
      this.pending.add(trip);
      if (trips.length >= 40) break;
    }
    this.worker.postMessage({ type: 'trips', clock: sec, trips });
    setTimeout(() => { for (const t of trips) if (!this.handed.has(t.trip)) this.pending.delete(t.trip); }, 8000);
  }

  dispose() {
    this.worker?.terminate();
    this.agents.dispose();
  }
}
