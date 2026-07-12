'use strict';

const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', process.env.LTS_ENV_FILE || '.env') });
} catch {
  // Continue with process env when dotenv is unavailable.
}

const { openLogFile, patchConsole, makeLineRelay } = require('../utils/logger');
openLogFile();
patchConsole();

const { ensureMongoDB } = require('./ensureMongodb');

function resolveRuntimeOs() {
  const override = (process.env.SERVER_RUNTIME_OS || 'auto').trim().toLowerCase();
  if (override === 'windows' || override === 'win') return 'windows';
  if (override === 'linux') return 'linux';
  return process.platform === 'win32' ? 'windows' : 'linux';
}

function resolveNodeExec(runtimeOs) {
  if (process.env.NODE_EXEC && process.env.NODE_EXEC.trim()) {
    return process.env.NODE_EXEC.trim();
  }
  if (runtimeOs === 'windows') {
    return (process.env.NODE_EXEC_WINDOWS || 'node').trim();
  }
  return (process.env.NODE_EXEC_LINUX || '/usr/bin/node').trim();
}

function resolvePythonExec(runtimeOs) {
  if (process.env.PYTHON_EXEC && process.env.PYTHON_EXEC.trim()) {
    return process.env.PYTHON_EXEC.trim();
  }
  if (runtimeOs === 'windows') {
    return (process.env.PYTHON_EXEC_WINDOWS || 'python').trim();
  }
  return (process.env.PYTHON_EXEC_LINUX || '/usr/bin/python3').trim();
}

function getPathEnvKey(envObj) {
  if (Object.prototype.hasOwnProperty.call(envObj, 'Path')) return 'Path';
  return 'PATH';
}

function pushPathEntry(entries, value) {
  if (!value || typeof value !== 'string') return;
  const v = value.trim();
  if (!v) return;
  if (!entries.includes(v)) entries.push(v);
}

function resolveDirFromBinary(value) {
  if (!value || typeof value !== 'string') return '';
  const v = value.trim();
  if (!v) return '';
  // Absolute/relative executable path: include its parent directory in PATH.
  if (v.includes('\\') || v.includes('/')) return path.dirname(v);
  return '';
}

function resolveByRuntime(runtimeOs, baseKey) {
  const osKey = runtimeOs === 'windows' ? `${baseKey}_WINDOWS` : `${baseKey}_LINUX`;
  const osVal = process.env[osKey];
  if (osVal && String(osVal).trim()) return String(osVal).trim();
  const generic = process.env[baseKey];
  if (generic && String(generic).trim()) return String(generic).trim();
  return '';
}

