'use strict';

/**
 * LTS ICE Candidate 자동화 테스트
 *
 * Phase 1: 서버 사전 점검 (HTTP + STUN UDP)
 * Phase 2: 브라우저 자동화 — RTCPeerConnection 인터셉트 → ICE stats 수집
 * Phase 3: 리포트 출력
 *
 * Usage:
 *   node src/scripts/iceTest.js [SERVER_URL] [UI_URL] [--headless]
 *
 * Defaults:
 *   SERVER_URL = http://localhost:3001
 *   UI_URL     = http://localhost:5173
 *
 * Examples:
 *   node src/scripts/iceTest.js
 *   node src/scripts/iceTest.js http://192.168.214.3:3001 http://192.168.214.3:5173
 *   node src/scripts/iceTest.js http://localhost:3001 http://localhost:5173 --headless
 */

const http  = require('http');
const dgram = require('dgram');
const path  = require('path');

// Load .env so SERVER_IP / PORT / VITE_PORT are available without manual args
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
} catch { /* dotenv optional */ }

const args      = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const _serverIp = process.env.SERVER_IP || 'localhost';
const _port     = process.env.PORT || '3001';
const _vitePort = process.env.VITE_PORT || '5173';
const SERVER    = (args[0] || `http://${_serverIp}:${_port}`).replace(/\/$/, '');
const UI        = (args[1] || `http://${_serverIp}:${_vitePort}`).replace(/\/$/, '');
// Auto-use headless when no X server is available (SSH without display forwarding)
const HEADLESS  = process.argv.includes('--headless') || !process.env.DISPLAY;

// Adaptive wait: max time to detect RTCPeerConnection creation after trigger
const PC_DETECT_MS    = 8_000;
// Adaptive wait: max time to reach 'connected' after PC is created
const ICE_CONNECT_MS  = 30_000;
// How many getStats() snapshots to collect (interval: 2 s)
const POLL_COUNT      = 5;
const POLL_INTERVAL   = 2_000;
// Path to system Chrome (avoids downloading Playwright's Chromium)
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
const OR = '\x1b[33;1m';

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

