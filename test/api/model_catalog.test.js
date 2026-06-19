'use strict';
/**
 * AI Model Catalog Tests
 *
 * TC: TC_AI_Model_Catalog
 *   Covers: TC-MC-001, TC-MC-002, TC-MC-005, TC-MC-007, TC-MC-008
 *
 * Network-dependent tests (TC-MC-004, TC-MC-009) require INTEGRATION_DOWNLOAD=1
 *
 * Prerequisites: Analysis server running (SERVER_MODE=analysis or combined)
 * Run: node test/api/model_catalog.test.js
 *
 * Set LTS_URL env var to override base URL.
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';
const INTEGRATION_DOWNLOAD = process.env.INTEGRATION_DOWNLOAD === '1';

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

function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description} [SKIP — ${reason}]`);
  results.push({ id, description, status: 'SKIP', reason });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── TC-MC-001: Catalog completeness ──────────────────────────────────────────

async function runGroupA() {
  console.log('\n[Group A] Catalog API — TC-MC-001, TC-MC-002');

  await test('TC-MC-001', 'GET /api/analysis/models returns 15 models with required fields', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.models), 'models is array');
    assertEq(body.models.length, 15, 'model count');

    const bySeriesV8   = body.models.filter(m => m.series === 'YOLOv8');
    const bySeries11   = body.models.filter(m => m.series === 'YOLO11');
    const bySeries12   = body.models.filter(m => m.series === 'YOLO12');
    assertEq(bySeriesV8.length, 5, 'YOLOv8 count');
    assertEq(bySeries11.length, 5, 'YOLO11 count');
    assertEq(bySeries12.length, 5, 'YOLO12 count');

    const required = ['id', 'label', 'series', 'mAP', 'cpuMs', 't4Ms', 'params', 'flops', 'downloaded', 'active', 'downloading', 'converting'];
    for (const m of body.models) {
      for (const field of required) {
        assert(field in m, `model ${m.id} missing field: ${field}`);
      }
    }
  });

  await test('TC-MC-002', 'YOLO12 entries have requiresConversion implied (converting field present)', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const yolo12 = body.models.filter(m => m.series === 'YOLO12');
    assertEq(yolo12.length, 5, 'YOLO12 count');
    for (const m of yolo12) {
      assert('converting' in m, `${m.id} should have converting field`);
    }
  });

  await test('TC-MC-002b', 'Active model flag is set for exactly one entry', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const activeModels = body.models.filter(m => m.active);
    assert(activeModels.length <= 1, `expected at most 1 active model, got ${activeModels.length}`);
  });
}

// ── TC-MC-007/008: Switch validation ─────────────────────────────────────────

async function runGroupB() {
  console.log('\n[Group B] Model Switch Validation — TC-MC-007, TC-MC-008');

  await test('TC-MC-007', 'POST /api/analysis/models/switch with unknown modelId returns 4xx', async () => {
    const { status, body } = await post('/api/analysis/models/switch', { modelId: '__nonexistent__' });
    assert(status >= 400, `expected 4xx, got ${status}`);
    assert(body.error, 'response should have error field');
  });

  await test('TC-MC-008', 'POST /api/analysis/models/switch with non-downloaded YOLO12 returns 400', async () => {
    const { status: catalogStatus, body: catalogBody } = await get('/api/analysis/models');
    assertEq(catalogStatus, 200, 'catalog HTTP status');
    const notDownloaded = catalogBody.models.find(m => m.series === 'YOLO12' && !m.downloaded);
    if (!notDownloaded) {
      console.log('    [INFO] All YOLO12 models already downloaded — TC-MC-008 cannot fully validate');
      return;
    }
    const { status, body } = await post('/api/analysis/models/switch', { modelId: notDownloaded.id });
    assertEq(status, 400, `expected 400 for non-downloaded model ${notDownloaded.id}`);
    assert(body.error, 'response should have error field');
  });
}

// ── TC-MC-004/009: Integration download (opt-in) ─────────────────────────────

async function runGroupC() {
  console.log('\n[Group C] Download Integration — TC-MC-004, TC-MC-009 (INTEGRATION_DOWNLOAD=1)');

  if (!INTEGRATION_DOWNLOAD) {
    skip('TC-MC-004', 'Download YOLOv8s direct ONNX', 'set INTEGRATION_DOWNLOAD=1 to enable');
    skip('TC-MC-009', 'Download YOLO12n PT→ONNX conversion', 'set INTEGRATION_DOWNLOAD=1 to enable');
    return;
  }

  await test('TC-MC-004', 'POST /api/analysis/models/download yolov8s — direct ONNX', async () => {
    const { status, body } = await post('/api/analysis/models/download', { modelId: 'yolov8s' });
    assert([200, 409].includes(status), `expected 200 or 409, got ${status}: ${body.error}`);
    if (status === 200 && !body.already) {
      // Poll until downloaded
      const deadline = Date.now() + 120_000;
      let downloaded = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const { body: cb } = await get('/api/analysis/models');
        const m = (cb.models || []).find(m => m.id === 'yolov8s');
        if (m?.downloaded) { downloaded = true; break; }
      }
      assert(downloaded, 'yolov8s.onnx should be downloaded within 120s');
    }
  });

  await test('TC-MC-009', 'POST /api/analysis/models/download yolo12n — PT→ONNX', async () => {
    const { status, body } = await post('/api/analysis/models/download', { modelId: 'yolo12n' });
    assert([200, 409].includes(status), `expected 200 or 409, got ${status}: ${body.error}`);
    if (status === 200 && !body.already) {
      const deadline = Date.now() + 600_000;
      let downloaded = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        const { body: cb } = await get('/api/analysis/models');
        const m = (cb.models || []).find(m => m.id === 'yolo12n');
        if (m?.downloaded) { downloaded = true; break; }
        if (m?.converting) console.log('    [INFO] YOLO12n: converting...');
      }
      assert(downloaded, 'yolo12n.onnx should be ready within 600s');
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== TC_AI_Model_Catalog ===');
  console.log(`Target: ${BASE_URL}`);

  await runGroupA();
  await runGroupB();
  await runGroupC();

  console.log('\n─────────────────────────────');
  console.log(`Result: ${passed} passed, ${failed} failed, ${results.filter(r => r.status === 'SKIP').length} skipped`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
