#!/usr/bin/env node
'use strict';

/**
 * stopIngestDaemon.js — ingest daemon 종료.
 *
 * 포트 점유 여부(실제 bind 시도, §6.36)로 실행 중인지 판단 — 과거에는
 * `/health` 응답만으로 판단해 "좀비" 상태(프로세스는 살아있지만 HTTP API가
 * 무응답)를 "실행 중 아님"으로 오판해 kill 로직 자체를 건너뛰는 버그가 있었다
 * (Design_Ingest_Daemon_Control.md §2.2). 핵심 로직은
 * server/src/services/ingestDaemonControl.js — 이 파일은 .env 로드 + CLI
 * 출력만 담당하는 얇은 래퍼.
 *
 * Usage:
 *   cd server && npm run ingest:stop
 */

const path = require('path');
const fs   = require('fs');

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

const { getConfig, stopDaemon } = require('../services/ingestDaemonControl');
const cfg = getConfig();

(async () => {
  const result = await stopDaemon();

  if (!result.wasRunning) {
    console.log(`[ingest:stop] daemon이 실행 중이지 않습니다 (${cfg.daemonUrl}).`);
    process.exit(0);
  }

  console.log('[ingest:stop] daemon 종료 중…');
  if (!result.ok) {
    console.warn(`[ingest:stop] ${result.error}`);
    process.exit(1);
  }
  console.log('[ingest:stop] daemon 종료 완료.');
})();
