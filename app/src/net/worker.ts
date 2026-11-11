import { build } from './core/build';
import { loadTile } from './tiles';
import type { Built } from './core/model';
import { fetchTbn } from '../data/tbn';
import { placeNetTile } from '../workers/vegetation';

export interface NetJob { id: number; root: string; tx: number; ty: number; size: number }
export type NetBuilt = Omit<Built, 'meshes' | 'lanes'> & { meshes: [string, Float32Array, Float32Array, Uint32Array][]; lanes: number; ground?: Uint8Array; veg?: Float32Array; vegCells?: Uint32Array };

self.onmessage = async (ev: MessageEvent<NetJob>) => {
  const { id, root, tx, ty, size } = ev.data;
  try {
    const desc = await loadTile(root, tx, ty);
    if (!desc) { (self as unknown as Worker).postMessage({ id, empty: true }); return; }
    const t0 = performance.now();
    const b = build(desc, { origin: { x: tx * size, y: ty * size } });
    const meshes: NetBuilt['meshes'] = [...b.meshes].map(([m, q]) => [m, q.pos, q.uv, q.idx]);
    const tr: Transferable[] = meshes.flatMap(([, p, u, i]) => [p.buffer, u.buffer, i.buffer]);
    const old = await fetchTbn(root.replace(/\/net$/, '') + `/tiles/0/${tx}_${ty}.bin.gz`).catch(() => null);
    let veg: Float32Array | undefined, vegCells: Uint32Array | undefined;
    if (old?.arrays.ground && b.terrain) {
      const g = b.terrain, ox = tx * size, oy = ty * size;
      const at = (x: number, y: number) => {
        const fx = (x + ox - g.x0) / g.cell, fy = (y + oy - g.y0) / g.cell;
        const i = Math.max(0, Math.min(g.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(g.ny - 2, Math.floor(fy)));
        const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j));
        const h = g.h, n = g.nx;
        return h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v;
      };
      const vb = placeNetTile(old.arrays, b, tx, ty, size, { cell: g.cell, at });
      veg = vb.veg; vegCells = vb.cells;
      tr.push(veg.buffer, vegCells.buffer);
    }
    if (b.terrain) tr.push(b.terrain.h.buffer);
    const ground = old?.arrays.ground as Uint8Array | undefined;
    if (ground) tr.push(ground.buffer);
    const out: NetBuilt = { ...b, meshes, lanes: b.lanes.length, ground, veg, vegCells };
    (self as unknown as Worker).postMessage({ id, built: out, ms: performance.now() - t0 }, tr);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String((e as Error)?.stack ?? e) });
  }
};
