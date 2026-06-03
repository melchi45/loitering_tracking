'use strict';
/**
 * Main System REST API Tests
 *
 * TC: TC-LTS-MAIN-01
 *   Group D — Behavior & Zone Layer    (TC-D-011 ~ TC-D-014)  — Zone CRUD / validation
 *   Group E — Alert & Storage Layer    (TC-E-003 ~ TC-E-004)  — Alert GET / acknowledge
 *   Group F — REST API                 (TC-F-001 ~ TC-F-005)  — Camera, zones, events, tracker, system
 *   Group H — Storage Persistence      (TC-H-002 ~ TC-H-003)  — Events filter, tracker config persist
 *
 * Note: Groups A-C (ingestion, AI, tracking), G (Socket.IO), H-001 (restart persistence),
 *       I (performance) require live cameras and are covered in Phase-2/3 integration tests.
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 * Run: node test/api/main_system.test.js
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

// ── Fixtures & cleanup ───────────────────────────────────────────────────────

const SAMPLE_POLYGON = [
  { x: 50,  y: 50  },
  { x: 300, y: 50  },
  { x: 300, y: 300 },
  { x: 50,  y: 300 },
];

const createdCameraIds = [];
const createdZones = []; // { cameraId, zoneId }
let testCameraId = null;

async function ensureTestCamera() {
  if (testCameraId) return testCameraId;
  const { status, body } = await post('/api/cameras', {
    name: 'TC-MAIN System Test Camera',
    rtspUrl: 'rtsp://192.168.1.200:554/main',
  });
  assert(status === 201, `Failed to create test camera: HTTP ${status}`);
  testCameraId = body.data.id;
  createdCameraIds.push(testCameraId);
  return testCameraId;
}

async function createZone(cameraId, overrides = {}) {
  const payload = {
    name:           overrides.name           || 'TC Zone',
    polygon:        overrides.polygon        || SAMPLE_POLYGON,
    type:           overrides.type           || 'MONITOR',
    dwellThreshold: overrides.dwellThreshold || 30,
    ...overrides,
  };
  const { status, body } = await post(`/api/cameras/${cameraId}/zones`, payload);
  assert(status === 201, `createZone failed: HTTP ${status} — ${JSON.stringify(body)}`);
  createdZones.push({ cameraId, zoneId: body.data.id });
  return body.data;
}

async function cleanupAll() {
  // Delete zones
  for (const { cameraId, zoneId } of createdZones) {
    try { await del(`/api/cameras/${cameraId}/zones/${zoneId}`); } catch (_) {}
  }
  createdZones.length = 0;

  // Delete cameras
  for (const id of createdCameraIds) {
    try { await del(`/api/cameras/${id}`); } catch (_) {}
  }
  createdCameraIds.length = 0;
  testCameraId = null;
}

// ── Prerequisites ────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running\n');
}

// ── Group D — Zone CRUD & Validation ─────────────────────────────────────────

async function runGroupD() {
  console.log('[Group D] Zone CRUD & Validation\n');

  const cameraId = await ensureTestCamera();

  let zone1;
  await test('TC-D-ZONE-001', 'POST zone — 201 with MONITOR type', async () => {
    zone1 = await createZone(cameraId, { name: 'TC-D-ZONE-001 Monitor', type: 'MONITOR' });
    assertEq(zone1.type, 'MONITOR', 'type');
    assert(zone1.id, 'id present');
  });

  await test('TC-D-ZONE-002', 'POST zone — EXCLUDE type accepted', async () => {
    const zone = await createZone(cameraId, { name: 'TC-D-ZONE-002 Exclude', type: 'EXCLUDE' });
    assertEq(zone.type, 'EXCLUDE', 'type');
  });

  await test('TC-D-011', 'POST zone — polygon with 2 vertices → 400', async () => {
    const { status, body } = await post(`/api/cameras/${cameraId}/zones`, {
      name: 'TC-D-011 Bad Polygon',
      polygon: [{ x: 0, y: 0 }, { x: 100, y: 100 }], // only 2 points
    });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-D-ZONE-003', 'GET /api/cameras/:id/zones — returns array with created zones', async () => {
    const { status, body } = await get(`/api/cameras/${cameraId}/zones`);
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
    assert(body.data.length >= 1, `at least 1 zone (got ${body.data.length})`);
  });

  await test('TC-D-014', '50 zones per camera — create 5 zones (sampled limit test)', async () => {
    const before = (await get(`/api/cameras/${cameraId}/zones`)).body.data.length;
    const toCreate = 5;
    for (let i = 0; i < toCreate; i++) {
      await createZone(cameraId, { name: `TC-D-014 Zone ${i}` });
    }
    const after = (await get(`/api/cameras/${cameraId}/zones`)).body.data.length;
    assert(after >= before + toCreate, `expected +${toCreate} zones, got ${after - before}`);
  });

  await test('TC-D-ZONE-004', 'PUT /api/cameras/:id/zones/:zoneId — 200, updated name', async () => {
    if (!zone1) { console.log('      (skipped)'); return; }
    const { status, body } = await put(
      `/api/cameras/${cameraId}/zones/${zone1.id}`,
      { name: 'TC-D-ZONE-004 Updated' }
    );
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.name, 'TC-D-ZONE-004 Updated', 'updated name');
  });

  await test('TC-D-012', 'Zone with schedule fields accepted', async () => {
    const zone = await createZone(cameraId, {
      name: 'TC-D-012 Scheduled',
      schedule: { startTime: '22:00', endTime: '06:00', days: ['Mon', 'Tue'] },
    });
    assert(zone.id, 'zone created with schedule');
  });

  await test('TC-D-013', 'Zone with targetClasses field accepted', async () => {
    const zone = await createZone(cameraId, {
      name: 'TC-D-013 TargetClass',
      targetClasses: ['person'],
    });
    assert(zone.id, 'zone created with targetClasses');
  });

  await test('TC-D-ZONE-005', 'DELETE /api/cameras/:id/zones/:zoneId — 200, removed', async () => {
    const zone = await createZone(cameraId, { name: 'TC-D-ZONE-005 Delete' });
    const { status } = await del(`/api/cameras/${cameraId}/zones/${zone.id}`);
    assertEq(status, 200, 'HTTP status');
    // Remove from cleanup list
    const idx = createdZones.findIndex(z => z.zoneId === zone.id);
    if (idx !== -1) createdZones.splice(idx, 1);
    // Verify removed
    const list = await get(`/api/cameras/${cameraId}/zones`);
    const found = list.body.data.find(z => z.id === zone.id);
    assert(!found, 'zone removed from list');
  });

  await test('TC-D-ZONE-006', 'POST zone — invalid type → 400', async () => {
    const { status, body } = await post(`/api/cameras/${cameraId}/zones`, {
      name: 'TC-D-ZONE-006 BadType',
      polygon: SAMPLE_POLYGON,
      type: 'INVALID_TYPE',
    });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });
}

// ── Group E — Alerts ─────────────────────────────────────────────────────────

async function runGroupE() {
  console.log('\n[Group E] Alerts API\n');

  await test('TC-E-003', 'GET /api/alerts → 200 with data array', async () => {
    const { status, body } = await get('/api/alerts');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
    assert(typeof body.count === 'number', 'count is number');
  });

  await test('TC-E-FILTER-001', 'GET /api/alerts?acknowledged=false — filter works', async () => {
    const { status, body } = await get('/api/alerts?acknowledged=false');
    assertEq(status, 200, 'HTTP status');
    for (const alert of body.data) {
      assert(!alert.acknowledged, `alert ${alert.id} should not be acknowledged`);
    }
  });

  await test('TC-E-FILTER-002', 'GET /api/alerts?acknowledged=true — filter works', async () => {
    const { status, body } = await get('/api/alerts?acknowledged=true');
    assertEq(status, 200, 'HTTP status');
    for (const alert of body.data) {
      assert(alert.acknowledged, `alert ${alert.id} should be acknowledged`);
    }
  });

  await test('TC-E-004', 'POST /api/alerts/:id/acknowledge — non-existent → 404', async () => {
    const { status } = await post('/api/alerts/non-existent-id/acknowledge', {});
    assertEq(status, 404, 'HTTP status');
  });

  // If unacknowledged alerts exist, try acknowledging the first one
  await test('TC-E-ACK', 'Acknowledge first unacknowledged alert (if any)', async () => {
    const { body } = await get('/api/alerts?acknowledged=false&limit=1');
    if (body.data.length === 0) {
      console.log('      (skipped: no unacknowledged alerts present)');
      return;
    }
    const alertId = body.data[0].id;
    const { status, body: ackBody } = await post(`/api/alerts/${alertId}/acknowledge`, {});
    assertEq(status, 200, 'HTTP status');
    assertEq(ackBody.success, true, 'success');
    // Verify it's now acknowledged
    const verify = await get(`/api/alerts?acknowledged=true`);
    const found = verify.body.data.find(a => a.id === alertId);
    assert(found, 'alert now in acknowledged list');
  });
}

// ── Group F — REST API (Events & Tracker) ───────────────────────────────────

async function runGroupF() {
  console.log('\n[Group F] Events & Tracker Config API\n');

  await test('TC-F-003-EVENTS', 'GET /api/events → 200 with data array', async () => {
    const { status, body } = await get('/api/events');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
    assert(typeof body.count === 'number', 'count is number');
  });

  await test('TC-F-003-FILTER', 'GET /api/events?cameraId=xxx — filter returns only that camera', async () => {
    const { status, body } = await get('/api/events?cameraId=non-existent-cam');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.length, 0, 'empty result for non-existent camera');
  });

  await test('TC-F-003-LIMIT', 'GET /api/events?limit=5 — respects limit', async () => {
    const { body } = await get('/api/events?limit=5');
    assert(body.data.length <= 5, `data length ≤ 5 (got ${body.data.length})`);
  });

  let savedConfig;
  await test('TC-F-004-GET', 'GET /api/tracker/config → 200 with config object', async () => {
    const { status, body } = await get('/api/tracker/config');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(body.data && typeof body.data === 'object', 'data is object');
    savedConfig = { ...body.data };
  });

  await test('TC-F-004-PUT', 'PUT /api/tracker/config — 200, value updated', async () => {
    const { status, body } = await put('/api/tracker/config', { maxAge: 100 });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    // Verify persisted
    const verify = await get('/api/tracker/config');
    assertEq(verify.body.data.maxAge, 100, 'maxAge persisted');
  });

  await test('TC-F-004-RESET', 'POST /api/tracker/config/reset → 200, defaults restored', async () => {
    const { status, body } = await post('/api/tracker/config/reset', {});
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(body.data && typeof body.data === 'object', 'data is object after reset');
  });

  // Restore original config
  if (savedConfig) {
    await put('/api/tracker/config', savedConfig).catch(() => {});
  }
}

// ── Group H — Storage Persistence ────────────────────────────────────────────

async function runGroupH() {
  console.log('\n[Group H] Storage & Persistence\n');

  await test('TC-H-002', 'Events support cameraId filter (FR-MAIN-091)', async () => {
    const { status, body } = await get('/api/events?cameraId=test-cam-id-00000');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data array');
    // All returned events should match cameraId
    for (const ev of body.data) {
      assertEq(ev.cameraId, 'test-cam-id-00000', 'cameraId filter applied');
    }
  });

  await test('TC-H-003', 'Tracker config persists after PUT (FR-MAIN-092)', async () => {
    // Put a unique value
    const uniqueVal = 77;
    await put('/api/tracker/config', { maxAge: uniqueVal });
    // Read it back
    const { body } = await get('/api/tracker/config');
    assertEq(body.data.maxAge, uniqueVal, 'maxAge persisted');
    // Restore with reset
    await post('/api/tracker/config/reset', {});
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-MAIN-01 — Main System REST API Tests        ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    await runGroupD();
    await runGroupE();
    await runGroupF();
    await runGroupH();
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
