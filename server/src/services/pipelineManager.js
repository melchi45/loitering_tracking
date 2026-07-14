'use strict';

const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');
const snapshotSvc = require('./snapshotService');
const faceSearchConditions = require('./faceSearchConditions');

// ── Lazy-load sharp (optional dependency, mirrors snapshotService.js) ─────────
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('[PipelineManager] sharp not found — streaming-mode analysis-frame downscale disabled (full-resolution frames forwarded as-is)');
}

// Streaming mode only: max width of the copy forwarded to the (possibly remote)
// analysis server. ingest-daemon always delivers native/decoded resolution now —
// this keeps the analysis HTTP hop cheap while detectionSnapshots crop still uses
// the untouched native buffer (see _processRemoteResult's bbox up-scaling).
const _AI_MAX_WIDTH = parseInt(process.env.AI_MAX_WIDTH || '640', 10);

/**
 * Downscales a JPEG buffer to at most `maxWidth` (aspect-preserving, no upscale).
 * Returns the original buffer unchanged if sharp is unavailable or already narrow enough.
 * @param {Buffer} jpegBuffer
 * @param {number} maxWidth
 * @returns {Promise<{ buf: Buffer, width: number, height: number }>}
 */
async function _downscaleForAnalysis(jpegBuffer, maxWidth) {
  if (!sharp) return { buf: jpegBuffer, width: 0, height: 0 };
  try {
    const img  = sharp(jpegBuffer);
    const meta = await img.metadata();
    if (!meta.width || meta.width <= maxWidth) {
      return { buf: jpegBuffer, width: meta.width || 0, height: meta.height || 0 };
    }
    const buf = await img.resize(maxWidth, null, { withoutEnlargement: true }).jpeg().toBuffer();
    const outMeta = await sharp(buf).metadata();
    return { buf, width: outMeta.width, height: outMeta.height };
  } catch {
    return { buf: jpegBuffer, width: 0, height: 0 };
  }
}

/**
 * Scales a bbox from one frame's coordinate space to another (e.g. the downscaled
 * copy sent to a remote analysis server → the native buffer retained for cropping).
 * Falls back to the original bbox (no scaling) when either dimension is unknown.
 * @param {{x:number,y:number,width:number,height:number}} bbox
 * @param {number} fromW
 * @param {number} fromH
 * @param {number} toW
 * @param {number} toH
 */
function _scaleBbox(bbox, fromW, fromH, toW, toH) {
  if (!bbox || !fromW || !fromH || !toW || !toH) return bbox;
  const sx = toW / fromW;
  const sy = toH / fromH;
  if (sx === 1 && sy === 1) return bbox;
  return {
    x:      bbox.x      * sx,
    y:      bbox.y      * sy,
    width:  bbox.width  * sx,
    height: bbox.height * sy,
  };
}

/**
 * Parse width/height from JPEG SOF marker — no full decode, reads ~100 bytes.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
function getJpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xFF) break;
    const marker = buf[i + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      if (i + 8 < buf.length) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      break;
    }
    if (i + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  return null;
}
function _pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

const { createCapture, CAPTURE_BACKEND } = require('./captureFactory');
const mediamtxManager  = require('./mediamtxManager');
const { getEngine: getWebRTCEngine, WEBRTC_ENGINE } = require('./webrtcEngineFactory');
const DetectionService    = require('./detection');
const BatchDetectionQueue = require('./batchDetectionQueue');
const { ByteTracker }  = require('./tracking');
const BehaviorEngine   = require('./behaviorEngine');
const ZoneManager      = require('./zoneManager');
const AlertService     = require('./alertService');
const AttributePipeline = require('./attributePipeline');
const FireSmokeService  = require('./fireSmokeService');
const { AppearanceReidService, cosineSim } = require('./appearanceReidService');
const { AgeEstimationService } = require('./ageEstimationService');
const analyticsConfig  = require('./analyticsConfig');
const { getSystemMetrics } = require('./systemMetrics');

const SERVER_MODE = process.env.SERVER_MODE || 'combined';

// ─── Ingest daemon helpers ────────────────────────────────────────────────────
// Used when CAPTURE_BACKEND=ingest-daemon to register/remove cameras directly
// with the AI-only Python daemon (no ffmpeg, no WebRTC RTP path).

const _INGEST_DAEMON_URL = (process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');

async function _ingestRegisterCamera(cameraId, rtspUrl, callbackUrl, appRtpCallbackUrl, appRtpRtspUrl, captureFps) {
  try {
    const body = { id: cameraId, rtspUrl, callbackUrl };
    if (appRtpCallbackUrl) body.appRtpCallbackUrl = appRtpCallbackUrl;
    // When MediaMTX is in use, rtspUrl is the MediaMTX URL (video/audio only).
    // App RTP must read from the original camera URL which carries ONVIF data tracks.
    if (appRtpRtspUrl) body.appRtpRtspUrl = appRtpRtspUrl;
    // Per-camera FPS target — ingest daemon uses time-based throttling when set.
    if (captureFps && captureFps > 0) body.captureFps = captureFps;
    const resp = await fetch(`${_INGEST_DAEMON_URL}/cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`ingest-daemon responded ${resp.status}`);
    return true;
  } catch (err) {
    console.warn(`[PipelineManager][${cameraId.slice(0, 8)}] ingest-daemon register failed: ${err.message}`);
    return false;
  }
}

// Deleting a camera MUST actually stop ingest-daemon's reconnect loop for it —
// previously this fired the DELETE once and silently swallowed any failure
// (network hiccup, ingest-daemon momentarily busy), leaving the daemon with an
// orphaned session that keeps retrying the camera connection forever with no
// trace in the log. One retry + logging on final failure closes that gap.
async function _ingestRemoveCamera(cameraId, attempt = 1) {
  try {
    const resp = await fetch(`${_INGEST_DAEMON_URL}/cameras/${encodeURIComponent(cameraId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`ingest-daemon responded ${resp.status}`);
    return true;
  } catch (err) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 500));
      return _ingestRemoveCamera(cameraId, attempt + 1);
    }
    console.warn(
      `[PipelineManager][${cameraId.slice(0, 8)}] ingest-daemon DELETE /cameras/${cameraId} failed after ${attempt} attempts: ${err.message} — ` +
      `the daemon may still hold this camera and keep retrying its RTSP connection`
    );
    return false;
  }
}

// Forwarding rate cap for streaming→analysis (frames per second per camera).
// 0 = unlimited (latest-frame-wins naturally throttles to analysis server speed).
// Set ANALYSIS_FPS in .env_streaming to explicitly cap forwarding, reducing
// wasted capture + network when analysis server is CPU-bound (e.g. ANALYSIS_FPS=2).
const _ANALYSIS_FPS        = Math.max(0, parseFloat(process.env.ANALYSIS_FPS || '0'));
const _ANALYSIS_INTERVAL_MS = _ANALYSIS_FPS > 0 ? 1000 / _ANALYSIS_FPS : 0;

// ─── Face gallery helpers ─────────────────────────────────────────────────────

// Dot product of two L2-normalised ArcFace embeddings == cosine similarity
function _cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// Returns true when two bboxes are within `tol` pixels on all four coordinates.
// Used to match a detected face bbox back to an enriched person's face.bbox.
function _bboxClose(a, b, tol = 3) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x      - b.x)      <= tol &&
    Math.abs(a.y      - b.y)      <= tol &&
    Math.abs(a.width  - b.width)  <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}

// ─── Clothing appearance gallery helpers ──────────────────────────────────────

// Weighted similarity for cross-camera clothing Re-ID.
// Combines upper/lower RGB Euclidean distance with PAR cloth-type exact-match.
// Returns [0, 1]; 1 = identical appearance.
function _clothingAppearSim(a, b) {
  const MAX_DIST = 441.67; // sqrt(3) × 255 — max possible RGB Euclidean distance
  let score = 0, w = 0;
  if (a.upperRgb && b.upperRgb) {
    const dr = a.upperRgb[0] - b.upperRgb[0];
    const dg = a.upperRgb[1] - b.upperRgb[1];
    const db = a.upperRgb[2] - b.upperRgb[2];
    const colorSim = 1 - Math.sqrt(dr * dr + dg * dg + db * db) / MAX_DIST;
    let typeSim = 0.5; // neutral when type unknown (PAR model not loaded)
    if (a.upper && b.upper && a.upper !== 'unknown' && b.upper !== 'unknown') {
      typeSim = a.upper === b.upper ? 1 : 0;
    }
    score += 0.60 * (0.55 * colorSim + 0.45 * typeSim); // upper = 60% total weight
    w += 0.60;
  }
  if (a.lowerRgb && b.lowerRgb) {
    const dr = a.lowerRgb[0] - b.lowerRgb[0];
    const dg = a.lowerRgb[1] - b.lowerRgb[1];
    const db = a.lowerRgb[2] - b.lowerRgb[2];
    const colorSim = 1 - Math.sqrt(dr * dr + dg * dg + db * db) / MAX_DIST;
    let typeSim = 0.5;
    if (a.lower && b.lower && a.lower !== 'unknown' && b.lower !== 'unknown') {
      typeSim = a.lower === b.lower ? 1 : 0;
    }
    score += 0.40 * (0.50 * colorSim + 0.50 * typeSim); // lower = 40% total weight
    w += 0.40;
  }
  return w > 0 ? score / w : 0;
}

// CrossCamera Face Tracking Phase-2 (Proposed) — FR-CCFR-061/062.
// When both sides carry an OSNet appearance embedding, blend embedding similarity
// (80%) with the existing color+type similarity (20%); otherwise fall back to the
// Phase-1 color-only similarity unchanged. See docs/design/Design_AI_AppearanceReID.md §12.
function _weightedAppearSim(a, b) {
  if (a.embedding && b.embedding) {
    const embSim   = cosineSim(a.embedding, b.embedding);
    const colorSim = _clothingAppearSim(a, b);
    return embSim * 0.8 + colorSim * 0.2;
  }
  return _clothingAppearSim(a, b);
}

const FACE_MATCH_THRESH     = 0.35;     // cosine similarity threshold for same-person
const FACE_EXPIRY_MS        = 30000;    // forget a face after 30s of absence
const FACE_TRACKING_PATH    = path.join(__dirname, '../../../storage/face_tracking.json');
const CLOTHING_MATCH_THRESH = 0.75;     // weighted colour+type threshold for same-clothing
const CLOTHING_EXPIRY_MS    = 300_000;  // 5 min — outfit doesn't change between rooms
const CLOTHING_FACE_W       = 0.70;     // face weight in combined Re-ID confidence
const CLOTHING_APPEAR_W     = 0.30;     // clothing weight in combined Re-ID confidence
// CrossCamera Face Tracking Phase-2 (Proposed) — per-track OSNet embedding throttle,
// mirrors AI-05 Phase-3's HP_INTERVAL_MS pattern (colorClothService.js).
const APPEARANCE_EMBED_INTERVAL_MS = 4000;
const AGE_ESTIMATION_INTERVAL_MS   = 4000; // Age Estimation (Proposed) — throttle re-inference per track

// Maximum number of concurrent camera pipelines (each = 1 capture backend process).
// Configurable via MAX_PIPELINES env var; 0 = unlimited.
const MAX_PIPELINES = parseInt(process.env.MAX_PIPELINES || '8', 10);

/**
 * Orchestrates the full camera processing pipeline:
 * CaptureBackend (ffmpeg|gstreamer|pyav) → Detection → Tracking → BehaviorEngine → Socket.IO emission
 */
class PipelineManager {
  /**
   * @param {import('socket.io').Server} io
   * @param {import('better-sqlite3').Database} db
   * @param {ZoneManager} [zoneManager]  Shared ZoneManager from index.js.
   *   When provided, zone cache invalidations from the REST API are reflected
   *   here immediately. If omitted a private instance is created (legacy behaviour).
   * @param {import('./qdrantService').QdrantService} [qdrantService]  Optional vector DB
   *   client (Proposed — CrossCamera Face Tracking Phase-2). Best-effort only; all
   *   Qdrant calls degrade to a no-op when disabled/unreachable.
   */
  constructor(io, db, zoneManager = null, qdrantService = null) {
    this._io             = io;
    this._db             = db;
    this._pipelines       = new Map(); // cameraId → PipelineContext
    this._starting        = new Set(); // cameraIds currently inside startCamera (race guard)
    this._zoneManager     = zoneManager || new ZoneManager(db);
    this._alertService    = new AlertService(db);
    this._detector        = null;  // Shared YOLOv8n instance
    this._batchQueue      = null;  // BatchDetectionQueue wrapping _detector
    this._attrPipeline    = null;  // Shared attribute pipeline
    this._fireSmokeService = null; // Shared fire/smoke detector
    // CrossCamera Face Tracking Phase-2 (Proposed) — appearance/body Re-ID embedding.
    this._qdrant          = qdrantService;
    this._appearanceReid  = new AppearanceReidService();
    this._appearanceEmbedCache = new Map(); // objectId -> { ts, embedding }
    // Age Estimation (Proposed) — see docs/design/Design_AI_Age_Estimation.md.
    this._ageEstimation   = new AgeEstimationService();
    this._ageEstimateCache = new Map(); // objectId -> { ts, result }
    this._analysisClient   = null; // Remote analysis client (streaming mode only)
    this._fireAlertCooldown = new Map(); // `${cameraId}:${zoneName}:${cls}` → lastAlertTs
    // Hook called just before a camera is marked offline (stopCamera).
    // Registered externally (index.js) to avoid circular dependency with internalApi.
    this._onCameraOfflineHook = null;
    // Shared face gallery across all cameras — enables cross-camera Re-ID.
    // Each entry: { faceId, embedding, lastSeenAt, lastCameraId }
    // When a face matches an entry whose lastCameraId differs from the current
    // camera, a `face:reidentified` Socket.IO event is emitted to all clients.
    this._sharedFaceGallery = [];
    this._faceCounter       = 1;

    // Persistent named gallery loaded from DB (faceGalleryFaces table).
    // Each entry: { id, galleryId, name, embedding, thumbnail }
    // Reloaded on enrollment/deletion via reloadPersistentGallery().
    this._persistentGallery = [];
    // Cooldown map for face_match alerts: `${faceId}:${galleryFaceId}` → lastEmittedAt (ms)
    this._faceMatchCooldown = new Map();

    // Bound how long a gallery/face row written by a different process to a shared DB
    // (e.g. a condition added directly on the analysis server's own dashboard) can
    // remain invisible to this process's live-matching gallery — reloadPersistentGallery()
    // is otherwise only triggered by this process's own local /api/galleries mutations.
    if (process.env.SERVER_MODE !== 'analysis') {
      setInterval(() => this.reloadPersistentGallery(), 10_000).unref();
    }

    // Cross-camera Re-ID statistics for the current server session
    // Map: faceId → { faceId, firstCameraId, lastCameraId, transitionCount, lastSeenAt }
    this._crossCameraStats  = new Map();

    // Global Person Registry — persists across gallery expiry for the full session.
    // Map: faceId → PersonTrajectory
    // PersonTrajectory: { faceId, alias, firstSeenAt, lastSeenAt, currentCameraId,
    //   segments: [{ cameraId, objectId, entryTime, exitTime }] }
    this._personTrajectory   = new Map();
    this._personAliasCounter = 0;
    this._faceTrackingSaveTimer = null; // debounce timer for face_tracking.json

    // Shared clothing gallery for cross-camera appearance Re-ID.
    // Entry: { clothingId, feature: {upperRgb, lowerRgb, upper, lower},
    //          lastSeenAt, lastCameraId, faceId }
    // TTL = CLOTHING_EXPIRY_MS (5 min). Persists across gallery entry expiry.
    this._sharedClothingGallery = [];
    this._clothingCounter       = 1;
    // Per-clothing cross-camera stats: clothingId → { clothingId, firstCameraId, lastCameraId, transitionCount, lastSeenAt }
    this._crossClothingStats    = new Map();

    // Restore persisted trajectory state
    this._loadFaceTracking();

    // Single listener — broadcast saved alerts to all connected clients
    this._alertService.on('alert', (alert) => {
      this._io.emit('alert:new', alert);
    });
  }

