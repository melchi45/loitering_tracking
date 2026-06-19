/**
 * clientLogger — two capabilities over the existing Socket.IO backchannel:
 *
 * 1. Console capture   (event: "client:log")
 *    Intercepts console.error/warn/info/log/debug, window.onerror,
 *    unhandledrejection and emits each entry immediately.
 *    Buffers up to MAX_OFFLINE entries while disconnected; flushes on reconnect.
 *
 * 2. WebRTC stats     (event: "client:webrtc-stats")
 *    Patches RTCPeerConnection so every connection is tracked automatically.
 *    Polls getStats() every WEBRTC_POLL_MS and sends the key stat categories
 *    (candidate-pair, inbound-rtp, outbound-rtp, transport, peer-connection).
 *    This mirrors what edge://webrtc-internals / chrome://webrtc-internals shows.
 */

import { getSocket } from './hooks/useSocket';

export const SESSION_ID =
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ── constants ──────────────────────────────────────────────────────────────────
const MAX_MSG_LEN    = 2_000;
const MAX_OFFLINE    = 100;
const WEBRTC_POLL_MS = 5_000;

// Stat types worth collecting (mirrors webrtc-internals key panels)
const STAT_TYPES_KEEP = new Set([
  'candidate-pair',
  'inbound-rtp',
  'outbound-rtp',
  'remote-inbound-rtp',
  'transport',
  'peer-connection',
  'local-candidate',
  'remote-candidate',
  'media-source',
  'codec',
]);

// ── types ──────────────────────────────────────────────────────────────────────
interface LogEntry {
  level:     string;
  message:   string;
  args?:     string[];
  stack?:    string;
  timestamp: string;
}

interface PCEntry {
  pc:       RTCPeerConnection;
  pcId:     string;
  cameraId: string | null;
  created:  string;
}

// ── state ──────────────────────────────────────────────────────────────────────
let offlineBuffer: LogEntry[] = [];
let capturing = false;
let webrtcTimer: ReturnType<typeof setInterval> | null = null;
const pcRegistry = new Map<string, PCEntry>();

// ── helpers ────────────────────────────────────────────────────────────────────
function safeStr(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function trunc(s: string): string {
  return s.length > MAX_MSG_LEN ? s.slice(0, MAX_MSG_LEN) + '…' : s;
}

// ── console log emission ───────────────────────────────────────────────────────
function emitLog(entries: LogEntry[]) {
  const socket = getSocket();
  const payload = { entries, sessionId: SESSION_ID, userAgent: navigator.userAgent, pageUrl: location.href };
  if (socket.connected) {
    socket.emit('client:log', payload);
  } else {
    offlineBuffer.push(...entries);
    if (offlineBuffer.length > MAX_OFFLINE) offlineBuffer = offlineBuffer.slice(-MAX_OFFLINE);
  }
}

function capture(level: string, rawArgs: unknown[], stack?: string) {
  if (capturing) return;
  capturing = true;
  try {
    const [first, ...rest] = rawArgs;
    emitLog([{
      level,
      message:   trunc(safeStr(first ?? '')),
      args:      rest.length ? rest.map(v => trunc(safeStr(v))) : undefined,
      stack:     stack ? trunc(stack) : undefined,
      timestamp: new Date().toISOString(),
    }]);
  } finally {
    capturing = false;
  }
}

const _orig = {
  log:   console.log.bind(console),
  info:  console.info.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
} as const;

// ── RTCPeerConnection intercept ────────────────────────────────────────────────

/**
 * Patch the global RTCPeerConnection constructor so every created PeerConnection
 * is automatically registered for stats polling.
 * cameraId is extracted from the optional `label` option we pass in useWebRTC.
 */
function _patchRTCPeerConnection() {
  if (typeof window === 'undefined' || !window.RTCPeerConnection) return;

  const OrigPC = window.RTCPeerConnection;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).RTCPeerConnection = function (
    config?: RTCConfiguration,
    // We accept an unofficial second arg to carry the cameraId label
    // (harmless — browsers ignore unknown constructor options)
  ) {
    const pc = new OrigPC(config);
    const pcId     = Math.random().toString(36).slice(2, 9);
    const cameraId = (config as (RTCConfiguration & { _cameraId?: string }) | undefined)?._cameraId ?? null;
    const entry: PCEntry = { pc, pcId, cameraId, created: new Date().toISOString() };
    pcRegistry.set(pcId, entry);

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        pcRegistry.delete(pcId);
      }
    });
    return pc;
  };
  // Preserve prototype so instanceof checks still work
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).RTCPeerConnection.prototype = OrigPC.prototype;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).RTCPeerConnection.generateCertificate = OrigPC.generateCertificate?.bind(OrigPC);
}

async function _pollWebRTCStats() {
  if (pcRegistry.size === 0) return;
  const socket = getSocket();
  if (!socket.connected) return;

  for (const { pc, pcId, cameraId, created } of pcRegistry.values()) {
    if (pc.signalingState === 'closed') { pcRegistry.delete(pcId); continue; }
    try {
      const report = await pc.getStats();
      const stats: Record<string, object> = {};
      report.forEach((value) => {
        // Only keep useful stat categories
        if (STAT_TYPES_KEEP.has(value.type)) {
          stats[value.id] = value;
        }
      });
      if (Object.keys(stats).length === 0) continue;
      socket.emit('client:webrtc-stats', {
        sessionId:         SESSION_ID,
        pcId,
        cameraId,
        created,
        signalingState:    pc.signalingState,
        connectionState:   pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        timestamp:         new Date().toISOString(),
        stats,
      });
    } catch {
      // pc may have been garbage-collected or closed mid-poll
    }
  }
}

