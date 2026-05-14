'use strict';

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('../services/pipelineManager')} pipelineManager
 * @returns {Router}
 */
function camerasRouter(db, pipelineManager) {
  const router = Router();

  /**
   * GET /api/cameras
   * List all cameras with their current pipeline status.
   */
  router.get('/', (req, res) => {
    try {
      const cameras = db.prepare('SELECT * FROM cameras ORDER BY createdAt DESC').all();
      const result = cameras.map((cam) => {
        const pipelineStatus = pipelineManager.getCameraStatus(cam.id);
        return {
          ...cam,
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

      const id = uuidv4();
      db.prepare(`
        INSERT INTO cameras (id, name, rtspUrl, username, password, ip, mac, httpPort, status)
        VALUES (@id, @name, @rtspUrl, @username, @password, @ip, @mac, @httpPort, 'offline')
      `).run({
        id, name, rtspUrl,
        username:  username  || process.env.RTSP_DEFAULT_USERNAME || null,
        password:  password  || process.env.RTSP_DEFAULT_PASSWORD || null,
        ip:        ip        || null,
        mac:       mac       || null,
        httpPort:  httpPort  || null,
      });

      const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
      res.status(201).json({ success: true, data: { ...camera, password: undefined } });
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
      const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
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
   * DELETE /api/cameras/:id
   * Remove a camera and stop its stream.
   */
  router.delete('/:id', async (req, res) => {
    try {
      const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      await pipelineManager.stopCamera(camera.id);
      db.prepare('DELETE FROM cameras WHERE id = ?').run(camera.id);

      res.json({ success: true, message: 'Camera removed' });
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
      const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
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
      const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
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
