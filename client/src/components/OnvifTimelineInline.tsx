/**
 * OnvifTimelineInline — 2-panel ONVIF timeline.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Controls (range/filter/refresh)                             │
 *   ├──────────┬──────────────────────────────────────────────────┤
 *   │All Events│ [mini bars per event type, overlaid, 1 row]      │  ← OVERVIEW (scroll=zoom, click=toggle)
 *   ├──────────┼──────────────────────────────────────────────────┤
 *   │ Name     │                                                  │  ← sticky header (shown when expanded)
 *   │ Motion   │ ████████████████████                             │  ← detail rows (scroll=vertical, toggle)
 *   │ DigInput │ ██████                                           │
 *   ├──────────┴──────────────────────────────────────────────────┤
 *   │          │ 08:00   09:00   10:00   11:00                   │  ← tick labels (always visible)
 *   └──────────┴──────────────────────────────────────────────────┘
 *
 * Scroll isolation:
 *   - Overview strip  → wheel = zoom in/out
 *   - Detail rows     → wheel = vertical scroll (no zoom)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, X, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n';
import { useOnvifEventStore, type OnvifEvent, type OnvifEventType, type OnvifSeverity } from '../stores/onvifEventStore';
import { parseOnvifXml } from '../utils/onvifParser';
import { useSocket } from '../hooks/useSocket';

// ── Layout constants ──────────────────────────────────────────────────────────

const OVERVIEW_H  = 50;   // height of the overview strip
const MINI_BAR_H  = 8;    // mini bar height inside overview
const ROW_H       = 52;   // individual event row height
const BAR_H       = 16;
const BAR_TOP     = 4;
const SNAP_H      = 28;
const SNAP_W      = 40;
const SNAP_TOP    = BAR_TOP + BAR_H + 2;
const TICK_H      = 20;
const DETAIL_W    = 220;
const DRAG_THRESH = 4;
const LABEL_W     = 130;  // Name column width

// ── Range options ─────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { label: '1H', ms:       3_600_000 },
  { label: '6H', ms:  6 * 3_600_000 },
  { label: '1D', ms: 86_400_000 },
  { label: '1W', ms: 7 * 86_400_000 },
  { label: '1M', ms: 30 * 86_400_000 },
  { label: '1Y', ms: 365 * 86_400_000 },
] as const;
type RangeLabel = '1H' | '6H' | '1D' | '1W' | '1M' | '1Y' | 'custom';

// ── Severity colour palette ───────────────────────────────────────────────────

const SEV_COLOR: Record<OnvifSeverity, string> = {
  info:     '#6366f1',
  warning:  '#f59e0b',
  critical: '#ef4444',
};
const SEV_TEXT: Record<OnvifSeverity, string> = {
  info:     'text-indigo-300',
  warning:  'text-amber-300',
  critical: 'text-red-400',
};

// ── Interval / Row types ──────────────────────────────────────────────────────

interface OnvifInterval {
  id: string;
  cameraId: string;
  topicType: string;
  topicLabel: string;
  severity: OnvifSeverity;
  sourceToken: string | null;
  ruleName: string | null;
  startTs: number;
  endTs: number;
  isPoint: boolean;
  inProgress: boolean;
  durationMs: number;
  startEvt: OnvifEvent;
  endEvt: OnvifEvent | null;
}

interface OnvifRow {
  key: string;
  topicLabel: string;
  sourceToken: string | null;
  ruleName: string | null;
  severity: OnvifSeverity;
  intervals: OnvifInterval[];
}

interface Props { cameraId: string; }
interface DragState { startX: number; startPan: number; }

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function OnvifTimelineInline({ cameraId }: Props) {
  const { t }    = useI18n();
  const { socket } = useSocket();
  const { events, pushEvent, setEvents, types, setTypes, addType } = useOnvifEventStore();

  const [range,         setRange]         = useState<RangeLabel>('1H');
  const [zoom,          setZoom]          = useState(1);
  const [pan,           setPan]           = useState(0);
  const [typeFilter,    setTypeFilter]    = useState('');
  const [selected,      setSelected]      = useState<OnvifInterval | null>(null);
  const [loading,       setLoading]       = useState(false);
  const [showRaw,       setShowRaw]       = useState(false);
  const [isDragging,    setIsDragging]    = useState(false);
  const [fetchKey,      setFetchKey]      = useState(0);
  const [customStart,   setCustomStart]   = useState('');
  const [customEnd,     setCustomEnd]     = useState('');
  const [customApplied, setCustomApplied] = useState<{ from: string; to: string } | null>(null);
  const [zoomedSnap,    setZoomedSnap]    = useState<string | null>(null);
  const [showDetail,    setShowDetail]    = useState(true);  // toggle individual rows

  const [snapCache, setSnapCache] = useState<Map<string, string>>(new Map());
  const fetchedRef            = useRef<Set<string>>(new Set());
  const MAX_SNAP_CONCURRENCY  = 4;
  const activeSnapFetchesRef  = useRef(0);
  const snapFetchQueueRef     = useRef<Array<{ id: string; gen: number }>>([]);
  const snapGenerationRef     = useRef(0);

  const drainSnapQueue = useCallback(() => {
    while (activeSnapFetchesRef.current < MAX_SNAP_CONCURRENCY && snapFetchQueueRef.current.length > 0) {
      const item = snapFetchQueueRef.current.shift()!;
      const { id, gen } = item;
      activeSnapFetchesRef.current++;
      fetch(`/api/onvif-snapshots?eventId=${id}&limit=1`)
        .then(r => r.json())
        .then(d => {
          if (snapGenerationRef.current !== gen) return;
          const fd = (d.snapshots?.[0]?.frameData as string | undefined) ?? '';
          if (fd) setSnapCache(prev => { const m = new Map(prev); m.set(id, fd); return m; });
        })
        .catch(() => {})
        .finally(() => { activeSnapFetchesRef.current--; drainSnapQueue(); });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const containerRef  = useRef<HTMLDivElement>(null);
  const dragRef       = useRef<DragState | null>(null);
  const hasDraggedRef = useRef(false);

  // ── Viewport math ────────────────────────────────────────────────────────────
  const rangeMs = range === 'custom' && customApplied
    ? Math.max(1, new Date(customApplied.to).getTime() - new Date(customApplied.from).getTime())
    : (RANGE_OPTIONS.find(r => r.label === range)?.ms ?? 3_600_000);

  const viewRangeEnd = range === 'custom' && customApplied
    ? new Date(customApplied.to).getTime()
    : nowMs;

  const viewSpan  = rangeMs / zoom;
  const viewEnd   = viewRangeEnd - pan * rangeMs;
  const viewStart = viewEnd - viewSpan;

  // ── Fetch events ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (range === 'custom' && !customApplied) return;
    setLoading(true);
    setSelected(null);
    fetchedRef.current.clear();
    snapFetchQueueRef.current = [];
    snapGenerationRef.current++;
    setSnapCache(new Map());
    const params = new URLSearchParams({ cameraId, limit: '1000' });
    if (range === 'custom' && customApplied) {
      params.set('from', customApplied.from);
      params.set('to',   customApplied.to);
    } else {
      params.set('from', new Date(Date.now() - rangeMs).toISOString());
    }
    fetch(`/api/onvif-events?${params}`)
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d.events)) return;
        setEvents(d.events);
        const seen = new Set<string>();
        for (const evt of d.events as OnvifEvent[]) {
          if (!evt.topicType || seen.has(evt.topicType)) continue;
          seen.add(evt.topicType);
          addType({ id: evt.topicType, topicType: evt.topicType, topicLabel: evt.topicLabel,
                    topic: evt.topic, severity: evt.severity, firstSeenAt: evt.serverTs });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cameraId, range, customApplied, rangeMs, fetchKey, setEvents, addType]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch('/api/onvif-event-types')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.types)) setTypes(d.types); })
      .catch(() => {});
  }, [setTypes]);

  useEffect(() => {
    if (!socket) return;
    const onEvent = (evt: OnvifEvent) => { if (evt.cameraId === cameraId) pushEvent(evt); };
    const onType  = (type: OnvifEventType) => addType(type);
    socket.on('onvif:event', onEvent);
    socket.on('onvif:type-registered', onType);
    return () => { socket.off('onvif:event', onEvent); socket.off('onvif:type-registered', onType); };
  }, [socket, cameraId, pushEvent, addType]);

  // ── Build intervals + rows ───────────────────────────────────────────────────
  const { rows, totalCount } = useMemo(() => {
    const filtered = typeFilter ? events.filter(e => e.topicType === typeFilter) : events;
    const intervals = buildIntervals(filtered, nowMs);
    return { rows: buildRows(intervals), totalCount: filtered.length };
  }, [events, typeFilter, nowMs]);

  const visibleRows = useMemo(() =>
    rows.filter(r =>
      r.intervals.some(iv => iv.endTs >= viewStart && iv.startTs <= viewEnd)
    ),
  [rows, viewStart, viewEnd]);

  const visibleCount = useMemo(() =>
    visibleRows.reduce((n, r) =>
      n + r.intervals.filter(iv => iv.endTs >= viewStart && iv.startTs <= viewEnd).length, 0),
  [visibleRows, viewStart, viewEnd]);

  // ── Lazy-fetch inline snaps ───────────────────────────────────────────────────
  useEffect(() => {
    const gen = snapGenerationRef.current;
    const newItems = [
      ...visibleRows.flatMap(r => r.intervals.filter(iv => !iv.isPoint && iv.endTs >= viewStart && iv.startTs <= viewEnd)),
      ...visibleRows.flatMap(r => r.intervals.filter(iv =>  iv.isPoint && iv.endTs >= viewStart && iv.startTs <= viewEnd)),
    ].filter(iv => !fetchedRef.current.has(iv.id));
    if (newItems.length === 0) return;
    newItems.forEach(iv => {
      fetchedRef.current.add(iv.id);
      snapFetchQueueRef.current.push({ id: iv.id, gen });
    });
    drainSnapQueue();
  }, [visibleRows, viewStart, viewEnd, drainSnapQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ticks ─────────────────────────────────────────────────────────────────────
  const ticks = useMemo(() =>
    [0, 0.25, 0.5, 0.75, 1].map(f => ({
      x: f,
      label: formatTick(viewStart + f * viewSpan, viewSpan),
    })),
  [viewStart, viewSpan]);

  // ── Zoom / pan ────────────────────────────────────────────────────────────────
  const clampPan = useCallback((p: number, z: number) =>
    Math.max(0, Math.min(Math.max(0, 1 - 1 / z), p)), []);

  const applyZoom = useCallback((factor: number) =>
    setZoom(z => Math.max(1, Math.min(z * factor, 500))), []);

  const shiftPan = useCallback((delta: number) =>
    setPan(p => clampPan(p + delta, zoom)), [zoom, clampPan]);

  useEffect(() => { if (zoom === 1) setPan(0); }, [zoom]);

  // onWheel is only attached to the overview strip — detail rows use native vertical scroll
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) applyZoom(1.4); else applyZoom(1 / 1.4);
  };

  // ── Drag to pan ───────────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startPan: pan };
    hasDraggedRef.current = false;
    setIsDragging(false);
  };
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !containerRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const trackW = containerRef.current.getBoundingClientRect().width - LABEL_W;
    if (!hasDraggedRef.current && Math.abs(dx) < DRAG_THRESH) return;
    if (!hasDraggedRef.current) { hasDraggedRef.current = true; setIsDragging(true); }
    setPan(clampPan(dragRef.current.startPan - dx / trackW / zoom, zoom));
  };
  const stopDrag = () => { dragRef.current = null; setIsDragging(false); };

  // ── Overview click: toggle detail rows ────────────────────────────────────────
  const handleOverviewClick = () => {
    if (hasDraggedRef.current) return;
    if (showDetail) { setSelected(null); setZoomedSnap(null); }
    setShowDetail(s => !s);
  };

  // ── Detail panel data ─────────────────────────────────────────────────────────
  const selEvt    = selected?.startEvt ?? null;
  const parsed    = selEvt?.rawXml ? parseOnvifXml(selEvt.rawXml) : null;
  const dispItems = parsed?.items ?? selEvt?.items ?? {};
  const selSnap   = selected ? (snapCache.get(selected.id) ?? null) : null;

  const cursorClass = isDragging ? 'cursor-grabbing' : zoom > 1 ? 'cursor-grab' : 'cursor-default';

  return (
    <div className="flex flex-col h-full text-[10px] select-none">

      {/* ── Control row ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/60
                      flex-shrink-0 bg-gray-900/60 flex-wrap">
        <div className="flex items-center gap-0.5">
          {RANGE_OPTIONS.map(({ label }) => (
            <button key={label}
              onClick={() => { setRange(label as RangeLabel); setZoom(1); setPan(0); }}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                range === label ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
              }`}>{label}</button>
          ))}
          <button
            onClick={() => { setRange('custom'); setZoom(1); setPan(0); }}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
              range === 'custom' ? 'bg-purple-600 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
            }`}>Custom</button>
        </div>

        <select value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setSelected(null); }}
          className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                     text-gray-300 focus:outline-none focus:border-indigo-500 cursor-pointer">
          <option value="">All Types</option>
          {types.map(({ topicType, topicLabel }) => (
            <option key={topicType} value={topicType}>{topicLabel}</option>
          ))}
        </select>

        <div className="flex-1" />
        {zoom > 1 && (
          <span className="text-[9px] text-indigo-400 bg-indigo-900/30 px-1.5 py-0.5 rounded">
            ×{zoom.toFixed(1)}
          </span>
        )}
        <button onClick={() => applyZoom(1.4)}
                className="text-gray-500 hover:text-gray-300 transition-colors text-[11px] leading-none px-0.5"
                title="Zoom in">+</button>
        <button onClick={() => applyZoom(1 / 1.4)}
                disabled={zoom <= 1}
                className="text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-[11px] leading-none px-0.5"
                title="Zoom out">−</button>
        {loading ? <Spinner /> : (
          <button onClick={() => setFetchKey(k => k + 1)}
                  className="text-gray-500 hover:text-gray-300 transition-colors" title="Refresh"><RotateCcw className="w-3 h-3" /></button>
        )}
        <span className="text-gray-600">{visibleCount}/{totalCount}</span>
      </div>

      {/* ── Custom date row ───────────────────────────────────────────────────── */}
      {range === 'custom' && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/40
                        flex-shrink-0 bg-gray-900/40 flex-wrap">
          <span className="text-gray-500 text-[9px]">From</span>
          <input type="datetime-local" value={customStart} onChange={e => setCustomStart(e.target.value)}
                 className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                            text-gray-300 focus:outline-none focus:border-purple-500" />
          <span className="text-gray-500 text-[9px]">To</span>
          <input type="datetime-local" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
                 className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                            text-gray-300 focus:outline-none focus:border-purple-500" />
          <button
            onClick={() => {
              if (!customStart || !customEnd) return;
              setCustomApplied({ from: new Date(customStart).toISOString(), to: new Date(customEnd).toISOString() });
              setZoom(1); setPan(0);
            }}
            disabled={!customStart || !customEnd}
            className="px-2 py-0.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-40
                       text-white rounded text-[9px] font-bold transition-colors">Apply</button>
          {customApplied && (
            <button onClick={() => { setCustomApplied(null); setCustomStart(''); setCustomEnd(''); }}
                    className="text-gray-500 hover:text-gray-300" title="Clear"><X className="w-2.5 h-2.5" /></button>
          )}
        </div>
      )}

      {/* ── Main area ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Timeline column ───────────────────────────────────────────────── */}
        <div
          ref={containerRef}
          className={`flex-1 min-h-0 flex flex-col overflow-hidden ${cursorClass}`}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
        >

          {/* ── Overview strip (zoom on scroll, toggle on click) ─────────────── */}
          <div
            className="flex-shrink-0 relative overflow-hidden border-b border-indigo-900/40 bg-gray-950/50"
            style={{ height: OVERVIEW_H }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onClick={handleOverviewClick}
            title={showDetail ? 'Click to collapse event rows' : 'Click to expand event rows'}
          >
            {/* Left label area */}
            <div className="absolute left-0 top-0 bottom-0 flex items-center justify-between px-3
                            border-r border-gray-700/60 bg-gray-900/80 z-10 pointer-events-none"
                 style={{ width: LABEL_W }}>
              <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wider leading-none">
                All Events
              </span>
              <span className="text-[9px] text-gray-600 font-bold">{showDetail ? '▲' : '▼'}</span>
            </div>

            {/* Mini bars Gantt area */}
            <div className="absolute pointer-events-none"
                 style={{ left: LABEL_W, right: 0, top: 0, bottom: 0 }}>

              {/* Quarter grid lines */}
              {[0.25, 0.5, 0.75].map(f => (
                <div key={f} className="absolute top-0 bottom-0 w-px bg-gray-700/30"
                     style={{ left: `${f * 100}%` }} />
              ))}

              {/* Mini bars: one per interval, all event types overlaid */}
              {rows.map(row =>
                row.intervals
                  .filter(iv => iv.endTs >= viewStart && iv.startTs <= viewEnd)
                  .map(iv => {
                    const color = SEV_COLOR[iv.severity];
                    if (iv.isPoint) {
                      const x = (iv.startTs - viewStart) / viewSpan;
                      if (x < 0 || x > 1) return null;
                      return (
                        <div key={iv.id}
                             className="absolute"
                             style={{
                               left:            `${x * 100}%`,
                               top:             (OVERVIEW_H - MINI_BAR_H * 1.5) / 2,
                               width:           2,
                               height:          MINI_BAR_H * 1.5,
                               backgroundColor: color,
                               opacity:         0.75,
                               borderRadius:    1,
                               transform:       'translateX(-1px)',
                             }} />
                      );
                    }
                    const barL = Math.max(0, (iv.startTs - viewStart) / viewSpan);
                    const barR = Math.min(1, (iv.endTs - viewStart) / viewSpan);
                    const barW = Math.max(0.003, barR - barL);
                    return (
                      <div key={iv.id}
                           className="absolute"
                           style={{
                             left:            `${barL * 100}%`,
                             width:           `${barW * 100}%`,
                             top:             (OVERVIEW_H - MINI_BAR_H) / 2,
                             height:          MINI_BAR_H,
                             backgroundColor: color,
                             opacity:         iv.inProgress ? 0.45 : 0.65,
                             borderRadius:    2,
                           }} />
                    );
                  })
              )}

              {!loading && rows.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <span className="text-[9px] text-gray-700">{t.onvifTimelineEmpty}</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Individual event rows (scroll=vertical, no zoom) ─────────────── */}
          {showDetail && (
            <div
              className="flex-1 min-h-0 overflow-y-auto"
              onMouseDown={handleMouseDown}
              onClick={() => { if (!hasDraggedRef.current) { setSelected(null); setZoomedSnap(null); } }}
            >
              {/* Sticky "Name" column header */}
              <div className="flex sticky top-0 z-10 border-b border-gray-700/50 bg-gray-900/95">
                <div className="flex-shrink-0 flex items-center px-3 border-r border-gray-700/60"
                     style={{ width: LABEL_W, height: 22 }}>
                  <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-wider">Name</span>
                </div>
                <div className="flex-1" style={{ height: 22 }} />
              </div>

              {!loading && rows.length === 0 && (
                <div className="flex items-center justify-center py-8 text-gray-600 text-xs">
                  {t.onvifTimelineEmpty}
                </div>
              )}

              {visibleRows.map((row, rowIdx) => (
                <div key={row.key}
                     className="flex"
                     style={{
                       height: ROW_H,
                       borderBottom: '1px solid rgba(55,65,81,0.4)',
                       backgroundColor: rowIdx % 2 === 1 ? 'rgba(255,255,255,0.015)' : undefined,
                     }}>

                  {/* ── Left Name label ── */}
                  <div className="flex-shrink-0 flex items-center px-3 border-r border-gray-700/60 overflow-hidden"
                       style={{ width: LABEL_W }}
                       onMouseDown={e => e.stopPropagation()}>
                    <div className="flex flex-col min-w-0">
                      <span className={`text-[11px] font-semibold truncate ${SEV_TEXT[row.severity]}`}
                            title={row.topicLabel}>
                        {row.topicLabel}
                      </span>
                      {row.sourceToken && (
                        <span className="text-[9px] text-gray-500 truncate">{row.sourceToken}</span>
                      )}
                      {row.ruleName && (
                        <span className="text-[9px] text-indigo-400/70 truncate">[{row.ruleName}]</span>
                      )}
                    </div>
                  </div>

                  {/* ── Gantt area ── */}
                  <div className="flex-1 relative overflow-hidden" style={{ height: ROW_H }}>

                    <span className="absolute left-0.5 text-[7px] text-gray-700 pointer-events-none"
                          style={{ top: BAR_TOP + 2, zIndex: 1 }}>
                      {rowIdx + 1}
                    </span>

                    {[0.25, 0.5, 0.75].map(f => (
                      <div key={f} className="absolute top-0 bottom-0 w-px bg-gray-700/30 pointer-events-none"
                           style={{ left: `${f * 100}%` }} />
                    ))}

                    {row.intervals
                      .filter(iv => iv.endTs >= viewStart && iv.startTs <= viewEnd)
                      .map(iv => {
                        const isSel  = selected?.id === iv.id;
                        const color  = SEV_COLOR[iv.severity];
                        const snapFd = snapCache.get(iv.id) ?? '';

                        if (iv.isPoint) {
                          const x = (iv.startTs - viewStart) / viewSpan;
                          if (x < -0.01 || x > 1.01) return null;
                          return (
                            <React.Fragment key={iv.id}>
                              <button
                                onMouseDown={e => e.stopPropagation()}
                                onClick={e => {
                                  e.stopPropagation();
                                  if (!hasDraggedRef.current) {
                                    setSelected(sel => sel?.id === iv.id ? null : iv);
                                    setZoomedSnap(null);
                                  }
                                }}
                                style={{
                                  position: 'absolute',
                                  left: `${x * 100}%`,
                                  top: BAR_TOP + BAR_H / 2 - 5,
                                  width: 10, height: 10,
                                  transform: 'translateX(-50%) rotate(45deg)',
                                  backgroundColor: color,
                                  opacity: isSel ? 1 : 0.85,
                                  outline: isSel ? '1px solid #fff' : undefined,
                                  cursor: 'pointer',
                                  zIndex: 2,
                                }}
                                title={`${iv.topicLabel} — ${new Date(iv.startTs).toLocaleTimeString()}`}
                              />
                              {snapFd && (
                                <img
                                  onMouseDown={e => e.stopPropagation()}
                                  onClick={e => {
                                    e.stopPropagation();
                                    if (!hasDraggedRef.current) {
                                      setSelected(sel => sel?.id === iv.id ? null : iv);
                                      setZoomedSnap(prev => prev === snapFd ? null : snapFd);
                                    }
                                  }}
                                  src={snapFd}
                                  alt=""
                                  style={{
                                    position: 'absolute',
                                    left: `${Math.max(0, Math.min(97, x * 100))}%`,
                                    top: SNAP_TOP,
                                    width: SNAP_W,
                                    height: SNAP_H,
                                    objectFit: 'cover',
                                    borderRadius: 2,
                                    border: isSel ? '1px solid #fff' : `1px solid ${color}66`,
                                    cursor: 'pointer',
                                    zIndex: 2,
                                    transform: 'translateX(-4px)',
                                  }}
                                  title={`Frame at ${new Date(iv.startTs).toLocaleTimeString()}`}
                                />
                              )}
                            </React.Fragment>
                          );
                        }

                        const barL   = Math.max(0, (iv.startTs - viewStart) / viewSpan);
                        const barR   = Math.min(1, (iv.endTs - viewStart) / viewSpan);
                        const barW   = Math.max(0.003, barR - barL);
                        const dur    = fmtDur(iv.inProgress ? nowMs - iv.startTs : iv.durationMs);
                        const xSnap  = (iv.startTs - viewStart) / viewSpan;
                        const snapLeft = Math.max(0, Math.min(97, xSnap * 100));

                        return (
                          <React.Fragment key={iv.id}>
                            <div
                              className="absolute flex items-center overflow-hidden rounded-sm"
                              onMouseDown={e => e.stopPropagation()}
                              onClick={e => {
                                e.stopPropagation();
                                if (!hasDraggedRef.current) {
                                  setSelected(sel => sel?.id === iv.id ? null : iv);
                                  setZoomedSnap(null);
                                }
                              }}
                              style={{
                                left:            `${barL * 100}%`,
                                width:           `${barW * 100}%`,
                                top:             BAR_TOP,
                                height:          BAR_H,
                                backgroundColor: color + (isSel ? 'ff' : iv.inProgress ? '88' : 'cc'),
                                border:          isSel
                                  ? '1px solid #fff'
                                  : iv.inProgress
                                    ? `1px dashed ${color}`
                                    : `1px solid ${color}`,
                                cursor: 'pointer',
                                zIndex: 2,
                              }}
                              title={`${iv.topicLabel}${iv.inProgress ? ' (in progress)' : ''} — ${dur}`}
                            >
                              <span style={{ padding: '0 4px', fontSize: 7, fontWeight: 700, color: '#fff',
                                             whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                             display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                                {iv.inProgress && <ArrowRight style={{ width: 6, height: 6, flexShrink: 0 }} />}{iv.topicLabel} {dur}
                              </span>
                            </div>

                            {snapFd && (
                              <div
                                className="absolute overflow-hidden rounded border cursor-pointer hover:border-white/60 hover:z-20 transition-all"
                                onMouseDown={e => e.stopPropagation()}
                                onClick={e => {
                                  e.stopPropagation();
                                  if (!hasDraggedRef.current) {
                                    setSelected(sel => sel?.id === iv.id ? null : iv);
                                    setZoomedSnap(prev => prev === snapFd ? null : snapFd);
                                  }
                                }}
                                style={{
                                  position:   'absolute',
                                  left:       `${snapLeft}%`,
                                  top:        SNAP_TOP,
                                  width:      SNAP_W,
                                  height:     SNAP_H,
                                  borderColor: isSel ? '#fff' : `${color}66`,
                                  zIndex:     2,
                                  transform:  'translateX(-4px)',
                                }}
                                title={`Frame at ${new Date(iv.startTs).toLocaleTimeString()}`}
                              >
                                <img src={snapFd} alt="" className="w-full h-full object-cover" />
                              </div>
                            )}
                          </React.Fragment>
                        );
                      })
                    }
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Tick labels (always visible) ──────────────────────────────────── */}
          <div className="flex-shrink-0 relative bg-gray-900/60"
               style={{ height: TICK_H, borderTop: '1px solid rgba(55,65,81,0.4)' }}>
            <div className="absolute" style={{ left: LABEL_W, right: 0, top: 0, bottom: 0 }}>
              {ticks.map(({ x, label }) => (
                <div key={x} className="absolute flex flex-col items-center"
                     style={{ left: `${x * 100}%`, transform: 'translateX(-50%)', bottom: 2 }}>
                  <div className="w-px h-2 bg-gray-600 mb-0.5" />
                  <span className="text-[7px] text-gray-600 whitespace-nowrap">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Detail panel (only when rows are expanded) ───────────────────── */}
        {selected && showDetail && (
          <div className="flex flex-col flex-shrink-0 border-l border-gray-700 bg-gray-900/90 overflow-hidden"
               style={{ width: DETAIL_W }}>

            <div className="flex items-center justify-between px-2 py-1.5
                            border-b border-gray-700/60 bg-gray-800/80 flex-shrink-0">
              <div className="flex items-center gap-1 min-w-0">
                <span className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: SEV_COLOR[selected.severity] }} />
                <span className={`text-[9px] font-bold truncate ${SEV_TEXT[selected.severity]}`}>
                  {selected.topicLabel}
                </span>
              </div>
              <button onClick={() => { setSelected(null); setZoomedSnap(null); }}
                      className="text-gray-500 hover:text-white flex-shrink-0 ml-1"><X className="w-3 h-3" /></button>
            </div>

            {zoomedSnap && (
              <div className="flex-shrink-0 px-1 pt-1 pb-0.5 border-b border-gray-700/50 bg-black/40">
                <div className="relative overflow-hidden rounded border border-white/20">
                  <img src={zoomedSnap} alt="onvif-snap"
                       className="w-full object-cover" style={{ maxHeight: 120 }} />
                  <span className="absolute bottom-0 left-0 right-0 text-[7px] text-gray-200
                                   bg-black/70 px-1 py-0.5 text-center">
                    Frame at event start
                  </span>
                  <button onClick={() => setZoomedSnap(null)}
                          className="absolute top-1 left-1 text-gray-400 hover:text-white bg-black/50 rounded px-1"><X className="w-2 h-2" /></button>
                </div>
              </div>
            )}

            {selEvt?.rawXml && (
              <div className="flex border-b border-gray-700/60 flex-shrink-0">
                <button onClick={() => setShowRaw(false)}
                        className={`flex-1 py-0.5 text-[9px] font-bold ${!showRaw ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                  Parsed</button>
                <button onClick={() => setShowRaw(true)}
                        className={`flex-1 py-0.5 text-[9px] font-bold ${showRaw ? 'bg-green-900/50 text-green-300' : 'text-gray-500 hover:text-gray-300'}`}>
                  Raw XML</button>
              </div>
            )}

            {!zoomedSnap && selSnap && (
              <div className="flex-shrink-0 border-b border-gray-700/50 overflow-y-auto"
                   style={{ maxHeight: 120 }}>
                <div className="p-1">
                  <div className="relative overflow-hidden rounded border border-gray-700 cursor-pointer hover:border-gray-500"
                       onClick={() => setZoomedSnap(selSnap)}>
                    <img src={selSnap} alt="onvif-snap"
                         className="w-full object-cover" style={{ height: 80 }} />
                    <span className="absolute bottom-0 left-0 right-0 text-[7px] text-gray-200
                                     bg-black/70 px-1 py-0.5 text-center">
                      Frame at event start
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {showRaw ? (
                <pre className="px-2 py-1 text-[8px] text-green-400 whitespace-pre-wrap break-all leading-tight">
                  {selEvt?.rawXml}
                </pre>
              ) : (
                <div className="px-2 py-1 space-y-0.5">
                  <DetailRow label="Start" value={new Date(selected.startTs).toLocaleString()} />
                  <DetailRow
                    label="End"
                    value={selected.inProgress ? '● In Progress' : selected.isPoint ? '—' : new Date(selected.endTs).toLocaleString()}
                    highlight={selected.inProgress}
                  />
                  {!selected.isPoint && (
                    <DetailRow label="Dur"
                      value={fmtDur(selected.inProgress ? nowMs - selected.startTs : selected.durationMs)} />
                  )}
                  {selected.sourceToken && <DetailRow label="Source" value={selected.sourceToken} />}
                  {selected.ruleName && <DetailRow label="RuleName" value={selected.ruleName} />}
                  {selEvt?.operation && <DetailRow label="Op" value={selEvt.operation} />}
                  {Object.entries(dispItems)
                    .filter(([k]) => {
                      if (k === 'SourceToken' || k === 'State') return false;
                      if ((k === 'RuleName' || k === 'Rule') && selected?.ruleName) return false;
                      return true;
                    })
                    .map(([k, v]) => <DetailRow key={k} label={k} value={String(v)} />)
                  }
                  <div className="pt-0.5 border-t border-gray-700/40">
                    <DetailRow label="Topic" value={selEvt?.topic ?? ''} mono />
                  </div>
                  {!selSnap && !selected.inProgress && (
                    <div className="text-[8px] text-gray-600 italic pt-1">No frame snapshot</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Pan bar (zoom > 1) ────────────────────────────────────────────────── */}
      {zoom > 1 && (
        <div className="flex items-center gap-1 px-2 py-0.5 border-t border-gray-700/40
                        bg-gray-900/40 flex-shrink-0">
          <button onClick={() => shiftPan(-0.1 / zoom)}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded"><ChevronLeft className="w-2.5 h-2.5" /></button>
          <div className="flex-1 h-1 bg-gray-700 rounded-full relative">
            <div className="absolute h-full bg-indigo-500 rounded-full"
                 style={{ left: `${pan * zoom * 100}%`, width: `${(1 / zoom) * 100}%` }} />
          </div>
          <button onClick={() => shiftPan(0.1 / zoom)}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded"><ChevronRight className="w-2.5 h-2.5" /></button>
          <button onClick={() => { setZoom(1); setPan(0); }}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-500 rounded"><X className="w-2.5 h-2.5" /></button>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DetailRow({ label, value, mono, highlight }: {
  label: string; value: string; mono?: boolean; highlight?: boolean;
}) {
  return (
    <div className="flex gap-1 text-[9px] leading-tight">
      <span className="text-gray-500 flex-shrink-0 w-10 truncate">{label}</span>
      <span className={`break-all ${mono ? 'font-mono text-gray-400' : ''} ${highlight ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
        {value}
      </span>
    </div>
  );
}

// ── Utility functions ─────────────────────────────────────────────────────────

const STATE_KEYS = ['State', 'IsMotion', 'IsSoundDetected', 'IsAlarm', 'IsActive',
                    'Active', 'Enabled', 'IsEnabled', 'IsTriggered', 'IsDetected', 'Value'];

function getEventState(evt: OnvifEvent): 'true' | 'false' | null {
  if (evt.state === 'true'  || evt.state === 'false')  return evt.state;
  const items = evt.items as Record<string, string> | undefined;
  if (!items) return null;
  for (const key of STATE_KEYS) {
    const v = items[key];
    if (v === 'true'  || v === 'True')  return 'true';
    if (v === 'false' || v === 'False') return 'false';
    if (v === '1') return 'true';
    if (v === '0') return 'false';
  }
  for (const [k, v] of Object.entries(items)) {
    if (k.toLowerCase().includes('token') || k.toLowerCase().includes('source')) continue;
    if (v === 'true'  || v === 'false') return v as 'true' | 'false';
  }
  return null;
}

function mkPoint(evt: OnvifEvent): OnvifInterval {
  const tsMs = new Date(evt.serverTs).getTime();
  return {
    id: evt.id, cameraId: evt.cameraId, topicType: evt.topicType,
    topicLabel: evt.topicLabel, severity: evt.severity, sourceToken: evt.sourceToken,
    ruleName: evt.ruleName ?? null,
    startTs: tsMs, endTs: tsMs, isPoint: true, inProgress: false,
    durationMs: 0, startEvt: evt, endEvt: null,
  };
}

function buildIntervals(events: OnvifEvent[], nowMs: number): OnvifInterval[] {
  const sorted = [...events].sort(
    (a, b) => new Date(a.serverTs).getTime() - new Date(b.serverTs).getTime(),
  );
  const intervals: OnvifInterval[] = [];
  const open = new Map<string, OnvifInterval>();

  for (const evt of sorted) {
    const key   = `${evt.cameraId}:${evt.topicType}:${evt.sourceToken ?? ''}:${evt.ruleName ?? ''}`;
    const state = getEventState(evt);

    if (state === 'true') {
      if (open.has(key)) continue;
      const tsMs = new Date(evt.serverTs).getTime();
      open.set(key, {
        id: evt.id, cameraId: evt.cameraId, topicType: evt.topicType,
        topicLabel: evt.topicLabel, severity: evt.severity, sourceToken: evt.sourceToken,
        ruleName: evt.ruleName ?? null,
        startTs: tsMs, endTs: nowMs, isPoint: false, inProgress: true,
        durationMs: nowMs - tsMs, startEvt: evt, endEvt: null,
      });
    } else if (state === 'false') {
      const interval = open.get(key);
      if (interval) {
        const endTs = new Date(evt.serverTs).getTime();
        interval.endTs      = endTs;
        interval.inProgress = false;
        interval.durationMs = endTs - interval.startTs;
        interval.endEvt     = evt;
        intervals.push(interval);
        open.delete(key);
      } else {
        intervals.push(mkPoint(evt));
      }
    } else {
      intervals.push(mkPoint(evt));
    }
  }

  for (const iv of open.values()) {
    iv.durationMs = nowMs - iv.startTs;
    intervals.push(iv);
  }

  return intervals;
}

function buildRows(intervals: OnvifInterval[]): OnvifRow[] {
  const rowMap = new Map<string, OnvifRow>();
  for (const iv of intervals) {
    const key = `${iv.topicType}:${iv.sourceToken ?? ''}:${iv.ruleName ?? ''}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, {
        key,
        topicLabel:  iv.topicLabel,
        sourceToken: iv.sourceToken,
        ruleName:    iv.ruleName,
        severity:    iv.severity,
        intervals:   [],
      });
    }
    rowMap.get(key)!.intervals.push(iv);
  }
  return Array.from(rowMap.values());
}

function fmtDur(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60); const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

function formatTick(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs <= 2 * 3_600_000)
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (spanMs <= 86_400_000)
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (spanMs <= 7 * 86_400_000)
    return d.toLocaleDateString('en', { weekday: 'short' }) + ' ' +
           d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
