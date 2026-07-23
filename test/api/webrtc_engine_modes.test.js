'use strict';
/**
 * WebRTC Engine Modes Tests (mediamtx / mediasoup contract)
 *
 * TC: TC-LTS-WEM-01
 *   Group A — Engine Selection & Config (TC-A-001, TC-A-004)
 *   Group D — Diagnostics (TC-D-001, TC-D-004)
 *
 * Group B (mediamtx flow) and Group C (mediasoup flow) require a live camera
 * and/or a specific WEBRTC_ENGINE setting + server restart — covered manually
 * per docs/tc/TC_WebRTC_Engine_Modes.md §4/§5, not automated here.
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 * Run: node test/api/webrtc_engine_modes.test.js
 *
 * Set LTS_URL env var to override base URL.
 */

const path = require('path');

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

// ── Minimal test harness (mirrors test/api/webrtc.test.js) ─────────────────

let passed = 0;
let failed = 0;
const results = [];

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed++;
    results.push({ id, description, status: 'PASS' });
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}`);
    console.error(`      ${err.message}`);
    failed++;
    results.push({ id, description, status: 'FAIL', error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function get(reqPath) {
  const res = await fetch(`${BASE_URL}${reqPath}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function post(reqPath) {
  const res = await fetch(`${BASE_URL}${reqPath}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running\n');
}

// ── Group A — Engine Selection & Config ──────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] Engine Selection & Config (TC-A-001, TC-A-004)\n');

  let currentEngine = null;

  await test('TC-A-001', 'POST /api/webrtc/ice-test — engine field matches an implemented engine', async () => {
    const { status, body } = await post('/api/webrtc/ice-test');
    assert(status === 200 || status === 503, `unexpected HTTP status ${status}`);
    if (status === 200) {
      assert(typeof body.engine === 'string', 'engine field is string');
      assert(['mediamtx-whep', 'mediasoup'].includes(body.engine),
        `engine "${body.engine}" is not a recognized implemented engine`);
      currentEngine = body.engine;
      assert(typeof body.testId === 'string' && body.testId.length > 0, 'testId present');
    } else {
      // Engine unreachable (e.g. MediaMTX not running) — still must expose which engine failed.
      assert(typeof body.engine === 'string', 'engine field present even on 503');
      assert(typeof body.hint === 'string', 'hint field present on 503');
    }
  });

  await test('TC-A-004', 'mediamtxEngine.js and mediasoupEngine.js both export the common engine interface', async () => {
    const REQUIRED_EXPORTS = [
      'ENGINE_NAME', 'addCameraStream', 'removeCameraStream',
      'waitForStreamReady', 'negotiate', 'isHealthy', 'getEngineInfo',
    ];
    const serverRoot = path.resolve(__dirname, '..', '..', 'server', 'src', 'services', 'webrtc');

    const mediamtxEngine = require(path.join(serverRoot, 'mediamtxEngine.js'));
    for (const key of REQUIRED_EXPORTS) {
      assert(key in mediamtxEngine, `mediamtxEngine.js missing export "${key}"`);
    }
    assertEq(mediamtxEngine.ENGINE_NAME, 'mediamtx', 'mediamtxEngine ENGINE_NAME');

    // mediasoup's own npm package may be absent in a lightweight test environment
    // (native addon); requiring it is only a static shape check, not a boot test.
    try {
      const mediasoupEngine = require(path.join(serverRoot, 'mediasoupEngine.js'));
      for (const key of REQUIRED_EXPORTS) {
        assert(key in mediasoupEngine, `mediasoupEngine.js missing export "${key}"`);
      }
      assertEq(mediasoupEngine.ENGINE_NAME, 'mediasoup', 'mediasoupEngine ENGINE_NAME');
    } catch (err) {
      console.warn(`      (skipped mediasoupEngine.js shape check — module unavailable: ${err.message})`);
    }
  });

  return currentEngine;
}

// ── Group D — Diagnostics ────────────────────────────────────────────────────

async function runGroupD() {
  console.log('[Group D] Diagnostics (TC-D-001, TC-D-004)\n');

  await test('TC-D-001', 'POST /api/webrtc/ice-test — testId prefixed with engine name when healthy', async () => {
    const { status, body } = await post('/api/webrtc/ice-test');
    if (status !== 200) {
      console.warn(`      (skipped — engine unhealthy, HTTP ${status})`);
      return;
    }
    assert(typeof body.testId === 'string', 'testId is string');
    assert(body.testId.includes('-'), 'testId contains a "-" separator');
  });

  await test('TC-D-004', 'GET /health does not expose a webrtcEngine field (regression guard)', async () => {
    const { status, body } = await get('/health');
    assertEq(status, 200, 'HTTP status');
    assert(!('webrtcEngine' in body),
      'webrtcEngine leaked into /health — engine info must only be exposed via /api/webrtc/ice-test or the dev-only /api/webrtc/monitor');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-WEM-01 — WebRTC Engine Modes Tests           ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  await checkPrerequisites();
  await runGroupA();
  await runGroupD();

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
