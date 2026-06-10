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
const { getSystemMetrics } = require('../services/systemMetrics');

const CONTEXT_EXPIRY_MS = 5 * 60 * 1000; // prune camera context after 5 min idle
const RECENT_WINDOW_MS  = 60 * 1000;
const STREAM_ACTIVE_MS  = 3000;

const _metrics = {
  startedAt:           Date.now(),
  requestsTotal:       0,
  requestsInFlight:    0,
  errorsTotal:         0,
  framesTotal:         0,
  bytesReceivedTotal:  0,
  totalProcessingMs:   0,
  detectionsTotal:     0,
  trackedObjectsTotal: 0,
  facesTotal:          0,
  fireSmokeTotal:      0,
  loiteringTotal:      0,
  lastRequestAt:       null,
  lastResponseAt:      null,
  recentSamples:       [],
  perCamera:           new Map(),
};

function _getCameraMetric(cameraId) {
  if (_metrics.perCamera.has(cameraId)) return _metrics.perCamera.get(cameraId);
  const metric = {
    cameraName:          null,
    framesTotal:         0,
    bytesReceivedTotal:  0,
    totalProcessingMs:   0,
    detectionsTotal:     0,
    trackedObjectsTotal: 0,
    facesTotal:          0,
    fireSmokeTotal:      0,
    loiteringTotal:      0,
    lastFrameAt:         null,
    zoneCount:           0,
    recentFrameTimes:    [],
  };
  _metrics.perCamera.set(cameraId, metric);
  return metric;
}

function _pruneCameraRecentFrames(metric, now = Date.now()) {
  const cutoff = now - RECENT_WINDOW_MS;
  while (metric.recentFrameTimes.length > 0 && metric.recentFrameTimes[0] < cutoff) {
    metric.recentFrameTimes.shift();
  }
}

function _buildCameraInputSummary(metric, now = Date.now()) {
  _pruneCameraRecentFrames(metric, now);

  const framesLast1s = metric.recentFrameTimes.filter((at) => at >= now - 1000).length;
  const lastFrameAgeMs = metric.lastFrameAt ? (now - metric.lastFrameAt) : Number.POSITIVE_INFINITY;
  const streamPresent = Number.isFinite(lastFrameAgeMs) && lastFrameAgeMs <= STREAM_ACTIVE_MS;

  return {
    framesLast1s,
    inputFps1s: Number(framesLast1s.toFixed(2)),
    streamPresent,
  };
}

function _pruneRecentSamples(now = Date.now()) {
  const cutoff = now - RECENT_WINDOW_MS;
  while (_metrics.recentSamples.length > 0 && _metrics.recentSamples[0].at < cutoff) {
    _metrics.recentSamples.shift();
  }
}

function _buildRecentSummary(now = Date.now()) {
  _pruneRecentSamples(now);
  const samples = _metrics.recentSamples;
  const totals = {
    frames:         samples.length,
    bytesReceived:  0,
    processingMs:   0,
    detections:     0,
    trackedObjects: 0,
    faces:          0,
    fireSmoke:      0,
    loitering:      0,
  };

  for (const sample of samples) {
    totals.bytesReceived  += sample.bytesReceived;
    totals.processingMs   += sample.processingMs;
    totals.detections     += sample.detections;
    totals.trackedObjects += sample.trackedObjects;
    totals.faces          += sample.faces;
    totals.fireSmoke      += sample.fireSmoke;
    totals.loitering      += sample.loitering;
  }

  const windowSec = Math.max(1, Math.min(RECENT_WINDOW_MS / 1000, samples.length > 0
    ? Math.max(1, Math.round((now - samples[0].at) / 1000))
    : RECENT_WINDOW_MS / 1000));

  return {
    windowSec,
    frames:            totals.frames,
    framesPerSec:      Number((totals.frames / windowSec).toFixed(2)),
    bytesReceived:     totals.bytesReceived,
    bytesPerSec:       Number((totals.bytesReceived / windowSec).toFixed(2)),
    megabytesReceived: Number((totals.bytesReceived / (1024 * 1024)).toFixed(2)),
    avgProcessingMs:   Number(((totals.processingMs || 0) / Math.max(1, totals.frames)).toFixed(1)),
    detections:        totals.detections,
    trackedObjects:    totals.trackedObjects,
    faces:             totals.faces,
    fireSmoke:         totals.fireSmoke,
    loitering:         totals.loitering,
  };
}

