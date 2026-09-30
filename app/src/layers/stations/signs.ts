// Per-station sign atlas (canvas texture): TTC wall name tiles, platform name
// boards (TTC black / GO green / UP / VIA), and the generic entrance logos.
// One 1024×512 texture per nearby station, one draw call each.
import * as THREE from 'three/webgpu';

export type Slot = 'tile' | 'board' | 'go' | 'ttc' | 'golog' | 'uplog' | 'vialog' | 'bullets';

/** uv rect [u0, v0, u1, v1] (v up) of each atlas slot */
export const SLOTS: Record<Slot, [number, number, number, number]> = {
  tile: [0, 0.75, 1, 1],
  board: [0, 0.5, 1, 0.75],
  go: [0, 0.25, 1, 0.5],
  ttc: [0, 0, 0.25, 0.25],
  golog: [0.25, 0, 0.5, 0.25],
  uplog: [0.5, 0, 0.75, 0.25],
  vialog: [0.75, 0, 0.875, 0.25],
  bullets: [0.875, 0, 1, 0.25],
};

export interface Bullet { text: string; bg: string; fg: string }

const FONT = 'Overpass, "Helvetica Neue", Helvetica, Arial, sans-serif';

function lum(hex: number) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function css(hex: number) { return `#${hex.toString(16).padStart(6, '0')}`; }

export function makeAtlas(name: string, wall: number, bullets: Bullet[]): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 512;
  const c = cv.getContext('2d')!;
  c.textBaseline = 'middle';
  // --- TTC wall tile band (station colour, name in the Toronto Subway style)
  c.fillStyle = css(wall);
  c.fillRect(0, 0, 1024, 128);
  c.strokeStyle = 'rgba(0,0,0,0.12)';
  c.lineWidth = 2;
  for (let x = 0; x < 1024; x += 64) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 128); c.stroke(); }
  for (let y = 0; y < 128; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(1024, y); c.stroke(); }
  c.fillStyle = lum(wall) > 0.55 ? '#1b1b1b' : '#f4f1ea';
  c.font = `800 78px ${FONT}`;
  c.textAlign = 'center';
  c.fillText(name, 512, 68, 980);
  // --- platform name board: black, white name, line bullets on the left
  c.fillStyle = '#16191d';
  c.fillRect(0, 128, 1024, 128);
  let x = 20;
  for (const b of bullets.slice(0, 3)) {
    c.fillStyle = b.bg;
    c.beginPath(); c.arc(x + 44, 192, 44, 0, Math.PI * 2); c.fill();
    c.fillStyle = b.fg;
    c.font = `800 56px ${FONT}`;
    c.textAlign = 'center';
    c.fillText(b.text, x + 44, 196);
    x += 100;
  }
  c.fillStyle = '#ffffff';
  c.font = `700 72px ${FONT}`;
  c.textAlign = 'left';
  c.fillText(name, x + 16, 196, 1004 - x - 16);
  // --- GO board: green, white GO roundel + name
  c.fillStyle = '#3d8b37';
  c.fillRect(0, 256, 1024, 128);
  c.fillStyle = '#ffffff';
  c.beginPath(); c.arc(76, 320, 50, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#3d8b37';
  c.font = `900 50px ${FONT}`;
  c.textAlign = 'center';
  c.fillText('GO', 76, 324);
  c.fillStyle = '#ffffff';
  c.font = `700 70px ${FONT}`;
  c.textAlign = 'left';
  c.fillText(name, 150, 324, 860);
  // --- TTC entrance sign (white box, red TTC wordmark, SUBWAY)
  c.fillStyle = '#f7f7f5';
  c.fillRect(0, 384, 256, 128);
  c.fillStyle = '#da251d';
  c.font = `italic 900 70px ${FONT}`;
  c.textAlign = 'center';
  c.fillText('TTC', 128, 428);
  c.fillRect(24, 460, 208, 6);
  c.fillStyle = '#1b1b1b';
  c.font = `800 30px ${FONT}`;
  c.fillText('SUBWAY', 128, 490);
  // --- GO logo
  c.fillStyle = '#3d8b37';
  c.fillRect(256, 384, 256, 128);
  c.fillStyle = '#ffffff';
  c.font = `900 96px ${FONT}`;
  c.fillText('GO', 384, 452);
  // --- UP logo
  c.fillStyle = '#e8641b';
  c.fillRect(512, 384, 256, 128);
  c.fillStyle = '#ffffff';
  c.font = `900 96px ${FONT}`;
  c.fillText('UP', 640, 452);
  // --- VIA logo
  c.fillStyle = '#ffd400';
  c.fillRect(768, 384, 128, 128);
  c.fillStyle = '#1b2a5a';
  c.font = `900 44px ${FONT}`;
  c.fillText('VIA', 832, 452);
  // --- bullets strip (first line bullet, for pole signs)
  const b0 = bullets[0];
  c.fillStyle = '#16191d';
  c.fillRect(896, 384, 128, 128);
  if (b0) {
    c.fillStyle = b0.bg;
    c.beginPath(); c.arc(960, 448, 52, 0, Math.PI * 2); c.fill();
    c.fillStyle = b0.fg;
    c.font = `800 64px ${FONT}`;
    c.fillText(b0.text, 960, 452);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  return t;
}

/** TTC-ish per-station wall colour (same hash + palette as interact/tunnel.ts), or the curated one. */
export function wallColour(name: string, curated?: string): number {
  if (curated) return parseInt(curated.replace('#', ''), 16);
  const pal = [0x3c8d9e, 0xc7a64a, 0x8a4f7d, 0x4f7d52, 0xb8664a, 0x5a6fa8, 0xa89b86, 0x6e9e8c, 0xd0c48a, 0x7a8c9e];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
}
