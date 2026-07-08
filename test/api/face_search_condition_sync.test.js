'use strict';
/**
 * Face Search Condition Sync — Streaming ↔ Analysis
 *
 * TC: TC-FSC-A-001 ~ TC-FSC-C-002
 * SRS: FR-FSC-001 ~ FR-FSC-016
 *
 * Group A (enrollment delegation) runs against whichever server BASE_URL points to,
 * regardless of SERVER_MODE. Groups B/C require a live analysis server reachable at
 * process.env.ANALYSIS_SERVER_URL (inherited from the TC runner's spawned environment)
 * — if unset or unreachable, those cases soft-skip rather than fail.
 *
 * Run: node test/api/face_search_condition_sync.test.js
 */

const fs   = require('fs');
const path = require('path');

const BASE_URL     = process.env.LTS_URL || 'http://localhost:3080';
const ANALYSIS_URL = process.env.ANALYSIS_SERVER_URL || '';
const FIXTURE_DIR  = path.resolve(__dirname, '../fixtures');

let passed = 0, failed = 0, skipped = 0;
const results = [];

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed++;
    results.push({ id, description, status: 'PASS' });
  } catch (err) {
    if (err.message === 'SKIP') {
      console.log(`  ⊘ ${id}: ${description} (skipped)`);
      skipped++;
      results.push({ id, description, status: 'SKIP' });
    } else {
      console.error(`  ✗ ${id}: ${description}\n      ${err.message}`);
      failed++;
      results.push({ id, description, status: 'FAIL', error: err.message });
    }
  }
}

function skip(reason) { const e = new Error('SKIP'); e.reason = reason; throw e; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEq(a, e, l) { if (a !== e) throw new Error(`${l}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }

// ── HTTP helpers (against BASE_URL — the server under test) ───────────────────

async function get(p, base = BASE_URL) {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
}
async function post(p, body, base = BASE_URL) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function del(p, base = BASE_URL) {
  const res = await fetch(`${base}${p}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}
async function postMultipart(urlPath, filePath, name, base = BASE_URL) {
  const formData = new FormData();
  const blob = new Blob([fs.readFileSync(filePath)], { type: 'image/jpeg' });
  formData.append('photo', blob, path.basename(filePath));
  if (name) formData.append('name', name);
  const res = await fetch(`${base}${urlPath}`, { method: 'POST', body: formData });
  return { status: res.status, body: await res.json() };
}
async function postRawJpeg(urlPath, filePath, base = ANALYSIS_URL) {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: fs.readFileSync(filePath),
  });
  return { status: res.status, body: await res.json() };
}

const createdGalleries = [];
async function createGallery(name, type = 'general', base = BASE_URL) {
  const r = await post('/api/galleries', { name, type }, base);
  assert(r.status === 201, `createGallery: ${r.status}`);
  createdGalleries.push({ id: r.body.data.id, base });
  return r.body.data;
}
async function cleanupAll() {
  for (const { id, base } of [...createdGalleries]) {
    try { await del(`/api/galleries/${id}`, base); } catch (_) {}
  }
  createdGalleries.length = 0;
}

