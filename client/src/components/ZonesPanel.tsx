import { useEffect, useState } from 'react';
import { useCameraStore } from '../stores/cameraStore';
import { useI18n } from '../i18n';

interface Zone {
  id: string;
  name: string;
  type: 'MONITOR' | 'EXCLUDE';
  dwellThreshold?: number;
}

interface CameraZoneInfo {
  cameraId: string;
  zones: Zone[];
  loading: boolean;
}

interface Props {
  onOpenCamera: (cameraId: string) => void;
}

export default function ZonesPanel({ onOpenCamera }: Props) {
  const cameras = useCameraStore((s) => s.cameras);
  const { t } = useI18n();
  const [zoneInfos, setZoneInfos] = useState<Map<string, CameraZoneInfo>>(new Map());

  // Fetch zones for all cameras
  useEffect(() => {
    if (cameras.length === 0) return;

    cameras.forEach(async (cam) => {
      setZoneInfos((prev) => {
        const next = new Map(prev);
        if (!next.has(cam.id)) next.set(cam.id, { cameraId: cam.id, zones: [], loading: true });
        return next;
      });

      try {
        const res = await fetch(`/api/cameras/${cam.id}/zones`);
        if (res.ok) {
          const data = await res.json();
          const zones: Zone[] = Array.isArray(data) ? data : (data.data ?? data.zones ?? []);
          setZoneInfos((prev) => {
            const next = new Map(prev);
            next.set(cam.id, { cameraId: cam.id, zones, loading: false });
            return next;
          });
        }
      } catch {
        setZoneInfos((prev) => {
          const next = new Map(prev);
          next.set(cam.id, { cameraId: cam.id, zones: [], loading: false });
          return next;
        });
      }
    });
  }, [cameras]);

  const totalZones = [...zoneInfos.values()].reduce((sum, info) => sum + info.zones.length, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-shrink-0 bg-gray-800/60">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">{t.tabZones}</span>
          {totalZones > 0 && (
            <span className="text-[10px] font-bold bg-blue-700 text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {totalZones}
            </span>
          )}
        </div>
        <span className="text-[9px] text-gray-500">{cameras.length} cameras</span>
      </div>

      {/* Body */}
      {cameras.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 px-4 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
            />
          </svg>
          <span className="text-xs">{t.addCameraFirst}</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1.5 px-2 space-y-1.5">
          {cameras.map((cam) => {
            const info = zoneInfos.get(cam.id);
            const zones = info?.zones ?? [];
            const loading = info?.loading ?? true;
            const monitorZones = zones.filter((z) => z.type === 'MONITOR');
            const excludeZones = zones.filter((z) => z.type === 'EXCLUDE');
            const isLive = cam.status === 'live' || cam.status === 'streaming';

            return (
              <div key={cam.id} className="rounded bg-gray-800 border border-gray-700 overflow-hidden">
                {/* Camera row */}
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isLive ? 'bg-green-500' : 'bg-gray-600'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-semibold text-white truncate">{cam.name}</div>
                    <div className="text-[9px] text-gray-500">
                      {loading ? (
                        <span className="text-gray-600">loading…</span>
                      ) : zones.length === 0 ? (
                        <span className="text-gray-600">No zones</span>
                      ) : (
                        <span>
                          {monitorZones.length > 0 && (
                            <span className="text-blue-400">{monitorZones.length} Monitor</span>
                          )}
                          {monitorZones.length > 0 && excludeZones.length > 0 && (
                            <span className="text-gray-600"> · </span>
                          )}
                          {excludeZones.length > 0 && (
                            <span className="text-yellow-500">{excludeZones.length} Exclude</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => onOpenCamera(cam.id)}
                    className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[9px] font-bold bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                      />
                    </svg>
                    Edit
                  </button>
                </div>

                {/* Zone chips */}
                {zones.length > 0 && (
                  <div className="px-2.5 pb-2 flex flex-wrap gap-1">
                    {zones.map((z) => (
                      <span
                        key={z.id}
                        className={`text-[8px] font-bold rounded px-1.5 py-0.5 border ${
                          z.type === 'MONITOR'
                            ? 'bg-blue-900/30 text-blue-300 border-blue-700/40'
                            : 'bg-yellow-900/30 text-yellow-400 border-yellow-700/40'
                        }`}
                      >
                        {z.name}
                        {z.dwellThreshold != null && (
                          <span className="ml-0.5 text-gray-500">{z.dwellThreshold}s</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Hint */}
          <p className="text-[8px] text-gray-600 text-center pt-1 pb-2 leading-relaxed">
            Click <span className="text-blue-400">Edit</span> to open fullscreen, then click the{' '}
            <span className="text-white">Zone button</span> on the camera to draw/edit zones.
          </p>
        </div>
      )}
    </div>
  );
}
