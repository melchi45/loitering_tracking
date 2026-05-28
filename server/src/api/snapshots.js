'use strict';
/**
 * snapshots.js — REST API for Detection Snapshot Storage
 *
 * Routes:
 *   GET    /api/snapshots          list snapshots (no cropData in list)
 *   GET    /api/snapshots/:id      single snapshot (includes cropData)
 *   DELETE /api/snapshots/:id      delete snapshot
 */

const { Router } = require('express');

function buildRouter(db) {
  const router = Router();

  // ─── GET /api/snapshots ─────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    try {
      const {
        cameraId, objectId, className, isLoitering,
        from, to, q,
        limit  = 50,
        offset = 0,
      } = req.query;

      const lim = Math.min(parseInt(limit)  || 50,  200);
      const off = Math.max(parseInt(offset) || 0,   0);

      let snaps = db.all('detectionSnapshots');

      if (objectId)   snaps = snaps.filter(s => s.objectId  === objectId);
      if (cameraId)   snaps = snaps.filter(s => s.cameraId  === cameraId);
      if (className)  snaps = snaps.filter(s => s.className === className);
      if (isLoitering !== undefined) {
        const flag = isLoitering === 'true' || isLoitering === true;
        snaps = snaps.filter(s => s.isLoitering === flag);
      }
      if (from) snaps = snaps.filter(s => s.timestamp >= from);
      if (to)   snaps = snaps.filter(s => s.timestamp <= to);
      if (q) {
        const ql = q.toLowerCase();
        snaps = snaps.filter(s =>
          (s.className  || '').toLowerCase().includes(ql) ||
          (s.cameraName || '').toLowerCase().includes(ql) ||
          (s.zoneName   || '').toLowerCase().includes(ql) ||
          (s.attributes?.face?.name || '').toLowerCase().includes(ql)
        );
      }

      snaps.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

      const total = snaps.length;
      const page  = snaps.slice(off, off + lim);

      // Strip cropData from list response to keep payload small
      const result = page.map(({ cropData: _cd, ...rest }) => rest); // eslint-disable-line no-unused-vars

      res.json({ total, offset: off, limit: lim, snapshots: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── GET /api/snapshots/:id ─────────────────────────────────────────────────
  router.get('/:id', (req, res) => {
    try {
      const snap = db.findOne('detectionSnapshots', { id: req.params.id });
      if (!snap) return res.status(404).json({ success: false, error: 'Not found' });
      res.json(snap);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── DELETE /api/snapshots/:id ──────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    try {
      const snap = db.findOne('detectionSnapshots', { id: req.params.id });
      if (!snap) return res.status(404).json({ success: false, error: 'Not found' });
      db.delete('detectionSnapshots', req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter };
