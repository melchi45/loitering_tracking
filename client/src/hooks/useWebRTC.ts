import { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from './useSocket';
import { useWebRTCConfigStore } from '../stores/webrtcConfigStore';
import { useDataChannelStore } from '../stores/dataChannelStore';
import { registerPeerConnection } from '../clientLogger';

// Kept for backwards compatibility with components that import this type
export interface IceStats {
  localType:     string;
  localProtocol: string;
  localAddress:  string;
  localPort:     number;
  remoteType:    string;
  remoteAddress: string;
  remotePort:    number;
  bytesSent:     number;
  bytesReceived: number;
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
      // one track ends, so onconnectionstatechange never fires and the retry
      // logic below was never triggered — the video simply froze forever on
      // its last decoded frame with no way to recover short of a page reload.
      // Confirmed live against TID-A800, whose capture restarts every
      // 20-40s during rough patches. retry() forces a fresh WHEP negotiation.
      if (trackKind === 'video') {
        event.track.onended = () => {
          console.log(`[useWebRTC][${cameraId.slice(0,8)}] track-ENDED: kind=${trackKind} — reconnecting`);
          if (!cancelled) retry();
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
            let lastBytesRx     = -1;
            let lastBytesRxAt   = Date.now();
            let lastFrames      = -1;
            let lastFramesAt    = Date.now();
            let statsTick       = 0;
            const statsTimer = setInterval(async () => {
              if (cancelled) { clearInterval(statsTimer); return; }
              try {
                const stats = await pc.getStats();
                let vBytesRx = 0, vPktsRx = 0, vFrames = 0;
                let cpBytesRx = 0, cpBytesTx = 0;
                let localCand = '', remoteCand = '';
                let localInfo:  { type: string; protocol: string; address: string; port: number } | null = null;
                let remoteInfo: { type: string; protocol: string; address: string; port: number } | null = null;
                const candidatePairIds = new Set<string>();
                stats.forEach(r => {
                  if (r.type === 'inbound-rtp' && r.kind === 'video') {
                    vBytesRx = r.bytesReceived ?? 0;
                    vPktsRx  = r.packetsReceived ?? 0;
                    vFrames  = r.framesDecoded ?? 0;
                  }
                  if (r.type === 'candidate-pair' && r.nominated) {
                    cpBytesRx += r.bytesReceived ?? 0;
                    cpBytesTx += r.bytesSent ?? 0;
                    const lcId = r.localCandidateId ?? '';
                    const rcId = r.remoteCandidateId ?? '';
                    if (lcId) candidatePairIds.add('L:' + lcId);
                    if (rcId) candidatePairIds.add('R:' + rcId);
                    localCand  = lcId;
                    remoteCand = rcId;
                  }
                  if (r.type === 'local-candidate' && candidatePairIds.has('L:' + r.id)) {
                    localCand = `${r.candidateType}/${r.protocol}/${r.address}:${r.port}`;
                    localInfo = { type: r.candidateType, protocol: r.protocol, address: r.address, port: r.port };
                  }
                  if (r.type === 'remote-candidate' && candidatePairIds.has('R:' + r.id)) {
                    remoteCand = `${r.candidateType}/${r.protocol}/${r.address}:${r.port}`;
                    remoteInfo = { type: r.candidateType, protocol: r.protocol, address: r.address, port: r.port };
                  }
                });
                if (localInfo && remoteInfo) {
                  const li = localInfo as { type: string; protocol: string; address: string; port: number };
                  const ri = remoteInfo as { type: string; protocol: string; address: string; port: number };
                  setIceStats({
                    localType:     li.type,
                    localProtocol: li.protocol,
                    localAddress:  li.address,
                    localPort:     li.port,
                    remoteType:    ri.type,
                    remoteAddress: ri.address,
                    remotePort:    ri.port,
                    bytesSent:     cpBytesTx,
                    bytesReceived: cpBytesRx,
                  });
                }
                statsTick += 1;
                if (statsTick <= 10) {
                  // Verbose connect-time diagnostics only for the first ~50s.
                  console.log(
                    `[useWebRTC][${cameraId.slice(0,8)}] stats t+${statsTick*POLL_MS/1000}s:` +
                    ` vBytesRx=${vBytesRx} vPkts=${vPktsRx} vFrames=${vFrames}` +
                    ` cpRx=${cpBytesRx} cpTx=${cpBytesTx}` +
                    ` local=${localCand} remote=${remoteCand}`
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
                let frameStalled = false;
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
                const staleReconnect = (reason: string) => {
                  const backoffMs = Math.min(retryCount * 2_000, 15_000);
                  console.log(`[useWebRTC][${cameraId.slice(0,8)}] ${reason} — reconnecting in ${Math.round((AUTO_RETRY_DELAY + backoffMs)/1000)}s`);
                  clearInterval(statsTimer);
                  if (cancelled) return;
                  setState('failed');
                  if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
                  retryTimerRef.current = setTimeout(() => {
                    if (!cancelled) setRetryCount(n => n + 1);
                  }, AUTO_RETRY_DELAY + backoffMs);
                };
                if (frameStalled) {
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

  return { videoRef, state, hasAudio, retry, iceStats };
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