  /**
   * Start the processing pipeline for a camera.
   * @param {object} camera  Camera row from DB { id, rtspUrl, username, password, ... }
   * @returns {Promise<void>}
   */
  async startCamera(camera) {
    // Prevent concurrent startCamera calls for the same camera.
    // Without this guard, two simultaneous calls (e.g. auto-start + error-retry)
    // both pass the _pipelines.has() check before either finishes, resulting in
    // duplicate FFmpeg processes and extreme CPU usage.
    if (this._starting.has(camera.id)) return;
    this._starting.add(camera.id);
    try {
      await this._doStartCamera(camera);
    } finally {
      this._starting.delete(camera.id);
    }
  }

  async _doStartCamera(camera) {
    if (SERVER_MODE === 'analysis') {
      console.warn(`[PipelineManager][${camera.id.slice(0, 8)}] startCamera called in analysis mode — skipping (this server receives frames, not cameras)`);
      return;
    }

    if (this._pipelines.has(camera.id)) {
      await this.stopCamera(camera.id);
    }

    // Enforce pipeline concurrency limit
    if (MAX_PIPELINES > 0 && this._pipelines.size >= MAX_PIPELINES) {
      console.warn(
        `[PipelineManager] MAX_PIPELINES (${MAX_PIPELINES}) reached — skipping camera ${camera.id}. ` +
        `Increase MAX_PIPELINES in .env to allow more concurrent streams.`
      );
      return;
    }

    // In streaming mode connect to a remote AI analysis server; in combined/analysis
    // mode load AI models locally (lazy — shared across all cameras).
    if (SERVER_MODE === 'streaming') {
      if (!this._analysisClient) {
        const AnalysisClient = require('./analysisClient');
        const url = process.env.ANALYSIS_SERVER_URL;
        if (!url) {
          console.warn('[PipelineManager] SERVER_MODE=streaming with empty ANALYSIS_SERVER_URL — streaming continues without remote AI results');
        } else {
          this._analysisClient = new AnalysisClient(url);
          const health = await this._analysisClient.healthCheck();
          console.log('[PipelineManager] Analysis server health:', JSON.stringify(health));
        }
      }
    } else {
      // Lazy-load detector (shared across cameras)
      if (!this._detector) {
        this._detector = new DetectionService();
        await this._detector.load().catch((err) => {
          console.warn('[PipelineManager] ONNX model not loaded — detection disabled:', err.message);
          this._detector = null;
        });
        // Wrap detector with batch queue — collects frames from multiple cameras
        // and runs a single session.run([B,3,640,640]) per flush cycle.
        if (this._detector) {
          this._batchQueue = new BatchDetectionQueue(this._detector);
          const bMax = parseInt(process.env.BATCH_MAX_SIZE, 10) || 4;
          const bWait = parseInt(process.env.BATCH_MAX_WAIT_MS, 10) || 33;
          console.log(`[PipelineManager] BatchDetectionQueue ready — maxBatch=${bMax} maxWait=${bWait}ms`);
        }
      }

      // Lazy-load attribute pipeline (face / PPE / color)
      if (!this._attrPipeline) {
        this._attrPipeline = new AttributePipeline();
        await this._attrPipeline.load().catch((err) => {
          console.warn('[PipelineManager] AttributePipeline load warn:', err.message);
        });
      }

      // CrossCamera Face Tracking Phase-2 (Proposed) — appearance Re-ID embedding model
      if (this._appearanceReid.status === 'not_started') {
        await this._appearanceReid.load().catch((err) => {
          console.warn('[PipelineManager] AppearanceReidService load warn:', err.message);
        });
      }

      // Age Estimation (Proposed) — age prediction model
      if (this._ageEstimation.status === 'not_started') {
        await this._ageEstimation.load().catch((err) => {
          console.warn('[PipelineManager] AgeEstimationService load warn:', err.message);
        });
      }

      // Lazy-load fire/smoke service
      if (!this._fireSmokeService) {
        this._fireSmokeService = new FireSmokeService();
        await this._fireSmokeService.load().catch((err) => {
          console.warn('[PipelineManager] FireSmokeService load warn:', err.message);
        });
      }
    }

    const rtspUrl  = this._buildRtspUrl(camera);
    const requestedWebRTC = !!camera.webrtcEnabled;
    const captureFps = parseInt(process.env.CAPTURE_FPS, 10) || 10;

    // YouTube cameras publish their stream via FFmpeg → MediaMTX at /yt/<id>.
    // They do NOT need a second MediaMTX path registration (which would create a
    // MediaMTX→MediaMTX loopback) and do NOT use mediasoup RTP fan-out — the
    // ingest-daemon reads directly from the existing /yt/<id> RTSP path for AI JPEG only.
    const isYouTube = camera.type === 'youtube';

    // Register with MediaMTX when:
    //   (a) WEBRTC_ENGINE=mediamtx and browser WebRTC delivery is requested, OR
    //   (b) the mediamtx capture backend is active.
    // WEBRTC_ENGINE=mediasoup does NOT need MediaMTX: ingest-daemon opens a single
    // PyAV session directly to the camera and fans out AI JPEG, H.264/Opus RTP for
    // mediasoup, and App RTP (ONVIF) from that one connection — no relay needed.
    // YouTube cameras are excluded: their RTSP URL IS already a MediaMTX path.
    const needsMediaMTX = !isYouTube && (
      (requestedWebRTC && WEBRTC_ENGINE === 'mediamtx')
      || CAPTURE_BACKEND === 'mediamtx'
    );
    let mediamtxReady = false;
    if (needsMediaMTX) {
      mediamtxReady = await mediamtxManager.addCameraPath(camera.id, rtspUrl).catch(() => false);
      if (!mediamtxReady) {
        console.warn(
          `[PipelineManager][${camera.id}] MediaMTX path registration failed — ` +
          `falling back to direct RTSP source (${rtspUrl})`
        );
      } else {
        // Wait for MediaMTX to establish its upstream RTSP pull before the capture
        // client connects.  Without this, the first connect attempt always gets 404
        // because MediaMTX hasn't finished the upstream handshake yet.
        const pathReady = await mediamtxManager.waitForPathReady(camera.id, 8000);
        if (!pathReady) {
          console.warn(`[PipelineManager][${camera.id}] MediaMTX upstream not ready after 8 s — capture will retry`);
        }
      }
    }

    const mediamtxRtspPort = parseInt(process.env.MEDIAMTX_RTSP_PORT, 10) || 8554;
    // When MediaMTX holds the camera stream (WebRTC mode or mediamtx backend),
    // ALL capture backends (gstreamer, ffmpeg, pyav) should read from the
    // MediaMTX local RTSP re-publish.  This prevents a second direct connection
    // to the camera which many devices limit to one simultaneous RTSP client.
    const captureUrl = mediamtxReady
      ? `rtsp://127.0.0.1:${mediamtxRtspPort}/${camera.id}`
      : rtspUrl;

    // App RTP (ONVIF metadata) always uses the original camera URL directly:
    //   · MediaMTX does not re-publish Application RTP tracks, so the direct URL
    //     is needed even when MediaMTX relays video/audio (mediamtx engine).
    //   · In mediasoup mode (no MediaMTX relay) the direct URL is used for everything.
    //   · YouTube sources have no App RTP; their RTSP is a MediaMTX re-publish.
    const daemonAppRtpRtspUrl = isYouTube ? null : rtspUrl;

    // For non-mediamtx WebRTC engines (mediasoup), register the stream with the engine.
    // mediasoupEngine.addCameraStream() internally calls ingest-daemon with both the
    // AI callbackUrl AND the mediasoup RTP ports, so we skip the separate ingest-daemon
    // registration below when WEBRTC_ENGINE=mediasoup.
    // YouTube cameras are excluded: they use AI-only ingest-daemon registration (below)
    // since their stream is already managed by FFmpeg→MediaMTX; starting mediasoup RTP
    // fan-out threads against a MediaMTX RTSP URL causes connection-refused retry loops.
    let altWebRTCReady = false;
    const registerAltEngine = !isYouTube && WEBRTC_ENGINE !== 'mediamtx' &&
      (requestedWebRTC || WEBRTC_ENGINE === 'mediasoup');
    if (registerAltEngine) {
      // Retry up to 3 times with a 2-second delay — ingest-daemon may still be
      // binding its port when the first addCameraStream call arrives on startup.
      for (let attempt = 0; attempt < 3; attempt++) {
        altWebRTCReady = await getWebRTCEngine().addCameraStream(camera.id, captureUrl, daemonAppRtpRtspUrl, captureFps).catch(() => false);
        if (altWebRTCReady) break;
        if (attempt < 2) {
          console.warn(`[PipelineManager][${camera.id.slice(0,8)}] addCameraStream attempt ${attempt + 1} failed — retrying in 2s`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    // When using ingest-daemon with mediamtx engine: register for AI JPEG only.
    // When using mediasoup engine: mediasoupEngine.addCameraStream() already registered
    // ingest-daemon (AI + RTP). Fall back to AI-only registration if mediasoup failed.
    // These are declared here (outer scope) so ctx can capture them in its literal below.
    let _ingestRtspUrl           = null;
    let _ingestCallbackUrl       = null;
    let _ingestAppRtpCallbackUrl = null;
    if (CAPTURE_BACKEND === 'ingest-daemon') {
      const isHttps     = (process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
      const serverProto = isHttps ? 'https' : 'http';
      const serverPort  = isHttps
        ? parseInt(process.env.HTTPS_PORT || '3443', 10)
        : parseInt(process.env.HTTP_PORT || process.env.PORT || '3080', 10);
      const callbackUrl       = `${serverProto}://127.0.0.1:${serverPort}/api/internal/frame/${camera.id}`;
      const appRtpCallbackUrl = `${serverProto}://127.0.0.1:${serverPort}/api/internal/apprtp/${camera.id}`;
      const daemonRtspUrl = mediamtxReady ? captureUrl : rtspUrl;
      // daemonAppRtpRtspUrl computed above (before registerAltEngine) — original camera
      // URL for App RTP so the ingest-daemon can access ONVIF data tracks that MediaMTX
      // does not re-publish.

      const needsDirectIngestReg = WEBRTC_ENGINE !== 'mediasoup' || !altWebRTCReady;
      if (needsDirectIngestReg) {
        const daemonReady = await _ingestRegisterCamera(camera.id, daemonRtspUrl, callbackUrl, appRtpCallbackUrl, daemonAppRtpRtspUrl, captureFps);
        if (!daemonReady) {
          console.error(`[PipelineManager][${camera.id}] Ingest daemon registration failed — no AI frames for this camera`);
        } else {
          console.log(`[PipelineManager][${camera.id}] Ingest daemon registered → AI:${daemonRtspUrl}${daemonAppRtpRtspUrl ? ` AppRTP:${daemonAppRtpRtspUrl}` : ''}`);
        }
        _ingestRtspUrl          = daemonRtspUrl;
        _ingestCallbackUrl      = callbackUrl;
        _ingestAppRtpCallbackUrl = appRtpCallbackUrl;
      }
    }

    const useWebRTC = requestedWebRTC && (WEBRTC_ENGINE === 'mediamtx' ? mediamtxReady : altWebRTCReady);
    if (requestedWebRTC && !useWebRTC) {
      console.warn(
        `[PipelineManager][${camera.id}] WebRTC disabled for this pipeline ` +
        `(engine: ${WEBRTC_ENGINE}, ready: ${WEBRTC_ENGINE === 'mediamtx' ? mediamtxReady : altWebRTCReady}).`
      );
    }

    const capture = createCapture(camera.id, captureUrl, { fps: captureFps, width: 640 });

    const tracker  = new ByteTracker();
    const behavior = new BehaviorEngine(this._zoneManager);

    let frameId = 0;

    const ctx = {
      capture,
      tracker,
      behavior,
      running:      true,
      useWebRTC,
      aiEnabled:    camera.aiEnabled !== false, // default true
      frameCount:   0,
      lastFrameAt:  null,
      _inferring:   false,
      // Streaming-mode per-camera analysis queue (latest-frame-wins pattern).
      // At most one JPEG buffer is held in memory per camera at any time.
      _pendingFrame:        null,
      _analyzing:           false,
      _lastAnalysisQueueAt: 0,   // epoch ms — used by ANALYSIS_FPS rate limiter
      // Most recent JPEG frame (updated on every frame arrival, used by ONVIF snapshot)
      _latestJpeg:          null, // { buf: Buffer, fw: number, fh: number }
      // Camera identity (for metrics display)
      cameraName:         camera.name || camera.id,
      // Analytics metrics — accumulated by local inference (combined/analysis mode)
      framesProcessed:    0,
      bytesReceivedTotal: 0,
      detectionsTotal:    0,
      trackedTotal:       0,
      facesTotal:         0,
      fireSmokeTotal:     0,
      loiteringTotal:     0,
      totalProcessingMs:  0,
      recentSamples:      [], // { at, bytes, detections, trackedObjects, faces, fireSmoke, loitering, processingMs }
      // Track lifecycle meta — keyed by objectId, used to persist ended tracks to DB
      // Only objects with riskScore >= 0.3 or isLoitering are saved (배회 위험 기준)
      _trackMeta:         new Map(), // objectId → { firstSeenAt, lastSeenAt, className, maxRiskScore, isLoitering, confidence, faceId, identity, zoneId, zoneName, color, cloth }
      // ingest-daemon re-registration params (used by frame watchdog on stall)
      _ingestRtspUrl,
      _ingestCallbackUrl,
      _ingestAppRtpCallbackUrl,
      _ingestAppRtpRtspUrl: daemonAppRtpRtspUrl ?? null,
      _captureUrl: captureUrl,   // URL ingest-daemon reads from (for mediasoup watchdog re-reg)
    };

    // ── Listen for loitering events ──────────────────────────────────────
    behavior.on('loitering', async (event) => {
      this._io.to(camera.id).emit('loitering', event);
      try {
        await this._alertService.createAlert({ ...event, cameraId: camera.id });
      } catch (err) {
        console.error('[PipelineManager] Alert creation failed:', err.message);
      }
    });

    // ── Frame processing ──────────────────────────────────────────────────
    capture.on('frame', async (jpegBuffer) => {
      if (!ctx.running) return;

      const currentFrameId = ++frameId;
      const timestamp = Date.now();
      ctx.frameCount++;
      ctx.lastFrameAt = timestamp;

      // 1. Parse actual JPEG dimensions from buffer header (fast — no full decode)
      const jpegSize  = getJpegSize(jpegBuffer);
      let frameWidth  = jpegSize?.width  ?? 640;
      let frameHeight = jpegSize?.height ?? 640;

      // Keep a reference to the most recent frame for ONVIF event snapshot capture
      ctx._latestJpeg = { buf: jpegBuffer, fw: frameWidth, fh: frameHeight };

      // Emit raw JPEG frame only for cameras NOT using WebRTC.
      // volatile: if the browser's WebSocket buffer is full (slow ACK), the frame
      // is dropped rather than queued — prevents stale-frame pile-up that causes
      // the visual "freeze then burst" effect when the browser catches up.
      if (!ctx.useWebRTC) {
        this._io.to(camera.id).volatile.emit('frame', {
          cameraId:    camera.id,
          frameId:     currentFrameId,
          timestamp,
          data:        jpegBuffer.toString('base64'),
          frameWidth,
          frameHeight,
        });
      }

      // Skip all inference when AI is disabled for this camera
      if (!ctx.aiEnabled) return;

      // ── Streaming mode: per-camera "latest-frame-wins" analysis queue ────────
      // In streaming mode the remote analysis server decides which AI modules to
      // run — the streaming server's own analyticsConfig is irrelevant here.
      // Always forward frames when an analysis client is configured.
      if (SERVER_MODE === 'streaming') {
        if (!this._analysisClient) return; // monitoring-only mode

        // ANALYSIS_FPS rate limiter: drop this frame if we've already queued one
        // within the target interval. Prevents sending 10 fps to an analysis server
        // that can only process 1-2 fps, reducing wasted network + CPU on both sides.
        if (_ANALYSIS_INTERVAL_MS > 0) {
          if (timestamp - ctx._lastAnalysisQueueAt < _ANALYSIS_INTERVAL_MS) return;
        }
        ctx._lastAnalysisQueueAt = timestamp;

        ctx._pendingFrame = {
          cameraId: camera.id,
          frameId:  currentFrameId,
          ts:       timestamp,
          buf:      jpegBuffer,
          fw:       frameWidth,
          fh:       frameHeight,
          zones:    this._zoneManager.getActiveZones(camera.id),
        };
        if (!ctx._analyzing) this._runPendingAnalysis(ctx, camera, analyticsConfig);
        return;
      }

      // ── Local inference (combined / analysis mode) ───────────────────────
      // Skip if every analytics module is disabled on this server.
      if (!analyticsConfig.anyModuleEnabled()) return;

      // Latest-frame-wins: when inference is already running for this camera,
      // store the newest frame so it is processed immediately after the current
      // inference completes.  This eliminates the idle gap between inference end
      // and the next frame arriving from ingest-daemon, smoothing GPU utilisation.
      if (ctx._inferring) {
        ctx._pendingFrame = { buf: jpegBuffer, fw: frameWidth, fh: frameHeight, ts: timestamp };
        return;
      }
      ctx._inferring = true;
      const _inferStart = Date.now();

      try {

        // 2. Run detection via batch queue — frames from multiple cameras are
        //    collected and inferred together as a single [B,3,640,640] tensor,
        //    maximising GPU SM utilisation (CUDA) or reducing DML command-queue overhead.
        let detections = [];
        if (this._batchQueue && analyticsConfig.anyDetectionEnabled()) {
          try {
            const result = await this._batchQueue.enqueue(jpegBuffer);
            detections  = result.detections.filter(d => analyticsConfig.isClassEnabled(d.className));
            frameWidth  = result.frameWidth;
            frameHeight = result.frameHeight;
          } catch (err) {
            console.error(`[PipelineManager][${camera.id}] Detection error:`, err.message);
          }
        }

        // 3a. Pre-tracking fast colour extraction — pixel averaging only (~0.5 ms/person),
        //     no GPU or model required. Attaches det.color so the multi-cue matcher
        //     can compare new-detection colour against the track's stored colour.
        if (analyticsConfig.isEnabled('color') && this._attrPipeline?.ready) {
          await Promise.all(detections.map(async (det) => {
            if (det.className !== 'person') return;
            try {
              det.color = await this._attrPipeline.fastColor(jpegBuffer, det.bbox, frameWidth, frameHeight);
            } catch { /* ignore — colour just won't be used for this detection */ }
          }));
        }

        // 3b. Update tracker
        const trackedObjects = tracker.update(detections);

        // 4. Attribute enrichment (face / PPE / color) — runs BEFORE behavior so that
        //    face embeddings, mask/hat status, and clothing color are available for
        //    appearance-based revisit detection and risk scoring in the behavior engine.
        let attrObjects      = trackedObjects;
        let faceDetObjects   = [];
        let clothingAssignMap = new Map(); // String(objectId) → { clothingId, matchScore }
        const anyAttrEnabled = analyticsConfig.isEnabled('face') ||
                               analyticsConfig.isEnabled('mask') ||
                               analyticsConfig.isEnabled('hat')  ||
                               analyticsConfig.isEnabled('color') ||
                               analyticsConfig.isEnabled('cloth');
        if (anyAttrEnabled && this._attrPipeline && this._attrPipeline.anyReady) {
          try {
            const zones = this._zoneManager.getActiveZones(camera.id);
            const { enrichedObjects: enriched, detectedFaces } =
              await this._attrPipeline.enrich(
                jpegBuffer, frameWidth, frameHeight, trackedObjects, zones,
                analyticsConfig.getConfig()
              );
            attrObjects = enriched;

            // Emit face detections as separate objects — only if face module enabled
            if (analyticsConfig.isEnabled('face') && detectedFaces.length > 0) {
              const { faces: namedFaces, crossCameraTransitions, pendingMatchEvents } =
                this._assignFaceIds(camera.id, camera.name || camera.id, detectedFaces, timestamp);

              // ── v1.1: Async crop + emit face_match + persist ──
              if (pendingMatchEvents && pendingMatchEvents.length > 0) {
                const _io   = this._io;
                const _db   = this._db;
                const _snapshotSvc = snapshotSvc;
                const _jpegBuffer  = jpegBuffer;
                const _frameWidth  = frameWidth;
                const _frameHeight = frameHeight;
                setImmediate(async () => {
                  for (const { evt, faceBbox } of pendingMatchEvents) {
                    let liveCropData;
                    try {
                      if (_snapshotSvc.isEnabled() && _jpegBuffer && faceBbox) {
                        const { data: cropBuf } = await _snapshotSvc.cropJpeg(
                          _jpegBuffer, faceBbox, _frameWidth, _frameHeight
                        );
                        liveCropData = 'data:image/jpeg;base64,' + cropBuf.toString('base64');
                      }
                    } catch (_) { /* non-fatal — emit without crop */ }
                    const fullEvt = liveCropData ? { ...evt, liveCropData } : evt;
                    _io.emit('face_match', fullEvt);
                    if (fullEvt.galleryType === 'missing') {
                      _io.emit('missing_person_match', fullEvt);
                    }
                    try {
                      // eslint-disable-next-line no-unused-vars
                      const { liveCropData: _drop, ...evtForDb } = fullEvt;
                      _db.insert('faceMatchHistory', {
                        id:        require('crypto').randomUUID(),
                        ...evtForDb,
                        createdAt: new Date(evt.timestamp).toISOString(),
                      });
                    } catch (dbErr) {
                      console.warn('[PipelineManager] faceMatchHistory insert error:', dbErr.message);
                    }
                  }
                });
              }

              // ── Step A: Update Global Person Registry for non-transition faces ──
              const crossCameraFaceIds = new Set(crossCameraTransitions.map(ev => ev.faceId));
              for (const f of namedFaces) {
                if (crossCameraFaceIds.has(f.faceId)) continue; // handled in Step B
                const person = attrObjects.find(obj =>
                  obj.className === 'person' && obj.face &&
                  _bboxClose(obj.face.bbox, f.bbox)
                );
                const objectId = person?.objectId ?? null;
                const traj = this._personTrajectory.get(f.faceId);
                if (!traj) {
                  // First detection — create trajectory record with canonical alias
                  const alias = `P${++this._personAliasCounter}`;
                  const newTraj = {
                    faceId: f.faceId, alias,
                    firstSeenAt: timestamp, lastSeenAt: timestamp,
                    currentCameraId: camera.id,
                    segments: [{ cameraId: camera.id, objectId, entryTime: timestamp, exitTime: timestamp }],
                  };
                  this._personTrajectory.set(f.faceId, newTraj);
                  this._scheduleFaceTrackingSave();
                  this._upsertTrajectoryToDb(newTraj);
                  this._io.emit('person:trajectory-update', newTraj);
                } else {
                  // Existing person in same camera — update exitTime silently
                  const lastSeg = traj.segments[traj.segments.length - 1];
                  if (lastSeg.cameraId === camera.id) {
                    lastSeg.exitTime = timestamp;
                    if (objectId !== null) lastSeg.objectId = objectId;
                  }
                  traj.lastSeenAt = timestamp;
                }
              }

              // ── Step B: Handle cross-camera transitions ──────────────────────
              for (const ev of crossCameraTransitions) {
                const person = attrObjects.find(obj =>
                  obj.className === 'person' && obj.face &&
                  _bboxClose(obj.face.bbox, ev.faceBbox)
                );
                const newObjectId = person?.objectId ?? null;

                // Update trajectory: close old segment, open new segment
                let traj = this._personTrajectory.get(ev.faceId);
                if (!traj) {
                  const alias = `P${++this._personAliasCounter}`;
                  traj = {
                    faceId: ev.faceId, alias,
                    firstSeenAt: timestamp, lastSeenAt: timestamp,
                    currentCameraId: ev.newCameraId,
                    segments: [{ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: timestamp, exitTime: timestamp, similarity: ev.similarity }],
                  };
                  this._personTrajectory.set(ev.faceId, traj);
                } else {
                  const lastSeg = traj.segments[traj.segments.length - 1];
                  lastSeg.exitTime = ev.timestamp;
                  traj.segments.push({ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: ev.timestamp, exitTime: ev.timestamp, similarity: ev.similarity });
                  traj.currentCameraId = ev.newCameraId;
                  traj.lastSeenAt      = ev.timestamp;
                }
                this._scheduleFaceTrackingSave();
                this._upsertTrajectoryToDb(traj);
                this._io.emit('person:trajectory-update', traj);

                this._io.emit('face:reidentified', {
                  faceId:       ev.faceId,
                  alias:        traj.alias,
                  prevCameraId: ev.prevCameraId,
                  newCameraId:  ev.newCameraId,
                  newObjectId,
                  similarity:   ev.similarity,
                  timestamp:    ev.timestamp,
                });
                console.log(
                  `[PipelineManager] Cross-camera Re-ID: ${traj.alias}/${ev.faceId} ` +
                  `${ev.prevCameraId.slice(0, 8)} → ${ev.newCameraId.slice(0, 8)} ` +
                  `person#${newObjectId ?? '?'} (sim=${ev.similarity.toFixed(3)})`
                );
              }

              // ── Build faceDetObjects with canonical alias ─────────────────────
              faceDetObjects = namedFaces.map((f, i) => ({
                objectId:    90000 + (currentFrameId % 1000) * 10 + i,
                className:   'face',
                confidence:  f.score,
                bbox:        f.bbox,
                faceId:      f.faceId,
                alias:       this._personTrajectory.get(f.faceId)?.alias ?? null,
                matchScore:  f.matchScore,
                isLoitering: false,
                dwellTime:   0,
              }));
            }

            // ── Clothing appearance Re-ID ──────────────────────────────────────────
            // Runs after face assignment so faceId → objectId links are available.
            // Works even when face module is disabled (color module gate only).
            if (analyticsConfig.isEnabled('color')) {
              // Build objectId → faceId from faceDetObjects ↔ attrObjects (via face bbox proximity)
              const _oIdToFaceId = new Map();
              for (const fd of faceDetObjects) {
                const p = attrObjects.find(o =>
                  o.className === 'person' && o.face && _bboxClose(o.face.bbox, fd.bbox)
                );
                if (p) _oIdToFaceId.set(String(p.objectId), fd.faceId);
              }

              // CrossCamera Face Tracking Phase-2 (Proposed) — per-track throttled
              // OSNet embedding extraction, fed into _assignClothingIds()'s weighted match.
              const _oIdToEmbedding = new Map();
              if (this._appearanceReid.ready) {
                await Promise.all(attrObjects
                  .filter(o => o.className === 'person' && o.color?.upperRgb)
                  .map(async (o) => {
                    const emb = await this._getAppearanceEmbedding(jpegBuffer, o.objectId, o.bbox);
                    if (emb) _oIdToEmbedding.set(String(o.objectId), emb);
                  }));
              }

              const { assignments: _ca, crossCameraTransitions: _clothCCT } =
                this._assignClothingIds(camera.id, attrObjects, timestamp, _oIdToFaceId, _oIdToEmbedding);

              for (const a of _ca) clothingAssignMap.set(String(a.objectId), a);

              for (const ct of _clothCCT) {
                this._io.emit('clothing:reidentified', {
                  clothingId:   ct.clothingId,
                  faceId:       ct.faceId ?? null,
                  prevCameraId: ct.prevCameraId,
                  newCameraId:  ct.newCameraId,
                  similarity:   ct.similarity,
                  objectId:     ct.objectId,
                  feature: {
                    upper:    ct.feature.upper,
                    lower:    ct.feature.lower,
                    upperRgb: ct.feature.upperRgb,
                    lowerRgb: ct.feature.lowerRgb,
                  },
                  timestamp: ct.timestamp,
                });
                console.log(
                  `[PipelineManager] Clothing Re-ID: ${ct.clothingId} ` +
                  `${ct.prevCameraId.slice(0, 8)}→${ct.newCameraId.slice(0, 8)} ` +
                  `sim=${ct.similarity.toFixed(3)}` +
                  (ct.faceId ? ` [${ct.faceId}]` : '')
                );
              }
            }

            // ── Age Estimation (Proposed) ────────────────────────────────────────────
            // Face crop preferred (higher accuracy); falls back to the person bbox when
            // no face was detected for this track. Independent of the 'color'/'cloth'
            // gates above — only requires 'human' detection plus its own toggle.
            if (analyticsConfig.isEnabled('ageEstimation') && this._ageEstimation.ready) {
              await Promise.all(attrObjects
                .filter(o => o.className === 'person')
                .map(async (o) => {
                  const bbox = o.face?.bbox || o.bbox;
                  if (!bbox) return;
                  const isFaceCrop = !!o.face?.bbox;
                  const result = await this._getAgeEstimate(jpegBuffer, o.objectId, bbox, isFaceCrop);
                  if (result) o.estimatedAge = result;
                }));
            }
          } catch (err) {
            console.error(`[PipelineManager][${camera.id}] Attribute pipeline error:`, err.message);
          }

          // Feed all appearance attributes back into the tracker (one-frame delayed).
          // Stored values are used during the NEXT frame's multi-cue association step.
          for (const obj of attrObjects) {
            if (obj.className !== 'person') continue;
            if (obj.face?.embedding)  tracker.updateAppearance(obj.objectId, obj.face.embedding);
            if (obj.color)            tracker.updateColor(obj.objectId, obj.color);
            if (obj.cloth)            tracker.updateCloth(obj.objectId, obj.cloth);
            if (obj.estimatedAge)     tracker.updateEstimatedAge(obj.objectId, obj.estimatedAge);
            // Accessories: hat (PPE model) and mask (PPE model)
            const hat  = obj.hat  !== undefined ? obj.hat  : undefined;
            const mask = obj.mask !== undefined ? obj.mask : undefined;
            if (hat !== undefined || mask !== undefined) {
              tracker.updateAccessories(obj.objectId, { hat, mask });
            }
          }
        }

        // 5. Run behavior analysis on attribute-enriched objects so that face embeddings,
        //    mask/hat status, and clothing color are available for appearance-based
        //    revisit detection and composite risk scoring.
        const enrichedObjects = behavior.update(camera.id, attrObjects, timestamp);

        // Propagate clothingId from clothing Re-ID assignments to behavior-enriched detections
        if (clothingAssignMap.size > 0) {
          for (const obj of enrichedObjects) {
            const ca = clothingAssignMap.get(String(obj.objectId));
            if (ca) obj.clothingId = ca.clothingId;
          }
        }

        // 6. Fire/smoke detection — gated by analytics config
        let fireSmokeObjects = [];
        const fireEnabled  = analyticsConfig.isEnabled('fire');
        const smokeEnabled = analyticsConfig.isEnabled('smoke');
        if ((fireEnabled || smokeEnabled) && this._fireSmokeService && this._fireSmokeService.ready) {
          try {
            const raw = await this._fireSmokeService.detect(jpegBuffer, frameWidth, frameHeight);
            fireSmokeObjects = raw.map((d, i) => ({
              ...d,
              objectId:    80000 + (currentFrameId % 1000) * 10 + i,
              isLoitering: false,
              dwellTime:   0,
            }));
            // Filter fire/smoke by module enable state
            fireSmokeObjects = fireSmokeObjects.filter(d =>
              (d.className === 'fire' && fireEnabled) ||
              (d.className === 'smoke' && smokeEnabled)
            );
            if (fireSmokeObjects.length > 0) {
              const zones = this._zoneManager.getActiveZones(camera.id);
              for (const det of fireSmokeObjects) {
                const center = {
                  x: det.bbox.x + det.bbox.width  / 2,
                  y: det.bbox.y + det.bbox.height / 2,
                };
                for (const zone of zones) {
                  if (zone.type !== 'MONITOR') continue;
                  if (zone.polygon.length < 3) continue;
                  if (!_pointInPolygon(center, zone.polygon)) continue;
                  const key = `${camera.id}:${zone.name}:${det.className}`;
                  const last = this._fireAlertCooldown.get(key) || 0;
                  if (timestamp - last < 10000) continue;
                  this._fireAlertCooldown.set(key, timestamp);
                  this._io.to(camera.id).emit('fire:alert', {
                    cameraId:   camera.id,
                    className:  det.className,
                    confidence: det.confidence,
                    zone:       zone.name,
                    timestamp,
                  });
                  console.warn(`[PipelineManager][${camera.id}] ${det.className.toUpperCase()} in zone "${zone.name}" (${(det.confidence * 100).toFixed(0)}%)`);
                }
              }
            }
          } catch (err) {
            console.error(`[PipelineManager][${camera.id}] FireSmoke error:`, err.message);
          }
        }

        // 7. Emit combined detections (person/vehicle + face + fire/smoke)
        const _allDets = [...enrichedObjects, ...faceDetObjects, ...fireSmokeObjects];
        if (currentFrameId % 50 === 1 || _allDets.length > 0 && currentFrameId % 10 === 1) {
          console.log(`[PM][${camera.id.slice(0,8)}] fid=${currentFrameId} yolo=${detections.length} tracked=${trackedObjects.length} total=${_allDets.length}`);
        }
        this._io.to(camera.id).emit('detections', {
          cameraId:    camera.id,
          frameId:     currentFrameId,
          timestamp,
          detections:  _allDets,
          frameWidth,
          frameHeight,
        });

        // 7b. Update track lifecycle meta + persist ended tracks to DB
        {
          const _nowMs = timestamp;

          // Update meta for all currently enriched (active) objects
          // enrichedObjects use objectId (= track.id UUID from toResult())
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
              if (obj.estimatedAge) existing.estimatedAge = obj.estimatedAge;
              existing.confidence = Math.max(existing.confidence, obj.confidence ?? 0);
            } else {
              ctx._trackMeta.set(id, {
                firstSeenAt:  obj.firstSeenAt ?? _nowMs,
                lastSeenAt:   _nowMs,
                className:    obj.className,
                maxRiskScore: obj.riskScore ?? 0,
                isLoitering:  obj.isLoitering ?? false,
                confidence:   obj.confidence ?? 0,
                faceId:       obj.faceId      ?? null,
                identity:     obj.identity    ?? null,
                zoneId:       obj.zoneId      ?? null,
                zoneName:     obj.zoneName    ?? null,
                color:        obj.color       ?? null,
                cloth:        obj.cloth       ?? null,
                estimatedAge: obj.estimatedAge ?? null,
              });
            }
          }

          // Flush removed tracks → save to DB if they meet the risk threshold
          const removedTracks = ctx.tracker.popRemovedTracks();
          if (removedTracks.length > 0) {
            const { v4: _uuid } = require('uuid');
            for (const rt of removedTracks) {
              // Track objects use rt.id (UUID); enrichedObjects expose it as objectId
              const trackKey = String(rt.id);
              const meta = ctx._trackMeta.get(trackKey);
              if (!meta) continue;
              ctx._trackMeta.delete(trackKey);
              // AI-05 Phase-3 / CrossCamera Phase-2 (Proposed) per-track caches —
              // unlike _sharedClothingGallery/_sharedFaceGallery, these are keyed by
              // objectId and must not outlive the track.
              if (this._attrPipeline) this._attrPipeline.dropTrack(trackKey);
              this._appearanceEmbedCache.delete(trackKey);
              this._ageEstimateCache.delete(trackKey);

              const dwellMs = meta.lastSeenAt - meta.firstSeenAt;

              // Persist condition: loitering flag OR zone-based risk OR dwell >= 0.5s
              const meetsRisk = meta.isLoitering || (meta.maxRiskScore ?? 0) >= 0.3;
              const meetsDwell = dwellMs >= 500; // 0.5-second minimum dwell
              if (!meetsRisk && !meetsDwell) continue;
              const _completedFields = {
                cameraId:    camera.id,
                cameraName:  camera.name || camera.id,
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
                estimatedAge: meta.estimatedAge,
                inProgress:  false,
              };
              const _existing = this._db.findOne('detectionTracks', { objectId: trackKey, cameraId: camera.id });
              if (_existing) {
                this._db.update('detectionTracks', _existing.id, _completedFields);
              } else {
                this._db.insert('detectionTracks', { id: _uuid(), ..._completedFields, createdAt: new Date().toISOString() });
              }
            }
            // Cap collection at 10,000 rows (oldest first)
            const allTracks = this._db.find('detectionTracks', {});
            if (allTracks.length > 10000) {
              const toRemove = allTracks
                .sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime())
                .slice(0, allTracks.length - 10000);
              for (const t of toRemove) this._db.delete('detectionTracks', t.id);
            }
          }
        }

        // 8. Accumulate per-camera analytics stats
        {
          const _now    = Date.now();
          const _inferMs = _now - _inferStart;
          const _lcount  = enrichedObjects.filter(o => o.isLoitering).length;
          ctx.framesProcessed++;
          ctx.bytesReceivedTotal  += jpegBuffer.length;
          ctx.detectionsTotal     += detections.length;
          ctx.trackedTotal        += trackedObjects.length;
          ctx.facesTotal          += faceDetObjects.length;
          ctx.fireSmokeTotal      += fireSmokeObjects.length;
          ctx.loiteringTotal      += _lcount;
          ctx.totalProcessingMs   += _inferMs;
          ctx.recentSamples.push({
            at: _now, bytes: jpegBuffer.length, processingMs: _inferMs,
            detections: detections.length, trackedObjects: trackedObjects.length,
            faces: faceDetObjects.length, fireSmoke: fireSmokeObjects.length, loitering: _lcount,
          });
          // Keep only last 60 s
          const _cutoff = _now - 60000;
          while (ctx.recentSamples.length > 0 && ctx.recentSamples[0].at < _cutoff) ctx.recentSamples.shift();
        }

        // 9. Save detection snapshots (non-blocking via setImmediate)
        if (snapshotSvc.isEnabled() && _allDets.length > 0) {
          const _jpegBuf  = jpegBuffer;
          const _fw       = frameWidth;
          const _fh       = frameHeight;
          const _ts       = timestamp;
          const _dets     = _allDets;
          const _camera   = camera;
          const _db       = this._db;
          const _io       = this._io;
          setImmediate(async () => {
            for (const det of _dets) {
              try {
                const hasFaceMatch = !!(det.face && det.face.matchScore > 0);
                const isFireSmoke  = det.className === 'fire' || det.className === 'smoke';
                if (!snapshotSvc.shouldSave(_camera.id, det.objectId, {
                      isLoitering: det.isLoitering, hasFaceMatch, isFireSmoke, timestamp: _ts })) continue;
                const { data: cropBuf, width: cw, height: ch } =
                  await snapshotSvc.cropJpeg(_jpegBuf, det.bbox, _fw, _fh);
                const snapId = await snapshotSvc.saveSnapshot(
                  _db, _camera, det, cropBuf, cw, ch, _fw, _fh, _ts);
                _io.to(_camera.id).emit('snapshot:new', {
                  cameraId:   _camera.id,
                  snapshotId: snapId,
                  objectId:   det.objectId,
                  className:  det.className,
                  timestamp:  _ts,
                  cropData:   'data:image/jpeg;base64,' + cropBuf.toString('base64'),
                });
              } catch (_e) {
                // per-detection crop errors are non-fatal
              }
            }
          });
        }
      } finally {
        ctx._inferring = false;
        // If a newer frame arrived while we were inferring, process it immediately
        // rather than waiting for the next frame from ingest-daemon.
        if (ctx._pendingFrame && ctx.running) {
          const pending = ctx._pendingFrame;
          ctx._pendingFrame = null;
          // Re-inject via the same capture event so all listeners run
          capture.emit('frame', pending.buf);
        }
      }
    });

    capture.on('started', ({ cmdline }) => {
      console.log(`[PipelineManager][${camera.id}] Capture started (${CAPTURE_BACKEND}): ${cmdline}`);
    });

    capture.on('frame', (() => {
      let firstFrame = true;
      return () => {
        if (firstFrame) {
          firstFrame = false;
          console.log(`[PipelineManager][${camera.id}] Stream connected — receiving frames`);
          this._updateCameraStatus(camera.id, 'streaming');
        }
      };
    })());

    capture.on('warn', ({ message }) => {
      console.warn(`[Capture:${CAPTURE_BACKEND}][${camera.id}] ${message}`);
      if (/(Connection refused|Authentication|401|timed out|No route to host|Network is unreachable)/i.test(message)) {
        this._updateCameraStatus(camera.id, 'source_unavailable');
        this._io.to(camera.id).emit('camera:stream-unavailable', {
          cameraId: camera.id,
          reason: message,
        });
      }
    });

    capture.on('reconnecting', ({ attempt, delay }) => {
      // Log every 10th attempt to avoid log flooding (retrying every 1 second)
      if (attempt === 1 || attempt % 10 === 0) {
        console.warn(`[PipelineManager][${camera.id}] Reconnecting... attempt ${attempt}`);
      }
      this._updateCameraStatus(camera.id, 'reconnecting');
    });

    capture.on('error', (err) => {
      console.error(`[PipelineManager][${camera.id}] Fatal error:`, err.message);
      // Permanent failures (binary not found / dependency missing) — mark as error, do not restart.
      const permanent = /not found|not installed|not available/i.test(err.message);
      this._updateCameraStatus(camera.id, permanent ? 'error' : 'reconnecting');
      this._io.to(camera.id).emit('camera:error', { cameraId: camera.id, message: err.message });
      if (!permanent && ctx.running) {
        // Exponential backoff: 2s → 4s → 8s … capped at 30s
        const attempt = (ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1);
        const delay = Math.min(2000 * Math.pow(1.5, attempt - 1), 30000);
        setTimeout(() => {
          if (ctx.running) this.startCamera(camera).catch(() => {});
        }, delay);
      }
    });

    capture.on('stats', ({ frameCount }) => {
      this._io.to(camera.id).emit('camera:stats', {
        cameraId: camera.id,
        frameCount,
        fps: ctx.lastFrameAt ? Math.round(frameCount / ((Date.now() - (ctx.startedAt || Date.now())) / 1000)) : 0,
      });
    });

    ctx.startedAt = Date.now();
    ctx.frameWatchdogTimer = null;
    this._pipelines.set(camera.id, ctx);
    this._updateCameraStatus(camera.id, 'connecting');
    capture.start();

    // Frame watchdog: restart capture if no JPEG arrives for 20 s.
    // For IngestDaemonCapture, capture.stop()/start() only toggles an in-process flag.
    // The actual reconnect requires re-registering the camera with the daemon via HTTP.
    {
      const FRAME_STALL_MS = 20_000;
      ctx.frameWatchdogTimer = setInterval(async () => {
        if (!ctx.running || !ctx.lastFrameAt) return;
        const stalledMs = Date.now() - ctx.lastFrameAt;
        if (stalledMs > FRAME_STALL_MS) {
          console.warn(`[PipelineManager][${camera.id}] Frame watchdog: no frame for ${Math.round(stalledMs / 1000)}s — restarting capture`);
          ctx.lastFrameAt = Date.now();
          ctx.capture.stop();

          if (CAPTURE_BACKEND === 'ingest-daemon' && ctx._ingestRtspUrl) {
            // AI-only or mediamtx-engine path: re-register directly with ingest-daemon.
            await _ingestRemoveCamera(camera.id);
            const ok = await _ingestRegisterCamera(camera.id, ctx._ingestRtspUrl, ctx._ingestCallbackUrl, ctx._ingestAppRtpCallbackUrl, ctx._ingestAppRtpRtspUrl);
            if (!ok) {
              console.error(`[PipelineManager][${camera.id}] Frame watchdog: ingest-daemon re-registration failed`);
            }
          } else if (CAPTURE_BACKEND === 'ingest-daemon' && WEBRTC_ENGINE !== 'mediamtx') {
            // mediasoup path: _ingestRtspUrl is null because mediasoupEngine.addCameraStream()
            // handled registration. Re-register via the engine (recreates PlainTransports + re-POST to daemon).
            const ok = await getWebRTCEngine().addCameraStream(camera.id, ctx._captureUrl, ctx._ingestAppRtpRtspUrl, parseInt(process.env.CAPTURE_FPS, 10) || 0).catch(() => false);
            if (!ok) {
              console.error(`[PipelineManager][${camera.id}] Frame watchdog: mediasoup re-registration failed`);
            }
          }

          ctx.capture.start();
        }
      }, 8_000);
    }

    // Active track flush: upsert long-running tracks every 30s so they appear
    // in the timeline even while the subject remains in frame continuously.
    // In streaming mode, also finalizes stale tracks (those not seen for 15s+)
    // since there is no popRemovedTracks() available (tracker runs on analysis server).
    {
      ctx._activeFlushTimer = setInterval(() => {
        if (!ctx.running || ctx._trackMeta.size === 0) return;
        const { v4: _fuuid } = require('uuid');
        const nowMs = Date.now();
        const _staleToFinalize = [];

        for (const [trackKey, meta] of ctx._trackMeta.entries()) {
          const dwellMs = meta.lastSeenAt - meta.firstSeenAt;
          const isStale = nowMs - meta.lastSeenAt > 15_000;

          if (isStale) {
            if (SERVER_MODE === 'streaming') {
              // Collect stale tracks for finalization below (inProgress: false)
              _staleToFinalize.push([trackKey, meta]);
            }
            continue; // skip inProgress upsert for stale tracks
          }

          if (dwellMs < 1000) continue; // only flush tracks active >= 1s
          const fields = {
            cameraId:    camera.id,
            cameraName:  camera.name || camera.id,
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
            estimatedAge: meta.estimatedAge,
            inProgress:  true,
          };
          const _ex = this._db.findOne('detectionTracks', { objectId: trackKey, cameraId: camera.id });
          if (_ex) {
            this._db.update('detectionTracks', _ex.id, fields);
          } else {
            this._db.insert('detectionTracks', { id: _fuuid(), ...fields, createdAt: new Date().toISOString() });
          }
        }

        // Streaming mode: finalize tracks not seen in 15s (replaces popRemovedTracks)
        for (const [trackKey, meta] of _staleToFinalize) {
          ctx._trackMeta.delete(trackKey);
          if (this._attrPipeline) this._attrPipeline.dropTrack(trackKey);
          this._appearanceEmbedCache.delete(trackKey);
          const dwellMs = meta.lastSeenAt - meta.firstSeenAt;
          const meetsRisk = meta.isLoitering || (meta.maxRiskScore ?? 0) >= 0.3;
          if (!meetsRisk && dwellMs < 500) continue;
          const fields = {
            cameraId:    camera.id,
            cameraName:  camera.name || camera.id,
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
            estimatedAge: meta.estimatedAge,
            inProgress:  false,
          };
          const _ex = this._db.findOne('detectionTracks', { objectId: trackKey, cameraId: camera.id });
          if (_ex) {
            this._db.update('detectionTracks', _ex.id, fields);
          } else {
            this._db.insert('detectionTracks', { id: _fuuid(), ...fields, createdAt: new Date().toISOString() });
          }
        }
      }, 30_000);
    }
  }

  /**
   * Stop the pipeline for a camera.
   * @param {string} cameraId
   * @returns {Promise<void>}
   */
  /**
   * Register a callback invoked just before a camera is marked offline.
   * Used by index.js to wire ONVIF event auto-close without a circular import.
   * @param {(cameraId: string) => void} fn
   */
  setOnCameraOfflineHook(fn) {
    this._onCameraOfflineHook = fn;
  }

  async stopCamera(cameraId) {
    const ctx = this._pipelines.get(cameraId);
    if (!ctx) return;

    // Close any open (state='true') ONVIF events before taking the camera offline.
    if (typeof this._onCameraOfflineHook === 'function') {
      try { this._onCameraOfflineHook(cameraId); } catch (_) {}
    }

    ctx.running       = false;
    ctx._pendingFrame = null; // discard any pending frame so _runPendingAnalysis exits cleanly
    if (ctx.frameWatchdogTimer) {
      clearInterval(ctx.frameWatchdogTimer);
      ctx.frameWatchdogTimer = null;
    }
    if (ctx._activeFlushTimer) {
      clearInterval(ctx._activeFlushTimer);
      ctx._activeFlushTimer = null;
    }
    ctx.capture.stop();
    ctx.behavior.reset();
    ctx.behavior.removeAllListeners();
    const needsMediaMTXCleanup = (ctx.useWebRTC && WEBRTC_ENGINE === 'mediamtx')
      || CAPTURE_BACKEND === 'mediamtx';
    // Awaited (not fire-and-forget) so the caller — DELETE /api/cameras/:id — only
    // responds "removed" once ingest-daemon has actually been told to stop, with
    // its own retry (see _ingestRemoveCamera). Each cleanup logs its own failure
    // internally, so one failing independently of the others doesn't hide it.
    await Promise.allSettled([
      needsMediaMTXCleanup ? mediamtxManager.removeCameraPath(cameraId) : Promise.resolve(),
      WEBRTC_ENGINE !== 'mediamtx' ? getWebRTCEngine().removeCameraStream(cameraId) : Promise.resolve(),
      CAPTURE_BACKEND === 'ingest-daemon' ? _ingestRemoveCamera(cameraId) : Promise.resolve(),
    ]);
    this._pipelines.delete(cameraId);
    this._updateCameraStatus(cameraId, 'offline');
  }

  /**
   * Get runtime status of a camera pipeline.
   * @param {string} cameraId
   * @returns {{ running: boolean, frameCount: number, lastFrameAt: number|null }|null}
   */
  getCameraStatus(cameraId) {
    const ctx = this._pipelines.get(cameraId);
    if (!ctx) return null;
    return {
      running:     ctx.running,
      aiEnabled:   ctx.aiEnabled,
      frameCount:  ctx.frameCount,
      lastFrameAt: ctx.lastFrameAt,
    };
  }

  /**
   * Returns the most recent JPEG frame for the given camera, or null if not available.
   * Used by ONVIF event snapshot capture to record the frame at event time.
   * @param {string} cameraId
   * @returns {{ buf: Buffer, fw: number, fh: number }|null}
   */
  getLatestFrame(cameraId) {
    const ctx = this._pipelines.get(cameraId);
    return ctx?._latestJpeg ?? null;
  }

  /**
   * Toggle AI inference for a running pipeline without restarting it.
   * @param {string} cameraId
   * @param {boolean} enabled
   */
  setAiEnabled(cameraId, enabled) {
    const ctx = this._pipelines.get(cameraId);
    if (ctx) ctx.aiEnabled = enabled;
  }

  /**
   * Inject a JPEG frame from the external ingest daemon into the pipeline.
   * Called by POST /api/internal/frame/:cameraId when CAPTURE_BACKEND=ingest-daemon.
   * @param {string} cameraId
   * @param {Buffer} jpegBuffer
   */
  onIngestFrame(cameraId, jpegBuffer) {
    const ctx = this._pipelines.get(cameraId);
    if (!ctx || !ctx.running) return;
    if (typeof ctx.capture.injectFrame === 'function') {
      ctx.capture.injectFrame(jpegBuffer);
    }
  }

  /**
   * Re-register all active cameras with ingest-daemon after an unexpected daemon restart.
   * Handles both paths:
   *  - mediamtx/direct: ctx._ingestRtspUrl is set → POST directly to ingest-daemon HTTP API
   *  - mediasoup:       ctx._ingestRtspUrl is null → re-register via engine.addCameraStream
   * Called by startServer.js auto-restart logic via POST /api/internal/ingest/reregister.
   */
  async reregisterAllWithIngestDaemon() {
    const results = {};
    for (const [cameraId, ctx] of this._pipelines) {
      if (!ctx.running) continue;
      try {
        if (ctx._ingestRtspUrl) {
          // mediamtx engine or direct AI-only path: re-register directly
          await _ingestRemoveCamera(cameraId);
          const ok = await _ingestRegisterCamera(cameraId, ctx._ingestRtspUrl, ctx._ingestCallbackUrl, ctx._ingestAppRtpCallbackUrl, ctx._ingestAppRtpRtspUrl);
          results[cameraId] = { ok };
        } else if (CAPTURE_BACKEND === 'ingest-daemon') {
          // mediasoup path: engine re-creates PlainTransports and re-POSTs to daemon
          const ok = await getWebRTCEngine().addCameraStream(cameraId, ctx._captureUrl, ctx._ingestAppRtpRtspUrl).catch(() => false);
          results[cameraId] = { ok };
        }
      } catch (e) {
        results[cameraId] = { ok: false, error: e.message };
      }
    }
    return results;
  }

  /** Returns status snapshot of all active pipelines for the dev monitor. */
  getAllPipelineStatus() {
    const result = [];
    for (const [cameraId, ctx] of this._pipelines) {
      result.push({
        cameraId,
        running:     ctx.running,
        aiEnabled:   ctx.aiEnabled,
        useWebRTC:   ctx.useWebRTC,
        frameCount:  ctx.frameCount,
        lastFrameAt: ctx.lastFrameAt,
        startedAt:   ctx.startedAt,
      });
    }
    return result;
  }

  /** Returns analysis client circuit-breaker stats, or null in non-streaming mode. */
  getAnalysisClientStats() {
    if (!this._analysisClient) return null;
    return this._analysisClient.getStats();
  }

  /** Stop all pipelines (for graceful shutdown). */
  async stopAll() {
    const ids = [...this._pipelines.keys()];
    await Promise.all(ids.map(id => this.stopCamera(id)));
    if (this._analysisClient) {
      this._analysisClient.destroy();
      this._analysisClient = null;
    }
  }

  /**
   * Returns the actual runtime load status of each AI service.
   * 'not_started' = pipeline never started (no camera active yet).
   * 'missing'     = model file not on disk.
   * 'loaded'      = model loaded and ready.
   * 'failed'      = model file found but loading failed.
   */
  getServiceStatus() {
    return {
      ppe:           this._attrPipeline     ? this._attrPipeline.ppeStatus   : 'not_started',
      face:          this._attrPipeline     ? this._attrPipeline.faceStatus  : 'not_started',
      cloth:         this._attrPipeline     ? this._attrPipeline.clothStatus : 'not_started',
      firesmoke:     this._fireSmokeService ? this._fireSmokeService.status  : 'not_started',
      // AI-05 Phase-3 Human Parsing (Proposed)
      humanParsing:  this._attrPipeline     ? this._attrPipeline.humanParsingStatus : 'not_started',
      // CrossCamera Face Tracking Phase-2 Appearance Re-ID (Proposed)
      appearanceReid: this._appearanceReid  ? this._appearanceReid.status : 'not_started',
      // Age Estimation (Proposed)
      ageEstimation: this._ageEstimation    ? this._ageEstimation.status : 'not_started',
    };
  }

  /**
   * Returns an analysisApi-compatible metrics snapshot built from local inference stats.
   * Used by GET /api/analysis/metrics in combined mode.
   */
  getAnalysisMetrics() {
    const now    = Date.now();
    const RECENT = 60 * 1000;
    const ACTIVE = 3000;
    const cutoff = now - RECENT;

    let totalFrames = 0, totalBytes = 0, totalMs = 0;
    let totalDets = 0, totalTracked = 0, totalFaces = 0, totalFS = 0, totalLoiter = 0;
    const allRecentSamples = [];
    const cameras = [];

    for (const [cameraId, ctx] of this._pipelines) {
      while (ctx.recentSamples.length > 0 && ctx.recentSamples[0].at < cutoff) ctx.recentSamples.shift();

      const fp = ctx.framesProcessed || 0;
      const lastAge = ctx.lastFrameAt ? (now - ctx.lastFrameAt) : Infinity;
      const streamPresent = isFinite(lastAge) && lastAge <= ACTIVE;
      const framesLast1s  = ctx.recentSamples.filter(s => s.at >= now - 1000).length;
      const zones = this._zoneManager.getActiveZones(cameraId) || [];

      cameras.push({
        cameraId,
        cameraName:          ctx.cameraName || cameraId,
        idleSec:             Math.round(lastAge / 1000),
        streamPresent,
        framesLast1s,
        inputFps1s:          framesLast1s,
        zoneCount:           zones.length,
        framesTotal:         fp,
        bytesReceivedTotal:  ctx.bytesReceivedTotal  || 0,
        avgProcessingMs:     fp > 0 ? Number((ctx.totalProcessingMs / fp).toFixed(1)) : 0,
        detectionsTotal:     ctx.detectionsTotal     || 0,
        trackedObjectsTotal: ctx.trackedTotal        || 0,
        facesTotal:          ctx.facesTotal          || 0,
        fireSmokeTotal:      ctx.fireSmokeTotal      || 0,
        loiteringTotal:      ctx.loiteringTotal      || 0,
        lastFrameAt:         ctx.lastFrameAt ? new Date(ctx.lastFrameAt).toISOString() : null,
      });

      totalFrames  += fp;
      totalBytes   += ctx.bytesReceivedTotal  || 0;
      totalMs      += ctx.totalProcessingMs   || 0;
      totalDets    += ctx.detectionsTotal     || 0;
      totalTracked += ctx.trackedTotal        || 0;
      totalFaces   += ctx.facesTotal          || 0;
      totalFS      += ctx.fireSmokeTotal      || 0;
      totalLoiter  += ctx.loiteringTotal      || 0;
      allRecentSamples.push(...ctx.recentSamples);
    }

    cameras.sort((a, b) => (b.lastFrameAt || '').localeCompare(a.lastFrameAt || ''));

    allRecentSamples.sort((a, b) => a.at - b.at);
    const rt = { frames: allRecentSamples.length, bytesReceived: 0, processingMs: 0, detections: 0, trackedObjects: 0, faces: 0, fireSmoke: 0, loitering: 0 };
    for (const s of allRecentSamples) {
      rt.bytesReceived  += s.bytes;       rt.processingMs   += s.processingMs;
      rt.detections     += s.detections;  rt.trackedObjects += s.trackedObjects;
      rt.faces          += s.faces;       rt.fireSmoke      += s.fireSmoke;
      rt.loitering      += s.loitering;
    }
    const windowSec = rt.frames > 0
      ? Math.max(1, Math.round((now - allRecentSamples[0].at) / 1000))
      : 60;
    const recent = {
      windowSec,
      frames:            rt.frames,
      framesPerSec:      Number((rt.frames / windowSec).toFixed(2)),
      bytesReceived:     rt.bytesReceived,
      bytesPerSec:       Number((rt.bytesReceived / windowSec).toFixed(2)),
      megabytesReceived: Number((rt.bytesReceived / (1024 * 1024)).toFixed(2)),
      avgProcessingMs:   Number(((rt.processingMs || 0) / Math.max(1, rt.frames)).toFixed(1)),
      detections:        rt.detections,
      trackedObjects:    rt.trackedObjects,
      faces:             rt.faces,
      fireSmoke:         rt.fireSmoke,
      loitering:         rt.loitering,
    };

    const enabledModules = Object.entries(analyticsConfig.getConfig())
      .filter(([, v]) => v === true).map(([k]) => k).sort();

    return {
      status:        'ok',
      mode:          'combined',
      uptimeSec:     Math.round(process.uptime()),
      activeCameras: cameras.filter(c => c.streamPresent).length,
      services: {
        detector:         this._detector         ? 'loaded'    : 'not-loaded',
        attrPipeline:     this._attrPipeline?.anyReady ? 'ready' : 'not-ready',
        fireSmokeService: this._fireSmokeService  ? 'loaded'    : 'not-loaded',
        ageEstimation:    this._ageEstimation     ? this._ageEstimation.status : 'not_started',
      },
      modules: { enabled: enabledModules, count: enabledModules.length },
      requests: {
        total: totalFrames, inFlight: 0, errors: 0,
        lastRequestAt: null, lastResponseAt: null,
        avgProcessingMs: Number((totalMs / Math.max(1, totalFrames)).toFixed(1)),
      },
      traffic: {
        bytesReceivedTotal: totalBytes,
        megabytesTotal:     Number((totalBytes / (1024 * 1024)).toFixed(2)),
      },
      results: {
        framesTotal:         totalFrames,
        detectionsTotal:     totalDets,
        trackedObjectsTotal: totalTracked,
        facesTotal:          totalFaces,
        fireSmokeTotal:      totalFS,
        loiteringTotal:      totalLoiter,
      },
      recent,
      cameras,
      models: this._getLoadedModels(),
      system: getSystemMetrics(),
      faceSearch: faceSearchConditions.summarize(this._db),
    };
  }

  _getLoadedModels() {
    const path = require('path');
    const fs   = require('fs');
    const models = [];

    if (this._detector) {
      const mp = this._detector.modelPath;
      models.push({ name: path.basename(mp), path: mp, service: 'detector', loaded: true, exists: fs.existsSync(mp) });
    }

    if (this._attrPipeline) {
      const ppe = this._attrPipeline._ppe;
      if (ppe?.modelPath) {
        const mp = ppe.modelPath;
        models.push({ name: path.basename(mp), path: mp, service: 'ppe', loaded: ppe.ready ?? false, exists: fs.existsSync(mp) });
      }
      const face = this._attrPipeline._face;
      if (face?.scrfdPath) {
        const mp = face.scrfdPath;
        models.push({ name: path.basename(mp), path: mp, service: 'face-detect', loaded: face.ready ?? false, exists: fs.existsSync(mp) });
      }
      if (face?.arcfacePath) {
        const mp = face.arcfacePath;
        models.push({ name: path.basename(mp), path: mp, service: 'face-embed', loaded: face.ready ?? false, exists: fs.existsSync(mp) });
      }
    }

    if (this._fireSmokeService) {
      const mp = this._fireSmokeService.modelPath;
      models.push({ name: path.basename(mp), path: mp, service: 'fire-smoke', loaded: true, exists: fs.existsSync(mp) });
    }

    return models;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Streaming-mode analysis scheduler (per-camera latest-frame-wins).
   *
   * Consumes ctx._pendingFrame, sends it to the analysis server, and re-fires
   * when the result arrives if a newer frame has been queued in the meantime.
   * This ensures analysis always runs on the most recent captured frame and
   * never falls behind regardless of analysis server latency.
   */
  _runPendingAnalysis(ctx, camera, analyticsConfig) {
    const frame = ctx._pendingFrame;
    if (!frame || !this._analysisClient || !ctx.running) return;
    ctx._pendingFrame = null;
    ctx._analyzing    = true;

    // frame.buf stays native resolution (retained for crop in _processRemoteResult);
    // only the copy actually sent over the wire to the analysis server is downscaled.
    _downscaleForAnalysis(frame.buf, _AI_MAX_WIDTH).then(({ buf: analysisBuf }) =>
      this._analysisClient.analyzeFrame({
        cameraId:   frame.cameraId,
        cameraName: camera.name || frame.cameraId,
        frameId:    frame.frameId,
        timestamp:  new Date(frame.ts).toISOString(),
        jpegBuffer: analysisBuf,
        zones:      frame.zones,
      })
    ).then(result => {
      ctx._analyzing = false;
      if (!ctx.running) { ctx._pendingFrame = null; return; }
      if (result) this._processRemoteResult(frame, result, camera, analyticsConfig);
      // If a newer frame arrived while we were waiting, process it now
      if (ctx._pendingFrame) this._runPendingAnalysis(ctx, camera, analyticsConfig);
    }).catch(() => {
      ctx._analyzing = false;
      // Errors already logged/handled by AnalysisClient (circuit breaker)
      if (ctx._pendingFrame && ctx.running) this._runPendingAnalysis(ctx, camera, analyticsConfig);
    });
  }

  /**
   * Process a successful analysis response from the remote analysis server.
   * Emits detections, loitering, face-match, and snapshot Socket.IO events.
   */
  _processRemoteResult(frame, result, camera, analyticsConfig) {
    const { cameraId: _cameraId, frameId: _frameId, ts: _ts,
            buf: _buf, fw: _fw, fh: _fh } = frame;

    const remoteTracked   = Array.isArray(result.tracked)       ? result.tracked       : [];
    const remoteFireSmoke = Array.isArray(result.fireSmoke)     ? result.fireSmoke     : [];
    const remoteFaces     = Array.isArray(result.detectedFaces) ? result.detectedFaces : [];
    const remoteFrameWidth  = result.frameWidth  || _fw;
    const remoteFrameHeight = result.frameHeight || _fh;
    let faceDetObjects = [];

    if (analyticsConfig.isEnabled('face') && remoteFaces.length > 0) {
      const { faces: namedFaces, crossCameraTransitions, pendingMatchEvents } =
        this._assignFaceIds(_cameraId, camera.name || camera.id, remoteFaces, _ts);

      if (pendingMatchEvents && pendingMatchEvents.length > 0) {
        const _io = this._io;
        const _db = this._db;
        setImmediate(async () => {
          for (const { evt, faceBbox } of pendingMatchEvents) {
            let liveCropData;
            try {
              if (snapshotSvc.isEnabled() && _buf && faceBbox) {
                // faceBbox is in the analysis server's (possibly downscaled) coordinate
                // space — _buf is the native buffer retained locally, so scale up first.
                const cropBbox = _scaleBbox(faceBbox, remoteFrameWidth, remoteFrameHeight, _fw, _fh);
                const { data: cropBuf } = await snapshotSvc.cropJpeg(
                  _buf, cropBbox, _fw, _fh
                );
                liveCropData = 'data:image/jpeg;base64,' + cropBuf.toString('base64');
              }
            } catch (_) { /* non-fatal */ }
            const fullEvt = liveCropData ? { ...evt, liveCropData } : evt;
            _io.emit('face_match', fullEvt);
            if (fullEvt.galleryType === 'missing') _io.emit('missing_person_match', fullEvt);
            try {
              // eslint-disable-next-line no-unused-vars
              const { liveCropData: _drop, ...evtForDb } = fullEvt;
              _db.insert('faceMatchHistory', {
                id:        require('crypto').randomUUID(),
                ...evtForDb,
                createdAt: new Date(evt.timestamp).toISOString(),
              });
            } catch (dbErr) {
              console.warn('[PipelineManager] faceMatchHistory insert error:', dbErr.message);
            }
          }
        });
      }

      // ── Step A: update trajectory for first-seen faces (no camera transition) ─
      const crossCameraFaceIds = new Set((crossCameraTransitions || []).map(ev => ev.faceId));
      for (const f of namedFaces) {
        if (crossCameraFaceIds.has(f.faceId)) continue;
        const person = remoteTracked.find(obj =>
          obj.className === 'person' && obj.face && _bboxClose(obj.face.bbox, f.bbox)
        );
        const objectId = person?.objectId ?? null;
        const traj = this._personTrajectory.get(f.faceId);
        if (!traj) {
          const alias = `P${++this._personAliasCounter}`;
          const newTraj = {
            faceId: f.faceId, alias,
            firstSeenAt: _ts, lastSeenAt: _ts,
            currentCameraId: _cameraId,
            segments: [{ cameraId: _cameraId, objectId, entryTime: _ts, exitTime: _ts }],
          };
          this._personTrajectory.set(f.faceId, newTraj);
          this._scheduleFaceTrackingSave();
          this._upsertTrajectoryToDb(newTraj);
          this._io.emit('person:trajectory-update', newTraj);
        } else {
          const lastSeg = traj.segments[traj.segments.length - 1];
          if (lastSeg.cameraId === _cameraId) {
            lastSeg.exitTime = _ts;
            if (objectId !== null) lastSeg.objectId = objectId;
          }
          traj.lastSeenAt = _ts;
        }
      }

      // ── Step B: handle cross-camera transitions with full trajectory management ─
      for (const ev of (crossCameraTransitions || [])) {
        const person = remoteTracked.find(obj =>
          obj.className === 'person' && obj.face && _bboxClose(obj.face.bbox, ev.faceBbox)
        );
        const newObjectId = person?.objectId ?? null;

        let traj = this._personTrajectory.get(ev.faceId);
        if (!traj) {
          const alias = `P${++this._personAliasCounter}`;
          traj = {
            faceId: ev.faceId, alias,
            firstSeenAt: ev.timestamp, lastSeenAt: ev.timestamp,
            currentCameraId: ev.newCameraId,
            segments: [{ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: ev.timestamp, exitTime: ev.timestamp, similarity: ev.similarity }],
          };
          this._personTrajectory.set(ev.faceId, traj);
        } else {
          const lastSeg = traj.segments[traj.segments.length - 1];
          lastSeg.exitTime = ev.timestamp;
          traj.segments.push({ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: ev.timestamp, exitTime: ev.timestamp, similarity: ev.similarity });
          traj.currentCameraId = ev.newCameraId;
          traj.lastSeenAt      = ev.timestamp;
        }
        this._scheduleFaceTrackingSave();
        this._upsertTrajectoryToDb(traj);
        this._io.emit('person:trajectory-update', traj);

        this._io.emit('face:reidentified', {
          faceId:       ev.faceId,
          alias:        traj.alias,
          prevCameraId: ev.prevCameraId,
          newCameraId:  ev.newCameraId,
          newObjectId,
          similarity:   ev.similarity,
          timestamp:    ev.timestamp,
        });
      }

      faceDetObjects = namedFaces.map((f, i) => ({
        objectId:    90000 + (_frameId % 1000) * 10 + i,
        className:   'face',
        confidence:  f.score,
        bbox:        f.bbox,
        faceId:      f.faceId,
        alias:       this._personTrajectory.get(f.faceId)?.alias ?? null,
        matchScore:  f.matchScore,
        isLoitering: false,
        dwellTime:   0,
      }));
    }

    // ── Clothing appearance Re-ID (streaming mode) ────────────────────────────
    if (analyticsConfig.isEnabled('color') && remoteTracked.length > 0) {
      const _oIdToFaceId = new Map();
      for (const fd of faceDetObjects) {
        const p = remoteTracked.find(o =>
          o.className === 'person' && o.face && _bboxClose(o.face.bbox, fd.bbox)
        );
        if (p) _oIdToFaceId.set(String(p.objectId), fd.faceId);
      }

      const { crossCameraTransitions: _clothCCT } =
        this._assignClothingIds(_cameraId, remoteTracked, _ts, _oIdToFaceId);

      for (const ct of _clothCCT) {
        this._io.emit('clothing:reidentified', {
          clothingId:   ct.clothingId,
          faceId:       ct.faceId ?? null,
          prevCameraId: ct.prevCameraId,
          newCameraId:  ct.newCameraId,
          similarity:   ct.similarity,
          objectId:     ct.objectId,
          feature: {
            upper:    ct.feature.upper,
            lower:    ct.feature.lower,
            upperRgb: ct.feature.upperRgb,
            lowerRgb: ct.feature.lowerRgb,
          },
          timestamp: ct.timestamp,
        });
      }
    }

    const allDetections = [...remoteTracked, ...faceDetObjects, ...remoteFireSmoke];

    // Rescale bbox (+ nested face.bbox) from the analysis server's coordinate space
    // (remoteFrameWidth/Height — the downscaled copy it actually analyzed) to the
    // native buffer's coordinate space, and report native frameWidth/frameHeight.
    // Without this, the 'frame' event (always native, from capture.on('frame', ...))
    // and this 'detections' event would alternately set CameraView's frameWidth/
    // frameHeight to two different values, making the live bbox overlay flicker
    // between two different scales on every update.
    const clientDetections = allDetections.map(det => ({
      ...det,
      bbox: _scaleBbox(det.bbox, remoteFrameWidth, remoteFrameHeight, _fw, _fh),
      ...(det.face ? { face: { ...det.face, bbox: _scaleBbox(det.face.bbox, remoteFrameWidth, remoteFrameHeight, _fw, _fh) } } : {}),
    }));

    this._io.to(_cameraId).emit('detections', {
      cameraId:   _cameraId,
      frameId:    _frameId,
      timestamp:  _ts,
      detections: clientDetections,
      frameWidth:  _fw,
      frameHeight: _fh,
    });

    // ── Track lifecycle accumulation for streaming mode (local shadow copy) ──
    // In streaming mode ByteTracker runs on the analysis server; streaming server
    // maintains its own _trackMeta to save a local copy of detectionTracks so
    // the DetectionsTimeline works even when the analysis server restarts.
    if (this._db) {
      const _ctx = this._pipelines.get(_cameraId);
      if (_ctx && _ctx._trackMeta) {
        for (const obj of remoteTracked) {
          if (obj.className === 'face' || obj.className === 'fire' || obj.className === 'smoke') continue;
          const id = String(obj.objectId);
          const existing = _ctx._trackMeta.get(id);
          if (existing) {
            existing.lastSeenAt = _ts;
            if ((obj.riskScore ?? 0) > (existing.maxRiskScore ?? 0)) existing.maxRiskScore = obj.riskScore;
            if (obj.isLoitering) existing.isLoitering = true;
            existing.confidence = Math.max(existing.confidence, obj.confidence ?? 0);
            if (obj.faceId)   existing.faceId   = obj.faceId;
            if (obj.identity) existing.identity = obj.identity;
            if (obj.color)    existing.color    = obj.color;
            if (obj.cloth)    existing.cloth    = obj.cloth;
            if (obj.zoneId)   existing.zoneId   = obj.zoneId;
            if (obj.zoneName) existing.zoneName = obj.zoneName;
          } else {
            _ctx._trackMeta.set(id, {
              firstSeenAt:  _ts,
              lastSeenAt:   _ts,
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
      }
    }

    for (const b of (result.behaviors || [])) {
      if (b.isLoitering || b.type === 'loitering') {
        this._io.to(_cameraId).emit('loitering', b);
        this._alertService.createAlert({ ...b, cameraId: _cameraId }).catch((err) => {
          console.error('[PipelineManager] Alert creation failed:', err.message);
        });
      }
    }

    if (snapshotSvc.isEnabled() && allDetections.length > 0) {
      const _db  = this._db;
      const _io  = this._io;
      const _cam = camera;
      setImmediate(async () => {
        for (const det of allDetections) {
          try {
            const hasFaceMatch = !!(det.face && det.face.matchScore > 0) || !!det.matchScore;
            const isFireSmoke  = det.className === 'fire' || det.className === 'smoke';
            if (!snapshotSvc.shouldSave(_cameraId, det.objectId, {
                  isLoitering: det.isLoitering,
                  hasFaceMatch,
                  isFireSmoke,
                  timestamp:   _ts,
                })) continue;
            // det.bbox is in the analysis server's (possibly downscaled) coordinate
            // space — _buf is the native buffer retained locally, so scale up first.
            // The scaled bbox (not det.bbox) is what gets persisted, so the stored
            // record's bbox/frameWidth/frameHeight/cropWidth/cropHeight stay consistent.
            const cropBbox = _scaleBbox(det.bbox, remoteFrameWidth, remoteFrameHeight, _fw, _fh);
            const { data: cropBuf, width: cw, height: ch } =
              await snapshotSvc.cropJpeg(_buf, cropBbox, _fw, _fh);
            const snapId = await snapshotSvc.saveSnapshot(
              _db, _cam, { ...det, bbox: cropBbox }, cropBuf, cw, ch, _fw, _fh, _ts
            );
            _io.to(_cameraId).emit('snapshot:new', {
              cameraId:   _cameraId,
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

  /**
   * Assign stable face IDs to detected faces using cosine similarity of ArcFace embeddings.
   * Uses a single shared gallery across all cameras to enable cross-camera Re-ID.
   *
   * When a face matches a gallery entry that was last seen on a DIFFERENT camera,
   * a `face:reidentified` Socket.IO event is broadcast to all connected clients:
   *   { faceId, prevCameraId, newCameraId, similarity, timestamp }
   *
   * Faces without embeddings get a transient per-frame ID (not enrolled in gallery).
   * Expired gallery entries (>FACE_EXPIRY_MS since last seen) are pruned each call.
   *
   * @param {string} cameraId      - ID of the camera that captured these faces
   * @param {string} cameraName    - Display name of that camera (camera.name || camera.id)
   * @param {Array}  detectedFaces - Output from attributePipeline (each may have .embedding)
   * @param {number} timestamp     - Current frame timestamp (ms since epoch)
   * @returns {Array} detectedFaces with faceId, matchScore, and crossCamera fields added
   */
  _assignFaceIds(cameraId, cameraName, detectedFaces, timestamp) {
    // Prune stale entries from the shared gallery (in-place replacement)
    this._sharedFaceGallery = this._sharedFaceGallery.filter(
      g => timestamp - g.lastSeenAt < FACE_EXPIRY_MS
    );

    const usedGalleryIds      = new Set();
    const crossCameraTransitions = [];
    const pendingMatchEvents   = [];  // v1.1: collected instead of emitting directly

    const result = detectedFaces.map(face => {
      if (!face.embedding) {
        // No embedding — assign transient ID, skip gallery enrollment
        return { ...face, faceId: `F${this._faceCounter++}` };
      }

      // Find best matching gallery entry across ALL cameras by cosine similarity
      let bestEntry = null, bestScore = FACE_MATCH_THRESH;
      for (const g of this._sharedFaceGallery) {
        if (usedGalleryIds.has(g.faceId)) continue;
        const sim = _cosineSim(face.embedding, g.embedding);
        if (sim > bestScore) { bestScore = sim; bestEntry = g; }
      }

      if (bestEntry) {
        const prevCameraId = bestEntry.lastCameraId;

        // Cross-camera Re-ID: same face seen on a different camera
        if (prevCameraId !== cameraId) {
          // Update per-face cross-camera stats
          const stats = this._crossCameraStats.get(bestEntry.faceId) || {
            faceId:          bestEntry.faceId,
            firstCameraId:   prevCameraId,
            lastCameraId:    prevCameraId,
            transitionCount: 0,
            lastSeenAt:      bestEntry.lastSeenAt,
          };
          stats.transitionCount++;
          stats.lastCameraId = cameraId;
          stats.lastSeenAt   = timestamp;
          this._crossCameraStats.set(bestEntry.faceId, stats);

          // Defer emission — face bbox is stored so the caller can resolve newObjectId
          crossCameraTransitions.push({
            faceId:      bestEntry.faceId,
            prevCameraId,
            newCameraId: cameraId,
            similarity:  bestScore,
            timestamp,
            faceBbox:    face.bbox,
          });
        }

        // Update gallery entry with current camera and timestamp
        bestEntry.lastSeenAt   = timestamp;
        bestEntry.lastCameraId = cameraId;
        usedGalleryIds.add(bestEntry.faceId);

        // Also search persistent gallery for named identity
        let namedMatch2 = null, namedScore2 = FACE_MATCH_THRESH;
        for (const pg of this._persistentGallery) {
          const sim = _cosineSim(face.embedding, pg.embedding);
          if (sim > namedScore2) { namedScore2 = sim; namedMatch2 = pg; }
        }
        if (namedMatch2) {
          const cooldownKey = `${bestEntry.faceId}:${namedMatch2.id}`;
          const lastEmit = this._faceMatchCooldown.get(cooldownKey) || 0;
          if (timestamp - lastEmit > 30_000) {
            this._faceMatchCooldown.set(cooldownKey, timestamp);
            const gallery2 = this._db.findOne('faceGalleries', { id: namedMatch2.galleryId });
            const galleryType2 = gallery2?.type || 'general';
            const matchEvt2 = {
              faceId:      bestEntry.faceId,
              cameraId,
              cameraName,
              identity:    namedMatch2.name,
              galleryId:   namedMatch2.galleryId,
              galleryType: galleryType2,
              matchScore:  namedScore2,
              thumbnail:   namedMatch2.thumbnail,
              timestamp,
            };
            // v1.1: collect instead of emit — frame handler will crop + emit
            pendingMatchEvents.push({ evt: matchEvt2, faceBbox: face.bbox });
          }
        }

        return {
          ...face,
          faceId:      bestEntry.faceId,
          matchScore:  bestScore,
          identity:    namedMatch2 ? namedMatch2.name : undefined,
          crossCamera: prevCameraId !== cameraId ? { prevCameraId } : undefined,
        };
      }

      // New face — enroll in shared gallery with current camera
      const newId = `F${this._faceCounter++}`;
      this._scheduleFaceTrackingSave();
      this._sharedFaceGallery.push({
        faceId:       newId,
        embedding:    face.embedding,
        lastSeenAt:   timestamp,
        lastCameraId: cameraId,
      });

      // Search persistent (named) gallery for this new face
      let namedMatch = null, namedScore = FACE_MATCH_THRESH;
      for (const pg of this._persistentGallery) {
        const sim = _cosineSim(face.embedding, pg.embedding);
        if (sim > namedScore) { namedScore = sim; namedMatch = pg; }
      }
      if (namedMatch) {
        const cooldownKey = `${newId}:${namedMatch.id}`;
        const lastEmit = this._faceMatchCooldown.get(cooldownKey) || 0;
        if (timestamp - lastEmit > 30_000) {
          this._faceMatchCooldown.set(cooldownKey, timestamp);
          const gallery = this._db.findOne('faceGalleries', { id: namedMatch.galleryId });
          const galleryType = gallery?.type || 'general';
          const matchEvt = {
            faceId:      newId,
            cameraId,
            cameraName,
            identity:    namedMatch.name,
            galleryId:   namedMatch.galleryId,
            galleryType,
            matchScore:  namedScore,
            thumbnail:   namedMatch.thumbnail,
            timestamp,
          };
          // v1.1: collect instead of emit — frame handler will crop + emit
          pendingMatchEvents.push({ evt: matchEvt, faceBbox: face.bbox });
        }
        return { ...face, faceId: newId, identity: namedMatch.name, matchScore: namedScore };
      }

      return { ...face, faceId: newId };
    });

    return { faces: result, crossCameraTransitions, pendingMatchEvents };
  }

  /**
   * Assign clothing IDs to detected persons and detect cross-camera appearance transitions.
   *
   * For each person detection that has color data (upperRgb), search the shared clothing
   * gallery using _clothingAppearSim(). Entries expire after CLOTHING_EXPIRY_MS (5 min).
   * When a match is found on a DIFFERENT camera, a cross-camera clothing transition is recorded.
   *
   * @param {string} cameraId        - Camera that captured the frame
   * @param {Array}  enrichedObjects - Tracked person objects with color/cloth attributes
   * @param {number} timestamp       - Frame timestamp (ms)
   * @param {Map}    objectIdToFaceId - Optional objectId→faceId link from face Re-ID
   * @param {Map}    [objectIdToEmbedding] - Optional objectId→OSNet embedding (Proposed,
   *   CrossCamera Face Tracking Phase-2). When present for both sides of a comparison,
   *   matching uses the 80/20 embedding/color weighting (FR-CCFR-061); otherwise the
   *   existing Phase-1 color-only similarity is used unchanged (FR-CCFR-062).
   * @returns {{ assignments, crossCameraTransitions }}
   */
  _assignClothingIds(cameraId, enrichedObjects, timestamp, objectIdToFaceId = new Map(), objectIdToEmbedding = new Map()) {
    // Prune expired gallery entries
    this._sharedClothingGallery = this._sharedClothingGallery.filter(
      g => timestamp - g.lastSeenAt < CLOTHING_EXPIRY_MS
    );

    const assignments          = [];
    const crossCameraTransitions = [];
    // Fix: prevent two people in the same frame both matching the same gallery
    // entry (the face-Re-ID equivalent, _assignFaceIds, already guards this).
    const usedGalleryIds = new Set();

    for (const obj of enrichedObjects) {
      if (obj.className !== 'person') continue;
      if (!obj.color?.upperRgb) continue; // need at least upper colour to match

      const feature = {
        upperRgb:  obj.color.upperRgb,
        lowerRgb:  obj.color.lowerRgb ?? null,
        lower:     obj.cloth?.lower   ?? null,
        embedding: objectIdToEmbedding.get(String(obj.objectId)) ?? null,
      };
      const linkedFaceId = objectIdToFaceId.get(String(obj.objectId)) ?? null;

      let bestEntry = null, bestScore = CLOTHING_MATCH_THRESH;
      for (const g of this._sharedClothingGallery) {
        if (usedGalleryIds.has(g.clothingId)) continue;
        const sim = _weightedAppearSim(feature, g.feature);
        if (sim > bestScore) { bestScore = sim; bestEntry = g; }
      }

      // Best-effort Qdrant upsert — fire-and-forget, never blocks the frame pipeline.
      if (feature.embedding && this._qdrant?.ready) {
        const idForUpsert = bestEntry ? bestEntry.clothingId : `C${this._clothingCounter}`;
        this._qdrant.upsertAppearance(idForUpsert, feature.embedding, {
          cameraId, colorUpper: feature.upper, colorLower: feature.lower, timestamp,
        }).catch(() => {});
      }

      if (bestEntry) {
        usedGalleryIds.add(bestEntry.clothingId);
        if (feature.embedding) bestEntry.feature.embedding = feature.embedding;
        const prevCameraId = bestEntry.lastCameraId;

        if (prevCameraId !== cameraId) {
          // Update per-clothing cross-camera stats
          const stats = this._crossClothingStats.get(bestEntry.clothingId) || {
            clothingId:      bestEntry.clothingId,
            firstCameraId:   prevCameraId,
            lastCameraId:    prevCameraId,
            transitionCount: 0,
            lastSeenAt:      bestEntry.lastSeenAt,
          };
          stats.transitionCount++;
          stats.lastCameraId = cameraId;
          stats.lastSeenAt   = timestamp;
          this._crossClothingStats.set(bestEntry.clothingId, stats);

          crossCameraTransitions.push({
            clothingId:  bestEntry.clothingId,
            faceId:      linkedFaceId || bestEntry.faceId || null,
            prevCameraId,
            newCameraId: cameraId,
            similarity:  bestScore,
            objectId:    obj.objectId,
            timestamp,
            feature,
          });
        }

        bestEntry.lastSeenAt   = timestamp;
        bestEntry.lastCameraId = cameraId;
        if (linkedFaceId && !bestEntry.faceId) bestEntry.faceId = linkedFaceId;

        assignments.push({ objectId: obj.objectId, clothingId: bestEntry.clothingId, matchScore: bestScore });
      } else {
        // New clothing profile — enroll in shared gallery
        const clothingId = `C${this._clothingCounter++}`;
        this._sharedClothingGallery.push({
          clothingId,
          feature,
          lastSeenAt:   timestamp,
          lastCameraId: cameraId,
          faceId:       linkedFaceId,
        });
        assignments.push({ objectId: obj.objectId, clothingId, matchScore: 1.0 });
      }
    }

    return { assignments, crossCameraTransitions };
  }

  /**
   * CrossCamera Face Tracking Phase-2 (Proposed) — per-track throttled OSNet
   * embedding extraction. Reuses a cached embedding within APPEARANCE_EMBED_INTERVAL_MS
   * instead of re-running the model every frame (mirrors AI-05 Phase-3's HP cache).
   * @returns {Promise<number[]|null>}
   */
  async _getAppearanceEmbedding(jpegBuffer, objectId, bbox) {
    const key = String(objectId);
    const now = Date.now();
    const cached = this._appearanceEmbedCache.get(key);
    if (cached && (now - cached.ts) < APPEARANCE_EMBED_INTERVAL_MS) return cached.embedding;

    const emb = await this._appearanceReid.getEmbedding(jpegBuffer, bbox);
    if (emb) this._appearanceEmbedCache.set(key, { ts: now, embedding: emb });
    return emb;
  }

  /**
   * Age Estimation (Proposed) — per-track throttled inference. Reuses a cached
   * result within AGE_ESTIMATION_INTERVAL_MS instead of re-running the model
   * every frame (mirrors _getAppearanceEmbedding above).
   * @returns {Promise<{value:number,bucket?:string,source:'face'|'body',modelId:string}|null>}
   */
  async _getAgeEstimate(jpegBuffer, objectId, bbox, isFaceCrop) {
    const key = String(objectId);
    const now = Date.now();
    const cached = this._ageEstimateCache.get(key);
    if (cached && (now - cached.ts) < AGE_ESTIMATION_INTERVAL_MS) return cached.result;

    const result = await this._ageEstimation.estimateAge(jpegBuffer, bbox, { isFaceCrop });
    if (result) this._ageEstimateCache.set(key, { ts: now, result });
    return result;
  }

  /**
   * Return clothing cross-camera Re-ID statistics for the current server session.
   * @returns {Array<{ clothingId, firstCameraId, lastCameraId, transitionCount, lastSeenAt }>}
   */
  getCrossClothingReIdStats() {
    return [...this._crossClothingStats.values()];
  }

  /**
   * Return cross-camera Re-ID statistics for the current server session.
   * Each entry describes a face that has been seen on more than one camera.
   *
   * @returns {Array<{ faceId, firstCameraId, lastCameraId, transitionCount, lastSeenAt }>}
   */
  getCrossCameraReIdStats() {
    return [...this._crossCameraStats.values()];
  }

  /**
   * Return active person trajectories for the REST endpoint.
   * @param {number} maxAgeMs  Include persons last seen within this window (default 5 min)
   */
  getPersonTrajectories(maxAgeMs = 300_000) {
    const cutoff = Date.now() - maxAgeMs;
    return [...this._personTrajectory.values()].filter(p => p.lastSeenAt >= cutoff);
  }

  // ---------------------------------------------------------------------------
  // Face tracking persistence — face_tracking.json
  // ---------------------------------------------------------------------------

  /** Load persisted trajectory state on startup. MongoDB mode loads from DB; JSON mode loads from face_tracking.json. */
  _loadFaceTracking() {
    try {
      // MongoDB mode: DB mirror was loaded from MongoDB at init time — use it.
      if (this._db && this._db.getMode() === 'mongodb') {
        const rows = this._db.all('faceTrajectories');
        for (const row of rows) {
          if (!row.faceId) continue;
          this._personTrajectory.set(row.faceId, {
            faceId:          row.faceId,
            alias:           row.alias,
            firstSeenAt:     row.firstSeenAt,
            lastSeenAt:      row.lastSeenAt,
            currentCameraId: row.currentCameraId,
            segments:        row.segments || [],
          });
          // Derive counters from stored IDs so they don't reset on restart.
          const idNum    = parseInt(row.faceId.slice(1))  || 0;
          const aliasNum = parseInt((row.alias || '').slice(1)) || 0;
          if (idNum    > this._faceCounter)        this._faceCounter        = idNum;
          if (aliasNum > this._personAliasCounter) this._personAliasCounter = aliasNum;
        }
        console.log(`[PipelineManager] Loaded face tracking from MongoDB: faceCounter=${this._faceCounter}, persons=${this._personTrajectory.size}`);
        return;
      }

      // JSON mode: load from face_tracking.json backup file.
      if (!fs.existsSync(FACE_TRACKING_PATH)) return;
      const raw = fs.readFileSync(FACE_TRACKING_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.faceCounter === 'number' && data.faceCounter > this._faceCounter) {
        this._faceCounter = data.faceCounter;
      }
      if (typeof data.personAliasCounter === 'number') {
        this._personAliasCounter = data.personAliasCounter;
      }
      if (Array.isArray(data.trajectories)) {
        for (const t of data.trajectories) {
          if (t && t.faceId) {
            this._personTrajectory.set(t.faceId, t);
          }
        }
      }
      console.log(`[PipelineManager] Loaded face tracking: faceCounter=${this._faceCounter}, persons=${this._personTrajectory.size}`);
    } catch (e) {
      console.warn('[PipelineManager] _loadFaceTracking error:', e.message);
    }
  }

  /** Persist trajectory state to storage/face_tracking.json (debounced 1 s). */
  _scheduleFaceTrackingSave() {
    if (this._faceTrackingSaveTimer) clearTimeout(this._faceTrackingSaveTimer);
    this._faceTrackingSaveTimer = setTimeout(() => {
      this._faceTrackingSaveTimer = null;
      this._saveFaceTracking();
    }, 1000);
  }

  _saveFaceTracking() {
    // MongoDB mode: _upsertTrajectoryToDb() already persists each trajectory
    // individually as events occur — no batch file write needed.
    // Skipping the synchronous JSON.stringify + writeFileSync (5+ MB) prevents
    // event loop blocking that would stall frame delivery from ingest-daemon.
    if (this._db && this._db.getMode() === 'mongodb') return;

    try {
      const trajectories = [...this._personTrajectory.values()].map(t => ({
        faceId: t.faceId,
        alias: t.alias,
        firstSeenAt: t.firstSeenAt,
        lastSeenAt: t.lastSeenAt,
        currentCameraId: t.currentCameraId,
        segments: (t.segments || []).map(s => ({
          cameraId: s.cameraId,
          objectId: s.objectId ?? null,
          entryTime: s.entryTime,
          exitTime: s.exitTime ?? null,
          similarity: s.similarity ?? null,
        })),
      }));

      // JSON mode: write file backup asynchronously to avoid blocking the event loop.
      const data = { faceCounter: this._faceCounter, personAliasCounter: this._personAliasCounter, trajectories };
      const dir = path.dirname(FACE_TRACKING_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.promises.writeFile(FACE_TRACKING_PATH, JSON.stringify(data, null, 2), 'utf8')
        .catch(e => console.warn('[PipelineManager] _saveFaceTracking write error:', e.message));

    } catch (e) {
      console.warn('[PipelineManager] _saveFaceTracking error:', e.message);
    }
  }

  // DB upsert for a single trajectory — called when a trajectory is created or
  // transitions to a new camera. Avoids the O(n²) cost of batch-upsert in _saveFaceTracking().
  _upsertTrajectoryToDb(traj) {
    if (!this._db) return;
    try {
      const row = {
        id: traj.faceId,
        faceId: traj.faceId,
        alias: traj.alias,
        firstSeenAt: traj.firstSeenAt,
        lastSeenAt: traj.lastSeenAt,
        currentCameraId: traj.currentCameraId,
        segments: (traj.segments || []).map(s => ({
          cameraId: s.cameraId,
          objectId: s.objectId ?? null,
          entryTime: s.entryTime,
          exitTime: s.exitTime ?? null,
          similarity: s.similarity ?? null,
        })),
      };
      if (this._db.findOne('faceTrajectories', { id: traj.faceId })) {
        this._db.update('faceTrajectories', traj.faceId, row);
      } else {
        this._db.insert('faceTrajectories', row);
      }
    } catch (e) {
      console.warn('[PipelineManager] _upsertTrajectoryToDb error:', e.message);
    }
  }

  /**
   * Reload persistent face gallery from DB.
   * Called by the REST API after enrollment or deletion.
   */
  reloadPersistentGallery() {
    try {
      this._persistentGallery = this._db.find('faceGalleryFaces', {})
        .filter(f => Array.isArray(f.embedding) && f.embedding.length > 0);
      console.log(`[PipelineManager] Persistent gallery reloaded — ${this._persistentGallery.length} face(s)`);
    } catch (e) {
      console.warn('[PipelineManager] reloadPersistentGallery error:', e.message);
    }
  }

  /** Eagerly initialize the attribute pipeline (face + PPE + color) without starting a camera.
   *  Called on server startup so gallery enrollment works even with no active cameras. */
  async loadFaceServiceEagerly() {
    if (SERVER_MODE === 'streaming') {
      console.log('[PipelineManager] Streaming mode — skip eager AttributePipeline load');
      return;
    }
    if (this._attrPipeline) return; // already loaded (camera was started first)
    this._attrPipeline = new AttributePipeline();
    await this._attrPipeline.load().catch((err) => {
      console.warn('[PipelineManager] Eager FaceService load warn:', err.message);
    });
    if (this._appearanceReid.status === 'not_started') {
      await this._appearanceReid.load().catch((err) => {
        console.warn('[PipelineManager] Eager AppearanceReidService load warn:', err.message);
      });
    }
    console.log(`[PipelineManager] Eager load — face:${this._attrPipeline.faceStatus}`);
  }

  _normalizeRtspUrl(inputUrl, cameraId) {
    if (typeof inputUrl !== 'string') return inputUrl;
    let normalized = inputUrl.trim();

    // Common typo from camera configuration: "rtps://" -> "rtsp://"
    if (/^rtps:\/\//i.test(normalized)) {
      normalized = normalized.replace(/^rtps:\/\//i, 'rtsp://');
      console.warn(
        `[PipelineManager][${cameraId || 'unknown'}] Invalid protocol "rtps://" detected; ` +
        'normalized to "rtsp://".'
      );
    }

    return normalized;
  }

  _buildRtspUrl(camera) {
    if (camera.rtspUrl) {
      const normalizedRtspUrl = this._normalizeRtspUrl(camera.rtspUrl, camera.id);
      // Inject credentials if not already in URL
      if (camera.username && !normalizedRtspUrl.includes('@')) {
        try {
          const url = new URL(normalizedRtspUrl);
          url.username = camera.username;
          url.password = camera.password || '';
          return url.toString();
        } catch (e) {
          console.warn(
            `[PipelineManager][${camera.id}] Failed to parse RTSP URL; ` +
            `using normalized URL as-is. (${e.message})`
          );
          return normalizedRtspUrl;
        }
      }
      return normalizedRtspUrl;
    }
    const user = camera.username || process.env.RTSP_DEFAULT_USERNAME || 'admin';
    const pass = camera.password || process.env.RTSP_DEFAULT_PASSWORD || '';
    return `rtsp://${user}:${pass}@${camera.ip}/stream1`;
  }

  _updateCameraStatus(cameraId, status) {
    try {
      this._db.update('cameras', cameraId, { status });
      this._io.to(cameraId).emit('camera:status', { cameraId, status });
    } catch (_) {}
  }
}

module.exports = PipelineManager;
