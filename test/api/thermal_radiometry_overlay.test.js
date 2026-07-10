'use strict';
/**
 * Thermal Radiometry Overlay — ONVIF BoxTemperatureReading 파서 & API 테스트
 *
 * Test Group A — 서버 파서 단위 테스트   (TC-A-001 ~ TC-A-008)
 * Test Group B — Socket.IO / HTTP API    (TC-B-001 ~ TC-B-003)
 *
 * SRS: FR-THERMAL-001 ~ FR-THERMAL-003
 * TC:  docs/tc/TC_Thermal_Radiometry_Overlay.md
 *
 * Prerequisites:
 *   Group A — Node.js 실행 환경 (서버 불필요)
 *   Group B — 서버 실행 중 (BASE_URL), socket.io-client 설치
 *
 * Run:
 *   node test/api/thermal_radiometry_overlay.test.js
 *   LTS_URL=http://localhost:3080 node test/api/thermal_radiometry_overlay.test.js
 *
 * Skip network tests:
 *   SKIP_NETWORK=1 node test/api/thermal_radiometry_overlay.test.js
 */

const path = require('path');
const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

// ── Minimal test harness ──────────────────────────────────────────────────────

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

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description} [SKIPPED — ${reason}]`);
  results.push({ id, description, status: 'SKIP', reason });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function post(urlPath, body, contentType = 'application/json') {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function put(urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Resolves a camera id to exercise network tests against — TEST_CAMERA_ID env var
// takes priority, otherwise the first camera returned by GET /api/cameras.
async function resolveCameraId() {
  if (process.env.TEST_CAMERA_ID) return process.env.TEST_CAMERA_ID;
  try {
    const r = await fetch(`${BASE_URL}/api/cameras`, { signal: AbortSignal.timeout(3000) });
    const body = await r.json();
    const cameras = body.cameras || body || [];
    return Array.isArray(cameras) && cameras[0] ? cameras[0].id : null;
  } catch {
    return null;
  }
}

// ── XML builders ─────────────────────────────────────────────────────────────

function buildMetadataXml(readings) {
  const readingXml = readings.map(r => {
    const attrs = [
      r.itemId    != null ? `ItemID="${r.itemId}"`    : '',
      r.areaName  != null ? `AreaName="${r.areaName}"` : '',
      r.maxTemp   != null ? `MaxTemperature="${r.maxTemp}"` : '',
      r.maxTempX  != null ? `MaxTemperatureCoordinatesX="${r.maxTempX}"` : '',
      r.maxTempY  != null ? `MaxTemperatureCoordinatesY="${r.maxTempY}"` : '',
      r.minTemp   != null ? `MinTemperature="${r.minTemp}"` : '',
      r.minTempX  != null ? `MinTemperatureCoordinatesX="${r.minTempX}"` : '',
      r.minTempY  != null ? `MinTemperatureCoordinatesY="${r.minTempY}"` : '',
      r.avgTemp   != null ? `AverageTemperature="${r.avgTemp}"` : '',
    ].filter(Boolean).join(' ');
    return `<ttr:BoxTemperatureReading ${attrs}/>`;
  }).join('\n              ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:ttr="https://www.onvif.org/ver20/analytics/radiometry"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
    xmlns:tns1="http://www.onvif.org/ver10/topics">
  <tt:Event>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:VideoAnalytics/Radiometry/BoxTemperatureReading</wsnt:Topic>
      <wsnt:Message>
        <tt:Message UtcTime="2026-04-20T03:37:22.359Z">
          <tt:Source>
            <tt:SimpleItem Name="VideoSourceToken" Value="VideoSourceToken-0"/>
          </tt:Source>
          <tt:Data>
            <tt:ElementItem Name="Reading">
              ${readingXml}
            </tt:ElementItem>
            <tt:SimpleItem Name="TimeStamp" Value="2026-04-20T03:37:22.359Z"/>
          </tt:Data>
        </tt:Message>
      </wsnt:Message>
    </wsnt:NotificationMessage>
  </tt:Event>
</tt:MetadataStream>`;
}

function xmlToBase64(xml) {
  return Buffer.from(xml, 'utf-8').toString('base64');
}

// ── Load server parser (unit tests only) ─────────────────────────────────────

