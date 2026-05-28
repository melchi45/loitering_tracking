# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Face Detection & Recognition

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-03 |
| **Version** | 2.1 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Related RFP** | RFP_AI_Face_Recognition.md (LTS-2026-AI-03) |

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

> **v2.1 Changes (2026-05-26):** Missing Persons gallery type added (`GalleryType = 'general' | 'vip' | 'blocklist' | 'missing'`). `missing_person_match` Socket.IO event, priority UI ordering (missing first, red styling, alert banner), eager FaceService startup load, and `galleryType` field on `face_match` event documented.
>
> **v2.0 Changes (2026-05-26):** Phase-2 gallery enrollment implemented. Storage changed from MongoDB/SQLite to JSON-file DB (`lts.json`). UI layout added (`FaceGalleryTab`). `multer` file upload, persistent named gallery, and `face_match` Socket.IO event now in production.

---

## 1. Product Vision

The Face Detection & Recognition module adds face-level identity anchoring to the LTS-2026 tracking pipeline — enabling loitering behavior to be linked to specific face IDs, supporting VIP/blocklist/missing-person matching, and providing privacy-preserving person tracking — while enforcing GDPR/PDPA compliance requirements for biometric data handling.

A key use case is **Missing Persons detection**: law enforcement or facility security staff upload reference photos of missing persons into a dedicated gallery. When the system recognizes a matching face on any live camera, it immediately fires a high-priority alert (`missing_person_match` Socket.IO event) visible across the entire UI.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect faces in full frames using SCRFD-2.5GF (bounding box + 5-point landmarks).
- Extract 512-D L2-normalized ArcFace embeddings per detected face.
- Assign persistent face IDs via a **server-wide shared** in-memory cosine-similarity gallery (threshold 0.35, 30 s expiry) — shared across all cameras to enable cross-camera Re-ID.
- Re-identify the same person across multiple cameras and broadcast a `face:reidentified` Socket.IO event when a cross-camera transition is detected.
- Assign a canonical session-persistent alias (P1, P2, …) to each unique person and track their trajectory across cameras in a Global Person Registry.
- Expose cross-camera Re-ID statistics and person trajectory data via REST API.
- Emit `faceId`, `alias`, and `matchScore` on face detection objects for display in the detection panel and canvas overlay.
- Support four **gallery types** (`GalleryType`): `general`, `vip`, `blocklist`, `missing` — each with distinct alert priority and UI styling.
- Emit a high-priority `missing_person_match` Socket.IO event (in addition to `face_match`) when a face matches a `missing`-type gallery, enabling emergency response workflows.
- Load FaceService models eagerly on server startup so gallery enrollment is available without requiring an active camera pipeline.
- Provide privacy-preserving anonymization (face blur) and mandatory audit logging for all gallery searches.

### 2.2 Non-Goals

- Face attribute analysis (age range, gender, emotion) is an optional Phase-3 addition and not required for current release.
- This module does not perform crowd demographic analytics.
- MongoDB integration is not supported. Storage uses the project's JSON-file DB (`lts.json` via `db.js`).

---

## 3. User Personas

**Security Administrator** — manages all gallery types (General, VIP, Blocklist, Missing Persons) via the **Face ID** sidebar tab. Uploads reference photos, assigns names, and deletes faces. Must comply with GDPR right-to-erasure requirements (delete button per face). For Missing Persons galleries, coordinates with law enforcement before enrollment.

**Security Operator** — monitors live camera feeds and receives real-time alerts in the **Live Matches** panel of the Face ID tab. Distinguishes alert priority by type: 🚨 red for Missing Persons, ⭐ yellow for VIP, 🚫 orange for Blocklist, ⚡ gray for General. Responds immediately to `missing_person_match` alerts.

**Law Enforcement / Search Coordinator** — provides reference photos for Missing Persons enrollment. Receives notification when a match is detected on any connected camera.

---

## 4. Functional Specification

### 4.1 Phase-1 Pipeline (Complete)

```
Frame
 ├─ SCRFD-2.5GF (full frame, 640×640 letterbox) → [{bbox, score, landmarks}]
 ├─ ArcFace ResNet-50 (per-face 112×112 aligned crop) → [512-D L2-normalized embedding]
 ├─ Cosine-similarity gallery (shared across ALL cameras, in-memory)
 │    threshold = 0.35,  expiry = 30 s
 │    → faceId ('F1', 'F2', …), matchScore
 │    → crossCamera: { prevCameraId }  — if re-identified on a different camera
 ├─ Global Person Registry
 │    → alias ('P1', 'P2', …) — session-persistent canonical identifier
 │    → PersonTrajectory: { faceId, alias, firstSeenAt, lastSeenAt,
 │         currentCameraId, segments:[{ cameraId, objectId, entryTime, exitTime }] }
 └─ Emitted as className='face' detection objects (with alias field)
```

