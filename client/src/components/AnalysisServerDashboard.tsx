import { useEffect, useState } from 'react';
import AnalysisDetectionPanel from './AnalysisDetectionPanel';
import AnalysisLivePanel from './AnalysisLivePanel';
import { useI18n } from '../i18n';
import type { Translations } from '../i18n/translations/en';

type GpuInfo = {
  index: number;
  utilization: number;
  memUsed: number;
  memTotal: number;
};

type SystemMetrics = {
  cpu: {
    usagePct: number | null;
    cores: number;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedPct: number;
    processRss: number;
    processHeap: number;
  };
  gpu: GpuInfo[] | null;
};

type OnnxModel = {
  name: string;
  path: string;
  service: string;
  loaded: boolean;
  exists: boolean;
};

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
  models?: OnnxModel[];
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
  system?: SystemMetrics;
};

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

function formatModuleLabel(name: string) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (v) => v.toUpperCase())
    .replace(/_/g, ' ');
}

const FPS_HISTORY_MAX = 30; // 30 samples × 2s poll = 60s rolling window

function FpsSparkline({ data }: { data: number[] }) {
  const W = 88, H = 26;
  if (data.length < 2) {
    return <span className="text-[10px] text-slate-600">—</span>;
  }
  const max = Math.max(...data, 1);
  const step = W / (data.length - 1);
  const pts = data.map((v, i): [number, number] => [
    +(i * step).toFixed(1),
    +(H - 2 - (v / max) * (H - 4)).toFixed(1),
  ]);
  const linePts = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const areaPath =
    `M${pts[0][0]},${H} ` +
    pts.map(([x, y]) => `L${x},${y}`).join(' ') +
    ` L${pts[pts.length - 1][0]},${H} Z`;
  const [lx, ly] = pts[pts.length - 1];
  const dotColor = data[data.length - 1] > 0 ? 'rgb(56,189,248)' : 'rgb(100,116,139)';
  return (
    <svg width={W} height={H} className="overflow-visible">
      <path d={areaPath} fill="rgba(56,189,248,0.08)" />
      <polyline
        points={linePts}
        fill="none"
        stroke="rgba(56,189,248,0.75)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lx} cy={ly} r={2.5} fill={dotColor} />
    </svg>
  );
}

