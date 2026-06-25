#!/usr/bin/env node
'use strict';

/**
 * stopIngestDaemon.js — ingest daemon 종료.
 *
 * 포트 7070 프로세스 kill → pkill -f ingest_daemon.py 순서로 종료.
 * 이미 실행 중이 아니어도 오류 없이 종료된다.
 *
 * Usage:
 *   cd server && npm run ingest:stop
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');
const { execSync } = require('child_process');

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
} catch (_) { /* .env not found */ }

const DAEMON_ADDR = (process.env.INGEST_DAEMON_ADDR || ':7070').trim();
const DAEMON_URL  = (process.env.INGEST_DAEMON_URL  || 'http://127.0.0.1:7070').replace(/\/$/, '');

// ── 실행 중 여부 확인 ─────────────────────────────────────────────────────────
async function isRunning() {
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

(async () => {
  const running = await isRunning();
  if (!running) {
    console.log(`[ingest:stop] daemon이 실행 중이지 않습니다 (${DAEMON_URL}).`);
    process.exit(0);
  }

  console.log('[ingest:stop] daemon 종료 중…');
  const addrPort = DAEMON_ADDR.replace(':', '');
  try { execSync(`fuser -k ${addrPort}/tcp 2>/dev/null; true`, { shell: true, stdio: 'ignore' }); } catch (_) {}
  try { execSync("pkill -f 'ingest_daemon.py' 2>/dev/null; true", { shell: true, stdio: 'ignore' }); } catch (_) {}

  // 포트 해제 확인 (최대 3초)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await isRunning())) break;
    await new Promise(r => setTimeout(r, 300));
  }

  const stillRunning = await isRunning();
  if (stillRunning) {
    console.warn('[ingest:stop] daemon이 아직 실행 중입니다. 수동으로 확인하세요.');
    process.exit(1);
  }

  console.log('[ingest:stop] daemon 종료 완료.');
})();