function _getEnabledModules() {
  const config = analyticsConfig.getConfig();
  return Object.entries(config)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
    .sort();
}

function _getLoadedModels() {
  const path = require('path');
  const fs   = require('fs');
  const models = [];

  if (_detector) {
    const mp = _detector.modelPath;
    models.push({ name: path.basename(mp), path: mp, service: 'detector', loaded: true, exists: fs.existsSync(mp) });
  }

  if (_attrPipeline) {
    const ppe = _attrPipeline._ppe;
    if (ppe?.modelPath) {
      const mp = ppe.modelPath;
      models.push({ name: path.basename(mp), path: mp, service: 'ppe', loaded: ppe.ready ?? false, exists: fs.existsSync(mp) });
    }
    const face = _attrPipeline._face;
    if (face?.scrfdPath) {
      const mp = face.scrfdPath;
      models.push({ name: path.basename(mp), path: mp, service: 'face-detect', loaded: face.ready ?? false, exists: fs.existsSync(mp) });
    }
    if (face?.arcfacePath) {
      const mp = face.arcfacePath;
      models.push({ name: path.basename(mp), path: mp, service: 'face-embed', loaded: face.ready ?? false, exists: fs.existsSync(mp) });
    }
  }

  if (_fireSmokeService) {
    const mp = _fireSmokeService.modelPath;
    models.push({ name: path.basename(mp), path: mp, service: 'fire-smoke', loaded: true, exists: fs.existsSync(mp) });
  }

  return models;
}

// ── Shared AI services (eager-loaded at startup) ─────────────────────────────
let _detector         = null;
let _attrPipeline     = null;
let _fireSmokeService = null;
let _servicesReady    = false;

// Single promise guards concurrent callers — all waiters share the same load.
let _loadPromise = null;

async function _ensureServices() {
  if (_servicesReady) return;
  if (!_loadPromise) {
    _loadPromise = _loadServices();
  }
  await _loadPromise;
}

async function _loadServices() {
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
}

// Start loading immediately at module load — frames arriving before load completes
// will await the shared promise rather than timing out while models initialise.
setImmediate(() => {
  _ensureServices().catch(err => console.error('[AnalysisAPI] Startup model load error:', err.message));
});

// ── Per-camera stateful context (tracker + behavior) ─────────────────────────
// key: cameraId  value: { tracker, behavior, lastSeenAt }
const _cameraContexts = new Map();

