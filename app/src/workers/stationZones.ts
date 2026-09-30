// Station complexes (Union deck, surface platforms): paved and kept free of
// trees. Zones come from data/stations.json `zones` (world E/N polygons,
// pipeline/tpipe/stations.py) via the tile-worker config. Applied to the
// decoded tile arrays before anything is built from them:
//   - ground raster pixels inside a zone → class 21 (platform/plaza, paved),
//     so vegetation / props that read ground classes skip them;
//   - vector ground polygons lying entirely inside a zone → class 21;
//   - OSM tree points (p_kind 3) inside a zone → 255 (ignored by every consumer).
// Buildings/houses clipping tracks or platforms are removed through the
// regular `suppress` id list (stations.json `suppress`).
import type { TypedArray } from '../data/tbn';

interface Zone { x0: number; y0: number; x1: number; y1: number; xy: Float64Array }

let zones: Zone[] = [];

export function setStationZones(flat: number[][] | undefined) {
  zones = (flat ?? []).filter((z) => z.length >= 6).map((z) => {
    const xy = Float64Array.from(z);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < xy.length; i += 2) {
      x0 = Math.min(x0, xy[i]); x1 = Math.max(x1, xy[i]);
      y0 = Math.min(y0, xy[i + 1]); y1 = Math.max(y1, xy[i + 1]);
    }
    return { x0, y0, x1, y1, xy };
  });
}

function inside(z: Zone, x: number, y: number): boolean {
  if (x < z.x0 || x > z.x1 || y < z.y0 || y > z.y1) return false;
  const p = z.xy, n = p.length / 2;
  let c = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = p[2 * i + 1], yj = p[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((p[2 * j] - p[2 * i]) * (y - yi)) / (yj - yi) + p[2 * i]) c = !c;
  }
  return c;
}

const PAVED = 21;
const DROPPED = 255;

/** Mutates the decoded tile arrays (see file comment). ox/oy = tile origin (world), S = tile size. */
export function applyStationZones(a: Record<string, TypedArray>, ox: number, oy: number, S: number) {
  const zs = zones.filter((z) => z.x1 >= ox && z.x0 <= ox + S && z.y1 >= oy && z.y0 <= oy + S);
  if (!zs.length) return;
  const any = (x: number, y: number) => { for (const z of zs) if (inside(z, x, y)) return true; return false; };
  // ground raster (256², row 0 = south, pixel centres)
  const g = a.ground as Uint8Array | undefined;
  if (g && g.length === 256 * 256) {
    const px = S / 256;
    for (const z of zs) {
      const i0 = Math.max(0, Math.floor((z.x0 - ox) / px)), i1 = Math.min(255, Math.ceil((z.x1 - ox) / px));
      const j0 = Math.max(0, Math.floor((z.y0 - oy) / px)), j1 = Math.min(255, Math.ceil((z.y1 - oy) / px));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * 256 + i;
        if (g[k] === 1) continue; // water stays water
        if (inside(z, ox + (i + 0.5) * px, oy + (j + 0.5) * px)) g[k] = PAVED;
      }
    }
  }
  // vector ground polygons (quantized tile-local u16)
  const off = a.gp_off as Uint32Array | undefined, gxy = a.gp_xy as Uint16Array | undefined, gc = a.gp_class as Uint8Array | undefined;
  if (off && gxy && gc) {
    const q = S / 65535;
    for (let p = 0; p < gc.length && p + 1 < off.length; p++) {
      if (gc[p] === 1 || gc[p] === PAVED) continue;
      let all = off[p + 1] > off[p];
      for (let v = off[p]; v < off[p + 1] && all; v++) all = any(ox + gxy[2 * v] * q, oy + gxy[2 * v + 1] * q);
      if (all) gc[p] = PAVED;
    }
  }
  // OSM trees
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined;
  if (pk && pxy) for (let i = 0; i < pk.length; i++) if (pk[i] === 3 && any(ox + pxy[2 * i], oy + pxy[2 * i + 1])) pk[i] = DROPPED;
}
