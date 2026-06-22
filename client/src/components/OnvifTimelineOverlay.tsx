/**
 * OnvifTimelineOverlay — full-screen ONVIF event timeline.
 *
 * Rendering:
 *   - state=true/false pairs → horizontal Gantt bars (one row per topicType:sourceToken)
 *   - in-progress → dashed-right bar
 *   - no-state events → diamond point markers
 *
 * Controls: scroll=zoom, ↑↓ keyboard=zoom, ←→=pan, Esc=close.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, WheelEvent } from 'react';
import { useI18n } from '../i18n';
import { useOnvifEventStore, type OnvifEvent, type OnvifEventType, type OnvifSeverity } from '../stores/onvifEventStore';
import { parseOnvifXml } from '../utils/onvifParser';
import { useSocket } from '../hooks/useSocket';

// ── Layout ────────────────────────────────────────────────────────────────────

const ROW_LABEL_W = 130;
const ROW_H       = 68;   // bar (22px) + snap strip (36px) + separator
const BAR_H       = 22;
const BAR_TOP     = 6;
const SNAP_H      = 36;
const SNAP_W      = 56;
const SNAP_TOP    = BAR_TOP + BAR_H + 4;
const TICK_H      = 28;
const DETAIL_W    = 300;

const RANGE_OPTIONS = [
  { label: '1D', ms: 86_400_000 },
  { label: '1W', ms: 7 * 86_400_000 },
  { label: '1M', ms: 30 * 86_400_000 },
  { label: '1Y', ms: 365 * 86_400_000 },
] as const;
type RangeLabel = '1D' | '1W' | '1M' | '1Y';

// ── Severity styling ──────────────────────────────────────────────────────────

const SEV_COLOR: Record<OnvifSeverity, string> = {
  info:     '#3b82f6',
  warning:  '#f59e0b',
  critical: '#ef4444',
};
const SEV_TEXT: Record<OnvifSeverity, string> = {
  info:     'text-blue-300',
  warning:  'text-amber-300',
  critical: 'text-red-400',
};
const SEV_BADGE: Record<OnvifSeverity, string> = {
  info:     'bg-blue-500 text-white',
  warning:  'bg-amber-500 text-gray-900',
  critical: 'bg-red-600 text-white',
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
  endTs: number;
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

interface Props {
  cameraId?: string;
  onClose: () => void;
}

// ── Hook: fetch + live ─────────────────────────────────────────────────────────

function useOnvifEvents(cameraId: string | undefined, rangeMs: number) {
  const { pushEvent, setEvents, events, setTypes, addType, types } = useOnvifEventStore();
  const { socket } = useSocket();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      from: new Date(Date.now() - rangeMs).toISOString(),
      limit: '2000',
    });
    if (cameraId) params.set('cameraId', cameraId);
    fetch(`/api/onvif-events?${params}`)
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d.events)) return;
        setEvents(d.events as OnvifEvent[]);
        // Defensive backfill: register any topicType present in events but missing
        // from the global registry (e.g. events stored before the registry feature).
        const seen = new Set<string>();
        for (const evt of d.events as OnvifEvent[]) {
          if (!evt.topicType || seen.has(evt.topicType)) continue;
          seen.add(evt.topicType);
          addType({
            id: evt.topicType, topicType: evt.topicType,
            topicLabel: evt.topicLabel, topic: evt.topic,
            severity: evt.severity, firstSeenAt: evt.serverTs,
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cameraId, rangeMs, setEvents, addType]);

  useEffect(() => {
    fetch('/api/onvif-event-types')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.types)) setTypes(d.types as OnvifEventType[]); })
      .catch(() => {});
  }, [setTypes]);

  useEffect(() => {
    if (!socket) return;
    const onEvent = (evt: OnvifEvent) => { if (!cameraId || evt.cameraId === cameraId) pushEvent(evt); };
    const onType  = (t: OnvifEventType) => addType(t);
    socket.on('onvif:event', onEvent);
    socket.on('onvif:type-registered', onType);
    return () => { socket.off('onvif:event', onEvent); socket.off('onvif:type-registered', onType); };
  }, [socket, cameraId, pushEvent, addType]);

  return { events, types, loading };
}

// ── Main overlay ──────────────────────────────────────────────────────────────

export default function OnvifTimelineOverlay({ cameraId, onClose }: Props) {
  const { t } = useI18n();

  const [range, setRange]           = useState<RangeLabel>('1D');
  const [zoomLevel, setZoomLevel]   = useState(1);
  const [panFraction, setPan]       = useState(0);
  const [selected, setSelected]         = useState<OnvifInterval | null>(null);
  const [selectedType, setSelectedType] = useState('');
  const [showRaw, setShowRaw]           = useState(false);
  const [snapCache, setSnapCache]       = useState<Map<string, string>>(new Map());
  const fetchedRef = useRef<Set<string>>(new Set());

  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const rangeMs = RANGE_OPTIONS.find(r => r.label === range)!.ms;
  const { events, types, loading } = useOnvifEvents(cameraId, rangeMs);

  // Clear snap cache on range/camera change
  useEffect(() => {
    fetchedRef.current.clear();
    setSnapCache(new Map());
  }, [cameraId, rangeMs]);

  // ── Viewport ────────────────────────────────────────────────────────────────
  const viewSpan  = rangeMs / zoomLevel;
  const viewEnd   = nowMs - panFraction * rangeMs;
  const viewStart = viewEnd - viewSpan;

  // ── Zoom / pan ──────────────────────────────────────────────────────────────
  const handleZoom = useCallback((factor: number) =>
    setZoomLevel(z => Math.max(1, Math.min(z * factor, 1000))), []);

  const shiftPan = useCallback((delta: number) =>
    setPan(p => Math.max(0, Math.min(1 - 1 / zoomLevel, p + delta))), [zoomLevel]);

  const handleWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.deltaY < 0) handleZoom(1.3); else handleZoom(1 / 1.3);
  };

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape')      { onClose(); return; }
      if (e.key === 'ArrowUp')     { e.preventDefault(); handleZoom(1.5); }
      if (e.key === 'ArrowDown')   { e.preventDefault(); handleZoom(1 / 1.5); }
      if (e.key === 'ArrowLeft')   { e.preventDefault(); shiftPan(-0.1 / zoomLevel); }
      if (e.key === 'ArrowRight')  { e.preventDefault(); shiftPan(0.1 / zoomLevel); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomLevel, onClose]);

  // ── Build intervals + rows ──────────────────────────────────────────────────
  const { rows, totalCount } = useMemo(() => {
    const filtered = selectedType ? events.filter(e => e.topicType === selectedType) : events;
    const intervals = buildIntervals(filtered, nowMs);
    return { rows: buildRows(intervals), totalCount: filtered.length };
  }, [events, selectedType, nowMs]);

  const visibleCount = useMemo(() =>
    rows.reduce((n, r) =>
      n + r.intervals.filter(iv => iv.endTs >= viewStart && iv.startTs <= viewEnd).length, 0),
  [rows, viewStart, viewEnd]);

  // ── Lazy-fetch inline snaps for visible intervals ────────────────────────────
  useEffect(() => {
    const visibleBars = rows.flatMap(r =>
      r.intervals.filter(iv => !iv.isPoint && iv.endTs >= viewStart && iv.startTs <= viewEnd)
    );
    const toFetch = visibleBars.filter(iv => !fetchedRef.current.has(iv.id));
    if (toFetch.length === 0) return;
    toFetch.forEach(iv => {
      fetchedRef.current.add(iv.id);
      fetch(`/api/onvif-snapshots?eventId=${iv.id}&limit=1`)
        .then(r => r.json())
        .then(d => {
          const fd = (d.snapshots?.[0]?.frameData as string | undefined) ?? '';
          if (fd) setSnapCache(prev => { const m = new Map(prev); m.set(iv.id, fd); return m; });
        })
        .catch(() => {});
    });
  }, [rows, viewStart, viewEnd]);

  // ── Ticks ───────────────────────────────────────────────────────────────────
  const ticks = useMemo(() =>
    [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1].map(f => ({
      x: f,
      label: formatTick(viewStart + f * viewSpan, viewSpan),
    })),
  [viewStart, viewSpan]);

  // ── Detail panel data ───────────────────────────────────────────────────────
  const selEvt    = selected?.startEvt ?? null;
  const parsed    = selEvt?.rawXml ? parseOnvifXml(selEvt.rawXml) : null;
  const dispItems = parsed?.items ?? selEvt?.items ?? {};
  const selSnap   = selected ? (snapCache.get(selected.id) ?? null) : null;

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-gray-950/95 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 bg-gray-900 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white tracking-wide">{t.onvifTimelineTitle}</span>
          {cameraId && (
            <span className="text-[10px] text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
              {cameraId.slice(0, 8)}
            </span>
          )}
          {loading && <span className="text-[10px] text-blue-400 animate-pulse">Loading…</span>}
        </div>

        <div className="flex items-center gap-2">
          {/* Range buttons */}
          <div className="flex items-center gap-1">
            {RANGE_OPTIONS.map(({ label }) => (
              <button
                key={label}
                onClick={() => { setRange(label as RangeLabel); setZoomLevel(1); setPan(0); }}
                className={`px-3 py-1 text-[11px] font-bold rounded transition-colors ${
                  range === label ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >{label}</button>
            ))}
          </div>

          {/* Type filter */}
          <select
            value={selectedType}
            onChange={e => { setSelectedType(e.target.value); setSelected(null); }}
            className="text-[11px] bg-gray-800 text-gray-300 border border-gray-600
                       rounded px-2 py-1 hover:border-gray-400 focus:outline-none
                       focus:border-blue-500 transition-colors"
          >
            <option value="">All Types</option>
            {types.map(tt => (
              <option key={tt.topicType} value={tt.topicType}>{tt.topicLabel || tt.topicType}</option>
            ))}
          </select>

          {zoomLevel > 1 && (
            <span className="text-[11px] text-blue-400 bg-blue-900/30 px-2 py-0.5 rounded">
              ×{zoomLevel.toFixed(1)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <span className="text-[10px] text-gray-500 hidden sm:block">{t.onvifTimelineHint}</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1.5 rounded hover:bg-gray-700 transition-colors"
            title="Close (Esc)"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Body: tracks + detail panel ─────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Track area */}
        <div
          ref={containerRef}
          className="flex-1 flex flex-col overflow-hidden cursor-crosshair select-none"
          onWheel={handleWheel}
          onClick={() => setSelected(null)}
        >
          {/* Scrollable rows */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">

            {/* Empty state */}
            {!loading && rows.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <span className="text-gray-600 text-sm">{t.onvifTimelineEmpty}</span>
              </div>
            )}

            {/* Track rows */}
            {rows.map((row, rowIdx) => (
              <div key={row.key} className="flex relative" style={{ height: ROW_H }}>

                {/* Label */}
                <div
                  className="flex-shrink-0 flex items-center px-3 border-r border-gray-700/60 overflow-hidden"
                  style={{ width: ROW_LABEL_W }}
                >
                  <div className="flex flex-col min-w-0">
                    <span className={`text-[11px] font-semibold truncate ${SEV_TEXT[row.severity]}`}
                          title={row.topicLabel}>
                      {row.topicLabel}
                    </span>
                    {row.sourceToken && (
                      <span className="text-[9px] text-gray-500 truncate">{row.sourceToken}</span>
                    )}
                  </div>
                </div>

                {/* Track canvas */}
                <div className="flex-1 relative overflow-hidden" style={{ height: ROW_H }}>
                  {rowIdx % 2 === 1 && (
                    <div className="absolute inset-0 bg-white/[0.02] pointer-events-none" />
                  )}
                  {/* Tick grid */}
                  {[1/6, 2/6, 3/6, 4/6, 5/6].map(f => (
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
                          <button
                            key={iv.id}
                            onClick={e => {
                              e.stopPropagation();
                              setSelected(sel => sel?.id === iv.id ? null : iv);
                              setShowRaw(false);
                            }}
                            style={{
                              position: 'absolute',
                              left: `${x * 100}%`,
                              top: BAR_TOP + BAR_H / 2 - 7,
                              width: 14, height: 14,
                              backgroundColor: color,
                              transform: 'translateX(-50%) rotate(45deg)',
                              opacity: isSel ? 1 : 0.85,
                              outline: isSel ? '2px solid #fff' : undefined,
                              cursor: 'pointer',
                              zIndex: 2,
                            }}
                            title={`${iv.topicLabel} — ${new Date(iv.startTs).toLocaleString()}`}
                          />
                        );
                      }

                      const barL = Math.max(0, (iv.startTs - viewStart) / viewSpan);
                      const barR = Math.min(1, (iv.endTs - viewStart) / viewSpan);
                      const barW = Math.max(0.002, barR - barL);
                      const dur  = fmtDur(iv.inProgress ? nowMs - iv.startTs : iv.durationMs);
                      const xSnap = (iv.startTs - viewStart) / viewSpan;
                      const snapLeft = Math.max(0, Math.min(97, xSnap * 100));

                      return (
                        <React.Fragment key={iv.id}>
                          {/* Gantt bar */}
                          <div
                            onClick={e => {
                              e.stopPropagation();
                              setSelected(sel => sel?.id === iv.id ? null : iv);
                              setShowRaw(false);
                            }}
                            style={{
                              position: 'absolute',
                              left:   `${barL * 100}%`,
                              width:  `${barW * 100}%`,
                              top:    BAR_TOP,
                              height: BAR_H,
                              backgroundColor: color + (isSel ? 'ff' : iv.inProgress ? '88' : 'cc'),
                              border: isSel
                                ? '1px solid #fff'
                                : iv.inProgress
                                  ? `1px dashed ${color}`
                                  : `1px solid ${color}`,
                              borderRadius: 3,
                              cursor: 'pointer',
                              overflow: 'hidden',
                              zIndex: 2,
                              display: 'flex',
                              alignItems: 'center',
                            }}
                            title={`${iv.topicLabel}${iv.inProgress ? ' (in progress)' : ''} — ${dur}`}
                          >
                            <span style={{ padding: '0 6px', fontSize: 10, fontWeight: 700, color: '#fff',
                                           whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {iv.inProgress ? '↦ ' : ''}{iv.topicLabel} {dur}
                            </span>
                          </div>

                          {/* Inline frame snap at startTs */}
                          {snapFd && (
                            <img
                              onClick={e => {
                                e.stopPropagation();
                                setSelected(sel => sel?.id === iv.id ? null : iv);
                                setShowRaw(false);
                              }}
                              src={snapFd}
                              alt=""
                              style={{
                                position: 'absolute',
                                left: `${snapLeft}%`,
                                top: SNAP_TOP,
                                width: SNAP_W,
                                height: SNAP_H,
                                objectFit: 'cover',
                                borderRadius: 3,
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
                    })
                  }
                </div>
              </div>
            ))}
          </div>

          {/* Tick labels (sticky bottom) */}
          <div className="flex-shrink-0 flex border-t border-gray-700/60 bg-gray-900/90"
               style={{ height: TICK_H }}>
            <div className="flex-shrink-0 border-r border-gray-700/60" style={{ width: ROW_LABEL_W }} />
            <div className="flex-1 relative">
              {ticks.map(({ x, label }) => (
                <div key={x} className="absolute flex flex-col items-center pointer-events-none"
                     style={{ left: `${x * 100}%` }}>
                  <div className="w-px h-3 bg-gray-600" />
                  <span className="text-[9px] text-gray-500 whitespace-nowrap mt-0.5">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Detail panel ─────────────────────────────────────────────────── */}
        {selected && (
          <div className="flex flex-col flex-shrink-0 border-l border-gray-700 bg-gray-900/90 overflow-hidden"
               style={{ width: DETAIL_W }}>

            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-xs px-1.5 py-0.5 rounded ${SEV_BADGE[selected.severity]}`}>
                  {selected.severity}
                </span>
                <span className="font-semibold text-white text-sm truncate">{selected.topicLabel}</span>
              </div>
              <button onClick={() => setSelected(null)}
                      className="text-gray-400 hover:text-white flex-shrink-0 ml-2">✕</button>
            </div>

            {/* Parsed / Raw XML toggle */}
            {selEvt?.rawXml && (
              <div className="flex border-b border-gray-700">
                <button onClick={() => setShowRaw(false)}
                        className={`flex-1 py-1 text-xs font-bold transition-colors ${!showRaw ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                  Parsed
                </button>
                <button onClick={() => setShowRaw(true)}
                        className={`flex-1 py-1 text-xs font-bold transition-colors ${showRaw ? 'bg-green-900/50 text-green-300' : 'text-gray-500 hover:text-gray-300'}`}>
                  Raw XML
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {showRaw ? (
                <pre className="px-3 py-2 text-[10px] text-green-400 whitespace-pre-wrap break-all leading-tight">
                  {selEvt?.rawXml}
                </pre>
              ) : (
                <div className="px-3 py-2 space-y-1 text-xs">
                  <DetailRow label="Start"  value={new Date(selected.startTs).toLocaleString()} />
                  <DetailRow
                    label="End"
                    value={selected.inProgress ? '● In Progress' : new Date(selected.endTs).toLocaleString()}
                    highlight={selected.inProgress}
                  />
                  <DetailRow label="Duration" value={selected.inProgress ? fmtDur(nowMs - selected.startTs) : fmtDur(selected.durationMs)} />
                  {selected.sourceToken && <DetailRow label="Source" value={selected.sourceToken} />}
                  {selEvt?.operation && <DetailRow label="Op" value={selEvt.operation} />}
                  {Object.entries(dispItems)
                    .filter(([k]) => !['SourceToken', 'State'].includes(k))
                    .map(([k, v]) => <DetailRow key={k} label={k} value={String(v)} />)
                  }
                  <div className="pt-1 border-t border-gray-700/60">
                    <DetailRow label="Topic" value={selEvt?.topic ?? ''} mono />
                  </div>

                  {selSnap && (
                    <div className="pt-2">
                      <div className="text-[10px] text-gray-500 mb-1">Frame at event start</div>
                      <img src={selSnap} alt="onvif-snap"
                           className="w-full rounded border border-gray-600/40 object-contain" />
                    </div>
                  )}
                  {!selSnap && !selected.inProgress && (
                    <div className="text-[10px] text-gray-600 italic pt-1">No frame snapshot</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Pan controls ─────────────────────────────────────────────────────── */}
      {zoomLevel > 1 && (
        <div className="flex items-center justify-center gap-3 py-2 bg-gray-900 border-t border-gray-700 flex-shrink-0">
          <button onClick={() => shiftPan(-0.15 / zoomLevel)}
                  className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded">
            ← Older
          </button>
          <div className="flex-1 max-w-xs h-1.5 bg-gray-700 rounded-full relative">
            <div className="absolute h-full bg-blue-500 rounded-full"
                 style={{ left: `${panFraction * zoomLevel * 100}%`, width: `${(1 / zoomLevel) * 100}%` }} />
          </div>
          <button onClick={() => shiftPan(0.15 / zoomLevel)}
                  className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded">
            Newer →
          </button>
          <button onClick={() => { setZoomLevel(1); setPan(0); }}
                  className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded">
            Reset
          </button>
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <div className="px-5 py-1.5 bg-gray-900 border-t border-gray-700 flex-shrink-0 flex items-center justify-between">
        <span className="text-[10px] text-gray-500">
          {t.onvifTimelineCount(visibleCount, totalCount)}
        </span>
        <div className="flex items-center gap-2">
          {(['info', 'warning', 'critical'] as OnvifSeverity[]).map(s => (
            <span key={s} className={`text-[9px] px-1.5 py-0.5 rounded ${SEV_BADGE[s]}`}>{s}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DetailRow({ label, value, mono, highlight }: {
  label: string; value: string; mono?: boolean; highlight?: boolean;
}) {
  return (
    <div className="flex gap-2 leading-snug">
      <span className="text-gray-500 flex-shrink-0 w-16 truncate">{label}</span>
      <span className={`break-all ${mono ? 'font-mono text-gray-400 text-[10px]' : ''} ${highlight ? 'text-green-400 font-bold' : 'text-gray-300'}`}>
        {value}
      </span>
    </div>
  );
}

// ── Utility functions (mirrored from OnvifTimelineInline) ─────────────────────

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
      rowMap.set(key, {
        key,
        topicType: iv.topicType,
        topicLabel: iv.topicLabel,
        sourceToken: iv.sourceToken,
        severity: iv.severity,
        intervals: [],
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

function formatTick(ts: number, viewSpanMs: number): string {
  const d = new Date(ts);
  if (viewSpanMs <= 2 * 3_600_000)
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (viewSpanMs <= 86_400_000)
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (viewSpanMs <= 7 * 86_400_000)
    return d.toLocaleDateString('en', { weekday: 'short' }) + ' ' +
           d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
