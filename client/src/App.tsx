import { useState, useEffect } from 'react';
import { useSocket } from './hooks/useSocket';
import { useCameraStore } from './stores/cameraStore';
import { useAlertStore } from './stores/alertStore';
import { useDiscoveryStore } from './stores/discoveryStore';
import CameraGrid from './components/CameraGrid';
import CameraList from './components/CameraList';
import AlertPanel from './components/AlertPanel';
import DiscoveredCameraPanel from './components/DiscoveredCameraPanel';
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

export default function App() {
  const [layout, setLayout] = useState<Layout>(4);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('cameras');

  const { socket, connected } = useSocket();
  const updateCameraStatus = useCameraStore((s) => s.updateCameraStatus);
  const setCameras = useCameraStore((s) => s.setCameras);
  const cameras = useCameraStore((s) => s.cameras);
  const addAlert = useAlertStore((s) => s.addAlert);
  const unreadAlerts = useAlertStore((s) => s.alerts.filter((a) => !a.acknowledged).length);
  const selectedDiscovered = useDiscoveryStore((s) => s.selected);
  const selectDiscovered   = useDiscoveryStore((s) => s.select);

  // Fetch existing cameras from backend on mount
  useEffect(() => {
    fetch('/api/cameras')
      .then((r) => r.json())
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setCameras(res.data);
      })
      .catch(() => {
        // Backend not available yet — start with empty list
      });
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
            Loitering Detection Dashboard
          </h1>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-1.5 ml-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
          />
          <span className={`text-xs ${connected ? 'text-green-400' : 'text-red-400'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Camera count */}
        <span className="text-xs text-gray-400">
          {cameras.filter((c) => c.status === 'live').length}/{cameras.length} live
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

      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Camera grid - main area */}
        <main className="flex-1 overflow-hidden p-2 relative">
          <CameraGrid layout={layout} />
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
                {tab}
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
                <p className="text-xs text-gray-400 leading-relaxed">
                  각 카메라 화면 우측 상단의<br />
                  <span className="text-blue-400 font-semibold">+ Zone</span> 버튼을 클릭하여<br />
                  Zone을 편집하세요.
                </p>
                {cameras.length === 0 && (
                  <p className="text-[10px] text-gray-600">카메라를 먼저 추가하세요.</p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
