'use strict';
/**
 * MCP Server Integration Tests
 * TC: TC-LTS-MCP-01 Groups A, D, C, B, E
 * SRS: FR-MCP-001 ~ FR-MCP-065
 *
 * Tests two layers:
 *   1. HTTP transport endpoints (/health, /schema) — TC-A
 *   2. Tool handler integration against live LTS API — TC-B/C/D/E
 *
 * Prerequisites:
 *   - LTS server running on LTS_URL (default http://localhost:3080)
 *   - Node.js 18+ (dynamic import)
 *
 * Run: node test/api/mcp_server.test.js
 */

const { spawn }  = require('child_process');
const path       = require('path');

const BASE_URL   = process.env.LTS_URL  || 'http://localhost:3080';
const MCP_PORT   = parseInt(process.env.MCP_PORT || '3002', 10);
const MCP_URL    = `http://localhost:${MCP_PORT}`;
const MCP_DIR    = path.resolve(__dirname, '../../mcp-server');

// ── Minimal test harness ─────────────────────────────────────────────────────

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

function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description} (skipped — ${reason})`);
  results.push({ id, description, status: 'SKIP' });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function ltsGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(5000) });
  return res.json().catch(() => ({}));
}

// ── MCP child process management ─────────────────────────────────────────────

let mcpProc = null;

async function startMcpServer() {
  return new Promise((resolve, reject) => {
    mcpProc = spawn('node', ['index.js'], {
      cwd: MCP_DIR,
      env: {
        ...process.env,
        TRANSPORT:    'http',
        MCP_PORT:     String(MCP_PORT),
        LTS_BASE_URL: BASE_URL,
      },
    });

    let started = false;
    const timer = setTimeout(() => {
      if (!started) reject(new Error('MCP server startup timeout (5s)'));
    }, 5000);

    mcpProc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!started && msg.includes('listening on port')) {
        started = true;
        clearTimeout(timer);
        setTimeout(resolve, 200); // brief settle
      }
    });

    mcpProc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`MCP spawn error: ${err.message}`));
    });

    mcpProc.on('exit', (code) => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited prematurely with code ${code}`));
      }
    });
  });
}

function stopMcpServer() {
  if (mcpProc) {
    mcpProc.kill('SIGTERM');
    mcpProc = null;
  }
}

// ── MockMcpServer for direct tool handler testing ─────────────────────────────

class MockMcpServer {
  constructor() {
    this.tools     = {};
    this.resources = {};
  }
  tool(name, _desc, _schema, handler) {
    this.tools[name] = handler;
  }
  resource(name, _uriOrTemplate, _meta, handler) {
    this.resources[name] = handler;
  }
}

// ── Dynamic ESM imports ───────────────────────────────────────────────────────

let LTSClient, registerCameraTools, registerAlertTools,
    registerLoiteringTools, registerAnalyticsTools, registerResources,
    TOOL_CATALOG, RESOURCE_CATALOG;

async function loadModules() {
  const clientMod  = await import(`${MCP_DIR}/lts-client.js`);
  LTSClient        = clientMod.LTSClient;

  const camMod     = await import(`${MCP_DIR}/tools/cameras.js`);
  registerCameraTools = camMod.registerCameraTools;

  const alertMod   = await import(`${MCP_DIR}/tools/alerts.js`);
  registerAlertTools = alertMod.registerAlertTools;

  const loiMod     = await import(`${MCP_DIR}/tools/loitering.js`);
  registerLoiteringTools = loiMod.registerLoiteringTools;

  const anaMod     = await import(`${MCP_DIR}/tools/analytics.js`);
  registerAnalyticsTools = anaMod.registerAnalyticsTools;

  const resMod     = await import(`${MCP_DIR}/resources.js`);
  registerResources = resMod.registerResources;

  const srvMod     = await import(`${MCP_DIR}/create-server.js`);
  TOOL_CATALOG     = srvMod.TOOL_CATALOG;
  RESOURCE_CATALOG = srvMod.RESOURCE_CATALOG;
}

function buildLiveServer() {
  const srv    = new MockMcpServer();
  const client = new LTSClient(BASE_URL);
  registerCameraTools(srv, client);
  registerAlertTools(srv, client);
  registerLoiteringTools(srv, client);
  registerAnalyticsTools(srv, client);
  registerResources(srv, client);
  return srv;
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]');
  const health = await ltsGet('/health');
  assert(health.status === 'ok', `LTS server not healthy: ${JSON.stringify(health)}`);
  console.log('  ✓ LTS server is running');
  await loadModules();
  console.log('  ✓ MCP modules loaded');
}

