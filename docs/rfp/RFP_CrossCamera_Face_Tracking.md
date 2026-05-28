# RFP — Cross-Camera Face Tracking (LTS-2026-CCT-001)

**Document**: LTS-2026-CCT-001  
**Status**: ✅ Implemented  
**Author**: Youngho Kim  
**Date**: 2026-05-20  

---

## 1. Overview

### 1.1 Problem Statement

The current Cross-Camera Re-ID system assigns a shared `faceId` (e.g. `F7`) to a face across cameras via the shared ArcFace gallery. However, three gaps remain:

| Gap | Description |
|---|---|
| **Gallery expiry** | Gallery entries expire after 30 s of non-detection. If a person moves slowly between cameras, they receive a new `faceId` and the cross-camera link is lost |
| **No canonical person ID** | There is no persistent "Person #N" identifier that survives gallery expiry or multiple faceId assignments |
| **No trajectory record** | Camera visit history ("Camera A → B → C with timestamps") is not stored or displayed; operators cannot reconstruct a person's path |

### 1.2 Goal

Maintain a **Global Person Registry** that:

1. Assigns a stable **Person ID** (e.g. `P1`, `P2`) on first face detection, persisting for the entire server session regardless of gallery expiry
2. Records a per-person **camera trajectory** — ordered list of camera visits with entry/exit times and tracker objectIds
3. Broadcasts trajectory updates via Socket.IO so the UI can show live camera movement timelines
4. Provides a REST endpoint for initial page-load hydration

---

## 2. Design

### 2.1 Data Model

#### PersonSegment
```
{
  cameraId:  string       // UUID of the camera
  objectId:  number|null  // ByteTracker objectId in this camera (null if body not detected)
  entryTime: number       // Unix timestamp ms — first seen in this camera
  exitTime:  number       // Unix timestamp ms — last seen in this camera (updated each frame)
}
```

#### PersonTrajectory
```
{
  faceId:          string          // Shared ArcFace gallery ID (canonical key)
  alias:           string          // "P1", "P2", … — session-stable display name
  firstSeenAt:     number          // timestamp of first ever detection
  lastSeenAt:      number          // timestamp of most recent detection (any camera)
  currentCameraId: string          // most recent camera
  segments:        PersonSegment[] // ordered list of camera visits
}
```

### 2.2 Server Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  PipelineManager._processFrame()                                     │
│                                                                      │
│  1. _assignFaceIds() → { faces, crossCameraTransitions }            │
│                                                                      │
│  2. For each named face (NOT in crossCameraTransitions):            │
│     a) If faceId absent from _personTrajectory → CREATE new entry   │
│        · alias = "P" + ++_personAliasCounter                        │
│        · segments = [{ cameraId, objectId, entryTime, exitTime }]   │
│        · emit person:trajectory-update                               │
│     b) If present AND same camera → UPDATE exitTime/objectId        │
│        (no broadcast — low-frequency change)                        │
│                                                                      │
│  3. For each crossCameraTransition:                                  │
│     a) Resolve newObjectId via _bboxClose() match on attrObjects    │
│     b) Close last segment: exitTime = transition timestamp          │
│     c) Append new segment: { newCameraId, newObjectId, … }          │
│     d) emit person:trajectory-update  ← meaningful change           │
│     e) emit face:reidentified (existing event, +newObjectId)        │
│                                                                      │
│  4. faceDetObjects carry alias for zero-latency UI label            │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.3 Socket.IO Event: `person:trajectory-update`

Emitted when a person is first detected or changes camera:

```json
{
  "faceId":          "F7",
  "alias":           "P3",
  "firstSeenAt":     1716015540000,
  "lastSeenAt":      1716015620000,
  "currentCameraId": "<camera-B-uuid>",
  "segments": [
    { "cameraId": "<camera-A-uuid>", "objectId": 42, "entryTime": 1716015540000, "exitTime": 1716015610000 },
    { "cameraId": "<camera-B-uuid>", "objectId": 15, "entryTime": 1716015620000, "exitTime": 1716015620000 }
  ]
}
```

### 2.4 REST API: `GET /api/persons/active`

Returns all persons seen in the last 5 minutes (for page-load hydration):

```json
{
  "total": 3,
  "persons": [ <PersonTrajectory>, … ]
}
```

Query param: `?maxAgeMs=300000` (default 5 min)

### 2.5 Updated `face:reidentified` event

Unchanged except now includes `newObjectId` (implemented in previous revision):

