// Low-poly apron furniture (docs/AIR.md "Apron"): ground support equipment, passenger
// boarding bridge parts and floodlight masts, built with models/builder.ts (flat-shaded,
// per-vertex colour, lamp / glass tags) and drawn instanced by air/apron/ApronFurniture.ts.
//
// Frames: x = forward (vehicle front / bridge axis), y = up, z = right; origin on the ground
// at the footprint centre unless noted. Dimensions from manufacturer data sheets (TLD
// TMX-150 baggage tractor, Aero Specialties / Fox baggage cart, TLD NBL-E belt loader,
// Garsite / Rampmaster 10 000 gal fueler, Mallaghan / Global catering hi-lift, TLD TPX-100
// towbarless and a conventional Eagle TT-8 pushback tractor, JBT / ThyssenKrupp apron-drive
// passenger boarding bridges, 30 m high-mast apron lighting).
import * as THREE from 'three/webgpu';
import { attribute, float, mix, step, fract, vec3, mod, floor } from 'three/tsl';
import { MeshBuilder, paint, rgb, type RGB } from '../../models/builder';
import { U } from '../../render/uniforms';

export const GSE_KINDS = ['tug', 'cart', 'belt', 'fuel', 'cater', 'push', 'gpu'] as const;
export type GseKind = (typeof GSE_KINDS)[number];

const TYRE = rgb(0x1c1c1c), RIM = rgb(0x8a8a8a), STEEL = rgb(0x7d8085), DARK = rgb(0x2b2d30);
const GLASS = paint(0x39424a, { glass: 1 });
const BEACON = paint(0xffa21a, { lamp: 2 });
const HEAD = paint(0xfff4d6, { lamp: 1 });

function wheels(b: MeshBuilder, xs: number[], r: number, w: number, zo: number) {
  for (const x of xs) b.wheelPair(x, r, w, zo, TYRE, RIM, 0.55, 6);
}

function finish(b: MeshBuilder): THREE.BufferGeometry {
  const g = b.build();
  g.deleteAttribute('livery');
  g.deleteAttribute('sign');
  return g;
}

/** baggage tractor (TLD TMX-150 class): 2.9 × 1.4 m, open cab with a canopy */
function tug(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const body = rgb(0xe3a716);
  b.box(-1.45, 1.45, 0.3, 0.75, -0.68, 0.68, DARK);
  b.box(0.35, 1.45, 0.75, 1.25, -0.66, 0.66, body); // engine hood (front)
  b.box(-1.45, -0.95, 0.75, 1.15, -0.66, 0.66, body); // rear deck
  b.box(-0.8, 0.0, 0.75, 1.1, -0.45, 0.45, DARK); // seat
  for (const z of [-0.6, 0.6]) for (const x of [-1.35, 0.3]) b.box(x, x + 0.06, 1.1, 2.0, z - 0.03, z + 0.03, DARK);
  b.box(-1.4, 0.4, 2.0, 2.08, -0.68, 0.68, body, 0, ''); // canopy
  b.box(1.4, 1.46, 0.95, 1.1, -0.55, -0.3, HEAD, 0, 'bottom back');
  b.box(1.4, 1.46, 0.95, 1.1, 0.3, 0.55, HEAD, 0, 'bottom back');
  b.box(-0.6, -0.45, 2.08, 2.22, -0.08, 0.08, BEACON);
  b.box(-1.6, -1.45, 0.4, 0.55, -0.12, 0.12, STEEL); // tow hitch
  wheels(b, [-0.85, 0.85], 0.34, 0.24, 0.72);
  return finish(b);
}

