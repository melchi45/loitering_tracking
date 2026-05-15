import { useState } from 'react';
import { useCameraStore } from '../stores/cameraStore';
import type { DiscoveredCamera } from '../types';

function Row({ label, value }: { label: string; value?: string | number | boolean | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex items-start gap-2 py-1 border-b border-gray-700/50">
      <span className="text-[11px] text-gray-500 w-24 flex-shrink-0">{label}</span>
      <span className="text-[11px] text-gray-200 break-all">{String(value)}</span>
    </div>
  );
}

function Badge({ ok }: { ok: boolean }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${ok ? 'bg-green-800 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
      {ok ? 'Yes' : 'No'}
    </span>
  );
}

interface Props {
  camera: DiscoveredCamera;
  onClose: () => void;
}

export default function DiscoveredCameraPanel({ camera, onClose }: Props) {
  const addCamera = useCameraStore((s) => s.addCamera);
  const [adding, setAdding] = useState(false);
  const [added, setAdded]   = useState(false);
  const [error, setError]   = useState('');

  const scheme  = camera.HttpType ? 'https' : 'http';
  const webPort = camera.HttpType ? camera.HttpsPort : camera.HttpPort;
  const rtspUrl = camera.rtspUrl || `rtsp://${camera.IPAddress}:${camera.Port || 554}/profile1/media.smp`;

  const handleAdd = async () => {
    setAdding(true);
    setError('');
    try {
      const port = camera.HttpType ? camera.HttpsPort : camera.HttpPort;
      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:     camera.Model || camera.IPAddress,
          rtspUrl,
          ip:       camera.IPAddress,
          mac:      camera.MACAddress,
          httpPort: port,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const result = await res.json();
      if (result.success && result.data) addCamera(result.data);
      setAdded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add camera');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="absolute right-0 top-0 h-full w-80 bg-gray-800 border-l border-gray-600 flex flex-col z-20 shadow-2xl">
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3 border-b border-gray-700 bg-gray-750 flex-shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-bold text-white truncate">
            {camera.Model || 'Unknown Device'}
          </div>
          <div className="text-[11px] text-blue-400 font-mono mt-0.5">{camera.IPAddress}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-gray-500">SUNAPI</span>
            <Badge ok={!!camera.SupportSunapi} />
            {camera.Type !== undefined && (
              <span className="text-[10px] text-gray-500">Type {camera.Type}</span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white text-xl leading-none flex-shrink-0 ml-2 mt-0.5"
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Details */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Network
        </div>
        <Row label="MAC"        value={camera.MACAddress} />
        <Row label="IP Address" value={camera.IPAddress} />
        <Row label="Gateway"    value={camera.Gateway} />
        <Row label="Subnet"     value={camera.SubnetMask} />

        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-4 mb-2">
          Ports
        </div>
        <Row label="HTTP Port"  value={camera.HttpPort} />
        <Row label="HTTPS Port" value={camera.HttpsPort} />
        <Row label="RTSP Port"  value={camera.Port} />

        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mt-4 mb-2">
          URLs
        </div>
        <div className="py-1 border-b border-gray-700/50">
          <div className="text-[10px] text-gray-500 mb-0.5">Web</div>
          <a
            href={`${scheme}://${camera.IPAddress}:${webPort}`}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-blue-400 hover:text-blue-300 break-all"
          >
            {scheme}://{camera.IPAddress}:{webPort}
          </a>
        </div>
        <div className="py-1 border-b border-gray-700/50">
          <div className="text-[10px] text-gray-500 mb-0.5">RTSP</div>
          <span className="text-[11px] text-green-400 break-all font-mono">{rtspUrl}</span>
        </div>
        {camera.URL && (
          <div className="py-1 border-b border-gray-700/50">
            <div className="text-[10px] text-gray-500 mb-0.5">DDNS</div>
            <span className="text-[11px] text-gray-300 break-all">{camera.URL}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 border-t border-gray-700 flex-shrink-0 space-y-2">
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {added ? (
          <div className="text-center text-xs text-green-400 font-semibold py-1">
            ✓ Added to camera list
          </div>
        ) : (
          <button
            onClick={handleAdd}
            disabled={adding}
            className="w-full py-2 text-xs font-semibold rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white transition-colors"
          >
            {adding ? 'Adding…' : '+ Add to System'}
          </button>
        )}
      </div>
    </div>
  );
}
