// Real-user monitoring: a small summary per session sent to the Worker
// (POST /rum → Workers Analytics Engine) after 45 s and whenever the page is
// hidden (at most once a minute). Production builds only; ?rum=0 disables.
//
// Frame times come from the engine loop (a fixed histogram, no per-frame
// allocation); tile latency from the tile workers (network/cache ms and the
// source: local Cache Storage, CDN edge cache, or R2).
import type { Engine } from './Engine';

const BUCKETS = [8, 12, 17, 20, 25, 33, 50, 100, 1e9];

export class Rum {
  private hist = new Uint32Array(BUCKETS.length);
  private frames = 0;
  private long = 0;
  private cpu = 0;
  private start = performance.now();
  private lastSent = 0;
  private sentTiles = 0;
  private engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
    if (!import.meta.env.PROD || new URLSearchParams(location.search).get('rum') === '0') return;
    setTimeout(() => this.send('session'), 45000);
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.send('hide'); });
  }

  /** per frame: real interval and main-thread ms */
  frame(dtMs: number, cpuMs: number) {
    let i = 0;
    while (dtMs > BUCKETS[i]) i++;
    this.hist[i]++;
    this.frames++;
    this.cpu += cpuMs;
    if (dtMs > 50) this.long++;
  }

  private pct(p: number) {
    let n = 0;
    const want = this.frames * p;
    for (let i = 0; i < BUCKETS.length; i++) { n += this.hist[i]; if (n >= want) return Math.min(BUCKETS[i], 200); }
    return 0;
  }

  private send(kind: string) {
    const now = performance.now();
    if (!this.frames || now - this.lastSent < 60000) return;
    this.lastSent = now;
    const e = this.engine, tm = e.tiles;
    const fl = tm.fetchLog.slice(this.sentTiles).sort((a, b) => a - b);
    this.sentTiles = tm.fetchLog.length;
    const q = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
    const sc = tm.sourceCounts, total = sc.local + sc.edge + sc.origin;
    const mark = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? 0;
    const body = {
      kind, backend: e.backend, quality: e.quality.name, build: String(tm.manifest?.build ?? ''),
      view: e.ctx.altitude < 150 ? 'street' : e.ctx.altitude < 3000 ? 'city' : 'region',
      fps: (this.frames / ((now - this.start) / 1000)),
      frameP50: this.pct(0.5), frameP95: this.pct(0.95), cpuMs: this.cpu / this.frames, longFrames: this.long,
      tileP50: q(fl, 0.5), tileP95: q(fl, 0.95), tileHitRate: total ? (sc.local + sc.edge) / total : 0, tiles: total,
      firstFrameMs: mark('first-tile'), settledMs: mark('layers-ready'),
      drawCalls: e.lastDrawCalls, triangles: e.lastTriangles, dpr: e.renderer.getPixelRatio(),
    };
    try { navigator.sendBeacon('/rum', new Blob([JSON.stringify(body)], { type: 'application/json' })); } catch { /* best effort */ }
    this.hist.fill(0); this.frames = 0; this.long = 0; this.cpu = 0; this.start = now;
  }
}
