# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Dashboard Sidebar — Face ID Panel

| | |
|---|---|
| **Document ID** | PRD-LTS-013 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Related RFP** | rfp/RFP_Dashboard_Sidebar_Face_ID.md (LTS-2026-013 v1.1) |

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [UI/UX Requirements](#5-uiux-requirements)
6. [Technical Requirements](#6-technical-requirements)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)
9. [v1.1 Amendment — Live Match Crop & Search](#9-v11-amendment--live-match-crop--search)

---

## 1. Product Vision

The Face ID panel gives security operators a single, always-accessible control surface for **person enrollment and real-time identification** without leaving the dashboard. Operators can register persons of interest (missing persons, VIPs, suspects) by uploading a photo, and the system will instantly alert them when any enrolled person appears in any live camera feed.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Provide a sidebar tab (`faces`) that hosts the full face gallery management workflow.
- Support four named gallery types with distinct visual priority: **missing** (highest, pulsing alert) > **vip** > **blocklist** > **general**.
- Allow face enrollment via drag-drop or click-to-upload photo; server handles SCRFD detection and ArcFace embedding extraction automatically.
- Display real-time match events in a scrollable log with color-coded rows by gallery type.
- Trigger a prominent flashing banner whenever a **missing-person** match occurs.
- Persist all named gallery data in JSON storage; survive server restarts without re-enrollment.

### 2.2 Non-Goals

- Bulk face import via ZIP archive (deferred to Phase-2).
- Manual embedding vector override or re-training (deferred to Phase-3).
- Server-side push notification (email / SMS) on match events (out of scope for this module).

---

## 3. User Personas

**Security Operator** — Registers missing persons or suspects by uploading photos. Monitors the match log during a shift to identify persons of interest on live feeds.

**Security Manager** — Creates and maintains VIP galleries for access-control events. Reviews match history for incident reports.

**IT Administrator** — Ensures face model files are downloaded and loaded on the server. Monitors `storage/face_tracking.json` for trajectory data integrity.

---

## 4. Functional Specification

### 4.1 Gallery Type System

Four named gallery types are supported, processed in priority order:

| Priority | Type | Icon | Trigger |
|---|---|---|---|
| 1 (highest) | `missing` | 🔍 | `missing_person_match` Socket.IO event + banner |
| 2 | `vip` | ⭐ | `face_match` event, yellow log row |
| 3 | `blocklist` | 🚫 | `face_match` event, orange log row |
| 4 | `general` | 🗃 | `face_match` event, gray log row |

### 4.2 Gallery CRUD

| Operation | Trigger | API |
|---|---|---|
| Create | `[+ Create]` button after entering name + selecting type | `POST /api/galleries` |
| Expand/Collapse | Click gallery row | Client-side state toggle |
| Delete | `✕` on gallery row (confirms via browser `confirm()`) | `DELETE /api/galleries/:id` |
| List | On tab mount | `GET /api/galleries` |

### 4.3 Face Enrollment

1. Operator selects a gallery (expands it by clicking).
2. Drops or selects a JPEG/PNG/WebP photo in the upload area.
3. Enters person name (defaults to `"Unknown"` if left blank).
4. Clicks **[Enroll]** → multipart `POST /api/galleries/:id/faces`.
5. Server processes: SCRFD detection → ArcFace embedding → thumbnail generation.
6. On success: upload area resets; face card appears; gallery face count increments.
7. On error (no face / model unavailable): error text shown in red.

### 4.4 Face Deletion

- Hover over a face card → `✕` button appears in top-right corner.
- Click `✕` → `DELETE /api/galleries/:id/faces/:faceId`.
- Face card removed from UI immediately (optimistic update).
- Gallery face count decremented.

### 4.5 Real-Time Match Log

- Listens to Socket.IO `face_match` events on the global `__ltsSocket`.
- Each event prepended to `matchLog` state (max 50 entries).
- Displayed newest-first with color-coded rows.
- Latest `missing`-type event drives the flashing alert banner.

### 4.6 Missing Person Alert Banner

- Shown at top of panel (above gallery list) when `matchLog` contains any `galleryType === 'missing'` entry.
- Red background, pulsing animation, shows name + similarity% + camera ID.
- Remains visible until the match log no longer contains a `missing` event.

---

## 5. UI/UX Requirements

### 5.1 Visual Hierarchy

- Missing section: distinct red-tinted section header with pulsing dot; `hover:bg-red-950/30` rows.
- Gallery rows: left border color-coded by type; selected gallery shows colored border.
- Match log rows: background and border color by gallery type.
- Missing person banner: full-width, above all content, `animate-pulse`.

### 5.2 Typography

- Panel header: `text-sm font-bold text-white`
- Section headers: `text-[8px] uppercase tracking-wide font-bold`
- Gallery name: `text-[10px] font-medium`
- Face card name: `text-[9px]`, `max-w-[56px]`, truncated
- Match log: `text-[10px]` for person name, `text-[9px]` for metadata

### 5.3 Scrolling Behavior

- Gallery list: flows with the sidebar's `overflow-y-auto` scroll container.
- Face card grid: expands inline; no fixed max height.
- Match log: `max-h-48 overflow-y-auto` — scrolls independently.

### 5.4 Loading States

- `[Enroll]` button shows `{t.faceEnrolling}` text and is `disabled` during enrollment request.
- Gallery face list shows no loading spinner (silently loads).

### 5.5 Empty States

| Situation | Display |
|---|---|
| No galleries created | `👤 No galleries` centered in content area |
| Gallery has no enrolled faces | `👤 No faces` centered below UploadArea |
| No match events yet | `👁 No matches yet` |

---

## 6. Technical Requirements

### 6.1 AI Models Required

| Model | File | Purpose |
|---|---|---|
| SCRFD-2.5GF | `server/models/scrfd_2.5g.onnx` | Face detection (bounding box + landmarks) |
| ArcFace ResNet-50 | `server/models/arcface_w600k_r50.onnx` | 512-dim face embedding extraction |

If model files are not present, enrollment returns HTTP 503. Gallery CRUD and match log remain functional.

### 6.2 Similarity Threshold

- Face match threshold: **cosine similarity ≥ 0.35** (configurable in `pipelineManager.js` constant `FACE_MATCH_THRESH`).
- Named gallery match threshold: same (shared constant).

### 6.3 Persistence Architecture

| Data | Storage | Key |
|---|---|---|
| Gallery metadata | `storage/lts.json` → `faceGalleries` table | `id` (UUID) |
| Face records + embeddings + thumbnails | `storage/lts.json` → `faceGalleryFaces` table | `id` (UUID) |
| Person trajectory state | `storage/face_tracking.json` | `faceId` |

`db.js` (custom JSON DB) provides `find`, `create`, `update`, `delete`, `persist` methods. Writes are synchronous file writes to prevent data loss on crash.

### 6.4 Socket.IO Integration

The client uses a globally injected `window.__ltsSocket` reference set in `App.tsx`. `FaceGalleryTab` subscribes to `face_match` on mount and unsubscribes on unmount via the `useEffect` cleanup.

### 6.5 REST Endpoint Implementation

| File | Endpoints |
|---|---|
| `server/src/api/faceGallery.js` | All 6 gallery/face endpoints |
| `server/src/index.js` | Registers `/api/galleries` router + calls `reloadPersistentGallery()` after enrollment/deletion |

### 6.6 Image Processing

- `multer` (memory storage, 10 MB limit) handles multipart upload.
- `sharp` normalizes uploaded image to JPEG before passing to SCRFD.
- Server generates 96×96 JPEG thumbnail stored as base64 data URI in DB.

---

## 7. Acceptance Criteria

| # | Criterion |
|---|---|
| AC-1 | Face ID tab visible in sidebar; clicking switches content to `FaceGalleryTab` |
| AC-2 | Gallery can be created with any of the 4 type options and persists after browser refresh |
| AC-3 | A face with a valid JPEG photo can be enrolled; face card appears with thumbnail and name |
| AC-4 | Enrollment of a photo with no detectable face returns an error message |
| AC-5 | Face card delete removes the card and decrements the gallery count |
| AC-6 | Gallery delete removes the gallery and all its face cards |
| AC-7 | `face_match` Socket.IO event causes a new row to appear in the match log within 1 s |
| AC-8 | Missing-person match triggers the red pulsing banner |
| AC-9 | After server restart, all enrolled galleries and faces are still present |
| AC-10 | Person trajectory alias counter (`P1`, `P2`…) continues from persisted value after restart |
| AC-11 | *(v1.1)* `face_match` event payload contains `liveCropData` (non-null base64 string when crop succeeds) |
| AC-12 | *(v1.1)* MatchLog entry shows enrolled photo AND live crop side-by-side |
| AC-13 | *(v1.1)* Each match event is persisted to `faceMatchHistory` table |
| AC-14 | *(v1.1)* `GET /api/search?q=John&types=matches` returns match entries for identity "John" |
| AC-15 | *(v1.1)* SearchBar result click for type `match` navigates to the `faces` sidebar tab |

---

## 8. Milestones & TODO

| Milestone | Status |
|---|---|
| `FaceGalleryTab.tsx` UI implementation | ✅ Complete |
| `faceGallery.js` REST API | ✅ Complete |
| `faceService.js` SCRFD + ArcFace ONNX pipeline | ✅ Complete (models optional) |
| Gallery + face persistence in `lts.json` | ✅ Complete |
| Person trajectory persistence in `face_tracking.json` | ✅ Complete |
| i18n keys for all 15 languages | ✅ Complete |
| **v1.1: Live face crop in `face_match` event** | ⏳ This sprint |
| **v1.1: `faceMatchHistory` DB table + persistence** | ⏳ This sprint |
| **v1.1: `GET /api/search?types=matches` endpoint** | ⏳ This sprint |
| **v1.1: MatchLog dual-photo layout** | ⏳ This sprint |
| **v1.1: SearchBar `match` result type** | ⏳ This sprint |
| Bulk face import (ZIP) | ⏳ Phase-2 |
| Gallery export / import | ⏳ Phase-3 |

---

## 9. v1.1 Amendment — Live Match Crop & Search

### 9.1 Feature: Live Crop in Match Log

**Problem**: The v1.0 MatchLog shows only the enrolled gallery photo. Operators have no live visual evidence of the detected face, making it harder to verify false positives at a glance.

**Solution**: For every `face_match` event, the server crops the detected face's bounding box from the live JPEG frame buffer and attaches the result as `liveCropData`. The client then renders both thumbnails side-by-side.

#### 9.1.1 Server Implementation — `_assignFaceIds` Refactor

`_assignFaceIds(cameraId, detectedFaces, timestamp)` is refactored to:
1. Collect match events into `pendingMatchEvents[]` instead of calling `this._io.emit('face_match', ...)` directly.
2. Return `{ faces, crossCameraTransitions, pendingMatchEvents }`.

In the outer `capture.on('frame', ...)` handler, after `_assignFaceIds` returns:
```js
setImmediate(async () => {
  for (const { evt, faceBbox } of pendingMatchEvents) {
    let liveCropData;
    try {
      const { data: cropBuf } = await snapshotSvc.cropJpeg(jpegBuffer, faceBbox, frameWidth, frameHeight);
      liveCropData = 'data:image/jpeg;base64,' + cropBuf.toString('base64');
    } catch (_) { /* fallback: no liveCropData */ }
    const fullEvt = { ...evt, ...(liveCropData ? { liveCropData } : {}) };
    this._io.emit('face_match', fullEvt);
    if (fullEvt.galleryType === 'missing') this._io.emit('missing_person_match', fullEvt);
    // Persist
    this._db.insert('faceMatchHistory', { id: uuidv4(), ...fullEvt, createdAt: new Date(evt.timestamp).toISOString() });
  }
});
```

#### 9.1.2 Client Implementation — MatchLog Dual Photo

`FaceMatchEvent` TypeScript interface gains `liveCropData?: string`.

`MatchLog` row layout changes from:
```
[enrolled_photo] [badge] [name] [score] [meta]
```
to:
```
[enrolled_photo] [live_crop] [badge] [name] [score] [meta]
```

Both images rendered as 28×28 (`w-7 h-7`). `live_crop` falls back to a grey placeholder icon (`👤`) if absent.

### 9.2 Feature: Face Match History & SearchBar

**Problem**: Match events are lost on page refresh; there is no way to search past recognition events.

**Solution**: Persist each `face_match` event in the `faceMatchHistory` DB table. Extend `GET /api/search?types=matches` to search this table.

#### 9.2.1 `faceMatchHistory` Table Schema

| Field | Type | Description |
|---|---|---|
| `id` | UUID string | Primary key |
| `faceId` | string | Live gallery face ID |
| `cameraId` | UUID string | Source camera |
| `identity` | string | Enrolled person name |
| `galleryId` | UUID string | Matched gallery |
| `galleryType` | GalleryType | Gallery type |
| `matchScore` | number | Cosine similarity (0–1) |
| `thumbnail` | string | base64 JPEG enrolled photo |
| `liveCropData` | string | base64 JPEG live crop (may be absent) |
| `timestamp` | number | Event Unix ms |
| `createdAt` | ISO string | Record creation time |

#### 9.2.2 Search API Extension

`GET /api/search?q=<query>&types=matches` returns results shaped as:
```json
{
  "_type": "match",
  "id": "...",
  "identity": "John Doe",
  "galleryType": "vip",
  "matchScore": 0.91,
  "cameraId": "...",
  "timestamp": 1748343600000,
  "thumbnail": "...",
  "liveCropData": "..."
}
```

SearchBar result click for `_type: 'match'` sets the active sidebar tab to `'faces'`.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Dashboard Sidebar Face ID |
