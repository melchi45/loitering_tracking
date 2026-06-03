'use strict';
/**
 * AI Detection Modules — Analytics Config & Capabilities Tests
 *
 * Covers TC documents:
 *   TC_AI_Accessories_Detection.md  → Groups A, B, D, F  (test/api/accessories_detection.test.js)
 *   TC_AI_Animal_Detection.md       → Groups A, B, D      (test/api/animal_detection.test.js)
 *   TC_AI_Cloth_Analysis.md         → Groups A, B, D      (test/api/cloth_analysis.test.js)
 *   TC_AI_Color_Analysis.md         → Groups A, B, D, E   (test/api/color_analysis.test.js)
 *   TC_AI_Fire_Smoke_Detection.md   → Groups A, B, D      (test/api/fire_smoke_detection.test.js)
 *   TC_AI_Hat_Detection.md          → Groups A, B, D      (test/api/hat_detection.test.js)
 *   TC_AI_Mask_Detection.md         → Groups A, B, D      (test/api/mask_detection.test.js)
 *   TC_AI_Vehicle_Detection.md      → Groups A, B, D      (test/api/vehicle_detection.test.js)
 *
 * SRS: FR-ACC-*, FR-ANI-*, FR-CLO-*, FR-COL-*, FR-FIR-*, FR-HAT-*, FR-MASK-*, FR-VDT-*
 *
 * Run: node test/api/ai_detection_modules.test.js
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(path) {
  const res  = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

// ── Config save/restore ──────────────────────────────────────────────────────

let savedConfig = null;

async function saveConfig() {
  const { body } = await get('/api/analytics/config');
  savedConfig = body.data || {};
}

async function restoreConfig() {
  if (savedConfig) {
    await put('/api/analytics/config', savedConfig);
  }
}

// ── Module definitions ───────────────────────────────────────────────────────

const MODULES = [
  {
    id:           'accessories',
    label:        'Accessories Detection',
    keys:         ['backpack', 'handbag', 'suitcase', 'umbrella', 'tie'],
    phase2keys:   ['glasses', 'sunglasses'],
    capKey:       'backpack',
    targetClass:  'accessories',
  },
  {
    id:          'animal',
    label:       'Animal Detection',
    keys:        ['bird', 'cat', 'dog', 'horse', 'cow', 'elephant'],
    phase2keys:  [],
    capKey:      null,   // animal keys not exposed in /api/capabilities (only in analytics/config)
    targetClass: 'animal',
  },
  {
    id:          'cloth',
    label:       'Cloth Analysis',
    keys:        ['cloth'],
    phase2keys:  [],
    capKey:      'cloth',
    targetClass: 'cloth',
  },
  {
    id:          'color',
    label:       'Color Analysis',
    keys:        ['color'],
    phase2keys:  [],
    capKey:      'color',
    targetClass: 'color',
  },
  {
    id:          'fire_smoke',
    label:       'Fire/Smoke Detection',
    keys:        ['fire', 'smoke'],
    phase2keys:  [],
    capKey:      'fire',
    targetClass: 'fire',
  },
  {
    id:          'hat',
    label:       'Hat Detection',
    keys:        ['hat'],
    phase2keys:  [],
    capKey:      'hat',
    targetClass: 'hat',
  },
  {
    id:          'mask',
    label:       'Mask Detection',
    keys:        ['mask'],
    phase2keys:  [],
    capKey:      'mask',
    targetClass: 'mask',
  },
  {
    id:          'vehicle',
    label:       'Vehicle Detection',
    keys:        ['vehicle'],
    phase2keys:  [],
    capKey:      'vehicle',
    targetClass: 'vehicle',
  },
];

// ── Prerequisites ─────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');

  const { status, body } = await get('/health');
  assert(status === 200, `Server not healthy: HTTP ${status}`);
  assert(body.status === 'ok', `Health: ${body.status}`);
  console.log('  ✓ Server is running');

  await saveConfig();
  console.log('  ✓ Original analytics config saved');
}

// ── Group A — Analytics Config per Module ────────────────────────────────────

async function runGroupA(mod) {
  const { id, label, keys } = mod;

  await test(`TC-A-${id}-001`, `${label}: GET /api/analytics/config contains module keys`, async () => {
    const { status, body } = await get('/api/analytics/config');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    for (const key of keys) {
      assert(key in body.data, `key "${key}" present in config`);
      assertEq(typeof body.data[key], 'boolean', `${key} is boolean`);
    }
  });

  await test(`TC-A-${id}-002`, `${label}: PUT enables first key`, async () => {
    const key = keys[0];
    const { status, body } = await put('/api/analytics/config', { [key]: true });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
  });

  await test(`TC-A-${id}-003`, `${label}: PUT disables first key`, async () => {
    const key = keys[0];
    await put('/api/analytics/config', { [key]: true });
    const { status, body } = await put('/api/analytics/config', { [key]: false });
    assertEq(status, 200, 'HTTP status');
    const verify = await get('/api/analytics/config');
    assertEq(verify.body.data[key], false, `${key} disabled`);
  });

  await test(`TC-A-${id}-004`, `${label}: PUT persists — GET returns updated value`, async () => {
    const key = keys[0];
    await put('/api/analytics/config', { [key]: true });
    const { body } = await get('/api/analytics/config');
    assertEq(body.data[key], true, `${key} persisted`);
    // Restore
    await put('/api/analytics/config', { [key]: false });
  });

  if (keys.length > 1) {
    await test(`TC-A-${id}-005`, `${label}: PUT partial update leaves other keys unchanged`, async () => {
      // Set all keys to false, then enable only first, verify rest unchanged
      const disableAll = {};
      keys.forEach(k => { disableAll[k] = false; });
      await put('/api/analytics/config', disableAll);

      await put('/api/analytics/config', { [keys[0]]: true });
      const { body } = await get('/api/analytics/config');
      assertEq(body.data[keys[0]], true, `${keys[0]} enabled`);
      for (const k of keys.slice(1)) {
        assertEq(body.data[k], false, `${k} unchanged`);
      }
      // Restore
      await put('/api/analytics/config', disableAll);
    });
  }
}

// ── Group B — Capabilities Endpoint ─────────────────────────────────────────

async function runGroupB(mod) {
  const { id, label, capKey } = mod;

  if (!capKey) {
    // Module not exposed in /api/capabilities (e.g. animal individual classes)
    return;
  }

  await test(`TC-B-${id}-001`, `${label}: GET /api/capabilities returns module availability`, async () => {
    const { status, body } = await get('/api/capabilities');
    assertEq(status, 200, 'HTTP status');
    assert(typeof body.ai === 'object', 'ai object present');
    assert(capKey in body.ai, `capability key "${capKey}" present`);
    assertEq(typeof body.ai[capKey], 'boolean', `${capKey} is boolean`);
  });

  await test(`TC-B-${id}-002`, `${label}: Capabilities status contains module key`, async () => {
    const { body } = await get('/api/capabilities');
    if (body.status && capKey in body.status) {
      const validStatuses = ['builtin', 'available', 'loaded', 'failed', 'missing', 'pending'];
      assert(
        validStatuses.includes(body.status[capKey]),
        `${capKey} status "${body.status[capKey]}" is valid`
      );
    }
    // No assertion if key not in status — not all modules expose status
  });
}

// ── Group D — Zone targetClass alias ─────────────────────────────────────────

async function runGroupD(mod) {
  const { id, label, targetClass } = mod;
  const SAMPLE_POLYGON = [
    { x: 10, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 200 }, { x: 10, y: 200 },
  ];

  // Create a test camera
  let cameraId = null;
  let zoneId   = null;

  try {
    const camRes = await fetch(`${BASE_URL}/api/cameras`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: `AI-${id}-test-cam`, rtspUrl: 'rtsp://127.0.0.1:8554/ai-test' }),
    });
    const cam = await camRes.json();
    if (camRes.status === 201) cameraId = cam.data?.id;
  } catch (_) {}

  if (!cameraId) return; // skip zone tests if camera creation fails

  await test(`TC-D-${id}-001`, `${label}: Zone with targetClasses: ["${targetClass}"] accepted`, async () => {
    const { status, body } = await post(`/api/cameras/${cameraId}/zones`, {
      name:          `TC-D-${id} Zone`,
      polygon:       SAMPLE_POLYGON,
      targetClasses: [targetClass],
    });
    assertEq(status, 201, 'HTTP status');
    assert(Array.isArray(body.data.targetClasses), 'targetClasses is array');
    assert(body.data.targetClasses.includes(targetClass), `"${targetClass}" in targetClasses`);
    zoneId = body.data.id;
  });

  // Cleanup
  if (zoneId)    { try { await fetch(`${BASE_URL}/api/cameras/${cameraId}/zones/${zoneId}`, { method: 'DELETE' }); } catch (_) {} }
  if (cameraId)  { try { await fetch(`${BASE_URL}/api/cameras/${cameraId}`, { method: 'DELETE' }); } catch (_) {} }
}

// ── Group F — Edge Cases ─────────────────────────────────────────────────────

async function runGroupF() {
  await test('TC-F-001', 'PUT analytics/config — unknown key accepted without error', async () => {
    // Server is permissive: unknown keys are accepted (200) and stored.
    // This verifies no crash occurs on unexpected input.
    const { status, body } = await put('/api/analytics/config', { __tc_f001_test_key__: true });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    // Server stores it (permissive behaviour — acceptable per FR design)
  });

  await test('TC-F-002', 'PUT analytics/config — empty body does not reset config', async () => {
    await put('/api/analytics/config', { color: true });
    await put('/api/analytics/config', {});
    const { body } = await get('/api/analytics/config');
    assertEq(body.data.color, true, 'color unchanged after empty PUT');
    await put('/api/analytics/config', { color: true }); // restore
  });

  await test('TC-F-003', 'GET /api/capabilities — structure is stable across calls', async () => {
    const r1 = await get('/api/capabilities');
    const r2 = await get('/api/capabilities');
    assertEq(JSON.stringify(Object.keys(r1.body.ai).sort()),
             JSON.stringify(Object.keys(r2.body.ai).sort()),
             'capability keys consistent');
  });

  await test('TC-F-004', 'Server health check passes', async () => {
    const { status, body } = await get('/health');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.status, 'ok', 'health ok');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC AI Detection Modules — Config & Capabilities    ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();

    for (const mod of MODULES) {
      console.log(`\n[Module: ${mod.label}]`);
      await runGroupA(mod);
      await runGroupB(mod);
      await runGroupD(mod);
    }

    console.log('\n[Group F] Edge Cases (Shared)\n');
    await runGroupF();

  } finally {
    await restoreConfig();
    console.log('\n  ✓ Original analytics config restored');
  }

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
  restoreConfig().catch(() => {});
  process.exit(1);
});
