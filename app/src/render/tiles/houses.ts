// House archetypes (SPEC h_type) as unit models + global instanced pools with
// slot allocation. Instance transforms are anchor-relative (floating origin).
// Two detail levels: full archetypes (shadow casters) for tiles in the near
// rings, a 12-triangle block with a hip roof for distant tiles (no shadows).
import * as THREE from 'three/webgpu';
import type { HouseBuf } from '../../workers/meshing';
import { vertexColorMaterial } from './materials';

// ---------------------------------------------------------------------------- archetype geometry

type V3 = [number, number, number];

class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  tri(a: V3, b: V3, c: V3, rgb: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.nrm.push(nx, ny, nz);
      this.col.push(...rgb);
    }
  }
  quad(a: V3, b: V3, c: V3, d: V3, rgb: V3) {
    this.tri(a, b, c, rgb);
    this.tri(a, c, d, rgb);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

const WALL: V3 = [1, 1, 1];
const WALL_LO: V3 = [0.86, 0.86, 0.86];
const ROOF: V3 = [0.5, 0.47, 0.45];
const DOOR: V3 = [0.55, 0.5, 0.45];

/** unit box walls x∈[-.5,.5] (length), z∈[-.5,.5] (width), y∈[0,eave] */
function walls(g: GeoBuilder, eave: number, x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5) {
  const b: V3[] = [[x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]];
  for (let i = 0; i < 4; i++) {
    const p = b[i], q = b[(i + 1) % 4];
    // outward faces: CCW seen from outside
    // walls reach 0.25 (×height) below the base so houses never float on slopes
    g.tri([p[0], -0.25, p[2]], [q[0], -0.25, q[2]], [q[0], eave, q[2]], WALL_LO);
    g.tri([p[0], -0.25, p[2]], [q[0], eave, q[2]], [p[0], eave, p[2]], WALL);
  }
}

function gable(g: GeoBuilder, eave: number, ridge = 1, overhang = 0.04, x0 = -0.5, x1 = 0.5) {
  const o = overhang;
  const zA = -0.5 - o, zB = 0.5 + o;
  const ex0 = x0 - o, ex1 = x1 + o;
  const eo = eave - o * 0.6; // eaves drop slightly with the overhang
  // two roof planes along x (ridge along length)
  g.quad([ex0, eo, zB], [ex1, eo, zB], [ex1, ridge, 0], [ex0, ridge, 0], ROOF);
  g.quad([ex1, eo, zA], [ex0, eo, zA], [ex0, ridge, 0], [ex1, ridge, 0], ROOF);
  // gable ends (wall colour)
  g.tri([x1, eave, 0.5], [x1, eave, -0.5], [x1, ridge, 0], WALL);
  g.tri([x0, eave, -0.5], [x0, eave, 0.5], [x0, ridge, 0], WALL);
}

function hip(g: GeoBuilder, eave: number, ridge = 1, overhang = 0.04) {
  const o = overhang;
  const x0 = -0.5 - o, x1 = 0.5 + o, z0 = -0.5 - o, z1 = 0.5 + o;
  const inset = 0.3;
  const ra: V3 = [-0.5 + inset, ridge, 0], rb: V3 = [0.5 - inset, ridge, 0];
  const eo = eave - o * 0.6;
  g.quad([x0, eo, z1], [x1, eo, z1], rb, ra, ROOF);
  g.quad([x1, eo, z0], [x0, eo, z0], ra, rb, ROOF);
  g.tri([x1, eo, z1], [x1, eo, z0], rb, ROOF);
  g.tri([x0, eo, z0], [x0, eo, z1], ra, ROOF);
}

function flatRoof(g: GeoBuilder, y: number, rgb: V3 = ROOF) {
  g.quad([-0.5, y, 0.5], [0.5, y, 0.5], [0.5, y, -0.5], [-0.5, y, -0.5], rgb);
}

function door(g: GeoBuilder, x: number) {
  // small darker rectangle on the +z (front) wall
  const z = 0.501, w = 0.06, h = 0.28;
  g.quad([x - w, 0, z], [x + w, 0, z], [x + w, h, z], [x - w, h, z], DOOR);
}

export const HOUSE_TYPES = 6;

export function houseGeometry(type: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  switch (type) {
    case 0: // detached: gable along length
      walls(g, 0.62); gable(g, 0.62); door(g, 0.15); break;
    case 1: // large detached: hipped
      walls(g, 0.66); hip(g, 0.66); door(g, -0.1); break;
    case 2: // semi: gable + party wall bump at centre
      walls(g, 0.64); gable(g, 0.64); door(g, -0.3); door(g, 0.3);
      g.quad([-0.01, 0.64, 0.52], [0.01, 0.64, 0.52], [0.01, 1.0, 0.0], [-0.01, 1.0, 0.0], WALL_LO);
      break;
    case 3: // townhouse row: low-slope roof, several doors
      walls(g, 0.8); gable(g, 0.8, 1, 0.02);
      for (let k = -2; k <= 2; k++) door(g, k * 0.19);
      break;
    case 4: // bungalow: low hip
      walls(g, 0.58); hip(g, 0.58, 1, 0.06); door(g, 0.2); break;
    case 5: // garage / shed: flat-ish
    default:
      walls(g, 0.92); flatRoof(g, 0.92, [0.5, 0.49, 0.47]); break;
  }
  return g.build();
}

/** distant-house stand-in: walls + low pyramid roof (12 triangles) */
export function houseLowGeometry(type: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const eave = type === 5 ? 0.92 : type === 3 ? 0.8 : 0.64;
  // walls without the below-ground skirt (slopes are invisible from afar)
  const b: V3[] = [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5]];
  for (let i = 0; i < 4; i++) {
    const p = b[i], q = b[(i + 1) % 4];
    g.quad([p[0], -0.1, p[2]], [q[0], -0.1, q[2]], [q[0], eave, q[2]], [p[0], eave, p[2]], WALL);
  }
  if (type === 5) flatRoof(g, eave, [0.5, 0.49, 0.47]);
  else {
    const top: V3 = [0, 1, 0];
    for (let i = 0; i < 4; i++) {
      const p = b[i], q = b[(i + 1) % 4];
      g.tri([p[0], eave, p[2]], [q[0], eave, q[2]], top, ROOF);
    }
  }
  return g.build();
}

