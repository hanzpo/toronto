// Spatial queries against the building footprints of loaded level-0 tiles
// (tile worker → FootprintBuf): "is this point inside a building volume",
// used by camera collision and label occlusion. Each tile's footprints get a
// lazily built uniform grid (32 m cells) the first time they're queried.
import type { TileManager } from '../render/tiles/TileManager';
import type { FootprintBuf } from '../workers/collide';

const CELL = 32;

interface Grid {
  n: number; // cells per side
  start: Uint32Array; // n*n+1
  items: Uint32Array;
  bb: Float32Array; // 4 per footprint: x0 y0 x1 y1
}

export class BuildingIndex {
  private grids = new WeakMap<FootprintBuf, Grid>();
  private tiles: TileManager;
  constructor(tiles: TileManager) {
    this.tiles = tiles;
  }

  private tileAt(e: number, n: number): { fb: FootprintBuf; ox: number; oy: number; S: number } | null {
    const S = this.tiles.manifest?.tileSize[0];
    if (!S) return null;
    const tx = Math.floor(e / S), ty = Math.floor(n / S);
    const t = this.tiles.tiles.get(`0/${tx}/${ty}`);
    if (!t || !t.collide) return null;
    return { fb: t.collide, ox: tx * S, oy: ty * S, S };
  }

  private grid(fb: FootprintBuf, S: number): Grid {
    let g = this.grids.get(fb);
    if (g) return g;
    const n = Math.ceil(S / CELL);
    const bb = new Float32Array(fb.count * 4);
    const counts = new Uint32Array(n * n + 1);
    const span = (i: number) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let v = fb.off[i]; v < fb.off[i + 1]; v++) {
        const x = fb.xy[2 * v], y = fb.xy[2 * v + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      bb[4 * i] = x0; bb[4 * i + 1] = y0; bb[4 * i + 2] = x1; bb[4 * i + 3] = y1;
      const c = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v / CELL)));
      return [c(x0), c(y0), c(x1), c(y1)];
    };
    const spans: number[][] = [];
    for (let i = 0; i < fb.count; i++) {
      const s = span(i);
      spans.push(s);
      for (let cy = s[1]; cy <= s[3]; cy++) for (let cx = s[0]; cx <= s[2]; cx++) counts[cy * n + cx + 1]++;
    }
    for (let k = 1; k <= n * n; k++) counts[k] += counts[k - 1];
    const items = new Uint32Array(counts[n * n]);
    const fill = counts.slice(0, n * n);
    for (let i = 0; i < fb.count; i++) {
      const s = spans[i];
      for (let cy = s[1]; cy <= s[3]; cy++) for (let cx = s[0]; cx <= s[2]; cx++) items[fill[cy * n + cx]++] = i;
    }
    g = { n, start: counts, items, bb };
    this.grids.set(fb, g);
    return g;
  }

  /**
   * Top elevation (datum m) of the tallest building whose footprint contains
   * (e, n) and whose volume spans elevation h (pass NaN to ignore h), or -Infinity.
   */
  topAt(e: number, n: number, h = NaN): number {
    const t = this.tileAt(e, n);
    if (!t) return -Infinity;
    const g = this.grid(t.fb, t.S);
    const x = e - t.ox, y = n - t.oy;
    const cx = Math.min(g.n - 1, Math.max(0, Math.floor(x / CELL))), cy = Math.min(g.n - 1, Math.max(0, Math.floor(y / CELL)));
    const k = cy * g.n + cx;
    const fb = t.fb;
    let best = -Infinity;
    for (let j = g.start[k]; j < g.start[k + 1]; j++) {
      const i = g.items[j];
      if (x < g.bb[4 * i] || x > g.bb[4 * i + 2] || y < g.bb[4 * i + 1] || y > g.bb[4 * i + 3]) continue;
      const top = fb.top[i];
      if (top <= best) continue;
      if (!Number.isNaN(h) && (h > top || h < fb.bottom[i])) continue;
      if (inside(fb.xy, fb.off[i], fb.off[i + 1], x, y)) best = top;
    }
    return best;
  }

  /**
   * Distance from (e, n) to the nearest footprint edge of a building that
   * contains elevation h, when (e, n) is within `r` of one (else r). 0 inside.
   */
  clearance(e: number, n: number, h: number, r: number): number {
    const t = this.tileAt(e, n);
    if (!t) return r;
    const g = this.grid(t.fb, t.S);
    const x = e - t.ox, y = n - t.oy;
    const c0x = Math.max(0, Math.floor((x - r) / CELL)), c1x = Math.min(g.n - 1, Math.floor((x + r) / CELL));
    const c0y = Math.max(0, Math.floor((y - r) / CELL)), c1y = Math.min(g.n - 1, Math.floor((y + r) / CELL));
    const fb = t.fb;
    let best = r;
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
      const k = cy * g.n + cx;
      for (let j = g.start[k]; j < g.start[k + 1]; j++) {
        const i = g.items[j];
        if (h > fb.top[i] || h < fb.bottom[i]) continue;
        if (x < g.bb[4 * i] - best || x > g.bb[4 * i + 2] + best || y < g.bb[4 * i + 1] - best || y > g.bb[4 * i + 3] + best) continue;
        const a = fb.off[i], b = fb.off[i + 1];
        if (inside(fb.xy, a, b, x, y)) return 0;
        for (let v = a; v < b; v++) {
          const w = v + 1 < b ? v + 1 : a;
          const x0 = fb.xy[2 * v], y0 = fb.xy[2 * v + 1], dx = fb.xy[2 * w] - x0, dy = fb.xy[2 * w + 1] - y0;
          const L2 = dx * dx + dy * dy;
          const u = L2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2)) : 0;
          const d = Math.hypot(x - x0 - dx * u, y - y0 - dy * u);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
}

function inside(xy: Float32Array, a: number, b: number, x: number, y: number): boolean {
  let c = false;
  for (let v = a, w = b - 1; v < b; w = v++) {
    const yi = xy[2 * v + 1], yj = xy[2 * w + 1];
    if ((yi > y) !== (yj > y)) {
      const xi = xy[2 * v], xj = xy[2 * w];
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}
