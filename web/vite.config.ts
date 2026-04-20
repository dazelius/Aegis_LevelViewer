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
    },
  },
});
