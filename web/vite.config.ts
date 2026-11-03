import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend (API + HLS edge) for local development. Override with STREAMHUB_BACKEND=http://host:port
const backend = process.env.STREAMHUB_BACKEND ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // SSE (/api/channels/:slug/events) streams through this proxy as-is.
      '/api': { target: backend, changeOrigin: false },
      '/hls': { target: backend, changeOrigin: false },
      // Uploaded avatars (v2).
      '/media': { target: backend, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/hls': { target: backend, changeOrigin: false },
      '/media': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    // hls.js (full build) is ~600 kB and lives in its own lazy chunk.
    chunkSizeWarningLimit: 700,
  },
});
