// Stylised low-poly vehicle + pedestrian models for instanced rendering.
// Local frame: +x forward, +y up, +z right; origin on the ground at the
// vehicle centre. Vertex attributes: position, normal, color (linear),
// tint (1 = multiply by the instance body colour), lamp (1 head, 2 tail,
// 3 indicator) and, for pedestrians, swing (limb swing weight).
import * as THREE from 'three/webgpu';

interface Part {
  /** bottom rectangle x0,x1 / z half-width and top rectangle (for tapered cabins) */
  x0: number; x1: number; y0: number; y1: number; hw: number;
  tx0?: number; tx1?: number; thw?: number;
  color: [number, number, number];
  tint?: number;
  lamp?: number;
  /** swing weight at the bottom / top of the part (pedestrian limbs) */
  swing?: [number, number];
  /** z centre offset (limbs) */
  zc?: number;
}

const GLASS: [number, number, number] = [0.035, 0.045, 0.06];
const DARK: [number, number, number] = [0.025, 0.025, 0.028];
const TRIM: [number, number, number] = [0.08, 0.08, 0.085];
const BODY: [number, number, number] = [1, 1, 1];
const HEAD: [number, number, number] = [0.95, 0.93, 0.85];
const TAIL: [number, number, number] = [0.5, 0.03, 0.02];

function build(parts: Part[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], tint: number[] = [], lamp: number[] = [], swing: number[] = [];
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const p of parts) {
    const zc = p.zc ?? 0;
    const tx0 = p.tx0 ?? p.x0, tx1 = p.tx1 ?? p.x1, thw = p.thw ?? p.hw;
    // 8 corners: bottom (y0) then top (y1); order: (x0,-z) (x1,-z) (x1,+z) (x0,+z)
    const C = [
      [p.x0, p.y0, zc - p.hw], [p.x1, p.y0, zc - p.hw], [p.x1, p.y0, zc + p.hw], [p.x0, p.y0, zc + p.hw],
      [tx0, p.y1, zc - thw], [tx1, p.y1, zc - thw], [tx1, p.y1, zc + thw], [tx0, p.y1, zc + thw],
    ];
    const quads = [
      [0, 1, 2, 3], // bottom
      [4, 7, 6, 5], // top
      [0, 4, 5, 1], // -z side
      [2, 6, 7, 3], // +z side
      [1, 5, 6, 2], // front (+x)
      [3, 7, 4, 0], // back
    ];
    for (const q of quads) {
      a.fromArray(C[q[0]]); b.fromArray(C[q[1]]); c.fromArray(C[q[2]]);
      const n = new THREE.Vector3().subVectors(c, b).cross(v.subVectors(a, b)).normalize();
      for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
        for (const k of tri) {
          const pt = C[k];
          pos.push(pt[0], pt[1], pt[2]);
          nor.push(n.x, n.y, n.z);
          col.push(...p.color);
          tint.push(p.tint ?? 0);
          lamp.push(p.lamp ?? 0);
          const sw = p.swing ? (pt[1] === p.y0 ? p.swing[0] : p.swing[1]) : 0;
          swing.push(sw);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 1));
  g.setAttribute('lamp', new THREE.Float32BufferAttribute(lamp, 1));
  g.setAttribute('swing', new THREE.Float32BufferAttribute(swing, 1));
  g.computeBoundingSphere();
  return g;
}

function wheels(xs: number[], hw: number, r: number): Part[] {
  return xs.flatMap((x) => [
    { x0: x - r, x1: x + r, y0: 0, y1: 2 * r, hw: 0.12, zc: -(hw - 0.1), color: DARK },
    { x0: x - r, x1: x + r, y0: 0, y1: 2 * r, hw: 0.12, zc: hw - 0.1, color: DARK },
  ]);
}

function lamps(xFront: number, xBack: number, y: number, hw: number, h = 0.12): Part[] {
  return [
    { x0: xFront - 0.02, x1: xFront + 0.03, y0: y, y1: y + h, hw: 0.16, zc: -(hw - 0.3), color: HEAD, lamp: 1 },
    { x0: xFront - 0.02, x1: xFront + 0.03, y0: y, y1: y + h, hw: 0.16, zc: hw - 0.3, color: HEAD, lamp: 1 },
    { x0: xBack - 0.03, x1: xBack + 0.02, y0: y + 0.05, y1: y + 0.05 + h, hw: 0.16, zc: -(hw - 0.25), color: TAIL, lamp: 2 },
    { x0: xBack - 0.03, x1: xBack + 0.02, y0: y + 0.05, y1: y + 0.05 + h, hw: 0.16, zc: hw - 0.25, color: TAIL, lamp: 2 },
  ];
}

