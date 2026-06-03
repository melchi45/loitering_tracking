# TEST CASES (TC)
# Cross-Camera Face Tracking & Global Person Registry

| | |
|---|---|
| **Document ID** | TC-LTS-CCFR-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_CrossCamera_Face_Tracking.md |
| **Test Scripts** | test/api/cross_camera_tracking.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Trajectory REST API](#3-test-group-a--trajectory-rest-api)
4. [Test Group B — Cross-Camera Stats API](#4-test-group-b--cross-camera-stats-api)
5. [Test Group C — Active Persons API](#5-test-group-c--active-persons-api)
6. [Test Group D — Shared Gallery Logic (Unit)](#6-test-group-d--shared-gallery-logic-unit)
7. [Test Group E — Person Registry Logic (Unit)](#7-test-group-e--person-registry-logic-unit)
8. [Test Group F — Socket.IO Events (Integration)](#8-test-group-f--socketio-events-integration)
9. [Test Group G — Edge Cases and Error Handling](#9-test-group-g--edge-cases-and-error-handling)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | Trajectory, stats, active persons endpoints | Node.js built-in fetch | `test/api/cross_camera_tracking.test.js` |
| Unit | _cosineSim, gallery matching, registry logic | Node.js, direct import | `test/unit/cross_camera.test.js` (Phase-2) |
| Integration | Socket.IO event emission on transitions | Node.js + socket.io-client | `test/integration/cross_camera.test.js` (Phase-2) |
| E2E | Live cross-camera person tracking | Manual / Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|-----------------|-------------|
| FR-CCFR-001 | TC-D-001 |
| FR-CCFR-002 | TC-D-002 |
| FR-CCFR-003 | TC-D-003 |
| FR-CCFR-004 | TC-D-004 |
| FR-CCFR-005 | TC-D-005 |
| FR-CCFR-006 | TC-D-006, TC-G-001 |
| FR-CCFR-010 | TC-D-007 |
| FR-CCFR-011 | TC-F-001 |
| FR-CCFR-012 | TC-B-001, TC-B-002 |
| FR-CCFR-013 | TC-D-008 |
| FR-CCFR-020 | TC-E-001 |
| FR-CCFR-021 | TC-E-002 |
| FR-CCFR-022 | TC-E-003 |
| FR-CCFR-023 | TC-E-004 |
| FR-CCFR-024 | TC-E-005, TC-F-002 |
| FR-CCFR-025 | TC-E-006 |
| FR-CCFR-026 | TC-F-003 |
| FR-CCFR-030 | TC-E-007, TC-F-001 |
| FR-CCFR-031 | TC-E-008 |
| FR-CCFR-032 | TC-F-002, TC-F-004 |
| FR-CCFR-033 | TC-G-002 |
| FR-CCFR-040 | TC-A-001, TC-A-002, TC-A-003 |
| FR-CCFR-041 | TC-B-001, TC-B-002 |
| FR-CCFR-042 | TC-C-001, TC-C-002, TC-C-003 |
| FR-CCFR-050 | TC-F-002, TC-F-004 |
| FR-CCFR-051 | TC-F-001 |
| FR-CCFR-052 | TC-F-003 |

### 1.3 Test Data

| Artifact | Purpose |
|----------|---------|
| `PersonTrajectory` fixture (JSON) | Validate response schema |
| `PersonSegment` fixture | Validate segment schema |
| Two camera UUID constants | Cross-camera transition simulation |
| Mock embedding (512 zeros + 1.0 in slot 0) | Cosine similarity unit tests |

---

## 2. Test Environment and Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `GET /health` returns `{ status: 'ok' }`
- ArcFace model may or may not be loaded — REST endpoints are available regardless

### 2.2 Test Isolation

- REST endpoint tests (Groups A, B, C) do not require any cameras to be running.
- They query the current in-memory state; results are empty if no cameras have been active.
- Tests assert response structure (HTTP 200, `success: true`, `data` is array) without asserting specific content.

### 2.3 Dependencies

```
node >= 18
No additional npm packages — uses built-in fetch (Node 18+)
```

---

## 3. Test Group A — Trajectory REST API

**Script:** `test/api/cross_camera_tracking.test.js` (Group A)

### TC-A-001 — GET /api/faces/trajectories — Returns 200

- **SRS:** FR-CCFR-040
- **Steps:**
  1. `GET /api/faces/trajectories`
  2. Assert HTTP 200
  3. Assert `body.success === true`
  4. Assert `body.data` is an array

### TC-A-002 — GET /api/faces/trajectories?maxAgeMs=60000 — Filter Applied

- **SRS:** FR-CCFR-040
- **Steps:**
  1. `GET /api/faces/trajectories?maxAgeMs=60000`
  2. Assert HTTP 200
  3. Assert `body.data` is an array
  4. For each entry in `body.data`: Assert `entry.lastSeenAt > Date.now() - 60000`

### TC-A-003 — GET /api/faces/trajectories — Response Schema Validation

- **SRS:** FR-CCFR-022, FR-CCFR-023, FR-CCFR-040
- **Precondition:** `body.data.length > 0` (skip schema check if empty)
- **Steps:**
  1. `GET /api/faces/trajectories`
  2. If data is non-empty, for the first entry assert:
     - `entry.faceId` is a non-empty string (e.g. starts with 'F')
     - `entry.alias` is a non-empty string (e.g. starts with 'P')
     - `entry.firstSeenAt` is a positive number
     - `entry.lastSeenAt >= entry.firstSeenAt`
     - `entry.currentCameraId` is a non-empty string
     - `entry.segments` is an array with at least 1 element
  3. For each segment in `entry.segments`:
     - `segment.cameraId` is a non-empty string
     - `segment.entryTime` is a positive number
     - `segment.exitTime >= segment.entryTime`
     - `segment.objectId` is a number or null

### TC-A-004 — GET /api/faces/trajectories — Segments Ordered Chronologically

- **SRS:** FR-CCFR-031
- **Precondition:** At least one trajectory with multiple segments in the response
- **Steps:**
  1. `GET /api/faces/trajectories`
  2. For any trajectory with `segments.length >= 2`:
     - For each consecutive pair: Assert `segments[i].entryTime <= segments[i+1].entryTime`

### TC-A-005 — GET /api/faces/trajectories?maxAgeMs=1 — Very Short Window Returns Empty or Recent

- **SRS:** FR-CCFR-040
- **Steps:**
  1. `GET /api/faces/trajectories?maxAgeMs=1`
  2. Assert HTTP 200
  3. Assert `body.data` is an array
  4. Assert all returned persons have `lastSeenAt > Date.now() - 5` (within last 5 ms)
  5. (In practice this will be empty — test validates filter logic)

---

## 4. Test Group B — Cross-Camera Stats API

**Script:** `test/api/cross_camera_tracking.test.js` (Group B)

### TC-B-001 — GET /api/faces/cross-camera-stats — Returns 200

- **SRS:** FR-CCFR-041
- **Steps:**
  1. `GET /api/faces/cross-camera-stats`
  2. Assert HTTP 200
  3. Assert `body.success === true`
  4. Assert `body.data` is an array

### TC-B-002 — GET /api/faces/cross-camera-stats — Response Schema

- **SRS:** FR-CCFR-012, FR-CCFR-041
- **Precondition:** `body.data.length > 0`
- **Steps:**
  1. `GET /api/faces/cross-camera-stats`
  2. If non-empty, for the first entry assert:
     - `entry.faceId` is a non-empty string
     - `entry.firstCameraId` is a non-empty string
     - `entry.lastCameraId` is a non-empty string
     - `entry.transitionCount` is a positive integer (≥ 1)
     - `entry.lastSeenAt` is a positive number (Unix ms)

### TC-B-003 — GET /api/faces/cross-camera-stats — transitionCount Is Non-Negative

- **SRS:** FR-CCFR-012
- **Steps:**
  1. `GET /api/faces/cross-camera-stats`
  2. For each entry in `body.data`:
     - Assert `entry.transitionCount >= 1`
     - (Stats entries are only created on actual transitions)

---

## 5. Test Group C — Active Persons API

**Script:** `test/api/cross_camera_tracking.test.js` (Group C)

### TC-C-001 — GET /api/persons/active — Returns 200 with total

- **SRS:** FR-CCFR-042
- **Steps:**
  1. `GET /api/persons/active`
  2. Assert HTTP 200
  3. Assert `body.success === true`
  4. Assert `body.persons` is an array
  5. Assert `body.total === body.persons.length`

### TC-C-002 — GET /api/persons/active?maxAgeMs=300000 — Default Behavior

- **SRS:** FR-CCFR-042
- **Steps:**
  1. `GET /api/persons/active?maxAgeMs=300000`
  2. Assert HTTP 200
  3. Assert `body.persons` is an array
  4. For each person: Assert `person.lastSeenAt > Date.now() - 300000`

### TC-C-003 — GET /api/persons/active — PersonTrajectory Schema

- **SRS:** FR-CCFR-022, FR-CCFR-042
- **Precondition:** `body.persons.length > 0`
- **Steps:**
  1. `GET /api/persons/active`
  2. For the first person entry assert:
     - `person.faceId` is string
     - `person.alias` starts with 'P'
     - `person.firstSeenAt` is positive number
     - `person.lastSeenAt >= person.firstSeenAt`
     - `person.currentCameraId` is non-empty string
     - `person.segments` is array with ≥ 1 element

### TC-C-004 — GET /api/persons/active — total Matches persons.length

- **SRS:** FR-CCFR-042
- **Steps:**
  1. `GET /api/persons/active?maxAgeMs=600000`
  2. Assert `body.total` is a non-negative integer
  3. Assert `body.total === body.persons.length`

---

## 6. Test Group D — Shared Gallery Logic (Unit)

**Type:** Unit tests — direct module import (Phase-2 automation target)

### TC-D-001 — SharedGalleryEntry Has Required Fields

- **SRS:** FR-CCFR-001
- **Steps:**
  1. Simulate first face detection in `_assignFaceIds()`
  2. Inspect `pipelineManager._sharedFaceGallery[0]`
  3. Assert fields: `faceId`, `embedding` (length=512), `lastSeenAt`, `lastCameraId`

### TC-D-002 — FaceId Sequential Assignment (F1, F2, ...)

- **SRS:** FR-CCFR-002
- **Steps:**
  1. Start with empty gallery
  2. Process 3 distinct faces (embeddings far apart in cosine space)
  3. Assert faceIds are `'F1'`, `'F2'`, `'F3'` in order

### TC-D-003 — Gallery Entry Created on New Face

- **SRS:** FR-CCFR-003
- **Steps:**
  1. Empty gallery
  2. Process one face
  3. Assert `_sharedFaceGallery.length === 1`
  4. Assert entry has correct `cameraId` and `lastSeenAt`

### TC-D-004 — Matching Threshold 0.35

- **SRS:** FR-CCFR-004
- **Steps:**
  1. Add gallery entry with known embedding
  2. Process face with cosine similarity = 0.34 → Assert NEW faceId assigned
  3. Process face with cosine similarity = 0.36 → Assert SAME faceId reused

### TC-D-005 — Gallery Entry Updated on Re-Detection (Same Camera)

- **SRS:** FR-CCFR-005
- **Steps:**
  1. Detect face on Camera-A at time T1
  2. Detect same face on Camera-A at time T2 (T2 > T1)
  3. Assert `_sharedFaceGallery.length === 1` (no new entry)
  4. Assert `entry.lastSeenAt === T2`
  5. Assert `entry.lastCameraId === Camera-A`

### TC-D-006 — Gallery Entry Pruned After 30 s

- **SRS:** FR-CCFR-006
- **Steps:**
  1. Add gallery entry with `lastSeenAt = now - 31000` (31 seconds ago)
  2. Call `_assignFaceIds()` with any face
  3. Assert the old entry is removed from `_sharedFaceGallery`

### TC-D-007 — Cross-Camera Transition Detected When lastCameraId Differs

- **SRS:** FR-CCFR-010
- **Steps:**
  1. Add gallery entry: `{ faceId: 'F1', lastCameraId: 'cam-A', embedding: [...] }`
  2. Process same face on `cam-B` (cosine similarity ≥ 0.35)
  3. Assert `crossCameraTransitions` array contains entry `{ faceId: 'F1', prevCameraId: 'cam-A', newCameraId: 'cam-B' }`

### TC-D-008 — Object ID Resolved via Bbox Proximity

- **SRS:** FR-CCFR-013
- **Steps:**
  1. `attrObjects` contains `{ objectId: 42, face: { bbox: { x: 100, y: 50, width: 40, height: 50 } } }`
  2. Call `_resolveObjectId({ x: 101, y: 51, width: 40, height: 50 }, attrObjects)` (within 3 px)
  3. Assert returns `42`
  4. Call `_resolveObjectId({ x: 200, y: 200, width: 40, height: 50 }, attrObjects)` (far away)
  5. Assert returns `null`

---

## 7. Test Group E — Person Registry Logic (Unit)

**Type:** Unit tests

### TC-E-001 — PersonTrajectory Map Initialized Empty

- **SRS:** FR-CCFR-020
- **Steps:**
  1. Create new PipelineManager instance
  2. Assert `pipelineManager._personTrajectory` is a Map
  3. Assert `pipelineManager._personTrajectory.size === 0`

### TC-E-002 — Alias Sequential Assignment (P1, P2, ...)

- **SRS:** FR-CCFR-021
- **Steps:**
  1. Start with empty registry
  2. Process 3 new distinct faceIds via `_updatePersonRegistry()`
  3. Assert aliases are `'P1'`, `'P2'`, `'P3'` in order

### TC-E-003 — PersonTrajectory Schema on Creation

- **SRS:** FR-CCFR-022
- **Steps:**
  1. Call `_updatePersonRegistry('F1', 'cam-A', face, now, false)`
  2. Get entry: `traj = _personTrajectory.get('F1')`
  3. Assert `traj.faceId === 'F1'`
  4. Assert `traj.alias === 'P1'`
  5. Assert `traj.firstSeenAt === now`
  6. Assert `traj.lastSeenAt === now`
  7. Assert `traj.currentCameraId === 'cam-A'`
  8. Assert `traj.segments.length === 1`

### TC-E-004 — PersonSegment Schema on First Detection

- **SRS:** FR-CCFR-023
- **Steps:**
  1. Create trajectory via first detection
  2. `seg = traj.segments[0]`
  3. Assert `seg.cameraId === 'cam-A'`
  4. Assert `seg.entryTime === now`
  5. Assert `seg.exitTime === now`
  6. Assert `seg.objectId` is number or null

### TC-E-005 — First Detection Creates Registry Entry and Emits Event

- **SRS:** FR-CCFR-024
- **Steps:**
  1. Monitor Socket.IO emissions
  2. Process first detection of a new face
  3. Assert `_personTrajectory.has('F1') === true`
  4. Assert `person:trajectory-update` was emitted with the new trajectory

### TC-E-006 — Same-Camera Update Does Not Emit Event

- **SRS:** FR-CCFR-025
- **Steps:**
  1. Register face on Camera-A
  2. Reset emission spy
  3. Process same face on Camera-A again (same camera)
  4. Assert `person:trajectory-update` was NOT emitted
  5. Assert `_personTrajectory.get('F1').lastSeenAt` is updated

### TC-E-007 — Camera Transition Appends Segment

- **SRS:** FR-CCFR-030
- **Steps:**
  1. Register face on Camera-A (segments.length = 1)
  2. Process same face on Camera-B (cross-camera)
  3. `traj = _personTrajectory.get('F1')`
  4. Assert `traj.segments.length === 2`
  5. Assert `traj.segments[0].cameraId === 'cam-A'`
  6. Assert `traj.segments[0].exitTime` is updated (closed)
  7. Assert `traj.segments[1].cameraId === 'cam-B'`
  8. Assert `traj.currentCameraId === 'cam-B'`

### TC-E-008 — Segments Ordered Chronologically

- **SRS:** FR-CCFR-031
- **Steps:**
  1. Register face on Camera-A at T1
  2. Transition to Camera-B at T2 (T2 > T1)
  3. Transition to Camera-C at T3 (T3 > T2)
  4. Assert `segments[0].entryTime <= segments[1].entryTime`
  5. Assert `segments[1].entryTime <= segments[2].entryTime`

---

## 8. Test Group F — Socket.IO Events (Integration)

**Type:** Integration (socket.io-client)

### TC-F-001 — face:reidentified Event Schema

- **SRS:** FR-CCFR-011, FR-CCFR-051
- **Steps:**
  1. Connect Socket.IO client
  2. Wait for a `face:reidentified` event (requires active camera with cross-camera detection)
  3. Assert payload has: `faceId`, `prevCameraId`, `newCameraId`, `newObjectId`, `similarity`, `timestamp`
  4. Assert `faceId` starts with 'F'
  5. Assert `similarity ≥ 0.35`
  6. Assert `newObjectId` is number or null
  7. Assert `timestamp` is Unix ms (> 1700000000000)

### TC-F-002 — person:trajectory-update Event on First Detection

- **SRS:** FR-CCFR-024, FR-CCFR-050, FR-CCFR-032
- **Steps:**
  1. Connect Socket.IO client
  2. Wait for a `person:trajectory-update` event
  3. Assert payload is a complete `PersonTrajectory`:
     - `faceId`, `alias`, `firstSeenAt`, `lastSeenAt`, `currentCameraId`, `segments`
  4. Assert `alias` starts with 'P'
  5. Assert `segments` is array with ≥ 1 element

### TC-F-003 — detections Event Contains alias Field

- **SRS:** FR-CCFR-026, FR-CCFR-052
- **Steps:**
  1. Connect Socket.IO client and join a camera room
  2. Wait for a `detections` event
  3. For objects that include a `face` sub-object:
     - If face is registered, Assert `face.alias` starts with 'P' or equals null
     - `face.alias` shall not be undefined

### TC-F-004 — person:trajectory-update Event on Camera Transition

- **SRS:** FR-CCFR-030, FR-CCFR-050, FR-CCFR-032
- **Steps:**
  1. Connect Socket.IO client
  2. Wait for a `person:trajectory-update` where `segments.length >= 2`
  3. Assert: second segment's `cameraId !== first segment's cameraId` (actual transition)
  4. Assert first segment `exitTime` is less than second segment `entryTime` or equal

---

## 9. Test Group G — Edge Cases and Error Handling

**Script:** `test/api/cross_camera_tracking.test.js` (Group G)

### TC-G-001 — Expired Gallery Entries Do Not Appear in Stats

- **SRS:** FR-CCFR-006
- **Steps:**
  1. `GET /api/faces/cross-camera-stats`
  2. For each stat entry: Assert `entry.lastSeenAt > 0`
  3. (Entries remain in stats even after gallery expiry — stats are session-persistent)
  4. Assert no entry has `transitionCount < 0`

### TC-G-002 — Registry Entries Not Deleted During Session

- **SRS:** FR-CCFR-033
- **Steps:**
  1. `GET /api/faces/trajectories` and note count N1
  2. Wait 35 seconds (gallery expiry window passes)
  3. `GET /api/faces/trajectories` with no maxAgeMs filter
  4. Note count N2
  5. Assert N2 >= N1 (entries may accumulate but are never deleted)
  6. (Note: with strict `maxAgeMs` the count may be lower — test without filter)

### TC-G-003 — GET /api/persons/active — maxAgeMs=0 Returns Empty

- **SRS:** FR-CCFR-042
- **Steps:**
  1. `GET /api/persons/active?maxAgeMs=0`
  2. Assert HTTP 200
  3. Assert `body.persons.length === 0` (no person was seen in the last 0 ms)
  4. Assert `body.total === 0`

### TC-G-004 — GET /api/faces/trajectories — Invalid maxAgeMs Handled Gracefully

- **Steps:**
  1. `GET /api/faces/trajectories?maxAgeMs=not-a-number`
  2. Assert HTTP 200 (not a 400/500)
  3. Assert `body.data` is an array
  4. (Server should treat invalid param as no filter or as default)

### TC-G-005 — All Three Endpoints Consistent (Same Underlying Data)

- **SRS:** FR-CCFR-040, FR-CCFR-042
- **Steps:**
  1. `GET /api/faces/trajectories` → count F1
  2. `GET /api/persons/active?maxAgeMs=86400000` (24 hours) → count P1
  3. Assert F1 >= P1 (trajectories includes all; persons/active may be filtered)
  4. Both shall return non-negative integer counts

---

## 10. Test Execution Order

```
Phase 1 — Prerequisite Checks
  Check server health (GET /health → 200)
  Check face capability (GET /api/capabilities)

Phase 2 — Trajectory REST API (Group A)
  TC-A-001 through TC-A-005
  (Independent; no camera required)

Phase 3 — Cross-Camera Stats (Group B)
  TC-B-001 through TC-B-003
  (Independent)

Phase 4 — Active Persons API (Group C)
  TC-C-001 through TC-C-004
  (Independent)

Phase 5 — Shared Gallery Units (Group D)
  TC-D-001 through TC-D-008
  (Unit tests; require direct module import)

Phase 6 — Person Registry Units (Group E)
  TC-E-001 through TC-E-008
  (Unit tests)

Phase 7 — Socket.IO Integration (Group F)
  TC-F-001 through TC-F-004
  Prerequisites: live cameras with face detection and cross-camera coverage

Phase 8 — Edge Cases (Group G)
  TC-G-001 through TC-G-005
```

---

## 11. Pass/Fail Criteria

### 11.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|-------|--------------------|----------|
| A — Trajectory API | 100% (5/5) | Yes |
| B — Stats API | 100% (3/3) | Yes |
| C — Active Persons API | 100% (4/4) | Yes |
| D — Shared Gallery | 100% (8/8) | Yes |
| E — Person Registry | 100% (8/8) | Yes |
| F — Socket.IO Events | ≥ 75% (3/4) | Yes |
| G — Edge Cases | ≥ 80% (4/5) | Yes |

### 11.2 Known Skip Conditions

| Test | Skip Condition |
|------|----------------|
| TC-A-003 (schema validation) | Requires active cameras; skip in isolated API tests |
| TC-D-001 through TC-D-008 | Require direct module import; skip in REST-only CI mode |
| TC-E-001 through TC-E-008 | Require direct module import; skip in REST-only CI mode |
| TC-F-001 through TC-F-004 | Require live cross-camera face detection; skip if no cameras |
| TC-G-002 (35-second wait) | Long-running; skip in fast CI mode |

### 11.3 Failure Response

| Severity | Condition | Action |
|----------|-----------|--------|
| Critical | Any Group A, B, or C REST endpoint failure | Block release; REST endpoints are the integration contract |
| High | Any Group D or E unit test failure | Block release; gallery and registry logic is core |
| Medium | Group F Socket.IO test failure | Investigate emission path; may block if cross-camera events are not reaching clients |
| Low | Group G edge case failures | Log; fix in next sprint |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for CrossCamera Face Tracking |
