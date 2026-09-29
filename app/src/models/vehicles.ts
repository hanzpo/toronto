// Low-poly, to-scale transit vehicle models for instanced rendering.
//
// Every factory returns ONE merged, indexed BufferGeometry for a whole consist,
// unit-normalised (x ∈ [-.5, .5] = length, +x = front, y ∈ [0, 1] from the rail
// / road surface, z ∈ [-.5, .5] = width) so MarkerOverlay can scale it by
// `size` = [length, height, width] in metres. Attributes:
//   position, normal (metre-space, flat shaded), color (linear RGB),
//   livery (0/1: region that should take the per-instance tint).
//
// Colours are baked liveries; `livery` marks a small region (roof strip, bus
// body band, LRT stripe) meant to carry the route/agency colour. Renderers that
// ignore `color`/`livery` still get a correct silhouette.
import type * as THREE from 'three/webgpu';
import { Vector3 as V3 } from 'three/webgpu';
import { MeshBuilder, mirrorSection, rgb, type RGB, type V2 } from './builder';

// ------------------------------------------------------------------ palette
const C = {
  steel: rgb(0xb8bec5),
  steelDark: rgb(0x8d949c),
  glass: rgb(0x1b2229),
  black: rgb(0x16181b),
  under: rgb(0x2a2c2f),
  bogie: rgb(0x303236),
  roof: rgb(0x9aa0a6),
  white: rgb(0xf1f2f0),
  offWhite: rgb(0xe2e4e2),
  ttcRed: rgb(0xda251d),
  ttcRedDark: rgb(0xa51a14),
  goGreen: rgb(0x3e8a36),
  goGreenDark: rgb(0x2d6a27),
  upOrange: rgb(0xf58220),
  charcoal: rgb(0x33373c),
  viaYellow: rgb(0xf5c400),
  viaBlue: rgb(0x1d3f7a),
  viaGrey: rgb(0x9ea4aa),
  amber: rgb(0xffb52e),
  light: rgb(0xfff6d8),
  tail: rgb(0xd0201a),
  tint: rgb(0xffffff), // livery base (multiplied by instance colour)
  tintShade: rgb(0xbfbfbf),
};

// ------------------------------------------------------------------ car kit
interface Band { y0: number; y1: number; color: RGB; liv?: number; eps?: number; inset?: number }
interface Nose {
  /** side profile (x outward from the body end, y), starting at the bottom on x=0, ending at the top on x=0 */
  profile: V2[];
  /** colour per profile edge (index i = edge p[i] → p[i+1]) */
  edges: RGB[];
  /** livery weight per edge (default 0) */
  liv?: number[];
  side: RGB;
  /** half width */
  hw: number;
  /** cab side windows [x0, x1, y0, y1] measured outward from the body end (negative = on the body) */
  sideWin?: [number, number, number, number];
  /** livery bands continued along the nose sides: [y0, y1, colour, livery?] */
  sideBands?: [number, number, RGB, number?][];
  /** head lamps: y, half-spacing, x on the nose face */
  lamps?: { x: number; y: number; z: number };
}
interface Car {
  /** body extents (m) excluding noses */
  x0: number; x1: number;
  half: V2[];
  body: RGB;
  bands?: Band[];
  /** individual windows: centres relative to car middle */
  windows?: { xs: number[]; w: number; y0: number; y1: number; color?: RGB; eps?: number };
  doors?: { xs: number[]; w: number; y0: number; y1: number; color: RGB; win?: [number, number] };
  bogies?: { xs: number[]; len: number; y0: number; y1: number; hw: number };
  front?: Nose;
  back?: Nose;
  roofStrip?: { hz: number; color: RGB; liv: number; inset?: number };
  roofBoxes?: { x0: number; x1: number; y1: number; hz: number; color: RGB }[];
  pantograph?: { x: number; y: number };
  /** separate under-body skirt: [y0, y1, hw, colour] (e.g. bilevel belly between trucks) */
  belly?: { x0: number; x1: number; y0: number; y1: number; hw: number; color: RGB };
}

