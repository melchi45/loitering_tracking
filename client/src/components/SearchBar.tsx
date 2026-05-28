import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearch, type SearchResult } from '../hooks/useSearch';

// ── Type badge ──────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: SearchResult['_type'] }) {
  const map: Record<string, string> = {
    detection: 'bg-blue-700/60 text-blue-200',
    alert:     'bg-red-700/60 text-red-200',
    face:      'bg-purple-700/60 text-purple-200',
    match:     'bg-cyan-700/60 text-cyan-200',
  };
  return (
    <span className={`text-[8px] font-bold rounded px-1.5 py-0.5 uppercase tracking-wide flex-shrink-0 ${map[type] ?? 'bg-gray-700 text-gray-300'}`}>
      {type}
    </span>
  );
}

// ── Crop / photo thumbnail ───────────────────────────────────────────────────

function Thumb({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return (
    <div className="w-10 h-12 flex-shrink-0 bg-gray-700 rounded flex items-center justify-center">
      <span className="text-[9px] text-gray-600">?</span>
    </div>
  );
  return (
    <img
      src={src}
      alt={alt ?? 'crop'}
      className="w-10 h-12 flex-shrink-0 object-cover rounded border border-gray-600 bg-gray-700"
      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

// ── Single result row ───────────────────────────────────────────────────────

function ResultRow({
  result,
  onClick,
}: {
  result: SearchResult;
  onClick: (r: SearchResult) => void;
}) {
  const ts = result.timestamp || result.createdAt;
  const timeLabel = ts
    ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  const dateLabel = ts
    ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
    : '';

  const imgSrc = result.cropData || result.photoData || result.liveCropData || result.thumbnail;

  return (
    <button
      onClick={() => onClick(result)}
      className="w-full flex items-start gap-2 px-3 py-2 hover:bg-gray-700/60 transition-colors text-left"
    >
      <Thumb src={imgSrc} alt={result.className || result.name || result.type} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <TypeBadge type={result._type} />

          {/* Main label */}
          {result._type === 'detection' && (
            <span className={`text-[10px] font-bold ${result.isLoitering ? 'text-red-400' : 'text-green-400'}`}>
              {result.className}
            </span>
          )}
          {result._type === 'alert' && (
            <span className="text-[10px] font-bold text-orange-400">{result.type}</span>
          )}
          {result._type === 'face' && (
            <span className="text-[10px] font-bold text-purple-300">{result.name}</span>
          )}
          {result._type === 'match' && (
            <span className="text-[10px] font-bold text-cyan-300">{result.identity}</span>
          )}

          {/* Loitering badge */}
          {result.isLoitering && (
            <span className="text-[7px] font-bold bg-red-600 text-white rounded px-1">LOITER</span>
          )}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {result.cameraName && (
            <span className="text-[9px] text-gray-400 truncate">{result.cameraName}</span>
          )}
          {result.zoneName && (
            <span className="text-[9px] text-gray-500">· {result.zoneName}</span>
          )}
          {result.dwellTime != null && result.dwellTime > 0 && (
            <span className="text-[9px] text-yellow-600">· {Math.round(result.dwellTime)}s</span>
          )}
          {result.confidence != null && (
            <span className="text-[9px] text-gray-600">· {(result.confidence * 100).toFixed(0)}%</span>
          )}
          {result._type === 'face' && result.galleryType && (
            <span className="text-[9px] text-gray-500">· {result.galleryType}</span>
          )}
          {result._type === 'match' && (
            <>
              {result.galleryType && <span className="text-[9px] text-gray-500">· {result.galleryType}</span>}
              {result.matchScore != null && (
                <span className="text-[9px] text-cyan-600">· {(result.matchScore * 100).toFixed(1)}%</span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="text-right flex-shrink-0">
        <div className="text-[9px] text-gray-300">{timeLabel}</div>
        <div className="text-[8px] text-gray-600">{dateLabel}</div>
      </div>
    </button>
  );
}

// ── Search Bar ──────────────────────────────────────────────────────────────

interface SearchBarProps {
  /** Called when user clicks a result; parent should navigate to the correct tab */
  onNavigate?: (result: SearchResult) => void;
  /** Called when user clicks the fullscreen expand button */
  onFullscreen?: (currentQuery: string) => void;
}

export function SearchBar({ onNavigate, onFullscreen }: SearchBarProps) {
  const [query,   setQuery]   = useState('');
  const [open,    setOpen]    = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);

  const { results, total, loading, error, search, clear } = useSearch(300);

  // Close panel when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setFocused(false);
        setQuery('');
        clear();
        inputRef.current?.blur();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [clear]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (v.trim().length > 0) {
      setOpen(true);
      search(v);
    } else {
      setOpen(false);
      clear();
    }
  }, [search, clear]);

  const handleResultClick = useCallback((r: SearchResult) => {
    setOpen(false);
    setQuery('');
    clear();
    onNavigate?.(r);
  }, [clear, onNavigate]);

  const showPanel = open && focused && query.trim().length > 0;

  return (
    <div ref={wrapperRef} className="relative">
      {/* Input */}
      <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border transition-colors ${
        focused
          ? 'bg-gray-700 border-blue-500'
          : 'bg-gray-700/60 border-gray-600 hover:border-gray-500'
      }`}>
        {loading ? (
          <svg className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => { setFocused(true); if (query.trim()) setOpen(true); }}
          placeholder="Search alerts, detections, faces…"
          className="bg-transparent text-xs text-gray-200 placeholder-gray-500 outline-none w-48 min-w-0"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setOpen(false); clear(); inputRef.current?.focus(); }}
            className="text-gray-500 hover:text-gray-300 flex-shrink-0 text-[10px]"
          >
            ✕
          </button>
        )}
        {/* Fullscreen expand button */}
        {onFullscreen && (
          <button
            onClick={() => { setOpen(false); onFullscreen(query); }}
            title="Open full-screen search"
            className="text-gray-500 hover:text-gray-300 flex-shrink-0 ml-0.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        )}
      </div>

      {/* Results panel */}
      {showPanel && (
        <div className="absolute top-full right-0 mt-1 w-80 bg-gray-800 border border-gray-600 rounded-lg shadow-2xl z-[200] overflow-hidden">
          {/* Panel header */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700 bg-gray-900/60">
            <span className="text-[9px] text-gray-400 uppercase tracking-wide">
              {loading ? 'Searching…' : error ? 'Error' : `${total} result${total !== 1 ? 's' : ''}`}
            </span>
            {error && <span className="text-[9px] text-red-400 truncate max-w-48">{error}</span>}
          </div>

          {/* Results list */}
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-700/40">
            {!loading && !error && results.length === 0 && (
              <div className="px-3 py-4 text-center text-[10px] text-gray-500">
                No results found for &ldquo;{query}&rdquo;
              </div>
            )}
            {results.map((r) => (
              <ResultRow key={`${r._type}-${r.id}`} result={r} onClick={handleResultClick} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
