// House archetypes (workers/houseFront.ts types) as unit models + global
// instanced pools with slot allocation. Instance transforms are anchor-relative
// (floating origin). Unit space: x ∈ [-½, ½] frontage, z ∈ [-½, ½] depth with
// the street front at +z, y ∈ [0, 1] base → ridge.
//
// Detail levels: a low-poly body per archetype (walls + roof; windows, doors,
// garage doors, brick/siding and shingles come from the house shader) for tiles
// in the near rings, a 12-triangle block beyond, and — only for houses within
// ~230 m of the camera — porches, bay windows, steps and chimneys in separate
// "detail" pools rebuilt as the camera moves.
import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, texture, floor, fract, mod, smoothstep, mix, step, max, abs, sin, pow, clamp, select,
  fwidth, positionGeometry, normalGeometry, normalWorld, positionWorld, cameraPosition, reflect, dot,
} from 'three/tsl';
import type { HouseBuf } from '../../workers/meshing';
import { U } from '../uniforms';
import { OCC } from './facadeMaterial';
import { baseTone } from './materials';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type V3 = [number, number, number];

// parts (hp.x): what a surface is made of
const P_WALL = 0, P_ROOF = 1, P_TRIM = 2, P_CONC = 3, P_DECK = 4, P_CHIM = 5, P_GARAGE = 6, P_PROOF = 7;

// ---------------------------------------------------------------------------- archetype geometry

class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  hp: number[] = [];
  hf: number[] = [];
  /** current surface record: part, eave (unit y), door x (unit, <-1 none), door mode, face range f0..f1 */
  part = P_WALL; eave = 0.6; doorX = -9; mode = 0; f0 = -0.5; f1 = 0.5;
  set(part: number, f0 = this.f0, f1 = this.f1) { this.part = part; this.f0 = f0; this.f1 = f1; return this; }
  tri(a: V3, b: V3, c: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.nrm.push(nx, ny, nz);
      this.hp.push(this.part, this.eave, this.doorX, this.mode);
      this.hf.push(this.f0, this.f1);
    }
  }
  quad(a: V3, b: V3, c: V3, d: V3) { this.tri(a, b, c); this.tri(a, c, d); }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('hp', new THREE.Float32BufferAttribute(this.hp, 4));
    g.setAttribute('hf', new THREE.Float32BufferAttribute(this.hf, 2));
    return g;
  }
}

/** walls of the box [x0,x1]×[z0,z1] from y0 to eave (front +z face may use another part) */
function walls(g: GeoBuilder, eave: number, x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, y0 = -0.25, part = P_WALL, frontPart = part, eaveF = eave) {
  g.eave = eaveF;
  g.set(frontPart, x0, x1).quad([x0, y0, z1], [x1, y0, z1], [x1, eave, z1], [x0, eave, z1]); // front (+z)
  g.set(part, x0, x1).quad([x1, y0, z0], [x0, y0, z0], [x0, eave, z0], [x1, eave, z0]); // back
  g.set(part, z0, z1).quad([x1, y0, z1], [x1, y0, z0], [x1, eave, z0], [x1, eave, z1]); // +x
  g.quad([x0, y0, z0], [x0, y0, z1], [x0, eave, z1], [x0, eave, z0]); // -x
  g.set(P_WALL);
}

/** gable roof, ridge along x (side gables) */
function gableX(g: GeoBuilder, eave: number, ridge = 1, x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, o = 0.04) {
  const zm = (z0 + z1) / 2, eo = eave - o * 0.6;
  g.set(P_ROOF);
  g.quad([x0 - o, eo, z1 + o], [x1 + o, eo, z1 + o], [x1 + o, ridge, zm], [x0 - o, ridge, zm]);
  g.quad([x1 + o, eo, z0 - o], [x0 - o, eo, z0 - o], [x0 - o, ridge, zm], [x1 + o, ridge, zm]);
  g.eave = eave;
  g.set(P_WALL, z0, z1);
  g.tri([x1, eave, z1], [x1, eave, z0], [x1, ridge, zm]);
  g.tri([x0, eave, z0], [x0, eave, z1], [x0, ridge, zm]);
}

/** gable roof, ridge along z (front gable facing the street) */
function gableZ(g: GeoBuilder, eave: number, ridge = 1, x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, o = 0.04) {
  const xm = (x0 + x1) / 2, eo = eave - o * 0.6;
  g.set(P_ROOF);
  g.quad([x1 + o, eo, z1 + o], [x1 + o, eo, z0 - o], [xm, ridge, z0 - o], [xm, ridge, z1 + o]);
  g.quad([x0 - o, eo, z0 - o], [x0 - o, eo, z1 + o], [xm, ridge, z1 + o], [xm, ridge, z0 - o]);
  g.eave = eave;
  g.set(P_WALL, x0, x1);
  g.tri([x0, eave, z1], [x1, eave, z1], [xm, ridge, z1]);
  g.tri([x1, eave, z0], [x0, eave, z0], [xm, ridge, z0]);
}

