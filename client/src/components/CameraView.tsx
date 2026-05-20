import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useCamera } from '../hooks/useCamera';
import { useWebRTC } from '../hooks/useWebRTC';
import { useCameraStore } from '../stores/cameraStore';
import { useI18n } from '../i18n';
import ZoneEditor from './ZoneEditor';
import type { Detection, Zone } from '../types';

interface Props {
  cameraId: string;
  cameraName: string;
}

function getRenderArea(fw: number, fh: number, cw: number, ch: number) {
  const ia = fw / fh, ca = cw / ch;
  if (ia > ca) return { rw: cw, rh: cw / ia, ox: 0, oy: (ch - cw / ia) / 2 };
  return { rw: ch * ia, rh: ch, ox: (cw - ch * ia) / 2, oy: 0 };
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  detections: Detection[],
  zones: Zone[],
  frameWidth: number,
  frameHeight: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cw = canvas.clientWidth  || canvas.width;
  const ch = canvas.clientHeight || canvas.height;
  canvas.width  = cw;
  canvas.height = ch;
  ctx.clearRect(0, 0, cw, ch);

  const { rw, rh, ox, oy } = getRenderArea(frameWidth, frameHeight, cw, ch);
  const sx = rw / frameWidth;
  const sy = rh / frameHeight;

  // ── Zone polygons ────────────────────────────────────────────────────────
  for (const zone of zones) {
    if (zone.polygon.length < 2) continue;
    const isMonitor = zone.type === 'MONITOR';
    ctx.beginPath();
    for (let i = 0; i < zone.polygon.length; i++) {
      const px = ox + zone.polygon[i].x * sx;
      const py = oy + zone.polygon[i].y * sy;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle   = isMonitor ? 'rgba(59,130,246,0.12)' : 'rgba(245,158,11,0.12)';
    ctx.strokeStyle = isMonitor ? 'rgba(59,130,246,0.8)'  : 'rgba(245,158,11,0.8)';
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();

    // Zone label at centroid
    const ax = zone.polygon.reduce((s, p) => s + p.x, 0) / zone.polygon.length;
    const ay = zone.polygon.reduce((s, p) => s + p.y, 0) / zone.polygon.length;
    const lx = ox + ax * sx;
    const ly = oy + ay * sy;
    ctx.font = 'bold 10px sans-serif';
    const tw = ctx.measureText(zone.name).width + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(lx - tw / 2, ly - 8, tw, 14);
    ctx.fillStyle = isMonitor ? '#60a5fa' : '#fbbf24';
    ctx.textAlign = 'center';
    ctx.fillText(zone.name, lx, ly + 3);
    ctx.textAlign = 'left';
  }

  // ── Detection BBoxes ─────────────────────────────────────────────────────
  for (const det of detections) {
    const { bbox, objectId, confidence, isLoitering, dwellTime, className } = det;

    const x = ox + bbox.x * sx;
    const y = oy + bbox.y * sy;
    const w = bbox.width  * sx;
    const h = bbox.height * sy;

    // Loitering always red; otherwise color by class
    const isFire  = className === 'fire';
    const isSmoke = className === 'smoke';
    const color = isLoitering ? 'rgba(239,68,68,0.9)' : (() => {
      switch (className) {
        case 'person':     return 'rgba(34,197,94,0.9)';   // green
        case 'bicycle':    return 'rgba(250,204,21,0.9)';  // yellow
        case 'car':        return 'rgba(59,130,246,0.9)';  // blue
        case 'motorcycle': return 'rgba(249,115,22,0.9)';  // orange
        case 'bus':        return 'rgba(168,85,247,0.9)';  // purple
        case 'truck':      return 'rgba(20,184,166,0.9)';  // teal
        case 'fire':       return 'rgba(255,80,0,1.0)';     // orange-red
        case 'smoke':      return 'rgba(100,116,139,0.9)';  // slate gray
        case 'face':       return 'rgba(147,197,253,0.95)'; // light blue
        case 'backpack':
        case 'umbrella':
        case 'handbag':
        case 'tie':
        case 'suitcase':     return 'rgba(245,158,11,0.9)';   // amber
        // Indoor / office objects (COCO 80-class)
        case 'chair':        return 'rgba(139,92,246,0.9)';   // violet
        case 'couch':        return 'rgba(167,139,250,0.9)';  // violet-400
        case 'dining table': return 'rgba(16,185,129,0.9)';   // emerald
        case 'bed':          return 'rgba(99,102,241,0.9)';   // indigo
        case 'tv':           return 'rgba(14,165,233,0.9)';   // sky
        case 'laptop':       return 'rgba(6,182,212,0.9)';    // cyan
        case 'mouse':        return 'rgba(251,191,36,0.9)';   // amber-300
        case 'keyboard':     return 'rgba(236,72,153,0.9)';   // pink
        case 'cell phone':   return 'rgba(248,113,113,0.9)';  // red-400
        case 'clock':        return 'rgba(52,211,153,0.9)';   // emerald-400
        case 'cup':          return 'rgba(251,146,60,0.9)';   // orange
        case 'bottle':       return 'rgba(163,230,53,0.9)';   // lime
        case 'book':         return 'rgba(196,181,253,0.9)';  // violet-300
        case 'remote':       return 'rgba(209,213,219,0.9)';  // gray-300
        case 'vase':         return 'rgba(244,114,182,0.9)';  // pink-400
        // Accessories — sports equipment (amber-toned)
        case 'sports ball':    return 'rgba(251,146,60,0.9)';   // orange-400
        case 'frisbee':        return 'rgba(253,186,116,0.9)';  // orange-300
        case 'skis':           return 'rgba(14,165,233,0.9)';   // sky-500
        case 'snowboard':      return 'rgba(56,189,248,0.9)';   // sky-400
        case 'baseball bat':   return 'rgba(234,179,8,0.9)';    // yellow-500
        case 'baseball glove': return 'rgba(202,138,4,0.9)';    // yellow-600
        case 'skateboard':     return 'rgba(249,115,22,0.9)';   // orange-500
        case 'surfboard':      return 'rgba(6,182,212,0.9)';    // cyan-500
        case 'tennis racket':  return 'rgba(163,230,53,0.9)';   // lime-400
        case 'kite':           return 'rgba(192,132,252,0.9)';  // violet-400
        case 'scissors':       return 'rgba(148,163,184,0.9)';  // slate-400
        case 'fork':           return 'rgba(209,213,219,0.9)';  // gray-300
        case 'knife':          return 'rgba(156,163,175,0.9)';  // gray-400
        case 'spoon':          return 'rgba(229,231,235,0.9)';  // gray-200
        // Animals — warm tones
        case 'bird':       return 'rgba(251,207,232,0.9)';  // pink-200
        case 'cat':        return 'rgba(253,164,175,0.9)';  // rose-300
        case 'dog':        return 'rgba(251,113,133,0.9)';  // rose-400
        case 'horse':      return 'rgba(194,65,12,0.9)';    // orange-800
        case 'sheep':      return 'rgba(243,244,246,0.9)';  // gray-100
        case 'cow':        return 'rgba(120,53,15,0.9)';    // amber-900
        case 'elephant':   return 'rgba(107,114,128,0.9)';  // gray-500
        case 'bear':       return 'rgba(92,51,23,0.9)';     // brown-ish
        case 'zebra':      return 'rgba(17,24,39,0.9)';     // gray-900
        case 'giraffe':    return 'rgba(217,119,6,0.9)';    // amber-600
        // Outdoor / Infrastructure — blue/green civic tones
        case 'bench':         return 'rgba(52,211,153,0.9)';   // emerald-400
        case 'traffic light': return 'rgba(250,204,21,0.9)';   // yellow-400
        case 'fire hydrant':  return 'rgba(239,68,68,0.9)';    // red-500
        case 'stop sign':     return 'rgba(185,28,28,0.9)';    // red-700
        case 'parking meter': return 'rgba(75,85,99,0.9)';     // gray-600
        case 'airplane':      return 'rgba(99,102,241,0.9)';   // indigo-500
        case 'boat':          return 'rgba(59,130,246,0.9)';   // blue-500
        case 'train':         return 'rgba(16,185,129,0.9)';   // emerald-500
        // Food / Kitchen — warm orange/yellow tones
        case 'bowl':      return 'rgba(251,191,36,0.9)';   // amber-400
        case 'wine glass': return 'rgba(196,181,253,0.9)'; // violet-300
        case 'banana':    return 'rgba(253,224,71,0.9)';   // yellow-300
        case 'apple':     return 'rgba(220,38,38,0.9)';    // red-600
        case 'sandwich':  return 'rgba(234,179,8,0.9)';    // yellow-500
        case 'orange':    return 'rgba(249,115,22,0.9)';   // orange-500
        case 'broccoli':  return 'rgba(21,128,61,0.9)';    // green-700
        case 'carrot':    return 'rgba(234,88,12,0.9)';    // orange-700
        case 'hot dog':   return 'rgba(202,138,4,0.9)';    // yellow-600
        case 'pizza':     return 'rgba(251,146,60,0.9)';   // orange-400
        case 'donut':     return 'rgba(244,114,182,0.9)';  // pink-400
        case 'cake':      return 'rgba(251,207,232,0.9)';  // pink-200
        // Home Appliances — cool neutral tones
        case 'toilet':       return 'rgba(226,232,240,0.9)';  // slate-200
        case 'sink':         return 'rgba(148,163,184,0.9)';  // slate-400
        case 'microwave':    return 'rgba(71,85,105,0.9)';    // slate-600
        case 'oven':         return 'rgba(51,65,85,0.9)';     // slate-700
        case 'toaster':      return 'rgba(100,116,139,0.9)';  // slate-500
        case 'refrigerator': return 'rgba(186,230,253,0.9)';  // sky-200
        case 'potted plant': return 'rgba(134,239,172,0.9)';  // green-300
        case 'teddy bear':   return 'rgba(253,186,116,0.9)';  // orange-300
        case 'hair drier':   return 'rgba(253,164,175,0.9)';  // rose-300
        case 'toothbrush':   return 'rgba(167,243,208,0.9)';  // emerald-200
        default:             return 'rgba(156,163,175,0.9)';  // gray
      }
    })();

    const isFace  = className === 'face';

    // Fire/smoke: filled background; face: thin solid; others: standard
    if (isFire) {
      ctx.fillStyle = 'rgba(255,80,0,0.18)';
      ctx.fillRect(x, y, w, h);
    } else if (isSmoke) {
      ctx.fillStyle = 'rgba(100,116,139,0.15)';
      ctx.fillRect(x, y, w, h);
    } else if (isFace) {
      ctx.fillStyle = 'rgba(147,197,253,0.08)';
      ctx.fillRect(x, y, w, h);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth   = isFire || isSmoke ? 3 : isFace ? 1.5 : 2;
    if (isFace) {
      ctx.setLineDash([4, 3]);
    }
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // Label: "face [F3]  87%" or "person #3f8c7a  94%"
    // Show first 6 chars of UUID so the label fits inside the bbox header.
    const clsLabel = (className || 'obj').slice(0, 10);
    const shortId  = typeof objectId === 'string' ? objectId.slice(0, 6) : String(objectId);
    const faceTag  = className === 'face' && det.faceId ? ` [${det.faceId}]` : ` #${shortId}`;
    const label = `${clsLabel}${faceTag}  ${(confidence * 100).toFixed(0)}%`;
    ctx.font = 'bold 12px monospace';
    const textW = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x, y - 20, textW, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, x + 4, y - 6);

    if (isLoitering || dwellTime > 5) {
      const dt = `${dwellTime.toFixed(1)}s`;
      ctx.font = 'bold 10px monospace';
      const dw = ctx.measureText(dt).width + 8;
      ctx.fillStyle = isLoitering ? 'rgba(239,68,68,0.85)' : 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + w - dw, y + h, dw, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(dt, x + w - dw + 4, y + h + 11);
    }

    // ── Attribute badges (mask / hat) — inside bbox, top-left ────────────
    if (det.mask || det.hat) {
      ctx.font = 'bold 9px monospace';
      let bx = x + 2;
      const by = y + 2;
      if (det.mask) {
        const txt = det.mask.status === 'mask_correct' ? 'MASK OK'  :
                    det.mask.status === 'no_mask'       ? 'NO MASK'  :
                    det.mask.status === 'uncertain'     ? 'MASK?'    : 'MASK?';
        // green = wearing; red = not wearing; gray = uncertain (model running, no result)
        const bg  = det.mask.status === 'mask_correct' ? 'rgba(34,197,94,0.85)'  :
                    det.mask.status === 'no_mask'       ? 'rgba(239,68,68,0.85)' :
                                                          'rgba(107,114,128,0.85)';
        const bw  = ctx.measureText(txt).width + 6;
        ctx.fillStyle = bg;
        ctx.fillRect(bx, by, bw, 14);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, bx + 3, by + 10);
        bx += bw + 2;
      }
      if (det.hat) {
        const txt = det.hat.isHelmet === true  ? 'HELMET'    :
                    det.hat.isHelmet === false  ? 'NO HELMET' : 'HAT?';
        // blue = compliant hardhat; red = no hardhat; gray = uncertain
        const bg  = det.hat.safetyCompliant === true  ? 'rgba(59,130,246,0.85)'  :
                    det.hat.safetyCompliant === false   ? 'rgba(239,68,68,0.85)'  :
                                                          'rgba(107,114,128,0.85)';
        const bw  = ctx.measureText(txt).width + 6;
        ctx.fillStyle = bg;
        ctx.fillRect(bx, by, bw, 14);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, bx + 3, by + 10);
      }
    }

    // ── Attribute lines stacked below bbox (color, then cloth) ──────────
    ctx.font = 'bold 10px monospace';
    let belowY = y + h;

    if (det.color) {
      const txt = `↑${det.color.upper} ↓${det.color.lower}`;
      const tw2 = ctx.measureText(txt).width + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(x, belowY, tw2, 16);
      ctx.fillStyle = '#d1d5db';
      ctx.fillText(txt, x + 4, belowY + 11);
      belowY += 16;
    }

    if (det.cloth) {
      const cu = det.cloth.upper  !== 'unknown' ? det.cloth.upper  : null;
      const cl = det.cloth.lower  !== 'unknown' ? det.cloth.lower  : null;
      const cs = det.cloth.sleeve !== 'unknown' ? det.cloth.sleeve : null;
      if (cu || cl) {
        const parts = [cu && `↑${cu}`, cl && `↓${cl}`].filter(Boolean) as string[];
        const txt = `cloth ${parts.join(' ')}${cs ? ` [${cs}]` : ''}`;
        const tw3 = ctx.measureText(txt).width + 8;
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(x, belowY, tw3, 16);
        ctx.fillStyle = '#a78bfa'; // violet-400 — distinct from gray color text
        ctx.fillText(txt, x + 4, belowY + 11);
      }
    }

  }
}

