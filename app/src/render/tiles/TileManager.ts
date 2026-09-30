// Quadtree-ish (4×4 split) tile streaming: LOD selection, prioritized loading
// through a worker pool, cancellation, LRU eviction and hole-free transitions.
import * as THREE from 'three/webgpu';
import type { WorkerIn, WorkerOut } from '../../workers/tileWorker';
import type { MeshBuf, TileMeshes } from '../../workers/meshing';
import { GroundPage, GROUND_LAYERS, vertexColorMaterial } from './materials';
import { roadMaterial } from './roadMaterial';
import type { StreetBuf } from '../../workers/street';
import { HousePools } from './houses';
import type { FrameContext } from '../../engine/types';
import { useApp } from '../../state/store';

export interface Manifest {
  version: number;
  /** data build id; appended to tile URLs as ?v= for cache busting */
  build?: number;
  tileSize: Record<string, number>;
  terrainGrid: Record<string, number>;
  groundRes: number;
  bounds: [number, number, number, number];
  tiles: Record<string, [number, number][]>;
  region?: [number, number][][];
  municipalities?: { name: string; label: [number, number] }[];
  synthetic?: boolean;
}

type TileState = 'none' | 'loading' | 'ready' | 'empty' | 'error';

export interface Tile {
  key: string;
  L: number;
  tx: number;
  ty: number;
  S: number;
  state: TileState;
  jobId: number;
  group: THREE.Group | null;
  terrain: THREE.Mesh | null;
  buildings: THREE.Mesh | null;
  /** roads + sidewalks + rail in one mesh; rail = indices from `railStart` */
  roads: THREE.Mesh | null;
  railStart: number;
  /** draw range state last applied (roads on, rail on) */
  streetMask: number;
  heights: Float32Array | null;
  grid: number;
  minH: number;
  maxH: number;
  houses: TileMeshes['houses'];
  housesShown: boolean;
  /** street furniture placements (level 0), consumed by StreetLayer */
  street: StreetBuf | null;
  page: GroundPage | null;
  layer: number;
  bytes: number;
  lastUsed: number;
  drawn: boolean;
  requestedAt: number;
  priority: number;
  kids: Tile[] | null;
  counts: TileMeshes['counts'] | null;
  retryAt: number;
  /** LOD hysteresis: currently refined into children */
  refined: boolean;
}

const key = (L: number, tx: number, ty: number) => `${L}/${tx}/${ty}`;

function attrBytes(m: MeshBuf): number {
  let b = 0;
  if (m.attrs) for (const k in m.attrs) b += m.attrs[k].array.byteLength;
  return b;
}

function meshBytes(r: TileMeshes): number {
  let b = 0;
  for (const m of [r.terrain, r.buildings, r.roads]) {
    if (m) b += m.position.byteLength + m.normal.byteLength + m.index.byteLength + (m.color?.byteLength ?? 0) + attrBytes(m);
  }
  return b;
}

/** Distance (m) below which a tile of level L is refined into its children. */
const REFINE_K: Record<number, number> = { 2: 0.85, 1: 1.0 };
/**
 * Detail rings at street level: level-0 tiles (full street detail) are only
 * refined in while an L1 tile is within ~1.9 km; beyond that the L1 tiles
 * (simplified buildings ≥ 12 m, roads in the ground raster) stand in, seen at
 * grazing angles. From higher up the full range comes back (houses, roads
 * seen from above), reaching the old 1.0 by ~1.1 km altitude.
 */
function refineL1(altitude: number) {
  return Math.min(1, 0.46 + Math.max(0, altitude) / 2000);
}
/** a refined tile only merges back once 25% further away than it refined (no LOD thrash) */
const HYSTERESIS = 1.25;
/** max geometry bytes turned into GPU objects per frame (uploads happen at render) */
const UPLOAD_BUDGET = 12 * 1024 * 1024;

const MAX_BYTES = 900 * 1024 * 1024;
const MAX_TILES = 1400;

