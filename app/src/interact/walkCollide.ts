// Solid world for the walking player: buildings / houses (engine BuildingIndex),
// street furniture, poles, trees and parked cars from the loaded level-0 tiles
// (props / street buffers, collected lazily per tile), plus moving cars and
// transit vehicles supplied per query. A circle (the walker) is pushed out of
// everything it overlaps; the surface under it (carriageway / sidewalk) comes
// from the props road segments.
import type { Engine } from '../engine/Engine';
import type { Tile } from '../render/tiles/TileManager';
import { K, PSTRIDE } from '../workers/props';
import { VEG_STRIDE } from '../layers/vegetation/species';

/** oriented box: centre, heading (rad CCW from +E), half length (along heading), half width */
export interface Box { e: number; n: number; h: number; hl: number; hw: number }

const CELL = 16;
/** circle (r) or box (hl, hw, h) collider, world coords */
interface Solid { e: number; n: number; r: number; h: number; hl: number; hw: number }

interface TileSolids {
  grid: Map<number, Solid[]>;
  /** road segments (world): x0 y0 x1 y1 hw cls */
  segs: Float32Array;
  e0: number;
  n0: number;
}

/** radius of round props, or box half sizes [hl, hw] (heading = prop angle) */
function propShape(k: number): number | [number, number] | null {
  switch (k) {
    case K.HYDRANT: return 0.22;
    case K.BIN: case K.HOUSEBIN: return 0.3;
    case K.NEWS: return [0.28, 0.3];
    case K.POSTBOX: return [0.3, 0.3];
    case K.BENCH: return [0.26, 0.92];
    case K.BIKERING: return 0.12;
    case K.PAYSTATION: return 0.2;
    case K.PLANTER: return 0.55;
    case K.BLADE: return 0.1;
    case K.HYDRO: return 0.2;
    case K.LOTLIGHT: return 0.16;
    case K.CAR: return [2.3, 0.92];
    case K.BIKESHARE: return 0.35;
    case K.BUSPOLE: return 0.08;
    case K.SHELTER: return [0.9, 1.95];
    default: return null;
  }
}

const gkey = (e: number, n: number) => Math.floor(e / CELL) * 1000003 + Math.floor(n / CELL);

export class WalkCollider {
  private cache = new WeakMap<Tile, TileSolids>();
  private engine: Engine;
  /** extra solids refreshed by the caller (TTC stop poles / shelters) */
  extra: Box[] = [];
  constructor(engine: Engine) {
    this.engine = engine;
  }

  private tileSolids(t: Tile): TileSolids | null {
    if (!t.props && !t.street) return null;
    let ts = this.cache.get(t);
    if (ts) return ts;
    const e0 = t.tx * t.S, n0 = t.ty * t.S;
    const grid = new Map<number, Solid[]>();
    const add = (s: Solid) => {
      const R = (s.r || Math.hypot(s.hl, s.hw)) + 0.5;
      for (let gx = Math.floor((s.e - R) / CELL); gx <= Math.floor((s.e + R) / CELL); gx++)
        for (let gy = Math.floor((s.n - R) / CELL); gy <= Math.floor((s.n + R) / CELL); gy++) {
          const k = gx * 1000003 + gy;
          const l = grid.get(k);
          if (l) l.push(s); else grid.set(k, [s]);
        }
    };
    const it = t.props?.items;
    if (it) for (let i = 0; i + PSTRIDE <= it.length; i += PSTRIDE) {
      const sh = propShape(it[i]);
      if (sh === null) continue;
      const e = e0 + it[i + 1], n = n0 + it[i + 2];
      if (typeof sh === 'number') add({ e, n, r: sh, h: 0, hl: 0, hw: 0 });
      else add({ e, n, r: 0, h: it[i + 4], hl: sh[0], hw: sh[1] });
    }
    const st = t.street;
    if (st) {
      for (let i = 0; i + 5 <= st.lamps.length; i += 5) add({ e: e0 + st.lamps[i], n: n0 + st.lamps[i + 1], r: 0.16, h: 0, hl: 0, hw: 0 });
      for (let i = 0; i + 7 <= st.signals.length; i += 7) add({ e: e0 + st.signals[i], n: n0 + st.signals[i + 1], r: 0.2, h: 0, hl: 0, hw: 0 });
      const v = st.veg;
      for (let i = 0; i + VEG_STRIDE <= v.length; i += VEG_STRIDE) {
        const sp = v[i + 6], ht = v[i + 4];
        if (sp === 12 || sp === 13 || ht < 3) continue; // shrubs, hedges
        add({ e: e0 + v[i], n: n0 + v[i + 1], r: Math.min(0.45, 0.15 + ht * 0.012), h: 0, hl: 0, hw: 0 });
      }
    }
    const ls = t.props?.segs ?? new Float32Array(0);
    const segs = new Float32Array(ls.length);
    for (let i = 0; i + 6 <= ls.length; i += 6) {
      segs[i] = e0 + ls[i]; segs[i + 1] = n0 + ls[i + 1]; segs[i + 2] = e0 + ls[i + 2]; segs[i + 3] = n0 + ls[i + 3];
      segs[i + 4] = ls[i + 4]; segs[i + 5] = ls[i + 5];
    }
    ts = { grid, segs, e0, n0 };
    this.cache.set(t, ts);
    return ts;
  }

