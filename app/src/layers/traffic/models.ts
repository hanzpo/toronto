// Low-poly, to-scale road vehicle + pedestrian models for instanced rendering.
// Local frame: +x forward, +y up, +z right; origin on the ground at the
// vehicle centre; metres (no normalisation — instance matrices carry no scale).
//
// Vertex attributes (all float):
//   position, normal, color (linear RGB)
//   tint   1 = multiply by the instance body / clothing colour (also mirrored as `livery`)
//   lamp   0 none, 1 headlight, 2 tail/brake, 3 indicator-left, 4 indicator-right
//   sign   1 = taxi roof sign (glows)
//   glass  1 = glazing
//   pedestrians only:
//   limb   0 body/head, 1 left arm, 2 right arm, 3 left leg, 4 right leg (left = −z)
//   pivot  joint height (m) the limb swings about (shoulder / hip)
//   swing  legacy linear swing weight (≈ rotation about the pivot; kept for the old shader)
//
// Bodies are lofted through cross-section stations (bumper, hood, cowl,
// windscreen top, roof end, deck, tail) so sedans / hatchbacks / SUVs / pickups
// / vans have their real glasshouse and silhouette; tyres + rims are separate
// prisms on top of black wheel-arch decals.
import * as THREE from 'three/webgpu';
import { abs, attribute, cos, float, sin, vec3 } from 'three/tsl';
import { MeshBuilder, paint, rgb, type RGB, type Station, type V2 } from '../../models/builder';

// ------------------------------------------------------------------ palette
const BODY = paint(0xffffff, { liv: 1 });
const GLASS = paint(0x0e1318, { glass: 1 });
const TRIM = paint(0x17181a);
const GRILLE = paint(0x0d0e0f);
const TYRE = paint(0x111213);
const RIM = paint(0xa7abb0);
const HEAD = paint(0xf4f1e6, { lamp: 1 });
const TAIL = paint(0x9a0c08, { lamp: 2 });
const IND_L = paint(0xd07a12, { lamp: 3 });
const IND_R = paint(0xd07a12, { lamp: 4 });
const PLATE = paint(0xe8ecef);
const CHROME = paint(0x9aa0a6);

// ------------------------------------------------------------------ lofted car kit
type Seg = 'hood' | 'ws' | 'cabin' | 'rs' | 'rsq' | 'panel';
interface St {
  x: number;
  /** collapsed (hood / deck / bed) height, or undefined for a full cabin section */
  h?: number;
  /** width scale (rounded corners at bumpers) */
  s?: number;
  /** overrides for cabin stations */
  roof?: number; top?: number;
  /** body bottom override */
  bot?: number;
  /** paint of the segment from this station to the next */
  seg: Seg;
}
interface CarShape {
  hw: number; roofHw: number; bot: number; belt: number; top: number; roof: number;
  /** lower body trim (plastic cladding) instead of body colour on the sill */
  cladding?: boolean;
}

function section(c: CarShape, st: St): V2[] {
  const s = st.s ?? 1;
  const hw = c.hw * s, bot = st.bot ?? c.bot;
  if (st.h !== undefined) {
    const h = st.h;
    const belt = Math.min(c.belt, h - 0.03);
    return [[hw - 0.07, bot], [hw, bot + 0.16], [hw, belt], [hw - 0.06, h], [hw - 0.14, h + 0.012], [hw - 0.26, h + 0.024], [0, h + 0.04]];
  }
  const roof = st.roof ?? c.roof, top = st.top ?? c.top;
  const rhw = c.roofHw * s;
  return [[hw - 0.07, bot], [hw, bot + 0.16], [hw, c.belt], [hw - 0.06, c.belt + 0.04], [rhw, top], [rhw - 0.1, roof], [0, roof + 0.025]];
}

function segPaint(seg: Seg, edge: number, clad: boolean): RGB {
  if (edge === 0) return clad ? TRIM : BODY;
  if (edge <= 2) return BODY;
  switch (seg) {
    case 'hood': case 'panel': return BODY;
    case 'ws': return edge === 3 ? GLASS : edge === 4 ? BODY : GLASS;
    case 'cabin': return edge === 3 ? GLASS : BODY;
    case 'rs': return edge === 5 ? GLASS : BODY;
    case 'rsq': return edge === 4 ? BODY : GLASS;
  }
}

