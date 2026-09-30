// Simplified airline liveries (references: app/src/models/AIRCRAFT_REFERENCE.md §Liveries).
//
// A livery is six colours + a few shader-painted fuselage features:
//   fuse / belly  upper fuselage and belly colour, split at `bellyLine`
//                 (vn = height on the local cross-section, −1 keel … +1 crown)
//   cheat         optional cheatline band (centre vn, half width, colour `stripe`)
//   wrap          rear-fuselage wrap: from station u (0 nose … 1 tail) along a
//                 diagonal the fuselage takes colour `stripe` (WestJet teal,
//                 Rouge red, Sunwing orange …); `wrapBand` adds a band of the
//                 tail colour along that boundary, `wrapRev` leans it forward
//   tail          fin base colour; tail art (Canvas2D logo) drawn on top
//   accent        winglet / accent colour, engine = nacelles
// Tail art is drawn once into a 1024² atlas (8 × 8 cells). Cell space: x → aft,
// y ↓ (left-side view, nose to the left), centred on the fin's centroid; the
// fin spans roughly 0.1…0.9 of the cell.
import * as THREE from 'three/webgpu';

export interface Livery {
  fuse: number; belly: number; tail: number; accent: number; engine: number; stripe: number;
  bellyLine: number; cheatY: number; cheatW: number;
  wrap: number; wrapBand: boolean; wrapRev: boolean;
  /** tail-art atlas cell, −1 = none */
  art: number;
}

const W = 0xf4f5f6;
type Art = (c: CanvasRenderingContext2D) => void;

interface Def extends Partial<Omit<Livery, 'art'>> { tail: number; art?: Art }
const DEFAULTS: Omit<Livery, 'tail' | 'art'> = {
  fuse: W, belly: W, accent: W, engine: 0xd6d9dd, stripe: W,
  bellyLine: -9, cheatY: 0, cheatW: 0, wrap: 9, wrapBand: false, wrapRev: false,
};

// ------------------------------------------------------------------ drawing helpers (cell = 128 px)

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const fill = (c: CanvasRenderingContext2D, col: number | string) => { c.fillStyle = typeof col === 'number' ? hex(col) : col; };
function disc(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: number | string) {
  fill(c, col); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
}
function ring(c: CanvasRenderingContext2D, x: number, y: number, r: number, w: number, col: number | string) {
  c.strokeStyle = typeof col === 'number' ? hex(col) : col; c.lineWidth = w; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
}
function polyF(c: CanvasRenderingContext2D, pts: number[], col: number | string) {
  fill(c, col); c.beginPath(); c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath(); c.fill();
}
function star(c: CanvasRenderingContext2D, x: number, y: number, r: number, n: number, inner: number, col: number | string, rot = -Math.PI / 2, twist = 0) {
  const p: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n + (i % 2 ? twist : 0);
    const rr = i % 2 ? r * inner : r;
    p.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  polyF(c, p, col);
}
/** whole-cell background */
function bg(c: CanvasRenderingContext2D, col: number | string) { fill(c, col); c.fillRect(0, 0, 128, 128); }

// Canadian-flag maple leaf (Wikimedia Commons "Flag of Canada" path, 1/1000 units, centred ~ (0, −0.1))
const LEAF = new Path2D(
  'm-90 2030 45-863a95 95 0 0 0-111-98l-859 151 116-320a65 65 0 0 0-20-73l-941-762 212-99a65 65 0 0 0 34-79l-186-572 542 115a65 65 0 0 0 73-38l105-247 423 454a65 65 0 0 0 111-57l-204-1052 327 189a65 65 0 0 0 91-27l332-652 332 652a65 65 0 0 0 91 27l327-189-204 1052a65 65 0 0 0 111 57l423-454 105 247a65 65 0 0 0 73 38l542-115-186 572a65 65 0 0 0 34 79l212 99-941 762a65 65 0 0 0-20 73l116 320-859-151a95 95 0 0 0-111 98l45 863z',
);
/** maple leaf of width `w` centred at (x, y) */
function leaf(c: CanvasRenderingContext2D, x: number, y: number, w: number, col: number | string) {
  c.save(); c.translate(x, y); const s = w / 4100; c.scale(s, s); c.translate(0, 180); fill(c, col); c.fill(LEAF); c.restore();
}
/** simple flying bird (crane / goose): body + two raised wings */
function bird(c: CanvasRenderingContext2D, x: number, y: number, s: number, col: number | string) {
  polyF(c, [x - s * 0.9, y - s * 0.5, x - s * 0.1, y + s * 0.05, x + s * 0.8, y + s * 0.45, x + s * 0.7, y + s * 0.55, x - s * 0.15, y + s * 0.2], col);
  polyF(c, [x - s * 0.2, y + 0.05 * s, x - s * 0.05, y - s * 0.9, x + s * 0.25, y - s * 0.75, x + s * 0.15, y + s * 0.2], col);
  polyF(c, [x + s * 0.1, y + 0.1 * s, x + s * 0.5, y - s * 0.55, x + s * 0.7, y - s * 0.4, x + s * 0.35, y + s * 0.3], col);
}
/** stripes parallel to a swept leading edge (angle a from vertical) */
function sweptBands(c: CanvasRenderingContext2D, bands: [number, number, number][], a = 0.65) {
  // bands: [x0 at the root (y = 128), width, colour]
  for (const [x0, w, col] of bands) {
    const dx = Math.tan(a) * 128;
    polyF(c, [x0, 128, x0 + w, 128, x0 + w - dx, 0, x0 - dx, 0], col);
  }
}

