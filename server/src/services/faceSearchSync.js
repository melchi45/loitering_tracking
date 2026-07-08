'use strict';

/**
 * Bidirectional sync of faceGalleries/faceGalleryFaces between a streaming server and its
 * analysis server. Modeled on _forwardToAnalysis() in api/analytics.js: fire-and-forget,
 * own keep-alive Agent, short timeout, warn-only on failure — never blocks the caller.
 *
 * Outbound (streaming → analysis): this server's own conditions, embedding stripped —
 * the analysis-side copy is display-only (its "Active Face Search" dashboard count), never
 * consulted for matching there.
 *
 * Inbound (analysis → streaming, same round trip): the analysis server's response carries
 * ITS OWN locally-registered conditions (e.g. added directly on its dashboard), WITH
 * embeddings intact, so they become locally matchable here too via
 * pipelineManager.reloadPersistentGallery().
 *
 * pushReconcile() is called two ways: immediately after every gallery/face mutation, and
 * unconditionally on a 5s interval (startAutoSync). Both paths send the identical full
 * snapshot — there is no incremental diff to get wrong, and either side self-heals from a
 * missed round trip on the next tick.
 */

const https = require('https');
const http  = require('http');
const faceSearchConditions = require('./faceSearchConditions');

const ANALYSIS_URL = process.env.ANALYSIS_SERVER_URL || '';
const SYNC_INTERVAL_MS = 5000;

const _httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const _httpAgent  = new http.Agent({ keepAlive: true });

function _buildOutboundSnapshot(db) {
  const { galleries: allGalleries, faces: allFaces } = faceSearchConditions.exportLocal(db);
  const galleries = allGalleries.map((g) => ({
    id: g.id, name: g.name, description: g.description, type: g.type, createdAt: g.createdAt,
  }));
  const faces = allFaces.map((f) => ({
    id: f.id, galleryId: f.galleryId, name: f.name, thumbnail: f.thumbnail,
    bbox: f.bbox, score: f.score, createdAt: f.createdAt,
    // embedding intentionally omitted — the analysis-side mirror is display-only
  }));
  return { galleries, faces };
}

function _postJson(base, pathname, body) {
  return new Promise((resolve, reject) => {
    const isHttps = base.protocol === 'https:';
    const mod     = isHttps ? https : http;
    const opts    = {
      hostname: base.hostname,
      port:     base.port || (isHttps ? 443 : 80),
      path:     pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  4000,
      agent:    isHttps ? _httpsAgent : _httpAgent,
    };
    const req = mod.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * @param {import('../db').db} db
 * @param {import('./pipelineManager')|null} [pipelineManager]  Reload trigger for the
 *   inbound direction — omit only in contexts where local live matching doesn't apply.
 */
async function pushReconcile(db, pipelineManager = null) {
  if (!ANALYSIS_URL) return;
  let base;
  try { base = new URL(ANALYSIS_URL); } catch { return; }

  try {
    const body = JSON.stringify(_buildOutboundSnapshot(db));
    const inbound = await _postJson(base, '/api/analysis/face-search-conditions/sync', body);
    if (inbound && (inbound.galleries || inbound.faces)) {
      faceSearchConditions.applyReconcile(db, inbound);
      if (pipelineManager && typeof pipelineManager.reloadPersistentGallery === 'function') {
        pipelineManager.reloadPersistentGallery();
      }
    }
  } catch (err) {
    console.warn('[FaceSearchSync] pushReconcile failed:', err.message);
  }
}

function startAutoSync(db, pipelineManager = null) {
  if (!ANALYSIS_URL) return;
  pushReconcile(db, pipelineManager);
  setInterval(() => pushReconcile(db, pipelineManager), SYNC_INTERVAL_MS).unref();
}

module.exports = { pushReconcile, startAutoSync };
