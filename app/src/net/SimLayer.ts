import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { simSpeed } from '../state/store';
import type { SimFrame, SimTrips, TripIn } from './sim/simWorker';
import { clock } from '../state/clock';
import type { TransitLayer } from '../layers/TransitLayer';
import { AgentsView } from './view/agents';

const S = 1024;
const RADIUS = 1200;
const MOVE = 700;

export class SimLayer implements Layer {
  readonly id = 'netsim';
  private engine!: Engine;
  private worker: Worker | null = null;
  private centre: { e: number; n: number } | null = null;
  private agents = new AgentsView(6000);
  private frame: SimFrame | null = null;
  private nodeIdx = new Map<string, number>();
  private have: Set<string> = new Set();
  private sentSpeed = -1;
  private handed = new Set<number>();
  private pending = new Set<number>();
  private nextHand = 0;

  init(engine: Engine) {
    this.engine = engine;
    this.have = engine.tiles.netTiles;
    this.worker = new Worker(new URL('./sim/simWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<SimFrame | SimTrips>) => {
      if (ev.data.type === 'trips') { this.onTrips(ev.data); return; }
      if (ev.data.type !== 'frame') return;
      if (!this.frame || this.frame.nodes !== ev.data.nodes) {
        this.nodeIdx = new Map(ev.data.nodes.map((id, i) => [id, i]));
      }
      this.frame = ev.data;
    };
    engine.tiles.root.add(this.agents.group);
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
        this.releaseAll();
        this.worker.postMessage({ type: 'region', root: `${this.engine.dataRoot}/net`, tiles, seed: (Math.random() * 1e9) | 0, speed: sp });
      }
    }
    if (this.centre && ctx.time > this.nextHand) {
      this.nextHand = ctx.time + 1.5;
      this.handoff();
    }
    if (this.frame) {
      this.agents.update(this.frame.agents);
      this.agents.group.visible = ctx.altitude < 3000;
    }
  }

  private transit(): TransitLayer | null {
    return (this.engine.layers.find((l) => l.id === 'transit') as unknown as TransitLayer) ?? null;
  }

  private releaseAll() {
    const tr = this.transit();
    for (const t of this.handed) tr?.overrides.delete(t);
    this.handed.clear();
    this.pending.clear();
  }

  private onTrips(m: SimTrips) {
    const tr = this.transit();
    for (const t of m.accepted) { this.handed.add(t); this.pending.delete(t); tr?.overrides.set(t, null); }
    for (const t of m.done) { this.handed.delete(t); tr?.overrides.delete(t); }
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
      if (this.handed.has(trip) || this.pending.has(trip)) continue;
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
    this.engine.tiles.root.remove(this.agents.group);
  }
}
