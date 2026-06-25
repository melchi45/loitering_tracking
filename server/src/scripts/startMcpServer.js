'use strict';

/**
 * startMcpServer.js — MCP 서버를 HTTP/SSE 모드로 백그라운드에서 시작.
 *
 * Usage:
 *   cd server && npm run mcp:start
 *   cd server && npm run mcp:start -- --dry-run
 *
 * 환경 변수 (server/.env):
 *   MCP_PORT          HTTP 포트 (기본 3002)
 *   MCP_AUTH_TOKEN    Bearer 인증 토큰 (비어 있으면 인증 없음)
 *   LTS_BASE_URL      LTS 서버 URL (기본 http://localhost:3080)
 *   NODE_EXEC_LINUX   사용할 node 실행 파일 경로 (기본 /usr/bin/node)
 */

const path = require('path');
const fs   = require('fs');
const net  = require('net');
const http = require('http');
const { spawn } = require('child_process');

// ── .env 로드 ────────────────────────────────────────────────────────────────
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
} catch (_) { /* .env 없으면 process.env 그대로 사용 */ }

const DRY_RUN  = process.argv.includes('--dry-run');
const MCP_PORT = parseInt(process.env.MCP_PORT || '3002', 10);
const MCP_LOG  = process.env.MCP_SERVER_LOG || '/tmp/mcp-server.log';

// server/ 기준 → mcp-server/index.js 절대 경로
const SERVER_DIR = path.resolve(__dirname, '../..');
const MCP_ENTRY  = path.resolve(SERVER_DIR, '..', 'mcp-server', 'index.js');

function resolveNodeExec() {
  if (process.env.NODE_EXEC && process.env.NODE_EXEC.trim()) return process.env.NODE_EXEC.trim();
  return process.platform === 'win32'
    ? (process.env.NODE_EXEC_WINDOWS || 'node').trim()
    : (process.env.NODE_EXEC_LINUX   || '/usr/bin/node').trim();
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout',  () => { sock.destroy(); resolve(false); });
    sock.on('error',    () => resolve(false));
    sock.connect(port, '127.0.0.1');
  });
}

async function waitForReady(port, maxMs = 8_000, pollMs = 300) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(
          { hostname: '127.0.0.1', port, path: '/schema', timeout: 800 },
          (res) => { res.resume(); resolve(res.statusCode < 500); }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

async function main() {
  const nodeExec = resolveNodeExec();

  console.log('[mcp:start] ─────────────────────────────────────────');
  console.log(`[mcp:start] Entry : ${MCP_ENTRY}`);
  console.log(`[mcp:start] Port  : ${MCP_PORT}`);
  console.log(`[mcp:start] Log   : ${MCP_LOG}`);
  console.log(`[mcp:start] Node  : ${nodeExec}`);
  if (DRY_RUN) { console.log('[mcp:start] --dry-run: 실제 실행 없이 종료'); process.exit(0); }
  console.log('[mcp:start] ─────────────────────────────────────────');

  if (!fs.existsSync(MCP_ENTRY)) {
    console.error(`[mcp:start] mcp-server entry not found: ${MCP_ENTRY}`);
    process.exit(1);
  }

  const alreadyRunning = await isPortOpen(MCP_PORT);
  if (alreadyRunning) {
    console.log(`[mcp:start] MCP 서버가 이미 :${MCP_PORT}에서 실행 중입니다.`);
    process.exit(0);
  }

  const childEnv = {
    ...process.env,
    TRANSPORT: 'http',
  };

  const logFd = fs.openSync(MCP_LOG, 'a');
  const child = spawn(nodeExec, [MCP_ENTRY], {
    stdio: ['ignore', logFd, logFd],
    env: childEnv,
    cwd: path.dirname(MCP_ENTRY),
    detached: true,
  });
  child.on('error', (e) => {
    console.error(`[mcp:start] 시작 실패: ${e.message}`);
    process.exit(1);
  });
  child.unref();
  fs.closeSync(logFd);

  console.log(`[mcp:start] MCP 서버 시작 중 (PID ${child.pid})…`);

  const ready = await waitForReady(MCP_PORT);
  if (ready) {
    console.log(`[mcp:start] MCP 서버 준비 완료 — http://localhost:${MCP_PORT}/sse`);
    console.log(`[mcp:start] 로그 확인: tail -f ${MCP_LOG}`);
  } else {
    console.warn(`[mcp:start] ${MCP_PORT}포트가 8초 내에 응답하지 않습니다. 로그를 확인하세요.`);
    console.warn(`[mcp:start]   tail -f ${MCP_LOG}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('[mcp:start] 오류:', e.message); process.exit(1); });
