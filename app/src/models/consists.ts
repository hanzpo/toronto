// Per-car transit consists: each car / module is its own instanced geometry so
// layers can place every car on the track individually (articulation reads on
// curves). Geometry convention (same as vehicles.ts): unit box — x ∈ [-.5, .5]
// (length, +x = forward), y ∈ [0, 1] (height, rail / road surface at 0),
// z ∈ [-.5, .5] (width, +z = right-hand side) — scale by `size` = [L, H, W] m.
// Pantographs may rise above y = 1 (to the contact wire).
//
// Vertex attributes: position, normal (metre space), color (linear RGB),
// livery (0|1 → × instance tint), lamp (0 none, 1 head, 2 tail/brake,
// 3 indicator-left, 4 indicator-right), sign (0|1 destination sign), glass (0|1).
// Cars are listed front → back; each car's +x points in the direction of
// travel. Cab cars exist in front / back variants (the lit lamps differ).
import type * as THREE from 'three/webgpu';
import type { MeshBuilder } from './builder';
import { flexityOutlook, FLEXITY_LEN, lrtModule, LRT_LEN, t1, torontoRocket, type FlexityModule, type LrtKind, type LrtModule } from './cars-ttc';
import { goBiLevel, mp40, upDmu, viaCharger, viaVenture } from './cars-mainline';
import { BUS_LEN, novaBus } from './cars-bus';

export type TransitMode = 'subway' | 'lrt' | 'streetcar' | 'commuter_rail' | 'airport_rail' | 'intercity_rail' | 'bus';

export interface CarSpec {
  key: string;
  geometry(): THREE.BufferGeometry;
  size: [number, number, number] /* L,H,W m */;
  /** ≤ ~150-250 triangle version for distance LOD (same attributes, same unit box) */
  lowGeometry?(): THREE.BufferGeometry;
  /** truck / axle pivots, metres from the car centre along x: [rear, front]; equal values = single truck; undefined = suspended module */
  bogies?: [number, number];
  /** human-readable name */
  name?: string;
}

export interface ConsistSpec {
  cars: CarSpec[];
  /** gap after car i (m), length = cars.length - 1 */
  gaps: number[];
  articulated: boolean;
  /** typical bogie pivots [rear, front] (m from car centre) of the consist's main car type */
  bogies?: [number, number];
}

type Maker = (low: boolean) => { b: MeshBuilder; L: number; H: number; W: number };

const cache = new Map<string, CarSpec>();
const def = (key: string, name: string, make: Maker, bogies?: [number, number]): CarSpec => {
  let spec = cache.get(key);
  if (spec) return spec;
  let hi: THREE.BufferGeometry | null = null, lo: THREE.BufferGeometry | null = null;
  const geometry = () => {
    if (!hi) { const r = make(false); hi = r.b.build([r.L, r.H, r.W]); hi.name = key; }
    return hi;
  };
  const lowGeometry = () => {
    if (!lo) { const r = make(true); lo = r.b.build([r.L, r.H, r.W]); lo.name = `${key}-low`; }
    return lo;
  };
  spec = {
    key, name, geometry, lowGeometry, bogies,
    get size() { return geometry().userData.size as [number, number, number]; },
  };
  cache.set(key, spec);
  return spec;
};

