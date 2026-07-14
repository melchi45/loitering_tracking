'use strict';
/**
 * AI Model Catalog Tests
 *
 * TC: TC_AI_Model_Catalog
 *   Covers: TC-MC-001, TC-MC-002, TC-MC-002b, TC-MC-007, TC-MC-008,
 *           TC-MC-012, TC-MC-013, TC-MC-017, TC-MC-018, TC-MC-019,
 *           TC-MC-020, TC-MC-021, TC-MC-023, TC-MC-026, TC-MC-027
 *   Not automated here (see TC_AI_Model_Catalog.md §3): TC-MC-003, TC-MC-005,
 *   TC-MC-006, TC-MC-010, TC-MC-011, TC-MC-014, TC-MC-015, TC-MC-016,
 *   TC-MC-024, TC-MC-025, TC-MC-028, TC-MC-029, TC-MC-030
 *
 * Network-dependent tests (TC-MC-004, TC-MC-009) require INTEGRATION_DOWNLOAD=1
 *
 * Group D (TC-MC-018/019, PromptPAR memory gate), Group E (TC-MC-023,
 * Deactivate), and Group F (TC-MC-026/027, Active Model Persistence) are unit
 * tests — they require the relevant service file only, NOT a running server.
 *
 * Prerequisites: Analysis server running (SERVER_MODE=analysis or combined)
 *   for Groups A-C; Groups D-F have no server prerequisite.
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
    const expected = ['face-detection', 'face-recognition', 'ppe', 'fire-smoke', 'cloth-par', 'human-parsing', 'appearance-reid', 'age-estimation', 'gender-classification'];
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

  await test('TC-MC-020', 'age-estimation family exposes InsightFace GenderAge and ViT Age Classifier entries', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const ageEstimation = body.catalog.filter(m => m.family === 'age-estimation');
    assertEq(ageEstimation.length, 2, 'age-estimation entry count');

    const insightface = ageEstimation.find(m => m.id === 'insightface-genderage');
    const vit          = ageEstimation.find(m => m.id === 'vit-age-classifier');
    assert(insightface, 'expected InsightFace GenderAge entry (insightface-genderage)');
    assert(vit, 'expected ViT Age Classifier entry (vit-age-classifier)');
    assert(!insightface.manualOnly, 'InsightFace GenderAge should not be manualOnly — direct ONNX download');
    assert(!vit.manualOnly, 'ViT Age Classifier should not be manualOnly — automated via hfOptimumExport');
    assert(insightface.url === undefined, 'internal url field must not be exposed to client');
    assert(vit.hfOptimumExport === undefined, 'internal hfOptimumExport field must not be exposed to client');
  });

  await test('TC-GEN-001', 'gender-classification family exposes InsightFace GenderAge and ViT Gender Classifier entries', async () => {
    const { status, body } = await get('/api/analysis/models');
    assertEq(status, 200, 'HTTP status');
    const genderClassification = body.catalog.filter(m => m.family === 'gender-classification');
    assertEq(genderClassification.length, 2, 'gender-classification entry count');

    const insightface = genderClassification.find(m => m.id === 'insightface-genderage-gender');
    const vit          = genderClassification.find(m => m.id === 'vit-gender-classifier');
    assert(insightface, 'expected InsightFace GenderAge entry (insightface-genderage-gender)');
    assert(vit, 'expected ViT Gender Classifier entry (vit-gender-classifier)');
    assert(!insightface.manualOnly, 'InsightFace GenderAge should not be manualOnly — direct ONNX download');
    assert(!vit.manualOnly, 'ViT Gender Classifier should not be manualOnly — automated via hfOptimumExport');
    assert(insightface.url === undefined, 'internal url field must not be exposed to client');
    assert(vit.hfOptimumExport === undefined, 'internal hfOptimumExport field must not be exposed to client');
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

// ── TC-MC-023: Deactivate unloads each extended family (unit — no running server) ──
// Exercises the service classes directly with a stubbed ONNX session (a plain
// object with a `release()` spy), since a real model file/session isn't needed
// to verify the unload contract: release the session, null it out, reset ready state.

async function runGroupE() {
  console.log('\n[Group E] Deactivate — TC-MC-023 (unit)');

  const FaceService = require('../../server/src/services/faceService');
  const { ProtectiveEquipService } = require('../../server/src/services/protectiveEquipService');
  const FireSmokeService = require('../../server/src/services/fireSmokeService');
  const { ColorClothService } = require('../../server/src/services/colorClothService');
  const { AppearanceReidService } = require('../../server/src/services/appearanceReidService');
  const { AgeEstimationService } = require('../../server/src/services/ageEstimationService');

  const stubSession = () => {
    let released = false;
    return { release: () => { released = true; }, wasReleased: () => released };
  };

  await test('TC-MC-023a', 'FaceService.unloadDetector() releases SCRFD session and resets ready/status', async () => {
    const svc = new FaceService();
    const session = stubSession();
    svc._scrfd = session; svc._ready = true; svc._status = 'loaded';
    svc.unloadDetector();
    assert(session.wasReleased(), 'SCRFD session.release() should have been called');
    assert(svc._scrfd === null && svc._ready === false && svc._status === 'not_started', 'detector state not reset');
  });

  await test('TC-MC-023b', 'FaceService.unloadRecognizer() releases ArcFace session without touching detector state', async () => {
    const svc = new FaceService();
    const session = stubSession();
    svc._arcface = session; svc._ready = true; // detector state deliberately left true
    svc.unloadRecognizer();
    assert(session.wasReleased(), 'ArcFace session.release() should have been called');
    assert(svc._arcface === null, 'arcface session not nulled');
    assert(svc._ready === true, 'unloadRecognizer() must not touch detector _ready state');
  });

  await test('TC-MC-023c', 'ProtectiveEquipService.unload() releases session and resets ready/status', async () => {
    const svc = new ProtectiveEquipService();
    const session = stubSession();
    svc._session = session; svc._ready = true; svc._status = 'loaded';
    svc.unload();
    assert(session.wasReleased(), 'PPE session.release() should have been called');
    assert(svc._session === null && svc._ready === false && svc._status === 'not_started', 'PPE state not reset');
  });

  await test('TC-MC-023d', 'FireSmokeService.unload() releases session and resets ready/status', async () => {
    const svc = new FireSmokeService();
    const session = stubSession();
    svc._session = session; svc._ready = true; svc._status = 'loaded';
    svc.unload();
    assert(session.wasReleased(), 'Fire/Smoke session.release() should have been called');
    assert(svc._session === null && svc._ready === false && svc._status === 'not_started', 'Fire/Smoke state not reset');
  });

  await test('TC-MC-023e', 'ColorClothService.unloadPar() releases the PAR session and resets _parReady', async () => {
    const svc = new ColorClothService();
    const session = stubSession();
    svc._parSession = session; svc._parReady = true;
    svc.unloadPar();
    assert(session.wasReleased(), 'PAR session.release() should have been called');
    assert(svc._parSession === null && svc._parReady === false, 'cloth-par state not reset');
  });

  await test('TC-MC-023f', 'ColorClothService.unloadHumanParsing() releases the HP session and resets _hpReady + cache', async () => {
    const svc = new ColorClothService();
    const session = stubSession();
    svc._hpSession = session; svc._hpReady = true; svc._hpClassMap = { upper: [1], lower: [2] };
    svc._parseCache.set('track-1', { ts: Date.now(), color: {} });
    svc.unloadHumanParsing();
    assert(session.wasReleased(), 'Human Parsing session.release() should have been called');
    assert(svc._hpSession === null && svc._hpReady === false && svc._hpClassMap === null, 'human-parsing state not reset');
    assert(svc._parseCache.size === 0, 'per-track color cache should be cleared on deactivate');
  });

  await test('TC-MC-023g', 'AppearanceReidService.unload() releases session and resets ready/status', async () => {
    const svc = new AppearanceReidService();
    const session = stubSession();
    svc._session = session; svc._ready = true; svc._status = 'loaded';
    svc.unload();
    assert(session.wasReleased(), 'Appearance Re-ID session.release() should have been called');
    assert(svc._session === null && svc._ready === false && svc._status === 'not_started', 'Appearance Re-ID state not reset');
  });

  await test('TC-MC-023h', 'AgeEstimationService.unload() releases session and resets ready/status', async () => {
    const svc = new AgeEstimationService();
    const session = stubSession();
    svc._session = session; svc._ready = true; svc._status = 'loaded';
    svc.unload();
    assert(session.wasReleased(), 'Age Estimation session.release() should have been called');
    assert(svc._session === null && svc._ready === false && svc._status === 'not_started', 'Age Estimation state not reset');
  });
}

// ── TC-MC-026/027: Active Model Persistence (unit — no running server) ──────────
// Exercises server/src/services/activeModelConfig.js directly against a scratch
// JSON-backend DB (isolated STORAGE_PATH), since a persistence round-trip must
// not touch the real server's storage/lts.json. Verifies the exact contract
// _restoreActiveModels() (analysisApi.js) depends on: a switch writes the
// modelId, a deactivate writes an explicit `null` (not key removal), and the
// two are distinguishable from a family that was never touched at all.

async function runGroupF() {
  console.log('\n[Group F] Active Model Persistence — TC-MC-026, TC-MC-027 (unit)');

  const fs = require('fs');
  const path = require('path');
  const scratchDir = path.join(require('os').tmpdir(), `lts-test-activemodels-${Date.now()}`);

  const originalDbType = process.env.DB_TYPE;
  const originalStoragePath = process.env.STORAGE_PATH;
  process.env.DB_TYPE = 'json';
  process.env.STORAGE_PATH = scratchDir;
  fs.mkdirSync(scratchDir, { recursive: true });

  // Force fresh module instances so this scratch DB_TYPE/STORAGE_PATH is honored
  // even if server/src/db or activeModelConfig was already required elsewhere.
  delete require.cache[require.resolve('../../server/src/db')];
  delete require.cache[require.resolve('../../server/src/db/JsonDatabase')];
  delete require.cache[require.resolve('../../server/src/services/activeModelConfig')];

  try {
    const { initDB } = require('../../server/src/db');
    const activeModelConfig = require('../../server/src/services/activeModelConfig');
    await initDB();

    await test('TC-MC-026', 'A successful switch persists { family: modelId } to the settings table', async () => {
      activeModelConfig.setActiveModel('cloth-par', 'openpar-resnet50-pa100k');
      const models = activeModelConfig.getActiveModels();
      assertEq(models['cloth-par'], 'openpar-resnet50-pa100k', 'persisted modelId');

      // Round-trip through the raw JSON file, mirroring what _restoreActiveModels()
      // sees on the next process start (a fresh module load, not the in-memory cache).
      const { getDB } = require('../../server/src/db');
      getDB().flushNow();
      const raw = JSON.parse(fs.readFileSync(path.join(scratchDir, 'lts.json'), 'utf8'));
      const row = raw.settings.find(r => r.id === 'activeModels');
      assert(row, 'activeModels settings row should exist on disk');
      assertEq(row['cloth-par'], 'openpar-resnet50-pa100k', 'persisted modelId on disk');
    });

    await test('TC-MC-027', 'A successful deactivate persists an explicit null, distinct from an unconfigured family', async () => {
      activeModelConfig.setActiveModel('ppe', 'yolov8m-ppe');
      activeModelConfig.clearActiveModel('ppe');
      const models = activeModelConfig.getActiveModels();
      assert('ppe' in models, 'deactivated family key should still be present');
      assertEq(models['ppe'], null, 'deactivated family value should be explicit null');
      assert(!('face-detection' in models), 'a never-configured family should be absent, not null');
    });

    await test('TC-MC-026b', 'YOLO detector family (undefined catalog family) persists under the fixed DETECTOR_FAMILY_KEY', async () => {
      activeModelConfig.setActiveModel(undefined, 'yolo12n');
      const models = activeModelConfig.getActiveModels();
      assertEq(models[activeModelConfig.DETECTOR_FAMILY_KEY], 'yolo12n', 'detector family key');
    });

    // Flush the debounced JSON writer synchronously before the scratch dir is
    // removed below — otherwise its ~2s-delayed async write fires after cleanup
    // and logs a harmless but noisy ENOENT to stderr.
    require('../../server/src/db').getDB().flushNow();
  } finally {
    if (originalDbType === undefined) delete process.env.DB_TYPE; else process.env.DB_TYPE = originalDbType;
    if (originalStoragePath === undefined) delete process.env.STORAGE_PATH; else process.env.STORAGE_PATH = originalStoragePath;
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== TC_AI_Model_Catalog ===');
  console.log(`Target: ${BASE_URL}`);

  await runGroupA();
  await runGroupB();
  await runGroupC();
  await runGroupD();
  await runGroupE();
  await runGroupF();

  console.log('\n─────────────────────────────');
  console.log(`Result: ${passed} passed, ${failed} failed, ${results.filter(r => r.status === 'SKIP').length} skipped`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
