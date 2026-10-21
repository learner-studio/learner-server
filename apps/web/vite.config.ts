import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** In dev the API runs separately; proxy its paths so the app stays same-origin (session cookie). */
const api = process.env.LEARNER_URL ?? 'http://127.0.0.1:3010'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5180, proxy: { '/rpc': api, '/api': api } },
  build: { outDir: 'dist', emptyOutDir: true },
})
