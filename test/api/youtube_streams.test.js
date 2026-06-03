'use strict';
/**
 * YouTube Streams API Tests
 *
 * TC: TC-LTS-YT-01
 *   Group A — URL Validation & Stream Limits (TC-A-001 ~ TC-A-004)
 *   Group D — REST API                       (TC-D-001 ~ TC-D-008)
 *
 * SRS: FR-YT-001 ~ FR-YT-005, FR-YT-026 ~ FR-YT-036
 *
 * Note: Groups B (process management), C (state machine), E (MediaMTX),
 *       G (performance) require live processes and are covered in Phase-2/3.
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 *                yt-dlp and ffmpeg installed on PATH
 * Run: node test/api/youtube_streams.test.js
 *
 * Set LTS_URL env var to override base URL.
 * Set YOUTUBE_TEST_URL to provide a real YouTube URL for TC-A-001.
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

// A short, publicly available YouTube video for live testing.
// Override with YOUTUBE_TEST_URL if needed.
const YT_URL = process.env.YOUTUBE_TEST_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

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

async function patch(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
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

// ── Cleanup ──────────────────────────────────────────────────────────────────

const createdStreamIds = [];

async function createStream(overrides = {}) {
  const payload = {
    youtubeUrl:  overrides.youtubeUrl  || YT_URL,
    name:        overrides.name        || 'TC YouTube Stream',
    resolution:  overrides.resolution  || '720p',
    ...overrides,
  };
  const { status, body } = await post('/api/youtube-streams', payload);
  if (status === 201) {
    const id = body.camera?.id || body.id;
    if (id) createdStreamIds.push(id);
    return { status, body, id };
  }
  return { status, body, id: null };
}

async function cleanupAll() {
  for (const id of createdStreamIds) {
    try { await del(`/api/youtube-streams/${id}`); } catch (_) {}
  }
  createdStreamIds.length = 0;
}

// ── Prerequisites ────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running');
  console.log(`  ℹ YouTube test URL: ${YT_URL}\n`);
}

// ── Group A — URL Validation & Stream Limits ─────────────────────────────────

async function runGroupA() {
  console.log('[Group A] URL Validation & Stream Limits\n');

  await test('TC-A-001', 'Valid YouTube URL → 201 with id', async () => {
    const { status, body, id } = await createStream({ name: 'TC-A-001', youtubeUrl: YT_URL });
    assert(status === 201, `HTTP ${status}: ${JSON.stringify(body)}`);
    assert(id, 'id present in response');
    assertEq(body.success, true, 'success');
  });

  await test('TC-A-002', 'Non-YouTube URL → 422 INVALID_YOUTUBE_URL', async () => {
    const { status, body } = await post('/api/youtube-streams', {
      youtubeUrl: 'https://example.com/watch?v=test',
      name: 'TC-A-002 Invalid',
      resolution: '720p',
    });
    assertEq(status, 422, 'HTTP status');
    assertEq(body.success, false, 'success false');
    assertEq(body.code, 'INVALID_YOUTUBE_URL', 'error code');
  });

  await test('TC-A-003', 'Missing youtubeUrl → 422', async () => {
    const { status, body } = await post('/api/youtube-streams', {
      name: 'TC-A-003 No URL', resolution: '720p',
    });
    assertEq(status, 422, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-A-004', 'URL security: malicious.site.com → 422', async () => {
    const { status, body } = await post('/api/youtube-streams', {
      youtubeUrl: 'https://malicious.site.com/watch?v=abc',
      name: 'TC-A-004 Malicious',
      resolution: '720p',
    });
    assertEq(status, 422, 'HTTP status');
    assertEq(body.code, 'INVALID_YOUTUBE_URL', 'code');
  });

  await test('TC-A-005', 'Missing name → 400', async () => {
    const { status } = await post('/api/youtube-streams', {
      youtubeUrl: YT_URL, resolution: '720p',
    });
    assertEq(status, 400, 'HTTP status');
  });

  await test('TC-A-006', 'Invalid resolution → 400', async () => {
    const { status } = await post('/api/youtube-streams', {
      youtubeUrl: YT_URL, name: 'TC-A-006', resolution: '2160p',
    });
    assertEq(status, 400, 'HTTP status');
  });
}

// ── Group D — REST API ────────────────────────────────────────────────────────

async function runGroupD() {
  console.log('\n[Group D] REST API\n');

  let streamId;

  await test('TC-D-001', 'POST /api/youtube-streams → 201 with all required fields', async () => {
    const { status, body, id } = await createStream({
      name: 'TC-D-001 Stream',
      youtubeUrl: YT_URL,
      resolution: '720p',
    });
    assert(status === 201, `HTTP ${status}`);
    streamId = id;
    const cam = body.camera || body;
    assert(cam.id, 'id present');
    assert(cam.name, 'name present');
    // youtubeUrl or rtspUrl present
    assert(cam.youtubeUrl || cam.rtspUrl, 'youtubeUrl or rtspUrl present');
  });

  await test('TC-D-002', 'GET /api/youtube-streams → array with created stream', async () => {
    const { status, body } = await get('/api/youtube-streams');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(Array.isArray(body.streams), 'streams is array');
    if (streamId) {
      const found = body.streams.find(s => s.id === streamId);
      assert(found, `stream ${streamId} in list`);
    }
  });

  await test('TC-D-003', 'GET /api/youtube-streams/:id/status → 200 with status field', async () => {
    if (!streamId) { console.log('      (skipped: no stream created)'); return; }
    const { status, body } = await get(`/api/youtube-streams/${streamId}/status`);
    assertEq(status, 200, 'HTTP status');
    assert(body.status !== undefined, 'status field present');
  });

  await test('TC-D-004', 'PATCH /api/youtube-streams/:id → 200 with updated field', async () => {
    if (!streamId) { console.log('      (skipped: no stream created)'); return; }
    const { status, body } = await patch(`/api/youtube-streams/${streamId}`, { resolution: '1080p' });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
  });

  await test('TC-D-005', 'DELETE /api/youtube-streams/:id → 200, removed from list', async () => {
    if (!streamId) { console.log('      (skipped: no stream created)'); return; }
    const delId = streamId;
    const { status } = await del(`/api/youtube-streams/${delId}`);
    assertEq(status, 200, 'HTTP status');
    // Remove from cleanup list (already deleted)
    const idx = createdStreamIds.indexOf(delId);
    if (idx !== -1) createdStreamIds.splice(idx, 1);
    streamId = null;
    // Verify removed
    const check = await get(`/api/youtube-streams/${delId}/status`);
    assertEq(check.status, 404, 'GET deleted stream → 404');
  });

  await test('TC-D-006', 'POST /api/youtube-streams/:id/restart — non-existent → 404', async () => {
    const { status } = await post('/api/youtube-streams/non-existent-id/restart', {});
    assertEq(status, 404, 'HTTP status');
  });

  await test('TC-D-007', 'GET /api/youtube-streams/:id — non-existent → 404', async () => {
    const { status } = await get('/api/youtube-streams/non-existent-id/status');
    assertEq(status, 404, 'HTTP status');
  });

  await test('TC-D-008', 'PATCH /api/youtube-streams/:id — non-existent → 404', async () => {
    const { status } = await patch('/api/youtube-streams/non-existent-id', { resolution: '720p' });
    assertEq(status, 404, 'HTTP status');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-YT-01 — YouTube Streams Tests               ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupD();
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
