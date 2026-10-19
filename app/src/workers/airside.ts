// Airside filter (docs/AIR.md "Apron"): roads, footways and street points that lie on an
// airport's paved airside are not drawn as city roads and carry no traffic. The zone is a
// 2 m raster per aerodrome from pipeline/tpipe/airports.py (data/air/airside.bin.gz), three
// bit planes on one grid:
//   0 apron   — paved airside incl. the painted service roads: road classes >= 5 are dropped
//               (the airport layer paints them as apron service roads / walkways)
//   1 runway  — runway + taxiway pavement: every road class at grade is dropped (a road never
//               crosses a runway or taxiway surface; real underpasses are tunnels and stay)
//   2 airside — near runways / taxiways / aprons: the traffic graph drops class >= 5 edges, so
//               perimeter / service roads carry no sim traffic (GSE is the airport layer's job)
// Bridges and tunnels are always kept. Version-1 files (one plane) are read as plane 0.
//
// Used by workers/tileWorker.ts (level-0 render tiles: r_* pieces are cut where they enter a
// dropping plane — sampled along every segment, so a road whose vertices lie either side of a
// runway is cut too — and p_* points inside are dropped) and sim/sim.worker.ts (graph edges
// collapse to a point, which the sim skips).
import { decodeTbn, type TypedArray } from '../data/tbn';

interface Zone { x0: number; y0: number; w: number; h: number; cell: number; bits: Uint8Array; planes: number; pb: number }

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
    const t = decodeTbn<{ zones: { x0: number; y0: number; w: number; h: number; cell: number; off: number; planes?: number; plane_bytes?: number }[] }>(buf);
    const zm = t.arrays.zm as Uint8Array;
    return (t.header.zones ?? []).map((z) => {
      const pb = z.plane_bytes ?? Math.ceil((z.w * z.h) / 8), planes = z.planes ?? 1;
      return { ...z, planes, pb, bits: zm.subarray(z.off, z.off + pb * planes) };
    });
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

/** bit mask of the planes covering (e, n): 1 apron, 2 runway / taxiway, 4 airside */
function planesAt(zs: Zone[], e: number, n: number): number {
  let m = 0;
  for (const z of zs) {
    const i = Math.floor((e - z.x0) / z.cell), j = Math.floor((n - z.y0) / z.cell);
    if (i < 0 || j < 0 || i >= z.w || j >= z.h) continue;
    const k = j * z.w + i;
    for (let p = 0; p < z.planes; p++) if (z.bits[p * z.pb + (k >> 3)] & (1 << (k & 7))) m |= 1 << p;
  }
  return m;
}

/** planes that drop a drawn road of this class */
const dropMask = (cls: number) => (cls >= 5 ? 1 | 2 : 2);

const PER_VERTEX: Record<string, number> = { r_xyz: 3, r_s: 1, r_el: 1, r_er: 1, r_pl: 1, r_pr: 1, r_lw: 1, r_mk: 1, r_vf: 1, r_sw: 1, r_dz: 1 };
const HOLD = new Set(['r_mk', 'r_vf', 'r_sw']); // bit fields: copy, never interpolate
const STEP = 1.5; // m: inside test spacing along a segment

/**
 * Render tile (level 0): cut road pieces at grade where they enter a dropping plane (a vertex is
 * inserted at every zone edge) and drop street points on the apron / runway planes. Mutates `a`.
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
    for (let i = 0; i < n; i++) if (!(planesAt(zs, x0 + pxy[2 * i], y0 + pxy[2 * i + 1]) & 3)) keep.push(i);
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

/** a point on a piece: vertex a, or between a and b = a + 1 at fraction t */
interface Pt { a: number; b: number; t: number }

