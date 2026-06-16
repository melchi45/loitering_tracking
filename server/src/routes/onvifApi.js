'use strict';

/**
 * ONVIF events REST API.
 *
 * GET  /api/onvif-events          — query stored ONVIF events
 *   ?cameraId=<id>                — filter by camera (optional)
 *   ?type=<topicType>             — filter by topic type (optional)
 *   ?severity=<severity>          — filter by severity (optional)
 *   ?from=<ISO>                   — start time inclusive (optional)
 *   ?to=<ISO>                     — end time inclusive (optional)
 *   ?limit=<n>                    — max rows, default 500
 *
 * DELETE /api/onvif-events        — clear all ONVIF events
 *   ?cameraId=<id>                — clear only for camera (optional)
 *
 * GET  /api/onvif-event-types     — all ever-seen ONVIF event types (global registry)
 * DELETE /api/onvif-event-types   — clear event type registry (admin use)
 */

const express = require('express');
const router      = express.Router();
const typesRouter = express.Router();

let _db = null;
function setDb(db) { _db = db; }

// GET /api/onvif-events
router.get('/', (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB not ready' });

  const { cameraId, type, severity, from, to, limit } = req.query;
  const maxRows = Math.min(parseInt(limit, 10) || 500, 5000);

  let rows = _db.all('onvif_events');

  // Newest first
  rows.sort((a, b) => (a.serverTs > b.serverTs ? -1 : 1));

  if (cameraId) rows = rows.filter(r => r.cameraId === cameraId);
  if (type)     rows = rows.filter(r => r.topicType === type);
  if (severity) rows = rows.filter(r => r.severity === severity);
  if (from)     rows = rows.filter(r => r.serverTs >= from);
  if (to)       rows = rows.filter(r => r.serverTs <= to);

  rows = rows.slice(0, maxRows);

  // Decode rawPayload for client (base64 → XML string for display)
  const result = rows.map(r => ({
    ...r,
    items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
    rawXml: r.rawPayload
      ? (() => { try { return Buffer.from(r.rawPayload, 'base64').toString('utf-8'); } catch { return null; } })()
      : null,
  }));

  res.json({ total: result.length, events: result });
});

// DELETE /api/onvif-events
router.delete('/', (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB not ready' });

  const { cameraId } = req.query;
  const all = _db.all('onvif_events');
  const toDelete = cameraId ? all.filter(r => r.cameraId === cameraId) : all;
  toDelete.forEach(r => _db.delete('onvif_events', r.id));

  res.json({ deleted: toDelete.length });
});

// ── GET /api/onvif-event-types ────────────────────────────────────────────────
typesRouter.get('/', (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB not ready' });
  const types = _db.all('onvif_event_types')
    .sort((a, b) => (a.topicLabel > b.topicLabel ? 1 : -1));
  res.json({ total: types.length, types });
});

// ── DELETE /api/onvif-event-types ─────────────────────────────────────────────
typesRouter.delete('/', (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB not ready' });
  const all = _db.all('onvif_event_types');
  all.forEach(r => _db.delete('onvif_event_types', r.id));
  res.json({ deleted: all.length });
});

module.exports = { router, typesRouter, setDb };
