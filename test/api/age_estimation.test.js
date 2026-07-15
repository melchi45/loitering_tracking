'use strict';
/**
 * AI Age Estimation Tests
 *
 * TC: TC_AI_Age_Estimation
 *   Covers: TC-AGE-007, TC-AGE-008, TC-AGE-009, TC-AGE-014 (partial), TC-AGE-016, TC-AGE-017 (partial — unit-level only, no live model file) (unit — no running server required)
 *   Not automated here (see TC_AI_Age_Estimation.md §2): TC-AGE-001~006, TC-AGE-010~013, TC-AGE-015, TC-AGE-018~020
 *   (catalog/download/switch/toggle/persistence/display behavior — require a running
 *   analysis server and/or downloaded model files; exercised manually via the Admin
 *   Dashboard and live camera).
 *
 * Exercises server/src/services/ageEstimationService.js directly — no server
 * prerequisite, no real ONNX model file (the ONNX session is stubbed).
 * Run: node test/api/age_estimation.test.js
 */

const fs   = require('fs');
const path = require('path');
const { AgeEstimationService, VIT_AGE_BUCKET_CLASSES, VIT_AGE_BUCKET_MIDPOINT } =
  require('../../server/src/services/ageEstimationService');
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
  console.log('\n[Group A] Graceful load — TC-AGE-007');

  await test('TC-AGE-007', 'load() sets status="missing" when the model file does not exist, without throwing', async () => {
    const svc = new AgeEstimationService({ modelPath: require('path').join(__dirname, '__nonexistent_age_model__.onnx') });
    await svc.load();
    assert(svc.status === 'missing', `expected status 'missing', got '${svc.status}'`);
    assert(svc.ready === false, 'ready must be false when model is missing');
  });
}

async function runGroupB() {
  console.log('\n[Group B] Model switching — TC-AGE-006 (unit-level)');

  await test('TC-AGE-006b', 'reload() updates modelPath and re-runs load() against the new path', async () => {
    const svc = new AgeEstimationService({ modelPath: require('path').join(__dirname, '__nonexistent_a__.onnx') });
    await svc.load();
    assert(svc.status === 'missing', 'sanity: initial load should report missing');

    const newPath = require('path').join(__dirname, '__nonexistent_b__.onnx');
    await svc.reload(newPath);
    assert(svc.modelPath === newPath, 'modelPath should be updated after reload()');
    assert(svc.status === 'missing', 'reload() against another missing file should still report missing, not throw');
  });
}

async function runGroupC() {
  console.log('\n[Group C] Output normalization — TC-AGE-008');

  await test('TC-AGE-008a', 'InsightFace variant: estimateAge() normalizes to {value, source, modelId}, no bucket', async () => {
    const svc = new AgeEstimationService({ modelPath: '/fake/models/genderage.onnx' });
    svc._session = {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => ({ output: { data: [0.1, 0.9, 0.25] } }), // age channel = 0.25 → 25
    };
    svc._ready = true;
    svc._status = 'loaded';

    const jpeg = await makeFixtureJpeg();
    const result = await svc.estimateAge(jpeg, { x: 0, y: 0, width: 32, height: 32 }, { isFaceCrop: true });
    assert(result, 'expected a result object');
    assert(result.value === 25, `expected value=25, got ${result.value}`);
    assert(result.bucket === undefined, 'InsightFace result should not carry a bucket field');
    assert(result.source === 'face', `expected source='face', got '${result.source}'`);
    assert(result.modelId === 'insightface-genderage', `expected modelId='insightface-genderage', got '${result.modelId}'`);
  });

  await test('TC-AGE-008b', 'ViT variant: estimateAge() argmaxes the 9-bucket softmax and maps to the documented midpoint', async () => {
    const svc = new AgeEstimationService({ modelPath: '/fake/models/vit_age_classifier.onnx' });
    const logits = new Array(VIT_AGE_BUCKET_CLASSES.length).fill(0);
    const targetIndex = VIT_AGE_BUCKET_CLASSES.indexOf('20-29');
    logits[targetIndex] = 10; // dominant class
    svc._session = {
      inputNames: ['pixel_values'],
      outputNames: ['logits'],
      run: async () => ({ logits: { data: logits } }),
    };
    svc._ready = true;
    svc._status = 'loaded';

    const jpeg = await makeFixtureJpeg(224, 224);
    const result = await svc.estimateAge(jpeg, { x: 0, y: 0, width: 100, height: 100 }, { isFaceCrop: false });
    assert(result, 'expected a result object');
    assert(result.bucket === '20-29', `expected bucket='20-29', got '${result.bucket}'`);
    assert(result.value === VIT_AGE_BUCKET_MIDPOINT['20-29'], `expected value=${VIT_AGE_BUCKET_MIDPOINT['20-29']}, got ${result.value}`);
    assert(result.source === 'body', `expected source='body', got '${result.source}'`);
    assert(result.modelId === 'vit-age-classifier', `expected modelId='vit-age-classifier', got '${result.modelId}'`);
  });
}

