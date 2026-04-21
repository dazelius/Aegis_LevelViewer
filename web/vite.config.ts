import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
