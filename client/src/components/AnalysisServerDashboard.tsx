import { useEffect, useState } from 'react';

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

function formatRelativeTime(iso: string | null) {
  if (!iso) return '없음';
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return '방금';
  const sec = Math.round(deltaMs / 1000);
  if (sec < 5) return '방금';
  if (sec < 60) return `${sec}초 전`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 전`;
  return `${Math.round(min / 60)}시간 전`;
}

function formatModuleLabel(name: string) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (v) => v.toUpperCase())
    .replace(/_/g, ' ');
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-700/70 bg-slate-900/70 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>
      <p className="mt-2 text-xs text-slate-400">{hint}</p>
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
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadMetrics() {
      try {
        const response = await fetch('/api/analysis/metrics');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as MetricsResponse;
        if (!active) return;
        setMetrics(data);
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
  const activeInputCount = cameraRows.filter((camera) => camera.streamPresent).length;
  const totalInputFps = cameraRows.reduce((sum, camera) => sum + camera.inputFps1s, 0);

  return (
    <div className="h-full overflow-auto rounded-[28px] border border-slate-700/70 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.18),_transparent_28%),linear-gradient(180deg,_rgba(15,23,42,0.96),_rgba(2,6,23,0.98))] px-6 py-6 text-slate-100 shadow-2xl shadow-black/30">
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
                    {connected ? '실시간 연결 정상' : '소켓 연결 끊김'}
                  </span>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-700/70 bg-slate-900/70 px-4 py-3">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Last response</p>
                <p className="mt-2 text-sm font-medium text-slate-200">{formatRelativeTime(metrics?.requests.lastResponseAt ?? null)}</p>
              </div>
            </div>
          </div>
        </section>

        {error && !metrics && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
            분석 메트릭을 아직 불러오지 못했습니다. 원인: {error}
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="최근 처리량"
            value={metrics ? `${metrics.recent.framesPerSec.toFixed(1)} fps` : '-'}
            hint={metrics ? `${metrics.recent.windowSec}초 창에서 ${metrics.recent.frames}프레임 처리` : '메트릭 대기 중'}
          />
          <StatCard
            label="입력 트래픽"
            value={metrics ? `${formatBytes(metrics.recent.bytesPerSec)}/s` : '-'}
            hint={metrics ? `누적 ${formatBytes(metrics.traffic.bytesReceivedTotal)}` : '메트릭 대기 중'}
          />
          <StatCard
            label="평균 추론 시간"
            value={metrics ? `${metrics.requests.avgProcessingMs.toFixed(1)} ms` : '-'}
            hint={metrics ? `현재 처리 중 ${metrics.requests.inFlight}건` : '메트릭 대기 중'}
          />
          <StatCard
            label="활성 컨텍스트"
            value={metrics ? String(metrics.activeCameras) : '-'}
            hint={metrics ? `실시간 입력 ${activeInputCount}대 / 총 입력 ${totalInputFps.toFixed(1)} fps` : '메트릭 대기 중'}
          />
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Analysis scope</p>
                <h3 className="mt-1 text-lg font-semibold text-slate-100">현재 분석 중인 항목</h3>
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
                <span className="text-sm text-slate-400">활성화된 분석 모듈이 없습니다.</span>
              )}
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">서비스 상태</p>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  <div className="flex items-center justify-between"><span>Detector</span><span className="text-emerald-300">{metrics?.services.detector ?? '-'}</span></div>
                  <div className="flex items-center justify-between"><span>Attribute</span><span className="text-emerald-300">{metrics?.services.attrPipeline ?? '-'}</span></div>
                  <div className="flex items-center justify-between"><span>Fire/Smoke</span><span className="text-emerald-300">{metrics?.services.fireSmokeService ?? '-'}</span></div>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">최근 1분 결과</p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-300">
                  <div><p className="text-slate-500">Detections</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.detections ?? 0}</p></div>
                  <div><p className="text-slate-500">Tracked</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.trackedObjects ?? 0}</p></div>
                  <div><p className="text-slate-500">Faces</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.faces ?? 0}</p></div>
                  <div><p className="text-slate-500">Loitering</p><p className="mt-1 text-lg font-semibold text-amber-300">{metrics?.recent.loitering ?? 0}</p></div>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Totals</p>
            <h3 className="mt-1 text-lg font-semibold text-slate-100">누적 분석 결과</h3>
            <div className="mt-5 space-y-3">
              {[
                ['Frames', metrics?.results.framesTotal ?? 0],
                ['Detections', metrics?.results.detectionsTotal ?? 0],
                ['Tracked Objects', metrics?.results.trackedObjectsTotal ?? 0],
                ['Faces', metrics?.results.facesTotal ?? 0],
                ['Fire / Smoke', metrics?.results.fireSmokeTotal ?? 0],
                ['Loitering', metrics?.results.loiteringTotal ?? 0],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3">
                  <span className="text-sm text-slate-400">{label}</span>
                  <span className="text-lg font-semibold text-slate-100">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-[24px] border border-slate-700/70 bg-slate-950/45 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Per source</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-100">연결된 분석 스트림별 부하</h3>
            </div>
            <span className="text-xs text-slate-400">마지막 응답 기준 최근 활동 순으로 정렬</span>
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800">
            <div className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] bg-slate-900/90 px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-slate-500">
              <span>Camera</span>
              <span>Input</span>
              <span>FPS(1s)</span>
              <span>Idle</span>
              <span>Frames</span>
              <span>Traffic</span>
              <span>Avg ms</span>
              <span>Result</span>
            </div>
            <div className="divide-y divide-slate-800/80">
              {cameraRows.length > 0 ? cameraRows.map((camera) => (
                <div key={camera.cameraId} className="grid grid-cols-[1.4fr_0.7fr_0.7fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] items-center gap-3 px-4 py-3 text-sm text-slate-300">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-100">{camera.cameraName || camera.cameraId}</p>
                    <p className="mt-1 text-xs text-slate-500">{camera.cameraId} · zones {camera.zoneCount} · last {formatRelativeTime(camera.lastFrameAt)}</p>
                  </div>
                  <span className={camera.streamPresent ? 'text-emerald-300' : 'text-slate-500'}>
                    {camera.streamPresent ? '있음' : '없음'}
                  </span>
                  <span className={camera.inputFps1s > 0 ? 'text-sky-300' : 'text-slate-500'}>{camera.inputFps1s.toFixed(1)}</span>
                  <span>{camera.idleSec}s</span>
                  <span>{camera.framesTotal}</span>
                  <span>{formatBytes(camera.bytesReceivedTotal)}</span>
                  <span>{camera.avgProcessingMs.toFixed(1)}</span>
                  <span className="text-xs text-slate-400">
                    det {camera.detectionsTotal} / face {camera.facesTotal} / loiter {camera.loiteringTotal}
                  </span>
                </div>
              )) : (
                <div className="px-4 py-6 text-sm text-slate-400">아직 분석 요청이 들어오지 않았습니다.</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}