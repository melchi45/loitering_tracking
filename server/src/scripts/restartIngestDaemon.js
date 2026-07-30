#!/usr/bin/env node
'use strict';

/**
 * restartIngestDaemon.js — 실행 중인 ingest daemon(들)만 재시작.
 *
 * 1. 기존 daemon 프로세스 종료 (포트 점유 여부 실제 bind 테스트로 확인, §6.35/§6.36)
 * 2. 새 daemon 시작 (백그라운드, stdout/stderr 로그 출력)
 * 3. /health 엔드포인트로 기동 확인 (최대 10초)
 * 4. 서버의 /api/internal/ingest/reregister를 통해 카메라 재등록
 *
 * 핵심 로직은 server/src/services/ingestDaemonControl.js에 있다 — 이 파일과
 * startIngestDaemon.js/stopIngestDaemon.js는 모두 그 모듈을 감싸는 얇은 CLI
 * 래퍼다. `POST /admin/ingest/restart`(Admin Dashboard API)도 동일 모듈의
 * restartDaemon()을 호출하므로, 여기서 고치는 버그는 API 쪽에도 자동 적용된다.
 *
 * 멀티 프로세스 ingest-daemon 플릿(2026-07-28, §6.45) — INGEST_DAEMON_INSTANCES
 * 로 나뉜 여러 인스턴스 중 특정 하나만 재시작하려면 --instance=<n>을 지정한다.
 * 생략 시 기존과 동일하게 전체(단일 배포에서는 그 하나)를 재시작한다.
 *
 * Usage:
 *   cd server && npm run ingest:restart
 *   cd server && npm run ingest:restart -- --dry-run       # 시작/등록 없이 설정만 출력
 *   cd server && npm run ingest:restart -- --instance=1     # 특정 인스턴스만 재시작
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

const { getConfig, restartDaemon } = require('../services/ingestDaemonControl');
const ingestDaemonPool = require('../services/ingestDaemonPool');

const configs = instanceIndex !== undefined
  ? [getConfig(instanceIndex)]
  : ingestDaemonPool.getAllInstanceConfigs().map((_, i) => getConfig(i));
// Only prefix log lines with "instance N: " when there's more than one to
// disambiguate, or the caller explicitly asked for one by index — the
// default single-instance deployment's log text stays exactly as before §6.45.
const showLabel = configs.length > 1 || instanceIndex !== undefined;
const label = (idx) => showLabel ? `instance ${idx}: ` : '';

console.log('[ingest:restart] ─────────────────────────────────────────');
for (const cfg of configs) {
  console.log(`[ingest:restart] ${label(cfg.instanceIndex)}Python  : ${cfg.pythonBin}`);
  console.log(`[ingest:restart] ${label(cfg.instanceIndex)}Script  : ${cfg.daemonPath}`);
  console.log(`[ingest:restart] ${label(cfg.instanceIndex)}Addr    : ${cfg.daemonAddr}`);
  console.log(`[ingest:restart] ${label(cfg.instanceIndex)}URL     : ${cfg.daemonUrl}`);
}
console.log(`[ingest:restart] Callback: ${configs[0].serverProto}://127.0.0.1:${configs[0].serverPort}`);
if (DRY_RUN) { console.log('[ingest:restart] --dry-run: 실제 실행 없이 종료'); process.exit(0); }
console.log('[ingest:restart] ─────────────────────────────────────────');

(async () => {
  console.log('[ingest:restart] 기존 daemon 종료 중…');
  console.log('[ingest:restart] 새 daemon 시작 중…');
  console.log('[ingest:restart] daemon 기동 대기 중 (최대 10초)…');

  const result = await restartDaemon(instanceIndex);
  // restartDaemon() returns a flat {ok,pid,cameras} when only one instance is
  // configured (today's exact shape) or {ok, instances:[...]} for N>1 — this
  // normalizes both into one array so the print loop below doesn't need to
  // care which shape it got.
  const perInstance = result.instances || [{ index: instanceIndex ?? 0, ...result }];

  let anyFailed = false;
  for (const r of perInstance) {
    if (!r.ok) {
      anyFailed = true;
      console.error(`[ingest:restart] ${label(r.index)}${r.error}`);
      continue;
    }
    console.log(`[ingest:restart] ${label(r.index)}daemon 준비 완료 (PID ${r.pid})`);
    console.log(`[ingest:restart] ${label(r.index)}카메라 재등록 중…`);
    for (const [id, info] of Object.entries(r.cameras || {})) {
      if (info.ok) console.log(`[ingest:restart]   ✓ 재등록 (via server): ${id.slice(0, 8)}  vPort=${info.videoPort ?? '-'} aPort=${info.audioPort ?? '-'}`);
      else console.warn(`[ingest:restart]   ✗ 재등록 실패 ${id.slice(0, 8)}: ${info.error || `HTTP ${info.status}`}`);
    }
  }
  console.log(`[ingest:restart] 완료. 로그 확인: ${configs.map(c => c.daemonLog).join(', ')}`);
  if (anyFailed) process.exit(1);
})();