/** hip roof over [x0,x1]×[z0,z1], ridge along the longer unit side */
function hip(g: GeoBuilder, eave: number, ridge = 1, x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, o = 0.04, inset = 0.3) {
  const eo = eave - o * 0.6;
  const a0 = x0 - o, a1 = x1 + o, b0 = z0 - o, b1 = z1 + o;
  const zm = (z0 + z1) / 2, xm = (x0 + x1) / 2;
  g.set(P_ROOF);
  if (x1 - x0 >= z1 - z0) {
    const ri = Math.min(inset, (x1 - x0) * 0.45);
    const ra: V3 = [x0 + ri, ridge, zm], rb: V3 = [x1 - ri, ridge, zm];
    g.quad([a0, eo, b1], [a1, eo, b1], rb, ra);
    g.quad([a1, eo, b0], [a0, eo, b0], ra, rb);
    g.tri([a1, eo, b1], [a1, eo, b0], rb);
    g.tri([a0, eo, b0], [a0, eo, b1], ra);
  } else {
    const ri = Math.min(inset, (z1 - z0) * 0.45);
    const ra: V3 = [xm, ridge, z1 - ri], rb: V3 = [xm, ridge, z0 + ri];
    g.quad([a1, eo, b1], [a1, eo, b0], rb, ra);
    g.quad([a0, eo, b0], [a0, eo, b1], ra, rb);
    g.tri([a0, eo, b1], [a1, eo, b1], ra);
    g.tri([a1, eo, b0], [a0, eo, b0], rb);
  }
}

function flatRoof(g: GeoBuilder, y: number, x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5) {
  g.set(P_ROOF).quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]);
}

/** closed box (no bottom) of one part */
function box(g: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, part: number, top = true) {
  g.set(part, x0, x1);
  g.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  g.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
  g.set(part, z0, z1);
  g.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
  g.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  if (top) g.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
}

/** thin post (4 sides) */
function post(g: GeoBuilder, x: number, z: number, y0: number, y1: number, r = 0.012) {
  box(g, x - r, y0, z - r * 1.3, x + r, y1, z + r * 1.3, P_TRIM, false);
}

/** porch: deck, posts, flat roof slab; front edge at z1 */
function porch(g: GeoBuilder, x0: number, x1: number, z0: number, z1: number, yRoof: number, nPosts = 2) {
  box(g, x0, -0.05, z0, x1, 0.07, z1, P_DECK);
  for (let k = 0; k < nPosts; k++) post(g, x0 + 0.02 + ((x1 - x0 - 0.04) * k) / Math.max(1, nPosts - 1), z1 - 0.02, 0.07, yRoof);
  box(g, x0 - 0.01, yRoof, z0, x1 + 0.01, yRoof + 0.025, z1 + 0.01, P_PROOF);
}

function steps(g: GeoBuilder, x0: number, x1: number, z0: number, depth: number, h: number) {
  box(g, x0, -0.05, z0, x1, h * 0.5, z0 + depth * 0.5, P_CONC);
  box(g, x0, -0.05, z0 + depth * 0.5, x1, h * 0.2, z0 + depth, P_CONC);
}

function chimney(g: GeoBuilder, x: number, z: number, y0: number, y1: number, w = 0.05, d = 0.07) {
  box(g, x - w, y0, z - d, x + w, y1, z + d, P_CHIM);
}

export const HOUSE_TYPES = 9;

