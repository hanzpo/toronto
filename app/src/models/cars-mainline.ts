// Mainline cars: GO (MP40PH-3C + BiLevel coach / cab car), UP Express
// (Nippon Sharyo DMU), VIA Rail (Siemens Charger SCV-42 + Venture coach / cab car).
// Metres, +x forward, origin at the car centre on the rail. See REFERENCE.md.
import { MeshBuilder, type RGB, type V2 } from './builder';
import { P, beam, noseDecal, noseLamp, nosePoly, railBody, railBogie, roofPod, sideDoor, type Dir, type Nose } from './rail';

// =================================================================== GO BiLevel
// 25.908 m, 3.0 m wide, 4.851 m high, low floor 0.38 m between the trucks;
// vertical lower walls, sloped upper walls (the classic BiLevel octagon).
const BL_HALF: V2[] = [[1.42, 0.35], [1.5, 0.45], [1.5, 0.65], [1.5, 2.25], [1.49, 2.55], [1.22, 4.05], [1.05, 4.5], [0.7, 4.78], [0, 4.851]];
const blSide = (y: number): RGB => (y < 0.65 ? P.white : y < 2.25 ? P.goGreen : y < 2.55 ? P.white : y < 4.05 ? P.goGreen : P.white);

/** GO BiLevel coach; `cab` = −1 puts the cab-car end at −x (train tail), 1 at +x. */
export function goBiLevel(cab: Dir | 0, low = false) {
  const L = 25.908, W = 3.0, H = 4.851;
  const b = new MeshBuilder();
  const flat: Nose = {
    prof: [0.1, 0.12, 0.12, 0.12, 0.12, 0.1, 0.08, 0.05, 0],
    taper: [0.95, 0.96, 0.96, 0.96, 0.96, 0.95, 0.93, 0.9, 1],
    front: (y) => (y < 0.65 ? P.under : P.white),
    side: blSide,
  };
  const hi = 1.25;
  const info = railBody(b, {
    L, half: BL_HALF, side: blSide, end: P.white, low, endInset: 0.15, gangway: [0.55, 1.45, 3.6],
    underside: P.under,
    bottom: [[-13, hi], [-9.55, hi], [-9.0, 0.35], [9.0, 0.35], [9.55, hi], [13, hi]],
    front: cab === 1 ? flat : undefined, back: cab === -1 ? flat : undefined,
  });
  const z = 1.5 + 0.015;
  if (low) {
    b.band(BL_HALF, -8.8, 8.8, 1.05, 1.9, P.glass, 0, 0.02);
    b.band(BL_HALF, -8.8, 8.8, 2.95, 3.75, P.glass, 0, 0.02);
    for (const s of [1, -1]) railBogie(b, s * 11.0, 2.59, 0.46, 0.83, { low: true, top: hi });
    return { b, L, H, W };
  }
  for (const s of [1, -1]) {
    sideDoor(b, info, s * 8.2, 1.3, 0.45, 2.2, { frame: P.goGreenDark, leaf: P.goGreen, win: [1.25, 2.05] });
    // intermediate-level window over the truck + door step
    b.sideWindow(s * 10.9 - 0.5, s * 10.9 + 0.5, 1.6, 2.15, z, P.glass, 0.08);
  }
  for (let k = 0; k < 8; k++) {
    const x = -6.3 + 1.8 * k;
    b.sideWindow(x - 0.62, x + 0.62, 1.02, 1.92, z, P.glass, 0.1);
  }
  for (let k = 0; k < 9; k++) {
    const x = -7.2 + 1.8 * k;
    b.band(BL_HALF, x - 0.66, x + 0.66, 2.95, 3.75, P.glass, 0, 0.02);
  }
  // roof vents
  for (const s of [1, -1]) roofPod(b, s * 11.2 - 0.8, s * 11.2 + 0.8, 4.78, 4.92, 0.45, P.offWhite);
  for (const s of [1, -1]) railBogie(b, s * 11.0, 2.59, 0.46, 0.83, { outboard: true, top: hi });
  if (cab) {
    const dir = cab as Dir;
    const on = false; // cab car normally trails the loco; its tail lamps are lit
    noseDecal(b, info, dir, 3.95, 4.5, 0, 1.05, P.goGreen);
    for (const s of [1, -1]) {
      nosePoly(b, info, dir, [[s * 0.18, 4.05], [s * 0.18, 4.4], [s * 0.45, 4.4], [s * 0.45, 4.05]], P.white, 0.03);
      noseDecal(b, info, dir, 2.45, 3.25, s * 0.95, 0.35, P.glass);
      // chevrons
      for (const k of [0, 1]) {
        const y0 = 1.45 + k * 0.32;
        nosePoly(b, info, dir, [[s * 0.6, y0], [s * 0.6, y0 + 0.14], [s * 1.28, y0 + 0.44], [s * 1.28, y0 + 0.3]], P.goGreen, 0.02);
      }
      noseLamp(b, info, dir, 1.35, s * 1.15, 0.08, on ? P.head : P.headOff);
      noseLamp(b, info, dir, 1.35, s * 0.95, 0.07, on ? P.tailOff : P.tail);
      noseLamp(b, info, dir, 4.62, s * 0.2, 0.07, on ? P.head : P.headOff);
    }
    noseDecal(b, info, dir, 0.75, 3.35, 0, 0.38, P.goGreenDark);
    noseDecal(b, info, dir, 0.8, 3.3, 0, 0.33, P.white, 0.02);
    noseDecal(b, info, dir, 2.4, 3.15, 0, 0.2, P.glass, 0.025);
    noseDecal(b, info, dir, 3.55, 3.8, 0, 0.55, P.sign);
  }
  return { b, L, H, W };
}

