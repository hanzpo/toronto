// TTC / Metrolinx urban rail cars: Toronto Rocket, T1, Flexity Outlook,
// Flexity Freedom (Line 5), Citadis Spirit (Line 6). One car / module each.
// Metres, +x forward, origin at the car centre on the rail. See REFERENCE.md.
import { MeshBuilder, type RGB, type V2 } from './builder';
import { P, railBody, railBogie, noseDecal, noseLamp, nosePoly, pantograph, roofPod, sideDoor, type Dir, type Nose } from './rail';

export type CabEnd = 'front' | 'back' | 'none';

// =================================================================== Toronto Rocket
// 23.19 m cab cars / 22.86 m intermediates, 3.137 m wide, 3.645 m high, floor 1.105 m.
const TR_HALF: V2[] = [[1.42, 0.88], [1.5685, 1.02], [1.5685, 1.25], [1.5685, 1.7], [1.5685, 3.0], [1.5, 3.3], [1.3, 3.52], [0.9, 3.62], [0, 3.645]];
const trSide = (y: number): RGB => (y < 1.02 ? P.under : P.silver);

function trNose(): Nose {
  return {
    prof: [0.92, 1.0, 1.0, 0.9, 0.44, 0.3, 0.16, 0.06, 0],
    taper: [0.86, 0.88, 0.88, 0.88, 0.84, 0.8, 0.78, 0.8, 1],
    front: (y) => (y < 1.02 ? P.under : y < 1.25 ? P.black : y < 1.7 ? P.silver : P.black),
    side: (y, seg) => (seg === 0 ? trSide(y) : y > 1.7 && y < 3.45 ? P.black : y > 1.02 && y < 1.25 && seg === 2 ? P.black : trSide(y)),
  };
}

