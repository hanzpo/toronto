// Vegetation materials (TSL). The pools of a family draw overlapping sets of
// instances; each instance carries its LOD state (ic: current level, previous
// level, switch time) chosen on the CPU per tree — a hashed switch distance
// with hysteresis (Vegetation.ts). The vertex shader collapses instances whose
// state isn't this pool's level; for FADE_S after a switch both levels draw
// and cross-fade through alpha-to-coverage (MSAA), so stills never stipple
// and nothing sparkles in motion. Far trees and small plants shrink out
// (scale morph) instead of fading.
//
//   high  (< ~160 m) LOBED 14 icosahedral lobes / TIERED 7 whorls, cast shadows
//   mid   (< ~650 m) the same lobes / whorls decimated (octahedra, 4-point
//                    stars): same crown, jitter, normals, colour
//   imp   (horizon)  camera-facing quad cut to the lobe union's extent,
//                    lit and coloured per pixel like the meshes
//
// Species shape (crown base, taper, vase, droop, lobe openness), colours and
// fall timing come from a uniform table (species.ts); the season is the sim
// day of year. Wind: a slow whole-tree sway plus lobe flutter.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U } from '../../render/uniforms';
import { baseTone } from '../../render/tiles/materials';
import { SPECIES_ROWS, speciesRows, S as SP_ID } from './species';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T: any = TSL;
const { attribute, uniform, uniformArray, vec3, vec4, float, int, cos, sin, sqrt, max, min, clamp, mix, fract, floor, dot, normalize, length, select, varying, transformNormalToView, positionGeometry, abs, pow, cross, positionWorld } = T;

/** shared per-frame inputs */
export const VU = {
  /** view camera, anchor-relative three coords */
  cam: uniform(new THREE.Vector3()),
  /** LOD distances: high → mid, mid → impostor, impostor fade-out end (m) */
  lod: uniform(new THREE.Vector4(120, 600, 5000, 0)),
  /** sim day of year (fractional) */
  doy: uniform(270),
  /** seconds, the clock of the per-instance LOD switch times (ic.z) */
  now: uniform(0),
};
/** LOD cross-fade length (s) */
export const FADE_S = 0.4;

const TABLE = uniformArray(speciesRows().map((r) => new THREE.Vector4(r[0], r[1], r[2], r[3])), 'vec4');
const row = (sp: N, r: number): N => TABLE.element(sp.mul(SPECIES_ROWS).add(r));
const linstep = (a: N, b: N, x: N) => clamp(x.sub(a).div(b.sub(a)), 0, 1);
const hash = (x: N) => fract(sin(x.mul(12.9898).add(4.1414)).mul(43758.5453));

const ia: N = attribute('ia', 'vec4'); // x, y, z (anchor-relative), seed
const ib: N = attribute('ib', 'vec4'); // height, width, species, extra
const va: N = attribute('va', 'vec4');
const vb: N = attribute('vb', 'vec4');
const ic: N = attribute('ic', 'vec4'); // LOD state: current level, previous level, switch time
const pg: N = positionGeometry;

export type VegLevel = 0 | 1 | 2;

/**
 * LOD visibility of this instance at `level` (vertex stage). The CPU picks each
 * tree's level (hashed per-tree switch distance + hysteresis, Vegetation.ts);
 * on a switch the old and new level cross-fade for FADE_S via alpha-to-coverage
 * (MSAA), so there is no stipple in stills and nothing sparkles while moving.
 * Returns (alpha, size) — size morphs trees out smoothly at the far limit and
 * small plants (shrubs, hedges) at their fade-out distance.
 */
function lodState(level: VegLevel, sp: N) {
  const H = ib.x;
  const d = length(ia.xyz.add(vec3(0, H.mul(0.5), 0)).sub(VU.cam));
  const t = clamp(VU.now.sub(ic.z).div(FADE_S), 0, 1);
  const isCur = abs(ic.x.sub(level)).lessThan(0.5), isPrev = abs(ic.y.sub(level)).lessThan(0.5);
  const alpha = select(isCur, t, float(0)).add(select(isPrev.and(isCur.not()), float(1).sub(t), float(0)));
  const L = VU.lod;
  const maxD = row(sp, 1).w;
  const kSp = select(maxD.greaterThan(0), float(1).sub(linstep(maxD.mul(0.75), maxD, d)), float(1));
  const size = float(1).sub(linstep(L.z.mul(0.8), L.z, d)).mul(kSp);
  return { alpha, size, d };
}