  private tileAt(e: number, n: number): Tile | undefined {
    const S = this.engine.tiles.manifest?.tileSize[0] ?? 1024;
    return this.engine.tiles.tiles.get(`0/${Math.floor(e / S)}/${Math.floor(n / S)}`);
  }

  /**
   * Push a circle (e, n, radius r, feet at elevation h) out of everything solid.
   * `movers` are cars / transit vehicles near the walker this frame.
   * Returns the resolved position and the total push (0 = free).
   */
  resolve(e: number, n: number, h: number, r: number, movers: Box[]): { e: number; n: number; push: number } {
    let push = 0;
    for (let iter = 0; iter < 3; iter++) {
      let dx = 0, dn = 0;
      // buildings (walls from the feet to head height)
      const b = this.engine.buildings?.pushOut(e, n, h + 1, r);
      if (b) { dx += b[0]; dn += b[1]; }
      const t = this.tileAt(e, n);
      const ts = t ? this.tileSolids(t) : null;
      const cands = ts?.grid.get(gkey(e, n));
      if (cands) for (const s of cands) { const p = pushSolid(e + dx, n + dn, r, s); if (p) { dx += p[0]; dn += p[1]; } }
      for (const m of movers) { const p = pushSolid(e + dx, n + dn, r, { ...m, r: 0 }); if (p) { dx += p[0]; dn += p[1]; } }
      for (const m of this.extra) { const p = pushSolid(e + dx, n + dn, r, { ...m, r: 0 }); if (p) { dx += p[0]; dn += p[1]; } }
      const l = Math.hypot(dx, dn);
      if (l < 1e-4) break;
      // never teleport through thin walls: cap one iteration's push
      const k = l > 1.5 ? 1.5 / l : 1;
      e += dx * k; n += dn * k;
      push += l * k;
    }
    return { e, n, push };
  }

  /**
   * Surface under (e, n): 1 carriageway (road class ≤ 6), 2 sidewalk band
   * beside a street, 0 elsewhere. Uses the props road segments of the tile.
   */
  surface(e: number, n: number): number {
    const t = this.tileAt(e, n);
    const ts = t ? this.tileSolids(t) : null;
    if (!ts) return 0;
    const sg = ts.segs;
    let best = Infinity, cls = 9;
    for (let k = 0; k + 6 <= sg.length; k += 6) {
      const x0 = sg[k], y0 = sg[k + 1];
      if (Math.abs(x0 - e) > 120 && Math.abs(sg[k + 2] - e) > 120) continue;
      if (Math.abs(y0 - n) > 120 && Math.abs(sg[k + 3] - n) > 120) continue;
      const dx = sg[k + 2] - x0, dy = sg[k + 3] - y0, l2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((e - x0) * dx + (n - y0) * dy) / l2));
      const d = Math.hypot(e - x0 - dx * u, n - y0 - dy * u) - sg[k + 4];
      if (d < best) { best = d; cls = sg[k + 5]; }
    }
    if (best <= 0 && cls <= 6) return 1;
    if (best <= 5 && cls >= 2 && cls <= 5) return 2;
    return 0;
  }
}

/** push of circle (e, n, r) out of a solid, or null */
function pushSolid(e: number, n: number, r: number, s: Solid): [number, number] | null {
  if (s.r > 0) {
    const dx = e - s.e, dn = n - s.n, d = Math.hypot(dx, dn), R = r + s.r;
    if (d >= R) return null;
    if (d < 1e-4) return [R, 0];
    return [(dx / d) * (R - d), (dn / d) * (R - d)];
  }
  const c = Math.cos(s.h), sn = Math.sin(s.h);
  const dx = e - s.e, dn = n - s.n;
  if (Math.abs(dx) > s.hl + s.hw + r || Math.abs(dn) > s.hl + s.hw + r) return null;
  const a = dx * c + dn * sn, b = -dx * sn + dn * c;
  const ca = Math.max(-s.hl, Math.min(s.hl, a)), cb = Math.max(-s.hw, Math.min(s.hw, b));
  let pa: number, pb: number;
  if (ca === a && cb === b) {
    // centre inside the box: out through the nearest side
    const ea = s.hl - Math.abs(a), eb = s.hw - Math.abs(b);
    if (ea < eb) { pa = Math.sign(a || 1) * (ea + r); pb = 0; } else { pa = 0; pb = Math.sign(b || 1) * (eb + r); }
  } else {
    const qa = a - ca, qb = b - cb, d = Math.hypot(qa, qb);
    if (d >= r) return null;
    pa = (qa / d) * (r - d); pb = (qb / d) * (r - d);
  }
  return [pa * c - pb * sn, pa * sn + pb * c];
}