// ------------------------------------------------------------------ liveries

const AC_BLACK = 0x17181a, AC_RED = 0xe31837;
const acArt: Art = (c) => {
  ring(c, 70, 62, 22, 3.6, AC_RED);
  leaf(c, 70, 61, 30, AC_RED);
};
const UA: Def = {
  belly: 0x1a4fa0, bellyLine: -0.34, tail: 0x0a2a5e, engine: 0x0a2a5e, accent: 0x0a2a5e,
  art: (c) => {
    disc(c, 72, 66, 24, 0xcfdff2);
    c.strokeStyle = hex(0x0a2a5e); c.lineWidth = 2.4;
    for (let i = -2; i <= 2; i++) { c.beginPath(); c.ellipse(72, 66 + i * 8.5, 24 * Math.cos((i * 8.5) / 26), 3.5, 0, 0, Math.PI * 2); c.stroke(); }
    c.beginPath(); c.ellipse(72, 66, 10, 24, 0, 0, Math.PI * 2); c.stroke();
  },
};
const DL: Def = {
  belly: 0x0b2a5a, bellyLine: -0.4, tail: 0xe01933, engine: 0x0b2a5a, accent: 0x0b2a5a,
  art: (c) => polyF(c, [30, 0, 128, 0, 128, 128, 96, 128], 0x9b1631),
};
const AA: Def = {
  fuse: 0xb9c0c6, belly: 0xb9c0c6, tail: 0x36495a, engine: 0xb4bac0, accent: 0x36495a,
  art: (c) => sweptBands(c, [[70, 7, 0xc8102e], [77, 5, W], [82, 7, 0xc8102e], [89, 5, W], [94, 7, 0xc8102e], [101, 5, W], [106, 30, 0xc8102e]]),
};

