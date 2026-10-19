// Rail corridor primitives of the slice (tpipe.primrail -> primnet.json "rail"): the shared ballast bed,
// track bands (ballast prism + two rails, the tile renderer's proportions), slopes, retaining walls,
// fences, street-over-rail bridge structures (deck slab, fascia, parapets, abutments, piers) and level
// crossings. Inside the slice these replace the tile's rail drawing (tileFilter drops its heavy rail).
import type { Soup } from './gen';
import { C, type Mat } from './materials';

type ZF = (e: number, n: number, z: number) => number;
type P3 = number[];

export interface RailNet {
  tracks: { cls: number; hw: number; xyz: P3[]; bridge: number[] }[];
  bed: { p: number[][]; z: number[]; t: number[][] }[];
  slopes: { inner: P3[]; outer: P3[]; kind: string }[];
  walls: { xy: number[][]; zb: number[]; zt: number[] }[];
  fences: { xyz: P3[]; h: number }[];
  structures: { left: P3[]; right: P3[]; abutments: P3[][]; seat: number[]; piers: { cols: number[][][]; ztop: number }[]; depth: number; parapet: number }[];
  crossings: { xy: number[]; z_track: number | null; track_dir: number[] | null; gates: boolean; lights: boolean; approaches: { mast: number[]; yaw: number; arm: number }[] }[];
  conv: { ballast_top: number; rail_head: number; gauge: number; ballast_top_inset: number };
}

// plain vertex-colour materials (ids the surface shader passes through)
const m = (r: number, g: number, b: number, id: number): Mat => [r, g, b, id];
const BALLAST = m(0.21, 0.195, 0.175, 20);
const BED = m(0.16, 0.15, 0.135, 20);
const STRUCT = m(0.33, 0.325, 0.31, 21);
const FENCE = m(0.16, 0.165, 0.17, 22);
const SIGNAL = m(0.55, 0.04, 0.03, 23);
const STEEL = C.rail;

function frame(P: P3[], k: number): [number, number] {
  const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)];
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];                      // left normal
}

function strip(S: Soup, L: P3[], R: P3[], zl: number[], zr: number[], rgb: Mat) {
  for (let k = 0; k < L.length - 1; k++)
    S.quad(S.v(L[k][0], L[k][1], zl[k]), S.v(R[k][0], R[k][1], zr[k]), S.v(R[k + 1][0], R[k + 1][1], zr[k + 1]), S.v(L[k + 1][0], L[k + 1][1], zl[k + 1]), rgb);
}

function wallLine(S: Soup, xy: number[][], zb: number[], zt: number[], rgb: Mat) {
  for (let k = 0; k < xy.length - 1; k++)
    S.wall(S.v(xy[k][0], xy[k][1], zb[k]), S.v(xy[k + 1][0], xy[k + 1][1], zb[k + 1]), S.v(xy[k + 1][0], xy[k + 1][1], zt[k + 1]), S.v(xy[k][0], xy[k][1], zt[k]), rgb);
}

function column(S: Soup, q: number[][], zb: number, zt: number, rgb: Mat) {
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    S.wall(S.v(a[0], a[1], zb), S.v(b[0], b[1], zb), S.v(b[0], b[1], zt), S.v(a[0], a[1], zt), rgb);
  }
  S.quad(S.v(q[0][0], q[0][1], zt), S.v(q[1][0], q[1][1], zt), S.v(q[2][0], q[2][1], zt), S.v(q[3][0], q[3][1], zt), rgb);
}

/** ground level under a structure: the bed (nearest bed vertex) where the corridor is, else the abutment seat - 6 m */
function makeGround(rail: RailNet) {
  const pts: number[][] = [];
  for (const b of rail.bed) for (let i = 0; i < b.p.length; i += 7) pts.push([b.p[i][0], b.p[i][1], b.z[i]]);
  return (x: number, y: number, fallback: number) => {
    let best = Infinity, z = fallback;
    for (const p of pts) {
      const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d < best) { best = d; z = p[2]; }
    }
    return best < 40 * 40 ? z : fallback;
  };
}

