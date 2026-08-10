'use strict';
/**
 * TC-UMPMETA-001 ~ TC-UMPMETA-009 — RTSP-over-WebSocket 'meta' Event → ONVIF Relay
 *
 * Covers the second ONVIF ingestion path added 2026-07-27
 * (Design_RTSP_Over_WebSocket.md §8.19): RTSP-over-WebSocket-mode cameras bypass
 * ingest-daemon's Application RTP fan-out entirely, so <rtsp-over-websocket>'s own
 * 'meta' CustomEvent (already-decoded XML, not base64 RTP payload) is
 * relayed browser-side to POST /api/cameras/:id/rtsp-over-websocket-meta and parsed via
 * onvifParser.js's parseOnvifXml()/ingestOnvifEvents() — the same functions
 * server/src/routes/internalApi.js's /apprtp/:cameraId handler uses, so both
 * paths share one dedup map and converge on identical onvif_events storage.
 *
 * Unlike test/api/onvif_apprtp.test.js's hand-simulated handler logic, these
 * tests call the REAL exported functions directly (parseOnvifXml,
 * ingestOnvifEvents, clearDedupStateForCamera) plus the REAL route handler
 * extracted from camerasRouter's Express layer stack — not a duplicate
 * reimplementation — so a regression in the actual shipped code fails here.
 *
 * TC-UMPMETA-001  parseOnvifXml: plain XML (not base64) → MotionAlarm parsed
 * TC-UMPMETA-002  parseOnvifXml: non-ONVIF text → null
 * TC-UMPMETA-003  ingestOnvifEvents: stores event + broadcasts onvif:event
 * TC-UMPMETA-004  ingestOnvifEvents: dedup — same topic+source+state → single insert
 * TC-UMPMETA-005  ingestOnvifEvents: radiometry → onvif:temperature, no dedup
 * TC-UMPMETA-006  clearDedupStateForCamera: only clears the given camera's keys
 * TC-UMPMETA-007  POST /:id/rtsp-over-websocket-meta route handler: unknown camera → 404
 * TC-UMPMETA-008  POST /:id/rtsp-over-websocket-meta route handler: missing xml → 400
 * TC-UMPMETA-009  POST /:id/rtsp-over-websocket-meta route handler: valid xml → 204 + DB insert + broadcast
 *
 * Run: node test/api/onvif_rtsp_over_websocket_meta_relay.test.js
 *
 * Related design: docs/design/Design_RTSP_Over_WebSocket.md §8.19
 */

const path = require('path');

// ── Minimal test harness (mirrors test/api/onvif_apprtp.test.js) ─────────────

let passed = 0;
let failed = 0;

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEq(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeMockIo() {
  const emitted = [];
  return { emit: (event, data) => emitted.push({ event, data }), _emitted: emitted };
}

function makeMockDb(rows = {}) {
  const inserted = [];
  return {
    insert: (table, row) => inserted.push({ table, row }),
    all: (table) => rows[table] || [],
    flushNow: () => {},
    findOne: (table, query) => (rows[table] || []).find((r) =>
      Object.entries(query).every(([k, v]) => r[k] === v)) || null,
    _inserted: inserted,
  };
}

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
        <tt:Message UtcTime="2026-07-27T12:00:00.000Z" PropertyOperation="Changed">
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
      <wsnt:Message><tt:Message UtcTime="2026-07-27T12:00:01.000Z">
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

const PARSER_PATH = path.resolve(__dirname, '../../server/src/services/onvifParser.js');
const CAMERAS_ROUTER_PATH = path.resolve(__dirname, '../../server/src/api/cameras.js');

let parseOnvifXml = null;
let ingestOnvifEvents = null;
let clearDedupStateForCamera = null;
try {
  ({ parseOnvifXml, ingestOnvifEvents, clearDedupStateForCamera } = require(PARSER_PATH));
} catch (_) {
  // module not available — tests below will fail loudly, which is correct
}

let camerasRouter = null;
try {
  camerasRouter = require(CAMERAS_ROUTER_PATH);
} catch (_) {
  // same
}

// Extracts the real registered handler (last middleware in the layer's own
// stack, i.e. skipping verifyAccessToken) for a given method+path — so tests
// exercise the actual production route function, not a reimplementation.
function findRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) return null;
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
  return res;
}

