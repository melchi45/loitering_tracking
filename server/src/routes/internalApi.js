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
 *   Called by ingest-daemon when WEBRTC_ENGINE=mediamtx and camera has
 *   Application RTP tracks (PT 96-127).  Server re-emits via Socket.IO.
 */

const express = require('express');
const router  = express.Router();

let _pipelineManager = null;
let _io              = null;

function setPipelineManager(pm) {
  _pipelineManager = pm;
}

function setSocketIO(io) {
  _io = io;
}

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

// ── Application RTP forwarding (mediamtx mode) ────────────────────────────────
router.post(
  '/apprtp/:cameraId',
  express.json({ limit: '64kb' }),
  (req, res) => {
    const { cameraId } = req.params;
    const data = req.body;

    if (!data || typeof data !== 'object') {
      return res.sendStatus(400);
    }

    // Emit via Socket.IO to all subscribers of this camera
    if (_io) {
      _io.emit('appRtp', { cameraId, ...data });
    }

    // Also forward to mediasoup DataProducer if engine is mediasoup
    try {
      const { getEngine, WEBRTC_ENGINE } = require('../webrtcEngineFactory');
      if (WEBRTC_ENGINE === 'mediasoup' && typeof getEngine().sendAppRtp === 'function') {
        getEngine().sendAppRtp(cameraId, data);
      }
    } catch (_) {}

    res.sendStatus(200);
  }
);

module.exports = { router, setPipelineManager, setSocketIO };
