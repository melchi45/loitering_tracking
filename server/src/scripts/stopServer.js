'use strict';

const path = require('path');
const { execSync } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
} catch {
  // Allow stop script to run even when dependencies are partially missing.
}

function parsePort(value, fallback) {
  const n = parseInt(value || String(fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

function unique(nums) {
  return Array.from(new Set(nums.filter((n) => Number.isFinite(n) && n > 0)));
}

function getTargetPorts() {
  const httpPort = parsePort(process.env.HTTP_PORT, 3080);
  const httpsPort = parsePort(process.env.HTTPS_PORT, 3443);
  return unique([httpPort, httpsPort]);
}

function getPidsOnWindows(ports) {
  const pids = new Set();

  // Prefer Get-NetTCPConnection, fallback to netstat parsing.
  try {
    const cmd = `Get-NetTCPConnection -LocalPort ${ports.join(',')} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
    const out = execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    out.split(/\r?\n/).forEach((line) => {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n)) pids.add(n);
    });
  } catch {
    // no-op; fallback below
  }

  if (pids.size === 0) {
    try {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*TCP\s+[^\s]+:(\d+)\s+[^\s]+\s+LISTENING\s+(\d+)\s*$/i);
        if (!m) continue;
        const port = parseInt(m[1], 10);
        const pid = parseInt(m[2], 10);
        if (ports.includes(port) && Number.isFinite(pid)) pids.add(pid);
      }
    } catch {
      // ignore
    }
  }

  return Array.from(pids);
}

function getPidsOnUnix(ports) {
  const pids = new Set();
  for (const port of ports) {
    // Try lsof with -sTCP:LISTEN (standard)
    for (const cmd of [
      `lsof -ti tcp:${port} -sTCP:LISTEN`,
      `lsof -ti :${port}`,               // fallback: no TCP filter (catches IPv6 :::port)
    ]) {
      try {
        const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        out.split(/\r?\n/).forEach((line) => {
          const n = parseInt(line.trim(), 10);
          if (Number.isFinite(n)) pids.add(n);
        });
        if (pids.size > 0) break; // found with first command, no need for fallback
      } catch {
        // ignore per-command failures
      }
    }
  }
  return Array.from(pids);
}

function killPids(pids) {
  if (pids.length === 0) return;
  if (process.platform === 'win32') {
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {
        // ignore failures for already-dead PIDs
      }
    }
    return;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore failures for already-dead PIDs
    }
  }
}

function main() {
  const ports = getTargetPorts();
  const pids = process.platform === 'win32' ? getPidsOnWindows(ports) : getPidsOnUnix(ports);

  if (pids.length === 0) {
    console.log(`[Stop] No listening process found on ports: ${ports.join(', ')}`);
    return;
  }

  console.log(`[Stop] Stopping PIDs on ports ${ports.join(', ')}: ${pids.join(', ')}`);
  killPids(pids);
  console.log('[Stop] Done');
}

main();