### 4.2 Face Quality Filter

Faces are rejected (skipped) when:
- Sharpness (Laplacian variance) < 50
- Brightness outside 40–220 mean pixel value
- Face size < 20×20 px
- Yaw angle > 75° or pitch > 30°
- Visible face area < 50%

### 4.3 Face Alignment

5-point similarity transform maps detected landmarks to 112×112 reference alignment for ArcFace input.

### 4.4 Cross-Camera Re-ID (Phase-1 Complete)

When `_assignFaceIds()` matches an embedding against the shared gallery and the previous `lastCameraId` differs from the current camera, a cross-camera transition is recorded.

**Socket.IO event `face:reidentified`:**
```json
{
  "faceId":      "F3",
  "alias":       "P1",
  "prevCameraId": "cam-01",
  "newCameraId":  "cam-02",
  "similarity":   0.871,
  "timestamp":    1715678901234
}
```

**Cross-camera statistics** are accumulated per face for the server session:
```json
{
  "faceId":         "F3",
  "firstCameraId":  "cam-01",
  "lastCameraId":   "cam-02",
  "transitionCount": 3,
  "lastSeenAt":     1715678901234
}
```

**Person Trajectory** in the Global Person Registry:
```json
{
  "faceId":        "F3",
  "alias":         "P1",
  "firstSeenAt":   1715678850000,
  "lastSeenAt":    1715678901234,
  "currentCameraId": "cam-02",
  "segments": [
    { "cameraId": "cam-01", "objectId": "track-uuid-a", "entryTime": 1715678850000, "exitTime": 1715678890000 },
    { "cameraId": "cam-02", "objectId": "track-uuid-b", "entryTime": 1715678901000, "exitTime": null }
  ]
}
```

**REST endpoints (Phase-1 Complete):**
- `GET /api/faces/cross-camera-stats` — returns `getCrossCameraReIdStats()` (faces seen on ≥ 2 cameras)
- `GET /api/faces/trajectories?maxAgeMs=300000` — returns `getPersonTrajectories()` (active in last N ms)

### 4.5 Gallery Management (Phase-2 Complete)

**Storage:** JSON-file DB (`server/storage/lts.json`) via `db.js` — tables `faceGalleries` and `faceGalleryFaces`.

**Gallery types (`GalleryType`):**

| Type | Value | Icon | UI Color | Alert Priority | Description |
|---|---|---|---|---|---|
| Missing Persons | `missing` | 🔍 | Red | **Highest** | Law-enforcement reference photos of missing individuals |
| VIP | `vip` | ⭐ | Yellow | High | Known persons requiring special treatment (access, notification) |
| Blocklist | `blocklist` | 🚫 | Orange | High | Persons of interest, banned individuals |
| General | `general` | 🗃 | Gray | Normal | Default category for named enrollment |

Each gallery stores: `{ id, name, description, type: GalleryType, createdAt }`.

**Photo upload:** `multer` (memory storage, 10 MB limit, JPEG/PNG/WebP). On upload:
1. `faceService.detectFaces()` — SCRFD detects all faces; largest face selected.
2. `faceService.getEmbedding()` — ArcFace extracts 512-D embedding.
3. 64×64 JPEG thumbnail generated via `sharp` and stored as base64.
4. Face record persisted: `{ id, galleryId, name, embedding, thumbnail, bbox, score }`.
5. `pipelineManager.reloadPersistentGallery()` called to refresh in-memory cache.

**FaceService eager startup load:** On server startup, `pipelineManager.loadFaceServiceEagerly()` is called immediately — face models (SCRFD + ArcFace) are loaded without waiting for a camera to start. This ensures gallery enrollment is available at any time, even with no active cameras.

**Live matching:** During every `_assignFaceIds()` call, each detected face's embedding is compared against all persistent gallery entries via cosine similarity (threshold 0.35). On match:
- `face_match` Socket.IO event emitted (30 s cooldown per `faceId:galleryFaceId` pair) — includes `galleryType` field.
- If `galleryType === 'missing'`: additional `missing_person_match` Socket.IO event emitted immediately.
- `identity` field set on the detection object.

