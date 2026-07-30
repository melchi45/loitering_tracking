#!/usr/bin/env node
'use strict';

/**
 * stopIngestDaemon.js — ingest daemon(들) 종료.
 *
 * 포트 점유 여부(실제 bind 시도, §6.36)로 실행 중인지 판단 — 과거에는
 * `/health` 응답만으로 판단해 "좀비" 상태(프로세스는 살아있지만 HTTP API가
 * 무응답)를 "실행 중 아님"으로 오판해 kill 로직 자체를 건너뛰는 버그가 있었다
 * (Design_Ingest_Daemon_Control.md §2.2). 핵심 로직은
 * server/src/services/ingestDaemonControl.js — 이 파일은 .env 로드 + CLI
 * 출력만 담당하는 얇은 래퍼.
 *
 * 멀티 프로세스 ingest-daemon 플릿(2026-07-28, §6.45) — 특정 인스턴스만
 * 종료하려면 --instance=<n>을 지정한다. 생략 시 설정된 전체 인스턴스를 종료한다.
 *
 * Usage:
 *   cd server && npm run ingest:stop
 *   cd server && npm run ingest:stop -- --instance=1
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

const _instanceArg  = process.argv.find(a => a.startsWith('--instance='));
const instanceIndex = _instanceArg ? parseInt(_instanceArg.split('=')[1], 10) : undefined;

const { getConfig, stopDaemon } = require('../services/ingestDaemonControl');
const ingestDaemonPool = require('../services/ingestDaemonPool');

const configs = instanceIndex !== undefined
  ? [getConfig(instanceIndex)]
  : ingestDaemonPool.getAllInstanceConfigs().map((_, i) => getConfig(i));
const showLabel = configs.length > 1 || instanceIndex !== undefined;
const label = (idx) => showLabel ? `instance ${idx}: ` : '';

(async () => {
  const result = await stopDaemon(instanceIndex);
  const perInstance = result.instances || [{ index: instanceIndex ?? 0, ...result }];

  let anyFailed = false;
  for (const r of perInstance) {
    const cfg = configs.find(c => c.instanceIndex === r.index) || configs[0];
    if (!r.wasRunning) {
      console.log(`[ingest:stop] ${label(r.index)}daemon이 실행 중이지 않습니다 (${cfg.daemonUrl}).`);
      continue;
    }
    console.log(`[ingest:stop] ${label(r.index)}daemon 종료 중…`);
    if (!r.ok) {
      anyFailed = true;
      console.warn(`[ingest:stop] ${label(r.index)}${r.error}`);
      continue;
    }
    console.log(`[ingest:stop] ${label(r.index)}daemon 종료 완료.`);
  }
  if (anyFailed) process.exit(1);
})();
