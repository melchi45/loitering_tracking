'use strict';
/**
 * Admin Log Viewer — REST API Tests
 *
 * TC: TC-LOG-001 ~ TC-LOG-020 (see docs/tc/TC_Admin_Log_Viewer.md)
 *
 * Prerequisites:
 *   - LTS server running (default http://localhost:3080)
 *   - AUTH_ENABLED=true in server/.env
 *   - An admin account exists: email=admin@test.local password=Admin1234!
 *   - LOG_TO_FILE=true in server/.env (for log file tests)
 *
 * Run:
 *   node test/api/admin_log_viewer.test.js
 *   LTS_URL=http://localhost:3080 node test/api/admin_log_viewer.test.js
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@test.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin1234!';

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

function skip(id, description, reason) {
  console.log(`  ○ ${id}: ${description} [SKIP: ${reason}]`);
  skipped++;
  results.push({ id, description, status: 'SKIP', reason });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  });
  return res;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

let adminToken = null;
let viewerToken = null;

async function getAdminToken() {
  if (adminToken) return adminToken;
  const res = await apiFetch('/api/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Admin login failed: ${res.status}`);
  const data = await res.json();
  adminToken = data.accessToken;
  return adminToken;
}

async function adminFetch(path, opts = {}) {
  const token = await getAdminToken();
  return apiFetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Admin Log Viewer — API Tests');
  console.log(`  Server: ${BASE_URL}`);
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── Group A: GET /admin/logs/recent ──────────────────────────────────────

  console.log('── GET /admin/logs/recent ──────────────────────────────────────');

  await test('TC-LOG-A-001', 'Admin can GET /admin/logs/recent (server source)', async () => {
    const res = await adminFetch('/admin/logs/recent?source=server&limit=50');
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.logs), 'logs must be array');
    assert(typeof body.level === 'string', 'level must be string');
    assert(typeof body.total === 'number', 'total must be number');
    assert(body.total <= 50, `total (${body.total}) should be ≤ 50`);
  });

  await test('TC-LOG-A-002', 'GET /admin/logs/recent default source is server', async () => {
    const res = await adminFetch('/admin/logs/recent');
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.logs), 'logs must be array');
  });

  await test('TC-LOG-A-003', 'GET /admin/logs/recent source=ingest returns array', async () => {
    const res = await adminFetch('/admin/logs/recent?source=ingest&limit=50');
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.logs), 'logs must be array');
  });

  await test('TC-LOG-A-004', 'GET /admin/logs/recent source=mediamtx returns array', async () => {
    const res = await adminFetch('/admin/logs/recent?source=mediamtx&limit=50');
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body.logs), 'logs must be array');
  });

  await test('TC-LOG-A-005', 'GET /admin/logs/recent invalid source returns 400', async () => {
    const res = await adminFetch('/admin/logs/recent?source=unknown');
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert(body.error, 'should have error message');
  });

  await test('TC-LOG-A-006', 'GET /admin/logs/recent without auth returns 401', async () => {
    const res = await apiFetch('/admin/logs/recent');
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });

  await test('TC-LOG-A-007', 'Log entry shape is valid (ts, level, msg, t)', async () => {
    const res = await adminFetch('/admin/logs/recent?source=server&limit=5');
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    if (body.logs.length > 0) {
      const entry = body.logs[0];
      assert(typeof entry.ts    === 'string', `ts must be string, got ${typeof entry.ts}`);
      assert(typeof entry.level === 'string', `level must be string, got ${typeof entry.level}`);
      assert(typeof entry.msg   === 'string', `msg must be string, got ${typeof entry.msg}`);
      assert(typeof entry.t     === 'number', `t must be number, got ${typeof entry.t}`);
      const validLevels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
      assert(validLevels.includes(entry.level), `level "${entry.level}" not in ${validLevels}`);
    }
  });

  await test('TC-LOG-A-008', 'Limit param caps results at requested value', async () => {
    const res = await adminFetch('/admin/logs/recent?source=server&limit=10');
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.logs.length <= 10, `Got ${body.logs.length} entries, expected ≤ 10`);
  });

  // ── Group B: PATCH /admin/logs/level ─────────────────────────────────────

  console.log('\n── PATCH /admin/logs/level ─────────────────────────────────────');

  let originalLevel = 'INFO';

  await test('TC-LOG-B-001', 'Admin can change log level to DEBUG', async () => {
    // Save original level first
    const r = await adminFetch('/admin/logs/recent?source=server&limit=1');
    if (r.ok) { const b = await r.json(); originalLevel = b.level || 'INFO'; }

    const res = await adminFetch('/admin/logs/level', {
      method: 'PATCH',
      body: JSON.stringify({ level: 'DEBUG' }),
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.ok === true, 'ok must be true');
    assert(body.level === 'DEBUG', `Expected level=DEBUG, got ${body.level}`);
  });

  await test('TC-LOG-B-002', 'Level change persists in subsequent GET', async () => {
    const res = await adminFetch('/admin/logs/recent?source=server&limit=1');
    assert(res.ok);
    const body = await res.json();
    assert(body.level === 'DEBUG', `Expected level=DEBUG, got ${body.level}`);
  });

  await test('TC-LOG-B-003', 'Admin can change log level to WARNING', async () => {
    const res = await adminFetch('/admin/logs/level', {
      method: 'PATCH',
      body: JSON.stringify({ level: 'WARNING' }),
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.level === 'WARNING', `Expected WARNING, got ${body.level}`);
  });

  await test('TC-LOG-B-004', 'Invalid level returns 400', async () => {
    const res = await adminFetch('/admin/logs/level', {
      method: 'PATCH',
      body: JSON.stringify({ level: 'TRACE' }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert(body.error, 'should have error message');
  });

  await test('TC-LOG-B-005', 'Missing level field returns 400', async () => {
    const res = await adminFetch('/admin/logs/level', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('TC-LOG-B-006', 'PATCH /admin/logs/level without auth returns 401', async () => {
    const res = await apiFetch('/admin/logs/level', {
      method: 'PATCH',
      body: JSON.stringify({ level: 'DEBUG' }),
    });
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });

  await test('TC-LOG-B-007', 'Restore original log level', async () => {
    const res = await adminFetch('/admin/logs/level', {
      method: 'PATCH',
      body: JSON.stringify({ level: originalLevel }),
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.level === originalLevel, `Expected ${originalLevel}, got ${body.level}`);
  });

  // ── Group C: Level change audit ──────────────────────────────────────────

  console.log('\n── Audit log ─────────────────────────────────────────────────');

  await test('TC-LOG-C-001', 'Level change is recorded in audit log', async () => {
    // Make a level change
    await adminFetch('/admin/logs/level', {
      method: 'PATCH',
      body: JSON.stringify({ level: 'ERROR' }),
    });

    // Fetch audit log
    const res = await adminFetch('/admin/audit?limit=20');
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json();
    const levelEntry = (body.events || []).find(e => e.event === 'log_level_changed');
    assert(levelEntry, 'Expected log_level_changed audit entry');

    // Restore
    await adminFetch('/admin/logs/level', { method: 'PATCH', body: JSON.stringify({ level: 'INFO' }) });
  });

  // ── Group D: UI behaviour notes (frontend-only, verified manually) ───────
  //
  // TC-LOG-021: Toolbar visible during auto-scroll — FR-LOG-015
  //   Manual: confirm toolbar/search bar do not scroll out of view while entries arrive.
  //
  // TC-LOG-022: Auto-scroll re-enables on scroll-to-bottom — FR-LOG-010
  //   Manual: scroll up → auto-scroll off; scroll back to bottom → auto-scroll on.
  //
  // TC-LOG-023: Search bar always visible — FR-LOG-015/016
  //   Manual: search bar between toolbar and stats row; stays visible while log area scrolls.
  //
  // TC-LOG-024: Search filters log list — FR-LOG-016
  //   Manual: type keyword → list filters case-insensitively; matches highlighted in yellow.
  //
  // TC-LOG-025: No-match empty state — FR-LOG-016
  //   Manual: type non-existent string → shows 'No matches for "..."'.
  //
  // TC-LOG-026: Search clear button — FR-LOG-016
  //   Manual: ✕ clears query; full level-filtered list reappears.
  //
  // TC-LOG-027: Multiple highlight occurrences per line — FR-LOG-016
  //   Manual: short query → all occurrences in a single row highlighted.
  //
  // TC-LOG-028: Download respects search filter — FR-LOG-016
  //   Manual: search active → download exports only matching lines.

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed · ${failed} failed · ${skipped} skipped`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (typeof process !== 'undefined') {
    process.exitCode = failed > 0 ? 1 : 0;
  }

  return { passed, failed, skipped, results };
}

runTests().catch(err => {
  console.error('[admin_log_viewer] Unexpected error:', err.message);
  process.exitCode = 1;
});
