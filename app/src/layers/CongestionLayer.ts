// Region-wide congestion overlay: every major road segment of the network model (ranks 0-2,
// congestion/majors.bin.gz from app/scripts/net-bake.mjs) coloured green → red by its speed ratio
// from a time-of-day demand model with the known bottleneck corridors.
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { fetchTbn } from '../data/tbn';
import { LineOverlay, type LineSpec } from '../render/overlay/LineOverlay';
import { clock } from '../state/clock';
import { useApp } from '../state/store';

/** speed ratio buckets: ≥ threshold → colour */
const BUCKETS: [number, number][] = [
  [0.78, 0x2fbf62],
  [0.62, 0xa5d23a],
  [0.48, 0xf4c430],
  [0.34, 0xf08a24],
  [0.2, 0xe03a2c],
  [0, 0x8f1420],
];
const WIDTH = [4.5, 3.5, 2.4];
const CLASS_LOAD = [1, 0.9, 0.75];

/** extra peak load of the known bottleneck corridors, by road name (0 = none) */
export function bottleneckOf(name: string | null | undefined): number {
  if (!name) return 0;
  const n = name.toLowerCase();
  if (n.includes('don valley')) return 1.2;
  if (n.includes('gardiner')) return 1.15;
  if (/\b401\b/.test(n) && n.includes('collector')) return 1.0;
  if (/\b401\b/.test(n) && n.includes('express')) return 0.9;
  if (/\b401\b/.test(n) || n.includes('macdonald')) return 1.0;
  if (n.includes('queen elizabeth') || /\bqew\b/.test(n)) return 0.95;
  if (/\b404\b/.test(n)) return 0.9;
  if (/\b427\b/.test(n)) return 0.85;
  if (n.includes('allen')) return 0.8;
  if (/\b400\b/.test(n) || /\b410\b/.test(n) || /\b403\b/.test(n)) return 0.6;
  if (n.includes('lake shore') || n.includes('lakeshore')) return 0.5;
  if (/\b407\b/.test(n)) return 0.1;
  return 0;
}

/** regional traffic demand (0 night … ~1 peak) at a time of day */
export function demand(secOfDay: number, weekday: number): number {
  const h = secOfDay / 3600;
  const g = (c: number, w: number) => Math.exp(-(((h - c) / w) ** 2));
  if (weekday === 0 || weekday === 6) return 0.08 + 0.55 * g(14, 3.2);
  return 0.08 + 0.8 * g(8, 1.1) + 0.85 * g(17.2, 1.4) + 0.35 * g(12.5, 2.2);
}

interface Majors { off: Uint32Array; xyz: Float32Array; cls: Uint8Array; load: Float32Array }

export class CongestionLayer implements Layer {
  readonly id = 'congestion';
  private lines!: LineOverlay;
  private majors: Majors | null = null;
  private requested = false;
  private buckets: Uint8Array | null = null;
  private lastTod = -1e9;
  private on = false;
  private root = '';

  init(engine: Engine) {
    this.root = engine.dataRoot;
    this.lines = new LineOverlay(engine, { name: 'congestion', width: 3, lift: 6, order: 3, depthMode: 'onTop' });
    this.lines.setVisible(false);
  }

  private async load() {
    const t = await fetchTbn<{ names: string[] }>(`${this.root}/congestion/majors.bin.gz`).catch(() => null);
    if (!t) return;
    const a = t.arrays, names = t.header.names ?? [];
    const cls = a.s_class as Uint8Array, nm = a.s_name as Uint16Array;
    const load = new Float32Array(cls.length);
    for (let i = 0; i < cls.length; i++) {
      const h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
      load[i] = (CLASS_LOAD[Math.min(2, cls[i])] ?? 0.7) * (1 + bottleneckOf(nm[i] === 0xffff ? null : names[nm[i]])) * (0.9 + (h / 4294967296) * 0.2);
    }
    this.majors = { off: a.s_off as Uint32Array, xyz: a.s_xyz as Float32Array, cls, load };
  }

  private colour(secOfDay: number, weekday: number) {
    const m = this.majors!;
    const n = m.cls.length;
    const d = demand(secOfDay, weekday);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const L = d * m.load[i];
      const r = 1 / (1 + 1.6 * L * L * L);
      let k = 0;
      while (k < BUCKETS.length - 1 && r < BUCKETS[k][0]) k++;
      b[i] = k;
    }
    const prev = this.buckets;
    if (prev && prev.every((v, i) => v === b[i])) return;
    this.buckets = b;
    const specs: LineSpec[] = new Array(n);
    for (let i = 0; i < n; i++) {
      specs[i] = { id: String(i), points: m.xyz.subarray(m.off[i] * 3, m.off[i + 1] * 3), color: BUCKETS[b[i]][1], width: WIDTH[Math.min(2, m.cls[i])] };
    }
    this.lines.set(specs);
  }

  update(ctx: FrameContext) {
    const enabled = ctx.analyticsMode && useApp.getState().analytics.congestion;
    if (enabled !== this.on) {
      this.on = enabled;
      this.lines.setVisible(enabled);
    }
    if (enabled && !this.requested) {
      this.requested = true;
      void this.load();
    }
    if (enabled && this.majors) {
      const p = clock.parts();
      if (Math.abs(p.secOfDay - this.lastTod) > 60) {
        this.lastTod = p.secOfDay;
        this.colour(p.secOfDay, p.weekday);
      }
    }
    this.lines.update(ctx);
  }

  dispose() {
    this.lines.dispose();
  }
}
