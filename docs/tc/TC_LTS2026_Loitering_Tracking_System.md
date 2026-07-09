# TEST CASES (TC)
# LTS-2026 Loitering Tracking System — Main System

| | |
|---|---|
| **Document ID** | TC-LTS-MAIN-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_LTS2026_Loitering_Tracking_System.md |
| **Test Scripts** | test/api/main_system.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Video Ingestion & Multi-Camera](#3-test-group-a--video-ingestion--multi-camera)
4. [Test Group B — AI Detection Pipeline](#4-test-group-b--ai-detection-pipeline)
5. [Test Group C — Tracking Layer](#5-test-group-c--tracking-layer)
6. [Test Group D — Behavior & Zone Layer](#6-test-group-d--behavior--zone-layer)
7. [Test Group E — Alert & Storage Layer](#7-test-group-e--alert--storage-layer)
8. [Test Group F — REST API](#8-test-group-f--rest-api)
9. [Test Group G — Socket.IO Real-Time Events](#9-test-group-g--socketio-real-time-events)
10. [Test Group H — Storage Persistence](#10-test-group-h--storage-persistence)
11. [Test Group I — Performance](#11-test-group-i--performance)
12. [Test Execution Order](#12-test-execution-order)
13. [Pass/Fail Criteria](#13-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | Camera, zone, event, alert, tracker config API | Node.js fetch | `test/api/main_system.test.js` |
| Integration | Socket.IO events, pipeline end-to-end | socket.io-client | `test/integration/main_pipeline.test.js` (Phase-2) |
| E2E | Full dashboard with live cameras | Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-MAIN-001 | TC-A-001 |
| FR-MAIN-002 | TC-A-002 |
| FR-MAIN-003 | TC-A-003 |
| FR-MAIN-004 | TC-B-001 |
| FR-MAIN-005 | TC-A-004 |
| FR-MAIN-010 | TC-B-002 |
| FR-MAIN-011 | TC-B-003 |
| FR-MAIN-012 | TC-B-004 |
| FR-MAIN-013 | TC-B-005 |
| FR-MAIN-014 | TC-B-006 |
| FR-MAIN-020 | TC-C-001 |
| FR-MAIN-021 | TC-C-002 |
| FR-MAIN-022 | TC-C-003 |
| FR-MAIN-023 | TC-C-004 |
| FR-MAIN-024 | TC-C-005 |
| FR-MAIN-025 | TC-C-006 |
| FR-MAIN-026 | TC-C-007 |
| FR-MAIN-030 | TC-D-001 |
| FR-MAIN-031 | TC-D-002 |
| FR-MAIN-032 | TC-D-003 |
| FR-MAIN-033 | TC-D-004 |
| FR-MAIN-034 | TC-D-005 |
| FR-MAIN-035 | TC-D-006 |
| FR-MAIN-036 | TC-D-007 |
| FR-MAIN-037 | TC-D-008 |
| FR-MAIN-038 | TC-D-009 |
| FR-MAIN-040 | TC-D-010 |
| FR-MAIN-041 | TC-D-011 |
| FR-MAIN-042 | TC-D-012 |
| FR-MAIN-043 | TC-D-013 |
| FR-MAIN-044 | TC-D-014 |
| FR-MAIN-045 | TC-H-001 |
| FR-MAIN-050 | TC-E-001 |
| FR-MAIN-051 | TC-E-002 |
| FR-MAIN-052 | TC-E-003 |
| FR-MAIN-053 | TC-E-004 |
| FR-MAIN-054 | TC-I-001 |
| FR-MAIN-070 | TC-F-001 |
| FR-MAIN-071 | TC-F-002 |
| FR-MAIN-072 | TC-F-003 |
| FR-MAIN-073 | TC-F-004 |
| FR-MAIN-074 | TC-F-005 |
| FR-MAIN-080 | TC-G-001 |
| FR-MAIN-081 | TC-G-002 |
| FR-MAIN-082 | TC-G-003 |
| FR-MAIN-083 | TC-G-004 |
| FR-MAIN-090 | TC-H-001 |
| FR-MAIN-091 | TC-H-002 |
| FR-MAIN-092 | TC-H-003 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| RTSP camera fixture (name, rtspUrl) | Camera registration |
| 4-point polygon zone fixture | Zone CRUD |
| Sample detection payload | Socket.IO tests |
| Alert fixture | Alert acknowledgment |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- `GET /health` returns `{ status: 'ok' }`
- `yolov8n.onnx` model present
- At least 1 RTSP camera available (for Phase-2 integration tests)

---

## 3. Test Group A — Video Ingestion & Multi-Camera

### TC-A-001 — RTSP Camera Persistence
- **Input:** Register RTSP camera; restart server
- **Expected:** Camera connection parameters restored from DB; camera reconnects automatically
- **Acceptance:** Camera reappears in `GET /api/cameras` after restart

### TC-A-002 — YouTube Stream Ingestion
- **Input:** Add YouTube virtual camera via `POST /api/youtube-streams`
- **Expected:** yt-dlp + FFmpeg pipeline starts; camera reaches `live` status
- **Acceptance:** `status: 'live'` within 30 seconds

### TC-A-003 — 16 Concurrent Camera Pipelines
- **Input:** Register 16 cameras (or mock 16 pipeline instances)
- **Expected:** All 16 pipelines operate independently; no cross-contamination
- **Acceptance:** `GET /api/cameras` shows 16 cameras; all independent

### TC-A-004 — Independent Start/Stop/Restart
- **Input:** `POST /api/cameras/:id/stop` on one camera; others still running
- **Expected:** Only target camera stops; others unaffected
- **Acceptance:** Target camera status = 'offline'; others still 'live'

---

## 4. Test Group B — AI Detection Pipeline

### TC-B-001 — 10 FPS Target
- **Input:** Camera pipeline running; check frame processing rate
- **Expected:** Frames processed at up to 10 FPS; excess frames dropped
- **Acceptance:** Measured rate ≤ 10 FPS; no backlog accumulation

### TC-B-002 — YOLOv8n Model Used
- **Input:** `GET /api/capabilities`
- **Expected:** Response includes model info indicating YOLOv8n ONNX (COCO 80 classes)
- **Acceptance:** Capabilities show COCO-80 detection

### TC-B-003 — Frame Preprocessing
- **Input:** Frame of size 1280×720
- **Expected:** Frame resized to 640×640 with letterbox; converted to float32 NCHW [0,1] tensor
- **Acceptance:** No preprocessing error; inference runs without shape mismatch

### TC-B-004 — Post-Processing
- **Input:** ONNX output with overlapping detections
- **Expected:** NMS applied with IoU 0.50; reverse letterbox coordinates applied
- **Acceptance:** Returned bbox coordinates in original frame space

### TC-B-005 — AI Submodule Toggle
- **Input:** Disable animal detection via `PUT /api/analytics/config { "cat": false }`
- **Expected:** Cat detection skipped in next frame; no inference for disabled class
- **Acceptance:** Cat class absent from next `detections` event

### TC-B-006 — ONNX Thread Config
- **Input:** Set `ONNX_THREADS_DEV=2` environment variable
- **Expected:** ONNX inference uses 2 threads
- **Acceptance:** Thread count reflected in ONNX session config

---

## 5. Test Group C — Tracking Layer

### TC-C-001 — ByteTrack Assignment
- **Input:** Sequential frames with same person
- **Expected:** Consistent `objectId` (UUID) assigned via IoU-based Hungarian algorithm
- **Acceptance:** Same person tracked with same `objectId` across 10+ frames

### TC-C-002 — Kalman Filter State
- **Input:** Track person across 5 frames
- **Expected:** 8-dimensional Kalman state `[x,y,w,h,vx,vy,vw,vh]` maintained per track
- **Acceptance:** Track prediction smooth; velocity components non-zero when moving

### TC-C-003 — objectId UUID Assignment
- **Input:** New person detected (no existing track)
- **Expected:** New UUID assigned as `objectId`; persists until track deleted
- **Acceptance:** `objectId` is valid UUID; stable across frames until maxAge

### TC-C-004 — 5-Cue Scoring
- **Input:** Person with face, color, clothing attributes in multi-track scene
- **Expected:** Track-detection assignment uses 5 cues: IoU, Face, Color, Cloth, Accessories
- **Acceptance:** Correct association when IoU alone would be ambiguous

### TC-C-005 — Adaptive Kalman Noise
- **Input:** Fast-moving person (high velocity) then stationary person
- **Expected:** Q scale: fast-moving ×4.0; stationary ×0.5; occluded ×3.0
- **Acceptance:** Kalman prediction confidence adapts to motion state

### TC-C-006 — maxAge Track Cleanup
- **Input:** Person leaves frame; wait `maxAge` (90) frames
- **Expected:** Track deleted after 90 missed frames
- **Acceptance:** `objectId` no longer in tracking output after maxAge

### TC-C-007 — Cross-Camera Face Re-ID
- **Input:** Same person appears on camera A then camera B (within re-ID window)
- **Expected:** `face:reidentified` Socket.IO event emitted; similarity ≥ 0.35
- **Acceptance:** Event received with matching face ID

---

## 6. Test Group D — Behavior & Zone Layer

### TC-D-001 — Dwell Time Calculation
- **Input:** Person enters zone; stays for 30 seconds
- **Expected:** `dwellTime` = 30.0 (±0.5s) in tracking output
- **Acceptance:** Dwell time accurate from zone entry point

### TC-D-002 — Sliding Window Displacement
- **Input:** Person moves 2 meters in 10-second window
- **Expected:** Displacement calculated over 10-second sliding window (not from entry point)
- **Acceptance:** Displacement reflects recent movement, not total path

### TC-D-003 — revisitCount Increment
- **Input:** Person exits zone; re-enters within `reentryWindow`
- **Expected:** `revisitCount` increments on re-entry
- **Acceptance:** Counter increases by 1 per re-entry within window

### TC-D-004 — Gallery-Based revisitCount Init
- **Input:** New objectId enters zone; matches 2-min gallery face/clothing
- **Expected:** `revisitCount` initialized from gallery match (not reset to 0)
- **Acceptance:** Revisit count reflects historical appearances

### TC-D-005 — pacingScore
- **Input:** Person reverses direction 5 times in 10 seconds
- **Expected:** `pacingScore = min(1, 5/10) = 0.5`
- **Acceptance:** pacingScore computed correctly

### TC-D-006 — circularScore
- **Input:** Person moves in a circle (max 300 frames)
- **Expected:** `circularScore` calculated from straight vs total path ratio
- **Acceptance:** circularScore between 0 and 1; circular path → higher score

### TC-D-007 — riskScore Calculation
- **Input:** Person with dwellTime=120, revisitCount=3, pacingScore=0.6
- **Expected:** `riskScore` = weighted sum of all 5 components
- **Acceptance:** riskScore between 0 and 1; increases with higher risk indicators

### TC-D-008 — isLoitering Threshold
- **Input:** Person dwell time reaches `zone.dwellThreshold` (e.g., 60s)
- **Expected:** `isLoitering = true` regardless of riskScore
- **Acceptance:** `isLoitering` flag set exactly at dwellThreshold

### TC-D-009 — Alert on minRiskScore
- **Input:** Zone with `minRiskScore: 0.4`; person with `isLoitering=true` and `riskScore=0.5`
- **Expected:** Alert triggered (both conditions met)
- **Acceptance:** Alert fired; only 1 condition alone insufficient

### TC-D-010 — MONITOR and EXCLUDE Zones
- **Input:** Person in MONITOR zone; person in EXCLUDE zone
- **Expected:** MONITOR → loitering analysis applied; EXCLUDE → detections suppressed
- **Acceptance:** No detections in EXCLUDE zone output; analysis in MONITOR zone

### TC-D-011 — Minimum 3 Vertices
- **Input:** `POST /api/cameras/:id/zones` with 2-vertex polygon
- **Expected:** HTTP 400 returned
- **Acceptance:** Zone not created; 400 response

### TC-D-012 — Zone Schedule
- **Input:** Zone with `startTime: "22:00"`, `endTime: "06:00"`, `days: ["Mon"]`
- **Expected:** Loitering analysis only active during Mon 22:00–06:00; inactive outside
- **Acceptance:** No alerts during off-schedule time

### TC-D-013 — targetClasses Filter
- **Input:** Zone with `targetClasses: ["person"]`; car detected in zone
- **Expected:** Car ignored for loitering analysis; only persons analyzed
- **Acceptance:** No car loitering events in output

### TC-D-014 — 50 Zone Support per Camera
- **Input:** Create 50 zones for one camera
- **Expected:** All 50 zones created successfully; all active
- **Acceptance:** `GET /api/cameras/:id/zones` returns 50 zones

### TC-D-015 — Per-Camera Pixel-to-Meter Calibration *(Planned — not yet implemented, Phase 12b-4)*
- **Input:** Camera with calibration configured (`pixelsPerMeter` or homography); zone `minDisplacement` set in meters (e.g. `0.2 m/s`, `3 m`, matching `Loitering_Detection_가이드.md` Rule 2 — guide absorbed into §6, source deleted)
- **Expected:** `behaviorEngine.js` velocity/displacement values convert to real-world units at the configuration boundary and in event payloads; uncalibrated cameras keep today's pixel-only behavior
- **Acceptance:** Not runnable today — no calibration feature exists in code. Tracked here so this TC is ready to activate once `Design_LTS2026_Loitering_Tracking_System.md` §6.2.1 is implemented.

---

## 7. Test Group E — Alert & Storage Layer

### TC-E-001 — loitering_alert Event Timing
- **Input:** Person reaches dwell threshold
- **Expected:** `loitering_alert` Socket.IO event received within 500 ms of threshold
- **Acceptance:** Event timestamp ≤ 500 ms after isLoitering transition

### TC-E-002 — Alert Dedup (Cooldown)
- **Input:** Same person/zone triggers multiple threshold crossings within cooldown window
- **Expected:** Only 1 alert emitted during cooldown window
- **Acceptance:** No duplicate alerts within configured cooldown period

### TC-E-003 — Alert Persistence
- **Input:** Alert generated; restart server
- **Expected:** Alert persists in `lts.json`; accessible via `GET /api/alerts`
- **Acceptance:** Alert present after restart with all fields intact

### TC-E-004 — Alert Acknowledgment
- **Input:** `POST /api/alerts/:id/acknowledge`
- **Expected:** HTTP 200; alert marked as acknowledged; filtered from unacknowledged list
- **Acceptance:** Alert `acknowledged: true`; not in active alert list

---

## 8. Test Group F — REST API

### TC-F-001 — Camera Management API
- **Input:** `GET`, `POST`, `PUT`, `DELETE` `/api/cameras`, and `/start`, `/stop`, `/reconnect`
- **Expected:** All 7 operations return correct HTTP codes and data
- **Acceptance:** CRUD operations succeed; pipeline operations change status correctly

### TC-F-002 — Zone Management API
- **Input:** `GET`, `POST`, `PUT`, `DELETE` `/api/cameras/:id/zones`
- **Expected:** All 4 CRUD operations work; 3-vertex minimum enforced
- **Acceptance:** Zone CRUD works; validation enforced

### TC-F-003 — Events & Alerts API
- **Input:** `GET /api/events` with time and camera filters; `POST /api/alerts/:id/acknowledge`
- **Expected:** Filtered events returned; acknowledgment persisted
- **Acceptance:** Filter parameters work; acknowledgment changes state

### TC-F-004 — Tracker Config API
- **Input:** `GET /api/tracker/config`, `PUT /api/tracker/config`, `POST /api/tracker/config/reset`
- **Expected:** Config read, updated, and reset correctly
- **Acceptance:** Updated config applied immediately; reset returns defaults

### TC-F-005 — System API
- **Input:** `GET /health`, `GET /api/capabilities`, `GET /api/crosscamera/stats`
- **Expected:** All 3 endpoints return HTTP 200 with expected schemas
- **Acceptance:** Correct response structure for each endpoint

---

## 9. Test Group G — Socket.IO Real-Time Events

### TC-G-001 — detections Event
- **Input:** Active camera pipeline processing frames
- **Expected:** `detections` Socket.IO event received per frame with detection array
- **Acceptance:** Events received at camera FPS; each contains `cameraId` and `detections[]`

### TC-G-002 — loitering_alert Event
- **Input:** Person meets isLoitering + riskScore conditions
- **Expected:** `loitering_alert` event received with full alert payload
- **Acceptance:** Event received; payload includes `cameraId`, `objectId`, `zoneName`, `dwellTime`, `riskScore`

### TC-G-003 — detections:summary Event
- **Input:** Frame processed by pipeline
- **Expected:** `detections:summary` event received with active and loitering counts
- **Acceptance:** Event has `active`, `loitering` count fields

### TC-G-004 — face:reidentified Event
- **Input:** Same face detected on different camera
- **Expected:** `face:reidentified` event received with cross-camera match info
- **Acceptance:** Event includes both camera IDs and matched face ID

---

## 10. Test Group H — Storage Persistence

### TC-H-001 — lts.json Persistence
- **Input:** Create camera, zone, event, alert; restart server
- **Expected:** All 4 data types restored from `storage/lts.json`
- **Acceptance:** All data accessible via API after restart

### TC-H-002 — Event Retention
- **Input:** Create 100 loitering events; query with `cameraId` filter
- **Expected:** Events persist indefinitely; filter returns correct subset
- **Acceptance:** All 100 events present; filter works correctly

### TC-H-003 — Tracker Config Persistence
- **Input:** Update `PUT /api/tracker/config`; restart server
- **Expected:** Tracker config persists in `storage/tracker.json`; applied immediately on load
- **Acceptance:** Config unchanged after restart; applied without server restart

---

## 11. Test Group I — Performance

### TC-I-001 — Alert Latency
- **Input:** Person crosses dwell threshold
- **Expected:** `loitering_alert` Socket.IO event received within 3 seconds of threshold
- **Acceptance:** End-to-end latency from threshold to UI alert ≤ 3 seconds

---

## 12. Test Execution Order

```
Group F (API) → Group A (ingestion) → Group B (AI) → Group C (tracking) → Group D (zones) → Group E (alerts) → Group G (Socket.IO) → Group H (persistence) → Group I (performance)
```

Clean up: delete all test cameras, zones, and events after each group.

---

## 13. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Ingestion | 16+ concurrent cameras; YouTube streams live within 30s |
| AI | 10 FPS cap; correct preprocessing; NMS applied |
| Tracking | Stable objectId; 8-dim Kalman; 5-cue scoring; maxAge cleanup |
| Zones | All 5 behavior metrics correct; zone CRUD; schedule; targetClasses |
| Alerts | ≤ 500 ms event latency; dedup; persistence |
| REST API | All 7 endpoint groups work with correct codes |
| Socket.IO | All 4 event types received correctly |
| Persistence | All data types survive server restart |
| Performance | Alert end-to-end ≤ 3 seconds |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for LTS2026 Loitering Tracking System |
| 1.1 | 2026-07-09 | Youngho Kim | TC-D-013 추가 (Planned, 미구현) — 카메라별 픽셀-미터 캘리브레이션, Phase 12b-4 활성화 시점에 실행 가능 — `docs/rfp/Loitering_Detection_가이드.md` 흡수 반영, 원본 삭제 |