/** body: walls + roof (+ garage volume); door and window layout carried in hp */
export function houseGeometry(type: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  switch (type) {
    case 0: // bay-and-gable: front gable, door to one side
      g.doorX = 0.24; g.mode = 0;
      walls(g, 0.64); gableZ(g, 0.64, 1, -0.5, 0.5, -0.5, 0.5, 0.05); break;
    case 1: // semi pair: side gable, mirrored doors at the outer ends
      g.doorX = 0.32; g.mode = 1;
      walls(g, 0.64); gableX(g, 0.64);
      g.set(P_TRIM).quad([-0.006, 0.64, 0.52], [0.006, 0.64, 0.52], [0.006, 1.0, 0.0], [-0.006, 1.0, 0.0]);
      break;
    case 2: // row: doors every unit, low side gable
      g.doorX = 0; g.mode = 2;
      walls(g, 0.84); gableX(g, 0.84, 1, -0.5, 0.5, -0.5, 0.5, 0.02); break;
    case 3: // postwar bungalow: low hip, door off-centre, picture window
      g.doorX = 0.22; g.mode = 3;
      walls(g, 0.56); hip(g, 0.56, 1, -0.5, 0.5, -0.5, 0.5, 0.07, 0.25); break;
    case 4: { // suburban 2-storey with attached garage on +x
      g.doorX = -0.02; g.mode = 0;
      walls(g, 0.8, -0.5, 0.18, -0.5, 0.45); hip(g, 0.8, 1, -0.5, 0.18, -0.5, 0.45, 0.04, 0.2);
      g.doorX = -9;
      walls(g, 0.4, 0.18, 0.5, -0.3, 0.5, -0.25, P_WALL, P_GARAGE); hip(g, 0.4, 0.6, 0.18, 0.5, -0.3, 0.5, 0.03, 0.15);
      break;
    }
    case 5: // garage / shed
      g.doorX = -9;
      walls(g, 0.9, -0.5, 0.5, -0.5, 0.5, -0.25, P_WALL, P_GARAGE); flatRoof(g, 0.9); break;
    case 6: // Annex house: big hip + front gable dormer
      g.doorX = -0.26; g.mode = 0;
      walls(g, 0.6); hip(g, 0.6, 1, -0.5, 0.5, -0.5, 0.5, 0.05, 0.3);
      g.eave = 0.6; g.doorX = -9;
      g.set(P_WALL, 0.05, 0.45).tri([0.05, 0.6, 0.47], [0.45, 0.6, 0.47], [0.25, 0.86, 0.47]);
      g.set(P_ROOF);
      g.quad([0.47, 0.58, 0.49], [0.47, 0.58, 0.2], [0.25, 0.87, 0.2], [0.25, 0.87, 0.49]);
      g.quad([0.03, 0.58, 0.2], [0.03, 0.58, 0.49], [0.25, 0.87, 0.49], [0.25, 0.87, 0.2]);
      break;
    case 7: // split-level: low wing (-x) + raised wing (+x) with garage under
      g.doorX = -0.06; g.mode = 0;
      walls(g, 0.55, -0.5, 0.0, -0.45, 0.45); hip(g, 0.55, 0.78, -0.5, 0.0, -0.45, 0.45, 0.05, 0.15);
      g.doorX = -9;
      g.eave = 0.86;
      g.set(P_GARAGE, 0.0, 0.5).quad([0.0, -0.25, 0.5], [0.5, -0.25, 0.5], [0.5, 0.33, 0.5], [0.0, 0.33, 0.5]);
      g.set(P_WALL, 0.0, 0.5).quad([0.0, 0.33, 0.5], [0.5, 0.33, 0.5], [0.5, 0.86, 0.5], [0.0, 0.86, 0.5]);
      g.set(P_WALL, 0.0, 0.5).quad([0.5, -0.25, -0.5], [0.0, -0.25, -0.5], [0.0, 0.86, -0.5], [0.5, 0.86, -0.5]);
      g.set(P_WALL, -0.5, 0.5).quad([0.5, -0.25, 0.5], [0.5, -0.25, -0.5], [0.5, 0.86, -0.5], [0.5, 0.86, 0.5]);
      g.quad([0.0, -0.25, -0.5], [0.0, -0.25, 0.5], [0.0, 0.86, 0.5], [0.0, 0.86, -0.5]);
      gableX(g, 0.86, 1, 0.0, 0.5, -0.5, 0.5, 0.04);
      break;
    case 8: default: { // large suburban: 2 storeys, double garage projecting forward on +x
      g.doorX = -0.18; g.mode = 0;
      walls(g, 0.78, -0.5, 0.5, -0.5, 0.28); hip(g, 0.78, 1, -0.5, 0.5, -0.5, 0.28, 0.04, 0.3);
      g.doorX = -9;
      walls(g, 0.36, 0.06, 0.5, 0.1, 0.5, -0.25, P_WALL, P_GARAGE); hip(g, 0.36, 0.52, 0.06, 0.5, 0.1, 0.5, 0.03, 0.12);
      break;
    }
  }
  return g.build();
}

/** near-camera details: porches, bays, steps, chimneys */
export function houseDetailGeometry(type: number): THREE.BufferGeometry | null {
  const g = new GeoBuilder();
  g.eave = 0.6; g.doorX = -9; g.mode = 0;
  switch (type) {
    case 0: // two-storey bay window (-x), porch + steps at the door (+x), side chimney
      g.eave = 0.6;
      box(g, -0.42, -0.1, 0.5, -0.04, 0.6, 0.57, P_WALL);
      g.set(P_ROOF).quad([-0.44, 0.6, 0.58], [-0.02, 0.6, 0.58], [-0.02, 0.63, 0.5], [-0.44, 0.63, 0.5]);
      porch(g, 0.02, 0.48, 0.5, 0.64, 0.3);
      steps(g, 0.12, 0.34, 0.64, 0.08, 0.07);
      chimney(g, -0.44, -0.1, 0.62, 1.05);
      break;
    case 1:
      porch(g, 0.1, 0.48, 0.5, 0.63, 0.3); porch(g, -0.48, -0.1, 0.5, 0.63, 0.3);
      steps(g, 0.22, 0.42, 0.63, 0.07, 0.07); steps(g, -0.42, -0.22, 0.63, 0.07, 0.07);
      chimney(g, 0.0, -0.15, 0.7, 1.08);
      break;
    case 3:
      steps(g, 0.14, 0.3, 0.5, 0.1, 0.08);
      box(g, 0.1, 0.4, 0.5, 0.34, 0.43, 0.56, P_PROOF);
      chimney(g, -0.3, 0.05, 0.6, 1.08, 0.04, 0.06);
      break;
    case 4:
      steps(g, -0.1, 0.06, 0.45, 0.08, 0.06);
      post(g, -0.12, 0.54, 0.0, 0.34, 0.012); post(g, 0.08, 0.54, 0.0, 0.34, 0.012);
      g.set(P_PROOF);
      g.quad([-0.15, 0.34, 0.56], [0.11, 0.34, 0.56], [0.11, 0.42, 0.45], [-0.15, 0.42, 0.45]);
      chimney(g, -0.5, -0.1, 0.6, 1.06, 0.03, 0.06);
      break;
    case 6: // Annex verandah across the front, steps, chimney
      porch(g, -0.48, 0.48, 0.5, 0.68, 0.28, 4);
      steps(g, -0.36, -0.14, 0.68, 0.08, 0.07);
      chimney(g, 0.35, -0.2, 0.8, 1.05);
      break;
    case 7:
      steps(g, -0.16, 0.02, 0.45, 0.08, 0.05);
      chimney(g, -0.4, 0.0, 0.5, 0.9, 0.04, 0.06);
      break;
    case 8:
      steps(g, -0.26, -0.08, 0.28, 0.08, 0.05);
      post(g, -0.28, 0.4, 0.0, 0.4, 0.01); post(g, -0.06, 0.4, 0.0, 0.4, 0.01);
      g.set(P_PROOF);
      g.quad([-0.3, 0.4, 0.42], [-0.04, 0.4, 0.42], [-0.04, 0.5, 0.28], [-0.3, 0.5, 0.28]);
      chimney(g, -0.5, -0.1, 0.7, 1.05, 0.03, 0.06);
      break;
    default:
      return null;
  }
  return g.build();
}

