import { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from './useSocket';
import { useWebRTCConfigStore } from '../stores/webrtcConfigStore';
import { useDataChannelStore } from '../stores/dataChannelStore';
import { registerPeerConnection } from '../clientLogger';

// WebRTC stats panel (2026-07-20) — one sample per stats poll tick: video/audio
// receive bitrate plus resolution/buffer/RTT/loss, for a YouTube "stats for
// nerds"-style Connection Speed / Network Activity timeline. Bounded ring
// buffer, see RX_HISTORY_MAX below.
export interface RxSample {
  t:         number; // Date.now() at sample time
  videoKbps: number;
  audioKbps: number;
  resWidth:  number;
  resHeight: number;
  fps:       number;
  bufferMs:  number; // jitter buffer delay accrued this tick (video)
  rttMs:     number; // nominated candidate-pair round-trip time
  lossPct:   number; // cumulative packet loss %, video+audio combined
  latencyMs: number; // approx. glass-to-glass estimate: rttMs/2 (one-way network) + bufferMs (playout hold)
  framesDecoded:  number; // cumulative, since connect
  framesReceived: number; // cumulative, since connect — framesReceived - framesDecoded = dropped
}

export interface RxCodecInfo {
  video:       string; // short name, e.g. "H264"
  audio:       string; // short name, e.g. "opus"
  videoDetail: string; // e.g. "pt96 · 90000Hz · profile-level-id=640033"
  audioDetail: string; // e.g. "pt111 · 48000Hz · 2ch"
}

const RX_HISTORY_MAX = 120; // ~2min of history — sampled every RATE_POLL_MS (1s, 2026-07-21)

// Manual jitterBufferTarget control (RTCRtpReceiver.jitterBufferTarget, Chrome
// 123+) was tried here 2026-07-20 through 2026-07-21 as a way to proactively
// ask the browser to hold more buffer before an anticipated freeze. REMOVED
// (2026-07-21) after causing four separate self-inflicted-delay bugs — see
// the escalation block below for the final root-cause writeup. The browser's
// own adaptive jitter buffer already does this natively without an external
// hint; this file no longer sets jitterBufferTarget at all.
// bufferMs "yellow"/"red" thresholds — single source of truth shared with
// WebRtcStatsPanel.tsx's color coding (2026-07-20). Live observation: a rising
// bufferMs consistently PRECEDES an fps-drop-to-0 freeze by a few seconds — the
// browser's own jitter estimator is already straining to keep up with growing
// network jitter/loss before it finally loses the race. Reacting only to an
// already-occurred freeze (the original version of this logic) was too late;
// bufferMs crossing into yellow/red now drives the SAME proactive step-up,
// on the theory that reinforcing the browser's own in-progress adaptation
// with a higher explicit floor, sooner, gives it more margin to actually
// avoid the underrun instead of just noticing it after the fact.
export const BUFFER_MS_WARN = 100;
export const BUFFER_MS_BAD  = 300;
// Latency (rttMs/2 + bufferMs, see the setRxHistory call below) thresholds —
// same single-source-of-truth pattern as BUFFER_MS_WARN/BAD, shared with
// WebRtcStatsPanel.tsx's color coding.
export const LATENCY_MS_WARN = 150;
export const LATENCY_MS_BAD  = 400;
// Buffer-saturation proactive reconnect (2026-07-20, reverted 2026-07-21,
// re-added 2026-07-21) — see the escalation block's own comment below for
// the trigger condition. History: added after live observation that
// bufferMs climbing to the JITTER_TARGET_MAX_MS ceiling reliably precedes a
// multi-second freeze; reverted the same day after the reconnect itself
// proved visibly disruptive (a real 1-2s "channel refresh" every time it
// fired) while the actual root cause was still unconfirmed. Since then,
// two GENUINE unrelated bugs were found and fixed (ingest-daemon had
// crashed; a stale profileLevelId cache was negotiating Baseline/Level 3.1
// for cameras that are actually High Profile/Level 5.0) — but a THIRD,
// still-unexplained failure mode remains: completely independent streams
// (different cameras, different capture backends) closing within
// milliseconds of each other, repeatedly, with mediasoup scores healthy
// and host CPU mostly idle (mpstat-confirmed) — consistent with a brief
// stall in a single-threaded shared process (Node's event loop, the
// mediasoup worker, or ingest-daemon's GIL) rather than host exhaustion.
// Until that's pinned down (see eventLoopLag.js, added alongside this),
// a long unrecovered freeze is worse than a brief visible reconnect, so
// this is back — re-revert once the real trigger is fixed at the source.
const BUFFER_SATURATED_TICKS_LIMIT = 2;

function shortCodecName(mimeType: string): string {
  return mimeType.split('/')[1] || mimeType;
}

interface NominatedPairCandidate {
  type:     string;
  protocol: string;
  address:  string;
  port:     number;
}

interface NominatedPairInfo {
  local:         NominatedPairCandidate;
  remote:        NominatedPairCandidate;
  bytesSent:     number;
  bytesReceived: number;
  rttMs:         number;
}

// Shared by the main 5s stats/watchdog loop (only needs rttMs, for the rx
// graph's RTT column) and the 1s ICE Rate loop (needs local/remote + bytes
// for the Local/Remote/Rate panel rows) — both parse the same nominated
// candidate-pair shape out of a getStats() report, so this avoids
// maintaining two copies of the candidate-pair/local-candidate/
// remote-candidate parsing logic.
function extractNominatedPair(stats: RTCStatsReport): NominatedPairInfo | null {
  let bytesRx = 0, bytesTx = 0, rttMs = 0;
  let localId = '', remoteId = '';
  stats.forEach(r => {
    if (r.type === 'candidate-pair' && r.nominated) {
      bytesRx  += r.bytesReceived ?? 0;
      bytesTx  += r.bytesSent ?? 0;
      rttMs     = (r.currentRoundTripTime ?? 0) * 1000;
      localId   = r.localCandidateId ?? '';
      remoteId  = r.remoteCandidateId ?? '';
    }
  });
  if (!localId || !remoteId) return null;
  let local:  NominatedPairCandidate | null = null;
  let remote: NominatedPairCandidate | null = null;
  stats.forEach(r => {
    if (r.type === 'local-candidate' && r.id === localId) {
      local = { type: r.candidateType, protocol: r.protocol, address: r.address, port: r.port };
    }
    if (r.type === 'remote-candidate' && r.id === remoteId) {
      remote = { type: r.candidateType, protocol: r.protocol, address: r.address, port: r.port };
    }
  });
  if (!local || !remote) return null;
  return { local, remote, bytesSent: bytesTx, bytesReceived: bytesRx, rttMs };
}

export interface CodecInfo { mimeType: string; payloadType?: number; clockRate?: number; channels?: number; sdpFmtpLine?: string; }

interface InboundRtpSnapshot {
  vBytesRx: number; vPktsRx: number; vFrames: number; vFramesReceived: number;
  aBytesRx: number; aPktsRx: number;
  vWidth: number; vHeight: number; vFps: number;
  vJitterDelay: number; vJitterCount: number;
  vFreezeCount: number;
  vPacketsLost: number; aPacketsLost: number;
  vCodecId: string; aCodecId: string;
  codecById: Map<string, CodecInfo>;
}

// Shared by the 5s stats/watchdog loop (needs every field, including the
// jitter/freeze counters that drive stall detection and jitterBufferTarget
// escalation) and the 1s rate loop (2026-07-21 — needs bytes/jitter/frames
// for the panel's 1s-refresh graphs, NOT the watchdog fields) — both parse
// the same inbound-rtp + codec report shape out of a getStats() report, so
// this avoids maintaining two copies of that parsing.
function extractInboundRtp(stats: RTCStatsReport): InboundRtpSnapshot {
  const snap: InboundRtpSnapshot = {
    vBytesRx: 0, vPktsRx: 0, vFrames: 0, vFramesReceived: 0,
    aBytesRx: 0, aPktsRx: 0,
    vWidth: 0, vHeight: 0, vFps: 0,
    vJitterDelay: 0, vJitterCount: 0,
    vFreezeCount: 0,
    vPacketsLost: 0, aPacketsLost: 0,
    vCodecId: '', aCodecId: '',
    codecById: new Map(),
  };
  stats.forEach(r => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      snap.vBytesRx        = r.bytesReceived ?? 0;
      snap.vPktsRx         = r.packetsReceived ?? 0;
      snap.vFrames         = r.framesDecoded ?? 0;
      snap.vFramesReceived = r.framesReceived ?? 0;
      snap.vWidth          = r.frameWidth ?? 0;
      snap.vHeight         = r.frameHeight ?? 0;
      snap.vFps            = r.framesPerSecond ?? 0;
      snap.vJitterDelay    = r.jitterBufferDelay ?? 0;
      snap.vJitterCount    = r.jitterBufferEmittedCount ?? 0;
      snap.vFreezeCount    = r.freezeCount ?? 0;
      snap.vPacketsLost    = r.packetsLost ?? 0;
      snap.vCodecId        = r.codecId ?? '';
    }
    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
      snap.aBytesRx     = r.bytesReceived ?? 0;
      snap.aPktsRx      = r.packetsReceived ?? 0;
      snap.aPacketsLost = r.packetsLost ?? 0;
      snap.aCodecId     = r.codecId ?? '';
    }
    if (r.type === 'codec') {
      snap.codecById.set(r.id, {
        mimeType:    r.mimeType ?? '',
        payloadType: r.payloadType,
        clockRate:   r.clockRate,
        channels:    r.channels,
        sdpFmtpLine: r.sdpFmtpLine,
      });
    }
  });
  return snap;
}

