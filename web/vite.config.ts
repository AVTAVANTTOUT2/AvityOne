import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run build` → web/dist, served by src/server.ts. `npm run dev:web` proxies the API to a local server.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: { proxy: { '/api': 'http://127.0.0.1:7710' } },
});
