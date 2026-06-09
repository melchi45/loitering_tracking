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
// How long to wait for ICE gathering before sending the offer anyway.
const ICE_GATHER_TIMEOUT = 5_000;

// ── Shared session registry ────────────────────────────────────────────────
// Stores the active RTCPeerConnection + MediaStream per camera so that a
// second consumer (e.g. fullscreen modal opening over the grid) can attach
// to the existing stream immediately instead of waiting for a new WHEP
// negotiation.
//
// Lifecycle:
//   • First consumer → negotiates WHEP, stores entry with refCount=1.
//   • Second consumer (cache hit) → increments refCount, attaches stream.
//   • Any consumer leaving → decrements refCount.
//   • Last consumer leaving (refCount reaches 0) → closes PC, deletes entry.
interface SessionEntry {
  pc:       RTCPeerConnection;
  stream:   MediaStream;
  hasAudio: boolean;
  refCount: number;
}
const sessionRegistry = new Map<string, SessionEntry>();

// ── Helpers shared between effect paths ───────────────────────────────────

function detachVideoElement(videoRef: React.RefObject<HTMLVideoElement>) {
  if (!videoRef.current) return;
  try { videoRef.current.pause(); } catch (_) {}
  videoRef.current.srcObject = null;
}

function closeEntry(cameraId: string) {
  const entry = sessionRegistry.get(cameraId);
  if (!entry) return;
  try { entry.pc.close(); } catch (_) {}
  sessionRegistry.delete(cameraId);
}

/**
 * WebRTC hook — uses MediaMTX WHEP via the Node.js proxy at
 * POST /api/webrtc/whep/:cameraId
 *
 * When multiple components mount with the same cameraId (e.g. grid cell +
 * fullscreen modal), the first one negotiates WHEP and all subsequent ones
 * immediately reuse the cached MediaStream.  The RTCPeerConnection stays
 * alive until the last consumer unmounts.
 */
export function useWebRTC(cameraId: string, enabled: boolean) {
  const { socket }    = useSocket();
  const getIceServers = useWebRTCConfigStore((s) => s.getIceServers);
  const videoRef      = useRef<HTMLVideoElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Seed initial state from registry so fullscreen shows "connected" immediately
  const [state, setState] = useState<WebRTCState>(() => {
    const e = sessionRegistry.get(cameraId);
    return (e && e.stream.active) ? 'connected' : 'idle';
  });
  const [hasAudio, setHasAudio] = useState<boolean>(() => {
    const e = sessionRegistry.get(cameraId);
    return !!(e && e.stream.active && e.hasAudio);
  });

  const [retryCount, setRetryCount] = useState(0);
  // Incremented when a cached stream goes inactive to force re-negotiation
  const [retryNonce, setRetryNonce] = useState(0);

  const retry = useCallback(() => {
    setRetryCount(0);
    setRetryNonce(n => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !cameraId) return;
    if (retryCount >= MAX_AUTO_RETRIES) { setState('failed'); return; }

    let cancelled = false;

    // ── Path A: reuse an existing session ─────────────────────────────────
    const existing = sessionRegistry.get(cameraId);
    if (existing && existing.stream.active) {
      existing.refCount++;
      setState('connected');
      setHasAudio(existing.hasAudio);
      if (videoRef.current) {
        videoRef.current.srcObject = existing.stream;
        videoRef.current.play().catch((err: DOMException | Error) => {
          const name = (err as DOMException).name ?? '';
          if (name !== 'AbortError' && name !== 'NotAllowedError') {
            console.warn(`[useWebRTC][${cameraId.slice(0,8)}] cached play(): ${err.message}`);
          }
        });
      }

      // Re-negotiate when the stream owner closes the PC
      const handleInactive = () => {
        if (sessionRegistry.get(cameraId) === existing) {
          sessionRegistry.delete(cameraId);
        }
        if (!cancelled) {
          setState('connecting');
          setRetryNonce(n => n + 1);
        }
      };
      existing.stream.addEventListener('inactive', handleInactive);

      return () => {
        cancelled = true;
        existing.stream.removeEventListener('inactive', handleInactive);
        detachVideoElement(videoRef);
        setState('idle');
        setHasAudio(false);

        const entry = sessionRegistry.get(cameraId);
        if (entry) {
          entry.refCount--;
          if (entry.refCount <= 0) closeEntry(cameraId);
        }
      };
    }

    // ── Path B: negotiate a new WHEP session ──────────────────────────────
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
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (event) => {
      if (cancelled || !videoRef.current) return;
      const stream = event.streams?.[0];
      if (!stream) return;
      const ha = stream.getAudioTracks().length > 0;

      // Register (or update) the shared session entry
      const cur = sessionRegistry.get(cameraId);
      if (cur) {
        cur.stream   = stream;
        cur.hasAudio = ha;
      } else {
        sessionRegistry.set(cameraId, { pc, stream, hasAudio: ha, refCount: 1 });
      }

      videoRef.current.srcObject = stream;
      videoRef.current.play().catch((err: DOMException | Error) => {
        const name = (err as DOMException).name ?? '';
        if (name !== 'AbortError' && name !== 'NotAllowedError') {
          console.warn(`[useWebRTC][${cameraId.slice(0,8)}] play(): ${err.message}`);
        }
      });
      if (!cancelled) setHasAudio(ha);
    };

    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') { resolve(); return; }
          const fallback = setTimeout(resolve, ICE_GATHER_TIMEOUT);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(fallback); resolve(); }
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
          const msg = (err as Error).message ?? '';
          console.error(`[useWebRTC][${cameraId.slice(0,8)}] ${msg}`);
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

      detachVideoElement(videoRef);
      setState('idle');
      setHasAudio(false);

      // Decrement refCount; only close the PC when the last consumer leaves
      const entry = sessionRegistry.get(cameraId);
      if (entry) {
        entry.refCount--;
        if (entry.refCount <= 0) {
          try { entry.pc.close(); } catch (_) {}
          sessionRegistry.delete(cameraId);
        }
        // If refCount > 0: other consumers hold the stream, keep PC alive
      } else {
        // Connection failed before the session was registered
        try { pc.close(); } catch (_) {}
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, enabled, socket, retryCount, retryNonce]);

  return { videoRef, state, hasAudio, retry, iceStats: null as IceStats | null };
}
