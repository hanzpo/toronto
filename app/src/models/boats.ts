// Low-poly boats for the waterfront (layers/WaterLifeLayer.ts). Metres, +x =
// bow, y = 0 at the waterline (hull bottoms sit below it, hidden by the lake),
// +z = starboard. Built with MeshBuilder; vertex tags reuse the vehicle
// convention but boats read them through layers/water/pools.ts:
//   livery 1  tinted by the per-instance colour (hull stripe / funnel band)
//   lamp   1 white nav light, 2 red (port), 3 green (starboard), 4 deck flood
//   sign   1 cabin windows (warm glow at night when the boat is manned)
//   glass  1 glazing
//
// References (photos + published particulars; lengths are LOA):
//   Sam McBride (1939) / Thomas Rennie (1951): double-ended diesel ferries,
//     ~39.6 x 10.8 m, enclosed main deck, open upper deck, a pilot house at
//     each end, one buff funnel amidships.
//   William Inglis (1935): the same layout, 30.2 x 7.6 m.
//   Ongiara (1963) / Maple City: double-ended vehicle ferries, 23.8 x 11 m,
//     open car deck, side passenger cabin, raised wheelhouse.
//   Marilyn Bell I (2009): Billy Bishop airport ferry, ~45 x 12.8 m,
//     double-ended, cabins both sides, wheelhouse bridging the car deck.
//   Trillium (1910): sidewheel paddle steamer, 45.7 m, paddle boxes, tall
//     buff funnel.
//   Northern Spirit-style harbour cruise boat (Mariposa), ~37 m, 3 decks.
//   Kajama (Great Lakes Schooner Co.): 50 m three-masted schooner.
//   Seaway-max laker: 225.5 x 23.8 m, aft accommodation, self-unloader boom.
//   William Lyon Mackenzie (1964): Toronto fireboat, 24.4 m, red hull.
//   CCG search-and-rescue cutter: ~16 m, red hull, white superstructure.
//   Sloop / cabin cruiser / bowrider / water taxi: generic 6-12 m.
import * as THREE from 'three/webgpu';
import { MeshBuilder, paint, rgb, type RGB, type Station, type V2 } from './builder';

export type BoatKey =
  | 'sail' | 'sailMoored' | 'power' | 'runabout' | 'taxi'
  | 'ferryBig' | 'ferryInglis' | 'ongiara' | 'marilynBell' | 'trillium'
  | 'tour' | 'schooner' | 'laker' | 'fireboat' | 'ccg';

export interface BoatLight { p: [number, number, number]; c: 'w' | 'r' | 'g' | 'y' }
export interface BoatModel {
  key: BoatKey;
  geometry: THREE.BufferGeometry;
  /** metres, as built (instances may scale uniformly) */
  len: number;
  beam: number;
  /** navigation / deck lights (drawn as sprites at night) */
  lights: BoatLight[];
}

const C = {
  white: rgb(0xf2f1ec),
  offwhite: rgb(0xe4e1d8),
  cream: rgb(0xefe6cf),
  black: rgb(0x1c1d20),
  antifoul: rgb(0x5a2320),
  boot: rgb(0x202326),
  deck: rgb(0x9a8f7c),
  teak: rgb(0x9b7650),
  grey: rgb(0x8c9096),
  darkgrey: rgb(0x4a4e54),
  navy: rgb(0x1e3a6e),
  green: rgb(0x2f5a3c),
  buff: rgb(0xd9a93a),
  red: rgb(0xb3261e),
  ccgRed: rgb(0xc8102e),
  yellow: rgb(0xf2c200),
  rust: rgb(0x7c3b25),
  hatch: rgb(0x6b6f55),
  seat: rgb(0x2b5d8c),
  sail: rgb(0xf4f2ea),
  canvas: rgb(0x2a4a7a),
};
const TINT = paint(0xffffff, { liv: 1 });
const GLASS = paint(0x1d2a33, { glass: 1 });
const WIN = paint(0x2a3640, { glass: 1, sign: 1 });
const lampW = paint(0xffffff, { lamp: 1 });
const lampR = paint(0xff2a1a, { lamp: 2 });
const lampG = paint(0x22ff55, { lamp: 3 });

// --------------------------------------------------------------------------- hull
interface HullOpts {
  L: number; B: number; D: number; F: number;
  /** freeboard at the stem / transom */
  Fbow?: number; Fstern?: number;
  /** transom half-width fraction (0 = pointed / double-ended) */
  stern?: number;
  /** same fine entry at both ends (double-ended ferries) */
  double?: boolean;
  /** exponent of the bow taper (bigger = blunter) */
  bluff?: number;
  top: RGB; boot?: RGB; bottom?: RGB; deck: RGB;
  /** parallel mid-body fraction (lakers) */
  parallel?: number;
}

