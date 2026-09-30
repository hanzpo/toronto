// Serves the app (static assets) and the dataset from R2 on one origin.
// Every response gets COOP/COEP so the page is cross-origin isolated and can
// use SharedArrayBuffer between the sim worker and the renderer.
//
// Tiles are stored as one pack per level-2 tile (pipeline/tpipe/pack.py):
// /data/tiles/L/tx_ty.bin.gz is a range read inside packs/{tx2}_{ty2}.pack,
// /data/graph/tx_ty.bin.gz inside packs/g{tx2}_{ty2}.pack.
//
// Caching:
//   /assets/*        content-hashed → immutable for a year
//   /textures/*      a day, stale-while-revalidate
//   tiles / graph    ?v=<build> URLs → immutable, edge Cache API
//   *.json           no-cache + ETag (revalidations answer 304 without a body)
//   pack indexes     memoised per isolate and in the edge cache, so a cold
//                    isolate doesn't pay an extra R2 read before the range read
// Tile responses carry Server-Timing (edge cache hit / index / R2 ms) so the
// client (and RUM) can see where tile latency goes.
//
// RUM: POST /rum (JSON from the client) → Workers Analytics Engine when the
// `RUM` binding exists (see wrangler.jsonc); otherwise accepted and dropped.

interface Env {
  ASSETS: Fetcher
  DATA: R2Bucket
  RUM?: AnalyticsEngineDataset
}

const ISOLATION: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

const TILE_RE = /^\/data\/tiles\/(\d)\/(-?\d+)_(-?\d+)\.bin\.gz$/
const GRAPH_RE = /^\/data\/graph\/(-?\d+)_(-?\d+)\.bin\.gz$/
type PackIndex = Record<string, [number, number]>
const packIndex = new Map<string, Promise<PackIndex | null>>()

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries({ ...ISOLATION, ...extra })) out.headers.set(k, v)
  return out
}

// Keyed by pack + data build (?v=), so re-uploaded packs are picked up.
function loadIndex(env: Env, ctx: ExecutionContext, origin: string, pack: string, version: string) {
  const key = `${pack}@${version}`
  let p = packIndex.get(key)
  if (!p) {
    p = (async () => {
      // edge cache first (shared by every isolate in the colo), then R2
      const ck = new Request(`${origin}/__packidx/${pack}.json?v=${version}`)
      const hit = version ? await caches.default.match(ck) : undefined
      if (hit) return (await hit.json()) as PackIndex
      const o = await env.DATA.get(`packs/${pack}.idx.json`)
      if (!o) return null
      const text = await o.text()
      if (version) {
        ctx.waitUntil(caches.default.put(ck, new Response(text, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable' },
        })))
      }
      return JSON.parse(text) as PackIndex
    })()
    p.catch(() => packIndex.delete(key))
    packIndex.set(key, p)
  }
  return p
}

