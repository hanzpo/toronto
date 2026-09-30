// Low-poly street props (metres; +x = the way the prop faces, usually toward
// the road; origin on the ground). Vertex colour alpha tags: 1 = lamp (emissive
// at night), 0.3 = tinted by the instance variant (house bins), 0.6 = backlit
// panel (shelter ads, pay-station screen), 0.8 = blade face (street-name atlas).
import * as THREE from 'three/webgpu';
import { Geo } from '../street/geometry';

type C = number[];
const lin = (hex: number, a = 0): C => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map((v) => Math.pow(v, 2.2)).concat(a);

const STEEL = lin(0x8d9296), DARKSTEEL = lin(0x3b3f43), BLACK = lin(0x1c1d1f), CONC = lin(0xa9a59d), WOOD = lin(0x6b5a48);
const TTC_RED = lin(0xda241f), WHITE = lin(0xf2f2ee), HYD_RED = lin(0xc4271e), HYD_YEL = lin(0xf2c200);
const CP_RED = lin(0xd52b1e), GREEN_P = lin(0x2f8f3a), SIGN_GREEN = lin(0x0f6b3d), POLE_WOOD = lin(0x5c4a3a);

function build(g: Geo): THREE.BufferGeometry {
  const b = g.build();
  return b;
}

/** Toronto fire hydrant: red barrel, yellow bonnet, two side nozzles + pumper */
export function hydrant() {
  const g = new Geo();
  g.prism(0, 0, 0, 0.06, 0.17, 0.17, 6, HYD_RED);
  g.prism(0, 0, 0.06, 0.6, 0.12, 0.11, 6, HYD_RED);
  g.prism(0, 0, 0.6, 0.74, 0.13, 0.04, 6, HYD_YEL);
  g.box(0.08, 0.34, -0.05, 0.2, 0.46, 0.05, HYD_YEL);
  g.box(-0.05, 0.38, 0.08, 0.05, 0.47, 0.17, HYD_RED);
  g.box(-0.05, 0.38, -0.17, 0.05, 0.47, -0.08, HYD_RED);
  return build(g);
}

/** Astral-style litter bin: dark grey column, coloured recycling slots */
export function litterBin() {
  const g = new Geo();
  g.box(-0.24, 0, -0.34, 0.24, 1.05, 0.34, DARKSTEEL);
  g.box(0.241, 0.7, -0.3, 0.25, 0.86, -0.02, lin(0x1f5fa8));
  g.box(0.241, 0.7, 0.02, 0.25, 0.86, 0.3, lin(0x6d6d6d));
  g.box(-0.26, 1.05, -0.36, 0.26, 1.1, 0.36, BLACK);
  return build(g);
}

/** a bank of three newspaper boxes (Star blue, Metro green, Sun yellow) */
export function newsBoxes() {
  const g = new Geo();
  const cols = [lin(0x1b4f9c), lin(0x2d8a3e), lin(0xe8c21a)];
  for (let i = 0; i < 3; i++) {
    const z0 = -0.8 + i * 0.54;
    g.box(-0.22, 0.25, z0, 0.22, 1.0, z0 + 0.48, cols[i]);
    g.box(0.221, 0.6, z0 + 0.06, 0.23, 0.92, z0 + 0.42, lin(0x9aa4aa));
    g.box(-0.02, 0, z0 + 0.2, 0.02, 0.25, z0 + 0.28, DARKSTEEL);
  }
  return build(g);
}

/** Canada Post street letter box */
export function postBox() {
  const g = new Geo();
  g.box(-0.25, 0, -0.28, 0.25, 1.15, 0.28, CP_RED);
  g.prism(0, 0, 1.15, 1.3, 0.3, 0.12, 6, CP_RED);
  g.box(0.251, 0.95, -0.18, 0.26, 1.03, 0.18, WHITE);
  g.box(0.251, 0.7, -0.14, 0.26, 0.76, 0.14, BLACK);
  return build(g);
}

