'use strict';

/**
 * Analysis API — used when SERVER_MODE=analysis
 *
 * Exposes:
 *   POST /api/analysis/frame               — receive JPEG frame, run AI, return results
 *   GET  /api/analysis/health              — liveness probe for streaming servers
 *   GET  /api/analysis/events              — recent analysis events (fire/smoke/loitering)
 *   DELETE /api/analysis/events            — clear all persisted analysis events
 *   GET  /api/analysis/models              — list YOLO model catalog with download/active status
 *   POST /api/analysis/models/switch       — hot-swap active YOLO model
 *   POST /api/analysis/models/download     — download a YOLO model from Ultralytics
 *   GET  /api/analysis/models/download-progress/:id — SSE stream for download progress
 *
 * Per-camera state (tracker + behavior engine) is kept in memory.
 * Stale contexts (> CONTEXT_EXPIRY_MS of inactivity) are pruned automatically.
 */

const crypto        = require('crypto');
const express       = require('express');
const router        = express.Router();
const DetectionService = require('../services/detection');
const { ByteTracker }  = require('../services/tracking');
const BehaviorEngine   = require('../services/behaviorEngine');
const AttributePipeline = require('../services/attributePipeline');
const FireSmokeService  = require('../services/fireSmokeService');
const analyticsConfig   = require('../services/analyticsConfig');
const { getSystemMetrics } = require('../services/systemMetrics');
const snapshotSvc      = require('../services/snapshotService');
const { extractFaceForEnrollment } = require('../services/faceEnrollHelper');
const faceSearchConditions = require('../services/faceSearchConditions');

// ── YOLO Model catalog ────────────────────────────────────────────────────────
// Each entry = one downloadable ONNX model.  file is relative to server/models/.
const MODEL_CATALOG = [
  // YOLO26 series (Ultralytics 2026 — NMS-free end-to-end, edge-optimised)
  // Ultralytics releases only .pt for YOLO26; ONNX is produced by `ultralytics export`.
  // requiresConversion: true → download handler fetches .pt then runs Python export.
  // Output format identical to YOLO11/v8: [1, 84, 8400] — no parser changes needed.
  { id: 'yolo26n', label: 'YOLO26n', series: 'YOLO26', size: 640, mAP: 40.9, cpuMs: 38.9,  t4Ms: 1.7,  params: '2.4M',  flops: '5.4B',   file: 'yolo26n.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt', requiresConversion: true },
  { id: 'yolo26s', label: 'YOLO26s', series: 'YOLO26', size: 640, mAP: 48.6, cpuMs: 87.2,  t4Ms: 2.5,  params: '9.5M',  flops: '20.7B',  file: 'yolo26s.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26s.pt', requiresConversion: true },
  { id: 'yolo26m', label: 'YOLO26m', series: 'YOLO26', size: 640, mAP: 53.1, cpuMs: 220.0, t4Ms: 4.7,  params: '20.4M', flops: '68.2B',  file: 'yolo26m.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26m.pt', requiresConversion: true },
  { id: 'yolo26l', label: 'YOLO26l', series: 'YOLO26', size: 640, mAP: 55.0, cpuMs: 286.2, t4Ms: 6.2,  params: '24.8M', flops: '86.4B',  file: 'yolo26l.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26l.pt', requiresConversion: true },
  { id: 'yolo26x', label: 'YOLO26x', series: 'YOLO26', size: 640, mAP: 57.5, cpuMs: 525.8, t4Ms: 11.8, params: '55.7M', flops: '193.9B', file: 'yolo26x.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26x.pt', requiresConversion: true },
  // YOLOv12 series (Ultralytics 2025 — attention-based architecture)
  // Ultralytics releases only .pt for YOLO12; ONNX is produced by `ultralytics export`.
  // requiresConversion: true → download handler fetches .pt then runs Python export.
  // Output format identical to YOLO11/v8: [1, 84, 8400] — no parser changes needed.
  { id: 'yolo12n', label: 'YOLO12n', series: 'YOLO12', size: 640, mAP: 40.6, cpuMs: 58.0,  t4Ms: 1.6,  params: '2.6M',  flops: '6.5B',   file: 'yolo12n.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12n.pt', requiresConversion: true },
  { id: 'yolo12s', label: 'YOLO12s', series: 'YOLO12', size: 640, mAP: 48.0, cpuMs: 95.0,  t4Ms: 2.7,  params: '9.3M',  flops: '21.5B',  file: 'yolo12s.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12s.pt', requiresConversion: true },
  { id: 'yolo12m', label: 'YOLO12m', series: 'YOLO12', size: 640, mAP: 52.5, cpuMs: 192.0, t4Ms: 5.0,  params: '20.2M', flops: '68.0B',  file: 'yolo12m.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12m.pt', requiresConversion: true },
  { id: 'yolo12l', label: 'YOLO12l', series: 'YOLO12', size: 640, mAP: 53.7, cpuMs: 250.0, t4Ms: 6.5,  params: '26.4M', flops: '88.9B',  file: 'yolo12l.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12l.pt', requiresConversion: true },
  { id: 'yolo12x', label: 'YOLO12x', series: 'YOLO12', size: 640, mAP: 55.2, cpuMs: 490.0, t4Ms: 12.0, params: '59.1M', flops: '199.0B', file: 'yolo12x.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo12x.pt', requiresConversion: true },
  // YOLO11 series (Ultralytics 2024)
  { id: 'yolo11n', label: 'YOLO11n', series: 'YOLO11', size: 640, mAP: 39.5, cpuMs: 56.1,  t4Ms: 1.5,  params: '2.6M',  flops: '6.5B',   file: 'yolo11n.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.onnx' },
  { id: 'yolo11s', label: 'YOLO11s', series: 'YOLO11', size: 640, mAP: 47.0, cpuMs: 90.0,  t4Ms: 2.5,  params: '9.4M',  flops: '21.5B',  file: 'yolo11s.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s.onnx' },
  { id: 'yolo11m', label: 'YOLO11m', series: 'YOLO11', size: 640, mAP: 51.5, cpuMs: 183.2, t4Ms: 4.7,  params: '20.1M', flops: '68.0B',  file: 'yolo11m.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11m.onnx' },
  { id: 'yolo11l', label: 'YOLO11l', series: 'YOLO11', size: 640, mAP: 53.4, cpuMs: 238.6, t4Ms: 6.2,  params: '25.3M', flops: '86.9B',  file: 'yolo11l.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11l.onnx' },
  { id: 'yolo11x', label: 'YOLO11x', series: 'YOLO11', size: 640, mAP: 54.7, cpuMs: 462.8, t4Ms: 11.3, params: '56.9M', flops: '194.9B', file: 'yolo11x.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11x.onnx' },
  // YOLOv8 series
  { id: 'yolov8n', label: 'YOLOv8n', series: 'YOLOv8', size: 640, mAP: 37.3, cpuMs: 80.4,  t4Ms: 1.47, params: '3.2M',  flops: '8.7B',   file: 'yolov8n.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.onnx' },
  { id: 'yolov8s', label: 'YOLOv8s', series: 'YOLOv8', size: 640, mAP: 44.9, cpuMs: 128.4, t4Ms: 2.66, params: '11.2M', flops: '28.6B',  file: 'yolov8s.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8s.onnx' },
  { id: 'yolov8m', label: 'YOLOv8m', series: 'YOLOv8', size: 640, mAP: 50.2, cpuMs: 234.7, t4Ms: 5.86, params: '25.9M', flops: '78.9B',  file: 'yolov8m.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8m.onnx' },
  { id: 'yolov8l', label: 'YOLOv8l', series: 'YOLOv8', size: 640, mAP: 52.9, cpuMs: 375.2, t4Ms: 9.06, params: '43.7M', flops: '165.2B', file: 'yolov8l.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8l.onnx' },
  { id: 'yolov8x', label: 'YOLOv8x', series: 'YOLOv8', size: 640, mAP: 53.9, cpuMs: 479.1, t4Ms: 14.37,params: '68.2M', flops: '257.8B', file: 'yolov8x.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8x.onnx' },
];

