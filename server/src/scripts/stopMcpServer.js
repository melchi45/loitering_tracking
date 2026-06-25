'use strict';

/**
 * stopMcpServer.js — 실행 중인 MCP HTTP 서버를 종료.
 *
 * Usage:
 *   cd server && npm run mcp:stop
 *
 * 환경 변수:
 *   MCP_PORT   MCP 서버 포트 (기본 3002)
 */

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

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
} catch (_) {}

const MCP_PORT = parseInt(process.env.MCP_PORT || '3002', 10);

function getPidsOnPort(port) {
  const pids = new Set();
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      out.split(/\r?\n/).forEach((l) => { const n = parseInt(l.trim(), 10); if (Number.isFinite(n)) pids.add(n); });
    } catch (_) {}
  } else {
    for (const cmd of [`lsof -ti tcp:${port} -sTCP:LISTEN`, `lsof -ti :${port}`]) {
      try {
        const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        out.split(/\r?\n/).forEach((l) => { const n = parseInt(l.trim(), 10); if (Number.isFinite(n)) pids.add(n); });
        if (pids.size > 0) break;
      } catch (_) {}
    }
    // pgrep 방식 보조 — mcp-server/index.js 패턴으로 추가 탐색
    try {
      const out = execSync('pgrep -f "mcp-server/index.js"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      out.split(/\r?\n/).forEach((l) => { const n = parseInt(l.trim(), 10); if (Number.isFinite(n) && n !== process.pid) pids.add(n); });
    } catch (_) {}
  }
  return Array.from(pids);
}

function isPortFreeOnHost(port, host) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (e) => {
      if (e.code === 'EAFNOSUPPORT' || e.code === 'EINVAL') { resolve(true); return; }
      resolve(false);
    });
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, host);
  });
}

async function waitForPortFree(port, timeoutMs = 8_000, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [v4, v6] = await Promise.all([
      isPortFreeOnHost(port, '127.0.0.1'),
      isPortFreeOnHost(port, '::'),
    ]);
    if (v4 && v6) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

async function main() {
  const pids = getPidsOnPort(MCP_PORT);

  if (pids.length === 0) {
    console.log(`[mcp:stop] :${MCP_PORT}에서 실행 중인 MCP 서버가 없습니다.`);
    return;
  }

  console.log(`[mcp:stop] MCP 서버 종료 중 (포트 ${MCP_PORT}, PIDs: ${pids.join(', ')})…`);

  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (_) {}
  }

  const freed = await waitForPortFree(MCP_PORT);
  if (freed) {
    console.log('[mcp:stop] MCP 서버 종료 완료');
  } else {
    console.warn('[mcp:stop] 포트 해제 대기 시간 초과 — SIGKILL 시도');
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch (_) {}
    }
    await waitForPortFree(MCP_PORT, 3_000);
    console.log('[mcp:stop] 완료');
  }
}

main().catch((e) => { console.error('[mcp:stop] 오류:', e.message); process.exit(1); });
