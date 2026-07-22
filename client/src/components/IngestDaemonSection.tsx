import { useEffect, useRef, useState } from 'react';
import { Wifi, WifiOff, RefreshCw, Video, Volume2, Cpu, Send, ArrowDownToLine } from 'lucide-react';
import { getSocket } from '../hooks/useSocket';
import Sparkline from './Sparkline';

// ── Types — mirrors server/src/services/ingestStatsAggregator.js's payload ──

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'unknown';

interface CameraStat {
  id: string;
  name: string;
  type: string;
  rtspUrl: string | null;
  youtubeUrl: string | null;
  webrtcEnabled: boolean;

  connectionState: ConnectionState;
  peerIp: string | null;
  peerPort: number | null;
  connectedAt: number | null;
  lastVideoPacketAt: number | null;
  lastAudioPacketAt: number | null;
  lastAiPushAt: number | null;
  lastAppRtpAt: number | null;
  videoCodec: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
  videoBps: number;
  videoFps: number;
  audioBps: number;
  audioFps: number;
  aiFps: number;

  framesProcessed: number;
  detectionsTotal: number;
  trackedTotal: number;
  facesTotal: number;
  fireSmokeTotal: number;
  loiteringTotal: number;

  mediasoupVideoBytesRx: number | null;
  mediasoupAudioBytesRx: number | null;
  mediasoupViewers: number;
}

interface AnalysisClientStats {
  connected: boolean;
  circuitOpen: boolean;
  total: number;
  errors: number;
  dropped: number;
  inflight?: number;
  lastError?: string;
  timeoutMs?: number;
  analysisServerUrl?: string;
}

interface IngestStatsPayload {
  timestamp: number;
  cameras: CameraStat[];
  analysisClient: AnalysisClientStats | null;
}

const HISTORY_MAX = 60; // ~90s at the server's 1.5s push interval

const STATE_STYLE: Record<ConnectionState, { dot: string; text: string; label: string }> = {
  connected:    { dot: 'bg-green-500 animate-pulse', text: 'text-green-400',  label: 'Connected' },
  connecting:   { dot: 'bg-yellow-500 animate-pulse', text: 'text-yellow-400', label: 'Connecting' },
  reconnecting: { dot: 'bg-yellow-500 animate-pulse', text: 'text-yellow-400', label: 'Reconnecting' },
  failed:       { dot: 'bg-red-500',                  text: 'text-red-400',   label: 'Failed' },
  unknown:      { dot: 'bg-gray-500',                 text: 'text-gray-400',  label: 'Unknown' },
};

