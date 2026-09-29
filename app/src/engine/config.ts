// URL-driven runtime config.
//   ?data=data-synthetic   data root under /public (default: data, falls back to data-synthetic)
//   ?webgl=1               force the WebGL2 backend
//   ?cam=E,N,dist,headingDeg,pitchDeg   initial camera
//   ?stats=0               hide stats
const q = new URLSearchParams(location.search);

export const config = {
  dataRoot: q.get('data') ?? '',
  forceWebGL: q.get('webgl') === '1',
  cam: q.get('cam')?.split(',').map(Number) ?? null,
  lodScale: Number(q.get('lod') ?? 1),
  debug: q.get('debug') === '1',
};

/** Resolve the data root: explicit ?data wins; else "data" if its manifest exists, else "data-synthetic". */
export async function resolveDataRoot(): Promise<string> {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  if (config.dataRoot) return `${base}/${config.dataRoot.replace(/^\/|\/$/g, '')}`;
  try {
    const r = await fetch(`${base}/data/manifest.json`, { method: 'HEAD' });
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) return `${base}/data`;
  } catch {
    /* ignore */
  }
  return `${base}/data-synthetic`;
}
