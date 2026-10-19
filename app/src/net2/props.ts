// Placed assets of the primitive-network slice (docs/NETWORK.md "Placed assets"): the street
// furniture that stands in the asset prop slots (primnet.json `props`), the signal assemblies at the
// generated signal poles (`poles`), the TTC island furniture on every platform (edges[].platforms),
// and the cast-iron tactile plates at every crosswalk end (ped crosswalks). Low-poly, instanced:
// one draw per kind, collapsed beyond each kind's range in the vertex shader; trees use the
// vegetation system's lobed crowns and materials (layers/vegetation) with a near / mid LOD.
//
// Toronto references (see also net2/materials.ts):
//  - street lights: Toronto Hydro standard 30-4220 -- 25-40 ft round spun-concrete pole, tapered
//    aluminium bracket (6 / 8 ft reach, 7 ft rise), cobra-head luminaire; black decorative poles with
//    BIA banner arms on the retail main streets (Queen W, Spadina);
//  - signals: concrete pole with steel mast arm, 300 mm three-section heads with black backplates
//    and a yellow retroreflective border (OTM Book 12), countdown pedestrian heads + push buttons;
//  - TTC: red-and-white stop flag pole, glass island shelters, galvanised railings along the traffic
//    side of every Spadina island (TTC 2012 platform retrofit), yellow tactile edge on the track side;
//  - furniture: Toronto (Astral) multi-stream litter bins, newspaper box banks, post-and-ring bike
//    stands, red hydrants with yellow bonnet caps, Green P pay-and-display machines, cast-iron tree
//    grates in the furnishing zone.
//
// Slot rules: the asset's `bike_ring` slots are the small-furniture slots of the furnishing zone;
// the first at each junction end becomes a litter bin, the next on arterials a newspaper-box bank,
// every sixth a hydrant (kerb side of the zone), every fourth a Green P machine where the asset has
// a parking band, the rest alternate bike stands and empty paving.
import * as THREE from 'three/webgpu';
import {
  attribute, float, vec3, vec4, cameraPosition, modelWorldMatrix, positionLocal, length, smoothstep, select, abs, step,
  uniform, mod, mix, floor, clamp, positionGeometry, texture, uv, vec2,
} from 'three/tsl';
import { Geo } from '../layers/street/geometry';
import { bikeRing, hydrant, payStation } from '../layers/props/geometry';
import { lobedHigh, lobedMid } from '../layers/vegetation/geometry';
import { lobedMaterial } from '../layers/vegetation/material';
import { S as SP } from '../layers/vegetation/species';
import { baseTone } from '../render/tiles/materials';
import { U } from '../render/uniforms';
import { clock } from '../state/clock';
import type { FrameContext } from '../engine/types';
import { C, lightAt, setLightMap } from './materials';
import type { PrimNet, Soup } from './gen';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
type V3 = [number, number, number];
type ZF = (e: number, n: number, z: number) => number;

const lin = (hex: number, a = 0): number[] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map((v) => Math.pow(v, 2.2)).concat(a);
const H_WALK = 0.15;

// ------------------------------------------------------------------------------------------ models
// +x = toward the road (or along the mast arm), y up, origin on the ground; alpha tags:
// 1 lamp lens · 0.2 / 0.4 / 0.6 signal red / yellow / green · 0.7 ped hand · 0.75 ped walk ·
// 0.72 countdown · 0.9 backlit panel · 0.3 tinted by the instance variant (banners)

const CONC_POLE = lin(0x9d9b95), ALU = lin(0xa9adb0), HEAD_GREY = lin(0x7d8286), BLACK = lin(0x1a1b1d);
const DARK = lin(0x151618), SIG_YEL = lin(0xe8b400), GALV = lin(0x9ea4a6), TTC_RED = lin(0xda241f), WHITE = lin(0xf0f0ec);

/** square-section beam between two points (for brackets, arms, rails) */
function beam(g: Geo, a: V3, b: V3, r: number, c: number[]) {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const t: V3 = [d[0] / l, d[1] / l, d[2] / l];
  const up: V3 = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cx = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  let u = cx(t, up); const ul = Math.hypot(...u); u = [u[0] / ul * r, u[1] / ul * r, u[2] / ul * r];
  let v = cx(u, t); const vl = Math.hypot(...v); v = [v[0] / vl * r, v[1] / vl * r, v[2] / vl * r];
  const P = (o: V3, su: number, sv: number): V3 => [o[0] + u[0] * su + v[0] * sv, o[1] + u[1] * su + v[1] * sv, o[2] + u[2] * su + v[2] * sv];
  const k = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let i = 0; i < 4; i++) {
    const [s0, t0] = k[i], [s1, t1] = k[(i + 1) % 4];
    g.quad(P(a, s0, t0), P(b, s0, t0), P(b, s1, t1), P(a, s1, t1), c);
  }
}

/** cobra-head luminaire hanging off (x, y): body along +x, lens underneath */
function cobra(g: Geo, x: number, y: number, body: number[]) {
  g.box(x, y - 0.12, -0.2, x + 0.72, y + 0.04, 0.2, body, true);
  g.box(x + 0.08, y + 0.04, -0.15, x + 0.6, y + 0.1, 0.15, body);
  g.quad([x + 0.1, y - 0.121, 0.16], [x + 0.1, y - 0.121, -0.16], [x + 0.66, y - 0.121, -0.16], [x + 0.66, y - 0.121, 0.16], [0.9, 0.88, 0.8, 1]);
}

/** Toronto Hydro standard: 9.1 m round spun-concrete pole, 2.4 m upswept tapered bracket, cobra head */
function lampConcrete() {
  const g = new Geo();
  g.prism(0, 0, -0.3, 9.2, 0.16, 0.095, 8, CONC_POLE);
  g.prism(0, 0, 9.2, 9.3, 0.1, 0.02, 8, CONC_POLE);
  const pts: V3[] = [[0.05, 8.45, 0], [0.8, 8.8, 0], [1.6, 8.98, 0], [2.3, 9.02, 0]];
  for (let i = 0; i < 3; i++) beam(g, pts[i], pts[i + 1], 0.05 - i * 0.01, ALU);
  g.box(-0.1, 8.35, -0.1, 0.1, 8.6, 0.1, ALU);
  cobra(g, 2.2, 9.02, HEAD_GREY);
  return g.build();
}

/** black decorative pole (downtown BIA main streets): fluted base, scroll arm, luminaire, banner arm */
function lampBlack() {
  const g = new Geo();
  g.prism(0, 0, 0, 0.9, 0.24, 0.17, 10, BLACK);
  g.prism(0, 0, 0.9, 1.0, 0.2, 0.2, 10, BLACK);
  g.prism(0, 0, 1.0, 8.0, 0.11, 0.08, 10, BLACK);
  g.prism(0, 0, 3.2, 3.3, 0.13, 0.13, 10, BLACK);
  g.prism(0, 0, 8.0, 8.35, 0.09, 0.04, 8, BLACK);
  const arm: V3[] = [[0.05, 7.4, 0], [0.7, 7.8, 0], [1.3, 7.9, 0], [1.75, 7.75, 0]];
  for (let i = 0; i < 3; i++) beam(g, arm[i], arm[i + 1], 0.035, BLACK);
  beam(g, [0.05, 7.0, 0], [0.7, 7.8, 0], 0.02, BLACK);
  cobra(g, 1.6, 7.75, BLACK);
  // BIA banner on two arms toward the road
  for (const y of [4.2, 5.9]) beam(g, [0.05, y, 0], [0.72, y, 0], 0.018, BLACK);
  const t = [1, 1, 1, 0.3];
  g.quad([0.12, 4.25, 0.006], [0.66, 4.25, 0.006], [0.66, 5.85, 0.006], [0.12, 5.85, 0.006], t);
  g.quad([0.66, 4.25, -0.006], [0.12, 4.25, -0.006], [0.12, 5.85, -0.006], [0.66, 5.85, -0.006], t);
  return g.build();
}

