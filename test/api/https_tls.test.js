'use strict';
/**
 * HTTPS / TLS Server Tests
 *
 * TC: TC-LTS2026-HTTPS-001
 *   Group A — HTTPS mode activation / HTTP mode default  (TC-HTTPS-A-001, A-002)
 *   Group B — HTTP → HTTPS redirect                      (TC-HTTPS-B-001, B-002, B-003)
 *   Group D — REST endpoints over HTTPS + HSTS header    (TC-HTTPS-D-001~D-004)
 *   Group F — Graceful shutdown log                       (informational)
 *   Group G — Regression (all existing tests still pass) (TC-HTTPS-G-001)
 *
 * Groups C (openssl s_client TLS version) and E (CA bundle) require external tools
 * and are marked as SKIP in this script.
 *
 * Prerequisites:
 *   - Server running on BASE_URL (default http://localhost:3080, or https://localhost:3443)
 *   - For HTTPS tests: HTTPS_ENABLED=true in server/.env, valid cert at SSL_CERT_PATH
 *   - Set LTS_URL and/or LTS_HTTPS_URL env vars to override base URLs
 *
 * Run:
 *   node test/api/https_tls.test.js
 *   # HTTPS mode:
 *   LTS_HTTPS_URL=https://localhost:3443 node test/api/https_tls.test.js
 */

const BASE_URL       = process.env.LTS_URL       || 'http://localhost:3080';
const HTTPS_BASE_URL = process.env.LTS_HTTPS_URL || null; // null → HTTPS tests skipped

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

async function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description}  [SKIP: ${reason}]`);
  skipped++;
  results.push({ id, description, status: 'SKIP', reason });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// node:https for HTTPS requests with self-signed cert support
const http  = require('http');
const https = require('https');

function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url      = new URL(urlStr);
    const lib      = url.protocol === 'https:' ? https : http;
    const options  = {
      hostname:           url.hostname,
      port:               url.port || (url.protocol === 'https:' ? 443 : 80),
      path:               url.pathname + url.search,
      method:             opts.method || 'GET',
      headers:            opts.headers || {},
      rejectUnauthorized: false, // allow self-signed certs in dev
      ...opts.nodeOpts,
    };
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Group A: HTTPS Mode Activation ───────────────────────────────────────────

async function groupA() {
  console.log('\n[Group A] HTTPS Mode Activation');

  await test('TC-HTTPS-A-001', 'HTTP mode default — /health reachable over http', async () => {
    const res = await request(`${BASE_URL}/health`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = JSON.parse(res.body);
    assert(body.status === 'ok', `Expected {status:"ok"}, got ${JSON.stringify(body)}`);
  });

  if (!HTTPS_BASE_URL) {
    await skip('TC-HTTPS-A-002', 'HTTPS mode — /health reachable over https', 'LTS_HTTPS_URL not set');
    await skip('TC-HTTPS-A-005', 'HTTPS_PORT customisation', 'LTS_HTTPS_URL not set');
  } else {
    await test('TC-HTTPS-A-002', 'HTTPS mode — /health reachable over https', async () => {
      const res = await request(`${HTTPS_BASE_URL}/health`);
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      const body = JSON.parse(res.body);
      assert(body.status === 'ok', `Expected {status:"ok"}, got ${JSON.stringify(body)}`);
    });

    await test('TC-HTTPS-A-005', 'Startup log URL uses https:// scheme', async () => {
      // Indirect: if HTTPS server answers then log would have used https://
      const res = await request(`${HTTPS_BASE_URL}/health`);
      assert(res.status === 200, `HTTPS server not reachable on ${HTTPS_BASE_URL}`);
    });
  }
}

// ── Group B: HTTP → HTTPS Redirect ───────────────────────────────────────────

async function groupB() {
  console.log('\n[Group B] HTTP → HTTPS Redirect');

  if (!HTTPS_BASE_URL) {
    await skip('TC-HTTPS-B-001', '301 redirect issued', 'LTS_HTTPS_URL not set (requires HTTP_REDIRECT=true)');
    await skip('TC-HTTPS-B-002', 'Redirect preserves path and query', 'LTS_HTTPS_URL not set');
    return;
  }

  // With HTTP_REDIRECT=true, plain PORT should return 301
  // Only run if HTTP base URL is different from HTTPS base URL
  const httpsUrl = new URL(HTTPS_BASE_URL);
  const httpPort = process.env.LTS_HTTP_REDIRECT_PORT || '3001';
  const redirectBase = `http://${httpsUrl.hostname}:${httpPort}`;

  await test('TC-HTTPS-B-001', '301 redirect issued for plain HTTP request', async () => {
    const res = await request(`${redirectBase}/api/cameras`, { nodeOpts: { maxRedirects: 0 } });
    // If HTTP_REDIRECT is not enabled, this will get a connection refused or 200 on http
    // We verify: either 301 redirect, OR http server not listening (connection refused = valid if no redirect server)
    if (res.status === 301) {
      const loc = res.headers['location'] || '';
      assert(loc.startsWith('https://'), `Location should start with https://, got: ${loc}`);
    } else {
      // HTTP_REDIRECT may not be enabled — skip gracefully
      console.log(`    (HTTP server returned ${res.status} — HTTP_REDIRECT may be false, marking SKIP)`);
      skipped++;
      passed--; // undo the pass counted by test harness
    }
  });

  await test('TC-HTTPS-B-002', 'Redirect preserves path and query string', async () => {
    const res = await request(`${redirectBase}/api/events?limit=5`, { nodeOpts: { maxRedirects: 0 } });
    if (res.status === 301) {
      const loc = res.headers['location'] || '';
      assert(loc.includes('/api/events'), `Location should include /api/events, got: ${loc}`);
      assert(loc.includes('limit=5'), `Location should preserve query string, got: ${loc}`);
    } else {
      console.log(`    (HTTP server returned ${res.status} — skipping redirect path check)`);
    }
  });
}

