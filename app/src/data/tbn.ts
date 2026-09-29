// Reader for the TBN1 container (see docs/SPEC.md). Arrays are zero-copy views.

export type TypedArray =
  | Int8Array | Uint8Array | Int16Array | Uint16Array
  | Int32Array | Uint32Array | Float32Array | Float64Array;

const CTORS = {
  i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array,
  i32: Int32Array, u32: Uint32Array, f32: Float32Array, f64: Float64Array,
} as const;

type DType = keyof typeof CTORS;

export interface Tbn<H = Record<string, unknown>> {
  header: H & { arrays: Record<string, [DType, number, number]> };
  arrays: Record<string, TypedArray>;
}

export function decodeTbn<H = Record<string, unknown>>(buf: ArrayBuffer): Tbn<H> {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'TBN1') throw new Error(`bad magic ${magic}`);
  const hl = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  let base = 8 + hl;
  base += (8 - (base % 8)) % 8;
  const arrays: Record<string, TypedArray> = {};
  for (const [name, [dt, off, n]] of Object.entries(header.arrays as Record<string, [DType, number, number]>)) {
    arrays[name] = new CTORS[dt](buf, base + off, n);
  }
  return { header, arrays };
}

export async function gunzip(res: Response): Promise<ArrayBuffer> {
  const ds = res.body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}

export async function fetchTbn<H = Record<string, unknown>>(url: string, signal?: AbortSignal): Promise<Tbn<H> | null> {
  const res = await fetch(url, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return decodeTbn<H>(await gunzip(res));
}