// =================================================================== GO MP40PH-3C
// 20.73 m, 3.05 m body (3.24 over handrails), 4.72 m, B-B, wheel 1.02 m.
const MP_HALF: V2[] = [[1.5, 1.18], [1.53, 1.4], [1.53, 2.1], [1.53, 2.95], [1.53, 3.3], [1.53, 3.95], [1.4, 4.35], [1.0, 4.62], [0, 4.72]];
const mpSide = (y: number): RGB => (y < 1.4 ? P.charcoal : y < 2.1 ? P.goGreen : y < 2.95 ? P.white : P.goGreen);
const mpFront = (y: number): RGB => (y < 1.4 ? P.charcoal : y < 2.95 ? P.goGreen : y < 3.3 ? P.white : y < 3.95 ? P.glass : P.white);

export function mp40(low = false) {
  const L = 20.73, W = 3.05, H = 4.72;
  const b = new MeshBuilder();
  const nose: Nose = {
    prof: [1.62, 1.62, 1.55, 1.38, 1.12, 0.62, 0.36, 0.15, 0],
    taper: [0.86, 0.86, 0.84, 0.8, 0.78, 0.72, 0.7, 0.7, 1],
    front: mpFront,
    side: (y, seg) => (seg === 0 ? mpSide(y) : seg === 1 ? (y > 3.3 && y < 3.95 ? P.glass : y > 2.95 ? P.white : mpSide(y)) : mpFront(y)),
  };
  const info = railBody(b, { L, half: MP_HALF, side: mpSide, end: P.goGreen, low, endInset: 0.2, gangway: [0.5, 1.5, 3.2], front: nose });
  const z = 1.53 + 0.015;
  const xf = info.noseX(1, 1.2);
  if (low) {
    for (const s of [1, -1]) railBogie(b, s * 6.7 - 0.2, 2.84, 0.51, 0.84, { low: true, top: 1.18 });
    b.box(-3.5, 1.5, 0.45, 1.18, -1.25, 1.25, P.charcoal);
    return { b, L, H, W };
  }
  // white cab roof cap + cab side windows
  b.band(MP_HALF, info.xb1 - 2.4, info.xb1, 3.95, 4.72, P.white, 0, 0.012);
  b.sideWindow(info.xb1 - 1.7, info.xb1 - 0.25, 3.32, 3.92, z, P.glass, 0.1);
  b.sideWindow(info.xb1 - 2.6, info.xb1 - 1.95, 2.3, 3.9, z, P.goGreenDark, 0.03); // cab door
  // side grilles (radiator / inertial filters)
  b.sideWindow(-10.0, -6.2, 3.45, 4.15, z, P.grille, 0.02);
  b.sideWindow(-3.8, 0.4, 3.6, 3.95, z, P.grille, 0.02);
  b.sideWindow(4.3, 6.6, 3.45, 3.8, z, P.grille, 0.02);
  // GO logo on the white stripe
  for (const s of [1, -1] as const) {
    b.disc(-7.35, 2.53, 0.33, s * (z + 0.005), s, P.goGreen, 12);
    b.disc(-6.65, 2.53, 0.33, s * (z + 0.005), s, P.goGreen, 12);
    b.disc(-7.35, 2.53, 0.2, s * (z + 0.01), s, P.white, 10);
    b.disc(-6.65, 2.53, 0.2, s * (z + 0.01), s, P.white, 10);
  }
  // walkway ledge + handrail
  b.box(info.xb0 - 0.1, info.xb1 + 0.6, 1.1, 1.2, -1.62, 1.62, P.charcoal, 0, 'bottom');
  for (const s of [1, -1]) beam(b, info.xb0 + 0.3, 2.05, info.xb0 + 0.3, 1.2, s * 1.6, 0.02, 0.05, P.charcoal);
  // front: white V, number boards, lamps, pilot
  // white V from the windscreen down to a point (split at the nose facets so it hugs the surface)
  const vTop = 3.3, vTip = 1.75, vW = 1.2;
  const vw = (y: number) => (vW * (y - vTip)) / (vTop - vTip);
  const lv = [3.3, 2.95, 2.1, 1.75];
  for (let i = 0; i < lv.length - 1; i++) {
    const a = lv[i], c = lv[i + 1];
    nosePoly(b, info, 1, [[-vw(a), a], [vw(a), a], [vw(c), c], [-vw(c), c]], P.white);
  }
  noseLamp(b, info, 1, 2.55, -0.17, 0.15, P.goGreen, 0.03);
  noseLamp(b, info, 1, 2.55, 0.17, 0.15, P.goGreen, 0.03);
  noseLamp(b, info, 1, 2.55, -0.17, 0.08, P.white, 0.035);
  noseLamp(b, info, 1, 2.55, 0.17, 0.08, P.white, 0.035);
  for (const s of [1, -1]) {
    noseDecal(b, info, 1, 3.02, 3.22, s * 0.95, 0.2, P.black, 0.02);
    noseLamp(b, info, 1, 1.8, s * 1.05, 0.09, P.head);
    noseLamp(b, info, 1, 1.8, s * 0.82, 0.07, P.tailOff);
    noseLamp(b, info, 1, 1.55, s * 1.1, 0.07, s > 0 ? P.indR : P.indL);
  }
  noseLamp(b, info, 1, 4.25, 0, 0.1, P.head);
  b.taperBox(xf - 0.55, xf + 0.02, 0.3, 1.18, 1.1, 0.12, 0.05, P.under);
  b.box(xf - 0.3, xf + 0.25, 0.8, 1.05, -0.2, 0.2, P.black); // coupler
  // trucks + fuel tank + reservoirs
  for (const s of [1, -1]) railBogie(b, s * 6.7 - 0.2, 2.84, 0.51, 0.84, { outboard: true, top: 1.18 });
  b.box(-3.5, 1.5, 0.45, 1.12, -1.28, 1.28, P.charcoal);
  b.box(2.2, 3.4, 0.7, 1.1, -1.1, 1.1, P.under);
  // roof: radiator hatch with fans, dynamic brake blister, exhaust
  roofPod(b, -10.1, -5.8, 4.55, 4.82, 1.25, P.goGreen, P.grille);
  for (const x of [-9.25, -7.95, -6.65]) b.roof(x - 0.5, x + 0.5, 4.83, 0.5, P.black);
  roofPod(b, -3.8, 0.4, 4.55, 4.8, 1.0, P.goGreen, P.grille);
  b.box(-4.8, -4.2, 4.6, 4.95, -0.25, 0.25, P.black);
  roofPod(b, 1.4, 4.8, 4.55, 4.76, 0.9, P.goGreen);
  return { b, L, H, W };
}

