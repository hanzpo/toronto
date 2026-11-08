import type { NetDesc } from './core/desc';

export interface TileJson extends NetDesc {
  tile: [number, number];
}

async function gunzipJson(res: Response): Promise<unknown> {
  const ds = res.body!.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(ds).text());
}

export async function loadTile(root: string, tx: number, ty: number): Promise<TileJson | null> {
  const r = await fetch(`${root}/${tx}_${ty}.json.gz`);
  if (!r.ok) return null;
  const j = (await gunzipJson(r)) as TileJson & { terrain?: { x0: number; y0: number; cell: number; nx: number; ny: number; base: number; cm: string } };
  if (j.terrain && 'cm' in j.terrain) {
    const t = j.terrain;
    const bin = atob(t.cm);
    const u = new Uint16Array(bin.length / 2);
    for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    const h = new Float32Array(u.length);
    for (let i = 0; i < u.length; i++) h[i] = t.base + u[i] / 100;
    (j as NetDesc).terrain = { x0: t.x0, y0: t.y0, cell: t.cell, nx: t.nx, ny: t.ny, h };
  }
  return j;
}
