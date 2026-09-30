// Vegetation runtime: instanced LOD pools fed incrementally from 64 m cells.
//
// Level-0 tiles carry per-tree records bucketed by (cell, family); each cell
// sits in the pools whose LOD range its distance range overlaps (with
// hysteresis), so moving the camera only moves the few cells crossing a
// boundary — no per-frame rebuilds. Each tree's LOD is a per-tree state
// (hashed switch distance ±10 %, hysteresis HY_*), updated only for trees in
// cells near a switch distance; a change starts a short cross-fade in the
// shader (material.ts). The pools only need to be a superset. Level-1 tiles add far canopy clumps to
// the impostor pool, which carries trees to the horizon.
//
// Pools / draws (main + shadow): lobed high ✓shadow, lobed mid near ✓shadow,
// lobed mid far, tiered high ✓shadow, tiered mid near ✓shadow, tiered mid
// far, impostors — 7 + 4 draws at most.
import * as THREE from 'three/webgpu';
import type { Engine } from '../../engine/Engine';
import type { FrameContext } from '../../engine/types';
import type { ViewCull } from '../../engine/view';
import { releaseObject } from '../../engine/dispose';
import { VEG_CELLS } from '../../workers/vegetation';
import { VEG_STRIDE } from './species';
import { impostorQuad, lobedHigh, lobedMid, tieredHigh, tieredMid } from './geometry';
import { FADE_S, impostorMaterial, lobedMaterial, tieredMaterial, VU } from './material';

/** LOD switch distances (m, before the quality scale): each tree switches at its own hashed
 *  distance within ±10 % of these (no visible ring), with hysteresis HY_* either side */
const LOD_HIGH = 160, LOD_MID = 650;
const HY_H = 5, HY_M = 20;
/** cells within this range put their mid-LOD trees in the shadow-casting pool */
const SHADOW_MID = 260;
const HYST = 14;
/** a camera move longer than this in one frame (teleport) re-derives every tree's LOD without fades */
const JUMP = 60;
/** cross-fade length when a tree changes LOD (s) */
const FADE = FADE_S;
/** instance writes per frame (cell moves / tile activations beyond this wait a frame) */
const WRITE_BUDGET = 40000;

interface Owner {
  slots: Int32Array;
  src: Float32Array;
  /** record index per slot entry */
  idx: Int32Array;
  e0: number; n0: number;
  /** per-record LOD state of the tile (cur, prev, switch time); null = impostor only (far canopy) */
  st: Float32Array | null;
}

