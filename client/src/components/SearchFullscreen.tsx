import { useEffect, useRef, useState, useCallback } from 'react';
import type { SearchResult } from '../hooks/useSearch';
import type { PersonTrajectory, CrossCameraReIdEvent } from '../types';
import { useCameraStore } from '../stores/cameraStore';
import { usePersonTrajectoryStore } from '../stores/personTrajectoryStore';
import { useCrossCameraStore } from '../stores/crossCameraStore';
import { useI18n } from '../i18n';
import type { Translations } from '../i18n/translations/en';
import OnvifTimelineOverlay from './OnvifTimelineOverlay';

// ── Constants ────────────────────────────────────────────────────────────────

type TypeFilter = 'all' | 'detection' | 'alert' | 'face' | 'match' | 'event';
type SortMode   = 'newest' | 'oldest' | 'camera';

const TYPE_TO_API: Record<TypeFilter, string> = {
  all:       'detections,alerts,faces,matches,events',
  detection: 'detections',
  alert:     'alerts',
  face:      'faces',
  match:     'matches',
  event:     'events',
};

function getTypeChips(t: Translations): { key: TypeFilter; label: string; color: string; tooltip: string }[] {
  return [
    { key: 'all',       label: t.searchChipAll,       color: 'bg-gray-600 text-gray-200',    tooltip: t.searchChipAllTooltip },
    { key: 'detection', label: t.searchChipDetection,  color: 'bg-blue-700 text-blue-100',    tooltip: t.searchChipDetectionTooltip },
    { key: 'alert',     label: t.searchChipAlert,      color: 'bg-red-700 text-red-100',      tooltip: t.searchChipAlertTooltip },
    { key: 'face',      label: t.searchChipFace,       color: 'bg-purple-700 text-purple-100', tooltip: t.searchChipFaceTooltip },
    { key: 'match',     label: t.searchChipMatch,      color: 'bg-cyan-700 text-cyan-100',    tooltip: t.searchChipMatchTooltip },
    { key: 'event',     label: t.searchChipEvent,      color: 'bg-amber-700 text-amber-100',  tooltip: t.searchChipEventTooltip },
  ];
}

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTs(ts: string | number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDate(ts: string | number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtTime(ts: string | number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function pct(v: number | null | undefined): string {
  if (v == null) return '';
  return (v * 100).toFixed(1) + '%';
}

function shortId(v: string | number | undefined): string {
  if (v == null) return '—';
  const s = String(v);
  return s.length > 12 ? s.slice(0, 8) + '…' + s.slice(-4) : s;
}

function riskLabel(v: number | null | undefined): { label: string; cls: string } {
  if (v == null) return { label: '—', cls: 'text-gray-500' };
  if (v >= 0.85) return { label: 'CRITICAL', cls: 'text-red-400' };
  if (v >= 0.70) return { label: 'HIGH',     cls: 'text-orange-400' };
  if (v >= 0.40) return { label: 'MEDIUM',   cls: 'text-yellow-400' };
  return             { label: 'LOW',      cls: 'text-green-400' };
}

function ProgressBar({ value, color = 'bg-blue-500' }: { value: number; color?: string }) {
  const w = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="text-[10px] text-gray-300 flex-shrink-0 w-8 text-right">{w}%</span>
    </div>
  );
}

// ── Collapsible Section ───────────────────────────────────────────────────────

function Section({
  title, icon, defaultOpen = true, children,
}: {
  title: string; icon?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-700/60 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800/80 hover:bg-gray-700/60 transition-colors text-left"
      >
        {icon && <span className="text-gray-400 flex-shrink-0 w-3.5 h-3.5">{icon}</span>}
        <span className="text-[11px] font-semibold text-gray-300 uppercase tracking-wide flex-1">{title}</span>
        <svg className={`w-3.5 h-3.5 text-gray-500 transition-transform flex-shrink-0 ${open ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && <div className="px-3 py-2.5 bg-gray-900/60">{children}</div>}
    </div>
  );
}

// ── Field Table ──────────────────────────────────────────────────────────────

function FieldRow({ label, value, mono = false }: { label: string; value?: React.ReactNode; mono?: boolean }) {
  if (value == null || value === '' || value === '—') return null;
  return (
    <tr className="border-b border-gray-700/30 last:border-0">
      <td className="py-1 pr-3 text-[10px] text-gray-500 whitespace-nowrap align-top w-28">{label}</td>
      <td className={`py-1 text-[11px] text-gray-200 ${mono ? 'font-mono break-all' : ''}`}>{value}</td>
    </tr>
  );
}

// ── Color Swatch ──────────────────────────────────────────────────────────────

function ColorSwatch({ rgb, label }: { rgb?: [number, number, number]; label: string }) {
  const style = rgb ? { backgroundColor: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` } : undefined;
  return (
    <div className="flex items-center gap-2">
      <div className="w-4 h-4 rounded border border-gray-600 flex-shrink-0" style={style ?? { backgroundColor: '#555' }} />
      <span className="text-[11px] text-gray-200">{label}</span>
      {rgb && <span className="text-[9px] text-gray-500 font-mono">rgb({rgb[0]},{rgb[1]},{rgb[2]})</span>}
    </div>
  );
}

// ── TypeBadge ────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    detection: 'bg-blue-700/60 text-blue-200',
    alert:     'bg-red-700/60 text-red-200',
    face:      'bg-purple-700/60 text-purple-200',
    match:     'bg-cyan-700/60 text-cyan-200',
    event:     'bg-amber-700/60 text-amber-200',
  };
  return (
    <span className={`text-[9px] font-bold rounded px-1.5 py-0.5 uppercase tracking-wide flex-shrink-0 ${map[type] ?? 'bg-gray-700 text-gray-300'}`}>
      {type}
    </span>
  );
}

// ── Image ─────────────────────────────────────────────────────────────────────

function CropImage({ src, alt, className = '' }: { src?: string; alt?: string; className?: string }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className={`flex items-center justify-center bg-gray-800 rounded text-gray-600 text-xs ${className}`}>
        No Image
      </div>
    );
  }
  const dataSrc = src.startsWith('data:') ? src : `data:image/jpeg;base64,${src}`;
  return (
    <img
      src={dataSrc}
      alt={alt ?? 'crop'}
      className={`object-contain rounded bg-gray-900 ${className}`}
      onError={() => setErr(true)}
    />
  );
}