REST API:
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/galleries` | List all galleries with face count, sorted by `createdAt` desc |
| POST | `/api/galleries` | Create gallery (`{ name, description, type }`) — `type` defaults to `general` |
| DELETE | `/api/galleries/:id` | Delete gallery + all enrolled faces (cascade) |
| GET | `/api/galleries/:id/faces` | List enrolled faces (raw embedding excluded) |
| POST | `/api/galleries/:id/faces` | Upload photo → SCRFD detect → ArcFace embed → enroll |
| DELETE | `/api/galleries/:id/faces/:faceId` | GDPR right-to-erasure |

### 4.6 Missing Persons Detection (Phase-2 Complete)

Missing Persons is a specialized gallery type that triggers an emergency-grade alert workflow distinct from general face matching.

**Enrollment workflow:**
1. Administrator creates a gallery with `type: 'missing'` via the Face ID tab or REST API.
2. Reference photo of the missing person is uploaded (`POST /api/galleries/:id/faces`).
3. SCRFD detects the face; ArcFace extracts the 512-D embedding.
4. Enrollment is persisted in `lts.json` and loaded into `_persistentGallery`.

**Detection workflow (per frame):**
```
_assignFaceIds() — frame processing loop
  ├─ For each detected face embedding:
  │   ├─ Search _persistentGallery for cosine similarity ≥ 0.35
  │   ├─ On match:
  │   │   ├─ Lookup gallery record → galleryType
  │   │   ├─ Emit Socket.IO 'face_match' (30 s cooldown)
  │   │   │     { faceId, cameraId, identity, galleryId, galleryType, matchScore, thumbnail, timestamp }
  │   │   └─ if galleryType === 'missing':
  │   │         Emit Socket.IO 'missing_person_match' (same payload, no cooldown suppression)
  │   └─ Set det.face.identity = enrolledFace.name
  └─ Continue to next frame
