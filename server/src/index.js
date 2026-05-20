'use strict';

// Load environment variables first
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const http    = require('http');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const { Server: SocketIOServer } = require('socket.io');

const { initDB }          = require('./db');
const webrtcGateway       = require('./services/webrtcGateway');
const PipelineManager     = require('./services/pipelineManager');
const ZoneManager         = require('./services/zoneManager');
const AlertService        = require('./services/alertService');
const { getDiscoveryService } = require('./services/discoveryService');
const camerasRouter          = require('./api/cameras');
const zonesRouter            = require('./api/zones');
const buildEventsRouters     = require('./api/events');
const analyticsRouter        = require('./api/analytics');
const trackerRouter          = require('./api/tracker');
const youtubeStreamsRouter    = require('./api/youtubeStreams');
const internalRouter         = require('./api/internal');
const YouTubeStreamService   = require('./services/youtubeStreamService');
const registerStreamHandlers = require('./socket/streamHandler');
const registerWebRTCHandlers = require('./socket/webrtcSignaling');

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  // ── WebRTC Gateway (mediasoup) — init before pipeline manager ──────────
  await webrtcGateway.init();

  // ── Database ────────────────────────────────────────────────────────────
  const db = initDB();
  console.log('[Server] SQLite database initialised');

  // ── Express ─────────────────────────────────────────────────────────────
  const app = express();

  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── HTTP + Socket.IO ─────────────────────────────────────────────────────
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB (for base64 frames)
  });

  // Expose io to route handlers via app.set
  app.set('io', io);

  // ── Services ─────────────────────────────────────────────────────────────
  const zoneManager         = new ZoneManager(db);
  const alertService        = new AlertService(db);
  // Pass the shared ZoneManager so zone additions/deletions via REST API are
  // immediately visible to the pipeline without a server restart.
  const pipelineManager     = new PipelineManager(io, db, zoneManager);
  const youtubeSvc          = new YouTubeStreamService(db, pipelineManager);
  youtubeSvc.init(); // Restore YouTube cameras from DB into in-memory streams Map

  // ── REST API Routes ───────────────────────────────────────────────────────
  app.use('/api/cameras', camerasRouter(db, pipelineManager, youtubeSvc));
  app.use('/api/cameras/:cameraId/zones', zonesRouter(zoneManager));
  const { eventsRouter: eRouter, alertsRouter: aRouter } = buildEventsRouters(db, alertService);
  app.use('/api/events', eRouter);
  app.use('/api/alerts', aRouter);
  app.use('/api/analytics',       analyticsRouter);
  app.use('/api/tracker',         trackerRouter);
  app.use('/api/youtube-streams', youtubeStreamsRouter(youtubeSvc));
  app.use('/internal',            internalRouter(youtubeSvc));

  // ── WebRTC ICE config (STUN/TURN) — served from .env so credentials stay server-side ──
  // Returns stunUrls (array) and turns (array).
  // Multiple TURN servers are supported via TURN_URL / TURN_URL_2 / TURN_URL_3 … in .env.
  app.get('/api/webrtc/ice-config', (_req, res) => {
    const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
      .split(',').map(s => s.trim()).filter(Boolean);

    // Collect TURN_URL, TURN_URL_2, TURN_URL_3, … until a gap is found
    const turns = [];
    for (let i = 1; ; i++) {
      const suffix = i === 1 ? '' : `_${i}`;
      const url = (process.env[`TURN_URL${suffix}`] || '').trim();
      if (!url) break;
      turns.push({
        url,
        username:   (process.env[`TURN_USERNAME${suffix}`]   || '').trim(),
        credential: (process.env[`TURN_CREDENTIAL${suffix}`] || '').trim(),
      });
    }

    res.json({ stunUrls, turns });
  });

  // ── Cross-camera Re-ID stats ──────────────────────────────────────────────────
  // Returns all faces that have been seen on more than one camera in the current session.
  // Each entry: { faceId, firstCameraId, lastCameraId, transitionCount, lastSeenAt }
  app.get('/api/crosscamera/stats', (req, res) => {
    const allStats = pipelineManager.getCrossCameraReIdStats();
    // Only return faces that actually crossed cameras (transitionCount > 0)
    const crossed = allStats.filter(s => s.transitionCount > 0);
    res.json({
      totalTransitions: crossed.reduce((sum, s) => sum + s.transitionCount, 0),
      uniqueFaces:      crossed.length,
      faces:            crossed,
    });
  });

  // ── Global Person Registry ────────────────────────────────────────────────────
  // Returns PersonTrajectory records for persons active within maxAgeMs (default 5 min).
  // Used by the client on page load to hydrate the personTrajectoryStore.
  app.get('/api/persons/active', (req, res) => {
    const maxAgeMs = parseInt(req.query.maxAgeMs) || 300_000;
    const persons  = pipelineManager.getPersonTrajectories(maxAgeMs);
    res.json({ total: persons.length, persons });
  });

  // AI module capabilities — returns availability (boolean) and detailed status per module.
  // status values: 'builtin' | 'available' | 'loaded' | 'failed' | 'missing' | 'pending'
  //   builtin   = always available, no model file needed
  //   available = model file present, not yet loaded (loads on first camera start)
  //   loaded    = model actively running in memory
  //   failed    = model file found but loading failed (OOM, corrupted, etc.)
  //   missing   = model file not on disk (run: cd server && npm run download-models)
  //   pending   = Phase-2 feature, not yet implemented
  app.get('/api/capabilities', (req, res) => {
    const fs2     = require('fs');
    const modelsDir = path.resolve(__dirname, '..', 'models');
    const has = (f) => fs2.existsSync(path.join(modelsDir, f));

    // Map runtime service status to capability status string
    const svcStatus = pipelineManager.getServiceStatus();
    const toStatus = (svcKey, fileExists, pending = false) => {
      if (pending)    return 'pending';
      if (!fileExists) return 'missing';
      const s = svcStatus[svcKey];
      if (s === 'loaded')  return 'loaded';
      if (s === 'failed')  return 'failed';
      return 'available'; // not_started or any unknown → file present, not yet loaded
    };

    const ppeFile  = has('yolov8m_ppe.onnx');
    const yoloFile = has('yolov8n.onnx');
    const faceFile = has('scrfd_2.5g.onnx') && has('arcface_w600k_r50.onnx');
    const fsFile   = has('yolov8s_fire_smoke.onnx');
    const parFile  = has('openpar.onnx');

    const ppeStatus  = toStatus('ppe',       ppeFile);
    const faceStatus = toStatus('face',      faceFile);
    const fsStatus   = toStatus('firesmoke', fsFile);

    // available = module can be enabled (not failed/missing/pending)
    const avail = (st) => st === 'loaded' || st === 'available' || st === 'builtin';

    const yoloStatus = yoloFile ? 'available' : 'missing';

    const statusMap = {
      human:       'builtin',
      vehicle:     'builtin',
      face:        faceStatus,
      mask:        ppeStatus,
      hat:         ppeStatus,
      color:       'builtin',
      cloth:       toStatus('cloth', parFile),
      backpack:    yoloStatus,
      handbag:     yoloStatus,
      suitcase:    yoloStatus,
      umbrella:    yoloStatus,
      tie:         yoloStatus,
      glasses:     'pending',
      sunglasses:  'pending',
      fire:        fsStatus,
      smoke:       fsStatus,
      chair:       yoloStatus,
      couch:       yoloStatus,
      diningtable: yoloStatus,
      furniture:   yoloStatus,
      laptop:      yoloStatus,
      tv:          yoloStatus,
      keyboard:    yoloStatus,
      mouse:       yoloStatus,
      cellphone:   yoloStatus,
      computer:    yoloStatus,
      clock:       yoloStatus,
      cup:         yoloStatus,
      bottle:      yoloStatus,
      book:        yoloStatus,
    };

    // Build boolean availability map (backward-compatible)
    const aiMap = {};
    for (const [k, st] of Object.entries(statusMap)) aiMap[k] = avail(st);

    res.json({ ai: aiMap, status: statusMap });
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status:    'ok',
      uptime:    process.uptime(),
      timestamp: new Date().toISOString(),
      db:        'connected',
    });
  });

  // ── Serve React static build ──────────────────────────────────────────────
  const clientBuildPath = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (require('fs').existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));
    // SPA fallback: all non-API routes serve index.html
    app.get(/^(?!\/api|\/health|\/socket\.io).*/, (req, res) => {
      res.sendFile(path.join(clientBuildPath, 'index.html'));
    });
    console.log(`[Server] Serving React UI from ${clientBuildPath}`);
  } else {
    // 404 fallback for API-only mode (before client is built)
    app.use('/api/*', (req, res) => {
      res.status(404).json({ success: false, error: `Cannot ${req.method} ${req.path}` });
    });
    app.get('/', (req, res) => {
      res.send('<h2>LTS Backend running. Build the client: <code>cd client && npm run build</code></h2>');
    });
  }

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[Express] Unhandled error:', err);
    res.status(500).json({ success: false, error: err.message });
  });

  // ── Socket.IO Handlers ────────────────────────────────────────────────────
  const discoverySvc = getDiscoveryService(io);

  io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);
    registerStreamHandlers(io, socket, db);
    registerWebRTCHandlers(io, socket);
    // Hydrate newly connected client with all known discovered devices
    discoverySvc.hydrate(socket);

    // ICE test trigger: relay to all browser clients so IceTestTrigger in React initiates WebRTC
    socket.on('webrtc:ice-test-start', ({ cameraId } = {}) => {
      io.emit('webrtc:ice-test-trigger', { cameraId });
    });
    socket.on('webrtc:ice-test-done', () => {
      io.emit('webrtc:ice-test-stop');
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id} (${reason})`);
    });
  });

  // Start background continuous discovery
  discoverySvc.start();

  // ── Auto-start all registered cameras on startup ─────────────────────────
  try {
    const allCameras = db.find('cameras', {});
    if (allCameras.length > 0) {
      console.log(`[Server] Starting ${allCameras.length} registered camera pipeline(s)`);
      for (const cam of allCameras) {
        pipelineManager.startCamera(cam).catch((err) => {
          console.error(`[Server] Auto-start failed for camera ${cam.id}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.warn('[Server] Could not auto-start cameras:', err.message);
  }

  // ── Start listening ───────────────────────────────────────────────────────
  await new Promise((resolve, reject) => {
    httpServer.listen(PORT, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  console.log(`[Server] Loitering Tracking System backend listening on port ${PORT}`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal} — shutting down gracefully…`);
    try {
      await youtubeSvc.stopAll();
      await pipelineManager.stopAll();
      io.close();
      httpServer.close(() => {
        console.log('[Server] HTTP server closed');
        try { db.close(); } catch (_) {}
        process.exit(0);
      });
      // Force-exit after 10 seconds if graceful shutdown hangs
      setTimeout(() => process.exit(1), 10000).unref();
    } catch (err) {
      console.error('[Server] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled promise rejection:', reason);
  });
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
