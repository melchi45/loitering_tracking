'use strict';

const path = require('path');
const { spawn } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', process.env.LTS_ENV_FILE || '.env') });
} catch {
  // Continue with process env when dotenv is unavailable.
}

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
  const generic = process.env[baseKey];
  if (generic && String(generic).trim()) return String(generic).trim();
  const osKey = runtimeOs === 'windows' ? `${baseKey}_WINDOWS` : `${baseKey}_LINUX`;
  const osVal = process.env[osKey];
  return osVal && String(osVal).trim() ? String(osVal).trim() : '';
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

  // MediaMTX: needed for mediamtx WebRTC WHEP engine, or when mediamtx is the capture backend.
  // Analysis-only mode never serves WebRTC or captures RTSP, so skip MediaMTX entirely
  // regardless of CAPTURE_BACKEND/WEBRTC_ENGINE settings in the env file.
  const needsMediaMTX = serverMode !== 'analysis' &&
                      (webrtcEngine === 'mediamtx' || captureBackend === 'mediamtx');

  // Ingest daemon: started whenever CAPTURE_BACKEND=ingest-daemon regardless of WebRTC engine.
  const needsIngestDaemon = captureBackend === 'ingest-daemon' && serverMode !== 'analysis';

  let mediamtxChild    = null;
  let ingestDaemonChild = null;

  if (needsMediaMTX) {
    const mediamtxBin    = resolveByRuntime(runtimeOs, 'MEDIAMTX_BIN') || 'mediamtx';
    const mediamtxConfig = path.resolve(__dirname, '..', '..', '..', 'mediamtx.yml');

    try {
      mediamtxChild = spawn(mediamtxBin, [mediamtxConfig], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      });

      mediamtxChild.stdout.on('data', (d) => process.stdout.write(`[MediaMTX] ${d}`));
      mediamtxChild.stderr.on('data', (d) => process.stderr.write(`[MediaMTX] ${d}`));

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
      let ingestArgs;
      let ingestExec;
      if (ingestBinRaw.endsWith('.py')) {
        // Prefer PYAV_PYTHON_BIN (points to the Python that has PyAV installed)
        // over the generic PYTHON_EXEC which may be a system Python without PyAV.
        ingestExec = (childEnv.PYAV_PYTHON_BIN || '').trim() || pythonExec;
        // __dirname = server/src/scripts — two levels up reaches server/, where the relative path in .env is anchored
        ingestArgs = [path.resolve(__dirname, '..', '..', ingestBinRaw), '--addr', ingestAddr];
      } else {
        ingestExec = ingestBinRaw || 'ingest-daemon';
        ingestArgs = ['--addr', ingestAddr];
      }

      try {
        ingestDaemonChild = spawn(ingestExec, ingestArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
        });

        ingestDaemonChild.stdout.on('data', (d) => process.stdout.write(`[Ingest] ${d}`));
        ingestDaemonChild.stderr.on('data', (d) => process.stderr.write(`[Ingest] ${d}`));

        ingestDaemonChild.on('error', (e) => {
          console.warn(`[Start] ingest-daemon failed to start: ${e.message} — WebRTC/AI capture unavailable`);
          ingestDaemonChild = null;
        });
        ingestDaemonChild.on('exit', (code) => {
          ingestDaemonChild = null;
          if (code !== 0 && code !== null) {
            console.warn(`[Start] ingest-daemon exited (code=${code})`);
          }
        });
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
    stdio: 'inherit',
    env: childEnv,
  });

  child.on('error', (err) => {
    console.error(`[Start] Failed to launch server with "${nodeExec}": ${err.message}`);
    if (mediamtxChild) try { mediamtxChild.kill(); } catch (_) {}
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (mediamtxChild)     try { mediamtxChild.kill();     } catch (_) {}
    if (ingestDaemonChild) try { ingestDaemonChild.kill(); } catch (_) {}
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });

  // Forward SIGTERM/SIGINT to all child processes
  const shutdown = (sig) => {
    if (mediamtxChild)     try { mediamtxChild.kill(sig);     } catch (_) {}
    if (ingestDaemonChild) try { ingestDaemonChild.kill(sig); } catch (_) {}
    try { child.kill(sig); } catch (_) {}
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(e => { console.error('[Start] fatal:', e.message); process.exit(1); });