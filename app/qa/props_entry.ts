// Offline entry for app/qa/props_dump.mjs: runs the tile worker's real street
// furniture + vegetation placement (workers/roads.ts, street.ts, vegetation.ts)
// for one level-0 tile, so static QA sees exactly what the client draws.
import { decodeTbn } from '../src/data/tbn';
import { buildRoads, TerrainSampler } from '../src/workers/meshing';
import { buildStreet } from '../src/workers/street';
import { applyStationZones, setStationZones } from '../src/workers/stationZones';

export function setZones(z: number[][]) { setStationZones(z); }

/**
 * Compact dump (little endian): u32 [nVeg, nLamp, nSig, 1] ·
 * veg: u16 x[n], u16 y[n] (tile-local, 1/64 m) · u8 height[n], u8 crown width[n] (0.1 m, capped 25.5) · u8 species[n] · pad to 4 ·
 * lamps f32 5/rec (x, n, z, angle, height) · signals f32 7/rec (x, n, z, angle, junction, phase, mast)
 */
export function placeTile(buf: ArrayBuffer, tx: number, ty: number, size = 1024, grid = 33): Uint8Array {
  const { arrays: a } = decodeTbn(buf);
  applyStationZones(a, tx * size, ty * size, size);
  const G = (a.terrain_h ? Math.round(Math.sqrt(a.terrain_h.length)) : grid) || grid;
  const hdm = a.terrain_h as Int16Array | undefined;
  const h = new Float32Array(G * G);
  if (hdm) for (let k = 0; k < h.length; k++) h[k] = hdm[k] / 10;
  const sampler = new TerrainSampler(h, G, size);
  const ground = a.ground ? (a.ground as Uint8Array).slice() : new Uint8Array(256 * 256);
  const roads = buildRoads(a, sampler, 0, ground);
  const st = buildStreet(a, roads.streets, roads.junctions, sampler, ground, tx, ty);
  const nv = st.veg.length / 8;
  const vegBytes = Math.ceil((nv * 7) / 4) * 4;
  const out = new ArrayBuffer(16 + vegBytes + (st.lamps.length + st.signals.length) * 4);
  new Uint32Array(out, 0, 4).set([nv, st.lamps.length / 5, st.signals.length / 7, 1]);
  const xs = new Uint16Array(out, 16, nv), ys = new Uint16Array(out, 16 + nv * 2, nv);
  const hs = new Uint8Array(out, 16 + nv * 4, nv), ws = new Uint8Array(out, 16 + nv * 5, nv), sp = new Uint8Array(out, 16 + nv * 6, nv);
  const q = (v: number, s: number, hi: number) => Math.max(0, Math.min(hi, Math.round(v * s)));
  for (let i = 0; i < nv; i++) {
    const r = st.veg.subarray(i * 8, i * 8 + 8);
    xs[i] = q(r[0], 64, 65535); ys[i] = q(r[1], 64, 65535); hs[i] = q(r[4], 10, 255); ws[i] = q(r[5], 10, 255); sp[i] = r[6];
  }
  const f = new Float32Array(out, 16 + vegBytes);
  f.set(st.lamps, 0); f.set(st.signals, st.lamps.length);
  return new Uint8Array(out);
}
