'use strict';
/**
 * Face Match History — Persistence, Camera Name, Timeline Integration
 *
 * TC: TC-FMH-A-001 ~ TC-FMH-B-001
 * SRS: FR-FMH-010 ~ FR-FMH-011, FR-FMH-002
 *
 * This suite verifies the read contract of GET /api/galleries/match-history. It does not
 * (and cannot, from a pure API test) trigger a real live camera face match — there is no
 * POST endpoint for this table by design (only the AI pipeline writes to it). Cases that
 * need actual history data soft-skip with a clear reason when the table is empty in the
 * test environment, following the SKIP pattern already used in missing_persons.test.js.
 *
 * Run: node test/api/face_match_history.test.js
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

let passed = 0, failed = 0, skipped = 0;
const results = [];

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed++;
    results.push({ id, description, status: 'PASS' });
  } catch (err) {
    if (err.message === 'SKIP') {
      console.log(`  ⊘ ${id}: ${description} (skipped)`);
      skipped++;
      results.push({ id, description, status: 'SKIP' });
    } else {
      console.error(`  ✗ ${id}: ${description}\n      ${err.message}`);
      failed++;
      results.push({ id, description, status: 'FAIL', error: err.message });
    }
  }
}

function skip(reason) { const e = new Error('SKIP'); e.reason = reason; throw e; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEq(a, e, l) { if (a !== e) throw new Error(`${l}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }

async function get(p) {
  const res = await fetch(`${BASE_URL}${p}`);
  return { status: res.status, body: await res.json() };
}

// ── Group A — Match History Endpoint ──────────────────────────────────────────

async function runGroupA() {
  console.log('\n[Group A] Match History Endpoint\n');

  await test('TC-FMH-A-001', 'Endpoint returns success shape', async () => {
    const { status, body } = await get('/api/galleries/match-history');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success flag');
    assert(Array.isArray(body.data), 'data is an array');
  });

  await test('TC-FMH-A-002', 'limit is clamped to 200', async () => {
    const { body } = await get('/api/galleries/match-history?limit=9999');
    assert(body.data.length <= 200, 'data length within clamp');
  });

  await test('TC-FMH-A-003', 'cameraId filter narrows to zero for a nonexistent camera', async () => {
    const { body } = await get('/api/galleries/match-history?cameraId=nonexistent-camera-id');
    assertEq(body.data.length, 0, 'no matches for nonexistent camera');
  });

  await test('TC-FMH-A-004', 'Invalid galleryType filter does not crash, returns empty', async () => {
    const { status, body } = await get('/api/galleries/match-history?galleryType=not-a-real-type');
    assertEq(status, 200, 'HTTP status (no crash)');
    assertEq(body.data.length, 0, 'no matches for invalid galleryType');
  });

  await test('TC-FMH-A-005', 'from filter in the far future returns zero', async () => {
    const { body } = await get('/api/galleries/match-history?from=2099-01-01T00:00:00Z');
    assertEq(body.data.length, 0, 'no matches from the far future');
  });

  await test('TC-FMH-A-006', 'Results sorted newest-first', async () => {
    const { body } = await get('/api/galleries/match-history?limit=10');
    if (body.data.length < 2) skip('not enough history to verify ordering');
    for (let i = 0; i < body.data.length - 1; i++) {
      assert(body.data[i].timestamp >= body.data[i + 1].timestamp, `entry ${i} not before entry ${i + 1}`);
    }
  });
}

// ── Group B — Camera Name ──────────────────────────────────────────────────────

async function runGroupB() {
  console.log('\n[Group B] Camera Name\n');

  await test('TC-FMH-B-001', 'cameraName field present when available', async () => {
    const { body } = await get('/api/galleries/match-history?limit=50');
    if (body.data.length === 0) skip('no match history available in this environment');
    for (const entry of body.data) {
      if (entry.cameraName != null) {
        assert(typeof entry.cameraName === 'string' && entry.cameraName.length > 0, 'cameraName is a non-empty string when present');
      }
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Face Match History Tests ===\n');

  console.log('[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not reachable: ${health.status}`);
  console.log('  ✓ Server running\n');

  await runGroupA();
  await runGroupB();

  console.log('\n=== Results ===');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${passed + failed + skipped}`);

  if (failed > 0) {
    results.filter(r => r.status === 'FAIL').forEach(r =>
      console.error(`  ✗ ${r.id}: ${r.description}\n      ${r.error}`)
    );
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