const DEFS: Record<string, Def> = {
  // ---- Canadian carriers
  ACA: { belly: AC_BLACK, bellyLine: -0.62, tail: AC_BLACK, engine: AC_BLACK, accent: AC_BLACK, art: acArt },
  JZA: { belly: AC_BLACK, bellyLine: -0.72, tail: AC_BLACK, engine: 0xf2f3f4, accent: AC_BLACK, art: acArt },
  ROU: {
    tail: W, engine: 0xd8262e, accent: 0xd8262e, stripe: 0xd8262e, wrap: 0.66,
    art: (c) => { leaf(c, 88, 70, 92, 0xd8262e); fill(c, hex(0xd8262e)); c.fillRect(0, 0, 128, 17); },
  },
  WJA: {
    tail: 0x003c71, engine: W, accent: 0x003c71, stripe: 0x00aaa6, wrap: 0.64, wrapBand: true,
    art: (c) => {
      polyF(c, [0, 128, 58, 128, 20, 70, 0, 70], 0x00aaa6);
      const x = 72, y = 60;
      polyF(c, [x, y, x - 13, y - 27, x - 4, y - 4], W); polyF(c, [x, y, x + 12, y + 25, x + 3, y + 4], W);
      polyF(c, [x, y, x + 20, y - 8, x + 3, y - 3], W); polyF(c, [x, y, x - 18, y + 8, x - 3, y + 3], W);
    },
  },
  POE: {
    fuse: 0xf4f3ef, belly: 0xf4f3ef, tail: 0x042444, engine: 0xf4f3ef, accent: 0xf4f3ef,
    art: (c) => {
      // rows of the lowercase "porter" wordmark, tilted up towards the trailing edge
      c.save(); c.translate(64, 64); c.rotate(-0.49); fill(c, 'rgba(150,168,200,0.6)');
      c.font = '600 11px system-ui, sans-serif'; c.textBaseline = 'middle';
      for (let r = -7; r <= 7; r++) for (let k = -3; k <= 3; k++) c.fillText('porter', k * 36 + (r % 2) * 18 - 18, r * 11);
      c.restore();
    },
  },
  FLE: { tail: 0x141c2c, engine: W, accent: W, art: (c) => { c.beginPath(); c.arc(88, 118, 30, Math.PI, 0); c.closePath(); fill(c, 0x3cc84a); c.fill(); } },
  TSC: {
    tail: 0x005eba, engine: W, accent: 0x1473c8, stripe: 0x3d9ad8, wrap: 0.68, wrapRev: true,
    art: (c) => { const g = c.createLinearGradient(0, 128, 0, 0); g.addColorStop(0, '#005eba'); g.addColorStop(1, '#22a7e8'); fill(c, g as unknown as string); c.fillStyle = g; c.fillRect(0, 0, 128, 128); star(c, 70, 64, 24, 5, 0.42, W, -Math.PI / 2, 0.18); },
  },
  SWG: {
    tail: 0xff5a1e, engine: 0xff5a1e, accent: 0xff5a1e, stripe: 0xff5a1e, wrap: 0.8,
    art: (c) => { disc(c, 70, 62, 9, W); for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; polyF(c, [70 + Math.cos(a) * 12, 62 + Math.sin(a) * 12, 70 + Math.cos(a + 0.2) * 21, 62 + Math.sin(a + 0.2) * 21, 70 + Math.cos(a - 0.15) * 20, 62 + Math.sin(a - 0.15) * 20], W); } },
  },
  CJT: {
    tail: 0x111214, engine: W, accent: 0xd7262d, stripe: 0xd7262d, cheatY: -0.38, cheatW: 0.035,
    art: (c) => {
      fill(c, '#9aa3ab'); for (let i = 0; i < 4; i++) c.fillRect(22, 52 + i * 6, 34, 2.2);
      disc(c, 80, 62, 16, 0xcfe3f4); ring(c, 80, 62, 16, 1.5, 0x2a3d57);
      c.strokeStyle = hex(0x2a3d57); c.lineWidth = 1.3; c.beginPath(); c.ellipse(80, 62, 7, 16, 0, 0, Math.PI * 2); c.moveTo(64, 62); c.lineTo(96, 62); c.stroke();
      leaf(c, 70, 62, 26, W); leaf(c, 70, 62, 23, 0xd7262d);
    },
  },
  // ---- US
  UAL: UA, SKW: UA,
  DAL: DL, EDV: DL,
  AAL: AA, EGF: AA, JIA: AA, RPA: AA,
  FDX: { belly: 0x8c8f94, bellyLine: -0.2, tail: 0x4d148c, engine: 0xc9ccd0, accent: 0x4d148c, art: (c) => { fill(c, W); c.fillRect(46, 52, 24, 16); fill(c, '#ff6200'); c.fillRect(72, 52, 22, 16); } },
  UPS: {
    belly: 0x351c15, bellyLine: -0.25, tail: 0x351c15, engine: 0xe9e7e2, accent: 0x351c15,
    art: (c) => { fill(c, '#ffb500'); c.beginPath(); c.moveTo(56, 50); c.quadraticCurveTo(72, 38, 90, 50); c.lineTo(90, 70); c.quadraticCurveTo(73, 90, 56, 70); c.closePath(); c.fill(); },
  },
  // ---- Europe
  BAW: {
    belly: 0x1e2a55, bellyLine: -0.2, tail: W, engine: 0x1e2a55, accent: W,
    art: (c) => {
      const band = (y: number, h: number, col: number) => { fill(c, col); c.beginPath(); c.moveTo(0, y); for (let x = 0; x <= 128; x += 8) c.lineTo(x, y - x * 0.25 + Math.sin(x / 18) * 5); for (let x = 128; x >= 0; x -= 8) c.lineTo(x, y + h - x * 0.25 + Math.sin(x / 18) * 5); c.closePath(); c.fill(); };
      band(38, 11, 0xeb2226); band(56, 13, 0x1e2a55); band(76, 9, 0xeb2226); band(92, 12, 0x1e2a55);
    },
  },
  DLH: { tail: 0x05164d, engine: 0x05164d, accent: 0x05164d, art: (c) => { ring(c, 70, 64, 24, 2.5, W); bird(c, 70, 66, 17, W); } },
  AFR: { tail: W, engine: 0xd0d3d6, accent: W, art: (c) => { c.save(); c.translate(64, 64); c.rotate(-0.62); fill(c, '#002157'); c.fillRect(-60, 26, 150, 12); fill(c, '#e4002b'); c.fillRect(-20, 8, 110, 7); fill(c, '#002157'); c.fillRect(10, -4, 80, 4); c.restore(); } },
  KLM: {
    fuse: 0x00a1de, belly: W, bellyLine: -0.2, tail: 0x00a1de, engine: 0xc9d4dc, accent: 0x00a1de, stripe: 0x003145, cheatY: -0.2, cheatW: 0.03,
    art: (c) => { polyF(c, [54, 70, 88, 70, 92, 58, 81, 64, 71, 54, 61, 64, 50, 58], W); for (let i = 0; i < 4; i++) disc(c, 57 + i * 9.5, 48, 2.6, W); },
  },
  SWR: { tail: 0xd52b1e, engine: W, accent: 0xd52b1e, art: (c) => { fill(c, W); c.fillRect(64, 44, 12, 38); c.fillRect(51, 57, 38, 12); } },
  LOT: { tail: 0x11397e, engine: W, accent: 0x11397e, art: (c) => { ring(c, 70, 64, 22, 2.2, W); bird(c, 70, 66, 15, W); } },
  THY: { tail: 0xc70a0c, engine: W, accent: 0xc70a0c, art: (c) => { disc(c, 70, 64, 24, W); bird(c, 70, 66, 16, 0xc70a0c); } },
  ITY: { fuse: 0x1e3f95, belly: 0x1e3f95, tail: 0x1e3f95, engine: W, accent: 0x1e3f95, art: (c) => { fill(c, '#009246'); c.fillRect(96, 0, 8, 128); fill(c, W); c.fillRect(104, 0, 8, 128); fill(c, '#ce2b37'); c.fillRect(112, 0, 16, 128); } },
  NOS: {
    tail: 0x10287a, engine: 0x9cc7ec, accent: 0x10287a, stripe: 0x10287a, wrap: 0.72,
    art: (c) => { c.strokeStyle = '#8fc6ea'; c.lineWidth = 4; c.beginPath(); c.moveTo(90, 118); c.bezierCurveTo(80, 70, 60, 40, 70, 28); c.bezierCurveTo(76, 20, 88, 28, 80, 38); c.stroke(); },
  },
  CFG: { tail: 0xffc72c, engine: W, accent: 0xffc72c, art: (c) => { fill(c, W); for (let x = 8; x < 128; x += 22) c.fillRect(x, 0, 10, 128); } },
  ICE: { tail: 0x002f6c, engine: 0x002f6c, accent: 0x002f6c, art: (c) => { c.strokeStyle = '#f5b335'; c.lineWidth = 5; c.beginPath(); c.moveTo(40, 88); c.bezierCurveTo(60, 40, 90, 80, 100, 38); c.stroke(); } },
  TAP: { tail: W, engine: 0xc9ccd0, accent: W, art: (c) => { fill(c, '#00843d'); c.beginPath(); c.arc(64, 150, 70, Math.PI * 1.15, Math.PI * 1.85); c.lineTo(64, 150); c.fill(); fill(c, '#d71921'); c.beginPath(); c.moveTo(50, 60); c.quadraticCurveTo(80, 30, 110, 44); c.quadraticCurveTo(80, 44, 56, 70); c.fill(); } },
  DWI: { tail: 0x043b7b, engine: W, accent: 0x043b7b, art: (c) => { fill(c, '#3f8dcc'); c.fillRect(0, 0, 128, 40); fill(c, '#042454'); c.fillRect(0, 88, 128, 40); disc(c, 76, 60, 7, 0xfccc04); } },
  // ---- Middle East / Asia / Africa
  UAE: { tail: W, engine: W, accent: W, art: (c) => { fill(c, '#d71a21'); c.fillRect(0, 0, 40, 128); fill(c, '#00843d'); c.fillRect(40, 28, 88, 14); fill(c, '#111'); c.fillRect(40, 58, 88, 14); } },
  ETD: { fuse: 0xe7dfd0, belly: 0xe7dfd0, tail: 0xb99659, engine: 0xb99659, accent: 0xb99659, art: (c) => { polyF(c, [20, 128, 80, 40, 128, 90, 128, 128], 0x8a6d3f); polyF(c, [40, 20, 100, 10, 80, 60], 0xd8c29a); } },
  ETH: { tail: W, engine: W, accent: W, art: (c) => { polyF(c, [30, 120, 60, 30, 72, 34, 50, 120], 0x078930); polyF(c, [52, 120, 76, 38, 88, 42, 72, 120], 0xfcdd09); polyF(c, [74, 120, 94, 46, 106, 50, 94, 120], 0xda121a); } },
  AIC: { belly: 0xda0e29, bellyLine: -0.4, tail: 0x5a1f5c, engine: 0xda0e29, accent: 0xda0e29, art: (c) => { fill(c, '#da0e29'); c.fillRect(80, 0, 48, 128); c.strokeStyle = '#c5a15a'; c.lineWidth = 4; c.beginPath(); c.moveTo(48, 110); c.lineTo(48, 60); c.quadraticCurveTo(66, 30, 70, 20); c.quadraticCurveTo(74, 30, 92, 60); c.lineTo(92, 110); c.stroke(); } },
  PIA: { tail: 0x01411c, engine: W, accent: 0x01411c, art: (c) => { fill(c, W); c.fillRect(0, 0, 44, 128); disc(c, 80, 64, 18, W); disc(c, 86, 60, 15, 0x01411c); star(c, 90, 56, 7, 5, 0.42, W); } },
  CPA: { tail: 0x006564, engine: W, accent: 0x006564, stripe: 0x5b6770, cheatY: -0.05, cheatW: 0.03, art: (c) => { fill(c, W); c.beginPath(); c.moveTo(48, 70); c.quadraticCurveTo(70, 44, 96, 44); c.quadraticCurveTo(76, 54, 66, 72); c.quadraticCurveTo(80, 70, 92, 80); c.quadraticCurveTo(66, 84, 48, 70); c.fill(); } },
  EVA: { belly: 0x00674c, bellyLine: -0.3, tail: 0x00674c, engine: W, accent: 0x00674c, stripe: 0xf28c28, cheatY: -0.3, cheatW: 0.025, art: (c) => { disc(c, 70, 62, 17, 0xf28c28); ring(c, 70, 62, 17, 2, W); } },
  CAL: { tail: W, engine: W, accent: W, art: (c) => { for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 - Math.PI / 2; disc(c, 70 + Math.cos(a) * 11, 62 + Math.sin(a) * 11, 10, 0xd6336c); } disc(c, 70, 62, 5, 0xf7c6d6); } },
  KAL: { fuse: 0xa9d2ee, belly: 0xc9ced3, bellyLine: -0.3, tail: W, engine: 0xa9d2ee, accent: 0x0065b3, art: (c) => { disc(c, 70, 64, 20, 0x0065b3); c.beginPath(); c.arc(70, 64, 20, Math.PI, 0); c.fillStyle = '#d7263d'; c.fill(); disc(c, 60, 64, 10, 0xd7263d); disc(c, 80, 64, 10, 0x0065b3); } },
  CSN: { tail: 0x1c78b9, engine: W, accent: 0x1c78b9, art: (c) => { for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; c.save(); c.translate(70, 62); c.rotate(a); fill(c, '#d52b1e'); c.beginPath(); c.ellipse(0, -11, 5, 11, 0, 0, Math.PI * 2); c.fill(); c.restore(); } } },
  PAL: { tail: W, engine: W, accent: W, art: (c) => { fill(c, '#0038a8'); c.beginPath(); c.moveTo(0, 30); c.quadraticCurveTo(64, 10, 128, 40); c.lineTo(128, 64); c.quadraticCurveTo(64, 40, 0, 56); c.fill(); fill(c, '#ce1126'); c.beginPath(); c.moveTo(0, 70); c.quadraticCurveTo(64, 50, 128, 80); c.lineTo(128, 104); c.quadraticCurveTo(64, 80, 0, 96); c.fill(); star(c, 40, 100, 12, 8, 0.45, 0xfcd116); } },
  ELY: { tail: 0x0b2a4f, engine: W, accent: 0x0b2a4f, stripe: 0x0b2a4f, cheatY: -0.4, cheatW: 0.02, art: (c) => { star(c, 70, 64, 18, 6, 0.58, W); } },
  // ---- Americas / other
  AMX: { belly: 0xc0c6cc, bellyLine: -0.45, tail: 0x0b2240, engine: 0xc0c6cc, accent: 0x0b2240, art: (c) => { polyF(c, [60, 84, 58, 58, 66, 40, 84, 36, 96, 48, 86, 54, 88, 70, 78, 84], W); } },
  CMP: { tail: 0x0032a0, engine: W, accent: 0x0032a0, art: (c) => { ring(c, 70, 64, 18, 3, 0xc9a227); c.strokeStyle = '#c9a227'; c.lineWidth = 2; c.beginPath(); c.ellipse(70, 64, 8, 18, 0, 0, Math.PI * 2); c.moveTo(52, 64); c.lineTo(88, 64); c.stroke(); } },
  BWA: { tail: W, engine: W, accent: W, art: (c) => { const g = c.createLinearGradient(0, 128, 128, 0); g.addColorStop(0, '#c8102e'); g.addColorStop(1, '#f6a33f'); c.fillStyle = g; c.beginPath(); c.moveTo(0, 128); c.quadraticCurveTo(60, 60, 128, 20); c.lineTo(128, 128); c.fill(); } },
  AVA: { tail: 0xda291c, engine: 0xda291c, accent: 0xda291c, stripe: 0xda291c, wrap: 0.74, art: (c) => polyF(c, [0, 128, 30, 128, 6, 60, 0, 60], 0xf6a33f) },
  RZO: { tail: W, engine: W, accent: 0x274f9a, art: (c) => { for (let i = 0; i < 7; i++) disc(c, 60 + (i % 3) * 10, 50 + Math.floor(i / 3) * 10, 7, i % 2 ? 0x6b5fc7 : 0x2a9bd5); } },
  BWA2: { tail: W },
};