// Download progress state: id → { percent, status, error }
const _downloadProgress = new Map();

const CONTEXT_EXPIRY_MS         = 5 * 60 * 1000; // prune camera context after 5 min idle
const RECENT_WINDOW_MS          = 60 * 1000;
const STREAM_ACTIVE_MS          = 3000;
const MAX_PERSISTED_EVENTS      = 500;            // cap DB collection size
const FIRE_SMOKE_SAVE_COOLDOWN  = 30_000;         // ms between saves for same camera+class
const LOITERING_SAVE_COOLDOWN   = 60_000;         // ms between saves for same camera+objectId

// Per-camera+class cooldown maps — prevent burst writes on every frame
const _fireSmokeEventCooldown = new Map(); // key: `${cameraId}:${className}`
const _loiteringEventCooldown = new Map(); // key: `${cameraId}:${objectId}`

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

// ── Re-ID utilities (shared with pipelineManager logic) ───────────────────────

const FACE_MATCH_THRESH     = 0.35;
const FACE_EXPIRY_MS        = 30_000;
const CLOTHING_MATCH_THRESH = 0.75;
const CLOTHING_EXPIRY_MS    = 300_000;

function _cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function _bboxClose(a, b, tol = 3) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x      - b.x)      <= tol &&
    Math.abs(a.y      - b.y)      <= tol &&
    Math.abs(a.width  - b.width)  <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}

function _clothingAppearSim(a, b) {
  const MAX_DIST = 441.67;
  let score = 0, w = 0;
  if (a.upperRgb && b.upperRgb) {
    const dr = a.upperRgb[0]-b.upperRgb[0], dg = a.upperRgb[1]-b.upperRgb[1], db = a.upperRgb[2]-b.upperRgb[2];
    const colorSim = 1 - Math.sqrt(dr*dr+dg*dg+db*db)/MAX_DIST;
    let typeSim = 0.5;
    if (a.upper && b.upper && a.upper !== 'unknown' && b.upper !== 'unknown') typeSim = a.upper === b.upper ? 1 : 0;
    score += 0.60*(0.55*colorSim+0.45*typeSim); w += 0.60;
  }
  if (a.lowerRgb && b.lowerRgb) {
    const dr = a.lowerRgb[0]-b.lowerRgb[0], dg = a.lowerRgb[1]-b.lowerRgb[1], db = a.lowerRgb[2]-b.lowerRgb[2];
    const colorSim = 1 - Math.sqrt(dr*dr+dg*dg+db*db)/MAX_DIST;
    let typeSim = 0.5;
    if (a.lower && b.lower && a.lower !== 'unknown' && b.lower !== 'unknown') typeSim = a.lower === b.lower ? 1 : 0;
    score += 0.40*(0.50*colorSim+0.50*typeSim); w += 0.40;
  }
  return w > 0 ? score/w : 0;
}

// ── Face Re-ID + Person Trajectory state (analysis mode, module-level) ────────
let _sharedFaceGallery    = [];
let _faceCounter          = 1;
let _crossCameraFaceStats = new Map();
let _personTrajectory     = new Map();
let _personAliasCounter   = 0;

// ── Clothing Re-ID state (analysis mode, module-level) ────────────────────────
let _sharedClothingGallery = [];
let _clothingCounter       = 1;
let _crossClothingStats    = new Map();

/**
 * Perform cross-camera face Re-ID for analysis mode.
 * Mirrors pipelineManager._assignFaceIds() but uses module-level gallery state.
 * @returns {{ namedFaces, crossCameraTransitions }}
 */
