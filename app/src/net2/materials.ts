// Material table for the primitive-network slice (docs/NETWORK.md, CROSS_SECTION.md): what every
// band, node surface, marking and trackwork piece of net2/gen.ts is made of, and one node
// material that draws them all with world-scale detail.
//
// Each entry is a linear albedo + a material id. gen.ts writes the id in the colour alpha
// (Soup.tri); `annotate` adds per-vertex band coordinates after generation (s along the edge,
// a across the band from its left edge, band width w, lateral offset from the centreline, distance
// to the nearest carriageway edge) by projecting every triangle onto the edge sweeps, so the shader
// can lay joints, pavers, wheel paths and gutters in street-aligned metres. Node surfaces (box,
// corners) get a frame aligned with the nearest leg.
//
// References (Toronto / Ontario):
//  - sidewalks: cast-in-place concrete scored in ~1.5 m panels, a joint behind the curb
//    (City of Toronto Complete Streets Guidelines 2017, ch. 4 "Sidewalks and pedestrian clearway";
//    Toronto standard drawing T-310.010 concrete sidewalk);
//  - furnishing zone: red / brown 100 x 200 mm unit pavers with tree pits (Complete Streets
//    "furnishing zone"; King / Queen W / Spadina streetscapes);
//  - curbs: 150 mm barrier curb (T-600.05); downtown granite curb on the main streets;
//  - TWSI: cast-iron truncated-dome plates, rust red weathering to a dark patina
//    (City of Toronto, "Testing different materials for TWSI", 2017; T-310.030-10);
//  - TTC streetcar islands: concrete, yellow tactile edge tiles along the track side (TTC,
//    Spadina platform accessibility retrofit 2012; CNIB-chosen yellow);
//  - streetcar ROW: concrete track slab with transverse joints (Spadina 1997, St Clair 2010);
//  - markings: OTM Book 11 (lane lines 3 m / 6 m, 100-150 mm; double yellow; 300-600 mm stop
//    bars), Toronto zebra crosswalk policy (2006, rev. 2019 / 2023) at signalized crossings.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, vec4, texture, positionGeometry, mix, smoothstep, clamp, floor, fract, max, min,
  fwidth, select, sin, dot, abs, length, luminance, uniform,
} from 'three/tsl';
import { U } from '../render/uniforms';
import { baseTone } from '../render/tiles/materials';
import { streetTexture } from '../render/tiles/roadMaterial';
import type { Asset, Band, PrimNet, Soup } from './gen';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** linear albedo + material id (alpha channel of the soup colour) */
export type Mat = [number, number, number, number];

/** material ids (the shader's switch) */
export const MID = {
  HIDDEN: 0, ASPHALT: 1, SIDEWALK: 2, FRONTAGE: 3, PAVERS: 4, CURB: 5, ROW_SLAB: 6, GRASS: 7, PLATFORM: 8,
  TACTILE_TTC: 9, TACTILE_IRON: 10, PAINT_WHITE: 11, PAINT_YELLOW: 12, RAIL: 13, GROOVE: 14, BIKE: 15, MEDIAN: 16,
  LANEWAY: 17, LOT: 18, PARKING: 19,
} as const;

const m = (r: number, g: number, b: number, id: number): Mat => [r, g, b, id];

/**
 * The surface table. Keys are gen.ts's historical colour names (so gen.ts reads `C.x` unchanged);
 * `pavers` there is the node-corner / transition frontage (hard concrete to the building line),
 * the furnishing-zone pavers are `furniture`.
 */
