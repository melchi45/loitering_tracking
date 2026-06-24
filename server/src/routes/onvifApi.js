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

  const registry = _db.all('onvif_event_types');
  const known    = new Set(registry.map(r => r.topicType));

  // Backfill: scan onvif_events for topicTypes not yet in the registry.
  // This handles events stored before the type registration feature existed,
  // or after a server restart that reset the in-memory dedup state.
  const seen = new Set(known);
  for (const evt of _db.all('onvif_events')) {
    if (!evt.topicType || seen.has(evt.topicType)) continue;
    seen.add(evt.topicType);
    const entry = {
      id:          evt.topicType,
      topicType:   evt.topicType,
      topicLabel:  evt.topicLabel || evt.topicType,
      topic:       evt.topic || '',
      severity:    evt.severity || 'info',
      firstSeenAt: evt.serverTs || evt.createdAt || new Date().toISOString(),
    };
    _db.insert('onvif_event_types', entry);
    registry.push(entry);
  }

  const types = registry.sort((a, b) => (a.topicLabel > b.topicLabel ? 1 : -1));
  res.json({ total: types.length, types });
});

// ── DELETE /api/onvif-event-types ─────────────────────────────────────────────
typesRouter.delete('/', (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB not ready' });
  const all = _db.all('onvif_event_types');
  all.forEach(r => _db.delete('onvif_event_types', r.id));
  res.json({ deleted: all.length });
});

// ── GET /api/onvif-snapshots ──────────────────────────────────────────────────
// Query: eventId (required or optional), cameraId, topicType, from, to, limit
const snapshotsRouter = express.Router();

snapshotsRouter.get('/', (req, res) => {
  if (!_db) return res.status(503).json({ error: 'DB not ready' });

  const { eventId, cameraId, topicType, from, to, limit } = req.query;
  const maxRows = Math.min(parseInt(limit, 10) || 50, 200);

  // Filter by indexed fields first before loading the full table.
  // onvif_snapshots rows contain large frameData blobs — filtering early
  // avoids sorting and serializing thousands of rows on every request.
  const exactWhere = {};
  if (eventId)   exactWhere.eventId   = eventId;
  if (cameraId)  exactWhere.cameraId  = cameraId;
  if (topicType) exactWhere.topicType = topicType;

  let rows = Object.keys(exactWhere).length > 0
    ? _db.find('onvif_snapshots', exactWhere)
    : _db.all('onvif_snapshots');

  rows.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1)); // newest first

  if (from) rows = rows.filter(r => r.timestamp >= from);
  if (to)   rows = rows.filter(r => r.timestamp <= to);

  rows = rows.slice(0, maxRows);

  // Return frameData as data URL for direct use in <img>
  const result = rows.map(r => ({
    ...r,
    frameData: r.frameData
      ? `data:image/jpeg;base64,${r.frameData}`
      : null,
  }));

  res.json({ total: result.length, snapshots: result });
});

module.exports = { router, typesRouter, snapshotsRouter, setDb };
