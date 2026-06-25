'use strict';
/**
 * MCP Server Extended Integration Tests
 * TC: TC-LTS-MCP-02 Groups J~N
 * SRS: FR-MCP-070 ~ FR-MCP-120
 *
 * Tests new MCP tools added in v1.1:
 *   Group J — System tools (get_server_status)
 *   Group K — Camera CRUD (add_camera, update_camera, delete_camera, toggle_camera_ai)
 *   Group L — ONVIF Events (query_onvif_events, get_onvif_event_types)
 *   Group M — AI Detection tools (query_analysis_events, get_detection_tracks, get_analysis_metrics)
 *   Group N — Schema catalog completeness check
 *
 * Prerequisites:
 *   - LTS server running on LTS_URL (default http://localhost:3080)
 *
 * Run: node test/api/mcp_server_extended.test.js
 */

const path = require('path');

const BASE_URL = process.env.LTS_URL  || 'http://localhost:3080';
const MCP_DIR  = path.resolve(__dirname, '../../mcp-server');

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

function skipTest(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description} (skipped — ${reason})`);
  results.push({ id, description, status: 'SKIP' });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpGet(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  return { status: res.status, body: text, json: () => JSON.parse(text) };
}

// ── Mock MCP server for unit testing tool handlers ───────────────────────────

class MockMcpServer {
  constructor() {
    this.tools = {};
    this.resources = {};
  }
  tool(name, _desc, _schema, handler) { this.tools[name] = handler; }
  resource(name, _template, _meta, handler) { this.resources[name] = handler; }
}

// ── Dynamic import of ESM modules ────────────────────────────────────────────

let LTSClient, registerSystemTools, registerOnvifTools, registerDetectionTools, registerCameraTools, TOOL_CATALOG;

async function loadModules() {
  const ltsClientMod   = await import(`file://${MCP_DIR}/lts-client.js`);
  const systemMod      = await import(`file://${MCP_DIR}/tools/system.js`);
  const onvifMod       = await import(`file://${MCP_DIR}/tools/onvif.js`);
  const detectionsMod  = await import(`file://${MCP_DIR}/tools/detections.js`);
  const camerasMod     = await import(`file://${MCP_DIR}/tools/cameras.js`);
  const serverMod      = await import(`file://${MCP_DIR}/create-server.js`);

  LTSClient              = ltsClientMod.LTSClient;
  registerSystemTools    = systemMod.registerSystemTools;
  registerOnvifTools     = onvifMod.registerOnvifTools;
  registerDetectionTools = detectionsMod.registerDetectionTools;
  registerCameraTools    = camerasMod.registerCameraTools;
  TOOL_CATALOG           = serverMod.TOOL_CATALOG;
}

// ── Prerequisites check ──────────────────────────────────────────────────────

async function checkPrerequisites() {
  console.log('\n[Prerequisites]\n');
  const res = await httpGet(`${BASE_URL}/health`);
  assert(res.status === 200, `LTS server not responding: ${BASE_URL}/health → HTTP ${res.status}`);
  const health = res.json();
  console.log(`  LTS server: ${health.status || 'ok'} (mode: ${health.mode || 'N/A'})`);
}

// ── Group J — System Tools ────────────────────────────────────────────────────

async function runGroupJ() {
  console.log('\n[Group J] System Tools\n');

  const srv    = new MockMcpServer();
  const client = new LTSClient(BASE_URL);
  registerSystemTools(srv, client);

  await test('TC-J-001', 'get_server_status — returns status text with Mode field', async () => {
    const result = await srv.tools.get_server_status({ includeMetrics: false });
    assert(Array.isArray(result.content), 'content is array');
    const text = result.content[0].text;
    assert(text.length > 0, 'text non-empty');
    assert(/Status|Mode|Uptime/i.test(text), `Expected status fields in text: ${text.slice(0, 100)}`);
  });

  await test('TC-J-002', 'get_server_status — includeMetrics:true returns metrics section', async () => {
    const result = await srv.tools.get_server_status({ includeMetrics: true });
    const text = result.content[0].text;
    assert(
      /Metrics|Memory|CPU|admin access/i.test(text),
      `Expected metrics or fallback in text: ${text.slice(0, 200)}`
    );
  });

  await test('TC-J-003', 'get_server_status — isError not set on success', async () => {
    const result = await srv.tools.get_server_status({});
    assert(!result.isError, 'isError should not be set');
  });
}

