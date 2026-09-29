import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// COOP/COEP make the page cross-origin isolated so SharedArrayBuffer works
// (sim worker <-> renderer). Production sets the same headers in the Worker.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation },
  worker: { format: 'es' },
})
