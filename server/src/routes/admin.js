'use strict';

const express = require('express');
const router  = express.Router();

const UserService    = require('../services/UserService');
const TokenService   = require('../services/TokenService');
const AuditService   = require('../services/AuditService');
const TcRunnerService = require('../services/TcRunnerService');
const { verifyAccessToken } = require('../middleware/auth');
const { requireRole }       = require('../middleware/role');
const { getSystemMetrics }  = require('../services/systemMetrics');
const { getDbStats }        = require('../db');

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

module.exports = router;