/** distant-house stand-in: walls + low pyramid roof (12 triangles) */
export function houseLowGeometry(type: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const eave = type === 5 ? 0.9 : type === 2 ? 0.84 : type === 3 ? 0.56 : 0.64;
  g.eave = eave; g.doorX = -9;
  const b: V3[] = [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5]];
  for (let i = 0; i < 4; i++) {
    const p = b[i], q = b[(i + 1) % 4];
    g.set(P_WALL, i % 2 ? -0.5 : -0.5, 0.5).quad([p[0], -0.1, p[2]], [q[0], -0.1, q[2]], [q[0], eave, q[2]], [p[0], eave, p[2]]);
  }
  if (type === 5) flatRoof(g, eave);
  else {
    g.set(P_ROOF);
    for (let i = 0; i < 4; i++) {
      const p = b[i], q = b[(i + 1) % 4];
      g.tri([p[0], eave, p[2]], [q[0], eave, q[2]], [0, 1, 0]);
    }
  }
  return g.build();
}

// ---------------------------------------------------------------------------- colours

// walls: Toronto red / buff brick (old city), then siding, stucco, painted brick
const BRICK = [0xa65d45, 0x9b4f3c, 0xb36b4f, 0x8c4a3a, 0xc9ad80, 0xd2b98e, 0x7f4535, 0xb98a74];
const OTHER = [0xe8e3d8, 0xc8cdcf, 0xaab3b8, 0xddd4c6, 0xebe1cc, 0xcfc1ac, 0xb6bdaf, 0xd9d6cf, 0x8c9a8f, 0x6f7d8c, 0xe2d9c9, 0xc2a189];
// shingles, trim, doors, garage doors (sRGB) — packed as rows of a 16×4 palette texture
const ROOF_P = [0x4a4a4a, 0x3a3b3d, 0x5a4636, 0x6b6660, 0x6b3b2f, 0x3f4a3d, 0x4d5660, 0x2c2c2e, 0x55504a, 0x5e5a55, 0x3c3530, 0x6a6a6a, 0x444c52, 0x5b4a3e, 0x383838, 0x4f463f];
const TRIM_P = [0xf2efe6, 0xf4f1ea, 0xe8e2d2, 0x2a2a2a, 0x2f4538, 0xf0ece0, 0x6b2d2a, 0xe9e4d8, 0x3a3f44, 0xf5f2ea, 0xd9cfb8, 0x1f2a36, 0xefe9dc, 0x584538, 0xf3f0e8, 0x8a8a84];
const DOOR_P = [0x7a1f1f, 0x1c1c1c, 0x1d2f55, 0x2e4d34, 0x5a3a24, 0xe8e4da, 0x8b5a2b, 0x2f3b45, 0x6a1b3a, 0x3d2a1e, 0x1f3a2b, 0x9a2a1a, 0x4a4a4a, 0x2a2a2a, 0x6d4c2f, 0x14324a];
const GAR_P = [0xf0eee8, 0xe6e2d8, 0xd8d2c4, 0x8a8680, 0x5a5550, 0xf2f0ea, 0xcfc8b8, 0x3a3a3a, 0xece9e0, 0xbfb8a8, 0xf4f2ec, 0x6b5a48, 0xe0dbd0, 0x9a9690, 0xf0ede4, 0x7a5a3c];

