// Procedural facades for the extruded tile buildings (no textures, no extra
// geometry): window grids at real storey heights with frames, lintels and sky
// reflections, brick coursing / precast joints / metal ribs up close, cornices
// and copings, and at street level storefront bands (shop glazing, doors,
// bulkheads, sign bands with lettering), office lobbies and loading doors.
// Night: lit rooms behind a real window grid (interior-mapped ceilings, back
// walls and floors, warm / cool / TV light, curtains and blinds), occupancy by
// building use and time of day, lobby glow and storefront light spilling onto
// the sidewalk, and a smooth distance LOD (window → lit floors → building
// average) so far buildings don't sparkle. Driven by the `fac` / `fcode` vertex
// attributes written by workers/buildings.ts (style table below must match its
// ST constants, the use classes its USE constants).
import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, texture, floor, fract, mod, smoothstep, mix, step, max, min, abs, sin, pow, clamp,
  fwidth, uniform, vertexColor, normalLocal, normalWorld, positionWorld, cameraPosition, reflect, dot, select, exp, exp2, log2, sqrt,
  Fn, If,
} from 'three/tsl';
import { clock } from '../../state/clock';
import { U } from '../uniforms';
import { baseTone } from './materials';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const ROWS = 8;
// per style: [floorH, bayW, winW, winH], [sill, groundH, reflect, litProb], [frame rgb, mullionMode], [glass rgb, ornament]
// ornament: 0 none · 1 lintels + sills + brick coursing · 2 condo balcony guards · 3 metal ribs · 4 panel joints
const STYLE: number[][][] = [
  /* 0 brick    */[[3.5, 2.5, 0.42, 0.55], [0.2, 4.4, 0.22, 0.3], [0.9, 0.88, 0.82, 0], [0.09, 0.1, 0.11, 1]],
  /* 1 stone    */[[4.2, 3.0, 0.46, 0.58], [0.18, 4.8, 0.25, 0.28], [0.22, 0.22, 0.2, 0], [0.09, 0.1, 0.11, 1]],
  /* 2 glass    */[[3.8, 1.5, 0.95, 0.76], [0.12, 5.5, 0.85, 0.45], [0.28, 0.3, 0.33, 1], [0.13, 0.2, 0.25, 0]],
  /* 3 condo    */[[3.0, 1.5, 0.96, 0.8], [0.14, 4.8, 0.7, 0.4], [0.82, 0.84, 0.84, 1], [0.15, 0.24, 0.25, 2]],
  /* 4 precast  */[[2.8, 3.0, 0.5, 0.48], [0.32, 4.2, 0.3, 0.35], [0.5, 0.5, 0.5, 0], [0.1, 0.12, 0.14, 4]],
  /* 5 ribbon   */[[3.7, 1.8, 0.97, 0.42], [0.36, 4.6, 0.6, 0.45], [0.18, 0.18, 0.18, 1], [0.1, 0.14, 0.18, 4]],
  /* 6 stucco   */[[3.5, 3.6, 0.42, 0.42], [0.32, 4.3, 0.25, 0.3], [0.92, 0.92, 0.9, 0], [0.1, 0.11, 0.12, 0]],
  /* 7 metal    */[[6.5, 7.0, 0.7, 0.14], [0.75, 4.5, 0.3, 0.15], [0.3, 0.3, 0.3, 0], [0.12, 0.14, 0.16, 3]],
  /* 8 parking  */[[3.0, 7.5, 0.92, 0.48], [0.38, 3.0, 0.0, 0.85], [0.6, 0.6, 0.58, 0], [0.07, 0.07, 0.07, 4]],
  /* 9 loft     */[[4.3, 3.2, 0.62, 0.6], [0.16, 4.6, 0.3, 0.35], [0.14, 0.14, 0.14, 0], [0.09, 0.1, 0.11, 1]],
  /* 10 blank   */[[3.0, 3.0, 0.0, 0.0], [0.3, 4.0, 0.0, 0.0], [0.5, 0.5, 0.5, 0], [0.1, 0.1, 0.1, 0]],
  /* 11 house   */[[2.9, 3.0, 0.4, 0.5], [0.3, 0.0, 0.25, 0.3], [0.92, 0.92, 0.9, 0], [0.1, 0.1, 0.11, 1]],
  /* 12 modern  */[[4.0, 2.2, 0.78, 0.5], [0.25, 4.8, 0.45, 0.3], [0.25, 0.26, 0.27, 1], [0.12, 0.16, 0.19, 4]],
  /* 13 roof    */[[3, 3, 0, 0], [0, 0, 0, 0], [0.5, 0.5, 0.5, 0], [0.1, 0.1, 0.1, 0]],
  /* 14 canopy  */[[3, 3, 0, 0], [0, 0, 0, 0], [0.5, 0.5, 0.5, 0], [0.1, 0.1, 0.1, 0]],
  /* 15 awning  */[[3, 3, 0, 0], [0, 0, 0, 0], [0.5, 0.5, 0.5, 0], [0.1, 0.1, 0.1, 0]],
];
// shop sign colours (sRGB) — Toronto main-street mix: red, green, navy, black, cream, yellow…
const SIGNS = [0xc62828, 0x2e7d32, 0x1a237e, 0x141414, 0xefe6cf, 0xf2b705, 0xe65100, 0x00796b,
  0x6a1b9a, 0x7b1f1f, 0x1565c0, 0xf4f4f0, 0x263238, 0xad1457, 0x33691e, 0x4e342e];
// bulkheads / shop door frames
const BULK = [0x2b2b2b, 0x3e2a1c, 0x14181c, 0x6d6a64, 0x1f3a2b, 0x5a1f1f, 0x2c3e50, 0x8c8070,
  0x151515, 0x40362c, 0x222a33, 0x4a4a48, 0x303030, 0x6b4a2e, 0x1c2c24, 0x3a3a3a];

function srgb(c: number): [number, number, number] {
  const f = (v: number) => Math.pow(v / 255, 2.2);
  return [f((c >> 16) & 255), f((c >> 8) & 255), f(c & 255)];
}

