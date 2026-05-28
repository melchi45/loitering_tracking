# TEST CASES (TC)
# AI Hat / Helmet Detection (PPE)

| | |
|---|---|
| **Document ID** | TC-LTS-AI-HAT-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_AI_Hat_Detection.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D), test/api/analytics_config.test.js (Group C) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Model Loading & Toggle Gate](#3-test-group-a--model-loading--toggle-gate)
4. [Test Group B — Head ROI & PPE Matching](#4-test-group-b--head-roi--ppe-matching)
5. [Test Group C — hat Attribute Output](#5-test-group-c--hat-attribute-output)
6. [Test Group D — Analytics Config & Persistence](#6-test-group-d--analytics-config--persistence)
7. [Test Group E — UI Rendering](#7-test-group-e--ui-rendering)
8. [Test Group F — Error Handling & Performance](#8-test-group-f--error-handling--performance)
9. [Test Execution Order](#9-test-execution-order)
10. [Pass/Fail Criteria](#10-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| Unit | Head ROI calculation, `_bestMatch()`, confidence filter | Node.js, direct import | `test/unit/hat_detection.test.js` (Phase-2) |
| API (REST) | `/api/analytics/config` hat toggle | Node.js fetch | `test/api/hat_detection.test.js` (Phase-2) |
| Integration | `detections` Socket.IO event `hat` field | socket.io-client | `test/integration/hat_detection.test.js` (Phase-2) |
| E2E | Live stream with hardhat/no-hat person | Manual / Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-HAT-001 | TC-A-001 |
| FR-HAT-002 | TC-A-002 |
| FR-HAT-003 | TC-A-003 |
| FR-HAT-004 | TC-A-004 |
| FR-HAT-005 | TC-B-001 |
| FR-HAT-006 | TC-B-002 |
| FR-HAT-007 | TC-B-003 |
| FR-HAT-008 | TC-B-004 |
| FR-HAT-009 | TC-C-001 |
| FR-HAT-010 | TC-C-002 |
| FR-HAT-011 | TC-E-001 |
| FR-HAT-012 | TC-B-005 |
| FR-HAT-013 | TC-D-001 |
| FR-HAT-014 | TC-D-002 |
| FR-HAT-015 | TC-D-003 |
| FR-HAT-016 | TC-C-003 |
| FR-HAT-017 | TC-A-005 |
| FR-HAT-018 | TC-F-001 |
| FR-HAT-019 | TC-F-002 |
| FR-HAT-030 | TC-F-003 |
| FR-HAT-031 | TC-F-004 |
| FR-HAT-032 | TC-F-005 |
| FR-HAT-033 | TC-F-006 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `yolov8m_ppe.onnx` | PPE detection model (10 classes) |
| JPEG with person + hardhat | Positive helmet detection |
| JPEG with person + no hat | Negative hat detection |
| JPEG with person, small head ROI (< 30×30 px) | Uncertain case |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3001`
- `yolov8n.onnx` and `yolov8m_ppe.onnx` model files present
- `analyticsConfig.hat` enabled before Group B/C tests

---

## 3. Test Group A — Model Loading & Toggle Gate

### TC-A-001 — PPE Model Load
- **Input:** Server startup with `yolov8m_ppe.onnx` present
- **Expected:** `GET /api/capabilities` returns `ai.hat: true`; `status.hat: 'loaded'`
- **Acceptance:** Both fields correct

### TC-A-002 — ProtectiveEquipService Load State
- **Input:** Check service state after load
- **Expected:** `ProtectiveEquipService` has `loaded: true`; inference session available
- **Acceptance:** Service ready without error

### TC-A-003 — Toggle Gate Check
- **Input:** Disable hat detection via `PUT /api/analytics/config { "hat": false }`
- **Expected:** Hat detection skipped for all subsequent frames; no PPE inference called for hat
- **Acceptance:** No `hat` field in detection output when disabled

### TC-A-004 — Shared Inference with Mask
- **Input:** Enable both `hat` and `mask`; process frame
- **Expected:** Single PPE inference call covers both; no duplicate inference
- **Acceptance:** One `ProtectiveEquipService.detect()` call per frame

### TC-A-005 — PPE Model File Missing
- **Precondition:** `yolov8m_ppe.onnx` absent
- **Input:** `GET /api/capabilities`
- **Expected:** `ai.hat: false`; hat detection gracefully disabled
- **Acceptance:** No server crash

---

## 4. Test Group B — Head ROI & PPE Matching

### TC-B-001 — Input Preprocessing
- **Input:** JPEG frame, hat detection active
- **Expected:** Frame preprocessed to 640×640 letterbox, CHW Float32, [0,1] normalized
- **Acceptance:** No preprocessing error; valid tensor shape `[1,3,640,640]`

### TC-B-002 — Head ROI Calculation
- **Input:** Person bbox `[x, y, w, h]`
- **Expected:** Head ROI = upper 35% of bbox (`height * 0.35`)
- **Acceptance:** ROI coordinates match formula; clamped to frame bounds

### TC-B-003 — Head ROI Zero Area → uncertain
- **Input:** Person bbox resulting in zero-area Head ROI after clamping
- **Expected:** `hat` field returns `{ className: 'uncertain' }`
- **Acceptance:** No crash; `uncertain` returned

### TC-B-004 — bestMatch() IoU Threshold
- **Input:** PPE detections near head ROI; one with IoU ≥ 0.1, one with IoU < 0.1
- **Expected:** Only the detection with IoU ≥ 0.1 is selected by `_bestMatch()`
- **Acceptance:** Correct match selected

### TC-B-005 — Low Confidence Filter
- **Input:** PPE detection with confidence < 0.30 near head ROI
- **Expected:** Detection discarded before `_bestMatch()`; `hat` returns `uncertain`
- **Acceptance:** Sub-threshold detections not used for hat classification

---

## 5. Test Group C — hat Attribute Output

### TC-C-001 — hat Field Always Present
- **Input:** Frame with person; hat module active
- **Expected:** Every person detection has `hat` field in output
- **Acceptance:** `hat` field present for all person detections

### TC-C-002 — hat Schema
- **Input:** Person with detected hardhat
- **Expected:** `hat` object contains: `className`, `confidence`, `isHelmet`, `safetyCompliant`
- **Acceptance:** All 4 fields present and correctly typed

### TC-C-003 — hat in detections Socket.IO Event
- **Input:** Camera pipeline running with hat enabled; person in frame
- **Expected:** `detections` event payload includes person objects with `hat` attribute
- **Acceptance:** `hat` field present in Socket.IO event payload

---

## 6. Test Group D — Analytics Config & Persistence

### TC-D-001 — Config Change Persisted
- **Input:** `PUT /api/analytics/config { "hat": false }`; server restart
- **Expected:** Hat detection remains disabled after restart
- **Acceptance:** `GET /api/analytics/config` returns `{ "hat": false }`

### TC-D-002 — capabilities reflects hat state
- **Input:** Toggle hat off; check capabilities
- **Expected:** `GET /api/capabilities` returns `ai.hat: false` when disabled
- **Acceptance:** Capabilities updated in real time

### TC-D-003 — Zone safetyPolicy Storage
- **Input:** `PUT /api/cameras/:id/zones/:zoneId` with `safetyPolicy: { requireHelmet: true }`
- **Expected:** Zone record saved with `safetyPolicy` block
- **Acceptance:** `GET /api/cameras/:id/zones` returns zone with `safetyPolicy` intact

---

## 7. Test Group E — UI Rendering

### TC-E-001 — HELMET / NO HELMET / HAT? Badges
- **Input:** Dashboard with person detections; hat enabled
- **Expected:** Each person shows one of: HELMET (isHelmet=true), NO HELMET (isHelmet=false), HAT? (uncertain)
- **Acceptance:** Badge matches hat classification; correct color applied

---

## 8. Test Group F — Error Handling & Performance

### TC-F-001 — PPE Inference Error Recovery
- **Input:** Corrupt JPEG input to PPE inference
- **Expected:** `hat = { className: 'uncertain' }` returned; no server crash
- **Acceptance:** Service continues processing subsequent frames

### TC-F-002 — Invalid JPEG Handling
- **Input:** Non-image bytes as frame input
- **Expected:** `sharp` exception caught; empty array returned
- **Acceptance:** No unhandled rejection

### TC-F-003 — Single Person Latency
- **Input:** Single person frame with hat enabled
- **Expected:** Hat detection adds ≤ 5 ms per person
- **Acceptance:** Latency measured ≤ 5 ms

### TC-F-004 — 10 Person Batch Latency
- **Input:** Frame with 10 persons, hat enabled
- **Expected:** Total hat detection ≤ 8 ms for batch
- **Acceptance:** Batch measured ≤ 8 ms

### TC-F-005 — PPE Model Memory
- **Input:** hat + mask both enabled
- **Expected:** PPE model shared; additional memory ≤ 200 MB vs baseline
- **Acceptance:** Server RSS increase ≤ 200 MB

### TC-F-006 — Multi-Track Capacity
- **Input:** Frame with 50 person tracks, hat enabled
- **Expected:** All 50 persons processed without error
- **Acceptance:** All 50 persons have `hat` field in output

---

## 9. Test Execution Order

```
Group A (model) → Group B (ROI/matching) → Group C (output) → Group D (config) → Group E (UI) → Group F (performance)
```

---

## 10. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Model loading | Capabilities reflect load state; graceful disable when absent |
| Head ROI | Correct formula applied; clamped; uncertain on zero area |
| hat field | Always present when module active; correct schema |
| Config | Persisted; immediate effect |
| Performance | ≤ 5 ms/person; ≤ 8 ms/10 persons; ≤ 200 MB extra RAM |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Hat Detection |
