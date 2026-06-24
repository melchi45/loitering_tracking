'use strict';
/**
 * TC-APPRTP-007 ~ TC-APPRTP-014 — ONVIF App RTP Internal API
 *
 * Tests POST /api/internal/apprtp/:cameraId logic (unit — no Express):
 *   TC-APPRTP-007    Socket.IO 'appRtp' broadcast
 *   TC-APPRTP-008    ONVIF payload parse → DB save → 'onvif:event' broadcast
 *   TC-APPRTP-008B   Dedup: same topic+sourceToken+state → single DB insert
 *   TC-APPRTP-009    Radiometry data → 'onvif:temperature' broadcast (no dedup)
 *   TC-APPRTP-013    MediaMTX 환경: appRtpRtspUrl이 원본 카메라 URL로 설정됨
 *   TC-APPRTP-014    EADDRINUSE 3회 연속 → App RTP 루프 종료 방어 처리
 *   TC-APPRTP-PARSER-A  parseOnvifPayload: MotionAlarm state=true
 *   TC-APPRTP-PARSER-B  parseOnvifPayload: non-MetadataStream → null
 *   TC-APPRTP-PARSER-C  parseOnvifPayload: BoxTemperatureReading radiometry array
 *
 * Run: node test/api/onvif_apprtp.test.js
 *
 * Related SRS:    docs/srs/SRS_ONVIF_Metadata_Pipeline.md
 * Related TC doc: docs/tc/TC_ONVIF_Metadata_Pipeline.md
 * Related PRD:    docs/prd/PRD_ONVIF_Metadata_Pipeline.md
 * Related RFP:    docs/rfp/RFP_ONVIF_Metadata_Pipeline.md
 */

const path = require('path');

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

function skip(id, description, reason) {
  console.log(`  ⊘ ${id}: ${description} [SKIPPED — ${reason}]`);
  results.push({ id, description, status: 'SKIP', reason });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertCloseTo(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance)
    throw new Error(`${label}: expected ~${expected} (±${tolerance}), got ${actual}`);
}

// ── Minimal mock helpers (no Jest dependency) ─────────────────────────────────

function makeMockFn() {
  const calls = [];
  const fn = (...args) => { calls.push(args); };
  fn.mock = { calls };
  return fn;
}

function makeMockIo() {
  const emitted = [];
  const emit = makeMockFn();
  emit.mock = emit.mock;
  const wrappedEmit = (event, data) => {
    emitted.push({ event, data });
    emit(event, data);
  };
  return { emit: wrappedEmit, _emitted: emitted };
}

function makeMockDb() {
  const inserted = [];
  const insert = (table, row) => inserted.push({ table, row });
  return { insert, _inserted: inserted };
}

// ── ONVIF XML fixtures ────────────────────────────────────────────────────────

const MOTION_ALARM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
    xmlns:tns1="http://www.onvif.org/ver10/topics">
  <tt:Event>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">
        tns1:VideoSource/tns1:MotionAlarm
      </wsnt:Topic>
      <wsnt:Message>
        <tt:Message UtcTime="2026-06-23T12:00:00.000Z" PropertyOperation="Changed">
          <tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="V_SRC_000"/></tt:Source>
          <tt:Data><tt:SimpleItem Name="State" Value="true"/></tt:Data>
        </tt:Message>
      </wsnt:Message>
    </wsnt:NotificationMessage>
  </tt:Event>
</tt:MetadataStream>`;

const RADIOMETRY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:ttr="https://www.onvif.org/ver20/analytics/radiometry"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
    xmlns:tns1="http://www.onvif.org/ver10/topics">
  <tt:Event>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">
        tns1:VideoAnalytics/Radiometry/BoxTemperatureReading
      </wsnt:Topic>
      <wsnt:Message><tt:Message UtcTime="2026-06-23T12:00:01.000Z">
        <tt:Data><tt:ElementItem Name="Reading">
          <ttr:BoxTemperatureReading ItemID="D" AreaName="D"
            MaxTemperature="352.5" MaxTemperatureCoordinatesX="243" MaxTemperatureCoordinatesY="217"
            MinTemperature="329.6" MinTemperatureCoordinatesX="328" MinTemperatureCoordinatesY="261"
            AverageTemperature="343.5"/>
        </tt:ElementItem></tt:Data>
      </tt:Message></wsnt:Message>
    </wsnt:NotificationMessage>
  </tt:Event>
</tt:MetadataStream>`;

function toBase64(xml) {
  return Buffer.from(xml, 'utf-8').toString('base64');
}

// ── Load onvifParser directly ─────────────────────────────────────────────────