/**
 * foliage coverage: leafless crowns draw at partial alpha-to-coverage, which
 * the MSAA resolve turns into a stable see-through haze — the same in every
 * LOD. Leafy crowns are fully opaque (airy species get gaps between lobes).
 */
function crownCover(leaf: N) {
  return select(leaf.greaterThan(0.97), float(1), mix(float(0.5), float(1), leaf.mul(leaf)));
}

/** fragment: alpha-to-coverage does the LOD fade (× crown cover); shadows switch at half way */
function applyFade(m: THREE.MeshLambertNodeMaterial, fade: N, extraMask: N | null, cover: N | null = null) {
  m.alphaToCoverage = true;
  m.opacityNode = cover ? fade.mul(cover) : fade;
  const half = fade.greaterThanEqual(0.5);
  (m as unknown as { maskShadowNode: N }).maskShadowNode = extraMask ? half.and(extraMask) : half;
  if (extraMask) m.maskNode = extraMask;
}

/** season: vec4(foliage rgb, leaf amount 0 bare … 1 full), per instance; `top` 0..1 turns the crown top first */
function foliage(sp: N, seed: N, top: N) {
  const r2 = row(sp, 2), r3 = row(sp, 3), r4 = row(sp, 4);
  const turn = r2.w, peak = r3.w, drop = r4.w;
  const ever = select(turn.lessThan(1), float(1), float(0));
  const doy = VU.doy.add(seed.sub(0.5).mul(12));
  const leafOut = linstep(float(112), float(140), doy);
  const fallT = linstep(turn, peak, doy.add(top.mul(5))).mul(float(1).sub(ever));
  const dropT = linstep(peak.add(2), drop, doy).mul(float(1).sub(ever));
  const leaf = mix(leafOut.mul(float(1).sub(dropT)), float(1), ever);
  // per-tree variation: brightness and hue
  const v = hash(seed.mul(91.7)).mul(0.3).add(0.85);
  const summer = r2.xyz.mul(vec3(hash(seed.mul(13.1)).mul(0.2).add(0.9), 1, hash(seed.mul(5.3)).mul(0.3).add(0.85))).mul(v);
  const spring = linstep(float(165), float(138), doy).mul(leafOut).mul(float(1).sub(ever));
  const young = mix(summer, vec3(0.14, 0.22, 0.05), spring.mul(0.5));
  const autumn = r3.xyz.mul(hash(seed.mul(47.3)).mul(0.35).add(0.8));
  const col = mix(young, autumn, pow(fallT, 1.6));
  // bare crowns: twig mass, lighter and hazier than bark (reads as a see-through crown)
  const twig = mix(r4.xyz.mul(1.25).add(vec3(0.03, 0.028, 0.025)), vec3(U.skyHorizon).mul(0.5), 0.15);
  // foliage transmits and scatters: brighter than its albedo under a Lambert model
  return vec4(mix(twig, col.mul(1.85), leaf), leaf);
}

/**
 * receive shadows from a point pushed toward the sun: crowns are shaded by
 * other objects (and by other trees), not by their own facets
 */
function softShadow(m: THREE.MeshLambertNodeMaterial, k: number) {
  (m as unknown as { receivedShadowPositionNode: N }).receivedShadowPositionNode = positionWorld.add(U.sunDir.mul(k));
}

/** organic 3D noise (−1 … 1) at ~0.5 m (scale 1) from sines with domain warp (world-space: stable under motion) */
function leafNoise(p: N, scale: number) {
  const q = p.mul(scale);
  const w = q.add(sin(q.yzx.mul(1.9)).mul(1.3));
  return sin(w.x.mul(3.1)).mul(sin(w.y.mul(2.7))).mul(sin(w.z.mul(3.3)));
}

/** instance frame: yaw (hedges: their own heading), hedge length */
function frame(sp: N, seed: N) {
  const isHedge = sp.equal(int(SP_ID.HEDGE));
  const ex = ib.w;
  const len = floor(ex.div(8));
  const ang = ex.sub(len.mul(8)).sub(Math.PI);
  const rot = select(isHedge, ang, seed.mul(6.2832));
  return { isHedge, len, rot, c: cos(rot), s: sin(rot) };
}
const yaw = (p: N, c: N, s: N) => vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.x.mul(s).negate().add(p.z.mul(c)));