// Kept for backwards compatibility with components that import this type
export interface IceStats {
  localType:     string;
  localProtocol: string;
  localAddress:  string;
  localPort:     number;
  remoteType:    string;
  remoteAddress: string;
  remotePort:    number;
  sentBps:       number; // instantaneous send rate, bits/sec (candidate-pair delta)
  receivedBps:   number; // instantaneous receive rate, bits/sec (candidate-pair delta)
}

type WebRTCState = 'idle' | 'connecting' | 'connected' | 'failed';

const MAX_AUTO_RETRIES   = 8;
const AUTO_RETRY_DELAY   = 3_000;
const CONNECT_TIMEOUT_MS = 30_000;

// ── Shared session registry ────────────────────────────────────────────────
//
// One entry per cameraId. The entry is created as soon as a WHEP negotiation
// starts (stream=null), preventing a second component from starting a duplicate
// negotiation. When the stream becomes available, all waiting consumers are
// notified via callbacks. RefCount tracks every active consumer; the PC is
// closed only when the last one unmounts.
//
interface SessionEntry {
  pc:        RTCPeerConnection | null;   // null while negotiating
  stream:    MediaStream | null;         // null until ontrack fires
  hasAudio:  boolean;
  refCount:  number;
  callbacks: Set<(stream: MediaStream, hasAudio: boolean) => void>;
}

const sessionRegistry = new Map<string, SessionEntry>();

function detachVideo(videoRef: React.RefObject<HTMLVideoElement>) {
  if (!videoRef.current) return;
  try { videoRef.current.pause(); } catch (_) {}
  videoRef.current.srcObject = null;
}

function releaseEntry(cameraId: string) {
  const e = sessionRegistry.get(cameraId);
  if (!e) return;
  e.refCount--;
  if (e.refCount <= 0) {
    if (e.pc) { try { e.pc.close(); } catch (_) {} }
    sessionRegistry.delete(cameraId);
  }
}

/**
 * WebRTC hook — MediaMTX WHEP via /api/webrtc/whep/:cameraId
 *
 * Multiple components sharing the same cameraId (grid cell + fullscreen) share
 * one RTCPeerConnection; no second WHEP negotiation is ever started while one
 * is in progress or already connected.
 */
