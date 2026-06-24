'use strict';
/**
 * TC-TIMELINE-RANGE-001 ~ TC-TIMELINE-RANGE-008 — 타임라인 1H 범위 API 테스트
 *
 * streamingOnly: Streaming Server 모드에서만 실행 (카메라 캡처 + ONVIF 파이프라인 필요)
 *
 *   TC-TIMELINE-RANGE-001  ONVIF 이벤트 API: 1H 범위(from) 파라미터 처리
 *   TC-TIMELINE-RANGE-002  ONVIF 이벤트 API: from 파라미터 없이 전체 조회 가능
 *   TC-TIMELINE-RANGE-003  ONVIF 이벤트 API: cameraId + 1H 범위 조합 필터
 *   TC-TIMELINE-RANGE-004  ONVIF 이벤트 API: to 파라미터 미래 시간 경계 처리
 *   TC-TIMELINE-RANGE-005  Detection tracks API: 1H 범위(from) 파라미터 처리
 *   TC-TIMELINE-RANGE-006  Detection tracks API: from 파라미터 없이 전체 조회 가능
 *   TC-TIMELINE-RANGE-007  Detection tracks API: cameraId + 1H 범위 조합 필터
 *   TC-TIMELINE-RANGE-008  ONVIF 이벤트 API: 6H 범위 — from 경계 값 검증
 *
 * Run: node test/api/timeline_range.test.js
 *
 * Related SRS:    docs/srs/SRS_ONVIF_Metadata_Pipeline.md  (FR-ONVIF-RANGE-001~005)
 *                 docs/srs/SRS_Fullscreen_Camera_View.md   (FR-FULLSCREEN-TIMELINE-001~003)
 * Related TC doc: docs/tc/TC_ONVIF_Metadata_Pipeline.md
 *                 docs/tc/TC_Fullscreen_Camera_View.md
 * Related PRD:    docs/prd/PRD_ONVIF_Metadata_Pipeline.md
 * Related RFP:    docs/rfp/RFP_ONVIF_Metadata_Pipeline.md
 */

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';