/** covered baggage cart: 3.2 × 1.55 m deck, side curtains, drawbar forward */
function cart(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const frame = rgb(0x9a9ea3), curtain = rgb(0x2a4a8a), roof = rgb(0xb8bcc0);
  b.box(-1.6, 1.6, 0.35, 0.5, -0.78, 0.78, frame); // deck
  for (const x of [-1.55, 1.5]) for (const z of [-0.74, 0.7]) b.box(x, x + 0.05, 0.5, 1.9, z, z + 0.04, frame);
  b.box(-1.62, 1.62, 1.9, 1.98, -0.8, 0.8, roof, 0, '');
  b.box(-1.5, 1.5, 0.6, 1.8, -0.79, -0.74, curtain, 0, 'bottom top');
  b.box(-1.5, 1.5, 0.6, 1.8, 0.74, 0.79, curtain, 0, 'bottom top');
  b.box(-1.55, -1.5, 0.55, 1.85, -0.72, 0.72, curtain, 0, 'bottom top');
  // luggage inside (visible through the open front)
  b.box(0.2, 1.3, 0.5, 1.0, -0.6, 0.55, rgb(0x303338));
  b.box(-1.2, 0.1, 0.5, 1.25, -0.55, 0.6, rgb(0x6b2e22));
  b.box(1.6, 2.6, 0.38, 0.45, -0.04, 0.04, DARK); // drawbar
  wheels(b, [-1.05, 1.05], 0.22, 0.14, 0.7);
  return finish(b);
}

/** belt loader (TLD NBL-E): 7.6 m chassis, conveyor raised towards the front (x+) to ~3 m */
function belt(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const body = rgb(0xe9e9e6), frame = rgb(0x3d4148), beltC = rgb(0x151515);
  b.box(-3.6, 3.2, 0.35, 0.85, -0.85, 0.85, body);
  b.box(-3.6, -2.1, 0.85, 2.05, 0.1, 0.95, body); // cab (rear right)
  b.box(-3.55, -2.15, 1.3, 1.95, 0.08, 0.97, GLASS, 0, 'bottom top');
  b.box(-3.0, -2.8, 2.05, 2.18, 0.45, 0.6, BEACON);
  // inclined conveyor: from (x=-3.8, y=1.05) to (x=3.9, y=3.05), 0.9 m wide
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const x0 = -3.8, y0 = 1.05, x1 = 3.9, y1 = 3.05, hw = 0.5, t = 0.35;
  const up = new THREE.Vector3(0, 1, 0);
  b.quad(V(x0, y0, -hw), V(x1, y1, -hw), V(x1, y1, hw), V(x0, y0, hw), beltC, 0, up);
  for (const s of [-1, 1]) {
    const z = s * (hw + 0.06);
    b.quad(V(x0, y0 - t, z), V(x1, y1 - t, z), V(x1, y1 + 0.12, z), V(x0, y0 + 0.12, z), frame, 0, V(0, 0, s));
    // handrail posts + rail
    for (const k of [0.15, 0.5, 0.85]) {
      const x = x0 + (x1 - x0) * k, y = y0 + (y1 - y0) * k;
      b.box(x - 0.03, x + 0.03, y, y + 0.9, z - 0.03, z + 0.03, body);
    }
  }
  b.quad(V(x0, y0 + 0.9, hw + 0.06), V(x1, y1 + 0.9, hw + 0.06), V(x1, y1 + 0.95, hw + 0.06), V(x0, y0 + 0.95, hw + 0.06), body, 0, V(0, 0, 1));
  b.quad(V(x0, y0 - t, -hw - 0.06), V(x1, y1 - t, -hw - 0.06), V(x1, y1 - t, hw + 0.06), V(x0, y0 - t, hw + 0.06), frame, 0, V(0, -1, 0.3));
  // lift struts
  b.box(1.0, 1.2, 0.85, 2.5, -0.35, -0.2, frame);
  b.box(1.0, 1.2, 0.85, 2.5, 0.2, 0.35, frame);
  b.box(3.85, 4.0, 2.95, 3.3, -0.55, 0.55, rgb(0x222222)); // rubber bumper at the door
  wheels(b, [-2.3, 2.2], 0.36, 0.24, 0.92);
  return finish(b);
}

