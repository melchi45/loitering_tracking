# DESIGN DOCUMENT
# Face Match → Detections Timeline Navigation

| | |
|---|---|
| **Document ID** | DESIGN-LTS-FMN-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Author** | LTS-2026 Engineering |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prop Threading](#2-prop-threading)
3. [Timeline Centering Effects](#3-timeline-centering-effects)
4. [Scrollbar Layout Fix](#4-scrollbar-layout-fix)
5. [File Change Summary](#5-file-change-summary)

---

## 1. Overview

Implementation design for [PRD_Face_Match_Timeline_Navigation.md](../prd/PRD_Face_Match_Timeline_Navigation.md) / [SRS_Face_Match_Timeline_Navigation.md](../srs/SRS_Face_Match_Timeline_Navigation.md). Connects two views built in [Design_Face_Match_History.md](Design_Face_Match_History.md): the Face ID tab's Live Matches list and the Fullscreen Detections timeline's face-match marker row.

No new state-management library or store — the existing `App.tsx` `renderTabContent()` closure and a chain of optional props is sufficient, since `<FaceGalleryTab />` has exactly one render site and `App.tsx` already owns the target (`fullscreenCameraId`) state.

---

## 2. Prop Threading

```tsx
// App.tsx
const [fullscreenCameraId, setFullscreenCameraId] = useState<string | null>(null);
const [focusMatch, setFocusMatch] = useState<{ faceId: string; timestamp: number } | null>(null);

function renderTabContent(overrideTab?: SidebarTab) {
  ...
  if (tab === 'faces') return (
    <FaceGalleryTab
      onFocusMatch={(cameraId, faceId, timestamp) => {
        setFullscreenCameraId(cameraId);
        setFocusMatch({ faceId, timestamp });
      }}
    />
  );
}

{fullscreenCameraId && (() => {
  const cam = cameras.find(c => c.id === fullscreenCameraId);
  return cam ? (
    <FullscreenCameraView
      cameraId={cam.id}
      cameraName={cam.name}
      onClose={() => { setFullscreenCameraId(null); setFocusMatch(null); }}
      initialVideoTab={focusMatch ? 'detections' : undefined}
      initialFocusMatch={focusMatch ?? undefined}
    />
  ) : null;
})()}
```

```tsx
// FaceGalleryTab.tsx
interface FaceGalleryTabProps {
  onFocusMatch?: (cameraId: string, faceId: string, timestamp: number) => void;
}
export default function FaceGalleryTab({ onFocusMatch }: FaceGalleryTabProps) {
  ...
  <MatchLog events={matchLog} t={t} onSelect={onFocusMatch} />
}

function MatchLog({ events, t, onSelect }: { events: FaceMatchEvent[]; t: ...; onSelect?: (cameraId: string, faceId: string, timestamp: number) => void }) {
  ...
  <div key={i} className={...} onClick={() => onSelect?.(ev.cameraId, ev.faceId, ev.timestamp)} style={{ cursor: onSelect ? 'pointer' : undefined }}>
```

```tsx
// FullscreenCameraView.tsx
interface Props {
  cameraId: string;
  cameraName: string;
  onClose: () => void;
  initialVideoTab?: 'events' | 'onvif' | 'detections';
  initialFocusMatch?: { faceId: string; timestamp: number };
}
export default function FullscreenCameraView({ cameraId, cameraName, onClose, initialVideoTab, initialFocusMatch }: Props) {
  const [videoTab, setVideoTab] = useState<'events' | 'onvif' | 'detections'>(initialVideoTab ?? 'onvif');
  ...
  {videoTab === 'detections' && <DetectionsTimelineInline cameraId={cameraId} initialFocusMatch={initialFocusMatch} />}
}
```

---

## 3. Timeline Centering Effects

`DetectionsTimelineInline.tsx`:

```tsx
export default function DetectionsTimelineInline({ cameraId, initialFocusMatch }: {
  cameraId: string;
  initialFocusMatch?: { faceId: string; timestamp: number };
}) {
  ...
  // Effect 1 — land the view on a window around the focused match, once.
  useEffect(() => {
    if (!initialFocusMatch) return;
    const HALF_WINDOW_MS = 30 * 60 * 1000;
    const from = new Date(initialFocusMatch.timestamp - HALF_WINDOW_MS);
    const to   = new Date(initialFocusMatch.timestamp + HALF_WINDOW_MS);
    setRange('custom');
    setCustomStart(toDatetimeLocal(from));
    setCustomEnd(toDatetimeLocal(to));
    setCustomApplied({ from: from.toISOString(), to: to.toISOString() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFocusMatch?.faceId, initialFocusMatch?.timestamp]);

  // Effect 2 — once the (now range-scoped) matches fetch resolves, auto-select the target.
  useEffect(() => {
    if (!initialFocusMatch) return;
    const target = matches.find(m => m.faceId === initialFocusMatch.faceId && m.timestamp === initialFocusMatch.timestamp);
    if (target) setSelectedMatch(target);
  }, [matches, initialFocusMatch]);
```

`toDatetimeLocal(d: Date): string` is a small new helper formatting to the `YYYY-MM-DDTHH:mm` shape the existing `<input type="datetime-local">` custom-range fields already use (`:401,:405`), so the range picker UI shows a consistent, editable window rather than blank inputs.

Both effects key off `initialFocusMatch`'s primitive fields (`faceId`, `timestamp`) rather than the object reference, so a parent re-render that recreates an equal-valued object doesn't re-trigger the range jump.

---

## 4. Scrollbar Layout Fix

Before:
```tsx
<div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
  {/* enrolled faces grid */}
  <MatchLog events={matchLog} t={t} />  {/* MatchLog itself: max-h-48 overflow-y-auto */}
</div>
```

After:
```tsx
<div className="flex-1 min-h-0 flex flex-col px-3 py-2 gap-3">
  <div className="overflow-y-auto">{/* enrolled faces grid, its own scroll region */}</div>
  <div className="flex-1 min-h-0 flex flex-col">
    <MatchLog events={matchLog} t={t} onSelect={onFocusMatch} />  {/* now flex-1 min-h-0 overflow-y-auto internally */}
  </div>
</div>
```

The outer wrapper no longer scrolls itself (`overflow-y-auto` removed, `flex flex-col` added) — it only distributes remaining vertical space between its two children, each of which owns exactly one scroll region sized to what's actually left, instead of a fixed `max-h-48` guessing.

---

## 5. File Change Summary

| File | Type | Purpose |
|---|---|---|
| `client/src/App.tsx` | Modified | `focusMatch` state, `onFocusMatch` wiring, `FullscreenCameraView` prop pass-through |
| `client/src/components/FaceGalleryTab.tsx` | Modified | `onFocusMatch` prop, `MatchLog` click handler, scrollbar layout fix |
| `client/src/components/FullscreenCameraView.tsx` | Modified | `initialVideoTab`/`initialFocusMatch` props |
| `client/src/components/DetectionsTimelineInline.tsx` | Modified | `initialFocusMatch` prop, two effects, `toDatetimeLocal` helper |
| `test/api/face_match_timeline_navigation.test.js` | New | Contract/regression check on the `{faceId,timestamp}` join key and shared `from`/`to` window shape |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-08 | 초기 작성 — Live Match 클릭 → Detections 타임라인 이동/센터링/자동 선택, Face ID 탭 스크롤바 레이아웃 수정 설계 |
