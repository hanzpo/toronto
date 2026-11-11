// Far road and rail ribbons from the network model (net/bake.ts far tiles): flat strips draped on
// the tile's own terrain, raised by the solved height over the ground on bridges, gone in tunnels.
// Tile-local three.js axes (x = E, y = elev, z = -N); attributes as render/tiles/roadMaterial.ts reads them.
import type { TypedArray } from '../data/tbn';
import type { MeshBuf } from './meshing';

export interface Terrain { cell: number; at(e: number, n: number): number }

const SURF_ROAD = 0, SURF_BALLAST = 7;
const VF_BRIDGE = 1, VF_TUNNEL = 2;
const PATH_CLASS = 8, TRAM_CLASS = 4;
const ROAD_W_MIN = [10, 10, 7, 6, 6, 5, 3.5];
const WIDEN = [1, 1.6, 3.2];
const RAIL_HW = 1.8;
const RAIL_WIDEN = [1, 2, 4];
const BALLAST = [150, 140, 128];
const FAR = 1e4;

class Strip {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; rd: number[] = []; rm: number[] = []; jn: number[] = []; idx: number[] = [];
  v(x: number, y: number, z: number, u: number, s: number, hw: number, code: number, rgb: number[], prio: number) {
    this.pos.push(x, y, z);
    this.nrm.push(0, 127, 0, 0);
    this.col.push(rgb[0], rgb[1], rgb[2], Math.round(prio * 25));
    this.rd.push(u, s, hw, hw);
    this.rm.push(0, code, 3.5, 0);
    this.jn.push(FAR, FAR, 0, 0);
    return this.pos.length / 3 - 1;
  }
  get empty() { return this.idx.length === 0; }
  finish(): MeshBuf | null {
    if (this.empty) return null;
    const n = this.pos.length / 3;
    return {
      position: Float32Array.from(this.pos), normal: Int8Array.from(this.nrm), color: Uint8Array.from(this.col),
      index: n < 65536 ? Uint16Array.from(this.idx) : Uint32Array.from(this.idx),
      attrs: {
        rd: { array: Float32Array.from(this.rd), size: 4 }, rm: { array: Float32Array.from(this.rm), size: 4 }, jn: { array: Float32Array.from(this.jn), size: 4 },
      },
    };
  }
}

function ribbons(b: Strip, a: Record<string, TypedArray>, p: 'r' | 'l', terr: Terrain, step: number, style: (i: number) => { hw: number; code: number; rgb: number[]; prio: number } | null) {
  const off = a[`${p}_off`] as Uint32Array | undefined;
  if (!off || off.length < 2) return 0;
  const xyz = a[`${p}_xyz`] as Float32Array, dz = a[`${p}_dz`] as Float32Array, vf = a[`${p}_vf`] as Uint8Array;
  let count = 0;
  for (let i = 0; i < off.length - 1; i++) {
    const st = style(i);
    if (!st) continue;
    const xs: number[] = [], ys: number[] = [], ds: number[] = [], fs: number[] = [];
    for (let k = off[i]; k < off[i + 1]; k++) {
      if (k > off[i]) {
        const x0 = xyz[k * 3 - 3], y0 = xyz[k * 3 - 2], x1 = xyz[k * 3], y1 = xyz[k * 3 + 1];
        const m = Math.floor(Math.hypot(x1 - x0, y1 - y0) / step);
        for (let q = 1; q <= m; q++) {
          const t = q / (m + 1);
          xs.push(x0 + (x1 - x0) * t); ys.push(y0 + (y1 - y0) * t); ds.push(dz[k - 1] + (dz[k] - dz[k - 1]) * t); fs.push(vf[k - 1] & vf[k]);
        }
      }
      xs.push(xyz[k * 3]); ys.push(xyz[k * 3 + 1]); ds.push(dz[k]); fs.push(vf[k]);
    }
    const n = xs.length;
    if (n < 2) continue;
    count++;
    let s = 0, prev: number[] | null = null;
    for (let k = 0; k < n; k++) {
      if (k) s += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
      if (fs[k] & VF_TUNNEL && (k === 0 || fs[k - 1] & VF_TUNNEL)) { prev = null; continue; }
      const kp = Math.max(0, k - 1), kn = Math.min(n - 1, k + 1);
      let tx = xs[kn] - xs[kp], ty = ys[kn] - ys[kp];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const ox = -ty * st.hw, oy = tx * st.hw;
      const g = terr.at(xs[k], ys[k]);
      const y = fs[k] & VF_BRIDGE ? g + Math.max(0, ds[k]) : g;
      const cur = [
        b.v(xs[k] + ox, y, -(ys[k] + oy), st.hw, s, st.hw, st.code, st.rgb, st.prio),
        b.v(xs[k] - ox, y, -(ys[k] - oy), -st.hw, s, st.hw, st.code, st.rgb, st.prio),
      ];
      if (prev) b.idx.push(prev[0], prev[1], cur[1], prev[0], cur[1], cur[0]);
      prev = cur;
    }
  }
  return count;
}

/** Road ribbons, then rail beds (rail = indices from `railStart`), for a tile of the given level. */
export function buildFar(a: Record<string, TypedArray>, terr: Terrain, level: number): { mesh: MeshBuf | null; railStart: number; roads: number; rails: number } {
  const step = Math.max(20, terr.cell);
  const b = new Strip();
  const cls = a.r_class as Uint8Array | undefined, wid = a.r_width as Float32Array | undefined, fl = a.r_flags as Uint8Array | undefined;
  const widen = WIDEN[level] ?? 1;
  const roads = ribbons(b, a, 'r', terr, step, (i) => {
    const c = cls![i];
    if (c >= PATH_CLASS) return null;
    const w = Math.max(wid![i], ROAD_W_MIN[c] ?? 3.5) * widen;
    return { hw: w / 2, code: c + 16 * (fl![i] & 1) + 32 * SURF_ROAD, rgb: [255, 255, 255], prio: 5.5 - c * 0.5 };
  });
  const railStart = b.idx.length;
  const lc = a.l_class as Uint8Array | undefined;
  const rails = ribbons(b, a, 'l', terr, step, (i) => {
    if (lc![i] === TRAM_CLASS) return null;
    return { hw: RAIL_HW * (RAIL_WIDEN[level] ?? 1), code: 8 + 32 * SURF_BALLAST, rgb: BALLAST, prio: 0.5 };
  });
  return { mesh: b.finish(), railStart, roads, rails };
}
