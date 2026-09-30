// Material for the level-0 vector ground (workers/ground.ts): land-cover
// classes with world-space micro detail, sports markings, water and shore banks.
//
// Per-class look lives in a small table texture (CLASS row 0 colour + roughness,
// rows 1-2 detail weights, row 3 extras) so adding a class is a table edit.
// Detail textures are two luminance packs (textures/CREDITS.md), sampled in
// tile-local metres with periods that divide the 1024 m tile (seamless across
// tiles, no large-coordinate precision loss), two octaves + a macro variation.
// Water: analytic waves whose normal amplitude is attenuated by each wave's
// wavelength against the pixel footprint (no moiré at any distance or grazing
// angle), sky reflection with Schlick fresnel as emission, sun glint through the
// lit specular, shallow tint + foam from the per-vertex shore distance.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, vec4, texture, positionLocal, normalLocal, modelWorldMatrix, positionGeometry,
  cameraPosition, transformNormalToView, mix, smoothstep, clamp, floor, fract, max, min, abs, length, normalize, pow,
  sin, cos, fwidth, select, dot, reflect, round,
} from 'three/tsl';
import { U } from '../uniforms';
import { baseTone } from './materials';
import { streetTexture } from './roadMaterial';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

interface ClassLook {
  col: number; rough: number;
  /** detail pack A weights: grass, asphalt, concrete, gravel */
  a?: [number, number, number, number];
  /** detail pack B weights: rock, sand, soil, cliff rock */
  b?: [number, number, number, number];
  /** macro colour variation strength, mowing stripes */
  macro?: number; mow?: number;
}

/** SPEC ground classes (+ vector-only 24-29, banks 30-33, portals 34-37) */
export const GROUND_LOOK: Record<number, ClassLook> = {
  0: { col: 0x9ea477, rough: 0.97, a: [0.8, 0, 0, 0.1], b: [0, 0, 0.45, 0], macro: 0.7 }, // rough grass / meadow
  2: { col: 0x7f9c58, rough: 0.96, a: [1, 0, 0, 0], b: [0, 0, 0.15, 0], macro: 0.45 }, // park grass
  3: { col: 0x5b6a3e, rough: 0.98, a: [0.35, 0, 0, 0], b: [0, 0, 0.9, 0], macro: 0.5 }, // forest floor
  4: { col: 0x809e55, rough: 0.96, a: [1, 0, 0, 0], macro: 0.55 }, // residential lawn
  5: { col: 0x8b8984, rough: 0.9, a: [0, 0.6, 0.25, 0], macro: 0.35 }, // commercial paving
  6: { col: 0x87837a, rough: 0.92, a: [0, 0.45, 0.2, 0.55], macro: 0.6 }, // industrial yard
  7: { col: 0xa19d66, rough: 0.97, a: [0.45, 0, 0, 0], b: [0, 0, 0.7, 0], macro: 0.8 }, // farmland
  8: { col: 0xd8c9a0, rough: 0.95, b: [0, 1.1, 0, 0], macro: 0.25 }, // sand / beach
  10: { col: 0x857d72, rough: 0.95, a: [0, 0, 0, 1.2], b: [0, 0, 0.2, 0], macro: 0.4 }, // rail lands: ballast / gravel
  11: { col: 0x5d5c59, rough: 0.88, a: [0, 1.1, 0, 0], macro: 0.25 }, // parking asphalt
  12: { col: 0x7a9860, rough: 0.96, a: [1, 0, 0, 0], macro: 0.3 }, // cemetery lawn
  13: { col: 0x71a04f, rough: 0.95, a: [0.8, 0, 0, 0], macro: 0.3, mow: 1 }, // golf
  16: { col: 0x69774f, rough: 0.9, a: [0.6, 0, 0, 0], b: [0, 0, 0.6, 0], macro: 0.6 }, // wetland
  17: { col: 0x839f5c, rough: 0.96, a: [1, 0, 0, 0], macro: 0.4 }, // institutional grounds
  18: { col: 0x9a8a6d, rough: 0.97, a: [0, 0, 0, 0.5], b: [0, 0, 1, 0], macro: 0.7 }, // construction / bare earth
  19: { col: 0x5c9644, rough: 0.95, a: [0.8, 0, 0, 0], macro: 0.15, mow: 1 }, // sports pitch
  21: { col: 0xb2ada3, rough: 0.9, a: [0, 0, 0.5, 0], macro: 0.25 }, // plaza / platform
  23: { col: 0x8fad68, rough: 0.96, a: [1, 0, 0, 0], macro: 0.35 }, // airfield grass
  24: { col: 0x4d7b5a, rough: 0.8, a: [0, 0.25, 0, 0] }, // hard court (surround)
  25: { col: 0x68994a, rough: 0.95, a: [0.8, 0, 0, 0], macro: 0.15, mow: 1 }, // ball diamond
  26: { col: 0x9e4c3a, rough: 0.9, a: [0, 0.3, 0, 0] }, // running track
  27: { col: 0xa8a49a, rough: 0.9, a: [0, 0, 0.45, 0] }, // pier / quay deck
  28: { col: 0x8d8980, rough: 0.95, b: [1.2, 0, 0, 0] }, // breakwater armour stone
  29: { col: 0x869f5d, rough: 0.96, a: [1, 0, 0, 0], b: [0, 0, 0.2, 0], macro: 0.4 }, // mown verge
  30: { col: 0xa19d93, rough: 0.9, a: [0, 0, 0.45, 0] }, // dockwall
  31: { col: 0x8f8b82, rough: 0.95, b: [1.4, 0, 0, 0] }, // revetment
  32: { col: 0xd3c49c, rough: 0.95, b: [0, 1, 0, 0] }, // beach bank
  33: { col: 0x6f6448, rough: 0.97, a: [0.3, 0, 0, 0], b: [0.3, 0, 0.9, 0] }, // natural bank
  34: { col: 0x9d998f, rough: 0.9, a: [0, 0, 0.45, 0] }, // trench wall
  35: { col: 0x746d63, rough: 0.95, a: [0, 0, 0, 0.7] }, // trench floor ballast
  36: { col: 0x0d0d0e, rough: 1.0 }, // tunnel mouth
  37: { col: 0xa6a298, rough: 0.9, a: [0, 0, 0.5, 0] }, // portal headwall
  38: { col: 0x77736d, rough: 0.45 }, // rails in open cuts
  39: { col: 0x7d9656, rough: 0.96, a: [1, 0, 0, 0], b: [0, 0, 0.3, 0], macro: 0.4 }, // embankment grass
};

