import { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from './useSocket';
import { useWebRTCConfigStore } from '../stores/webrtcConfigStore';

// mediasoup-client types — declared locally so the package doesn't need to be
// installed for TypeScript compilation (runtime import is dynamic).
type RtpCapabilities = Record<string, unknown>;

type WebRTCState = 'idle' | 'connecting' | 'connected' | 'failed';

export interface IceStats {
  localType:     string;  // 'host' | 'srflx' | 'relay'
  localProtocol: string;  // 'udp' | 'tcp'
  localAddress:  string;
  localPort:     number;
  remoteType:    string;
  remoteAddress: string;
  remotePort:    number;
  bytesSent:     number;
  bytesReceived: number;
}

interface ConsumerParams {
  id:            string;
  producerId:    string;
  kind:          'audio' | 'video';
  rtpParameters: unknown;
}

interface ConsumeResult {
  video?: ConsumerParams;
  audio?: ConsumerParams;
  error?: string;
}

// Max time to wait for the full signaling + ICE + DTLS handshake.
// If exceeded, the state is set to 'failed' so the user can see an error.
const CONNECT_TIMEOUT_MS    = 30_000;
const ICE_DISCONNECT_WAIT   = 5_000;  // how long to wait for ICE self-recovery
const MAX_AUTO_RETRIES      = 8;   // covers ~32 s of startup retries (8 × 4 s)
const AUTO_RETRY_DELAY      = 4_000;

// Errors that indicate a transient server startup state — retry silently
const PIPELINE_STARTING_RE = /pipeline not ready|no video producer|no producers available/i;

export function useWebRTC(cameraId: string, enabled: boolean) {
  const { socket }  = useSocket();
  // Use a stable selector — avoids re-triggering the effect when unrelated
  // store fields change (webrtcConfig whole-object reference would change on any set()).
  const getIceServers = useWebRTCConfigStore((s) => s.getIceServers);

  const videoRef                    = useRef<HTMLVideoElement>(null);
  const [state, setState]           = useState<WebRTCState>('idle');
  const [hasAudio, setHasAudio]     = useState(false);

  const deviceRef       = useRef<any>(null);
  const transportRef    = useRef<any>(null);
  const consumersRef    = useRef<any[]>([]);
  const retryTimerRef   = useRef<ReturnType<typeof setTimeout>>();
  const icePollerRef    = useRef<ReturnType<typeof setInterval>>();

  const [retryCount, setRetryCount] = useState(0);
  const [iceStats, setIceStats]     = useState<IceStats | null>(null);

  const retry = useCallback(() => {
    setRetryCount(0); // reset counter so auto-retry grace period starts fresh
  }, []);

  const cleanup = useCallback(() => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = undefined; }
    if (icePollerRef.current)  { clearInterval(icePollerRef.current);  icePollerRef.current  = undefined; }
    setIceStats(null);
    for (const c of consumersRef.current) {
      try { if (!c.closed) c.close(); } catch (_) {}
    }
    consumersRef.current = [];
    if (transportRef.current) {
      try { if (!transportRef.current.closed) transportRef.current.close(); } catch (_) {}
      transportRef.current = null;
    }
    deviceRef.current = null;
    if (videoRef.current) {
      // Pause before clearing srcObject to avoid an AbortError on any in-flight
      // play() promise (the browser interrupts play when srcObject changes).
      try { videoRef.current.pause(); } catch (_) {}
      videoRef.current.srcObject = null;
    }
    socket.emit('webrtc:leave', { cameraId });
    setState('idle');
    setHasAudio(false);
  }, [cameraId, socket]);

  useEffect(() => {
    if (!enabled || !cameraId) return;

    let cancelled = false;

    // Coordinate two async events: srcObject being set on the video element,
    // and the transport reaching 'connected'. Both must be true before we
    // call setState('connected') so the video is never shown blank.
    let srcObjectReady     = false;
    let transportConnected = false;

    // ── Connection timeout ────────────────────────────────────────────────
    // If the full setup (signaling + ICE + DTLS + first frame) doesn't
    // complete within CONNECT_TIMEOUT_MS, show the user a 'failed' state.
    const connectTimeoutId = setTimeout(() => {
      if (!cancelled && transportRef.current) {
        const cs = transportRef.current?.connectionState;
        if (cs !== 'connected') {
          console.warn(`[useWebRTC][${cameraId.slice(0,8)}] connect timeout (30 s) — state: ${cs}`);
          setState('failed');
        }
      }
    }, CONNECT_TIMEOUT_MS);

    setState('connecting');

    // ── Producer-closed notification from server ───────────────────────────
    // When the RTSP pipeline stops (camera disconnects, FFmpeg restarts),
    // the server emits this event so we can schedule a reconnect immediately
    // rather than waiting for the ICE disconnect timeout.
    const handleProducerClosed = ({ cameraId: closedId }: { cameraId: string }) => {
      if (closedId !== cameraId || cancelled) return;
      console.warn(`[useWebRTC][${cameraId.slice(0,8)}] server: producer closed — scheduling retry`);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = undefined; }
      retryTimerRef.current = setTimeout(() => {
        if (!cancelled) setRetryCount((n) => n + 1);
      }, AUTO_RETRY_DELAY);
    };
    socket.on('webrtc:producer-closed', handleProducerClosed);

    (async () => {
      try {
        // ── Dynamic import ────────────────────────────────────────────────
        // @ts-ignore
        const { Device } = await import('mediasoup-client');
        if (cancelled) return;

        // 1. Get router RTP capabilities
        const routerRtpCapabilities = await new Promise<RtpCapabilities>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('getCapabilities timed out')), 10_000);
          socket.emit('webrtc:getCapabilities', { cameraId }, (caps: RtpCapabilities & { error?: string }) => {
            clearTimeout(t);
            if (caps?.error) reject(new Error(caps.error));
            else resolve(caps);
          });
        });
        if (cancelled) return;

        // 2. Load mediasoup Device
        const device = new Device();
        await device.load({ routerRtpCapabilities });
        deviceRef.current = device;
        if (cancelled) return;

        // 3. Create server-side WebRtcTransport
        const transportParams = await new Promise<any>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('createTransport timed out')), 10_000);
          socket.emit('webrtc:createTransport', { cameraId }, (params: any) => {
            clearTimeout(t);
            if (params?.error) reject(new Error(params.error));
            else resolve(params);
          });
        });
        if (cancelled) { socket.emit('webrtc:leave', { cameraId }); return; }

        // 4. Create client-side RecvTransport
        const iceServers = getIceServers();
        const transport = device.createRecvTransport({
          ...transportParams,
          ...(iceServers.length ? { iceServers } : {}),
        });
        transportRef.current = transport;

        // ── ICE / connection state monitoring ─────────────────────────────
        transport.on('icegatheringstatechange', (s: string) =>
          console.log(`[useWebRTC][${cameraId.slice(0,8)}] ICE gathering: ${s}`));

        const pollIceStats = async () => {
          if (!transportRef.current) return;
          try {
            const report: RTCStatsReport = await transportRef.current.getStats();
            let selectedPair: any = null;
            const candidates = new Map<string, any>();
            report.forEach((e: any) => {
              if (e.type === 'local-candidate' || e.type === 'remote-candidate') candidates.set(e.id, e);
              if (e.type === 'candidate-pair' && e.nominated) selectedPair = e;
            });
            if (!selectedPair) return;
            const loc = candidates.get(selectedPair.localCandidateId);
            const rem = candidates.get(selectedPair.remoteCandidateId);
            setIceStats({
              localType:     loc?.candidateType ?? '?',
              localProtocol: loc?.protocol      ?? '?',
              localAddress:  loc?.address ?? loc?.ip ?? '?',
              localPort:     loc?.port          ?? 0,
              remoteType:    rem?.candidateType ?? '?',
              remoteAddress: rem?.address ?? rem?.ip ?? '?',
              remotePort:    rem?.port          ?? 0,
              bytesSent:     selectedPair.bytesSent     ?? 0,
              bytesReceived: selectedPair.bytesReceived ?? 0,
            });
          } catch { /* getStats() can throw if transport closed */ }
        };

        // Transition to 'connected' UI state only when BOTH the transport ICE/DTLS
        // handshake is done AND srcObject has been assigned to the video element.
        // This prevents showing a blank video when connectionstatechange fires
        // before the consume loop finishes setting srcObject.
        const markConnected = () => {
          if (cancelled) return;
          clearTimeout(connectTimeoutId);
          if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = undefined; }
          setState('connected');
          if (icePollerRef.current) clearInterval(icePollerRef.current);
          pollIceStats();
          icePollerRef.current = setInterval(pollIceStats, 3000);
        };

        transport.on('connectionstatechange', (s: string) => {
          console.log(`[useWebRTC][${cameraId.slice(0,8)}] connection state: ${s}`);
          if (cancelled) return;
          if (s === 'connected') {
            transportConnected = true;
            // Only flip to UI-connected when srcObject is already set.
            // If not yet (race: ICE done before consume loop finishes), srcObjectReady
            // path below will call markConnected() once srcObject is assigned.
            if (srcObjectReady) markConnected();
          } else if (s === 'disconnected') {
            // Transient — ICE may self-recover. Force a retry if it doesn't within 5 s.
            console.warn(`[useWebRTC][${cameraId.slice(0,8)}] ICE disconnected (waiting up to ${ICE_DISCONNECT_WAIT / 1000} s…)`);
            retryTimerRef.current = setTimeout(() => {
              if (!cancelled) {
                console.warn(`[useWebRTC][${cameraId.slice(0,8)}] disconnected timeout — forcing retry`);
                setRetryCount((n) => n + 1);
              }
            }, ICE_DISCONNECT_WAIT);
          } else if (s === 'failed' || s === 'closed') {
            console.warn(`[useWebRTC][${cameraId.slice(0,8)}] ICE/DTLS ${s}`);
            setState('failed');
            // Auto-retry up to MAX_AUTO_RETRIES times
            if (retryCount < MAX_AUTO_RETRIES) {
              retryTimerRef.current = setTimeout(() => {
                if (!cancelled) setRetryCount((n) => n + 1);
              }, AUTO_RETRY_DELAY);
            }
          }
        });

        transport.on('connect', ({ dtlsParameters }: any, callback: () => void, errback: (e: Error) => void) => {
          socket.emit('webrtc:connectTransport',
            { cameraId, transportId: transport.id, dtlsParameters },
            (res: { error?: string }) => {
              if (res?.error) errback(new Error(res.error));
              else callback();
            },
          );
        });

        // 5. Request consumers from server
        const consumeResult = await new Promise<ConsumeResult>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('consume timed out')), 15_000);
          socket.emit('webrtc:consume',
            { cameraId, transportId: transport.id, rtpCapabilities: device.rtpCapabilities },
            (params: ConsumeResult) => {
              clearTimeout(t);
              if (params?.error) reject(new Error(params.error));
              else resolve(params);
            },
          );
        });
        if (cancelled) return;

        if (!consumeResult.video && !consumeResult.audio) {
          throw new Error('No producers available yet — camera may not be streaming');
        }

        // 6. Consume tracks
        const tracks: MediaStreamTrack[] = [];
        let audioTrackFound = false;

        for (const [key, params] of Object.entries(consumeResult) as [string, ConsumerParams][]) {
          if (!params?.id) continue;
          if (cancelled) return;
          const consumer = await transport.consume(params as any);
          consumersRef.current.push(consumer);
          tracks.push(consumer.track);
          if (key === 'audio') audioTrackFound = true;
          socket.emit('webrtc:resumeConsumer', { cameraId, consumerId: consumer.id });
          console.log(`[useWebRTC][${cameraId.slice(0,8)}] consuming ${key} track`);
        }

        if (cancelled) return;

        if (tracks.length > 0 && videoRef.current) {
          // Capture the video element reference before any async operation —
          // cleanup may set videoRef.current = null while play() is pending.
          const videoEl = videoRef.current;
          videoEl.srcObject = new MediaStream(tracks);

          // play() is asynchronous. If cleanup runs while it is pending, the
          // browser interrupts it with an AbortError ("interrupted by a new load
          // request"). That is expected and safe to ignore silently.
          await videoEl.play().catch((err: DOMException | Error) => {
            const name = (err as DOMException).name ?? '';
            if (name === 'AbortError' || name === 'NotAllowedError') {
              // AbortError  — srcObject was replaced/cleared during play(); harmless.
              // NotAllowedError — autoplay blocked; video will play on first user gesture.
              console.log(`[useWebRTC][${cameraId.slice(0,8)}] play() deferred (${name || err.message})`);
            } else {
              console.warn(`[useWebRTC][${cameraId.slice(0,8)}] play() warning:`, err.message);
            }
          });

          if (!cancelled) setHasAudio(audioTrackFound);

          // srcObject is now set. If ICE/DTLS already reached 'connected' before
          // the consume loop finished (race condition), flip to UI-connected now.
          // Otherwise markConnected() will be called from connectionstatechange.
          srcObjectReady = true;
          if (transportConnected) {
            markConnected();
          } else {
            console.log(`[useWebRTC][${cameraId.slice(0,8)}] tracks ready — awaiting ICE connection`);
          }
        } else if (!cancelled) {
          // No video tracks or videoRef not available — mark src as "ready" so
          // connectionstatechange can still flip to connected (e.g. audio-only).
          srcObjectReady = true;
          if (transportConnected) markConnected();
          console.warn(`[useWebRTC][${cameraId.slice(0,8)}] videoRef not ready — awaiting connection`);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = (err as Error).message ?? '';
          if (PIPELINE_STARTING_RE.test(msg) && retryCount < MAX_AUTO_RETRIES) {
            // Pipeline is still starting — keep 'connecting' state and retry
            console.log(`[useWebRTC][${cameraId.slice(0,8)}] pipeline starting, retry ${retryCount + 1}/${MAX_AUTO_RETRIES}`);
            clearTimeout(connectTimeoutId);
            retryTimerRef.current = setTimeout(() => {
              if (!cancelled) setRetryCount((n) => n + 1);
            }, AUTO_RETRY_DELAY);
          } else {
            console.error(`[useWebRTC][${cameraId.slice(0,8)}] setup failed:`, err);
            setState('failed');
            clearTimeout(connectTimeoutId);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(connectTimeoutId);
      socket.off('webrtc:producer-closed', handleProducerClosed);
      cleanup();
    };
  }, [cameraId, enabled, socket, getIceServers, cleanup, retryCount]);

  return { videoRef, state, hasAudio, retry, iceStats };
}

