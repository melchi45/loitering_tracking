'use strict';
/**
 * Face Match → Detections Timeline Navigation — Join Key Contract
 *
 * TC: TC-FMN-A-001 ~ TC-FMN-A-003
 * SRS: FR-FMN-004, FR-FMN-020, §6.1
 *
 * This feature is almost entirely client-side (prop plumbing between FaceGalleryTab,
 * FullscreenCameraView, and DetectionsTimelineInline). This suite verifies the API-level
 * contract the client-side navigation logic depends on: that {faceId, timestamp} is a
 * usable join key on GET /api/galleries/match-history, and that the same from/to window
 * shape is accepted identically by both /api/galleries/match-history and
 * /api/analysis/detection-tracks (the two endpoints DetectionsTimelineInline fetches when
 * centering on a match). See docs/tc/TC_Face_Match_Timeline_Navigation.md Group B for the
 * manual UI verification steps this suite does not (and cannot) automate.
 *
 * Run: node test/api/face_match_timeline_navigation.test.js
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

async function runGroupA() {
  console.log('\n[Group A] Join Key Contract\n');

  await test('TC-FMN-A-001', 'Match entries carry faceId + timestamp', async () => {
    const { body } = await get('/api/galleries/match-history?limit=20');
    if (body.data.length === 0) skip('no match history available');
    for (const entry of body.data) {
      assert(typeof entry.faceId === 'string' && entry.faceId.length > 0, 'faceId is a non-empty string');
      assert(typeof entry.timestamp === 'number', 'timestamp is a number');
    }
  });

  await test('TC-FMN-A-002', '±30-minute window round trip finds the same entry', async () => {
    const { body: first } = await get('/api/galleries/match-history?limit=1');
    if (first.data.length === 0) skip('no match history available');
    const target = first.data[0];
    const HALF_WINDOW_MS = 30 * 60 * 1000;
    const from = new Date(target.timestamp - HALF_WINDOW_MS).toISOString();
    const to   = new Date(target.timestamp + HALF_WINDOW_MS).toISOString();
    const { body: windowed } = await get(`/api/galleries/match-history?from=${from}&to=${to}`);
    assert(windowed.data.some(m => m.id === target.id), 'target entry found within its own centered window');
  });

  await test('TC-FMN-A-003', 'Same from/to shape accepted by detection-tracks', async () => {
    const { body: first } = await get('/api/galleries/match-history?limit=1');
    if (first.data.length === 0) skip('no match history available');
    const target = first.data[0];
    const HALF_WINDOW_MS = 30 * 60 * 1000;
    const from = new Date(target.timestamp - HALF_WINDOW_MS).toISOString();
    const to   = new Date(target.timestamp + HALF_WINDOW_MS).toISOString();
    const { status, body } = await get(`/api/analysis/detection-tracks?cameraId=${target.cameraId}&from=${from}&to=${to}`);
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.tracks), 'tracks is an array');
  });
}

async function main() {
  console.log('=== Face Match Timeline Navigation Tests ===\n');

  console.log('[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not reachable: ${health.status}`);
  console.log('  ✓ Server running\n');

  await runGroupA();

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