interface CarBuild { b: MeshBuilder; st: St[]; shape: CarShape; front: number; rear: number }

function loftCar(shape: CarShape, st: St[], capRear: (edge: number) => RGB | null = (e) => (e === 0 ? GRILLE : e === 3 && st[0].h === undefined ? GLASS : BODY)): CarBuild {
  const b = new MeshBuilder();
  const stations: Station[] = [...st].reverse().map((s) => ({ x: s.x, pts: section(shape, s) }));
  // stations are now ascending in x: seg i spans stations i..i+1 → original seg of station (n-2-i)
  const n = st.length;
  b.loft(stations, (i, e) => segPaint(st[n - 2 - i].seg, e, !!shape.cladding), {
    front: (e) => (e === 0 ? GRILLE : e === 3 && st[0].h === undefined ? GLASS : BODY),
    back: capRear,
    bottom: TRIM,
  });
  return { b, st, shape, front: st[0].x, rear: st[n - 1].x };
}

/** Front / rear face decal (x plane). */
function face(b: MeshBuilder, x: number, dir: 1 | -1, y0: number, y1: number, z0: number, z1: number, c: RGB) {
  b.poly([new THREE.Vector3(x, y0, z0), new THREE.Vector3(x, y0, z1), new THREE.Vector3(x, y1, z1), new THREE.Vector3(x, y1, z0)], c, 0, new THREE.Vector3(dir, 0, 0));
}

function capTop(c: CarBuild, which: 'front' | 'rear') {
  const st = which === 'front' ? c.st[0] : c.st[c.st.length - 1];
  const sec = section(c.shape, st);
  return { x: st.x, top: sec[sec.length - 1][1], bot: sec[0][1], hw: sec[1][0] };
}

interface Details {
  wheels: { x: number; r: number; w?: number }[];
  /** head-lamp band on the front face: y0, y1, inner z, outer z */
  head: [number, number, number, number];
  tail: [number, number, number, number];
  /** B-pillar x positions, door seams */
  pillars?: number[];
  seams?: number[];
  mirrors?: number;
  grille?: [number, number, number];
  rim?: RGB;
}

function details(c: CarBuild, d: Details) {
  const { b, shape } = c;
  const hw = shape.hw;
  const f = capTop(c, 'front'), r = capTop(c, 'rear');
  // lamps
  const [hy0, hy1, hz0, hz1] = d.head;
  for (const s of [1, -1]) {
    face(b, f.x + 0.012, 1, hy0, hy1, s * hz0, s * hz1, HEAD);
    face(b, f.x + 0.012, 1, hy0, hy0 + 0.05, s * (hz1 + 0.01), s * Math.min(hz1 + 0.09, f.hw - 0.02), s > 0 ? IND_R : IND_L);
  }
  const [ty0, ty1, tz0, tz1] = d.tail;
  for (const s of [1, -1]) {
    face(b, r.x - 0.012, -1, ty0, ty1, s * tz0, s * tz1, TAIL);
    face(b, r.x - 0.012, -1, ty0 - 0.06, ty0 - 0.01, s * tz0, s * tz1, s > 0 ? IND_R : IND_L);
  }
  // grille, plates
  const [gy0, gy1, gz] = d.grille ?? [f.bot + 0.2, hy0 - 0.02, hz0 - 0.06];
  face(b, f.x + 0.01, 1, gy0, gy1, -gz, gz, GRILLE);
  face(b, f.x + 0.014, 1, f.bot + 0.06, f.bot + 0.18, -0.26, 0.26, PLATE);
  face(b, r.x - 0.014, -1, ty0 - 0.3, ty0 - 0.16, -0.26, 0.26, PLATE);
  // wheels + arches
  const zSide = hw + 0.004;
  for (const w of d.wheels) {
    const ar = w.r + 0.07;
    const pts: V2[] = [];
    for (let i = 0; i <= 8; i++) pts.push([w.x + Math.cos((i / 8) * Math.PI) * ar, w.r + Math.sin((i / 8) * Math.PI) * ar]);
    pts.push([w.x - ar, shape.bot + 0.04], [w.x + ar, shape.bot + 0.04]);
    b.sidePoly(pts, zSide, TRIM);
    b.wheelPair(w.x, w.r, w.w ?? 0.22, hw + 0.012, TYRE, d.rim ?? RIM, 0.6, 10);
  }
  // pillars + door seams
  const cab = c.st.find((s) => s.h === undefined)!;
  const cabHalf = section(shape, cab);
  for (const x of d.pillars ?? []) b.band(cabHalf, x - 0.05, x + 0.05, shape.belt + 0.04, (cab.top ?? shape.top), TRIM, 0, 0.012);
  for (const x of d.seams ?? []) b.band(cabHalf, x - 0.008, x + 0.008, shape.bot + 0.2, shape.belt, TRIM, 0, 0.006);
  if (d.mirrors !== undefined) {
    for (const s of [1, -1]) b.box(d.mirrors - 0.08, d.mirrors + 0.06, shape.belt + 0.04, shape.belt + 0.17, s > 0 ? hw - 0.02 : -hw - 0.16, s > 0 ? hw + 0.16 : -hw + 0.02, BODY, 0, 'bottom');
  }
}

