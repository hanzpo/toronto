import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeTbn } from './src/data/tbn';
import { buildTerrain, TerrainSampler } from './src/workers/meshing';
import { buildGround } from './src/workers/ground';
for (const k of process.argv.slice(2)) {
  const raw = gunzipSync(readFileSync(`public/data/tiles/0/${k}.bin.gz`));
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const { arrays: a } = decodeTbn(buf as ArrayBuffer);
  const G = Math.round(Math.sqrt(a.terrain_h.length));
  const t0 = performance.now();
  const terr = buildTerrain(a.terrain_h as Int16Array, G, 1024, 0);
  const s = new TerrainSampler(terr.heights, G, 1024);
  const m = buildGround(a, s);
  const cls: Record<number, number> = {};
  if (m) { const gd = m.attrs!.gd.array; for (let i = 0; i < m.index.length; i += 3) { const c = gd[m.index[i] * 4]; cls[c] = (cls[c] ?? 0) + 1; } }
  console.log(k, 'G', G, 'tris', m ? m.index.length / 3 : 0, 'verts', m ? m.position.length / 3 : 0, 'ms', (performance.now() - t0).toFixed(0), JSON.stringify(cls));
}
