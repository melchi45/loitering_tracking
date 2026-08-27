import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, RotateCw, Save } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogFileEntry {
  name: string;
  sizeBytes: number;
  mtime: number;
}

interface LogStats {
  config: { dir: string; maxFileSizeMB: number; maxFiles: number };
  effectiveDir: string;
  fallbackActive: boolean;
  ipcAvailable: boolean;
  serverId: string;
  dirWritable: boolean;
  dirWriteError: string | null;
  currentFile: { name: string; sizeBytes: number } | null;
  files: LogFileEntry[];
  totalFiles: number;
  totalBytes: number;
}

interface LogRotationPanelProps {
  apiFetch: (path: string, opts?: RequestInit) => Promise<unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LogRotationPanel({ apiFetch }: LogRotationPanelProps) {
  const [stats,      setStats]      = useState<LogStats | null>(null);
  const [error,      setError]      = useState('');
  const [saving,     setSaving]     = useState(false);
  const [rotating,   setRotating]   = useState(false);
  const [dirInput,        setDirInput]        = useState('');
  const [maxSizeInput,    setMaxSizeInput]    = useState('');
  const [maxFilesInput,   setMaxFilesInput]   = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/admin/system/logs') as LogStats;
      setStats(data);
      // Only seed the form fields on first load — don't clobber what the
      // admin is actively typing on every 10s poll.
      setDirInput(prev => prev || data.config.dir);
      setMaxSizeInput(prev => prev || String(data.config.maxFileSizeMB));
      setMaxFilesInput(prev => prev || String(data.config.maxFiles));
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load log stats');
    }
  }, [apiFetch]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 10000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const maxFileSizeMB = Number(maxSizeInput);
      const maxFiles = Number(maxFilesInput);
      const data = await apiFetch('/admin/system/logs', {
        method: 'PUT',
        body: JSON.stringify({ dir: dirInput, maxFileSizeMB, maxFiles }),
      }) as LogStats;
      setStats(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save log config');
    } finally {
      setSaving(false);
    }
  }

  async function handleRotateNow() {
    setRotating(true);
    setError('');
    try {
      await apiFetch('/admin/system/logs/rotate', { method: 'POST' });
      setTimeout(load, 1000); // give the supervisor a moment to finish the rename before refreshing
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to trigger rotation');
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Log Storage &amp; Rotation</div>
          {stats?.serverId && (
            <div className="text-[10px] text-gray-600 mt-0.5">
              Server: <span className="font-mono text-gray-500">{stats.serverId}</span> — settings apply only to this instance
            </div>
          )}
        </div>
        {stats && !stats.ipcAvailable && (
          <span className="text-[10px] text-yellow-500 inline-flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Dev mode — saved but not applied live (production only)
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-300 text-xs">{error}</div>
      )}

      {stats?.fallbackActive && (
        <div className="mb-3 p-3 bg-yellow-900/20 border border-yellow-800 rounded-lg text-yellow-300 text-xs flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Configured directory isn't writable — falling back to {stats.effectiveDir}
        </div>
      )}

      {stats && !stats.dirWritable && (
        <div className="mb-3 p-3 bg-red-900/20 border border-red-800 rounded-lg text-red-300 text-xs flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            This process cannot write to {stats.effectiveDir} right now
            {stats.dirWriteError ? `: ${stats.dirWriteError}` : ''} — no console/terminal
            access needed, this is checked live on every load.
          </span>
        </div>
      )}

      {stats && stats.dirWritable && !stats.currentFile && (
        <div className="mb-3 p-3 bg-blue-900/20 border border-blue-800 rounded-lg text-blue-300 text-xs flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            This process CAN write to {stats.effectiveDir}, but no log file exists there yet —
            if you expect one, the process actually writing logs (the production supervisor)
            may be using a different directory than what's configured here.
          </span>
        </div>
      )}

      {/* ── Config form ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Directory</label>
          <div className="relative">
            <FolderOpen className="w-3.5 h-3.5 text-gray-600 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={dirInput}
              onChange={e => setDirInput(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-2 py-1.5 text-xs text-white font-mono"
              placeholder="/var/log/lts"
            />
          </div>
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Max File Size (MB)</label>
          <input
            type="number"
            min={1}
            max={10240}
            value={maxSizeInput}
            onChange={e => setMaxSizeInput(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white"
          />
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Max Retained Files (#)</label>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxFilesInput}
            onChange={e => setMaxFilesInput(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-xs font-medium text-white"
        >
          <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleRotateNow}
          disabled={rotating || !stats?.ipcAvailable}
          title={!stats?.ipcAvailable ? 'Only available when running via npm run start|streaming|analysis' : undefined}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 border border-gray-700 rounded-lg text-xs font-medium text-white"
        >
          <RotateCw className="w-3.5 h-3.5" /> {rotating ? 'Rotating…' : 'Rotate Now'}
        </button>
      </div>

      {/* ── Current state ────────────────────────────────────────────────────── */}
      {stats && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-gray-800 rounded-lg p-2">
              <div className="text-gray-500">Active File</div>
              <div className="text-gray-200 font-mono truncate">
                {stats.currentFile ? `${stats.currentFile.name} (${fmtBytes(stats.currentFile.sizeBytes)})` : '—'}
              </div>
            </div>
            <div className="bg-gray-800 rounded-lg p-2">
              <div className="text-gray-500">Archived Files</div>
              <div className="text-gray-200">{stats.totalFiles} · {fmtBytes(stats.totalBytes)} total</div>
            </div>
          </div>

          {stats.files.length > 0 && (
            <div className="max-h-40 overflow-y-auto border border-gray-800 rounded-lg">
              <table className="w-full text-[11px]">
                <thead className="bg-gray-800/60 text-gray-500 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1 font-normal">File</th>
                    <th className="text-right px-2 py-1 font-normal">Size</th>
                    <th className="text-right px-2 py-1 font-normal">Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.files.map(f => (
                    <tr key={f.name} className="border-t border-gray-800/60">
                      <td className="px-2 py-1 font-mono text-gray-300 truncate max-w-[200px]">{f.name}</td>
                      <td className="px-2 py-1 text-right text-gray-400">{fmtBytes(f.sizeBytes)}</td>
                      <td className="px-2 py-1 text-right text-gray-500">{fmtTime(f.mtime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
