# DESIGN DOCUMENT
# Face Match History — Persistence, Camera Name, Timeline Integration

| | |
|---|---|
| **Document ID** | DESIGN-LTS-FMH-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Author** | LTS-2026 Engineering |

---

## Table of Contents

1. [Overview](#1-overview)
2. [cameraName Threading](#2-cameraname-threading)
3. [Match History Endpoint](#3-match-history-endpoint)
4. [Face ID Tab Fetch-on-Mount](#4-face-id-tab-fetch-on-mount)
5. [Detections Timeline Face Matches Row](#5-detections-timeline-face-matches-row)
6. [File Change Summary](#6-file-change-summary)

---

## 1. Overview

Implementation design for [PRD_Face_Match_History.md](../prd/PRD_Face_Match_History.md) / [SRS_Face_Match_History.md](../srs/SRS_Face_Match_History.md). Extends [Design_AI_Face_Recognition.md](Design_AI_Face_Recognition.md) (the `faceMatchHistory` write path already documented there) and reuses the point-event marker convention from [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md).

Root cause recap: the write path (`pipelineManager.js:697`, `:1700`) already works in both `DB_TYPE` modes — the gap is entirely read-side (no endpoint, no client fetch) plus one missing field (`cameraName`, never threaded into `_assignFaceIds`).

---

## 2. cameraName Threading

```js
// Before
_assignFaceIds(cameraId, detectedFaces, timestamp) { ... }
// Call site A (pipelineManager.js:668, local/combined path — camera already in scope)
this._assignFaceIds(camera.id, detectedFaces, timestamp);
// Call site B (pipelineManager.js:1678, _processRemoteResult — camera is the method's 3rd param)
this._assignFaceIds(_cameraId, remoteFaces, _ts);

// After
_assignFaceIds(cameraId, cameraName, detectedFaces, timestamp) { ... }
this._assignFaceIds(camera.id, camera.name || camera.id, detectedFaces, timestamp);
this._assignFaceIds(_cameraId, camera.name || camera.id, remoteFaces, _ts);
```

Inside the function, both match-event object literals (`matchEvt2` at `:2009-2018`, `matchEvt` at `:2056-2065`) gain one line each:
```js
const matchEvt = {
  faceId:      newId,
  cameraId,
  cameraName,          // NEW
  identity:    namedMatch.name,
  ...
};
```

No other function in `pipelineManager.js` needs to change — `cameraName` reaches the socket emit and the `faceMatchHistory` insert purely because both already spread the full event object (`_io.emit('face_match', fullEvt)`, `_db.insert('faceMatchHistory', { ...evtForDb, ... })`).

---

## 3. Match History Endpoint

`server/src/api/faceGallery.js`, added alongside the existing `/cross-camera-stats`/`/trajectories` routes:

```js
// GET /api/galleries/match-history?limit=50&cameraId=&galleryType=&from=&to=
router.get('/match-history', (req, res) => {
  try {
    const limit       = Math.min(200, parseInt(req.query.limit) || 50);
    const cameraId    = req.query.cameraId    ? String(req.query.cameraId)    : null;
    const galleryType = req.query.galleryType ? String(req.query.galleryType) : null;
    const fromTs      = req.query.from ? new Date(String(req.query.from)).getTime() : null;
    const toTs        = req.query.to   ? new Date(String(req.query.to)).getTime()   : null;

    let matches = db.all('faceMatchHistory');
    if (cameraId)    matches = matches.filter(m => m.cameraId === cameraId);
    if (galleryType) matches = matches.filter(m => m.galleryType === galleryType);
    if (fromTs)      matches = matches.filter(m => (m.timestamp || 0) >= fromTs);
    if (toTs)        matches = matches.filter(m => (m.timestamp || 0) <= toTs);

    matches.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json({ success: true, data: matches.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
```

Placed before the `/:id` and `/:id/faces` routes in the router (Express matches routes in registration order, and `/match-history` would otherwise be swallowed by `/:id` if registered after it — same reason `/cross-camera-stats` and `/trajectories` are already registered as their own literal paths rather than under a param).

---

## 4. Face ID Tab Fetch-on-Mount

`FaceGalleryTab.tsx`:

```tsx
useEffect(() => {
  fetch(`${API}/match-history?limit=50`)
    .then(r => r.json())
    .then(body => {
      if (!body.success) return;
      matchLogRef.current = body.data;
      setMatchLog(body.data);
    })
    .catch(() => {});
}, []);
```
Runs once, independent of the existing `socket.on('face_match', ...)` effect (`:279-289`) — the socket listener continues to `[newEvent, ...matchLogRef.current].slice(0, 50)` exactly as today, now prepending onto a non-empty seeded list instead of an empty one.

Camera name render fix (`:174`):
```tsx
const cameras = useCameraStore(s => s.cameras);
const cameraName = ev.cameraName
  ?? cameras.find(c => c.id === ev.cameraId)?.name
  ?? ev.cameraId;
...
<div className="text-[9px] text-gray-500 truncate">{cameraName} · {formatTime(ev.timestamp)}</div>
```

---

## 5. Detections Timeline Face Matches Row

`DetectionsTimelineInline.tsx` gains a parallel fetch (same `params`/range dependency array already driving the existing `detection-tracks` `useEffect`):

```tsx
const [matches, setMatches] = useState<FaceMatchEvent[]>([]);
useEffect(() => {
  const params = new URLSearchParams({ cameraId, from: rangeFrom, to: rangeTo, limit: '200' });
  fetch(`/api/galleries/match-history?${params}`)
    .then(r => r.json())
    .then(d => setMatches(d.success ? d.data : []));
}, [cameraId, rangeFrom, rangeTo]);
```

Rendered as one dedicated row, positioned above the `visibleTracks.map(...)` loop (`:494`), reusing the same `ROW_H`/label-column layout constants those rows use:

```tsx
{matches.length > 0 && (
  <div className="flex" style={{ height: ROW_H }}>
    <div style={{ width: LABEL_W }} className="text-[10px] text-gray-400 px-2 flex items-center">🔍 Face Matches</div>
    <div className="flex-1 relative overflow-hidden" style={{ height: ROW_H }}>
      {matches.map(m => {
        const ts  = m.timestamp;
        const pct = ((ts - viewStart) / viewSpan) * 100;
        if (pct < 0 || pct > 100) return null;
        const color = GALLERY_TYPE_META[m.galleryType].badgeClass; // reuse existing color mapping
        return (
          <div key={`${m.faceId}-${ts}`}
               className="absolute cursor-pointer"
               style={{ left: `${pct}%`, top: BAR_TOP + BAR_H / 2 - 7, width: 14, height: 14,
                        transform: 'translateX(-50%) rotate(45deg)', zIndex: 5 }}
               title={`${m.identity} — ${(m.matchScore * 100).toFixed(0)}%`}
               onClick={() => setSelectedMatch(m)}
          />
        );
      })}
    </div>
  </div>
)}
{selectedMatch && (
  <div className="absolute ... popover">
    <img src={selectedMatch.thumbnail} />
    <p>{selectedMatch.identity} — {(selectedMatch.matchScore * 100).toFixed(0)}%</p>
    <p>{new Date(selectedMatch.timestamp).toLocaleString()}</p>
  </div>
)}
```

This mirrors `OnvifTimelineOverlay.tsx`'s existing `isPoint` diamond-marker rendering (`transform: rotate(45deg)`, fixed 14×14 size, single `left` position, no `width` range) — no new visual convention is invented. `selectedMatch` is a small independent piece of local state, deliberately not merged into the existing `selected`/`zoomedSnap` track-detail state machine to avoid touching that already-large component's state shape.

---

## 6. File Change Summary

| File | Type | Purpose |
|---|---|---|
| `server/src/services/pipelineManager.js` | Modified | `_assignFaceIds` signature + 2 call sites + 2 object literals — `cameraName` |
| `server/src/api/faceGallery.js` | Modified | `GET /match-history` |
| `client/src/types/index.ts` | Modified | `FaceMatchEvent.cameraName?` |
| `client/src/components/FaceGalleryTab.tsx` | Modified | Fetch-on-mount, camera name fallback chain |
| `client/src/components/DetectionsTimelineInline.tsx` | Modified | Matches fetch, Face Matches row, click popover |
| `test/api/face_match_history.test.js` | New | Fills the pre-existing "📋 planned" slot in `docs/README.md` |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-08 | 초기 작성 — cameraName 전파, match-history 조회 엔드포인트, Face ID 탭 마운트 시 조회, Detections 타임라인 Face Matches 행 설계 |
