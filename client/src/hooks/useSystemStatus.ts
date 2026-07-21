import { useEffect, useState } from 'react';

// ── Analysis server connection status (streaming mode only) ──────────────────
// GET /api/analysis/client-status only exists when SERVER_MODE=streaming and
// ANALYSIS_SERVER_URL is set (server/src/index.js) — a non-OK response means
// "not applicable here", not an error.

export interface AnalysisClientStatus {
  connected:          boolean;
  circuitOpen:        boolean;
  total:              number;
  errors:             number;
  dropped:            number;
  lastError?:         string;
  timeoutMs?:         number;
  analysisServerUrl?: string;
}

export function useAnalysisClientStatus(): AnalysisClientStatus | null {
  const [status, setStatus] = useState<AnalysisClientStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/analysis/client-status');
        if (!res.ok) { setStatus(null); return; } // not streaming mode — endpoint absent
        const data: AnalysisClientStatus = await res.json();
        if (!cancelled) setStatus(data);
      } catch { if (!cancelled) setStatus(null); }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}

// ── ingest-daemon status ──────────────────────────────────────────────────────
// GET /api/ingest-status (server/src/index.js, 2026-07-21) — always 200; use
// `enabled` to tell "not using ingest-daemon" apart from "using it but down".

export interface IngestDaemonStatus {
  enabled: boolean;
  healthy: boolean;
  cameras?: number;
  error?:   string;
}

export function useIngestDaemonStatus(): IngestDaemonStatus | null {
  const [status, setStatus] = useState<IngestDaemonStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/ingest-status');
        if (!res.ok) { setStatus(null); return; }
        const data: IngestDaemonStatus = await res.json();
        if (!cancelled) setStatus(data);
      } catch { if (!cancelled) setStatus(null); }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}
