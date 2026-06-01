'use strict';

// Load environment variables first
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const http         = require('http');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const session      = require('express-session');
const { Server: SocketIOServer } = require('socket.io');

const { initDB, flushNow }    = require('./db');
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
const settingsRouter         = require('./api/settings');
const youtubeStreamsRouter    = require('./api/youtubeStreams');
const internalRouter         = require('./api/internal');
const faceGalleryRouter      = require('./api/faceGallery');
const { buildRouter: buildSnapshotsRouter } = require('./api/snapshots');
const { buildRouter: buildSearchRouter }    = require('./api/search');
const { buildRouter: buildStatsRouter }     = require('./api/stats');
const authRouter     = require('./routes/auth');
const adminRouter    = require('./routes/admin');
const { passport: configuredPassport, setup: setupPassport } = require('./config/passport');
const YouTubeStreamService   = require('./services/youtubeStreamService');
const registerStreamHandlers = require('./socket/streamHandler');
const registerWebRTCHandlers = require('./socket/webrtcSignaling');
const registerWebRTCTelemetryHandlers = require('./socket/webrtcTelemetryHandlers');

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  // ── WebRTC Gateway (mediasoup) — init before pipeline manager ──────────
  await webrtcGateway.init();

  // ── Database ────────────────────────────────────────────────────────────
  const db = await initDB();
  console.log('[Server] Database initialised (mode:', require('./db').getStorageMode(), ')');

  // ── Express ─────────────────────────────────────────────────────────────
  const app = express();

  // Read HTTPS mode early so HSTS middleware can reference it
  const httpsEnabled = process.env.HTTPS_ENABLED === 'true';

  app.use(cors({
    origin: process.env.CLIENT_ORIGIN
      ? process.env.CLIENT_ORIGIN.split(',').map(s => s.trim())
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser(process.env.COOKIE_SECRET));

  // ── Session (required for OAuth state management) ─────────────────────────
  app.use(session({
    secret:            process.env.SESSION_SECRET || process.env.COOKIE_SECRET || 'lts-session-secret',
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   httpsEnabled,
      sameSite: 'lax',
      maxAge:   10 * 60 * 1000,  // 10 min — only needed for OAuth CSRF state
    },
  }));

  // ── Passport (Google OAuth strategy) ──────────────────────────────────────
  setupPassport();
  app.use(configuredPassport.initialize());
  app.use(configuredPassport.session());

  // HSTS — only when serving over HTTPS (SRS FR-HTTPS-007)
  if (httpsEnabled) {
    app.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });
  }

  // ── HTTP / HTTPS + Socket.IO ──────────────────────────────────────────────
  // HTTPS_ENABLED=true  → TLS server on HTTPS_PORT (default 3443)
  //                        cert: SSL_CERT_PATH, key: SSL_KEY_PATH (PEM)
  // HTTP_REDIRECT=true  → keeps plain HTTP on PORT and issues 301 → HTTPS
  // HTTPS_ENABLED=false → plain HTTP on PORT (default, no cert required)
  let httpServer;
  if (httpsEnabled) {
    const certFile = path.resolve(__dirname, '..', process.env.SSL_CERT_PATH || './certs/server.crt');
    const keyFile  = path.resolve(__dirname, '..', process.env.SSL_KEY_PATH  || './certs/server.key');
    const caFile   = process.env.SSL_CA_PATH
      ? path.resolve(__dirname, '..', process.env.SSL_CA_PATH) : null;
    const tlsOpts = {
      cert: fs.readFileSync(certFile),
      key:  fs.readFileSync(keyFile),
    };
    if (caFile) tlsOpts.ca = fs.readFileSync(caFile);
    httpServer = https.createServer(tlsOpts, app);
  } else {
    httpServer = http.createServer(app);
  }
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

  // ── Auth / Admin Routes ───────────────────────────────────────────────────
  app.use('/auth',  authRouter);
  app.use('/admin', adminRouter);

  // ── REST API Routes ───────────────────────────────────────────────────────
  app.use('/api/cameras', camerasRouter(db, pipelineManager, youtubeSvc));
  app.use('/api/cameras/:cameraId/zones', zonesRouter(zoneManager));
  const { eventsRouter: eRouter, alertsRouter: aRouter } = buildEventsRouters(db, alertService);
  app.use('/api/events', eRouter);
  app.use('/api/alerts', aRouter);
  app.use('/api/analytics',       analyticsRouter);
  app.use('/api/tracker',         trackerRouter);
  app.use('/api/settings',        settingsRouter);
  app.use('/api/youtube-streams', youtubeStreamsRouter(youtubeSvc));
  app.use('/internal',            internalRouter(youtubeSvc));

  // Face gallery — getter always resolves to the live FaceService once models are loaded
  const getFaceService = () => pipelineManager._attrPipeline?._face ?? null;
  app.use('/api/galleries', faceGalleryRouter(db, pipelineManager, getFaceService));

  // Detection Snapshots & Global Search
  app.use('/api/snapshots', buildSnapshotsRouter(db));
  app.use('/api/search',    buildSearchRouter(db));

  // System-wide Stats Dashboard
  app.use('/api/stats',     buildStatsRouter(db));
  // Eagerly load face models so enrollment works without an active camera pipeline.
  // Also reload persistent gallery after models are ready.
  pipelineManager.loadFaceServiceEagerly()
    .then(() => pipelineManager.reloadPersistentGallery())
    .catch(() => {});

  // Cross-camera stats and person trajectories (standalone /api/faces/* routes)
  app.get('/api/faces/cross-camera-stats', (_req, res) => {
    try { res.json({ success: true, data: pipelineManager.getCrossCameraReIdStats() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
  app.get('/api/faces/trajectories', (req, res) => {
    try {
      const maxAgeMs = parseInt(req.query.maxAgeMs) || 300_000;
      res.json({ success: true, data: pipelineManager.getPersonTrajectories(maxAgeMs) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ── WebRTC ICE config (STUN/TURN) ─────────────────────────────────────────
  // Priority: 1. DB settings table ('webrtcConfig' row)
  //           2. .env fallback (STUN_URLS, TURN_URL, TURN_URL_2, …)
  // The client writes back via PUT /api/settings/webrtcConfig when the user saves.
  app.get('/api/webrtc/ice-config', (_req, res) => {
    // 1. Try DB first
    const saved = db.findOne('settings', { id: 'webrtcConfig' });
    if (saved && Array.isArray(saved.stunUrls)) {
      return res.json({ stunUrls: saved.stunUrls, turns: saved.turns ?? [] });
    }

    // 2. Fallback to .env
    const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
      .split(',').map(s => s.trim()).filter(Boolean);

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

    // Seed DB with .env values so future calls return from DB
    db.insert('settings', { id: 'webrtcConfig', enabled: false, stunUrls, turns });

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
    app.get(/^(?!\/api|\/auth|\/admin|\/health|\/socket\.io).*/, (req, res) => {
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
    registerWebRTCTelemetryHandlers(io, socket);
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
  const ACTIVE_PORT  = httpsEnabled ? parseInt(process.env.HTTPS_PORT || '3443', 10) : PORT;
  const ACTIVE_PROTO = httpsEnabled ? 'https' : 'http';

  // Optional: HTTP → HTTPS redirect on the plain HTTP port
  if (httpsEnabled && process.env.HTTP_REDIRECT === 'true') {
    const redirectApp = express();
    redirectApp.use((req, res) => {
      res.redirect(301, `https://${req.hostname}:${ACTIVE_PORT}${req.url}`);
    });
    http.createServer(redirectApp).listen(PORT, () => {
      console.log(`[Server] HTTP→HTTPS redirect listening on port ${PORT}`);
    });
  }

  await new Promise((resolve, reject) => {
    httpServer.listen(ACTIVE_PORT, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  console.log(`[Server] Loitering Tracking System backend listening on port ${ACTIVE_PORT}`);
  console.log(`[Server] Health: ${ACTIVE_PROTO}://localhost:${ACTIVE_PORT}/health`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal} — shutting down gracefully…`);
    try {
      await youtubeSvc.stopAll();
      await pipelineManager.stopAll();
      io.close();
      flushNow(); // flush any pending debounced DB write before shutdown
      httpServer.close(() => {
        console.log(`[Server] ${httpsEnabled ? 'HTTPS' : 'HTTP'} server closed`);
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
