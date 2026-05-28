import { useState, useEffect, useRef, useCallback } from 'react';
import { useI18n } from '../i18n';
import type { FaceGallery, EnrolledFace, FaceMatchEvent, GalleryType } from '../types';

const API = '/api/galleries';

// ── Gallery type meta ─────────────────────────────────────────────────────────

const GALLERY_TYPE_META: Record<GalleryType, { icon: string; labelKey: keyof ReturnType<typeof useI18n>['t']; badgeClass: string; rowClass: string }> = {
  missing:  { icon: '🔍', labelKey: 'galleryTypeMissing',  badgeClass: 'bg-red-700 text-red-100',     rowClass: 'border-l-red-500' },
  vip:      { icon: '⭐', labelKey: 'galleryTypeVip',      badgeClass: 'bg-yellow-700 text-yellow-100', rowClass: 'border-l-yellow-500' },
  blocklist:{ icon: '🚫', labelKey: 'galleryTypeBlocklist', badgeClass: 'bg-orange-700 text-orange-100', rowClass: 'border-l-orange-500' },
  general:  { icon: '🗃', labelKey: 'galleryTypeGeneral',  badgeClass: 'bg-gray-700 text-gray-300',    rowClass: 'border-l-blue-500' },
};

const GALLERY_TYPE_ORDER: GalleryType[] = ['missing', 'vip', 'blocklist', 'general'];

// ── Small helpers ─────────────────────────────────────────────────────────────

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function pct(v: number) { return `${(v * 100).toFixed(1)}%`; }

// ── Sub-components ────────────────────────────────────────────────────────────

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-20 gap-1 text-gray-600">
      <span className="text-xl">{icon}</span>
      <span className="text-[10px]">{text}</span>
    </div>
  );
}

function GalleryBadge({ count, type }: { count: number; type: GalleryType }) {
  const { badgeClass } = GALLERY_TYPE_META[type];
  return (
    <span className={`ml-auto text-[9px] rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-bold ${badgeClass}`}>
      {count}
    </span>
  );
}

// ── TypePill ──────────────────────────────────────────────────────────────────

function TypePill({ type, t }: { type: GalleryType; t: ReturnType<typeof useI18n>['t'] }) {
  const { icon, badgeClass } = GALLERY_TYPE_META[type];
  return (
    <span className={`inline-flex items-center gap-0.5 text-[8px] font-bold rounded px-1 py-0.5 ${badgeClass}`}>
      {icon} {t[GALLERY_TYPE_META[type].labelKey] as string}
    </span>
  );
}

// ── FaceCard ──────────────────────────────────────────────────────────────────

function FaceCard({ face, onDelete }: { face: EnrolledFace; onDelete: (id: string) => void }) {
  return (
    <div className="relative group flex flex-col items-center gap-1 bg-gray-800 rounded-lg p-1.5 border border-gray-700 hover:border-gray-500 transition-colors">
      {face.thumbnail ? (
        <img src={face.thumbnail} alt={face.name} className="w-12 h-12 rounded object-cover border border-gray-700" />
      ) : (
        <div className="w-12 h-12 rounded bg-gray-700 flex items-center justify-center text-gray-500 text-xl">👤</div>
      )}
      <span className="text-[9px] text-gray-300 font-medium truncate w-full text-center max-w-[56px]">{face.name}</span>
      <button
        onClick={() => onDelete(face.id)}
        className="absolute top-0.5 right-0.5 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full bg-red-700 hover:bg-red-600 text-white text-[9px] transition-colors"
        title="Delete"
      >✕</button>
    </div>
  );
}

// ── UploadArea ────────────────────────────────────────────────────────────────

interface UploadAreaProps {
  galleryId: string;
  onEnrolled: () => void;
  t: ReturnType<typeof useI18n>['t'];
}