// ── Group A — HTTP Transport (TOOL_CATALOG / RESOURCE_CATALOG) ────────────────

async function runGroupA() {
  console.log('\n[Group A] Server Startup & HTTP Transport\n');

  // TC-A-001 — static catalog sizes (no process needed)
  await test('TC-A-001', 'TOOL_CATALOG has expected tools', async () => {
    assertEq(TOOL_CATALOG.length, 18, 'tool count');
  });

  await test('TC-A-001b', 'RESOURCE_CATALOG has expected resources', async () => {
    assertEq(RESOURCE_CATALOG.length, 7, 'resource count');
  });

  await test('TC-A-001c', 'Every tool has name, access, description', async () => {
    for (const t of TOOL_CATALOG) {
      assert(t.name        && t.name.length > 0,        `tool missing name: ${JSON.stringify(t)}`);
      assert(t.access      && ['read', 'write'].includes(t.access), `tool ${t.name} invalid access`);
      assert(t.description && t.description.length > 0, `tool ${t.name} missing description`);
    }
  });

  // TC-A-002 / TC-A-003 — HTTP transport endpoints
  console.log('  … starting MCP server in HTTP mode');
  try {
    await startMcpServer();
    console.log(`  ✓ MCP server started on port ${MCP_PORT}`);

    await test('TC-A-002', 'GET /health → 200 ok', async () => {
      const { status, body } = await get(`${MCP_URL}/health`);
      assertEq(status, 200, 'HTTP status');
      assertEq(body.status, 'ok', 'status field');
      assertEq(body.transport, 'http', 'transport field');
    });

    await test('TC-A-003', 'GET /schema → 200 with tools and resources arrays', async () => {
      const { status, body } = await get(`${MCP_URL}/schema`);
      assertEq(status, 200, 'HTTP status');
      assert(Array.isArray(body.tools),     'tools is array');
      assert(Array.isArray(body.resources), 'resources is array');
      assertEq(body.tools.length,     18, 'tools count');
      assertEq(body.resources.length,  7, 'resources count');
    });

    await test('TC-A-003b', 'GET /schema — sseUrl and name fields present', async () => {
      const { body } = await get(`${MCP_URL}/schema`);
      assert(body.name && body.name.length > 0,   'name present');
      assert(body.sseUrl && body.sseUrl.length > 0, 'sseUrl present');
    });

  } finally {
    stopMcpServer();
  }
}

// ── Group D — Camera & Zone Tools (live LTS API) ──────────────────────────────

async function runGroupD() {
  console.log('\n[Group D] Camera & Zone Tools (live LTS API)\n');

  const srv = buildLiveServer();

  await test('TC-D-001a', 'get_camera_status — returns text response', async () => {
    const result = await srv.tools.get_camera_status({});
    assert(Array.isArray(result.content), 'content is array');
    assertEq(result.content[0].type, 'text', 'content type');
    assert(result.content[0].text.length > 0, 'text non-empty');
  });

  await test('TC-D-001b', 'get_camera_status — shows camera count or "No cameras"', async () => {
    const result = await srv.tools.get_camera_status({});
    const text   = result.content[0].text;
    // Either "N/M running" or "No cameras configured"
    assert(
      /\d+\/\d+ running/i.test(text) || /No cameras/i.test(text),
      `Unexpected response: ${text.slice(0, 80)}`
    );
  });

  await test('TC-D-001c', 'get_camera_status — unknown cameraId returns not-found', async () => {
    const result = await srv.tools.get_camera_status({ cameraId: 'nonexistent-cam-xyz' });
    const text   = result.content[0].text;
    assert(/not found/i.test(text), `Expected "not found" in: ${text}`);
  });

  await test('TC-D-002a', 'get_zone_config — returns text response for existing camera', async () => {
    // Get any camera first
    const cameras = await ltsGet('/api/cameras');
    const camList = cameras.data || [];

    if (camList.length === 0) {
      skip('TC-D-002a', 'get_zone_config', 'no cameras available');
      return;
    }

    const result = await srv.tools.get_zone_config({ cameraId: camList[0].id });
    assert(Array.isArray(result.content), 'content is array');
    assertEq(result.content[0].type, 'text', 'content type');
  });

  await test('TC-D-002b', 'get_zone_config — unknown cameraId returns "No zones"', async () => {
    const result = await srv.tools.get_zone_config({ cameraId: 'nonexistent-cam-xyz' });
    const text   = result.content[0].text;
    assert(/No zones/i.test(text), `Expected "No zones" in: ${text}`);
  });

  await test('TC-D-003', 'update_zone_threshold — missing zone returns isError', async () => {
    const result = await srv.tools.update_zone_threshold({
      cameraId:       'nonexistent',
      zoneId:         '00000000-0000-0000-0000-000000000000',
      dwellThreshold: 60,
    });
    assertEq(result.isError, true, 'isError flag');
  });
}

