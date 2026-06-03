'use strict';

/**
 * Server health-check script.
 * Usage: node src/scripts/healthCheck.js [BASE_URL]
 * Default BASE_URL: http://localhost:3080
 *
 * Checks:
 *   1. /api/cameras           — DB + pipeline status
 *   2. /api/webrtc/ice-config — STUN/TURN config from .env
 *   3. /api/capabilities      — AI model / service status
 *   4. mediasoup UDP ports    — 40000-49999 reachable via SS/netstat
 */

const http = require('http');

const BASE = (process.argv[2] || 'http://localhost:3080').replace(/\/$/, '');

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

function ok(msg)   { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}·${RESET} ${msg}`); }

function get(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}${path}`;
    http.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function checkPorts() {
  const { execSync } = require('child_process');
  try {
    // ss -u -l -n lists UDP listening sockets; grep mediasoup port range
    const out = execSync('ss -u -l -n 2>/dev/null || netstat -u -l -n 2>/dev/null', { timeout: 3000 }).toString();
    const portRe = /:(4[0-9]{4})\b/g;
    const ports = new Set();
    let m;
    while ((m = portRe.exec(out)) !== null) {
      const p = parseInt(m[1]);
      if (p >= 40000 && p <= 49999) ports.add(p);
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return null;
  }
}

async function main() {
  console.log(`\n${BOLD}=== LTS Server Health Check ===${RESET}`);
  console.log(`  Target: ${CYAN}${BASE}${RESET}\n`);

  let allOk = true;

  // ── 1. Camera list ────────────────────────────────────────────────────────
  console.log(`${BOLD}[1] Cameras & Pipeline Status${RESET}`);
  try {
    const { status, data } = await get('/api/cameras');
    if (status !== 200 || !data.success) {
      fail(`GET /api/cameras → HTTP ${status}`);
      allOk = false;
    } else {
      const cams = data.data || [];
      ok(`${cams.length} camera(s) in database`);
      if (cams.length === 0) {
        warn('No cameras registered — add a camera first');
      } else {
        for (const c of cams) {
          const ps = c.pipelineStatus;
          const webrtc = c.webrtcEnabled ? 'WebRTC ON' : 'WebRTC OFF';
          const running = ps && ps.running;
          const label = running ? `${GREEN}running${RESET}` : `${YELLOW}stopped${RESET}`;
          info(`${c.name} (${(c.id || '').slice(0, 8)}) — ${label} — ${webrtc}`);
          if (ps && ps.ffmpegRetries > 0) {
            warn(`  ffmpeg retried ${ps.ffmpegRetries}× (RTSP instability?)`);
          }
        }
      }
    }
  } catch (err) {
    fail(`GET /api/cameras — ${err.message} (server not running?)`);
    allOk = false;
  }

  // ── 2. WebRTC ICE config ─────────────────────────────────────────────────
  console.log(`\n${BOLD}[2] WebRTC ICE Config${RESET}`);
  try {
    const { status, data } = await get('/api/webrtc/ice-config');
    if (status !== 200) {
      fail(`GET /api/webrtc/ice-config → HTTP ${status}`);
      allOk = false;
    } else {
      const { stunUrls = [], turns = [] } = data;
      ok(`${stunUrls.length} STUN server(s)`);
      for (const u of stunUrls) info(`STUN: ${u}`);

      if (turns.length === 0) {
        warn('No TURN servers configured — WebRTC may fail outside LAN');
      } else {
        ok(`${turns.length} TURN server(s)`);
        for (const t of turns) info(`TURN: ${t.url}  user=${t.username}`);
      }
    }
  } catch (err) {
    fail(`GET /api/webrtc/ice-config — ${err.message}`);
    allOk = false;
  }

  // ── 3. AI capabilities ────────────────────────────────────────────────────
  console.log(`\n${BOLD}[3] AI Capabilities${RESET}`);
  try {
    const { status, data } = await get('/api/capabilities');
    if (status !== 200) {
      fail(`GET /api/capabilities → HTTP ${status}`);
      allOk = false;
    } else {
      // Response: { ai: { human: bool, … }, status: { human: 'builtin'|'loaded'|… } }
      const statusMap = (typeof data.status === 'object' && data.status !== null)
        ? data.status
        : {};
      const counts = { loaded: 0, builtin: 0, available: 0, missing: 0, failed: 0, pending: 0 };
      for (const [key, s] of Object.entries(statusMap)) {
        counts[s] = (counts[s] || 0) + 1;
        if (s === 'failed') { fail(`${key}: ${s}`); allOk = false; }
        if (s === 'missing') warn(`${key}: missing model — run: npm run download-models`);
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      ok(`${total} AI module(s) — loaded:${counts.loaded} builtin:${counts.builtin} available:${counts.available} pending:${counts.pending} missing:${counts.missing}`);
    }
  } catch (err) {
    warn(`GET /api/capabilities — ${err.message}`);
  }

  // ── 4. mediasoup UDP ports ────────────────────────────────────────────────
  console.log(`\n${BOLD}[4] mediasoup UDP Ports (40000-49999)${RESET}`);
  const ports = checkPorts();
  if (ports === null) {
    warn('Could not check UDP ports (ss/netstat not available)');
  } else if (ports.length === 0) {
    warn('No mediasoup UDP ports listening — WebRTC transport not yet created (normal before first viewer)');
  } else {
    ok(`${ports.length} UDP port(s) open: ${ports.slice(0, 5).join(', ')}${ports.length > 5 ? ' …' : ''}`);
  }

  // ── 5. SERVER_IP env sanity ──────────────────────────────────────────────
  console.log(`\n${BOLD}[5] Environment Sanity${RESET}`);
  try {
    // Fetch ice-config again to derive SERVER_IP from announced STUN/TURN
    const { data } = await get('/api/webrtc/ice-config');
    const turns = data.turns || [];
    if (turns.length > 0) {
      const firstTurnHost = turns[0].url.replace(/^turn:/, '').split(':')[0];
      info(`Primary TURN host: ${firstTurnHost}`);
    }
    // Simple reachability check: can we talk to the server?
    ok(`Server at ${BASE} is reachable`);
  } catch {
    /* already reported */
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}=== Result ===${RESET}`);
  if (allOk) {
    console.log(`${GREEN}${BOLD}  All checks passed.${RESET}\n`);
  } else {
    console.log(`${RED}${BOLD}  Some checks FAILED — see above.${RESET}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
