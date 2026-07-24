'use strict';

/**
 * ingestDaemonControl.js — ingest-daemon(:7070) 프로세스의 start/stop/restart
 * 공용 로직. `server/src/scripts/{start,stop,restart}IngestDaemon.js` (CLI)와
 * `POST /admin/ingest/{start,stop,restart}` (Admin Dashboard API)가 이 모듈
 * 하나만 호출한다 — 로직이 두 곳에 따로 존재하면 §6.35(restartIngestDaemon.js
 * 포트-해제 확인 버그)류 수정이 한쪽에만 적용되고 다른 쪽은 계속 깨진 채로
 * 남는 사고가 재발하기 쉽다는 것을 이번 세션에서 실제로 두 번 겪었다
 * (Design_RTSP_Capture_Backend.md §6.35, §6.36).
 *
 * 호출부가 이미 dotenv로 process.env를 채운 뒤(서버 프로세스 자체이거나,
 * CLI 래퍼가 로드한 뒤) require하는 것을 전제로 한다 — 이 모듈 자체는
 * .env 파일을 읽지 않는다.
 */

const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const net   = require('net');
const http  = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');

function getConfig() {
  const PYAV_OS_KEY   = process.platform === 'win32' ? 'PYAV_PYTHON_BIN_WINDOWS' : 'PYAV_PYTHON_BIN_LINUX';
  const pythonBin      = (process.env[PYAV_OS_KEY] || '').trim() || (process.env.PYAV_PYTHON_BIN || '').trim() || 'python3';
  const daemonBinRaw   = (process.env.INGEST_DAEMON_BIN || '../ingest-daemon/ingest_daemon.py').trim();
  const daemonAddr     = (process.env.INGEST_DAEMON_ADDR || ':7070').trim();
  const daemonPort     = parseInt(daemonAddr.replace(':', '') || '7070', 10);
  const daemonUrl      = (process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
  const httpsEnabled   = (process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
  const serverPort     = httpsEnabled
    ? parseInt(process.env.HTTPS_PORT || '3443', 10)
    : parseInt(process.env.HTTP_PORT || process.env.PORT || '3080', 10);
  const serverProto    = httpsEnabled ? 'https' : 'http';

  const serverDir  = path.resolve(__dirname, '..', '..');
  const daemonPath = daemonBinRaw.endsWith('.py') ? path.resolve(serverDir, daemonBinRaw) : daemonBinRaw;

  const storagePath = process.env.STORAGE_PATH
    ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
    : path.resolve(serverDir, 'storage');
  const dbPath = path.join(storagePath, 'lts.json');

  const daemonLog = process.env.INGEST_DAEMON_LOG || path.join(os.tmpdir(), 'ingest-daemon.log');

  return { pythonBin, daemonPath, daemonAddr, daemonPort, daemonUrl, httpsEnabled, serverPort, serverProto, dbPath, daemonLog };
}

// Whether the daemon's HTTP API answers /health. NOTE: a "zombie" daemon
// (process alive, CPU-spinning, HTTP thread starved — Design_RTSP_Capture_
// Backend.md §6.29.5) will make this resolve false even though the process
// still holds the port — do not use this alone to decide whether a kill is
// needed (see isPortFree() below, which is what stop/restart actually key off).
function checkHealth(daemonUrl) {
  const u = new URL(`${daemonUrl}/health`);
  return new Promise((resolve) => {
    const req = http.get({ hostname: u.hostname, port: u.port || 7070, path: u.pathname, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealth(daemonUrl, maxMs = 10_000, pollMs = 300) {
  const u = new URL(`${daemonUrl}/health`);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ hostname: u.hostname, port: u.port || 7070, path: u.pathname, timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// Real bind attempt — the only ptrace-independent way to know whether the
// port is actually free on hosts with kernel.yama.ptrace_scope=1 (see
// Design_RTSP_Capture_Backend.md §6.35/§6.36; `lsof`/`fuser` both silently
// fail to see a same-uid process started outside the caller's ptrace tree).
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

// Kills any process holding the daemon's port, including a zombie one that
// /health can't see. Returns once the port is confirmed free (or gives up
// after the SIGKILL grace window). `wasRunning` reflects port occupancy
// *before* this ran, not the (unreliable) /health-based check.
async function killDaemon({ daemonPort }) {
  const wasRunning = !(await isPortFree(daemonPort));
  if (!wasRunning) return { wasRunning: false };

  try { execSync(`fuser -k ${daemonPort}/tcp`, { stdio: 'ignore' }); } catch (_) {}
  try { execSync("pkill -f 'ingest_daemon.py'", { stdio: 'ignore' }); } catch (_) {}

  const graceDeadline = Date.now() + 8_000;
  while (Date.now() < graceDeadline) {
    if (await isPortFree(daemonPort)) return { wasRunning: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  if (await isPortFree(daemonPort)) return { wasRunning: true };

  try { execSync("pkill -9 -f 'ingest_daemon.py'", { stdio: 'ignore' }); } catch (_) {}
  const killDeadline = Date.now() + 3_000;
  while (Date.now() < killDeadline) {
    if (await isPortFree(daemonPort)) return { wasRunning: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { wasRunning: true, stillOccupied: !(await isPortFree(daemonPort)) };
}

// Spawns a fresh daemon process (detached — survives this process exiting,
// same as the CLI scripts always did) and waits for /health.
async function spawnDaemon(cfg) {
  const logFd = fs.openSync(cfg.daemonLog, 'a');
  // ingest_daemon.py self-targets setpriority() at startup using
  // INGEST_DAEMON_PRIORITY (Design_RTSP_Capture_Backend.md §6.33.1) — just
  // needs the env var passed through, no spawn-side wrapping.
  const child = spawn(cfg.pythonBin, [cfg.daemonPath, '--addr', cfg.daemonAddr], {
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  fs.closeSync(logFd);

  const ready = await waitForHealth(cfg.daemonUrl, 10_000);
  return { child, ready };
}

// Re-registers all active cameras via the server's own internal endpoint
// (localhost-only, always registered regardless of SERVER_MODE — see
// `POST /api/internal/ingest/reregister` in index.js). Works identically
// whether called from inside the running server process (Admin API) or
// from a standalone CLI script, so there's exactly one implementation.
async function reregisterCameras(cfg) {
  const proto  = cfg.httpsEnabled ? https : http;
  const sslCtx = cfg.httpsEnabled ? { rejectUnauthorized: false } : {};

  try {
    const result = await new Promise((resolve, reject) => {
      const u = new URL(`${cfg.serverProto}://127.0.0.1:${cfg.serverPort}/api/internal/ingest/reregister`);
      const opts = {
        hostname: u.hostname, port: u.port || cfg.serverPort, path: u.pathname,
        method: 'POST', headers: { 'Content-Length': '0' }, ...sslCtx,
      };
      const req = proto.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
          else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    return { via: 'server', cameras: result.cameras || {} };
  } catch (e) {
    // Fallback: DB 직접 읽기 (mediasoup 포트 없음 — AI 프레임만 등록)
  }

  let cameras = [];
  try {
    const db = JSON.parse(fs.readFileSync(cfg.dbPath, 'utf8'));
    cameras = db.cameras || [];
  } catch (e) {
    return { via: 'fallback', error: `DB read failed: ${e.message}`, cameras: {} };
  }

  const results = {};
  for (const cam of cameras) {
    if (!cam.id || !cam.rtspUrl) continue;
    const callbackUrl       = `${cfg.serverProto}://127.0.0.1:${cfg.serverPort}/api/internal/frame/${cam.id}`;
    const appRtpCallbackUrl = `${cfg.serverProto}://127.0.0.1:${cfg.serverPort}/api/internal/apprtp/${cam.id}`;
    const body = JSON.stringify({ id: cam.id, rtspUrl: cam.rtspUrl, callbackUrl, appRtpCallbackUrl });
    try {
      await new Promise((resolve, reject) => {
        const u = new URL(`${cfg.daemonUrl}/cameras`);
        const opts = {
          hostname: u.hostname, port: u.port || 7070, path: u.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        };
        const req = http.request(opts, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
            else reject(new Error(`HTTP ${res.statusCode}`));
          });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });
      results[cam.id] = { ok: true };
    } catch (e) {
      results[cam.id] = { ok: false, error: e.message };
    }
  }
  return { via: 'fallback', cameras: results };
}

// ── High-level operations (used by both CLI wrappers and the Admin API) ────

async function startDaemon() {
  const cfg = getConfig();
  if (!(await isPortFree(cfg.daemonPort))) {
    return { ok: true, alreadyRunning: true };
  }
  const { child, ready } = await spawnDaemon(cfg);
  if (!ready) {
    return { ok: false, error: 'daemon did not respond to /health within 10s', pid: child.pid };
  }
  const { cameras } = await reregisterCameras(cfg);
  return { ok: true, alreadyRunning: false, pid: child.pid, cameras };
}

async function stopDaemon() {
  const cfg = getConfig();
  const { wasRunning, stillOccupied } = await killDaemon(cfg);
  if (stillOccupied) {
    return { ok: false, wasRunning, error: `port ${cfg.daemonPort} still occupied after SIGKILL` };
  }
  return { ok: true, wasRunning };
}

async function restartDaemon() {
  const cfg = getConfig();
  await killDaemon(cfg);
  const { child, ready } = await spawnDaemon(cfg);
  if (!ready) {
    return { ok: false, error: 'daemon did not respond to /health within 10s', pid: child.pid };
  }
  const { cameras } = await reregisterCameras(cfg);
  return { ok: true, pid: child.pid, cameras };
}

module.exports = {
  getConfig,
  checkHealth,
  waitForHealth,
  isPortFree,
  killDaemon,
  spawnDaemon,
  reregisterCameras,
  startDaemon,
  stopDaemon,
  restartDaemon,
};
