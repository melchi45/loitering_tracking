'use strict';

/**
 * /internal/mediamtx  — LTS-2026-004
 *
 * Webhook handler for MediaMTX publish / unpublish events.
 * MediaMTX calls this endpoint via its runOnPublish / runOnUnpublish hooks.
 *
 * Security: only requests originating from loopback (127.0.0.1 / ::1) are
 * accepted; all others are rejected with HTTP 403.
 */

const { Router } = require('express');

/**
 * @param {import('../services/youtubeStreamService')} youtubeStreamService
 * @returns {Router}
 */
function internalRouter(youtubeStreamService) {
  const router = Router();

  // Loopback-only guard middleware
  router.use((req, res, next) => {
    const src = req.socket.remoteAddress || '';
    const isLoopback = src === '127.0.0.1' || src === '::1' || src === '::ffff:127.0.0.1';
    if (!isLoopback) {
      return res.status(403).json({ error: 'Forbidden: internal endpoint' });
    }
    next();
  });

  /**
   * POST /internal/mediamtx
   * Body: { event: "publish" | "unpublish", path: string }
   */
  router.post('/mediamtx', (req, res) => {
    const { event, path } = req.body;

    if (!event || !path) {
      return res.status(400).json({ error: 'event and path are required' });
    }

    console.log(`[Internal] MediaMTX event: ${event} path: ${path}`);

    if (event === 'publish') {
      youtubeStreamService.onMediaMTXPublish(path);
    } else if (event === 'unpublish') {
      youtubeStreamService.onMediaMTXUnpublish(path);
    }

    res.json({ ok: true });
  });

  return router;
}

module.exports = internalRouter;
