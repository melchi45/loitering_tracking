import { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from './useSocket';

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

/**
 * WebRTC hook — uses MediaMTX WHEP via the Node.js proxy at
 * POST /api/webrtc/whep/:cameraId
 *
 * Replaces the previous mediasoup-client implementation. The signaling is a
 * single HTTP POST (SDP offer → answer); all ICE/DTLS complexity is handled
 * by the browser's native RTCPeerConnection and MediaMTX.
 */
export function useWebRTC(cameraId: string, enabled: boolean) {
  const { socket }  = useSocket();
  const videoRef                    = useRef<HTMLVideoElement>(null);
  const [state, setState]           = useState<WebRTCState>('idle');
  const [hasAudio, setHasAudio]     = useState(false);

  const pcRef         = useRef<RTCPeerConnection | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => {
    setRetryCount(0);
  }, []);

  const cleanup = useCallback(() => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = undefined; }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch (_) {}
      pcRef.current = null;
    }
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch (_) {}
      videoRef.current.srcObject = null;
    }
    setState('idle');
    setHasAudio(false);
  }, []);

  useEffect(() => {
    if (!enabled || !cameraId) return;

    if (retryCount >= MAX_AUTO_RETRIES) {
      setState('failed');
      return;
    }

    let cancelled = false;
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

    // camera:stream-unavailable from server (RTSP down) — schedule retry
    const handleStreamUnavailable = ({ cameraId: id }: { cameraId: string }) => {
      if (id !== cameraId || cancelled) return;
      setState('failed');
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        if (!cancelled) setRetryCount(n => n + 1);
      }, AUTO_RETRY_DELAY);
    };
    socket.on('camera:stream-unavailable', handleStreamUnavailable);

    (async () => {
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pcRef.current = pc;

        // Receive-only transceivers (browser is consumer only)
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        // Assign tracks to video element as soon as they arrive
        pc.ontrack = (event) => {
          if (cancelled || !videoRef.current) return;
          const stream = event.streams?.[0];
          if (!stream) return;
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch((err: DOMException | Error) => {
            const name = (err as DOMException).name ?? '';
            if (name !== 'AbortError' && name !== 'NotAllowedError') {
              console.warn(`[useWebRTC][${cameraId.slice(0,8)}] play(): ${err.message}`);
            }
          });
          const audioTracks = stream.getAudioTracks();
          if (!cancelled) setHasAudio(audioTracks.length > 0);
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering (trickle-free WHEP sends all candidates in offer)
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') { resolve(); return; }
          const fallback = setTimeout(resolve, ICE_GATHER_TIMEOUT);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(fallback); resolve(); }
          };
        });

        if (cancelled) { pc.close(); return; }

        // POST SDP offer to Node.js WHEP proxy → get SDP answer from MediaMTX
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
      cleanup();
    };
  }, [cameraId, enabled, socket, retryCount, cleanup]);

  return { videoRef, state, hasAudio, retry, iceStats: null as IceStats | null };
}
