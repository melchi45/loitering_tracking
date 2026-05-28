import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend URL: HTTPS when HTTPS_ENABLED=true (default port 3443), else HTTP (3001)
const backendPort    = process.env.BACKEND_PORT  || (process.env.HTTPS_ENABLED === 'true' ? '3443' : '3001');
const backendProto   = process.env.HTTPS_ENABLED === 'true' ? 'https' : 'http';
const backendTarget  = `${backendProto}://localhost:${backendPort}`;

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
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,  // allow self-signed certs in development
      },
      '/auth': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/admin': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: backendTarget,
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
