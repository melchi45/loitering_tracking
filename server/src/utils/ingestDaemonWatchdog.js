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

// 2026-07-27 incident (Design_RTSP_Capture_Backend.md §6.40): INGEST_WATCHDOG_ENABLED=false
// was left set from a past debugging session and stayed off for days, silently disabling
// auto-recovery while ingest-daemon was HTTP-wedged — cameras sat in RETRY/Offline with no
// automatic fix. The debug-disable is meant to be short-lived (comment in server/.env says
// "temporarily... re-enable afterward"), so this safety net makes that assumption
// self-enforcing instead of relying on someone remembering to flip the flag back.
const DEBUG_DISABLE_REMINDER_MS = 5 * 60_000;  // loud reminder every 5 min while disabled
const DEBUG_DISABLE_MAX_MS      = 30 * 60_000; // force re-enable after 30 min regardless

// Fetches and parses ingest-daemon's own /health body (e.g. {"status":"ok","cameras":9})
// — used by both the watchdog loop (boolean-only) and the dashboard status API
// (wants the camera count too). Never rejects; timeout/parse/connection errors
// all resolve to { ok: false, error }.
function fetchIngestDaemonHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const parsed = JSON.parse(body);
          resolve({ ok: true, cameras: parsed.cameras });
        } catch {
          resolve({ ok: false, error: 'invalid JSON response' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error',   (err) => resolve({ ok: false, error: err.message }));
  });
}

async function checkHealth(url) {
  return (await fetchIngestDaemonHealth(url)).ok;
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

// Called instead of startIngestDaemonWatchdog() when INGEST_WATCHDOG_ENABLED=false.
// Reminds loudly every 5 min that auto-recovery is off, and force-starts the real
// watchdog after 30 min so a debug session that was never cleaned up can't leave
// ingest-daemon unrecoverable indefinitely.
function armDebugDisableSafetyNet() {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
    if (Date.now() - startedAt >= DEBUG_DISABLE_MAX_MS) {
      clearInterval(timer);
      console.warn(`[IngestWatchdog] INGEST_WATCHDOG_ENABLED=false for ${elapsedMin}min — safety net timeout reached, force-enabling watchdog now (set INGEST_WATCHDOG_ENABLED=true in server/.env to silence this)`);
      startIngestDaemonWatchdog();
      return;
    }
    console.warn(`[IngestWatchdog] still disabled via INGEST_WATCHDOG_ENABLED=false (${elapsedMin}min elapsed) — auto-recovery is OFF, will force re-enable at 30min`);
  }, DEBUG_DISABLE_REMINDER_MS);
  timer.unref();
}

module.exports = { startIngestDaemonWatchdog, fetchIngestDaemonHealth, armDebugDisableSafetyNet };