function addCar(b: MeshBuilder, c: Car) {
  const sec = mirrorSection(c.half);
  const top = Math.max(...c.half.map((p) => p[1]));
  const bot = c.half[0][1];
  const mid = (c.x0 + c.x1) / 2;
  const capFront = c.front ? 'none' : 'front';
  const capBack = c.back ? 'none' : 'back';
  const caps = capFront === 'front' && capBack === 'back' ? 'both' : capFront === 'front' ? 'front' : capBack === 'back' ? 'back' : 'none';
  b.extrudeX(sec, c.x0, c.x1, c.body, 0, caps);
  const inset = 0.25;
  for (const band of c.bands ?? []) {
    const ins = band.inset ?? inset;
    b.band(c.half, c.x0 + ins, c.x1 - ins, band.y0, band.y1, band.color, band.liv ?? 0, band.eps ?? 0.03);
  }
  if (c.doors) {
    for (const x of c.doors.xs) {
      b.band(c.half, mid + x - c.doors.w / 2, mid + x + c.doors.w / 2, c.doors.y0, c.doors.y1, c.doors.color, 0, 0.05);
      if (c.doors.win) b.band(c.half, mid + x - c.doors.w / 2 + 0.15, mid + x + c.doors.w / 2 - 0.15, c.doors.win[0], c.doors.win[1], C.glass, 0, 0.07);
    }
  }
  if (c.windows) {
    for (const x of c.windows.xs) {
      b.band(c.half, mid + x - c.windows.w / 2, mid + x + c.windows.w / 2, c.windows.y0, c.windows.y1, c.windows.color ?? C.glass, 0, c.windows.eps ?? 0.05);
    }
  }
  if (c.roofStrip) {
    const ins = c.roofStrip.inset ?? 0.4;
    b.roof(c.x0 + ins, c.x1 - ins, top + 0.02, c.roofStrip.hz, c.roofStrip.color, c.roofStrip.liv);
  }
  for (const r of c.roofBoxes ?? []) b.box(mid + r.x0, mid + r.x1, top - 0.05, r.y1, -r.hz, r.hz, r.color);
  if (c.bogies) {
    for (const x of c.bogies.xs) {
      b.box(mid + x - c.bogies.len / 2, mid + x + c.bogies.len / 2, c.bogies.y0, c.bogies.y1, -c.bogies.hw, c.bogies.hw, C.bogie, 0, 'bottom top');
    }
  }
  if (c.belly) {
    const e = c.belly;
    b.box(mid + e.x0, mid + e.x1, e.y0, e.y1, -e.hw, e.hw, e.color, 0, 'top');
  }
  if (c.pantograph) pantograph(b, mid + c.pantograph.x, c.pantograph.y);
  if (c.front) addNose(b, c.front, c.x1, 1, bot);
  if (c.back) addNose(b, c.back, c.x0, -1, bot);
}

function addNose(b: MeshBuilder, n: Nose, xEnd: number, dir: 1 | -1, _bot: number) {
  const prof: V2[] = n.profile.map(([x, y]) => [xEnd + dir * x, y]);
  b.extrudeZ(prof, n.hw, (i) => n.edges[Math.min(i, n.edges.length - 1)], n.side, 0, (i) => n.liv?.[i] ?? 0);
  if (n.sideWin) {
    const [a, c, y0, y1] = n.sideWin;
    const xa = xEnd + dir * a, xc = xEnd + dir * c;
    const lo = Math.min(xa, xc), hi = Math.max(xa, xc);
    for (const s of [1, -1]) {
      const z = s * (n.hw + 0.03);
      b.quad(v(lo, y0, z), v(hi, y0, z), v(hi, y1, z), v(lo, y1, z), C.glass, 0, v(0, 0, s));
    }
  }
  for (const [y0, y1, col, liv] of n.sideBands ?? []) {
    const ext = Math.min(profileX(n.profile, y0), profileX(n.profile, y1), profileX(n.profile, (y0 + y1) / 2)) - 0.02;
    if (ext <= 0) continue;
    const xa = xEnd - dir * 0.3, xc = xEnd + dir * ext;
    const lo = Math.min(xa, xc), hi = Math.max(xa, xc);
    for (const s of [1, -1]) {
      const z = s * (n.hw + 0.025);
      b.quad(v(lo, y0, z), v(hi, y0, z), v(hi, y1, z), v(lo, y1, z), col, liv ?? 0, v(0, 0, s));
    }
  }
  if (n.lamps) {
    const { x, y, z } = n.lamps;
    const xl = xEnd + dir * (x + 0.02);
    for (const s of [1, -1]) {
      b.quad(v(xl, y, s * z - 0.14), v(xl, y + 0.16, s * z - 0.14), v(xl, y + 0.16, s * z + 0.14), v(xl, y, s * z + 0.14), C.light, 0, v(dir, 0, 0));
    }
  }
}

/** furthest x of a side profile at height y */
function profileX(p: V2[], y: number): number {
  let best = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    if ((y0 - y) * (y1 - y) > 0 || y0 === y1) continue;
    best = Math.max(best, x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
  }
  return best;
}