// ── Test harness ─────────────────────────────────────────────────────────────

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowMinus(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const MS_1H = 60 * 60 * 1000;
const MS_6H = 6 * MS_1H;

// ── TC-TIMELINE-RANGE-001: ONVIF events API 1H range ─────────────────────────

console.log('\n── Timeline 1H Range Tests ──────────────────────────────────────');

await test('TC-TIMELINE-RANGE-001', 'ONVIF 이벤트 API: 1H from 파라미터 수신 → 200 + total 반환', async () => {
  const from = nowMinus(MS_1H);
  const { status, body } = await get(`/api/onvif-events?from=${encodeURIComponent(from)}&limit=1000`);
  assert(status === 200, `HTTP ${status}`);
  assert(typeof body.total === 'number', `total not number: ${JSON.stringify(body)}`);
  assert(Array.isArray(body.events), 'events not array');
  // All returned events must be at or after the from timestamp
  for (const e of body.events) {
    assert(e.serverTs >= from, `Event ${e.id} serverTs=${e.serverTs} is before from=${from}`);
  }
});

// ── TC-TIMELINE-RANGE-002: ONVIF events API no from param ────────────────────

await test('TC-TIMELINE-RANGE-002', 'ONVIF 이벤트 API: from 없이 전체 조회 → 200 + events array', async () => {
  const { status, body } = await get('/api/onvif-events?limit=10');
  assert(status === 200, `HTTP ${status}`);
  assert(typeof body.total === 'number', 'total not number');
  assert(Array.isArray(body.events), 'events not array');
});

// ── TC-TIMELINE-RANGE-003: ONVIF events API cameraId + 1H range ──────────────

await test('TC-TIMELINE-RANGE-003', 'ONVIF 이벤트 API: cameraId + 1H 범위 필터 → 해당 카메라 이벤트만 반환', async () => {
  // Get any camera from the camera list
  const camRes = await get('/api/cameras');
  const cameras = camRes.body?.data ?? camRes.body?.cameras ?? [];
  if (cameras.length === 0) {
    console.log('      (skip — no cameras registered)');
    return;
  }
  const cameraId = cameras[0].id;
  const from = nowMinus(MS_1H);
  const { status, body } = await get(`/api/onvif-events?cameraId=${cameraId}&from=${encodeURIComponent(from)}&limit=500`);
  assert(status === 200, `HTTP ${status}`);
  assert(Array.isArray(body.events), 'events not array');
  for (const e of body.events) {
    assert(e.cameraId === cameraId, `Event cameraId mismatch: got ${e.cameraId}`);
    assert(e.serverTs >= from, `Event serverTs=${e.serverTs} before from=${from}`);
  }
});

// ── TC-TIMELINE-RANGE-004: ONVIF events API future `to` boundary ─────────────

await test('TC-TIMELINE-RANGE-004', 'ONVIF 이벤트 API: to 파라미터 미래 시간 → 현재까지 이벤트 정상 반환', async () => {
  const from = nowMinus(MS_1H);
  const to   = new Date(Date.now() + 60_000).toISOString(); // 1 minute in future
  const { status, body } = await get(`/api/onvif-events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`);
  assert(status === 200, `HTTP ${status}`);
  assert(Array.isArray(body.events), 'events not array');
});

// ── TC-TIMELINE-RANGE-005: Detection tracks API 1H range ─────────────────────

await test('TC-TIMELINE-RANGE-005', 'Detection tracks API: 1H from 파라미터 → 200 + tracks array', async () => {
  const from = nowMinus(MS_1H);
  const { status, body } = await get(`/api/analysis/detection-tracks?from=${encodeURIComponent(from)}&limit=500`);
  assert(status === 200, `HTTP ${status}`);
  assert(Array.isArray(body.tracks), `tracks not array: ${JSON.stringify(body)}`);
  assert(typeof body.total === 'number', 'total not number');
  for (const t of body.tracks) {
    assert(t.firstSeenAt >= from || t.lastSeenAt >= from,
      `Track ${t.objectId} both firstSeenAt and lastSeenAt before from=${from}`);
  }
});

// ── TC-TIMELINE-RANGE-006: Detection tracks API no from param ────────────────

await test('TC-TIMELINE-RANGE-006', 'Detection tracks API: from 없이 전체 조회 → 200 + tracks array', async () => {
  const { status, body } = await get('/api/analysis/detection-tracks?limit=10');
  assert(status === 200, `HTTP ${status}`);
  assert(Array.isArray(body.tracks), 'tracks not array');
});

// ── TC-TIMELINE-RANGE-007: Detection tracks API cameraId + 1H range ──────────

await test('TC-TIMELINE-RANGE-007', 'Detection tracks API: cameraId + 1H 범위 → 해당 카메라 트랙만 반환', async () => {
  const camRes = await get('/api/cameras');
  const cameras = camRes.body?.data ?? camRes.body?.cameras ?? [];
  if (cameras.length === 0) {
    console.log('      (skip — no cameras registered)');
    return;
  }
  const cameraId = cameras[0].id;
  const from = nowMinus(MS_1H);
  const { status, body } = await get(
    `/api/analysis/detection-tracks?cameraId=${cameraId}&from=${encodeURIComponent(from)}&limit=200`);
  assert(status === 200, `HTTP ${status}`);
  assert(Array.isArray(body.tracks), 'tracks not array');
  for (const t of body.tracks) {
    assert(t.cameraId === cameraId, `Track cameraId mismatch: got ${t.cameraId}`);
  }
});

// ── TC-TIMELINE-RANGE-008: ONVIF events 6H range boundary ────────────────────

await test('TC-TIMELINE-RANGE-008', 'ONVIF 이벤트 API: 6H from 경계 — 결과가 [0, limit] 이내', async () => {
  const from  = nowMinus(MS_6H);
  const limit = 500;
  const { status, body } = await get(`/api/onvif-events?from=${encodeURIComponent(from)}&limit=${limit}`);
  assert(status === 200, `HTTP ${status}`);
  assert(body.total <= limit, `total ${body.total} exceeds limit ${limit}`);
  assert(Array.isArray(body.events), 'events not array');
  // Spot-check: all returned events within the [from, now] window
  const now = new Date().toISOString();
  for (const e of body.events) {
    assert(e.serverTs >= from, `serverTs ${e.serverTs} before from ${from}`);
    assert(e.serverTs <= now,  `serverTs ${e.serverTs} after now ${now}`);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);

for (const r of results) {
  if (r.status === 'PASS')  console.log(`  [TC-PASS] ${r.id} ${r.description}`);
  if (r.status === 'FAIL')  console.log(`  [TC-FAIL] ${r.id} ${r.description} — ${r.error}`);
}

process.exit(failed > 0 ? 1 : 0);
