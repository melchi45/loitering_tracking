import { useCallback, useRef, useState } from 'react';

// Mirrors the vendor player's public 'statistics' CustomEvent payload shapes
// — see submodules/ump-player/src/ump/custom/ump-player.js onUmpStatistics().
// `type: 'rtp'` fires ~1/sec per media track (video and audio separately,
// see rtpSession.js's statisticsTimer, 1000ms interval); `type: 'fps'` fires
// ~1/sec for the decode/render side. Both are re-dispatched verbatim as
// `this[dispatch]("statistics", {statistics})` on the <ump-player> host
// element, which RTSPOverWebSocketView.tsx listens for and forwards here via
// onStatistics(). `type: 'timestamp'` exists in the vendor payload too but
// is never dispatched as a public event (only used to update the player's
// own internal statistics overlay), so it never reaches this hook.
// Numeric-looking fields are typed `unknown` rather than `number` — the
// vendor's own Mean utility (app/media/ump/Util/util.js: `this.mean =
// function() { return this.count ? (this.sum / this.count).toFixed(3) : 0;
// }`) returns a STRING once count > 0 (only the count===0 case is a real
// number), and videoTagPlayer.js feeds that straight into
// decodedFramesMean/decodedBytesMean/dropFramesMean; `latency` is always
// `latency.toFixed(4)` (always a string). Treating these as `number` at the
// type level let a raw `.toFixed()` call in UmpStatsPanel.tsx crash with
// "toFixed is not a function" the first time a mean field ticked past its
// zero-count default — see toNum() below, which normalizes at this
// boundary instead of trusting the vendor's inconsistent typing.
interface UmpRtpStatistics {
  type: 'rtp';
  media?: 'video' | 'audio';
  codec?: string;
  fps?: unknown;
  receviedPacket?: unknown; // vendor's own (misspelled) field name
}

interface UmpFpsStatistics {
  type: 'fps';
  fps?: unknown;
  decodedPerSec?: unknown;
  decodedFramesMean?: unknown;
  // Despite the "PerSec" name, videoTagPlayer.js sets this to the RAW
  // CUMULATIVE counter (`videoElement.webkitVideoDecodedByteCount`, total
  // bytes decoded since playback start), not a rate — the true per-second
  // delta only exists internally (`videoBytesDecodedPerSec`) and is never
  // sent as-is, only smoothed into decodedBytesMean below via
  // `videoMean.record(videoBytesDecodedPerSec)`. Graphing this field
  // directly produces a strictly-increasing line, not a rate — see
  // decodedBytesTotal in UmpStatsSnapshot.
  decodedBytesDecodedPerSec?: unknown;
  decodedBytesMean?: unknown; // true average bytes/sec (Mean() over the real per-tick delta) — the actual rate
  dropFramesCount?: unknown;
  dropFramesMean?: unknown;
  width?: unknown;
  height?: unknown;
  latency?: unknown;
  limit?: unknown;
  chunksize?: unknown;
}

type UmpStatisticsPayload = UmpRtpStatistics | UmpFpsStatistics | { type: string };

export interface UmpStatsSnapshot {
  videoCodec:          string;
  audioCodec:          string;
  videoFps:            number;
  videoFrames:         number; // cumulative, since connect
  audioFps:            number;
  audioFrames:         number; // cumulative, since connect
  decodedFps:          number;
  decodedFpsMean:      number;
  decodedBytesTotal:   number; // cumulative bytes decoded since playback start — NOT a rate, don't graph
  decodedBpsMean:      number; // bits/sec, true average — the actual rate to graph
  dropFramesCount:     number; // cumulative
  dropFramesMean:      number; // per-sec average
  width:               number;
  height:              number;
  latencySec:          number;
  latencyLimitSec:     number | null;
  chunkSize:           number | null;
}

// One point per 'fps' tick (~1/sec) — see onStatistics() below for why
// history is sampled off that tick specifically rather than every event.
export interface UmpSample {
  t:               number; // Date.now() at sample time
  decodedFps:      number;
  bitrateBpsMean:  number; // decodedBpsMean at this tick — the graphable rate (decodedBytesTotal is cumulative, not sampled)
  dropFramesMean:  number;
  latencySec:      number;
}

const UMP_HISTORY_MAX = 120; // ~2min at ~1 sample/sec — matches RX_HISTORY_MAX in useWebRTC.ts

