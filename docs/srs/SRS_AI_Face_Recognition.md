# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Face Detection & Recognition

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-03 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Face_Recognition.md |
| **Parent RFP** | rfp/RFP_AI_Face_Recognition.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Gallery Management](#3-functional-requirements--gallery-management)
4. [Functional Requirements — Face Enrollment](#4-functional-requirements--face-enrollment)
5. [Functional Requirements — Live Face Matching](#5-functional-requirements--live-face-matching)
6. [Functional Requirements — Missing Persons Detection](#6-functional-requirements--missing-persons-detection)
7. [Functional Requirements — Cross-Camera Re-ID](#7-functional-requirements--cross-camera-re-id)
8. [Functional Requirements — Face ID UI Tab](#8-functional-requirements--face-id-ui-tab)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Data Requirements](#10-data-requirements)
11. [Interface Requirements](#11-interface-requirements)
12. [Constraints & Assumptions](#12-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the Face Detection & Recognition AI Module of LTS-2026. Each requirement is identified by a unique ID (FR-FAC-NNN) and is directly traceable to test cases in TC_AI_Face_Recognition.md.

### 1.2 Scope

This document covers:
- Gallery lifecycle management (create, list, delete)
- Face enrollment via photo upload (detect → embed → persist)
- Real-time live face matching against persistent galleries
- Missing Persons detection with emergency alert workflow
- Cross-camera face Re-ID and Global Person Registry
- Face ID sidebar tab UI behaviour

Out of scope: face attribute analysis (age/gender), face blur/anonymization, RBAC (Phase-3).

### 1.3 Definitions

| Term | Definition |
|---|---|
| Gallery | A named collection of enrolled face embeddings, typed as `general`, `vip`, `blocklist`, or `missing` |
| GalleryType | TypeScript union: `'general' \| 'vip' \| 'blocklist' \| 'missing'` |
| Enrolled Face | A person record containing a name, 512-D ArcFace embedding, 64×64 thumbnail, and bbox |
| Embedding | 512-dimensional L2-normalized float32 vector produced by ArcFace ResNet-50 |
| Cosine Similarity | Dot product of two L2-normalized vectors — equivalent to cosine distance |
| Shared Gallery | In-memory transient gallery shared across all camera pipelines for cross-camera Re-ID |
| Persistent Gallery | On-disk gallery (`lts.json`) loaded from DB at startup; used for named identity matching |
| Cooldown | 30-second suppression window per `faceId:galleryFaceId` pair for `face_match` events |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP Frame
  └─ AttributePipeline
       ├─ FaceService.detectFaces()    — SCRFD-2.5GF
       ├─ FaceService.getEmbedding()   — ArcFace ResNet-50
       └─ PipelineManager._assignFaceIds()
            ├─ _sharedFaceGallery      — in-memory, cross-camera Re-ID
            ├─ _persistentGallery      — loaded from DB, named matching
            └─ Socket.IO emit          — face_match, missing_person_match, face:reidentified
```

### 2.2 Startup Sequence

```
Server start
  1. webrtcGateway.init()
  2. initDB()                          — load lts.json
  3. PipelineManager constructed
  4. pipelineManager.loadFaceServiceEagerly()   — loads SCRFD + ArcFace ONNX models
  5. pipelineManager.reloadPersistentGallery()  — cache DB faces in _persistentGallery
  6. HTTP server listen on PORT
  7. Cameras auto-start (from DB)
```

---

## 3. Functional Requirements — Gallery Management

### FR-FAC-001 — List Galleries

- **Endpoint:** `GET /api/galleries`
- **Auth:** None (Phase-2; RBAC in Phase-3)
- **Response:** `{ success: true, data: FaceGallery[] }` sorted by `createdAt` descending
- **FaceGallery fields:** `id`, `name`, `description`, `type`, `faceCount`, `createdAt`, `updatedAt`
- **faceCount:** Count of enrolled faces in `faceGalleryFaces` for each gallery
- **Error:** `500` on DB read failure

### FR-FAC-002 — Create Gallery

- **Endpoint:** `POST /api/galleries`
- **Body:** `{ name: string (required), description?: string, type?: GalleryType }`
- **Validation:**
  - `name` must be non-empty after trim → `400 { success: false, error: 'name is required' }`
  - `type` must be one of `['general', 'vip', 'blocklist', 'missing']`; invalid value silently defaults to `'general'`
- **On success:** Inserts `{ id: uuid, name, description, type }` into `faceGalleries` table
- **Response:** `201 { success: true, data: { ...gallery, faceCount: 0 } }`

### FR-FAC-003 — Delete Gallery

- **Endpoint:** `DELETE /api/galleries/:id`
- **Cascade:** All `faceGalleryFaces` records with matching `galleryId` are deleted before gallery deletion
- **Error:** `404` if gallery not found
- **Side effect:** `pipelineManager.reloadPersistentGallery()` must be triggered (to remove deleted faces from matching cache)
- **Response:** `200 { success: true }`

### FR-FAC-004 — Gallery Type Defaults

- If `type` is omitted from `POST /api/galleries`, the created gallery must have `type === 'general'`
- `GET /api/galleries` must return `type` for every gallery record (never `undefined` or `null`)

---

## 4. Functional Requirements — Face Enrollment

### FR-FAC-010 — Upload & Enroll Face

- **Endpoint:** `POST /api/galleries/:id/faces`
- **Content-Type:** `multipart/form-data`
- **Fields:** `photo` (image file, required), `name` (string, optional, default `'Unknown'`)
- **Max file size:** 10 MB → `400` if exceeded
- **Accepted MIME types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- **Gallery existence:** `404` if `:id` not found

### FR-FAC-011 — Face Detection on Upload

- Photo is normalized to JPEG (quality 95) via `sharp` before processing
- `faceService.detectFaces(jpegBuf, origW, origH)` is called
- If zero faces detected → `422 { success: false, error: 'No face detected...' }`
- If ≥ 2 faces detected → the face with largest `bbox.width × bbox.height` is selected

### FR-FAC-012 — Embedding Extraction on Upload

- `faceService.getEmbedding(jpegBuf, selectedFace.bbox)` is called
- If embedding is `null` → `422 { success: false, error: 'Could not extract face embedding...' }`
- The embedding is a 512-element float32 array, L2-normalized

### FR-FAC-013 — Thumbnail Generation

- A 64×64 JPEG thumbnail is generated by cropping to `best.bbox` then resizing with `fit: 'cover'`
- Stored as `data:image/jpeg;base64,<base64>` string in the `thumbnail` field
- `Math.max(0, Math.round(x))` guards prevent negative crop coordinates
- `Math.max(1, Math.round(width/height))` prevents zero-size crop

### FR-FAC-014 — Face Record Persistence

- Persisted record: `{ id: uuid, galleryId, name, embedding: float32[], thumbnail: string, bbox: BBox, score: number }`
- `db.insert('faceGalleryFaces', face)` is called
- `pipelineManager.reloadPersistentGallery()` is called immediately after insert
- Response: `201 { success: true, data: { ...face, embedding: undefined } }` — raw embedding never exposed

### FR-FAC-015 — FaceService Availability Check

- If `getFaceService()` returns `null` or `faceService.ready === false` → `503 { success: false, error: 'Face service not available — models not loaded' }`
- FaceService is loaded eagerly on startup; this 503 should only occur if models are missing from disk

### FR-FAC-016 — List Enrolled Faces

- **Endpoint:** `GET /api/galleries/:id/faces`
- **Response:** `{ success: true, data: EnrolledFace[] }` sorted by `createdAt` descending
- `embedding` field must be excluded from all response objects
- `404` if gallery not found

### FR-FAC-017 — Delete Enrolled Face (GDPR Erasure)

- **Endpoint:** `DELETE /api/galleries/:id/faces/:faceId`
- Both `galleryId` and `id` must match the record
- `404` if not found
- `pipelineManager.reloadPersistentGallery()` called after deletion
- Response: `200 { success: true }`

---

## 5. Functional Requirements — Live Face Matching

### FR-FAC-020 — Persistent Gallery Search (Per Frame)

- During every `_assignFaceIds()` call, each detected face embedding is compared against all `_persistentGallery` entries
- Comparison: `dot(embedding, galleryEntry.embedding)` (cosine similarity, both L2-normalized)
- Threshold: `0.35` — matches below this value are not reported as named identities
- The gallery entry with the highest similarity above threshold is selected as the match

### FR-FAC-021 — face_match Socket.IO Event

- Emitted when `similarity ≥ 0.35` against a persistent gallery entry
- **Cooldown:** 30 seconds per `${faceId}:${galleryFaceId}` key — same pair will not re-emit within cooldown
- **Payload:**
  ```json
  {
    "faceId":      "F7",
    "cameraId":    "cam-01",
    "identity":    "Kim Minsu",
    "galleryId":   "gallery-uuid",
    "galleryType": "missing",
    "matchScore":  0.872,
    "thumbnail":   "data:image/jpeg;base64,…",
    "timestamp":   1748239140000
  }
  ```
- `galleryType` must be populated from the gallery record at emit time

### FR-FAC-022 — Identity Assignment on Detection Object

- On named match, `det.face.identity` is set to `enrolledFace.name`
- The identity is visible in the detection panel and canvas overlay

---

## 6. Functional Requirements — Missing Persons Detection

### FR-FAC-030 — Missing Gallery Type

- A gallery created with `type: 'missing'` is stored and retrievable as such
- `GET /api/galleries` returns `type: 'missing'` for these galleries

### FR-FAC-031 — missing_person_match Event

- When `face_match` is triggered and the matched gallery has `type === 'missing'`:
  - `missing_person_match` Socket.IO event is emitted **in addition to** `face_match`
  - Same payload as `face_match`
  - Emitted to all connected clients (`io.emit`)
  - Subject to the same 30-second cooldown as `face_match`

### FR-FAC-032 — Gallery Lookup at Match Time

- `db.findOne('faceGalleries', { id: namedMatch.galleryId })` is called to retrieve `galleryType`
- If gallery lookup fails (gallery deleted after enrollment), emit `face_match` with `galleryType: 'general'` as fallback

### FR-FAC-033 — No Duplicate Event

- For a `missing`-type match, exactly **two** events are emitted per match event: `face_match` and `missing_person_match`
- Only `face_match` is emitted for `vip`, `blocklist`, and `general` types

---

## 7. Functional Requirements — Cross-Camera Re-ID

### FR-FAC-040 — Shared Gallery Assignment

- Each newly detected face is compared against `_sharedFaceGallery` (in-memory, threshold 0.35)
- If matched: existing `faceId` is reused; `lastSeenAt` and `lastCameraId` are updated
- If not matched: new `faceId` (e.g. `F1`, `F2`, …) is generated; entry added to shared gallery

### FR-FAC-041 — Gallery Entry Expiry

- Shared gallery entries older than 30 seconds are pruned on every `_assignFaceIds()` call
- Expiry is based on `lastSeenAt`

### FR-FAC-042 — Cross-Camera Re-ID Event

- If `sharedEntry.lastCameraId !== currentCameraId` and the face matches (sim ≥ 0.35):
  - `face:reidentified` Socket.IO event emitted
  - `_crossCameraStats[faceId].transitionCount` incremented
  - `_personTrajectory[faceId].segments` updated with new segment

### FR-FAC-043 — Global Person Registry

- Each unique face ID receives a session-persistent alias (P1, P2, …) assigned in order of first detection
- `GET /api/faces/trajectories?maxAgeMs=N` returns persons whose `lastSeenAt` is within N ms of current time
- `GET /api/faces/cross-camera-stats` returns all faces with `transitionCount ≥ 0`

---

## 8. Functional Requirements — Face ID UI Tab

### FR-FAC-050 — Tab Navigation

- A **Face ID** tab (icon: 🪪) is present in the sidebar navigation
- Selecting it renders `FaceGalleryTab` component
- Tab label uses i18n key `tabFaceGallery` (15 languages)

### FR-FAC-051 — Gallery Creation UI

- A type-selector button (icon changes to selected type's icon) opens a dropdown with 4 options: Missing Persons 🔍, VIP ⭐, Blocklist 🚫, General 🗃
- A text input for gallery name; Enter key submits
- `+ Gallery` button disabled when name is empty or creation is in progress
- On success: new gallery selected automatically; gallery list refreshed

### FR-FAC-052 — Gallery List — Grouping & Ordering

- Galleries are grouped by type in order: `missing` → `vip` → `blocklist` → `general`
- Each group has a section header showing the type icon and label
- Empty groups (no galleries of that type) are hidden
- Selected gallery is highlighted with a coloured left border matching its type

### FR-FAC-053 — Missing Persons UI Priority

- Missing section header has red background and pulsing red dot `●` indicator
- Missing gallery rows have red hover background
- If `missingCount > 0` (total enrolled faces in all missing galleries), an animated red badge `🔍 N` appears in the tab header
- When a `missing_person_match` event is received, a flashing red banner appears at the top of the tab showing identity, match %, and camera ID

### FR-FAC-054 — Face Enrollment UI

- Drag-and-drop zone accepts JPEG/PNG/WebP; click-to-browse also supported
- Preview thumbnail shown immediately after file selection
- Person name input field; submits on Enter or button click
- `Enroll` button disabled when no file selected or enrollment in progress
- On enrollment success: file/preview cleared; enrolled faces grid refreshed

### FR-FAC-055 — Enrolled Faces Grid

- 4-column grid of 64×64 thumbnails with person name below
- Hover reveals ✕ delete button (top-right of card)
- Delete: removes face from server + optimistically updates local state (decrement faceCount)

### FR-FAC-056 — Live Matches Panel

- Subscribes to `face_match` Socket.IO event via `window.__ltsSocket`
- Stores up to 50 most recent events (newest first)
- Each entry shows: type icon, thumbnail, identity, match %, camera ID, timestamp
- Type-differentiated styling: 🚨 red (missing), ⭐ yellow (vip), 🚫 orange (blocklist), ⚡ gray (general)
- Empty state shows `faceNoMatches` i18n string

### FR-FAC-057 — Internationalisation

- All visible strings use i18n translation keys
- 15 languages supported: en, ko, ja, zh-CN, zh-TW, es, fr, de, pt, ru, ar, hi, id, tr, vi
- Keys: `tabFaceGallery`, `faceGallerySubtitle`, `faceNewGalleryPlaceholder`, `faceCreateGallery`, `faceDeleteGallery`, `faceDeleteGalleryConfirm`, `faceNoGalleries`, `faceSelectGallery`, `faceEnrollTitle`, `faceUploadHint`, `faceNamePlaceholder`, `faceEnroll`, `faceEnrolling`, `faceEnrolled`, `faceNoFaces`, `faceLiveMatches`, `faceNoMatches`, `faceSelectType`, `galleryTypeGeneral`, `galleryTypeVip`, `galleryTypeBlocklist`, `galleryTypeMissing`, `missingPersonAlert`

---

## 9. Non-Functional Requirements

### FR-FAC-060 — Model Load Time

- FaceService (SCRFD + ArcFace) must load within 30 seconds of server startup on the target hardware
- `loadFaceServiceEagerly()` is called during server initialization, before HTTP listen

### FR-FAC-061 — Enrollment Latency

- End-to-end photo enrollment (upload → detect → embed → persist → response) must complete within 5 seconds on the server hardware

### FR-FAC-062 — Per-Frame Matching Latency

- Persistent gallery search (cosine similarity over all enrolled faces) must add ≤ 5 ms per frame for galleries up to 1,000 faces

### FR-FAC-063 — Raw Embedding Confidentiality

- Raw 512-D embeddings are never included in REST API responses or Socket.IO events
- Only thumbnails (64×64 base64 JPEG) and identity names are exposed

### FR-FAC-064 — GDPR Right-to-Erasure

- `DELETE /api/galleries/:id/faces/:faceId` permanently removes the embedding and thumbnail from storage
- The persistent gallery cache (`_persistentGallery`) is refreshed within the same request cycle

---

## 10. Data Requirements

### 10.1 faceGalleries Table Schema

```json
{
  "id":          "uuid-v4",
  "name":        "string (trimmed, non-empty)",
  "description": "string (trimmed, may be empty)",
  "type":        "general | vip | blocklist | missing",
  "createdAt":   "ISO-8601 timestamp (set by db.insert)",
  "updatedAt":   "ISO-8601 timestamp (set by db.insert)"
}
```

### 10.2 faceGalleryFaces Table Schema

```json
{
  "id":        "uuid-v4",
  "galleryId": "uuid-v4 (FK → faceGalleries.id)",
  "name":      "string (trimmed, default 'Unknown')",
  "embedding": "float32[] length=512",
  "thumbnail": "data:image/jpeg;base64,... (64×64)",
  "bbox":      { "x": number, "y": number, "width": number, "height": number },
  "score":     "number (SCRFD detection confidence 0–1)",
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp"
}
```

### 10.3 FaceMatchEvent (Socket.IO payload)

```typescript
interface FaceMatchEvent {
  faceId:      string;     // shared gallery face ID (e.g. 'F7')
  cameraId:    string;     // camera that detected the match
  identity:    string;     // enrolledFace.name
  galleryId:   string;     // source gallery UUID
  galleryType: GalleryType;
  matchScore:  number;     // cosine similarity 0–1
  thumbnail:   string;     // data:image/jpeg;base64,...
  timestamp:   number;     // Unix ms
}
```

---

## 11. Interface Requirements

### 11.1 REST API Summary

| ID | Method | Endpoint | Auth | Description |
|---|---|---|---|---|
| FR-FAC-001 | GET | `/api/galleries` | None | List all galleries |
| FR-FAC-002 | POST | `/api/galleries` | None | Create gallery |
| FR-FAC-003 | DELETE | `/api/galleries/:id` | None | Delete gallery (cascade) |
| FR-FAC-016 | GET | `/api/galleries/:id/faces` | None | List enrolled faces |
| FR-FAC-010 | POST | `/api/galleries/:id/faces` | None | Enroll face from photo |
| FR-FAC-017 | DELETE | `/api/galleries/:id/faces/:faceId` | None | Delete enrolled face |
| FR-FAC-043 | GET | `/api/faces/trajectories` | None | Active person trajectories |
| FR-FAC-043 | GET | `/api/faces/cross-camera-stats` | None | Cross-camera Re-ID stats |

### 11.2 Socket.IO Event Summary

| Event | Direction | Condition | FR |
|---|---|---|---|
| `face_match` | Server→Client | Named gallery match (sim ≥ 0.35, any type) | FR-FAC-021 |
| `missing_person_match` | Server→Client | Named gallery match + `galleryType === 'missing'` | FR-FAC-031 |
| `face:reidentified` | Server→Client | Same face seen on different camera | FR-FAC-042 |

---

## 12. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Storage is JSON-file DB (`lts.json`); not suitable for galleries exceeding ~10,000 faces |
| C-02 | Models `scrfd_2.5g.onnx` and `arcface_w600k_r50.onnx` must be present in `server/models/` |
| C-03 | Photo upload is processed in-memory (multer memoryStorage); no temp files are written to disk |
| C-04 | `window.__ltsSocket` must be populated by the App component before FaceGalleryTab mounts |
| C-05 | Cooldown map (`_faceMatchCooldown`) is in-memory only; resets on server restart |
| C-06 | Multiple photos can be enrolled in the same gallery (multiple persons or multiple angles) |
| C-07 | Gallery deletion is non-reversible; no soft-delete or recycle bin |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Face Recognition |
