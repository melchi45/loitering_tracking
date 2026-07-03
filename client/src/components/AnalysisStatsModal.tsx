import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import type { Translations } from '../i18n/translations/en';

type MetricsResponse = {
  mode: string;
  uptimeSec: number;
  activeCameras: number;
  services: {
    detector: string;
    attrPipeline: string;
    fireSmokeService: string;
  };
  modules: {
    enabled: string[];
    count: number;
  };
  requests: {
    total: number;
    inFlight: number;
    errors: number;
    lastRequestAt: string | null;
    lastResponseAt: string | null;
    avgProcessingMs: number;
  };
  traffic: {
    bytesReceivedTotal: number;
    megabytesTotal: number;
  };
  results: {
    framesTotal: number;
    detectionsTotal: number;
    trackedObjectsTotal: number;
    facesTotal: number;
    fireSmokeTotal: number;
    loiteringTotal: number;
  };
  recent: {
    windowSec: number;
    frames: number;
    framesPerSec: number;
    bytesReceived: number;
    bytesPerSec: number;
    megabytesReceived: number;
    avgProcessingMs: number;
    detections: number;
    trackedObjects: number;
    faces: number;
    fireSmoke: number;
    loitering: number;
  };
  cameras: Array<{
    cameraId: string;
    cameraName?: string;
    idleSec: number;
    streamPresent: boolean;
    framesLast1s: number;
    inputFps1s: number;
    zoneCount: number;
    framesTotal: number;
    bytesReceivedTotal: number;
    avgProcessingMs: number;
    detectionsTotal: number;
    trackedObjectsTotal: number;
    facesTotal: number;
    fireSmokeTotal: number;
    loiteringTotal: number;
    lastFrameAt: string | null;
  }>;
};

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: MetricsResponse };

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatRelativeTime(iso: string | null, t: Translations) {
  if (!iso) return t.timeNone;
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return t.timeJustNow;
  const sec = Math.round(deltaMs / 1000);
  if (sec < 5) return t.timeJustNow;
  if (sec < 60) return t.timeSecAgo(sec);
  const min = Math.round(sec / 60);
  if (min < 60) return t.timeMinAgo(min);
  return t.timeHourAgo(Math.round(min / 60));
}

function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return '0m';
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  return `${hour}h ${min % 60}m`;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
      <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>
      <p className="mt-2 text-xs text-slate-400">{hint}</p>
    </div>
  );
}

