// Airside filter (docs/AIR.md "Apron"): service roads, footways and street points that lie
// on an airport's paved airside (aprons, taxiways) are painted by the airport layer as
// apron service roads / walkways, so the tile road mesh (curbs, sidewalks, lamps) and the
// traffic graph drop them here. The zone is a 2 m raster per aerodrome from
// pipeline/tpipe/airports.py (data/air/airside.bin.gz). Only road classes >= 5 at grade
// are affected (bridges / tunnels, e.g. roads under taxiway bridges, are kept).
//
// Used by workers/tileWorker.ts (level-0 render tiles: r_* pieces are cut at the zone
// edge, p_* points inside are dropped) and sim/sim.worker.ts (graph edges inside are
// collapsed, so no cars / pedestrians spawn or route on the apron).
import { decodeTbn, type TypedArray } from '../data/tbn';

interface Zone { x0: number; y0: number; w: number; h: number; cell: number; bits: Uint8Array }

let zonesP: Promise<Zone[]> | null = null;

async function load(dataRoot: string): Promise<Zone[]> {
  try {
    const res = await fetch(`${dataRoot}/air/airside.bin.gz`);
    if (!res.ok) return [];
    let buf = await res.arrayBuffer();
    const u = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (u[0] === 0x1f && u[1] === 0x8b) {
      buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    const t = decodeTbn<{ zones: { x0: number; y0: number; w: number; h: number; cell: number; off: number }[] }>(buf);
    const zm = t.arrays.zm as Uint8Array;
    return (t.header.zones ?? []).map((z) => ({ ...z, bits: zm.subarray(z.off, z.off + Math.ceil((z.w * z.h) / 8)) }));
  } catch {
    return [];
  }
}

function zones(dataRoot: string) {
  return (zonesP ??= load(dataRoot));
}

/** zones overlapping the rect, or null */
function near(all: Zone[], x0: number, y0: number, x1: number, y1: number): Zone[] | null {
  const out = all.filter((z) => z.x0 < x1 && z.x0 + z.w * z.cell > x0 && z.y0 < y1 && z.y0 + z.h * z.cell > y0);
  return out.length ? out : null;
}

function inside(zs: Zone[], e: number, n: number): boolean {
  for (const z of zs) {
    const i = Math.floor((e - z.x0) / z.cell), j = Math.floor((n - z.y0) / z.cell);
    if (i < 0 || j < 0 || i >= z.w || j >= z.h) continue;
    const k = j * z.w + i;
    if (z.bits[k >> 3] & (1 << (k & 7))) return true;
  }
  return false;
}

const PER_VERTEX: Record<string, number> = { r_xyz: 3, r_s: 1, r_el: 1, r_er: 1, r_pl: 1, r_pr: 1, r_lw: 1, r_mk: 1, r_vf: 1, r_sw: 1, r_dz: 1 };
const HOLD = new Set(['r_mk', 'r_vf', 'r_sw']); // bit fields: copy, never interpolate

/**
 * Render tile (level 0): cut road pieces of class >= 5 at grade where they enter the airside
 * zone (a vertex is inserted at the zone edge) and drop street points inside. Mutates `a`.
 */
export async function dropAirsideTile(a: Record<string, TypedArray>, url: string, x0: number, y0: number, size: number) {
  const all = await zones(url.replace(/\/tiles\/\d+\/[^/]*$/, ''));
  const zs = near(all, x0, y0, x0 + size, y0 + size);
  if (!zs) return;
  const off = a.r_off as Uint32Array | undefined;
  if (off && off.length > 1) cutRoads(a, zs, x0, y0);
  const pk = a.p_kind as Uint8Array | undefined, pxy = a.p_xy as Float32Array | undefined;
  if (pk && pxy) {
    const n = pk.length;
    const keep: number[] = [];
    for (let i = 0; i < n; i++) if (!inside(zs, x0 + pxy[2 * i], y0 + pxy[2 * i + 1])) keep.push(i);
    if (keep.length < n) {
      for (const k of Object.keys(a)) {
        if (!k.startsWith('p_')) continue;
        const src = a[k], stride = src.length / n;
        if (!Number.isInteger(stride)) continue;
        const dst = new (src.constructor as new (n: number) => TypedArray)(keep.length * stride);
        keep.forEach((i, o) => { for (let c = 0; c < stride; c++) dst[o * stride + c] = src[i * stride + c]; });
        a[k] = dst;
      }
    }
  }
}

function cutRoads(a: Record<string, TypedArray>, zs: Zone[], x0: number, y0: number) {
  const off = a.r_off as Uint32Array, xyz = a.r_xyz as Float32Array;
  const cls = a.r_class as Uint8Array, fl = a.r_flags as Uint8Array;
  const nP = off.length - 1;
  // runs of kept vertices per piece: [piece, from, to, tFrom, tTo] (t = fraction towards the
  // neighbour vertex for an inserted edge vertex, 0 = none)
  const runs: [number, number, number, number, number][] = [];
  let changed = false;
  const inAt = (v: number) => inside(zs, x0 + xyz[3 * v], y0 + xyz[3 * v + 1]);
  const edgeT = (va: number, vb: number) => { // fraction from outside va towards inside vb where the zone starts
    let lo = 0, hi = 1;
    const ax = xyz[3 * va], ay = xyz[3 * va + 1], bx = xyz[3 * vb], by = xyz[3 * vb + 1];
    for (let it = 0; it < 10; it++) {
      const m = (lo + hi) / 2;
      if (inside(zs, x0 + ax + (bx - ax) * m, y0 + ay + (by - ay) * m)) hi = m; else lo = m;
    }
    return lo;
  };
  for (let p = 0; p < nP; p++) {
    const s = off[p], e = off[p + 1];
    if (cls[p] < 5 || (fl[p] & 6) !== 0 || e - s < 2) { runs.push([p, s, e, 0, 0]); continue; }
    let v = s;
    let any = false;
    while (v < e) {
      while (v < e && inAt(v)) { v++; any = true; }
      if (v >= e) break;
      const r0 = v;
      while (v < e && !inAt(v)) v++;
      // run [r0, v): extend by a partial vertex into the zone on each side
      const tA = r0 > s ? edgeT(r0, r0 - 1) : 0;
      const tB = v < e ? edgeT(v - 1, v) : 0;
      if (v - r0 + (tA > 0 ? 1 : 0) + (tB > 0 ? 1 : 0) >= 2) runs.push([p, r0, v, tA, tB]);
      if (v < e) any = true;
    }
    if (any) changed = true;
    else if (!runs.length || runs[runs.length - 1][0] !== p) runs.push([p, s, e, 0, 0]);
  }
  if (!changed) return;
  let nV = 0;
  for (const [, f, t, tA, tB] of runs) nV += t - f + (tA > 0 ? 1 : 0) + (tB > 0 ? 1 : 0);
  const nOld = off[nP];
  const out: Record<string, TypedArray> = {};
  const newOff = new Uint32Array(runs.length + 1);
  for (const k of Object.keys(a)) {
    if (!k.startsWith('r_') || k === 'r_off') continue;
    const src = a[k];
    const vs = PER_VERTEX[k];
    const perVertex = vs !== undefined && src.length === nOld * vs;
    const stride = perVertex ? vs : src.length / nP;
    if (!Number.isInteger(stride)) continue;
    out[k] = new (src.constructor as new (n: number) => TypedArray)((perVertex ? nV : runs.length) * stride);
  }
  let o = 0;
  runs.forEach(([p, f, t, tA, tB], ri) => {
    newOff[ri] = o;
    for (const k of Object.keys(out)) {
      const src = a[k], dst = out[k];
      const vs = PER_VERTEX[k];
      if (vs !== undefined && src.length === nOld * vs) {
        let w = o;
        const put = (va: number, vb: number, tt: number) => {
          for (let c = 0; c < vs; c++) {
            const A = src[va * vs + c], B = src[vb * vs + c];
            dst[w * vs + c] = HOLD.has(k) ? A : A + (B - A) * tt;
          }
          w++;
        };
        if (tA > 0) put(f - 1, f, 1 - tA);
        for (let v = f; v < t; v++) put(v, v, 0);
        if (tB > 0) put(t - 1, t, tB);
      } else {
        const stride = src.length / nP;
        for (let c = 0; c < stride; c++) dst[ri * stride + c] = src[p * stride + c];
      }
    }
    o += t - f + (tA > 0 ? 1 : 0) + (tB > 0 ? 1 : 0);
  });
  newOff[runs.length] = o;
  // distance along the way at a piece start (dash phase) when the piece start moved
  if (out.r_v0 && a.r_v0) {
    runs.forEach(([p, f, , tA], ri) => {
      let d = 0;
      for (let v = off[p] + 1; v <= f - (tA > 0 ? 1 : 0); v++) d += Math.hypot(xyz[3 * v] - xyz[3 * v - 3], xyz[3 * v + 1] - xyz[3 * v - 2]);
      if (tA > 0 && f > off[p]) d += (1 - tA) * Math.hypot(xyz[3 * f] - xyz[3 * f - 3], xyz[3 * f + 1] - xyz[3 * f - 2]);
      out.r_v0[ri] = (a.r_v0 as Float32Array)[p] + d;
    });
  }
  Object.assign(a, out);
  a.r_off = newOff;
}

/**
 * Traffic graph tile: collapse drivable edges of class >= 5 at grade whose middle lies in the
 * airside zone to a point (the sim skips zero-length edges), so no traffic spawns or routes
 * on aprons. GSE is the airport layer's job. Mutates `a`.
 */
export async function dropAirsideGraph(a: Record<string, TypedArray>, dataRoot: string, x0: number, y0: number, size: number) {
  const all = await zones(dataRoot);
  const zs = near(all, x0, y0, x0 + size, y0 + size);
  if (!zs) return;
  const off = a.e_off as Uint32Array, xyz = a.e_xyz as Float32Array, cls = a.e_class as Uint8Array, fl = a.e_flags as Uint8Array;
  if (!off || !xyz) return;
  for (let e = 0; e + 1 < off.length; e++) {
    if (cls[e] < 5 || (fl[e] & 6) !== 0) continue;
    const s = off[e], t = off[e + 1];
    let hit = 0;
    for (let v = s; v < t; v++) if (inside(zs, x0 + xyz[3 * v], y0 + xyz[3 * v + 1])) hit++;
    if (hit * 2 < t - s) continue;
    for (let v = s + 1; v < t; v++) for (let c = 0; c < 3; c++) xyz[3 * v + c] = xyz[3 * s + c];
  }
}