// ------------------------------------------------------------------ table + atlas

const ORDER = Object.keys(DEFS);
const ART_INDEX = new Map<string, number>();
{
  let k = 0;
  for (const code of ORDER) if (DEFS[code].art) ART_INDEX.set(code, k++);
}
const cacheLiv = new Map<string, Livery>();

export function liveryOf(airline: string): Livery {
  let l = cacheLiv.get(airline);
  if (l) return l;
  const d = DEFS[airline];
  if (d) {
    const { art: _a, ...rest } = d;
    void _a;
    // shared defs (UAL / SKW) reuse the first code's art cell
    const artCode = ORDER.find((c) => DEFS[c] === d && ART_INDEX.has(c));
    l = { ...DEFAULTS, ...rest, art: artCode ? ART_INDEX.get(artCode)! : -1 };
  } else {
    let h = 0;
    for (const c of airline) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const tail = hsl((h % 360) / 360, 0.6, 0.35);
    l = { ...DEFAULTS, tail, accent: tail, art: -1 };
  }
  cacheLiv.set(airline, l);
  return l;
}

export const ART_CELLS = 8;
let artTex: THREE.CanvasTexture | null = null;
/** 1024² tail-art atlas (8 × 8 cells of 128 px, transparent where the fin keeps its base colour) */
export function tailArtTexture(): THREE.Texture {
  if (artTex) return artTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128 * ART_CELLS;
  const c = cv.getContext('2d')!;
  for (const [code, k] of ART_INDEX) {
    const cx = (k % ART_CELLS) * 128, cy = Math.floor(k / ART_CELLS) * 128;
    c.save();
    c.beginPath(); c.rect(cx, cy, 128, 128); c.clip();
    c.translate(cx, cy);
    try { DEFS[code].art!(c); } catch (e) { console.warn('tail art', code, e); }
    c.restore();
  }
  artTex = new THREE.CanvasTexture(cv);
  artTex.colorSpace = THREE.SRGBColorSpace;
  artTex.anisotropy = 4;
  return artTex;
}

function hsl(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

void bg;
