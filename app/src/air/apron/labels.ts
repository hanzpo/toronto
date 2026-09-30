// Painted stand numbers (docs/AIR.md "Apron"): yellow characters on a black box, laid flat
// on the apron and read by a pilot taxiing in along the lead-in line. Characters come from
// a Canvas2D atlas (bold condensed sans, one cell each); geometry is one quad per character
// carrying (gx, gy, kind 10, glyph index) in the marking attribute, so the labels are drawn
// by the airport marking material (air/surfaces/materials.ts) in the markings draw call.
import * as THREE from 'three/webgpu';

export const LABEL_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-';
const CW = 64, CH = 104;
export const LABEL_CELLS = 40;
/** character advance / height */
export const LABEL_ASPECT = 0.62;
export const MK_GLYPH = 10;

let atlas: THREE.Texture | null = null;

export function labelAtlas(): THREE.Texture {
  if (atlas) return atlas;
  const cv = document.createElement('canvas');
  cv.width = CW * LABEL_CELLS;
  cv.height = CH;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(CH * 0.86)}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`;
  for (let i = 0; i < LABEL_CHARS.length; i++) {
    const x = i * CW + CW / 2;
    g.save();
    g.translate(x, CH / 2 + CH * 0.04);
    g.scale(0.78, 1); // condense
    g.fillText(LABEL_CHARS[i], 0, 0);
    g.restore();
  }
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

/**
 * Label quads: [ref, x, h, z, bearing] per label (origin-relative three coords; bearing =
 * direction the text is read towards, clockwise from north). Returns position + mk attribute.
 */
export function labelGeometry(labels: [string, number, number, number, number][], height = 2.6): THREE.BufferGeometry | null {
  const pos: number[] = [], mk: number[] = [], idx: number[] = [];
  const pad = 0.28, padV = 0.22;
  for (const [ref, x, h, z, brg] of labels) {
    const chars = [...ref.toUpperCase()].map((c) => LABEL_CHARS.indexOf(c)).filter((i) => i >= 0);
    if (!chars.length) continue;
    // reading frame on the ground: up = bearing direction, right = 90° clockwise of it
    const ux = Math.sin(brg), un = Math.cos(brg);
    const rx = un, rn = -ux;
    const adv = height * LABEL_ASPECT;
    const total = adv * chars.length;
    chars.forEach((ci, k) => {
      const g0 = k === 0 ? -pad : 0, g1 = k === chars.length - 1 ? 1 + pad : 1;
      const base = pos.length / 3;
      for (const [gx, gy] of [[g0, -padV], [g1, -padV], [g1, 1 + padV], [g0, 1 + padV]]) {
        const s = -total / 2 + adv * (k + gx); // along the reading direction's right
        const t = height * (gy - 0.5);
        const E = rx * s + ux * t, N = rn * s + un * t;
        pos.push(x + E, h, z - N);
        mk.push(gx, gy, MK_GLYPH, ci);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('mk', new THREE.BufferAttribute(new Float32Array(mk), 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
