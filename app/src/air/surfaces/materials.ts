// TSL materials for handcrafted airport surfaces (docs/AIR.md "Surfaces"):
//   runwayMaterial   — asphalt/concrete/turf with procedural Transport Canada
//                      TP 312 / ICAO Annex 14 markings from per-vertex runway params
//   pavementMaterial — taxiway asphalt, apron concrete slabs, grass underlay
//   markingMaterial  — transparent yellow ribbons (centre/edge/hold/lead-in/stop)
//   lightMaterial    — night-time runway & taxiway lights (instanced sprites)
// Every marking is an exact box-filtered coverage over the pixel footprint
// (as in render/tiles/roadMaterial.ts), so markings stay crisp up close and
// fade to the right average tone far away — no aliasing, no shimmer.
// Depth: the same distance-scaled pull towards the camera as the road layer
// (priority: underlay 0.5 < pavement 2 < runway 2.4 < markings 4.5).
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, vec4, texture, positionGeometry, modelWorldMatrix, cameraPosition, length,
  mix, smoothstep, clamp, floor, fract, max, min, fwidth, select, luminance, dFdx, dFdy, abs, uv,
  instancedBufferAttribute,
} from 'three/tsl';
import { baseTone } from '../../render/tiles/materials';
import { streetTexture } from '../../render/tiles/roadMaterial';
import { U } from '../../render/uniforms';
import { glyphAtlas, GLYPH_CELL, GLYPH_L } from './glyphs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** exact box-filtered coverage of [c-h, c+h] over footprint f */
const band = (x: N, c: N, h: N, f: N) =>
  clamp(x.add(f.mul(0.5)), c.sub(h), c.add(h)).sub(clamp(x.sub(f.mul(0.5)), c.sub(h), c.add(h))).div(f);
/** box-filtered square wave, period P, on over [0, D) */
const wave = (x: N, P: number | N, D: number | N, f: N) => {
  const F = (t: N) => floor(t.div(P)).mul(D).add(min(fract(t.div(P)).mul(P), D));
  return F(x.add(f.mul(0.5))).sub(F(x.sub(f.mul(0.5)))).div(f);
};
const f01 = (c: N) => select(c, float(1), float(0));

function pull(m: THREE.NodeMaterial, prio: N) {
  const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const toCam = cameraPosition.sub(wp);
  const d = length(toCam);
  const p = d.mul(prio.mul(0.00005).add(0.0008)).add(prio.mul(0.035).add(0.1));
  m.positionNode = positionGeometry.add(toCam.div(d).mul(min(p, d.mul(0.5))));
}

const WHITE = vec3(0.66, 0.66, 0.64);
const YELLOW = vec3(0.72, 0.47, 0.06);
const lin = (c: number) => Math.pow(c / 255, 2.2);
// airfield grass = terrain class 23 (0xbcd6a2), which the aerodrome raster uses (osm_tiles.py)
const GRASS_LIN = vec3(lin(0xbc), lin(0xd6), lin(0xa2));

/** world-space ground position (metres); origins are 64 m aligned so texture phases match the terrain */
const groundXY = () => vec2(positionGeometry.x, positionGeometry.z.negate());

function asphaltBase(gp: N, tone: number) {
  const a = texture(streetTexture('asphalt_color.webp'), gp.div(4)).rgb;
  const macro = texture(streetTexture('asphalt_color.webp'), gp.div(97).add(0.21)).r;
  return { col: mix(vec3(0.021, 0.022, 0.02), a, 0.55).mul(macro.mul(1.1).add(0.85)).mul(tone), tex: a };
}

// ---------------------------------------------------------------------------- runway