/** slatted bench with back, facing +x */
export function bench() {
  const g = new Geo();
  const slat = lin(0x5b4330), frame = lin(0x2c3a30);
  g.box(-0.22, 0.42, -0.9, 0.22, 0.47, 0.9, slat);
  g.box(-0.26, 0.55, -0.9, -0.21, 0.9, 0.9, slat);
  for (const z of [-0.8, 0.8]) { g.box(-0.2, 0, z - 0.03, 0.18, 0.42, z + 0.03, frame); g.box(-0.26, 0.42, z - 0.03, -0.2, 0.9, z + 0.03, frame); }
  return build(g);
}

/** Toronto post-and-ring bike stand */
export function bikeRing() {
  const g = new Geo();
  g.prism(0, 0, 0, 1.0, 0.03, 0.03, 6, STEEL);
  const n = 10, R = 0.26, r = 0.015, y0 = 0.72;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (a: number, s: number): [number, number, number] => [Math.cos(a) * (R + s), y0 + Math.sin(a) * (R + s), 0];
    g.quad(p(a0, -r), p(a1, -r), p(a1, r), p(a0, r), STEEL);
    g.quad(p(a0, r), p(a1, r), p(a1, -r), p(a0, -r), STEEL);
  }
  return build(g);
}

/** Green P pay-and-display machine */
export function payStation() {
  const g = new Geo();
  g.box(-0.16, 0, -0.2, 0.16, 1.55, 0.2, lin(0x30343a));
  g.box(0.161, 1.1, -0.12, 0.17, 1.35, 0.12, lin(0x9fd3b0, 0.6));
  g.box(-0.18, 1.55, -0.22, 0.18, 1.72, 0.22, GREEN_P);
  return build(g);
}

/** concrete planter with shrubs */
export function planter() {
  const g = new Geo();
  g.box(-0.45, 0, -0.9, 0.45, 0.6, 0.9, CONC);
  g.box(-0.4, 0.6, -0.85, 0.4, 0.62, 0.85, lin(0x3b2e22));
  g.blob(0, 0.85, -0.4, 0.4, 0.35, 0.42, 0, lin(0x3f6b2e, 0.05), lin(0x22401a, 0.05), 1);
  g.blob(0, 0.8, 0.42, 0.38, 0.3, 0.4, 0, lin(0x4a7a33, 0.05), lin(0x27461c, 0.05), 2);
  return build(g);
}

/** street-name blade pole (the blades are a separate pool) */
export function bladePole() {
  const g = new Geo();
  g.prism(0, 0, 0, 3.5, 0.045, 0.04, 6, STEEL);
  g.prism(0, 0, 3.5, 3.56, 0.05, 0.02, 6, STEEL);
  return build(g);
}

/** one street-name blade (1.1 × 0.24 m), centred on the pole, long axis along x; faces carry atlas uvs */
export function blade() {
  const g = new THREE.BoxGeometry(1.1, 0.24, 0.025);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(uv.count * 4);
  const face = lin(0x0f6b3d, 0.8), edge = lin(0x0f6b3d, 0);
  for (let i = 0; i < uv.count; i++) {
    const front = Math.abs(n.getZ(i)) > 0.9;
    const c = front ? face : edge;
    col.set(c, i * 4);
    // mirror the back face so the text reads left-to-right from both sides
    if (front && n.getZ(i) < 0) uv.setX(i, 1 - uv.getX(i));
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const ng = g.toNonIndexed();
  g.dispose();
  return ng;
}

/** wooden hydro pole with crossarm, insulators, optional transformer (variant) */
export function hydroPole(transformer: boolean) {
  const g = new Geo();
  g.prism(0, 0, 0, 11.2, 0.15, 0.12, 6, POLE_WOOD);
  // crossarms across the line (local x: toward the road), conductors run along local z
  g.box(-1.2, 10.25, -0.06, 1.2, 10.4, 0.06, WOOD);
  for (const x of [-1.05, 0, 1.05]) g.prism(x, 0, 10.4, 10.62, 0.04, 0.03, 5, lin(0x6f8a94));
  g.box(-0.7, 9.2, -0.05, 0.7, 9.3, 0.05, WOOD);
  if (transformer) g.prism(-0.35, 0, 7.6, 8.8, 0.3, 0.3, 8, lin(0x6d7478));
  return build(g);
}

/** three sagging conductors from x=0 to x=1 (scaled to the span); strands at z = −1.05, 0, 1.05; y relative to the pole base */
export function wireSpan() {
  const g = new Geo();
  const seg = 6, w = 0.025;
  for (const z of [-1.05, 0, 1.05]) {
    const y = 10.62;
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg, t1 = (i + 1) / seg;
      const s0 = -4 * t0 * (1 - t0) * 0.55, s1 = -4 * t1 * (1 - t1) * 0.55;
      const a: [number, number, number] = [t0, y + s0 - w, z], b: [number, number, number] = [t1, y + s1 - w, z];
      const c: [number, number, number] = [t1, y + s1 + w, z], d: [number, number, number] = [t0, y + s0 + w, z];
      g.quad(a, b, c, d, BLACK); g.quad(d, c, b, a, BLACK);
    }
  }
  return build(g);
}

