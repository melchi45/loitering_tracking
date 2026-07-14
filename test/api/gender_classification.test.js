'use strict';
/**
 * AI Gender Classification Tests
 *
 * TC: TC_AI_Gender_Classification
 *   Covers: TC-GEN-007, TC-GEN-008, TC-GEN-009, TC-GEN-014 (partial), TC-GEN-016 (unit — no running server required)
 *   Not automated here (see TC_AI_Gender_Classification.md §2): TC-GEN-001~006, TC-GEN-010~013, TC-GEN-015
 *   (catalog/download/switch/toggle/persistence/display behavior — require a running
 *   analysis server and/or downloaded model files; exercised manually via the Admin
 *   Dashboard and live camera).
 *
 * Exercises server/src/services/genderClassificationService.js directly — no server
 * prerequisite, no real ONNX model file (the ONNX session is stubbed).
 * Run: node test/api/gender_classification.test.js
 */

const fs   = require('fs');
const path = require('path');
const { GenderClassificationService, VIT_GENDER_CLASSES } =
  require('../../server/src/services/genderClassificationService');
const PipelineManager = require('../../server/src/services/pipelineManager');

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

async function makeFixtureJpeg(width = 64, height = 64) {
  // sharp lives in server/node_modules (not hoisted to the repo root) — resolve explicitly
  // since this test file is under test/api/, not server/.
  const sharp = require('../../server/node_modules/sharp');
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 100, b: 90 } },
  }).jpeg().toBuffer();
}

async function runGroupA() {
  console.log('\n[Group A] Graceful load — TC-GEN-007');

  await test('TC-GEN-007', 'load() sets status="missing" when the model file does not exist, without throwing', async () => {
    const svc = new GenderClassificationService({ modelPath: require('path').join(__dirname, '__nonexistent_gender_model__.onnx') });
    await svc.load();
    assert(svc.status === 'missing', `expected status 'missing', got '${svc.status}'`);
    assert(svc.ready === false, 'ready must be false when model is missing');
  });
}

async function runGroupB() {
  console.log('\n[Group B] Model switching — TC-GEN-006 (unit-level)');

  await test('TC-GEN-006b', 'reload() updates modelPath and re-runs load() against the new path', async () => {
    const svc = new GenderClassificationService({ modelPath: require('path').join(__dirname, '__nonexistent_a__.onnx') });
    await svc.load();
    assert(svc.status === 'missing', 'sanity: initial load should report missing');

    const newPath = require('path').join(__dirname, '__nonexistent_b__.onnx');
    await svc.reload(newPath);
    assert(svc.modelPath === newPath, 'modelPath should be updated after reload()');
    assert(svc.status === 'missing', 'reload() against another missing file should still report missing, not throw');
  });
}

async function runGroupC() {
  console.log('\n[Group C] Output normalization — TC-GEN-008');

  await test('TC-GEN-008a', 'InsightFace variant: classifyGender() normalizes to {value, confidence, source, modelId}', async () => {
    const svc = new GenderClassificationService({ modelPath: '/fake/models/genderage.onnx' });
    svc._session = {
      inputNames: ['input'],
      outputNames: ['output'],
      // gender logits [female, male] favor male, age channel (ignored here) = 0.25
      run: async () => ({ output: { data: [0.1, 0.9, 0.25] } }),
    };
    svc._ready = true;
    svc._status = 'loaded';

    const jpeg = await makeFixtureJpeg();
    const result = await svc.classifyGender(jpeg, { x: 0, y: 0, width: 32, height: 32 }, { isFaceCrop: true });
    assert(result, 'expected a result object');
    assert(result.value === 'male', `expected value='male', got '${result.value}'`);
    assert(result.confidence > 0.5, `expected confidence > 0.5 for the dominant class, got ${result.confidence}`);
    assert(result.source === 'face', `expected source='face', got '${result.source}'`);
    assert(result.modelId === 'insightface-genderage-gender', `expected modelId='insightface-genderage-gender', got '${result.modelId}'`);
  });

  await test('TC-GEN-008b', 'ViT variant: classifyGender() argmaxes the 2-class softmax', async () => {
    const svc = new GenderClassificationService({ modelPath: '/fake/models/vit_gender_classifier.onnx' });
    const logits = new Array(VIT_GENDER_CLASSES.length).fill(0);
    const targetIndex = VIT_GENDER_CLASSES.indexOf('female');
    logits[targetIndex] = 10; // dominant class
    svc._session = {
      inputNames: ['pixel_values'],
      outputNames: ['logits'],
      run: async () => ({ logits: { data: logits } }),
    };
    svc._ready = true;
    svc._status = 'loaded';

    const jpeg = await makeFixtureJpeg(224, 224);
    const result = await svc.classifyGender(jpeg, { x: 0, y: 0, width: 100, height: 100 }, { isFaceCrop: false });
    assert(result, 'expected a result object');
    assert(result.value === 'female', `expected value='female', got '${result.value}'`);
    assert(result.confidence > 0.9, `expected high confidence for the dominant class, got ${result.confidence}`);
    assert(result.source === 'body', `expected source='body', got '${result.source}'`);
    assert(result.modelId === 'vit-gender-classifier', `expected modelId='vit-gender-classifier', got '${result.modelId}'`);
  });
}

