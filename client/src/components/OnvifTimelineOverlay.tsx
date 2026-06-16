/**
 * OnvifTimelineOverlay — full-screen overlay that renders ONVIF events as a
 * horizontal timeline with zoom (scroll / keyboard ↑↓) and pan (keyboard ←→).
 *
 * Timeline range presets: 1D · 1W · 1M · 1Y
 * Event icons are clickable → shows ONVIF parsed detail + Raw XML toggle.
 *
 * Fetches events from GET /api/onvif-events and subscribes to Socket.IO
 * `onvif:event` for live updates.
 */

import { useCallback, useEffect, useMemo, useRef, useState, WheelEvent } from 'react';
import { useI18n } from '../i18n';
import { useOnvifEventStore, type OnvifEvent, type OnvifSeverity } from '../stores/onvifEventStore';
import { parseOnvifXml } from '../utils/onvifParser';
import { useSocket } from '../hooks/useSocket';

// ── Constants ─────────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { label: '1D', ms: 24 * 60 * 60 * 1000 },
  { label: '1W', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '1M', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: '1Y', ms: 365 * 24 * 60 * 60 * 1000 },
] as const;

type RangeLabel = '1D' | '1W' | '1M' | '1Y';

const SEVERITY_COLORS: Record<OnvifSeverity, string> = {
  info:     'bg-blue-500 border-blue-400 text-white',
  warning:  'bg-yellow-500 border-yellow-400 text-gray-900',
  critical: 'bg-red-600 border-red-400 text-white',
};

const SEVERITY_ICON: Record<string, string> = {
  callRequest:  '📞',
  motionAlarm:  '🚶',
  lineCrossed:  '🚧',
  fieldEntered: '⬛',
  fieldExited:  '⬜',
  fire:         '🔥',
  smoke:        '💨',
  unknown:      '❓',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  cameraId?: string;
  onClose: () => void;
}

interface TimelineItem {
  evt: OnvifEvent;
  x: number; // 0..1 fraction along the visible viewport
}

// ── Hook: fetch + live ─────────────────────────────────────────────────────────

