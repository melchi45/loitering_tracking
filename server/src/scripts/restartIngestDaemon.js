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
const fs      = require('fs');
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
const PYTHON_BIN    = (process.env.PYAV_PYTHON_BIN || '').trim() || 'python3';
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

// ── 기존 daemon 종료 ──────────────────────────────────────────────────────────
console.log('[ingest:restart] 기존 daemon 종료 중…');
const addrPort = DAEMON_ADDR.replace(':', '');
try { execSync(`fuser -k ${addrPort}/tcp 2>/dev/null; true`, { shell: true, stdio: 'ignore' }); } catch (_) {}
try { execSync("pkill -f 'ingest_daemon.py' 2>/dev/null; true", { shell: true, stdio: 'ignore' }); } catch (_) {}
// 포트가 비워질 때까지 잠깐 대기
execSync('sleep 0.5', { shell: true, stdio: 'ignore' });

// ── 새 daemon 시작 ────────────────────────────────────────────────────────────
console.log('[ingest:restart] 새 daemon 시작 중…');
const child = spawn(PYTHON_BIN, [DAEMON_PATH, '--addr', DAEMON_ADDR], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

child.stdout.on('data', (d) => process.stdout.write(`[Ingest] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[Ingest] ${d}`));
child.on('error', (e) => { console.error(`[ingest:restart] 시작 실패: ${e.message}`); process.exit(1); });
child.on('exit', (code) => {
  if (code != null && code !== 0) console.warn(`[ingest:restart] daemon exited (code=${code})`);
});
child.unref();  // 부모 프로세스 종료 후에도 daemon 유지

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
async function reregisterCameras() {
  let cameras = [];
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    cameras = db.cameras || [];
  } catch (e) {
    console.warn(`[ingest:restart] DB 읽기 실패 (${DB_PATH}): ${e.message}`);
    return;
  }

  const sslCtx = HTTPS_ENABLED ? { rejectUnauthorized: false } : null;

  for (const cam of cameras) {
    if (!cam.id || !cam.rtspUrl) continue;
    const callbackUrl = `${SERVER_PROTO}://127.0.0.1:${SERVER_PORT}/api/internal/frame/${cam.id}`;
    const body = JSON.stringify({ id: cam.id, rtspUrl: cam.rtspUrl, callbackUrl });

    try {
      await new Promise((resolve, reject) => {
        const u = new URL(`${DAEMON_URL}/cameras`);
        const opts = {
          hostname: u.hostname, port: u.port || 7070, path: u.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          ...(sslCtx || {}),
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
      console.log(`[ingest:restart]   ✓ 등록: ${cam.id.slice(0, 8)} → ${cam.rtspUrl.slice(0, 50)}`);
    } catch (e) {
      console.warn(`[ingest:restart]   ✗ 등록 실패 ${cam.id.slice(0, 8)}: ${e.message}`);
    }
  }
}

(async () => {
  console.log('[ingest:restart] daemon 기동 대기 중 (최대 10초)…');
  const ready = await waitForHealth(10_000);
  if (!ready) {
    console.error('[ingest:restart] daemon이 10초 내에 응답하지 않습니다. 로그를 확인하세요.');
    process.exit(1);
  }
  console.log(`[ingest:restart] daemon 준비 완료 (PID ${child.pid})`);

  console.log('[ingest:restart] 카메라 재등록 중…');
  await reregisterCameras();
  console.log('[ingest:restart] 완료. daemon 로그:');
})();