let _pal: THREE.DataTexture | null = null;
function palette() {
  if (_pal) return _pal;
  const d = new Float32Array(16 * 4 * 4);
  [ROOF_P, TRIM_P, DOOR_P, GAR_P].forEach((row, r) => row.forEach((c, i) => {
    d.set([((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1].map((v, k) => (k < 3 ? Math.pow(v, 2.2) : v)), (r * 16 + i) * 4);
  }));
  const t = new THREE.DataTexture(d, 16, 4, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return (_pal = t);
}

const hash2 = (a: N, b: N): N => fract(sin(a.mul(12.9898).add(b.mul(78.233))).mul(43758.5453));
const box1 = (x: N, a: N, b: N, w: N): N => smoothstep(a.sub(w), a.add(w), x).mul(float(1).sub(smoothstep(b.sub(w), b.add(w), x)));
const lin = (r: number, g: number, b: number) => vec3(Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2));

/** house shader: part colours, window / door / garage door layout, brick or siding, shingles */
function houseMaterial(name: string) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = name;
  const pal = palette();
  const hinfo = attribute('hinfo', 'vec4');
  const hcol = attribute('hcol', 'vec3');
  const hp = attribute('hp', 'vec4');
  const hf = attribute('hf', 'vec2');
  const sx: N = hinfo.x, sy: N = hinfo.y, sz: N = hinfo.z;
  const code = floor(hinfo.w.add(0.5));
  const seed = mod(code, 256), brick = step(255.5, code);
  const part = floor(hp.x.add(0.5));
  const is = (p: number) => step(p - 0.5, part).mul(step(part, p + 0.5));
  const pg = positionGeometry, nG = normalGeometry;
  const isFB = step(0.6, abs(nG.z)), isFront = step(0.6, nG.z);
  const isVert = float(1).sub(step(0.3, abs(nG.y)));
  const along = mix(pg.z, pg.x, isFB), scaleA = mix(sz, sx, isFB);
  const u: N = along.sub(hf.x).mul(scaleA);
  const Lf: N = hf.y.sub(hf.x).mul(scaleA);
  const h: N = pg.y.mul(sy);
  const eaveM: N = hp.y.mul(sy);
  const pickC = (row: number, k: number) => texture(pal, vec2(floor(fract(seed.mul(k).div(256).add(seed.mul(0.618))).mul(16)).add(0.5).div(16), (row + 0.5) / 4)).rgb;
  const roofC = pickC(0, 1.37), trimC = pickC(1, 2.71), doorC = pickC(2, 5.13), garC = pickC(3, 3.33);
  const wallBase: N = vec3(hcol); // instance colours are written linear (THREE.Color.setHex)

  // storeys and window grid
  const nSt = max(floor(eaveM.div(2.75).add(0.35)), 1);
  const stH = eaveM.div(nSt);
  const st = floor(h.div(stH));
  const fyM = fract(h.div(stH)).mul(stH);
  const nb = max(floor(Lf.div(2.9).add(0.3)), 1);
  const bw = Lf.div(nb);
  const cu = u.div(bw), cx = floor(cu), fx = fract(cu).mul(bw); // metres within the bay
  const wu = max(fwidth(u), 0.002), wh = max(fwidth(h), 0.002);
  const far = smoothstep(0.1, 0.35, max(wu, wh));
  // bungalow picture window: ground floor, front, wider
  const mode = hp.w;
  const pict = step(2.5, mode).mul(isFront).mul(step(st, 0.5)).mul(step(cx, 0.5));
  const winHalf = mix(float(0.5), bw.mul(0.4), pict);
  const winTop = mix(float(0.85).add(clamp(stH.sub(1.25), 0.9, 1.45)), float(2.2), pict);
  const winMask = box1(fx, bw.mul(0.5).sub(winHalf), bw.mul(0.5).add(winHalf), wu).mul(box1(fyM, float(0.85), winTop, wh))
    .mul(step(h, eaveM.sub(0.25))).mul(box1(u, float(0.45), Lf.sub(0.45), wu)).mul(step(1.8, Lf));
  // attic window in gable ends
  const attic = box1(u, Lf.mul(0.5).sub(0.42), Lf.mul(0.5).add(0.42), wu).mul(box1(h, eaveM.add(0.55), eaveM.add(1.55), wh)).mul(isFB).mul(step(eaveM.add(2.4), sy));
  // door(s) on the front face
  const doorX = hp.z;
  const dc1 = doorX.sub(hf.x).mul(sx), dc2 = doorX.negate().sub(hf.x).mul(sx);
  const hasDoor = step(-1, doorX).mul(isFront);
  const rowU = fract(u.div(5.5)).mul(5.5);
  const dMask1 = box1(u, dc1.sub(0.48), dc1.add(0.48), wu);
  const dMask2 = box1(u, dc2.sub(0.48), dc2.add(0.48), wu).mul(step(0.5, mode)).mul(step(mode, 1.5));
  const dMaskR = box1(rowU, float(0.7), float(1.65), wu).mul(step(1.5, mode)).mul(step(mode, 2.5));
  const dMaskU = mix(clamp(dMask1.add(dMask2), 0, 1), dMaskR, step(1.5, mode).mul(step(mode, 2.5)));
  const door = dMaskU.mul(box1(h, float(0.3), float(2.3), wh)).mul(hasDoor);
  const nearDoor = dMaskU.mul(hasDoor).mul(step(st, 0.5));
  const win = clamp(winMask.mul(float(1).sub(nearDoor)).add(attic), 0, 1).mul(isVert).mul(is(P_WALL));
  const winF = mix(win, float(0.22).mul(isVert).mul(is(P_WALL)).mul(step(h, eaveM)), far);
  // window frame (trim colour) around the pane
  const frame = float(1).sub(box1(fx, bw.mul(0.5).sub(winHalf).add(0.08), bw.mul(0.5).add(winHalf).sub(0.08), wu)
    .mul(box1(fyM, float(0.93), winTop.sub(0.08), wh))).mul(winMask);
  const wr = hash2(seed.add(st.mul(3.1)), cx.add(Lf.mul(0.37)).add(isFB.mul(11.0)));

  // wall surface: brick coursing or lap siding
  const by = h.div(0.0667), brow = floor(by), bx = u.div(0.203).add(brow.mul(0.5));
  const bW = max(fwidth(by), fwidth(bx));
  const nearK = float(1).sub(smoothstep(0.12, 0.35, bW));
  const mortar = float(1).sub(box1(fract(by), float(0.14), float(1), bW).mul(box1(fract(bx), float(0.05), float(1), bW)));
  const bTone = hash2(floor(bx), brow.mul(0.37)).sub(0.5).mul(0.16);
  const siding = box1(fract(h.div(0.2)), float(0.0), float(0.12), fwidth(h.div(0.2))).mul(float(1).sub(smoothstep(0.2, 0.45, fwidth(h.div(0.2)))));
  let wallC: N = wallBase.mul(float(1).add(mix(siding.mul(-0.14), bTone.sub(mortar.mul(0.18)), brick).mul(nearK.max(float(1).sub(brick)))));
  wallC = wallC.mul(mix(float(0.8), float(1), smoothstep(-0.2, 0.5, h))); // foundation
  wallC = mix(wallC, trimC, frame.mul(float(1).sub(far)));

  // glass: dark with sky reflection; blinds on some panes
  const Vd = positionWorld.sub(cameraPosition).normalize();
  const cosT = abs(dot(Vd, normalWorld));
  const fres = pow(float(1).sub(cosT), 4);
  const R = reflect(Vd, normalWorld);
  const ry = R.y.add(wr.sub(0.5).mul(0.2));
  const sky = mix(vec3(0.16, 0.165, 0.17), mix(vec3(U.skyHorizon as N), vec3(U.skyZenith as N), smoothstep(0, 0.7, ry)), smoothstep(-0.12, 0.08, ry));
  const blind = step(0.7, wr).mul(step(winTop.sub(0.5).sub(wr.mul(0.4)), fyM));
  const glassC = mix(lin(0.08, 0.09, 0.1), lin(0.7, 0.66, 0.58), blind.mul(0.8));
  let col: N = mix(wallC, glassC, winF.mul(float(1).sub(frame.mul(float(1).sub(far)))));
  // door: panel with a small light
  col = mix(col, mix(doorC, doorC.mul(0.55), box1(h, float(1.7), float(2.1), wh).mul(0.6)), door.mul(is(P_WALL)).mul(isVert));
  // garage door: sectional panels
  const gU = u, gSplit = step(5.6, Lf);
  const gd = box1(gU, float(0.35), Lf.sub(0.35), wu).mul(float(1).sub(box1(gU, Lf.mul(0.5).sub(0.18), Lf.mul(0.5).add(0.18), wu).mul(gSplit)))
    .mul(box1(h, float(0.0), float(2.2), wh)).mul(isFront).mul(is(P_GARAGE));
  const grooves = box1(fract(h.div(0.55)), float(0.0), float(0.06), fwidth(h.div(0.55))).mul(float(1).sub(far));
  const garWall = wallC;
  col = mix(col, garWall, is(P_GARAGE));
  col = mix(col, garC.mul(float(1).sub(grooves.mul(0.25))), gd);
  // shingles
  const sh = box1(fract(h.div(0.19)), float(0.0), float(0.1), fwidth(h.div(0.19))).mul(float(1).sub(smoothstep(0.2, 0.45, fwidth(h.div(0.19)))));
  const shTone = hash2(floor(positionWorld.x.div(0.9)), floor(h.div(0.19))).sub(0.5).mul(0.1);
  const roofCol = roofC.mul(float(1).sub(sh.mul(0.25)).add(shTone));
  col = mix(col, roofCol, is(P_ROOF).add(is(P_PROOF)));
  col = mix(col, trimC, is(P_TRIM));
  col = mix(col, lin(0.66, 0.64, 0.6), is(P_CONC));
  col = mix(col, select(fract(seed.mul(0.37)).lessThan(0.5), lin(0.45, 0.38, 0.3), lin(0.55, 0.55, 0.52)), is(P_DECK));
  col = mix(col, lin(0.5, 0.24, 0.18).mul(float(1).add(mortar.mul(-0.15).mul(nearK))), is(P_CHIM));
  m.colorNode = baseTone(col);

  // emissive: reflections by day, lit rooms at night
  const night = U.night;
  const litW = mix(step(float(1).sub(OCC.x.mul(1.1)), fract(wr.mul(13.7))), OCC.x, far);
  const warm = mix(vec3(1.0, 0.7, 0.4), vec3(0.95, 0.82, 0.6), fract(wr.mul(5.1)));
  let em: N = sky.mul(fres.mul(0.55).add(0.1)).mul(winF).mul(float(1).sub(blind.mul(0.7))).mul(float(1).sub(night.mul(0.8)));
  em = em.add(warm.mul(litW).mul(winF).mul(night).mul(0.5));
  // porch light by the door
  em = em.add(vec3(1.0, 0.75, 0.45).mul(door).mul(box1(h, float(2.0), float(2.3), wh)).mul(night).mul(0.5));
  (m as unknown as { emissiveNode: N }).emissiveNode = em.mul(float(1).sub(U.analytics.mul(0.7)));
  return m;
}

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
  slots: Int32Array[];
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
  name: string;
  info!: THREE.InstancedBufferAttribute;
  col!: THREE.InstancedBufferAttribute;
  lo = Infinity;
  hi = -1;
  mark(s: number) { if (s < this.lo) this.lo = s; if (s > this.hi) this.hi = s; }
  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, cap: number, parent: THREE.Object3D, shadows: boolean, name: string) {
    this.geometry = geometry; this.material = material; this.parent = parent; this.shadows = shadows; this.name = name;
    this.cap = cap;
    this.mesh = this.makeMesh(cap);
    this.slotEntry = new Int32Array(cap);
  }
  private makeMesh(cap: number) {
    const g = this.geometry.clone();
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    g.setAttribute('hinfo', this.info);
    g.setAttribute('hcol', this.col);
    const m = new THREE.InstancedMesh(g, this.material, cap);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = this.shadows;
    m.receiveShadow = true;
    m.name = this.name;
    this.parent.add(m);
    return m;
  }
  ensure(n: number) {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    const old = this.mesh, oi = this.info.array as Float32Array, oc = this.col.array as Float32Array;
    const m = this.makeMesh(cap);
    (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    (this.info.array as Float32Array).set(oi);
    (this.col.array as Float32Array).set(oc);
    m.position.copy(old.position);
    m.visible = old.visible;
    m.count = this.count;
    this.parent.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.mesh = m;
    const se = new Int32Array(cap); se.set(this.slotEntry); this.slotEntry = se;
    this.cap = cap;
    this.lo = 0; this.hi = this.count - 1;
  }
  flush() {
    if (this.hi < this.lo) return;
    const lo = this.lo, n = Math.min(this.hi, this.cap - 1) - lo + 1;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(lo * 16, n * 16); im.needsUpdate = true;
    this.info.clearUpdateRanges(); this.info.addUpdateRange(lo * 4, n * 4); this.info.needsUpdate = true;
    this.col.clearUpdateRanges(); this.col.addUpdateRange(lo * 3, n * 3); this.col.needsUpdate = true;
    this.lo = Infinity; this.hi = -1;
  }
}