/** Variant order matches the sim's vehicle kinds: sedan, hatchback, SUV, pickup, van, box truck. */
export function carGeometries(): THREE.BufferGeometry[] {
  const sedan = build([
    { x0: -2.35, x1: 2.35, y0: 0.28, y1: 0.8, hw: 0.91, tx0: -2.3, tx1: 2.25, color: BODY, tint: 1 },
    { x0: -2.36, x1: 2.36, y0: 0.24, y1: 0.4, hw: 0.92, color: TRIM },
    { x0: -1.35, x1: 1.0, y0: 0.8, y1: 1.38, hw: 0.86, tx0: -0.95, tx1: 0.45, thw: 0.72, color: GLASS },
    { x0: -0.95, x1: 0.45, y0: 1.38, y1: 1.44, hw: 0.72, color: BODY, tint: 1 },
    ...wheels([-1.4, 1.4], 0.9, 0.33),
    ...lamps(2.33, -2.33, 0.6, 0.91),
  ]);
  const hatch = build([
    { x0: -2.05, x1: 2.05, y0: 0.28, y1: 0.82, hw: 0.89, tx0: -2.0, tx1: 1.95, color: BODY, tint: 1 },
    { x0: -2.06, x1: 2.06, y0: 0.24, y1: 0.4, hw: 0.9, color: TRIM },
    { x0: -2.0, x1: 0.85, y0: 0.82, y1: 1.44, hw: 0.84, tx0: -1.85, tx1: 0.3, thw: 0.72, color: GLASS },
    { x0: -1.85, x1: 0.3, y0: 1.44, y1: 1.5, hw: 0.72, color: BODY, tint: 1 },
    ...wheels([-1.25, 1.3], 0.88, 0.32),
    ...lamps(2.03, -2.03, 0.62, 0.89),
  ]);
  const suv = build([
    { x0: -2.45, x1: 2.45, y0: 0.36, y1: 1.02, hw: 0.97, tx0: -2.42, tx1: 2.3, color: BODY, tint: 1 },
    { x0: -2.46, x1: 2.46, y0: 0.3, y1: 0.5, hw: 0.98, color: TRIM },
    { x0: -2.4, x1: 1.05, y0: 1.02, y1: 1.68, hw: 0.93, tx0: -2.3, tx1: 0.55, thw: 0.82, color: GLASS },
    { x0: -2.3, x1: 0.55, y0: 1.68, y1: 1.76, hw: 0.82, color: BODY, tint: 1 },
    ...wheels([-1.5, 1.5], 0.96, 0.38),
    ...lamps(2.43, -2.43, 0.78, 0.97),
  ]);
  const pickup = build([
    { x0: -2.8, x1: 2.8, y0: 0.42, y1: 1.08, hw: 1.0, tx1: 2.7, color: BODY, tint: 1 },
    { x0: -2.81, x1: 2.81, y0: 0.36, y1: 0.55, hw: 1.01, color: TRIM },
    { x0: -2.55, x1: -0.35, y0: 0.95, y1: 1.09, hw: 0.86, color: DARK },
    { x0: -0.3, x1: 1.25, y0: 1.08, y1: 1.84, hw: 0.95, tx0: -0.25, tx1: 0.8, thw: 0.84, color: GLASS },
    { x0: -0.25, x1: 0.8, y0: 1.84, y1: 1.9, hw: 0.84, color: BODY, tint: 1 },
    ...wheels([-1.85, 1.65], 0.99, 0.4),
    ...lamps(2.78, -2.78, 0.85, 1.0),
  ]);
  const van = build([
    { x0: -2.65, x1: 1.75, y0: 0.36, y1: 2.05, hw: 0.99, tx1: 1.55, thw: 0.95, color: BODY, tint: 1 },
    { x0: 1.75, x1: 2.65, y0: 0.36, y1: 1.12, hw: 0.99, tx1: 2.55, color: BODY, tint: 1 },
    { x0: 1.45, x1: 1.9, y0: 1.12, y1: 1.9, hw: 0.97, tx0: 1.3, tx1: 1.5, thw: 0.93, color: GLASS },
    { x0: -0.2, x1: 1.4, y0: 1.3, y1: 1.78, hw: 1.0, color: GLASS },
    { x0: -2.66, x1: 2.66, y0: 0.3, y1: 0.5, hw: 1.0, color: TRIM },
    ...wheels([-1.75, 1.7], 0.98, 0.36),
    ...lamps(2.63, -2.63, 0.75, 0.99),
  ]);
  const truck = build([
    // cab
    { x0: 2.25, x1: 4.3, y0: 0.55, y1: 2.9, hw: 1.2, tx1: 4.1, color: BODY, tint: 1 },
    { x0: 3.65, x1: 4.12, y0: 1.75, y1: 2.65, hw: 1.21, tx1: 3.95, color: GLASS },
    // cargo box (plain white/grey, not tinted)
    { x0: -4.3, x1: 2.15, y0: 0.95, y1: 3.45, hw: 1.25, color: [0.86, 0.87, 0.86] },
    // chassis
    { x0: -4.2, x1: 4.3, y0: 0.5, y1: 0.95, hw: 1.05, color: TRIM },
    ...wheels([-2.9, -1.9, 3.1], 1.15, 0.48),
    ...lamps(4.29, -4.3, 0.75, 1.2),
  ]);
  return [sedan, hatch, suv, pickup, van, truck];
}

