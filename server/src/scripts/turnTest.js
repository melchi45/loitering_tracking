'use strict';

/**
 * LTS TURN Server Relay Test
 *
 * Phase A — Allocation:  verifies credentials + reachability (TURN allocates a relay address)
 * Phase B — Relay:       two-context test (localhost ↔ LAN IP) when SERVER_IP is set,
 *                        otherwise same-machine hairpin test (may be inconclusive)
 *
 * Usage:
 *   node src/scripts/turnTest.js [SERVER_URL] [--headless]
 *
 * Defaults:
 *   SERVER_URL = http://localhost:3080
 *
 * Examples:
 *   node src/scripts/turnTest.js
 *   node src/scripts/turnTest.js http://192.168.214.3:3001
 *   node src/scripts/turnTest.js http://localhost:3080 --headless
 */

const http = require('http');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
} catch { /* dotenv optional */ }

const args      = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const _serverIp = process.env.SERVER_IP || 'localhost';
const _port     = process.env.HTTP_PORT || process.env.PORT || '3080';
const SERVER    = (args[0] || `http://${_serverIp}:${_port}`).replace(/\/$/, '');
const HEADLESS  = process.argv.includes('--headless') || !process.env.DISPLAY;

// Two-context relay: pageA uses loopback, pageB uses LAN IP (different source path to TURN)
const URL_A = `http://localhost:${_port}`;
const URL_B = (_serverIp && _serverIp !== 'localhost' && _serverIp !== '127.0.0.1')
  ? `http://${_serverIp}:${_port}`
  : null; // null → fall back to same-machine hairpin test

const TURN_CONNECT_MS = 20_000;

const CHROME_PATH = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/local/bin/chromium',
].find(p => { try { require('fs').accessSync(p); return true; } catch { return false; } });

// ── ANSI colors ────────────────────────────────────────────────────────────
const R  = '\x1b[0m';
const B  = '\x1b[1m';
const G  = '\x1b[32m';
const Y  = '\x1b[33m';
const RE = '\x1b[31m';
const C  = '\x1b[36m';

function ok(m)   { console.log(`  ${G}✓${R} ${m}`); }
function warn(m) { console.log(`  ${Y}!${R} ${m}`); }
function fail(m) { console.log(`  ${RE}✗${R} ${m}`); }
function info(m) { console.log(`  ${C}·${R} ${m}`); }
function hdr(m)  { console.log(`\n${B}${m}${R}`); }

