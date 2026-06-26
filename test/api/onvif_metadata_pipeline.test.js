'use strict';
/**
 * ONVIF Metadata Pipeline — Parser Unit Tests + API Integration Tests
 *
 * TC-PARSER-001: 단일 NotificationMessage → array[1]
 * TC-PARSER-002: 다중 NotificationMessage → array[N]  (회귀 방지 — 핵심 버그 수정)
 * TC-PARSER-003: 비-MetadataStream 페이로드 → null
 * TC-PARSER-004: TOPIC_MAP 알려진 토픽 정규화
 * TC-PARSER-005: Samsung namespace 변형 정규화  (회귀 방지)
 * TC-PARSER-006: Unknown 토픽 처리
 * TC-PARSER-007: State 추출 우선순위 및 숫자 boolean 정규화
 * TC-PARSER-008: 다중 이벤트 독립 Dedup (API 통합)
 * TC-PARSER-009: 상태 변화 Dedup — 동일 state 반복 저장 방지 (API 통합)
 * TC-PARSER-010: 파싱 오류 시 200 응답 유지 (API 통합)
 *
 * Unit tests (TC-PARSER-001~007): require onvifParser.js 직접 — 서버 불필요
 * Integration tests (TC-PARSER-008~010): 실행 중인 서버 필요
 *   LTS_URL=http://localhost:3080 (기본값)
 *
 * Run: node test/api/onvif_metadata_pipeline.test.js
 * Run (unit only): node test/api/onvif_metadata_pipeline.test.js --unit-only
 *
 * Related SRS:    docs/srs/SRS_ONVIF_Metadata_Pipeline.md
 * Related TC doc: docs/tc/TC_ONVIF_Metadata_Pipeline.md
 */

const path = require('path');

const BASE_URL = process.env.LTS_URL || 'http://localhost:3080';
const UNIT_ONLY = process.argv.includes('--unit-only');

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

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── HTTP helpers (integration tests) ─────────────────────────────────────────

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rb = await res.json().catch(() => ({}));
  return { status: res.status, body: rb };
}

async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status };
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function toBase64(xml) {
  return Buffer.from(xml, 'utf-8').toString('base64');
}

const NS = `xmlns:tt="http://www.onvif.org/ver10/schema" ` +
           `xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" ` +
           `xmlns:tns1="http://www.onvif.org/ver10/topics" ` +
           `xmlns:tnssamsung="http://www.samsungcctv.com/2011/event/topics"`;

function makeNotification(topic, utcTime, operation, sourceItems, dataItems) {
  const src = (sourceItems || []).map(([n, v]) =>
    `<tt:SimpleItem Name="${n}" Value="${v}"/>`).join('');
  const dat = (dataItems || []).map(([n, v]) =>
    `<tt:SimpleItem Name="${n}" Value="${v}"/>`).join('');
  return `
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic>
      <wsnt:Message>
        <tt:Message UtcTime="${utcTime}" PropertyOperation="${operation}">
          <tt:Source>${src}</tt:Source>
          <tt:Data>${dat}</tt:Data>
        </tt:Message>
      </wsnt:Message>
    </wsnt:NotificationMessage>`;
}

function makeMetadataStream(...notifications) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream ${NS}>
  <tt:Event>
    ${notifications.join('\n    ')}
  </tt:Event>
