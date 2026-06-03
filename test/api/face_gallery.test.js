'use strict';
/**
 * Test Group A — Gallery CRUD API
 * Test Group E — Cross-Camera Re-ID API
 *
 * TC: TC-A-001 ~ TC-A-013, TC-E-001 ~ TC-E-003
 * SRS: FR-FAC-001 ~ FR-FAC-004, FR-FAC-043
 *
 * Prerequisites: Server running on BASE_URL
 * Run: node test/api/face_gallery.test.js
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
  return { status: res.status, body: await res.json() };
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}

// ── Cleanup helpers ─────────────────────────────────────────────────────────

const createdGalleries = [];

async function createGallery(name, type = 'general') {
  const { status, body } = await post('/api/galleries', { name, type });
  assert(status === 201, `createGallery failed: ${status} ${JSON.stringify(body)}`);
  createdGalleries.push(body.data.id);
  return body.data;
}

async function cleanupAll() {
  for (const id of createdGalleries) {
    try { await del(`/api/galleries/${id}`); } catch (_) {}
  }
  createdGalleries.length = 0;
}

// ── Prerequisite check ──────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');

  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running');

  const caps = await get('/api/capabilities');
  assert(caps.body.ai?.face === true, 'Face capability not available (models missing?)');
  console.log('  ✓ Face capability available');

  const galleries = await get('/api/galleries');
  assert(Array.isArray(galleries.body.data), 'Gallery list is not an array');
  if (galleries.body.data.length > 0) {
    console.warn(`  ⚠ Found ${galleries.body.data.length} existing galleries — cleaning up first`);
    for (const g of galleries.body.data) {
      await del(`/api/galleries/${g.id}`);
    }
  }
  console.log('  ✓ Clean state confirmed\n');
}

// ── Test Group A — Gallery CRUD ─────────────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] Gallery CRUD API\n');

  await test('TC-A-001', 'Create Gallery — general type default', async () => {
    const g = await createGallery('TC-A-001 Gallery');
    assertEq(g.type, 'general', 'type');
    assertEq(g.faceCount, 0, 'faceCount');
    assert(g.id && g.id.length === 36, 'id is UUID');
    assert(g.name === 'TC-A-001 Gallery', 'name');
  });

  await test('TC-A-002', 'Create Gallery — missing type', async () => {
    const g = await createGallery('TC-A-002 Missing', 'missing');
    assertEq(g.type, 'missing', 'type');
  });

  await test('TC-A-003', 'Create Gallery — vip type', async () => {
    const g = await createGallery('TC-A-003 VIP', 'vip');
    assertEq(g.type, 'vip', 'type');
  });

  await test('TC-A-004', 'Create Gallery — blocklist type', async () => {
    const g = await createGallery('TC-A-004 Blocklist', 'blocklist');
    assertEq(g.type, 'blocklist', 'type');
  });

  await test('TC-A-005', 'Create Gallery — invalid type defaults to general', async () => {
    const { status, body } = await post('/api/galleries', { name: 'TC-A-005 Invalid Type', type: 'vvip' });
    assertEq(status, 201, 'HTTP status');
    assertEq(body.data.type, 'general', 'type defaults to general');
    createdGalleries.push(body.data.id);
  });

  await test('TC-A-006', 'Create Gallery — missing name → 400', async () => {
    const { status, body } = await post('/api/galleries', { description: 'no name here' });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
    assertEq(body.error, 'name is required', 'error message');
  });

  await test('TC-A-007', 'Create Gallery — empty name (whitespace) → 400', async () => {
    const { status, body } = await post('/api/galleries', { name: '   ' });
    assertEq(status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-A-008', 'List Galleries — empty state', async () => {
    await cleanupAll();
    const { status, body } = await get('/api/galleries');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
    assertEq(body.data.length, 0, 'empty list');
  });

  await test('TC-A-009', 'List Galleries — returns all types with correct faceCount', async () => {
    const types = ['general', 'vip', 'blocklist', 'missing'];
    const created = {};
    for (const t of types) {
      const g = await createGallery(`TC-A-009 ${t}`, t);
      created[t] = g.id;
    }
    const { body } = await get('/api/galleries');
    assertEq(body.data.length, 4, 'gallery count');
    for (const g of body.data) {
      assertEq(g.faceCount, 0, `${g.type} faceCount`);
      assert(types.includes(g.type), `type '${g.type}' is valid`);
    }
  });

  await test('TC-A-010', 'List Galleries — sorted by createdAt DESC', async () => {
    await cleanupAll();
    const a = await createGallery('TC-A-010 A');
    await new Promise(r => setTimeout(r, 100));
    const b = await createGallery('TC-A-010 B');
    const { body } = await get('/api/galleries');
    assertEq(body.data[0].name, 'TC-A-010 B', 'newest first');
    assertEq(body.data[1].name, 'TC-A-010 A', 'older second');
  });

  await test('TC-A-011', 'Delete Gallery → 200 and removed from list', async () => {
    const g = await createGallery('TC-A-011 To Delete');
    const { status, body } = await del(`/api/galleries/${g.id}`);
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success true');
    const list = await get('/api/galleries');
    const found = list.body.data.find(x => x.id === g.id);
    assert(!found, 'gallery removed from list');
    // remove from cleanup tracking
    const idx = createdGalleries.indexOf(g.id);
    if (idx >= 0) createdGalleries.splice(idx, 1);
  });

  await test('TC-A-012', 'Delete Gallery — not found → 404', async () => {
    const { status, body } = await del('/api/galleries/00000000-0000-0000-0000-000000000000');
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await cleanupAll();
}

// ── Test Group E — Cross-Camera Re-ID API ───────────────────────────────────

async function runGroupE() {
  console.log('[Group E] Cross-Camera Re-ID API\n');

  await test('TC-E-001', 'GET /api/faces/cross-camera-stats → 200', async () => {
    const { status, body } = await get('/api/faces/cross-camera-stats');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-E-002', 'GET /api/faces/trajectories → 200', async () => {
    const { status, body } = await get('/api/faces/trajectories');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-E-003', 'GET /api/faces/trajectories?maxAgeMs=60000 → 200', async () => {
    const { status, body } = await get('/api/faces/trajectories?maxAgeMs=60000');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
    const now = Date.now();
    for (const p of body.data) {
      assert(p.lastSeenAt > now - 60000, `person lastSeenAt within 60 s: ${p.faceId}`);
    }
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Face Gallery API Tests ===\n');
  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupE();
  } finally {
    await cleanupAll();
  }

  console.log('\n=== Results ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ✗ ${r.id}: ${r.description}`);
      console.log(`      ${r.error}`);
    });
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