class VegPool {
  mesh!: THREE.Mesh;
  geo!: THREE.InstancedBufferGeometry;
  ia!: THREE.InstancedBufferAttribute;
  ib!: THREE.InstancedBufferAttribute;
  /** LOD state: current level, previous level, switch time (s, VU.now clock) */
  ic!: THREE.InstancedBufferAttribute;
  cap: number;
  count = 0;
  owners: (Owner | null)[] = [];
  entries: Int32Array;
  live = new Set<Owner>();
  /** dirty slot ranges (inclusive pairs) since the last flush */
  private dirty: number[] = [];
  readonly tris: number;
  private tmpl: THREE.BufferGeometry; private mat: THREE.Material; private parent: THREE.Object3D; readonly name: string; private shadow: boolean;
  constructor(tmpl: THREE.BufferGeometry, mat: THREE.Material, cap: number, parent: THREE.Object3D, name: string, shadow: boolean) {
    this.tmpl = tmpl; this.mat = mat; this.parent = parent; this.name = name; this.shadow = shadow;
    this.cap = cap;
    this.entries = new Int32Array(cap);
    this.tris = (tmpl.userData.tris as number) ?? 0;
    this.make(new Float32Array(cap * 4), new Float32Array(cap * 4), new Float32Array(cap * 4));
  }
  private make(a: Float32Array, b: Float32Array, c: Float32Array) {
    const g = new THREE.InstancedBufferGeometry();
    for (const k of Object.keys(this.tmpl.attributes)) g.setAttribute(k, this.tmpl.attributes[k].clone());
    if (this.tmpl.index) g.setIndex(this.tmpl.index.clone());
    this.ia = new THREE.InstancedBufferAttribute(a, 4);
    this.ib = new THREE.InstancedBufferAttribute(b, 4);
    this.ic = new THREE.InstancedBufferAttribute(c, 4);
    g.setAttribute('ia', this.ia);
    g.setAttribute('ib', this.ib);
    g.setAttribute('ic', this.ic);
    g.instanceCount = this.count;
    const m = new THREE.Mesh(g, this.mat);
    m.name = this.name;
    m.frustumCulled = false;
    m.castShadow = this.shadow;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    if (this.mesh) {
      m.position.copy(this.mesh.position);
      m.visible = this.mesh.visible;
      this.parent.remove(this.mesh);
      releaseObject(this.mesh);
    }
    m.updateMatrix();
    this.parent.add(m);
    this.mesh = m; this.geo = g;
  }
  setOrigin(x: number, z: number) {
    this.mesh.position.set(x, 0, z);
    this.mesh.updateMatrix();
  }
  private ensure(n: number) {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    const a = new Float32Array(cap * 4); a.set(this.ia.array as Float32Array);
    const b = new Float32Array(cap * 4); b.set(this.ib.array as Float32Array);
    const c = new Float32Array(cap * 4); c.set(this.ic.array as Float32Array);
    const e = new Int32Array(cap); e.set(this.entries); this.entries = e;
    this.cap = cap;
    this.make(a, b, c);
    this.dirty.length = 0; // fresh buffers upload whole
  }
  private mark(a: number, b = a) { this.dirty.push(a, b); }
  write(o: Owner, j: number, ox: number, oz: number, mark = true) {
    const s = o.slots[j], r = o.idx[j] * VEG_STRIDE, src = o.src;
    const A = this.ia.array as Float32Array, B = this.ib.array as Float32Array;
    A[s * 4] = o.e0 + src[r] - ox; A[s * 4 + 1] = src[r + 2]; A[s * 4 + 2] = -(o.n0 + src[r + 1]) - oz; A[s * 4 + 3] = src[r + 3];
    B[s * 4] = src[r + 4]; B[s * 4 + 1] = src[r + 5]; B[s * 4 + 2] = src[r + 6]; B[s * 4 + 3] = src[r + 7];
    this.writeState(o, j, false);
    if (mark) this.mark(s);
  }
  writeState(o: Owner, j: number, mark = true) {
    const s = o.slots[j], C = this.ic.array as Float32Array;
    if (o.st) { const q = o.idx[j] * 3; C[s * 4] = o.st[q]; C[s * 4 + 1] = o.st[q + 1]; C[s * 4 + 2] = o.st[q + 2]; }
    else { C[s * 4] = 2; C[s * 4 + 1] = 2; C[s * 4 + 2] = -1e4; }
    if (mark) this.mark(s);
  }
  /** slot entry of record r in owner o (owners hold contiguous record ranges), −1 if absent */
  static entryOf(o: Owner, r: number) {
    const j = r - o.idx[0];
    return j >= 0 && j < o.idx.length && o.idx[j] === r ? j : -1;
  }
  rewriteStates() {
    for (const o of this.live) for (let j = 0; j < o.slots.length; j++) this.writeState(o, j, false);
    if (this.count) this.mark(0, this.count - 1);
  }
  /** allocate slots for records [a0, a1) (+ [b0, b1)) of `src` */
  alloc(src: Float32Array, e0: number, n0: number, ranges: number[], ox: number, oz: number, st: Float32Array | null): Owner {
    let n = 0;
    for (let q = 0; q < ranges.length; q += 2) n += ranges[q + 1] - ranges[q];
    this.ensure(this.count + n);
    const o: Owner = { slots: new Int32Array(n), src, idx: new Int32Array(n), e0, n0, st };
    const first = this.count;
    let j = 0;
    for (let q = 0; q < ranges.length; q += 2) {
      for (let r = ranges[q]; r < ranges[q + 1]; r++) {
        const s = this.count++;
        o.slots[j] = s; o.idx[j] = r; this.owners[s] = o; this.entries[s] = j;
        this.write(o, j, ox, oz, false);
        j++;
      }
    }
    if (n) this.mark(first, first + n - 1);
    this.live.add(o);
    this.geo.instanceCount = this.count;
    return o;
  }
  free(o: Owner) {
    const A = this.ia.array as Float32Array, B = this.ib.array as Float32Array, C = this.ic.array as Float32Array;
    for (let j = 0; j < o.slots.length; j++) {
      const s = o.slots[j], last = this.count - 1;
      if (s !== last) {
        A.copyWithin(s * 4, last * 4, last * 4 + 4);
        B.copyWithin(s * 4, last * 4, last * 4 + 4);
        C.copyWithin(s * 4, last * 4, last * 4 + 4);
        this.mark(s);
        const lo = this.owners[last]!, e = this.entries[last];
        lo.slots[e] = s; this.owners[s] = lo; this.entries[s] = e;
      }
      this.owners[last] = null;
      this.count--;
    }
    this.live.delete(o);
    this.geo.instanceCount = this.count;
  }
  rewriteAll(ox: number, oz: number) {
    for (const o of this.live) for (let j = 0; j < o.slots.length; j++) this.write(o, j, ox, oz, false);
    if (this.count) this.mark(0, this.count - 1);
  }
  flush() {
    const d = this.dirty;
    if (!d.length) return;
    this.ia.clearUpdateRanges(); this.ib.clearUpdateRanges(); this.ic.clearUpdateRanges();
    const ranges: number[] = [];
    if (d.length > 512) {
      let lo = Infinity, hi = -1;
      for (let i = 0; i < d.length; i += 2) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i + 1]); }
      ranges.push(lo, hi);
    } else {
      const ord: number[] = [];
      for (let i = 0; i < d.length; i += 2) ord.push(i);
      ord.sort((x, y) => d[x] - d[y]);
      let a = d[ord[0]], b = d[ord[0] + 1];
      for (let q = 1; q < ord.length; q++) {
        const s0 = d[ord[q]], s1 = d[ord[q] + 1];
        if (s0 <= b + 8) { b = Math.max(b, s1); continue; }
        ranges.push(a, b); a = s0; b = s1;
      }
      ranges.push(a, b);
    }
    for (let i = 0; i < ranges.length; i += 2) {
      if (ranges[i] >= this.cap) continue;
      const n = Math.min(ranges[i + 1], this.cap - 1) - ranges[i] + 1;
      this.ia.addUpdateRange(ranges[i] * 4, n * 4);
      this.ib.addUpdateRange(ranges[i] * 4, n * 4);
      this.ic.addUpdateRange(ranges[i] * 4, n * 4);
    }
    this.ia.needsUpdate = true; this.ib.needsUpdate = true; this.ic.needsUpdate = true;
    d.length = 0;
  }
  dispose() { this.parent.remove(this.mesh); releaseObject(this.mesh); }
}

