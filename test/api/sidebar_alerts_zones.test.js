'use strict';
/**
 * Dashboard Sidebar — Alerts & Zones REST API Tests
 * TC: TC_Dashboard_Sidebar_Alerts_Zones.md
 * Groups: B (Alert Acknowledgment REST), D (Zone Editor REST)
 *
 * NOTE: Groups A (Alert Panel Display), C (Zone Sidebar UI),
 *       E (i18n/Edge Cases) are Phase-3 frontend/E2E tests
 *       → see test/e2e/dashboard_detection.test.js
 *
 * Run: node test/api/sidebar_alerts_zones.test.js
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3001';

// ── Minimal test harness ─────────────────────────────────────────────────────

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

function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description} (skipped — ${reason})`);
  results.push({ id, description, status: 'SKIP' });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function get(path) {
  const res  = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function post(path, body = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function put(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function del(path) {
  const res  = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

let cameraId = null;
const cleanupZones = [];

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const { status, body } = await get('/health');
  assert(status === 200, `Server not healthy: HTTP ${status}`);
  assert(body.status === 'ok', `Health: ${body.status}`);
  console.log('  ✓ Server is running');

  // Create a test camera
  const camRes = await fetch(`${BASE_URL}/api/cameras`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name: 'SB-AZ Test Camera', rtspUrl: 'rtsp://127.0.0.1:8554/sb-az-test' }),
  });
  const cam = await camRes.json();
  assert(camRes.status === 201, `Camera creation failed: ${camRes.status}`);
  cameraId = cam.data.id;
  console.log(`  ✓ Test camera created: ${cameraId}\n`);
}

// ── Group A — Note: UI tests (Phase-3) ───────────────────────────────────────

function runGroupA_notes() {
  console.log('[Group A] Alert Panel Display — Phase-3 (UI/E2E tests)\n');
  skip('TC-A-001', 'Real-Time Alert from Socket.IO — panel updates', 'Phase-3 frontend test');
  skip('TC-A-002', 'Unacknowledged Alert Count Badge', 'Phase-3 frontend test');
  skip('TC-A-003', '"Clear All" Button', 'Phase-3 frontend test');
  skip('TC-A-004', 'Alert Row Content rendering', 'Phase-3 frontend test');
  skip('TC-A-005', 'Acknowledged vs Unacknowledged Styling', 'Phase-3 frontend test');
  skip('TC-A-006', '20 Alert Maximum', 'Phase-3 frontend test');
  skip('TC-A-007', 'Empty State', 'Phase-3 frontend test');
}

// ── Group B — Alert Acknowledgment REST API ──────────────────────────────────

async function runGroupB() {
  console.log('[Group B] Alert Acknowledgment REST API\n');

  await test('TC-B-001', 'GET /api/alerts → 200 with data array', async () => {
    const { status, body } = await get('/api/alerts');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-B-002', 'GET /api/alerts?acknowledged=false → only unacknowledged', async () => {
    const { status, body } = await get('/api/alerts?acknowledged=false');
    assertEq(status, 200, 'HTTP status');
    for (const a of body.data) {
      assert(a.acknowledged === false, `Alert ${a.id} should be unacknowledged`);
    }
  });

  await test('TC-B-003', 'GET /api/alerts?acknowledged=true → only acknowledged', async () => {
    const { status, body } = await get('/api/alerts?acknowledged=true');
    assertEq(status, 200, 'HTTP status');
    for (const a of body.data) {
      assert(a.acknowledged === true, `Alert ${a.id} should be acknowledged`);
    }
  });

  await test('TC-B-004', 'POST /api/alerts/:id/acknowledge — non-existent → 404', async () => {
    const { status, body } = await post('/api/alerts/00000000-0000-0000-0000-000000000000/acknowledge');
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-B-005', 'POST /api/alerts/:id/acknowledge — first unacknowledged alert', async () => {
    const { body: alertList } = await get('/api/alerts?acknowledged=false');
    if (alertList.data.length === 0) {
      console.log('      (no unacknowledged alerts — acknowledging not tested)');
      return;
    }
    const alertId = alertList.data[0].id;
    const { status, body } = await post(`/api/alerts/${alertId}/acknowledge`);
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
  });
}

// ── Group C & D — Zone Sidebar REST API ──────────────────────────────────────

async function runGroupD() {
  console.log('[Group D] Zone Editor REST API\n');

  const POLYGON = [
    { x: 20, y: 20 }, { x: 300, y: 20 }, { x: 300, y: 250 }, { x: 20, y: 250 },
  ];

  await test('TC-D-001', 'POST zone — 201 with id, type, polygon', async () => {
    const { status, body } = await post(`/api/cameras/${cameraId}/zones`, {
      name:    'TC-D-001 Monitor Zone',
      type:    'MONITOR',
      polygon: POLYGON,
    });
    assertEq(status, 201, 'HTTP status');
    assert(body.data.id,    'id present');
    assertEq(body.data.type, 'MONITOR', 'type');
    assert(Array.isArray(body.data.polygon), 'polygon is array');
    cleanupZones.push(body.data.id);
  });

  await test('TC-D-002', 'POST EXCLUDE zone — accepted', async () => {
    const { status, body } = await post(`/api/cameras/${cameraId}/zones`, {
      name:    'TC-D-002 Exclude Zone',
      type:    'EXCLUDE',
      polygon: POLYGON,
    });
    assertEq(status, 201, 'HTTP status');
    assertEq(body.data.type, 'EXCLUDE', 'type');
    cleanupZones.push(body.data.id);
  });

  await test('TC-D-003', 'PUT zone — dwellThreshold updated', async () => {
    const { body: created } = await post(`/api/cameras/${cameraId}/zones`, {
      name:           'TC-D-003 Update Zone',
      polygon:        POLYGON,
      dwellThreshold: 30,
    });
    cleanupZones.push(created.data.id);
    const { status, body } = await put(`/api/cameras/${cameraId}/zones/${created.data.id}`, {
      dwellThreshold: 90,
    });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.dwellThreshold, 90, 'dwellThreshold updated');
  });

  await test('TC-D-004', 'DELETE zone → 200, removed from list', async () => {
    const { body: created } = await post(`/api/cameras/${cameraId}/zones`, {
      name:    'TC-D-004 Delete Zone',
      polygon: POLYGON,
    });
    const zid = created.data.id;
    const { status } = await del(`/api/cameras/${cameraId}/zones/${zid}`);
    assertEq(status, 200, 'HTTP status');

    const { body: list } = await get(`/api/cameras/${cameraId}/zones`);
    assert(!list.data.find(z => z.id === zid), 'zone removed from list');
  });

  await test('TC-D-005', 'POST zone — missing name → 400', async () => {
    const { status } = await post(`/api/cameras/${cameraId}/zones`, { polygon: POLYGON });
    assertEq(status, 400, 'HTTP status');
  });

  await test('TC-D-006', 'POST zone — polygon with 2 vertices → 400', async () => {
    const { status } = await post(`/api/cameras/${cameraId}/zones`, {
      name:    'TC-D-006',
      polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    });
    assertEq(status, 400, 'HTTP status');
  });
}

// ── Group E — Note: i18n / UI tests (Phase-3) ───────────────────────────────

function runGroupE_notes() {
  console.log('[Group E] i18n & Edge Cases — Phase-3 (UI/E2E tests)\n');
  skip('TC-E-001', 'Language switch EN↔KO in sidebar', 'Phase-3 frontend test');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  for (const zid of cleanupZones) {
    try { await del(`/api/cameras/${cameraId}/zones/${zid}`); } catch (_) {}
  }
  if (cameraId) {
    try { await del(`/api/cameras/${cameraId}`); } catch (_) {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC_Dashboard_Sidebar_Alerts_Zones — REST API Tests ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    runGroupA_notes();
    await runGroupB();
    await runGroupD();
    runGroupE_notes();
  } finally {
    await cleanup();
  }

  const skipped = results.filter(r => r.status === 'SKIP').length;
  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('─────────────────────────────────────────────────────');

  if (failed > 0) {
    console.log('\nFailed tests:');
    results
      .filter(r => r.status === 'FAIL')
      .forEach(r => console.log(`  ✗ ${r.id}: ${r.description}\n      ${r.error}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  cleanup().catch(() => {});
  process.exit(1);
});