/** green highway guide sign on two posts, facing +x (4.4 × 2.6 m panel, fake legend) */
export function highwaySign() {
  const g = new Geo();
  for (const z of [-1.6, 1.6]) g.prism(-0.1, z, 0, 5.4, 0.1, 0.1, 6, STEEL);
  g.box(-0.05, 2.8, -2.2, 0.05, 5.4, 2.2, SIGN_GREEN);
  g.box(0.051, 2.86, -2.14, 0.06, 5.34, 2.14, WHITE);
  g.box(0.061, 2.93, -2.07, 0.07, 5.27, 2.07, SIGN_GREEN);
  // legend: two destination lines + route shield + exit arrow
  g.box(0.071, 4.55, -1.6, 0.08, 4.85, 1.1, WHITE);
  g.box(0.071, 3.95, -1.6, 0.08, 4.25, 0.7, WHITE);
  g.box(0.071, 4.0, 1.25, 0.08, 4.85, 1.85, WHITE);
  g.box(0.071, 3.1, 1.5, 0.08, 3.7, 1.62, WHITE);
  g.box(0.071, 3.45, 1.3, 0.08, 3.7, 1.82, WHITE);
  return build(g);
}

/** Toronto curbside bin (tinted per variant: blue recycling, green organics, grey garbage) */
export function houseBin() {
  const g = new Geo();
  const t = [1, 1, 1, 0.3];
  g.box(-0.3, 0.05, -0.33, 0.3, 1.0, 0.33, t);
  g.box(-0.33, 1.0, -0.35, 0.34, 1.06, 0.35, t);
  for (const z of [-0.26, 0.26]) g.prism(-0.28, z, 0, 0.12, 0.08, 0.08, 6, BLACK);
  return build(g);
}

/** unit flat quad x,z ∈ [-½, ½] at y = 0 (lot pads, stripes, driveways) */
export function flatQuad() {
  const g = new Geo();
  g.quad([-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5], [1, 1, 1, 0]);
  return build(g);
}

/** parking-lot light standard: 9 m pole, two shoebox heads */
export function lotLight() {
  const g = new Geo();
  g.box(-0.3, 0, -0.3, 0.3, 0.5, 0.3, CONC);
  g.prism(0, 0, 0.5, 9.2, 0.09, 0.07, 6, STEEL);
  g.box(-1.3, 9.1, -0.06, 1.3, 9.2, 0.06, STEEL);
  for (const x of [-1.3, 1.3]) { g.box(x - 0.35, 9.0, -0.25, x + 0.35, 9.25, 0.25, DARKSTEEL); g.box(x - 0.3, 8.99, -0.2, x + 0.3, 9.0, 0.2, [1, 1, 1, 1]); }
  return build(g);
}

