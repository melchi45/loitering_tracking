'use strict';
/**
 * Human Detection API Tests
 * TC: TC-A-001 ~ TC-A-005, TC-B-001 ~ TC-B-006, TC-C-001 ~ TC-C-004, TC-D-001 ~ TC-D-005
 * SRS: FR-HDT-017, FR-HDT-020, FR-HDT-032
 *
 * Prerequisites: Server running on BASE_URL, yolov8n.onnx loaded
 * Run: node test/api/human_detection.test.js
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

async function put(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── State tracker for cleanup ───────────────────────────────────────────────

let personClassDisabled = false;

async function ensurePersonEnabled() {
  if (personClassDisabled) {
    await put('/api/analytics/config', { classId: 0, enabled: true });
    personClassDisabled = false;
  }
}

// ── Prerequisite check ──────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');

  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: ${health.status}`);
  assert(health.body.status === 'ok', `Health status: ${health.body.status}`);
  console.log('  ✓ Server is running');

  const caps = await get('/api/capabilities');
  assert(caps.status === 200, 'Capabilities endpoint failed');
  if (!caps.body.ai?.humanDetection) {
    console.warn('  ⚠ humanDetection not available (yolov8n.onnx not loaded) — skipping all tests');
    console.log('\n=== Results ===');
    console.log('  Passed:  0');
    console.log('  Failed:  0');
    console.log('  Skipped: all (model not loaded)');
    process.exit(0);
  }
  console.log('  ✓ humanDetection capability confirmed\n');
}

// ── Test Group A — Capabilities & Health API ────────────────────────────────

async function runGroupA() {
  console.log('[Group A] Capabilities & Health API\n');

  await test('TC-A-001', 'GET /health → 200 ok', async () => {
    const { status, body } = await get('/health');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.status, 'ok', 'health status');
  });

  await test('TC-A-002', 'GET /api/capabilities returns humanDetection boolean', async () => {
    const { status, body } = await get('/api/capabilities');
    assertEq(status, 200, 'HTTP status');
    assert(body.ai !== null && typeof body.ai === 'object', 'ai object present');
    assertEq(typeof body.ai.humanDetection, 'boolean', 'humanDetection type');
  });

  await test('TC-A-003', 'humanDetection === true when yolov8n.onnx loaded', async () => {
    const { body } = await get('/api/capabilities');
    assertEq(body.ai.humanDetection, true, 'humanDetection');
  });

  await test('TC-A-004', 'Capabilities includes modelName when humanDetection is true', async () => {
    const { body } = await get('/api/capabilities');
    if (body.ai.humanDetection) {
      assert(typeof body.ai.modelName === 'string', 'modelName is string');
      assert(body.ai.modelName.length > 0, 'modelName not empty');
    }
    // Skip assertion if humanDetection is false (model not present in env)
  });

  await test('TC-A-005', 'GET /api/capabilities returns application/json Content-Type', async () => {
    const res = await fetch(`${BASE_URL}/api/capabilities`);
    assertEq(res.status, 200, 'HTTP status');
    const ct = res.headers.get('content-type') || '';
    assert(ct.includes('application/json'), `Content-Type: ${ct}`);
  });
}

// ── Test Group B — Analytics Config ────────────────────────────────────────

async function runGroupB() {
  console.log('[Group B] Analytics Config (Human Class Gate)\n');

  await test('TC-B-001', 'GET /api/analytics/config accessible and returns JSON', async () => {
    const { status, body } = await get('/api/analytics/config');
    assertEq(status, 200, 'HTTP status');
    assert(typeof body === 'object' && body !== null, 'response is object');
  });

  await test('TC-B-002', 'Analytics config contains class 0 (person) entry', async () => {
    const { body } = await get('/api/analytics/config');
    // Support both {classes: {'0': ...}} and {enabled: [...]} response shapes
    const classEntry = body.classes?.['0'] || body.classes?.[0] ||
      (Array.isArray(body.enabled) ? body.enabled.find(c => c.classId === 0) : null);
    assert(classEntry !== undefined && classEntry !== null,
      'class 0 entry not found in analytics config');
  });

  await test('TC-B-003', 'Class 0 (person) is enabled by default', async () => {
    const { body } = await get('/api/analytics/config');
    const entry = body.classes?.['0'] || body.classes?.[0] ||
      (Array.isArray(body.enabled) ? body.enabled.find(c => c.classId === 0) : null);
    assert(entry?.enabled === true, 'person class should be enabled by default');
  });

  await test('TC-B-004', 'PUT /api/analytics/config disables class 0', async () => {
    const { status, body } = await put('/api/analytics/config', { classId: 0, enabled: false });
    personClassDisabled = true;
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');

    const cfg = await get('/api/analytics/config');
    const entry = cfg.body.classes?.['0'] || cfg.body.classes?.[0] ||
      (Array.isArray(cfg.body.enabled) ? cfg.body.enabled.find(c => c.classId === 0) : null);
    assert(entry?.enabled === false, 'class 0 should now be disabled');
  });

  await test('TC-B-005', 'PUT /api/analytics/config re-enables class 0', async () => {
    await put('/api/analytics/config', { classId: 0, enabled: true });
    personClassDisabled = false;

    const cfg = await get('/api/analytics/config');
    const entry = cfg.body.classes?.['0'] || cfg.body.classes?.[0] ||
      (Array.isArray(cfg.body.enabled) ? cfg.body.enabled.find(c => c.classId === 0) : null);
    assert(entry?.enabled === true, 'class 0 should be re-enabled');
  });

  await test('TC-B-006', 'PUT /api/analytics/config with invalid classId returns error', async () => {
    const { status, body } = await put('/api/analytics/config', { classId: 999, enabled: false });
    assert(status === 400 || body.success === false,
      `Expected error for invalid classId; got status=${status} success=${body.success}`);
  });

  await ensurePersonEnabled();
}

// ── Test Group C — Detection Output Schema ──────────────────────────────────

async function runGroupC() {
  console.log('[Group C] Detection Output Schema\n');

  await test('TC-C-001', 'Capabilities ai object has required structure', async () => {
    const { body } = await get('/api/capabilities');
    assert(body.ai !== null && typeof body.ai === 'object', 'ai is object');
    assert('humanDetection' in body.ai, 'humanDetection key present');
    assertEq(typeof body.ai.humanDetection, 'boolean', 'humanDetection type');
  });

  await test('TC-C-002', 'Analytics config class 0 entry has className "person"', async () => {
    const { body } = await get('/api/analytics/config');
    const entry = body.classes?.['0'] || body.classes?.[0] ||
      (Array.isArray(body.enabled) ? body.enabled.find(c => c.classId === 0) : null);
    assert(entry !== null && entry !== undefined, 'class 0 entry exists');
    if (entry.className !== undefined) {
      assertEq(entry.className, 'person', 'className');
    }
  });

  await test('TC-C-003', 'Analytics config returns accessible JSON structure', async () => {
    const { status, body } = await get('/api/analytics/config');
    assertEq(status, 200, 'HTTP status');
    assert(typeof body === 'object', 'response is object');
    // At minimum: has either 'classes' or 'enabled' key with person class (0) accessible
    const hasClasses = body.classes !== undefined;
    const hasEnabled = Array.isArray(body.enabled);
    assert(hasClasses || hasEnabled, 'config has classes or enabled array');
  });

  await test('TC-C-004', 'Confidence threshold not exposed or is valid number', async () => {
    const { body } = await get('/api/analytics/config');
    if (body.confidenceThreshold !== undefined) {
      const val = body.confidenceThreshold;
      assert(typeof val === 'number', 'confidenceThreshold is number');
      assert(val >= 0 && val <= 1, `confidenceThreshold out of range: ${val}`);
    }
    // Skip assertion if field not exposed — it's an implementation detail
  });
}

// ── Test Group D — Error Handling & Edge Cases ──────────────────────────────

async function runGroupD() {
  console.log('[Group D] Error Handling & Edge Cases\n');

  await test('TC-D-001', 'GET /api/capabilities requires no auth (no 401/403)', async () => {
    const res = await fetch(`${BASE_URL}/api/capabilities`);
    assert(res.status !== 401 && res.status !== 403,
      `Expected no auth required; got ${res.status}`);
    assertEq(res.status, 200, 'HTTP status');
  });

  await test('TC-D-002', 'GET /api/analytics/config requires no auth', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics/config`);
    assert(res.status !== 401 && res.status !== 403,
      `Expected no auth required; got ${res.status}`);
    assertEq(res.status, 200, 'HTTP status');
  });

  await test('TC-D-003', 'PUT /api/analytics/config with non-boolean enabled handled gracefully', async () => {
    const { status } = await put('/api/analytics/config', { classId: 0, enabled: 'yes' });
    assert(status !== 500, `Should not 500 on non-boolean enabled; got ${status}`);
    // Acceptable: 400 (rejected) or 200 (coerced to boolean)
    await ensurePersonEnabled();
  });

  await test('TC-D-004', '10 concurrent GET /api/capabilities all return 200', async () => {
    const requests = Array.from({ length: 10 }, () => get('/api/capabilities'));
    const responses = await Promise.all(requests);
    for (const { status } of responses) {
      assertEq(status, 200, 'HTTP status');
    }
    const values = responses.map(r => r.body.ai?.humanDetection);
    const unique = new Set(values);
    assertEq(unique.size, 1, 'humanDetection consistent across concurrent requests');
  });

  await test('TC-D-005', 'Class 0 disabled state persists across multiple GET requests', async () => {
    await put('/api/analytics/config', { classId: 0, enabled: false });
    personClassDisabled = true;

    const reads = await Promise.all([
      get('/api/analytics/config'),
      get('/api/analytics/config'),
      get('/api/analytics/config'),
    ]);
    for (const { body } of reads) {
      const entry = body.classes?.['0'] || body.classes?.[0] ||
        (Array.isArray(body.enabled) ? body.enabled.find(c => c.classId === 0) : null);
      assert(entry?.enabled === false, 'class 0 must remain disabled');
    }
    await ensurePersonEnabled();
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Human Detection API Tests ===\n');
  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupB();
    await runGroupC();
    await runGroupD();
  } finally {
    // Ensure person class is re-enabled regardless of test failures
    await ensurePersonEnabled();
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
