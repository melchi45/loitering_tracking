import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useCameraStore } from '../stores/cameraStore';
import CameraView from './CameraView';
import type { Camera } from '../types';

// ─── Layout type definitions ─────────────────────────────────────────────────

export type LayoutId =
  | '1' | '2' | '4' | '1+3' | '5' | '1+4'
  | '8' | '1+7' | '9' | '12' | '1+11'
  | '16' | '1+15' | '24' | '32' | '64'
  | '2+2' | '2+6' | '2+10' | '2+14'
  | '3+5' | '3+9' | '3+13';

interface FeaturedSpec {
  mainCount?: number; // number of main cameras in the main panel (default 1)
  subCols:   number;  // columns in the sub-camera panel
  mainFlex:  number;  // CSS flex-grow ratio for the main panel
  subFlex:   number;  // CSS flex-grow ratio for the sub panel
}

export interface LayoutDef {
  id:       LayoutId;
  label:    string;
  channels: number;           // max camera feeds to display
  slots:    number;           // total grid cells (may include one empty for 5-chan 3×2)
  featured: false | FeaturedSpec;
  cols?:    number;           // columns for equal-grid layouts
  rows?:    number;           // rows for equal-grid layouts
}

export const LAYOUT_DEFS: LayoutDef[] = [
  { id: '1',    label: '1',    channels:  1, slots:  1, featured: false, cols: 1, rows: 1 },
  { id: '2',    label: '2',    channels:  2, slots:  2, featured: false, cols: 2, rows: 1 },
  { id: '4',    label: '4',    channels:  4, slots:  4, featured: false, cols: 2, rows: 2 },
  { id: '1+3',  label: '1+3',  channels:  4, slots:  4, featured: { mainCount: 1, subCols: 1, mainFlex: 3, subFlex: 1 } },
  { id: '5',    label: '5',    channels:  5, slots:  6, featured: false, cols: 3, rows: 2 },
  { id: '1+4',  label: '1+4',  channels:  5, slots:  5, featured: { mainCount: 1, subCols: 1, mainFlex: 3, subFlex: 1 } },
  { id: '8',    label: '8',    channels:  8, slots:  8, featured: false, cols: 4, rows: 2 },
  { id: '1+7',  label: '1+7',  channels:  8, slots:  8, featured: { mainCount: 1, subCols: 2, mainFlex: 3, subFlex: 2 } },
  { id: '9',    label: '9',    channels:  9, slots:  9, featured: false, cols: 3, rows: 3 },
  { id: '12',   label: '12',   channels: 12, slots: 12, featured: false, cols: 4, rows: 3 },
  { id: '1+11', label: '1+11', channels: 12, slots: 12, featured: { mainCount: 1, subCols: 2, mainFlex: 3, subFlex: 2 } },
  { id: '16',   label: '16',   channels: 16, slots: 16, featured: false, cols: 4, rows: 4 },
  { id: '1+15', label: '1+15', channels: 16, slots: 16, featured: { mainCount: 1, subCols: 3, mainFlex: 3, subFlex: 2 } },
  { id: '24',   label: '24',   channels: 24, slots: 24, featured: false, cols: 6, rows: 4 },
  { id: '32',   label: '32',   channels: 32, slots: 32, featured: false, cols: 8, rows: 4 },
  { id: '64',   label: '64',   channels: 64, slots: 64, featured: false, cols: 8, rows: 8 },
  // 2 Main + Sub
  { id: '2+2',  label: '2+2',  channels:  4, slots:  4, featured: { mainCount: 2, subCols: 1, mainFlex: 3, subFlex: 1 } },
  { id: '2+6',  label: '2+6',  channels:  8, slots:  8, featured: { mainCount: 2, subCols: 2, mainFlex: 3, subFlex: 2 } },
  { id: '2+10', label: '2+10', channels: 12, slots: 12, featured: { mainCount: 2, subCols: 2, mainFlex: 3, subFlex: 2 } },
  { id: '2+14', label: '2+14', channels: 16, slots: 16, featured: { mainCount: 2, subCols: 3, mainFlex: 3, subFlex: 2 } },
  // 3 Main + Sub
  { id: '3+5',  label: '3+5',  channels:  8, slots:  8, featured: { mainCount: 3, subCols: 2, mainFlex: 3, subFlex: 2 } },
  { id: '3+9',  label: '3+9',  channels: 12, slots: 12, featured: { mainCount: 3, subCols: 3, mainFlex: 3, subFlex: 2 } },
  { id: '3+13', label: '3+13', channels: 16, slots: 16, featured: { mainCount: 3, subCols: 4, mainFlex: 3, subFlex: 2 } },
];

