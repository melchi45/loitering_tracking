'use strict';
/**
 * Test Group C — Missing Persons Detection
 *
 * TC: TC-C-001 ~ TC-C-006
 * SRS: FR-FAC-030 ~ FR-FAC-033
 *
 * Note: TC-C-003, TC-C-004, TC-C-005 require Socket.IO connection and a camera
 * pipeline actively processing frames. They are marked as integration tests.
 * Without a running camera, only TC-C-001 and TC-C-002 run in pure API mode.
 *
 * Run: node test/api/missing_persons.test.js
 */

const fs   = require('fs');
const path = require('path');

const BASE_URL    = process.env.LTS_URL || 'http://localhost:3001';
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');
const SOCKET_IO_TIMEOUT = parseInt(process.env.SOCKET_TIMEOUT || '5000');

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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(p) {
  const res = await fetch(`${BASE_URL}${p}`);
  return { status: res.status, body: await res.json() };
}
async function post(p, body) {
  const res = await fetch(`${BASE_URL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function del(p) {
  const res = await fetch(`${BASE_URL}${p}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}
async function postMultipart(urlPath, filePath, name) {
  const formData = new FormData();
  const blob = new Blob([fs.readFileSync(filePath)], { type: 'image/jpeg' });
  formData.append('photo', blob, path.basename(filePath));
  if (name) formData.append('name', name);
  const res = await fetch(`${BASE_URL}${urlPath}`, { method: 'POST', body: formData });
  return { status: res.status, body: await res.json() };
}

const createdGalleries = [];
async function createGallery(name, type = 'general') {
  const r = await post('/api/galleries', { name, type });
  assert(r.status === 201, `createGallery: ${r.status}`);
  createdGalleries.push(r.body.data.id);
  return r.body.data;
}
async function cleanupAll() {
  for (const id of [...createdGalleries]) {
    try { await del(`/api/galleries/${id}`); } catch (_) {}
  }
  createdGalleries.length = 0;
}

// ── Socket.IO helper (dynamic import since socket.io-client may not be installed) ─

async function waitForSocketEvent(eventName, timeoutMs = SOCKET_IO_TIMEOUT) {
  let io;
  try {
    const { io: socketIO } = await import('socket.io-client');
    io = socketIO;
  } catch (_) {
    throw new Error('SKIP');
  }

  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, { transports: ['websocket'] });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Timeout: '${eventName}' not received within ${timeoutMs} ms`));
    }, timeoutMs);

    socket.on(eventName, (data) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(data);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(err);
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runGroupC() {
  console.log('[Group C] Missing Persons Detection\n');

  // ── TC-C-001: Create missing gallery, verify type ─────────────────────────

  await test('TC-C-001', 'Create missing gallery — type stored correctly', async () => {
    const g = await createGallery('TC-C-001 Missing', 'missing');
    const { body } = await get('/api/galleries');
    const found = body.data.find(x => x.id === g.id);
    assert(found, 'gallery found in list');
    assertEq(found.type, 'missing', 'gallery type is missing');
  });

  // ── TC-C-002: Enroll face in missing gallery ──────────────────────────────

  const facePath = (() => {
    const candidates = [
      path.join(FIXTURE_DIR, 'face_clear.jpg'),
      path.join(FIXTURE_DIR, 'face.jpg'),
    ];
    return candidates.find(c => fs.existsSync(c)) || null;
  })();

  await test('TC-C-002', 'Enroll face in missing gallery', async () => {
    if (!facePath) skip('No face fixture available');
    const g = await createGallery('TC-C-002 Missing', 'missing');
    const { status, body } = await postMultipart(`/api/galleries/${g.id}/faces`, facePath, 'Missing Person');
    assertEq(status, 201, 'HTTP status');
    const list = await get(`/api/galleries/${g.id}/faces`);
    assertEq(list.body.data.length, 1, 'enrolled face present');
  });

  // ── TC-C-003: missing_person_match event (requires camera + Socket.IO) ────

  await test('TC-C-003', 'missing_person_match event emitted on match (integration)', async () => {
    skip('Requires active camera pipeline — run as integration test with live camera');
  });

  await test('TC-C-004', 'Both face_match and missing_person_match emitted (integration)', async () => {
    skip('Requires active camera pipeline — run as integration test with live camera');
  });

  // ── TC-C-005: vip gallery — no missing_person_match ──────────────────────

  await test('TC-C-005', 'VIP gallery — face_match only, no missing_person_match (integration)', async () => {
    skip('Requires active camera pipeline — run as integration test with live camera');
  });

  // ── TC-C-006: galleryType correct per event (API-level schema verification) ─

  await test('TC-C-006', 'Gallery API returns correct type per gallery', async () => {
    await cleanupAll();
    const types = ['general', 'vip', 'blocklist', 'missing'];
    const galleries = {};
    for (const t of types) {
      const g = await createGallery(`TC-C-006 ${t}`, t);
      galleries[t] = g;
    }
    const { body } = await get('/api/galleries');
    for (const t of types) {
      const found = body.data.find(x => x.id === galleries[t].id);
      assert(found, `gallery ${t} found`);
      assertEq(found.type, t, `gallery type matches for ${t}`);
    }
  });

  await cleanupAll();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Missing Persons Detection Tests ===\n');

  console.log('[Prerequisites]');
  const health = await get('/health');
  assert(health.status === 200, `Server not reachable: ${health.status}`);
  console.log('  ✓ Server running\n');

  try {
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
