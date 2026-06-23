import { useEffect, useRef, useState } from 'react';
import { getSocket } from '../hooks/useSocket';

interface ThermalReading {
  itemId:   string | null;
  areaName: string | null;
  maxTemp:  number | null;
  maxTempX: number | null;
  maxTempY: number | null;
  minTemp:  number | null;
  minTempX: number | null;
  minTempY: number | null;
  avgTemp:  number | null;
}

interface ThermalData {
  cameraId: string;
  utcTime:  string;
  readings: ThermalReading[];
}

interface Props {
  cameraId:    string;
  frameWidth:  number;
  frameHeight: number;
}

const FADE_MS = 6000; // hide overlay if no reading for 6 s

// Same letter-box logic as CameraView drawOverlay
function getRenderArea(fw: number, fh: number, cw: number, ch: number) {
  if (!fw || !fh || !cw || !ch) return { rw: cw, rh: ch, ox: 0, oy: 0 };
  const ia = fw / fh, ca = cw / ch;
  if (ia > ca) return { rw: cw,    rh: cw / ia, ox: 0,            oy: (ch - cw / ia) / 2 };
  return            { rw: ch * ia, rh: ch,       ox: (cw - ch * ia) / 2, oy: 0 };
}

function toScreen(px: number, py: number, fw: number, fh: number, cw: number, ch: number) {
  if (!fw || !fh || !cw || !ch) return { sx: -9999, sy: -9999 };
  const { rw, rh, ox, oy } = getRenderArea(fw, fh, cw, ch);
  return { sx: ox + (px / fw) * rw, sy: oy + (py / fh) * rh };
}

/**
 * Detect unit heuristic: ONVIF Radiometry standard uses Celsius,
 * but some vendors report in Kelvin. Values > 200 are assumed Kelvin.
 */
function formatTemp(t: number | null): string {
  if (t === null) return '—';
  if (t > 200) return `${t.toFixed(1)} (${(t - 273.15).toFixed(1)}°C)`;
  return `${t.toFixed(1)}°C`;
}

function crosshairLabel(t: number | null): string {
  if (t === null) return '';
  if (t > 200) return `${(t - 273.15).toFixed(1)}°C`;
  return `${t.toFixed(1)}°C`;
}

// Approximate text width in pixels (monospace 11px ≈ 6.6px/char)
function textWidth(s: string) { return s.length * 6.6 + 6; }

// AreaName="FullArea" or ItemID="Z" → entire-frame reading, no coordinate markers
function isFullArea(r: ThermalReading): boolean {
  return r.areaName === 'FullArea' || r.itemId === 'Z';
}

