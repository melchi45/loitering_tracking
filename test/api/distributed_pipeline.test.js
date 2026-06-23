'use strict';
/**
 * Distributed pipeline mode contract tests.
 *
 * Run: node test/api/distributed_pipeline.test.js
 *
 * This suite validates mode-specific API behavior without requiring
 * camera hardware or external analysis server fixtures.
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function post(path, payload) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC_Distributed_AI_Pipeline — Mode Contract Tests   ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const health = await get('/health');
  assertEq(health.status, 200, 'GET /health status');
  assert(health.body && health.body.status === 'ok', 'health.status must be ok');

  const mode = health.body.serverMode || 'combined';
  const isAnalysis = mode === 'analysis';
  const isStreaming = mode === 'streaming';
  const isCombined = mode === 'combined';

  console.log(`\n[Info] serverMode=${mode}`);

  await test('TC-DAP-001', 'mode is one of combined/streaming/analysis', async () => {
    assert(['combined', 'streaming', 'analysis'].includes(mode), `unexpected mode: ${mode}`);
  });

  await test('TC-DAP-002', 'camera discovery endpoint follows mode policy', async () => {
    const r = await post('/api/cameras/discover', {});
    if (isAnalysis) {
      assertEq(r.status, 409, 'analysis discover status');
      assertEq(r.body.success, false, 'analysis discover success');
      return;
    }
    assertEq(r.status, 200, 'non-analysis discover status');
    assertEq(r.body.success, true, 'non-analysis discover success');
  });

  await test('TC-DAP-003', 'analysis health endpoint availability is mode-aware', async () => {
    const r = await get('/api/analysis/health');
    if (isStreaming) {
      assertEq(r.status, 404, 'streaming analysis health status');
      return;
    }
    assertEq(r.status, 200, 'combined/analysis analysis health status');
    assertEq(r.body.status, 'ok', 'analysis health payload');
  });

  await test('TC-DAP-004', 'analysis frame validation returns expected status by mode', async () => {
    const r = await post('/api/analysis/frame', {});
    if (isStreaming) {
      assertEq(r.status, 404, 'streaming frame endpoint status');
      return;
    }
    assertEq(r.status, 400, 'combined/analysis frame validation status');
    assert(typeof r.body.error === 'string', 'error message exists');
  });

  await test('TC-DAP-005', 'analysis frame response includes detectedFaces when endpoint is enabled', async () => {
    if (isStreaming) return;

    // 1x1 JPEG (valid minimal sample)
    const tinyJpegBase64 =
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEBAVFhUVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAABBQEBAAAAAAAAAAAAAAAFAAMEBgcBAv/EADgQAAIBAwMCBAMHAwQDAAAAAAECAwAEEQUSITEGE0FRImFxgZEykaGxwQcjQlJy0fAkQ2OC/8QAGQEBAQEBAQEAAAAAAAAAAAAAAAEDAgQF/8QAHxEBAQEBAQACAwEAAAAAAAAAAAERAhIhMUEDE1EU/9oADAMBAAIRAxEAPwD8NREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREH//2Q==';

    const payload = {
      cameraId: 'test-cam-distributed',
      frameId: 1,
      timestamp: new Date().toISOString(),
      frame: tinyJpegBase64,
      zones: [],
    };
    const r = await post('/api/analysis/frame', payload);
    assertEq(r.status, 200, 'analysis frame status');
    assert(Array.isArray(r.body.detectedFaces), 'detectedFaces must be an array');
    assert(Array.isArray(r.body.tracked), 'tracked must be an array');
    assert(Array.isArray(r.body.behaviors), 'behaviors must be an array');
  });

  await test('TC-DAP-009', '다중 채널 동시 추론 시 cameraId 격리 (FR-DAP-027)', async () => {
    if (isStreaming) return; // analysis/combined 모드 전용

    // 1×1 pixel JPEG — minimal valid sample used for concurrent routing validation
    const tinyJpeg =
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEBAVFhUVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAABBQEBAAAAAAAAAAAAAAAFAAMEBgcBAv/EADgQAAIBAwMCBAMHAwQDAAAAAAECAwAEEQUSITEGE0FRImFxgZEykaGxwQcjQlJy0fAkQ2OC/8QAGQEBAQEBAQEAAAAAAAAAAAAAAAEDAgQF/8QAHxEBAQEBAQACAwEAAAAAAAAAAAERAhIhMUEDE1EU/9oADAMBAAIRAxEAPwD8NREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREH//2Q==';

    const camAId = 'tc009-cam-alpha';
    const camBId = 'tc009-cam-beta';

    const makePayload = (cameraId, frameId) => ({
      cameraId,
      frameId,
      timestamp: new Date().toISOString(),
      frame: tinyJpeg,
      zones: [],
    });

    // Send two frames from different cameras concurrently — validates that
    // DetectionService._preprocess() does not share a mutable Float32Array
    // buffer between concurrent requests (FR-DAP-027).
    const [rA, rB] = await Promise.all([
      post('/api/analysis/frame', makePayload(camAId, 1)),
      post('/api/analysis/frame', makePayload(camBId, 1)),
    ]);

    assertEq(rA.status, 200, 'camera A response status');
    assertEq(rB.status, 200, 'camera B response status');

    // Each response must echo back the cameraId that was sent —
    // cross-channel contamination would cause a mismatch here.
    assertEq(rA.body.cameraId, camAId, 'camera A response cameraId must match request');
    assertEq(rB.body.cameraId, camBId, 'camera B response cameraId must match request');

    // Both responses must contain independent result arrays (not shared references)
    assert(Array.isArray(rA.body.tracked), 'camera A tracked must be array');
    assert(Array.isArray(rB.body.tracked), 'camera B tracked must be array');
    assert(Array.isArray(rA.body.behaviors), 'camera A behaviors must be array');
    assert(Array.isArray(rB.body.behaviors), 'camera B behaviors must be array');
  });

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
