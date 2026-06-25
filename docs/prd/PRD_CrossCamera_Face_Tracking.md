# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Cross-Camera Face Tracking & Person Trajectory

| | |
|---|---|
| **Document ID** | PRD-LTS-004 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_CrossCamera_Face_Tracking.md |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

Maintain a Global Person Registry that assigns each detected individual a stable session-persistent identity alias (e.g., "P1", "P2"), records their full camera-visit trajectory, and delivers live movement timeline updates to the dashboard — enabling operators to reconstruct any person's path across multiple cameras even after gallery expiry causes a new face ID to be assigned.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Assign a stable **Person alias** (e.g., `P1`, `P2`) on first face detection that persists for the entire server session, independent of ArcFace gallery expiry.
- **G2**: Record an ordered per-person **camera trajectory** (list of `PersonSegment` objects with camera ID, tracker object ID, entry time, and exit time).
- **G3**: Emit a `person:trajectory-update` Socket.IO event when a person is first detected or transitions to a new camera.
- **G4**: Provide a `GET /api/persons/active` REST endpoint for page-load hydration returning all persons seen in the last 5 minutes.
- **G5**: Display a "Person Trails" panel in the dashboard showing each person's camera movement timeline with camera names and similarity scores.

### 2.2 Non-Goals

- **NG1**: Multi-camera dwell time aggregation across all cameras — planned as Phase 2; Phase 1 records trajectories only.
- **NG2**: Return pattern detection (detecting when a person revisits the same camera) — planned as Phase 2.
- **NG3**: SQLite or database persistence of trajectories across server restarts — in-memory `Map` is the current scope; database persistence is Phase 2.
- **NG4**: Multi-server or Redis-based trajectory sharing — single-server in-process registry is sufficient for ≤ 16 cameras.

---

## 3. User Personas

### Persona 1 — Security Operator
Monitors multiple cameras simultaneously. Needs to see at a glance that "P3 entered Camera-A, then moved to Camera-B" so they can understand a subject's movement without manually correlating feeds.

### Persona 2 — Incident Investigator
Reviews an alert after the fact. Needs a trajectory record showing every camera the suspect visited, with timestamps, to reconstruct the full path through the facility.

### Persona 3 — System Developer / Integrator
Consumes the `person:trajectory-update` Socket.IO event or the `/api/persons/active` endpoint to build custom surveillance dashboards or integrate trajectory data into a VMS.

---

## 4. Functional Specification

### 4.1 Global Person Registry

- The registry is a server-side in-process `Map<faceId, PersonTrajectory>`.
- On first detection of a face not present in the registry, a new `PersonTrajectory` entry is created with:
  - `alias`: "P" + incrementing counter (e.g., `P1`, `P2`).
  - `faceId`: the shared ArcFace gallery ID (canonical key).
  - `firstSeenAt`: Unix timestamp ms of first detection.
  - `segments`: array containing the initial `PersonSegment`.
- The alias is stable for the entire server session; gallery expiry does not change it.
- When the same face is detected again in the same camera, only `lastSeenAt` and the current segment's `exitTime` are updated (no broadcast for minor updates).
- When a cross-camera transition is detected, a new `PersonSegment` is appended and `person:trajectory-update` is emitted.

### 4.2 PersonSegment Model

Each segment represents one continuous visit to one camera:

```
{
  cameraId:  string       // UUID of the camera
  objectId:  number|null  // ByteTracker objectId in this camera (null if body not tracked)
  entryTime: number       // Unix timestamp ms — first seen in this camera
  exitTime:  number       // Unix timestamp ms — last seen (updated each frame)
}
```

### 4.3 PersonTrajectory Model

```
{
  faceId:          string          // Shared ArcFace gallery ID
  alias:           string          // "P1", "P2", …
  firstSeenAt:     number          // Timestamp of first detection
  lastSeenAt:      number          // Timestamp of most recent detection (any camera)
  currentCameraId: string          // UUID of most recent camera
  segments:        PersonSegment[] // Ordered list of camera visits
}
```