// ── HTTP helper ────────────────────────────────────────────────────────────
function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${SERVER}${urlPath}`, { timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, data: b }); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ── Phase A: TURN Allocation Test ─────────────────────────────────────────
// Verifies that the TURN server is reachable, credentials are valid, and a
// relay address is successfully allocated. Does NOT test data relay.
async function testTurnAllocation(page, turn, timeoutMs = 8000) {
  return page.evaluate(async ({ turn, timeoutMs }) => {
    return new Promise((resolve) => {
      const cfg = {
        iceServers: [{ urls: turn.url, username: turn.username, credential: turn.credential }],
        iceTransportPolicy: 'relay',
      };
      const pc = new RTCPeerConnection(cfg);
      let relayCandidate = null;
      let settled = false;
      const timer = setTimeout(() => done('timeout'), timeoutMs);

      function done(status) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { pc.close(); } catch {}
        resolve({ status, relayCandidate });
      }

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && candidate.type === 'relay') {
          relayCandidate = `${candidate.protocol} ${candidate.address}:${candidate.port}`;
          done('allocated');
        }
        if (candidate === null && !relayCandidate) done('no-relay');
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && !relayCandidate) done('no-relay');
      };

      pc.createDataChannel('alloc-test');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch((e) => done(`sdp-error: ${e.message}`));
    });
  }, { turn, timeoutMs });
}

// ── Phase B-i: TURN Relay — Two-Context Test ──────────────────────────────
// Opens two separate browser contexts: pageA at localhost (loopback source IP)
// and pageB at LAN IP. Different source IPs avoid coturn same-server hairpin
// blocking. Playwright acts as the out-of-band signaling broker.
async function testTurnRelayTwoContexts(browser, turn, urlA, urlB) {
  const iceCfg = {
    iceServers: [{ urls: turn.url, username: turn.username, credential: turn.credential }],
    iceTransportPolicy: 'relay',
  };
  const events = [];

  const ctxA  = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const ctxB  = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await pageA.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await pageB.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 10_000 });

    // Initialize relay-only RTCPeerConnection on each page
    const initPeer = (page, cfg) => page.evaluate((cfg) => {
      window.__rtcState = {
        pc:                new RTCPeerConnection(cfg),
        pendingCandidates: [],
        connState:         'new',
        iceState:          'new',
      };
      const s = window.__rtcState;
      s.pc.onicecandidate = ({ candidate }) => {
        if (candidate) s.pendingCandidates.push(candidate.toJSON());
      };
      s.pc.addEventListener('connectionstatechange', () => {
        s.connState = s.pc.connectionState;
      });
      s.pc.addEventListener('iceconnectionstatechange', () => {
        s.iceState = s.pc.iceConnectionState;
      });
    }, cfg);

    await initPeer(pageA, iceCfg);
    await initPeer(pageB, iceCfg);

    // pageA creates data channel + offer
    const offer = await pageA.evaluate(async () => {
      const s = window.__rtcState;
      s.pc.createDataChannel('turn-relay-two-ctx');
      const o = await s.pc.createOffer();
      await s.pc.setLocalDescription(o);
      return JSON.parse(JSON.stringify(s.pc.localDescription));
    });
    events.push(`offer created (${offer.sdp.length}B SDP)`);

    // pageB receives offer, creates answer
    const answer = await pageB.evaluate(async (offer) => {
      const s = window.__rtcState;
      await s.pc.setRemoteDescription(offer);
      const a = await s.pc.createAnswer();
      await s.pc.setLocalDescription(a);
      return JSON.parse(JSON.stringify(s.pc.localDescription));
    }, offer);
    events.push('answer created');

    // pageA receives answer
    await pageA.evaluate(async (answer) => {
      await window.__rtcState.pc.setRemoteDescription(answer);
    }, answer);
    events.push('SDP exchange complete — relaying ICE candidates');

    // Poll-loop: cross-inject ICE candidates until connected or timeout
    const deadline = Date.now() + TURN_CONNECT_MS;
    let connState  = 'new';

    while (Date.now() < deadline) {
      // pageA → pageB
      const candsA = await pageA.evaluate(() => window.__rtcState.pendingCandidates.splice(0));
      for (const c of candsA) {
        const parts = (c.candidate || '').split(' ');
        events.push(`A→B: ${parts[7] || '?'} ${parts[2] || '?'} ${parts[4] || '?'}:${parts[5] || '?'}`);
        await pageB.evaluate((c) => window.__rtcState.pc.addIceCandidate(c).catch(() => {}), c);
      }

      // pageB → pageA
      const candsB = await pageB.evaluate(() => window.__rtcState.pendingCandidates.splice(0));
      for (const c of candsB) {
        const parts = (c.candidate || '').split(' ');
        events.push(`B→A: ${parts[7] || '?'} ${parts[2] || '?'} ${parts[4] || '?'}:${parts[5] || '?'}`);
        await pageA.evaluate((c) => window.__rtcState.pc.addIceCandidate(c).catch(() => {}), c);
      }

      connState = await pageA.evaluate(() => window.__rtcState.connState);
      if (connState === 'connected' || connState === 'failed') break;

      await new Promise((r) => setTimeout(r, 200));
    }

    const status = connState === 'connected' ? 'connected'
                 : connState === 'failed'    ? 'failed'
                 :                             'timeout';
    return { status, events };
  } finally {
    await pageA.evaluate(() => { try { window.__rtcState?.pc?.close(); } catch {} }).catch(() => {});
    await pageB.evaluate(() => { try { window.__rtcState?.pc?.close(); } catch {} }).catch(() => {});
    await ctxA.close();
    await ctxB.close();
  }
}

// ── Phase B-ii: TURN Relay — Same-Machine Fallback ────────────────────────
// Both peers in the same page/context. coturn may block same-server hairpin,
// so failure here is expected and does NOT indicate a TURN misconfiguration.
async function testTurnRelaySameMachine(page, turn) {
  return page.evaluate(async ({ turn, timeoutMs }) => {
    return new Promise((resolve) => {
      const iceServers = [{
        urls:       turn.url,
        username:   turn.username,
        credential: turn.credential,
      }];
      const cfg = { iceServers, iceTransportPolicy: 'relay' };

      const pc1 = new RTCPeerConnection(cfg);
      const pc2 = new RTCPeerConnection(cfg);

      const events = [];
      let settled  = false;
      const timer  = setTimeout(() => done('timeout'), timeoutMs);

      function done(status) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { pc1.close(); } catch {}
        try { pc2.close(); } catch {}
        resolve({ status, events });
      }

      pc1.onicecandidate = ({ candidate }) => {
        if (candidate) {
          events.push(`pc1→pc2: ${candidate.type} ${candidate.protocol} ${candidate.address}:${candidate.port}`);
          pc2.addIceCandidate(candidate).catch(() => {});
        }
      };
      pc2.onicecandidate = ({ candidate }) => {
        if (candidate) {
          events.push(`pc2→pc1: ${candidate.type} ${candidate.protocol} ${candidate.address}:${candidate.port}`);
          pc1.addIceCandidate(candidate).catch(() => {});
        }
      };
      pc1.addEventListener('connectionstatechange', () => {
        events.push(`pc1 conn→${pc1.connectionState}`);
        if (pc1.connectionState === 'connected') done('connected');
        if (pc1.connectionState === 'failed')    done('failed');
      });
      pc1.addEventListener('iceconnectionstatechange', () => {
        events.push(`pc1 ice→${pc1.iceConnectionState}`);
      });

      pc1.createDataChannel('turn-relay-test');
      pc1.createOffer()
        .then((offer) => pc1.setLocalDescription(offer).then(() => pc2.setRemoteDescription(offer)))
        .then(() => pc2.createAnswer())
        .then((answer) => pc2.setLocalDescription(answer).then(() => pc1.setRemoteDescription(answer)))
        .catch((e) => { events.push(`SDP error: ${e.message}`); done('sdp-error'); });
    });
  }, { turn, timeoutMs: TURN_CONNECT_MS });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${B}=== LTS TURN Server Relay Test ===${R}`);
  console.log(`  Server : ${C}${SERVER}${R}`);
  console.log(`  Mode   : ${HEADLESS ? 'headless' : 'headed'}`);
  if (URL_B) {
    console.log(`  Relay  : two-context (${URL_A}  ↔  ${URL_B})`);
  } else {
    console.log(`  Relay  : same-machine (set SERVER_IP=<LAN IP> for two-context test)`);
  }

  // ── Step 1: Fetch TURN config from server ──────────────────────────────
  hdr('[Step 1] Fetch TURN Configuration');
  let turns = [];
  try {
    const { status, data } = await httpGet('/api/webrtc/ice-config');
    if (status !== 200) { fail(`GET /api/webrtc/ice-config → HTTP ${status}`); process.exit(1); }
    turns = data.turns || [];
    if (turns.length === 0) {
      warn('No TURN servers configured — nothing to test');
      warn('Add TURN config in server/.env: TURN_SERVER, TURN_USER, TURN_CREDENTIAL');
      process.exit(0);
    }
    ok(`${turns.length} TURN server(s) found`);
    for (const t of turns) info(`  ${t.url}  user=${t.username}`);
  } catch (err) {
    fail(`Server not responding: ${err.message}`);
    info('  Make sure the server is running: cd server && npm run dev');
    process.exit(1);
  }

  // ── Step 2: Launch browser ─────────────────────────────────────────────
  hdr('[Step 2] Launch Browser');
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    fail('playwright is not installed');
    info('  cd server && npm install --save-dev playwright');
    process.exit(1);
  }

  const launchOpts = {
    headless: HEADLESS,
    args: [
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--use-fake-ui-for-media-stream',
      '--disable-web-security',
    ],
  };
  if (CHROME_PATH) {
    launchOpts.executablePath = CHROME_PATH;
    info(`Using system Chrome: ${CHROME_PATH}`);
  }

  const browser = await playwright.chromium.launch(launchOpts);
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const page    = await context.newPage();
  ok('Chromium launched');

  try {
    await page.goto(URL_A, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    ok(`Page loaded: ${URL_A}`);
  } catch (err) {
    fail(`UI load failed: ${err.message}`);
    info('  Make sure the server is running and the client is built: cd client && npm run build');
    await browser.close();
    process.exit(1);
  }

  // ── Step 3a: TURN Allocation Test ─────────────────────────────────────
  hdr('[Step 3a] TURN Allocation Test (credential + reachability)');
  info('Verifies TURN server is reachable and allocates a relay address.');

  const allocResults = [];
  for (const turn of turns) {
    process.stdout.write(`  ${C}·${R} ${turn.url} … `);
    const start = Date.now();
    const { status, relayCandidate } = await testTurnAllocation(page, turn);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (status === 'allocated') {
      process.stdout.write(`${G}✓ relay allocated${R}: ${relayCandidate}  (${elapsed}s)\n`);
      allocResults.push({ turn, ok: true, relayCandidate, elapsed });
    } else {
      process.stdout.write(`${RE}✗ ${status}${R}  (${elapsed}s)\n`);
      allocResults.push({ turn, ok: false, status, elapsed });
      if (status === 'no-relay') {
        info('    → Check TURN credentials or server availability');
      } else if (status === 'timeout') {
        info('    → TURN server unreachable (check port 3478 UDP/TCP)');
      }
    }
  }

  // ── Step 3b: TURN Relay Connectivity Test ─────────────────────────────
  const relayResults = [];

  if (URL_B) {
    hdr(`[Step 3b] TURN Relay Connectivity Test (two-context: localhost ↔ ${_serverIp})`);
    info(`pageA: ${URL_A}  (loopback source IP)`);
    info(`pageB: ${URL_B}  (LAN source IP)`);
    info(`Different source IPs avoid coturn same-server hairpin blocking.`);
    info(`iceTransportPolicy: 'relay' — only relay candidates allowed`);
    info(`Timeout per server: ${TURN_CONNECT_MS / 1000}s`);

    for (const turn of turns) {
      process.stdout.write(`  ${C}·${R} ${turn.url} … `);
      const start = Date.now();
      let result;
      try {
        result = await testTurnRelayTwoContexts(browser, turn, URL_A, URL_B);
      } catch (err) {
        result = { status: `error: ${err.message}`, events: [] };
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const { status, events } = result;

      if (status === 'connected') {
        process.stdout.write(`${G}✓ relay connected${R}  (${elapsed}s)\n`);
        relayResults.push({ turn, ok: true, elapsed, twoCtx: true });
      } else {
        process.stdout.write(`${RE}✗ ${status}${R}  (${elapsed}s)\n`);
        relayResults.push({ turn, ok: false, status, elapsed, twoCtx: true });
        for (const e of events.slice(-6)) info(`    ${e}`);
        if (status === 'failed') {
          info('    → relay allocated but peers failed to connect');
          info('    → check coturn relay UDP port range (min-port/max-port) and firewall');
        } else if (status === 'timeout') {
          info('    → ICE candidates exchanged but connection timed out');
          info('    → verify UDP 50000-59999 is open between clients and server');
        }
      }
    }
  } else {
    hdr('[Step 3b] TURN Relay Connectivity Test (same-machine hairpin)');
    warn('Same-machine test: both peers relay through the same TURN server.');
    warn('coturn may block same-server hairpin routing — failure here does NOT mean');
    warn('TURN relay is broken. Run from an external machine for a definitive result.');
    warn(`Set SERVER_IP=<LAN IP> in .env to enable the two-context relay test.`);
    info(`iceTransportPolicy: 'relay' — only relay candidates allowed`);
    info(`Timeout per server: ${TURN_CONNECT_MS / 1000}s`);

    for (const turn of turns) {
      process.stdout.write(`  ${C}·${R} ${turn.url} … `);
      const start = Date.now();
      const { status, events } = await testTurnRelaySameMachine(page, turn);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if (status === 'connected') {
        process.stdout.write(`${G}✓ relay connected${R}  (${elapsed}s)\n`);
        relayResults.push({ turn, ok: true, elapsed, twoCtx: false });
      } else {
        process.stdout.write(`${Y}! ${status}${R}  (${elapsed}s)\n`);
        relayResults.push({ turn, ok: false, status, elapsed, twoCtx: false });
        for (const e of events.slice(-4)) info(`    ${e}`);
      }
    }
  }

  await browser.close();

  // ── Step 4: Summary ────────────────────────────────────────────────────
  hdr('=== TURN Test Summary ===');
  const allocPassed = allocResults.filter((r) => r.ok).length;
  const relayPassed = relayResults.filter((r) => r.ok).length;
  const total       = turns.length;

  console.log(`\n  ${B}Allocation (credential + reachability):${R}`);
  for (const r of allocResults) {
    if (r.ok) ok(`${r.turn.url}  → ${r.relayCandidate}  (${r.elapsed}s)`);
    else      fail(`${r.turn.url}  — ${r.status}  (${r.elapsed}s)`);
  }

  const relayLabel = URL_B
    ? `Relay connectivity (two-context: localhost ↔ ${_serverIp}):`
    : 'Relay connectivity (same-machine hairpin):';
  console.log(`\n  ${B}${relayLabel}${R}`);
  for (const r of relayResults) {
    if (r.ok) {
      ok(`${r.turn.url}  — relay data flow confirmed  (${r.elapsed}s)`);
    } else if (r.twoCtx) {
      fail(`${r.turn.url}  — ${r.status}  (${r.elapsed}s)`);
    } else {
      warn(`${r.turn.url}  — ${r.status} (expected on same machine)  (${r.elapsed}s)`);
    }
  }

  console.log();
  if (allocPassed === total) {
    if (URL_B) {
      if (relayPassed === total) {
        console.log(`${G}${B}  PASS — All ${total} TURN server(s): allocation ✓  two-context relay ✓${R}\n`);
      } else {
        console.log(`${RE}${B}  FAIL — ${relayPassed}/${total} TURN server(s) relayed (two-context test)${R}\n`);
        info('  Allocation OK but relay failed — check relay UDP port range and firewall:');
        info('    coturn: min-port/max-port in /etc/turnserver.conf');
        info('    firewall: sudo ufw allow 50000:59999/udp');
        process.exitCode = 1;
      }
    } else {
      if (relayPassed === total) {
        console.log(`${G}${B}  PASS — All ${total} TURN server(s): allocation ✓  relay ✓${R}\n`);
      } else {
        console.log(`${G}${B}  PASS — All ${total} TURN server(s) allocated successfully${R}`);
        console.log(`${Y}${B}  NOTE — Same-machine relay test inconclusive (coturn hairpin limitation)${R}`);
        console.log(`${Y}         Set SERVER_IP=<LAN IP> in .env for a definitive two-context relay test${R}\n`);
      }
    }
  } else {
    console.log(`${RE}${B}  FAIL — ${allocPassed}/${total} TURN server(s) allocated (credential or connectivity error)${R}\n`);
    info('  Verify TURN server is running: sudo systemctl status coturn');
    info('  Check port 3478 is open: sudo ufw allow 3478/udp');
    info('  Check credentials in server/.env: TURN_USER, TURN_CREDENTIAL');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
});