/** 3-section 300 mm signal head facing −z at (x, y0 bottom) with a black backplate + yellow border */
function signalHead(g: Geo, x: number, y0: number, zf = 0) {
  const w = 0.2, h = 1.08;
  g.box(x - w, y0, zf - 0.02, x + w, y0 + h, zf + 0.26, DARK, true);
  // backplate (behind the housing, +z), yellow retroreflective border
  g.box(x - 0.42, y0 - 0.12, zf + 0.26, x + 0.42, y0 + h + 0.12, zf + 0.28, DARK);
  g.box(x - 0.42, y0 - 0.12, zf + 0.255, x + 0.42, y0 + h + 0.12, zf + 0.259, SIG_YEL);
  g.box(x - 0.36, y0 - 0.06, zf + 0.25, x + 0.36, y0 + h + 0.06, zf + 0.254, DARK);
  const lens = [[0.2, y0 + 0.88], [0.4, y0 + 0.54], [0.6, y0 + 0.2]] as const;
  for (const [tag, cy] of lens) {
    const r = 0.13, n = 10, fz = zf - 0.021;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      g.tri([x, cy, fz], [x + Math.cos(a1) * r, cy + Math.sin(a1) * r, fz], [x + Math.cos(a0) * r, cy + Math.sin(a0) * r, fz], [0.04, 0.04, 0.04, tag], [0, 0, -1]);
    }
    // visor (tunnel)
    g.box(x - 0.15, cy + 0.12, zf - 0.24, x + 0.15, cy + 0.15, zf - 0.02, DARK);
    g.box(x - 0.16, cy - 0.1, zf - 0.2, x - 0.13, cy + 0.14, zf - 0.02, DARK);
    g.box(x + 0.13, cy - 0.1, zf - 0.2, x + 0.16, cy + 0.14, zf - 0.02, DARK);
  }
}

/** signal pole: concrete pole, luminaire bracket, pole-mounted head facing −z, ped head facing −x,
 *  push-button box; the mast arm (separate, scaled) runs along +x at 6.3 m */
function signalPole() {
  const g = new Geo();
  g.prism(0, 0, -0.3, 8.6, 0.19, 0.12, 8, CONC_POLE);
  // arm clamp and luminaire bracket on the far side of the arm
  g.box(-0.2, 6.15, -0.2, 0.2, 6.55, 0.2, GALV);
  beam(g, [0.05, 8.2, 0], [1.2, 8.7, 0], 0.045, ALU);
  beam(g, [1.2, 8.7, 0], [2.0, 8.75, 0], 0.04, ALU);
  cobra(g, 1.95, 8.75, HEAD_GREY);
  // side-mounted primary head facing approaching traffic (−z), on a bracket
  g.box(-0.05, 3.3, -0.35, 0.05, 3.4, -0.15, GALV);
  signalHead(g, 0, 2.7, -0.62);
  // pedestrian head facing across the crosswalk (−x): hand / walk + countdown
  g.box(-0.42, 2.35, -0.25, -0.18, 2.83, 0.25, DARK, true);
  g.box(-0.431, 2.42, 0.02, -0.421, 2.76, 0.22, [0.05, 0.05, 0.05, 0.7]);
  g.box(-0.431, 2.42, -0.22, -0.421, 2.76, -0.02, [0.05, 0.05, 0.05, 0.72]);
  g.box(-0.46, 2.83, -0.27, -0.18, 2.86, 0.27, DARK);
  // accessible push button (APS) box
  g.box(-0.25, 1.0, 0.12, -0.12, 1.3, 0.28, lin(0x2b2d30));
  g.box(-0.251, 1.12, 0.17, -0.245, 1.2, 0.23, SIG_YEL);
  return g.build();
}

/** mast arm: unit length along +x (scaled per instance), tapered steel tube at 6.3-6.5 m */
function mastArm() {
  const g = new Geo();
  beam(g, [0, 6.42, 0], [1, 6.32, 0], 0.07, GALV);
  return g.build();
}

/** head hung from the mast arm, facing −z */
function mastHead() {
  const g = new Geo();
  g.box(-0.03, 5.62, -0.03, 0.03, 6.32, 0.03, DARK);
  signalHead(g, 0, 4.6, 0);
  return g.build();
}

/** Toronto multi-stream street bin (Astral): grey steel body, garbage / recycling openings, dark lid */
function litterBin() {
  const g = new Geo();
  const body = lin(0x6e7377);
  g.box(-0.3, 0, -0.55, 0.3, 1.1, 0.55, body);
  g.box(-0.32, 1.1, -0.57, 0.32, 1.17, 0.57, lin(0x2e3134));
  g.box(0.301, 0.72, -0.48, 0.31, 0.92, -0.06, lin(0x121314));
  g.box(0.301, 0.72, 0.06, 0.31, 0.92, 0.48, lin(0x1d5aa8));
  g.box(0.302, 0.3, -0.45, 0.31, 0.6, 0.45, lin(0x5a5f63));
  g.box(0.301, 1.0, -0.2, 0.31, 1.05, 0.2, WHITE);
  return g.build();
}

/** cast-iron tree grate 1.2 x 1.2 m, flush, weathered; the trunk opening darker */
function treeGrate() {
  const g = new Geo();
  g.box(-0.6, 0, -0.6, 0.6, 0.012, 0.6, lin(0x4a4239));
  g.box(-0.25, 0.012, -0.25, 0.25, 0.014, 0.25, lin(0x2e261e));
  return g.build();
}

/** TTC stop pole: red / white flag with the route plate, facing along the platform (±z) */
function ttcPole() {
  const g = new Geo();
  g.prism(0, 0, 0, 3.0, 0.04, 0.04, 8, GALV);
  g.box(-0.02, 2.25, 0.04, 0.02, 2.95, 0.55, TTC_RED);
  g.box(-0.025, 2.62, 0.06, 0.025, 2.8, 0.53, WHITE);
  g.box(-0.025, 2.33, 0.06, 0.025, 2.42, 0.53, WHITE);
  g.box(-0.05, 1.5, -0.14, 0.05, 2.0, 0.14, lin(0x202020, 0.9));
  return g.build();
}

/** TTC island shelter (glass, 4.2 m): opening toward the tracks (+x), glass back on the traffic side,
 *  map / ad panel at one end, bench */
function islandShelter() {
  const g = new Geo();
  const frame = lin(0x3a3f43), glass = lin(0x8ea3ad), roof = lin(0x4d5358);
  const L = 2.1, D = 0.65, H = 2.45;
  for (const [x, z] of [[-D, -L], [-D, L], [D, -L], [D, L], [-D, 0]]) g.box(x - 0.04, 0, z - 0.04, x + 0.04, H, z + 0.04, frame);
  g.box(-D - 0.15, H, -L - 0.2, D + 0.3, H + 0.1, L + 0.2, roof, true);
  g.box(-D - 0.15, H + 0.1, -L - 0.2, D + 0.3, H + 0.14, L + 0.2, lin(0x6b7075));
  g.box(-D - 0.015, 0.12, -L, -D + 0.015, H - 0.08, L, glass);
  g.box(-D, 0.12, -L - 0.015, D * 0.4, H - 0.08, -L + 0.015, glass);
  g.box(-D, 0.12, L - 0.03, D * 0.4, H - 0.08, L + 0.03, lin(0xdfe6ea, 0.9));
  g.box(-D + 0.05, 0.44, -1.4, -D + 0.42, 0.49, 1.2, lin(0x6d7276));
  // TTC red band on the roof edge
  g.box(D + 0.3, H + 0.01, -L - 0.2, D + 0.31, H + 0.09, L + 0.2, TTC_RED);
  return g.build();
}

/** galvanised pipe railing, unit length along +z: top rail 1.07 m, mid rail 0.55 m */
function railSpan() {
  const g = new Geo();
  beam(g, [0, 1.07, 0], [0, 1.07, 1], 0.025, GALV);
  beam(g, [0, 0.55, 0], [0, 0.55, 1], 0.018, GALV);
  return g.build();
}
function railPost() {
  const g = new Geo();
  g.prism(0, 0, 0, 1.1, 0.03, 0.03, 6, GALV);
  return g.build();
}

/** a bank of three newspaper boxes; each box takes its colour from the instance palette (tags 0.32-0.36) */
function newsBank() {
  const g = new Geo();
  for (let i = 0; i < 3; i++) {
    const z0 = -0.8 + i * 0.54, t = [1, 1, 1, 0.32 + i * 0.02];
    g.box(-0.22, 0.25, z0, 0.22, 1.0, z0 + 0.48, t);
    g.box(-0.23, 1.0, z0 - 0.01, 0.23, 1.04, z0 + 0.49, t);
    g.box(0.221, 0.6, z0 + 0.06, 0.23, 0.92, z0 + 0.42, lin(0x9aa4aa));
    g.box(0.221, 0.36, z0 + 0.12, 0.23, 0.42, z0 + 0.36, lin(0x2a2c2e));
    g.box(-0.02, 0, z0 + 0.2, 0.02, 0.25, z0 + 0.28, DARK);
  }
  return g.build();
}