function UploadArea({ galleryId, onEnrolled, t }: UploadAreaProps) {
  const [name, setName]         = useState('');
  const [preview, setPreview]   = useState<string | null>(null);
  const [file, setFile]         = useState<File | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    setFile(f); setError(null);
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(f);
  };

  const onEnroll = async () => {
    if (!file) return;
    setLoading(true); setError(null);
    try {
      const form = new FormData();
      form.append('photo', file);
      form.append('name', name.trim() || 'Unknown');
      const r = await fetch(`${API}/${galleryId}/faces`, { method: 'POST', body: form });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'Enrollment failed');
      setFile(null); setPreview(null); setName('');
      onEnrolled();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  };

  return (
    <div className="space-y-2">
      <div
        className={`relative border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors ${
          dragging ? 'border-blue-500 bg-blue-950/30' : 'border-gray-600 hover:border-gray-500'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
      >
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        {preview
          ? <img src={preview} alt="preview" className="mx-auto h-20 rounded object-contain" />
          : <div className="py-3"><div className="text-2xl mb-1">📷</div><p className="text-[10px] text-gray-400">{t.faceUploadHint}</p></div>
        }
      </div>
      <input type="text" placeholder={t.faceNamePlaceholder} value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500" />
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      <button onClick={onEnroll} disabled={!file || loading}
        className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-xs font-semibold text-white transition-colors">
        {loading ? t.faceEnrolling : t.faceEnroll}
      </button>
    </div>
  );
}

// ── MatchLog ──────────────────────────────────────────────────────────────────

function MatchLog({ events, t }: { events: FaceMatchEvent[]; t: ReturnType<typeof useI18n>['t'] }) {
  if (!events.length) return <EmptyState icon="👁" text={String(t.faceNoMatches)} />;
  return (
    <div className="space-y-1 max-h-48 overflow-y-auto pr-0.5">
      {events.map((ev, i) => {
        const isMissing = ev.galleryType === 'missing';
        const isVip     = ev.galleryType === 'vip';
        const isBlock   = ev.galleryType === 'blocklist';
        const bg   = isMissing ? 'bg-red-950/60 border-red-700/60'
                   : isVip     ? 'bg-yellow-950/50 border-yellow-700/50'
                   : isBlock   ? 'bg-orange-950/50 border-orange-700/50'
                   : 'bg-gray-800/60 border-gray-700/40';
        const icon = isMissing ? '🚨' : isVip ? '⭐' : isBlock ? '🚫' : '⚡';
        return (
          <div key={i} className={`flex items-center gap-2 border rounded px-2 py-1 ${bg}`}>
            {/* Enrolled gallery photo */}
            {ev.thumbnail
              ? <img src={ev.thumbnail} alt={ev.identity} title="Enrolled" className="w-7 h-7 rounded object-cover flex-shrink-0" />
              : <span className="w-7 h-7 flex items-center justify-center text-sm flex-shrink-0">👤</span>
            }
            {/* Live crop from frame (v1.1) */}
            {ev.liveCropData
              ? <img src={ev.liveCropData} alt="live" title="Live" className="w-7 h-7 rounded object-cover flex-shrink-0 ring-1 ring-blue-500" />
              : <span className="w-7 h-7 flex items-center justify-center text-xs text-gray-600 flex-shrink-0">👤</span>
            }
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 flex-wrap">
                {isMissing && (
                  <span className="text-[8px] font-bold bg-red-700 text-red-100 rounded px-1 py-0.5 animate-pulse">
                    {String(t.galleryTypeMissing)}
                  </span>
                )}
                <span className={`font-bold text-[10px] truncate ${isMissing ? 'text-red-200' : 'text-yellow-300'}`}>{ev.identity}</span>
                <span className="text-[9px] text-gray-500 flex-shrink-0">{pct(ev.matchScore)}</span>
              </div>
              <div className="text-[9px] text-gray-500 truncate">{ev.cameraId} · {formatTime(ev.timestamp)}</div>
            </div>
            <span className="text-lg flex-shrink-0">{icon}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── GallerySection ────────────────────────────────────────────────────────────

interface GallerySectionProps {
  type: GalleryType;
  galleries: FaceGallery[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  t: ReturnType<typeof useI18n>['t'];
}

function GallerySection({ type, galleries, selectedId, onSelect, onDelete, t }: GallerySectionProps) {
  const { icon, rowClass } = GALLERY_TYPE_META[type];
  const list = galleries.filter(g => (g.type || 'general') === type);
  if (!list.length) return null;

  const isMissing = type === 'missing';

  return (
    <div className="mb-0.5">
      {/* Section header */}
      <div className={`flex items-center gap-1 px-3 py-0.5 ${isMissing ? 'bg-red-950/40' : 'bg-gray-850'}`}>
        <span className="text-[9px]">{icon}</span>
        <span className={`text-[8px] uppercase tracking-wide font-bold ${isMissing ? 'text-red-400' : 'text-gray-500'}`}>
          {t[GALLERY_TYPE_META[type].labelKey] as string}
          {isMissing && <span className="ml-1 text-red-500 animate-pulse">●</span>}
        </span>
      </div>
      {list.map(g => (
        <button
          key={g.id}
          onClick={() => onSelect(g.id === selectedId ? '' : g.id)}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-800 transition-colors border-l-2 ${
            g.id === selectedId
              ? `bg-gray-800 ${rowClass}`
              : 'border-l-transparent'
          } ${isMissing ? 'hover:bg-red-950/30' : ''}`}
        >
          <span className="flex-1 truncate text-[10px] font-medium">{g.name}</span>
          <GalleryBadge count={g.faceCount} type={g.type || 'general'} />
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(g.id); }}
            className="text-gray-600 hover:text-red-400 text-[10px] ml-1 transition-colors"
            title={String(t.faceDeleteGallery)}
          >✕</button>
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FaceGalleryTab() {
  const { t } = useI18n();

  const [galleries, setGalleries]       = useState<FaceGallery[]>([]);
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [faces, setFaces]               = useState<EnrolledFace[]>([]);
  const [matchLog, setMatchLog]         = useState<FaceMatchEvent[]>([]);
  const [newGallName, setNewGallName]   = useState('');
  const [newGallType, setNewGallType]   = useState<GalleryType>('general');
  const [creating, setCreating]         = useState(false);
  const [loadingFaces, setLoadingFaces] = useState(false);
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const matchLogRef = useRef<FaceMatchEvent[]>([]);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchGalleries = useCallback(async () => {
    try {
      const r = await fetch(API);
      const j = await r.json();
      if (j.success) setGalleries(j.data);
    } catch (_) {}
  }, []);

  const fetchFaces = useCallback(async (galleryId: string) => {
    setLoadingFaces(true);
    try {
      const r = await fetch(`${API}/${galleryId}/faces`);
      const j = await r.json();
      if (j.success) setFaces(j.data);
    } catch (_) {} finally { setLoadingFaces(false); }
  }, []);

  useEffect(() => { fetchGalleries(); }, [fetchGalleries]);

  useEffect(() => {
    if (selectedId) fetchFaces(selectedId);
    else setFaces([]);
  }, [selectedId, fetchFaces]);

  // ── Socket.IO face_match listener ─────────────────────────────────────────

  useEffect(() => {
    const socket = (window as unknown as { __ltsSocket?: { on: (e: string, cb: (d: unknown) => void) => void; off: (e: string, cb: (d: unknown) => void) => void } }).__ltsSocket;
    if (!socket) return;
    const handler = (ev: unknown) => {
      const next = [ev as FaceMatchEvent, ...matchLogRef.current].slice(0, 50);
      matchLogRef.current = next;
      setMatchLog([...next]);
    };
    socket.on('face_match', handler);
    return () => socket.off('face_match', handler);
  }, []);

  // ── Missing person alert banner (flashing) ────────────────────────────────

  const latestMissing = matchLog.find(e => e.galleryType === 'missing');

  // ── Actions ────────────────────────────────────────────────────────────────

  const createGallery = async () => {
    if (!newGallName.trim()) return;
    setCreating(true);
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGallName.trim(), type: newGallType }),
      });
      const j = await r.json();
      if (j.success) {
        setNewGallName(''); setShowTypeMenu(false);
        await fetchGalleries();
        setSelectedId(j.data.id);
      }
    } catch (_) {} finally { setCreating(false); }
  };

  const deleteGallery = async (id: string) => {
    if (!confirm(String(t.faceDeleteGalleryConfirm))) return;
    await fetch(`${API}/${id}`, { method: 'DELETE' });
    if (selectedId === id) setSelectedId(null);
    await fetchGalleries();
  };

  const handleSelect = (id: string) => setSelectedId(id === selectedId ? null : id);

  const deleteFace = async (faceId: string) => {
    if (!selectedId) return;
    await fetch(`${API}/${selectedId}/faces/${faceId}`, { method: 'DELETE' });
    setFaces(prev => prev.filter(f => f.id !== faceId));
    setGalleries(prev => prev.map(g => g.id === selectedId ? { ...g, faceCount: Math.max(0, g.faceCount - 1) } : g));
  };

  const selectedGallery = galleries.find(g => g.id === selectedId) ?? null;
  const missingCount = galleries.filter(g => (g.type || 'general') === 'missing').reduce((s, g) => s + g.faceCount, 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-200 text-xs overflow-hidden">

      {/* ── Missing person alert banner ── */}
      {latestMissing && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-red-800/80 border-b border-red-700 animate-pulse">
          <span className="text-base">🚨</span>
          <div className="flex-1 min-w-0">
            <span className="font-bold text-red-100 text-[10px]">{String(t.missingPersonAlert)}: </span>
            <span className="text-red-200 text-[10px] font-semibold">{latestMissing.identity}</span>
            <span className="text-red-400 text-[9px] ml-1">({pct(latestMissing.matchScore)})</span>
          </div>
          <span className="text-[9px] text-red-400 flex-shrink-0">{latestMissing.cameraId}</span>
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-3 pt-2 pb-2 border-b border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-gray-100">{t.tabFaceGallery}</span>
            {missingCount > 0 && (
              <span className="text-[9px] bg-red-700 text-red-100 rounded-full px-1.5 py-0.5 font-bold animate-pulse">
                🔍 {missingCount}
              </span>
            )}
          </div>
          <span className="text-[9px] text-gray-500">{t.faceGallerySubtitle}</span>
        </div>

        {/* Create gallery row */}
        <div className="flex gap-1">
          {/* Type selector button */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowTypeMenu(v => !v)}
              className="h-full px-2 bg-gray-700 border border-gray-600 rounded text-base hover:bg-gray-600 transition-colors"
              title={String(t.faceSelectType)}
            >
              {GALLERY_TYPE_META[newGallType].icon}
            </button>
            {showTypeMenu && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden min-w-[130px]">
                {GALLERY_TYPE_ORDER.map(type => (
                  <button
                    key={type}
                    onClick={() => { setNewGallType(type); setShowTypeMenu(false); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-[10px] hover:bg-gray-700 transition-colors ${newGallType === type ? 'bg-gray-700' : ''}`}
                  >
                    <span>{GALLERY_TYPE_META[type].icon}</span>
                    <span className="font-medium">{t[GALLERY_TYPE_META[type].labelKey] as string}</span>
                    {type === 'missing' && <span className="ml-auto text-[8px] text-red-400">●</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <input
            type="text"
            placeholder={t.faceNewGalleryPlaceholder}
            value={newGallName}
            onChange={e => setNewGallName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createGallery()}
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={createGallery}
            disabled={creating || !newGallName.trim()}
            className="px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-600 rounded text-[10px] font-semibold transition-colors whitespace-nowrap"
          >{t.faceCreateGallery}</button>
        </div>
      </div>

      {/* ── Gallery list — grouped by type ── */}
      <div className="flex-shrink-0 border-b border-gray-800 max-h-36 overflow-y-auto">
        {galleries.length === 0
          ? <EmptyState icon="🗃" text={String(t.faceNoGalleries)} />
          : GALLERY_TYPE_ORDER.map(type => (
              <GallerySection
                key={type}
                type={type}
                galleries={galleries}
                selectedId={selectedId}
                onSelect={handleSelect}
                onDelete={deleteGallery}
                t={t}
              />
            ))
        }
      </div>

      {/* ── Selected gallery content ── */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {!selectedGallery
          ? <EmptyState icon="👆" text={String(t.faceSelectGallery)} />
          : (
            <>
              {/* Gallery type badge */}
              <div className="flex items-center gap-2">
                <TypePill type={selectedGallery.type || 'general'} t={t} />
                <span className="text-[10px] text-gray-400 font-medium">{selectedGallery.name}</span>
                {selectedGallery.description && (
                  <span className="text-[9px] text-gray-600 truncate">{selectedGallery.description}</span>
                )}
              </div>

              {/* Upload */}
              <div>
                <p className="text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-1.5">{t.faceEnrollTitle}</p>
                <UploadArea galleryId={selectedGallery.id} onEnrolled={() => fetchFaces(selectedGallery.id).then(fetchGalleries)} t={t} />
              </div>

              {/* Enrolled faces */}
              <div>
                <p className="text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-1.5">{t.faceEnrolled} ({faces.length})</p>
                {loadingFaces
                  ? <EmptyState icon="⏳" text="Loading…" />
                  : faces.length === 0
                    ? <EmptyState icon="👤" text={String(t.faceNoFaces)} />
                    : (
                      <div className="grid grid-cols-4 gap-1.5">
                        {faces.map(f => <FaceCard key={f.id} face={f} onDelete={deleteFace} />)}
                      </div>
                    )
                }
              </div>
            </>
          )
        }

        {/* Live match log — always visible */}
        <div>
          <p className="text-[9px] text-gray-500 uppercase tracking-wide font-bold mb-1.5">{t.faceLiveMatches}</p>
          <MatchLog events={matchLog} t={t} />
        </div>
      </div>
    </div>
  );
}
