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

// Exposed to client runtime code (build-time constants, not env files) so the
// browser bundle can know this deployment's actual configured ports without
// guessing — see RTSPOverWebSocketView.tsx, which needs the real HTTPS_PORT/HTTP_PORT
// as a fallback for window.location.port (empty only when the page itself is
// served on the protocol-default port 443/80, e.g. behind a reverse proxy —
// hardcoding 443/80 as that fallback would be wrong for this project, whose
// actual defaults are 3443/3080).
const httpsPort = senv.HTTPS_PORT || '3443';
const httpPort  = senv.HTTP_PORT || senv.PORT || '3080';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages project pages are served from https://<user>.github.io/<repo>/,
  // not the domain root, so asset URLs need the /<repo>/ prefix — only applied
  // when building via .github/workflows/deploy-pages.yml (GITHUB_PAGES=true).
  // Local dev and self-hosted production builds keep root-relative '/'.
  base: process.env.GITHUB_PAGES === 'true' ? '/loitering_tracking/' : '/',
  define: {
    __LTS_HTTPS_PORT__: JSON.stringify(httpsPort),
    __LTS_HTTP_PORT__: JSON.stringify(httpPort),
  },
  build: {
    outDir: 'dist',
    // @melchi45/rtsp-over-websocket's zipWorker/audiotranscoderWorker chunks (<4KB, Vite's
    // default assetsInlineLimit) get base64-inlined as `data:text/javascript,...` Worker
    // URLs instead of emitted as real files. Those worker scripts then resolve a sibling
    // asset via a relative `new URL('../foo.js', self.location.href)` — but `self.location`
    // for a Worker built from a `data:` URL IS that data: URL, and data: URLs have an
    // opaque path (WHATWG URL spec), so relative resolution against them throws
    // "Failed to construct 'URL': Invalid URL", killing every RTSP-over-WebSocket channel
    // at worker startup. Disabling inlining forces every such asset to a real /assets/
    // file with a resolvable http(s) base. See RTSPOverWebSocketView.tsx.
    assetsInlineLimit: 0,
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
      '/health': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/internal': {
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
      // RTSP-over-WebSocket bridge (2026-07-23) — see
      // server/src/services/rtspOverWebSocketServer.js /
      // docs/design/Design_RTSP_Over_WebSocket.md §4.2.
      '/StreamingServer': {
        target: backendTarget,
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