```json
{
  "faceId":       "F7",
  "prevCameraId": "<camera-A-uuid>",
  "newCameraId":  "<camera-B-uuid>",
  "newObjectId":  15,
  "similarity":   0.87,
  "timestamp":    1716015620000
}
```

---

## 3. Client-Side Components

| Component | File | Description |
|---|---|---|
| `PersonTrajectory` / `PersonSegment` types | `client/src/types/index.ts` | TypeScript interfaces |
| `usePersonTrajectoryStore` | `client/src/stores/personTrajectoryStore.ts` | Zustand store: `Map<faceId, PersonTrajectory>` |
| Socket listener | `client/src/App.tsx` | Subscribes to `person:trajectory-update`; hydrates store from `/api/persons/active` on mount |
| **Person Trails panel** | `client/src/components/FullscreenCameraView.tsx` | Collapsible section in Detection panel showing persons who visited this camera; timeline arrows `Cam-A → Cam-B ► Cam-C` |
| **Person alias badge** | `client/src/components/FullscreenCameraView.tsx` | `DetectionRow` shows `P3` badge (teal) next to `[F7]` on face detections |

### 3.1 Person Trails Panel — Display Format

```
PERSON TRAILS (2)                                      ▲
 ● P3  [F7]  Camera-A → Camera-B ► Here  87%  2m ago
 ○ P1  [F2]  Entrance → Hallway  ► Here  91%  5m ago
```

- `●` = currently in this camera; `○` = previously visited
- Timeline uses camera names (resolved from cameraStore), falls back to UUID prefix
- `►` marks the current/last camera in the trail
- Segments sorted chronologically; shows last 4 cameras if trail is long
- Clicking a trail entry focuses the camera grid on the current camera

---

## 4. Implementation Files

| File | Change |
|---|---|
| `server/src/services/pipelineManager.js` | Add `_personTrajectory: Map`, `_personAliasCounter`, trajectory update logic in `_processFrame`, `getPersonTrajectories()` method |
| `server/src/index.js` | Add `GET /api/persons/active` route |
| `client/src/types/index.ts` | Add `PersonSegment`, `PersonTrajectory` interfaces |
| `client/src/stores/personTrajectoryStore.ts` | New Zustand store |
| `client/src/App.tsx` | Add `person:trajectory-update` socket listener + hydration fetch |
| `client/src/components/FullscreenCameraView.tsx` | Person Trails panel + alias badge in `DetectionRow` |

---

## 5. Loitering Enhancement

Cross-camera trajectory data enables two additional loitering signals:

### 5.1 Multi-Camera Dwell Aggregation
Total dwell time across all cameras:
```
totalDwell = Σ (segment.exitTime - segment.entryTime) for all segments
```
A person who briefly visits many cameras may not trigger any single-camera loitering alert but accumulates suspicious total dwell.

### 5.2 Return Pattern Detection
If a person's trajectory contains the same `cameraId` more than once (return visit), this can be surfaced as a revisit warning in the Alert panel.

> These enhancements are tracked as Phase-2 items. Phase-1 (implemented) covers trajectory recording and display only.

---

## 6. Scale & Persistence

| Scope | Storage | Notes |
|---|---|---|
| Current (in-process) | `Map` in PipelineManager | Survives until server restart; entries never deleted (GC concern for long sessions → add TTL cleanup) |
| Phase-2 | SQLite `persons` table | Persist trajectories across restarts; query by date range |
| Phase-3 (multi-server) | Redis or Qdrant | See §2.3.2 upgrade path in `RFP_LTS2026_Loitering_Tracking_System.md` |

---

## 7. Feature Status

| Feature | Status | Notes |
|---|---|---|
| PersonTrajectory data model | ✅ Done | `PersonSegment` + `PersonTrajectory` types |
| Server trajectory tracking | ✅ Done | `_personTrajectory` Map in PipelineManager |
| `person:trajectory-update` event | ✅ Done | Emitted on first detection + camera transition |
| `GET /api/persons/active` | ✅ Done | Query param `maxAgeMs` |
| `usePersonTrajectoryStore` | ✅ Done | Zustand store |
| Socket listener in App.tsx | ✅ Done | + hydration on mount |
| Person Trails panel | ✅ Done | Collapsible, shows trail with camera names |
| Alias badge in DetectionRow | ✅ Done | Teal `P3` chip next to `[F7]` |
| Multi-camera dwell aggregation | 🔵 Phase-2 | Not yet implemented |
| Return pattern detection | 🔵 Phase-2 | Not yet implemented |
| SQLite persistence | 🔵 Phase-2 | In-memory only for now |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for CrossCamera Face Tracking |
