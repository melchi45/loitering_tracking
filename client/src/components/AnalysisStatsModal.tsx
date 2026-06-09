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
          <h2 className="mt-1 text-lg font-semibold text-slate-50">분석 서버 운영 지표</h2>
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
            분석 메트릭을 불러오지 못했습니다. 원인: {state.message}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_0.75fr]">
          <section className="rounded-[24px] border border-amber-400/20 bg-slate-950/40 px-5 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Live pulse</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-50">실시간 처리 상태</h3>
                <p className="mt-2 text-sm text-slate-400">
                  최근 응답 {formatRelativeTime(metrics?.requests.lastResponseAt ?? null)} · 업타임 {formatDuration(metrics?.uptimeSec ?? 0)}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-300">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Modules</p>
                <p className="mt-2 font-medium text-slate-100">{metrics ? `${metrics.modules.count} active` : 'loading'}</p>
                <p className="mt-1 text-xs text-slate-500">{metrics?.modules.enabled.join(', ') || '분석 모듈 대기 중'}</p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="최근 처리량"
                value={metrics ? `${metrics.recent.framesPerSec.toFixed(1)} fps` : '-'}
                hint={metrics ? `${metrics.recent.windowSec}초 동안 ${metrics.recent.frames}프레임` : '메트릭 수집 중'}
              />
              <StatCard
                label="입력 트래픽"
                value={metrics ? `${formatBytes(metrics.recent.bytesPerSec)}/s` : '-'}
                hint={metrics ? `최근 창 ${formatBytes(metrics.recent.bytesReceived)}` : '메트릭 수집 중'}
              />
              <StatCard
                label="평균 추론 시간"
                value={metrics ? `${metrics.requests.avgProcessingMs.toFixed(1)} ms` : '-'}
                hint={metrics ? `동시 처리 ${metrics.requests.inFlight}건` : '메트릭 수집 중'}
              />
              <StatCard
                label="오류율 감시"
                value={metrics ? `${metrics.requests.errors}` : '-'}
                hint={metrics ? `누적 요청 ${metrics.requests.total}건` : '메트릭 수집 중'}
              />
              <StatCard
                label="카메라 입력"
                value={metrics ? `${activeInputCount}/${cameraRows.length}` : '-'}
                hint={metrics ? `총 ${totalInputFps.toFixed(1)} fps 입력 중` : '메트릭 수집 중'}
              />
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">최근 결과</p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-300">
                  <div><p className="text-slate-500">Detections</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.detections ?? 0}</p></div>
                  <div><p className="text-slate-500">Tracked</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.trackedObjects ?? 0}</p></div>
                  <div><p className="text-slate-500">Faces</p><p className="mt-1 text-lg font-semibold text-slate-100">{metrics?.recent.faces ?? 0}</p></div>
                  <div><p className="text-slate-500">Loitering</p><p className="mt-1 text-lg font-semibold text-amber-300">{metrics?.recent.loitering ?? 0}</p></div>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">서비스 상태</p>
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
            <h3 className="mt-1 text-lg font-semibold text-slate-100">누적 분석 집계</h3>
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
              <h3 className="mt-1 text-lg font-semibold text-slate-100">분석 입력원별 운영 지표</h3>
            </div>
            <span className="text-xs text-slate-400">마지막 프레임 시간과 누적 결과를 함께 표시합니다.</span>
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
                  <span className="text-xs text-slate-400">det {camera.detectionsTotal} / face {camera.facesTotal} / loiter {camera.loiteringTotal}</span>
                </div>
              )) : (
                <div className="px-4 py-8 text-center text-sm text-slate-500">
                  아직 집계된 분석 입력원이 없습니다.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}