export class TileManager {
  manifest!: Manifest;
  root = new THREE.Group();
  houses = new HousePools();
  tiles = new Map<string, Tile>();
  roots: Tile[] = [];
  private workers: Worker[] = [];
  private workerLoad: number[] = [];
  private jobs = new Map<number, Tile>();
  private jobSeq = 1;
  private results: { tile: Tile; res: TileMeshes }[] = [];
  private pages: GroundPage[] = [];
  private drawnList: Tile[] = [];
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private box = new THREE.Box3();
  private now = 0;
  private requests: Tile[] = [];
  // prefetch: speculative network fetches into the worker's Cache Storage
  private prefetched = new Set<string>();
  private prefetchInFlight = 0;
  private vel = { e: 0, n: 0, h: 0, lastE: NaN, lastN: NaN, lastH: NaN };
  private pfList: { t: Tile; d: number }[] = [];
  readonly buildingMat = vertexColorMaterial('buildings', { emissiveWindows: true });
  /** one street material for roads, sidewalks and rail (shared shader) */
  readonly roadMat = roadMaterial('roads');
  readonly railMat = this.roadMat;
  bytes = 0;
  readyCount = 0;
  loadMs: number[] = [];
  /** network/cache time per tile (ms), all tiles since the last reset (benchmarks) */
  fetchLog: number[] = [];
  /** tiles loaded per source since start (RUM: local Cache Storage / CDN edge / R2) */
  sourceCounts = { local: 0, edge: 0, origin: 0 };
  /** time spent building GPU objects on the main thread (last 50 tiles) */
  buildMs: number[] = [];
  onFirstReady: (() => void) | null = null;
  /** set by the engine: compile a new page's material off the critical path */
  warm: ((obj: THREE.Object3D) => void) | null = null;
  lodScale = 1;
  /** altitude-dependent L1 refinement factor (street-level detail rings) */
  private l1K = 1;

