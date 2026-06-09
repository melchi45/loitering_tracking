'use strict';

const https   = require('https');
const http    = require('http');
const express = require('express');
const { getConfig, setConfig } = require('../services/analyticsConfig');

const router = express.Router();

const SERVER_MODE    = process.env.SERVER_MODE || 'combined';
const ANALYSIS_URL   = process.env.ANALYSIS_SERVER_URL || '';

// Keep-alive agents for forwarding to analysis server
const _httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const _httpAgent  = new http.Agent({ keepAlive: true });

/**
 * Forward analytics config update to the analysis server so that AI inference
 * uses the same settings that the user configured in the streaming-server UI.
 * Non-fatal: failures are logged but do not block the local save.
 */
function _forwardToAnalysis(updates) {
  if (!ANALYSIS_URL) return;
  let base;
  try { base = new URL(ANALYSIS_URL); } catch { return; }

  const body    = JSON.stringify(updates);
  const isHttps = base.protocol === 'https:';
  const mod     = isHttps ? https : http;
  const opts    = {
    hostname: base.hostname,
    port:     base.port || (isHttps ? 443 : 80),
    path:     '/api/analytics/config',
    method:   'PUT',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout:  4000,
    agent:    isHttps ? _httpsAgent : _httpAgent,
  };
  const req = mod.request(opts, (res) => {
    res.resume(); // drain
    if (res.statusCode >= 400) {
      console.warn(`[Analytics] forward to analysis server HTTP ${res.statusCode}`);
    }
  });
  req.on('error', (err) => console.warn('[Analytics] forward to analysis server failed:', err.message));
  req.on('timeout', () => { req.destroy(); console.warn('[Analytics] forward to analysis server timeout'); });
  req.write(body);
  req.end();
}

// GET /api/analytics/config
router.get('/config', (req, res) => {
  res.json({ success: true, data: getConfig() });
});

// PUT /api/analytics/config  { human: true, face: false, ... }
router.put('/config', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ success: false, error: 'Body must be an object.' });
  }
  const config = setConfig(updates);
  // In streaming mode, the analysis server holds the live AI state — keep it in sync.
  if (SERVER_MODE === 'streaming') _forwardToAnalysis(updates);
  res.json({ success: true, data: config });
});

module.exports = router;
