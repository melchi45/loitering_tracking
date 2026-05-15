import { useState } from 'react';
import { useCameraStore } from '../stores/cameraStore';
import type { Camera } from '../types';

interface Props {
  camera: Camera;
  onClose: () => void;
}

export default function CameraEditModal({ camera, onClose }: Props) {
  const updateCamera = useCameraStore((s) => s.updateCamera);

  const [form, setForm] = useState({
    name:     camera.name,
    rtspUrl:  camera.rtspUrl,
    username: '',
    password: '',
  });
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [e.target.name]: e.target.value }));

  const handleSave = async (andReconnect: boolean) => {
    if (!form.name.trim() || !form.rtspUrl.trim()) {
      setError('Name and RTSP URL are required.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      // 1. Update camera config
      const res = await fetch(`/api/cameras/${camera.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:     form.name,
          rtspUrl:  form.rtspUrl,
          username: form.username || undefined,
          password: form.password || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text() || 'Save failed');
      const result = await res.json();
      if (result.success && result.data) updateCamera(camera.id, result.data);

      // 2. Reconnect stream
      if (andReconnect) {
        const rRes = await fetch(`/api/cameras/${camera.id}/stream/reconnect`, { method: 'POST' });
        if (!rRes.ok) throw new Error('Reconnect failed');
        setSuccess('Saved & reconnecting…');
      } else {
        setSuccess('Saved.');
      }

      setTimeout(onClose, 800);
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
            <h3 className="text-sm font-bold text-white">Edit Camera</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">{camera.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Form */}
        <div className="p-4 space-y-3">
          {/* Name */}
          <div>
            <label className="block text-[11px] text-gray-400 mb-1">Name *</label>
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* RTSP URL */}
          <div>
            <label className="block text-[11px] text-gray-400 mb-1">RTSP URL *</label>
            <input
              name="rtspUrl"
              value={form.rtspUrl}
              onChange={handleChange}
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
                value={form.username}
                onChange={handleChange}
                placeholder="admin"
                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Password</label>
              <input
                name="password"
                type="password"
                value={form.password}
                onChange={handleChange}
                placeholder="(unchanged)"
                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Tip */}
          <p className="text-[10px] text-gray-500">
            Leave Username/Password blank to keep existing credentials.
          </p>

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
            onClick={() => handleSave(false)}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white transition-colors"
          >
            Save only
          </button>
          <button
            onClick={() => handleSave(true)}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white font-semibold transition-colors"
          >
            {saving ? 'Saving…' : 'Save & Reconnect'}
          </button>
        </div>
      </div>
    </div>
  );
}
