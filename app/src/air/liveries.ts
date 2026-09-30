// Simplified airline liveries: five colours applied to model parts
// (fuselage, tail fin, belly, accent = tail logo + cheatline, engines).
export interface Livery { fuse: number; tail: number; belly: number; accent: number; engine: number }

const L = (fuse: number, tail: number, belly: number, accent: number, engine: number): Livery => ({ fuse, tail, belly, accent, engine });
const W = 0xf4f5f6;

const AC = L(W, 0x121315, 0x1b1d20, 0xd62a1f, 0x1b1d20); // 2017: white, black tail + belly, red leaf
const UA = L(0xeef0f2, 0x0c2d6b, 0x0c2d6b, 0x4f7cc4, 0x0c2d6b);
const DL = L(W, 0x0b1f41, 0x0b1f41, 0xc01933, 0x0b1f41);
const AA = L(0xc5cad0, 0x2c5aa0, 0xaeb4ba, 0xc3202f, 0xb4bac0);

export const LIVERIES: Record<string, Livery> = {
  ACA: AC, JZA: AC,
  ROU: L(W, 0xc8102e, 0xb9bec4, 0xf4f5f6, 0x9ea4aa),
  WJA: L(W, 0x0a4f63, W, 0x16a9b7, 0x0a4f63),
  SWG: L(W, 0x0e3f8a, W, 0xf7941d, 0x0e3f8a),
  POE: L(W, 0x0c2140, W, 0xc8cdd3, 0x0c2140),
  FLE: L(W, 0x9ccb3b, W, 0x161616, 0x9ccb3b),
  TSC: L(W, 0x1f5fa8, W, 0x5bc2e7, 0x1f5fa8),
  UAL: UA, SKW: UA,
  DAL: DL, EDV: DL,
  AAL: AA, EGF: AA, JIA: AA, RPA: AA,
  BAW: L(W, 0x1b2a5c, 0x1b2a5c, 0xc8102e, 0x9aa1a8),
  DLH: L(W, 0x05164d, W, 0xf9b000, 0x05164d),
  AFR: L(W, 0xf4f5f6, W, 0xd41c23, 0x0a1d4c),
  KLM: L(0x00a1de, 0x00a1de, W, W, 0x00a1de),
  SWR: L(W, 0xd52b1e, W, W, 0x9aa1a8),
  LOT: L(W, 0x0b2d6b, W, W, 0x0b2d6b),
  THY: L(W, 0xc8102e, W, W, 0x9aa1a8),
  ELY: L(W, 0x0b3d91, W, W, 0x0b3d91),
  UAE: L(W, 0xd71921, W, 0x00843d, 0x9aa1a8),
  ETD: L(0xe7dfd0, 0xb99659, 0xe7dfd0, 0x6b5a3c, 0xb99659),
  ETH: L(W, 0x078930, W, 0xfcdd09, 0x078930),
  AIC: L(W, 0xb3163c, W, 0xd4a94b, 0x6a1f5c),
  PIA: L(W, 0x006a4e, W, W, 0x9aa1a8),
  CPA: L(0xeef0ef, 0x005d63, 0xa3a9ad, W, 0x005d63),
  EVA: L(W, 0x00704a, W, 0xf08300, 0x00704a),
  CAL: L(W, 0xd98cb0, 0x1c3d7a, 0x1c3d7a, 0x9aa1a8),
  KAL: L(0x9fd4ee, W, 0xc9ced3, 0x0065b3, 0x9fd4ee),
  CSN: L(W, 0x1c78b9, W, 0xd52b1e, 0x1c78b9),
  PAL: L(W, 0x0038a8, W, 0xfcd116, 0x9aa1a8),
  TAP: L(W, 0xe0231f, W, 0x006847, 0x9aa1a8),
  RZO: L(W, 0x2a9bd5, W, 0x274f9a, 0x274f9a),
  CFG: L(W, 0xf4c12e, W, 0x1f1f1f, 0xf4c12e),
  NOS: L(W, 0x0b2d6b, W, W, 0x0b2d6b),
  ITY: L(W, 0x0033a0, W, 0x00a1de, 0x0033a0),
  AMX: L(W, 0x0b2240, 0xc0c6cc, 0xc0c6cc, 0x0b2240),
  CMP: L(W, 0x0032a0, W, 0xc9a227, 0x0032a0),
  BWA: L(W, 0xc8102e, W, 0xf6c33f, 0x9aa1a8),
  DWI: L(W, 0x7c6ce0, W, 0x3b2ea6, 0x7c6ce0),
  AVA: L(W, 0xd71920, W, W, 0x9aa1a8),
  ICE: L(W, 0x003a7d, 0x003a7d, 0xf5b335, 0x003a7d),
  FDX: L(W, 0x4d148c, 0x8c8f94, 0xff6600, W),
  UPS: L(0xe9e7e2, 0x351c15, 0x351c15, 0xffb500, 0xe9e7e2),
  CJT: L(W, 0x0c2340, W, 0xd52b1e, 0x9aa1a8),
};

export function liveryOf(airline: string): Livery {
  const l = LIVERIES[airline];
  if (l) return l;
  let h = 0;
  for (const c of airline) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = (h % 360) / 360;
  const tail = hsl(hue, 0.6, 0.35);
  return L(W, tail, W, 0xf4f5f6, 0x9aa1a8);
}

function hsl(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
