import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import type { Built } from './core/model';
import type { Mat } from './core/assets';
import { NetView } from './view/NetView';
import type { NetBuilt } from './worker';

const S = 1024;
const RADIUS = 2600;
const KEEP = 3400;
const PROPS = 1400;
const MAX_ALT = 3500;

interface NetTile { key: string; tx: number; ty: number; state: 'loading' | 'ready' | 'empty'; view?: NetView; group?: THREE.Group; nodeIds?: string[]; terrain?: Built['terrain']; solids?: { e: number; n: number; r: number }[] }

export interface VegSink { setNear(key: string, e0: number, n0: number, veg: Float32Array, cells: Uint32Array): void; dropNear(key: string): void }

export interface SignalSource { signal(node: string, group: number): 'red' | 'amber' | 'green'; gate(node: string): number }

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
  signals: SignalSource | null = null;
  vegetation: VegSink | null = null;

  async init(engine: Engine) {
    this.engine = engine;
    this.root = `${engine.dataRoot}/net`;
    const r = await fetch(`${this.root}/index.json`).catch(() => null);
    if (!r?.ok) return;
    const idx = (await r.json()) as { tiles: { tile: [number, number] }[] };
    for (const t of idx.tiles) this.have.add(`${t.tile[0]}_${t.tile[1]}`);
    engine.tiles.netTiles = this.have;
    engine.tiles.netHeight = (e, n) => this.heightAt(e, n);
    engine.tiles.netSolids = (e, n) => this.tiles.get(`${Math.floor(e / S)}_${Math.floor(n / S)}`)?.solids ?? [];
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
    const sig = this.signals;
    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready' || !t.view) continue;
      const d = Math.hypot(Math.max(0, Math.abs(E - (t.tx + 0.5) * S) - S / 2), Math.max(0, Math.abs(N - (t.ty + 0.5) * S) - S / 2));
      t.view.props.group.visible = d < PROPS && ctx.altitude < 1500;
    }
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready' || !t.view || !t.nodeIds || !sig || !t.view.props.group.visible) continue;
      const ids = t.nodeIds;
      t.view.props.setSignals((ni, g) => sig.signal(ids[ni], g));
      t.view.props.setGates((ni) => { const v = sig.gate(ids[ni]); return { down: Math.min(1, v * 1.4), flash: v > 0 && blink }; });
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
    const view = new NetView({ ...b, meshes, lanes: [] } as Built, { x: t.tx * S, y: t.ty * S }, b.ground, 2, S);
    const g = view.group;
    g.position.set(t.tx * S, 0, -t.ty * S);
    g.name = `net ${t.key}`;
    this.group.add(g);
    t.view = view;
    t.group = g;
    t.nodeIds = b.nodes.map((n) => n.id);
    t.terrain = b.terrain;
    const R: Record<string, number> = { lamp: 0.16, lamp_res: 0.18, tree: 0.3, hydrant: 0.22, bin: 0.3, bench: 0.5, signal_pole: 0.2, stop_sign: 0.06, ocs_pole: 0.18, gate: 0.35, crossbuck: 0.08, shelter: 1.2, pier: 1.0 };
    t.solids = b.props.filter((p) => R[p.kind]).map((p) => ({ e: p.x, n: p.y, r: R[p.kind] }));
    t.state = 'ready';
    if (b.veg && b.vegCells) this.vegetation?.setNear(t.key, t.tx * S, t.ty * S, b.veg, b.vegCells);
    this.engine.tiles.netReady.add(t.key);
  }

  heightAt(e: number, n: number): number | null {
    const t = this.tiles.get(`${Math.floor(e / S)}_${Math.floor(n / S)}`);
    const g = t?.terrain;
    if (!g) return null;
    const fx = (e - g.x0) / g.cell, fy = (n - g.y0) / g.cell;
    const i = Math.max(0, Math.min(g.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(g.ny - 2, Math.floor(fy)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j));
    const h = g.h, nx = g.nx;
    return h[j * nx + i] * (1 - u) * (1 - v) + h[j * nx + i + 1] * u * (1 - v) + h[(j + 1) * nx + i] * (1 - u) * v + h[(j + 1) * nx + i + 1] * u * v + 0.05;
  }

  private drop(t: NetTile) {
    if (t.group) {
      this.group.remove(t.group);
      t.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    this.engine.tiles.netReady.delete(t.key);
    this.vegetation?.dropNear(t.key);
    this.tiles.delete(t.key);
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const t of [...this.tiles.values()]) this.drop(t);
    this.engine.tiles.root.remove(this.group);
  }
}
