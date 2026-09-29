// ?debug=1 — exercises the overlay API: a few route lines + moving markers.
import type { Engine } from '../../engine/Engine';
import type { FrameContext, Layer } from '../../engine/types';
import { LineOverlay } from './LineOverlay';
import { MarkerOverlay } from './MarkerOverlay';

export class DebugOverlayLayer implements Layer {
  readonly id = 'debug-overlay';
  private lines!: LineOverlay;
  private markers!: MarkerOverlay;
  private path: number[] = [];

  private engine!: Engine;
  init(engine: Engine) {
    this.engine = engine;
    this.lines = new LineOverlay(engine, { name: 'debug-lines', width: 4 });
    // a loop around downtown and a long line to the west
    const loop: number[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const e = -300 + Math.cos(a) * 1500, n = -300 + Math.sin(a) * 1100;
      loop.push(e, n, engine.heightAt(e, n));
    }
    this.path = loop;
    this.lines.set([
      { id: 'loop', points: loop, color: 0xf8c300 },
      { id: 'west', points: [0, -900, 0, -40000, -30000, 0, -56000, -46000, 0], color: 0x3e8a36, width: 6 },
    ]);
    this.markers = new MarkerOverlay(engine, { name: 'debug-trains', capacity: 64, shape: 'train', size: [140, 4.5, 3.2], minPixels: 10 });
  }

  update(ctx: FrameContext) {
    const n = this.path.length / 3 - 1;
    for (let k = 0; k < 8; k++) {
      const t = ((ctx.time * 0.01 + k / 8) % 1) * n;
      const i = Math.floor(t), f = t - i;
      const p = this.path;
      const e = p[i * 3] + (p[i * 3 + 3] - p[i * 3]) * f, nn = p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * f;
      const hd = Math.atan2(p[i * 3 + 4] - p[i * 3 + 1], p[i * 3 + 3] - p[i * 3]);
      this.markers.setMarker(k, e, nn, this.engine.heightAt(e, nn), hd, k % 2 ? 0x3e8a36 : 0xf8c300);
    }
    this.markers.setCount(8);
    this.lines.update(ctx);
    this.markers.update(ctx);
  }

  dispose() {
    this.lines.dispose();
    this.markers.dispose();
  }
}