function _assignFaceIdsAnalysis(cameraId, detectedFaces, now) {
  _sharedFaceGallery = _sharedFaceGallery.filter(g => now - g.lastSeenAt < FACE_EXPIRY_MS);
  const usedIds = new Set();
  const crossCameraTransitions = [];

  const namedFaces = detectedFaces.map(face => {
    if (!face.embedding) return { ...face, faceId: `F${_faceCounter++}` };

    let bestEntry = null, bestScore = FACE_MATCH_THRESH;
    for (const g of _sharedFaceGallery) {
      if (usedIds.has(g.faceId)) continue;
      const sim = _cosineSim(face.embedding, g.embedding);
      if (sim > bestScore) { bestScore = sim; bestEntry = g; }
    }

    if (bestEntry) {
      const prevCameraId = bestEntry.lastCameraId;
      if (prevCameraId !== cameraId) {
        const stats = _crossCameraFaceStats.get(bestEntry.faceId) || { faceId: bestEntry.faceId, firstCameraId: prevCameraId, lastCameraId: prevCameraId, transitionCount: 0, lastSeenAt: bestEntry.lastSeenAt };
        stats.transitionCount++; stats.lastCameraId = cameraId; stats.lastSeenAt = now;
        _crossCameraFaceStats.set(bestEntry.faceId, stats);
        crossCameraTransitions.push({ faceId: bestEntry.faceId, prevCameraId, newCameraId: cameraId, similarity: bestScore, timestamp: now, faceBbox: face.bbox });
      }
      bestEntry.lastSeenAt = now; bestEntry.lastCameraId = cameraId;
      usedIds.add(bestEntry.faceId);
      return { ...face, faceId: bestEntry.faceId, matchScore: bestScore };
    }

    const newId = `F${_faceCounter++}`;
    _sharedFaceGallery.push({ faceId: newId, embedding: face.embedding, lastSeenAt: now, lastCameraId: cameraId });
    return { ...face, faceId: newId };
  });

  return { namedFaces, crossCameraTransitions };
}

/**
 * Perform cross-camera clothing Re-ID for analysis mode.
 * Mirrors pipelineManager._assignClothingIds().
 */
function _assignClothingIdsAnalysis(cameraId, enrichedObjects, now, oIdToFaceId = new Map()) {
  _sharedClothingGallery = _sharedClothingGallery.filter(g => now - g.lastSeenAt < CLOTHING_EXPIRY_MS);
  const crossCameraTransitions = [];

  for (const obj of enrichedObjects) {
    if (obj.className !== 'person' || !obj.color?.upperRgb) continue;
    const feature = { upperRgb: obj.color.upperRgb, lowerRgb: obj.color.lowerRgb ?? null, upper: obj.cloth?.upper ?? null, lower: obj.cloth?.lower ?? null };
    const linkedFaceId = oIdToFaceId.get(String(obj.objectId)) ?? null;

    let bestEntry = null, bestScore = CLOTHING_MATCH_THRESH;
    for (const g of _sharedClothingGallery) {
      const sim = _clothingAppearSim(feature, g.feature);
      if (sim > bestScore) { bestScore = sim; bestEntry = g; }
    }

    if (bestEntry) {
      const prevCameraId = bestEntry.lastCameraId;
      if (prevCameraId !== cameraId) {
        const stats = _crossClothingStats.get(bestEntry.clothingId) || { clothingId: bestEntry.clothingId, firstCameraId: prevCameraId, lastCameraId: prevCameraId, transitionCount: 0, lastSeenAt: bestEntry.lastSeenAt };
        stats.transitionCount++; stats.lastCameraId = cameraId; stats.lastSeenAt = now;
        _crossClothingStats.set(bestEntry.clothingId, stats);
        crossCameraTransitions.push({ clothingId: bestEntry.clothingId, faceId: linkedFaceId || bestEntry.faceId || null, prevCameraId, newCameraId: cameraId, similarity: bestScore, objectId: obj.objectId, timestamp: now, feature });
      }
      bestEntry.lastSeenAt = now; bestEntry.lastCameraId = cameraId;
      if (linkedFaceId && !bestEntry.faceId) bestEntry.faceId = linkedFaceId;
    } else {
      const clothingId = `C${_clothingCounter++}`;
      _sharedClothingGallery.push({ clothingId, feature, lastSeenAt: now, lastCameraId: cameraId, faceId: linkedFaceId });
    }
  }

  return { crossCameraTransitions };
}

// ── Shared AI services (eager-loaded at startup) ───────────────────────────────
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

// ── DB persistence helpers ─────────────────────────────────────────────────────
function _saveAnalysisEvent(db, event) {
  if (!db) return;
  try {
    const all = db.find('analysisEvents', {});
    if (all.length >= MAX_PERSISTED_EVENTS) {
      // Delete oldest entry to keep collection bounded
      const oldest = all.slice().sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      )[0];
      if (oldest?.id) db.delete('analysisEvents', oldest.id);
    }
    db.insert('analysisEvents', event);
  } catch (err) {
    console.warn('[AnalysisAPI] Failed to persist event:', err.message);
  }
}

async function _cropThumbnail(jpegBuffer, bbox, fw, fh) {
  if (!jpegBuffer || !bbox || !fw || !fh) return null;
  try {
    const { data } = await snapshotSvc.cropJpeg(jpegBuffer, bbox, fw, fh);
    return 'data:image/jpeg;base64,' + data.toString('base64');
  } catch {
    return null;
  }
}

async function _persistFireSmoke(db, io, cameraId, cameraName, ts, detections, jpegBuffer, fw, fh) {
  const now = Date.now();
  for (const det of detections) {
    const key = `${cameraId}:${det.className}`;
    if (now - (_fireSmokeEventCooldown.get(key) || 0) < FIRE_SMOKE_SAVE_COOLDOWN) continue;
    _fireSmokeEventCooldown.set(key, now);
    const cropData = await _cropThumbnail(jpegBuffer, det.bbox, fw, fh);
    _saveAnalysisEvent(db, {
      id:         crypto.randomUUID(),
      type:       det.className, // 'fire' | 'smoke'
      cameraId,
      cameraName: cameraName || cameraId,
      timestamp:  ts,
      confidence: det.confidence,
      bbox:       det.bbox,
      cropData,
    });
    if (io && cropData) {
      io.emit('snapshot:new', {
        cameraId,
        objectId:  det.className, // pseudo-objectId: 'fire' | 'smoke'
        className: det.className,
        timestamp: ts,
        cropData,
      });
    }
  }
}

async function _persistLoitering(db, io, cameraId, cameraName, ts, behaviors, jpegBuffer, fw, fh) {
  const now = Date.now();
  for (const b of behaviors) {
    if (!b.isLoitering && b.type !== 'loitering') continue;
    const objectId = b.objectId ?? b.trackId;
    const key = `${cameraId}:${objectId}`;
    if (now - (_loiteringEventCooldown.get(key) || 0) < LOITERING_SAVE_COOLDOWN) continue;
    _loiteringEventCooldown.set(key, now);
    const cropData = await _cropThumbnail(jpegBuffer, b.bbox, fw, fh);
    _saveAnalysisEvent(db, {
      id:         crypto.randomUUID(),
      type:       'loitering',
      cameraId,
      cameraName: cameraName || cameraId,
      timestamp:  ts,
      objectId,
      dwellTime:  b.dwellTime,
      zoneId:     b.zoneId,
      zoneName:   b.zoneName,
      riskScore:  b.riskScore,
      bbox:       b.bbox,
      cropData,
    });
    if (io && cropData) {
      io.emit('snapshot:new', {
        cameraId,
        objectId,
        className: 'person',
        timestamp: ts,
        cropData,
      });
    }
  }
}

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
    _trackMeta: new Map(), // trackId → { firstSeenAt, lastSeenAt, className, maxRiskScore, isLoitering, ... }
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

