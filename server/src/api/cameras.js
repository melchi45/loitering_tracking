'use strict';

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');

function normalizeRtspUrl(rtspUrl) {
  if (typeof rtspUrl !== 'string' || !rtspUrl.trim()) {
    return { ok: false, error: 'rtspUrl must be a non-empty string' };
  }

  let normalized = rtspUrl.trim();
  let correctedFromRtps = false;
  if (/^rtps:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^rtps:\/\//i, 'rtsp://');
    correctedFromRtps = true;
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_) {
    return { ok: false, error: 'rtspUrl must be a valid RTSP URL' };
  }

  if (parsed.protocol !== 'rtsp:') {
    return { ok: false, error: 'rtspUrl must start with rtsp://' };
  }

  return { ok: true, value: parsed.toString(), correctedFromRtps };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('../services/pipelineManager')} pipelineManager
 * @param {import('../services/youtubeStreamService')|null} [youtubeSvc]
 * @returns {Router}
 */
function camerasRouter(db, pipelineManager, youtubeSvc = null) {
  const router = Router();

  /**
   * GET /api/cameras
   * List all cameras with their current pipeline status.
   */
  router.get('/', (req, res) => {
    try {
      const cameras = db.all('cameras').sort((a, b) =>
        (b.createdAt || '').localeCompare(a.createdAt || ''));
      const result = cameras.map((cam) => {
        const pipelineStatus = pipelineManager.getCameraStatus(cam.id);
        // YouTube cameras store bitrate in DB as bps; normalize to kbps for API consumers
        const bitrate = cam.type === 'youtube' && cam.bitrate
          ? Math.round(cam.bitrate / 1000)
          : cam.bitrate;
        return {
          ...cam,
          bitrate,
          password:       undefined, // Never expose password in list
          pipelineStatus: pipelineStatus || null,
        };
      });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/discover
   * Trigger UDP discovery broadcast. Results are sent via Socket.IO.
   * Returns an empty array immediately; real results arrive via 'discovery:result' socket event.
   */
  router.post('/discover', (req, res) => {
    try {
      // Signal via Socket.IO to start discovery (handled in streamHandler)
      // The actual UDPDiscovery is kicked off by the client via socket event.
      // This REST endpoint exists as a convenience trigger.
      const io = req.app.get('io');
      if (io) {
        io.emit('discovery:trigger');
      }
      res.json({ success: true, data: [], message: 'Discovery started. Listen for discovery:result socket events.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras
   * Add a new camera.
   * Body: { name, rtspUrl, username?, password?, ip?, mac?, httpPort? }
   */
  router.post('/', (req, res) => {
    try {
      const { name, rtspUrl, username, password, ip, mac, httpPort } = req.body;
      if (!name || !rtspUrl) {
        return res.status(400).json({ success: false, error: 'name and rtspUrl are required' });
      }

      const normalizedRtsp = normalizeRtspUrl(rtspUrl);
      if (!normalizedRtsp.ok) {
        return res.status(400).json({ success: false, error: normalizedRtsp.error });
      }

      const id = uuidv4();
      db.insert('cameras', {
        id, name, rtspUrl: normalizedRtsp.value,
        username:  username  || process.env.RTSP_DEFAULT_USERNAME || null,
        password:  password  || process.env.RTSP_DEFAULT_PASSWORD || null,
        ip:        ip        || null,
        mac:       mac       || null,
        httpPort:  httpPort  || null,
        status:    'offline',
      });

      const camera = db.findOne('cameras', { id });
      res.status(201).json({
        success: true,
        data: { ...camera, password: undefined },
        warning: normalizedRtsp.correctedFromRtps ? 'rtps:// was corrected to rtsp:// automatically' : undefined,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/cameras/:id
   * Get details for a specific camera.
   */
  router.get('/:id', (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      const pipelineStatus = pipelineManager.getCameraStatus(camera.id);
      res.json({
        success: true,
        data: { ...camera, password: undefined, pipelineStatus: pipelineStatus || null },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /api/cameras/:id
   * Update camera config. Restarts the pipeline when rtspUrl, credentials, or
   * webrtcEnabled change so the new settings take effect immediately.
   */
  router.put('/:id', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      const { name, rtspUrl, username, password, webrtcEnabled } = req.body;
      let normalizedRtsp = null;
      if (rtspUrl !== undefined) {
        normalizedRtsp = normalizeRtspUrl(rtspUrl);
        if (!normalizedRtsp.ok) {
          return res.status(400).json({ success: false, error: normalizedRtsp.error });
        }
      }

      const updates = {};
      if (name          !== undefined) updates.name          = name;
      if (rtspUrl       !== undefined) updates.rtspUrl       = normalizedRtsp.value;
      if (username      !== undefined) updates.username      = username || null;
      if (password      !== undefined) updates.password      = password || null;
      if (webrtcEnabled !== undefined) updates.webrtcEnabled = !!webrtcEnabled;

      db.update('cameras', camera.id, updates);
      const updated = db.findOne('cameras', { id: camera.id });

      // Only restart pipeline when a value that actually affects the stream changed.
      // Checking presence (webrtcEnabled !== undefined) was wrong — CameraEditModal
      // always sends webrtcEnabled, causing a ByteTracker reset on every save.
      const needsRestart =
        (rtspUrl       !== undefined && normalizedRtsp.value    !== camera.rtspUrl) ||
        (webrtcEnabled !== undefined && !!webrtcEnabled        !== !!camera.webrtcEnabled) ||
        (username      !== undefined && (username || null)     !== camera.username) ||
        (password      !== undefined && (password || null)     !== camera.password);

      // Respond immediately so the browser does not time out while waiting for
      // ONNX model load / RTSP negotiation (can take several seconds).
      res.json({
        success: true,
        data: { ...updated, password: undefined },
        restarted: needsRestart,
        warning: normalizedRtsp?.correctedFromRtps ? 'rtps:// was corrected to rtsp:// automatically' : undefined,
      });

      if (needsRestart && updated.status !== 'idle') {
        setImmediate(async () => {
          try {
            await pipelineManager.stopCamera(camera.id);
            await pipelineManager.startCamera(updated);
          } catch (e) {
            console.error('[cameras] pipeline restart error:', e.message);
          }
        });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/stream/reconnect
   * Stop the current pipeline and start fresh (double-click or post-edit reconnect).
   */
  router.post('/:id/stream/reconnect', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      res.json({ success: true, message: 'Reconnecting', cameraId: camera.id });
      setImmediate(async () => {
        try {
          await pipelineManager.stopCamera(camera.id);
          await pipelineManager.startCamera(camera);
        } catch (e) {
          console.error('[cameras] reconnect error:', e.message);
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * DELETE /api/cameras/:id
   * Remove a camera and stop its stream.
   * For YouTube virtual cameras, also stops the yt-dlp/ffmpeg pipeline.
   */
  router.delete('/:id', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      // Stop the YouTube stream service first (kills yt-dlp + ffmpeg, removes from memory)
      if (camera.type === 'youtube' && youtubeSvc) {
        try { await youtubeSvc.stopStream(camera.id); } catch { /* already removed */ }
      } else {
        await pipelineManager.stopCamera(camera.id);
        db.delete('cameras', camera.id);
      }

      res.json({ success: true, message: 'Camera removed' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/ai/toggle
   * Toggle AI inference on/off for a camera without restarting the pipeline.
   */
  router.post('/:id/ai/toggle', (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      const newValue = camera.aiEnabled === false ? true : false; // default is true, so toggle
      db.update('cameras', camera.id, { aiEnabled: newValue });
      pipelineManager.setAiEnabled(camera.id, newValue);

      res.json({ success: true, aiEnabled: newValue });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/stream/start
   * Start the processing pipeline for a camera.
   */
  router.post('/:id/stream/start', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      await pipelineManager.startCamera(camera);
      res.json({ success: true, message: 'Pipeline started', cameraId: camera.id });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/stream/stop
   * Stop the processing pipeline for a camera.
   */
  router.post('/:id/stream/stop', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      await pipelineManager.stopCamera(camera.id);
      res.json({ success: true, message: 'Pipeline stopped', cameraId: camera.id });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = camerasRouter;