async function runGroupD() {
  console.log('\n[Group D] Fallback / graceful no-op — TC-AGE-009');

  await test('TC-AGE-009', 'estimateAge() returns null (no throw) when the service is not ready or bbox is missing', async () => {
    const svc = new AgeEstimationService({ modelPath: '/fake/models/genderage.onnx' });
    // Not ready (no load() / stubbed session) — must return null, not throw.
    const jpeg = await makeFixtureJpeg();
    const r1 = await svc.estimateAge(jpeg, { x: 0, y: 0, width: 32, height: 32 }, { isFaceCrop: true });
    assert(r1 === null, 'expected null when service is not ready');

    svc._ready = true;
    svc._status = 'loaded';
    const r2 = await svc.estimateAge(jpeg, null, { isFaceCrop: false });
    assert(r2 === null, 'expected null when bbox is missing, even if ready');
  });
}

async function runGroupE() {
  console.log('\n[Group E] Metrics diagnostic field — TC-AGE-014');

  await test('TC-AGE-014a', 'getAnalysisMetrics().services includes an ageEstimation key (was silently omitted before 2026-07-14)', async () => {
    // getAnalysisMetrics() reads analyticsConfig.getConfig(), which touches the
    // global DB singleton — point it at a scratch dir so this stays a no-server-
    // required unit test rather than polluting storage/lts.json.
    const os = require('os');
    process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'lts-age-test-'));
    const { initDB } = require('../../server/src/db');
    await initDB();

    // Call the real method against a minimal fake instance (prototype chain intact,
    // so other prototype methods like _getLoadedModels() still resolve) — a full
    // constructor call pulls in capture/WebRTC engines out of scope for this
    // unit-level file; see TC_AI_Age_Estimation.md TC-AGE-014 for the full-server check.
    const fakeThis = Object.assign(Object.create(PipelineManager.prototype), {
      _pipelines: new Map(),
      _detector: null,
      _attrPipeline: null,
      _fireSmokeService: null,
      _ageEstimation: new AgeEstimationService(),
      _db: { all() { return []; } },
    });
    const metrics = fakeThis.getAnalysisMetrics();
    assert(Object.prototype.hasOwnProperty.call(metrics.services, 'ageEstimation'),
      'services object must have an ageEstimation key, even before any model is loaded');
    assert(metrics.services.ageEstimation === 'not_started',
      `expected 'not_started' for a freshly constructed service, got '${metrics.services.ageEstimation}'`);
  });
}

async function runGroupF() {
  console.log('\n[Group F] analysisApi.js detectionTracks persistence — TC-AGE-016');

  const analysisApiSrc = fs.readFileSync(
    path.join(__dirname, '../../server/src/routes/analysisApi.js'), 'utf8');

  function section(startMarker, endMarker) {
    const start = analysisApiSrc.indexOf(startMarker);
    assert(start !== -1, `marker not found (source may have moved): ${startMarker}`);
    const end = analysisApiSrc.indexOf(endMarker, start);
    assert(end !== -1, `end marker not found (source may have moved): ${endMarker}`);
    return analysisApiSrc.slice(start, end);
  }

  await test('TC-AGE-016a', '30s active-flush fields object carries estimatedAge/estimatedGender through to detectionTracks',
    async () => {
      const activeFlush = section(
        '// Active track flush: upsert long-running in-frame tracks every 30s',
        '// ── POST /api/analysis/frame');
      assert(/estimatedAge/.test(activeFlush),
        'active-flush fields object omits estimatedAge — in-progress tracks in the Detections timeline will show no age (Design doc §12.2)');
      assert(/estimatedGender/.test(activeFlush),
        'active-flush fields object omits estimatedGender');
    });

  await test('TC-AGE-016b', 'per-frame _trackMeta create/update block carries estimatedAge/estimatedGender (mirrors color/cloth)',
    async () => {
      const trackMetaBlock = section(
        '// ── Track lifecycle: update _trackMeta + flush removed tracks to DB',
        'if (fireSmoke.length > 0) _persistFireSmoke(');
      assert(/existing\.estimatedAge\s*=\s*obj\.estimatedAge/.test(trackMetaBlock),
        '_trackMeta update branch does not propagate obj.estimatedAge onto the existing meta entry');
      assert(/existing\.estimatedGender\s*=\s*obj\.estimatedGender/.test(trackMetaBlock),
        '_trackMeta update branch does not propagate obj.estimatedGender onto the existing meta entry');
      assert(/estimatedAge:\s*obj\.estimatedAge\s*\?\?\s*null/.test(trackMetaBlock),
        '_trackMeta creation branch does not seed estimatedAge for a newly-seen track');
      assert(/estimatedGender:\s*obj\.estimatedGender\s*\?\?\s*null/.test(trackMetaBlock),
        '_trackMeta creation branch does not seed estimatedGender for a newly-seen track');
    });

  await test('TC-AGE-016c', 'track-completion _completedFields object carries estimatedAge/estimatedGender into the persisted detectionTracks row',
    async () => {
      const trackMetaBlock = section(
        '// ── Track lifecycle: update _trackMeta + flush removed tracks to DB',
        'if (fireSmoke.length > 0) _persistFireSmoke(');
      const completedFieldsStart = trackMetaBlock.indexOf('_completedFields = {');
      assert(completedFieldsStart !== -1, '_completedFields object literal not found');
      const completedFields = trackMetaBlock.slice(completedFieldsStart, trackMetaBlock.indexOf('};', completedFieldsStart));
      assert(/estimatedAge:\s*meta\.estimatedAge/.test(completedFields),
        '_completedFields omits estimatedAge — a track that ends (leaves frame) will persist to detectionTracks with no age, even though it was attached live (Design doc §12.2 root cause 2)');
      assert(/estimatedGender:\s*meta\.estimatedGender/.test(completedFields),
        '_completedFields omits estimatedGender');
    });
}