export const LAYOUT_GROUPS: { label: string; ids: LayoutId[] }[] = [
  { label: 'Equal Grid',   ids: ['1', '2', '4', '5', '8', '9', '12', '16', '24', '32', '64'] },
  { label: '1 Main + Sub', ids: ['1+3', '1+4', '1+7', '1+11', '1+15'] },
  { label: '2 Main + Sub', ids: ['2+2', '2+6', '2+10', '2+14'] },
  { label: '3 Main + Sub', ids: ['3+5', '3+9', '3+13'] },
];

// ─── Layout icon — SVG miniature thumbnail ────────────────────────────────────

export function LayoutIcon({ id, size = 18 }: { id: LayoutId; size?: number }) {
  const def = LAYOUT_DEFS.find((d) => d.id === id)!;
  const gap = 1;

  if (!def.featured) {
    const cols = def.cols!;
    const rows = def.rows!;
    const cw = (size - gap * (cols - 1)) / cols;
    const ch = (size - gap * (rows - 1)) / rows;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
        {Array.from({ length: def.slots }).map((_, i) => {
          const c = i % cols;
          const r = Math.floor(i / cols);
          return (
            <rect
              key={i}
              x={c * (cw + gap)}
              y={r * (ch + gap)}
              width={cw}
              height={ch}
              fill={i < def.channels ? 'currentColor' : '#374151'}
              rx={0.5}
            />
          );
        })}
      </svg>
    );
  }

  // Featured icon: mainCount large cells (left) + sub grid (right)
  const { mainCount = 1, subCols, mainFlex, subFlex } = def.featured;
  const subCount   = def.channels - mainCount;
  const subRows    = Math.ceil(subCount / subCols);
  const totalFlex  = mainFlex + subFlex;
  const mainPanelW = Math.round((size - gap) * mainFlex / totalFlex);
  const subPanelW  = size - mainPanelW - gap;
  const scw = (subPanelW - gap * (subCols - 1)) / subCols;
  const sch = (size - gap * (subRows  - 1)) / subRows;
  // main cells stacked vertically
  const mch = (size - gap * (mainCount - 1)) / mainCount;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      {Array.from({ length: mainCount }).map((_, mi) => (
        <rect
          key={`m${mi}`}
          x={0}
          y={mi * (mch + gap)}
          width={mainPanelW}
          height={mch}
          fill="currentColor"
          rx={0.5}
        />
      ))}
      {Array.from({ length: subCount }).map((_, i) => {
        const c = i % subCols;
        const r = Math.floor(i / subCols);
        return (
          <rect
            key={i}
            x={mainPanelW + gap + c * (scw + gap)}
            y={r * (sch + gap)}
            width={scw}
            height={sch}
            fill="currentColor"
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}

// ─── Single camera cell ───────────────────────────────────────────────────────

interface CellProps {
  camera?:       Camera;
  idx:           number;
  compact:       boolean;  // true → minimal overlays (for 16+ channel grids)
  isSelected:    boolean;
  onDoubleClick: (id: string) => void;
  onSelect:      (id: string) => void;
}

function CameraCell({ camera, idx, compact, isSelected, onDoubleClick, onSelect }: CellProps) {
  if (!camera) {
    // Unassigned channel slot — distinct (dashed border) from an assigned-but-offline
    // camera, which still renders its name/status via CameraView below. See FR-CH-051.
    return (
      <div className="relative bg-gray-800/30 border border-dashed border-gray-700 rounded overflow-hidden flex flex-col items-center justify-center min-h-0 min-w-0 select-none gap-0.5">
        <span className="text-[10px] text-gray-600 font-mono">{idx + 1}</span>
        {!compact && <span className="text-[8px] text-gray-700 uppercase tracking-wide">Unassigned</span>}
      </div>
    );
  }

  return (
    <div
      className={`relative bg-gray-900 rounded overflow-hidden cursor-pointer min-h-0 min-w-0 transition-shadow ${
        isSelected ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-900' : ''
      }`}
      onClick={() => onSelect(camera.id)}
      onDoubleClick={() => onDoubleClick(camera.id)}
      title={`${camera.name} — click: select / double-click: fullscreen`}
    >
      {/* YouTube badge */}
      {camera.type === 'youtube' && (
        <span className="absolute top-1 right-1 bg-red-600 text-white text-[9px] font-bold px-1 py-0.5 rounded-sm z-10 select-none leading-none">
          YT
        </span>
      )}

      {/* YouTube error overlay */}
      {camera.type === 'youtube' && camera.status === 'error' && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center z-20 gap-1">
          <span className="text-red-400 text-[10px] font-bold inline-flex items-center gap-0.5"><AlertTriangle className="w-2.5 h-2.5" /> Error</span>
          {!compact && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await fetch(`/api/youtube-streams/${camera.id}/restart`, { method: 'POST' });
                } catch { /* ignore */ }
              }}
              className="px-2 py-0.5 text-[9px] rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
            >
              Restart
            </button>
          )}
        </div>
      )}

      {/* Camera name label (full mode) or channel index chip (compact mode) */}
      {!compact ? (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-4 pb-0.5 pointer-events-none z-10">
          <span className="text-[9px] text-gray-300 truncate block leading-tight">{camera.name}</span>
        </div>
      ) : (
        <div className="absolute top-0.5 left-0.5 bg-black/50 rounded px-0.5 pointer-events-none z-10 leading-none">
          <span className="text-[7px] text-gray-400">{idx + 1}</span>
        </div>
      )}

      <CameraView cameraId={camera.id} cameraName={camera.name} />
    </div>
  );
}