/** Toronto Rocket car. `cab`: which end carries the driving cab (none = intermediate). */
export function torontoRocket(cab: CabEnd, low = false) {
  const L = cab === 'none' ? 22.86 : 23.19, W = 3.137, H = 3.645;
  const b = new MeshBuilder();
  const info = railBody(b, {
    L, half: TR_HALF, side: trSide, end: P.silver, low, endInset: 0.14, gangway: [1.05, 1.1, 3.1],
    front: cab === 'front' ? trNose() : undefined,
    back: cab === 'back' ? trNose() : undefined,
  });
  const c = cab === 'front' ? -0.17 : cab === 'back' ? 0.17 : 0;
  const z = TR_HALF[3][0] + 0.015;
  if (low) {
    b.band(TR_HALF, info.xb0 + 1, info.xb1 - 1, 1.75, 2.6, P.glass, 0, 0.02);
    railBogie(b, c - 8, 2.08, 0.36, 0.83, { low: true, top: 0.88 });
    railBogie(b, c + 8, 2.08, 0.36, 0.83, { low: true, top: 0.88 });
    return { b, L, H, W };
  }
  // creases
  b.band(TR_HALF, info.xb0 + 0.05, info.xb1 - 0.05, 1.05, 1.085, P.silverDark, 0, 0.01);
  b.band(TR_HALF, info.xb0 + 0.05, info.xb1 - 0.05, 2.95, 2.985, P.silverDark, 0, 0.01);
  // doors: 4 double doors per side
  for (const dx of [-8.55, -2.85, 2.85, 8.55]) {
    sideDoor(b, info, c + dx, 1.42, 1.1, 2.98, { frame: P.silverDark, leaf: P.silver, win: [1.78, 2.62] });
  }
  // windows (frame + glass)
  const win = (x: number, w: number) => {
    b.sideWindow(x - w / 2 - 0.05, x + w / 2 + 0.05, 1.67, 2.7, z, P.silverDark, 0.18);
    b.sideWindow(x - w / 2, x + w / 2, 1.72, 2.65, z + 0.006, P.glass, 0.15);
  };
  win(c, 2.1);
  win(c - 5.7, 2.3); win(c + 5.7, 2.3);
  if (cab !== 'back') win(c - 10.35, 1.2);
  if (cab !== 'front') win(c + 10.35, 1.2);
  // TTC logo (red bar) next to the centre window
  for (const s of [1, -1] as const) b.sideWindow(c + 1.35, c + 1.8, 2.3, 2.44, z + 0.006, P.ttcRed, 0, s);
  // cab side door + window, run number
  const cabSide = (dir: Dir) => {
    const x = dir > 0 ? info.xb1 - 0.6 : info.xb0 + 0.6;
    b.sideWindow(x - 0.4, x + 0.4, 1.1, 2.98, z, P.silverDark, 0.04);
    b.sideWindow(x - 0.36, x + 0.36, 1.12, 2.95, z + 0.006, P.silver, 0.03);
    b.sideWindow(x - 0.22, x + 0.22, 1.9, 2.72, z + 0.012, P.glass, 0.08);
  };
  const front = (dir: Dir) => {
    cabSide(dir);
    const on = (dir > 0) === (cab === 'front');
    // windscreen panes in the black mask + silver pillars
    noseDecal(b, info, dir, 1.95, 3.02, 0, 0.36, P.glass);
    for (const s of [1, -1]) {
      noseDecal(b, info, dir, 1.9, 3.02, s * 0.86, 0.36, P.glass);
      noseDecal(b, info, dir, 1.72, 3.3, s * 0.43, 0.035, P.silver, 0.02);
      noseLamp(b, info, dir, 3.22, s * 1.02, 0.08, on ? P.tailOff : P.tail);
      noseLamp(b, info, dir, 1.13, s * 1.2, 0.085, on ? P.head : P.headOff);
      noseLamp(b, info, dir, 1.13, s * 1.0, 0.05, P.yellow);
    }
    noseDecal(b, info, dir, 3.12, 3.32, 0.05, 0.42, P.sign);
    noseDecal(b, info, dir, 3.12, 3.32, -0.5, 0.08, P.tint); // line badge (route colour)
    // TTC logo on the lower front
    noseDecal(b, info, dir, 1.47, 1.52, 0, 0.34, P.ttcRed);
    nosePoly(b, info, dir, [[-0.11, 1.63], [0.11, 1.63], [0.11, 1.47], [0, 1.37], [-0.11, 1.47]], P.ttcRed, 0.02);
    nosePoly(b, info, dir, [[-0.075, 1.6], [0.075, 1.6], [0.075, 1.48], [0, 1.41], [-0.075, 1.48]], P.white, 0.025);
    noseDecal(b, info, dir, 0.93, 0.98, 0, 0.9, P.yellow);
  };
  if (cab === 'front') front(1);
  if (cab === 'back') front(-1);
  // running gear + underframe
  for (const s of [1, -1]) railBogie(b, c + s * 8, 2.083, 0.3555, 0.83, { top: 0.88 });
  b.box(c - 6.4, c - 1.0, 0.42, 0.88, -1.2, 1.2, P.under);
  b.box(c + 1.0, c + 6.4, 0.42, 0.88, -1.2, 1.2, P.under);
  // roof: low HVAC units at both ends
  for (const s of [1, -1]) roofPod(b, c + s * 8.4 - 1.5, c + s * 8.4 + 1.5, 3.55, 3.72, 0.78, P.roofGrey, P.grille);
  return { b, L, H, W };
}

// =================================================================== T1 (Line 2)
const T1_HALF: V2[] = [[1.45, 0.9], [1.57, 1.03], [1.57, 1.3], [1.57, 1.7], [1.57, 3.05], [1.48, 3.35], [1.2, 3.55], [0, 3.65]];
const t1Side = (y: number): RGB => (y < 1.03 ? P.under : P.silver);