// =================================================================== UP Express DMU
// Nippon Sharyo DMU, 25.9 m cars, 3.2 m wide, 4.25 m. Silver / champagne-gold, orange pinstripe.
const UP_HALF: V2[] = [[1.45, 1.05], [1.6, 1.2], [1.6, 1.55], [1.6, 2.1], [1.6, 2.18], [1.6, 3.05], [1.52, 3.45], [1.25, 3.85], [0.6, 4.02], [0, 4.05]];
const upSide = (y: number): RGB => (y < 1.55 ? P.charcoal : y < 2.1 ? P.upGold : y < 2.18 ? P.upOrange : P.upSilver);
const upFront = (y: number): RGB => (y < 1.55 ? P.charcoal : y < 2.18 ? P.upSilver : y < 3.45 ? P.black : P.upGold);

export function upDmu(cab: Dir | 0, low = false) {
  const L = 25.9, W = 3.2, H = 4.25;
  const b = new MeshBuilder();
  const nose: Nose = {
    prof: [1.2, 1.3, 1.3, 1.22, 1.2, 0.86, 0.55, 0.28, 0.1, 0],
    taper: [0.86, 0.88, 0.88, 0.88, 0.88, 0.88, 0.84, 0.8, 0.78, 1],
    front: upFront,
    side: (y, seg) => (seg === 0 ? upSide(y) : y > 2.18 && y < 3.45 ? P.black : seg === 2 ? upFront(y) : upSide(y)),
  };
  const info = railBody(b, {
    L, half: UP_HALF, side: upSide, end: P.upSilver, low, endInset: 0.15, gangway: [0.55, 1.3, 3.3],
    front: cab === 1 ? nose : undefined, back: cab === -1 ? nose : undefined,
  });
  const z = 1.6 + 0.015;
  if (low) {
    b.band(UP_HALF, info.xb0 + 1.5, info.xb1 - 1.5, 2.3, 3.0, P.glass, 0, 0.02);
    for (const s of [1, -1]) railBogie(b, s * 9.0, 2.6, 0.43, 0.83, { low: true, top: 1.05 });
    return { b, L, H, W };
  }
  const c = cab * -0.6;
  for (const s of [1, -1]) sideDoor(b, info, c + s * 6.4, 1.3, 1.15, 3.1, { frame: P.charcoal, leaf: P.upSilver, win: [2.3, 3.0] });
  for (const x of [-4.05, -1.35, 1.35, 4.05]) b.sideWindow(c + x - 1.15, c + x + 1.15, 2.3, 3.0, z, P.glass, 0.12);
  for (const s of [1, -1]) if (s !== cab) b.sideWindow(c + s * 9.0 - 1.1, c + s * 9.0 + 1.1, 2.3, 3.0, z, P.glass, 0.12);
  if (cab) {
    const dir = cab as Dir;
    const xe = dir > 0 ? info.xb1 : info.xb0;
    b.sideWindow(Math.min(xe, xe - dir * 1.2), Math.max(xe, xe - dir * 1.2), 2.3, 3.0, z, P.glass, 0.1);
    for (const s of [1, -1]) {
      noseDecal(b, info, dir, 2.3, 3.02, s * 0.88, 0.34, P.glass);
      noseDecal(b, info, dir, 1.66, 2.12, s * 1.02, 0.2, P.black, 0.02);
      noseLamp(b, info, dir, 2.0, s * 1.02, 0.08, P.headOff);
      noseLamp(b, info, dir, 1.78, s * 1.02, 0.07, P.tail);
      noseDecal(b, info, dir, 1.56, 2.2, s * 1.28, 0.04, P.upOrange, 0.02);
    }
    noseDecal(b, info, dir, 2.3, 3.02, 0, 0.5, P.glass);
    noseDecal(b, info, dir, 2.86, 3.0, 0, 0.45, P.sign, 0.025);
    noseLamp(b, info, dir, 3.25, -0.12, 0.08, P.head);
    noseLamp(b, info, dir, 3.25, 0.12, 0.08, P.head);
    noseDecal(b, info, dir, 1.75, 1.95, 0, 0.26, P.upGold, 0.02); // "UP"
    const xf = info.noseX(dir, 1.1);
    b.box(Math.min(xf, xf - dir * 0.6), Math.max(xf, xf - dir * 0.6), 0.45, 1.05, -1.0, 1.0, P.under, 0, 'bottom');
    for (let k = 0; k < 4; k++) b.box(xe - dir * 1.5 - 0.12, xe - dir * 1.5 + 0.12, 4.0, 4.14, -0.35 + k * 0.23 - 0.08, -0.35 + k * 0.23 + 0.08, P.silverDark);
  }
  for (const s of [1, -1]) railBogie(b, s * 9.0, 2.6, 0.43, 0.83, { outboard: true, top: 1.05 });
  b.box(-6.0, 5.4, 0.45, 1.05, -1.25, 1.25, P.under);
  for (const s of [1, -1]) roofPod(b, s * 5.5 - 2.2, s * 5.5 + 2.2, 3.95, 4.22, 1.05, P.upSilver, P.grille);
  return { b, L, H, W };
}