function pantograph(b: MeshBuilder, x: number, y: number) {
  // base frame + folded diamond arm + head (pan) bar
  b.box(x - 0.9, x + 0.9, y, y + 0.14, -0.55, 0.55, C.under);
  const arm = (x0: number, y0: number, x1: number, y1: number) => {
    const w = 0.05;
    b.quad(v(x0, y0, -0.35), v(x1, y1, -0.35), v(x1, y1 + w * 2, -0.35), v(x0, y0 + w * 2, -0.35), C.black, 0, v(0, 0, -1));
    b.quad(v(x0, y0, 0.35), v(x1, y1, 0.35), v(x1, y1 + w * 2, 0.35), v(x0, y0 + w * 2, 0.35), C.black, 0, v(0, 0, 1));
  };
  arm(x - 0.7, y + 0.14, x + 0.3, y + 0.35);
  arm(x + 0.3, y + 0.35, x - 0.2, y + 0.55);
  b.box(x - 0.35, x - 0.05, y + 0.55, y + 0.62, -0.8, 0.8, C.black);
}

function v(x: number, y: number, z: number) {
  return new V3(x, y, z);
}

/** Build helper: lay out `n` cars of length `len` with `gap` between, centred at 0. Returns [x0, x1] per car. */
function layout(lens: number[], gap: number): [number, number][] {
  const total = lens.reduce((a, l) => a + l, 0) + gap * (lens.length - 1);
  let x = total / 2;
  const out: [number, number][] = [];
  for (const l of lens) {
    out.push([x - l, x]);
    x -= l + gap;
  }
  return out; // first = front-most
}

// ============================================================ TTC subway (TR)
// Bombardier Toronto Rocket: 6 × ~23 m = 138 m (Line 4: 4 cars ≈ 92 m),
// 3.65 m high, 3.13 m wide. Stainless body, black window band, red cab front.
const TR_HALF: V2[] = [[1.45, 0.95], [1.565, 1.25], [1.565, 2.95], [1.42, 3.38], [0.95, 3.6], [0, 3.65]];

function trNose(): Nose {
  return {
    profile: [[0, 0.95], [0.8, 0.95], [0.95, 1.15], [0.95, 1.85], [0.85, 2.1], [0.55, 3.3], [0.3, 3.58], [0, 3.65]],
    edges: [C.under, C.black, C.ttcRed, C.black, C.glass, C.black, C.steel, C.steel],
    side: C.steel,
    hw: 1.5,
    sideBands: [[1.52, 1.66, C.ttcRed]],
    sideWin: [-1.6, -0.2, 1.95, 2.8],
    lamps: { x: 0.95, y: 1.4, z: 1.05 },
  };
}

export function subwayTR(cars = 6): THREE.BufferGeometry {
  const L = 23;
  const gap = 0.45;
  const b = new MeshBuilder();
  const lay = layout(new Array(cars).fill(L - gap), gap);
  lay.forEach(([x0, x1], i) => {
    const front = i === 0, back = i === cars - 1;
    const bx0 = back ? x0 + 0.95 : x0, bx1 = front ? x1 - 0.95 : x1;
    const mid = (x0 + x1) / 2;
    addCar(b, {
      x0: bx0, x1: bx1, half: TR_HALF, body: C.steel,
      bands: [
        { y0: 1.12, y1: 1.18, color: C.steelDark }, // ribs
        { y0: 1.32, y1: 1.38, color: C.steelDark },
        { y0: 1.52, y1: 1.66, color: C.ttcRed },
        { y0: 1.95, y1: 2.8, color: C.glass },
      ],
      doors: { xs: [-8.1, -2.7, 2.7, 8.1].map((x) => x + (mid - (bx0 + bx1) / 2)), w: 1.55, y0: 1.0, y1: 3.0, color: C.steelDark, win: [1.95, 2.75] },
      bogies: { xs: [-7.8, 7.8].map((x) => x + (mid - (bx0 + bx1) / 2)), len: 2.7, y0: 0.08, y1: 0.95, hw: 1.2 },
      roofStrip: { hz: 0.75, color: C.tint, liv: 1 },
      front: front ? trNose() : undefined,
      back: back ? trNose() : undefined,
    });
  });
  const total = cars * L - gap;
  return b.build([total, 3.65, 3.13]);
}

// ============================================================ TTC Flexity Outlook streetcar
// 30.2 m, 5 sections (cab / short pod / centre / short pod / cab), 2.54 m wide,
// 3.84 m to the pantograph head. Red body, black glass band, grey roof pods.
const FLX_HALF: V2[] = [[1.18, 0.34], [1.27, 0.62], [1.27, 2.85], [1.12, 3.22], [0.6, 3.34], [0, 3.36]];