function hull(b: MeshBuilder, o: HullOpts) {
  const { L, B, D, F } = o;
  const Fb = o.Fbow ?? F * 1.15, Fs = o.Fstern ?? F;
  const stern = o.double ? 0 : o.stern ?? 0.75;
  const bluff = o.bluff ?? 0.9;
  const par = o.parallel ?? 0.3;
  const us = o.double
    ? [0, 0.03, 0.1, 0.22, 0.4, 0.6, 0.78, 0.9, 0.97, 1]
    : [0, 0.08, 0.25, 0.45, 0.62, 0.76, 0.88, 0.96, 1];
  const bowW = (t: number) => Math.max(0.03, Math.pow(Math.cos(t * Math.PI / 2), bluff));
  const pb = 0.5 + par / 2; // start of the bow taper
  const wf = (u: number) => {
    if (o.double) {
      const t = Math.abs(u - 0.5) * 2; // 0 mid → 1 ends
      return t < par ? 1 : bowW((t - par) / (1 - par));
    }
    if (u > pb) return bowW((u - pb) / (1 - pb));
    const a = Math.min(1, u / Math.max(0.05, 0.5 - par / 2));
    return stern + (1 - stern) * Math.sin(a * Math.PI / 2);
  };
  const fb = (u: number) => {
    if (o.double) { const t = Math.abs(u - 0.5) * 2; return F + (Fb - F) * t * t; }
    return F + (Fb - F) * Math.max(0, (u - 0.55) / 0.45) ** 2 + (Fs - F) * Math.max(0, (0.25 - u) / 0.25) ** 2;
  };
  const dr = (u: number) => {
    const t = o.double ? Math.abs(u - 0.5) * 2 : Math.max(0, (u - 0.5) * 2);
    return D * (1 - 0.6 * Math.max(0, (t - 0.8) / 0.2));
  };
  const st: Station[] = us.map((u) => {
    const w = (B / 2) * wf(u), d = dr(u), f = fb(u);
    return { x: -L / 2 + u * L, pts: [[0, -d], [w * 0.55, -d * 0.95], [w * 0.93, -d * 0.45], [w, -0.12], [w, Math.min(0.3, f * 0.3)], [w, f], [0, f]] };
  });
  const boot = o.boot ?? C.boot, bottom = o.bottom ?? C.antifoul;
  const col = (e: number): RGB => (e <= 2 ? bottom : e === 3 ? boot : e === 4 ? o.top : e === 5 ? o.deck : o.top);
  b.loft(st, (_s, e) => (e === 5 ? o.deck : col(e === 4 ? 4 : e === 3 ? 3 : e)), {
    back: o.double ? undefined : (e) => col(e === 5 ? 4 : e),
  });
  return { fb, wf, halfW: (u: number) => (B / 2) * wf(u), x: (u: number) => -L / 2 + u * L };
}

/** Railing: thin posts + top rail along a closed rectangle at deck height y. */
function railRect(b: MeshBuilder, x0: number, x1: number, hz: number, y: number, h = 1.0, col: RGB = C.white, sides = 'all') {
  const t = 0.05;
  if (sides.includes('all') || sides.includes('s')) {
    b.box(x0, x1, y + h - t, y + h, hz - t, hz, col);
    b.box(x0, x1, y + h - t, y + h, -hz, -hz + t, col);
    b.box(x0, x1, y + h * 0.45, y + h * 0.45 + t, hz - t, hz, col);
    b.box(x0, x1, y + h * 0.45, y + h * 0.45 + t, -hz, -hz + t, col);
  }
  if (sides.includes('all') || sides.includes('e')) {
    b.box(x0, x0 + t, y + h - t, y + h, -hz, hz, col);
    b.box(x1 - t, x1, y + h - t, y + h, -hz, hz, col);
  }
  const n = Math.max(2, Math.round((x1 - x0) / 2.2));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    b.box(x - t, x + t, y, y + h, hz - 2 * t, hz, col, 0, 'bottom top');
    b.box(x - t, x + t, y, y + h, -hz, -hz + 2 * t, col, 0, 'bottom top');
  }
}

/** Row of windows on both sides at plane |z| = hz. */
function windowRow(b: MeshBuilder, x0: number, x1: number, y0: number, y1: number, hz: number, pitch = 1.8, w = 0.72, color: RGB = WIN) {
  const n = Math.max(1, Math.floor((x1 - x0) / pitch));
  const p = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const xc = x0 + p * (i + 0.5);
    b.sideWindow(xc - (p * w) / 2, xc + (p * w) / 2, y0, y1, hz + 0.015, color, 0.1);
  }
}

/** Upright cylinder-ish funnel (octagonal prism) from y0 to y1, with a coloured top band. */
function funnel(b: MeshBuilder, x: number, y0: number, y1: number, r: number, body: RGB, top: RGB, rake = 0, band = 0.18, zc = 0) {
  const n = 8;
  const sec: V2[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + Math.PI / n; sec.push([zc + Math.cos(a) * r, Math.sin(a) * r * 1.3]); }
  // extrude "sections" vertically: draw quads manually
  const yb = y1 - (y1 - y0) * band;
  const ring = (y: number) => sec.map(([z, xo]) => new THREE.Vector3(x + xo - rake * (y - y0), y, z));
  const A = ring(y0), M = ring(yb), T = ring(y1);
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    const mid = new THREE.Vector3(sec[i][1] + sec[k][1], 0, sec[i][0] + sec[k][0] - 2 * zc);
    b.quad(A[i], A[k], M[k], M[i], body, 0, mid);
    b.quad(M[i], M[k], T[k], T[i], top, 0, mid);
  }
  b.poly(T, C.black, 0, new THREE.Vector3(0, 1, 0));
}

function mast(b: MeshBuilder, x: number, y0: number, y1: number, r = 0.08, col: RGB = C.white, z = 0) {
  b.box(x - r, x + r, y0, y1, z - r, z + r, col, 0, 'bottom');
}

