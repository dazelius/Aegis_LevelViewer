import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `AEGISGRAM_APP_BASE` lets us deploy under a reverse-proxy sub-path
// (e.g. `/api/v1/ai-tools/21/proxy/` on the UAAutoTool platform).
// Vite uses it for:
//   - asset URLs in the emitted index.html (`<script src>`, `<link href>`)
//   - `import.meta.env.BASE_URL` for runtime use by API / WS / router
// Default `/` keeps local dev and plain-root deploys working unchanged.
const APP_BASE = (() => {
  const raw = (process.env.AEGISGRAM_APP_BASE || '/').trim();
  if (!raw) return '/';
  // Vite requires a trailing slash to treat the value as a directory.
  return raw.endsWith('/') ? raw : `${raw}/`;
})();

export default defineConfig({
  base: APP_BASE,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.LEVEL_VIEWER_PORT
          ? `http://localhost:${process.env.LEVEL_VIEWER_PORT}`
          : 'http://localhost:3101',
        changeOrigin: true,
      },
      // Multiplayer WebSocket — `ws: true` makes Vite proxy HTTP-101
      // Upgrade frames through to the backend. Without this the
      // browser's `new WebSocket('ws://localhost:5173/ws/...')`
      // handshake reaches Vite itself and gets a 404.
      '/ws': {
        target: process.env.LEVEL_VIEWER_PORT
          ? `http://localhost:${process.env.LEVEL_VIEWER_PORT}`
          : 'http://localhost:3101',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