// Toronto-ish house colours: red/buff brick, siding, stucco
const HOUSE_COLORS = [
  0xb98a74, 0xa8796a, 0xc9a58a, 0xdccbab, 0xd3c09d, 0xe8e3d8, 0xc8cdcf, 0xaab3b8,
  0xddd4c6, 0xc2a189, 0x9e7566, 0xebe1cc, 0xcfc1ac, 0xb6bdaf, 0xe2d9c9, 0xd9d6cf,
];

// ---------------------------------------------------------------------------- pools

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

interface TileHouses {
  pools: Pool[];
  originE: number;
  originN: number;
  data: HouseBuf;
  /** per type: slot for each instance (by instance idx in data) */
  slots: Int32Array[];
  /** per type: data index for each entry in slots */
  items: Int32Array[];
}

class Pool {
  mesh: THREE.InstancedMesh;
  count = 0;
  cap: number;
  slotTile: (TileHouses | null)[] = [];
  slotEntry!: Int32Array;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  parent: THREE.Object3D;
  shadows: boolean;
  /** slot range written since the last flush (uploads only that range) */
  lo = Infinity;
  hi = -1;
  mark(s: number) { if (s < this.lo) this.lo = s; if (s > this.hi) this.hi = s; }
  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, cap: number, parent: THREE.Object3D, shadows = true) {
    this.geometry = geometry; this.material = material; this.parent = parent; this.shadows = shadows;
    this.cap = cap;
    this.mesh = this.makeMesh(cap);
    this.slotEntry = new Int32Array(cap);
  }
  private makeMesh(cap: number) {
    const m = new THREE.InstancedMesh(this.geometry, this.material, cap);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = this.shadows;
    m.receiveShadow = true;
    m.name = this.shadows ? 'houses' : 'housesLo';
    this.parent.add(m);
    return m;
  }
  ensure(n: number) {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    const old = this.mesh;
    const m = this.makeMesh(cap);
    (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    (m.instanceColor!.array as Float32Array).set(old.instanceColor!.array as Float32Array);
    m.position.copy(old.position);
    m.visible = old.visible;
    m.count = this.count;
    this.parent.remove(old);
    old.dispose();
    this.mesh = m;
    const se = new Int32Array(cap); se.set(this.slotEntry); this.slotEntry = se;
    this.cap = cap;
  }
}

export class HousePools {
  pools: Pool[] = [];
  poolsLo: Pool[] = [];
  tiles = new Map<string, TileHouses>();
  group = new THREE.Group();
  private anchorE = 0;
  private anchorN = 0;
  dirty = false;

  constructor() {
    this.group.name = 'housePools';
    const mat = vertexColorMaterial('houses');
    for (let t = 0; t < HOUSE_TYPES; t++) this.pools.push(new Pool(houseGeometry(t), mat, 4096, this.group));
    for (let t = 0; t < HOUSE_TYPES; t++) this.poolsLo.push(new Pool(houseLowGeometry(t), mat, 4096, this.group, false));
  }

  get instanceCount() {
    return this.pools.reduce((s, p) => s + p.count, 0) + this.poolsLo.reduce((s, p) => s + p.count, 0);
  }

  /** detail level a tile's houses are drawn at (undefined = not shown) */
  levelOf(key: string): 'hi' | 'lo' | undefined {
    const t = this.tiles.get(key);
    return t ? (t.pools === this.pools ? 'hi' : 'lo') : undefined;
  }