export default function ThermalOverlay({ cameraId, frameWidth, frameHeight }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize]     = useState({ w: 0, h: 0 });
  const [data, setData]     = useState<ThermalData | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track container dimensions via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Subscribe to real-time temperature events
  useEffect(() => {
    const socket = getSocket();
    const handler = (d: ThermalData) => {
      if (d.cameraId !== cameraId) return;
      setData(d);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => setData(null), FADE_MS);
    };
    socket.on('onvif:temperature', handler);
    return () => {
      socket.off('onvif:temperature', handler);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [cameraId]);

  const { w, h } = size;
  const fw = frameWidth  || 0;
  const fh = frameHeight || 0;

  if (!data || data.readings.length === 0) {
    return <div ref={containerRef} className="absolute inset-0 pointer-events-none" />;
  }

  const fullAreaReadings  = data.readings.filter(isFullArea);
  const pointReadings     = data.readings.filter(r => !isFullArea(r));

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none overflow-hidden">

      {/* ── FullArea banner (top — no crosshair, covers entire frame) ── */}
      {fullAreaReadings.length > 0 && (
        <div className="absolute top-0 left-0 right-0 flex justify-center pt-1 gap-2">
          {fullAreaReadings.map((r, i) => (
            <div
              key={`fa-${i}`}
              className="bg-black/70 backdrop-blur-sm border border-orange-500/40 rounded-md px-3 py-1 text-[11px] font-mono leading-tight"
            >
              <div className="flex items-center gap-2">
                <span className="text-orange-300 font-semibold">🌡 {r.areaName || r.itemId || 'Full'}</span>
                {r.maxTemp !== null && (
                  <span className="flex items-center gap-0.5">
                    <span className="text-red-400 font-bold">▲</span>
                    <span className="text-red-300">{formatTemp(r.maxTemp)}</span>
                  </span>
                )}
                {r.minTemp !== null && (
                  <span className="flex items-center gap-0.5">
                    <span className="text-sky-400 font-bold">▼</span>
                    <span className="text-sky-300">{formatTemp(r.minTemp)}</span>
                  </span>
                )}
                {r.avgTemp !== null && (
                  <span className="flex items-center gap-0.5">
                    <span className="text-gray-400">~</span>
                    <span className="text-gray-200">{formatTemp(r.avgTemp)}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Coordinate-based readings: SVG crosshairs + bottom-left panel ── */}
      {pointReadings.length > 0 && (
        <>
          <svg
            className="absolute inset-0"
            style={{ width: w || '100%', height: h || '100%' }}
            overflow="visible"
          >
            {pointReadings.map((r, i) => {
              const markers: React.ReactNode[] = [];

              // Max temperature marker (red)
              if (r.maxTemp !== null && r.maxTempX !== null && r.maxTempY !== null) {
                const { sx, sy } = toScreen(r.maxTempX, r.maxTempY, fw, fh, w, h);
                const lbl = crosshairLabel(r.maxTemp);
                const lw  = textWidth(lbl);
                const lx  = sx + 14 + lw < w ? sx + 14 : sx - lw - 6;
                markers.push(
                  <g key={`tmax-${i}`}>
                    <line x1={sx - 12} y1={sy} x2={sx + 12} y2={sy} stroke="#ef4444" strokeWidth={1.5} />
                    <line x1={sx} y1={sy - 12} x2={sx} y2={sy + 12} stroke="#ef4444" strokeWidth={1.5} />
                    <circle cx={sx} cy={sy} r={3.5} fill="none" stroke="#ef4444" strokeWidth={1.5} />
                    {lbl && (
                      <>
                        <rect x={lx - 2} y={sy - 9} width={lw} height={16} rx={3} fill="rgba(0,0,0,0.72)" />
                        <text x={lx} y={sy + 3} fill="#ef4444" fontSize={11} fontFamily="monospace" fontWeight="bold">{lbl}</text>
                      </>
                    )}
                  </g>
                );
              }

              // Min temperature marker (sky-blue)
              if (r.minTemp !== null && r.minTempX !== null && r.minTempY !== null) {
                const { sx, sy } = toScreen(r.minTempX, r.minTempY, fw, fh, w, h);
                const lbl = crosshairLabel(r.minTemp);
                const lw  = textWidth(lbl);
                const lx  = sx + 14 + lw < w ? sx + 14 : sx - lw - 6;
                markers.push(
                  <g key={`tmin-${i}`}>
                    <line x1={sx - 12} y1={sy} x2={sx + 12} y2={sy} stroke="#38bdf8" strokeWidth={1.5} />
                    <line x1={sx} y1={sy - 12} x2={sx} y2={sy + 12} stroke="#38bdf8" strokeWidth={1.5} />
                    <circle cx={sx} cy={sy} r={3.5} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
                    {lbl && (
                      <>
                        <rect x={lx - 2} y={sy - 9} width={lw} height={16} rx={3} fill="rgba(0,0,0,0.72)" />
                        <text x={lx} y={sy + 3} fill="#38bdf8" fontSize={11} fontFamily="monospace" fontWeight="bold">{lbl}</text>
                      </>
                    )}
                  </g>
                );
              }

              return markers;
            })}
          </svg>

          {/* Bottom-left info panel for coordinate-based readings */}
          <div className="absolute bottom-8 left-2 flex flex-col gap-1">
            {pointReadings.map((r, i) => (
              <div
                key={i}
                className="bg-black/75 rounded-md px-2.5 py-1.5 backdrop-blur-sm border border-white/10 text-[11px] font-mono leading-tight"
              >
                <div className="flex items-center gap-1 text-orange-300 font-semibold mb-1">
                  <span>🌡</span>
                  <span>{r.areaName || r.itemId || `Area ${i + 1}`}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {r.maxTemp !== null && (
                    <span className="flex items-center gap-1">
                      <span className="text-red-400 font-bold">▲</span>
                      <span className="text-red-300">{formatTemp(r.maxTemp)}</span>
                    </span>
                  )}
                  {r.minTemp !== null && (
                    <span className="flex items-center gap-1">
                      <span className="text-sky-400 font-bold">▼</span>
                      <span className="text-sky-300">{formatTemp(r.minTemp)}</span>
                    </span>
                  )}
                  {r.avgTemp !== null && (
                    <span className="flex items-center gap-1">
                      <span className="text-gray-400">~</span>
                      <span className="text-gray-200">{formatTemp(r.avgTemp)}</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