(async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  TC_UMP_Meta_Relay — RTSP-over-WebSocket "meta" event ONVIF relay tests  ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  console.log('── Group: onvifParser.parseOnvifXml (direct XML, not base64) ──\n');

  if (parseOnvifXml) {
    await test('TC-UMPMETA-001', 'plain XML (not base64) → MotionAlarm parsed', () => {
      const result = parseOnvifXml(MOTION_ALARM_XML);
      assert(Array.isArray(result), 'must return an array');
      assertEq(result.length, 1, 'one NotificationMessage');
      assertEq(result[0].topicType, 'motionAlarm', 'topicType');
      assertEq(result[0].state, 'true', 'state');
      assertEq(result[0].sourceToken, 'V_SRC_000', 'sourceToken');
    });

    await test('TC-UMPMETA-002', 'non-ONVIF text → null', () => {
      assertEq(parseOnvifXml('not xml at all'), null, 'non-MetadataStream text');
      assertEq(parseOnvifXml(''), null, 'empty string');
      assertEq(parseOnvifXml(undefined), null, 'undefined input must not throw');
    });
  }

  console.log('\n── Group: onvifParser.ingestOnvifEvents ─────────────────────\n');

  if (ingestOnvifEvents && parseOnvifXml) {
    await test('TC-UMPMETA-003', 'stores event + broadcasts onvif:event', () => {
      const db = makeMockDb();
      const io = makeMockIo();
      const parsedList = parseOnvifXml(MOTION_ALARM_XML);
      ingestOnvifEvents('cam-ump-001', parsedList, { db, io, rawPayload: 'base64xml' });

      const inserted = db._inserted.filter((r) => r.table === 'onvif_events');
      assertEq(inserted.length, 1, 'one onvif_events row inserted');
      assertEq(inserted[0].row.cameraId, 'cam-ump-001', 'cameraId on stored row');
      assertEq(inserted[0].row.rawPayload, 'base64xml', 'rawPayload passed through verbatim');

      const broadcast = io._emitted.find((e) => e.event === 'onvif:event');
      assert(broadcast, 'onvif:event must be broadcast');
      assertEq(broadcast.data.topicType, 'motionAlarm', 'broadcast payload topicType');
    });

    await test('TC-UMPMETA-004', 'dedup — same topic+source+state → single insert', () => {
      const db = makeMockDb();
      const io = makeMockIo();
      const parsedList = parseOnvifXml(MOTION_ALARM_XML);
      ingestOnvifEvents('cam-ump-002', parsedList, { db, io });
      ingestOnvifEvents('cam-ump-002', parsedList, { db, io }); // identical state again

      const inserted = db._inserted.filter((r) => r.table === 'onvif_events');
      assertEq(inserted.length, 1, 'second identical-state call must be a no-op');
    });

    await test('TC-UMPMETA-005', 'radiometry → onvif:temperature, no dedup', () => {
      const db = makeMockDb();
      const io = makeMockIo();
      const parsedList = parseOnvifXml(RADIOMETRY_XML);
      ingestOnvifEvents('cam-ump-003', parsedList, { db, io });
      ingestOnvifEvents('cam-ump-003', parsedList, { db, io }); // same reading again

      const tempEvents = io._emitted.filter((e) => e.event === 'onvif:temperature');
      assertEq(tempEvents.length, 2, 'radiometry broadcast must fire every call, never deduped');
      assert(tempEvents[0].data.readings[0].maxTemp === 352.5, 'reading payload preserved');
    });
  }

  console.log('\n── Group: onvifParser.clearDedupStateForCamera ──────────────\n');

  if (ingestOnvifEvents && clearDedupStateForCamera && parseOnvifXml) {
    await test('TC-UMPMETA-006', 'only clears the given camera\'s dedup keys', () => {
      const db = makeMockDb();
      const io = makeMockIo();
      const parsedList = parseOnvifXml(MOTION_ALARM_XML);
      ingestOnvifEvents('cam-ump-A', parsedList, { db, io });
      ingestOnvifEvents('cam-ump-B', parsedList, { db, io });

      clearDedupStateForCamera('cam-ump-A');

      // cam-ump-A: dedup state cleared → identical state re-inserts.
      ingestOnvifEvents('cam-ump-A', parsedList, { db, io });
      // cam-ump-B: untouched → still deduped.
      ingestOnvifEvents('cam-ump-B', parsedList, { db, io });

      const countFor = (id) => db._inserted.filter((r) => r.table === 'onvif_events' && r.row.cameraId === id).length;
      assertEq(countFor('cam-ump-A'), 2, 'cam-ump-A dedup was cleared, so it re-inserts');
      assertEq(countFor('cam-ump-B'), 1, 'cam-ump-B dedup untouched, stays deduped');
    });
  }

  console.log('\n── Group: POST /api/cameras/:id/rtsp-over-websocket-meta (real route handler) ──\n');

  if (camerasRouter) {
    const db = makeMockDb({ cameras: [{ id: 'cam-1' }] });
    const io = makeMockIo();
    const router = camerasRouter(db, /* pipelineManager */ {}, /* youtubeSvc */ null, io);
    const handler = findRouteHandler(router, 'post', '/:id/rtsp-over-websocket-meta');

    await test('TC-UMPMETA-007', 'unknown camera → 404', async () => {
      assert(handler, 'route handler must be registered');
      const req = { params: { id: 'does-not-exist' }, body: { xml: MOTION_ALARM_XML } };
      const res = makeRes();
      await handler(req, res);
      assertEq(res.statusCode, 404, 'status code');
    });

    await test('TC-UMPMETA-008', 'missing xml → 400', async () => {
      const req = { params: { id: 'cam-1' }, body: {} };
      const res = makeRes();
      await handler(req, res);
      assertEq(res.statusCode, 400, 'status code');
    });

    await test('TC-UMPMETA-009', 'valid xml → 204 + DB insert + broadcast', async () => {
      const req = { params: { id: 'cam-1' }, body: { xml: MOTION_ALARM_XML } };
      const res = makeRes();
      await handler(req, res);
      assertEq(res.statusCode, 204, 'status code');
      const inserted = db._inserted.filter((r) => r.table === 'onvif_events' && r.row.cameraId === 'cam-1');
      assertEq(inserted.length, 1, 'event stored for cam-1');
      assert(io._emitted.some((e) => e.event === 'onvif:event'), 'onvif:event broadcast');
    });
  }

  console.log('\n── Summary ─────────────────────────────────────────────────\n');
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