export function runwayMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'airport-runway';
  m.side = THREE.DoubleSide;
  m.metalness = 0;
  pull(m, float(2.4));
  const ra = attribute('ra', 'vec4'); // u (right of A->B), v (from end A), half width, length
  const rb = attribute('rb', 'vec4'); // displaced A, displaced B, stopway A, stopway B
  const rc = attribute('rc', 'vec4'); // designator code A, B (num*4 + L1/C2/R3), kind (0 asphalt 1 concrete 2 turf), flags (1 closed)
  const atlas = glyphAtlas();

  m.colorNode = Fn(() => {
    const u = ra.x, v = ra.y, hw = ra.z, L = ra.w;
    const gp = groundXY();
    const dist = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz));
    // per-end frame: s from the pavement end, x to the pilot's right, t past the threshold
    const isB = v.greaterThan(L.mul(0.5));
    const s = select(isB, L.sub(v), v);
    const x = select(isB, u.negate(), u);
    const ax = abs(x);
    const disp = select(isB, rb.y, rb.x);
    const code = select(isB, rc.y, rc.x);
    const t = s.sub(disp);
    const fx = max(fwidth(u), 0.002), fs = max(fwidth(v), 0.002);
    const lda = L.sub(disp);
    const wide = hw.greaterThan(13.5);

    // ---- surface
    const asp = asphaltBase(gp, 4.6);
    const conc = texture(streetTexture('concrete_color.webp'), gp.div(3)).rgb.mul(0.8);
    // concrete slab joints 7.5 m (only on concrete runways)
    const joints = wave(u.add(100), 7.5, 0.06, fx).max(wave(v.add(100), 7.5, 0.06, fs)).mul(0.25);
    let base: N = select(rc.z.greaterThan(0.5), conc.mul(float(1).sub(joints)), asp.col);
    // rubber deposits in the touchdown zones (both ends) + a darker keel along the centreline
    const rub = smoothstep(120, 300, t).mul(smoothstep(1100, 700, t)).mul(smoothstep(hw.mul(0.55), hw.mul(0.1), ax));
    const keel = smoothstep(hw.mul(0.45), float(2), ax).mul(0.25);
    const rubN = texture(streetTexture('asphalt_color.webp'), gp.div(vec2(23, 5)).add(0.5)).r.mul(6).clamp(0.4, 1.4);
    base = base.mul(float(1).sub(rub.mul(0.55).mul(rubN).add(keel.mul(0.6)).clamp(0, 0.7)));
    // turf strip: mown grass with alternating stripes
    const mow = wave(v.add(1000), 24, 12, fs).mul(0.1).add(0.95);
    const turf = GRASS_LIN.mul(mow).mul(0.92);

    // ---- markings (white): threshold piano keys
    const k = select(hw.lessThan(10), float(2), select(hw.lessThan(12.5), float(3), select(hw.lessThan(17.5), float(4),
      select(hw.lessThan(25), float(6), float(8)))));
    const xi = float(1.5);
    const xo = min(hw.sub(3), float(27));
    const P = xo.sub(xi).div(k);
    const keys = band(t, float(21), float(15), fs).mul(wave(ax.sub(xi), P, P.mul(0.55), fx))
      .mul(band(ax, xi.add(xo).mul(0.5), xo.sub(xi).mul(0.5), fx));

    // designators: letter (if any) nearest the threshold, then the number
    const H = select(wide, float(9), float(6));
    const gw = H.mul(0.5); // glyph ink width
    const cellW = gw.div(1 - 2 * GLYPH_CELL.marginX), cellH = H.div(1 - 2 * GLYPH_CELL.marginY);
    const num = floor(code.div(4).add(0.01));
    const suf = code.sub(num.mul(4));
    const hasSuf = suf.greaterThan(0.5);
    const t0 = float(48);
    const tNum = select(hasSuf, t0.add(H).add(4), t0);
    const inLet = hasSuf.and(t.greaterThan(t0.sub(2))).and(t.lessThan(t0.add(H).add(2)));
    const d1 = floor(num.div(10).add(0.01)), d2 = num.sub(d1.mul(10));
    const gap = H.mul(0.18);
    const idx = select(inLet, suf.add(GLYPH_L - 1), select(x.lessThan(0), d1, d2));
    const cx = select(inLet, float(0), select(x.lessThan(0), gap.mul(-0.5).sub(gw.mul(0.5)), gap.mul(0.5).add(gw.mul(0.5))));
    const ty = select(inLet, t0, tNum);
    const gx = x.sub(cx).div(cellW).add(0.5);
    const gy = t.sub(ty).sub(H.mul(0.5)).div(cellH).add(0.5);
    const inCell = f01(gx.greaterThan(0).and(gx.lessThan(1)).and(gy.greaterThan(0)).and(gy.lessThan(1)));
    const auv = vec2(idx.add(clamp(gx, 0, 1)).div(GLYPH_CELL.cells), clamp(gy, 0, 1));
    const du = vec2(dFdx(x).div(cellW).div(GLYPH_CELL.cells), dFdx(t).div(cellH));
    const dv = vec2(dFdy(x).div(cellW).div(GLYPH_CELL.cells), dFdy(t).div(cellH));
    const glyph = texture(atlas, auv).grad(du, dv).r.mul(inCell).mul(f01(t.greaterThan(t0.sub(3))));

    // aiming point (distance / size by landing distance available, ICAO table 5-1)
    const aP = select(lda.greaterThan(2399), float(400), select(lda.greaterThan(1199), float(300), select(lda.greaterThan(799), float(250), float(150))));
    const aLen = select(lda.greaterThan(1199), float(45), float(30));
    const aW = select(lda.greaterThan(2399), float(9), select(lda.greaterThan(1199), float(6), float(4)));
    const aIn = select(lda.greaterThan(1199), float(9), float(6));
    const aim = band(t, aP.add(aLen.mul(0.5)), aLen.mul(0.5), fs).mul(band(ax, aIn.add(aW.mul(0.5)), aW.mul(0.5), fx))
      .mul(f01(hw.greaterThan(10.5)));

    // touchdown zone bars (pairs): 150 m ×3, then 450/600 ×2, 750/900 ×1 (only while < LDA/2)
    const tdz = (pos: number, n: number) => {
      const span = n * 3.3 - 1.5;
      return band(t, float(pos + 11.25), float(11.25), fs)
        .mul(band(ax.sub(9), float(span / 2), float(span / 2), fx))
        .mul(wave(ax.sub(9), 3.3, 1.8, fx))
        .mul(f01(lda.mul(0.5).greaterThan(pos + 60)));
    };
    const tdzAll = tdz(150, 3).add(tdz(450, 2)).add(tdz(600, 2)).add(tdz(750, 1)).add(tdz(900, 1))
      .mul(f01(lda.greaterThan(1199).and(wide)));

    // centreline: 30 m stripes / 20 m gaps centred on mid-runway, clear of both designators
    const clW = select(wide, float(0.45), float(0.23));
    const tA = v.sub(rb.x), tB = L.sub(v).sub(rb.y);
    const clear = float(48 + 2 * 9 + 4 + 12);
    const cl = band(u, float(0), clW, fx).mul(wave(v.sub(L.mul(0.5)).add(15 + 50 * 400), 50, 30, fs))
      .mul(f01(tA.greaterThan(clear).and(tB.greaterThan(clear))));

    // side stripes (runway edge), full paved length
    const sw = select(wide, float(0.45), float(0.23));
    const edge = band(ax, hw.sub(sw).sub(0.25), sw, fx).mul(f01(s.greaterThan(0)));

    // displaced threshold: transverse bar + arrows in the displaced portion
    const hasDisp = disp.greaterThan(1);
    const inDisp = f01(hasDisp.and(t.lessThan(-1.8)).and(s.greaterThan(0)));
    const bar = band(t, float(-0.9), float(0.9), fs).mul(f01(hasDisp)).mul(band(ax, float(0), hw.sub(0.3), fx));
    const q = fract(t.add(40 * 200).div(40)).mul(40); // 0..40, arrow heads point towards the threshold
    const shaft = band(u, float(0), float(0.45), fx).mul(band(q, float(15), float(10), fs));
    const head = band(ax.sub(float(35).sub(q).mul(0.3)), float(-0.2), float(0.55), fx).mul(band(q, float(30), float(5), fs));
    const arrows = shaft.add(head).mul(inDisp);

    // closed runway: white X crosses at both ends (no other markings)
    const closed = rc.w.greaterThan(0.5);
    const xt = t.sub(90);
    const cross = band(ax.sub(abs(xt).mul(0.35)), float(0), float(0.9), fx).mul(band(xt, float(0), float(20), fs));

    let white: N = keys.add(glyph).add(aim).add(tdzAll).add(cl).add(edge).add(bar).add(arrows);
    white = select(closed, cross, white);
    // pre-threshold stopway / blast pad: yellow chevrons pointing at the runway
    const chev = wave(s.negate().sub(ax).add(3000), 30, 1.2, max(fs, fx).mul(1.5)).mul(f01(s.lessThan(0)))
      .mul(band(ax, float(0), hw.sub(0.5), fx));
    const turfK = rc.z.greaterThan(1.5);
    const wear = clamp(luminance(asp.tex).mul(10).add(0.6), 0.75, 1);
    const wc = clamp(white, 0, 1).mul(wear).mul(f01(turfK.not()));
    const yc = clamp(chev, 0, 1).mul(wear).mul(f01(turfK.not()));
    const col = select(turfK, turf, mix(mix(base, WHITE, wc), YELLOW, yc));
    void dist;
    return baseTone(col);
  })();
  m.roughnessNode = float(0.9);
  return m;
}