export function useWebRTC(cameraId: string, enabled: boolean) {
  const { socket }    = useSocket();
  const getIceServers = useWebRTCConfigStore((s) => s.getIceServers);
  const pushDCMessage = useDataChannelStore((s) => s.pushMessage);
  const videoRef      = useRef<HTMLVideoElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const [state, setState] = useState<WebRTCState>(() => {
    const e = sessionRegistry.get(cameraId);
    return e?.stream?.active ? 'connected' : 'idle';
  });
  const [hasAudio, setHasAudio] = useState<boolean>(() => {
    const e = sessionRegistry.get(cameraId);
    return !!(e?.stream?.active && e.hasAudio);
  });

  const [retryCount, setRetryCount] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0); // forces re-run when cached stream dies
  // iceStats (2026-07-16) — was permanently `null` (see the old final return
  // statement's `iceStats: null as IceStats | null`), so the ICE debug panel
  // in CameraView.tsx showed "Collecting stats…" forever regardless of actual
  // connection state — confirmed live, this made it useless for diagnosing
  // exactly the remote-network-path question it exists to answer (host vs
  // srflx vs relay candidate, real bytes sent/received). The stall-watchdog
  // below already parses the nominated candidate-pair on every poll; it just
  // never got stored anywhere. Populated from that same loop now.
  const [iceStats, setIceStats] = useState<IceStats | null>(null);
  const [rxHistory, setRxHistory] = useState<RxSample[]>([]);
  const [rxCodec, setRxCodec] = useState<RxCodecInfo>({ video: '', audio: '', videoDetail: '', audioDetail: '' });

  const retry = useCallback(() => {
    setRetryCount(0);
    setRetryNonce(n => n + 1);
  }, []);

  // Subscribe to Socket.IO appRtp events for this camera independently of the
  // WebRTC session lifecycle. This works in mediamtx mode (no DataChannel) and
  // acts as a redundant delivery path in mediasoup mode.  The store deduplicates
  // by seq, so double-counting is prevented when both DataChannel and Socket.IO
  // deliver the same packet.
  useEffect(() => {
    if (!enabled || !cameraId || !socket) return;
    const handleAppRtp = (data: {
      cameraId: string; pt: number; timestamp: number; seq: number; payload: string;
    }) => {
      if (data.cameraId !== cameraId) return;
      pushDCMessage({ cameraId, pt: data.pt, timestamp: data.timestamp, seq: data.seq, payload: data.payload });
    };
    socket.on('appRtp', handleAppRtp);
    return () => { socket.off('appRtp', handleAppRtp); };
  }, [cameraId, enabled, socket, pushDCMessage]);

  useEffect(() => {
    if (!enabled || !cameraId) return;
    if (retryCount >= MAX_AUTO_RETRIES) { setState('failed'); return; }

    let cancelled = false;

    const existingEntry = sessionRegistry.get(cameraId);

    // ── Case A: active stream already in registry ──────────────────────────
    if (existingEntry?.stream?.active) {
      existingEntry.refCount++;
      setState('connected');
      setHasAudio(existingEntry.hasAudio);
      if (videoRef.current) {
        videoRef.current.srcObject = existingEntry.stream;
        _attachAndPlay(videoRef.current, cameraId);
      }

      const handleInactive = () => {
        // Stream died — force re-negotiation on next render cycle
        if (!cancelled) { setState('connecting'); setRetryNonce(n => n + 1); }
      };
      existingEntry.stream.addEventListener('inactive', handleInactive);

      return () => {
        cancelled = true;
        existingEntry.stream!.removeEventListener('inactive', handleInactive);
        detachVideo(videoRef);
        setState('idle');
        setHasAudio(false);
        releaseEntry(cameraId);
      };
    }

    // ── Case B: negotiation already in progress — wait for stream ──────────
    if (existingEntry && !existingEntry.stream) {
      existingEntry.refCount++;
      setState('connecting');

      const onStream = (stream: MediaStream, ha: boolean) => {
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          _attachAndPlay(videoRef.current, cameraId);
        }
        setState('connected');
        setHasAudio(ha);
      };
      existingEntry.callbacks.add(onStream);

      return () => {
        cancelled = true;
        const e = sessionRegistry.get(cameraId);
        if (e) e.callbacks.delete(onStream);
        detachVideo(videoRef);
        setState('idle');
        setHasAudio(false);
        releaseEntry(cameraId);
      };
    }

    // ── Case C: start a fresh WHEP negotiation ─────────────────────────────
    // Create a placeholder entry immediately to block duplicate negotiations.
    const entry: SessionEntry = { pc: null, stream: null, hasAudio: false, refCount: 1, callbacks: new Set() };
    sessionRegistry.set(cameraId, entry);
    setState('connecting');

    const connectTimeoutId = setTimeout(() => {
      if (!cancelled) {
        console.warn(`[useWebRTC][${cameraId.slice(0,8)}] connect timeout`);
        setState('failed');
        retryTimerRef.current = setTimeout(() => {
          if (!cancelled) setRetryCount(n => n + 1);
        }, AUTO_RETRY_DELAY);
      }
    }, CONNECT_TIMEOUT_MS);

    const handleStreamUnavailable = ({ cameraId: id }: { cameraId: string }) => {
      if (id !== cameraId || cancelled) return;
      setState('failed');
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        if (!cancelled) setRetryCount(n => n + 1);
      }, AUTO_RETRY_DELAY);
    };
    socket.on('camera:stream-unavailable', handleStreamUnavailable);

    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    entry.pc = pc;
    registerPeerConnection(pc, cameraId);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // Create an outgoing DataChannel so the SDP offer includes m=application (SCTP).
    // The server's mediasoup DataConsumer feeds data back through its own server-side
    // DataChannel, which the browser receives via ondatachannel below.
    pc.createDataChannel('init', { ordered: false, maxRetransmits: 0 });

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      dc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          pushDCMessage({ cameraId, ...msg });
        } catch (_) {}
      };
    };

    // Synthetic stream for engines that don't include a=msid in the SDP answer
    // (mediasoup before the fix). Without a=msid, event.streams is [], so we
    // collect each incoming track into a single MediaStream manually.
    let _peerStream: MediaStream | null = null;
    // Tracked so the bottom cleanup can remove the 'inactive' listener added
    // in ontrack below (see handleStreamInactive) — without this, every
    // reconnect cycle leaks one listener on the previous stream object.
    let _lastStream: MediaStream | null = null;
    let _lastInactiveHandler: (() => void) | null = null;

    pc.ontrack = (event) => {
      // Diagnostic: log BEFORE early-return so we can see if ontrack fires even when
      // the guard conditions block the rest of the handler.
      console.log(
        `[useWebRTC][${cameraId.slice(0,8)}] ontrack-raw: kind=${event.track.kind}` +
        ` cancelled=${cancelled} hasRef=${!!videoRef.current} streams=${event.streams.length}`
      );
      if (cancelled || !videoRef.current) return;
      console.log(
        `[useWebRTC][${cameraId.slice(0,8)}] ontrack: kind=${event.track.kind}` +
        ` streams=${event.streams.length} muted=${event.track.muted}`
      );
      // Monitor track mute/unmute to detect when RTP starts flowing.
      const trackKind = event.track.kind;
      event.track.onunmute = () =>
        console.log(`[useWebRTC][${cameraId.slice(0,8)}] track-UNMUTED: kind=${trackKind}`);
      event.track.onmute = () =>
        console.log(`[useWebRTC][${cameraId.slice(0,8)}] track-MUTED: kind=${trackKind}`);
      // The server closes and recreates its mediasoup Producer whenever the
      // camera's own capture pipeline restarts (e.g. the frame watchdog
      // reconnecting a flaky RTSP source) — this closes every Consumer bound
      // to that Producer, which fires 'ended' on the browser's track. The
      // RTCPeerConnection's overall connectionState does NOT change when only
      // one track ends, so onconnectionstatechange never fires.
      //
      // Broadcast via stream.stop(), not local retry() (2026-07-16,
      // §shared-session-watchdog-scope) — a grid tile and a fullscreen view of
      // the SAME camera share one RTCPeerConnection through sessionRegistry
      // (Case A below reuses an already-active stream), but only the ONE
      // component instance that originally created the connection (Case C,
      // right here) owned this onended handler — scoped to ITS OWN `cancelled`
      // flag. Confirmed live: opening a camera fullscreen hides/unmounts the
      // grid tile behind it, which runs Case C's cleanup and flips its
      // `cancelled` to true — silently disabling this exact handler (and the
      // stall watchdog below, same issue) for the REMAINING fullscreen viewer,
      // which then had literally nothing left watching for a dead track. The
      // video froze on its last decoded frame with no way to recover short of
      // a page reload — exactly the symptom reported live against the
      // fullscreen YouTube view while its detection overlay kept updating
      // (detections arrive over Socket.IO, an entirely separate channel from
      // the video track). Fix: stop every track on the shared `stream`
      // instead of calling this instance's own retry() — that fires the
      // native 'inactive' event on the MediaStream, which EVERY consumer
      // (Case A's handleInactive below, and this same Case C instance's own
      // mirrored listener a few lines down) already listens for and reacts to
      // independently, regardless of which specific component originally
      // created the connection or whether that creator is still mounted.
      if (trackKind === 'video') {
        event.track.onended = () => {
          console.log(`[useWebRTC][${cameraId.slice(0,8)}] track-ENDED: kind=${trackKind} — reconnecting`);
          try { stream?.getTracks().forEach(t => t.stop()); } catch (_) {}
        };
      }
      let stream = event.streams?.[0];
      if (!stream) {
        if (!_peerStream) _peerStream = new MediaStream();
        _peerStream.addTrack(event.track);
        stream = _peerStream;
      }
      const ha = stream.getAudioTracks().length > 0;

      // Populate the shared entry and notify waiting consumers (Case B)
      const e = sessionRegistry.get(cameraId);
      if (e) {
        e.stream   = stream;
        e.hasAudio = ha;
        for (const cb of e.callbacks) cb(stream, ha);
        e.callbacks.clear();
      }

      // Mirrors Case A's handleInactive (2026-07-16) — this Case C instance is
      // itself just one of potentially several consumers of this stream once a
      // second component (e.g. a fullscreen view) attaches via Case A, so it
      // needs to react to the stream going inactive exactly the same way,
      // regardless of which consumer's watchdog/onended actually detected the
      // problem and called stream.stop().
      const handleStreamInactive = () => {
        if (!cancelled) { setState('connecting'); setRetryNonce(n => n + 1); }
      };
      stream.addEventListener('inactive', handleStreamInactive);
      _lastStream = stream;
      _lastInactiveHandler = handleStreamInactive;

      videoRef.current.srcObject = stream;
      console.log(
        `[useWebRTC][${cameraId.slice(0,8)}] srcObject set` +
        ` tracks=${stream.getTracks().map(t => t.kind + '/' + t.readyState).join(',')}`
      );
      _attachAndPlay(videoRef.current, cameraId);
      if (!cancelled) setHasAudio(ha);
    };

    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (cancelled) { pc.close(); return; }

        // Register connection state handler BEFORE setRemoteDescription to avoid
        // missing the 'connected' transition if ICE connects very fast (same LAN).
        pc.onconnectionstatechange = () => {
          if (cancelled) return;
          const cs = pc.connectionState;
          console.log(`[useWebRTC][${cameraId.slice(0,8)}] connection: ${cs}`);
          if (cs === 'connected') {
            clearTimeout(connectTimeoutId);
            if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = undefined; }
            setState('connected');
            // ── Stale-stream watchdog (runs for the connection's lifetime) ──────
            // mediasoup closes its server-side Consumer when the camera's own
            // Producer is torn down and recreated (e.g. pipelineManager's frame
            // watchdog reconnecting a flaky RTSP source — confirmed live against
            // TID-A800, which does this every 20-40s during rough patches). That
            // Consumer-close does NOT trigger any SDP renegotiation or track-level
            // signal to the browser: RTCPeerConnection.connectionState stays
            // "connected" and the video MediaStreamTrack never fires 'ended' —
            // confirmed by direct WHEP testing (getStats().bytesReceived froze
            // for 75s+ across a real server-side restart with no track-ended
            // event and no connectionState change). So neither onconnectionstate-
            // change nor track.onended (kept above as defense-in-depth for
            // engines/scenarios that DO signal explicitly) can detect this —
            // the only reliable signal is inbound-rtp.bytesReceived going flat
            // while nominally "connected". STALL_MS is kept above the server's
            // own FRAME_STALL_MS (20s, pipelineManager.js) so this doesn't fire
            // before the server has even started its own recovery.
            // Jitter (2026-07-16, §client-reconnect-storm) — ALL tiles on a grid
            // page mount within milliseconds of each other, so with fixed
            // thresholds every camera's watchdog fires in the same instant. If
            // several reconnect at once, the resulting negotiation/decoder-
            // teardown burst is itself enough to stall decode on OTHER tiles
            // that were fine a moment earlier — confirmed live: even the one
            // camera that was flawless across dozens of isolated 90s tests all
            // session got caught in the exact same repeating stall→reconnect
            // cycle once it was sharing a page with 6 other tiles whose
            // watchdogs kept firing in near-lockstep. A random per-connection
            // offset spreads reconnects out so they stop synchronizing.
            const jitterMs      = Math.floor(Math.random() * 8_000);
            const STALL_MS      = 25_000 + jitterMs;
            // Frame-decode stall gets a longer grace period than byte-stall: a
            // fresh connection legitimately shows bytesReceived growing for a
            // few seconds before the first keyframe arrives and framesDecoded
            // starts moving (mid-GOP join, waiting on requestKeyFrame()), so
            // this must not fire during that normal startup window.
            const FRAME_STALL_MS = 20_000 + jitterMs;
            const POLL_MS       = 5_000;
            // ICE panel Rate (2026-07-20) — polled on its own faster cadence,
            // independent of POLL_MS: the stall watchdog/adaptive jitter logic
            // below is tuned against 5s ticks (§6.20/§6.27's JITTER_TARGET_STEP_*
            // sizes assume a 5s cadence), so changing POLL_MS itself would
            // silently change their behavior too. See the rateTimer block below.
            const RATE_POLL_MS  = 1_000;
            let lastBytesRx     = -1;
            let lastBytesRxAt   = Date.now();
            let lastFrames      = -1;
            let lastFramesAt    = Date.now();
            let statsTick       = 0;
            // Buffer health (2026-07-20) — jitterBufferDelay/-EmittedCount are
            // cumulative counters; averaging the delta between two polls gives
            // the mean jitter-buffer hold time for THIS tick instead of a
            // since-connect average that barely moves after the first minute.
            let prevJitterDelay = -1;
            let prevJitterCount = -1;
            // Freeze/loss tracking — early-warning signal only (2026-07-21).
            // Previously drove manual jitterBufferTarget control; that
            // mechanism was removed (see the escalation block's comment below),
            // so these deltas are computed but not currently acted on.
            let prevFreezeCount  = -1;
            let prevLossForAdapt = -1;
            // See BUFFER_SATURATED_TICKS_LIMIT's comment above.
            let bufferSaturatedTicks = 0;
            // Background-tab focus guard (2026-07-20, §focus-throttle) —
            // confirmed live: switching away from the browser tab and back
            // reliably triggered a stall-reconnect almost every time. Chrome
            // throttles/pauses WebRTC video decode for hidden tabs to save
            // power (framesDecoded legitimately stops advancing while
            // hidden), which looks EXACTLY like a real stall to the
            // frame-stall watchdog below, and also inflates bufferMs
            // (jitterBufferDelay keeps accumulating against a near-frozen
            // emitted count) enough to fire the proactive jitterBufferTarget
            // escalation on backgrounded-tab noise. Neither is a real
            // problem — the tab wasn't decoding because nobody was
            // watching, not because the network failed. Reset every "last
            // seen" baseline the moment the tab becomes visible again so
            // the next poll tick starts a fresh comparison window instead of
            // measuring across the entire hidden period; the poll tick
            // itself also skips stall-detection and buffer escalation
            // entirely while still hidden (see their own `!document.hidden`
            // guards below) so nothing fires while there's no one watching.
            const handleVisibilityChange = () => {
              if (sessionRegistry.get(cameraId)?.pc !== pc) {
                document.removeEventListener('visibilitychange', handleVisibilityChange);
                return;
              }
              if (!document.hidden) {
                lastFrames = -1;      lastFramesAt   = Date.now();
                lastBytesRx = -1;     lastBytesRxAt  = Date.now();
                prevFreezeCount = -1; prevLossForAdapt = -1;
                prevJitterDelay = -1; prevJitterCount  = -1;
                bufferSaturatedTicks = 0;
              }
            };
            document.addEventListener('visibilitychange', handleVisibilityChange);
            const statsTimer = setInterval(async () => {
              // Entry-liveness check, not `cancelled` (2026-07-16,
              // §shared-session-watchdog-scope) — see the onended handler
              // comment above for the full story. This lets the watchdog
              // outlive the specific component instance that created the
              // connection, as long as the connection itself (same `pc`) is
              // still the one registered for this camera — i.e. as long as
              // ANY consumer (this one or another, e.g. a fullscreen view)
              // still needs it. It only stops once the entry is gone
              // (refCount hit 0) or points at a different pc (a reconnect
              // already happened via some other path).
              if (sessionRegistry.get(cameraId)?.pc !== pc) {
                clearInterval(statsTimer);
                document.removeEventListener('visibilitychange', handleVisibilityChange);
                return;
              }
              try {
                const stats = await pc.getStats();
                // Only the fields the stall watchdog / jitterBufferTarget escalation /
                // codec-detail update below actually use — vFramesReceived/aBytesRx/
                // aPktsRx/vWidth/vHeight/vFps/aPacketsLost are the rxHistory-only
                // fields, sampled by the 1s rateTimer instead (see its comment).
                const {
                  vBytesRx, vPktsRx, vFrames,
                  vJitterDelay, vJitterCount, vFreezeCount,
                  vPacketsLost,
                  vCodecId, aCodecId, codecById,
                } = extractInboundRtp(stats);
                // ICE Local/Remote/Rate panel rows are now populated by the
                // separate rateTimer below (1s cadence) — this loop only
                // needs the nominated pair's rttMs for the rx graph.
                const rttMs = extractNominatedPair(stats)?.rttMs ?? 0;
                if (!cancelled) {
                  const vCodecInfo = codecById.get(vCodecId);
                  const aCodecInfo = codecById.get(aCodecId);
                  const videoCodec = shortCodecName(vCodecInfo?.mimeType ?? '');
                  const audioCodec = shortCodecName(aCodecInfo?.mimeType ?? '');
                  // "Codecs" detail line (2026-07-21) — mirrors the extra codec
                  // parameters YouTube's stats-for-nerds shows alongside the
                  // codec name (payload type / clock rate / fmtp), sourced
                  // straight from the RTCCodecStats record already being
                  // iterated above rather than a second getStats() pass.
                  const videoDetail = vCodecInfo
                    ? [`pt${vCodecInfo.payloadType ?? '?'}`, vCodecInfo.clockRate ? `${vCodecInfo.clockRate}Hz` : null, vCodecInfo.sdpFmtpLine || null]
                        .filter(Boolean).join(' · ')
                    : '';
                  const audioDetail = aCodecInfo
                    ? [`pt${aCodecInfo.payloadType ?? '?'}`, aCodecInfo.clockRate ? `${aCodecInfo.clockRate}Hz` : null, aCodecInfo.channels ? `${aCodecInfo.channels}ch` : null]
                        .filter(Boolean).join(' · ')
                    : '';
                  setRxCodec(prev =>
                    prev.video === videoCodec && prev.audio === audioCodec
                    && prev.videoDetail === videoDetail && prev.audioDetail === audioDetail
                      ? prev
                      : { video: videoCodec, audio: audioCodec, videoDetail, audioDetail });
                }
                // Buffer ms: mean jitter-buffer hold time accrued since the last poll
                // (see prevJitterDelay/-Count declaration above). 0 on the first tick
                // and whenever the emitted-frame counter hasn't advanced.
                let bufferMs = 0;
                if (prevJitterCount >= 0 && vJitterCount > prevJitterCount) {
                  bufferMs = ((vJitterDelay - prevJitterDelay) / (vJitterCount - prevJitterCount)) * 1000;
                }
                prevJitterDelay = vJitterDelay;
                prevJitterCount = vJitterCount;
                // Adaptive jitterBufferTarget (2026-07-21, §self-reinforcing-buffer-loop) —
                // PREVIOUSLY escalated on bufferMs itself crossing yellow/red, on the
                // theory that "rising bufferMs precedes a freeze, so raise the target
                // proactively." That reasoning has a fatal flaw: this SAME code sets
                // `videoReceiver.jitterBufferTarget = jitterTargetMs` a few lines below,
                // which directly commands the browser to hold frames for at least that
                // long — and the browser's own jitterBufferDelay stat (which `bufferMs`
                // above is computed from) then faithfully reports back that
                // self-imposed hold time as "the buffer is elevated." That closes a
                // positive feedback loop: any minor, ordinary jitter blip crossing the
                // (low) BUFFER_MS_WARN threshold triggers a step-up, which raises
                // bufferMs on the NEXT tick (partly or wholly because of that step-up),
                // which triggers another step-up — with STEP_UP (150-300ms/tick)
                // 5-10x steeper than STEP_DOWN (30ms/tick), this ratchets to the
                // JITTER_TARGET_MAX_MS ceiling in ~3-4 ticks (15-20s) essentially
                // regardless of whether there was ever a real underlying problem.
                // Confirmed live: reported "bufferMs periodically spikes past 900ms
                // even though data reception is fine" — exactly this runaway.
                // FIX: escalate only on signals we do NOT ourselves influence —
                // an actual decoder freeze (freezeCount) or actual new packet loss
                // (packetsLost). bufferMs stays a passive display metric only.
                // Skipped entirely while the tab is hidden — freeze/loss readings
                // are meaningless (inflated or frozen) against Chrome's
                // background-tab decode throttling, so escalating off them here
                // would just be reacting to a false signal.
                if (!document.hidden) {
                  const freezeDelta = prevFreezeCount >= 0 ? Math.max(0, vFreezeCount - prevFreezeCount) : 0;
                  const lossDeltaForAdapt = prevLossForAdapt >= 0 ? Math.max(0, vPacketsLost - prevLossForAdapt) : 0;
                  prevFreezeCount  = vFreezeCount;
                  prevLossForAdapt = vPacketsLost;
                  // Manual jitterBufferTarget control REMOVED (2026-07-21) — this
                  // mechanism caused four separate bugs across this project's
                  // history (v1.20 → v1.36 → v1.37 → v1.41, see the constants'
                  // comment above and §self-reinforcing-buffer-loop) and root-cause
                  // analysis of a fifth (live: 2048x1536/15fps stream, bufferMs
                  // climbing to 1439ms, framesDropped ~25%, packetsLost <1%) found
                  // the same class of problem again: STEP_UP (150ms/event) so far
                  // outpaces STEP_DOWN (30ms/5s tick) that on any long-lived
                  // connection with even occasional real loss/freeze — not
                  // uncommon on these links — jitterTargetMs ratchets toward
                  // JITTER_TARGET_MAX_MS and rarely gets the ~2.5 clean minutes
                  // needed to fully decay back down. We were then COMMANDING the
                  // browser via `videoReceiver.jitterBufferTarget` to hold every
                  // frame for up to that long before decode — a self-imposed delay
                  // that looks identical to "the decoder can't keep up" in every
                  // metric (bufferMs, latencyMs) without actually being a decode
                  // problem at all. The browser's own adaptive jitter buffer
                  // already balances this natively without an external hint;
                  // freeze/loss are still tracked below purely as an early-warning
                  // signal, but no longer used to command the receiver.
                  void freezeDelta;
                  void lossDeltaForAdapt;
                  // See BUFFER_SATURATED_TICKS_LIMIT's comment. Triggers on
                  // bufferMs alone — now a purely observational metric (nothing in
                  // this file sets jitterBufferTarget anymore), so a sustained
                  // high reading reflects real jitter-buffer/decode delay, not a
                  // delay we commanded ourselves.
                  bufferSaturatedTicks = bufferMs >= BUFFER_MS_BAD
                    ? bufferSaturatedTicks + 1
                    : 0;
                }
                statsTick += 1;
                if (statsTick <= 10) {
                  // Verbose connect-time diagnostics only for the first ~50s.
                  console.log(
                    `[useWebRTC][${cameraId.slice(0,8)}] stats t+${statsTick*POLL_MS/1000}s:` +
                    ` vBytesRx=${vBytesRx} vPkts=${vPktsRx} vFrames=${vFrames} rttMs=${Math.round(rttMs)}`
                  );
                }
                // Byte-stall and frame-stall are separate failure modes (2026-07-16,
                // §dashboard-black-tiles): bytesReceived can keep climbing forever
                // while framesDecoded never moves off 0 — confirmed live via the
                // server's own webrtc/monitor endpoint showing a healthy, growing
                // Consumer (bytesSent in the megabytes, ICE/DTLS connected) for a
                // tile the dashboard rendered as a solid black video element the
                // whole time. The byte-stall check above never fires in that case
                // (bytes ARE moving), so nothing here previously caught it —
                // vFrames was captured into a local var and only ever logged, never
                // compared. This mirrors the byte check but keyed on framesDecoded.
                // Skip stall bookkeeping entirely while the tab is hidden
                // (2026-07-20, §focus-throttle — see handleVisibilityChange's
                // comment above) — vFrames/vBytesRx naturally stop advancing
                // while backgrounded, which is expected, not a stall.
                let frameStalled = false;
                if (!document.hidden) {
                  if (vFrames !== lastFrames) {
                    lastFrames   = vFrames;
                    lastFramesAt = Date.now();
                  } else if (Date.now() - lastFramesAt > FRAME_STALL_MS) {
                    frameStalled = true;
                  }
                  if (vBytesRx !== lastBytesRx) {
                    lastBytesRx   = vBytesRx;
                    lastBytesRxAt = Date.now();
                  }
                }
                // staleReconnect (2026-07-16) — both stall paths used to call
                // retry(), which resets retryCount to 0. That's correct for the
                // user-facing "Reconnect" button (a fresh manual click deserves a
                // full retry budget) but WRONG here: it silently defeats
                // MAX_AUTO_RETRIES for every automatic stall detection, so a
                // camera stuck in a genuine stall-reconnect-stall cycle (e.g.
                // client-side decode CPU starvation from many simultaneous
                // high-res tiles/tabs, confirmed live — reconnecting cannot fix a
                // browser decode-capacity problem) retries forever instead of
                // settling into 'failed' after MAX_AUTO_RETRIES like every other
                // automatic retry path in this file already does
                // (setRetryCount(n => n + 1), never a reset). Mirror that pattern:
                // increment (respecting the cap via the effect's own top-of-run
                // check).
                //
                // Backoff (2026-07-16, §client-reconnect-storm) — a fixed
                // AUTO_RETRY_DELAY meant every stalled tile retried at the same
                // fast cadence forever, so a fleet of tiles that stalled together
                // (see the jitter comment above) kept reconnecting together too,
                // and each synchronized burst of renegotiations was itself heavy
                // enough to stall decode on tiles that had just barely recovered
                // — a self-sustaining loop confirmed live across all 7 tiles
                // simultaneously, including one with zero prior stall history.
                // Grow the delay with retryCount so a chronically-stalling tile
                // backs off instead of hammering at a constant rate, same
                // rationale as pipelineManager.js's server-side watchdog backoff.
                //
                // Broadcast via stream.stop(), not local setState/setRetryCount
                // (2026-07-16, §shared-session-watchdog-scope) — same reasoning
                // as the onended handler above: this watchdog may now be
                // running on behalf of OTHER consumers after its own creating
                // component unmounted (e.g. a fullscreen view left running
                // after the grid tile behind it was hidden), so the reconnect
                // action must not depend on THIS instance's own React state —
                // stopping the shared stream's tracks fires 'inactive' on
                // every attached consumer independently. `cancelled` is no
                // longer checked here; the entry-liveness check already
                // guards the interval itself (above).
                const staleReconnect = (reason: string) => {
                  const backoffMs = Math.min(retryCount * 2_000, 15_000);
                  console.log(`[useWebRTC][${cameraId.slice(0,8)}] ${reason} — reconnecting in ${Math.round((AUTO_RETRY_DELAY + backoffMs)/1000)}s`);
                  clearInterval(statsTimer);
                  clearInterval(rateTimer);
                  document.removeEventListener('visibilitychange', handleVisibilityChange);
                  setTimeout(() => {
                    // Read the CURRENT shared stream at fire time, not a
                    // closure over ontrack's local `stream` (out of scope
                    // here, and may have been replaced by a newer negotiation
                    // by the time this delayed callback runs anyway).
                    const liveStream = sessionRegistry.get(cameraId)?.stream;
                    try { liveStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
                  }, AUTO_RETRY_DELAY + backoffMs);
                };
                if (document.hidden) {
                  // No-op — see the guard above; a hidden tab intentionally
                  // stops updating lastFramesAt/lastBytesRxAt, so evaluating
                  // their staleness against real wall-clock time here would
                  // false-positive the moment STALL_MS elapses in the
                  // background, reconnecting a tab nobody is watching.
                } else if (bufferSaturatedTicks >= BUFFER_SATURATED_TICKS_LIMIT) {
                  staleReconnect(
                    `bufferMs=${Math.round(bufferMs)}ms still bad for ${bufferSaturatedTicks} ticks ` +
                    `— reconnecting proactively before a freeze`
                  );
                } else if (frameStalled) {
                  staleReconnect(
                    `framesDecoded stuck at ${vFrames} for ${Math.round((Date.now() - lastFramesAt) / 1000)}s ` +
                    `despite bytesReceived=${vBytesRx} and connectionState=connected`
                  );
                } else if (Date.now() - lastBytesRxAt > STALL_MS) {
                  staleReconnect(
                    `video stream stale for ${Math.round((Date.now() - lastBytesRxAt) / 1000)}s ` +
                    `despite connectionState=connected`
                  );
                }
              } catch (_) {}
            }, POLL_MS);
            // ICE panel Rate — 1s cadence, deliberately separate from
            // statsTimer above (see RATE_POLL_MS's comment). Bytes sent/
            // received come straight off the ICE candidate-pair, which
            // keeps counting real network traffic even while the tab is
            // hidden and decode is throttled (§focus-throttle) — so unlike
            // the stall/jitter logic this is NOT gated on document.hidden.
            let ratePrevBytesTx = -1;
            let ratePrevBytesRx = -1;
            let ratePrevAt      = Date.now();
            // rxHistory sampling (2026-07-21) — moved here from the 5s
            // statsTimer so the panel/graphs refresh every second, WITHOUT
            // touching statsTimer's own cadence (its stall-watchdog and
            // jitterBufferTarget escalation are tuned against 5s ticks — see
            // POLL_MS's comment — so that loop is left completely alone).
            // Own independent prev-tracking, separate from statsTimer's
            // (both read the same cumulative getStats() counters but compute
            // deltas over their own window — no shared mutable state).
            let ratePrevVideoBytes  = -1;
            let ratePrevAudioBytes  = -1;
            let ratePrevJitterDelay = -1;
            let ratePrevJitterCount = -1;
            // Carries the last successfully-computed bufferMs forward across
            // ticks (2026-07-21, §buffer-oscillation) — see its use below.
            let lastKnownBufferMs   = 0;
            const rateTimer = setInterval(async () => {
              if (sessionRegistry.get(cameraId)?.pc !== pc) {
                clearInterval(rateTimer);
                return;
              }
              try {
                const stats    = await pc.getStats();
                const nominated = extractNominatedPair(stats);
                if (!nominated || cancelled) return;
                const now     = Date.now();
                const elapsed = (now - ratePrevAt) / 1000;
                const sentBps     = ratePrevBytesTx >= 0 && elapsed > 0
                  ? Math.max(0, ((nominated.bytesSent - ratePrevBytesTx) * 8) / elapsed) : 0;
                const receivedBps = ratePrevBytesRx >= 0 && elapsed > 0
                  ? Math.max(0, ((nominated.bytesReceived - ratePrevBytesRx) * 8) / elapsed) : 0;
                ratePrevBytesTx = nominated.bytesSent;
                ratePrevBytesRx = nominated.bytesReceived;
                ratePrevAt      = now;
                setIceStats({
                  localType:     nominated.local.type,
                  localProtocol: nominated.local.protocol,
                  localAddress:  nominated.local.address,
                  localPort:     nominated.local.port,
                  remoteType:    nominated.remote.type,
                  remoteAddress: nominated.remote.address,
                  remotePort:    nominated.remote.port,
                  sentBps,
                  receivedBps,
                });

                const rtp = extractInboundRtp(stats);
                // bufferMs (2026-07-21, §buffer-oscillation) — at this 1s
                // cadence, a tick with zero newly-emitted frames is common
                // even in a healthy connection (~30fps ÷ 1s window has real
                // variance), and jitterBufferEmittedCount simply doesn't
                // advance in that case. Previously this fell through to a
                // hardcoded 0, then the NEXT tick divided the two ticks'
                // worth of accumulated jitterBufferDelay across whichever
                // frames emitted since — producing a false "0ms" reading
                // immediately followed by a compensating spike, every couple
                // of ticks. Confirmed live: user-reported Buffer/Latency
                // oscillating between 0ms and 900ms+ repeatedly. Carrying the
                // last known-good value forward instead of resetting to 0
                // means bufferMs only changes when there's actually new
                // jitter-buffer data to compute it from.
                if (ratePrevJitterCount >= 0 && rtp.vJitterCount > ratePrevJitterCount) {
                  lastKnownBufferMs = Math.max(0,
                    ((rtp.vJitterDelay - ratePrevJitterDelay) / (rtp.vJitterCount - ratePrevJitterCount)) * 1000);
                }
                const bufferMs = lastKnownBufferMs;
                ratePrevJitterDelay = rtp.vJitterDelay;
                ratePrevJitterCount = rtp.vJitterCount;
                const totalLost = rtp.vPacketsLost + rtp.aPacketsLost;
                const totalRecv = rtp.vPktsRx + rtp.aPktsRx;
                const lossPct   = totalLost + totalRecv > 0 ? (totalLost / (totalLost + totalRecv)) * 100 : 0;
                // Approx. glass-to-glass latency — see RxSample.latencyMs's
                // comment on the interface: rttMs/2 (one-way network) +
                // bufferMs (playout hold), understates true latency but
                // tracks relative changes faithfully.
                const latencyMs = nominated.rttMs / 2 + bufferMs;
                if (ratePrevVideoBytes >= 0 && elapsed > 0 && !cancelled) {
                  const videoKbps = Math.max(0, ((rtp.vBytesRx - ratePrevVideoBytes) * 8) / 1000 / elapsed);
                  const audioKbps = Math.max(0, ((rtp.aBytesRx - ratePrevAudioBytes) * 8) / 1000 / elapsed);
                  setRxHistory(h => [...h, {
                    t: now, videoKbps, audioKbps,
                    resWidth: rtp.vWidth, resHeight: rtp.vHeight, fps: rtp.vFps,
                    bufferMs, rttMs: nominated.rttMs, lossPct, latencyMs,
                    framesDecoded: rtp.vFrames, framesReceived: rtp.vFramesReceived,
                  }].slice(-RX_HISTORY_MAX));
                }
                ratePrevVideoBytes = rtp.vBytesRx;
                ratePrevAudioBytes = rtp.aBytesRx;
              } catch (_) {}
            }, RATE_POLL_MS);
          } else if (cs === 'failed' || cs === 'closed') {
            setState('failed');
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            retryTimerRef.current = setTimeout(() => {
              if (!cancelled) setRetryCount(n => n + 1);
            }, AUTO_RETRY_DELAY);
          } else if (cs === 'disconnected') {
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            retryTimerRef.current = setTimeout(() => {
              if (!cancelled) setRetryCount(n => n + 1);
            }, 5_000);
          }
        };

        pc.oniceconnectionstatechange = () => {
          if (!cancelled) console.log(`[useWebRTC][${cameraId.slice(0,8)}] ice: ${pc.iceConnectionState}`);
        };

        // Wait up to 2s for the browser to gather its LAN host candidate.
        // We must include host candidates so mediasoup knows the browser's LAN IP.
        // We filter OUT srflx/relay candidates whose public IPs (same NAT as the
        // server's external IP) would cause NAT hairpin failures in mediasoup.
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') { resolve(); return; }
          const fb = setTimeout(resolve, 2_000);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(fb); resolve(); }
          };
        });

        if (cancelled) { pc.close(); return; }

        // Keep only typ=host candidates; strip srflx and relay to avoid NAT hairpin.
        const hostOnlySdp = _filterHostCandidates(pc.localDescription?.sdp ?? offer.sdp ?? '');

        const resp = await fetch(`/api/webrtc/whep/${cameraId}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body:    hostOnlySdp,
        });

        if (!resp.ok) {
          const txt = await resp.text().catch(() => '');
          throw new Error(`WHEP ${resp.status}: ${txt.slice(0, 120)}`);
        }

        const sdpAnswer = await resp.text();
        if (cancelled) { pc.close(); return; }

        await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

      } catch (err) {
        if (!cancelled) {
          console.error(`[useWebRTC][${cameraId.slice(0,8)}] ${(err as Error).message}`);
          // Remove placeholder entry so next retry starts fresh
          const e = sessionRegistry.get(cameraId);
          if (e && !e.stream) sessionRegistry.delete(cameraId);
          setState('failed');
          clearTimeout(connectTimeoutId);
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => {
            if (!cancelled) setRetryCount(n => n + 1);
          }, AUTO_RETRY_DELAY);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(connectTimeoutId);
      socket.off('camera:stream-unavailable', handleStreamUnavailable);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = undefined; }
      if (_lastStream && _lastInactiveHandler) {
        _lastStream.removeEventListener('inactive', _lastInactiveHandler);
      }

      detachVideo(videoRef);
      setState('idle');
      setHasAudio(false);

      const e = sessionRegistry.get(cameraId);
      if (e) {
        e.refCount--;
        if (e.refCount <= 0) {
          if (e.pc) { try { e.pc.close(); } catch (_) {} }
          sessionRegistry.delete(cameraId);
        }
        // refCount > 0: other consumers keep the session alive
      } else {
        // Entry was already removed (e.g. WHEP failed before entry was useful)
        try { pc.close(); } catch (_) {}
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, enabled, socket, retryCount, retryNonce, retry]);

  return { videoRef, state, hasAudio, retry, iceStats, rxHistory, rxCodec };
}

function _ignoreAbort(err: DOMException | Error) {
  const name = (err as DOMException).name ?? '';
  if (name !== 'AbortError' && name !== 'NotAllowedError') {
    console.warn('[useWebRTC] play():', err.message ?? err);
  }
}

// _attachAndPlay (2026-07-16) — replaces the old bare
// `video.play().catch(_ignoreAbort)` at every call site. That silently
// swallowed NotAllowedError exactly like the harmless AbortError case
// (superseded play() calls, e.g. from React re-attaching srcObject), but
// NotAllowedError means the element is genuinely stuck paused — confirmed
// live via Chrome's own Media panel showing "Pause" for a tile whose element
// still displayed its last decoded frame (a paused <video> keeps rendering
// its current frame, so a frozen-but-present image gave no visual sign
// anything was wrong). All several tiles autoplaying at once on page load /
// mass-reconnect is exactly the kind of burst that can trip a transient
// autoplay rejection, so retry once after a short delay before giving up —
// unlike AbortError, a NotAllowedError is often gone on the next attempt
// once the burst settles.
function _attachAndPlay(video: HTMLVideoElement, cameraId: string) {
  video.play().catch((err: DOMException | Error) => {
    const name = (err as DOMException).name ?? '';
    if (name === 'NotAllowedError') {
      console.warn(`[useWebRTC][${cameraId.slice(0,8)}] play() blocked (NotAllowedError) — retrying once`);
      setTimeout(() => {
        video.play().catch((err2: DOMException | Error) => {
          const name2 = (err2 as DOMException).name ?? '';
          if (name2 !== 'AbortError') {
            console.warn(`[useWebRTC][${cameraId.slice(0,8)}] play() retry failed:`, err2.message ?? err2);
          }
        });
      }, 500);
      return;
    }
    _ignoreAbort(err);
  });
}

// Keep typ=host candidates (all) and typ=srflx candidates whose address is
// in an RFC-1918 private range (i.e. from a local STUN server like coturn on
// the same LAN). This gives mediasoup the browser's reachable LAN address
// while excluding public srflx/relay candidates that cause NAT hairpin issues.
function _filterHostCandidates(sdp: string): string {
  return sdp
    .split('\n')
    .filter(line => {
      if (!line.startsWith('a=candidate:')) return true;
      if (line.includes(' typ host')) return true;
      if (line.includes(' typ srflx')) {
        // Only keep srflx if the mapped address is private (RFC 1918)
        const m = line.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m) {
          const ip = m[1];
          return ip.startsWith('10.') ||
                 ip.startsWith('192.168.') ||
                 /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
        }
      }
      return false;
    })
    .join('\n');
}
