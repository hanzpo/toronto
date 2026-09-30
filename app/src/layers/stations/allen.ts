// Allen Road (Spadina line, 1978) median stations: Glencairn, Lawrence West,
// Yorkdale, Wilson. The platform sits between the two tracks in the
// expressway median; the stations layer draws the platform, this file draws
// the station structure around it, in the frame of the tracks the trains run
// on (so clearances hold wherever the snapped tracks end up):
//
//  - the enclosure: walls 3.2 m outside each track centreline (≥ 2.2 m
//    column/wall clearance, docs/STATIONS.md) and the roof: Glencairn's flat
//    roof with the central vaulted skylight (Rita Letendre's pink "Joy"
//    glass), Lawrence West's orange-framed skylight strips over the tracks and
//    glazed upper walls, Yorkdale's glass barrel vault ending in half domes on
//    stainless-clad walls with oval windows (Arthur Erickson), Wilson's plain
//    concrete box;
//  - platform columns on the platform centreline (Yorkdale's X struts);
//  - the concourse bridging the tracks at the entrance end (floor ≥ 5.6 m
//    over the rail) and, where curated, an enclosed walkway over the Allen
//    lanes to a stair tower (Yorkdale → mall), or Lawrence West's bus deck
//    bridging the median south of the Lawrence Avenue bridge.
//
// Curated in pipeline/curated/stations.json as `levels[].structure`:
//   { "kind": "glencairn" | "lawrence_west" | "yorkdale" | "wilson",
//     "concourse": "n" | "s" | "both",            // end(s) with a bridging concourse
//     "walks": [{ "from": [lat, lon], "to": [lat, lon] }],   // → E/N in stations.json
//     "deck": { "west": m, "len": m } }                   // Lawrence West bus deck
// All geometry is vertex-coloured and lands in the station's lit buffer
// (no extra draw calls).
import type { Geo, RGB } from './build';

type V3 = [number, number, number];

export interface StructureSpec {
  kind: 'glencairn' | 'lawrence_west' | 'yorkdale' | 'wilson';
  concourse?: 'n' | 's' | 'both';
  walks?: { from: [number, number]; to: [number, number] }[];
  deck?: { west: number; len: number };
}

export interface TrackSample { e: number; n: number; z: number; nx: number; ny: number; s: number }

export interface AllenCtx {
  g: Geo;
  /** samples along the reference track covering the platform ± 40 m, ≤ 4 m apart */
  S: TrackSample[];
  /** platform arc range on the reference track */
  s0: number;
  s1: number;
  /** platform edges (lateral, along the samples' left normal); tracks at a − E and b + E */
  a: number;
  b: number;
  E: number;
  /** platform top above rail */
  H: number;
  P: (e: number, n: number, z: number) => V3;
  heightAt(e: number, n: number): number;
  /** a network track centreline within r of (e, n) */
  trackNear(e: number, n: number, r: number): boolean;
}

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const lin = (c: RGB): RGB => c.map((v) => Math.pow(v, 2.2)) as RGB;
const C = {
  concrete: lin(hex(0xb3aea4)),
  concreteDark: lin(hex(0x8a857c)),
  concreteIn: lin(hex(0x9f9b93)),
  white: lin(hex(0xe6e4dd)),
  roof: lin(hex(0x8e9194)),
  glass: lin(hex(0x9fbdcc)),
  glassPink: lin(hex(0xe6c3cf)),
  glassDark: lin(hex(0x3f5663)),
  steel: lin(hex(0x5b6168)),
  steelWhite: lin(hex(0xdfe3e6)),
  stainless: lin(hex(0xc7ccd1)),
  orange: lin(hex(0xe0701c)),
  brick: lin(hex(0x9a5a43)),
  deck: lin(hex(0x77797b)),
  ttcRed: lin(hex(0xda251d)),
};

/** Wall centre offset outside a track centreline (m): 3.2 − ½ wall ≥ 2.2 clearance. */
const WALL_OFF = 3.2;
const WALL_T = 0.45;
/** underside of anything spanning the tracks, above rail */
const SPAN_CLEAR = 5.6;