export const C: Record<string, Mat> = {
  asphalt: m(0.092, 0.092, 0.088, MID.ASPHALT),        // worn Toronto asphalt, sRGB ~85
  concrete: m(0.36, 0.35, 0.33, MID.SIDEWALK),         // broom-finished sidewalk concrete, sRGB ~165
  pavers: m(0.36, 0.35, 0.33, MID.FRONTAGE),           // frontage / corner hardscape to the building line
  furniture: m(0.2, 0.095, 0.06, MID.PAVERS),          // red-brown unit pavers (furnishing zone)
  curb: m(0.33, 0.33, 0.32, MID.CURB),                 // granite / light concrete curb
  row: m(0.34, 0.335, 0.315, MID.ROW_SLAB),            // streetcar ROW concrete slab
  grass: m(0.075, 0.12, 0.035, MID.GRASS),
  platform: m(0.42, 0.41, 0.385, MID.PLATFORM),        // TTC island concrete
  tactile: m(0.62, 0.4, 0.02, MID.TACTILE_TTC),        // TTC yellow platform-edge tactile tiles
  iron: m(0.075, 0.045, 0.032, MID.TACTILE_IRON),      // City cast-iron TWSI plates
  white: m(0.7, 0.7, 0.68, MID.PAINT_WHITE),
  yellow: m(0.62, 0.38, 0.02, MID.PAINT_YELLOW),
  rail: m(0.17, 0.17, 0.175, MID.RAIL),
  groove: m(0.012, 0.012, 0.012, MID.GROOVE),
  // the soup's signal-pole stand-ins: props.ts draws the real signal assemblies, so they are dropped
  pole: m(0.12, 0.12, 0.13, MID.HIDDEN),
  median: m(0.37, 0.36, 0.34, MID.MEDIAN),
  bike: m(0.1, 0.1, 0.095, MID.BIKE),
  laneway: m(0.12, 0.118, 0.11, MID.LANEWAY),
  lot: m(0.115, 0.113, 0.107, MID.LOT),
  parking: m(0.11, 0.11, 0.104, MID.PARKING),
};

/** asset class per band object (bands are unique per asset), registered from the net before generation */
const bandAsset = new WeakMap<Band, Asset>();
export function registerAssets(assets: Asset[]) {
  for (const a of assets) for (const b of a.bands) bandAsset.set(b, a);
}
const isLaneway = (a?: Asset) => !!a && /^osm_c6_/.test(a.id) && !a.bands.some((b) => b.kind === 'sidewalk');

/** the material of a band (gen.ts kindRGB) */
export function materialFor(kind: string, b?: Band): Mat {
  switch (kind) {
    case 'frontage': case 'frontage_walk': return C.concrete;     // the walk continues to the building line
    case 'building_edge': return C.pavers;
    case 'sidewalk': return b?.surface === 'pavers' ? C.furniture : C.concrete;
    case 'furniture': return b?.surface === 'concrete' ? C.concrete : C.furniture;
    case 'boulevard': return C.grass;
    case 'curb': return C.curb;
    case 'transit_row': return b?.surface === 'grass' ? C.grass : C.row;
    case 'median': return b?.surface === 'grass' ? C.grass : C.median;
    case 'bike_lane': return C.bike;
    case 'parking': return C.parking;
    case 'platform': return C.platform;
    default: {
      const a = b ? bandAsset.get(b) : undefined;
      if (a?.id === 'lot_aisle') return C.lot;
      if (isLaneway(a)) return C.laneway;
      return C.asphalt;
    }
  }
}

// ------------------------------------------------------------------------------------------ annotate

/**
 * Per-vertex band coordinates for the soup (attributes `nb` = s, a, w, lat and `nc` = dEdge, 0, 0, 0):
 * every triangle is projected onto the edge sweep it lies in (centroid inside the section); its
 * band from the centroid; every vertex gets s along the edge and a across that band. Triangles
 * outside every sweep (node boxes and corners) get a frame along the nearest edge (s, a in metres,
 * w = 0).
 */
