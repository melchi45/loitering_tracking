/**
 * OnvifTimelineInline — compact ONVIF timeline embedded in FullscreenCameraView.
 *
 * Rendering:
 *   - state=true/false pairs → horizontal Gantt bars (start→end)
 *   - in-progress (state=true, no matching false) → dashed-right bar
 *   - no-state events → diamond point markers
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ [1D][1W][1M][1Y][Custom]  [Type ▾]    ×2.0  5/12           │ ← control
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ callRequest (Tok)│ ████░░░░ 3s ████          │ detail 200px │
 *   │ motionAlarm      │ ████████████████ 15s      │              │
 *   │──────────────────┼──────────────────────     │              │
 *   │ <tick labels>    │                           │              │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │  ◀ ━━━━━━━━━━━━ ▶  ✕   (zoom > 1 only)                     │
 *   └─────────────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useOnvifEventStore, type OnvifEvent, type OnvifEventType, type OnvifSeverity } from '../stores/onvifEventStore';
import { parseOnvifXml } from '../utils/onvifParser';
import { useSocket } from '../hooks/useSocket';

// ── Layout constants ──────────────────────────────────────────────────────────

const ROW_LABEL_W = 80;         // px – fixed label column
const ROW_H       = 28;         // px – each track row
const BAR_H       = 16;         // px – Gantt bar height
const BAR_TOP     = (ROW_H - BAR_H) / 2;
const TICK_H      = 20;         // px – tick labels row
const DETAIL_W    = 200;        // px – right split panel
const DRAG_THRESH = 4;          // px

// ── Range options ─────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { label: '1D', ms: 86_400_000 },
  { label: '1W', ms: 7 * 86_400_000 },
  { label: '1M', ms: 30 * 86_400_000 },
  { label: '1Y', ms: 365 * 86_400_000 },
] as const;
type RangeLabel = '1D' | '1W' | '1M' | '1Y' | 'custom';

// ── Severity styling ──────────────────────────────────────────────────────────

const SEV_BAR: Record<OnvifSeverity, string> = {
  info:     'bg-blue-600/90',
  warning:  'bg-amber-500/90',
  critical: 'bg-red-600/90',
};
const SEV_DOT: Record<OnvifSeverity, string> = {
  info:     'bg-blue-500',
  warning:  'bg-amber-400',
  critical: 'bg-red-500',
};
const SEV_TEXT: Record<OnvifSeverity, string> = {
  info:     'text-blue-300',
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
  startTs: number;
  endTs: number;        // = nowMs for in-progress
  isPoint: boolean;
  inProgress: boolean;
  durationMs: number;
  startEvt: OnvifEvent;
  endEvt: OnvifEvent | null;
}

interface OnvifRow {
  key: string;
  topicType: string;
  topicLabel: string;
  sourceToken: string | null;
  severity: OnvifSeverity;
  intervals: OnvifInterval[];
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props { cameraId: string; }
interface DragState { startX: number; startPan: number; }

// ── Component ─────────────────────────────────────────────────────────────────

export default function OnvifTimelineInline({ cameraId }: Props) {
  const { t }  = useI18n();
  const { socket } = useSocket();
  const { events, pushEvent, setEvents, types, setTypes, addType } = useOnvifEventStore();

  const [range, setRange]       = useState<RangeLabel>('1D');
  const [zoom, setZoom]         = useState(1);
  const [pan, setPan]           = useState(0);
  const [typeFilter, setTypeFilter] = useState('');
  const [selected, setSelected] = useState<OnvifInterval | null>(null);
  const [loading, setLoading]   = useState(false);
  const [showRaw, setShowRaw]   = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd,   setCustomEnd]   = useState('');
  const [customApplied, setCustomApplied] = useState<{ from: string; to: string } | null>(null);

  // Periodic tick so in-progress intervals update their duration display
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const containerRef  = useRef<HTMLDivElement>(null);
  const dragRef       = useRef<DragState | null>(null);
  const hasDraggedRef = useRef(false);

  // ── Viewport math ───────────────────────────────────────────────────────────
  const rangeMs = range === 'custom' && customApplied
    ? Math.max(1, new Date(customApplied.to).getTime() - new Date(customApplied.from).getTime())
    : (RANGE_OPTIONS.find(r => r.label === range)?.ms ?? 86_400_000);

  const viewRangeEnd = range === 'custom' && customApplied
    ? new Date(customApplied.to).getTime()
    : nowMs;

  const viewSpan  = rangeMs / zoom;
  const viewEnd   = viewRangeEnd - pan * rangeMs;
  const viewStart = viewEnd - viewSpan;

  // ── Fetch events on range/camera change ────────────────────────────────────
  useEffect(() => {
    if (range === 'custom' && !customApplied) return;
    setLoading(true);
    setSelected(null);
    const params = new URLSearchParams({ cameraId, limit: '1000' });
    if (range === 'custom' && customApplied) {
      params.set('from', customApplied.from);
      params.set('to',   customApplied.to);
    } else {
      params.set('from', new Date(Date.now() - rangeMs).toISOString());
    }
    fetch(`/api/onvif-events?${params}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.events)) setEvents(d.events); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cameraId, range, customApplied, rangeMs, setEvents]);

  // ── Fetch global type registry ──────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/onvif-event-types')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.types)) setTypes(d.types); })
      .catch(() => {});
  }, [setTypes]);

  // ── Live push via socket ────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onEvent = (evt: OnvifEvent) => { if (evt.cameraId === cameraId) pushEvent(evt); };
    const onType  = (t: OnvifEventType) => addType(t);
    socket.on('onvif:event', onEvent);
    socket.on('onvif:type-registered', onType);
    return () => { socket.off('onvif:event', onEvent); socket.off('onvif:type-registered', onType); };
  }, [socket, cameraId, pushEvent, addType]);

  // ── Fetch snapshot when interval is selected ────────────────────────────────
  useEffect(() => {
    if (!selected) { setSnapshot(null); return; }
    fetch(`/api/onvif-snapshots?eventId=${selected.id}&limit=1`)
      .then(r => r.json())
      .then(d => setSnapshot(d.snapshots?.[0]?.frameData ?? null))
      .catch(() => setSnapshot(null));
  }, [selected?.id]);

  // ── Zoom / pan helpers ──────────────────────────────────────────────────────
  const clampPan = useCallback((p: number, z: number) =>
    Math.max(0, Math.min(Math.max(0, 1 - 1 / z), p)), []);

  const applyZoom = useCallback((factor: number) =>
    setZoom(z => Math.max(1, Math.min(z * factor, 500))), []);

  const shiftPan = useCallback((delta: number) =>
    setPan(p => clampPan(p + delta, zoom)), [zoom, clampPan]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) applyZoom(1.4); else applyZoom(1 / 1.4);
  };

  useEffect(() => { if (zoom === 1) setPan(0); }, [zoom]);

  // ── Drag-to-pan ─────────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startPan: pan };
    hasDraggedRef.current = false;
    setIsDragging(false);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !containerRef.current) return;
    const dx    = e.clientX - dragRef.current.startX;
    const trackW = containerRef.current.getBoundingClientRect().width - ROW_LABEL_W;
    if (!hasDraggedRef.current && Math.abs(dx) < DRAG_THRESH) return;
    if (!hasDraggedRef.current) { hasDraggedRef.current = true; setIsDragging(true); }
    setPan(clampPan(dragRef.current.startPan + dx / trackW / zoom, zoom));
  };

  const stopDrag = () => { dragRef.current = null; setIsDragging(false); };

  // ── Build intervals + rows ──────────────────────────────────────────────────
  const { rows, totalCount } = useMemo(() => {
    const filtered = typeFilter
      ? events.filter(e => e.topicType === typeFilter)
      : events;
    const intervals = buildIntervals(filtered, nowMs);
    return { rows: buildRows(intervals), totalCount: filtered.length };
  }, [events, typeFilter, nowMs]);

  const visibleCount = useMemo(() =>
    rows.reduce((n, r) =>
      n + r.intervals.filter(iv => iv.endTs >= viewStart && iv.startTs <= viewEnd).length,
    0),
  [rows, viewStart, viewEnd]);

  // ── Tick labels ─────────────────────────────────────────────────────────────
  const ticks = useMemo(() =>
    [0, 0.25, 0.5, 0.75, 1].map(f => ({
      x: f,
      label: formatTick(viewStart + f * viewSpan, viewSpan),
    })),
  [viewStart, viewSpan]);

  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-grab';

  // ── Detail panel data ───────────────────────────────────────────────────────
  const selEvt     = selected?.startEvt ?? null;
  const parsed     = selEvt?.rawXml ? parseOnvifXml(selEvt.rawXml) : null;
  const dispItems  = parsed?.items ?? selEvt?.items ?? {};

  return (
    <div className="flex flex-col h-full text-[10px] select-none">

      {/* ── Control row ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/60
                      flex-shrink-0 bg-gray-900/60 flex-wrap">

        {/* Range buttons */}
        <div className="flex items-center gap-0.5">
          {RANGE_OPTIONS.map(({ label }) => (
            <button
              key={label}
              onClick={() => { setRange(label as RangeLabel); setZoom(1); setPan(0); }}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                range === label
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
              }`}
            >{label}</button>
          ))}
          <button
            onClick={() => { setRange('custom'); setZoom(1); setPan(0); }}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
              range === 'custom' ? 'bg-purple-600 text-white' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
            }`}
          >Custom</button>
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setSelected(null); }}
          className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                     text-gray-300 focus:outline-none focus:border-blue-500 cursor-pointer"
        >
          <option value="">All Types</option>
          {types.map(({ topicType, topicLabel }) => (
            <option key={topicType} value={topicType}>{topicLabel}</option>
          ))}
        </select>

        <div className="flex-1" />
        {zoom > 1 && (
          <span className="text-[9px] text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded">
            ×{zoom.toFixed(1)}
          </span>
        )}
        {loading && (
          <svg className="w-4 h-4 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        <span className="text-gray-600">{visibleCount}/{totalCount}</span>
      </div>

      {/* ── Custom date picker row ────────────────────────────────────────────── */}
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
                       text-white rounded text-[9px] font-bold transition-colors"
          >Apply</button>
          {customApplied && (
            <button onClick={() => { setCustomApplied(null); setCustomStart(''); setCustomEnd(''); }}
                    className="text-gray-500 hover:text-gray-300 text-[9px] transition-colors" title="Clear">✕</button>
          )}
        </div>
      )}

      {/* ── Main split area ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Track area ───────────────────────────────────────────────────────── */}
        <div
          ref={containerRef}
          className={`flex-1 flex flex-col overflow-hidden ${cursorClass}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
          onClick={() => { if (!hasDraggedRef.current) setSelected(null); }}
        >
          {/* Scrollable rows */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">

            {/* Empty state */}
            {!loading && rows.length === 0 && (
              <div className="flex items-center justify-center h-full pointer-events-none">
                <span className="text-gray-600">{t.onvifTimelineEmpty}</span>
              </div>
            )}

            {/* Track rows */}
            {rows.map((row, rowIdx) => (
              <div key={row.key} className="flex relative" style={{ height: ROW_H }}>

                {/* Label column */}
                <div
                  className="flex-shrink-0 flex items-center px-1.5 border-r border-gray-700/60 overflow-hidden"
                  style={{ width: ROW_LABEL_W }}
                >
                  <span className={`text-[8px] truncate ${SEV_TEXT[row.severity] ?? 'text-gray-400'}`}
                        title={row.topicLabel}>
                    {row.topicLabel}
                  </span>
                </div>

                {/* Track canvas */}
                <div className="flex-1 relative overflow-hidden" style={{ height: ROW_H }}>

                  {/* Alternating row bg */}
                  {rowIdx % 2 === 1 && (
                    <div className="absolute inset-0 bg-white/[0.025] pointer-events-none" />
                  )}

                  {/* Tick grid lines */}
                  {[0.25, 0.5, 0.75].map(f => (
                    <div key={f} className="absolute top-0 bottom-0 w-px bg-gray-700/40 pointer-events-none"
                         style={{ left: `${f * 100}%` }} />
                  ))}

                  {/* Intervals */}
                  {row.intervals
                    .filter(iv => iv.endTs >= viewStart && iv.startTs <= viewEnd)
                    .map(iv => {
                      const isSel = selected?.id === iv.id;

                      if (iv.isPoint) {
                        const x = (iv.startTs - viewStart) / viewSpan;
                        if (x < -0.01 || x > 1.01) return null;
                        return (
                          <button
                            key={iv.id}
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => {
                              e.stopPropagation();
                              if (!hasDraggedRef.current)
                                setSelected(sel => sel?.id === iv.id ? null : iv);
                            }}
                            className={`absolute w-3 h-3 ${SEV_DOT[iv.severity]} hover:scale-125
                                        transition-transform cursor-pointer
                                        ${isSel ? 'ring-1 ring-white scale-125' : 'opacity-90'}`}
                            style={{
                              left: `${x * 100}%`,
                              top: BAR_TOP,
                              height: BAR_H,
                              width: 8,
                              transform: 'translateX(-50%) rotate(45deg)',
                            }}
                            title={`${iv.topicLabel} — ${new Date(iv.startTs).toLocaleTimeString()}`}
                          />
                        );
                      }

                      // Gantt bar
                      const barL = Math.max(0, (iv.startTs - viewStart) / viewSpan);
                      const barR = Math.min(1, (iv.endTs - viewStart) / viewSpan);
                      const barW = Math.max(0.003, barR - barL);
                      const dur  = iv.inProgress ? fmtDur(nowMs - iv.startTs) : fmtDur(iv.durationMs);

                      return (
                        <button
                          key={iv.id}
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => {
                            e.stopPropagation();
                            if (!hasDraggedRef.current)
                              setSelected(sel => sel?.id === iv.id ? null : iv);
                            setShowRaw(false);
                          }}
                          className={`absolute flex items-center px-1 overflow-hidden rounded-sm
                                      ${SEV_BAR[iv.severity]} text-white text-[8px] cursor-pointer
                                      transition-opacity hover:opacity-100
                                      ${isSel ? 'ring-1 ring-white opacity-100' : 'opacity-80'}`}
                          style={{
                            left: `${barL * 100}%`,
                            width: `${barW * 100}%`,
                            top: BAR_TOP,
                            height: BAR_H,
                            borderRight: iv.inProgress ? '2px dashed rgba(255,255,255,0.5)' : undefined,
                          }}
                          title={`${iv.topicLabel}${iv.inProgress ? ' (in progress)' : ''} — ${dur}`}
                        >
                          <span className="truncate leading-none">{iv.inProgress ? '↦ ' : ''}{dur}</span>
                        </button>
                      );
                    })
                  }
                </div>
              </div>
            ))}
          </div>

          {/* Tick labels row (sticky bottom) */}
          <div className="flex-shrink-0 flex border-t border-gray-700/40 bg-gray-950/80"
               style={{ height: TICK_H }}>
            <div className="flex-shrink-0 border-r border-gray-700/60" style={{ width: ROW_LABEL_W }} />
            <div className="flex-1 relative">
              {ticks.map(({ x, label }) => (
                <div key={x}
                     className="absolute flex flex-col items-center pointer-events-none"
                     style={{ left: `${x * 100}%` }}>
                  <div className="w-px h-2 bg-gray-600" />
                  <span className="text-[8px] text-gray-500 whitespace-nowrap mt-0.5">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Detail panel ─────────────────────────────────────────────────────── */}
        {selected && (
          <div className="flex flex-col flex-shrink-0 border-l border-gray-700 bg-gray-900/80 overflow-hidden"
               style={{ width: DETAIL_W }}>

            {/* Header */}
            <div className="flex items-center justify-between px-2 py-1.5
                            border-b border-gray-700/60 bg-gray-800/80 flex-shrink-0">
              <div className="flex items-center gap-1 min-w-0">
                <span className={`text-[9px] font-bold truncate ${SEV_TEXT[selected.severity]}`}>
                  {selected.topicLabel}
                </span>
              </div>
              <button onClick={() => setSelected(null)}
                      className="text-gray-500 hover:text-white flex-shrink-0 ml-1 text-[11px]">✕</button>
            </div>

            {/* Parsed / Raw toggle */}
            {selEvt?.rawXml && (
              <div className="flex border-b border-gray-700/60 flex-shrink-0">
                <button onClick={() => setShowRaw(false)}
                        className={`flex-1 py-0.5 text-[9px] font-bold ${!showRaw ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                  Parsed
                </button>
                <button onClick={() => setShowRaw(true)}
                        className={`flex-1 py-0.5 text-[9px] font-bold ${showRaw ? 'bg-green-900/50 text-green-300' : 'text-gray-500 hover:text-gray-300'}`}>
                  Raw XML
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {showRaw ? (
                <pre className="px-2 py-1 text-[8px] text-green-400 whitespace-pre-wrap break-all leading-tight">
                  {selEvt?.rawXml}
                </pre>
              ) : (
                <div className="px-2 py-1 space-y-0.5">
                  {/* Interval timing */}
                  <DetailRow label="Start" value={new Date(selected.startTs).toLocaleString()} />
                  <DetailRow
                    label="End"
                    value={selected.inProgress ? '● In Progress' : new Date(selected.endTs).toLocaleString()}
                    highlight={selected.inProgress}
                  />
                  <DetailRow label="Dur" value={selected.inProgress ? fmtDur(nowMs - selected.startTs) : fmtDur(selected.durationMs)} />
                  {selected.sourceToken && <DetailRow label="Source" value={selected.sourceToken} />}
                  {selEvt?.operation && <DetailRow label="Op" value={selEvt.operation} />}
                  {Object.entries(dispItems)
                    .filter(([k]) => !['SourceToken', 'State'].includes(k))
                    .map(([k, v]) => <DetailRow key={k} label={k} value={String(v)} />)
                  }
                  <div className="pt-0.5 border-t border-gray-700/40">
                    <DetailRow label="Topic" value={selEvt?.topic ?? ''} mono />
                  </div>

                  {/* Snapshot */}
                  {snapshot && (
                    <div className="pt-1">
                      <div className="text-[8px] text-gray-500 mb-1">Frame at event start</div>
                      <img src={snapshot} alt="onvif-snap"
                           className="w-full rounded border border-gray-600/40 object-contain" />
                    </div>
                  )}
                  {!snapshot && !selected.inProgress && (
                    <div className="text-[8px] text-gray-600 italic pt-1">No frame snapshot</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Pan bar (zoom > 1 only) ───────────────────────────────────────────── */}
      {zoom > 1 && (
        <div className="flex items-center gap-1 px-2 py-0.5 border-t border-gray-700/40
                        bg-gray-900/40 flex-shrink-0">
          <button onClick={() => shiftPan(-0.1 / zoom)}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-[9px]">◀</button>
          <div className="flex-1 h-1 bg-gray-700 rounded-full relative">
            <div className="absolute h-full bg-blue-500 rounded-full"
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

function mkPoint(evt: OnvifEvent): OnvifInterval {
  const tsMs = new Date(evt.serverTs).getTime();
  return {
    id: evt.id, cameraId: evt.cameraId, topicType: evt.topicType,
    topicLabel: evt.topicLabel, severity: evt.severity, sourceToken: evt.sourceToken,
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
    const key = `${evt.cameraId}:${evt.topicType}:${evt.sourceToken ?? ''}`;

    if (evt.state === 'true') {
      if (open.has(key)) {
        // Consecutive start without end (server-restart artifact or camera re-trigger
        // while still active). Coalesce: keep the original start time, ignore this event.
        continue;
      }
      const tsMs = new Date(evt.serverTs).getTime();
      open.set(key, {
        id: evt.id, cameraId: evt.cameraId, topicType: evt.topicType,
        topicLabel: evt.topicLabel, severity: evt.severity, sourceToken: evt.sourceToken,
        startTs: tsMs, endTs: nowMs, isPoint: false, inProgress: true,
        durationMs: nowMs - tsMs, startEvt: evt, endEvt: null,
      });
    } else if (evt.state === 'false') {
      const interval = open.get(key);
      if (interval) {
        const endTs = new Date(evt.serverTs).getTime();
        interval.endTs = endTs;
        interval.inProgress = false;
        interval.durationMs = endTs - interval.startTs;
        interval.endEvt = evt;
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
    const key = `${iv.topicType}:${iv.sourceToken ?? ''}`;
    if (!rowMap.has(key)) {
      const label = iv.topicLabel + (iv.sourceToken ? ` (${iv.sourceToken})` : '');
      rowMap.set(key, { key, topicType: iv.topicType, topicLabel: label, sourceToken: iv.sourceToken, severity: iv.severity, intervals: [] });
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
