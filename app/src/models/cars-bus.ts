// Nova Bus LFS (40' rigid, 62' artic) in TTC-style livery: white body, dark
// window band with framed windows, livery stripes (tinted by route / agency
// colour), roof pods. Metres, +x forward, origin at the centre on the road.
import { MeshBuilder, type RGB, type V2 } from './builder';
import { P, beam, noseDecal, noseLamp, railBody, roofPod, sideDoor, type Nose } from './rail';

const BUS_HALF: V2[] = [[1.2, 0.32], [1.295, 0.45], [1.295, 0.75], [1.295, 1.02], [1.295, 1.12], [1.295, 2.55], [1.295, 2.75], [1.2, 3.0], [0, 3.04]];
const busSide = (y: number): RGB => (y < 0.75 ? P.white : y < 1.02 ? P.tint : y < 1.12 ? P.white : y < 2.55 ? P.charcoal : P.white);
const busFront = (y: number): RGB => (y < 0.75 ? P.black : y < 1.02 ? P.tint : y < 1.12 ? P.white : y < 2.55 ? P.glass : y < 2.75 ? P.black : P.white);
const busRear = (y: number): RGB => (y < 0.62 ? P.black : y < 2.1 ? P.white : y < 2.55 ? P.glass : P.white);

export type BusPart = 'rigid' | 'artic-front' | 'artic-rear';
export const BUS_LEN: Record<BusPart, number> = { rigid: 12.19, 'artic-front': 11.0, 'artic-rear': 7.3 };