export function annotate(S: Soup, net: PrimNet): { nb: Float32Array; nc: Float32Array } {
  const nV = S.pos.length / 3;
  const nb = new Float32Array(nV * 4), nc = new Float32Array(nV * 4);
  interface Seg { e: number; k: number; x0: number; y0: number; dx: number; dy: number; len: number; umax: number }
  const segs: Seg[] = [];
  const cell = 16;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  const edges = net.edges;
  const assetOf = new Map(net.assets.map((a) => [a.id, a]));
  edges.forEach((e, ei) => {
    const sw = e.sweep;
    if (!sw) return;
    for (let k = 0; k < sw.s.length - 1; k++) {
      const x0 = sw.c[k][0] - S.ox, y0 = sw.c[k][1] - S.oy, x1 = sw.c[k + 1][0] - S.ox, y1 = sw.c[k + 1][1] - S.oy;
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1e-6;
      const U0 = sw.U[k], U1 = sw.U[k + 1];
      const umax = Math.max(Math.abs(U0[0]), Math.abs(U0[U0.length - 1]), Math.abs(U1[0]), Math.abs(U1[U1.length - 1])) + 0.3;
      const id = segs.push({ e: ei, k, x0, y0, dx: dx / len, dy: dy / len, len, umax }) - 1;
      const i0 = Math.floor((Math.min(x0, x1) - umax) / cell), i1 = Math.floor((Math.max(x0, x1) + umax) / cell);
      const j0 = Math.floor((Math.min(y0, y1) - umax) / cell), j1 = Math.floor((Math.max(y0, y1) + umax) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const q = key(i, j); const l = grid.get(q); if (l) l.push(id); else grid.set(q, [id]);
      }
    }
  });
  const P = S.pos;
  const vE = (v: number) => P[v * 3], vN = (v: number) => -P[v * 3 + 2];
  const proj = (g: Seg, x: number, y: number) => {
    const rx = x - g.x0, ry = y - g.y0;
    return { t: rx * g.dx + ry * g.dy, u: -rx * g.dy + ry * g.dx };   // u + left of the edge direction
  };
  for (let t = 0; t < nV; t += 3) {
    const cx = (vE(t) + vE(t + 1) + vE(t + 2)) / 3, cy = (vN(t) + vN(t + 1) + vN(t + 2)) / 3;
    const cand = grid.get(key(Math.floor(cx / cell), Math.floor(cy / cell))) ?? [];
    let best: Seg | null = null, bt = 0, bu = 0, bScore = Infinity;
    let near: Seg | null = null, nd = Infinity;
    for (const id of cand) {
      const g = segs[id];
      const p = proj(g, cx, cy);
      const out = Math.max(0, -p.t, p.t - g.len);
      const d = Math.hypot(out, Math.max(0, Math.abs(p.u) - g.umax));
      if (Math.abs(p.u) + out < nd) { nd = Math.abs(p.u) + out; near = g; }
      if (out > 0.05) continue;
      const sw = edges[g.e].sweep!;
      const f = Math.min(1, Math.max(0, p.t / g.len));
      const U0 = sw.U[g.k], U1 = sw.U[g.k + 1];
      const uL = U0[0] * (1 - f) + U1[0] * f, uR = U0[U0.length - 1] * (1 - f) + U1[U1.length - 1] * f;
      if (p.u > uL + 0.02 || p.u < uR - 0.02) continue;
      const score = d + Math.abs(p.u) * 1e-3;
      if (score < bScore) { bScore = score; best = g; bt = f; bu = p.u; }
    }
    if (best) {
      const sw = edges[best.e].sweep!;
      // Toronto practice: no lane lines on local streets, laneways and parking aisles (assets with
      // markings: false or class >= 5) -- drop the thin painted lines gen.ts sweeps there
      const id = S.col[t * 4 + 3];
      if (id === MID.PAINT_WHITE || id === MID.PAINT_YELLOW) {
        const e = edges[best.e], a = assetOf.get(e.asset) as (Asset & { markings?: boolean }) | undefined;
        if (a?.markings === false || e.cls >= 5) {
          const ax = vE(t + 1) - vE(t), ay = vN(t + 1) - vN(t), bx = vE(t + 2) - vE(t), by = vN(t + 2) - vN(t);
          const area2 = Math.abs(ax * by - ay * bx);
          const lmax = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by), Math.hypot(bx - ax, by - ay));
          if (area2 / Math.max(lmax, 1e-6) < 0.15) for (let v = t; v < t + 3; v++) S.col[v * 4 + 3] = MID.HIDDEN;
        }
      }
      const U0 = sw.U[best.k], U1 = sw.U[best.k + 1];
      const U = U0.map((u, j) => u * (1 - bt) + U1[j] * bt);
      let j = 0;
      while (j < U.length - 2 && bu < U[j + 1]) j++;
      const w = U[j] - U[j + 1];
      const cwL = U[sw.idx.cwL], cwR = U[sw.idx.cwR];
      const s0 = sw.s[best.k];
      for (let v = t; v < t + 3; v++) {
        const p = proj(best, vE(v), vN(v));
        nb.set([s0 + p.t, U[j] - p.u, Math.max(w, 0.01), p.u], v * 4);
        nc[v * 4] = Math.min(Math.abs(p.u - cwL), Math.abs(p.u - cwR));
      }
    } else {
      // node surfaces: a street-aligned frame from the nearest edge (else the Toronto grid, 16.7 deg)
      const dx = near ? near.dx : Math.sin(16.7 * Math.PI / 180), dy = near ? near.dy : Math.cos(16.7 * Math.PI / 180);
      for (let v = t; v < t + 3; v++) {
        const x = vE(v), y = vN(v);
        nb.set([x * dx + y * dy, -x * dy + y * dx, 0, 0], v * 4);
        nc[v * 4] = 99;
      }
    }
  }
  return { nb, nc };
}

