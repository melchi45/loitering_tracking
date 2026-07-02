'use strict';

/**
 * /api/youtube-streams  — LTS-2026-004
 *
 * REST endpoints for creating, listing, updating, and deleting
 * YouTube virtual camera channels.
 *
 * Requires:
 *   app.set('youtubeStreamService', <YouTubeStreamService instance>)
 */

const { Router } = require('express');

/**
 * @param {import('../services/youtubeStreamService')} youtubeStreamService
 * @returns {Router}
 */
function youtubeStreamsRouter(youtubeStreamService) {
  const router = Router();

  // ── POST /api/youtube-streams ─────────────────────────────────────────────
  // Create a new virtual camera from a YouTube URL.
  router.post('/', async (req, res) => {
    const { youtubeUrl, name, resolution, bitrate, repeatPlayback, webrtcEnabled, channelSlot } = req.body;

    if (!youtubeUrl || typeof youtubeUrl !== 'string') {
      return res.status(422).json({ success: false, code: 'INVALID_YOUTUBE_URL', error: 'youtubeUrl is required' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    // Sanitize optional numeric params
    const parsedBitrate = bitrate ? parseInt(bitrate, 10) : undefined;
    if (bitrate !== undefined && (isNaN(parsedBitrate) || parsedBitrate < 100 || parsedBitrate > 20000)) {
      return res.status(400).json({ success: false, error: 'bitrate must be between 100 and 20000 kbps' });
    }

    const validResolutions = ['1080p', '720p', '480p'];
    if (resolution !== undefined && !validResolutions.includes(resolution)) {
      return res.status(400).json({ success: false, error: `resolution must be one of: ${validResolutions.join(', ')}` });
    }

    try {
      const camera = await youtubeStreamService.createStream({
        youtubeUrl:     youtubeUrl.trim(),
        name:           name.trim(),
        resolution:     resolution || '1080p',
        bitrate:        parsedBitrate || 2000,
        repeatPlayback: !!repeatPlayback,
        webrtcEnabled:  webrtcEnabled !== undefined ? !!webrtcEnabled : false,
        channelSlot,
      });
      return res.status(201).json({ success: true, camera });
    } catch (err) {
      const code   = err.code || 'INTERNAL_ERROR';
      const status =
        code === 'INVALID_YOUTUBE_URL'     ? 422 :
        code === 'YT_DLP_FAILED'           ? 422 :
        code === 'FFMPEG_NOT_FOUND'        ? 503 :
        code === 'MAX_STREAMS_REACHED'     ? 429 :
        code === 'STREAM_TIMEOUT'          ? 504 :
        code === 'CHANNEL_SLOT_CONFLICT'   ? 409 :
        code === 'CHANNEL_SLOT_INVALID'    ? 400 : 500;
      return res.status(status).json({ success: false, code, error: err.message });
    }
  });

  // ── GET /api/youtube-streams ──────────────────────────────────────────────
  // List all active YouTube streams.
  router.get('/', (req, res) => {
    try {
      const streams = youtubeStreamService.listStreams();
      res.json({ success: true, streams });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /api/youtube-streams/:id/status ───────────────────────────────────
  // Poll stream status — used by UI during the 'starting' phase.
  router.get('/:id/status', (req, res) => {
    const stream = youtubeStreamService.getStream(req.params.id);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    const elapsed = (Date.now() - new Date(stream.createdAt).getTime()) / 1000;
    res.json({ ...stream, elapsed: Math.round(elapsed * 10) / 10 });
  });

  // ── PATCH /api/youtube-streams/:id ───────────────────────────────────────
  // Update stream name, YouTube URL, resolution, or bitrate (triggers restart).
  router.patch('/:id', async (req, res) => {
    const { youtubeUrl, name, resolution, bitrate, repeatPlayback, webrtcEnabled, channelSlot } = req.body;

    if (youtubeUrl !== undefined && typeof youtubeUrl !== 'string') {
      return res.status(422).json({ success: false, code: 'INVALID_YOUTUBE_URL', error: 'youtubeUrl must be a string' });
    }

    const validResolutions = ['1080p', '720p', '480p'];
    if (resolution !== undefined && !validResolutions.includes(resolution)) {
      return res.status(400).json({ success: false, error: `resolution must be one of: ${validResolutions.join(', ')}` });
    }

    const parsedBitrate = bitrate !== undefined ? parseInt(bitrate, 10) : undefined;
    if (bitrate !== undefined && (isNaN(parsedBitrate) || parsedBitrate < 100 || parsedBitrate > 20000)) {
      return res.status(400).json({ success: false, error: 'bitrate must be between 100 and 20000 kbps' });
    }

    try {
      const updated = await youtubeStreamService.updateStream(req.params.id, {
        youtubeUrl:     youtubeUrl?.trim(),
        name:           name?.trim(),
        resolution,
        bitrate:        parsedBitrate,
        repeatPlayback: repeatPlayback !== undefined ? !!repeatPlayback : undefined,
        webrtcEnabled:  webrtcEnabled !== undefined ? !!webrtcEnabled : undefined,
        channelSlot,
      });
      res.json({ success: true, camera: updated });
    } catch (err) {
      const code   = err.code || 'INTERNAL_ERROR';
      const status =
        code === 'NOT_FOUND'              ? 404 :
        code === 'INVALID_YOUTUBE_URL'    ? 422 :
        code === 'CHANNEL_SLOT_CONFLICT'  ? 409 :
        code === 'CHANNEL_SLOT_INVALID'   ? 400 : 500;
      res.status(status).json({ success: false, code, error: err.message });
    }
  });

  // ── DELETE /api/youtube-streams/:id ──────────────────────────────────────
  // Stop and remove a YouTube stream.
  router.delete('/:id', async (req, res) => {
    try {
      await youtubeStreamService.stopStream(req.params.id);
      res.json({ success: true, message: `Stream ${req.params.id} stopped and camera record removed.` });
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : 500;
      res.status(status).json({ success: false, code: err.code, error: err.message });
    }
  });

  // ── POST /api/youtube-streams/:id/restart ────────────────────────────────
  // Manually restart a stream that has entered 'error' state.
  router.post('/:id/restart', async (req, res) => {
    try {
      const updated = await youtubeStreamService.restartStream(req.params.id);
      res.json({ success: true, camera: updated });
    } catch (err) {
      const code   = err.code || 'INTERNAL_ERROR';
      const status = code === 'NOT_FOUND' ? 404 : code === 'STREAM_STOPPED' ? 409 : 500;
      res.status(status).json({ success: false, code, error: err.message });
    }
  });

  return router;
}

module.exports = youtubeStreamsRouter;