// ------------------------------------------------------------------ variants
export interface CarVariant {
  key: string;
  name: string;
  /** sim vehicle kind this variant can stand in for (0 sedan, 1 hatchback, 2 SUV, 3 pickup, 4 van, 5 truck) */
  kind: number;
  /** real length (m) */
  length: number;
  geometry(): THREE.BufferGeometry;
}

function finalize(b: MeshBuilder): THREE.BufferGeometry {
  const g = b.build();
  g.setAttribute('tint', g.attributes.livery);
  g.computeBoundingSphere();
  return g;
}

function sedan(taxi = false) {
  const shape: CarShape = { hw: 0.91, roofHw: 0.7, bot: 0.2, belt: 0.86, top: 1.3, roof: 1.43 };
  const c = loftCar(shape, [
    { x: 2.35, h: 0.72, s: 0.88, bot: 0.25, seg: 'hood' },
    { x: 2.22, h: 0.8, s: 0.97, seg: 'hood' },
    { x: 1.6, h: 0.87, seg: 'hood' },
    { x: 0.98, h: 0.92, seg: 'ws' },
    { x: 0.12, seg: 'cabin' },
    { x: -0.95, seg: 'rs' },
    { x: -1.72, h: 0.98, seg: 'hood' },
    { x: -2.25, h: 0.96, s: 0.97, seg: 'hood' },
    { x: -2.35, h: 0.84, s: 0.9, bot: 0.25 },
  ].map((s) => ({ seg: 'hood', ...s }) as St));
  details(c, { wheels: [{ x: 1.42, r: 0.33 }, { x: -1.4, r: 0.33 }], head: [0.6, 0.7, 0.42, 0.74], tail: [0.8, 0.92, 0.38, 0.78], pillars: [-0.2], seams: [0.85, -0.2, -1.1], mirrors: 0.85 });
  if (taxi) {
    c.b.taperBox(-0.55, -0.1, 1.45, 1.66, 0.3, 0.03, 0.04, paint(0xf3f0e6, { sign: 1 }));
  }
  return finalize(c.b);
}

function hatchback() {
  const shape: CarShape = { hw: 0.89, roofHw: 0.7, bot: 0.19, belt: 0.88, top: 1.33, roof: 1.46 };
  const c = loftCar(shape, [
    { x: 2.05, h: 0.72, s: 0.88, bot: 0.24, seg: 'hood' },
    { x: 1.93, h: 0.8, s: 0.97, seg: 'hood' },
    { x: 1.4, h: 0.88, seg: 'hood' },
    { x: 0.82, h: 0.94, seg: 'ws' },
    { x: -0.05, seg: 'cabin' },
    { x: -1.72, seg: 'cabin' },
    { x: -1.97, roof: 1.4, top: 1.3, seg: 'rsq' },
    { x: -2.03, h: 0.9, s: 0.95, seg: 'hood' },
  ] as St[], (e) => (e === 0 ? GRILLE : BODY));
  details(c, { wheels: [{ x: 1.3, r: 0.32 }, { x: -1.3, r: 0.32 }], head: [0.62, 0.72, 0.4, 0.73], tail: [0.78, 0.9, 0.42, 0.78], pillars: [-0.5, -1.62], seams: [0.7, -0.5, -1.3], mirrors: 0.7 });
  return finalize(c.b);
}