function flexityNose(body: RGB, lower: RGB): Nose {
  return {
    profile: [[0, 0.34], [0.85, 0.34], [1.05, 0.62], [1.05, 1.15], [0.95, 1.45], [0.62, 2.95], [0.35, 3.3], [0, 3.36]],
    edges: [C.under, C.black, lower, body, C.glass, C.black, body, body],
    side: body,
    hw: 1.22,
    sideBands: [[0.34, 0.62, C.charcoal], [0.95, 1.05, C.white]],
    sideWin: [-1.5, 0.35, 1.25, 2.75],
    lamps: { x: 1.05, y: 0.85, z: 0.85 },
  };
}

export function streetcarFlexity(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const lens = [7.3, 3.5, 8.0, 3.5, 7.3];
  const gap = 0.15;
  const lay = layout(lens, gap);
  const total = lens.reduce((a, l) => a + l, 0) + gap * 4;
  lay.forEach(([x0, x1], i) => {
    const front = i === 0, back = i === lens.length - 1;
    const bx0 = back ? x0 + 1.05 : x0, bx1 = front ? x1 - 1.05 : x1;
    const pod = i === 1 || i === 3;
    const len = bx1 - bx0;
    addCar(b, {
      x0: bx0, x1: bx1, half: FLX_HALF, body: C.ttcRed,
      bands: [
        { y0: 0.34, y1: 0.62, color: C.charcoal, inset: 0.05 },
        { y0: 0.95, y1: 1.05, color: C.white, inset: 0.05 },
        { y0: 1.25, y1: 2.75, color: C.glass, inset: pod ? 0.3 : 0.4 },
      ],
      doors: pod ? undefined : { xs: [front ? -1.2 : back ? 1.2 : 0], w: 1.3, y0: 0.4, y1: 2.9, color: C.ttcRedDark, win: [0.9, 2.7] },
      bogies: pod ? { xs: [0], len: 2.2, y0: 0.05, y1: 0.4, hw: 1.1 } : undefined,
      roofBoxes: pod ? undefined : [{ x0: -len / 2 + 0.8, x1: len / 2 - 0.8, y1: 3.62, hz: 0.85, color: C.roof }],
      pantograph: i === 2 ? { x: 0.4, y: 3.62 } : undefined,
      front: front ? flexityNose(C.ttcRed, C.ttcRed) : undefined,
      back: back ? flexityNose(C.ttcRed, C.ttcRed) : undefined,
    });
  });
  return b.build([total, 3.84, 2.54]);
}

// ============================================================ LRT (Line 5 Flexity Freedom / Line 6 Citadis Spirit)
// 2 × 30.8 m cars ≈ 62 m (Line 6: single ~48 m Citadis), 2.65 m wide, 3.7 m.
// White body, black glass, dark front; livery stripe + roof strip for the line colour.
const LRT_HALF: V2[] = [[1.24, 0.36], [1.325, 0.62], [1.325, 2.9], [1.18, 3.25], [0.6, 3.36], [0, 3.38]];

function lrtNose(): Nose {
  return {
    profile: [[0, 0.36], [0.95, 0.36], [1.15, 0.62], [1.15, 1.2], [1.05, 1.45], [0.6, 3.0], [0.3, 3.32], [0, 3.38]],
    edges: [C.under, C.charcoal, C.charcoal, C.tint, C.glass, C.charcoal, C.white, C.white],
    liv: [0, 0, 0, 1],
    side: C.white,
    hw: 1.28,
    sideBands: [[0.36, 0.62, C.charcoal], [0.72, 1.02, C.tint, 1]],
    sideWin: [-1.4, 0.4, 1.2, 2.8],
    lamps: { x: 1.15, y: 0.8, z: 0.9 },
  };
}

export function lrtVehicle(units = 2, unitLen = 30.8, modules = 5): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const gap = 0.6;
  const unitLay = layout(new Array(units).fill(unitLen), gap);
  const total = units * unitLen + gap * (units - 1);
  unitLay.forEach(([ux0, ux1], u) => {
    // each unit: cab + (modules-2) + cab with short articulation gaps
    const inner = unitLen - 0.12 * (modules - 1);
    const lens = new Array(modules).fill(inner / modules);
    const lay = layout(lens, 0.12).map(([a, c]) => [a + (ux0 + ux1) / 2, c + (ux0 + ux1) / 2] as [number, number]);
    lay.forEach(([x0, x1], i) => {
      const front = i === 0, back = i === modules - 1;
      const bx0 = back ? x0 + 1.15 : x0, bx1 = front ? x1 - 1.15 : x1;
      const len = bx1 - bx0;
      addCar(b, {
        x0: bx0, x1: bx1, half: LRT_HALF, body: C.white,
        bands: [
          { y0: 0.36, y1: 0.62, color: C.charcoal, inset: 0.05 },
          { y0: 0.72, y1: 1.02, color: C.tint, liv: 1, inset: 0.05 },
          { y0: 1.2, y1: 2.8, color: C.glass, inset: 0.35 },
        ],
        doors: { xs: [0], w: 1.3, y0: 0.4, y1: 2.9, color: C.offWhite, win: [0.9, 2.75] },
        bogies: i % 2 === 0 ? { xs: [0], len: 2.2, y0: 0.05, y1: 0.4, hw: 1.15 } : undefined,
        roofBoxes: [{ x0: -len / 2 + 0.7, x1: len / 2 - 0.7, y1: 3.6, hz: 0.8, color: C.roof }],
        roofStrip: undefined,
        pantograph: i === Math.floor(modules / 2) ? { x: 0, y: 3.6 } : undefined,
        front: front ? lrtNose() : undefined,
        back: back ? lrtNose() : undefined,
      });
      void u;
    });
  });
  return b.build([total, 3.7, 2.65]);
}

