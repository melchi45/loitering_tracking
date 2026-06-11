'use strict';

/**
 * Internal API — consumed only by the Go ingest daemon (localhost).
 * Not exposed through authentication middleware.
 *
 * POST /api/internal/frame/:cameraId
 *   Body: image/jpeg binary
 *   Called by the ingest-daemon AI goroutine at ~10 FPS per camera.
 *   Feeds the JPEG directly into pipelineManager for AI inference.
 */

const express = require('express');
const router  = express.Router();

let _pipelineManager = null;

function setPipelineManager(pm) {
  _pipelineManager = pm;
}

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

module.exports = { router, setPipelineManager };