function suv(len = 4.9, roofH = 1.76, key: 'suv' | 'crossover' = 'suv') {
  const h = len / 2;
  const shape: CarShape = { hw: key === 'suv' ? 0.965 : 0.93, roofHw: key === 'suv' ? 0.8 : 0.74, bot: key === 'suv' ? 0.3 : 0.26, belt: key === 'suv' ? 1.06 : 1.0, top: roofH - 0.14, roof: roofH, cladding: true };
  const c = loftCar(shape, [
    { x: h, h: key === 'suv' ? 0.95 : 0.86, s: 0.9, bot: 0.33, seg: 'hood' },
    { x: h - 0.12, h: key === 'suv' ? 1.03 : 0.94, s: 0.97, seg: 'hood' },
    { x: h - 0.7, h: key === 'suv' ? 1.09 : 1.0, seg: 'hood' },
    { x: h - 1.25, h: key === 'suv' ? 1.13 : 1.05, seg: 'ws' },
    { x: h - 2.05, seg: 'cabin' },
    { x: -h + 0.3, seg: 'cabin' },
    { x: -h + 0.07, roof: roofH - (key === 'suv' ? 0.05 : 0.12), top: roofH - 0.24, seg: 'rsq' },
    { x: -h, h: key === 'suv' ? 1.02 : 0.95, s: 0.95, bot: 0.33, seg: 'hood' },
  ] as St[], (e) => (e === 0 ? GRILLE : BODY));
  const r = key === 'suv' ? 0.38 : 0.35;
  details(c, {
    wheels: [{ x: h - 1.0, r }, { x: -h + 1.05, r }], head: key === 'suv' ? [0.82, 0.94, 0.42, 0.8] : [0.74, 0.84, 0.42, 0.77],
    tail: [key === 'suv' ? 1.0 : 0.94, key === 'suv' ? 1.14 : 1.06, 0.5, 0.84], pillars: [h - 2.9, -h + 0.45], seams: [h - 2.05, h - 2.9, -h + 1.5], mirrors: h - 1.3,
  });
  // roof rails
  if (key === 'suv') for (const s of [1, -1]) c.b.box(-h + 0.5, h - 2.2, roofH + 0.02, roofH + 0.07, s * 0.62 - 0.03, s * 0.62 + 0.03, TRIM, 0, 'bottom');
  return finalize(c.b);
}

function pickup() {
  const shape: CarShape = { hw: 1.0, roofHw: 0.84, bot: 0.4, belt: 1.24, top: 1.8, roof: 1.94, cladding: false };
  const c = loftCar(shape, [
    { x: 2.8, h: 1.08, s: 0.92, bot: 0.42, seg: 'hood' },
    { x: 2.68, h: 1.2, s: 0.98, seg: 'hood' },
    { x: 1.6, h: 1.24, seg: 'hood' },
    { x: 1.15, h: 1.28, seg: 'ws' },
    { x: 0.45, seg: 'cabin' },
    { x: -0.92, seg: 'cabin' },
    { x: -0.98, h: 1.3, seg: 'hood' },
    { x: -2.72, h: 1.3, seg: 'hood' },
    { x: -2.8, h: 1.26, s: 0.97, seg: 'hood' },
  ] as St[]);
  // open bed
  c.b.box(-2.68, -1.02, 1.335, 1.34, -0.86, 0.86, TRIM, 0, 'bottom');
  // chrome grille / bumpers
  face(c.b, 2.815, 1, 0.72, 1.02, -0.62, 0.62, CHROME);
  details(c, { wheels: [{ x: 1.85, r: 0.4, w: 0.27 }, { x: -1.75, r: 0.4, w: 0.27 }], head: [0.88, 1.02, 0.64, 0.88], tail: [0.95, 1.22, 0.86, 0.96], pillars: [-0.25], seams: [1.1, -0.25], mirrors: 1.1, grille: [0.62, 0.86, 0.6], rim: RIM });
  return finalize(c.b);
}

