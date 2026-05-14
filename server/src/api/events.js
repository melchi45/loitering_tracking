'use strict';

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');

function buildRouters(db, alertService) {
  const eventsRouter = Router();
  const alertsRouter = Router();

  // ─── Events ────────────────────────────────────────────────────────────────

  eventsRouter.get('/', (req, res) => {
    try {
      const { cameraId, from, to, limit = 100 } = req.query;
      const lim = parseInt(limit) || 100;

      let events = db.all('events');

      if (cameraId) events = events.filter(e => e.cameraId === cameraId);
      if (from)     events = events.filter(e => e.startTime >= from);
      if (to)       events = events.filter(e => e.startTime <= to);

      events.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));
      events = events.slice(0, lim);

      res.json({ success: true, data: events, count: events.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  eventsRouter.get('/:id/clip', (req, res) => {
    try {
      const event = db.findOne('events', { id: req.params.id });
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

  eventsRouter.get('/:id', (req, res) => {
    try {
      const event = db.findOne('events', { id: req.params.id });
      if (!event) return res.status(404).json({ success: false, error: 'Event not found' });
      res.json({ success: true, data: event });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── Alerts ─────────────────────────────────────────────────────────────────

  alertsRouter.get('/', (req, res) => {
    try {
      const { acknowledged, cameraId, limit = 100 } = req.query;
      const lim = parseInt(limit) || 100;

      let alerts = db.all('alerts');

      if (acknowledged !== undefined) {
        const ackBool = acknowledged === 'true' || acknowledged === '1';
        alerts = alerts.filter(a => Boolean(a.acknowledged) === ackBool);
      }
      if (cameraId) alerts = alerts.filter(a => a.cameraId === cameraId);

      alerts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      alerts = alerts.slice(0, lim);

      res.json({ success: true, data: alerts, count: alerts.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

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
