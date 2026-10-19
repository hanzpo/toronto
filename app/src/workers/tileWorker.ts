// Tile worker: fetch + gunzip + decode TBN1 + build transferable geometry.
import { decodeTbn } from '../data/tbn';

import { buildBuildings, buildRail, buildRoads, buildTerrain, concatMeshes, extractHouses, frontSurfaces, promoteNonHouses, TerrainSampler, type MeshBuf, type TileMeshes } from './meshing';
import { buildProps } from './props';
import { setHeritage } from './buildings';
import { buildUrban } from './urban';
import { houseRoofQa } from './houseFront';
import { buildStreet } from './street';
import { buildGround, cutData } from './ground';
import { buildCanopy } from './vegetation';
import { extractFootprints } from './collide';
import { applyStationZones, setStationZones } from './stationZones';
import { dropAirsideTile } from './airside';
import { SURF_CURB, SURF_TACTILE } from './roads';
import { dropNet2 } from '../net2/tileFilter';
import { buildSurface, SurfaceSampler, structuresOnly, surfaceFurniture, surfaceRails } from './surface';

/** road surfaces only drawn on tiles near the camera (TileManager ROAD_NEAR): vertical curb faces, tactile plates */
const NEAR_SURFS = new Set([SURF_CURB, SURF_TACTILE]);

export type WorkerIn =
  | { type: 'config'; suppress: number[]; heritage?: number[]; build: number; zones?: number[][]; vground?: boolean; surf?: boolean; net2?: number[] | null }
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
/** level-0 vector ground (off with ?vground=0, for A/B checks) */
let useVGround = true;
/** unified at-grade surface (`?surf=1`, docs/SURFACE.md) where the tile carries sf_* */
let useSurf = false;
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

let net2Box: number[] | null = null;

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'config') {
    suppress = new Set(msg.suppress);
    setHeritage(msg.heritage ?? []);
    useVGround = msg.vground !== false;
    useSurf = msg.surf === true;
    net2Box = msg.net2 ?? null;
    setStationZones(msg.zones);
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
    const { arrays: a, header } = decodeTbn<{ names?: string[] }>(buf);
    if (level === 0) applyStationZones(a, msg.tx * size, msg.ty * size, size);
    if (level === 0) await dropAirsideTile(a, url, msg.tx * size, msg.ty * size, size); // apron roads: drawn by AirportLayer
    if (level === 0 && net2Box) dropNet2(a, net2Box, msg.tx * size, msg.ty * size);   // ?net=2: the slice draws these
    const G = (a.terrain_h ? Math.round(Math.sqrt(a.terrain_h.length)) : grid) || grid;
    const terr = buildTerrain(a.terrain_h as Int16Array, G, size, level);
    const sampler = new TerrainSampler(terr.heights, G, size);
    const embList: number[] = [];
    // ?surf=1: one surface mesh replaces terrain / vector ground / ribbons / sidewalks / medians / beds;
    // placement (props, lamps, trees, rails) samples that surface
    const surf = level === 0 && useSurf ? buildSurface(a, size) : null;
    const place = surf ? new SurfaceSampler(sampler, surf.index) : sampler;
    const vground = surf ? surf.mesh : level === 0 && useVGround ? buildGround(a, sampler, a.ground as Uint8Array | undefined, embList) : null;
    const emb = embList.length ? Float32Array.from(embList) : null;
    const cuts = level === 0 ? cutData(a, size) : null;
    // houses first: footprints that aren't houses (long / narrow) join the extruded buildings
    let houses = level === 0 ? extractHouses(a, suppress, msg.tx * size, msg.ty * size, header.names) : null;
    if (houses) { houses = promoteNonHouses(a, houses).hb; houses.qa = houseRoofQa(houses, a, msg.tx * size, msg.ty * size); }
    const bld = buildBuildings(a, suppress, level, msg.tx * size, msg.ty * size, sampler, header.names);
    const ground = a.ground ? (a.ground as Uint8Array).slice() : new Uint8Array(256 * 256);
    const roads = buildRoads(a, sampler, level, ground);
    // ?surf=1: decks / parapets / piers from the road mesher, plus barriers, guardrails and tactile plates on the surface
    if (surf) roads.mesh = concatMeshes(buildRoads(structuresOnly(a, 'r'), place, level, ground).mesh, surfaceFurniture(a, surf.index, size));
    const rail = surf
      ? { mesh: concatMeshes(buildRail(structuresOnly(a, 'l'), place, level).mesh, surfaceRails(a, surf.index, size)), count: 0 }
      : buildRail(a, sampler, level);
    const street = level === 0 ? buildStreet(a, roads.streets, roads.junctions, place, ground, msg.tx, msg.ty) : null;
    const props = level === 0 ? buildProps(a, header.names ?? [], roads.streets, roads.junctions, place, ground, houses, msg.tx, msg.ty) : null;
    // rooftops (from buildBuildings), construction sites, laneways: layers/UrbanLayer.ts
    const urban = level === 0 ? buildUrban(a, header.names ?? [], bld.items, place, ground, houses, msg.tx, msg.ty) : null;
    const canopy = level === 1 ? buildCanopy(a, ground, sampler, msg.tx, msg.ty, size) : null;
    const street3d = concatMeshes(roads.mesh, rail.mesh);
    const railStart = roads.mesh ? roads.mesh.index.length : 0;
    const roadNear = street3d && level === 0 ? frontSurfaces(street3d, railStart, NEAR_SURFS) : 0;
    const collide = level === 0 ? extractFootprints(a, suppress) : null;
    const result: TileMeshes = {
      terrain: terr.mesh, vground, cuts, emb, surf: surf?.index ?? null, heights: terr.heights, grid: G, ground, minH: terr.minH, maxH: Math.max(terr.maxH, 0),
      buildings: bld.mesh, collide, roads: street3d, railStart, roadNear, terrainCoarse: terr.coarseStart, houses, street, canopy, props, urban,
      counts: { buildings: bld.count, houses: houses?.count ?? 0, roads: roads.count, rails: rail.count },
    };
    const tr: Transferable[] = [terr.heights.buffer, ground.buffer];
    if (collide) tr.push(collide.off.buffer, collide.xy.buffer, collide.bottom.buffer, collide.top.buffer, ...(collide.occ ? [collide.occ.buffer] : []));
    transfers(terr.mesh, tr); transfers(vground, tr);
    if (surf) tr.push(surf.index.idx.buffer, surf.index.off.buffer, surf.index.tris.buffer); // index.pos is the mesh's position buffer
    if (cuts) tr.push(cuts.off.buffer, cuts.xy.buffer, cuts.type.buffer, cuts.toff.buffer, cuts.txyz.buffer, cuts.tkind.buffer, cuts.box.buffer); transfers(bld.mesh, tr); transfers(street3d, tr);
    if (canopy) tr.push(canopy.buffer);
    if (emb) tr.push(emb.buffer);
    if (urban) tr.push(urban.items.buffer);
    if (props) { tr.push(props.items.buffer, props.segs.buffer); transfers(props.ground, tr); }
    if (street) tr.push(street.veg.buffer, street.vegCells.buffer, street.lamps.buffer, street.signals.buffer, street.signalIds.buffer);
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