// ============================================================ GO Transit
// MP40PH-3C (21.2 m) + 10 BiLevel coaches (25.9 m) incl. cab car = 283 m;
// default 11 cars behind the loco ≈ 306 m. BiLevel: 4.84 m high, 2.95 m wide,
// low centre floor between the trucks, upper deck windows on the sloped sides.
const BL_HALF: V2[] = [[1.36, 1.15], [1.475, 1.3], [1.475, 2.95], [1.2, 4.35], [0.95, 4.8], [0, 4.84]];
const MP40_HALF: V2[] = [[1.4, 1.15], [1.52, 1.35], [1.52, 3.95], [1.3, 4.45], [0.7, 4.62], [0, 4.64]];

function biLevel(b: MeshBuilder, x0: number, x1: number, cab: boolean) {
  const mid = (x0 + x1) / 2;
  const bx0 = cab ? x0 + 0.7 : x0;
  const c = mid - (bx0 + x1) / 2; // shift from body middle to car middle
  addCar(b, {
    x0: bx0, x1, half: BL_HALF, body: C.white,
    bands: [
      { y0: 1.15, y1: 1.45, color: C.goGreen, inset: 0.05 },
      { y0: 2.6, y1: 2.78, color: C.goGreen, inset: 0.05 }, // stripe between decks
      { y0: 3.05, y1: 3.85, color: C.glass, inset: 1.2 }, // upper-deck ribbon glazing
    ],
    windows: { xs: [-7.2, -5.4, -3.6, -1.8, 0, 1.8, 3.6, 5.4, 7.2].map((x) => x + c), w: 1.35, y0: 1.2, y1: 2.35 },
    doors: { xs: [-9.6, 9.6].map((x) => x + c), w: 1.25, y0: 0.62, y1: 2.5, color: C.goGreenDark, win: [1.45, 2.3] },
    bogies: { xs: [-10.6, 10.6].map((x) => x + c), len: 2.8, y0: 0.08, y1: 1.15, hw: 1.2 },
    belly: { x0: -9.0 + c, x1: 9.0 + c, y0: 0.55, y1: 1.16, hw: 1.38, color: C.goGreen },
    roofBoxes: [{ x0: -11.8 + c, x1: -10.6 + c, y1: 4.92, hz: 0.5, color: C.roof }],
    back: cab ? {
      // flat-fronted cab car end: upper-deck cab windows, green lower
      profile: [[0, 1.15], [0.55, 1.15], [0.7, 1.35], [0.7, 2.6], [0.7, 3.05], [0.7, 3.9], [0.5, 4.7], [0, 4.84]],
      edges: [C.under, C.goGreen, C.goGreen, C.white, C.glass, C.white, C.white, C.white],
      side: C.white,
      hw: 1.44,
      sideWin: [0.1, 0.65, 3.05, 3.85],
      lamps: { x: 0.7, y: 1.8, z: 0.95 },
    } : undefined,
  });
}

