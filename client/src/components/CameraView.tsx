import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera } from '../hooks/useCamera';
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

    // Label: "person #3  94%" or "car #7  82%"
    const clsLabel = (className || 'obj').slice(0, 10);
    const label = `${clsLabel} #${objectId}  ${(confidence * 100).toFixed(0)}%`;
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
        const txt = det.mask.status === 'mask_correct' ? 'MASK OK' :
                    det.mask.status === 'no_mask'       ? 'NO MASK' : 'MASK?';
        const bg  = det.mask.status === 'mask_correct' ? 'rgba(34,197,94,0.85)' :
                    det.mask.status === 'no_mask'       ? 'rgba(239,68,68,0.85)' :
                                                          'rgba(234,179,8,0.85)';
        const bw  = ctx.measureText(txt).width + 6;
        ctx.fillStyle = bg;
        ctx.fillRect(bx, by, bw, 14);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, bx + 3, by + 10);
        bx += bw + 2;
      }
      if (det.hat) {
        const txt = det.hat.isHelmet ? 'HELMET' : 'HAT';
        const bg  = det.hat.isHelmet ? 'rgba(59,130,246,0.85)' : 'rgba(107,114,128,0.85)';
        const bw  = ctx.measureText(txt).width + 6;
        ctx.fillStyle = bg;
        ctx.fillRect(bx, by, bw, 14);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, bx + 3, by + 10);
      }
    }

    // ── Color info — inside bbox, bottom-left ────────────────────────────
    if (det.color) {
      const txt = `↑${det.color.upper} ↓${det.color.lower}`;
      ctx.font = '9px monospace';
      const tw2 = ctx.measureText(txt).width + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(x, y + h - 15, tw2, 13);
      ctx.fillStyle = '#d1d5db';
      ctx.fillText(txt, x + 3, y + h - 5);
    }

  }
}

export default function CameraView({ cameraId, cameraName }: Props) {
  const { frame, detections, frameWidth, frameHeight } = useCamera(cameraId);
  const imgRef    = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameras   = useCameraStore((s) => s.cameras);
  const camera    = cameras.find((c) => c.id === cameraId);
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

  // Redraw overlay whenever detections, zones, or frame changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    // Use rAF so layout is settled and clientWidth/Height are non-zero
    const raf = requestAnimationFrame(() => {
      drawOverlay(canvas, detections, zones, frameWidth, frameHeight);
    });
    return () => cancelAnimationFrame(raf);
  }, [detections, zones, frame, frameWidth, frameHeight]);

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
      {frame ? (
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
