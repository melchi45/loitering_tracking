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

  // ── Ingest daemon (CAPTURE_BACKEND=ingest-daemon) ────────────────────────
  // Start before nodemon so it's ready when pipelineManager calls addCameraStream().
  // Skip if already running (avoids port conflict on server restart).
  const captureBackend = (childEnv.CAPTURE_BACKEND || '').toLowerCase();
  const serverMode     = (childEnv.SERVER_MODE || 'combined').toLowerCase();

  // Analysis-only mode never serves WebRTC or captures RTSP — skip MediaMTX.
  if (serverMode !== 'analysis') {
    try { startMediaMTX(); } catch (_) {}
  }
  let ingestDaemonChild = null;

  if (captureBackend === 'ingest-daemon' && serverMode !== 'analysis') {
    const ingestBinRaw = resolveByRuntime(runtimeOs, 'INGEST_DAEMON_BIN') || '';
    const ingestAddr   = childEnv.INGEST_DAEMON_ADDR || ':7070';
    const ingestUrl    = (childEnv.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
    const ingestPort   = parseInt(ingestAddr.replace(':', '') || '7070', 10);

    // Check if ingest-daemon is already listening on its port.
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
      console.log(`[Dev] ingest-daemon already running on :${ingestPort} — skipping start`);
    } else {
      let ingestExec, ingestArgs;
      if (ingestBinRaw.endsWith('.py')) {
        // Resolved OS-first (PYAV_PYTHON_BIN_WINDOWS/_LINUX) so a generic PYAV_PYTHON_BIN
        // set for the "other" OS doesn't shadow the platform-specific path.
        ingestExec = resolveByRuntime(runtimeOs, 'PYAV_PYTHON_BIN') || pythonExec;
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
          console.warn(`[Dev] ingest-daemon failed to start: ${e.message}`);
          ingestDaemonChild = null;
        });
        ingestDaemonChild.on('exit', (code) => {
          ingestDaemonChild = null;
          if (code !== 0 && code !== null) console.warn(`[Dev] ingest-daemon exited (code=${code})`);
        });
        console.log(`[Dev] ingest-daemon starting on ${ingestAddr}`);
      } catch (e) {
        console.warn(`[Dev] Could not start ingest-daemon: ${e.message}`);
      }
    }
  }

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
    if (monitorChild)      try { monitorChild.kill();      } catch (_) {}
    if (mediamtxChild)     try { mediamtxChild.kill();     } catch (_) {}
    if (ingestDaemonChild) try { ingestDaemonChild.kill(); } catch (_) {}
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
      if (monitorChild)      try { monitorChild.kill(sig);      } catch (_) {}
      if (mediamtxChild)     try { mediamtxChild.kill(sig);     } catch (_) {}
      if (ingestDaemonChild) try { ingestDaemonChild.kill(sig); } catch (_) {}
      try { child.kill(sig); } catch (_) {}
    });
  }
}

main().catch(err => { console.error('[Dev] Fatal:', err.message); process.exit(1); });  