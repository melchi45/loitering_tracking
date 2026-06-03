# TEST CASES (TC)
# AI Animal Detection

| | |
|---|---|
| **Document ID** | TC-LTS-AI-ANI-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_AI_Animal_Detection.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D), test/api/analytics_config.test.js (Group C) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Model Sharing & Class Enablement](#3-test-group-a--model-sharing--class-enablement)
4. [Test Group B — Detection Output & Coordinate Transform](#4-test-group-b--detection-output--coordinate-transform)
5. [Test Group C — Analytics Config Toggle](#5-test-group-c--analytics-config-toggle)
6. [Test Group D — Tracking & Zone Integration](#6-test-group-d--tracking--zone-integration)
7. [Test Group E — UI Rendering](#7-test-group-e--ui-rendering)
8. [Test Group F — Error Handling & Performance](#8-test-group-f--error-handling--performance)
9. [Test Execution Order](#9-test-execution-order)
10. [Pass/Fail Criteria](#10-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| Unit | ENABLED_CLASSES mapping, detection output schema | Node.js, direct import | `test/unit/animal_detection.test.js` (Phase-2) |
| API (REST) | `/api/analytics/config` toggle | Node.js built-in fetch | `test/api/animal_detection.test.js` (Phase-2) |
| Integration | Socket.IO `detections` event with animal objects | socket.io-client | `test/integration/animal_detection.test.js` (Phase-2) |
| E2E | Live camera feed with animal detection | Manual / Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-ANI-001 | TC-A-001 |
| FR-ANI-002 | TC-A-002 |
| FR-ANI-003 | TC-A-003 |
| FR-ANI-004 | TC-A-004 |
| FR-ANI-005 | TC-A-005 |
| FR-ANI-006 | TC-C-001 |
| FR-ANI-007 | TC-C-002 |
| FR-ANI-008 | TC-C-003 |
| FR-ANI-009 | TC-C-004 |
| FR-ANI-010 | TC-B-001 |
| FR-ANI-011 | TC-B-002 |
| FR-ANI-012 | TC-B-003 |
| FR-ANI-013 | TC-D-001 |
| FR-ANI-014 | TC-D-002 |
| FR-ANI-015 | TC-D-003 |
| FR-ANI-016 | TC-E-001 |
| FR-ANI-017 | TC-E-002 |
| FR-ANI-018 | TC-E-003 |
| FR-ANI-019 | TC-E-004 |
| FR-ANI-020 | TC-E-005 |
| FR-ANI-021 | TC-A-006 |
| FR-ANI-022 | TC-F-001 |
| FR-ANI-023 | TC-C-005 |
| FR-ANI-030 | TC-F-002 |
| FR-ANI-031 | TC-F-003 |
| FR-ANI-032 | TC-F-004 |
| FR-ANI-033 | TC-F-005 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `yolov8n.onnx` | Shared detection model (must be present) |
| Sample JPEG with cat | Animal detection positive case |
| Sample JPEG with no animal | Negative detection case |
| `analyticsConfig` fixture | Toggle state for enabling/disabling species |

---

## 2. Test Environment and Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `GET /health` returns `{ status: 'ok' }`
- `yolov8n.onnx` model file present in model directory
- At least one camera registered and running (for integration tests)

### 2.2 Clean State

- `GET /api/analytics/config` restored to defaults before and after Group C tests
- No active loitering alerts from previous test runs

### 2.3 Dependencies

```
node >= 18
yolov8n.onnx model file
```

---

## 3. Test Group A — Model Sharing & Class Enablement

### TC-A-001 — Shared Model Verification
- **Precondition:** Server running with `yolov8n.onnx`
- **Input:** `GET /api/capabilities`
- **Expected:** Response includes `ai.animal: true`; no separate model file loaded
- **Acceptance:** HTTP 200; `ai.animal === true`

### TC-A-002 — Shared Inference Session
- **Precondition:** Human detection enabled
- **Input:** Enable animal detection; send one frame
- **Expected:** Single ONNX inference call handles both human and animal detection
- **Acceptance:** No duplicate model load; server memory stable

### TC-A-003 — COCO Animal Class IDs
- **Input:** `GET /api/capabilities`
- **Expected:** Animal classes include COCO IDs 14–23 (bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe)
- **Acceptance:** All 10 animal class IDs present in capabilities response

### TC-A-004 — Default Confidence Threshold
- **Input:** Perform inference with animal detection enabled
- **Expected:** Detections with confidence < 0.25 are not returned
- **Acceptance:** All returned detections have `confidence >= 0.25`

### TC-A-005 — NMS IoU Threshold
- **Input:** Feed frame with overlapping animal bounding boxes (confidence > 0.25)
- **Expected:** NMS with IoU threshold 0.5 applied; overlapping boxes suppressed
- **Acceptance:** Only the highest-confidence box remains for overlapping detections

### TC-A-006 — Model File Missing
- **Precondition:** Rename/remove `yolov8n.onnx`
- **Input:** `GET /api/capabilities`
- **Expected:** `ai.animal: false` returned; animal detection disabled gracefully
- **Acceptance:** No server crash; capabilities reflect disabled state

---

## 4. Test Group B — Detection Output & Coordinate Transform

### TC-B-001 — Detection Output Schema
- **Input:** Frame containing a detectable animal (e.g., cat)
- **Expected:** Detection object contains: `bbox`, `confidence`, `classId`, `className`
- **Acceptance:** All 4 fields present; `className` is one of the 10 animal species

### TC-B-002 — Coordinate Inverse Transform
- **Input:** Frame of size 1280×720 containing an animal
- **Expected:** Returned `bbox` coordinates are in original frame pixel space (not letterboxed 640×640)
- **Acceptance:** All bbox values within `[0, 1280]` (x) and `[0, 720]` (y); no negative values

### TC-B-003 — detect() Return Structure
- **Input:** Frame with 2 animal detections
- **Expected:** `detect()` returns `{ detections: [...], frameWidth: W, frameHeight: H }`
- **Acceptance:** `detections` is an array; `frameWidth` and `frameHeight` match input frame dimensions

---

## 5. Test Group C — Analytics Config Toggle

### TC-C-001 — Species Independent Toggle
- **Input:** `PUT /api/analytics/config` with `{ "cat": true, "dog": false }`
- **Expected:** Cat detections enabled; dog detections suppressed in subsequent frames
- **Acceptance:** Only cat detections appear in output; dog class absent

### TC-C-002 — Default All Species Disabled
- **Input:** `GET /api/analytics/config` on fresh server start
- **Expected:** All 10 animal species have `false` as default value
- **Acceptance:** All animal class keys return `false`

### TC-C-003 — Config Persistence
- **Input:** `PUT /api/analytics/config` with `{ "bird": true }`; restart server
- **Expected:** Bird detection remains enabled after restart
- **Acceptance:** `GET /api/analytics/config` after restart returns `{ "bird": true }`

### TC-C-004 — Immediate Suppression After Disable
- **Input:** Disable cat detection while camera is running; send next frame
- **Expected:** Cat detections absent from the very next frame's results
- **Acceptance:** No cat detection in the immediate next `detections` event

### TC-C-005 — Unknown Species Key Ignored
- **Input:** `PUT /api/analytics/config` with `{ "dragon": true }`
- **Expected:** Request succeeds (HTTP 200); unknown key silently ignored; no 400 error
- **Acceptance:** HTTP 200; existing config unchanged

---

## 6. Test Group D — Tracking & Zone Integration

### TC-D-001 — Object ID Assignment
- **Input:** Animal detected across 3 consecutive frames
- **Expected:** Same `objectId` assigned across all 3 frames; `dwellTime` accumulates
- **Acceptance:** Consistent `objectId`; `dwellTime` increases monotonically

### TC-D-002 — targetClasses Zone Filter
- **Input:** Zone with `targetClasses: ["cat"]`; frame has both cat and dog
- **Expected:** Only cat is analyzed for loitering in this zone; dog ignored
- **Acceptance:** Loitering analysis triggered only for cat-class detections

### TC-D-003 — Loitering Alert for Animal
- **Input:** Cat remains in MONITOR zone for duration ≥ `zone.dwellThreshold`
- **Expected:** `loitering:alert` Socket.IO event emitted with animal object details
- **Acceptance:** Event received within 3 seconds of threshold exceeded

---

## 7. Test Group E — UI Rendering

### TC-E-001 — detections Event Enriched Fields
- **Input:** Enable animal detection; run camera pipeline
- **Expected:** `detections` Socket.IO event payload includes animal detections with `classId`, `className`, `objectId`
- **Acceptance:** Animal detections present in event payload

### TC-E-002 — Species Color Coding
- **Input:** Browser dashboard with animal detections active
- **Expected:** Each animal species has distinct Tailwind color applied to DetectionRow badge
- **Acceptance:** At least 3 different colors used across different species

### TC-E-003 — Loitering Red Badge
- **Input:** Animal with `isLoitering: true`
- **Expected:** Red loitering badge and red background in DetectionRow
- **Acceptance:** `bg-red-` class applied to loitering animal row

### TC-E-004 — "Animals" Filter Group in Detection Panel
- **Input:** Detection panel sidebar with mixed detections
- **Expected:** "Animals" category group present in category filter dropdown
- **Acceptance:** "Animals" group visible; selecting it filters to animal detections only

### TC-E-005 — VideoAnalyticsTab Animal Checkboxes
- **Input:** Open VideoAnalyticsTab
- **Expected:** "Animals" group with 10 checkboxes (one per species) visible
- **Acceptance:** All 10 species checkboxes present and functional

---

## 8. Test Group F — Error Handling & Performance

### TC-F-001 — ONNX Inference Error Recovery
- **Input:** Simulate ONNX inference error (corrupt input)
- **Expected:** `detect()` returns empty array; no server crash
- **Acceptance:** Empty array returned; subsequent calls succeed

### TC-F-002 — Detection Latency
- **Precondition:** Animal detection enabled, single camera running at 10 FPS
- **Expected:** Animal detection adds ≤ 15 ms per frame (shared inference pass)
- **Acceptance:** No additional latency vs. human-only detection (shared model)

### TC-F-003 — No Extra ONNX Session
- **Input:** Enable animal + human detection simultaneously
- **Expected:** Only one ONNX InferenceSession for COCO model
- **Acceptance:** Server process memory not increased by additional ONNX session

### TC-F-004 — mAP Accuracy Baseline
- **Input:** COCO val2017 animal subset (Phase-2, offline evaluation)
- **Expected:** Average mAP@0.5 across 10 animal classes ≥ 45%
- **Acceptance:** Benchmark result ≥ 45% mAP@0.5

### TC-F-005 — Multi-Camera Concurrent Detection
- **Input:** 4 cameras simultaneously with animal detection enabled
- **Expected:** Each camera's ByteTracker operates independently; no cross-contamination of `objectId`
- **Acceptance:** ObjectIDs unique per camera; no shared state between camera pipelines

---

## 9. Test Execution Order

```
Group A (model) → Group B (output) → Group C (config) → Group D (tracking) → Group E (UI) → Group F (performance)
```

Group C tests that modify config must restore defaults after completion.

---

## 10. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Model sharing | No additional ONNX session; capabilities reflect state |
| Detection schema | All required fields present and correctly typed |
| Config toggle | Immediate effect; persisted after restart |
| Tracking | Stable objectId across frames; correct zone filtering |
| UI | Correct badges, colors, and filter groups |
| Performance | ≤ 15 ms overhead; no crashes on errors |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Animal Detection |