function sideLights(b: MeshBuilder, x: number, y: number, hz: number, lights: BoatLight[]) {
  b.box(x - 0.12, x + 0.12, y, y + 0.18, hz, hz + 0.06, lampG);
  b.box(x - 0.12, x + 0.12, y, y + 0.18, -hz - 0.06, -hz, lampR);
  lights.push({ p: [x, y + 0.09, hz + 0.05], c: 'g' }, { p: [x, y + 0.09, -hz - 0.05], c: 'r' });
}

function done(key: BoatKey, b: MeshBuilder, len: number, beam: number, lights: BoatLight[]): BoatModel {
  return { key, geometry: b.build(), len, beam, lights };
}

// --------------------------------------------------------------------------- small craft
function sailboat(furled: boolean): BoatModel {
  const b = new MeshBuilder();
  const L = 10, B = 3.3, lights: BoatLight[] = [];
  const h = hull(b, { L, B, D: 0.55, F: 1.0, Fbow: 1.3, Fstern: 0.95, stern: 0.62, bluff: 0.8, top: C.white, boot: TINT, deck: C.offwhite });
  // cabin trunk + windows, cockpit well, coamings
  b.taperBox(-1.2, 2.2, 0.95, 1.55, 1.05, 0.35, 0.2, C.offwhite);
  b.sideWindow(-0.6, 1.6, 1.18, 1.4, 0.97, GLASS, 0.08);
  b.box(-4.3, -1.2, 0.6, 0.98, -1.05, 1.05, C.teak, 0, 'bottom');
  // mast, boom, standing rigging hint (forestay as thin box)
  const mx = 1.0, mh = 13.2;
  mast(b, mx, 1.5, mh, 0.08, C.grey);
  b.box(-3.4, mx, 2.1, 2.22, -0.05, 0.05, C.grey);
  const stay = (a: THREE.Vector3, c: THREE.Vector3) => {
    const d = new THREE.Vector3().subVectors(c, a), n = new THREE.Vector3(0, 0, 0.02);
    b.quad(a.clone().sub(n), c.clone().sub(n), c.clone().add(n), a.clone().add(n), C.darkgrey, 0, new THREE.Vector3(-d.y, d.x, 0));
  };
  stay(new THREE.Vector3(4.85, 1.3, 0), new THREE.Vector3(mx, mh - 0.4, 0));
  stay(new THREE.Vector3(-4.9, 1.0, 0), new THREE.Vector3(mx, mh - 0.2, 0));
  if (furled) {
    b.box(-3.3, mx - 0.1, 2.22, 2.55, -0.18, 0.18, C.canvas); // sail cover
    b.box(3.2, 4.8, 1.3, 1.6, -0.12, 0.12, C.canvas);
  } else {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    // main (slightly cambered: two panels) + genoa
    b.poly([V(mx - 0.1, 2.25, 0), V(mx - 0.1, mh - 0.3, 0), V(-1.2, 7.6, 0.35)], C.sail, 0, V(0, 0, 1));
    b.poly([V(mx - 0.1, 2.25, 0), V(-1.2, 7.6, 0.35), V(-3.3, 2.25, 0.5)], C.sail, 0, V(0, 0, 1));
    b.poly([V(4.75, 1.45, 0), V(mx + 0.15, mh - 0.8, 0), V(0.1, 1.9, 0.45)], C.sail, 0, V(0, 0, 1));
  }
  sideLights(b, 4.3, 1.25, h.halfW(0.9) + 0.02, lights);
  b.box(-5.02, -4.95, 0.85, 1.0, -0.08, 0.08, lampW);
  b.box(mx - 0.1, mx + 0.1, mh, mh + 0.15, -0.1, 0.1, lampW);
  lights.push({ p: [-5, 0.95, 0], c: 'w' }, { p: [mx, mh + 0.1, 0], c: 'w' });
  return done(furled ? 'sailMoored' : 'sail', b, L, B, lights);
}

function cruiser(): BoatModel {
  const b = new MeshBuilder();
  const L = 10, B = 3.4, lights: BoatLight[] = [];
  hull(b, { L, B, D: 0.7, F: 1.25, Fbow: 1.65, Fstern: 1.15, stern: 0.85, bluff: 0.7, top: C.white, boot: TINT, deck: C.offwhite });
  // cabin with raked windshield, hardtop
  b.taperBox(-2.2, 2.6, 1.2, 2.25, 1.45, 0.6, 0.25, C.white);
  b.sideWindow(-1.6, 1.8, 1.55, 2.0, 1.33, GLASS, 0.15);
  b.taperBox(-3.6, 1.2, 2.25, 2.4, 1.4, 0.1, 0.05, C.offwhite);
  b.box(-3.5, -3.4, 1.25, 2.25, 1.2, 1.3, C.grey, 0, 'bottom top');
  b.box(-3.5, -3.4, 1.25, 2.25, -1.3, -1.2, C.grey, 0, 'bottom top');
  b.box(-4.9, -2.2, 1.0, 1.25, -1.45, 1.45, C.teak, 0, 'bottom');
  mast(b, -0.5, 2.4, 3.3, 0.05, C.grey);
  b.box(-0.6, -0.4, 3.3, 3.45, -0.1, 0.1, lampW);
  sideLights(b, 2.2, 1.7, 1.4, lights);
  lights.push({ p: [-0.5, 3.4, 0], c: 'w' });
  return done('power', b, L, B, lights);
}