// `v` may legitimately be a number, a numeric string (see the module doc
// comment above), or missing/NaN-producing — falls back to the previous
// value rather than resetting the panel to 0 on a single malformed tick.
function toNum(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const EMPTY_STATS: UmpStatsSnapshot = {
  videoCodec: '', audioCodec: '', videoFps: 0, videoFrames: 0, audioFps: 0, audioFrames: 0,
  decodedFps: 0, decodedFpsMean: 0, decodedBytesTotal: 0, decodedBpsMean: 0,
  dropFramesCount: 0, dropFramesMean: 0, width: 0, height: 0, latencySec: 0,
  latencyLimitSec: null, chunkSize: null,
};

/**
 * Accumulates <ump-player>'s 'statistics' CustomEvent stream into a
 * WebRtcStatsPanel-shaped snapshot + bounded sample history, so
 * UmpStatsPanel.tsx can render a "stats for nerds" panel the same way
 * CameraView.tsx already does for WebRTC (see WebRtcStatsPanel.tsx /
 * useWebRTC.ts's RxSample). Lives in the CameraView layer (not
 * RTSPOverWebSocketView) so the resulting badge/toggle/panel can sit in the same
 * top-right corner flex column as the WebRTC/Zone rows instead of a second,
 * overlapping absolutely-positioned block.
 */
export function useUmpStats() {
  const [stats, setStats] = useState<UmpStatsSnapshot | null>(null);
  const [history, setHistory] = useState<UmpSample[]>([]);
  const latestRef = useRef<UmpStatsSnapshot>(EMPTY_STATS);

  const onStatistics = useCallback((raw: unknown) => {
    const s = raw as UmpStatisticsPayload | undefined;
    if (!s || (s.type !== 'rtp' && s.type !== 'fps')) return;

    const next: UmpStatsSnapshot = { ...latestRef.current };

    if (s.type === 'rtp') {
      const rtp = s as UmpRtpStatistics;
      if (rtp.media === 'video') {
        if (typeof rtp.codec === 'string') next.videoCodec = rtp.codec;
        next.videoFps = toNum(rtp.fps, next.videoFps);
        next.videoFrames = toNum(rtp.receviedPacket, next.videoFrames);
      } else if (rtp.media === 'audio') {
        if (typeof rtp.codec === 'string') next.audioCodec = rtp.codec;
        next.audioFps = toNum(rtp.fps, next.audioFps);
        next.audioFrames = toNum(rtp.receviedPacket, next.audioFrames);
      }
    } else {
      const fps = s as UmpFpsStatistics;
      next.decodedFps = toNum(fps.decodedPerSec ?? fps.fps, next.decodedFps);
      next.decodedFpsMean = toNum(fps.decodedFramesMean, next.decodedFpsMean);
      next.decodedBytesTotal = toNum(fps.decodedBytesDecodedPerSec, next.decodedBytesTotal);
      next.decodedBpsMean = toNum(fps.decodedBytesMean, next.decodedBpsMean / 8) * 8;
      next.dropFramesCount = toNum(fps.dropFramesCount, next.dropFramesCount);
      next.dropFramesMean = toNum(fps.dropFramesMean, next.dropFramesMean);
      next.width = toNum(fps.width, next.width);
      next.height = toNum(fps.height, next.height);
      next.latencySec = toNum(fps.latency, next.latencySec);
      next.latencyLimitSec = fps.limit != null ? toNum(fps.limit, next.latencyLimitSec ?? 0) : next.latencyLimitSec;
      next.chunkSize = fps.chunksize != null ? toNum(fps.chunksize, next.chunkSize ?? 0) : next.chunkSize;
    }

    latestRef.current = next;
    setStats(next);

    // Only the 'fps' tick carries a full per-second decode/render snapshot —
    // sample history off that tick so points land ~1/sec instead of
    // double-sampling on every per-track 'rtp' tick too.
    if (s.type === 'fps') {
      setHistory((prev) => [...prev, {
        t:              Date.now(),
        decodedFps:     next.decodedFps,
        bitrateBpsMean: next.decodedBpsMean,
        dropFramesMean: next.dropFramesMean,
        latencySec:     next.latencySec,
      }].slice(-UMP_HISTORY_MAX));
    }
  }, []);

  const reset = useCallback(() => {
    latestRef.current = EMPTY_STATS;
    setStats(null);
    setHistory([]);
  }, []);

  return { stats, history, onStatistics, reset };
}
