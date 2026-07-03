import { useEffect, useState, useCallback, useMemo } from 'react';
import { useI18n, BCP47_LOCALE } from '../i18n';
import type { Translations } from '../i18n/translations/en';

type AnalysisEvent = {
  id: string;
  type: 'fire' | 'smoke' | 'loitering';
  cameraId: string;
  cameraName: string;
  timestamp: string;
  confidence?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  objectId?: number;
  dwellTime?: number;
  zoneId?: string;
  zoneName?: string;
  riskScore?: number;
  cropData?: string;
};

interface Props {
  onClose?: () => void;
}

function typeLabel(t: Translations, type: string): string {
  if (type === 'fire') return t.evtTypeFire;
  if (type === 'smoke') return t.evtTypeSmoke;
  if (type === 'loitering') return t.evtTypeLoitering;
  return type;
}

const TYPE_BADGE: Record<string, string> = {
  fire:      'bg-orange-500/20 text-orange-300 border border-orange-500/30',
  smoke:     'bg-gray-600/30 text-gray-300 border border-gray-600/40',
  loitering: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
};

const TYPE_ROW: Record<string, string> = {
  fire:      'border-orange-500/30 bg-orange-950/20 hover:bg-orange-950/40',
  smoke:     'border-gray-600/30 bg-gray-900/40 hover:bg-gray-900/60',
  loitering: 'border-amber-500/30 bg-amber-950/20 hover:bg-amber-950/40',
};

