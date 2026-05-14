import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    // dev-only: adjust port as needed (only for local dev, not used in production)
    port: parseInt(process.env.VITE_PORT || '5173'),
    proxy: {
      '/api': `http://localhost:${process.env.BACKEND_PORT || '3001'}`,
      '/socket.io': {
        target: `http://localhost:${process.env.BACKEND_PORT || '3001'}`,
        ws: true,
      },
    },
  },
});