// ── Group K — Camera CRUD ─────────────────────────────────────────────────────

async function runGroupK() {
  console.log('\n[Group K] Camera CRUD Tools\n');

  const srv    = new MockMcpServer();
  const client = new LTSClient(BASE_URL);
  registerCameraTools(srv, client);

  let createdCameraId = null;

  await test('TC-K-001', 'add_camera — adds a camera and returns ID', async () => {
    const result = await srv.tools.add_camera({
      name: '[MCP-TEST] temp-cam-ext',
      url:  'rtsp://192.0.2.1:554/test',
      type: 'rtsp',
      aiEnabled: false,
    });
    assert(!result.isError, `add_camera failed: ${result.content[0]?.text}`);
    const text = result.content[0].text;
    const idMatch = text.match(/ID\s*:\s*([a-f0-9-]{8,})/i);
    assert(idMatch, `Expected camera ID in response: ${text}`);
    createdCameraId = idMatch[1];
    console.log(`      Created camera: ${createdCameraId}`);
  });

  await test('TC-K-002', 'update_camera — updates name and returns success', async () => {
    if (!createdCameraId) { skipTest('TC-K-002', 'update_camera', 'no camera from TC-K-001'); return; }
    const result = await srv.tools.update_camera({
      cameraId: createdCameraId,
      name: '[MCP-TEST] renamed-cam',
    });
    assert(!result.isError, `update_camera failed: ${result.content[0]?.text}`);
  });

  await test('TC-K-003', 'toggle_camera_ai — toggles AI flag', async () => {
    if (!createdCameraId) { skipTest('TC-K-003', 'toggle_camera_ai', 'no camera from TC-K-001'); return; }
    const result = await srv.tools.toggle_camera_ai({ cameraId: createdCameraId, enabled: true });
    assert(!result.isError, `toggle_camera_ai failed: ${result.content[0]?.text}`);
    assert(/enabled|disabled/i.test(result.content[0].text), 'Expected enabled/disabled in response');
  });

  await test('TC-K-004', 'delete_camera — deletes created camera', async () => {
    if (!createdCameraId) { skipTest('TC-K-004', 'delete_camera', 'no camera from TC-K-001'); return; }
    const result = await srv.tools.delete_camera({ cameraId: createdCameraId });
    assert(!result.isError, `delete_camera failed: ${result.content[0]?.text}`);
    createdCameraId = null;
  });

  await test('TC-K-005', 'delete_camera — returns error for nonexistent ID', async () => {
    const result = await srv.tools.delete_camera({ cameraId: 'nonexistent-cam-00000000' });
    assert(result.isError || /error|not found/i.test(result.content[0]?.text || ''), 'Expected error for nonexistent camera');
  });

  await test('TC-K-006', 'update_camera — no-op when no fields provided', async () => {
    const result = await srv.tools.update_camera({ cameraId: 'any-id' });
    assert(/No fields/i.test(result.content[0]?.text || ''), 'Expected "No fields to update" message');
  });
}

// ── Group L — ONVIF Event Tools ───────────────────────────────────────────────

async function runGroupL() {
  console.log('\n[Group L] ONVIF Event Tools\n');

  const srv    = new MockMcpServer();
  const client = new LTSClient(BASE_URL);
  registerOnvifTools(srv, client);

  await test('TC-L-001', 'query_onvif_events — returns text content', async () => {
    const result = await srv.tools.query_onvif_events({ limit: 10 });
    assert(Array.isArray(result.content), 'content is array');
    assert(typeof result.content[0].text === 'string', 'text is string');
  });

  await test('TC-L-002', 'query_onvif_events — type filter accepted', async () => {
    const result = await srv.tools.query_onvif_events({ type: 'motionAlarm', limit: 5 });
    assert(!result.isError, `Tool returned error: ${result.content[0]?.text}`);
  });

  await test('TC-L-003', 'query_onvif_events — time range filter accepted', async () => {
    const to   = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const result = await srv.tools.query_onvif_events({ from, to, limit: 10 });
    assert(!result.isError, `Tool returned error: ${result.content[0]?.text}`);
  });

  await test('TC-L-004', 'get_onvif_event_types — returns text content', async () => {
    const result = await srv.tools.get_onvif_event_types({});
    assert(Array.isArray(result.content), 'content is array');
    assert(typeof result.content[0].text === 'string', 'text is string');
  });

  await test('TC-L-005', 'query_onvif_events — ruleName filter accepted (no crash on miss)', async () => {
    const result = await srv.tools.query_onvif_events({ ruleName: '__no_such_rule__', limit: 20 });
    assert(!result.isError, `Tool returned error: ${result.content[0]?.text}`);
  });
}