// Lazily cached db reference (set on first frame processed)
let _db = null;

// Active track flush: upsert long-running in-frame tracks every 30s
// so they appear in the Timeline even when the subject never leaves the camera view.
const { v4: _trackUuid } = require('uuid');
setInterval(() => {
  if (!_db) return;
  const nowMs = Date.now();
  for (const [camId, ctx] of _cameraContexts) {
    if (!ctx._trackMeta || ctx._trackMeta.size === 0) continue;
    for (const [trackKey, meta] of ctx._trackMeta.entries()) {
      const dwellMs = meta.lastSeenAt - meta.firstSeenAt;
      if (dwellMs < 5000) continue;
      if (nowMs - meta.lastSeenAt > 15_000) continue; // stale — removal imminent
      const fields = {
        cameraId:    camId,
        cameraName:  ctx.cameraName || camId,
        objectId:    trackKey,
        className:   meta.className,
        firstSeenAt: new Date(meta.firstSeenAt).toISOString(),
        lastSeenAt:  new Date(meta.lastSeenAt).toISOString(),
        dwellTime:   dwellMs,
        maxRiskScore: meta.maxRiskScore,
        isLoitering: meta.isLoitering,
        confidence:  meta.confidence,
        faceId:      meta.faceId,
        identity:    meta.identity,
        zoneId:      meta.zoneId,
        zoneName:    meta.zoneName,
        color:       meta.color,
        cloth:       meta.cloth,
        inProgress:  true,
      };
      const _ex = _db.findOne('detectionTracks', { objectId: trackKey, cameraId: camId });
      if (_ex) {
        _db.update('detectionTracks', _ex.id, fields);
      } else {
        _db.insert('detectionTracks', { id: _trackUuid(), ...fields, createdAt: new Date().toISOString() });
      }
    }
  }
}, 30_000).unref();

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
    // Capture removed tracks immediately (before any concurrent update can overwrite _removedTracks)
    const _removedBatch = ctx.tracker.popRemovedTracks();

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

    // 4.5 Face Re-ID + Person Trajectory (analysis mode — uses module-level gallery state)
    const now_reid = Date.now();
    let namedFaces = detectedFaces;
    let crossCameraFaceTransitions = [];
    const io = req.app.get('io');

    if (io && analyticsConfig.isEnabled('face') && detectedFaces.some(f => f.embedding)) {
      const reid = _assignFaceIdsAnalysis(cameraId, detectedFaces, now_reid);
      namedFaces = reid.namedFaces;
      crossCameraFaceTransitions = reid.crossCameraTransitions;

      // Step A: update trajectory for non-cross-camera faces
      const ccFaceIds = new Set(crossCameraFaceTransitions.map(ev => ev.faceId));
      for (const f of namedFaces) {
        if (ccFaceIds.has(f.faceId) || !f.faceId) continue;
        const person = enrichedObjects.find(o => o.className === 'person' && o.face && _bboxClose(o.face.bbox, f.bbox));
        const objectId = person?.objectId ?? null;
        const traj = _personTrajectory.get(f.faceId);
        if (!traj) {
          const alias = `P${++_personAliasCounter}`;
          const newTraj = { faceId: f.faceId, alias, firstSeenAt: now_reid, lastSeenAt: now_reid, currentCameraId: cameraId, segments: [{ cameraId, objectId, entryTime: now_reid, exitTime: now_reid }] };
          _personTrajectory.set(f.faceId, newTraj);
          io.emit('person:trajectory-update', newTraj);
        } else {
          const lastSeg = traj.segments[traj.segments.length - 1];
          if (lastSeg.cameraId === cameraId) { lastSeg.exitTime = now_reid; if (objectId !== null) lastSeg.objectId = objectId; }
          traj.lastSeenAt = now_reid;
        }
      }

      // Step B: cross-camera transitions
      for (const ev of crossCameraFaceTransitions) {
        const person = enrichedObjects.find(o => o.className === 'person' && o.face && _bboxClose(o.face.bbox, ev.faceBbox));
        const newObjectId = person?.objectId ?? null;
        let traj = _personTrajectory.get(ev.faceId);
        if (!traj) {
          const alias = `P${++_personAliasCounter}`;
          traj = { faceId: ev.faceId, alias, firstSeenAt: ev.timestamp, lastSeenAt: ev.timestamp, currentCameraId: ev.newCameraId, segments: [{ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: ev.timestamp, exitTime: ev.timestamp }] };
          _personTrajectory.set(ev.faceId, traj);
        } else {
          const lastSeg = traj.segments[traj.segments.length - 1];
          lastSeg.exitTime = ev.timestamp;
          traj.segments.push({ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: ev.timestamp, exitTime: ev.timestamp });
          traj.currentCameraId = ev.newCameraId;
          traj.lastSeenAt = ev.timestamp;
        }
        io.emit('person:trajectory-update', traj);
        io.emit('face:reidentified', { faceId: ev.faceId, alias: traj.alias, prevCameraId: ev.prevCameraId, newCameraId: ev.newCameraId, newObjectId, similarity: ev.similarity, timestamp: ev.timestamp });
      }

      // Annotate enriched persons with faceId + alias from Re-ID
      for (const obj of enrichedObjects) {
        if (obj.className !== 'person' || !obj.face) continue;
        const match = namedFaces.find(f => _bboxClose(f.bbox, obj.face.bbox));
        if (match?.faceId) {
          obj.faceId = match.faceId;
          obj.face.faceId = match.faceId;
          obj.face.matchScore = match.matchScore ?? 0;
          obj.alias = _personTrajectory.get(match.faceId)?.alias ?? null;
        }
      }
    }

    // 4.6 Clothing Re-ID (analysis mode)
    if (io && analyticsConfig.isEnabled('color') && enrichedObjects.length > 0) {
      const oIdToFaceId = new Map();
      for (const f of namedFaces) {
        if (!f.faceId) continue;
        const p = enrichedObjects.find(o => o.className === 'person' && o.face && _bboxClose(o.face.bbox, f.bbox));
        if (p) oIdToFaceId.set(String(p.objectId), f.faceId);
      }
      const { crossCameraTransitions: clothCCT } = _assignClothingIdsAnalysis(cameraId, enrichedObjects, now_reid, oIdToFaceId);
      for (const ct of clothCCT) {
        io.emit('clothing:reidentified', { clothingId: ct.clothingId, faceId: ct.faceId ?? null, prevCameraId: ct.prevCameraId, newCameraId: ct.newCameraId, similarity: ct.similarity, objectId: ct.objectId, feature: ct.feature, timestamp: ct.timestamp });
      }
    }

    const faceDetections = namedFaces.map((f, i) => ({
      objectId:  90000 + (Number(frameId || 0) % 1000) * 10 + i,
      className: 'face',
      confidence: f.score,
      bbox: f.bbox,
      faceId:    f.faceId ?? null,
      alias:     f.faceId ? (_personTrajectory.get(f.faceId)?.alias ?? null) : null,
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

    const alertService = req.app.get('alertService');
    const db  = req.app.get('db');

    // ── Process behaviors: loitering alerts (alert persistence only) ──────────
    const behaviors = behaviorsResult || [];
    for (const b of behaviors) {
      if ((b.isLoitering || b.type === 'loitering') && alertService) {
        alertService.createAlert({ ...b, cameraId }).catch(() => {});
      }
    }

    // ── Emit real-time detections to connected browser clients ────────────────
    // In streaming mode: streaming server calls _processRemoteResult which emits to
    // camera rooms (.to(cameraId)) after receiving our HTTP response.
    // In analysis mode (direct browser connection): we emit globally here so the
    // dashboard can show live detections without camera room subscriptions.
    if (io) {
      const fireSmokeWithId = fireSmoke.map(d => ({ ...d, objectId: d.objectId ?? d.className }));
      io.emit('detections', {
        cameraId,
        frameId,
        timestamp:  ts,
        detections: [...enrichedObjects, ...faceDetections, ...fireSmokeWithId],
        frameWidth,
        frameHeight,
      });
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

    // ── Persist fire/smoke and loitering events (after response — non-blocking) ─
    if (db) {
      if (!_db) _db = db; // cache for active-flush interval

      // ── Track lifecycle: update _trackMeta + flush removed tracks to DB ──────
      if (!ctx._trackMeta) ctx._trackMeta = new Map();
      const _nowMs = typeof timestamp === 'number' ? timestamp : Date.now();

      for (const obj of enrichedObjects) {
        const id = String(obj.objectId);
        const existing = ctx._trackMeta.get(id);
        if (existing) {
          existing.lastSeenAt = _nowMs;
          if ((obj.riskScore ?? 0) > (existing.maxRiskScore ?? 0)) existing.maxRiskScore = obj.riskScore;
          if (obj.isLoitering) existing.isLoitering = true;
          if (obj.faceId)      existing.faceId      = obj.faceId;
          if (obj.identity)    existing.identity    = obj.identity;
          if (obj.zoneId)      existing.zoneId      = obj.zoneId;
          if (obj.zoneName)    existing.zoneName    = obj.zoneName;
          if (obj.color)       existing.color       = obj.color;
          if (obj.cloth)       existing.cloth       = obj.cloth;
          existing.confidence = Math.max(existing.confidence, obj.confidence ?? 0);
        } else {
          ctx._trackMeta.set(id, {
            firstSeenAt:  obj.firstSeenAt ?? _nowMs,
            lastSeenAt:   _nowMs,
            className:    obj.className,
            maxRiskScore: obj.riskScore   ?? 0,
            isLoitering:  obj.isLoitering ?? false,
            confidence:   obj.confidence  ?? 0,
            faceId:       obj.faceId      ?? null,
            identity:     obj.identity    ?? null,
            zoneId:       obj.zoneId      ?? null,
            zoneName:     obj.zoneName    ?? null,
            color:        obj.color       ?? null,
            cloth:        obj.cloth       ?? null,
          });
        }
      }

      for (const rt of _removedBatch) {
        const trackKey = String(rt.id);
        const meta = ctx._trackMeta.get(trackKey);
        if (!meta) continue;
        ctx._trackMeta.delete(trackKey);
        const dwellMs = meta.lastSeenAt - meta.firstSeenAt;
        const meetsRisk = meta.isLoitering || (meta.maxRiskScore ?? 0) >= 0.3;
        const meetsDwell = dwellMs >= 1000;
        if (!meetsRisk && !meetsDwell) continue;
        const _completedFields = {
          cameraId:    cameraId,
          cameraName:  cameraName || cameraId,
          objectId:    trackKey,
          className:   meta.className,
          firstSeenAt: new Date(meta.firstSeenAt).toISOString(),
          lastSeenAt:  new Date(meta.lastSeenAt).toISOString(),
          dwellTime:   dwellMs,
          maxRiskScore: meta.maxRiskScore,
          isLoitering: meta.isLoitering,
          confidence:  meta.confidence,
          faceId:      meta.faceId,
          identity:    meta.identity,
          zoneId:      meta.zoneId,
          zoneName:    meta.zoneName,
          color:       meta.color,
          cloth:       meta.cloth,
          inProgress:  false,
        };
        const _ex = db.findOne('detectionTracks', { objectId: trackKey, cameraId });
        if (_ex) {
          db.update('detectionTracks', _ex.id, _completedFields);
        } else {
          db.insert('detectionTracks', { id: _trackUuid(), ..._completedFields, createdAt: new Date().toISOString() });
        }
      }

      if (fireSmoke.length > 0) _persistFireSmoke(db, io, cameraId, cameraName, ts, fireSmoke, jpegBuffer, frameWidth, frameHeight).catch(() => {});
      if (behaviors.length > 0) _persistLoitering(db, io, cameraId, cameraName, ts, behaviors, jpegBuffer, frameWidth, frameHeight).catch(() => {});

      // ── snapshot:new for regular tracked objects (isFirstSeen / isLoitering / hasFaceMatch) ─
      // Uses the same snapshotSvc.shouldSave() logic as combined/streaming modes so that
      // DashboardDetectionPanel shows person crops in analysis server mode too.
      if (snapshotSvc.isEnabled() && enrichedObjects.length > 0 && io) {
        const _buf = jpegBuffer; const _fw = frameWidth; const _fh = frameHeight;
        const _db = db; const _io = io; const _camId = cameraId; const _ts = ts;
        const _cam = { id: cameraId, name: cameraName || cameraId };
        setImmediate(async () => {
          for (const det of enrichedObjects) {
            try {
              const hasFaceMatch = !!(det.face && det.face.matchScore > 0) || !!det.matchScore;
              if (!snapshotSvc.shouldSave(_camId, det.objectId, {
                isLoitering: det.isLoitering,
                hasFaceMatch,
                isFireSmoke: false,
                timestamp:   new Date(_ts).getTime(),
              })) continue;
              const { data: cropBuf, width: cw, height: ch } =
                await snapshotSvc.cropJpeg(_buf, det.bbox, _fw, _fh);
              const snapId = await snapshotSvc.saveSnapshot(_db, _cam, det, cropBuf, cw, ch, _fw, _fh, _ts);
              _io.emit('snapshot:new', {
                cameraId:   _camId,
                snapshotId: snapId,
                objectId:   det.objectId,
                className:  det.className,
                timestamp:  _ts,
                cropData:   'data:image/jpeg;base64,' + cropBuf.toString('base64'),
              });
            } catch (_) { /* non-fatal */ }
          }
        });
      }
    }
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

// ── POST /api/analysis/face-embed ─────────────────────────────────────────────
// Delegated enrollment: a streaming server with no local face model forwards the
// enrollment photo here for detect+embed+thumbnail extraction.
router.post('/face-embed', express.raw({ type: 'image/jpeg', limit: '10mb' }), async (req, res) => {
  try {
    await _ensureServices();
    const faceService = _attrPipeline?._face;
    if (!faceService || !faceService.ready) {
      return res.status(503).json({ success: false, error: 'Face service not available — models not loaded' });
    }
    const extracted = await extractFaceForEnrollment(faceService, req.body);
    res.json({ success: true, ...extracted });
  } catch (err) {
    const status = /No face detected/.test(err.message) || /Could not extract/.test(err.message) ? 422 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ── POST /api/analysis/face-search-conditions/sync ────────────────────────────
// Bidirectional: receives a full gallery/face snapshot from a streaming server and
// mirrors it locally (tagged source:'synced', display-only — never used for matching
// here). In the SAME response, returns this analysis server's own locally-registered
// conditions (source:'local', WITH embeddings) so the streaming server can pull in
// anything added directly on the analysis dashboard and make it locally matchable.
router.post('/face-search-conditions/sync', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const db = req.app.get('db');
    faceSearchConditions.applyReconcile(db, req.body);
    res.json({ success: true, ...faceSearchConditions.exportLocal(db) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/analysis/face-search-conditions ──────────────────────────────────
router.get('/face-search-conditions', (req, res) => {
  try {
    const db = req.app.get('db');
    res.json(faceSearchConditions.listGrouped(db));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
    faceSearch: faceSearchConditions.summarize(req.app.get('db')),
  });
});

// ── GET /api/analysis/config/fire-smoke ──────────────────────────────────────
router.get('/config/fire-smoke', (_req, res) => {
  res.json({
    confThreshold: _fireSmokeService?.confThreshold ?? 0.35,
    nmsThreshold:  _fireSmokeService?.nmsThreshold  ?? 0.45,
    available:     !!_fireSmokeService,
  });
});

// ── PATCH /api/analysis/config/fire-smoke ─────────────────────────────────────
router.patch('/config/fire-smoke', express.json({ limit: '10kb' }), (req, res) => {
  if (!_fireSmokeService) {
    return res.status(503).json({ error: 'FireSmokeService not loaded' });
  }
  const { confThreshold, nmsThreshold } = req.body || {};
  if (confThreshold != null && (typeof confThreshold !== 'number' || confThreshold < 0 || confThreshold > 1)) {
    return res.status(400).json({ error: 'confThreshold must be a number between 0 and 1' });
  }
  if (nmsThreshold != null && (typeof nmsThreshold !== 'number' || nmsThreshold < 0 || nmsThreshold > 1)) {
    return res.status(400).json({ error: 'nmsThreshold must be a number between 0 and 1' });
  }
  _fireSmokeService.setThresholds({ confThreshold, nmsThreshold });
  console.log(`[AnalysisAPI] Fire/smoke thresholds updated: conf=${_fireSmokeService.confThreshold} nms=${_fireSmokeService.nmsThreshold}`);
  res.json({
    confThreshold: _fireSmokeService.confThreshold,
    nmsThreshold:  _fireSmokeService.nmsThreshold,
  });
});

// ── GET /api/analysis/events ──────────────────────────────────────────────────
// Returns recent persisted analysis events (fire/smoke/loitering).
// Query params:
//   limit    (default 100, max 500)
//   type     comma-separated: fire,smoke,loitering
//   cameraId single camera filter
//   from     ISO timestamp — include events at or after this time
//   to       ISO timestamp — include events at or before this time
router.get('/events', (req, res) => {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ error: 'DB not available' });

  const limit        = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100));
  const typeFilter   = req.query.type     ? String(req.query.type).split(',').map(t => t.trim()).filter(Boolean) : null;
  const cameraFilter = req.query.cameraId ? String(req.query.cameraId) : null;
  const fromTs       = req.query.from     ? new Date(String(req.query.from)).getTime() : null;
  const toTs         = req.query.to       ? new Date(String(req.query.to)).getTime()   : null;

  let events = db.find('analysisEvents', {});
  if (typeFilter   && typeFilter.length > 0) events = events.filter(e => typeFilter.includes(e.type));
  if (cameraFilter) events = events.filter(e => e.cameraId === cameraFilter);
  if (fromTs)       events = events.filter(e => new Date(e.timestamp).getTime() >= fromTs);
  if (toTs)         events = events.filter(e => new Date(e.timestamp).getTime() <= toTs);

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  events = events.slice(0, limit);

  res.json({ events, total: events.length });
});

// ── DELETE /api/analysis/events ───────────────────────────────────────────────
// Clears all persisted analysis events.
router.delete('/events', (req, res) => {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ error: 'DB not available' });

  try {
    const all = db.find('analysisEvents', {});
    for (const event of all) {
      if (event.id) db.delete('analysisEvents', event.id);
    }
    res.json({ deleted: all.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/detection-tracks ────────────────────────────────────────────────
// Returns persisted detection track lifecycles (배회 위험 기준 저장됨)
// Query: cameraId, from (ISO), to (ISO), class, limit (default 500, max 1000)
router.get('/detection-tracks', (req, res) => {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ error: 'DB not available' });

  try {
    const limit        = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || '500'), 10) || 500));
    const cameraFilter = req.query.cameraId ? String(req.query.cameraId) : null;
    const classFilter  = req.query.class    ? String(req.query.class)    : null;
    const fromTs       = req.query.from     ? new Date(String(req.query.from)).getTime() : null;
    const toTs         = req.query.to       ? new Date(String(req.query.to)).getTime()   : null;

    let tracks = db.find('detectionTracks', {});
    if (cameraFilter) tracks = tracks.filter(t => t.cameraId === cameraFilter);
    if (classFilter)  tracks = tracks.filter(t => t.className === classFilter);
    // Overlap filter: include tracks whose interval [firstSeenAt, lastSeenAt] overlaps [fromTs, toTs]
    if (fromTs) tracks = tracks.filter(t => new Date(t.lastSeenAt).getTime()  >= fromTs);
    if (toTs)   tracks = tracks.filter(t => new Date(t.firstSeenAt).getTime() <= toTs);

    tracks.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());
    tracks = tracks.slice(0, limit);

    res.json({ tracks, total: tracks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/detection-tracks ─────────────────────────────────────────────
router.delete('/detection-tracks', (req, res) => {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ error: 'DB not available' });

  try {
    const all = db.find('detectionTracks', {});
    for (const t of all) {
      if (t.id) db.delete('detectionTracks', t.id);
    }
    res.json({ deleted: all.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analysis/face-trajectories ──────────────────────────────────────
// Cross-camera face trajectory history persisted in DB (faceTrajectories table).
// Query: faceId, alias, cameraId, from (ISO), to (ISO), limit (default 50, max 500)
router.get('/face-trajectories', (req, res) => {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ error: 'DB not available' });

  try {
    const limit      = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const faceFilter = req.query.faceId   ? String(req.query.faceId)   : null;
    const aliasFilter= req.query.alias    ? String(req.query.alias)    : null;
    const camFilter  = req.query.cameraId ? String(req.query.cameraId) : null;
    const fromTs     = req.query.from     ? new Date(String(req.query.from)).getTime() : null;
    const toTs       = req.query.to       ? new Date(String(req.query.to)).getTime()   : null;

    let rows = db.all('faceTrajectories');
    if (faceFilter)  rows = rows.filter(r => r.faceId  === faceFilter  || r.id === faceFilter);
    if (aliasFilter) rows = rows.filter(r => r.alias   === aliasFilter);
    if (camFilter)   rows = rows.filter(r =>
      r.currentCameraId === camFilter ||
      (Array.isArray(r.segments) && r.segments.some(s => s.cameraId === camFilter))
    );
    if (fromTs) rows = rows.filter(r => (r.lastSeenAt  || 0) >= fromTs);
    if (toTs)   rows = rows.filter(r => (r.firstSeenAt || 0) <= toTs);

    rows.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    rows = rows.slice(0, limit);

    res.json({ trajectories: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/analysis/face-trajectories ────────────────────────────────────
router.delete('/face-trajectories', (req, res) => {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ error: 'DB not available' });

  try {
    const all = db.all('faceTrajectories');
    for (const r of all) {
      if (r.id) db.delete('faceTrajectories', r.id);
    }
    res.json({ deleted: all.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/analysis/detection-snapshots ─────────────────────────────────────
// Returns saved crop images for a given objectId (detection track)
// Query: objectId (required), cameraId, from (ISO), to (ISO), limit (default 20, max 100)
router.get('/detection-snapshots', (req, res) => {
  const db = req.app.get('db');
  if (!db) return res.status(503).json({ error: 'DB not available' });

  try {
    const objectId     = req.query.objectId ? String(req.query.objectId) : null;
    const cameraFilter = req.query.cameraId ? String(req.query.cameraId) : null;
    const fromTs       = req.query.from     ? new Date(String(req.query.from)).getTime() : null;
    const toTs         = req.query.to       ? new Date(String(req.query.to)).getTime()   : null;
    const limit        = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));

    if (!objectId) return res.status(400).json({ error: 'objectId required' });

    let snaps = db.find('detectionSnapshots', { objectId });
    if (cameraFilter) snaps = snaps.filter(s => s.cameraId === cameraFilter);
    if (fromTs) snaps = snaps.filter(s => new Date(s.timestamp).getTime() >= fromTs);
    if (toTs)   snaps = snaps.filter(s => new Date(s.timestamp).getTime() <= toTs);
    snaps.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    snaps = snaps.slice(0, limit);

    res.json({ snapshots: snaps, total: snaps.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── GET /api/analysis/models ─────────────────────────────────────────────────
// Returns the full model catalog with per-model download status and active flag.
router.get('/models', (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const modelsDir = path.resolve(__dirname, '..', '..', 'models');
  const activeFile = _detector ? path.basename(_detector.modelPath) : null;

  const catalog = MODEL_CATALOG.map(m => {
    const filePath = path.join(modelsDir, m.file);
    const exists   = fs.existsSync(filePath);
    const stat     = exists ? fs.statSync(filePath) : null;
    const progress = _downloadProgress.get(m.id);
    return {
      ...m,
      url: undefined,           // don't expose raw GitHub URL to client
      exists,
      active:   activeFile === m.file,
      sizeBytes: stat ? stat.size : null,
      converting: progress?.status === 'converting',
      downloading: progress?.status === 'downloading' || progress?.status === 'converting',
      downloadPercent: progress?.percent ?? null,
      downloadError:   progress?.status === 'error' ? progress.error : null,
    };
  });

  res.json({ activeFile, catalog });
});

// ── POST /api/analysis/models/switch ─────────────────────────────────────────
// Hot-swap the active YOLO detection model.  Body: { modelId: string }
router.post('/models/switch', express.json({ limit: '1kb' }), async (req, res) => {
  const { modelId } = req.body || {};
  const fs   = require('fs');
  const path = require('path');
  const entry = MODEL_CATALOG.find(m => m.id === modelId);
  if (!entry) return res.status(400).json({ error: 'Unknown modelId' });

  const filePath = path.resolve(__dirname, '..', '..', 'models', entry.file);
  if (!fs.existsSync(filePath)) {
    return res.status(409).json({ error: 'Model file not downloaded yet', file: entry.file });
  }

  try {
    if (!_detector) {
      const DetectionService = require('../services/detection');
      _detector = new DetectionService({ modelPath: filePath });
      await _detector.load();
    } else {
      await _detector.reload(filePath);
    }
    console.log(`[AnalysisAPI] Switched YOLO model → ${entry.label}`);
    res.json({ ok: true, active: entry.label, file: entry.file });
  } catch (err) {
    console.error('[AnalysisAPI] Model switch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/analysis/models/download ───────────────────────────────────────
// Trigger async download of a model from Ultralytics GitHub releases.
// Body: { modelId: string }  — responds immediately; progress via polling GET /models
router.post('/models/download', express.json({ limit: '1kb' }), async (req, res) => {
  const { modelId } = req.body || {};
  const fs   = require('fs');
  const path = require('path');
  const https = require('https');
  const http  = require('http');

  const entry = MODEL_CATALOG.find(m => m.id === modelId);
  if (!entry) return res.status(400).json({ error: 'Unknown modelId' });

  const modelsDir = path.resolve(__dirname, '..', '..', 'models');
  const filePath  = path.join(modelsDir, entry.file);

  if (_downloadProgress.get(modelId)?.status === 'downloading') {
    return res.status(409).json({ error: 'Download already in progress' });
  }

  _downloadProgress.set(modelId, { status: 'downloading', percent: 0, error: null });
  res.json({ ok: true, message: `Download started for ${entry.label}` });

  // Async download with redirect support
  const doDownload = (url, destPath, cb) => {
    const proto = url.startsWith('https') ? https : http;
    const tmpPath = destPath + '.tmp';
    const file = fs.createWriteStream(tmpPath);

    const req2 = proto.get(url, { rejectUnauthorized: false }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.destroy();
        fs.unlink(tmpPath, () => {});
        return doDownload(response.headers.location, destPath, cb);
      }
      if (response.statusCode !== 200) {
        file.destroy();
        fs.unlink(tmpPath, () => {});
        return cb(new Error(`HTTP ${response.statusCode}`));
      }
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (total > 0) {
          _downloadProgress.set(modelId, { status: 'downloading', percent: Math.round(received / total * 100), error: null });
        }
      });
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.rename(tmpPath, destPath, (err) => cb(err));
        });
      });
    });
    req2.on('error', (err) => {
      file.destroy();
      fs.unlink(tmpPath, () => {});
      cb(err);
    });
    req2.setTimeout(300_000, () => { req2.destroy(); cb(new Error('Download timeout')); });
  };

  try {
    if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

    if (entry.requiresConversion) {
      // PT → ONNX via ultralytics export
      const { execFile } = require('child_process');
      const ptFile = entry.file.replace('.onnx', '.pt');
      const ptPath = path.join(modelsDir, ptFile);

      _downloadProgress.set(modelId, { status: 'downloading', percent: 0, error: null });
      await new Promise((resolve, reject) => doDownload(entry.url, ptPath, (err) => err ? reject(err) : resolve()));
      _downloadProgress.set(modelId, { status: 'converting', percent: 95, error: null });

      // Resolve Python with ultralytics that supports YOLO12 (cfg/models/12 directory).
      // ultralytics < 8.3.x uses 'v12' or missing dir and cannot export YOLO12 weights.
      // Check must verify YOLO12 support explicitly, not just 'import ultralytics'.
      const { execFileSync } = require('child_process');
      const pyCandidates = [
        process.env.PYTHON_EXEC,
        process.platform === 'win32' ? process.env.PYTHON_EXEC_WINDOWS : process.env.PYTHON_EXEC_LINUX,
        '/usr/bin/python3',
        'python3',
        'python',
      ].filter(Boolean);
      const pyCheckScript = [
        'import ultralytics, os',
        'cfg12 = os.path.join(os.path.dirname(ultralytics.__file__), "cfg", "models", "12")',
        'assert os.path.exists(cfg12), "YOLO12 not supported (ultralytics " + ultralytics.__version__ + ")"',
      ].join('; ');
      let pyExec = null;
      for (const cand of pyCandidates) {
        try { execFileSync(cand, ['-c', pyCheckScript], { timeout: 8000 }); pyExec = cand; break; } catch {}
      }
      if (!pyExec) throw new Error('Python with ultralytics >=8.3 (YOLO12 support) not found. Run: pip install -U ultralytics');

      const script = [
        'from ultralytics import YOLO',
        `m = YOLO(${JSON.stringify(ptPath)})`,
        `m.export(format="onnx", imgsz=${entry.size}, dynamic=False)`,
      ].join('; ');

      await new Promise((resolve, reject) => {
        execFile(pyExec, ['-c', script], { timeout: 300_000 }, (err, stdout, stderr) => {
          if (err) { console.error('[AnalysisAPI] ONNX export stderr:', stderr); return reject(err); }
          resolve();
        });
      });

      // ultralytics writes <stem>.onnx next to the .pt file
      const exportedOnnx = ptPath.replace(/\.pt$/, '.onnx');
      if (exportedOnnx !== filePath && fs.existsSync(exportedOnnx)) {
        fs.renameSync(exportedOnnx, filePath);
      }
      fs.unlink(ptPath, () => {});
    } else {
      await new Promise((resolve, reject) => doDownload(entry.url, filePath, (err) => err ? reject(err) : resolve()));
    }

    _downloadProgress.set(modelId, { status: 'done', percent: 100, error: null });
    console.log(`[AnalysisAPI] Ready ${entry.label} → ${entry.file}`);
  } catch (err) {
    _downloadProgress.set(modelId, { status: 'error', percent: 0, error: err.message });
    console.error(`[AnalysisAPI] Download failed for ${entry.label}:`, err.message);
  }
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
