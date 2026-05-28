import { useEffect, useRef, useState } from 'react';
import { useCameraStore } from '../stores/cameraStore';
import { useCrossCameraStore } from '../stores/crossCameraStore';
import { usePersonTrajectoryStore } from '../stores/personTrajectoryStore';
import { useAllDetections } from '../hooks/useAllDetections';
import { useSocket } from '../hooks/useSocket';
import { DetectionRow, CATEGORIES, getCategoryKey } from './FullscreenCameraView';
import { useI18n } from '../i18n';
import type { Detection } from '../types';

interface MergedDetection extends Detection {
  _cameraId:   string;
  _cameraName: string;
}

// ── Camera checkbox filter dropdown ──────────────────────────────────────────

interface CameraFilterProps {
  cameras:    { id: string; name: string }[];
  enabled:    Set<string>;
  onToggle:   (id: string) => void;
  onToggleAll: () => void;
}

function CameraFilter({ cameras, enabled, onToggle, onToggleAll }: CameraFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const allChecked  = enabled.size === cameras.length && cameras.length > 0;
  const noneChecked = enabled.size === 0;
  const label       = allChecked
    ? `All Cameras (${cameras.length})`
    : noneChecked
      ? 'No cameras'
      : `${enabled.size} / ${cameras.length} cameras`;

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-1 bg-gray-700 border border-gray-600 rounded px-2 py-0.5 text-[10px] text-gray-200 hover:bg-gray-600 transition-colors"
      >
        <span className="truncate">{label}</span>
        <span className="text-[8px] text-gray-400 flex-shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-0.5 bg-gray-800 border border-gray-600 rounded shadow-xl z-50 py-1 max-h-48 overflow-y-auto">
          {/* All toggle */}
          <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={onToggleAll}
              className="accent-blue-500"
            />
            <span className="text-[10px] text-gray-200 font-semibold">All</span>
          </label>
          <div className="border-t border-gray-700 my-0.5" />

          {cameras.map((c) => (
            <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled.has(c.id)}
                onChange={() => onToggle(c.id)}
                className="accent-blue-500"
              />
              <span className="flex-1 truncate text-[10px] text-gray-300">{c.name}</span>
              {!enabled.has(c.id) && (
                <span className="text-[8px] text-gray-600">hidden</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Color Legend popup ────────────────────────────────────────────────────────

function ColorLegendPopup({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 w-56 bg-gray-900 border border-gray-600 rounded shadow-2xl z-50 py-2 px-3 max-h-80 overflow-y-auto"
    >
      <div className="text-[9px] text-gray-400 uppercase tracking-wide font-bold mb-1.5">Detection Color Legend</div>

      {/* Row background */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">Row Background</div>
      <div className="grid grid-cols-1 gap-y-0.5 text-[9px] mb-2">
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-900/50 mr-1 align-middle" />Loitering alert</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-900/40 mr-1 align-middle" />Fire detected</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-800/60 mr-1 align-middle" />Smoke detected</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-900/30 mr-1 align-middle" />Face detected</span>
      </div>

      {/* People & vehicles */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">People & Vehicles</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] mb-2">
        <span className="text-green-400">■ person</span>
        <span className="text-red-400">■ loitering</span>
        <span className="text-blue-300">■ face</span>
        <span className="text-yellow-400">■ bicycle</span>
        <span className="text-blue-400">■ car</span>
        <span className="text-orange-400">■ motorcycle</span>
        <span className="text-purple-400">■ bus</span>
        <span className="text-teal-400">■ truck</span>
      </div>

      {/* Hazard */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">Hazard</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] mb-2">
        <span className="text-orange-500">■ fire</span>
        <span className="text-slate-400">■ smoke</span>
      </div>

      {/* Accessories */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">Accessories</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] mb-2">
        <span className="text-amber-400">■ backpack</span>
        <span className="text-amber-400">■ handbag</span>
        <span className="text-amber-400">■ suitcase</span>
        <span className="text-amber-400">■ umbrella</span>
        <span className="text-orange-400">■ sports ball</span>
        <span className="text-sky-500">■ skis</span>
        <span className="text-yellow-500">■ baseball bat</span>
        <span className="text-cyan-500">■ surfboard</span>
      </div>

      {/* Animals */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">Animals</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] mb-2">
        <span className="text-pink-200">■ bird</span>
        <span className="text-rose-300">■ cat</span>
        <span className="text-rose-400">■ dog</span>
        <span className="text-orange-800">■ horse</span>
        <span className="text-gray-100">■ sheep</span>
        <span className="text-amber-900">■ cow</span>
        <span className="text-gray-500">■ elephant</span>
        <span className="text-amber-800">■ bear</span>
        <span className="text-gray-100">■ zebra</span>
        <span className="text-amber-600">■ giraffe</span>
      </div>

      {/* Outdoor */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">Outdoor</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] mb-2">
        <span className="text-emerald-400">■ bench</span>
        <span className="text-yellow-400">■ traffic light</span>
        <span className="text-red-500">■ fire hydrant</span>
        <span className="text-red-700">■ stop sign</span>
        <span className="text-indigo-400">■ airplane</span>
        <span className="text-blue-400">■ boat</span>
        <span className="text-emerald-500">■ train</span>
      </div>

      {/* Color Analysis (Phase-1, active) */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">
        Color Analysis <span className="text-green-600 normal-case font-normal">(active)</span>
      </div>
      <div className="grid grid-cols-1 gap-y-0.5 text-[9px] mb-2">
        <span className="text-gray-400">Person row shows clothing colors:</span>
        <span className="font-mono text-gray-300">upper <span className="text-white">gray</span> | lower <span className="text-white">black</span></span>
        <div className="grid grid-cols-3 gap-x-1 gap-y-0.5 mt-0.5">
          {['black','white','gray','red','orange','yellow','green','blue','purple','pink','brown'].map(c => (
            <span key={c} className="text-gray-400">· {c}</span>
          ))}
        </div>
      </div>

      {/* Cloth Type (Phase-2, active) */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">
        Cloth Type <span className="text-green-600 normal-case font-normal">(active)</span>
      </div>
      <div className="grid grid-cols-1 gap-y-0.5 text-[9px] mb-2">
        <span className="font-mono"><span className="text-violet-500">cloth</span> <span className="text-violet-300">↑hoodie ↓jeans</span> <span className="text-violet-600">[long]</span></span>
        <div className="mt-0.5">
          <span className="text-gray-500">Upper: </span>
          <span className="text-violet-300">tshirt shirt jacket hoodie vest dress</span>
        </div>
        <div>
          <span className="text-gray-500">Lower: </span>
          <span className="text-violet-300">pants jeans shorts skirt</span>
        </div>
        <div>
          <span className="text-gray-500">Sleeve: </span>
          <span className="text-violet-600">short long</span>
        </div>
      </div>

      {/* Badges */}
      <div className="text-[8px] text-gray-500 uppercase tracking-wide font-semibold mb-0.5">Status Badges</div>
      <div className="grid grid-cols-1 gap-y-0.5 text-[9px]">
        <span><span className="inline-block bg-red-600 text-white rounded px-1 text-[7px] mr-1">LOITER</span>Loitering active</span>
        <span><span className="inline-block bg-orange-600 text-white rounded px-1 text-[7px] mr-1">FIRE</span>Fire/smoke alert</span>
        <span><span className="inline-block bg-blue-700/70 text-blue-100 rounded px-1 text-[7px] mr-1">X-CAM</span>Cross-camera Re-ID</span>
        <span><span className="inline-block bg-teal-700/70 text-teal-100 rounded px-1 text-[7px] mr-1">P1</span>Person alias (canonical ID)</span>
      </div>
    </div>
  );
}

// ── Dashboard Detection Panel ─────────────────────────────────────────────────

export function DashboardDetectionPanel() {
  const cameras = useCameraStore((s) => s.cameras);
  const { t }   = useI18n();
  const { socket } = useSocket();

  // ── Snapshot crop thumbnails: key = 'cameraId:objectId' → base64 data URL
  const [cropMap, setCropMap] = useState<Record<string, string>>({});

  // Camera filter state — all enabled by default
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(cameras.map((c) => c.id))
  );

  // Sync when cameras list changes (new camera added / removed)
  useEffect(() => {
    setEnabledIds(prev => {
      const next = new Set(prev);
      // Add newly registered cameras
      for (const c of cameras) next.add(c.id);
      // Remove cameras that no longer exist
      for (const id of next) {
        if (!cameras.find((c) => c.id === id)) next.delete(id);
      }
      return next;
    });
  }, [cameras]);

  const enabledList  = cameras.filter((c) => enabledIds.has(c.id)).map((c) => c.id);
  const detectionMap = useAllDetections(enabledList);

  // Subscribe to snapshot:new events from the server
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { cameraId: string; objectId: number | string; cropData: string }) => {
      const key = `${data.cameraId}:${data.objectId}`;
      setCropMap(prev => ({ ...prev, [key]: data.cropData }));
    };
    socket.on('snapshot:new', handler);
    return () => { socket.off('snapshot:new', handler); };
  }, [socket]);

  const crossCameraEvents = useCrossCameraStore((s) => s.events);
  const allPersons        = usePersonTrajectoryStore((s) => s.persons);

  const [hiddenCats,      setHiddenCats]      = useState<Set<string>>(new Set());
  const [showCrossCamera, setShowCrossCamera] = useState(true);
  const [showPersonTrails, setShowPersonTrails] = useState(true);
  const [showLegend,      setShowLegend]      = useState(false);
  const legendBtnRef = useRef<HTMLDivElement>(null);

  const toggleCam = (id: string) =>
    setEnabledIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setEnabledIds(
      enabledIds.size === cameras.length
        ? new Set()
        : new Set(cameras.map((c) => c.id))
    );

  const toggleCat = (key: string) =>
    setHiddenCats(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Build merged + sorted detection list
  const merged: MergedDetection[] = [];
  for (const [cameraId, dets] of detectionMap) {
    const cam = cameras.find((c) => c.id === cameraId);
    const cameraName = cam?.name ?? cameraId.slice(0, 8);
    for (const det of dets) {
      merged.push({ ...det, _cameraId: cameraId, _cameraName: cameraName });
    }
  }
  merged.sort((a, b) => {
    if (a.isLoitering !== b.isLoitering) return a.isLoitering ? -1 : 1;
    return b.dwellTime - a.dwellTime;
  });

  const filtered = hiddenCats.size === 0
    ? merged
    : merged.filter((d) => !hiddenCats.has(getCategoryKey(d.className ?? '')));

  const loiteringCount = merged.filter((d) => d.isLoitering).length;

  // Cross-camera events (global)
  const crossCamFaceIds = new Set(crossCameraEvents.map((ev) => ev.faceId));

  // Camera names resolver
  const camName = (id: string) => cameras.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  // Person Trails — all active persons
  const personTrails = [...allPersons.values()].sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt
  );

  const fmtDur = (ms: number) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${s % 60 > 0 ? `${s % 60}s` : ''}`;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Top bar: camera filter + stats ── */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-700 flex-shrink-0 bg-gray-800/60">
        <span className="text-[9px] text-gray-500 uppercase tracking-wide flex-shrink-0">Camera</span>
        <CameraFilter
          cameras={cameras}
          enabled={enabledIds}
          onToggle={toggleCam}
          onToggleAll={toggleAll}
        />
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-[9px] text-gray-400">{t.objCount(merged.length)}</span>
          {loiteringCount > 0 && (
            <span className="text-[9px] font-bold text-red-400">{t.loiterCount(loiteringCount)}</span>
          )}
        </div>
        {/* Color legend button */}
        <div ref={legendBtnRef} className="relative flex-shrink-0">
          <button
            onClick={() => setShowLegend(v => !v)}
            className={`w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center transition-colors border ${
              showLegend
                ? 'bg-blue-600 border-blue-400 text-white'
                : 'bg-gray-700 border-gray-500 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
            }`}
            title="Color Legend"
          >
            ?
          </button>
          {showLegend && <ColorLegendPopup onClose={() => setShowLegend(false)} />}
        </div>
      </div>

      {/* ── Category filter bar ── */}
      <div className="flex flex-wrap gap-1 px-2 py-1.5 border-b border-gray-700/60 flex-shrink-0">
        {CATEGORIES.map(({ key, label, color }) => {
          const hidden = hiddenCats.has(key);
          return (
            <button
              key={key}
              onClick={() => toggleCat(key)}
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
          >
            All
          </button>
        )}
      </div>

      {/* ── Merged detection list ── */}
      <div className="flex-1 overflow-y-auto">
        {cameras.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 px-4 text-center">
            <span className="text-xs">{t.addCameraFirst}</span>
          </div>
        ) : enabledIds.size === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 px-4 text-center">
            <span className="text-xs">No cameras selected</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600">
            <span className="text-xs">
              {hiddenCats.size > 0 ? 'All filtered — click "All" to reset' : t.noDetections}
            </span>
          </div>
        ) : (
          filtered.map((det, i) => {
            const cropKey  = `${det._cameraId}:${det.objectId}`;
            const cropData = cropMap[cropKey];
            return (
              <div key={`${det._cameraId}-${det.objectId}-${i}`}>
                {/* Camera name badge — shown when cameraId changes from previous row */}
                {(i === 0 || det._cameraId !== filtered[i - 1]._cameraId) && (
                  <div className="px-3 pt-1.5 pb-0.5">
                    <span className="text-[8px] font-bold uppercase tracking-wide bg-gray-700/60 text-gray-400 rounded px-1.5 py-0.5">
                      {det._cameraName}
                    </span>
                  </div>
                )}
                <div className="flex items-start gap-1.5 pr-1">
                  {/* Crop thumbnail */}
                  {cropData ? (
                    <img
                      src={cropData}
                      alt={det.className ?? 'crop'}
                      className="w-8 h-10 object-cover rounded border border-gray-600 bg-gray-700 flex-shrink-0 mt-0.5 ml-1 cursor-pointer hover:opacity-80 transition-opacity"
                      title="Click to enlarge"
                      onClick={() => window.open(cropData, '_blank')}
                    />
                  ) : (
                    <div className="w-8 h-10 rounded border border-gray-700/40 bg-gray-800/30 flex-shrink-0 mt-0.5 ml-1" />
                  )}
                  <div className="flex-1 min-w-0">
                    <DetectionRow
                      det={det}
                      isCrossCamera={det.className === 'face' && det.faceId != null && crossCamFaceIds.has(det.faceId)}
                    />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Person Trails (global — all cameras) ── */}
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
              {personTrails.slice(0, 8).map((p) => {
                const segs  = p.segments.slice(-4);
                const trail = segs.map((s, i) => {
                  const name  = camName(s.cameraId);
                  const isCur = i === segs.length - 1;
                  return isCur ? `►${name}` : name;
                }).join(' → ');
                const totalMs = p.segments.reduce((sum, s) => sum + (s.exitTime - s.entryTime), 0);
                return (
                  <div key={p.faceId} className="flex items-start gap-1.5 text-[9px] font-mono">
                    <span className="mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 bg-teal-500" />
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

      {/* ── Cross-Camera Re-ID feed (global) ── */}
      {crossCameraEvents.length > 0 && (
        <div className="border-t border-gray-700 flex-shrink-0">
          <button
            onClick={() => setShowCrossCamera(v => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-gray-700/40 transition-colors"
          >
            <span className="text-[8px] text-blue-400 uppercase tracking-wide font-bold">
              Cross-Camera Re-ID
              <span className="ml-1 text-blue-600 font-normal">({crossCameraEvents.length})</span>
            </span>
            <span className="text-[8px] text-gray-500">{showCrossCamera ? '▲' : '▼'}</span>
          </button>
          {showCrossCamera && (
            <div className="px-3 pb-2 space-y-0.5 max-h-20 overflow-y-auto">
              {crossCameraEvents.slice(0, 6).map((ev, i) => (
                <div key={i} className="text-[9px] font-mono text-gray-400">
                  {ev.alias && <span className="text-teal-300 font-bold mr-1">{ev.alias}</span>}
                  <span className="text-blue-300 font-bold">[{ev.faceId}]</span>
                  {' '}<span className="text-gray-200" title={ev.prevCameraId}>{camName(ev.prevCameraId)}</span>
                  {' '}&#8594;{' '}
                  <span className="text-gray-200" title={ev.newCameraId}>{camName(ev.newCameraId)}</span>
                  {ev.newObjectId != null && (
                    <span className="text-yellow-400 ml-0.5" title={String(ev.newObjectId)}>
                      #{typeof ev.newObjectId === 'string' ? ev.newObjectId.slice(0, 6) : ev.newObjectId}
                    </span>
                  )}
                  {' '}<span className="text-gray-500">{(ev.similarity * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
