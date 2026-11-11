// Offline entry for app/qa/props_dump.mjs: builds one level-0 tile with the network engine and runs
// the vegetation placement as the network worker does (net/worker.ts), so static QA sees exactly
// what the client draws.
import { decodeTbn } from '../src/data/tbn';
import { build } from '../src/net/core/build';
import type { NetDesc } from '../src/net/core/desc';
import { decodeTerrain, type TerrainHeader } from '../src/net/tiles';
import { placeNetTile } from '../src/workers/vegetation';

/** tpipe/qa/checks_objects.py PROP_KIND codes of the network engine's street props */
const KIND: Record<string, number> = { hydrant: 0, bin: 1, bench: 4, bus_stop: 18, tram_stop: 18, shelter: 19 };
const LAMPS = new Set(['lamp', 'lamp_res']);

/**
 * Compact dump (little endian): u32 [nVeg, nLamp, nSig, 2] ·
 * veg: u16 x[n], u16 y[n] (tile-local, 1/64 m) · u8 height[n], u8 crown width[n] (0.1 m, capped 25.5) · u8 species[n] · pad to 4 ·
 * lamps f32 5/rec (x, n, z, angle, height) · signals f32 7/rec (x, n, z, angle, junction, phase, mast) ·
 * street props f32 5/rec (kind, x, n, z, angle) to the end
 */
export function placeTile(tileBuf: ArrayBuffer, netJson: string, dtm: Uint8Array | null, tx: number, ty: number, size = 1024): Uint8Array {
  const { arrays: a } = decodeTbn(tileBuf);
  const j = JSON.parse(netJson) as NetDesc & { terrain?: TerrainHeader };
  const desc = { ...j, terrain: j.terrain && dtm ? decodeTerrain(j.terrain, dtm) : undefined } as NetDesc;
  const b = build(desc);
  const ox = tx * size, oy = ty * size;
  const g = b.terrain!;
  const at = (x: number, y: number) => {
    const fx = (x + ox - g.x0) / g.cell, fy = (y + oy - g.y0) / g.cell;
    const i = Math.max(0, Math.min(g.nx - 2, Math.floor(fx))), k = Math.max(0, Math.min(g.ny - 2, Math.floor(fy)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - k));
    const h = g.h, n = g.nx;
    return h[k * n + i] * (1 - u) * (1 - v) + h[k * n + i + 1] * u * (1 - v) + h[(k + 1) * n + i] * (1 - u) * v + h[(k + 1) * n + i + 1] * u * v;
  };
  const all = placeNetTile(a, b, tx, ty, size, { cell: g.cell, at }).veg;
  const keep: number[] = [];
  for (let i = 0; i < all.length; i += 8) if (all[i] >= 0 && all[i] < size && all[i + 1] >= 0 && all[i + 1] < size) keep.push(...all.subarray(i, i + 8));
  const veg = Float32Array.from(keep);
  const lamps: number[] = [], signals: number[] = [], props: number[] = [];
  const nodeIdx = new Map<string, number>();
  for (const p of b.props) {
    const x = p.x - ox, y = p.y - oy;
    if (LAMPS.has(p.kind)) lamps.push(x, y, p.z, p.h, p.kind === 'lamp' ? 8.5 : 9.5);
    else if (p.kind === 'signal_pole') {
      const key = `${Math.round(p.x / 40)},${Math.round(p.y / 40)}`;
      if (!nodeIdx.has(key)) nodeIdx.set(key, nodeIdx.size);
      signals.push(x, y, p.z, p.h, nodeIdx.get(key)!, 0, p.p?.reach ?? 3);
    } else if (KIND[p.kind] !== undefined) props.push(KIND[p.kind], x, y, p.z, p.h);
  }
  const nv = veg.length / 8;
  const vegBytes = Math.ceil((nv * 7) / 4) * 4;
  const out = new ArrayBuffer(16 + vegBytes + (lamps.length + signals.length + props.length) * 4);
  new Uint32Array(out, 0, 4).set([nv, lamps.length / 5, signals.length / 7, 2]);
  const xs = new Uint16Array(out, 16, nv), ys = new Uint16Array(out, 16 + nv * 2, nv);
  const hs = new Uint8Array(out, 16 + nv * 4, nv), ws = new Uint8Array(out, 16 + nv * 5, nv), sp = new Uint8Array(out, 16 + nv * 6, nv);
  const q = (v: number, s: number, hi: number) => Math.max(0, Math.min(hi, Math.round(v * s)));
  for (let i = 0; i < nv; i++) {
    const r = veg.subarray(i * 8, i * 8 + 8);
    xs[i] = q(r[0], 64, 65535); ys[i] = q(r[1], 64, 65535); hs[i] = q(r[4], 10, 255); ws[i] = q(r[5], 10, 255); sp[i] = r[6];
  }
  const f = new Float32Array(out, 16 + vegBytes);
  f.set(lamps, 0); f.set(signals, lamps.length); f.set(props, lamps.length + signals.length);
  return new Uint8Array(out);
}
