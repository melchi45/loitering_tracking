'use strict';

const telemetry = require('./webrtcTelemetry');

function registerWebRTCTelemetryHandlers(io, socket) {
  const tag = `[WebRTC][${socket.id.slice(0, 8)}]`;

  socket.on('webrtc:telemetry:subscribe', ({ cameraId } = {}, cb) => {
    socket.join(telemetry.TELEMETRY_ROOM);
    const recent = telemetry.queryTelemetry({ cameraId, limit: 50 });
    if (cb) cb({ ok: true, room: telemetry.TELEMETRY_ROOM, recent });
  });

  socket.on('webrtc:telemetry:unsubscribe', (_payload, cb) => {
    socket.leave(telemetry.TELEMETRY_ROOM);
    if (cb) cb({ ok: true });
  });

  socket.on('webrtc:getClientLogs', ({ cameraId, socketId, limit } = {}, cb) => {
    if (cb) cb({ logs: telemetry.queryTelemetry({ cameraId, socketId, limit }) });
  });

  socket.on('webrtc:client-log', (payload = {}, cb) => {
    const record = telemetry.makeTelemetryRecord(socket, payload);
    if (!record) {
      if (cb) cb({ error: 'Invalid telemetry payload' });
      return;
    }

    telemetry.storeTelemetry(record);
    console.log(
      `${tag} telemetry ${record.level.toUpperCase()} ${record.event} — camera ${record.cameraId.slice(0, 8) || 'n/a'} ` +
      (record.transportId ? `transport ${record.transportId.slice(0, 8)} — ` : '') +
      record.message,
    );
    if (io && typeof io.to === 'function') {
      io.to(telemetry.TELEMETRY_ROOM).emit('webrtc:telemetry', record);
    }
    if (cb) cb({ ok: true, record });
  });
}

module.exports = registerWebRTCTelemetryHandlers;