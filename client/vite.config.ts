import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Self-contained bundle law: relative base, no runtime CDN, everything bundled.
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8790',
    },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
});
