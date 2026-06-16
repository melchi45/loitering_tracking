/**
 * OnvifTimelineInline — compact ONVIF timeline embedded in FullscreenCameraView.
 *
 * Layout (horizontal split):
 *   ┌──────────────────────────────────────────────────┐
 *   │ [1D][1W][1M][1Y]  [Type ▾]     ×2.0   5/12      │ ← control row
 *   ├─────────────────────────┬────────────────────────┤
 *   │  timeline canvas        │  event detail (split)  │
 *   │  (flex-1, draggable)    │  (192px fixed)         │
 *   ├─────────────────────────┴────────────────────────┤
 *   │  ◀ ━━━━━━━━━━━━ ▶  ✕     (zoom > 1 only)        │
 *   └──────────────────────────────────────────────────┘
 *
 * Zoom:  scroll-wheel on canvas
 * Pan:   click-and-drag on canvas
 *          drag ← → pan decreases → newest events revealed at right
 *          drag → → pan increases → older events revealed at left
 *        ◀ ▶ buttons
 * Filter: Event Type combobox (from global onvif_event_types registry — persists across ranges)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useOnvifEventStore, type OnvifEvent, type OnvifEventType, type OnvifSeverity } from '../stores/onvifEventStore';
import { parseOnvifXml } from '../utils/onvifParser';
import { useSocket } from '../hooks/useSocket';

// ── Constants ─────────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { label: '1D', ms: 24 * 60 * 60 * 1000 },
  { label: '1W', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '1M', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: '1Y', ms: 365 * 24 * 60 * 60 * 1000 },
] as const;
type RangeLabel = '1D' | '1W' | '1M' | '1Y' | 'custom';

const SEVERITY_BG: Record<OnvifSeverity, string> = {
  info:     'bg-blue-500',
  warning:  'bg-yellow-500',
  critical: 'bg-red-600',
};
const SEVERITY_TEXT: Record<OnvifSeverity, string> = {
  info:     'text-blue-300',
  warning:  'text-yellow-300',
  critical: 'text-red-400',
};

const SEVERITY_ICON: Record<string, string> = {
  callRequest:  '📞',
  motionAlarm:  '🚶',
  lineCrossed:  '🚧',
  fieldEntered: '⬛',
  fieldExited:  '⬜',
  fire:         '🔥',
  smoke:        '💨',
  unknown:      '●',
};

const DRAG_THRESHOLD_PX = 4;
const DETAIL_PANEL_W    = 192; // px

// ── Props / internal types ────────────────────────────────────────────────────

interface Props { cameraId: string; }

interface DragState { startX: number; startPan: number; }

// ── Component ─────────────────────────────────────────────────────────────────

export default function OnvifTimelineInline({ cameraId }: Props) {
  const { t }  = useI18n();
  const { socket } = useSocket();
  const { events, pushEvent, setEvents, types, setTypes, addType } = useOnvifEventStore();

  const [range, setRange]         = useState<RangeLabel>('1D');
  const [zoom, setZoom]           = useState(1);
  const [pan, setPan]             = useState(0);
  const [typeFilter, setTypeFilter] = useState('');   // '' = all types
  const [selected, setSelected]   = useState<OnvifEvent | null>(null);
  const [loading, setLoading]     = useState(false);
  const [showRaw, setShowRaw]     = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd,   setCustomEnd]   = useState('');
  const [customApplied, setCustomApplied] = useState<{ from: string; to: string } | null>(null);

  const containerRef  = useRef<HTMLDivElement>(null);
  const dragRef       = useRef<DragState | null>(null);
  const hasDraggedRef = useRef(false);

  const rangeMs = range === 'custom' && customApplied
    ? Math.max(1, new Date(customApplied.to).getTime() - new Date(customApplied.from).getTime())
    : (RANGE_OPTIONS.find(r => r.label === range)?.ms ?? 86400_000);

  // End anchor for viewport: custom range ends at customApplied.to; others end at now
  const viewRangeEnd = range === 'custom' && customApplied
    ? new Date(customApplied.to).getTime()
    : Date.now();

  // ── Fetch on range / camera change ─────────────────────────────────────────
  useEffect(() => {
    if (range === 'custom' && !customApplied) return; // wait for Apply
    setLoading(true);
    setSelected(null);
    const params = new URLSearchParams({ cameraId, limit: '1000' });
    if (range === 'custom' && customApplied) {
      params.set('from', customApplied.from);
      params.set('to',   customApplied.to);
    } else {
      const ms = RANGE_OPTIONS.find(r => r.label === range)?.ms ?? 86400_000;
      params.set('from', new Date(Date.now() - ms).toISOString());
    }
    fetch(`/api/onvif-events?${params}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.events)) setEvents(d.events); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cameraId, range, customApplied, setEvents]);

  // ── Fetch global event type registry (once on mount) ───────────────────────
  useEffect(() => {
    fetch('/api/onvif-event-types')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.types)) setTypes(d.types); })
      .catch(() => {});
  }, [setTypes]);

  // ── Live push ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onEvent = (evt: OnvifEvent) => {
      if (evt.cameraId !== cameraId) return;
      pushEvent(evt);
    };
    const onTypeRegistered = (type: OnvifEventType) => { addType(type); };
    socket.on('onvif:event', onEvent);
    socket.on('onvif:type-registered', onTypeRegistered);
    return () => {
      socket.off('onvif:event', onEvent);
      socket.off('onvif:type-registered', onTypeRegistered);
    };
  }, [socket, cameraId, pushEvent, addType]);

  // ── Zoom helpers ────────────────────────────────────────────────────────────
  const applyZoom = useCallback((factor: number) => {
    setZoom(z => Math.max(1, Math.min(z * factor, 500)));
  }, []);

  const clampPan = useCallback((p: number, z: number) =>
    Math.max(0, Math.min(Math.max(0, 1 - 1 / z), p)),
  []);

  const shiftPan = useCallback((delta: number) => {
    setPan(p => clampPan(p + delta, zoom));
  }, [zoom, clampPan]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) applyZoom(1.4);
    else              applyZoom(1 / 1.4);
  };

  useEffect(() => { if (zoom === 1) setPan(0); }, [zoom]);

  // ── Drag-to-pan ─────────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current       = { startX: e.clientX, startPan: pan };
    hasDraggedRef.current = false;
    setIsDragging(false);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !containerRef.current) return;
    const dx    = e.clientX - dragRef.current.startX;
    const width = containerRef.current.getBoundingClientRect().width;
    if (!hasDraggedRef.current && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!hasDraggedRef.current) {
      hasDraggedRef.current = true;
      setIsDragging(true);
    }
    // drag ← (dx<0) → pan decreases → newer events visible
    setPan(clampPan(dragRef.current.startPan + dx / width / zoom, zoom));
  };

  const stopDrag = () => {
    dragRef.current = null;
    setIsDragging(false);
  };

  // ── Viewport ────────────────────────────────────────────────────────────────
  const viewSpan  = rangeMs / zoom;
  const viewEnd   = viewRangeEnd - pan * rangeMs;
  const viewStart = viewEnd - viewSpan;

  // ── Event type options — from global registry, not derived from current events ─
  // This ensures all ever-seen types appear even when outside the current range.
  const typeOptions = types; // OnvifEventType[] sorted by topicLabel (server/store ensures this)

  // ── Filtered + positioned events ────────────────────────────────────────────
  const items = useMemo(() => {
    return events
      .filter(e => {
        const ts = new Date(e.serverTs).getTime();
        if (ts < viewStart || ts > viewEnd) return false;
        if (typeFilter && e.topicType !== typeFilter) return false;
        return true;
      })
      .map(e => ({
        evt: e,
        x: (new Date(e.serverTs).getTime() - viewStart) / viewSpan,
      }));
  }, [events, viewStart, viewEnd, viewSpan, typeFilter]);

  const totalFiltered = useMemo(() =>
    typeFilter ? events.filter(e => e.topicType === typeFilter).length : events.length,
  [events, typeFilter]);

  // Tick labels
  const ticks = useMemo(() =>
    [0, 0.25, 0.5, 0.75, 1].map(f => ({
      x: f,
      label: formatTick(viewStart + f * viewSpan, viewSpan),
    })),
    [viewStart, viewSpan],
  );

  // ── Detail panel data ───────────────────────────────────────────────────────
  const parsed       = selected?.rawXml ? parseOnvifXml(selected.rawXml) : null;
  const displayItems = parsed?.items ?? selected?.items ?? {};

  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-grab';

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
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => { setRange('custom'); setZoom(1); setPan(0); }}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
              range === 'custom'
                ? 'bg-purple-600 text-white'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
            }`}
          >
            Custom
          </button>
        </div>

        {/* Event Type combobox */}
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setSelected(null); }}
          className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                     text-gray-300 focus:outline-none focus:border-blue-500 cursor-pointer"
          title="Filter by event type"
        >
          <option value="">All Types</option>
          {typeOptions.map(({ topicType, topicLabel }) => (
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
        <span className="text-gray-600">{items.length}/{totalFiltered}</span>
      </div>

      {/* ── Custom date picker row (shown when Custom is selected) ──────────── */}
      {range === 'custom' && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/40
                        flex-shrink-0 bg-gray-900/40 flex-wrap">
          <span className="text-gray-500 text-[9px]">From</span>
          <input
            type="datetime-local"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                       text-gray-300 focus:outline-none focus:border-purple-500"
          />
          <span className="text-gray-500 text-[9px]">To</span>
          <input
            type="datetime-local"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                       text-gray-300 focus:outline-none focus:border-purple-500"
          />
          <button
            onClick={() => {
              if (!customStart || !customEnd) return;
              setCustomApplied({ from: new Date(customStart).toISOString(), to: new Date(customEnd).toISOString() });
              setZoom(1); setPan(0);
            }}
            disabled={!customStart || !customEnd}
            className="px-2 py-0.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-40
                       text-white rounded text-[9px] font-bold transition-colors"
          >
            Apply
          </button>
          {customApplied && (
            <button
              onClick={() => { setCustomApplied(null); setCustomStart(''); setCustomEnd(''); }}
              className="text-gray-500 hover:text-gray-300 text-[9px] transition-colors"
              title="Clear custom range"
            >✕</button>
          )}
        </div>
      )}

      {/* ── Main split area ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left: timeline canvas */}
        <div
          ref={containerRef}
          className={`flex-1 relative min-h-0 overflow-hidden ${cursorClass}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
        >
          {/* Baseline */}
          <div className="absolute left-0 right-0 bg-gray-700 pointer-events-none"
               style={{ top: '50%', height: 1 }} />

          {/* Tick labels */}
          {ticks.map(({ x, label }) => (
            <div
              key={x}
              className="absolute flex flex-col items-center pointer-events-none"
              style={{ left: `${x * 100}%`, top: 'calc(50% + 2px)', transform: 'translateX(-50%)' }}
            >
              <div className="w-px h-2 bg-gray-600" />
              <span className="text-[8px] text-gray-600 whitespace-nowrap mt-0.5">{label}</span>
            </div>
          ))}

          {/* Event icons */}
          {items.map(({ evt, x }) => {
            const isSel = selected?.id === evt.id;
            const icon  = SEVERITY_ICON[evt.topicType] ?? SEVERITY_ICON.unknown;
            const bg    = SEVERITY_BG[evt.severity] ?? 'bg-blue-500';
            return (
              <div
                key={evt.id}
                className="absolute"
                style={{ left: `${x * 100}%`, top: '50%', transform: 'translate(-50%, -100%) translateY(-4px)' }}
              >
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasDraggedRef.current) return;
                    setSelected(prev => prev?.id === evt.id ? null : evt);
                    setShowRaw(false);
                  }}
                  className={`w-5 h-5 rounded-full ${bg} border border-white/20
                              flex items-center justify-center text-[9px]
                              transition-transform hover:scale-125 shadow cursor-pointer
                              ${isSel ? 'scale-125 ring-2 ring-white' : ''}`}
                  title={`${evt.topicLabel} — ${new Date(evt.serverTs).toLocaleString()}`}
                >
                  {icon}
                </button>
              </div>
            );
          })}

          {/* Empty state */}
          {!loading && items.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-gray-600">{t.onvifTimelineEmpty}</span>
            </div>
          )}

          {/* Background click = deselect */}
          <div
            className="absolute inset-0 -z-10"
            onClick={() => { if (!hasDraggedRef.current) setSelected(null); }}
          />
        </div>

        {/* Right: event detail panel — only rendered when an event is selected */}
        {selected && (
          <div
            className="flex flex-col flex-shrink-0 border-l border-gray-700 bg-gray-900/80 overflow-hidden"
            style={{ width: DETAIL_PANEL_W }}
          >
            {/* Detail header */}
            <div className="flex items-center justify-between px-2 py-1.5
                            border-b border-gray-700/60 bg-gray-800/80 flex-shrink-0">
              <div className="flex items-center gap-1 min-w-0">
                <span className={`text-[9px] ${SEVERITY_TEXT[selected.severity] ?? 'text-gray-300'}`}>
                  {SEVERITY_ICON[selected.topicType] ?? '●'}
                </span>
                <span className="font-semibold text-white text-[10px] truncate">
                  {selected.topicLabel}
                </span>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-gray-500 hover:text-white flex-shrink-0 ml-1 text-[11px]"
              >✕</button>
            </div>

            {/* Parsed / Raw toggle */}
            {selected.rawXml && (
              <div className="flex border-b border-gray-700/60 flex-shrink-0">
                <button
                  onClick={() => setShowRaw(false)}
                  className={`flex-1 py-0.5 text-[9px] font-bold transition-colors ${
                    !showRaw ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >Parsed</button>
                <button
                  onClick={() => setShowRaw(true)}
                  className={`flex-1 py-0.5 text-[9px] font-bold transition-colors ${
                    showRaw ? 'bg-green-900/50 text-green-300' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >Raw XML</button>
              </div>
            )}

            {/* Detail content */}
            <div className="flex-1 overflow-y-auto">
              {showRaw ? (
                <pre className="px-2 py-1 text-[8px] text-green-400 whitespace-pre-wrap
                                break-all leading-tight">
                  {selected.rawXml}
                </pre>
              ) : (
                <div className="px-2 py-1 space-y-1">
                  <DetailRow label="Time"   value={new Date(selected.utcTime).toLocaleString()} />
                  <DetailRow label="Op"     value={selected.operation} />
                  {selected.sourceToken && <DetailRow label="Source" value={selected.sourceToken} />}
                  {selected.state       && (
                    <DetailRow
                      label="State"
                      value={selected.state}
                      highlight={selected.state === 'true'}
                    />
                  )}
                  {Object.entries(displayItems)
                    .filter(([k]) => !['SourceToken', 'State'].includes(k))
                    .map(([k, v]) => <DetailRow key={k} label={k} value={String(v)} />)}
                  <div className="pt-1 border-t border-gray-700/40">
                    <DetailRow label="Topic" value={selected.topic} mono />
                  </div>
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
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-[9px]">
            ◀
          </button>
          <div className="flex-1 h-1 bg-gray-700 rounded-full relative">
            <div
              className="absolute h-full bg-blue-500 rounded-full"
              style={{ left: `${pan * zoom * 100}%`, width: `${(1 / zoom) * 100}%` }}
            />
          </div>
          <button onClick={() => shiftPan(0.1 / zoom)}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded text-[9px]">
            ▶
          </button>
          <button onClick={() => { setZoom(1); setPan(0); }}
                  className="px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-500 rounded text-[9px]">
            ✕
          </button>
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
      <span className="text-gray-500 flex-shrink-0 w-12 truncate">{label}</span>
      <span className={`break-all ${mono ? 'font-mono text-gray-400' : ''} ${highlight ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
        {value}
      </span>
    </div>
  );
}

// ── Tick label format ────────────────────────────────────────────────────────

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
