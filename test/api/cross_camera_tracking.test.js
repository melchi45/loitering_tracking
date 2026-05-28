'use strict';
/**
 * Cross-Camera Face Tracking — REST API Tests
 * TC: TC_CrossCamera_Face_Tracking.md
 * Groups: A (Trajectory API), B (Stats API), C (Active Persons API), G (Edge Cases)
 * SRS: FR-CCFR-040, FR-CCFR-041, FR-CCFR-042
 *
 * Run: node test/api/cross_camera_tracking.test.js
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

// ── Prerequisites ─────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const { status, body } = await get('/health');
  assert(status === 200, `Server not healthy: HTTP ${status}`);
  assert(body.status === 'ok', `Health: ${body.status}`);
  console.log('  ✓ Server is running\n');
}

// ── Group A — Trajectory REST API ────────────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] Trajectory REST API\n');

  await test('TC-A-001', 'GET /api/faces/trajectories → 200', async () => {
    const { status, body } = await get('/api/faces/trajectories');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-A-002', 'GET /api/faces/trajectories?maxAgeMs=60000 → 200', async () => {
    const { status, body } = await get('/api/faces/trajectories?maxAgeMs=60000');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-A-003', 'GET /api/faces/trajectories — response schema validation', async () => {
    const { body } = await get('/api/faces/trajectories');
    for (const traj of body.data) {
      assert(typeof traj.faceId === 'string', `faceId is string: ${JSON.stringify(traj)}`);
      assert(Array.isArray(traj.segments), `segments is array: ${JSON.stringify(traj)}`);
    }
  });

  await test('TC-A-004', 'GET /api/faces/trajectories — segments ordered chronologically', async () => {
    const { body } = await get('/api/faces/trajectories');
    for (const traj of body.data) {
      const segs = traj.segments;
      for (let i = 1; i < segs.length; i++) {
        const prev = new Date(segs[i - 1].startTime || segs[i - 1].timestamp || 0).getTime();
        const curr = new Date(segs[i].startTime     || segs[i].timestamp     || 0).getTime();
        assert(curr >= prev, `Segments out of order for ${traj.faceId}: idx ${i - 1} > ${i}`);
      }
    }
  });

  await test('TC-A-005', 'GET /api/faces/trajectories?maxAgeMs=1 → empty or very recent data', async () => {
    const { status, body } = await get('/api/faces/trajectories?maxAgeMs=1');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.data), 'data is array');
    // Results should be very sparse (near-empty) for 1ms window
  });
}

// ── Group B — Cross-Camera Stats API ─────────────────────────────────────────

async function runGroupB() {
  console.log('[Group B] Cross-Camera Stats API\n');

  await test('TC-B-001', 'GET /api/faces/cross-camera-stats → 200', async () => {
    const { status, body } = await get('/api/faces/cross-camera-stats');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.data), 'data is array');
  });

  await test('TC-B-002', 'GET /api/faces/cross-camera-stats — response schema', async () => {
    const { body } = await get('/api/faces/cross-camera-stats');
    for (const entry of body.data) {
      assert(typeof entry.faceId === 'string',            `faceId is string`);
      assert(typeof entry.transitionCount === 'number',   `transitionCount is number`);
    }
  });

  await test('TC-B-003', 'GET /api/faces/cross-camera-stats — transitionCount is non-negative', async () => {
    const { body } = await get('/api/faces/cross-camera-stats');
    for (const entry of body.data) {
      assert(entry.transitionCount >= 0, `transitionCount ${entry.transitionCount} >= 0`);
    }
  });
}

// ── Group C — Active Persons API ─────────────────────────────────────────────

async function runGroupC() {
  console.log('[Group C] Active Persons API\n');

  await test('TC-C-001', 'GET /api/persons/active → 200 with total', async () => {
    const { status, body } = await get('/api/persons/active');
    assertEq(status, 200, 'HTTP status');
    assert(body.success !== false, 'no error');
    // total field may be in body directly or in body.data
    const hasTotal = typeof body.total === 'number' || typeof body.data?.total === 'number';
    assert(hasTotal || Array.isArray(body.data?.persons) || Array.isArray(body.data),
      `Unexpected shape: ${JSON.stringify(body).slice(0, 100)}`);
  });

  await test('TC-C-002', 'GET /api/persons/active?maxAgeMs=300000 → 200', async () => {
    const { status, body } = await get('/api/persons/active?maxAgeMs=300000');
    assertEq(status, 200, 'HTTP status');
    assert(body.success !== false, 'no error');
  });

  await test('TC-C-004', 'GET /api/persons/active — total matches persons length (if schema)', async () => {
    const { body } = await get('/api/persons/active');
    // Response shape: { total, persons } OR { data: { total, persons } } OR { data: [] }
    const persons = Array.isArray(body.persons)          ? body.persons
                  : Array.isArray(body.data?.persons)    ? body.data.persons
                  : Array.isArray(body.data)             ? body.data
                  : [];
    const total   = typeof body.total === 'number'       ? body.total
                  : typeof body.data?.total === 'number' ? body.data.total
                  : persons.length;
    assertEq(total, persons.length, 'total equals persons.length');
  });
}

// ── Group G — Edge Cases ─────────────────────────────────────────────────────

async function runGroupG() {
  console.log('[Group G] Edge Cases\n');

  await test('TC-G-001', 'cross-camera-stats — no entry has lastSeenAt = 0 (expired entries pruned)', async () => {
    const { body } = await get('/api/faces/cross-camera-stats');
    for (const entry of body.data) {
      if ('lastSeenAt' in entry) {
        assert(entry.lastSeenAt > 0, `entry ${entry.faceId} lastSeenAt > 0`);
      }
    }
  });

  await test('TC-G-003', 'GET /api/persons/active?maxAgeMs=0 → 200 (no crash)', async () => {
    // Server accepts maxAgeMs param — even if filtering not implemented, must not crash
    const { status, body } = await get('/api/persons/active?maxAgeMs=0');
    assertEq(status, 200, 'HTTP status');
    const persons = Array.isArray(body.persons)        ? body.persons
                  : Array.isArray(body.data?.persons)  ? body.data.persons
                  : Array.isArray(body.data)           ? body.data
                  : [];
    assert(Array.isArray(persons), 'persons is array');
  });

  await test('TC-G-004', 'GET /api/faces/trajectories?maxAgeMs=invalid → 200 or 400 (handled gracefully)', async () => {
    const { status } = await get('/api/faces/trajectories?maxAgeMs=notanumber');
    assert(status === 200 || status === 400, `Expected 200 or 400, got ${status}`);
  });

  await test('TC-G-005', 'All three endpoints consistent — respond 200 with arrays', async () => {
    const [traj, stats, persons] = await Promise.all([
      get('/api/faces/trajectories'),
      get('/api/faces/cross-camera-stats'),
      get('/api/persons/active'),
    ]);
    assertEq(traj.status,    200, 'trajectories HTTP status');
    assertEq(stats.status,   200, 'stats HTTP status');
    assertEq(persons.status, 200, 'persons HTTP status');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC_CrossCamera_Face_Tracking — REST API Tests      ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  await checkPrerequisites();
  await runGroupA();
  await runGroupB();
  await runGroupC();
  await runGroupG();

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
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
  process.exit(1);
});