function sway(y: N, H: N, seed: N) {
  const k = clamp(y.div(max(H, 1)), 0, 1.2);
  const ph = U.time.mul(1.1).add(seed.mul(40)).add(ia.x.mul(0.021)).add(ia.z.mul(0.017));
  const a = sin(ph).mul(0.5).add(sin(ph.mul(2.3).add(1.7)).mul(0.25)).mul(H.mul(0.009)).mul(k.mul(k));
  return vec3(a, 0, a.mul(0.6));
}

function commonMaterial(name: string) {
  const m = new THREE.MeshLambertNodeMaterial();
  m.name = name;
  return m;
}

// ---------------------------------------------------------------------------- LOBED (high + mid)

export function lobedMaterial(level: 0 | 1) {
  const m = commonMaterial(level === 0 ? 'vegLobedHigh' : 'vegLobedMid');
  const sp = int(ib.z);
  const H = ib.x, W = ib.y, seed = ia.w;
  const r0 = row(sp, 0), r1 = row(sp, 1);
  const base = r0.x, taper = r0.y, vase = r0.z, droop = r0.w;
  const fr = frame(sp, seed);
  const Rx = select(fr.isHedge, max(fr.len, W).mul(0.5), W.mul(0.5));
  const Rz = W.mul(0.5);
  const Hc = H.mul(float(1).sub(base)).mul(0.5);
  const Yc = H.mul(base).add(Hc);
  const kind = vb.x;
  const top = clamp(va.y.mul(0.5).add(0.5), 0, 1);
  const fol = foliage(sp, seed, top);
  const open = r1.x.mul(mix(float(0.7), float(1), fol.w));
  const ls = lodState(level, sp);

  /** crown-unit point → local metres (taper, vase, droop) */
  const crown = (p: N) => {
    const yn = p.y;
    const hs = float(1).sub(taper.mul(yn.mul(0.5).add(0.5))).mul(float(1).add(vase.mul(yn).mul(0.5)));
    const xz = p.xz.mul(hs);
    const py = yn.sub(droop.mul(dot(xz, xz)).mul(0.9));
    return vec3(xz.x.mul(Rx), Yc.add(py.mul(Hc)), xz.y.mul(Rz));
  };
  // foliage: jittered lobe centre (per instance), lobe radius × openness — identical for both LODs
  const lh = vb.z.add(seed.mul(3.7));
  const jit = vec3(hash(lh.mul(17.1)), hash(lh.mul(29.3)), hash(lh.mul(41.9))).sub(0.5).mul(0.24);
  const lr = va.w.mul(open).mul(hash(lh.mul(7.7)).mul(0.3).add(0.85));
  const pc = va.xyz.add(jit).add(pg.mul(lr));
  const flutter = sin(U.time.mul(2.6).add(vb.z.mul(31)).add(seed.mul(11))).mul(0.035).mul(lr);
  const pFol = crown(pc).add(vec3(flutter, flutter.mul(0.5), flutter.mul(-0.7)).mul(max(Rx, Hc)));
  // trunk: from below ground up into the crown centre, tapering
  const tr = r1.y.mul(H).mul(float(1).sub(pg.y.mul(0.45)));
  const pTrunk = vec3(pg.x.mul(tr), pg.y.mul(Yc.add(0.3)).sub(0.3), pg.z.mul(tr));
  // limb: crown base → toward a lobe
  const a0 = vec3(0, H.mul(base).mul(0.92), 0);
  const a1 = crown(va.xyz.mul(0.8));
  const dir = normalize(a1.sub(a0));
  const s1 = normalize(cross(dir, vec3(0.001, 1, 0.002)));
  const s2 = cross(dir, s1);
  const lw = r1.y.mul(H).mul(0.42).mul(float(1).sub(pg.y.mul(0.6)));
  const pLimb = mix(a0, a1, pg.y).add(s1.mul(pg.x.mul(lw))).add(s2.mul(pg.z.mul(lw)));

  const local = select(kind.lessThan(0.5), pTrunk, select(kind.lessThan(1.5), pLimb, pFol));
  const moved = local.add(sway(local.y, H, seed)).mul(ls.size);
  const visible = ls.alpha.greaterThan(0.001).and(ls.size.greaterThan(0.01));
  const wl = ia.xyz.add(yaw(moved, fr.c, fr.s));
  m.positionNode = select(visible, wl, vec3(0));

  // normals (world = mesh local: pools sit at the anchor, unrotated)
  const nOff = normalize(pg);
  const nHull = normalize(pc.add(vec3(0, 0.15, 0)));
  // soft foliage: mostly the crown's spherical normal, a little of the lobe's (no faceted look)
  const nF0 = normalize(mix(nOff, nHull, 0.72));
  const nF = normalize(normalize(vec3(nF0.x.div(max(Rx, 0.3)), nF0.y.div(max(Hc, 0.3)), nF0.z.div(max(Rz, 0.3)))).add(vec3(0, 0.5, 0)));
  const nT = vec3(pg.x, 0, pg.z);
  const nL = s1.mul(pg.x).add(s2.mul(pg.z));
  const nLocal = select(kind.lessThan(0.5), nT, select(kind.lessThan(1.5), nL, nF));
  const vN = varying(yaw(nLocal, fr.c, fr.s), 'vVegN');
  m.normalNode = transformNormalToView(normalize(vN));

  const bark = row(sp, 4).xyz;
  const ao = vb.y;
  const col = select(kind.lessThan(1.5), bark.mul(ao), fol.xyz.mul(ao).mul(hash(lh.mul(3.1)).mul(0.16).add(0.92)));
  const vCol = varying(vec4(col, select(kind.lessThan(1.5), float(0), float(1))), 'vVegC');
  const vA = varying(ls.alpha, 'vVegA');
  let edge: N = null;
  if (level === 0) {
    // leafy, ragged silhouettes on near crowns only (world-space noise: stable
    // under motion); the cut fades out by 55 m, well before the switch to mid
    const vP = varying(vec4(wl.sub(VU.cam), ls.d), 'vVegP');
    const rim = float(1).sub(abs(dot(normalize(vN), normalize(vP.xyz.negate()))));
    const cutK = float(1).sub(linstep(float(30), float(55), vP.w));
    const n1 = leafNoise(positionWorld, 0.8).mul(0.5).add(0.5);
    edge = n1.greaterThan(rim.sub(0.5).mul(2.0).mul(cutK).sub(0.001)).or(vCol.w.lessThan(0.5));
  }
  const vCov = varying(select(kind.lessThan(1.5), float(1), crownCover(fol.w)), 'vVegCov');
  applyFade(m, vA, edge, vCov);
  softShadow(m, 2.2);
  const c: N = vCol.xyz;
  m.colorNode = baseTone(c);
  return m;
}