function runabout(): BoatModel {
  const b = new MeshBuilder();
  const L = 6.5, B = 2.4, lights: BoatLight[] = [];
  hull(b, { L, B, D: 0.4, F: 0.8, Fbow: 1.0, Fstern: 0.75, stern: 0.85, bluff: 0.65, top: TINT, boot: C.white, deck: C.offwhite });
  b.box(-2.9, 1.8, 0.45, 0.8, -1.0, 1.0, C.cream, 0, 'bottom'); // seating well
  b.taperBox(0.2, 0.8, 0.8, 1.25, 1.05, 0.25, 0.05, GLASS);
  b.box(-2.6, -1.6, 0.8, 1.2, -0.9, 0.9, C.seat);
  b.box(-0.6, 0.1, 0.8, 1.2, 0.2, 0.9, C.seat);
  b.box(-0.6, 0.1, 0.8, 1.2, -0.9, -0.2, C.seat);
  b.box(-3.3, -3.1, 0.2, 1.1, -0.3, 0.3, C.darkgrey); // outboard
  sideLights(b, 2.8, 0.95, 0.4, lights);
  mast(b, -3.0, 1.1, 2.0, 0.03, C.grey);
  lights.push({ p: [-3.0, 2.0, 0], c: 'w' });
  return done('runabout', b, L, B, lights);
}

function waterTaxi(): BoatModel {
  // Toronto Harbour water taxis: yellow launches with a white canopy.
  const b = new MeshBuilder();
  const L = 9, B = 2.8, lights: BoatLight[] = [];
  hull(b, { L, B, D: 0.5, F: 0.95, Fbow: 1.2, Fstern: 0.9, stern: 0.8, bluff: 0.7, top: C.yellow, boot: C.black, deck: C.teak });
  b.box(-3.6, 3.0, 0.95, 1.15, -1.3, 1.3, C.yellow, 0, 'bottom'); // gunwale cap
  for (const x of [-3.2, -0.8, 1.6]) for (const s of [1, -1]) b.box(x - 0.04, x + 0.04, 1.1, 2.4, s * 1.2 - 0.04, s * 1.2 + 0.04, C.white, 0, 'bottom top');
  b.taperBox(-3.5, 2.0, 2.4, 2.55, 1.3, 0.1, 0.05, C.white);
  for (const x of [-2.6, -1.4, -0.2, 1.0]) b.box(x - 0.3, x + 0.3, 0.95, 1.4, -1.1, 1.1, C.seat);
  b.taperBox(2.1, 2.6, 1.15, 1.7, 1.1, 0.2, 0.1, GLASS);
  sideLights(b, 2.6, 1.2, 1.25, lights);
  mast(b, -3.4, 2.55, 3.3, 0.04, C.white);
  lights.push({ p: [-3.4, 3.35, 0], c: 'w' });
  return done('taxi', b, L, B, lights);
}

// --------------------------------------------------------------------------- Island ferries
interface IslandFerryOpts { L: number; B: number; hullTop: RGB; trim: RGB; funnel: RGB }
/** Sam McBride / Thomas Rennie / William Inglis: double-ended, 2 decks, 2 pilot houses, 1 funnel. */
function islandFerry(key: BoatKey, o: IslandFerryOpts): BoatModel {
  const b = new MeshBuilder();
  const { L, B } = o, lights: BoatLight[] = [];
  const F = 1.9;
  hull(b, { L, B, D: 2.2, F, Fbow: 2.2, double: true, parallel: 0.45, bluff: 0.55, top: o.hullTop, boot: C.black, deck: C.deck });
  const cx = L / 2 - L * 0.13, hz = B / 2 - 0.35, y1 = F + 2.5;
  // enclosed main deck (windows), sheer rub rail in the trim colour
  b.box(-cx, cx, F, y1, -hz, hz, C.white, 0, 'bottom');
  b.band([[B / 2, 0], [B / 2, F]], -L * 0.22, L * 0.22, F - 0.35, F - 0.1, o.trim, 0, 0.03);
  windowRow(b, -cx + 0.8, cx - 0.8, F + 0.9, F + 2.0, hz, 1.9);
  b.endDecal(cx + 0.01, 1, F + 0.9, F + 2.0, hz - 1.0, WIN);
  b.endDecal(-cx - 0.01, -1, F + 0.9, F + 2.0, hz - 1.0, WIN);
  // upper (promenade) deck: deck plate, railings, canopy over the centre
  const ux = L / 2 - L * 0.06;
  b.box(-ux, ux, y1, y1 + 0.2, -B / 2 + 0.1, B / 2 - 0.1, C.white);
  railRect(b, -ux, ux, B / 2 - 0.12, y1 + 0.2, 1.05, C.white);
  for (const x of [-L * 0.2, 0, L * 0.2]) for (const s of [1, -1]) b.box(x - 0.08, x + 0.08, y1 + 0.2, y1 + 2.6, s * (hz - 0.5) - 0.08, s * (hz - 0.5) + 0.08, C.white, 0, 'bottom top');
  b.box(-L * 0.24, L * 0.24, y1 + 2.6, y1 + 2.75, -hz + 0.2, hz - 0.2, C.offwhite);
  // benches
  for (let x = -L * 0.3; x <= L * 0.3; x += 2.2) b.box(x - 0.25, x + 0.25, y1 + 0.2, y1 + 0.65, -hz + 1.2, hz - 1.2, C.teak);
  // pilot houses at both ends
  for (const s of [1, -1]) {
    const px = s * (L / 2 - L * 0.16);
    b.box(px - 1.4, px + 1.4, y1 + 0.2, y1 + 2.4, -1.9, 1.9, C.white);
    b.box(px - 1.55, px + 1.55, y1 + 2.4, y1 + 2.55, -2.1, 2.1, o.trim);
    b.sideWindow(px - 1.2, px + 1.2, y1 + 1.3, y1 + 2.15, 1.915, GLASS, 0.06);
    b.endDecal(px + s * 1.405, s as 1 | -1, y1 + 1.3, y1 + 2.15, 1.7, GLASS);
    sideLights(b, px, y1 + 1.6, 1.95, lights);
  }
  funnel(b, 0, y1 + 2.75, y1 + 5.4, 0.8, o.funnel, C.black, 0, 0.2);
  mast(b, L * 0.1, y1 + 2.75, y1 + 6.5, 0.07, C.white);
  b.box(L * 0.1 - 0.12, L * 0.1 + 0.12, y1 + 6.5, y1 + 6.7, -0.12, 0.12, lampW);
  lights.push({ p: [L * 0.1, y1 + 6.6, 0], c: 'w' });
  // deck lights along the canopy (night)
  for (const x of [-L * 0.2, 0, L * 0.2]) lights.push({ p: [x, y1 + 2.55, 0], c: 'y' });
  return done(key, b, L, B, lights);
}

