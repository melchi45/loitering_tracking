#!/usr/bin/env node
'use strict';

/**
 * startIngestDaemon.js — ingest daemon 최초 시작 (기존 프로세스 종료 없음).
 *
 * 이미 daemon이 실행 중이면(포트 점유 여부로 판단, §6.36 참고) 아무것도
 * 하지 않고 종료한다. 핵심 로직은 server/src/services/ingestDaemonControl.js
 * 에 있다 — 이 파일은 .env 로드 + CLI 출력만 담당하는 얇은 래퍼.
 *
 * Usage:
 *   cd server && npm run ingest:start
 *   cd server && npm run ingest:start -- --dry-run
 */

const path = require('path');
const fs   = require('fs');

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

const DRY_RUN = process.argv.includes('--dry-run');

// getConfig() reads process.env, so require this only after the .env load above.
const { getConfig, startDaemon } = require('../services/ingestDaemonControl');
const cfg = getConfig();

console.log('[ingest:start] ──────────────────────────────────────────');
console.log(`[ingest:start] Python  : ${cfg.pythonBin}`);
console.log(`[ingest:start] Script  : ${cfg.daemonPath}`);
console.log(`[ingest:start] Addr    : ${cfg.daemonAddr}`);
console.log(`[ingest:start] URL     : ${cfg.daemonUrl}`);
console.log(`[ingest:start] Callback: ${cfg.serverProto}://127.0.0.1:${cfg.serverPort}`);
if (DRY_RUN) { console.log('[ingest:start] --dry-run: 실제 실행 없이 종료'); process.exit(0); }
console.log('[ingest:start] ──────────────────────────────────────────');

(async () => {
  console.log(`[ingest:start] daemon 시작 중… (로그: ${cfg.daemonLog})`);
  const result = await startDaemon();

  if (result.alreadyRunning) {
    console.log(`[ingest:start] daemon이 이미 실행 중입니다 (${cfg.daemonUrl}). 중지하려면 npm run ingest:stop`);
    process.exit(0);
  }
  if (!result.ok) {
    console.error(`[ingest:start] ${result.error}`);
    process.exit(1);
  }

  console.log(`[ingest:start] daemon 준비 완료 (PID ${result.pid})`);
  console.log('[ingest:start] 카메라 재등록 중…');
  for (const [id, info] of Object.entries(result.cameras || {})) {
    if (info.ok) console.log(`[ingest:start]   ✓ 재등록: ${id.slice(0, 8)}  vPort=${info.videoPort ?? '-'} aPort=${info.audioPort ?? '-'}`);
    else console.warn(`[ingest:start]   ✗ 재등록 실패 ${id.slice(0, 8)}: ${info.error || `HTTP ${info.status}`}`);
  }
  console.log(`[ingest:start] 완료. 로그 확인: ${cfg.daemonLog}`);
})();
