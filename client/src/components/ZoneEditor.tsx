import React, { useRef, useEffect, useState, useCallback } from 'react';

interface Point {
  x: number;
  y: number;
}

interface Zone {
  id: string;
  name: string;
  type: 'MONITOR' | 'EXCLUDE';
  polygon: Point[];
}

interface Props {
  cameraId: string;
  frameSnapshot: string | null;
}

const ZONE_COLORS: Record<Zone['type'], { fill: string; stroke: string }> = {
  MONITOR: { fill: 'rgba(59,130,246,0.25)', stroke: 'rgba(59,130,246,0.9)' },
  EXCLUDE: { fill: 'rgba(107,114,128,0.25)', stroke: 'rgba(107,114,128,0.9)' },
};

const CLOSE_THRESHOLD = 12; // pixels to close polygon

function distance(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export default function ZoneEditor({ cameraId, frameSnapshot }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [cursorPoint, setCursorPoint] = useState<Point | null>(null);
  const [zoneName, setZoneName] = useState('Zone 1');
  const [zoneType, setZoneType] = useState<Zone['type']>('MONITOR');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  // Load existing zones from backend
  useEffect(() => {
    if (!cameraId) return;
    fetch(`/api/cameras/${cameraId}/zones`)
      .then((r) => r.json())
      .then((data: Zone[]) => setZones(Array.isArray(data) ? data : []))
      .catch(() => setZones([]));
  }, [cameraId]);

  const getCanvasPoint = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw existing zones
    for (const zone of zones) {
      if (zone.polygon.length < 3) continue;
      const colors = ZONE_COLORS[zone.type];
      ctx.beginPath();
      ctx.moveTo(zone.polygon[0].x, zone.polygon[0].y);
      for (let i = 1; i < zone.polygon.length; i++) {
        ctx.lineTo(zone.polygon[i].x, zone.polygon[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = colors.fill;
      ctx.fill();
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Zone label
      const cx = zone.polygon.reduce((s, p) => s + p.x, 0) / zone.polygon.length;
      const cy = zone.polygon.reduce((s, p) => s + p.y, 0) / zone.polygon.length;
      ctx.fillStyle = colors.stroke;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${zone.name} [${zone.type}]`, cx, cy);
    }

    // Draw current polygon being drawn
    if (currentPoints.length > 0) {
      const colors = ZONE_COLORS[zoneType];
      ctx.beginPath();
      ctx.moveTo(currentPoints[0].x, currentPoints[0].y);
      for (let i = 1; i < currentPoints.length; i++) {
        ctx.lineTo(currentPoints[i].x, currentPoints[i].y);
      }
      if (cursorPoint) {
        ctx.lineTo(cursorPoint.x, cursorPoint.y);
      }
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw vertices
      for (let i = 0; i < currentPoints.length; i++) {
        const p = currentPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? 'rgba(255,255,255,0.9)' : colors.stroke;
        ctx.fill();
        ctx.strokeStyle = colors.stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }, [zones, currentPoints, cursorPoint, zoneType]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // Set canvas size based on frame
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frameSnapshot) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth || 640;
      canvas.height = img.naturalHeight || 360;
      redraw();
    };
    img.src = `data:image/jpeg;base64,${frameSnapshot}`;
  }, [frameSnapshot, redraw]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (currentPoints.length === 0) return;
    setCursorPoint(getCanvasPoint(e));
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.detail === 2) return; // ignore double-click (handled separately)
    const pt = getCanvasPoint(e);

    // Close polygon if clicking near first point
    if (currentPoints.length >= 3) {
      const first = currentPoints[0];
      if (distance(pt, first) < CLOSE_THRESHOLD) {
        closePolygon();
        return;
      }
    }

    setCurrentPoints((prev) => [...prev, pt]);
  };

  const handleDoubleClick = () => {
    if (currentPoints.length >= 3) {
      closePolygon();
    }
  };

  const closePolygon = () => {
    const newZone: Zone = {
      id: `zone-${Date.now()}`,
      name: zoneName,
      type: zoneType,
      polygon: [...currentPoints],
    };
    setZones((prev) => [...prev, newZone]);
    setCurrentPoints([]);
    setCursorPoint(null);
  };

  const handleClear = () => {
    setCurrentPoints([]);
    setCursorPoint(null);
  };

  const handleClearAll = () => {
    if (!confirm('Clear all zones?')) return;
    setZones([]);
    setCurrentPoints([]);
    setCursorPoint(null);
  };

  const handleSave = async () => {
    if (zones.length === 0) {
      setSaveMessage('No zones to save.');
      setTimeout(() => setSaveMessage(''), 3000);
      return;
    }
    setSaving(true);
    setSaveMessage('');
    try {
      const res = await fetch(`/api/cameras/${cameraId}/zones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zones }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveMessage('Zones saved successfully!');
    } catch (err) {
      setSaveMessage('Error saving zones.');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMessage(''), 4000);
    }
  };

  const handleDeleteZone = (id: string) => {
    setZones((prev) => prev.filter((z) => z.id !== id));
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="block text-[11px] text-gray-400 mb-1">Zone Name</label>
          <input
            type="text"
            value={zoneName}
            onChange={(e) => setZoneName(e.target.value)}
            className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white w-32 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-[11px] text-gray-400 mb-1">Type</label>
          <select
            value={zoneType}
            onChange={(e) => setZoneType(e.target.value as Zone['type'])}
            className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
          >
            <option value="MONITOR">MONITOR</option>
            <option value="EXCLUDE">EXCLUDE</option>
          </select>
        </div>
        <button
          onClick={handleClear}
          disabled={currentPoints.length === 0}
          className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white transition-colors"
        >
          Clear Drawing
        </button>
        <button
          onClick={handleClearAll}
          disabled={zones.length === 0}
          className="px-3 py-1.5 text-xs rounded bg-red-900 hover:bg-red-800 disabled:opacity-40 text-white transition-colors"
        >
          Clear All Zones
        </button>
        <button
          onClick={handleSave}
          disabled={saving || zones.length === 0}
          className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white font-semibold transition-colors"
        >
          {saving ? 'Saving…' : 'Save Zones'}
        </button>
      </div>

      {saveMessage && (
        <p className={`text-xs ${saveMessage.includes('Error') ? 'text-red-400' : 'text-green-400'}`}>
          {saveMessage}
        </p>
      )}

      <p className="text-[11px] text-gray-400">
        Click to add vertices · Double-click or click first point to close polygon
      </p>

      {/* Canvas over frame */}
      <div className="relative bg-gray-900 rounded overflow-hidden border border-gray-700">
        {frameSnapshot ? (
          <img
            src={`data:image/jpeg;base64,${frameSnapshot}`}
            alt="Frame snapshot"
            className="w-full"
            draggable={false}
          />
        ) : (
          <div className="w-full aspect-video flex items-center justify-center text-gray-600 text-sm">
            No frame snapshot available
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="absolute top-0 left-0 w-full h-full cursor-crosshair"
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setCursorPoint(null)}
        />
      </div>

      {/* Zone list */}
      {zones.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-gray-400 uppercase tracking-wide">Defined Zones</p>
          {zones.map((zone) => (
            <div
              key={zone.id}
              className="flex items-center justify-between px-2 py-1 rounded bg-gray-800 text-xs"
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: ZONE_COLORS[zone.type].stroke }}
                />
                <span className="text-white font-semibold">{zone.name}</span>
                <span className="text-gray-400">{zone.type}</span>
                <span className="text-gray-500">({zone.polygon.length} pts)</span>
              </div>
              <button
                onClick={() => handleDeleteZone(zone.id)}
                className="text-gray-500 hover:text-red-400 transition-colors text-xs"
                title="Delete zone"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
