import { useMemo, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { useCameraStore } from '../stores/cameraStore';
import { useChannelConfigStore } from '../stores/channelConfigStore';
import { ChannelSlotPicker } from './ChannelSlotPicker';
import { StreamingModeSelector } from './StreamingModeSelector';
import { channelRtspUrl } from '../utils/channelRtsp';
import type { Camera, NvrProfile, ProbeChannelsResult } from '../types';

interface Props {
  camera: Camera;
  onClose: () => void;
}

/**
 * Resolves the RTSP URL for a different NVR channel without any live device
 * query — uses the per-channel URLs already known (persisted nvrProfiles, or
 * a fresh probe-channels result), falling back to SUNAPI path-substitution.
 * Returns null when neither source can resolve it (FR-CH-042/043).
 */
function resolveNvrChannelRtsp(
  profiles: NvrProfile[] | null | undefined,
  supportSunapi: boolean,
  baseRtspUrl: string,
  targetChannel: number,
): string | null {
  const fromProfile = profiles?.find((p) => p.channelIndex === targetChannel);
  if (fromProfile) return fromProfile.rtspUrl;
  if (supportSunapi && baseRtspUrl) {
    const substituted = channelRtspUrl(baseRtspUrl, targetChannel);
    return substituted !== baseRtspUrl ? substituted : null;
  }
  return null;
}

/** Looks up a single protocol's RTSP URL for a channel from a probe-channels per-protocol profiles list — used to show SUNAPI/ONVIF URLs side by side, distinct from the merged resolveNvrChannelRtsp() above. */
function resolveProtocolChannelRtsp(profiles: NvrProfile[] | null | undefined, targetChannel: number): string | null {
  return profiles?.find((p) => p.channelIndex === targetChannel)?.rtspUrl ?? null;
}

export default function CameraEditModal({ camera, onClose }: Props) {
  const updateCamera = useCameraStore((s) => s.updateCamera);
  const cameras       = useCameraStore((s) => s.cameras);
  const maxChannelNum = useChannelConfigStore((s) => s.maxChannelNum);
  const isYoutube = camera.type === 'youtube';

  // channelSlot → occupying camera name, excluding this camera itself (FR-CH-034)
  const takenChannelSlots = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of cameras) if (c.channelSlot != null && c.id !== camera.id) m.set(c.channelSlot, c.name);
    return m;
  }, [cameras, camera.id]);

  const [channelSlot, setChannelSlot] = useState<number | null>(camera.channelSlot ?? null);

  // ── NVR sub-channel state (SUNAPI/ONVIF multi-channel sources only) ──────────
  // `redetected` overrides the camera's persisted maxChannel/nvrProfiles/supportSunapi
  // when the operator clicks "Re-detect" — lets cameras added before this feature
  // (no persisted NVR metadata) discover their channels without deleting/re-adding.
  const [redetecting, setRedetecting]     = useState(false);
  const [redetectError, setRedetectError] = useState('');
  const [redetected, setRedetected]       = useState<ProbeChannelsResult | null>(null);

  const effectiveMaxChannel    = redetected?.maxChannel ?? camera.maxChannel ?? 1;
  const effectiveProfiles      = redetected?.profiles ?? camera.nvrProfiles ?? null;
  const effectiveSupportSunapi = redetected?.supportSunapi ?? camera.supportSunapi ?? false;
  const hasNvrChannels = !isYoutube && effectiveMaxChannel > 1;

  const [nvrChannel, setNvrChannel] = useState<number | null>(camera.channelIndex ?? null);
  const [nvrRtspPreview, setNvrRtspPreview] = useState<string | null>(null);

  const handleRedetectChannels = async () => {
    setRedetectError('');
    // Prefer whatever RTSP URL is currently typed into the form (unsaved edits)
    // over the camera's persisted value — Re-detect should probe the address the
    // operator is about to save, not the one already on disk.
    const currentRtspUrl = rtspForm.rtspUrl.trim() || camera.rtspUrl;
    if (!camera.ip && !currentRtspUrl) {
      setRedetectError('No IP or RTSP URL known for this camera.');
      return;
    }
    let ip = '';
    try { ip = new URL(currentRtspUrl).hostname; } catch { /* fall through to camera.ip below */ }
    if (!ip) ip = camera.ip || '';
    if (!ip) {
      setRedetectError('Could not determine camera IP.');
      return;
    }
    setRedetecting(true);
    try {
      const res = await fetch('/api/cameras/probe-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip,
          httpPort:    camera.httpPort || undefined,
          baseRtspUrl: currentRtspUrl,
          // Forward whatever the operator has typed into the form this session —
          // covers editing credentials and clicking Re-detect before Save, when the
          // camera's own DB record (looked up server-side via cameraId below) still
          // has the old/blank value. Falsy (unedited '') falls back to the DB record
          // server-side, so this is safe to send unconditionally.
          username:    rtspForm.username || undefined,
          password:    rtspForm.password || undefined,
          // Passing cameraId lets the server look up the camera's own stored
          // credentials for the SUNAPI probe when the form fields above are blank —
          // this client never has the persisted password value (GET /api/cameras
          // strips it), so it can't pre-fill the form with it.
          cameraId:    camera.id,
        }),
      });
      const result: ProbeChannelsResult = await res.json();
      if (!res.ok || !result.success) throw new Error(result?.error || 'Detection failed');
      setRedetected(result);
      if (result.maxChannel > 1 && nvrChannel == null) setNvrChannel(camera.channelIndex ?? 1);
    } catch (err) {
      setRedetectError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setRedetecting(false);
    }
  };

  // ── RTSP form state ────────────────────────────────────────────────────────
  // streamingMode ('jpeg'|'webrtc'|'ump') replaces the old binary webrtcEnabled toggle —
  // see Design_UMP_Player_RTSP_over_WebSocket.md §7. Falls back to deriving from
  // webrtcEnabled for cameras fetched before the server started returning streamingMode.
  const [rtspForm, setRtspForm] = useState({
    name:          camera.name,
    rtspUrl:       camera.rtspUrl,
    username:      '',
    password:      '',
    streamingMode: camera.streamingMode ?? (camera.webrtcEnabled ? 'webrtc' : 'jpeg') as 'jpeg' | 'webrtc' | 'ump',
  });

  // ── Thermal sensor calibration state — native sensor resolution (e.g. 160x120)
  // used to scale onvif:temperature raw coordinates onto the actual video resolution.
  // Blank means "no calibration" (raw coordinates assumed to already match video resolution).
  const [thermalSensorWidth,  setThermalSensorWidth]  = useState(camera.thermalSensorWidth  ?? '');
  const [thermalSensorHeight, setThermalSensorHeight] = useState(camera.thermalSensorHeight ?? '');

  // ── YouTube form state ─────────────────────────────────────────────────────
  const [ytForm, setYtForm] = useState({
    name:           camera.name,
    youtubeUrl:     camera.youtubeUrl || '',
    resolution:     (camera.resolution as '1080p' | '720p' | '480p') || '1080p',
    bitrate:        camera.bitrate || 2000,
    repeatPlayback: camera.repeatPlayback || false,
    webrtcEnabled:  !!(camera.webrtcEnabled),
  });

  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState('');

  // ── RTSP handlers ──────────────────────────────────────────────────────────
  const handleRtspChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    setRtspForm((p) => ({ ...p, [e.target.name]: e.target.value }));

  const handleRtspSave = async (andReconnect: boolean) => {
    if (!rtspForm.name.trim() || !rtspForm.rtspUrl.trim()) {
      setError('Name and RTSP URL are required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      // A resolved NVR channel switch (nvrRtspPreview) takes priority over the
      // manually-edited rtspUrl field — see FR-CH-042.
      const finalRtspUrl = nvrRtspPreview ?? rtspForm.rtspUrl;
      const res = await fetch(`/api/cameras/${camera.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:          rtspForm.name,
          rtspUrl:       finalRtspUrl,
          username:      rtspForm.username || undefined,
          password:      rtspForm.password || undefined,
          streamingMode: rtspForm.streamingMode,
          channelSlot:   channelSlot ?? undefined,
          channelIndex:  hasNvrChannels ? (nvrChannel ?? undefined) : undefined,
          // Only overwrite persisted NVR metadata when a fresh "Re-detect" ran this session.
          maxChannel:    redetected ? redetected.maxChannel : undefined,
          supportSunapi: redetected ? redetected.supportSunapi : undefined,
          nvrProfiles:   redetected ? redetected.profiles : undefined,
          thermalSensorWidth:  thermalSensorWidth  === '' ? null : Number(thermalSensorWidth),
          thermalSensorHeight: thermalSensorHeight === '' ? null : Number(thermalSensorHeight),
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.error || 'Save failed');
      if (result.success && result.data) updateCamera(camera.id, result.data);

      if (andReconnect && !result.restarted) {
        const rRes = await fetch(`/api/cameras/${camera.id}/stream/reconnect`, { method: 'POST' });
        if (!rRes.ok) throw new Error('Reconnect failed');
      }
      setSuccess(andReconnect ? 'Saved & reconnecting…' : 'Saved.');
      setTimeout(onClose, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  // ── YouTube handlers ───────────────────────────────────────────────────────
  const handleYtChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setYtForm((p) => ({ ...p, [name]: name === 'bitrate' ? Number(value) : value }));
  };

  const handleYtSave = async () => {
    if (!ytForm.name.trim())       { setError('Name is required.');         return; }
    if (!ytForm.youtubeUrl.trim()) { setError('YouTube URL is required.');  return; }
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/youtube-streams/${camera.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:           ytForm.name.trim(),
          youtubeUrl:     ytForm.youtubeUrl.trim(),
          resolution:     ytForm.resolution,
          bitrate:        ytForm.bitrate,
          repeatPlayback: ytForm.repeatPlayback,
          webrtcEnabled:  ytForm.webrtcEnabled,
          channelSlot:    channelSlot ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          body.code === 'INVALID_YOUTUBE_URL'   ? 'Invalid YouTube URL.' :
          body.code === 'NOT_FOUND'              ? 'Stream not found.' :
          body.code === 'CHANNEL_SLOT_CONFLICT'  ? body.error :
          body.code === 'CHANNEL_SLOT_INVALID'   ? body.error :
          body.error || 'Save failed';
        throw new Error(msg);
      }
      const result = await res.json();
      if (result.success && result.camera) {
        updateCamera(camera.id, {
          name:           result.camera.name,
          youtubeUrl:     result.camera.youtubeUrl,
          resolution:     result.camera.resolution,
          bitrate:        result.camera.bitrate,
          repeatPlayback: result.camera.repeatPlayback,
          webrtcEnabled:  result.camera.webrtcEnabled,
          channelSlot:    result.camera.channelSlot,
        });
      }
      setSuccess('Saved. The stream will restart if URL or resolution is changed.');
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-800 rounded-lg shadow-xl w-96 border border-gray-600">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white">Edit Camera</h3>
              {isYoutube && (
                <span className="bg-red-700 text-white text-[9px] font-bold px-1 py-px rounded-sm">YT</span>
              )}
            </div>
            <p className="text-[11px] text-gray-400 mt-0.5">{camera.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* ── YouTube edit form ─────────────────────────────────────────── */}
        {isYoutube ? (
          <>
            <div className="p-4 space-y-3">
              {/* Restart notice */}
              <div className="text-[10px] text-yellow-500 bg-yellow-900/20 border border-yellow-700/40 rounded px-2 py-1.5 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" /> Changing the URL, resolution, or bitrate will automatically restart the stream.
              </div>

              {/* Name */}
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">Name *</label>
                <input
                  name="name"
                  value={ytForm.name}
                  onChange={handleYtChange}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
                />
              </div>

              {/* YouTube URL */}
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">YouTube URL *</label>
                <input
                  name="youtubeUrl"
                  value={ytForm.youtubeUrl}
                  onChange={handleYtChange}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 font-mono focus:outline-none focus:border-red-500"
                />
              </div>

              {/* Resolution + Bitrate */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-gray-400 mb-1">Resolution</label>
                  <select
                    name="resolution"
                    value={ytForm.resolution}
                    onChange={handleYtChange}
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                  >
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="480p">480p</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-400 mb-1">Bitrate (kbps)</label>
                  <input
                    name="bitrate"
                    type="number"
                    value={ytForm.bitrate}
                    onChange={handleYtChange}
                    min={100}
                    max={10000}
                    step={500}
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>

              {/* Repeat Playback */}
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={ytForm.repeatPlayback}
                  onChange={(e) => setYtForm((p) => ({ ...p, repeatPlayback: e.target.checked }))}
                  className="w-3.5 h-3.5 rounded accent-red-500"
                />
                <span>Repeat Playback — auto-restart when video ends</span>
              </label>

              {/* Channel Slot — dashboard grid position (FR-CH-034) */}
              <div className="py-2 border-t border-gray-700 mt-1">
                <p className="text-xs text-gray-200 font-medium mb-1.5">Channel</p>
                <ChannelSlotPicker
                  value={channelSlot}
                  onChange={setChannelSlot}
                  maxChannelNum={maxChannelNum}
                  takenSlots={takenChannelSlots}
                />
              </div>

              {/* WebRTC toggle */}
              <div className="flex items-center justify-between py-2 border-t border-gray-700 mt-1">
                <div>
                  <p className="text-xs text-gray-200 font-medium">WebRTC Streaming</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {ytForm.webrtcEnabled
                      ? 'Video via WebRTC (H.264 + Audio) — requires SERVER_IP in .env'
                      : 'Video via JPEG / Socket.IO (default)'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setYtForm((p) => ({ ...p, webrtcEnabled: !p.webrtcEnabled }))}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${
                    ytForm.webrtcEnabled ? 'bg-blue-600' : 'bg-gray-600'
                  }`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
                    ytForm.webrtcEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>

              {/* Internal RTSP URL (read-only) */}
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">Internal RTSP URL</label>
                <p
                  className="w-full bg-gray-900/50 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-500 font-mono truncate select-all"
                  title={camera.rtspUrl}
                >
                  {camera.rtspUrl}
                </p>
              </div>

              {error   && <p className="text-xs text-red-400">{error}</p>}
              {success && <p className="text-xs text-green-400">{success}</p>}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleYtSave}
                disabled={saving}
                className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-semibold transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        ) : (
          /* ── RTSP edit form ─────────────────────────────────────────── */
          <>
            <div className="p-4 space-y-3">
              {/* Name */}
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">Name *</label>
                <input
                  name="name"
                  value={rtspForm.name}
                  onChange={handleRtspChange}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* RTSP URL */}
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">RTSP URL *</label>
                <input
                  name="rtspUrl"
                  value={rtspForm.rtspUrl}
                  onChange={handleRtspChange}
                  placeholder="rtsp://192.168.1.x:554/stream"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 font-mono focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Credentials */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-gray-400 mb-1">Username</label>
                  <input
                    name="username"
                    value={rtspForm.username}
                    onChange={handleRtspChange}
                    placeholder="admin"
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-400 mb-1">Password</label>
                  <input
                    name="password"
                    type="password"
                    value={rtspForm.password}
                    onChange={handleRtspChange}
                    placeholder="(unchanged)"
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Tip */}
              <p className="text-[10px] text-gray-500">
                Leave Username/Password blank to keep existing credentials.
              </p>

              {/* Channel Slot — dashboard grid position (FR-CH-034) */}
              <div className="py-2 border-t border-gray-700 mt-1">
                <p className="text-xs text-gray-200 font-medium mb-1.5">Channel</p>
                <ChannelSlotPicker
                  value={channelSlot}
                  onChange={setChannelSlot}
                  maxChannelNum={maxChannelNum}
                  takenSlots={takenChannelSlots}
                />
              </div>

              {/* NVR Channel — SUNAPI/ONVIF multi-channel sources (FR-CH-041~044) */}
              <div className="py-2 border-t border-gray-700 mt-1">
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs text-gray-200 font-medium">
                    NVR Channel
                    {hasNvrChannels && <span className="text-gray-500 font-normal"> (max {effectiveMaxChannel})</span>}
                  </p>
                  <button
                    type="button"
                    onClick={handleRedetectChannels}
                    disabled={redetecting}
                    className="px-2 py-1 text-[10px] rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200 transition-colors"
                  >
                    {redetecting ? 'Detecting…' : <span className="inline-flex items-center gap-1"><Search className="w-2.5 h-2.5" /> Re-detect</span>}
                  </button>
                </div>
                {redetectError && <p className="text-[10px] text-red-400 mb-1">{redetectError}</p>}
                {!hasNvrChannels && !redetectError && !redetected && (
                  <p className="text-[10px] text-gray-500">
                    No NVR channel data yet — click Re-detect to query SUNAPI/ONVIF for this camera's IP.
                  </p>
                )}
                {!hasNvrChannels && !redetectError && redetected && (
                  <p className="text-[10px] text-gray-500">
                    Re-detect ran ({redetected.protocol === 'none' ? 'no SUNAPI/ONVIF response' : redetected.protocol.toUpperCase()}) —
                    single-channel or no multi-channel NVR found at this camera's IP.
                  </p>
                )}
                {hasNvrChannels && (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {Array.from({ length: effectiveMaxChannel }, (_, i) => i + 1).map((ch) => {
                        const resolved = resolveNvrChannelRtsp(effectiveProfiles, effectiveSupportSunapi, camera.rtspUrl, ch);
                        const isSelected = ch === nvrChannel;
                        return (
                          <button
                            key={ch}
                            type="button"
                            disabled={resolved === null}
                            title={resolved === null ? 'RTSP could not be resolved for this channel' : resolved}
                            onClick={() => {
                              setNvrChannel(ch);
                              setNvrRtspPreview(resolved);
                            }}
                            className={`px-2 py-1 rounded border text-[11px] font-semibold transition-all ${
                              isSelected
                                ? 'border-amber-500 bg-amber-900/50 text-amber-200'
                                : resolved === null
                                ? 'border-gray-800 bg-gray-900 text-gray-700 cursor-not-allowed'
                                : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                            }`}
                          >
                            CH {ch}
                          </button>
                        );
                      })}
                    </div>
                    {nvrRtspPreview && (
                      <p className="text-[10px] text-gray-500 mt-1.5 font-mono truncate" title={nvrRtspPreview}>
                        → {nvrRtspPreview}
                      </p>
                    )}
                    {redetected && (
                      <div className="mt-1.5 space-y-0.5">
                        <p className="text-[10px] text-gray-500 font-mono truncate" title={resolveProtocolChannelRtsp(redetected.sunapiProfiles, nvrChannel ?? 1) ?? undefined}>
                          SUNAPI: {resolveProtocolChannelRtsp(redetected.sunapiProfiles, nvrChannel ?? 1) ?? 'not detected'}
                        </p>
                        <p className="text-[10px] text-gray-500 font-mono truncate" title={resolveProtocolChannelRtsp(redetected.onvifProfiles, nvrChannel ?? 1) ?? undefined}>
                          ONVIF: {resolveProtocolChannelRtsp(redetected.onvifProfiles, nvrChannel ?? 1) ?? 'not detected'}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Streaming mode — JPEG(Default) / WebRTC / UMP (Design_UMP_Player_RTSP_over_WebSocket.md §7) */}
              <StreamingModeSelector
                value={rtspForm.streamingMode}
                onChange={(mode) => setRtspForm((p) => ({ ...p, streamingMode: mode }))}
              />

              {/* Thermal Sensor Coordinate calibration — scales onvif:temperature raw
                  coordinates (native sensor resolution) onto the actual video resolution */}
              <div className="py-2 border-t border-gray-700 mt-1">
                <p className="text-xs text-gray-200 font-medium mb-0.5">Sensor Coordinate</p>
                <p className="text-[10px] text-gray-500 mb-1.5">
                  Thermal sensor's native resolution (e.g. 160 x 120). Leave blank if the camera
                  already reports temperature coordinates at full video resolution.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={16384}
                    value={thermalSensorWidth}
                    onChange={(e) => setThermalSensorWidth(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="Width (e.g. 160)"
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={16384}
                    value={thermalSensorHeight}
                    onChange={(e) => setThermalSensorHeight(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="Height (e.g. 120)"
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {error   && <p className="text-xs text-red-400">{error}</p>}
              {success && <p className="text-xs text-green-400">{success}</p>}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRtspSave(false)}
                disabled={saving}
                className="px-3 py-1.5 text-xs rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white transition-colors"
              >
                Save only
              </button>
              <button
                onClick={() => handleRtspSave(true)}
                disabled={saving}
                className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white font-semibold transition-colors"
              >
                {saving ? 'Saving…' : 'Save & Reconnect'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
