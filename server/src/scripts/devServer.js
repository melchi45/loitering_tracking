'use strict';

const path = require('path');
const { spawn } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
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
  const nodemonBin = path.resolve(__dirname, '..', '..', 'node_modules', 'nodemon', 'bin', 'nodemon.js');
  const nodemonConfig = path.resolve(__dirname, '..', '..', 'nodemon.json');
  const serverEntry = path.resolve(__dirname, '..', 'index.js');
  const monitorEntry = path.resolve(__dirname, 'webrtcMonitor.js');
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

  // ── MediaMTX (WebRTC relay) ──────────────────────────────────────────────
  // Start MediaMTX before nodemon so the API is ready when pipelineManager
  // calls addCameraPath() on the first camera start.
  const mediamtxBin    = resolveByRuntime(runtimeOs, 'MEDIAMTX_BIN') || 'mediamtx';
  const mediamtxConfig = path.resolve(__dirname, '..', '..', '..', 'mediamtx.yml');
  let mediamtxChild = null;

  function startMediaMTX() {
    const proc = spawn(mediamtxBin, [mediamtxConfig], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    mediamtxChild = proc;

    proc.stdout.on('data', (d) => process.stdout.write(`[MediaMTX] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[MediaMTX] ${d}`));

    proc.on('error', (e) => {
      console.warn(`[Dev] MediaMTX failed to start: ${e.message} — WebRTC delivery will be unavailable`);
      mediamtxChild = null;
    });
    proc.on('exit', (code) => {
      mediamtxChild = null;
      if (code !== 0 && code !== null) {
        console.warn(`[Dev] MediaMTX exited (code=${code})`);
      }
    });
  }

  try { startMediaMTX(); } catch (_) {}

  // ── nodemon (main server process) ────────────────────────────────────────
  const child = spawn(nodeExec, [nodemonBin, '--config', nodemonConfig, '--exec', nodeExec, serverEntry], {
    stdio: 'inherit',
    env: childEnv,
  });

  child.on('error', (err) => {
    console.error(`[Dev] Failed to launch nodemon with "${nodeExec}": ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (monitorChild) try { monitorChild.kill(); } catch (_) {}
    if (mediamtxChild) try { mediamtxChild.kill(); } catch (_) {}
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });

  // ── WebRTC monitor (companion process) ──────────────────────────────────
  let monitorChild = null;
  const MONITOR_START_DELAY_MS = 3_000;
  setTimeout(() => {
    monitorChild = spawn(nodeExec, [monitorEntry], {
      stdio: 'inherit',
      env: childEnv,
    });
    monitorChild.on('error', (e) => {
      console.warn(`[Dev] WebRTC monitor failed to start: ${e.message}`);
    });
    monitorChild.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[Dev] WebRTC monitor exited (code=${code})`);
      }
    });
  }, MONITOR_START_DELAY_MS);

  // Forward SIGINT/SIGTERM so all children are cleaned up on Ctrl+C
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (monitorChild)  try { monitorChild.kill(sig);  } catch (_) {}
      if (mediamtxChild) try { mediamtxChild.kill(sig); } catch (_) {}
      try { child.kill(sig); } catch (_) {}
    });
  }
}

main();