function minivan() {
  const shape: CarShape = { hw: 1.0, roofHw: 0.82, bot: 0.22, belt: 0.98, top: 1.62, roof: 1.76 };
  const c = loftCar(shape, [
    { x: 2.6, h: 0.78, s: 0.88, bot: 0.26, seg: 'hood' },
    { x: 2.48, h: 0.86, s: 0.97, seg: 'hood' },
    { x: 2.0, h: 0.96, seg: 'hood' },
    { x: 1.5, h: 1.02, seg: 'ws' },
    { x: 0.55, seg: 'cabin' },
    { x: -2.35, seg: 'cabin' },
    { x: -2.55, roof: 1.7, top: 1.55, seg: 'rsq' },
    { x: -2.6, h: 0.95, s: 0.95, seg: 'hood' },
  ] as St[], (e) => (e === 0 ? GRILLE : BODY));
  details(c, { wheels: [{ x: 1.55, r: 0.35 }, { x: -1.53, r: 0.35 }], head: [0.7, 0.82, 0.45, 0.82], tail: [0.95, 1.2, 0.7, 0.9], pillars: [0.05, -1.5], seams: [0.05, -1.4], mirrors: 1.45 });
  return finalize(c.b);
}

function deliveryVan() {
  // high-roof cargo van (Transit / Sprinter class)
  const shape: CarShape = { hw: 1.02, roofHw: 0.95, bot: 0.3, belt: 1.12, top: 1.82, roof: 2.5 };
  const c = loftCar(shape, [
    { x: 2.65, h: 0.78, s: 0.88, bot: 0.34, seg: 'hood' },
    { x: 2.52, h: 0.9, s: 0.96, seg: 'hood' },
    { x: 2.08, h: 1.02, seg: 'hood' },
    { x: 1.72, h: 1.12, seg: 'ws' },
    { x: 1.05, roof: 2.0, top: 1.86, seg: 'cabin' },
    { x: 0.95, roof: 2.48, top: 1.86, seg: 'panel' },
    { x: -2.6, roof: 2.48, top: 1.86, seg: 'panel' },
    { x: -2.65, h: 2.4, s: 0.99, seg: 'panel' },
  ] as St[], (e) => (e === 0 ? GRILLE : BODY));
  details(c, { wheels: [{ x: 1.75, r: 0.36 }, { x: -1.6, r: 0.36 }], head: [0.86, 1.0, 0.5, 0.86], tail: [0.9, 1.4, 0.9, 0.98], seams: [0.25, -1.9], mirrors: 1.55 });
  // rear doors split + windows, side sliding-door seam
  face(c.b, -2.662, -1, 1.2, 1.7, -0.8, -0.05, GLASS);
  face(c.b, -2.662, -1, 1.2, 1.7, 0.05, 0.8, GLASS);
  face(c.b, -2.664, -1, 0.4, 2.3, -0.012, 0.012, TRIM);
  return finalize(c.b);
}

function boxTruck() {
  // cab-over medium-duty box truck (Isuzu N / Hino class), 8.6 m
  const cabShape: CarShape = { hw: 1.08, roofHw: 1.0, bot: 0.55, belt: 1.5, top: 2.45, roof: 2.72 };
  const c = loftCar(cabShape, [
    { x: 4.3, seg: 'cabin' },
    { x: 2.35, seg: 'cabin' },
  ] as St[], () => BODY);
  const cb = c.b;
  const cargo = paint(0xe6e7e4);
  cb.box(-4.3, 2.2, 0.98, 3.45, -1.25, 1.25, cargo, 0, '');
  cb.box(-4.3, 2.2, 3.45, 3.47, -1.25, 1.25, paint(0xcfd1cf), 0, 'bottom');
  // rear roll door ribs
  for (let y = 1.2; y < 3.3; y += 0.3) face(cb, -4.31, -1, y, y + 0.025, -1.15, 1.15, paint(0xb9bcbc));
  // chassis, bumper, fuel tank, side guards
  cb.box(-4.1, 4.35, 0.55, 0.98, -0.5, 0.5, TRIM, 0, 'bottom');
  cb.box(4.28, 4.42, 0.4, 0.75, -1.1, 1.1, TRIM, 0, 'bottom');
  cb.box(-0.6, 0.9, 0.45, 0.9, -1.1, -0.55, paint(0x9aa0a5), 0, 'bottom');
  cb.box(-4.35, -4.2, 0.45, 0.98, -1.2, 1.2, TRIM, 0, 'bottom');
  details(c, { wheels: [{ x: 3.1, r: 0.46, w: 0.26 }, { x: -2.2, r: 0.46, w: 0.3 }], head: [0.85, 1.05, 0.62, 0.98], tail: [0.62, 0.84, 0.95, 1.15], mirrors: 4.0, grille: [1.1, 1.45, 0.55] });
  // windscreen on the cab front (front cap edge 3 is glass) + rear dual wheels hint
  for (const s of [1, -1]) cb.box(-2.2 - 0.46, -2.2 + 0.46, 0.0, 0.92, s > 0 ? 0.55 : -0.85, s > 0 ? 0.85 : -0.55, TYRE, 0, 'bottom top');
  // tail lamps sit on the box rear
  for (const s of [1, -1]) face(cb, -4.36, -1, 0.62, 0.84, s * 0.95, s * 1.15, TAIL);
  return finalize(cb);
}

