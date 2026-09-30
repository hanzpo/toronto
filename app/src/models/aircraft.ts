// Airliner specs (to scale) + cached instanced geometry. Dimensions and their
// sources: app/src/models/AIRCRAFT_REFERENCE.md. Geometry: ./aircraftBuilder.ts.
//
// Frame (metres): +x forward, +y up, +z right (starboard). Origin = the main
// landing-gear contact point on the ground, so the plane pitches about its
// main gear on rotation / flare and sits on the ground at y = 0.
// All `x` values in a spec are measured aft from the nose tip.
import * as THREE from 'three/webgpu';
import { buildAircraft, type AircraftPoints, type Cockpit } from './aircraftBuilder';
import { NOSES, NOSE_OF } from './aircraftNoses';

export { PART, ANIM, type AircraftPoints } from './aircraftBuilder';

export type TipDevice = 'none' | 'raked' | 'blended' | 'sharklet' | 'split' | 'curved' | 'small';

export interface AircraftSpec {
  code: string;
  name: string;
  length: number;
  span: number;
  /** tail-fin top above ground (gear down) */
  height: number;
  cls: 'turboprop' | 'regional' | 'narrow' | 'wide';
  /** approach reference speed m/s, takeoff rotate speed m/s */
  vref: number;
  vr: number;
  freighter?: boolean;
  fus: {
    /** fuselage length (nose tip → tail cone) when the overall length is measured to the stabiliser tip */
    len?: number;
    /** external width / height */
    w: number; h: number;
    /** fuselage bottom above ground at the main gear */
    belly: number;
    /** nose tip → constant section, tail cone length */
    nose: number; tail: number;
    /** nose tip height (× half height, from the centre line) */
    tipY: number;
    /** nose superellipse exponents: top line, bottom line, plan view (2 = round) */
    noseShape: [number, number, number];
    /** tail-cone end: centre height (× half height) and radius (× half height) */
    endY: number; endR: number;
    /** exponent of the tail top-line drop (higher = stays level longer) */
    tailTop: number;
    /** explicit nose profile (overrides tipY / noseShape): crown / keel heights (× half height from the
     *  centre line) and half widths (× half width) at stations T (fraction of `nose`, default PROF_T) */
    prof?: { T?: number[]; top: number[]; bot: number[]; w: number[] };
  };
  wing: {
    /** root leading edge (at the fuselage side) from the nose */
    x: number;
    root: number; tip: number;
    /** leading-edge sweep (deg), dihedral (deg) */
    sweep: number; dih: number;
    /** trailing-edge kink as a fraction of the exposed half span (0 = straight TE); inboard TE sweep (deg) */
    kink: number; teSweepIn: number;
    /** thickness / chord at the root */
    tc: number;
    /** root chord-line height relative to the fuselage centre (× half height), low wings */
    y: number;
    high?: boolean;
    tipDev: TipDevice;
    /** tip-device height / sweep (deg) / cant from vertical (deg) */
    tipH: number; tipSweep?: number; tipCant?: number;
  };
  eng: {
    kind: 'fan' | 'prop'; mount: 'wing' | 'aft';
    /** nacelle max diameter, length (lip → nozzle) */
    d: number; len: number;
    /** intake lip from the nose; lateral position from the centre line; centre height above ground (optional) */
    x: number; z: number; y?: number;
    /** flattened lower lip (737NG / MAX), chevron nozzle (787 / MAX), short fan cowl (mixed / CF6), core cowl radius */
    flat?: boolean; chevron?: boolean; short?: boolean; core?: number;
    prop?: { d: number; blades: number };
  };
  fin: {
    /** root leading edge from the nose, root / tip chord, LE sweep (deg) */
    x: number; root: number; tip: number; sweep: number;
    t?: boolean; tc?: number;
    /** dorsal fillet length ahead of the fin root (m) */
    dorsal?: number;
  };
  hs: {
    span: number; root: number; tip: number; sweep: number; dih: number;
    /** root LE from the nose; root height (× local half height from the centre line) */
    x: number; y: number;
  };
  gear: {
    /** nose gear from the nose tip, wheelbase, main track, wheels per main leg, main / nose tyre diameter */
    nose: number; base: number; track: number; main: 2 | 4 | 6; tyre: number; noseTyre: number;
    /** main gear retraction */
    retract: 'in' | 'fwd' | 'aft';
    /** main wells closed by doors (737: no, wheels sit exposed in the belly) */
    doors: boolean;
    /** main gear in fuselage-side sponsons (ATR) */
    sponson?: boolean;
  };
  /** doors (x from the nose to the door centre, width, kind): P passenger (both sides), O overwing exit,
   *  C lower-deck cargo (right), M main-deck cargo (left, freighters) */
  doors: [number, number, 'P' | 'O' | 'C' | 'M'][];
  /** cabin windows: first / last window centre from the nose, pitch, half width / height, row centre above the fuselage centre line (m) */
  win: { from: number; to: number; pitch: number; hw: number; hh: number; y: number };
  cockpit: Cockpit;
  /** windshield lower front point: station from the nose, height above the centre line (m), pane size scale */
  ck: [number, number, number];
  /** explicit right-side cockpit panes (overrides the style): corners [station from the nose, height above the
   *  centre line (m) | null = on the nose crown], ordered front-bottom, rear-bottom, rear-top, front-top */
  panes?: [number, number | null][][];
}