// ---------------------------------------------------------------------------- TIERED (high + mid)

export function tieredMaterial(level: 0 | 1) {
  const m = commonMaterial(level === 0 ? 'vegTieredHigh' : 'vegTieredMid');
  const sp = int(ib.z);
  const H = ib.x, W = ib.y, seed = ia.w;
  const r0 = row(sp, 0), r1 = row(sp, 1);
  const base = r0.x, taper = r0.y, droop = r0.w;
  const fr = frame(sp, seed);
  const R = W.mul(0.5);
  const y0 = H.mul(base), len = H.sub(y0);
  const kind = vb.x;
  const ls = lodState(level, sp);
  const fol = foliage(sp, seed, va.x);

  const ringY = va.y, ring = va.z;
  const prof = pow(max(float(1).sub(ringY), 0.02), taper).mul(float(1).sub(pow(ringY, 6).mul(0.2)));
  const wh = hash(vb.z.mul(13.3).add(seed.mul(7.1)));
  const rad = R.mul(prof).mul(ring).mul(wh.mul(0.26).add(0.87)).mul(r1.x);
  const yF = y0.add(va.x.mul(len)).sub(droop.mul(ring).mul(prof).mul(R).mul(0.45));
  const twist = wh.mul(0.5);
  const ct = cos(twist), st = sin(twist);
  const dx = pg.x.mul(ct).sub(pg.z.mul(st)), dz = pg.x.mul(st).add(pg.z.mul(ct));
  const pFol = vec3(dx.mul(rad), yF, dz.mul(rad));
  const tr = r1.y.mul(H).mul(float(1).sub(pg.y.mul(0.7)));
  const pTrunk = vec3(pg.x.mul(tr), pg.y.mul(H.mul(0.9).add(0.3)).sub(0.3), pg.z.mul(tr));
  const local = select(kind.lessThan(0.5), pTrunk, pFol);
  const moved = local.add(sway(local.y, H, seed)).mul(ls.size);
  const visible = ls.alpha.greaterThan(0.001).and(ls.size.greaterThan(0.01));
  m.positionNode = select(visible, ia.xyz.add(yaw(moved, fr.c, fr.s)), vec3(0));

  const n0 = attribute('normal', 'vec3');
  const nW = normalize(vec3(n0.x.mul(ct).sub(n0.z.mul(st)), n0.y.mul(R.div(max(len, 1)).mul(2.2).add(0.4)), n0.x.mul(st).add(n0.z.mul(ct))));
  // blend toward a hemispherical (radial + up) normal: soft from any angle, never dark shards from above
  const nHemi = normalize(vec3(dx, 0.9, dz));
  const nF = normalize(mix(nW, nHemi, 0.5));
  const nLocal = select(kind.lessThan(0.5), vec3(pg.x, 0, pg.z), nF);
  const vN = varying(yaw(nLocal, fr.c, fr.s), 'vVegN');
  m.normalNode = transformNormalToView(normalize(vN));

  const bark = row(sp, 4).xyz;
  const col = select(kind.lessThan(0.5), bark.mul(vb.y), fol.xyz.mul(vb.y).mul(wh.mul(0.14).add(0.93)));
  const vCol = varying(col, 'vVegC');
  applyFade(m, varying(ls.alpha, 'vVegA'), null);
  softShadow(m, 1.6);
  m.colorNode = baseTone(vCol);
  return m;
}