let parseRadiometryReadings;
let parseOnvifPayload;
try {
  const parserPath = path.resolve(__dirname, '../../server/src/services/onvifParser.js');
  const parser = require(parserPath);
  parseRadiometryReadings = parser.parseRadiometryReadings;
  parseOnvifPayload       = parser.parseOnvifPayload;
} catch (e) {
  console.warn(`[WARN] onvifParser.js 로드 실패 — 단위 테스트 스킵: ${e.message}`);
}

// ── Group A: 서버 파서 단위 테스트 ───────────────────────────────────────────

async function runGroupA() {
  console.log('\n[Group A] 서버 파서 단위 테스트 (parseRadiometryReadings / parseOnvifPayload)');

  if (!parseRadiometryReadings) {
    console.warn('  ⊘ onvifParser.js를 불러올 수 없어 Group A 전체 스킵');
    return;
  }

  // TC-A-001: Named Box Area 파싱
  await test('TC-A-001', '단일 Named Box Area 파싱 — 속성 전체 추출', () => {
    const xml = buildMetadataXml([{
      itemId: 'D', areaName: 'D',
      maxTemp: 359.9, maxTempX: 243, maxTempY: 217,
      minTemp: 333.8, minTempX: 328, minTempY: 261,
      avgTemp: 350.0,
    }]);
    const readings = parseRadiometryReadings(xml);
    assertEq(readings.length, 1, 'readings.length');
    assertEq(readings[0].itemId,   'D',    'itemId');
    assertEq(readings[0].areaName, 'D',    'areaName');
    assertEq(readings[0].maxTemp,  359.9,  'maxTemp');
    assertEq(readings[0].maxTempX, 243,    'maxTempX');
    assertEq(readings[0].maxTempY, 217,    'maxTempY');
    assertEq(readings[0].minTemp,  333.8,  'minTemp');
    assertEq(readings[0].minTempX, 328,    'minTempX');
    assertEq(readings[0].minTempY, 261,    'minTempY');
    assertEq(readings[0].avgTemp,  350.0,  'avgTemp');
  });

  // TC-A-002: FullArea 좌표 없는 파싱
  await test('TC-A-002', 'FullArea(ItemID=Z) 파싱 — 좌표 null 처리', () => {
    const xml = buildMetadataXml([{
      itemId: 'Z', areaName: 'FullArea',
      maxTemp: 370.0, minTemp: 310.0, avgTemp: 340.0,
    }]);
    const readings = parseRadiometryReadings(xml);
    assertEq(readings.length, 1, 'readings.length');
    assertEq(readings[0].itemId,   'Z',        'itemId');
    assertEq(readings[0].areaName, 'FullArea', 'areaName');
    assertEq(readings[0].maxTempX, null,       'maxTempX should be null');
    assertEq(readings[0].maxTempY, null,       'maxTempY should be null');
    assertEq(readings[0].minTempX, null,       'minTempX should be null');
    assertEq(readings[0].minTempY, null,       'minTempY should be null');
  });

  // TC-A-003: FullArea 좌표 포함 파싱 (서버는 파싱, 클라이언트가 제외 책임)
  await test('TC-A-003', 'FullArea 좌표 포함 파싱 — 서버는 좌표 추출', () => {
    const xml = buildMetadataXml([{
      itemId: 'Z', areaName: 'FullArea',
      maxTemp: 370.0, maxTempX: 100, maxTempY: 80,
      minTemp: 310.0, minTempX: 200, minTempY: 150,
      avgTemp: 340.0,
    }]);
    const readings = parseRadiometryReadings(xml);
    assertEq(readings.length, 1, 'readings.length');
    assertEq(readings[0].maxTempX, 100, 'maxTempX');
    assertEq(readings[0].maxTempY, 80,  'maxTempY');
  });

  // TC-A-004: 복수 BoxTemperatureReading
  await test('TC-A-004', '복수 BoxTemperatureReading — 모두 파싱', () => {
    const xml = buildMetadataXml([
      { itemId: 'D', areaName: 'D', maxTemp: 359.9, minTemp: 333.8, avgTemp: 350.0 },
      { itemId: 'Z', areaName: 'FullArea', maxTemp: 370.0, minTemp: 310.0, avgTemp: 340.0 },
    ]);
    const readings = parseRadiometryReadings(xml);
    assertEq(readings.length, 2, 'readings.length');
    assertEq(readings[0].itemId, 'D',        'readings[0].itemId');
    assertEq(readings[1].itemId, 'Z',        'readings[1].itemId');
    assertEq(readings[1].areaName, 'FullArea', 'readings[1].areaName');
  });

  // TC-A-005: 네임스페이스 접두어 무관
  await test('TC-A-005', '네임스페이스 접두어 변형 — ttr:/ns:/접두어없음 모두 파싱', () => {
    const variants = [
      '<ttr:BoxTemperatureReading ItemID="A" AreaName="A" MaxTemperature="100.0" MinTemperature="90.0"/>',
      '<ns2:BoxTemperatureReading ItemID="A" AreaName="A" MaxTemperature="100.0" MinTemperature="90.0"/>',
      '<BoxTemperatureReading ItemID="A" AreaName="A" MaxTemperature="100.0" MinTemperature="90.0"/>',
    ];
    for (const variant of variants) {
      const readings = parseRadiometryReadings(variant);
      assert(readings.length === 1, `접두어 변형 파싱 실패: ${variant.slice(0, 50)}`);
      assertEq(readings[0].itemId, 'A', 'itemId');
    }
  });

  // TC-A-006: Max/Min 모두 없는 요소 → 무시
  await test('TC-A-006', 'MaxTemperature·MinTemperature 모두 없음 → readings 제외', () => {
    const xml = '<ttr:BoxTemperatureReading ItemID="D" AreaName="D" AverageTemperature="350.0"/>';
    const readings = parseRadiometryReadings(xml);
    assertEq(readings.length, 0, 'readings.length should be 0');
  });

  // TC-A-007: parseOnvifPayload — radiometry 필드 확인
  // parseOnvifPayload는 배열 [{topic, topicType, radiometry, ...}]을 반환합니다.
  await test('TC-A-007', 'parseOnvifPayload — radiometry 파싱 및 topicType 확인', () => {
    const xml = buildMetadataXml([{
      itemId: 'D', areaName: 'D',
      maxTemp: 359.9, maxTempX: 243, maxTempY: 217,
      minTemp: 333.8, minTempX: 328, minTempY: 261,
      avgTemp: 350.0,
    }]);
    const b64 = xmlToBase64(xml);
    const results = parseOnvifPayload(b64);
    assert(results !== null && Array.isArray(results), 'parseOnvifPayload should return array');
    assert(results.length >= 1, 'results.length >= 1');
    const parsed = results[0];
    assertEq(parsed.topicType, 'boxTemperatureReading', 'topicType');
    assert(Array.isArray(parsed.radiometry), 'radiometry should be array');
    assertEq(parsed.radiometry.length, 1, 'radiometry.length');
    assertEq(parsed.radiometry[0].itemId, 'D', 'radiometry[0].itemId');
    assertEq(parsed.radiometry[0].maxTempX, 243, 'radiometry[0].maxTempX');
  });

  // TC-A-008: ingest_daemon.py 코드 구조 검증 (정적 코드 검사)
  await test('TC-A-008', 'ingest_daemon.py — appRtpCallbackUrl 조건부 스레드 시작 코드 존재', () => {
    const fs = require('fs');
    const daemonPath = path.resolve(__dirname, '../../ingest-daemon/ingest_daemon.py');
    assert(fs.existsSync(daemonPath), 'ingest_daemon.py 파일 없음');
    const src = fs.readFileSync(daemonPath, 'utf-8');
    assert(
      src.includes('app_rtp_callback_url') && src.includes('cfg.get("appRtpCallbackUrl")'),
      'appRtpCallbackUrl 할당 코드 없음'
    );
    assert(
      src.includes('if self.app_rtp_callback_url:'),
      'appRtpCallbackUrl 조건부 스레드 시작 코드 없음'
    );
    assert(
      src.includes('self._start_thread("apprtp", self._app_rtp_loop)'),
      'apprtp 스레드 시작 코드 없음'
    );
  });
}

