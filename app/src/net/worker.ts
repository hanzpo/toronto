import { build } from './core/build';
import { loadTile } from './tiles';
import type { Built } from './core/model';
import { fetchTbn } from '../data/tbn';

export interface NetJob { id: number; root: string; tx: number; ty: number; size: number }
export type NetBuilt = Omit<Built, 'meshes' | 'lanes'> & { meshes: [string, Float32Array, Float32Array, Uint32Array][]; lanes: number; ground?: Uint8Array };

self.onmessage = async (ev: MessageEvent<NetJob>) => {
  const { id, root, tx, ty, size } = ev.data;
  try {
    const desc = await loadTile(root, tx, ty);
    if (!desc) { (self as unknown as Worker).postMessage({ id, empty: true }); return; }
    const t0 = performance.now();
    const b = build(desc, { origin: { x: tx * size, y: ty * size } });
    const meshes: NetBuilt['meshes'] = [...b.meshes].map(([m, q]) => [m, q.pos, q.uv, q.idx]);
    const tr: Transferable[] = meshes.flatMap(([, p, u, i]) => [p.buffer, u.buffer, i.buffer]);
    if (b.terrain) tr.push(b.terrain.h.buffer);
    const old = await fetchTbn(root.replace(/\/net$/, '') + `/tiles/0/${tx}_${ty}.bin.gz`).catch(() => null);
    const ground = old?.arrays.ground as Uint8Array | undefined;
    if (ground) tr.push(ground.buffer);
    const out: NetBuilt = { ...b, meshes, lanes: b.lanes.length, ground };
    (self as unknown as Worker).postMessage({ id, built: out, ms: performance.now() - t0 }, tr);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String((e as Error)?.stack ?? e) });
  }
};
