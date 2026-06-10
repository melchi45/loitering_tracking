'use client';

import { useEffect, useState, useCallback } from 'react';

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
};

type EventsResponse = {
  events: AnalysisEvent[];
  total: number;
};

const TYPE_LABELS: Record<string, string> = {
  fire:       '🔥 화재',
  smoke:      '💨 연기',
  loitering:  '🚶 배회',
};

const TYPE_COLORS: Record<string, string> = {
  fire:      'border-orange-500/40 bg-orange-950/20',
  smoke:     'border-gray-500/40 bg-gray-900/40',
  loitering: 'border-amber-500/40 bg-amber-950/20',
};

const TYPE_BADGE: Record<string, string> = {
  fire:      'bg-orange-500/20 text-orange-300 border border-orange-500/30',
  smoke:     'bg-gray-600/30 text-gray-300 border border-gray-600/40',
  loitering: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
};

const FILTER_OPTIONS = [
  { id: '',          label: '전체' },
  { id: 'fire',      label: '🔥 화재' },
  { id: 'smoke',     label: '💨 연기' },
  { id: 'loitering', label: '🚶 배회' },
] as const;

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function EventRow({ event }: { event: AnalysisEvent }) {
  const colorClass = TYPE_COLORS[event.type] ?? 'border-slate-700 bg-slate-900/40';
  const badgeClass = TYPE_BADGE[event.type] ?? 'bg-slate-700/40 text-slate-300';
  const label      = TYPE_LABELS[event.type] ?? event.type;

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${colorClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold ${badgeClass}`}>
            {label}
          </span>
          <span className="text-sm font-medium text-slate-100 truncate">
            {event.cameraName || event.cameraId}
          </span>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-slate-300 tabular-nums">{formatTime(event.timestamp)}</p>
          <p className="text-[10px] text-slate-500">{formatDate(event.timestamp)}</p>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
        {event.type === 'loitering' && (
          <>
            {event.objectId != null && <span>객체 ID: {event.objectId}</span>}
            {event.dwellTime != null && <span>체류 시간: {event.dwellTime.toFixed(1)}s</span>}
            {event.zoneName  && <span>구역: {event.zoneName}</span>}
            {event.riskScore != null && (
              <span className="text-amber-400">위험도: {(event.riskScore * 100).toFixed(0)}%</span>
            )}
          </>
        )}
        {(event.type === 'fire' || event.type === 'smoke') && event.confidence != null && (
          <span className="text-orange-300">신뢰도: {(event.confidence * 100).toFixed(1)}%</span>
        )}
        {event.bbox && (
          <span className="text-slate-500 font-mono text-[10px]">
            bbox ({event.bbox.x.toFixed(0)}, {event.bbox.y.toFixed(0)})
          </span>
        )}
      </div>
    </div>
  );
}

export default function AnalysisDetectionPanel() {
  const [events,      setEvents]      = useState<AnalysisEvent[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [typeFilter,  setTypeFilter]  = useState('');
  const [clearing,    setClearing]    = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    try {
      const url = typeFilter
        ? `/api/analysis/events?limit=100&type=${typeFilter}`
        : '/api/analysis/events?limit=100';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as EventsResponse;
      setEvents(data.events ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  async function handleClear() {
    if (!window.confirm('분석 이벤트를 모두 삭제하겠습니까?')) return;
    setClearing(true);
    try {
      await fetch('/api/analysis/events', { method: 'DELETE' });
      setEvents([]);
    } catch {
      /* ignore */
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-slate-950/60">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-800 flex-shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400 flex-1">
          분석 이벤트
          {events.length > 0 && (
            <span className="ml-1.5 rounded-full bg-slate-700 px-1.5 py-0.5 text-slate-300">{events.length}</span>
          )}
        </span>

        {/* Auto-refresh toggle */}
        <button
          onClick={() => setAutoRefresh(v => !v)}
          title={autoRefresh ? '자동 새로고침 끄기' : '자동 새로고침 켜기'}
          className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
            autoRefresh
              ? 'bg-emerald-700/40 text-emerald-300 border border-emerald-600/40'
              : 'bg-slate-700/40 text-slate-400 border border-slate-700'
          }`}
        >
          {autoRefresh ? '● 실시간' : '○ 일시정지'}
        </button>

        {/* Manual refresh */}
        <button
          onClick={() => load()}
          title="새로고침"
          className="text-[10px] px-2 py-0.5 rounded bg-slate-700/40 text-slate-400 hover:text-slate-200 border border-slate-700 transition-colors"
        >
          ↻
        </button>

        {/* Clear */}
        {events.length > 0 && (
          <button
            onClick={handleClear}
            disabled={clearing}
            title="이벤트 전체 삭제"
            className="text-[10px] px-2 py-0.5 rounded bg-rose-900/30 text-rose-400 hover:bg-rose-900/50 border border-rose-700/40 transition-colors disabled:opacity-50"
          >
            {clearing ? '…' : '삭제'}
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-slate-800/60 flex-shrink-0 overflow-x-auto scrollbar-none">
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => setTypeFilter(opt.id)}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors border ${
              typeFilter === opt.id
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-slate-800/60 text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {loading && (
          <div className="flex items-center justify-center h-20">
            <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 px-3 py-3 text-xs text-rose-300">
            이벤트를 불러오지 못했습니다: {error}
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-center">
            <span className="text-2xl mb-2">🔍</span>
            <p className="text-sm text-slate-400">분석 이벤트 없음</p>
            <p className="text-xs text-slate-600 mt-1">
              {typeFilter ? `'${TYPE_LABELS[typeFilter] ?? typeFilter}' 타입의 이벤트가 없습니다.` : 'AI 분석이 실행되면 이벤트가 여기 표시됩니다.'}
            </p>
          </div>
        )}

        {!loading && events.map(evt => (
          <EventRow key={evt.id} event={evt} />
        ))}
      </div>
    </div>
  );
}