async function runGroupD() {
  console.log('\n[Group D] Fallback / graceful no-op — TC-GEN-009');

  await test('TC-GEN-009', 'classifyGender() returns null (no throw) when the service is not ready or bbox is missing', async () => {
    const svc = new GenderClassificationService({ modelPath: '/fake/models/genderage.onnx' });
    // Not ready (no load() / stubbed session) — must return null, not throw.
    const jpeg = await makeFixtureJpeg();
    const r1 = await svc.classifyGender(jpeg, { x: 0, y: 0, width: 32, height: 32 }, { isFaceCrop: true });
    assert(r1 === null, 'expected null when service is not ready');

    svc._ready = true;
    svc._status = 'loaded';
    const r2 = await svc.classifyGender(jpeg, null, { isFaceCrop: false });
    assert(r2 === null, 'expected null when bbox is missing, even if ready');
  });
}

async function runGroupE() {
  console.log('\n[Group E] Metrics diagnostic field — TC-GEN-014');

  await test('TC-GEN-014a', 'getAnalysisMetrics().services includes a genderClassification key', async () => {
    // getAnalysisMetrics() reads analyticsConfig.getConfig(), which touches the
    // global DB singleton — point it at a scratch dir so this stays a no-server-
    // required unit test rather than polluting storage/lts.json.
    const os = require('os');
    process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'lts-gender-test-'));
    const { initDB } = require('../../server/src/db');
    await initDB();

    // Call the real method against a minimal fake instance (prototype chain intact,
    // so other prototype methods like _getLoadedModels() still resolve) — a full
    // constructor call pulls in capture/WebRTC engines out of scope for this
    // unit-level file; see TC_AI_Gender_Classification.md TC-GEN-014 for the full-server check.
    const fakeThis = Object.assign(Object.create(PipelineManager.prototype), {
      _pipelines: new Map(),
      _detector: null,
      _attrPipeline: null,
      _fireSmokeService: null,
      _ageEstimation: null,
      _genderClassification: new GenderClassificationService(),
      _db: { all() { return []; } },
    });
    const metrics = fakeThis.getAnalysisMetrics();
    assert(Object.prototype.hasOwnProperty.call(metrics.services, 'genderClassification'),
      'services object must have a genderClassification key, even before any model is loaded');
    assert(metrics.services.genderClassification === 'not_started',
      `expected 'not_started' for a freshly constructed service, got '${metrics.services.genderClassification}'`);
  });
}

async function runGroupF() {
  console.log('\n[Group F] analysisApi.js detectionTracks persistence — TC-GEN-016');

  const analysisApiSrc = fs.readFileSync(
    path.join(__dirname, '../../server/src/routes/analysisApi.js'), 'utf8');

  function section(startMarker, endMarker) {
    const start = analysisApiSrc.indexOf(startMarker);
    assert(start !== -1, `marker not found (source may have moved): ${startMarker}`);
    const end = analysisApiSrc.indexOf(endMarker, start);
    assert(end !== -1, `end marker not found (source may have moved): ${endMarker}`);
    return analysisApiSrc.slice(start, end);
  }

  await test('TC-GEN-016a', '30s active-flush fields object carries estimatedGender through to detectionTracks',
    async () => {
      const activeFlush = section(
        '// Active track flush: upsert long-running in-frame tracks every 30s',
        '// ── POST /api/analysis/frame');
      assert(/estimatedGender/.test(activeFlush),
        'active-flush fields object omits estimatedGender — in-progress tracks in the Detections timeline will show no gender (mirrors Age Estimation Design doc §12.2)');
    });

  await test('TC-GEN-016b', 'per-frame _trackMeta create/update block carries estimatedGender (mirrors color/cloth/estimatedAge)',
    async () => {
      const trackMetaBlock = section(
        '// ── Track lifecycle: update _trackMeta + flush removed tracks to DB',
        'if (fireSmoke.length > 0) _persistFireSmoke(');
      assert(/existing\.estimatedGender\s*=\s*obj\.estimatedGender/.test(trackMetaBlock),
        '_trackMeta update branch does not propagate obj.estimatedGender onto the existing meta entry');
      assert(/estimatedGender:\s*obj\.estimatedGender\s*\?\?\s*null/.test(trackMetaBlock),
        '_trackMeta creation branch does not seed estimatedGender for a newly-seen track');
    });

  await test('TC-GEN-016c', 'track-completion _completedFields object carries estimatedGender into the persisted detectionTracks row',
    async () => {
      const trackMetaBlock = section(
        '// ── Track lifecycle: update _trackMeta + flush removed tracks to DB',
        'if (fireSmoke.length > 0) _persistFireSmoke(');
      const completedFieldsStart = trackMetaBlock.indexOf('_completedFields = {');
      assert(completedFieldsStart !== -1, '_completedFields object literal not found');
      const completedFields = trackMetaBlock.slice(completedFieldsStart, trackMetaBlock.indexOf('};', completedFieldsStart));
      assert(/estimatedGender:\s*meta\.estimatedGender/.test(completedFields),
        '_completedFields omits estimatedGender — a track that ends (leaves frame) will persist to detectionTracks with no gender');
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== TC_AI_Gender_Classification ===');

  await runGroupA();
  await runGroupB();
  await runGroupC();
  await runGroupD();
  await runGroupE();
  await runGroupF();

  console.log('\n─────────────────────────────');
  console.log(`Result: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