// ---------------------------------------------------------------------------- impostor

/**
 * Camera-facing quad per tree through its crown centre, sized to the crown's
 * projected extent (an ellipsoid seen from the camera's elevation angle). The
 * fragment shader cuts the species silhouette (lobed ellipse with taper /
 * vase / droop and lumps, or a whorled cone; the trunk below), shades it with
 * a spherical normal so it lights like the meshes, and applies the LOD dither.
 */
export function impostorMaterial() {
  const m = commonMaterial('vegImpostor');
  const sp = int(ib.z);
  const H = ib.x, W = ib.y, seed = ia.w;
  const r0 = row(sp, 0), r1 = row(sp, 1);
  const base = r0.x, taper = r0.y, vase = r0.z, droop = r0.w;
  const tiered = r1.z.greaterThan(0.5);
  const fol = foliage(sp, seed, float(0.6));
  const open = r1.x.mul(mix(float(0.7), float(1), fol.w));
  const ls = lodState(2, sp);
  const k = ls.size;
  // crown extent of the meshes' lobe union (crown units): top 0.52 + 0.5·open, bottom 0.40 + 0.44·open,
  // sideways ≈ 0.5 + 0.48·open; whorled crowns fill base … top exactly
  const Hc0 = H.mul(float(1).sub(base)).mul(0.5);
  const eT = open.mul(0.5).add(0.52), eB0 = open.mul(0.44).add(0.4);
  const Hc = select(tiered, Hc0, Hc0.mul(eT.add(eB0)).mul(0.5)).mul(k);
  const Yc = H.mul(base).add(Hc0).add(select(tiered, float(0), eT.sub(eB0).mul(0.5).mul(Hc0))).mul(k);
  const Rh = select(tiered, W.mul(0.5).mul(r1.x), W.mul(0.5).mul(open.mul(0.48).add(0.5)).mul(float(1).add(vase.mul(0.25)))).mul(k);

  const C = ia.xyz.add(vec3(0, Yc, 0));
  const toCam = VU.cam.sub(C);
  const dir = normalize(toCam);
  const hl = length(dir.xz);
  const right = select(hl.greaterThan(0.001), normalize(vec3(dir.z, 0, dir.x.negate())), vec3(1, 0, 0));
  const up2 = cross(dir, right);
  const sinE = clamp(dir.y, -1, 1);
  const cosE = sqrt(max(float(1).sub(sinE.mul(sinE)), 0));
  const extV = sqrt(Hc.mul(cosE).mul(Hc.mul(cosE)).add(Rh.mul(sinE).mul(Rh.mul(sinE))));
  const extB = extV.mul(float(1).add(droop.mul(0.6).mul(cosE)));
  const sGround = Yc.negate().mul(cosE);
  const sBot = min(extB.negate(), sGround);
  const halfW = Rh.mul(1.14);
  const s = mix(sBot, extV.mul(1.06), pg.y);
  const x = pg.x.mul(halfW);
  const wob = sway(Yc, H, seed);
  const P = C.add(right.mul(x)).add(up2.mul(s)).add(wob);
  const visible = ls.alpha.greaterThan(0.001).and(k.greaterThan(0.01));
  m.positionNode = select(visible, P, vec3(0));

  const vA = varying(vec4(x, s, extV, extB), 'vImpA');
  const vB = varying(vec4(Rh, r1.y.mul(H).mul(1.3).add(0.05).mul(k), sinE, seed), 'vImpB');
  const vS = varying(vec4(taper, vase, select(tiered, float(1), float(0)), fol.w), 'vImpS');
  const vR = varying(right, 'vImpR');
  const vU = varying(up2, 'vImpU');
  const vD = varying(dir, 'vImpD');
  const vCol = varying(fol.xyz, 'vImpC');
  const vBark = varying(row(sp, 4).xyz, 'vImpK');
  const vAl = varying(ls.alpha, 'vImpW');

  const X = vA.x, Sv = vA.y, eV = vA.z, eB = vA.w;
  const yn = select(Sv.greaterThanEqual(0), Sv.div(eV), Sv.div(eB));
  const u = X.div(vB.x);
  const tp = vS.x, vs = vS.y, isT = vS.z, sE = vB.z, sd = vB.w;
  const lobedProf = sqrt(max(float(1).sub(yn.mul(yn)), 0)).mul(float(1).sub(tp.mul(yn.mul(0.5).add(0.5)).mul(0.9))).mul(float(1).add(vs.mul(yn).mul(0.5))).div(float(1).add(vs.mul(0.25)));
  const tierProf = pow(max(float(1).sub(yn).mul(0.5), 0.0), tp).mul(fract(yn.mul(0.5).add(0.5).mul(6).add(sd.mul(3))).mul(0.2).add(0.82));
  const sideProf = mix(lobedProf, tierProf, isT);
  const prof0 = mix(sideProf, sqrt(max(float(1).sub(yn.mul(yn)), 0)), sE.mul(sE));
  const lump = float(1).add(sin(u.mul(7).add(sd.mul(40))).mul(sin(yn.mul(6).add(sd.mul(23)))).mul(0.09).mul(float(1).sub(isT)));
  const prof = prof0.mul(lump);
  const inCrown = abs(u).lessThan(prof).and(abs(yn).lessThanEqual(1));
  const tw = vB.y;
  const inTrunk = abs(X).lessThan(tw).and(Sv.lessThan(eB.mul(-0.2)));
  const vCov = varying(crownCover(fol.w), 'vImpCov');
  applyFade(m, vAl, inCrown.or(inTrunk), select(inCrown, vCov, float(1)));

  const nx = clamp(u.div(max(prof, 0.05)), -1, 1);
  const nz = sqrt(max(float(1).sub(nx.mul(nx)).sub(yn.mul(yn)), 0));
  const nCrown = normalize(vR.mul(nx.mul(0.85)).add(vU.mul(yn.mul(0.85).add(0.1))).add(vD.mul(nz.add(0.25))).add(vec3(0, 0.5, 0)));
  const nTrunk = normalize(vR.mul(X.div(tw)).add(vD));
  m.normalNode = transformNormalToView(select(inCrown, nCrown, nTrunk));
  const ao = mix(float(0.55), float(1.0), clamp(yn.mul(0.5).add(0.5), 0, 1)).mul(mix(float(0.8), float(1), nz));
  softShadow(m, 3);
  m.colorNode = baseTone(select(inCrown, vCol.mul(ao).mul(0.92), vBark.mul(0.8)));
  return m;
}

