# DESIGN DOCUMENT
# AI Module — Face Detection & Recognition

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-03 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Face_Recognition.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design](#3-server-side-design)
4. [Client-Side Design](#4-client-side-design)
5. [Data Model](#5-data-model)
6. [API Design](#6-api-design)
7. [Sequence Diagrams](#7-sequence-diagrams)
8. [Configuration & Environment](#8-configuration--environment)
9. [Error Handling](#9-error-handling)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                        │
│  App.tsx ──────────── window.__ltsSocket (Socket.IO client) │
│      └─ FaceGalleryTab.tsx                                  │
│           ├─ REST: fetch('/api/galleries/...')              │
│           └─ Socket.IO: 'face_match', 'missing_person_match'│
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)             │
│                                                              │
│  index.js                                                    │
│   ├─ POST /api/galleries/*  → faceGallery.js (Router)       │
│   ├─ GET  /api/faces/*      → inline handlers               │
│   └─ loadFaceServiceEagerly() on startup                    │
│                                                              │
│  api/faceGallery.js                                          │
│   ├─ multer (memoryStorage, 10MB)                           │
│   └─ calls getFaceService() → faceService instance          │
│                                                              │
│  services/pipelineManager.js                                 │
│   ├─ _attrPipeline: AttributePipeline                       │
│   │    └─ _face: FaceService                                │
│   ├─ _sharedFaceGallery[]   — in-memory, cross-cam Re-ID   │
│   ├─ _persistentGallery[]   — loaded from DB                │
│   ├─ _faceMatchCooldown Map — cooldown tracking             │
│   └─ _personTrajectory Map  — Global Person Registry        │
│                                                              │
│  services/faceService.js                                     │
│   ├─ detectFaces()  — SCRFD ONNX                            │
│   └─ getEmbedding() — ArcFace ONNX                          │
│                                                              │
│  db.js (JSON-file store)                                     │
│   ├─ table: faceGalleries                                   │
│   └─ table: faceGalleryFaces                                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── api/
│   │   │   └── faceGallery.js          # REST router for /api/galleries
│   │   ├── services/
│   │   │   ├── faceService.js          # SCRFD + ArcFace ONNX wrapper
│   │   │   ├── attributePipeline.js    # Composite attr pipeline (face+PPE+color)
│   │   │   └── pipelineManager.js      # _assignFaceIds, _sharedFaceGallery, etc.
│   │   ├── db.js                       # JSON-file DB (lts.json)
│   │   └── index.js                    # Express app + route mounting
│   ├── models/
│   │   ├── scrfd_2.5g.onnx             # Face detection (3.3 MB)
│   │   └── arcface_w600k_r50.onnx      # Face recognition (249 MB)
│   └── storage/
│       └── lts.json                    # Persistent data store
│
├── client/
│   └── src/
│       ├── components/
│       │   └── FaceGalleryTab.tsx      # Face ID sidebar tab
│       ├── types/
│       │   └── index.ts                # GalleryType, FaceGallery, EnrolledFace, etc.
│       └── i18n/
│           └── translations/
│               └── *.ts               # 15 language files
│
├── docs/
│   ├── rfp/RFP_AI_Face_Recognition.md
│   ├── prd/PRD_AI_Face_Recognition.md
│   ├── srs/SRS_AI_Face_Recognition.md
│   ├── design/Design_AI_Face_Recognition.md  ← this file
│   └── tc/TC_AI_Face_Recognition.md
│
└── test/
    ├── api/
    │   ├── face_gallery.test.js
    │   ├── face_enrollment.test.js
    │   └── missing_persons.test.js
    └── integration/
        └── face_pipeline.test.js
```

---

## 3. Server-Side Design

### 3.1 FaceService (`server/src/services/faceService.js`)

**Responsibilities:**
- Load and hold ONNX InferenceSession instances for SCRFD and ArcFace
- Provide `detectFaces(jpegBuffer, width, height)` and `getEmbedding(jpegBuffer, bbox)` APIs

**Key design points:**

| Method | Input | Output | Notes |
|---|---|---|---|
| `load()` | — | `Promise<void>` | Loads both ONNX models; sets `_ready = true` on success |
| `detectFaces(buf, w, h)` | JPEG Buffer, frame dims | `Array<{bbox, score, landmarks}>` | SCRFD-2.5GF, 640×640 letterbox, NMS |
| `getEmbedding(buf, bbox)` | JPEG Buffer, face bbox | `Float32Array(512) \| null` | ArcFace 112×112 aligned crop, L2-normalized |

**State machine:**

```
_status: 'not_started'
  → load() called
  → scrfd loaded: _status stays 'not_started'
  → arcface loaded: _status = 'loaded', _ready = true
  → any load error: _status = 'failed', _ready = false
  → model file missing: _status = 'missing'
```

**SCRFD pre-processing:**
1. Resize input frame to 640×640 with letterboxing (pad with 0.5 grey)
2. Convert to float32 RGB, normalize to 0–1
3. Transpose to `[1, 3, 640, 640]` NCHW

**ArcFace pre-processing:**
1. Extract face crop using detected bbox
2. Apply 5-point similarity transform using detected landmarks → 112×112 aligned crop
3. Normalize pixel values: `(pixel / 255.0 - 0.5) / 0.5`
4. L2-normalize output embedding vector

### 3.2 AttributePipeline (`server/src/services/attributePipeline.js`)

**Responsibilities:**
- Compose FaceService, PPEService, and ColorService
- `load()` triggers all sub-service loads in parallel
- `enrich(detections, ...)` runs all enabled attribute pipelines per detection

**FaceService access:**
- `this._face = new FaceService(options.face)`
- Exposed as `attrPipeline._face` for external access (used by gallery enrollment)

**Status properties:**
```javascript
get faceStatus()  { return this._face.status; }   // 'loaded' | 'failed' | 'missing' | ...
get anyReady()    { return this._face.ready || this._ppe.ready || this._color.ready; }
```

### 3.3 PipelineManager (`server/src/services/pipelineManager.js`)

**Key fields:**

| Field | Type | Purpose |
|---|---|---|
| `_attrPipeline` | `AttributePipeline \| null` | Shared instance; initialized on first camera start OR eager load |
| `_sharedFaceGallery` | `Array<SharedEntry>` | In-memory gallery for cross-camera Re-ID |
| `_persistentGallery` | `Array<DBFaceEntry>` | DB-loaded named faces for identity matching |
| `_faceMatchCooldown` | `Map<string, number>` | `${faceId}:${galleryFaceId}` → lastEmitMs |
| `_personTrajectory` | `Map<string, PersonTrajectory>` | faceId → trajectory record |
| `_crossCameraStats` | `Map<string, CrossCamStat>` | faceId → stats record |
| `_faceCounter` | `number` | Monotonic counter for faceId generation (F1, F2, …) |

**`loadFaceServiceEagerly()` design:**

```javascript
async loadFaceServiceEagerly() {
  if (this._attrPipeline) return;  // idempotent
  this._attrPipeline = new AttributePipeline();
  await this._attrPipeline.load();
  // _attrPipeline._face is now available for gallery enrollment
}
```

**`_assignFaceIds(faces, cameraId, jpegBuffer, frameW, frameH)` flow:**

```
For each detected face:
  1. Extract embedding via faceService.getEmbedding()
  2. Search _sharedFaceGallery for cosine sim ≥ 0.35
     a. Match found:
        - Reuse existing faceId
        - If lastCameraId ≠ cameraId → emit face:reidentified, update trajectory
        - Update lastSeenAt, lastCameraId
     b. No match:
        - Assign new faceId = 'F' + _faceCounter++
        - Add new entry to _sharedFaceGallery
        - Assign alias (P1, P2, …) if not in _personTrajectory

  3. Search _persistentGallery for cosine sim ≥ 0.35
     a. Match found (and cooldown expired):
        - Lookup gallery record for galleryType
        - emit 'face_match' { faceId, cameraId, identity, galleryId, galleryType, ... }
        - if galleryType === 'missing': emit 'missing_person_match' (same payload)
        - Set cooldown: _faceMatchCooldown.set(key, Date.now())
        - Set det.face.identity = enrolledFace.name

  4. Prune _sharedFaceGallery entries older than 30 s
```

**Cooldown check:**
```javascript
const cooldownKey = `${faceId}:${namedMatch.id}`;
const lastEmit = this._faceMatchCooldown.get(cooldownKey) || 0;
if (Date.now() - lastEmit > 30_000) {
  // emit and update cooldown
}
```

### 3.4 faceGallery Router (`server/src/api/faceGallery.js`)

**Middleware stack per enrollment request:**
```
Express Router
  └─ upload.single('photo')  [multer: memoryStorage, 10MB, JPEG/PNG/WebP/GIF]
       └─ async handler
            ├─ validate gallery exists (db.findOne)
            ├─ validate file present
            ├─ getFaceService() — lazy getter
            ├─ validate faceService.ready
            ├─ sharp: normalize to JPEG
            ├─ faceService.detectFaces()
            ├─ faceService.getEmbedding()
            ├─ sharp: crop → resize → base64 thumbnail
            ├─ db.insert('faceGalleryFaces', ...)
            └─ pipelineManager.reloadPersistentGallery()
```

**getFaceService() pattern (lazy getter from index.js):**
```javascript
// index.js — passed to router constructor
const getFaceService = () => pipelineManager._attrPipeline?._face ?? null;

// Inside route handler — called per-request, not at mount time
const faceService = typeof getFaceService === 'function'
  ? getFaceService()
  : getFaceService;
```

---

## 4. Client-Side Design

### 4.1 FaceGalleryTab Component (`client/src/components/FaceGalleryTab.tsx`)

**Component tree:**
```
FaceGalleryTab
├─ Missing Person Alert Banner       (conditional, latestMissing state)
├─ Header
│   ├─ Tab title + missing badge    (missingCount > 0)
│   └─ Gallery create row
│       ├─ TypeSelector (dropdown)
│       ├─ Name input
│       └─ Create button
├─ Gallery List (grouped by type)
│   └─ GallerySection × 4           (missing → vip → blocklist → general)
│       └─ Gallery row buttons
├─ Selected Gallery Content
│   ├─ TypePill + gallery name
│   ├─ UploadArea (FR-FAC-054)
│   └─ FaceCard grid × N            (FR-FAC-055)
└─ Live Matches panel
    └─ MatchLog                      (FR-FAC-056)
```

**State management:**

| State | Type | Purpose |
|---|---|---|
| `galleries` | `FaceGallery[]` | All galleries from server |
| `selectedId` | `string \| null` | Currently selected gallery |
| `faces` | `EnrolledFace[]` | Faces in selected gallery |
| `matchLog` | `FaceMatchEvent[]` | Up to 50 most recent matches |
| `newGallName` | `string` | Create gallery input value |
| `newGallType` | `GalleryType` | Create gallery type selector value |
| `showTypeMenu` | `boolean` | Dropdown open state |
| `creating` | `boolean` | Create operation in progress |
| `loadingFaces` | `boolean` | Face list loading state |

**Socket.IO subscription:**
```typescript
// Reads from window.__ltsSocket (set by App.tsx)
const socket = (window as any).__ltsSocket;
socket.on('face_match', handler);
// matchLog stored in ref (matchLogRef) to avoid stale closure
// then sync to state
```

### 4.2 GALLERY_TYPE_META

```typescript
const GALLERY_TYPE_META: Record<GalleryType, {
  icon:       string;
  labelKey:   keyof Translations;
  badgeClass: string;   // Tailwind classes for badge pill
  rowClass:   string;   // Tailwind class for left border
}> = {
  missing:   { icon: '🔍', labelKey: 'galleryTypeMissing',  badgeClass: 'bg-red-700 text-red-100',      rowClass: 'border-l-red-500'    },
  vip:       { icon: '⭐', labelKey: 'galleryTypeVip',      badgeClass: 'bg-yellow-700 text-yellow-100', rowClass: 'border-l-yellow-500' },
  blocklist: { icon: '🚫', labelKey: 'galleryTypeBlocklist', badgeClass: 'bg-orange-700 text-orange-100', rowClass: 'border-l-orange-500' },
  general:   { icon: '🗃', labelKey: 'galleryTypeGeneral',  badgeClass: 'bg-gray-700 text-gray-300',     rowClass: 'border-l-blue-500'   },
};

const GALLERY_TYPE_ORDER: GalleryType[] = ['missing', 'vip', 'blocklist', 'general'];
```

### 4.3 TypeScript Interfaces (`client/src/types/index.ts`)

```typescript
export type GalleryType = 'general' | 'vip' | 'blocklist' | 'missing';

export interface FaceGallery {
  id:          string;
  name:        string;
  description: string;
  type:        GalleryType;
  faceCount:   number;
  createdAt:   string;
}

export interface EnrolledFace {
  id:        string;
  galleryId: string;
  name:      string;
  thumbnail: string;   // data:image/jpeg;base64,...
  score:     number;
  createdAt: string;
}

export interface FaceMatchEvent {
  faceId:      string;
  cameraId:    string;
  identity:    string;
  galleryId:   string;
  galleryType: GalleryType;
  matchScore:  number;
  thumbnail:   string;
  timestamp:   number;
}
```

---

## 5. Data Model

### 5.1 DB Tables (lts.json)

**faceGalleries**
```
id          UUID v4       Primary key
name        string        Display name (trimmed)
description string        Optional notes
type        GalleryType   'general' | 'vip' | 'blocklist' | 'missing'
createdAt   ISO-8601      Set by db.insert()
updatedAt   ISO-8601      Set by db.insert()
```

**faceGalleryFaces**
```
id          UUID v4       Primary key
galleryId   UUID v4       Foreign key → faceGalleries.id
name        string        Person display name
embedding   number[]      512-element float32 array (never exposed via API)
thumbnail   string        data:image/jpeg;base64,... (64×64)
bbox        {x,y,w,h}    Source face location in uploaded photo
score       number        SCRFD detection confidence
createdAt   ISO-8601
updatedAt   ISO-8601
```

### 5.2 In-Memory Structures

**_sharedFaceGallery entry:**
```typescript
{ faceId: string; embedding: number[]; lastSeenAt: number; lastCameraId: string; }
```

**_persistentGallery entry (from DB, filtered):**
```typescript
// All faceGalleryFaces where Array.isArray(embedding) && embedding.length > 0
{ id, galleryId, name, embedding, thumbnail }
```

**_faceMatchCooldown:**
```typescript
Map<`${faceId}:${galleryFaceId}`, lastEmitTimestampMs>
```

---

## 6. API Design

### 6.1 Gallery CRUD

```
GET  /api/galleries
  → 200: { success: true, data: FaceGallery[] }  (sorted by createdAt DESC)
  → 500: { success: false, error: string }

POST /api/galleries
  Body: { name: string, description?: string, type?: GalleryType }
  → 201: { success: true, data: FaceGallery & { faceCount: 0 } }
  → 400: { success: false, error: 'name is required' }
  → 500: { success: false, error: string }

DELETE /api/galleries/:id
  → 200: { success: true }
  → 404: { success: false, error: 'Gallery not found' }
  → 500: { success: false, error: string }
```

### 6.2 Face Enrollment

```
POST /api/galleries/:id/faces
  Content-Type: multipart/form-data
  Fields: photo (file), name (string)
  → 201: { success: true, data: EnrolledFace }   (embedding excluded)
  → 400: { success: false, error: 'photo field is required' }
  → 404: { success: false, error: 'Gallery not found' }
  → 422: { success: false, error: 'No face detected...' }
  → 422: { success: false, error: 'Could not extract face embedding...' }
  → 503: { success: false, error: 'Face service not available — models not loaded' }
  → 500: { success: false, error: string }

DELETE /api/galleries/:id/faces/:faceId
  → 200: { success: true }
  → 404: { success: false, error: 'Face not found' }
  → 500: { success: false, error: string }

GET /api/galleries/:id/faces
  → 200: { success: true, data: EnrolledFace[] }
  → 404: { success: false, error: 'Gallery not found' }
  → 500: { success: false, error: string }
```

### 6.3 Cross-Camera Stats

```
GET /api/faces/cross-camera-stats
  → 200: { success: true, data: CrossCameraReIdEvent[] }

GET /api/faces/trajectories?maxAgeMs=300000
  → 200: { success: true, data: PersonTrajectory[] }
```

---

## 7. Sequence Diagrams

### 7.1 Gallery Enrollment

```
Client                faceGallery.js      FaceService      PipelineManager     DB
  │                        │                  │                  │              │
  │── POST /galleries/:id/faces ──────────────>│                  │              │
  │                        │──getFaceService()─>│                  │              │
  │                        │<──FaceService ref ─│                  │              │
  │                        │──sharp normalize──>│                  │              │
  │                        │──detectFaces()────>│                  │              │
  │                        │<──[{bbox,score,lmk}]                 │              │
  │                        │──getEmbedding()───>│                  │              │
  │                        │<──Float32Array(512)│                  │              │
  │                        │──sharp thumbnail──>│                  │              │
  │                        │──db.insert()──────────────────────────────────────>│
  │                        │──reloadPersistentGallery()───────────>│              │
  │                        │                   │                   │──db.find()──>│
  │                        │                   │                   │<──faces[]────│
  │<── 201 { data: face }──│                   │                   │              │
```

### 7.2 Missing Person Detection (Per Frame)

```
Camera Frame    AttributePipeline    PipelineManager     DB         Socket.IO
     │                │                    │              │              │
     │──JPEG buf──────>│                   │              │              │
     │                │──detectFaces()     │              │              │
     │                │──getEmbedding()    │              │              │
     │                │──[embeddings]─────>│              │              │
     │                │                   │──cosine search _persistentGallery
     │                │                   │  sim=0.872 ≥ 0.35 → MATCH   │
     │                │                   │──db.findOne(galleryId)──────>│
     │                │                   │<──{type:'missing'}───────────│
     │                │                   │──cooldown check (30s)        │
     │                │                   │──emit 'face_match'───────────────────>│
     │                │                   │──emit 'missing_person_match'─────────>│
```

---

## 8. Configuration & Environment

### 8.1 Model Paths

```javascript
// faceService.js constructor defaults
const modelsDir = path.resolve(__dirname, '..', '..', 'models');
this.scrfdPath   = options.scrfdPath   || path.join(modelsDir, 'scrfd_2.5g.onnx');
this.arcfacePath = options.arcfacePath || path.join(modelsDir, 'arcface_w600k_r50.onnx');
```

### 8.2 Matching Thresholds

```javascript
// In _assignFaceIds()
const FACE_MATCH_THRESHOLD = 0.35;   // cosine similarity minimum for identity match
const GALLERY_EXPIRY_MS    = 30_000; // shared gallery entry TTL
const COOLDOWN_MS          = 30_000; // face_match event cooldown per faceId:galleryFaceId
```

### 8.3 Upload Limits (multer)

```javascript
limits:     { fileSize: 10 * 1024 * 1024 },  // 10 MB
fileFilter: accept image/jpeg|png|webp|gif
```

---

## 9. Error Handling

| Scenario | Handler | Response |
|---|---|---|
| Gallery not found on enroll | faceGallery.js | 404 |
| No file in upload | faceGallery.js | 400 |
| FaceService not ready | faceGallery.js | 503 |
| No face detected | faceGallery.js | 422 |
| Embedding fails | faceGallery.js | 422 |
| Sharp crop out-of-bounds | `Math.max(0, ...)` guard | prevents error |
| Gallery deleted mid-session (persistent gallery miss) | `_assignFaceIds` fallback | `galleryType: 'general'` |
| DB write failure | faceGallery.js catch | 500 |
| Model file missing at startup | FaceService.load() | `_status = 'missing'`, 503 on enroll |
| ONNX inference error | FaceService methods | null returned, 422 on enroll |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Face Recognition |