// =================================================================== VIA Rail: Siemens Venture + Charger SCV-42
const VN_HALF: V2[] = [[1.45, 1.0], [1.6, 1.15], [1.6, 1.55], [1.6, 2.02], [1.6, 2.1], [1.6, 2.95], [1.55, 3.3], [1.35, 3.85], [0.8, 4.2], [0, 4.27]];
const vnSide = (y: number): RGB => (y < 1.55 ? P.charcoal : y < 2.02 ? P.viaMid : y < 2.1 ? P.viaYellow : P.viaGrey);
const viaFace = (y: number): RGB => (y < 1.55 ? P.charcoal : P.black);
function viaNose(prof: number[], taper: number[]): Nose {
  return {
    prof, taper,
    front: viaFace,
    side: (y, seg) => (seg === 0 ? vnSide(y) : seg === 1 ? (y > 1.55 && y < 3.85 ? P.viaYellow : vnSide(y)) : viaFace(y)),
  };
}
function viaFront(b: MeshBuilder, info: ReturnType<typeof railBody>, dir: Dir, lit: boolean, wsY: [number, number]) {
  for (const s of [1, -1]) {
    noseDecal(b, info, dir, wsY[0], wsY[1], s * 0.45, 0.42, P.glass);
    noseLamp(b, info, dir, 1.95, s * 1.0, 0.09, lit ? P.head : P.headOff);
    noseLamp(b, info, dir, 1.78, s * 0.84, 0.06, lit ? P.tailOff : P.tail);
  }
  noseDecal(b, info, dir, wsY[1] + 0.05, wsY[1] + 0.2, 0, 0.5, P.signWhite);
  noseDecal(b, info, dir, 2.1, 2.26, 0.05, 0.34, P.viaYellow); // VIA logo
}

