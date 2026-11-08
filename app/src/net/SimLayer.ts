import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { simSpeed } from '../state/store';
import type { SimFrame } from './sim/simWorker';
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

  init(engine: Engine) {
    this.engine = engine;
    this.have = engine.tiles.netTiles;
    this.worker = new Worker(new URL('./sim/simWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<SimFrame>) => {
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
        this.worker.postMessage({ type: 'region', root: `${this.engine.dataRoot}/net`, tiles, seed: (Math.random() * 1e9) | 0, speed: sp });
      }
    }
    if (this.frame) {
      this.agents.update(this.frame.agents);
      this.agents.group.visible = ctx.altitude < 3000;
    }
  }

  dispose() {
    this.worker?.terminate();
    this.engine.tiles.root.remove(this.agents.group);
  }
}
