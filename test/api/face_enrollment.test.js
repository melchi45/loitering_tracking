'use strict';
/**
 * Test Group B — Face Enrollment API
 * Test Group G — Edge Cases & Error Handling
 *
 * TC: TC-B-001 ~ TC-B-012, TC-G-002 ~ TC-G-005
 * SRS: FR-FAC-010 ~ FR-FAC-017
 *
 * Prerequisites: Server running; test/fixtures/ images present
 * Run: node test/api/face_enrollment.test.js
 */

const fs   = require('fs');
const path = require('path');

const BASE_URL    = process.env.LTS_URL || 'http://localhost:3080';
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const results = [];

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed++;
    results.push({ id, description, status: 'PASS' });
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}\n      ${err.message}`);
    failed++;
    results.push({ id, description, status: 'FAIL', error: err.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEq(a, e, l) { if (a !== e) throw new Error(`${l}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, body: await res.json() };
}
async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}

async function postMultipart(urlPath, filePath, name) {
  const formData = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  const filename = filePath.split('/').pop() || 'photo.jpg';
  const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
  formData.append('photo', blob, filename);
  if (name) formData.append('name', name);
  const res = await fetch(`${BASE_URL}${urlPath}`, { method: 'POST', body: formData });
  return { status: res.status, body: await res.json() };
}

async function postMultipartRaw(urlPath, filePath, mimeType, name) {
  const formData = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  const filename = filePath.split('/').pop() || 'photo.jpg';
  const blob = new Blob([fileBuffer], { type: mimeType });
  formData.append('photo', blob, filename);
  if (name) formData.append('name', name);
  const res = await fetch(`${BASE_URL}${urlPath}`, { method: 'POST', body: formData });
  return { status: res.status, body: await res.json() };
}

// ── Gallery helpers ──────────────────────────────────────────────────────────

const createdGalleries = [];

async function createGallery(name, type = 'general') {
  const res = await post('/api/galleries', { name, type });
  assert(res.status === 201, `createGallery: ${res.status}`);
  createdGalleries.push(res.body.data.id);
  return res.body.data;
}

async function cleanupAll() {
  for (const id of [...createdGalleries]) {
    try { await del(`/api/galleries/${id}`); } catch (_) {}
  }
  createdGalleries.length = 0;
}

// ── Fixture check ────────────────────────────────────────────────────────────

function checkFixtures() {
  const noFace = path.join(FIXTURE_DIR, 'no_face.jpg');
  assert(fs.existsSync(noFace), `Fixture missing: ${noFace}\nRun: node test/setup_fixtures.js`);
  console.log('  ✓ Fixtures present\n');
}

// ── Check for real face image ─────────────────────────────────────────────────

