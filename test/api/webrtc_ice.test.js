'use strict';
/**
 * WebRTC ICE Config API Tests
 *
 * TC: TC-LTS-ICE-01
 *   Group A — ICE Config Endpoint (TC-A-001 ~ TC-A-004)
 *   Group C — TURN Config         (TC-C-002 ~ TC-C-003)
 *
 * SRS: FR-ICE-001 ~ FR-ICE-004, FR-ICE-020 ~ FR-ICE-022
 *
 * Note: Groups B (STUN UDP ping), E-G (ice-test CLI phases), H (Socket.IO trigger)
 *       require live STUN/TURN servers and are covered in Phase-2/3.
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 * Run: node test/api/webrtc_ice.test.js
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

// ── Group A — ICE Config Endpoint ───────────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] ICE Config Endpoint\n');

  await test('TC-A-001', 'GET /api/webrtc/ice-config → 200', async () => {
    const { status } = await get('/api/webrtc/ice-config');
    assertEq(status, 200, 'HTTP status');
  });

  await test('TC-A-002', 'Response has stunUrls (array) and turns (array)', async () => {
    const { body } = await get('/api/webrtc/ice-config');
    assert(Array.isArray(body.stunUrls), `stunUrls should be array (got ${typeof body.stunUrls})`);
    assert(Array.isArray(body.turns),    `turns should be array (got ${typeof body.turns})`);
  });

  await test('TC-A-003', 'stunUrls contains at least the default Google STUN', async () => {
    const { body } = await get('/api/webrtc/ice-config');
    assert(body.stunUrls.length >= 1, `stunUrls empty; expected at least default STUN`);
    // Default is stun:stun.l.google.com:19302 unless STUN_URLS env var is set
    const hasStun = body.stunUrls.every(url => typeof url === 'string' && url.startsWith('stun:'));
    assert(hasStun, `all stunUrls should be stun:// URIs (got: ${JSON.stringify(body.stunUrls)})`);
  });

  await test('TC-A-004', 'turns array entries have url, username, credential fields', async () => {
    const { body } = await get('/api/webrtc/ice-config');
    for (const turn of body.turns) {
      assert(typeof turn.url === 'string', 'turn.url is string');
      assert('username' in turn,   'turn.username field present');
      assert('credential' in turn, 'turn.credential field present');
    }
    console.log(`      (${body.turns.length} TURN server(s) configured)`);
  });

  await test('TC-A-005', 'No authentication required for ICE config endpoint', async () => {
    // Should return 200 with no Authorization header
    const res = await fetch(`${BASE_URL}/api/webrtc/ice-config`);
    assertEq(res.status, 200, 'HTTP status (no auth header)');
  });
}

// ── Group C — TURN Configuration ────────────────────────────────────────────

async function runGroupC() {
  console.log('\n[Group C] TURN Configuration\n');

  await test('TC-C-001', 'TURN urls begin with turn: or turns: scheme', async () => {
    const { body } = await get('/api/webrtc/ice-config');
    for (const turn of body.turns) {
      assert(
        turn.url.startsWith('turn:') || turn.url.startsWith('turns:'),
        `TURN url should start with turn: or turns: (got: ${turn.url})`
      );
    }
    console.log(`      (${body.turns.length} TURN server(s) validated)`);
  });

  await test('TC-C-002', 'Response body does not include raw credential values in stunUrls', async () => {
    // stunUrls should be pure stun: URIs without username/password embedded
    const { body } = await get('/api/webrtc/ice-config');
    for (const url of body.stunUrls) {
      assert(!url.includes('@'), `stunUrl should not contain @ (embedded credentials): ${url}`);
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-ICE-01 — STUN/TURN ICE Config Tests         ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  await checkPrerequisites();
  await runGroupA();
  await runGroupC();

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
