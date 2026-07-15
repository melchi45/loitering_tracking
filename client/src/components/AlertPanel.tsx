import { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, Search, SlidersHorizontal, CheckCircle2, Clock, X } from 'lucide-react';
import { useAlertStore } from '../stores/alertStore';
import { useCameraStore } from '../stores/cameraStore';
import { useI18n } from '../i18n';
import type { Alert } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeTs(ts: number | string | undefined): number {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  const t = new Date(ts).getTime();
  return isNaN(t) ? 0 : t;
}

function relativeTime(ts: number | string | undefined): string {
  const t = normalizeTs(ts);
  if (!t) return '—';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatDateTime(ts: number | string | undefined): string {
  const t = normalizeTs(ts);
  if (!t) return '—';
  return new Date(t).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function normalizeAlert(raw: Record<string, unknown>): Alert {
  const ts = normalizeTs(raw.timestamp as number | string);
  return {
    id:           String(raw.id ?? ''),
    cameraId:     String(raw.cameraId ?? ''),
    objectId:     raw.objectId as string | number,
    zone:         (raw.zoneName as string) ?? (raw.zone as string) ?? undefined,
    zoneId:       raw.zoneId as string | undefined,
    type:         (raw.type as string) || 'LOITERING',
    dwellTime:    Number(raw.dwellTime) || 0,
    timestamp:    ts || Date.now(),
    acknowledged: Boolean(raw.acknowledged),
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest First' },
  { value: 'oldest', label: 'Oldest First' },
  { value: 'dwell',  label: 'Dwell (High→Low)' },
  { value: 'camera', label: 'Camera (A→Z)' },
] as const;
type SortOption = typeof SORT_OPTIONS[number]['value'];

const TIME_OPTIONS = [
  { value: 'all',   label: 'All' },
  { value: '1h',    label: '1h' },
  { value: '24h',   label: '24h' },
  { value: 'today', label: 'Today' },
] as const;
type TimeOption = typeof TIME_OPTIONS[number]['value'];

// ── AlertRow ──────────────────────────────────────────────────────────────────

function AlertRow({ alert, cameraName }: { alert: Alert; cameraName: string }) {
  const acknowledgeAlert = useAlertStore((s) => s.acknowledgeAlert);

  const handleAck = async () => {
    try { await fetch(`/api/alerts/${alert.id}/acknowledge`, { method: 'POST' }); } catch { /* ignore */ }
    acknowledgeAlert(alert.id);
  };

  const type = (alert.type || 'LOITERING').toUpperCase();
  const typeBadgeClass =
    type === 'FIRE'  ? 'bg-orange-700 text-white' :
    type === 'SMOKE' ? 'bg-gray-600 text-gray-100' :
                       'bg-red-800 text-white';

  return (
    <div className={`rounded border text-xs transition-opacity ${
      alert.acknowledged
        ? 'bg-gray-800/60 border-gray-700 opacity-50'
        : 'bg-red-950/20 border-red-900/40'
    }`}>
      {/* Row 1: icon + camera + type badge + relative time */}
      <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5">
        <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 ${alert.acknowledged ? 'text-gray-500' : 'text-red-400'}`} />
        <span className="font-semibold text-white truncate flex-1 text-[11px]">{cameraName}</span>
        <span className={`flex-shrink-0 text-[8px] font-bold px-1.5 py-0.5 rounded ${typeBadgeClass}`}>{type}</span>
      </div>

      {/* Row 2: object ID + zone */}
      <div className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-gray-400">
        <span>#{String(alert.objectId).slice(0, 8)}</span>
        {alert.zone && (
          <>
            <span className="text-gray-600">·</span>
            <span className="text-blue-400 truncate" title={alert.zone}>{alert.zone}</span>
          </>
        )}
      </div>

      {/* Row 3: dwell + absolute time + ack */}
      <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-yellow-400 flex-shrink-0 inline-flex items-center gap-0.5"><Clock className="w-3 h-3" /> {alert.dwellTime.toFixed(1)}s</span>
          <span
            className="text-gray-500 text-[10px] truncate"
            title={formatDateTime(alert.timestamp)}
          >
            {relativeTime(alert.timestamp)}
          </span>
        </div>
        {!alert.acknowledged && (
          <button
            onClick={handleAck}
            className="flex-shrink-0 ml-1 px-1.5 py-0.5 text-[9px] font-bold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded border border-gray-600 transition-colors"
          >
            Ack
          </button>
        )}
      </div>
    </div>
  );
}

// ── AlertPanel ────────────────────────────────────────────────────────────────

export default function AlertPanel() {
  const alerts         = useAlertStore((s) => s.alerts);
  const clearAlerts    = useAlertStore((s) => s.clearAlerts);
  const hydrateAlerts  = useAlertStore((s) => s.hydrateAlerts);
  const cameras        = useCameraStore((s) => s.cameras);
  const { t }          = useI18n();

  const [search,       setSearch]       = useState('');
  const [filterCamera, setFilterCamera] = useState('');
  const [filterZone,   setFilterZone]   = useState('');
  const [filterType,   setFilterType]   = useState('');
  const [filterTime,   setFilterTime]   = useState<TimeOption>('all');
  const [sortBy,       setSortBy]       = useState<SortOption>('newest');
  const [showFilters,  setShowFilters]  = useState(false);
  const [loading,      setLoading]      = useState(false);

  // Load historical alerts from REST API on mount
  useEffect(() => {
    setLoading(true);
    fetch('/api/alerts?limit=500')
      .then((r) => r.json())
      .then((res) => {
        if (res.success && Array.isArray(res.data)) {
          hydrateAlerts(res.data.map(normalizeAlert));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [hydrateAlerts]);

  const cameraNameMap = useMemo(
    () => new Map(cameras.map((c) => [c.id, c.name])),
    [cameras]
  );

  // Unique filter options derived from current alerts
  const uniqueTypes = useMemo(
    () => [...new Set(alerts.map((a) => (a.type || 'LOITERING').toUpperCase()))].sort(),
    [alerts]
  );
  const uniqueCameras = useMemo(
    () => [...new Set(alerts.map((a) => a.cameraId))]
      .map((id) => ({ id, name: cameraNameMap.get(id) || id }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [alerts, cameraNameMap]
  );
  const uniqueZones = useMemo(
    () => [...new Set(alerts.map((a) => a.zone).filter(Boolean) as string[])].sort(),
    [alerts]
  );

  const unacknowledgedCount = useMemo(
    () => alerts.filter((a) => !a.acknowledged).length,
    [alerts]
  );

  const filtered = useMemo(() => {
    const now = Date.now();
    const timeLimit =
      filterTime === '1h'  ? 3_600_000 :
      filterTime === '24h' ? 86_400_000 : null;
    const todayStart =
      filterTime === 'today' ? new Date().setHours(0, 0, 0, 0) : null;

    const result = alerts.filter((a) => {
      const ts      = normalizeTs(a.timestamp);
      const camName = (cameraNameMap.get(a.cameraId) || a.cameraId).toLowerCase();
      const aType   = (a.type || 'LOITERING').toUpperCase();

      if (filterType   && aType         !== filterType.toUpperCase()) return false;
      if (filterCamera && a.cameraId    !== filterCamera)             return false;
      if (filterZone   && a.zone        !== filterZone)               return false;
      if (timeLimit    && now - ts       > timeLimit)                 return false;
      if (todayStart   && ts             < todayStart)                return false;

      if (search) {
        const q = search.toLowerCase();
        if (
          !camName.includes(q) &&
          !(a.zone || '').toLowerCase().includes(q) &&
          !aType.toLowerCase().includes(q) &&
          !String(a.objectId).toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });

    result.sort((a, b) => {
      if (sortBy === 'newest') return normalizeTs(b.timestamp) - normalizeTs(a.timestamp);
      if (sortBy === 'oldest') return normalizeTs(a.timestamp) - normalizeTs(b.timestamp);
      if (sortBy === 'dwell')  return (b.dwellTime || 0) - (a.dwellTime || 0);
      if (sortBy === 'camera') {
        return (cameraNameMap.get(a.cameraId) || a.cameraId)
          .localeCompare(cameraNameMap.get(b.cameraId) || b.cameraId);
      }
      return 0;
    });

    return result;
  }, [alerts, search, filterCamera, filterZone, filterType, filterTime, sortBy, cameraNameMap]);

  const activeFilterCount = [
    filterCamera,
    filterZone,
    filterType,
    filterTime !== 'all' ? filterTime : '',
  ].filter(Boolean).length;

  const clearFilters = () => {
    setFilterCamera('');
    setFilterZone('');
    setFilterType('');
    setFilterTime('all');
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">{t.alertTitle}</span>
          {unacknowledgedCount > 0 && (
            <span className="text-[10px] font-bold bg-red-600 text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {unacknowledgedCount}
            </span>
          )}
        </div>
        {alerts.length > 0 && (
          <button
            onClick={clearAlerts}
            className="text-[11px] text-gray-400 hover:text-red-400 transition-colors"
          >
            {t.alertAckAll}
          </button>
        )}
      </div>

      {/* ── Search + Sort row ── */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-700 flex-shrink-0">
        {/* Search */}
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Camera, zone, type, ID…"
            className="w-full bg-gray-900 border border-gray-700 rounded pl-5 pr-5 py-1 text-[11px] text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 leading-none"
            ><X className="w-3 h-3" /></button>
          )}
        </div>

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={`flex-shrink-0 flex items-center gap-1 px-1.5 py-1 rounded text-[11px] border transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'bg-blue-700/40 border-blue-600 text-blue-300'
              : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
          }`}
          title="Filters"
        >
          <SlidersHorizontal className="w-3 h-3" />
          {activeFilterCount > 0 && (
            <span className="text-[9px] font-bold bg-blue-600 text-white rounded-full w-3.5 h-3.5 flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortOption)}
          className="flex-shrink-0 bg-gray-800 border border-gray-700 rounded px-1 py-1 text-[10px] text-gray-300 focus:outline-none focus:border-blue-500"
          title="Sort"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* ── Filter panel ── */}
      {showFilters && (
        <div className="px-2 py-2 border-b border-gray-700 flex-shrink-0 space-y-1.5 bg-gray-800/40">

          {/* Type chips */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-9 flex-shrink-0">Type</span>
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setFilterType('')}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  !filterType ? 'bg-gray-600 border-gray-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
                }`}
              >All</button>
              {uniqueTypes.map((ty) => (
                <button
                  key={ty}
                  onClick={() => setFilterType(filterType === ty ? '' : ty)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    filterType === ty
                      ? 'bg-red-800 border-red-600 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
                  }`}
                >{ty}</button>
              ))}
            </div>
          </div>

          {/* Camera select */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-9 flex-shrink-0">Cam</span>
            <select
              value={filterCamera}
              onChange={(e) => setFilterCamera(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500"
            >
              <option value="">All Cameras</option>
              {uniqueCameras.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Zone select */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-9 flex-shrink-0">Zone</span>
            <select
              value={filterZone}
              onChange={(e) => setFilterZone(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500"
            >
              <option value="">All Zones</option>
              {uniqueZones.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </div>

          {/* Time chips */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-500 w-9 flex-shrink-0">Time</span>
            <div className="flex gap-1">
              {TIME_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setFilterTime(o.value)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    filterTime === o.value
                      ? 'bg-blue-700 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
                  }`}
                >{o.label}</button>
              ))}
            </div>
          </div>

          {/* Clear filters */}
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="text-[10px] text-red-400 hover:text-red-300 transition-colors inline-flex items-center gap-0.5"
            >
              <X className="w-2.5 h-2.5" /> Clear all filters
            </button>
          )}
        </div>
      )}

      {/* ── Result count ── */}
      <div className="px-3 py-1 flex-shrink-0 flex items-center justify-between border-b border-gray-700/50">
        <span className="text-[10px] text-gray-500">
          {loading ? 'Loading…' : `${filtered.length} / ${alerts.length} alerts`}
        </span>
        {filtered.length > 0 && (
          <span className="text-[10px] text-gray-600">
            {filtered.filter((a) => !a.acknowledged).length} unack'd
          </span>
        )}
      </div>

      {/* ── Alert list ── */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5 space-y-1.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 text-xs gap-2">
            <CheckCircle2 className="w-8 h-8 opacity-40" />
            <span>
              {alerts.length > 0 ? 'No alerts match current filters' : t.noAlerts}
            </span>
            {activeFilterCount > 0 && (
              <button onClick={clearFilters} className="text-blue-400 hover:text-blue-300 text-[10px]">
                Clear filters
              </button>
            )}
          </div>
        ) : (
          filtered.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              cameraName={cameraNameMap.get(alert.cameraId) || alert.cameraId}
            />
          ))
        )}
      </div>
    </div>
  );
}