// pool membership bits
const HIGH = 1, MIDN = 2, MIDF = 4, IMP = 8;

interface Cell {
  /** bucket ranges into the tile records: lobed [l0, l1), tiered [t0, t1) */
  l0: number; l1: number; t0: number; t1: number;
  cx: number; cy: number; cz: number; r: number;
  mask: number;
  own: (Owner | null)[]; // per pool index
}

interface VegTile { key: string; e0: number; n0: number; src: Float32Array; cells: Cell[]; dist: number; st: Float32Array }
interface Canopy { key: string; owner: Owner | null; src: Float32Array; e0: number; n0: number }

export class Vegetation {
  readonly group = new THREE.Group();
  private pools: VegPool[] = [];
  private tiles = new Map<string, VegTile>();
  private canopies = new Map<string, Canopy>();
  private anchorVer = -1;
  private at = new THREE.Vector3(Infinity, 0, 0);
  /** camera (E, N, elevation) of the last LOD state update, LOD distances in use */
  private last = new THREE.Vector3(Infinity, 0, 0);
  private lod = new THREE.Vector2(0, 0);
  private t0 = performance.now() / 1000;
  /** diagnostics: override the switch distances [high→mid, mid→impostor] (m) */
  debugLod: [number, number] | null = null;
  private lodKey = '';
  private dirty = true;
  private pending = false;
  private tileOrder: VegTile[] = [];
  /** widened view frustum (engine/view.ts): the non-shadow pools (mid far, impostors) only take cells inside it */
  private view: ViewCull | null = null;
  private viewVer = -1;

