'use strict';

const express = require('express');
const router  = express.Router();

const UserService    = require('../services/UserService');
const TokenService   = require('../services/TokenService');
const AuditService   = require('../services/AuditService');
const TcRunnerService = require('../services/TcRunnerService');
const ingestDaemonControl = require('../services/ingestDaemonControl');
const { notifyAnalysisCameraRemoved } = require('../api/cameras');
const { verifyAccessToken } = require('../middleware/auth');
const { requireRole }       = require('../middleware/role');
const { getSystemMetrics }  = require('../services/systemMetrics');
const { getDbStats, getDbDetailedStats } = require('../db');
const { getRecentLogs, setLogLevel, getLogLevel, tailLogFile } = require('../utils/logger');

// All admin routes require authentication + admin role
router.use(verifyAccessToken);
router.use(requireRole('admin'));

// ── GET /admin/users ──────────────────────────────────────────────────────────
// Query: ?status=pending|active|rejected|revoked  &search=<text>
router.get('/users', (req, res) => {
  const { status, search } = req.query;
  const users = UserService.list({ status, search });
  res.json({ users, total: users.length });
});

// ── GET /admin/users/:id ──────────────────────────────────────────────────────
router.get('/users/:id', (req, res) => {
  const user = UserService.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ── PATCH /admin/users/:id ────────────────────────────────────────────────────
// Body: { action: 'approve'|'reject'|'revoke'|'reactivate', role?: 'admin'|'operator'|'viewer' }
router.patch('/users/:id', async (req, res) => {
  try {
    const { action, role } = req.body;
    const valid = ['approve', 'reject', 'revoke', 'reactivate'];
    if (!valid.includes(action))
      return res.status(400).json({ error: `action must be one of: ${valid.join(', ')}` });

    // Prevent self-demotion
    if (req.params.id === req.user.sub && action === 'revoke')
      return res.status(400).json({ error: 'Cannot revoke your own account' });

    const user = UserService.updateStatus(req.params.id, { action, role });
    if (!user) return res.status(404).json({ error: 'User not found' });

    AuditService.log({
      event:   action,
      userId:  user.id,
      email:   user.email,
      actorId: req.user.sub,
      detail:  { role: role ?? undefined },
    });

    // Revoke all tokens when account is rejected or revoked
    if (action === 'reject' || action === 'revoke') {
      TokenService.revokeAllForUser(user.id);
    }

    res.json(user);
  } catch (err) {
    console.error('[admin/users PATCH]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /admin/users/:id ───────────────────────────────────────────────────
router.delete('/users/:id', (req, res) => {
  if (req.params.id === req.user.sub)
    return res.status(400).json({ error: 'Cannot delete your own account' });

  const user = UserService.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  TokenService.revokeAllForUser(req.params.id);
  UserService.remove(req.params.id);

  AuditService.log({
    event:   'deleted',
    userId:  req.params.id,
    email:   user.email,
    actorId: req.user.sub,
  });

  res.json({ ok: true });
});

// ── GET /admin/system ─────────────────────────────────────────────────────────
// Returns: CPU, memory, GPU, disk I/O, storage, DB query stats
router.get('/system', (_req, res) => {
  res.json({
    system: getSystemMetrics(),
    db:     getDbStats(),
  });
});

// ── GET /admin/system/db ──────────────────────────────────────────────────────
// Returns per-table row counts + disk footprint (real counts for MongoDB —
// bypasses the in-memory TABLE_ROW_CAPS mirror — file size breakdown for JSON).
// Split from /admin/system because it's heavier (per-collection collStats
// round-trips for MongoDB) and the client polls it on a slower interval.
router.get('/system/db', async (_req, res) => {
  try {
    res.json(await getDbDetailedStats());
  } catch (err) {
    console.error('[admin/system/db]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /admin/audit ──────────────────────────────────────────────────────────
// Query: ?userId=<id>  &event=<type>  &limit=<n>
router.get('/audit', (req, res) => {
  const { userId, event, limit } = req.query;
  const events = AuditService.query({
    userId,
    event,
    limit: limit ? parseInt(limit) : 100,
  });
  res.json({ events, total: events.length });
});

// ── GET /admin/tc-results ─────────────────────────────────────────────────────
// Returns the latest startup test run results.
// Response: { run: { runId, runAt, passed, failed, skipped, total }, results: [...], running: bool }
router.get('/tc-results', (req, res) => {
  res.json(TcRunnerService.getLatestRun());
});

// ── DELETE /admin/tc-results ──────────────────────────────────────────────────
// Clears all stored TC results.
router.delete('/tc-results', (req, res) => {
  const deleted = TcRunnerService.clearResults();
  res.json({ success: true, deleted });
});

// ── POST /admin/tc-results/run ────────────────────────────────────────────────
// Triggers a manual re-run of all startup tests.
// Body: { port?: number, proto?: string }
router.post('/tc-results/run', (req, res) => {
  const httpsEnabled = process.env.HTTPS_ENABLED === 'true';
  const httpsPort = parseInt(process.env.HTTPS_PORT || '3443', 10);
  const httpPort  = parseInt(process.env.PORT || '3080', 10);
  const defaultPort  = httpsEnabled ? httpsPort : httpPort;
  const defaultProto = httpsEnabled ? 'https' : 'http';
  const port  = req.body?.port  ?? defaultPort;
  const proto = req.body?.proto ?? defaultProto;
  const started = TcRunnerService.runNow(port, proto);
  if (!started) return res.status(409).json({ error: 'A test run is already in progress' });
  res.json({ success: true, message: `Test run started on ${proto}://localhost:${port}` });
});

// ── GET /admin/logs/recent ────────────────────────────────────────────────────
// Query: ?source=server|ingest|mediamtx|build  &limit=<n>
// Returns recent log entries from in-memory buffer (source=server, default)
// or from the daily log file filtered by prefix (source=ingest|mediamtx|build).
// Cap (2000) must match LOG_BUFFER_MAX in utils/logger.js — see AdminLogPanel.tsx
// MAX_LINES_OPTIONS, whose largest value this endpoint must be able to satisfy.
router.get('/logs/recent', (req, res) => {
  const source = (req.query.source || 'server').toLowerCase();
  const limit  = Math.min(parseInt(req.query.limit || '200', 10), 2000);

  if (source === 'server') {
    const logs = getRecentLogs().slice(-limit);
    return res.json({ logs, level: getLogLevel(), total: logs.length });
  }

  const prefixMap = { ingest: '[Ingest]', mediamtx: '[MediaMTX]', build: '[OrtBuild]' };
  const prefix = prefixMap[source];
  if (!prefix) return res.status(400).json({ error: `Unknown source: ${source}. Use server|ingest|mediamtx|build` });

  const logs = tailLogFile({ prefix, limit });
  res.json({ logs, level: getLogLevel(), total: logs.length });
});

// ── PATCH /admin/logs/level ───────────────────────────────────────────────────
// Body: { level: 'DEBUG'|'INFO'|'WARNING'|'ERROR'|'CRITICAL'|'NONE' }
// Changes the Socket.IO relay min-level at runtime (does not affect file logging).
router.patch('/logs/level', (req, res) => {
  const { level } = req.body ?? {};
  if (!level || typeof level !== 'string')
    return res.status(400).json({ error: 'Body must include { level: string }' });

  const ok = setLogLevel(level.toUpperCase());
  if (!ok)
    return res.status(400).json({ error: `Invalid level "${level}". Use DEBUG|INFO|WARNING|ERROR|CRITICAL|NONE` });

  AuditService.log({
    event:   'log_level_changed',
    actorId: req.user.sub,
    detail:  { level: level.toUpperCase() },
  });

  res.json({ ok: true, level: getLogLevel() });
});

// ── ingest-daemon control (Design_Ingest_Daemon_Control.md) ──────────────────
// Streaming + Combined 모드에서 사용 가능 — CAPTURE_BACKEND=ingest-daemon이
// 유일한 게이팅 조건(§6 Q1 확정, analysis 모드는 이 백엔드를 쓰지 않으므로
// 자연히 제외됨). 동기 응답(§6 Q2 확정) — restart는 최대 ~11초 걸릴 수 있다.
function requireIngestDaemonBackend(req, res, next) {
  const backend = (process.env.CAPTURE_BACKEND || 'ffmpeg').toLowerCase();
  if (backend !== 'ingest-daemon') {
    return res.status(501).json({ error: 'ingest-daemon backend not active (CAPTURE_BACKEND != ingest-daemon)' });
  }
  next();
}

// Optional body.instance (2026-07-28, §6.45 — multi-process ingest-daemon
// fleet): targets one specific instance. Omitted ⇒ every configured instance
// (today's exact single-instance behavior when INGEST_DAEMON_INSTANCES is
// unset — ingestDaemonControl's *Daemon() functions unwrap to the same flat
// {ok,...} shape in that case, so existing clients see zero change).
function _parseInstanceParam(req) {
  const raw = req.body?.instance;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ── POST /admin/ingest/start ──────────────────────────────────────────────────
router.post('/ingest/start', requireIngestDaemonBackend, async (req, res) => {
  try {
    const result = await ingestDaemonControl.startDaemon(_parseInstanceParam(req));
    AuditService.log({ event: 'ingest_daemon_start', actorId: req.user.sub, detail: result });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error('[admin/ingest/start]', err);
    AuditService.log({ event: 'ingest_daemon_start', actorId: req.user.sub, detail: { ok: false, error: err.message } });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /admin/ingest/stop ───────────────────────────────────────────────────
router.post('/ingest/stop', requireIngestDaemonBackend, async (req, res) => {
  try {
    const result = await ingestDaemonControl.stopDaemon(_parseInstanceParam(req));
    AuditService.log({ event: 'ingest_daemon_stop', actorId: req.user.sub, detail: result });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error('[admin/ingest/stop]', err);
    AuditService.log({ event: 'ingest_daemon_stop', actorId: req.user.sub, detail: { ok: false, error: err.message } });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /admin/ingest/restart ────────────────────────────────────────────────
router.post('/ingest/restart', requireIngestDaemonBackend, async (req, res) => {
  try {
    const result = await ingestDaemonControl.restartDaemon(_parseInstanceParam(req));
    AuditService.log({ event: 'ingest_daemon_restart', actorId: req.user.sub, detail: result });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error('[admin/ingest/restart]', err);
    AuditService.log({ event: 'ingest_daemon_restart', actorId: req.user.sub, detail: { ok: false, error: err.message } });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /admin/analysis/camera-removed ───────────────────────────────────────
// Force-clears a channel from the remote Analysis server's per-camera state
// (_cameraContexts/_metrics.perCamera in analysisApi.js) by cameraId, without
// requiring a local Camera record to exist. DELETE /api/cameras/:id already
// does this same notify as a side effect (server/src/api/cameras.js
// _notifyAnalysisCameraRemoved) — but it 404s before ever reaching that call
// when there's no matching local Camera, which is exactly the case for
// ad-hoc/synthetic cameraIds a TC suite (or any other direct
// POST /api/analysis/frame caller) may have pushed straight to the Analysis
// server. Those previously had no operator-facing cleanup path short of
// waiting out the Analysis server's 5-minute idle-prune sweep or a raw curl
// against the remote host directly. Same underlying HTTP call as the DELETE
// path, just reachable independently of local Camera existence, and awaited
// here (unlike the fire-and-forget DELETE path) so the admin gets a real
// success/failure result. streaming-mode only (mirrors
// _notifyAnalysisCameraRemoved's own gate) — combined/analysis modes don't
// forward to a separate Analysis server.
router.post('/analysis/camera-removed', async (req, res) => {
  const cameraId = req.body?.cameraId;
  if (!cameraId || typeof cameraId !== 'string') {
    return res.status(400).json({ success: false, error: 'cameraId is required' });
  }
  try {
    const result = await notifyAnalysisCameraRemoved(cameraId);
    AuditService.log({ event: 'analysis_camera_removed_forced', actorId: req.user.sub, detail: { cameraId, ...result } });
    res.status(result.ok ? 200 : 502).json({ success: result.ok, cameraId, error: result.error });
  } catch (err) {
    console.error('[admin/analysis/camera-removed]', err);
    AuditService.log({ event: 'analysis_camera_removed_forced', actorId: req.user.sub, detail: { cameraId, ok: false, error: err.message } });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