```

**Socket.IO event `missing_person_match`:**
```json
{
  "faceId":      "F7",
  "cameraId":    "cam-03",
  "identity":    "Kim Minsu",
  "galleryId":   "gallery-uuid",
  "galleryType": "missing",
  "matchScore":  0.872,
  "thumbnail":   "data:image/jpeg;base64,…",
  "timestamp":   1748239140000
}
```

**Cooldown behaviour:**
- `face_match`: 30-second cooldown per `${faceId}:${galleryFaceId}` pair — prevents alert spam during continuous recognition.
- `missing_person_match`: Uses the same 30-second cooldown. Emergency re-alert occurs if the same face disappears and reappears after the cooldown window.

**UI alert workflow (see §4.8):**
- Flashing red banner at top of Face ID tab.
- Red animated badge (🔍 N) in tab header.
- Live Matches entry styled with 🚨 icon and red background.
- Missing Persons galleries rendered first in gallery list (above VIP, Blocklist, General) with red left border and pulsing red dot indicator.

### 4.7 Privacy & Compliance Requirements

| Feature | Status |
|---|---|
| Face anonymization (Gaussian blur on faceBbox before streaming) | Mandatory — Phase-2 |
| Raw face images never stored — embeddings only | Mandatory |
| Embedding auto-delete after configurable retention period | Mandatory |
| Audit log for all gallery searches and matches | Mandatory |
| RBAC: Admins manage gallery, Operators view alerts only | Mandatory |
| Consent overlay when camera is active | Required by regulation |

### 4.8 UI Layout — Face ID Tab (Phase-2 Complete)

A dedicated **Face ID** sidebar tab (`FaceGalleryTab.tsx`) provides the full gallery management UI, with Missing Persons given highest visual priority.

```
┌─ Face ID ─────────────────────── 🔍 2 ─────────────────┐
│ Header: "Face ID"  [🔍 2]  subtitle: "Enroll & recognize"│
│                                 ↑ animated red badge      │
│                                   when missing count > 0  │
│                                                           │
│ ┌─ MISSING PERSON DETECTED: Kim Minsu  87.2%  cam-03 ──┐ │
│ │ 🚨  (flashing red banner — shown only on match)       │ │
│ └───────────────────────────────────────────────────────┘ │
│                                                           │
│ ┌─ Create Gallery ───────────────────────────────────┐    │
│ │ [🔍▼] [ gallery name input…  ] [ + Gallery ]       │    │
│ │   ↑ type selector dropdown:                        │    │
│ │   ┌─────────────────────────────────┐              │    │
│ │   │ 🔍  Missing Persons          ●  │ ← red dot    │    │
│ │   │ ⭐  VIP                         │              │    │
│ │   │ 🚫  Blocklist                   │              │    │
│ │   │ 🗃  General                     │              │    │
│ │   └─────────────────────────────────┘              │    │
│ └────────────────────────────────────────────────────┘    │
│                                                           │
│ ┌─ Gallery List (grouped, scrollable, max 9 rem) ───────┐ │
│ │  🔍 MISSING PERSONS  ●              ← red section     │ │
│ │  ║ Kim Minsu Gallery         [2] ✕  ← red left border │ │
│ │  ║ Jane Doe Search           [1] ✕                    │ │
│ │                                                        │ │
│ │  ⭐ VIP                                               │ │
│ │    Executive List            [5] ✕                    │ │
│ │                                                        │ │
│ │  🚫 BLOCKLIST                                         │ │
│ │    Banned Persons            [12] ✕                   │ │
│ │                                                        │ │
│ │  🗃 GENERAL                                           │ │
│ │    Staff Gallery             [34] ✕                   │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                           │
│  ─── missing  [MISSING PERSONS] ─────────────────────── │
│  (type badge shown for selected gallery)                  │
│                                                           │
│  ─── ENROLL FACE ─────────────────────────────────────── │
│  ┌─ Drop Zone ─────────────────────────────────────────┐  │
│  │        📷  Click or drag a photo here               │  │
│  │        [preview thumbnail when selected]            │  │
│  └─────────────────────────────────────────────────────┘  │
│  [ Person name…                                        ]   │
│  [ Enroll                                              ]   │
│                                                           │
│  ─── ENROLLED FACES (2) ──────────────────────────────── │
│  ┌──┐  ┌──┐                                               │
│  │👤│  │👤│   4-column thumbnail grid                     │
│  │Kim│  │Jane│  (hover → ✕ delete button)                 │
│  └──┘  └──┘                                               │
│                                                           │
│  ─── LIVE MATCHES ─────────────────────────────────────── │
│  🚨 [thumb] Kim Minsu   87.2%  cam-03 · 14:32:01  ← red  │
│  ⭐  [thumb] CEO Park    91.5%  cam-01 · 14:31:55  ← yel  │
│  🚫  [thumb] Banned-007 78.4%  cam-02 · 14:31:40  ← org  │
│  ⚡  [thumb] Staff-003  82.0%  cam-01 · 14:30:12  ← gray │
└───────────────────────────────────────────────────────────┘
```

**Key UI behaviours:**

| Element | Behaviour |
|---|---|
| Missing person alert banner | Flashing red bar at top (`animate-pulse`); shows identity, match %, camera; visible only when `missing_person_match` received |
| Missing count badge | Animated red badge (🔍 N) in tab header; shows total enrolled faces across all missing galleries |
| Gallery type selector | Icon button opens dropdown: Missing Persons / VIP / Blocklist / General — selected before creating a gallery |
| Gallery list ordering | Always: Missing → VIP → Blocklist → General |
| Gallery list — missing section | Red background (`bg-red-950/40`), red text, pulsing red dot `●` |
| Gallery list — missing row | Red left border when selected; red hover background |
| Gallery type badge | Coloured pill shown next to selected gallery name (🔍 red for missing) |
| Live Matches — missing | 🚨 icon, red background, red identity text, `MISSING PERSONS` badge with `animate-pulse` |
| Live Matches — vip | ⭐ icon, yellow background, yellow identity text |
| Live Matches — blocklist | 🚫 icon, orange background |
| Live Matches — general | ⚡ icon, gray background |
| Live Matches capacity | Newest first, max 50 entries in memory |
| i18n | All strings (including type labels, alert text) available in 15 languages: `galleryTypeMissing`, `galleryTypeVip`, `galleryTypeBlocklist`, `galleryTypeGeneral`, `missingPersonAlert`, `faceNoMatches`, `faceSelectType` |

### 4.9 Zone Activation

Zones with `"targetClasses": ["face"]` activate the full face detection and recognition pipeline. Combined with `"human"` enables joint body + face tracking.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime (`onnxruntime-node`) |
| Face detection model | `scrfd_2.5g.onnx` (SCRFD-2.5GF, 3.3 MB) |
| Face recognition model | `arcface_w600k_r50.onnx` (ArcFace ResNet-50, 166 MB) |
| Detector input | `[1, 3, 640, 640]` float32 letterboxed |
| Detector output | `[N, 15]` — x1, y1, x2, y2, score, 5×(lmk_x, lmk_y) |
| Recognizer input | `[1, 3, 112, 112]` float32 aligned face crop |
| Recognizer output | `[1, 512]` float32 L2-normalized embedding |
| Gallery similarity | Cosine similarity (dot product of L2-normalized vectors) |
| Gallery scope | Server-wide shared across all cameras (enables cross-camera Re-ID) |
| Gallery threshold | 0.35 |
| Gallery expiry | 30 s (entries with no match pruned on each call) |
| Total face pipeline latency | ≤ 25 ms in addition to primary detection |
| Minimum face size | 20×20 px in 1080p |

---

## 6. Input / Output Contract

**Input:**
- JPEG frame buffer (1080p) from RTSP pipeline.
- Person bbox list from primary detection (optional — face detection runs on full frame).

**Output per face detection object (className='face', Phase-1):**
```json
{
  "objectId":  "face-det-uuid",
  "className": "face",
  "bbox":      { "x": 110, "y": 55, "width": 40, "height": 45 },
  "confidence": 0.91,
  "faceId":    "F3",
  "alias":     "P1",
  "matchScore": 0.923,
  "crossCamera": { "prevCameraId": "cam-01" }
}
```

**Face attributes on enriched person object (Phase-1):**
```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "face": {
    "bbox":      { "x": 110, "y": 55, "width": 40, "height": 45 },
    "faceId":    "F3",
    "alias":     "P1",
    "identity":  null,
    "matchScore": 0.923,
    "embedding": null
  }
}
```

**Cross-camera Re-ID event `face:reidentified` (Phase-1):**
```json
{
  "faceId":       "F3",
  "alias":        "P1",
  "prevCameraId": "cam-01",
  "newCameraId":  "cam-02",
  "similarity":   0.871,
  "timestamp":    1715678901234
}
```

**Named identity match alert `face_match` (Phase-2) — all gallery types:**
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

> `galleryType` is one of `"general"` | `"vip"` | `"blocklist"` | `"missing"`. Client uses this field to choose alert icon and colour.

**Missing person alert `missing_person_match` (Phase-2) — `missing` type only:**
```json
{
  "faceId":      "F7",
  "cameraId":    "cam-03",
  "identity":    "Kim Minsu",
  "galleryId":   "gallery-uuid",
  "galleryType": "missing",
  "matchScore":  0.872,
  "thumbnail":   "data:image/jpeg;base64,…",
  "timestamp":   1748239140000
}
```

> This event has the same payload as `face_match` but is emitted **additionally and separately** so clients can subscribe to it independently for emergency notification workflows (push notification, alarm trigger, dispatch system integration) without filtering the general `face_match` stream.

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Face detection accuracy — easy | AP@0.5 ≥ 95% on WiderFace Easy |
| AC-02 | Face detection accuracy — hard | AP@0.5 ≥ 78% on WiderFace Hard |
| AC-03 | Face recognition accuracy | Verification accuracy ≥ 99.0% on LFW |
| AC-04 | 1:N search latency | Gallery search ≤ 5 ms for 1,000-face gallery |
| AC-05 | Total pipeline latency | Face pipeline adds ≤ 25 ms to per-frame time |
| AC-06 | Face ID persistence | Same face assigned consistent `faceId` across ≥ 10 consecutive frames |
| AC-07 | Face ID display | Canvas overlay and detection panel show `face [F3] 87%` format |
| AC-08 | Model capabilities endpoint | `/api/capabilities` returns `face: true` when both model files are present |
| AC-09 | No raw face storage | Server never writes raw face image crops to disk or emits them in socket events |
| AC-10 | Quality filter | Blurry (Laplacian < 50) or small (< 20×20 px) faces are rejected before embedding extraction |
| AC-11 | Cross-camera Re-ID event | `face:reidentified` Socket.IO event is emitted when the same face (cosine sim ≥ 0.35) is detected on a different camera |
| AC-12 | Shared gallery | A face enrolled on cam-01 is matched on cam-02 without re-enrollment |
| AC-13 | Canonical alias | Each unique person receives a session-persistent alias (P1, P2, …) consistent across camera transitions |
| AC-14 | Trajectory API | `GET /api/faces/trajectories` returns segments for persons active within the last 5 minutes |
| AC-15 | Cross-camera stats API | `GET /api/faces/cross-camera-stats` returns transition counts for faces seen on ≥ 2 cameras |
| AC-16 | Gallery type field | `POST /api/galleries` with `type: 'missing'` creates a missing-type gallery; GET returns `type` field |
| AC-17 | face_match galleryType | `face_match` Socket.IO event includes `galleryType` field matching the enrolled gallery |
| AC-18 | missing_person_match event | When a face matches a `missing`-type gallery, both `face_match` and `missing_person_match` are emitted |
| AC-19 | Gallery ordering | Face ID tab gallery list always renders Missing Persons section before VIP, Blocklist, and General |
| AC-20 | Missing alert banner | Red flashing banner appears at top of Face ID tab within 1 s of `missing_person_match` event |
| AC-21 | Missing count badge | Header badge shows total enrolled face count across all missing galleries; updates on enrollment/deletion |
| AC-22 | Enrollment without camera | Photo enrollment succeeds via `POST /api/galleries/:id/faces` when no cameras are actively streaming (FaceService loads eagerly on startup) |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase-1: SCRFD face detection + ArcFace embedding + server-wide shared gallery + cross-camera Re-ID (`face:reidentified`) + Global Person Registry (alias, trajectory) + REST API (`/api/faces/cross-camera-stats`, `/api/faces/trajectories`) | 2026-05-18 | 2026-05-18 | ✅ Complete |
| M2 | Phase-2: Persistent JSON-file gallery (`faceGalleries` + `faceGalleryFaces` in `lts.json`) + photo upload (`multer`) + named identity enrollment REST API | 2026-05-26 | 2026-05-26 | ✅ Complete |
| M3 | Phase-2: Named identity match alert — `face_match` Socket.IO event (with `galleryType` field) + 30 s cooldown | 2026-05-26 | 2026-05-26 | ✅ Complete |
| M4 | Phase-2: **Face ID sidebar tab** — gallery CRUD, photo upload UI, enrolled face grid, live match log | 2026-05-26 | 2026-05-26 | ✅ Complete |
| M5 | Phase-2: **Missing Persons gallery type** — `GalleryType` system (general/vip/blocklist/missing), `missing_person_match` event, priority UI (red banner, badge, grouped list), eager FaceService startup, `galleryType` on `face_match` | 2026-05-26 | 2026-05-26 | ✅ Complete |
| M6 | Phase-3: Face blur/anonymization privacy mode | TBD | - | ⏳ Pending |
| M7 | Phase-3: Face attribute analysis (age range, gender) | TBD | - | ⏳ Pending |

### 8.2 TODO (Phase-3)

- [x] ~~Implement persistent face gallery (survive server restarts)~~ ✅ JSON-file DB
- [x] ~~Implement enrollment endpoints (`POST /api/galleries`, `POST /api/galleries/:id/faces`)~~ ✅
- [x] ~~Implement `DELETE /api/galleries/:id/faces/:faceId` for GDPR right-to-erasure~~ ✅
- [x] ~~VIP/blocklist `face_match` Socket.IO alert~~ ✅ includes `galleryType` field
- [x] ~~Face ID sidebar tab UI~~ ✅ `FaceGalleryTab.tsx`
- [x] ~~Missing Persons gallery type (`type: 'missing'`)~~ ✅ `GalleryType` union type
- [x] ~~`missing_person_match` Socket.IO event~~ ✅ emitted alongside `face_match` for missing galleries
- [x] ~~Missing Persons priority UI~~ ✅ red banner, badge, grouped list (missing first), red styling
- [x] ~~Eager FaceService startup load~~ ✅ `pipelineManager.loadFaceServiceEagerly()` called on server init
- [ ] Implement `GET /api/galleries/:id/search` 1:N explicit search endpoint (currently live-only)
- [ ] Implement face anonymization — Gaussian blur on `faceBbox` before Socket.IO emission
- [ ] Add `zone.privacyMode` field and conditional blur routing in `pipelineManager.js`
- [ ] Implement audit log for all gallery searches and identity matches
- [ ] Add RBAC checks: admin-only gallery management endpoints
- [ ] Add embedding retention period configuration with auto-purge cron job
- [ ] Source or train `age_gender_mobilenet.onnx` for Phase-3 optional attribute analysis

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for AI Face Recognition |
