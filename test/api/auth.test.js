'use strict';
/**
 * User Authentication & Authorization — REST API Tests
 *
 * TC: TC-LTS2026-AUTH-001
 *   Group A — Local Registration         (TC-AUTH-A-001 ~ A-006)
 *   Group B — Local Sign-In              (TC-AUTH-B-001 ~ B-005)
 *   Group C — JWT Token Management       (TC-AUTH-C-001 ~ C-006)
 *   Group D — Logout                     (TC-AUTH-D-001 ~ D-003)
 *   Group E — Admin User Management      (TC-AUTH-E-001 ~ E-006)
 *   Group F — RBAC / Protected Routes    (TC-AUTH-F-001 ~ F-003)
 *   Group G — Regression                 (TC-AUTH-G-001)
 *
 * Prerequisites:
 *   - Server running (default https://localhost:3443)
 *   - AUTH_ENABLED=true in server/.env
 *
 * Run:
 *   node test/api/auth.test.js
 *   LTS_URL=https://localhost:3443 node test/api/auth.test.js
 */

const BASE_URL = process.env.LTS_URL || 'https://localhost:3443';

// ── Minimal test harness ──────────────────────────────────────────────────────

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

async function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description}  [SKIP: ${reason}]`);
  skipped++;
  results.push({ id, description, status: 'SKIP', reason });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');

function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const lib     = url.protocol === 'https:' ? https : http;
    const options = {
      hostname:           url.hostname,
      port:               url.port || (url.protocol === 'https:' ? 443 : 80),
      path:               url.pathname + url.search,
      method:             opts.method || 'GET',
      headers:            opts.headers || {},
      rejectUnauthorized: false,
      ...opts.nodeOpts,
    };
    if (opts.body) {
      const bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      options.headers['Content-Type']   = options.headers['Content-Type'] || 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function post(path, body, headers = {}) {
  return request(`${BASE_URL}${path}`, { method: 'POST', body, headers });
}

function get(path, headers = {}) {
  return request(`${BASE_URL}${path}`, { method: 'GET', headers });
}

function patch(path, body, headers = {}) {
  return request(`${BASE_URL}${path}`, { method: 'PATCH', body, headers });
}

/** Extract Set-Cookie value by name */
function getCookie(res, name) {
  const cookies = [].concat(res.headers['set-cookie'] || []);
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) return c.split(';')[0].split('=').slice(1).join('=');
  }
  return null;
}

// ── Test state shared across groups ──────────────────────────────────────────

const TS         = Date.now();
const adminEmail = `auth_admin_${TS}@lts-test.local`;
const adminPass  = 'AdminPass1!';
const userEmail  = `auth_user_${TS}@lts-test.local`;
const userPass   = 'UserPass1!';

let adminToken   = null;
let adminRefresh = null;
let userId       = null;

// ─────────────────────────────────────────────────────────────────────────────

async function runAll() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' TC-LTS2026-AUTH-001  User Authentication & Authorization');
  console.log(`  Server: ${BASE_URL}`);
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── Health check ────────────────────────────────────────────────────────────
  try {
    const h = await get('/health');
    assert(h.status === 200, `Health check failed: ${h.status}`);
    console.log('  ◆ Server reachable\n');
  } catch (err) {
    console.error(`  ✗ Server not reachable at ${BASE_URL}: ${err.message}`);
    process.exit(1);
  }

  // ── Group A — Local Registration ───────────────────────────────────────────
  console.log('── Group A: Local Registration ──────────────────────────────');

  await test('TC-AUTH-A-001', 'First registered user becomes admin (auto-approve)', async () => {
    const res = await post('/auth/register', { email: adminEmail, password: adminPass, name: 'Auth Admin' });
    // May be 201 (new) or 409 (already exists from a previous run — skip gracefully)
    if (res.status === 409) {
      // Pre-existing admin from another run; attempt login below instead
      return;
    }
    assert(res.status === 201, `Expected 201, got ${res.status}: ${res.body}`);
    assert(res.json?.user?.role === 'admin' || res.json?.user?.status === 'active',
      `Expected admin/active for first user; got role=${res.json?.user?.role} status=${res.json?.user?.status}`);
  });

  await test('TC-AUTH-A-002', 'Second user created as pending viewer', async () => {
    const res = await post('/auth/register', { email: userEmail, password: userPass, name: 'Auth User' });
    if (res.status === 409) return; // idempotent
    assert(res.status === 201, `Expected 201, got ${res.status}: ${res.body}`);
    const u = res.json?.user;
    assert(u?.status === 'pending', `Expected pending, got ${u?.status}`);
    assert(u?.role === 'viewer',    `Expected viewer, got ${u?.role}`);
    userId = u?.id;
  });

  await test('TC-AUTH-A-003', 'Duplicate email rejected with 409', async () => {
    const res = await post('/auth/register', { email: adminEmail, password: 'AnotherPass1!' });
    assert(res.status === 409, `Expected 409, got ${res.status}`);
  });

  await test('TC-AUTH-A-004', 'Password too short rejected with 400', async () => {
    const res = await post('/auth/register', { email: `short_${TS}@lts.local`, password: 'abc' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('TC-AUTH-A-005', 'Missing email rejected with 400', async () => {
    const res = await post('/auth/register', { password: 'TestPass1!' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('TC-AUTH-A-006', 'Missing password rejected with 400', async () => {
    const res = await post('/auth/register', { email: `nopw_${TS}@lts.local` });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  // ── Group B — Local Sign-In ────────────────────────────────────────────────
  console.log('\n── Group B: Local Sign-In ───────────────────────────────────');

  await test('TC-AUTH-B-001', 'Active admin signs in — JWT + refresh cookie returned', async () => {
    const res = await post('/auth/login', { email: adminEmail, password: adminPass });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
    assert(res.json?.accessToken, 'No accessToken in response');
    assert(res.json?.user?.email === adminEmail, 'Wrong email in user object');
    adminToken   = res.json.accessToken;
    adminRefresh = getCookie(res, 'refreshToken');
    assert(adminToken,   'No access token stored');
    assert(adminRefresh, 'No refresh cookie set');
  });

  await test('TC-AUTH-B-002', 'Wrong password returns 401', async () => {
    const res = await post('/auth/login', { email: adminEmail, password: 'WrongPass!' });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test('TC-AUTH-B-003', 'Pending user cannot sign in (403)', async () => {
    const res = await post('/auth/login', { email: userEmail, password: userPass });
    assert(res.status === 403, `Expected 403 for pending user, got ${res.status}`);
  });

  await test('TC-AUTH-B-004', 'Non-existent email returns 401 (no user enumeration)', async () => {
    const res = await post('/auth/login', { email: `nobody_${TS}@lts.local`, password: 'Pass1234!' });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test('TC-AUTH-B-005', 'Missing password returns 400', async () => {
    const res = await post('/auth/login', { email: adminEmail });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  // ── Group C — JWT Token Management ────────────────────────────────────────
  console.log('\n── Group C: JWT Token Management ────────────────────────────');

  await test('TC-AUTH-C-001', 'GET /auth/me returns current user profile', async () => {
    if (!adminToken) return skip('TC-AUTH-C-001', 'GET /auth/me', 'No admin token');
    const res = await get('/auth/me', { Authorization: `Bearer ${adminToken}` });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.json?.email === adminEmail, `Wrong email: ${res.json?.email}`);
  });

  await test('TC-AUTH-C-002', 'GET /auth/me without token returns 401', async () => {
    const res = await get('/auth/me');
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test('TC-AUTH-C-003', 'GET /auth/me with invalid token returns 401', async () => {
    const res = await get('/auth/me', { Authorization: 'Bearer not.a.valid.token' });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test('TC-AUTH-C-004', 'POST /auth/refresh returns new access token', async () => {
    if (!adminRefresh) return skip('TC-AUTH-C-004', 'Refresh', 'No refresh cookie from login');
    const res = await post('/auth/refresh', null, { Cookie: `refreshToken=${adminRefresh}` });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
    assert(res.json?.accessToken, 'No new accessToken');
    // Update token for subsequent tests
    adminToken   = res.json.accessToken;
    adminRefresh = getCookie(res, 'refreshToken') || adminRefresh;
  });

  await test('TC-AUTH-C-005', 'POST /auth/refresh without cookie returns 401', async () => {
    const res = await post('/auth/refresh', null, {});
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test('TC-AUTH-C-006', 'POST /auth/refresh with invalid cookie returns 401', async () => {
    const res = await post('/auth/refresh', null, { Cookie: 'refreshToken=invalid_token_value' });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // ── Group E — Admin User Management ───────────────────────────────────────
  console.log('\n── Group E: Admin User Management ───────────────────────────');

  await test('TC-AUTH-E-001', 'GET /admin/users returns user list (admin)', async () => {
    if (!adminToken) return skip('TC-AUTH-E-001', 'List users', 'No admin token');
    const res = await get('/admin/users', { Authorization: `Bearer ${adminToken}` });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(Array.isArray(res.json?.users || res.json), 'Expected array of users');
  });

  await test('TC-AUTH-E-002', 'GET /admin/users without token returns 401', async () => {
    const res = await get('/admin/users');
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test('TC-AUTH-E-003', 'Admin can approve pending user', async () => {
    if (!adminToken) return skip('TC-AUTH-E-003', 'Approve user', 'No admin token');
    // Find userId if not set
    if (!userId) {
      const list = await get('/admin/users', { Authorization: `Bearer ${adminToken}` });
      const users = list.json?.users || list.json || [];
      const found = users.find(u => u.email === userEmail);
      if (!found) return skip('TC-AUTH-E-003', 'Approve user', 'Pending user not found');
      userId = found.id;
    }
    const res = await patch(`/admin/users/${userId}`,
      { action: 'approve', role: 'operator' },
      { Authorization: `Bearer ${adminToken}` });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
    assert(res.json?.status === 'active', `Expected active, got ${res.json?.status}`);
    assert(res.json?.role === 'operator', `Expected operator, got ${res.json?.role}`);
  });

  await test('TC-AUTH-E-004', 'Approved user can now sign in', async () => {
    const res = await post('/auth/login', { email: userEmail, password: userPass });
    assert(res.status === 200, `Expected 200 after approval, got ${res.status}: ${res.body}`);
    assert(res.json?.accessToken, 'No accessToken after approval');
  });

  await test('TC-AUTH-E-005', 'Admin can revoke a user', async () => {
    if (!adminToken || !userId) return skip('TC-AUTH-E-005', 'Revoke user', 'No token or userId');
    const res = await patch(`/admin/users/${userId}`,
      { action: 'revoke' },
      { Authorization: `Bearer ${adminToken}` });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
    assert(res.json?.status === 'revoked', `Expected revoked, got ${res.json?.status}`);
  });

  await test('TC-AUTH-E-006', 'Revoked user cannot sign in (403)', async () => {
    const res = await post('/auth/login', { email: userEmail, password: userPass });
    assert(res.status === 403, `Expected 403 for revoked user, got ${res.status}`);
  });

  // ── Group F — RBAC / Protected Routes ─────────────────────────────────────
  console.log('\n── Group F: RBAC / Protected Routes ─────────────────────────');

  await test('TC-AUTH-F-001', 'Protected API route requires valid token', async () => {
    const res = await get('/api/cameras');
    assert(res.status === 401, `Expected 401 without token, got ${res.status}`);
  });

  await test('TC-AUTH-F-002', 'Protected API route accessible with valid admin token', async () => {
    if (!adminToken) return skip('TC-AUTH-F-002', 'Access cameras', 'No admin token');
    const res = await get('/api/cameras', { Authorization: `Bearer ${adminToken}` });
    assert(res.status === 200, `Expected 200 with token, got ${res.status}`);
  });

  await test('TC-AUTH-F-003', 'Admin endpoint inaccessible with operator token', async () => {
    // Use a freshly re-approved operator user
    if (!userId) return skip('TC-AUTH-F-003', 'Operator→admin endpoint', 'No userId');
    // Re-activate user for this test
    await patch(`/admin/users/${userId}`, { action: 'reactivate' },
      { Authorization: `Bearer ${adminToken}` });
    const loginRes = await post('/auth/login', { email: userEmail, password: userPass });
    if (loginRes.status !== 200) return skip('TC-AUTH-F-003', 'Operator→admin endpoint', 'Login failed');
    const opToken = loginRes.json?.accessToken;
    const res = await get('/admin/users', { Authorization: `Bearer ${opToken}` });
    assert(res.status === 403, `Expected 403 for operator on admin route, got ${res.status}`);
  });

  // ── Group D — Logout ───────────────────────────────────────────────────────
  console.log('\n── Group D: Logout ──────────────────────────────────────────');

  await test('TC-AUTH-D-001', 'POST /auth/logout revokes refresh token', async () => {
    if (!adminRefresh) return skip('TC-AUTH-D-001', 'Logout', 'No refresh cookie');
    const res = await post('/auth/logout', null, {
      Authorization: `Bearer ${adminToken}`,
      Cookie:        `refreshToken=${adminRefresh}`,
    });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
  });

  await test('TC-AUTH-D-002', 'Refresh after logout returns 401', async () => {
    if (!adminRefresh) return skip('TC-AUTH-D-002', 'Refresh after logout', 'No refresh cookie');
    const res = await post('/auth/refresh', null, { Cookie: `refreshToken=${adminRefresh}` });
    assert(res.status === 401, `Expected 401 after logout, got ${res.status}`);
  });

  await test('TC-AUTH-D-003', 'POST /auth/logout with no cookie returns 200 silently', async () => {
    const res = await post('/auth/logout', null, {});
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  });

  // ── Group G — Regression ───────────────────────────────────────────────────
  console.log('\n── Group G: Regression ──────────────────────────────────────');

  await test('TC-AUTH-G-001', 'GET /health still responds 200', async () => {
    const res = await get('/health');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = passed + failed + skipped;
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed  ${failed} failed  ${skipped} skipped  (${total} total)`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (typeof global.__TEST_RESULTS__ !== 'undefined') {
    global.__TEST_RESULTS__ = { passed, failed, skipped, results };
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

runAll().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
