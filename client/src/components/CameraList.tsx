import React, { useState, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useCameraStore } from '../stores/cameraStore';
import type { Camera, DiscoveredCamera } from '../types';

interface AddCameraForm {
  name: string;
  rtspUrl: string;
  username: string;
  password: string;
}

const DEFAULT_FORM: AddCameraForm = {
  name: '',
  rtspUrl: '',
  username: '',
  password: '',
};

function StatusDot({ status }: { status: Camera['status'] }) {
  const color =
    status === 'live'
      ? 'bg-green-500'
      : status === 'error'
      ? 'bg-red-500'
      : status === 'offline'
      ? 'bg-gray-500'
      : 'bg-yellow-500';

  return (
    <span
      className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`}
      title={status}
    />
  );
}

export default function CameraList() {
  const { socket, connected } = useSocket();
  const cameras = useCameraStore((s) => s.cameras);
  const addCamera = useCameraStore((s) => s.addCamera);
  const removeCamera = useCameraStore((s) => s.removeCamera);

  const [showAddModal, setShowAddModal] = useState(false);
  const [form, setForm] = useState<AddCameraForm>(DEFAULT_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredCamera[]>([]);

  // Listen for discovery results
  useEffect(() => {
    const handleDiscovery = (data: { cameras: DiscoveredCamera[] }) => {
      setDiscovered(data.cameras ?? []);
      setDiscovering(false);
    };
    socket.on('discovery:result', handleDiscovery);
    return () => {
      socket.off('discovery:result', handleDiscovery);
    };
  }, [socket]);

  const handleDiscover = () => {
    setDiscovering(true);
    setDiscovered([]);
    socket.emit('discovery:start');
    // Timeout fallback after 15s
    setTimeout(() => setDiscovering(false), 15000);
  };

  const handleAddDiscovered = async (cam: DiscoveredCamera) => {
    try {
      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cam.name,
          rtspUrl: cam.rtspUrl,
          ip: cam.ip,
          mac: cam.mac,
        }),
      });
      if (!res.ok) throw new Error('Failed to add camera');
      const created: Camera = await res.json();
      addCamera(created);
      setDiscovered((prev) => prev.filter((c) => c.id !== cam.id));
    } catch (err) {
      console.error('Add discovered camera error:', err);
    }
  };

  const handleFormChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.rtspUrl.trim()) {
      setFormError('Name and RTSP URL are required.');
      return;
    }
    setFormError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          rtspUrl: form.rtspUrl,
          username: form.username || undefined,
          password: form.password || undefined,
        }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || 'Failed to add camera');
      }
      const created: Camera = await res.json();
      addCamera(created);
      setShowAddModal(false);
      setForm(DEFAULT_FORM);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm('Remove this camera?')) return;
    try {
      await fetch(`/api/cameras/${id}`, { method: 'DELETE' });
    } catch {
      // Remove locally even on error
    }
    removeCamera(id);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">Cameras</span>
          <span className="text-[10px] text-gray-400">
            ({cameras.length})
          </span>
          {/* Connection status */}
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={handleDiscover}
            disabled={!connected || discovering}
            className="text-[11px] px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white transition-colors"
            title="Auto-discover cameras on the network"
          >
            {discovering ? 'Scanning…' : 'Discover'}
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-[11px] px-2 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white transition-colors"
            title="Add camera manually"
          >
            + Add
          </button>
        </div>
      </div>

      {/* Camera list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {cameras.length === 0 && (
          <p className="text-xs text-gray-500 text-center mt-4">
            No cameras added yet.
          </p>
        )}
        {cameras.map((cam) => (
          <div
            key={cam.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-800 hover:bg-gray-700 group"
          >
            <StatusDot status={cam.status} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-white truncate">
                {cam.name}
              </div>
              {cam.ip && (
                <div className="text-[10px] text-gray-400 truncate">{cam.ip}</div>
              )}
            </div>
            <button
              onClick={() => handleRemove(cam.id)}
              className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-all text-xs px-1"
              title="Remove camera"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Discovered cameras */}
      {discovered.length > 0 && (
        <div className="border-t border-gray-700 p-2">
          <div className="text-[11px] font-semibold text-blue-400 mb-1.5 uppercase tracking-wide">
            Discovered ({discovered.length})
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {discovered.map((cam) => (
              <div
                key={cam.id}
                className="flex items-center gap-2 px-2 py-1 rounded bg-gray-800 text-xs"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-white truncate">{cam.name || cam.ip}</div>
                  <div className="text-gray-400 text-[10px]">{cam.ip}</div>
                </div>
                <button
                  onClick={() => handleAddDiscovered(cam)}
                  className="px-2 py-0.5 text-[11px] bg-blue-700 hover:bg-blue-600 text-white rounded transition-colors"
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Camera Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-gray-800 rounded-lg shadow-xl w-80 p-5 border border-gray-700">
            <h3 className="text-sm font-bold text-white mb-4">Add Camera</h3>
            <form onSubmit={handleFormSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">
                  Camera Name *
                </label>
                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleFormChange}
                  placeholder="Front Door"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">
                  RTSP URL *
                </label>
                <input
                  type="text"
                  name="rtspUrl"
                  value={form.rtspUrl}
                  onChange={handleFormChange}
                  placeholder="rtsp://192.168.1.100:554/stream"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  name="username"
                  value={form.username}
                  onChange={handleFormChange}
                  placeholder="admin"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-gray-400 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  name="password"
                  value={form.password}
                  onChange={handleFormChange}
                  placeholder="••••••••"
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              {formError && (
                <p className="text-xs text-red-400">{formError}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddModal(false);
                    setForm(DEFAULT_FORM);
                    setFormError('');
                  }}
                  className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white font-semibold transition-colors"
                >
                  {submitting ? 'Adding…' : 'Add Camera'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
