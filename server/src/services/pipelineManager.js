'use strict';

const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');
const snapshotSvc = require('./snapshotService');

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
const RtpIngestion     = require('./rtpIngestion');
const webrtcGateway    = require('./webrtcGateway');
const DetectionService = require('./detection');
const { ByteTracker }  = require('./tracking');
const BehaviorEngine   = require('./behaviorEngine');
const ZoneManager      = require('./zoneManager');
const AlertService     = require('./alertService');
const AttributePipeline = require('./attributePipeline');
const FireSmokeService  = require('./fireSmokeService');
const analyticsConfig  = require('./analyticsConfig');

const SERVER_MODE = process.env.SERVER_MODE || 'combined';

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

const FACE_MATCH_THRESH   = 0.35;  // cosine similarity threshold for same-person
const FACE_EXPIRY_MS      = 30000; // forget a face after 30s of absence
const FACE_TRACKING_PATH  = path.join(__dirname, '../../../storage/face_tracking.json');

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
   */
  constructor(io, db, zoneManager = null) {
    this._io             = io;
    this._db             = db;
    this._pipelines       = new Map(); // cameraId → PipelineContext
    this._zoneManager     = zoneManager || new ZoneManager(db);
    this._alertService    = new AlertService(db);
    this._detector        = null;  // Shared YOLOv8n instance
    this._attrPipeline    = null;  // Shared attribute pipeline
    this._fireSmokeService = null; // Shared fire/smoke detector
    this._analysisClient   = null; // Remote analysis client (streaming mode only)
    this._fireAlertCooldown = new Map(); // `${cameraId}:${zoneName}:${cls}` → lastAlertTs
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
          console.error('[PipelineManager] SERVER_MODE=streaming requires ANALYSIS_SERVER_URL in .env');
          return;
        }
        this._analysisClient = new AnalysisClient(url);
        const health = await this._analysisClient.healthCheck();
        console.log('[PipelineManager] Analysis server health:', JSON.stringify(health));
      }
    } else {
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
    }

    const rtspUrl  = this._buildRtspUrl(camera);
    const useWebRTC = !!(camera.webrtcEnabled && webrtcGateway.enabled);

    const captureFps = parseInt(process.env.CAPTURE_FPS, 10) || 10;

    let capture;
    if (useWebRTC) {
      capture = new RtpIngestion(camera.id, rtspUrl, { fps: captureFps, width: 640 });
      await capture.start(); // async: sets up mediasoup PlainTransports then spawns FFmpeg
    } else {
      capture = createCapture(camera.id, rtspUrl, { fps: captureFps, width: 640 });
    }

    const tracker  = new ByteTracker();
    const behavior = new BehaviorEngine(this._zoneManager);

    let frameId = 0;

    const ctx = {
      capture,
      tracker,
      behavior,
      running:     true,
      useWebRTC,
      aiEnabled:   camera.aiEnabled !== false, // default true
      frameCount:  0,
      lastFrameAt: null,
      _inferring:  false,
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

      // Emit raw JPEG frame only for cameras NOT using WebRTC
      // (WebRTC cameras stream video via mediasoup to <video> element)
      if (!ctx.useWebRTC) {
        this._io.to(camera.id).emit('frame', {
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

      // Skip all inference when every analytics module is disabled
      if (!analyticsConfig.anyModuleEnabled()) return;

      // Skip inference if previous frame is still being processed (frame-drop)
      if (ctx._inferring) return;
      ctx._inferring = true;

      try {
        // ── Streaming mode: delegate all AI inference to remote analysis server ──
        if (SERVER_MODE === 'streaming' && this._analysisClient) {
          const zones = this._zoneManager.getActiveZones(camera.id);
          const result = await this._analysisClient.analyzeFrame({
            cameraId:        camera.id,
            frameId:         currentFrameId,
            timestamp:       new Date(timestamp).toISOString(),
            jpegBuffer,
            zones,
            analyticsConfig: analyticsConfig.getConfig(),
          });
          if (result) {
            this._io.to(camera.id).emit('detections', {
              cameraId:   camera.id,
              frameId:    currentFrameId,
              timestamp,
              detections: [...(result.tracked || []), ...(result.fireSmoke || [])],
              frameWidth:  result.frameWidth  || frameWidth,
              frameHeight: result.frameHeight || frameHeight,
            });
            for (const b of (result.behaviors || [])) {
              if (b.isLoitering || b.type === 'loitering') {
                this._io.to(camera.id).emit('loitering', b);
                this._alertService.createAlert({ ...b, cameraId: camera.id }).catch((err) => {
                  console.error('[PipelineManager] Alert creation failed:', err.message);
                });
              }
            }
          }
          return; // skip local inference below
        }

        // 2. Run detection — skipped entirely if no detection module is enabled
        let detections = [];
        if (this._detector && analyticsConfig.anyDetectionEnabled()) {
          try {
            const result = await this._detector.detect(jpegBuffer);
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
        let attrObjects    = trackedObjects;
        let faceDetObjects = [];
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
                this._assignFaceIds(camera.id, detectedFaces, timestamp);

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
                      _db.insert('faceMatchHistory', {
                        id:        require('crypto').randomUUID(),
                        ...fullEvt,
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
                    segments: [{ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: timestamp, exitTime: timestamp }],
                  };
                  this._personTrajectory.set(ev.faceId, traj);
                } else {
                  const lastSeg = traj.segments[traj.segments.length - 1];
                  lastSeg.exitTime = ev.timestamp;
                  traj.segments.push({ cameraId: ev.newCameraId, objectId: newObjectId, entryTime: ev.timestamp, exitTime: ev.timestamp });
                  traj.currentCameraId = ev.newCameraId;
                  traj.lastSeenAt      = ev.timestamp;
                }
                this._scheduleFaceTrackingSave();
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

        // 8. Save detection snapshots (non-blocking via setImmediate)
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
    this._pipelines.set(camera.id, ctx);
    this._updateCameraStatus(camera.id, 'connecting');
    // RtpIngestion was already started (async) above; capture backend starts here (sync)
    if (!useWebRTC) capture.start();
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
    if (ctx.useWebRTC) webrtcGateway.deleteRouter(cameraId);
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
   * Toggle AI inference for a running pipeline without restarting it.
   * @param {string} cameraId
   * @param {boolean} enabled
   */
  setAiEnabled(cameraId, enabled) {
    const ctx = this._pipelines.get(cameraId);
    if (ctx) ctx.aiEnabled = enabled;
  }

  /** Stop all pipelines (for graceful shutdown). */
  async stopAll() {
    const ids = [...this._pipelines.keys()];
    await Promise.all(ids.map(id => this.stopCamera(id)));
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
      ppe:       this._attrPipeline     ? this._attrPipeline.ppeStatus   : 'not_started',
      face:      this._attrPipeline     ? this._attrPipeline.faceStatus  : 'not_started',
      cloth:     this._attrPipeline     ? this._attrPipeline.clothStatus : 'not_started',
      firesmoke: this._fireSmokeService ? this._fireSmokeService.status  : 'not_started',
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

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
   * @param {Array}  detectedFaces - Output from attributePipeline (each may have .embedding)
   * @param {number} timestamp     - Current frame timestamp (ms since epoch)
   * @returns {Array} detectedFaces with faceId, matchScore, and crossCamera fields added
   */
  _assignFaceIds(cameraId, detectedFaces, timestamp) {
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

  /** Load persisted trajectory state from storage/face_tracking.json on startup. */
  _loadFaceTracking() {
    try {
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
    try {
      const data = {
        faceCounter: this._faceCounter,
        personAliasCounter: this._personAliasCounter,
        // Strip large embedding buffers from trajectory segments to save space
        trajectories: [...this._personTrajectory.values()].map(t => ({
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
          })),
        })),
      };
      const dir = path.dirname(FACE_TRACKING_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(FACE_TRACKING_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[PipelineManager] _saveFaceTracking error:', e.message);
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
    if (this._attrPipeline) return; // already loaded (camera was started first)
    this._attrPipeline = new AttributePipeline();
    await this._attrPipeline.load().catch((err) => {
      console.warn('[PipelineManager] Eager FaceService load warn:', err.message);
    });
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
