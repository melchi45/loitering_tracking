#!/usr/bin/env node
'use strict';

/**
 * restartIngestDaemon.js — 실행 중인 ingest daemon만 재시작.
 *
 * 1. 기존 daemon 프로세스 종료 (포트 7070 kill)
 * 2. 새 daemon 시작 (백그라운드, stdout/stderr 로그 출력)
 * 3. /health 엔드포인트로 기동 확인 (최대 10초)
 * 4. DB에서 카메라 목록을 읽어 daemon에 재등록 (callbackUrl 포함)
 *
 * Usage:
 *   cd server && npm run ingest:restart
 *   cd server && npm run ingest:restart -- --dry-run   # 시작/등록 없이 설정만 출력
 */

const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const net     = require('net');
const http    = require('http');
const https   = require('https');
const { execSync, spawn } = require('child_process');

// ── 환경 변수 로드 ────────────────────────────────────────────────────────────
const envFile = process.env.LTS_ENV_FILE
  ? path.resolve(__dirname, '../../', process.env.LTS_ENV_FILE)
  : path.resolve(__dirname, '../../.env');

try {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch (_) { /* .env not found — use existing env */ }

const DRY_RUN       = process.argv.includes('--dry-run');
// OS-specific key first (PYAV_PYTHON_BIN_WINDOWS/_LINUX) so a generic PYAV_PYTHON_BIN
// set for the "other" OS doesn't shadow the platform-specific path.
const PYAV_OS_KEY   = process.platform === 'win32' ? 'PYAV_PYTHON_BIN_WINDOWS' : 'PYAV_PYTHON_BIN_LINUX';
const PYTHON_BIN    = (process.env[PYAV_OS_KEY] || '').trim() || (process.env.PYAV_PYTHON_BIN || '').trim() || 'python3';
const DAEMON_BIN    = (process.env.INGEST_DAEMON_BIN || '../ingest-daemon/ingest_daemon.py').trim();
const DAEMON_ADDR   = (process.env.INGEST_DAEMON_ADDR || ':7070').trim();
const DAEMON_URL    = (process.env.INGEST_DAEMON_URL  || 'http://127.0.0.1:7070').replace(/\/$/, '');
const HTTPS_ENABLED = (process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
const SERVER_PORT   = HTTPS_ENABLED
  ? parseInt(process.env.HTTPS_PORT || '3443', 10)
  : parseInt(process.env.HTTP_PORT || process.env.PORT || '3080', 10);
const SERVER_PROTO  = HTTPS_ENABLED ? 'https' : 'http';

// INGEST_DAEMON_BIN 경로를 server/ 기준 절대 경로로 변환
const SERVER_DIR  = path.resolve(__dirname, '../..');
const DAEMON_PATH = DAEMON_BIN.endsWith('.py')
  ? path.resolve(SERVER_DIR, DAEMON_BIN)
  : DAEMON_BIN;

// DB 파일 경로 (lts.json)
const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(SERVER_DIR, 'storage');
const DB_PATH = path.join(STORAGE_PATH, 'lts.json');

// ── 설정 출력 ─────────────────────────────────────────────────────────────────
console.log('[ingest:restart] ─────────────────────────────────────────');
console.log(`[ingest:restart] Python  : ${PYTHON_BIN}`);
console.log(`[ingest:restart] Script  : ${DAEMON_PATH}`);
console.log(`[ingest:restart] Addr    : ${DAEMON_ADDR}`);
console.log(`[ingest:restart] URL     : ${DAEMON_URL}`);
console.log(`[ingest:restart] Callback: ${SERVER_PROTO}://127.0.0.1:${SERVER_PORT}`);
if (DRY_RUN) { console.log('[ingest:restart] --dry-run: 실제 실행 없이 종료'); process.exit(0); }
console.log('[ingest:restart] ─────────────────────────────────────────');

// ── 기존 daemon 종료 (cross-platform: port 기준) ──────────────────────────────
// Unix: fuser/pkill로 포트+cmdline 매칭 종료. Windows: fuser/pkill이 없으므로
// stopServer.js와 동일하게 Get-NetTCPConnection/netstat으로 포트를 점유한 PID를
// 찾아 taskkill로 종료한다 (getPidsOnWindows/killPids, server/src/scripts/stopServer.js 참조).
function _getPortPid() {
  const addrPort = parseInt(DAEMON_ADDR.replace(':', ''), 10);
  if (process.platform === 'win32') {
    try {
      const cmd = `Get-NetTCPConnection -State Listen -LocalPort ${addrPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
      const out = execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pids = out.split(/\r?\n/).map(l => parseInt(l.trim(), 10)).filter(Number.isFinite);
      if (pids.length) return pids;
    } catch (_) {}
    try {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || !/^TCP$/i.test(parts[0])) continue;
        const m = parts[1].match(/:(\d+)$/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (m && parseInt(m[1], 10) === addrPort && Number.isFinite(pid)) pids.add(pid);
      }
      return Array.from(pids);
    } catch (_) { return []; }
  }
  try {
    const out = execSync(`lsof -ti tcp:${addrPort} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map(l => parseInt(l.trim(), 10)).filter(Number.isFinite);
  } catch (_) { return []; }
}

// Whether the port is actually free, checked by attempting a real bind
// instead of asking lsof/`_getPortPid()` who owns it (2026-07-23).
// `_getPortPid()` shells out to `lsof -ti tcp:PORT`, which resolves a
// listening socket to a PID via `/proc/<pid>/fd` — a read that requires
// ptrace permission on the target process. On hosts with the (Ubuntu
// default) `kernel.yama.ptrace_scope=1`, that permission is denied for
// any process outside the caller's ptrace tree, e.g. a daemon started by
// a different shell/session — even though it's the same uid. In that
// case lsof silently returns nothing, `_getPortPid()` reports `[]`, and
// the poll loop below used to read that as "port already free" and
// return immediately, skipping the SIGKILL escalation entirely — so
// `startDaemon()` raced onto a port a still-alive zombie daemon held,
// crashing on EADDRINUSE in a loop. Binding a throwaway server is what
// the real daemon spawn is about to do anyway, so it's a direct,
// permission-independent proxy for "is this port actually available".
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

async function killExistingDaemon() {
  console.log('[ingest:restart] 기존 daemon 종료 중…');
  const addrPort = parseInt(DAEMON_ADDR.replace(':', ''), 10);
  const pids = _getPortPid();
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    } catch (_) { /* already dead */ }
  }
  if (process.platform !== 'win32') {
    // pkill matches via /proc/<pid>/cmdline, which — unlike /proc/<pid>/fd —
    // is NOT gated by ptrace_scope, so this still reaches the daemon even
    // when `_getPortPid()` above (lsof) found no owner for the port.
    try { execSync("pkill -f 'ingest_daemon.py'", { stdio: 'ignore' }); } catch (_) {}
  }
  // Poll for the port to actually free up instead of a fixed 500ms sleep
  // (2026-07-16) — ingest_daemon.py's graceful SIGTERM shutdown (stop_all(),
  // joining every camera's threads with up to an 8s timeout each) can take
  // several seconds under real fleet churn, occasionally much longer than
  // that when threads don't exit cleanly (see docs/design/
  // Design_RTSP_Capture_Backend.md §6.11/§6.12). A fixed 500ms wait let
  // startDaemon() race against a still-listening old process, causing a
  // reliable "Address already in use" crash on the fresh spawn. Wait up to
  // 8s for the port to clear on its own; if it's still held after that,
  // escalate to SIGKILL (systemd's TERM-then-KILL pattern) so the restart
  // always eventually succeeds instead of failing outright.
  const GRACE_MS = 8_000;
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (await isPortFree(addrPort)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (await isPortFree(addrPort)) return;
  console.warn(`[ingest:restart] SIGTERM 후 ${GRACE_MS}ms 내 종료되지 않음 — SIGKILL로 강제 종료`);
  const stillListening = _getPortPid();
  for (const pid of stillListening) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch (_) { /* already dead */ }
  }
  if (process.platform !== 'win32') {
    // Same ptrace_scope blind spot as the SIGTERM step above — always
    // also try the cmdline-matched fallback so the daemon is actually
    // killed even when `_getPortPid()` can't see it.
    try { execSync("pkill -9 -f 'ingest_daemon.py'", { stdio: 'ignore' }); } catch (_) {}
  }
  const killDeadline = Date.now() + 3_000;
  while (Date.now() < killDeadline) {
    if (await isPortFree(addrPort)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!(await isPortFree(addrPort))) {
    console.error(`[ingest:restart] SIGKILL 후에도 포트 ${addrPort}가 해제되지 않았습니다.`);
  }
}

// ── 새 daemon 시작 ────────────────────────────────────────────────────────────
// Daemon logs are written directly to a file so the restart script can exit
// cleanly after camera registration without holding the event loop open.
const DAEMON_LOG = process.env.INGEST_DAEMON_LOG || path.join(os.tmpdir(), 'ingest-daemon.log');

async function startDaemon() {
  console.log(`[ingest:restart] 새 daemon 시작 중… (로그: ${DAEMON_LOG})`);
  const logFd = fs.openSync(DAEMON_LOG, 'a');
  const child = spawn(PYTHON_BIN, [DAEMON_PATH, '--addr', DAEMON_ADDR], {
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.on('error', (e) => { console.error(`[ingest:restart] 시작 실패: ${e.message}`); process.exit(1); });
  child.on('exit', (code) => {
    if (code != null && code !== 0) console.warn(`[ingest:restart] daemon exited (code=${code})`);
  });
  child.unref();  // 부모 프로세스 종료 후에도 daemon 유지
  fs.closeSync(logFd); // parent no longer needs the FD; daemon keeps it via inheritance
  return child;
}

// ── 기동 확인 ─────────────────────────────────────────────────────────────────
async function waitForHealth(maxMs = 10_000, pollMs = 300) {
  const u = new URL(`${DAEMON_URL}/health`);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 1000 }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch (_) {
      await new Promise(r => setTimeout(r, pollMs));
    }
  }
  return false;
}

// ── 카메라 재등록 ─────────────────────────────────────────────────────────────
// mediasoup PlainTransport 포트는 DB에 없고 서버 메모리(_cameras 맵)에만 있으므로
// 서버의 /api/internal/ingest/reregister 엔드포인트를 통해 재등록한다.
// 서버가 응답하지 않으면 DB 직접 읽기 방식으로 폴백 (AI 프레임만, RTP 없음).
async function reregisterCameras() {
  const proto = (HTTPS_ENABLED ? https : http);
  const sslCtx = HTTPS_ENABLED ? { rejectUnauthorized: false } : {};

  // 1차: 서버 API를 통해 재등록 (mediasoup 포트 포함)
  try {
    const result = await new Promise((resolve, reject) => {
      const reregisterUrl = new URL(
        `${SERVER_PROTO}://127.0.0.1:${SERVER_PORT}/api/internal/ingest/reregister`
      );
      const opts = {
        hostname: reregisterUrl.hostname,
        port:     reregisterUrl.port || SERVER_PORT,
        path:     reregisterUrl.pathname,
        method:   'POST',
        headers:  { 'Content-Length': '0' },
        ...sslCtx,
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

    const cams = result.cameras || {};
    for (const [id, info] of Object.entries(cams)) {
      if (info.ok) {
        console.log(`[ingest:restart]   ✓ 재등록 (via server): ${id.slice(0, 8)}  vPort=${info.videoPort} aPort=${info.audioPort}`);
      } else {
        console.warn(`[ingest:restart]   ✗ 재등록 실패 ${id.slice(0, 8)}: ${info.error || `HTTP ${info.status}`}`);
      }
    }
    return;
  } catch (e) {
    console.warn(`[ingest:restart] 서버 재등록 API 실패 (${e.message}) — DB 직접 읽기로 폴백`);
  }

  // 2차 폴백: DB 직접 읽기 (mediasoup 포트 없음 — AI 프레임만 등록)
  let cameras = [];
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    cameras = db.cameras || [];
  } catch (e) {
    console.warn(`[ingest:restart] DB 읽기 실패 (${DB_PATH}): ${e.message}`);
    return;
  }

  for (const cam of cameras) {
    if (!cam.id || !cam.rtspUrl) continue;
    const callbackUrl       = `${SERVER_PROTO}://127.0.0.1:${SERVER_PORT}/api/internal/frame/${cam.id}`;
    const appRtpCallbackUrl = `${SERVER_PROTO}://127.0.0.1:${SERVER_PORT}/api/internal/apprtp/${cam.id}`;
    const body = JSON.stringify({ id: cam.id, rtspUrl: cam.rtspUrl, callbackUrl, appRtpCallbackUrl });

    try {
      await new Promise((resolve, reject) => {
        const u = new URL(`${DAEMON_URL}/cameras`);
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
      console.log(`[ingest:restart]   ✓ 등록 (AI + App RTP): ${cam.id.slice(0, 8)}`);
    } catch (e) {
      console.warn(`[ingest:restart]   ✗ 등록 실패 ${cam.id.slice(0, 8)}: ${e.message}`);
    }
  }
}

(async () => {
  await killExistingDaemon();
  const child = await startDaemon();

  console.log('[ingest:restart] daemon 기동 대기 중 (최대 10초)…');
  const ready = await waitForHealth(10_000);
  if (!ready) {
    console.error('[ingest:restart] daemon이 10초 내에 응답하지 않습니다. 로그를 확인하세요.');
    process.exit(1);
  }
  console.log(`[ingest:restart] daemon 준비 완료 (PID ${child.pid})`);

  console.log('[ingest:restart] 카메라 재등록 중…');
  await reregisterCameras();
  console.log(`[ingest:restart] 완료. 로그 확인: ${DAEMON_LOG}`);
})();
