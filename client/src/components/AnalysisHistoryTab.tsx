/**
 * AnalysisHistoryTab — shows stored AI detection events for one camera.
 *
 * Data source: GET /api/analysis/events?cameraId=&from=&to=&type=&limit=
 * Supports:
 *   - Preset time range buttons: 1H / 6H / 1D / 1W / All
 *   - Custom Start / End datetime-local inputs + Apply button
 *   - Loading spinner during fetch
 *   - Type filter: All / Loitering / Fire / Smoke
 *   - Thumbnail preview (cropData) on hover
 *   - Refresh button
 */

import { useEffect, useState } from 'react';
import { Footprints, Flame, Wind, RotateCcw, X, type LucideIcon } from 'lucide-react';
import { useI18n } from '../i18n';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnalysisEvent {
  id: string;
  type: 'fire' | 'smoke' | 'loitering' | string;
  cameraId: string;
  cameraName: string;
  timestamp: string;
  confidence?: number;
  objectId?: string;
  dwellTime?: number;
  zoneId?: string;
  zoneName?: string;
  riskScore?: number;
  bbox?: number[];
  cropData?: string;
}

type RangePreset = '1H' | '6H' | '1D' | '1W' | 'All';
type TypeFilter  = '' | 'loitering' | 'fire' | 'smoke';

const PRESET_MS: Record<RangePreset, number | null> = {
  '1H':  1 * 60 * 60 * 1000,
  '6H':  6 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W':  7 * 24 * 60 * 60 * 1000,
  'All': null,
};

