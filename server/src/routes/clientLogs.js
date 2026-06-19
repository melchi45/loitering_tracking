'use strict';

/**
 * /api/client-logs  — browser console log ingestion & retrieval.
 *
 * POST /api/client-logs        receive a batch of log entries from the browser
 * GET  /api/client-logs        query stored logs (level, sessionId, from/to, limit)
 * DELETE /api/client-logs      clear all stored logs
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function buildClientLogsRouter(db) {
  const router = express.Router();

  // ── POST /api/client-logs ─────────────────────────────────────────────────
  // Body: { entries: Array<LogEntry>, sessionId, userAgent, url }
  // LogEntry: { level, message, args?, timestamp, stack? }
  router.post('/', (req, res) => {
    const { entries, sessionId, userAgent, pageUrl } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries must be a non-empty array' });
    }
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket.remoteAddress
                  || 'unknown';

    const now = new Date().toISOString();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      db.insert('client_logs', {
        id:         uuidv4(),
        sessionId:  sessionId  || null,
        clientIp,
        userAgent:  userAgent  || null,
        pageUrl:    pageUrl    || null,
        level:      (entry.level || 'log').toLowerCase(),
        message:    String(entry.message ?? ''),
        args:       entry.args    ?? null,
        stack:      entry.stack   ?? null,
        clientTs:   entry.timestamp ?? null,
        serverTs:   now,
      });
    }
    res.json({ ok: true, stored: entries.length });
  });

  // ── GET /api/client-logs ──────────────────────────────────────────────────
  // Query: level=error|warn|info|log|debug  sessionId=  from=ISO  to=ISO  limit=N
  router.get('/', (req, res) => {
    const { level, sessionId, from, to, limit = '200' } = req.query;
    let rows = db.all('client_logs');

    if (level)     rows = rows.filter(r => r.level === level.toLowerCase());
    if (sessionId) rows = rows.filter(r => r.sessionId === sessionId);
    if (from)      rows = rows.filter(r => r.serverTs >= from);
    if (to)        rows = rows.filter(r => r.serverTs <= to);

    // newest first
    rows.sort((a, b) => (b.serverTs > a.serverTs ? 1 : -1));
    rows = rows.slice(0, Math.min(parseInt(limit, 10) || 200, 2000));

    res.json({ total: rows.length, entries: rows });
  });

  // ── DELETE /api/client-logs ───────────────────────────────────────────────
  router.delete('/', (req, res) => {
    const all = db.all('client_logs');
    for (const r of all) db.delete('client_logs', r.id);
    res.json({ ok: true, deleted: all.length });
  });

  // ── GET /api/client-logs/webrtc ───────────────────────────────────────────
  // Query: sessionId=  cameraId=  pcId=  from=  to=  limit=N
  router.get('/webrtc', (req, res) => {
    const { sessionId, cameraId, pcId, from, to, limit = '100' } = req.query;
    let rows = db.all('client_webrtc_stats');

    if (sessionId) rows = rows.filter(r => r.sessionId === sessionId);
    if (cameraId)  rows = rows.filter(r => r.cameraId  === cameraId);
    if (pcId)      rows = rows.filter(r => r.pcId      === pcId);
    if (from)      rows = rows.filter(r => r.serverTs  >= from);
    if (to)        rows = rows.filter(r => r.serverTs  <= to);

    rows.sort((a, b) => (b.serverTs > a.serverTs ? 1 : -1));
    rows = rows.slice(0, Math.min(parseInt(limit, 10) || 100, 1000));

    res.json({ total: rows.length, entries: rows });
  });

  // ── DELETE /api/client-logs/webrtc ────────────────────────────────────────
  router.delete('/webrtc', (req, res) => {
    const all = db.all('client_webrtc_stats');
    for (const r of all) db.delete('client_webrtc_stats', r.id);
    res.json({ ok: true, deleted: all.length });
  });

  return router;
};