/** apron fuel truck (10 000 gal class): 10 m, tank + cab */
function fuel(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const white = rgb(0xeeeeec), stripe = rgb(0xc3261d), cabC = rgb(0xd9dcde);
  b.box(-4.8, 5.0, 0.55, 1.0, -1.1, 1.1, DARK);
  // cab (front)
  b.box(2.8, 4.9, 1.0, 2.9, -1.2, 1.2, cabC);
  b.box(4.85, 4.95, 1.75, 2.7, -1.05, 1.05, GLASS, 0, 'bottom top back');
  b.box(3.3, 4.6, 1.8, 2.7, -1.22, 1.22, GLASS, 0, 'bottom top front back');
  b.box(3.6, 3.8, 2.9, 3.05, -0.3, 0.3, BEACON);
  b.box(4.95, 5.05, 1.1, 1.3, -1.0, -0.7, HEAD);
  b.box(4.95, 5.05, 1.1, 1.3, 0.7, 1.0, HEAD);
  // elliptical tank (extruded section, z/y)
  const sec: [number, number][] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    sec.push([Math.cos(a) * 1.25, 2.15 + Math.sin(a) * 1.05]);
  }
  b.extrudeX(sec, -4.7, 2.6, (e) => (e === 0 || e === 11 || e === 5 || e === 6 ? stripe : white));
  b.box(-4.9, -4.6, 0.9, 2.6, -0.9, 0.9, STEEL); // rear hose reel cabinet
  b.box(-2.5, 1.5, 3.2, 3.28, -0.4, 0.4, STEEL, 0, ''); // top walkway
  wheels(b, [-3.3, -2.0, 3.6], 0.52, 0.34, 1.22);
  return finish(b);
}

/** catering hi-lift truck: cab + scissor lift + insulated box body (lowered) */
function cater(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const box = rgb(0xf2f2f0), cabC = rgb(0x2d5aa6), frame = rgb(0x4a4d52);
  b.box(-4.2, 3.8, 0.5, 0.95, -1.05, 1.05, DARK);
  b.box(2.2, 3.8, 0.95, 2.8, -1.15, 1.15, cabC);
  b.box(3.75, 3.85, 1.7, 2.6, -1.0, 1.0, GLASS, 0, 'bottom top back');
  b.box(2.6, 3.5, 1.75, 2.6, -1.17, 1.17, GLASS, 0, 'bottom top front back');
  b.box(2.8, 3.0, 2.8, 2.95, -0.3, 0.3, BEACON);
  // scissor (x cross members) + lowered body
  b.box(-3.8, 1.8, 0.95, 1.3, -0.95, -0.85, frame);
  b.box(-3.8, 1.8, 0.95, 1.3, 0.85, 0.95, frame);
  b.box(-4.3, 1.9, 1.3, 4.0, -1.25, 1.25, box);
  b.box(-4.35, -4.25, 1.4, 3.9, -1.1, 1.1, rgb(0xc9ccce)); // rear door
  b.box(-4.9, -4.3, 1.3, 1.4, -1.2, 1.2, frame, 0, ''); // service platform
  wheels(b, [-2.8, 2.8], 0.48, 0.3, 1.15);
  return finish(b);
}

/** conventional pushback tractor (Eagle TT-8 class): low, heavy, cab at the rear */
function push(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const y = rgb(0xe8b21e), k = rgb(0x1e1e1e);
  b.box(-3.0, 3.0, 0.35, 1.25, -1.35, 1.35, y);
  b.box(-3.0, 3.0, 0.35, 0.55, -1.38, 1.38, k); // bumper band
  b.box(-2.7, -1.1, 1.25, 2.35, -0.8, 0.8, y);
  b.box(-2.72, -1.08, 1.5, 2.25, -0.82, 0.82, GLASS, 0, 'bottom top');
  b.box(-2.1, -1.8, 2.35, 2.5, -0.1, 0.1, BEACON);
  b.box(3.0, 3.35, 0.55, 0.85, -0.25, 0.25, k); // tow pin
  b.box(2.95, 3.02, 0.8, 1.0, -1.2, -0.9, HEAD);
  b.box(2.95, 3.02, 0.8, 1.0, 0.9, 1.2, HEAD);
  wheels(b, [-1.9, 1.9], 0.55, 0.42, 1.42);
  return finish(b);
}

/** ground power unit on a small trailer */
function gpu(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const c = rgb(0xd6d8da);
  b.box(-1.2, 1.2, 0.35, 1.55, -0.7, 0.7, c);
  b.box(-1.15, 1.15, 0.6, 1.4, -0.72, -0.7, rgb(0x6f7479), 0, 'bottom top');
  b.box(1.2, 2.0, 0.35, 0.42, -0.04, 0.04, DARK);
  b.box(0.2, 0.6, 1.55, 1.75, -0.2, 0.2, rgb(0x222222)); // cable coil
  wheels(b, [-0.7, 0.7], 0.25, 0.16, 0.66);
  return finish(b);
}