function mp40(b: MeshBuilder, x0: number, x1: number) {
  const nose = 1.0;
  const bx1 = x1 - nose;
  const len = bx1 - x0;
  const mid = (x0 + bx1) / 2;
  addCar(b, {
    x0, x1: bx1, half: MP40_HALF, body: C.white,
    bands: [
      { y0: 1.15, y1: 2.2, color: C.goGreen, inset: 0.02 },
      { y0: 2.35, y1: 2.5, color: C.goGreen, inset: 0.02 },
    ],
    windows: { xs: [len / 2 - 1.1], w: 1.4, y0: 3.0, y1: 3.8 },
    bogies: { xs: [-len / 2 + 3.3, len / 2 - 3.8], len: 4.2, y0: 0.08, y1: 1.15, hw: 1.3 },
    // radiator/dynamic-brake hatches + exhaust at the rear
    roofBoxes: [
      { x0: -len / 2 + 0.5, x1: -len / 2 + 6.5, y1: 4.8, hz: 1.25, color: C.charcoal },
      { x0: -2.5, x1: 1.5, y1: 4.72, hz: 0.9, color: C.roof },
    ],
    front: {
      profile: [[0, 0.3], [0.55, 0.3], [1.0, 1.15], [1.0, 2.3], [0.85, 2.9], [0.55, 3.85], [0.35, 4.5], [0, 4.64]],
      edges: [C.black, C.charcoal, C.goGreen, C.white, C.glass, C.white, C.white, C.white],
      side: C.white,
      hw: 1.45,
      sideBands: [[1.15, 2.2, C.goGreen], [2.35, 2.5, C.goGreen]],
      lamps: { x: 1.0, y: 1.6, z: 0.95 },
    },
  });
  void mid;
  // side walkway / deck skirt
  b.box(x0 + 0.5, bx1 - 0.3, 0.95, 1.15, -1.55, 1.55, C.charcoal, 0, 'bottom top');
}

export function goTrain(coaches = 11): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const gap = 0.5;
  const lens = [21.2, ...new Array(coaches).fill(25.9)];
  const lay = layout(lens, gap);
  lay.forEach(([x0, x1], i) => {
    if (i === 0) mp40(b, x0, x1);
    else biLevel(b, x0, x1, i === lens.length - 1);
  });
  const total = lens.reduce((a, l) => a + l, 0) + gap * (lens.length - 1);
  return b.build([total, 4.92, 3.1]);
}

// ============================================================ UP Express
// Nippon Sharyo DMU, 3 cars ≈ 76 m, 4.25 m high, 3.1 m wide. Silver/white body,
// charcoal glazing band + lower skirt, orange accent, long sloped cab nose.
const UP_HALF: V2[] = [[1.45, 1.1], [1.55, 1.3], [1.55, 3.3], [1.35, 3.9], [0.8, 4.12], [0, 4.15]];

function upNose(): Nose {
  return {
    profile: [[0, 1.1], [1.9, 1.1], [2.4, 1.4], [2.4, 1.9], [2.0, 2.4], [0.9, 3.75], [0.4, 4.05], [0, 4.15]],
    edges: [C.under, C.charcoal, C.upOrange, C.charcoal, C.glass, C.charcoal, C.offWhite, C.offWhite],
    side: C.offWhite,
    hw: 1.5,
    sideBands: [[1.1, 1.6, C.charcoal], [1.72, 1.88, C.upOrange]],
    sideWin: [-1.2, 0.9, 2.25, 3.2],
    lamps: { x: 2.4, y: 1.55, z: 0.95 },
  };
}

export function upExpress(cars = 3): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const gap = 0.5;
  const L = 25.4;
  const lay = layout(new Array(cars).fill(L), gap);
  lay.forEach(([x0, x1], i) => {
    const front = i === 0, back = i === cars - 1;
    const bx0 = back ? x0 + 2.4 : x0, bx1 = front ? x1 - 2.4 : x1;
    const c = (x0 + x1) / 2 - (bx0 + bx1) / 2;
    addCar(b, {
      x0: bx0, x1: bx1, half: UP_HALF, body: C.offWhite,
      bands: [
        { y0: 1.1, y1: 1.6, color: C.charcoal, inset: 0.05 },
        { y0: 1.72, y1: 1.88, color: C.upOrange, inset: 0.05 },
        { y0: 2.15, y1: 3.25, color: C.charcoal, inset: 0.3 },
      ],
      windows: { xs: [-7.5, -5.3, -3.1, 3.1, 5.3, 7.5].map((x) => x + c), w: 1.8, y0: 2.3, y1: 3.1, eps: 0.05 },
      doors: { xs: [-1.2, 1.2].map((x) => x + c), w: 1.3, y0: 1.2, y1: 3.2, color: C.upOrange, win: [2.25, 3.05] },
      bogies: { xs: [-9.2, 9.2].map((x) => x + c), len: 2.8, y0: 0.08, y1: 1.1, hw: 1.2 },
      roofBoxes: [{ x0: -3 + c, x1: 3 + c, y1: 4.25, hz: 0.9, color: C.roof }],
      front: front ? upNose() : undefined,
      back: back ? upNose() : undefined,
    });
  });
  return b.build([cars * L + gap * (cars - 1), 4.25, 3.1]);
}

// ============================================================ VIA Rail
// GE P42DC "Genesis" (21 m, 4.4 m) + 6 LRC coaches (25.9 m, 3.8 m, rounded).
// Grey/steel with dark blue window band and yellow stripe.
const P42_HALF: V2[] = [[1.45, 1.1], [1.55, 1.3], [1.55, 3.6], [1.2, 4.2], [0.6, 4.4], [0, 4.4]];
const LRC_HALF: V2[] = [[1.3, 0.95], [1.52, 1.25], [1.6, 2.2], [1.52, 3.0], [1.25, 3.55], [0.7, 3.8], [0, 3.82]];

