'use strict';

/**
 * WebRTC connection health monitor — runs alongside nodemon in `npm run dev`.
 *
 * Every POLL_INTERVAL_MS seconds, polls:
 *   GET /api/webrtc/monitor  — pipeline status + MediaMTX health
 *   GET /health              — server uptime
 *   ps aux | grep ffmpeg     — OS-level ffmpeg process count
 *
 * Prints a compact status line plus anomaly warnings.
 * Anomalies detected:
 *   - ffmpeg process count > expected (orphan leak)
 *   - MediaMTX unreachable
 *   - pipeline frame stall (>10 s since last frame)
 */

const path     = require('path');
const https    = require('https');
const http     = require('http');
const { execSync } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
} catch (_) {}

// ── Config ────────────────────────────────────────────────────────────────────
const HTTPS_ENABLED   = process.env.HTTPS_ENABLED === 'true';
const PORT            = HTTPS_ENABLED
  ? parseInt(process.env.HTTPS_PORT || '3443', 10)
  : parseInt(process.env.HTTP_PORT  || '3080', 10);
const MEDIAMTX_API    = process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997';
const POLL_INTERVAL_MS   = 5_000;
const STALL_THRESHOLD_MS = 10_000;
const CONNECT_RETRY_MS   = 2_000;
const CONNECT_MAX_TRIES  = 60;

// ── ANSI colors ───────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

function ts()   { return new Date().toTimeString().slice(0, 8); }
function pfx(level = 'info') {
  const color = level === 'warn' ? C.yellow : level === 'error' ? C.red : C.cyan;
  return `${color}[WebRTC-MON ${ts()}]${C.reset}`;
}
function ok(s)   { return `${C.green}${s}${C.reset}`; }
function warn(s) { return `${C.yellow}${s}${C.reset}`; }
function err(s)  { return `${C.red}${C.bold}${s}${C.reset}`; }
function dim(s)  { return `${C.gray}${s}${C.reset}`; }
function bold(s) { return `${C.bold}${s}${C.reset}`; }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const mod  = HTTPS_ENABLED ? https : http;
    const url  = `${HTTPS_ENABLED ? 'https' : 'http'}://127.0.0.1:${PORT}${urlPath}`;
    const opts = HTTPS_ENABLED ? { rejectUnauthorized: false } : {};
    const req  = mod.get(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4_000, () => { req.destroy(); reject(new Error('request timeout')); });
  });
}

function getUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── FFmpeg process count ──────────────────────────────────────────────────────
function countFfmpeg() {
  try {
    const out = execSync("ps aux 2>/dev/null | grep '[f]fmpeg' | wc -l", {
      encoding: 'utf8',
      timeout:  2000,
    }).trim();
    return parseInt(out, 10) || 0;
  } catch (_) {
    return -1;
  }
}

// ── MediaMTX health ───────────────────────────────────────────────────────────
async function checkMediaMTX() {
  try {
    const res = await getUrl(`${MEDIAMTX_API}/v3/config/global/get`);
    return res.status < 400;
  } catch {
    return false;
  }
}

// ── State tracking ────────────────────────────────────────────────────────────
const prevPipelines = new Map();
const anomalyCount  = { ffmpegLeak: 0, mediamtxDown: 0, stall: 0 };