/** Bike Share Toronto dock (+ bike when docked); variant with the pay terminal */
export function bikeDock(terminal: boolean, bike: boolean) {
  const g = new Geo();
  const plate = lin(0x3a3d40);
  g.box(-1.3, 0, -0.1, 0.5, 0.04, 0.1, plate);
  g.box(0.25, 0, -0.08, 0.45, 0.8, 0.08, lin(0x2a2c2e));
  g.box(0.451, 0.62, -0.05, 0.46, 0.72, 0.05, lin(0x3cb043, 1));
  if (terminal) {
    g.box(-0.6, 0, -0.3, 0.1, 2.3, 0.3, lin(0x2a2c2e));
    g.box(0.101, 1.3, -0.25, 0.11, 2.1, 0.25, lin(0xdfe6ea, 0.6));
    g.box(-0.62, 2.1, -0.32, 0.12, 2.3, 0.32, lin(0x3cb043));
  }
  if (bike) {
    const frame = lin(0x2c2f33), tyre = BLACK, acc = lin(0x3cb043);
    for (const x of [-1.05, 0.05]) {
      const n = 8, R = 0.33;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        const p = (a: number, r: number): [number, number, number] => [x + Math.cos(a) * r, 0.35 + Math.sin(a) * r, 0];
        g.quad(p(a0, R - 0.05), p(a1, R - 0.05), p(a1, R), p(a0, R), tyre);
        g.quad(p(a0, R), p(a1, R), p(a1, R - 0.05), p(a0, R - 0.05), tyre);
      }
    }
    g.box(-1.05, 0.33, -0.03, 0.05, 0.4, 0.03, frame);
    g.box(-0.6, 0.35, -0.03, -0.52, 0.95, 0.03, frame);
    g.box(-0.7, 0.93, -0.1, -0.45, 0.98, 0.1, BLACK);
    g.box(-0.05, 0.4, -0.03, 0.03, 1.05, 0.03, frame);
    g.box(-0.05, 1.0, -0.3, 0.03, 1.05, 0.3, frame);
    g.box(-1.2, 0.62, -0.08, -0.85, 0.66, 0.08, acc);
    g.box(0.0, 0.62, -0.12, 0.25, 0.8, 0.12, acc);
  }
  return build(g);
}

/** TTC stop pole: red-and-white flag sign */
export function busPole() {
  const g = new Geo();
  g.prism(0, 0, 0, 2.9, 0.035, 0.035, 6, STEEL);
  g.box(-0.02, 2.2, 0.04, 0.02, 2.85, 0.5, TTC_RED);
  g.box(-0.025, 2.55, 0.06, 0.025, 2.72, 0.48, WHITE);
  g.box(-0.025, 2.28, 0.06, 0.025, 2.36, 0.48, WHITE);
  g.box(-0.04, 1.4, -0.12, 0.04, 1.9, 0.12, lin(0x222222));
  return build(g);
}

/** Astral TTC shelter: glass box with roof, ad panel at one end, bench; opening toward +x */
export function shelter() {
  const g = new Geo();
  const frame = lin(0x3d4246), glass = lin(0x9fb3bd), roof = lin(0x5a6066);
  const L = 1.9, D = 0.8, H = 2.4;
  for (const [x, z] of [[-D, -L], [-D, L], [D, -L], [D, L]]) g.box(x - 0.04, 0, z - 0.04, x + 0.04, H, z + 0.04, frame);
  g.box(-D - 0.1, H, -L - 0.15, D + 0.2, H + 0.12, L + 0.15, roof);
  g.box(-D - 0.02, 0.15, -L, -D + 0.02, H - 0.1, L, glass);
  g.box(-D, 0.15, -L - 0.02, D * 0.2, H - 0.1, -L + 0.02, glass);
  g.box(-D, 0.15, L - 0.03, D, H - 0.1, L + 0.03, lin(0xe8eef2, 0.6));
  g.box(-D + 0.05, 0.45, -1.2, -D + 0.45, 0.5, 0.9, lin(0x6d7276));
  return build(g);
}