/** Ongiara / Maple City: double-ended vehicle ferry, open car deck, side cabin + raised wheelhouse. */
function carFerry(key: BoatKey, L: number, B: number, hullTop: RGB, bothSides: boolean): BoatModel {
  const b = new MeshBuilder();
  const lights: BoatLight[] = [];
  const F = 1.5;
  hull(b, { L, B, D: 1.8, F, Fbow: 1.6, double: true, parallel: 0.6, bluff: 0.35, top: hullTop, boot: C.black, deck: C.darkgrey });
  const hz = B / 2;
  // bulwarks along the car deck
  b.box(-L / 2 + 1.5, L / 2 - 1.5, F, F + 1.0, hz - 0.2, hz, hullTop);
  b.box(-L / 2 + 1.5, L / 2 - 1.5, F, F + 1.0, -hz, -hz + 0.2, hullTop);
  // end ramps (raised)
  for (const s of [1, -1]) b.box(s > 0 ? L / 2 - 1.6 : -L / 2 + 0.2, s > 0 ? L / 2 - 0.2 : -L / 2 + 1.6, F, F + 0.25, -hz + 1.5, hz - 1.5, C.grey);
  // passenger cabin(s) along the side(s)
  const cabW = Math.min(3.2, B * 0.28);
  const cab = (s: number) => {
    const z0 = s * (hz - 0.2), z1 = s * (hz - 0.2 - cabW);
    b.box(-L * 0.36, L * 0.36, F, F + 2.4, Math.min(z0, z1), Math.max(z0, z1), C.white);
    windowRow(b, -L * 0.33, L * 0.33, F + 1.0, F + 1.9, hz - 0.2, 1.6);
    railRect(b, -L * 0.36, L * 0.36, hz - 0.2, F + 2.4, 0.9, C.white, 's');
  };
  cab(-1);
  if (bothSides) cab(1);
  // raised wheelhouse (bridging the deck on the Marilyn Bell, over the side cabin on Ongiara)
  const wz0 = bothSides ? -hz + 0.2 : -hz + 0.2, wz1 = bothSides ? hz - 0.2 : -hz + 0.2 + cabW + 0.6;
  const wy = bothSides ? F + 5.0 : F + 2.4;
  if (bothSides) {
    b.box(-2.6, 2.6, wy - 0.4, wy, wz0, wz1, C.white); // bridge deck across the car deck (clearance ~3.5 m)
  }
  b.box(-2.2, 2.2, wy, wy + 2.3, wz0 + (bothSides ? 3.2 : 0.1), wz1 - (bothSides ? 3.2 : 0.1), C.white);
  b.box(-2.35, 2.35, wy + 2.3, wy + 2.45, wz0 + (bothSides ? 3.0 : 0), wz1 - (bothSides ? 3.0 : 0), hullTop);
  for (const s of [1, -1]) b.endDecal(s * 2.205, s as 1 | -1, wy + 1.2, wy + 2.05, (wz1 - wz0) / 2 - (bothSides ? 3.4 : 0.35), GLASS, 0, (wz0 + wz1) / 2);
  const mz = (wz0 + wz1) / 2;
  mast(b, 0, wy + 2.45, wy + 5.2, 0.07, C.white, mz);
  b.box(-0.12, 0.12, wy + 5.2, wy + 5.4, mz - 0.12, mz + 0.12, lampW);
  lights.push({ p: [0, wy + 5.3, mz], c: 'w' });
  lights.push({ p: [2.3, wy + 1.8, wz1], c: 'g' }, { p: [2.3, wy + 1.8, wz0], c: 'r' });
  b.box(2.2, 2.3, wy + 1.7, wy + 1.9, wz1, wz1 + 0.06, lampG);
  b.box(2.2, 2.3, wy + 1.7, wy + 1.9, wz0 - 0.06, wz0, lampR);
  // a few cars / a truck on deck (static cargo)
  const cars: [number, number, number, number][] = [[-L * 0.28, 0.2, 0xb0b4ba, 4.6], [-L * 0.08, 0.6, 0x1f3d7a, 4.8], [L * 0.14, 0.1, 0x8a1c1c, 4.4], [L * 0.3, 0.8, 0xe8e8e8, 6.5]];
  const laneZ = bothSides ? 0 : 1.6;
  cars.forEach(([x, dz, hex, len], i) => {
    const c = rgb(hex), z = laneZ + (i % 2 ? -1.4 : 1.2) * (bothSides ? 1 : 0.7) + dz * 0.2;
    const big = len > 6;
    b.box(x - len / 2, x + len / 2, F + 0.3, F + (big ? 2.9 : 1.1), z - 0.9, z + 0.9, c);
    if (!big) b.taperBox(x - len * 0.25, x + len * 0.2, F + 1.1, F + 1.55, 0.85, 0.25, 0.08, GLASS, z);
  });
  lights.push({ p: [-L * 0.2, F + 2.6, 0], c: 'y' }, { p: [L * 0.2, F + 2.6, 0], c: 'y' });
  return done(key, b, L, B, lights);
}