function classTable(): THREE.DataTexture {
  const W = 64, data = new Uint8Array(W * 4 * 4);
  for (let i = 0; i < W; i++) {
    const L = GROUND_LOOK[i] ?? GROUND_LOOK[0];
    const k = i * 4;
    data[k] = (L.col >> 16) & 255; data[k + 1] = (L.col >> 8) & 255; data[k + 2] = L.col & 255; data[k + 3] = Math.round(L.rough * 255);
    const a = L.a ?? [0, 0, 0, 0], b = L.b ?? [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      data[W * 4 + k + c] = Math.round(Math.min(a[c], 2) * 127);
      data[W * 8 + k + c] = Math.round(Math.min(b[c], 2) * 127);
    }
    data[W * 12 + k] = Math.round((L.macro ?? 0) * 255);
    data[W * 12 + k + 1] = Math.round((L.mow ?? 0) * 255);
  }
  // row 0 is colour (sRGB) but rows 1-3 are data: keep the texture linear and decode row 0 in the shader
  const t = new THREE.DataTexture(data, W, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const f01 = (c: N) => select(c, float(1), float(0));
const isCls = (cls: N, k: number) => f01(abs(cls.sub(k)).lessThan(0.5));
/** anti-aliased coverage of a line of half-width w at signed distance d */
const line = (d: N, w: number | N) => {
  const fw = max(fwidth(d), 1e-4);
  return clamp(float(w).sub(abs(d)).div(fw).add(0.5), 0, 1);
};

let _mat: THREE.MeshStandardNodeMaterial | null = null;
export const groundMaterial = () => (_mat ??= makeGroundMaterial());

function makeGroundMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'ground';
  m.metalness = 0;
  const table = classTable();
  const texA = streetTexture('ground_detail_a.webp', false);
  const texB = streetTexture('ground_detail_b.webp', false);

  const gd = attribute('gd', 'vec4');
  const cls = round(gd.x);
  const row = (r: number) => texture(table, vec2(cls.add(0.5).div(64), (r + 0.5) / 4));
  const look = row(0), wA = row(1).mul(255 / 127), wB = row(2).mul(255 / 127), ext = row(3);
  const baseCol = pow(look.rgb, vec3(2.2));

  // tile-local metres (E, N); periods below divide 1024 m
  const e = positionLocal.x, nN = positionLocal.z.negate(), h = positionLocal.y;
  const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const toCam = cameraPosition.sub(wp);
  const dist = length(toCam);
  const viewDir = toCam.div(dist);

  const banks = cls.greaterThan(29.5).and(cls.lessThan(37.5));
  // banks and walls use (along, height) texture coordinates (floors, rails and fills use the plan)
  const vert = banks.and(abs(cls.sub(35)).greaterThan(0.5));
  const uv = select(vert, vec2(gd.y, h), vec2(e, nN));
  const uv1 = uv.div(4);
  const uv2 = vec2(e.mul(3).add(nN.mul(4)), e.mul(-4).add(nN.mul(3))).div(128); // rotated octave, 25.6 m
  const uvM = vec2(e.mul(5).sub(nN.mul(12)), e.mul(12).add(nN.mul(5))).div(1024); // macro, ~79 m
  const tA = texture(texA, uv1), tB = texture(texB, uv1);
  const tA2 = texture(texA, uv2), tB2 = texture(texB, uv2);
  const mac = texture(texB, uvM).b.sub(0.5).mul(2); // smooth large-scale noise (-1..1)
  const near = smoothstep(900, 60, dist);
  const det = dot(wA, tA.sub(0.5)).add(dot(wB, tB.sub(0.5)))
    .add(dot(wA, tA2.sub(0.5)).add(dot(wB, tB2.sub(0.5))).mul(0.6));
  const detail = float(1).add(det.mul(1.6).mul(mix(0.35, 1, near)));
  // macro variation: lighter / yellower vs darker / greener patches
  const macro = ext.r.mul(mac);
  let col: N = baseCol.mul(float(1).add(macro.mul(0.18))).add(vec3(0.02, 0.012, -0.01).mul(macro));
  col = col.mul(clamp(detail, 0.45, 1.6));
  // steep natural ground (bluffs, ravine walls): bare clay / earth
  const steep = smoothstep(0.86, 0.62, normalLocal.y).mul(f01(cls.lessThan(23.5).or(isCls(cls, 29).greaterThan(0.5))));
  const clay = pow(vec3(0.66, 0.58, 0.46), vec3(2.2)).mul(clamp(float(1).add(tB.a.sub(0.5).mul(0.9)).add(tB2.a.sub(0.5).mul(0.5)), 0.5, 1.5));
  col = mix(col, clay, steep.mul(float(1).sub(isCls(cls, 1))));
  // mowing stripes (golf, pitches): 5 m bands along the frame / east axis
  const isPitch = isCls(cls, 19).add(isCls(cls, 25));
  const mowCoord = select(isPitch.greaterThan(0.5), gd.y, e.add(nN.mul(0.5)));
  const mow = smoothstep(0.35, 0.65, abs(fract(mowCoord.div(10)).sub(0.5)).mul(2)).sub(0.5).mul(ext.g).mul(0.12).mul(near);
  col = col.mul(float(1).add(mow));

  // ---- sports markings (frame-local u, v in gd.y / gd.z; size packed in gd.w)
  const u = gd.y, v = gd.z;
  const hl = floor(gd.w.div(1024)).div(4), hw = gd.w.mod(1024).div(4);
  const au = abs(u), av = abs(v);
  const W = 0.06;
  // soccer (19): touch/goal lines, halfway, centre circle, penalty & goal areas
  const inset = min(1.0, hw.mul(0.05));
  const A = hl.sub(inset), B = hw.sub(inset);
  const rect = (cu: N, a: N, b: N) => line(max(abs(au.sub(cu)).sub(a), av.sub(b)), W);
  const big = f01(hl.greaterThan(30));
  const pen = min(16.5, hl.mul(0.3)), penW = min(20.15, B.mul(0.6));
  const goal = min(5.5, hl.mul(0.1)), goalW = min(9.15, B.mul(0.3));
  const soccer = max(max(rect(0, A, B), line(u, W).mul(f01(av.lessThan(B)))),
    max(line(length(vec2(u, v)).sub(min(9.15, B.mul(0.3))), W),
      max(rect(A.sub(pen.mul(0.5)), pen.mul(0.5), penW), rect(A.sub(goal.mul(0.5)), goal.mul(0.5), goalW)).mul(big)));
  // tennis (24, 10 < hl < 20) or a generic court outline
  const tennis = f01(hl.greaterThan(10).and(hl.lessThan(20)));
  const inCourt = f01(au.lessThan(11.885).and(av.lessThan(5.485)));
  const tLines = max(max(line(max(au.sub(11.885), av.sub(5.485)), 0.04), line(max(au.sub(11.885), av.sub(4.115)), 0.04)),
    max(line(max(au.sub(6.4), av.sub(4.115)), 0.04).mul(f01(au.lessThan(6.45))), line(v, 0.04).mul(f01(au.lessThan(6.4)))));
  const gLines = max(line(max(au.sub(hl.sub(0.5)), av.sub(hw.sub(0.5))), 0.05), max(line(u, 0.05).mul(f01(av.lessThan(hw.sub(0.5)))), line(length(vec2(u, v)).sub(1.8), 0.05)));
  const court = mix(gLines, tLines, tennis);
  // running track (26): stadium rings, 1.22 m lanes
  const sa = max(hl.sub(hw), 0);
  const r = length(vec2(max(au.sub(sa), 0), v));
  const dd = hw.sub(0.4).sub(r);
  const lane = dd.sub(round(dd.div(1.22)).mul(1.22));
  const onTrack = f01(dd.greaterThan(-0.1).and(dd.lessThan(9.9)));
  const trackL = line(lane, 0.025).mul(onTrack);
  const isC = isCls(cls, 24), isT = isCls(cls, 26), isS = isCls(cls, 19);
  const courtCol = mix(pow(vec3(0.3, 0.52, 0.42), vec3(2.2)), pow(vec3(0.27, 0.42, 0.55), vec3(2.2)), inCourt.mul(tennis));
  col = mix(col, courtCol.mul(clamp(detail, 0.9, 1.1)), isC);
  const trackCol = mix(pow(vec3(0.45, 0.6, 0.3), vec3(2.2)).mul(clamp(detail, 0.7, 1.3)), col, onTrack);
  col = mix(col, trackCol, isT);
  const marks = soccer.mul(isS).add(court.mul(isC)).add(trackL.mul(isT));
  col = mix(col, vec3(0.86, 0.86, 0.84), clamp(marks, 0, 1).mul(smoothstep(700, 150, dist)));

  // ---- banks: wet / algae band just above the water line
  const bankH = gd.z; // height above water (m)
  const wetBand = smoothstep(0.7, 0.05, bankH).mul(f01(banks.and(cls.lessThan(33.5)))).mul(mix(float(0.8), float(0.3), isCls(cls, 32)));
  col = mix(col, col.mul(vec3(0.55, 0.6, 0.5)), wetBand);
  // natural banks: grass creeping over the top
  const grassTop = smoothstep(0.5, 1.2, bankH).mul(isCls(cls, 33));
  col = mix(col, pow(vec3(0.42, 0.52, 0.3), vec3(2.2)).mul(clamp(detail, 0.6, 1.4)), grassTop.mul(0.7));

  // ---- water
  const isW = isCls(cls, 1);
  const shoreD = gd.y, shoreT = round(gd.z), kind = round(gd.w);
  const WS = waterSurface(e, nN, dist, viewDir, kind, shoreD, shoreT, tB.g.add(tA.r.mul(0.3)));
  const { wN, wcol, fres, sky, foam } = WS;
  col = mix(col, wcol.mul(float(1).sub(fres)), isW);

  m.colorNode = baseTone(col);
  (m as unknown as { emissiveNode: N }).emissiveNode = sky.mul(fres).mul(isW).mul(float(1).sub(U.analytics.mul(0.8))).mul(0.7);
  const rough = mix(look.a, mix(float(0.07), float(0.6), foam), isW);
  m.roughnessNode = rough;
  m.normalNode = transformNormalToView(normalize(mix(normalLocal, wN, isW)));
  void sin; void Fn;
  return m;
}

/**
 * Water surface shading shared by the vector ground and the far raster terrain.
 * Ripples: a periodic normal map (32 m and 8 m layers scrolled in different
 * directions; periods divide every tile size) + two long, low swells, each faded
 * by the pixel footprint (mipmapped as well), so it never aliases into stripes.
 * Returns the world normal, body colour (before fresnel), fresnel, sky reflection
 * colour and foam. `kind` 0 lake · 1 pond · 2 river; `shoreD` m; `shoreT` shore type.
 */
export function waterSurface(e: N, nN: N, dist: N, viewDir: N, kind: N, shoreD: N, shoreT: N, noise: N) {
  const waterN = streetTexture('water_normal.webp', false);
  const foot = dist.mul(0.0016).div(max(abs(viewDir.y), 0.12)); // metres per pixel along the surface
  const t = U.time;
  const n1 = texture(waterN, vec2(e, nN).div(32).add(vec2(t.mul(0.011), t.mul(0.007))));
  const n2 = texture(waterN, vec2(nN, e.negate()).div(8).add(vec2(t.mul(-0.023), t.mul(0.017))));
  const f1 = smoothstep(4.0, 0.2, foot), f2 = smoothstep(1.0, 0.05, foot);
  const calm = mix(float(1), float(0.5), f01(kind.greaterThan(0.5))); // ponds / rivers calmer
  const TAU = Math.PI * 2;
  const sw1 = cos(e.mul(TAU * 13 / 1024).add(nN.mul(TAU * 9 / 1024)).add(t.mul(0.5))).mul(0.005).mul(smoothstep(12, 2, foot));
  const sw2 = cos(e.mul(TAU * -7 / 1024).add(nN.mul(TAU * 16 / 1024)).add(t.mul(0.37))).mul(0.004).mul(smoothstep(12, 2, foot));
  const sx = n1.r.sub(0.5).mul(2).mul(f1.mul(0.38)).add(n2.g.sub(0.5).mul(2).mul(f2.mul(0.22))).add(sw1.mul(0.82)).add(sw2.mul(-0.4)).mul(calm);
  const sz = n1.g.sub(0.5).mul(2).mul(f1.mul(0.38)).sub(n2.r.sub(0.5).mul(2).mul(f2.mul(0.22))).add(sw1.mul(0.57)).add(sw2.mul(0.92)).mul(calm);
  // world normal (three axes: x = E, z = -N)
  const wN = normalize(vec3(sx.negate(), 1, sz));
  const shallow = smoothstep(14, 0, shoreD);
  const deep = mix(vec3(0.06, 0.13, 0.16), vec3(0.06, 0.1, 0.08), f01(kind.greaterThan(0.5)));
  const shal = mix(vec3(0.11, 0.2, 0.19), vec3(0.1, 0.13, 0.08), f01(kind.greaterThan(0.5)));
  const beachy = f01(abs(shoreT.sub(3)).lessThan(0.5));
  let wcol: N = mix(deep, mix(shal, vec3(0.2, 0.24, 0.18), beachy.mul(0.6)), shallow);
  // foam line along the shore, broken up by noise, lapping in time
  const foamW = mix(mix(float(0.9), float(0.55), f01(abs(shoreT.sub(1)).lessThan(0.5))), float(2.8), beachy); // dockwalls: a thin line
  const lap = sin(t.mul(0.9).add(e.mul(0.05)).add(nN.mul(0.037))).mul(0.5).add(0.5);
  const foam = smoothstep(foamW.mul(mix(0.7, 1.2, lap)), float(0), shoreD).mul(smoothstep(0.35, 0.6, noise)).mul(f01(shoreT.greaterThan(0.5)));
  wcol = mix(wcol, vec3(0.8, 0.82, 0.8), foam.mul(0.65));
  // sky reflection (emission) with Schlick fresnel
  const cosT = max(dot(viewDir, wN), 0);
  const fres = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosT), 5))).mul(float(1).sub(foam));
  const rdir = reflect(viewDir.negate(), wN);
  const sky = mix(U.skyHorizon, U.skyZenith, pow(clamp(rdir.y, 0, 1), 0.5));
  return { wN, wcol, fres, sky, foam };
}
