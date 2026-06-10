# DESIGN DOCUMENT
# Cross-Camera Face Tracking & Global Person Registry

| | |
|---|---|
| **Document ID** | DESIGN-LTS-CCFR-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_CrossCamera_Face_Tracking.md |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design](#3-server-side-design)
4. [Client-Side Design](#4-client-side-design)
5. [Data Model](#5-data-model)
6. [API Design](#6-api-design)
7. [Sequence Diagrams](#7-sequence-diagrams)
8. [Configuration and Thresholds](#8-configuration-and-thresholds)
9. [Error Handling](#9-error-handling)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLIENT (React + Zustand)                        │
│                                                                          │
│  App.tsx                                                                 │
│   ├─ socket.on('person:trajectory-update') → usePersonTrajectoryStore   │
│   ├─ socket.on('face:reidentified')        → usePersonTrajectoryStore   │
│   └─ onMount: GET /api/persons/active      → hydrate store              │
│                                                                          │
│  FullscreenCameraView.tsx                                                │
│   ├─ Person Trails panel (collapsible)                                   │
│   │    Shows all persons who visited this camera                        │
│   │    Format: P3 [F7]  Camera-A → Camera-B ► Here  87%  2m ago        │
│   └─ DetectionRow: teal alias badge (P3) next to face ID [F7]           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTP / WebSocket
┌──────────────────────────────▼──────────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)                         │
│                                                                          │
│  index.js                                                                │
│   ├─ GET /api/persons/active                                             │
│   ├─ GET /api/faces/trajectories                                         │
│   └─ GET /api/faces/cross-camera-stats                                   │
│                                                                          │
│  services/pipelineManager.js                                             │
│   ├─ _sharedFaceGallery[]         — in-memory cross-camera Re-ID        │
│   ├─ _faceCounter                 — F1, F2, … assignment                │
│   ├─ _crossCameraStats Map        — per-face transition stats            │
│   ├─ _personTrajectory Map        — Global Person Registry               │
│   ├─ _personAliasCounter          — P1, P2, … assignment                │
│   └─ _assignFaceIds()             — core Re-ID + trajectory logic       │
│                                                                          │
│  services/faceService.js                                                 │
│   └─ getEmbedding()               — ArcFace 512-D embedding             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── pipelineManager.js          # All Re-ID + registry logic
│   │   │   ├── faceService.js              # ArcFace ONNX wrapper
│   │   │   └── attributePipeline.js        # Composite pipeline (face+PPE+color)
│   │   └── index.js                        # REST route definitions
│
├── client/
│   └── src/
│       ├── stores/
│       │   └── personTrajectoryStore.ts    # Zustand store: Map<faceId, PersonTrajectory>
│       ├── components/
│       │   └── FullscreenCameraView.tsx    # Person Trails panel + alias badge
│       └── types/
│           └── index.ts                    # PersonSegment, PersonTrajectory interfaces
│
├── docs/
│   ├── srs/SRS_CrossCamera_Face_Tracking.md
│   └── design/Design_CrossCamera_Face_Tracking.md   ← this file
│
└── test/
    └── api/
        └── cross_camera_tracking.test.js
```

---

## 3. Server-Side Design

### 3.1 PipelineManager State Fields

```javascript
// In PipelineManager constructor:

// Shared gallery — cross-camera Re-ID
this._sharedFaceGallery = [];  // Array<SharedGalleryEntry>
this._faceCounter       = 1;   // next faceId number

// Cross-camera transition stats
this._crossCameraStats = new Map();  // Map<faceId, CrossCamStat>

// Global Person Registry — session-persistent, survives gallery expiry
this._personTrajectory   = new Map();  // Map<faceId, PersonTrajectory>
this._personAliasCounter = 0;          // P1, P2, … counter
```

**SharedGalleryEntry schema:**
```javascript
{
  faceId:       string,    // 'F1', 'F2', ...
  embedding:    number[],  // 512-D ArcFace, L2-normalised
  lastSeenAt:   number,    // Unix ms
  lastCameraId: string,    // most recent camera UUID
}
```

**CrossCamStat schema:**
```javascript
{
  faceId:          string,
  firstCameraId:   string,
  lastCameraId:    string,
  transitionCount: number,
  lastSeenAt:      number,
}
```

### 3.2 `_assignFaceIds()` — Core Algorithm

```javascript
_assignFaceIds(faces, cameraId, jpegBuffer, frameW, frameH) {
  const now = Date.now();
  const crossCameraTransitions = [];

  for (const face of faces) {
    // 1. Extract ArcFace embedding (512-D, L2-normalised)
    const embedding = await this._attrPipeline._face.getEmbedding(jpegBuffer, face.bbox);
    if (!embedding) continue;

    // 2. Search shared gallery
    let bestMatch = null;
    let bestSim   = -1;
    for (const entry of this._sharedFaceGallery) {
      const sim = _cosineSim(embedding, entry.embedding);
      if (sim > bestSim) { bestSim = sim; bestMatch = entry; }
    }

    let faceId;
    let isCrossCamera = false;

    if (bestSim >= FACE_MATCH_THRESH) {  // 0.35
      faceId = bestMatch.faceId;
      if (bestMatch.lastCameraId !== cameraId) {
        isCrossCamera = true;
        crossCameraTransitions.push({
          faceId, prevCameraId: bestMatch.lastCameraId,
          newCameraId: cameraId, similarity: bestSim,
        });
        // Update stats
        const stat = this._crossCameraStats.get(faceId) || {
          faceId, firstCameraId: bestMatch.lastCameraId, lastCameraId: cameraId,
          transitionCount: 0, lastSeenAt: now,
        };
        stat.transitionCount++;
        stat.lastCameraId = cameraId;
        stat.lastSeenAt   = now;
        this._crossCameraStats.set(faceId, stat);
      }
      bestMatch.lastSeenAt   = now;
      bestMatch.lastCameraId = cameraId;
    } else {
      // New face
      faceId = 'F' + this._faceCounter++;
      this._sharedFaceGallery.push({ faceId, embedding, lastSeenAt: now, lastCameraId: cameraId });
    }

    // 3. Update person registry
    const alias = this._updatePersonRegistry(faceId, cameraId, face, now, isCrossCamera);
    face.faceId = faceId;
    face.alias  = alias;
  }

  // 4. Prune expired entries
  const cutoff = now - FACE_EXPIRY_MS;  // 30 s
  this._sharedFaceGallery = this._sharedFaceGallery.filter(e => e.lastSeenAt > cutoff);

  return { faces, crossCameraTransitions };
}
```

### 3.3 `_updatePersonRegistry()` — Trajectory Management

```javascript
_updatePersonRegistry(faceId, cameraId, face, now, isCrossCamera) {
  const traj = this._personTrajectory.get(faceId);

  if (!traj) {
    // First ever detection of this faceId
    const alias = 'P' + (++this._personAliasCounter);
    const newTraj = {
      faceId,
      alias,
      firstSeenAt:     now,
      lastSeenAt:      now,
      currentCameraId: cameraId,
      segments: [{
        cameraId, objectId: face.objectId ?? null,
        entryTime: now, exitTime: now,
      }],
    };
    this._personTrajectory.set(faceId, newTraj);
    this._io.emit('person:trajectory-update', newTraj);
    return alias;
  }

  // Existing registry entry
  traj.lastSeenAt = now;

  if (isCrossCamera) {
    // Close previous segment
    traj.segments[traj.segments.length - 1].exitTime = now;
    // Resolve newObjectId via _bboxClose() scan of attrObjects
    const newObjectId = this._resolveObjectId(face.bbox);
    // Append new segment
    traj.segments.push({
      cameraId, objectId: newObjectId,
      entryTime: now, exitTime: now,
    });
    traj.currentCameraId = cameraId;
    this._io.emit('person:trajectory-update', { ...traj });
  } else {
    // Same camera: update exitTime of current segment only
    const lastSeg = traj.segments[traj.segments.length - 1];
    lastSeg.exitTime = now;
    if (face.objectId != null) lastSeg.objectId = face.objectId;
    // No event emitted for minor same-camera updates
  }

  return traj.alias;
}
```

### 3.4 `_resolveObjectId()` — Bbox Proximity Match

```javascript
_resolveObjectId(faceBbox, attrObjects) {
  // attrObjects: enriched persons from AttributePipeline
  for (const person of attrObjects) {
    if (person.face && _bboxClose(faceBbox, person.face.bbox, 3)) {
      return person.objectId;  // numeric ByteTracker ID
    }
  }
  return null;
}
```

**`_bboxClose(a, b, tol=3)` implementation:**
```javascript
function _bboxClose(a, b, tol = 3) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
      && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}
```

### 3.5 `_cosineSim()` — Embedding Similarity

```javascript
function _cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;  // dot product of L2-normalised vectors = cosine similarity
}
```

Both embeddings are L2-normalised by ArcFace, so dot product == cosine similarity directly, in range [−1, 1]; effective range [0, 1] for well-detected faces.

### 3.6 REST Route Handlers (in `index.js`)

```javascript
// GET /api/faces/trajectories?maxAgeMs=300000
app.get('/api/faces/trajectories', (req, res) => {
  const maxAgeMs = parseInt(req.query.maxAgeMs) || Infinity;
  const cutoff   = Date.now() - maxAgeMs;
  const data     = [...pipelineManager._personTrajectory.values()]
    .filter(t => t.lastSeenAt > cutoff);
  res.json({ success: true, data });
});

// GET /api/faces/cross-camera-stats
app.get('/api/faces/cross-camera-stats', (req, res) => {
  const data = [...pipelineManager._crossCameraStats.values()];
  res.json({ success: true, data });
});

// GET /api/persons/active?maxAgeMs=300000
app.get('/api/persons/active', (req, res) => {
  const maxAgeMs = parseInt(req.query.maxAgeMs) || 300_000;
  const cutoff   = Date.now() - maxAgeMs;
  const persons  = [...pipelineManager._personTrajectory.values()]
    .filter(t => t.lastSeenAt > cutoff);
  res.json({ success: true, total: persons.length, persons });
});
```

### 3.7 `getPersonTrajectories()` and `getCrossCameraStats()` Methods

```javascript
// Used internally and by REST handlers
getPersonTrajectories(maxAgeMs = Infinity) {
  const cutoff = Date.now() - maxAgeMs;
  return [...this._personTrajectory.values()]
    .filter(t => t.lastSeenAt > cutoff);
}

getCrossCameraStats() {
  return [...this._crossCameraStats.values()];
}
```

---

## 4. Client-Side Design

### 4.1 PersonTrajectory TypeScript Interfaces (`client/src/types/index.ts`)

```typescript
export interface PersonSegment {
  cameraId:  string;
  objectId:  number | null;
  entryTime: number;  // Unix ms
  exitTime:  number;  // Unix ms
}

export interface PersonTrajectory {
  faceId:          string;
  alias:           string;
  firstSeenAt:     number;
  lastSeenAt:      number;
  currentCameraId: string;
  segments:        PersonSegment[];
}
```

### 4.2 `usePersonTrajectoryStore` (Zustand)

```typescript
interface PersonTrajectoryStore {
  trajectories: Map<string, PersonTrajectory>;      // faceId → trajectory
  upsert: (t: PersonTrajectory) => void;
  hydrate: (list: PersonTrajectory[]) => void;
  getForCamera: (cameraId: string) => PersonTrajectory[];
}

// Implementation:
const usePersonTrajectoryStore = create<PersonTrajectoryStore>((set, get) => ({
  trajectories: new Map(),

  upsert: (t) => set(state => {
    const m = new Map(state.trajectories);
    m.set(t.faceId, t);
    return { trajectories: m };
  }),

  hydrate: (list) => set({
    trajectories: new Map(list.map(t => [t.faceId, t])),
  }),

  getForCamera: (cameraId) =>
    [...get().trajectories.values()]
      .filter(t => t.segments.some(s => s.cameraId === cameraId)),
}));
```

### 4.3 Socket.IO Listeners in `App.tsx`

```typescript
// On component mount:
useEffect(() => {
  // Hydrate store from REST endpoint
  fetch('/api/persons/active?maxAgeMs=300000')
    .then(r => r.json())
    .then(body => usePersonTrajectoryStore.getState().hydrate(body.persons));

  // Subscribe to real-time updates
  socket.on('person:trajectory-update', (traj: PersonTrajectory) => {
    usePersonTrajectoryStore.getState().upsert(traj);
  });

  return () => {
    socket.off('person:trajectory-update');
  };
}, []);
```

### 4.4 Person Trails Panel — Display Logic

The Person Trails panel appears in `FullscreenCameraView.tsx` as a collapsible section:

```
PERSON TRAILS (2)                                              ▲
 ● P3  [F7]  Camera-A → Camera-B ► Here      87%  2m ago
 ○ P1  [F2]  Entrance → Hallway  ► Here      91%  5m ago
```

**Rendering rules:**
- `●` (green dot) = person's `currentCameraId === this camera`
- `○` (gray dot) = person previously visited this camera
- Trail shows up to last 4 camera names, resolved from `cameraStore` (fallback: UUID prefix)
- `►` marks the current/last camera in the trail
- Clicking a trail entry calls `focusCamera(traj.currentCameraId)`
- Similarity % comes from the most recent `face:reidentified` event stored in the store

**Persons shown:** All trajectories from `usePersonTrajectoryStore.getForCamera(cameraId)`.

### 4.5 Alias Badge in `DetectionRow`

For face detection objects carrying a non-null `alias` field, a teal chip is rendered:

```typescript
// In DetectionRow:
{det.face?.alias && (
  <span className="bg-teal-600 text-white text-xs px-1 rounded font-mono">
    {det.face.alias}
  </span>
)}
// Renders as: [P3]  next to  [F7]
```

---

## 5. Data Model

### 5.1 In-Memory Structures (Server, Not Persisted)

**`_sharedFaceGallery` entry:**
```
faceId       string    'F1', 'F2', ...
embedding    number[]  512-D float32, L2-normalised
lastSeenAt   number    Unix ms — for TTL expiry (30 s)
lastCameraId string    UUID of most recent camera
```

**`_personTrajectory` entry (PersonTrajectory):**
```
faceId          string           Canonical key (matches sharedGallery entry)
alias           string           'P1', 'P2', ... (never changes once set)
firstSeenAt     number           Unix ms
lastSeenAt      number           Unix ms (updated every frame)
currentCameraId string           UUID of most recent camera
segments        PersonSegment[]  Ordered list of camera visits
```

**PersonSegment:**
```
cameraId   string        UUID of the camera visited
objectId   number|null   ByteTracker numeric ID in that camera
entryTime  number        Unix ms — first seen in this camera visit
exitTime   number        Unix ms — last seen (updated each frame)
```

**`_crossCameraStats` entry:**
```
faceId          string   Canonical face ID
firstCameraId   string   UUID of camera where face was first seen
lastCameraId    string   UUID of most recent camera
transitionCount number   Cumulative cross-camera transitions
lastSeenAt      number   Unix ms — most recent transition timestamp
```

### 5.2 Client Zustand State

```typescript
Map<faceId: string, PersonTrajectory>
```

Keyed by `faceId`. Each upsert replaces the full trajectory object (not a merge). The client treats the server's emitted `PersonTrajectory` as the source of truth.

---

## 6. API Design

### 6.1 Trajectory Endpoints

```
GET /api/faces/trajectories
GET /api/faces/trajectories?maxAgeMs=60000

  Response 200:
  {
    "success": true,
    "data": [
      {
        "faceId":          "F7",
        "alias":           "P3",
        "firstSeenAt":     1748000000000,
        "lastSeenAt":      1748000620000,
        "currentCameraId": "<camera-B-uuid>",
        "segments": [...]
      }
    ]
  }

  Errors:
    None expected (returns empty array on no data)
```

### 6.2 Cross-Camera Stats Endpoint

```
GET /api/faces/cross-camera-stats

  Response 200:
  {
    "success": true,
    "data": [
      {
        "faceId":          "F7",
        "firstCameraId":   "<camera-A-uuid>",
        "lastCameraId":    "<camera-B-uuid>",
        "transitionCount": 2,
        "lastSeenAt":      1748000620000
      }
    ]
  }
```

### 6.3 Active Persons Endpoint

```
GET /api/persons/active
GET /api/persons/active?maxAgeMs=300000

  Response 200:
  {
    "success": true,
    "total":   3,
    "persons": [PersonTrajectory, ...]
  }

  Default maxAgeMs: 300000 (5 minutes)
```

---

## 7. Sequence Diagrams

### 7.1 First Face Detection — New Person Registration

```
Camera Frame    PipelineManager           Socket.IO Clients
     │                │                         │
     │── JPEG buf ────►│                         │
     │                │── _assignFaceIds()       │
     │                │   embedding extracted    │
     │                │   no gallery match found │
     │                │   faceId = 'F' + counter │
     │                │   add to _sharedGallery  │
     │                │── _updatePersonRegistry() │
     │                │   no trajectory entry    │
     │                │   alias = 'P' + counter  │
     │                │   create PersonTrajectory│
     │                │   segments=[{cam, oid,   │
     │                │   entryTime, exitTime}]  │
     │                │── emit person:trajectory-update ──►│
     │                │── emit detections (alias='P1') ───►│
```

### 7.2 Cross-Camera Transition

```
Camera-B Frame   PipelineManager           Socket.IO Clients
     │                │                         │
     │── JPEG buf ────►│                         │
     │                │── _assignFaceIds()       │
     │                │   embedding extracted    │
     │                │   gallery match: F7      │
     │                │   lastCameraId = cam-A   │
     │                │   currentCamera = cam-B  │
     │                │   → CROSS-CAMERA!        │
     │                │── _resolveObjectId()     │
     │                │   scan attrObjects       │
     │                │   bboxClose match → 15   │
     │                │── emit face:reidentified ──────────►│
     │                │   {F7, cam-A, cam-B, 15, 0.87}     │
     │                │── _updatePersonRegistry() │
     │                │   close prev segment     │
     │                │   append new segment     │
     │                │   currentCameraId=cam-B  │
     │                │── emit person:trajectory-update ──►│
```

### 7.3 Page Load Hydration

```
Client (App.tsx)               REST API                PipelineManager
     │                             │                        │
     │── GET /api/persons/active ─►│                        │
     │                             │── getPersonTrajectories(300000ms)
     │                             │◄── PersonTrajectory[]  │
     │◄── 200 { persons: [...] } ──│                        │
     │── hydrate(persons)          │                        │
     │   [usePersonTrajectoryStore]│                        │
     │── listen person:trajectory-update ─────────────────►│
```

---

## 8. Configuration and Thresholds

```javascript
// In pipelineManager.js
const FACE_MATCH_THRESH = 0.35;   // cosine similarity — shared gallery matching
const FACE_EXPIRY_MS    = 30_000; // 30 s — shared gallery entry TTL

// In BehaviorEngine zone gallery (_checkAndEnrollAppearance)
const FACE_THRESH = 0.45;         // higher threshold for cross-ID tracking within zone
const EXPIRY_MS   = 120_000;      // 2 min zone gallery appearance memory
```

| Parameter | Value | Location | Description |
|-----------|-------|----------|-------------|
| `FACE_MATCH_THRESH` | 0.35 | pipelineManager.js | Min cosine sim for shared gallery match |
| `FACE_EXPIRY_MS` | 30,000 ms | pipelineManager.js | Shared gallery entry TTL |
| `maxAgeMs` (persons/active default) | 300,000 ms | index.js | Default filter window for active persons |
| `_bboxClose` tolerance | 3 px | pipelineManager.js | Object ID resolution via face bbox proximity |

---

## 9. SERVER_MODE별 궤적 관리 적용 범위

### 9.1 combined 모드 (`_processFrame`)

`_processFrame()`에서 `_assignFaceIds()` → `_updatePersonRegistry()` 순으로 호출되어
얼굴 감지 즉시 궤적이 갱신되고 `person:trajectory-update`가 emit됩니다.

### 9.2 streaming 모드 (`_processRemoteResult`)

streaming 서버는 analysis 서버로부터 HTTP 응답을 수신한 뒤 `_processRemoteResult()`를 실행합니다.
analysis 서버는 자체 `_assignFaceIds()`를 실행하고 결과를 응답에 포함시키며,
streaming 서버의 `_processRemoteResult()`는 반환된 `namedFaces`와 `crossCameraTransitions`를
사용해 로컬 `_personTrajectory`를 갱신합니다.

```javascript
// _processRemoteResult() — streaming 모드 궤적 갱신 흐름

// Step A: 크로스카메라 전환이 아닌 첫 감지 처리
const crossCameraFaceIds = new Set((crossCameraTransitions || []).map(ev => ev.faceId));
for (const f of namedFaces) {
  if (crossCameraFaceIds.has(f.faceId)) continue;          // Step B에서 처리
  const person = remoteTracked.find(obj =>
    obj.className === 'person' && obj.face && _bboxClose(obj.face.bbox, f.bbox)
  );
  const objectId = person?.objectId ?? null;
  const traj = this._personTrajectory.get(f.faceId);
  if (!traj) {
    // 신규 인물 — alias 부여
    const alias = `P${++this._personAliasCounter}`;
    const newTraj = { faceId: f.faceId, alias, firstSeenAt, lastSeenAt,
      currentCameraId, segments: [{ cameraId, objectId, entryTime, exitTime }] };
    this._personTrajectory.set(f.faceId, newTraj);
    this._io.emit('person:trajectory-update', newTraj);
  } else {
    // 기존 인물 — 현재 세그먼트 exitTime 갱신
    const lastSeg = traj.segments[traj.segments.length - 1];
    if (lastSeg.cameraId === cameraId) { lastSeg.exitTime = ts; }
    traj.lastSeenAt = ts;
  }
}

// Step B: 크로스카메라 전환 처리
for (const ev of (crossCameraTransitions || [])) {
  const newObjectId = person?.objectId ?? null;
  let traj = this._personTrajectory.get(ev.faceId);
  if (!traj) {
    // 첫 감지가 크로스카메라 전환으로 시작하는 경우
    traj = { faceId, alias, segments: [{ cameraId: ev.newCameraId, ... }] };
    this._personTrajectory.set(ev.faceId, traj);
  } else {
    traj.segments[traj.segments.length - 1].exitTime = ev.timestamp;
    traj.segments.push({ cameraId: ev.newCameraId, objectId: newObjectId, ... });
    traj.currentCameraId = ev.newCameraId;
  }
  this._io.emit('person:trajectory-update', traj);
  this._io.emit('face:reidentified', { faceId, alias: traj.alias,
    prevCameraId, newCameraId, newObjectId, similarity, timestamp });
}
```

**combined vs streaming 비교:**

| 항목 | combined | streaming |
|------|----------|-----------|
| 궤적 관리 위치 | `_processFrame` → `_updatePersonRegistry()` | `_processRemoteResult` — Step A/B 인라인 |
| namedFaces 출처 | 로컬 `_assignFaceIds()` 결과 | analysis 서버 HTTP 응답 (`namedFaces`) |
| `face:reidentified` emit | `_updatePersonRegistry()` 내부 | `_processRemoteResult` Step B |
| alias 정보 | `_updatePersonRegistry()` 반환값 | traj.alias 조회 |
| `_scheduleFaceTrackingSave()` | `_updatePersonRegistry()` 내부 | Step A, B 각각 호출 |

### 9.3 analysis 모드

analysis 모드는 카메라 캡처 없이 HTTP API(`/api/analysis/frame`)로 프레임을 수신합니다.
`analysisApi.js`에서 자체 `_assignFaceIds()`를 호출하여 크로스카메라 전환을 감지하고,
결과를 HTTP 응답에 포함합니다. streaming 서버가 이 응답을 받아 Step A/B를 실행합니다.
analysis 서버 단독 운영 시에는 streaming 서버의 `_processRemoteResult()`가 없으므로
`person:trajectory-update`는 emit되지 않습니다 (향후 analysis 모드 직접 emit 지원 예정).

---

## 10. Error Handling

| Scenario | Location | Behavior |
|----------|----------|----------|
| ArcFace embedding extraction fails | `_assignFaceIds()` | Skip face; no gallery entry created; no event emitted |
| Shared gallery entry expires between detection and processing | `_assignFaceIds()` | Pruned silently; face treated as new on next detection |
| `_bboxClose()` finds no match for objectId resolution | `_resolveObjectId()` | `newObjectId = null`; event still emitted |
| `_personTrajectory` already has entry but transition detected | `_updatePersonRegistry()` | Close prev segment + append; emit event; no crash |
| Socket.IO emit failure | `_io.emit()` | Node.js Socket.IO buffers/ignores; no crash to pipeline |
| REST handler: no trajectories in range | `GET /api/faces/trajectories` | Return `{ success: true, data: [] }`; not an error |
| REST handler: `_crossCameraStats` empty | `GET /api/faces/cross-camera-stats` | Return `{ success: true, data: [] }` |
| Concurrent frames modifying `_sharedFaceGallery` | `_assignFaceIds()` | Node.js event loop is single-threaded; no race conditions within one pipeline |
| Multiple camera pipelines concurrent access to shared state | PipelineManager | `_assignFaceIds()` is synchronous within a single `await`; no concurrent modification within a frame cycle |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for CrossCamera Face Tracking |
| 1.1 | 2026-06-10 | Youngho Kim | Section 9 추가: SERVER_MODE별 궤적 관리 적용 범위 — streaming 모드 `_processRemoteResult` Step A/B 인라인 궤적 갱신 설계 반영 |
