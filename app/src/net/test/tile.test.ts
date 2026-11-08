import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { build } from '../core/build';
import type { NetDesc } from '../core/desc';

it('builds a mapped tile', { timeout: 300000 }, () => {
  for (const t of ['-2_-1', '-1_-1', '-2_-2', '-1_-2']) {
    const j = JSON.parse(gunzipSync(readFileSync(`public/data-net/net/${t}.json.gz`)).toString()) as NetDesc & { terrain: { cm: string; base: number; nx: number; ny: number; x0: number; y0: number; cell: number } };
    const raw = Buffer.from(j.terrain.cm, 'base64');
    const u = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    j.terrain = { ...j.terrain, h: Float32Array.from(u, (v) => j.terrain.base + v / 100) } as never;
    const t0 = performance.now();
    const b = build(j);
    const kinds: Record<string, number> = {};
    for (const n of b.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    let tris = 0;
    for (const m of b.meshes.values()) tris += m.idx.length / 3;
    const rv: Record<string, number> = {};
    for (const r of b.review) rv[r.kind] = (rv[r.kind] ?? 0) + 1;
    console.log(t, `${(performance.now() - t0).toFixed(0)} ms`, { segs: j.segments.length, tris, lanes: b.lanes.length, kinds, rv });
  }
});