  private engine: Engine;
  constructor(engine: Engine) {
    this.engine = engine;
    this.group.name = 'vegetation';
    this.group.matrixWorldAutoUpdate = true;
    const g = this.group;
    const lh = lobedMaterial(0), lm = lobedMaterial(1), th = tieredMaterial(0), tm = tieredMaterial(1), im = impostorMaterial();
    const LH = lobedHigh(), LM = lobedMid(), TH = tieredHigh(), TM = tieredMid(), IQ = impostorQuad();
    this.pools = [
      new VegPool(LH, lh, 4096, g, 'vegLobedHigh', true), // 0
      new VegPool(LM, lm, 8192, g, 'vegLobedMidNear', true), // 1
      new VegPool(LM, lm, 32768, g, 'vegLobedMidFar', false), // 2
      new VegPool(TH, th, 2048, g, 'vegTieredHigh', true), // 3
      new VegPool(TM, tm, 4096, g, 'vegTieredMidNear', true), // 4
      new VegPool(TM, tm, 8192, g, 'vegTieredMidFar', false), // 5
      new VegPool(IQ, im, 131072, g, 'vegImpostors', false), // 6
    ];
    engine.scene.add(this.group);
  }

  /** compile the pipelines up front (a pool's first use would otherwise stall) */
  async prewarm() {
    for (const p of this.pools) p.geo.instanceCount = 1;
    const e = this.engine;
    const pr = e.renderer.compileAsync(this.group, e.camera, e.scene).catch(() => {});
    for (const p of this.pools) p.geo.instanceCount = p.count;
    await pr;
  }

  /** instance / triangle counts per pool (diagnostics) */
  stats() {
    return this.pools.map((p) => ({ name: p.name, n: p.count, tris: p.count * p.tris }));
  }