function useOnvifEvents(cameraId: string | undefined, rangeMs: number) {
  const { pushEvent, setEvents, events } = useOnvifEventStore();
  const { socket } = useSocket();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const now   = Date.now();
    const from  = new Date(now - rangeMs).toISOString();
    const params = new URLSearchParams({ from, limit: '2000' });
    if (cameraId) params.set('cameraId', cameraId);

    fetch(`/api/onvif-events?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.events)) {
          setEvents(data.events as OnvifEvent[]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cameraId, rangeMs, setEvents]);

  useEffect(() => {
    if (!socket) return;
    const handler = (evt: OnvifEvent) => {
      if (cameraId && evt.cameraId !== cameraId) return;
      pushEvent(evt);
    };
    socket.on('onvif:event', handler);
    return () => { socket.off('onvif:event', handler); };
  }, [socket, cameraId, pushEvent]);

  return { events, loading };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EventDetailPanel({ evt, onClose }: { evt: OnvifEvent; onClose: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const parsed = evt.rawXml ? parseOnvifXml(evt.rawXml) : null;
  const displayItems = parsed?.items ?? evt.items ?? {};

  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50
                    w-80 bg-gray-900 border border-gray-600 rounded-lg shadow-2xl text-xs
                    overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700">
        <span className="font-semibold text-white">{evt.topicLabel}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-white p-0.5">✕</button>
      </div>

      {/* Parsed detail */}
      <div className="px-3 py-2 space-y-1">
        <Row label="Topic"     value={evt.topic} />
        <Row label="Time"      value={new Date(evt.utcTime).toLocaleString()} />
        <Row label="Operation" value={evt.operation} />
        {evt.sourceToken && <Row label="Source"    value={evt.sourceToken} />}
        {evt.state       && <Row label="State"     value={evt.state} />}
        {Object.entries(displayItems)
          .filter(([k]) => !['SourceToken', 'State'].includes(k))
          .map(([k, v]) => <Row key={k} label={k} value={String(v)} />)}
      </div>

      {/* Raw XML toggle */}
      {evt.rawXml && (
        <div className="border-t border-gray-700">
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="w-full px-3 py-1.5 text-left text-[10px] text-gray-400 hover:text-gray-200
                       hover:bg-gray-800 transition-colors font-mono"
          >
            {showRaw ? '▾ Hide Raw XML' : '▸ Show Raw XML'}
          </button>
          {showRaw && (
            <pre className="px-3 py-2 text-[9px] text-green-400 bg-gray-950 overflow-x-auto
                            max-h-40 leading-tight whitespace-pre-wrap break-all">
              {evt.rawXml}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-gray-500 flex-shrink-0 w-20 truncate">{label}</span>
      <span className="text-gray-200 break-all">{value}</span>
    </div>
  );
}

// ── Main overlay ──────────────────────────────────────────────────────────────

export default function OnvifTimelineOverlay({ cameraId, onClose }: Props) {
  const { t } = useI18n();
  const [range, setRange]         = useState<RangeLabel>('1D');
  const [zoomLevel, setZoomLevel] = useState(1);       // 1 = full range, >1 = zoomed in
  const [panFraction, setPan]     = useState(0);        // 0..1 offset from end (0 = latest)
  const [selected, setSelected]   = useState<OnvifEvent | null>(null);
  const containerRef              = useRef<HTMLDivElement>(null);

  const rangeMs = RANGE_OPTIONS.find((r) => r.label === range)!.ms;
  const { events, loading } = useOnvifEvents(cameraId, rangeMs);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); handleZoom(1.5);  }
      if (e.key === 'ArrowDown')  { e.preventDefault(); handleZoom(1 / 1.5); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); shiftPan(-0.1 / zoomLevel); }
      if (e.key === 'ArrowRight') { e.preventDefault(); shiftPan( 0.1 / zoomLevel); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomLevel, onClose]);

  const handleZoom = useCallback((factor: number) => {
    setZoomLevel((z) => Math.max(1, Math.min(z * factor, 1000)));
  }, []);

  const shiftPan = useCallback((delta: number) => {
    setPan((p) => Math.max(0, Math.min(1 - 1 / zoomLevel, p + delta)));
  }, [zoomLevel]);

  const handleWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.deltaY < 0) handleZoom(1.3);
    else              handleZoom(1 / 1.3);
  };

  // Viewport: [viewStart, viewEnd] as absolute timestamps
  const now      = Date.now();
  const rangeEnd = now;
  const viewSpan = rangeMs / zoomLevel;
  const viewEnd  = rangeEnd - panFraction * rangeMs;
  const viewStart = viewEnd - viewSpan;

  // Map events to x positions [0..1] within current viewport
  const items = useMemo<TimelineItem[]>(() => {
    return events
      .filter((e) => {
        const ts = new Date(e.serverTs).getTime();
        return ts >= viewStart && ts <= viewEnd;
      })
      .map((e) => ({
        evt: e,
        x: (new Date(e.serverTs).getTime() - viewStart) / viewSpan,
      }));
  }, [events, viewStart, viewEnd, viewSpan]);

  // Timeline tick labels
  const ticks = useMemo(() => {
    const count  = 6;
    const result = [];
    for (let i = 0; i <= count; i++) {
      const ts    = viewStart + (i / count) * viewSpan;
      const label = formatTick(ts, viewSpan);
      result.push({ x: i / count, label });
    }
    return result;
  }, [viewStart, viewSpan]);

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-gray-950/95 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 bg-gray-900 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white tracking-wide">
            {t.onvifTimelineTitle}
          </span>
          {cameraId && (
            <span className="text-[10px] text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
              {cameraId.slice(0, 8)}
            </span>
          )}
          {loading && (
            <span className="text-[10px] text-blue-400 animate-pulse">Loading…</span>
          )}
        </div>

        {/* Range selector */}
        <div className="flex items-center gap-1">
          {RANGE_OPTIONS.map(({ label }) => (
            <button
              key={label}
              onClick={() => { setRange(label as RangeLabel); setZoomLevel(1); setPan(0); }}
              className={`px-3 py-1 text-[11px] font-bold rounded transition-colors ${
                range === label
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <span className="text-[10px] text-gray-500 hidden sm:block">
            {t.onvifTimelineHint}
          </span>
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

      {/* ── Timeline canvas ─────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden select-none cursor-crosshair"
        onWheel={handleWheel}
      >
        {/* Tick marks + labels */}
        <div className="absolute bottom-8 left-0 right-0 h-6 pointer-events-none">
          {ticks.map(({ x, label }) => (
            <div
              key={x}
              className="absolute flex flex-col items-center"
              style={{ left: `${x * 100}%`, transform: 'translateX(-50%)' }}
            >
              <div className="w-px h-3 bg-gray-600" />
              <span className="text-[9px] text-gray-500 whitespace-nowrap mt-0.5">{label}</span>
            </div>
          ))}
          {/* Baseline */}
          <div className="absolute bottom-0 left-0 right-0 h-px bg-gray-700" />
        </div>

        {/* Event icons */}
        {items.map(({ evt, x }) => (
          <EventIcon
            key={evt.id}
            evt={evt}
            x={x}
            isSelected={selected?.id === evt.id}
            onSelect={(e) => {
              e.stopPropagation();
              setSelected((prev) => prev?.id === evt.id ? null : evt);
            }}
          />
        ))}

        {/* Empty state */}
        {!loading && items.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-gray-600 text-sm">{t.onvifTimelineEmpty}</span>
          </div>
        )}

        {/* Zoom/pan controls hint */}
        <div className="absolute top-3 right-4 text-[10px] text-gray-600 pointer-events-none">
          {zoomLevel > 1 && (
            <span className="bg-gray-800/80 px-2 py-0.5 rounded">
              ×{zoomLevel.toFixed(1)}
            </span>
          )}
        </div>

        {/* Legend */}
        <div className="absolute bottom-16 right-4 flex gap-2">
          {(['info', 'warning', 'critical'] as OnvifSeverity[]).map((s) => (
            <span key={s} className={`text-[9px] px-1.5 py-0.5 rounded ${SEVERITY_COLORS[s]}`}>
              {s}
            </span>
          ))}
        </div>
      </div>

      {/* ── Pan controls ────────────────────────────────────────────────── */}
      {zoomLevel > 1 && (
        <div className="flex items-center justify-center gap-3 py-2 bg-gray-900 border-t border-gray-700 flex-shrink-0">
          <button
            onClick={() => shiftPan(-0.15 / zoomLevel)}
            className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded"
          >
            ← Older
          </button>
          <div className="flex-1 max-w-xs h-1.5 bg-gray-700 rounded-full relative">
            <div
              className="absolute h-full bg-blue-500 rounded-full"
              style={{
                left:  `${panFraction * zoomLevel * 100}%`,
                width: `${(1 / zoomLevel) * 100}%`,
              }}
            />
          </div>
          <button
            onClick={() => shiftPan(0.15 / zoomLevel)}
            className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded"
          >
            Newer →
          </button>
          <button
            onClick={() => { setZoomLevel(1); setPan(0); }}
            className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded"
          >
            Reset
          </button>
        </div>
      )}

      {/* ── Event count footer ───────────────────────────────────────────── */}
      <div className="px-5 py-1.5 bg-gray-900 border-t border-gray-700 flex-shrink-0">
        <span className="text-[10px] text-gray-500">
          {t.onvifTimelineCount(items.length, events.length)}
        </span>
      </div>
    </div>
  );
}

