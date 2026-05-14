import { useRef, useEffect } from 'react';
import { useCamera } from '../hooks/useCamera';
import { useCameraStore } from '../stores/cameraStore';
import type { Detection } from '../types';

// Model input dimensions (YOLO default)
const MODEL_WIDTH = 640;
const MODEL_HEIGHT = 640;

interface Props {
  cameraId: string;
  cameraName: string;
}

function drawDetections(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  detections: Detection[]
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const displayW = img.clientWidth;
  const displayH = img.clientHeight;

  canvas.width = displayW;
  canvas.height = displayH;

  ctx.clearRect(0, 0, displayW, displayH);

  const scaleX = displayW / MODEL_WIDTH;
  const scaleY = displayH / MODEL_HEIGHT;

  for (const det of detections) {
    const { bbox, objectId, confidence, isLoitering, dwellTime } = det;

    const x = bbox.x * scaleX;
    const y = bbox.y * scaleY;
    const w = bbox.width * scaleX;
    const h = bbox.height * scaleY;

    const color = isLoitering
      ? 'rgba(239,68,68,0.9)'
      : 'rgba(34,197,94,0.9)';

    // Draw bounding box
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // Label text
    const label = `ID:${objectId}  ${(confidence * 100).toFixed(0)}%`;
    ctx.font = 'bold 12px monospace';
    const textMetrics = ctx.measureText(label);
    const textW = textMetrics.width + 8;
    const textH = 18;

    // Label background
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y - textH - 2, textW, textH + 2);

    // Label text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 4, y - 6);

    // Dwell timer (bottom-right of bbox)
    if (isLoitering || dwellTime > 5) {
      const dwellText = `${dwellTime.toFixed(1)}s`;
      const dwellMetrics = ctx.measureText(dwellText);
      const dwellW = dwellMetrics.width + 8;
      const dwellH = 18;

      ctx.fillStyle = isLoitering ? 'rgba(239,68,68,0.8)' : 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + w - dwellW, y + h, dwellW, dwellH);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(dwellText, x + w - dwellW + 4, y + h + 13);
    }
  }
}

export default function CameraView({ cameraId, cameraName }: Props) {
  const { frame, detections } = useCamera(cameraId);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameras = useCameraStore((s) => s.cameras);
  const camera = cameras.find((c) => c.id === cameraId);
  const status = camera?.status ?? 'idle';

  // Redraw bounding boxes whenever detections or frame changes
  useEffect(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !frame) return;

    if (!img.complete || img.naturalWidth === 0) {
      const onLoad = () => drawDetections(canvas, img, detections);
      img.addEventListener('load', onLoad, { once: true });
      return () => img.removeEventListener('load', onLoad);
    }

    drawDetections(canvas, img, detections);
  }, [detections, frame]);

  const statusColor =
    status === 'live'
      ? 'bg-green-500'
      : status === 'error'
      ? 'bg-red-500'
      : status === 'offline'
      ? 'bg-gray-500'
      : 'bg-yellow-500';

  const statusLabel =
    status === 'live'
      ? 'LIVE'
      : status === 'error'
      ? 'ERR'
      : status === 'offline'
      ? 'OFF'
      : 'IDLE';

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
            style={{ objectFit: 'contain' }}
          />
        </>
      ) : (
        <div className="flex flex-col items-center justify-center w-full h-full min-h-[120px] gap-2">
          <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-6 h-6 text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 10l4.553-2.069A1 1 0 0121 8.882v6.236a1 1 0 01-1.447.894L15 14M4 8h8a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2z"
              />
            </svg>
          </div>
          <span className="text-xs text-gray-500">No signal</span>
        </div>
      )}

      {/* Camera name + status overlay (top-left) */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 rounded px-2 py-1">
        <span className={`w-2 h-2 rounded-full ${statusColor} flex-shrink-0`} />
        <span className="text-xs font-semibold text-white truncate max-w-[120px]">
          {cameraName}
        </span>
        <span className={`text-[10px] font-bold ${statusColor.replace('bg-', 'text-')} ml-1`}>
          {statusLabel}
        </span>
      </div>

      {/* Detection count badge (top-right) */}
      {detections.length > 0 && (
        <div className="absolute top-2 right-2 bg-black/60 rounded px-2 py-1">
          <span className="text-xs text-white">
            {detections.length} obj
            {detections.filter((d) => d.isLoitering).length > 0 && (
              <span className="text-red-400 ml-1">
                ({detections.filter((d) => d.isLoitering).length} loiter)
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