  update(ctx: FrameContext) {
    const eng = this.engine;
    const o = ctx.anchor.origin;
    if (this.anchorVer !== ctx.anchor.version) {
      this.anchorVer = ctx.anchor.version;
      for (const p of this.pools) { p.setOrigin(o.x, o.z); p.rewriteAll(o.x, o.z); }
    }
    const cam = ctx.cameraPos;
    const E = cam.x, Nn = -cam.z, Hc = cam.y;
    const alt = ctx.altitude;
    const sc = ctx.view.scale;
    // impostors reach further from the air; nothing above ~5 km altitude (sub-pixel, the land cover carries it)
    let far = Math.min(7000, 4800 + Math.max(0, alt) * 1.2);
    if (alt > 3500) far *= Math.max(0, (5000 - alt) / 1500);
    far *= Math.max(0.75, sc);
    const lodH = this.debugLod?.[0] ?? LOD_HIGH * sc, lodM = this.debugLod?.[1] ?? LOD_MID * sc;
    VU.cam.value.set(cam.x - o.x, cam.y, cam.z - o.z);
    VU.lod.value.set(lodH, lodM, Math.max(far, 1), 0);
    VU.doy.value = dayOfYear(ctx.simMs);
    const now = performance.now() / 1000 - this.t0;
    VU.now.value = now;
    this.group.visible = far > 1;
    // LOD state inputs (makeTile / updateStates)
    const jumped = Math.hypot(E - this.last.x, Nn - this.last.y, Hc - this.last.z) > JUMP;
    const lodChanged = lodH !== this.lod.x || lodM !== this.lod.y;
    this.last.set(E, Nn, Hc);
    this.lod.set(lodH, lodM);

    // ---- tile sets: drawn level-0 tiles with records, drawn level-1 tiles with canopy
    const want0 = new Set<string>(), want1 = new Set<string>();
    let changed = false;
    if (far > 1) {
      for (const t of eng.tiles.drawn) {
        const dx = Math.max(0, Math.abs(E - (t.tx + 0.5) * t.S) - t.S / 2), dy = Math.max(0, Math.abs(Nn - (t.ty + 0.5) * t.S) - t.S / 2);
        const d = Math.hypot(dx, dy, Math.max(0, alt - 60));
        if (t.L === 0 && t.street && t.street.veg.length) {
          if (d > far + 100) continue;
          want0.add(t.key);
          let rec = this.tiles.get(t.key);
          if (!rec) { rec = this.makeTile(t.key, t.tx * t.S, t.ty * t.S, t.street.veg, t.street.vegCells, t.S); this.tiles.set(t.key, rec); changed = true; }
          rec.dist = d;
        } else if (t.L === 1 && t.canopy && t.canopy.length) {
          if (d > far + (this.canopies.has(t.key) ? 400 : 0)) continue;
          if (!ctx.view.wideBoxEN(t.tx * t.S, t.ty * t.S, t.minH - 5, (t.tx + 1) * t.S, (t.ty + 1) * t.S, t.maxH + 40)) continue;
          want1.add(t.key);
        }
      }
    }
    for (const [k, rec] of this.tiles) if (!want0.has(k)) { this.dropTile(rec); this.tiles.delete(k); changed = true; }
    for (const [k, c] of this.canopies) if (!want1.has(k)) { if (c.owner) this.pools[6].free(c.owner); this.canopies.delete(k); }
    let budget = WRITE_BUDGET;
    for (const t of eng.tiles.drawn) {
      if (t.L !== 1 || !want1.has(t.key) || this.canopies.has(t.key) || budget <= 0) continue;
      const src = t.canopy!;
      const n = src.length / VEG_STRIDE;
      const owner = this.pools[6].alloc(src, t.tx * t.S, t.ty * t.S, [0, n], o.x, o.z, null);
      this.canopies.set(t.key, { key: t.key, owner, src, e0: t.tx * t.S, n0: t.ty * t.S });
      budget -= n;
    }

    // ---- per-tree LOD states (hysteresis; a switch starts a short cross-fade)
    // (a quality change moves the switch distances: every tree re-evaluates, with fades)
    if (jumped) this.resetStates(E, Nn, Hc);
    else this.updateStates(E, Nn, Hc, now, lodChanged);

    // ---- cells → pools (only when the camera / LOD distances moved or tiles changed)
    const lodKey = `${lodH.toFixed(1)}|${lodM.toFixed(1)}|${far.toFixed(0)}`;
    const moved = Math.hypot(E - this.at.x, Nn - this.at.y, Hc - this.at.z) > 2;
    const turned = ctx.view.wideVersion !== this.viewVer;
    this.viewVer = ctx.view.wideVersion;
    this.view = ctx.view;
    if (changed || moved || turned || lodKey !== this.lodKey || this.pending || this.dirty) {
      if (changed) this.tileOrder = [...this.tiles.values()];
      this.tileOrder.sort((a, b) => a.dist - b.dist);
      this.at.set(E, Nn, Hc);
      this.lodKey = lodKey;
      this.dirty = false;
      this.pending = this.assign(E, Nn, Hc, lodH, lodM, far, budget, o.x, o.z);
    }
    for (const p of this.pools) p.flush();
  }