### 4.4 Cross-Camera Transition Handling

When `_assignFaceIds()` identifies a cross-camera transition for a face:
1. The last open segment is closed: `exitTime = transition timestamp`.
2. A new segment is appended: `{ newCameraId, newObjectId, entryTime, exitTime }`.
3. `person:trajectory-update` is emitted.
4. `face:reidentified` continues to be emitted (existing event) with the resolved `newObjectId`.

Object ID resolution: the face bbox is matched to the enriched person track in `attrObjects` via `_bboxClose()` (±3 px tolerance).

### 4.5 Person Alias in Detection Feed

Each detected face object carries the `alias` field (e.g., `"P3"`) so the dashboard can display it as a teal badge next to the face ID without waiting for a trajectory-update event.

### 4.6 Person Trails Panel (UI)

- Collapsible section in the Detection panel (Detections tab) of the fullscreen camera view.
- Shows all persons who have visited the current camera.
- Format per entry: `[alias] [faceId]  Camera-A → Camera-B ► Here  similarity%  time-ago`.
- `●` prefix = currently in this camera; `○` prefix = previously visited.
- Timeline uses resolved camera names from `cameraStore`; falls back to UUID prefix.
- `►` marks the current/last camera in the trail.
- Shows last 4 cameras if the trail is long.
- Clicking a trail entry focuses the camera grid on the current camera.

### 4.7 Person Alias Badge in DetectionRow

A teal chip displaying the alias (e.g., `P3`) is shown next to `[F7]` in the face detection row of the detection panel.

### 4.8 Registry Lifecycle

- Entries are never deleted during a server session (current implementation).
- A TTL cleanup mechanism is required to prevent unbounded memory growth in long sessions — planned as a follow-up task.
- On server restart, all trajectory data is lost; SQLite persistence is a Phase 2 item.

---

## 5. Technical Requirements

### 5.1 Runtime & Stack

| Component | Technology |
|---|---|
| Registry storage | In-process `Map` in `PipelineManager` |
| Server event | Socket.IO (`person:trajectory-update`) |
| REST endpoint | `GET /api/persons/active` in `server/src/index.js` |
| Client store | Zustand (`usePersonTrajectoryStore`) |
| Type definitions | `PersonSegment`, `PersonTrajectory` in `client/src/types/index.ts` |

### 5.2 Implementation Files

| File | Change |
|---|---|
| `server/src/services/pipelineManager.js` | Add `_personTrajectory: Map`, `_personAliasCounter`, trajectory update logic in `_processFrame`, `getPersonTrajectories()` method |
| `server/src/index.js` | Add `GET /api/persons/active` route |
| `client/src/types/index.ts` | Add `PersonSegment`, `PersonTrajectory` interfaces |
| `client/src/stores/personTrajectoryStore.ts` | New Zustand store |
| `client/src/App.tsx` | Add `person:trajectory-update` socket listener + hydration fetch on mount |
| `client/src/components/FullscreenCameraView.tsx` | Person Trails panel + alias badge in `DetectionRow` |

### 5.3 Scale & Persistence Roadmap

| Scope | Storage | Notes |
|---|---|---|
| Current (≤ 16 cameras, single server) | In-process `Map` | Zero dependencies; lost on restart |
| Phase 2 | SQLite `persons` table | Persists across restarts; query by date range |
| Phase 3 (multi-server) | Redis or Qdrant | See upgrade path in `RFP_LTS2026_Loitering_Tracking_System.md §2.3.2` |

---

## 6. API / Interface Contract

### 6.1 REST Endpoint

```
GET /api/persons/active?maxAgeMs=300000
```

Returns all persons seen within the last `maxAgeMs` milliseconds (default: 5 minutes).

**Response:**
```json
{
  "total": 3,
  "persons": [
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
  ]
}
```

### 6.2 Socket.IO Event: `person:trajectory-update`

Emitted on first detection or camera transition.

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

### 6.3 Updated `face:reidentified` Event

