import type { RxSample, RxCodecInfo, IceStats } from '../hooks/useWebRTC';
import { BUFFER_MS_WARN, BUFFER_MS_BAD, LATENCY_MS_WARN, LATENCY_MS_BAD } from '../hooks/useWebRTC';
import Sparkline from './Sparkline';

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
 * YouTube "stats for nerds"-style panel: label:value grid plus (2026-07-21)
 * small per-metric timeline graphs for the three that benefit most from a
 * trend at a glance — Network Activity (combined rx bitrate), Buffer Health,
 * and Latency — mirroring that overlay's own Network Activity / Buffer
 * Health graphs. Every value still comes from the same ICE/getStats()
 * sources as before; RxSample already carries ~2min of history
 * (RX_HISTORY_MAX in useWebRTC.ts) so no extra sampling was needed.
 */
export default function WebRtcStatsPanel({ iceStats, history, codec }: Props) {
  const last = history.length > 0 ? history[history.length - 1] : null;
  const hasRes = !!last && last.resWidth > 0 && last.resHeight > 0;
  const kbpsHistory     = history.map(s => s.videoKbps + s.audioKbps);
  const bufferMsHistory = history.map(s => s.bufferMs);
  const latencyHistory  = history.map(s => s.latencyMs);
  const dropped = last ? Math.max(0, last.framesReceived - last.framesDecoded) : 0;

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

          <span className="text-gray-500">Frames</span>
          <span className={dropped > 0 ? 'text-yellow-400' : undefined}>
            {last.framesDecoded} decoded, {dropped} dropped
          </span>

          <span className="text-gray-500">Codec</span>
          <div className="truncate">
            <div>{codec.video || '–'} / {codec.audio || '–'}</div>
            {(codec.videoDetail || codec.audioDetail) && (
              <div className="text-[10px] text-gray-500 truncate">
                {codec.videoDetail}{codec.videoDetail && codec.audioDetail ? ' · ' : ''}{codec.audioDetail}
              </div>
            )}
          </div>

          <span className="text-gray-500">Speed</span>
          <div>
            <div>{Math.round(last.videoKbps + last.audioKbps)} kbps</div>
            <Sparkline values={kbpsHistory} colorClass="text-cyan-400" />
          </div>

          <span className="text-gray-500">Buffer</span>
          <div>
            <div className={metricColor(last.bufferMs, BUFFER_MS_WARN, BUFFER_MS_BAD)}>{Math.round(last.bufferMs)} ms</div>
            <Sparkline
              values={bufferMsHistory}
              colorClass={metricColor(last.bufferMs, BUFFER_MS_WARN, BUFFER_MS_BAD)}
              thresholdRatio={BUFFER_MS_BAD / Math.max(BUFFER_MS_BAD, ...bufferMsHistory, 1)}
            />
          </div>

          <span className="text-gray-500">Latency</span>
          <div>
            <div className={metricColor(last.latencyMs, LATENCY_MS_WARN, LATENCY_MS_BAD)}>{Math.round(last.latencyMs)} ms</div>
            <Sparkline
              values={latencyHistory}
              colorClass={metricColor(last.latencyMs, LATENCY_MS_WARN, LATENCY_MS_BAD)}
              thresholdRatio={LATENCY_MS_BAD / Math.max(LATENCY_MS_BAD, ...latencyHistory, 1)}
            />
          </div>

          <span className="text-gray-500">RTT</span>
          <span className={metricColor(last.rttMs, 100, 300)}>{Math.round(last.rttMs)} ms</span>
          <span className="text-gray-500">Loss</span>
          <span className={metricColor(last.lossPct, 0.5, 2)}>{last.lossPct.toFixed(1)}%</span>
        </>
      )}
    </div>
  );
}
