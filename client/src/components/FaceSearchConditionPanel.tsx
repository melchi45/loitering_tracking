import { useEffect, useState, useCallback } from 'react';
import { Search, X, Archive, Pencil } from 'lucide-react';
import { useI18n } from '../i18n';
import type { GalleryType } from '../types';
import { GALLERY_TYPE_META, GALLERY_TYPE_ORDER } from '../utils/galleryTypeMeta';

type ConditionFace = {
  id: string;
  galleryId: string;
  galleryType: GalleryType;
  name: string;
  thumbnail?: string;
  source: 'local' | 'synced';
  createdAt?: string;
};

type ConditionsResponse = {
  total: number;
  byType: Record<GalleryType, number>;
  faces: ConditionFace[];
};

interface Props {
  onClose?: () => void;
}

async function findOrCreateGallery(type: GalleryType): Promise<string> {
  const listRes = await fetch('/api/galleries');
  const listBody = await listRes.json();
  const existing = (listBody.data || []).find((g: { type?: GalleryType }) => g.type === type);
  if (existing) return existing.id;

  const createRes = await fetch('/api/galleries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${type} (analysis)`, type }),
  });
  const createBody = await createRes.json();
  if (!createRes.ok || !createBody.data) throw new Error(createBody.error || 'Failed to create gallery');
  return createBody.data.id;
}

export default function FaceSearchConditionPanel({ onClose }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<ConditionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<GalleryType>('general');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<GalleryType>('general');
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/analysis/face-search-conditions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as ConditionsResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const handleAdd = async () => {
    if (!name.trim() || !file) return;
    setSubmitting(true);
    try {
      const galleryId = await findOrCreateGallery(type);
      const form = new FormData();
      form.append('photo', file);
      form.append('name', name.trim());
      const res = await fetch(`/api/galleries/${galleryId}/faces`, { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setName('');
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add condition');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (f: ConditionFace) => {
    setEditingId(f.id);
    setEditName(f.name);
    setEditType(f.galleryType);
    setEditFile(null);
  };

  const cancelEdit = () => setEditingId(null);

  const handleSaveEdit = async (f: ConditionFace) => {
    setEditSubmitting(true);
    try {
      const form = new FormData();
      if (editName.trim() && editName.trim() !== f.name) form.append('name', editName.trim());
      if (editType !== f.galleryType) form.append('galleryId', await findOrCreateGallery(editType));
      if (editFile) form.append('photo', editFile);

      const res = await fetch(`/api/galleries/${f.galleryId}/faces/${f.id}`, { method: 'PUT', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update condition');
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleDelete = async (f: ConditionFace) => {
    try {
      const res = await fetch(`/api/galleries/${f.galleryId}/faces/${f.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete condition');
    }
  };

  const facesByType = GALLERY_TYPE_ORDER.map((gt) => ({
    type: gt,
    faces: (data?.faces ?? []).filter((f) => f.galleryType === gt),
  }));

  return (
    <div className="flex flex-col h-full bg-gray-950 text-white overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800 flex-shrink-0">
        <Search className="w-4 h-4" />
        <h3 className="text-sm font-semibold flex-1">Active Face Search Conditions</h3>
        <span className="text-xs text-gray-400">{data?.total ?? 0} total</span>
        {onClose && (
          <button onClick={onClose} title={String(t.settingsClose)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-800 text-gray-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ── Add condition form ── */}
      <div className="flex gap-1.5 px-3 py-2 border-b border-gray-800/60 flex-shrink-0 flex-wrap">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as GalleryType)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200"
        >
          {GALLERY_TYPE_ORDER.map((gt) => (
            <option key={gt} value={gt}>{gt}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-[100px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 placeholder-gray-600"
        />
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-[11px] text-gray-400 max-w-[140px]"
        />
        <button
          onClick={handleAdd}
          disabled={submitting || !name.trim() || !file}
          className="px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-600 rounded text-[11px] font-semibold"
        >
          {submitting ? 'Adding…' : 'Add condition'}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-[11px] text-rose-300 bg-rose-950/30 border-b border-rose-900/40">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
        {facesByType.every((g) => g.faces.length === 0) ? (
          <div className="flex flex-col items-center justify-center h-40 text-center px-4 text-gray-600">
            <Archive className="w-6 h-6" />
            <span className="text-[11px] mt-1">No active face search conditions</span>
          </div>
        ) : facesByType.map(({ type: gt, faces }) => {
          if (faces.length === 0) return null;
          const meta = GALLERY_TYPE_META[gt];
          return (
            <div key={gt}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <meta.icon className="w-3 h-3" />
                <span className={`text-[10px] font-bold uppercase rounded-full px-1.5 py-0.5 ${meta.badgeClass}`}>
                  {gt} ({faces.length})
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {faces.map((f) => editingId === f.id ? (
                  <div key={f.id} className={`col-span-4 flex items-center gap-1.5 bg-gray-800 rounded-lg p-2 border-l-2 flex-wrap ${meta.rowClass}`}>
                    {f.thumbnail ? (
                      <img src={f.thumbnail} alt={f.name} className="w-10 h-10 rounded object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded bg-gray-700 flex items-center justify-center text-gray-500 flex-shrink-0">?</div>
                    )}
                    <select
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as GalleryType)}
                      className="bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200"
                    >
                      {GALLERY_TYPE_ORDER.map((gt) => (
                        <option key={gt} value={gt}>{gt}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="flex-1 min-w-[80px] bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200"
                    />
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(e) => setEditFile(e.target.files?.[0] ?? null)}
                      className="text-[10px] text-gray-400 max-w-[110px]"
                    />
                    <button
                      onClick={() => handleSaveEdit(f)}
                      disabled={editSubmitting}
                      className="px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-600 rounded text-[11px] font-semibold"
                    >
                      {editSubmitting ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      disabled={editSubmitting}
                      className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-[11px] text-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div key={f.id} className={`relative group flex flex-col items-center gap-1 bg-gray-800 rounded-lg p-1.5 border-l-2 ${meta.rowClass}`}>
                    <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => startEdit(f)}
                        title="Edit"
                        className="w-4 h-4 flex items-center justify-center rounded bg-gray-900/80 text-gray-300 hover:text-white"
                      >
                        <Pencil className="w-2.5 h-2.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(f)}
                        title="Delete"
                        className="w-4 h-4 flex items-center justify-center rounded bg-gray-900/80 text-gray-400 hover:text-rose-400"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                    {f.thumbnail ? (
                      <img src={f.thumbnail} alt={f.name} className="w-12 h-12 rounded object-cover" />
                    ) : (
                      <div className="w-12 h-12 rounded bg-gray-700 flex items-center justify-center text-gray-500">?</div>
                    )}
                    <span className="text-[10px] text-gray-300 truncate w-full text-center">{f.name}</span>
                    <span className="text-[8px] text-gray-600">{f.source}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
