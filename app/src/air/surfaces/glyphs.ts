// Runway designator glyph atlas: 0-9, L, C, R drawn as block segment shapes in
// the style of ICAO Annex 14 / TP 312 runway numerals (fig. 5-3): thick
// strokes, square terminals, tall 1:2 cells. 16 cells in one row (13 used);
// each glyph sits inside its cell with a margin so mip levels do not bleed.
import * as THREE from 'three/webgpu';

export const GLYPH_L = 10, GLYPH_C = 11, GLYPH_R = 12;
const CW = 64, CH = 128, N = 16;

// segment boxes in a 10 x 20 unit glyph space (x right, y down), stroke 3
type Box = [number, number, number, number];
const S = 3;
const TOP: Box = [0, 0, 10, S], MID: Box = [0, 8.5, 10, S], BOT: Box = [0, 20 - S, 10, S];
const TL: Box = [0, 0, S, 10], TR: Box = [10 - S, 0, S, 10], BL: Box = [0, 10, S, 10], BR: Box = [10 - S, 10, S, 10];
const GLYPHS: Box[][] = [
  [TOP, BOT, [0, 0, S, 20], [10 - S, 0, S, 20]], // 0
  [[3.5, 0, S, 20], [1, 0, 4, S], [1, 20 - S, 8, S]], // 1
  [TOP, TR, MID, BL, BOT], // 2
  [TOP, [10 - S, 0, S, 20], MID, BOT], // 3
  [TL, [0, 8.5, 10, S], [10 - S, 0, S, 20]], // 4
  [TOP, TL, MID, BR, BOT], // 5
  [TOP, [0, 0, S, 20], MID, BR, BOT], // 6
  [TOP, [10 - S, 0, S, 20]], // 7
  [TOP, MID, BOT, [0, 0, S, 20], [10 - S, 0, S, 20]], // 8
  [TOP, MID, BOT, TL, [10 - S, 0, S, 20]], // 9
  [[0, 0, S, 20], BOT], // L
  [TOP, BOT, [0, 0, S, 20]], // C
  [TOP, MID, [0, 0, S, 20], TR, [5.5, 10, S, 10]], // R
];

let atlas: THREE.Texture | null = null;

export function glyphAtlas(): THREE.Texture {
  if (atlas) return atlas;
  const cv = document.createElement('canvas');
  cv.width = CW * N;
  cv.height = CH;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#fff';
  // glyph space 10x20 -> cell with 7 px margin left/right, 10 px top/bottom
  const mx = 7, my = 10;
  const sx = (CW - 2 * mx) / 10, sy = (CH - 2 * my) / 20;
  GLYPHS.forEach((boxes, i) => {
    for (const [x, y, w, h] of boxes) g.fillRect(i * CW + mx + x * sx, my + y * sy, w * sx, h * sy);
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  atlas = t;
  return t;
}

/** glyph box inside its cell, as fractions (for placing glyphs at true size) */
export const GLYPH_CELL = { cells: N, marginX: 7 / CW, marginY: 10 / CH };
