'use strict';
/**
 * WebRTC Client Telemetry Relay Tests
 *
 * TC: TC-LTS-WRTC-01
 *   Group I — Client Telemetry Relay (TC-I-001 ~ TC-I-004)
 *
 * Tests the Socket.IO telemetry path without a browser dependency by
 * registering the real WebRTC signaling handlers against a mock socket.
 *
 * Run: node test/api/webrtc_telemetry.test.js
 */

const registerWebRTCTelemetryHandlers = require('../../server/src/socket/webrtcTelemetryHandlers');
const telemetry = require('../../server/src/socket/webrtcTelemetry');

let passed = 0;
let failed = 0;

async function test(id, description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${id}: ${description}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✗ ${id}: ${description}`);
    console.error(`      ${err.message}`);
    failed += 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

class MockSocket {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
    this.emitted = [];
    this.rooms = new Set();
    this.disconnected = false;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  off(event) {
    this.handlers.delete(event);
  }

  join(room) {
    this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  emit(event, payload, cb) {
    this.emitted.push({ event, payload });
    if (typeof cb === 'function') cb();
  }

  trigger(event, payload, cb) {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler registered for ${event}`);
    return handler(payload, cb);
  }
}

function createMockIo() {
  const broadcast = [];
  return {
    broadcast,
    to(room) {
      return {
        emit(event, payload) {
          broadcast.push({ room, event, payload });
        },
      };
    },
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TC-LTS-WRTC-01 — Client Telemetry Relay Tests      ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  telemetry.clearTelemetry();

  const io = createMockIo();
  const socket = new MockSocket('socket-telemetry-01');
  registerWebRTCTelemetryHandlers(io, socket);

  await test('TC-I-001', 'webrtc:client-log is stored and acknowledged', async () => {
    let ack;
    socket.trigger('webrtc:client-log', {
      cameraId: 'camera-1',
      level: 'info',
      event: 'connection-state',
      message: 'Transport connection state changed to connected',
      details: { state: 'connected' },
      timestamp: 1234567890,
      userAgent: 'UnitTest/1.0',
      transportId: 'transport-abc',
    }, (res) => { ack = res; });

    assert(ack && ack.ok === true, 'ack should be ok');
    assert(ack.record.cameraId === 'camera-1', 'cameraId should be normalized');
    assert(telemetry.queryTelemetry({ cameraId: 'camera-1', limit: 10 }).length === 1, 'telemetry buffer should contain one record');
    assert(io.broadcast.length === 1, 'telemetry should be broadcast to subscribed room');
    assert(io.broadcast[0].event === 'webrtc:telemetry', 'broadcast event name');
  });

  await test('TC-I-002', 'telemetry subscribe returns recent logs', async () => {
    let ack;
    socket.trigger('webrtc:telemetry:subscribe', { cameraId: 'camera-1' }, (res) => { ack = res; });
    assert(ack.ok === true, 'subscribe ack should be ok');
    assert(Array.isArray(ack.recent), 'recent should be array');
    assert(ack.recent.length >= 1, 'recent logs should be returned');
    assert(socket.rooms.has('webrtc:telemetry'), 'socket should join telemetry room');
  });

  await test('TC-I-003', 'webrtc:getClientLogs returns filtered results', async () => {
    let ack;
    socket.trigger('webrtc:getClientLogs', { cameraId: 'camera-1', socketId: 'socket-telemetry-01', limit: 5 }, (res) => { ack = res; });
    assert(Array.isArray(ack.logs), 'logs should be array');
    assert(ack.logs.length === 1, 'filtered logs should contain the seeded entry');
    assert(ack.logs[0].event === 'connection-state', 'event should match');
  });

  await test('TC-I-004', 'oversized fields are sanitized before storage', async () => {
    let ack;
    socket.trigger('webrtc:client-log', {
      cameraId: 'camera-1',
      level: 'debug',
      event: 'ice-stats',
      message: 'x'.repeat(900),
      details: { huge: 'y'.repeat(2000) },
    }, (res) => { ack = res; });

    assert(ack.ok === true, 'sanitized payload should still be accepted');
    const logs = telemetry.queryTelemetry({ cameraId: 'camera-1', limit: 10 });
    const last = logs[logs.length - 1];
    assert(last.message.length <= 500, 'message should be truncated');
    assert(String(last.details.huge).length <= 500, 'detail string should be truncated');
  });

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('─────────────────────────────────────────────────────\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});