export function gseGeometry(k: GseKind): THREE.BufferGeometry {
  return { tug, cart, belt, fuel, cater, push, gpu }[k]();
}

// ---------------------------------------------------------------------------- boarding bridges

const BR_STEEL = rgb(0xc4c8cc), BR_DARK = rgb(0x7a7f86), BR_ROOF = rgb(0xa5a9ae);
const BR_GLASS = paint(0x6d8290, { glass: 1 });

/** tunnel section: x ∈ [0, 1] (scaled to length), floor at y = 0, 2.6 × 2.9 m section */
export function tunnelGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const hw = 1.3, h = 2.9;
  b.box(0, 1, 0, 0.3, -hw, hw, BR_DARK, 0, 'front back');
  b.box(0, 1, 0.3, 1.1, -hw, hw, BR_STEEL, 0, 'top bottom front back');
  b.box(0, 1, 1.1, 2.25, -hw, hw, BR_GLASS, 0, 'top bottom front back');
  b.box(0, 1, 2.25, h, -hw, hw, BR_STEEL, 0, 'bottom front back');
  b.box(0, 1, h, h + 0.12, -hw * 0.85, hw * 0.85, BR_ROOF, 0, 'bottom front back');
  return finish(b);
}

/** fixed link (terminal → rotunda): as a tunnel, slightly wider, darker */
export function linkGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const hw = 1.5, h = 3.0;
  b.box(0, 1, -0.3, 0.9, -hw, hw, BR_DARK, 0, 'front back');
  b.box(0, 1, 0.9, 2.3, -hw, hw, BR_GLASS, 0, 'top bottom front back');
  b.box(0, 1, 2.3, h, -hw, hw, BR_STEEL, 0, 'bottom front back');
  return finish(b);
}

/** rotunda on its column; the floor is at FLOOR m, origin on the ground */
export const BRIDGE_FLOOR = 4.4;
export function rotundaGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const n = 14, r = 2.3;
  const ring = (y: number, rr: number) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr);
  });
  const band = (y0: number, y1: number, rr: number, c: RGB) => {
    const A = ring(y0, rr), B = ring(y1, rr);
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n, m = ((i + 0.5) / n) * Math.PI * 2;
      b.quad(A[i], A[k], B[k], B[i], c, 0, new THREE.Vector3(Math.cos(m), 0, Math.sin(m)));
    }
  };
  const F = BRIDGE_FLOOR;
  band(F - 0.4, F + 0.9, r, BR_DARK);
  band(F + 0.9, F + 2.2, r, BR_GLASS);
  band(F + 2.2, F + 3.1, r, BR_STEEL);
  b.poly(ring(F + 3.1, r), BR_ROOF, 0, new THREE.Vector3(0, 1, 0));
  b.poly(ring(F - 0.4, r), BR_DARK, 0, new THREE.Vector3(0, -1, 0));
  band(0, F - 0.4, 0.45, BR_DARK); // column
  b.box(-0.9, 0.9, 0, 0.3, -0.9, 0.9, rgb(0x9c9c96)); // footing
  return finish(b);
}

/** cab: floor at y = 0, x+ = towards the aircraft (bellows face at x = 1.8) */
export function cabGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const hw = 1.95;
  b.box(-1.6, 1.4, -0.35, 0.35, -hw, hw, BR_DARK);
  b.box(-1.6, 1.4, 0.35, 1.0, -hw, hw, BR_STEEL, 0, 'top bottom');
  b.box(-1.6, 1.4, 1.0, 2.3, -hw, hw, BR_GLASS, 0, 'top bottom');
  b.box(-1.6, 1.4, 2.3, 3.2, -hw, hw, BR_STEEL, 0, 'bottom');
  // bellows canopy + bumper
  b.box(1.4, 1.95, -0.1, 3.0, -hw + 0.25, hw - 0.25, rgb(0x2a2a2a));
  b.box(1.95, 2.05, -0.15, 0.1, -hw + 0.3, hw - 0.3, rgb(0x121212));
  b.box(-0.2, 0.2, 3.2, 3.36, -0.2, 0.2, BEACON);
  return finish(b);
}

