'use strict';

const { v4: uuidv4 } = require('uuid');
const RTSPCapture     = require('./rtspCapture');
const DetectionService = require('./detection');
const { ByteTracker } = require('./tracking');
const BehaviorEngine  = require('./behaviorEngine');
const ZoneManager     = require('./zoneManager');
const AlertService    = require('./alertService');

/**
 * Orchestrates the full camera processing pipeline:
 * RTSPCapture → Detection → Tracking → BehaviorEngine → Socket.IO emission
 */
class PipelineManager {
  /**
   * @param {import('socket.io').Server} io
   * @param {import('better-sqlite3').Database} db
   */
  constructor(io, db) {
    this._io          = io;
    this._db          = db;
    this._pipelines   = new Map(); // cameraId → PipelineContext
    this._zoneManager = new ZoneManager(db);
    this._alertService = new AlertService(db);
    this._detector    = null;  // Shared single model instance
  }

  /**
   * Start the processing pipeline for a camera.
   * @param {object} camera  Camera row from DB { id, rtspUrl, username, password, ... }
   * @returns {Promise<void>}
   */
  async startCamera(camera) {
    if (this._pipelines.has(camera.id)) {
      await this.stopCamera(camera.id);
    }

    // Lazy-load detector (shared across cameras)
    if (!this._detector) {
      this._detector = new DetectionService();
      await this._detector.load().catch((err) => {
        console.warn('[PipelineManager] ONNX model not loaded — detection disabled:', err.message);
        this._detector = null;
      });
    }

    const rtspUrl = this._buildRtspUrl(camera);
    const capture = new RTSPCapture(camera.id, rtspUrl, { fps: 10, width: 640, height: 640 });
    const tracker = new ByteTracker();
    const behavior = new BehaviorEngine(this._zoneManager);

    let frameId = 0;

    const ctx = {
      capture,
      tracker,
      behavior,
      running: true,
      frameCount: 0,
      lastFrameAt: null,
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

    this._alertService.on('alert', (alert) => {
      this._io.emit('alert:new', alert);
    });

    // ── Frame processing ──────────────────────────────────────────────────
    capture.on('frame', async (jpegBuffer) => {
      if (!ctx.running) return;

      const currentFrameId = ++frameId;
      const timestamp = Date.now();
      ctx.frameCount++;
      ctx.lastFrameAt = timestamp;

      // 1. Emit raw frame (base64 JPEG)
      this._io.to(camera.id).emit('frame', {
        cameraId:  camera.id,
        frameId:   currentFrameId,
        timestamp,
        data:      jpegBuffer.toString('base64'),
      });

      // 2. Run detection (if model is loaded)
      let detections = [];
      if (this._detector) {
        try {
          detections = await this._detector.detect(jpegBuffer);
        } catch (err) {
          console.error(`[PipelineManager][${camera.id}] Detection error:`, err.message);
        }
      }

      // 3. Update tracker
      const trackedObjects = tracker.update(detections);

      // 4. Run behavior analysis
      const enrichedObjects = behavior.update(camera.id, trackedObjects, timestamp);

      // 5. Emit detections + tracking results
      this._io.to(camera.id).emit('detections', {
        cameraId:   camera.id,
        frameId:    currentFrameId,
        timestamp,
        detections: enrichedObjects,
      });
    });

    capture.on('started', ({ cmdline }) => {
      console.log(`[PipelineManager][${camera.id}] FFmpeg started`);
      this._updateCameraStatus(camera.id, 'streaming');
    });

    capture.on('reconnecting', ({ attempt, delay }) => {
      console.warn(`[PipelineManager][${camera.id}] Reconnecting (attempt ${attempt}, delay ${delay}ms)`);
      this._updateCameraStatus(camera.id, 'reconnecting');
    });

    capture.on('error', (err) => {
      console.error(`[PipelineManager][${camera.id}] Fatal error:`, err.message);
      this._updateCameraStatus(camera.id, 'error');
      this._io.to(camera.id).emit('camera:error', { cameraId: camera.id, message: err.message });
    });

    capture.on('stats', ({ frameCount }) => {
      this._io.to(camera.id).emit('camera:stats', {
        cameraId: camera.id,
        frameCount,
        fps: ctx.lastFrameAt ? Math.round(frameCount / ((Date.now() - (ctx.startedAt || Date.now())) / 1000)) : 0,
      });
    });

    ctx.startedAt = Date.now();
    this._pipelines.set(camera.id, ctx);
    this._updateCameraStatus(camera.id, 'connecting');
    capture.start();
  }

  /**
   * Stop the pipeline for a camera.
   * @param {string} cameraId
   * @returns {Promise<void>}
   */
  async stopCamera(cameraId) {
    const ctx = this._pipelines.get(cameraId);
    if (!ctx) return;

    ctx.running = false;
    ctx.capture.stop();
    ctx.behavior.reset();
    ctx.behavior.removeAllListeners();
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
      frameCount:  ctx.frameCount,
      lastFrameAt: ctx.lastFrameAt,
    };
  }

  /** Stop all pipelines (for graceful shutdown). */
  async stopAll() {
    const ids = [...this._pipelines.keys()];
    await Promise.all(ids.map(id => this.stopCamera(id)));
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _buildRtspUrl(camera) {
    if (camera.rtspUrl) {
      // Inject credentials if not already in URL
      if (camera.username && !camera.rtspUrl.includes('@')) {
        const url = new URL(camera.rtspUrl);
        url.username = camera.username;
        url.password = camera.password || '';
        return url.toString();
      }
      return camera.rtspUrl;
    }
    const user = camera.username || process.env.RTSP_DEFAULT_USERNAME || 'admin';
    const pass = camera.password || process.env.RTSP_DEFAULT_PASSWORD || '';
    return `rtsp://${user}:${pass}@${camera.ip}/stream1`;
  }

  _updateCameraStatus(cameraId, status) {
    try {
      this._db
        .prepare('UPDATE cameras SET status = ? WHERE id = ?')
        .run(status, cameraId);
    } catch (_) {}
  }
}

module.exports = PipelineManager;
