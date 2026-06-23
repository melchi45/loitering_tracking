'use strict';

/**
 * Internal API — consumed only by the ingest daemon (localhost).
 * Not exposed through authentication middleware.
 *
 * POST /api/internal/frame/:cameraId
 *   Body: image/jpeg binary
 *   Called by the ingest-daemon AI thread at ~10 FPS per camera.
 *
 * POST /api/internal/apprtp/:cameraId
 *   Body: application/json  { pt, timestamp, seq, payload }
 *   Called by ingest-daemon when camera has Application RTP tracks (ONVIF etc.).
 *   Parsed ONVIF events are stored in onvif_events DB table (state-change dedup).
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { parseOnvifPayload } = require('../services/onvifParser');

const router  = express.Router();

let _pipelineManager = null;
let _io              = null;
let _db              = null;

function setPipelineManager(pm) { _pipelineManager = pm; }
function setSocketIO(io)        { _io = io; }
function setDb(db)              { _db = db; }

// Per-camera+topic+source last known state — prevents storing periodic heartbeats
// that repeat the same state (State=false every 30ms).
// key: `${cameraId}:${topic}:${sourceToken}` → last State string
const _lastStates = new Map();

// ── AI JPEG frame ─────────────────────────────────────────────────────────────
router.post(
  '/frame/:cameraId',
  express.raw({ type: 'image/jpeg', limit: '4mb' }),
  (req, res) => {
    const { cameraId } = req.params;
    const jpegBuffer   = req.body;

    if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer.length === 0) {
      return res.sendStatus(400);
    }

    if (_pipelineManager && typeof _pipelineManager.onIngestFrame === 'function') {
      _pipelineManager.onIngestFrame(cameraId, jpegBuffer);
    }

    res.sendStatus(200);
  }
);

// ── Application RTP forwarding + ONVIF storage ────────────────────────────────
router.post(
  '/apprtp/:cameraId',
  express.json({ limit: '64kb' }),
  (req, res) => {
    const { cameraId } = req.params;
    const data = req.body;

    if (!data || typeof data !== 'object') {
      return res.sendStatus(400);
    }

    // 1. Broadcast via Socket.IO (all engine modes)
    if (_io) {
      _io.emit('appRtp', { cameraId, ...data });
    }

    // 2. Forward to mediasoup DataProducer (mediasoup mode)
    try {
      const { getEngine, WEBRTC_ENGINE } = require('../services/webrtcEngineFactory');
      if (WEBRTC_ENGINE === 'mediasoup' && typeof getEngine().sendAppRtp === 'function') {
        getEngine().sendAppRtp(cameraId, data);
      }
    } catch (err) {
      console.error('[internalApi] sendAppRtp error:', err.message);
    }

    // 3. Parse ONVIF metadata and store state-change events
    if (_db && data.payload) {
      try {
        const parsedList = parseOnvifPayload(data.payload);
        if (Array.isArray(parsedList)) {
          for (const parsed of parsedList) {
            // Radiometry (thermal camera): emit real-time temperature event every reading.
            // Do NOT dedup — the live overlay needs every update.
            if (parsed.radiometry && parsed.radiometry.length > 0 && _io) {
              _io.emit('onvif:temperature', {
                cameraId,
                utcTime:  parsed.utcTime,
                readings: parsed.radiometry,
              });
            }

            // Dedup: only store when state actually changes for this camera+topic+sourceToken
            const dedupKey = `${cameraId}:${parsed.topic}:${parsed.sourceToken}`;
            const lastState = _lastStates.get(dedupKey);
            if (lastState !== parsed.state) {
              _lastStates.set(dedupKey, parsed.state);
              const now = new Date().toISOString();
              const event = {
                id:          uuidv4(),
                cameraId,
                topic:       parsed.topic,
                topicType:   parsed.topicType,
                topicLabel:  parsed.topicLabel,
                severity:    parsed.severity,
                utcTime:     parsed.utcTime,
                operation:   parsed.operation,
                sourceToken: parsed.sourceToken,
                state:       parsed.state,
                items:       JSON.stringify(parsed.items),
                rawPayload:  data.payload,
                serverTs:    now,
              };
              _db.insert('onvif_events', event);

              // On state=true (event START) or point events (no state), capture snapshot
              if ((parsed.state === 'true' || parsed.state == null) && _pipelineManager) {
                setImmediate(() => {
                  try {
                    const frame = _pipelineManager.getLatestFrame(cameraId);
                    if (frame && frame.buf) {
                      _db.insert('onvif_snapshots', {
                        id:          uuidv4(),
                        eventId:     event.id,
                        cameraId,
                        topicType:   parsed.topicType,
                        timestamp:   now,
                        frameData:   frame.buf.toString('base64'),
                        frameWidth:  frame.fw,
                        frameHeight: frame.fh,
                        createdAt:   now,
                      });
                    }
                  } catch (_e) { /* never block ONVIF path */ }
                });
              }

              // Register topicType globally if first time seen
              const knownTypes = _db.all('onvif_event_types');
              if (!knownTypes.some(r => r.topicType === parsed.topicType)) {
                const typeEntry = {
                  id:          parsed.topicType,
                  topicType:   parsed.topicType,
                  topicLabel:  parsed.topicLabel,
                  topic:       parsed.topic,
                  severity:    parsed.severity,
                  firstSeenAt: now,
                };
                _db.insert('onvif_event_types', typeEntry);
                if (_io) _io.emit('onvif:type-registered', typeEntry);
              }

              // Notify connected clients of the new event
              if (_io) _io.emit('onvif:event', event);
            }
          }
        }
      } catch (err) {
        // Never let ONVIF parsing errors break the main path
        console.warn('[internalApi] ONVIF parse error:', err.message);
      }
    }

    res.sendStatus(200);
  }
);

module.exports = { router, setPipelineManager, setSocketIO, setDb };
