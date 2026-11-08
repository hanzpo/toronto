import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import type { Built } from './core/model';
import type { Mat } from './core/assets';
import { NetView } from './view/NetView';
import type { NetBuilt } from './worker';

const S = 1024;
const RADIUS = 1700;
const KEEP = 2600;
const MAX_ALT = 3500;

interface NetTile { key: string; tx: number; ty: number; state: 'loading' | 'ready' | 'empty'; view?: NetView; group?: THREE.Group }

export class NetLayer implements Layer {
  readonly id = 'net';
  private engine!: Engine;
  private root = '';
  private have = new Set<string>();
  private tiles = new Map<string, NetTile>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private jobs = new Map<number, NetTile>();
  private next = 1;
  readonly group = new THREE.Group();

  async init(engine: Engine) {
    this.engine = engine;
    this.root = `${engine.dataRoot}/net`;
    const r = await fetch(`${this.root}/index.json`).catch(() => null);
    if (!r?.ok) return;
    const idx = (await r.json()) as { tiles: { tile: [number, number] }[] };
    for (const t of idx.tiles) this.have.add(`${t.tile[0]}_${t.tile[1]}`);
    engine.tiles.netTiles = this.have;
    this.group.name = 'net';
    engine.tiles.root.add(this.group);
    const n = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this.done(i, ev.data);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  update(ctx: FrameContext) {
    if (!this.have.size) return;
    const E = ctx.focus.x, N = -ctx.focus.z;
    const want: { key: string; tx: number; ty: number; d: number }[] = [];
    if (ctx.altitude < MAX_ALT) {
      const r = Math.ceil(RADIUS / S);
      const cx = Math.floor(E / S), cy = Math.floor(N / S);
      for (let ty = cy - r; ty <= cy + r; ty++) for (let tx = cx - r; tx <= cx + r; tx++) {
        const key = `${tx}_${ty}`;
        if (!this.have.has(key)) continue;
        const d = Math.hypot(Math.max(0, Math.abs(E - (tx + 0.5) * S) - S / 2), Math.max(0, Math.abs(N - (ty + 0.5) * S) - S / 2));
        if (d < RADIUS) want.push({ key, tx, ty, d });
      }
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (this.tiles.has(w.key)) continue;
      const wi = this.busy.indexOf(Math.min(...this.busy));
      if (this.busy[wi] >= 1) break;
      const t: NetTile = { key: w.key, tx: w.tx, ty: w.ty, state: 'loading' };
      this.tiles.set(w.key, t);
      const id = this.next++;
      this.jobs.set(id, t);
      this.busy[wi]++;
      this.workers[wi].postMessage({ id, root: this.root, tx: w.tx, ty: w.ty, size: S });
    }
    for (const t of this.tiles.values()) {
      if (t.state === 'loading') continue;
      const d = Math.hypot(Math.max(0, Math.abs(E - (t.tx + 0.5) * S) - S / 2), Math.max(0, Math.abs(N - (t.ty + 0.5) * S) - S / 2));
      if (d > KEEP || ctx.altitude > MAX_ALT * 1.3) this.drop(t);
    }
  }

  private done(wi: number, msg: { id: number; built?: NetBuilt; empty?: boolean; error?: string; ms?: number }) {
    this.busy[wi] = Math.max(0, this.busy[wi] - 1);
    const t = this.jobs.get(msg.id);
    this.jobs.delete(msg.id);
    if (!t || this.tiles.get(t.key) !== t) return;
    if (msg.error) { console.warn('net tile', t.key, msg.error); t.state = 'empty'; return; }
    if (!msg.built) { t.state = 'empty'; return; }
    const b = msg.built;
    const meshes: Built['meshes'] = new Map(b.meshes.map(([m, pos, uv, idx]) => [m as Mat, { pos, uv, idx }]));
    const view = new NetView({ ...b, meshes, lanes: [] } as Built, { x: t.tx * S, y: t.ty * S }, b.ground);
    const g = view.group;
    g.position.set(t.tx * S, 0, -t.ty * S);
    g.name = `net ${t.key}`;
    this.group.add(g);
    t.view = view;
    t.group = g;
    t.state = 'ready';
    this.engine.tiles.netReady.add(t.key);
  }

  private drop(t: NetTile) {
    if (t.group) {
      this.group.remove(t.group);
      t.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    this.engine.tiles.netReady.delete(t.key);
    this.tiles.delete(t.key);
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const t of [...this.tiles.values()]) this.drop(t);
    this.engine.tiles.root.remove(this.group);
  }
}