type Part<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };
function merge(base: AircraftSpec, o: Part<AircraftSpec>): AircraftSpec {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    const bv = (base as unknown as Record<string, unknown>)[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && bv && typeof bv === 'object' ? { ...bv, ...v } : v;
  }
  return out as unknown as AircraftSpec;
}

// ------------------------------------------------------------------ families
// Numbers: AIRCRAFT_REFERENCE.md (S = manufacturer airport-planning document,
// M = measured off its drawings, E = estimate). Door x = door centre.

const A320: AircraftSpec = {
  code: 'A320', name: 'Airbus A320', length: 37.57, span: 35.8, height: 11.76, cls: 'narrow', vref: 69, vr: 75,
  fus: { w: 3.95, h: 4.14, belly: 1.73, nose: 5.8, tail: 11.8, tipY: -0.2, noseShape: [2.1, 2.4, 2.1], endY: 0.38, endR: 0.1, tailTop: 1.9,
    // measured off an A320 side photo: blunt rounded nose, tip just below the centre line
    prof: { top: [-0.15, 0.05, 0.19, 0.31, 0.48, 0.66, 0.79, 0.9, 0.97, 1], bot: [-0.15, -0.35, -0.52, -0.64, -0.76, -0.86, -0.92, -0.96, -0.99, -1], w: [0.03, 0.38, 0.56, 0.7, 0.81, 0.9, 0.95, 0.98, 0.995, 1] } },
  wing: { x: 13.1, root: 6.07, tip: 1.64, sweep: 27.5, dih: 5.1, kink: 0.28, teSweepIn: 0, tc: 0.15, y: -0.6, tipDev: 'sharklet', tipH: 2.43, tipSweep: 42 },
  eng: { kind: 'fan', mount: 'wing', d: 2.3, len: 4.5, x: 11.19, z: 5.75, y: 1.73 },
  fin: { x: 27.9, root: 6.0, tip: 2.1, sweep: 34, dorsal: 1.5 },
  hs: { span: 12.45, root: 3.6, tip: 1.35, sweep: 32, dih: 6, x: 31.6, y: 0.05 },
  gear: { nose: 5.07, base: 12.64, track: 7.59, main: 2, tyre: 1.17, noseTyre: 0.76, retract: 'in', doors: true },
  doors: [[5.4, 0.81, 'P'], [14.7, 0.51, 'O'], [15.55, 0.51, 'O'], [29.9, 0.81, 'P'], [9.0, 1.8, 'C'], [23.5, 1.8, 'C']],
  win: { from: 6.4, to: 28.9, pitch: 0.533, hw: 0.115, hh: 0.165, y: 0.42 },
  cockpit: 'airbus', ck: [1.5, 0.45, 1.12],
  // 6-pane cockpit: V-shaped lower windshield line, DV window, notched rear pane
  panes: [
    [[1.25, null], [1.85, 0.58], [2.4, 1.2], [1.95, null]],
    [[1.95, 0.58], [2.58, 0.6], [2.58, 1.16], [2.12, 1.2]],
    [[2.66, 0.6], [3.12, 0.62], [2.98, 1.08], [2.66, 1.14]],
  ],
};

const B738: AircraftSpec = {
  code: 'B738', name: 'Boeing 737-800', length: 39.47, span: 35.79, height: 12.55, cls: 'narrow', vref: 72, vr: 78,
  fus: { len: 39.18, w: 3.76, h: 4.01, belly: 1.35, nose: 6.2, tail: 11.7, tipY: -0.3, noseShape: [1.7, 2.3, 1.8], endY: 0.5, endR: 0.1, tailTop: 1.7,
    // measured off a 737-800 side photo: pointed nose on the centre line, long drooping chin
    prof: { top: [-0.03, 0.1, 0.24, 0.38, 0.54, 0.68, 0.8, 0.9, 0.96, 1], bot: [-0.03, -0.17, -0.27, -0.4, -0.55, -0.7, -0.8, -0.89, -0.95, -1], w: [0.03, 0.3, 0.47, 0.62, 0.75, 0.86, 0.93, 0.97, 0.99, 1] } },
  wing: { x: 15.06, root: 6.3, tip: 1.6, sweep: 28.8, dih: 6, kink: 0.23, teSweepIn: 0, tc: 0.15, y: -0.62, tipDev: 'blended', tipH: 2.44, tipSweep: 50 },
  eng: { kind: 'fan', mount: 'wing', d: 2.0, len: 4.3, x: 13.36, z: 4.83, y: 1.32, flat: true, short: true },
  fin: { x: 30.9, root: 6.2, tip: 2.0, sweep: 38, dorsal: 4.0 },
  hs: { span: 14.35, root: 3.9, tip: 1.2, sweep: 33, dih: 7, x: 32.6, y: 0.05 },
  gear: { nose: 4.09, base: 15.6, track: 5.72, main: 2, tyre: 1.14, noseTyre: 0.69, retract: 'in', doors: false },
  doors: [[5.03, 0.86, 'P'], [16.71, 0.51, 'O'], [17.68, 0.51, 'O'], [31.88, 0.76, 'P'], [8.53, 1.2, 'C'], [27.97, 1.2, 'C']],
  win: { from: 6.1, to: 30.8, pitch: 0.508, hw: 0.115, hh: 0.165, y: 0.4 },
  cockpit: 'boeing', ck: [1.7, 0.4, 1.1],
  // 3 panes per side, flat lower line, aft pane with a slanted trailing edge
  panes: [
    [[1.15, null], [2.35, 0.8], [2.4, 1.28], [1.9, null]],
    [[2.42, 0.8], [2.9, 0.8], [2.9, 1.32], [2.45, 1.3]],
    [[2.98, 0.8], [3.62, 0.82], [3.4, 1.28], [2.98, 1.34]],
  ],
};