function trillium(): BoatModel {
  const b = new MeshBuilder();
  const L = 45.7, B = 9.2, lights: BoatLight[] = [];
  const F = 1.8;
  hull(b, { L, B, D: 2.0, F, Fbow: 2.4, Fstern: 2.0, stern: 0.45, bluff: 0.8, top: C.white, boot: C.black, deck: C.deck });
  // guards (main deck overhang out to the paddle boxes)
  const G = 7.2;
  b.box(-L * 0.36, L * 0.33, F - 0.2, F + 0.1, -G, G, C.white);
  // paddle boxes
  for (const s of [1, -1]) {
    const prof: V2[] = [];
    for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; prof.push([Math.cos(a) * 3.4, F + Math.sin(a) * 3.2]); }
    b.extrudeZ(prof, 0.8, () => C.white, C.white, 0, undefined, s * 7.6);
    b.sidePoly(prof.map(([x, y]) => [x * 0.7, F + (y - F) * 0.7] as V2), 8.41 * 1, C.buff, s as 1 | -1);
  }
  const hz = 4.5;
  b.box(-L * 0.35, L * 0.3, F + 0.1, F + 2.7, -hz, hz, C.white, 0, 'bottom');
  // arched window rows (rectangles with a rounded feel)
  windowRow(b, -L * 0.33, L * 0.28, F + 0.9, F + 2.2, hz, 1.6, 0.6);
  b.box(-L * 0.37, L * 0.32, F + 2.7, F + 2.9, -G + 0.4, G - 0.4, C.white);
  b.box(-L * 0.28, L * 0.18, F + 2.9, F + 5.1, -hz + 0.6, hz - 0.6, C.white);
  windowRow(b, -L * 0.26, L * 0.16, F + 3.5, F + 4.6, hz - 0.6, 1.6, 0.6);
  railRect(b, -L * 0.37, L * 0.32, G - 0.45, F + 2.9, 1.0, C.white, 's');
  b.box(-L * 0.3, L * 0.2, F + 5.1, F + 5.25, -hz + 0.4, hz - 0.4, C.offwhite);
  // pilot house forward, tall raked funnel, masts
  b.box(L * 0.2, L * 0.26, F + 2.9, F + 5.4, -2, 2, C.white);
  b.endDecal(L * 0.26 + 0.01, 1, F + 4.2, F + 5.1, 1.8, GLASS);
  funnel(b, -L * 0.02, F + 5.25, F + 11.5, 0.95, C.buff, C.black, 0.08, 0.15);
  mast(b, L * 0.36, F + 0.1, F + 12, 0.1, C.teak);
  mast(b, -L * 0.4, F + 0.1, F + 8, 0.09, C.teak);
  sideLights(b, L * 0.22, F + 4.5, 2.05, lights);
  b.box(L * 0.36 - 0.12, L * 0.36 + 0.12, F + 12, F + 12.2, -0.12, 0.12, lampW);
  lights.push({ p: [L * 0.36, F + 12.1, 0], c: 'w' });
  for (const x of [-L * 0.25, -L * 0.05, L * 0.15]) lights.push({ p: [x, F + 5.3, 0], c: 'y' });
  return done('trillium', b, L, B, lights);
}

function tourBoat(): BoatModel {
  const b = new MeshBuilder();
  const L = 37, B = 9, lights: BoatLight[] = [];
  const F = 1.6;
  hull(b, { L, B, D: 1.8, F, Fbow: 2.3, Fstern: 1.6, stern: 0.85, bluff: 0.75, top: C.white, boot: TINT, deck: C.deck });
  b.band([[B / 2, 0], [B / 2, F]], -L * 0.3, L * 0.12, F - 0.5, F - 0.2, TINT, 0, 0.03);
  const hz = B / 2 - 0.2;
  b.box(-L * 0.46, L * 0.34, F, F + 2.6, -hz, hz, C.white);
  windowRow(b, -L * 0.44, L * 0.32, F + 0.8, F + 2.3, hz, 2.0, 0.85, WIN);
  b.box(-L * 0.4, L * 0.24, F + 2.6, F + 5.0, -hz + 0.3, hz - 0.3, C.white);
  windowRow(b, -L * 0.38, L * 0.22, F + 3.2, F + 4.7, hz - 0.3, 2.0, 0.85, WIN);
  b.band([[hz, 0], [hz, 10]], -L * 0.46, L * 0.34, F + 2.45, F + 2.6, TINT, 0, 0.02);
  // open top deck with rail + wheelhouse
  b.box(-L * 0.42, L * 0.26, F + 5.0, F + 5.15, -hz + 0.2, hz - 0.2, C.offwhite);
  railRect(b, -L * 0.42, L * 0.26, hz - 0.25, F + 5.15, 1.0);
  b.box(L * 0.12, L * 0.25, F + 5.15, F + 7.2, -2.2, 2.2, C.white);
  b.endDecal(L * 0.25 + 0.01, 1, F + 6.2, F + 7.0, 2.0, GLASS);
  b.box(L * 0.11, L * 0.26, F + 7.2, F + 7.35, -2.4, 2.4, TINT);
  for (let x = -L * 0.38; x < L * 0.08; x += 2.0) b.box(x - 0.25, x + 0.25, F + 5.15, F + 5.6, -hz + 1.0, hz - 1.0, C.seat);
  sideLights(b, L * 0.2, F + 6.5, 2.25, lights);
  mast(b, L * 0.18, F + 7.35, F + 10, 0.07);
  lights.push({ p: [L * 0.18, F + 10, 0], c: 'w' });
  for (const x of [-L * 0.3, -L * 0.1, L * 0.05]) lights.push({ p: [x, F + 5.4, 0], c: 'y' });
  return done('tour', b, L, B, lights);
}

