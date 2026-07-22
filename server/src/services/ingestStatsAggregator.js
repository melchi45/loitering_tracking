'use strict';

/**
 * Ingest Daemon real-time monitoring — Admin Dashboard (2026-07-21).
 * See docs/design/Design_Ingest_Daemon_Monitoring.md for the full design.
 *
 * Polls ingest-daemon's GET /cameras/stats, merges it with:
 *  - DB camera metadata (name, type, rtspUrl/youtubeUrl)
 *  - pipelineManager.getIngestMonitorStats() (Node-side AI/analysis counters)
 *  - pipelineManager.getAnalysisClientStats() (Analysis-server circuit breaker,
 *    system-wide not per-camera)
 *  - getWebRTCEngine().getProducerStats() (mediasoup RTP delivery to browsers)
 * and pushes the merged snapshot via Socket.IO to admin-verified subscribers
 * only — see middleware/auth.js's verifySocketAdmin() comment for why this
 * does NOT follow this codebase's existing io.emit()-to-everyone pattern
 * (utils/logger.js's server:log): rtspUrl embeds camera credentials.
 */

const http = require('http');

const POLL_INTERVAL_MS = 1500;
const INGEST_STATS_TIMEOUT_MS = 3000;

function _fetchIngestStats(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: INGEST_STATS_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve([]);
        try { resolve(JSON.parse(body).cameras || []); }
        catch { resolve([]); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
  });
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('../db').BaseDatabase} db
 * @param {import('./pipelineManager')} pipelineManager
 * @param {() => object} getWebRTCEngine
 */
function startIngestStatsAggregator({ io, db, pipelineManager, getWebRTCEngine }) {
  const { verifySocketAdmin } = require('../middleware/auth');
  const ingestUrl = `${(process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '')}/cameras/stats`;

  // Admin-verified subscriber sockets — see module comment. A socket must
  // explicitly (re-)subscribe with a valid admin JWT; disconnecting or
  // unsubscribing removes it. Not persisted — a page refresh re-subscribes.
  const adminSockets = new Set();

  io.on('connection', (socket) => {
    socket.on('admin:subscribe-ingest-stats', ({ token } = {}) => {
      if (!verifySocketAdmin(token)) return; // silently ignore — no error leak to unauthenticated caller
      adminSockets.add(socket.id);
    });
    socket.on('admin:unsubscribe-ingest-stats', () => {
      adminSockets.delete(socket.id);
    });
    socket.on('disconnect', () => {
      adminSockets.delete(socket.id);
    });
  });

  const timer = setInterval(async () => {
    if (adminSockets.size === 0) return; // nobody watching — skip the poll entirely

    const [ingestCameras, cameras] = await Promise.all([
      _fetchIngestStats(ingestUrl),
      Promise.resolve(db.all('cameras')),
    ]);
    const ingestById = new Map(ingestCameras.map((c) => [c.id, c]));
    const cameraById  = new Map(cameras.map((c) => [c.id, c]));
    const nodeStats   = pipelineManager.getIngestMonitorStats();

    const engine = getWebRTCEngine();
    let producerStats = {};
    if (engine && typeof engine.getProducerStats === 'function') {
      producerStats = await engine.getProducerStats().catch(() => ({}));
    }
    // producerStats is keyed by cameraId.slice(0,8) (see mediasoupEngine.js's
    // getProducerStats()) — build a prefix lookup so the merge below can find
    // each camera's entry despite the different key length.
    const producerByPrefix = producerStats;

    const merged = [];
    const allIds = new Set([...ingestById.keys(), ...cameraById.keys(), ...Object.keys(nodeStats)]);
    for (const id of allIds) {
      const camera = cameraById.get(id);
      if (!camera) continue; // ingest-daemon/pipeline entry with no matching DB record — stale, skip
      const ingest = ingestById.get(id) || null;
      const node    = nodeStats[id] || null;
      const producer = producerByPrefix[id.slice(0, 8)] || null;

      merged.push({
        id,
        name:   camera.name,
        type:   camera.type || 'rtsp',
        rtspUrl:    camera.type === 'youtube' ? null : (camera.rtspUrl || null),
        youtubeUrl: camera.type === 'youtube' ? (camera.youtubeUrl || null) : null,
        webrtcEnabled: !!camera.webrtcEnabled,

        // ── ingest-daemon (Python) — connection/capture/codec/IP/throughput ──
        connectionState:   ingest?.connectionState ?? 'unknown',
        peerIp:            ingest?.peerIp ?? null,
        peerPort:          ingest?.peerPort ?? null,
        connectedAt:       ingest?.connectedAt ?? null,
        lastVideoPacketAt: ingest?.lastVideoPacketAt ?? null,
        lastAudioPacketAt: ingest?.lastAudioPacketAt ?? null,
        lastAiPushAt:      ingest?.lastAiPushAt ?? null,
        lastAppRtpAt:      ingest?.lastAppRtpAt ?? null,
        videoCodec:        ingest?.videoCodec ?? null,
        videoWidth:        ingest?.videoWidth ?? null,
        videoHeight:       ingest?.videoHeight ?? null,
        videoBps:          ingest?.videoBps ?? 0,
        videoFps:          ingest?.videoFps ?? 0,
        audioBps:          ingest?.audioBps ?? 0,
        audioFps:          ingest?.audioFps ?? 0,
        aiFps:             ingest?.aiFps ?? 0,

        // ── Node → Analysis server (this camera's slice of the pipeline) ──
        framesProcessed:    node?.framesProcessed ?? 0,
        detectionsTotal:    node?.detectionsTotal ?? 0,
        trackedTotal:       node?.trackedTotal ?? 0,
        facesTotal:         node?.facesTotal ?? 0,
        fireSmokeTotal:     node?.fireSmokeTotal ?? 0,
        loiteringTotal:     node?.loiteringTotal ?? 0,

        // ── ingest-daemon → Node (Streaming server) — mediasoup RTP receipt ──
        mediasoupVideoBytesRx: producer?.videoBytesRx ?? null,
        mediasoupAudioBytesRx: producer?.audioBytesRx ?? null,
        mediasoupViewers:      producer?.viewers?.length ?? 0,
      });
    }

    const payload = {
      timestamp: Date.now(),
      cameras: merged,
      // System-wide (not per-camera) — Node(streaming) ↔ Analysis server circuit breaker.
      analysisClient: pipelineManager.getAnalysisClientStats(),
    };

    for (const socketId of adminSockets) {
      io.to(socketId).emit('admin:ingest-stats', payload);
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
}

module.exports = { startIngestStatsAggregator };
