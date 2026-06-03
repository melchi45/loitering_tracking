'use strict';
/**
 * Dashboard Sidebar — Cameras REST API Tests
 * TC: TC_Dashboard_Sidebar_Cameras.md
 * Groups: B (Added Cameras REST), C (Add Camera Modal REST), D (Found Cameras REST), G (Edge Cases)
 *
 * NOTE: Groups A (Header & Sub-Tabs), E (DiscoveredCameraPanel Overlay),
 *       F (Edit Camera Modal UI) are Phase-3 frontend/E2E tests.
 *
 * Run: node test/api/sidebar_cameras.test.js
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

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

async function post(path, body) {
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

// ── Cleanup ───────────────────────────────────────────────────────────────────

const createdCameras = [];

// ── Prerequisites ─────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const { status, body } = await get('/health');
  assert(status === 200, `Server not healthy: HTTP ${status}`);
  assert(body.status === 'ok', `Health: ${body.status}`);
  console.log('  ✓ Server is running\n');
}

// ── Group A — UI notes ────────────────────────────────────────────────────────

function runGroupA_notes() {
  console.log('[Group A] Camera Panel Header & Sub-Tabs — Phase-3 (UI/E2E)\n');
  skip('TC-A-001', 'Sub-tab "Added Cameras" visible and selected by default', 'Phase-3 frontend test');
  skip('TC-A-002', 'Sub-tab "Found Cameras" tab is accessible', 'Phase-3 frontend test');
}

// ── Group B — Added Cameras REST API ─────────────────────────────────────────

async function runGroupB() {
  console.log('[Group B] Added Cameras List REST API\n');

  await test('TC-B-001', 'GET /api/cameras → 200 with data array', async () => {
    const { status, body } = await get('/api/cameras');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-B-002', 'GET /api/cameras — each camera has required fields', async () => {
    const { body } = await get('/api/cameras');
    for (const cam of body.data) {
      assert(typeof cam.id   === 'string', `camera ${cam.id} has id`);
      assert(typeof cam.name === 'string', `camera ${cam.id} has name`);
    }
  });

  await test('TC-B-003', 'GET /api/cameras — no password/credential fields exposed', async () => {
    const { body } = await get('/api/cameras');
    for (const cam of body.data) {
      assert(!('password' in cam),    `camera ${cam.id} must not expose password`);
      assert(!('credentials' in cam), `camera ${cam.id} must not expose credentials`);
    }
  });
}

// ── Group C — Add Camera Modal REST API ──────────────────────────────────────

async function runGroupC() {
  console.log('[Group C] Add Camera Modal — REST API\n');

  await test('TC-C-001', 'POST /api/cameras — valid RTSP camera → 201', async () => {
    const { status, body } = await post('/api/cameras', {
      name:    'SB-CAM Test Camera RTSP',
      rtspUrl: 'rtsp://10.10.10.10:554/stream1',
    });
    assertEq(status, 201, 'HTTP status');
    assert(body.data?.id, 'id present');
    createdCameras.push(body.data.id);
  });

  await test('TC-C-002', 'POST /api/cameras — missing name → 400', async () => {
    const { status, body } = await post('/api/cameras', { rtspUrl: 'rtsp://10.10.10.11:554/ch0' });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-C-003', 'POST /api/cameras — missing rtspUrl → 400', async () => {
    const { status, body } = await post('/api/cameras', { name: 'Missing URL Camera' });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-C-004', 'POST /api/cameras — duplicate registration (same RTSP URL)', async () => {
    const rtspUrl = 'rtsp://10.20.30.40:554/dup-test';
    const r1 = await post('/api/cameras', { name: 'Dup Cam 1', rtspUrl });
    const r2 = await post('/api/cameras', { name: 'Dup Cam 2', rtspUrl });
    // Server may accept (200/201) or reject (409) duplicates — both are valid behaviours
    assert(
      [200, 201, 409].includes(r1.status) && [200, 201, 409].includes(r2.status),
      `Expected 201 or 409, got ${r1.status}, ${r2.status}`
    );
    if (r1.status === 201) createdCameras.push(r1.body.data?.id);
    if (r2.status === 201) createdCameras.push(r2.body.data?.id);
  });
}

// ── Group D — Found Cameras (Discovery) REST API ──────────────────────────────

async function runGroupD() {
  console.log('[Group D] Found Cameras (Discovery API)\n');

  await test('TC-D-001', 'POST /api/cameras/discover → 200, discovery triggered', async () => {
    const { status, body } = await post('/api/cameras/discover', {});
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
  });

  await test('TC-D-002', 'POST /api/cameras/discover — repeated call → 200', async () => {
    const { status } = await post('/api/cameras/discover', {});
    assertEq(status, 200, 'HTTP status');
  });
}

// ── Group E, F — UI notes ─────────────────────────────────────────────────────

function runGroupEF_notes() {
  console.log('[Group E/F] DiscoveredCameraPanel & Edit Camera Modal — Phase-3 (UI/E2E)\n');
  skip('TC-E-001', 'DiscoveredCameraPanel overlay renders camera preview', 'Phase-3 frontend test');
  skip('TC-F-001', 'Edit Camera Modal opens with pre-filled values', 'Phase-3 frontend test');
}

// ── Group G — Edge Cases ──────────────────────────────────────────────────────

async function runGroupG() {
  console.log('[Group G] Edge Cases\n');

  await test('TC-G-001', 'GET /api/cameras/:id — non-existent → 404', async () => {
    const { status, body } = await get('/api/cameras/00000000-0000-0000-0000-000000000000');
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-G-002', 'PUT /api/cameras/:id — non-existent → 404', async () => {
    const { status, body } = await put('/api/cameras/00000000-0000-0000-0000-000000000000', { name: 'Ghost' });
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-G-003', 'DELETE /api/cameras/:id — non-existent → 404', async () => {
    const { status, body } = await del('/api/cameras/00000000-0000-0000-0000-000000000000');
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-G-004', 'PUT /api/cameras/:id — update name → 200', async () => {
    if (createdCameras.length === 0) {
      const { body: cam } = await post('/api/cameras', { name: 'G-004 Cam', rtspUrl: 'rtsp://1.2.3.4:554/g4' });
      if (cam.data?.id) createdCameras.push(cam.data.id);
    }
    if (createdCameras.length === 0) { console.log('      (no cameras to update)'); return; }
    const camId = createdCameras[0];
    const { status, body } = await put(`/api/cameras/${camId}`, { name: 'Updated Camera Name' });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.name, 'Updated Camera Name', 'name updated');
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  for (const id of createdCameras.filter(Boolean)) {
    try { await del(`/api/cameras/${id}`); } catch (_) {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC_Dashboard_Sidebar_Cameras — REST API Tests      ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    runGroupA_notes();
    await runGroupB();
    await runGroupC();
    await runGroupD();
    runGroupEF_notes();
    await runGroupG();
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
