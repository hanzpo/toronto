// Quadtree-ish (4×4 split) tile streaming: LOD selection, prioritized loading
// through a worker pool, cancellation, LRU eviction and hole-free transitions.
import * as THREE from 'three/webgpu';
import type { WorkerIn, WorkerOut } from '../../workers/tileWorker';
import type { MeshBuf, TileMeshes } from '../../workers/meshing';
import { GroundPage, GROUND_LAYERS, vertexColorMaterial } from './materials';
import { HousePools } from './houses';
import type { FrameContext } from '../../engine/types';
import { useApp } from '../../state/store';

export interface Manifest {
  version: number;
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
  roads: THREE.Mesh | null;
  rail: THREE.Mesh | null;
  heights: Float32Array | null;
  grid: number;
  minH: number;
  maxH: number;
  houses: TileMeshes['houses'];
  housesShown: boolean;
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
}

const key = (L: number, tx: number, ty: number) => `${L}/${tx}/${ty}`;

/** Distance (m) below which a tile of level L is refined into its children. */
const REFINE_K: Record<number, number> = { 2: 0.85, 1: 1.0 };

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
  readonly buildingMat = vertexColorMaterial('buildings', { emissiveWindows: true });
  readonly roadMat = vertexColorMaterial('roads', { pull: 0.0009, pullConst: 0.25 });
  readonly railMat = vertexColorMaterial('rail', { pull: 0.0011, pullConst: 0.35 });
  bytes = 0;
  readyCount = 0;
  loadMs: number[] = [];
  /** time spent building GPU objects on the main thread (last 50 tiles) */
  buildMs: number[] = [];
  onFirstReady: (() => void) | null = null;
  lodScale = 1;

  dataRoot: string;
  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    this.root.name = 'tiles';
    this.root.add(this.houses.group);
  }

  async init() {
    const r = await fetch(`${this.dataRoot}/manifest.json`);
    if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
    this.manifest = await r.json();
    for (const L of ['0', '1', '2']) {
      for (const [tx, ty] of this.manifest.tiles[L] ?? []) {
        const l = +L;
        const S = this.manifest.tileSize[L];
        const t: Tile = {
          key: key(l, tx, ty), L: l, tx, ty, S, state: 'none', jobId: 0, group: null, terrain: null,
          buildings: null, roads: null, rail: null, heights: null, grid: 0, minH: 0, maxH: 120,
          houses: null, housesShown: false, page: null, layer: -1, bytes: 0, lastUsed: 0, drawn: false,
          requestedAt: 0, priority: 0, kids: null, counts: null, retryAt: 0,
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
      w.postMessage({ type: 'config', suppress } satisfies WorkerIn);
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

    const prevDrawn = this.drawnList;
    this.drawnList = [];
    this.requests.length = 0;
    for (const t of this.roots) this.visit(t, E, N, H);

    // visibility transitions
    for (const t of prevDrawn) t.drawn = false;
    const layers = useApp.getState().layers;
    for (const t of this.drawnList) {
      t.drawn = true;
      t.lastUsed = this.now;
      if (t.group) {
        t.group.visible = true;
        if (t.terrain) t.terrain.visible = layers.terrain;
        if (t.buildings) t.buildings.visible = layers.buildings;
        if (t.roads) t.roads.visible = layers.roads;
        if (t.rail) t.rail.visible = layers.rail;
      }
      if (t.houses && !t.housesShown) {
        this.houses.add(t.key, t.tx * t.S, t.ty * t.S, t.houses);
        t.housesShown = true;
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
    this.consumeResults();
    this.evict();
    this.houses.flush();
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

  private done(t: Tile) {
    return t.state === 'ready' || t.state === 'empty' || t.state === 'error';
  }

  private visit(t: Tile, E: number, N: number, H: number) {
    t.lastUsed = this.now;
    const d = this.tileDist(t, E, N, H);
    const vis = this.inFrustum(t);
    const kids = t.L > 0 ? this.kidsOf(t) : [];
    const refine = kids.length > 0 && d < t.S * (REFINE_K[t.L] ?? 0) * this.lodScale;
    if (refine) {
      let allReady = true;
      for (const k of kids) {
        if (!this.done(k)) {
          allReady = false;
          this.request(k, this.tileDist(k, E, N, H), vis && this.inFrustum(k));
        }
      }
      if (allReady) {
        for (const k of kids) this.visit(k, E, N, H);
        return;
      }
      if (t.state === 'ready') { this.drawnList.push(t); return; }
      this.request(t, d, vis);
      for (const k of kids) if (k.state === 'ready') this.drawnList.push(k);
      return;
    }
    if (t.state === 'ready') { this.drawnList.push(t); return; }
    this.request(t, d, vis);
    // zooming out before the parent is loaded: keep children to avoid holes
    for (const k of kids) {
      if (k.state === 'ready') { k.lastUsed = this.now; this.drawnList.push(k); }
    }
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
        type: 'load', id, url: `${this.dataRoot}/tiles/${t.L}/${t.tx}_${t.ty}.bin.gz`,
        level: t.L, tx: t.tx, ty: t.ty, size: t.S, grid: this.manifest.terrainGrid[L] ?? 33,
      } satisfies WorkerIn);
    }
  }

  private onWorker(wi: number, m: WorkerOut) {
    const t = this.jobs.get(m.id);
    if (!t) return; // cancelled
    this.jobs.delete(m.id);
    this.workerLoad[wi]--;
    if (m.type === 'done') {
      this.results.push({ tile: t, res: m.result });
      this.loadMs.push(m.ms.fetch + m.ms.mesh);
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
    while (this.results.length && performance.now() - t0 < 6) {
      const { tile, res } = this.results.shift()!;
      const s = performance.now();
      this.build(tile, res);
      this.buildMs.push(performance.now() - s);
      if (this.buildMs.length > 50) this.buildMs.shift();
    }
  }

  private geometry(m: MeshBuf, sphere: THREE.Sphere): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    const nb = new THREE.InterleavedBuffer(m.normal, 4);
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(nb, 3, 0, true));
    if (m.color) g.setAttribute('color', new THREE.BufferAttribute(m.color, 4, true));
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
      if (m) bytes += m.position.byteLength + m.normal.byteLength + m.index.byteLength + (m.color?.byteLength ?? 0);
    };

    // terrain
    let page = this.pages.find((p) => p.free.length > 0);
    if (!page) { page = new GroundPage(); this.pages.push(page); }
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
    t.rail = add(r.rail, this.railMat, 'rail', false);
    if (t.roads) t.roads.renderOrder = 1;
    if (t.rail) t.rail.renderOrder = 2;
    t.heights = r.heights;
    t.grid = r.grid;
    t.houses = r.houses;
    t.counts = r.counts;
    if (r.houses) bytes += r.houses.count * 76;
    t.bytes = bytes;
    this.bytes += bytes;
    t.group = g;
    g.updateMatrixWorld(true);
    this.root.add(g);
    t.state = 'ready';
    this.readyCount++;
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
      group: null, terrain: null, buildings: null, roads: null, rail: null, heights: null, houses: null,
      page: null, layer: -1, bytes: 0, state: 'none', counts: null,
    });
    this.readyCount--;
  }

  private evict() {
    if (this.bytes < MAX_BYTES && this.readyCount < MAX_TILES) return;
    const cands: Tile[] = [];
    for (const t of this.tiles.values()) {
      if (t.state === 'ready' && !t.drawn && this.now - t.lastUsed > 0.5) cands.push(t);
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
