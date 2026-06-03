'use strict';
/**
 * Stats Dashboard Panel — API Tests
 * TC: TC_Stats_Panel.md (Groups A–G)
 * Endpoint: GET /api/stats
 *
 * Groups H (frontend/E2E) are Phase-3 tests → test/e2e/dashboard_e2e.test.js
 *
 * Run: node test/api/stats_panel.test.js
 * Or:  npx jest test/api/stats_panel.test.js
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

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

async function get(path) {
  const res  = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

async function post(path, body = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── Test camera helpers ───────────────────────────────────────────────────────

let createdCameraIds = [];
let createdZoneIds   = [];
let createdAlertIds  = [];

async function createCamera(overrides = {}) {
  const payload = {
    name:   overrides.name   || `StatsTestCam-${Date.now()}`,
    rtspUrl: overrides.rtspUrl || 'rtsp://test.invalid/stream',
    status: overrides.status || 'stopped',
    type:   overrides.type   || 'rtsp',
    aiEnabled: overrides.aiEnabled ?? false,
    ...overrides,
  };
  const res  = await fetch(`${BASE_URL}/api/cameras`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const body = await res.json();
  const id   = body.data?.id || body.id;
  if (id) createdCameraIds.push(id);
  return { status: res.status, body, id };
}

async function createZone(cameraId, overrides = {}) {
  const payload = {
    name:            overrides.name || `Zone-${Date.now()}`,
    type:            overrides.type || 'MONITOR',
    dwellThreshold:  10,
    vertices:        [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }],
    ...overrides,
  };
  const res  = await fetch(`${BASE_URL}/api/cameras/${cameraId}/zones`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const body = await res.json();
  const id   = body.data?.id || body.id;
  if (id) createdZoneIds.push({ cameraId, zoneId: id });
  return { status: res.status, body, id };
}

// ── Cleanup helper ────────────────────────────────────────────────────────────

async function cleanup() {
  for (const { cameraId, zoneId } of createdZoneIds) {
    await fetch(`${BASE_URL}/api/cameras/${cameraId}/zones/${zoneId}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of createdCameraIds) {
    await fetch(`${BASE_URL}/api/cameras/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  createdCameraIds = [];
  createdZoneIds   = [];
  createdAlertIds  = [];
}

// ════════════════════════════════════════════════════════════════════════════════
// GROUP A — API Basic Response
// ════════════════════════════════════════════════════════════════════════════════
async function groupA() {
  console.log('\nGroup A — API Basic Response');

  await test('TC-STATS-001-A01', 'GET /api/stats returns HTTP 200 with success:true', async () => {
    const { status, body } = await get('/api/stats');
    assertEq(status, 200, 'HTTP status');
    assertEq(body.success, true, 'body.success');
    assert(typeof body.data === 'object', 'body.data must be object');
  });

  await test('TC-STATS-001-A02', 'Response contains all required top-level keys', async () => {
    const { body } = await get('/api/stats');
    const required = ['generatedAt', 'storage', 'cameras', 'zones', 'events', 'alerts', 'faces'];
    for (const k of required) {
      assert(k in body.data, `Missing key: data.${k}`);
    }
  });

  await test('TC-STATS-001-A03', 'generatedAt is valid ISO 8601 string', async () => {
    const { body } = await get('/api/stats');
    const ts = new Date(body.data.generatedAt);
    assert(!isNaN(ts.getTime()), `generatedAt is not a valid date: ${body.data.generatedAt}`);
    assert(body.data.generatedAt.includes('T'), 'generatedAt should be ISO format with T');
  });

  await test('TC-STATS-001-A04', 'storage.mode is a string (json or mongodb)', async () => {
    const { body } = await get('/api/stats');
    assert(typeof body.data.storage.mode === 'string', 'storage.mode must be a string');
    assert(['json', 'mongodb'].includes(body.data.storage.mode),
      `storage.mode should be json or mongodb, got: ${body.data.storage.mode}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// GROUP B — Camera Stats
// ════════════════════════════════════════════════════════════════════════════════
async function groupB() {
  console.log('\nGroup B — Camera Stats');

  await test('TC-STATS-001-B01', 'cameras section has required sub-keys', async () => {
    const { body } = await get('/api/stats');
    const c = body.data.cameras;
    assert(typeof c.total === 'number', 'cameras.total must be number');
    assert(typeof c.byStatus === 'object', 'cameras.byStatus must be object');
    assert(typeof c.byType   === 'object', 'cameras.byType must be object');
    assert(typeof c.aiEnabled === 'number', 'cameras.aiEnabled must be number');
    ['streaming', 'stopped', 'error', 'connecting'].forEach(k => {
      assert(k in c.byStatus, `cameras.byStatus.${k} missing`);
    });
  });

  await test('TC-STATS-001-B02', 'cameras.total reflects created cameras', async () => {
    const before = (await get('/api/stats')).body.data.cameras.total;
    const { id } = await createCamera({ name: 'B02-cam', status: 'stopped' });
    if (!id) { console.warn('    (camera creation unsupported — skipping count check)'); return; }
    const after = (await get('/api/stats')).body.data.cameras.total;
    assert(after >= before + 1, `Expected total to increase by at least 1 (was ${before}, got ${after})`);
  });

  await test('TC-STATS-001-B03', 'streaming cameras counted in byStatus.streaming', async () => {
    const { id } = await createCamera({ name: 'B03-cam', status: 'live' });
    if (!id) { console.warn('    (skipping — camera creation not available)'); return; }
    const { body } = await get('/api/stats');
    assert(body.data.cameras.byStatus.streaming >= 1,
      `Expected streaming >= 1, got ${body.data.cameras.byStatus.streaming}`);
  });

  await test('TC-STATS-001-B04', 'youtube cameras counted in byType.youtube', async () => {
    const { id } = await createCamera({ name: 'B04-yt', type: 'youtube', status: 'stopped' });
    if (!id) { console.warn('    (skipping — camera creation not available)'); return; }
    const { body } = await get('/api/stats');
    assert(body.data.cameras.byType.youtube >= 1,
      `Expected byType.youtube >= 1, got ${body.data.cameras.byType.youtube}`);
  });

  await test('TC-STATS-001-B05', 'byStatus counts are all non-negative integers', async () => {
    const { body } = await get('/api/stats');
    const bs = body.data.cameras.byStatus;
    for (const [k, v] of Object.entries(bs)) {
      assert(Number.isInteger(v) && v >= 0, `byStatus.${k} must be non-negative integer, got ${v}`);
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// GROUP C — Zone Stats
// ════════════════════════════════════════════════════════════════════════════════
async function groupC() {
  console.log('\nGroup C — Zone Stats');

  await test('TC-STATS-001-C01', 'zones section has required sub-keys', async () => {
    const { body } = await get('/api/stats');
    const z = body.data.zones;
    assert(typeof z.total === 'number',  'zones.total must be number');
    assert(typeof z.byType === 'object', 'zones.byType must be object');
    assert(Array.isArray(z.byCamera),    'zones.byCamera must be array');
    assert('MONITOR' in z.byType, 'zones.byType.MONITOR missing');
    assert('EXCLUDE' in z.byType, 'zones.byType.EXCLUDE missing');
  });

  await test('TC-STATS-001-C02', 'MONITOR and EXCLUDE counts sum to zones.total', async () => {
    const { body } = await get('/api/stats');
    const z = body.data.zones;
    assertEq(z.byType.MONITOR + z.byType.EXCLUDE, z.total, 'MONITOR + EXCLUDE === total');
  });

  await test('TC-STATS-001-C03', 'byCamera array items have cameraId, cameraName, count', async () => {
    const { body } = await get('/api/stats');
    const { byCamera } = body.data.zones;
    for (const item of byCamera) {
      assert(typeof item.cameraId   === 'string', 'byCamera item.cameraId must be string');
      assert(typeof item.cameraName === 'string', 'byCamera item.cameraName must be string');
      assert(typeof item.count      === 'number', 'byCamera item.count must be number');
    }
  });

  await test('TC-STATS-001-C04', 'byCamera has at most 10 entries', async () => {
    const { body } = await get('/api/stats');
    assert(body.data.zones.byCamera.length <= 10,
      `byCamera should have max 10 entries, got ${body.data.zones.byCamera.length}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// GROUP D — Events Stats
// ════════════════════════════════════════════════════════════════════════════════
async function groupD() {
  console.log('\nGroup D — Events Stats');

  await test('TC-STATS-001-D01', 'events section has required sub-keys', async () => {
    const { body } = await get('/api/stats');
    const e = body.data.events;
    assert(typeof e.total     === 'number', 'events.total must be number');
    assert(typeof e.today     === 'number', 'events.today must be number');
    assert(typeof e.loitering === 'number', 'events.loitering must be number');
    assert(Array.isArray(e.last7days),      'events.last7days must be array');
  });

  await test('TC-STATS-001-D04', 'last7days has exactly 7 entries', async () => {
    const { body } = await get('/api/stats');
    assertEq(body.data.events.last7days.length, 7, 'last7days.length');
  });

  await test('TC-STATS-001-D05', 'last7days entries are in ascending date order', async () => {
    const { body } = await get('/api/stats');
    const days = body.data.events.last7days;
    for (let i = 1; i < days.length; i++) {
      assert(days[i].date >= days[i - 1].date,
        `last7days not sorted: ${days[i - 1].date} > ${days[i].date}`);
    }
  });

  await test('TC-STATS-001-D06', 'last7days dates match YYYY-MM-DD format', async () => {
    const { body } = await get('/api/stats');
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    for (const d of body.data.events.last7days) {
      assert(typeof d.date === 'string' && ISO_DATE.test(d.date),
        `date "${d.date}" doesn't match YYYY-MM-DD`);
      assert(typeof d.count === 'number', `count "${d.count}" must be a number`);
    }
  });

  await test('TC-STATS-001-D07', 'events.today is <= events.total', async () => {
    const { body } = await get('/api/stats');
    assert(body.data.events.today <= body.data.events.total,
      `today (${body.data.events.today}) must be <= total (${body.data.events.total})`);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// GROUP E — Alerts Stats
// ════════════════════════════════════════════════════════════════════════════════
async function groupE() {
  console.log('\nGroup E — Alerts Stats');

  await test('TC-STATS-001-E01', 'alerts section has required sub-keys', async () => {
    const { body } = await get('/api/stats');
    const a = body.data.alerts;
    assert(typeof a.total          === 'number', 'alerts.total must be number');
    assert(typeof a.unacknowledged === 'number', 'alerts.unacknowledged must be number');
    assert(typeof a.today          === 'number', 'alerts.today must be number');
    assert(typeof a.bySeverity     === 'object', 'alerts.bySeverity must be object');
    ['HIGH', 'MEDIUM', 'LOW'].forEach(k => {
      assert(k in a.bySeverity, `alerts.bySeverity.${k} missing`);
    });
  });

  await test('TC-STATS-001-E04', 'bySeverity counts sum to alerts.total', async () => {
    const { body } = await get('/api/stats');
    const a = body.data.alerts;
    const severitySum = a.bySeverity.HIGH + a.bySeverity.MEDIUM + a.bySeverity.LOW;
    assertEq(severitySum, a.total, 'HIGH + MEDIUM + LOW === alerts.total');
  });

  await test('TC-STATS-001-E05', 'unacknowledged is <= total', async () => {
    const { body } = await get('/api/stats');
    const a = body.data.alerts;
    assert(a.unacknowledged <= a.total,
      `unacknowledged (${a.unacknowledged}) must be <= total (${a.total})`);
  });

  await test('TC-STATS-001-E06', 'today is <= total', async () => {
    const { body } = await get('/api/stats');
    const a = body.data.alerts;
    assert(a.today <= a.total,
      `alerts.today (${a.today}) must be <= total (${a.total})`);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// GROUP F — Face ID Stats
// ════════════════════════════════════════════════════════════════════════════════
async function groupF() {
  console.log('\nGroup F — Face ID Stats');

  await test('TC-STATS-001-F01', 'faces section has galleries and enrolled keys', async () => {
    const { body } = await get('/api/stats');
    const f = body.data.faces;
    assert(typeof f.galleries === 'number', 'faces.galleries must be number');
    assert(typeof f.enrolled  === 'number', 'faces.enrolled must be number');
  });

  await test('TC-STATS-001-F02', 'enrolled is non-negative', async () => {
    const { body } = await get('/api/stats');
    assert(body.data.faces.enrolled >= 0,
      `faces.enrolled must be >= 0, got ${body.data.faces.enrolled}`);
  });

  await test('TC-STATS-001-F03', 'galleries is non-negative', async () => {
    const { body } = await get('/api/stats');
    assert(body.data.faces.galleries >= 0,
      `faces.galleries must be >= 0, got ${body.data.faces.galleries}`);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// GROUP G — Error Handling
// ════════════════════════════════════════════════════════════════════════════════
async function groupG() {
  console.log('\nGroup G — Error Handling & Response Headers');

  await test('TC-STATS-001-G02', 'Content-Type is application/json', async () => {
    const { headers } = await get('/api/stats');
    const ct = headers.get('content-type') || '';
    assert(ct.includes('application/json'), `Content-Type should be application/json, got: ${ct}`);
  });

  await test('TC-STATS-001-G03', 'all numeric values are non-negative', async () => {
    const { body } = await get('/api/stats');
    const d = body.data;

    // Cameras
    const camNums = [
      d.cameras.total, d.cameras.aiEnabled,
      d.cameras.byStatus.streaming, d.cameras.byStatus.stopped,
      d.cameras.byStatus.error, d.cameras.byStatus.connecting,
      d.cameras.byType.rtsp, d.cameras.byType.youtube,
    ];
    for (const n of camNums) {
      assert(n >= 0, `Camera stat value is negative: ${n}`);
    }

    // Zones
    assert(d.zones.total >= 0, 'zones.total negative');
    assert(d.zones.byType.MONITOR >= 0, 'zones.byType.MONITOR negative');
    assert(d.zones.byType.EXCLUDE >= 0, 'zones.byType.EXCLUDE negative');

    // Events
    assert(d.events.total >= 0, 'events.total negative');
    assert(d.events.today >= 0, 'events.today negative');
    assert(d.events.loitering >= 0, 'events.loitering negative');

    // Alerts
    assert(d.alerts.total >= 0, 'alerts.total negative');
    assert(d.alerts.unacknowledged >= 0, 'alerts.unacknowledged negative');

    // Faces
    assert(d.faces.galleries >= 0, 'faces.galleries negative');
    assert(d.faces.enrolled  >= 0, 'faces.enrolled negative');
  });

  await test('TC-STATS-001-G04', 'consecutive calls return consistent data shapes', async () => {
    const r1 = (await get('/api/stats')).body;
    const r2 = (await get('/api/stats')).body;
    // Both should succeed
    assert(r1.success, 'First call should succeed');
    assert(r2.success, 'Second call should succeed');
    // Structure should be the same
    const keys1 = Object.keys(r1.data).sort().join(',');
    const keys2 = Object.keys(r2.data).sort().join(',');
    assertEq(keys1, keys2, 'Top-level data keys should match across calls');
  });

  skip('TC-STATS-001-G01', 'Internal error returns HTTP 500 with success:false',
    'Requires server-side injection — covered by unit tests');
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('=================================================================');
  console.log('Stats Dashboard Panel — API Test Suite');
  console.log(`Target: ${BASE_URL}`);
  console.log('=================================================================');

  try {
    // Verify server is reachable
    await fetch(`${BASE_URL}/api/stats`);
  } catch {
    console.error('\n[ERROR] Cannot connect to server at', BASE_URL);
    console.error('Start the server first: cd server && npm run dev\n');
    process.exit(1);
  }

  await groupA();
  await groupB();
  await groupC();
  await groupD();
  await groupE();
  await groupF();
  await groupG();

  // Cleanup test data
  await cleanup();

  // Summary
  console.log('\n=================================================================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.filter(r => r.status === 'SKIP').length} skipped`);
  console.log('=================================================================');

  if (failed > 0) {
    console.error('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.error(`  ✗ ${r.id}: ${r.description}`);
      if (r.error) console.error(`      ${r.error}`);
    });
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
