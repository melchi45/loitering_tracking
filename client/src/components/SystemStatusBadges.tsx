import { useIngestDaemonStatus, useAnalysisClientStatus } from '../hooks/useSystemStatus';
import { useAuthStore } from '../stores/authStore';

// Small status pills for the Channel Group nav bar (2026-07-21) — shows
// ingest-daemon and Analysis-server connectivity so a silent failure (e.g.
// the ingest-daemon HTTP-unresponsive state in Design_RTSP_Capture_Backend.md
// §6.29.5) is visible on the dashboard instead of only surfacing as
// downstream WebRTC/camera symptoms.

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ok ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
  );
}

export function SystemStatusBadges() {
  const ingest   = useIngestDaemonStatus();
  const analysis = useAnalysisClientStatus();
  const { user, navigateTo, setPendingAdminSection } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  // Neither status applies to this deployment (e.g. combined mode with a
  // non-ingest-daemon capture backend and no remote analysis server) — render
  // nothing rather than an empty pill bar.
  if ((!ingest || !ingest.enabled) && !analysis) return null;

  const goToIngestPanel = () => {
    setPendingAdminSection('ingest');
    navigateTo('admin');
  };

  return (
    <div className="flex items-center gap-2">
      {ingest && ingest.enabled && (
        <div
          role={isAdmin ? 'button' : undefined}
          tabIndex={isAdmin ? 0 : undefined}
          onClick={isAdmin ? goToIngestPanel : undefined}
          onKeyDown={isAdmin ? (e) => { if (e.key === 'Enter' || e.key === ' ') goToIngestPanel(); } : undefined}
          className={`flex items-center gap-1.5 px-2 py-1 bg-gray-800/80 border border-gray-700 rounded-lg ${isAdmin ? 'cursor-pointer hover:border-gray-500 transition-colors' : ''}`}
          title={
            (ingest.healthy
              ? `ingest-daemon connected — ${ingest.cameras ?? 0} camera(s) registered`
              : `ingest-daemon unresponsive${ingest.error ? ` (${ingest.error})` : ''} — auto-recovery in progress`)
            + (isAdmin ? ' — click for details' : '')
          }
        >
          <StatusDot ok={ingest.healthy} />
          <span className={`text-xs whitespace-nowrap ${ingest.healthy ? 'text-green-400' : 'text-red-400'}`}>
            Ingest-Daemon{ingest.healthy && ingest.cameras != null ? ` (${ingest.cameras})` : ''}
          </span>
        </div>
      )}
      {analysis && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 bg-gray-800/80 border border-gray-700 rounded-lg"
          title={
            analysis.connected
              ? `Analysis server connected${analysis.analysisServerUrl ? ` — ${analysis.analysisServerUrl}` : ''}`
              : `Analysis server unreachable — circuit ${analysis.circuitOpen ? 'open' : 'closed'}${analysis.lastError ? ` (${analysis.lastError})` : ''}`
          }
        >
          <StatusDot ok={analysis.connected} />
          <span className={`text-xs whitespace-nowrap ${analysis.connected ? 'text-green-400' : 'text-red-400'}`}>
            Analysis
          </span>
        </div>
      )}
    </div>
  );
}