let _variants: CarVariant[] | null = null;
const v = (key: string, name: string, kind: number, length: number, f: () => THREE.BufferGeometry): CarVariant => {
  let g: THREE.BufferGeometry | null = null;
  return { key, name, kind, length, geometry: () => (g ??= f()) };
};

/** All road vehicle variants (the first of each kind is the default used by carGeometries()). */
export const CAR_VARIANTS: CarVariant[] = (_variants ??= [
  v('sedan', 'Sedan (Camry / Civic class)', 0, 4.7, () => sedan(false)),
  v('hatchback', 'Hatchback (Golf / Corolla hatch)', 1, 4.1, hatchback),
  v('suv', 'SUV (Highlander / Explorer class)', 2, 4.9, () => suv(4.9, 1.76, 'suv')),
  v('pickup', 'Pickup (F-150 SuperCrew)', 3, 5.6, pickup),
  v('van', 'Delivery van (Transit high-roof)', 4, 5.3, deliveryVan),
  v('truck', 'Box truck (cab-over, 26 ft box)', 5, 8.6, boxTruck),
  v('taxi', 'Taxi (sedan + roof sign)', 0, 4.7, () => sedan(true)),
  v('crossover', 'Crossover (RAV4 / CR-V)', 2, 4.6, () => suv(4.6, 1.68, 'crossover')),
  v('minivan', 'Minivan (Grand Caravan / Sienna)', 4, 5.2, minivan),
]);

/** Variants usable for a sim kind (first = default). Pick by hashing the car id for variety. */
export function carVariantsForKind(kind: number): CarVariant[] {
  return CAR_VARIANTS.filter((x) => x.kind === kind);
}

/** Variant order matches the sim's vehicle kinds: sedan, hatchback, SUV, pickup, van, box truck. */
export function carGeometries(): THREE.BufferGeometry[] {
  return [0, 1, 2, 3, 4, 5].map((k) => carVariantsForKind(k)[0].geometry().clone());
}

/** Real-world lengths per kind (sim uses the same numbers). */
export const CAR_LENGTH = [4.7, 4.1, 4.9, 5.6, 5.3, 8.6];

// realistic body colour mix (white/black/grey/silver dominate)
const CAR_COLORS = [
  0xf1f1ef, 0xeeeeec, 0xe8e8e6, 0x16171a, 0x1c1d21, 0x2a2c30, 0x85888c, 0x6d7074,
  0xb9bcbf, 0xc8cacc, 0x1e3a6e, 0x2b4f8c, 0x8e1a1a, 0xa42a22, 0x2f4a38, 0x7a6a55,
];
export const carPalette = CAR_COLORS.map((c) => new THREE.Color(c));

// ------------------------------------------------------------------ pedestrians
interface PedBody {
  scale: number;
  pants: number; skin: number; hair: number; shoe: number;
  /** torso bottom (coat hem) */
  hem?: number;
  skirt?: boolean;
  longHair?: boolean;
  hat?: number;
  backpack?: number;
  sleeves?: 'long' | 'short';
  bulk?: number;
}

/** Vertical n-gon prism (elliptic, tapered). Caps optional. */
function prism(b: MeshBuilder, xc: number, zc: number, y0: number, y1: number, rx0: number, rz0: number, rx1: number, rz1: number, c: RGB, n = 6, caps: 'top' | 'both' | 'none' = 'top', dx1 = 0) {
  const ring = (y: number, rx: number, rz: number, ox: number) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    return new THREE.Vector3(xc + ox + Math.cos(a) * rx, y, zc + Math.sin(a) * rz);
  });
  const A = ring(y0, rx0, rz0, 0), B = ring(y1, rx1, rz1, dx1);
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    const mid = ((i + 0.5) / n) * Math.PI * 2 + Math.PI / n;
    b.quad(A[i], A[k], B[k], B[i], c, 0, new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)));
  }
  if (caps !== 'none') b.poly(B, c, 0, new THREE.Vector3(0, 1, 0));
  if (caps === 'both') b.poly(A, c, 0, new THREE.Vector3(0, -1, 0));
}