/** older City litter bin: round black steel can with a domed lid and side opening */
function binRound() {
  const g = new Geo();
  const steel = lin(0x232527);
  g.prism(0, 0, 0, 0.95, 0.3, 0.3, 10, steel);
  g.prism(0, 0, 0.95, 1.12, 0.32, 0.16, 10, steel);
  g.box(0.22, 0.75, -0.14, 0.3, 0.9, 0.14, lin(0x0c0c0d));
  g.box(0.29, 0.4, -0.12, 0.305, 0.5, 0.12, lin(0x2f6b3a));
  return g.build();
}

/** Toronto parking sign: 0.3 x 0.45 m white plate on a galvanised U-channel post, facing the road (+x).
 *  The symbol (green P / red no-stopping / blue permit) comes from the instance palette (tag 0.38) */
function parkingSign() {
  const g = new Geo();
  g.box(-0.025, 0, -0.02, 0.025, 2.55, 0.02, GALV);
  g.box(0.026, 1.95, -0.15, 0.04, 2.4, 0.15, WHITE);
  g.box(-0.04, 1.95, -0.15, -0.026, 2.4, 0.15, lin(0xb8bcbe));
  g.box(0.041, 2.17, -0.09, 0.046, 2.36, 0.09, [1, 1, 1, 0.38]);
  g.box(0.041, 2.0, -0.12, 0.046, 2.05, 0.12, [1, 1, 1, 0.38]);
  g.box(0.041, 2.08, -0.12, 0.046, 2.11, 0.06, lin(0x222222));
  return g.build();
}

/** traffic-signal controller cabinet (grey-green steel), door toward +x */
function utilityBox() {
  const g = new Geo();
  g.box(-0.35, 0, -0.6, 0.35, 0.12, 0.6, lin(0x8f8c86));
  g.box(-0.3, 0.12, -0.55, 0.3, 1.5, 0.55, lin(0x6f7a6c));
  g.box(-0.32, 1.5, -0.57, 0.32, 1.56, 0.57, lin(0x5d675b));
  g.box(0.301, 0.25, -0.5, 0.31, 1.42, 0.02, lin(0x66705f));
  g.box(0.311, 0.8, -0.06, 0.32, 0.95, -0.02, lin(0x2a2c2e));
  return g.build();
}

/** TTC transit-info pillar on the platform: slim black column, red TTC head, backlit map / next-vehicle panels */
function infoPillar() {
  const g = new Geo();
  g.box(-0.16, 0, -0.26, 0.16, 2.3, 0.26, lin(0x1d1f22));
  g.box(-0.17, 2.3, -0.27, 0.17, 2.6, 0.27, TTC_RED);
  g.box(-0.172, 2.38, -0.12, 0.172, 2.52, 0.12, WHITE);
  for (const sx of [1, -1]) g.box(sx * 0.161 - 0.005, 0.9, -0.22, sx * 0.161 + 0.005, 2.15, 0.22, lin(0xe6ecef, 0.9));
  return g.build();
}

/** street-name sign post (blades are their own pool) */
function bladePost() {
  const g = new Geo();
  g.prism(0, 0, 0, 3.55, 0.045, 0.04, 8, GALV);
  g.prism(0, 0, 3.55, 3.6, 0.05, 0.02, 8, GALV);
  return g.build();
}

/** one Toronto street-name blade, 1.2 x 0.25 m along +x, centred on the post: blue face with the name from
 *  the atlas (tag 0.8 + uv), white border; both faces read left to right */
function bladeGeo() {
  const g = new THREE.BoxGeometry(1.2, 0.25, 0.03);
  const uvA = g.getAttribute('uv') as THREE.BufferAttribute, nA = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(uvA.count * 4);
  const face = [1, 1, 1, 0.8], edge = lin(0x1a4c9a);
  for (let i = 0; i < uvA.count; i++) {
    const front = Math.abs(nA.getZ(i)) > 0.9;
    col.set(front ? face : edge, i * 4);
    if (front && nA.getZ(i) < 0) uvA.setX(i, 1 - uvA.getX(i));
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const ng = g.toNonIndexed();
  g.dispose();
  return ng;
}

/** street names in Toronto's sign style (white caps on blue, white border), one atlas row each */
function nameAtlas(names: string[]) {
  const W = 512, H = 64, rows = Math.max(1, names.length);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H * rows;
  const c = cv.getContext('2d')!;
  const abbr = (n: string) => n.toUpperCase().replace(/\bSTREET\b/, 'ST').replace(/\bAVENUE\b/, 'AVE').replace(/\bWEST\b/, 'W')
    .replace(/\bEAST\b/, 'E').replace(/\bSQUARE\b/, 'SQ').replace(/\bTERRACE\b/, 'TERR').replace(/\bPLACE\b/, 'PL').replace(/\bLANE\b/, 'LANE');
  names.forEach((n, i) => {
    const y = i * H;
    c.fillStyle = '#1a4c9a'; c.fillRect(0, y, W, H);
    c.strokeStyle = '#f4f4f0'; c.lineWidth = 4; c.strokeRect(5, y + 5, W - 10, H - 10);
    c.fillStyle = '#f4f4f0';
    const t = abbr(n);
    let size = 40;
    c.font = `600 ${size}px Inter, Helvetica, Arial, sans-serif`;
    while (c.measureText(t).width > W - 40 && size > 18) { size -= 2; c.font = `600 ${size}px Inter, Helvetica, Arial, sans-serif`; }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(t, W / 2, y + H / 2 + 2);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = 4;
  return { tex, rows };
}

function bladeMaterial(atlas: THREE.Texture, rows: number) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = 'net2Blades';
  const ipos = attribute('ipos', 'vec4');
  const d = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(ipos.xyz, 1)).xyz));
  const k = float(1).sub(smoothstep(170, 200, d));
  m.positionNode = ipos.xyz.add(positionLocal.sub(ipos.xyz).mul(k));
  const vc = attribute('color', 'vec4');
  const uvn = uv();
  const tx = texture(atlas, vec2(uvn.x, ipos.w.add(float(1).sub(uvn.y)).div(rows))).rgb;
  const isFace = step(0.75, vc.a).mul(step(vc.a, 0.85));
  m.colorNode = baseTone(mix(vc.rgb, tx, isFace));
  // retroreflective sheeting: a little brighter in headlights / lamp light at night
  (m as unknown as { emissiveNode: N }).emissiveNode = mix(vc.rgb, tx, isFace).mul(U.night.mul(0.25));
  return m;
}

// ------------------------------------------------------------------------------------------ material

const phaseT = uniform(0);

/** vertex colours (alpha tags), per-instance window, lamp / signal / ped / panel emission.
 *  ipos.w: variant (banner hue) or signal group (0 / 1) */