// ------------------------------------------------------------------ car catalogue
export const CARS = {
  trCabF: () => def('tr-cab-f', 'Toronto Rocket cab car (leading)', (l) => torontoRocket('front', l), [-8.17, 7.83]),
  trMid: () => def('tr-mid', 'Toronto Rocket intermediate car', (l) => torontoRocket('none', l), [-8, 8]),
  trCabR: () => def('tr-cab-r', 'Toronto Rocket cab car (trailing)', (l) => torontoRocket('back', l), [-7.83, 8.17]),
  t1CabF: () => def('t1-cab-f', 'T1 cab end (leading)', (l) => t1('front', l), [-8, 8]),
  t1Mid: () => def('t1-mid', 'T1 car', (l) => t1('none', l), [-8, 8]),
  t1CabR: () => def('t1-cab-r', 'T1 cab end (trailing)', (l) => t1('back', l), [-8, 8]),
  flexity: (m: FlexityModule) => def(`flexity-${m}`, `Flexity Outlook module ${m}`, (l) => flexityOutlook(m, l),
    m === 'C' ? [0, 0] : m === 'A-front' ? [-0.9, -0.9] : m === 'A-back' ? [0.9, 0.9] : undefined),
  lrt: (k: LrtKind, m: LrtModule) => def(`${k}-${m}`, `${k === 'freedom' ? 'Flexity Freedom' : 'Citadis Spirit'} module ${m}`, (l) => lrtModule(k, m, l),
    m === 'C' ? [0, 0] : m === 'A-front' ? [-1.2, -1.2] : m === 'A-back' ? [1.2, 1.2] : undefined),
  mp40: () => def('go-mp40', 'GO MP40PH-3C locomotive', (l) => mp40(l), [-6.9, 6.5]),
  biLevel: () => def('go-bilevel', 'GO BiLevel coach', (l) => goBiLevel(0, l), [-11, 11]),
  goCab: () => def('go-cab', 'GO BiLevel cab car (cab at rear)', (l) => goBiLevel(-1, l), [-11, 11]),
  goCabF: () => def('go-cab-f', 'GO BiLevel cab car (cab leading)', (l) => goBiLevel(1, l), [-11, 11]),
  upCabF: () => def('up-cab-f', 'UP Express DMU cab car (leading)', (l) => upDmu(1, l), [-9, 9]),
  upMid: () => def('up-mid', 'UP Express DMU intermediate', (l) => upDmu(0, l), [-9, 9]),
  upCabR: () => def('up-cab-r', 'UP Express DMU cab car (trailing)', (l) => upDmu(-1, l), [-9, 9]),
  charger: () => def('via-charger', 'VIA Siemens Charger SCV-42', (l) => viaCharger(l), [-6.2, 6.2]),
  venture: () => def('via-venture', 'VIA Siemens Venture coach', (l) => viaVenture(0, l), [-9.3, 9.3]),
  ventureCab: () => def('via-venture-cab', 'VIA Venture cab car (cab at rear)', (l) => viaVenture(-1, l), [-9.3, 9.3]),
  bus: () => def('bus-40', 'Nova LFS 40\'', (l) => novaBus('rigid', l), [BUS_LEN.rigid / 2 - 8.65, BUS_LEN.rigid / 2 - 2.45]),
  busArticF: () => def('bus-artic-f', 'Nova LFS Artic front section', (l) => novaBus('artic-front', l), [BUS_LEN['artic-front'] / 2 - 8.65, BUS_LEN['artic-front'] / 2 - 2.45]),
  busArticR: () => def('bus-artic-r', 'Nova LFS Artic rear section', (l) => novaBus('artic-rear', l), [0.17, 0.17]),
};

// ------------------------------------------------------------------ consists
const rep = <T,>(n: number, f: () => T) => Array.from({ length: n }, f);

function subway(short: string): ConsistSpec {
  const n = short === '4' ? 4 : 6;
  const t = short === '2';
  const cars = t
    ? [CARS.t1CabF(), ...rep(n - 2, CARS.t1Mid), CARS.t1CabR()]
    : [CARS.trCabF(), ...rep(n - 2, CARS.trMid), CARS.trCabR()];
  return { cars, gaps: rep(n - 1, () => 0.15), articulated: false, bogies: [-8, 8] };
}

function lrtUnit(k: LrtKind, mods: LrtModule[]): CarSpec[] {
  return mods.map((m) => CARS.lrt(k, m));
}

