import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is set from BASE_PATH so the same build works on GitHub Pages
// (served from /<repo>/) and on Cloudflare Pages / Netlify (served from /).
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  // manifold-3d ships a .wasm next to its JS; Vite must not try to bundle it.
  optimizeDeps: { exclude: ['manifold-3d'] },
  assetsInclude: ['**/*.wasm'],
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