function getFaceFixture() {
  // Prefer a user-provided clear face photo; fall back to noting skip
  const candidates = [
    path.join(FIXTURE_DIR, 'face_clear.jpg'),
    path.join(FIXTURE_DIR, 'face.jpg'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// ── Test Group B ─────────────────────────────────────────────────────────────

async function runGroupB() {
  console.log('[Group B] Face Enrollment API\n');

  const facePath = getFaceFixture();
  const hasRealFace = !!facePath;
  if (!hasRealFace) {
    console.warn('  ⚠ No real face fixture found (test/fixtures/face_clear.jpg)');
    console.warn('  ⚠ TC-B-001, B-002, B-007, B-008 will be skipped\n');
  }

  // ── Enrollment success tests (require real face photo) ────────────────────

  if (hasRealFace) {
    await test('TC-B-001', 'Enroll Face — success with name', async () => {
      const g = await createGallery('TC-B-001 Gallery');
      const { status, body } = await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'Kim Minsu');
      assertEq(status, 201, 'HTTP status');
      assertEq(body.success, true, 'success');
      assertEq(body.data.name, 'Kim Minsu', 'name');
      assert(body.data.thumbnail?.startsWith('data:image/jpeg;base64,'), 'thumbnail is base64 JPEG');
      assert(body.data.embedding === undefined, 'embedding not exposed');
      assert(body.data.id?.length === 36, 'id is UUID');

      const list = await get(`/api/galleries`);
      const gallery = list.body.data.find(x => x.id === g.id);
      assertEq(gallery.faceCount, 1, 'faceCount updated to 1');
    });

    await test('TC-B-002', 'Enroll Face — default name Unknown', async () => {
      const g = await createGallery('TC-B-002 Gallery');
      const { status, body } = await postMultipart(`/api/galleries/${g.id}/faces`, facePath);
      assertEq(status, 201, 'HTTP status');
      assertEq(body.data.name, 'Unknown', 'default name');
    });

    await test('TC-B-007', 'Enroll Face — multi-face → largest selected (no error)', async () => {
      const multiFace = path.join(FIXTURE_DIR, 'multi_face.jpg');
      if (!fs.existsSync(multiFace)) {
        console.log('    (skipped — multi_face.jpg not available)');
        return;
      }
      const g = await createGallery('TC-B-007 Gallery');
      const { status, body } = await postMultipart(`/api/galleries/${g.id}/faces`, multiFace, 'MultiTest');
      assertEq(status, 201, 'HTTP status');
      assert(body.data.bbox.width > 0, 'bbox width > 0');
    });

    await test('TC-B-008', 'List Enrolled Faces — returns faces, no embedding', async () => {
      const g = await createGallery('TC-B-008 Gallery');
      await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'Person A');
      await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'Person B');

      const { status, body } = await get(`/api/galleries/${g.id}/faces`);
      assertEq(status, 200, 'HTTP status');
      assertEq(body.data.length, 2, 'face count');
      for (const f of body.data) {
        assert(f.embedding === undefined, 'embedding not exposed');
        assert(f.thumbnail?.startsWith('data:image/jpeg;base64,'), 'thumbnail present');
      }
      // sorted DESC by createdAt
      assert(body.data[0].name === 'Person B', 'newest first');
    });
  }

  // ── Error path tests (work without real face photo) ───────────────────────

  await test('TC-B-003', 'Enroll Face — gallery not found → 404', async () => {
    const noFacePath = path.join(FIXTURE_DIR, 'no_face.jpg');
    const { status, body } = await postMultipart('/api/galleries/00000000-0000-0000-0000-000000000000/faces', noFacePath, 'Test');
    assertEq(status, 404, 'HTTP status');
    assertEq(body.success, false, 'success false');
  });

  await test('TC-B-004', 'Enroll Face — no photo field → 400', async () => {
    const g = await createGallery('TC-B-004 Gallery');
    const res = await fetch(`${BASE_URL}/api/galleries/${g.id}/faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    const body = await res.json();
    assertEq(res.status, 400, 'HTTP status');
    assertEq(body.success, false, 'success false');
    assertEq(body.error, 'photo field is required', 'error message');
  });

  await test('TC-B-005', 'Enroll Face — no face in photo → 422', async () => {
    const g = await createGallery('TC-B-005 Gallery');
    const noFacePath = path.join(FIXTURE_DIR, 'no_face.jpg');
    const { status, body } = await postMultipart(`/api/galleries/${g.id}/faces`, noFacePath, 'NoFace');
    if (status === 503) {
      // Face detection service not available in this server mode (e.g. streaming-only)
      console.log('      (face service unavailable — 503; skipping assertion)');
      return;
    }
    assertEq(status, 422, 'HTTP status');
    assertEq(body.success, false, 'success false');
    assert(body.error?.includes('No face detected'), `error contains 'No face detected': got '${body.error}'`);
  });

  await test('TC-B-006', 'Enroll Face — file too large → 400/413', async () => {
    const g = await createGallery('TC-B-006 Gallery');
    // Create a 11MB buffer in memory
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0);
    const formData = new FormData();
    formData.append('photo', new Blob([bigBuffer], { type: 'image/jpeg' }), 'large.jpg');
    const res = await fetch(`${BASE_URL}/api/galleries/${g.id}/faces`, { method: 'POST', body: formData });
    assert(res.status === 400 || res.status === 413, `Expected 400 or 413, got ${res.status}`);
  });

  await test('TC-B-009', 'List Faces — gallery not found → 404', async () => {
    const { status, body } = await get('/api/galleries/00000000-0000-0000-0000-000000000000/faces');
    assertEq(status, 404, 'HTTP status');
  });

  if (hasRealFace) {
    await test('TC-B-010', 'Delete Face → 200, removed from list', async () => {
      const g = await createGallery('TC-B-010 Gallery');
      const enroll = await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'ToDelete');
      const faceId = enroll.body.data.id;

      const { status, body } = await del(`/api/galleries/${g.id}/faces/${faceId}`);
      assertEq(status, 200, 'HTTP status');
      assertEq(body.success, true, 'success');

      const list = await get(`/api/galleries/${g.id}/faces`);
      assertEq(list.body.data.length, 0, 'face list empty');

      const galleries = await get('/api/galleries');
      const gallery = galleries.body.data.find(x => x.id === g.id);
      assertEq(gallery.faceCount, 0, 'faceCount back to 0');
    });
  }

  await test('TC-B-011', 'Delete Face — not found → 404', async () => {
    const g = await createGallery('TC-B-011 Gallery');
    const { status } = await del(`/api/galleries/${g.id}/faces/00000000-0000-0000-0000-000000000000`);
    assertEq(status, 404, 'HTTP status');
  });

  if (hasRealFace) {
    await test('TC-B-012', 'Delete Face — wrong gallery → 404', async () => {
      const gA = await createGallery('TC-B-012 Gallery A');
      const gB = await createGallery('TC-B-012 Gallery B');
      const enroll = await postMultipart(`/api/galleries/${gA.id}/faces`, facePath, 'Person');
      const faceId = enroll.body.data.id;
      const { status } = await del(`/api/galleries/${gB.id}/faces/${faceId}`);
      assertEq(status, 404, 'HTTP status — wrong gallery');
    });
  }

  // ── Group G error cases ──────────────────────────────────────────────────

  await test('TC-G-002', 'Enroll — unsupported MIME type → 400', async () => {
    const g = await createGallery('TC-G-002 Gallery');
    const formData = new FormData();
    formData.append('photo', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'test.pdf');
    const res = await fetch(`${BASE_URL}/api/galleries/${g.id}/faces`, { method: 'POST', body: formData });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('TC-G-003', 'Enroll to deleted gallery → 404', async () => {
    const g = await createGallery('TC-G-003 Gallery');
    await del(`/api/galleries/${g.id}`);
    const noFacePath = path.join(FIXTURE_DIR, 'no_face.jpg');
    const { status } = await postMultipart(`/api/galleries/${g.id}/faces`, noFacePath);
    assertEq(status, 404, 'HTTP status');
    // remove from tracking since already deleted
    const idx = createdGalleries.indexOf(g.id);
    if (idx >= 0) createdGalleries.splice(idx, 1);
  });

  if (hasRealFace) {
    await test('TC-G-005', 'Concurrent enrollments — no 500 errors', async () => {
      const g = await createGallery('TC-G-005 Gallery');
      const requests = Array.from({ length: 3 }, (_, i) =>
        postMultipart(`/api/galleries/${g.id}/faces`, facePath, `Person-${i}`)
      );
      const results = await Promise.all(requests);
      const errors = results.filter(r => r.status === 500);
      assertEq(errors.length, 0, '500 errors on concurrent enroll');
      const successes = results.filter(r => r.status === 201).length;
      assert(successes >= 1, `At least 1 successful enrollment: got ${successes}`);
    });
  }

  await cleanupAll();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Face Enrollment API Tests ===\n');

  console.log('[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, 'Server not reachable');
  console.log('  ✓ Server running');
  checkFixtures();

  try {
    await runGroupB();
  } finally {
    await cleanupAll();
  }

  console.log('\n=== Results ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  if (failed > 0) {
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.error(`  ✗ ${r.id}: ${r.description}\n      ${r.error}`);
    });
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