function schooner(): BoatModel {
  const b = new MeshBuilder();
  const L = 50, B = 8.2, lights: BoatLight[] = [];
  const F = 2.0;
  hull(b, { L: L - 8, B, D: 2.8, F, Fbow: 3.0, Fstern: 2.4, stern: 0.55, bluff: 1.1, top: C.black, boot: C.white, deck: C.teak });
  b.band([[B / 2, 0], [B / 2, F]], -6, 6, F - 0.45, F - 0.25, C.white, 0, 0.03);
  // bowsprit
  b.box(L / 2 - 4.5, L / 2, F + 0.9, F + 1.1, -0.12, 0.12, C.teak);
  b.box(-6, 2, F, F + 1.3, -2, 2, C.teak); // deckhouse
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const masts = [9, 0, -9];
  const hts = [28, 30, 28];
  masts.forEach((x, i) => {
    mast(b, x, F, F + hts[i], 0.18, C.teak);
    // gaff sail (quad) aft of each mast + topsail
    b.poly([V(x - 0.2, F + 2.5, 0), V(x - 0.2, F + hts[i] * 0.62, 0), V(x - 6.5, F + hts[i] * 0.72, 0.4), V(x - 7.2, F + 2.5, 0.5)], C.cream, 0, V(0, 0, 1));
    b.poly([V(x - 0.2, F + hts[i] * 0.64, 0), V(x - 0.2, F + hts[i] - 0.5, 0), V(x - 6.3, F + hts[i] * 0.74, 0.4)], C.cream, 0, V(0, 0, 1));
  });
  // headsails
  b.poly([V(L / 2 - 0.5, F + 1.2, 0), V(9.2, F + 24, 0), V(9.4, F + 2.0, 0.4)], C.cream, 0, V(0, 0, 1));
  sideLights(b, 11, F + 1.3, B / 2 - 0.3, lights);
  b.box(9 - 0.15, 9 + 0.15, F + 28, F + 28.2, -0.15, 0.15, lampW);
  lights.push({ p: [9, F + 28.1, 0], c: 'w' }, { p: [-L / 2 + 5, F + 1.5, 0], c: 'w' });
  return done('schooner', b, L, B, lights);
}

function laker(): BoatModel {
  const b = new MeshBuilder();
  const L = 225.5, B = 23.8, lights: BoatLight[] = [];
  const F = 5.5;
  hull(b, { L, B, D: 7.5, F, Fbow: 8.5, Fstern: 6.5, stern: 0.9, bluff: 0.45, parallel: 0.8, top: TINT, boot: C.antifoul, deck: C.rust });
  // white name / sheer stripe
  b.band([[B / 2, 0], [B / 2, F]], -L / 2 + 24, L / 2 - 24, F - 0.6, F - 0.3, C.white, 0, 0.05);
  // hatches
  for (let x = -L / 2 + 34; x < L / 2 - 16; x += 10.5) b.box(x, x + 7.5, F, F + 1.1, -B / 2 + 3.2, B / 2 - 3.2, C.hatch);
  // self-unloader boom lying fore-and-aft on its saddle
  b.box(-L / 2 + 28, L / 2 - 50, F + 1.6, F + 3.2, 3.6, 5.4, C.grey);
  b.box(-L / 2 + 26, -L / 2 + 30, F, F + 7, 2.8, 6.2, C.grey);
  // forecastle
  b.box(L / 2 - 14, L / 2 - 4, F + 0.1, F + 3.0, -B / 2 + 2.5, B / 2 - 2.5, TINT);
  // aft accommodation block (5 decks) + bridge wings + funnel
  const ax0 = -L / 2 + 3, ax1 = -L / 2 + 22, hz = B / 2 - 0.6;
  b.box(ax0, ax1, F, F + 12.5, -hz, hz, C.white);
  for (let k = 0; k < 4; k++) windowRow(b, ax0 + 1, ax1 - 1, F + 1.2 + k * 2.9, F + 2.3 + k * 2.9, hz, 2.4, 0.55, WIN);
  b.box(ax1 - 4, ax1 + 0.5, F + 12.5, F + 15.5, -B / 2 - 0.5, B / 2 + 0.5, C.white);
  b.endDecal(ax1 + 0.51, 1, F + 13.6, F + 15.1, B / 2, GLASS);
  b.box(ax1 - 4.2, ax1 + 0.7, F + 15.5, F + 15.8, -B / 2 - 0.6, B / 2 + 0.6, C.darkgrey);
  funnel(b, ax0 + 6, F + 12.5, F + 21, 2.0, TINT, C.black, 0.12, 0.2);
  mast(b, ax1 - 2, F + 15.8, F + 22, 0.2, C.white);
  mast(b, L / 2 - 8, F + 3, F + 16, 0.2, C.white);
  sideLights(b, ax1 - 1, F + 14.5, B / 2 + 0.5, lights);
  lights.push({ p: [L / 2 - 8, F + 16.2, 0], c: 'w' }, { p: [ax1 - 2, F + 22.2, 0], c: 'w' }, { p: [-L / 2, F + 1, 0], c: 'w' });
  lights.push({ p: [ax0 + 10, F + 12.6, 0], c: 'y' }, { p: [0, F + 3.5, 4.5], c: 'y' }, { p: [60, F + 3.5, 4.5], c: 'y' }, { p: [-60, F + 3.5, 4.5], c: 'y' });
  return done('laker', b, L, B, lights);
}

