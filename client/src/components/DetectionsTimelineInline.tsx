/**
 * DetectionsTimelineInline — Gantt-style detection track timeline with inline crop filmstrip.
 *
 * Layout per track row (ROW_H = 56px):
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  [████████ person #a3f2  2m30s  85% ████████]  ← Gantt bar (top 18px)
 *   │       [img1]     [img2]              [img3]     ← crops at timestamps (bottom 34px)
 *   └────────────────────────────────────────────────────────────┘
 *
 * Each crop thumbnail is positioned at its exact capture timestamp within the bar's span.
 * Clicking a thumbnail or bar selects the track → right detail panel with all snapshots.
 *
 * Data sources:
 *   GET /api/analysis/detection-tracks?cameraId=&from=&to=&class=&limit=
 *   GET /api/analysis/detection-snapshots?objectId=&cameraId=&limit=8  (per track)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DetectionTrack {
  id: string;
  cameraId: string;
  cameraName: string;
  objectId: string;
  className: string;
  firstSeenAt: string;
  lastSeenAt: string;
  dwellTime: number;
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
const LABEL_W   = 100;  // left Name column width
const DETAIL_W  = 200;
const ROW_H     = 56;   // bar (18px) + filmstrip (34px) + border (2px) + padding (2px)
const BAR_H     = 16;   // height of the Gantt bar portion
const BAR_TOP   = 4;    // top offset of bar within row
const SNAP_H    = 34;   // filmstrip height
const SNAP_TOP  = BAR_TOP + BAR_H + 2; // where filmstrip starts
const SNAP_W    = 28;   // thumbnail width
const TICK_H    = 20;   // tick label row height at bottom

function classColor(track: DetectionTrack): string {
  if (track.isLoitering) return '#ef4444';
  const cls = track.className;
  if (cls === 'person')     return '#22c55e';
  if (cls === 'face')       return '#93c5fd';
  if (cls === 'car')        return '#3b82f6';
  if (cls === 'truck')      return '#14b8a6';
  if (cls === 'bus')        return '#a855f7';
  if (cls === 'motorcycle') return '#f97316';
  if (cls === 'bicycle')    return '#eab308';
  if (cls === 'fire')       return '#f97316';
  if (cls === 'smoke')      return '#94a3b8';
  return '#6b7280';
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
  // Per-track snapshot cache: objectId → snapshot array (sorted by timestamp asc)
  const [snapCache, setSnapCache] = useState<Map<string, DetectionSnapshot[]>>(new Map());
  // All snapshots for selected track (full detail panel)
  const [detailSnaps,    setDetailSnaps]    = useState<DetectionSnapshot[]>([]);
  const [detailLoading,  setDetailLoading]  = useState(false);
  // Selected snapshot for zoomed view
  const [zoomedSnap, setZoomedSnap] = useState<DetectionSnapshot | null>(null);

  const containerRef  = useRef<HTMLDivElement>(null);
  const dragRef       = useRef<{ startX: number; startPan: number } | null>(null);
  const hasDraggedRef = useRef(false);

  // Compute time range
  const rangeMs = range === 'custom' && customApplied
    ? Math.max(1, new Date(customApplied.to).getTime() - new Date(customApplied.from).getTime())
    : (RANGE_MS[range] ?? RANGE_MS['1H']);

  const viewRangeEnd = range === 'custom' && customApplied
    ? new Date(customApplied.to).getTime()
    : Date.now();

  // ── Fetch tracks ──────────────────────────────────────────────────────────

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

  // ── Batch-fetch snapshots for visible tracks (up to 8 per track, 10 concurrent) ──

  const visibleTracks = useMemo(() => {
    const viewSpan  = rangeMs / zoom;
    const viewEnd   = viewRangeEnd - pan * rangeMs;
    const viewStart = viewEnd - viewSpan;
    return tracks.filter(t => {
      const fs = new Date(t.firstSeenAt).getTime();
      const ls = new Date(t.lastSeenAt).getTime();
      return ls >= viewStart && fs <= viewEnd;
    });
  }, [tracks, rangeMs, zoom, pan, viewRangeEnd]);

  useEffect(() => {
    const toFetch = visibleTracks.filter(t => !snapCache.has(t.objectId));
    if (toFetch.length === 0) return;

    const results = new Map<string, DetectionSnapshot[]>();

    const fetchOne = async (track: DetectionTrack) => {
      try {
        const params = new URLSearchParams({
          objectId: track.objectId,
          cameraId: track.cameraId,
          limit: '8',
        });
        const r = await fetch(`/api/analysis/detection-snapshots?${params}`);
        const d = await r.json();
        const snaps: DetectionSnapshot[] = Array.isArray(d.snapshots) ? d.snapshots : [];
        // Sort ascending by timestamp for left-to-right filmstrip
        snaps.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        results.set(track.objectId, snaps);
      } catch {
        results.set(track.objectId, []);
      }
    };

    const BATCH = 10;
    const run = async () => {
      for (let i = 0; i < toFetch.length; i += BATCH) {
        await Promise.all(toFetch.slice(i, i + BATCH).map(fetchOne));
      }
      setSnapCache(prev => {
        const next = new Map(prev);
        results.forEach((v, k) => next.set(k, v));
        return next;
      });
    };
    run();
  }, [visibleTracks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch ALL snapshots for selected track (detail panel) ──────────────────

  useEffect(() => {
    if (!selected) { setDetailSnaps([]); setZoomedSnap(null); return; }
    setDetailLoading(true);
    const params = new URLSearchParams({
      objectId: selected.objectId,
      cameraId: selected.cameraId,
      limit: '50',
    });
    fetch(`/api/analysis/detection-snapshots?${params}`)
      .then(r => r.json())
      .then(d => {
        const snaps: DetectionSnapshot[] = Array.isArray(d.snapshots) ? d.snapshots : [];
        snaps.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        setDetailSnaps(snaps);
      })
      .catch(() => setDetailSnaps([]))
      .finally(() => setDetailLoading(false));
  }, [selected]);

  // ── Viewport ────────────────────────────────────────────────────────────────

  const viewSpan  = rangeMs / zoom;
  const viewEnd   = viewRangeEnd - pan * rangeMs;
  const viewStart = viewEnd - viewSpan;

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

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startPan: pan };
    hasDraggedRef.current = false;
    setIsDragging(false);
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current || !containerRef.current) return;
    const dx    = e.clientX - dragRef.current.startX;
    const width = containerRef.current.getBoundingClientRect().width - LABEL_W;
    if (!hasDraggedRef.current && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!hasDraggedRef.current) { hasDraggedRef.current = true; setIsDragging(true); }
    setPan(clampPan(dragRef.current.startPan - dx / width / zoom, zoom));
  };
  const stopDrag = () => { dragRef.current = null; setIsDragging(false); };

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
        {loading ? <Spinner /> : (
          <button onClick={() => setFetchKey(k => k + 1)}
                  className="text-gray-500 hover:text-gray-300 transition-colors" title="Refresh">↺</button>
        )}
        <span className="text-gray-600">{visibleTracks.length}/{tracks.length}</span>
      </div>

      {/* ── Custom date row ──────────────────────────────────────────────────── */}
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

      {/* ── Main area ────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Gantt canvas ────────────────────────────────────────────────── */}
        <div
          ref={containerRef}
          className={`flex-1 relative overflow-hidden ${cursorClass}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
        >
          {/* Tick labels — offset by LABEL_W so ticks align with Gantt area */}
          <div className="absolute bottom-0 right-0 pointer-events-none bg-gray-900/60"
               style={{ left: LABEL_W, height: TICK_H, borderTop: '1px solid rgba(55,65,81,0.4)' }}>
            {ticks.map(({ x, label }) => (
              <div key={x} className="absolute flex flex-col items-center"
                   style={{ left: `${x * 100}%`, transform: 'translateX(-50%)', bottom: 2 }}>
                <div className="w-px h-2 bg-gray-600 mb-0.5" />
                <span className="text-[7px] text-gray-600 whitespace-nowrap">{label}</span>
              </div>
            ))}
          </div>

          {/* Track rows */}
          <div className="absolute top-0 left-0 right-0 overflow-y-auto"
               style={{ bottom: TICK_H }}>

            {/* Column header */}
            <div className="flex sticky top-0 z-10 border-b border-gray-700/50 bg-gray-900/95">
              <div className="flex-shrink-0 flex items-center px-2 border-r border-gray-700/60"
                   style={{ width: LABEL_W, height: 20 }}>
                <span className="text-[8px] font-semibold text-gray-500 uppercase tracking-wider">Name</span>
              </div>
              <div className="flex-1" style={{ height: 20 }} />
            </div>

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
                const fs    = new Date(track.firstSeenAt).getTime();
                const ls    = new Date(track.lastSeenAt).getTime();
                const xLeft  = Math.max(0, (fs - viewStart) / viewSpan);
                const xRight = Math.min(1, (ls - viewStart) / viewSpan);
                const barW   = Math.max(0.003, xRight - xLeft);
                const isSel  = selected?.id === track.id;
                const color  = classColor(track);
                const snaps  = snapCache.get(track.objectId) ?? null; // null=not fetched, []=no snaps
                const ganttW = (containerRef.current?.getBoundingClientRect().width ?? 800) - LABEL_W;

                return (
                  <div key={track.id}
                       className="flex"
                       style={{
                         height: ROW_H,
                         borderBottom: '1px solid rgba(55,65,81,0.4)',
                         backgroundColor: isSel ? 'rgba(255,255,255,0.03)' : undefined,
                       }}>

                    {/* ── Left Name label ── */}
                    <div
                      className="flex-shrink-0 flex flex-col justify-center px-2 border-r border-gray-700/50 overflow-hidden"
                      style={{ width: LABEL_W }}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={() => {
                        setSelected(prev => prev?.id === track.id ? null : track);
                        setZoomedSnap(null);
                      }}
                    >
                      <span className="text-[9px] font-bold truncate leading-tight"
                            style={{ color }}>
                        {track.isLoitering ? '⚠ ' : ''}{track.className}
                      </span>
                      <span className="text-[8px] text-gray-600 font-mono truncate leading-tight">
                        #{String(track.objectId).slice(-6)}
                      </span>
                      {track.identity && (
                        <span className="text-[8px] text-indigo-400/80 truncate leading-tight">
                          {track.identity}
                        </span>
                      )}
                    </div>

                    {/* ── Gantt area ── */}
                    <div className="flex-1 relative overflow-hidden" style={{ height: ROW_H }}>

                      {/* ── Gantt bar ── */}
                      <div
                        className="absolute flex items-center overflow-hidden rounded-sm"
                        style={{
                          left:            `${xLeft * 100}%`,
                          width:           `${barW * 100}%`,
                          top:             BAR_TOP,
                          height:          BAR_H,
                          backgroundColor: color + (isSel ? 'ff' : track.inProgress ? '88' : 'cc'),
                          border:          isSel ? `1px solid #fff` : track.inProgress ? `1px dashed ${color}` : `1px solid ${color}`,
                          cursor:          'pointer',
                          zIndex:          2,
                        }}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => {
                          if (hasDraggedRef.current) return;
                          setSelected(prev => prev?.id === track.id ? null : track);
                          setZoomedSnap(null);
                        }}
                        title={`${track.className} — ${fmtDur(track.dwellTime)} — risk ${(track.maxRiskScore * 100).toFixed(0)}%`}
                      >
                        <span className="px-1 text-[7px] font-bold text-white whitespace-nowrap overflow-hidden">
                          {fmtDur(track.dwellTime)}
                          {track.maxRiskScore > 0 && ` ${(track.maxRiskScore * 100).toFixed(0)}%`}
                        </span>
                      </div>

                      {/* ── Row index ── */}
                      <span className="absolute left-0.5 text-[7px] text-gray-700 pointer-events-none"
                            style={{ top: BAR_TOP + 2, zIndex: 1 }}>
                        {idx + 1}
                      </span>

                      {/* ── Crop filmstrip — each snapshot at its timestamp position ── */}
                      {snaps && snaps.length > 0 && snaps.map((snap, si) => {
                        const snapTs = new Date(snap.timestamp).getTime();
                        const xSnap = (snapTs - viewStart) / viewSpan; // 0..1 position
                        if (xSnap < 0 || xSnap > 1) return null; // outside view

                        // Center the thumbnail on xSnap, but clamp within Gantt area
                        const pct = Math.max(0, Math.min(100 - (SNAP_W / ganttW) * 100, xSnap * 100));

                        return (
                          <div
                            key={snap.id}
                            className="absolute overflow-hidden rounded border border-gray-600/80 cursor-pointer
                                       hover:border-white/60 hover:z-20 transition-all"
                            style={{
                              left:    `${pct}%`,
                              top:     SNAP_TOP,
                              width:   SNAP_W,
                              height:  SNAP_H,
                              zIndex:  si + 3,
                              outline: snap.isLoitering ? '1px solid #ef4444' : undefined,
                            }}
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => {
                              e.stopPropagation();
                              if (hasDraggedRef.current) return;
                              setSelected(prev => prev?.id === track.id ? track : track);
                              setZoomedSnap(prev => prev?.id === snap.id ? null : snap);
                            }}
                            title={new Date(snap.timestamp).toLocaleTimeString('en', { hour12: false })}
                          >
                            <img src={snap.cropData} alt={snap.className}
                                 className="w-full h-full object-cover" />
                            {snap.isLoitering && (
                              <span className="absolute top-0 right-0 bg-red-600/90 text-white text-[5px] px-px leading-tight">⚠</span>
                            )}
                          </div>
                        );
                      })}

                      {/* Loading indicator for this track's snaps */}
                      {snaps === null && (
                        <div className="absolute flex items-center justify-center"
                             style={{ left: `${xLeft * 100}%`, top: SNAP_TOP + 6, height: 20, width: 20 }}>
                          <span className="text-[8px] text-gray-700 animate-pulse">·</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Background click = deselect */}
          <div className="absolute inset-0 -z-10"
               onClick={() => { if (!hasDraggedRef.current) { setSelected(null); setZoomedSnap(null); } }} />
        </div>

        {/* ── Detail panel ─────────────────────────────────────────────────── */}
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
                {detailSnaps.length > 0 && (
                  <span className="text-[8px] text-gray-400 ml-1">({detailSnaps.length} crops)</span>
                )}
              </div>
              <button onClick={() => { setSelected(null); setZoomedSnap(null); }}
                      className="text-gray-500 hover:text-white flex-shrink-0 ml-1 text-[11px]">✕</button>
            </div>

            {/* Zoomed snapshot view */}
            {zoomedSnap && (
              <div className="flex-shrink-0 px-1 pt-1 pb-0.5 border-b border-gray-700/50 bg-black/40">
                <div className="relative overflow-hidden rounded border border-white/20">
                  <img src={zoomedSnap.cropData} alt={zoomedSnap.className}
                       className="w-full object-cover" style={{ maxHeight: 120 }} />
                  {zoomedSnap.isLoitering && (
                    <span className="absolute top-1 right-1 bg-red-600 text-white text-[7px] px-1 rounded">⚠ loitering</span>
                  )}
                  <span className="absolute bottom-0 left-0 right-0 text-[7px] text-gray-200
                                   bg-black/70 px-1 py-0.5 text-center">
                    {new Date(zoomedSnap.timestamp).toLocaleTimeString('en', { hour12: false })}
                  </span>
                  <button onClick={() => setZoomedSnap(null)}
                          className="absolute top-1 left-1 text-gray-400 hover:text-white bg-black/50 rounded px-1 text-[8px]">✕</button>
                </div>
              </div>
            )}

            {/* All crop thumbnails (scrollable grid) */}
            <div className="flex-shrink-0 border-b border-gray-700/50 overflow-y-auto"
                 style={{ maxHeight: 180 }}>
              {detailLoading ? (
                <div className="flex justify-center py-3"><Spinner /></div>
              ) : detailSnaps.length > 0 ? (
                <div className="grid gap-1 p-1" style={{ gridTemplateColumns: `repeat(3, 1fr)` }}>
                  {detailSnaps.map(s => (
                    <div key={s.id}
                         className={`relative overflow-hidden rounded border cursor-pointer transition-all
                                     ${zoomedSnap?.id === s.id ? 'border-white/80 ring-1 ring-white/30' : 'border-gray-700 hover:border-gray-500'}`}
                         onClick={() => setZoomedSnap(prev => prev?.id === s.id ? null : s)}>
                      <img src={s.cropData} alt={s.className}
                           className="w-full object-cover" style={{ height: 52 }} />
                      {s.isLoitering && (
                        <span className="absolute top-0 right-0 bg-red-600 text-white text-[5px] px-0.5">⚠</span>
                      )}
                      <span className="absolute bottom-0 left-0 right-0 text-[5px] text-gray-300
                                       bg-black/70 px-0.5 text-center leading-tight truncate">
                        {new Date(s.timestamp).toLocaleTimeString('en', { hour12: false })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[8px] text-gray-600 text-center py-2">No crop images saved</div>
              )}
            </div>

            {/* Track metadata */}
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

      {/* ── Pan bar (zoom > 1) ────────────────────────────────────────────── */}
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
