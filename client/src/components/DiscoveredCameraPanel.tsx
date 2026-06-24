import { useState } from 'react';
import { useCameraStore } from '../stores/cameraStore';
import type { DiscoveredCamera, OnvifProfile } from '../types';

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

/** Generate RTSP URL for a specific channel number by replacing the profile index. */
function channelRtspUrl(baseUrl: string, channel: number): string {
  if (!baseUrl) return baseUrl;
  if (/\/profile\d+\//i.test(baseUrl)) return baseUrl.replace(/\/profile\d+\//i, `/profile${channel}/`);
  if (/\/profile\d+$/i.test(baseUrl))  return baseUrl.replace(/\/profile\d+$/i,  `/profile${channel}`);
  return baseUrl;
}

export default function DiscoveredCameraPanel({ camera, onClose }: Props) {
  const addCamera = useCameraStore((s) => s.addCamera);
  const [adding, setAdding]     = useState(false);
  const [added, setAdded]       = useState(false);
  const [error, setError]       = useState('');
  const [selectedProfile, setSelectedProfile] = useState<OnvifProfile | null>(
    camera.profiles?.find((p) => p.rtspUrl) ?? null
  );

  const [channelCount, setChannelCount] = useState<number>(camera.MaxChannel ?? 1);
  const hasChannels = channelCount > 1;
  const [selectedChannel, setSelectedChannel] = useState<number>(1);

  const scheme  = camera.HttpType ? 'https' : 'http';
  const webPort = camera.HttpType ? camera.HttpsPort : camera.HttpPort;

  // Channel-aware RTSP URL:
  //   1) ONVIF: first profile whose channelIndex matches the selected channel
  //   2) Fallback: derive from base RTSP URL by replacing profile number
  const resolveRtspUrl = (channel: number): string => {
    const profiles = camera.profiles ?? [];
    // Prefer profile with matching channelIndex (set by server SourceToken dedup)
    const byChannel = profiles.find((p) => p.channelIndex === channel && p.rtspUrl);
    if (byChannel) return byChannel.rtspUrl;
    // Fallback: profiles array index (legacy; works when channelIndex not set)
    if (profiles.length >= channel && profiles[channel - 1]?.rtspUrl) {
      return profiles[channel - 1].rtspUrl;
    }
    const base = camera.rtspUrl || `rtsp://${camera.IPAddress}:${camera.Port || 554}/profile1/media.smp`;
    return channel > 1 ? channelRtspUrl(base, channel) : base;
  };

  const rtspUrl = hasChannels
    ? resolveRtspUrl(selectedChannel)
    : (selectedProfile?.rtspUrl || camera.rtspUrl ||
       `rtsp://${camera.IPAddress}:${camera.Port || 554}/profile1/media.smp`);

  const handleAdd = async () => {
    setAdding(true);
    setError('');
    try {
      const port       = camera.HttpType ? camera.HttpsPort : camera.HttpPort;
      const baseName   = camera.Model || camera.IPAddress;
      const cameraName = hasChannels ? `${baseName} Ch${selectedChannel}` : baseName;
      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:         cameraName,
          rtspUrl,
          ip:           camera.IPAddress,
          mac:          camera.MACAddress,
          httpPort:     port,
          channelIndex: hasChannels ? selectedChannel : undefined,
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
          <Row label="Firmware"        value={camera.FirmwareVersion} />
          <Row label="Serial"          value={camera.SerialNumber} />
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">SUNAPI</span>
            <Badge ok={!!camera.SupportSunapi} label="Yes" />
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">ONVIF</span>
            <Badge ok={!!camera.SupportOnvif} label="Yes" />
          </div>
          <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
            <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">Channels</span>
            <div className="flex items-center gap-1.5">
              {(camera.MaxChannel ?? 1) > 1 && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-800 text-amber-300">
                  {camera.MaxChannel} CH
                </span>
              )}
              <input
                type="number"
                min={1}
                max={64}
                value={channelCount}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (v >= 1) { setChannelCount(v); setSelectedChannel(1); }
                }}
                className="w-14 bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[11px] text-white text-center focus:outline-none focus:border-blue-500"
                title="Override channel count (if auto-detection failed)"
              />
              <span className="text-[10px] text-gray-500">manual</span>
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
                      {isSelected && <span className="text-purple-400">✓</span>}
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
          <div className="text-center text-xs text-green-400 font-semibold py-1">
            ✓ Added to camera list
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
