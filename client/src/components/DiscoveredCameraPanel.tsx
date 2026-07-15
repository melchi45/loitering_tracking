import { useState } from 'react';
import { Search, Check } from 'lucide-react';
import { useCameraStore } from '../stores/cameraStore';
import type { DiscoveredCamera, OnvifProfile, ProbeChannelsResult, NvrProfile } from '../types';
import { channelRtspUrl, defaultSunapiRtspUrl } from '../utils/channelRtsp';

function Row({ label, value }: { label: string; value?: string | number | boolean | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
      <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">{label}</span>
      <span className="text-[11px] text-gray-200 break-all">{String(value)}</span>
    </div>
  );
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${ok ? 'bg-green-800 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
      {ok ? label : 'No'}
    </span>
  );
}

function SourceBadge({ source, supportOnvif }: { source?: string; supportOnvif?: boolean }) {
  const showWiseNet = source === 'udp' || source === 'both';
  const showOnvif   = source === 'onvif' || source === 'both' || !!supportOnvif;
  if (!showWiseNet && !showOnvif) return null;
  return (
    <div className="flex gap-1 mt-1">
      {showWiseNet && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-900 text-blue-300">WiseNet</span>
      )}
      {showOnvif && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-900 text-purple-300">ONVIF</span>
      )}
    </div>
  );
}

interface Props {
  camera: DiscoveredCamera;
  onClose: () => void;
}

