import { it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { build } from '../core/build';
import type { NetDesc } from '../core/desc';
import { decodeTerrain, type TerrainHeader } from '../tiles';

const ROOT = process.env.NET_ROOT ?? 'public/data/net';

function pick(): string[] {
  if (process.env.NET_TILES) return process.env.NET_TILES.split(' ');
  const idx = JSON.parse(readFileSync(`${ROOT}/index.json`, 'utf8')) as { tiles: { tile: [number, number] }[] };
  const all = idx.tiles.map((t) => `${t.tile[0]}_${t.tile[1]}`);
  const out = new Set<string>(all.includes('-2_-1') ? ['-2_-1'] : []);
  const n = Number(process.env.NET_RANDOM ?? 5);
  while (out.size < Math.min(all.length, n + 1)) out.add(all[Math.floor(Math.random() * all.length)]);
  return [...out];
}

it('builds mapped tiles', { timeout: 600000 }, () => {
  const fails: string[] = [];
  for (const t of pick()) {
    const j = JSON.parse(gunzipSync(readFileSync(`${ROOT}/${t}.json.gz`)).toString()) as NetDesc & { terrain?: TerrainHeader };
    const dtm = `${ROOT}/${t}.dtm.gz`;
    const desc = { ...j, terrain: j.terrain && existsSync(dtm) ? decodeTerrain(j.terrain, gunzipSync(readFileSync(dtm))) : undefined } as NetDesc;
    const t0 = performance.now();
    try {
      const b = build(desc);
      const kinds: Record<string, number> = {};
      for (const n of b.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
      let tris = 0;
      for (const m of b.meshes.values()) tris += m.idx.length / 3;
      const rv: Record<string, number> = {};
      for (const r of b.review) rv[r.kind] = (rv[r.kind] ?? 0) + 1;
      console.log(t, `${(performance.now() - t0).toFixed(0)} ms`, { segs: j.segments.length, own: j.own?.segs.length, cell: desc.terrain?.cell, tris, lanes: b.lanes.length, kinds, rv });
    } catch (e) {
      fails.push(`${t}: ${(e as Error).stack ?? e}`);
      console.log(t, 'FAILED', (e as Error).stack);
    }
  }
  if (fails.length) throw new Error(fails.join('\n'));
});
