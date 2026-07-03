import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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

function fmtTime(iso: string, locale: string) {
  try {
    return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}
function fmtDateKey(iso: string) {
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
}
function fmtDateLabel(iso: string, locale: string) {
  try {
    return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  } catch { return iso; }
}
function fmtHourKey(iso: string) {
  try { return String(new Date(iso).getHours()).padStart(2, '0'); } catch { return '00'; }
}
function fmtHourLabel(iso: string, t: Translations) {
  try { return t.evtHourLabel(new Date(iso).getHours()); } catch { return iso; }
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ event, selected, onSelect, t, locale }: {
  event: AnalysisEvent;
  selected: boolean;
  onSelect: (id: string | null) => void;
  t: Translations;
  locale: string;
}) {
  const badge = TYPE_BADGE[event.type] ?? 'bg-slate-700/40 text-slate-300 border border-slate-600/30';
  const row   = TYPE_ROW[event.type]  ?? 'border-slate-700 bg-slate-900/40 hover:bg-slate-900/60';
  const label = typeLabel(t, event.type);

  return (
    <div
      className={`rounded border cursor-pointer transition-colors text-white ${row} ${selected ? 'ring-1 ring-blue-500/60' : ''}`}
      onClick={() => onSelect(selected ? null : event.id)}
    >
      {/* Row header */}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold ${badge}`}>{label}</span>
        <span className="flex-1 text-[10px] font-medium text-slate-200 truncate">
          {event.cameraName || event.cameraId.slice(0, 8)}
        </span>
        <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">{fmtTime(event.timestamp, locale)}</span>
        <span className={`shrink-0 text-[9px] text-slate-500 transition-transform ${selected ? 'rotate-180' : ''}`}>▾</span>
      </div>

      {/* Expanded detail */}
      {selected && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-slate-700/40">
          {/* Meta chips */}
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-400 pt-1.5">
            {event.type === 'loitering' && (
              <>
                {event.objectId  != null && <span>{t.evtObjectHash(event.objectId)}</span>}
                {event.dwellTime != null && <span className="text-amber-400">{t.evtDwellShort(`${event.dwellTime.toFixed(1)}s`)}</span>}
                {event.zoneName  && <span className="text-blue-400">{event.zoneName}</span>}
                {event.riskScore != null && (
                  <span className="text-red-400">{t.evtRiskShort(Math.round(event.riskScore * 100))}</span>
                )}
              </>
            )}
            {(event.type === 'fire' || event.type === 'smoke') && event.confidence != null && (
              <span className="text-orange-300">{t.evtConfidenceShort(Number((event.confidence * 100).toFixed(1)))}</span>
            )}
            {event.bbox && (
              <span className="text-slate-500 font-mono text-[9px]">
                ({Math.round(event.bbox.x)},{Math.round(event.bbox.y)}) {Math.round(event.bbox.width)}×{Math.round(event.bbox.height)}
              </span>
            )}
          </div>

          {/* Crop image */}
          {event.cropData ? (
            <div>
              <img
                src={event.cropData}
                alt={label}
                className="w-full max-h-36 object-contain rounded border border-slate-700 bg-slate-800 cursor-pointer hover:opacity-80 transition-opacity"
                title={t.evtClickToEnlarge}
                onClick={(e) => { e.stopPropagation(); window.open(event.cropData, '_blank'); }}
              />
              <p className="text-[9px] text-slate-600 mt-0.5">{t.evtSnapshotHint}</p>
            </div>
          ) : (
            <p className="text-[9px] text-slate-600 italic">{t.evtNoSnapshot}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main tab component ────────────────────────────────────────────────────────

export default function AnalysisEventsTab() {
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
  const [typeFilter,  setTypeFilter]  = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [collapsedHours, setCollapsedHours] = useState<Set<string>>(new Set());
  const [clearing,    setClearing]    = useState(false);
  const newestIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = typeFilter ? `?limit=300&type=${typeFilter}` : '?limit=300';
      const res = await fetch(`/api/analysis/events${qs}`);
      if (!res.ok) return;
      const data = await res.json() as { events: AnalysisEvent[] };
      const incoming = data.events ?? [];
      // Auto-expand newest hour group when new events arrive
      if (incoming.length > 0 && newestIdRef.current !== incoming[0]?.id) {
        newestIdRef.current = incoming[0]?.id ?? null;
      }
      setEvents(incoming);
    } catch {
      // silent — keep showing previous data
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  async function handleClear() {
    if (!window.confirm(t.evtConfirmClearAll)) return;
    setClearing(true);
    try {
      await fetch('/api/analysis/events', { method: 'DELETE' });
      setEvents([]);
    } catch { /* ignore */ }
    finally { setClearing(false); }
  }

  const toggleHour = (key: string) =>
    setCollapsedHours(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Group: date → hour → events (both sorted descending)
  const grouped = useMemo(() => {
    const dateMap = new Map<string, Map<string, AnalysisEvent[]>>();
    for (const ev of events) {
      const dk = fmtDateKey(ev.timestamp);
      const hk = fmtHourKey(ev.timestamp);
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
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-800 flex-shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 flex-1">
          {t.evtHeaderShort}
          {events.length > 0 && (
            <span className="ml-1.5 rounded-full bg-gray-700 px-1.5 py-0.5 text-gray-300 normal-case tracking-normal font-medium text-[9px]">
              {events.length}
            </span>
          )}
        </span>
        <button
          onClick={() => setAutoRefresh(v => !v)}
          title={autoRefresh ? t.evtAutoRefreshOff : t.evtAutoRefreshOn}
          className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
            autoRefresh
              ? 'bg-emerald-800/40 text-emerald-300 border-emerald-700/40'
              : 'bg-gray-800/60 text-gray-400 border-gray-700'
          }`}
        >
          {autoRefresh ? t.evtLiveLabel : t.evtStoppedShort}
        </button>
        <button
          onClick={() => load()}
          title={t.evtRefresh}
          className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800/60 text-gray-400 hover:text-gray-200 border border-gray-700 transition-colors"
        >
          ↻
        </button>
        {events.length > 0 && (
          <button
            onClick={handleClear}
            disabled={clearing}
            title={t.evtClearAllTitle}
            className="text-[9px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 border border-red-700/40 transition-colors disabled:opacity-50"
          >
            {clearing ? '…' : t.evtDelete}
          </button>
        )}
      </div>

      {/* ── Filter bar ── */}
      <div className="flex gap-1 px-3 py-1.5 border-b border-gray-800/60 flex-shrink-0 overflow-x-auto">
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => { setTypeFilter(opt.id); setSelectedId(null); }}
            className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium border transition-colors ${
              typeFilter === opt.id
                ? 'bg-amber-600/30 text-amber-200 border-amber-500/40'
                : 'bg-gray-800/60 text-gray-400 border-gray-700 hover:text-gray-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        {loading && events.length === 0 && (
          <div className="flex items-center justify-center h-16">
            <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && events.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-center px-4">
            <span className="text-2xl mb-1">🔍</span>
            <p className="text-xs text-gray-400">{t.evtNoEvents}</p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              {typeFilter
                ? t.evtNoEventsOfType(typeLabel(t, typeFilter))
                : t.evtEmptyHintShort}
            </p>
          </div>
        )}

        {grouped.map(({ dk, hours }) => {
          const dateTotalCount = hours.reduce((s, h) => s + h.evs.length, 0);
          return (
            <div key={dk} className="px-2 pt-2.5">
              {/* Date header */}
              <div className="flex items-center gap-1.5 mb-2">
                <div className="h-px flex-1 bg-gray-700/60" />
                <span className="text-[9px] font-semibold text-gray-400 bg-gray-900 px-1.5 rounded whitespace-nowrap">
                  {fmtDateLabel(hours[0].evs[0].timestamp, locale)}
                  <span className="ml-1 text-gray-600">({dateTotalCount})</span>
                </span>
                <div className="h-px flex-1 bg-gray-700/60" />
              </div>

              {/* Hour groups within this date */}
              {hours.map(({ hk, evs }) => {
                const groupKey = `${dk}-${hk}`;
                const collapsed = collapsedHours.has(groupKey);
                return (
                  <div key={hk} className="mb-2">
                    {/* Hour header — clickable to collapse */}
                    <button
                      onClick={() => toggleHour(groupKey)}
                      className="flex items-center gap-1.5 w-full text-left mb-1 px-0.5 group"
                    >
                      <span className="w-1 h-3 rounded-full bg-sky-500/60 flex-shrink-0" />
                      <span className="text-[9px] text-sky-400 font-semibold">{fmtHourLabel(evs[0].timestamp, t)}</span>
                      <span className="text-[9px] text-gray-600">({t.evtCountUnit(evs.length)})</span>
                      <span className={`text-[8px] text-gray-600 ml-auto transition-transform ${collapsed ? '' : 'rotate-180'}`}>▾</span>
                    </button>

                    {!collapsed && (
                      <div className="space-y-1 pl-2">
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
        <div className="h-4" />
      </div>
    </div>
  );
}
