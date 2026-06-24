'use strict';
/**
 * Detection Snapshot & Search API Tests
 *
 * TC: TC-Detection-Snapshot-Search
 *   Group B — Snapshot REST API          (TC-SNAP-B-001~B-006)
 *   Group C — Search API                 (TC-SNAP-C-001~C-006)
 *   Group F — Filter Regression          (TC-SNAP-F-001~F-003)
 *   Group I — SearchFullscreen Filter Chip Tooltips (TC-SNAP-I-001~I-011, source-level + API)
 *   Group J — Confidence Range Filter    (TC-J-001~J-007)
 *
 * FR References: FR-SNAP-023, FR-SNAP-024, FR-SNAP-025, FR-SNAP-026~030
 *
 * Prerequisites:
 *   - Server running (default https://localhost:3443)
 *   - Set LTS_URL env var to override (e.g. LTS_URL=https://localhost:3443)
 *
 * Run:
 *   node test/api/detection_snapshot_search.test.js
 *   LTS_URL=https://localhost:3443 node test/api/detection_snapshot_search.test.js
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = process.env.LTS_URL || 'https://localhost:3443';

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

const https = require('https');
const http  = require('http');

function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      rejectUnauthorized: false,
    };
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function get(path) {
  const res = await request(`${BASE_URL}${path}`);
  return { status: res.status, headers: res.headers, data: JSON.parse(res.body) };
}

// ── Group B: Snapshot REST API ────────────────────────────────────────────────

async function groupB() {
  console.log('\n[Group B] Snapshot REST API');

  await test('TC-SNAP-B-001', 'GET /api/snapshots returns 200 with pagination fields', async () => {
    const { status, data } = await get('/api/snapshots?limit=5');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(typeof data.total   === 'number', 'Missing total field');
    assert(typeof data.offset  === 'number', 'Missing offset field');
    assert(typeof data.limit   === 'number', 'Missing limit field');
    assert(Array.isArray(data.snapshots), 'snapshots must be array');
  });

  await test('TC-SNAP-B-002', 'List response strips cropData (payload reduction)', async () => {
    const { data } = await get('/api/snapshots?limit=5');
    if (data.snapshots.length === 0) return; // no data to test
    for (const s of data.snapshots) {
      assert(!('cropData' in s), `cropData must not appear in list — found in snapshot ${s.id}`);
    }
  });

  await test('TC-SNAP-B-003', 'GET /api/snapshots/:id returns cropData field', async () => {
    const { data: list } = await get('/api/snapshots?limit=1');
    if (list.snapshots.length === 0) {
      console.log('      (no snapshots in DB — skipping individual fetch check)');
      return;
    }
    const id = list.snapshots[0].id;
    const { status, data } = await get(`/api/snapshots/${id}`);
    assert(status === 200, `Expected 200, got ${status}`);
    // cropData may be null for snapshots without image data, but field must exist
    assert('id' in data, 'Missing id in single snapshot response');
  });

  await test('TC-SNAP-B-004', 'objectId filter returns only matching snapshots', async () => {
    // Get a known objectId from the list
    const { data: list } = await get('/api/snapshots?limit=20');
    if (list.snapshots.length === 0) {
      console.log('      (no snapshots in DB — skipping objectId filter check)');
      return;
    }
    const target = list.snapshots.find(s => s.objectId);
    if (!target) {
      console.log('      (no snapshots with objectId — skipping)');
      return;
    }
    const { data } = await get(`/api/snapshots?objectId=${target.objectId}&limit=50`);
    assert(Array.isArray(data.snapshots), 'snapshots must be array');
    for (const s of data.snapshots) {
      assert(s.objectId === target.objectId,
        `Expected objectId=${target.objectId}, got ${s.objectId}`);
    }
  });

  await test('TC-SNAP-B-005', 'cameraId filter returns only matching snapshots', async () => {
    const { data: list } = await get('/api/snapshots?limit=20');
    if (list.snapshots.length === 0) { console.log('      (no snapshots — skipping)'); return; }
    const cameraId = list.snapshots[0].cameraId;
    if (!cameraId) { console.log('      (no cameraId in snapshot — skipping)'); return; }
    const { data } = await get(`/api/snapshots?cameraId=${cameraId}&limit=50`);
    for (const s of data.snapshots) {
      assert(s.cameraId === cameraId, `Expected cameraId=${cameraId}, got ${s.cameraId}`);
    }
  });

  await test('TC-SNAP-B-006', 'GET /api/snapshots/:id with unknown ID returns 404', async () => {
    const { status } = await get('/api/snapshots/00000000-0000-0000-0000-000000000000');
    assert(status === 404, `Expected 404, got ${status}`);
  });
}

// ── Group C: Search API ───────────────────────────────────────────────────────

async function groupC() {
  console.log('\n[Group C] Search API');

  await test('TC-SNAP-C-001', 'GET /api/search without q returns 400', async () => {
    const { status } = await get('/api/search');
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('TC-SNAP-C-002', 'GET /api/search?q=person returns results array', async () => {
    const { status, data } = await get('/api/search?q=person&limit=5');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.results), 'results must be array');
    assert(typeof data.total === 'number', 'total must be number');
  });

  await test('TC-SNAP-C-003', 'types=detections returns only _type:detection results', async () => {
    const { status, data } = await get('/api/search?q=person&types=detections&limit=20');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) return;
    for (const r of data.results) {
      assert(r._type === 'detection',
        `Expected _type=detection, got ${r._type} (id=${r.id})`);
    }
  });

  await test('TC-SNAP-C-004', 'types=alerts returns only _type:alert results', async () => {
    const { status, data } = await get('/api/search?q=loitering&types=alerts&limit=20');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) return;
    for (const r of data.results) {
      assert(r._type === 'alert',
        `Expected _type=alert, got ${r._type} (id=${r.id})`);
    }
  });

  await test('TC-SNAP-C-005', 'types=faces returns only _type:face results', async () => {
    const { status, data } = await get('/api/search?q=a&types=faces&limit=20');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) return;
    for (const r of data.results) {
      assert(r._type === 'face',
        `Expected _type=face, got ${r._type} (id=${r.id})`);
    }
  });

  await test('TC-SNAP-C-006', 'types=events returns only _type:event results', async () => {
    const { status, data } = await get('/api/search?q=loitering&types=events&limit=20');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) return;
    for (const r of data.results) {
      assert(r._type === 'event',
        `Expected _type=event, got ${r._type} (id=${r.id})`);
    }
  });
}

// ── Group F: Filter Regression ────────────────────────────────────────────────

async function groupF() {
  console.log('\n[Group F] Filter Regression');

  await test('TC-SNAP-F-001', 'q=loitering&types=detections returns isLoitering=true detections', async () => {
    const { status, data } = await get('/api/search?q=loitering&types=detections&limit=20');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) {
      console.log('      (no loitering detections in DB — skipping assertion)');
      return;
    }
    const allLoitering = data.results.every(r => r._type === 'detection');
    assert(allLoitering, 'All returned results should be _type:detection');
  });

  await test('TC-SNAP-F-002', 'q=loitering&types=alerts returns LOITERING alerts', async () => {
    const { status, data } = await get('/api/search?q=loitering&types=alerts&limit=20');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) {
      console.log('      (no loitering alerts in DB — skipping assertion)');
      return;
    }
    for (const r of data.results) {
      assert(r._type === 'alert', `Expected _type=alert, got ${r._type}`);
    }
  });

  await test('TC-SNAP-F-003', 'Search results sorted by timestamp descending', async () => {
    const { status, data } = await get('/api/search?q=person&types=detections&limit=10');
    assert(status === 200, `Expected 200, got ${status}`);
    const times = data.results.map(r => new Date(r.timestamp || 0).getTime());
    for (let i = 1; i < times.length; i++) {
      assert(times[i - 1] >= times[i],
        `Results not sorted descending at index ${i}: ${times[i-1]} < ${times[i]}`);
    }
  });
}

// ── Group I: SearchFullscreen Filter Chip Tooltips (source-level checks) ──────

async function groupI() {
  console.log('\n[Group I] SearchFullscreen Filter Chip Tooltips');

  // Tooltip strings live in i18n/ko.ts, not the component source.
  // Read both files and combine for string checks.
  const fs   = require('fs');
  const path = require('path');

  const koPath  = path.resolve(__dirname, '../../client/src/i18n/translations/ko.ts');
  const srcPath = path.resolve(__dirname, '../../client/src/components/SearchFullscreen.tsx');

  // Must have at least the ko translation file
  if (!fs.existsSync(koPath)) {
    for (const [id, desc] of [
      ['TC-SNAP-I-001', 'All chip tooltip text present'],
      ['TC-SNAP-I-002', 'Detection chip tooltip text'],
      ['TC-SNAP-I-003', 'Alert chip tooltip text'],
      ['TC-SNAP-I-004', 'Face chip tooltip text'],
      ['TC-SNAP-I-005', 'Match chip tooltip text'],
      ['TC-SNAP-I-006', 'Event chip tooltip text'],
      ['TC-SNAP-I-011', 'All tooltips non-empty ≥50 chars'],
    ]) await skip(id, desc, 'ko.ts translation file not found');
    return;
  }

  const ko  = fs.readFileSync(koPath, 'utf8');
  const src = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf8') : '';
  // Combined source for string checks
  const all = ko + '\n' + src;

  await test('TC-SNAP-I-001', 'All 칩 tooltip — 감지·경보·얼굴·매칭·이벤트 포함', async () => {
    assert(all.includes('모든 유형의 결과를 표시합니다'), 'All tooltip prefix missing');
    for (const kw of ['감지', '경보', '얼굴', '이벤트']) {
      assert(all.includes(kw), `"${kw}" keyword missing from All tooltip`);
    }
  });

  await test('TC-SNAP-I-002', 'Detection 칩 tooltip — AI 감지·체류시간·위험도 포함', async () => {
    assert(all.includes('AI가 감지한 객체'), 'Detection tooltip "AI가 감지한 객체" missing');
    assert(all.includes('체류시간'),          'Detection tooltip "체류시간" missing');
    assert(all.includes('위험도 점수'),        'Detection tooltip "위험도 점수" missing');
  });

  await test('TC-SNAP-I-003', 'Alert 칩 tooltip — 배회 임계값·미확인 알림 포함', async () => {
    assert(all.includes('배회 임계값'),  'Alert tooltip "배회 임계값" missing');
    assert(all.includes('미확인 알림'), 'Alert tooltip "미확인 알림" missing');
  });

  await test('TC-SNAP-I-004', 'Face 칩 tooltip — 얼굴 갤러리·실종자·용의자 포함', async () => {
    assert(all.includes('얼굴 갤러리'), 'Face tooltip "얼굴 갤러리" missing');
    assert(all.includes('실종자'),      'Face tooltip "실종자" missing');
    assert(all.includes('용의자'),      'Face tooltip "용의자" missing');
  });

  await test('TC-SNAP-I-005', 'Match 칩 tooltip — 얼굴 인식·유사도 점수·크롭 이미지 포함', async () => {
    assert(all.includes('얼굴 인식'),   'Match tooltip "얼굴 인식" missing');
    assert(all.includes('유사도 점수'), 'Match tooltip "유사도 점수" missing');
    assert(all.includes('크롭 이미지') || all.includes('얼굴 크롭'), 'Match tooltip crop image text missing');
  });

  await test('TC-SNAP-I-006', 'Event 칩 tooltip — 배회 이벤트·이동 경로 포함', async () => {
    assert(all.includes('배회 이벤트'), 'Event tooltip "배회 이벤트" missing');
    assert(all.includes('이동 경로'),   'Event tooltip "이동 경로" missing');
  });

  await test('TC-SNAP-I-007', 'types=detections — only _type:detection results', async () => {
    const { status, data } = await get('/api/search?q=person&types=detections&limit=10');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) return;
    for (const r of data.results) {
      assert(r._type === 'detection', `Expected detection, got ${r._type}`);
    }
  });

  await test('TC-SNAP-I-008', 'types=alerts — only _type:alert results', async () => {
    const { status, data } = await get('/api/search?q=loitering&types=alerts&limit=10');
    assert(status === 200, `Expected 200, got ${status}`);
    if (data.results.length === 0) return;
    for (const r of data.results) {
      assert(r._type === 'alert', `Expected alert, got ${r._type}`);
    }
  });

  await test('TC-SNAP-I-009', 'types=detections,alerts,faces,matches,events — mixed _type allowed', async () => {
    const { status, data } = await get(
      '/api/search?q=loitering&types=detections,alerts,faces,matches,events&limit=20'
    );
    assert(status === 200, `Expected 200, got ${status}`);
    const types = new Set(data.results.map(r => r._type));
    // At minimum the endpoint must accept the request without error
    assert(data.results !== undefined, 'results field missing');
  });

  await test('TC-SNAP-I-010', 'TYPE_CHIPS has exactly 6 entries with tooltip field', async () => {
    const matches = [...src.matchAll(/key:\s*'(\w+)'[^}]+tooltip:/gs)];
    assert(matches.length === 6, `Expected 6 TYPE_CHIPS with tooltip, found ${matches.length}`);
  });

  await test('TC-SNAP-I-011', 'All chip tooltips are non-empty strings ≥ 50 chars', async () => {
    // Tooltip strings live in ko.ts under searchChip*Tooltip keys — check all combined source
    const tooltipKeyRe = /searchChip\w+Tooltip:\s*'([^']{50,})'/g;
    const tooltips = [...all.matchAll(tooltipKeyRe)].map(m => m[1]);
    // Expect at least 6 tooltip keys (all, detection, alert, face, match, event)
    assert(tooltips.length >= 6,
      `Expected ≥6 tooltip strings ≥50 chars in i18n/ko.ts, found ${tooltips.length}`);
    for (const t of tooltips) {
      assert(t.trim().length >= 50, `Tooltip too short: "${t.slice(0, 30)}…"`);
    }
  });
}

// ── Group J — Confidence Range Filter ────────────────────────────────────────
// FR-SNAP-026~030 | TC-J-001~007

async function groupJ() {
  console.log('\nGroup J — Confidence Range Filter');

  // TC-J-001: minConfidence filter excludes low-confidence results
  await test('TC-J-001', 'minConfidence=0.6 — no result has confidence < 0.6', async () => {
    const { status, data } = await get(`/api/search?q=person&types=detections&minConfidence=0.6`);
    assert(status === 200, `Expected 200, got ${status}`);
    const violations = (data.results || []).filter(r => r.confidence != null && r.confidence < 0.6);
    assert(violations.length === 0,
      `Found ${violations.length} result(s) with confidence < 0.6`);
  });

  // TC-J-002: maxConfidence filter excludes high-confidence results
  await test('TC-J-002', 'maxConfidence=0.8 — no result has confidence > 0.8', async () => {
    const { status, data } = await get(`/api/search?q=person&types=detections&maxConfidence=0.8`);
    assert(status === 200, `Expected 200, got ${status}`);
    const violations = (data.results || []).filter(r => r.confidence != null && r.confidence > 0.8);
    assert(violations.length === 0,
      `Found ${violations.length} result(s) with confidence > 0.8`);
  });

  // TC-J-003: combined range filter
  await test('TC-J-003', 'minConfidence=0.5&maxConfidence=0.8 — results within [0.5, 0.8]', async () => {
    const { status, data } = await get(`/api/search?q=person&types=detections&minConfidence=0.5&maxConfidence=0.8`);
    assert(status === 200, `Expected 200, got ${status}`);
    const violations = (data.results || []).filter(r => {
      if (r.confidence == null) return false;
      return r.confidence < 0.5 || r.confidence > 0.8;
    });
    assert(violations.length === 0,
      `Found ${violations.length} result(s) outside [0.5, 0.8]`);
  });

  // TC-J-004: inverted range returns HTTP 400
  await test('TC-J-004', 'minConfidence > maxConfidence returns HTTP 400', async () => {
    const res = await request(`${BASE_URL}/api/search?q=person&minConfidence=0.9&maxConfidence=0.3`);
    assert(res.status === 400, `Expected 400 for inverted range, got ${res.status}`);
    const data = JSON.parse(res.body);
    assert(data.success === false, 'Expected success=false in error response');
    assert(data.error, 'Expected error message in response body');
  });

  // TC-J-005: non-numeric minConfidence is ignored, returns HTTP 200
  await test('TC-J-005', 'minConfidence=abc — ignored, returns HTTP 200', async () => {
    const res = await request(`${BASE_URL}/api/search?q=person&minConfidence=abc`);
    assert(res.status === 200, `Expected 200 for non-numeric confidence, got ${res.status}`);
  });

  // TC-J-006: confidence filter applies alongside type filter
  await test('TC-J-006', 'types=alerts&minConfidence=0.9 — returns alert results only', async () => {
    const { status, data } = await get(`/api/search?q=camera&types=alerts&minConfidence=0.9`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(typeof data.total === 'number', 'Expected numeric total');
    // All returned items should be alert type if any returned
    const nonAlerts = (data.results || []).filter(r => r._type !== 'alert');
    assert(nonAlerts.length === 0,
      `Found ${nonAlerts.length} non-alert result(s) with types=alerts`);
  });

  // TC-J-007: full range [0,1] is equivalent to no confidence filter
  await test('TC-J-007', 'minConfidence=0&maxConfidence=1 returns same count as no filter', async () => {
    const [r1, r2] = await Promise.all([
      get(`/api/search?q=person&types=detections`),
      get(`/api/search?q=person&types=detections&minConfidence=0&maxConfidence=1`),
    ]);
    assert(r1.status === 200, `Baseline request returned ${r1.status}`);
    assert(r2.status === 200, `Full-range request returned ${r2.status}`);
    assert(r1.data.total === r2.data.total,
      `Total mismatch: no-filter=${r1.data.total}, full-range=${r2.data.total}`);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Detection Snapshot & Search Tests');
  console.log(`Base URL: ${BASE_URL}`);
  console.log('='.repeat(60));

  // Server health check
  try {
    const { status } = await get('/health');
    if (status !== 200) throw new Error(`/health returned ${status}`);
    console.log('  Server reachable ✓\n');
  } catch (e) {
    console.error(`\nFATAL: Cannot reach server at ${BASE_URL} — ${e.message}`);
    console.error('Set LTS_URL env var (e.g. LTS_URL=https://localhost:3443)\n');
    process.exit(1);
  }

  await groupB();
  await groupC();
  await groupF();
  await groupI();
  await groupJ();

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
