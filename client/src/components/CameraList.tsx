import { useState, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useCameraStore } from '../stores/cameraStore';
import type { Camera, DiscoveredCamera } from '../types';

interface AddCameraForm {
  name: string;
  rtspUrl: string;
  username: string;
  password: string;
}

const DEFAULT_FORM: AddCameraForm = { name: '', rtspUrl: '', username: '', password: '' };

function StatusDot({ status }: { status: Camera['status'] }) {
  const color =
    status === 'live'    ? 'bg-green-500' :
    status === 'error'   ? 'bg-red-500'   :
    status === 'offline' ? 'bg-gray-500'  : 'bg-yellow-500';
  return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`} title={status} />;
}

function Field({ label, value }: { label: string; value?: string | number | boolean }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex gap-1 text-[10px]">
      <span className="text-gray-500 flex-shrink-0">{label}:</span>
      <span className="text-gray-300 truncate">{String(value)}</span>
    </div>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const handleDevice = (data: { device: DiscoveredCamera }) => {
      if (!data?.device) return;
      setDiscovered((prev) => {
        if (prev.find((c) => c.id === data.device.id)) return prev;
        return [...prev, data.device];
      });
    };
    const handleDone = () => setDiscovering(false);

    socket.on('discovery:result', handleDevice);
    socket.on('discovery:done',   handleDone);
    return () => {
      socket.off('discovery:result', handleDevice);
      socket.off('discovery:done',   handleDone);
    };
  }, [socket]);

  const handleDiscover = () => {
    setDiscovering(true);
    setDiscovered([]);
    setExpandedId(null);
    socket.emit('discovery:start', { timeout: 8000 });
    // Fallback: clear scanning state after 10s if done event never arrives
    setTimeout(() => setDiscovering(false), 10000);
  };

  const buildRtspUrl = (cam: DiscoveredCamera) => {
    if (cam.rtspUrl) return cam.rtspUrl;
    return `rtsp://${cam.IPAddress}:${cam.Port || 554}/profile1/media.smp`;
  };

  const handleAddDiscovered = async (cam: DiscoveredCamera) => {
    try {
      const port = cam.HttpType ? cam.HttpsPort : cam.HttpPort;
      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:     cam.Model || cam.IPAddress,
          rtspUrl:  buildRtspUrl(cam),
          ip:       cam.IPAddress,
          mac:      cam.MACAddress,
          httpPort: port,
        }),
      });
      if (!res.ok) throw new Error('Failed to add camera');
      const result = await res.json();
      if (result.success && result.data) addCamera(result.data);
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
      const result = await res.json();
      if (result.success && result.data) addCamera(result.data);
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
    try { await fetch(`/api/cameras/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
    removeCamera(id);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">Cameras</span>
          <span className="text-[10px] text-gray-400">({cameras.length})</span>
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
            title={connected ? 'Connected' : 'Disconnected — waiting for server'}
          />
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={handleDiscover}
            disabled={!connected || discovering}
            className="text-[11px] px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white transition-colors"
            title={!connected ? 'Waiting for server connection…' : 'Discover WiseNet cameras on the network'}
          >
            {discovering ? (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-300 animate-ping inline-block" />
                Scanning…
              </span>
            ) : 'Discover'}
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
        {cameras.length === 0 && !discovering && discovered.length === 0 && (
          <p className="text-xs text-gray-500 text-center mt-4">
            No cameras yet. Use <strong>Discover</strong> or <strong>+ Add</strong>.
          </p>
        )}
        {cameras.map((cam) => (
          <div
            key={cam.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-800 hover:bg-gray-700 group"
          >
            <StatusDot status={cam.status} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-white truncate">{cam.name}</div>
              {cam.ip && <div className="text-[10px] text-gray-400 truncate">{cam.ip}</div>}
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
      {(discovering || discovered.length > 0) && (
        <div className="border-t border-gray-700 flex-shrink-0">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[11px] font-semibold text-blue-400 uppercase tracking-wide">
              {discovering ? 'Scanning…' : `Found (${discovered.length})`}
            </span>
            {discovered.length > 0 && (
              <button
                onClick={() => setDiscovered([])}
                className="text-[10px] text-gray-500 hover:text-gray-300"
              >
                clear
              </button>
            )}
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1 px-2 pb-2">
            {discovered.map((cam) => {
              const isExpanded = expandedId === cam.id;
              const scheme = cam.HttpType ? 'https' : 'http';
              const webPort = cam.HttpType ? cam.HttpsPort : cam.HttpPort;
              return (
                <div key={cam.id} className="rounded bg-gray-800 border border-gray-700 overflow-hidden">
                  {/* Summary row */}
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-white truncate">
                        {cam.Model || cam.IPAddress}
                      </div>
                      <div className="text-[10px] text-gray-400">{cam.IPAddress}</div>
                    </div>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : cam.id)}
                      className="text-[10px] text-gray-500 hover:text-gray-300 px-1 flex-shrink-0"
                      title="Show details"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                    <button
                      onClick={() => handleAddDiscovered(cam)}
                      className="px-2 py-0.5 text-[11px] bg-blue-700 hover:bg-blue-600 text-white rounded transition-colors flex-shrink-0"
                    >
                      Add
                    </button>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-3 py-2 border-t border-gray-700 bg-gray-900 space-y-0.5">
                      <Field label="MAC"        value={cam.MACAddress} />
                      <Field label="IP"         value={cam.IPAddress} />
                      <Field label="Gateway"    value={cam.Gateway} />
                      <Field label="Subnet"     value={cam.SubnetMask} />
                      <Field label="Model"      value={cam.Model} />
                      <Field label="Type"       value={cam.Type} />
                      <Field label="Protocol"   value={scheme.toUpperCase()} />
                      <Field label="HTTP Port"  value={cam.HttpPort} />
                      <Field label="HTTPS Port" value={cam.HttpsPort} />
                      <Field label="RTSP Port"  value={cam.Port} />
                      <Field label="SUNAPI"     value={cam.SupportSunapi ? 'Yes' : 'No'} />
                      {cam.URL && <Field label="DDNS" value={cam.URL} />}
                      <div className="mt-1.5 pt-1 border-t border-gray-700 space-y-0.5">
                        <div className="text-[10px] text-gray-500">Web URL:</div>
                        <div className="text-[10px] text-blue-400 break-all">
                          {scheme}://{cam.IPAddress}:{webPort}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">RTSP URL:</div>
                        <div className="text-[10px] text-green-400 break-all">
                          {buildRtspUrl(cam)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Camera Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-gray-800 rounded-lg shadow-xl w-80 p-5 border border-gray-700">
            <h3 className="text-sm font-bold text-white mb-4">Add Camera</h3>
            <form onSubmit={handleFormSubmit} className="space-y-3">
              {(['name', 'rtspUrl', 'username', 'password'] as const).map((field) => (
                <div key={field}>
                  <label className="block text-[11px] text-gray-400 mb-1 capitalize">
                    {field === 'rtspUrl' ? 'RTSP URL' : field}
                    {(field === 'name' || field === 'rtspUrl') && ' *'}
                  </label>
                  <input
                    type={field === 'password' ? 'password' : 'text'}
                    name={field}
                    value={form[field]}
                    onChange={handleFormChange}
                    placeholder={
                      field === 'name'     ? 'Front Door' :
                      field === 'rtspUrl'  ? 'rtsp://192.168.1.100:554/stream' :
                      field === 'username' ? 'admin' : '••••••••'
                    }
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              ))}
              {formError && <p className="text-xs text-red-400">{formError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowAddModal(false); setForm(DEFAULT_FORM); setFormError(''); }}
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