// ── Result Row (left panel) ──────────────────────────────────────────────────

function ResultRow({
  result,
  selected,
  onClick,
  rowRef,
}: {
  result: SearchResult;
  selected: boolean;
  onClick: () => void;
  rowRef?: React.Ref<HTMLButtonElement>;
}) {
  const ts  = result.timestamp || result.createdAt;
  const imgSrc = result.cropData || result.photoData || result.liveCropData || result.thumbnail;

  return (
    <button
      ref={rowRef}
      onClick={onClick}
      className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors border-l-2 ${
        selected
          ? 'bg-blue-900/40 border-blue-500'
          : 'border-transparent hover:bg-gray-700/60'
      }`}
    >
      {/* Thumbnail */}
      <div className="w-10 h-12 flex-shrink-0 bg-gray-800 rounded overflow-hidden">
        {imgSrc ? (
          <img
            src={imgSrc.startsWith('data:') ? imgSrc : `data:image/jpeg;base64,${imgSrc}`}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-700">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M9 10.5h.008v.008H9V10.5zm-.375 0a.375.375 0 11.75 0 .375.375 0 01-.75 0z" />
            </svg>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <TypeBadge type={result._type} />
          {result._type === 'detection' && (
            <span className={`text-[10px] font-semibold ${result.isLoitering ? 'text-red-400' : 'text-green-400'}`}>
              {result.className}
            </span>
          )}
          {result._type === 'alert' && (
            <span className="text-[10px] font-semibold text-orange-400">{result.type}</span>
          )}
          {result._type === 'face' && (
            <span className="text-[10px] font-semibold text-purple-300">{result.name}</span>
          )}
          {result._type === 'match' && (
            <span className="text-[10px] font-semibold text-cyan-300">{result.identity}</span>
          )}
          {(result as unknown as { _type: string })._type === 'event' && (
            <span className="text-[10px] font-semibold text-amber-300">{(result as SearchResult & { type?: string }).type}</span>
          )}
          {result.isLoitering && (
            <span className="text-[7px] font-bold bg-red-600 text-white rounded px-1">LOITER</span>
          )}
          {result.riskScore != null && result.riskScore >= 0.70 && (() => {
            const r2 = riskLabel(result.riskScore);
            return <span className={`text-[7px] font-bold rounded px-1 ${result.riskScore >= 0.85 ? 'bg-red-900 text-red-300' : 'bg-orange-900 text-orange-300'}`}>{r2.label}</span>;
          })()}
        </div>
        <div className="flex items-center gap-1 text-[9px] text-gray-400 flex-wrap">
          {result.cameraName && <span>{result.cameraName}</span>}
          {result.zoneName   && <span>· {result.zoneName}</span>}
          {result._type === 'match' && result.matchScore != null && (
            <span className="text-cyan-500">· {pct(result.matchScore)}</span>
          )}
          {result._type === 'detection' && result.velocity != null && (
            <span className="text-gray-600">· {result.velocity.toFixed(0)}px/s</span>
          )}
        </div>
      </div>

      <div className="text-right flex-shrink-0">
        <div className="text-[9px] text-gray-300">{fmtTime(ts)}</div>
        <div className="text-[8px] text-gray-600">{fmtDate(ts)}</div>
      </div>
    </button>
  );
}

// ── Person Trail Section ──────────────────────────────────────────────────────

function PersonTrailSection({
  faceId, cameraNames,
}: {
  faceId: string | undefined; cameraNames: Map<string, string>;
}) {
  const persons = usePersonTrajectoryStore(s => s.persons);
  if (!faceId) {
    return (
      <Section title="Person Trail" defaultOpen={false} icon="🧭">
        <p className="text-[10px] text-gray-500 italic">No face ID — person trail not available for unmatched objects</p>
      </Section>
    );
  }
  const person: PersonTrajectory | undefined = persons.get(faceId);
  if (!person) {
    return (
      <Section title="Person Trail" defaultOpen={false} icon="🧭">
        <p className="text-[10px] text-gray-500 italic">Person {shortId(faceId)} not found in active sessions</p>
      </Section>
    );
  }
  const durationSec = (person.lastSeenAt - person.firstSeenAt) / 1000;
  return (
    <Section title={`Person Trail — ${person.alias}`} defaultOpen icon="🧭">
      <table className="w-full border-collapse mb-3">
        <tbody>
          <FieldRow label="Alias"      value={<span className="font-bold text-blue-300">{person.alias}</span>} />
          <FieldRow label="Face ID"    value={shortId(person.faceId)} mono />
          <FieldRow label="First Seen" value={fmtTs(person.firstSeenAt)} />
          <FieldRow label="Last Seen"  value={fmtTs(person.lastSeenAt)} />
          <FieldRow label="Total Time" value={`${Math.round(durationSec)} s (${Math.round(durationSec / 60)} min)`} />
          <FieldRow label="Cameras"    value={`${new Set(person.segments.map(s => s.cameraId)).size} camera(s)`} />
        </tbody>
      </table>
      <div className="space-y-1">
        <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">Segments</div>
        {person.segments.map((seg, i) => {
          const name = cameraNames.get(seg.cameraId) || shortId(seg.cameraId);
          const dur  = seg.exitTime ? Math.round((seg.exitTime - seg.entryTime) / 1000) : null;
          const isActive = !seg.exitTime;
          return (
            <div key={i} className={`flex items-center gap-2 px-2 py-1.5 rounded text-[10px] ${isActive ? 'bg-blue-900/40 border border-blue-700/50' : 'bg-gray-800/60'}`}>
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isActive ? 'bg-blue-400 animate-pulse' : 'bg-gray-600'}`} />
              <span className="text-gray-300 font-medium flex-1 truncate">{name}</span>
              <span className="text-gray-500 flex-shrink-0">{fmtTime(seg.entryTime)}</span>
              <span className="text-gray-600 flex-shrink-0">→</span>
              <span className="text-gray-500 flex-shrink-0">{seg.exitTime ? fmtTime(seg.exitTime) : <span className="text-blue-400">now</span>}</span>
              {dur != null && <span className="text-gray-600 flex-shrink-0">({dur}s)</span>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ── Cross-Camera Re-ID Section ────────────────────────────────────────────────

function CrossCameraSection({
  faceId, cameraNames,
}: {
  faceId: string | undefined; cameraNames: Map<string, string>;
}) {
  const events = useCrossCameraStore(s => s.events);
  if (!faceId) return null;
  const related = events.filter((e: CrossCameraReIdEvent) => e.faceId === faceId);
  return (
    <Section title="Cross-Camera Re-ID" defaultOpen={related.length > 0} icon="🔄">
      {related.length === 0 ? (
        <p className="text-[10px] text-gray-500 italic">No recent cross-camera transitions for this person</p>
      ) : (
        <div className="space-y-1.5">
          {related.map((ev, i) => {
            const prevName = cameraNames.get(ev.prevCameraId) || shortId(ev.prevCameraId);
            const newName  = cameraNames.get(ev.newCameraId)  || shortId(ev.newCameraId);
            return (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-800/60 text-[10px]">
                <span className="text-gray-400 truncate flex-shrink-0 max-w-[90px]">{prevName}</span>
                <svg className="w-3 h-3 text-cyan-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                <span className="text-gray-200 font-medium truncate flex-1">{newName}</span>
                <span className="text-cyan-500 flex-shrink-0">{pct(ev.similarity)}</span>
                <span className="text-gray-500 flex-shrink-0">{fmtTime(ev.timestamp)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ── Detection Detail ─────────────────────────────────────────────────────────

function DetectionDetail({ r }: { r: SearchResult }) {
  const cameras     = useCameraStore(s => s.cameras);
  const cameraNames = new Map(cameras.map(c => [c.id, c.name]));
  const camera      = cameras.find(c => c.id === r.cameraId);

  type FaceAttr  = { faceId?: string; name?: string; matchScore?: number; bbox?: { x:number;y:number;width:number;height:number } };
  type MaskAttr  = { status?: string; confidence?: number };
  type HatAttr   = { className?: string; confidence?: number; isHelmet?: boolean | null; safetyCompliant?: boolean | null };
  type ColorAttr = { upper?: string; lower?: string; upperRgb?: [number,number,number]; lowerRgb?: [number,number,number] };
  type ClothAttr = {
    lower?: string; sleeve?: string;
    gender?: string; ageGroup?: string; viewAngle?: string;
    hat?: boolean; glasses?: boolean; handBag?: boolean; shoulderBag?: boolean;
    backpack?: boolean; holdObjectsInFront?: boolean; longCoat?: boolean; boots?: boolean;
  };

  const attrs = r.attributes as Record<string, unknown> | undefined;
  const face  = attrs?.face  as FaceAttr  | undefined;
  const mask  = attrs?.mask  as MaskAttr  | undefined;
  const hat   = attrs?.hat   as HatAttr   | undefined;
  const color = attrs?.color as ColorAttr | undefined;
  const cloth = attrs?.cloth as ClothAttr | undefined;

  const risk   = riskLabel(r.riskScore);
  const faceId = face?.faceId;

  const bboxCenter = r.bbox && r.frameWidth && r.frameHeight
    ? {
        cx: (((r.bbox.x + r.bbox.width  / 2) / r.frameWidth)  * 100).toFixed(1),
        cy: (((r.bbox.y + r.bbox.height / 2) / r.frameHeight) * 100).toFixed(1),
      }
    : null;

  return (
    <div className="flex flex-col gap-2.5 pb-6">
      {/* Crop image */}
      {r.cropData && (
        <div className="relative">
          <CropImage src={r.cropData} alt={r.className} className="w-full max-h-72" />
          <div className="absolute top-2 left-2 flex gap-1 flex-wrap">
            <TypeBadge type="detection" />
            {r.isLoitering && <span className="text-[9px] font-bold bg-red-600 text-white rounded px-1.5 py-0.5">LOITERING</span>}
            {r.riskScore != null && <span className={`text-[9px] font-bold rounded px-1.5 py-0.5 bg-gray-900/80 ${risk.cls}`}>{risk.label}</span>}
          </div>
          {r.confidence != null && (
            <div className="absolute top-2 right-2 bg-gray-900/80 rounded px-1.5 py-0.5">
              <span className="text-[10px] font-bold text-white">{pct(r.confidence)}</span>
            </div>
          )}
          {r.cropWidth && r.cropHeight && (
            <div className="absolute bottom-2 right-2 bg-gray-900/60 rounded px-1.5 py-0.5">
              <span className="text-[8px] text-gray-400">{r.cropWidth}×{r.cropHeight}px</span>
            </div>
          )}
        </div>
      )}

      {/* Object Identity */}
      <Section title="Object Identity">
        <table className="w-full border-collapse">
          <tbody>
            <FieldRow label="Class"     value={<span className={`font-semibold ${r.isLoitering ? 'text-red-400' : 'text-green-400'}`}>{r.className}</span>} />
            <FieldRow label="Object ID" value={shortId(r.objectId)} mono />
            {r.objectId && String(r.objectId).length > 12 && <FieldRow label="Full ID" value={String(r.objectId)} mono />}
            <FieldRow label="Confidence" value={r.confidence != null ? <ProgressBar value={r.confidence} /> : undefined} />
          </tbody>
        </table>
      </Section>

      {/* Position & Frame */}
      {r.bbox && (
        <Section title="Position & Frame" defaultOpen={false}>
          <table className="w-full border-collapse">
            <tbody>
              <FieldRow label="BBox X,Y"  value={`${Math.round(r.bbox.x)}, ${Math.round(r.bbox.y)} px`} />
              <FieldRow label="BBox W×H"  value={`${Math.round(r.bbox.width)} × ${Math.round(r.bbox.height)} px`} />
              {bboxCenter && <FieldRow label="Center" value={`(${bboxCenter.cx}%, ${bboxCenter.cy}%) of frame`} />}
              {r.frameWidth && r.frameHeight && <FieldRow label="Frame" value={`${r.frameWidth} × ${r.frameHeight} px`} />}
              {r.cropWidth  && r.cropHeight  && <FieldRow label="Crop"  value={`${r.cropWidth} × ${r.cropHeight} px`} />}
            </tbody>
          </table>
        </Section>
      )}

      {/* Behavior Metrics */}
      <Section title="Behavior Metrics">
        <div className="space-y-2">
          {r.dwellTime != null && r.dwellTime > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 w-28">Dwell Time</span>
              <span className="text-xs font-semibold text-yellow-400">{Math.round(r.dwellTime)} s</span>
            </div>
          )}
          {r.riskScore != null && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500">Risk Score</span>
                <span className={`text-[10px] font-bold ${risk.cls}`}>{risk.label} ({r.riskScore.toFixed(2)})</span>
              </div>
              <ProgressBar value={r.riskScore} color={
                r.riskScore >= 0.85 ? 'bg-red-500' :
                r.riskScore >= 0.70 ? 'bg-orange-500' :
                r.riskScore >= 0.40 ? 'bg-yellow-500' : 'bg-green-500'
              } />
            </div>
          )}
          {r.velocity != null && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 w-28">Velocity</span>
              <span className="text-xs text-gray-200">{r.velocity.toFixed(1)} px/s</span>
            </div>
          )}
          {r.circularScore != null && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500">Circular Score</span>
                <span className="text-[10px] text-gray-300">{r.circularScore.toFixed(2)}</span>
              </div>
              <ProgressBar value={r.circularScore} color="bg-purple-500" />
            </div>
          )}
          {r.pacingScore != null && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500">Pacing Score</span>
                <span className="text-[10px] text-gray-300">{r.pacingScore.toFixed(2)}</span>
              </div>
              <ProgressBar value={r.pacingScore} color="bg-cyan-500" />
            </div>
          )}
          {r.revisitCount != null && r.revisitCount > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 w-28">Zone Re-entries</span>
              <span className="text-xs font-semibold text-orange-400">{r.revisitCount}×</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-500 w-28">Loitering</span>
            <span className={`text-[10px] font-bold ${r.isLoitering ? 'text-red-400' : 'text-gray-500'}`}>
              {r.isLoitering ? '✓ YES' : 'NO'}
            </span>
          </div>
        </div>
      </Section>

      {/* Location */}
      <Section title="Location">
        <table className="w-full border-collapse">
          <tbody>
            <FieldRow label="Zone"      value={r.zoneName && `${r.zoneName}${r.zoneId ? ` (${shortId(r.zoneId)})` : ''}`} />
            <FieldRow label="Camera"    value={r.cameraName} />
            <FieldRow label="Timestamp" value={fmtTs(r.timestamp)} />
          </tbody>
        </table>
      </Section>

      {/* Pedestrian attributes (PromptPAR / PA100k) */}
      {cloth && (
        <Section title="Attributes" defaultOpen>
          <table className="w-full border-collapse">
            <tbody>
              <FieldRow label="Gender"       value={cloth.gender} />
              <FieldRow label="Age Group"    value={cloth.ageGroup} />
              <FieldRow label="View Angle"   value={cloth.viewAngle} />
              <FieldRow label="Lower Garment" value={cloth.lower} />
              <FieldRow label="Sleeve"        value={cloth.sleeve} />
              <FieldRow label="Accessories"   value={[
                cloth.hat && 'hat',
                cloth.glasses && 'glasses',
                cloth.handBag && 'hand bag',
                cloth.shoulderBag && 'shoulder bag',
                cloth.backpack && 'backpack',
                cloth.holdObjectsInFront && 'holding object',
                cloth.longCoat && 'long coat',
                cloth.boots && 'boots',
              ].filter(Boolean).join(', ') || undefined} />
            </tbody>
          </table>
        </Section>
      )}

      {/* Color Analysis */}
      {color && (color.upper || color.lower) && (
        <Section title="Color Analysis" defaultOpen>
          <div className="space-y-2">
            {color.upper && (
              <div>
                <span className="text-[9px] text-gray-500 uppercase tracking-wide">Upper</span>
                <div className="mt-1"><ColorSwatch rgb={color.upperRgb} label={color.upper} /></div>
              </div>
            )}
            {color.lower && (
              <div>
                <span className="text-[9px] text-gray-500 uppercase tracking-wide">Lower</span>
                <div className="mt-1"><ColorSwatch rgb={color.lowerRgb} label={color.lower} /></div>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Face Recognition */}
      {face && (face.faceId || face.name || face.matchScore != null) && (
        <Section title="Face Recognition" defaultOpen>
          <table className="w-full border-collapse">
            <tbody>
              <FieldRow label="Identity"    value={face.name && <span className="font-semibold text-purple-300">{face.name}</span>} />
              <FieldRow label="Face ID"     value={face.faceId && shortId(face.faceId)} mono />
              <FieldRow label="Match Score" value={face.matchScore != null ? <ProgressBar value={face.matchScore} color="bg-purple-500" /> : undefined} />
              {face.bbox && (
                <FieldRow label="Face BBox" value={`x=${Math.round(face.bbox.x)} y=${Math.round(face.bbox.y)} ${Math.round(face.bbox.width)}×${Math.round(face.bbox.height)}`} />
              )}
            </tbody>
          </table>
        </Section>
      )}

      {/* PPE / Safety */}
      {(mask || hat) && (
        <Section title="PPE / Safety" defaultOpen>
          <table className="w-full border-collapse">
            <tbody>
              {mask?.status && (
                <FieldRow label="Mask" value={
                  <span className={mask.status === 'mask_correct' ? 'text-green-400' : mask.status === 'no_mask' ? 'text-red-400' : 'text-yellow-400'}>
                    {mask.status.replace(/_/g, ' ')}
                    {mask.status === 'mask_correct' ? ' ✓' : mask.status === 'no_mask' ? ' ✗' : ''}
                    {mask.confidence != null && ` (${pct(mask.confidence)})`}
                  </span>
                } />
              )}
              {hat?.className && (
                <FieldRow label="Hat" value={
                  <span className={hat.isHelmet === true ? 'text-green-400' : hat.isHelmet === false ? 'text-red-400' : 'text-gray-300'}>
                    {hat.className}
                    {hat.isHelmet === true  ? ' ✓ (safety compliant)' : ''}
                    {hat.isHelmet === false ? ' ✗ (non-compliant)' : ''}
                    {hat.confidence != null && ` (${pct(hat.confidence)})`}
                  </span>
                } />
              )}
            </tbody>
          </table>
        </Section>
      )}

      {/* Camera Info */}
      <Section title="Camera Info" defaultOpen={false}>
        <table className="w-full border-collapse">
          <tbody>
            <FieldRow label="Name"    value={camera?.name || r.cameraName} />
            <FieldRow label="Camera ID" value={shortId(r.cameraId)} mono />
            {camera?.ip  && <FieldRow label="IP"  value={camera.ip}  mono />}
            {camera?.mac && <FieldRow label="MAC" value={camera.mac} mono />}
            {camera?.rtspUrl && (
              <FieldRow label="RTSP URL" value={<span className="font-mono text-[9px] text-gray-400 break-all">{camera.rtspUrl}</span>} />
            )}
            {camera?.type && <FieldRow label="Type" value={camera.type} />}
            <FieldRow label="Status" value={
              camera ? (
                <span className={`font-semibold ${
                  camera.status === 'live' || camera.status === 'streaming' ? 'text-green-400' :
                  camera.status === 'offline' || camera.status === 'error' ? 'text-red-400' : 'text-yellow-400'
                }`}>{camera.status.toUpperCase()}</span>
              ) : undefined
            } />
          </tbody>
        </table>
      </Section>

      {/* Person Trail */}
      <PersonTrailSection faceId={faceId} cameraNames={cameraNames} />

      {/* Cross-Camera Re-ID */}
      {faceId && <CrossCameraSection faceId={faceId} cameraNames={cameraNames} />}
    </div>
  );
}

// ── Alert Detail ─────────────────────────────────────────────────────────────

function AlertDetail({ r, onAcknowledge }: { r: SearchResult; onAcknowledge?: (id: string) => Promise<void> }) {
  const cameras = useCameraStore(s => s.cameras);
  const camera  = cameras.find(c => c.id === r.cameraId);
  const [acking, setAcking] = useState(false);
  const [acked,  setAcked]  = useState(r.acknowledged ?? false);

  const handleAck = async () => {
    if (acked || acking) return;
    setAcking(true);
    try { await onAcknowledge?.(r.id); setAcked(true); }
    finally { setAcking(false); }
  };

  return (
    <div className="flex flex-col gap-2.5 pb-6">
      {r.cropData && <CropImage src={r.cropData} alt="alert snapshot" className="w-full max-h-64" />}
      <div className="flex items-center gap-2 flex-wrap">
        <TypeBadge type="alert" />
        <span className="text-base font-bold text-orange-400">{r.type}</span>
        {acked && <span className="text-xs font-bold bg-green-700 text-green-200 rounded px-2 py-0.5">ACK'd</span>}
      </div>
      <Section title="Alert Details">
        <table className="w-full border-collapse">
          <tbody>
            <FieldRow label="Type"       value={r.type} />
            <FieldRow label="Camera"     value={r.cameraName} />
            <FieldRow label="Zone"       value={r.zoneName} />
            <FieldRow label="Dwell Time" value={r.dwellTime ? `${Math.round(r.dwellTime)} s` : undefined} />
            <FieldRow label="Timestamp"  value={fmtTs(r.timestamp)} />
          </tbody>
        </table>
        {!acked && (
          <button onClick={handleAck} disabled={acking}
            className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-semibold rounded-md transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {acking ? 'Acknowledging…' : 'Acknowledge Alert'}
          </button>
        )}
      </Section>
      {camera && (
        <Section title="Camera Info" defaultOpen={false}>
          <table className="w-full border-collapse">
            <tbody>
              <FieldRow label="Name"   value={camera.name} />
              {camera.ip && <FieldRow label="IP" value={camera.ip} mono />}
              <FieldRow label="Status" value={camera.status.toUpperCase()} />
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

// ── Face Detail ──────────────────────────────────────────────────────────────

function FaceDetail({ r }: { r: SearchResult }) {
  return (
    <div className="flex flex-col gap-2.5 pb-6">
      {r.photoData && <CropImage src={r.photoData} alt={r.name} className="w-full max-h-64" />}
      <div className="flex items-center gap-2 flex-wrap">
        <TypeBadge type="face" />
        <span className="text-base font-bold text-purple-300">{r.name}</span>
      </div>
      <Section title="Face Record">
        <table className="w-full border-collapse">
          <tbody>
            <FieldRow label="Name"    value={r.name} />
            <FieldRow label="Gallery" value={r.galleryName} />
            <FieldRow label="Type"    value={r.galleryType} />
            <FieldRow label="Notes"   value={r.notes} />
            <FieldRow label="Added"   value={fmtTs(r.createdAt)} />
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ── Match Detail ─────────────────────────────────────────────────────────────

function MatchDetail({ r }: { r: SearchResult }) {
  const cameras    = useCameraStore(s => s.cameras);
  const cameraNames = new Map(cameras.map(c => [c.id, c.name]));
  const faceId     = (r.attributes as { face?: { faceId?: string } } | undefined)?.face?.faceId ?? r.faceId;
  return (
    <div className="flex flex-col gap-2.5 pb-6">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[9px] text-gray-500 text-center mb-1">Live Crop</div>
          <CropImage src={r.liveCropData} alt="live" className="w-full h-40" />
        </div>
        <div>
          <div className="text-[9px] text-gray-500 text-center mb-1">Gallery Photo</div>
          <CropImage src={r.photoData || r.thumbnail} alt="gallery" className="w-full h-40" />
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <TypeBadge type="match" />
        <span className="text-base font-bold text-cyan-300">{r.identity}</span>
      </div>
      {r.matchScore != null && (
        <div>
          <div className="text-[10px] text-gray-500 mb-1">Match Score</div>
          <ProgressBar value={r.matchScore} color="bg-cyan-500" />
        </div>
      )}
      <Section title="Match Details">
        <table className="w-full border-collapse">
          <tbody>
            <FieldRow label="Identity"  value={r.identity} />
            <FieldRow label="Face ID"   value={faceId && shortId(faceId)} mono />
            <FieldRow label="Gallery"   value={r.galleryType} />
            <FieldRow label="Camera"    value={r.cameraName} />
            <FieldRow label="Timestamp" value={fmtTs(r.timestamp || r.createdAt)} />
          </tbody>
        </table>
      </Section>
      {faceId && <PersonTrailSection faceId={faceId} cameraNames={cameraNames} />}
      {faceId && <CrossCameraSection faceId={faceId} cameraNames={cameraNames} />}
    </div>
  );
}

// ── Event Detail ─────────────────────────────────────────────────────────────

function EventDetail({ r }: { r: SearchResult }) {
  const ev = r as SearchResult & { type?: string; message?: string };
  return (
    <div className="flex flex-col gap-2.5 pb-6">
      <div className="flex items-center gap-2 flex-wrap">
        <TypeBadge type="event" />
        <span className="text-base font-bold text-amber-300">{ev.type}</span>
      </div>
      <Section title="Event Details">
        <table className="w-full border-collapse">
          <tbody>
            <FieldRow label="Type"       value={ev.type} />
            <FieldRow label="Camera"     value={r.cameraName} />
            <FieldRow label="Zone"       value={r.zoneName} />
            <FieldRow label="Class"      value={r.className} />
            <FieldRow label="Dwell Time" value={r.dwellTime ? `${Math.round(r.dwellTime)} s` : undefined} />
            <FieldRow label="Timestamp"  value={fmtTs(r.timestamp)} />
            {ev.message && <FieldRow label="Message" value={ev.message} />}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({
  result,
  onAcknowledge,
}: {
  result: SearchResult | null;
  onAcknowledge?: (id: string) => Promise<void>;
}) {
  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-3 select-none">
        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 15.75l-2.489-2.489m0 0a3.375 3.375 0 10-4.773-4.773 3.375 3.375 0 004.774 4.774zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm">Select a result to view details</p>
      </div>
    );
  }

  const t = result._type as string;

  return (
    <div key={result.id + t} className="h-full overflow-y-auto px-4 py-4 animate-fade-in">
      {t === 'detection' && <DetectionDetail r={result} />}
      {t === 'alert'     && <AlertDetail    r={result} onAcknowledge={onAcknowledge} />}
      {t === 'face'      && <FaceDetail     r={result} />}
      {t === 'match'     && <MatchDetail    r={result} />}
      {t === 'event'     && <EventDetail    r={result} />}
    </div>
  );
}

// ── Export CSV ───────────────────────────────────────────────────────────────

function exportCsv(results: SearchResult[], query: string) {
  const headers = [
    'type','id','cameraName','cameraId','className','zoneName','zoneId',
    'objectId','dwellTime','confidence','isLoitering','velocity','riskScore',
    'circularScore','pacingScore','revisitCount','timestamp','name','identity','matchScore',
  ];
  const escape  = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const rows = results.map(r => {
    return headers.map(h => {
      if (h === 'type') return escape(r._type);
      return escape((r as unknown as Record<string, unknown>)[h]);
    }).join(',');
  });
  const csv  = [headers.join(','), ...rows].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  const a    = document.createElement('a');
  a.href     = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  a.download = `lts-search-${query.replace(/[^a-z0-9]/gi, '_')}-${date}.csv`;
  a.click();
}

// ── Main Component ───────────────────────────────────────────────────────────

interface SearchFullscreenProps {
  initialQuery?: string;
  onClose: () => void;
}

export function SearchFullscreen({ initialQuery = '', onClose }: SearchFullscreenProps) {
  const { t } = useI18n();
  const [showOnvifTimeline, setShowOnvifTimeline] = useState(false);
  const [query,    setQuery]   = useState(initialQuery);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [from,     setFrom]    = useState('');
  const [to,       setTo]      = useState('');
  const [sort,     setSort]    = useState<SortMode>('newest');
  const [confMin,  setConfMin] = useState(0);    // 0–100 integer %
  const [confMax,  setConfMax] = useState(100);  // 0–100 integer %
  const [results,  setResults] = useState<SearchResult[]>([]);
  const [total,    setTotal]   = useState(0);
  const [offset,   setOffset]  = useState(0);
  const [loading,  setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,    setError]   = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);

  const inputRef    = useRef<HTMLInputElement>(null);
  const listRef     = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Search function ──────────────────────────────────────────────────────

  const runSearch = useCallback(async (
    q: string,
    tf: TypeFilter,
    fromDate: string,
    toDate: string,
    s: SortMode,
    off: number,
    append: boolean,
    cMin = 0,
    cMax = 100,
  ) => {
    if (!q.trim()) { setResults([]); setTotal(0); return; }

    const params = new URLSearchParams({ q: q.trim(), limit: String(PAGE_SIZE), offset: String(off) });
    params.set('types', TYPE_TO_API[tf]);
    if (fromDate) params.set('from', fromDate);
    if (toDate)   params.set('to',   toDate);
    if (s === 'oldest') params.set('sort', 'oldest');
    if (s === 'camera') params.set('sort', 'camera');
    if (cMin > 0)   params.set('minConfidence', String(cMin / 100));
    if (cMax < 100) params.set('maxConfidence', String(cMax / 100));

    try {
      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data: { query: string; total: number; results: SearchResult[] } = await res.json();
      setTotal(data.total);
      setResults(prev => append ? [...prev, ...data.results] : data.results);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
      if (!append) { setResults([]); setTotal(0); }
    }
  }, []);

  // ── Debounced search on query / filter changes ───────────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setOffset(0);
      setSelected(null);
      setLoadingMore(false);
      setLoading(true);
      runSearch(query, typeFilter, from, to, sort, 0, false, confMin, confMax)
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, typeFilter, from, to, sort, confMin, confMax]);

  // Initial search on mount if query provided
  useEffect(() => {
    if (initialQuery.trim()) {
      setLoading(true);
      runSearch(initialQuery, 'all', '', '', 'newest', 0, false)
        .finally(() => setLoading(false));
    }
    inputRef.current?.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load More ────────────────────────────────────────────────────────────

  const handleLoadMore = useCallback(async () => {
    const nextOffset = offset + PAGE_SIZE;
    setOffset(nextOffset);
    setLoadingMore(true);
    await runSearch(query, typeFilter, from, to, sort, nextOffset, true, confMin, confMax);
    setLoadingMore(false);
  }, [offset, query, typeFilter, from, to, sort, confMin, confMax, runSearch]);

  // ── Keyboard navigation ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setResults(prev => {
          if (prev.length === 0) return prev;
          const idx = selected ? prev.findIndex(r => r.id === selected.id && r._type === selected._type) : -1;
          const next = e.key === 'ArrowDown'
            ? Math.min(idx + 1, prev.length - 1)
            : Math.max(idx - 1, 0);
          const nextResult = prev[next];
          setSelected(nextResult);
          // scroll into view
          setTimeout(() => selectedRef.current?.scrollIntoView({ block: 'nearest' }), 0);
          return prev;
        });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, selected]);

  // ── Acknowledge alert ────────────────────────────────────────────────────

  const handleAcknowledge = useCallback(async (id: string) => {
    await fetch(`/api/alerts/${id}/acknowledge`, { method: 'POST' });
    setResults(prev => prev.map(r =>
      r._type === 'alert' && r.id === id ? { ...r, acknowledged: true } : r
    ));
    if (selected?._type === 'alert' && selected.id === id) {
      setSelected(prev => prev ? { ...prev, acknowledged: true } : prev);
    }
  }, [selected]);

  // ── Render ───────────────────────────────────────────────────────────────

  const canLoadMore = results.length < total && results.length > 0;

  const TYPE_CHIPS = getTypeChips(t);

  return (
    <div className="fixed inset-0 z-[300] bg-gray-900 flex flex-col overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 border-b border-gray-700 bg-gray-800/90 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Search input */}
          <div className="flex items-center gap-2 flex-1 bg-gray-700 rounded-lg px-3 py-2 border border-gray-600 focus-within:border-blue-500 transition-colors">
            {loading ? (
              <svg className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t.searchPlaceholder}
              className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-500 outline-none"
            />
            {query && (
              <button onClick={() => { setQuery(''); setResults([]); setTotal(0); }} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
            )}
          </div>

          {/* Result count */}
          <span className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
            {error ? (
              <span className="text-red-400">{error}</span>
            ) : query.trim() ? (
              t.searchResults(total)
            ) : ''}
          </span>

          {/* Close button */}
          <button
            onClick={onClose}
            title={t.searchClose}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-xs rounded-lg transition-colors flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="hidden sm:inline">{t.searchClose.replace(' (Esc)', '')}</span>
          </button>
        </div>

        {/* Filters row */}
        <div className="flex items-center gap-3 mt-2.5 flex-wrap">
          {/* Type chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {TYPE_CHIPS.map(chip => (
              <button
                key={chip.key}
                onClick={() => setTypeFilter(chip.key)}
                title={chip.tooltip}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                  typeFilter === chip.key
                    ? chip.color + ' ring-1 ring-white/30'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-gray-600 flex-shrink-0" />

          {/* Date range */}
          <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
            <span>{t.searchFrom}</span>
            <input
              type="datetime-local"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-gray-200 text-[10px] focus:outline-none focus:border-blue-500"
            />
            <span>{t.searchTo}</span>
            <input
              type="datetime-local"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-gray-200 text-[10px] focus:outline-none focus:border-blue-500"
            />
            {(from || to) && (
              <button onClick={() => { setFrom(''); setTo(''); }} className="text-gray-500 hover:text-gray-300 text-[9px]">{t.searchClear}</button>
            )}
          </div>

          <div className="h-4 w-px bg-gray-600 flex-shrink-0" />

          {/* Sort */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-400">{t.searchSort}</span>
            <select
              value={sort}
              onChange={e => setSort(e.target.value as SortMode)}
              className="bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-gray-200 text-[10px] focus:outline-none focus:border-blue-500"
            >
              <option value="newest">{t.searchSortNewest}</option>
              <option value="oldest">{t.searchSortOldest}</option>
              <option value="camera">{t.searchSortCamera}</option>
            </select>
          </div>

          <div className="h-4 w-px bg-gray-600 flex-shrink-0" />

          {/* Confidence range */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-400">Conf</span>
            <input
              type="number" min={0} max={100} value={confMin}
              onChange={e => setConfMin(Math.min(Math.max(0, Number(e.target.value)), confMax))}
              className="w-14 bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-gray-200 text-[10px] focus:outline-none focus:border-blue-500"
              title="Min confidence %"
            />
            <span className="text-[9px] text-gray-500">–</span>
            <input
              type="number" min={0} max={100} value={confMax}
              onChange={e => setConfMax(Math.max(Math.min(100, Number(e.target.value)), confMin))}
              className="w-14 bg-gray-700 border border-gray-600 rounded px-1.5 py-0.5 text-gray-200 text-[10px] focus:outline-none focus:border-blue-500"
              title="Max confidence %"
            />
            <span className="text-[9px] text-gray-400">%</span>
            {(confMin > 0 || confMax < 100) && (
              <button
                onClick={() => { setConfMin(0); setConfMax(100); }}
                className="text-[9px] text-gray-500 hover:text-gray-300 underline"
                title="Clear confidence filter"
              >Clear</button>
            )}
          </div>

          <div className="h-4 w-px bg-gray-600 flex-shrink-0" />

          {/* ONVIF Timeline */}
          <button
            onClick={() => setShowOnvifTimeline(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold
                       bg-indigo-900/40 text-indigo-300 border border-indigo-700/40
                       hover:bg-indigo-800/60 hover:text-indigo-100 rounded-full transition-colors"
            title={t.onvifTimelineOpen}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            {t.onvifTimelineOpen}
          </button>
        </div>
      </header>

      {/* ONVIF Timeline overlay */}
      {showOnvifTimeline && (
        <OnvifTimelineOverlay onClose={() => setShowOnvifTimeline(false)} />
      )}

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left panel — result list */}
        <div className="flex flex-col w-[40%] min-w-[280px] border-r border-gray-700 overflow-hidden">
          <div ref={listRef} className="flex-1 overflow-y-auto divide-y divide-gray-700/40">
            {!loading && !error && results.length === 0 && query.trim() && (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                {t.searchNoResults(query)}
              </div>
            )}
            {!query.trim() && (
              <div className="px-4 py-8 text-center text-sm text-gray-600">
                {t.searchTypeQuery}
              </div>
            )}
            {results.map((r, i) => {
              const isSelected = selected?.id === r.id && selected?._type === r._type;
              return (
                <ResultRow
                  key={`${r._type}-${r.id}-${i}`}
                  result={r}
                  selected={isSelected}
                  onClick={() => setSelected(isSelected ? null : r)}
                  rowRef={isSelected ? selectedRef : undefined}
                />
              );
            })}
            {loadingMore && (
              <div className="flex items-center justify-center py-4">
                <svg className="w-5 h-5 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              </div>
            )}
          </div>

          {/* Footer: load more + export */}
          <div className="flex-shrink-0 border-t border-gray-700 px-3 py-2 flex items-center gap-2 bg-gray-800/60">
            <button
              onClick={handleLoadMore}
              disabled={!canLoadMore || loadingMore}
              className="flex-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors py-1"
            >
              {canLoadMore
                ? t.searchLoadMore(results.length, total)
                : results.length > 0
                  ? t.searchAllLoaded(total)
                  : ''}
            </button>
            {results.length > 0 && (
              <button
                onClick={() => exportCsv(results, query)}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 bg-gray-700 hover:bg-gray-600 rounded transition-colors flex-shrink-0"
                title="Export visible results as CSV"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                CSV
              </button>
            )}
          </div>
        </div>

        {/* Right panel — detail */}
        <div className="flex-1 overflow-hidden bg-gray-900">
          <DetailPanel result={selected} onAcknowledge={handleAcknowledge} />
        </div>
      </div>
    </div>
  );
}
