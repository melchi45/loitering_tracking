# TEST CASES (TC)
# Object Tracking Subsystem

| | |
|---|---|
| **Document ID** | TC-LTS-TRK-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_Object_Tracking.md |
| **Test Scripts** | test/api/object_tracking.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Zone CRUD API](#3-test-group-a--zone-crud-api)
4. [Test Group B — Tracker Config API](#4-test-group-b--tracker-config-api)
5. [Test Group C — Kalman Filter Behavior](#5-test-group-c--kalman-filter-behavior)
6. [Test Group D — ByteTracker Assignment](#6-test-group-d--bytetracker-assignment)
7. [Test Group E — BehaviorEngine Metrics](#7-test-group-e--behaviorengine-metrics)
8. [Test Group F — Socket.IO Events](#8-test-group-f--socketio-events)
9. [Test Group G — Edge Cases and Error Handling](#9-test-group-g--edge-cases-and-error-handling)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | Zone CRUD, tracker config | Node.js built-in fetch | `test/api/object_tracking.test.js` |
| Unit | KalmanFilter, ByteTracker, BehaviorEngine | Node.js, direct import | `test/unit/tracking.test.js` (Phase-2) |
| Integration | Full pipeline events via Socket.IO | Node.js + socket.io-client | `test/integration/tracking_pipeline.test.js` (Phase-2) |
| E2E | Live camera loitering detection | Manual / Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|-----------------|-------------|
| FR-TRK-001 | TC-C-001 |
| FR-TRK-002 | TC-C-002 |
| FR-TRK-003 | TC-C-001 |
| FR-TRK-004 | TC-C-003 |
| FR-TRK-005 | TC-C-004 |
| FR-TRK-006 | TC-D-001 |
| FR-TRK-007 | TC-D-002 |
| FR-TRK-008 | TC-D-003 |
| FR-TRK-009 | TC-D-004 |
| FR-TRK-010 | TC-D-001, TC-D-005 |
| FR-TRK-011 | TC-E-001 |
| FR-TRK-012 | TC-E-002 |
| FR-TRK-013 | TC-E-003 |
| FR-TRK-014 | TC-E-004 |
| FR-TRK-015 | TC-E-005 |
| FR-TRK-016 | TC-E-006 |
| FR-TRK-017 | TC-E-007 |
| FR-TRK-018 | TC-E-008 |
| FR-TRK-019 | TC-E-009 |
| FR-TRK-020 | TC-A-001, TC-A-002 |
| FR-TRK-021 | TC-A-006 |
| FR-TRK-022 | TC-A-008 |
| FR-TRK-023 | TC-G-001 |

### 1.3 Test Data

| Artifact | Purpose |
|----------|---------|
| Camera UUID (`test-camera-id`) | Fixed ID for zone test isolation |
| Sample polygon (4-point rectangle) | Valid zone creation |
| Single point polygon | Invalid polygon rejection |
| Sample detections array | ByteTracker unit test input |
| Mock frame sequence | BehaviorEngine dwell/risk test input |

---

## 2. Test Environment and Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3001`
- `GET /health` returns `{ status: 'ok' }`
- At least one camera registered in the system (for zone tests)

### 2.2 Clean State

- Each test group that creates zones cleans up created zones after completion.
- Tracker config is reset to defaults before and after Group B tests.

### 2.3 Dependencies

```
node >= 18
No additional npm packages — uses built-in fetch (Node 18+)
```

---

## 3. Test Group A — Zone CRUD API

**Script:** `test/api/object_tracking.test.js` (Group A)

### TC-A-001 — Create MONITOR Zone — Success

- **SRS:** FR-TRK-020, FR-TRK-021
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ name: 'Test Zone', type: 'MONITOR', polygon: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}], dwellThreshold: 30 }`
  2. Assert HTTP 201
  3. Assert `data.type === 'MONITOR'`
  4. Assert `data.id` is a valid UUID
  5. Assert `data.polygon.length === 4`
  6. Assert `data.dwellThreshold === 30`
- **Cleanup:** DELETE created zone

### TC-A-002 — Create EXCLUDE Zone — Success

- **SRS:** FR-TRK-020
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ name: 'Exclude Zone', type: 'EXCLUDE', polygon: [{x:0,y:0},{x:50,y:0},{x:50,y:50},{x:0,y:50}] }`
  2. Assert HTTP 201
  3. Assert `data.type === 'EXCLUDE'`
- **Cleanup:** DELETE created zone

### TC-A-003 — Create Zone — Defaults Applied

- **SRS:** FR-TRK-020, FR-TRK-021
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ name: 'Default Zone', polygon: [{x:0,y:0},{x:200,y:0},{x:200,y:200},{x:0,y:200}] }` (no type or dwellThreshold)
  2. Assert HTTP 201
  3. Assert `data.type === 'MONITOR'` (default)
  4. Assert `data.dwellThreshold` is a positive number
- **Cleanup:** DELETE created zone

### TC-A-004 — List Zones for Camera — Empty

- **SRS:** FR-TRK-020
- **Steps:**
  1. Use a camera ID that has no zones
  2. `GET /api/cameras/:cameraId/zones`
  3. Assert HTTP 200
  4. Assert `data` is an array
  5. Assert `data.length === 0`

### TC-A-005 — List Zones for Camera — Returns Created Zones

- **SRS:** FR-TRK-020
- **Steps:**
  1. Create 2 zones for a test camera
  2. `GET /api/cameras/:cameraId/zones`
  3. Assert `data.length === 2`
  4. Assert both zone IDs are present
- **Cleanup:** DELETE both zones

### TC-A-006 — Create Zone — Polygon Too Short (< 3 points) → 400

- **SRS:** FR-TRK-021
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ name: 'Bad Zone', polygon: [{x:0,y:0},{x:100,y:0}] }` (only 2 points)
  2. Assert HTTP 400
  3. Assert `success === false`
  4. Assert `error` contains 'polygon' or '3'

### TC-A-007 — Create Zone — Missing Name → 400

- **SRS:** FR-TRK-021
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ polygon: [{x:0,y:0},{x:100,y:0},{x:100,y:100}] }` (no name)
  2. Assert HTTP 400

### TC-A-008 — Create Zone — With Schedule

- **SRS:** FR-TRK-022
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ ..., schedule: { startTime: '08:00', endTime: '20:00', days: ['Mon','Tue','Wed','Thu','Fri'] } }`
  2. Assert HTTP 201
  3. Assert `data.schedule.startTime === '08:00'`
  4. Assert `data.schedule.days.length === 5`
- **Cleanup:** DELETE created zone

### TC-A-009 — Update Zone — dwellThreshold

- **SRS:** FR-TRK-020
- **Steps:**
  1. Create a zone with `dwellThreshold: 30`
  2. `PUT /api/cameras/:cameraId/zones/:zoneId` with `{ dwellThreshold: 60 }`
  3. Assert HTTP 200
  4. Assert `data.dwellThreshold === 60`
- **Cleanup:** DELETE zone

### TC-A-010 — Update Zone — Not Found → 404

- **SRS:** FR-TRK-020
- **Steps:**
  1. `PUT /api/cameras/:cameraId/zones/00000000-0000-0000-0000-000000000000` with `{ dwellThreshold: 45 }`
  2. Assert HTTP 404
  3. Assert `success === false`

### TC-A-011 — Delete Zone → 200 and Removed

- **SRS:** FR-TRK-020
- **Steps:**
  1. Create a zone
  2. `DELETE /api/cameras/:cameraId/zones/:zoneId`
  3. Assert HTTP 200
  4. `GET /api/cameras/:cameraId/zones` → Assert zone is not in list

### TC-A-012 — Delete Zone — Not Found → 404

- **SRS:** FR-TRK-020
- **Steps:**
  1. `DELETE /api/cameras/:cameraId/zones/00000000-0000-0000-0000-000000000000`
  2. Assert HTTP 404
  3. Assert `success === false`

### TC-A-013 — Create Zone — Invalid Type → 400

- **SRS:** FR-TRK-020
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ name: 'Bad Type', type: 'WATCH', polygon: [...] }`
  2. Assert HTTP 400
  3. Assert `error` contains 'MONITOR or EXCLUDE'

---

## 4. Test Group B — Tracker Config API

**Script:** `test/api/object_tracking.test.js` (Group B)

### TC-B-001 — GET /api/tracker/config — Returns Config Object

- **SRS:** NFR-TRK-01 (performance tuning)
- **Steps:**
  1. `GET /api/tracker/config`
  2. Assert HTTP 200
  3. Assert `success === true`
  4. Assert `data` has fields: `iouThreshold`, `maxAge`, `iouWeight`, `faceWeight`
  5. Assert all fields are numbers

### TC-B-002 — PUT /api/tracker/config — Update iouThreshold

- **SRS:** NFR-TRK-01
- **Steps:**
  1. `PUT /api/tracker/config` with `{ iouThreshold: 0.4 }`
  2. Assert HTTP 200
  3. Assert `data.iouThreshold === 0.4`
  4. `GET /api/tracker/config` → Assert `data.iouThreshold === 0.4`
- **Cleanup:** POST /api/tracker/config/reset

### TC-B-003 — PUT /api/tracker/config — Update maxAge

- **SRS:** FR-TRK-008
- **Steps:**
  1. `PUT /api/tracker/config` with `{ maxAge: 120 }`
  2. Assert HTTP 200
  3. Assert `data.maxAge === 120`
- **Cleanup:** POST /api/tracker/config/reset

### TC-B-004 — POST /api/tracker/config/reset — Restores Defaults

- **SRS:** NFR-TRK-01
- **Steps:**
  1. `PUT /api/tracker/config` with `{ iouThreshold: 0.9, maxAge: 1 }`
  2. `POST /api/tracker/config/reset`
  3. Assert HTTP 200
  4. `GET /api/tracker/config` → Assert `data.iouThreshold` is default (0.25)
  5. Assert `data.maxAge` is default (90)

### TC-B-005 — PUT /api/tracker/config — Invalid Body → 400

- **Steps:**
  1. `PUT /api/tracker/config` with body `"not-an-object"` (raw string)
  2. Assert HTTP 400
  3. Assert `error === 'Body must be a JSON object.'`

---

## 5. Test Group C — Kalman Filter Behavior

**Type:** Unit (direct module import)

### TC-C-001 — KalmanFilter init — State Vector Set Correctly

- **SRS:** FR-TRK-001, FR-TRK-003
- **Steps:**
  1. `const kf = new KalmanFilter(); kf.init({ x: 10, y: 20, width: 50, height: 80 })`
  2. Assert `kf.x[0] === 10` (x)
  3. Assert `kf.x[1] === 20` (y)
  4. Assert `kf.x[2] === 50` (width)
  5. Assert `kf.x[3] === 80` (height)
  6. Assert `kf.x[4] === 0` (vx)
  7. Assert `kf.x[5] === 0` (vy)
  8. Assert `kf.x[6] === 0` (vw)
  9. Assert `kf.x[7] === 0` (vh)

### TC-C-002 — KalmanFilter — Measurement Vector Accepted

- **SRS:** FR-TRK-002
- **Steps:**
  1. `kf.init(bbox); kf.update({ x: 15, y: 25, width: 52, height: 82 })`
  2. Assert returned bbox has fields x, y, width, height
  3. Assert values are close to measurement (correction applied)

### TC-C-003 — KalmanFilter predict — Constant Velocity Motion

- **SRS:** FR-TRK-004
- **Steps:**
  1. `kf.init({ x: 0, y: 0, width: 50, height: 100 })`
  2. Manually set `kf.x[4] = 5` (vx)
  3. `const pred = kf.predict()`
  4. Assert `pred.x` is approximately 5 (x advanced by vx)

### TC-C-004 — KalmanFilter update — Corrects State Toward Measurement

- **SRS:** FR-TRK-005
- **Steps:**
  1. `kf.init({ x: 0, y: 0, width: 50, height: 100 })`
  2. `kf.predict()`
  3. `const corrected = kf.update({ x: 20, y: 10, width: 50, height: 100 })`
  4. Assert `corrected.x > 0` (pulled toward measurement)
  5. Assert `corrected.x < 20` (not fully at measurement — weighted blend)

---

## 6. Test Group D — ByteTracker Assignment

**Type:** Unit (direct module import)

### TC-D-001 — ByteTracker — New Detection Creates Track

- **SRS:** FR-TRK-006, FR-TRK-010
- **Steps:**
  1. `const bt = new ByteTracker(); const results = bt.update([{ bbox: {x:10,y:10,width:50,height:100}, confidence: 0.9, className: 'person' }])`
  2. Assert `results.length === 1`
  3. Assert `results[0].objectId` is a valid UUID
  4. Assert `results[0].bbox` is close to input bbox

### TC-D-002 — ByteTracker — objectId Persists Across Frames

- **SRS:** FR-TRK-007
- **Steps:**
  1. Create ByteTracker, update with 1 detection at `{x:10, y:10, w:50, h:100}`
  2. Note `objectId` from result
  3. `bt.update([...same detection slightly shifted...])` (IoU overlap)
  4. Assert new result has same `objectId`

### TC-D-003 — ByteTracker — Lost Track Buffered Before Removal

- **SRS:** FR-TRK-008
- **Steps:**
  1. Create ByteTracker with `{ maxAge: 5 }`
  2. Update with 1 detection → note objectId
  3. Update with empty detections for 3 frames
  4. Assert track is still returned (state Lost but within maxAge)
  5. Update with empty detections for 6 more frames (total > maxAge)
  6. Assert track is no longer returned

### TC-D-004 — ByteTracker — trackLifetime Counter Incremented

- **SRS:** FR-TRK-009
- **Steps:**
  1. `bt.update([detection])` → `age = 1`
  2. `bt.update([same detection])` → `age = 2`
  3. `bt.update([same detection])` → `age = 3`
  4. Access `bt._tracks[0].age` → Assert `=== 3`

### TC-D-005 — ByteTracker — IoU Below Threshold Creates New Track

- **SRS:** FR-TRK-010
- **Steps:**
  1. Create ByteTracker with `{ iouThreshold: 0.5 }`
  2. Update with detection at `{x:0, y:0, w:10, h:10}`
  3. Update with detection at `{x:200, y:200, w:10, h:10}` (no overlap)
  4. Assert two distinct tracks in result
  5. Assert objectIds are different

---

## 7. Test Group E — BehaviorEngine Metrics

**Type:** Unit (direct module import)

### TC-E-001 — BehaviorEngine — History Buffer Capacity

- **SRS:** FR-TRK-011
- **Steps:**
  1. Create BehaviorEngine with mock ZoneManager
  2. Feed 350 frames with same object inside MONITOR zone
  3. Access internal state: `engine._state.get(objectId).frames.length`
  4. Assert `≤ 300` (buffer capped)

### TC-E-002 — BehaviorEngine — dwellTime Computed Correctly

- **SRS:** FR-TRK-012
- **Steps:**
  1. Feed frame at timestamp T=0 with object in zone
  2. Feed frame at timestamp T=15000 (15 seconds later)
  3. Assert enriched object has `dwellTime ≈ 15`

### TC-E-003 — BehaviorEngine — revisitCount Increments on Re-entry

- **SRS:** FR-TRK-013
- **Steps:**
  1. Feed 5 frames with object inside zone (enteredAt = T0)
  2. Feed 2 frames with object outside zone (leftAt set)
  3. Feed 5 frames with same object back inside zone (within reentryWindow)
  4. Assert `revisitCount === 1`

### TC-E-004 — BehaviorEngine — Velocity Computed from Position History

- **SRS:** FR-TRK-014
- **Steps:**
  1. Feed 20 frames with object moving at constant 10 px per frame (10 FPS → 100 px/s)
  2. Assert enriched object `velocity` is approximately 100 px/s (within 20%)

### TC-E-005 — BehaviorEngine — circularScore for Loop Motion

- **SRS:** FR-TRK-015
- **Steps:**
  1. Feed 30 frames tracing a circular path (returning near start)
  2. Assert `circularScore > 0.5`
  3. For comparison: feed 30 frames of straight-line motion → Assert `circularScore < 0.2`

### TC-E-006 — BehaviorEngine — pacingScore for Back-and-Forth Motion

- **SRS:** FR-TRK-016
- **Steps:**
  1. Feed 30 frames alternating x direction (pacing pattern: +10, −10, +10, ...)
  2. Assert `pacingScore > 0.5`
  3. For comparison: straight motion → Assert `pacingScore < 0.1`

### TC-E-007 — BehaviorEngine — riskScore Weighted Correctly

- **SRS:** FR-TRK-017
- **Steps:**
  1. Create scenario: dwellTime = dwellThreshold (ratio=0.5), revisitCount=0, velocity=0, pacing=0, circular=0
  2. Expected riskScore ≈ 0.5 × 0.35 = 0.175
  3. Assert `riskScore` is approximately 0.175 (within 0.01)

### TC-E-008 — BehaviorEngine — isLoitering Flag Set When Threshold Crossed

- **SRS:** FR-TRK-018
- **Steps:**
  1. Create zone with `dwellThreshold: 10` and `minDisplacement: 100`
  2. Feed object in zone at same position for 11 seconds
  3. Assert enriched object `isLoitering === true`
  4. Assert same object with only 9 seconds has `isLoitering === false`

### TC-E-009 — BehaviorEngine — targetClasses Filter Respected

- **SRS:** FR-TRK-019
- **Steps:**
  1. Create zone with `targetClasses: ['person']`
  2. Feed a `className: 'car'` object inside zone
  3. Assert no dwell logic applied: `isLoitering === false`, `dwellTime === 0`
  4. Feed a `className: 'person'` object inside same zone
  5. Assert dwell logic applied: `dwellTime > 0`

---

## 8. Test Group F — Socket.IO Events

**Type:** Integration (socket.io-client)

### TC-F-001 — `loitering_alert` Event Schema Validated

- **SRS:** FR-TRK-018, §9.1
- **Steps:**
  1. Connect Socket.IO client and join a camera room
  2. Wait for a `loitering_alert` event (triggered by live or simulated camera)
  3. Assert payload has: `objectId`, `cameraId`, `zoneId`, `dwellTime`, `riskScore`, `timestamp`, `bbox`
  4. Assert `riskScore` is number in [0, 1]
  5. Assert `timestamp` is Unix ms (> 1700000000000)

### TC-F-002 — `detections` Event Contains riskScore and dwellTime

- **SRS:** §9.1
- **Steps:**
  1. Connect Socket.IO client and join a camera room
  2. Wait for a `detections` event
  3. Assert `objects` is an array
  4. For each object: Assert `objectId`, `bbox`, `riskScore`, `dwellTime` present
  5. Assert `riskScore ∈ [0, 1]`

### TC-F-003 — `detections:summary` Event Schema

- **SRS:** §9.1
- **Steps:**
  1. Connect Socket.IO client and join camera room
  2. Wait for `detections:summary` event
  3. Assert `activeCount` is non-negative integer
  4. Assert `loiteringCount` is non-negative integer
  5. Assert `zones` is an array

---

## 9. Test Group G — Edge Cases and Error Handling

**Script:** `test/api/object_tracking.test.js` (Group G)

### TC-G-001 — Point-in-Polygon — Boundary Conditions

- **SRS:** FR-TRK-023
- **Type:** Unit (import ZoneManager or BehaviorEngine helpers)
- **Steps:**
  1. Define rectangle polygon `[(0,0),(100,0),(100,100),(0,100)]`
  2. Test centroid (50, 50) → Assert inside = true
  3. Test centroid (101, 50) → Assert inside = false
  4. Test centroid (0, 0) (vertex) → Assert inside is deterministic (boundary case)

### TC-G-002 — Zone API — Server Error Handling

- **Steps:**
  1. `GET /api/cameras/nonexistent-camera-id/zones`
  2. Assert HTTP 200 with `data: []` (camera with no zones returns empty)

### TC-G-003 — Tracker Config — Partial Update Preserves Other Fields

- **Steps:**
  1. `GET /api/tracker/config` → record all field values
  2. `PUT /api/tracker/config` with `{ maxAge: 60 }`
  3. `GET /api/tracker/config`
  4. Assert `maxAge === 60`
  5. Assert all other fields unchanged from step 1
- **Cleanup:** POST /api/tracker/config/reset

### TC-G-004 — Zone Created for Unknown Camera — Accepted

- **Steps:**
  1. `POST /api/cameras/unknown-camera-xyz/zones` with valid body
  2. Assert HTTP 201 (zone manager does not validate camera existence)
  3. `GET /api/cameras/unknown-camera-xyz/zones` → Assert zone is listed
- **Cleanup:** DELETE created zone

### TC-G-005 — Create Zone with targetClasses

- **SRS:** FR-TRK-019
- **Steps:**
  1. `POST /api/cameras/:cameraId/zones` with `{ ..., targetClasses: ['person', 'vehicle'] }`
  2. Assert HTTP 201
  3. Assert `data.targetClasses` contains `'person'` and `'vehicle'`
- **Cleanup:** DELETE zone

---

## 10. Test Execution Order

```
Phase 1 — Prerequisite Checks
  Check server health (GET /health → 200)
  Confirm tracker config endpoint responds

Phase 2 — Zone CRUD (Group A)
  TC-A-001 through TC-A-013
  (Independent; each test cleans up after itself)

Phase 3 — Tracker Config (Group B)
  TC-B-001 through TC-B-005
  Reset config at end of phase

Phase 4 — KalmanFilter Units (Group C)
  TC-C-001 through TC-C-004
  (Unit tests; no server required)

Phase 5 — ByteTracker Units (Group D)
  TC-D-001 through TC-D-005
  (Unit tests; no server required)

Phase 6 — BehaviorEngine Units (Group E)
  TC-E-001 through TC-E-009
  (Unit tests with mock ZoneManager)

Phase 7 — Socket.IO Integration (Group F)
  TC-F-001 through TC-F-003
  Prerequisites: live camera with active zones

Phase 8 — Edge Cases (Group G)
  TC-G-001 through TC-G-005
```

---

## 11. Pass/Fail Criteria

### 11.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|-------|--------------------|----------|
| A — Zone CRUD | 100% (13/13) | Yes |
| B — Tracker Config | 100% (5/5) | Yes |
| C — KalmanFilter | 100% (4/4) | Yes |
| D — ByteTracker | 100% (5/5) | Yes |
| E — BehaviorEngine | 100% (9/9) | Yes |
| F — Socket.IO | 100% (3/3) | Yes |
| G — Edge Cases | ≥ 80% (4/5) | Yes |

### 11.2 Known Skip Conditions

| Test | Skip Condition |
|------|----------------|
| TC-C-003 (velocity model) | Requires manual KF state injection (unit test only) |
| TC-E-001 (buffer cap) | Requires 350+ simulated frames; skip in quick CI mode |
| TC-F-001, TC-F-002, TC-F-003 | Require a running camera with detections |

### 11.3 Failure Response

| Severity | Condition | Action |
|----------|-----------|--------|
| Critical | Any Group A failure | Block release; zone persistence is core |
| High | Any Group E or D failure | Block release; tracking accuracy is core |
| Medium | Group F failure | Investigate socket emission path; may block |
| Low | Group G partial failure | Log; fix in next sprint |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Object Tracking |
