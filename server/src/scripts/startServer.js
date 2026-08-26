'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', process.env.LTS_ENV_FILE || '.env') });
} catch {
  // Continue with process env when dotenv is unavailable.
}

const logger = require('../utils/logger');
const { openLogFile, patchConsole, makeLineRelay } = logger;
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
  let ingestDaemonChildren = []; // instanceIndex -> child process | null (§6.45)
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
    // Multi-process ingest-daemon fleet (2026-07-28, §6.45) — cameras split
    // across INGEST_DAEMON_INSTANCES independent OS processes (each its own
    // port + GIL) via services/ingestDaemonPool.js, mirroring the same
    // deterministic cameraId-hash pattern webrtc/mediasoupEngine.js already
    // uses for its mediasoup Worker pool. Root cause: a single ingest-daemon
    // process handling every camera in one GIL was confirmed via live strace
    // during a wedge to hit a GIL hand-off livelock (~22,000 futex()/sec
    // across 96 threads, zero actual I/O) — six single-process mitigations
    // (§6.41-§6.44) each failed to stop the recurrence. With
    // INGEST_DAEMON_INSTANCES unset (default 1) this loop runs exactly once,
    // on today's exact port — see ingestDaemonPool.js's backward-compat
    // guarantee — so existing single-instance deployments are unaffected.
    const ingestDaemonPool = require('../services/ingestDaemonPool');
    const net = require('net');
    const instances = ingestDaemonPool.getAllInstanceConfigs();
    if (instances.length > 1) {
      console.log(`[Start] ingest-daemon fleet: ${instances.length} instances (ports ${instances.map(i => i.port).join(', ')})`);
    }

    async function _isPortFree(port) {
      return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => tester.close(() => resolve(true)));
        tester.listen(port, '0.0.0.0');
      });
    }

    // instanceIndex -> restart-attempt count. Declared once, outside the
    // per-instance loop below, so each instance's own counter persists across
    // that instance's repeated respawns (a shared counter keyed by index, not
    // one counter per instance-loop-iteration closure).
    const _ingestRestartAttempts = {};

    const readyPromises = [];
    for (const inst of instances) {
      const idx        = inst.index;
      const ingestPort = inst.port;
      const ingestAddr = inst.addr;
      _ingestRestartAttempts[idx] = 0;

      // Check if this instance is already listening on its port (same check as devServer.js).
      const alreadyRunning = await new Promise(resolve => {
        const sock = new net.Socket();
        sock.setTimeout(500);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error',   () => resolve(false));
        sock.connect(ingestPort, '127.0.0.1');
      });

      if (alreadyRunning) {
        console.log(`[Start] ingest-daemon[${idx}] already running on :${ingestPort} — skipping start`);
        continue;
      }

      // INGEST_DAEMON_BIN may be a Python script (e.g. ../ingest-daemon/ingest_daemon.py)
      // or a compiled Go/native binary.  Detect by extension.
      const ingestBinRaw = resolveByRuntime(runtimeOs, 'INGEST_DAEMON_BIN') || '';
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

      // Scheduling priority for ingest-daemon itself (2026-07-22,
      // Design_RTSP_Capture_Backend.md §6.33.1) — live diagnosis found
      // ingest-daemon at ~300% CPU (the single busiest process on this
      // shared host) while WebRTC loss persisted even after
      // mediasoup-worker's own priority boost. Routing this process's spawn
      // through the same C wrapper binary used for mediasoup-worker was
      // tried and abandoned — it consistently came up at default niceness
      // when launched via this spawn() call (works fine invoked directly
      // from a shell; root cause not identified). ingest_daemon.py now
      // self-targets setpriority() at its own startup instead (only needs
      // CAP_SYS_NICE on itself via `setcap` on the real python3 binary, not
      // on whatever spawns it) — this just needs to pass the env var through.
      //
      // INGEST_HEARTBEAT_FILE is set per-instance (2026-07-28, §6.45) —
      // ingest_daemon.py already reads this env var itself and passes it
      // straight through to its own ingest_health_proxy.py subprocess (no
      // Python code change needed); without a unique path per instance every
      // instance's _stats_sampler() would overwrite the SAME heartbeat file.
      const ingestChildEnv = { ...childEnv, INGEST_HEARTBEAT_FILE: inst.heartbeatFile };

      // Attach stdout/stderr relay and exit-based auto-restart to a spawned ingest-daemon process.
      // On unexpected exit (!_shuttingDown), waits with exponential backoff and re-spawns.
      // After successful restart, triggers camera re-registration via server internal API.
      // The relay tag stays the fixed '[Ingest]' (not per-instance) — GET
      // /admin/logs/recent?source=ingest matches on this exact prefix
      // (admin.js's prefixMap), so all instances' logs stay visible there;
      // instance identity is included in the message text instead.
      function _attachIngestHandlers(proc) {
        proc.stdout.on('data', makeLineRelay('[Ingest]', process.stdout));
        proc.stderr.on('data', makeLineRelay('[Ingest]', process.stderr));

        proc.on('error', (e) => {
          console.warn(`[Start] ingest-daemon[${idx}] failed to start: ${e.message} — WebRTC/AI capture unavailable`);
          ingestDaemonChildren[idx] = null;
          if (!_shuttingDown) _respawnIngest();
        });

        proc.on('exit', (code) => {
          ingestDaemonChildren[idx] = null;
          if (_shuttingDown) return;
          if (code !== 0 && code !== null) {
            console.warn(`[Start] ingest-daemon[${idx}] exited (code=${code})`);
          }
          _respawnIngest();
        });
      }

      // Whether the daemon holding ingestPort right now actually answers /health.
      // _respawnIngest() only fires reactively from THIS instance's own spawned
      // child exiting — if this instance is itself an orphan (its managed
      // index.js already gone, e.g. a leftover generation of startServer.js
      // from a prior deploy that was never fully stopped), it would otherwise
      // retry forever and, on every attempt, unconditionally pkill whatever is
      // on the port — including a perfectly healthy daemon that a DIFFERENT,
      // live supervisor generation is actively serving traffic through. That
      // exact scenario was reproduced live (2026-07-28): an orphaned
      // 5-day-old startServer.js kept killing the current daemon out from
      // under every camera every time its own dead child triggered a retry,
      // producing a repeating full-fleet 0 fps outage. Checking health first
      // and standing down when it's already good is what actually fixes the
      // recovery process, rather than just killing today's specific orphan.
      async function _isIngestHealthy() {
        return new Promise((resolve) => {
          const req = http.get(
            { hostname: '127.0.0.1', port: ingestPort, path: '/health', timeout: 1500 },
            (res) => { res.resume(); resolve(res.statusCode === 200); }
          );
          req.on('timeout', () => { req.destroy(); resolve(false); });
          req.on('error', () => resolve(false));
        });
      }

      async function _killPortOrphan() {
        // Kill any process still holding ingestPort so the fresh spawn can bind.
        // `fuser -k` resolves the listening socket to a PID via /proc/<pid>/fd,
        // which requires ptrace permission on the target — on hosts with
        // kernel.yama.ptrace_scope=1 (Ubuntu default) this silently fails for
        // any orphan started outside our ptrace tree (e.g. a previous
        // supervisor generation's child, or one wedged from a crashed prior
        // run), leaving the orphan alive and every subsequent spawn attempt
        // looping forever on EADDRINUSE. `pkill -f` matches via
        // /proc/<pid>/cmdline instead, which is NOT ptrace-gated, so it still
        // reaches the orphan even when fuser/lsof can't see it (same fix
        // already applied to restartIngestDaemon.js's killExistingDaemon(),
        // 2026-07-23). Matched on THIS instance's own `--addr :PORT` argument
        // (2026-07-28, §6.45) — with multiple instances, a bare `pkill -f
        // 'ingest_daemon.py'` would kill every instance, not just this one's
        // orphan. Linux-only; safe to ignore on other platforms.
        const pattern = `ingest_daemon.py --addr :${ingestPort}`;
        try {
          const { execSync } = require('child_process');
          execSync(`fuser -k ${ingestPort}/tcp`, { stdio: 'ignore' });
        } catch (_) {}
        try {
          const { execSync } = require('child_process');
          execSync(`pkill -f '${pattern}'`, { stdio: 'ignore' });
        } catch (_) {}

        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          if (await _isPortFree(ingestPort)) return;
          await new Promise(r => setTimeout(r, 250));
        }
        if (await _isPortFree(ingestPort)) return;

        console.warn(`[Start] ingest-daemon[${idx}] orphan still holding :${ingestPort} after SIGTERM — escalating to SIGKILL`);
        try {
          const { execSync } = require('child_process');
          execSync(`pkill -9 -f '${pattern}'`, { stdio: 'ignore' });
        } catch (_) {}
        const killDeadline = Date.now() + 3_000;
        while (Date.now() < killDeadline) {
          if (await _isPortFree(ingestPort)) return;
          await new Promise(r => setTimeout(r, 250));
        }
      }

      async function _respawnIngest() {
        if (_shuttingDown) return;
        const delay = Math.min(1_000 * Math.pow(1.5, _ingestRestartAttempts[idx]), 30_000);
        _ingestRestartAttempts[idx]++;
        console.warn(`[Start] ingest-daemon[${idx}] crashed — restarting in ${(delay / 1000).toFixed(1)}s (attempt #${_ingestRestartAttempts[idx]})`);
        await new Promise(r => setTimeout(r, delay));
        if (_shuttingDown) return;

        // Another supervisor generation is already serving a healthy daemon on
        // this port — stand down instead of killing it and racing to replace
        // it with our own. See _isIngestHealthy() above for why this check
        // exists at all.
        if (await _isIngestHealthy()) {
          console.warn(`[Start] ingest-daemon[${idx}] on :${ingestPort} is healthy (owned by another supervisor) — standing down, this instance will not manage it further`);
          _ingestRestartAttempts[idx] = 0;
          return;
        }

        // Evict any orphan process left on the port before spawning a fresh daemon.
        await _killPortOrphan();

        try {
          const proc = spawn(ingestExec, ingestArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: ingestChildEnv,
          });
          ingestDaemonChildren[idx] = proc;
          _attachIngestHandlers(proc);
          console.log(`[Start] ingest-daemon[${idx}] restarting on ${ingestAddr}`);

          // Wait for the daemon to bind its port (up to 15 s).
          // Only count the port as ready when the spawned process is still alive
          // (exitCode === null), so we don't mistake a surviving orphan for success.
          const deadline = Date.now() + 15_000;
          let ready = false;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 300));
            if (_shuttingDown || !ingestDaemonChildren[idx]) break;
            // Process already exited — bind failed; abort this poll round.
            if (ingestDaemonChildren[idx].exitCode !== null || ingestDaemonChildren[idx].signalCode !== null) break;
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
            _ingestRestartAttempts[idx] = 0;
            console.log(`[Start] ingest-daemon[${idx}] restarted on :${ingestPort} — re-registering its cameras`);
            // Must mirror startIngestDaemon.js/restartIngestDaemon.js: when HTTPS_ENABLED=true
            // the plain HTTP listener on HTTP_PORT never binds (see index.js ACTIVE_PORT),
            // so a hardcoded http:// request here always fails with ECONNREFUSED and the
            // reregister silently never happens after a crash-restart.
            const httpsEnabled = (childEnv.HTTPS_ENABLED || '').toLowerCase() === 'true';
            const serverProto  = httpsEnabled ? https : http;
            const serverPort   = parseInt(httpsEnabled ? (childEnv.HTTPS_PORT || '3443') : (childEnv.HTTP_PORT || '3080'), 10);
            const sslCtx       = httpsEnabled ? { rejectUnauthorized: false } : {};
            // instanceIndex (§6.45) scopes the reregister to only THIS
            // instance's cameras — the other instances' cameras never crashed
            // and don't need re-registering. See index.js's reregister route.
            const reregBody = JSON.stringify({ instanceIndex: idx });
            serverProto.request(
              {
                hostname: '127.0.0.1', port: serverPort,
                path: '/api/internal/ingest/reregister',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reregBody) },
                ...sslCtx,
              },
              (res) => { console.log(`[Start] ingest-daemon[${idx}] reregister: HTTP ${res.statusCode}`); res.resume(); }
            ).on('error', (e) => { console.warn(`[Start] ingest-daemon[${idx}] reregister failed: ${e.message}`); }).end(reregBody);
          } else {
            console.warn(`[Start] ingest-daemon[${idx}] not ready after restart — will retry on next crash`);
          }
        } catch (e) {
          console.warn(`[Start] Could not restart ingest-daemon[${idx}]: ${e.message}`);
          _respawnIngest();
        }
      }

      try {
        const proc = spawn(ingestExec, ingestArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: ingestChildEnv,
        });
        ingestDaemonChildren[idx] = proc;
        _attachIngestHandlers(proc);
        console.log(`[Start] ingest-daemon[${idx}] starting on ${ingestAddr}`);

        // Wait up to 15 s for this instance to bind its port before starting
        // the Node.js server. Without this delay, pipelineManager.startCamera()
        // calls addCameraStream() while the port is still unbound →
        // ECONNREFUSED → WebRTC disabled for every camera. Collected into
        // readyPromises (awaited together after this loop) instead of awaited
        // here, so N instances start in parallel rather than adding up to
        // N × 15s of sequential startup delay.
        readyPromises.push((async () => {
          const INGEST_READY_TIMEOUT_MS = 15_000;
          const INGEST_POLL_MS          = 300;
          const deadline = Date.now() + INGEST_READY_TIMEOUT_MS;
          let ingestReady = false;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, INGEST_POLL_MS));
            // Stop polling if the daemon already exited (spawn error)
            if (!ingestDaemonChildren[idx]) break;
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
            console.log(`[Start] ingest-daemon[${idx}] ready on :${ingestPort}`);
          } else {
            console.warn(`[Start] ingest-daemon[${idx}] not ready after ${INGEST_READY_TIMEOUT_MS / 1000}s — starting server anyway`);
          }
        })());
      } catch (e) {
        console.warn(`[Start] Could not start ingest-daemon[${idx}]: ${e.message}`);
      }
    }

    await Promise.all(readyPromises);
  }

  const child = spawn(nodeExec, [serverEntry], {
    // 4th 'ipc' slot lets index.js (Admin API, Log Storage & Rotation panel)
    // push logConfig changes to THIS process via process.send()/child.on('message')
    // — this process is the one that actually owns the log file handle
    // (openLogFile()/patchConsole() above), see utils/logger.js header comment
    // and docs/design/Design_Log_Rotation.md.
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    env: childEnv,
  });
  child.stdout.on('data', makeLineRelay('', process.stdout));
  child.stderr.on('data', makeLineRelay('', process.stderr));
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'lts:logConfig' && msg.payload) {
      logger.setLogConfig(msg.payload);
    } else if (msg.type === 'lts:logRotate') {
      logger.forceRotate();
    }
  });

  child.on('error', (err) => {
    console.error(`[Start] Failed to launch server with "${nodeExec}": ${err.message}`);
    if (mediamtxChild) try { mediamtxChild.kill('SIGTERM'); } catch (_) {}
    process.exit(1);
  });

  // ── Graceful shutdown helpers ───────────────────────────────────────────
  // killChildren: terminate managed child processes (mediamtx, ingest-daemon).
  // Idempotent — safe to call multiple times.
  const killChildren = (sig = 'SIGTERM') => {
    if (mediamtxChild) { try { mediamtxChild.kill(sig); } catch (_) {} mediamtxChild = null; }
    ingestDaemonChildren.forEach((c, i) => {
      if (!c) return;
      try { c.kill(sig); } catch (_) {}
      ingestDaemonChildren[i] = null;
    });
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