export function viaVenture(cab: Dir | 0, low = false) {
  const L = 25.9, W = 3.2, H = 4.27;
  const b = new MeshBuilder();
  const nose = viaNose([1.5, 1.6, 1.6, 1.56, 1.54, 1.25, 0.95, 0.45, 0.12, 0], [0.8, 0.82, 0.82, 0.82, 0.82, 0.8, 0.78, 0.74, 0.72, 1]);
  const info = railBody(b, {
    L, half: VN_HALF, side: vnSide, end: P.viaGrey, low, endInset: 0.15, gangway: [0.55, 1.3, 3.3],
    front: cab === 1 ? nose : undefined, back: cab === -1 ? nose : undefined,
  });
  const z = 1.6 + 0.015;
  if (low) {
    b.band(VN_HALF, info.xb0 + 1.5, info.xb1 - 1.5, 2.2, 2.9, P.glass, 0, 0.02);
    for (const s of [1, -1]) railBogie(b, s * 9.3, 2.6, 0.45, 0.83, { low: true, top: 1.0 });
    return { b, L, H, W };
  }
  for (const s of [1, -1]) if (s !== cab) sideDoor(b, info, s * 11.9, 0.95, 1.1, 3.05, { frame: P.charcoal, leaf: P.viaGrey, win: [2.25, 2.9], leaves: 1 });
  const x0 = cab === 1 ? -10.5 : -10.4, x1 = cab === -1 ? 10.5 : 10.4;
  const x0w = cab === -1 ? info.xb0 + 2.4 : x0, x1w = cab === 1 ? info.xb1 - 2.4 : x1;
  const n = Math.round((x1w - x0w) / 1.32);
  for (let k = 0; k <= n; k++) {
    const x = x0w + ((x1w - x0w) * k) / n;
    b.sideWindow(x - 0.5, x + 0.5, 2.2, 2.9, z, P.glass, 0.1);
  }
  if (cab) {
    const dir = cab as Dir;
    const xe = dir > 0 ? info.xb1 : info.xb0;
    // charcoal diagonal sweep behind the cab
    const X = (d: number) => xe - dir * d;
    b.sidePoly(dir > 0 ? [[X(4.2), 1.55], [X(0), 1.55], [X(0), 3.85], [X(1.6), 3.85]] : [[X(0), 1.55], [X(4.2), 1.55], [X(1.6), 3.85], [X(0), 3.85]], z, P.charcoal);
    b.sideWindow(Math.min(xe, xe - dir * 1.1), Math.max(xe, xe - dir * 1.1), 2.4, 3.1, z + 0.005, P.glass, 0.1);
    viaFront(b, info, dir, false, [2.45, 3.2]);
    const xf = info.noseX(dir, 1.0);
    b.box(Math.min(xf, xf - dir * 0.6), Math.max(xf, xf - dir * 0.6), 0.4, 1.0, -1.05, 1.05, P.silverDark, 0, 'bottom');
  }
  for (const s of [1, -1]) railBogie(b, s * 9.3, 2.6, 0.45, 0.83, { top: 1.0 });
  b.box(-7.0, 7.0, 0.5, 1.0, -1.3, 1.3, P.under);
  for (const s of [1, -1]) roofPod(b, s * 10.5 - 1.3, s * 10.5 + 1.3, 4.15, 4.32, 0.8, P.viaGrey);
  return { b, L, H, W };
}

