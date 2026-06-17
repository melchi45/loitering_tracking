/**
 * DetectionsTimelineInline — Gantt-style detection track timeline.
 *
 * Shows persisted track lifecycles (objectId, start→end, className, riskScore)
 * stored by pipelineManager when a ByteTracker track ends with riskScore >= 0.3
 * or isLoitering=true.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ [1H][6H][1D][1W][Custom]  [Class ▾]  🖼  ↺   5/12                  │ ← controls
 *   ├──────────────────────────────────────────────────────────────────────┤
 *   │ [thumb] │ Gantt rows (scrollable)             │ Detail panel (192px)│
 *   │  [img]  │  person#a3f2 [████████] L 85%      │ (open on bar click) │
 *   │  [img]  │  car#7d91     [████]                │                     │
 *   ├─────────┴──────────────────────────────────────┴─────────────────────┤
 *   │ tick labels                                                          │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Data source: GET /api/analysis/detection-tracks?cameraId=&from=&to=&class=&limit=
 * Thumbnails:  GET /api/analysis/detection-snapshots?objectId=&cameraId=&limit=1
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DetectionTrack {
  id: string;
  cameraId: string;
  cameraName: string;
  objectId: string;
  className: string;
  firstSeenAt: string;   // ISO
  lastSeenAt: string;    // ISO
  dwellTime: number;     // ms
  maxRiskScore: number;
  isLoitering: boolean;
  confidence: number;
  faceId?: string | null;
  identity?: string | null;
  zoneId?: string | null;
  zoneName?: string | null;
  color?: { upper: string; lower: string } | null;
  cloth?: { upper: string; lower: string; sleeve?: string } | null;
  inProgress?: boolean;
}

interface DetectionSnapshot {
  id: string;
  cameraId: string;
  objectId: string;
  timestamp: string;
  className: string;
  cropData: string;
  cropWidth: number;
  cropHeight: number;
  confidence: number;
  isLoitering: boolean;
}

type RangeLabel = '1H' | '6H' | '1D' | '1W' | 'custom';

const RANGE_MS: Record<string, number> = {
  '1H':  1 * 60 * 60 * 1000,
  '6H':  6 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W':  7 * 24 * 60 * 60 * 1000,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDur(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 > 0 ? `${s % 60}s` : ''}`;
}

function formatTick(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 2 * 3600_000)
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (spanMs <= 86400_000)
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (spanMs <= 7 * 86400_000)
    return d.toLocaleDateString('en', { weekday: 'short' }) + ' ' +
           d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

const DRAG_THRESHOLD_PX = 4;
const DETAIL_W   = 192;
const ROW_H      = 28; // px per track row (increased from 22 to fit thumbnail)
const THUMB_W    = 30; // px — thumbnail column width

function classColor(track: DetectionTrack): string {
  if (track.isLoitering) return '#ef4444'; // red-500
  const cls = track.className;
  if (cls === 'person')     return '#22c55e'; // green-500
  if (cls === 'face')       return '#93c5fd'; // blue-300
  if (cls === 'car')        return '#3b82f6'; // blue-500
  if (cls === 'truck')      return '#14b8a6'; // teal-500
  if (cls === 'bus')        return '#a855f7'; // purple-500
  if (cls === 'motorcycle') return '#f97316'; // orange-500
  if (cls === 'bicycle')    return '#eab308'; // yellow-500
  if (cls === 'fire')       return '#f97316'; // orange-500
  if (cls === 'smoke')      return '#94a3b8'; // slate-400
  return '#6b7280'; // gray-500
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DetectionsTimelineInline({ cameraId }: { cameraId: string }) {
  const [tracks,        setTracks]        = useState<DetectionTrack[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [range,         setRange]         = useState<RangeLabel>('1H');
  const [classFilter,   setClassFilter]   = useState('');
  const [selected,      setSelected]      = useState<DetectionTrack | null>(null);
  const [zoom,          setZoom]          = useState(1);
  const [pan,           setPan]           = useState(0);
  const [isDragging,    setIsDragging]    = useState(false);
  const [fetchKey,      setFetchKey]      = useState(0);
  const [customStart,   setCustomStart]   = useState('');
  const [customEnd,     setCustomEnd]     = useState('');
  const [customApplied, setCustomApplied] = useState<{ from: string; to: string } | null>(null);
  const [snapshots,     setSnapshots]     = useState<DetectionSnapshot[]>([]);
  const [snapsLoading,  setSnapsLoading]  = useState(false);
  // Thumbnails
  const [showThumbs,   setShowThumbs]    = useState(true);
  const [thumbCache,   setThumbCache]    = useState<Map<string, string | null>>(new Map());

  const containerRef   = useRef<HTMLDivElement>(null);
  const innerScrollRef = useRef<HTMLDivElement>(null);
  const thumbScrollRef = useRef<HTMLDivElement>(null);
  const dragRef        = useRef<{ startX: number; startPan: number } | null>(null);
  const hasDraggedRef  = useRef(false);

  // Compute fetch range
  const rangeMs = range === 'custom' && customApplied
    ? Math.max(1, new Date(customApplied.to).getTime() - new Date(customApplied.from).getTime())
    : (RANGE_MS[range] ?? RANGE_MS['1H']);

  const viewRangeEnd = range === 'custom' && customApplied
    ? new Date(customApplied.to).getTime()
    : Date.now();

  // Fetch tracks
  useEffect(() => {
    if (range === 'custom' && !customApplied) return;
    setLoading(true);
    const params = new URLSearchParams({ cameraId, limit: '1000' });
    if (range === 'custom' && customApplied) {
      params.set('from', customApplied.from);
      params.set('to',   customApplied.to);
    } else {
      const now = Date.now();
      params.set('from', new Date(now - (RANGE_MS[range] ?? RANGE_MS['1H'])).toISOString());
      params.set('to',   new Date(now).toISOString());
    }
    if (classFilter) params.set('class', classFilter);

    fetch(`/api/analysis/detection-tracks?${params}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) console.error('[DetectionsTimeline] API error:', d.error);
        setTracks(Array.isArray(d.tracks) ? d.tracks : []);
      })
      .catch(e => console.error('[DetectionsTimeline] fetch error:', e))
      .finally(() => setLoading(false));
  }, [fetchKey, range, customApplied, classFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch thumbnails for all loaded tracks (batched, 10 at a time)
  useEffect(() => {
    if (!showThumbs || tracks.length === 0) return;
    const toFetch = tracks.filter(t => !thumbCache.has(t.objectId));
    if (toFetch.length === 0) return;

    const results = new Map<string, string | null>();
    const fetchOne = async (track: DetectionTrack) => {
      try {
        const r = await fetch(
          `/api/analysis/detection-snapshots?objectId=${encodeURIComponent(track.objectId)}&cameraId=${encodeURIComponent(track.cameraId)}&limit=1`
        );
        const d = await r.json();
        const first = (Array.isArray(d.snapshots) ? d.snapshots : [])[0];
        results.set(track.objectId, first?.cropData ?? null);
      } catch {
        results.set(track.objectId, null);
      }
    };

    const BATCH = 10;
    const run = async () => {
      for (let i = 0; i < toFetch.length; i += BATCH) {
        await Promise.all(toFetch.slice(i, i + BATCH).map(fetchOne));
      }
      setThumbCache(prev => {
        const next = new Map(prev);
        results.forEach((v, k) => next.set(k, v));
        return next;
      });
    };
    run();
  }, [tracks, showThumbs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch crop snapshots when a track is selected
  useEffect(() => {
    if (!selected) { setSnapshots([]); return; }
    setSnapsLoading(true);
    const params = new URLSearchParams({
      objectId: selected.objectId,
      cameraId: selected.cameraId,
      limit: '20',
    });
    fetch(`/api/analysis/detection-snapshots?${params}`)
      .then(r => r.json())
      .then(d => setSnapshots(Array.isArray(d.snapshots) ? d.snapshots : []))
      .catch(() => setSnapshots([]))
      .finally(() => setSnapsLoading(false));
  }, [selected]);

  // Viewport
  const viewSpan  = rangeMs / zoom;
  const viewEnd   = viewRangeEnd - pan * rangeMs;
  const viewStart = viewEnd - viewSpan;

  // Zoom
  const applyZoom = useCallback((factor: number) => {
    setZoom(z => Math.max(1, Math.min(z * factor, 500)));
  }, []);
  const clampPan = useCallback((p: number, z: number) =>
    Math.max(0, Math.min(Math.max(0, 1 - 1 / z), p)), []);
  const shiftPan = useCallback((delta: number) => {
    setPan(p => clampPan(p + delta, zoom));
  }, [zoom, clampPan]);

  useEffect(() => { if (zoom === 1) setPan(0); }, [zoom]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) applyZoom(1.4); else applyZoom(1 / 1.4);
  };

  // Drag-to-pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startPan: pan };
    hasDraggedRef.current = false;
    setIsDragging(false);
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current || !containerRef.current) return;
    const dx    = e.clientX - dragRef.current.startX;
    const width = containerRef.current.getBoundingClientRect().width;
    if (!hasDraggedRef.current && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!hasDraggedRef.current) { hasDraggedRef.current = true; setIsDragging(true); }
    setPan(clampPan(dragRef.current.startPan - dx / width / zoom, zoom));
  };
  const stopDrag = () => { dragRef.current = null; setIsDragging(false); };

  // Scroll sync between thumbnail strip and Gantt rows
  const syncFromInner = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (thumbScrollRef.current) thumbScrollRef.current.scrollTop = e.currentTarget.scrollTop;
  }, []);
  const syncFromThumb = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (innerScrollRef.current) innerScrollRef.current.scrollTop = e.currentTarget.scrollTop;
  }, []);

  // Visible tracks (within viewport)
  const visibleTracks = useMemo(() => {
    return tracks.filter(t => {
      const fs = new Date(t.firstSeenAt).getTime();
      const ls = new Date(t.lastSeenAt).getTime();
      return ls >= viewStart && fs <= viewEnd;
    });
  }, [tracks, viewStart, viewEnd]);

  const ticks = useMemo(() =>
    [0, 0.25, 0.5, 0.75, 1].map(f => ({
      x:     f,
      label: formatTick(viewStart + f * viewSpan, viewSpan),
    })), [viewStart, viewSpan]);

  const cursorClass = isDragging ? 'cursor-grabbing' : zoom > 1 ? 'cursor-grab' : 'cursor-default';

  function applyCustomRange() {
    if (!customStart || !customEnd) return;
    setCustomApplied({ from: new Date(customStart).toISOString(), to: new Date(customEnd).toISOString() });
    setZoom(1); setPan(0);
  }

  return (
    <div className="flex flex-col h-full text-[10px] select-none">

      {/* ── Controls ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/60
                      flex-shrink-0 bg-gray-900/60 flex-wrap">

        {/* Range buttons */}
        <div className="flex items-center gap-0.5">
          {(['1H','6H','1D','1W','custom'] as RangeLabel[]).map(r => (
            <button key={r}
              onClick={() => { setRange(r); setZoom(1); setPan(0); if (r !== 'custom') setCustomApplied(null); }}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                range === r
                  ? r === 'custom' ? 'bg-purple-600 text-white' : 'bg-emerald-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
              }`}
            >
              {r === 'custom' ? 'Custom' : r}
            </button>
          ))}
        </div>

        {/* Class filter */}
        <select
          value={classFilter}
          onChange={e => { setClassFilter(e.target.value); setFetchKey(k => k + 1); }}
          className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                     text-gray-300 focus:outline-none focus:border-emerald-500 cursor-pointer"
        >
          <option value="">All Classes</option>
          <option value="person">Person</option>
          <option value="car">Car</option>
          <option value="truck">Truck</option>
          <option value="bus">Bus</option>
          <option value="motorcycle">Motorcycle</option>
        </select>

        <div className="flex-1" />

        {zoom > 1 && (
          <span className="text-[9px] text-emerald-400 bg-emerald-900/30 px-1.5 py-0.5 rounded">
            ×{zoom.toFixed(1)}
          </span>
        )}

        {/* Thumbnail toggle */}
        <button
          onClick={() => setShowThumbs(v => !v)}
          title={showThumbs ? 'Hide thumbnails' : 'Show thumbnails'}
          className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${
            showThumbs
              ? 'bg-blue-700/60 text-blue-200'
              : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
          }`}
        >
          {showThumbs ? '▣' : '▢'}
        </button>

        {loading ? <Spinner /> : (
          <button onClick={() => setFetchKey(k => k + 1)}
                  className="text-gray-500 hover:text-gray-300 transition-colors" title="Refresh">↺</button>
        )}
        <span className="text-gray-600">{visibleTracks.length}/{tracks.length}</span>
      </div>

      {/* ── Custom date row ─────────────────────────────────────────────────── */}
      {range === 'custom' && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/40
                        flex-shrink-0 bg-gray-900/40 flex-wrap">
          <span className="text-gray-500 text-[9px]">From</span>
          <input type="datetime-local" value={customStart} onChange={e => setCustomStart(e.target.value)}
                 className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px] text-gray-300
                            focus:outline-none focus:border-purple-500" />
          <span className="text-gray-500 text-[9px]">To</span>
          <input type="datetime-local" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
                 className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px] text-gray-300
                            focus:outline-none focus:border-purple-500" />
          <button onClick={applyCustomRange} disabled={!customStart || !customEnd}
                  className="px-2 py-0.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-40
                             text-white rounded text-[9px] font-bold transition-colors">Apply</button>
          {customApplied && (
            <button onClick={() => { setCustomApplied(null); setCustomStart(''); setCustomEnd(''); }}
                    className="text-gray-500 hover:text-gray-300 text-[9px]" title="Clear">✕</button>
          )}
        </div>
      )}

      {/* ── Main area: thumbnail strip + Gantt canvas + detail panel ─────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Thumbnail column (synced scroll with Gantt rows) */}
        {showThumbs && (
          <div
            ref={thumbScrollRef}
            onScroll={syncFromThumb}
            className="flex-shrink-0 overflow-y-auto overflow-x-hidden border-r border-gray-700/40 bg-gray-900/50"
            style={{ width: THUMB_W }}
          >
            {visibleTracks.length === 0 ? (
              /* placeholder to keep column visible */
              <div style={{ height: '100%' }} />
            ) : (
              <>
                {visibleTracks.map(track => {
                  const thumb = thumbCache.get(track.objectId);
                  const isSel = selected?.id === track.id;
                  return (
                    <div
                      key={track.id}
                      style={{ height: ROW_H, borderBottom: '1px solid rgba(55,65,81,0.3)' }}
                      className={`relative flex items-center justify-center overflow-hidden cursor-pointer
                                  transition-opacity ${isSel ? 'ring-1 ring-inset ring-white/50' : ''}`}
                      onClick={() => setSelected(prev => prev?.id === track.id ? null : track)}
                      title={`${track.className} — ${fmtDur(track.dwellTime)}`}
                    >
                      {thumb ? (
                        <img
                          src={thumb}
                          alt={track.className}
                          className="w-full h-full object-cover"
                          style={{ opacity: isSel ? 1 : 0.85 }}
                        />
                      ) : (
                        /* Letter avatar while loading or when no snapshot exists */
                        <div
                          className="w-full h-full flex items-center justify-center text-[8px] font-bold"
                          style={{
                            backgroundColor: classColor(track) + '22',
                            color: classColor(track),
                          }}
                        >
                          {thumb === null
                            ? track.className[0].toUpperCase()
                            : <span className="opacity-30">·</span>
                          }
                        </div>
                      )}
                      {track.isLoitering && (
                        <span className="absolute top-0 right-0 text-[6px] leading-none
                                         bg-red-600/90 text-white px-px">⚠</span>
                      )}
                    </div>
                  );
                })}
                {/* Bottom spacer matching tick label row height */}
                <div style={{ height: 20, borderTop: '1px solid rgba(55,65,81,0.2)' }} />
              </>
            )}
          </div>
        )}

        {/* Gantt canvas */}
        <div
          ref={containerRef}
          className={`flex-1 relative overflow-hidden ${cursorClass}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
        >
          {/* Tick labels row at bottom */}
          <div className="absolute bottom-0 left-0 right-0 h-5 border-t border-gray-700/40 pointer-events-none bg-gray-900/60">
            {ticks.map(({ x, label }) => (
              <div key={x} className="absolute flex flex-col items-center"
                   style={{ left: `${x * 100}%`, transform: 'translateX(-50%)', bottom: 2 }}>
                <div className="w-px h-2 bg-gray-600 mb-0.5" />
                <span className="text-[7px] text-gray-600 whitespace-nowrap">{label}</span>
              </div>
            ))}
          </div>

          {/* Track rows */}
          <div
            ref={innerScrollRef}
            onScroll={syncFromInner}
            className="absolute top-0 left-0 right-0 overflow-y-auto"
            style={{ bottom: 20 }}
          >
            {loading && visibleTracks.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-600 gap-2">
                <Spinner /> <span className="text-xs">Loading tracks…</span>
              </div>
            ) : visibleTracks.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-600 text-xs">
                No detection tracks in this range.
              </div>
            ) : (
              visibleTracks.map((track, idx) => {
                const fs = new Date(track.firstSeenAt).getTime();
                const ls = new Date(track.lastSeenAt).getTime();
                const xLeft  = Math.max(0, (fs - viewStart) / viewSpan);
                const xRight = Math.min(1, (ls - viewStart) / viewSpan);
                const barW   = Math.max(0.002, xRight - xLeft); // min 0.2% visible
                const isSel  = selected?.id === track.id;
                const color  = classColor(track);

                return (
                  <div key={track.id}
                       className="relative flex items-center"
                       style={{ height: ROW_H, borderBottom: '1px solid rgba(55,65,81,0.4)' }}>
                    {/* Bar */}
                    <div
                      className="absolute flex items-center overflow-hidden rounded-sm transition-transform"
                      style={{
                        left:            `${xLeft * 100}%`,
                        width:           `${barW * 100}%`,
                        top:             3,
                        height:          ROW_H - 6,
                        backgroundColor: color + (isSel ? 'ff' : track.inProgress ? '88' : 'cc'),
                        border:          isSel ? `2px solid #fff` : track.inProgress ? `1px dashed ${color}` : `1px solid ${color}`,
                        cursor:          'pointer',
                        zIndex:          isSel ? 10 : 1,
                      }}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={() => {
                        if (hasDraggedRef.current) return;
                        setSelected(prev => prev?.id === track.id ? null : track);
                      }}
                      title={`${track.className} — ${fmtDur(track.dwellTime)} — risk ${(track.maxRiskScore * 100).toFixed(0)}%`}
                    >
                      <span className="px-1 text-[8px] font-bold text-white whitespace-nowrap overflow-hidden">
                        {track.isLoitering ? '⚠ ' : ''}
                        {track.className}
                        {' '}
                        <span className="opacity-70">#{String(track.objectId).slice(-6)}</span>
                        {' '}
                        {fmtDur(track.dwellTime)}
                        {track.maxRiskScore > 0 && ` ${(track.maxRiskScore * 100).toFixed(0)}%`}
                      </span>
                    </div>

                    {/* Row index label (far left) */}
                    <span className="absolute left-0 text-[7px] text-gray-700 pl-0.5 pointer-events-none"
                          style={{ zIndex: 0 }}>
                      {idx + 1}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* Background click = deselect */}
          <div className="absolute inset-0 -z-10"
               onClick={() => { if (!hasDraggedRef.current) setSelected(null); }} />
        </div>

        {/* ── Detail panel (right, 192px, only when track selected) ──────────── */}
        {selected && (
          <div className="flex flex-col flex-shrink-0 border-l border-gray-700 bg-gray-900/90 overflow-hidden"
               style={{ width: DETAIL_W }}>
            {/* Header */}
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-gray-700/60
                            bg-gray-800/80 flex-shrink-0">
              <div className="flex items-center gap-1 min-w-0">
                <span className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: classColor(selected) }} />
                <span className="font-bold text-white text-[10px] uppercase truncate">
                  {selected.isLoitering ? '⚠ ' : ''}{selected.className}
                </span>
              </div>
              <button onClick={() => setSelected(null)}
                      className="text-gray-500 hover:text-white flex-shrink-0 ml-1 text-[11px]">✕</button>
            </div>

            {/* Crop image strip — all snapshots for this track */}
            <div className="flex-shrink-0 px-1 pt-1 pb-0.5 border-b border-gray-700/50 bg-gray-950/40">
              {snapsLoading ? (
                <div className="flex justify-center py-2"><Spinner /></div>
              ) : snapshots.length > 0 ? (
                <div className="grid grid-cols-2 gap-1">
                  {snapshots.map(s => (
                    <div key={s.id} className="relative overflow-hidden rounded border border-gray-700">
                      <img src={s.cropData} alt={s.className}
                           className="w-full object-cover"
                           style={{ maxHeight: 76 }} />
                      {s.isLoitering && (
                        <span className="absolute top-0 right-0 bg-red-600 text-white text-[6px] px-0.5">⚠</span>
                      )}
                      <span className="absolute bottom-0 left-0 right-0 text-[6px] text-gray-300
                                      bg-black/70 px-0.5 text-center leading-tight">
                        {new Date(s.timestamp).toLocaleTimeString('en', { hour12: false })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[8px] text-gray-600 text-center py-1.5">No crop images saved</div>
              )}
            </div>

            {/* Detail rows */}
            <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
              {selected.inProgress && (
                <div className="text-[8px] text-yellow-400 bg-yellow-900/30 rounded px-1 py-0.5 mb-1">
                  ● In progress
                </div>
              )}
              <DR label="Track"    value={`#${String(selected.objectId).slice(-8)}`} mono />
              <DR label="First"    value={new Date(selected.firstSeenAt).toLocaleString()} />
              <DR label="Last"     value={new Date(selected.lastSeenAt).toLocaleString()} />
              <DR label="Dwell"    value={fmtDur(selected.dwellTime)} highlight={selected.dwellTime > 10000} />
              <DR label="Risk"     value={`${(selected.maxRiskScore * 100).toFixed(0)}%`}
                                   highlight={selected.maxRiskScore >= 0.5} />
              <DR label="Loitering" value={selected.isLoitering ? 'YES' : 'No'} highlight={selected.isLoitering} />
              <DR label="Conf"     value={`${(selected.confidence * 100).toFixed(0)}%`} />
              {selected.faceId   && <DR label="Face"   value={selected.faceId} mono />}
              {selected.identity && <DR label="Name"   value={selected.identity} />}
              {selected.zoneName && <DR label="Zone"   value={selected.zoneName} />}
              {selected.color && (
                <>
                  <DR label="Upper" value={selected.color.upper} />
                  <DR label="Lower" value={selected.color.lower} />
                </>
              )}
              {selected.cloth && (
                <>
                  {selected.cloth.upper && <DR label="Cloth↑" value={selected.cloth.upper} />}
                  {selected.cloth.lower && <DR label="Cloth↓" value={selected.cloth.lower} />}
                </>
              )}
              <DR label="Camera" value={selected.cameraName} />
            </div>
          </div>
        )}
      </div>

      {/* ── Pan bar (zoom > 1) ────────────────────────────────────────────────── */}
      {zoom > 1 && (
        <div className="flex items-center gap-1 px-2 py-0.5 border-t border-gray-700/40
                        bg-gray-900/40 flex-shrink-0">
          <button onClick={() => shiftPan(-0.1 / zoom)}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-[9px]">◀</button>
          <div className="flex-1 h-1 bg-gray-700 rounded-full relative">
            <div className="absolute h-full bg-emerald-500 rounded-full"
                 style={{ left: `${pan * zoom * 100}%`, width: `${(1 / zoom) * 100}%` }} />
          </div>
          <button onClick={() => shiftPan(0.1 / zoom)}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-[9px]">▶</button>
          <button onClick={() => { setZoom(1); setPan(0); }}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-500 rounded text-[9px]">✕</button>
        </div>
      )}
    </div>
  );
}

// ── Detail row sub-component ──────────────────────────────────────────────────

function DR({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div className="flex gap-1 text-[9px] leading-tight">
      <span className="text-gray-500 flex-shrink-0 w-14 truncate">{label}</span>
      <span className={`break-all ${mono ? 'font-mono text-gray-400' : ''} ${highlight ? 'text-red-400 font-bold' : 'text-gray-300'}`}>
        {value}
      </span>
    </div>
  );
}
