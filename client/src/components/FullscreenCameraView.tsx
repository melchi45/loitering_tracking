import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera } from '../hooks/useCamera';
import { useCrossCameraStore } from '../stores/crossCameraStore';
import { useClothingReIdStore } from '../stores/clothingReIdStore';
import { useCameraStore } from '../stores/cameraStore';
import { usePersonTrajectoryStore } from '../stores/personTrajectoryStore';
import { useDataChannelStore } from '../stores/dataChannelStore';
import type { AppRtpMessage } from '../stores/dataChannelStore';
import { useI18n } from '../i18n';
import CameraView from './CameraView';
import OnvifTimelineInline from './OnvifTimelineInline';
import DetectionsTimelineInline from './DetectionsTimelineInline';
import type { Detection, ClothingFeature } from '../types';

interface Props {
  cameraId: string;
  cameraName: string;
  onClose: () => void;
  initialVideoTab?: 'events' | 'onvif' | 'detections';
  initialFocusMatch?: { faceId: string; timestamp: number };
}

const MASK_LABEL: Record<string, string> = {
  mask_correct:   'MASK OK',
  mask_incorrect: 'MASK BAD',
  no_mask:        'NO MASK',
  uncertain:      'MASK?',
};
const MASK_COLOR: Record<string, string> = {
  mask_correct:   'bg-green-700 text-green-100',
  mask_incorrect: 'bg-yellow-700 text-yellow-100',
  no_mask:        'bg-red-700 text-red-100',
  uncertain:      'bg-gray-600 text-gray-200',
};