export function consistFor(mode: TransitMode, route?: { agency: string; short: string }): ConsistSpec {
  const agency = route?.agency?.toLowerCase() ?? '';
  const short = (route?.short ?? '').trim().toUpperCase();
  switch (mode) {
    case 'subway':
      return subway(short);
    case 'streetcar': {
      const mods: FlexityModule[] = ['A-front', 'B', 'C', 'B', 'A-back'];
      return { cars: mods.map(CARS.flexity), gaps: rep(4, () => 0.06), articulated: true, bogies: [0, 0] };
    }
    case 'lrt': {
      if (short === '6' || agency === 'miway' || (agency === 'metrolinx' && short === '10')) {
        const mods: LrtModule[] = ['A-front', 'B', 'C', 'B', 'C', 'B', 'A-back'];
        return { cars: lrtUnit('citadis', mods), gaps: rep(6, () => 0.06), articulated: true, bogies: [0, 0] };
      }
      const unit: LrtModule[] = ['A-front', 'B', 'C', 'B', 'A-back'];
      const units = short === '5' ? 2 : 1;
      const cars: CarSpec[] = [];
      const gaps: number[] = [];
      for (let u = 0; u < units; u++) {
        if (u) gaps.push(0.9); // coupler between units
        cars.push(...lrtUnit('freedom', unit));
        gaps.push(...rep(4, () => 0.06));
      }
      return { cars, gaps: gaps.slice(0, cars.length - 1), articulated: true, bogies: [0, 0] };
    }
    case 'commuter_rail': {
      const coaches = short === 'RH' || short === 'ST' ? 10 : 12;
      const cars = [CARS.mp40(), ...rep(coaches - 1, CARS.biLevel), CARS.goCab()];
      return { cars, gaps: rep(cars.length - 1, () => 0.25), articulated: false, bogies: [-11, 11] };
    }
    case 'airport_rail': {
      const cars = [CARS.upCabF(), CARS.upMid(), CARS.upCabR()];
      return { cars, gaps: [0.3, 0.3], articulated: false, bogies: [-9, 9] };
    }
    case 'intercity_rail': {
      const cars = [CARS.charger(), ...rep(4, CARS.venture), CARS.ventureCab()];
      return { cars, gaps: rep(cars.length - 1, () => 0.3), articulated: false, bogies: [-9.3, 9.3] };
    }
    case 'bus':
    default:
      if (isArtic(agency, short)) {
        return { cars: [CARS.busArticF(), CARS.busArticR()], gaps: [0.6], articulated: true, bogies: CARS.bus().bogies };
      }
      return { cars: [CARS.bus()], gaps: [], articulated: false, bogies: CARS.bus().bogies };
  }
}

// high-frequency trunk routes run with 18 m artics
const ARTIC: Record<string, (s: string) => boolean> = {
  ttc: (s) => ['7', '29', '35', '36', '41', '52', '84', '85', '95', '96', '939'].includes(s) || /^9\d\d$/.test(s),
  miway: (s) => ['103', '107', '109', '110'].includes(s),
  brampton: (s) => /^5\d\d$/.test(s), // Züm
  yrt: (s) => /^(60\d|VIVA|BLUE|PURPLE|ORANGE|GREEN|PINK|YELLOW)/.test(s),
  drt: (s) => s === '900' || s === '901' || s.startsWith('PULSE'),
  hsr: (s) => s === '10' || s === '1',
  grt: (s) => s === '301' || s === '302',
};
function isArtic(agency: string, short: string) {
  return !!ARTIC[agency]?.(short);
}

/** Every distinct car (for galleries / preloading). */
export function allCars(): CarSpec[] {
  const fm: FlexityModule[] = ['A-front', 'B', 'C', 'A-back'];
  const lm: LrtModule[] = ['A-front', 'B', 'C', 'A-back'];
  return [
    CARS.trCabF(), CARS.trMid(), CARS.trCabR(), CARS.t1CabF(), CARS.t1Mid(), CARS.t1CabR(),
    ...fm.map(CARS.flexity), ...lm.map((m) => CARS.lrt('freedom', m)), ...lm.map((m) => CARS.lrt('citadis', m)),
    CARS.mp40(), CARS.biLevel(), CARS.goCab(), CARS.goCabF(), CARS.upCabF(), CARS.upMid(), CARS.upCabR(),
    CARS.charger(), CARS.venture(), CARS.ventureCab(), CARS.bus(), CARS.busArticF(), CARS.busArticR(),
  ];
}

/** Total length of a consist (m). */
export function consistLength(c: ConsistSpec): number {
  return c.cars.reduce((a, s) => a + s.size[0], 0) + c.gaps.reduce((a, g) => a + g, 0);
}

export { FLEXITY_LEN, LRT_LEN };
