'use strict';

/**
 * Analysis server launcher — starts this codebase in SERVER_MODE=analysis.
 *
 * Overrides .env settings so the process acts as a pure AI inference server:
 *   - No camera capture, no WebRTC
 *   - Listens on HTTP only (loopback, port 3082 by default)
 *   - Exposes POST /api/analysis/frame and GET /api/analysis/health
 *
 * Usage:
 *   node src/scripts/analysisServer.js       # production-like
 *   npm run dev:analysis                     # nodemon auto-restart
 *
 * Configure via .env:
 *   ANALYSIS_HTTP_PORT=3082   (override listen port)
 */

const path = require('path');

// Load .env BEFORE overriding anything
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
} catch (_) {}

// ── Analysis mode overrides ──────────────────────────────────────────────────
// Must be set before requiring index.js (const SERVER_MODE = process.env.SERVER_MODE
// is evaluated at module-load time).
process.env.SERVER_MODE     = 'analysis';
process.env.HTTP_PORT       = String(parseInt(process.env.ANALYSIS_HTTP_PORT || '3082', 10));
process.env.HTTPS_ENABLED   = 'false';    // loopback-only; TLS not needed
process.env.WEBRTC_DISABLED = '1';        // no mediasoup / no capture
process.env.ANALYSIS_SERVER_URL = '';     // prevent recursive forwarding

// Keep AUTH_ENABLED as-is. The streaming server and analysis server share the
// same JWT_SECRET so tokens from the streaming server are valid here too.
// If you want auth-free inter-process calls, set AUTH_ENABLED=false in .env.

require('../index.js');