function _getOrCreateContext(cameraId, zonesArray, cameraName) {
  if (_cameraContexts.has(cameraId)) {
    const ctx = _cameraContexts.get(cameraId);
    ctx.lastSeenAt = Date.now();
    // Refresh zones if provided
    if (zonesArray && zonesArray.length > 0) ctx._zones = zonesArray;
    if (cameraName) ctx.cameraName = cameraName;
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
    cameraName: cameraName || cameraId,
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
// Accepts two content-types:
//   image/jpeg  — binary JPEG body + JSON metadata in X-LTS-Meta header (preferred)
//   application/json — legacy: { cameraId, frameId, timestamp, frame: base64, zones }
function _isAbortError(err) {
  return err?.type === 'request.aborted' || err?.code === 'ECONNABORTED';
}

function _parseFrameBody(req, res, next) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  const parser = ct === 'image/jpeg'
    ? express.raw({ type: 'image/jpeg', limit: '10mb' })
    : express.json({ limit: '20mb' });

  parser(req, res, (err) => {
    if (err && _isAbortError(err)) {
      // Streaming server closed the socket before finishing body transfer
      // (timeout fired mid-send). Frame is irrelevant — drop silently.
      _metrics.errorsTotal++;
      return;
    }
    next(err);
  });
}

router.post('/frame', _parseFrameBody, async (req, res) => {
  const t0 = Date.now();
  try {
    let cameraId, cameraName, frameId, timestamp, zones = [], jpegBuffer;

    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct === 'image/jpeg') {
      // Binary mode: JPEG in body, lightweight JSON metadata in X-LTS-Meta header
      let meta = {};
      try {
        const raw = req.headers['x-lts-meta'] || '{}';
        // Accept both base64-encoded (new, supports non-ASCII names) and raw JSON (legacy)
        const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        meta = JSON.parse(jsonStr);
      } catch { /* ignore */ }
      cameraId  = meta.cameraId;
      cameraName = meta.cameraName;
      frameId   = meta.frameId;
      timestamp = meta.timestamp;
      zones     = meta.zones || [];
      jpegBuffer = req.body; // Buffer
    } else {
      // Legacy JSON mode
      const body = req.body || {};
      cameraId  = body.cameraId;
      cameraName = body.cameraName;
      frameId   = body.frameId;
      timestamp = body.timestamp;
      zones     = body.zones || [];
      if (!body.frame) {
        return res.status(400).json({ error: 'cameraId and frame (base64 JPEG) are required' });
      }
      jpegBuffer = Buffer.from(body.frame, 'base64');
    }

    if (!cameraId || !jpegBuffer?.length) {
      return res.status(400).json({ error: 'cameraId and frame are required' });
    }

    _metrics.requestsTotal += 1;
    _metrics.requestsInFlight += 1;
    _metrics.framesTotal += 1;
    _metrics.bytesReceivedTotal += jpegBuffer.length;
    _metrics.lastRequestAt = new Date().toISOString();

    const cameraMetric = _getCameraMetric(cameraId);
    cameraMetric.cameraName = cameraName || cameraMetric.cameraName || cameraId;
    cameraMetric.framesTotal += 1;
    cameraMetric.bytesReceivedTotal += jpegBuffer.length;
    const frameAt = Date.now();
    cameraMetric.lastFrameAt = frameAt;
    cameraMetric.recentFrameTimes.push(frameAt);
    _pruneCameraRecentFrames(cameraMetric, frameAt);
    cameraMetric.zoneCount = Array.isArray(zones) ? zones.length : 0;

    // Use the analysis server's own analyticsConfig (managed independently via its DB/settings).
    // remoteAnalyticsConfig from the streaming server is intentionally ignored here —
    // the analysis server admin controls which modules are enabled on this node.

    await _ensureServices();

    const ctx = _getOrCreateContext(cameraId, zones, cameraName);

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
    let detectedFaces = [];
    const anyAttrEnabled = ['face', 'mask', 'hat', 'color', 'cloth'].some(m => analyticsConfig.isEnabled(m));
    if (anyAttrEnabled && _attrPipeline?.anyReady) {
      try {
        const { enrichedObjects: e, detectedFaces: f } = await _attrPipeline.enrich(
          jpegBuffer, frameWidth, frameHeight, trackedObjects, zones,
          analyticsConfig.getConfig()
        );
        enrichedObjects = e;
        detectedFaces = f;
      } catch (err) {
        console.warn(`[AnalysisAPI] Attribute enrichment warn:`, err.message);
      }
    }

    const faceDetections = detectedFaces.map((f, i) => ({
      objectId:  90000 + (Number(frameId || 0) % 1000) * 10 + i,
      className: 'face',
      confidence: f.score,
      bbox: f.bbox,
      isLoitering: false,
      dwellTime: 0,
    }));

    // 5. Behavior engine
    const behaviorsResult = ctx.behavior.update(cameraId, enrichedObjects, timestamp || new Date().toISOString());
  const loiteringCount = (behaviorsResult || []).filter((b) => b.isLoitering || b.type === 'loitering').length;

    // 6. Fire / smoke
    let fireSmoke = [];
    const fireEnabled = analyticsConfig.isEnabled('fire');
    const smokeEnabled = analyticsConfig.isEnabled('smoke');
    if (_fireSmokeService && (fireEnabled || smokeEnabled)) {
      try {
        fireSmoke = await _fireSmokeService.detect(jpegBuffer, frameWidth, frameHeight);
        fireSmoke = fireSmoke.filter((d) =>
          (d.className === 'fire' && fireEnabled) ||
          (d.className === 'smoke' && smokeEnabled)
        );
      } catch { /* non-fatal */ }
    }

    const processingMs = Date.now() - t0;
    const ts = timestamp || new Date().toISOString();

    _metrics.totalProcessingMs += processingMs;
    _metrics.detectionsTotal += detections.length;
    _metrics.trackedObjectsTotal += enrichedObjects.length;
    _metrics.facesTotal += detectedFaces.length;
    _metrics.fireSmokeTotal += fireSmoke.length;
    _metrics.loiteringTotal += loiteringCount;
    _metrics.lastResponseAt = new Date().toISOString();
    _metrics.recentSamples.push({
      at:             Date.now(),
      bytesReceived:  jpegBuffer.length,
      processingMs,
      detections:     detections.length,
      trackedObjects: enrichedObjects.length,
      faces:          detectedFaces.length,
      fireSmoke:      fireSmoke.length,
      loitering:      loiteringCount,
    });
    _pruneRecentSamples();

    cameraMetric.totalProcessingMs += processingMs;
    cameraMetric.detectionsTotal += detections.length;
    cameraMetric.trackedObjectsTotal += enrichedObjects.length;
    cameraMetric.facesTotal += detectedFaces.length;
    cameraMetric.fireSmokeTotal += fireSmoke.length;
    cameraMetric.loiteringTotal += loiteringCount;

    // Results are returned in the HTTP response body so the calling streaming
    // server can emit Socket.IO events to browser clients via _processRemoteResult.
    // Direct Socket.IO emissions from the analysis server are intentionally omitted:
    // browsers connect to the streaming server, not here.
    const alertService = req.app.get('alertService');

    // ── Process behaviors: loitering alerts (alert persistence only) ──────────
    const behaviors = behaviorsResult || [];
    for (const b of behaviors) {
      if ((b.isLoitering || b.type === 'loitering') && alertService) {
        alertService.createAlert({ ...b, cameraId }).catch(() => {});
      }
    }

    res.json({
      cameraId,
      frameId,
      timestamp:    ts,
      detections,
      tracked:      enrichedObjects,
      detectedFaces,
      behaviors,
      fireSmoke,
      frameWidth,
      frameHeight,
      processingMs,
    });
  } catch (err) {
    _metrics.errorsTotal += 1;
    console.error('[AnalysisAPI] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    _metrics.requestsInFlight = Math.max(0, _metrics.requestsInFlight - 1);
  }
});

// ── GET /api/analysis/health ──────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({
    status:          'ok',
    mode:            'analysis',
    servicesReady:   _servicesReady,
    activeCameras:   _cameraContexts.size,
    detector:        _detector ? 'loaded' : (_loadPromise ? 'loading' : 'not-loaded'),
    attrPipeline:    _attrPipeline?.anyReady ? 'ready' : 'not-ready',
    fireSmokeService: _fireSmokeService ? 'loaded' : 'not-loaded',
    uptime:          process.uptime(),
  });
});

