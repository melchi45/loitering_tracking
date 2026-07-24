import type { RxSample, RxCodecInfo, IceStats } from '../hooks/useWebRTC';
import { BUFFER_MS_WARN, BUFFER_MS_BAD, LATENCY_MS_WARN, LATENCY_MS_BAD } from '../hooks/useWebRTC';
import Sparkline from './Sparkline';
import HeatStrip from './HeatStrip';

// Fixed line-identity colors for the combined multi-series graphs below —
// intentionally distinct from the green/yellow/red used by metricColor(),
// so "which line is this" (identity) never gets confused with "is this
// value healthy" (threshold state). See MultiSparkline.tsx.
const THROUGHPUT_UP_COLOR    = 'text-sky-400';
const THROUGHPUT_DOWN_COLOR  = 'text-cyan-400';
const THROUGHPUT_SPEED_COLOR = 'text-indigo-400';
const TIMING_BUFFER_COLOR    = 'text-violet-400';
const TIMING_LATENCY_COLOR   = 'text-fuchsia-400';
const TIMING_RTT_COLOR       = 'text-pink-400';
const FPS_COLOR              = 'text-teal-400';
const RTT_MS_WARN   = 100;
const RTT_MS_BAD    = 300;
const LOSS_PCT_WARN = 0.5;
const LOSS_PCT_BAD  = 2;

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
 * small per-metric timeline graphs. Metrics that share a unit are grouped —
 * Throughput (Rate↑/Rate↓/Speed, kbps) and Timing (Buffer/Latency/RTT, ms) —
 * each as 3 stacked HeatStrip rows instead of 3 lines on a shared axis
 * (2026-07-22, replacing an earlier log-scale MultiSparkline attempt): this
 * panel is a ~220px overlay pinned to a video tile, not a dashboard, so
 * there's no headroom for a line chart tall enough to keep 3 overlaid lines
 * (one of them small-magnitude, e.g. Rate↑ or LAN-range RTT) readable.
 * HeatStrip encodes magnitude as color opacity instead of line position, so
 * it stays legible at a few px tall regardless of any series' absolute
 * scale — see HeatStrip.tsx. Every value still comes from the same
 * ICE/getStats() sources as before; RxSample already carries ~2min of
 * history (RX_HISTORY_MAX in useWebRTC.ts) so no extra sampling was needed.
 */
export default function WebRtcStatsPanel({ iceStats, history, codec }: Props) {
  const last = history.length > 0 ? history[history.length - 1] : null;
  const hasRes = !!last && last.resWidth > 0 && last.resHeight > 0;
  const sentBpsHistory     = history.map(s => s.sentBps);
  const receivedBpsHistory = history.map(s => s.receivedBps);
  const kbpsHistory        = history.map(s => s.videoKbps + s.audioKbps);
  const bufferMsHistory    = history.map(s => s.bufferMs);
  const latencyHistory     = history.map(s => s.latencyMs);
  const rttHistory         = history.map(s => s.rttMs);
  const fpsHistory         = history.map(s => s.fps);
  const lossHistory        = history.map(s => s.lossPct);
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
        </>
      ) : (
        <span className="text-gray-500 col-span-2">Collecting stats…</span>
      )}

      {last && (
        <>
          <span className="text-gray-500">Res</span>
          <div>
            <div>{hasRes ? `${last.resWidth}×${last.resHeight}` : '–'} {Math.round(last.fps)}fps</div>
            <Sparkline values={fpsHistory} colorClass={FPS_COLOR} />
          </div>

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

          <span className="text-gray-500">Rate</span>
          <div>
            <div className="flex flex-wrap gap-x-1.5">
              <span><span className={THROUGHPUT_UP_COLOR}>●</span> ↑{fmtBps(last.sentBps)}</span>
              <span><span className={THROUGHPUT_DOWN_COLOR}>●</span> ↓{fmtBps(last.receivedBps)}</span>
              <span><span className={THROUGHPUT_SPEED_COLOR}>●</span> {fmtBps((last.videoKbps + last.audioKbps) * 1000)}</span>
            </div>
            <div className="flex flex-col gap-y-0.5 mt-0.5">
              <HeatStrip values={sentBpsHistory} colorClass={THROUGHPUT_UP_COLOR} />
              <HeatStrip values={receivedBpsHistory} colorClass={THROUGHPUT_DOWN_COLOR} />
              <HeatStrip values={kbpsHistory} colorClass={THROUGHPUT_SPEED_COLOR} />
            </div>
          </div>

          <span className="text-gray-500">Timing</span>
          <div>
            <div className="flex flex-wrap gap-x-1.5">
              <span>
                <span className={TIMING_BUFFER_COLOR}>●</span>{' '}
                <span className={metricColor(last.bufferMs, BUFFER_MS_WARN, BUFFER_MS_BAD)}>Buf {Math.round(last.bufferMs)}ms</span>
              </span>
              <span>
                <span className={TIMING_LATENCY_COLOR}>●</span>{' '}
                <span className={metricColor(last.latencyMs, LATENCY_MS_WARN, LATENCY_MS_BAD)}>Lat {Math.round(last.latencyMs)}ms</span>
              </span>
              <span>
                <span className={TIMING_RTT_COLOR}>●</span>{' '}
                <span className={metricColor(last.rttMs, RTT_MS_WARN, RTT_MS_BAD)}>RTT {Math.round(last.rttMs)}ms</span>
              </span>
            </div>
            <div className="flex flex-col gap-y-0.5 mt-0.5">
              <HeatStrip values={bufferMsHistory} colorClass={TIMING_BUFFER_COLOR} />
              <HeatStrip values={latencyHistory} colorClass={TIMING_LATENCY_COLOR} />
              <HeatStrip values={rttHistory} colorClass={TIMING_RTT_COLOR} />
            </div>
          </div>

          <span className="text-gray-500">Loss</span>
          <div>
            <div className={metricColor(last.lossPct, LOSS_PCT_WARN, LOSS_PCT_BAD)}>{last.lossPct.toFixed(1)}%</div>
            <Sparkline
              values={lossHistory}
              colorClass={metricColor(last.lossPct, LOSS_PCT_WARN, LOSS_PCT_BAD)}
              thresholdRatio={LOSS_PCT_BAD / Math.max(LOSS_PCT_BAD, ...lossHistory, 1)}
            />
          </div>
        </>
      )}
    </div>
  );
}
