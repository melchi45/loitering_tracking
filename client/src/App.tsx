import { useState, useEffect, useRef } from 'react';
import { useSocket } from './hooks/useSocket';
import { useCameraStore } from './stores/cameraStore';
import { useAlertStore } from './stores/alertStore';
import { useDiscoveryStore } from './stores/discoveryStore';
import { useCrossCameraStore } from './stores/crossCameraStore';
import { usePersonTrajectoryStore } from './stores/personTrajectoryStore';
import { useI18n, LANGUAGES, type LangCode } from './i18n';
import { useWebRTCConfigStore, type WebRTCConfig, type TurnServer } from './stores/webrtcConfigStore';
import { useWebRTC } from './hooks/useWebRTC';
import CameraGrid, { LayoutId, LAYOUT_DEFS, LAYOUT_GROUPS, LayoutIcon } from './components/CameraGrid';
import CameraList from './components/CameraList';
import AlertPanel from './components/AlertPanel';
import DiscoveredCameraPanel from './components/DiscoveredCameraPanel';
import FullscreenCameraView from './components/FullscreenCameraView';
import { DashboardDetectionPanel } from './components/DashboardDetectionPanel';
import ZonesPanel from './components/ZonesPanel';
import VideoAnalyticsTab from './components/VideoAnalyticsTab';
import FaceGalleryTab from './components/FaceGalleryTab';
import { SearchBar } from './components/SearchBar';
import { SearchFullscreen } from './components/SearchFullscreen';
import StatsPanelModal from './components/StatsPanelModal';
import ProfileModal from './components/ProfileModal';
import type { SearchResult } from './hooks/useSearch';
import type { Alert, CrossCameraReIdEvent, PersonTrajectory } from './types';
import { useAuthStore } from './stores/authStore';
import SignInPage from './pages/SignInPage';
import PendingPage from './pages/PendingPage';
import AdminUsersPage from './pages/admin/AdminUsersPage';

type SidebarTab = 'cameras' | 'alerts' | 'zones' | 'detections' | 'analytics' | 'faces';