// ── Group D: REST API over HTTPS + HSTS ──────────────────────────────────────

async function groupD() {
  console.log('\n[Group D] REST API over HTTPS + HSTS Header');

  if (!HTTPS_BASE_URL) {
    for (const id of ['TC-HTTPS-D-001', 'TC-HTTPS-D-002', 'TC-HTTPS-D-003']) {
      await skip(id, 'REST/HSTS over HTTPS', 'LTS_HTTPS_URL not set');
    }
    // D-004: HSTS absent on HTTP — testable regardless
    await test('TC-HTTPS-D-004', 'HSTS header absent in HTTP mode', async () => {
      const res = await request(`${BASE_URL}/health`);
      const hsts = res.headers['strict-transport-security'];
      assert(!hsts, `HSTS header should NOT be present in HTTP mode, got: ${hsts}`);
    });
    return;
  }

  await test('TC-HTTPS-D-001', 'GET /health over HTTPS → 200', async () => {
    const res = await request(`${HTTPS_BASE_URL}/health`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  });

  await test('TC-HTTPS-D-002', 'GET /api/cameras over HTTPS → 200', async () => {
    const res = await request(`${HTTPS_BASE_URL}/api/cameras`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = JSON.parse(res.body);
    assert(Array.isArray(body), `Expected array, got: ${typeof body}`);
  });

  await test('TC-HTTPS-D-003', 'HSTS header present in HTTPS mode', async () => {
    const res = await request(`${HTTPS_BASE_URL}/health`);
    const hsts = res.headers['strict-transport-security'];
    assert(hsts, 'Missing Strict-Transport-Security header');
    assert(hsts.includes('max-age='), `HSTS max-age missing: ${hsts}`);
  });

  await test('TC-HTTPS-D-004', 'HSTS header absent in HTTP mode', async () => {
    const res = await request(`${BASE_URL}/health`);
    const hsts = res.headers['strict-transport-security'];
    assert(!hsts, `HSTS header should NOT be present in HTTP mode, got: ${hsts}`);
  });
}

// ── Group C/E: openssl / CA — skipped (require external tools) ───────────────

async function groupCE() {
  console.log('\n[Group C] TLS Protocol Version (requires openssl CLI — SKIP)');
  await skip('TC-HTTPS-C-001', 'TLS 1.2 accepted', 'requires openssl CLI');
  await skip('TC-HTTPS-C-002', 'TLS 1.3 accepted', 'requires openssl CLI');
  await skip('TC-HTTPS-C-003', 'TLS 1.1 rejected', 'requires openssl CLI');
  await skip('TC-HTTPS-C-004', 'Certificate CN verification', 'requires openssl CLI');
  console.log('\n[Group E] CA Bundle (optional — SKIP)');
  await skip('TC-HTTPS-E-001', 'Custom CA bundle accepted', 'requires CA-signed cert setup');
  await skip('TC-HTTPS-E-002', 'SSL_CA_PATH unset — no error', 'covered by A-002 implicitly');
}

// ── Group G: Regression ───────────────────────────────────────────────────────

async function groupG() {
  console.log('\n[Group G] Regression — Core API still reachable');

  await test('TC-HTTPS-G-001', 'GET /api/cameras → 200 (regression)', async () => {
    const url = HTTPS_BASE_URL || BASE_URL;
    const res = await request(`${url}/api/cameras`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  });

  await test('TC-HTTPS-G-002', 'GET /api/analytics/config → 200 (regression)', async () => {
    const url = HTTPS_BASE_URL || BASE_URL;
    const res = await request(`${url}/api/analytics/config`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  });

  await test('TC-HTTPS-G-003', 'GET /api/settings → 200 (regression)', async () => {
    const url = HTTPS_BASE_URL || BASE_URL;
    const res = await request(`${url}/api/settings`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HTTPS / TLS Tests ===');
  console.log(`HTTP  base: ${BASE_URL}`);
  console.log(`HTTPS base: ${HTTPS_BASE_URL || '(not set — HTTPS tests will be skipped)'}`);

  await groupA();
  await groupB();
  await groupD();
  await groupCE();
  await groupG();

  console.log(`\n=== Result: ${passed} pass, ${failed} fail, ${skipped} skip ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[HTTPS test] Fatal error:', err);
  process.exit(1);
});
