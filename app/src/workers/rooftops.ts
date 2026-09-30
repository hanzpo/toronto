// Rooftops (tile worker, called by buildBuildings for flat roofs): parapets
// with copings, mechanical / elevator penthouses and stair bulkheads (baked
// into the building mesh, facade-shaded), roof finishes as flat paint on the
// roof (Toronto Green Roof Bylaw sedum mats on newer buildings, amenity decks
// on condo podiums, ballasted solar rows on low-rise commercial roofs), and
// the instanced rooftop equipment placements (rooftop HVAC units, exhaust
// fans, hatches, plumbing vents, cooling towers, the odd wooden water tank on
// an old loft, patio umbrellas and planters) handed to layers/UrbanLayer.ts.
// Everything is seeded by the building's OSM id, so it's stable across loads.
import { FBuilder, ST, obb, quadFacing, ringArea, wall, type RGB } from './buildings';
import { UK, inRing, pushItem, rnd } from './urban';

export interface RoofIn {
  xy: Float32Array; vertOff: Uint32Array; r0: number; r1: number;
  base: number; roofY: number; H: number; kind: number; style: number; old: boolean; core: boolean;
  h: number; area: number; wc: RGB; seed: number; level: number;
}

const SEDUM = [0x5d7839, 0x6a8a3f, 0x7b8e44, 0x8c7047, 0x4e6a31, 0x75883a];
const DECK_WOOD = [0x8b6c4f, 0x7c5f45, 0x93765a];
const PAVERS = [0x9d988f, 0xa8a399, 0x8f8a82];
const PV: RGB = [34, 44, 70], PV_BACK: RGB = [70, 72, 76];
const hex = (c: number): RGB => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** parapet height (m) for a flat roof, 0 = none (houses, sheds, canopies, overhangs, level ≥ 1) */
export function parapetHeight(R: RoofIn, minH: number): number {
  if (R.level !== 0 || minH > 0.5) return 0;
  if (R.kind === 1 || R.kind === 11 || R.kind === 15 || R.kind === 14) return 0;
  if (R.H < 7 || R.area < 150) return 0;
  const n = R.vertOff[R.r1] - R.vertOff[R.r0];
  if (n > 90) return 0;
  const r = rnd(R.h, 101);
  if (R.H > 45) return 1.1 + r * 0.5;
  if (R.old && (R.style === ST.BRICK || R.style === ST.LOFT || R.style === ST.STONE)) return 0.7 + r * 0.8; // brick parapets, often stepped up at the front
  return 0.5 + r * 0.5;
}

/**
 * Parapet inner faces + caps, penthouse boxes and roof paint into `b`;
 * equipment placements into `items` (tile-local E, N, elevation).
 */
