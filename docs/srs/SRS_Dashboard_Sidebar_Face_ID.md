# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Dashboard Sidebar — Face ID Panel

| | |
|---|---|
| **Document ID** | SRS-LTS-UI-FACE-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent PRD** | prd/PRD_Dashboard_Sidebar_Face_ID.md (v1.1) |
| **Parent RFP** | rfp/RFP_Dashboard_Sidebar_Face_ID.md (v1.1) |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Gallery Management](#3-functional-requirements--gallery-management)
4. [Functional Requirements — Face Enrollment](#4-functional-requirements--face-enrollment)
5. [Functional Requirements — Match Log](#5-functional-requirements--match-log)
6. [Functional Requirements — Missing Person Alert](#6-functional-requirements--missing-person-alert)
7. [Functional Requirements — Data Persistence](#7-functional-requirements--data-persistence)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Interface Requirements](#9-interface-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)
11. [v1.1 Amendment — Live Match Crop & Search (FR-UI-FACE-080~085)](#11-v11-amendment--live-match-crop--search)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the Face ID Panel of LTS-2026. Each requirement is identified by a unique ID (`FR-UI-FACE-NNN`) and is directly traceable to test cases in `TC_Dashboard_Sidebar_Face_ID.md`.

### 1.2 Scope

This document covers:
- Gallery CRUD: create / list / expand / delete named face galleries
- Face enrollment: photo upload → SCRFD detection → ArcFace embedding → DB persist
- Face card display: thumbnail, name, delete
- Real-time match log via Socket.IO
- Missing person alert banner
- Full data persistence across server restarts
- **(v1.1)** Live face crop in `face_match` event payload
- **(v1.1)** `faceMatchHistory` DB persistence for match events
- **(v1.1)** SearchBar integration for face match history search

Out of scope: bulk import (Phase-2), manual embedding override (Phase-3).

### 1.3 Definitions

| Term | Definition |
|---|---|
| `FaceGallery` | A named collection of enrolled faces with a type (`missing`/`vip`/`blocklist`/`general`) |
| `EnrolledFace` | A single person record with name, 512-dim ArcFace embedding, 96×96 thumbnail |
| `FaceMatchEvent` | Real-time event from server when a live camera frame matches an enrolled face |
| `SCRFD` | Short-Range Face Detector — ONNX model for face detection in uploaded photos |
| `ArcFace` | Face recognition model — produces 512-dim L2-normalized embedding |
| `faceGalleries` | DB table in `storage/lts.json` for gallery metadata |
| `faceGalleryFaces` | DB table in `storage/lts.json` for enrolled face records |
| `face_tracking.json` | Separate JSON file for runtime person trajectory state |

---

## 2. System Overview

### 2.1 Architecture

```
┌─────────────────────────────────────────────────────┐
│                   CLIENT (React)                    │
│  FaceGalleryTab.tsx                                 │
│   ├─ Gallery list (GallerySection × 4 types)        │
│   ├─ UploadArea → POST /api/galleries/:id/faces     │
│   ├─ FaceCard grid → DELETE face                    │
│   └─ MatchLog (Socket.IO face_match listener)       │
└─────────────────────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼────────────────────────────┐
│  Server                                             │
│  GET/POST/DELETE /api/galleries                     │
│  GET/POST/DELETE /api/galleries/:id/faces           │
│  FaceService (SCRFD + ArcFace ONNX)                 │
│  PipelineManager (runtime gallery + trajectory)     │
│  DB: lts.json (faceGalleries, faceGalleryFaces)     │
│  DB: face_tracking.json (trajectory + counters)     │
└─────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
Photo upload
  → multer (memory, ≤10 MB)
  → sharp (JPEG normalize)
  → SCRFD: detect face bounding box
  → ArcFace: extract 512-dim embedding
  → DB: store embedding + base64 thumbnail in faceGalleryFaces
  → PipelineManager.reloadPersistentGallery()
  → Response: EnrolledFace object

Live frame
  → YOLO detection → person crop
  → ArcFace: extract embedding
  → Compare vs _sharedFaceGallery (in-memory, 30s expiry)
  → Compare vs _persistentGallery (named, from DB)
  → On match: emit face_match via Socket.IO
```

---

## 3. Functional Requirements — Gallery Management

### FR-UI-FACE-001 — Gallery Tab Registration

The sidebar shall contain a tab with ID `faces`, icon `🪪`, and label determined by i18n key `tabFaceGallery`. Clicking the tab shall render `FaceGalleryTab` as the active sidebar content.

### FR-UI-FACE-002 — Gallery Fetch on Mount

When `FaceGalleryTab` mounts, it shall issue `GET /api/galleries` and populate the gallery list state. The request shall be retried silently on failure (no user-visible error for initial load).

### FR-UI-FACE-003 — Gallery Display Order

Galleries shall be grouped by type and displayed in the following fixed order: `missing` → `vip` → `blocklist` → `general`. Within each type group, galleries shall be ordered by creation time (oldest first).

### FR-UI-FACE-004 — Gallery Section Header

Each type group that contains at least one gallery shall render a section header with the type icon and uppercased type label. The `missing` type header shall include a pulsing dot (`animate-pulse text-red-500`).

### FR-UI-FACE-005 — Gallery Row Expand/Collapse

Clicking a gallery row shall toggle its expanded state. Only one gallery may be expanded at a time. Expanding a gallery shall trigger `GET /api/galleries/:id/faces` to load its face list.

### FR-UI-FACE-006 — Selected Gallery Left Border

The expanded/selected gallery row shall render a left border colored by its type (red for `missing`, yellow for `vip`, orange for `blocklist`, blue for `general`).

### FR-UI-FACE-007 — Gallery Creation

The panel shall include a text input for gallery name and a type selector dropdown. Clicking `[+ Create]` shall call `POST /api/galleries` with `{ name: string, type: GalleryType }`. On success, the gallery list shall refresh and the new gallery shall be auto-selected (expanded).

### FR-UI-FACE-008 — Gallery Type Selector

The type selector shall be a dropdown showing 4 options (missing / vip / blocklist / general) with their respective icons and i18n labels. Default value shall be `general`.

### FR-UI-FACE-009 — Gallery Deletion

Clicking the `✕` button on a gallery row shall display a browser `confirm()` dialog. On confirmation, `DELETE /api/galleries/:id` shall be called. On success, the gallery shall be removed from the list and the selection shall be cleared.

### FR-UI-FACE-010 — Empty Gallery List State

When no galleries exist, the panel shall display an empty state with `👤` icon and i18n text `faceNoGalleries`.

---

## 4. Functional Requirements — Face Enrollment

### FR-UI-FACE-020 — Upload Area

The expanded gallery shall display an upload area (`UploadArea` component) with a dashed border. The area shall accept JPEG, PNG, and WebP files.

### FR-UI-FACE-021 — Drag-Drop Upload

Dragging a file over the upload area shall change the border to blue (`border-blue-500`) and background to `bg-blue-950/30`. Dropping a valid image file shall load it as a preview.

### FR-UI-FACE-022 — Click-to-Browse Upload

Clicking the upload area shall open a native file picker filtered to `image/jpeg,image/png,image/webp`. Selecting a file shall load it as a preview.

### FR-UI-FACE-023 — Photo Preview

After a file is selected or dropped, a preview image shall replace the hint text inside the upload area. The preview shall be `mx-auto h-20 rounded object-contain`.

### FR-UI-FACE-024 — Name Input

A text input field below the upload area shall accept a person name. Placeholder text is determined by i18n key `faceNamePlaceholder`. If left blank, enrollment shall use `"Unknown"` as the name.

### FR-UI-FACE-025 — Enroll Button State

The `[Enroll]` button shall be disabled (`disabled` attribute) when no file is selected or when enrollment is in progress. During enrollment, button text shall change to i18n `faceEnrolling`.

### FR-UI-FACE-026 — Enrollment Request

Clicking `[Enroll]` shall send `POST /api/galleries/:id/faces` as `multipart/form-data` with fields `photo` (file) and `name` (string).

### FR-UI-FACE-027 — Enrollment Success

On HTTP 200 success response: upload area state (file, preview, name) shall reset. Gallery face count shall increment. The gallery's face list shall refresh.

### FR-UI-FACE-028 — Enrollment Error Display

On non-2xx response or network error, the error message from `response.json().error` (or a default message) shall be displayed in `text-[10px] text-red-400` below the name input.

### FR-UI-FACE-029 — Face Card Display

Each enrolled face shall be rendered as a `FaceCard` within a `flex flex-wrap gap-1.5` grid. Each card shall show a 48×48 thumbnail (or `👤` fallback), a truncated name, and a hover-revealed delete button.

### FR-UI-FACE-030 — Face Deletion

Hovering a face card shall reveal a `✕` delete button in the top-right corner. Clicking it shall send `DELETE /api/galleries/:id/faces/:faceId`. On success, the face card shall be removed from the grid and the gallery face count decremented.

---

## 5. Functional Requirements — Match Log

### FR-UI-FACE-040 — Socket.IO Subscription

`FaceGalleryTab` shall subscribe to the `face_match` Socket.IO event on mount using the `window.__ltsSocket` reference. The subscription shall be cleaned up on unmount.

### FR-UI-FACE-041 — Match Log State

Each received `face_match` event shall be prepended to the `matchLog` array state. The array shall be capped at **50 entries**; entries exceeding the cap shall be discarded (oldest first).

### FR-UI-FACE-042 — Match Log Display

The match log shall render each event as a row with: thumbnail (28×28), type icon, person name, similarity percentage, camera ID, and timestamp (`HH:MM:SS`).

### FR-UI-FACE-043 — Match Log Row Color

Match log rows shall have background and border color determined by `galleryType`:
- `missing`: `bg-red-950/60 border-red-700/60`
- `vip`: `bg-yellow-950/50 border-yellow-700/50`
- `blocklist`: `bg-orange-950/50 border-orange-700/50`
- `general`: `bg-gray-800/60 border-gray-700/40`

### FR-UI-FACE-044 — Match Log Empty State

When no match events have been received, the match log area shall display `👁` icon and i18n text `faceNoMatches`.

### FR-UI-FACE-045 — Match Log Scroll

The match log container shall be `max-h-48 overflow-y-auto`, allowing independent scrolling.

---

## 6. Functional Requirements — Missing Person Alert

### FR-UI-FACE-050 — Missing Person Banner Trigger

When `matchLog` contains at least one entry with `galleryType === 'missing'`, a full-width alert banner shall be displayed at the top of the `FaceGalleryTab` content area, above the gallery creation row.

### FR-UI-FACE-051 — Missing Person Banner Content

The banner shall display: `🚨` icon, i18n `missingPersonAlert` label, the matched person's `identity` name, cosine similarity percentage, and `cameraId`.

### FR-UI-FACE-052 — Missing Person Banner Style

The banner shall use `bg-red-800/80 border-b border-red-700 animate-pulse` styling.

### FR-UI-FACE-053 — Missing Count Badge

The panel header shall display a red round badge with the total count of enrolled faces in `missing`-type galleries. The badge shall be hidden when the count is 0.

---

## 7. Functional Requirements — Data Persistence

### FR-UI-FACE-060 — Gallery Persistence

Named galleries created via `POST /api/galleries` shall be stored in the `faceGalleries` table of `storage/lts.json`. Galleries shall remain accessible after server restart without any re-enrollment action.

### FR-UI-FACE-061 — Face Record Persistence

Enrolled faces (including ArcFace embedding vector and base64 thumbnail) shall be stored in the `faceGalleryFaces` table of `storage/lts.json`. Records shall survive server restarts.

### FR-UI-FACE-062 — Persistent Gallery Reload

After any enrollment or deletion operation, the server shall call `pipelineManager.reloadPersistentGallery()` to reload the in-memory named gallery cache used by the live matching pipeline.

### FR-UI-FACE-063 — Person Trajectory Persistence

The `_faceCounter`, `_personAliasCounter`, and all `_personTrajectory` entries shall be persisted to `storage/face_tracking.json` with a 1-second debounce. The file shall be loaded on `PipelineManager` initialization to restore counters across server restarts.

### FR-UI-FACE-064 — Trajectory Persistence Schema

`storage/face_tracking.json` shall contain:

```json
{
  "faceCounter": <number>,
  "personAliasCounter": <number>,
  "trajectories": [
    {
      "faceId": "F<n>",
      "alias": "P<n>",
      "firstSeenAt": <unix-ms>,
      "lastSeenAt": <unix-ms>,
      "currentCameraId": "<uuid>",
      "segments": [
        { "cameraId": "<uuid>", "objectId": <n|null>, "entryTime": <unix-ms>, "exitTime": <unix-ms|null> }
      ]
    }
  ]
}
```

Embedding vectors shall NOT be stored in this file to limit file size.

---

## 8. Non-Functional Requirements

### NFR-UI-FACE-001 — Enrollment Latency

Face enrollment response shall complete within **5 seconds** on a server with models loaded (measured from request send to UI update).

### NFR-UI-FACE-002 — Match Log Update Latency

A `face_match` Socket.IO event shall appear as a new match log row within **1 second** of emission.

### NFR-UI-FACE-003 — Upload Size Limit

The server shall reject file uploads exceeding **10 MB** with HTTP 400.

### NFR-UI-FACE-004 — Gallery Scalability

The system shall support up to **500 enrolled faces** across all galleries without degradation in matching latency (measured on server with ArcFace model loaded, cosine similarity over 500 vectors).

### NFR-UI-FACE-005 — Persistence Durability

`face_tracking.json` writes shall be synchronous (`writeFileSync`) to prevent data loss on abnormal server termination.

---

## 9. Interface Requirements

### 9.1 REST API

See RFP §11 for endpoint definitions and response schemas.

### 9.2 Socket.IO

| Event | Direction | Payload Type |
|---|---|---|
| `face_match` | Server → Client | `FaceMatchEvent` |
| `missing_person_match` | Server → Client | `FaceMatchEvent` (subset where `galleryType === 'missing'`) |

### 9.3 Storage Files

| File | Access | Format | Used when |
|---|---|---|---|
| `storage/lts.json` | Read/Write (db.js) | JSON (table arrays) | Always (also as hot-standby when `DB_TYPE=mongodb`) |
| `storage/face_tracking.json` | Read/Write (pipelineManager.js) | JSON | Always (person trajectory persistence) |
| MongoDB collections | Read/Write (mongoDbService.js) | BSON documents | `DB_TYPE=mongodb` only |

---

## 10. Persistence Requirements (FR-UI-FACE-065 ~ FR-UI-FACE-074)

### 10.1 Gallery & Face Data Persistence

| ID | Requirement | Priority |
|---|---|---|
| FR-UI-FACE-065 | The system SHALL persist gallery records (name, type, description, id, createdAt) across server restarts. | Must |
| FR-UI-FACE-066 | The system SHALL persist enrolled face records (name, galleryId, embedding, thumbnail, bbox, score, createdAt) across server restarts. | Must |
| FR-UI-FACE-067 | Gallery type labels (VIP, Missing Persons, Blocklist, General) SHALL be preserved without change after a server restart. | Must |
| FR-UI-FACE-068 | Face thumbnail images (base64 JPEG, 64×64) SHALL be restored from storage on server startup and served via `/api/galleries/:id/faces`. | Must |
| FR-UI-FACE-069 | Face embeddings (512-D float array) SHALL be restored on startup so that recognition matching resumes immediately without re-enrollment. | Must |

### 10.2 Storage Backend Selection

| ID | Requirement | Priority |
|---|---|---|
| FR-UI-FACE-070 | The server SHALL support two storage backends configurable via `DB_TYPE` in `server/.env`: `json` (default) and `mongodb`. | Must |
| FR-UI-FACE-071 | When `DB_TYPE=json`, all data SHALL be stored in `storage/lts.json` using synchronous file I/O. This is the default mode and requires no external dependencies. | Must |
| FR-UI-FACE-072 | When `DB_TYPE=mongodb`, the server SHALL connect to the MongoDB instance specified by `MONGODB_URI` on startup, load all table data into the in-memory store, and write all subsequent mutations to MongoDB asynchronously. | Must |
| FR-UI-FACE-073 | In MongoDB mode, `storage/lts.json` SHALL be maintained as a hot-standby JSON backup. On startup, if the MongoDB collection for a table is empty but `lts.json` contains data, the server SHALL seed MongoDB from `lts.json` automatically. | Must |
| FR-UI-FACE-074 | If MongoDB is configured but unreachable at startup, the server SHALL log a warning and fall back to `json` mode without interrupting service startup. | Must |

### 10.3 Server Restart Recovery

| ID | Requirement | Priority |
|---|---|---|
| FR-UI-FACE-075 | On server startup, `pipelineManager.reloadPersistentGallery()` SHALL be called after the face service is ready, loading all enrolled embeddings into the in-memory matching index. | Must |
| FR-UI-FACE-076 | Face tracking counters (`_faceCounter`, `_personAliasCounter`) and person trajectories SHALL be restored from `storage/face_tracking.json` on startup, preserving continuity of person IDs across restarts. | Must |

---

## 11. Constraints & Assumptions

1. Face model files (`scrfd_2.5g.onnx`, `arcface_w600k_r50.onnx`) must be manually downloaded to `server/models/`. The system SHALL degrade gracefully (503) if models are absent.
2. The `window.__ltsSocket` global must be initialized in `App.tsx` before `FaceGalleryTab` mounts.
3. Photo uploads must contain at least one human face with a bounding box area sufficient for SCRFD detection.
4. The `storage/` directory must be writable by the Node.js server process.
5. All gallery and face UUIDs are generated server-side via `uuid.v4()`.
6. When `DB_TYPE=mongodb`, `MONGODB_URI` must be set to a valid MongoDB connection string. The database and collections are created automatically on first write.
7. Embedding vectors are stored as-is (JSON arrays of 512 floats) in both JSON and MongoDB storage. No vector index is required for the current cosine-similarity matching approach.
---

## 11. v1.1 Amendment — Live Match Crop & Search

### 11.1 Overview

v1.1 adds two capabilities:
1. **Live Match Crop**: Each `face_match` event payload now includes a JPEG crop of the detected face from the live frame buffer (`liveCropData`). The MatchLog displays this alongside the enrolled gallery photo.
2. **Face Match History**: Each match event is persisted to a `faceMatchHistory` DB table. The `GET /api/search` endpoint is extended with `types=matches` to search this history.

### 11.2 New Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-UI-FACE-080 | The server SHALL include a `liveCropData` field (base64 JPEG data URL) in every `face_match` Socket.IO event payload when `sharp` is available and the bounding box can be cropped from the JPEG frame buffer. | Must |
| FR-UI-FACE-081 | The crop operation SHALL use `setImmediate` to avoid blocking the live frame pipeline. The `face_match` event SHALL NOT be emitted until the crop is complete (one atomic event per match). | Must |
| FR-UI-FACE-082 | When the crop operation fails, the server SHALL still emit `face_match` without `liveCropData`; the event MUST NOT be suppressed. | Must |
| FR-UI-FACE-083 | `FaceGalleryTab` MatchLog rows SHALL display both the enrolled gallery photo (`thumbnail`) and the live frame crop (`liveCropData`) as 28×28 images in a side-by-side layout. If `liveCropData` is absent, a placeholder icon SHALL be shown. | Must |
| FR-UI-FACE-084 | The server SHALL persist each `face_match` event to the `faceMatchHistory` table in `storage/lts.json` (and MongoDB when active), with fields: `id`, `faceId`, `cameraId`, `identity`, `galleryId`, `galleryType`, `matchScore`, `thumbnail`, `liveCropData`, `timestamp`, `createdAt`. | Must |
| FR-UI-FACE-085 | `GET /api/search?q=<query>&types=matches` SHALL search the `identity` field of `faceMatchHistory` rows (case-insensitive substring match) and return results shaped as `{ _type: 'match', id, identity, galleryType, matchScore, cameraId, timestamp, thumbnail, liveCropData }`. | Must |
| FR-UI-FACE-086 | `GET /api/search?q=<query>&types=faces` SHALL also include `faceMatchHistory` results alongside `faceGalleryFaces` results. | Should |
| FR-UI-FACE-087 | SearchBar result items with `_type: 'match'` SHALL navigate the UI to the `faces` sidebar tab when clicked. | Must |

### 11.3 Updated Interface — FaceMatchEvent

```typescript
interface FaceMatchEvent {
  faceId:        string;      // Live gallery face ID
  cameraId:      string;      // Source camera UUID
  identity:      string;      // Enrolled person name
  galleryId:     string;      // Matched gallery UUID
  galleryType:   GalleryType; // Gallery type
  matchScore:    number;      // Cosine similarity (0–1)
  thumbnail?:    string;      // base64 JPEG — enrolled gallery photo
  liveCropData?: string;      // [NEW v1.1] base64 JPEG — live detected face crop
  timestamp:     number;      // Event Unix ms
}
```

### 11.4 Non-Functional Requirements (v1.1)

| ID | Requirement |
|---|---|
| NFR-UI-FACE-010 | Crop operation MUST complete within 100 ms (p99) on server hardware. |
| NFR-UI-FACE-011 | `faceMatchHistory` table MUST NOT exceed 10,000 rows; oldest entries SHALL be pruned automatically when the limit is reached. |
| NFR-UI-FACE-012 | `GET /api/search?types=matches` response MUST complete within 500 ms for up to 10,000 history rows. |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Dashboard Sidebar Face ID |
