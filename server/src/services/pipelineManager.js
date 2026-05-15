'use strict';

const { v4: uuidv4 } = require('uuid');

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

const RTSPCapture      = require('./rtspCapture');
const DetectionService = require('./detection');
const { ByteTracker }  = require('./tracking');
const BehaviorEngine   = require('./behaviorEngine');
const ZoneManager      = require('./zoneManager');
const AlertService     = require('./alertService');
const AttributePipeline = require('./attributePipeline');
const FireSmokeService  = require('./fireSmokeService');

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
    this._io             = io;
    this._db             = db;
    this._pipelines       = new Map(); // cameraId → PipelineContext
    this._zoneManager     = new ZoneManager(db);
    this._alertService    = new AlertService(db);
    this._detector        = null;  // Shared YOLOv8n instance
    this._attrPipeline    = null;  // Shared attribute pipeline
    this._fireSmokeService = null; // Shared fire/smoke detector
    this._fireAlertCooldown = new Map(); // `${cameraId}:${zoneName}:${cls}` → lastAlertTs

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

    // Lazy-load attribute pipeline (face / PPE / color)
    if (!this._attrPipeline) {
      this._attrPipeline = new AttributePipeline();
      await this._attrPipeline.load().catch((err) => {
        console.warn('[PipelineManager] AttributePipeline load warn:', err.message);
      });
    }

    // Lazy-load fire/smoke service
    if (!this._fireSmokeService) {
      this._fireSmokeService = new FireSmokeService();
      await this._fireSmokeService.load().catch((err) => {
        console.warn('[PipelineManager] FireSmokeService load warn:', err.message);
      });
    }

    const rtspUrl = this._buildRtspUrl(camera);
    const capture = new RTSPCapture(camera.id, rtspUrl, { fps: 10, width: 640 });
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
      _inferring: false,  // frame-drop guard: skip inference when previous is still running
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

      // Emit raw frame immediately so the UI can display it without waiting for inference
      this._io.to(camera.id).emit('frame', {
        cameraId:    camera.id,
        frameId:     currentFrameId,
        timestamp,
        data:        jpegBuffer.toString('base64'),
        frameWidth,
        frameHeight,
      });

      // Skip inference if previous frame is still being processed (frame-drop)
      if (ctx._inferring) return;
      ctx._inferring = true;

      try {
        // 2. Run detection (if model is loaded)
        let detections = [];
        if (this._detector) {
          try {
            const result = await this._detector.detect(jpegBuffer);
            detections  = result.detections;
            frameWidth  = result.frameWidth;
            frameHeight = result.frameHeight;
          } catch (err) {
            console.error(`[PipelineManager][${camera.id}] Detection error:`, err.message);
          }
        }

        // 3. Update tracker
        const trackedObjects = tracker.update(detections);

        // 4. Run behavior analysis
        const behaviorObjects = behavior.update(camera.id, trackedObjects, timestamp);

        // 5. Attribute enrichment (face / PPE / color) — only when models are loaded
        let enrichedObjects = behaviorObjects;
        if (this._attrPipeline && this._attrPipeline.anyReady) {
          try {
            const zones = this._zoneManager.getActiveZones(camera.id);
            enrichedObjects = await this._attrPipeline.enrich(
              jpegBuffer, frameWidth, frameHeight, behaviorObjects, zones
            );
          } catch (err) {
            console.error(`[PipelineManager][${camera.id}] Attribute pipeline error:`, err.message);
          }
        }

        // 6. Fire/smoke detection — full-frame, independent of person tracking
        let fireSmokeObjects = [];
        if (this._fireSmokeService && this._fireSmokeService.ready) {
          const zones = this._zoneManager.getActiveZones(camera.id);
          const needFS = zones.some(z =>
            z.targetClasses?.some(c => c === 'fire' || c === 'smoke')
          );
          if (needFS) {
            try {
              const raw = await this._fireSmokeService.detect(jpegBuffer, frameWidth, frameHeight);
              fireSmokeObjects = raw.map((d, i) => ({
                ...d,
                objectId:    80000 + (currentFrameId % 1000) * 10 + i,
                isLoitering: false,
                dwellTime:   0,
              }));
              // Emit fire:alert for detections intersecting a MONITOR zone
              for (const det of fireSmokeObjects) {
                const center = {
                  x: det.bbox.x + det.bbox.width  / 2,
                  y: det.bbox.y + det.bbox.height / 2,
                };
                for (const zone of zones) {
                  if (zone.type !== 'MONITOR') continue;
                  if (!zone.targetClasses?.includes(det.className)) continue;
                  if (zone.polygon.length < 3) continue;
                  if (!_pointInPolygon(center, zone.polygon)) continue;
                  // Cooldown: same camera+zone+class → at most once per 10 s
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
                  console.warn(`[PipelineManager][${camera.id}] ${det.className.toUpperCase()} detected in zone "${zone.name}" (${(det.confidence * 100).toFixed(0)}%)`);
                }
              }
            } catch (err) {
              console.error(`[PipelineManager][${camera.id}] FireSmoke error:`, err.message);
            }
          }
        }

        // 7. Emit combined detections (person/vehicle + fire/smoke)
        this._io.to(camera.id).emit('detections', {
          cameraId:    camera.id,
          frameId:     currentFrameId,
          timestamp,
          detections:  [...enrichedObjects, ...fireSmokeObjects],
          frameWidth,
          frameHeight,
        });
      } finally {
        ctx._inferring = false;
      }
    });

    capture.on('started', ({ cmdline }) => {
      console.log(`[PipelineManager][${camera.id}] FFmpeg started: ${cmdline}`);
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
      console.warn(`[RTSPCapture][${camera.id}] ${message}`);
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
      this._updateCameraStatus(camera.id, 'reconnecting');
      this._io.to(camera.id).emit('camera:error', { cameraId: camera.id, message: err.message });
      // Restart the entire pipeline after 1 second (spawn-level failure recovery)
      if (ctx.running) {
        setTimeout(() => {
          if (ctx.running) this.startCamera(camera).catch(() => {});
        }, 1000);
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
      this._db.update('cameras', cameraId, { status });
      this._io.to(cameraId).emit('camera:status', { cameraId, status });
    } catch (_) {}
  }
}

module.exports = PipelineManager;