function pedestrian(p: PedBody): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const k = p.scale, bulk = p.bulk ?? 1;
  const Y = (y: number) => y * k;
  const shirt = paint(0xffffff, { liv: 1 });
  const pants = rgb(p.pants), skin = rgb(p.skin), hair = rgb(p.hair), shoe = rgb(p.shoe);
  const hip = Y(0.93), shoulder = Y(1.43);
  const part = (limb: number, pivot: number, f: () => void) => {
    b.setExtra('limb', limb); b.setExtra('pivot', pivot);
    // legacy swing weight: 0 at the joint, ±1 (legs) / ∓0.6 (arms) at the extremity, linear in between
    b.setExtra('swingSign', limb === 3 ? 1 : limb === 4 ? -1 : limb === 1 ? -0.6 : limb === 2 ? 0.6 : 0);
    f();
  };
  // legs (left = −z)
  for (const [limb, s] of [[3, -1], [4, 1]] as const) {
    part(limb, hip, () => {
      prism(b, 0, s * 0.095 * bulk, Y(0.07), hip + 0.02, 0.06 * bulk, 0.06 * bulk, 0.08 * bulk, 0.085 * bulk, p.skirt ? skin : pants, 6, 'none');
      b.box(-0.07, 0.16, 0, Y(0.08), s * 0.095 * bulk - 0.055, s * 0.095 * bulk + 0.055, shoe);
    });
  }
  part(0, 0, () => {
    // pelvis / skirt
    if (p.skirt) prism(b, 0, 0, Y(0.62), Y(1.0), 0.17 * bulk, 0.24 * bulk, 0.12 * bulk, 0.17 * bulk, pants, 8, 'none');
    else prism(b, 0, 0, Y(0.84), Y(1.0), 0.11 * bulk, 0.17 * bulk, 0.12 * bulk, 0.18 * bulk, pants, 6, 'none');
    // torso (shirt / coat, tinted)
    prism(b, 0, 0, p.hem !== undefined ? Y(p.hem) : Y(0.95), Y(1.46), 0.11 * bulk, 0.155 * bulk, 0.115 * bulk, 0.175 * bulk, shirt, 8, 'top');
    // neck + head
    prism(b, 0.005, 0, Y(1.45), Y(1.53), 0.045, 0.045, 0.045, 0.045, skin, 5, 'none');
    prism(b, 0.01, 0, Y(1.52), Y(1.75), 0.095, 0.085, 0.09, 0.08, skin, 8, 'top');
    // hair / hat
    if (p.hat !== undefined) prism(b, 0, 0, Y(1.66), Y(1.8), 0.105, 0.095, 0.07, 0.06, rgb(p.hat), 8, 'top');
    else prism(b, -0.012, 0, Y(1.66), Y(1.77), 0.1, 0.092, 0.085, 0.078, hair, 8, 'top');
    if (p.longHair) prism(b, -0.07, 0, Y(1.36), Y(1.7), 0.05, 0.09, 0.06, 0.09, hair, 6, 'none');
    if (p.backpack !== undefined) b.box(-0.28 * bulk, -0.11 * bulk, Y(1.05), Y(1.42), -0.15, 0.15, rgb(p.backpack), 0, 'bottom');
  });
  // arms
  for (const [limb, s] of [[1, -1], [2, 1]] as const) {
    part(limb, shoulder, () => {
      const z = s * 0.205 * bulk;
      prism(b, 0, z, Y(1.12), shoulder, 0.046, 0.042, 0.052, 0.05, shirt, 6, 'top');
      prism(b, 0.01, z, Y(0.86), Y(1.12), 0.042, 0.04, 0.05, 0.048, p.sleeves === 'short' ? skin : shirt, 6, 'none');
      prism(b, 0.015, z, Y(0.76), Y(0.86), 0.035, 0.028, 0.042, 0.035, skin, 5, 'both');
    });
  }
  const g = b.build();
  g.setAttribute('tint', g.attributes.livery);
  // legacy `swing` = sign × (pivot − y) / (pivot − extremity)
  const pos = g.attributes.position.array as Float32Array;
  const piv = g.attributes.pivot.array as Float32Array;
  const sg = g.attributes.swingSign.array as Float32Array;
  const limbA = g.attributes.limb.array as Float32Array;
  const sw = new Float32Array(piv.length);
  for (let i = 0; i < sw.length; i++) {
    const reach = limbA[i] >= 3 ? piv[i] : piv[i] - Y(0.76);
    sw[i] = sg[i] ? sg[i] * Math.max(0, Math.min(1, (piv[i] - pos[i * 3 + 1]) / reach)) : 0;
  }
  g.setAttribute('swing', new THREE.BufferAttribute(sw, 1));
  g.deleteAttribute('swingSign');
  g.computeBoundingSphere();
  return g;
}