let _tbl: THREE.DataTexture | null = null;
function styleTable(): THREE.DataTexture {
  if (_tbl) return _tbl;
  const d = new Float32Array(16 * ROWS * 4);
  for (let s = 0; s < 16; s++) {
    for (let r = 0; r < 4; r++) {
      const v = STYLE[s][r].slice();
      if (r >= 2) { for (let k = 0; k < 3; k++) v[k] = Math.pow(v[k], 2.2); }
      d.set(v, (r * 16 + s) * 4);
    }
    d.set([...srgb(SIGNS[s]), 1], (4 * 16 + s) * 4);
    d.set([...srgb(BULK[s]), 1], (5 * 16 + s) * 4);
  }
  const t = new THREE.DataTexture(d, 16, ROWS, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return (_tbl = t);
}

// Share of rooms lit by hour: [hour, residential, office, shops, hotel, civic / school, 24 h (hospital, station)].
// Homes: low through the working day, an evening peak around 20–22 h, most dark by 01 h, a
// breakfast bump. Offices: working hours, a trickle until ~20 h, then cleaners / security only
// (most towers dark after 22 h). Shops: open 10–21 h. Hotels: late. Civic: office hours + evening
// classes. Hospitals / stations never go dark.
const SCHED: number[][] = [
  [0, 0.14, 0.05, 0.1, 0.22, 0.03, 0.4], [1.5, 0.07, 0.04, 0.08, 0.12, 0.03, 0.36], [5, 0.04, 0.04, 0.08, 0.08, 0.03, 0.36],
  [6.5, 0.24, 0.1, 0.12, 0.3, 0.08, 0.45], [8, 0.2, 0.5, 0.35, 0.25, 0.5, 0.6], [9, 0.09, 0.72, 0.6, 0.12, 0.72, 0.62],
  [10, 0.08, 0.75, 0.9, 0.1, 0.72, 0.62], [16, 0.12, 0.72, 0.9, 0.14, 0.62, 0.6], [17.5, 0.34, 0.55, 0.9, 0.3, 0.38, 0.58],
  [19, 0.48, 0.3, 0.9, 0.45, 0.25, 0.55], [20.5, 0.55, 0.18, 0.85, 0.55, 0.18, 0.52], [22, 0.46, 0.08, 0.3, 0.52, 0.06, 0.48],
  [23.5, 0.26, 0.05, 0.12, 0.36, 0.04, 0.44], [24, 0.14, 0.05, 0.1, 0.22, 0.03, 0.4],
];
const _occ = new Array(6).fill(0);
function occupancy(sec: number, weekday: number): number[] {
  const hr = (sec / 3600) % 24;
  for (let i = 0; i < SCHED.length - 1; i++) {
    const a = SCHED[i], b = SCHED[i + 1];
    if (hr >= a[0] && hr <= b[0]) {
      const t = (hr - a[0]) / Math.max(1e-6, b[0] - a[0]);
      for (let k = 0; k < 6; k++) _occ[k] = a[k + 1] + (b[k + 1] - a[k + 1]) * t;
      break;
    }
  }
  // weekends: offices / schools mostly empty, homes busier by day
  if (weekday === 0 || weekday === 6) { _occ[1] *= 0.3; _occ[4] *= 0.35; _occ[0] = Math.max(_occ[0], 0.16); }
  return _occ;
}
let _occAt = -1;
function refreshOcc() {
  const p = clock.parts();
  const key = Math.floor(p.secOfDay / 30) * 8 + p.weekday;
  if (key === _occAt) return;
  _occAt = key;
  const o = occupancy(p.secOfDay, p.weekday);
  (OCC.value as THREE.Vector3).set(o[0], o[1], o[2]);
  (OCC2.value as THREE.Vector3).set(o[3], o[4], o[5]);
}
/** (residential, office, shop) lit fractions for the sim time of day (also used by houses.ts) */
export const OCC = uniform(new THREE.Vector3(0.4, 0.4, 0.8)).onFrameUpdate(refreshOcc) as N;
/** (hotel, civic / school, 24 h) lit fractions */
export const OCC2 = uniform(new THREE.Vector3(0.4, 0.2, 0.5)).onFrameUpdate(refreshOcc) as N;

const hash2 = (a: N, b: N): N => fract(sin(a.mul(12.9898).add(b.mul(78.233))).mul(43758.5453));
/** anti-aliased box [a, b] on x with filter width w */
const box = (x: N, a: N, b: N, w: N): N => smoothstep(a.sub(w), a.add(w), x).mul(float(1).sub(smoothstep(b.sub(w), b.add(w), x)));
const lin = (r: number, g: number, b: number) => vec3(Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2));