/** near-detail radius (m) and rebuild step */
const NEAR_R = 230, NEAR_STEP = 20;

export class HousePools {
  pools: Pool[] = [];
  poolsLo: Pool[] = [];
  /** porches / bays / steps / chimneys for houses near the camera (index = archetype; null = none) */
  detail: (Pool | null)[] = [];
  tiles = new Map<string, TileHouses>();
  group = new THREE.Group();
  private anchorE = 0;
  private anchorN = 0;
  private nearAt = { e: Infinity, n: Infinity };
  private nearDirty = true;
  dirty = false;

  constructor() {
    this.group.name = 'housePools';
    const mat = houseMaterial('houses');
    for (let t = 0; t < HOUSE_TYPES; t++) this.pools.push(new Pool(houseGeometry(t), mat, 2048, this.group, true, 'houses'));
    for (let t = 0; t < HOUSE_TYPES; t++) this.poolsLo.push(new Pool(houseLowGeometry(t), mat, 2048, this.group, false, 'housesLo'));
    for (let t = 0; t < HOUSE_TYPES; t++) {
      const g = houseDetailGeometry(t);
      this.detail.push(g ? new Pool(g, mat, 256, this.group, true, 'houseDetail') : null);
    }
  }

  get instanceCount() {
    return this.pools.reduce((s, p) => s + p.count, 0) + this.poolsLo.reduce((s, p) => s + p.count, 0);
  }