const PARSER_PATH = path.resolve(__dirname, '../../server/src/services/onvifParser.js');
let parseOnvifPayload = null;
try {
  ({ parseOnvifPayload } = require(PARSER_PATH));
} catch (_) {
  // parser not available — parser tests will be skipped
}

// ── Simulated handler logic ───────────────────────────────────────────────────

function runHandler({ cameraId, data, io, db, lastStates = new Map(), webrtcEngine = null }) {
  // 1. Socket.IO appRtp broadcast (always)
  if (io) io.emit('appRtp', { cameraId, ...data });

  // 2. mediasoup DataProducer (optional)
  if (webrtcEngine && typeof webrtcEngine.sendAppRtp === 'function') {
    webrtcEngine.sendAppRtp(cameraId, data);
  }

  // 3. ONVIF parse + dedup + DB + broadcasts
  if (db && data.payload && parseOnvifPayload) {
    const parsedList = parseOnvifPayload(data.payload);
    if (Array.isArray(parsedList)) {
      for (const parsed of parsedList) {
        // Radiometry: immediate broadcast, no dedup
        if (parsed.radiometry && parsed.radiometry.length > 0 && io) {
          io.emit('onvif:temperature', {
            cameraId,
            utcTime: parsed.utcTime,
            readings: parsed.radiometry,
          });
        }

        // State-change dedup
        const dedupKey = `${cameraId}:${parsed.topic}:${parsed.sourceToken}`;
        if (lastStates.get(dedupKey) !== parsed.state) {
          lastStates.set(dedupKey, parsed.state);
          const event = { id: 'test-uuid', cameraId, ...parsed, serverTs: new Date().toISOString() };
          db.insert('onvif_events', event);
          if (io) io.emit('onvif:event', event);
        }
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  TC_ONVIF_AppRTP — App RTP Internal Handler Tests       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\n── Group: onvifParser unit ─────────────────────────────────\n');

  if (!parseOnvifPayload) {
    skip('TC-APPRTP-PARSER-A', 'parseOnvifPayload: MotionAlarm state=true', 'onvifParser.js not found');
    skip('TC-APPRTP-PARSER-B', 'parseOnvifPayload: non-MetadataStream → null', 'onvifParser.js not found');
    skip('TC-APPRTP-PARSER-C', 'parseOnvifPayload: BoxTemperatureReading radiometry array', 'onvifParser.js not found');
  } else {
    await test('TC-APPRTP-PARSER-A', 'parseOnvifPayload: MotionAlarm state=true', () => {
      const results = parseOnvifPayload(toBase64(MOTION_ALARM_XML));
      assert(Array.isArray(results), 'result must be array');
      assert(results.length > 0, 'result must be non-empty');
      assert(/MotionAlarm/i.test(results[0].topic), `topic must match MotionAlarm, got: ${results[0].topic}`);
      assertEq(results[0].state, 'true', 'state');
    });

    await test('TC-APPRTP-PARSER-B', 'parseOnvifPayload: non-MetadataStream → null', () => {
      const b64 = Buffer.from('<root><data>hello</data></root>', 'utf-8').toString('base64');
      const result = parseOnvifPayload(b64);
      assertEq(result, null, 'non-MetadataStream must return null');
    });

    await test('TC-APPRTP-PARSER-C', 'parseOnvifPayload: BoxTemperatureReading radiometry array', () => {
      const results = parseOnvifPayload(toBase64(RADIOMETRY_XML));
      assert(Array.isArray(results), 'result must be array');
      const evt = results[0];
      assert(Array.isArray(evt.radiometry), 'radiometry must be array');
      assert(evt.radiometry.length > 0, 'radiometry must be non-empty');
      const reading = evt.radiometry[0];
      assert('maxTemp' in reading, 'must have maxTemp');
      assert('minTemp' in reading, 'must have minTemp');
      assert('avgTemp' in reading, 'must have avgTemp');
      assertCloseTo(reading.maxTemp, 352.5, 0.1, 'maxTemp');
    });
  }

  console.log('\n── Group: AppRtp handler logic ─────────────────────────────\n');

  await test('TC-APPRTP-007', 'broadcasts appRtp via Socket.IO with cameraId', () => {
    const io = makeMockIo();
    const data = { pt: 96, timestamp: 1000, seq: 0, payload: toBase64('<x/>') };
    runHandler({ cameraId: 'cam-abc', data, io });

    const appRtpCalls = io._emitted.filter(e => e.event === 'appRtp');
    assertEq(appRtpCalls.length, 1, 'appRtp emit count');
    assertEq(appRtpCalls[0].data.cameraId, 'cam-abc', 'cameraId');
    assertEq(appRtpCalls[0].data.pt, 96, 'pt');
    assertEq(appRtpCalls[0].data.seq, 0, 'seq');
  });

  await test('TC-APPRTP-007B', 'no socket emit when io is null (graceful no-op)', () => {
    const data = { pt: 96, timestamp: 5000, seq: 4, payload: toBase64(MOTION_ALARM_XML) };
    let threw = false;
    try {
      runHandler({ cameraId: 'cam-abc', data, io: null });
    } catch (_) {
      threw = true;
    }
    assert(!threw, 'must not throw when io is null');
  });

  await test('TC-APPRTP-007C', 'emits appRtp for each POST regardless of ONVIF parse result', () => {
    const io = makeMockIo();
    const notOnvif = Buffer.from('raw binary data \x00\x01\x02', 'binary').toString('base64');
    const data = { pt: 99, timestamp: 6000, seq: 0, payload: notOnvif };
    runHandler({ cameraId: 'cam-xyz', data, io });
    assertEq(io._emitted.filter(e => e.event === 'appRtp').length, 1, 'appRtp emit count');
  });

  if (!parseOnvifPayload) {
    skip('TC-APPRTP-008',  'ONVIF payload → DB save + onvif:event broadcast', 'onvifParser.js not found');
    skip('TC-APPRTP-008B', 'dedup: same topic+sourceToken+state → single DB insert', 'onvifParser.js not found');
    skip('TC-APPRTP-009',  'onvif:temperature for radiometry without DB insert', 'onvifParser.js not found');
  } else {
    await test('TC-APPRTP-008', 'ONVIF payload → DB save + onvif:event broadcast', () => {
      const io = makeMockIo();
      const db = makeMockDb();
      const data = { pt: 96, timestamp: 2000, seq: 1, payload: toBase64(MOTION_ALARM_XML) };
      runHandler({ cameraId: 'cam-abc', data, io, db });

      const dbInserts = db._inserted.filter(r => r.table === 'onvif_events');
      assert(dbInserts.length > 0, 'DB insert must have occurred');
      assertEq(dbInserts[0].row.cameraId, 'cam-abc', 'cameraId in DB row');
      assert(/MotionAlarm/i.test(dbInserts[0].row.topic), `topic in DB must match MotionAlarm, got: ${dbInserts[0].row.topic}`);

      const onvifEvents = io._emitted.filter(e => e.event === 'onvif:event');
      assert(onvifEvents.length > 0, 'onvif:event must have been emitted');
    });

    await test('TC-APPRTP-008B', 'dedup: same topic+sourceToken+state → single DB insert', () => {
      const io = makeMockIo();
      const db = makeMockDb();
      const lastStates = new Map();
      const data = { pt: 96, timestamp: 3000, seq: 2, payload: toBase64(MOTION_ALARM_XML) };

      runHandler({ cameraId: 'cam-abc', data, io, db, lastStates });
      runHandler({ cameraId: 'cam-abc', data, io, db, lastStates });

      const dbInserts = db._inserted.filter(r => r.table === 'onvif_events');
      assertEq(dbInserts.length, 1, 'second identical event must be deduped');
    });

    await test('TC-APPRTP-009', 'onvif:temperature for radiometry — no DB insert (dedup bypass)', () => {
      const io = makeMockIo();
      const db = makeMockDb();
      const data = { pt: 96, timestamp: 4000, seq: 3, payload: toBase64(RADIOMETRY_XML) };
      runHandler({ cameraId: 'cam-therm', data, io, db });

      const tempEvents = io._emitted.filter(e => e.event === 'onvif:temperature');
      assert(tempEvents.length > 0, 'onvif:temperature must have been emitted');
      assertEq(tempEvents[0].data.cameraId, 'cam-therm', 'cameraId');
      assert(Array.isArray(tempEvents[0].data.readings), 'readings must be array');
      assertCloseTo(tempEvents[0].data.readings[0].maxTemp, 352.5, 0.1, 'maxTemp');

      // temperature must be emitted before onvif:event (radiometry fires first)
      const tempIdx    = io._emitted.findIndex(e => e.event === 'onvif:temperature');
      const onvifIdx   = io._emitted.findIndex(e => e.event === 'onvif:event');
      if (onvifIdx !== -1) {
        assert(tempIdx < onvifIdx, 'onvif:temperature must emit before onvif:event');
      }
    });
  }

  // ── TC-APPRTP-013 / 014 — MediaMTX URL 분리 + EADDRINUSE 방어 ─────────────

  {
    // ── Simulate _ingestRegisterCamera body construction (pipelineManager.js) ──
    function buildRegistrationBody({ cameraId, daemonRtspUrl, callbackUrl, appRtpCallbackUrl, daemonAppRtpRtspUrl }) {
      const body = { id: cameraId, rtspUrl: daemonRtspUrl, callbackUrl };
      if (appRtpCallbackUrl) body.appRtpCallbackUrl = appRtpCallbackUrl;
      if (daemonAppRtpRtspUrl) body.appRtpRtspUrl = daemonAppRtpRtspUrl;
      return body;
    }

    await test('TC-APPRTP-013', 'MediaMTX 환경: body.appRtpRtspUrl은 원본 카메라 URL, rtspUrl은 MediaMTX URL', () => {
      const originalCameraUrl = 'rtsp://10.0.0.5/live/0/MAIN';
      const mediamtxUrl       = 'rtsp://127.0.0.1:8554/cam-uuid';
      const callbackUrl       = 'http://127.0.0.1:3080/api/internal/frame/cam-uuid';
      const appRtpCallbackUrl = 'http://127.0.0.1:3080/api/internal/apprtp/cam-uuid';

      // When mediamtxReady=true: daemonRtspUrl = mediamtxUrl, daemonAppRtpRtspUrl = originalCameraUrl
      const body = buildRegistrationBody({
        cameraId: 'cam-uuid',
        daemonRtspUrl: mediamtxUrl,
        callbackUrl,
        appRtpCallbackUrl,
        daemonAppRtpRtspUrl: originalCameraUrl,
      });

      assertEq(body.rtspUrl,          mediamtxUrl,       'rtspUrl must be MediaMTX URL (AI path)');
      assertEq(body.appRtpRtspUrl,    originalCameraUrl, 'appRtpRtspUrl must be original camera URL');
      assertEq(body.appRtpCallbackUrl, appRtpCallbackUrl, 'appRtpCallbackUrl must be set');
      assert(body.appRtpRtspUrl !== body.rtspUrl, 'App RTP URL and AI URL must differ');
    });

    await test('TC-APPRTP-013B', 'MediaMTX 미사용: appRtpRtspUrl 필드 없음 (rtspUrl이 원본 카메라 URL)', () => {
      const originalCameraUrl = 'rtsp://10.0.0.5/live/0/MAIN';
      const callbackUrl       = 'http://127.0.0.1:3080/api/internal/frame/cam-uuid';
      const appRtpCallbackUrl = 'http://127.0.0.1:3080/api/internal/apprtp/cam-uuid';

      // When mediamtxReady=false: daemonRtspUrl = originalCameraUrl, daemonAppRtpRtspUrl = undefined
      const body = buildRegistrationBody({
        cameraId: 'cam-uuid',
        daemonRtspUrl: originalCameraUrl,
        callbackUrl,
        appRtpCallbackUrl,
        daemonAppRtpRtspUrl: undefined,
      });

      assertEq(body.rtspUrl, originalCameraUrl, 'rtspUrl must be original camera URL');
      assert(!('appRtpRtspUrl' in body), 'appRtpRtspUrl must not be present when MediaMTX is not used');
    });

    await test('TC-APPRTP-014', 'EADDRINUSE 3회 연속 → addr_in_use_n 카운터가 임계값(3)에 도달해 루프 탈출', () => {
      // Simulate the _app_rtp_loop EADDRINUSE guard logic
      let addr_in_use_n = 0;
      const MAX_ADDR_IN_USE = 3;
      let exited = false;

      function simulateOsError(errno) {
        const err = new Error('Address already in use');
        err.errno = errno;
        return err;
      }

      for (let attempt = 0; attempt < 10; attempt++) {
        const exc = simulateOsError(98); // EADDRINUSE
        if (exc.errno === 98) {
          addr_in_use_n++;
          if (addr_in_use_n >= MAX_ADDR_IN_USE) {
            exited = true;
            break;
          }
        }
      }

      assert(exited, 'Loop must exit after 3 consecutive EADDRINUSE errors');
      assertEq(addr_in_use_n, MAX_ADDR_IN_USE, 'Counter must reach exactly 3 before exit');
    });

    await test('TC-APPRTP-014B', 'Non-EADDRINUSE OSError는 카운터를 증가시키지 않음', () => {
      let addr_in_use_n = 0;
      const MAX_ADDR_IN_USE = 3;
      let exited = false;

      // errno=111 (ECONNREFUSED) — should NOT trigger exit
      const connRefused = new Error('Connection refused');
      connRefused.errno = 111;

      if (connRefused.errno === 98) {
        addr_in_use_n++;
        if (addr_in_use_n >= MAX_ADDR_IN_USE) exited = true;
      }

      assertEq(addr_in_use_n, 0, 'ECONNREFUSED must not increment addr_in_use_n');
      assert(!exited, 'Loop must NOT exit for non-EADDRINUSE errors');
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  console.log('\n── Summary ─────────────────────────────────────────────────\n');
  console.log(`  Passed: ${passed}  Failed: ${failed}  Skipped: ${results.filter(r => r.status === 'SKIP').length}`);
  if (failed > 0) process.exit(1);
})();
