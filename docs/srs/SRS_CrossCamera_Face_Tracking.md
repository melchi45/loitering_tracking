# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Cross-Camera Face Tracking & Global Person Registry

| | |
|---|---|
| **Document ID** | SRS-LTS-CCFR-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_CrossCamera_Face_Tracking.md |
| **Parent RFP** | rfp/RFP_CrossCamera_Face_Tracking.md |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Scope](#2-scope)
3. [Definitions and Abbreviations](#3-definitions-and-abbreviations)
4. [System Overview](#4-system-overview)
5. [Functional Requirements — Shared Face Gallery](#5-functional-requirements--shared-face-gallery)
6. [Functional Requirements — Cross-Camera Re-ID](#6-functional-requirements--cross-camera-re-id)
7. [Functional Requirements — Global Person Registry](#7-functional-requirements--global-person-registry)
8. [Functional Requirements — Person Trajectory](#8-functional-requirements--person-trajectory)
9. [Functional Requirements — REST API](#9-functional-requirements--rest-api)
10. [Functional Requirements — Socket.IO Events](#10-functional-requirements--socketio-events)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Interface Requirements](#12-interface-requirements)
13. [Constraints and Assumptions](#13-constraints-and-assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines complete, verifiable functional requirements for the **Cross-Camera Face Tracking** subsystem of LTS-2026. Each requirement is identified by a unique FR-CCFR-NNN ID and is directly traceable to test cases in `TC_CrossCamera_Face_Tracking.md`.

### 1.2 Problem Context

The core cross-camera face Re-ID system assigns a shared `faceId` (e.g. `F7`) across cameras using an in-memory ArcFace gallery. Three gaps motivated this subsystem:

1. **Gallery expiry gap** — gallery entries expire after 30 s of non-detection. A person moving slowly between cameras receives a new `faceId`, breaking the cross-camera link.
2. **No canonical person ID** — no stable identifier survives gallery expiry or multiple `faceId` assignments within the same session.
3. **No trajectory record** — camera visit history with timestamps is not stored or surfaced to operators.

### 1.3 Scope

This document covers:

- Shared ArcFace gallery lifecycle: assignment, expiry, cosine similarity matching.
- Cross-camera Re-ID event detection and emission.
- Global Person Registry: session-persistent alias assignment, PersonTrajectory data model.
- Per-person camera trajectory recording and segment management.
- REST API for trajectory hydration and cross-camera statistics.
- Socket.IO events for real-time trajectory updates.

Out of scope: multi-camera dwell aggregation, return pattern detection, SQLite trajectory persistence, multi-server Redis/Qdrant sharing (all Phase-2 or later).

---

## 2. Scope

The Cross-Camera Face Tracking subsystem operates within `PipelineManager._processFrame()` and covers:

- Maintaining a session-level `_sharedFaceGallery` array for cross-camera face Re-ID.
- Assigning sequential `faceId` labels (`F1`, `F2`, …) to newly detected faces.
- Maintaining a `_personTrajectory` Map that is independent of gallery expiry.
- Assigning sequential person aliases (`P1`, `P2`, …) on first face detection.
- Appending `PersonSegment` entries on camera transitions.
- Emitting `face:reidentified` and `person:trajectory-update` Socket.IO events.
- Providing `GET /api/faces/trajectories` and `GET /api/faces/cross-camera-stats` endpoints.

---

## 3. Definitions and Abbreviations

| Term | Definition |
|------|-----------|
| Shared Gallery | In-memory `_sharedFaceGallery` array; entries expire after 30 s |
| Persistent Gallery | On-disk gallery loaded from DB (`lts.json`); used for named identity matching |
| faceId | Sequential label (F1, F2, …) assigned to each unique face in the shared gallery |
| Person alias | Session-stable display name (P1, P2, …) assigned to a face on first detection |
| PersonTrajectory | Server-side record tracking all camera visits for one alias; persists for the session |
| PersonSegment | One continuous visit to one camera: `{ cameraId, objectId, entryTime, exitTime }` |
| Cross-camera transition | Event when a face matching an existing gallery entry is detected on a different camera |
| Cosine similarity | Dot product of two L2-normalised ArcFace embeddings; range [−1, 1], effective [0, 1] |
| Re-ID | Re-identification — recognizing the same person across different camera views |
| `_bboxClose()` | Helper that returns true if two bboxes differ by ≤ 3 px on all four coordinates |
| EMA | Exponential Moving Average — used for embedding smoothing in ByteTracker |
| TTL | Time To Live — maximum age of a data entry before it is pruned |

---

## 4. System Overview

### 4.1 Component Diagram

```
RTSP Frame (Camera A or Camera B)
         │
         ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  PipelineManager._processFrame(cameraId, frame)                      │
  │                                                                      │
  │  1. DetectionService.detect()   → raw detections [{bbox, class}]    │
  │  2. ByteTracker.update()        → trackedObjects [{objectId, bbox}] │
  │  3. AttributePipeline.enrich()  → face embeddings (ArcFace 512-D)  │
  │  4. _assignFaceIds()            → face IDs + cross-camera events    │
  │  5. BehaviorEngine.update()     → loitering metrics                 │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
         │
         ├───────────────────────────────────────────────────────────┐
         ▼                                                           │
  ┌──────────────────────────────────────────────────────┐          │
  │  _sharedFaceGallery (in-memory array)                │          │
  │  Entry: { faceId, embedding, lastSeenAt,             │          │
  │           lastCameraId }                             │          │
  │  TTL: 30 s from lastSeenAt                           │          │
  └──────────────────────────────────────────────────────┘          │
         │                                                           │
         ▼                                                           ▼
  ┌──────────────────────────────────────────┐    ┌──────────────────────────────────┐
  │  _personTrajectory (Map<faceId,          │    │  Socket.IO                       │
  │                      PersonTrajectory>)  │    │  ├─ 'face:reidentified'           │
  │  Session-stable; never pruned            │    │  ├─ 'person:trajectory-update'   │
  │  alias: P1, P2, …                        │    │  └─ 'detections'  (alias field)  │
  └──────────────────────────────────────────┘    └──────────────────────────────────┘
         │
         ▼
  ┌──────────────────────────────────────────┐
  │  REST Endpoints                          │
  │  ├─ GET /api/faces/trajectories          │
  │  ├─ GET /api/faces/cross-camera-stats    │
  │  └─ GET /api/persons/active              │
  └──────────────────────────────────────────┘
```

### 4.2 Processing Order Within `_assignFaceIds()`

```
For each detected face with ArcFace embedding:

  Step 1: Search _sharedFaceGallery (cosine similarity ≥ 0.35)
    a) Match found (same camera)    → reuse faceId; update lastSeenAt
    b) Match found (diff camera)    → reuse faceId; emit face:reidentified;
                                      update trajectory; update lastCameraId
    c) No match                     → assign new faceId = 'F' + _faceCounter++
                                      add entry to _sharedFaceGallery

  Step 2: Update _personTrajectory
    a) faceId not in registry       → create PersonTrajectory; assign alias Pn
                                      emit person:trajectory-update
    b) faceId in registry, same cam → update lastSeenAt + current segment.exitTime
    c) faceId in registry, new cam  → close prev segment; append new segment
                                      emit person:trajectory-update

  Step 3: Search _persistentGallery (named identity matching — separate concern)
    → may emit 'face_match' or 'missing_person_match' (see SRS_AI_Face_Recognition.md)

  Step 4: Prune _sharedFaceGallery entries with lastSeenAt older than 30 s
```

---

## 5. Functional Requirements — Shared Face Gallery

### FR-CCFR-001 — Shared Gallery Data Structure

The system shall maintain a `_sharedFaceGallery` array in `PipelineManager` with one entry per uniquely identified face. Each entry shall contain:

- `faceId`: string label (e.g. `"F1"`)
- `embedding`: 512-element float32 array (ArcFace, L2-normalised)
- `lastSeenAt`: Unix timestamp ms of most recent detection
- `lastCameraId`: UUID of the camera that most recently detected this face

### FR-CCFR-002 — FaceId Assignment

When a new face is detected whose embedding does not match any existing shared gallery entry (cosine similarity < 0.35), the system shall assign a new `faceId` using the pattern `'F' + _faceCounter` where `_faceCounter` starts at 1 and increments monotonically for the server session.

- **Output:** `faceId` string (e.g. `"F1"`, `"F2"`, …)
- **Uniqueness:** Each `faceId` shall be unique within a server session.

### FR-CCFR-003 — Gallery Entry Creation

On first detection of a face, the system shall add a new entry to `_sharedFaceGallery`:
```
{ faceId, embedding, lastSeenAt: now, lastCameraId: cameraId }
```

### FR-CCFR-004 — Gallery Matching Threshold

The cosine similarity threshold for matching a face to an existing shared gallery entry shall be **0.35**. Detections with similarity below this threshold shall be assigned new `faceId` values.

### FR-CCFR-005 — Gallery Entry Update on Re-Detection

When an existing gallery entry is matched:
- `lastSeenAt` shall be updated to the current frame timestamp.
- `lastCameraId` shall be updated to the current `cameraId`.
- The `faceId` shall be reused without creating a new entry.

### FR-CCFR-006 — Gallery Entry Expiry

The system shall prune `_sharedFaceGallery` entries whose `lastSeenAt` is more than **30,000 ms** (30 seconds) older than the current frame timestamp on every `_assignFaceIds()` call.

- **Rationale:** Expired entries prevent false Re-ID matches for faces that have left the scene.
- **Note:** Expiry of a shared gallery entry does not remove the corresponding `PersonTrajectory` entry (alias is session-persistent).

---

## 6. Functional Requirements — Cross-Camera Re-ID

### FR-CCFR-010 — Cross-Camera Transition Detection

When a face matches an existing shared gallery entry (`similarity ≥ 0.35`) and the entry's `lastCameraId` differs from the current `cameraId`, the system shall classify this as a **cross-camera transition**.

### FR-CCFR-011 — face:reidentified Event Emission

On cross-camera transition, the system shall emit a `face:reidentified` Socket.IO event to all connected clients with the following payload:

```json
{
  "faceId":       "F7",
  "prevCameraId": "<camera-A-uuid>",
  "newCameraId":  "<camera-B-uuid>",
  "newObjectId":  15,
  "similarity":   0.87,
  "timestamp":    1748000000000
}
```

- `newObjectId` is the ByteTracker `objectId` (numeric) in the destination camera, resolved via `_bboxClose()` (±3 px tolerance). If no match is found, `newObjectId` shall be `null`.

### FR-CCFR-012 — Cross-Camera Stats Tracking

The system shall maintain a `_crossCameraStats` Map (`faceId → CrossCamStat`) with the following fields per entry:

```
{ faceId, firstCameraId, lastCameraId, transitionCount, lastSeenAt }
```

- `transitionCount` shall increment by 1 on each cross-camera transition for the same `faceId`.
- `firstCameraId` shall be set when the entry is first created and never changed.
- `lastCameraId` and `lastSeenAt` shall be updated on each transition.

### FR-CCFR-013 — Object ID Resolution via Bbox Proximity

The system shall resolve `newObjectId` by scanning the enriched `attrObjects` array for the current frame and finding the person track whose face bbox is within `_bboxClose()` tolerance (±3 px on each coordinate) of the detected face bbox.

- If exactly one match is found, its `objectId` shall be used.
- If no match is found or multiple matches exist, `newObjectId` shall be `null`.

---

## 7. Functional Requirements — Global Person Registry

### FR-CCFR-020 — Person Registry Storage

The system shall maintain a `_personTrajectory` Map in `PipelineManager` with schema `Map<faceId, PersonTrajectory>`. This Map shall persist for the entire server session and shall not be cleared on gallery expiry.

### FR-CCFR-021 — Person Alias Assignment

When a `faceId` is encountered that is not yet in `_personTrajectory`, the system shall create a new registry entry and assign a **person alias** using the pattern `'P' + ++_personAliasCounter` (1-based, incrementing monotonically).

- **Example:** First face → alias `"P1"`, second → `"P2"`, etc.
- **Stability:** Once assigned, a person alias shall not change for the rest of the server session, even if the `faceId` expires from the shared gallery and a new `faceId` is later assigned to the same face. (Note: alias continuity across gallery expiry is a Phase-2 concern; this requirement applies to within-gallery-lifetime behaviour.)

### FR-CCFR-022 — PersonTrajectory Schema

Each `PersonTrajectory` entry shall conform to:

```javascript
{
  faceId:          string,          // shared gallery ID (canonical key)
  alias:           string,          // "P1", "P2", …
  firstSeenAt:     number,          // Unix ms — timestamp of first ever detection
  lastSeenAt:      number,          // Unix ms — most recent detection (any camera)
  currentCameraId: string,          // UUID of most recent camera
  segments:        PersonSegment[], // ordered list of camera visits (≥ 1 entry)
}
```

### FR-CCFR-023 — PersonSegment Schema

Each `PersonSegment` shall conform to:

```javascript
{
  cameraId:  string,       // UUID of the camera
  objectId:  number|null,  // ByteTracker objectId in this camera; null if unresolved
  entryTime: number,       // Unix ms — first seen in this camera
  exitTime:  number,       // Unix ms — last seen in this camera (updated each frame)
}
```

### FR-CCFR-024 — Registry Entry Creation on First Detection

When a new `faceId` is first detected (no existing `_personTrajectory` entry):

1. `alias` is assigned as `'P' + ++_personAliasCounter`.
2. `firstSeenAt` and `lastSeenAt` are set to the current frame timestamp.
3. `currentCameraId` is set to the current camera.
4. `segments` is initialized with one `PersonSegment`: `{ cameraId, objectId, entryTime: now, exitTime: now }`.
5. `person:trajectory-update` Socket.IO event is emitted with the full `PersonTrajectory`.

### FR-CCFR-025 — Same-Camera Detection Update

When a known `faceId` is detected in the **same camera** as its `currentCameraId`:

1. `lastSeenAt` shall be updated to the current frame timestamp.
2. The last segment's `exitTime` shall be updated to the current frame timestamp.
3. The last segment's `objectId` shall be refreshed if a new ByteTracker match is available.
4. **No** `person:trajectory-update` event shall be emitted (minor update; reduce event noise).

### FR-CCFR-026 — Alias Field on Detection Objects

Each detected face object produced by `_assignFaceIds()` shall carry an `alias` field (e.g. `"P3"`) so the dashboard can display it without waiting for a trajectory-update event. The alias shall be `null` or absent if the face has not yet been registered.

---

## 8. Functional Requirements — Person Trajectory

### FR-CCFR-030 — Camera Transition Segment Append

When a known `faceId` is detected on a **different** camera from its `currentCameraId`:

1. The last open segment shall be closed: `segment.exitTime = current frame timestamp`.
2. A new segment shall be appended: `{ cameraId: newCameraId, objectId: newObjectId, entryTime: now, exitTime: now }`.
3. `currentCameraId` shall be updated to the new camera.
4. `lastSeenAt` shall be updated.
5. `person:trajectory-update` Socket.IO event shall be emitted.

### FR-CCFR-031 — Segment Ordering

Segments in the `PersonTrajectory.segments` array shall always be ordered chronologically by `entryTime`, with the most recent segment last.

### FR-CCFR-032 — Trajectory Event Triggers

`person:trajectory-update` shall be emitted **only** in the following cases:

1. First detection of a face (new registry entry created).
2. Cross-camera transition detected (new segment appended).

It shall **not** be emitted for same-camera frame-by-frame updates.

### FR-CCFR-033 — Registry Lifecycle

- Registry entries shall **not** be deleted during a server session.
- On server restart, all trajectory data is lost (in-memory only; Phase-2 adds persistence).
- The registry shall not impose a hard upper bound on entries during Phase-1, but a TTL cleanup mechanism is required before production deployment to prevent unbounded memory growth in long sessions (see NFR-CCFR-05).

---

## 9. Functional Requirements — REST API

### FR-CCFR-040 — GET /api/faces/trajectories

- **Method:** GET
- **Path:** `/api/faces/trajectories`
- **Query params:** `maxAgeMs` (optional, default: no limit) — filter by `lastSeenAt`
- **Response 200:**
  ```json
  { "success": true, "data": PersonTrajectory[] }
  ```
- When `maxAgeMs` is provided, only persons whose `lastSeenAt > now − maxAgeMs` shall be returned.
- Persons with zero segments shall not appear in the response.

### FR-CCFR-041 — GET /api/faces/cross-camera-stats

- **Method:** GET
- **Path:** `/api/faces/cross-camera-stats`
- **Response 200:**
  ```json
  {
    "success": true,
    "data": [
      {
        "faceId":          "F7",
        "firstCameraId":   "<camera-A-uuid>",
        "lastCameraId":    "<camera-B-uuid>",
        "transitionCount": 2,
        "lastSeenAt":      1748000000000
      }
    ]
  }
  ```
- All entries in `_crossCameraStats` shall be returned regardless of age.
- If no transitions have occurred, `data` shall be an empty array.

### FR-CCFR-042 — GET /api/persons/active

- **Method:** GET
- **Path:** `/api/persons/active`
- **Query params:** `maxAgeMs` (optional, default: 300000 ms = 5 minutes)
- **Response 200:**
  ```json
  { "total": 3, "persons": PersonTrajectory[] }
  ```
- Returns all persons whose `lastSeenAt > now − maxAgeMs`.
- `total` shall reflect the count of persons in the `persons` array.
- Each `PersonTrajectory` in the response shall include the full `segments` array.

---

## 10. Functional Requirements — Socket.IO Events

### FR-CCFR-050 — person:trajectory-update Event

- **Direction:** Server → All clients (io.emit)
- **Trigger:** FR-CCFR-024 (first detection) or FR-CCFR-030 (camera transition)
- **Payload schema:**
  ```json
  {
    "faceId":          "F7",
    "alias":           "P3",
    "firstSeenAt":     1748000000000,
    "lastSeenAt":      1748000620000,
    "currentCameraId": "<camera-B-uuid>",
    "segments": [
      { "cameraId": "<camera-A-uuid>", "objectId": 42, "entryTime": 1748000540000, "exitTime": 1748000610000 },
      { "cameraId": "<camera-B-uuid>", "objectId": 15, "entryTime": 1748000620000, "exitTime": 1748000620000 }
    ]
  }
  ```
- The payload shall be a complete `PersonTrajectory` object (all segments, not a delta).

### FR-CCFR-051 — face:reidentified Event

- **Direction:** Server → All clients (io.emit)
- **Trigger:** Cross-camera transition detected in `_assignFaceIds()` (FR-CCFR-010)
- **Payload schema:**
  ```json
  {
    "faceId":       "F7",
    "prevCameraId": "<camera-A-uuid>",
    "newCameraId":  "<camera-B-uuid>",
    "newObjectId":  15,
    "similarity":   0.87,
    "timestamp":    1748000620000
  }
  ```
- `newObjectId` shall be `null` if object ID resolution failed (FR-CCFR-013).
- `similarity` shall be in range [0.35, 1.0] (matched face).

### FR-CCFR-052 — detections Event — alias Field

- The existing `detections` Socket.IO event shall include an `alias` field (e.g. `"P3"`) on each face detection object when the face is registered in `_personTrajectory`.
- If the face is not yet registered (race condition within same frame), `alias` may be absent or `null`.

---

## 11. Non-Functional Requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR-CCFR-01 | Performance | `_assignFaceIds()` shall add ≤ 10 ms overhead per frame for galleries of up to 200 shared entries (cosine search over float32 embeddings). |
| NFR-CCFR-02 | Latency | `face:reidentified` and `person:trajectory-update` shall be emitted within 500 ms of the frame that triggered the cross-camera transition. |
| NFR-CCFR-03 | Scalability | The system shall correctly track up to 50 simultaneous person aliases per server session without degradation. |
| NFR-CCFR-04 | Accuracy | Cosine similarity matching (threshold 0.35) shall produce an ID-switch rate of less than 10% for persons detected across 2 cameras in controlled test conditions. |
| NFR-CCFR-05 | Memory | `_personTrajectory` Map shall not exceed 50 MB heap memory for sessions with up to 10,000 person entries (average 5 segments each). TTL cleanup is required for production sessions exceeding 8 hours. |
| NFR-CCFR-06 | Reliability | Gallery expiry (FR-CCFR-006) shall not crash or produce unhandled exceptions; entries shall be silently pruned. |

---

## 12. Interface Requirements

### 12.1 REST API Summary

| Method | Endpoint | Auth | FR | Description |
|--------|----------|------|----|-------------|
| GET | `/api/faces/trajectories` | None | FR-CCFR-040 | List person trajectories with optional age filter |
| GET | `/api/faces/cross-camera-stats` | None | FR-CCFR-041 | List cross-camera Re-ID statistics |
| GET | `/api/persons/active` | None | FR-CCFR-042 | List active persons (seen within maxAgeMs) |

### 12.2 Socket.IO Event Summary

| Event | Direction | Trigger | FR |
|-------|-----------|---------|-----|
| `person:trajectory-update` | Server → All clients | First detection or camera transition | FR-CCFR-050 |
| `face:reidentified` | Server → All clients | Cross-camera transition | FR-CCFR-051 |
| `detections` | Server → Room (cameraId) | Per-frame detection output | FR-CCFR-052 |

### 12.3 Internal Interface — `_assignFaceIds()` Output

The `_assignFaceIds()` method shall return an object containing:
- `faces`: array of face detection objects enriched with `faceId` and `alias`
- `crossCameraTransitions`: array of transition records `{ faceId, prevCameraId, newCameraId, similarity }`

---

## 13. Constraints and Assumptions

| ID | Constraint / Assumption |
|----|------------------------|
| C-01 | The system is single-server only; cross-server trajectory sharing is out of scope (Phase-3 Redis). |
| C-02 | `_personTrajectory` is in-process in-memory only; data is lost on server restart. |
| C-03 | Face embedding extraction requires `AttributePipeline` with ArcFace ONNX model loaded. Frames without ArcFace output do not contribute to gallery matching or trajectory updates. |
| C-04 | ByteTracker `objectId` values are camera-local; the same numeric ID may exist on different cameras for different people. Cross-camera object ID correlation is achieved only through face embedding matching. |
| C-05 | Maximum supported active cameras for this subsystem is 16; beyond this, the single-server in-process model may encounter performance degradation. |
| C-06 | The cosine similarity threshold (0.35) is a system constant. Adjusting it requires code changes; a configurable threshold is a Phase-2 item. |
| C-07 | Gallery entries expire after exactly 30,000 ms of non-detection. Persons who are occluded for more than 30 s in transit between cameras may receive a new `faceId` on re-appearance; their alias continuity across this gap is not guaranteed in Phase-1. |
| C-08 | The `_bboxClose()` tolerance of ±3 pixels assumes person body bbox and face bbox share the same coordinate origin (same resolution frame). |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for CrossCamera Face Tracking |