function propMaterial(name: string, far: number) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = name;
  m.metalness = 0;
  m.roughness = 0.6;
  const ipos = attribute('ipos', 'vec4');
  const ivar = attribute('ivar', 'vec4');          // palette pick, wear, -, -
  const d = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(ipos.xyz, 1)).xyz));
  const k = float(1).sub(smoothstep(far * 0.85, far, d));
  m.positionNode = ipos.xyz.add(positionLocal.sub(ipos.xyz).mul(k));
  const vc = attribute('color', 'vec4');
  const tag = vc.a;
  const v = ipos.w;
  // BIA banners (tag 0.3): hue by street (ipos.w)
  const banner = select(mod(v, 3).lessThan(1), vec3(0.5, 0.05, 0.04), select(mod(v, 3).lessThan(2), vec3(0.03, 0.12, 0.35), vec3(0.45, 0.3, 0.02)));
  const isBanner = step(0.29, tag).mul(step(tag, 0.31));
  // palette slots (tags 0.32 / 0.34 / 0.36 news boxes, 0.38 parking-sign symbol): per-instance pick
  const slot = floor(tag.sub(0.3).mul(50).add(0.5));
  const isSlot = step(0.315, tag).mul(step(tag, 0.385));
  const pi = mod(floor(ivar.x.mul(8)).add(slot.mul(3)), 8);
  const news = select(pi.lessThan(1), vec3(0.03, 0.09, 0.33), select(pi.lessThan(2), vec3(0.04, 0.22, 0.06),
    select(pi.lessThan(3), vec3(0.75, 0.52, 0.02), select(pi.lessThan(4), vec3(0.5, 0.03, 0.03),
      select(pi.lessThan(5), vec3(0.55, 0.55, 0.53), select(pi.lessThan(6), vec3(0.02, 0.02, 0.025),
        select(pi.lessThan(7), vec3(0.3, 0.02, 0.15), vec3(0.02, 0.2, 0.25))))))));
  const pk = mod(floor(ivar.x.mul(3)), 3);
  const sign = select(pk.lessThan(1), vec3(0.02, 0.25, 0.08), select(pk.lessThan(2), vec3(0.55, 0.02, 0.02), vec3(0.02, 0.1, 0.35)));
  const tint = select(slot.greaterThan(3.5), sign, news);
  let col: N = mix(mix(vc.rgb, banner, isBanner), tint, isSlot);
  // wear: faded, slightly desaturated paint per instance; grime at the foot
  const wear = ivar.y;
  const lum = col.x.mul(0.3).add(col.y.mul(0.59)).add(col.z.mul(0.11));
  col = mix(col, vec3(lum), wear.mul(0.3)).mul(float(1).sub(wear.mul(0.16)));
  col = col.mul(clamp(positionGeometry.y.mul(1.4).add(0.68), 0, 1));
  m.colorNode = baseTone(col);
  // night: lit by the same baked light as the street under it (sampled at the instance's foot; the
  // cobra heads throw their light down, so the lower parts get more), shop spill and shelter light
  const Lp = lightAt(ipos.x, ipos.z);
  const fall = clamp(float(1.15).sub(positionGeometry.y.mul(0.06)), 0.35, 1.1);
  const litN = col.mul(vec3(1.0, 0.95, 0.86).mul(Lp.r.mul(1.6)).add(vec3(1.0, 0.68, 0.38).mul(Lp.g.mul(1.2))).add(vec3(0.85, 0.92, 1.0).mul(Lp.b.mul(1.4))))
    .mul(fall).mul(U.night);
  // fixed-time plan (70 s): group 0 green 0-30, yellow 30-34, all-red 34-35; group 1 offset by 35 s
  const t = mod(phaseT.add(v.mul(35)), 70);
  const state = select(t.lessThan(30), float(2), select(t.lessThan(34), float(1), float(0)));
  const isLens = step(0.15, tag).mul(step(tag, 0.65)).mul(float(1).sub(isBanner)).mul(float(1).sub(isSlot));
  const idx = tag.mul(5).sub(1);            // 0 red, 1 yellow, 2 green
  const on = select(abs(idx.sub(state)).lessThan(0.5), float(1), float(0)).mul(isLens);
  const hue = select(idx.lessThan(0.5), vec3(1, 0.08, 0.04), select(idx.lessThan(1.5), vec3(1, 0.5, 0.03), vec3(0.1, 1, 0.6)));
  // pedestrian heads serve the crossing parallel to the OTHER group's traffic
  const tp = mod(phaseT.add(v.mul(35)).add(35), 70);
  const walk = select(tp.lessThan(22), float(1), float(0));
  const isHand = step(0.69, tag).mul(step(tag, 0.71));
  const isCount = step(0.715, tag).mul(step(tag, 0.73));
  const ped = select(walk.greaterThan(0.5), vec3(0.9, 0.9, 0.85), vec3(1, 0.35, 0.03)).mul(isHand)
    .add(vec3(1, 0.4, 0.03).mul(isCount).mul(select(tp.lessThan(34).and(tp.greaterThan(22)), float(1), float(0.0))));
  const lamp = step(0.95, tag);
  const panel = step(0.85, tag).mul(step(tag, 0.93));
  // LED cobra heads (Toronto's 2017 conversion, ~4000 K): bright lens at night
  (m as unknown as { emissiveNode: N }).emissiveNode = litN.add(hue.mul(on).mul(2.2))
    .add(ped.mul(1.6))
    .add(vec3(1.0, 0.95, 0.85).mul(lamp).mul(U.night).mul(6))
    .add(vc.rgb.mul(panel).mul(U.night.mul(2.2).add(0.1)));
  return m;
}

// ------------------------------------------------------------------------------------------ placement

/** a placed instance in the NetLayer group frame; lx / lz: lean (rad) about local x / z; pal, wear: per-instance
 *  palette pick and paint wear (default: hashed from the position, so nothing repeats exactly) */
interface Inst { x: number; y: number; z: number; ang: number; sx?: number; sy?: number; sz?: number; v?: number; lx?: number; lz?: number; pal?: number; wear?: number }

class Pool {
  mesh: THREE.InstancedMesh;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, list: Inst[], parent: THREE.Object3D, shadow: boolean) {
    const n = Math.max(1, list.length);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.count = list.length;
    const ipos = new Float32Array(n * 4), ivar = new Float32Array(n * 4);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), Sc = new THREE.Vector3(), Eu = new THREE.Euler(0, 0, 0, 'YXZ');
    list.forEach((it, i) => {
      Q.setFromEuler(Eu.set(it.lx ?? 0, it.ang, it.lz ?? 0, 'YXZ'));
      M.compose(P.set(it.x, it.y, it.z), Q, Sc.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1));
      this.mesh.setMatrixAt(i, M);
      ipos.set([it.x, it.y, it.z, it.v ?? 0], i * 4);
      ivar.set([it.pal ?? hash(it.x * 0.37, it.z * 0.71), it.wear ?? hash(it.z * 0.53, it.x * 0.29), 0, 0], i * 4);
    });
    geo.setAttribute('ipos', new THREE.InstancedBufferAttribute(ipos, 4));
    geo.setAttribute('ivar', new THREE.InstancedBufferAttribute(ivar, 4));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    parent.add(this.mesh);
  }
  get tris() { return this.mesh.count * ((this.mesh.geometry.getAttribute('position').count / 3) | 0); }
}

const hash = (a: number, b = 0) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };

/** streets whose lamps are the black decorative (BIA) poles */
const BLACK_POLE_STREETS = new Set(['Queen Street West', 'Spadina Avenue']);

export class NetProps {
  readonly group = new THREE.Group();
  private trees: { meshes: THREE.Mesh[]; pos: Float32Array; rec: Float32Array } | null = null;
  private pools: Pool[] = [];
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private anchorVer = -1;
  private ox: number; private oy: number;
  counts: Record<string, number> = {};
  private atlasNames: string[] = [];
  private lightTex: THREE.DataTexture | null = null;
  private net: PrimNet | null = null;
  private zAt: ZF | null = null;
  private stopsDone = false;
  private stopPoll = 0;

  /** curbside TTC stops (streetcar / bus stops of the live feed inside the slice that are not on an island):
   *  red-and-white stop pole 0.6 m behind the curb, and a glass shelter where the walk is wide enough */
  private placeStops() {
    const sys = (window as unknown as { __transit?: { system?: { stops?(o: { modes: string[] }): { x: ArrayLike<number>; y: ArrayLike<number> } } } }).__transit?.system;
    if (!sys?.stops || !this.net || !this.zAt) return false;
    const st = sys.stops({ modes: ['bus', 'streetcar'] });
    const net = this.net, zAt = this.zAt;
    const [x0, y0, x1, y1] = net.bbox;
    const poles: Inst[] = [], shelters: Inst[] = [];
    for (let i = 0; i < st.x.length; i++) {
      const e0 = st.x[i], n0 = st.y[i];
      if (e0 < x0 || e0 > x1 || n0 < y0 || n0 > y1) continue;
      // nearest sweep row of a street with sidewalks; islands handle their own stops
      let best: { e: (typeof net.edges)[number]; k: number; d: number; u: number } | null = null;
      for (const e of net.edges) {
        const sw = e.sweep;
        if (!sw || !sw.kinds.includes('sidewalk')) continue;
        for (let k = 0; k < sw.c.length; k += 1) {
          const d = Math.hypot(sw.c[k][0] - e0, sw.c[k][1] - n0);
          if (d < (best?.d ?? 30)) best = { e, k, d, u: (e0 - sw.c[k][0]) * sw.n[k][0] + (n0 - sw.c[k][1]) * sw.n[k][1] };
        }
      }
      if (!best) continue;
      const { e, k, u } = best, sw = e.sweep!;
      if (e.platforms.some((p) => sw.s[k] > p.s0 - 15 && sw.s[k] < p.s1 + 15)) continue;
      const side = u >= 0 ? 1 : -1, cw = side > 0 ? sw.idx.cwL : sw.idx.cwR;
      const U = sw.U[k], c = sw.c[k], n = sw.n[k];
      const toRoad = Math.atan2(-side * n[1], -side * n[0]);
      const z = zAt(c[0], c[1], c[2]) + H_WALK;
      const up = U[cw] + side * 0.75;
      poles.push(this.L(c[0] + n[0] * up, c[1] + n[1] * up, z, toRoad - Math.PI / 2));
      const walkW = Math.abs(U[cw] - U[side > 0 ? sw.idx.walkL : sw.idx.walkR]);
      if (walkW >= 3.6 && hash(e0, n0) < 0.6) {
        const us = U[cw] + side * (0.15 + Math.min(2.4, walkW - 1.6));
        const t = [n[1], -n[0]];
        shelters.push(this.L(c[0] + n[0] * us + t[0] * 3, c[1] + n[1] * us + t[1] * 3, z, toRoad));
      }
    }
    if (poles.length) this.pools.push(new Pool(ttcPole(), propMaterial('net2curbPole', 400), poles, this.group, false));
    if (shelters.length) this.pools.push(new Pool(islandShelter(), propMaterial('net2curbShelter', 500), shelters, this.group, true));
    this.counts.curbStops = poles.length;
    return true;
  }

