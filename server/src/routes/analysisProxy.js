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
 *   GET /api/analysis/metrics            → proxied to remote
 *   GET /api/analysis/health             → proxied to remote
 *   GET /api/analysis/contexts           → proxied to remote
 *   GET /api/analysis/detection-tracks   → proxied; falls back to streaming server local DB
 *   GET /api/analysis/detection-snapshots → proxied; falls back to streaming server local DB
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

// ── Local fallback helpers ────────────────────────────────────────────────────

function _localDetectionTracks(req, res) {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ tracks: [], total: 0, source: 'local-streaming', error: 'DB unavailable' });
  let tracks = db.find('detectionTracks', {});
  const { cameraId, from, to, class: cls } = req.query;
  const lim = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  if (cameraId) tracks = tracks.filter(t => t.cameraId === cameraId);
  if (cls)      tracks = tracks.filter(t => t.className === cls);
  if (from) { const f = new Date(from).getTime(); tracks = tracks.filter(t => new Date(t.lastSeenAt).getTime() >= f); }
  if (to)   { const u = new Date(to).getTime();   tracks = tracks.filter(t => new Date(t.firstSeenAt).getTime() <= u); }
  tracks = tracks.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime()).slice(0, lim);
  res.json({ tracks, total: tracks.length, source: 'local-streaming' });
}

function _localDetectionSnapshots(req, res) {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ snapshots: [], total: 0, source: 'local-streaming', error: 'DB unavailable' });
  const { objectId, cameraId } = req.query;
  if (!objectId) return res.status(400).json({ error: 'objectId required' });
  let snaps = db.find('detectionSnapshots', { objectId });
  if (cameraId) snaps = snaps.filter(s => s.cameraId === cameraId);
  const lim = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  snaps = snaps.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, lim);
  res.json({ snapshots: snaps, total: snaps.length, source: 'local-streaming' });
}

function proxyGetWithFallback(targetPath, req, res, fallback) {
  if (!ANALYSIS_URL) return fallback(req, res);
  let base;
  try { base = new URL(ANALYSIS_URL); } catch { return fallback(req, res); }
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
      if (proxyRes.statusCode >= 500 && !res.headersSent) return fallback(req, res);
      if (!res.headersSent) res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(raw);
    });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) fallback(req, res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) fallback(req, res);
  });
  proxyReq.end();
}

// Merged: analysis server result + local streaming DB result (by objectId dedup)
function proxyGetMerged(targetPath, req, res, localFn) {
  if (!ANALYSIS_URL) return localFn(req, res);
  let base;
  try { base = new URL(ANALYSIS_URL); } catch { return localFn(req, res); }
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
      if (proxyRes.statusCode >= 500 && !res.headersSent) return localFn(req, res);
      let remoteData = { tracks: [], total: 0 };
      try { remoteData = JSON.parse(raw); } catch (_) { return localFn(req, res); }
      if (res.headersSent) return;

      // Merge local streaming tracks with remote analysis tracks
      const db = req.app.get('db');
      const localTracks = db ? _getLocalTracks(req.query, db) : [];

      // Deduplicate by objectId: remote takes precedence (more up-to-date)
      const remoteTracks = Array.isArray(remoteData.tracks) ? remoteData.tracks : [];
      const seenObjectIds = new Set(remoteTracks.map(t => t.objectId));
      const onlyLocal = localTracks.filter(t => !seenObjectIds.has(t.objectId));
      const merged = [...remoteTracks, ...onlyLocal];

      // Re-sort by firstSeenAt descending and enforce limit
      const lim = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
      merged.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());
      const result = merged.slice(0, lim);
      res.json({ tracks: result, total: result.length, source: 'merged' });
    });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) localFn(req, res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) localFn(req, res);
  });
  proxyReq.end();
}

function _getLocalTracks(query, db) {
  let tracks = db.find('detectionTracks', {});
  const { cameraId, from, to, class: cls } = query;
  const lim = Math.min(parseInt(query.limit, 10) || 200, 1000);
  if (cameraId) tracks = tracks.filter(t => t.cameraId === cameraId);
  if (cls)      tracks = tracks.filter(t => t.className === cls);
  if (from) { const f = new Date(from).getTime(); tracks = tracks.filter(t => new Date(t.lastSeenAt).getTime() >= f); }
  if (to)   { const u = new Date(to).getTime();   tracks = tracks.filter(t => new Date(t.firstSeenAt).getTime() <= u); }
  return tracks.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime()).slice(0, lim);
}

// Merged: analysis server snapshots + local streaming DB snapshots (dedup by id)
function proxyGetMergedSnapshots(targetPath, req, res, localFn) {
  if (!ANALYSIS_URL) return localFn(req, res);
  let base;
  try { base = new URL(ANALYSIS_URL); } catch { return localFn(req, res); }
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
      if (proxyRes.statusCode >= 500 && !res.headersSent) return localFn(req, res);
      let remoteData = { snapshots: [], total: 0 };
      try { remoteData = JSON.parse(raw); } catch (_) { return localFn(req, res); }
      if (res.headersSent) return;

      const db = req.app.get('db');
      const { objectId, cameraId } = req.query;
      const lim = Math.min(parseInt(req.query.limit, 10) || 20, 100);

      let localSnaps = [];
      if (db && objectId) {
        localSnaps = db.find('detectionSnapshots', { objectId });
        if (cameraId) localSnaps = localSnaps.filter(s => s.cameraId === cameraId);
      }

      const remoteSnaps = Array.isArray(remoteData.snapshots) ? remoteData.snapshots : [];
      const seenIds = new Set(remoteSnaps.map(s => s.id));
      const onlyLocal = localSnaps.filter(s => !seenIds.has(s.id));
      const merged = [...remoteSnaps, ...onlyLocal];
      merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      const result = merged.slice(0, lim);
      res.json({ snapshots: result, total: result.length, source: 'merged' });
    });
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) localFn(req, res); });
  proxyReq.on('error', () => { if (!res.headersSent) localFn(req, res); });
  proxyReq.end();
}

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
  proxyGetMerged(`/api/analysis/detection-tracks${qs}`, req, res, _localDetectionTracks);
});
router.get('/detection-snapshots', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  proxyGetMergedSnapshots(`/api/analysis/detection-snapshots${qs}`, req, res, _localDetectionSnapshots);
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