// ─── CameraGrid ───────────────────────────────────────────────────────────────

interface Props {
  layoutId:             LayoutId;
  onCameraDoubleClick?: (cameraId: string) => void;
  /**
   * 0-based offset into the 1..MAX_CHANNEL_NUM channel-slot space (NOT an array
   * index into `cameras`). Cell N shows whichever camera has
   * `channelSlot === groupStart + N + 1`, or an empty placeholder if none.
   * See docs/design/Design_Channel_Slot.md §5.5/§5.7.
   */
  groupStart?: number;
}

export default function CameraGrid({ layoutId, onCameraDoubleClick, groupStart = 0 }: Props) {
  const cameras      = useCameraStore((s) => s.cameras);
  const selectedId   = useCameraStore((s) => s.selectedId);
  const selectCamera = useCameraStore((s) => s.selectCamera);

  // O(1) channelSlot → camera lookup, rebuilt only when the camera list changes
  // (NFR-CH-53).
  const camerasBySlot = useMemo(() => {
    const m = new Map<number, Camera>();
    for (const c of cameras) if (c.channelSlot != null) m.set(c.channelSlot, c);
    return m;
  }, [cameras]);

  const def     = LAYOUT_DEFS.find((d) => d.id === layoutId) ?? LAYOUT_DEFS[2]; // fallback: 4
  const compact = def.channels >= 16;
  const handleDbl    = (id: string) => onCameraDoubleClick?.(id);
  const handleSelect = (id: string) => selectCamera(selectedId === id ? null : id);

  // ── Equal grid layout ────────────────────────────────────────────────────────
  if (!def.featured) {
    const { cols, rows, slots } = def;
    return (
      <div
        className="w-full h-full gap-1"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows:    `repeat(${rows}, 1fr)`,
        }}
      >
        {Array.from({ length: slots! }).map((_, idx) => {
          const cam = camerasBySlot.get(groupStart + idx + 1);
          return (
            <CameraCell
              key={cam?.id ?? `e-${groupStart + idx}`}
              camera={cam}
              idx={groupStart + idx}
              compact={compact}
              isSelected={cam?.id === selectedId}
              onDoubleClick={handleDbl}
              onSelect={handleSelect}
            />
          );
        })}
      </div>
    );
  }

  // ── Featured layout: mainCount large cells (left) + sub grid (right) ──────────
  const { mainCount = 1, subCols, mainFlex, subFlex } = def.featured;
  const subCount = def.channels - mainCount;
  const subRows  = Math.ceil(subCount / subCols);

  return (
    <div className="flex w-full h-full gap-1">
      {/* Main cameras — stacked vertically on the left */}
      <div
        className="min-h-0 min-w-0 gap-1"
        style={{
          flex: mainFlex,
          display: 'grid',
          gridTemplateColumns: '1fr',
          gridTemplateRows: `repeat(${mainCount}, 1fr)`,
        }}
      >
        {Array.from({ length: mainCount }).map((_, mi) => {
          const cam = camerasBySlot.get(groupStart + mi + 1);
          return (
            <CameraCell
              key={cam?.id ?? `em-${groupStart + mi}`}
              camera={cam}
              idx={groupStart + mi}
              compact={false}
              isSelected={cam?.id === selectedId}
              onDoubleClick={handleDbl}
              onSelect={handleSelect}
            />
          );
        })}
      </div>

      {/* Sub-camera panel — right side grid */}
      <div
        className="min-h-0 min-w-0 gap-1"
        style={{
          flex: subFlex,
          display: 'grid',
          gridTemplateColumns: `repeat(${subCols}, 1fr)`,
          gridTemplateRows:    `repeat(${subRows}, 1fr)`,
        }}
      >
        {Array.from({ length: subCount }).map((_, i) => {
          const cam = camerasBySlot.get(groupStart + mainCount + i + 1);
          return (
            <CameraCell
              key={cam?.id ?? `es-${groupStart + mainCount + i}`}
              camera={cam}
              idx={groupStart + mainCount + i}
              compact={subCount > 7}
              isSelected={cam?.id === selectedId}
              onDoubleClick={handleDbl}
              onSelect={handleSelect}
            />
          );
        })}
      </div>
    </div>
  );
}