export function roofTop(b: FBuilder, R: RoofIn, par: number, items: number[] | null) {
  const { xy, vertOff, r0, r1, seed, h } = R;
  const top = R.roofY;
  const va = vertOff[r0], vb = vertOff[r0 + 1];

  // ---- parapet: one steep inner face per edge, from the coping (outer wall top) down to the roof
  // 0.3 m in — reads as a parapet with its coping from above and from the street, at 2 triangles an edge
  if (par > 0) {
    const t = 0.3;
    const inner: RGB = [R.wc[0] * 0.8, R.wc[1] * 0.8, R.wc[2] * 0.8];
    for (let rr = r0; rr < r1; rr++) {
      const s = vertOff[rr], e = vertOff[rr + 1];
      const ccw = ringArea(xy, s, e) > 0;
      const flip = rr === r0 ? !ccw : ccw;
      for (let k = s; k < e; k++) {
        const k2 = k + 1 < e ? k + 1 : s;
        let x0 = xy[k * 2], n0 = xy[k * 2 + 1], x1 = xy[k2 * 2], n1 = xy[k2 * 2 + 1];
        if (flip) { [x0, x1] = [x1, x0]; [n0, n1] = [n1, n0]; }
        const dx = x1 - x0, dn = n1 - n0, l = Math.hypot(dx, dn);
        if (l < 0.8) continue;
        const ix = (-dn / l) * t, iy = (dx / l) * t; // inward (left of travel)
        b.h0 = top; b.H = par; b.L = l; b.unit = 0;
        b.code = ST.BLANK + 64 * seed;
        const y = top + par;
        quadFacing(b, [[x0, y, -n0], [x1, y, -n1], [x1 + ix, top, -(n1 + iy)], [x0 + ix, top, -(n0 + iy)]], [-dn / l, 0.35, -dx / l], inner, [0, l, l, 0]);
      }
    }
  }

  // ---- roof frame: OBB (u = long axis)
  const o = obb(xy, va, vb);
  const ang = Math.atan2(o.uy, o.ux);
  const vx = -o.uy, vy = o.ux;
  const Pt = (u: number, v: number): [number, number] => [o.cx + o.ux * u + vx * v, o.cy + o.uy * u + vy * v];
  const onRoof = (x: number, y: number) => {
    if (!inRing(xy, va, vb, x, y)) return false;
    for (let rr = r0 + 1; rr < r1; rr++) if (inRing(xy, vertOff[rr], vertOff[rr + 1], x, y)) return false;
    return true;
  };
  /** rectangle (OBB frame, centre uc,vc, half sizes) fully on the roof with margin m */
  const rectIn = (uc: number, vc: number, hl: number, hw: number, m: number) => {
    for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]]) {
      const [x, y] = Pt(uc + a * (hl + m), vc + c * (hw + m));
      if (!onRoof(x, y)) return false;
    }
    return true;
  };
  const busy: [number, number, number, number][] = []; // OBB-frame rects kept clear of equipment
  const blocked = (u: number, v: number, r: number) => busy.some(([uc, vc, hl, hw]) => Math.abs(u - uc) < hl + r && Math.abs(v - vc) < hw + r);
  const tower = R.H >= 45, mid = R.H >= 14;
  const modern = !R.old || R.style === ST.GLASS || R.style === ST.CONDO || R.style === ST.MODERN;
  const condo = R.style === ST.CONDO || (R.kind === 2 && !R.old) || (R.style === ST.GLASS && R.kind !== 3 && R.kind !== 13);
  const big = R.area > 2500 && R.H < 18;

  // ---- penthouses (level 0 and 1 for towers)
  const box = (uc: number, vc: number, hl: number, hw: number, y0: number, hgt: number, style: number, col: RGB) => {
    const c = [Pt(uc - hl, vc - hw), Pt(uc + hl, vc - hw), Pt(uc + hl, vc + hw), Pt(uc - hl, vc + hw)];
    b.h0 = y0; b.H = hgt; b.unit = 0; b.code = style + 64 * seed;
    for (let k = 0; k < 4; k++) {
      const p = c[k], q = c[(k + 1) % 4];
      b.L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      wall(b, p[0], p[1], q[0], q[1], y0 - 0.3, y0 + hgt, y0 - 0.3, y0 + hgt, col);
    }
    b.code = ST.ROOF + 64 * seed;
    const yt = y0 + hgt;
    quadFacing(b, c.map((p) => [p[0], yt, -p[1]]), [0, 1, 0], [128, 127, 123], [0, 0, 0, 0]);
    busy.push([uc, vc, hl, hw]);
  };
  const penthouse = () => {
    let hl: number, hw: number, ph: number, style: number, col: RGB;
    const gray: RGB = hex([0x8d9092, 0x7c8084, 0x9a9890, 0x6d7174][(rnd(h, 110) * 4) | 0]);
    if (tower) {
      hl = Math.min(30, Math.max(6, o.L * (0.3 + rnd(h, 111) * 0.15)));
      hw = Math.min(20, Math.max(5, o.W * (0.35 + rnd(h, 112) * 0.15)));
      ph = 5 + rnd(h, 113) * 3.5 + (R.H > 120 ? 2 : 0);
      // glass/condo towers often wrap the mechanical floor in the tower's own cladding (a "crown")
      const crown = (R.style === ST.GLASS || R.style === ST.CONDO) && rnd(h, 114) < 0.5;
      style = crown ? R.style : ST.METAL; col = crown ? R.wc : gray;
    } else if (mid) {
      if (rnd(h, 115) > (R.old ? 0.6 : 0.8) || R.area < 220) return;
      hl = Math.min(12, Math.max(3.5, o.L * 0.18)); hw = Math.min(8, Math.max(2.8, o.W * 0.22));
      ph = 3 + rnd(h, 116) * 1.6;
      style = R.old ? ST.BLANK : ST.METAL; col = R.old ? R.wc : gray;
    } else {
      if (R.H < 7 || R.area < 120 || rnd(h, 117) > 0.3 || R.kind === 1) return;
      hl = 2.2; hw = 1.7; ph = 2.6; // stair bulkhead
      style = ST.BLANK; col = R.old ? R.wc : gray;
    }
    const off = (rnd(h, 118) - 0.5) * o.L * 0.3;
    for (const f of [1, 0.75, 0.55]) {
      const uc = off * f;
      if (rectIn(uc, 0, hl * f, hw * f, 0.8)) {
        const fl = hl * f, fw = hw * f;
        box(uc, 0, fl, fw, top, ph, style, col);
        // towers: a smaller elevator overrun / BMU housing on top
        if (tower && rnd(h, 119) < 0.45) box(uc + fl * 0.3 * (rnd(h, 120) < 0.5 ? 1 : -1), 0, fl * 0.45, fw * 0.6, top + ph, 2.5 + rnd(h, 121) * 1.5, style, col);
        return;
      }
    }
  };
  if (R.level === 0 || (tower && R.level === 1)) penthouse();
  if (R.level !== 0 || !items) return;

  // ---- roof paint: green roof, amenity deck or solar rows (one programme per roof)
  const paintQuad = (P4: [number, number][], y: number, col: RGB) => {
    b.code = ST.ROOF + 64 * seed; b.h0 = top; b.H = 999;
    quadFacing(b, P4.map((p) => [p[0], y, -p[1]]), [0, 1, 0], col, [0, 0, 0, 0]);
  };
  const rectPts = (uc: number, vc: number, hl: number, hw: number) => [Pt(uc - hl, vc - hw), Pt(uc + hl, vc - hw), Pt(uc + hl, vc + hw), Pt(uc - hl, vc + hw)];
  const fitRect = (uc: number, vc: number, hl: number, hw: number, m: number): [number, number, number, number] | null => {
    for (const f of [1, 0.8, 0.62, 0.48]) if (rectIn(uc * f, vc * f, hl * f, hw * f, m)) return [uc * f, vc * f, hl * f, hw * f];
    return null;
  };
  const rp = rnd(h, 130);
  const inset = par > 0 ? 1.0 : 0.6;
  let program: 'green' | 'deck' | 'solar' | 'none' = 'none';
  if (R.area > 250 && condo && R.H < 70 && rp < 0.34) program = 'deck';
  else if (R.area > 350 && modern && !big && rp < (condo ? 0.62 : 0.3)) program = 'green';
  else if ((big || R.kind === 5 || R.kind === 4) && R.area > 800 && rp < 0.18) program = 'solar';
  else if (!R.old && R.H < 12 && R.area > 90 && R.area < 450 && rp < 0.05) program = 'solar';
  if (program === 'green') {
    const cov = 0.55 + rnd(h, 131) * 0.35;
    const r = fitRect((rnd(h, 132) - 0.5) * o.L * (1 - cov) * 0.5, 0, (o.L / 2 - inset) * cov, (o.W / 2 - inset) * Math.min(1, cov + 0.2), 0.2);
    if (r) {
      const [uc, vc, hl, hw] = r;
      const nu = Math.min(4, Math.max(1, Math.round(hl / 4))), nv = Math.min(4, Math.max(1, Math.round(hw / 4)));
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const u0 = uc - hl + (2 * hl * i) / nu, u1 = uc - hl + (2 * hl * (i + 1)) / nu;
        const v0 = vc - hw + (2 * hw * j) / nv, v1 = vc - hw + (2 * hw * (j + 1)) / nv;
        const c = hex(SEDUM[(rnd(h, 140 + i, j) * SEDUM.length) | 0]);
        paintQuad([Pt(u0, v0), Pt(u1, v0), Pt(u1, v1), Pt(u0, v1)], top + 0.07, c);
      }
      // walkway strip left clear down the middle (maintenance path)
      busy.push([uc, vc, hl, hw]);
    }
  } else if (program === 'deck') {
    const end = rnd(h, 133) < 0.5 ? 1 : -1;
    const hl0 = Math.min(o.L * 0.25, 14), hw0 = o.W / 2 - inset;
    const r = fitRect(end * (o.L / 2 - inset - hl0), 0, hl0, hw0, 0.2);
    if (r) {
      const [uc, vc, hl, hw] = r;
      const wood = rnd(h, 134) < 0.55;
      const c = hex((wood ? DECK_WOOD : PAVERS)[(rnd(h, 135) * 3) | 0]);
      paintQuad(rectPts(uc, vc, hl, hw), top + 0.09, c);
      busy.push([uc, vc, hl, hw]);
      // umbrellas + planters on the deck
      const nU = Math.min(5, Math.max(1, Math.floor((hl * hw * 4) / 45)));
      const colU = (rnd(h, 136) * 6) | 0;
      for (let q = 0; q < nU; q++) {
        const u = uc + (nU === 1 ? 0 : -hl * 0.6 + (1.2 * hl * q) / (nU - 1)), v = vc + (rnd(h, 137 + q) - 0.5) * hw * 0.8;
        const [x, y] = Pt(u, v);
        pushItem(items, UK.UMBRELLA, x, y, top + 0.09, ang + rnd(h, 150 + q), 1, 1, 1, rnd(h, 160) < 0.7 ? colU : (colU + q) % 6);
      }
      const nP = Math.min(8, Math.max(2, Math.round(hl / 2.5)));
      for (let q = 0; q < nP; q++) {
        const u = uc - hl + 0.7 + ((2 * hl - 1.4) * q) / Math.max(1, nP - 1);
        for (const sgn of [-1, 1]) {
          if (rnd(h, 170 + q, sgn) < 0.35) continue;
          const [x, y] = Pt(u, vc + sgn * (hw - 0.6));
          pushItem(items, UK.PLANTER, x, y, top + 0.09, ang, 1, 1, 1, 0);
        }
      }
    }
  } else if (program === 'solar') {
    // rows face south: tilt axis along the OBB axis closest to E-W
    const uS = -o.uy, vS = -vy; // south component of u and v (dot with (0,-1))
    const alongU = Math.abs(vS) > Math.abs(uS); // rows run along u when v points most south
    const sgn = alongU ? (vS > 0 ? 1 : -1) : (uS > 0 ? 1 : -1); // +1: the + direction is south
    const cov = 0.6 + rnd(h, 138) * 0.25;
    const r = fitRect(0, 0, (o.L / 2 - inset - 0.8) * cov, (o.W / 2 - inset - 0.8) * cov, 0.2);
    if (r) {
      const [uc, vc, hl, hw] = r;
      const pitch = 2.3, depth = 1.55, rise = depth * Math.sin(0.2), run = depth * Math.cos(0.2);
      const acrossHalf = alongU ? hw : hl, alongHalf = alongU ? hl : hw;
      const nRows = Math.min(60, Math.floor((2 * acrossHalf) / pitch));
      for (let q = 0; q < nRows; q++) {
        const a0 = -acrossHalf + pitch * q + pitch - 0.2; // south edge (in the across axis, + = south when sgn>0)
        const s0 = sgn * a0, s1 = sgn * (a0 - run);
        const P2 = (al: number, ac: number) => (alongU ? Pt(uc + al, vc + ac) : Pt(uc + ac, vc + al));
        const A = P2(-alongHalf, s0), B = P2(alongHalf, s0), C = P2(alongHalf, s1), D = P2(-alongHalf, s1);
        const y0 = top + 0.25, y1 = top + 0.25 + rise;
        b.code = ST.ROOF + 64 * seed; b.h0 = top; b.H = 999;
        quadFacing(b, [[A[0], y0, -A[1]], [B[0], y0, -B[1]], [C[0], y1, -C[1]], [D[0], y1, -D[1]]], [0, 1, 0], PV, [0, 0, 0, 0]);
        quadFacing(b, [[A[0], y0 - 0.02, -A[1]], [B[0], y0 - 0.02, -B[1]], [C[0], y1 - 0.02, -C[1]], [D[0], y1 - 0.02, -D[1]]], [0, -1, 0], PV_BACK, [0, 0, 0, 0]);
      }
      busy.push([uc, vc, hl, hw]);
    }
  }

  // ---- equipment
  type Pick = { k: number; r: number; sx?: number; sy?: number; sz?: number; v?: number };
  const want: Pick[] = [];
  const A = R.area;
  const add = (n: number, p: Pick) => { for (let i = 0; i < n; i++) want.push({ ...p, v: p.v ?? ((rnd(h, 180 + want.length) * 4) | 0) }); };
  const rtuBig = (i: number) => rnd(h, 190 + i) < (big ? 0.5 : 0.25);
  if (big || R.kind === 4 || R.kind === 5) {
    // big boxes / plazas / warehouses: rooftop units in rows, exhaust fans, a hatch
    const n = Math.min(30, Math.max(2, Math.round(A / 380)));
    for (let i = 0; i < n; i++) want.push(rtuBig(i) ? { k: UK.RTU, r: 2.4, sx: 1.8, sy: 1.35, sz: 1.5 } : { k: UK.RTU, r: 1.5 });
    add(Math.min(14, Math.round(A / 700)), { k: UK.FAN, r: 0.6 });
    add(1, { k: UK.HATCH, r: 0.8 });
    add(Math.min(6, Math.round(A / 900)), { k: UK.VENT, r: 0.4 });
  } else if (R.kind === 3 || R.kind === 13 || R.kind === 6 || R.kind === 7 || R.kind === 10 || R.style === ST.RIBBON || (R.style === ST.GLASS && !condo)) {
    if (tower && rnd(h, 191) < 0.6) add(1 + (A > 1500 ? 1 : 0), { k: UK.COOLING, r: 3.2 });
    add(Math.min(12, Math.max(1, Math.round(A / 320))), { k: UK.RTU, r: 1.5 });
    add(Math.min(8, Math.round(A / 450)), { k: UK.FAN, r: 0.6 });
    add(1, { k: UK.HATCH, r: 0.8 });
    add(Math.min(4, Math.round(A / 600)), { k: UK.VENT, r: 0.4 });
  } else if (R.kind !== 1 && R.kind !== 11 && R.kind !== 14 && R.kind !== 15) {
    // apartments, condos, old main-street buildings
    add(Math.min(5, Math.round(A / 500) + (mid ? 1 : 0)), { k: UK.RTU, r: 1.5 });
    add(Math.min(8, Math.max(1, Math.round(A / 220))), { k: UK.FAN, r: 0.6 });
    add(Math.min(6, Math.max(1, Math.round(A / 160))), { k: UK.VENT, r: 0.4 });
    if (!mid || R.old) add(1, { k: UK.HATCH, r: 0.8 });
    // a wooden water tank on an old brick loft (rare in Toronto — a handful survive)
    if (R.old && (R.style === ST.LOFT || R.style === ST.BRICK) && R.H >= 13 && R.H <= 34 && A > 400 && rnd(h, 192) < 0.035) want.unshift({ k: UK.WATERTANK, r: 3, v: (rnd(h, 193) * 2) | 0 });
  }
  if (!want.length) return;
  // candidate cells over the OBB, visited in a hashed order
  const sp = 4.2;
  const nu = Math.max(1, Math.floor((o.L - 2 * inset) / sp)), nv = Math.max(1, Math.floor((o.W - 2 * inset) / sp));
  if (nu * nv > 900) return;
  const cells: number[] = [];
  for (let i = 0; i < nu * nv; i++) cells.push(i);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rnd(h, 200, i) * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  let wi = 0;
  const taken: [number, number, number][] = [];
  for (const c of cells) {
    if (wi >= want.length) break;
    const i = c % nu, j = Math.floor(c / nu);
    const w = want[wi];
    const u = -o.L / 2 + inset + sp * (i + 0.5) + (rnd(h, 210, c) - 0.5) * 1.2;
    const v = -o.W / 2 + inset + sp * (j + 0.5) + (rnd(h, 211, c) - 0.5) * 1.2;
    if (blocked(u, v, w.r + 0.6)) continue;
    if (taken.some(([tu, tv, tr]) => Math.hypot(tu - u, tv - v) < tr + w.r + 0.5)) continue;
    const [x, y] = Pt(u, v);
    const m = w.r + (par > 0 ? 0.5 : 0.3);
    if (!onRoof(x, y) || !rectIn(u, v, m * 0.7, m * 0.7, 0)) continue;
    const a = ang + (rnd(h, 212, c) < 0.5 ? 0 : Math.PI / 2) + (w.k === UK.FAN || w.k === UK.VENT ? rnd(h, 213, c) * 3 : 0);
    pushItem(items, w.k, x, y, top, a, w.sx ?? 1, w.sy ?? 1, w.sz ?? 1, w.v ?? 0);
    taken.push([u, v, w.r]);
    wi++;
  }
}