const TYPE_ICON: Record<string, LucideIcon> = {
  loitering: Footprints,
  fire:       Flame,
  smoke:      Wind,
};
const TYPE_COLOR: Record<string, string> = {
  loitering: 'text-red-400',
  fire:       'text-orange-400',
  smoke:      'text-slate-400',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDwell(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 > 0 ? `${s % 60}s` : ''}`;
}

// SVG spinner
function Spinner() {
  return (
    <svg className="w-5 h-5 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path  className="opacity-75" fill="currentColor"
             d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AnalysisHistoryTab({ cameraId }: { cameraId: string }) {
  useI18n();

  const [events,      setEvents]      = useState<AnalysisEvent[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [preset,      setPreset]      = useState<RangePreset>('1D');
  const [typeFilter,  setTypeFilter]  = useState<TypeFilter>('');
  const [customStart, setCustomStart] = useState('');
  const [customEnd,   setCustomEnd]   = useState('');
  const [activeRange, setActiveRange] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [fetchKey,    setFetchKey]    = useState(0); // increment to trigger re-fetch
  const [hovered,     setHovered]     = useState<string | null>(null);

  // Compute from/to from preset
  useEffect(() => {
    if (preset === 'All') {
      // handled by Apply button for custom; if no custom inputs, fetch all
      if (!customStart && !customEnd) {
        setActiveRange({ from: null, to: null });
        setFetchKey(k => k + 1);
      }
      return;
    }
    const ms = PRESET_MS[preset];
    const from = ms ? new Date(Date.now() - ms).toISOString() : null;
    setActiveRange({ from, to: null });
    setFetchKey(k => k + 1);
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch on fetchKey change (preset or custom apply)
  useEffect(() => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ cameraId, limit: '500' });
    if (activeRange.from) params.set('from', activeRange.from);
    if (activeRange.to)   params.set('to',   activeRange.to);
    if (typeFilter)       params.set('type',  typeFilter);

    fetch(`/api/analysis/events?${params}`)
      .then(r => r.json())
      .then(d => setEvents(Array.isArray(d.events) ? d.events : []))
      .catch(e => setError(e.message || 'Fetch failed'))
      .finally(() => setLoading(false));
  }, [fetchKey, typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyCustomRange() {
    if (!customStart && !customEnd) return;
    setActiveRange({
      from: customStart ? new Date(customStart).toISOString() : null,
      to:   customEnd   ? new Date(customEnd).toISOString()   : null,
    });
    setFetchKey(k => k + 1);
  }

  function refresh() { setFetchKey(k => k + 1); }

  return (
    <div className="flex flex-col h-full text-[10px] select-none">

      {/* ── Control row ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/60
                      flex-shrink-0 bg-gray-900/60 flex-wrap">

        {/* Preset range buttons */}
        <div className="flex items-center gap-0.5">
          {(['1H', '6H', '1D', '1W', 'All'] as RangePreset[]).map(p => (
            <button
              key={p}
              onClick={() => { setPreset(p); if (p !== 'All') { setCustomStart(''); setCustomEnd(''); }}}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                preset === p
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value as TypeFilter); setFetchKey(k => k + 1); }}
          className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                     text-gray-300 focus:outline-none focus:border-emerald-500 cursor-pointer"
          title="Filter by detection type"
        >
          <option value="">All Types</option>
          <option value="loitering">Loitering</option>
          <option value="fire">Fire</option>
          <option value="smoke">Smoke</option>
        </select>

        <div className="flex-1" />

        {loading
          ? <Spinner />
          : <button onClick={refresh}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              title="Refresh"><RotateCcw className="w-3 h-3" /></button>
        }
        <span className="text-gray-600">{events.length}</span>
      </div>

      {/* ── Custom date range row (shown only when preset = All) ────────────── */}
      {preset === 'All' && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-700/40
                        flex-shrink-0 bg-gray-900/40 flex-wrap">
          <span className="text-gray-500 text-[9px]">From</span>
          <input
            type="datetime-local"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                       text-gray-300 focus:outline-none focus:border-emerald-500"
          />
          <span className="text-gray-500 text-[9px]">To</span>
          <input
            type="datetime-local"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[9px]
                       text-gray-300 focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={applyCustomRange}
            disabled={!customStart && !customEnd}
            className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40
                       text-white rounded text-[9px] font-bold transition-colors"
          >
            Apply
          </button>
          <button
            onClick={() => { setCustomStart(''); setCustomEnd(''); setActiveRange({ from: null, to: null }); setFetchKey(k => k + 1); }}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Clear range"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      )}

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      {error ? (
        <div className="flex-1 flex items-center justify-center text-red-400 text-xs">{error}</div>
      ) : loading ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-500">
          <Spinner />
          <span className="text-[9px]">Loading analysis events…</span>
        </div>
      ) : events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">
          No analysis events in this range.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0 divide-y divide-gray-800/50">
          {events.map(evt => (
            <div
              key={evt.id}
              className="flex items-start gap-2 px-2 py-1.5 hover:bg-gray-800/40 transition-colors relative"
              onMouseEnter={() => setHovered(evt.id)}
              onMouseLeave={() => setHovered(null)}
            >
              {/* Type icon */}
              <span className={`flex-shrink-0 ${TYPE_COLOR[evt.type] ?? 'text-gray-400'}`}>
                {(() => { const Icon = TYPE_ICON[evt.type]; return Icon ? <Icon className="w-3.5 h-3.5" /> : <span className="text-sm">●</span>; })()}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`font-bold text-[9px] uppercase tracking-wide ${TYPE_COLOR[evt.type] ?? 'text-gray-300'}`}>
                    {evt.type}
                  </span>
                  <span className="text-gray-600 text-[8px]">{fmtTime(evt.timestamp)}</span>
                </div>

                {/* Details */}
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                  {evt.confidence != null && (
                    <span className="text-gray-500 text-[8px]">
                      conf: <span className="text-gray-300">{(evt.confidence * 100).toFixed(0)}%</span>
                    </span>
                  )}
                  {evt.dwellTime != null && (
                    <span className="text-gray-500 text-[8px]">
                      dwell: <span className="text-yellow-300">{fmtDwell(evt.dwellTime)}</span>
                    </span>
                  )}
                  {evt.riskScore != null && (
                    <span className="text-gray-500 text-[8px]">
                      risk: <span className="text-red-400">{(evt.riskScore * 100).toFixed(0)}%</span>
                    </span>
                  )}
                  {evt.zoneName && (
                    <span className="text-gray-500 text-[8px]">
                      zone: <span className="text-purple-300">{evt.zoneName}</span>
                    </span>
                  )}
                  {evt.objectId && (
                    <span className="text-gray-500 text-[8px] font-mono">
                      #{String(evt.objectId).slice(0, 6)}
                    </span>
                  )}
                </div>
              </div>

              {/* Thumbnail on hover */}
              {hovered === evt.id && evt.cropData && (
                <img
                  src={evt.cropData}
                  alt="crop"
                  className="absolute right-2 top-1 w-16 h-16 object-cover rounded border border-gray-600 shadow-lg z-10"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
