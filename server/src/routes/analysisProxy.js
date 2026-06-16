'use strict';

/**
 * analysisProxy.js — Proxy for analysis server read-only endpoints.
 *
 * Mounted at /api/analysis when SERVER_MODE=streaming.
 * Forwards GET requests to ANALYSIS_SERVER_URL so the dashboard can poll
 * metrics without the browser needing direct (cross-origin) access to the
 * analysis server.
 *
 * Supported:
 *   GET /api/analysis/metrics  → proxied to remote /api/analysis/metrics
 *   GET /api/analysis/health   → proxied to remote /api/analysis/health
 *   GET /api/analysis/contexts → proxied to remote /api/analysis/contexts
 */

const http    = require('http');
const https   = require('https');
const { URL } = require('url');
const express = require('express');

const router = express.Router();

const ANALYSIS_URL   = process.env.ANALYSIS_SERVER_URL || '';
const PROXY_TIMEOUT  = 5000;

// Keep-alive agents to reuse TLS/TCP connections across repeated polls.
const httpAgent  = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({
  keepAlive:          true,
  rejectUnauthorized: process.env.NODE_ENV === 'production',
});

function proxyGet(targetPath, req, res) {
  if (!ANALYSIS_URL) {
    return res.status(503).json({ error: 'ANALYSIS_SERVER_URL not configured' });
  }

  let base;
  try {
    base = new URL(ANALYSIS_URL);
  } catch {
    return res.status(503).json({ error: 'Invalid ANALYSIS_SERVER_URL' });
  }

  const isHttps = base.protocol === 'https:';
  const mod     = isHttps ? https : http;
  const opts    = {
    hostname: base.hostname,
    port:     base.port || (isHttps ? 443 : 80),
    path:     targetPath,
    method:   'GET',
    timeout:  PROXY_TIMEOUT,
    agent:    isHttps ? httpsAgent : httpAgent,
  };

  const proxyReq = mod.request(opts, (proxyRes) => {
    let raw = '';
    proxyRes.on('data', c => { raw += c; });
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(raw);
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Analysis server timeout' });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: `Analysis server unreachable: ${err.message}` });
  });

  proxyReq.end();
}

function proxyMethod(method, targetPath, res) {
  if (!ANALYSIS_URL) {
    return res.status(503).json({ error: 'ANALYSIS_SERVER_URL not configured' });
  }
  let base;
  try { base = new URL(ANALYSIS_URL); } catch {
    return res.status(503).json({ error: 'Invalid ANALYSIS_SERVER_URL' });
  }
  const isHttps = base.protocol === 'https:';
  const mod     = isHttps ? https : http;
  const opts    = {
    hostname: base.hostname,
    port:     base.port || (isHttps ? 443 : 80),
    path:     targetPath,
    method,
    timeout:  PROXY_TIMEOUT,
    agent:    isHttps ? httpsAgent : httpAgent,
  };
  const proxyReq = mod.request(opts, (proxyRes) => {
    let raw = '';
    proxyRes.on('data', c => { raw += c; });
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(raw);
    });
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Analysis server timeout' }); });
  proxyReq.on('error', (err) => { if (!res.headersSent) res.status(502).json({ error: `Analysis server unreachable: ${err.message}` }); });
  proxyReq.end();
}

router.get('/metrics',           (req, res) => proxyGet('/api/analysis/metrics',           req, res));
router.get('/health',            (req, res) => proxyGet('/api/analysis/health',            req, res));
router.get('/contexts',          (req, res) => proxyGet('/api/analysis/contexts',          req, res));
router.get('/config/fire-smoke', (req, res) => proxyGet('/api/analysis/config/fire-smoke', req, res));
router.get('/events',            (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyGet(`/api/analysis/events${qs}`, req, res);
});
router.get('/detection-tracks',  (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyGet(`/api/analysis/detection-tracks${qs}`, req, res);
});
router.get('/detection-snapshots', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyGet(`/api/analysis/detection-snapshots${qs}`, req, res);
});
router.delete('/detection-tracks', (_req, res) => {
  proxyMethod('DELETE', '/api/analysis/detection-tracks', res);
});
router.delete('/events', (_req, res) => {
  proxyMethod('DELETE', '/api/analysis/events', res);
});

// All other methods / paths are not proxied
router.use((_req, res) => {
  res.status(404).json({ error: 'Not available in streaming mode' });
});

module.exports = router;