export function t1(cab: CabEnd, low = false) {
  const L = 22.9, W = 3.14, H = 3.65;
  const b = new MeshBuilder();
  const flat: Nose = {
    prof: [0.06, 0.1, 0.12, 0.12, 0.12, 0.1, 0.06, 0],
    taper: [0.94, 0.96, 0.96, 0.96, 0.95, 0.93, 0.9, 1],
    front: (y) => (y < 1.03 ? P.under : P.silver),
    side: t1Side,
  };
  const info = railBody(b, {
    L, half: T1_HALF, side: t1Side, end: P.silver, low, endInset: 0.14, gangway: [0.55, 1.1, 3.0],
    front: cab === 'front' ? flat : undefined, back: cab === 'back' ? flat : undefined,
  });
  const z = 1.57 + 0.015;
  if (low) {
    b.band(T1_HALF, info.xb0 + 1, info.xb1 - 1, 1.75, 2.6, P.glass, 0, 0.02);
    for (const s of [1, -1]) railBogie(b, s * 8, 2.08, 0.36, 0.83, { low: true, top: 0.9 });
    return { b, L, H, W };
  }
  // fluted lower panels
  for (let y = 1.12; y < 1.62; y += 0.1) b.band(T1_HALF, info.xb0 + 0.1, info.xb1 - 0.1, y, y + 0.025, P.silverDark, 0, 0.008);
  for (const dx of [-8.5, -2.85, 2.85, 8.5]) sideDoor(b, info, dx, 1.37, 1.1, 2.98, { frame: P.silverDark, leaf: P.silver, win: [1.8, 2.6] });
  const win = (x: number, w: number) => b.sideWindow(x - w / 2, x + w / 2, 1.75, 2.62, z + 0.01, P.glass, 0.16);
  win(0, 2.2); win(-5.7, 2.3); win(5.7, 2.3); win(-10.4, 1.1); win(10.4, 1.1);
  for (const s of [1, -1] as const) b.sideWindow(1.4, 1.85, 2.3, 2.44, z + 0.01, P.ttcRed, 0, s);
  const front = (dir: Dir) => {
    const on = (dir > 0) === (cab === 'front');
    noseDecal(b, info, dir, 1.15, 3.1, 0, 0.42, P.silverDark);
    noseDecal(b, info, dir, 1.18, 3.07, 0, 0.38, P.silver, 0.02);
    noseDecal(b, info, dir, 2.0, 2.85, 0, 0.2, P.glass, 0.025);
    for (const s of [1, -1]) {
      noseDecal(b, info, dir, 1.95, 2.8, s * 0.98, 0.3, P.glass);
      noseLamp(b, info, dir, 3.38, s * 1.05, 0.07, on ? P.tailOff : P.tail);
      noseLamp(b, info, dir, 3.38, s * 0.85, 0.07, P.headOff);
      noseLamp(b, info, dir, 1.35, s * 1.12, 0.09, on ? P.head : P.headOff);
    }
    noseDecal(b, info, dir, 3.26, 3.48, 0, 0.5, P.black);
    noseDecal(b, info, dir, 3.3, 3.44, 0, 0.42, P.signWhite, 0.02);
  };
  if (cab === 'front') front(1);
  if (cab === 'back') front(-1);
  for (const s of [1, -1]) railBogie(b, s * 8, 2.083, 0.3555, 0.83, { top: 0.9 });
  b.box(-6.4, -1.0, 0.42, 0.9, -1.2, 1.2, P.under);
  b.box(1.0, 6.4, 0.42, 0.9, -1.2, 1.2, P.under);
  return { b, L, H, W };
}

// =================================================================== Flexity Outlook (TTC)
// 30.2 m over couplers, 5 modules A-B-C-B-A (A and C on trucks, B suspended),
// 2.54 m wide, 3.84 m high, low floor 0.36 m. Red / white / black TTC livery.
const FLX_HALF: V2[] = [[1.18, 0.3], [1.25, 0.42], [1.27, 0.78], [1.27, 0.95], [1.27, 1.1], [1.27, 2.55], [1.26, 2.88], [1.2, 3.08], [1.08, 3.4], [0.8, 3.68], [0, 3.8]];
const flxSide = (y: number): RGB => (y < 0.95 ? P.ttcRed : y < 1.1 ? P.white : y < 2.55 ? P.glass : y < 2.88 ? P.white : P.ttcRed);
const flxFront = (y: number): RGB => (y < 0.42 ? P.ttcRed : y < 0.78 ? P.white : y < 1.1 ? P.ttcRed : y < 3.08 ? P.glass : P.ttcRed);

