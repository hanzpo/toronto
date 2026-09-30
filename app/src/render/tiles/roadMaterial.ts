// Street surface material: world-space asphalt / concrete / pavers / grass
// textures and procedural, box-filtered (alias-free at any distance) Ontario
// road markings driven by the per-vertex attributes written in workers/roads.ts
// (docs/ROADS.md, OTM Book 11 / 15 / 18):
//   white dashed lane lines (3 m on / 6 m off; 3/9 on freeways) laid out from
//   per-vertex edge-line offsets and the nominal lane width, so tapers and added
//   lanes keep every line continuous; continuity lines (3/3) for auxiliary lanes;
//   double yellow centre lines on two-way arterials; yellow left / white right
//   edge lines on freeways and ramps (white at gores), painted gore herringbone,
//   shoulder rumble strips; bike lanes with symbols and buffers, sharrows;
//   ladder crosswalks + stop bars at signalized junctions, stop bars at stop
//   signs, zebra / line crosswalks, PXO ladders with shark teeth, railway
//   crossing stop lines, and clean (unmarked) junction boxes. Also concrete
//   slabs, cast-iron tactile plates, grass, gravel, boardwalk, stairs, track
//   ballast with concrete / timber ties, embedded track panels and grooved rail.
// All road-layer geometry is pulled toward the camera by a distance-scaled,
// per-layer depth bias (vertex colour alpha = priority), which keeps a strict
// draw order terrain < rail ballast < paths < minor < major roads < sidewalks
// < rails without z-fighting at any range (reversed-Z float depth).
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, vec4, texture, positionGeometry, modelWorldMatrix, cameraPosition, length,
  mix, smoothstep, clamp, floor, fract, max, min, fwidth, select, vertexColor, pow, luminance, step,
} from 'three/tsl';
import { baseTone } from './materials';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();
export function streetTexture(name: string, srgb = true): THREE.Texture {
  let t = cache.get(name);
  if (t) return t;
  t = loader.load(`${import.meta.env.BASE_URL}textures/${name}`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  cache.set(name, t);
  return t;
}

/** exact box-filtered coverage of the band [c-h, c+h] over a pixel footprint f */
const band = (x: N, c: N, h: N, f: N) => clamp(x.add(f.mul(0.5)), c.sub(h), c.add(h)).sub(clamp(x.sub(f.mul(0.5)), c.sub(h), c.add(h))).div(f);
/** box-filtered coverage of a square wave with period P and on-length D (on at [0, D)) */
const wave = (x: N, P: number | N, D: number | N, f: N) => {
  const F = (t: N) => floor(t.div(P)).mul(D).add(min(fract(t.div(P)).mul(P), D));
  return F(x.add(f.mul(0.5))).sub(F(x.sub(f.mul(0.5)))).div(f);
};
const near = (a: N, k: number) => a.sub(k).abs().lessThan(0.5);
/** bool node → 0/1 float */
const f01 = (c: N) => select(c, float(1), float(0));

/** bit k of a float-packed integer */
const bit = (x: N, k: number) => floor(x.div(2 ** k)).mod(2);
/** k-bit field at shift sh */
const field = (x: N, sh: number, bits: number) => floor(x.div(2 ** sh)).mod(2 ** bits);

export function roadMaterial(name = 'roads'): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = name;
  m.metalness = 0;
  const asphalt = streetTexture('asphalt_color.webp');
  const concrete = streetTexture('concrete_color.webp');
  const pavers = streetTexture('pavers_color.webp');
  const grass = streetTexture('grass_color.webp');

  const rd = attribute('rd', 'vec4');
  const rm = attribute('rm', 'vec4');
  const jn = attribute('jn', 'vec4');
  const vc = vertexColor();

  // ---- depth pull (vertex stage)
  {
    const wp = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
    const toCam = cameraPosition.sub(wp);
    const d = length(toCam);
    const prio = vc.a.mul(255 / 25);
    const pull = d.mul(prio.mul(0.00005).add(0.0008)).add(prio.mul(0.035).add(0.1));
    m.positionNode = positionGeometry.add(toCam.div(d).mul(min(pull, d.mul(0.5))));
  }

  const col = Fn(() => {
    const code = rm.y.add(0.5);
    const surf = floor(code.div(32));
    const r1 = code.sub(surf.mul(32));
    const ow = floor(r1.div(16));
    const cls = floor(r1.sub(ow.mul(16)));
    const mk = rm.x.add(0.5);
    const lw = max(rm.z, 2.4);
    const fx = rm.w.add(0.5);
    const nF = field(mk, 0, 4), nB = field(mk, 4, 4);
    const auxR = field(mk, 8, 2), auxL = field(mk, 10, 2);
    const goreR = bit(mk, 12), goreL = bit(mk, 13), noEdgeR = bit(mk, 14), noEdgeL = bit(mk, 15);
    const contR = bit(mk, 16), contL = bit(mk, 17);
    const bikeR = field(mk, 18, 3), bikeL = field(mk, 21, 3);
    const isLink = bit(fx, 0), rumble = bit(fx, 1), sharrow = bit(fx, 2), stairs = bit(fx, 3), cycle = bit(fx, 4), divided = bit(fx, 5);
    const u = rd.x, v = rd.y, eL = rd.z, eR = rd.w;
    const fu = max(fwidth(u), 0.0005), fv = max(fwidth(v), 0.0005);
    const tint = pow(vc.rgb, vec3(2.2));

    const gp = vec2(positionGeometry.x, positionGeometry.z.negate());
    const dist = length(cameraPosition.sub(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz));

    // ---- base albedo per surface
    const aTex = texture(asphalt, gp.div(4)).rgb;
    const macro = texture(asphalt, gp.div(61).add(0.37)).r;
    // the texture is fresh black asphalt (avg sRGB 43); Toronto streets are worn grey
    const asph = mix(vec3(0.021, 0.022, 0.02), aTex, 0.55).mul(macro.mul(1.2).add(0.8)).mul(5.4);
    const vertical = near(surf, 2).or(near(surf, 3)).or(near(surf, 8));
    const cuv = select(vertical, vec2(v, positionGeometry.y), gp);
    const conc = texture(concrete, cuv.div(2.5)).rgb.mul(0.86);
    // sidewalk slab joints every 1.5 m + a joint 0.3 m behind the curb
    const joints = wave(v.add(0.015), 1.5, 0.03, fv).max(band(u.abs(), eL.add(0.35), float(0.015), fu).mul(f01(near(surf, 1))));
    const walk = conc.mul(float(1).sub(joints.mul(0.35)));
    const pav = texture(pavers, gp.div(2.5)).rgb.mul(0.9);
    const grs = texture(grass, gp.div(3)).rgb.mul(0.85).mul(tint);
    const gravel = vec3(luminance(texture(asphalt, gp.div(1.3)).rgb).mul(8).add(0.25)).mul(tint);
    // ties: concrete on main lines (GO / CN / CP), timber elsewhere; 0.6 m spacing
    const sleepers = wave(v, 0.61, 0.26, fv).mul(band(u, float(0), float(1.3), fu));
    const tieCol = select(cls.lessThan(0.5), vec3(0.34, 0.33, 0.31), vec3(0.2, 0.16, 0.12));
    const ballast = mix(gravel, tieCol, sleepers.mul(0.9));
    const farTone = select(near(cls, 4), asph.mul(0.9), gravel);
    // streetcar / embedded rail: groove beside the running surface (rm.x = 1)
    const groove = f01(mk.greaterThan(0.75)).mul(step(u, float(-0.01)));
    const steel = mix(mix(tint.mul(1.25), vec3(0.02), groove.mul(0.85)), farTone, smoothstep(40, 160, dist));
    // track panels (concrete, 2.4 m slabs)
    const panel = conc.mul(0.95).mul(float(1).sub(wave(v.add(0.02), 2.4, 0.04, fv).mul(0.4)));
    // Toronto TWSI: cast iron plates, dark with rust patina, truncated domes on a ~60 mm grid
    const domes = smoothstep(0.022, 0.016, length(fract(vec2(u, v).div(0.06)).sub(0.5).mul(0.06)));
    const iron = mix(vec3(0.06, 0.045, 0.035), vec3(0.16, 0.08, 0.04), luminance(conc).mul(1.4)).mul(domes.mul(0.6).add(0.7));
    const wood = mix(vec3(0.24, 0.16, 0.1), vec3(0.16, 0.1, 0.06), wave(u.add(10), 0.15, 0.02, fu));
    const pathBase = asph.mul(tint).mul(select(cycle.greaterThan(0.5), float(0.85), float(1.25)));
    const stair = float(1).sub(wave(v, 0.3, 0.05, fv).mul(0.45).mul(stairs));

    const base = select(near(surf, 0), asph.mul(tint),
      select(near(surf, 4), pathBase.mul(stair),
        select(near(surf, 1), walk.mul(stair),
          select(near(surf, 2), conc.mul(1.08),
            select(near(surf, 5), pav.mul(tint),
              select(near(surf, 6), steel,
                select(near(surf, 7), ballast,
                  select(near(surf, 9), iron,
                    select(near(surf, 10), grs,
                      select(near(surf, 11), gravel,
                        select(near(surf, 12), panel,
                          select(near(surf, 13), wood, conc.mul(tint)))))))))))));

    // ---- markings (roads with lane data)
    const markable = near(surf, 0).and(nF.greaterThan(0.5)).and(cls.lessThan(6.5));
    const hwy = cls.lessThan(1.5).or(isLink.greaterThan(0.5));
    const P = select(cls.lessThan(1.5), float(12), float(9));
    const dash = wave(v.add(1000), P, 3, fv);
    const cont = wave(v.add(1000), 6, 3, fv);        // continuity line: 3 m on / 3 m off (OTM Book 11)
    const lwid = select(hwy, float(0.075), float(0.055));
    const twoWay = nB.greaterThan(0.5);
    const bw = (c: N) => select(near(c, 1), float(1.7), select(near(c, 4), float(2.5), float(0)));
    const bwR = bw(bikeR), bwL = bw(bikeL);
    // -- one-way: lanes counted from the left edge line with the nominal lane width
    const k1 = clamp(floor(eL.sub(u).div(lw).add(0.5)), 1, max(nF.sub(1), 1));
    const u1 = eL.sub(k1.mul(lw));
    const in1 = f01(u1.greaterThan(eR.negate().add(bwR).add(lw.mul(0.45)))).mul(f01(nF.greaterThan(1.5)));
    const isAux = f01(k1.greaterThan(nF.sub(auxR).sub(0.5)).or(k1.lessThan(auxL.add(0.5))));
    const oneLane = band(u, u1, mix(lwid, float(0.1), isAux), fu).mul(in1).mul(mix(dash, cont, isAux));
    // -- two-way: lanes out from the centre line
    const lwR = max(eR.sub(bwR).div(max(nF, 1)), 2.4), lwL = max(eL.sub(bwL).div(max(nB, 1)), 2.4);
    const nS = select(u.lessThan(0), nF, nB), lwS = select(u.lessThan(0), lwR, lwL);
    const kS = clamp(floor(u.abs().div(lwS).add(0.5)), 1, max(nS.sub(1), 1));
    const twoLane = band(u.abs(), kS.mul(lwS), lwid, fu).mul(f01(nS.greaterThan(1.5))).mul(dash);
    // local streets (residential / unclassified / service) carry no lane lines in Toronto, even
    // where OSM counts parking lanes as lanes
    const laneCov = select(twoWay, twoLane, oneLane).mul(f01(cls.lessThan(4.5)));
    // centre: double yellow on two-way arterials / collectors
    const centre = band(u.abs(), float(0.18), float(0.055), fu).mul(f01(twoWay)).mul(f01(cls.lessThan(4.5)))
      .mul(f01(nF.add(nB).greaterThan(1.5)));
    // edge lines: freeways / ramps / rural two-way highways; OTM: yellow left, white right on divided
    const edgeW = select(isLink.greaterThan(0.5), float(0.1), float(0.075));
    const rEdgeLine = band(u, eR.negate(), edgeW, fu).mul(f01(hwy)).mul(float(1).sub(noEdgeR));
    // divided streets: yellow left edge line along the median curb (OTM Book 11)
    const lEdgeLine = band(u, eL.sub(select(hwy, float(0), float(0.25))), edgeW, fu).mul(f01(hwy).max(divided)).mul(float(1).sub(noEdgeL));
    const rEdge = rEdgeLine.mul(mix(float(1), cont, contR));
    const lEdge = lEdgeLine.mul(mix(float(1), cont, contL));
    // bike lanes: solid 15 cm line at the lane's inner edge (OTM Book 18), buffer hatched
    const bikeLineR = band(u, eR.negate().add(bwR), float(0.075), fu).mul(f01(bikeR.greaterThan(0.5)).mul(f01(bwR.greaterThan(0.1))));
    const bikeLineL = band(u, eL.sub(bwL), float(0.075), fu).mul(f01(bikeL.greaterThan(0.5)).mul(f01(bwL.greaterThan(0.1))));
    const buffR = band(u, eR.negate().add(bwR).sub(0.5), float(0.075), fu).mul(f01(near(bikeR, 4)));
    // bicycle symbol in the lane every 50 m: two wheels + frame, simplified
    const bsym = (uc: N) => {
      const lv = fract(v.div(50)).mul(50).sub(25);
      const w1 = band(length(vec2(u.sub(uc), lv.sub(0.55))), float(0.33), float(0.04), fu);
      const w2 = band(length(vec2(u.sub(uc), lv.add(0.55))), float(0.33), float(0.04), fu);
      const fr = band(u.sub(uc), float(0), float(0.04), fu).mul(band(lv, float(0), float(0.55), fv));
      return w1.add(w2).add(fr);
    };
    const bikeSym = bsym(eR.negate().add(bwR.mul(0.5))).mul(f01(near(bikeR, 1).or(near(bikeR, 4))))
      .add(bsym(eL.sub(bwL.mul(0.5))).mul(f01(near(bikeL, 1).or(near(bikeL, 4)))));
    // sharrows: bike symbol + two chevrons in the right lane every 40 m (OTM Book 18)
    const sc = select(twoWay, eR.negate().add(lwR.mul(0.5)), eR.negate().add(lw.mul(0.5)));
    const lvS = fract(v.add(20).div(40)).mul(40).sub(20);
    const chev = (o: number) => band(lvS.sub(o).sub(u.sub(sc).abs().mul(0.8)), float(0), float(0.05), fv).mul(f01(u.sub(sc).abs().lessThan(0.5)));
    const shar = sharrow.mul(bsym(sc).mul(f01(lvS.abs().lessThan(1.2))).add(chev(1.6)).add(chev(1.9)));
    // gore areas: white herringbone (45-60 cm at 6 m centres, OTM Book 11) beyond the edge line
    const inGoreR = goreR.mul(f01(u.lessThan(eR.negate().sub(0.1))));
    const inGoreL = goreL.mul(f01(u.greaterThan(eL.add(0.1))));
    const herr = wave(v.add(u.abs()).add(1000), 6, 0.5, max(fv, fu));
    const gore = inGoreR.add(inGoreL).mul(herr);
    // rumble strips on freeway shoulders
    const shoulderR = f01(u.lessThan(eR.negate().sub(0.3)).and(u.greaterThan(eR.negate().sub(0.9))));
    const shoulderL = f01(u.greaterThan(eL.add(0.3)).and(u.lessThan(eL.add(0.9))));
    const rumbleCov = rumble.mul(shoulderR.add(shoulderL)).mul(wave(v, 0.3, 0.17, fv)).mul(float(1).sub(smoothstep(20, 60, dist)));

    // ---- junction / crossing features on either side
    const feat = (d: N, fc: N, prev: boolean) => {
      const type = floor(fc.add(0.05).div(100));
      const r = fc.sub(type.mul(100));
      const sig = near(type, 2), stp = near(type, 5), zeb = near(type, 3), lin = near(type, 4), pxo = near(type, 6), rr = near(type, 7);
      const rEnd = select(sig, r.add(4.6), select(stp, r.add(1.6), select(zeb.or(lin).or(pxo), float(2.4), select(rr, float(6), r.add(0.3)))));
      const keep = select(type.greaterThan(0.5), step(rEnd, d), float(1));
      const mid = eL.sub(eR).mul(0.5);
      const inner = band(u, mid, eL.add(eR).mul(0.5).sub(0.3), fu);
      // ladder crosswalk: two edge lines + bars
      const cw = band(d, r.add(0.5), float(0.1), fv).add(band(d, r.add(3.3), float(0.1), fv))
        .add(band(d, r.add(1.9), float(1.3), fv).mul(wave(u.add(100.3), 1.2, 0.6, fu)))
        .mul(inner).mul(f01(sig));
      // stop bars on the approach half
      const approach = prev ? ow.lessThan(0.5).and(u.greaterThan(0)) : ow.greaterThan(0.5).or(u.lessThan(0));
      const stopAt = select(sig, r.add(4.3), r.add(1.1));
      const sb = band(d, stopAt, float(0.2), fv).mul(inner).mul(f01(approach)).mul(f01(sig.or(stp)));
      // mid-block crossings; PXO: ladder + shark teeth 6 m back (OTM Book 15)
      const zb = band(d, float(0.9), float(0.9), fv).mul(wave(u.add(100.3), 1.2, 0.6, fu)).mul(inner).mul(f01(zeb.or(pxo)));
      const ln = band(d, float(1.9), float(0.1), fv).mul(inner).mul(f01(lin));
      const ty = d.sub(6.0).div(0.9);
      const tx = fract(u.div(0.9)).sub(0.5).abs().mul(2);
      const teeth = f01(ty.greaterThan(0).and(ty.lessThan(1)).and(tx.lessThan(float(1).sub(ty)))).mul(inner).mul(f01(approach)).mul(f01(pxo));
      // railway crossing: paired 30 cm stop lines >= 4.5 m before the near rail (OTM Book 11)
      const rrs = band(d, float(4.8), float(0.15), fv).add(band(d, float(5.4), float(0.15), fv)).mul(inner).mul(f01(approach)).mul(f01(rr));
      return { keep, white: cw.add(sb).add(zb).add(ln).add(teeth).add(rrs) };
    };
    const fp = feat(jn.x, jn.z, true), fn = feat(jn.y, jn.w, false);
    const keepF = fp.keep.mul(fn.keep);
    const lEdgeYellow = f01(ow.greaterThan(0.5)).mul(float(1).sub(goreL));
    const white = clamp(laneCov.add(rEdge).add(lEdge.mul(float(1).sub(lEdgeYellow))).add(bikeLineR).add(bikeLineL).add(buffR)
      .add(bikeSym).add(shar).add(gore).mul(keepF).add(fp.white).add(fn.white), 0, 1);
    const yellow = clamp(centre.add(lEdge.mul(lEdgeYellow)).mul(keepF), 0, 1);
    const wear = clamp(luminance(aTex).mul(12).add(0.55), 0.7, 1);
    const wm = white.mul(wear).mul(f01(markable));
    const ym = yellow.mul(wear).mul(f01(markable));
    const WHITE = vec3(0.62, 0.62, 0.6), YELLOW = vec3(0.72, 0.47, 0.06);
    const withRumble = base.mul(float(1).sub(rumbleCov.mul(0.35).mul(f01(near(surf, 0)))));
    const outC = mix(mix(withRumble, WHITE, wm), YELLOW, ym);
    return baseTone(outC);
  })();

  m.colorNode = col;
  m.roughnessNode = float(0.92);
  return m;
}
