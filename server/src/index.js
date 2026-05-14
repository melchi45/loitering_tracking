'use strict';

// Load environment variables first
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const http    = require('http');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const { Server: SocketIOServer } = require('socket.io');

const { initDB }          = require('./db');
const PipelineManager     = require('./services/pipelineManager');
const ZoneManager         = require('./services/zoneManager');
const AlertService        = require('./services/alertService');
const camerasRouter       = require('./api/cameras');
const zonesRouter         = require('./api/zones');
const buildEventsRouters  = require('./api/events');
const registerStreamHandlers = require('./socket/streamHandler');

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
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
  const zoneManager    = new ZoneManager(db);
  const alertService   = new AlertService(db);
  const pipelineManager = new PipelineManager(io, db);

  // ── REST API Routes ───────────────────────────────────────────────────────
  app.use('/api/cameras', camerasRouter(db, pipelineManager));
  app.use('/api/cameras/:cameraId/zones', zonesRouter(zoneManager));
  const { eventsRouter: eRouter, alertsRouter: aRouter } = buildEventsRouters(db, alertService);
  app.use('/api/events', eRouter);
  app.use('/api/alerts', aRouter);

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
  io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);
    registerStreamHandlers(io, socket, db);

    socket.on('disconnect', (reason) => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id} (${reason})`);
    });
  });

  // ── Auto-restart cameras that were streaming before a potential crash ─────
  try {
    const streamingCameras = db
      .prepare("SELECT * FROM cameras WHERE status = 'streaming' OR status = 'connecting'")
      .all();
    if (streamingCameras.length > 0) {
      console.log(`[Server] Restarting ${streamingCameras.length} previously-active pipeline(s)`);
      for (const cam of streamingCameras) {
        pipelineManager.startCamera(cam).catch((err) => {
          console.error(`[Server] Auto-restart failed for camera ${cam.id}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.warn('[Server] Could not auto-restart cameras:', err.message);
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
