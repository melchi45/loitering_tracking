import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSocket } from '../hooks/useSocket';

// ─── Types ────────────────────────────────────────────────────────────────────

type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
type LogSource = 'server' | 'ingest' | 'mediamtx';

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  t: number;
}

interface AdminLogPanelProps {
  apiFetch: (path: string, opts?: RequestInit) => Promise<unknown>;
  serverMode: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LEVEL_ORDER: LogLevel[] = ['ERROR', 'WARNING', 'INFO', 'DEBUG'];
const RUNTIME_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL', 'NONE'];
const MAX_LINES_OPTIONS = [100, 200, 500, 1000, 2000] as const;
type MaxLines = typeof MAX_LINES_OPTIONS[number];
const LS_MAX_LINES_KEY = 'lts_admin_log_maxLines';

const LEVEL_COLORS: Record<LogLevel, string> = {
  CRITICAL: 'text-red-200 bg-red-950/60',
  ERROR:    'text-red-300 bg-red-900/30',
  WARNING:  'text-yellow-300 bg-yellow-900/20',
  INFO:     'text-blue-300',
  DEBUG:    'text-gray-400',
};

const LEVEL_BADGE: Record<LogLevel, string> = {
  CRITICAL: 'bg-red-700 text-red-100',
  ERROR:    'bg-red-800/80 text-red-200',
  WARNING:  'bg-yellow-800/80 text-yellow-200',
  INFO:     'bg-blue-800/60 text-blue-200',
  DEBUG:    'bg-gray-700/60 text-gray-300',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminLogPanel({ apiFetch, serverMode }: AdminLogPanelProps) {
  const { socket, connected } = useSocket();

  const [source, setSource]               = useState<LogSource>('server');
  const [logs, setLogs]                   = useState<LogEntry[]>([]);
  const [visibleLevels, setVisibleLevels] = useState<Set<LogLevel>>(new Set(LEVEL_ORDER));
  const [runtimeLevel, setRuntimeLevel]   = useState('INFO');
  const [autoScroll, setAutoScroll]       = useState(true);
  const [paused, setPaused]               = useState(false);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');
  const [levelChanging, setLevelChanging] = useState(false);
  const [lastUpdate, setLastUpdate]       = useState<Date | null>(null);
  const [searchQuery, setSearchQuery]     = useState('');
  const [maxLines, setMaxLines]           = useState<MaxLines>(() => {
    const saved = localStorage.getItem(LS_MAX_LINES_KEY);
    const n = saved ? parseInt(saved, 10) : 500;
    return (MAX_LINES_OPTIONS as readonly number[]).includes(n) ? n as MaxLines : 500;
  });

  const logAreaRef  = useRef<HTMLDivElement>(null);
  const pausedRef   = useRef(paused);
  const sourceRef   = useRef(source);

  pausedRef.current = paused;
  sourceRef.current = source;

  const isStreaming = serverMode === 'streaming' || serverMode === 'combined';

  // ── Persist maxLines to localStorage ─────────────────────────────────────

  useEffect(() => {
    localStorage.setItem(LS_MAX_LINES_KEY, String(maxLines));
  }, [maxLines]);

  // ── Trim existing logs when maxLines decreases ────────────────────────────

  useEffect(() => {
    setLogs(prev => prev.length > maxLines ? prev.slice(-maxLines) : prev);
  }, [maxLines]);

  // ── Initial load on source change ─────────────────────────────────────────

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        const data = await apiFetch(`/admin/logs/recent?source=${source}&limit=200`) as {
          logs?: LogEntry[];
          level?: string;
        };
        setLogs((data.logs || []).slice(-maxLines));
        if (data.level) setRuntimeLevel(data.level);
        setLastUpdate(new Date());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load logs');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Socket.IO real-time (server source only) ──────────────────────────────

  useEffect(() => {
    if (source !== 'server' || !socket) return;
    socket.emit('admin:subscribe-logs');
  }, [socket, source]);

  useEffect(() => {
    if (!socket) return;

    const handler = (entry: LogEntry) => {
      if (pausedRef.current || sourceRef.current !== 'server') return;
      setLogs(prev => {
        const next = [...prev, entry];
        return next.length > maxLines ? next.slice(-maxLines) : next;
      });
      setLastUpdate(new Date());
    };

    socket.on('server:log', handler);
    return () => { socket.off('server:log', handler); };
  }, [socket]);

  // ── Poll ingest / mediamtx from log file ─────────────────────────────────

  useEffect(() => {
    if (source === 'server') return;

    const id = setInterval(async () => {
      if (pausedRef.current) return;
      try {
        const data = await apiFetch(`/admin/logs/recent?source=${source}&limit=200`) as {
          logs?: LogEntry[];
        };
        setLogs((data.logs || []).slice(-maxLines));
        setLastUpdate(new Date());
      } catch (_) { /* silently ignore poll errors */ }
    }, 2000);

    return () => clearInterval(id);
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-scroll: use scrollTop assignment to avoid document-level scroll ──

  useEffect(() => {
    if (!autoScroll || !logAreaRef.current) return;
    // Direct scrollTop assignment keeps the scroll inside the container div,
    // preventing the document from scrolling and hiding the toolbar.
    logAreaRef.current.scrollTop = logAreaRef.current.scrollHeight;
  }, [logs, autoScroll]);

  // Disable auto-scroll when user manually scrolls up
  const handleScroll = useCallback(() => {
    if (!logAreaRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logAreaRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (!atBottom) setAutoScroll(false);
    else setAutoScroll(true);
  }, []);

  // ── Runtime log level change ──────────────────────────────────────────────

  async function handleRuntimeLevelChange(level: string) {
    setLevelChanging(true);
    try {
      const data = await apiFetch('/admin/logs/level', {
        method: 'PATCH',
        body: JSON.stringify({ level }),
      }) as { level?: string };
      setRuntimeLevel(data.level || level);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to change level');
    } finally {
      setLevelChanging(false);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function toggleLevel(lvl: LogLevel) {
    setVisibleLevels(prev => {
      const next = new Set(prev);
      if (next.has(lvl)) { if (next.size > 1) next.delete(lvl); }
      else next.add(lvl);
      return next;
    });
  }

  function handleClear() {
    setLogs([]);
    setLastUpdate(null);
  }

  function handleScrollToBottom() {
    setAutoScroll(true);
    if (logAreaRef.current) {
      logAreaRef.current.scrollTop = logAreaRef.current.scrollHeight;
    }
  }

  const lowerQuery = searchQuery.toLowerCase();

  const filteredLogs = useMemo(() => {
    const byLevel = logs.filter(l => visibleLevels.has(l.level));
    if (!lowerQuery) return byLevel;
    return byLevel.filter(l => l.msg.toLowerCase().includes(lowerQuery) || l.ts.includes(searchQuery));
  }, [logs, visibleLevels, lowerQuery, searchQuery]);

  function handleDownload() {
    const text = filteredLogs.map(l => `${l.ts} [${l.level}] ${l.msg}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `lts-logs-${source}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Source options (filter by mode) ──────────────────────────────────────

  const sourceOptions: { id: LogSource; label: string; desc: string }[] = [
    { id: 'server',   label: 'Server',        desc: 'Real-time via Socket.IO' },
    ...(isStreaming ? [{ id: 'ingest' as LogSource, label: 'Ingest Daemon', desc: 'Polled from log file' }] : []),
    { id: 'mediamtx', label: 'MediaMTX',      desc: 'Polled from log file' },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  // Root is overflow-hidden so only the log area div scrolls internally.
  // All control sections are flex-shrink-0 to prevent them from being pushed off-screen.
  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Fixed control area (never scrolls) ── */}
      <div className="flex-shrink-0 flex flex-col gap-3 px-5 pt-5 pb-3 bg-gray-950">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Server Logs</h2>
            <p className="text-xs text-gray-500 mt-0.5">Real-time log viewer · last <span className="text-gray-400">{maxLines.toLocaleString()}</span> lines per source</p>
          </div>

          {/* Connection indicator */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-600'}`} />
            <span className={connected ? 'text-green-400' : 'text-gray-500'}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
            {lastUpdate && (
              <span className="text-gray-600 ml-2">
                updated {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {/* Error bar */}
        {error && (
          <div className="bg-red-900/40 border border-red-700/50 text-red-300 text-xs rounded-lg px-3 py-2 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-400 hover:text-red-200 ml-3">✕</button>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex flex-wrap gap-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">

          {/* Source selector */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Source</span>
            <div className="flex gap-1">
              {sourceOptions.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setSource(opt.id)}
                  title={opt.desc}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    source === opt.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="w-px bg-gray-700 self-stretch" />

          {/* Runtime level selector (only for server source) */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">
              Server Log Level
              {source !== 'server' && <span className="text-gray-600 ml-1">(server only)</span>}
            </span>
            <select
              value={runtimeLevel}
              onChange={e => handleRuntimeLevelChange(e.target.value)}
              disabled={source !== 'server' || levelChanging}
              className="bg-gray-800 text-gray-300 text-xs rounded-md px-2 py-1 border border-gray-700 disabled:opacity-40 cursor-pointer"
            >
              {RUNTIME_LEVELS.map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>

          <div className="w-px bg-gray-700 self-stretch" />

          {/* View level filters */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Show Levels</span>
            <div className="flex gap-1.5 items-center">
              {LEVEL_ORDER.map(lvl => (
                <button
                  key={lvl}
                  onClick={() => toggleLevel(lvl)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                    visibleLevels.has(lvl)
                      ? `${LEVEL_BADGE[lvl]} border-transparent`
                      : 'bg-transparent text-gray-600 border-gray-700 hover:border-gray-500'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>

          <div className="w-px bg-gray-700 self-stretch" />

          {/* Max Lines selector */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Max Lines</span>
            <select
              value={maxLines}
              onChange={e => setMaxLines(Number(e.target.value) as MaxLines)}
              className="bg-gray-800 text-gray-300 text-xs rounded-md px-2 py-1 border border-gray-700 cursor-pointer"
            >
              {MAX_LINES_OPTIONS.map(n => (
                <option key={n} value={n}>{n.toLocaleString()}</option>
              ))}
            </select>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Actions */}
          <div className="flex items-end gap-2">
            <button
              onClick={handleScrollToBottom}
              title="Scroll to bottom"
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                autoScroll
                  ? 'border-blue-600/50 text-blue-400 bg-blue-900/20'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              ↓ Auto-scroll
            </button>

            <button
              onClick={() => setPaused(p => !p)}
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                paused
                  ? 'border-yellow-600/50 text-yellow-400 bg-yellow-900/20 hover:bg-yellow-900/30'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>

            <button
              onClick={handleDownload}
              disabled={filteredLogs.length === 0}
              className="px-2 py-1 rounded text-xs border border-gray-700 text-gray-400 hover:text-white disabled:opacity-30 transition-colors"
            >
              ↓ Download
            </button>

            <button
              onClick={handleClear}
              className="px-2 py-1 rounded text-xs border border-red-800/50 text-red-400 hover:bg-red-900/20 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
          <span className="text-gray-500 text-xs select-none">🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search log messages…  (case-insensitive, matches timestamp or message)"
            className="flex-1 bg-transparent text-gray-300 text-xs placeholder-gray-600 outline-none min-w-0"
          />
          {searchQuery && (
            <>
              <span className="text-gray-500 text-[10px] shrink-0">
                {filteredLogs.length} match{filteredLogs.length !== 1 ? 'es' : ''}
              </span>
              <button
                onClick={() => setSearchQuery('')}
                className="text-gray-500 hover:text-gray-300 text-xs shrink-0"
                title="Clear search"
              >
                ✕
              </button>
            </>
          )}
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs text-gray-500 pb-1">
          <span>
            <span className="text-gray-300 font-medium">{filteredLogs.length}</span> / {logs.length} lines
            {paused && <span className="ml-2 text-yellow-500">⏸ Paused</span>}
            {searchQuery && <span className="ml-2 text-blue-400">🔍 filtered</span>}
          </span>
          {source !== 'server' && (
            <span className="text-gray-600">Polling every 2s from log file</span>
          )}
          <div className="flex gap-3 ml-auto">
            {LEVEL_ORDER.map(lvl => {
              const count = logs.filter(l => l.level === lvl).length;
              if (!count) return null;
              return (
                <span key={lvl} className={`${LEVEL_BADGE[lvl]} px-1.5 py-0.5 rounded text-[10px] font-medium`}>
                  {lvl}: {count}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Scrollable log area (only this div scrolls) ── */}
      <div
        ref={logAreaRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto mx-5 mb-5 rounded-xl bg-gray-950 border border-gray-800 font-mono text-[11px]"
      >
        {loading && (
          <div className="flex items-center justify-center h-20 text-gray-500 text-xs">
            Loading logs…
          </div>
        )}
        {!loading && filteredLogs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-24 gap-2 text-gray-600 text-xs">
            <span className="text-2xl opacity-40">📭</span>
            <span>
              {searchQuery
                ? `No matches for "${searchQuery}"`
                : `No log entries${source !== 'server' ? ' — log file may not exist yet' : ''}`}
            </span>
          </div>
        )}
        {filteredLogs.map((entry, i) => (
          <LogRow key={`${entry.t}-${i}`} entry={entry} highlight={lowerQuery} />
        ))}
      </div>
    </div>
  );
}

// ─── LogRow ───────────────────────────────────────────────────────────────────

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-400/30 text-yellow-200 rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {highlightText(text.slice(idx + query.length), query)}
    </>
  );
}

const LogRow = React.memo(function LogRow({ entry, highlight }: { entry: LogEntry; highlight: string }) {
  const rowBg    = LEVEL_COLORS[entry.level] ?? '';
  const badgeCls = LEVEL_BADGE[entry.level]  ?? '';

  return (
    <div className={`flex gap-2 px-3 py-0.5 border-b border-gray-900/60 hover:bg-white/5 leading-5 ${rowBg}`}>
      <span className="text-gray-600 shrink-0 select-none">{entry.ts}</span>
      <span className={`shrink-0 px-1 rounded text-[9px] font-bold self-center ${badgeCls}`}>
        {entry.level}
      </span>
      <span className="break-all whitespace-pre-wrap">{highlightText(entry.msg, highlight)}</span>
    </div>
  );
});