async function analysisReachable() {
  if (!ANALYSIS_URL) return false;
  try {
    const res = await fetch(`${ANALYSIS_URL}/api/analysis/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

const facePath = (() => {
  const candidates = [
    path.join(FIXTURE_DIR, 'face_clear.jpg'),
    path.join(FIXTURE_DIR, 'face.jpg'),
  ];
  return candidates.find(c => fs.existsSync(c)) || null;
})();
const noFacePath = path.join(FIXTURE_DIR, 'no_face.jpg');

// ── Group A — Enrollment Delegation ────────────────────────────────────────────

async function runGroupA() {
  console.log('\n[Group A] Enrollment Delegation\n');

  await test('TC-FSC-A-001', 'Delegated enrollment succeeds (201, not 503)', async () => {
    if (!facePath) skip('No face fixture available');
    const g = await createGallery('TC-FSC-A-001', 'general');
    const { status, body } = await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'Test Person');
    assertEq(status, 201, 'HTTP status');
    assert(body.data.embedding === undefined, 'embedding never exposed');
  });

  await test('TC-FSC-A-002', '/api/analysis/face-embed direct contract', async () => {
    if (!facePath) skip('No face fixture available');
    if (!(await analysisReachable())) skip('No live analysis server configured');
    const { status, body } = await postRawJpeg('/api/analysis/face-embed', facePath);
    assertEq(status, 200, 'HTTP status');
    assert(body.success === true, 'success flag');
    assertEq(body.embedding.length, 512, 'embedding length');
    assert(body.thumbnail.startsWith('data:image/jpeg;base64,'), 'thumbnail data URI');
  });

  await test('TC-FSC-A-003', '/face-embed no-face error parity (422)', async () => {
    if (!fs.existsSync(noFacePath)) skip('No no_face.jpg fixture available');
    if (!(await analysisReachable())) skip('No live analysis server configured');
    const { status, body } = await postRawJpeg('/api/analysis/face-embed', noFacePath);
    assertEq(status, 422, 'HTTP status');
    assert(/No face detected/.test(body.error), 'error message');
  });
}

// ── Group B — Condition Mirror Push/Poll ───────────────────────────────────────

async function pollForFace(faceId, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await get('/api/analysis/face-search-conditions', ANALYSIS_URL);
    if (body.faces && body.faces.some(f => f.id === faceId)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function pollForFaceAbsent(faceId, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await get('/api/analysis/face-search-conditions', ANALYSIS_URL);
    if (!body.faces || !body.faces.some(f => f.id === faceId)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function runGroupB() {
  console.log('\n[Group B] Condition Mirror Push/Poll\n');

  await test('TC-FSC-B-001', 'Push propagation — enroll then mirrored on analysis server', async () => {
    if (!facePath) skip('No face fixture available');
    if (!(await analysisReachable())) skip('No live analysis server configured');
    const g = await createGallery('TC-FSC-B-001', 'vip');
    const enroll = await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'VIP Person');
    assertEq(enroll.status, 201, 'enroll status');
    const found = await pollForFace(enroll.body.data.id);
    assert(found, 'face mirrored on analysis server within timeout');

    await del(`/api/galleries/${g.id}`);
    const absent = await pollForFaceAbsent(enroll.body.data.id);
    assert(absent, 'face removed from mirror after gallery delete');
  });

  await test('TC-FSC-B-002', 'No embedding field over the wire', async () => {
    if (!facePath) skip('No face fixture available');
    if (!(await analysisReachable())) skip('No live analysis server configured');
    const g = await createGallery('TC-FSC-B-002', 'general');
    const enroll = await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'No Embed Test');
    await pollForFace(enroll.body.data.id);
    const { body } = await get('/api/analysis/face-search-conditions', ANALYSIS_URL);
    for (const f of body.faces) assert(f.embedding === undefined, 'embedding excluded from mirror');
  });

  await test('TC-FSC-B-003', 'Poll self-heal (restart-safety net)', async () => {
    skip('Requires direct analysis-server DB access from the test process — verified manually per TC_Face_Search_Condition_Sync.md Group B');
  });

  await test('TC-FSC-B-004', 'Local rows on analysis server never deleted by reconcile', async () => {
    if (!(await analysisReachable())) skip('No live analysis server configured');
    const g = await createGallery('TC-FSC-B-004', 'blocklist', ANALYSIS_URL);
    // Trigger a reconcile from the streaming side via any mutation
    const trigger = await createGallery('TC-FSC-B-004-trigger', 'general');
    await del(`/api/galleries/${trigger.id}`);
    await new Promise(r => setTimeout(r, 1000));
    const { body } = await get('/api/galleries', ANALYSIS_URL);
    assert(body.data.some(x => x.id === g.id), 'locally-added analysis-server gallery survives reconcile');
  });
}

// ── Group C — Dashboard Metrics ────────────────────────────────────────────────

async function runGroupC() {
  console.log('\n[Group C] Dashboard Metrics\n');

  await test('TC-FSC-C-001', 'faceSearch field present in /api/analysis/metrics', async () => {
    if (!(await analysisReachable())) skip('No live analysis server configured');
    const { body } = await get('/api/analysis/metrics', ANALYSIS_URL);
    assert(body.faceSearch, 'faceSearch field present');
    assert(typeof body.faceSearch.total === 'number', 'total is a number');
    for (const k of ['missing', 'vip', 'blocklist', 'general']) {
      assert(typeof body.faceSearch.byType[k] === 'number', `byType.${k} is a number`);
    }
  });

  await test('TC-FSC-C-002', 'Count matches detail list total', async () => {
    if (!(await analysisReachable())) skip('No live analysis server configured');
    const conditions = await get('/api/analysis/face-search-conditions', ANALYSIS_URL);
    const metrics    = await get('/api/analysis/metrics', ANALYSIS_URL);
    assertEq(conditions.body.total, metrics.body.faceSearch.total, 'totals match');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Face Search Condition Sync Tests ===\n');

  console.log('[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not reachable: ${health.status}`);
  console.log('  ✓ Server running\n');

  try {
    await runGroupA();
    await runGroupB();
    await runGroupC();
  } finally {
    await cleanupAll();
  }

  console.log('\n=== Results ===');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${passed + failed + skipped}`);

  if (failed > 0) {
    results.filter(r => r.status === 'FAIL').forEach(r =>
      console.error(`  ✗ ${r.id}: ${r.description}\n      ${r.error}`)
    );
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