export default function AnalysisStatsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<FetchState>({ status: 'idle' });

  useEffect(() => {
    if (!open) return;

    let active = true;

    async function loadMetrics() {
      setState((prev) => prev.status === 'ok' ? prev : { status: 'loading' });
      try {
        const response = await fetch('/api/analysis/metrics');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as MetricsResponse;
        if (!active) return;
        setState({ status: 'ok', data });
      } catch (err) {
        if (!active) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'unknown error' });
      }
    }

    loadMetrics();
    const timer = window.setInterval(loadMetrics, 2000);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const metrics = state.status === 'ok' ? state.data : null;
  const cameraRows = metrics?.cameras ?? [];
  const activeInputCount = cameraRows.filter((camera) => camera.streamPresent).length;
  const totalInputFps = cameraRows.reduce((sum, camera) => sum + camera.inputFps1s, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-sm"
      aria-modal="true"
      role="dialog"
      aria-label="Analysis Statistics Panel"
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-amber-300">Analysis statistics</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-50">{t.statsModalTitle}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setState({ status: 'loading' })}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            onClick={async () => {
              setState((prev) => prev.status === 'ok' ? prev : { status: 'loading' });
              try {
                const response = await fetch('/api/analysis/metrics');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json() as MetricsResponse;
                setState({ status: 'ok', data });
              } catch (err) {
                setState({ status: 'error', message: err instanceof Error ? err.message : 'unknown error' });
              }
            }}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            title="Refresh"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 ${state.status === 'loading' ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            title="Close (Esc)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {state.status === 'error' && !metrics && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
            {t.statsLoadError(state.message)}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_0.75fr]">
          <section className="rounded-[24px] border border-amber-400/20 bg-slate-950/40 px-5 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Live pulse</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-50">{t.statsRealtimeStatus}</h3>
                <p className="mt-2 text-sm text-slate-400">
                  {t.statsLastResponseLabel} {formatRelativeTime(metrics?.requests.lastResponseAt ?? null, t)} · {t.statsUptimeLabel} {formatDuration(metrics?.uptimeSec ?? 0)}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-300">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Modules</p>
                <p className="mt-2 font-medium text-slate-100">{metrics ? `${metrics.modules.count} active` : 'loading'}</p>
                <p className="mt-1 text-xs text-slate-500">{metrics?.modules.enabled.join(', ') || t.statsModulesWaiting}</p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={t.statsRecentThroughput}
                value={metrics ? `${metrics.recent.framesPerSec.toFixed(1)} fps` : '-'}
                hint={metrics ? t.statsWindowFrames(metrics.recent.windowSec, metrics.recent.frames) : t.statsMetricsCollecting}
              />
              <StatCard
                label={t.statsInputTraffic}
                value={metrics ? `${formatBytes(metrics.recent.bytesPerSec)}/s` : '-'}
                hint={metrics ? t.statsRecentWindowBytes(formatBytes(metrics.recent.bytesReceived)) : t.statsMetricsCollecting}
              />
              <StatCard
                label={t.statsAvgInferenceTime}
                value={metrics ? `${metrics.requests.avgProcessingMs.toFixed(1)} ms` : '-'}
                hint={metrics ? t.statsConcurrentRequests(metrics.requests.inFlight) : t.statsMetricsCollecting}
              />
              <StatCard
                label={t.statsErrorRateWatch}
                value={metrics ? `${metrics.requests.errors}` : '-'}
                hint={metrics ? t.statsTotalRequests(metrics.requests.total) : t.statsMetricsCollecting}
              />
              <StatCard
                label={t.statsCameraInput}
                value={metrics ? `${activeInputCount}/${cameraRows.length}` : '-'}
                hint={metrics ? t.statsTotalFpsInput(totalInputFps.toFixed(1)) : t.statsMetricsCollecting}
              />
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{t.statsRecentResults}</p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-300">
                  <div><p className="text-slate-500">Detections</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.detections ?? 0}</p></div>
                  <div><p className="text-slate-500">Tracked</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.trackedObjects ?? 0}</p></div>
                  <div><p className="text-slate-500">Faces</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.faces ?? 0}</p></div>
                  <div><p className="text-slate-500">Loitering</p><p className="mt-1 text-lg font-semibold text-amber-300">{metrics?.recent.loitering ?? 0}</p></div>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{t.serviceStatus}</p>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  <div className="flex items-center justify-between"><span>Detector</span><span className="text-emerald-300">{metrics?.services.detector ?? '-'}</span></div>
                  <div className="flex items-center justify-between"><span>Attribute</span><span className="text-emerald-300">{metrics?.services.attrPipeline ?? '-'}</span></div>
                  <div className="flex items-center justify-between"><span>Fire/Smoke</span><span className="text-emerald-300">{metrics?.services.fireSmokeService ?? '-'}</span></div>
                  <div className="flex items-center justify-between"><span>Active contexts</span><span className="text-slate-100">{metrics?.activeCameras ?? 0}</span></div>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Cumulative totals</p>
            <h3 className="mt-1 text-lg font-semibold text-slate-100">{t.statsCumulativeTotals}</h3>
            <div className="mt-5 space-y-3">
              {[
                ['Frames', metrics?.results.framesTotal ?? 0],
                ['Detections', metrics?.results.detectionsTotal ?? 0],
                ['Tracked Objects', metrics?.results.trackedObjectsTotal ?? 0],
                ['Faces', metrics?.results.facesTotal ?? 0],
                ['Fire / Smoke', metrics?.results.fireSmokeTotal ?? 0],
                ['Loitering', metrics?.results.loiteringTotal ?? 0],
                ['Traffic', metrics ? formatBytes(metrics.traffic.bytesReceivedTotal) : '-'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3">
                  <span className="text-sm text-slate-400">{label}</span>
                  <span className="text-lg font-semibold text-slate-100">{value}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="mt-4 rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Per source</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-100">{t.statsPerSourceMetrics}</h3>
            </div>
            <span className="text-xs text-slate-400">{t.statsPerSourceHint}</span>
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800">
            <div className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.8fr_0.8fr_0.9fr_0.8fr_1fr] bg-slate-900/90 px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">
              <span>Source</span>
              <span>Input</span>
              <span>FPS(1s)</span>
              <span>Idle</span>
              <span>Frames</span>
              <span>Traffic</span>
              <span>Avg ms</span>
              <span>Results</span>
            </div>
            <div className="divide-y divide-slate-800/80">
              {metrics && metrics.cameras.length > 0 ? metrics.cameras.map((camera) => (
                <div key={camera.cameraId} className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.8fr_0.8fr_0.9fr_0.8fr_1fr] items-center gap-3 px-4 py-3 text-sm text-slate-300">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-100">{camera.cameraName || camera.cameraId}</p>
                    <p className="mt-1 text-xs text-slate-500">{camera.cameraId} · zones {camera.zoneCount} · last {formatRelativeTime(camera.lastFrameAt, t)}</p>
                  </div>
                  <span className={camera.streamPresent ? 'text-emerald-300' : 'text-slate-500'}>
                    {camera.streamPresent ? t.streamPresentYes : t.streamPresentNo}
                  </span>
                  <span className={camera.inputFps1s > 0 ? 'text-sky-300' : 'text-slate-500'}>{camera.inputFps1s.toFixed(1)}</span>
                  <span>{camera.idleSec}s</span>
                  <span>{camera.framesTotal}</span>
                  <span>{formatBytes(camera.bytesReceivedTotal)}</span>
                  <span>{camera.avgProcessingMs.toFixed(1)}</span>
                  <span className="text-xs text-slate-400">det {camera.detectionsTotal} / face {camera.facesTotal} / loiter {camera.loiteringTotal}</span>
                </div>
              )) : (
                <div className="px-4 py-8 text-center text-sm text-slate-500">
                  {t.statsNoInputSources}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}