function flexityNose(): Nose {
  return {
    prof: [0.86, 0.96, 1.0, 0.99, 0.97, 0.84, 0.81, 0.74, 0.5, 0.24, 0],
    taper: [0.82, 0.84, 0.85, 0.85, 0.85, 0.86, 0.86, 0.84, 0.78, 0.7, 1],
    front: flxFront,
    side: (y, seg) => (seg === 0 ? (y > 0.42 && y < 0.95 ? P.white : flxSide(y)) : flxFront(y)),
  };
}

export type FlexityModule = 'A-front' | 'B' | 'C' | 'A-back';
export const FLEXITY_LEN: Record<FlexityModule, number> = { 'A-front': 8.3, B: 4.4, C: 4.4, 'A-back': 8.3 };

export function flexityOutlook(m: FlexityModule, low = false) {
  const L = FLEXITY_LEN[m], W = 2.54, H = 3.84;
  const b = new MeshBuilder();
  const cab: Dir | 0 = m === 'A-front' ? 1 : m === 'A-back' ? -1 : 0;
  const info = railBody(b, {
    L, half: FLX_HALF, side: flxSide, end: P.black, low, endInset: 0.04,
    front: cab === 1 ? flexityNose() : undefined, back: cab === -1 ? flexityNose() : undefined,
  });
  const z = 1.27 + 0.012;
  const truck = m === 'C' ? 0 : m === 'A-front' ? -0.9 : m === 'A-back' ? 0.9 : null;
  if (low) {
    if (truck !== null) b.box(truck - 1.1, truck + 1.1, 0.05, 0.3, -1.05, 1.05, P.black);
    if (m === 'C') pantograph(b, 0, 3.8, 5.0, 1, true);
    return { b, L, H, W };
  }
  // articulation seals (black) at inner ends
  const seal = (x0: number, x1: number) => b.band(FLX_HALF, x0, x1, 0.3, 3.8, P.black, 0, 0.012);
  if (cab !== -1) seal(info.xb0, info.xb0 + 0.12);
  if (cab !== 1) seal(info.xb1 - 0.12, info.xb1);
  // window mullions (thin dark frames over the glass band)
  const inner0 = info.xb0 + (cab === -1 ? 0.2 : 0.35), inner1 = info.xb1 - (cab === 1 ? 0.2 : 0.35);
  const doorX: number[] = m === 'B' ? [0] : m === 'A-front' ? [info.xb1 - 2.05] : m === 'A-back' ? [info.xb0 + 2.05] : [];
  const n = Math.max(1, Math.round((inner1 - inner0) / 1.45));
  for (let k = 0; k <= n; k++) {
    const x = inner0 + ((inner1 - inner0) * k) / n;
    if (doorX.some((d) => Math.abs(d - x) < 0.85)) continue;
    b.sideWindow(x - 0.05, x + 0.05, 1.1, 2.55, z, P.charcoal, 0);
  }
  // doors: right side only (+z); left side keeps windows + red lower panel
  for (const x of doorX) {
    sideDoor(b, info, x, 1.3, 0.34, 2.6, { frame: P.frame, leaf: P.glassTint, win: [0.85, 2.5], side: 1, winColor: P.glass, eps: 0.02 });
    b.sideWindow(x - 0.68, x + 0.68, 0.28, 0.34, z + 0.01, P.yellow, 0, 1); // threshold edge
  }
  // cab: white swoosh behind the nose, cab side window, blue marker lights, lamps
  if (cab) {
    const xe = cab > 0 ? info.xb1 : info.xb0;
    const X = (d: number) => xe - cab * d;
    b.sidePoly(cab > 0
      ? [[X(1.7), 0.42], [X(0), 0.42], [X(0), 1.1], [X(0.9), 1.1], [X(1.7), 0.95]]
      : [[X(0), 0.42], [X(1.7), 0.42], [X(1.7), 0.95], [X(0.9), 1.1], [X(0), 1.1]], z, P.white);
    const dir = cab as Dir;
    const on = (m === 'A-front');
    for (const s of [1, -1]) {
      noseLamp(b, info, dir, 0.93, s * 0.98, 0.075, on ? P.head : P.headOff);
      noseLamp(b, info, dir, 0.93, s * 0.8, 0.075, on ? P.head : P.headOff);
      noseDecal(b, info, dir, 0.9, 0.96, s * 0.42, 0.2, on ? P.head : P.headOff);
      noseLamp(b, info, dir, 0.93, s * 0.62, 0.05, on ? P.tailOff : P.tail);
      noseDecal(b, info, dir, 0.86, 0.9, s * 1.05, 0.08, s > 0 ? P.indR : P.indL);
      noseLamp(b, info, dir, 3.22, s * 0.95, 0.05, P.markerBlue);
    }
    noseDecal(b, info, dir, 2.66, 2.9, 0.12, 0.62, P.sign);
    noseDecal(b, info, dir, 2.66, 2.9, -0.7, 0.14, P.sign);
    noseDecal(b, info, dir, 1.14, 1.2, 0, 0.9, P.charcoal); // wiper / dash line
    // coupler cover
    noseDecal(b, info, dir, 0.52, 0.66, 0, 0.35, P.offWhite);
  }
  // running gear under the skirt
  if (truck !== null) {
    b.box(truck - 1.15, truck + 1.15, 0.04, 0.3, -1.1, 1.1, P.black);
    for (const s of [1, -1]) for (const ax of [truck - 0.9, truck + 0.9]) b.disc(ax, 0.3, 0.26, s * 1.12, s as Dir, P.bogie, 8);
  }
  // roof: red fairings are the section; equipment grilles + pantograph
  if (m === 'A-front' || m === 'A-back') {
    const xc = cab > 0 ? -1.2 : 1.2;
    roofPod(b, xc - 2.2, xc + 2.2, 3.7, 3.86, 0.72, P.ttcRed, P.grille);
  }
  if (m === 'C') pantograph(b, 0, 3.8, 5.0, 1);
  if (m === 'B') roofPod(b, -1.4, 1.4, 3.7, 3.84, 0.7, P.ttcRed, P.grille);
  return { b, L, H, W };
}