  levelOf(key: string): 'hi' | 'lo' | undefined {
    const t = this.tiles.get(key);
    return t ? (t.pools === this.pools ? 'hi' : 'lo') : undefined;
  }

  rebase(e: number, n: number) {
    this.anchorE = e; this.anchorN = n;
    for (const p of this.allPools()) p.mesh.position.set(e, 0, -n);
    for (const t of this.tiles.values()) this.writeTile(t);
    this.nearDirty = true;
    this.dirty = true;
  }

  private allPools(): Pool[] {
    return [...this.pools, ...this.poolsLo, ...(this.detail.filter(Boolean) as Pool[])];
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
    if (!lo) this.nearDirty = true;
    this.dirty = true;
  }

  remove(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    for (let k = 0; k < HOUSE_TYPES; k++) {
      const pool = t.pools[k];
      const mArr = pool.mesh.instanceMatrix.array as Float32Array;
      const iArr = pool.info.array as Float32Array, cArr = pool.col.array as Float32Array;
      const slots = t.slots[k];
      for (let j = 0; j < slots.length; j++) {
        const s = slots[j];
        const last = pool.count - 1;
        if (s !== last) {
          mArr.copyWithin(s * 16, last * 16, last * 16 + 16);
          iArr.copyWithin(s * 4, last * 4, last * 4 + 4);
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
    if (t.pools === this.pools) this.nearDirty = true;
    this.tiles.delete(key);
    this.dirty = true;
  }

  /** instance record for house i of a tile into slot s of pool p */
  private put(p: Pool, s: number, d: HouseBuf, i: number, ox: number, on: number) {
    _p.set(ox + d.xy[i * 2], d.base[i], -(on + d.xy[i * 2 + 1]));
    _q.setFromAxisAngle(_up, d.angle[i]);
    const sx = Math.max(d.len[i], 2), sy = Math.max(d.height[i], 2), sz = Math.max(d.wid[i], 2);
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    _m.toArray(p.mesh.instanceMatrix.array as Float32Array, s * 16);
    const v = d.variant[i];
    const t = d.type[i];
    // brick for the old-city archetypes (mostly) and some suburban fronts; siding / stucco otherwise
    const brick = t === 0 || t === 1 || t === 6 ? (v & 7) !== 7 : t === 2 ? (v & 3) !== 3 : t === 5 ? false : (v & 3) === 0;
    _c.setHex(brick ? BRICK[(v >> 2) % BRICK.length] : OTHER[(v >> 2) % OTHER.length]);
    const f = 0.93 + ((v >> 5) / 7) * 0.1;
    const ia = p.info.array as Float32Array, ca = p.col.array as Float32Array;
    ia[s * 4] = sx; ia[s * 4 + 1] = sy; ia[s * 4 + 2] = sz; ia[s * 4 + 3] = v + (brick ? 256 : 0);
    ca[s * 3] = _c.r * f; ca[s * 3 + 1] = _c.g * f; ca[s * 3 + 2] = _c.b * f;
    p.mark(s);
  }

  private writeTile(t: TileHouses) {
    const d = t.data;
    const ox = t.originE - this.anchorE, on = t.originN - this.anchorN;
    for (let k = 0; k < HOUSE_TYPES; k++) {
      const pool = t.pools[k];
      const items = t.items[k], slots = t.slots[k];
      for (let j = 0; j < items.length; j++) this.put(pool, slots[j], d, items[j], ox, on);
    }
  }

  /** refill the near-detail pools when the camera moved (call once per frame) */
  updateNear(E: number, N: number, H: number) {
    const moved = Math.hypot(E - this.nearAt.e, N - this.nearAt.n) > NEAR_STEP;
    if (!moved && !this.nearDirty) return;
    this.nearAt = { e: E, n: N };
    this.nearDirty = false;
    for (const p of this.detail) if (p) { p.count = 0; p.mesh.count = 0; }
    // high above the rooftops the details are sub-pixel
    const R = NEAR_R;
    if (H < 400) {
      for (const t of this.tiles.values()) {
        if (t.pools !== this.pools) continue;
        if (E < t.originE - R || E > t.originE + 1024 + R || N < t.originN - R || N > t.originN + 1024 + R) continue;
        const d = t.data, ox = t.originE - this.anchorE, on = t.originN - this.anchorN;
        for (let i = 0; i < d.count; i++) {
          const p = this.detail[Math.min(d.type[i], HOUSE_TYPES - 1)];
          if (!p) continue;
          const e = t.originE + d.xy[i * 2], n = t.originN + d.xy[i * 2 + 1];
          if (Math.abs(e - E) > R || Math.abs(n - N) > R || Math.hypot(e - E, n - N) > R) continue;
          p.ensure(p.count + 1);
          const s = p.count++;
          this.put(p, s, d, i, ox, on);
        }
      }
    }
    for (const p of this.detail) if (p) { p.mesh.count = p.count; if (p.count) { p.lo = 0; p.hi = p.count - 1; } }
    this.dirty = true;
  }

  /** push pending changes to the GPU (call once per frame) */
  flush() {
    if (!this.dirty) return;
    for (const p of this.allPools()) p.flush();
    this.dirty = false;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  dispose() {
    for (const p of this.allPools()) {
      p.mesh.geometry.dispose();
      p.mesh.dispose();
      p.geometry.dispose();
    }
  }
}
