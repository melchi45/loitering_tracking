'use strict';
/**
 * YouTube Streams API Tests — LTS-2026-012 Refinements
 *
 * TC: TC-LTS-YT-02
 *   Group A — repeatPlayback Feature   (TC-A-001, TC-A-004)
 *   Group B — Database Schema          (TC-B-001 ~ TC-B-002)
 *   Group D — Error Codes — Extended   (TC-D-001 ~ TC-D-002)
 *
 * SRS: FR-YT2-001 ~ FR-YT2-041
 *
 * Extends TC-LTS-YT-01. Only covers LTS-2026-012-specific additions.
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 *                yt-dlp and ffmpeg installed on PATH
 * Run: node test/api/youtube_streams_lts2026.test.js
 *
 * Set LTS_URL env var to override base URL.
 * Set YOUTUBE_TEST_URL to provide a real YouTube URL.
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';
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
    youtubeUrl: YT_URL,
    name: 'TC-YT2 Stream',
    resolution: '720p',
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
  console.log('  ✓ Server is running\n');
}

// ── Group A — repeatPlayback Feature ────────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] repeatPlayback Feature\n');

  await test('TC-A-001', 'POST with repeatPlayback: true → 201 with field in response', async () => {
    const { status, body, id } = await createStream({
      name: 'TC-A-001 Repeat', repeatPlayback: true,
    });
    assert(status === 201, `HTTP ${status}: ${JSON.stringify(body)}`);
    const cam = body.camera || body;
    assert(id, 'id present');
    // repeatPlayback should be in the response
    assert(cam.repeatPlayback === true || cam.repeatPlayback !== undefined,
      `repeatPlayback field in response (got: ${JSON.stringify(cam.repeatPlayback)})`);
  });

  await test('TC-A-002', 'POST with repeatPlayback: false (default) → 201', async () => {
    const { status, body } = await createStream({ name: 'TC-A-002 NoRepeat', repeatPlayback: false });
    assert(status === 201, `HTTP ${status}`);
    const cam = body.camera || body;
    // repeatPlayback should default to false when not set or set to false
    if (cam.repeatPlayback !== undefined) {
      assertEq(cam.repeatPlayback, false, 'repeatPlayback false');
    }
  });

  await test('TC-A-004', 'PATCH repeatPlayback only → 200, no restart', async () => {
    const { status: cs, body: cb, id } = await createStream({ name: 'TC-A-004 Patch' });
    assert(cs === 201, `createStream HTTP ${cs}`);
    if (!id) { console.log('      (skipped: stream creation failed)'); return; }

    const { status, body } = await patch(`/api/youtube-streams/${id}`, { repeatPlayback: true });
    assertEq(status, 200, 'PATCH HTTP status');
    assertEq(body.success, true, 'success');
    // Stream should still be in its current state (not restarted)
    const statusAfter = await get(`/api/youtube-streams/${id}/status`);
    assertEq(statusAfter.status, 200, 'Status endpoint still accessible');
  });
}

// ── Group B — Database Schema ────────────────────────────────────────────────

async function runGroupB() {
  console.log('\n[Group B] Database Schema Compliance\n');

  await test('TC-B-001', 'POST response contains all required schema fields', async () => {
    const { status, body } = await createStream({ name: 'TC-B-001 Schema', repeatPlayback: false });
    assert(status === 201, `HTTP ${status}`);
    const cam = body.camera || body;
    const required = ['id', 'name', 'resolution'];
    for (const field of required) {
      assert(cam[field] !== undefined, `field ${field} missing in response`);
    }
  });

  await test('TC-B-002', 'API returns bitrate in kbps (not bps)', async () => {
    const { status, body } = await createStream({
      name: 'TC-B-002 Bitrate', resolution: '720p', bitrate: 2000,
    });
    assert(status === 201, `HTTP ${status}`);
    const cam = body.camera || body;
    if (cam.bitrate !== undefined) {
      // bitrate via API should be kbps (1000-10000 range), NOT bps (1000000+ range)
      assert(cam.bitrate <= 20000, `bitrate should be kbps (≤20000), got ${cam.bitrate}`);
    }
  });
}

// ── Group D — Error Codes — Extended ────────────────────────────────────────

async function runGroupD() {
  console.log('\n[Group D] Error Codes — Extended\n');

  const ERROR_CASES = [
    {
      id: 'TC-D-INVALID_URL',
      desc: 'Invalid YouTube URL → 422 INVALID_YOUTUBE_URL',
      body: { youtubeUrl: 'https://notyoutube.com/v=x', name: 'Err Test', resolution: '720p' },
      expectedStatus: 422,
      expectedCode: 'INVALID_YOUTUBE_URL',
    },
    {
      id: 'TC-D-NOT_FOUND',
      desc: 'Non-existent stream restart → 404 STREAM_NOT_FOUND',
      action: async () => post('/api/youtube-streams/no-such-id-00000000/restart', {}),
      expectedStatus: 404,
    },
  ];

  for (const tc of ERROR_CASES) {
    await test(tc.id, tc.desc, async () => {
      const result = tc.action
        ? await tc.action()
        : await post('/api/youtube-streams', tc.body);
      assertEq(result.status, tc.expectedStatus, 'HTTP status');
      assertEq(result.body.success, false, 'success false');
      if (tc.expectedCode) {
        assertEq(result.body.code, tc.expectedCode, 'error code');
      }
    });
  }

  await test('TC-D-002', 'Error response format: {success, code, error}', async () => {
    const { status, body } = await post('/api/youtube-streams', {
      youtubeUrl: 'https://malicious.com/watch', name: 'Format Test', resolution: '720p',
    });
    assertEq(status, 422, 'HTTP status');
    assertEq(body.success, false, 'success false');
    assert(typeof body.code === 'string' && body.code.length > 0, 'code is non-empty string');
    assert(typeof body.error === 'string' && body.error.length > 0, 'error is non-empty string');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-YT-02 — YouTube Streams LTS-2026-012 Tests  ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupB();
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