/** drive column legs: unit height (scaled to the tunnel floor), two posts across z */
export function legsGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  for (const z of [-1.1, 1.1]) b.box(-0.18, 0.18, 0, 1, z - 0.18, z + 0.18, BR_DARK, 0, 'top bottom');
  b.box(-0.3, 0.3, 0.9, 1, -1.35, 1.35, BR_DARK, 0, 'bottom');
  return finish(b);
}

/** drive bogie: cross beam + two wheel pairs, on the ground */
export function bogieGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.box(-0.6, 0.6, 0.45, 0.95, -1.6, 1.6, rgb(0xd8a21b));
  b.box(-0.35, 0.35, 0.95, 1.4, -1.3, 1.3, BR_DARK);
  wheels(b, [0], 0.5, 0.35, 1.9);
  return finish(b);
}

// ---------------------------------------------------------------------------- floodlight mast

export const MAST_H = 30;
/** 30 m high mast: tapered octagonal pole, head frame with 6 downward floodlights */
export function mastGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const n = 8;
  const pole = rgb(0x8e9296);
  const ring = (y: number, r: number) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  });
  const A = ring(0.6, 0.42), B = ring(MAST_H - 0.6, 0.16);
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n, m = ((i + 0.5) / n) * Math.PI * 2;
    b.quad(A[i], A[k], B[k], B[i], pole, 0, new THREE.Vector3(Math.cos(m), 0.02, Math.sin(m)));
  }
  b.box(-0.9, 0.9, 0, 0.6, -0.9, 0.9, rgb(0xa3a39c)); // footing
  b.box(-1.9, 1.9, MAST_H - 0.8, MAST_H - 0.55, -0.2, 0.2, rgb(0x55595e)); // head frame
  b.box(-0.2, 0.2, MAST_H - 0.8, MAST_H - 0.55, -1.9, 1.9, rgb(0x55595e));
  const lamp = paint(0xfff6e0, { lamp: 1 }), housing = rgb(0x3b3e42);
  for (const [x, z] of [[-1.6, 0], [1.6, 0], [0, -1.6], [0, 1.6], [-0.9, -0.9], [0.9, 0.9]]) {
    b.box(x - 0.45, x + 0.45, MAST_H - 1.35, MAST_H - 0.8, z - 0.3, z + 0.3, housing, 0, 'bottom');
    b.quad(new THREE.Vector3(x - 0.42, MAST_H - 1.36, z - 0.28), new THREE.Vector3(x + 0.42, MAST_H - 1.36, z - 0.28),
      new THREE.Vector3(x + 0.42, MAST_H - 1.36, z + 0.28), new THREE.Vector3(x - 0.42, MAST_H - 1.36, z + 0.28), lamp, 0, new THREE.Vector3(0, -1, 0));
  }
  return finish(b);
}

// ---------------------------------------------------------------------------- material

/** lit instanced material: vertex colour; lamp 1 = floodlight / headlight (night), 2 = amber beacon (blinks) */
export function apronMaterial(name: string): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 });
  m.name = name;
  const col = attribute('color', 'vec3');
  const lamp = attribute('lamp', 'float');
  const glass = attribute('glass', 'float');
  const is = (k: number) => step(k - 0.5, lamp).mul(step(lamp, k + 0.5));
  const blink = step(0.72, fract(U.time.mul(1.1).add(mod(floor(col.x.mul(97)), 7).mul(0.13))));
  m.colorNode = col;
  m.roughnessNode = mix(float(0.62), float(0.1), glass);
  m.metalnessNode = mix(float(0.12), float(0.0), glass);
  m.emissiveNode = vec3(1.0, 0.95, 0.85).mul(is(1)).mul(U.night.mul(3.0).add(0.05))
    .add(vec3(1.0, 0.55, 0.08).mul(is(2)).mul(blink.mul(U.night.mul(3).add(0.8))));
  return m;
}