// ── Layout picker dropdown ──────────────────────────────────────────────────
function LayoutPicker({ current, onChange }: { current: LayoutId; onChange: (id: LayoutId) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium transition-colors"
        title="Select layout"
      >
        <span className="text-gray-300"><LayoutIcon id={current} size={16} /></span>
        <span className="font-bold">{current}</span>
        <svg className="w-3 h-3 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-2xl p-3 z-50 w-72">
          {LAYOUT_GROUPS.map((group) => (
            <div key={group.label} className="mb-3 last:mb-0">
              <div className="text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-2">
                {group.label}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.ids.map((id) => {
                  const def = LAYOUT_DEFS.find((d) => d.id === id)!;
                  const isActive = id === current;
                  return (
                    <button
                      key={id}
                      onClick={() => { onChange(id); setOpen(false); }}
                      title={`${id} — ${def.channels} channels`}
                      className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded transition-colors min-w-[44px] ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      <LayoutIcon id={id} size={20} />
                      <span className="text-[9px] font-medium leading-none">{id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { lang, setLang, t } = useI18n();
  const webrtcStore = useWebRTCConfigStore();

  // Local draft state — only persisted when Apply is clicked
  const [enabled,  setEnabled]  = useState(webrtcStore.enabled);
  const [stunUrls, setStunUrls] = useState<string[]>(webrtcStore.stunUrls);
  const [turns,    setTurns]    = useState<TurnServer[]>(webrtcStore.turns ?? []);
  const [saved,    setSaved]    = useState(false);

  function updateStun(idx: number, value: string) {
    setStunUrls((prev) => prev.map((u, i) => (i === idx ? value : u)));
    setSaved(false);
  }
  function addStun() {
    setStunUrls((prev) => [...prev, '']);
    setSaved(false);
  }
  function removeStun(idx: number) {
    setStunUrls((prev) => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  function updateTurn(idx: number, field: 'url' | 'username' | 'credential', value: string) {
    setTurns((prev) => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
    setSaved(false);
  }
  function addTurn() {
    setTurns((prev) => [...prev, { url: '', username: '', credential: '' }]);
    setSaved(false);
  }
  function removeTurn(idx: number) {
    setTurns((prev) => prev.filter((_, i) => i !== idx));
    setSaved(false);
  }

  function handleApply() {
    const cfg: WebRTCConfig = {
      enabled,
      stunUrls: stunUrls.map((u) => u.trim()).filter(Boolean),
      turns: turns.filter((t) => t.url.trim()),
    };
    webrtcStore.setConfig(cfg);
    setSaved(true);
  }

  const inputCls = 'w-full bg-gray-900 text-xs text-gray-200 px-2 py-1.5 rounded border border-gray-600 focus:outline-none focus:border-blue-500 placeholder-gray-600';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-96 max-h-[88vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <span className="text-sm font-bold text-white">{t.settingsTitle}</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-gray-700"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={(e) => e.preventDefault()} autoComplete="off" className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* ── Language ── */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{t.settingsLanguage}</p>
            <div className="relative">
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value as LangCode)}
                className="w-full appearance-none bg-gray-700 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-2 pr-8 focus:outline-none focus:border-blue-500 cursor-pointer"
              >
                {LANGUAGES.map((lang_meta) => (
                  <option key={lang_meta.code} value={lang_meta.code}>
                    {lang_meta.flag}  {lang_meta.label}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-gray-400">
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </span>
            </div>
          </div>

          {/* ── WebRTC ── */}
          <div className="border-t border-gray-700 pt-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{t.settingsWebRTC}</p>

            {/* Enable toggle */}
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-gray-300">{t.settingsWebRTCEnabled}</span>
              <button
                onClick={() => { setEnabled((v) => !v); setSaved(false); }}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${
                  enabled ? 'bg-blue-600' : 'bg-gray-600'
                }`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
                  enabled ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </button>
            </div>

            {/* STUN servers */}
            <p className="text-xs text-gray-500 mb-1">{t.settingsStunServers}</p>
            <div className="space-y-1 mb-1">
              {stunUrls.map((url, idx) => (
                <div key={idx} className="flex gap-1 items-center">
                  <input
                    value={url}
                    onChange={(e) => updateStun(idx, e.target.value)}
                    placeholder={t.settingsStunPlaceholder}
                    className={inputCls + ' flex-1'}
                  />
                  <button
                    onClick={() => removeStun(idx)}
                    className="text-gray-500 hover:text-red-400 transition-colors px-1 text-lg leading-none"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={addStun}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors mb-4"
            >
              {t.settingsStunAdd}
            </button>

            {/* TURN servers */}
            <p className="text-xs text-gray-500 mb-1">{t.settingsTurnServer}</p>
            <div className="space-y-2 mb-1">
              {turns.map((turn, idx) => (
                <div key={idx} className="space-y-1 bg-gray-900/50 border border-gray-700 rounded-lg p-2">
                  <div className="flex gap-1 items-center">
                    <input
                      value={turn.url}
                      onChange={(e) => updateTurn(idx, 'url', e.target.value)}
                      placeholder={t.settingsTurnUrlPlaceholder}
                      className={inputCls + ' flex-1'}
                    />
                    <button
                      onClick={() => removeTurn(idx)}
                      className="text-gray-500 hover:text-red-400 transition-colors px-1 text-lg leading-none flex-shrink-0"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex gap-1">
                    <input
                      value={turn.username}
                      onChange={(e) => updateTurn(idx, 'username', e.target.value)}
                      placeholder={t.settingsTurnUsername}
                      className={inputCls + ' flex-1'}
                    />
                    <input
                      value={turn.credential}
                      onChange={(e) => updateTurn(idx, 'credential', e.target.value)}
                      placeholder={t.settingsTurnCredential}
                      type="password"
                      autoComplete="new-password"
                      className={inputCls + ' flex-1'}
                    />
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={addTurn}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors mb-4"
            >
              {t.settingsTurnAdd}
            </button>

            {/* Apply button */}
            <button
              onClick={handleApply}
              className={`w-full py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                saved
                  ? 'bg-green-700/60 text-green-300 cursor-default'
                  : 'bg-blue-700 hover:bg-blue-600 text-white'
              }`}
            >
              {saved ? t.settingsWebRTCSaved : t.settingsWebRTCApply}
            </button>
          </div>
        </form>
        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm text-gray-200 transition-colors"
          >
            {t.settingsClose}
          </button>
        </div>
      </div>
    </div>
  );
}

// Hidden WebRTC connection used only by npm run ice-test (triggered via Socket.IO)
function IceTestTrigger({ cameraId }: { cameraId: string }) {
  const { videoRef } = useWebRTC(cameraId, true);
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
    />
  );
}

function Dashboard() {
  const auth = useAuthStore();

  // ── Dashboard ─────────────────────────────────────────────────────────────
  const [layout, setLayout] = useState<LayoutId>(() => {
    const saved = localStorage.getItem('lts-layout') as LayoutId | null;
    if (saved) return saved;
    return window.innerWidth < 768 ? '1' : '4';
  });  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('cameras');

  // Navigate to relevant sidebar tab when a search result is clicked
  const handleSearchNavigate = (result: SearchResult) => {
    if (result._type === 'alert')                setSidebarTab('alerts');
    else if (result._type === 'face')            setSidebarTab('faces');
    else if (result._type === 'match')           setSidebarTab('faces');
    else                                         setSidebarTab('detections');
  };

  const [fullscreenCameraId, setFullscreenCameraId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showStats,    setShowStats]    = useState(false);
  const [showProfile,  setShowProfile]  = useState(false);
  const [showSearchFullscreen, setShowSearchFullscreen] = useState(false);
  const [searchFullscreenQuery, setSearchFullscreenQuery] = useState('');
  const [iceTestCameraId, setIceTestCameraId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const isResizingRef = useRef(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [channelOffset, setChannelOffset] = useState(0);
  const swipeTouchStartX = useRef<number | null>(null);

  const { socket, connected } = useSocket();
  const updateCameraStatus = useCameraStore((s) => s.updateCameraStatus);
  const setCameras = useCameraStore((s) => s.setCameras);
  const cameras = useCameraStore((s) => s.cameras);
  const addAlert = useAlertStore((s) => s.addAlert);
  const unreadAlerts = useAlertStore((s) => s.alerts.filter((a) => !a.acknowledged).length);
  const selectedDiscovered = useDiscoveryStore((s) => s.selected);
  const selectDiscovered   = useDiscoveryStore((s) => s.select);
  const addCrossCameraEvent  = useCrossCameraStore((s) => s.addEvent);
  const updatePerson         = usePersonTrajectoryStore((s) => s.updatePerson);
  const hydratePerson        = usePersonTrajectoryStore((s) => s.hydrate);
  const { t } = useI18n();
  const setWebRTCConfig = useWebRTCConfigStore((s) => s.setConfig);
  const webrtcEnabled   = useWebRTCConfigStore((s) => s.enabled);

  // Fetch existing cameras from backend on mount
  useEffect(() => {
    fetch('/api/cameras')
      .then((r) => r.json())
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setCameras(res.data);
      })
      .catch(() => {});
  }, [setCameras]);

  // Hydrate person trajectory store on mount
  useEffect(() => {
    fetch('/api/persons/active')
      .then((r) => r.json())
      .then((res: { persons: PersonTrajectory[] }) => {
        if (Array.isArray(res.persons)) hydratePerson(res.persons);
      })
      .catch(() => {});
  }, [hydratePerson]);

  // Sync layout with server on mount.
  // • Server has value → apply it (source of truth across sessions).
  // • Server 404 (not set yet) → seed server from current localStorage/default value.
  useEffect(() => {
    const localVal = localStorage.getItem('lts-layout') as LayoutId | null;
    const currentId = (localVal && LAYOUT_DEFS.find((d) => d.id === localVal)) ? localVal : layout;

    fetch('/api/settings/layout')
      .then((r) => {
        if (r.status === 404) {
          // Seed server with current value
          fetch('/api/settings/layout', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: currentId }),
          }).catch(() => {});
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((data: { value?: string } | null) => {
        const id = data?.value as LayoutId | undefined;
        if (id && LAYOUT_DEFS.find((d) => d.id === id)) {
          setLayout(id);
          localStorage.setItem('lts-layout', id);
        }
      })
      .catch(() => {}); // offline — keep localStorage value
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mobile breakpoint detection
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Sync ICE/WebRTC config with server on mount.
  // Priority: DB settings → .env fallback (auto-seeded to DB on first hit).
  // On every mount, the server value overwrites localStorage to keep all sessions in sync.
  useEffect(() => {
    fetch('/api/settings/webrtcConfig')
      .then((r) => (r.ok ? r.json() : null))
      .then((resp: { success?: boolean; data?: { enabled?: boolean; stunUrls?: string[]; turns?: TurnServer[] } } | null) => {
        // Settings API wraps the payload in { success, data: {...} }
        const cfg = resp?.data;
        if (cfg && Array.isArray(cfg.stunUrls)) {
          // Server has saved config — use it and sync to store + localStorage
          setWebRTCConfig({
            enabled:  cfg.enabled ?? webrtcEnabled,
            stunUrls: cfg.stunUrls,
            turns:    cfg.turns ?? [],
          });
        } else {
          // Not in DB yet — call /api/webrtc/ice-config which seeds DB from .env
          fetch('/api/webrtc/ice-config')
            .then((r) => r.json())
            .then((iceCfg: { stunUrls: string[]; turns: TurnServer[] }) => {
              setWebRTCConfig({ enabled: webrtcEnabled, stunUrls: iceCfg.stunUrls ?? [], turns: iceCfg.turns ?? [] });
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global socket event handlers
  useEffect(() => {
    const handleCameraStatus = (event: { cameraId: string; status: 'live' | 'offline' | 'error' }) => {
      updateCameraStatus(event.cameraId, event.status);
    };

    const handleAlert = (event: {
      id?: string;
      cameraId: string;
      objectId: string | number;
      zone?: string;
      zoneName?: string;
      zoneId?: string;
      type?: string;
      dwellTime: number;
      timestamp: number | string;
      acknowledged?: boolean;
    }) => {
      const ts = typeof event.timestamp === 'string'
        ? new Date(event.timestamp).getTime()
        : (event.timestamp || Date.now());
      const alert: Alert = {
        id: event.id ?? `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        cameraId: event.cameraId,
        objectId: event.objectId,
        zone: event.zoneName ?? event.zone,
        zoneId: event.zoneId,
        type: event.type || 'LOITERING',
        dwellTime: event.dwellTime,
        timestamp: isNaN(ts) ? Date.now() : ts,
        acknowledged: event.acknowledged ?? false,
      };
      addAlert(alert);
    };

    const handleFaceReidentified = (event: CrossCameraReIdEvent) => {
      addCrossCameraEvent(event);
    };

    const handlePersonTrajectory = (p: PersonTrajectory) => {
      updatePerson(p);
    };

    const handleIceTestTrigger = ({ cameraId }: { cameraId: string }) => {
      setIceTestCameraId(cameraId);
    };
    const handleIceTestStop = () => setIceTestCameraId(null);

    socket.on('camera:status',           handleCameraStatus);
    socket.on('alert:new',               handleAlert);
    socket.on('face:reidentified',       handleFaceReidentified);
    socket.on('person:trajectory-update', handlePersonTrajectory);
    socket.on('webrtc:ice-test-trigger', handleIceTestTrigger);
    socket.on('webrtc:ice-test-stop',    handleIceTestStop);

    // Expose socket globally so FaceGalleryTab can subscribe to face_match events
    (window as unknown as Record<string, unknown>).__ltsSocket = socket;

    return () => {
      socket.off('camera:status',           handleCameraStatus);
      socket.off('alert:new',               handleAlert);
      socket.off('face:reidentified',       handleFaceReidentified);
      socket.off('person:trajectory-update', handlePersonTrajectory);
      socket.off('webrtc:ice-test-trigger', handleIceTestTrigger);
      socket.off('webrtc:ice-test-stop',    handleIceTestStop);
    };
  }, [socket, updateCameraStatus, addAlert, addCrossCameraEvent, updatePerson]);

  // ── Shared: tab nav items ───────────────────────────────────────────────────
  const TAB_ITEMS = [
    { id: 'cameras'    as SidebarTab, icon: '📷', label: t.tabCameras },
    { id: 'alerts'     as SidebarTab, icon: '🔔', label: t.tabAlerts },
    { id: 'zones'      as SidebarTab, icon: '🗺',  label: t.tabZones },
    { id: 'detections' as SidebarTab, icon: '👁',  label: t.tabDetections },
    { id: 'analytics'  as SidebarTab, icon: '🤖', label: t.tabVideoAnalytics },
    { id: 'faces'      as SidebarTab, icon: '🪪',  label: t.tabFaceGallery },
  ];

  // ── Shared: tab content renderer ────────────────────────────────────────────
  function renderTabContent() {
    if (sidebarTab === 'cameras')    return <CameraList />;
    if (sidebarTab === 'alerts')     return <AlertPanel />;
    if (sidebarTab === 'analytics')  return <VideoAnalyticsTab />;
    if (sidebarTab === 'detections') return <DashboardDetectionPanel />;
    if (sidebarTab === 'zones')      return <ZonesPanel onOpenCamera={setFullscreenCameraId} />;
    if (sidebarTab === 'faces')      return <FaceGalleryTab />;
    return null;
  }

  // ── Shared: stats chart button ──────────────────────────────────────────
  const statsBtn = (
    <button
      onClick={() => setShowStats(true)}
      className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
      title="Statistics"
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
    </button>
  );

  // ── Shared: settings gear button ─────────────────────────────────────────
  const settingsBtn = (
    <button
      onClick={() => setShowSettings(true)}
      className="p-1.5 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
      title={t.settings}
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </button>
  );

  // ── Shared: user menu (avatar + dropdown) ─────────────────────────────────
  const userMenu = auth.user ? (
    <div className="relative group">
      <button className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-gray-700 transition-colors" title={auth.user.email}>
        {auth.user.avatarDataUrl
          ? <img src={auth.user.avatarDataUrl} alt="avatar" className="w-6 h-6 rounded-full object-cover" />
          : <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center">
              {auth.user.name?.charAt(0).toUpperCase() || auth.user.email.charAt(0).toUpperCase()}
            </span>
        }
        <span className="text-xs text-gray-300 hidden sm:block max-w-[80px] truncate">{auth.user.name || auth.user.email}</span>
        <svg className="w-3 h-3 text-gray-500" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>
      <div className="absolute right-0 top-full mt-1 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 z-50 hidden group-hover:block">
        <div className="px-3 py-2 border-b border-gray-700">
          <p className="text-xs font-medium text-white truncate">{auth.user.name || auth.user.email}</p>
          <p className="text-xs text-gray-400 capitalize">{auth.user.role}</p>
          {auth.user.organization && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{auth.user.organization}</p>
          )}
        </div>
        <button onClick={() => setShowProfile(true)}
          className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Profile
        </button>
        {auth.user.role === 'admin' && (
          <button onClick={() => auth.navigateTo('admin')}
            className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
            User Management
          </button>
        )}
        <button onClick={() => auth.logout()}
          className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Sign Out
        </button>
      </div>
    </div>
  ) : null;

  // ── Shared: overlays ─────────────────────────────────────────────────────
  const overlays = (
    <>
      {iceTestCameraId && <IceTestTrigger cameraId={iceTestCameraId} />}
      {fullscreenCameraId && (() => {
        const cam = cameras.find(c => c.id === fullscreenCameraId);
        return cam ? (
          <FullscreenCameraView cameraId={cam.id} cameraName={cam.name} onClose={() => setFullscreenCameraId(null)} />
        ) : null;
      })()}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showStats    && <StatsPanelModal open={showStats} onClose={() => setShowStats(false)} />}
      {showProfile  && <ProfileModal onClose={() => setShowProfile(false)} />}
      {showSearchFullscreen && (
        <SearchFullscreen
          initialQuery={searchFullscreenQuery}
          onClose={() => setShowSearchFullscreen(false)}
        />
      )}
    </>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // MOBILE LAYOUT  (< 768px)
  // ════════════════════════════════════════════════════════════════════════════
  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-gray-900 overflow-hidden">
        {/* Mobile header */}
        <header className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              LTS
            </div>
            <h1 className="text-sm font-bold text-white whitespace-nowrap">{t.appTitle}</h1>
          </div>
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <div className="flex-1" />
          <span className="text-[10px] text-gray-400">{cameras.filter(c => c.status === 'live' || c.status === 'streaming').length}/{cameras.length} {t.live}</span>
          {statsBtn}
          {settingsBtn}
          {userMenu}
        </header>

        {/* Mobile content area */}
        <div className="flex-1 overflow-hidden">
          {sidebarTab === 'cameras' ? (
            /* Cameras tab: full area swipeable (grid 58% + list 42%) */
            (() => {
              const def = LAYOUT_DEFS.find((d) => d.id === layout)!;
              const pageSize    = def.channels;
              const totalPages  = cameras.length > 0 ? Math.ceil(cameras.length / pageSize) : 1;
              const currentPage = cameras.length > 0 ? Math.floor(channelOffset / pageSize) : 0;
              const clampedOffset = Math.min(channelOffset, Math.max(0, cameras.length - pageSize));

              const onTouchStart = (e: React.TouchEvent) => {
                swipeTouchStartX.current = e.touches[0].clientX;
              };
              const onTouchEnd = (e: React.TouchEvent) => {
                if (swipeTouchStartX.current === null) return;
                const dx = e.changedTouches[0].clientX - swipeTouchStartX.current;
                swipeTouchStartX.current = null;
                if (Math.abs(dx) < 40) return;
                const maxOffset = Math.max(0, cameras.length - pageSize);
                if (dx < 0) {
                  setChannelOffset((o) => Math.min(maxOffset, o + pageSize));
                } else {
                  setChannelOffset((o) => Math.max(0, o - pageSize));
                }
              };

              return (
                <div
                  className="flex flex-col h-full select-none"
                  onTouchStart={onTouchStart}
                  onTouchEnd={onTouchEnd}
                >
                  {/* Grid area */}
                  <div className="overflow-hidden p-1 relative" style={{ flex: '0 0 58%' }}>
                    <CameraGrid
                      layoutId={layout}
                      onCameraDoubleClick={setFullscreenCameraId}
                      startIndex={clampedOffset}
                    />
                    {selectedDiscovered && (
                      <DiscoveredCameraPanel camera={selectedDiscovered} onClose={() => selectDiscovered(null)} />
                    )}
                    {/* Mini layout picker overlay */}
                    <div className="absolute top-2 right-2 z-10">
                      <LayoutPicker current={layout} onChange={(id) => {
                      setLayout(id); setChannelOffset(0); localStorage.setItem('lts-layout', id);
                      fetch('/api/settings/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: id }) }).catch(() => {});
                    }} />
                    </div>
                    {/* Page indicator dots */}
                    {totalPages > 1 && (
                      <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5 pointer-events-none">
                        {Array.from({ length: totalPages }).map((_, i) => (
                          <span
                            key={i}
                            className={`w-1.5 h-1.5 rounded-full transition-colors ${
                              i === currentPage ? 'bg-blue-400' : 'bg-gray-600'
                            }`}
                          />
                        ))}
                      </div>
                    )}
                    {/* Page counter badge */}
                    {totalPages > 1 && cameras.length > 0 && (
                      <div className="absolute top-2 left-2 bg-black/50 rounded px-1.5 py-0.5 pointer-events-none">
                        <span className="text-[9px] text-gray-300">{currentPage + 1}/{totalPages}</span>
                      </div>
                    )}
                  </div>
                  {/* Camera list area — swipe is handled by parent div */}
                  <div className="border-t border-gray-700 overflow-hidden" style={{ flex: '0 0 42%' }}>
                    <CameraList />
                  </div>
                </div>
              );
            })()
          ) : (
            /* All other tabs: full screen content */
            <div className="h-full overflow-hidden">
              {renderTabContent()}
            </div>
          )}
        </div>

        {/* Mobile bottom navigation */}
        <nav className="flex border-t border-gray-700 bg-gray-900 flex-shrink-0" style={{ height: 52 }}>
          {TAB_ITEMS.map(({ id, icon, label }) => (
            <button
              key={id}
              onClick={() => setSidebarTab(id)}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 relative transition-colors ${
                sidebarTab === id ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {sidebarTab === id && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-blue-400 rounded-b" />
              )}
              <span className="text-lg leading-none">{icon}</span>
              <span className="text-[8px] font-semibold uppercase tracking-wide leading-none">{label}</span>
              {id === 'alerts' && unreadAlerts > 0 && (
                <span className="absolute top-1 right-2 w-3.5 h-3.5 text-[8px] font-bold bg-red-600 text-white rounded-full flex items-center justify-center">
                  {unreadAlerts > 9 ? '9+' : unreadAlerts}
                </span>
              )}
            </button>
          ))}
        </nav>

        {overlays}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DESKTOP LAYOUT  (≥ 768px)
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col h-screen bg-gray-900 overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-4 py-2 bg-gray-800 border-b border-gray-700 flex-shrink-0">
        {/* Title */}
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            LTS
          </div>
          <h1 className="text-sm font-bold text-white whitespace-nowrap">
            {t.appTitle}
          </h1>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-1.5 ml-2">
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
            {connected ? t.connected : t.disconnected}
          </span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Search bar */}
        <SearchBar
          onNavigate={handleSearchNavigate}
          onFullscreen={(q) => { setSearchFullscreenQuery(q); setShowSearchFullscreen(true); }}
        />

        {/* Camera count */}
        <span className="text-xs text-gray-400">
          {cameras.filter((c) => c.status === 'live' || c.status === 'streaming').length}/{cameras.length} {t.live}
        </span>

        {/* Layout picker */}
        <LayoutPicker current={layout} onChange={(id) => {
          setLayout(id); setChannelOffset(0); localStorage.setItem('lts-layout', id);
          fetch('/api/settings/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: id }) }).catch(() => {});
        }} />

        {statsBtn}
        {settingsBtn}
        {userMenu}
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar resize handle */}
        <div
          className="w-1 cursor-col-resize flex-shrink-0 bg-gray-700 hover:bg-blue-500 active:bg-blue-400 transition-colors z-10 order-last"
          onMouseDown={(e) => {
            e.preventDefault();
            isResizingRef.current = true;
            const startX = e.clientX;
            const startW = sidebarWidth;
            const onMove = (ev: MouseEvent) => {
              if (!isResizingRef.current) return;
              const delta = startX - ev.clientX;
              const next = Math.min(600, Math.max(180, startW + delta));
              setSidebarWidth(next);
            };
            const onUp = () => {
              isResizingRef.current = false;
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
        />

        {/* Camera grid - main area */}
        <main className="flex-1 overflow-hidden p-2 relative">
          {(() => {
            const def      = LAYOUT_DEFS.find((d) => d.id === layout)!;
            const pageSize = def.channels;
            const canPrev  = channelOffset > 0;
            const canNext  = cameras.length > pageSize && channelOffset + pageSize < cameras.length;
            return (
              <>
                <CameraGrid
                  layoutId={layout}
                  onCameraDoubleClick={setFullscreenCameraId}
                  startIndex={channelOffset}
                />
                {/* Previous channel page button */}
                {canPrev && (
                  <button
                    className="absolute left-3 top-1/2 -translate-y-1/2 z-20 bg-black/60 hover:bg-black/80 text-white w-8 h-14 flex items-center justify-center rounded-r-lg transition-colors shadow-lg"
                    onClick={() => setChannelOffset((o) => Math.max(0, o - pageSize))}
                    title="Previous channel page"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
                {/* Next channel page button */}
                {canNext && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-20 bg-black/60 hover:bg-black/80 text-white w-8 h-14 flex items-center justify-center rounded-l-lg transition-colors shadow-lg"
                    onClick={() => setChannelOffset((o) => Math.min(cameras.length - pageSize, o + pageSize))}
                    title="Next channel page"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
              </>
            );
          })()}
          {selectedDiscovered && (
            <DiscoveredCameraPanel
              camera={selectedDiscovered}
              onClose={() => selectDiscovered(null)}
            />
          )}
        </main>

        {/* Sidebar */}
        <aside
          className="flex flex-col bg-gray-800 border-l border-gray-700 flex-shrink-0 overflow-hidden"
          style={{ width: sidebarWidth }}
        >
          {/* Sidebar tabs */}
          <div className="flex border-b border-gray-700 flex-shrink-0 overflow-x-auto scrollbar-none">
            {TAB_ITEMS.map(({ id, icon, label }) => (
              <button
                key={id}
                title={label}
                onClick={() => setSidebarTab(id)}
                className={`flex-1 min-w-[36px] flex flex-col items-center justify-center py-1.5 gap-0.5 transition-colors relative ${
                  sidebarTab === id
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <span className="text-sm leading-none">{icon}</span>
                <span className="text-[9px] font-semibold uppercase tracking-wide leading-none truncate w-full text-center px-0.5">
                  {label}
                </span>
                {id === 'alerts' && unreadAlerts > 0 && (
                  <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 text-[8px] font-bold bg-red-600 text-white rounded-full flex items-center justify-center">
                    {unreadAlerts > 9 ? '9+' : unreadAlerts}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Sidebar content */}
          <div className="flex-1 overflow-hidden">
            {renderTabContent()}
          </div>
        </aside>
      </div>

      {overlays}
    </div>
  );
}

export default function App() {
  const auth = useAuthStore();
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    // Handle OAuth callback result passed via URL query param.
    // The server redirects to /?auth=success|pending|denied|error after OAuth.
    const params = new URLSearchParams(window.location.search);
    const authResult = params.get('auth');

    // Strip the query string immediately so it doesn't reappear on refresh.
    if (authResult) {
      window.history.replaceState({}, '', '/');
    }

    if (authResult === 'pending') {
      auth.navigateTo('pending');
      setInitializing(false);
      return;
    }

    if (authResult === 'denied' || authResult === 'error') {
      const reason = params.get('reason');
      auth.setError(
        reason === 'not_configured'
          ? 'OAuth provider is not configured. Contact your administrator.'
          : authResult === 'denied'
          ? 'Access denied. Contact an administrator to activate your account.'
          : 'Authentication failed. Please try again.',
      );
      setInitializing(false);
      return;
    }

    // Normal flow — try to restore session from HttpOnly refresh cookie.
    // On success this also calls auth.navigateTo('dashboard') internally.
    auth.refresh().finally(() => setInitializing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (initializing) {
    return (
      <div className="flex h-screen bg-gray-900 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-gray-400 text-sm">Loading…</span>
        </div>
      </div>
    );
  }

  if (auth.page === 'signin')  return <SignInPage />;
  if (auth.page === 'pending') return <PendingPage />;
  if (auth.page === 'admin')   return <AdminUsersPage />;
  return <Dashboard />;
}
