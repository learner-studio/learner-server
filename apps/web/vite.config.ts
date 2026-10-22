import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** In dev the API runs separately; proxy its paths so the app stays same-origin (session cookie). */
const api = process.env.LEARNER_URL ?? 'http://127.0.0.1:3010'
/**
 * `LEARNER_WEB_BASE` prefixes the asset URLs and, through `import.meta.env.BASE_URL`,
 * the API calls (see src/lib/api.ts). The default `/` serves the app from the API's
 * own root; `build:proxied` builds the copy nginx serves under /learner/ on a host
 * whose /assets, /rpc and /api belong to another app.
 */
export default defineConfig({
  base: process.env.LEARNER_WEB_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  // learner-web.service runs this dev server behind nginx at dev.biztoolz.app/learner/ (HMR over the same websocket).
  server: { host: '127.0.0.1', port: 5180, strictPort: true, allowedHosts: ['dev.biztoolz.app', 'localhost', '127.0.0.1'], proxy: { '/rpc': api, '/api': api } },
  build: { outDir: 'dist', emptyOutDir: true },
})
