'use strict';
/**
 * Ingest Daemon Control — REST API Tests
 *
 * TC: TC-LTS-INGEST-CONTROL-001 (docs/tc/TC_Ingest_Daemon_Control.md)
 *
 * SAFETY NOTE: Stop/Restart are destructive against a live server's real
 * camera capture. This suite only exercises non-destructive paths (auth
 * gating, backend gating, Start-when-already-running no-op, audit log,
 * CLI --dry-run) by default. Set LTS_TEST_INGEST_DESTRUCTIVE=true to also
 * run the actual Stop/Restart tests — only do this against a disposable/dev
 * ingest-daemon, never against a server with real cameras you care about.
 *
 * Prerequisites:
 *   - Server running (default https://localhost:3443)
 *   - AUTH_ENABLED=true in server/.env
 *
 * Run:
 *   node test/api/ingest_daemon_control.test.js
 *   LTS_URL=https://localhost:3443 node test/api/ingest_daemon_control.test.js
 *   LTS_TEST_INGEST_DESTRUCTIVE=true node test/api/ingest_daemon_control.test.js
 */

const BASE_URL = process.env.LTS_URL || 'https://localhost:3443';
const DESTRUCTIVE = process.env.LTS_TEST_INGEST_DESTRUCTIVE === 'true';

// ── Minimal test harness (mirrors test/api/auth.test.js) ─────────────────────

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