export function DetectionRow({ det, isCrossCamera }: { det: Detection; isCrossCamera?: boolean }) {
  const { objectId, className, confidence, dwellTime, isLoitering, bbox, face, mask, hat, color, cloth,
          faceId, matchScore, estimatedAge, estimatedGender,
          riskScore, revisitCount, velocity, circularScore } = det;

  // Look up canonical alias from the global person registry
  const personAlias = usePersonTrajectoryStore((s) => {
    const key = faceId ?? (face as { faceId?: string } | undefined)?.faceId;
    return key ? s.persons.get(key)?.alias ?? null : null;
  });

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
    className === 'backpack' || className === 'handbag' || className === 'suitcase' ||
    className === 'umbrella' || className === 'tie'
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
    className === 'vase'         ? 'text-pink-300'    :
    // Accessories — sports equipment
    className === 'sports ball'    ? 'text-orange-400'  :
    className === 'frisbee'        ? 'text-orange-300'  :
    className === 'skis'           ? 'text-sky-500'     :
    className === 'snowboard'      ? 'text-sky-400'     :
    className === 'baseball bat'   ? 'text-yellow-500'  :
    className === 'baseball glove' ? 'text-yellow-600'  :
    className === 'skateboard'     ? 'text-orange-500'  :
    className === 'surfboard'      ? 'text-cyan-500'    :
    className === 'tennis racket'  ? 'text-lime-400'    :
    className === 'kite'           ? 'text-violet-400'  :
    className === 'scissors'       ? 'text-slate-400'   :
    className === 'fork'           ? 'text-gray-300'    :
    className === 'knife'          ? 'text-gray-400'    :
    className === 'spoon'          ? 'text-gray-200'    :
    // Animals — warm tones
    className === 'bird'       ? 'text-pink-200'    :
    className === 'cat'        ? 'text-rose-300'    :
    className === 'dog'        ? 'text-rose-400'    :
    className === 'horse'      ? 'text-orange-800'  :
    className === 'sheep'      ? 'text-gray-100'    :
    className === 'cow'        ? 'text-amber-900'   :
    className === 'elephant'   ? 'text-gray-500'    :
    className === 'bear'       ? 'text-amber-800'   :
    className === 'zebra'      ? 'text-gray-100'    :
    className === 'giraffe'    ? 'text-amber-600'   :
    // Outdoor / Infrastructure — civic tones
    className === 'bench'         ? 'text-emerald-400' :
    className === 'traffic light' ? 'text-yellow-400'  :
    className === 'fire hydrant'  ? 'text-red-500'     :
    className === 'stop sign'     ? 'text-red-700'     :
    className === 'parking meter' ? 'text-gray-600'    :
    className === 'airplane'      ? 'text-indigo-400'  :
    className === 'boat'          ? 'text-blue-400'    :
    className === 'train'         ? 'text-emerald-500' :
    // Food / Kitchen — warm tones
    className === 'bowl'       ? 'text-amber-400'   :
    className === 'wine glass' ? 'text-violet-300'  :
    className === 'banana'     ? 'text-yellow-300'  :
    className === 'apple'      ? 'text-red-500'     :
    className === 'sandwich'   ? 'text-yellow-500'  :
    className === 'orange'     ? 'text-orange-500'  :
    className === 'broccoli'   ? 'text-green-600'   :
    className === 'carrot'     ? 'text-orange-600'  :
    className === 'hot dog'    ? 'text-yellow-600'  :
    className === 'pizza'      ? 'text-orange-400'  :
    className === 'donut'      ? 'text-pink-400'    :
    className === 'cake'       ? 'text-pink-200'    :
    // Home Appliances — cool neutral tones
    className === 'bed'          ? 'text-indigo-400' :
    className === 'toilet'       ? 'text-slate-200'  :
    className === 'sink'         ? 'text-slate-400'  :
    className === 'microwave'    ? 'text-slate-500'  :
    className === 'oven'         ? 'text-slate-600'  :
    className === 'toaster'      ? 'text-slate-400'  :
    className === 'refrigerator' ? 'text-sky-200'    :
    className === 'potted plant' ? 'text-green-300'  :
    className === 'teddy bear'   ? 'text-orange-200' :
    className === 'hair drier'   ? 'text-rose-300'   :
    className === 'toothbrush'   ? 'text-emerald-200': 'text-gray-400';

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
            <span className={`text-[9px] font-bold rounded px-1 py-0.5 uppercase ${
              hat.safetyCompliant === true  ? 'bg-blue-700 text-blue-100'  :
              hat.safetyCompliant === false  ? 'bg-red-700 text-red-100'   :
                                              'bg-gray-600 text-gray-200'
            }`}>
              {hat.isHelmet === true  ? 'HELMET'    :
               hat.isHelmet === false ? 'NO HELMET' : 'HAT?'}
            </span>
          )}
          <span className="text-[10px] text-gray-400 font-mono">#{String(objectId).slice(0, 8)}</span>
        </div>
      </div>

      {/* Core metrics */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-gray-400 font-mono">
        <span>conf  <span className="text-gray-200">{((confidence ?? 0) * 100).toFixed(0)}%</span></span>
        <span>dwell <span className={(dwellTime ?? 0) > 5 ? 'text-yellow-300' : 'text-gray-200'}>{(dwellTime ?? 0).toFixed(1)}s</span></span>
        <span>x <span className="text-gray-200">{(bbox?.x ?? 0).toFixed(0)}</span></span>
        <span>y <span className="text-gray-200">{(bbox?.y ?? 0).toFixed(0)}</span></span>
        <span>w <span className="text-gray-200">{(bbox?.width ?? 0).toFixed(0)}</span></span>
        <span>h <span className="text-gray-200">{(bbox?.height ?? 0).toFixed(0)}</span></span>
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

      {/* Dedicated Age Estimation (InsightFace/ViT Age Classifier) — distinct from
          the coarse 3-bucket "attrs" ageGroup below (PromptPAR/PA100k attribute). */}
      {estimatedAge?.value != null && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] font-mono">
          <span className="text-teal-500">age</span>
          <span className="text-teal-300 font-semibold">~{Math.round(estimatedAge.value)}</span>
          {estimatedAge.bucket && <span className="text-teal-600">({estimatedAge.bucket})</span>}
        </div>
      )}

      {/* Dedicated Gender Classification (InsightFace/ViT Gender Classifier) — distinct
          from the "attrs" gender below (PromptPAR/PA100k byproduct attribute). */}
      {estimatedGender?.value != null && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] font-mono">
          <span className="text-fuchsia-500">gender</span>
          <span className="text-fuchsia-300 font-semibold">{estimatedGender.value}</span>
          <span className="text-fuchsia-600">({Math.round(estimatedGender.confidence * 100)}%)</span>
        </div>
      )}

      {/* Pedestrian attributes (PromptPAR / PA100k, 26 attributes) */}
      {cloth && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
          <span className="text-violet-500">attrs</span>
          {cloth.gender && <span className="text-violet-300">{cloth.gender}</span>}
          {cloth.ageGroup && <span className="text-violet-300">{cloth.ageGroup}</span>}
          {cloth.viewAngle && <span className="text-violet-300">{cloth.viewAngle}</span>}
          {cloth.lower && <span className="text-violet-300">↓{cloth.lower}</span>}
          {cloth.sleeve && <span className="text-violet-600">[{cloth.sleeve} sleeve]</span>}
          {cloth.hat && <span className="text-violet-600">hat</span>}
          {cloth.glasses && <span className="text-violet-600">glasses</span>}
          {cloth.handBag && <span className="text-violet-600">hand bag</span>}
          {cloth.shoulderBag && <span className="text-violet-600">shoulder bag</span>}
          {cloth.backpack && <span className="text-violet-600">backpack</span>}
          {cloth.longCoat && <span className="text-violet-600">long coat</span>}
          {cloth.boots && <span className="text-violet-600">boots</span>}
        </div>
      )}

      {/* Face recognition info — on person objects (face attribute) */}
      {face && (
        <div className="mt-0.5 text-[10px] text-blue-400 font-mono flex items-center gap-1.5 flex-wrap">
          face {((face.score ?? 0) * 100).toFixed(0)}%
          {face.faceId && <span className="text-blue-300 font-bold">[{face.faceId}]</span>}
          {personAlias && <span className="text-[8px] font-bold bg-teal-700/70 text-teal-100 rounded px-1 py-0.5">{personAlias}</span>}
          {face.identity && <span className="text-blue-200">{face.identity}</span>}
        </div>
      )}

      {/* Face recognition info — on standalone face detection objects */}
      {className === 'face' && faceId && (
        <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
          <span className="text-blue-300 font-bold">[{faceId}]</span>
          {personAlias && <span className="text-[8px] font-bold bg-teal-700/70 text-teal-100 rounded px-1 py-0.5">{personAlias}</span>}
          {matchScore != null && (
            <span className="text-gray-500">
              sim <span className={matchScore >= 0.6 ? 'text-green-400' : matchScore >= 0.4 ? 'text-yellow-400' : 'text-gray-400'}>
                {(matchScore * 100).toFixed(0)}%
              </span>
            </span>
          )}
          {isCrossCamera && (
            <span className="text-[8px] font-bold bg-blue-700/70 text-blue-100 rounded px-1 py-0.5 uppercase">
              &#8596; CROSS-CAM
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Class-category filter definitions ──────────────────────────────────────
export const CATEGORIES = [
  { key: 'people',    label: 'People',   color: 'text-green-400',   classes: new Set(['person', 'face']) },
  { key: 'vehicle',   label: 'Vehicle',  color: 'text-blue-400',    classes: new Set(['bicycle','car','motorcycle','bus','truck']) },
  { key: 'hazard',    label: 'Hazard',   color: 'text-orange-500',  classes: new Set(['fire','smoke']) },
  { key: 'accessory', label: 'Acc',      color: 'text-amber-400',   classes: new Set([
      'backpack','handbag','suitcase','umbrella','tie',
      'sports ball','frisbee','skis','snowboard','baseball bat','baseball glove',
      'skateboard','surfboard','tennis racket','kite','scissors','fork','knife','spoon','remote',
    ]) },
  { key: 'indoor',    label: 'Indoor',   color: 'text-violet-400',  classes: new Set([
      'chair','couch','dining table','bed','tv','laptop','mouse','keyboard','cell phone',
      'clock','cup','bottle','book','vase','microwave','oven','toaster','sink','refrigerator',
      'toilet','toothbrush','hair drier','teddy bear','potted plant',
    ]) },
  { key: 'animal',    label: 'Animal',   color: 'text-pink-300',    classes: new Set(['bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe']) },
  { key: 'outdoor',   label: 'Outdoor',  color: 'text-emerald-400', classes: new Set(['bench','traffic light','fire hydrant','stop sign','parking meter','airplane','boat','train']) },
  { key: 'food',      label: 'Food',     color: 'text-yellow-400',  classes: new Set(['bowl','wine glass','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake']) },
] as const;

type CategoryKey = typeof CATEGORIES[number]['key'];

export function getCategoryKey(className: string): CategoryKey | 'other' {
  for (const cat of CATEGORIES) {
    if ((cat.classes as Set<string>).has(className)) return cat.key;
  }
  return 'other';
}

/** Small colour swatch for clothing RGB display */
function RgbSwatch({ rgb }: { rgb: [number, number, number] | null | undefined }) {
  if (!rgb) return null;
  const hex = `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`;
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-sm border border-gray-600 flex-shrink-0"
      style={{ backgroundColor: hex }}
      title={hex}
    />
  );
}

/** Format clothing feature as a short label */
function clothingLabel(f: ClothingFeature): string {
  const parts: string[] = [];
  if (f.upper && f.upper !== 'unknown') parts.push(f.upper);
  if (f.lower && f.lower !== 'unknown') parts.push(f.lower);
  return parts.length > 0 ? parts.join('/') : 'colour match';
}

export function DetectionPanel({ cameraId }: { cameraId: string }) {
  const { detections } = useCamera(cameraId);
  const crossCameraEvents  = useCrossCameraStore((s) => s.events);
  const clothingReIdEvents = useClothingReIdStore((s) => s.events);
  const allPersons = usePersonTrajectoryStore((s) => s.persons);
  const cameras = useCameraStore((s) => s.cameras);
  const listRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const [showLegend, setShowLegend] = useState(false);
  const [showCrossCamera, setShowCrossCamera] = useState(true);
  const [showAppearance, setShowAppearance] = useState(true);
  const [showPersonTrails, setShowPersonTrails] = useState(true);
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set());

  // Resolve camera ID to display name (falls back to first 8 chars of ID)
  const camName = (id: string) =>
    cameras.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  const toggleCat = (key: string) =>
    setHiddenCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const sorted = [...detections].sort((a, b) => {
    if (a.isLoitering !== b.isLoitering) return a.isLoitering ? -1 : 1;
    return b.dwellTime - a.dwellTime;
  });

  const filtered = hiddenCats.size === 0
    ? sorted
    : sorted.filter((d) => !hiddenCats.has(getCategoryKey(d.className ?? '')));

  // Set of faceIds that appeared in a cross-camera event involving this camera
  const crossCamFaceIds = new Set(
    crossCameraEvents
      .filter((ev) => ev.prevCameraId === cameraId || ev.newCameraId === cameraId)
      .map((ev) => ev.faceId)
  );

  // Recent cross-camera face events where this camera is involved
  const localEvents = crossCameraEvents.filter(
    (ev) => ev.prevCameraId === cameraId || ev.newCameraId === cameraId
  );

  // Recent clothing Re-ID events where this camera is involved
  const localClothingEvents = clothingReIdEvents.filter(
    (ev) => ev.prevCameraId === cameraId || ev.newCameraId === cameraId
  );

  // Combined confidence: look up face sim for clothing events that have a linked faceId
  const combinedConfidence = (clothingSim: number, faceId: string | null | undefined): number | null => {
    if (!faceId) return null;
    const facEv = crossCameraEvents.find(
      (e) => e.faceId === faceId &&
             Math.abs(e.timestamp - Date.now()) < 10_000
    );
    if (!facEv) return null;
    return 0.70 * facEv.similarity + 0.30 * clothingSim;
  };

  // Persons whose trajectory includes this camera (sorted: currently here first)
  const personTrails = [...allPersons.values()].filter((p) =>
    p.segments.some((s) => s.cameraId === cameraId)
  ).sort((a, b) => {
    const aHere = a.currentCameraId === cameraId ? 1 : 0;
    const bHere = b.currentCameraId === cameraId ? 1 : 0;
    return bHere - aHere || b.lastSeenAt - a.lastSeenAt;
  });

  // Helper: format duration in seconds
  const fmtDur = (ms: number) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${s % 60 > 0 ? `${s % 60}s` : ''}`;
  };

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

      {/* Category filter bar */}
      <div className="flex flex-wrap gap-1 px-2 py-1.5 border-b border-gray-700/60 flex-shrink-0">
        {CATEGORIES.map(({ key, label, color }) => {
          const hidden = hiddenCats.has(key);
          return (
            <button
              key={key}
              onClick={() => toggleCat(key)}
              title={hidden ? `Show ${label}` : `Hide ${label}`}
              className={`text-[8px] font-bold rounded px-1.5 py-0.5 transition-colors border ${
                hidden
                  ? 'bg-gray-700/60 text-gray-600 border-gray-600 line-through'
                  : `bg-gray-700/30 ${color} border-current/30 hover:bg-gray-700/60`
              }`}
            >
              {label}
            </button>
          );
        })}
        {hiddenCats.size > 0 && (
          <button
            onClick={() => setHiddenCats(new Set())}
            className="text-[8px] font-bold rounded px-1.5 py-0.5 bg-blue-800/40 text-blue-300 border border-blue-700/40 hover:bg-blue-800/60 transition-colors"
            title="Show all categories"
          >
            All
          </button>
        )}
      </div>

      {/* Detection list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <span className="text-xs">
              {hiddenCats.size > 0 ? 'All filtered — click "All" to reset' : t.noDetections}
            </span>
          </div>
        ) : (
          filtered.map((det) => (
            <DetectionRow
              key={det.objectId}
              det={det}
              isCrossCamera={det.className === 'face' && det.faceId != null && crossCamFaceIds.has(det.faceId)}
            />
          ))
        )}
      </div>

      {/* Person Trails — collapsible, shows persons who visited this camera */}
      {personTrails.length > 0 && (
        <div className="border-t border-gray-700 flex-shrink-0">
          <button
            onClick={() => setShowPersonTrails(v => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-gray-700/40 transition-colors"
          >
            <span className="text-[8px] text-teal-400 uppercase tracking-wide font-bold">
              Person Trails
              <span className="ml-1 text-teal-600 font-normal">({personTrails.length})</span>
            </span>
            <span className="text-[8px] text-gray-500">{showPersonTrails ? '▲' : '▼'}</span>
          </button>
          {showPersonTrails && (
            <div className="px-3 pb-2 space-y-1 max-h-28 overflow-y-auto">
              {personTrails.slice(0, 6).map((p) => {
                const isHere = p.currentCameraId === cameraId;
                // Build camera trail string, show up to last 4 cameras
                const segs = p.segments.slice(-4);
                const trail = segs.map((s, i) => {
                  const name = camName(s.cameraId);
                  const isCur = s.cameraId === cameraId && i === segs.length - 1;
                  return isCur ? `►${name}` : name;
                }).join(' → ');
                // Total dwell time across all segments
                const totalMs = p.segments.reduce((sum, s) => sum + (s.exitTime - s.entryTime), 0);
                return (
                  <div key={p.faceId} className="flex items-start gap-1.5 text-[9px] font-mono">
                    <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${isHere ? 'bg-teal-400' : 'bg-gray-600'}`} />
                    <div className="flex-1 min-w-0">
                      <span className="text-teal-300 font-bold">{p.alias}</span>
                      <span className="text-gray-500 ml-1">[{p.faceId}]</span>
                      <span className="text-gray-400 ml-1 block truncate">{trail}</span>
                      <span className="text-gray-600">total {fmtDur(totalMs)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Cross-Camera Re-ID feed — face + clothing events merged, collapsible */}
      {(localEvents.length > 0 || localClothingEvents.length > 0) && (
        <div className="border-t border-gray-700 flex-shrink-0">
          <button
            onClick={() => setShowCrossCamera(v => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-gray-700/40 transition-colors"
          >
            <span className="text-[8px] text-blue-400 uppercase tracking-wide font-bold">
              Cross-Camera Re-ID
              <span className="ml-1 text-blue-600 font-normal">
                ({localEvents.length + localClothingEvents.length})
              </span>
            </span>
            <span className="text-[8px] text-gray-500">{showCrossCamera ? '▲' : '▼'}</span>
          </button>
          {showCrossCamera && (
            <div className="px-3 pb-2 space-y-0.5 max-h-24 overflow-y-auto">
              {/* Face Re-ID events */}
              {localEvents.slice(0, 4).map((ev, i) => (
                <div key={`f-${i}`} className="flex items-center gap-1 text-[9px] font-mono text-gray-400">
                  <span className="text-blue-400" title="Face Re-ID">👤</span>
                  <span className="text-blue-300 font-bold">[{ev.faceId}]</span>
                  {ev.alias && <span className="text-teal-300 font-bold">{ev.alias}</span>}
                  <span className="text-gray-200" title={ev.prevCameraId}>{camName(ev.prevCameraId)}</span>
                  <span>→</span>
                  <span className="text-gray-200" title={ev.newCameraId}>{camName(ev.newCameraId)}</span>
                  <span className="text-gray-500 ml-auto">{(ev.similarity * 100).toFixed(0)}%</span>
                </div>
              ))}
              {/* Clothing Re-ID events */}
              {localClothingEvents.slice(0, 3).map((ev, i) => {
                const combined = combinedConfidence(ev.similarity, ev.faceId);
                return (
                  <div key={`c-${i}`} className="flex items-center gap-1 text-[9px] font-mono text-gray-400">
                    <span className="text-orange-400" title="Appearance Re-ID">👕</span>
                    <span className="text-orange-300 font-bold">[{ev.clothingId}]</span>
                    {ev.faceId && <span className="text-blue-500 text-[8px]">{ev.faceId}</span>}
                    <span className="text-gray-200" title={ev.prevCameraId}>{camName(ev.prevCameraId)}</span>
                    <span>→</span>
                    <span className="text-gray-200" title={ev.newCameraId}>{camName(ev.newCameraId)}</span>
                    <span className="ml-auto text-gray-500">
                      {combined != null
                        ? <span className="text-purple-400 font-bold">{(combined * 100).toFixed(0)}%</span>
                        : <span>{(ev.similarity * 100).toFixed(0)}%</span>
                      }
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Appearance Re-ID panel — clothing details, collapsible */}
      {localClothingEvents.length > 0 && (
        <div className="border-t border-gray-700 flex-shrink-0">
          <button
            onClick={() => setShowAppearance(v => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-gray-700/40 transition-colors"
          >
            <span className="text-[8px] text-orange-400 uppercase tracking-wide font-bold">
              Appearance Re-ID
              <span className="ml-1 text-orange-600 font-normal">({localClothingEvents.length})</span>
            </span>
            <span className="text-[8px] text-gray-500">{showAppearance ? '▲' : '▼'}</span>
          </button>
          {showAppearance && (
            <div className="px-3 pb-2 space-y-1 max-h-28 overflow-y-auto">
              {localClothingEvents.slice(0, 5).map((ev, i) => {
                const combined = combinedConfidence(ev.similarity, ev.faceId);
                const isHere   = ev.newCameraId === cameraId;
                return (
                  <div key={i} className="flex items-start gap-1.5 text-[9px] font-mono">
                    <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${isHere ? 'bg-orange-400' : 'bg-gray-600'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="text-orange-300 font-bold">{ev.clothingId}</span>
                        {ev.faceId && <span className="text-blue-400 text-[8px]">[{ev.faceId}]</span>}
                        <RgbSwatch rgb={ev.feature.upperRgb as [number,number,number] | null} />
                        <RgbSwatch rgb={ev.feature.lowerRgb as [number,number,number] | null} />
                        <span className="text-gray-500 truncate">{clothingLabel(ev.feature)}</span>
                      </div>
                      <div className="text-gray-500">
                        {camName(ev.prevCameraId)} → {camName(ev.newCameraId)}
                        {' '}
                        {combined != null
                          ? <span className="text-purple-400 font-bold">comb {(combined * 100).toFixed(0)}%</span>
                          : <span>appear {(ev.similarity * 100).toFixed(0)}%</span>
                        }
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="text-[8px] text-gray-600 pt-0.5">
                purple = face×0.7 + appear×0.3 combined confidence
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend — collapsible, collapsed by default */}
      <div className="border-t border-gray-700 flex-shrink-0">
        <button
          onClick={() => setShowLegend(v => !v)}
          className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-gray-700/40 transition-colors"
        >
          <span className="text-[8px] text-gray-400 uppercase tracking-wide font-bold">
            {t.legendPeopleVehicles ?? 'Object Classes'}
          </span>
          <span className="text-[8px] text-gray-500">{showLegend ? '▲' : '▼'}</span>
        </button>
        {showLegend && (
          <div className="px-3 pb-2 space-y-1.5 max-h-64 overflow-y-auto">
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
            </div>
            {/* Accessories */}
            <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.zoneGroupAccessories}</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
              <span className="text-amber-400">■ backpack</span>
              <span className="text-amber-400">■ handbag</span>
              <span className="text-amber-400">■ suitcase</span>
              <span className="text-amber-400">■ umbrella</span>
              <span className="text-amber-400">■ tie</span>
              <span className="text-orange-400">■ sports ball</span>
              <span className="text-sky-500">■ skis</span>
              <span className="text-yellow-500">■ baseball bat</span>
              <span className="text-orange-500">■ skateboard</span>
              <span className="text-cyan-500">■ surfboard</span>
              <span className="text-lime-400">■ tennis racket</span>
              <span className="text-violet-400">■ kite</span>
              <span className="text-gray-300">■ scissors/fork/knife</span>
              <span className="text-gray-400">■ remote/spoon</span>
            </div>
            {/* Animals */}
            <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.legendAnimals}</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
              <span className="text-pink-200">■ bird</span>
              <span className="text-rose-300">■ cat</span>
              <span className="text-rose-400">■ dog</span>
              <span className="text-amber-600">■ horse</span>
              <span className="text-gray-400">■ sheep</span>
              <span className="text-amber-900">■ cow</span>
              <span className="text-gray-500">■ elephant</span>
              <span className="text-amber-800">■ bear</span>
              <span className="text-gray-300">■ zebra</span>
              <span className="text-amber-600">■ giraffe</span>
            </div>
            {/* Outdoor / Infrastructure */}
            <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.legendOutdoor}</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
              <span className="text-emerald-400">■ bench</span>
              <span className="text-yellow-400">■ traffic light</span>
              <span className="text-red-500">■ fire hydrant</span>
              <span className="text-red-700">■ stop sign</span>
              <span className="text-gray-600">■ parking meter</span>
              <span className="text-indigo-400">■ airplane</span>
              <span className="text-blue-400">■ boat</span>
              <span className="text-emerald-500">■ train</span>
            </div>
            {/* Food / Kitchen */}
            <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.legendFood}</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
              <span className="text-amber-400">■ bowl</span>
              <span className="text-violet-300">■ wine glass</span>
              <span className="text-yellow-300">■ banana</span>
              <span className="text-red-500">■ apple</span>
              <span className="text-orange-500">■ orange</span>
              <span className="text-green-600">■ broccoli</span>
              <span className="text-orange-400">■ pizza</span>
              <span className="text-pink-400">■ donut</span>
              <span className="text-pink-200">■ cake</span>
              <span className="text-orange-400">■ sandwich/hotdog</span>
            </div>
            {/* Home Appliances */}
            <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.legendHomeAppliances}</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
              <span className="text-indigo-400">■ bed</span>
              <span className="text-slate-400">■ sink</span>
              <span className="text-slate-500">■ microwave</span>
              <span className="text-sky-200">■ refrigerator</span>
              <span className="text-green-300">■ potted plant</span>
              <span className="text-rose-300">■ hair drier</span>
              <span className="text-emerald-200">■ toothbrush</span>
              <span className="text-orange-200">■ teddy bear</span>
            </div>
            {/* Indoor / office objects */}
            <div className="text-[8px] text-gray-500 uppercase tracking-wide font-bold pt-0.5">{t.legendIndoor}</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
              <span className="text-violet-400">■ chair</span>
              <span className="text-violet-300">■ couch</span>
              <span className="text-emerald-400">■ dining table</span>
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
              <span className="bg-red-700/70 text-red-100 rounded px-1">NO HELMET</span>
              <span className="bg-gray-600/70 text-gray-200 rounded px-1">MASK? / HAT?</span>
              <span className="text-gray-500 text-[7px]">gray = AI uncertain</span>
              <span className="text-blue-400">⬚ face bbox</span>
              <span className="text-gray-400">↑↓ color</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Payload decoder ───────────────────────────────────────────────────────────
// App RTP payload is base64-encoded raw bytes from the RTSP data/subtitle track
// (typically ONVIF XML metadata). Try to render as UTF-8 text; fall back to
// binary size indicator so the row is never blank.
function decodePayload(b64: string): string {
  try {
    const bin  = atob(b64);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const text  = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Strip non-printable control chars (keep tab/LF/CR for XML readability)
    const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    if (clean.length > 0) return clean.slice(0, 200);
    return `[binary ${bytes.length}B]`;
  } catch {
    return '[decode error]';
  }
}

// ── Camera Events Tab ─────────────────────────────────────────────────────────
export function CameraEventsTab({ cameraId }: { cameraId: string }) {
  const history    = useDataChannelStore(s => s.history[cameraId]  ?? []);
  const totalCount = useDataChannelStore(s => s.counts[cameraId]   ?? 0);
  const listRef    = useRef<HTMLDivElement>(null);
  const { t }      = useI18n();

  // Auto-scroll to bottom when new history items arrive
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history.length]);

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('en', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

  return (
    <div className="flex flex-col h-full">
      {/* Tab header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/60 flex-shrink-0 bg-gray-900/60">
        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-300">
          {t.cameraEventsTab}
        </span>
        {totalCount > 0 && (
          <span className="text-[9px] bg-blue-700/50 text-blue-200 rounded-full px-1.5 py-0.5 tabular-nums">
            {totalCount >= 1000 ? `${Math.floor(totalCount / 1000)}k+` : totalCount}
          </span>
        )}
        {history.length === 0 && (
          <span className="text-[9px] text-gray-600 ml-auto">{t.cameraEventsNoData}</span>
        )}
      </div>

      {/* Message list — scrollable */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto min-h-0 divide-y divide-gray-800/50"
      >
        {history.map((msg: AppRtpMessage) => (
          <div
            key={`${msg.seq}-${msg.receivedAt}`}
            className="flex items-start gap-2 px-3 py-0.5 hover:bg-gray-800/40 transition-colors"
          >
            <span className="text-[8px] text-gray-500 whitespace-nowrap font-mono flex-shrink-0 pt-px">
              {fmtTime(msg.receivedAt)}
            </span>
            <span className="text-[8px] text-gray-600 flex-shrink-0 pt-px tabular-nums">
              #{msg.seq}
            </span>
            <span className="text-[8px] text-cyan-700 flex-shrink-0 pt-px">
              pt{msg.pt}
            </span>
            <span className="text-[8px] text-gray-400 break-all leading-3 pt-px">
              {decodePayload(msg.payload)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const PANEL_MIN_H  = 60;
const PANEL_MAX_H  = 600;
const PANEL_STORAGE_KEY = 'lts_fullscreen_panel_height';

export default function FullscreenCameraView({ cameraId, cameraName, onClose, initialVideoTab, initialFocusMatch }: Props) {
  const [videoTab, setVideoTab] = useState<'events' | 'onvif' | 'detections'>(initialVideoTab ?? 'onvif');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const { t } = useI18n();

  // Bottom panel height — persisted in localStorage
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem(PANEL_STORAGE_KEY) ?? '', 10);
    return isNaN(saved) ? 200 : Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, saved));
  });

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Responsive breakpoint
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Splitbar drag — mouse
  const handleSplitbarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY  = e.clientY;
    const startH  = panelHeight;

    const onMouseMove = (ev: MouseEvent) => {
      const next = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, startH + (startY - ev.clientY)));
      setPanelHeight(next);
    };
    const onMouseUp = (ev: MouseEvent) => {
      const next = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, startH + (startY - ev.clientY)));
      localStorage.setItem(PANEL_STORAGE_KEY, String(next));
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  }, [panelHeight]);

  // Splitbar drag — touch
  const handleSplitbarTouchStart = useCallback((e: React.TouchEvent) => {
    const startY = e.touches[0].clientY;
    const startH = panelHeight;

    const onTouchMove = (ev: TouchEvent) => {
      ev.preventDefault();
      const next = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, startH + (startY - ev.touches[0].clientY)));
      setPanelHeight(next);
    };
    const onTouchEnd = () => {
      setPanelHeight(prev => { localStorage.setItem(PANEL_STORAGE_KEY, String(prev)); return prev; });
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend',  onTouchEnd);
    };
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend',  onTouchEnd);
  }, [panelHeight]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90"
      style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* ── Video column (left on desktop, top on mobile) ─────────────── */}
      <div
        className="flex flex-col overflow-hidden min-h-0"
        style={isMobile ? { flex: '0 0 60%' } : { flex: 1, minWidth: 0 }}
      >
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
        <div className="flex-1 min-h-0 overflow-hidden p-2">
          <CameraView cameraId={cameraId} cameraName={cameraName} />
        </div>

        {/* ── Splitbar ──────────────────────────────────────────────── */}
        <div
          className="flex-shrink-0 flex items-center justify-center h-2 bg-gray-800/80 hover:bg-indigo-900/60 active:bg-indigo-800/70 cursor-row-resize group border-t border-b border-gray-700/60 transition-colors select-none"
          onMouseDown={handleSplitbarMouseDown}
          onTouchStart={handleSplitbarTouchStart}
          title="Drag to resize panel"
        >
          <div className="w-10 h-0.5 rounded-full bg-gray-600 group-hover:bg-indigo-400 transition-colors" />
        </div>

        {/* ── Bottom tab bar + content ───────────────────────────────── */}
        <div
          className="flex-shrink-0 flex flex-col bg-gray-900"
          style={{ height: panelHeight }}
        >
          {/* Tab bar */}
          <div className="flex items-center border-b border-gray-700/60 flex-shrink-0 bg-gray-900/80">
            <button
              onClick={() => setVideoTab('events')}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors border-b-2 ${
                videoTab === 'events'
                  ? 'border-blue-500 text-blue-300'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.cameraEventsTab}
            </button>
            <button
              onClick={() => setVideoTab('onvif')}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors border-b-2 ${
                videoTab === 'onvif'
                  ? 'border-indigo-500 text-indigo-300'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.onvifTimelineOpen}
            </button>
            <button
              onClick={() => setVideoTab('detections')}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide transition-colors border-b-2 ${
                videoTab === 'detections'
                  ? 'border-emerald-500 text-emerald-300'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              Detections
            </button>
          </div>

          {/* Tab content:
              events     → Camera Events (DataChannel RTP messages)
              onvif      → ONVIF Timeline (DB-persisted events)
              detections → Analysis Events history (fire/smoke/loitering stored in DB) */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {videoTab === 'events' && <CameraEventsTab cameraId={cameraId} />}
            {videoTab === 'onvif'  && <OnvifTimelineInline cameraId={cameraId} />}
            {videoTab === 'detections' && <DetectionsTimelineInline cameraId={cameraId} initialFocusMatch={initialFocusMatch} />}
          </div>
        </div>
      </div>

      {/* ── Right panel — real-time AI detections (always visible) ───── */}
      <div
        className="flex flex-col overflow-hidden border-gray-700"
        style={isMobile
          ? { flex: '0 0 40%', borderTop: '1px solid rgb(55 65 81)' }
          : { width: 288, flexShrink: 0, borderLeft: '1px solid rgb(55 65 81)' }
        }
      >
        <DetectionPanel cameraId={cameraId} />
      </div>
    </div>
  );
}