  constructor(ox: number, oy: number) { this.ox = ox; this.oy = oy; this.group.name = 'net2Props'; }

  /** local frame of the NetLayer group: (E - ox, z, -(N - oy)); angle: the local +x axis points to (E, N) direction `a` */
  private L(e: number, n: number, z: number, a: number, extra: Partial<Inst> = {}): Inst {
    return { x: e - this.ox, y: z, z: -(n - this.oy), ang: a, ...extra };
  }

  build(net: PrimNet & { props?: { kind: string; zone: string; edge: number; s: number; xyz: number[]; heading: number; width: number }[] }, zAt: ZF) {
    for (const p of this.pools) { this.group.remove(p.mesh); p.mesh.dispose(); }
    this.pools = [];
    const E = new Map(net.edges.map((e) => [e.id, e]));
    const assets = new Map(net.assets.map((a) => [a.id, a]));
    const K: Record<string, Inst[]> = {
      lampC: [], lampB: [], sigPole: [], mastArm: [], mastHead: [], bin: [], news: [], hydrant: [], pay: [], ring: [], grate: [],
      ttcPole: [], shelter: [], railSpan: [], railPost: [], binR: [], parkSign: [], utilBox: [], pillar: [], bladePost: [], blade: [],
    };
    /** light sources for the night light map: E, N, mounting height, intensity, channel (0 LED lamp, 2 shelter) */
    const lights: number[][] = [];
    const treeList: { e: number; n: number; z: number; sp: number; h: number; w: number; seed: number }[] = [];

    // the edge row nearest to s: centre + left normal (to face the road / find the kerb side)
    const rowAt = (eid: number, s: number) => {
      const sw = E.get(eid)?.sweep;
      if (!sw) return null;
      let k = 0;
      while (k < sw.s.length - 2 && sw.s[k + 1] < s) k++;
      const f = Math.max(0, Math.min(1, (s - sw.s[k]) / Math.max(1e-6, sw.s[k + 1] - sw.s[k])));
      const c = [sw.c[k][0] * (1 - f) + sw.c[k + 1][0] * f, sw.c[k][1] * (1 - f) + sw.c[k + 1][1] * f, sw.c[k][2] * (1 - f) + sw.c[k + 1][2] * f];
      const n = [sw.n[k][0], sw.n[k][1]];
      const U = sw.U[k].map((u, j) => u * (1 - f) + sw.U[k + 1][j] * f);
      return { c, n, U, sw, k };
    };

    // ---- furnishing-zone slots
    const bySide = new Map<string, { p: NonNullable<typeof net.props>[number]; toRoad: number; side: number }[]>();
    for (const p of net.props ?? []) {
      const e = E.get(p.edge);
      const r = rowAt(p.edge, p.s);
      if (!e || !r) continue;
      const lat = (p.xyz[0] - r.c[0]) * r.n[0] + (p.xyz[1] - r.c[1]) * r.n[1];
      const side = lat >= 0 ? 1 : -1;
      const toRoad = Math.atan2(-side * r.n[1], -side * r.n[0]);
      const z = zAt(p.xyz[0], p.xyz[1], p.xyz[2] - H_WALK) + H_WALK;
      if (p.kind === 'lamp') {
        const black = BLACK_POLE_STREETS.has(e.name);
        (black ? K.lampB : K.lampC).push(this.L(p.xyz[0], p.xyz[1], z, toRoad, { v: Math.floor(hash(p.edge) * 3) }));
        const reach = black ? 1.96 : 2.56;
        lights.push([p.xyz[0] + Math.cos(toRoad) * reach, p.xyz[1] + Math.sin(toRoad) * reach, black ? 7.7 : 9.0, 1, 0]);
      } else if (p.kind === 'tree_pit') {
        // about a third of the downtown pits are empty or paved over; young trees, narrow crowns
        if (hash(p.s, p.edge + 0.5) < 0.3) continue;
        K.grate.push(this.L(p.xyz[0], p.xyz[1], z, toRoad));
        const sp = [SP.LOCUST, SP.LOCUST, SP.LINDEN, SP.PLANE][Math.floor(hash(p.edge, 1) * 4)];
        treeList.push({ e: p.xyz[0], n: p.xyz[1], z, sp, h: 6 + hash(p.s, p.edge) * 3.5, w: 0.55, seed: hash(p.s, 7) });
      } else if (p.kind === 'bike_ring') {
        const key = `${p.edge}:${side}`;
        const l = bySide.get(key) ?? [];
        l.push({ p, toRoad, side });
        bySide.set(key, l);
      }
    }
    for (const [key, l] of bySide) {
      const e = E.get(Number(key.split(':')[0]))!;
      const a = assets.get(e.asset);
      const arterial = e.cls <= 3;
      const parking = !!a?.bands.some((b) => b.kind === 'parking');
      l.sort((x, y) => x.p.s - y.p.s);
      l.forEach(({ p, toRoad }, i) => {
        const z = zAt(p.xyz[0], p.xyz[1], p.xyz[2] - H_WALK) + H_WALK;
        const fromEnd = Math.min(i, l.length - 1 - i);
        // kerb side of the zone: toward the road by (width / 2 - 0.5)
        const kx = Math.cos(toRoad) * Math.max(0, p.width / 2 - 0.5), ky = Math.sin(toRoad) * Math.max(0, p.width / 2 - 0.5);
        // bins: mostly the Astral multi-stream bin, some older round cans; news banks in varied liveries
        if (fromEnd === 0) (hash(p.s, p.edge + 2) < 0.3 ? K.binR : K.bin).push(this.L(p.xyz[0], p.xyz[1], z, toRoad));
        else if (fromEnd === 1 && arterial) K.news.push(this.L(p.xyz[0], p.xyz[1], z, toRoad, { pal: hash(p.s, p.edge + 9) }));
        else if (i % 6 === 3) K.hydrant.push(this.L(p.xyz[0] + kx, p.xyz[1] + ky, z, toRoad));
        else if (parking && i % 4 === 2) K.pay.push(this.L(p.xyz[0] + kx * 0.6, p.xyz[1] + ky * 0.6, z, toRoad));
        else if (i % 2 === 0) K.ring.push(this.L(p.xyz[0], p.xyz[1], z, toRoad + Math.PI / 2));
      });
    }

    // ---- streets without a furnishing zone (boulevard / sidewalk only): lamps every 30 m on
    // alternate sides and boulevard trees every 9 m (stopgap until the asset carries these slots)
    for (const e of net.edges) {
      const sw = e.sweep, a = assets.get(e.asset);
      if (!sw || !a || a.draw === false || e.cls > 5 || sw.kinds.includes('furniture')) continue;
      const hasWalk = sw.kinds.includes('sidewalk');
      if (!hasWalk) continue;
      const s0 = sw.s[0], s1 = sw.s[sw.s.length - 1];
      const avoid = [s0, s1, ...e.platforms.flatMap((p) => [p.s0, p.s1])];
      const ok = (st: number) => avoid.every((q) => Math.abs(st - q) >= 7);
      for (const side of [1, -1]) {
        // the band next to the curb on this side: boulevard centre, else 0.6 m behind the curb
        const cw = side > 0 ? sw.idx.cwL : sw.idx.cwR;
        const j = side > 0 ? cw - 2 : cw + 1;   // the interval just outside the curb band
        const kind = sw.kinds[j];
        for (let st = s0 + 8 + (side > 0 ? 0 : 15); st < s1 - 6; st += 30) {
          if (!ok(st)) continue;
          const r = rowAt(e.id, st)!;
          const uIn = kind === 'boulevard' ? (r.U[j] + r.U[j + 1]) / 2 : r.U[cw] + side * 0.75;
          const x = r.c[0] + r.n[0] * uIn, y = r.c[1] + r.n[1] * uIn;
          const toRoad = Math.atan2(-side * r.n[1], -side * r.n[0]);
          K.lampC.push(this.L(x, y, zAt(r.c[0], r.c[1], r.c[2]) + H_WALK, toRoad, { sy: 0.85 }));
          lights.push([x + Math.cos(toRoad) * 2.56, y + Math.sin(toRoad) * 2.56, 7.7, 0.85, 0]);
          // residential permit-parking signs between the lamps, one side
          if (side > 0 && e.cls >= 5 && hash(st, e.id) < 0.6) {
            const r2 = rowAt(e.id, st + 15);
            if (r2 && ok(st + 15)) {
              const u2 = r2.U[cw] + side * 0.6;
              K.parkSign.push(this.L(r2.c[0] + r2.n[0] * u2, r2.c[1] + r2.n[1] * u2, zAt(r2.c[0], r2.c[1], r2.c[2]) + H_WALK, toRoad, { pal: 0.1 }));
            }
          }
        }
        if (kind !== 'boulevard') continue;
        for (let st = s0 + 10; st < s1 - 8; st += 9) {
          if (!ok(st) || hash(st, e.id + side) < 0.25) continue;
          const r = rowAt(e.id, st)!;
          const uIn = (r.U[j] + r.U[j + 1]) / 2;
          const x = r.c[0] + r.n[0] * uIn, y = r.c[1] + r.n[1] * uIn;
          treeList.push({ e: x, n: y, z: zAt(r.c[0], r.c[1], r.c[2]) + H_WALK, sp: [SP.NORWAY, SP.LINDEN, SP.SILVER][Math.floor(hash(e.id, 3) * 3)], h: 9 + hash(st, 2) * 5, w: 0.7, seed: hash(st, 9) });
        }
      }
    }

    // ---- signal assemblies at the generated signal poles: pole at p, mast arm toward q; the
    // approach traffic is to the left of the arm (heads face it); phase group by leg axis
    for (const p of net.poles ?? []) {
      const z = zAt(p[0], p[1], p[2] - H_WALK) + H_WALK;
      const ax = p[3] - p[0], ay = p[4] - p[1];
      const len = Math.hypot(ax, ay);
      if (len < 0.5) continue;
      const ang = Math.atan2(ay, ax);
      // legs along the Spadina axis (N 16.7 deg W grid) are group 0, cross streets group 1
      const leg = ang + Math.PI / 2;
      const grid = 16.7 * Math.PI / 180 + Math.PI / 2;
      const g = Math.abs(Math.cos(leg - grid)) > 0.7 ? 1 : 0;
      K.sigPole.push(this.L(p[0], p[1], z, ang, { v: g }));
      lights.push([p[0] + (ax / len) * 2.3, p[1] + (ay / len) * 2.3, 8.75, 1, 0]);
      const armL = Math.min(len + 1.5, 9);
      K.mastArm.push(this.L(p[0], p[1], z, ang, { sx: armL }));
      for (const f of [0.55, 0.95]) {
        K.mastHead.push(this.L(p[0] + (ax / len) * armL * f, p[1] + (ay / len) * armL * f, z, ang, { v: g }));
      }
    }

    // ---- TTC islands: railing along the traffic side, shelter, stop pole at the approach end
    for (const e of net.edges) {
      const sw = e.sweep;
      if (!sw) continue;
      for (const p of e.platforms) {
        const j = p.band + 2;
        const mid = (p.s0 + p.s1) / 2;
        const at = (s: number, off: number) => {
          const r = rowAt(e.id, s)!;
          const eu = p.side > 0 ? r.U[j] : r.U[j + 1];       // traffic-side edge of the widened ROW
          const u = eu - p.side * off;
          return { x: r.c[0] + r.n[0] * u, y: r.c[1] + r.n[1] * u, z: zAt(r.c[0], r.c[1], r.c[2]) + H_WALK + p.h, r };
        };
        // railing: 0.12 m inside the traffic edge, ramps (2.5 m) open at both ends, posts every 2 m
        const a0 = p.s0 + 2.5, a1 = p.s1 - 2.5;
        for (let s = a0; s < a1 - 0.01; s += 2) {
          const s2 = Math.min(a1, s + 2);
          const A = at(s, 0.12), B = at(s2, 0.12);
          const L = Math.hypot(B.x - A.x, B.y - A.y);
          // the span runs along local +z, which a rotation `a` points to (E, N) = (sin a, -cos a)
          const dir = Math.atan2(B.y - A.y, B.x - A.x);
          K.railSpan.push(this.L(A.x, A.y, A.z, dir + Math.PI / 2, { sz: L }));
          K.railPost.push(this.L(A.x, A.y, A.z, 0));
        }
        { const B = at(a1, 0.12); K.railPost.push(this.L(B.x, B.y, B.z, 0)); }
        // shelter: centred, back glass toward the railing, opening toward the tracks
        const S = at(mid, 0.12 + 0.8);
        const toTrack = Math.atan2(-p.side * S.r.n[1], -p.side * S.r.n[0]);
        K.shelter.push(this.L(S.x, S.y, S.z, toTrack));
        // stop pole near the end where the car arrives (track direction on this side)
        const sEnd = p.side > 0 ? p.s0 + 3.5 : p.s1 - 3.5;
        const P = at(sEnd, 0.9);
        K.ttcPole.push(this.L(P.x, P.y, P.z, toTrack));
        lights.push([S.x, S.y, 2.4, 1, 2]);
        // info pillar near the other end, on the platform centre line
        const Q = at(p.side > 0 ? p.s1 - 6 : p.s0 + 6, p.w / 2);
        K.pillar.push(this.L(Q.x, Q.y, Q.z, toTrack + Math.PI / 2));
      }
    }

    // ---- parking signs along parking bands (green P / red no-stopping in the peaks), kerb side
    for (const e of net.edges) {
      const sw = e.sweep, a = assets.get(e.asset);
      if (!sw || !a?.bands.some((b) => b.kind === 'parking')) continue;
      const s0 = sw.s[0], s1 = sw.s[sw.s.length - 1];
      const avoid = [s0, s1, ...e.platforms.flatMap((p) => [p.s0, p.s1])];
      for (const side of [1, -1]) {
        const cw = side > 0 ? sw.idx.cwL : sw.idx.cwR;
        let n = 0;
        for (let st = s0 + 12 + (side > 0 ? 0 : 11); st < s1 - 10; st += 24) {
          if (avoid.some((q) => Math.abs(st - q) < 6)) continue;
          const r = rowAt(e.id, st)!;
          // the walk edge of the curb band, then 0.5 m in
          const u = r.U[cw] + side * 0.65;
          const toRoad = Math.atan2(-side * r.n[1], -side * r.n[0]);
          K.parkSign.push(this.L(r.c[0] + r.n[0] * u, r.c[1] + r.n[1] * u, zAt(r.c[0], r.c[1], r.c[2]) + H_WALK, toRoad, { pal: n++ % 3 === 2 ? 0.5 : 0.1 }));
        }
      }
    }

    // ---- junction corners: Toronto street-name blades (two streets) and one signal controller per signalized node
    const names: string[] = [];
    const nameRow = (n: string) => { let i = names.indexOf(n); if (i < 0) { i = names.length; names.push(n); } return i; };
    const legDir = (eid: number, end: number) => {
      const sw = E.get(eid)?.sweep;
      if (!sw || sw.c.length < 2) return 0;
      const a = end === 0 ? sw.c[0] : sw.c[sw.c.length - 1], b = end === 0 ? sw.c[1] : sw.c[sw.c.length - 2];
      return Math.atan2(b[1] - a[1], b[0] - a[0]);
    };
    for (const nd of net.nodes) {
      const M = nd.mesh;
      if (!M || M.kind !== 'junction' || !M.ret || !M.walk) continue;
      const n = M.legs.length;
      const z = zAt(nd.xyz[0], nd.xyz[1], nd.xyz[2]) + H_WALK;
      let placed = 0;
      for (let i = 0; i < n; i++) {
        if (M.par?.[i]) continue;
        const ret = M.ret[i], wk = M.walk[i];
        if (!ret?.length || !wk?.length) continue;
        const rm = ret[Math.floor(ret.length / 2)], wm = wk[Math.floor(wk.length / 2)];
        const ea = E.get(M.legs[i].edge), eb = E.get(M.legs[(i + 1) % n].edge);
        const dx = wm[0] - rm[0], dy = wm[1] - rm[1], dl = Math.hypot(dx, dy) || 1;
        if (dl < 1.2) continue;
        const inward = Math.atan2(dy, dx);
        if (nd.signal && placed === 0) {
          const f = Math.min(2.2, dl * 0.6) / dl;
          K.utilBox.push(this.L(rm[0] + dx * f + (-dy / dl) * 1.5, rm[1] + dy * f + (dx / dl) * 1.5, z, inward + Math.PI));
        }
        // blades on two diagonal corners, both street names
        if (i % 2 === 0 && ea?.name && eb?.name && ea.name !== eb.name) {
          const f = Math.min(0.9, dl * 0.4) / dl;
          const x = rm[0] + dx * f, y = rm[1] + dy * f;
          K.bladePost.push(this.L(x, y, z, 0));
          K.blade.push(this.L(x, y, z + 3.05, legDir(M.legs[i].edge, M.legs[i].end), { v: nameRow(ea.name) }));
          K.blade.push(this.L(x, y, z + 3.33, legDir(M.legs[(i + 1) % n].edge, M.legs[(i + 1) % n].end), { v: nameRow(eb.name) }));
        }
        placed++;
      }
    }

    // ---- variety: rotation jitter and a slight lean on street furniture, a hair of lean on poles
    for (const k of ['bin', 'binR', 'news', 'hydrant', 'pay', 'ring', 'parkSign', 'utilBox']) {
      for (const it of K[k]) {
        const h = hash(it.x * 1.3, it.z * 0.7);
        it.ang += (h - 0.5) * (k === 'ring' ? 0.06 : 0.14);
        it.lx = (hash(it.z, it.x) - 0.5) * (k === 'parkSign' ? 0.06 : 0.02);
        it.lz = (hash(it.x, it.z * 3) - 0.5) * (k === 'parkSign' ? 0.06 : 0.02);
      }
    }
    for (const k of ['lampC', 'lampB', 'sigPole', 'bladePost']) {
      for (const it of K[k]) { it.lx = (hash(it.z, it.x) - 0.5) * 0.012; it.lz = (hash(it.x, it.z) - 0.5) * 0.012; }
    }
    this.lightMap(net, lights);
    this.net = net; this.zAt = zAt; this.stopsDone = false;
    this.atlasNames = names;

    // ---- build the pools
    const mk = (name: string, geo: THREE.BufferGeometry, far: number, shadow: boolean) => {
      const list = K[name];
      this.counts[name] = list.length;
      if (!list.length) return;
      this.pools.push(new Pool(geo, propMaterial(`net2${name}`, far), list, this.group, shadow));
    };
    mk('lampC', lampConcrete(), 900, true);
    mk('lampB', lampBlack(), 900, true);
    mk('sigPole', signalPole(), 900, true);
    mk('mastArm', mastArm(), 900, true);
    mk('mastHead', mastHead(), 900, true);
    mk('bin', litterBin(), 260, false);
    mk('news', newsBank(), 260, false);
    mk('binR', binRound(), 260, false);
    mk('parkSign', parkingSign(), 220, false);
    mk('utilBox', utilityBox(), 300, false);
    mk('pillar', infoPillar(), 400, false);
    mk('bladePost', bladePost(), 220, false);
    if (K.blade.length && names.length) {
      const { tex, rows } = nameAtlas(names);
      this.counts.blade = K.blade.length;
      this.pools.push(new Pool(bladeGeo(), bladeMaterial(tex, rows), K.blade, this.group, false));
    }
    mk('hydrant', hydrant(), 220, false);
    mk('pay', payStation(), 220, false);
    mk('ring', bikeRing(), 180, false);
    mk('grate', treeGrate(), 180, false);
    mk('ttcPole', ttcPole(), 400, false);
    mk('shelter', islandShelter(), 500, true);
    mk('railSpan', railSpan(), 300, false);
    mk('railPost', railPost(), 300, false);
    this.buildTrees(treeList);
    this.counts.trees = treeList.length;
  }

