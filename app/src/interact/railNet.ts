// Shared, lazily loaded view of the switch-level rail network
// (data/rail/network.bin.gz, docs/RAIL.md): every edge as a polyline in a
// segment grid (parallel-track queries for the tunnel cross-section), the
// graph nodes (edge boundaries = where the sim's blocks restart, switches)
// in a coarse grid. Loaded once per data root.
import { fetchTbn } from '../data/tbn';
import { TrackIndex } from '../layers/stations/tracks';

/** network e_kind: 0 rail · 1 subway · 2 light rail · 3 tram */
export type NetKind = 0 | 1 | 2 | 3;

export interface RailNet {
  tracks: TrackIndex;
  /** network edge kind per TrackIndex polyline */
  polyKind: Uint8Array;
  /** node E, N, z */
  nodes: Float32Array;
  /** node flags (1 switch · 2 diamond · 4 end of track) */
  nodeFlags: Uint8Array;
  /** node grid (100 m cells) */
  nodeGrid: Map<number, number[]>;
}

const CELL = 100;
const key = (cx: number, cy: number) => (cx + 8192) * 16384 + (cy + 8192);

let pending: Promise<RailNet | null> | null = null;
let loaded: RailNet | null = null;

/** The network, or null while it loads (starts the load on first call). */
export function railNet(dataRoot: string): RailNet | null {
  if (!pending) pending = load(dataRoot).then((n) => (loaded = n)).catch(() => null);
  return loaded;
}

async function load(root: string): Promise<RailNet | null> {
  const t = await fetchTbn(`${root}/rail/network.bin.gz`);
  if (!t) return null;
  const a = t.arrays;
  const off = a.e_off as Uint32Array, xyz = a.e_xyz as Float32Array, kind = a.e_kind as Uint8Array;
  const tracks = new TrackIndex();
  const pk: number[] = [];
  for (let e = 0; e + 1 < off.length; e++) {
    if (off[e + 1] - off[e] < 2) continue;
    tracks.add(kind[e] === 1 ? 'subway' : kind[e] === 2 ? 'lrt' : kind[e] === 3 ? 'streetcar' : 'commuter_rail', '', xyz.subarray(3 * off[e], 3 * off[e + 1]));
    pk.push(kind[e]);
  }
  const nodes = a.n_xyz as Float32Array;
  const nodeGrid = new Map<number, number[]>();
  for (let i = 0; i < nodes.length / 3; i++) {
    const k = key(Math.floor(nodes[3 * i] / CELL), Math.floor(nodes[3 * i + 1] / CELL));
    let c = nodeGrid.get(k);
    if (!c) nodeGrid.set(k, (c = []));
    c.push(i);
  }
  return { tracks, polyKind: Uint8Array.from(pk), nodes, nodeFlags: a.n_flags as Uint8Array, nodeGrid };
}

/** node indices within r of (e, n) */
export function nodesNear(net: RailNet, e: number, n: number, r: number): number[] {
  const out: number[] = [];
  const x0 = Math.floor((e - r) / CELL), x1 = Math.floor((e + r) / CELL), y0 = Math.floor((n - r) / CELL), y1 = Math.floor((n + r) / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
    const c = net.nodeGrid.get(key(cx, cy));
    if (!c) continue;
    for (const i of c) if (Math.hypot(net.nodes[3 * i] - e, net.nodes[3 * i + 1] - n) <= r) out.push(i);
  }
  return out;
}

/**
 * Lateral offsets (m, + = right of the direction (tx, ty)) of the tracks of
 * kind `k` running parallel (within ~14°) through the cross-section at (e, n),
 * within r. Includes the track at (e, n) itself (≈ 0).
 */
export function parallelLats(net: RailNet, e: number, n: number, tx: number, ty: number, r: number, k: NetKind, out: number[] = []): number[] {
  out.length = 0;
  const tr = net.tracks;
  for (const h of tr.near(e, n, r, () => true)) {
    if (net.polyKind[h.poly] !== k) continue;
    const p = tr.polys[h.poly];
    const i = 3 * h.seg;
    let dx = p.xyz[i + 3] - p.xyz[i], dy = p.xyz[i + 4] - p.xyz[i + 1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    if (Math.abs(dx * tx + dy * ty) < 0.97) continue;
    // the nearest point must be abeam, not past the end of the polyline
    const along = (h.x - e) * tx + (h.y - n) * ty;
    if (Math.abs(along) > 3) continue;
    out.push((h.x - e) * ty - (h.y - n) * tx);
  }
  out.sort((a, b) => a - b);
  return out;
}
