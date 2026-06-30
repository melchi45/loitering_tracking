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
const { parseOnvifPayload, parseLogstringPayload } = require('../services/onvifParser');

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
        // Primary: ONVIF MetadataStream XML.
        // Fallback: Samsung proprietary "---logstring" text events on the App-RTP data track.
        const rawText = (() => { try { return Buffer.from(data.payload, 'base64').toString('utf-8'); } catch { return null; } })();
        let parsedList = parseOnvifPayload(data.payload);
        let parsedViaLogstring = false;
        if (parsedList === null) {
          parsedList = parseLogstringPayload(data.payload);
          if (parsedList !== null) {
            parsedViaLogstring = true;
          } else {
            // Still unparseable — log at debug for investigation.
            if (rawText && rawText.length > 64) {
              console.debug(`[internalApi][ONVIF] cam=${cameraId} payload not MetadataStream/logstring (${rawText.length}B): ${rawText.slice(0, 200)}`);
            }
          }
        }
        // INFO 로그: 수신된 모든 ONVIF MetadataStream/logstring 이벤트를 raw 내용과 함께 출력
        // boxTemperatureReading 은 초당 수십회 발생하므로 제외 (debug 레벨 유지)
        if (Array.isArray(parsedList)) {
          const NON_SPAMMY = parsedList.filter(e => e.topicType !== 'boxTemperatureReading');
          if (NON_SPAMMY.length > 0) {
            const src = parsedViaLogstring ? 'logstring' : 'ONVIF/XML';
            const summary = NON_SPAMMY.map(e => `${e.topicType}(state=${e.state})`).join(', ');
            console.info(
              `[internalApi][${src}] cam=${cameraId} events=[${summary}]\n` +
              `  raw(${rawText ? rawText.length : 0}B):\n${rawText ?? '(decode error)'}`
            );
          }
        }
        if (Array.isArray(parsedList)) {
          for (const parsed of parsedList) {
            // Radiometry (thermal camera): emit real-time temperature event every reading.
            // Do NOT dedup — the live overlay needs every update.
            if (parsed.radiometry && parsed.radiometry.length > 0) {
              parsed.radiometry.forEach((r, ri) => {
                console.debug(
                  `[internalApi][BoxTemperatureReading] cam=${cameraId} ` +
                  `area="${r.areaName ?? r.itemId ?? ri}" ` +
                  `max=${r.maxTemp}(${r.maxTempX},${r.maxTempY}) ` +
                  `min=${r.minTemp}(${r.minTempX},${r.minTempY}) ` +
                  `avg=${r.avgTemp} utc=${parsed.utcTime}`
                );
              });
              if (_io) {
                _io.emit('onvif:temperature', {
                  cameraId,
                  utcTime:  parsed.utcTime,
                  readings: parsed.radiometry,
                });
              }
            }

            // Dedup: only store when state actually changes for this camera+topic+sourceToken+ruleName
            // RuleName distinguishes multiple analytics rules on the same source — each rule is
            // an independent event stream and must not be collapsed across rule boundaries.
            const dedupKey = `${cameraId}:${parsed.topic}:${parsed.sourceToken}:${parsed.ruleName ?? ''}`;
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
                ruleName:    parsed.ruleName ?? null,
                state:       parsed.state,
                items:       JSON.stringify(parsed.items),
                rawPayload:  data.payload,
                serverTs:    now,
              };
              _db.insert('onvif_events', event);
              // Flush immediately so the event survives a crash/reboot within the 2-second debounce window
              if (typeof _db.flushNow === 'function') _db.flushNow();

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

/**
 * Close all in-progress ONVIF events for a camera that is going offline.
 *
 * When a camera disconnects without sending state=false for open events, those
 * events remain "in progress" indefinitely in the timeline.  This function:
 *   1. Scans onvif_events in the DB to find the most recent event per
 *      (topicType, sourceToken, ruleName) group for the camera.
 *   2. For each group whose latest event has state='true', inserts a synthetic
 *      state='false' closing event timestamped "now".
 *   3. Emits onvif:event via Socket.IO so live timeline UIs update immediately.
 *   4. Clears _lastStates entries for the camera so the next reconnect starts clean.
 *
 * Called by pipelineManager.stopCamera() via the onCameraOfflineHook.
 *
 * @param {string} cameraId
 */
function closeOpenEventsForCamera(cameraId) {
  if (!_db) return;
  const now = new Date().toISOString();

  // Find the most-recent event per (topicType, sourceToken, ruleName) for this camera.
  const events = _db.all('onvif_events').filter(e => e.cameraId === cameraId);

  if (events.length > 0) {
    // Sort ascending so the last entry in each group is the most recent.
    events.sort((a, b) => (a.serverTs < b.serverTs ? -1 : 1));

    const lastByGroup = new Map();
    for (const evt of events) {
      // Use '::' separator to avoid ambiguity with ':' inside topic strings.
      const groupKey = `${evt.topicType ?? evt.topic}::${evt.sourceToken ?? ''}::${evt.ruleName ?? ''}`;
      lastByGroup.set(groupKey, evt);
    }

    let closedCount = 0;
    for (const [, lastEvt] of lastByGroup) {
      if (lastEvt.state !== 'true') continue;

      const closeEvent = {
        id:             uuidv4(),
        cameraId,
        topic:          lastEvt.topic,
        topicType:      lastEvt.topicType,
        topicLabel:     lastEvt.topicLabel,
        severity:       lastEvt.severity,
        utcTime:        now,
        operation:      'Changed',
        sourceToken:    lastEvt.sourceToken ?? null,
        ruleName:       lastEvt.ruleName ?? null,
        state:          'false',
        items:          null,
        rawPayload:     null,
        serverTs:       now,
        disconnectClose: true,   // synthetic — generated on camera disconnect
      };

      _db.insert('onvif_events', closeEvent);
      if (_io) _io.emit('onvif:event', closeEvent);
      closedCount++;
    }

    if (closedCount > 0) {
      console.log(
        `[internalApi][ONVIF] cam=${cameraId} offline: ` +
        `auto-closed ${closedCount} in-progress event(s)`
      );
    }
  }

  // Clear dedup state for this camera so the next reconnect starts fresh.
  const prefix = `${cameraId}:`;
  for (const key of [..._lastStates.keys()]) {
    if (key.startsWith(prefix)) _lastStates.delete(key);
  }
}

module.exports = { router, setPipelineManager, setSocketIO, setDb, closeOpenEventsForCamera };