// ── Group M — AI Detection Tools ──────────────────────────────────────────────

async function runGroupM() {
  console.log('\n[Group M] AI Detection Tools\n');

  const srv    = new MockMcpServer();
  const client = new LTSClient(BASE_URL);
  registerDetectionTools(srv, client);

  await test('TC-M-001', 'query_analysis_events — returns text content', async () => {
    const result = await srv.tools.query_analysis_events({ limit: 10 });
    assert(Array.isArray(result.content), 'content is array');
    assert(typeof result.content[0].text === 'string', 'text is string');
  });

  await test('TC-M-002', 'query_analysis_events — type=loitering filter accepted', async () => {
    const result = await srv.tools.query_analysis_events({ type: 'loitering', limit: 10 });
    assert(!result.isError, `Tool returned error: ${result.content[0]?.text}`);
  });

  await test('TC-M-003', 'query_analysis_events — type=fire filter accepted', async () => {
    const result = await srv.tools.query_analysis_events({ type: 'fire', limit: 10 });
    assert(!result.isError, `Tool returned error: ${result.content[0]?.text}`);
  });

  await test('TC-M-004', 'get_detection_tracks — returns text content', async () => {
    const result = await srv.tools.get_detection_tracks({ limit: 10 });
    assert(Array.isArray(result.content), 'content is array');
    assert(typeof result.content[0].text === 'string', 'text is string');
  });

  await test('TC-M-005', 'get_detection_tracks — inProgressOnly filter accepted', async () => {
    const result = await srv.tools.get_detection_tracks({ inProgressOnly: true, limit: 10 });
    assert(!result.isError, `Tool returned error: ${result.content[0]?.text}`);
  });

  await test('TC-M-006', 'get_analysis_metrics — returns text with status or graceful error', async () => {
    const result = await srv.tools.get_analysis_metrics({});
    assert(Array.isArray(result.content), 'content is array');
    assert(typeof result.content[0].text === 'string', 'text is string');
  });
}

// ── Group N — TOOL_CATALOG completeness ───────────────────────────────────────

async function runGroupN() {
  console.log('\n[Group N] TOOL_CATALOG completeness\n');

  const expectedTools = [
    'get_server_status',
    'add_camera', 'update_camera', 'delete_camera', 'toggle_camera_ai',
    'query_onvif_events', 'get_onvif_event_types',
    'query_analysis_events', 'get_detection_tracks', 'get_analysis_metrics',
    'query_loitering_events', 'get_active_alerts', 'acknowledge_alert',
    'get_analytics_summary', 'generate_security_report',
  ];

  const catalogNames = new Set(TOOL_CATALOG.map(t => t.name));

  for (const toolName of expectedTools) {
    await test(`TC-N-${toolName}`, `TOOL_CATALOG includes '${toolName}'`, () => {
      assert(catalogNames.has(toolName), `Missing from TOOL_CATALOG: ${toolName}`);
    });
  }

  await test('TC-N-access-tags', 'All TOOL_CATALOG entries have access tag (read|write)', () => {
    for (const entry of TOOL_CATALOG) {
      assert(
        entry.access === 'read' || entry.access === 'write',
        `${entry.name} missing access tag`
      );
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-MCP-02 — MCP Server Extended Tests (v1.1)        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  await loadModules();
  await checkPrerequisites();
  await runGroupJ();
  await runGroupK();
  await runGroupL();
  await runGroupM();
  await runGroupN();

  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────────');

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL')
      .forEach(r => console.log(`  ✗ ${r.id}: ${r.description}\n      ${r.error}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
