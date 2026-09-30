// Height of the *rendered* terrain under a point, for placing cars and
// pedestrians exactly on the drawn ground/road surface. Samples the finest
// terrain tile that is currently drawn (so agents follow the same triangles the
// user sees, and move with them across LOD switches), falling back to the
// finest loaded one. Same triangle split as TileManager.heightAt.
import type { TileManager, Tile } from '../../render/tiles/TileManager';

export class GroundSampler {
  private tm: TileManager;
  /** per level-0 cell (packed tx, ty) → tile to sample this frame */
  private cache = new Map<number, Tile | null>();
  private lastKey = NaN;
  private lastTile: Tile | null = null;
  private S0 = 1024;

  constructor(tm: TileManager) {
    this.tm = tm;
  }

  /** call once per frame (tiles may have been drawn / refined since) */
  begin() {
    this.cache.clear();
    this.lastKey = NaN;
    this.lastTile = null;
    this.S0 = this.tm.manifest?.tileSize['0'] ?? 1024;
  }

  private pick(tx: number, ty: number): Tile | null {
    const tiles = this.tm.tiles;
    let loaded: Tile | null = null;
    let x = tx, y = ty;
    for (let L = 0; L <= 2; L++) {
      if (L > 0) { x = Math.floor(x / 4); y = Math.floor(y / 4); }
      const t = tiles.get(`${L}/${x}/${y}`);
      if (!t || !t.heights) continue;
      if (t.drawn) return t;
      loaded ??= t;
    }
    return loaded;
  }

  /** rendered terrain elevation (datum m) at world E/N, or NaN when nothing is loaded */
  at(e: number, n: number): number {
    const tx = Math.floor(e / this.S0), ty = Math.floor(n / this.S0);
    const k = tx * 131072 + ty;
    let t: Tile | null | undefined;
    if (k === this.lastKey) t = this.lastTile;
    else {
      t = this.cache.get(k);
      if (t === undefined) { t = this.pick(tx, ty); this.cache.set(k, t); }
      this.lastKey = k;
      this.lastTile = t;
    }
    if (!t || !t.heights) return NaN;
    const S = t.S, G = t.grid, c = S / (G - 1), h = t.heights;
    let fx = (e - t.tx * S) / c, fy = (n - t.ty * S) / c;
    fx = Math.min(Math.max(fx, 0), G - 1.0001); fy = Math.min(Math.max(fy, 0), G - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const h00 = h[j * G + i], h10 = h[j * G + i + 1], h01 = h[(j + 1) * G + i], h11 = h[(j + 1) * G + i + 1];
    return u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + v * (h01 - h00) + u * (h11 - h01);
  }
}
