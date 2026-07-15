import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { Zone } from '../types';

interface Point { x: number; y: number; }

interface Props {
  cameraId:      string;
  frame?:        string | null;
  frameWidth:    number;
  frameHeight:   number;
  zones:         Zone[];
  onZoneAdded:   (zone: Zone) => void;
  onZoneUpdated: (zone: Zone) => void;
  onZoneDeleted: (zoneId: string) => void;
  onClose:       () => void;
}

const ZONE_COLORS: Record<string, { stroke: string; fill: string; selFill: string }> = {
  MONITOR: { stroke: '#3b82f6', fill: 'rgba(59,130,246,0.15)', selFill: 'rgba(59,130,246,0.32)' },
  EXCLUDE: { stroke: '#f59e0b', fill: 'rgba(245,158,11,0.15)', selFill: 'rgba(245,158,11,0.32)' },
};


const VERTEX_R   = 6;
// Hit test radius in canvas CSS pixels — converted to frame coords inside hitVertex
const VERTEX_HIT_PX = 14;
const PANEL_W    = 256;

function getRenderArea(fw: number, fh: number, cw: number, ch: number) {
  const ia = fw / fh, ca = cw / ch;
  if (ia > ca) return { rw: cw, rh: cw / ia, ox: 0, oy: (ch - cw / ia) / 2 };
  return { rw: ch * ia, rh: ch, ox: (cw - ch * ia) / 2, oy: 0 };
}

function pointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export default function ZoneEditor({
  cameraId, frame, frameWidth, frameHeight, zones,
  onZoneAdded, onZoneUpdated, onZoneDeleted, onClose,
}: Props) {
  const { t } = useI18n();
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const bgFrame  = useRef(frame ?? null);
  const bgImgRef = useRef<HTMLImageElement>(null);

  // Effective frame dimensions — start from props, get updated to the
  // background image's natural size once the JPEG loads.  This guarantees
  // getRA() agrees with how <img object-contain> positions the video.
  const [fwEff, setFwEff] = useState(frameWidth  || 640);
  const [fhEff, setFhEff] = useState(frameHeight || 640);

  const handleBgLoad = useCallback(() => {
    const img = bgImgRef.current;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setFwEff(img.naturalWidth);
      setFhEff(img.naturalHeight);
    }
  }, []);

  // ── Rendering state ──────────────────────────────────────────────────────
  const [mode,       setMode]       = useState<'idle' | 'draw'>('idle');
  const [drawPoints, setDrawPoints] = useState<Point[]>([]);
  const [zoneName,   setZoneName]   = useState('Zone 1');
  const [zoneType,   setZoneType]   = useState<'MONITOR' | 'EXCLUDE'>('MONITOR');
  const [dwellThreshold,  setDwellThreshold]  = useState(30);
  const [minDisplacement, setMinDisplacement] = useState(50);
  const [minRiskScore,    setMinRiskScore]    = useState(0.0);

  const [selectedZoneId,  setSelectedZoneId]  = useState<string | null>(null);
  const [editPolygon,     setEditPolygon]     = useState<Point[] | null>(null);
  const [activeVertexIdx, setActiveVertexIdx] = useState<number | null>(null);
  const [contextMenu,     setContextMenu]     = useState<{ x: number; y: number } | null>(null);
  const [ctxVertexIdx,    setCtxVertexIdx]    = useState<number | null>(null);
  const [editName,        setEditName]        = useState('');

  // Settings for the SELECTED (existing) zone — loaded when zone is selected
  const [editZoneType,   setEditZoneType]   = useState<'MONITOR' | 'EXCLUDE'>('MONITOR');
  const [editDwell,      setEditDwell]      = useState(30);
  const [editDisp,       setEditDisp]       = useState(50);
  const [editRisk,       setEditRisk]       = useState(0.0);

  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  // ── Refs — always current, read from event handlers ──────────────────────
  const selIdRef        = useRef<string | null>(null);
  const editPolyRef     = useRef<Point[] | null>(null);
  const activeVIdxRef   = useRef<number | null>(null);
  const ctxMenuRef      = useRef<{ x: number; y: number } | null>(null);
  const modeRef         = useRef<'idle' | 'draw'>('idle');
  const zonesRef        = useRef<Zone[]>(zones);
  const editNameRef     = useRef('');
  const dragging        = useRef<{ vertexIdx: number } | null>(null);
  const ctxVertexIdxRef = useRef<number | null>(null);

  selIdRef.current        = selectedZoneId;
  editPolyRef.current     = editPolygon;
  activeVIdxRef.current   = activeVertexIdx;
  ctxMenuRef.current      = contextMenu;
  modeRef.current         = mode;
  zonesRef.current        = zones;
  editNameRef.current     = editName;
  ctxVertexIdxRef.current = ctxVertexIdx;

  // ── Canvas resize ────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = container.clientWidth;
      canvas.height = container.clientHeight;
    });
    ro.observe(container);
    canvas.width  = container.clientWidth;
    canvas.height = container.clientHeight;
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedZoneId) { setEditName(''); return; }
    const z = zones.find(z => z.id === selectedZoneId);
    if (z) {
      setEditName(z.name);
      editNameRef.current = z.name;
    }
  }, [selectedZoneId, zones]);

  // ── Coordinate helpers ───────────────────────────────────────────────────

  // Returns render area within the canvas, excluding the right panel.
  // Uses c.clientWidth (CSS pixels) to match clientX/clientY coordinate space.
  // Uses fwEff/fhEff — the actual JPEG dimensions read from the background image.
  const getRA = useCallback(() => {
    const c = canvasRef.current!;
    const cw = c.clientWidth  || c.width;
    const ch = c.clientHeight || c.height;
    return getRenderArea(fwEff, fhEff, cw - PANEL_W, ch);
  }, [fwEff, fhEff]);

  const frameToCanvas = useCallback((fx: number, fy: number): Point => {
    const { rw, rh, ox, oy } = getRA();
    return { x: ox + fx * (rw / fwEff), y: oy + fy * (rh / fhEff) };
  }, [getRA, fwEff, fhEff]);

  // Convert client (mouse) coords → frame coords, clamped to frame bounds.
  const clientToFrame = useCallback((cx: number, cy: number): Point => {
    const canvas = canvasRef.current!;
    const rect   = canvas.getBoundingClientRect();
    const { rw, rh, ox, oy } = getRA();
    return {
      x: Math.max(0, Math.min(fwEff, Math.round((cx - rect.left - ox) * (fwEff / rw)))),
      y: Math.max(0, Math.min(fhEff, Math.round((cy - rect.top  - oy) * (fhEff / rh)))),
    };
  }, [getRA, fwEff, fhEff]);

  // ── Hit testing — all in frame coordinate space ──────────────────────────
  //
  // Using frame coords instead of canvas pixels avoids any mismatch between
  // getBoundingClientRect() and canvas .width/.height attribute scaling.

  const hitVertex = useCallback((fp: Point, poly: Point[]): number | null => {
    const { rw, rh } = getRA();
    // Convert the screen-pixel hit radius to frame units
    const hrx = VERTEX_HIT_PX * (fwEff / rw);
    const hry = VERTEX_HIT_PX * (fhEff / rh);
    for (let i = 0; i < poly.length; i++) {
      const dx = fp.x - poly[i].x;
      const dy = fp.y - poly[i].y;
      if ((dx / hrx) ** 2 + (dy / hry) ** 2 <= 1) return i;
    }
    return null;
  }, [getRA, fwEff, fhEff]);

  const hitZone = useCallback((fp: Point, selId: string | null, editPoly: Point[] | null): Zone | null => {
    const zs = zonesRef.current;
    for (let i = zs.length - 1; i >= 0; i--) {
      const z    = zs[i];
      const poly = (z.id === selId && editPoly) ? editPoly : z.polygon;
      if (poly.length >= 3 && pointInPolygon(fp, poly)) return z;
    }
    return null;
  }, []);

  // ── Selection ────────────────────────────────────────────────────────────

  const selectZone = useCallback((z: Zone) => {
    const poly = [...z.polygon];
    selIdRef.current      = z.id;
    editPolyRef.current   = poly;
    activeVIdxRef.current = null;
    setSelectedZoneId(z.id);
    setEditPolygon(poly);
    setActiveVertexIdx(null);
    setEditName(z.name);
    editNameRef.current = z.name;
    // Load current zone settings into edit state
    setEditZoneType(z.type);
    setEditDwell(z.dwellThreshold  ?? 30);
    setEditDisp(z.minDisplacement  ?? 50);
    setEditRisk(z.minRiskScore     ?? 0.0);
  }, []);

  const clearSelection = useCallback(() => {
    selIdRef.current      = null;
    editPolyRef.current   = null;
    activeVIdxRef.current = null;
    setSelectedZoneId(null);
    setEditPolygon(null);
    setActiveVertexIdx(null);
  }, []);

  // ── Global drag listeners — work even when cursor leaves canvas ──────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current === null) return;
      const editPoly = editPolyRef.current;
      if (!editPoly) return;
      const fp = clientToFrame(e.clientX, e.clientY);
      const vi = dragging.current.vertexIdx;
      const next = editPoly.map((p, i) => (i === vi ? fp : p));
      editPolyRef.current = next;
      setEditPolygon(next);
    };
    const onUp = () => {
      if (dragging.current !== null) {
        dragging.current      = null;
        activeVIdxRef.current = null;
        setActiveVertexIdx(null);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
  }, [clientToFrame]);

  // ── Redraw ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const zone of zones) {
      const isSel = zone.id === selectedZoneId;
      const poly  = (isSel && editPolygon) ? editPolygon : zone.polygon;
      if (poly.length < 2) continue;
      const c = ZONE_COLORS[zone.type] || ZONE_COLORS.MONITOR;

      ctx.beginPath();
      poly.forEach((p, i) => {
        const cp = frameToCanvas(p.x, p.y);
        i === 0 ? ctx.moveTo(cp.x, cp.y) : ctx.lineTo(cp.x, cp.y);
      });
      ctx.closePath();
      ctx.fillStyle   = isSel ? c.selFill : c.fill;
      ctx.strokeStyle = c.stroke;
      ctx.lineWidth   = isSel ? 3 : 1.5;
      ctx.fill();
      ctx.stroke();

      const ax = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const ay = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      const lp = frameToCanvas(ax, ay);
      ctx.font = 'bold 12px sans-serif';
      const tw = ctx.measureText(zone.name).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(lp.x - tw / 2, lp.y - 10, tw, 18);
      ctx.fillStyle = c.stroke;
      ctx.textAlign = 'center';
      ctx.fillText(zone.name, lp.x, lp.y + 3);
      ctx.textAlign = 'left';

      if (isSel) {
        poly.forEach((p, i) => {
          const vp       = frameToCanvas(p.x, p.y);
          const isActive = i === activeVertexIdx;
          ctx.beginPath();
          ctx.arc(vp.x, vp.y, isActive ? VERTEX_R + 4 : VERTEX_R, 0, Math.PI * 2);
          ctx.fillStyle   = isActive ? '#fff'   : c.stroke;
          ctx.strokeStyle = isActive ? c.stroke : '#fff';
          ctx.lineWidth   = 2;
          ctx.fill();
          ctx.stroke();
          ctx.font      = `bold ${isActive ? 11 : 9}px monospace`;
          ctx.fillStyle = isActive ? c.stroke : '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(String(i + 1), vp.x, vp.y + 3.5);
          ctx.textAlign = 'left';
        });

        ctx.font = 'bold 11px sans-serif';
        if (activeVertexIdx !== null) {
          ctx.fillStyle = 'rgba(255,245,150,0.95)';
          ctx.fillText(`Vertex ${activeVertexIdx + 1} — ${t.zoneDrawVertexHint}`, 12, 24);
        } else {
          ctx.fillStyle = 'rgba(180,200,255,0.88)';
          ctx.fillText(t.zoneVertexHint, 12, 24);
        }
      }
    }

    if (mode === 'draw' && drawPoints.length > 0) {
      const c = ZONE_COLORS[zoneType];
      ctx.beginPath();
      drawPoints.forEach((p, i) => {
        const cp = frameToCanvas(p.x, p.y);
        i === 0 ? ctx.moveTo(cp.x, cp.y) : ctx.lineTo(cp.x, cp.y);
      });
      ctx.strokeStyle = c.stroke;
      ctx.lineWidth   = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      drawPoints.forEach((p) => {
        const cp = frameToCanvas(p.x, p.y);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
        ctx.fillStyle   = c.stroke;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 1.5;
        ctx.fill();
        ctx.stroke();
      });
      if (drawPoints.length >= 3) {
        const fp0 = frameToCanvas(drawPoints[0].x, drawPoints[0].y);
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.font      = '11px sans-serif';
        ctx.fillText(t.zoneDrawHint, fp0.x + 10, fp0.y - 8);
      }
    }
  }, [drawPoints, zones, zoneType, mode, selectedZoneId, editPolygon, activeVertexIdx, frameToCanvas, t]);

  // ── Mouse events ─────────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (modeRef.current !== 'idle') return;
    const editPoly = editPolyRef.current;
    const selId    = selIdRef.current;
    if (!selId || !editPoly) return;

    const fp = clientToFrame(e.clientX, e.clientY);
    const vi = hitVertex(fp, editPoly);
    if (vi !== null) {
      dragging.current      = { vertexIdx: vi };
      activeVIdxRef.current = vi;
      setActiveVertexIdx(vi);
      e.preventDefault();
    }
  }, [clientToFrame, hitVertex]);

  // Cursor feedback only — drag itself is handled by global document listener
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (dragging.current !== null) { canvas.style.cursor = 'grabbing'; return; }
    if (modeRef.current === 'draw') { canvas.style.cursor = 'crosshair'; return; }

    const fp       = clientToFrame(e.clientX, e.clientY);
    const editPoly = editPolyRef.current;

    if (activeVIdxRef.current !== null) { canvas.style.cursor = 'crosshair'; return; }
    if (editPoly) {
      canvas.style.cursor = hitVertex(fp, editPoly) !== null ? 'grab' : 'default';
      return;
    }
    canvas.style.cursor = hitZone(fp, selIdRef.current, editPolyRef.current) ? 'pointer' : 'default';
  }, [clientToFrame, hitVertex, hitZone]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (ctxMenuRef.current) { setContextMenu(null); return; }

    const editPoly   = editPolyRef.current;
    const selId      = selIdRef.current;
    const activeVIdx = activeVIdxRef.current;
    const fp         = clientToFrame(e.clientX, e.clientY);

    if (modeRef.current === 'draw') {
      setDrawPoints(prev => [...prev, fp]);
      return;
    }

    if (selId && editPoly && activeVIdx !== null) {
      const vi = hitVertex(fp, editPoly);
      if (vi !== null) {
        const next = vi === activeVIdx ? null : vi;
        activeVIdxRef.current = next;
        setActiveVertexIdx(next);
      } else {
        const next = editPoly.map((p, i) => (i === activeVIdx ? fp : p));
        editPolyRef.current   = next;
        activeVIdxRef.current = null;
        setEditPolygon(next);
        setActiveVertexIdx(null);
      }
      return;
    }

    if (selId && editPoly) {
      const vi = hitVertex(fp, editPoly);
      if (vi !== null) {
        activeVIdxRef.current = vi;
        setActiveVertexIdx(vi);
        return;
      }
    }

    const hz = hitZone(fp, selId, editPoly);
    if (hz) {
      if (hz.id !== selId) selectZone(hz);
      return;
    }

    clearSelection();
  }, [clientToFrame, hitVertex, hitZone, selectZone, clearSelection]);

  const handleDblClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (modeRef.current !== 'draw') return;
    setDrawPoints(prev => (prev.length >= 3 ? prev.slice(0, -1) : prev));
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();

    const selId = selIdRef.current;

    if (!selId) {
      const fp = clientToFrame(e.clientX, e.clientY);
      const hz = hitZone(fp, null, null);
      if (!hz) return;
      selectZone(hz);
      // selectZone updates editPolyRef.current synchronously — fall through
    }

    // Detect if cursor is on a specific vertex (frame-coord hit test)
    const poly = editPolyRef.current;
    let vi: number | null = null;
    if (poly) {
      const fp = clientToFrame(e.clientX, e.clientY);
      vi = hitVertex(fp, poly);
    }

    ctxVertexIdxRef.current = vi;
    setCtxVertexIdx(vi);

    const rect = containerRef.current!.getBoundingClientRect();
    const menu = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    ctxMenuRef.current = menu;
    setContextMenu(menu);
  }, [clientToFrame, hitVertex, hitZone, selectZone]);

  // ── API ──────────────────────────────────────────────────────────────────

  const apiPut = async (zoneId: string, body: object): Promise<Zone | null> => {
    const res = await fetch(`/api/cameras/${cameraId}/zones/${zoneId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text() || 'Update failed');
    const { data } = await res.json();
    return data as Zone;
  };

  const handleSaveNew = async () => {
    if (drawPoints.length < 3) { setError(t.zoneVertexDeleteMin); return; }
    if (!zoneName.trim())       { setError(t.zoneEnterName); return; }
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/cameras/${cameraId}/zones`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: zoneName, type: zoneType, polygon: drawPoints, dwellThreshold, minDisplacement, minRiskScore }),
      });
      if (!res.ok) throw new Error(await res.text() || 'Save failed');
      const { data } = await res.json();
      onZoneAdded(data);
      setDrawPoints([]);
      setZoneName(`Zone ${zones.length + 2}`);
      setMode('idle');
      modeRef.current = 'idle';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally { setSaving(false); }
  };

  const handleSavePolygon = async () => {
    const selId    = selIdRef.current;
    const editPoly = editPolyRef.current;
    if (!selId || !editPoly) return;
    setSaving(true); setError('');
    try {
      const data = await apiPut(selId, { polygon: editPoly });
      if (data) { onZoneUpdated(data); }
      activeVIdxRef.current = null; setActiveVertexIdx(null);
      ctxMenuRef.current    = null; setContextMenu(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally { setSaving(false); }
  };

  const handleSaveZone = async () => {
    const selId    = selIdRef.current;
    const editPoly = editPolyRef.current;
    if (!selId) return;
    setSaving(true); setError('');
    try {
      const body: Record<string, unknown> = {
        name:            editNameRef.current.trim() || undefined,
        type:            editZoneType,
        dwellThreshold:  editDwell,
        minDisplacement: editDisp,
        minRiskScore:    editRisk,
      };
      if (editPoly) body.polygon = editPoly;
      const data = await apiPut(selId, body);
      if (data) {
        onZoneUpdated(data);
        activeVIdxRef.current = null; setActiveVertexIdx(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDeleteZone = async (zoneId: string) => {
    try {
      const res = await fetch(`/api/cameras/${cameraId}/zones/${zoneId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      onZoneDeleted(zoneId);
      if (selIdRef.current === zoneId) clearSelection();
      ctxMenuRef.current = null; setContextMenu(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // Remove vertex at ctxVertexIdx, connect neighbours directly, auto-save.
  const handleDeleteVertex = async () => {
    const selId    = selIdRef.current;
    const editPoly = editPolyRef.current;
    const vi       = ctxVertexIdxRef.current;
    if (!selId || !editPoly || vi === null) return;
    if (editPoly.length <= 3) {
      setError(t.zoneVertexDeleteMin);
      ctxMenuRef.current = null; setContextMenu(null);
      return;
    }
    const newPoly = editPoly.filter((_, i) => i !== vi);
    editPolyRef.current     = newPoly;
    activeVIdxRef.current   = null;
    ctxVertexIdxRef.current = null;
    setEditPolygon(newPoly);
    setActiveVertexIdx(null);
    setCtxVertexIdx(null);
    ctxMenuRef.current = null; setContextMenu(null);
    setSaving(true); setError('');
    try {
      const data = await apiPut(selId, { polygon: newPoly });
      if (data) onZoneUpdated(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vertex delete failed');
      editPolyRef.current = editPoly;
      setEditPolygon(editPoly);
    } finally { setSaving(false); }
  };

  const selectedZone = zones.find(z => z.id === selectedZoneId);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="fixed inset-0 z-[100] bg-black/75">

      {bgFrame.current && (
        <img
          ref={bgImgRef}
          src={`data:image/jpeg;base64,${bgFrame.current}`}
          className="absolute inset-y-0 left-0 object-contain pointer-events-none select-none"
          style={{ width: `calc(100% - ${PANEL_W}px)`, height: '100%' }}
          draggable={false}
          alt=""
          onLoad={handleBgLoad}
        />
      )}

      {/* Canvas covers full viewport; PANEL_W is excluded inside getRA() */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
      />

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="absolute z-[110] bg-gray-800 border border-gray-600 rounded shadow-xl py-1 min-w-[192px] text-xs"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="px-3 py-1 text-[10px] text-gray-400 border-b border-gray-700 mb-0.5 font-semibold truncate">
            {selectedZone?.name ?? 'Zone'}
            {ctxVertexIdx !== null && (
              <span className="text-yellow-400 ml-1">— Vertex {ctxVertexIdx + 1}</span>
            )}
          </div>

          {/* Vertex delete — only visible when right-click landed on a vertex */}
          {ctxVertexIdx !== null && (
            <button
              onClick={handleDeleteVertex}
              disabled={saving || (editPolygon?.length ?? 0) <= 3}
              title={(editPolygon?.length ?? 0) <= 3 ? t.zoneVertexDeleteMin : `Delete Vertex ${ctxVertexIdx + 1}`}
              className="w-full text-left px-3 py-1.5 text-orange-400 hover:bg-orange-900/50 disabled:opacity-40 transition-colors"
            >
              Delete Vertex {ctxVertexIdx + 1}
            </button>
          )}

          <button
            onClick={handleSavePolygon}
            disabled={saving}
            className="w-full text-left px-3 py-1.5 text-blue-300 hover:bg-blue-800/60 disabled:opacity-40 transition-colors"
          >
            {saving ? t.zoneSaveVertexing : t.zoneSaveVertex}
          </button>
          <button
            onClick={() => selectedZoneId && handleDeleteZone(selectedZoneId)}
            className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-red-900/50 transition-colors"
          >
            {t.zoneDeleteZone}
          </button>
          <div className="border-t border-gray-700 my-0.5" />
          <button
            onClick={() => { ctxMenuRef.current = null; setContextMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-gray-400 hover:bg-gray-700 transition-colors"
          >
            {t.zoneCancel}
          </button>
        </div>
      )}

      {/* ── Control panel (right edge) ─────────────────────────────────────── */}
      <div className="absolute top-0 right-0 h-full w-64 bg-gray-900/95 border-l border-gray-700 flex flex-col text-xs z-[105]">

        <div className="flex items-center justify-between px-3 py-2.5 bg-gray-800 border-b border-gray-700 flex-shrink-0">
          <span className="font-bold text-sm text-white">{t.zoneEdit}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none px-1" title={t.zoneCancel}>×</button>
        </div>

        <div className="flex border-b border-gray-700 flex-shrink-0">
          <button
            onClick={() => { setMode('idle'); modeRef.current = 'idle'; setDrawPoints([]); setError(''); }}
            className={`flex-1 py-2 text-[10px] font-bold transition-colors ${mode === 'idle' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Select / Edit
          </button>
          <button
            onClick={() => { setMode('draw'); modeRef.current = 'draw'; clearSelection(); ctxMenuRef.current = null; setContextMenu(null); setError(''); }}
            className={`flex-1 py-2 text-[10px] font-bold transition-colors ${mode === 'draw' ? 'bg-blue-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            {t.zoneAdd}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">

          {mode === 'idle' && (
            <>
              {/* Saved Zones list — always shown at top */}
              {zones.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wide mb-1">Saved Zones ({zones.length})</p>
                  {zones.map((z) => (
                    <div
                      key={z.id}
                      onClick={() => { ctxMenuRef.current = null; setContextMenu(null); selectZone(z); }}
                      className={`flex items-center gap-1.5 rounded px-2 py-1 cursor-pointer transition-colors ${z.id === selectedZoneId ? 'bg-blue-900/40 border border-blue-600/40' : 'bg-gray-800 hover:bg-gray-700'}`}
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${z.type === 'MONITOR' ? 'bg-blue-500' : 'bg-yellow-500'}`} />
                      <span className="flex-1 truncate text-white text-[10px]">{z.name}</span>
                      <span className="text-[9px] text-gray-500 flex-shrink-0">
                        {z.type === 'MONITOR' ? `${z.dwellThreshold ?? 30}${t.zoneSeconds}` : t.zoneTypeExclude}
                        {z.targetClasses && z.targetClasses.length > 0 && (
                          <span className="ml-1 text-blue-500">{z.targetClasses.map(c => c[0].toUpperCase()).join('')}</span>
                        )}
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteZone(z.id); }} className="text-gray-600 hover:text-red-400 flex-shrink-0 ml-0.5"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-3">
                  <p className="text-[10px] text-gray-600">No zones — use + Zone tab to add one</p>
                </div>
              )}

              {/* Selected zone edit form — directly below list */}
              {selectedZone ? (
                <div className="space-y-2.5 border-t border-gray-700 pt-2.5">

                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1 font-semibold uppercase tracking-wide">{t.zoneName}</label>
                    <input
                      value={editName}
                      onChange={(e) => { setEditName(e.target.value); editNameRef.current = e.target.value; }}
                      className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                      placeholder={t.zoneName}
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1 font-semibold uppercase tracking-wide">{t.zoneType}</label>
                    <div className="flex gap-1">
                      {(['MONITOR', 'EXCLUDE'] as const).map((typ) => (
                        <button key={typ} onClick={() => setEditZoneType(typ)}
                          className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors ${editZoneType === typ ? (typ === 'MONITOR' ? 'bg-blue-700 text-white' : 'bg-yellow-700 text-white') : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
                        >
                          {typ === 'MONITOR' ? t.zoneTypeMonitor : t.zoneTypeExclude}
                        </button>
                      ))}
                    </div>
                  </div>

                  {editZoneType === 'MONITOR' && (
                    <>
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1">{t.zoneDwellLabel}&nbsp;<span className="text-white font-semibold">{editDwell}{t.zoneSeconds}</span></label>
                        <input type="range" min={5} max={300} value={editDwell} onChange={(e) => setEditDwell(Number(e.target.value))} className="w-full accent-blue-500" />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1">Min Displacement&nbsp;<span className="text-white font-semibold">{editDisp}px</span></label>
                        <input type="range" min={10} max={200} value={editDisp} onChange={(e) => setEditDisp(Number(e.target.value))} className="w-full accent-blue-500" />
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1">Min Risk Score&nbsp;<span className="text-white font-semibold">{editRisk.toFixed(2)}</span><span className="text-gray-500 ml-1">(alert threshold)</span></label>
                        <input type="range" min={0} max={1} step={0.05} value={editRisk} onChange={(e) => setEditRisk(Number(e.target.value))} className="w-full accent-orange-500" />
                      </div>
                    </>
                  )}

                  <div className="text-[10px] text-gray-400">
                    Vertices&nbsp;<span className="text-white font-bold">{(editPolygon ?? selectedZone.polygon).length}</span>
                    <span className="ml-2 text-gray-600">{t.zoneVertexHint}</span>
                  </div>

                  {activeVertexIdx !== null && (
                    <div className="bg-yellow-900/40 rounded p-2 text-[10px] text-yellow-300">
                      Vertex {activeVertexIdx + 1} selected<br />
                      <span className="text-yellow-200">{t.zoneDrawVertexHint}</span>
                    </div>
                  )}

                  <div className="flex gap-1">
                    <button onClick={clearSelection} className="flex-1 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-[10px] transition-colors">Deselect</button>
                    <button
                      onClick={handleSaveZone}
                      disabled={saving || !selectedZoneId}
                      className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-[10px] font-bold transition-colors"
                    >
                      {saving ? t.zoneSaveVertexing : t.zoneSave}
                    </button>
                  </div>
                </div>
              ) : zones.length > 0 && (
                <p className="text-center text-[10px] text-gray-500 py-2">{t.zoneClickToSelect}</p>
              )}
            </>
          )}

          {mode === 'draw' && (
            <div className="space-y-2 text-gray-200">
              <div className="bg-blue-900/30 rounded p-2 text-[10px] text-blue-300">{t.zoneDrawHint}</div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-1">{t.zoneName}</label>
                <input
                  value={zoneName}
                  onChange={(e) => setZoneName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-1">{t.zoneType}</label>
                <div className="flex gap-1">
                  {(['MONITOR', 'EXCLUDE'] as const).map((typ) => (
                    <button key={typ} onClick={() => setZoneType(typ)}
                      className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors ${zoneType === typ ? (typ === 'MONITOR' ? 'bg-blue-700 text-white' : 'bg-yellow-700 text-white') : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
                    >
                      {typ === 'MONITOR' ? t.zoneTypeMonitor : t.zoneTypeExclude}
                    </button>
                  ))}
                </div>
              </div>
              {zoneType === 'MONITOR' && (
                <>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">{t.zoneDwellLabel}&nbsp;<span className="text-white font-semibold">{dwellThreshold}{t.zoneSeconds}</span></label>
                    <input type="range" min={5} max={300} value={dwellThreshold} onChange={(e) => setDwellThreshold(Number(e.target.value))} className="w-full accent-blue-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">Min Displacement&nbsp;<span className="text-white font-semibold">{minDisplacement}px</span></label>
                    <input type="range" min={10} max={200} value={minDisplacement} onChange={(e) => setMinDisplacement(Number(e.target.value))} className="w-full accent-blue-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">Min Risk Score&nbsp;<span className="text-white font-semibold">{minRiskScore.toFixed(2)}</span><span className="text-gray-500 ml-1">(alert threshold)</span></label>
                    <input type="range" min={0} max={1} step={0.05} value={minRiskScore} onChange={(e) => setMinRiskScore(Number(e.target.value))} className="w-full accent-orange-500" />
                  </div>
                </>
              )}
              <div className="text-[10px] text-gray-400">
                Vertices&nbsp;<span className="text-white font-bold">{drawPoints.length}</span>
                {drawPoints.length >= 3 && <span className="text-green-400 ml-1">{t.zoneCanSave}</span>}
              </div>
              <div className="flex gap-1">
                <button onClick={() => { setDrawPoints([]); setError(''); }} className="flex-1 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-[10px]">{t.zoneReset}</button>
                <button onClick={handleSaveNew} disabled={saving || drawPoints.length < 3} className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white font-bold text-[10px]">{saving ? t.zoneSaveVertexing : t.zoneSave}</button>
              </div>
            </div>
          )}

          {error && <p className="text-[10px] text-red-400">{error}</p>}

          {mode === 'draw' && zones.length > 0 && (
            <div className="border-t border-gray-700 pt-2 space-y-1">
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wide mb-1">Saved Zones ({zones.length})</p>
              {zones.map((z) => (
                <div
                  key={z.id}
                  className={`flex items-center gap-1.5 rounded px-2 py-1 ${z.id === selectedZoneId ? 'bg-blue-900/40 border border-blue-600/40' : 'bg-gray-800'}`}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${z.type === 'MONITOR' ? 'bg-blue-500' : 'bg-yellow-500'}`} />
                  <span className="flex-1 truncate text-white text-[10px]">{z.name}</span>
                  <span className="text-[9px] text-gray-500 flex-shrink-0">
                    {z.type === 'MONITOR' ? `${z.dwellThreshold ?? 30}${t.zoneSeconds}` : t.zoneTypeExclude}
                    {z.targetClasses && z.targetClasses.length > 0 && (
                      <span className="ml-1 text-blue-500">{z.targetClasses.map(c => c[0].toUpperCase()).join('')}</span>
                    )}
                  </span>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteZone(z.id); }} className="text-gray-600 hover:text-red-400 flex-shrink-0 ml-0.5"><X className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
