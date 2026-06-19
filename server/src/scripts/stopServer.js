'use strict';

const path = require('path');
const { execSync } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', process.env.LTS_ENV_FILE || '.env') });
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
    const cmd = `$ports = @(${ports.join(',')}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique`;
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
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        if (!/^TCP$/i.test(parts[0])) continue;

        const local = parts[1];
        const pid = parseInt(parts[parts.length - 1], 10);
        const m = local.match(/:(\d+)$/);
        if (!m) continue;
        const port = parseInt(m[1], 10);
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

function isPortFreeOnHost(port, host) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      // Some Linux hosts disable IPv6 entirely. Treat "address family not supported"
      // as neutral so IPv4 availability can still decide port state.
      if (err && (err.code === 'EAFNOSUPPORT' || err.code === 'EINVAL')) {
        resolve(true);
        return;
      }
      resolve(false);
    });
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, host);
  });
}

async function isPortFree(port) {
  const ipv4 = await isPortFreeOnHost(port, '127.0.0.1');
  const ipv6 = await isPortFreeOnHost(port, '::');
  return ipv4 && ipv6;
}

async function waitForPortsFree(ports, timeoutMs = 10000, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const results = await Promise.all(ports.map(isPortFree));
    if (results.every(Boolean)) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

// ── Kill processes by cmdline pattern (Linux/macOS only) ─────────────────────
// Uses pgrep -f to find processes matching the pattern string and sends SIGTERM.
// Returns the list of PIDs that were signalled.
function killByPattern(pattern) {
  if (process.platform === 'win32') return [];
  const pids = [];
  try {
    const out = execSync(`pgrep -f "${pattern}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    out.trim().split(/\r?\n/).forEach((line) => {
      const pid = parseInt(line.trim(), 10);
      if (!Number.isFinite(pid) || pid === process.pid) return;
      pids.push(pid);
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    });
  } catch { /* pgrep exits non-zero when no match — ignore */ }
  return pids;
}

// LTS-managed child process patterns (Linux/macOS).
// These are killed after the main Node.js server exits so that mediamtx,
// ingest-daemon, and yt-dlp/ffmpeg do not linger as orphan processes.
const LTS_CHILD_PATTERNS = [
  'mediamtx',          // MediaMTX media proxy
  'ingest_daemon.py',  // PyAV ingest daemon
];

async function main() {
  const ports = getTargetPorts();
  const pids = process.platform === 'win32' ? getPidsOnWindows(ports) : getPidsOnUnix(ports);

  if (pids.length === 0) {
    console.log(`[Stop] No listening process found on ports: ${ports.join(', ')}`);
  } else {
    console.log(`[Stop] Stopping PIDs on ports ${ports.join(', ')}: ${pids.join(', ')}`);
    killPids(pids);

    const freed = await waitForPortsFree(ports);
    if (freed) {
      console.log('[Stop] Server stopped — ports released');
    } else {
      console.warn('[Stop] Timeout waiting for ports to be released — forcing SIGKILL');
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }
      await waitForPortsFree(ports, 3000);
    }
  }

  // Kill LTS child processes that may outlive the Node.js server.
  // These are spawned by startServer.js and should have exited with it, but
  // if the server was SIGKILL'd they become orphans.
  if (process.platform !== 'win32') {
    const extra = [];
    for (const pattern of LTS_CHILD_PATTERNS) {
      const killed = killByPattern(pattern);
      extra.push(...killed);
    }
    if (extra.length > 0) {
      console.log(`[Stop] Killed orphan LTS processes (PIDs: ${extra.join(', ')})`);
      // Give them 3 s to exit cleanly, then SIGKILL any survivors.
      await new Promise(r => setTimeout(r, 3000));
      for (const pid of extra) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  }

  console.log('[Stop] Done');
}

main().catch((err) => { console.error('[Stop] Error:', err.message); process.exit(1); });