  dataRoot: string;
  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    this.root.name = 'tiles';
    this.root.add(this.houses.group);
    // ~1000 static tile groups: skip them in the per-frame scene matrix walk
    // (each tile group computes its world matrix once when built; the house
    // pools are refreshed in update())
    this.root.matrixWorldAutoUpdate = false;
  }

  async init() {
    const r = await fetch(`${this.dataRoot}/manifest.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
    this.manifest = await r.json();
    for (const L of ['0', '1', '2']) {
      for (const [tx, ty] of this.manifest.tiles[L] ?? []) {
        const l = +L;
        const S = this.manifest.tileSize[L];
        const t: Tile = {
          key: key(l, tx, ty), L: l, tx, ty, S, state: 'none', jobId: 0, group: null, terrain: null,
          buildings: null, roads: null, railStart: 0, streetMask: 3, heights: null, grid: 0, minH: 0, maxH: 120,
          houses: null, housesShown: false, street: null, page: null, layer: -1, bytes: 0, lastUsed: 0, drawn: false,
          requestedAt: 0, priority: 0, kids: null, counts: null, retryAt: 0, refined: false,
        };
        this.tiles.set(t.key, t);
        if (l === 2) this.roots.push(t);
      }
    }
    // Levels without a coarser parent become roots too (partial pyramids).
    for (const t of this.tiles.values()) {
      if (t.L < 2 && !this.tiles.has(key(t.L + 1, Math.floor(t.tx / 4), Math.floor(t.ty / 4)))) this.roots.push(t);
    }
    let suppress: number[] = [];
    try {
      const lr = await fetch(`${this.dataRoot}/landmarks.json`);
      if (lr.ok && (lr.headers.get('content-type') ?? '').includes('json')) {
        const lm = (await lr.json()) as { suppress?: number[] }[];
        suppress = lm.flatMap((l) => l.suppress ?? []);
      }
    } catch { /* optional */ }
    const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('../../workers/tileWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<WorkerOut>) => this.onWorker(i, ev.data);
      w.postMessage({ type: 'config', suppress, build: this.manifest.build ?? 0 } satisfies WorkerIn);
      this.workers.push(w);
      this.workerLoad.push(0);
    }
  }

  kidsOf(t: Tile): Tile[] {
    if (t.kids) return t.kids;
    const k: Tile[] = [];
    if (t.L > 0) {
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const c = this.tiles.get(key(t.L - 1, t.tx * 4 + i, t.ty * 4 + j));
          if (c) k.push(c);
        }
      }
    }
    t.kids = k;
    return k;
  }

  // ------------------------------------------------------------------------ height queries

  /** Terrain elevation (datum m) at world E,N using the finest loaded tile; `fallback` if none. */
  heightAt(e: number, n: number, fallback = 0): number {
    for (let L = 0; L <= 2; L++) {
      const S = this.manifest?.tileSize[L];
      if (!S) continue;
      const t = this.tiles.get(key(L, Math.floor(e / S), Math.floor(n / S)));
      if (t && t.heights) {
        const G = t.grid, c = S / (G - 1), h = t.heights;
        let fx = (e - t.tx * S) / c, fy = (n - t.ty * S) / c;
        fx = Math.min(Math.max(fx, 0), G - 1.0001); fy = Math.min(Math.max(fy, 0), G - 1.0001);
        const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
        const h00 = h[j * G + i], h10 = h[j * G + i + 1], h01 = h[(j + 1) * G + i], h11 = h[(j + 1) * G + i + 1];
        return u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + v * (h01 - h00) + u * (h11 - h01);
      }
    }
    return fallback;
  }

  // ------------------------------------------------------------------------ per-frame

  update(ctx: FrameContext) {
    if (!this.manifest) return;
    this.now = ctx.time;
    const cam = ctx.camera;
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, cam.coordinateSystem, cam.reversedDepth);
    const E = ctx.cameraPos.x, N = -ctx.cameraPos.z, H = ctx.cameraPos.y;
    this.l1K = refineL1(ctx.altitude);

    const prevDrawn = this.drawnList;
    this.drawnList = [];
    this.requests.length = 0;
    for (const t of this.roots) this.visit(t, E, N, H);
    this.velocity(ctx, E, N);

    // visibility transitions
    for (const t of prevDrawn) t.drawn = false;
    const layers = useApp.getState().layers;
    for (const t of this.drawnList) {
      t.drawn = true;
      t.lastUsed = this.now;
      if (t.group) {
        t.group.visible = true;
        const d = this.tileDist(t, E, N, H);
        // Far tiles seen from low altitude: flat ground projects to a sliver
        // (eye height · S / d²) and its relief to (maxH − minH) / d. Under
        // ~0.6 px neither is worth a draw (fogged to the horizon colour anyway).
        let sliver = false;
        if (d > ctx.view.r2) {
          const eye = Math.max(1, H - t.maxH);
          const px = ctx.pixelScale * Math.max((eye * t.S) / (d * (d + t.S)), (t.maxH - t.minH) / d);
          sliver = px < 0.6;
        }
        if (t.terrain) t.terrain.visible = layers.terrain && !sliver;
        if (t.buildings) t.buildings.visible = layers.buildings;
        if (t.roads) {
          const mask = (layers.roads ? 1 : 0) | (layers.rail ? 2 : 0);
          if (mask !== t.streetMask) {
            t.streetMask = mask;
            const g = t.roads.geometry, n = g.index!.count, rs = t.railStart;
            if (mask === 3) g.setDrawRange(0, Infinity);
            else if (mask === 1) g.setDrawRange(0, rs);
            else if (mask === 2) g.setDrawRange(rs, n - rs);
          }
          // ring 2+: street surfaces of far tiles seen at a grazing angle
          // (< ~1.2°) cover no pixels worth a draw call
          const grazing = sliver || (d > ctx.view.r1 && (H - t.maxH) < d * 0.02);
          t.roads.visible = !grazing && mask !== 0 && !(mask === 1 && t.railStart === 0) && !(mask === 2 && t.railStart === t.roads.geometry.index!.count);
        }
      }
      if (t.houses) {
        // near rings: full archetypes (shadows); beyond ring 1: 12-triangle blocks
        const d = this.tileDist(t, E, N, H);
        const cur = t.housesShown ? this.houses.levelOf(t.key) : undefined;
        const r1 = ctx.view.r1;
        const lo = cur === 'lo' ? d > r1 * 0.85 : d > r1;
        if (cur && (cur === 'lo') !== lo) { this.houses.remove(t.key); t.housesShown = false; }
        if (!t.housesShown) {
          this.houses.add(t.key, t.tx * t.S, t.ty * t.S, t.houses, lo);
          t.housesShown = true;
        }
      }
    }
    for (const t of prevDrawn) {
      if (!t.drawn) {
        if (t.group) t.group.visible = false;
        if (t.housesShown) { this.houses.remove(t.key); t.housesShown = false; }
      }
    }
    this.houses.setVisible(layers.houses);

    this.dispatch();
    this.prefetch(E, N, H);
    this.consumeResults();
    this.evict();
    this.houses.flush();
    this.houses.group.updateMatrixWorld();
  }

  private tileDist(t: Tile, E: number, N: number, H: number) {
    const cx = (t.tx + 0.5) * t.S, cy = (t.ty + 0.5) * t.S;
    const dx = Math.max(0, Math.abs(E - cx) - t.S / 2);
    const dy = Math.max(0, Math.abs(N - cy) - t.S / 2);
    const dz = H > t.maxH ? H - t.maxH : H < t.minH ? t.minH - H : 0;
    return Math.hypot(dx, dy, dz);
  }

  private inFrustum(t: Tile) {
    this.box.min.set(t.tx * t.S, t.minH - 30, -(t.ty + 1) * t.S);
    this.box.max.set((t.tx + 1) * t.S, t.maxH + 350, -t.ty * t.S);
    return this.frustum.intersectsBox(this.box);
  }

  private request(t: Tile, d: number, vis: boolean) {
    if (t.state === 'ready' || t.state === 'empty') return;
    if (t.state === 'error' && this.now < t.retryAt) return;
    // coarse levels first, then nearest, frustum first
    t.priority = d * (vis ? 1 : 4) / (1 + t.L * 1.5) + (vis ? 0 : 5000);
    t.requestedAt = this.now;
    this.requests.push(t);
  }

  /**
   * Hole-free LOD selection. Returns true when `t`'s area is fully covered by
   * drawn tiles. A tile refines only if every *visible* child subtree can be
   * drawn; otherwise the partial children are rolled back and the tile itself
   * (or, if it isn't loaded, its nearest loaded ancestor) is drawn instead.
   * Off-screen children don't block refinement — they load at low priority so
   * rotating the camera rarely reveals anything missing.
   */
  private visit(t: Tile, E: number, N: number, H: number): boolean {
    t.lastUsed = this.now;
    const d = this.tileDist(t, E, N, H);
    const vis = this.inFrustum(t);
    const kids = t.L > 0 ? this.kidsOf(t) : [];
    if (kids.length) {
      const k = t.S * (REFINE_K[t.L] ?? 0) * this.lodScale * (t.L === 1 ? this.l1K : 1);
      t.refined = d < (t.refined ? k * HYSTERESIS : k);
    } else {
      t.refined = false;
    }
    if (t.refined) {
      const mark = this.drawnList.length;
      let ok = true;
      for (const c of kids) {
        if (!this.visit(c, E, N, H) && this.inFrustum(c)) ok = false;
      }
      if (ok) return true;
      this.drawnList.length = mark; // partial refinement → fall back to this tile
    }
    if (t.state === 'ready') { this.drawnList.push(t); return true; }
    if (t.state === 'empty') return true;
    this.request(t, d, vis);
    return false;
  }

  /** smoothed camera velocity (m/s) for predictive prefetching */
  private velocity(ctx: FrameContext, E: number, N: number) {
    const v = this.vel, H = ctx.cameraPos.y;
    if (!Number.isNaN(v.lastE) && ctx.dt > 0) {
      const a = Math.min(1, ctx.dt * 4);
      v.e += ((E - v.lastE) / ctx.dt - v.e) * a;
      v.n += ((N - v.lastN) / ctx.dt - v.n) * a;
      v.h += ((H - v.lastH) / ctx.dt - v.h) * a;
    }
    v.lastE = E; v.lastN = N; v.lastH = H;
  }

  /**
   * When the loader is idle, warm the cache with tiles the camera is likely to
   * need next: the LOD selection re-run with a wider refine range around the
   * position the camera will reach in ~2 s. Only the compressed bytes are
   * fetched (into Cache Storage); meshing happens when a tile is really needed.
   */
  private prefetch(E: number, N: number, H: number) {
    const cap = this.workers.length * 2;
    if (this.prefetchInFlight >= cap) return;
    let pending = 0;
    for (const t of this.requests) if (t.state === 'none') pending++;
    if (pending > 0 || this.jobs.size > this.workers.length) return;
    const v = this.vel, ahead = 2.0;
    const pE = E + v.e * ahead, pN = N + v.n * ahead, pH = Math.max(20, H + v.h * ahead);
    this.pfList.length = 0;
    const walk = (t: Tile) => {
      const d = this.tileDist(t, pE, pN, pH);
      const kids = t.L > 0 ? this.kidsOf(t) : [];
      if (t.state !== 'ready' && t.state !== 'loading' && t.state !== 'empty' && !this.prefetched.has(t.key)) {
        this.pfList.push({ t, d: d / (1 + t.L * 1.5) });
      }
      if (kids.length && d < t.S * (REFINE_K[t.L] ?? 0) * this.lodScale * (t.L === 1 ? this.l1K : 1) * 1.6) for (const c of kids) walk(c);
    };
    for (const r of this.roots) walk(r);
    this.pfList.sort((a, b) => a.d - b.d);
    for (const { t } of this.pfList) {
      if (this.prefetchInFlight >= cap) break;
      this.prefetched.add(t.key);
      this.prefetchInFlight++;
      const wi = (this.jobSeq++) % this.workers.length;
      this.workers[wi].postMessage({ type: 'prefetch', url: this.tileUrl(t) } satisfies WorkerIn);
    }
  }

  private tileUrl(t: Tile) {
    return `${this.dataRoot}/tiles/${t.L}/${t.tx}_${t.ty}.bin.gz${this.manifest.build ? `?v=${this.manifest.build}` : ''}`;
  }

  private dispatch() {
    // cancel stale in-flight jobs
    for (const [id, t] of this.jobs) {
      if (this.now - t.requestedAt > 1.5) {
        const w = this.workers[(id >> 20) & 15];
        w?.postMessage({ type: 'cancel', id } satisfies WorkerIn);
        this.jobs.delete(id);
        this.workerLoad[(id >> 20) & 15]--;
        t.state = 'none';
        t.jobId = 0;
      }
    }
    const maxPer = 3;
    const cap = this.workers.length * maxPer;
    if (this.jobs.size >= cap || this.requests.length === 0) return;
    this.requests.sort((a, b) => a.priority - b.priority);
    for (const t of this.requests) {
      if (this.jobs.size >= cap) break;
      if (t.state !== 'none' && t.state !== 'error') continue;
      let wi = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.workerLoad[i] < this.workerLoad[wi]) wi = i;
      const id = (wi << 20) | (this.jobSeq++ & 0xfffff);
      t.state = 'loading';
      t.jobId = id;
      this.jobs.set(id, t);
      this.workerLoad[wi]++;
      const L = String(t.L);
      this.workers[wi].postMessage({
        type: 'load', id, url: this.tileUrl(t),
        level: t.L, tx: t.tx, ty: t.ty, size: t.S, grid: this.manifest.terrainGrid[L] ?? 33,
      } satisfies WorkerIn);
    }
  }

  private onWorker(wi: number, m: WorkerOut) {
    if (m.type === 'prefetched') { this.prefetchInFlight--; return; }
    const t = this.jobs.get(m.id);
    if (!t) return; // cancelled
    this.jobs.delete(m.id);
    this.workerLoad[wi]--;
    if (m.type === 'done') {
      this.results.push({ tile: t, res: m.result });
      this.loadMs.push(m.ms.fetch + m.ms.mesh);
      if (this.fetchLog.length < 5000) this.fetchLog.push(m.ms.fetch);
      this.sourceCounts[m.src]++;
      if (this.loadMs.length > 50) this.loadMs.shift();
    } else if (m.type === 'empty') {
      t.state = 'empty';
    } else if (m.type === 'cancelled') {
      t.state = 'none';
    } else {
      console.warn('tile error', t.key, m.message);
      t.state = 'error';
      t.retryAt = this.now + 10;
    }
  }

  private consumeResults() {
    const t0 = performance.now();
    let bytes = 0;
    // coarse + near first: those are what fill holes
    if (this.results.length > 1) this.results.sort((a, b) => b.tile.L - a.tile.L || a.tile.priority - b.tile.priority);
    if (this.results.length) this.ensureSparePage();
    while (this.results.length && performance.now() - t0 < 6 && bytes < UPLOAD_BUDGET) {
      const { tile, res } = this.results.shift()!;
      bytes += meshBytes(res);
      const s = performance.now();
      this.build(tile, res);
      this.buildMs.push(performance.now() - s);
      if (this.buildMs.length > 50) this.buildMs.shift();
    }
  }

  /** New ground page; its material is compiled right away (not on first draw). */
  private addPage(): GroundPage {
    const page = new GroundPage();
    this.pages.push(page);
    if (this.warm) {
      const g = new THREE.PlaneGeometry(1, 1);
      const m = new THREE.Mesh(g, page.material);
      m.userData.groundLayer = 0;
      m.userData.tileSize = 1024;
      this.warm(m);
    }
    return page;
  }

  /** keep a spare page ahead of demand so allocating never builds a shader mid-zoom */
  private ensureSparePage() {
    let free = 0;
    for (const p of this.pages) free += p.free.length;
    if (free < 64) this.addPage();
  }

  private geometry(m: MeshBuf, sphere: THREE.Sphere): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    const nb = new THREE.InterleavedBuffer(m.normal, 4);
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(nb, 3, 0, true));
    if (m.color) g.setAttribute('color', new THREE.BufferAttribute(m.color, 4, true));
    if (m.attrs) for (const k in m.attrs) g.setAttribute(k, new THREE.BufferAttribute(m.attrs[k].array, m.attrs[k].size));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    g.boundingSphere = sphere.clone();
    const b = new THREE.Box3();
    b.setFromCenterAndSize(sphere.center, new THREE.Vector3(sphere.radius * 1.4, sphere.radius * 1.4, sphere.radius * 1.4));
    g.boundingBox = b;
    return g;
  }

  private build(t: Tile, r: TileMeshes) {
    const S = t.S;
    const g = new THREE.Group();
    g.name = t.key;
    g.position.set(t.tx * S, 0, -t.ty * S);
    g.visible = false;
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    t.minH = r.minH;
    t.maxH = r.maxH;
    const top = r.maxH + (t.L === 0 ? 350 : 500);
    const sphere = new THREE.Sphere(new THREE.Vector3(S / 2, (r.minH + top) / 2, -S / 2), Math.hypot(S / 2, S / 2, (top - r.minH) / 2));
    let bytes = 0;
    const count = (m: MeshBuf | null) => {
      if (m) bytes += m.position.byteLength + m.normal.byteLength + m.index.byteLength + (m.color?.byteLength ?? 0) + attrBytes(m);
    };

    // terrain
    let page = this.pages.find((p) => p.free.length > 0);
    if (!page) page = this.addPage();
    t.page = page;
    t.layer = page.alloc(r.ground);
    const terrain = new THREE.Mesh(this.geometry(r.terrain, sphere), page.material);
    terrain.userData.groundLayer = t.layer;
    terrain.userData.tileSize = S;
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    terrain.matrixAutoUpdate = false;
    g.add(terrain);
    t.terrain = terrain;
    count(r.terrain);
    bytes += 65536;

    const add = (m: MeshBuf | null, mat: THREE.Material, name: string, cast: boolean) => {
      if (!m) return null;
      const mesh = new THREE.Mesh(this.geometry(m, sphere), mat);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
      count(m);
      return mesh;
    };
    t.buildings = add(r.buildings, this.buildingMat, 'buildings', true);
    t.roads = add(r.roads, this.roadMat, 'roads', false);
    t.railStart = r.railStart;
    t.streetMask = 3;
    if (t.roads) t.roads.renderOrder = 1;
    t.heights = r.heights;
    t.grid = r.grid;
    t.houses = r.houses;
    t.street = r.street;
    t.counts = r.counts;
    if (r.houses) bytes += r.houses.count * 76;
    t.bytes = bytes;
    this.bytes += bytes;
    t.group = g;
    g.updateMatrixWorld(true);
    this.root.add(g);
    t.state = 'ready';
    this.readyCount++;
    if (this.readyCount === 1 && !performance.getEntriesByName('first-tile').length) performance.mark('first-tile');
    if (this.onFirstReady && this.readyCount === 1) this.onFirstReady();
  }

  private unload(t: Tile) {
    if (t.housesShown) { this.houses.remove(t.key); t.housesShown = false; }
    if (t.group) {
      for (const c of t.group.children) (c as THREE.Mesh).geometry?.dispose();
      this.root.remove(t.group);
    }
    if (t.page && t.layer >= 0) t.page.release(t.layer);
    this.bytes -= t.bytes;
    Object.assign(t, {
      group: null, terrain: null, buildings: null, roads: null, railStart: 0, streetMask: 3, heights: null, houses: null, street: null,
      page: null, layer: -1, bytes: 0, state: 'none', counts: null,
    });
    this.readyCount--;
  }

  private evict() {
    if (this.bytes < MAX_BYTES && this.readyCount < MAX_TILES) return;
    const cands: Tile[] = [];
    for (const t of this.tiles.values()) {
      if (t.state === 'ready' && t.L < 2 && !t.drawn && this.now - t.lastUsed > 0.5) cands.push(t);
    }
    cands.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of cands) {
      if (this.bytes < MAX_BYTES * 0.85 && this.readyCount < MAX_TILES * 0.85) break;
      this.unload(t);
    }
  }

  stats() {
    let pending = this.jobs.size + this.results.length;
    for (const t of this.requests) if (t.state === 'none') pending++;
    return {
      loaded: this.readyCount,
      visible: this.drawnList.length,
      pending,
      bytes: this.bytes + this.pages.length * GROUND_LAYERS * 65536,
      houses: this.houses.instanceCount,
    };
  }

  /** tiles are being fetched / meshed / uploaded (frame spikes are expected) */
  get busy(): boolean {
    return this.jobs.size > 0 || this.results.length > 0;
  }

  /** tiles currently drawn (read-only) */
  get drawn(): readonly Tile[] {
    return this.drawnList;
  }

  /** anchor changed → rebase house pools */
  rebase(e: number, n: number) {
    this.houses.rebase(e, n);
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const t of this.tiles.values()) if (t.state === 'ready') this.unload(t);
    this.houses.dispose();
  }
}