// ── Group C — Alert Tools (live LTS API) ─────────────────────────────────────

async function runGroupC() {
  console.log('\n[Group C] Alert Tools (live LTS API)\n');

  const srv = buildLiveServer();

  await test('TC-C-001a', 'get_active_alerts — returns text response', async () => {
    const result = await srv.tools.get_active_alerts({});
    assert(Array.isArray(result.content), 'content is array');
    assertEq(result.content[0].type, 'text', 'content type');
  });

  await test('TC-C-001b', 'get_active_alerts — shows alert count or "All clear"', async () => {
    const result = await srv.tools.get_active_alerts({});
    const text   = result.content[0].text;
    assert(
      /\d+ active/i.test(text) || /All clear/i.test(text),
      `Unexpected response: ${text.slice(0, 80)}`
    );
  });

  await test('TC-C-001c', 'get_active_alerts — limit parameter respected', async () => {
    // This test checks that calling with limit=1 returns at most 1 alert in the text
    const result = await srv.tools.get_active_alerts({ limit: 1 });
    const text   = result.content[0].text;
    // Either "1 active" or "All clear"
    assert(
      /^1 active/i.test(text) || /All clear/i.test(text),
      `Expected "1 active" or "All clear", got: ${text.slice(0, 80)}`
    );
  });

  await test('TC-C-002', 'explain_alert — unknown alertId returns isError', async () => {
    const result = await srv.tools.explain_alert({ alertId: '00000000-0000-0000-0000-000000000000' });
    assertEq(result.isError, true, 'isError flag');
    const text = result.content[0].text;
    assert(/not found/i.test(text), `Expected "not found" in: ${text}`);
  });

  await test('TC-C-003', 'acknowledge_alert — unknown alertId returns isError', async () => {
    const result = await srv.tools.acknowledge_alert({ alertId: '00000000-0000-0000-0000-000000000000' });
    assertEq(result.isError, true, 'isError flag');
  });
}

// ── Group B — Loitering & Tracking Tools (live LTS API) ─────────────────────

async function runGroupB() {
  console.log('\n[Group B] Loitering & Tracking Tools (live LTS API)\n');

  const srv = buildLiveServer();

  await test('TC-B-001a', 'query_loitering_events — returns text response', async () => {
    const result = await srv.tools.query_loitering_events({});
    assert(Array.isArray(result.content), 'content is array');
    assertEq(result.content[0].type, 'text', 'content type');
  });

  await test('TC-B-001b', 'query_loitering_events — shows event count or "No loitering"', async () => {
    const result = await srv.tools.query_loitering_events({});
    const text   = result.content[0].text;
    assert(
      /\d+ loitering/i.test(text) || /No loitering/i.test(text),
      `Unexpected response: ${text.slice(0, 80)}`
    );
  });

  await test('TC-B-001c', 'query_loitering_events — limit parameter reduces results', async () => {
    const result = await srv.tools.query_loitering_events({ limit: 2 });
    const text   = result.content[0].text;
    // Count lines starting with "Event ID:" to check limit is respected
    const eventLines = text.split('\n').filter(l => /^Event ID:/i.test(l.trim()));
    assert(eventLines.length <= 2, `Expected ≤2 events, got ${eventLines.length}`);
  });

  await test('TC-B-002a', 'get_tracking_history — unknown objectId returns no-history message', async () => {
    const result = await srv.tools.get_tracking_history({ objectId: 'nonexistent-obj-xyz' });
    const text   = result.content[0].text;
    assert(
      /not found/i.test(text) || /No tracking history/i.test(text),
      `Expected "not found" or "No tracking history" in: ${text}`
    );
  });
}