// =================================================================== Flexity Freedom (Line 5) / Citadis Spirit (Line 6)
// Line 5: 31 m, 2.65 m wide, 3.6 m high, 5 modules (A-B-C-B-A, B-2-B: A, C on trucks).
// Line 6: Citadis Spirit 48 m, 7 modules (A-B-C-B-C-B-A), 2.65 m.
const LRT_HALF: V2[] = [[1.25, 0.3], [1.32, 0.45], [1.325, 0.62], [1.325, 0.9], [1.325, 1.0], [1.325, 2.62], [1.3, 2.95], [1.2, 3.2], [0.85, 3.38], [0, 3.42]];

export type LrtModule = 'A-front' | 'B' | 'C' | 'A-back';
export type LrtKind = 'freedom' | 'citadis';
export const LRT_LEN: Record<LrtKind, Record<LrtModule, number>> = {
  freedom: { 'A-front': 8.5, B: 3.6, C: 6.4, 'A-back': 8.5 },
  citadis: { 'A-front': 8.4, B: 5.2, C: 7.4, 'A-back': 8.4 },
};

export function lrtModule(kind: LrtKind, m: LrtModule, low = false) {
  const L = LRT_LEN[kind][m], W = 2.65, H = 3.6;
  const body = P.lrtWhite;
  const side = (y: number): RGB => (y < 0.45 ? P.lrtGrey : y < 0.9 ? body : y < 1.0 ? P.tint : y < 2.62 ? P.glass : body);
  const cit = kind === 'citadis';
  const front = (y: number): RGB => (cit
    ? (y < 0.62 ? body : y < 1.0 ? P.charcoal : y < 2.95 ? P.glass : P.charcoal)
    : (y < 0.62 ? P.offWhite : y < 1.0 ? P.black : y < 2.95 ? P.glass : P.black));
  const nose: Nose = {
    prof: cit ? [0.9, 1.1, 1.18, 1.16, 1.12, 0.8, 0.55, 0.34, 0.12, 0] : [1.0, 1.22, 1.32, 1.3, 1.26, 0.92, 0.6, 0.34, 0.12, 0],
    taper: cit ? [0.86, 0.88, 0.88, 0.88, 0.88, 0.86, 0.82, 0.78, 0.74, 1] : [0.78, 0.8, 0.82, 0.82, 0.82, 0.8, 0.76, 0.72, 0.7, 1],
    front,
    side: (y, seg) => (seg === 0 ? (cit && y > 0.62 ? (y < 2.95 && y > 1.0 ? P.glass : P.charcoal) : side(y)) : front(y)),
  };
  const b = new MeshBuilder();
  const cab: Dir | 0 = m === 'A-front' ? 1 : m === 'A-back' ? -1 : 0;
  const info = railBody(b, {
    L, half: LRT_HALF, side, end: P.black, low, endInset: 0.05,
    front: cab === 1 ? nose : undefined, back: cab === -1 ? nose : undefined,
  });
  const z = 1.325 + 0.012;
  const truck = m === 'C' ? 0 : m === 'A-front' ? -1.2 : m === 'A-back' ? 1.2 : null;
  if (low) {
    if (truck !== null) b.box(truck - 1.1, truck + 1.1, 0.05, 0.3, -1.1, 1.1, P.black);
    if (m === 'C') pantograph(b, 0, 3.42, 5.4, 1, true);
    return { b, L, H, W };
  }
  if (cab !== -1) b.band(LRT_HALF, info.xb0, info.xb0 + 0.12, 0.3, 3.42, P.black, 0, 0.012);
  if (cab !== 1) b.band(LRT_HALF, info.xb1 - 0.12, info.xb1, 0.3, 3.42, P.black, 0, 0.012);
  const doorX: number[] = m === 'B' ? [0] : m === 'A-front' ? [info.xb0 + 1.6] : m === 'A-back' ? [info.xb1 - 1.6] : cit ? [] : [];
  const inner0 = info.xb0 + 0.3, inner1 = info.xb1 - 0.3;
  const n = Math.max(1, Math.round((inner1 - inner0) / 1.5));
  for (let k = 0; k <= n; k++) {
    const x = inner0 + ((inner1 - inner0) * k) / n;
    if (doorX.some((d) => Math.abs(d - x) < 0.85)) continue;
    b.sideWindow(x - 0.05, x + 0.05, 1.0, 2.62, z, P.lrtWhite, 0);
  }
  for (const x of doorX) {
    sideDoor(b, info, x, 1.3, 0.36, 2.62, { frame: P.lrtGrey, leaf: P.glassTint, win: [0.8, 2.5], winColor: P.glass });
  }
  if (cab) {
    const dir = cab as Dir;
    const on = m === 'A-front';
    const xe = cab > 0 ? info.xb1 : info.xb0;
    if (cit) {
      // black mask sweeping back along the cab side
      const X = (d: number) => xe - cab * d;
      b.sidePoly(cab > 0 ? [[X(0.5), 0.62], [X(0), 0.62], [X(0), 3.2], [X(2.6), 3.2]] : [[X(0), 0.62], [X(0.5), 0.62], [X(2.6), 3.2], [X(0), 3.2]], z, P.charcoal);
    }
    for (const s of [1, -1]) {
      noseLamp(b, info, dir, 0.82, s * 0.95, 0.08, on ? P.head : P.headOff);
      noseLamp(b, info, dir, 0.82, s * 0.74, 0.06, on ? P.tailOff : P.tail);
      noseDecal(b, info, dir, 0.7, 0.74, s * 1.0, 0.08, s > 0 ? P.indR : P.indL);
    }
    noseDecal(b, info, dir, 2.66, 2.86, 0, 0.55, P.sign);
  }
  if (truck !== null) {
    b.box(truck - 1.15, truck + 1.15, 0.04, 0.3, -1.12, 1.12, P.black);
    for (const s of [1, -1]) for (const ax of [truck - 0.9, truck + 0.9]) b.disc(ax, 0.32, 0.28, s * 1.14, s as Dir, P.bogie, 8);
  }
  if (m === 'C') pantograph(b, 0, 3.42, 5.4, 1);
  else if (cab) { const xa = -1.8 * cab, xb = xa - 3.2 * cab; roofPod(b, Math.min(xa, xb), Math.max(xa, xb), 3.38, 3.58, 0.8, P.lrtWhite, P.grille); }
  if (m === 'B') roofPod(b, -1.2, 1.2, 3.38, 3.56, 0.75, P.lrtWhite, P.grille);
  return { b, L, H, W };
}
