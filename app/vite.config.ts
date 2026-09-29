import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'

// COOP/COEP make the page cross-origin isolated so SharedArrayBuffer works
// (sim worker <-> renderer). Production sets the same headers in the Worker.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Serve *.gz data files as opaque bytes. Vite's static server would add
// `Content-Encoding: gzip`, which makes browsers decode (or choke on) them;
// the client gunzips TBN files itself with DecompressionStream.
function rawGz(): Plugin {
  const handler = (root: string) => (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
    const url = (req.url ?? '').split('?')[0]
    if (!url.endsWith('.gz')) return next()
    const file = join(root, decodeURIComponent(url))
    let size = 0
    try { size = statSync(file).size } catch { res.statusCode = 404; res.end(); return }
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(size))
    res.setHeader('Cache-Control', 'no-cache')
    for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v)
    createReadStream(file).pipe(res)
  }
  return {
    name: 'raw-gz',
    configureServer(server) { server.middlewares.use(handler(join(server.config.root, 'public'))) },
    configurePreviewServer(server) { server.middlewares.use(handler(join(server.config.root, 'dist'))) },
  }
}

export default defineConfig({
  plugins: [rawGz(), react()],
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation },
  worker: { format: 'es' },
})
