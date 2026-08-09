import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the built site works from ANY GitHub Pages path
  // (user.github.io/ OR user.github.io/repo-name/) without reconfiguration.
  base: './',
  plugins: [react(), tailwindcss()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // jSquash packages resolve their own .wasm binaries at runtime; pre-bundling
    // rewrites those URLs and breaks them.
    exclude: [
      '@jsquash/avif',
      '@jsquash/jpeg',
      '@jsquash/png',
      '@jsquash/webp',
    ],
  },
  build: {
    // Never inline .wasm — the codecs must stay as separate fetchable assets.
    assetsInlineLimit: 0,
    target: 'es2022',
  },
})