const A333: AircraftSpec = {
  code: 'A333', name: 'Airbus A330-300', length: 63.69, span: 60.3, height: 16.79, cls: 'wide', vref: 70, vr: 80,
  fus: { w: 5.64, h: 5.64, belly: 2.5, nose: 8.5, tail: 18.5, tipY: -0.22, noseShape: [2.1, 2.4, 2.1], endY: 0.35, endR: 0.09, tailTop: 2.2 },
  wing: { x: 22.8, root: 10.56, tip: 2.51, sweep: 31.5, dih: 4.5, kink: 0.3, teSweepIn: 0, tc: 0.14, y: -0.55, tipDev: 'small', tipH: 2.74, tipSweep: 45 },
  eng: { kind: 'fan', mount: 'wing', d: 3.1, len: 6.8, x: 21.3, z: 9.37, y: 2.35 },
  fin: { x: 54.1, root: 6.1, tip: 3.1, sweep: 38, dorsal: 1.7 },
  hs: { span: 19.4, root: 7.2, tip: 2.03, sweep: 38, dih: 6, x: 55.8, y: 0.0 },
  gear: { nose: 6.67, base: 25.38, track: 10.68, main: 4, tyre: 1.27, noseTyre: 1.05, retract: 'in', doors: true },
  doors: [[6.3, 1.07, 'P'], [18.2, 1.07, 'P'], [36.3, 0.76, 'P'], [51.4, 1.07, 'P'], [10.9, 2.7, 'C'], [45.7, 2.7, 'C']],
  win: { from: 7.6, to: 50.2, pitch: 0.533, hw: 0.12, hh: 0.17, y: 0.45 },
  cockpit: 'airbus', ck: [2.2, 0.95, 1.18],
};

const B789: AircraftSpec = {
  code: 'B789', name: 'Boeing 787-9', length: 62.81, span: 60.12, height: 17.02, cls: 'wide', vref: 74, vr: 82,
  fus: { len: 62.0, w: 5.77, h: 5.94, belly: 2.2, nose: 8.4, tail: 20.0, tipY: -0.25, noseShape: [1.75, 2.3, 1.9], endY: 0.3, endR: 0.09, tailTop: 2.0 },
  wing: { x: 21.4, root: 12.4, tip: 2.67, sweep: 35.4, dih: 6.5, kink: 0.27, teSweepIn: 0, tc: 0.13, y: -0.6, tipDev: 'raked', tipH: 0 },
  eng: { kind: 'fan', mount: 'wing', d: 3.5, len: 7.0, x: 20.8, z: 9.91, y: 2.5, chevron: true },
  fin: { x: 51.0, root: 8.0, tip: 2.1, sweep: 40, dorsal: 2.0 },
  hs: { span: 19.81, root: 6.4, tip: 1.5, sweep: 38, dih: 6, x: 54.6, y: 0.0 },
  gear: { nose: 5.41, base: 25.83, track: 9.8, main: 4, tyre: 1.32, noseTyre: 1.02, retract: 'in', doors: true },
  doors: [[6.3, 1.07, 'P'], [18.36, 1.07, 'P'], [35.43, 1.07, 'P'], [49.66, 1.07, 'P'], [11.0, 2.7, 'C'], [43.31, 2.7, 'C']],
  win: { from: 7.6, to: 48.4, pitch: 0.61, hw: 0.135, hh: 0.235, y: 0.45 },
  cockpit: 'b787', ck: [2.4, 0.8, 1.2],
};

// ------------------------------------------------------------------ types