  /** move cells between pools; returns true when the write budget ran out (continue next frame) */
  private assign(E: number, N: number, Hc: number, lodH: number, lodM: number, far: number, budget: number, ox: number, oz: number): boolean {
    // superset of every tree's reachable states (hashed switch ±10 %, hysteresis, cell hysteresis)
    const H1 = lodH * 1.1 + HY_H, H0 = lodH * 0.9 - HY_H, M1 = lodM * 1.1 + HY_M, M0 = lodM * 0.9 - HY_M;
    for (const t of this.tileOrder) {
      for (const c of t.cells) {
        const d = Math.hypot(c.cx - E, c.cy - N, c.cz - Hc);
        const dmin = Math.max(0, d - c.r), dmax = d + c.r;
        const has = c.mask;
        let want = 0;
        if (dmin < H1 + (has & HIGH ? HYST : 0)) want |= HIGH;
        const hm = has & (MIDN | MIDF) ? HYST : 0;
        if (dmax > H0 - hm && dmin < M1 + hm) want |= dmin < SHADOW_MID + (has & MIDN ? HYST : 0) ? MIDN : MIDF;
        const hi = has & IMP ? HYST : 0;
        if (dmax > M0 - hi && dmin < far + hi) want |= IMP;
        // mid-far / impostor trees outside the widened view frustum draw nothing (they cast no shadow)
        if (want & (MIDF | IMP) && dmin > SHADOW_MID && this.view && !this.view.wideSphereEN(c.cx, c.cy, c.cz, c.r + 2)) want &= ~(MIDF | IMP);
        if (want === has) continue;
        if (budget <= 0) return true;
        budget -= this.apply(t, c, want, ox, oz);
      }
    }
    return false;
  }

  private apply(t: VegTile, c: Cell, want: number, ox: number, oz: number): number {
    let writes = 0;
    const set = (bit: number, lobedPool: number, tieredPool: number) => {
      const on = (want & bit) !== 0, was = (c.mask & bit) !== 0;
      if (on === was) return;
      for (const [pi, a, b] of [[lobedPool, c.l0, c.l1], [tieredPool, c.t0, c.t1]] as const) {
        if (b <= a) continue;
        if (on) { c.own[pi] = this.pools[pi].alloc(t.src, t.e0, t.n0, [a, b], ox, oz, t.st); writes += b - a; }
        else if (c.own[pi]) { this.pools[pi].free(c.own[pi]!); c.own[pi] = null; writes += b - a; }
      }
    };
    set(HIGH, 0, 3);
    set(MIDN, 1, 4);
    set(MIDF, 2, 5);
    // impostors: one owner for both families
    const on = (want & IMP) !== 0, was = (c.mask & IMP) !== 0;
    if (on !== was) {
      if (on) { c.own[6] = this.pools[6].alloc(t.src, t.e0, t.n0, [c.l0, c.l1, c.t0, c.t1], ox, oz, t.st); writes += c.t1 - c.l0; }
      else if (c.own[6]) { this.pools[6].free(c.own[6]!); c.own[6] = null; writes += c.t1 - c.l0; }
    }
    c.mask = want;
    return writes + 8;
  }

  private makeTile(key: string, e0: number, n0: number, src: Float32Array, buckets: Uint32Array, S: number): VegTile {
    const cells: Cell[] = [];
    const cs = S / VEG_CELLS;
    for (let b = 0; b < VEG_CELLS * VEG_CELLS; b++) {
      const l0 = buckets[b * 2], l1 = buckets[b * 2 + 1], t1 = buckets[b * 2 + 2];
      if (t1 <= l0) continue;
      const i = b % VEG_CELLS, j = Math.floor(b / VEG_CELLS);
      const cx = e0 + (i + 0.5) * cs, cy = n0 + (j + 0.5) * cs;
      let zs = 0;
      for (let r = l0; r < t1; r++) zs += src[r * VEG_STRIDE + 2] + src[r * VEG_STRIDE + 4] * 0.5;
      const cz = zs / (t1 - l0);
      let rr = 0;
      for (let r = l0; r < t1; r++) {
        const q = r * VEG_STRIDE;
        rr = Math.max(rr, Math.hypot(e0 + src[q] - cx, n0 + src[q + 1] - cy, src[q + 2] + src[q + 4] * 0.5 - cz));
      }
      cells.push({ l0, l1, t0: l1, t1, cx, cy, cz, r: rr + 1, mask: 0, own: [null, null, null, null, null, null, null] });
    }
    const t: VegTile = { key, e0, n0, src, cells, dist: 0, st: new Float32Array((src.length / VEG_STRIDE) * 3) };
    this.hardStates(t, this.last.x, this.last.y, this.last.z);
    return t;
  }