/** Real-world lengths per variant (sim uses the same numbers). */
export const CAR_LENGTH = [4.7, 4.1, 4.9, 5.6, 5.3, 8.6];

export function pedestrianGeometry(): THREE.BufferGeometry {
  const PANTS: [number, number, number] = [0.07, 0.08, 0.12];
  const SKIN: [number, number, number] = [0.55, 0.38, 0.28];
  const HAIR: [number, number, number] = [0.05, 0.035, 0.025];
  const SHOE: [number, number, number] = [0.03, 0.03, 0.03];
  return build([
    { x0: -0.08, x1: 0.08, y0: 0.08, y1: 0.88, hw: 0.075, zc: -0.1, color: PANTS, swing: [1, 0] },
    { x0: -0.08, x1: 0.08, y0: 0.08, y1: 0.88, hw: 0.075, zc: 0.1, color: PANTS, swing: [-1, 0] },
    { x0: -0.1, x1: 0.13, y0: 0, y1: 0.08, hw: 0.075, zc: -0.1, color: SHOE, swing: [1, 1] },
    { x0: -0.1, x1: 0.13, y0: 0, y1: 0.08, hw: 0.075, zc: 0.1, color: SHOE, swing: [-1, -1] },
    { x0: -0.12, x1: 0.12, y0: 0.86, y1: 1.46, hw: 0.21, thw: 0.23, color: BODY, tint: 1 },
    { x0: -0.06, x1: 0.06, y0: 0.82, y1: 1.42, hw: 0.05, zc: -0.27, color: BODY, tint: 1, swing: [-0.6, 0] },
    { x0: -0.06, x1: 0.06, y0: 0.82, y1: 1.42, hw: 0.05, zc: 0.27, color: BODY, tint: 1, swing: [0.6, 0] },
    { x0: -0.1, x1: 0.1, y0: 1.47, y1: 1.7, hw: 0.09, color: SKIN },
    { x0: -0.11, x1: 0.09, y0: 1.66, y1: 1.76, hw: 0.1, color: HAIR },
  ]);
}

// realistic body colour mix (white/black/grey/silver dominate)
const CAR_COLORS = [
  0xf1f1ef, 0xeeeeec, 0xe8e8e6, 0x16171a, 0x1c1d21, 0x2a2c30, 0x85888c, 0x6d7074,
  0xb9bcbf, 0xc8cacc, 0x1e3a6e, 0x2b4f8c, 0x8e1a1a, 0xa42a22, 0x2f4a38, 0x7a6a55,
];
export const carPalette = CAR_COLORS.map((c) => new THREE.Color(c));

const SHIRTS = [
  0x2f3d5c, 0x9a2b2b, 0xe0ddd6, 0x1e1e22, 0x3d6b4f, 0xc79a3b, 0x6b4c8a, 0x4f7fa8,
  0xd46a3a, 0x7b7f86, 0xb5b0a5, 0x274d6e,
];
export const shirtPalette = SHIRTS.map((c) => new THREE.Color(c));
