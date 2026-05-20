import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    host: '0.0.0.0',   // Accessible from the entire LAN (default 127.0.0.1 is local-only)
    open: false,        // Prevent VSCode from repeatedly opening the browser on port detection
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
