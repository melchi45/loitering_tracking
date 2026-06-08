'use strict';

/**
 * Analysis API — used when SERVER_MODE=analysis
 *
 * Exposes:
 *   POST /api/analysis/frame  — receive JPEG frame, run AI, return results
 *   GET  /api/analysis/health — liveness probe for streaming servers
 *
 * Per-camera state (tracker + behavior engine) is kept in memory.
 * Stale contexts (> CONTEXT_EXPIRY_MS of inactivity) are pruned automatically.
 */

const express       = require('express');
const router        = express.Router();
const DetectionService = require('../services/detection');
const { ByteTracker }  = require('../services/tracking');
const BehaviorEngine   = require('../services/behaviorEngine');
const AttributePipeline = require('../services/attributePipeline');
const FireSmokeService  = require('../services/fireSmokeService');
const analyticsConfig   = require('../services/analyticsConfig');

const CONTEXT_EXPIRY_MS = 5 * 60 * 1000; // prune camera context after 5 min idle

// ── Shared AI services (lazy-loaded on first request) ────────────────────────
let _detector       = null;
let _attrPipeline   = null;
let _fireSmokeService = null;
let _servicesLoading  = false;
let _servicesReady    = false;

async function _ensureServices() {
  if (_servicesReady) return;
  if (_servicesLoading) {
    // Wait for in-progress load
    await new Promise(r => setTimeout(r, 200));
    if (_servicesReady) return;
  }
  _servicesLoading = true;
  try {
    _detector = new DetectionService();
    await _detector.load();
    console.log('[AnalysisAPI] Detection service loaded');
  } catch (err) {
    console.warn('[AnalysisAPI] Detection service load failed:', err.message);
    _detector = null;
  }
  try {
    _attrPipeline = new AttributePipeline();
    await _attrPipeline.load();
    console.log('[AnalysisAPI] AttributePipeline loaded');
  } catch (err) {
    console.warn('[AnalysisAPI] AttributePipeline load warn:', err.message);
    _attrPipeline = null;
  }
  try {
    _fireSmokeService = new FireSmokeService();
    await _fireSmokeService.load();
    console.log('[AnalysisAPI] FireSmokeService loaded');
  } catch (err) {
    console.warn('[AnalysisAPI] FireSmokeService load warn:', err.message);
    _fireSmokeService = null;
  }
  _servicesReady = true;
  _servicesLoading = false;
}

// ── Per-camera stateful context (tracker + behavior) ─────────────────────────
// key: cameraId  value: { tracker, behavior, lastSeenAt }
const _cameraContexts = new Map();

function _getOrCreateContext(cameraId, zonesArray) {
  if (_cameraContexts.has(cameraId)) {
    const ctx = _cameraContexts.get(cameraId);
    ctx.lastSeenAt = Date.now();
    // Refresh zones if provided
    if (zonesArray && zonesArray.length > 0) ctx._zones = zonesArray;
    return ctx;
  }

  // Build a lightweight zone manager shim from the passed zone array.
  // The BehaviorEngine only calls zoneManager.getActiveZones(cameraId).
  const zoneShim = {
    _zones: zonesArray || [],
    getActiveZones(_cameraId) { return this._zones; },
  };

  const ctx = {
    tracker:    new ByteTracker(),
    behavior:   new BehaviorEngine(zoneShim),
    _zones:     zonesArray || [],
    lastSeenAt: Date.now(),
  };
  _cameraContexts.set(cameraId, ctx);
  return ctx;
}

// Prune idle contexts every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, ctx] of _cameraContexts) {
    if (now - ctx.lastSeenAt > CONTEXT_EXPIRY_MS) {
      _cameraContexts.delete(id);
      console.log(`[AnalysisAPI] Pruned idle context for camera ${id.slice(0, 8)}`);
    }
  }
}, 60_000).unref();

