'use strict';
/**
 * Camera Discovery & Registration API Tests
 *
 * TC: TC-LTS-CAM-01
 *   Group A — Discovery Trigger API  (TC-A-001 ~ TC-A-002)
 *   Group B — Camera Registration API (TC-B-001 ~ TC-B-007)
 *   Group G — Edge Cases              (TC-G-001 ~ TC-G-006)
 *
 * SRS: FR-CAM-040 ~ FR-CAM-056
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 * Run: node test/api/camera_discovery.test.js
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

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

async function put(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

const createdCameraIds = [];

async function createCamera(overrides = {}) {
  const payload = {
    name:    overrides.name    || 'TC Camera',
    rtspUrl: overrides.rtspUrl || 'rtsp://192.168.1.100:554/stream',
    ...overrides,
  };
  const { status, body } = await post('/api/cameras', payload);
  assert(status === 201, `createCamera failed: HTTP ${status} — ${JSON.stringify(body)}`);
  createdCameraIds.push(body.data.id);
  return body.data;
}

async function cleanupAll() {
  for (const id of createdCameraIds) {
    try { await del(`/api/cameras/${id}`); } catch (_) {}
  }
  createdCameraIds.length = 0;
}

// ── Prerequisites ────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running\n');
}

// ── Group A — Discovery Trigger API ─────────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] Discovery Trigger API\n');

  await test('TC-A-001', 'POST /api/cameras/discover → 200, discovery started', async () => {
    const { status, body } = await post('/api/cameras/discover', {});
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(typeof body.message === 'string', 'message is string');
  });

  await test('TC-A-002', 'Rescan: second POST /api/cameras/discover → 200', async () => {
    const { status, body } = await post('/api/cameras/discover', {});
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
  });
}

// ── Group B — Camera Registration API ───────────────────────────────────────

async function runGroupB() {
  console.log('\n[Group B] Camera Registration API\n');

  let cam1;
  await test('TC-B-001', 'POST /api/cameras — success (201 with UUID)', async () => {
    cam1 = await createCamera({ name: 'TC-B-001 Cam', rtspUrl: 'rtsp://10.0.0.1:554/ch0' });
    assert(cam1.id && cam1.id.length === 36, `id is UUID (got: ${cam1.id})`);
    assertEq(cam1.name, 'TC-B-001 Cam', 'name');
    assertEq(cam1.rtspUrl, 'rtsp://10.0.0.1:554/ch0', 'rtspUrl');
  });

  await test('TC-B-002', 'GET /api/cameras — returns array of cameras', async () => {
    await createCamera({ name: 'TC-B-002 Cam A', rtspUrl: 'rtsp://10.0.0.2:554/ch0' });
    await createCamera({ name: 'TC-B-002 Cam B', rtspUrl: 'rtsp://10.0.0.3:554/ch0' });
    const { status, body } = await get('/api/cameras');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
    assert(body.data.length >= 2, `at least 2 cameras (got ${body.data.length})`);
  });

  await test('TC-B-003', 'GET /api/cameras/:id — 200 with correct record', async () => {
    const cam = await createCamera({ name: 'TC-B-003 Cam', rtspUrl: 'rtsp://10.0.0.4:554/ch0' });
    const { status, body } = await get(`/api/cameras/${cam.id}`);
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.id, cam.id, 'id matches');
    assertEq(body.data.name, 'TC-B-003 Cam', 'name matches');
  });

  await test('TC-B-004', 'PUT /api/cameras/:id — 200, updated name', async () => {
    const cam = await createCamera({ name: 'TC-B-004 Before', rtspUrl: 'rtsp://10.0.0.5:554/ch0' });
    const { status, body } = await put(`/api/cameras/${cam.id}`, { name: 'TC-B-004 After' });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.name, 'TC-B-004 After', 'updated name');
    // Verify persisted
    const verify = await get(`/api/cameras/${cam.id}`);
    assertEq(verify.body.data.name, 'TC-B-004 After', 'persisted name');
  });

  await test('TC-B-005', 'DELETE /api/cameras/:id — 200, camera removed', async () => {
    const cam = await createCamera({ name: 'TC-B-005 Del', rtspUrl: 'rtsp://10.0.0.6:554/ch0' });
    const delId = cam.id;
    const { status } = await del(`/api/cameras/${delId}`);
    assertEq(status, 200, 'HTTP status');
    // Remove from cleanup list (already deleted)
    const idx = createdCameraIds.indexOf(delId);
    if (idx !== -1) createdCameraIds.splice(idx, 1);
    // Verify removed
    const check = await get(`/api/cameras/${delId}`);
    assertEq(check.status, 404, 'GET deleted camera → 404');
  });

  await test('TC-B-006', 'POST /api/cameras/:id/stream/reconnect — 200', async () => {
    const cam = await createCamera({ name: 'TC-B-006 Recon', rtspUrl: 'rtsp://10.0.0.7:554/ch0' });
    const { status, body } = await post(`/api/cameras/${cam.id}/stream/reconnect`, {});
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
  });

  await test('TC-B-007', 'GET /api/cameras — no password fields exposed', async () => {
    await createCamera({
      name: 'TC-B-007 Pass', rtspUrl: 'rtsp://10.0.0.8:554/ch0',
      username: 'admin', password: 'secret123',
    });
    const { body } = await get('/api/cameras');
    for (const cam of body.data) {
      assert(cam.password === undefined || cam.password === null,
        `password exposed for camera ${cam.id}: ${cam.password}`);
    }
  });
}

// ── Group G — Edge Cases ─────────────────────────────────────────────────────

async function runGroupG() {
  console.log('\n[Group G] Edge Cases\n');

  await test('TC-G-001', 'POST /api/cameras — missing name → 400', async () => {
    const { status, body } = await post('/api/cameras', { rtspUrl: 'rtsp://10.0.0.9:554/ch0' });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-G-002', 'POST /api/cameras — missing rtspUrl → 400', async () => {
    const { status, body } = await post('/api/cameras', { name: 'TC-G-002 No URL' });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-G-003', 'GET /api/cameras/:id — non-existent → 404', async () => {
    const { status } = await get('/api/cameras/non-existent-id-00000000');
    assertEq(status, 404, 'HTTP status');
  });

  await test('TC-G-004', 'PUT /api/cameras/:id — non-existent → 404', async () => {
    const { status } = await put('/api/cameras/non-existent-id-00000000', { name: 'Ghost' });
    assertEq(status, 404, 'HTTP status');
  });

  await test('TC-G-005', 'DELETE /api/cameras/:id — non-existent → 404', async () => {
    const { status } = await del('/api/cameras/non-existent-id-00000000');
    assertEq(status, 404, 'HTTP status');
  });

  await test('TC-G-006', 'POST /api/cameras — missing both name and rtspUrl → 400', async () => {
    const { status, body } = await post('/api/cameras', {});
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-CAM-01 — Camera Discovery Tests             ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupB();
    await runGroupG();
  } finally {
    await cleanupAll();
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
