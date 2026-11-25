import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // shared/ holds code the web app, the pipeline and the tools all use (see docs/plans/shared-ladder.md).
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)) } },
  server: {
    // shared/ sits next to web/, outside Vite's default file-serving root.
    fs: { allow: ['..'] },
    // The upload page talks to the local pipeline server (node pipeline/bin/serve.mjs) same-origin,
    // so it sends no CORS headers and EventSource needs no special handling.
    proxy: { '/api/pipeline': 'http://127.0.0.1:8790' },
  },
  test: {
    // Tests must not depend on a developer's web/.env.local: pin every base URL. Empty means "not configured".
    env: {
      VITE_LOCAL_BASE: 'http://localhost:8788',
      VITE_LOCAL_BASE_H1: '',
      VITE_LOCAL_BASE_H2: '',
      VITE_LOCAL_BASE_H3: '',
      VITE_S3_BASE: '',
      VITE_S3_NEAR_BASE: '',
      VITE_S3_FAR_BASE: '',
      VITE_CDN_BASE: '',
      VITE_ADS_BASE: '',
    },
  },
})