async function main() {
  await ensureMongoDB();

  const runtimeOs = resolveRuntimeOs();
  const nodeExec = resolveNodeExec(runtimeOs);
  const pythonExec = resolvePythonExec(runtimeOs);
  const serverEntry = path.resolve(__dirname, '..', 'index.js');
  const childEnv = { ...process.env };
  const pathKey = getPathEnvKey(childEnv);
  const pathEntries = [];

  // Ensure subprocesses can discover required binaries even in restricted shells.
  pushPathEntry(pathEntries, resolveDirFromBinary(nodeExec));
  pushPathEntry(pathEntries, resolveDirFromBinary(pythonExec));
  pushPathEntry(pathEntries, resolveByRuntime(runtimeOs, 'FFMPEG_BIN_DIR'));
  pushPathEntry(pathEntries, resolveDirFromBinary(resolveByRuntime(runtimeOs, 'YTDLP_BIN')));

  const currentPath = childEnv[pathKey] || childEnv.PATH || childEnv.Path || '';
  childEnv[pathKey] = pathEntries.length ? `${pathEntries.join(path.delimiter)}${path.delimiter}${currentPath}` : currentPath;

  // Keep Python resolution consistent across runtime features (e.g., PyAV sidecar).
  childEnv.PYTHON = pythonExec;
  if (!childEnv.PYAV_PYTHON_BIN || !childEnv.PYAV_PYTHON_BIN.trim()) {
    childEnv.PYAV_PYTHON_BIN = pythonExec;
  }

  // ── MediaMTX — start when needed for WebRTC or capture ──────────────────
  // devServer.js always starts MediaMTX (dev mode). startServer.js starts it
  // only when the active configuration actually needs it so that analysis-only
  // deployments (which never serve WebRTC) don't require MediaMTX.
  const webrtcEngine   = (childEnv.WEBRTC_ENGINE    || 'mediamtx').toLowerCase();
  const captureBackend = (childEnv.CAPTURE_BACKEND  || 'ffmpeg').toLowerCase();
  const serverMode     = (childEnv.SERVER_MODE       || 'combined').toLowerCase();

  // MediaMTX is required in any non-analysis mode because:
  //   - mediamtx engine: RTSP pull + WebRTC WHEP delivery
  //   - mediasoup engine: pipelineManager registers camera paths for ingest-daemon loopback
  //   - YouTube streams: FFmpeg always publishes to MediaMTX RTSP regardless of WEBRTC_ENGINE
  // Analysis-only mode never captures RTSP or serves WebRTC — skip MediaMTX entirely.
  const needsMediaMTX = serverMode !== 'analysis';

  // Ingest daemon: started whenever CAPTURE_BACKEND=ingest-daemon regardless of WebRTC engine.
  const needsIngestDaemon = captureBackend === 'ingest-daemon' && serverMode !== 'analysis';

  let mediamtxChild    = null;
  let ingestDaemonChild = null;
  let _shuttingDown = false;

  if (needsMediaMTX) {
    const mediamtxBin    = resolveByRuntime(runtimeOs, 'MEDIAMTX_BIN') || 'mediamtx';
    const mediamtxConfig = path.resolve(__dirname, '..', '..', '..', 'mediamtx.yml');

    try {
      mediamtxChild = spawn(mediamtxBin, [mediamtxConfig], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      });

      mediamtxChild.stdout.on('data', makeLineRelay('[MediaMTX]', process.stdout));
      mediamtxChild.stderr.on('data', makeLineRelay('[MediaMTX]', process.stderr));

      mediamtxChild.on('error', (e) => {
        console.warn(`[Start] MediaMTX failed to start: ${e.message} — WebRTC delivery will be unavailable`);
        mediamtxChild = null;
      });
      mediamtxChild.on('exit', (code) => {
        mediamtxChild = null;
        if (code !== 0 && code !== null) {
          console.warn(`[Start] MediaMTX exited (code=${code})`);
        }
      });
    } catch (e) {
      console.warn(`[Start] Could not start MediaMTX: ${e.message}`);
    }
  }

  if (needsIngestDaemon) {
    // INGEST_DAEMON_BIN may be a Python script (e.g. ../ingest-daemon/ingest_daemon.py)
    // or a compiled Go/native binary.  Detect by extension.
    const ingestBinRaw = resolveByRuntime(runtimeOs, 'INGEST_DAEMON_BIN') || '';
    const ingestAddr   = childEnv.INGEST_DAEMON_ADDR || ':7070';
    const ingestPort   = parseInt(ingestAddr.replace(':', '') || '7070', 10);

    // Check if ingest-daemon is already listening on its port (same check as devServer.js).
    const net = require('net');
    const alreadyRunning = await new Promise(resolve => {
      const sock = new net.Socket();
      sock.setTimeout(500);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.on('error',   () => resolve(false));
      sock.connect(ingestPort, '127.0.0.1');
    });

    if (alreadyRunning) {
      console.log(`[Start] ingest-daemon already running on :${ingestPort} — skipping start`);
    } else {
      let ingestExec;
      let ingestArgs;
      if (ingestBinRaw.endsWith('.py')) {
        // Prefer PYAV_PYTHON_BIN (points to the Python that has PyAV installed)
        // over the generic PYTHON_EXEC which may be a system Python without PyAV.
        // Resolved OS-first (PYAV_PYTHON_BIN_WINDOWS/_LINUX) so a generic PYAV_PYTHON_BIN
        // set for the "other" OS doesn't shadow the platform-specific path.
        ingestExec = resolveByRuntime(runtimeOs, 'PYAV_PYTHON_BIN') || pythonExec;
        // __dirname = server/src/scripts — two levels up reaches server/, where the relative path in .env is anchored
        ingestArgs = [path.resolve(__dirname, '..', '..', ingestBinRaw), '--addr', ingestAddr];
      } else {
        ingestExec = ingestBinRaw || 'ingest-daemon';
        ingestArgs = ['--addr', ingestAddr];
      }

      let _ingestRestartAttempts = 0;

      // Attach stdout/stderr relay and exit-based auto-restart to a spawned ingest-daemon process.
      // On unexpected exit (!_shuttingDown), waits with exponential backoff and re-spawns.
      // After successful restart, triggers camera re-registration via server internal API.
      function _attachIngestHandlers(proc) {
        proc.stdout.on('data', makeLineRelay('[Ingest]', process.stdout));
        proc.stderr.on('data', makeLineRelay('[Ingest]', process.stderr));

        proc.on('error', (e) => {
          console.warn(`[Start] ingest-daemon failed to start: ${e.message} — WebRTC/AI capture unavailable`);
          ingestDaemonChild = null;
          if (!_shuttingDown) _respawnIngest();
        });

        proc.on('exit', (code) => {
          ingestDaemonChild = null;
          if (_shuttingDown) return;
          if (code !== 0 && code !== null) {
            console.warn(`[Start] ingest-daemon exited (code=${code})`);
          }
          _respawnIngest();
        });
      }

      async function _killPortOrphan() {
        // Kill any process still holding ingestPort so the fresh spawn can bind.
        // fuser -k is Linux-only; safe to ignore on other platforms or if nothing occupies the port.
        try {
          const { execSync } = require('child_process');
          execSync(`fuser -k ${ingestPort}/tcp`, { stdio: 'ignore' });
          await new Promise(r => setTimeout(r, 300));
        } catch (_) {}
      }

      async function _respawnIngest() {
        if (_shuttingDown) return;
        const delay = Math.min(1_000 * Math.pow(1.5, _ingestRestartAttempts), 30_000);
        _ingestRestartAttempts++;
        console.warn(`[Start] ingest-daemon crashed — restarting in ${(delay / 1000).toFixed(1)}s (attempt #${_ingestRestartAttempts})`);
        await new Promise(r => setTimeout(r, delay));
        if (_shuttingDown) return;

        // Evict any orphan process left on the port before spawning a fresh daemon.
        await _killPortOrphan();

        try {
          const proc = spawn(ingestExec, ingestArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
          });
          ingestDaemonChild = proc;
          _attachIngestHandlers(proc);
          console.log(`[Start] ingest-daemon restarting on ${ingestAddr}`);

          // Wait for the daemon to bind its port (up to 15 s).
          // Only count the port as ready when the spawned process is still alive
          // (exitCode === null), so we don't mistake a surviving orphan for success.
          const deadline = Date.now() + 15_000;
          let ready = false;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 300));
            if (_shuttingDown || !ingestDaemonChild) break;
            // Process already exited — bind failed; abort this poll round.
            if (ingestDaemonChild.exitCode !== null || ingestDaemonChild.signalCode !== null) break;
            const up = await new Promise(resolve => {
              const s = new net.Socket();
              s.setTimeout(400);
              s.on('connect', () => { s.destroy(); resolve(true); });
              s.on('timeout', () => { s.destroy(); resolve(false); });
              s.on('error', () => resolve(false));
              s.connect(ingestPort, '127.0.0.1');
            });
            if (up) { ready = true; break; }
          }

          if (ready) {
            _ingestRestartAttempts = 0;
            console.log(`[Start] ingest-daemon restarted on :${ingestPort} — re-registering cameras`);
            // Must mirror startIngestDaemon.js/restartIngestDaemon.js: when HTTPS_ENABLED=true
            // the plain HTTP listener on HTTP_PORT never binds (see index.js ACTIVE_PORT),
            // so a hardcoded http:// request here always fails with ECONNREFUSED and the
            // reregister silently never happens after a crash-restart.
            const httpsEnabled = (childEnv.HTTPS_ENABLED || '').toLowerCase() === 'true';
            const serverProto  = httpsEnabled ? https : http;
            const serverPort   = parseInt(httpsEnabled ? (childEnv.HTTPS_PORT || '3443') : (childEnv.HTTP_PORT || '3080'), 10);
            const sslCtx       = httpsEnabled ? { rejectUnauthorized: false } : {};
            serverProto.request(
              {
                hostname: '127.0.0.1', port: serverPort,
                path: '/api/internal/ingest/reregister',
                method: 'POST', headers: { 'Content-Length': '0' },
                ...sslCtx,
              },
              (res) => { console.log(`[Start] ingest reregister: HTTP ${res.statusCode}`); res.resume(); }
            ).on('error', (e) => { console.warn(`[Start] ingest reregister failed: ${e.message}`); }).end();
          } else {
            console.warn(`[Start] ingest-daemon not ready after restart — will retry on next crash`);
          }
        } catch (e) {
          console.warn(`[Start] Could not restart ingest-daemon: ${e.message}`);
          _respawnIngest();
        }
      }

      try {
        ingestDaemonChild = spawn(ingestExec, ingestArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
        });
        _attachIngestHandlers(ingestDaemonChild);
        console.log(`[Start] ingest-daemon starting on ${ingestAddr}`);

        // Wait up to 15 s for ingest-daemon to bind its port before starting the
        // Node.js server. Without this delay, pipelineManager.startCamera() calls
        // addCameraStream() while the port is still unbound → ECONNREFUSED → WebRTC
        // disabled for every camera.
        const INGEST_READY_TIMEOUT_MS = 15_000;
        const INGEST_POLL_MS          = 300;
        const deadline = Date.now() + INGEST_READY_TIMEOUT_MS;
        let ingestReady = false;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, INGEST_POLL_MS));
          // Stop polling if the daemon already exited (spawn error)
          if (!ingestDaemonChild) break;
          const ready = await new Promise(resolve => {
            const s = new net.Socket();
            s.setTimeout(400);
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('timeout', () => { s.destroy(); resolve(false); });
            s.on('error',   () => resolve(false));
            s.connect(ingestPort, '127.0.0.1');
          });
          if (ready) { ingestReady = true; break; }
        }
        if (ingestReady) {
          console.log(`[Start] ingest-daemon ready on :${ingestPort}`);
        } else {
          console.warn(`[Start] ingest-daemon not ready after ${INGEST_READY_TIMEOUT_MS / 1000}s — starting server anyway`);
        }
      } catch (e) {
        console.warn(`[Start] Could not start ingest-daemon: ${e.message}`);
      }
    }
  }

  const child = spawn(nodeExec, [serverEntry], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: childEnv,
  });
  child.stdout.on('data', makeLineRelay('', process.stdout));
  child.stderr.on('data', makeLineRelay('', process.stderr));

  child.on('error', (err) => {
    console.error(`[Start] Failed to launch server with "${nodeExec}": ${err.message}`);
    if (mediamtxChild) try { mediamtxChild.kill('SIGTERM'); } catch (_) {}
    process.exit(1);
  });

  // ── Graceful shutdown helpers ───────────────────────────────────────────
  // killChildren: terminate managed child processes (mediamtx, ingest-daemon).
  // Idempotent — safe to call multiple times.
  const killChildren = (sig = 'SIGTERM') => {
    if (mediamtxChild)     { try { mediamtxChild.kill(sig);     } catch (_) {} mediamtxChild     = null; }
    if (ingestDaemonChild) { try { ingestDaemonChild.kill(sig); } catch (_) {} ingestDaemonChild = null; }
  };

  const shutdown = (sig) => {
    if (_shuttingDown) return;
    _shuttingDown = true;
    killChildren(sig);
    try { child.kill(sig); } catch (_) {}
    // Force-exit after 12 s if graceful shutdown stalls
    setTimeout(() => {
      console.warn('[Start] Forced exit after 12s shutdown timeout');
      killChildren('SIGKILL');
      process.exit(1);
    }, 12_000).unref();
  };

  child.on('exit', (code, signal) => {
    killChildren('SIGTERM');
    // Remove signal handlers before re-raising so the OS default (exit) fires.
    // Without this, process.kill(pid, signal) would re-invoke our handler and
    // never reach the default exit behaviour, leaving startServer.js alive forever.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGHUP');
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  // Forward SIGTERM / SIGINT / SIGHUP to all child processes.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGHUP',  () => shutdown('SIGTERM'));
}

main().catch(e => { console.error('[Start] fatal:', e.message); process.exit(1); });