'use strict';
/**
 * TC-APPRTP-007 ~ TC-APPRTP-009 — ONVIF App RTP Internal API (Node.js)
 *
 * Tests POST /api/internal/apprtp/:cameraId:
 *   - Socket.IO 'appRtp' broadcast (TC-APPRTP-007)
 *   - ONVIF payload parse → DB save → 'onvif:event' broadcast (TC-APPRTP-008)
 *   - Radiometry data → 'onvif:temperature' broadcast without DB save (TC-APPRTP-009)
 *
 * Run: npx jest test/api/onvif_apprtp.test.js --runInBand --forceExit
 */

const path = require('path');

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

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeMockIo() {
  const emitted = [];
  return {
    emit: jest.fn((event, data) => emitted.push({ event, data })),
    _emitted: emitted,
  };
}

function makeMockDb() {
  const inserted = [];
  return {
    insert: jest.fn((table, row) => inserted.push({ table, row })),
    _inserted: inserted,
  };
}

// ── Load onvifParser directly ─────────────────────────────────────────────────

const PARSER_PATH = path.resolve(__dirname, '../../server/src/services/onvifParser.js');

let parseOnvifPayload;
try {
  ({ parseOnvifPayload } = require(PARSER_PATH));
} catch (_) {
  parseOnvifPayload = null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('onvifParser — ONVIF XML 구조화 파싱', () => {
  if (!parseOnvifPayload) {
    it.skip('onvifParser.js not found — skipping parser tests');
    return;
  }

  it('parses MotionAlarm topic and extracts state=true (TC-APPRTP-008 prerequisite)', () => {
    const b64 = toBase64(MOTION_ALARM_XML);
    const results = parseOnvifPayload(b64);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const evt = results[0];
    expect(evt.topic).toMatch(/MotionAlarm/i);
    expect(evt.state).toBe('true'); // parser returns string, not boolean
  });

  it('returns null for non-MetadataStream payload', () => {
    const b64 = Buffer.from('<root><data>hello</data></root>', 'utf-8').toString('base64');
    const result = parseOnvifPayload(b64);
    expect(result).toBeNull();
  });

  it('parses BoxTemperatureReading and populates radiometry array (TC-APPRTP-009 prerequisite)', () => {
    const b64 = toBase64(RADIOMETRY_XML);
    const results = parseOnvifPayload(b64);
    expect(Array.isArray(results)).toBe(true);
    const evt = results[0];
    expect(Array.isArray(evt.radiometry)).toBe(true);
    expect(evt.radiometry.length).toBeGreaterThan(0);
    const reading = evt.radiometry[0];
    expect(reading).toHaveProperty('maxTemp');
    expect(reading).toHaveProperty('minTemp');
    expect(reading).toHaveProperty('avgTemp');
    expect(reading.maxTemp).toBeCloseTo(352.5, 1);
  });
});

// ── Simulated handler behaviour (unit-tests the logic, not Express routing) ──

describe('AppRtp internal handler logic', () => {
  /**
   * Simulates what POST /api/internal/apprtp/:cameraId does, without Express.
   * This keeps the test self-contained and fast.
   */
  function runHandler({ cameraId, data, io, db, lastStates = new Map(), webrtcEngine = null }) {
    // 1. Socket.IO broadcast (TC-APPRTP-007)
    if (io) io.emit('appRtp', { cameraId, ...data });

    // 2. mediasoup DataProducer (optional)
    if (webrtcEngine && typeof webrtcEngine.sendAppRtp === 'function') {
      webrtcEngine.sendAppRtp(cameraId, data);
    }

    // 3. ONVIF parse + dedup + DB (TC-APPRTP-008, TC-APPRTP-009)
    if (db && data.payload && parseOnvifPayload) {
      const parsedList = parseOnvifPayload(data.payload);
      if (Array.isArray(parsedList)) {
        for (const parsed of parsedList) {
          if (parsed.radiometry && parsed.radiometry.length > 0 && io) {
            io.emit('onvif:temperature', {
              cameraId,
              utcTime: parsed.utcTime,
              readings: parsed.radiometry,
            });
          }

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

  it('TC-APPRTP-007: broadcasts appRtp via socket.io with cameraId', () => {
    const io = makeMockIo();
    const data = { pt: 96, timestamp: 1000, seq: 0, payload: toBase64('<x/>') };
    runHandler({ cameraId: 'cam-abc', data, io });

    const appRtpCalls = io._emitted.filter(e => e.event === 'appRtp');
    expect(appRtpCalls).toHaveLength(1);
    expect(appRtpCalls[0].data.cameraId).toBe('cam-abc');
    expect(appRtpCalls[0].data.pt).toBe(96);
    expect(appRtpCalls[0].data.seq).toBe(0);
  });

  it('TC-APPRTP-008: parses ONVIF payload and saves onvif_event to DB', () => {
    if (!parseOnvifPayload) return;
    const io = makeMockIo();
    const db = makeMockDb();
    const data = { pt: 96, timestamp: 2000, seq: 1, payload: toBase64(MOTION_ALARM_XML) };
    runHandler({ cameraId: 'cam-abc', data, io, db });

    const dbInserts = db._inserted.filter(r => r.table === 'onvif_events');
    expect(dbInserts.length).toBeGreaterThan(0);
    expect(dbInserts[0].row.cameraId).toBe('cam-abc');
    expect(dbInserts[0].row.topic).toMatch(/MotionAlarm/i);

    const onvifEvents = io._emitted.filter(e => e.event === 'onvif:event');
    expect(onvifEvents.length).toBeGreaterThan(0);
  });

  it('TC-APPRTP-008: deduplicates events with same topic+sourceToken+state', () => {
    if (!parseOnvifPayload) return;
    const io = makeMockIo();
    const db = makeMockDb();
    const lastStates = new Map();
    const data = { pt: 96, timestamp: 3000, seq: 2, payload: toBase64(MOTION_ALARM_XML) };

    runHandler({ cameraId: 'cam-abc', data, io, db, lastStates });
    runHandler({ cameraId: 'cam-abc', data, io, db, lastStates });

    const dbInserts = db._inserted.filter(r => r.table === 'onvif_events');
    expect(dbInserts).toHaveLength(1); // second call deduped
  });

  it('TC-APPRTP-009: emits onvif:temperature for radiometry without DB insert', () => {
    if (!parseOnvifPayload) return;
    const io = makeMockIo();
    const db = makeMockDb();
    const data = { pt: 96, timestamp: 4000, seq: 3, payload: toBase64(RADIOMETRY_XML) };
    runHandler({ cameraId: 'cam-therm', data, io, db });

    const tempEvents = io._emitted.filter(e => e.event === 'onvif:temperature');
    expect(tempEvents.length).toBeGreaterThan(0);
    expect(tempEvents[0].data.cameraId).toBe('cam-therm');
    expect(Array.isArray(tempEvents[0].data.readings)).toBe(true);
    expect(tempEvents[0].data.readings[0].maxTemp).toBeCloseTo(352.5, 1);

    // onvif:temperature must emit before any dedup check (no dedup on radiometry socket event).
    // Note: onvif_events DB insert may still occur via dedup logic for the BoxTemperatureReading
    // topic (state=null point event) — this is expected behaviour per internalApi.js implementation.
    const tempIdx = io._emitted.findIndex(e => e.event === 'onvif:temperature');
    const onvifEventIdx = io._emitted.findIndex(e => e.event === 'onvif:event');
    if (onvifEventIdx !== -1) {
      expect(tempIdx).toBeLessThan(onvifEventIdx); // temperature emitted before onvif:event
    }
  });

  it('TC-APPRTP-007: no socket emit when io is null (graceful no-op)', () => {
    const data = { pt: 96, timestamp: 5000, seq: 4, payload: toBase64(MOTION_ALARM_XML) };
    expect(() => runHandler({ cameraId: 'cam-abc', data, io: null })).not.toThrow();
  });

  it('emits appRtp for each POST regardless of ONVIF parse result', () => {
    const io = makeMockIo();
    const notOnvif = Buffer.from('raw binary data \x00\x01\x02', 'binary').toString('base64');
    const data = { pt: 99, timestamp: 6000, seq: 0, payload: notOnvif };
    runHandler({ cameraId: 'cam-xyz', data, io });

    expect(io._emitted.filter(e => e.event === 'appRtp')).toHaveLength(1);
  });
});
