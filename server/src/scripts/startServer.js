'use strict';

const path = require('path');
const { spawn } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', process.env.LTS_ENV_FILE || '.env') });
} catch {
  // Continue with process env when dotenv is unavailable.
}

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

function main() {
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

  // mediasoup engine uses Go ingest daemon — MediaMTX not needed for that path.
  const needsMediaMTX = (webrtcEngine === 'mediamtx' && serverMode !== 'analysis')
                      || captureBackend === 'mediamtx';

  const needsIngestDaemon = webrtcEngine === 'mediasoup' && serverMode !== 'analysis';

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
    const ingestBin  = resolveByRuntime(runtimeOs, 'INGEST_DAEMON_BIN') || 'ingest-daemon';
    const ingestAddr = childEnv.INGEST_DAEMON_ADDR || ':7070';

    try {
      ingestDaemonChild = spawn(ingestBin, ['--addr', ingestAddr], {
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
    } catch (e) {
      console.warn(`[Start] Could not start ingest-daemon: ${e.message}`);
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

main();