export function buildAllen(spec: StructureSpec, c: AllenCtx): { cols: [number, number][] } {
  const { g, S, P } = c;
  const cols: [number, number][] = [];
  const up: V3 = [0, 1, 0], down: V3 = [0, -1, 0];
  const tA = c.a - c.E, tB = c.b + c.E;
  const lw = tA - WALL_OFF, rw = tB + WALL_OFF;
  const mid = (c.a + c.b) / 2;
  // rail level is flat over the platform: use its mean for the whole structure
  const inPl = S.filter((q) => q.s >= c.s0 && q.s <= c.s1);
  const zr = (inPl.length ? inPl : S).reduce((t, q) => t + q.z, 0) / Math.max(1, (inPl.length ? inPl : S).length);
  const Q = (i: number, lat: number, y: number): V3 => { const q = S[i]; return P(q.e + q.nx * lat, q.n + q.ny * lat, zr + y); };
  const W = (i: number, lat: number): [number, number] => { const q = S[i]; return [q.e + q.nx * lat, q.n + q.ny * lat]; };
  const lat3 = (i: number): V3 => [S[i].nx, 0, -S[i].ny];
  const along3 = (i: number): V3 => [S[i].ny, 0, S[i].nx];
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
  const idx = (s: number) => {
    let k = 0;
    for (let i = 0; i < S.length; i++) if (Math.abs(S[i].s - s) < Math.abs(S[k].s - s)) k = i;
    return k;
  };
  // north = the platform end whose arc position points north
  const tN = S[S.length - 1].n - S[0].n >= 0 ? 1 : -1; // +1: increasing s runs north
  const endS = (end: 'n' | 's') => ((end === 'n') === (tN > 0) ? c.s1 : c.s0);
  const outDir = (end: 'n' | 's') => ((end === 'n') === (tN > 0) ? 1 : -1);
  // east = +lateral when the left normal points east
  const eastSign = S[0].nx >= 0 ? 1 : -1;

  /** closed box following the track between samples i0..i1, lateral l0..l1, heights y0..y1 */
  const band = (i0: number, i1: number, l0: number, l1: number, y0: number, y1: number, col: RGB, caps = true, bottom = false) => {
    for (let i = i0; i < i1; i++) {
      g.face(Q(i, l0, y1), Q(i + 1, l0, y1), Q(i + 1, l1, y1), Q(i, l1, y1), col, up);
      if (bottom) g.face(Q(i, l0, y0), Q(i + 1, l0, y0), Q(i + 1, l1, y0), Q(i, l1, y0), col, down);
      g.face(Q(i, l0, y0), Q(i + 1, l0, y0), Q(i + 1, l0, y1), Q(i, l0, y1), col, neg(lat3(i)));
      g.face(Q(i, l1, y0), Q(i + 1, l1, y0), Q(i + 1, l1, y1), Q(i, l1, y1), col, lat3(i));
    }
    if (caps) {
      g.face(Q(i0, l0, y0), Q(i0, l1, y0), Q(i0, l1, y1), Q(i0, l0, y1), col, neg(along3(i0)));
      g.face(Q(i1, l0, y0), Q(i1, l1, y0), Q(i1, l1, y1), Q(i1, l0, y1), col, along3(i1));
    }
  };
  /** thin vertical panel along the track at lateral `lat`, facing ±lateral (both sides) */
  const skin = (i0: number, i1: number, lat: number, y0: number, y1: number, col: RGB, sides: 1 | -1 | 0 = 0) => {
    for (let i = i0; i < i1; i++) {
      if (sides >= 0) g.face(Q(i, lat, y0), Q(i + 1, lat, y0), Q(i + 1, lat, y1), Q(i, lat, y1), col, lat3(i));
      if (sides <= 0) g.face(Q(i, lat, y0), Q(i + 1, lat, y0), Q(i + 1, lat, y1), Q(i, lat, y1), col, neg(lat3(i)));
    }
  };
  /** vertical cross panel at sample i spanning l0..l1 (both faces) */
  const cross = (i: number, l0: number, l1: number, y0: number, y1: number, col: RGB) => {
    g.face(Q(i, l0, y0), Q(i, l1, y0), Q(i, l1, y1), Q(i, l0, y1), col, along3(i));
    g.face(Q(i, l0, y0), Q(i, l1, y0), Q(i, l1, y1), Q(i, l0, y1), col, neg(along3(i)));
  };
  /** square column at (sample i, lat) from y0 to y1; skipped when a track centreline is within 2.2 m */
  const column = (i: number, lat: number, y0: number, y1: number, w: number, col: RGB) => {
    const [e, n] = W(i, lat);
    if (c.trackNear(e, n, 2.2 + w / 2)) return false;
    const o = Q(i, lat, 0);
    box(o, along3(i), w, w, y0, y1, col);
    cols.push([e, n]);
    return true;
  };
  /** box centred at o (three coords; y relative to o), long axis d */
  const box = (o: V3, d: V3, len: number, wid: number, y0: number, y1: number, col: RGB, top = true) => {
    const r: V3 = [d[2], 0, -d[0]];
    const hl = len / 2, hw = wid / 2;
    const K = (a: number, s: number, y: number): V3 => [o[0] + d[0] * a + r[0] * s, o[1] + y, o[2] + d[2] * a + r[2] * s];
    if (top) g.face(K(-hl, -hw, y1), K(hl, -hw, y1), K(hl, hw, y1), K(-hl, hw, y1), col, up);
    g.face(K(-hl, -hw, y0), K(hl, -hw, y0), K(hl, hw, y0), K(-hl, hw, y0), col, down);
    g.face(K(-hl, hw, y0), K(hl, hw, y0), K(hl, hw, y1), K(-hl, hw, y1), col, r);
    g.face(K(-hl, -hw, y0), K(hl, -hw, y0), K(hl, -hw, y1), K(-hl, -hw, y1), col, neg(r));
    g.face(K(hl, -hw, y0), K(hl, hw, y0), K(hl, hw, y1), K(hl, -hw, y1), col, d);
    g.face(K(-hl, -hw, y0), K(-hl, hw, y0), K(-hl, hw, y1), K(-hl, -hw, y1), col, neg(d));
  };
  /** arched (half-sine) glazed vault between laterals l0..l1 springing at ys, both faces; ribs every ~ribStep m */
  const vault = (i0: number, i1: number, l0: number, l1: number, ys: number, rise: number, n: number, glass: RGB, rib: RGB | null, ribStep = 4) => {
    const pt = (i: number, k: number): V3 => { const t = k / n; return Q(i, l0 + (l1 - l0) * t, ys + rise * Math.sin(Math.PI * t)); };
    let lastRib = -1e9;
    for (let i = i0; i < i1; i++) {
      for (let k = 0; k < n; k++) quad2(pt(i, k), pt(i + 1, k), pt(i + 1, k + 1), pt(i, k + 1), glass);
      if (rib && S[i].s - lastRib >= ribStep) {
        lastRib = S[i].s;
        for (let k = 0; k < n; k++) {
          const a = pt(i, k), b = pt(i, k + 1);
          ribSeg(a, b, along3(i), 0.18, 0.22, rib);
        }
      }
    }
  };
  /** quad drawn on both sides */
  const quad2 = (a: V3, b: V3, cc: V3, d: V3, col: RGB) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    g.face(a, b, cc, d, col, [nx, ny, nz]);
    g.face(a, b, cc, d, col, [-nx, -ny, -nz]);
  };
  /** small rectangular bar from a to b (rib), thickness t along `d`, depth h below */
  const ribSeg = (a: V3, b: V3, d: V3, t: number, h: number, col: RGB) => {
    const o = (p: V3, s: number, y: number): V3 => [p[0] + d[0] * s, p[1] - y, p[2] + d[2] * s];
    quad2(o(a, -t, 0), o(b, -t, 0), o(b, -t, h), o(a, -t, h), col);
    quad2(o(a, t, 0), o(b, t, 0), o(b, t, h), o(a, t, h), col);
    quad2(o(a, -t, h), o(b, -t, h), o(b, t, h), o(a, t, h), col);
  };
  /** enclosed box spanning between arc positions sa..sb (end walls), laterals l0..l1, y0..y1 */
  const spanBox = (sa: number, sb: number, l0: number, l1: number, y0: number, y1: number, wall: RGB, band_: RGB | null, roof: RGB) => {
    const i0 = idx(Math.min(sa, sb)), i1 = idx(Math.max(sa, sb));
    if (i1 <= i0) return;
    band(i0, i1, l0, l1, y0, y0 + 0.6, C.concreteDark, true, true); // floor slab (underside visible from the tracks)
    band(i0, i1, l0 + 0.1, l1 - 0.1, y0 + 0.6, y1 - 0.5, wall, true);
    if (band_) {
      skin(i0, i1, l0 - 0.02, y0 + 1.6, y1 - 1.2, band_, -1);
      skin(i0, i1, l1 + 0.02, y0 + 1.6, y1 - 1.2, band_, 1);
      g.face(Q(i0, l0 + 0.4, y0 + 1.6), Q(i0, l1 - 0.4, y0 + 1.6), Q(i0, l1 - 0.4, y1 - 1.2), Q(i0, l0 + 0.4, y1 - 1.2), band_, neg(along3(i0)));
      g.face(Q(i1, l0 + 0.4, y0 + 1.6), Q(i1, l1 - 0.4, y0 + 1.6), Q(i1, l1 - 0.4, y1 - 1.2), Q(i1, l0 + 0.4, y1 - 1.2), band_, along3(i1));
    }
    band(i0, i1, l0 - 0.3, l1 + 0.3, y1 - 0.5, y1, roof, true, true);
  };
  /** ground level (datum) under the lateral range at sample i, relative to rail */
  const groundRel = (i: number, l0: number, l1: number) => {
    let m = -Infinity;
    for (let k = 0; k <= 4; k++) { const [e, n] = W(i, l0 + ((l1 - l0) * k) / 4); m = Math.max(m, c.heightAt(e, n) - zr); }
    return m;
  };

  // ------------------------------------------------------------ enclosure extent
  const iA = idx(c.s0 - 3), iB = idx(c.s1 + 3);
  const kind = spec.kind;
  const wallTop = kind === 'yorkdale' ? 4.2 : kind === 'lawrence_west' ? 5.4 : 5.6;
  const roofTop = wallTop + 0.5;

  // side walls (thick, both faces) + coping
  for (const lat of [lw, rw]) {
    band(iA, iB, lat - WALL_T / 2, lat + WALL_T / 2, -0.3, kind === 'lawrence_west' ? 2.4 : wallTop, C.concreteIn);
    const outSide = lat < mid ? -1 : 1;
    const lo = lat + outSide * (WALL_T / 2 + 0.02);
    if (kind === 'glencairn') skin(iA, iB, lo, 3.4, wallTop, C.white, outSide as 1 | -1); // white horizontal cladding band
    if (kind === 'yorkdale') {
      skin(iA, iB, lo, 0.4, wallTop, C.stainless, outSide as 1 | -1);
      // oval windows (recalling the train windows), every ~5 m
      for (let i = iA + 1; i < iB; i++) {
        if ((i - iA) % 2) continue;
        const o = Q(i, lo + outSide * 0.02, 0);
        const d = along3(i), r: V3 = [lat3(i)[0] * outSide, 0, lat3(i)[2] * outSide];
        ellipse(o, d, r, 1.5, 0.75, 2.2, C.glassDark);
      }
    }
    if (kind === 'lawrence_west') {
      // glazed upper wall in orange-painted frames
      skin(iA, iB, lat, 2.4, wallTop, C.glass, 0);
      for (let i = iA; i <= iB; i++) {
        const o = Q(i, lat, 0);
        box(o, along3(i), 0.16, 0.3, 2.4, wallTop, C.orange);
      }
      band(iA, iB, lat - 0.2, lat + 0.2, 2.3, 2.5, C.orange);
    }
  }

  // ------------------------------------------------------------ roof
  if (kind === 'yorkdale') {
    // glass barrel vault over tracks + platform, springing from the walls
    const half = (rw - lw) / 2;
    const rise = half * 0.62;
    vault(iA, iB, lw, rw, wallTop, rise, 10, C.glass, C.steelWhite, 4);
    band(iA, iB, lw - 0.4, lw + 0.4, wallTop, wallTop + 0.35, C.stainless);
    band(iA, iB, rw - 0.4, rw + 0.4, wallTop, wallTop + 0.35, C.stainless);
    for (const [i, sg] of [[iA, -1], [iB, 1]] as const) halfDome(i, sg, lw, rw, wallTop, rise);
  } else {
    // flat roof slab; Glencairn: central vaulted skylight; Lawrence West: skylight strips over the tracks
    const gaps: [number, number][] =
      kind === 'glencairn' ? [[c.a + 0.6, c.b - 0.6]] : kind === 'lawrence_west' ? [[tA - 1.6, tA + 1.6], [tB - 1.6, tB + 1.6]] : [];
    let l = lw - 0.5;
    for (const [g0, g1] of [...gaps, [rw + 0.5, rw + 0.5] as [number, number]]) {
      if (g0 > l + 0.05) band(iA, iB, l, g0, wallTop, roofTop, C.roof, true, true);
      l = g1;
    }
    // fascia
    skin(iA, iB, lw - 0.52, roofTop - 0.9, roofTop, kind === 'glencairn' ? C.white : C.concreteDark, -1);
    skin(iA, iB, rw + 0.52, roofTop - 0.9, roofTop, kind === 'glencairn' ? C.white : C.concreteDark, 1);
    if (kind === 'glencairn') {
      vault(iA, iB, c.a + 0.6, c.b - 0.6, roofTop, 1.9, 6, C.glassPink, C.steelWhite, 6);
      cross(iA, c.a + 0.6, c.b - 0.6, wallTop, roofTop, C.concrete);
      cross(iB, c.a + 0.6, c.b - 0.6, wallTop, roofTop, C.concrete);
    }
    if (kind === 'lawrence_west') {
      for (const t of [tA, tB]) {
        band(iA, iB, t - 1.7, t - 1.5, wallTop, roofTop + 0.7, C.orange);
        band(iA, iB, t + 1.5, t + 1.7, wallTop, roofTop + 0.7, C.orange);
        vault(iA, iB, t - 1.5, t + 1.5, roofTop + 0.5, 0.5, 2, C.glass, C.orange, 3);
      }
    }
    // end walls above the trains' clearance (gable ends), open below for the tracks
    for (const i of [iA, iB]) cross(i, lw, rw, SPAN_CLEAR - 0.6, wallTop, C.concrete);
  }

  // ------------------------------------------------------------ platform columns
  const top = kind === 'yorkdale' ? wallTop + 0.4 : wallTop;
  let lastCol = -1e9;
  for (let i = idx(c.s0 + 6); i <= idx(c.s1 - 6); i++) {
    if (S[i].s - lastCol < (kind === 'yorkdale' ? 12 : 10)) continue;
    if (!column(i, mid, c.H, top, kind === 'yorkdale' ? 0.7 : 0.55, kind === 'yorkdale' ? C.stainless : C.concrete)) continue;
    lastCol = S[i].s;
    if (kind === 'yorkdale') {
      // X-shaped struts from the pillar head up to the vault
      const half = (rw - lw) / 2, rise = half * 0.62;
      for (const sd of [-1, 1]) {
        const lt = mid + sd * 3.4;
        const t = (lt - lw) / (rw - lw);
        const yv = wallTop + rise * Math.sin(Math.PI * t) - 0.25;
        for (const da of [-1.6, 1.6]) {
          const a = Q(i, mid, top);
          const q = S[i];
          const b0 = Q(i, lt, yv);
          const b: V3 = [b0[0] + q.ny * da, b0[1], b0[2] + q.nx * da];
          ribSeg([a[0], a[1] + 0.2, a[2]], [b[0], b[1] + 0.2, b[2]], lat3(i), 0.12, 0.25, C.steelWhite);
        }
      }
    }
  }

  // ------------------------------------------------------------ concourses bridging the tracks
  const ends: ('n' | 's')[] = spec.concourse === 'both' ? ['n', 's'] : spec.concourse ? [spec.concourse] : [];
  for (const end of ends) {
    const se = endS(end), od = outDir(end);
    const len = kind === 'glencairn' && end === 's' ? 11 : 16;
    // stair / escalator core on the platform end, up to the concourse floor
    const sc0 = se - od * 14, sc1 = se - od * 1;
    const ic0 = idx(Math.min(sc0, sc1)), ic1 = idx(Math.max(sc0, sc1));
    const pw = Math.min(3.6, c.b - c.a - 2.4);
    if (pw > 1.5 && ic1 > ic0) {
      band(ic0, ic1, mid - pw / 2, mid + pw / 2, c.H, SPAN_CLEAR + 0.6, kind === 'yorkdale' ? C.stainless : C.concreteDark);
      skin(ic0, ic1, mid - pw / 2 - 0.02, c.H + 0.4, SPAN_CLEAR - 0.4, C.glassDark, -1);
      skin(ic0, ic1, mid + pw / 2 + 0.02, c.H + 0.4, SPAN_CLEAR - 0.4, C.glassDark, 1);
    }
    // concourse box: floor over the rail by SPAN_CLEAR and over the ground beside the tracks
    const sa = se + od * 1, sb = se + od * (1 + len);
    const gr = Math.max(groundRel(idx(sa), lw, rw), groundRel(idx(sb), lw, rw));
    const y0 = Math.max(SPAN_CLEAR, gr + 0.2);
    const y1 = y0 + (kind === 'lawrence_west' ? 5 : 4.4);
    const wall = kind === 'yorkdale' ? C.stainless : kind === 'glencairn' ? C.white : kind === 'lawrence_west' ? C.concrete : C.concrete;
    const bandC = kind === 'wilson' ? null : C.glass;
    spanBox(sa, sb, lw - 0.4, rw + 0.4, y0, y1, wall, bandC, C.roof);
    // TTC red band over the entrance face
    const iE = idx(sb);
    cross(iE, lw, rw, y1 - 1.1, y1 - 0.6, C.ttcRed);
    // piers under the concourse along the wall lines (outside the track clearance)
    for (const s of [sa, sb]) for (const lat of [lw, rw]) column(idx(s), lat, -0.3, y0, 0.8, C.concreteDark);
  }

  // ------------------------------------------------------------ Lawrence West bus deck
  if (spec.deck) {
    const se = endS('n'), od = outDir('n');
    const sa = se - od * 6, sb = se + od * spec.deck.len;
    const west = -eastSign; // lateral direction of west
    const lOut = (west < 0 ? lw : rw) + west * spec.deck.west;
    const l0 = Math.min(lOut, west < 0 ? rw + 0.6 : lw - 0.6), l1 = Math.max(lOut, west < 0 ? rw + 0.6 : lw - 0.6);
    const i0 = idx(Math.min(sa, sb)), i1 = idx(Math.max(sa, sb));
    let gr = -Infinity;
    for (let i = i0; i <= i1; i += 2) gr = Math.max(gr, groundRel(i, l0, l1));
    const y0 = Math.max(SPAN_CLEAR + 0.4, gr + 5.2);
    band(i0, i1, l0, l1, y0, y0 + 1.1, C.deck, true, true);
    skin(i0, i1, l0 - 0.02, y0, y0 + 1.1, C.orange, -1);
    skin(i0, i1, l1 + 0.02, y0, y0 + 1.1, C.orange, 1);
    // piers: wall lines (between tracks and roads) and the deck's outer edge
    for (let i = i0; i <= i1; i += Math.max(1, Math.round(12 / Math.max(1, Math.abs(S[1].s - S[0].s))))) {
      for (const lat of [lw, rw, lOut - west * 0.8]) column(i, lat, -0.3 + Math.min(0, groundRel(i, lat, lat)), y0, 0.9, C.concreteDark);
    }
    // bus canopy on posts at the deck edges + glazed waiting room with orange frames
    const yc = y0 + 1.1;
    band(i0, i1, l0 + 1, l1 - 1, yc + 4.6, yc + 5.0, C.roof, true, true);
    for (let i = i0; i <= i1; i += 3) for (const lat of [l0 + 1.3, l1 - 1.3]) box(Q(i, lat, 0), along3(i), 0.35, 0.35, yc, yc + 4.6, C.orange);
    const wr0 = mid - 6, wr1 = mid + 6;
    const iw0 = idx(se + od * 2), iw1 = idx(se + od * 14);
    band(Math.min(iw0, iw1), Math.max(iw0, iw1), wr0, wr1, yc, yc + 3.4, C.glass);
    band(Math.min(iw0, iw1), Math.max(iw0, iw1), wr0 - 0.2, wr1 + 0.2, yc + 3.4, yc + 3.7, C.orange);
  }

  // ------------------------------------------------------------ enclosed walkways (e.g. Yorkdale → mall)
  for (const w of spec.walks ?? []) {
    const [e0, n0] = w.from, [e1, n1] = w.to;
    const L = Math.hypot(e1 - e0, n1 - n0);
    if (L < 4) continue;
    const dx = (e1 - e0) / L, dy = (n1 - n0) / L;
    // deck underside: over the rail and over the ground along the span by the road clearance
    let gmax = -Infinity;
    for (let k = 0; k <= 12; k++) gmax = Math.max(gmax, c.heightAt(e0 + dx * L * (k / 12), n0 + dy * L * (k / 12)));
    const zd = Math.max(zr + SPAN_CLEAR, gmax + 5.3);
    const d3: V3 = [dx, 0, -dy];
    const o = P((e0 + e1) / 2, (n0 + n1) / 2, zd);
    box(o, d3, L, 4.2, 0, 0.7, C.concreteDark);
    box(o, d3, L, 4.0, 0.7, 3.4, C.glass, false);
    box(o, d3, L, 4.4, 3.4, 3.8, kind === 'yorkdale' ? C.stainless : C.roof);
    // stair tower at the far end, from the ground up to the walkway
    const zg = c.heightAt(e1, n1);
    const ot = P(e1 + dx * 3, n1 + dy * 3, zg);
    box(ot, d3, 7, 6.5, -0.3, zd - zg + 3.8, kind === 'yorkdale' ? C.stainless : C.concrete);
    box(ot, d3, 7.02, 3, 0.2, zd - zg + 3.2, C.glassDark, false);
    // the near end joins the station: a short stub down to the concourse / enclosure roof
    const on = P(e0, n0, zd);
    box(on, d3, 5, 5, -Math.max(0, zd - (zr + wallTop)), 3.8, kind === 'yorkdale' ? C.stainless : C.concrete);
  }

  return { cols };

  function halfDome(i: number, sg: 1 | -1, l0: number, l1: number, ys: number, rise: number) {
    // quarter ellipsoid closing the barrel vault (Yorkdale): extends r = half width beyond the end
    const q = S[i];
    const r = (l1 - l0) / 2, lm = (l0 + l1) / 2;
    const tx = q.ny * sg, ty = -q.nx * sg; // outward along-track unit (E, N)
    const nA = 10, nB = 5;
    const pt = (k: number, j: number): V3 => {
      const th = (Math.PI * k) / nA, ph = ((Math.PI / 2) * j) / nB;
      const lat = lm - r * Math.cos(th) * Math.cos(ph);
      const y = ys + rise * Math.sin(th) * Math.cos(ph);
      const ds = r * 0.8 * Math.sin(ph);
      return P(q.e + q.nx * lat + tx * ds, q.n + q.ny * lat + ty * ds, zr + y);
    };
    for (let k = 0; k < nA; k++) for (let j = 0; j < nB; j++) quad2(pt(k, j), pt(k + 1, j), pt(k + 1, j + 1), pt(k, j + 1), C.glass);
    // base wall of the dome (a curved low wall outside the tracks' ends is not needed: the tracks run through)
  }

  function ellipse(o: V3, d: V3, r: V3, rx: number, ry: number, yc: number, col: RGB) {
    const n = 10;
    const ring: V3[] = [];
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      ring.push([o[0] + d[0] * rx * Math.cos(a), o[1] + yc + ry * Math.sin(a), o[2] + d[2] * rx * Math.cos(a)]);
    }
    const cc: V3 = [o[0], o[1] + yc, o[2]];
    for (let k = 0; k < n; k++) {
      const a = ring[k], b = ring[(k + 1) % n];
      g.face(cc, a, b, b, col, r);
    }
  }
}
