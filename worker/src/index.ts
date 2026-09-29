// Serves the app (static assets) and the dataset from R2 on one origin.
// Every response gets COOP/COEP so the page is cross-origin isolated and can
// use SharedArrayBuffer between the sim worker and the renderer.
//
// Tiles are stored as one pack per level-2 tile (pipeline/tpipe/pack.py):
// /data/tiles/L/tx_ty.bin.gz is a range read inside packs/{tx2}_{ty2}.pack,
// /data/graph/tx_ty.bin.gz inside packs/g{tx2}_{ty2}.pack.

interface Env {
  ASSETS: Fetcher
  DATA: R2Bucket
}

const ISOLATION: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

const TILE_RE = /^\/data\/tiles\/(\d)\/(-?\d+)_(-?\d+)\.bin\.gz$/
const GRAPH_RE = /^\/data\/graph\/(-?\d+)_(-?\d+)\.bin\.gz$/
const packIndex = new Map<string, Promise<Record<string, [number, number]> | null>>()

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries({ ...ISOLATION, ...extra })) out.headers.set(k, v)
  return out
}

function loadIndex(env: Env, pack: string) {
  let p = packIndex.get(pack)
  if (!p) {
    p = env.DATA.get(`packs/${pack}.idx.json`).then((o) => (o ? o.json() : null))
    packIndex.set(pack, p)
  }
  return p
}

async function serveData(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const cache = caches.default
  const hit = await cache.match(req)
  if (hit) return hit

  let res: Response
  const t = TILE_RE.exec(path)
  const g = t ? null : GRAPH_RE.exec(path)
  const m = t ?? (g ? [g[0], '0', g[1], g[2]] : null)
  if (m) {
    const [lv, tx, ty] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const f = 4 ** (2 - lv)
    const pack = `${g ? 'g' : ''}${Math.floor(tx / f)}_${Math.floor(ty / f)}`
    const idx = await loadIndex(env, pack)
    const entry = idx?.[`${lv}/${tx}_${ty}`]
    if (!entry) return withHeaders(new Response('not found', { status: 404 }))
    const obj = await env.DATA.get(`packs/${pack}.pack`, { range: { offset: entry[0], length: entry[1] } })
    if (!obj) return withHeaders(new Response('not found', { status: 404 }))
    res = new Response(obj.body, {
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' },
    })
  } else {
    const obj = await env.DATA.get(path.slice(1))
    if (!obj) return withHeaders(new Response('not found', { status: 404 }))
    const type = path.endsWith('.json') ? 'application/json' : 'application/octet-stream'
    res = new Response(obj.body, {
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', ETag: obj.httpEtag },
    })
  }
  res = withHeaders(res)
  ctx.waitUntil(cache.put(req, res.clone()))
  return res
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/data/')) {
      if (req.method === 'HEAD') {
        const res = await serveData(new Request(req.url, { method: 'GET', headers: req.headers }), env, ctx, url.pathname)
        return new Response(null, { status: res.status, headers: res.headers })
      }
      if (req.method !== 'GET') return withHeaders(new Response('method not allowed', { status: 405 }))
      return serveData(req, env, ctx, url.pathname)
    }
    return withHeaders(await env.ASSETS.fetch(req))
  },
} satisfies ExportedHandler<Env>