  /** LOD a tree at distance d should show, staying at `cur` inside the hysteresis margins */
  private level(d: number, seed: number, cur: number): number {
    const h = this.lod.x * (0.9 + 0.2 * ((seed * 7.13) % 1)), m = this.lod.y * (0.9 + 0.2 * ((seed * 3.71) % 1));
    const target = d < h ? 0 : d < m ? 1 : 2;
    if (cur < 0 || target === cur) return target;
    if (cur === 0) return d > h + HY_H ? target : 0;
    if (cur === 1) return d < h - HY_H ? 0 : d > m + HY_M ? 2 : 1;
    return d < m - HY_M ? target : 2;
  }

  private treeDist(t: VegTile, r: number, E: number, N: number, Hc: number) {
    const q = r * VEG_STRIDE, src = t.src;
    return Math.hypot(t.e0 + src[q] - E, t.n0 + src[q + 1] - N, src[q + 2] + src[q + 4] * 0.5 - Hc);
  }

  private hardStates(t: VegTile, E: number, N: number, Hc: number) {
    const st = t.st, n = st.length / 3;
    for (let r = 0; r < n; r++) {
      const L = this.level(this.treeDist(t, r, E, N, Hc), t.src[r * VEG_STRIDE + 3], -1);
      st[r * 3] = L; st[r * 3 + 1] = L; st[r * 3 + 2] = -1e4;
    }
  }

  /** teleport / LOD distance change: every tree to its level, no fades */
  private resetStates(E: number, N: number, Hc: number) {
    for (const t of this.tiles.values()) this.hardStates(t, E, N, Hc);
    for (const p of this.pools) p.rewriteStates();
  }

  /** trees in cells near a switch distance: apply hysteresis, start cross-fades on change */
  private updateStates(E: number, N: number, Hc: number, now: number, all: boolean) {
    const hA = this.lod.x * 0.9 - HY_H, hB = this.lod.x * 1.1 + HY_H, mA = this.lod.y * 0.9 - HY_M, mB = this.lod.y * 1.1 + HY_M;
    for (const t of this.tiles.values()) {
      const st = t.st;
      for (const c of t.cells) {
        const d = Math.hypot(c.cx - E, c.cy - N, c.cz - Hc);
        const dmin = d - c.r, dmax = d + c.r;
        if (!all && !((dmax > hA && dmin < hB) || (dmax > mA && dmin < mB))) continue;
        for (let r = c.l0; r < c.t1; r++) {
          const cur = st[r * 3];
          const L = this.level(this.treeDist(t, r, E, N, Hc), t.src[r * VEG_STRIDE + 3], cur);
          if (L === cur) continue;
          // reversing a fade in progress: continue from where it is
          const el = now - st[r * 3 + 2], prev = st[r * 3 + 1];
          st[r * 3 + 1] = cur; st[r * 3] = L;
          st[r * 3 + 2] = el < FADE && prev === L ? now - (FADE - el) : now;
          for (let pi = 0; pi < 7; pi++) {
            const o = c.own[pi];
            if (!o) continue;
            const j = VegPool.entryOf(o, r);
            if (j >= 0) this.pools[pi].writeState(o, j);
          }
        }
      }
    }
  }

  private dropTile(t: VegTile) {
    for (const c of t.cells) {
      for (let pi = 0; pi < 7; pi++) if (c.own[pi]) { this.pools[pi].free(c.own[pi]!); c.own[pi] = null; }
      c.mask = 0;
    }
    this.dirty = true;
  }

  dispose() {
    for (const p of this.pools) p.dispose();
    this.group.removeFromParent();
  }
}

/** fractional day of year (UTC; Toronto's seasons don't care about the hours) */
export function dayOfYear(ms: number): number {
  const d = new Date(ms);
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return (ms - y0) / 86400000 + 1;
}