function fireboat(): BoatModel {
  // William Lyon Mackenzie: red hull, white-and-red superstructure, monitors on the tower.
  const b = new MeshBuilder();
  const L = 24.4, B = 6.1, lights: BoatLight[] = [];
  const F = 1.6;
  hull(b, { L, B, D: 1.8, F, Fbow: 2.3, Fstern: 1.5, stern: 0.8, bluff: 0.8, top: C.red, boot: C.black, deck: C.darkgrey });
  b.box(-6, 5.5, F, F + 2.4, -2.5, 2.5, C.white);
  windowRow(b, -5.5, 5, F + 1.1, F + 1.9, 2.5, 1.5);
  b.box(1.5, 5.2, F + 2.4, F + 4.4, -2.1, 2.1, C.white);
  b.endDecal(5.21, 1, F + 3.3, F + 4.2, 1.9, GLASS);
  b.box(1.4, 5.3, F + 4.4, F + 4.6, -2.2, 2.2, C.red);
  // monitor tower
  b.box(-3.6, -2.6, F + 2.4, F + 7.4, -0.5, 0.5, C.red);
  b.box(-4.0, -2.2, F + 7.4, F + 7.8, -0.9, 0.9, C.red);
  for (const [x, y, z] of [[-3.1, F + 8.1, 0], [3.3, F + 4.9, 0], [8.5, F + 0.8, 0], [-8.8, F + 0.6, 1.8], [-8.8, F + 0.6, -1.8]]) {
    b.box(x - 0.3, x + 0.6, y - 0.25, y + 0.25, z - 0.2, z + 0.2, C.buff);
  }
  funnel(b, -1, F + 2.4, F + 4.5, 0.45, C.red, C.black);
  sideLights(b, 4.5, F + 3.8, 2.15, lights);
  mast(b, 3, F + 4.6, F + 8, 0.06);
  lights.push({ p: [3, F + 8.1, 0], c: 'w' });
  return done('fireboat', b, L, B, lights);
}

function ccgCutter(): BoatModel {
  const b = new MeshBuilder();
  const L = 16, B = 5, lights: BoatLight[] = [];
  const F = 1.4;
  hull(b, { L, B, D: 1.2, F, Fbow: 2.0, Fstern: 1.3, stern: 0.9, bluff: 0.7, top: C.ccgRed, boot: C.black, deck: C.grey });
  b.band([[B / 2, 0], [B / 2, F]], -0.5, 1.5, 0.3, F - 0.1, C.white, 0, 0.03); // CCG white stripe
  b.box(-2.5, 3.5, F, F + 2.4, -2.0, 2.0, C.white);
  b.sideWindow(-1.8, 3.0, F + 1.2, F + 2.0, 2.0, GLASS, 0.08);
  b.endDecal(3.51, 1, F + 1.2, F + 2.1, 1.8, GLASS);
  b.box(-2.7, 3.7, F + 2.4, F + 2.55, -2.2, 2.2, C.ccgRed);
  mast(b, 0, F + 2.55, F + 5.5, 0.07);
  b.box(-0.3, 0.3, F + 4.2, F + 4.5, -0.5, 0.5, C.darkgrey);
  sideLights(b, 3.2, F + 1.9, 2.05, lights);
  lights.push({ p: [0, F + 5.6, 0], c: 'w' });
  return done('ccg', b, L, B, lights);
}

// --------------------------------------------------------------------------- registry
const BUILDERS: Record<BoatKey, () => BoatModel> = {
  sail: () => sailboat(false),
  sailMoored: () => sailboat(true),
  power: cruiser,
  runabout,
  taxi: waterTaxi,
  ferryBig: () => islandFerry('ferryBig', { L: 39.6, B: 10.8, hullTop: C.white, trim: C.green, funnel: C.buff }),
  ferryInglis: () => islandFerry('ferryInglis', { L: 30.2, B: 7.6, hullTop: C.white, trim: C.green, funnel: C.buff }),
  ongiara: () => carFerry('ongiara', 23.8, 11.0, C.green, false),
  marilynBell: () => carFerry('marilynBell', 45.0, 12.8, C.navy, true),
  trillium,
  tour: tourBoat,
  schooner,
  laker,
  fireboat,
  ccg: ccgCutter,
};

const cache = new Map<BoatKey, BoatModel>();
export function boatModel(key: BoatKey): BoatModel {
  let m = cache.get(key);
  if (!m) { m = BUILDERS[key](); cache.set(key, m); }
  return m;
}

export const BOAT_KEYS = Object.keys(BUILDERS) as BoatKey[];