  /** place the pools at a new anchor (world E,N) and rewrite all instances */
  rebase(e: number, n: number) {
    this.anchorE = e; this.anchorN = n;
    for (const p of [...this.pools, ...this.poolsLo]) p.mesh.position.set(e, 0, -n);
    for (const t of this.tiles.values()) this.writeTile(t);
    this.dirty = true;
  }

  add(key: string, originE: number, originN: number, data: HouseBuf, lo = false) {
    if (this.tiles.has(key) || data.count === 0) return;
    const perType: number[][] = Array.from({ length: HOUSE_TYPES }, () => []);
    for (let i = 0; i < data.count; i++) perType[Math.min(data.type[i], HOUSE_TYPES - 1)].push(i);
    const pools = lo ? this.poolsLo : this.pools;
    const t: TileHouses = { pools, originE, originN, data, slots: [], items: [] };
    for (let k = 0; k < HOUSE_TYPES; k++) {
      const pool = pools[k];
      const items = Int32Array.from(perType[k]);
      pool.ensure(pool.count + items.length);
      const slots = new Int32Array(items.length);
      for (let j = 0; j < items.length; j++) {
        const s = pool.count++;
        slots[j] = s;
        pool.slotTile[s] = t;
        pool.slotEntry[s] = j;
      }
      t.slots.push(slots);
      t.items.push(items);
      pool.mesh.count = pool.count;
    }
    this.tiles.set(key, t);
    this.writeTile(t);
    this.dirty = true;
  }

  remove(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    for (let k = 0; k < HOUSE_TYPES; k++) {
      const pool = t.pools[k];
      const mArr = pool.mesh.instanceMatrix.array as Float32Array;
      const cArr = pool.mesh.instanceColor!.array as Float32Array;
      const slots = t.slots[k];
      for (let j = 0; j < slots.length; j++) {
        const s = slots[j];
        const last = pool.count - 1;
        if (s !== last) {
          mArr.copyWithin(s * 16, last * 16, last * 16 + 16);
          cArr.copyWithin(s * 3, last * 3, last * 3 + 3);
          pool.mark(s);
          const owner = pool.slotTile[last]!;
          const entry = pool.slotEntry[last];
          owner.slots[k][entry] = s;
          pool.slotTile[s] = owner;
          pool.slotEntry[s] = entry;
        }
        pool.slotTile[last] = null;
        pool.count--;
      }
      pool.mesh.count = pool.count;
    }
    this.tiles.delete(key);
    this.dirty = true;
  }

  private writeTile(t: TileHouses) {
    const d = t.data;
    const ox = t.originE - this.anchorE, on = t.originN - this.anchorN;
    for (let k = 0; k < HOUSE_TYPES; k++) {
      const pool = t.pools[k];
      const mArr = pool.mesh.instanceMatrix.array as Float32Array;
      const cArr = pool.mesh.instanceColor!.array as Float32Array;
      const items = t.items[k], slots = t.slots[k];
      for (let j = 0; j < items.length; j++) {
        const i = items[j], s = slots[j];
        pool.mark(s);
        _p.set(ox + d.xy[i * 2], d.base[i], -(on + d.xy[i * 2 + 1]));
        _q.setFromAxisAngle(_up, d.angle[i]);
        _s.set(Math.max(d.len[i], 2), Math.max(d.height[i], 2), Math.max(d.wid[i], 2));
        _m.compose(_p, _q, _s);
        _m.toArray(mArr, s * 16);
        const v = d.variant[i];
        _c.setHex(HOUSE_COLORS[v % HOUSE_COLORS.length]);
        const f = 0.92 + ((v >> 4) / 15) * 0.14;
        cArr[s * 3] = _c.r * f; cArr[s * 3 + 1] = _c.g * f; cArr[s * 3 + 2] = _c.b * f;
      }
    }
  }

  /** push pending changes to the GPU (call once per frame) */
  flush() {
    if (!this.dirty) return;
    for (const p of [...this.pools, ...this.poolsLo]) {
      if (p.hi < p.lo) continue;
      const lo = p.lo, n = Math.min(p.hi, p.cap - 1) - lo + 1;
      const im = p.mesh.instanceMatrix, ic = p.mesh.instanceColor!;
      im.clearUpdateRanges(); im.addUpdateRange(lo * 16, n * 16); im.needsUpdate = true;
      ic.clearUpdateRanges(); ic.addUpdateRange(lo * 3, n * 3); ic.needsUpdate = true;
      p.lo = Infinity; p.hi = -1;
    }
    this.dirty = false;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  dispose() {
    for (const p of [...this.pools, ...this.poolsLo]) {
      p.mesh.dispose();
      p.geometry.dispose();
    }
  }
}
