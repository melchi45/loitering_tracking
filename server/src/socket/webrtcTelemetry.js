'use strict';

const TELEMETRY_ROOM = 'webrtc:telemetry';
const MAX_TELEMETRY_EVENTS = 500;

const telemetryEvents = [];

function truncateString(value, maxLen = 240) {
  const text = String(value ?? '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return undefined;
  try {
    return JSON.parse(JSON.stringify(details, (_key, value) => {
      if (typeof value === 'string') return truncateString(value, 500);
      if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
      return value;
    }));
  } catch (_) {
    return undefined;
  }
}

function normalizeLevel(level) {
  const value = String(level || 'info').toLowerCase();
  if (['debug', 'info', 'warn', 'error'].includes(value)) return value;
  return 'info';
}

function normalizeText(value, maxLen = 240) {
  return truncateString(value == null ? '' : String(value), maxLen).trim();
}

function makeTelemetryRecord(socket, payload = {}) {
  const cameraId = normalizeText(payload.cameraId, 64);
  const transportId = normalizeText(payload.transportId, 64);
  const consumerId = normalizeText(payload.consumerId, 64);
  const event = normalizeText(payload.event || payload.stage || 'client-log', 64);
  const message = normalizeText(payload.message || payload.msg || '', 500);

  if (!event || !message) return null;

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'client',
    socketId: socket?.id || '',
    cameraId,
    transportId,
    consumerId,
    level: normalizeLevel(payload.level),
    event,
    message,
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
    details: sanitizeDetails(payload.details),
    userAgent: normalizeText(payload.userAgent, 180),
  };
}

function storeTelemetry(record) {
  telemetryEvents.push(record);
  if (telemetryEvents.length > MAX_TELEMETRY_EVENTS) {
    telemetryEvents.splice(0, telemetryEvents.length - MAX_TELEMETRY_EVENTS);
  }
}

function queryTelemetry({ cameraId, socketId, limit = 100 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  let rows = telemetryEvents;
  if (cameraId) {
    const cam = normalizeText(cameraId, 64);
    rows = rows.filter((row) => row.cameraId === cam);
  }
  if (socketId) {
    const sock = normalizeText(socketId, 64);
    rows = rows.filter((row) => row.socketId === sock);
  }
  return rows.slice(-normalizedLimit);
}

function clearTelemetry() {
  telemetryEvents.length = 0;
}

module.exports = {
  TELEMETRY_ROOM,
  clearTelemetry,
  makeTelemetryRecord,
  queryTelemetry,
  storeTelemetry,
};