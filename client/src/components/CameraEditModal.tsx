import { useState } from 'react';
import { useCameraStore } from '../stores/cameraStore';
import type { Camera } from '../types';

interface Props {
  camera: Camera;
  onClose: () => void;
}

export default function CameraEditModal({ camera, onClose }: Props) {
  const updateCamera = useCameraStore((s) => s.updateCamera);
  const isYoutube = camera.type === 'youtube';

  // ── RTSP form state ────────────────────────────────────────────────────────
  const [rtspForm, setRtspForm] = useState({
    name:          camera.name,
    rtspUrl:       camera.rtspUrl,
    username:      '',
    password:      '',
    webrtcEnabled: !!(camera.webrtcEnabled),
  });

  // ── YouTube form state ─────────────────────────────────────────────────────
  const [ytForm, setYtForm] = useState({
    name:           camera.name,
    youtubeUrl:     camera.youtubeUrl || '',
    resolution:     (camera.resolution as '1080p' | '720p' | '480p') || '1080p',
    bitrate:        camera.bitrate || 2000,
    repeatPlayback: camera.repeatPlayback || false,
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
      const res = await fetch(`/api/cameras/${camera.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:          rtspForm.name,
          rtspUrl:       rtspForm.rtspUrl,
          username:      rtspForm.username || undefined,
          password:      rtspForm.password || undefined,
          webrtcEnabled: rtspForm.webrtcEnabled,
        }),
      });
      if (!res.ok) throw new Error(await res.text() || 'Save failed');
      const result = await res.json();
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
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          body.code === 'INVALID_YOUTUBE_URL' ? '유효하지 않은 YouTube URL입니다.' :
          body.code === 'NOT_FOUND'            ? '스트림을 찾을 수 없습니다.' :
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
        });
      }
      setSuccess('저장되었습니다. URL/해상도 변경 시 스트림이 재시작됩니다.');
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
              <div className="text-[10px] text-yellow-500 bg-yellow-900/20 border border-yellow-700/40 rounded px-2 py-1.5">
                ⚠ URL·해상도·비트레이트를 변경하면 스트림이 자동으로 재시작됩니다.
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
                  <label className="block text-[11px] text-gray-400 mb-1">해상도</label>
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
                  <label className="block text-[11px] text-gray-400 mb-1">비트레이트 (kbps)</label>
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
                <span>반복 재생 — 영상 종료 시 자동 재시작</span>
              </label>

              {/* Internal RTSP URL (read-only) */}
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">내부 RTSP URL</label>
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
                {saving ? '저장 중…' : '저장'}
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

              {/* WebRTC toggle */}
              <div className="flex items-center justify-between py-2 border-t border-gray-700 mt-1">
                <div>
                  <p className="text-xs text-gray-200 font-medium">WebRTC Streaming</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {rtspForm.webrtcEnabled
                      ? 'Video via WebRTC (H.264 + Audio) — requires SERVER_IP in .env'
                      : 'Video via JPEG / Socket.IO (default)'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRtspForm((p) => ({ ...p, webrtcEnabled: !p.webrtcEnabled }))}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${
                    rtspForm.webrtcEnabled ? 'bg-blue-600' : 'bg-gray-600'
                  }`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
                    rtspForm.webrtcEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
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
