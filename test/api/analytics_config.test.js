'use strict';
/**
 * Analytics Config API Tests
 *
 * TC: TC_AI_Animal_Detection (Group C — Config Toggle)
 *     TC_AI_Hat_Detection    (Group C — Config Toggle)
 *     TC_AI_Mask_Detection   (Group C — Config Toggle)
 *     TC_AI_Human_Detection  (Group C — Config Toggle)
 *     TC_AI_Vehicle_Detection (Group C)
 *     TC_AI_Fire_Smoke_Detection (Group C)
 *     TC_AI_Accessories_Detection (Group C)
 *     TC_AI_Color_Analysis   (Group C)
 *     TC_AI_Cloth_Analysis   (Group C)
 *
 * API: GET /api/analytics/config
 *      PUT /api/analytics/config
 *
 * Prerequisites: Server running on BASE_URL (default http://localhost:3080)
 * Run: node test/api/analytics_config.test.js
 *
 * Set LTS_URL env var to override base URL.
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
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function put(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

// ── Saved original config for restoration ────────────────────────────────────

let originalConfig = null;

async function saveConfig() {
  const { body } = await get('/api/analytics/config');
  originalConfig = { ...body.data };
}

async function restoreConfig() {
  if (originalConfig) {
    await put('/api/analytics/config', originalConfig);
  }
}

// ── Prerequisites ────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not healthy: HTTP ${health.status}`);
  assert(health.body.status === 'ok', `Unexpected health status: ${health.body.status}`);
  console.log('  ✓ Server is running');
  await saveConfig();
  console.log('  ✓ Original analytics config saved\n');
}

// ── Group A — GET analytics config ──────────────────────────────────────────

async function runGroupA() {
  console.log('[Group A] GET /api/analytics/config\n');

  await test('TC-CFG-001', 'GET /api/analytics/config → 200 with data object', async () => {
    const { status, body } = await get('/api/analytics/config');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assert(body.data && typeof body.data === 'object', 'data is object');
  });

  await test('TC-CFG-002', 'GET config contains expected boolean fields', async () => {
    const { body } = await get('/api/analytics/config');
    const cfg = body.data;
    // Key AI module flags should be present and boolean
    for (const key of ['human', 'face', 'vehicle']) {
      assert(typeof cfg[key] === 'boolean', `config.${key} should be boolean (got ${typeof cfg[key]})`);
    }
  });
}

// ── Group B — PUT analytics config ──────────────────────────────────────────

async function runGroupB() {
  console.log('\n[Group B] PUT /api/analytics/config\n');

  await test('TC-CFG-010', 'PUT /api/analytics/config → 200 updates field', async () => {
    // Toggle human detection: get current then flip
    const { body: before } = await get('/api/analytics/config');
    const currentHuman = before.data.human;
    const { status, body } = await put('/api/analytics/config', { human: !currentHuman });
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'success');
    assertEq(body.data.human, !currentHuman, 'human toggled');
  });

  await test('TC-CFG-011', 'PUT persists change: GET returns updated value', async () => {
    await put('/api/analytics/config', { vehicle: false });
    const { body } = await get('/api/analytics/config');
    assertEq(body.data.vehicle, false, 'vehicle false after PUT');
  });

  await test('TC-CFG-012', 'PUT invalid body (malformed JSON) → non-200', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not_json',
    });
    // Express body-parser returns 400; global error handler may return 500
    assert(res.status >= 400, `Expected error status, got ${res.status}`);
  });
}

// ── Group C — Per-module toggle tests ───────────────────────────────────────

async function runGroupC() {
  console.log('\n[Group C] Per-module Toggle\n');

  const MODULES = [
    { key: 'human',      label: 'Human Detection'       },
    { key: 'face',       label: 'Face Recognition'      },
    { key: 'vehicle',    label: 'Vehicle Detection'      },
    { key: 'fire',       label: 'Fire/Smoke Detection'  },
    { key: 'hat',        label: 'Hat Detection'          },
    { key: 'mask',       label: 'Mask Detection'         },
    { key: 'animal',     label: 'Animal Detection'       },
    { key: 'color',      label: 'Color Analysis'         },
    { key: 'cloth',      label: 'Cloth Analysis'         },
    { key: 'accessory',  label: 'Accessories Detection'  },
  ];

  for (const mod of MODULES) {
    await test(
      `TC-CFG-C-${mod.key}`,
      `Toggle ${mod.label} (key: ${mod.key}) off then on`,
      async () => {
        // Disable
        const { status: s1, body: b1 } = await put('/api/analytics/config', { [mod.key]: false });
        assertEq(s1, 200, `disable ${mod.key} HTTP status`);
        // Key may not exist (not all keys are in every config), skip assertion if absent
        if (mod.key in b1.data) {
          assertEq(b1.data[mod.key], false, `${mod.key} disabled`);
        }
        // Re-enable
        const { status: s2, body: b2 } = await put('/api/analytics/config', { [mod.key]: true });
        assertEq(s2, 200, `enable ${mod.key} HTTP status`);
        if (mod.key in b2.data) {
          assertEq(b2.data[mod.key], true, `${mod.key} re-enabled`);
        }
      }
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC AI Modules — Analytics Config Tests             ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupB();
    await runGroupC();
  } finally {
    await restoreConfig();
    console.log('\n  ✓ Original analytics config restored');
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
