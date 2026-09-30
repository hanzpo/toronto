// Street surface material: world-space asphalt / concrete / pavers textures and
// procedural, box-filtered (alias-free at any distance) Ontario road markings
// driven by the per-vertex attributes written in workers/roads.ts:
//   white dashed lane lines (3 m on / 6 m off; 3/9 on freeways), double solid
//   yellow centre lines on two-way arterials, white right / yellow left edge
//   lines on divided highways, ladder crosswalks + stop bars at signalized
//   junctions, stop bars at stop signs, zebra / line crosswalks at marked
//   crossings, and clean (unmarked) junction boxes.
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

export function roadMaterial(name = 'roads'): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = name;
  m.metalness = 0;
  const asphalt = streetTexture('asphalt_color.webp');
  const concrete = streetTexture('concrete_color.webp');
  const pavers = streetTexture('pavers_color.webp');

  const rd = attribute('rd', 'vec4');
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
    const code = rd.w.add(0.5);
    const surf = floor(code.div(512));
    const r1 = code.sub(surf.mul(512));
    const ow = floor(r1.div(256));
    const r2 = r1.sub(ow.mul(256));
    const lanes = floor(r2.div(16));
    const cls = floor(r2.sub(lanes.mul(16)));
    const u = rd.x, v = rd.y, hw = rd.z;
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
    const joints = wave(v.add(0.015), 1.5, 0.03, fv).max(band(u.abs(), hw.add(0.35), float(0.015), fu).mul(f01(near(surf, 1))));
    const walk = conc.mul(float(1).sub(joints.mul(0.35)));
    const pav = texture(pavers, gp.div(2.5)).rgb.mul(0.9);
    const gravel = vec3(luminance(texture(asphalt, gp.div(1.3)).rgb).mul(8).add(0.25)).mul(tint);
    const sleepers = wave(v, 0.62, 0.24, fv).mul(band(u, float(0), float(1.3), fu));
    const ballast = mix(gravel, vec3(0.2, 0.17, 0.14), sleepers.mul(0.85));
    const farTone = select(near(cls, 4), asph.mul(0.9), gravel);
    const steel = mix(tint.mul(1.25), farTone, smoothstep(40, 160, dist));

    const base = select(near(surf, 0).or(near(surf, 4)), asph.mul(tint),
      select(near(surf, 1), walk,
        select(near(surf, 2), conc.mul(1.08),
          select(near(surf, 5), pav,
            select(near(surf, 6), steel,
              select(near(surf, 7), ballast, conc.mul(tint)))))));

    // ---- markings (roads with lane data only: level-0 tiles)
    const markable = near(surf, 0).and(lanes.greaterThan(0.5)).and(cls.lessThan(5.5));
    const g = select(cls.lessThan(1.5), float(1.2), float(0.45));
    const P = select(cls.lessThan(1.5), float(12), float(9));
    const dash = wave(v.add(1000), P, 3, fv);
    // two-way lane lines
    const nR = max(floor(lanes.div(2)), 1), nL = max(lanes.sub(nR), 1);
    const nS = select(u.lessThan(0), nR, nL);
    const lwS = max(hw.sub(g).div(nS), 2.4);
    const kS = clamp(floor(u.abs().div(lwS).add(0.5)), 1, max(nS.sub(1), 1));
    const twoLane = band(u.abs(), kS.mul(lwS), float(0.06), fu).mul(f01(nS.greaterThan(1.5)));
    // one-way lane lines
    const lw1 = max(hw.sub(g).mul(2).div(max(lanes, 1)), 2.4);
    const x1 = u.add(hw).sub(g);
    const k1 = clamp(floor(x1.div(lw1).add(0.5)), 1, max(lanes.sub(1), 1));
    const oneLane = band(x1, k1.mul(lw1), float(0.06), fu).mul(f01(lanes.greaterThan(1.5)));
    const laneCov = select(ow.greaterThan(0.5), oneLane, twoLane).mul(dash);
    // centre: double yellow on two-way arterials/collectors
    const centre = band(u.abs(), float(0.18), float(0.055), fu).mul(f01(ow.lessThan(0.5))).mul(f01(cls.lessThan(4.5))).mul(f01(lanes.greaterThan(1.5)));
    // edge lines on highways
    const edgeOn = f01(cls.lessThan(1.5));
    const rEdge = band(u, hw.sub(g).negate(), float(0.08), fu).mul(edgeOn);
    const lEdge = band(u, hw.sub(g), float(0.08), fu).mul(edgeOn);

    // ---- junction / crossing features on either side
    const feat = (d: N, fc: N, prev: boolean) => {
      const type = floor(fc.add(0.05).div(100));
      const r = fc.sub(type.mul(100));
      const sig = near(type, 2), stp = near(type, 5), zeb = near(type, 3), lin = near(type, 4);
      const rEnd = select(sig, r.add(4.6), select(stp, r.add(1.6), select(zeb.or(lin), float(2.4), r.add(0.3))));
      const keep = select(type.greaterThan(0.5), step(rEnd, d), float(1));
      const inner = band(u, float(0), hw.sub(0.3), fu);
      // ladder crosswalk: two edge lines + bars
      const cw = band(d, r.add(0.5), float(0.1), fv).add(band(d, r.add(3.3), float(0.1), fv))
        .add(band(d, r.add(1.9), float(1.3), fv).mul(wave(u.add(100.3), 1.2, 0.6, fu)))
        .mul(inner).mul(f01(sig));
      // stop bars on the approach half
      const approach = prev ? ow.lessThan(0.5).and(u.greaterThan(0)) : ow.greaterThan(0.5).or(u.lessThan(0));
      const stopAt = select(sig, r.add(4.1), r.add(1.1));
      const sb = band(d, stopAt, float(0.22), fv).mul(band(u, float(0), hw.sub(g), fu)).mul(f01(approach)).mul(f01(sig.or(stp)));
      // mid-block crossings
      const zb = band(d, float(0.9), float(0.9), fv).mul(wave(u.add(100.3), 1.2, 0.6, fu)).mul(inner).mul(f01(zeb));
      const ln = band(d, float(1.9), float(0.1), fv).mul(inner).mul(f01(lin));
      return { keep, white: cw.add(sb).add(zb).add(ln) };
    };
    const fp = feat(jn.x, jn.z, true), fn = feat(jn.y, jn.w, false);
    const keepF = fp.keep.mul(fn.keep);
    const white = clamp(laneCov.add(rEdge).add(select(ow.greaterThan(0.5), float(0), lEdge)).mul(keepF).add(fp.white).add(fn.white), 0, 1);
    const yellow = clamp(centre.add(select(ow.greaterThan(0.5), lEdge, float(0))).mul(keepF), 0, 1);
    const wear = clamp(luminance(aTex).mul(12).add(0.55), 0.7, 1);
    const wm = white.mul(wear).mul(f01(markable));
    const ym = yellow.mul(wear).mul(f01(markable));
    const WHITE = vec3(0.62, 0.62, 0.6), YELLOW = vec3(0.72, 0.47, 0.06);
    const outC = mix(mix(base, WHITE, wm), YELLOW, ym);
    return baseTone(outC);
  })();

  m.colorNode = col;
  m.roughnessNode = float(0.92);
  return m;
}