// ── Group B: Socket.IO / HTTP API 테스트 ─────────────────────────────────────

async function runGroupB() {
  console.log('\n[Group B] Socket.IO / HTTP API 테스트 (서버 실행 필요)');

  if (SKIP_NETWORK) {
    skip('TC-B-001', 'BoxTemperatureReading → onvif:temperature emit', 'SKIP_NETWORK=1');
    skip('TC-B-002', '중복 패킷도 매번 emit', 'SKIP_NETWORK=1');
    skip('TC-B-003', 'BoxTemperatureReading 없는 패킷 → emit 없음', 'SKIP_NETWORK=1');
    return;
  }

  // 서버 헬스 체크
  let serverAlive = false;
  try {
    const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    serverAlive = r.ok;
  } catch {
    serverAlive = false;
  }
  if (!serverAlive) {
    console.warn(`  ⊘ 서버(${BASE_URL})에 접속 불가 — Group B 전체 스킵`);
    ['TC-B-001', 'TC-B-002', 'TC-B-003'].forEach(id =>
      results.push({ id, description: id, status: 'SKIP', reason: '서버 미실행' })
    );
    return;
  }

  // 먼저 카메라 ID를 조회
  const cameraId = await resolveCameraId();
  if (!cameraId) {
    console.warn('  ⊘ 등록된 카메라 없음 — Group B 전체 스킵');
    ['TC-B-001', 'TC-B-002', 'TC-B-003'].forEach(id =>
      results.push({ id, description: id, status: 'SKIP', reason: '카메라 없음' })
    );
    return;
  }

  // Socket.IO 연결 (socket.io-client 선택적 사용)
  let io;
  try {
    io = require('socket.io-client');
  } catch {
    console.warn('  ⊘ socket.io-client 미설치 — Group B 소켓 테스트 스킵');
    ['TC-B-001', 'TC-B-002', 'TC-B-003'].forEach(id =>
      results.push({ id, description: id, status: 'SKIP', reason: 'socket.io-client 미설치' })
    );
    return;
  }

  const socket = io(BASE_URL, { transports: ['websocket'], timeout: 5000 });
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });

  function waitForEvent(eventName, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${eventName}`)), timeoutMs);
      socket.once(eventName, (data) => { clearTimeout(t); resolve(data); });
    });
  }

  function buildPayload(readings) {
    const xml = buildMetadataXml(readings);
    return { pt: 0, timestamp: Date.now(), seq: 0, payload: xmlToBase64(xml) };
  }

  // TC-B-001: BoxTemperatureReading → onvif:temperature emit
  await test('TC-B-001', 'BoxTemperatureReading POST → onvif:temperature 이벤트 수신', async () => {
    const payloadPromise = waitForEvent('onvif:temperature');
    await post(`/api/internal/apprtp/${cameraId}`, buildPayload([{
      itemId: 'D', areaName: 'D',
      maxTemp: 359.9, maxTempX: 243, maxTempY: 217,
      minTemp: 333.8, minTempX: 328, minTempY: 261,
      avgTemp: 350.0,
    }]));
    const evt = await payloadPromise;
    assertEq(evt.cameraId, cameraId, 'cameraId');
    assert(Array.isArray(evt.readings), 'readings should be array');
    assertEq(evt.readings.length, 1, 'readings.length');
    assertEq(evt.readings[0].itemId,   'D',   'readings[0].itemId');
    assertEq(evt.readings[0].maxTempX, 243,   'readings[0].maxTempX');
    assertEq(evt.readings[0].maxTempY, 217,   'readings[0].maxTempY');
    assertEq(evt.readings[0].maxTemp,  359.9, 'readings[0].maxTemp');
    assert(typeof evt.utcTime === 'string' && evt.utcTime.length > 0, 'utcTime should be string');
  });

  // TC-B-002: 중복 패킷도 매번 emit (dedup 없음)
  await test('TC-B-002', '동일 BoxTemperatureReading 2회 전송 → 2회 모두 onvif:temperature 수신', async () => {
    let count = 0;
    socket.on('onvif:temperature', (evt) => { if (evt.cameraId === cameraId) count++; });

    const payload = buildPayload([{
      itemId: 'D', areaName: 'D',
      maxTemp: 359.9, maxTempX: 243, maxTempY: 217,
      minTemp: 333.8, minTempX: 328, minTempY: 261,
    }]);
    await post(`/api/internal/apprtp/${cameraId}`, payload);
    await post(`/api/internal/apprtp/${cameraId}`, payload);
    await new Promise(r => setTimeout(r, 500));
    socket.off('onvif:temperature');
    assert(count >= 2, `onvif:temperature 수신 횟수 ${count} (기대 ≥ 2)`);
  });

  // TC-B-003: BoxTemperatureReading 없는 ONVIF 패킷 → onvif:temperature emit 없음
  await test('TC-B-003', 'BoxTemperatureReading 없는 패킷 → onvif:temperature 미수신', async () => {
    const motionXml = `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
    xmlns:tns1="http://www.onvif.org/ver10/topics">
  <tt:Event>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="...">tns1:VideoSource/tns1:MotionAlarm</wsnt:Topic>
      <wsnt:Message>
        <tt:Message UtcTime="2026-04-20T03:37:22.359Z" PropertyOperation="Changed">
          <tt:Source><tt:SimpleItem Name="VideoSourceToken" Value="VideoSourceToken-0"/></tt:Source>
          <tt:Data><tt:SimpleItem Name="State" Value="true"/></tt:Data>
        </tt:Message>
      </wsnt:Message>
    </wsnt:NotificationMessage>
  </tt:Event>
</tt:MetadataStream>`;

    let received = false;
    const handler = (evt) => { if (evt.cameraId === cameraId) received = true; };
    socket.on('onvif:temperature', handler);

    await post(`/api/internal/apprtp/${cameraId}`, {
      pt: 0, timestamp: Date.now(), seq: 0, payload: xmlToBase64(motionXml),
    });
    await new Promise(r => setTimeout(r, 600));
    socket.off('onvif:temperature', handler);
    assert(!received, 'onvif:temperature가 잘못 emit됨 (BoxTemperatureReading 없는 패킷)');
  });

  socket.disconnect();
}

// ── isFullArea 클라이언트 로직 검증 (Node 환경에서 재현) ─────────────────────

async function runGroupC() {
  console.log('\n[Group C] isFullArea / coordSlots 필터 로직 검증');

  function isFullArea(r) {
    return r.areaName === 'FullArea' || r.itemId === 'Z';
  }

  function buildCoordSlots(readings) {
    return readings.filter(r =>
      !isFullArea(r) && (
        (r.maxTempX !== null && r.maxTempY !== null) ||
        (r.minTempX !== null && r.minTempY !== null)
      )
    );
  }

  // TC-C-001: FullArea → coordSlots 제외
  await test('TC-C-001 (logic)', 'FullArea(ItemID=Z) → coordSlots 제외 (FR-THERMAL-023)', () => {
    const readings = [
      { itemId: 'Z', areaName: 'FullArea', maxTempX: 100, maxTempY: 80, minTempX: 200, minTempY: 150 },
    ];
    const coordSlots = buildCoordSlots(readings);
    assertEq(coordSlots.length, 0, 'coordSlots.length should be 0 for FullArea');
  });

  // TC-C-002: Named Box Area → coordSlots 포함
  await test('TC-C-002 (logic)', 'Named Box Area(ItemID=D) → coordSlots 포함 (FR-THERMAL-021)', () => {
    const readings = [
      { itemId: 'D', areaName: 'D', maxTempX: 243, maxTempY: 217, minTempX: 328, minTempY: 261 },
    ];
    const coordSlots = buildCoordSlots(readings);
    assertEq(coordSlots.length, 1, 'coordSlots.length should be 1 for Named Area');
    assertEq(coordSlots[0].itemId, 'D', 'coordSlots[0].itemId');
  });

  // TC-C-003: FullArea + Named Area 혼합 → Named Area만 coordSlots
  await test('TC-C-003 (logic)', 'FullArea + Named Area 혼합 → Named Area만 coordSlots', () => {
    const readings = [
      { itemId: 'D',  areaName: 'D',        maxTempX: 243, maxTempY: 217, minTempX: null, minTempY: null },
      { itemId: 'Z',  areaName: 'FullArea',  maxTempX: 100, maxTempY: 80,  minTempX: 200, minTempY: 150 },
    ];
    const coordSlots = buildCoordSlots(readings);
    assertEq(coordSlots.length, 1, 'coordSlots.length should be 1');
    assertEq(coordSlots[0].itemId, 'D', 'only Named Area in coordSlots');
  });

  // TC-C-004: 좌표 없는 Named Area → coordSlots 제외
  await test('TC-C-004 (logic)', '좌표 없는 Named Area → coordSlots 제외', () => {
    const readings = [
      { itemId: 'D', areaName: 'D', maxTempX: null, maxTempY: null, minTempX: null, minTempY: null },
    ];
    const coordSlots = buildCoordSlots(readings);
    assertEq(coordSlots.length, 0, 'no coordinates → not in coordSlots');
  });

  // TC-D-001: Kelvin 변환 포맷
  await test('TC-D-001 (logic)', 'Kelvin 값(>200) → °C 변환 포맷 (FR-THERMAL-013)', () => {
    function formatTemp(t) {
      if (t === null) return '—';
      if (t > 200) return `${t.toFixed(1)} (${(t - 273.15).toFixed(1)}°C)`;
      return `${t.toFixed(1)}°C`;
    }
    assertEq(formatTemp(359.9), '359.9 (86.8°C)', 'Kelvin format');
    assertEq(formatTemp(86.8),  '86.8°C',          'Celsius format');
    assertEq(formatTemp(null),  '—',               'null format');
  });
}

// ── Group F: Sensor Coordinate Calibration (FR-THERMAL-030~033) ─────────────

// Pure-JS reproduction of ThermalOverlay.tsx's getRenderArea()/toScreen() —
// same letterbox math, kept in sync manually (component logic isn't exported).
function getRenderArea(fw, fh, cw, ch) {
  if (!fw || !fh || !cw || !ch) return { rw: cw, rh: ch, ox: 0, oy: 0 };
  const ia = fw / fh, ca = cw / ch;
  if (ia > ca) return { rw: cw, rh: cw / ia, ox: 0, oy: (ch - cw / ia) / 2 };
  return { rw: ch * ia, rh: ch, ox: (cw - ch * ia) / 2, oy: 0 };
}

function toScreen(px, py, sensorW, sensorH, fw, fh, cw, ch) {
  if (!fw || !fh || !cw || !ch || !sensorW || !sensorH) return { sx: -9999, sy: -9999 };
  const { rw, rh, ox, oy } = getRenderArea(fw, fh, cw, ch);
  const sx = Math.max(ox, Math.min(ox + rw, ox + (px / sensorW) * rw));
  const sy = Math.max(oy, Math.min(oy + rh, oy + (py / sensorH) * rh));
  return { sx, sy };
}

async function runGroupF() {
  console.log('\n[Group F] Sensor Coordinate Calibration (FR-THERMAL-030~033)');

  // TC-F-003: sensorWidth/Height configured → normalization uses sensor resolution,
  // not frame resolution — a center-of-sensor point must land at screen center.
  await test('TC-F-003', 'toScreen — Sensor Coordinate 설정 시 sensorWidth/Height 기준 정규화', () => {
    const { sx, sy } = toScreen(80, 60, /*sensorW*/160, /*sensorH*/120, /*fw*/640, /*fh*/480, /*cw*/640, /*ch*/480);
    assert(Math.abs(sx - 320) < 0.01, `sx should be ~320 (center), got ${sx}`);
    assert(Math.abs(sy - 240) < 0.01, `sy should be ~240 (center), got ${sy}`);
  });

  // TC-F-004: sensorWidth/Height unset → component-level fallback to frameWidth/Height
  // (mirrors `const sensorW = sensorWidth || fw` in ThermalOverlay.tsx) — must reproduce
  // pre-calibration behavior exactly.
  await test('TC-F-004', 'toScreen — Sensor Coordinate 미설정 시 frameWidth/Height 폴백', () => {
    const fw = 640, fh = 480;
    const sensorWidth = 0, sensorHeight = 0; // "unset" as sent by the component (falsy)
    const effSensorW = sensorWidth || fw;
    const effSensorH = sensorHeight || fh;
    const { sx, sy } = toScreen(320, 240, effSensorW, effSensorH, fw, fh, 640, 480);
    assert(Math.abs(sx - 320) < 0.01, `sx should be ~320 (center), got ${sx}`);
    assert(Math.abs(sy - 240) < 0.01, `sy should be ~240 (center), got ${sy}`);
  });

  // TC-F-005: getRenderArea's letterbox aspect ratio always derives from frameWidth/Height,
  // never from sensorWidth/Height — the two resolutions solve different problems.
  await test('TC-F-005', 'getRenderArea — letterbox 종횡비는 항상 frameWidth/Height 기준', () => {
    // sensor is 4:3 (160x120), frame is 16:9 (1920x1080), container is 4:3 (800x600)
    const { rw, rh, ox, oy } = getRenderArea(1920, 1080, 800, 600);
    assertEq(rw, 800, 'rw');
    assertEq(rh, 450, 'rh');
    assertEq(ox, 0,   'ox');
    assertEq(oy, 75,  'oy — top/bottom letterbox bars from 16:9 frame in 4:3 container');
  });

  // TC-F-006: CameraEditModal.tsx — Sensor Coordinate UI wiring (static code check)
  await test('TC-F-006', 'CameraEditModal.tsx — Sensor Coordinate 입력 UI 및 저장 로직 존재', () => {
    const fs = require('fs');
    const modalPath = path.resolve(__dirname, '../../client/src/components/CameraEditModal.tsx');
    assert(fs.existsSync(modalPath), 'CameraEditModal.tsx 파일 없음');
    const src = fs.readFileSync(modalPath, 'utf-8');
    assert(src.includes('thermalSensorWidth') && src.includes('thermalSensorHeight'),
      'thermalSensorWidth/Height state 없음');
    assert(src.includes('Sensor Coordinate'), 'Sensor Coordinate 라벨 없음');
    assert(
      /thermalSensorWidth:\s*thermalSensorWidth\s*===\s*''\s*\?\s*null\s*:\s*Number\(thermalSensorWidth\)/.test(src),
      '빈 값 → null 저장 로직 없음'
    );
  });

  if (SKIP_NETWORK) {
    skip('TC-F-001', 'PUT /api/cameras/:id — thermalSensorWidth/Height 저장', 'SKIP_NETWORK=1');
    skip('TC-F-002', '빈 값 전송 → null로 초기화', 'SKIP_NETWORK=1');
    return;
  }

  let serverAlive = false;
  try {
    const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    serverAlive = r.ok;
  } catch {
    serverAlive = false;
  }
  const cameraId = serverAlive ? await resolveCameraId() : null;
  if (!cameraId) {
    const reason = serverAlive ? '카메라 없음' : '서버 미실행';
    console.warn(`  ⊘ ${reason} — TC-F-001/002 스킵`);
    skip('TC-F-001', 'PUT /api/cameras/:id — thermalSensorWidth/Height 저장', reason);
    skip('TC-F-002', '빈 값 전송 → null로 초기화', reason);
    return;
  }

  // TC-F-001: persist thermalSensorWidth/Height
  await test('TC-F-001', 'PUT /api/cameras/:id — thermalSensorWidth/Height 저장', async () => {
    const { status, body } = await put(`/api/cameras/${cameraId}`, {
      thermalSensorWidth: 160, thermalSensorHeight: 120,
    });
    assert(status === 200, `PUT status should be 200, got ${status}`);
    assertEq(body.data?.thermalSensorWidth,  160, 'data.thermalSensorWidth');
    assertEq(body.data?.thermalSensorHeight, 120, 'data.thermalSensorHeight');

    const r = await fetch(`${BASE_URL}/api/cameras/${cameraId}`);
    const getBody = await r.json();
    assertEq(getBody.data?.thermalSensorWidth,  160, 'GET data.thermalSensorWidth after PUT');
    assertEq(getBody.data?.thermalSensorHeight, 120, 'GET data.thermalSensorHeight after PUT');
  });

  // TC-F-002: clearing (null) resets calibration
  await test('TC-F-002', '빈 값(null) 전송 → thermalSensorWidth/Height 초기화', async () => {
    const { status, body } = await put(`/api/cameras/${cameraId}`, {
      thermalSensorWidth: null, thermalSensorHeight: null,
    });
    assert(status === 200, `PUT status should be 200, got ${status}`);
    assertEq(body.data?.thermalSensorWidth,  null, 'data.thermalSensorWidth');
    assertEq(body.data?.thermalSensorHeight, null, 'data.thermalSensorHeight');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Thermal Radiometry Overlay Tests ===');
  console.log(`Base URL: ${BASE_URL}  |  SKIP_NETWORK: ${SKIP_NETWORK}`);

  await runGroupA();
  await runGroupB();
  await runGroupC();
  await runGroupF();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${results.filter(r => r.status === 'SKIP').length} skipped ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
