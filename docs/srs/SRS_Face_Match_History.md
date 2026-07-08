# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Face Match History — Persistence, Camera Name, Timeline Integration

| | |
|---|---|
| **Document ID** | SRS-LTS-FMH-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent PRD** | prd/PRD_Face_Match_History.md |
| **Parent RFP** | rfp/RFP_Face_Match_History.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — cameraName Threading](#3-functional-requirements--cameraname-threading)
4. [Functional Requirements — Match History Endpoint](#4-functional-requirements--match-history-endpoint)
5. [Functional Requirements — Face ID Tab](#5-functional-requirements--face-id-tab)
6. [Functional Requirements — Detections Timeline](#6-functional-requirements--detections-timeline)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [Data Requirements](#8-data-requirements)
9. [Interface Requirements](#9-interface-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines verifiable functional requirements (`FR-FMH-NNN`) for making `faceMatchHistory` genuinely retrievable and legible: camera-named, fetchable after a refresh, and visible on the per-camera Detections timeline.

### 1.2 Scope

Covers: `cameraName` field addition to match events; a new read endpoint over `faceMatchHistory`; Face ID tab fetch-on-mount; Detections timeline marker row.

Out of scope: matching pipeline logic itself (`SRS_AI_Face_Recognition.md` §5 already covers `FR-FAC-020`~`FR-FAC-022` for that), any new Socket.IO event.

### 1.3 Definitions

| Term | Definition |
|---|---|
| Match History | The persisted `faceMatchHistory` DB table — one row per emitted `face_match` event (after cooldown suppression) |
| Point Marker | A zero-duration visual marker on a Gantt-style timeline, positioned by a single timestamp rather than a start/end range (established convention in `OnvifTimelineOverlay.tsx`) |

---

## 2. System Overview

```
pipelineManager._assignFaceIds(cameraId, cameraName, detectedFaces, timestamp)
  ├─ matchEvt/matchEvt2 now include cameraName
  ├─ io.emit('face_match', evt) / io.emit('missing_person_match', evt)   — unchanged event names
  └─ db.insert('faceMatchHistory', evt)                                   — unchanged call site

GET /api/galleries/match-history  ── new ──►  db.find('faceMatchHistory', {})

FaceGalleryTab.tsx        ── new fetch-on-mount ──►  GET /api/galleries/match-history?limit=50
DetectionsTimelineInline.tsx ── new fetch ──►  GET /api/galleries/match-history?cameraId=&from=&to=
```

---

## 3. Functional Requirements — cameraName Threading

### FR-FMH-001 — `_assignFaceIds` Signature Change

- `pipelineManager.js`'s `_assignFaceIds(cameraId, detectedFaces, timestamp)` becomes `_assignFaceIds(cameraId, cameraName, detectedFaces, timestamp)`.
- Both existing call sites pass `camera.name || camera.id` as the new second positional argument, using the `camera` object already in scope at each site.

### FR-FMH-002 — `cameraName` on Match Event Objects

- Both `matchEvt` and `matchEvt2` object literals inside `_assignFaceIds` include a `cameraName` field, set from the new parameter, positioned immediately after `cameraId`.
- No other field in either object changes.

### FR-FMH-003 — Automatic Propagation

- `cameraName` requires no separate change at the socket-emit or DB-insert call sites — both already spread the full event object (`{ ...evtForDb }` for the DB row, the object itself for the socket emit).

---

## 4. Functional Requirements — Match History Endpoint

### FR-FMH-010 — `GET /api/galleries/match-history`

- Mounted in `server/src/api/faceGallery.js` alongside the existing `/cross-camera-stats`/`/trajectories` cross-cutting routes (not under a specific gallery `:id`).
- Query params: `limit` (integer, default 50, max 200 — clamp values above 200), `cameraId` (string, exact match), `galleryType` (one of `general|vip|blocklist|missing`, exact match), `from`/`to` (ISO-8601 strings, parsed to epoch ms, inclusive range against the stored `timestamp` field).
- Response: `{ success: true, data: FaceMatchEvent[] }`, sorted descending by `timestamp` (newest first).
- No auth requirement beyond what already applies to sibling `faceGallery.js` routes (none, Phase-2 baseline per `SRS_AI_Face_Recognition.md` §3).

### FR-FMH-011 — Filter Semantics

- All filters are ANDed together when multiple are supplied.
- Omitting a filter param means "no constraint on that dimension," not "match only records missing that field."
- `limit` bounds the OUTPUT size after filtering and sorting, not a pagination cursor — no `offset` param in this version (matches the table's own 5000-row cap; full pagination is unnecessary at this scale).

---

## 5. Functional Requirements — Face ID Tab

### FR-FMH-020 — Fetch on Mount

- `FaceGalleryTab.tsx` calls `GET /api/galleries/match-history?limit=50` in a `useEffect` that runs once on mount, seeding `matchLog`/`matchLogRef` before (or independent of) the existing socket-listener effect.
- The live `socket.on('face_match', ...)` listener continues to prepend new events exactly as before — the two data sources are not deduplicated by ID (the socket payload has no persisted-row `id`); a narrow duplicate-display window around the exact moment of mount is an accepted, documented tradeoff (see C-01).

### FR-FMH-021 — Camera Name Display Fallback Chain

- Render order for each match log entry's camera label: `ev.cameraName` (if present) → `useCameraStore` lookup of `ev.cameraId` against the currently-loaded camera list → raw `ev.cameraId` (final fallback, e.g. for a since-deleted camera).

---

## 6. Functional Requirements — Detections Timeline

### FR-FMH-030 — Match History Fetch, Scoped to Camera + Range

- `DetectionsTimelineInline.tsx` fetches `GET /api/galleries/match-history?cameraId={current}&from={viewStart}&to={viewEnd}&limit=200` using the same range-derived params already driving its existing `detection-tracks` fetch (same dependency array / refetch triggers).

### FR-FMH-031 — Dedicated "Face Matches" Row

- A single row labeled "🔍 Face Matches" renders above the per-object track rows whenever `matches.length > 0` for the current camera+range.
- Each match renders as a diamond point-marker (rotated-45°-square `<div>`, no width — reusing `OnvifTimelineOverlay.tsx`'s existing point-event visual convention) positioned at `left: ((timestamp - viewStart) / viewSpan) * 100%`.
- Marker color is derived from `galleryType` via `GALLERY_TYPE_META` (`client/src/utils/galleryTypeMeta.ts`) — the same mapping used in the Face ID tab, for visual consistency across the two surfaces.

### FR-FMH-032 — Click-to-Reveal Thumbnail

- Clicking a marker opens a small local popover (independent of the existing `selected`/`zoomedSnap` track-detail state) showing the match's thumbnail, `identity`, `matchScore`, and formatted timestamp.

---

## 7. Non-Functional Requirements

### FR-FMH-040 — No New Persistence Layer

- No new DB table, no new `ALL_TABLES`/`mongoDbService.js`/`installDb.js` registration — `faceMatchHistory` is already fully provisioned in both `DB_TYPE` backends.

### FR-FMH-041 — Query Performance

- `GET /api/galleries/match-history` operates on an in-memory `db.find()` over a table capped at 5000 rows — filter/sort/slice cost is bounded and requires no new indexing strategy beyond what `faceMatchHistory` already has (`installDb.js`'s existing `{cameraId, createdAt}` index, per prior research).

---

## 8. Data Requirements

### 8.1 `FaceMatchEvent` — Added Field

```typescript
export interface FaceMatchEvent {
  faceId:        string;
  cameraId:      string;
  cameraName?:   string;   // NEW — optional: absent on rows persisted before this feature shipped
  identity:      string;
  galleryId:     string;
  galleryType:   GalleryType;
  matchScore:    number;
  thumbnail:     string;
  liveCropData?: string;
  timestamp:     number;
}
```

### 8.2 `GET /api/galleries/match-history` Response

```json
{
  "success": true,
  "data": [
    {
      "faceId": "F7", "cameraId": "cam-01", "cameraName": "TNO-C3020T",
      "identity": "Kim Minsu", "galleryId": "gallery-uuid", "galleryType": "missing",
      "matchScore": 0.872, "thumbnail": "data:image/jpeg;base64,...", "timestamp": 1748239140000
    }
  ]
}
```

---

## 9. Interface Requirements

### 9.1 REST API Summary

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-FMH-010 | GET | `/api/galleries/match-history` | Query persisted face match history — `limit`, `cameraId`, `galleryType`, `from`, `to` |

### 9.2 Socket.IO Events

No new events. `face_match` / `missing_person_match` (`SRS_AI_Face_Recognition.md` §11.2) gain an additive `cameraName` field only.

---

## 10. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | A narrow duplicate-display window is possible if a live `face_match` socket event arrives in the same instant as the mount-time history fetch completes — not deduplicated by ID since the socket payload carries no persisted-row identifier. Accepted as a cosmetic, self-resolving edge case (the 50-entry cap and 30s cooldown make it exceedingly rare and harmless) |
| C-02 | Rows persisted before this feature ships lack `cameraName` — client-side fallback (FR-FMH-021) covers display; the endpoint does not backfill or synthesize it server-side |
| C-03 | The Detections timeline's "Face Matches" row is independent of the per-object track rows — a match is never joined onto a specific person's Gantt bar by `objectId`/time-overlap, so it can never be silently hidden by falling outside a track's fetched window |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — SRS for Face Match History |
