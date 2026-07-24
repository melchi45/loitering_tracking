import type { UmpStatsSnapshot, UmpSample } from '../hooks/useUmpStats';
import Sparkline from './Sparkline';
import HeatStrip from './HeatStrip';

// Distinct from WebRtcStatsPanel's line-identity colors so the two panels
// never look like they're sharing a legend even if a user has both open
// side-by-side (mixed streamingMode grid).
const DECODE_FPS_COLOR = 'text-teal-400';
const BITRATE_COLOR    = 'text-sky-400';
const DROP_COLOR       = 'text-orange-400';
const LATENCY_MS_WARN  = 150; // same thresholds as WebRtcStatsPanel's LATENCY_MS_WARN/BAD —
const LATENCY_MS_BAD   = 400; // "high latency" means the same thing regardless of transport.

function metricColor(value: number, warn: number, bad: number): string {
  if (value < warn) return 'text-green-400';
  if (value < bad) return 'text-yellow-400';
  return 'text-red-400';
}

function fmtBps(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  if (bitsPerSecond >= 1_000) return `${(bitsPerSecond / 1_000).toFixed(1)} kbps`;
  return `${Math.round(bitsPerSecond)} bps`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

interface Props {
  stats:   UmpStatsSnapshot | null;
  history: UmpSample[];
}

/**
 * UMP counterpart to WebRtcStatsPanel.tsx — same YouTube "stats for nerds"
 * label:value grid + sparkline layout, sourced from <ump-player>'s
 * 'statistics' CustomEvent (see useUmpStats.ts) instead of RTCPeerConnection
 * getStats(). Toggled from the same top-right corner button CameraView.tsx
 * already uses for WebRTC's ICE panel.
 */
export default function UmpStatsPanel({ stats, history }: Props) {
  const decodedFpsHistory  = history.map(s => s.decodedFps);
  const bitrateHistory     = history.map(s => s.bitrateBpsMean);
  const dropHistory        = history.map(s => s.dropFramesMean);
  const latencyMsHistory   = history.map(s => s.latencySec * 1000);

  if (!stats) {
    return <div className="text-gray-500 text-[9px]">Collecting stats…</div>;
  }

  const latencyMs = stats.latencySec * 1000;

  return (
    <div className="grid grid-cols-[38px_1fr] gap-x-1.5 gap-y-0.5">
      <span className="text-gray-500">Res</span>
      <div>
        {stats.width > 0 ? `${stats.width}×${stats.height}` : '–'} {Math.round(stats.decodedFps)}fps
        {stats.decodedFpsMean > 0 && <span className="text-gray-500"> (avg {stats.decodedFpsMean.toFixed(1)})</span>}
      </div>

      <span className="text-gray-500">Codec</span>
      <div className="truncate">{stats.videoCodec || '–'} / {stats.audioCodec || '–'}</div>

      <span className="text-gray-500">Frames</span>
      <div className={stats.dropFramesCount > 0 ? 'text-yellow-400' : undefined}>
        {stats.videoFrames} recv, {stats.dropFramesCount} dropped
      </div>

      {/* decodedBytesTotal is a cumulative byte counter, not a rate — it only
          ever goes up, so it's shown as a plain running total, not graphed.
          decodedBpsMean is the true averaged bitrate (Mean() over the real
          per-tick delta) and is what actually varies tick to tick, so it
          drives both the headline number and the sparkline. */}
      <span className="text-gray-500">Rate</span>
      <div>
        <div className="flex items-center gap-1">
          <span className={BITRATE_COLOR}>●</span>
          <span>{fmtBps(stats.decodedBpsMean)}</span>
          <span className="text-gray-500">avg</span>
        </div>
        <Sparkline values={bitrateHistory} colorClass={BITRATE_COLOR} />
        <div className="text-gray-500">Total {fmtBytes(stats.decodedBytesTotal)}</div>
      </div>

      <span className="text-gray-500">FPS</span>
      <div>
        <div className="flex items-center gap-1">
          <span className={DECODE_FPS_COLOR}>●</span>
          <span>{Math.round(stats.decodedFps)} fps</span>
        </div>
        <Sparkline values={decodedFpsHistory} colorClass={DECODE_FPS_COLOR} />
      </div>

      <span className="text-gray-500">Latency</span>
      <div>
        <span className={metricColor(latencyMs, LATENCY_MS_WARN, LATENCY_MS_BAD)}>
          {Math.round(latencyMs)}ms
        </span>
        {stats.latencyLimitSec != null && (
          <span className="text-gray-500"> / max {Math.round(stats.latencyLimitSec * 1000)}ms</span>
        )}
        <HeatStrip values={latencyMsHistory} colorClass={metricColor(latencyMs, LATENCY_MS_WARN, LATENCY_MS_BAD)} />
      </div>

      <span className="text-gray-500">Drops</span>
      <div>
        <span className={stats.dropFramesMean > 0 ? DROP_COLOR : undefined}>
          {stats.dropFramesMean.toFixed(2)}/sec
        </span>
        <HeatStrip values={dropHistory} colorClass={DROP_COLOR} />
      </div>

      {stats.chunkSize != null && (
        <>
          <span className="text-gray-500">Chunk</span>
          <div>#{stats.chunkSize}</div>
        </>
      )}
    </div>
  );
}