export const AIRCRAFT: Record<string, AircraftSpec> = {
  DH8D: {
    code: 'DH8D', name: 'De Havilland Dash 8-400', length: 32.83, span: 28.42, height: 8.3, cls: 'turboprop', vref: 60, vr: 58,
    fus: { len: 31.04, w: 2.69, h: 2.6, belly: 0.87, nose: 4.4, tail: 9.5, tipY: -0.1, noseShape: [1.6, 2.0, 1.7], endY: 0.5, endR: 0.12, tailTop: 1.5,
      // measured off a Porter Q400 side photo: long wedge nose, low sharp tip, flat chin
      prof: { top: [-0.76, -0.61, -0.47, -0.29, -0.06, 0.24, 0.56, 0.85, 0.96, 1], bot: [-0.76, -0.88, -0.94, -0.98, -1, -1, -1, -1, -1, -1], w: [0.03, 0.3, 0.47, 0.61, 0.74, 0.85, 0.92, 0.97, 0.995, 1] } },
    wing: { x: 13.7, root: 2.9, tip: 1.3, sweep: 3, dih: 2.5, kink: 0, teSweepIn: 0, tc: 0.18, y: 0.9, high: true, tipDev: 'none', tipH: 0 },
    eng: { kind: 'prop', mount: 'wing', d: 1.35, len: 8.4, x: 11.1, z: 4.4, y: 3.08, prop: { d: 4.11, blades: 6 } },
    fin: { x: 25.0, root: 4.6, tip: 3.2, sweep: 30, t: true, tc: 0.12, dorsal: 2.5 },
    hs: { span: 9.27, root: 2.6, tip: 1.3, sweep: 15, dih: 0, x: 29.6, y: 0 },
    gear: { nose: 1.8, base: 13.99, track: 8.8, main: 2, tyre: 0.99, noseTyre: 0.56, retract: 'aft', doors: true },
    doors: [[5.3, 0.76, 'P'], [22.2, 0.61, 'P'], [7.5, 1.1, 'C']],
    win: { from: 6.5, to: 21.3, pitch: 0.79, hw: 0.14, hh: 0.19, y: 0.28 },
    cockpit: 'q400', ck: [1.65, 0.25, 1.0],
    panes: [
      [[1.68, null], [2.3, 0.31], [2.46, 0.8], [2.42, null]],
      [[2.37, 0.31], [2.95, 0.31], [2.95, 0.82], [2.52, 0.81]],
      [[3.01, 0.31], [3.32, 0.31], [3.27, 0.76], [3.01, 0.8]],
    ],
  },
  AT76: {
    code: 'AT76', name: 'ATR 72-600', length: 27.17, span: 27.05, height: 7.65, cls: 'turboprop', vref: 57, vr: 55,
    fus: { w: 2.865, h: 2.865, belly: 0.85, nose: 3.4, tail: 8.0, tipY: -0.2, noseShape: [2, 2, 2], endY: 0.5, endR: 0.12, tailTop: 1.5,
      // short blunt snub nose, windscreen low and forward under a brow (E: photos / general arrangement)
      prof: { top: [-0.28, -0.02, 0.2, 0.4, 0.52, 0.72, 0.87, 0.95, 0.99, 1], bot: [-0.28, -0.52, -0.68, -0.8, -0.9, -0.96, -0.99, -1, -1, -1], w: [0.03, 0.4, 0.58, 0.72, 0.83, 0.91, 0.96, 0.99, 1, 1] } },
    wing: { x: 11.2, root: 2.57, tip: 1.41, sweep: 3, dih: 2, kink: 0, teSweepIn: 0, tc: 0.18, y: 0.9, high: true, tipDev: 'none', tipH: 0 },
    eng: { kind: 'prop', mount: 'wing', d: 1.15, len: 4.6, x: 9.3, z: 4.1, y: 3.0, prop: { d: 3.93, blades: 6 } },
    fin: { x: 20.6, root: 4.2, tip: 2.1, sweep: 34, tc: 0.12, dorsal: 3.0 },
    hs: { span: 7.31, root: 2.0, tip: 1.1, sweep: 12, dih: 0, x: 23.6, y: 0.85 },
    gear: { nose: 2.0, base: 10.77, track: 4.1, main: 2, tyre: 0.85, noseTyre: 0.45, retract: 'in', doors: false, sponson: true },
    doors: [[3.6, 1.27, 'P'], [24.3, 0.72, 'P']],
    win: { from: 5.3, to: 22.6, pitch: 0.66, hw: 0.13, hh: 0.18, y: 0.3 },
    cockpit: 'q400', ck: [1.2, 0.1, 0.9],
    panes: [
      [[1.02, null], [1.6, 0.08], [1.78, 0.48], [1.45, null]],
      [[1.68, 0.08], [2.1, 0.08], [2.06, 0.5], [1.84, 0.52]],
      [[2.16, 0.12], [2.42, 0.12], [2.36, 0.44], [2.16, 0.47]],
    ],
  },
  CRJ9: {
    code: 'CRJ9', name: 'Bombardier CRJ900', length: 36.24, span: 24.85, height: 7.35, cls: 'regional', vref: 70, vr: 72,
    fus: { w: 2.69, h: 2.69, belly: 0.85, nose: 5.5, tail: 8.2, tipY: -0.2, noseShape: [1.5, 1.9, 1.6], endY: 0.4, endR: 0.14, tailTop: 1.8 },
    wing: { x: 16.2, root: 4.85, tip: 1.89, sweep: 29, dih: 3, kink: 0.28, teSweepIn: 0, tc: 0.13, y: -0.55, tipDev: 'small', tipH: 1.3, tipSweep: 45 },
    eng: { kind: 'fan', mount: 'aft', d: 1.53, len: 3.9, x: 25.51, z: 2.29, y: 3.5 },
    fin: { x: 29.7, root: 4.4, tip: 2.7, sweep: 47, t: true, tc: 0.12, dorsal: 1.0 },
    hs: { span: 8.54, root: 2.3, tip: 1.1, sweep: 33, dih: -2, x: 34.5, y: 0 },
    gear: { nose: 2.1, base: 17.3, track: 4.07, main: 2, tyre: 0.9, noseTyre: 0.6, retract: 'in', doors: false },
    doors: [[4.67, 0.91, 'P'], [16.96, 0.51, 'O'], [18.0, 0.51, 'O'], [9.8, 0.9, 'C'], [12.7, 0.9, 'C']],
    win: { from: 5.6, to: 26.5, pitch: 0.7, hw: 0.12, hh: 0.17, y: 0.2 },
    cockpit: 'crj', ck: [1.85, 0.3, 0.95],
  },
  E75L: {
    code: 'E75L', name: 'Embraer 175', length: 31.68, span: 28.65, height: 9.86, cls: 'regional', vref: 66, vr: 68,
    fus: { w: 3.01, h: 3.35, belly: 1.25, nose: 5.0, tail: 7.5, tipY: -0.22, noseShape: [2.0, 2.3, 2.0], endY: 0.4, endR: 0.12, tailTop: 1.8 },
    wing: { x: 11.5, root: 5.4, tip: 1.2, sweep: 27, dih: 5, kink: 0.3, teSweepIn: 0, tc: 0.14, y: -0.55, tipDev: 'blended', tipH: 1.9, tipSweep: 45 },
    eng: { kind: 'fan', mount: 'wing', d: 1.45, len: 4.0, x: 10.3, z: 3.7, y: 1.2 },
    fin: { x: 24.0, root: 4.5, tip: 1.9, sweep: 40, dorsal: 2.2 },
    hs: { span: 10.0, root: 3.0, tip: 1.1, sweep: 33, dih: 6, x: 27.4, y: 0.2 },
    gear: { nose: 4.13, base: 11.4, track: 5.2, main: 2, tyre: 0.99, noseTyre: 0.61, retract: 'in', doors: false },
    doors: [[4.7, 0.87, 'P'], [23.4, 0.71, 'P'], [8.2, 1.1, 'C'], [20.5, 1.0, 'C']],
    win: { from: 6.0, to: 22.6, pitch: 0.87, hw: 0.14, hh: 0.2, y: 0.42 },
    cockpit: 'ejet', ck: [1.4, 0.4, 1.05],
  },
  E295: {
    code: 'E295', name: 'Embraer 195-E2', length: 41.6, span: 35.12, height: 10.78, cls: 'narrow', vref: 68, vr: 72,
    fus: { w: 3.01, h: 3.35, belly: 1.3, nose: 5.0, tail: 8.5, tipY: -0.22, noseShape: [2.0, 2.3, 2.0], endY: 0.4, endR: 0.12, tailTop: 1.8 },
    wing: { x: 15.2, root: 6.1, tip: 1.3, sweep: 28, dih: 5, kink: 0.28, teSweepIn: 0, tc: 0.14, y: -0.55, tipDev: 'raked', tipH: 0 },
    eng: { kind: 'fan', mount: 'wing', d: 2.4, len: 4.3, x: 12.4, z: 4.85, y: 1.64 },
    fin: { x: 33.0, root: 5.0, tip: 2.0, sweep: 43, dorsal: 2.2 },
    hs: { span: 10.0, root: 3.3, tip: 1.2, sweep: 33, dih: 6, x: 36.8, y: 0.2 },
    gear: { nose: 4.55, base: 15.71, track: 6.73, main: 2, tyre: 1.1, noseTyre: 0.66, retract: 'in', doors: true },
    doors: [[4.7, 0.87, 'P'], [33.3, 0.71, 'P'], [7.3, 1.1, 'C'], [28.5, 1.0, 'C']],
    win: { from: 6.0, to: 32.4, pitch: 0.87, hw: 0.14, hh: 0.2, y: 0.42 },
    cockpit: 'ejet', ck: [1.4, 0.4, 1.05],
  },
  BCS3: {
    code: 'BCS3', name: 'Airbus A220-300', length: 38.71, span: 35.1, height: 11.6, cls: 'narrow', vref: 67, vr: 72,
    fus: { w: 3.505, h: 3.72, belly: 1.85, nose: 5.5, tail: 12.0, tipY: -0.2, noseShape: [1.75, 2.3, 1.9], endY: 0.35, endR: 0.11, tailTop: 1.9 },
    wing: { x: 13.04, root: 6.8, tip: 1.5, sweep: 29, dih: 5, kink: 0.28, teSweepIn: 0, tc: 0.14, y: -0.6, tipDev: 'small', tipH: 1.55, tipCant: 45, tipSweep: 45 },
    eng: { kind: 'fan', mount: 'wing', d: 2.3, len: 4.4, x: 12.17, z: 5.45, y: 1.77 },
    fin: { x: 31.5, root: 5.0, tip: 1.8, sweep: 40, dorsal: 2.2 },
    hs: { span: 12.26, root: 3.6, tip: 1.3, sweep: 40, dih: 6, x: 32.9, y: 0.05 },
    gear: { nose: 3.39, base: 15.31, track: 6.73, main: 2, tyre: 1.1, noseTyre: 0.7, retract: 'in', doors: false },
    doors: [[5.1, 0.8, 'P'], [15.5, 0.51, 'O'], [29.86, 0.8, 'P'], [7.05, 1.1, 'C'], [25.4, 1.1, 'C']],
    win: { from: 6.2, to: 28.8, pitch: 0.55, hw: 0.14, hh: 0.205, y: 0.35 },
    cockpit: 'a220', ck: [1.55, 0.4, 1.1],
  },
  A319: merge(A320, { code: 'A319', name: 'Airbus A319', length: 33.84, span: 34.1,
    wing: { x: 11.5, tipDev: 'small', tipH: 0.95, tipCant: 0 }, eng: { x: 9.59 }, fin: { x: 24.2 }, hs: { x: 27.9 },
    gear: { base: 11.04 }, doors: [[5.4, 0.81, 'P'], [13.1, 0.51, 'O'], [13.95, 0.51, 'O'], [26.2, 0.81, 'P'], [9.0, 1.8, 'C'], [21.4, 1.8, 'C']],
    win: { to: 25.2 } }),
  A320: A320,
  A20N: merge(A320, { code: 'A20N', name: 'Airbus A320neo', eng: { d: 2.55, len: 4.9, x: 11.14, y: 1.74, short: true } }),
  A321: merge(A320, { code: 'A321', name: 'Airbus A321', length: 44.51, vref: 72, vr: 78,
    wing: { x: 17.4, root: 6.4 }, eng: { x: 15.46 }, fin: { x: 34.85 }, hs: { x: 38.5 },
    gear: { base: 16.9 }, doors: [[5.4, 0.81, 'P'], [14.2, 0.76, 'P'], [25.2, 0.76, 'P'], [36.9, 0.81, 'P'], [9.0, 1.8, 'C'], [30.5, 1.8, 'C']],
    win: { to: 35.9 } }),
  A21N: merge(A320, { code: 'A21N', name: 'Airbus A321neo', length: 44.51, vref: 72, vr: 78,
    wing: { x: 17.4, root: 6.4 }, eng: { d: 2.55, len: 4.9, x: 15.4, y: 1.74, short: true }, fin: { x: 34.85 }, hs: { x: 38.5 },
    gear: { base: 16.9 }, doors: [[5.4, 0.81, 'P'], [18.95, 0.51, 'O'], [19.8, 0.51, 'O'], [36.8, 0.81, 'P'], [9.4, 1.8, 'C'], [30.9, 1.8, 'C']],
    win: { to: 35.9 } }),
  B737: merge(B738, { code: 'B737', name: 'Boeing 737-700', length: 33.63, vref: 70, vr: 75,
    fus: { len: 33.4 }, wing: { x: 12.0 }, eng: { x: 10.36 }, fin: { x: 25.1 }, hs: { x: 26.8 },
    gear: { base: 12.6 }, doors: [[5.03, 0.86, 'P'], [14.2, 0.51, 'O'], [26.04, 0.76, 'P'], [8.53, 1.2, 'C'], [22.1, 1.2, 'C']],
    win: { to: 25.0 } }),
  B738: B738,
  B38M: merge(B738, { code: 'B38M', name: 'Boeing 737 MAX 8', span: 35.92, height: 12.45,
    fus: { len: 39.12, tail: 12.2, endY: 0.42, endR: 0.08 },
    eng: { d: 2.2, len: 4.7, x: 13.0, y: 1.58, flat: false, chevron: true, short: true },
    wing: { tipDev: 'split', tipH: 2.0 } }),
  B39M: merge(B738, { code: 'B39M', name: 'Boeing 737 MAX 9', length: 42.16, span: 35.92, height: 12.4, vref: 73, vr: 79,
    fus: { len: 41.76, tail: 12.2, endY: 0.42, endR: 0.08 },
    eng: { d: 2.2, len: 4.7, x: 14.58, y: 1.58, flat: false, chevron: true, short: true },
    wing: { x: 16.6, tipDev: 'split', tipH: 2.0 }, fin: { x: 33.5 }, hs: { x: 35.2 }, gear: { base: 17.17 },
    doors: [[5.03, 0.86, 'P'], [18.29, 0.51, 'O'], [19.25, 0.51, 'O'], [34.52, 0.76, 'P'], [8.53, 1.2, 'C'], [30.61, 1.2, 'C']],
    win: { to: 33.4 } }),
  B752: merge(B738, { code: 'B752', name: 'Boeing 757-200F', length: 47.32, span: 38.05, height: 13.6, vref: 70, vr: 76, freighter: true,
    fus: { len: 47.32, belly: 2.0, nose: 6.0, tail: 12.5, noseShape: [1.7, 2.3, 1.8], endY: 0.4, endR: 0.09 },
    wing: { x: 18.1, root: 8.3, tip: 2.0, sweep: 28, kink: 0.28, tipDev: 'none', tipH: 0 },
    eng: { d: 2.5, len: 5.9, x: 16.84, z: 6.48, y: 2.0, flat: false, short: false },
    fin: { x: 37.2, root: 6.95, tip: 2.43, sweep: 42, dorsal: 1.2 }, hs: { span: 15.21, root: 4.98, tip: 1.64, sweep: 31, x: 40.5 },
    gear: { nose: 5.89, base: 18.29, track: 7.32, main: 4, tyre: 1.14, noseTyre: 0.74, doors: true },
    doors: [[3.86, 0.56, 'P'], [9.93, 3.4, 'M'], [10.95, 1.4, 'C'], [31.78, 1.4, 'C']],
    win: { from: 0, to: 0 }, cockpit: 'b757', ck: [1.85, 0.45, 1.12] }),
  B763: {
    code: 'B763', name: 'Boeing 767-300F', length: 54.94, span: 47.57, height: 15.9, cls: 'wide', vref: 72, vr: 80, freighter: true,
    fus: { w: 5.03, h: 5.41, belly: 2.1, nose: 7.2, tail: 16.0, tipY: -0.25, noseShape: [1.75, 2.3, 1.85], endY: 0.35, endR: 0.09, tailTop: 1.9 },
    wing: { x: 18.3, root: 11.0, tip: 2.29, sweep: 34.5, dih: 6, kink: 0.3, teSweepIn: 0, tc: 0.15, y: -0.6, tipDev: 'none', tipH: 0 },
    eng: { kind: 'fan', mount: 'wing', d: 2.9, len: 6.4, x: 18.54, z: 7.92, y: 2.3, short: true },
    fin: { x: 43.6, root: 7.84, tip: 2.4, sweep: 42, dorsal: 1.6 },
    hs: { span: 18.62, root: 6.95, tip: 1.39, sweep: 35, dih: 7, x: 46.8, y: 0.0 },
    gear: { nose: 4.55, base: 22.76, track: 9.3, main: 4, tyre: 1.17, noseTyre: 0.94, retract: 'in', doors: true },
    doors: [[5.7, 1.07, 'P'], [11.93, 3.4, 'M'], [14.5, 1.75, 'C'], [42.5, 1.75, 'C']],
    win: { from: 0, to: 0, pitch: 0.51, hw: 0.12, hh: 0.17, y: 0.45 },
    cockpit: 'b757', ck: [2.1, 0.75, 1.18],
  },
  B788: merge(B789, { code: 'B788', name: 'Boeing 787-8', length: 56.72, height: 16.92, vref: 72, vr: 80,
    fus: { len: 55.91 }, wing: { x: 18.4 }, eng: { x: 17.76, z: 9.73 }, fin: { x: 45.0 }, hs: { x: 48.6 }, gear: { base: 22.78 },
    doors: [[6.3, 1.07, 'P'], [15.32, 1.07, 'P'], [32.39, 1.07, 'P'], [43.56, 1.07, 'P'], [11.0, 2.7, 'C'], [37.5, 2.7, 'C']],
    win: { to: 42.3 } }),
  B789: B789,
  A333: A333,
  A339: merge(A333, { code: 'A339', name: 'Airbus A330-900', span: 64.0, eng: { d: 3.7, len: 7.1, x: 21.05, y: 2.52 },
    wing: { tipDev: 'curved', tipH: 3.6, tipSweep: 40 } }),
  A359: {
    code: 'A359', name: 'Airbus A350-900', length: 66.8, span: 64.75, height: 17.05, cls: 'wide', vref: 72, vr: 80,
    fus: { len: 65.26, w: 5.96, h: 6.09, belly: 2.45, nose: 7.4, tail: 14.8, tipY: -0.3, noseShape: [1.75, 2.4, 1.9], endY: 0.39, endR: 0.09, tailTop: 1.8 },
    wing: { x: 22.4, root: 13.47, tip: 2.5, sweep: 36, dih: 5, kink: 0.27, teSweepIn: 0, tc: 0.13, y: -0.58, tipDev: 'curved', tipH: 2.4, tipSweep: 58 },
    eng: { kind: 'fan', mount: 'wing', d: 3.7, len: 6.9, x: 21.97, z: 10.5, y: 2.61 },
    fin: { x: 54.5, root: 7.79, tip: 3.04, sweep: 32.7, dorsal: 2.2 },
    hs: { span: 18.9, root: 6.2, tip: 2.46, sweep: 36, dih: 6, x: 58.2, y: 0.0 },
    gear: { nose: 4.63, base: 28.66, track: 10.6, main: 4, tyre: 1.4, noseTyre: 1.07, retract: 'in', doors: true },
    doors: [[7.3, 1.07, 'P'], [19.3, 1.07, 'P'], [38.4, 1.07, 'P'], [53.0, 1.07, 'P'], [12.4, 2.7, 'C'], [47.4, 2.7, 'C']],
    win: { from: 8.5, to: 51.8, pitch: 0.64, hw: 0.12, hh: 0.17, y: 0.5 },
    cockpit: 'a350', ck: [2.3, 0.35, 1.22],
  },
  B77W: {
    code: 'B77W', name: 'Boeing 777-300ER', length: 73.86, span: 64.8, height: 18.5, cls: 'wide', vref: 76, vr: 85,
    fus: { len: 73.08, w: 6.2, h: 6.2, belly: 2.4, nose: 9.0, tail: 22.0, tipY: -0.25, noseShape: [1.75, 2.3, 1.9], endY: 0.2, endR: 0.07, tailTop: 2.3 },
    wing: { x: 26.89, root: 13.2, tip: 1.8, sweep: 34.5, dih: 6, kink: 0.3, teSweepIn: 0, tc: 0.13, y: -0.6, tipDev: 'raked', tipH: 0 },
    eng: { kind: 'fan', mount: 'wing', d: 4.22, len: 7.3, x: 25.76, z: 9.61, y: 2.84 },
    fin: { x: 60.2, root: 8.93, tip: 2.59, sweep: 44, dorsal: 2.2 },
    hs: { span: 21.53, root: 7.3, tip: 2.19, sweep: 38, dih: 7, x: 63.4, y: 0.0 },
    gear: { nose: 5.89, base: 31.22, track: 10.97, main: 6, tyre: 1.32, noseTyre: 1.09, retract: 'in', doors: true },
    doors: [[6.74, 1.07, 'P'], [17.07, 1.07, 'P'], [32.92, 1.07, 'P'], [46.46, 1.07, 'P'], [59.67, 1.07, 'P'], [12.8, 2.7, 'C'], [52.5, 2.7, 'C']],
    win: { from: 8.1, to: 58.4, pitch: 0.56, hw: 0.125, hh: 0.19, y: 0.45 },
    cockpit: 'boeing', ck: [2.5, 1.0, 1.25],
  },
};