const PED_BODIES: PedBody[] = [
  { scale: 1.0, pants: 0x2b3446, skin: 0xb98a6a, hair: 0x2a1d14, shoe: 0x1a1a1a, sleeves: 'short' },
  { scale: 0.95, pants: 0x1b1c20, skin: 0xe0b89a, hair: 0x5a3a22, shoe: 0x2a2020, skirt: true, longHair: true, bulk: 0.9, sleeves: 'long' },
  { scale: 1.03, pants: 0x3a3a3e, skin: 0x6e4a34, hair: 0x111111, shoe: 0x222222, hem: 0.7, hat: 0x2d3340, bulk: 1.08, sleeves: 'long', backpack: 0x24272b },
  { scale: 0.88, pants: 0x4c5a6e, skin: 0xd8a882, hair: 0x1c1410, shoe: 0xdedede, backpack: 0xb23a2e, bulk: 0.92, sleeves: 'short' },
];

let _peds: THREE.BufferGeometry[] | null = null;
/** Pedestrian body types (adult man, woman with skirt, man in winter coat + toque + backpack, teen with backpack). */
export function pedestrianGeometries(): THREE.BufferGeometry[] {
  return (_peds ??= PED_BODIES.map(pedestrian));
}

/** Default pedestrian (TrafficLayer's single pool). */
export function pedestrianGeometry(): THREE.BufferGeometry {
  return pedestrianGeometries()[0].clone();
}

/**
 * TSL walk-cycle position node (local space, +x = forward) for pedestrian
 * geometries: rotates arms / legs about their shoulder / hip pivot by the
 * walking phase and adds a small bob. `anim` = vec3(phase, heading, moving).
 * Use as `material.positionNode = pedestrianWalkNode(attribute('iAnim', 'vec3'))`.
 */
export function pedestrianWalkNode(anim: ReturnType<typeof vec3> | ReturnType<typeof attribute>) {
  const a = anim as ReturnType<typeof vec3>;
  const limb = attribute('limb', 'float');
  const pivot = attribute('pivot', 'float');
  const p = attribute('position', 'vec3');
  const s = sin(a.x).mul(a.z);
  // legs ±0.45 rad, arms ∓0.35 rad; left / right in antiphase
  const isL = (k: number) => float(1).sub(abs(limb.sub(k)).min(1));
  const ang = s.mul(isL(3).mul(0.45).sub(isL(4).mul(0.45)).sub(isL(1).mul(0.35)).add(isL(2).mul(0.35)));
  const dy = p.y.sub(pivot);
  const c = cos(ang), sn = sin(ang);
  const moved = vec3(p.x.mul(c).sub(dy.mul(sn)), pivot.add(p.x.mul(sn)).add(dy.mul(c)), p.z);
  const limbMask = limb.min(1);
  const bob = abs(sin(a.x)).mul(0.03).mul(a.z);
  return vec3(p.x, p.y, p.z).mul(float(1).sub(limbMask)).add(moved.mul(limbMask)).add(vec3(0, bob, 0));
}

const SHIRTS = [
  0x2f3d5c, 0x9a2b2b, 0xe0ddd6, 0x1e1e22, 0x3d6b4f, 0xc79a3b, 0x6b4c8a, 0x4f7fa8,
  0xd46a3a, 0x7b7f86, 0xb5b0a5, 0x274d6e,
];
export const shirtPalette = SHIRTS.map((c) => new THREE.Color(c));