// ------------------------------------------------------------------------------------------ shader

/** exact box-filtered coverage of [c-h, c+h] over a pixel footprint f */
const bandCov = (x: N, c: N, h: N, f: N): N => clamp(x.add(f.mul(0.5)), c.sub(h), c.add(h)).sub(clamp(x.sub(f.mul(0.5)), c.sub(h), c.add(h))).div(f);
/** box-filtered coverage of lines of width W centred on multiples of P */
const lines = (x: N, P: number | N, W: number | N, f: N): N => {
  const F = (t: N) => floor(t.div(P)).mul(W).add(min(fract(t.div(P)).mul(P), W));
  const y = x.add(float(W).mul(0.5));
  return F(y.add(f.mul(0.5))).sub(F(y.sub(f.mul(0.5)))).div(f);
};
const hash = (p: N): N => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
/** smooth value noise */
const vnoise = (p: N): N => {
  const i: N = floor(p), f: N = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash(i), b = hash(i.add(vec2(1, 0))), c = hash(i.add(vec2(0, 1))), d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
};
const near = (x: N, k: number): N => abs(x.sub(k)).lessThan(0.5);

// ------------------------------------------------------------------------------------------ night light map
// Light reaching the slice surface at night, baked by net2/props.ts from the placed lights (RGBA8 over the
// slice bbox): R LED cobra-head pools, G warm storefront spill on the frontage, B shelter / platform light.
const lmPlaceholder = new THREE.DataTexture(new Uint8Array(4), 1, 1);
lmPlaceholder.needsUpdate = true;
/** local-frame origin of the map (E - ox, N - oy) and 1 / its size (m) */
const lmXform = uniform(new THREE.Vector4(0, 0, 1, 1));
const lmNodes: N[] = [];
let lmTex: THREE.Texture = lmPlaceholder;
export function setLightMap(tex: THREE.Texture, x0: number, y0: number, w: number, h: number) {
  lmXform.value.set(x0, y0, 1 / w, 1 / h);
  lmTex = tex;
  for (const n of lmNodes) n.value = tex;
}
/** the night light map at a point of the slice's local frame (x = E - ox, z = -(N - oy)): rgba */
export function lightAt(x: N, z: N): N {
  const n = texture(lmTex, vec2(x.sub(lmXform.x).mul(lmXform.z), z.negate().sub(lmXform.y).mul(lmXform.w)));
  lmNodes.push(n);
  return n;
}