// ── Group E — Analytics & Report Tools (live LTS API) ────────────────────────

async function runGroupE() {
  console.log('\n[Group E] Analytics & Report Tools (live LTS API)\n');

  const srv = buildLiveServer();

  await test('TC-E-001a', 'get_analytics_summary — returns text response', async () => {
    const result = await srv.tools.get_analytics_summary({});
    assert(Array.isArray(result.content), 'content is array');
    assertEq(result.content[0].type, 'text', 'content type');
  });

  await test('TC-E-001b', 'get_analytics_summary — text contains "Analytics Summary" or "No data"', async () => {
    const result = await srv.tools.get_analytics_summary({});
    const text   = result.content[0].text;
    assert(
      /Analytics Summary/i.test(text) || /No data/i.test(text),
      `Unexpected response: ${text.slice(0, 100)}`
    );
  });

  await test('TC-E-002a', 'generate_security_report — returns text response', async () => {
    const result = await srv.tools.generate_security_report({});
    assert(Array.isArray(result.content), 'content is array');
    assertEq(result.content[0].type, 'text', 'content type');
    assert(result.content[0].text.length > 0, 'text non-empty');
  });

  await test('TC-E-002b', 'generate_security_report — text is markdown with sections', async () => {
    const result = await srv.tools.generate_security_report({});
    const text   = result.content[0].text;
    // Expect at least one markdown heading
    assert(/^#{1,3} /m.test(text), `Expected markdown heading in report: ${text.slice(0, 100)}`);
  });
}

// ── Group F — MCP Resources (live LTS API) ───────────────────────────────────

async function runGroupF() {
  console.log('\n[Group F] MCP Resources (live LTS API)\n');

  const srv    = new MockMcpServer();
  const client = new LTSClient(BASE_URL);
  registerResources(srv, client);

  await test('TC-F-001', 'lts://cameras resource — returns JSON with cameras array', async () => {
    const result = await srv.resources['cameras']();
    const content = result.contents[0];
    assertEq(content.mimeType, 'application/json', 'mimeType');
    const data = JSON.parse(content.text);
    assert(Array.isArray(data), 'cameras is array');
  });

  await test('TC-F-002', 'lts://alerts/active resource — returns JSON with alerts array', async () => {
    const result = await srv.resources['alerts-active']();
    const content = result.contents[0];
    assertEq(content.mimeType, 'application/json', 'mimeType');
    const data = JSON.parse(content.text);
    assert(Array.isArray(data), 'alerts is array');
    // Verify all returned alerts are unacknowledged
    for (const a of data) {
      assert(a.acknowledged !== true, `Alert ${a.id} should not be acknowledged`);
    }
  });

  await test('TC-F-003', 'lts://zones/{cameraId} resource — returns empty array for unknown camera', async () => {
    const uri = { href: 'lts://zones/nonexistent-cam' };
    const result = await srv.resources['zones'](uri, { cameraId: 'nonexistent-cam' });
    const data = JSON.parse(result.contents[0].text);
    assert(Array.isArray(data), 'zones is array');
    assertEq(data.length, 0, 'no zones for unknown camera');
  });

  await test('TC-F-004', 'lts://system/summary resource — returns summary with camera/alert/event counts', async () => {
    const result = await srv.resources['system-summary']();
    const content = result.contents[0];
    assertEq(content.mimeType, 'application/json', 'mimeType');
    const data = JSON.parse(content.text);
    assert(typeof data.cameras === 'object',   'cameras section present');
    assert(typeof data.alerts  === 'object',   'alerts section present');
    assert(typeof data.events  === 'object',   'events section present');
    assert(typeof data.cameras.total === 'number', 'cameras.total is number');
    assert(typeof data.alerts.active === 'number', 'alerts.active is number');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-MCP-01 — MCP Server Integration Tests       ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    await checkPrerequisites();
    await runGroupA();
    await runGroupD();
    await runGroupC();
    await runGroupB();
    await runGroupE();
    await runGroupF();
  } finally {
    stopMcpServer();
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────');

  if (failed > 0) {
    console.log('\nFailed tests:');
    results
      .filter(r => r.status === 'FAIL')
      .forEach(r => console.log(`  ✗ ${r.id}: ${r.description}\n      ${r.error}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  stopMcpServer();
  process.exit(1);
});
