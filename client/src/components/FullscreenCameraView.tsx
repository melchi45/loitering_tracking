import { useEffect, useRef } from 'react';
import { useCamera } from '../hooks/useCamera';
import CameraView from './CameraView';
import type { Detection } from '../types';

interface Props {
  cameraId: string;
  cameraName: string;
  onClose: () => void;
}

const MASK_LABEL: Record<string, string> = {
  mask_correct:   'MASK OK',
  mask_incorrect: 'MASK BAD',
  no_mask:        'NO MASK',
};
const MASK_COLOR: Record<string, string> = {
  mask_correct:   'bg-green-700 text-green-100',
  mask_incorrect: 'bg-yellow-700 text-yellow-100',
  no_mask:        'bg-red-700 text-red-100',
};

function DetectionRow({ det }: { det: Detection }) {
  const { objectId, className, confidence, dwellTime, isLoitering, bbox, face, mask, hat, color } = det;

  const clsColor =
    isLoitering              ? 'text-red-400'    :
    className === 'person'   ? 'text-green-400'  :
    className === 'bicycle'  ? 'text-yellow-400' :
    className === 'car'      ? 'text-blue-400'   :
    className === 'motorcycle' ? 'text-orange-400' :
    className === 'bus'      ? 'text-purple-400' :
    className === 'truck'    ? 'text-teal-400'   :
    className === 'backpack' || className === 'handbag' || className === 'suitcase'
                             ? 'text-amber-400'  : 'text-gray-400';

  return (
    <div className={`px-3 py-2 border-b border-gray-700/60 ${isLoitering ? 'bg-red-900/20' : ''}`}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-bold uppercase ${clsColor}`}>{className || 'obj'}</span>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {isLoitering && (
            <span className="text-[9px] font-bold bg-red-600 text-white rounded px-1 py-0.5 uppercase">
              LOITER
            </span>
          )}
          {mask && (
            <span className={`text-[9px] font-bold rounded px-1 py-0.5 uppercase ${MASK_COLOR[mask.status] ?? 'bg-gray-600 text-white'}`}>
              {MASK_LABEL[mask.status] ?? mask.status}
            </span>
          )}
          {hat && (
            <span className={`text-[9px] font-bold rounded px-1 py-0.5 uppercase ${hat.isHelmet ? 'bg-blue-700 text-blue-100' : 'bg-gray-600 text-gray-200'}`}>
              {hat.isHelmet ? 'HELMET' : 'HAT'}
            </span>
          )}
          <span className="text-[10px] text-gray-400 font-mono">#{String(objectId).slice(0, 8)}</span>
        </div>
      </div>

      {/* Core metrics */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-gray-400 font-mono">
        <span>conf  <span className="text-gray-200">{(confidence * 100).toFixed(0)}%</span></span>
        <span>dwell <span className={dwellTime > 5 ? 'text-yellow-300' : 'text-gray-200'}>{dwellTime.toFixed(1)}s</span></span>
        <span>x <span className="text-gray-200">{bbox.x.toFixed(0)}</span></span>
        <span>y <span className="text-gray-200">{bbox.y.toFixed(0)}</span></span>
        <span>w <span className="text-gray-200">{bbox.width.toFixed(0)}</span></span>
        <span>h <span className="text-gray-200">{bbox.height.toFixed(0)}</span></span>
      </div>

      {/* Color attributes */}
      {color && (
        <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 font-mono">
          <span>upper</span>
          <span className="text-gray-200 font-semibold">{color.upper}</span>
          <span className="text-gray-600">|</span>
          <span>lower</span>
          <span className="text-gray-200 font-semibold">{color.lower}</span>
        </div>
      )}

      {/* Face detection indicator */}
      {face && (
        <div className="mt-0.5 text-[10px] text-blue-400 font-mono">
          face {(face.score * 100).toFixed(0)}%
          {face.identity && <span className="ml-1 text-blue-300">{face.identity}</span>}
        </div>
      )}
    </div>
  );
}

function DetectionPanel({ cameraId }: { cameraId: string }) {
  const { detections } = useCamera(cameraId);
  const listRef = useRef<HTMLDivElement>(null);

  const sorted = [...detections].sort((a, b) => {
    if (a.isLoitering !== b.isLoitering) return a.isLoitering ? -1 : 1;
    return b.dwellTime - a.dwellTime;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <span className="text-xs font-bold text-gray-200 uppercase tracking-wide">Detections</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">
            {detections.length} obj
          </span>
          {detections.filter(d => d.isLoitering).length > 0 && (
            <span className="text-[10px] font-bold text-red-400">
              {detections.filter(d => d.isLoitering).length} loiter
            </span>
          )}
        </div>
      </div>

      {/* Detection list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <span className="text-xs">No detections</span>
          </div>
        ) : (
          sorted.map((det) => (
            <DetectionRow key={det.objectId} det={det} />
          ))
        )}
      </div>

      {/* Legend */}
      <div className="px-3 py-2 border-t border-gray-700 flex-shrink-0">
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
          <span className="text-green-400">■ person</span>
          <span className="text-yellow-400">■ bicycle</span>
          <span className="text-blue-400">■ car</span>
          <span className="text-orange-400">■ motorcycle</span>
          <span className="text-purple-400">■ bus</span>
          <span className="text-teal-400">■ truck</span>
        </div>
      </div>
    </div>
  );
}

export default function FullscreenCameraView({ cameraId, cameraName, onClose }: Props) {
  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/90"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Left detection panel */}
      <div className="w-56 flex-shrink-0 bg-gray-800 border-r border-gray-700 flex flex-col overflow-hidden">
        <DetectionPanel cameraId={cameraId} />
      </div>

      {/* Main video area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-900/80 flex-shrink-0">
          <span className="text-sm font-semibold text-white">{cameraName}</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-gray-700"
            title="Close (Esc)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Video */}
        <div className="flex-1 overflow-hidden p-2">
          <CameraView cameraId={cameraId} cameraName={cameraName} />
        </div>
      </div>
    </div>
  );
}
