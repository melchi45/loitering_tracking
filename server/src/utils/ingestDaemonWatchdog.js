'use strict';

/**
 * ingest-daemon HTTP-unresponsive watchdog (2026-07-21, Design_RTSP_Capture_Backend.md §6.29.5/§6.29.9).
 *
 * ingest_daemon.py has been observed going fully unresponsive on its own HTTP
 * API (/health, /cameras, registration POSTs never return) while the process
 * itself stays alive and CPU-busy — confirmed twice in one session, ~1 hour
 * apart, always requiring SIGKILL (SIGTERM got no response either) via
 * `npm run ingest:restart`. Suspected CPython GIL contention from PyAV decode
 * threads starving the HTTP server thread under sustained multi-camera load;
 * not root-caused at the Python level (py-spy blocked by ptrace_scope=1).
 * Until that's fixed, this watchdog is the automatic recovery path — mirrors
 * pipelineManager.js's WebRTC self-heal sweep, but for the daemon itself.
 */

const http  = require('http');
const path  = require('path');
const { spawn } = require('child_process');

const CHECK_INTERVAL_MS   = 20_000;
const HEALTH_TIMEOUT_MS   = 3_000;
const FAILURE_THRESHOLD   = 2;      // consecutive failed checks before restarting
const STARTUP_GRACE_MS    = 30_000; // let the daemon finish its own boot first
const RESTART_COOLDOWN_MS = 90_000; // restartIngestDaemon.js itself takes ~10s;
                                     // give re-registration time before re-arming

function checkHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error',   () => resolve(false));
  });
}

function triggerRestart() {
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'restartIngestDaemon.js');
  console.error('[IngestWatchdog] ingest-daemon unresponsive for 2 consecutive checks — running restartIngestDaemon.js');
  // Resolve 'node' via PATH rather than process.execPath — on this host
  // process.execPath resolves to the glibc-compat ld-linux loader binary
  // itself (confirmed live: `ps aux` shows the running process as
  // `ld-linux-x86-64.so.2 --library-path ... node-24_15_0 src/index.js`),
  // so spawning process.execPath directly with just [scriptPath] drops the
  // --library-path/node-24_15_0 arguments the loader needs and instead tries
  // to execve() the .js file itself as an ELF binary ("invalid ELF header").
  // The `node` on PATH is the wrapper script at ~/.local/bin/node that adds
  // those arguments correctly — the same one `npm run ingest:restart` uses.
  const child = spawn('node', [scriptPath], {
    cwd: path.resolve(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout.on('data', (d) => process.stdout.write(`[IngestWatchdog] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[IngestWatchdog] ${d}`));
  child.on('exit', (code) => {
    console.log(`[IngestWatchdog] restartIngestDaemon.js exited with code ${code}`);
  });
}

function startIngestDaemonWatchdog() {
  const url = `${(process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '')}/health`;
  let consecutiveFailures = 0;
  let cooldownUntil = 0;

  const timer = setInterval(async () => {
    if (Date.now() < cooldownUntil) return;
    const ok = await checkHealth(url);
    if (ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures += 1;
    console.warn(`[IngestWatchdog] health check failed (${consecutiveFailures}/${FAILURE_THRESHOLD}) — ${url}`);
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      consecutiveFailures = 0;
      cooldownUntil = Date.now() + RESTART_COOLDOWN_MS;
      triggerRestart();
    }
  }, CHECK_INTERVAL_MS);
  timer.unref();

  // Delay the first check past STARTUP_GRACE_MS so a slow-but-normal boot
  // (daemon still binding its port) isn't mistaken for the unresponsive state.
  cooldownUntil = Date.now() + STARTUP_GRACE_MS;
}

module.exports = { startIngestDaemonWatchdog };