function cutRoads(a: Record<string, TypedArray>, zs: Zone[], x0: number, y0: number) {
  const off = a.r_off as Uint32Array, xyz = a.r_xyz as Float32Array;
  const cls = a.r_class as Uint8Array, fl = a.r_flags as Uint8Array;
  const nP = off.length - 1;
  const runs: { p: number; pts: Pt[] }[] = [];
  let changed = false;
  for (let p = 0; p < nP; p++) {
    const s = off[p], e = off[p + 1];
    const whole = () => { const pts: Pt[] = []; for (let v = s; v < e; v++) pts.push({ a: v, b: v, t: 0 }); runs.push({ p, pts }); };
    if ((fl[p] & 6) !== 0 || e - s < 2) { whole(); continue; }
    const dm = dropMask(cls[p]);
    const inAt = (va: number, vb: number, t: number) => {
      const X = xyz[3 * va] + (xyz[3 * vb] - xyz[3 * va]) * t, Y = xyz[3 * va + 1] + (xyz[3 * vb + 1] - xyz[3 * va + 1]) * t;
      return (planesAt(zs, x0 + X, y0 + Y) & dm) !== 0;
    };
    const px = (q: Pt) => xyz[3 * q.a] + (xyz[3 * q.b] - xyz[3 * q.a]) * q.t, py = (q: Pt) => xyz[3 * q.a + 1] + (xyz[3 * q.b + 1] - xyz[3 * q.a + 1]) * q.t;
    const add = (run: Pt[], q: Pt) => { // skip (near-)duplicate points: no zero-length segments
      const l = run[run.length - 1];
      if (l && Math.hypot(px(l) - px(q), py(l) - py(q)) < 0.05) return;
      run.push(q);
    };
    let cur: Pt[] | null = inAt(s, s, 0) ? null : [{ a: s, b: s, t: 0 }];
    let cut = cur === null;
    let prevIn = cur === null;
    for (let v = s + 1; v < e; v++) {
      const L = Math.hypot(xyz[3 * v] - xyz[3 * v - 3], xyz[3 * v + 1] - xyz[3 * v - 2]);
      const m = Math.max(1, Math.ceil(L / STEP));
      for (let k = 1; k <= m; k++) {
        const t = k / m;
        const pin = inAt(v - 1, v, t);
        if (pin !== prevIn) {
          cut = true;
          let lo = (k - 1) / m, hi = t; // bisection: lo has prevIn, hi has pin
          for (let it = 0; it < 8; it++) { const mid = (lo + hi) / 2; if (inAt(v - 1, v, mid) === prevIn) lo = mid; else hi = mid; }
          const tb = pin ? lo : hi; // stay on the outside
          if (pin) { if (cur) { add(cur, { a: v - 1, b: v, t: tb }); runs.push({ p, pts: cur }); } cur = null; }
          else cur = [{ a: v - 1, b: v, t: tb }];
          prevIn = pin;
        }
      }
      if (!prevIn && cur) add(cur, { a: v, b: v, t: 0 });
    }
    if (cur) runs.push({ p, pts: cur });
    if (cut) changed = true;
  }
  if (!changed) return;
  const keep = runs.filter((r) => r.pts.length >= 2);
  const nV = keep.reduce((n, r) => n + r.pts.length, 0);
  const nOld = off[nP];
  const out: Record<string, TypedArray> = {};
  for (const k of Object.keys(a)) {
    if (!k.startsWith('r_') || k === 'r_off') continue;
    const src = a[k];
    const vs = PER_VERTEX[k];
    const perVertex = vs !== undefined && src.length === nOld * vs;
    const stride = perVertex ? vs : src.length / nP;
    if (!Number.isInteger(stride)) continue;
    out[k] = new (src.constructor as new (n: number) => TypedArray)((perVertex ? nV : keep.length) * stride);
  }
  const newOff = new Uint32Array(keep.length + 1);
  let o = 0;
  keep.forEach(({ p, pts }, ri) => {
    newOff[ri] = o;
    for (const k of Object.keys(out)) {
      const src = a[k], dst = out[k];
      const vs = PER_VERTEX[k];
      if (vs !== undefined && src.length === nOld * vs) {
        pts.forEach((q, w) => {
          for (let c = 0; c < vs; c++) {
            const A = src[q.a * vs + c], B = src[q.b * vs + c];
            dst[(o + w) * vs + c] = HOLD.has(k) || q.a === q.b ? A : A + (B - A) * q.t;
          }
        });
      } else {
        const stride = src.length / nP;
        for (let c = 0; c < stride; c++) dst[ri * stride + c] = src[p * stride + c];
      }
    }
    o += pts.length;
  });
  newOff[keep.length] = o;
  // distance along the way at a piece start (dash phase) when the start moved
  if (out.r_v0 && a.r_v0) {
    keep.forEach(({ p, pts }, ri) => {
      const q = pts[0];
      let d = 0;
      for (let v = off[p] + 1; v <= q.a; v++) d += Math.hypot(xyz[3 * v] - xyz[3 * v - 3], xyz[3 * v + 1] - xyz[3 * v - 2]);
      if (q.b !== q.a) d += q.t * Math.hypot(xyz[3 * q.b] - xyz[3 * q.a], xyz[3 * q.b + 1] - xyz[3 * q.a + 1]);
      out.r_v0[ri] = (a.r_v0 as Float32Array)[p] + d;
    });
  }
  Object.assign(a, out);
  a.r_off = newOff;
}

/**
 * Traffic graph tile: collapse edges at grade that touch runway / taxiway pavement (any class) or,
 * for classes >= 5, lie mostly on the apron or airside planes, to a point (the sim skips
 * zero-length edges): no traffic spawns or routes across runways or on airside roads. Mutates `a`.
 */
export async function dropAirsideGraph(a: Record<string, TypedArray>, dataRoot: string, x0: number, y0: number, size: number) {
  const all = await zones(dataRoot);
  const zs = near(all, x0, y0, x0 + size, y0 + size);
  if (!zs) return;
  const off = a.e_off as Uint32Array, xyz = a.e_xyz as Float32Array, cls = a.e_class as Uint8Array, fl = a.e_flags as Uint8Array;
  if (!off || !xyz) return;
  for (let e = 0; e + 1 < off.length; e++) {
    if ((fl[e] & 6) !== 0) continue;
    const s = off[e], t = off[e + 1];
    let n = 0, air = 0, rwy = false;
    for (let v = s; v + 1 < t && !rwy; v++) {
      const L = Math.hypot(xyz[3 * v + 3] - xyz[3 * v], xyz[3 * v + 4] - xyz[3 * v + 1]);
      const m = Math.max(1, Math.ceil(L / STEP));
      for (let k = 0; k < m; k++) {
        const f = k / m;
        const pm = planesAt(zs, x0 + xyz[3 * v] + (xyz[3 * v + 3] - xyz[3 * v]) * f, y0 + xyz[3 * v + 1] + (xyz[3 * v + 4] - xyz[3 * v + 1]) * f);
        n++;
        if (pm & 2) { rwy = true; break; }
        if (pm & 5) air++;
      }
    }
    if (!rwy && !(cls[e] >= 5 && air * 2 >= n && n > 0)) continue;
    for (let v = s + 1; v < t; v++) for (let c = 0; c < 3; c++) xyz[3 * v + c] = xyz[3 * s + c];
  }
}
