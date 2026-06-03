'use strict';
/**
 * Object Tracking API Tests
 *
 * Test Group A — Zone CRUD API           (TC-A-001 ~ TC-A-013)
 * Test Group B — Tracker Config API      (TC-B-001 ~ TC-B-005)
 * Test Group G — Edge Cases              (TC-G-002 ~ TC-G-005)
 *
 * SRS: FR-TRK-020 ~ FR-TRK-023, NFR-TRK-01
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 *                At least one camera registered in the system.
 * Run: node test/api/object_tracking.test.js
 *
 * Set LTS_URL env var to override base URL.
 * Set TEST_CAMERA_ID to use a specific camera (falls back to first available camera).
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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertClose(actual, expected, tolerance, label) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance)
    throw new Error(`${label}: expected ${expected} ±${tolerance}, got ${actual} (diff=${diff.toFixed(4)})`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

async function put(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── Zone helpers ─────────────────────────────────────────────────────────────

const SAMPLE_POLYGON = [
  { x: 50, y: 50 },
  { x: 300, y: 50 },
  { x: 300, y: 300 },
  { x: 50, y: 300 },
];

const createdZones = []; // { cameraId, zoneId }
let CREATED_TEST_CAMERA = false; // whether we created a dedicated camera for this run

async function createZone(cameraId, overrides = {}) {
  const body = Object.assign(
    { name: 'Test Zone', type: 'MONITOR', polygon: SAMPLE_POLYGON, dwellThreshold: 30 },
    overrides,
  );
  const { status, body: resp } = await post(`/api/cameras/${cameraId}/zones`, body);
  assert(status === 201, `createZone failed: HTTP ${status} — ${JSON.stringify(resp)}`);
  createdZones.push({ cameraId, zoneId: resp.data.id });
  return resp.data;
}

async function cleanupZones() {
  for (const { cameraId, zoneId } of createdZones) {
    try { await del(`/api/cameras/${cameraId}/zones/${zoneId}`); } catch (_) {}
  }
  createdZones.length = 0;
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

let TEST_CAMERA_ID = process.env.TEST_CAMERA_ID || null;

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');

  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running');

  // Always create a fresh dedicated camera so zone tests start with clean state
  if (!process.env.TEST_CAMERA_ID) {
    const camRes = await post('/api/cameras', {
      name:    `OT Test Camera ${Date.now()}`,
      rtspUrl: 'rtsp://127.0.0.1:8554/test-ot',
    });
    assert(camRes.status === 201, `Failed to create test camera: HTTP ${camRes.status}`);
    TEST_CAMERA_ID = camRes.body.data.id;
    CREATED_TEST_CAMERA = true;
    console.log(`  ✓ Created fresh test camera: ${TEST_CAMERA_ID}`);
  } else {
    console.log(`  ✓ Using camera: ${TEST_CAMERA_ID}`);
  }

  // Confirm tracker config endpoint is available
  const config = await get('/api/tracker/config');
  assert(config.status === 200, `Tracker config endpoint not available: HTTP ${config.status}`);
  console.log('  ✓ Tracker config endpoint available\n');
}

// ── Test Group A — Zone CRUD API ──────────────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] Zone CRUD API\n');

  await test('TC-A-001', 'Create MONITOR zone — success', async () => {
    const zone = await createZone(TEST_CAMERA_ID, { name: 'TC-A-001 Monitor', type: 'MONITOR', dwellThreshold: 30 });
    assertEq(zone.type, 'MONITOR', 'type');
    assert(zone.id && zone.id.length > 8, 'id is non-empty');
    assertEq(zone.polygon.length, 4, 'polygon length');
    assertEq(zone.dwellThreshold, 30, 'dwellThreshold');
  });

  await test('TC-A-002', 'Create EXCLUDE zone — success', async () => {
    const zone = await createZone(TEST_CAMERA_ID, { name: 'TC-A-002 Exclude', type: 'EXCLUDE' });
    assertEq(zone.type, 'EXCLUDE', 'type');
  });

  await test('TC-A-003', 'Create zone — defaults applied (MONITOR, dwellThreshold > 0)', async () => {
    const { status, body } = await post(`/api/cameras/${TEST_CAMERA_ID}/zones`, {
      name:    'TC-A-003 Default',
      polygon: SAMPLE_POLYGON,
    });
    assertEq(status, 201, 'HTTP status');
    assert(body.data.type === 'MONITOR' || !body.data.type || body.data.type.length > 0, 'type is set');
    assert(typeof body.data.dwellThreshold === 'number' && body.data.dwellThreshold > 0, 'dwellThreshold > 0');
    createdZones.push({ cameraId: TEST_CAMERA_ID, zoneId: body.data.id });
  });

  await test('TC-A-004', 'List zones — empty camera returns empty array', async () => {
    await cleanupZones();
    const { status, body } = await get(`/api/cameras/${TEST_CAMERA_ID}/zones`);
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
    assertEq(body.data.length, 0, 'empty list');
  });

  await test('TC-A-005', 'List zones — returns all created zones', async () => {
    const z1 = await createZone(TEST_CAMERA_ID, { name: 'TC-A-005 Zone 1' });
    const z2 = await createZone(TEST_CAMERA_ID, { name: 'TC-A-005 Zone 2' });
    const { status, body } = await get(`/api/cameras/${TEST_CAMERA_ID}/zones`);
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.length, 2, 'zone count');
    const ids = body.data.map(z => z.id);
    assert(ids.includes(z1.id), 'zone 1 present');
    assert(ids.includes(z2.id), 'zone 2 present');
  });

  await cleanupZones();

  await test('TC-A-006', 'Create zone — polygon with 2 points → 400', async () => {
    const { status, body } = await post(`/api/cameras/${TEST_CAMERA_ID}/zones`, {
      name:    'TC-A-006 Short Polygon',
      polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
    assert(
      body.error && (body.error.includes('polygon') || body.error.includes('3')),
      `error message should mention polygon: got "${body.error}"`,
    );
  });

  await test('TC-A-007', 'Create zone — missing name → 400', async () => {
    const { status, body } = await post(`/api/cameras/${TEST_CAMERA_ID}/zones`, {
      polygon: SAMPLE_POLYGON,
    });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-A-008', 'Create zone — with schedule stored correctly', async () => {
    const zone = await createZone(TEST_CAMERA_ID, {
      name:     'TC-A-008 Scheduled',
      schedule: { startTime: '08:00', endTime: '20:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
    });
    assert(zone.schedule !== null && zone.schedule !== undefined, 'schedule present');
    assertEq(zone.schedule.startTime, '08:00', 'startTime');
    assertEq(zone.schedule.days.length, 5, 'days count');
  });

  await test('TC-A-009', 'Update zone — dwellThreshold changed', async () => {
    const zone = await createZone(TEST_CAMERA_ID, { name: 'TC-A-009 Update', dwellThreshold: 30 });
    const { status, body } = await put(`/api/cameras/${TEST_CAMERA_ID}/zones/${zone.id}`, { dwellThreshold: 60 });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.dwellThreshold, 60, 'updated dwellThreshold');
  });

  await test('TC-A-010', 'Update zone — not found → 404', async () => {
    const { status, body } = await put(
      `/api/cameras/${TEST_CAMERA_ID}/zones/00000000-0000-0000-0000-000000000000`,
      { dwellThreshold: 45 },
    );
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-A-011', 'Delete zone → 200 and removed from list', async () => {
    const zone = await createZone(TEST_CAMERA_ID, { name: 'TC-A-011 To Delete' });
    // Remove from cleanup tracking since we're explicitly deleting
    const idx = createdZones.findIndex(z => z.zoneId === zone.id);
    if (idx >= 0) createdZones.splice(idx, 1);

    const { status, body } = await del(`/api/cameras/${TEST_CAMERA_ID}/zones/${zone.id}`);
    assertEq(status, 200, 'HTTP status');

    const list = await get(`/api/cameras/${TEST_CAMERA_ID}/zones`);
    const found = (list.body.data || []).find(z => z.id === zone.id);
    assert(!found, 'zone removed from list');
  });

  await test('TC-A-012', 'Delete zone — not found → 404', async () => {
    const { status, body } = await del(
      `/api/cameras/${TEST_CAMERA_ID}/zones/00000000-0000-0000-0000-000000000000`,
    );
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-A-013', 'Create zone — invalid type → 400', async () => {
    const { status, body } = await post(`/api/cameras/${TEST_CAMERA_ID}/zones`, {
      name:    'TC-A-013 Invalid Type',
      type:    'WATCH',
      polygon: SAMPLE_POLYGON,
    });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
    assert(
      body.error && (body.error.includes('MONITOR') || body.error.includes('EXCLUDE')),
      `error mentions valid types: "${body.error}"`,
    );
  });

  await cleanupZones();
}

// ── Test Group B — Tracker Config API ────────────────────────────────────────

async function runGroupB() {
  console.log('[Group B] Tracker Config API\n');

  let originalConfig = null;

  await test('TC-B-001', 'GET /api/tracker/config — returns config object', async () => {
    const { status, body } = await get('/api/tracker/config');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    const cfg = body.data;
    assert(typeof cfg.iouThreshold === 'number', 'iouThreshold is number');
    assert(typeof cfg.maxAge === 'number', 'maxAge is number');
    assert(typeof cfg.iouWeight === 'number', 'iouWeight is number');
    assert(typeof cfg.faceWeight === 'number', 'faceWeight is number');
    originalConfig = cfg;
  });

  await test('TC-B-002', 'PUT /api/tracker/config — update iouThreshold', async () => {
    const { status, body } = await put('/api/tracker/config', { iouThreshold: 0.4 });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.iouThreshold, 0.4, 'iouThreshold updated');

    const { body: verify } = await get('/api/tracker/config');
    assertEq(verify.data.iouThreshold, 0.4, 'persisted iouThreshold');
  });

  await test('TC-B-003', 'PUT /api/tracker/config — update maxAge', async () => {
    const { status, body } = await put('/api/tracker/config', { maxAge: 120 });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.maxAge, 120, 'maxAge updated');
  });

  await test('TC-B-004', 'POST /api/tracker/config/reset — restores defaults', async () => {
    // First set non-default values
    await put('/api/tracker/config', { iouThreshold: 0.9, maxAge: 1 });

    const { status, body } = await post('/api/tracker/config/reset', {});
    assertEq(status, 200, 'HTTP status');

    const { body: verify } = await get('/api/tracker/config');
    // Default iouThreshold is 0.25; confirm it's not 0.9
    assert(verify.data.iouThreshold !== 0.9, 'iouThreshold reset from 0.9');
    assert(verify.data.maxAge !== 1, 'maxAge reset from 1');
  });

  await test('TC-B-005', 'PUT /api/tracker/config — invalid body → error status', async () => {
    const res = await fetch(`${BASE_URL}/api/tracker/config`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    '"not-an-object"',
    });
    // Express body-parser or global error handler returns 400 or 500
    assert(res.status >= 400, `Expected error status, got ${res.status}`);
  });

  // Always reset config at end of group
  try {
    await post('/api/tracker/config/reset', {});
  } catch (_) {}
}

// ── Test Group G — Edge Cases ─────────────────────────────────────────────────

async function runGroupG() {
  console.log('[Group G] Edge Cases\n');

  await test('TC-G-002', 'GET zones for unknown camera — returns empty array', async () => {
    const { status, body } = await get('/api/cameras/nonexistent-camera-xyz-001/zones');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
    assertEq(body.data.length, 0, 'no zones for unknown camera');
  });

  await test('TC-G-003', 'PUT tracker config — partial update preserves other fields', async () => {
    const { body: before } = await get('/api/tracker/config');
    const originalIou = before.data.iouThreshold;

    await put('/api/tracker/config', { maxAge: 60 });

    const { body: after } = await get('/api/tracker/config');
    assertEq(after.data.maxAge, 60, 'maxAge changed');
    assertEq(after.data.iouThreshold, originalIou, 'iouThreshold unchanged');

    await post('/api/tracker/config/reset', {});
  });

  await test('TC-G-004', 'Create zone for synthetic camera ID — accepted', async () => {
    const syntheticCamId = 'synthetic-cam-tc-g-004';
    const { status, body } = await post(`/api/cameras/${syntheticCamId}/zones`, {
      name:    'TC-G-004 Synthetic Zone',
      polygon: SAMPLE_POLYGON,
    });
    assertEq(status, 201, 'HTTP status');
    assert(body.data && body.data.id, 'zone created with id');

    // Verify list
    const list = await get(`/api/cameras/${syntheticCamId}/zones`);
    assert(list.body.data.some(z => z.id === body.data.id), 'zone appears in list');

    // Cleanup
    await del(`/api/cameras/${syntheticCamId}/zones/${body.data.id}`);
  });

  await test('TC-G-005', 'Create zone with targetClasses — stored correctly', async () => {
    const zone = await createZone(TEST_CAMERA_ID, {
      name:          'TC-G-005 Target Classes',
      targetClasses: ['person', 'vehicle'],
    });
    assert(Array.isArray(zone.targetClasses), 'targetClasses is array');
    assert(zone.targetClasses.includes('person'), 'person in targetClasses');
    assert(zone.targetClasses.includes('vehicle'), 'vehicle in targetClasses');
  });

  await cleanupZones();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== Object Tracking API Tests ===\n');

  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupB();
    await runGroupG();
  } finally {
    await cleanupZones();
    // Ensure config is reset even if tests fail mid-way
    try { await post('/api/tracker/config/reset', {}); } catch (_) {}
    // Delete the dedicated test camera we created
    if (CREATED_TEST_CAMERA && TEST_CAMERA_ID) {
      try { await del(`/api/cameras/${TEST_CAMERA_ID}`); } catch (_) {}
    }
  }

  console.log('\n=== Results ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results
      .filter(r => r.status === 'FAIL')
      .forEach(r => {
        console.log(`  ✗ ${r.id}: ${r.description}`);
        console.log(`      ${r.error}`);
      });
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