  /** bake the night light map (see materials.ts setLightMap): LED pools under every lamp head
   *  (cos^3 / h^2 falloff), warm spill from shop windows on the frontage of main streets, shelter light */
  private lightMap(net: PrimNet, lights: number[][]) {
    const [x0, y0, x1, y1] = net.bbox, T = 0.75;
    const W = Math.ceil((x1 - x0) / T), H = Math.ceil((y1 - y0) / T);
    const acc = new Float32Array(W * H * 3);
    for (const [e, n, h, I, ch] of lights) {
      const R = ch === 2 ? 5 : h * 2.0;
      const ci = (e - x0) / T - 0.5, cj = (n - y0) / T - 0.5, rT = R / T;
      for (let j = Math.max(0, Math.floor(cj - rT)); j <= Math.min(H - 1, Math.ceil(cj + rT)); j++) {
        for (let i = Math.max(0, Math.floor(ci - rT)); i <= Math.min(W - 1, Math.ceil(ci + rT)); i++) {
          const r2 = ((i - ci) ** 2 + (j - cj) ** 2) * T * T;
          if (r2 > R * R) continue;
          const f = ch === 2 ? I * Math.exp(-r2 / (2 * 1.8 * 1.8)) : I * Math.pow((h * h) / (h * h + r2), 2.6) * (1 - r2 / (R * R));
          acc[(j * W + i) * 3 + ch] += f;
        }
      }
    }
    // storefront spill: main streets (furnishing zone present), lit shop fronts every ~6 m
    for (const e of net.edges) {
      const sw = e.sweep;
      if (!sw || !sw.kinds.includes('furniture')) continue;
      for (let k = 0; k < sw.s.length - 1; k++) {
        for (let sub = 0; sub < 4; sub++) {
          const f = sub / 4, s = sw.s[k] * (1 - f) + sw.s[k + 1] * f;
          const c = [sw.c[k][0] * (1 - f) + sw.c[k + 1][0] * f, sw.c[k][1] * (1 - f) + sw.c[k + 1][1] * f], nn = sw.n[k];
          for (const side of [1, -1]) {
            const shop = Math.floor(s / 6.5);
            const lit = hash(shop, e.id * 2 + (side > 0 ? 1 : 0));
            if (lit < 0.35) continue;
            const I = 0.45 + 0.55 * hash(shop + 0.5, e.id);
            const ub = sw.U[k][side > 0 ? sw.idx.bldgL : sw.idx.bldgR] * (1 - f) + sw.U[k + 1][side > 0 ? sw.idx.bldgL : sw.idx.bldgR] * f;
            for (let d = 0; d <= 6; d += 0.5) {
              const u = ub - side * d;
              const i = Math.round((c[0] + nn[0] * u - x0) / T - 0.5), j = Math.round((c[1] + nn[1] * u - y0) / T - 0.5);
              if (i < 0 || j < 0 || i >= W || j >= H) continue;
              const q = (j * W + i) * 3 + 1;
              acc[q] = Math.max(acc[q], I * Math.exp(-d / 2.0));
            }
          }
        }
      }
    }
    const data = new Uint8Array(W * H * 4);
    for (let q = 0; q < W * H; q++) {
      for (let c = 0; c < 3; c++) data[q * 4 + c] = Math.round(255 * (1 - Math.exp(-acc[q * 3 + c] * 0.9)));
      data[q * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.lightTex?.dispose();
    this.lightTex = tex;
    setLightMap(tex, x0 - this.ox, y0 - this.oy, W * T, H * T);
  }

  /** street trees: the vegetation system's lobed crowns (materials, seasons, wind) as two LOD pools */
  private buildTrees(list: { e: number; n: number; z: number; sp: number; h: number; w: number; seed: number }[]) {
    if (this.trees) { for (const m of this.trees.meshes) { m.removeFromParent(); m.geometry.dispose(); } this.trees = null; }
    if (!list.length) return;
    const n = list.length;
    const pos = new Float32Array(n * 3), rec = new Float32Array(n * 5);
    list.forEach((t, i) => { pos.set([t.e, t.z, -t.n], i * 3); rec.set([t.h, t.h * t.w, t.sp, 0, t.seed], i * 5); });
    const mkMesh = (tmpl: THREE.BufferGeometry, level: 0 | 1) => {
      const g = new THREE.InstancedBufferGeometry();
      for (const k of Object.keys(tmpl.attributes)) g.setAttribute(k, tmpl.attributes[k]);
      if (tmpl.index) g.setIndex(tmpl.index);
      for (const k of ['ia', 'ib', 'ic']) g.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      g.instanceCount = 0;
      const m = new THREE.Mesh(g, lobedMaterial(level));
      m.name = level === 0 ? 'net2TreesHigh' : 'net2TreesMid';
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      return m;
    };
    this.trees = { meshes: [mkMesh(lobedHigh(), 0), mkMesh(lobedMid(), 1)], pos, rec };
    this.anchorVer = -1;
    this.lastCam.set(Infinity, 0, 0);
  }

  /** the tree meshes live in the scene at the floating anchor (vegetation materials are anchor-relative);
   *  each LOD pool holds only its trees (high < 160 m, mid < 1.5 km), repacked when the camera moves */
  update(ctx: FrameContext, scene: THREE.Object3D) {
    phaseT.value = clock.parts().secOfDay;
    if (!this.stopsDone && (this.stopPoll += ctx.dt ?? 0.016) > 1) { this.stopPoll = 0; this.stopsDone = this.placeStops(); }
    const T = this.trees;
    if (!T) return;
    const o = ctx.anchor.origin;
    const cam = ctx.cameraPos;
    const rebase = this.anchorVer !== ctx.anchor.version;
    if (!rebase && cam.distanceTo(this.lastCam) < 8) return;
    this.anchorVer = ctx.anchor.version;
    this.lastCam.copy(cam);
    const cnt = [0, 0];
    for (const m of T.meshes) {
      if (!m.parent) scene.add(m);
      m.position.set(o.x, 0, o.z); m.updateMatrix();
    }
    const at = T.meshes.map((m) => ['ia', 'ib', 'ic'].map((k) => m.geometry.getAttribute(k) as THREE.InstancedBufferAttribute));
    for (let i = 0; i < T.pos.length / 3; i++) {
      const x = T.pos[i * 3], y = T.pos[i * 3 + 1], z = T.pos[i * 3 + 2];
      const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
      const lv = d < 160 ? 0 : d < 1500 ? 1 : 2;
      if (lv > 1) continue;
      const j = cnt[lv]++;
      const [ia, ib, ic] = at[lv].map((a) => a.array as Float32Array);
      ia.set([x - o.x, y, z - o.z, T.rec[i * 5 + 4]], j * 4);
      ib.set(T.rec.subarray(i * 5, i * 5 + 4), j * 4);
      ic.set([lv, lv, -1e4, 0], j * 4);
    }
    T.meshes.forEach((m, lv) => {
      (m.geometry as THREE.InstancedBufferGeometry).instanceCount = cnt[lv];
      for (const a of at[lv]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, cnt[lv] * 4); }
    });
  }

  stats() {
    const pools = this.pools.map((p) => ({ name: (p.mesh.material as THREE.Material).name, n: p.mesh.count, tris: p.tris }));
    const t = this.trees ? this.trees.meshes.map((m) => (m.geometry as THREE.InstancedBufferGeometry).instanceCount) : [0, 0];
    return { pools, trees: { high: t[0], mid: t[1], total: this.counts.trees ?? 0 }, streetNames: this.atlasNames.length, curbStops: this.counts.curbStops ?? 0, draws: pools.length + 2 };
  }

  dispose() {
    for (const p of this.pools) p.mesh.dispose();
    if (this.trees) for (const m of this.trees.meshes) { m.removeFromParent(); m.geometry.dispose(); }
    this.group.removeFromParent();
  }
}

// ------------------------------------------------------------------------------------------ decals

/**
 * Surface decals appended to the slice soup (after gen.generate, before annotate):
 *  - cast-iron tactile plates (610 mm deep, 2.4 m wide, 0.2 m behind the curb face) at both ends of
 *    every crosswalk of the pedestrian mesh (Toronto T-310.030-10);
 *  - the transverse lines of the Toronto zebra crosswalk (200 mm, at both ends of the bars) for every
 *    run of zebra bars in `marks`.
 */
export function addDecals(S: Soup, net: PrimNet & { ped: { kind: string; xyz: number[][]; width: number; edge?: number }[] }, zAt: ZF) {
  const E = new Map(net.edges.map((e) => [e.id, e]));
  const quad = (pts: number[][], z: number, m: typeof C.iron) =>
    S.quad(S.v(pts[0][0], pts[0][1], z), S.v(pts[1][0], pts[1][1], z), S.v(pts[2][0], pts[2][1], z), S.v(pts[3][0], pts[3][1], z), m);
  let plates = 0;
  for (const p of net.ped) {
    if (p.kind !== 'crosswalk' || p.edge === undefined) continue;
    const e = E.get(p.edge);
    const sw = e?.sweep;
    if (!sw || p.xyz.length < 2) continue;
    const mx = (p.xyz[0][0] + p.xyz[1][0]) / 2, my = (p.xyz[0][1] + p.xyz[1][1]) / 2;
    let k = 0, bd = Infinity;
    for (let q = 0; q < sw.s.length; q++) { const d = Math.hypot(sw.c[q][0] - mx, sw.c[q][1] - my); if (d < bd) { bd = d; k = q; } }
    const c = sw.c[k], n = sw.n[k], t = [n[1], -n[0]];
    const z = zAt(c[0], c[1], c[2]) + H_WALK + 0.006;
    for (const side of [1, -1]) {
      const u0 = sw.U[k][side > 0 ? sw.idx.cwL : sw.idx.cwR] + side * 0.2, u1 = u0 + side * 0.61;
      const P = (u: number, a: number) => [c[0] + n[0] * u + t[0] * a, c[1] + n[1] * u + t[1] * a];
      quad([P(u0, -1.2), P(u0, 1.2), P(u1, 1.2), P(u1, -1.2)], z, C.iron);
      plates++;
    }
  }
  // zebra runs: bars are ~0.55 x 3 m quads; group by shared long axis and collinear centres
  const bars = (net.marks ?? []).map((m) => {
    const q = m.xyz;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const l01 = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), l12 = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    const [a, b] = l01 > l12 ? [q[0], q[1]] : [q[1], q[2]];
    const L = Math.max(l01, l12), W = Math.min(l01, l12);
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    return { cx, cy, z: q[0][2], L, W, ux, uy, used: false };
  }).filter((b) => b.W > 0.45 && b.W < 0.7 && b.L > 2 && b.L < 6);
  let rails = 0;
  for (const b of bars) {
    if (b.used) continue;
    const run = bars.filter((o) => !o.used && Math.abs(o.ux * b.ux + o.uy * b.uy) > 0.98 &&
      Math.abs((o.cx - b.cx) * b.ux + (o.cy - b.cy) * b.uy) < 0.3 && Math.hypot(o.cx - b.cx, o.cy - b.cy) < 40);
    if (run.length < 3) continue;
    // order along the run direction (perpendicular to the bars)
    const vx = -b.uy, vy = b.ux;
    run.sort((p, q) => ((p.cx - b.cx) * vx + (p.cy - b.cy) * vy) - ((q.cx - b.cx) * vx + (q.cy - b.cy) * vy));
    // keep only the contiguous stretch (gaps < 1.4 m) that contains b
    const seg: typeof run = [];
    for (const r of run) {
      if (seg.length && ((r.cx - seg[seg.length - 1].cx) * vx + (r.cy - seg[seg.length - 1].cy) * vy) > 1.4) {
        if (seg.includes(b)) break;
        seg.length = 0;
      }
      seg.push(r);
    }
    if (seg.length < 3) continue;
    for (const r of seg) r.used = true;
    const f = seg[0], l = seg[seg.length - 1];
    const w0 = -0.35, w1 = ((l.cx - f.cx) * vx + (l.cy - f.cy) * vy) + 0.35;
    for (const sgn of [1, -1]) {
      const off = sgn * (b.L / 2 + 0.12);
      const P = (w: number, o: number) => [f.cx + vx * w + b.ux * o, f.cy + vy * w + b.uy * o];
      const z = zAt(f.cx, f.cy, f.z) + 0.0005;
      quad([P(w0, off - 0.1), P(w1, off - 0.1), P(w1, off + 0.1), P(w0, off + 0.1)], z, C.white);
      rails++;
    }
  }
  return { plates, rails };
}
