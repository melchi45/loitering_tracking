import { useState, useEffect, useCallback } from 'react';
import { useSocket } from './hooks/useSocket';
import { useCameraStore } from './stores/cameraStore';
import { useAlertStore } from './stores/alertStore';
import CameraGrid from './components/CameraGrid';
import CameraList from './components/CameraList';
import AlertPanel from './components/AlertPanel';
import ZoneEditor from './components/ZoneEditor';
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
  const [zoneEditorCameraId, setZoneEditorCameraId] = useState<string | null>(null);
  const [zoneEditorSnapshot, setZoneEditorSnapshot] = useState<string | null>(null);

  const { socket, connected } = useSocket();
  const updateCameraStatus = useCameraStore((s) => s.updateCameraStatus);
  const setCameras = useCameraStore((s) => s.setCameras);
  const cameras = useCameraStore((s) => s.cameras);
  const addAlert = useAlertStore((s) => s.addAlert);
  const unreadAlerts = useAlertStore((s) => s.alerts.filter((a) => !a.acknowledged).length);

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

  const handleOpenZoneEditor = useCallback(
    (cameraId: string, snapshot: string | null) => {
      setZoneEditorCameraId(cameraId);
      setZoneEditorSnapshot(snapshot);
      setSidebarTab('zones');
    },
    []
  );

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

        {/* Zone editor shortcut */}
        {cameras.length > 0 && (
          <button
            onClick={() => handleOpenZoneEditor(cameras[0].id, null)}
            className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
            title="Open zone editor for first camera"
          >
            Zones
          </button>
        )}
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Camera grid - main area */}
        <main className="flex-1 overflow-hidden p-2">
          <CameraGrid layout={layout} />
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
              <div className="h-full overflow-y-auto p-3">
                {zoneEditorCameraId ? (
                  <>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xs text-gray-400">Camera:</span>
                      <select
                        value={zoneEditorCameraId}
                        onChange={(e) => {
                          setZoneEditorCameraId(e.target.value);
                          setZoneEditorSnapshot(null);
                        }}
                        className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none"
                      >
                        {cameras.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <ZoneEditor
                      cameraId={zoneEditorCameraId}
                      frameSnapshot={zoneEditorSnapshot}
                    />
                  </>
                ) : cameras.length > 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                    <p className="text-xs text-gray-400">
                      Select a camera to edit detection zones
                    </p>
                    <select
                      onChange={(e) => setZoneEditorCameraId(e.target.value)}
                      defaultValue=""
                      className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none"
                    >
                      <option value="" disabled>
                        -- Select Camera --
                      </option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 text-center mt-8">
                    Add a camera first to configure zones.
                  </p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