// ── Event icon ────────────────────────────────────────────────────────────────

function EventIcon({
  evt, x, isSelected, onSelect,
}: {
  evt: OnvifEvent;
  x: number;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
}) {
  const icon     = SEVERITY_ICON[evt.topicType] ?? SEVERITY_ICON.unknown;
  const colorCls = SEVERITY_COLORS[evt.severity] ?? SEVERITY_COLORS.info;

  return (
    <div
      className="absolute"
      style={{ left: `${x * 100}%`, bottom: '2.5rem', transform: 'translateX(-50%)' }}
    >
      <button
        onClick={onSelect}
        className={`w-7 h-7 rounded-full border-2 flex items-center justify-center
                    text-sm transition-transform hover:scale-125 focus:outline-none
                    shadow-lg ${colorCls}
                    ${isSelected ? 'scale-125 ring-2 ring-white' : ''}`}
        title={`${evt.topicLabel} — ${new Date(evt.serverTs).toLocaleString()}`}
      >
        {icon}
      </button>

      {/* Vertical stem */}
      <div className="absolute top-full left-1/2 -translate-x-1/2 w-px h-4 bg-gray-600" />

      {/* Detail popup */}
      {isSelected && (
        <EventDetailPanel evt={evt} onClose={() => onSelect({ stopPropagation: () => {} } as React.MouseEvent)} />
      )}
    </div>
  );
}

// ── Helper: tick label format ──────────────────────────────────────────────────

function formatTick(ts: number, viewSpanMs: number): string {
  const d = new Date(ts);
  if (viewSpanMs <= 2 * 60 * 60 * 1000) {
    // ≤ 2 h → show HH:MM:SS
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  if (viewSpanMs <= 24 * 60 * 60 * 1000) {
    // ≤ 1 day → HH:MM
    return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (viewSpanMs <= 7 * 24 * 60 * 60 * 1000) {
    // ≤ 1 week → Mon 12:00
    return d.toLocaleDateString('en', { weekday: 'short' }) + ' ' +
           d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  // > 1 week → Jan 5
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
