import { useEffect, useRef, useState } from 'react';
import { useCamera } from '../hooks/useCamera';
import { useI18n } from '../i18n';
import CameraView from './CameraView';
import VideoAnalyticsTab from './VideoAnalyticsTab';
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
  const { objectId, className, confidence, dwellTime, isLoitering, bbox, face, mask, hat, color,
          riskScore, revisitCount, velocity, circularScore } = det;

  const clsColor =
    isLoitering                ? 'text-red-400'     :
    className === 'person'     ? 'text-green-400'   :
    className === 'bicycle'    ? 'text-yellow-400'  :
    className === 'car'        ? 'text-blue-400'    :
    className === 'motorcycle' ? 'text-orange-400'  :
    className === 'bus'        ? 'text-purple-400'  :
    className === 'truck'      ? 'text-teal-400'    :
    className === 'fire'       ? 'text-orange-500'  :
    className === 'smoke'      ? 'text-slate-400'   :
    className === 'face'       ? 'text-blue-300'    :
    className === 'backpack' || className === 'handbag' || className === 'suitcase'
                               ? 'text-amber-400'   :
    // Indoor / office objects
    className === 'chair'        ? 'text-violet-400'  :
    className === 'couch'        ? 'text-violet-300'  :
    className === 'dining table' ? 'text-emerald-400' :
    className === 'bed'          ? 'text-indigo-400'  :
    className === 'tv'           ? 'text-sky-400'     :
    className === 'laptop'       ? 'text-cyan-400'    :
    className === 'mouse'        ? 'text-amber-300'   :
    className === 'keyboard'     ? 'text-pink-400'    :
    className === 'cell phone'   ? 'text-red-300'     :
    className === 'clock'        ? 'text-emerald-300' :
    className === 'cup'          ? 'text-orange-300'  :
    className === 'bottle'       ? 'text-lime-400'    :
    className === 'book'         ? 'text-violet-200'  :
    className === 'vase'         ? 'text-pink-300'    : 'text-gray-400';

  return (
    <div className={`px-3 py-2 border-b border-gray-700/60 ${
      isLoitering ? 'bg-red-900/20' :
      className === 'fire'  ? 'bg-orange-900/25' :
      className === 'smoke' ? 'bg-slate-800/40'  :
      className === 'face'  ? 'bg-blue-900/15'   : ''
    }`}>
      {/* Header row */}
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-bold uppercase ${clsColor}`}>{className || 'obj'}</span>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {isLoitering && (
            <span className="text-[9px] font-bold bg-red-600 text-white rounded px-1 py-0.5 uppercase">
              LOITER
            </span>
          )}
          {className === 'fire' && (
            <span className="text-[9px] font-bold bg-orange-600 text-white rounded px-1 py-0.5 uppercase animate-pulse">
              FIRE
            </span>
          )}
          {className === 'smoke' && (
            <span className="text-[9px] font-bold bg-slate-600 text-white rounded px-1 py-0.5 uppercase">
              SMOKE
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

      {/* Adaptive multi-feature metrics (zone-matched objects only) */}
      {(riskScore != null || revisitCount != null) && (
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
          {riskScore != null && (
            <span className="text-gray-400">
              risk{' '}
              <span className={
                riskScore >= 0.7 ? 'text-red-400 font-bold' :
                riskScore >= 0.4 ? 'text-yellow-300' : 'text-gray-300'
              }>
                {(riskScore * 100).toFixed(0)}%
              </span>
            </span>
          )}
          {revisitCount != null && revisitCount > 0 && (
            <span className="text-gray-400">
              revisit <span className="text-orange-300">{revisitCount}×</span>
            </span>
          )}
          {velocity != null && (
            <span className="text-gray-400">
              vel <span className={velocity < 20 ? 'text-red-300' : 'text-gray-300'}>{velocity.toFixed(0)}px/s</span>
            </span>
          )}
          {circularScore != null && circularScore > 0.4 && (
            <span className="text-orange-400 font-bold">↻ circular</span>
          )}
        </div>
      )}

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
  const { t } = useI18n();

  const sorted = [...detections].sort((a, b) => {
    if (a.isLoitering !== b.isLoitering) return a.isLoitering ? -1 : 1;
    return b.dwellTime - a.dwellTime;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <span className="text-xs font-bold text-gray-200 uppercase tracking-wide">{t.detections}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">{t.objCount(detections.length)}</span>
          {detections.filter(d => d.isLoitering).length > 0 && (
            <span className="text-[10px] font-bold text-red-400">
              {t.loiterCount(detections.filter(d => d.isLoitering).length)}
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
            <span className="text-xs">{t.noDetections}</span>
          </div>
        ) : (
          sorted.map((det) => (
            <DetectionRow key={det.objectId} det={det} />
          ))
        )}
      </div>

      {/* Legend */}
      <div className="px-3 py-2 border-t border-gray-700 flex-shrink-0 space-y-1.5">
        {/* People & vehicles */}
        <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold">{t.legendPeopleVehicles}</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
          <span className="text-green-400">■ person</span>
          <span className="text-red-400">■ loitering</span>
          <span className="text-blue-300">■ face</span>
          <span className="text-yellow-400">■ bicycle</span>
          <span className="text-blue-400">■ car</span>
          <span className="text-orange-400">■ motorcycle</span>
          <span className="text-purple-400">■ bus</span>
          <span className="text-teal-400">■ truck</span>
          <span className="text-orange-500">■ fire</span>
          <span className="text-slate-400">■ smoke</span>
          <span className="text-amber-400">■ {t.legendBaggage}</span>
        </div>
        <div className="text-[8px] text-gray-600 pl-2">backpack · umbrella · handbag · tie · suitcase</div>
        {/* Indoor / office objects */}
        <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.legendIndoor}</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
          <span className="text-violet-400">■ chair</span>
          <span className="text-violet-300">■ couch</span>
          <span className="text-emerald-400">■ dining table</span>
          <span className="text-indigo-400">■ bed</span>
          <span className="text-sky-400">■ tv</span>
          <span className="text-cyan-400">■ laptop</span>
          <span className="text-pink-400">■ keyboard</span>
          <span className="text-amber-300">■ mouse</span>
          <span className="text-red-300">■ cell phone</span>
          <span className="text-emerald-300">■ clock</span>
          <span className="text-orange-300">■ cup</span>
          <span className="text-lime-400">■ bottle</span>
          <span className="text-violet-200">■ book</span>
          <span className="text-pink-300">■ vase</span>
        </div>
        {/* AI attribute badges */}
        <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.legendAiBadges}</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[8px]">
          <span className="bg-green-700/70 text-green-100 rounded px-1">MASK OK</span>
          <span className="bg-red-700/70 text-red-100 rounded px-1">NO MASK</span>
          <span className="bg-blue-700/70 text-blue-100 rounded px-1">HELMET</span>
          <span className="bg-gray-600/70 text-gray-200 rounded px-1">HAT</span>
          <span className="text-blue-400">⬚ face bbox</span>
          <span className="text-gray-400">↑↓ color</span>
        </div>
      </div>
    </div>
  );
}

export default function FullscreenCameraView({ cameraId, cameraName, onClose }: Props) {
  const [leftTab, setLeftTab] = useState<'detections' | 'analytics'>('detections');
  const { t } = useI18n();

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
      {/* Left panel — Detection / Video Analytics tabs */}
      <div className="w-64 flex-shrink-0 bg-gray-800 border-r border-gray-700 flex flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="flex border-b border-gray-700 flex-shrink-0">
          <button
            onClick={() => setLeftTab('detections')}
            className={`flex-1 py-2 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
              leftTab === 'detections'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.detections}
          </button>
          <button
            onClick={() => setLeftTab('analytics')}
            className={`flex-1 py-2 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
              leftTab === 'analytics'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.tabVideoAnalytics}
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-hidden">
          {leftTab === 'detections' && <DetectionPanel cameraId={cameraId} />}
          {leftTab === 'analytics'  && <VideoAnalyticsTab />}
        </div>
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