function fmt(iso: string, mode: 'time' | 'dateKey' | 'dateLabel' | 'hourKey' | 'hourLabel', t: Translations, locale: string) {
  try {
    const d = new Date(iso);
    if (mode === 'time')      return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (mode === 'dateKey')   return d.toISOString().slice(0, 10);
    if (mode === 'hourKey')   return String(d.getHours()).padStart(2, '0');
    if (mode === 'hourLabel') return t.evtHourLabel(d.getHours());
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  } catch {
    return iso;
  }
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ event, selected, onSelect, t, locale }: {
  event: AnalysisEvent;
  selected: boolean;
  onSelect: (id: string | null) => void;
  t: Translations;
  locale: string;
}) {
  const badge = TYPE_BADGE[event.type] ?? 'bg-slate-700/40 text-slate-300';
  const row   = TYPE_ROW[event.type]  ?? 'border-slate-700 bg-slate-900/40 hover:bg-slate-900/60';
  const label = typeLabel(t, event.type);

  return (
    <div
      className={`rounded-lg border cursor-pointer transition-colors ${row} ${selected ? 'ring-1 ring-blue-500/60' : ''}`}
      onClick={() => onSelect(selected ? null : event.id)}
    >
      {/* Row header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge}`}>{label}</span>
        <span className="flex-1 text-[11px] font-medium text-slate-200 truncate">
          {event.cameraName || event.cameraId}
        </span>
        <span className="shrink-0 text-[11px] text-slate-400 tabular-nums">{fmt(event.timestamp, 'time', t, locale)}</span>
        <span className={`shrink-0 text-[10px] text-slate-500 transition-transform ${selected ? 'rotate-180' : ''}`}>▾</span>
      </div>

      {/* Expanded detail */}
      {selected && (
        <div className="px-3 pb-3 space-y-2 border-t border-slate-700/40">
          {/* Meta chips */}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400 pt-2">
            {event.type === 'loitering' && (
              <>
                {event.objectId != null && <span>{t.evtObjectIdColon(event.objectId)}</span>}
                {event.dwellTime  != null && <span className="text-amber-400">{t.evtDwellColon(`${event.dwellTime.toFixed(1)}s`)}</span>}
                {event.zoneName   && <span className="text-blue-400">{t.evtZoneColon(event.zoneName)}</span>}
                {event.riskScore  != null && (
                  <span className="text-red-400">{t.evtRiskColon(Math.round(event.riskScore * 100))}</span>
                )}
              </>
            )}
            {(event.type === 'fire' || event.type === 'smoke') && event.confidence != null && (
              <span className="text-orange-300">{t.evtConfidenceColon(Number((event.confidence * 100).toFixed(1)))}</span>
            )}
            {event.bbox && (
              <span className="text-slate-500 font-mono text-[10px]">
                bbox ({Math.round(event.bbox.x)}, {Math.round(event.bbox.y)}, {Math.round(event.bbox.width)}×{Math.round(event.bbox.height)})
              </span>
            )}
          </div>

          {/* Crop image */}
          {event.cropData ? (
            <div className="flex gap-3 items-start">
              <img
                src={event.cropData}
                alt={label}
                className="w-24 h-24 object-cover rounded border border-slate-600 bg-slate-800 cursor-pointer hover:opacity-80 transition-opacity flex-shrink-0"
                title={t.evtClickToEnlarge}
                onClick={(e) => { e.stopPropagation(); window.open(event.cropData, '_blank'); }}
              />
              <p className="text-[10px] text-slate-500 pt-1">{t.evtSnapshotLine1}<br />{t.evtSnapshotLine2}</p>
            </div>
          ) : (
            <p className="text-[10px] text-slate-600 italic">{t.evtNoSnapshot}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AnalysisDetectionPanel({ onClose }: Props) {
  const { t, lang } = useI18n();
  const locale = BCP47_LOCALE[lang];
  const FILTER_OPTIONS = [
    { id: '',          label: t.evtFilterAll },
    { id: 'fire',      label: t.evtTypeFire },
    { id: 'smoke',     label: t.evtTypeSmoke },
    { id: 'loitering', label: t.evtTypeLoitering },
  ] as const;
  const [events,      setEvents]      = useState<AnalysisEvent[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [typeFilter,  setTypeFilter]  = useState('');
  const [clearing,    setClearing]    = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = typeFilter ? `?limit=200&type=${typeFilter}` : '?limit=200';
      const res = await fetch(`/api/analysis/events${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { events: AnalysisEvent[]; total: number };
      setEvents(data.events ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [autoRefresh, load]);

  async function handleClear() {
    if (!window.confirm(t.evtConfirmClearAll)) return;
    setClearing(true);
    try { await fetch('/api/analysis/events', { method: 'DELETE' }); setEvents([]); }
    catch { /* ignore */ }
    finally { setClearing(false); }
  }

  const [collapsedHours, setCollapsedHours] = useState<Set<string>>(new Set());

  const toggleHour = (key: string) =>
    setCollapsedHours(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Group events by date → hour (both sorted descending)
  const grouped = useMemo(() => {
    const dateMap = new Map<string, Map<string, AnalysisEvent[]>>();
    for (const ev of events) {
      const dk = fmt(ev.timestamp, 'dateKey', t, locale);
      const hk = fmt(ev.timestamp, 'hourKey', t, locale);
      if (!dateMap.has(dk)) dateMap.set(dk, new Map());
      const hm = dateMap.get(dk)!;
      if (!hm.has(hk)) hm.set(hk, []);
      hm.get(hk)!.push(ev);
    }
    return [...dateMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dk, hm]) => ({
        dk,
        hours: [...hm.entries()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([hk, evs]) => ({ hk, evs })),
      }));
  }, [events]);

  return (
    <div className="flex flex-col h-full bg-gray-950 text-white overflow-hidden">

      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800 flex-shrink-0">
        <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400 flex-1">
          {t.evtHeaderFull}
          {events.length > 0 && (
            <span className="ml-2 rounded-full bg-gray-700 px-2 py-0.5 text-gray-300 normal-case tracking-normal font-medium">
              {t.evtCountUnit(events.length)}
            </span>
          )}
        </span>

        <button
          onClick={() => setAutoRefresh(v => !v)}
          title={autoRefresh ? t.evtAutoRefreshOff : t.evtAutoRefreshOn}
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            autoRefresh
              ? 'bg-emerald-800/40 text-emerald-300 border-emerald-700/40'
              : 'bg-gray-800/60 text-gray-400 border-gray-700'
          }`}
        >
          {autoRefresh ? t.evtLiveLabel : t.evtPausedFull}
        </button>

        <button onClick={() => load()} title={t.evtRefresh}
          className="text-[10px] px-2 py-0.5 rounded bg-gray-800/60 text-gray-400 hover:text-gray-200 border border-gray-700 transition-colors">
          ↻
        </button>

        {events.length > 0 && (
          <button onClick={handleClear} disabled={clearing} title={t.evtClearAllTitle}
            className="text-[10px] px-2 py-0.5 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 border border-red-700/40 transition-colors disabled:opacity-50">
            {clearing ? '…' : t.evtDelete}
          </button>
        )}

        {onClose && (
          <button onClick={onClose} title={t.settingsClose}
            className="ml-1 w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors text-lg leading-none">
            ✕
          </button>
        )}
      </div>

      {/* ── Filter bar ── */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-gray-800/60 flex-shrink-0 overflow-x-auto">
        {FILTER_OPTIONS.map(opt => (
          <button key={opt.id} onClick={() => { setTypeFilter(opt.id); setSelectedId(null); }}
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-medium border transition-colors ${
              typeFilter === opt.id
                ? 'bg-amber-600/30 text-amber-200 border-amber-500/40'
                : 'bg-gray-800/60 text-gray-400 border-gray-700 hover:text-gray-200'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center h-24">
            <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && error && (
          <div className="mx-3 mt-3 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-3 text-xs text-red-300">
            {t.evtLoadError(error)}
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4">
            <span className="text-3xl mb-2">🔍</span>
            <p className="text-sm text-gray-400">{t.evtNoEvents}</p>
            <p className="text-xs text-gray-600 mt-1">
              {typeFilter
                ? t.evtNoEventsOfType(typeLabel(t, typeFilter))
                : t.evtEmptyHintFull}
            </p>
          </div>
        )}

        {!loading && !error && grouped.map(({ dk, hours }) => {
          const dateTotalCount = hours.reduce((s, h) => s + h.evs.length, 0);
          return (
            <div key={dk} className="px-3 pt-3">
              {/* Date header */}
              <div className="flex items-center gap-2 mb-2">
                <div className="h-px flex-1 bg-gray-700/60" />
                <span className="text-[10px] font-semibold text-gray-400 bg-gray-900 px-2 rounded">
                  {fmt(hours[0].evs[0].timestamp, 'dateLabel', t, locale)}
                  <span className="ml-1.5 text-gray-600">({t.evtCountUnit(dateTotalCount)})</span>
                </span>
                <div className="h-px flex-1 bg-gray-700/60" />
              </div>

              {/* Hour groups within this date */}
              {hours.map(({ hk, evs }) => {
                const groupKey = `${dk}-${hk}`;
                const collapsed = collapsedHours.has(groupKey);
                return (
                  <div key={hk} className="mb-3">
                    {/* Hour header — clickable to collapse */}
                    <button
                      onClick={() => toggleHour(groupKey)}
                      className="flex items-center gap-2 w-full text-left mb-1.5 px-0.5 group"
                    >
                      <span className="w-1 h-3.5 rounded-full bg-sky-500/60 flex-shrink-0" />
                      <span className="text-[10px] text-sky-400 font-semibold">{fmt(evs[0].timestamp, 'hourLabel', t, locale)}</span>
                      <span className="text-[10px] text-gray-600">({t.evtCountUnit(evs.length)})</span>
                      <span className={`text-[9px] text-gray-600 ml-auto transition-transform ${collapsed ? '' : 'rotate-180'}`}>▾</span>
                    </button>

                    {!collapsed && (
                      <div className="space-y-1.5 pl-3">
                        {evs.map(ev => (
                          <EventRow
                            key={ev.id}
                            event={ev}
                            selected={selectedId === ev.id}
                            onSelect={setSelectedId}
                            t={t}
                            locale={locale}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Bottom padding */}
        <div className="h-4" />
      </div>
    </div>
  );
}
