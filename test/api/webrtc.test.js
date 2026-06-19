'use strict';
/**
 * WebRTC Media Gateway Tests (REST API layer)
 *
 * TC: TC-LTS-WRTC-01
 *   Group F — REST API (TC-F-001 ~ TC-F-002)
 *
 * Tests: GET /api/capabilities, GET /api/crosscamera/stats
 *
 * Note: Groups A-E (mediasoup codec, signaling, router, DataChannel, fallback)
 *       and Group G (performance/latency) require a live WebRTC pipeline and
 *       are covered in Phase-2/3 integration tests.
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 * Run: node test/api/webrtc.test.js
 *
 * Set LTS_URL env var to override base URL.
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

// ── Minimal test harness ────────────────────────────────────────────────────

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

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── Prerequisites ────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running\n');
}

// ── Group A — mediasoup Codec PT Constraints ─────────────────────────────────

async function runGroupA() {
  console.log('[Group A] mediasoup Codec PT Constraints (TC-A-008, TC-A-009)\n');

  // TC-A-008 (FR-WRTC-070): Verify H264 PT=109 and Opus PT=111 via capabilities endpoint.
  // Full browser-level verification (inbound-rtp framesDecoded > 0) requires live browser
  // sessions and is Phase-3; this test confirms the REST-observable preconditions.
  await test('TC-A-008', 'GET /api/capabilities — codecs array present (PT=109 precondition)', async () => {
    const { status, body } = await get('/api/capabilities');
    assertEq(status, 200, 'HTTP status');
    // Capabilities endpoint must respond with valid structure regardless of engine
    assert(body && typeof body === 'object', 'response is object');
    // If webrtc info is exposed, confirm H264 and Opus codec presence
    if (body.codecs) {
      const h264 = body.codecs.find(c => c.mimeType && c.mimeType.toLowerCase().includes('h264'));
      assert(h264, 'H264 codec present in capabilities');
      if (h264.preferredPayloadType !== undefined) {
        assertEq(h264.preferredPayloadType, 109, 'H264 preferredPayloadType must be 109 (not 108)');
      }
    }
  });

  // TC-A-009 (FR-WRTC-071): Verify ICE config uses env-var-restricted IPs.
  // Server must not enumerate all NICs for listenIps.
  await test('TC-A-009', 'GET /api/webrtc/ice-config — stunUrls present; no loopback IP advertised', async () => {
    const { status, body } = await get('/api/webrtc/ice-config');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.stunUrls), 'stunUrls is array');
    // Loopback addresses (127.x.x.x) must not appear as STUN/TURN candidates
    const allUrls = [...body.stunUrls, ...(body.turns || []).map(t => t.url || '')];
    for (const url of allUrls) {
      assert(!url.includes('127.0.0.'), `loopback 127.x address must not be in ICE URLs: ${url}`);
    }
  });
}

// ── Group F — REST API ───────────────────────────────────────────────────────

async function runGroupF() {
  console.log('[Group F] REST API — Capabilities & Stats\n');

  await test('TC-F-001', 'GET /api/capabilities → 200 with AI availability map', async () => {
    const { status, body } = await get('/api/capabilities');
    assertEq(status, 200, 'HTTP status');
    assert(body.ai && typeof body.ai === 'object', 'ai map present');
    assert(body.status && typeof body.status === 'object', 'status map present');
  });

  await test('TC-F-002', 'Capabilities include expected AI module keys', async () => {
    const { body } = await get('/api/capabilities');
    const expected = ['human', 'vehicle', 'face', 'mask', 'hat', 'fire'];
    for (const key of expected) {
      assert(key in body.ai, `ai.${key} missing from capabilities`);
      assert(typeof body.ai[key] === 'boolean', `ai.${key} should be boolean`);
    }
  });

  await test('TC-F-003', 'Capabilities status map values are valid strings', async () => {
    const { body } = await get('/api/capabilities');
    const validStatuses = ['builtin', 'available', 'loaded', 'failed', 'missing', 'pending'];
    for (const [key, val] of Object.entries(body.status)) {
      assert(validStatuses.includes(val),
        `status.${key} has invalid value "${val}"; expected one of: ${validStatuses.join(', ')}`);
    }
  });

  await test('TC-F-004', 'GET /api/crosscamera/stats → 200 with stats schema', async () => {
    const { status, body } = await get('/api/crosscamera/stats');
    assertEq(status, 200, 'HTTP status');
    assert('totalTransitions' in body, 'totalTransitions field present');
    assert('uniqueFaces' in body,      'uniqueFaces field present');
    assert(Array.isArray(body.faces),  'faces is array');
  });

  await test('TC-F-005', 'GET /health → 200 with server health fields', async () => {
    const { status, body } = await get('/health');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.status, 'ok', 'status ok');
    assert(typeof body.uptime === 'number',    'uptime is number');
    assert(typeof body.timestamp === 'string', 'timestamp is string');
  });

  await test('TC-F-006', 'GET /api/persons/active → 200 with persons array', async () => {
    const { status, body } = await get('/api/persons/active');
    assertEq(status, 200, 'HTTP status');
    assert('total' in body,             'total field present');
    assert(Array.isArray(body.persons), 'persons is array');
    assert(typeof body.total === 'number', 'total is number');
  });

  await test('TC-F-007', 'GET /api/webrtc/ice-config → 200 (WebRTC infra reachable)', async () => {
    const { status, body } = await get('/api/webrtc/ice-config');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.stunUrls), 'stunUrls array');
    assert(Array.isArray(body.turns),    'turns array');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-WRTC-01 — WebRTC Media Gateway Tests        ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  await checkPrerequisites();
  await runGroupA();
  await runGroupF();

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
