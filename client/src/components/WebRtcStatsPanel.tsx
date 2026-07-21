import type { RxSample, RxCodecInfo, IceStats } from '../hooks/useWebRTC';
import { BUFFER_MS_WARN, BUFFER_MS_BAD } from '../hooks/useWebRTC';

interface Props {
  iceStats: IceStats | null;
  history:  RxSample[];
  codec:    RxCodecInfo;
}

function metricColor(value: number, warn: number, bad: number): string {
  if (value < warn) return 'text-green-400';
  if (value < bad) return 'text-yellow-400';
  return 'text-red-400';
}

function candidateColor(t: string): string {
  return t === 'relay' ? 'text-orange-400' : t === 'srflx' ? 'text-yellow-400' : 'text-green-400';
}

function candidateLabel(t: string): string {
  return t === 'relay' ? 'TURN relay' : t === 'srflx' ? 'STUN mapped' : t === 'host' ? 'host (LAN)' : t;
}

function fmtBps(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  if (bitsPerSecond >= 1_000) return `${(bitsPerSecond / 1_000).toFixed(1)} kbps`;
  return `${Math.round(bitsPerSecond)} bps`;
}

/**
 * YouTube "stats for nerds"-style label:value grid — that overlay is plain
 * one-line-per-metric text, not a graph, so this mirrors that instead of
 * spending vertical space on bar charts. One grid row per fact; every value
 * still comes from the same ICE/getStats() sources as before.
 */
export default function WebRtcStatsPanel({ iceStats, history, codec }: Props) {
  const last = history.length > 0 ? history[history.length - 1] : null;
  const hasRes = !!last && last.resWidth > 0 && last.resHeight > 0;

  return (
    <div className="grid grid-cols-[38px_1fr] gap-x-1.5 gap-y-0.5">
      {iceStats ? (
        <>
          <span className="text-gray-500">Local</span>
          <span className="truncate" title={candidateLabel(iceStats.localType)}>
            <span className={candidateColor(iceStats.localType)}>[{iceStats.localType}]</span>
            {' '}{iceStats.localAddress}:{iceStats.localPort}
          </span>
          <span className="text-gray-500">Remote</span>
          <span className="truncate" title={candidateLabel(iceStats.remoteType)}>
            <span className={candidateColor(iceStats.remoteType)}>[{iceStats.remoteType}]</span>
            {' '}{iceStats.remoteAddress}:{iceStats.remotePort}
          </span>
          <span className="text-gray-500">Rate</span>
          <span>↑ {fmtBps(iceStats.sentBps)} ↓ {fmtBps(iceStats.receivedBps)}</span>
        </>
      ) : (
        <span className="text-gray-500 col-span-2">Collecting stats…</span>
      )}

      {last && (
        <>
          <span className="text-gray-500">Res</span>
          <span>{hasRes ? `${last.resWidth}×${last.resHeight}` : '–'} {Math.round(last.fps)}fps</span>
          <span className="text-gray-500">Codec</span>
          <span className="truncate">{codec.video || '–'} / {codec.audio || '–'}</span>
          <span className="text-gray-500">Speed</span>
          <span>{Math.round(last.videoKbps + last.audioKbps)} kbps</span>
          <span className="text-gray-500">Buffer</span>
          <span className={metricColor(last.bufferMs, BUFFER_MS_WARN, BUFFER_MS_BAD)}>{Math.round(last.bufferMs)} ms</span>
          <span className="text-gray-500">RTT</span>
          <span className={metricColor(last.rttMs, 100, 300)}>{Math.round(last.rttMs)} ms</span>
          <span className="text-gray-500">Loss</span>
          <span className={metricColor(last.lossPct, 0.5, 2)}>{last.lossPct.toFixed(1)}%</span>
        </>
      )}
    </div>
  );
}
