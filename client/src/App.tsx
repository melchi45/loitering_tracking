import { useState, useEffect } from 'react';
import { useSocket } from './hooks/useSocket';
import { useCameraStore } from './stores/cameraStore';
import { useAlertStore } from './stores/alertStore';
import { useDiscoveryStore } from './stores/discoveryStore';
import { useI18n, LANGUAGES, type LangCode } from './i18n';
import CameraGrid from './components/CameraGrid';
import CameraList from './components/CameraList';
import AlertPanel from './components/AlertPanel';
import DiscoveredCameraPanel from './components/DiscoveredCameraPanel';
import FullscreenCameraView from './components/FullscreenCameraView';
import type { Alert } from './types';

type Layout = 1 | 4 | 9 | 16;
type SidebarTab = 'cameras' | 'alerts' | 'zones';

const LAYOUT_OPTIONS: Layout[] = [1, 4, 9, 16];

function LayoutButton({ value, current, onClick }: { value: Layout; current: Layout; onClick: () => void }) {
  const isActive = value === current;
  const gridIcon = value === 1 ? '▣' : value === 4 ? '⊞' : value === 9 ? '⊟' : '⊠';
  return (
    <button
      onClick={onClick}
      title={`${value}-camera layout`}
      className={`px-3 py-1 text-sm rounded font-bold transition-colors ${
        isActive
          ? 'bg-blue-600 text-white'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
      }`}
    >
      {gridIcon} {value}
    </button>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { lang, setLang, t } = useI18n();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-80 max-h-[80vh] flex flex-col overflow-hidden">
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

        {/* Language section */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{t.settingsLanguage}</p>
          <div className="space-y-0.5">
            {LANGUAGES.map((lang_meta) => (
              <button
                key={lang_meta.code}
                onClick={() => { setLang(lang_meta.code as LangCode); }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                  lang === lang_meta.code
                    ? 'bg-blue-600/30 border border-blue-500/50 text-white'
                    : 'hover:bg-gray-700/60 text-gray-300'
                }`}
              >
                <span className="text-lg leading-none">{lang_meta.flag}</span>
                <span className="text-sm">{lang_meta.label}</span>
                {lang === lang_meta.code && (
                  <span className="ml-auto">
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

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

export default function App() {
  const [layout, setLayout] = useState<Layout>(4);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('cameras');
  const [fullscreenCameraId, setFullscreenCameraId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const { socket, connected } = useSocket();
  const updateCameraStatus = useCameraStore((s) => s.updateCameraStatus);
  const setCameras = useCameraStore((s) => s.setCameras);
  const cameras = useCameraStore((s) => s.cameras);
  const addAlert = useAlertStore((s) => s.addAlert);
  const unreadAlerts = useAlertStore((s) => s.alerts.filter((a) => !a.acknowledged).length);
  const selectedDiscovered = useDiscoveryStore((s) => s.selected);
  const selectDiscovered   = useDiscoveryStore((s) => s.select);
  const { t } = useI18n();

  // Fetch existing cameras from backend on mount
  useEffect(() => {
    fetch('/api/cameras')
      .then((r) => r.json())
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setCameras(res.data);
      })
      .catch(() => {});
  }, [setCameras]);

  // Global socket event handlers
  useEffect(() => {
    const handleCameraStatus = (event: { cameraId: string; status: 'live' | 'offline' | 'error' }) => {
      updateCameraStatus(event.cameraId, event.status);
    };

    const handleAlert = (event: {
      cameraId: string;
      objectId: number;
      zone?: string;
      dwellTime: number;
      timestamp: number;
    }) => {
      const alert: Alert = {
        id: `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        cameraId: event.cameraId,
        objectId: event.objectId,
        zone: event.zone,
        dwellTime: event.dwellTime,
        timestamp: event.timestamp,
        acknowledged: false,
      };
      addAlert(alert);
    };

    socket.on('camera:status', handleCameraStatus);
    socket.on('alert', handleAlert);

    return () => {
      socket.off('camera:status', handleCameraStatus);
      socket.off('alert', handleAlert);
    };
  }, [socket, updateCameraStatus, addAlert]);


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

        {/* Camera count */}
        <span className="text-xs text-gray-400">
          {cameras.filter((c) => c.status === 'live').length}/{cameras.length} {t.live}
        </span>

        {/* Layout toggle */}
        <div className="flex gap-1">
          {LAYOUT_OPTIONS.map((l) => (
            <LayoutButton
              key={l}
              value={l}
              current={layout}
              onClick={() => setLayout(l)}
            />
          ))}
        </div>

        {/* Settings gear icon */}
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
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Camera grid - main area */}
        <main className="flex-1 overflow-hidden p-2 relative">
          <CameraGrid layout={layout} onCameraDoubleClick={setFullscreenCameraId} />
          {selectedDiscovered && (
            <DiscoveredCameraPanel
              camera={selectedDiscovered}
              onClose={() => selectDiscovered(null)}
            />
          )}
        </main>

        {/* Sidebar */}
        <aside className="w-72 flex flex-col bg-gray-800 border-l border-gray-700 flex-shrink-0 overflow-hidden">
          {/* Sidebar tabs */}
          <div className="flex border-b border-gray-700 flex-shrink-0">
            {(['cameras', 'alerts', 'zones'] as SidebarTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setSidebarTab(tab)}
                className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wide transition-colors relative ${
                  sidebarTab === tab
                    ? 'text-blue-400 border-b-2 border-blue-400'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {tab === 'cameras' ? t.tabCameras : tab === 'alerts' ? t.tabAlerts : t.tabZones}
                {tab === 'alerts' && unreadAlerts > 0 && (
                  <span className="absolute top-1 right-1 w-4 h-4 text-[9px] font-bold bg-red-600 text-white rounded-full flex items-center justify-center">
                    {unreadAlerts > 9 ? '9+' : unreadAlerts}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Sidebar content */}
          <div className="flex-1 overflow-hidden">
            {sidebarTab === 'cameras' && <CameraList />}
            {sidebarTab === 'alerts' && <AlertPanel />}
            {sidebarTab === 'zones' && (
              <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                  />
                </svg>
                <p className="text-xs text-gray-400 leading-relaxed">{t.zoneHint}</p>
                {cameras.length === 0 && (
                  <p className="text-[10px] text-gray-600">{t.addCameraFirst}</p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Fullscreen camera overlay */}
      {fullscreenCameraId && (() => {
        const cam = cameras.find(c => c.id === fullscreenCameraId);
        return cam ? (
          <FullscreenCameraView
            cameraId={cam.id}
            cameraName={cam.name}
            onClose={() => setFullscreenCameraId(null)}
          />
        ) : null;
      })()}

      {/* Settings modal */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