// ── POST /api/analysis/frame ──────────────────────────────────────────────────
router.post('/frame', express.json({ limit: '20mb' }), async (req, res) => {
  const t0 = Date.now();
  try {
    const {
      cameraId,
      frameId,
      timestamp,
      frame,
      zones           = [],
      analyticsConfig: remoteAnalyticsConfig,
    } = req.body;

    if (!cameraId || !frame) {
      return res.status(400).json({ error: 'cameraId and frame (base64 JPEG) are required' });
    }

    const jpegBuffer = Buffer.from(frame, 'base64');

    // Merge remote analytics config into local (remote takes precedence)
    if (remoteAnalyticsConfig) {
      analyticsConfig.mergeRemote(remoteAnalyticsConfig);
    }

    await _ensureServices();

    const ctx = _getOrCreateContext(cameraId, zones);

    // 1. Detection
    let detections  = [];
    let frameWidth  = 0;
    let frameHeight = 0;
    if (_detector && analyticsConfig.anyDetectionEnabled()) {
      try {
        const result = await _detector.detect(jpegBuffer);
        detections  = result.detections.filter(d => analyticsConfig.isClassEnabled(d.className));
        frameWidth  = result.frameWidth;
        frameHeight = result.frameHeight;
      } catch (err) {
        console.error(`[AnalysisAPI][${cameraId.slice(0,8)}] Detection error:`, err.message);
      }
    }

    // 2. Fast colour pre-pass (before tracker so multi-cue matching can use colour)
    if (analyticsConfig.isEnabled('color') && _attrPipeline?.ready) {
      await Promise.all(detections.map(async (det) => {
        if (det.className !== 'person') return;
        try {
          det.color = await _attrPipeline.fastColor(jpegBuffer, det.bbox, frameWidth, frameHeight);
        } catch { /* non-fatal */ }
      }));
    }

    // 3. Tracking
    const trackedObjects = ctx.tracker.update(detections);

    // 4. Attribute enrichment (face / PPE / color)
    let enrichedObjects = trackedObjects;
    const anyAttrEnabled = ['face', 'mask', 'hat', 'color', 'cloth'].some(m => analyticsConfig.isEnabled(m));
    if (anyAttrEnabled && _attrPipeline?.anyReady) {
      try {
        const { enrichedObjects: e } = await _attrPipeline.enrich(
          jpegBuffer, frameWidth, frameHeight, trackedObjects, zones,
          analyticsConfig.getConfig()
        );
        enrichedObjects = e;
      } catch (err) {
        console.warn(`[AnalysisAPI] Attribute enrichment warn:`, err.message);
      }
    }

    // 5. Behavior engine
    const behaviorsResult = ctx.behavior.update(cameraId, enrichedObjects, timestamp || new Date().toISOString());

    // 6. Fire / smoke
    let fireSmoke = [];
    if (_fireSmokeService && analyticsConfig.isEnabled('fire')) {
      try {
        fireSmoke = await _fireSmokeService.detect(jpegBuffer);
      } catch { /* non-fatal */ }
    }

    const processingMs = Date.now() - t0;

    res.json({
      cameraId,
      frameId,
      timestamp:    timestamp || new Date().toISOString(),
      detections,
      tracked:      enrichedObjects,
      behaviors:    behaviorsResult || [],
      fireSmoke,
      frameWidth,
      frameHeight,
      processingMs,
    });
  } catch (err) {
    console.error('[AnalysisAPI] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analysis/health ──────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({
    status:          'ok',
    mode:            'analysis',
    servicesReady:   _servicesReady,
    activeCameras:   _cameraContexts.size,
    detector:        _detector ? 'loaded' : (_servicesLoading ? 'loading' : 'not-loaded'),
    attrPipeline:    _attrPipeline?.anyReady ? 'ready' : 'not-ready',
    fireSmokeService: _fireSmokeService ? 'loaded' : 'not-loaded',
    uptime:          process.uptime(),
  });
});

// ── GET /api/analysis/contexts ────────────────────────────────────────────────
// Returns per-camera context summary (for debugging)
router.get('/contexts', (_req, res) => {
  const now = Date.now();
  const contexts = [];
  for (const [id, ctx] of _cameraContexts) {
    contexts.push({
      cameraId:   id,
      idleSec:    Math.round((now - ctx.lastSeenAt) / 1000),
      zoneCount:  ctx._zones.length,
    });
  }
  res.json({ count: contexts.length, contexts });
});

module.exports = router;