export default function DiscoveredCameraPanel({ camera, onClose }: Props) {
  const addCamera = useCameraStore((s) => s.addCamera);
  const [adding, setAdding]     = useState(false);
  const [added, setAdded]       = useState(false);
  const [error, setError]       = useState('');
  const [selectedProfile, setSelectedProfile] = useState<OnvifProfile | null>(
    camera.profiles?.find((p) => p.rtspUrl) ?? null
  );

  // ── On-demand re-detection ────────────────────────────────────────────────
  // The Found-tab discovery scan already resolved channel info once — this is
  // NOT a duplicate of the manual Add form's "Detect Channels" (which has no
  // discovery data to draw on at all). It exists for the case where the initial
  // scan's result may be stale or incomplete (e.g. the camera's channel count
  // changed since the scan, or the scan's best-effort SUNAPI/ONVIF query timed
  // out) — the operator can force a fresh probe before adding, without leaving
  // this panel or re-running a full network scan. See Design_Channel_Slot.md §5.2a.
  const [redetecting, setRedetecting]     = useState(false);
  const [redetectError, setRedetectError] = useState('');
  const [redetected, setRedetected]       = useState<ProbeChannelsResult | null>(null);

  const effectiveMaxChannel    = redetected?.maxChannel ?? camera.MaxChannel ?? 1;
  const effectiveSupportSunapi = redetected?.supportSunapi ?? camera.SupportSunapi ?? false;
  // Per-protocol counts (FR-CH-066) — shown separately from the merged
  // effectiveMaxChannel above so an operator can see what each protocol
  // actually reported, not just whichever one "won". undefined/null means
  // that protocol was never queried/never responded, not "single-channel".
  const effectiveSunapiMaxChannel = redetected?.sunapiMaxChannel ?? camera.SunapiMaxChannel;
  const effectiveOnvifMaxChannel  = redetected?.onvifMaxChannel  ?? camera.OnvifMaxChannel;

  // SUNAPI MaxChannel is authoritative when available — use it as the upper bound
  const channelCountMax = effectiveSupportSunapi && effectiveMaxChannel > 1
    ? effectiveMaxChannel
    : 64;
  const [channelCount, setChannelCount] = useState<number>(camera.MaxChannel ?? 1);
  const hasChannels = channelCount > 1;
  const [selectedChannel, setSelectedChannel] = useState<number>(1);

  const scheme  = camera.HttpType ? 'https' : 'http';
  const webPort = camera.HttpType ? camera.HttpsPort : camera.HttpPort;

  const handleRedetectChannels = async () => {
    setRedetectError('');
    setRedetecting(true);
    try {
      const res = await fetch('/api/cameras/probe-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip:          camera.IPAddress,
          httpPort:    camera.HttpType ? camera.HttpsPort : camera.HttpPort,
          httpType:    camera.HttpType,
          username:    camera.Username,
          password:    camera.Password,
          baseRtspUrl: camera.rtspUrl,
        }),
      });
      const result: ProbeChannelsResult = await res.json();
      if (!res.ok || !result.success) throw new Error(result?.error || 'Detection failed');
      setRedetected(result);
      if (result.maxChannel > 1) {
        setChannelCount(result.maxChannel);
        setSelectedChannel(1);
      }
    } catch (err) {
      setRedetectError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setRedetecting(false);
    }
  };

  // Channel-aware RTSP URL:
  //   1) A fresh Re-detect result (if the operator ran one) — freshest data available
  //   2) ONVIF: first profile whose channelIndex matches the selected channel
  //   3) Fallback: derive from base RTSP URL by replacing profile number
  const resolveRtspUrl = (channel: number): string => {
    const fromRedetect = redetected?.profiles.find((p) => p.channelIndex === channel && p.rtspUrl);
    if (fromRedetect) return fromRedetect.rtspUrl;

    const profiles = camera.profiles ?? [];
    // Prefer profile with matching channelIndex (set by server SourceToken dedup)
    const byChannel = profiles.find((p) => p.channelIndex === channel && p.rtspUrl);
    if (byChannel) return byChannel.rtspUrl;
    // Fallback: profiles array index (legacy; works when channelIndex not set)
    if (profiles.length >= channel && profiles[channel - 1]?.rtspUrl) {
      return profiles[channel - 1].rtspUrl;
    }
    const base = camera.rtspUrl || defaultSunapiRtspUrl(camera.IPAddress, camera.Port, 1);
    return channel > 1 ? channelRtspUrl(base, channel) : base;
  };

  // Per-protocol URL for the currently selected channel — shown side by side
  // in the Device info section so the operator can see which protocol (if
  // either) actually resolved this channel's RTSP URL, instead of only the
  // merged resolveRtspUrl() result above.
  const resolveProtocolUrl = (profiles: NvrProfile[] | undefined, channel: number): string | null =>
    profiles?.find((p) => p.channelIndex === channel && p.rtspUrl)?.rtspUrl
      ?? (profiles?.length && profiles.length >= channel ? profiles[channel - 1]?.rtspUrl : undefined)
      ?? null;
  const sunapiUrl = resolveProtocolUrl(redetected?.sunapiProfiles, selectedChannel);
  const onvifUrl  = resolveProtocolUrl(
    redetected?.onvifProfiles ?? camera.profiles
      ?.filter((p): p is OnvifProfile & { channelIndex: number } => p.channelIndex != null)
      .map((p) => ({ channelIndex: p.channelIndex, rtspUrl: p.rtspUrl })),
    selectedChannel,
  );

  const rtspUrl = hasChannels
    ? resolveRtspUrl(selectedChannel)
    : (selectedProfile?.rtspUrl || camera.rtspUrl ||
       defaultSunapiRtspUrl(camera.IPAddress, camera.Port, 1));

  const handleAdd = async () => {
    setAdding(true);
    setError('');
    try {
      const port       = camera.HttpType ? camera.HttpsPort : camera.HttpPort;
      const baseName   = camera.Model || camera.IPAddress;
      const cameraName = hasChannels ? `${baseName} Ch${selectedChannel}` : baseName;

      // Persist per-channel RTSP URLs so CameraEditModal can switch NVR channel
      // later without a live re-query (no ONVIF auth wired — see Design_Channel_Slot.md §7).
      const nvrProfiles = hasChannels
        ? Array.from({ length: channelCount }, (_, i) => i + 1)
            .map((ch) => ({ channelIndex: ch, rtspUrl: resolveRtspUrl(ch) }))
            .filter((p) => !!p.rtspUrl)
        : undefined;

      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:          cameraName,
          rtspUrl,
          ip:            camera.IPAddress,
          mac:           camera.MACAddress,
          httpPort:      port,
          channelIndex:  hasChannels ? selectedChannel : undefined,
          maxChannel:    hasChannels ? channelCount : undefined,
          supportSunapi: effectiveSupportSunapi,
          nvrProfiles,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      if (result.success && result.data) addCamera(result.data);
      setAdded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add camera');
    } finally {
      setAdding(false);
    }
  };

  const hasProfiles = (camera.profiles?.length ?? 0) > 0;

  return (
    <div className="absolute right-0 top-0 h-full w-80 bg-gray-800 border-l border-gray-600 flex flex-col z-20 shadow-2xl">
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-bold text-white truncate">
            {camera.Model || 'Unknown Device'}
          </div>
          {camera.Manufacturer && (
            <div className="text-[11px] text-gray-400 truncate">{camera.Manufacturer}</div>
          )}
          <div className="text-[11px] text-blue-400 font-mono mt-0.5">{camera.IPAddress}</div>
          <SourceBadge source={camera.source} supportOnvif={camera.SupportOnvif} />
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white text-xl leading-none flex-shrink-0 ml-2 mt-0.5"
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Details */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">

        {/* Device info */}
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Device</div>
          <Row label="Manufacturer"    value={camera.Manufacturer} />
          <Row label="Model"           value={camera.Model} />
          <Row label="Type"            value={camera.DeviceType} />
          <Row label="Firmware"        value={camera.FirmwareVersion} />
          <Row label="Serial"          value={camera.SerialNumber} />
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">SUNAPI</span>
            <Badge ok={!!camera.SupportSunapi} label="Yes" />
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">SUNAPI MaxCh</span>
            <span className="text-[11px] text-gray-200">
              {effectiveSunapiMaxChannel != null ? `${effectiveSunapiMaxChannel} CH` : 'not detected'}
            </span>
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">ONVIF</span>
            <Badge ok={!!camera.SupportOnvif} label="Yes" />
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">ONVIF MaxCh</span>
            <span className="text-[11px] text-gray-200">
              {effectiveOnvifMaxChannel != null ? `${effectiveOnvifMaxChannel} CH` : 'not detected'}
            </span>
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">SUNAPI URL{hasChannels ? ` (Ch${selectedChannel})` : ''}</span>
            <span className="text-[11px] text-gray-200 font-mono truncate" title={sunapiUrl ?? undefined}>
              {sunapiUrl ?? 'not detected'}
            </span>
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">ONVIF URL{hasChannels ? ` (Ch${selectedChannel})` : ''}</span>
            <span className="text-[11px] text-gray-200 font-mono truncate" title={onvifUrl ?? undefined}>
              {onvifUrl ?? 'not detected'}
            </span>
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0 pt-0.5">Channels</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                {effectiveMaxChannel > 1 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-800 text-amber-300">
                    {effectiveMaxChannel} CH
                  </span>
                )}
                <input
                  type="number"
                  min={1}
                  max={channelCountMax}
                  value={channelCount}
                  onChange={(e) => {
                    const v = Math.min(parseInt(e.target.value, 10) || 1, channelCountMax);
                    if (v >= 1) { setChannelCount(v); setSelectedChannel(1); }
                  }}
                  className="w-14 bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[11px] text-white text-center focus:outline-none focus:border-blue-500"
                  title={`Override channel count${effectiveSupportSunapi && channelCountMax < 64 ? ` (max ${channelCountMax} from SUNAPI)` : ''}`}
                />
                <span className="text-[10px] text-gray-500">manual</span>
                <button
                  type="button"
                  onClick={handleRedetectChannels}
                  disabled={redetecting}
                  title="Re-query this IP for SUNAPI/ONVIF channels — use if the scan result looks stale or incomplete"
                  className="px-1.5 py-0.5 text-[10px] rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200 transition-colors"
                >
                  {redetecting ? 'Detecting…' : <span className="inline-flex items-center gap-1"><Search className="w-2.5 h-2.5" /> Re-detect</span>}
                </button>
              </div>
              {redetectError && <p className="text-[9px] text-red-400 mt-0.5">{redetectError}</p>}
              {!redetectError && redetected && (
                <p className="text-[9px] text-gray-500 mt-0.5">
                  Re-detect ({redetected.protocol === 'none' ? 'no response' : redetected.protocol.toUpperCase()}) —{' '}
                  {redetected.maxChannel > 1 ? `${redetected.maxChannel}CH confirmed` : 'no multi-channel NVR found, scan result unchanged'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Channel Selection (NVR — MaxChannel > 1) */}
        {hasChannels && (
          <div>
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
              Channel Selection
            </div>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: channelCount }, (_, i) => i + 1).map((ch) => {
                const isActive = ch === selectedChannel;
                // Check if any ONVIF profile for this channel has an RTSP URL
                const hasProfileUrl = !!(camera.profiles?.find((p) => p.channelIndex === ch && p.rtspUrl)
                  ?? camera.profiles?.[ch - 1]?.rtspUrl);
                return (
                  <button
                    key={ch}
                    onClick={() => {
                      setSelectedChannel(ch);
                      if (camera.profiles?.[ch - 1]) setSelectedProfile(camera.profiles[ch - 1]);
                    }}
                    className={`px-2 py-1 rounded border text-[11px] font-semibold transition-all ${
                      isActive
                        ? 'border-amber-500 bg-amber-900/50 text-amber-200'
                        : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                    }`}
                    title={hasProfileUrl ? resolveRtspUrl(ch) : undefined}
                  >
                    CH {ch}
                    {hasProfileUrl && (
                      <span className="ml-1 text-[9px] text-green-500">●</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-1.5 text-[10px] text-gray-500">
              ● ONVIF profile available &nbsp;· Adding will use name &quot;{camera.Model || camera.IPAddress} Ch{selectedChannel}&quot;
            </div>
          </div>
        )}

        {/* Network */}
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Network</div>
          <Row label="MAC"        value={camera.MACAddress} />
          <Row label="Gateway"    value={camera.Gateway} />
          <Row label="Subnet"     value={camera.SubnetMask} />
          <Row label="HTTP Port"  value={camera.HttpPort} />
          <Row label="HTTPS Port" value={camera.HttpsPort} />
          <Row label="RTSP Port"  value={camera.Port} />
        </div>

        {/* ONVIF Stream Profiles */}
        {hasProfiles && (
          <div>
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
              ONVIF Profiles
            </div>
            <div className="space-y-1">
              {camera.profiles!.map((p) => {
                const isSelected = selectedProfile?.token === p.token;
                const res = p.width && p.height ? `${p.width}×${p.height}` : '';
                const label = [p.name || p.token, res, p.encoding, p.fps ? `${p.fps}fps` : '']
                  .filter(Boolean).join(' · ');
                return (
                  <button
                    key={p.token}
                    onClick={() => setSelectedProfile(p)}
                    disabled={!p.rtspUrl}
                    className={`w-full text-left px-2 py-1.5 rounded border text-[11px] transition-all ${
                      !p.rtspUrl
                        ? 'border-gray-700 bg-gray-900 text-gray-600 cursor-not-allowed'
                        : isSelected
                        ? 'border-purple-500 bg-purple-900/40 text-white'
                        : 'border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      {isSelected && <Check className="w-3 h-3 text-purple-400" />}
                      <span className="truncate">{label}</span>
                    </div>
                    {p.rtspUrl && (
                      <div className="text-[9px] text-gray-500 font-mono truncate mt-0.5">{p.rtspUrl}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* URLs */}
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">URLs</div>
          {webPort && (
            <div className="py-1 border-b border-gray-700/50">
              <div className="text-[10px] text-gray-500 mb-0.5">Web</div>
              <a
                href={`${scheme}://${camera.IPAddress}:${webPort}`}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-blue-400 hover:text-blue-300 break-all"
              >
                {scheme}://{camera.IPAddress}:{webPort}
              </a>
            </div>
          )}
          <div className="py-1 border-b border-gray-700/50">
            <div className="text-[10px] text-gray-500 mb-0.5">
              {hasChannels
                ? `RTSP (Ch ${selectedChannel})`
                : `RTSP${selectedProfile ? ` (${selectedProfile.name || selectedProfile.token})` : ''}`}
            </div>
            <span className="text-[11px] text-green-400 break-all font-mono">{rtspUrl}</span>
          </div>
          {camera.URL && (
            <div className="py-1 border-b border-gray-700/50">
              <div className="text-[10px] text-gray-500 mb-0.5">DDNS</div>
              <span className="text-[11px] text-gray-300 break-all">{camera.URL}</span>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-gray-700 flex-shrink-0 space-y-2">
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {added ? (
          <div className="text-center text-xs text-green-400 font-semibold py-1 inline-flex items-center gap-1 justify-center w-full">
            <Check className="w-3.5 h-3.5" /> Added to camera list
          </div>
        ) : (
          <button
            onClick={handleAdd}
            disabled={adding}
            className="w-full py-2 text-xs font-semibold rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white transition-colors"
          >
            {adding
              ? 'Adding…'
              : hasChannels
              ? `+ Add Ch ${selectedChannel} to System`
              : '+ Add to System'}
          </button>
        )}
      </div>
    </div>
  );
}
