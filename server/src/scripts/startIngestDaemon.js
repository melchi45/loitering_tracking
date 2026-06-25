#!/usr/bin/env node
'use strict';

/**
 * startIngestDaemon.js — ingest daemon 최초 시작 (기존 프로세스 종료 없음).
 *
 * 이미 daemon이 실행 중이면 /health 응답을 확인하고 종료한다.
 * 실행 중이 아닌 경우에만 새로 시작한다.
 *
 * Usage:
 *   cd server && npm run ingest:start
 *   cd server && npm run ingest:start -- --dry-run
 */

const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const { spawn } = require('child_process');

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
const PYTHON_BIN    = (process.env.PYAV_PYTHON_BIN || '').trim() || 'python3';
const DAEMON_BIN    = (process.env.INGEST_DAEMON_BIN || '../ingest-daemon/ingest_daemon.py').trim();
const DAEMON_ADDR   = (process.env.INGEST_DAEMON_ADDR || ':7070').trim();
const DAEMON_URL    = (process.env.INGEST_DAEMON_URL  || 'http://127.0.0.1:7070').replace(/\/$/, '');
const HTTPS_ENABLED = (process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
const SERVER_PORT   = HTTPS_ENABLED
  ? parseInt(process.env.HTTPS_PORT || '3443', 10)
  : parseInt(process.env.HTTP_PORT || process.env.PORT || '3080', 10);
const SERVER_PROTO  = HTTPS_ENABLED ? 'https' : 'http';

const SERVER_DIR  = path.resolve(__dirname, '../..');
const DAEMON_PATH = DAEMON_BIN.endsWith('.py')
  ? path.resolve(SERVER_DIR, DAEMON_BIN)
  : DAEMON_BIN;

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(SERVER_DIR, 'storage');
const DB_PATH = path.join(STORAGE_PATH, 'lts.json');

console.log('[ingest:start] ──────────────────────────────────────────');
console.log(`[ingest:start] Python  : ${PYTHON_BIN}`);
console.log(`[ingest:start] Script  : ${DAEMON_PATH}`);
console.log(`[ingest:start] Addr    : ${DAEMON_ADDR}`);
console.log(`[ingest:start] URL     : ${DAEMON_URL}`);
console.log(`[ingest:start] Callback: ${SERVER_PROTO}://127.0.0.1:${SERVER_PORT}`);
if (DRY_RUN) { console.log('[ingest:start] --dry-run: 실제 실행 없이 종료'); process.exit(0); }
console.log('[ingest:start] ──────────────────────────────────────────');

// ── 이미 실행 중인지 확인 ─────────────────────────────────────────────────────
async function isAlreadyRunning() {
  const u = new URL(`${DAEMON_URL}/health`);
  return new Promise((resolve) => {
    const req = http.get({ hostname: u.hostname, port: u.port || 7070, path: u.pathname, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── health 대기 ───────────────────────────────────────────────────────────────
async function waitForHealth(maxMs = 10_000, pollMs = 300) {
  const u = new URL(`${DAEMON_URL}/health`);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ hostname: u.hostname, port: u.port || 7070, path: u.pathname, timeout: 1000 }, (res) => {
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

// ── 카메라 재등록 (restartIngestDaemon.js와 동일 로직) ──────────────────────
async function reregisterCameras() {
  const proto  = HTTPS_ENABLED ? https : http;
  const sslCtx = HTTPS_ENABLED ? { rejectUnauthorized: false } : {};

  try {
    const result = await new Promise((resolve, reject) => {
      const reregisterUrl = new URL(`${SERVER_PROTO}://127.0.0.1:${SERVER_PORT}/api/internal/ingest/reregister`);
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
        console.log(`[ingest:start]   ✓ 재등록 (via server): ${id.slice(0, 8)}  vPort=${info.videoPort} aPort=${info.audioPort}`);
      } else {
        console.warn(`[ingest:start]   ✗ 재등록 실패 ${id.slice(0, 8)}: ${info.error || `HTTP ${info.status}`}`);
      }
    }
    return;
  } catch (e) {
    console.warn(`[ingest:start] 서버 재등록 API 실패 (${e.message}) — DB 직접 읽기로 폴백`);
  }

  let cameras = [];
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    cameras = db.cameras || [];
  } catch (e) {
    console.warn(`[ingest:start] DB 읽기 실패 (${DB_PATH}): ${e.message}`);
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
      console.log(`[ingest:start]   ✓ 등록 (AI + App RTP): ${cam.id.slice(0, 8)}`);
    } catch (e) {
      console.warn(`[ingest:start]   ✗ 등록 실패 ${cam.id.slice(0, 8)}: ${e.message}`);
    }
  }
}

(async () => {
  // 이미 실행 중이면 재시작 없이 종료
  if (await isAlreadyRunning()) {
    console.log(`[ingest:start] daemon이 이미 실행 중입니다 (${DAEMON_URL}). 중지하려면 npm run ingest:stop`);
    process.exit(0);
  }

  const DAEMON_LOG = process.env.INGEST_DAEMON_LOG || '/tmp/ingest-daemon.log';
  console.log(`[ingest:start] daemon 시작 중… (로그: ${DAEMON_LOG})`);
  const logFd = fs.openSync(DAEMON_LOG, 'a');
  const child = spawn(PYTHON_BIN, [DAEMON_PATH, '--addr', DAEMON_ADDR], {
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.on('error', (e) => { console.error(`[ingest:start] 시작 실패: ${e.message}`); process.exit(1); });
  child.on('exit', (code) => {
    if (code != null && code !== 0) console.warn(`[ingest:start] daemon exited (code=${code})`);
  });
  child.unref();
  fs.closeSync(logFd);

  console.log('[ingest:start] daemon 기동 대기 중 (최대 10초)…');
  const ready = await waitForHealth(10_000);
  if (!ready) {
    console.error('[ingest:start] daemon이 10초 내에 응답하지 않습니다. 로그를 확인하세요.');
    process.exit(1);
  }
  console.log(`[ingest:start] daemon 준비 완료 (PID ${child.pid})`);

  console.log('[ingest:start] 카메라 재등록 중…');
  await reregisterCameras();
  console.log(`[ingest:start] 완료. 로그 확인: tail -f ${DAEMON_LOG}`);
})();