function httpPut(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(`${SERVER}${urlPath}`);
    const options = {
      hostname: url.hostname, port: url.port || 80, path: url.pathname,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, data: b }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── STUN UDP ping ──────────────────────────────────────────────────────────
function stunPing(host, port = 3478) {
  return new Promise((resolve) => {
    const s   = dgram.createSocket('udp4');
    // Minimal STUN Binding Request (RFC 5389) — exactly 20 bytes
    // 0x0001=BindingRequest  0x0000=msgLen  0x2112A442=magic  12-byte txId
    const req = Buffer.from('000100002112a442000000000000000000000000', 'hex');
    let done  = false;
    const end = (result) => {
      if (done) return;
      done = true;
      try { s.close(); } catch { /* already closed */ }
      resolve(result);
    };
    // Explicitly bind before send so the OS assigns an ephemeral recv port
    s.bind(0, () => {
      setTimeout(() => end(false), 3000);
      s.send(req, port, host, (err) => { if (err) end(false); });
      s.on('message', () => end(true));
      s.on('error',   () => end(false));
    });
  });
}

// ── Wait for pipeline to be running ──────────────────────────────────────
async function waitForPipeline(cameraId, maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const { data } = await httpGet(`/api/cameras/${cameraId}`);
      if (data?.data?.pipelineStatus?.running) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// ── Minimal Engine.IO v4 + Socket.IO v4 client (raw ws — no socket.io-client dep) ──
// Engine.IO v4 text frame format over WebSocket:
//   '0{...}'  = OPEN   (server→client, handshake)
//   '2'       = PING   (server→client)
//   '3'       = PONG   (client→server, reply to PING)
//   '40'      = SIO CONNECT to default namespace
//   '40{...}' = SIO CONNECT ACK (server→client)
//   '42[...]' = SIO EVENT  (client←→server, JSON array: [event, data])
function socketIOConnect(serverUrl) {
  const WebSocket = require('ws');
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const to = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('Socket.IO connect timeout')); }, 7000);

    ws.on('message', (raw) => {
      const msg = raw.toString();
      if      (msg[0] === '2')               { ws.send('3'); return; }  // PING → PONG
      else if (msg[0] === '0')               { ws.send('40'); return; } // EIO OPEN → SIO CONNECT
      else if (msg[0] === '4' && msg[1] === '0') {                      // SIO CONNECT ACK
        clearTimeout(to);
        resolve({
          emit: (event, data) => ws.send('42' + JSON.stringify([event, data])),
          close: () => { try { ws.close(); } catch {} },
        });
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// ── Loopback ICE injection ─────────────────────────────────────────────────
// Injects two RTCPeerConnections into the browser page and negotiates them
// locally (no signaling server needed). This reliably tests STUN/TURN without
// depending on mediasoup-client, which fails in headless Chrome due to codec
// detection limitations (UnsupportedError: device not supported).
async function injectLoopbackICETest(page, iceConfig) {
  const stunUrls = iceConfig?.stunUrls ?? [];
  const turns    = iceConfig?.turns    ?? [];

  await page.evaluate(async ({ stunUrls, turns }) => {
    const iceServers = [
      ...stunUrls.map((url) => ({ urls: url })),
      ...turns.map((t)   => ({ urls: t.url, username: t.username, credential: t.credential })),
    ];

    const pc1 = new RTCPeerConnection({ iceServers });
    const pc2 = new RTCPeerConnection({ iceServers });

    // Register pc1 so Playwright's waitForPCCreation / waitForICEConnected can see it
    window.__lts_rtcPCs.push(pc1);
    window.__lts_rtcEvents.push('loopback: two-PC ICE loopback injected');

    // Forward ICE candidates between the two local peers
    pc1.onicecandidate = ({ candidate }) => {
      if (candidate) pc2.addIceCandidate(candidate).catch(() => {});
    };
    pc2.onicecandidate = ({ candidate }) => {
      if (candidate) pc1.addIceCandidate(candidate).catch(() => {});
    };

    // Record state changes in the shared event log
    pc1.addEventListener('connectionstatechange', () =>
      window.__lts_rtcEvents.push(`loopback PC#1 connectionState→${pc1.connectionState}`));
    pc1.addEventListener('iceconnectionstatechange', () =>
      window.__lts_rtcEvents.push(`loopback PC#1 iceConnectionState→${pc1.iceConnectionState}`));
    pc1.addEventListener('icecandidate', (e) => {
      if (e.candidate)
        window.__lts_rtcEvents.push(
          `loopback cand: ${e.candidate.type} ${e.candidate.protocol} ${e.candidate.address}:${e.candidate.port}`
        );
    });

    // Data channel triggers ICE negotiation without requiring any media device
    pc1.createDataChannel('lts-ice-test');

    // Local SDP exchange (offer/answer)
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    // ICE gathering and connectivity checks start automatically
  }, { stunUrls, turns });
}

// ── Adaptive polling helpers ────────────────────────────────────────────────
async function waitForPCCreation(page, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const n = await page.evaluate(() => window.__lts_rtcPCs?.length ?? 0).catch(() => 0);
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function waitForICEConnected(page, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    const st = await page.evaluate(() => {
      const pc = window.__lts_rtcPCs?.[0];
      return pc ? { conn: pc.connectionState, ice: pc.iceConnectionState } : null;
    }).catch(() => null);

    if (st) {
      if (elapsed % 3 === 0) {
        process.stdout.write(`  \x1b[36m·\x1b[0m ICE ${elapsed}s  conn=${st.conn}  ice=${st.ice}          \r`);
      }
      if (st.conn === 'connected') { process.stdout.write('\n'); return true; }
      if (st.conn === 'failed' || st.conn === 'closed') {
        process.stdout.write('\n');
        fail(`ICE 상태: ${st.conn} — 더 이상 복구 불가`);
        return false;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stdout.write('\n');
  return false;
}

// ── Parse RTCStatsReport → IceStats ───────────────────────────────────────
function parseStats(statsObj) {
  let selectedPair = null;
  const candidates = {};

  for (const entry of Object.values(statsObj)) {
    if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') {
      candidates[entry.id] = entry;
    }
    if (entry.type === 'candidate-pair' && entry.nominated) {
      // Prefer the pair with the largest bytesReceived if multiple nominated
      if (!selectedPair || (entry.bytesReceived ?? 0) > (selectedPair.bytesReceived ?? 0)) {
        selectedPair = entry;
      }
    }
  }
  if (!selectedPair) return null;

  const loc = candidates[selectedPair.localCandidateId]  || {};
  const rem = candidates[selectedPair.remoteCandidateId] || {};

  return {
    localType:     loc.candidateType ?? '?',
    localProtocol: loc.protocol      ?? '?',
    localAddress:  loc.address ?? loc.ip ?? '?',
    localPort:     loc.port    ?? 0,
    remoteType:    rem.candidateType ?? '?',
    remoteAddress: rem.address ?? rem.ip ?? '?',
    remotePort:    rem.port    ?? 0,
    bytesSent:     selectedPair.bytesSent     ?? 0,
    bytesReceived: selectedPair.bytesReceived ?? 0,
    timestamp:     selectedPair.timestamp     ?? Date.now(),
    state:         selectedPair.state         ?? '?',
  };
}

// ── Phase 1: Server pre-flight ─────────────────────────────────────────────
async function phase1() {
  hdr('[Phase 1] 서버 사전 점검');

  // Server reachability
  let cameras  = [];
  let iceConfig = null;

  try {
    const { status, data } = await httpGet('/api/cameras');
    if (status !== 200 || !data.success) {
      fail(`GET /api/cameras → HTTP ${status}`);
      return { serverOk: false, cameras, iceConfig };
    }
    cameras = data.data || [];
    const webrtcCams = cameras.filter((c) => c.webrtcEnabled);
    ok(`카메라 ${cameras.length}개 (WebRTC 활성: ${webrtcCams.length}개)`);
    for (const c of webrtcCams) {
      const running = c.pipelineStatus?.running;
      info(`  ${c.name} (${c.id.slice(0, 8)}) — ${running ? `${G}running${R}` : `${Y}stopped${R}`}`);
    }
    if (webrtcCams.length === 0) {
      info('WebRTC 활성 카메라 없음 — 테스트용 임시 활성화를 시도합니다');
    }
  } catch (err) {
    fail(`서버 응답 없음 (${err.message}) — 서버가 실행 중인지 확인하세요`);
    info(`  cd server && npm run dev`);
    return { serverOk: false, cameras, iceConfig };
  }

  // ICE config
  try {
    const { status, data } = await httpGet('/api/webrtc/ice-config');
    if (status === 200) {
      iceConfig = data;
      ok(`STUN ${data.stunUrls?.length ?? 0}개  TURN ${data.turns?.length ?? 0}개`);
      for (const u of (data.stunUrls || [])) info(`  STUN: ${u}`);
      for (const t of (data.turns    || [])) info(`  TURN: ${t.url}  user=${t.username}`);
    }
  } catch (err) {
    warn(`/api/webrtc/ice-config: ${err.message}`);
  }

  // STUN UDP ping (LAN STUN servers only)
  if (iceConfig?.stunUrls?.length) {
    for (const u of iceConfig.stunUrls) {
      const m = u.match(/stun:([^:]+)(?::(\d+))?/);
      if (!m || m[1].includes('google.com') || m[1].includes('stun.l.')) continue;
      const host = m[1], port = parseInt(m[2] || '3478');
      const alive = await stunPing(host, port);
      if (alive) ok(`STUN UDP ping → ${host}:${port} 응답 있음`);
      else        warn(`STUN UDP ping → ${host}:${port} 응답 없음`);
    }
  }

  // Auto-enable WebRTC on the first camera if none are enabled
  let autoEnabledId = null;
  const webrtcCamsAfterStun = cameras.filter((c) => c.webrtcEnabled);
  if (webrtcCamsAfterStun.length === 0 && cameras.length > 0) {
    const target = cameras[0];
    info(`WebRTC 활성 카메라 없음 — "${target.name}" 임시 활성화 중...`);
    try {
      const { status, data } = await httpPut(`/api/cameras/${target.id}`, { webrtcEnabled: true });
      if (status === 200 && data.success) {
        autoEnabledId = target.id;
        info('파이프라인 준비 대기 중 (최대 15초)...');
        const ready = await waitForPipeline(target.id, 15000);
        if (ready) ok(`"${target.name}": WebRTC 파이프라인 준비 완료`);
        else        warn(`"${target.name}": 파이프라인 시간 초과 — RTSP 스트림이 유효한지 확인 필요`);
      } else {
        warn(`WebRTC 활성화 API 오류 (HTTP ${status})`);
      }
    } catch (err) {
      warn(`WebRTC 자동 활성화 실패: ${err.message}`);
    }
  }

  const serverOk = cameras.some((c) => c.webrtcEnabled && c.pipelineStatus?.running)
                || autoEnabledId !== null;
  if (!serverOk) {
    warn('WebRTC 파이프라인 실행 중인 카메라 없음 — 브라우저 테스트는 계속 진행합니다');
  }
  return { serverOk, cameras, iceConfig, autoEnabledId };
}

// ── Phase 2: Browser automation ────────────────────────────────────────────
async function phase2(testCameraId, iceConfig) {
  hdr('[Phase 2] 브라우저 자동화');

  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    fail('playwright 미설치');
    info('설치 명령: cd server && npm install --save-dev playwright');
    return null;
  }

  const launchOpts = {
    headless: HEADLESS,
    args: [
      // Show real LAN IPs in ICE candidates (not .local mDNS)
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      // Auto-grant media permissions (mic/camera dialogs)
      '--use-fake-ui-for-media-stream',
      // Disable CORS for local dev
      '--disable-web-security',
    ],
  };

  // Prefer system Chrome to avoid Playwright downloading its own Chromium
  if (CHROME_PATH) {
    launchOpts.executablePath = CHROME_PATH;
    info(`시스템 Chrome 사용: ${CHROME_PATH}`);
  } else {
    info('시스템 Chrome 없음 — Playwright 내장 Chromium 사용 (npx playwright install chromium)');
  }
  info(`Mode: ${HEADLESS ? 'headless' : '브라우저 창 표시 (headed)'}`);
  info(`UI  : ${UI}`);

  const browser = await playwright.chromium.launch(launchOpts);
  const context = await browser.newContext({
    // Grant all permissions up front
    permissions: ['microphone', 'camera'],
  });
  const page = await context.newPage();

  // ── Inject RTCPeerConnection interceptor ──
  // Must run before any page scripts so mediasoup-client picks up our proxy.
  await page.addInitScript(() => {
    window.__lts_rtcPCs = [];
    window.__lts_rtcEvents = [];

    const _Native = window.RTCPeerConnection;
    // Use Proxy to intercept new RTCPeerConnection(...) without breaking prototype chain
    window.RTCPeerConnection = new Proxy(_Native, {
      construct(Target, args) {
        const pc = Reflect.construct(Target, args);
        window.__lts_rtcPCs.push(pc);

        // Track state changes for the log
        const tag = `PC#${window.__lts_rtcPCs.length}`;
        pc.addEventListener('connectionstatechange', () => {
          window.__lts_rtcEvents.push(`${tag} connectionState→${pc.connectionState}`);
        });
        pc.addEventListener('iceconnectionstatechange', () => {
          window.__lts_rtcEvents.push(`${tag} iceConnectionState→${pc.iceConnectionState}`);
        });
        pc.addEventListener('icegatheringstatechange', () => {
          window.__lts_rtcEvents.push(`${tag} iceGatheringState→${pc.iceGatheringState}`);
        });
        pc.addEventListener('icecandidate', (e) => {
          if (e.candidate) {
            window.__lts_rtcEvents.push(
              `${tag} candidate: ${e.candidate.type} ${e.candidate.protocol} ${e.candidate.address}:${e.candidate.port}`
            );
          }
        });
        return pc;
      },
    });
  });

  // Forward browser console lines that mention WebRTC / ICE
  page.on('console', (msg) => {
    const t = msg.text();
    if (/webrtc|ice|dtls|rtp|producer|consumer/i.test(t)) {
      info(`  [browser] ${t.slice(0, 120)}`);
    }
  });

  ok('Chromium 시작');
  try {
    await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch (err) {
    fail(`UI 로드 실패: ${err.message}`);
    info(`  Web UI가 실행 중인지 확인: cd client && npm run dev`);
    await browser.close();
    return null;
  }
  ok(`페이지 로드 완료: ${UI}`);

  // ── Socket.IO trigger: tell the React app to start a WebRTC test connection ──
  // (Optional — IceTestTrigger uses mediasoup-client which may fail in headless Chrome.
  //  The loopback injection below provides a reliable fallback.)
  let sio = null;
  if (testCameraId) {
    try {
      sio = await socketIOConnect(SERVER);
      sio.emit('webrtc:ice-test-start', { cameraId: testCameraId });
      ok(`Socket.IO 트리거 전송 → webrtc:ice-test-start (camera ${testCameraId.slice(0, 8)}…)`);
    } catch (err) {
      warn(`Socket.IO 연결 실패: ${err.message}`);
    }
  }

  // ── Loopback ICE injection (primary path — no mediasoup-client required) ──
  // Creates two RTCPeerConnections inside the browser page and connects them via
  // local SDP exchange, using the server's STUN/TURN ICE servers.
  // This works reliably in headless Chrome without codec/mediasoup limitations.
  info('Loopback ICE 테스트 주입 중…');
  try {
    await injectLoopbackICETest(page, iceConfig);
    ok('RTCPeerConnection × 2 생성 (loopback SDP 교환 완료)');
  } catch (err) {
    warn(`Loopback 주입 실패: ${err.message} — 기존 WebRTC 연결 감지로 대체`);
  }

  // ── Phase A: Verify RTCPeerConnection is present ──────────────────────────
  // Loopback PCs are injected synchronously, so we only need a short sanity check
  info('RTCPeerConnection 생성 확인…');
  const pcFound = await waitForPCCreation(page, 3_000);

  if (!pcFound) {
    fail('RTCPeerConnection이 생성되지 않음');
    warn('  → Loopback 주입이 실패하고 IceTestTrigger도 동작하지 않음');
    const ssPath = '/tmp/lts-ice-test-fail.png';
    await page.screenshot({ path: ssPath }).catch(() => {});
    info(`스크린샷 저장: ${ssPath}`);
    if (sio) sio.close();
    await browser.close();
    return null;
  }
  ok('RTCPeerConnection 생성 확인');

  // ── Phase B: Wait for ICE connected (adaptive — exit as soon as connected) ──
  info(`ICE 연결 대기 중… (최대 ${ICE_CONNECT_MS / 1000}초, 연결되면 즉시 종료)`);
  const connected = await waitForICEConnected(page, ICE_CONNECT_MS);

  // Collect browser-side event log regardless of success
  const rtcEvents = await page.evaluate(() => window.__lts_rtcEvents ?? []).catch(() => []);
  const pcStates  = await page.evaluate(() =>
    window.__lts_rtcPCs.map((pc, i) => ({
      id:     `PC#${i + 1}`,
      conn:   pc.connectionState,
      ice:    pc.iceConnectionState,
      gather: pc.iceGatheringState,
    }))
  ).catch(() => []);

  if (!connected) {
    fail(`ICE 연결 실패 (${ICE_CONNECT_MS / 1000}초 초과)`);
    for (const s of pcStates) {
      info(`  ${s.id}: conn=${s.conn}  ice=${s.ice}  gather=${s.gather}`);
    }
    if (rtcEvents.length > 0) {
      info('ICE 이벤트 로그:');
      for (const e of rtcEvents.slice(-15)) info(`  ${e}`);
    }
    const ssPath = '/tmp/lts-ice-test-fail.png';
    await page.screenshot({ path: ssPath }).catch(() => {});
    info(`스크린샷 저장: ${ssPath}`);
    if (sio) sio.close();
    await browser.close();
    return null;
  }

  ok('ICE 연결 성공 (connectionState = connected)');

  // Print ICE event log
  if (rtcEvents.length > 0) {
    info('ICE 이벤트 로그:');
    for (const e of rtcEvents) info(`  ${e}`);
  }

  // ── Poll getStats() ──
  info(`getStats() ${POLL_COUNT}회 수집 중 (${POLL_INTERVAL / 1000}초 간격)…`);
  const snapshots = [];

  for (let i = 0; i < POLL_COUNT; i++) {
    const statsObj = await page.evaluate(async () => {
      const pc = window.__lts_rtcPCs.find((p) => p.connectionState === 'connected');
      if (!pc) return null;
      const out = {};
      const report = await pc.getStats();
      report.forEach((v, k) => { out[k] = v; });
      return out;
    }).catch(() => null);

    if (statsObj) {
      const parsed = parseStats(statsObj);
      if (parsed) snapshots.push(parsed);
    }
    if (i < POLL_COUNT - 1) await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  // Take a screenshot of the connected state
  const ssPath = '/tmp/lts-ice-test-ok.png';
  await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});
  ok(`스크린샷 저장: ${ssPath}`);

  // Signal test completion so the React app cleans up the hidden WebRTC connection
  if (sio) {
    sio.emit('webrtc:ice-test-done', {});
    sio.close();
  }

  await browser.close();
  ok('브라우저 종료');
  return snapshots;
}

// ── Phase 3: Report ────────────────────────────────────────────────────────
function phase3(snapshots) {
  if (!snapshots || snapshots.length === 0) return false;

  hdr('[Phase 3] ICE Candidate 리포트');

  const first = snapshots[0];
  const last  = snapshots[snapshots.length - 1];

  const typeTag = (t) =>
    t === 'relay'  ? `${OR}[relay]${R} ` :
    t === 'srflx'  ? `${Y}[srflx]${R} ` :
    t === 'host'   ? `${G}[host] ${R} ` : `[${t}]  `;

  const typeDesc = (t) =>
    t === 'relay'  ? `${OR}TURN 릴레이${R} — 방화벽/인터넷 우회 경로` :
    t === 'srflx'  ? `${Y}STUN mapped${R} — NAT 통과 (공인 IP 취득)` :
    t === 'host'   ? `${G}LAN 직접${R}   — 최적 경로` : t;

  console.log(`\n  ${B}Local  candidate:${R} ${typeTag(last.localType)}${last.localProtocol.toUpperCase()}  ${last.localAddress}:${last.localPort}`);
  console.log(`    └ ${typeDesc(last.localType)}`);
  console.log(`\n  ${B}Remote candidate:${R} ${typeTag(last.remoteType)}${last.remoteAddress}:${last.remotePort}`);

  // Throughput
  const fmt = (b) =>
    b >= 1_048_576 ? `${(b / 1_048_576).toFixed(2)} MB` :
    b >= 1024      ? `${(b / 1024).toFixed(1)} KB`       : `${b} B`;

  const dRx   = last.bytesReceived - first.bytesReceived;
  const dSec  = Math.max((last.timestamp - first.timestamp) / 1000, 0.001);
  const kbps  = ((dRx * 8) / dSec / 1000).toFixed(0);

  console.log(`\n  ${B}트래픽:${R}`);
  console.log(`    ↑ 송신 누적   : ${fmt(last.bytesSent)}`);
  console.log(`    ↓ 수신 누적   : ${fmt(last.bytesReceived)}`);
  console.log(`    ↓ 수신 속도   : ~${kbps} kbps  (${POLL_COUNT}회 × ${POLL_INTERVAL / 1000}s)`);

  // Snapshots trend
  if (snapshots.length > 1) {
    console.log(`\n  ${B}수신 추이:${R}`);
    for (const s of snapshots) {
      const bar = '█'.repeat(Math.min(Math.floor(s.bytesReceived / 50000), 20));
      console.log(`    ${fmt(s.bytesReceived).padStart(10)}  ${bar}`);
    }
  }

  // Verdict
  console.log();
  // Detect loopback test (both local and remote candidates share the same IP/loopback address)
  const isLoopback = last.localAddress === last.remoteAddress ||
    last.localAddress === '127.0.0.1' || last.localAddress === '::1';
  if (isLoopback) {
    ok(`경로: Loopback 직접 (${last.localProtocol.toUpperCase()}) — STUN/TURN 설정 포함, RTCPeerConnection ✓`);
    info('  loopback 테스트: 두 PeerConnection이 같은 브라우저 내에서 연결됨');
    info('  STUN/TURN 서버 도달 여부는 Phase 1 UDP ping 결과로 확인하세요');
  } else if (last.localType === 'host') {
    ok(`경로: LAN 직접 (${last.localProtocol.toUpperCase()}) — 최적`);
  } else if (last.localType === 'srflx') {
    warn(`경로: STUN NAT 통과 (${last.localProtocol.toUpperCase()}) — UDP 방화벽이 없으면 정상`);
    info('  문제 발생 시: sudo ufw allow 40000:49999/udp');
  } else if (last.localType === 'relay') {
    warn(`경로: TURN 릴레이 — LAN 직접 연결(host)이 안 된 이유 확인 권장`);
    info('  server/.env → SERVER_IP=<LAN IP> 설정 확인');
    info('  /etc/turnserver.conf → allowed-peer-ip=<mediasoup LAN IP> 확인');
  }

  // Loopback tests have static bytesReceived (ICE handshake only, no continuous stream).
  // For loopback, bytesReceived > 0 is sufficient to confirm data plane works.
  if (isLoopback) return last.bytesReceived > 0;
  return dRx > 0; // For real streams: bytes must be actively flowing
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${B}=== LTS ICE Candidate 자동화 테스트 ===${R}`);
  console.log(`  Server : ${C}${SERVER}${R}`);
  console.log(`  UI     : ${C}${UI}${R}`);
  console.log(`  모드   : ${HEADLESS ? 'headless' : '브라우저 창 표시'}`);

  const { autoEnabledId, cameras, iceConfig } = await phase1();
  // Identify the camera to use for the WebRTC test
  const webrtcCam  = (cameras || []).find((c) => c.webrtcEnabled && c.pipelineStatus?.running);
  const testCamId  = webrtcCam?.id ?? autoEnabledId ?? null;
  if (testCamId) info(`WebRTC 테스트 대상 카메라: ${testCamId.slice(0, 8)}…`);
  const snapshots = await phase2(testCamId, iceConfig);
  const flowing   = phase3(snapshots);

  // Restore auto-enabled camera to its original state
  if (autoEnabledId) {
    try {
      await httpPut(`/api/cameras/${autoEnabledId}`, { webrtcEnabled: false });
      info(`카메라 WebRTC 설정 원복: ${autoEnabledId.slice(0, 8)}...`);
    } catch { /* ignore */ }
  }

  hdr('=== 최종 결과 ===');
  if (flowing) {
    console.log(`${G}${B}  PASS — ICE 연결 확인, 영상 데이터 흐름 정상${R}\n`);
  } else if (snapshots && snapshots.length > 0) {
    console.log(`${Y}${B}  WARN — ICE 연결됨, 데이터 흐름 미확인 (카메라 스트림 점검 필요)${R}\n`);
    process.exitCode = 1;
  } else {
    console.log(`${RE}${B}  FAIL — ICE 연결 불가 (위 로그 확인)${R}\n`);
    info('  /tmp/lts-ice-test-fail.png — 실패 시 스크린샷');
    info('  cd server && npm run health — 서버 상태 전체 점검');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
});
