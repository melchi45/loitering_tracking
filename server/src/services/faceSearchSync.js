'use strict';

/**
 * Streaming-side push of the current faceGalleries/faceGalleryFaces state to the analysis
 * server, so its dashboard can display an "Active Face Search" count without a second
 * matching engine. Modeled on _forwardToAnalysis() in api/analytics.js: fire-and-forget,
 * own keep-alive Agent, short timeout, warn-only on failure — never blocks the caller.
 *
 * pushReconcile() is called two ways: immediately after every gallery/face mutation, and
 * unconditionally on a 5s interval (startAutoSync). Both paths send the identical full
 * snapshot — there is no incremental diff to get wrong, and the analysis server self-heals
 * from a missed push on the next tick.
 */

const https = require('https');
const http  = require('http');

const ANALYSIS_URL = process.env.ANALYSIS_SERVER_URL || '';
const SYNC_INTERVAL_MS = 5000;

const _httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const _httpAgent  = new http.Agent({ keepAlive: true });

function _buildSnapshot(db) {
  const galleries = db.all('faceGalleries').map((g) => ({
    id: g.id, name: g.name, description: g.description, type: g.type, createdAt: g.createdAt,
  }));
  const faces = db.all('faceGalleryFaces').map((f) => ({
    id: f.id, galleryId: f.galleryId, name: f.name, thumbnail: f.thumbnail,
    bbox: f.bbox, score: f.score, createdAt: f.createdAt,
    // embedding intentionally omitted — the analysis-side mirror is display-only
  }));
  return { galleries, faces };
}

function pushReconcile(db) {
  if (!ANALYSIS_URL) return;
  let base;
  try { base = new URL(ANALYSIS_URL); } catch { return; }

  const body    = JSON.stringify(_buildSnapshot(db));
  const isHttps = base.protocol === 'https:';
  const mod     = isHttps ? https : http;
  const opts    = {
    hostname: base.hostname,
    port:     base.port || (isHttps ? 443 : 80),
    path:     '/api/analysis/face-search-conditions/sync',
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout:  4000,
    agent:    isHttps ? _httpsAgent : _httpAgent,
  };
  const req = mod.request(opts, (res) => {
    res.resume();
    if (res.statusCode >= 400) {
      console.warn(`[FaceSearchSync] pushReconcile HTTP ${res.statusCode}`);
    }
  });
  req.on('error', (err) => console.warn('[FaceSearchSync] pushReconcile failed:', err.message));
  req.on('timeout', () => { req.destroy(); console.warn('[FaceSearchSync] pushReconcile timeout'); });
  req.write(body);
  req.end();
}

function startAutoSync(db) {
  if (!ANALYSIS_URL) return;
  pushReconcile(db);
  setInterval(() => pushReconcile(db), SYNC_INTERVAL_MS).unref();
}

module.exports = { pushReconcile, startAutoSync };