export function genRail(S: Soup, rail: RailNet | null | undefined, zAt: ZF) {
  if (!rail) return;
  const BT = rail.conv?.ballast_top ?? 0.28, RH = rail.conv?.rail_head ?? 0.44, G2 = (rail.conv?.gauge ?? 1.435) / 2, INS = rail.conv?.ballast_top_inset ?? 0.6;
  // shared bed
  for (const b of rail.bed) {
    const v = b.p.map((p, i) => S.v(p[0], p[1], zAt(p[0], p[1], b.z[i])));
    for (const [i, j, k] of b.t) S.tri(v[i], v[j], v[k], BED);
  }
  // tracks: ballast prism + rails (bridge vertices carry no ballast)
  for (const t of rail.tracks) {
    const P = t.xyz;
    const N = P.map((_, k) => frame(P, k));
    const Z = P.map((p) => zAt(p[0], p[1], p[2]));
    for (let k = 0; k < P.length - 1; k++) {
      if (t.bridge[k] && t.bridge[k + 1]) continue;
      const row = (i: number, u: number, h: number) => S.v(P[i][0] + N[i][0] * u, P[i][1] + N[i][1] * u, Z[i] + h);
      const hw = t.hw, top = hw - INS;
      S.quad(row(k, hw, 0.03), row(k, top, BT), row(k + 1, top, BT), row(k + 1, hw, 0.03), BALLAST);
      S.quad(row(k, top, BT), row(k, -top, BT), row(k + 1, -top, BT), row(k + 1, top, BT), BALLAST);
      S.quad(row(k, -top, BT), row(k, -hw, 0.03), row(k + 1, -hw, 0.03), row(k + 1, -top, BT), BALLAST);
      for (const u of [G2, -G2]) {
        S.quad(row(k, u + 0.036, RH), row(k, u - 0.036, RH), row(k + 1, u - 0.036, RH), row(k + 1, u + 0.036, RH), STEEL);
        S.wall(row(k, u, BT), row(k + 1, u, BT), row(k + 1, u, RH), row(k, u, RH), STEEL);
      }
    }
  }
  // slopes (berms / cuts) to the ground
  for (const s of rail.slopes) strip(S, s.inner, s.outer, s.inner.map((p) => zAt(p[0], p[1], p[2])), s.outer.map((p) => zAt(p[0], p[1], p[2])), C.grass);
  // retaining walls, with a 0.3 m coping
  for (const w of rail.walls) {
    const zb = w.xy.map((p, i) => zAt(p[0], p[1], w.zb[i]) - 0.3), zt = w.xy.map((p, i) => zAt(p[0], p[1], w.zt[i]) + 0.15);
    wallLine(S, w.xy, zb, zt, STRUCT);
  }
  // fences: mesh panel + posts every ~3 m
  for (const f of rail.fences) {
    const z0 = f.xyz.map((p) => zAt(p[0], p[1], p[2]));
    wallLine(S, f.xyz, z0, z0.map((z) => z + f.h), FENCE);
    let acc = 0;
    for (let k = 1; k < f.xyz.length; k++) {
      acc += Math.hypot(f.xyz[k][0] - f.xyz[k - 1][0], f.xyz[k][1] - f.xyz[k - 1][1]);
      if (acc < 3) continue;
      acc = 0;
      const p = f.xyz[k], r = 0.04;
      column(S, [[p[0] - r, p[1] - r], [p[0] + r, p[1] - r], [p[0] + r, p[1] + r], [p[0] - r, p[1] + r]], z0[k], z0[k] + f.h + 0.1, FENCE);
    }
  }
  // street-over-rail structures: the deck surface is the street's own sweep; here the slab, fascia,
  // parapets, abutment walls and piers
  const ground = makeGround(rail);
  for (const st of rail.structures) {
    const L = st.left, R = st.right;
    const zt = L.map((p) => zAt(p[0], p[1], p[2])), zb = zt.map((z) => z - st.depth);
    strip(S, R, L, zb, zb, STRUCT);                                        // soffit
    wallLine(S, L.map((p) => [p[0], p[1]]), zb, zt, STRUCT);               // fascias
    wallLine(S, R.map((p) => [p[0], p[1]]), zb, zt, STRUCT);
    wallLine(S, L.map((p) => [p[0], p[1]]), zt, zt.map((z) => z + st.parapet), STRUCT);     // parapets
    wallLine(S, R.map((p) => [p[0], p[1]]), zt, zt.map((z) => z + st.parapet), STRUCT);
    st.abutments.forEach((a, i) => {
      const top = zAt(a[0][0], a[0][1], st.seat[i]);
      const bot = a.map((p) => ground(p[0], p[1], top - 6) - 0.5);
      wallLine(S, a.map((p) => [p[0], p[1]]), bot, [top, top], STRUCT);
    });
    for (const p of st.piers) for (const c of p.cols) {
      const cx = c.reduce((s, q) => s + q[0], 0) / 4, cy = c.reduce((s, q) => s + q[1], 0) / 4;
      const top = zAt(cx, cy, p.ztop);
      column(S, c, ground(cx, cy, top - 8) - 0.3, top, STRUCT);
    }
  }
  // level crossings: a concrete panel along the track across the street, gate masts with lights
  for (const x of rail.crossings) {
    if (x.z_track == null || !x.track_dir) continue;
    const [tx, ty] = x.track_dir, nx = -ty, ny = tx;
    const z = zAt(x.xy[0], x.xy[1], x.z_track) + RH + 0.005;
    const q = (u: number, v: number) => S.v(x.xy[0] + tx * u + nx * v, x.xy[1] + ty * u + ny * v, z);
    S.quad(q(-5, -1.4), q(5, -1.4), q(5, 1.4), q(-5, 1.4), C.concrete);
    for (const a of x.approaches ?? []) {
      const r = 0.12, mz = zAt(a.mast[0], a.mast[1], x.z_track) + RH;
      column(S, [[a.mast[0] - r, a.mast[1] - r], [a.mast[0] + r, a.mast[1] - r], [a.mast[0] + r, a.mast[1] + r], [a.mast[0] - r, a.mast[1] + r]], mz, mz + 4.2, STRUCT);
      if (x.lights) column(S, [[a.mast[0] - 0.2, a.mast[1] - 0.2], [a.mast[0] + 0.2, a.mast[1] - 0.2], [a.mast[0] + 0.2, a.mast[1] + 0.2], [a.mast[0] - 0.2, a.mast[1] + 0.2]], mz + 2.8, mz + 3.2, SIGNAL);
      if (x.gates) {          // the arm, raised: a slim upright beside the mast
        const ux = Math.cos(a.yaw) * 0.3, uy = Math.sin(a.yaw) * 0.3;
        column(S, [[a.mast[0] + ux - 0.06, a.mast[1] + uy - 0.06], [a.mast[0] + ux + 0.06, a.mast[1] + uy - 0.06], [a.mast[0] + ux + 0.06, a.mast[1] + uy + 0.06], [a.mast[0] + ux - 0.06, a.mast[1] + uy + 0.06]], mz + 1.0, mz + 1.0 + a.arm, m(0.75, 0.73, 0.7, 24));
      }
    }
  }
}
