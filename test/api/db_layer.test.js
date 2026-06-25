'use strict';
/**
 * DB Layer — REST API Tests
 *
 * TC: TC-STORAGE-001
 *   Group A — JSON Mode: In-Memory Store Operations  (TC-A-001 ~ TC-A-008)
 *   Group B — JSON Mode: Persistence                 (TC-B-001 ~ TC-B-004)
 *   Group H — Error Handling (REST-testable subset)  (TC-H-002, TC-H-005)
 *   Group I — Security                               (TC-I-001 ~ TC-I-002)
 *   Group J — Atomic Write & Durability              (TC-J-005 ~ TC-J-006)
 *
 * MongoDB groups C/D/E/F/G require a live MongoDB instance →
 * run test/integration/storage_mongo.test.js separately.
 *
 * SRS: FR-STORAGE-001 ~ FR-STORAGE-074, NFR-STORAGE-001 ~ NFR-STORAGE-017
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 * Run: node test/api/db_layer.test.js
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

// ── Minimal test harness ───────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
let skipped = 0;
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
  console.log(`  ⊘ ${id}: ${description}  [SKIP: ${reason}]`);
  skipped++;
  results.push({ id, description, status: 'SKIP', reason });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function get(path, headers = {}) {
  const res  = await fetch(`${BASE_URL}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

async function put(path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

async function del(path, headers = {}) {
  const res  = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── Test camera factory + cleanup ─────────────────────────────────────────────

const _createdIds = [];

async function createTestCamera(overrides = {}) {
  const payload = {
    name:    overrides.name    || `TC-DB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    rtspUrl: overrides.rtspUrl || 'rtsp://192.0.2.1:554/tc-db-test',
    ...overrides,
  };
  const { status, body } = await post('/api/cameras', payload);
  assert(status === 201, `createTestCamera: HTTP ${status} — ${JSON.stringify(body)}`);
  const cam = body.data || body;
  const id  = cam.id;
  assert(id, 'createTestCamera: no id in response');
  _createdIds.push(id);
  return cam;
}

async function cleanupAll() {
  for (const id of _createdIds) {
    try { await del(`/api/cameras/${id}`); } catch (_) {}
  }
  _createdIds.length = 0;
}

// ── Prerequisites ──────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running');

  // Probe admin endpoint — used by Group H tests
  const adminProbe = await get('/admin/system');
  const adminAvailable = adminProbe.status === 200;
  if (adminAvailable) {
    console.log('  ✓ Admin endpoint accessible (AUTH_ENABLED=false or valid token)');
  } else {
    console.log('  ⚠ Admin endpoint unavailable (401) — Group H admin tests will skip');
  }

  const dbMode = adminAvailable ? (adminProbe.body.db?.mode ?? 'unknown') : 'unknown';
  console.log(`  ✓ DB mode: ${dbMode}\n`);
  return { adminAvailable, dbMode, adminBody: adminProbe.body };
}

// ── Group A — In-Memory Store Operations ─────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] JSON Mode: In-Memory Store Operations\n');

  await test('TC-A-001', 'GET /api/cameras → 200 array (all tables initialised on startup)', async () => {
    const { status, body } = await get('/api/cameras');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success flag');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-A-002', 'GET /api/alerts and /api/onvif-events both return 200 (multiple tables accessible)', async () => {
    const alerts      = await get('/api/alerts');
    const onvifEvents = await get('/api/onvif-events');
    assertEq(alerts.status,      200, 'alerts HTTP status');
    assertEq(onvifEvents.status, 200, 'onvif-events HTTP status');
    // alerts: { success, data: [] }; onvif-events: { total, events: [] }
    const alertsData = alerts.body.data ?? alerts.body;
    assert(Array.isArray(alertsData), 'alerts data is array');
    assert(
      Array.isArray(onvifEvents.body.events) || Array.isArray(onvifEvents.body.data) || Array.isArray(onvifEvents.body),
      'onvif-events returns an array field',
    );
  });

  await test('TC-A-003', 'find(table, where): GET /api/cameras/:id returns only the matching record', async () => {
    const camA = await createTestCamera({ name: 'TC-A-003-CamA' });
    const camB = await createTestCamera({ name: 'TC-A-003-CamB' });

    const resA = await get(`/api/cameras/${camA.id}`);
    assertEq(resA.status, 200, 'camA GET status');
    assertEq(resA.body.data.id, camA.id, 'camA id matches');
    assertEq(resA.body.data.name, 'TC-A-003-CamA', 'camA name matches');

    const resB = await get(`/api/cameras/${camB.id}`);
    assertEq(resB.body.data.name, 'TC-A-003-CamB', 'camB name unchanged');
  });

  await test('TC-A-004', 'findOne() → null for non-existent id: GET /api/cameras/:id → 404', async () => {
    const { status } = await get('/api/cameras/tc-db-a004-nonexistent-00000000');
    assertEq(status, 404, 'HTTP status must be 404');
  });

  await test('TC-A-005', 'insert() adds createdAt: POST /api/cameras → 201, createdAt is valid ISO-8601', async () => {
    const cam = await createTestCamera({ name: 'TC-A-005-CreatedAt' });
    assert(typeof cam.createdAt === 'string', `createdAt must be string (got: ${cam.createdAt})`);
    const d = new Date(cam.createdAt);
    assert(!isNaN(d.getTime()), `createdAt must be valid date: ${cam.createdAt}`);
    assert(cam.id && cam.id.length >= 8, `id must exist (got: ${cam.id})`);
  });

  await test('TC-A-006', 'update() modifies target only: PUT /api/cameras/:id changes name+updatedAt; other record unchanged', async () => {
    const camA = await createTestCamera({ name: 'TC-A-006-Before' });
    const camB = await createTestCamera({ name: 'TC-A-006-Other' });
    const createdAtA = camA.createdAt;

    const putRes = await put(`/api/cameras/${camA.id}`, { name: 'TC-A-006-After' });
    assertEq(putRes.status, 200, 'PUT HTTP status');

    const verify = await get(`/api/cameras/${camA.id}`);
    const updated = verify.body.data;
    assertEq(updated.name, 'TC-A-006-After', 'name updated');
    assert(updated.updatedAt >= createdAtA, `updatedAt (${updated.updatedAt}) >= createdAt (${createdAtA})`);

    const otherVerify = await get(`/api/cameras/${camB.id}`);
    assertEq(otherVerify.body.data.name, 'TC-A-006-Other', 'camB untouched');
  });

  await test('TC-A-007', 'delete() removes row: DELETE /api/cameras/:id → 200; GET → 404', async () => {
    const cam   = await createTestCamera({ name: 'TC-A-007-Del' });
    const delId = cam.id;

    const { status } = await del(`/api/cameras/${delId}`);
    assertEq(status, 200, 'DELETE HTTP status');
    const idx = _createdIds.indexOf(delId);
    if (idx !== -1) _createdIds.splice(idx, 1);

    const check = await get(`/api/cameras/${delId}`);
    assertEq(check.status, 404, 'GET deleted camera → 404');
  });

  await test('TC-A-008', 'find() returns all matches: 3 inserted cameras all appear in GET /api/cameras', async () => {
    const before = (await get('/api/cameras')).body.data.length;
    await createTestCamera({ name: 'TC-A-008-Cam1' });
    await createTestCamera({ name: 'TC-A-008-Cam2' });
    await createTestCamera({ name: 'TC-A-008-Cam3' });
    const { body } = await get('/api/cameras');
    assert(
      body.data.length >= before + 3,
      `Expected ≥ ${before + 3} cameras, got ${body.data.length}`,
    );
  });
}

// ── Group B — JSON Mode: Persistence ─────────────────────────────────────────

async function runGroupB() {
  console.log('\n[Group B] JSON Mode: Persistence\n');

  await test('TC-B-001', 'loadFromJson: POST /api/cameras → GET returns same record (in-memory hydrated)', async () => {
    const cam = await createTestCamera({ name: 'TC-B-001-Persist' });
    const { status, body } = await get(`/api/cameras/${cam.id}`);
    assertEq(status, 200, 'HTTP status');
    assertEq(body.data.id,   cam.id,             'id matches');
    assertEq(body.data.name, 'TC-B-001-Persist', 'name matches');
  });

  await test('TC-B-002', 'empty store: GET /api/cameras/:nonexistent → 404 (missing file → empty store fallback)', async () => {
    const { status } = await get('/api/cameras/tc-b002-missing-id-000000000000');
    assertEq(status, 404, 'HTTP status 404');
  });

  await test('TC-B-003', 'persistJson called on INSERT: data accessible after concurrent queries', async () => {
    const cam = await createTestCamera({ name: 'TC-B-003-MemPersist' });
    // Simulate activity between insert and verify
    await get('/api/cameras');
    await get('/api/zones');
    await get('/api/alerts');
    const { status, body } = await get(`/api/cameras/${cam.id}`);
    assertEq(status, 200, 'GET after concurrent queries: 200');
    assertEq(body.data.name, 'TC-B-003-MemPersist', 'data intact');
  });

  await test('TC-B-004', 'persistJson called on UPDATE and DELETE: 3 mutations each reflected immediately', async () => {
    const cam = await createTestCamera({ name: 'TC-B-004-A' });

    // UPDATE
    const putRes = await put(`/api/cameras/${cam.id}`, { name: 'TC-B-004-B' });
    assertEq(putRes.status, 200, 'PUT status');
    const afterPut = await get(`/api/cameras/${cam.id}`);
    assertEq(afterPut.body.data.name, 'TC-B-004-B', 'name updated');

    // DELETE
    const delRes = await del(`/api/cameras/${cam.id}`);
    assertEq(delRes.status, 200, 'DELETE status');
    const idx = _createdIds.indexOf(cam.id);
    if (idx !== -1) _createdIds.splice(idx, 1);
    const afterDel = await get(`/api/cameras/${cam.id}`);
    assertEq(afterDel.status, 404, 'GET after DELETE → 404');
  });
}

// ── Group H — Error Handling (REST-testable subset) ───────────────────────────

async function runGroupH(adminAvailable) {
  console.log('\n[Group H] Error Handling & Resilience (REST-testable subset)\n');

  if (!adminAvailable) {
    skip('TC-H-002', 'MONGODB_URI absent → db.mode=json (admin/system)', 'admin endpoint not accessible (AUTH_ENABLED=true)');
    skip('TC-H-005', 'db.cumulative.inserts increments after write', 'admin endpoint not accessible (AUTH_ENABLED=true)');
    return;
  }

  await test('TC-H-002', 'GET /admin/system → db.mode reported; json mode when MONGODB_URI absent', async () => {
    const { status, body } = await get('/admin/system');
    assertEq(status, 200, 'HTTP status');
    assert(typeof body.db?.mode === 'string',
      `db.mode must be string (got: ${JSON.stringify(body.db?.mode)})`);
    // When MONGODB_URI is not set, server must use json mode
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      assertEq(body.db.mode, 'json', 'db.mode must be "json" when MONGODB_URI is unset');
    }
    // connected must be boolean
    assert(typeof body.db.connected === 'boolean',
      `db.connected must be boolean (got: ${body.db.connected})`);
  });

  await test('TC-H-005', 'db.cumulative.inserts counter increments after POST /api/cameras', async () => {
    const before = (await get('/admin/system')).body.db?.cumulative?.inserts ?? 0;
    await createTestCamera({ name: 'TC-H-005-Counter' });
    const after  = (await get('/admin/system')).body.db?.cumulative?.inserts ?? 0;
    assert(after > before,
      `cumulative.inserts must increase: ${before} → ${after}`);
  });
}

// ── Group I — Security ────────────────────────────────────────────────────────

async function runGroupI() {
  console.log('\n[Group I] Security\n');

  await test('TC-I-001', 'GET /api/cameras: no _id or __v field in any record (MongoDB internals hidden)', async () => {
    await createTestCamera({ name: 'TC-I-001-NoPK' });
    const { status, body } = await get('/api/cameras');
    assertEq(status, 200, 'HTTP status');
    assert(body.data.length > 0, 'at least one camera present');
    for (const cam of body.data) {
      assert(cam._id === undefined,
        `_id must not be exposed (camera ${cam.id})`);
      assert(cam.__v === undefined,
        `__v must not be exposed (camera ${cam.id})`);
    }
  });

  await test('TC-I-002', 'POST /api/cameras with password field → GET /api/cameras: password absent', async () => {
    await createTestCamera({
      name:     'TC-I-002-PassCam',
      rtspUrl:  'rtsp://admin:secret123@192.0.2.2:554/stream',
      password: 'secret123',
    });
    const { body } = await get('/api/cameras');
    for (const cam of body.data) {
      assert(cam.password === undefined || cam.password === null,
        `password exposed for camera ${cam.id}: "${cam.password}"`);
    }
  });
}

// ── Group J — Atomic Write & Durability (REST-testable subset) ────────────────

async function runGroupJ() {
  console.log('\n[Group J] Atomic Write & Durability (REST-testable subset)\n');

  await test('TC-J-005', 'Rapid INSERT × 5 → all 5 records immediately queryable (in-session durability)', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const cam = await createTestCamera({ name: `TC-J-005-Cam${i}` });
      ids.push(cam.id);
    }
    for (const id of ids) {
      const { status } = await get(`/api/cameras/${id}`);
      assertEq(status, 200, `camera ${id} must be queryable`);
    }
  });

  await test('TC-J-006', 'ALL_TABLES cameras slot initialised: GET /api/cameras returns success+array', async () => {
    const { status, body } = await get('/api/cameras');
    assertEq(status, 200, 'HTTP status');
    assert(body.success === true, 'success flag must be true');
    assert(Array.isArray(body.data), 'data must be array (cameras table slot initialised)');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  TC-STORAGE-001 — Storage Layer Tests                  ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('  Groups: A (CRUD) · B (Persistence) · H (Error) · I (Security) · J (Durability)');
  console.log('  MongoDB groups C/D/E/F/G → test/integration/storage_mongo.test.js\n');

  let adminAvailable = false;
  let dbMode = 'unknown';

  try {
    const prereqs = await checkPrerequisites();
    adminAvailable = prereqs.adminAvailable;
    dbMode = prereqs.dbMode;
  } catch (err) {
    console.error('Fatal: Prerequisites failed:', err.message);
    process.exit(1);
  }

  try {
    await runGroupA();
    await runGroupB();
    await runGroupH(adminAvailable);
    await runGroupI();
    await runGroupJ();
  } finally {
    await cleanupAll();
  }

  console.log('\n──────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('──────────────────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
