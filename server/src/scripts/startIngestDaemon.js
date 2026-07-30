#!/usr/bin/env node
'use strict';

/**
 * startIngestDaemon.js — ingest daemon(들) 최초 시작 (기존 프로세스 종료 없음).
 *
 * 이미 daemon이 실행 중이면(포트 점유 여부로 판단, §6.36 참고) 아무것도
 * 하지 않고 종료한다. 핵심 로직은 server/src/services/ingestDaemonControl.js
 * 에 있다 — 이 파일은 .env 로드 + CLI 출력만 담당하는 얇은 래퍼.
 *
 * 멀티 프로세스 ingest-daemon 플릿(2026-07-28, §6.45) — 특정 인스턴스만
 * 시작하려면 --instance=<n>을 지정한다. 생략 시 설정된 전체 인스턴스를 시작한다
 * (단일 배포에서는 지금까지와 동일하게 그 하나만).
 *
 * Usage:
 *   cd server && npm run ingest:start
 *   cd server && npm run ingest:start -- --dry-run
 *   cd server && npm run ingest:start -- --instance=1
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
const _instanceArg  = process.argv.find(a => a.startsWith('--instance='));
const instanceIndex = _instanceArg ? parseInt(_instanceArg.split('=')[1], 10) : undefined;

// getConfig() reads process.env, so require this only after the .env load above.
const { getConfig, startDaemon } = require('../services/ingestDaemonControl');
const ingestDaemonPool = require('../services/ingestDaemonPool');

const configs = instanceIndex !== undefined
  ? [getConfig(instanceIndex)]
  : ingestDaemonPool.getAllInstanceConfigs().map((_, i) => getConfig(i));
// Only prefix log lines with "instance N: " when there's more than one to
// disambiguate, or the caller explicitly asked for one by index — the
// default single-instance deployment's log text stays exactly as before §6.45.
const showLabel = configs.length > 1 || instanceIndex !== undefined;
const label = (idx) => showLabel ? `instance ${idx}: ` : '';

console.log('[ingest:start] ──────────────────────────────────────────');
for (const cfg of configs) {
  console.log(`[ingest:start] ${label(cfg.instanceIndex)}Python  : ${cfg.pythonBin}`);
  console.log(`[ingest:start] ${label(cfg.instanceIndex)}Script  : ${cfg.daemonPath}`);
  console.log(`[ingest:start] ${label(cfg.instanceIndex)}Addr    : ${cfg.daemonAddr}`);
  console.log(`[ingest:start] ${label(cfg.instanceIndex)}URL     : ${cfg.daemonUrl}`);
}
console.log(`[ingest:start] Callback: ${configs[0].serverProto}://127.0.0.1:${configs[0].serverPort}`);
if (DRY_RUN) { console.log('[ingest:start] --dry-run: 실제 실행 없이 종료'); process.exit(0); }
console.log('[ingest:start] ──────────────────────────────────────────');

(async () => {
  console.log('[ingest:start] daemon 시작 중…');
  const result = await startDaemon(instanceIndex);
  // See restartIngestDaemon.js's comment — normalizes the flat (N=1) and
  // wrapped (N>1) shapes returned by ingestDaemonControl's start/stop/restart
  // functions into one array so this print loop handles both identically.
  const perInstance = result.instances || [{ index: instanceIndex ?? 0, ...result }];

  let anyFailed = false;
  for (const r of perInstance) {
    if (r.alreadyRunning) {
      console.log(`[ingest:start] ${label(r.index)}daemon이 이미 실행 중입니다. 중지하려면 npm run ingest:stop`);
      continue;
    }
    if (!r.ok) {
      anyFailed = true;
      console.error(`[ingest:start] ${label(r.index)}${r.error}`);
      continue;
    }
    console.log(`[ingest:start] ${label(r.index)}daemon 준비 완료 (PID ${r.pid})`);
    console.log(`[ingest:start] ${label(r.index)}카메라 재등록 중…`);
    for (const [id, info] of Object.entries(r.cameras || {})) {
      if (info.ok) console.log(`[ingest:start]   ✓ 재등록: ${id.slice(0, 8)}  vPort=${info.videoPort ?? '-'} aPort=${info.audioPort ?? '-'}`);
      else console.warn(`[ingest:start]   ✗ 재등록 실패 ${id.slice(0, 8)}: ${info.error || `HTTP ${info.status}`}`);
    }
  }
  console.log(`[ingest:start] 완료. 로그 확인: ${configs.map(c => c.daemonLog).join(', ')}`);
  if (anyFailed) process.exit(1);
})();
