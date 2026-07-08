# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Face Match History — Persistence, Camera Name, Timeline Integration

| | |
|---|---|
| **Document ID** | PRD-LTS-FMH-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Related RFP** | RFP_Face_Match_History.md (LTS-2026-FMH-01) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [Input / Output Contract](#6-input--output-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

A face match, once recorded, must remain a durable, human-readable, and time-correlated fact of the system — reachable whether the operator is looking at the live Face ID feed, reloading that page later, or reviewing a specific camera's Fullscreen history. The underlying write already happens correctly; this feature makes it actually retrievable and legible.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- `GET /api/galleries/match-history` exposes the already-persisted `faceMatchHistory` table with `limit`/`cameraId`/`galleryType`/`from`/`to` filters.
- `pipelineManager._assignFaceIds()` includes `cameraName` in every match event it builds, so it flows into the socket payload and the DB row for free.
- `FaceGalleryTab.tsx` seeds its Live Matches list from that endpoint on mount, so a refresh doesn't lose recent history.
- `DetectionsTimelineInline.tsx` renders a dedicated "Face Matches" row with point markers, reusing the existing `OnvifTimelineOverlay.tsx` diamond-marker convention.

### 2.2 Non-Goals

- No change to matching thresholds, cooldown, or the `face_match`/`missing_person_match` event names.
- No backfill of `cameraName` onto rows written before this ships.
- No attempt to join a face-match marker onto a specific person's Gantt bar by `objectId`/time-overlap — a dedicated row is used instead (simpler, never drops an out-of-window match).

---

## 3. User Personas

**Security Operator** — watches the Face ID tab's Live Matches panel; expects it to still show recent history after an accidental refresh or tab restart, with a real camera name instead of an ID.

**Security Administrator / Investigator** — opens a specific camera's Fullscreen view after an incident to correlate a face match with that camera's broader detection activity on one shared timeline.

---

## 4. Functional Specification

### 4.1 `cameraName` Threading

```
_assignFaceIds(cameraId, cameraName, detectedFaces, timestamp)   // cameraName param added
  ├─ matchEvt  = { faceId, cameraId, cameraName, identity, galleryId, galleryType, matchScore, thumbnail, timestamp }
  └─ matchEvt2 = { faceId, cameraId, cameraName, identity, galleryId, galleryType, matchScore, thumbnail, timestamp }
```
Both call sites (`pipelineManager.js:668` local/combined path, `:1678` `_processRemoteResult` streaming path) already have the full `camera` object in scope — they pass `camera.name || camera.id` as the new second argument.

### 4.2 `GET /api/galleries/match-history`

```
GET /api/galleries/match-history?limit=50&cameraId=&galleryType=&from=&to=
  → db.find('faceMatchHistory', {})
  → filter by cameraId / galleryType / from / to (epoch-ms comparison against stored timestamp)
  → sort desc by timestamp
  → slice(0, limit)
  → { success: true, data: FaceMatchEvent[] }
```

### 4.3 Face ID Tab — Fetch on Mount

`FaceGalleryTab.tsx` gains a mount-time `useEffect` that calls the endpoint above with `limit=50` and seeds `matchLog`/`matchLogRef`, independent of (and running before) the existing `socket.on('face_match', ...)` listener. Camera name rendering falls back through: `ev.cameraName` → `useCameraStore` lookup by `ev.cameraId` → raw `ev.cameraId`.

### 4.4 Detections Timeline — Face Matches Row

`DetectionsTimelineInline.tsx` fetches `GET /api/galleries/match-history?cameraId=&from=&to=&limit=200` alongside its existing detection-tracks fetch (same range/params dependencies). Results render as a dedicated row above the per-object track rows: a diamond marker (rotated-45°-square, matching `OnvifTimelineOverlay.tsx`'s existing point-event style) at each match's timestamp, colored by `galleryType` via the shared `GALLERY_TYPE_META` (`client/src/utils/galleryTypeMeta.ts`). Clicking a marker opens a small popover with the thumbnail, identity, match score, and time.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| No new DB table | Reuses `faceMatchHistory` (`ALL_TABLES`, 5000-row cap, unchanged) |
| No new Socket.IO event | `cameraName` is additive on `face_match`/`missing_person_match` |
| Query style | Matches `faceGallery.js`'s existing `parseInt(req.query.x) || default` / in-memory `.filter().sort()` conventions — no new query-building abstraction |
| Marker rendering | Reuses the `isPoint` diamond-marker visual pattern already established in `OnvifTimelineOverlay.tsx` — no new marker convention invented |

---

## 6. Input / Output Contract

**`GET /api/galleries/match-history` response:**
```json
{
  "success": true,
  "data": [
    {
      "faceId": "F7",
      "cameraId": "cam-01",
      "cameraName": "TNO-C3020T",
      "identity": "Kim Minsu",
      "galleryId": "gallery-uuid",
      "galleryType": "missing",
      "matchScore": 0.872,
      "thumbnail": "data:image/jpeg;base64,...",
      "timestamp": 1748239140000
    }
  ]
}
```

**`face_match` / `missing_person_match` Socket.IO payload (additive field only):**
```json
{
  "faceId": "F7", "cameraId": "cam-01", "cameraName": "TNO-C3020T",
  "identity": "Kim Minsu", "galleryId": "gallery-uuid", "galleryType": "missing",
  "matchScore": 0.872, "thumbnail": "data:image/jpeg;base64,...", "timestamp": 1748239140000
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Endpoint returns persisted history | `GET /api/galleries/match-history` returns previously-recorded matches, newest first |
| AC-02 | `limit`/`cameraId`/`galleryType`/`from`/`to` filters work | Each filter narrows the result set correctly, verified independently |
| AC-03 | `cameraName` present on new matches | A match recorded after this ships includes a non-empty `cameraName` matching the camera's configured name |
| AC-04 | Face ID tab survives refresh | Reloading the page shows the same recent matches that were visible before reload |
| AC-05 | Camera name shown, not raw ID | Live Matches entries display `cameraName` (or a store-resolved fallback), not the bare camera ID, for any camera still configured |
| AC-06 | Detections timeline shows matches | Opening a camera's Fullscreen → Detections tab shows a marker for each face match recorded against that camera within the visible range |
| AC-07 | Marker reveals thumbnail | Clicking a face-match marker shows the matched face's thumbnail, identity, and score |
| AC-08 | No regression to matching pipeline | `face_match`/`missing_person_match` emission rate, cooldown, and payload shape (aside from the additive field) are unchanged |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Status |
|---|---|---|
| M1 | `cameraName` threading through `_assignFaceIds` | ⏳ In progress |
| M2 | `GET /api/galleries/match-history` endpoint | ⏳ In progress |
| M3 | Face ID tab fetch-on-mount + camera name display | ⏳ In progress |
| M4 | Detections timeline Face Matches row | ⏳ In progress |
| M5 | `test/api/face_match_history.test.js` + SUITES registration | ⏳ In progress |

### 8.2 TODO

- [ ] `pipelineManager.js` — `_assignFaceIds` signature + both call sites + both `matchEvt`/`matchEvt2` literals
- [ ] `faceGallery.js` — `GET /match-history`
- [ ] `client/src/types/index.ts` — `FaceMatchEvent.cameraName?`
- [ ] `FaceGalleryTab.tsx` — fetch-on-mount, camera name fallback chain
- [ ] `DetectionsTimelineInline.tsx` — matches fetch, Face Matches row, click popover
- [ ] `test/api/face_match_history.test.js` (fills the pre-existing "📋 planned" slot in `docs/README.md`)

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — PRD for Face Match History |