function fmtBps(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} kbps`;
  return `${Math.round(bps)} bps`;
}

function fmtAgo(epochMs: number | null): string {
  if (!epochMs) return '—';
  const s = Math.round((Date.now() - epochMs) / 1000);
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function fmtBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

interface Props {
  accessToken: string | null;
}

export default function IngestDaemonSection({ accessToken }: Props) {
  const [payload, setPayload] = useState<IngestStatsPayload | null>(null);
  const [connected, setConnected] = useState(false);
  // Client-side rolling history per camera — the server pushes a snapshot each
  // tick, not a time series (2026-07-21, see Design_Ingest_Daemon_Monitoring.md
  // §7 decision #5). Mirrors useWebRTC.ts's rxHistory pattern: accumulate here,
  // not on the server.
  const historyRef = useRef<Map<string, { videoBps: number[]; videoFps: number[] }>>(new Map());

  useEffect(() => {
    const socket = getSocket();

    const subscribe = () => {
      if (!accessToken) return;
      socket.emit('admin:subscribe-ingest-stats', { token: accessToken });
    };
    const handleStats = (data: IngestStatsPayload) => {
      setPayload(data);
      for (const cam of data.cameras) {
        let h = historyRef.current.get(cam.id);
        if (!h) { h = { videoBps: [], videoFps: [] }; historyRef.current.set(cam.id, h); }
        h.videoBps.push(cam.videoBps);
        h.videoFps.push(cam.videoFps);
        if (h.videoBps.length > HISTORY_MAX) h.videoBps.shift();
        if (h.videoFps.length > HISTORY_MAX) h.videoFps.shift();
      }
    };
    const handleConnect = () => { setConnected(true); subscribe(); };
    const handleDisconnect = () => setConnected(false);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('admin:ingest-stats', handleStats);
    setConnected(socket.connected);
    if (socket.connected) subscribe();

    return () => {
      socket.emit('admin:unsubscribe-ingest-stats');
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('admin:ingest-stats', handleStats);
    };
  }, [accessToken]);

  const ac = payload?.analysisClient;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Ingest Daemon</h2>
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          {connected ? 'Live' : 'Disconnected'}
        </div>
      </div>

      {ac && (
        <div className="flex items-center gap-4 px-3 py-2 bg-gray-800/60 border border-gray-700 rounded-lg text-xs text-gray-300">
          <span className="font-medium text-gray-200">Analysis Server</span>
          <span className={`flex items-center gap-1 ${ac.connected ? 'text-green-400' : 'text-red-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${ac.connected ? 'bg-green-500' : 'bg-red-500'}`} />
            {ac.connected ? 'Connected' : `Circuit ${ac.circuitOpen ? 'open' : 'closed'}`}
          </span>
          <span>Total: {ac.total}</span>
          <span>Errors: {ac.errors}</span>
          <span>Dropped: {ac.dropped}</span>
          {ac.inflight != null && <span>In-flight: {ac.inflight}</span>}
          {ac.lastError && <span className="text-red-400 truncate">{ac.lastError}</span>}
        </div>
      )}

      {!payload && (
        <div className="text-sm text-gray-500 px-3 py-6 text-center">
          {connected ? 'Waiting for first stats push…' : 'Connecting to server…'}
        </div>
      )}

      {payload && payload.cameras.length === 0 && (
        <div className="text-sm text-gray-500 px-3 py-6 text-center">No cameras registered.</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {payload?.cameras.map((cam) => {
          const st = STATE_STYLE[cam.connectionState] ?? STATE_STYLE.unknown;
          const h = historyRef.current.get(cam.id);
          return (
            <div key={cam.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.dot}`} />
                  <span className="font-medium text-white truncate">{cam.name}</span>
                  {!cam.webrtcEnabled && <span className="text-[10px] text-gray-500 flex-shrink-0">(WebRTC off)</span>}
                </div>
                <span className={`text-xs flex-shrink-0 ${st.text}`}>{st.label}</span>
              </div>

              <div className="text-[11px] text-gray-500 truncate" title={cam.rtspUrl || cam.youtubeUrl || ''}>
                {cam.type === 'youtube' ? cam.youtubeUrl : cam.rtspUrl}
              </div>

              {cam.peerIp && (
                <div className="text-[11px] text-gray-400">
                  IP: <span className="text-gray-300">{cam.peerIp}{cam.peerPort ? `:${cam.peerPort}` : ''}</span>
                  {cam.connectedAt && <span className="text-gray-600"> · connected {fmtAgo(cam.connectedAt)}</span>}
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <div className="flex items-center gap-1 text-gray-400">
                  <Video className="w-3 h-3" />
                  {cam.videoCodec || '—'} {cam.videoWidth ? `${cam.videoWidth}×${cam.videoHeight}` : ''}
                </div>
                <div className="flex items-center gap-1 text-gray-400">
                  <Volume2 className="w-3 h-3" /> last {fmtAgo(cam.lastAudioPacketAt)}
                </div>
                <div className="text-gray-300">{fmtBps(cam.videoBps)} · {cam.videoFps.toFixed(1)} fps</div>
                <div className="text-gray-300">{fmtBps(cam.audioBps)} · {cam.audioFps.toFixed(1)} fps</div>
              </div>

              {h && h.videoBps.some((v) => v > 0) && (
                <div className="space-y-0.5">
                  <Sparkline values={h.videoBps} colorClass="text-blue-400" />
                  <Sparkline values={h.videoFps} colorClass="text-purple-400" />
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-400 pt-1 border-t border-gray-700/60">
                <div className="flex items-center gap-1">
                  <Cpu className="w-3 h-3" /> AI {cam.aiFps.toFixed(1)} fps · last {fmtAgo(cam.lastAiPushAt)}
                </div>
                <div>Detections: {cam.detectionsTotal}</div>
                <div className="flex items-center gap-1">
                  <Send className="w-3 h-3" /> Analysis: {cam.framesProcessed} frames
                </div>
                <div className="flex items-center gap-1">
                  <ArrowDownToLine className="w-3 h-3" /> →Streaming: {fmtBytes(cam.mediasoupVideoBytesRx)}
                </div>
                <div>Tracked: {cam.trackedTotal}</div>
                <div>Viewers: {cam.mediasoupViewers}</div>
              </div>

              <div className="flex items-center gap-1 text-[10px] text-gray-600">
                {cam.connectionState === 'connected' ? <Wifi className="w-3 h-3" /> :
                 cam.connectionState === 'reconnecting' ? <RefreshCw className="w-3 h-3" /> :
                 <WifiOff className="w-3 h-3" />}
                Last video packet {fmtAgo(cam.lastVideoPacketAt)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
