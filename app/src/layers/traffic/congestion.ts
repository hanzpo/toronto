// Region-wide congestion overlay (statistical tier): every class 0–2 road
// segment coloured green → yellow → red by its estimated speed ratio. Ratios
// come from the worker (demand model + locally measured agent speeds).
import type { Engine } from '../../engine/Engine';
import type { FrameContext } from '../../engine/types';
import { LineOverlay, type LineSpec } from '../../render/overlay/LineOverlay';
import { clock } from '../../state/clock';

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

interface Geom { off: Uint32Array; xyz: Float32Array; cls: Uint8Array }

export class CongestionOverlay {
  private lines: LineOverlay;
  private geom: Geom | null = null;
  private requested = false;
  private lastReq = -1e9;
  private lastTod = -1e9;
  private buckets: Uint8Array | null = null;
  private on = false;
  private post: ((m: { type: 'majors' } | { type: 'congestion'; tod: number; weekday: number }) => void) | null = null;

  constructor(engine: Engine) {
    this.lines = new LineOverlay(engine, { name: 'congestion', width: 3, lift: 6, order: 3, depthMode: 'onTop' });
    this.lines.setVisible(false);
  }

  bind(post: (m: { type: 'majors' } | { type: 'congestion'; tod: number; weekday: number }) => void) {
    this.post = post;
  }

  setGeometry(g: Geom) {
    this.geom = g;
    this.lastReq = -1e9;
  }

  setRatios(ratio: Uint8Array) {
    if (!this.geom) return;
    const n = this.geom.cls.length;
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = ratio[i] / 255;
      let k = 0;
      while (k < BUCKETS.length - 1 && r < BUCKETS[k][0]) k++;
      b[i] = k;
    }
    const prev = this.buckets;
    if (prev && prev.length === n) {
      let same = true;
      for (let i = 0; i < n && same; i++) same = prev[i] === b[i];
      if (same) return;
    }
    this.buckets = b;
    const { off, xyz, cls } = this.geom;
    const specs: LineSpec[] = new Array(n);
    for (let i = 0; i < n; i++) {
      specs[i] = {
        id: String(i),
        points: xyz.subarray(off[i] * 3, off[i + 1] * 3),
        color: BUCKETS[b[i]][1],
        width: WIDTH[Math.min(2, cls[i])],
      };
    }
    this.lines.set(specs);
  }

  update(ctx: FrameContext, enabled: boolean) {
    if (enabled !== this.on) {
      this.on = enabled;
      this.lines.setVisible(enabled);
    }
    if (enabled && this.post) {
      if (!this.requested) {
        this.requested = true;
        this.post({ type: 'majors' });
      }
      const p = clock.parts();
      // refresh at most once a second, and only when sim time moved
      if (this.geom && ctx.time - this.lastReq > 1 && Math.abs(p.secOfDay - this.lastTod) > 20) {
        this.lastReq = ctx.time;
        this.lastTod = p.secOfDay;
        this.post({ type: 'congestion', tod: p.secOfDay, weekday: p.weekday });
      }
    }
    this.lines.update(ctx);
  }

  dispose() {
    this.lines.dispose();
  }
}