export function novaBus(part: BusPart, low = false) {
  const L = BUS_LEN[part], W = 2.59, H = 3.28;
  const b = new MeshBuilder();
  const hasFront = part !== 'artic-rear', hasRear = part !== 'artic-front';
  const front: Nose = {
    prof: [0.24, 0.3, 0.3, 0.3, 0.3, 0.19, 0.15, 0.06, 0],
    taper: [0.92, 0.94, 0.94, 0.94, 0.94, 0.95, 0.95, 0.9, 1],
    front: busFront,
    side: (y, seg) => (seg === 0 ? busSide(y) : busFront(y)),
  };
  const rear: Nose = {
    prof: [0.1, 0.14, 0.14, 0.14, 0.14, 0.12, 0.1, 0.05, 0],
    taper: [0.94, 0.95, 0.95, 0.95, 0.95, 0.95, 0.94, 0.9, 1],
    front: busRear,
    side: (y) => busSide(y),
  };
  const info = railBody(b, {
    L, half: BUS_HALF, side: busSide, end: P.charcoal, low, endInset: 0.3,
    front: hasFront ? front : undefined, back: hasRear ? rear : undefined,
  });
  const z = 1.295 + 0.012;
  const axles = part === 'rigid' ? [L / 2 - 2.45, L / 2 - 2.45 - 6.2] : part === 'artic-front' ? [L / 2 - 2.45, L / 2 - 2.45 - 6.2] : [0.17];
  if (low) {
    b.band(BUS_HALF, info.xb0 + 0.4, info.xb1 - 0.2, 1.2, 2.5, P.glass, 0, 0.02);
    for (const x of axles) b.box(x - 0.5, x + 0.5, 0, 1.0, -1.31, 1.31, P.rubber, 0, 'bottom top');
    return { b, L, H, W };
  }
  // livery roof-line stripe
  b.band(BUS_HALF, info.xb0 + 0.05, info.xb1 - 0.05, 2.6, 2.7, P.tint, 0, 0.01);
  // wheels + black arches
  for (const x of axles) {
    const arch: V2[] = [];
    for (let i = 0; i <= 8; i++) arch.push([x + Math.cos((i / 8) * Math.PI) * 0.66, 0.5 + Math.sin((i / 8) * Math.PI) * 0.66]);
    arch.push([x - 0.66, 0.32], [x + 0.66, 0.32]);
    b.sidePoly(arch, z + 0.002, P.black);
    b.wheelPair(x, 0.5, 0.32, 1.32, P.rubber, P.silver, 0.58, 10);
  }
  // doors (right side) + windows
  const doors: number[] = part === 'rigid' ? [L / 2 - 1.15, -0.7] : part === 'artic-front' ? [L / 2 - 1.15, -0.3] : [-1.3];
  for (const x of doors) {
    sideDoor(b, info, x, 1.15, 0.4, 2.62, { frame: P.charcoal, leaf: P.glassTint, win: [0.6, 2.5], side: 1, eps: 0.018, winColor: P.glass });
  }
  const winStart = info.xb0 + (hasRear ? 1.0 : 0.4), winEnd = info.xb1 - (hasFront ? 1.8 : 0.4);
  const n = Math.max(1, Math.round((winEnd - winStart) / 1.55));
  const w = (winEnd - winStart) / n;
  for (let k = 0; k < n; k++) {
    const x0 = winStart + k * w + 0.06, x1 = winStart + (k + 1) * w - 0.06;
    for (const s of [1, -1] as const) {
      if (s > 0 && doors.some((d) => x1 > d - 0.7 && x0 < d + 0.7)) continue;
      b.sideWindow(x0, x1, 1.2, 2.5, z, P.silverDark, 0.1, s);
      b.sideWindow(x0 + 0.05, x1 - 0.05, 1.25, 2.45, z + 0.005, P.glass, 0.08, s);
    }
  }
  if (hasFront) {
    // driver's side window
    b.sideWindow(info.xb1 - 1.7, info.xb1 - 0.1, 1.2, 2.5, z, P.glass, 0.08, -1);
    for (const s of [1, -1]) {
      noseLamp(b, info, 1, 0.9, s * 1.1, 0.08, P.head);
      noseLamp(b, info, 1, 0.9, s * 0.9, 0.07, P.head);
      noseDecal(b, info, 1, 1.02, 1.1, s * 1.1, 0.1, s > 0 ? P.indR : P.indL);
      // mirror on an arm
      const xf = info.noseX(1, 2.3);
      beam(b, xf - 0.1, 2.45, xf + 0.15, 2.45, s * 1.35, 0.1, 0.05, P.black);
      b.box(xf + 0.05, xf + 0.2, 1.95, 2.45, s * 1.42 - 0.08, s * 1.42 + 0.08, P.black);
    }
    noseDecal(b, info, 1, 2.58, 2.73, 0, 0.9, P.sign);
    noseDecal(b, info, 1, 0.45, 0.55, 0, 0.3, P.white); // plate
  }
  if (hasRear) {
    for (const s of [1, -1]) {
      noseDecal(b, info, -1, 0.8, 1.35, s * 1.1, 0.1, P.tail);
      noseDecal(b, info, -1, 1.38, 1.5, s * 1.1, 0.1, s > 0 ? P.indR : P.indL);
    }
    noseDecal(b, info, -1, 0.85, 1.7, 0, 0.75, P.grille);
    noseDecal(b, info, -1, 2.6, 2.72, 0, 0.5, P.sign);
  }
  if (!hasFront || !hasRear) {
    // articulation bellows half
    const x = hasFront ? info.xb0 : info.xb1;
    b.box(Math.min(x, x + (hasFront ? -0.3 : 0.3)), Math.max(x, x + (hasFront ? -0.3 : 0.3)), 0.4, 2.95, -1.2, 1.2, P.rubber, 0, 'bottom');
  }
  // roof pods: HVAC over the rear, hybrid battery / electric pod mid-front
  if (hasRear) roofPod(b, info.xb0 + 0.4, info.xb0 + 2.8, 2.98, 3.28, 1.05, P.white, P.grille);
  if (hasFront) roofPod(b, part === 'rigid' ? -1.0 : -2.5, part === 'rigid' ? 3.4 : 2.5, 2.98, 3.2, 0.95, P.white);
  return { b, L, H, W };
}
