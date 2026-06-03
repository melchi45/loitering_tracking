import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Read server/.env to get the correct backend configuration.
// This avoids manual duplication of HTTPS_ENABLED / PORT settings into client env files.
function loadServerEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, '../server/.env');
  if (!fs.existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) result[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return result;
}

const senv = loadServerEnv();

// Backend URL: prefer explicit BACKEND_PORT / HTTPS_ENABLED env, fall back to server/.env
const httpsEnabled = (process.env.HTTPS_ENABLED ?? senv.HTTPS_ENABLED) === 'true';
const backendPort  = process.env.BACKEND_PORT
  ?? (httpsEnabled ? (senv.HTTPS_PORT || '3443') : (senv.HTTP_PORT || senv.PORT || '3080'));
const backendProto  = httpsEnabled ? 'https' : 'http';
const backendTarget = `${backendProto}://localhost:${backendPort}`;

// When the backend uses HTTPS (self-signed), serve Vite dev server over HTTPS too.
// This ensures OAuth cookies (Secure; SameSite=Lax) set on localhost:3443 are sent
// back to localhost:3080, and the browser only needs to trust the cert once.
const certDir = path.resolve(__dirname, '../server/certs');
const httpsConfig = httpsEnabled && fs.existsSync(path.join(certDir, 'server.key'))
  ? {
      key:  fs.readFileSync(path.join(certDir, 'server.key')),
      cert: fs.readFileSync(path.join(certDir, 'server.crt')),
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    host: '0.0.0.0',   // Accessible from the entire LAN (default 127.0.0.1 is local-only)
    open: false,        // Prevent VSCode from repeatedly opening the browser on port detection
    port: parseInt(process.env.VITE_PORT || '3080'),
    https: httpsConfig,
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