Includes `newObjectId` (the ByteTracker object ID in the destination camera):

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

`newObjectId` is `null` if the face could not be matched to a tracked person body.

### 6.4 Cross-Camera Stats Endpoint

```
GET /api/crosscamera/stats
```

```json
{
  "totalTransitions": 3,
  "uniqueFaces": 2,
  "faces": [
    {
      "faceId":          "F7",
      "firstCameraId":   "<camera-A-uuid>",
      "lastCameraId":    "<camera-B-uuid>",
      "transitionCount": 2,
      "lastSeenAt":      1716015600000
    }
  ]
}
```

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | A face first detected in Camera-A is assigned alias `P1` (or next available `Pn`) within the current detection frame. |
| AC-02 | When the same face moves to Camera-B, `person:trajectory-update` is emitted with two segments: one for Camera-A (closed) and one for Camera-B (open). |
| AC-03 | The alias assigned to a person does not change even after the ArcFace gallery entry expires and re-creates a new `faceId` in the same session. |
| AC-04 | `GET /api/persons/active` returns all persons seen within the last 5 minutes; response conforms to the `PersonTrajectory` schema. |
| AC-05 | On dashboard page load, `usePersonTrajectoryStore` is hydrated with data from `/api/persons/active` within 2 seconds. |
| AC-06 | The Person Trails panel in the fullscreen camera view lists all persons who visited the camera, with their trajectory displayed as `Camera-A → Camera-B ► Here`. |
| AC-07 | A teal alias badge (e.g., `P3`) appears in the `DetectionRow` next to the face ID for all detected faces with a registry entry. |
| AC-08 | `face:reidentified` event includes a non-null `newObjectId` when the transitioned face is matched to a visible person track in the destination camera. |
| AC-09 | `GET /api/crosscamera/stats` correctly reflects the total number of cross-camera transitions and unique faces. |
| AC-10 | Registry memory usage does not grow unboundedly; a TTL cleanup mechanism removes entries older than a configurable threshold. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | PersonTrajectory data model + server registry in PipelineManager | TBD | May 2026 | ✅ Done |
| M2 | `person:trajectory-update` Socket.IO event emission | TBD | May 2026 | ✅ Done |
| M3 | `GET /api/persons/active` REST endpoint | TBD | May 2026 | ✅ Done |
| M4 | `usePersonTrajectoryStore` Zustand store + App.tsx socket listener + hydration | TBD | May 2026 | ✅ Done |
| M5 | Person Trails panel + alias badge in FullscreenCameraView.tsx | TBD | May 2026 | ✅ Done |
| M6 | Multi-camera dwell aggregation (Phase 2) | TBD | - | ⏳ Pending |
| M7 | Return pattern detection (Phase 2) | TBD | - | ⏳ Pending |
| M8 | DB persistence — `faceTrajectories` table + `GET /api/analysis/face-trajectories` + MCP tool | Jun 2026 | Jun 2026 | ✅ Done |

### 8.2 TODO

- [ ] Implement TTL cleanup for the in-process `_personTrajectory` Map to prevent memory growth in long sessions
- [ ] Implement multi-camera dwell aggregation: `totalDwell = Σ(segment.exitTime − segment.entryTime)` across all segments
- [ ] Implement return pattern detection: flag when a person's trajectory contains the same `cameraId` more than once
- [ ] Expose BehaviorEngine loitering alerts with cumulative cross-camera dwell as an additional risk factor
- [ ] Write unit tests for trajectory creation, segment append, and cross-camera transition logic in `pipelineManager.js`
- [ ] Write integration tests for `person:trajectory-update` Socket.IO event emission
- [ ] Add query parameters to `/api/persons/active` for filtering by camera ID or alias
- [ ] Define and document Redis upgrade path for multi-server trajectory sharing

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for CrossCamera Face Tracking |
| 1.1 | 2026-06-25 | LTS Engineering Team | M8 완료 — DB 영속화 (faceTrajectories), REST API, MCP tool query_face_trajectories |