/** chimneys on the ridge and dormers on the slopes of old pitched (extruded) roofs */
export function pitchedDetail(items: number[], cx: number, cy: number, ux: number, uy: number, hl: number, hw: number, eave: number, top: number,
  roofType: number, inset: number, h: number, old: boolean, kind: number, area: number) {
  const vx = -uy, vy = ux;
  const ang = Math.atan2(uy, ux);
  if (old && (kind === 0 || kind === 1 || kind === 2 || kind === 4) && area < 600 && rnd(h, 300) < 0.65) {
    const ridgeHalf = Math.max(0.5, hl - inset);
    const s = (rnd(h, 301) < 0.5 ? 1 : -1) * ridgeHalf * (0.55 + rnd(h, 302) * 0.3);
    pushItem(items, UK.CHIMNEY, cx + ux * s, cy + uy * s, top - 1.3, ang, 1, 1, 1, 0);
  }
  if (roofType === 1 && old && hl > 4.5 && hw > 3 && (top - eave) > 2.2 && rnd(h, 303) < 0.35) {
    const n = hl > 8 ? 2 : 1;
    for (const side of [1, -1]) {
      if (side < 0 && rnd(h, 304) < 0.5) continue;
      for (let q = 0; q < n; q++) {
        const s = n === 1 ? 0 : (q === 0 ? -hl * 0.4 : hl * 0.4);
        const t = 0.5; // half way up the slope
        const x = cx + ux * s + vx * side * hw * t, y = cy + uy * s + vy * side * hw * t;
        const z = eave + (top - eave) * (1 - t);
        pushItem(items, UK.DORMER, x, y, z, Math.atan2(vy * side, vx * side), 1, (top - eave) / 3.5, 1, 0);
      }
    }
  }
}