export function netMaterial(): THREE.MeshLambertNodeMaterial {
  // Lambert like the tile streets: no grazing-angle sheen washing out the street at eye level
  const mat = new THREE.MeshLambertNodeMaterial();
  mat.name = 'net2Surface';
  mat.side = THREE.DoubleSide;
  const asphaltT = streetTexture('asphalt_color.webp');
  const concreteT = streetTexture('concrete_color.webp');
  const grassT = streetTexture('grass_color.webp');
  const col = attribute('color', 'vec4');
  const nbA = attribute('nb', 'vec4');
  const ncA = attribute('nc', 'vec4');

  const shade = Fn(() => {
    const id = col.a;
    const alb = col.rgb;
    const s = nbA.x, a = nbA.y, w = nbA.z, lat = nbA.w, dEdge = ncA.x;
    const fs = max(fwidth(s), 0.0005), fa = max(fwidth(a), 0.0005);
    const fp = max(fs, fa);                         // pixel footprint (m)
    const fine = float(1).sub(smoothstep(0.012, 0.05, fp));   // detail at the cm scale
    const mid = float(1).sub(smoothstep(0.05, 0.25, fp));     // detail at the dm scale
    // world position (local metres, E / N) for isotropic detail textures
    const gp = vec2(positionGeometry.x, positionGeometry.z.negate());
    const y = positionGeometry.y;
    const inBand = w.greaterThan(0.005);
    const sa = vec2(s, a);

    // ---- asphalt: aggregate texture normalised to mean 1, macro variation, wear by lane position
    const aTex = texture(asphaltT, gp.div(3.2)).rgb.div(0.0198);
    const aMacro = texture(asphaltT, gp.div(71).add(0.37)).r.div(0.0198);
    const grain = mix(vec3(1), aTex, 0.35).mul(mix(float(1), aMacro, 0.2));
    const blotch = vnoise(gp.div(6.5)).mul(0.5).add(vnoise(gp.div(1.7)).mul(0.25));
    // wheel paths: 0.85 m either side of the lane centre, polished and darker; oil strip in the centre
    const isLane = inBand.and(w.greaterThan(2.5)).and(w.lessThan(4.4));
    const lc = a.sub(w.mul(0.5));
    const wheel = smoothstep(0.42, 0.12, abs(abs(lc).sub(0.85))).mul(select(isLane, float(1), float(0)));
    const oil = smoothstep(0.45, 0.1, abs(lc)).mul(select(isLane, float(1), float(0))).mul(vnoise(vec2(s.div(3.1), a.mul(2))).mul(0.7).add(0.3));
    // gutter: dust and grit in the 0.6 m along the curb
    const gutter = smoothstep(0.7, 0.05, dEdge);
    // transverse crack seals (tar) at hashed stations, construction joint along the band edge
    const ck = floor(s.div(13.7));
    const crackOn = select(hash(vec2(ck, w.floor())).lessThan(0.35), float(1), float(0));
    const crackPos = s.sub(ck.mul(13.7)).sub(hash(vec2(ck, 3.1)).mul(10).add(1.5)).add(sin(a.mul(1.7)).mul(0.08));
    const crack = bandCov(crackPos, float(0), float(0.012), fs).mul(crackOn).mul(select(inBand, float(1), float(0)));
    const seam = bandCov(a, float(0), float(0.01), fa).mul(select(isLane, float(1), float(0))).mul(0.6);
    // utility-cut patches: newer, darker rectangles
    const pc = floor(vec2(s.div(7.3), a.div(1.9)));
    const patch = select(hash(pc.add(17.3)).lessThan(0.05), float(1), float(0)).mul(select(inBand, float(1), float(0)));
    const asphaltBase = alb.mul(grain).mul(blotch.mul(0.1).add(0.96));
    const lanesWear = float(1).sub(wheel.mul(0.1)).sub(oil.mul(0.1)).add(gutter.mul(0.2));
    const asphalt = asphaltBase.mul(lanesWear).mul(mix(float(1), float(0.72), patch))
      .mul(float(1).sub(crack.add(seam).clamp(0, 1).mul(0.55)));
    // laneways: older, lighter, patched, a darker drainage line down the middle
    const laneway = asphaltBase.mul(mix(float(1), float(0.8), patch)).mul(vnoise(gp.div(3)).mul(0.25).add(0.95))
      .mul(float(1).sub(smoothstep(0.5, 0.0, abs(lat)).mul(0.18))).mul(float(1).sub(crack.mul(0.5)));
    // parking lane / lot: no wheel paths, oil drips where cars stand
    const drip = smoothstep(0.35, 0.05, length(vec2(fract(s.div(6.4)).sub(0.5).mul(6.4), a.sub(w.mul(0.5))).div(vec2(1.6, 0.5))))
      .mul(vnoise(sa.mul(3)).mul(0.6).add(0.4));
    const parking = asphaltBase.mul(float(1).sub(drip.mul(0.22))).mul(float(1).add(gutter.mul(0.18))).mul(float(1).sub(crack.mul(0.5)));

    // ---- concrete family
    const cTex = texture(concreteT, gp.div(2.2)).rgb.div(0.4922);
    const cMacro = vnoise(gp.div(4.3)).mul(0.5).add(vnoise(gp.div(0.9)).mul(0.25));
    const concBase = alb.mul(mix(vec3(1), cTex, 0.8)).mul(cMacro.mul(0.14).add(0.92));
    // sidewalk: 1.5 m panels, a joint along the curb side and one down the middle of wide walks
    const jW = 0.012;
    const tJoint = lines(s, 1.5, jW, fs);
    const lJoint = select(inBand, bandCov(a, w.mul(0.5), float(jW * 0.5), fa).mul(select(w.greaterThan(2.6), float(1), float(0))),
      lines(a, 1.5, jW, fa));
    const joints = tJoint.max(lJoint).mul(mid);
    // gum and stains: dark dots on downtown walks
    const gum = smoothstep(0.93, 0.975, hash(floor(gp.div(0.07)))).mul(fine).mul(0.5);
    const sidewalk = concBase.mul(float(1).sub(joints.mul(0.45))).mul(float(1).sub(gum.mul(0.5)));
    const frontage = concBase.mul(float(1).sub(lines(s, 1.8, jW, fs).max(select(inBand, float(0), lines(a, 1.8, jW, fa))).mul(mid).mul(0.4)));
    // streetcar slab: 4.5 m bays, joint down the middle, grime along the rails (tracks at +-1.72 m)
    const rowJ = lines(s, 4.5, 0.018, fs).max(bandCov(a, w.mul(0.5), float(0.009), fa)).mul(mid);
    const railGrime = smoothstep(0.9, 0.3, abs(abs(a.sub(w.mul(0.5))).sub(1.72)));
    const rowSlab = concBase.mul(float(1).sub(rowJ.mul(0.5))).mul(float(1).sub(railGrime.mul(0.16)));
    // platform: 3 m bays, fine broom texture across
    const broom = lines(s, 0.012, 0.004, fs).mul(fine).mul(0.06);
    const platform = concBase.mul(float(1).sub(lines(s, 3.0, jW, fs).mul(mid).mul(0.45))).mul(float(1).sub(broom));
    const median = concBase.mul(float(1).sub(lines(s, 3.0, jW, fs).mul(mid).mul(0.4)));
    // granite curb: speckle, 1.8 m stones; the vertical face uses s and height
    const speck = hash(floor(vec2(s, a.add(y.mul(3))).div(0.009))).sub(0.5).mul(fine).mul(0.45);
    const curbJ = lines(s, 1.8, 0.008, fs).mul(mid);
    const curb = alb.mul(mix(vec3(1), cTex, 0.5)).mul(float(1).add(speck)).mul(float(1).sub(curbJ.mul(0.5)));

    // ---- furnishing-zone pavers: 200 x 100 mm running bond along the street, red / brown / charcoal
    const row = floor(a.div(0.1));
    const xb = s.add(row.mul(0.1));
    const brick = vec2(floor(xb.div(0.2)), row);
    const hb = hash(brick.add(select(inBand, float(0), float(7.7))));
    const paverCol = select(hb.lessThan(0.16), vec3(0.075, 0.068, 0.062), select(hb.lessThan(0.55), alb, alb.mul(vec3(1.15, 1.3, 1.35))));
    const pJoint = lines(xb, 0.2, 0.006, fs).max(lines(a, 0.1, 0.006, fa)).mul(fine);
    const paverAvg = alb.mul(0.95);
    const pavers = mix(paverAvg, mix(paverCol.mul(hash(brick.add(3.3)).mul(0.25).add(0.88)), vec3(0.16, 0.145, 0.12), pJoint), mid)
      .mul(mix(vec3(1), cTex, 0.35));

    // ---- tactile: truncated domes on a 60 mm grid (yellow TTC tiles in 300 mm squares; cast iron plates)
    const dm = fract(sa.div(0.06)).sub(0.5).mul(0.06);
    const dome = smoothstep(0.013, 0.009, length(dm)).mul(fine);
    const tile = lines(s, 0.3, 0.004, fs).max(lines(a, 0.3, 0.004, fa)).mul(fine);
    const ttc = alb.mul(float(1).add(dome.mul(0.18))).mul(float(1).sub(tile.mul(0.5))).mul(vnoise(gp.div(0.8)).mul(0.1).add(0.95));
    const rust = vnoise(gp.div(0.35));
    const iron = mix(alb, vec3(0.16, 0.07, 0.035), rust.mul(0.6)).mul(float(1).add(dome.mul(0.6)));

    // ---- paint: retroreflective, worn where tyres run (patchy)
    const wear = smoothstep(0.35, 0.8, vnoise(gp.div(0.23)).mul(0.6).add(vnoise(gp.div(1.3)).mul(0.4)));
    const paintW = mix(alb, alb.mul(0.45), wear.mul(0.35));
    const paintY = mix(alb, alb.mul(0.5), wear.mul(0.3));

    // ---- bike lane (Toronto: white bicycle symbol + arrow every 50 m, OTM Book 18)
    const lv = fract(s.div(50)).mul(50).sub(25);
    const bc = a.sub(w.mul(0.5));
    const wh1 = bandCov(length(vec2(bc, lv.sub(0.55))), float(0.33), float(0.04), fp);
    const wh2 = bandCov(length(vec2(bc, lv.add(0.55))), float(0.33), float(0.04), fp);
    const frm = bandCov(bc, float(0), float(0.04), fa).mul(bandCov(lv, float(0), float(0.55), fs));
    const arrow = bandCov(bc, float(0), float(0.05), fa).mul(bandCov(lv, float(-2.2), float(0.6), fs))
      .add(bandCov(abs(bc).add(lv.add(1.5).mul(0.6)), float(0), float(0.05), fa).mul(bandCov(lv, float(-1.7), float(0.25), fs)));
    const edgeLine = bandCov(a, float(0.1), float(0.05), fa).add(bandCov(a, w.sub(0.1), float(0.05), fa));
    const sym = wh1.add(wh2).add(frm).add(arrow).add(edgeLine).clamp(0, 1);
    const bike = mix(asphaltBase, vec3(0.62, 0.62, 0.6), sym.mul(0.9));

    const grass = texture(grassT, gp.div(3)).rgb.div(vec3(0.1243, 0.1603, 0.0303)).mul(alb).mul(0.9);
    const rail = alb.mul(texture(asphaltT, gp.div(0.9)).r.div(0.0198).mul(0.2).add(0.9));

    const c = select(near(id, MID.ASPHALT), asphalt,
      select(near(id, MID.SIDEWALK), sidewalk,
        select(near(id, MID.FRONTAGE), frontage,
          select(near(id, MID.PAVERS), pavers,
            select(near(id, MID.CURB), curb,
              select(near(id, MID.ROW_SLAB), rowSlab,
                select(near(id, MID.GRASS), grass,
                  select(near(id, MID.PLATFORM), platform,
                    select(near(id, MID.TACTILE_TTC), ttc,
                      select(near(id, MID.TACTILE_IRON), iron,
                        select(near(id, MID.PAINT_WHITE), paintW,
                          select(near(id, MID.PAINT_YELLOW), paintY,
                            select(near(id, MID.RAIL), rail,
                              select(near(id, MID.BIKE), bike,
                                select(near(id, MID.MEDIAN), median,
                                  select(near(id, MID.LANEWAY), laneway,
                                    select(near(id, MID.LOT).or(near(id, MID.PARKING)), parking, alb)))))))))))))))));
    return c;
  });
  const albedo = shade();
  mat.colorNode = baseTone(albedo);
  // night: reflected light from the baked map (LED pools ~4000 K, warm shop windows, cool shelter light)
  const Lm = lightAt(positionGeometry.x, positionGeometry.z);
  (mat as unknown as { emissiveNode: N }).emissiveNode = albedo.mul(
    vec3(1.0, 0.95, 0.86).mul(Lm.r.mul(Lm.r.sqrt()).mul(1.8)).add(vec3(1.0, 0.68, 0.38).mul(Lm.g.mul(1.3))).add(vec3(0.85, 0.92, 1.0).mul(Lm.b.mul(1.6))),
  ).mul(U.night);
  const id = col.a;
  // the soup's pole stand-ins (id 0) are drawn by props.ts: discard them
  mat.opacityNode = select(id.lessThan(0.5), float(0), float(1));
  mat.alphaTest = 0.5;
  void luminance; void vec4;
  return mat;
}