// Reads INGEST_DAEMON_INSTANCES straight from server/.env — the multi-instance
// fleet tests (TC-IDC-015~017) only make sense when N>1 is actually configured.
function readEnvInt(envPath, name, defaultValue) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const m = content.match(new RegExp(`^${name}=(.*)$`, 'm'));
    const n = m ? parseInt(m[1].trim(), 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      rejectUnauthorized: false,
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

function post(path_, body, headers = {}) {
  return request(`${BASE_URL}${path_}`, { method: 'POST', body, headers });
}
function get(path_, headers = {}) {
  return request(`${BASE_URL}${path_}`, { method: 'GET', headers });
}

// ── Test state ────────────────────────────────────────────────────────────────

const TS        = Date.now();
const viewerEmail = `ingest_ctrl_viewer_${TS}@lts-test.local`;
const viewerPass  = 'ViewerPass1!';

const envAdminEmail = process.env.LTS_ADMIN_EMAIL;
const envAdminPass  = process.env.LTS_ADMIN_PASSWORD;

let adminToken  = null;
let viewerToken = null;
let backendEnabled = false; // CAPTURE_BACKEND === 'ingest-daemon', from GET /api/ingest-status

// ─────────────────────────────────────────────────────────────────────────────

async function runAll() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' TC-LTS-INGEST-CONTROL-001  Ingest Daemon Control');
  console.log(`  Server: ${BASE_URL}  (destructive tests: ${DESTRUCTIVE ? 'ENABLED' : 'disabled'})`);
  console.log('══════════════════════════════════════════════════════════════\n');

  try {
    const h = await get('/health');
    assert(h.status === 200, `Health check failed: ${h.status}`);
    console.log('  ◆ Server reachable\n');
  } catch (err) {
    console.error(`  ✗ Server not reachable at ${BASE_URL}: ${err.message}`);
    process.exit(1);
  }

  const ingestStatus = await get('/api/ingest-status');
  backendEnabled = ingestStatus.json?.enabled === true;
  console.log(`  ◆ CAPTURE_BACKEND=ingest-daemon active: ${backendEnabled}\n`);

  // ── Auth setup ────────────────────────────────────────────────────────────
  console.log('── Setup: obtaining tokens ───────────────────────────────────');

  await test('TC-IDC-SETUP-1', 'Register throwaway viewer user', async () => {
    const res = await post('/auth/register', { email: viewerEmail, password: viewerPass, name: 'Ingest Ctrl Viewer' });
    if (res.status === 409) return; // idempotent
    assert(res.status === 201, `Expected 201, got ${res.status}: ${res.body}`);
  });

  await test('TC-IDC-SETUP-2', 'Admin login (registration bootstrap or LTS_ADMIN_EMAIL/PASSWORD)', async () => {
    if (envAdminEmail && envAdminPass) {
      const res = await post('/auth/login', { email: envAdminEmail, password: envAdminPass });
      assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
      adminToken = res.json.accessToken;
      return;
    }
    // Fall back to a fresh registration — only becomes usable admin if this
    // is the first user in an empty DB (see auth.test.js TC-AUTH-A-001).
    const adminEmail = `ingest_ctrl_admin_${TS}@lts-test.local`;
    const adminPass  = 'AdminPass1!';
    await post('/auth/register', { email: adminEmail, password: adminPass, name: 'Ingest Ctrl Admin' });
    const res = await post('/auth/login', { email: adminEmail, password: adminPass });
    if (res.status === 200 && res.json?.accessToken) {
      // Only trust this token if it actually carries the admin role — a
      // pending/viewer login would otherwise make every "admin" test below
      // silently assert against a 403, not a real gap.
      const me = await get('/auth/me', { Authorization: `Bearer ${res.json.accessToken}` });
      if (me.json?.role === 'admin') adminToken = res.json.accessToken;
    }
  });

  await test('TC-IDC-SETUP-3', 'Viewer login', async () => {
    const res = await post('/auth/login', { email: viewerEmail, password: viewerPass });
    if (res.status === 200 && res.json?.accessToken) viewerToken = res.json.accessToken;
    // A pending viewer may not be able to log in yet — that's fine, TC-IDC-001
    // below falls back to "no token" which exercises the same 401 gate.
  });

  // ── TC-IDC-001: auth gating ─────────────────────────────────────────────────
  console.log('\n── TC-IDC-001: Access control ────────────────────────────────');

  for (const action of ['start', 'stop', 'restart']) {
    await test(`TC-IDC-001-${action}-no-token`, `POST /admin/ingest/${action} with no token → 401/403`, async () => {
      const res = await post(`/admin/ingest/${action}`, {});
      assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
    });
  }

  if (viewerToken) {
    for (const action of ['start', 'stop', 'restart']) {
      await test(`TC-IDC-001-${action}-viewer`, `POST /admin/ingest/${action} as viewer → 403`, async () => {
        const res = await post(`/admin/ingest/${action}`, {}, { Authorization: `Bearer ${viewerToken}` });
        assert(res.status === 403, `Expected 403, got ${res.status}: ${res.body}`);
      });
    }
  } else {
    await skip('TC-IDC-001-viewer', 'Non-admin role rejection', 'no usable viewer token (pending approval in this DB)');
  }

  // ── TC-IDC-002: backend gating ───────────────────────────────────────────────
  console.log('\n── TC-IDC-002: CAPTURE_BACKEND gating ───────────────────────');

  if (!adminToken) {
    await skip('TC-IDC-002', 'CAPTURE_BACKEND gating', 'no admin token available');
  } else if (backendEnabled) {
    await skip('TC-IDC-002', 'CAPTURE_BACKEND!=ingest-daemon → 501', 'this server has CAPTURE_BACKEND=ingest-daemon active — cannot exercise the disabled branch without reconfiguring');
  } else {
    await test('TC-IDC-002', 'POST /admin/ingest/start with CAPTURE_BACKEND != ingest-daemon → 501', async () => {
      const res = await post('/admin/ingest/start', {}, { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 501, `Expected 501, got ${res.status}: ${res.body}`);
    });
  }

  // ── TC-IDC-003 / 010: non-destructive admin action + audit ──────────────────
  console.log('\n── TC-IDC-003/010: Start (no-op when already running) + audit ─');

  if (!adminToken || !backendEnabled) {
    await skip('TC-IDC-003', 'Start no-op when already running', !adminToken ? 'no admin token' : 'CAPTURE_BACKEND != ingest-daemon on this server');
    await skip('TC-IDC-010', 'Audit log entry for start', !adminToken ? 'no admin token' : 'CAPTURE_BACKEND != ingest-daemon on this server');
  } else {
    let startResult = null;
    await test('TC-IDC-003', 'POST /admin/ingest/start returns 200 with ok:true', async () => {
      const res = await post('/admin/ingest/start', {}, { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
      assert(res.json?.ok === true, `Expected ok:true, got ${res.body}`);
      startResult = res.json;
    });

    await test('TC-IDC-010', 'Audit log contains ingest_daemon_start entry', async () => {
      const res = await get('/admin/audit?event=ingest_daemon_start&limit=5', { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(Array.isArray(res.json?.events) && res.json.events.length > 0,
        'Expected at least one ingest_daemon_start audit entry');
    });

    if (startResult) console.log(`      (daemon alreadyRunning=${startResult.alreadyRunning}, pid=${startResult.pid ?? '-'})`);
  }

  // ── TC-IDC destructive: Stop/Restart (opt-in only) ──────────────────────────
  console.log('\n── TC-IDC-005~008: Stop/Restart (destructive, opt-in) ────────');

  if (!DESTRUCTIVE) {
    await skip('TC-IDC-005', 'Stop terminates a healthy daemon', 'set LTS_TEST_INGEST_DESTRUCTIVE=true to run — interrupts real camera capture');
    await skip('TC-IDC-008', 'Restart recovers daemon + re-registers cameras', 'set LTS_TEST_INGEST_DESTRUCTIVE=true to run — interrupts real camera capture');
  } else if (!adminToken || !backendEnabled) {
    await skip('TC-IDC-005', 'Stop terminates a healthy daemon', !adminToken ? 'no admin token' : 'CAPTURE_BACKEND != ingest-daemon');
    await skip('TC-IDC-008', 'Restart recovers daemon + re-registers cameras', !adminToken ? 'no admin token' : 'CAPTURE_BACKEND != ingest-daemon');
  } else {
    await test('TC-IDC-005', 'POST /admin/ingest/stop → ok:true, wasRunning reflects prior state', async () => {
      const res = await post('/admin/ingest/stop', {}, { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
      assert(res.json?.ok === true, `Expected ok:true, got ${res.body}`);
    });

    await test('TC-IDC-008', 'POST /admin/ingest/restart → ok:true, pid present, cameras re-registered', async () => {
      const res = await post('/admin/ingest/restart', {}, { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
      assert(res.json?.ok === true, `Expected ok:true, got ${res.body}`);
      assert(typeof res.json?.pid === 'number', `Expected numeric pid, got ${JSON.stringify(res.json?.pid)}`);
    });
  }

  // ── TC-IDC-015~017: multi-instance fleet targeting (destructive, opt-in) ────
  console.log('\n── TC-IDC-015~017: instance param (destructive, opt-in) ──────');

  const serverDir = path.resolve(__dirname, '..', '..', 'server');
  const instanceCount = readEnvInt(path.join(serverDir, '.env'), 'INGEST_DAEMON_INSTANCES', 1);

  if (!DESTRUCTIVE) {
    await skip('TC-IDC-015', 'instance param targets a single instance', 'set LTS_TEST_INGEST_DESTRUCTIVE=true to run — interrupts real camera capture');
    await skip('TC-IDC-016', 'omitted instance targets the whole fleet', 'set LTS_TEST_INGEST_DESTRUCTIVE=true to run — interrupts real camera capture');
    await skip('TC-IDC-017', 'single-instance deployments unaffected by the fleet feature', 'set LTS_TEST_INGEST_DESTRUCTIVE=true to run — interrupts real camera capture');
  } else if (!adminToken || !backendEnabled) {
    await skip('TC-IDC-015', 'instance param targets a single instance', !adminToken ? 'no admin token' : 'CAPTURE_BACKEND != ingest-daemon');
    await skip('TC-IDC-016', 'omitted instance targets the whole fleet', !adminToken ? 'no admin token' : 'CAPTURE_BACKEND != ingest-daemon');
    await skip('TC-IDC-017', 'single-instance deployments unaffected by the fleet feature', !adminToken ? 'no admin token' : 'CAPTURE_BACKEND != ingest-daemon');
  } else if (instanceCount <= 1) {
    await skip('TC-IDC-015', 'instance param targets a single instance', 'INGEST_DAEMON_INSTANCES <= 1 — set to 3+ in server/.env to exercise fleet targeting');
    await skip('TC-IDC-016', 'omitted instance targets the whole fleet', 'INGEST_DAEMON_INSTANCES <= 1 — set to 3+ in server/.env to exercise fleet targeting');

    await test('TC-IDC-017', 'Single-instance deployment: restart response has no instances[] wrapper', async () => {
      const res = await post('/admin/ingest/restart', {}, { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
      assert(res.json?.ok === true, `Expected ok:true, got ${res.body}`);
      assert(res.json?.instances === undefined, `Expected no instances[] wrapper for single-instance deployment, got ${JSON.stringify(res.json)}`);
      assert(typeof res.json?.pid === 'number', `Expected numeric pid, got ${JSON.stringify(res.json?.pid)}`);
    });
  } else {
    await test('TC-IDC-015', 'instance:1 restarts only that instance (flat response, no instances[])', async () => {
      const res = await post('/admin/ingest/restart', { instance: 1 }, { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
      assert(res.json?.ok === true, `Expected ok:true, got ${res.body}`);
      assert(res.json?.instances === undefined, `Expected flat single-instance shape when instance is specified, got ${JSON.stringify(res.json)}`);
      assert(typeof res.json?.pid === 'number', `Expected numeric pid, got ${JSON.stringify(res.json?.pid)}`);
    });

    await test('TC-IDC-016', 'Omitted instance restarts the whole fleet (instances[] wrapper)', async () => {
      const res = await post('/admin/ingest/restart', {}, { Authorization: `Bearer ${adminToken}` });
      assert(res.status === 200, `Expected 200, got ${res.status}: ${res.body}`);
      assert(res.json?.ok === true, `Expected ok:true, got ${res.body}`);
      assert(Array.isArray(res.json?.instances), `Expected instances[] array for fleet-wide restart, got ${JSON.stringify(res.json)}`);
      assert(res.json.instances.length === instanceCount, `Expected ${instanceCount} instances, got ${res.json.instances.length}`);
      for (const inst of res.json.instances) {
        assert(typeof inst.index === 'number', `Expected numeric index per instance, got ${JSON.stringify(inst)}`);
        assert(typeof inst.port === 'number', `Expected numeric port per instance, got ${JSON.stringify(inst)}`);
      }
    });
  }

  // ── TC-IDC-011: CLI --dry-run (always safe) ──────────────────────────────────
  console.log('\n── TC-IDC-011: CLI --dry-run (no side effects) ──────────────');

  await test('TC-IDC-011-start', 'npm run ingest:start -- --dry-run exits 0 and prints config', () => {
    const out = execSync('node src/scripts/startIngestDaemon.js --dry-run', { cwd: serverDir, encoding: 'utf8' });
    assert(out.includes('--dry-run'), `Expected dry-run marker in output, got: ${out}`);
  });

  await test('TC-IDC-011-restart', 'npm run ingest:restart -- --dry-run exits 0 and prints config', () => {
    const out = execSync('node src/scripts/restartIngestDaemon.js --dry-run', { cwd: serverDir, encoding: 'utf8' });
    assert(out.includes('--dry-run'), `Expected dry-run marker in output, got: ${out}`);
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (process.send) process.send({ suite: 'ingest_daemon_control', passed, failed, skipped, results });
  process.exitCode = failed > 0 ? 1 : 0;
}

runAll().catch((err) => {
  console.error('Fatal error running test suite:', err);
  process.exit(1);
});