// apply the per-family nose profiles + cockpit panes (aircraftNoses.ts)
for (const [code, [fam, ds, dy]] of Object.entries(NOSE_OF)) {
  const a = AIRCRAFT[code], n = NOSES[fam];
  if (!a || !n) continue;
  a.fus = { ...a.fus, nose: n.nose + ds, prof: { top: n.top, bot: n.bot, w: n.w } };
  a.panes = n.panes.map((p) => p.map(([sn, y]) => [sn + ds, y === null ? null : y + dy] as [number, number | null]));
}

/** stable row index per type (shader decal / window texture rows) */
export const TYPE_CODES = Object.keys(AIRCRAFT);

// ------------------------------------------------------------------ models

export interface AircraftModel {
  spec: AircraftSpec;
  /** high detail (gear, flaps, cockpit, props) */
  geometry: THREE.BufferGeometry;
  /** far LOD (≤ ~400 triangles, no gear) */
  low: THREE.BufferGeometry;
  points: AircraftPoints;
  row: number;
}

const cache = new Map<string, AircraftModel>();

export function aircraftModel(code: string): AircraftModel {
  const k = AIRCRAFT[code] ? code : 'A320';
  let m = cache.get(k);
  if (!m) {
    const row = TYPE_CODES.indexOf(k);
    const built = buildAircraft(AIRCRAFT[k], row);
    m = { spec: AIRCRAFT[k], geometry: built.geometry, low: built.low, points: built.points, row };
    cache.set(k, m);
  }
  return m;
}

