'use strict';
/**
 * AI Model Catalog Tests
 *
 * TC: TC_AI_Model_Catalog
 *   Covers: TC-MC-001, TC-MC-002, TC-MC-002b, TC-MC-007, TC-MC-008,
 *           TC-MC-012, TC-MC-013, TC-MC-017, TC-MC-018, TC-MC-019
 *   Not automated here (see TC_AI_Model_Catalog.md §3): TC-MC-003, TC-MC-005,
 *   TC-MC-006, TC-MC-010, TC-MC-011, TC-MC-014, TC-MC-015, TC-MC-016
 *
 * Network-dependent tests (TC-MC-004, TC-MC-009) require INTEGRATION_DOWNLOAD=1
 *
 * Group D (TC-MC-018/019, PromptPAR memory gate) is a unit test — it requires
 * server/src/services/colorClothService.js only, NOT a running server.
 *
 * Prerequisites: Analysis server running (SERVER_MODE=analysis or combined)
 *   for Groups A-C; Group D has no server prerequisite.
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
  console.log('\n[Group A] Catalog API — TC-MC-001, TC-MC-002, TC-MC-012');

  await test('TC-MC-001', 'GET /api/analysis/models returns the YOLO detector catalog with required fields', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    assert(Array.isArray(body.catalog), 'catalog is array');

    const detectors = body.catalog.filter(m => !m.family);
    assertEq(detectors.length, 20, 'YOLO detector count (26/12/11/v8 × n/s/m/l/x)');

    const bySeries26  = detectors.filter(m => m.series === 'YOLO26');
    const bySeriesV8   = detectors.filter(m => m.series === 'YOLOv8');
    const bySeries11   = detectors.filter(m => m.series === 'YOLO11');
    const bySeries12   = detectors.filter(m => m.series === 'YOLO12');
    assertEq(bySeries26.length, 5, 'YOLO26 count');
    assertEq(bySeriesV8.length, 5, 'YOLOv8 count');
    assertEq(bySeries11.length, 5, 'YOLO11 count');
    assertEq(bySeries12.length, 5, 'YOLO12 count');

    const required = ['id', 'label', 'series', 'mAP', 'cpuMs', 't4Ms', 'params', 'flops', 'exists', 'active', 'downloading', 'converting'];
    for (const m of detectors) {
      for (const field of required) {
        assert(field in m, `model ${m.id} missing field: ${field}`);
      }
    }
  });

  await test('TC-MC-002', 'YOLO12 entries have requiresConversion implied (converting field present)', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const yolo12 = body.catalog.filter(m => m.series === 'YOLO12');
    assertEq(yolo12.length, 5, 'YOLO12 count');
    for (const m of yolo12) {
      assert('converting' in m, `${m.id} should have converting field`);
    }
  });

  await test('TC-MC-002b', 'Active model flag is set for at most one entry per family', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const byFamily = new Map();
    for (const m of body.catalog) {
      if (!m.active) continue;
      const key = m.family || 'detector';
      byFamily.set(key, (byFamily.get(key) || 0) + 1);
    }
    for (const [family, count] of byFamily) {
      assert(count <= 1, `expected at most 1 active model for family=${family}, got ${count}`);
    }
  });

  await test('TC-MC-012', 'Catalog includes all non-detector model families', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const families = new Set(body.catalog.map(m => m.family).filter(Boolean));
    const expected = ['face-detection', 'face-recognition', 'ppe', 'fire-smoke', 'cloth-par', 'human-parsing', 'appearance-reid'];
    for (const family of expected) {
      assert(families.has(family), `catalog missing family: ${family}`);
    }
    // manualOnly entries (no automatable source) must never expose a raw download URL
    const manualEntries = body.catalog.filter(m => m.manualOnly);
    assert(manualEntries.length >= 1, 'expected at least one manualOnly entry (cloth-par)');
    for (const m of manualEntries) {
      assert(m.url === undefined, `manualOnly entry ${m.id} should not expose a url field`);
    }
  });

  await test('TC-MC-017', 'cloth-par family exposes one memory-gated PromptPAR entry and one non-gated OpenPAR alternative', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const clothPar = body.catalog.filter(m => m.family === 'cloth-par');
    assertEq(clothPar.length, 2, 'cloth-par entry count');

    const promptPar = clothPar.find(m => m.id === 'openpar-pa100k');
    const openPar   = clothPar.find(m => m.id === 'openpar-resnet50-pa100k');
    assert(promptPar, 'expected PromptPAR entry (openpar-pa100k)');
    assert(openPar, 'expected OpenPAR entry (openpar-resnet50-pa100k)');
    assert(!promptPar.manualOnly, 'PromptPAR should not be manualOnly — shipped directly in server/models/');
    assert(openPar.manualOnly === true, 'OpenPAR should be manualOnly — no public pretrained ONNX release');
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

  await test('TC-MC-008', 'POST /api/analysis/models/switch with non-downloaded YOLO12 returns 409', async () => {
    const { status: catalogStatus, body: catalogBody } = await get('/api/analysis/models');
    assertEq(catalogStatus, 200, 'catalog HTTP status');
    const notDownloaded = catalogBody.catalog.find(m => m.series === 'YOLO12' && !m.exists);
    if (!notDownloaded) {
      console.log('    [INFO] All YOLO12 models already downloaded — TC-MC-008 cannot fully validate');
      return;
    }
    const { status, body } = await post('/api/analysis/models/switch', { modelId: notDownloaded.id });
    assertEq(status, 409, `expected 409 for non-downloaded model ${notDownloaded.id}`);
    assert(body.error, 'response should have error field');
  });

  await test('TC-MC-013', 'POST /api/analysis/models/download for a manualOnly entry returns 409', async () => {
    const { status: catalogStatus, body: catalogBody } = await get('/api/analysis/models');
    assertEq(catalogStatus, 200, 'catalog HTTP status');
    const manualEntry = catalogBody.catalog.find(m => m.manualOnly);
    if (!manualEntry) {
      console.log('    [INFO] No manualOnly catalog entry found — TC-MC-013 cannot fully validate');
      return;
    }
    const { status, body } = await post('/api/analysis/models/download', { modelId: manualEntry.id });
    assertEq(status, 409, `expected 409 for manualOnly model ${manualEntry.id}`);
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
        const m = (cb.catalog || []).find(m => m.id === 'yolov8s');
        if (m?.exists) { downloaded = true; break; }
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
        const m = (cb.catalog || []).find(m => m.id === 'yolo12n');
        if (m?.exists) { downloaded = true; break; }
        if (m?.converting) console.log('    [INFO] YOLO12n: converting...');
      }
      assert(downloaded, 'yolo12n.onnx should be ready within 600s');
    }
  });
}

// ── TC-MC-018/019: PromptPAR memory gate (unit — no running server required) ────
// Exercises server/src/services/colorClothService.js directly, since a real
// ~1.2GB PromptPAR checkpoint is not available in CI. The gate check runs
// before any filesystem/ONNX access, so a fake path is enough to hit it.

async function runGroupD() {
  console.log('\n[Group D] PromptPAR Memory Gate — TC-MC-018, TC-MC-019 (unit)');

  const os = require('os');
  const path = require('path');
  const { ColorClothService, checkPromptParMemory, PROMPTPAR_MIN_FREE_MEM_MB } =
    require('../../server/src/services/colorClothService');

  const realFreemem = os.freemem;
  const FAKE_PROMPTPAR_PATH = path.join('server', 'models', 'openpar_pa100k.onnx');
  const FAKE_OPENPAR_PATH   = path.join('server', 'models', 'openpar_resnet50_pa100k.onnx');

  await test('TC-MC-018', 'reloadPar() rejects PromptPAR and logs when free RAM is below the gate', async () => {
    os.freemem = () => 1 * 1024 * 1024 * 1024; // 1GB — below the 2GB default floor
    try {
      const mem = checkPromptParMemory();
      assert(mem.ok === false, `expected gate to fail at 1GB free (required ${PROMPTPAR_MIN_FREE_MEM_MB}MB)`);

      const svc = new ColorClothService();
      let threw = false;
      try {
        await svc.reloadPar(FAKE_PROMPTPAR_PATH);
      } catch (err) {
        threw = true;
        assert(/PromptPAR/.test(err.message), `error message should reference PromptPAR: ${err.message}`);
      }
      assert(threw, 'reloadPar() should throw when the memory gate fails');
      assert(svc._parReady === false, '_parReady must remain false after a gated rejection');
    } finally {
      os.freemem = realFreemem;
    }
  });

  await test('TC-MC-019', 'checkPromptParMemory() passes and OpenPAR (non-gated) is unaffected by low free RAM', async () => {
    os.freemem = () => 1 * 1024 * 1024 * 1024; // still 1GB — OpenPAR must not care
    try {
      const mem = checkPromptParMemory();
      assert(mem.ok === false, 'sanity: gate should still read as failing at 1GB for PromptPAR');
      // OpenPAR's filename isn't in the gated set, so the gate check itself is a no-op
      // for it (the ONNX load would still be attempted — not asserted here, no real file).
      const svc = new ColorClothService();
      assert(svc._checkPromptParGate(FAKE_OPENPAR_PATH) === true, 'OpenPAR path must not be memory-gated');
    } finally {
      os.freemem = realFreemem;
    }

    os.freemem = () => 8 * 1024 * 1024 * 1024; // 8GB — comfortably above the floor
    try {
      const mem = checkPromptParMemory();
      assert(mem.ok === true, 'expected gate to pass at 8GB free');
    } finally {
      os.freemem = realFreemem;
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
  await runGroupD();

  console.log('\n─────────────────────────────');
  console.log(`Result: ${passed} passed, ${failed} failed, ${results.filter(r => r.status === 'SKIP').length} skipped`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
