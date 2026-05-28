# DESIGN DOCUMENT
# Dashboard Sidebar — Face ID Panel

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-FACE-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Dashboard_Sidebar_Face_ID.md (v1.1) |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Component Tree](#3-component-tree)
4. [State Management Design](#4-state-management-design)
5. [Socket.IO Subscription Design](#5-socketio-subscription-design)
6. [TypeScript Interface Definitions](#6-typescript-interface-definitions)
7. [REST API Integration](#7-rest-api-integration)
8. [Server-Side Design](#8-server-side-design)
9. [Storage Schema](#9-storage-schema)
10. [Sequence Diagrams](#10-sequence-diagrams)
11. [Error Handling](#11-error-handling)
12. [v1.1 Amendment — Live Match Crop & Search Architecture](#12-v11-amendment--live-match-crop--search-architecture)

---

## 1. Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                          CLIENT (React)                           │
│                                                                   │
│  App.tsx                                                          │
│   └─ Sidebar tabs: 'faces' → <FaceGalleryTab />                  │
│                                                                   │
│  FaceGalleryTab.tsx                                               │
│   ├─ Missing person banner (conditional)                          │
│   ├─ Gallery creation row (name input + type selector + create)   │
│   ├─ GallerySection × 4 types                                     │
│   │    └─ Gallery rows (expand/collapse)                          │
│   │         ├─ UploadArea (when gallery is selected)             │
│   │         └─ FaceCard[] grid                                    │
│   └─ MatchLog (Socket.IO face_match consumer)                     │
└───────────────────────────────────────────────────────────────────┘
              │  HTTP REST         │  WebSocket (Socket.IO)
┌─────────────▼───────────────────▼─────────────────────────────────┐
│  Server                                                           │
│  router: server/src/api/faceGallery.js                           │
│     GET    /api/galleries                                         │
│     POST   /api/galleries                                         │
│     DELETE /api/galleries/:id                                     │
│     GET    /api/galleries/:id/faces                               │
│     POST   /api/galleries/:id/faces  (multer + sharp + ONNX)     │
│     DELETE /api/galleries/:id/faces/:faceId                       │
│                                                                   │
│  FaceService: server/src/services/faceService.js                  │
│     detectFaces(buf)  → SCRFD ONNX → bboxes + landmarks          │
│     extractEmbedding(crop) → ArcFace ONNX → Float32[512]         │
│                                                                   │
│  PipelineManager: _persistentGallery cache                        │
│     reloadPersistentGallery()  → DB query → in-memory array      │
│     _sharedFaceGallery         → runtime session faces (30s)      │
│     _personTrajectory          → Map<faceId, PersonTrajectory>    │
└───────────────────────────────────────────────────────────────────┘
              │  JSON read/write
┌─────────────▼──────────────────┐
│  storage/lts.json              │
│   faceGalleries table          │
│   faceGalleryFaces table       │
├────────────────────────────────┤
│  storage/face_tracking.json    │
│   faceCounter                  │
│   personAliasCounter           │
│   trajectories[]               │
└────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── client/
│   └── src/
│       ├── components/
│       │   └── FaceGalleryTab.tsx         # Main tab component
│       ├── types/
│       │   └── index.ts                   # FaceGallery, EnrolledFace, FaceMatchEvent, GalleryType
│       └── i18n/
│           └── index.ts                   # tabFaceGallery, faceEnroll, galleryType* keys
│
├── server/
│   └── src/
│       ├── api/
│       │   └── faceGallery.js             # Express router — all 6 endpoints
│       ├── services/
│       │   ├── faceService.js             # SCRFD + ArcFace ONNX inference
│       │   └── pipelineManager.js         # _persistentGallery, _personTrajectory, face_tracking.json
│       └── db.js                          # JSON DB — faceGalleries, faceGalleryFaces tables
│
└── storage/
    ├── lts.json                           # Persistent galleries + enrolled faces
    └── face_tracking.json                 # Person trajectory + counters (auto-created)
```

---

## 3. Component Tree

```
FaceGalleryTab                              (FaceGalleryTab.tsx)
│
├── [Banner] Missing person alert          (conditional, animate-pulse)
│
├── Gallery creation row
│   ├── <input> gallery name
│   ├── Type dropdown (showTypeMenu state)
│   │   └── [missing, vip, blocklist, general] options
│   └── [+ Create] button
│
├── GallerySection (type = 'missing')      (GallerySection component)
│   └── Gallery rows × N
│       ├── Gallery name + GalleryBadge + ✕ delete
│       └── [when selectedId === gallery.id]
│           ├── UploadArea                 (UploadArea component)
│           │   ├── Dashed drop zone (preview / hint)
│           │   ├── <input type=text> name
│           │   ├── Error text (conditional)
│           │   └── [Enroll] button
│           └── FaceCard × N              (FaceCard component)
│               ├── <img> 48×48 thumbnail (or 👤 fallback)
│               ├── name label
│               └── ✕ delete button (hover)
│
├── GallerySection (type = 'vip')
├── GallerySection (type = 'blocklist')
├── GallerySection (type = 'general')
│
└── MatchLog                               (MatchLog component)
    └── match rows × N (max 50)
        ├── thumbnail 28×28
        ├── type icon + person name + score%
        └── cameraId + timestamp
```

---

## 4. State Management Design

### 4.1 Component-Local State (FaceGalleryTab)

All state is local to `FaceGalleryTab` — no global Zustand store is used.

```typescript
const [galleries, setGalleries]           = useState<FaceGallery[]>([]);
const [selectedId, setSelectedId]         = useState<string | null>(null);
const [faces, setFaces]                   = useState<EnrolledFace[]>([]);
const [matchLog, setMatchLog]             = useState<FaceMatchEvent[]>([]);
const [newGallName, setNewGallName]       = useState('');
const [newGallType, setNewGallType]       = useState<GalleryType>('general');
const [creating, setCreating]             = useState(false);
const [loadingFaces, setLoadingFaces]     = useState(false);
const [showTypeMenu, setShowTypeMenu]     = useState(false);
const matchLogRef = useRef<FaceMatchEvent[]>([]);  // ref for Socket.IO handler closure
```

### 4.2 State Transitions

| Action | State Change |
|---|---|
| Mount | `fetchGalleries()` → `setGalleries` |
| Select gallery | `setSelectedId(id)` → `fetchFaces(id)` → `setFaces` |
| Deselect gallery | `setSelectedId(null)` → `setFaces([])` |
| Create gallery | `POST` → `fetchGalleries()` → `setSelectedId(newId)` |
| Delete gallery | `DELETE` → `fetchGalleries()` → if deleted==selected: `setSelectedId(null)` |
| Enroll face | `POST` → reset upload state → `fetchFaces(selectedId)` |
| Delete face | `DELETE` → `setFaces(prev.filter(...))` → decrement `faceCount` in galleries |
| face_match event | prepend to `matchLogRef.current` → `setMatchLog([...ref])` (max 50) |

### 4.3 Derived State

```typescript
const selectedGallery = galleries.find(g => g.id === selectedId) ?? null;
const missingCount = galleries
  .filter(g => (g.type || 'general') === 'missing')
  .reduce((s, g) => s + g.faceCount, 0);
const latestMissing = matchLog.find(e => e.galleryType === 'missing');
```

---

## 5. Socket.IO Subscription Design

```typescript
useEffect(() => {
  const socket = (window as unknown as { __ltsSocket?: SocketType }).__ltsSocket;
  if (!socket) return;

  const handler = (ev: unknown) => {
    const next = [ev as FaceMatchEvent, ...matchLogRef.current].slice(0, 50);
    matchLogRef.current = next;
    setMatchLog([...next]);
  };

  socket.on('face_match', handler);
  return () => socket.off('face_match', handler);   // cleanup on unmount
}, []);
```

**Design rationale**: `matchLogRef` is used alongside `matchLog` state to avoid stale closures in the Socket.IO event handler. The ref is updated synchronously; state is updated (triggering re-render) immediately after.

---

## 6. TypeScript Interface Definitions

```typescript
// client/src/types/index.ts

export type GalleryType = 'missing' | 'vip' | 'blocklist' | 'general';

export interface FaceGallery {
  id:        string;
  name:      string;
  type:      GalleryType;
  faceCount: number;
  createdAt: number;       // Unix ms
}

export interface EnrolledFace {
  id:        string;       // UUID
  galleryId: string;
  name:      string;
  thumbnail: string;       // base64 JPEG data URI "data:image/jpeg;base64,..."
  createdAt: number;
}

export interface FaceMatchEvent {
  faceId:      string;     // Live session face ID ("F7")
  identity:    string;     // Enrolled person name
  galleryId:   string;
  galleryName: string;
  galleryType: GalleryType;
  matchScore:  number;     // 0–1 cosine similarity
  cameraId:    string;
  timestamp:   number;
  thumbnail?:  string;     // Face crop from live frame (optional)
}
```

---

## 7. REST API Integration

### 7.1 Client Fetch Patterns

```typescript
const API = '/api/galleries';

// List galleries
const r = await fetch(API);
const j = await r.json();
if (j.success) setGalleries(j.data);

// Create gallery
const r = await fetch(API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: newGallName.trim(), type: newGallType }),
});

// Enroll face (multipart)
const form = new FormData();
form.append('photo', file);
form.append('name', name.trim() || 'Unknown');
const r = await fetch(`${API}/${galleryId}/faces`, { method: 'POST', body: form });

// Delete face
await fetch(`${API}/${selectedId}/faces/${faceId}`, { method: 'DELETE' });
```

### 7.2 Error Handling

All fetch calls are wrapped in `try/catch`. Non-2xx responses throw an error using `response.json().error` message. Errors are surfaced to the user via component-local `error` state (red text).

---

## 8. Server-Side Design

### 8.1 `server/src/api/faceGallery.js`

```
Router: express.Router()
  GET    /                  → db.find('faceGalleries', {}) + faceCount computed
  POST   /                  → db.create('faceGalleries', { id: uuid, name, type, createdAt })
  DELETE /:id               → db.delete('faceGalleries', id) + cascade faceGalleryFaces
  GET    /:id/faces         → db.find('faceGalleryFaces', { galleryId: id })
                              (embedding field stripped from response — not sent to client)
  POST   /:id/faces         → multer() → sharp normalize → faceService.detectFaces()
                            → faceService.extractEmbedding() → db.create('faceGalleryFaces', ...)
                            → pipelineManager.reloadPersistentGallery()
  DELETE /:id/faces/:faceId → db.delete('faceGalleryFaces', faceId)
                            → pipelineManager.reloadPersistentGallery()
```

### 8.2 `server/src/services/faceService.js`

```
FaceService
  constructor()
    - Loads scrfd_2.5g.onnx + arcface_w600k_r50.onnx via onnxruntime-node
    - Throws if models not found (server continues in degraded mode)

  async detectFaces(imageBuffer: Buffer) → Face[]
    - Runs SCRFD inference (input: normalized RGB 640×640)
    - Returns [{ bbox: {x,y,w,h}, landmarks, score }]

  async extractEmbedding(faceBuffer: Buffer) → Float32Array(512)
    - Crops face region, resizes to 112×112 (ArcFace input)
    - Runs ArcFace inference → 512-dim L2-normalized vector

  isReady() → boolean
    - Returns true if both models are loaded
```

### 8.3 `server/src/services/pipelineManager.js` — Face-Related Fields

```javascript
// In-memory (session only, 30s expiry)
this._sharedFaceGallery = [];   // [{ faceId, embedding, lastSeenAt, lastCameraId }]
this._faceCounter       = 1;    // F1, F2, F3...  (persisted)

// Persistent (loaded from DB on demand)
this._persistentGallery = [];   // [{ id, galleryId, name, embedding, thumbnail }]
this._faceMatchCooldown = new Map(); // `${faceId}:${galleryFaceId}` → lastEmittedAt

// Person trajectory (persisted to face_tracking.json)
this._personTrajectory   = new Map(); // faceId → PersonTrajectory
this._personAliasCounter = 0;         // P1, P2, P3...  (persisted)
this._faceTrackingSaveTimer = null;    // debounce handle

// Methods
reloadPersistentGallery()   → reload from DB
_loadFaceTracking()         → read face_tracking.json on startup
_saveFaceTracking()         → write face_tracking.json synchronously
_scheduleFaceTrackingSave() → debounced 1s before _saveFaceTracking()
_assignFaceIds(cameraId, detectedFaces, timestamp) → adds faceId + matchScore to each face
```

---

## 9. Storage Schema

### 9.1 `storage/lts.json` — faceGalleries Table

```json
{
  "faceGalleries": [
    {
      "id":        "550e8400-e29b-41d4-a716-446655440000",
      "name":      "Missing Persons",
      "type":      "missing",
      "createdAt": 1748389200000
    }
  ]
}
```

### 9.2 `storage/lts.json` — faceGalleryFaces Table

```json
{
  "faceGalleryFaces": [
    {
      "id":        "a1b2c3d4-...",
      "galleryId": "550e8400-...",
      "name":      "Alice Kim",
      "embedding": [0.123, -0.456, ...],   // Float32[512] as JSON array
      "thumbnail": "data:image/jpeg;base64,/9j/...",  // base64, 96×96
      "createdAt": 1748389260000
    }
  ]
}
```

### 9.3 `storage/face_tracking.json`

```json
{
  "faceCounter": 42,
  "personAliasCounter": 7,
  "trajectories": [
    {
      "faceId": "F38",
      "alias": "P5",
      "firstSeenAt": 1748389300000,
      "lastSeenAt":  1748389450000,
      "currentCameraId": "e91740de-1234-5678-abcd-000000000000",
      "segments": [
        {
          "cameraId":  "e91740de-1234-5678-abcd-000000000000",
          "objectId":  12,
          "entryTime": 1748389300000,
          "exitTime":  1748389450000
        }
      ]
    }
  ]
}
```

---

## 10. Sequence Diagrams

### 10.1 Face Enrollment

```
User          FaceGalleryTab         Server (faceGallery.js)     FaceService      DB
 │                  │                         │                       │            │
 │──drop photo──>   │                         │                       │            │
 │                  │ preview shown            │                       │            │
 │──enter name──>   │                         │                       │            │
 │──[Enroll]──>     │                         │                       │            │
 │                  │──POST /galleries/:id/faces (multipart)──>       │            │
 │                  │                         │──sharp normalize──>   │            │
 │                  │                         │──detectFaces()──>     │            │
 │                  │                         │               <──bbox+score──       │
 │                  │                         │──extractEmbedding()─> │            │
 │                  │                         │               <──Float32[512]──     │
 │                  │                         │──create('faceGalleryFaces', ...)──> │
 │                  │                         │──reloadPersistentGallery()          │
 │                  │<── 200 EnrolledFace ────│                       │            │
 │                  │ reset state + fetchFaces │                       │            │
 │<── face card ─── │                         │                       │            │
```

### 10.2 Live Face Match

```
Camera Frame    PipelineManager         Socket.IO         FaceGalleryTab
      │                │                    │                    │
      │──JPEG frame──> │                    │                    │
      │                │──YOLO detect──>    │                    │
      │                │──ArcFace embed──>  │                    │
      │                │──compare vs        │                    │
      │                │  _persistentGallery│                    │
      │                │──match found──>    │                    │
      │                │──emit('face_match')─────────────────>   │
      │                │                    │  setMatchLog (max 50)│
      │                │                    │  latestMissing banner│
```

### 10.3 Server Restart — Data Restoration

```
Server startup
  │
  ├── PipelineManager constructor
  │     └── _loadFaceTracking()
  │           ├── read face_tracking.json
  │           ├── restore _faceCounter
  │           ├── restore _personAliasCounter
  │           └── restore _personTrajectory Map
  │
  └── faceGallery router registered
        └── GET /api/galleries → reads lts.json → returns galleries (all faces intact)
```

---

## 11. Storage Backend Architecture

### 11.1 Storage Mode Overview

The server supports two storage backends, selected via `DB_TYPE` in `server/.env`:

```
DB_TYPE=json      Default — synchronous JSON file I/O (no external dependencies)
DB_TYPE=mongodb   MongoDB — async write-through with JSON hot-standby backup
```

### 11.2 Dual-Backend Design

```
┌─────────────────────────────────────────────────────────────────┐
│                    Route Handlers (faceGallery.js)              │
│         db.insert() / db.find() / db.update() / db.delete()     │
│         (always synchronous — reads from in-memory store)       │
└───────────────────────────┬─────────────────────────────────────┘
                            │ in-memory write
                            ▼
                ┌───────────────────────┐
                │   In-Memory Store     │  ← source of truth for reads
                │   (store: Object)     │
                └────────┬─────────────┘
                         │ afterWrite()
               ┌─────────┴──────────────┐
               │                        │
               ▼                        ▼
   ┌─────────────────────┐  ┌────────────────────────┐
   │  JSON File (always) │  │  MongoDB (if connected) │
   │  storage/lts.json   │  │  mongoDbService.upsert()│
   │  (sync write)       │  │  (async fire-and-forget)│
   └─────────────────────┘  └────────────────────────┘
      Hot-standby backup        Primary DB (when enabled)
```

### 11.3 File Structure

| File | Role |
|---|---|
| `server/src/db.js` | In-memory store + JSON persistence + MongoDB write-through dispatcher |
| `server/src/services/mongoDbService.js` | Mongoose connection manager, CRUD adapter, `loadAll()` for startup hydration |
| `server/storage/lts.json` | JSON store file (default mode) / hot-standby backup (MongoDB mode) |
| `server/storage/face_tracking.json` | Face tracking runtime state (always JSON, managed by pipelineManager) |

### 11.4 MongoDB Collections

When `DB_TYPE=mongodb`, the following collections are used (auto-created on first write):

| Collection | Schema key fields | Notes |
|---|---|---|
| `cameras` | `id`, `url`, `name`, `type` | Camera registry |
| `zones` | `id`, `cameraId`, `name`, `polygon` | Detection zones |
| `events` | `id`, `cameraId`, `type`, `ts` | Detection event log |
| `alerts` | `id`, `eventId`, `type`, `ack` | Alert records |
| `faceGalleries` | `id`, `name`, `type`, `description` | Gallery metadata |
| `faceGalleryFaces` | `id`, `galleryId`, `name`, `embedding`, `thumbnail` | Enrolled faces + 512-D embeddings |

All collections use a flexible Mongoose schema (`strict: false`) with `id` (UUID string) as the logical primary key.

### 11.5 Startup Data Recovery Sequence

```
Server starts (main() in index.js)
  │
  ├─ 1. db.js: loadFromJson()          — read storage/lts.json into memory
  │
  ├─ 2. DB_TYPE=mongodb?
  │     YES → mongoDbService.connect()
  │          → mongoDbService.loadAll()
  │          → for each table:
  │              if Mongo has rows: replace in-memory from Mongo
  │              if Mongo empty + JSON has rows: seed Mongo from JSON
  │     NO  → continue with JSON data (already in memory)
  │
  ├─ 3. pipelineManager.loadFaceServiceEagerly()
  │     → ONNX models loaded
  │
  └─ 4. pipelineManager.reloadPersistentGallery()
        → db.all('faceGalleryFaces') → all embeddings loaded into matching index
        → Face recognition active immediately
```

### 11.6 Environment Configuration

Add the following to `server/.env`:

```ini
# ── Storage Backend ─────────────────────────────────────────────────────
# DB_TYPE=json     : Default, no external dependencies required
# DB_TYPE=mongodb  : MongoDB mode; MONGODB_URI must be set
DB_TYPE=json

# MongoDB connection URI (required when DB_TYPE=mongodb)
MONGODB_URI=mongodb://localhost:27017/lts

# MongoDB database name override (optional)
MONGODB_DB_NAME=lts
```

### 11.7 Docker Compose Volume Mapping

When running via Docker, ensure the storage volume is correctly mapped:

```yaml
# docker-compose.yml
services:
  server:
    volumes:
      - ./storage:/app/storage       # JSON file persistence
    environment:
      - STORAGE_PATH=/app/storage
      # To use MongoDB:
      # - DB_TYPE=mongodb
      # - MONGODB_URI=mongodb://mongo:27017/lts

  # Optional: add MongoDB service
  mongo:
    image: mongo:7
    volumes:
      - mongo_data:/data/db
    ports:
      - "27017:27017"

volumes:
  mongo_data:
```

---

## 12. Error Handling

### 12.1 Client Error States

| Scenario | Handler | User Feedback |
|---|---|---|
| `GET /api/galleries` fails | `catch` → log, no state change | Silent (stale list shown) |
| `POST /api/galleries` fails | `catch` → no state change | No error shown (creating spinner stops) |
| Enrollment: non-2xx | `throw new Error(j.error)` | Red error text below name input |
| Enrollment: no face | Server returns `{ success: false, error: "No face detected" }` | Red error text |
| Enrollment: 503 (model not loaded) | Server returns `{ success: false, error: "Face service not available" }` | Red error text |
| `DELETE` fails | `catch` → log | Silent (item remains in list) |
| `window.__ltsSocket` not found | `if (!socket) return` | No subscription (no crash) |

### 12.2 Server Error Responses

| Condition | HTTP Status | Body |
|---|---|---|
| Gallery not found | `404` | `{ success: false, error: "Gallery not found" }` |
| Face record not found | `404` | `{ success: false, error: "Face not found" }` |
| No face detected in photo | `400` | `{ success: false, error: "No face detected" }` |
| Model files not loaded | `503` | `{ success: false, error: "Face service not available" }` |
| File too large | `400` | multer error passthrough |
| DB write failure | `500` | `{ success: false, error: "Internal error" }` |

### 12.3 MongoDB Failure Handling

| Condition | Behavior |
|---|---|
| MongoDB unreachable at startup | Warning logged; server falls back to JSON mode; service starts normally |
| MongoDB disconnects mid-operation | Write goes to JSON only; MongoDB re-queued on reconnect (via Mongoose auto-reconnect) |
| MongoDB write error (upsert/delete) | Error logged; in-memory and JSON are still updated; no request failure |

---

## 13. v1.1 Amendment — Live Match Crop & Search Architecture

### 13.1 Problem Statement

In v1.0, `_assignFaceIds()` emits `face_match` Socket.IO events **synchronously** inside itself, but the JPEG frame buffer (`jpegBuffer`) is not passed to this method. Adding an async `sharp` crop operation requires refactoring the call boundary.

### 13.2 `_assignFaceIds` Refactor Design

#### Before (v1.0)
```
_assignFaceIds(cameraId, detectedFaces, timestamp) {
  ...
  this._io.emit('face_match', matchEvt);  // direct emit, no crop
  ...
  return { faces, crossCameraTransitions };
}
```

#### After (v1.1)
```
_assignFaceIds(cameraId, detectedFaces, timestamp) {
  const pendingMatchEvents = [];
  ...
  // Instead of emit:
  pendingMatchEvents.push({ evt: matchEvt, faceBbox: face.bbox });
  ...
  return { faces, crossCameraTransitions, pendingMatchEvents };
}
```

Caller (frame handler in `capture.on('frame', ...)`):
```js
const { faces: namedFaces, crossCameraTransitions, pendingMatchEvents }
  = this._assignFaceIds(camera.id, detectedFaces, timestamp);

// Async crop + emit (non-blocking, one event loop tick later)
if (pendingMatchEvents.length > 0) {
  setImmediate(async () => {
    for (const { evt, faceBbox } of pendingMatchEvents) {
      let liveCropData;
      try {
        if (snapshotSvc.isEnabled() && jpegBuffer) {
          const { data: cropBuf } = await snapshotSvc.cropJpeg(
            jpegBuffer, faceBbox, frameWidth, frameHeight
          );
          liveCropData = 'data:image/jpeg;base64,' + cropBuf.toString('base64');
        }
      } catch (_) { /* non-fatal */ }

      const fullEvt = { ...evt, ...(liveCropData ? { liveCropData } : {}) };
      this._io.emit('face_match', fullEvt);
      if (fullEvt.galleryType === 'missing') {
        this._io.emit('missing_person_match', fullEvt);
      }

      // Persist to faceMatchHistory
      try {
        this._db.insert('faceMatchHistory', {
          id:          uuidv4(),
          ...fullEvt,
          createdAt:   new Date(evt.timestamp).toISOString(),
        });
      } catch (e) {
        console.warn('[PipelineManager] faceMatchHistory insert error:', e.message);
      }
    }
  });
}
```

### 13.3 `faceMatchHistory` DB Table Schema

Added to `ALL_TABLES` in `server/src/db.js`:

```json
{
  "id":           "uuid (primary key)",
  "faceId":       "string — live gallery face ID",
  "cameraId":     "uuid — source camera",
  "identity":     "string — enrolled person name",
  "galleryId":    "uuid — matched gallery",
  "galleryType":  "GalleryType",
  "matchScore":   "number — cosine similarity (0–1)",
  "thumbnail":    "string — base64 JPEG enrolled photo",
  "liveCropData": "string? — base64 JPEG live face crop",
  "timestamp":    "number — event Unix ms",
  "createdAt":    "ISO string — record creation time"
}
```

### 13.4 Search API Extension

`server/src/api/search.js` — `GET /api/search?q=&types=matches` extension:

```js
if (typeSet.has('matches') || typeSet.has('faces')) {
  const history = db.find('faceMatchHistory', r =>
    !q || r.identity?.toLowerCase().includes(q)
  );
  results.push(...history.slice(0, 50).map(r => ({
    _type:       'match',
    id:          r.id,
    identity:    r.identity,
    galleryType: r.galleryType,
    matchScore:  r.matchScore,
    cameraId:    r.cameraId,
    timestamp:   r.timestamp,
    thumbnail:   r.thumbnail,
    liveCropData:r.liveCropData,
  })));
}
```

### 13.5 Client — Updated `FaceMatchEvent` Interface

```typescript
// client/src/types/index.ts
interface FaceMatchEvent {
  faceId:        string;
  cameraId:      string;
  identity:      string;
  galleryId:     string;
  galleryType:   GalleryType;
  matchScore:    number;
  thumbnail?:    string;
  liveCropData?: string;      // NEW v1.1 — live face crop
  timestamp:     number;
}
```

### 13.6 Client — MatchLog Row Layout Change

`FaceGalleryTab.tsx` — MatchLog entry (before):
```tsx
<img src={ev.thumbnail} className="w-7 h-7 rounded object-cover" />
```

After (v1.1 dual photo):
```tsx
{/* Enrolled gallery photo */}
{ev.thumbnail
  ? <img src={ev.thumbnail} className="w-7 h-7 rounded object-cover" title="Enrolled" />
  : <span className="w-7 h-7 flex items-center justify-center text-sm">👤</span>
}
{/* Live crop from frame */}
{ev.liveCropData
  ? <img src={ev.liveCropData} className="w-7 h-7 rounded object-cover ring-1 ring-blue-500" title="Live" />
  : <span className="w-7 h-7 flex items-center justify-center text-xs text-gray-600">👤</span>
}
```

### 13.7 `SearchBar` — `match` Result Type

`SearchBar.tsx` handles `_type: 'match'` identically to `_type: 'face'`: navigates to `faces` tab and shows `liveCropData` or `thumbnail` as the preview image.

### 13.8 Sequence Diagram — v1.1 face_match Flow

```
Camera frame arrives
  │
  ├─ pipelineManager: _assignFaceIds()
  │    └─ [match found] pendingMatchEvents.push({ evt, faceBbox })
  │    └─ returns { faces, crossCameraTransitions, pendingMatchEvents }
  │
  └─ setImmediate(async () =>
       for each { evt, faceBbox } in pendingMatchEvents:
         ├─ snapshotSvc.cropJpeg(jpegBuffer, faceBbox) → liveCropData
         ├─ io.emit('face_match', { ...evt, liveCropData })
         ├─ [galleryType==='missing'] io.emit('missing_person_match', ...)
         └─ db.insert('faceMatchHistory', { id, ...evt, liveCropData, createdAt })
     )

Client (FaceGalleryTab)
  └─ socket.on('face_match', ev)
       └─ setMatchLog([ev, ...prev].slice(0, 50))
            └─ renders [enrolled photo] [live crop] [badge] [name] [score] [meta]
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Dashboard Sidebar Face ID |
