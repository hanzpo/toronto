// Tile worker: fetch + gunzip + decode TBN1 + build transferable geometry.
import { decodeTbn } from '../data/tbn';

/** gunzip unless the server/browser already decoded it (Content-Encoding: gzip) */
async function bodyBytes(res: Response): Promise<ArrayBuffer> {
  const raw = await res.arrayBuffer();
  const u = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
  if (u[0] !== 0x1f || u[1] !== 0x8b) return raw;
  const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}
import { buildBuildings, buildRail, buildRoads, buildTerrain, extractHouses, TerrainSampler, type MeshBuf, type TileMeshes } from './meshing';

export type WorkerIn =
  | { type: 'config'; suppress: number[] }
  | { type: 'load'; id: number; url: string; level: number; tx: number; ty: number; size: number; grid: number }
  | { type: 'cancel'; id: number };

export type WorkerOut =
  | { type: 'done'; id: number; result: TileMeshes; ms: { fetch: number; mesh: number } }
  | { type: 'empty'; id: number }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string };

let suppress = new Set<number>();
const jobs = new Map<number, AbortController>();

function transfers(m: MeshBuf | null, out: Transferable[]) {
  if (!m) return;
  out.push(m.position.buffer, m.normal.buffer, m.index.buffer);
  if (m.color) out.push(m.color.buffer);
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'config') {
    suppress = new Set(msg.suppress);
    return;
  }
  if (msg.type === 'cancel') {
    jobs.get(msg.id)?.abort();
    return;
  }
  const { id, url, level, size, grid } = msg;
  const ac = new AbortController();
  jobs.set(id, ac);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (res.status === 404) { post({ type: 'empty', id }); return; }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = await bodyBytes(res);
    if (ac.signal.aborted) { post({ type: 'cancelled', id }); return; }
    const t1 = performance.now();
    const { arrays: a } = decodeTbn(buf);
    const G = (a.terrain_h ? Math.round(Math.sqrt(a.terrain_h.length)) : grid) || grid;
    const terr = buildTerrain(a.terrain_h as Int16Array, G, size, level);
    const sampler = new TerrainSampler(terr.heights, G, size);
    const bld = buildBuildings(a, suppress, level);
    const roads = buildRoads(a, sampler, level);
    const rail = buildRail(a, sampler, level);
    const houses = level === 0 ? extractHouses(a, suppress) : null;
    const ground = a.ground ? (a.ground as Uint8Array).slice() : new Uint8Array(256 * 256);
    const result: TileMeshes = {
      terrain: terr.mesh, heights: terr.heights, grid: G, ground, minH: terr.minH, maxH: Math.max(terr.maxH, 0),
      buildings: bld.mesh, roads: roads.mesh, rail: rail.mesh, houses,
      counts: { buildings: bld.count, houses: houses?.count ?? 0, roads: roads.count, rails: rail.count },
    };
    const tr: Transferable[] = [terr.heights.buffer, ground.buffer];
    transfers(terr.mesh, tr); transfers(bld.mesh, tr); transfers(roads.mesh, tr); transfers(rail.mesh, tr);
    if (houses) tr.push(houses.xy.buffer, houses.base.buffer, houses.angle.buffer, houses.len.buffer, houses.wid.buffer, houses.height.buffer, houses.type.buffer, houses.variant.buffer);
    post({ type: 'done', id, result, ms: { fetch: t1 - t0, mesh: performance.now() - t1 } }, tr);
  } catch (e) {
    if (ac.signal.aborted) post({ type: 'cancelled', id });
    else post({ type: 'error', id, message: String((e as Error)?.stack ?? e) });
  } finally {
    jobs.delete(id);
  }
};

function post(m: WorkerOut, tr: Transferable[] = []) {
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, tr);
}