export function viaTrain(coaches = 6): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const gap = 0.5;
  const lens = [21.0, ...new Array(coaches).fill(25.9)];
  const lay = layout(lens, gap);
  lay.forEach(([x0, x1], i) => {
    if (i === 0) {
      const bx1 = x1 - 2.2;
      const len = bx1 - x0;
      addCar(b, {
        x0, x1: bx1, half: P42_HALF, body: C.viaGrey,
        bands: [
          { y0: 1.1, y1: 1.5, color: C.charcoal, inset: 0.02 },
          { y0: 1.75, y1: 2.05, color: C.viaYellow, inset: 0.02 },
          { y0: 2.05, y1: 2.9, color: C.viaBlue, inset: 0.02 },
        ],
        bogies: { xs: [-len / 2 + 3.2, len / 2 - 3.2], len: 3.6, y0: 0.08, y1: 1.1, hw: 1.3 },
        roofBoxes: [{ x0: -len / 2 + 1, x1: -len / 2 + 5, y1: 4.5, hz: 1.0, color: C.charcoal }],
        front: {
          // Genesis: raked nose, windscreen high on a steep slope
          profile: [[0, 0.3], [1.2, 0.3], [2.2, 1.1], [2.2, 2.0], [1.9, 2.9], [1.1, 3.75], [0.5, 4.3], [0, 4.4]],
          edges: [C.black, C.charcoal, C.viaYellow, C.viaBlue, C.glass, C.viaGrey, C.viaGrey, C.viaGrey],
          side: C.viaGrey,
          hw: 1.5,
          sideBands: [[1.1, 1.5, C.charcoal], [1.75, 2.05, C.viaYellow], [2.05, 2.9, C.viaBlue]],
          sideWin: [-1.0, 0.8, 3.0, 3.6],
          lamps: { x: 2.2, y: 1.5, z: 0.9 },
        },
      });
    } else {
      addCar(b, {
        x0, x1, half: LRC_HALF, body: C.steel,
        bands: [
          { y0: 1.3, y1: 1.5, color: C.viaYellow, inset: 0.05 },
          { y0: 1.55, y1: 1.72, color: C.viaBlue, inset: 0.05 },
          { y0: 2.0, y1: 2.8, color: C.glass, inset: 1.5 },
        ],
        doors: { xs: [-12.0, 12.0], w: 0.95, y0: 1.0, y1: 3.1, color: C.steelDark, win: [2.0, 2.8] },
        bogies: { xs: [-9.4, 9.4], len: 2.8, y0: 0.08, y1: 0.95, hw: 1.2 },
      });
    }
  });
  const total = lens.reduce((a, l) => a + l, 0) + gap * (lens.length - 1);
  return b.build([total, 4.5, 3.2]);
}

// ============================================================ Bus
// New Flyer / Nova LFS-style 40' (12.2 m × 2.6 m × 3.2 m incl. roof pods).
// White with a red (livery) skirt + front, black glazing. Articulated 18.3 m variant.
const BUS_HALF: V2[] = [[1.25, 0.32], [1.3, 0.45], [1.3, 2.85], [1.18, 3.0], [0, 3.02]];

function busBody(b: MeshBuilder, x0: number, x1: number, front: boolean, back: boolean, wheels: number[]) {
  const nose = front ? 0.25 : 0;
  const bx1 = x1 - nose;
  addCar(b, {
    x0, x1: bx1, half: BUS_HALF, body: C.white,
    bands: [
      { y0: 0.32, y1: 1.05, color: C.tint, liv: 1, inset: 0.02 },
      { y0: 1.25, y1: 2.55, color: C.glass, inset: 0.35 },
    ],
    roofBoxes: [{ x0: -1.5 + (back ? -((x1 - x0) / 2) + 2.2 : 0), x1: 1.5 + (back ? -((x1 - x0) / 2) + 2.2 : 0), y1: 3.22, hz: 0.95, color: C.offWhite }],
    front: front ? {
      profile: [[0, 0.32], [0.25, 0.32], [0.25, 1.05], [0.25, 1.15], [0.12, 2.75], [0, 3.02]],
      edges: [C.under, C.tint, C.black, C.glass, C.white, C.white],
      liv: [0, 1],
      side: C.white,
      hw: 1.28,
      sideBands: [[0.32, 1.05, C.tint, 1]],
      lamps: { x: 0.25, y: 0.62, z: 0.95 },
    } : undefined,
  });
  // destination sign + tail lights
  if (front) b.endDecal(bx1 + 0.14, 1, 2.62, 2.9, 0.95, C.amber);
  if (back) b.endDecal(x0 - 0.02, -1, 1.0, 1.3, 1.1, C.tail);
  for (const wx of wheels) {
    for (const s of [1, -1]) {
      b.box(wx - 0.52, wx + 0.52, 0.0, 1.0, s > 0 ? 1.05 : -1.33, s > 0 ? 1.33 : -1.05, C.black, 0, 'bottom top');
    }
  }
}

