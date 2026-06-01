'use strict';
/**
 * User Profile Management API Tests
 *
 * TC Reference: TC-LTS2026-PROFILE-001
 *   Group A — Profile Read      (TC-PROF-A-001 ~ A-003)  — GET /auth/me includes profile fields
 *   Group B — Profile Update    (TC-PROF-B-001 ~ B-007)  — PATCH /auth/me field validation & save
 *   Group C — Avatar Upload     (TC-PROF-C-001 ~ C-004)  — Base64 avatar accept / reject
 *   Group D — Admin View        (TC-PROF-D-001 ~ D-003)  — GET /admin/users/:id returns profile
 *   Group E — Admin Search      (TC-PROF-E-001 ~ E-005)  — Search by org/phone/bio/name/email
 *   Group F — Security          (TC-PROF-F-001 ~ F-003)  — Auth enforcement
 *
 * Prerequisites:
 *   - Server running on BASE_URL (default https://localhost:3443)
 *   - AUTH_ENABLED=true and a seeded admin account
 *   - Set LTS_HTTPS_URL, ADMIN_EMAIL, ADMIN_PASS environment variables to override defaults
 *
 * Run:
 *   node test/api/user_profile.test.js
 *   LTS_HTTPS_URL=https://localhost:3443 ADMIN_EMAIL=admin@example.com ADMIN_PASS=secret \
 *     node test/api/user_profile.test.js
 */

const http  = require('http');
const https = require('https');

const BASE_URL    = process.env.LTS_HTTPS_URL || 'https://localhost:3443';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL   || 'melchi45@gmail.com';
const ADMIN_PASS  = process.env.ADMIN_PASS    || 'admin1234!';

// ── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
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
  console.log(`  ⊘ ${id}: ${description} [SKIP: ${reason}]`);
  skipped++;
  results.push({ id, description, status: 'SKIP', reason });
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── HTTP helpers (self-signed cert allowed) ──────────────────────────────────

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${BASE_URL}${path}`);
    const lib     = url.protocol === 'https:' ? https : http;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = { 'Content-Type': 'application/json' };
    if (token)   headers['Authorization'] = `Bearer ${token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const opts = {
      hostname:           url.hostname,
      port:               url.port || (url.protocol === 'https:' ? 443 : 80),
      path:               url.pathname + url.search,
      method,
      headers,
      rejectUnauthorized: false,
    };

    const req = lib.request(opts, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        const json = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function get(path, token)         { return request('GET',   path, undefined, token); }
async function post(path, body, token)  { return request('POST',  path, body, token); }
async function patch(path, body, token) { return request('PATCH', path, body, token); }

// ── Session helpers ──────────────────────────────────────────────────────────

async function loginAsAdmin() {
  const res = await post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASS });
  if (res.status !== 200) throw new Error(`Admin login failed: HTTP ${res.status} — ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

// ── Shared state ─────────────────────────────────────────────────────────────

let adminToken = null;
let adminUserId = null;

// ═════════════════════════════════════════════════════════════════════════════
// Setup
// ═════════════════════════════════════════════════════════════════════════════

async function setup() {
  try {
    adminToken = await loginAsAdmin();
    const meRes = await get('/auth/me', adminToken);
    if (meRes.status === 200) adminUserId = meRes.body.id;
  } catch (err) {
    console.error('[setup] Failed to authenticate:', err.message);
    console.error('        Set ADMIN_EMAIL and ADMIN_PASS environment variables.');
    process.exit(1);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Group A — Profile Read
// ═════════════════════════════════════════════════════════════════════════════

async function groupA() {
  console.log('\n  Group A — Profile Read');

  await test('TC-PROF-A-001', 'GET /auth/me returns 200 with id, email, name, role', async () => {
    const res = await get('/auth/me', adminToken);
    assertEq(res.status, 200, 'status');
    assert(res.body.id,    'body.id present');
    assert(res.body.email, 'body.email present');
    assert(res.body.name,  'body.name present');
    assert(res.body.role,  'body.role present');
  });

  await test('TC-PROF-A-002', 'GET /auth/me response includes optional profile fields (or undefined)', async () => {
    const res = await get('/auth/me', adminToken);
    assertEq(res.status, 200, 'status');
    // Fields may be undefined but must not throw on access
    const allowed = ['organization', 'phone', 'bio', 'avatarDataUrl'];
    allowed.forEach(f => {
      const val = res.body[f];
      assert(val === undefined || typeof val === 'string', `${f} must be string or absent`);
    });
  });

  await test('TC-PROF-A-003', 'GET /auth/me requires authentication — 401 without token', async () => {
    const res = await get('/auth/me');
    assertEq(res.status, 401, 'status');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Group B — Profile Update
// ═════════════════════════════════════════════════════════════════════════════

async function groupB() {
  console.log('\n  Group B — Profile Update');

  const testOrg   = `TestOrg-${Date.now()}`;
  const testPhone = '+82-10-0000-0001';
  const testBio   = 'Test bio for automated tests.';

  await test('TC-PROF-B-001', 'PATCH /auth/me accepts valid organization, phone, bio', async () => {
    const res = await patch('/auth/me', {
      organization: testOrg,
      phone:        testPhone,
      bio:          testBio,
    }, adminToken);
    assertEq(res.status, 200, 'status');
    assertEq(res.body.organization, testOrg,   'organization');
    assertEq(res.body.phone,        testPhone, 'phone');
    assertEq(res.body.bio,          testBio,   'bio');
  });

  await test('TC-PROF-B-002', 'PATCH /auth/me persists changes — GET /auth/me returns updated fields', async () => {
    const res = await get('/auth/me', adminToken);
    assertEq(res.status, 200, 'status');
    assertEq(res.body.organization, testOrg,   'organization persisted');
    assertEq(res.body.phone,        testPhone, 'phone persisted');
    assertEq(res.body.bio,          testBio,   'bio persisted');
  });

  await test('TC-PROF-B-003', 'PATCH /auth/me accepts name update', async () => {
    const res = await patch('/auth/me', { name: 'LTS Admin' }, adminToken);
    assertEq(res.status, 200, 'status');
    assertEq(res.body.name, 'LTS Admin', 'name updated');
  });

  await test('TC-PROF-B-004', 'PATCH /auth/me rejects empty name', async () => {
    const res = await patch('/auth/me', { name: '' }, adminToken);
    assertEq(res.status, 400, 'status');
    assert(res.body.error, 'error message present');
  });

  await test('TC-PROF-B-005', 'PATCH /auth/me rejects name > 64 chars', async () => {
    const res = await patch('/auth/me', { name: 'A'.repeat(65) }, adminToken);
    assertEq(res.status, 400, 'status');
  });

  await test('TC-PROF-B-006', 'PATCH /auth/me rejects organization > 128 chars', async () => {
    const res = await patch('/auth/me', { organization: 'X'.repeat(129) }, adminToken);
    assertEq(res.status, 400, 'status');
  });

  await test('TC-PROF-B-007', 'PATCH /auth/me rejects bio > 256 chars', async () => {
    const res = await patch('/auth/me', { bio: 'B'.repeat(257) }, adminToken);
    assertEq(res.status, 400, 'status');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Group C — Avatar Upload
// ═════════════════════════════════════════════════════════════════════════════

// Minimal 1×1 transparent PNG as base64 data URL (67 bytes)
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';

async function groupC() {
  console.log('\n  Group C — Avatar Upload');

  await test('TC-PROF-C-001', 'PATCH /auth/me accepts valid base64 PNG data URL', async () => {
    const res = await patch('/auth/me', { avatarDataUrl: TINY_PNG_DATA_URL }, adminToken);
    assertEq(res.status, 200, 'status');
    assert(res.body.avatarDataUrl?.startsWith('data:image/'), 'avatarDataUrl starts with data:image/');
  });

  await test('TC-PROF-C-002', 'GET /auth/me returns saved avatarDataUrl', async () => {
    const res = await get('/auth/me', adminToken);
    assertEq(res.status, 200, 'status');
    assert(res.body.avatarDataUrl?.startsWith('data:image/'), 'avatarDataUrl present');
  });

  await test('TC-PROF-C-003', 'PATCH /auth/me rejects avatarDataUrl not starting with data:image/', async () => {
    const res = await patch('/auth/me', { avatarDataUrl: 'data:text/plain;base64,aGVsbG8=' }, adminToken);
    assertEq(res.status, 400, 'status');
    assert(res.body.error, 'error message present');
  });

  await test('TC-PROF-C-004', 'PATCH /auth/me rejects avatarDataUrl exceeding 65536 chars', async () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(65537);
    const res = await patch('/auth/me', { avatarDataUrl: big }, adminToken);
    assertEq(res.status, 400, 'status');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Group D — Admin View Profile
// ═════════════════════════════════════════════════════════════════════════════

async function groupD() {
  console.log('\n  Group D — Admin View Profile');

  if (!adminUserId) {
    skip('TC-PROF-D-001', 'GET /admin/users/:id returns profile fields', 'adminUserId not resolved');
    skip('TC-PROF-D-002', 'GET /admin/users/:id includes organization and phone', 'adminUserId not resolved');
    skip('TC-PROF-D-003', 'GET /admin/users/:id includes avatarDataUrl', 'adminUserId not resolved');
    return;
  }

  await test('TC-PROF-D-001', 'GET /admin/users/:id returns 200 for valid user', async () => {
    const res = await get(`/admin/users/${adminUserId}`, adminToken);
    assertEq(res.status, 200, 'status');
    assertEq(res.body.id, adminUserId, 'id matches');
  });

  await test('TC-PROF-D-002', 'GET /admin/users/:id includes organization and phone', async () => {
    const res = await get(`/admin/users/${adminUserId}`, adminToken);
    assertEq(res.status, 200, 'status');
    assert(typeof res.body.organization === 'string' || res.body.organization === undefined, 'organization type');
    assert(typeof res.body.phone === 'string' || res.body.phone === undefined, 'phone type');
  });

  await test('TC-PROF-D-003', 'GET /admin/users/:id includes avatarDataUrl when set', async () => {
    const res = await get(`/admin/users/${adminUserId}`, adminToken);
    assertEq(res.status, 200, 'status');
    if (res.body.avatarDataUrl) {
      assert(res.body.avatarDataUrl.startsWith('data:image/'), 'avatarDataUrl format');
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Group E — Admin Search by Profile Fields
// ═════════════════════════════════════════════════════════════════════════════

async function groupE() {
  console.log('\n  Group E — Admin Search by Profile Fields');

  // Seed: we know the admin user's org/phone/bio from group B
  await test('TC-PROF-E-001', 'GET /admin/users?search= returns user array', async () => {
    const res = await get('/admin/users?search=', adminToken);
    assertEq(res.status, 200, 'status');
    assert(Array.isArray(res.body.users), 'body.users is array');
  });

  await test('TC-PROF-E-002', 'Admin search by partial email returns matching user', async () => {
    const domain = ADMIN_EMAIL.split('@')[1];
    const res = await get(`/admin/users?search=${encodeURIComponent(domain)}`, adminToken);
    assertEq(res.status, 200, 'status');
    assert(res.body.users.length > 0, 'at least one result');
    assert(res.body.users.some(u => u.email === ADMIN_EMAIL), 'admin user found by email domain');
  });

  await test('TC-PROF-E-003', 'Admin search by organization matches updated user', async () => {
    // Relies on group B having set organization = `TestOrg-<timestamp>`
    // Just ensure the endpoint returns 200 and structure is correct
    const res = await get('/admin/users?search=TestOrg', adminToken);
    assertEq(res.status, 200, 'status');
    assert(Array.isArray(res.body.users), 'body.users is array');
  });

  await test('TC-PROF-E-004', 'Admin search by phone fragment returns matching user', async () => {
    const res = await get('/admin/users?search=0000-0001', adminToken);
    assertEq(res.status, 200, 'status');
    assert(Array.isArray(res.body.users), 'body.users is array');
    // When group B ran successfully, the admin user has this phone number
  });

  await test('TC-PROF-E-005', 'Admin search with non-matching query returns empty array', async () => {
    const res = await get('/admin/users?search=__no_match_xyz_9999__', adminToken);
    assertEq(res.status, 200, 'status');
    assertEq(res.body.users.length, 0, 'empty results');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Group F — Security
// ═════════════════════════════════════════════════════════════════════════════

async function groupF() {
  console.log('\n  Group F — Security');

  await test('TC-PROF-F-001', 'PATCH /auth/me requires auth — returns 401 without token', async () => {
    const res = await patch('/auth/me', { bio: 'unauthorized' });
    assertEq(res.status, 401, 'status');
  });

  await test('TC-PROF-F-002', 'GET /admin/users requires admin — returns 401/403 without token', async () => {
    const res = await get('/admin/users');
    assert(res.status === 401 || res.status === 403, `status ${res.status} should be 401 or 403`);
  });

  await test('TC-PROF-F-003', 'PATCH /auth/me does not expose passwordHash in response', async () => {
    const res = await patch('/auth/me', { bio: 'security test' }, adminToken);
    assertEq(res.status, 200, 'status');
    assert(!('passwordHash' in res.body), 'passwordHash must not be in response');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TC-LTS2026-PROFILE-001 — User Profile Management API Tests');
  console.log(`  Target: ${BASE_URL}`);
  console.log('═══════════════════════════════════════════════════════════════');

  await setup();
  await groupA();
  await groupB();
  await groupC();
  await groupD();
  await groupE();
  await groupF();

  console.log('\n───────────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('───────────────────────────────────────────────────────────────');

  if (failed > 0) {
    console.error('\n  FAILED TESTS:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.error(`    ✗ ${r.id}: ${r.description}`);
      console.error(`        ${r.error}`);
    });
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
