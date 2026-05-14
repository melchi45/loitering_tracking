'use strict';

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('../services/alertService')} alertService
 * @returns {{ eventsRouter: Router, alertsRouter: Router }}
 */
function buildRouters(db, alertService) {
  const eventsRouter = Router();
  const alertsRouter = Router();

  // ─── Events ────────────────────────────────────────────────────────────────

  /**
   * GET /api/events
   * Query loitering events with optional filters.
   * Query params: cameraId, from (ISO date), to (ISO date), limit (default 100)
   */
  eventsRouter.get('/', (req, res) => {
    try {
      const { cameraId, from, to, limit = 100 } = req.query;

      let sql = 'SELECT * FROM events WHERE 1=1';
      const params = [];

      if (cameraId) { sql += ' AND cameraId = ?'; params.push(cameraId); }
      if (from)     { sql += ' AND startTime >= ?'; params.push(from); }
      if (to)       { sql += ' AND startTime <= ?'; params.push(to); }

      sql += ' ORDER BY startTime DESC LIMIT ?';
      params.push(parseInt(limit) || 100);

      const events = db.prepare(sql).all(...params);
      res.json({ success: true, data: events, count: events.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/events/:id/clip
   * Stream the video clip associated with an event.
   * Must be defined BEFORE /:id to avoid shadowing.
   */
  eventsRouter.get('/:id/clip', (req, res) => {
    try {
      const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
      if (!event) return res.status(404).json({ success: false, error: 'Event not found' });
      if (!event.clipPath) return res.status(404).json({ success: false, error: 'No clip available' });

      const clipPath = path.resolve(event.clipPath);
      if (!fs.existsSync(clipPath)) {
        return res.status(404).json({ success: false, error: 'Clip file not found on disk' });
      }

      const stat = fs.statSync(clipPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;

        res.writeHead(206, {
          'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': chunksize,
          'Content-Type':   'video/mp4',
        });
        fs.createReadStream(clipPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type':   'video/mp4',
        });
        fs.createReadStream(clipPath).pipe(res);
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/events/:id
   * Get a single event by ID.
   */
  eventsRouter.get('/:id', (req, res) => {
    try {
      const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
      if (!event) return res.status(404).json({ success: false, error: 'Event not found' });
      res.json({ success: true, data: event });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── Alerts ─────────────────────────────────────────────────────────────────

  /**
   * GET /api/alerts
   * List alerts with optional filter.
   * Query params: acknowledged (true/false), cameraId, limit
   */
  alertsRouter.get('/', (req, res) => {
    try {
      const { acknowledged, cameraId, limit = 100 } = req.query;

      let sql = 'SELECT * FROM alerts WHERE 1=1';
      const params = [];

      if (acknowledged !== undefined) {
        sql += ' AND acknowledged = ?';
        params.push(acknowledged === 'true' || acknowledged === '1' ? 1 : 0);
      }
      if (cameraId) { sql += ' AND cameraId = ?'; params.push(cameraId); }

      sql += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(parseInt(limit) || 100);

      const alerts = db.prepare(sql).all(...params);
      res.json({ success: true, data: alerts, count: alerts.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/alerts/:id/acknowledge
   * Mark an alert as acknowledged.
   */
  alertsRouter.post('/:id/acknowledge', (req, res) => {
    try {
      const changed = alertService.acknowledgeAlert(req.params.id);
      if (!changed) return res.status(404).json({ success: false, error: 'Alert not found' });
      res.json({ success: true, message: 'Alert acknowledged' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return { eventsRouter, alertsRouter };
}

module.exports = buildRouters;