router.get('/metrics', (req, res) => {
  // In combined mode, PipelineManager accumulates local inference stats directly.
  // Delegate to it so the Analysis Dashboard reflects real data.
  const pm = req.app && req.app.get('pipelineManager');
  if (pm && typeof pm.getAnalysisMetrics === 'function') {
    return res.json(pm.getAnalysisMetrics());
  }

  const now = Date.now();
  const enabledModules = _getEnabledModules();
  const recent = _buildRecentSummary(now);
  const cameras = [];

  for (const [cameraId, ctx] of _cameraContexts) {
    const metric = _metrics.perCamera.get(cameraId) || _getCameraMetric(cameraId);
    const input = _buildCameraInputSummary(metric, now);
    cameras.push({
      cameraId,
      cameraName: ctx.cameraName || metric.cameraName || cameraId,
      idleSec:             Math.round((now - ctx.lastSeenAt) / 1000),
      streamPresent:       input.streamPresent,
      framesLast1s:        input.framesLast1s,
      inputFps1s:          input.inputFps1s,
      zoneCount:           ctx._zones.length,
      framesTotal:         metric.framesTotal,
      bytesReceivedTotal:  metric.bytesReceivedTotal,
      avgProcessingMs:     Number((metric.totalProcessingMs / Math.max(1, metric.framesTotal)).toFixed(1)),
      detectionsTotal:     metric.detectionsTotal,
      trackedObjectsTotal: metric.trackedObjectsTotal,
      facesTotal:          metric.facesTotal,
      fireSmokeTotal:      metric.fireSmokeTotal,
      loiteringTotal:      metric.loiteringTotal,
      lastFrameAt:         metric.lastFrameAt ? new Date(metric.lastFrameAt).toISOString() : null,
    });
  }

  cameras.sort((a, b) => (b.lastFrameAt || '').localeCompare(a.lastFrameAt || ''));

  res.json({
    status: 'ok',
    mode: 'analysis',
    uptimeSec: Math.round(process.uptime()),
    activeCameras: _cameraContexts.size,
    services: {
      detector:         _detector ? 'loaded' : (_loadPromise ? 'loading' : 'not-loaded'),
      attrPipeline:     _attrPipeline?.anyReady ? 'ready' : 'not-ready',
      fireSmokeService: _fireSmokeService ? 'loaded' : 'not-loaded',
    },
    modules: {
      enabled: enabledModules,
      count: enabledModules.length,
    },
    requests: {
      total:           _metrics.requestsTotal,
      inFlight:        _metrics.requestsInFlight,
      errors:          _metrics.errorsTotal,
      lastRequestAt:   _metrics.lastRequestAt,
      lastResponseAt:  _metrics.lastResponseAt,
      avgProcessingMs: Number((_metrics.totalProcessingMs / Math.max(1, _metrics.framesTotal)).toFixed(1)),
    },
    traffic: {
      bytesReceivedTotal: _metrics.bytesReceivedTotal,
      megabytesTotal:     Number((_metrics.bytesReceivedTotal / (1024 * 1024)).toFixed(2)),
    },
    results: {
      framesTotal:         _metrics.framesTotal,
      detectionsTotal:     _metrics.detectionsTotal,
      trackedObjectsTotal: _metrics.trackedObjectsTotal,
      facesTotal:          _metrics.facesTotal,
      fireSmokeTotal:      _metrics.fireSmokeTotal,
      loiteringTotal:      _metrics.loiteringTotal,
    },
    recent,
    cameras,
    models: _getLoadedModels(),
    system: getSystemMetrics(),
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
      cameraName: ctx.cameraName || id,
      idleSec:    Math.round((now - ctx.lastSeenAt) / 1000),
      zoneCount:  ctx._zones.length,
    });
  }
  res.json({ count: contexts.length, contexts });
});

// ── Router-level error handler ────────────────────────────────────────────────
// Belt-and-suspenders: catch any abort errors that escape _parseFrameBody
// (e.g. abort during async inference, not just body parsing).
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (_isAbortError(err)) {
    _metrics.errorsTotal++;
    return; // socket already closed — no response possible
  }
  _metrics.errorsTotal++;
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