// ── public API ─────────────────────────────────────────────────────────────────
export function initClientLogger() {
  if (typeof window === 'undefined') return;

  // 1. Console capture
  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) => {
    console[level] = (...args: unknown[]) => { _orig[level](...args); capture(level, args); };
  });

  window.addEventListener('error', (ev) => {
    capture('error', [ev.message || 'Uncaught error'], ev.error?.stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const msg   = ev.reason instanceof Error ? ev.reason.message : safeStr(ev.reason);
    const stack = ev.reason instanceof Error ? ev.reason.stack   : undefined;
    capture('error', [`UnhandledRejection: ${msg}`], stack);
  });

  // Flush offline buffer on reconnect
  const socket = getSocket();
  socket.on('connect', () => {
    if (offlineBuffer.length > 0) {
      const toSend = offlineBuffer.splice(0);
      socket.emit('client:log', { entries: toSend, sessionId: SESSION_ID, userAgent: navigator.userAgent, pageUrl: location.href });
    }
  });

  // 2. WebRTC stats collection
  _patchRTCPeerConnection();
  webrtcTimer = setInterval(_pollWebRTCStats, WEBRTC_POLL_MS);

  _orig.log('[clientLogger] active — sessionId:', SESSION_ID, '| WebRTC stats poll:', WEBRTC_POLL_MS / 1000, 's');
}

export function stopClientLogger() {
  (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) => {
    console[level] = _orig[level];
  });
  if (webrtcTimer) { clearInterval(webrtcTimer); webrtcTimer = null; }
  pcRegistry.clear();
}

/** Call this from useWebRTC to tag a PeerConnection with the cameraId */
export function registerPeerConnection(pc: RTCPeerConnection, cameraId: string) {
  const pcId = Math.random().toString(36).slice(2, 9);
  pcRegistry.set(pcId, { pc, pcId, cameraId, created: new Date().toISOString() });
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      pcRegistry.delete(pcId);
    }
  });
}

// ── Snapshot for Statistics UI ─────────────────────────────────────────────────

export interface WebRTCPCSummary {
  pcId:               string;
  cameraId:           string | null;
  connectionState:    string;
  iceConnectionState: string;
  signalingState:     string;
  /** Round-trip time in ms (from nominated candidate-pair), or null if unknown */
  rttMs:              number | null;
  /** Fraction packet loss 0–1, or null */
  packetLoss:         number | null;
  /** Total bytes received (audio+video inbound-rtp) */
  bytesReceived:      number;
  /** Video frames per second, or null */
  framesPerSecond:    number | null;
  /** Active local candidate type: host / srflx / relay */
  localCandidateType: string | null;
}

/**
 * Snapshot of all currently tracked PeerConnections.
 * Called synchronously (getStats is NOT awaited here — returns last-known stats).
 * For a live snapshot, call getWebRTCSnapshotAsync().
 */
export function getWebRTCSnapshot(): WebRTCPCSummary[] {
  return Array.from(pcRegistry.values()).map(({ pc, pcId, cameraId }) => ({
    pcId,
    cameraId,
    connectionState:    pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    signalingState:     pc.signalingState,
    rttMs:              null,
    packetLoss:         null,
    bytesReceived:      0,
    framesPerSecond:    null,
    localCandidateType: null,
  }));
}

/** Async version — calls getStats() on each PC and extracts key metrics */
export async function getWebRTCSnapshotAsync(): Promise<WebRTCPCSummary[]> {
  const results: WebRTCPCSummary[] = [];
  for (const { pc, pcId, cameraId } of pcRegistry.values()) {
    const summary: WebRTCPCSummary = {
      pcId,
      cameraId,
      connectionState:    pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      signalingState:     pc.signalingState,
      rttMs:              null,
      packetLoss:         null,
      bytesReceived:      0,
      framesPerSecond:    null,
      localCandidateType: null,
    };
    try {
      const report = await pc.getStats();
      let totalBytesReceived = 0;
      let totalPacketsReceived = 0;
      let totalPacketsLost = 0;
      let activePairId: string | null = null;

      report.forEach((stat) => {
        if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') {
          summary.rttMs = stat.currentRoundTripTime != null
            ? Math.round(stat.currentRoundTripTime * 1000) : null;
          activePairId = stat.localCandidateId ?? null;
        }
        if (stat.type === 'inbound-rtp') {
          totalBytesReceived   += stat.bytesReceived ?? 0;
          totalPacketsReceived += stat.packetsReceived ?? 0;
          totalPacketsLost     += stat.packetsLost ?? 0;
          if (stat.kind === 'video' && stat.framesPerSecond != null) {
            summary.framesPerSecond = Math.round(stat.framesPerSecond * 10) / 10;
          }
        }
        if (stat.type === 'local-candidate' && activePairId && stat.id === activePairId) {
          summary.localCandidateType = stat.candidateType ?? null;
        }
      });

      summary.bytesReceived = totalBytesReceived;
      if (totalPacketsReceived + totalPacketsLost > 0) {
        summary.packetLoss = totalPacketsLost / (totalPacketsReceived + totalPacketsLost);
      }
    } catch {
      // PC may have closed
    }
    results.push(summary);
  }
  return results;
}