function StatCard({
  label,
  value,
  hint,
  onClick,
  accentClass,
  clickHint,
}: {
  label: string;
  value: string;
  hint: string;
  onClick?: () => void;
  accentClass?: string;
  clickHint: string;
}) {
  const base = 'rounded-2xl border border-slate-700/70 bg-slate-900/70 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]';
  const interactive = onClick ? 'cursor-pointer hover:border-amber-400/40 hover:bg-slate-800/80 transition-colors' : '';
  return (
    <div className={`${base} ${interactive}`} onClick={onClick}>
      <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${accentClass ?? 'text-slate-100'}`}>{value}</p>
      <p className="mt-2 text-xs text-slate-400">{hint}</p>
      {onClick && (
        <p className="mt-1 text-[10px] text-amber-400/60">{clickHint}</p>
      )}
    </div>
  );
}

function UsageGauge({
  label,
  pct,
  sub,
  colorClass,
}: {
  label: string;
  pct: number | null;
  sub: string;
  colorClass: string;
}) {
  const safePct = pct != null && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</p>
        <span className="text-sm font-semibold text-slate-100">
          {safePct != null ? `${safePct}%` : '—'}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-700/60">
        <div
          className={`h-full rounded-full transition-all duration-500 ${colorClass}`}
          style={{ width: safePct != null ? `${safePct}%` : '0%' }}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-slate-500">{sub}</p>
    </div>
  );
}

export default function AnalysisServerDashboard({
  connected,
  title,
  description,
}: {
  connected: boolean;
  title: string;
  description: string;
}) {
  const { t } = useI18n();
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fpsHistory, setFpsHistory] = useState<Map<string, number[]>>(new Map());
  const [showEventHistory,   setShowEventHistory]   = useState(false);
  const [showLiveDetections, setShowLiveDetections] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadMetrics() {
      try {
        const response = await fetch('/api/analysis/metrics');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as MetricsResponse;
        if (!active) return;
        setMetrics(data);
        setFpsHistory(prev => {
          const next = new Map(prev);
          for (const cam of data.cameras) {
            const hist = next.get(cam.cameraId) ?? [];
            const updated = [...hist, cam.inputFps1s];
            next.set(cam.cameraId, updated.length > FPS_HISTORY_MAX ? updated.slice(-FPS_HISTORY_MAX) : updated);
          }
          return next;
        });
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'unknown error');
      }
    }

    loadMetrics();
    const timer = window.setInterval(loadMetrics, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const enabledModules = metrics?.modules.enabled ?? [];
  const cameraRows = metrics?.cameras ?? [];

  return (
    <div className="relative h-full overflow-auto rounded-[28px] border border-slate-700/70 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.18),_transparent_28%),linear-gradient(180deg,_rgba(15,23,42,0.96),_rgba(2,6,23,0.98))] px-6 py-6 text-slate-100 shadow-2xl shadow-black/30">

      {/* ── Event History overlay (배회/화재/연기 이벤트 DB 히스토리) ── */}
      {showEventHistory && (
        <div className="absolute inset-0 z-20 rounded-[28px] overflow-hidden">
          <AnalysisDetectionPanel onClose={() => setShowEventHistory(false)} />
        </div>
      )}

      {/* ── Live Detections overlay (실시간 감지 피드) ── */}
      {showLiveDetections && (
        <div className="absolute inset-0 z-20 rounded-[28px] overflow-hidden">
          <AnalysisLivePanel onClose={() => setShowLiveDetections(false)} />
        </div>
      )}
      <div className="flex flex-col gap-6">
        <section className="rounded-[24px] border border-amber-400/20 bg-slate-950/40 px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-400/30 bg-amber-500/10 text-amber-300">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M19.8 15.3l1.402 1.402c1 1 .03 2.798-1.332 2.798H4.13c-1.36 0-2.332-1.797-1.332-2.798L4 15.3" />
                  </svg>
                </span>
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.22em] text-amber-300">ANALYSIS FABRIC</p>
                  <h2 className="mt-1 text-2xl font-semibold text-slate-50">{title}</h2>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-300">{description}</p>
            </div>

            <div className="grid min-w-[280px] grid-cols-2 gap-3">
              <div className="rounded-2xl border border-slate-700/70 bg-slate-900/70 px-4 py-3">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Socket</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.9)]' : 'bg-rose-500'}`} />
                  <span className={`text-sm font-medium ${connected ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {connected ? t.dashRealtimeConnected : t.dashSocketDisconnected}
                  </span>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-700/70 bg-slate-900/70 px-4 py-3">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Last response</p>
                <p className="mt-2 text-sm font-medium text-slate-200">{formatRelativeTime(metrics?.requests.lastResponseAt ?? null, t)}</p>
              </div>
            </div>
          </div>
        </section>

        {error && !metrics && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
            {t.dashMetricsLoadError(error ?? '')}
          </div>
        )}

        {metrics?.system && (
          <section className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
            <div className="mb-4">
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">System resources</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-100">{t.dashResourceUsage}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <UsageGauge
                label="CPU"
                pct={metrics.system.cpu.usagePct}
                sub={t.dashCores(metrics.system.cpu.cores)}
                colorClass={
                  (metrics.system.cpu.usagePct ?? 0) >= 90 ? 'bg-rose-500' :
                  (metrics.system.cpu.usagePct ?? 0) >= 70 ? 'bg-amber-400' :
                  'bg-sky-500'
                }
              />
              <UsageGauge
                label="System RAM"
                pct={metrics.system.memory.usedPct}
                sub={`${formatBytes(metrics.system.memory.totalBytes - metrics.system.memory.freeBytes)} / ${formatBytes(metrics.system.memory.totalBytes)}`}
                colorClass={
                  metrics.system.memory.usedPct >= 90 ? 'bg-rose-500' :
                  metrics.system.memory.usedPct >= 75 ? 'bg-amber-400' :
                  'bg-emerald-500'
                }
              />
              <UsageGauge
                label="Process RSS"
                pct={Math.round(metrics.system.memory.processRss / metrics.system.memory.totalBytes * 100)}
                sub={formatBytes(metrics.system.memory.processRss)}
                colorClass="bg-violet-500"
              />
              {metrics.system.gpu && metrics.system.gpu.length > 0 ? (
                metrics.system.gpu.map(gpu => (
                  <div key={gpu.index} className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                    <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                      GPU {gpu.index}
                    </p>
                    <div className="mt-2 space-y-2">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-slate-500">Util</span>
                          <span className="text-xs font-semibold text-slate-100">{gpu.utilization}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/60">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              gpu.utilization >= 90 ? 'bg-rose-500' :
                              gpu.utilization >= 70 ? 'bg-amber-400' : 'bg-green-500'
                            }`}
                            style={{ width: `${Math.min(100, gpu.utilization)}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-slate-500">VRAM</span>
                          <span className="text-xs font-semibold text-slate-100">
                            {Math.round(gpu.memUsed / gpu.memTotal * 100)}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/60">
                          <div
                            className="h-full rounded-full bg-purple-500 transition-all duration-500"
                            style={{ width: `${Math.min(100, Math.round(gpu.memUsed / gpu.memTotal * 100))}%` }}
                          />
                        </div>
                        <p className="mt-1 text-[10px] text-slate-500">{gpu.memUsed} / {gpu.memTotal} MiB</p>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4 flex items-center">
                  <p className="text-xs text-slate-500">{t.dashGpuNone}<br />{t.dashGpuNotDetected}</p>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={t.statsRecentThroughput}
            value={metrics ? `${metrics.recent.framesPerSec.toFixed(1)} fps` : '-'}
            hint={metrics ? t.dashWindowFramesProcessed(metrics.recent.windowSec, metrics.recent.frames) : t.dashMetricsWaiting}
            clickHint={t.dashClickForDetails}
          />
          <StatCard
            label={t.statsInputTraffic}
            value={metrics ? `${formatBytes(metrics.recent.bytesPerSec)}/s` : '-'}
            hint={metrics ? t.dashCumulativeBytes(formatBytes(metrics.traffic.bytesReceivedTotal)) : t.dashMetricsWaiting}
            clickHint={t.dashClickForDetails}
          />
          <StatCard
            label={t.dashDetectionEventsCumulative}
            value={metrics ? String(metrics.results.detectionsTotal + metrics.results.fireSmokeTotal) : '-'}
            hint={metrics ? t.dashLoiterFireSmokeCounts(metrics.results.loiteringTotal, metrics.results.fireSmokeTotal) : t.dashMetricsWaiting}
            accentClass="text-amber-300"
            onClick={() => setShowLiveDetections(true)}
            clickHint={t.dashClickForDetails}
          />
          <StatCard
            label={t.dashAlertsLoiterCumulative}
            value={metrics ? String(metrics.results.loiteringTotal) : '-'}
            hint={metrics ? t.dashLoiterAlertCount : t.dashMetricsWaiting}
            accentClass="text-rose-300"
            onClick={() => setShowEventHistory(true)}
            clickHint={t.dashClickForDetails}
          />
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Analysis scope</p>
                <h3 className="mt-1 text-lg font-semibold text-slate-100">{t.dashCurrentlyAnalyzing}</h3>
              </div>
              <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
                {metrics ? `${metrics.modules.count} modules enabled` : 'loading'}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {enabledModules.length > 0 ? enabledModules.map((moduleName) => (
                <span
                  key={moduleName}
                  className="rounded-full border border-sky-400/20 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-200"
                >
                  {formatModuleLabel(moduleName)}
                </span>
              )) : (
                <span className="text-sm text-slate-400">{t.dashNoActiveModules}</span>
              )}
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{t.serviceStatus}</p>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  <div className="flex items-center justify-between"><span>Detector</span><span className="text-emerald-300">{metrics?.services.detector ?? '-'}</span></div>
                  <div className="flex items-center justify-between"><span>Attribute</span><span className="text-emerald-300">{metrics?.services.attrPipeline ?? '-'}</span></div>
                  <div className="flex items-center justify-between"><span>Fire/Smoke</span><span className="text-emerald-300">{metrics?.services.fireSmokeService ?? '-'}</span></div>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{t.dashLoadedOnnxModels}</p>
                <div className="mt-3 space-y-1.5">
                  {metrics?.models && metrics.models.length > 0 ? metrics.models.map((m) => (
                    <div key={m.service} className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-slate-300" title={m.path}>{m.name}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        m.loaded && m.exists
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : !m.exists
                          ? 'bg-rose-500/15 text-rose-300'
                          : 'bg-amber-500/15 text-amber-300'
                      }`}>
                        {m.loaded && m.exists ? 'loaded' : !m.exists ? 'missing' : 'not ready'}
                      </span>
                    </div>
                  )) : (
                    <p className="text-xs text-slate-500">{metrics ? t.dashNoModelLoaded : t.dashWaitingEllipsis}</p>
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{t.dashRecentOneMinResults}</p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-300">
                  <div><p className="text-slate-500">Detections</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.detections ?? 0}</p></div>
                  <div><p className="text-slate-500">Tracked</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.trackedObjects ?? 0}</p></div>
                  <div
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setShowEventHistory(true)}
                  >
                    <p className="text-slate-500">Fire/Smoke</p>
                    <p className="mt-1 text-lg font-semibold text-orange-300">{metrics?.recent.fireSmoke ?? 0}</p>
                  </div>
                  <div
                    className="cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setShowEventHistory(true)}
                  >
                    <p className="text-slate-500">Loitering</p>
                    <p className="mt-1 text-lg font-semibold text-amber-300">{metrics?.recent.loitering ?? 0}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Totals</p>
            <h3 className="mt-1 text-lg font-semibold text-slate-100">{t.dashCumulativeResults}</h3>
            <div className="mt-5 space-y-3">
              {([
                { label: 'Frames',          value: metrics?.results.framesTotal ?? 0,          showHist: false, valueClass: 'text-slate-100' },
                { label: 'Detections',      value: metrics?.results.detectionsTotal ?? 0,       showHist: true,  valueClass: 'text-sky-200' },
                { label: 'Tracked Objects', value: metrics?.results.trackedObjectsTotal ?? 0,   showHist: false, valueClass: 'text-slate-100' },
                { label: 'Faces',           value: metrics?.results.facesTotal ?? 0,            showHist: false, valueClass: 'text-slate-100' },
                { label: 'Fire / Smoke',    value: metrics?.results.fireSmokeTotal ?? 0,        showHist: true,  valueClass: 'text-orange-300' },
                { label: 'Loitering',       value: metrics?.results.loiteringTotal ?? 0,        showHist: true,  valueClass: 'text-amber-300' },
              ] as const).map(({ label, value, showHist, valueClass }) => {
                return (
                  <div
                    key={label}
                    className={`flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 ${showHist ? 'cursor-pointer hover:border-slate-600 transition-colors' : ''}`}
                    onClick={showHist ? () => setShowEventHistory(true) : undefined}
                  >
                    <span className="text-sm text-slate-400">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className={`text-lg font-semibold ${valueClass}`}>{value}</span>
                      {showHist && <span className="text-[10px] text-slate-600">→</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {metrics?.models && metrics.models.length > 0 && (
          <section className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
            <div className="mb-4">
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">ONNX Models</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-100">{t.dashLoadedAiModels}</h3>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {metrics.models.map((model) => {
                const serviceLabel: Record<string, string> = {
                  detector:        t.dashModelDetector,
                  ppe:             t.dashModelPpe,
                  'face-detect':   t.dashModelFaceDetect,
                  'face-embed':    t.dashModelFaceEmbed,
                  'fire-smoke':    t.dashModelFireSmoke,
                };
                const label = serviceLabel[model.service] ?? model.service;
                const ok   = model.loaded && model.exists;
                const warn = model.exists && !model.loaded;
                return (
                  <div
                    key={model.path}
                    className={`flex items-start gap-3 rounded-2xl border px-4 py-3 ${
                      ok   ? 'border-emerald-500/20 bg-emerald-950/20' :
                      warn ? 'border-amber-500/20 bg-amber-950/20' :
                             'border-rose-500/20 bg-rose-950/20'
                    }`}
                  >
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      ok   ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' :
                      warn ? 'bg-amber-400' :
                             'bg-rose-500'
                    }`} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-100" title={model.path}>{model.name}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{label}</p>
                      <p className={`mt-0.5 text-[10px] ${
                        ok   ? 'text-emerald-400' :
                        warn ? 'text-amber-400' :
                               'text-rose-400'
                      }`}>
                        {!model.exists ? t.dashFileMissing : !model.loaded ? t.dashLoadFailed : t.dashLoadedOk}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Per source</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-100">{t.dashConnectedStreamLoad}</h3>
            </div>
            <span className="text-xs text-slate-400">{t.dashSortedByRecentActivity}</span>
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800">
            <div className="grid grid-cols-[1.4fr_0.7fr_1.4fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] bg-slate-900/90 px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">
              <span>Camera</span>
              <span>Input</span>
              <span>{t.dashFpsTrend}</span>
              <span>Idle</span>
              <span>Frames</span>
              <span>Traffic</span>
              <span>Avg ms</span>
              <span>Result</span>
            </div>
            <div className="divide-y divide-slate-800/80">
              {cameraRows.length > 0 ? cameraRows.map((camera) => (
                <div key={camera.cameraId} className="grid grid-cols-[1.4fr_0.7fr_1.4fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] items-center gap-3 px-4 py-3 text-sm text-slate-300">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-100">{camera.cameraName || camera.cameraId}</p>
                    <p className="mt-1 text-xs text-slate-500">{camera.cameraId} · zones {camera.zoneCount} · last {formatRelativeTime(camera.lastFrameAt, t)}</p>
                  </div>
                  <span className={camera.streamPresent ? 'text-emerald-300' : 'text-slate-500'}>
                    {camera.streamPresent ? t.streamPresentYes : t.streamPresentNo}
                  </span>
                  <div className="flex flex-col gap-1">
                    <span className={camera.inputFps1s > 0 ? 'text-sky-300 tabular-nums' : 'text-slate-500'}>
                      {camera.inputFps1s.toFixed(1)} fps
                    </span>
                    <FpsSparkline data={fpsHistory.get(camera.cameraId) ?? []} />
                  </div>
                  <span>{camera.idleSec}s</span>
                  <span>{camera.framesTotal}</span>
                  <span>{formatBytes(camera.bytesReceivedTotal)}</span>
                  <span>{camera.avgProcessingMs.toFixed(1)}</span>
                  <span className="text-xs text-slate-400">
                    det {camera.detectionsTotal} / face {camera.facesTotal} / loiter {camera.loiteringTotal}
                  </span>
                </div>
              )) : (
                <div className="px-4 py-6 text-sm text-slate-400">{t.dashNoRequestsYet}</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}