export default function CameraView({ cameraId, cameraName }: Props) {
  const cameras        = useCameraStore((s) => s.cameras);
  const camera         = cameras.find((c) => c.id === cameraId);
  // Per-camera webrtcEnabled flag alone gates WebRTC mode.
  // STUN/TURN settings come from useWebRTC hook via webrtcConfigStore.
  const useWebRTCMode  = !!camera?.webrtcEnabled;

  // JPEG path (always active for AI detections; frame only used when not WebRTC)
  const { frame, detections, frameWidth, frameHeight } = useCamera(cameraId);
  // WebRTC path (active only when webrtcEnabled + global WebRTC enabled)
  const { videoRef, state: webrtcState, hasAudio, retry: retryWebRTC, iceStats } = useWebRTC(cameraId, useWebRTCMode);

  const imgRef    = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [isMuted,      setIsMuted]      = useState(true);
  const [showIcePanel, setShowIcePanel] = useState(false);

  // React's `muted` prop only sets defaultMuted — cannot be toggled via props.
  // Control the live `muted` DOM property directly whenever isMuted or connection state changes.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = isMuted;
  }, [isMuted, videoRef, webrtcState]);
  const status    = camera?.status ?? 'idle';
  const { t }     = useI18n();

  const [zones,      setZones]      = useState<Zone[]>([]);
  const [editZones,  setEditZones]  = useState(false);
  const [zonesLoaded, setZonesLoaded] = useState(false);

  // Load zones on mount / when editing is opened
  const loadZones = useCallback(() => {
    fetch(`/api/cameras/${cameraId}/zones`)
      .then(r => r.json())
      .then(d => { if (d.success) setZones(d.data); })
      .catch(() => {})
      .finally(() => setZonesLoaded(true));
  }, [cameraId]);

  useEffect(() => { loadZones(); }, [loadZones]);

  // Redraw overlay whenever detections, zones change.
  // For WebRTC mode, trigger on every detection update (no frame dependency needed).
  const hasVideo = useWebRTCMode ? webrtcState === 'connected' : !!frame;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasVideo) return;
    const raf = requestAnimationFrame(() => {
      drawOverlay(canvas, detections, zones, frameWidth, frameHeight);
    });
    return () => cancelAnimationFrame(raf);
  }, [detections, zones, hasVideo, frameWidth, frameHeight]);

  const statusColor =
    status === 'live' || status === 'streaming' ? 'bg-green-500' :
    status === 'error'                          ? 'bg-red-500'   :
    status === 'offline'                        ? 'bg-gray-500'  : 'bg-yellow-500';

  const statusLabel =
    status === 'live' || status === 'streaming' ? t.statusLive  :
    status === 'connecting'                     ? t.statusConn  :
    status === 'reconnecting'                   ? t.statusRetry :
    status === 'error'                          ? t.statusErr   :
    status === 'offline'                        ? t.statusOff   : t.statusIdle;

  return (
    <div className="relative w-full h-full bg-gray-900 overflow-hidden rounded-lg">
      {useWebRTCMode ? (
        /* ── WebRTC path: native <video> element ── */
        <>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-contain"
            style={{ display: webrtcState === 'connected' ? 'block' : 'none' }}
          />
          {webrtcState !== 'connected' && (
            <div className="flex flex-col items-center justify-center w-full h-full min-h-[120px] gap-2">
              <div className={`w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center ${webrtcState === 'connecting' ? 'animate-pulse' : ''}`}>
                <svg xmlns="http://www.w3.org/2000/svg" className={`w-5 h-5 ${webrtcState === 'failed' ? 'text-red-400' : 'text-blue-400'}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                </svg>
              </div>
              {webrtcState === 'failed' ? (
                <>
                  <span className="text-xs text-red-400 font-semibold">WebRTC connection failed</span>
                  <span className="text-[10px] text-gray-500 text-center px-4">
                    Check SERVER_IP env var on the server<br/>(server/.env → SERVER_IP=&lt;server-ip&gt;)
                  </span>
                  <button
                    onClick={retryWebRTC}
                    className="mt-1 px-3 py-1 text-[11px] rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                  >
                    Reconnect
                  </button>
                </>
              ) : (
                <span className="text-xs text-gray-500">WebRTC connecting…</span>
              )}
            </div>
          )}
          {webrtcState === 'connected' && (
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 w-full h-full pointer-events-none"
            />
          )}
          {/* Audio mute/unmute button — only when connected and audio track exists */}
          {webrtcState === 'connected' && hasAudio && (
            <button
              onClick={() => setIsMuted((m) => !m)}
              title={isMuted ? 'Unmute audio' : 'Mute audio'}
              className="absolute bottom-2 left-2 z-10 flex items-center justify-center w-7 h-7 rounded-full bg-black/50 hover:bg-black/75 text-white transition-colors"
            >
              {isMuted
                ? <VolumeX className="w-4 h-4" />
                : <Volume2 className="w-4 h-4 text-blue-300" />}
            </button>
          )}
          {/* WebRTC badge + ICE toggle */}
          <div className="absolute top-2 right-12 flex items-center gap-1">
            <div className="bg-blue-900/70 rounded px-1.5 py-0.5 text-[9px] font-bold text-blue-300">
              WebRTC
            </div>
            {webrtcState === 'connected' && (
              <button
                onClick={() => setShowIcePanel((v) => !v)}
                title="ICE candidate info"
                className={`rounded px-1.5 py-0.5 text-[9px] font-bold transition-colors ${
                  showIcePanel
                    ? 'bg-cyan-600/80 text-white'
                    : 'bg-gray-700/70 text-gray-400 hover:text-cyan-300'
                }`}
              >
                ICE
              </button>
            )}
          </div>

          {/* ICE debug panel */}
          {showIcePanel && webrtcState === 'connected' && (
            <div className="absolute top-9 right-2 bg-black/85 rounded-lg p-2 text-[10px] font-mono text-gray-200 z-20 min-w-[200px] leading-5 border border-gray-700/60">
              {iceStats ? (() => {
                const typeColor = (t: string) =>
                  t === 'relay'  ? 'text-orange-400' :
                  t === 'srflx'  ? 'text-yellow-400' : 'text-green-400';
                const typeLabel = (t: string) =>
                  t === 'relay'  ? 'TURN relay' :
                  t === 'srflx'  ? 'STUN mapped' :
                  t === 'host'   ? 'host (LAN)' : t;
                const fmtBytes = (b: number) =>
                  b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` :
                  b >= 1024      ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
                return (
                  <>
                    <div className="text-gray-500 mb-0.5">─ local</div>
                    <div>
                      <span className={typeColor(iceStats.localType)}>[{iceStats.localType}]</span>
                      {' '}{iceStats.localProtocol.toUpperCase()}{' '}
                      {iceStats.localAddress}:{iceStats.localPort}
                    </div>
                    <div className="text-gray-500 text-[9px]">{typeLabel(iceStats.localType)}</div>
                    <div className="text-gray-500 mt-0.5 mb-0.5">─ remote</div>
                    <div>
                      <span className={typeColor(iceStats.remoteType)}>[{iceStats.remoteType}]</span>
                      {' '}{iceStats.remoteAddress}:{iceStats.remotePort}
                    </div>
                    <div className="text-gray-500 text-[9px] mt-0.5 border-t border-gray-700/60 pt-0.5">
                      ↑ {fmtBytes(iceStats.bytesSent)} &nbsp; ↓ {fmtBytes(iceStats.bytesReceived)}
                    </div>
                  </>
                );
              })() : (
                <span className="text-gray-500">Collecting stats…</span>
              )}
            </div>
          )}
        </>
      ) : frame ? (
        /* ── JPEG path: existing <img> element ── */
        <>
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt={cameraName}
            className="w-full h-full object-contain"
            draggable={false}
          />
          <canvas
            ref={canvasRef}
            className="absolute top-0 left-0 w-full h-full pointer-events-none"
          />
        </>
      ) : (
        <div className="flex flex-col items-center justify-center w-full h-full min-h-[120px] gap-2">
          <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6 text-gray-500"
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M15 10l4.553-2.069A1 1 0 0121 8.882v6.236a1 1 0 01-1.447.894L15 14M4 8h8a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2z"
              />
            </svg>
          </div>
          <span className="text-xs text-gray-500">{t.noSignal}</span>
        </div>
      )}

      {/* Zone Editor — full-screen modal (fixed inset-0) */}
      {editZones && zonesLoaded && (
        <ZoneEditor
          cameraId={cameraId}
          frame={frame}
          frameWidth={frameWidth}
          frameHeight={frameHeight}
          zones={zones}
          onZoneAdded={(z)  => setZones(prev => [...prev, z])}
          onZoneUpdated={(z) => setZones(prev => prev.map(x => x.id === z.id ? z : x))}
          onZoneDeleted={(id) => setZones(prev => prev.filter(z => z.id !== id))}
          onClose={() => setEditZones(false)}
        />
      )}

      {/* Status badge (top-left) */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 rounded px-2 py-1">
        <span className={`w-2 h-2 rounded-full ${statusColor} flex-shrink-0`} />
        <span className="text-xs font-semibold text-white truncate max-w-[100px]">{cameraName}</span>
        <span className={`text-[10px] font-bold ${statusColor.replace('bg-', 'text-')} ml-1`}>{statusLabel}</span>
      </div>

      {/* Zone edit button (top-right) */}
      {!editZones && (
        <button
          onClick={() => setEditZones(true)}
          className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 rounded px-2 py-1 text-[10px] text-gray-300 hover:text-white transition-colors"
          title={t.zoneEdit}
        >
          {zones.length > 0 ? `Zone ${zones.length}` : t.zoneAdd}
        </button>
      )}

      {/* Detection count (bottom-right) */}
      {detections.length > 0 && !editZones && (
        <div className="absolute bottom-2 right-2 bg-black/60 rounded px-2 py-1">
          <span className="text-xs text-white">
            {t.objCount(detections.length)}
            {detections.filter(d => d.isLoitering).length > 0 && (
              <span className="text-red-400 ml-1">
                ({t.loiterCount(detections.filter(d => d.isLoitering).length)})
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