// ---------------------------------------------------------------------------- pavement

export function pavementMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'airport-pavement';
  m.side = THREE.DoubleSide;
  m.metalness = 0;
  const ps = attribute('ps', 'float'); // 0 taxiway asphalt · 1 apron concrete · 2 grass underlay
  pull(m, select(ps.greaterThan(1.5), float(0.5), float(2)));
  m.colorNode = Fn(() => {
    const gp = groundXY();
    const dist = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz));
    const fx = max(fwidth(gp.x), 0.002), fy = max(fwidth(gp.y), 0.002);
    const asp = asphaltBase(gp, 5.0).col;
    const cTex = texture(streetTexture('concrete_color.webp'), gp.div(3)).rgb;
    const cMacro = texture(streetTexture('concrete_color.webp'), gp.div(53).add(0.4)).r.mul(1.2).add(0.45);
    // 7.5 m apron slabs with sealed (dark) joints, slight per-slab tone variation
    const slab = floor(gp.div(7.5));
    const rnd = fract(slab.x.mul(0.1031).add(slab.y.mul(0.11369)).mul(slab.x.add(slab.y).mul(0.13787).add(3.1)).mul(43.7));
    const joints = wave(gp.x.add(1000), 7.5, 0.07, fx).max(wave(gp.y.add(1000), 7.5, 0.07, fy));
    const conc = cTex.mul(0.78).mul(cMacro.clamp(0.8, 1.15)).mul(rnd.mul(0.1).add(0.95)).mul(float(1).sub(joints.mul(0.35)));
    // grass underlay: same tone + close-range detail as the terrain shader (class 2)
    const closeK = smoothstep(450, 40, dist);
    const grassL = luminance(texture(streetTexture('grass_color.webp'), gp.div(4)).rgb).div(0.12);
    const grass = GRASS_LIN.mul(mix(float(1), clamp(grassL.mul(0.6).add(0.4), 0.4, 1.6), closeK))
      .mul(float(1).add(clamp(positionGeometry.y, -50, 400).mul(0.00035)));
    const col = select(ps.lessThan(0.5), asp, select(ps.lessThan(1.5), conc, grass));
    return baseTone(col);
  })();
  m.roughnessNode = select(ps.greaterThan(1.5), float(0.97), float(0.9));
  return m;
}