const CH_HALF: V2[] = [[1.45, 1.05], [1.52, 1.2], [1.52, 1.55], [1.52, 2.02], [1.52, 2.1], [1.52, 3.3], [1.4, 3.85], [1.0, 4.25], [0, 4.39]];
export function viaCharger(low = false) {
  const L = 21.8, W = 3.05, H = 4.39;
  const b = new MeshBuilder();
  const side = (y: number): RGB => (y < 1.55 ? P.charcoal : y < 2.02 ? P.viaMid : y < 2.1 ? P.viaYellow : P.viaGrey);
  const nose: Nose = {
    prof: [2.0, 2.05, 2.0, 1.9, 1.88, 1.05, 0.5, 0.15, 0],
    taper: [0.8, 0.82, 0.82, 0.8, 0.8, 0.76, 0.72, 0.7, 1],
    front: viaFace,
    side: (y, seg) => (seg === 0 ? side(y) : seg === 1 ? (y > 1.55 && y < 3.85 ? P.viaYellow : side(y)) : viaFace(y)),
  };
  const info = railBody(b, { L, half: CH_HALF, side, end: P.viaGrey, low, endInset: 0.2, gangway: [0.5, 1.3, 3.2], front: nose });
  const z = 1.52 + 0.015;
  if (low) {
    for (const s of [1, -1]) railBogie(b, s * 6.2, 2.7, 0.5, 0.84, { low: true, top: 1.05 });
    return { b, L, H, W };
  }
  const xe = info.xb1;
  b.sidePoly([[xe - 9.5, 1.55], [xe - 3.8, 1.55], [xe - 1.2, 3.85], [xe - 6.9, 3.85]], z, P.charcoal);
  b.sideWindow(xe - 1.2, xe - 0.2, 2.5, 3.2, z + 0.005, P.glass, 0.1);
  b.sideWindow(-10.2, -6.5, 2.4, 3.6, z, P.grille, 0.03);
  viaFront(b, info, 1, true, [2.55, 3.3]);
  const xf = info.noseX(1, 1.05);
  b.taperBox(xf - 0.7, xf + 0.02, 0.3, 1.05, 1.15, 0.15, 0.05, P.silverDark);
  for (const s of [1, -1]) railBogie(b, s * 6.2, 2.7, 0.5, 0.84, { outboard: true, top: 1.05 });
  b.box(-3.5, 2.8, 0.45, 1.05, -1.25, 1.25, P.charcoal);
  roofPod(b, -10.0, -5.0, 4.3, 4.5, 1.1, P.viaGrey, P.grille);
  b.box(-4.2, -3.7, 4.3, 4.6, -0.25, 0.25, P.black);
  return { b, L, H, W };
}
