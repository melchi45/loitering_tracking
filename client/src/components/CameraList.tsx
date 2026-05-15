import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useCameraStore } from '../stores/cameraStore';
import { useDiscoveryStore } from '../stores/discoveryStore';
import CameraEditModal from './CameraEditModal';
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

type Tab = 'added' | 'found';

const SEARCH_FIELDS: Array<{ key: keyof DiscoveredCamera; label: string }> = [
  { key: 'Model',       label: 'Model'      },
  { key: 'IPAddress',   label: 'IP'         },
  { key: 'MACAddress',  label: 'MAC'        },
  { key: 'Gateway',     label: 'Gateway'    },
  { key: 'SubnetMask',  label: 'Subnet'     },
  { key: 'HttpPort',    label: 'HTTP'       },
  { key: 'HttpsPort',   label: 'HTTPS'      },
  { key: 'Port',        label: 'RTSP Port'  },
  { key: 'URL',         label: 'DDNS'       },
  { key: 'rtspUrl',     label: 'RTSP URL'   },
];

function getMatchedFields(cam: DiscoveredCamera, query: string): string[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  return SEARCH_FIELDS
    .filter(({ key }) => String(cam[key] ?? '').toLowerCase().includes(q))
    .map(({ label }) => label);
}

export default function CameraList() {
  const { socket, connected } = useSocket();
  const cameras      = useCameraStore((s) => s.cameras);
  const addCamera    = useCameraStore((s) => s.addCamera);
  const removeCamera = useCameraStore((s) => s.removeCamera);
  const selectedId   = useCameraStore((s) => s.selectedId);
  const selectCamera = useCameraStore((s) => s.selectCamera);

  const discovered    = useDiscoveryStore((s) => s.cameras);
  const selected      = useDiscoveryStore((s) => s.selected);
  const scanning      = useDiscoveryStore((s) => s.scanning);
  const addOrUpdate   = useDiscoveryStore((s) => s.addOrUpdate);
  const clearFound    = useDiscoveryStore((s) => s.clear);
  const selectDiscovered = useDiscoveryStore((s) => s.select);
  const setScanning   = useDiscoveryStore((s) => s.setScanning);

  const [tab, setTab] = useState<Tab>('added');
  const [editCamera, setEditCamera] = useState<Camera | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  // double-click guard: single click selects, double-click reconnects
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [form, setForm] = useState<AddCameraForm>(DEFAULT_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Auto-switch to Found tab when first device arrives
  const [autoSwitched, setAutoSwitched] = useState(false);

  // Listen for server-pushed discovery events
  useEffect(() => {
    const handleResult = (data: { device: DiscoveredCamera }) => {
      if (!data?.device) return;
      addOrUpdate(data.device);
      if (!autoSwitched) {
        setTab('found');
        setAutoSwitched(true);
      }
    };
    const handleScanning = (data: { scanning: boolean; count?: number }) => {
      setScanning(data.scanning);
    };
    const handleCleared = () => {
      clearFound();
    };

    socket.on('discovery:result',  handleResult);
    socket.on('discovery:scanning', handleScanning);
    socket.on('discovery:cleared', handleCleared);
    return () => {
      socket.off('discovery:result',  handleResult);
      socket.off('discovery:scanning', handleScanning);
      socket.off('discovery:cleared', handleCleared);
    };
  }, [socket, addOrUpdate, clearFound, setScanning, autoSwitched]);

  const handleClean = () => {
    clearFound();
    selectDiscovered(null);
    setAutoSwitched(false);
    socket.emit('discovery:rescan');
  };

  const handleRemoveCamera = async (id: string) => {
    if (!confirm('Remove this camera?')) return;
    try { await fetch(`/api/cameras/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
    removeCamera(id);
  };

  const handleReconnect = useCallback(async (id: string) => {
    setReconnecting(id);
    try {
      await fetch(`/api/cameras/${id}/stream/reconnect`, { method: 'POST' });
    } catch { /* ignore */ }
    finally { setTimeout(() => setReconnecting(null), 2000); }
  }, []);

  const handleCameraClick = useCallback((cam: Camera) => {
    if (clickTimerRef.current) {
      // Second click within 300ms → treat as double-click
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      handleReconnect(cam.id);
    } else {
      // First click → select (with short delay to detect double)
      selectCamera(selectedId === cam.id ? null : cam.id);
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
      }, 300);
    }
  }, [selectedId, selectCamera, handleReconnect]);

  const handleContextMenu = useCallback((e: React.MouseEvent, cam: Camera) => {
    e.preventDefault();
    setEditCamera(cam);
  }, []);

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
          name:     form.name,
          rtspUrl:  form.rtspUrl,
          username: form.username || undefined,
          password: form.password || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text() || 'Failed');
      const result = await res.json();
      if (result.success && result.data) addCamera(result.data);
      setShowAddModal(false);
      setForm(DEFAULT_FORM);
      setTab('added');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">Cameras</span>
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="text-[11px] px-2 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white transition-colors"
          title="Add camera manually"
        >
          + Add
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700 flex-shrink-0">
        <button
          onClick={() => setTab('added')}
          className={`flex-1 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
            tab === 'added' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Added ({cameras.length})
        </button>
        <button
          onClick={() => setTab('found')}
          className={`flex-1 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors relative ${
            tab === 'found' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {scanning && (
            <span className="absolute left-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
          )}
          Found ({discovered.length})
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {/* ── Added cameras ── */}
        {tab === 'added' && (
          <div className="p-2 space-y-1">
            {cameras.length === 0 ? (
              <p className="text-xs text-gray-500 text-center mt-6">
                No cameras yet. Use <strong>+ Add</strong> or select from <strong>Found</strong>.
              </p>
            ) : (
              cameras.map((cam) => {
                const isSelected = selectedId === cam.id;
                const isReconn   = reconnecting === cam.id;
                return (
                  <div
                    key={cam.id}
                    onClick={() => handleCameraClick(cam)}
                    onContextMenu={(e) => handleContextMenu(e, cam)}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded border cursor-pointer select-none transition-all group ${
                      isSelected
                        ? 'bg-blue-900/50 border-blue-600'
                        : 'bg-gray-800 border-gray-700 hover:bg-gray-700 hover:border-gray-600'
                    }`}
                    title="Click: select  |  Double-click: reconnect  |  Right-click: edit"
                  >
                    <StatusDot status={cam.status} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{cam.name}</div>
                      {cam.ip && <div className="text-[10px] text-gray-400 truncate">{cam.ip}</div>}
                    </div>
                    {isReconn && (
                      <span className="text-[9px] text-yellow-400 animate-pulse flex-shrink-0">Reconnecting…</span>
                    )}
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditCamera(cam); }}
                        className="text-gray-500 hover:text-blue-400 text-xs px-1"
                        title="Edit"
                      >
                        ✎
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleReconnect(cam.id); }}
                        className="text-gray-500 hover:text-yellow-400 text-xs px-1"
                        title="Reconnect"
                      >
                        ↺
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemoveCamera(cam.id); }}
                        className="text-gray-500 hover:text-red-400 text-xs px-1"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ── Found (discovered) cameras ── */}
        {tab === 'found' && (
          <div className="flex flex-col h-full">
            {/* Found header: scanning indicator + Clean */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                {scanning ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
                    <span className="text-[11px] text-blue-400">Scanning…</span>
                  </>
                ) : (
                  <span className="text-[11px] text-gray-400">
                    {discovered.length > 0 ? `${discovered.length} device(s) found` : 'Waiting…'}
                  </span>
                )}
              </div>
              <button
                onClick={handleClean}
                className="text-[10px] px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                title="Clear results and restart scan"
              >
                Clean
              </button>
            </div>

            {/* Search box */}
            <div className="px-2 py-1.5 border-b border-gray-700 flex-shrink-0">
              <div className="relative">
                <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Model, IP, MAC, port, URL…"
                  className="w-full bg-gray-900 border border-gray-600 rounded pl-6 pr-6 py-1 text-[11px] text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
              {searchQuery.trim() && (() => {
                const hits = discovered.filter((c) => getMatchedFields(c, searchQuery).length > 0).length;
                return (
                  <div className="mt-1 text-[10px] text-gray-500">
                    {hits} / {discovered.length} match
                  </div>
                );
              })()}
            </div>

            {/* Device list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {(() => {
                const filtered = searchQuery.trim()
                  ? discovered.filter((c) => getMatchedFields(c, searchQuery).length > 0)
                  : discovered;

                if (discovered.length === 0) {
                  return (
                    <p className="text-xs text-gray-500 text-center mt-6">
                      {scanning ? 'Scanning for WiseNet cameras…' : 'No devices found.'}
                    </p>
                  );
                }
                if (filtered.length === 0) {
                  return (
                    <p className="text-xs text-gray-500 text-center mt-6">
                      No matches for "<span className="text-gray-300">{searchQuery}</span>"
                    </p>
                  );
                }

                return filtered.map((cam) => {
                  const isSelected = selected?.id === cam.id;
                  const matchedFields = getMatchedFields(cam, searchQuery);
                  return (
                    <button
                      key={cam.id}
                      onClick={() => selectDiscovered(isSelected ? null : cam)}
                      className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded border transition-all ${
                        isSelected
                          ? 'bg-blue-900/50 border-blue-600'
                          : 'bg-gray-800 border-gray-700 hover:bg-gray-700 hover:border-gray-600'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 mt-1" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-white truncate">
                          {cam.Model || cam.IPAddress}
                        </div>
                        <div className="text-[10px] text-gray-400 truncate">{cam.IPAddress}</div>
                        {matchedFields.length > 0 && (
                          <div className="flex flex-wrap gap-0.5 mt-0.5">
                            {matchedFields.map((f) => (
                              <span
                                key={f}
                                className="px-1 py-px rounded text-[9px] bg-yellow-900/60 text-yellow-400"
                              >
                                {f}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {cam.SupportSunapi && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-green-900 text-green-400 flex-shrink-0 mt-0.5">
                          SUNAPI
                        </span>
                      )}
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Edit Camera Modal */}
      {editCamera && (
        <CameraEditModal
          camera={editCamera}
          onClose={() => setEditCamera(null)}
        />
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
                  className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white font-semibold"
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