// ------------------------------------------------------------------ fuselage decal texture

/**
 * Per-type fuselage pattern rows (2 texel rows per type, 2048 wide, u = station / length):
 *  pattern row: R = 1 − |x − nearest window centre| / (pitch / 2) (0 = no window), G = door distance
 *               from its fore/aft edge / 0.6 m, B = door kind / 8 (1 P, 2 O, 3 C, 4 M)
 *  param row:   R = window half width / 0.5, G = half height / 0.5, B = pitch / 1, A = cargo door height / 4
 */
export const DECAL_W = 2048;
let decalTex: THREE.DataTexture | null = null;
export function aircraftDecalTexture(): THREE.DataTexture {
  if (decalTex) return decalTex;
  const n = TYPE_CODES.length;
  const data = new Uint8Array(DECAL_W * n * 2 * 4);
  TYPE_CODES.forEach((code, k) => {
    const s = AIRCRAFT[code];
    const L = s.fus.len ?? s.length;
    const o = k * 2 * DECAL_W * 4, op = o + DECAL_W * 4;
    const w = s.win;
    const doorAt = (x: number) => s.doors.find(([dx, dw]) => Math.abs(x - dx) < dw / 2 + 0.12);
    const wins: number[] = [];
    if (w.to > w.from) for (let x = w.from; x <= w.to + 1e-6; x += w.pitch) if (!doorAt(x) || doorAt(x)![2] === 'C') wins.push(x);
    for (let i = 0; i < DECAL_W; i++) {
      const x = ((i + 0.5) / DECAL_W) * L;
      let best = Infinity;
      for (const c of wins) best = Math.min(best, Math.abs(x - c));
      const r = best < w.pitch / 2 ? 1 - best / (w.pitch / 2) : 0;
      let g = 0, bk = 0;
      for (const [dx, dw, kind] of s.doors) {
        const inside = dw / 2 - Math.abs(x - dx);
        const kk = kind === 'P' ? 1 : kind === 'O' ? 2 : kind === 'C' ? 3 : 4;
        if (inside > -0.08 && kk !== 3) { g = Math.max(g, Math.max(0, inside) / 0.6); bk = kk; }
        else if (inside > -0.08 && bk === 0) { g = Math.max(g, Math.max(0, inside) / 0.6); bk = kk; }
      }
      data[o + i * 4] = Math.round(r * 255);
      data[o + i * 4 + 1] = Math.round(Math.min(1, g) * 255);
      data[o + i * 4 + 2] = Math.round((bk / 8) * 255);
      data[o + i * 4 + 3] = 255;
      data[op + i * 4] = Math.round(Math.min(1, w.hw / 0.5) * 255);
      data[op + i * 4 + 1] = Math.round(Math.min(1, w.hh / 0.5) * 255);
      data[op + i * 4 + 2] = Math.round(Math.min(1, w.pitch) * 255);
      data[op + i * 4 + 3] = Math.round(Math.min(1, (s.cls === 'wide' ? 1.7 : s.cls === 'turboprop' ? 1.2 : 1.15) / 4) * 255);
    }
  });
  const t = new THREE.DataTexture(data, DECAL_W, n * 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  decalTex = t;
  return t;
}
