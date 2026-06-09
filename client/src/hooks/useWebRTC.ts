import { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from './useSocket';
import { useWebRTCConfigStore } from '../stores/webrtcConfigStore';

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
const ICE_GATHER_TIMEOUT = 5_000;

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

  const retry = useCallback(() => {
    setRetryCount(0);
    setRetryNonce(n => n + 1);
  }, []);

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
        videoRef.current.play().catch(_ignoreAbort);
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
          videoRef.current.play().catch(_ignoreAbort);
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
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (event) => {
      if (cancelled || !videoRef.current) return;
      const stream = event.streams?.[0];
      if (!stream) return;
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
      videoRef.current.play().catch(_ignoreAbort);
      if (!cancelled) setHasAudio(ha);
    };

    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') { resolve(); return; }
          const fb = setTimeout(resolve, ICE_GATHER_TIMEOUT);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(fb); resolve(); }
          };
        });

        if (cancelled) { pc.close(); return; }

        const resp = await fetch(`/api/webrtc/whep/${cameraId}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body:    pc.localDescription?.sdp ?? offer.sdp,
        });

        if (!resp.ok) {
          const txt = await resp.text().catch(() => '');
          throw new Error(`WHEP ${resp.status}: ${txt.slice(0, 120)}`);
        }

        const sdpAnswer = await resp.text();
        if (cancelled) { pc.close(); return; }

        await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

        pc.onconnectionstatechange = () => {
          if (cancelled) return;
          const cs = pc.connectionState;
          console.log(`[useWebRTC][${cameraId.slice(0,8)}] connection: ${cs}`);
          if (cs === 'connected') {
            clearTimeout(connectTimeoutId);
            setState('connected');
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
  }, [cameraId, enabled, socket, retryCount, retryNonce]);

  return { videoRef, state, hasAudio, retry, iceStats: null as IceStats | null };
}

function _ignoreAbort(err: DOMException | Error) {
  const name = (err as DOMException).name ?? '';
  if (name !== 'AbortError' && name !== 'NotAllowedError') {
    console.warn('[useWebRTC] play():', err.message ?? err);
  }
}