async function runGroupG() {
  console.log('\n[Group G] Corrected preprocessing constants — TC-AGE-017 (accuracy remediation, Design doc §13)');

  // Fixture is a solid-color crop with 3 distinct channel values (R=120, G=100, B=90)
  // so channel-order bugs (feeding BGR instead of RGB) are directly observable in the
  // tensor the service builds — a channel-order bug would put 90 where 120 is expected.

  await test('TC-AGE-017a', 'InsightFace variant feeds RGB order (not BGR) with input_std=128.0 (not 127.5)', async () => {
    const svc = new AgeEstimationService({ modelPath: '/fake/models/genderage.onnx' });
    let capturedTensor = null;
    svc._session = {
      inputNames: ['input'], outputNames: ['output'],
      run: async (feeds) => { capturedTensor = feeds.input; return { output: { data: [0, 0, 0.25] } }; },
    };
    svc._ready = true; svc._status = 'loaded';

    const jpeg = await makeFixtureJpeg(32, 32); // R=120, G=100, B=90
    await svc.estimateAge(jpeg, { x: 0, y: 0, width: 32, height: 32 }, { isFaceCrop: true });

    assert(capturedTensor, 'expected the session to have been called with a tensor');
    const n = 96 * 96; // INSIGHTFACE_SIZE
    // Tolerance is loose enough to absorb JPEG quantization drift (the fixture is a
    // solid color re-encoded as JPEG, so a channel value can land ±1-2/255 off) but
    // far tighter than the ~0.13-0.23 error a real channel-order/divisor bug produces.
    const TOL = 0.02;
    const expectR = (120 - 127.5) / 128.0;
    const expectG = (100 - 127.5) / 128.0;
    const expectB = (90  - 127.5) / 128.0;
    assert(Math.abs(capturedTensor.data[0] - expectR) < TOL,
      `channel-plane 0 (should be R) expected ~${expectR}, got ${capturedTensor.data[0]} — RGB/BGR order or divisor regressed`);
    assert(Math.abs(capturedTensor.data[n] - expectG) < TOL,
      `channel-plane 1 (should be G) expected ~${expectG}, got ${capturedTensor.data[n]}`);
    assert(Math.abs(capturedTensor.data[2 * n] - expectB) < TOL,
      `channel-plane 2 (should be B) expected ~${expectB}, got ${capturedTensor.data[2 * n]} — if this equals the R value instead, channel order reverted to BGR`);
  });

  await test('TC-AGE-017b', 'ViT variant uses image_mean=image_std=[0.5,0.5,0.5] (not ImageNet statistics)', async () => {
    const svc = new AgeEstimationService({ modelPath: '/fake/models/vit_age_classifier.onnx' });
    let capturedTensor = null;
    svc._session = {
      inputNames: ['pixel_values'], outputNames: ['logits'],
      run: async (feeds) => { capturedTensor = feeds.pixel_values; return { logits: { data: new Array(VIT_AGE_BUCKET_CLASSES.length).fill(0) } }; },
    };
    svc._ready = true; svc._status = 'loaded';

    const jpeg = await makeFixtureJpeg(224, 224); // R=120, G=100, B=90
    await svc.estimateAge(jpeg, { x: 0, y: 0, width: 100, height: 100 }, { isFaceCrop: false });

    assert(capturedTensor, 'expected the session to have been called with a tensor');
    const n = 224 * 224; // VIT_SIZE
    const expectR = (120 / 255 - 0.5) / 0.5;
    assert(Math.abs(capturedTensor.data[0] - expectR) < 0.02,
      `expected ViT normalization (px/255-0.5)/0.5 = ${expectR}, got ${capturedTensor.data[0]} — ImageNet statistics may have regressed back in`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== TC_AI_Age_Estimation ===');

  await runGroupA();
  await runGroupB();
  await runGroupC();
  await runGroupD();
  await runGroupE();
  await runGroupF();
  await runGroupG();

  console.log('\n─────────────────────────────');
  console.log(`Result: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