// ---------------------------------------------------------------------------- markings

export function markingMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false });
  m.name = 'airport-markings';
  m.side = THREE.DoubleSide;
  m.metalness = 0;
  pull(m, float(4.5));
  const mk = attribute('mk', 'vec4'); // u across (m), v along (m), kind, line half-width
  const u = mk.x, v = mk.y, kind = mk.z, lh = mk.w;
  const fu = max(fwidth(u), 0.002), fv = max(fwidth(v), 0.002);
  const is = (k: number) => abs(kind.sub(k)).lessThan(0.5);
  const centre = band(u, float(0), lh, fu);
  const edge = band(abs(u), float(0.25), lh, fu);
  // runway holding position (pattern A): two solid lines on the taxiway side (u > 0), two dashed on the runway side
  const solid = band(u, float(0.45), lh, fu).add(band(u, float(1.05), lh, fu));
  const dashed = band(u, float(-0.45), lh, fu).add(band(u, float(-1.05), lh, fu)).mul(wave(v.add(0.45), 1.8, 0.9, fv));
  const hold = solid.add(dashed);
  const cov: N = select(is(1), edge, select(is(2), hold, centre));
  const dist = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz));
  const wear = texture(streetTexture('asphalt_color.webp'), vec2(positionGeometry.x, positionGeometry.z).div(4)).r;
  m.colorNode = baseTone(YELLOW.mul(clamp(wear.mul(8).add(0.7), 0.8, 1.05)));
  m.opacityNode = clamp(cov, 0, 1).mul(0.95).mul(float(1).sub(smoothstep(9000, 12000, dist)));
  m.roughnessNode = float(0.85);
  return m;
}

// ---------------------------------------------------------------------------- lights

const LIGHT_COL = [
  [1.0, 0.86, 0.6], // runway edge (white/amber)
  [0.2, 1.0, 0.35], // threshold (green)
  [1.0, 0.12, 0.08], // runway end (red)
  [0.15, 0.35, 1.0], // taxiway edge (blue)
];

export function lightMaterial(pos: THREE.InstancedBufferAttribute, kind: THREE.InstancedBufferAttribute) {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.name = 'airport-lights';
  const p = instancedBufferAttribute(pos) as unknown as N;
  const k = instancedBufferAttribute(kind) as unknown as N;
  // pulled towards the camera further than the (depth-pulled) pavement so fixtures 0.35 m up stay visible
  const toCam = cameraPosition.sub(modelWorldMatrix.mul(vec4(p, 1)).xyz);
  const d = length(toCam);
  m.positionNode = p.add(toCam.div(d).mul(min(d.mul(0.0016).add(0.6), d.mul(0.5))));
  // ≥ ~5 px at any distance (the glow core is ~40 % of the sprite), 1.4 m up close
  m.scaleNode = max(float(1.4), d.mul(0.0045));
  const col: N = select(k.lessThan(0.5), vec3(...LIGHT_COL[0]), select(k.lessThan(1.5), vec3(...LIGHT_COL[1]),
    select(k.lessThan(2.5), vec3(...LIGHT_COL[2]), vec3(...LIGHT_COL[3]))));
  const r = length(uv().sub(0.5)).mul(2);
  const core = float(1).sub(smoothstep(0.0, 1.0, r));
  const glow = core.mul(core).mul(core);
  const fade = float(1).sub(smoothstep(9000, 15000, d));
  m.colorNode = vec4(col.mul(glow).mul(4).mul(U.night).mul(fade), glow);
  m.fog = false;
  return m;
}
