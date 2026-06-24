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
  webrtcEnabled: boolean;
}

interface AddYouTubeForm {
  name: string;
  youtubeUrl: string;
  resolution: '1080p' | '720p' | '480p';
  bitrate: number;
  repeatPlayback: boolean;
  webrtcEnabled: boolean;
}

type AddSourceType = 'rtsp' | 'youtube';

const DEFAULT_FORM: AddCameraForm = { name: '', rtspUrl: '', username: '', password: '', webrtcEnabled: false };
const DEFAULT_YT_FORM: AddYouTubeForm = { name: '', youtubeUrl: '', resolution: '1080p', bitrate: 2000, repeatPlayback: false, webrtcEnabled: false };

function StatusDot({ status }: { status: Camera['status'] }) {
  const color =
    (status === 'live' || status === 'streaming') ? 'bg-green-500' :
    status === 'error'                            ? 'bg-red-500'   :
    status === 'offline'                          ? 'bg-gray-500'  : 'bg-yellow-500';
  return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`} title={status} />;
}

type Tab = 'added' | 'found';

const SEARCH_FIELDS: Array<{ key: keyof DiscoveredCamera; label: string }> = [
  { key: 'Model',        label: 'Model'       },
  { key: 'Manufacturer', label: 'Manufacturer'},
  { key: 'IPAddress',    label: 'IP'          },
  { key: 'MACAddress',   label: 'MAC'         },
  { key: 'Gateway',      label: 'Gateway'     },
  { key: 'SubnetMask',   label: 'Subnet'      },
  { key: 'HttpPort',     label: 'HTTP'        },
  { key: 'HttpsPort',    label: 'HTTPS'       },
  { key: 'Port',         label: 'RTSP Port'   },
  { key: 'URL',          label: 'DDNS'        },
  { key: 'rtspUrl',      label: 'RTSP URL'    },
];

// Virtual category keywords — boolean/enum fields not matched by string comparison
const CATEGORY_MATCHERS: Array<{
  keywords: string[];
  label: string;
  match: (cam: DiscoveredCamera) => boolean;
}> = [
  {
    keywords: ['onvif'],
    label: 'ONVIF',
    match: (cam) => !!(cam.SupportOnvif || cam.source === 'onvif' || cam.source === 'both'),
  },
  {
    keywords: ['sunapi', 'wisenet', 'hanwha'],
    label: 'SUNAPI',
    match: (cam) => !!cam.SupportSunapi,
  },
  {
    keywords: ['udp', 'wisenet', 'hanwha'],
    label: 'WiseNet',
    match: (cam) => cam.source === 'udp' || cam.source === 'both',
  },
];

function getMatchedFields(cam: DiscoveredCamera, query: string): string[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase().trim();

  const matched: string[] = [];

  // Standard string fields
  for (const { key, label } of SEARCH_FIELDS) {
    if (String(cam[key] ?? '').toLowerCase().includes(q)) matched.push(label);
  }

  // Virtual category fields (ONVIF, SUNAPI, WiseNet…)
  for (const { keywords, label, match } of CATEGORY_MATCHERS) {
    if (keywords.some((kw) => kw.includes(q) || q.includes(kw)) && match(cam)) {
      if (!matched.includes(label)) matched.push(label);
    }
  }

  return matched;
}

export default function CameraList() {
  const { socket, connected } = useSocket();
  const cameras      = useCameraStore((s) => s.cameras);
  const addCamera    = useCameraStore((s) => s.addCamera);
  const removeCamera = useCameraStore((s) => s.removeCamera);
  const updateCamera = useCameraStore((s) => s.updateCamera);
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
  const [addSourceType, setAddSourceType] = useState<AddSourceType>('rtsp');

  // double-click guard: single click selects, double-click reconnects
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [form, setForm] = useState<AddCameraForm>(DEFAULT_FORM);
  const [ytForm, setYtForm] = useState<AddYouTubeForm>(DEFAULT_YT_FORM);
  const [ytStarting, setYtStarting] = useState(false);
  const [ytPollId, setYtPollId] = useState<string | null>(null);
  const [ytElapsed, setYtElapsed] = useState(0);
  const ytElapsedRef = useRef(0);
  const ytPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Auto-switch to Found tab when first device arrives
  const [autoSwitched, setAutoSwitched] = useState(false);

  // Auto-switch back to Added tab when a camera is added from Found tab
  const prevCamerasLen = useRef(cameras.length);

  // When a camera is added while on the Found tab, switch back to Added
  useEffect(() => {
    if (cameras.length > prevCamerasLen.current && tab === 'found') {
      setTab('added');
    }
    prevCamerasLen.current = cameras.length;
  }, [cameras.length, tab]);

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

  const handleAiToggle = useCallback(async (e: React.MouseEvent, cam: Camera) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/cameras/${cam.id}/ai/toggle`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        updateCamera(cam.id, { aiEnabled: data.aiEnabled });
      }
    } catch { /* ignore */ }
  }, [updateCamera]);

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

  const handleYtFormChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setYtForm((prev) => ({ ...prev, [name]: name === 'bitrate' ? Number(value) : value }));
  };

  // Poll stream status until live or error
  const startYtPoll = (id: string) => {
    setYtPollId(id);
    ytElapsedRef.current = 0;
    setYtElapsed(0);
    ytPollTimer.current = setInterval(async () => {
      ytElapsedRef.current += 2;
      setYtElapsed(ytElapsedRef.current);
      try {
        const r = await fetch(`/api/youtube-streams/${id}/status`);
        const data = await r.json();
        if (data.status === 'live') {
          stopYtPoll();
          addCamera({
            id: data.id,
            name: data.name,
            rtspUrl: data.rtspUrl,
            status: 'live',
            type: 'youtube',
            youtubeUrl: data.youtubeUrl,
            resolution: data.resolution,
            bitrate: data.bitrate,
            webrtcEnabled: data.webrtcEnabled,
          });
          closeAddModal();
          setTab('added');
        } else if (data.status === 'error') {
          stopYtPoll();
          setYtStarting(false);
          setFormError('Failed to start stream. Please try again.');
        } else if (ytElapsedRef.current >= 30) {
          stopYtPoll();
          setYtStarting(false);
          setFormError('Stream start timed out (30s).');
        }
      } catch { /* network error — keep polling */ }
    }, 2000);
  };

  const stopYtPoll = () => {
    if (ytPollTimer.current) { clearInterval(ytPollTimer.current); ytPollTimer.current = null; }
    setYtPollId(null);
  };

  const closeAddModal = () => {
    stopYtPoll();
    setShowAddModal(false);
    setForm(DEFAULT_FORM);
    setYtForm(DEFAULT_YT_FORM);
    setFormError('');
    setAddSourceType('rtsp');
    setYtStarting(false);
  };

  const handleYtFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ytForm.name.trim()) { setFormError('Please enter a channel name.'); return; }
    if (!ytForm.youtubeUrl.trim()) { setFormError('Please enter a YouTube URL.'); return; }
    setFormError('');
    setYtStarting(true);
    try {
      const res = await fetch('/api/youtube-streams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          youtubeUrl:     ytForm.youtubeUrl.trim(),
          name:           ytForm.name.trim(),
          resolution:     ytForm.resolution,
          bitrate:        ytForm.bitrate,
          repeatPlayback: ytForm.repeatPlayback,
          webrtcEnabled:  ytForm.webrtcEnabled,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setYtStarting(false);
        const msg =
          result.code === 'INVALID_YOUTUBE_URL' ? 'Invalid YouTube URL.' :
          result.code === 'YT_DLP_FAILED'       ? 'Cannot retrieve video. It may be private or deleted.' :
          result.code === 'MAX_STREAMS_REACHED'  ? 'Maximum number of YouTube streams reached.' :
          result.code === 'STREAM_TIMEOUT'       ? 'Stream start timed out. Please try again.' :
          result.error || 'Unknown error';
        setFormError(msg);
        return;
      }
      // Stream creation started — poll for live status
      startYtPoll(result.camera.id);
    } catch (err) {
      setYtStarting(false);
      setFormError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleRtspAdd = async () => {
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
          name:          form.name,
          rtspUrl:       form.rtspUrl,
          username:      form.username || undefined,
          password:      form.password || undefined,
          webrtcEnabled: form.webrtcEnabled,
        }),
      });
      if (!res.ok) throw new Error(await res.text() || 'Failed');
      const result = await res.json();
      if (result.success && result.data) addCamera(result.data);
      closeAddModal();
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
                const aiOn       = cam.aiEnabled !== false; // default true
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
                      <div className="flex items-center gap-1">
                        <span className="text-xs font-semibold text-white truncate">{cam.name}</span>
                        {cam.type === 'youtube' && (
                          <span className="flex-shrink-0 bg-red-700 text-white text-[9px] font-bold px-1 py-px rounded-sm">YT</span>
                        )}
                      </div>
                      {cam.type === 'youtube'
                        ? cam.youtubeUrl && (
                            <div className="text-[10px] text-gray-400 truncate" title={cam.youtubeUrl}>
                              {cam.youtubeUrl}
                            </div>
                          )
                        : cam.ip && (
                            <div className="text-[10px] text-gray-400 truncate">{cam.ip}</div>
                          )
                      }
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
                        onClick={(e) => handleAiToggle(e, cam)}
                        className={`text-[9px] font-bold px-1 rounded transition-colors ${
                          aiOn
                            ? 'text-green-400 hover:text-green-300'
                            : 'text-gray-600 hover:text-gray-400'
                        }`}
                        title={aiOn ? 'AI On — click to disable' : 'AI Off — click to enable'}
                      >
                        AI
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
                      {scanning ? 'Scanning (WiseNet UDP + ONVIF)…' : 'No devices found.'}
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
                  const isSelected    = selected?.id === cam.id;
                  const matchedFields = getMatchedFields(cam, searchQuery);
                  const src           = cam.source || 'udp';
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
                        <div className="text-[10px] text-gray-400 truncate">
                          {cam.Manufacturer ? `${cam.Manufacturer} · ` : ''}{cam.IPAddress}
                        </div>
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
                      <div className="flex flex-col items-end gap-0.5 flex-shrink-0 mt-0.5">
                        {(cam.MaxChannel ?? 1) > 1 && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-800 text-amber-300 font-bold">
                            {cam.MaxChannel}CH
                          </span>
                        )}
                        {(src === 'udp' || src === 'both') && cam.SupportSunapi && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-green-900 text-green-400">
                            SUNAPI
                          </span>
                        )}
                        {(src === 'onvif' || src === 'both' || !!cam.SupportOnvif) && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-purple-900 text-purple-300">
                            ONVIF
                          </span>
                        )}
                      </div>
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeAddModal(); }}
        >
          <div className="bg-gray-800 rounded-lg shadow-xl w-96 border border-gray-600">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <div>
                <h3 className="text-sm font-bold text-white">Add Camera</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {addSourceType === 'youtube' ? 'YouTube virtual channel' : 'Manual RTSP camera'}
                </p>
              </div>
              <button onClick={closeAddModal} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
            </div>

            {/* Source type toggle */}
            <div className="flex border-b border-gray-700">
              <button
                type="button"
                onClick={() => { setAddSourceType('rtsp'); setFormError(''); }}
                className={`flex-1 py-2 text-[11px] font-semibold transition-colors ${
                  addSourceType === 'rtsp'
                    ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                IP Camera (RTSP)
              </button>
              <button
                type="button"
                onClick={() => { setAddSourceType('youtube'); setFormError(''); }}
                className={`flex-1 py-2 text-[11px] font-semibold transition-colors ${
                  addSourceType === 'youtube'
                    ? 'text-red-400 border-b-2 border-red-400 bg-gray-800'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                ▶ YouTube Source
              </button>
            </div>

            {/* RTSP form */}
            {addSourceType === 'rtsp' && (
              <>
                {/* Form body */}
                <div className="p-4 space-y-3">
                  {/* Name */}
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">Name *</label>
                    <input
                      name="name"
                      value={form.name}
                      onChange={handleFormChange}
                      placeholder="Front Door"
                      className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  {/* RTSP URL */}
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">RTSP URL *</label>
                    <input
                      name="rtspUrl"
                      value={form.rtspUrl}
                      onChange={handleFormChange}
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
                        onChange={handleFormChange}
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
                        onChange={handleFormChange}
                        placeholder="••••••••"
                        className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  {/* Tip */}
                  <p className="text-[10px] text-gray-500">
                    Leave Username/Password blank if no credentials required.
                  </p>

                  {/* WebRTC toggle */}
                  <div className="flex items-center justify-between py-2 border-t border-gray-700 mt-1">
                    <div>
                      <p className="text-xs text-gray-200 font-medium">WebRTC Streaming</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">
                        {form.webrtcEnabled
                          ? 'Video via WebRTC (H.264 + Audio) — requires SERVER_IP in .env'
                          : 'Video via JPEG / Socket.IO (default)'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm((p) => ({ ...p, webrtcEnabled: !p.webrtcEnabled }))}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${
                        form.webrtcEnabled ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
                        form.webrtcEnabled ? 'translate-x-4' : 'translate-x-0.5'
                      }`} />
                    </button>
                  </div>

                  {formError && <p className="text-xs text-red-400">{formError}</p>}
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
                  <button
                    type="button"
                    onClick={closeAddModal}
                    className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRtspAdd}
                    disabled={submitting}
                    className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white font-semibold transition-colors"
                  >
                    {submitting ? 'Adding…' : 'Add Camera'}
                  </button>
                </div>
              </>
            )}

            {/* YouTube form */}
            {addSourceType === 'youtube' && (
              <div className="p-4">
                {/* ToS warning */}
                <div className="mb-3 text-[10px] text-yellow-500 bg-yellow-900/20 border border-yellow-700/40 rounded px-2 py-1.5">
                  ⚠ Streaming YouTube content may violate YouTube's Terms of Service (Section 5.B).
                  Only use with your own channel videos or videos with appropriate licensing.
                </div>

                {ytStarting ? (
                  /* Loading state */
                  <div className="py-6 text-center space-y-3">
                    <div className="text-2xl animate-pulse">⏳</div>
                    <p className="text-xs text-gray-300">Resolving YouTube URL…</p>
                    <p className="text-[11px] text-gray-500">Elapsed: {ytElapsed}s / 30s</p>
                    <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-red-500 h-1.5 rounded-full transition-all duration-1000"
                        style={{ width: `${Math.min((ytElapsed / 30) * 100, 100)}%` }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        stopYtPoll();
                        setYtStarting(false);
                        // Cancel the stream if it was already created
                        if (ytPollId) {
                          fetch(`/api/youtube-streams/${ytPollId}`, { method: 'DELETE' }).catch(() => {});
                        }
                      }}
                      className="text-xs text-gray-400 hover:text-gray-200 underline"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleYtFormSubmit} className="space-y-3">
                    <div>
                      <label className="block text-[11px] text-gray-400 mb-1">Channel Name *</label>
                      <input
                        name="name"
                        value={ytForm.name}
                        onChange={handleYtFormChange}
                        placeholder="Crowd test video"
                        className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-gray-400 mb-1">YouTube URL *</label>
                      <input
                        name="youtubeUrl"
                        value={ytForm.youtubeUrl}
                        onChange={handleYtFormChange}
                        placeholder="https://www.youtube.com/watch?v=..."
                        className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 font-mono focus:outline-none focus:border-red-500"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-gray-400 mb-1">Resolution</label>
                        <select
                          name="resolution"
                          value={ytForm.resolution}
                          onChange={handleYtFormChange}
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
                          onChange={handleYtFormChange}
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
                        onChange={(e) => setYtForm((prev) => ({ ...prev, repeatPlayback: e.target.checked }))}
                        className="w-3.5 h-3.5 rounded accent-red-500"
                      />
                      <span>Repeat Playback — auto-restart when video ends</span>
                    </label>

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
                        onClick={() => setYtForm((prev) => ({ ...prev, webrtcEnabled: !prev.webrtcEnabled }))}
                        className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${
                          ytForm.webrtcEnabled ? 'bg-blue-600' : 'bg-gray-600'
                        }`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
                          ytForm.webrtcEnabled ? 'translate-x-4' : 'translate-x-0.5'
                        }`} />
                      </button>
                    </div>

                    {formError && <p className="text-xs text-red-400">{formError}</p>}
                    <div className="flex justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={closeAddModal}
                        className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white font-semibold"
                      >
                        Add Stream
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
