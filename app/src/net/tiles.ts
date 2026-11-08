import type { NetDesc, TerrainDesc } from './core/desc';

export interface TileJson extends NetDesc {
  tile: [number, number];
}

export interface TerrainHeader { x0: number; y0: number; cell: number; nx: number; ny: number; base: number; enc?: string }

async function gunzip(res: Response): Promise<ArrayBuffer> {
  const ds = res.body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}

export function decodeTerrain(t: TerrainHeader, buf: ArrayBuffer | Uint8Array): TerrainDesc {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const n = t.nx * t.ny;
  if (bytes.byteLength < n * 2) throw new Error(`terrain: ${bytes.byteLength} bytes for ${t.nx}x${t.ny}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const h = new Float32Array(n);
  for (let r = 0; r < t.ny; r++) {
    let acc = 0;
    for (let c = 0; c < t.nx; c++) {
      const i = r * t.nx + c;
      const v = dv.getUint16(i * 2, true);
      acc = c === 0 ? v : (acc + v) & 0xffff;
      h[i] = t.base + acc / 100;
    }
  }
  return { x0: t.x0, y0: t.y0, cell: t.cell, nx: t.nx, ny: t.ny, h };
}

export async function loadTile(root: string, tx: number, ty: number): Promise<TileJson | null> {
  const [r, rt] = await Promise.all([fetch(`${root}/${tx}_${ty}.json.gz`), fetch(`${root}/${tx}_${ty}.dtm.gz`)]);
  if (!r.ok) return null;
  const j = JSON.parse(new TextDecoder().decode(await gunzip(r))) as Omit<TileJson, 'terrain'> & { terrain?: TerrainHeader };
  const out = j as unknown as TileJson;
  out.terrain = j.terrain && rt.ok ? decodeTerrain(j.terrain, await gunzip(rt)) : undefined;
  return out;
}