export function facadeMaterial(): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = 'buildings';
  const tbl = styleTable();
  const vc = vertexColor();
  const base: N = pow(vec3(vc.r, vc.g, vc.b), vec3(2.2));

  const fac = attribute('fac', 'vec4');
  const fcd = attribute('fcode', 'vec2');
  const u: N = fac.x, hh: N = fac.y, L: N = fac.z, Ht: N = fac.w;
  const code = floor(fcd.x.add(0.5));
  const unitW: N = max(fcd.y, 0.5);
  // unit −1: a party wall (shared with / exposed above a neighbour): a blank fire wall
  const notParty: N = step(-0.5, fcd.y);
  const style = mod(code, 16), front = mod(floor(code.div(16)), 4), seed = mod(floor(code.div(64)), 256);
  const use = floor(code.div(16384));
  const isUse = (k: number): N => step(k - 0.5, use).mul(step(use, k + 0.5));
  const sv = style.add(0.5).div(16);
  const row = (r: number) => texture(tbl, vec2(sv, (r + 0.5) / ROWS));
  const P0 = row(0), P1 = row(1), P2 = row(2), P3 = row(3);
  const pal = (r: number, idx: N) => texture(tbl, vec2(floor(idx.mul(16)).add(0.5).div(16), (r + 0.5) / ROWS)).rgb;

  const isWall: N = float(1).sub(step(0.35, abs(normalLocal.y)));
  const isShop = step(0.5, front).mul(step(front, 1.5));
  const isLobby = step(1.5, front).mul(step(front, 2.5));
  const isDock = step(2.5, front);
  const isRoof = step(12.5, style).mul(step(style, 13.5));
  const isCanopy = step(13.5, style).mul(step(style, 14.5));
  const isAwning = step(14.5, style);
  const special = isRoof.add(isCanopy).add(isAwning);

  // ---- view vectors for glass
  const Vd = positionWorld.sub(cameraPosition).normalize();
  const Nw = normalWorld;
  const cosT = abs(dot(Vd, Nw));
  const fres = pow(float(1).sub(cosT), 5);
  const reflCol = (jit: N) => {
    const R = reflect(Vd, Nw);
    const ry = R.y.add(jit.sub(0.5).mul(0.14));
    const sky = mix(vec3(U.skyHorizon as N), vec3(U.skyZenith as N), smoothstep(0.0, 0.7, ry));
    // below the horizon: the street and the facades opposite (mid grey), above: sky
    return mix(vec3(0.16, 0.165, 0.17), sky, smoothstep(-0.12, 0.08, ry));
  };

  // ---- upper-floor window grid
  const gH = mix(float(0), P1.y, isShop.add(isLobby));
  const hu = hh.sub(gH);
  const fh = P0.x;
  const fyv = hu.div(fh);
  const fl = floor(fyv), fy = fract(fyv);
  // bay rhythm: the style's bay width, ±12 % per building (never a window across a corner: the grid
  // restarts on every wall, whole bays only, and a 0.35 m pier is kept at each end)
  const bayT = P0.y.mul(fract(seed.mul(0.377).add(0.11)).mul(0.24).add(0.88));
  const nb = max(floor(L.div(bayT).add(0.5)), 1);
  const bw = L.div(nb);
  const cu = u.div(bw);
  const colI = floor(cu), fx = fract(cu);
  const wX = max(fwidth(cu), 0.001), wY = max(fwidth(fyv), 0.001);
  const winW = P0.z, winH = P0.w, sill = P1.x;
  const x0 = float(0.5).sub(winW.mul(0.5)), x1 = float(0.5).add(winW.mul(0.5));
  const y0 = sill, y1 = sill.add(winH);
  const inX = box(fx, x0, x1, wX), inY = box(fy, y0, y1, wY);
  const valid = step(0, hu).mul(step(fl.add(1).mul(fh).add(gH), Ht.sub(0.3))).mul(step(1.6, L)).mul(step(0.01, winW)).mul(notParty)
    .mul(box(u, float(0.35), L.sub(0.35), max(fwidth(u), 0.001)));
  const far = smoothstep(0.22, 0.55, max(wX, wY));
  const winSharp = inX.mul(inY).mul(valid);
  const win: N = mix(winSharp, winW.mul(winH).mul(valid), far).mul(isWall).mul(float(1).sub(special));

  // per-window randoms
  const wr = hash2(seed.mul(0.731).add(fl.mul(1.37)), colI.mul(0.917).add(L.mul(0.113)));
  const wr2 = fract(wr.mul(17.31));
  // frame: thin border inside the window opening, plus a centre mullion on wide punched windows
  const fw = float(0.06).div(bw);
  const frameM = float(1).sub(box(fx, x0.add(fw), x1.sub(fw), wX).mul(box(fy, y0.add(fw.mul(bw).div(fh)), y1.sub(fw.mul(bw).div(fh)), wY)))
    .add(select((winW.mul(bw) as N).greaterThan(1.4).and((P2.w as N).lessThan(0.5)), box(fx, float(0.485), float(0.515), wX), float(0)))
    .mul(float(1).sub(far));
  // ---- rooms: who lives / works behind each window
  // homes & hotel rooms: units of 2–3 bays; offices & the rest: open-plan zones of 4–7 bays that
  // tend to be lit a whole floor at a time
  const officeLike = float(1).sub(isUse(0)).sub(isUse(4));
  const floorR = hash2(seed.mul(1.91).add(fl.mul(0.61)), float(7.7));
  const ub = mix(floor(hash2(seed.add(fl.mul(2.3)), float(1.3)).mul(2)).add(2), floor(hash2(seed.add(fl.mul(1.1)), float(2.9)).mul(4)).add(4), officeLike);
  const unitI = floor(colI.add(floor(hash2(seed.mul(0.5).add(fl.mul(1.3)), float(9.1)).mul(ub))).div(ub));
  const unitR = hash2(seed.mul(1.7).add(fl.mul(0.37)), unitI.mul(0.71).add(L.mul(0.13)));
  const tempR = fract(unitR.mul(7.31));
  // window coverings (window-plane, no parallax): side curtains / sheers in homes, venetian blinds in
  // offices, roller blinds part-way down in both
  const wxm = fx.sub(0.5).mul(bw); // m from the bay centre
  const hwm = winW.mul(bw).mul(0.5); // half window width, m
  const curtOn = step(0.45, wr).mul(float(1).sub(officeLike));
  const cf = fract(wr.mul(5.3)).mul(0.28).add(0.14);
  const sheer = step(0.9, fract(wr.mul(11.7))).mul(float(1).sub(officeLike));
  const curtain = clamp(curtOn.mul(step(hwm.mul(float(1).sub(cf)), abs(wxm))).add(sheer), 0, 1);
  const blindOn = step(mix(float(0.82), float(0.6), officeLike), wr2);
  const blindLvl = y1.sub(winH.mul(fract(wr2.mul(3.7)).mul(0.65).add(0.15)));
  const blind = blindOn.mul(step(blindLvl, fy)).mul(float(1).sub(curtain));
  const slatK = float(1).sub(smoothstep(0.25, 0.6, fwidth(hh.div(0.08))));
  const slats = box(fract(hh.div(0.08)), float(0.0), float(0.35), max(fwidth(hh.div(0.08)), 0.001)).mul(slatK).mul(officeLike);
  const coverC = mix(mix(lin(0.62, 0.57, 0.48), lin(0.72, 0.72, 0.7), officeLike), mix(lin(0.55, 0.42, 0.33), lin(0.82, 0.78, 0.7), step(0.5, fract(wr.mul(3.1)))), curtain);
  const cover = clamp(blind.add(curtain), 0, 1);

  // ---- interior mapping: the view ray continues into a box room (floor slab, ceiling, back wall at
  // the room depth) — ceilings with light fittings when seen from the street, back walls head-on
  const Tw = vec3(Nw.z, float(0), Nw.x.negate()); // along +u (workers/buildings.ts wall())
  const ia = dot(Vd, Tw), ib = Vd.y, ic = max(dot(Vd, Nw).negate(), 0.06);
  // (a real branch: pixels where the windows are sub-pixel skip the room entirely)
  const roomI: N = Fn(() => {
    const r = float(0.5).toVar();
    If(far.lessThan(0.995).and(isWall.greaterThan(0.5)), () => {
      const roomD = mix(float(3.8), float(7.5), officeLike).mul(unitR.mul(0.4).add(0.8));
      const ceilH = fh.sub(0.35);
      const wyR = fy.mul(fh);
      const tB = roomD.div(ic);
      const yB = wyR.add(ib.mul(tB)), xB = wxm.add(ia.mul(tB));
      const hitC = step(ceilH, yB), hitF = step(yB, 0.0).mul(float(1).sub(hitC));
      const tC = ceilH.sub(wyR).div(max(ib, 0.0001)), tF = wyR.div(max(ib.negate(), 0.0001));
      const zC = tC.mul(ic), xC = wxm.add(ia.mul(tC)); // ceiling hit: depth into the room, across
      const zF = tF.mul(ic);
      // homes: a lamp somewhere on the back wall (warm pool), a dim ceiling, darker floor, sofa / shelf
      // silhouettes; offices: rows of troffers on the ceiling, bright back wall, dark workstation band
      const lampX = fract(unitR.mul(3.7)).sub(0.5).mul(bw).mul(0.9);
      const dl = xB.sub(lampX), dy = yB.sub(1.25);
      const pool = float(1).div(dl.mul(dl).add(dy.mul(dy)).mul(0.9).add(1));
      const furn = step(yB, fract(unitR.mul(13.1)).mul(0.5).add(0.45)).mul(step(0.3, hash2(floor(xB.div(0.9)).add(unitR.mul(31)), float(4.4))));
      const backRes = pool.mul(0.9).add(0.18).mul(float(1).sub(furn.mul(0.75)));
      const desk = step(yB, 1.15).mul(step(0.7, yB).mul(0.35).add(0.65));
      const monitor = box(fract(xB.div(1.6).add(unitR)), float(0.42), float(0.58), float(0.02)).mul(box(yB, float(0.8), float(1.12), float(0.02)));
      const backOff = mix(float(0.62), float(0.22), desk).add(monitor.mul(0.5));
      const troffer = box(fract(zC.div(2.4).add(unitR)), float(0.42), float(0.58), float(0.03)).mul(box(fract(xC.div(1.2)), float(0.2), float(0.8), float(0.05)));
      const ceilOff = troffer.mul(1.4).add(0.42).div(zC.mul(0.08).add(1));
      const ceilRes = float(0.42).div(dl.mul(dl).mul(0.1).add(1)).add(0.08);
      const floorI = mix(float(0.22), float(0.3), officeLike).div(zF.mul(0.1).add(1));
      const backI = mix(backRes, backOff, officeLike).div(roomD.mul(0.05).add(0.85));
      const ceilI = mix(ceilRes, ceilOff, officeLike);
      r.assign(mix(mix(backI, floorI, hitF), ceilI, hitC));
    });
    return r;
  })();

  // by day blinds / curtains are seen through tinted, reflective glass: muted, less on curtain walls
  const coverVis = cover.mul(mix(float(0.55), float(0.22), P1.z));
  const glassD = mix(P3.rgb.mul(wr.mul(0.6).add(0.7)).mul(roomI.mul(0.5).add(0.75)), coverC.mul(0.7), coverVis);
  const refl = P1.z.mul(fres.mul(0.75).add(0.25)).mul(float(1).sub(coverVis.mul(0.8)));
  const winCol = mix(glassD, P2.rgb, clamp(frameM, 0, 1));

  // ---- wall surface ornament
  const orn = P3.w;
  const isBrickO = step(0.5, orn).mul(step(orn, 1.5));
  const isBalc = step(1.5, orn).mul(step(orn, 2.5));
  const isRib = step(2.5, orn).mul(step(orn, 3.5));
  const isJoint = step(3.5, orn);
  // brick coursing up close
  const by = hh.div(0.0667), brow = floor(by); // modular brick: 57 mm + 10 mm joint
  const bx = u.div(0.203).add(brow.mul(0.5)); // 194 mm + joint
  const bW = max(fwidth(by), fwidth(bx));
  const nearK = float(1).sub(smoothstep(0.12, 0.35, bW));
  const mortar = float(1).sub(box(fract(by), float(0.14), float(1), bW).mul(box(fract(bx), float(0.05), float(1), bW)));
  const brickTone = hash2(floor(bx), brow.mul(0.37)).sub(0.5).mul(0.16);
  let wallC: N = base.mul(float(1).add(isBrickO.mul(nearK).mul(brickTone.sub(mortar.mul(0.18)))));
  // lintels and sills (stone) on brick styles
  const lint = box(fx, x0.sub(0.05), x1.add(0.05), wX).mul(box(fy, y1, y1.add(float(0.22).div(fh)), wY).add(box(fy, y0.sub(float(0.09).div(fh)), y0, wY)))
    .mul(valid).mul(isBrickO).mul(float(1).sub(far));
  wallC = mix(wallC, lin(0.8, 0.77, 0.7), clamp(lint, 0, 1));
  // precast / curtain-wall joints
  const jointK = float(1).sub(box(fy, float(0.02), float(0.98), wY).mul(box(fx, float(0.015), float(0.985), wX))).mul(isJoint).mul(float(1).sub(far));
  wallC = wallC.mul(float(1).sub(jointK.mul(0.22)));
  // metal ribs
  const ribW = fwidth(u.div(0.3));
  wallC = wallC.mul(float(1).add(sin(u.div(0.3).mul(6.2832)).mul(0.07).mul(isRib).mul(float(1).sub(smoothstep(0.2, 0.45, ribW)))));
  // mullion gaps inside the glazing band use the frame colour (curtain walls, ribbon windows)
  const inBand = inY.mul(valid).mul(step(0.5, P2.w)).mul(float(1).sub(inX));
  wallC = mix(wallC, P2.rgb, clamp(inBand, 0, 1).mul(float(1).sub(far.mul(0.5))));
  // condo balcony guards: frosted band in the lower pane on alternating bays
  const guard = isBalc.mul(box(fy, y0, y0.add(0.3), wY)).mul(step(0.5, fract(colI.mul(0.5).add(seed.mul(0.5)))));
  // cornice shadow + coping at the wall top; darker plinth at the foot
  const cornice = box(hh, Ht.sub(1.1), Ht.sub(0.5), max(fwidth(hh), 0.001)).mul(isBrickO).mul(step(6, Ht));
  const coping = step(Ht.sub(0.45), hh).mul(step(4, Ht));
  wallC = mix(wallC, wallC.mul(0.72), cornice);
  wallC = mix(wallC, mix(wallC, lin(0.68, 0.67, 0.64), 0.55), coping);
  wallC = mix(wallC, wallC.mul(0.72), step(hh, 0.45).mul(float(1).sub(isShop)).mul(float(1).sub(isLobby)));
  // soft ground-level occlusion
  wallC = wallC.mul(mix(float(0.86), float(1), smoothstep(-0.5, 7, hh)));

  let col: N = mix(wallC, winCol, win);
  col = mix(col, mix(col, lin(0.8, 0.85, 0.86), 0.45), guard.mul(win));

  // ---- storefront band
  const us = u.div(unitW), si = floor(us), um = fract(us).mul(unitW);
  const wm = max(fwidth(um), 0.002), wh = max(fwidth(hh), 0.002);
  const rs = hash2(seed.mul(0.371).add(si.mul(1.713)), L.mul(0.0917).add(3.1));
  const rs2 = fract(rs.mul(31.7)), rs3 = fract(rs.mul(7.13));
  const pier = float(1).sub(box(um, float(0.32), unitW.sub(0.32), wm));
  const shopFar = smoothstep(0.08, 0.3, wm);
  const signTop = min(P1.y.sub(0.35), float(4.0));
  const glassZ = box(hh, float(0.5), float(2.9), wh);
  const signZ = box(hh, float(3.15), signTop, wh);
  const bulkZ = step(hh, 0.5);
  const dA = select(rs.lessThan(0.33), float(0.5), select(rs.lessThan(0.66), unitW.sub(1.6), unitW.mul(0.5).sub(0.55)));
  const doorZ = box(um, dA, dA.add(1.1), wm).mul(step(hh, 2.45));
  const doorGlass = box(um, dA.add(0.14), dA.add(0.96), wm).mul(box(hh, float(0.25), float(2.3), wh));
  const signC = pal(4, rs2);
  const bulkC = pal(5, rs3);
  // shop interior seen through the glass: lit back wall (warm or cool), shelving
  // uprights + shelves in stores, table silhouettes in cafés, a few display items
  const backC = mix(lin(0.42, 0.36, 0.28), lin(0.36, 0.38, 0.4), step(0.6, rs2));
  const grad = smoothstep(0.4, 2.9, hh).mul(0.5).add(0.5);
  const isStore = step(0.45, rs3);
  const upr = box(fract(um.div(1.25)), float(0.0), float(0.07), wm.div(1.25));
  const shelves = box(fract(hh.div(0.5)), float(0.0), float(0.12), wh.div(0.5)).mul(box(hh, float(0.6), float(2.2), wh));
  const tables = box(fract(um.div(1.8).add(rs)), float(0.2), float(0.6), wm.div(1.8)).mul(box(hh, float(0.5), float(1.05), wh));
  const items = step(0.72, hash2(floor(um.div(0.5)).add(si.mul(13.1)), floor(hh.div(0.4)))).mul(box(hh, float(0.55), float(1.5), wh));
  const itemC = mix(pal(4, fract(rs.mul(3.7).add(floor(um.div(0.5)).mul(0.13)))), backC, 0.35);
  const detailK = float(1).sub(shopFar);
  let interior: N = backC.mul(grad);
  interior = mix(interior, interior.mul(0.35), clamp(upr.add(shelves), 0, 1).mul(isStore).mul(detailK));
  interior = mix(interior, interior.mul(0.3), tables.mul(float(1).sub(isStore)).mul(detailK));
  interior = mix(interior, itemC.mul(grad), items.mul(detailK).mul(0.8));
  const shopGlass = interior.mul(0.45);
  // lettering: blocky glyphs across the middle of the sign band
  const gx = um.div(0.3);
  const glyph = step(0.3, hash2(floor(gx).add(si.mul(7.7)), seed.add(1))).mul(box(fract(gx), float(0.14), float(0.86), wm.div(0.3)))
    .mul(box(hh, float(3.3), signTop.sub(0.2), wh)).mul(box(um, unitW.mul(0.18), unitW.mul(0.82), wm));
  const signLum = dot(signC, vec3(0.3, 0.59, 0.11));
  const letterC = select(signLum.greaterThan(0.25), lin(0.08, 0.08, 0.08), select(rs3.lessThan(0.5), lin(0.97, 0.95, 0.9), lin(0.98, 0.8, 0.25)));
  const signFull = mix(signC, letterC, glyph.mul(float(1).sub(shopFar)));
  let shopC: N = wallC; // piers + cornice default to the wall
  shopC = mix(shopC, bulkC, bulkZ.mul(float(1).sub(pier)));
  shopC = mix(shopC, shopGlass, glassZ.mul(float(1).sub(pier)));
  shopC = mix(shopC, bulkC.mul(0.6), box(hh, float(2.9), float(3.12), wh).mul(float(1).sub(pier)));
  shopC = mix(shopC, signFull, signZ.mul(float(1).sub(pier.mul(0.6))));
  shopC = mix(shopC, mix(bulkC.mul(0.5), lin(0.12, 0.13, 0.13), doorGlass), doorZ);
  const shopZone = isShop.mul(step(hh, P1.y)).mul(isWall);
  col = mix(col, shopC, shopZone);
  const shopGlassMask = glassZ.mul(float(1).sub(pier)).mul(float(1).sub(doorZ)).add(doorGlass.mul(doorZ)).mul(shopZone);

  // ---- office / civic lobby: full-height glazing with mullions
  const lobbyH = P1.y;
  const lu = fract(u.div(unitW));
  const lw = max(fwidth(u.div(unitW)), 0.002);
  const mull = float(1).sub(box(lu, float(0.04), float(0.96), lw)).add(box(hh, float(2.95), float(3.1), wh)).add(step(hh, 0.12));
  // the lobby behind the glass (interior-mapped like the rooms above): 9 m deep, pot lights on a
  // grid in the ceiling, a lit back wall with the reception desk, a polished floor
  const lroomH = lobbyH.sub(0.4);
  const lobbyRoom: N = Fn(() => {
    const r = float(0.5).toVar();
    If(isLobby.greaterThan(0.5).and(hh.lessThan(lobbyH)).and(isWall.greaterThan(0.5)), () => {
      const tBl = float(9).div(ic);
      const yBl = hh.add(ib.mul(tBl));
      const hitCl = step(lroomH, yBl), hitFl = step(yBl, 0.0).mul(float(1).sub(hitCl));
      const tCl = lroomH.sub(hh).div(max(ib, 0.0001));
      const xCl = u.add(ia.mul(tCl)), zCl = tCl.mul(ic);
      const pots = box(fract(xCl.div(2.2)), float(0.43), float(0.57), float(0.02)).mul(box(fract(zCl.div(2.2)), float(0.43), float(0.57), float(0.02)));
      const lobCeil = pots.mul(2.2).add(0.28).div(zCl.mul(0.05).add(1));
      const lobBack = mix(float(0.55), float(0.3), step(yBl, 1.1)).mul(fract(seed.mul(0.29)).mul(0.4).add(0.8));
      const lobFloor = float(0.36).div(hh.div(max(ib.negate(), 0.0001)).mul(ic).mul(0.06).add(1));
      r.assign(mix(mix(lobBack, lobFloor, hitFl), lobCeil, hitCl));
    });
    return r;
  })();
  const lobbyC = mix(lin(0.36, 0.33, 0.27).mul(lobbyRoom.mul(0.6).add(0.7)), lin(0.12, 0.12, 0.13), clamp(mull, 0, 1));
  const lobbyZone = isLobby.mul(step(hh, lobbyH.sub(0.4))).mul(isWall).mul(box(u, float(0.6), L.sub(0.6), max(fwidth(u), 0.001)));
  col = mix(col, lobbyC, lobbyZone);
  col = mix(col, wallC.mul(0.8), isLobby.mul(isWall).mul(box(hh, lobbyH.sub(0.4), lobbyH, wh)));

  // ---- loading doors (industrial); on BLANK walls (laneway garages, workers/buildings.ts) residential garage doors
  const isGar = step(9.5, style).mul(step(style, 10.5));
  const dHalf = mix(float(1.6), min(unitW.mul(0.5).sub(0.35), float(1.25)), isGar);
  const dTop = mix(float(3.7), float(2.15), isGar);
  const dOn = max(step(rs, 0.65), isGar);
  const dockDoor = box(um, unitW.mul(0.5).sub(dHalf), unitW.mul(0.5).add(dHalf), wm).mul(step(hh, dTop)).mul(dOn);
  const ribP = mix(float(0.16), float(0.54), isGar);
  const ribs = sin(hh.div(ribP).mul(6.2832)).mul(mix(float(0.08), float(0.12), isGar)).mul(float(1).sub(smoothstep(0.3, 0.6, fwidth(hh.div(ribP)))));
  // garage door colours: white, cream, brown, grey, green, black
  const garC = select(rs.lessThan(0.3), lin(0.86, 0.85, 0.82), select(rs.lessThan(0.45), lin(0.8, 0.74, 0.62), select(rs.lessThan(0.6), lin(0.36, 0.25, 0.17),
    select(rs.lessThan(0.75), lin(0.52, 0.53, 0.53), select(rs.lessThan(0.87), lin(0.2, 0.3, 0.24), lin(0.12, 0.12, 0.13))))));
  let dockC: N = mix(lin(0.55, 0.56, 0.56), garC, isGar).mul(float(1).add(ribs));
  // tasteful graffiti on some laneway garage doors: bubbly letter fills with a dark outline
  const gsd = rs2.mul(40);
  const gu = um.sub(unitW.mul(0.5)).mul(1.1), gv = hh.mul(1.25);
  const gf = sin(gu.mul(2.6).add(sin(gv.mul(3.3).add(gsd)).mul(1.2)).add(gsd.mul(0.7))).mul(sin(gv.mul(4.6).add(sin(gu.mul(2.1).add(gsd.mul(1.3))).mul(1.4))));
  const gBand = box(hh, float(0.35), float(1.75), wh).mul(box(um, unitW.mul(0.5).sub(dHalf).add(0.2), unitW.mul(0.5).add(dHalf).sub(0.2), wm));
  const gOn = isGar.mul(step(rs2, 0.16)).mul(float(1).sub(shopFar)).mul(gBand);
  dockC = mix(dockC, mix(signC, pal(4, fract(rs2.mul(5.3))), step(0.5, fract(gu.mul(0.35).add(gv.mul(0.2))))), step(0.18, gf).mul(gOn));
  dockC = mix(dockC, lin(0.03, 0.03, 0.035), step(0.08, gf).mul(step(gf, 0.18)).mul(gOn));
  const dockFrame = box(um, unitW.mul(0.5).sub(dHalf.add(0.2)), unitW.mul(0.5).add(dHalf.add(0.2)), wm).mul(step(hh, dTop.add(0.2))).mul(dOn);
  const dockZone = isDock.mul(isWall);
  col = mix(col, lin(0.25, 0.25, 0.24), dockFrame.mul(dockZone));
  col = mix(col, dockC, dockDoor.mul(dockZone));

  // ---- roof: gravel / membrane mottling
  const rp = vec2(positionWorld.x, positionWorld.z);
  const rn = hash2(floor(rp.x.div(1.7)), floor(rp.y.div(1.7))).sub(0.5).mul(0.1)
    .add(hash2(floor(rp.x.div(9.3)), floor(rp.y.div(9.3))).sub(0.5).mul(0.12));
  // real roof decks (not paint / aprons, which carry H = 999): per-building finish from the seed —
  // gravel ballast, single-ply membrane with seams on the street grid (≈ −16.7°), or dark modified bitumen
  const deck = step(Ht, 900).mul(isRoof).mul(step(0.35, abs(normalLocal.y)));
  const rt = fract(seed.mul(0.618));
  const rq = vec2(rp.x.mul(0.958).sub(rp.y.mul(0.287)), rp.x.mul(0.287).add(rp.y.mul(0.958)));
  const fineW = max(fwidth(rp.x), fwidth(rp.y));
  const nearR = float(1).sub(smoothstep(0.05, 0.25, fineW));
  const gravel = hash2(floor(rp.x.div(0.22)), floor(rp.y.div(0.22))).sub(0.5).mul(0.22).mul(nearR);
  const sq = rq.x.div(3.05);
  const seam = box(fract(sq), float(0), float(0.02), max(fwidth(sq), 0.001)).mul(float(1).sub(smoothstep(0.1, 0.4, fwidth(sq))));
  const bq = rq.y.div(0.95);
  const lap = box(fract(bq), float(0), float(0.05), max(fwidth(bq), 0.001)).mul(float(1).sub(smoothstep(0.15, 0.45, fwidth(bq))));
  const stain = smoothstep(0.55, 0.9, hash2(floor(rq.x.div(6.1)), floor(rq.y.div(4.3)))).mul(0.14);
  const isGravel = step(rt, 0.42), isMem = step(0.42, rt).mul(step(rt, 0.78)), isBit = step(0.78, rt);
  const finish = float(1).add(gravel.mul(isGravel)).sub(seam.mul(0.12).mul(isMem)).sub(lap.mul(0.1).mul(isBit)).sub(stain.mul(isMem.add(isBit)));
  col = mix(col, base.mul(float(1).add(rn)), isRoof.mul(step(0.35, abs(normalLocal.y))));
  col = mix(col, col.mul(finish).mul(mix(float(1), float(0.62), isBit)), deck);
  // sidewalk apron in front of street walls (H = 998, h = distance from the face): 1.5 m slab joints
  const isApron = isRoof.mul(step(997.5, Ht)).mul(step(Ht, 998.5));
  const jU = u.div(1.5), jD = hh.div(1.5);
  const slabJ = float(1).sub(box(fract(jU), float(0.01), float(0.99), max(fwidth(jU), 0.001)).mul(box(fract(jD), float(0.01), float(0.99), max(fwidth(jD), 0.001))))
    .mul(float(1).sub(smoothstep(0.1, 0.35, max(fwidth(jU), fwidth(jD)))));
  col = mix(col, col.mul(float(1).sub(slabJ.mul(0.28))), isApron);

  // ---- awnings (striped or solid fabric) and plaza canopies (sign fascia)
  const aw = fract(u.div(0.36));
  const stripes = step(0.5, aw).mul(step(0.45, rs2));
  const awC = mix(base, lin(0.93, 0.91, 0.86), stripes.mul(float(1).sub(smoothstep(0.2, 0.5, fwidth(u.div(0.36))))));
  col = mix(col, awC, isAwning);
  const fascia = isCanopy.mul(float(1).sub(step(0.35, abs(normalLocal.y))));
  const cSign = box(um, float(0.7), unitW.sub(0.7), wm).mul(box(hh, float(3.45), float(4.05), wh)).mul(fascia).mul(step(0.12, rs));
  const cGlyph = step(0.3, hash2(floor(gx).add(si.mul(7.7)), seed.add(2))).mul(box(fract(gx), float(0.14), float(0.86), wm.div(0.3)))
    .mul(box(hh, float(3.55), float(3.95), wh)).mul(box(um, unitW.mul(0.25), unitW.mul(0.75), wm));
  col = mix(col, base, isCanopy);
  col = mix(col, mix(signC, letterC, cGlyph.mul(float(1).sub(shopFar))), cSign);

  m.colorNode = baseTone(col);

  // ---- emissive: glass reflections by day, lights at night
  const night = U.night;
  const dayRefl = float(1).sub(night.mul(0.75));
  let em: N = reflCol(wr).mul(refl).mul(win).mul(dayRefl);
  // shop glass at street level mostly mirrors the street and the facades across it, not the sky
  em = em.add(mix(min(reflCol(rs), vec3(0.35)), vec3(0.12, 0.125, 0.13), 0.5).mul(fres.mul(0.12).add(0.035)).mul(shopGlassMask).mul(dayRefl));
  em = em.add(reflCol(float(0.5)).mul(fres.mul(0.5).add(0.15)).mul(lobbyZone).mul(float(1).sub(clamp(mull, 0, 1))).mul(dayRefl));
  // ---- lit rooms
  // occupancy: the use's schedule × a per-building character (some towers busy, some nearly dark)
  const prob: N = isUse(0).mul(OCC.x).add(isUse(1).mul(OCC.y)).add(isUse(2).mul(OCC.z.mul(0.45)))
    .add(isUse(3).mul(OCC2.y)).add(isUse(4).mul(OCC2.x)).add(isUse(5).mul(OCC2.z)).add(isUse(6).mul(OCC2.y.mul(0.4).add(0.03)))
    .add(isUse(7).mul(0.92));
  const bChar = fract(seed.mul(0.6180339).add(0.137));
  const pb = clamp(prob.mul(bChar.mul(bChar).mul(2.1).add(0.3)), 0, 0.95); // mean ×1, range ×0.3–2.4
  // offices: whole floors on or off, a few late workers on dark floors; homes: unit by unit
  const floorLit = step(floorR, pb.mul(1.12));
  const unitLit = mix(step(unitR, pb), mix(step(unitR, pb.mul(0.25)), step(unitR, 0.88), floorLit), officeLike);
  const litNear = unitLit.mul(step(0.1, wr2)); // the odd dark room inside a lit flat / zone
  // LOD (a mip chain of the lit pattern): once a window cell drops below ~3 px the pattern is
  // shown per group of 2^k × 2^k windows, k growing with distance, each group lit to a fraction
  // drawn around the building's mean with the spread a real average of that many rooms has (more
  // for offices: floors switch together). Groups stay ≥ ~1 px, so nothing sparkles, yet a far
  // tower still reads as patches of light rather than one flat glowing wall.
  const lodMid = far;
  const fp = max(wX, wY);
  const lvl = clamp(log2(fp.div(0.3)), 0, 6);
  const kA = floor(lvl), kT = smoothstep(0.2, 0.8, fract(lvl));
  const pAvg = pb.mul(0.9);
  const sdK = sqrt(pAvg.mul(float(1).sub(pAvg))).mul(3.46).mul(mix(float(1), float(1.8), officeLike));
  const grp = (k: N): N => {
    const gs = exp2(k);
    const gh = hash2(seed.mul(0.13).add(floor(colI.div(gs)).mul(1.7)).add(k.mul(5.1)), floor(fl.div(gs)).mul(2.3).add(L.mul(0.071)));
    return clamp(pAvg.add(gh.sub(0.5).mul(sdK).div(gs)), 0, 1);
  };
  const litV: N = Fn(() => {
    const v = float(litNear).toVar();
    If(lvl.greaterThan(0.0001), () => { v.assign(mix(select(kA.lessThan(0.5), litNear, grp(kA)), grp(kA.add(1)), kT)); });
    return v;
  })();
  const lodFar = smoothstep(1, 3.5, lvl);
  // colour temperature per flat / zone: homes 2700 K lamps, 3000 K, some 4000 K, a blue TV glow;
  // offices 4000 K fluorescent / LED, some 3500 K, a few 5000 K; hotels warm; hospitals cool
  const tv = step(0.93, tempR).mul(isUse(0));
  const resC = mix(mix(mix(vec3(1.0, 0.6, 0.3), vec3(1.0, 0.72, 0.45), step(0.5, tempR)), vec3(0.92, 0.88, 0.78), step(0.8, tempR)), vec3(0.42, 0.56, 1.0), tv);
  const offC = mix(mix(vec3(0.86, 0.89, 0.9), vec3(0.96, 0.88, 0.7), step(0.65, tempR)), vec3(0.78, 0.86, 1.0), step(0.9, tempR));
  const cool = isUse(5).add(isUse(7).mul(step(0.5, bChar)));
  const lightC = mix(mix(resC, offC, officeLike), vec3(0.82, 0.9, 1.0), cool);
  const avgC = mix(mix(vec3(1.0, 0.7, 0.42), vec3(0.9, 0.88, 0.8), officeLike), vec3(0.85, 0.9, 0.98), cool);
  const flick = float(1).sub(tv.mul(sin(U.time.mul(7.3).add(unitR.mul(40))).mul(sin(U.time.mul(2.9).add(unitR.mul(17)))).mul(0.3).add(0.15)));
  // what the pane shows: the room, or light through the curtain / blind
  const coverI = mix(mix(float(0.42), float(0.3).mul(float(1).sub(slats.mul(0.6))), officeLike), float(0.55), curtain.mul(sheer));
  const paneI = mix(roomI, coverI, cover).mul(flick);
  const lcol = mix(lightC.mul(mix(vec3(1), coverC.mul(1.3), cover.mul(float(1).sub(officeLike)).mul(0.6))), avgC, lodMid);
  // far: a facade of sub-pixel lights reads darker than its mathematical average (and a flat
  // glow reads as a lit wall), so the averaged levels are toned down
  const inten = mix(paneI, float(0.4), lodMid).mul(mix(float(1), float(0.62), lodFar));
  const pane = float(1).sub(clamp(frameM, 0, 1).mul(float(1).sub(far)));
  em = em.add(lcol.mul(litV).mul(win).mul(pane).mul(inten).mul(night).mul(0.62));
  // by day a lit office shows its ceiling lights faintly behind the glass
  em = em.add(lcol.mul(litV).mul(win).mul(pane).mul(roomI).mul(float(1).sub(lodMid)).mul(float(1).sub(night)).mul(officeLike).mul(0.05));
  // shops: most lit in the evening; signs backlit
  const shopLit = step(float(1).sub(OCC.z), rs3);
  // light spilling from lit shop windows / lobbies onto the sidewalk apron in front
  em = em.add(backC.mul(1.3).mul(shopLit).mul(isShop).mul(isApron).mul(exp(hh.negate().div(1.6))).mul(float(1).sub(pier.mul(0.55))).mul(night));
  em = em.add(lin(0.95, 0.9, 0.78).mul(isLobby).mul(isApron).mul(exp(hh.negate().div(2.4))).mul(night).mul(OCC.y.mul(0.25).add(0.12)));
  em = em.add(interior.mul(1.6).mul(shopGlassMask).mul(shopLit).mul(night).mul(rs2.mul(0.4).add(0.45)));
  em = em.add(signFull.mul(signZ).mul(shopZone).mul(step(rs2, OCC.z.mul(0.75))).mul(night).mul(0.8));
  em = em.add(signC.mul(cSign).mul(night).mul(0.8));
  // lobbies stay lit all night (security desk), brightest in office hours
  em = em.add(lin(0.97, 0.9, 0.76).mul(lobbyRoom).mul(lobbyZone).mul(float(1).sub(clamp(mull, 0, 1))).mul(night.mul(OCC.y.mul(0.35).add(0.4)).add(0.03)));
  // canopy soffit pot lights
  em = em.add(lin(1, 0.85, 0.6).mul(isCanopy).mul(step(normalLocal.y, -0.5)).mul(night).mul(0.5));
  (m as unknown as { emissiveNode: N }).emissiveNode = em.mul(float(1).sub(U.analytics.mul(0.7)));
  return m;
}
