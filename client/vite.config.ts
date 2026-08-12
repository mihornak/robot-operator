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
    rollupOptions: {
      // lab.html is a second entry: the graphics lab (src/lab/). It ships with
      // the build so the tuned look can be reviewed from the deployed URL, and
      // it costs the game nothing — nothing in src/ imports it.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab.html', import.meta.url)),
      },
    },
  },
});