// ── Poll cycle ────────────────────────────────────────────────────────────────
async function poll() {
  let health, monitor;
  try {
    [health, monitor] = await Promise.all([get('/health'), get('/api/webrtc/monitor')]);
  } catch (e) {
    console.log(`${pfx('warn')} server unreachable — ${e.message}`);
    return;
  }
  if (!health || !monitor) {
    console.log(`${pfx('warn')} invalid server response`);
    return;
  }

  const [ffmpegCount, mediamtxOk] = await Promise.all([
    Promise.resolve(countFfmpeg()),
    checkMediaMTX(),
  ]);

  const pipelines      = monitor.pipelines || [];
  // Each pipeline runs exactly 1 ffmpeg process (RTSPCapture for AI frames).
  // MediaMTX handles WebRTC delivery independently (its own processes, not counted here).
  const expectedFfmpeg = pipelines.length;

  // ── Header line ──────────────────────────────────────────────────────────
  const uptimeStr = health.uptime ? `${Math.round(health.uptime)}s` : '?';
  const ffOk      = ffmpegCount < 0 || ffmpegCount <= expectedFfmpeg + 1;
  const ffStr     = ffmpegCount < 0 ? dim('?') : !ffOk
    ? err(`${ffmpegCount}`)
    : ffmpegCount > 0 ? ok(`${ffmpegCount}`) : dim('0');

  console.log(
    `${pfx()} ${bold('server')} ${ok('OK')} uptime=${uptimeStr} mode=${monitor.serverMode || '?'}` +
    ` │ ${bold('ffmpeg')} ${ffStr}/${expectedFfmpeg} procs`
  );

  // ── MediaMTX status ───────────────────────────────────────────────────────
  const mtxStr = mediamtxOk ? ok('OK') : err('DOWN');
  const mtxWarn = !mediamtxOk && pipelines.some(p => p.useWebRTC);
  console.log(
    `${pfx(mtxWarn ? 'warn' : 'info')} ${bold('MediaMTX')} ${mtxStr}` +
    (monitor.mediamtx?.paths !== undefined ? ` │ paths=${monitor.mediamtx.paths}` : '')
  );
  if (!mediamtxOk) anomalyCount.mediamtxDown++;

  // ── Per-pipeline status ───────────────────────────────────────────────────
  for (const pipe of pipelines) {
    const cam     = pipe.cameraId.slice(0, 8);
    const now     = Date.now();
    const staleMs = pipe.lastFrameAt ? now - pipe.lastFrameAt : null;
    const stalled = staleMs !== null && staleMs > STALL_THRESHOLD_MS;
    const noFrames = staleMs === null;

    const prev    = prevPipelines.get(pipe.cameraId);
    const growing = prev ? pipe.frameCount > prev.frameCount : null;
    prevPipelines.set(pipe.cameraId, { frameCount: pipe.frameCount, lastFrameAt: pipe.lastFrameAt });

    const streamStr = noFrames
      ? dim('no frames yet')
      : stalled
        ? err(`STALLED ${(staleMs / 1000).toFixed(1)}s`)
        : growing === false
          ? warn(`frozen frames=${pipe.frameCount}`)
          : ok(`live frames=${pipe.frameCount} lag=${(staleMs / 1000).toFixed(1)}s`);

    const webrtcLabel = pipe.useWebRTC
      ? `webrtc=${ok('MediaMTX')}`
      : `webrtc=${dim('NO')}`;

    console.log(
      `${pfx(stalled ? 'warn' : 'info')} ${bold('cam=' + cam)}` +
      ` ${webrtcLabel} │ ${streamStr}`
    );

    if (stalled) anomalyCount.stall++;
  }

  // ── ffmpeg leak warning ───────────────────────────────────────────────────
  if (ffmpegCount >= 0 && ffmpegCount > expectedFfmpeg + 1) {
    console.log(
      `${pfx('warn')} ${err('⚠ FFMPEG LEAK')}: ${ffmpegCount} processes but` +
      ` only ${expectedFfmpeg} pipelines — orphaned processes detected`
    );
    anomalyCount.ffmpegLeak++;
  }

  // ── Anomaly summary every 12 polls (~1 min) ───────────────────────────────
  if (Object.values(anomalyCount).some(v => v > 0)) {
    const total = Object.values(anomalyCount).reduce((a, b) => a + b, 0);
    if (total % 12 === 0) {
      console.log(
        `${pfx('warn')} anomaly counts since start:` +
        ` ffmpegLeak=${anomalyCount.ffmpegLeak}` +
        ` mediamtxDown=${anomalyCount.mediamtxDown}` +
        ` stall=${anomalyCount.stall}`
      );
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const proto = HTTPS_ENABLED ? 'https' : 'http';
  console.log(`${pfx()} WebRTC monitor starting — ${proto}://127.0.0.1:${PORT} poll=${POLL_INTERVAL_MS / 1000}s`);

  let attempts = 0;
  for (;;) {
    try {
      await get('/health');
      break;
    } catch (_) {
      attempts++;
      if (attempts === 1) console.log(`${pfx('warn')} waiting for server to start...`);
      if (attempts >= CONNECT_MAX_TRIES) {
        console.log(`${pfx('error')} server not reachable after ${CONNECT_MAX_TRIES * CONNECT_RETRY_MS / 1000}s — monitor exiting`);
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
  console.log(`${pfx()} server is up — monitoring started`);

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((e) => {
  console.error('[WebRTC-MON] fatal:', e.message);
  process.exit(1);
});