async function serveData(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const url = new URL(req.url)
  // JSON (manifest, transit index, landmarks) changes with each data upload:
  // revalidate every time, but answer unchanged files with 304.
  const isJson = path.endsWith('.json')
  const cacheable = !isJson
  const cache = caches.default
  const t0 = Date.now()
  const hit = cacheable ? await cache.match(req) : undefined
  if (hit) {
    const out = new Response(hit.body, hit)
    out.headers.set('Server-Timing', `cache;desc=hit;dur=${Date.now() - t0}`)
    return out
  }

  let res: Response
  const t = TILE_RE.exec(path)
  const g = t ? null : GRAPH_RE.exec(path)
  const m = t ?? (g ? [g[0], '0', g[1], g[2]] : null)
  if (m) {
    const [lv, tx, ty] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const f = 4 ** (2 - lv)
    const pack = `${g ? 'g' : ''}${Math.floor(tx / f)}_${Math.floor(ty / f)}`
    const version = url.searchParams.get('v') ?? ''
    const idx = await loadIndex(env, ctx, url.origin, pack, version)
    const tIdx = Date.now()
    const entry = idx?.[`${lv}/${tx}_${ty}`]
    if (!entry) return withHeaders(new Response('not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=3600' } }))
    const obj = await env.DATA.get(`packs/${pack}.pack`, { range: { offset: entry[0], length: entry[1] } })
    if (!obj) return withHeaders(new Response('not found', { status: 404 }))
    // URLs carry ?v=<data build>, so a given URL never changes: cache for a year
    const versioned = url.searchParams.has('v')
    res = new Response(obj.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(entry[1]),
        'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      },
    })
    res = withHeaders(res)
    const out = res.clone()
    ctx.waitUntil(cache.put(req, res))
    out.headers.set('Server-Timing', `cache;desc=miss, idx;dur=${tIdx - t0}, r2;dur=${Date.now() - tIdx}`)
    return out
  }

  const inm = req.headers.get('If-None-Match')
  const obj = await env.DATA.get(path.slice(1), inm ? { onlyIf: { etagDoesNotMatch: inm.replace(/^W\//, '').replace(/"/g, '') } } : {})
  if (!obj) return withHeaders(new Response('not found', { status: 404 }))
  const type = isJson ? 'application/json' : 'application/octet-stream'
  const headers = { 'Content-Type': type, 'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-cache', ETag: obj.httpEtag }
  if (!('body' in obj)) return withHeaders(new Response(null, { status: 304, headers })) // precondition failed → unchanged
  res = withHeaders(new Response(obj.body, { headers }))
  if (cacheable) ctx.waitUntil(cache.put(req, res.clone()))
  return res
}

/** Real-user metrics from the client (see app/src/engine/rum.ts). */
async function rum(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (env.RUM) {
    try {
      const b = (await req.json()) as Record<string, unknown>
      const num = (k: string) => (typeof b[k] === 'number' && isFinite(b[k] as number) ? (b[k] as number) : 0)
      const str = (k: string) => String(b[k] ?? '').slice(0, 64)
      const cf = (req as unknown as { cf?: { colo?: string; country?: string } }).cf
      env.RUM.writeDataPoint({
        indexes: [str('kind') || 'session'],
        blobs: [str('backend'), str('quality'), str('view'), cf?.colo ?? '', cf?.country ?? '', str('build')],
        doubles: [
          num('fps'), num('frameP50'), num('frameP95'), num('cpuMs'), num('longFrames'),
          num('tileP50'), num('tileP95'), num('tileHitRate'), num('tiles'),
          num('firstFrameMs'), num('settledMs'), num('drawCalls'), num('triangles'), num('dpr'),
        ],
      })
    } catch {
      return new Response('bad request', { status: 400 })
    }
  }
  return new Response(null, { status: 204 })
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/rum') return rum(req, env)
    if (url.pathname.startsWith('/data/')) {
      if (req.method === 'HEAD') {
        const res = await serveData(new Request(req.url, { method: 'GET', headers: req.headers }), env, ctx, url.pathname)
        return new Response(null, { status: res.status, headers: res.headers })
      }
      if (req.method !== 'GET') return withHeaders(new Response('method not allowed', { status: 405 }))
      return serveData(req, env, ctx, url.pathname)
    }
    const res = await env.ASSETS.fetch(req)
    if (res.status === 200 && url.pathname.startsWith('/assets/')) {
      // Vite output is content-hashed: never revalidate
      return withHeaders(res, { 'Cache-Control': 'public, max-age=31536000, immutable' })
    }
    if (res.status === 200 && url.pathname.startsWith('/textures/')) {
      return withHeaders(res, { 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' })
    }
    if (res.status === 200 && url.pathname === '/sw.js') {
      return withHeaders(res, { 'Cache-Control': 'no-cache' })
    }
    return withHeaders(res)
  },
} satisfies ExportedHandler<Env>