</tt:MetadataStream>`;
}

// ── Load parser module ────────────────────────────────────────────────────────

const parserPath = path.resolve(__dirname, '../../server/src/services/onvifParser.js');
const { parseOnvifPayload, TOPIC_MAP } = require(parserPath);

// ── Unit Tests ────────────────────────────────────────────────────────────────

async function runUnitTests() {
  console.log('\n── Unit Tests (onvifParser.js) ──────────────────────────');

  // TC-PARSER-001: 단일 NotificationMessage → array[1]
  await test('TC-PARSER-001', '단일 NotificationMessage → 배열 길이 1 반환', () => {
    const xml = makeMetadataStream(
      makeNotification(
        'tns1:VideoSource/tns1:MotionAlarm',
        '2026-06-23T12:00:00.000Z',
        'Changed',
        [['Source', 'VideoSourceToken-1']],
        [['State', 'true']]
      )
    );
    const result = parseOnvifPayload(toBase64(xml));
    assert(Array.isArray(result), 'result must be an array');
    assertEq(result.length, 1, 'result.length');
    assertEq(result[0].topic, 'tns1:VideoSource/tns1:MotionAlarm', 'result[0].topic');
    assertEq(result[0].state, 'true', 'result[0].state');
    assertEq(result[0].topicType, 'motionAlarm', 'result[0].topicType');
  });

  // TC-PARSER-002: 다중 NotificationMessage → array[N] (핵심 회귀 방지)
  await test('TC-PARSER-002', '다중 NotificationMessage → 배열 길이 N, 교차 오염 없음 (회귀)', () => {
    const xml = makeMetadataStream(
      makeNotification(
        'tns1:VideoSource/tns1:MotionAlarm',
        '2026-06-23T12:00:01.000Z',
        'Changed',
        [['Source', 'VideoSourceToken-1']],
        [['State', 'true']]
      ),
      makeNotification(
        'tns1:Device/tns1:Trigger/tns1:DigitalInput',
        '2026-06-23T12:00:02.000Z',
        'Changed',
        [['Index', '0'], ['AlarmInID', '1']],
        [['Level', 'false']]
      ),
      makeNotification(
        'tns1:AudioSource/tnssamsung:AudioDetection',
        '2026-06-23T12:00:03.000Z',
        'Initialized',
        [['AudioSourceToken', 'AudioSource-0']],
        [['Audio', 'false'], ['State', 'false']]
      )
    );
    const result = parseOnvifPayload(toBase64(xml));
    assert(Array.isArray(result), 'result must be an array');
    assertEq(result.length, 3, 'result.length must be 3');

    // 각 블록 topic 독립성
    assertEq(result[0].topic, 'tns1:VideoSource/tns1:MotionAlarm', 'result[0].topic');
    assertEq(result[1].topic, 'tns1:Device/tns1:Trigger/tns1:DigitalInput', 'result[1].topic');
    assertEq(result[2].topic, 'tns1:AudioSource/tnssamsung:AudioDetection', 'result[2].topic');

    // 각 블록 UtcTime 독립성
    assertEq(result[0].utcTime, '2026-06-23T12:00:01.000Z', 'result[0].utcTime');
    assertEq(result[1].utcTime, '2026-06-23T12:00:02.000Z', 'result[1].utcTime');
    assertEq(result[2].utcTime, '2026-06-23T12:00:03.000Z', 'result[2].utcTime');

    // 교차 오염 없음: result[0]의 items에 다른 블록 데이터 없어야 함
    assert(!('AlarmInID' in result[0].items), 'result[0] must not contain DigitalInput items');
    assert(!('AudioSourceToken' in result[0].items), 'result[0] must not contain Audio items');
  });

  // TC-PARSER-003: 비-MetadataStream → null
  await test('TC-PARSER-003', '비-MetadataStream 페이로드 → null 반환', () => {
    const result1 = parseOnvifPayload(toBase64('not-onvif-data'));
    assertEq(result1, null, 'random string → null');

    const result2 = parseOnvifPayload(toBase64('<SomeOtherXml/>'));
    assertEq(result2, null, 'non-MetadataStream XML → null');
  });

  // TC-PARSER-004: TOPIC_MAP 알려진 토픽 정규화
  await test('TC-PARSER-004', 'TOPIC_MAP 표준 ONVIF 토픽 정규화 검증', () => {
    const cases = [
      { topic: 'tns1:VideoSource/tns1:MotionAlarm',          type: 'motionAlarm',           sev: 'warning' },
      { topic: 'tns1:Device/tns1:Trigger/tns1:Relay',        type: 'relay',                 sev: 'info'    },
      { topic: 'tns1:VideoSource/RadiometryAlarm',            type: 'radiometryAlarm',       sev: 'warning' },
      { topic: 'tns1:RuleEngine/Radiometry/TemperatureAlarm', type: 'temperatureAlarm',      sev: 'warning' },
      { topic: 'tns1:RuleEngine/Detection/TemperatureDifference', type: 'temperatureDifference', sev: 'info' },
    ];
    for (const { topic, type, sev } of cases) {
      const xml = makeMetadataStream(
        makeNotification(topic, '2026-06-23T00:00:00.000Z', 'Changed', [], [])
      );
      const result = parseOnvifPayload(toBase64(xml));
      assert(Array.isArray(result) && result.length > 0, `${topic}: must parse`);
      assertEq(result[0].topicType, type, `${topic} → topicType`);
      assertEq(result[0].severity,  sev,  `${topic} → severity`);
    }
  });

  // TC-PARSER-005: Samsung namespace 변형 정규화 (회귀 방지)
  await test('TC-PARSER-005', 'Samsung namespace 변형 TOPIC_MAP 정규화 (회귀)', () => {
    const cases = [
      { topic: 'tns1:Device/tns1:Trigger/tnssamsung:DigitalInput', type: 'digitalInput' },
      { topic: 'tns1:VideoAnalytics/tnssamsung:MotionDetection',   type: 'motionAlarm'  },
      { topic: 'tns1:AudioSource/tnssamsung:AudioDetection',        type: 'audioAlarm'   },
      { topic: 'tns1:VideoSource/MotionAlarm',                      type: 'motionAlarm'  },
      { topic: 'tnssamsung:IVA/Fire',                               type: 'fire'         },
      { topic: 'tnssamsung:IVA/LoiteringDetection',                 type: 'loiteringDetection' },
    ];
    for (const { topic, type } of cases) {
      const xml = makeMetadataStream(
        makeNotification(topic, '2026-06-23T00:00:00.000Z', 'Changed', [], [['State', 'true']])
      );
      const result = parseOnvifPayload(toBase64(xml));
      assert(Array.isArray(result) && result.length > 0, `${topic}: must parse`);
      assertEq(result[0].topicType, type, `${topic} → topicType`);
    }
  });

  // TC-PARSER-006: Unknown 토픽 처리
  await test('TC-PARSER-006', 'Unknown 토픽 → 전체 경로를 topicType, 마지막 세그먼트를 label', () => {
    const topic = 'tns1:Custom/Namespace:UnknownEvent';
    const xml = makeMetadataStream(
      makeNotification(topic, '2026-06-23T00:00:00.000Z', 'Changed', [], [])
    );
    const result = parseOnvifPayload(toBase64(xml));
    assert(Array.isArray(result) && result.length === 1, 'must parse unknown topic');
    assertEq(result[0].topicType, topic,           'topicType = full path');
    assertEq(result[0].topicLabel, 'UnknownEvent', 'topicLabel = last segment without namespace');
    assertEq(result[0].severity, 'info',           'severity = info for unknown');
  });

  // TC-PARSER-007: State 추출 우선순위 및 숫자 boolean 정규화
  await test('TC-PARSER-007', 'State 추출 우선순위 — State > IsMotion > Value, 숫자 정규화', () => {
    const wrap = (dataItems) => {
      const xml = makeMetadataStream(
        makeNotification(
          'tns1:VideoSource/tns1:MotionAlarm',
          '2026-06-23T00:00:00.000Z',
          'Changed',
          [],
          dataItems
        )
      );
      const result = parseOnvifPayload(toBase64(xml));
      return result && result[0] ? result[0].state : undefined;
    };

    // State 최우선
    assertEq(wrap([['State', 'true']]),   'true',  'State=true');
    assertEq(wrap([['State', 'false']]),  'false', 'State=false');

    // IsMotion 폴백 (State 없음)
    assertEq(wrap([['IsMotion', 'false']]), 'false', 'IsMotion=false fallback');

    // Value='1' → 'true' 정규화
    assertEq(wrap([['Value', '1']]),  'true',  "Value='1' → 'true'");
    assertEq(wrap([['Value', '0']]),  'false', "Value='0' → 'false'");

    // 빈 items → null
    assertEq(wrap([]), null, 'empty items → null');
  });

  // TC-PARSER-007b: RuleName 추출 — Source SimpleItem에서 ruleName 필드 반환
  await test('TC-PARSER-007b', 'RuleName SimpleItem → parsed.ruleName 필드 반환', () => {
    const xmlWithRule = makeMetadataStream(
      makeNotification(
        'tns1:VideoAnalytics/tns1:RuleAlarm',
        '2026-06-24T10:00:00.000Z',
        'Changed',
        [['VideoSourceConfigurationToken', 'VS-1'], ['RuleName', 'Zone1_Loitering']],
        [['IsActive', 'true']]
      )
    );
    const result = parseOnvifPayload(toBase64(xmlWithRule));
    assert(Array.isArray(result) && result.length === 1, 'expect 1 parsed notification');
    assertEq(result[0].ruleName, 'Zone1_Loitering', 'ruleName must be extracted from RuleName SimpleItem');

    // 이벤트가 없을 때 ruleName은 null
    const xmlNoRule = makeMetadataStream(
      makeNotification(
        'tns1:VideoSource/tns1:MotionAlarm',
        '2026-06-24T10:00:01.000Z',
        'Changed',
        [['SourceToken', 'VS-1']],
        [['State', 'true']]
      )
    );
    const result2 = parseOnvifPayload(toBase64(xmlNoRule));
    assert(Array.isArray(result2) && result2.length === 1, 'expect 1 parsed notification');
    assertEq(result2[0].ruleName, null, 'ruleName must be null when RuleName SimpleItem is absent');
  });
}

// ── Integration Tests (server required) ──────────────────────────────────────

async function runIntegrationTests() {
  console.log('\n── Integration Tests (requires server at ' + BASE_URL + ') ──');

  // 서버 가용성 확인
  let serverAvailable = false;
  try {
    const r = await get('/health');
    serverAvailable = r.status === 200;
  } catch {
    serverAvailable = false;
  }

  if (!serverAvailable) {
    console.log('  ⚠ Server not available — skipping integration tests');
    console.log('    Start server: cd server && npm run dev');
    return;
  }

  const CAM_ID = `tc-onvif-parser-${Date.now()}`;
  const APPRTP_PATH = `/api/internal/apprtp/${CAM_ID}`;

  // TC-PARSER-008: 다중 이벤트 독립 Dedup (API 통합)
  await test('TC-PARSER-008', '3개 NotificationMessage 패킷 → DB에 3개 이벤트 저장', async () => {
    // 테스트 카메라 ID에 한정하여 초기화 (전체 삭제 금지 — 운영 이벤트 보호)
    await del(`/api/onvif-events?cameraId=${CAM_ID}`);

    const xml = makeMetadataStream(
      makeNotification(
        'tns1:VideoSource/tns1:MotionAlarm',
        '2026-06-23T12:10:01.000Z', 'Changed',
        [['Source', 'VS-1']], [['State', 'true']]
      ),
      makeNotification(
        'tns1:Device/tns1:Trigger/tns1:DigitalInput',
        '2026-06-23T12:10:02.000Z', 'Changed',
        [['Index', '0']], [['Level', 'false']]
      ),
      makeNotification(
        'tns1:AudioSource/tnssamsung:AudioDetection',
        '2026-06-23T12:10:03.000Z', 'Initialized',
        [['AudioSourceToken', 'AS-0']], [['State', 'false']]
      )
    );

    const r = await post(APPRTP_PATH, { payload: toBase64(xml), pt: 96, timestamp: 0, seq: 1 });
    assertEq(r.status, 200, 'POST /apprtp status');

    // 짧은 대기 후 조회 (DB 비동기 저장 고려)
    await new Promise(res => setTimeout(res, 100));

    const q = await get(`/api/onvif-events?cameraId=${CAM_ID}&limit=20`);
    assertEq(q.status, 200, 'GET /api/onvif-events status');
    const events = q.body.events || [];
    assert(events.length >= 3, `expected ≥3 events, got ${events.length}`);

    const topics = events.map(e => e.topic);
    assert(topics.includes('tns1:VideoSource/tns1:MotionAlarm'),       'MotionAlarm stored');
    assert(topics.includes('tns1:Device/tns1:Trigger/tns1:DigitalInput'), 'DigitalInput stored');
    assert(topics.includes('tns1:AudioSource/tnssamsung:AudioDetection'), 'AudioDetection stored');
  });

  // TC-PARSER-009: 상태 변화 Dedup — 동일 state 반복 저장 방지
  // Use a SEPARATE cameraId to avoid _lastStates cache pollution from TC-PARSER-008
  // (the in-memory dedup map persists across tests; sharing CAM_ID would pre-seed the cache).
  await test('TC-PARSER-009', '동일 state 패킷 2회 전송 → DB 저장 1회만', async () => {
    const DEDUP_CAM_ID   = `tc-onvif-dedup-${Date.now()}`;
    const DEDUP_RTP_PATH = `/api/internal/apprtp/${DEDUP_CAM_ID}`;

    // 테스트 카메라 ID에 한정하여 초기화 (전체 삭제 금지 — 운영 이벤트 보호)
    await del(`/api/onvif-events?cameraId=${DEDUP_CAM_ID}`);

    const xml = makeMetadataStream(
      makeNotification(
        'tns1:VideoSource/tns1:MotionAlarm',
        '2026-06-23T12:20:00.000Z', 'Changed',
        [['SourceToken', 'VS-dedup']], [['State', 'true']]
      )
    );
    const payload = { payload: toBase64(xml), pt: 96, timestamp: 0, seq: 1 };

    // 동일 패킷 2회 전송
    await post(DEDUP_RTP_PATH, payload);
    await post(DEDUP_RTP_PATH, payload);

    await new Promise(res => setTimeout(res, 200));

    const q = await get(`/api/onvif-events?cameraId=${DEDUP_CAM_ID}&limit=20`);
    const events = (q.body.events || []).filter(e =>
      e.topic === 'tns1:VideoSource/tns1:MotionAlarm'
    );
    assertEq(events.length, 1, 'dedup: same state must be stored only once');
  });

  // TC-PARSER-010: 파싱 오류 시 200 응답 유지
  await test('TC-PARSER-010', '손상된 base64 페이로드에도 POST 200 반환', async () => {
    const r = await post(APPRTP_PATH, {
      payload: 'NOT_VALID_BASE64_!@#$%',
      pt: 96,
      timestamp: 0,
      seq: 99,
    });
    assertEq(r.status, 200, 'corrupt payload must still return 200');
  });

  // TC-PARSER-011: RuleName 기반 이벤트 분리
  // ONVIF Source SimpleItem에 Name="RuleName"이 다른 두 이벤트는 서로 다른
  // 이벤트 스트림으로 간주되어야 하며 동일 topicType이어도 별도 저장되어야 한다.
  await test('TC-PARSER-011', 'RuleName이 다른 두 이벤트 → DB에 별도 2행 저장', async () => {
    const RULE_CAM_ID   = `tc-onvif-rulename-${Date.now()}`;
    const RULE_RTP_PATH = `/api/internal/apprtp/${RULE_CAM_ID}`;

    // Cleanup before test
    await del(`/api/onvif-events?cameraId=${RULE_CAM_ID}`);

    // Event A: RuleName=Zone1
    const xmlA = makeMetadataStream(
      makeNotification(
        'tns1:VideoAnalytics/tns1:RuleAlarm',
        new Date().toISOString(),
        'Changed',
        [['VideoSourceConfigurationToken', 'VS-1'], ['RuleName', 'Zone1']],
        [['IsActive', 'true']]
      )
    );
    // Event B: RuleName=Zone2 (different rule on same source)
    const xmlB = makeMetadataStream(
      makeNotification(
        'tns1:VideoAnalytics/tns1:RuleAlarm',
        new Date().toISOString(),
        'Changed',
        [['VideoSourceConfigurationToken', 'VS-1'], ['RuleName', 'Zone2']],
        [['IsActive', 'true']]
      )
    );

    const makePayload = (xml) => ({
      payload: toBase64(xml),
      pt: 96,
      timestamp: Date.now(),
      seq: Math.floor(Math.random() * 9999),
    });

    await post(RULE_RTP_PATH, makePayload(xmlA));
    await new Promise(r => setTimeout(r, 150));
    await post(RULE_RTP_PATH, makePayload(xmlB));
    await new Promise(r => setTimeout(r, 150));

    const q = await get(`/api/onvif-events?cameraId=${RULE_CAM_ID}&limit=20`);
    assertEq(q.status, 200, 'GET /api/onvif-events status');

    const evts = q.body.events ?? [];
    const ruleNames = evts.map(e => e.ruleName).filter(Boolean);
    assert(ruleNames.includes('Zone1'), 'event with RuleName=Zone1 must be stored');
    assert(ruleNames.includes('Zone2'), 'event with RuleName=Zone2 must be stored');
    assertEq(evts.length, 2, 'two events must be stored (one per RuleName)');
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  TC_ONVIF_Metadata_Pipeline — Parser & Integration Tests ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  await runUnitTests();

  if (!UNIT_ONLY) {
    await runIntegrationTests();
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('──────────────────────────────────────────────────────────');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