export function bus(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const L = 12.2;
  busBody(b, -L / 2, L / 2, true, true, [L / 2 - 2.7, -L / 2 + 3.4]);
  // front door + centre door
  b.band(BUS_HALF, L / 2 - 1.95, L / 2 - 0.8, 0.4, 2.6, C.glass, 0, 0.06);
  b.band(BUS_HALF, -0.6, 0.6, 0.4, 2.6, C.glass, 0, 0.06);
  return b.build([L, 3.22, 2.6]);
}

export function busArticulated(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const L = 18.3;
  const a1 = 10.6, g = 0.9;
  busBody(b, L / 2 - a1, L / 2, true, false, [L / 2 - 2.7, L / 2 - a1 + 1.8]);
  busBody(b, -L / 2, L / 2 - a1 - g, false, true, [-L / 2 + 2.0]);
  // bellows
  b.box(L / 2 - a1 - g - 0.05, L / 2 - a1 + 0.05, 0.4, 2.95, -1.2, 1.2, C.charcoal);
  b.band(BUS_HALF, L / 2 - 1.95, L / 2 - 0.8, 0.4, 2.6, C.glass, 0, 0.06);
  b.band(BUS_HALF, L / 2 - a1 + 2.8, L / 2 - a1 + 4.0, 0.4, 2.6, C.glass, 0, 0.06);
  b.band(BUS_HALF, -L / 2 + 3.2, -L / 2 + 4.4, 0.4, 2.6, C.glass, 0, 0.06);
  return b.build([L, 3.22, 2.6]);
}

// ============================================================ registry
export type VehicleKey = 'subway' | 'lrt' | 'streetcar' | 'commuter_rail' | 'airport_rail' | 'intercity_rail' | 'bus';

export interface VehicleModel {
  name: string;
  /** cached, unit-normalised geometry (shared: do not dispose / mutate) */
  geometry(): THREE.BufferGeometry;
  /** real size [length, height, width] in metres — pass as MarkerOverlay `size` */
  size: [number, number, number];
  /** what the `livery` attribute marks (tinted by the instance colour) */
  liveryRegions?: string[];
  /** instance colour that reproduces the real livery (use when not tinting by route) */
  defaultTint: number;
}

function model(name: string, f: () => THREE.BufferGeometry, liveryRegions: string[], defaultTint: number): VehicleModel {
  let g: THREE.BufferGeometry | null = null;
  const geometry = () => (g ??= f());
  return {
    name, liveryRegions, defaultTint, geometry,
    get size() { return geometry().userData.size as [number, number, number]; },
  };
}

export const VEHICLE_MODELS: Record<VehicleKey, VehicleModel> = {
  subway: model('TTC Toronto Rocket (6 cars)', () => subwayTR(6), ['roof strip'], 0xb8bec5),
  lrt: model('Line 5 Flexity Freedom (2 cars)', () => lrtVehicle(2), ['side stripe', 'front lower panel'], 0xff8000),
  streetcar: model('TTC Flexity Outlook', streetcarFlexity, [], 0xffffff),
  commuter_rail: model('GO MP40 + 11 BiLevel', () => goTrain(11), [], 0xffffff),
  airport_rail: model('UP Express DMU (3 cars)', () => upExpress(3), [], 0xffffff),
  intercity_rail: model('VIA P42 + 6 LRC', () => viaTrain(6), [], 0xffffff),
  bus: model('40\' low-floor bus', bus, ['lower body skirt', 'front lower panel'], 0xda251d),
};

/** Extra variants (not keyed by mode). */
export const EXTRA_MODELS = {
  subway4: model('TTC Toronto Rocket (4 cars, Line 4)', () => subwayTR(4), ['roof strip'], 0xb8bec5),
  lrt1: model('LRT single unit (Line 6 / ION)', () => lrtVehicle(1), ['side stripe', 'front lower panel'], 0x969696),
  goShort: model('GO MP40 + 6 BiLevel', () => goTrain(6), [], 0xffffff),
  busArtic: model('18 m articulated bus', busArticulated, ['lower body skirt', 'front lower panel'], 0xda251d),
};

export function triangleCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}
