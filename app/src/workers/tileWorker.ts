// Tile worker: fetch + gunzip + decode TBN1 + build transferable geometry.
import { decodeTbn } from '../data/tbn';

import { buildBuildings, buildRail, buildRoads, buildTerrain, concatMeshes, extractHouses, TerrainSampler, type MeshBuf, type TileMeshes } from './meshing';
import { buildStreet } from './street';

export type WorkerIn =
  | { type: 'config'; suppress: number[]; build: number }
  | { type: 'prefetch'; url: string }
  | { type: 'load'; id: number; url: string; level: number; tx: number; ty: number; size: number; grid: number }
  | { type: 'cancel'; id: number };

export type WorkerOut =
  | { type: 'done'; id: number; result: TileMeshes; ms: { fetch: number; mesh: number }; src: TileSource }
  | { type: 'empty'; id: number }
  | { type: 'cancelled'; id: number }
  | { type: 'prefetched'; url: string }
  | { type: 'error'; id: number; message: string };

let suppress = new Set<number>();
/** where tile bytes came from: local Cache Storage, CDN edge cache, or R2 (edge miss) */
export type TileSource = 'local' | 'edge' | 'origin';
const sources = new Map<string, TileSource>();

// ---------------------------------------------------------------- persistent tile cache
// Compressed tile bytes live in Cache Storage keyed by data build, so revisits
// and reloads skip the network entirely; old builds are dropped on startup.
const CACHE_PREFIX = 'tiles-';
let cacheName = `${CACHE_PREFIX}0`;
let cacheP: Promise<Cache | null> = Promise.resolve(null);
const inflight = new Map<string, Promise<ArrayBuffer | null>>();

function openCache(build: number) {
  cacheName = `${CACHE_PREFIX}${build}`;
  if (typeof caches === 'undefined') return;
  cacheP = caches.open(cacheName).catch(() => null);
  caches.keys().then((ks) => ks.forEach((k) => k.startsWith(CACHE_PREFIX) && k !== cacheName && caches.delete(k))).catch(() => {});
}

/** Compressed bytes for a tile URL (cache → network), or null on 404. Network
 * downloads are shared between a prefetch and a real load of the same tile
 * and are never aborted, so bytes already in flight end up cached. */
function tileBytes(url: string): Promise<ArrayBuffer | null> {
  let p = inflight.get(url);
  if (p) return p;
  p = (async () => {
    const cache = await cacheP;
    const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
    if (hit) { sources.set(url, 'local'); return hit.arrayBuffer(); }
    const res = await fetch(url);
    sources.set(url, /cache;desc=hit/.test(res.headers.get('server-timing') ?? '') ? 'edge' : 'origin');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (cache) cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
    return buf;
  })().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

async function gunzipBytes(raw: ArrayBuffer): Promise<ArrayBuffer> {
  const u = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
  if (u[0] !== 0x1f || u[1] !== 0x8b) return raw;
  const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}
const jobs = new Map<number, AbortController>();
/** urls of in-flight loads (a prefetch must not drop their source record) */
const jobsByUrl = new Set<string>();

function transfers(m: MeshBuf | null, out: Transferable[]) {
  if (!m) return;
  out.push(m.position.buffer, m.normal.buffer, m.index.buffer);
  if (m.color) out.push(m.color.buffer);
  if (m.attrs) for (const k in m.attrs) out.push(m.attrs[k].array.buffer);
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'config') {
    suppress = new Set(msg.suppress);
    openCache(msg.build);
    return;
  }
  if (msg.type === 'prefetch') {
    tileBytes(msg.url).catch(() => null).finally(() => { if (!jobsByUrl.has(msg.url)) sources.delete(msg.url); post({ type: 'prefetched', url: msg.url }); });
    return;
  }
  if (msg.type === 'cancel') {
    jobs.get(msg.id)?.abort();
    return;
  }
  const { id, url, level, size, grid } = msg;
  const ac = new AbortController();
  jobs.set(id, ac);
  jobsByUrl.add(url);
  const t0 = performance.now();
  try {
    const raw = await tileBytes(url);
    if (ac.signal.aborted) { post({ type: 'cancelled', id }); return; }
    if (!raw) { post({ type: 'empty', id }); return; }
    const buf = await gunzipBytes(raw);
    if (ac.signal.aborted) { post({ type: 'cancelled', id }); return; }
    const t1 = performance.now();
    const { arrays: a } = decodeTbn(buf);
    const G = (a.terrain_h ? Math.round(Math.sqrt(a.terrain_h.length)) : grid) || grid;
    const terr = buildTerrain(a.terrain_h as Int16Array, G, size, level);
    const sampler = new TerrainSampler(terr.heights, G, size);
    const bld = buildBuildings(a, suppress, level);
    const ground = a.ground ? (a.ground as Uint8Array).slice() : new Uint8Array(256 * 256);
    const roads = buildRoads(a, sampler, level, ground);
    const rail = buildRail(a, sampler, level);
    const houses = level === 0 ? extractHouses(a, suppress) : null;
    const street = level === 0 ? buildStreet(a, roads.streets, roads.junctions, sampler, ground, msg.tx, msg.ty) : null;
    const street3d = concatMeshes(roads.mesh, rail.mesh);
    const result: TileMeshes = {
      terrain: terr.mesh, heights: terr.heights, grid: G, ground, minH: terr.minH, maxH: Math.max(terr.maxH, 0),
      buildings: bld.mesh, roads: street3d, railStart: roads.mesh ? roads.mesh.index.length : 0, houses, street,
      counts: { buildings: bld.count, houses: houses?.count ?? 0, roads: roads.count, rails: rail.count },
    };
    const tr: Transferable[] = [terr.heights.buffer, ground.buffer];
    transfers(terr.mesh, tr); transfers(bld.mesh, tr); transfers(street3d, tr);
    if (street) tr.push(street.trees.buffer, street.lamps.buffer, street.signals.buffer, street.signalIds.buffer);
    if (houses) tr.push(houses.xy.buffer, houses.base.buffer, houses.angle.buffer, houses.len.buffer, houses.wid.buffer, houses.height.buffer, houses.type.buffer, houses.variant.buffer);
    const src = sources.get(url) ?? 'local';
    sources.delete(url);
    post({ type: 'done', id, result, ms: { fetch: t1 - t0, mesh: performance.now() - t1 }, src }, tr);
  } catch (e) {
    if (ac.signal.aborted) post({ type: 'cancelled', id });
    else post({ type: 'error', id, message: String((e as Error)?.stack ?? e) });
  } finally {
    jobs.delete(id);
    jobsByUrl.delete(url);
  }
};

function post(m: WorkerOut, tr: Transferable[] = []) {
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, tr);
}
