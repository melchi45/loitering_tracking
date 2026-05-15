import { useCallback, useEffect, useRef, useState } from 'react';
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

interface AiAttr { id: string; label: string; labelKo: string; }
const AI_ATTRIBUTE_DEFS: AiAttr[] = [
  { id: 'human',       label: 'Human',       labelKo: '사람'   },
  { id: 'vehicle',     label: 'Vehicle',      labelKo: '차량'   },
  { id: 'face',        label: 'Face',         labelKo: '얼굴'   },
  { id: 'mask',        label: 'Mask',         labelKo: '마스크' },
  { id: 'color',       label: 'Color',        labelKo: '색상'   },
  { id: 'cloth',       label: 'Cloth',        labelKo: '의류'   },
  { id: 'hat',         label: 'Hat',          labelKo: '모자'   },
  { id: 'accessories', label: 'Accessories',  labelKo: '소품'   },
  { id: 'fire',        label: 'Fire',         labelKo: '화재'   },
  { id: 'smoke',       label: 'Smoke',        labelKo: '연기'   },
];

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

  const [selectedZoneId,  setSelectedZoneId]  = useState<string | null>(null);
  const [editPolygon,     setEditPolygon]     = useState<Point[] | null>(null);
  const [activeVertexIdx, setActiveVertexIdx] = useState<number | null>(null);
  const [contextMenu,     setContextMenu]     = useState<{ x: number; y: number } | null>(null);
  const [ctxVertexIdx,    setCtxVertexIdx]    = useState<number | null>(null);
  const [editName,        setEditName]        = useState('');
  const [targetClasses,   setTargetClasses]   = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  // AI module availability — loaded from server /api/capabilities on mount
  const [aiCaps, setAiCaps] = useState<Record<string, boolean>>({
    human: true, vehicle: true, face: false, mask: false,
    color: false, cloth: false, hat: false, accessories: false,
  });
  useEffect(() => {
    fetch('/api/capabilities')
      .then(r => r.json())
      .then(d => { if (d.ai) setAiCaps(d.ai); })
      .catch(() => {});
  }, []);

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
    if (!selectedZoneId) { setEditName(''); setTargetClasses([]); return; }
    const z = zones.find(z => z.id === selectedZoneId);
    if (z) {
      setEditName(z.name);
      editNameRef.current = z.name;
      setTargetClasses(z.targetClasses ?? []);
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
    setTargetClasses(z.targetClasses ?? []);
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
          ctx.fillText(`꼭짓점 ${activeVertexIdx + 1} — 드래그하거나 이동 위치 클릭`, 12, 24);
        } else {
          ctx.fillStyle = 'rgba(180,200,255,0.88)';
          ctx.fillText('꼭짓점 드래그로 이동  /  꼭짓점 위 우클릭 → 꼭짓점 삭제  /  빈 곳 우클릭 → 저장·Zone 삭제', 12, 24);
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
        ctx.fillText('더블클릭으로 완성', fp0.x + 10, fp0.y - 8);
      }
    }
  }, [drawPoints, zones, zoneType, mode, selectedZoneId, editPolygon, activeVertexIdx, frameToCanvas]);

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
    if (drawPoints.length < 3) { setError('최소 3개 꼭짓점이 필요합니다.'); return; }
    if (!zoneName.trim())       { setError('Zone 이름을 입력하세요.'); return; }
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/cameras/${cameraId}/zones`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: zoneName, type: zoneType, polygon: drawPoints, dwellThreshold, minDisplacement }),
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
      if (data) { onZoneUpdated(data); editPolyRef.current = null; setEditPolygon(null); }
      activeVIdxRef.current = null; setActiveVertexIdx(null);
      ctxMenuRef.current    = null; setContextMenu(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally { setSaving(false); }
  };

  const handleSaveName = async () => {
    const selId = selIdRef.current;
    const name  = editNameRef.current.trim();
    if (!selId || !name) return;
    const zone = zonesRef.current.find(z => z.id === selId);
    if (!zone || zone.name === name) return;
    try {
      const data = await apiPut(selId, { name });
      if (data) onZoneUpdated(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Name save failed');
    }
  };

  const handleTargetClassToggle = async (cls: string) => {
    const selId = selIdRef.current;
    if (!selId) return;
    const next = targetClasses.includes(cls)
      ? targetClasses.filter(c => c !== cls)
      : [...targetClasses, cls];
    setTargetClasses(next);
    try {
      const data = await apiPut(selId, { targetClasses: next });
      if (data) onZoneUpdated(data);
    } catch (err) {
      setTargetClasses(targetClasses); // rollback
      setError(err instanceof Error ? err.message : 'Update failed');
    }
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
      setError('꼭짓점이 3개이면 더 이상 삭제할 수 없습니다. Zone 전체를 삭제하려면 "Zone 삭제"를 사용하세요.');
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
              <span className="text-yellow-400 ml-1">— 꼭짓점 {ctxVertexIdx + 1}</span>
            )}
          </div>

          {/* Vertex delete — only visible when right-click landed on a vertex */}
          {ctxVertexIdx !== null && (
            <button
              onClick={handleDeleteVertex}
              disabled={saving || (editPolygon?.length ?? 0) <= 3}
              title={(editPolygon?.length ?? 0) <= 3 ? '최소 3개 꼭짓점 필요' : '이 꼭짓점을 삭제하고 자동 저장'}
              className="w-full text-left px-3 py-1.5 text-orange-400 hover:bg-orange-900/50 disabled:opacity-40 transition-colors"
            >
              꼭짓점 {ctxVertexIdx + 1} 삭제
            </button>
          )}

          <button
            onClick={handleSavePolygon}
            disabled={saving}
            className="w-full text-left px-3 py-1.5 text-blue-300 hover:bg-blue-800/60 disabled:opacity-40 transition-colors"
          >
            {saving ? '저장 중…' : '꼭짓점 변경 저장'}
          </button>
          <button
            onClick={() => selectedZoneId && handleDeleteZone(selectedZoneId)}
            className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-red-900/50 transition-colors"
          >
            Zone 삭제
          </button>
          <div className="border-t border-gray-700 my-0.5" />
          <button
            onClick={() => { ctxMenuRef.current = null; setContextMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-gray-400 hover:bg-gray-700 transition-colors"
          >
            닫기
          </button>
        </div>
      )}

      {/* ── Control panel (right edge) ─────────────────────────────────────── */}
      <div className="absolute top-0 right-0 h-full w-64 bg-gray-900/95 border-l border-gray-700 flex flex-col text-xs z-[105]">

        <div className="flex items-center justify-between px-3 py-2.5 bg-gray-800 border-b border-gray-700 flex-shrink-0">
          <span className="font-bold text-sm text-white">Zone 편집</span>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none px-1" title="닫기">×</button>
        </div>

        <div className="flex border-b border-gray-700 flex-shrink-0">
          <button
            onClick={() => { setMode('idle'); modeRef.current = 'idle'; setDrawPoints([]); setError(''); }}
            className={`flex-1 py-2 text-[10px] font-bold transition-colors ${mode === 'idle' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            선택·편집
          </button>
          <button
            onClick={() => { setMode('draw'); modeRef.current = 'draw'; clearSelection(); ctxMenuRef.current = null; setContextMenu(null); setError(''); }}
            className={`flex-1 py-2 text-[10px] font-bold transition-colors ${mode === 'draw' ? 'bg-blue-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            + 그리기
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">

          {mode === 'idle' && (
            selectedZone ? (
              <div className="space-y-2.5">

                <div>
                  <label className="block text-[10px] text-gray-400 mb-1 font-semibold uppercase tracking-wide">Zone 이름</label>
                  <div className="flex gap-1">
                    <input
                      value={editName}
                      onChange={(e) => { setEditName(e.target.value); editNameRef.current = e.target.value; }}
                      onBlur={handleSaveName}
                      onKeyDown={(e) => { if (e.key === 'Enter') { handleSaveName(); e.currentTarget.blur(); } }}
                      className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                      placeholder="Zone 이름"
                    />
                    <button onClick={handleSaveName} className="px-2 py-1 text-[10px] rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors" title="이름 저장">✓</button>
                  </div>
                </div>

                <div className="bg-gray-800 rounded p-2 flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${selectedZone.type === 'MONITOR' ? 'bg-blue-500' : 'bg-yellow-500'}`} />
                  <span className="text-[10px] text-gray-400">{selectedZone.type}</span>
                  <span className="text-[10px] text-gray-500 ml-auto">{(editPolygon ?? selectedZone.polygon).length}개 꼭짓점</span>
                </div>

                {/* AI 감지 대상 선택 */}
                <div>
                  <label className="block text-[10px] text-gray-400 mb-1.5 font-semibold uppercase tracking-wide">
                    AI 감지 대상
                    <span className="ml-1 text-gray-600 normal-case font-normal">(미선택 시 전체)</span>
                  </label>
                  <div className="grid grid-cols-2 gap-1">
                    {AI_ATTRIBUTE_DEFS.map((attr) => {
                      const available = aiCaps[attr.id] ?? false;
                      const checked   = targetClasses.includes(attr.id);
                      return (
                        <button
                          key={attr.id}
                          onClick={() => available && handleTargetClassToggle(attr.id)}
                          disabled={!available}
                          title={available ? '' : '모델 미설치 (서버/models/ 디렉토리 확인)'}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-left transition-colors ${
                            !available
                              ? 'opacity-35 cursor-not-allowed bg-gray-800 text-gray-500'
                              : checked
                              ? 'bg-blue-700/70 text-white border border-blue-500'
                              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 border border-transparent'
                          }`}
                        >
                          <span className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center ${
                            checked ? 'bg-blue-500 border-blue-400' : 'border-gray-600'
                          }`}>
                            {checked && <span className="text-white text-[8px] leading-none">✓</span>}
                          </span>
                          <span className="truncate">{attr.labelKo}</span>
                          {!available && <span className="ml-auto text-[8px] text-gray-600">준비중</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="bg-blue-900/30 rounded p-2 text-[10px] text-blue-300 leading-relaxed space-y-0.5">
                  <p>• 꼭짓점 <strong>드래그</strong> → 실시간 이동 (전체 영역)</p>
                  <p>• 꼭짓점 위 <strong>우클릭</strong> → 꼭짓점 삭제</p>
                  <p>• 빈 곳 <strong>우클릭</strong> → 변경 저장 / Zone 삭제</p>
                </div>

                {activeVertexIdx !== null && (
                  <div className="bg-yellow-900/40 rounded p-2 text-[10px] text-yellow-300">
                    꼭짓점 {activeVertexIdx + 1} 선택됨<br />
                    <span className="text-yellow-200">드래그하거나 이동할 위치를 클릭하세요</span>
                  </div>
                )}

                <div className="flex gap-1">
                  <button onClick={clearSelection} className="flex-1 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-[10px] transition-colors">선택 해제</button>
                  <button
                    onClick={handleSavePolygon}
                    disabled={saving || !editPolygon}
                    className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-[10px] font-bold transition-colors"
                  >
                    {saving ? '저장…' : '꼭짓점 저장'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-24 text-center">
                <p className="text-[10px] text-gray-400 leading-relaxed">
                  Zone을 클릭하여 선택하세요<br />
                  꼭짓점 드래그 이동 / 우클릭 저장·삭제
                </p>
              </div>
            )
          )}

          {mode === 'draw' && (
            <div className="space-y-2 text-gray-200">
              <div className="bg-blue-900/30 rounded p-2 text-[10px] text-blue-300">클릭 → 꼭짓점 추가 / 더블클릭 → 완성</div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-1">Zone 이름</label>
                <input
                  value={zoneName}
                  onChange={(e) => setZoneName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-1">유형</label>
                <div className="flex gap-1">
                  {(['MONITOR', 'EXCLUDE'] as const).map((t) => (
                    <button key={t} onClick={() => setZoneType(t)}
                      className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors ${zoneType === t ? (t === 'MONITOR' ? 'bg-blue-700 text-white' : 'bg-yellow-700 text-white') : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
                    >
                      {t === 'MONITOR' ? '감시' : '제외'}
                    </button>
                  ))}
                </div>
              </div>
              {zoneType === 'MONITOR' && (
                <>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">체류 임계값&nbsp;<span className="text-white font-semibold">{dwellThreshold}초</span></label>
                    <input type="range" min={5} max={300} value={dwellThreshold} onChange={(e) => setDwellThreshold(Number(e.target.value))} className="w-full accent-blue-500" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">최소 이동거리&nbsp;<span className="text-white font-semibold">{minDisplacement}px</span></label>
                    <input type="range" min={10} max={200} value={minDisplacement} onChange={(e) => setMinDisplacement(Number(e.target.value))} className="w-full accent-blue-500" />
                  </div>
                </>
              )}
              <div className="text-[10px] text-gray-400">
                꼭짓점&nbsp;<span className="text-white font-bold">{drawPoints.length}</span>개
                {drawPoints.length >= 3 && <span className="text-green-400 ml-1">✓ 저장 가능</span>}
              </div>
              <div className="flex gap-1">
                <button onClick={() => { setDrawPoints([]); setError(''); }} className="flex-1 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-[10px]">초기화</button>
                <button onClick={handleSaveNew} disabled={saving || drawPoints.length < 3} className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white font-bold text-[10px]">{saving ? '저장…' : '저장'}</button>
              </div>
            </div>
          )}

          {error && <p className="text-[10px] text-red-400">{error}</p>}

          {zones.length > 0 && (
            <div className="border-t border-gray-700 pt-2 space-y-1">
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wide mb-1">저장된 Zone ({zones.length})</p>
              {zones.map((z) => (
                <div
                  key={z.id}
                  onClick={() => { if (mode === 'idle') { ctxMenuRef.current = null; setContextMenu(null); selectZone(z); } }}
                  className={`flex items-center gap-1.5 rounded px-2 py-1 transition-colors ${mode === 'idle' ? 'cursor-pointer' : ''} ${z.id === selectedZoneId ? 'bg-blue-900/40 border border-blue-600/40' : 'bg-gray-800 hover:bg-gray-700'}`}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${z.type === 'MONITOR' ? 'bg-blue-500' : 'bg-yellow-500'}`} />
                  <span className="flex-1 truncate text-white text-[10px]">{z.name}</span>
                  <span className="text-[9px] text-gray-500 flex-shrink-0">
                    {z.type === 'MONITOR' ? `${z.dwellThreshold ?? 30}s` : '제외'}
                    {z.targetClasses && z.targetClasses.length > 0 && (
                      <span className="ml-1 text-blue-500">{z.targetClasses.map(c => c[0].toUpperCase()).join('')}</span>
                    )}
                  </span>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteZone(z.id); }} className="text-gray-600 hover:text-red-400 text-[10px] flex-shrink-0 ml-0.5">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
