# TEST CASES (TC)
# AI Mask Detection (PPE)

| | |
|---|---|
| **Document ID** | TC-LTS-AI-MSK-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_AI_Mask_Detection.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D), test/api/analytics_config.test.js (Group C) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Model Sharing & Toggle Gate](#3-test-group-a--model-sharing--toggle-gate)
4. [Test Group B — Head ROI & PPE Matching](#4-test-group-b--head-roi--ppe-matching)
5. [Test Group C — mask Attribute Output](#5-test-group-c--mask-attribute-output)
6. [Test Group D — Zone maskPolicy Integration](#6-test-group-d--zone-maskpolicy-integration)
7. [Test Group E — Analytics Config & Persistence](#7-test-group-e--analytics-config--persistence)
8. [Test Group F — Error Handling & Performance](#8-test-group-f--error-handling--performance)
9. [Test Execution Order](#9-test-execution-order)
10. [Pass/Fail Criteria](#10-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| Unit | Head ROI, `_bestMatch()` for mask classes, small ROI guard | Node.js | `test/unit/mask_detection.test.js` (Phase-2) |
| API (REST) | `/api/analytics/config` mask toggle | Node.js fetch | `test/api/mask_detection.test.js` (Phase-2) |
| Integration | `detections` event `mask` field | socket.io-client | `test/integration/mask_detection.test.js` (Phase-2) |
| E2E | Live stream with masked/unmasked person | Manual / Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-MSK-001 | TC-A-001 |
| FR-MSK-002 | TC-A-002 |
| FR-MSK-003 | TC-A-003 |
| FR-MSK-004 | TC-A-004 |
| FR-MSK-005 | TC-B-001 |
| FR-MSK-006 | TC-B-002 |
| FR-MSK-007 | TC-B-003 |
| FR-MSK-008 | TC-B-004 |
| FR-MSK-009 | TC-B-005 |
| FR-MSK-010 | TC-B-006 |
| FR-MSK-011 | TC-C-001 |
| FR-MSK-012 | TC-C-002 |
| FR-MSK-013 | TC-C-003 |
| FR-MSK-014 | TC-D-001 |
| FR-MSK-015 | TC-D-002 |
| FR-MSK-016 | TC-D-003 |
| FR-MSK-017 | TC-D-004 |
| FR-MSK-018 | TC-D-005 |
| FR-MSK-019 | TC-E-001 |
| FR-MSK-020 | TC-E-002 |
| FR-MSK-021 | TC-C-004 |
| FR-MSK-023 | TC-A-005 |
| FR-MSK-024 | TC-F-001 |
| FR-MSK-025 | TC-F-002 |
| FR-MSK-030 | TC-F-003 |
| FR-MSK-031 | TC-F-004 |
| FR-MSK-032 | TC-F-005 |
| FR-MSK-033 | TC-F-006 |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- `yolov8n.onnx` and `yolov8m_ppe.onnx` present
- `analyticsConfig.mask` enabled before Group B/C/D tests

---

## 3. Test Group A — Model Sharing & Toggle Gate

### TC-A-001 — PPE Model for Mask
- **Input:** Server startup; `GET /api/capabilities`
- **Expected:** `ai.mask: true`; `status.mask: 'loaded'`; uses shared `yolov8m_ppe.onnx`
- **Acceptance:** No additional ONNX session beyond shared PPE model

### TC-A-002 — ProtectiveEquipService Load State
- **Input:** Check `ProtectiveEquipService.loaded` after startup
- **Expected:** `loaded: true`; inference session active
- **Acceptance:** No errors during load

### TC-A-003 — Toggle Gate
- **Input:** `PUT /api/analytics/config { "mask": false }` then process frame
- **Expected:** No `mask` classification performed; `mask` field absent from output
- **Acceptance:** No PPE inference for mask when disabled

### TC-A-004 — Shared Inference with Hat
- **Input:** Both `hat` and `mask` enabled; process frame
- **Expected:** Single PPE inference call handles both modules
- **Acceptance:** No duplicate inference; single call to `ProtectiveEquipService.detect()`

### TC-A-005 — PPE Model Missing
- **Precondition:** Remove `yolov8m_ppe.onnx`
- **Input:** `GET /api/capabilities`
- **Expected:** `ai.mask: false`; graceful disable
- **Acceptance:** No crash

---

## 4. Test Group B — Head ROI & PPE Matching

### TC-B-001 — Input Preprocessing
- **Input:** JPEG frame; mask detection active
- **Expected:** 640×640 letterbox, CHW Float32, [0,1] normalized
- **Acceptance:** Tensor shape `[1,3,640,640]` valid

### TC-B-002 — Low Confidence Discard
- **Input:** PPE detection with confidence < 0.30
- **Expected:** Discarded before `_bestMatch()`; `mask` returns `uncertain`
- **Acceptance:** Sub-threshold detections excluded

### TC-B-003 — Head ROI Formula (Mask)
- **Input:** Person bbox `[x, y, w, h]`
- **Expected:** Mask Head ROI = upper 35% of bbox height
- **Acceptance:** ROI coordinates match formula; clamped to frame bounds

### TC-B-004 — Head ROI Clamping
- **Input:** Person at frame edge; Head ROI partially outside frame
- **Expected:** Coordinates clamped to `[0, frameWidth]` and `[0, frameHeight]`
- **Acceptance:** No negative or out-of-bounds coordinates

### TC-B-005 — bestMatch() for Mask Classes
- **Input:** PPE detections; one is class 1 (mask_correct) or class 3 (no_mask)
- **Expected:** `_bestMatch()` considers only PPE class 1 and 3 for mask module
- **Acceptance:** Only mask-relevant PPE classes used

### TC-B-006 — Small Head ROI → uncertain
- **Input:** Head ROI area < 30×30 px
- **Expected:** `mask` returns `{ status: 'uncertain' }`; classification skipped
- **Acceptance:** No crash; `uncertain` returned

---

## 5. Test Group C — mask Attribute Output

### TC-C-001 — mask Field Always Present
- **Input:** Frame with person; mask module active
- **Expected:** Every person detection has `mask` field
- **Acceptance:** `mask` present for all persons

### TC-C-002 — mask Schema
- **Input:** Person with mask detected
- **Expected:** `mask` object contains: `status: 'mask_correct' | 'no_mask' | 'uncertain'`, `confidence`
- **Acceptance:** Both fields present; `status` is one of the 3 valid values

### TC-C-003 — MASK OK / NO MASK / MASK? Badge Labels
- **Input:** Dashboard; person with `mask.status` value
- **Expected:** `mask_correct` → "MASK OK"; `no_mask` → "NO MASK"; `uncertain` → "MASK?"
- **Acceptance:** Correct label for each status value

### TC-C-004 — mask in detections Socket.IO Event
- **Input:** Camera pipeline; mask enabled
- **Expected:** `detections` event includes person with `mask` attribute
- **Acceptance:** `mask` field present in Socket.IO payload

---

## 6. Test Group D — Zone maskPolicy Integration

### TC-D-001 — targetClasses "mask" Activation
- **Input:** Zone with `targetClasses: ["mask"]`
- **Expected:** Mask compliance check activated for persons in this zone
- **Acceptance:** Zone config saved; mask compliance logic runs for this zone

### TC-D-002 — maskPolicy Field in Zone
- **Input:** `PUT /api/cameras/:id/zones/:zoneId` with `maskPolicy: "mandatory"`
- **Expected:** Zone record contains `maskPolicy: "mandatory"`
- **Acceptance:** `GET /api/cameras/:id/zones` returns zone with `maskPolicy`

### TC-D-003 — mask_violation Event on mandatory Zone
- **Input:** Zone with `maskPolicy: "mandatory"`; person with `mask.status: "no_mask"` enters
- **Expected:** `mask_violation` event emitted
- **Acceptance:** Event received via Socket.IO

### TC-D-004 — uncertain Does Not Trigger Violation
- **Input:** Zone with `maskPolicy: "mandatory"`; person with `mask.status: "uncertain"`
- **Expected:** No `mask_violation` event
- **Acceptance:** No violation event emitted for uncertain status

### TC-D-005 — recommended maskPolicy No uncertain Violation
- **Input:** Zone with `maskPolicy: "recommended"`; person with `mask.status: "uncertain"`
- **Expected:** No violation alert emitted
- **Acceptance:** No violation for uncertain in recommended mode

---

## 7. Test Group E — Analytics Config & Persistence

### TC-E-001 — Config Persisted
- **Input:** `PUT /api/analytics/config { "mask": false }`; restart server
- **Expected:** Mask detection disabled after restart
- **Acceptance:** `GET /api/analytics/config` returns `{ "mask": false }`

### TC-E-002 — capabilities reflects mask state
- **Input:** Disable mask; check capabilities
- **Expected:** `ai.mask: false` in capabilities
- **Acceptance:** Correct real-time reflection

---

## 8. Test Group F — Error Handling & Performance

### TC-F-001 — PPE Inference Error → uncertain
- **Input:** Simulate PPE inference exception
- **Expected:** `mask = { status: 'uncertain' }` returned; no crash
- **Acceptance:** Service continues

### TC-F-002 — Invalid JPEG
- **Input:** Non-JPEG bytes
- **Expected:** `sharp` exception caught; empty array returned
- **Acceptance:** No unhandled rejection

### TC-F-003 — Single Person Latency
- **Expected:** ≤ 7 ms per person for mask detection
- **Acceptance:** Measured ≤ 7 ms

### TC-F-004 — 10 Person Batch
- **Expected:** ≤ 30 ms for 10 persons
- **Acceptance:** Measured ≤ 30 ms

### TC-F-005 — Mask Accuracy (Offline)
- **Expected:** `no_mask` precision ≥ 96%; recall ≥ 94%; overall 3-class accuracy ≥ 95%
- **Acceptance:** Benchmark meets thresholds (Phase-2 offline eval)

### TC-F-006 — 50-Track Capacity
- **Input:** 50 person tracks with mask enabled
- **Expected:** All 50 persons processed; no errors
- **Acceptance:** 50 `mask` fields in output

---

## 9. Test Execution Order

```
Group A (model) → Group B (ROI/matching) → Group C (output) → Group D (zone policy) → Group E (config) → Group F (perf)
```

---

## 10. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Model sharing | Single PPE session for hat+mask; capabilities accurate |
| Head ROI | Correct formula; clamped; uncertain on small ROI |
| mask field | Always present; correct 3-class status; correct badge labels |
| Zone policy | maskPolicy saved; violations triggered correctly |
| Config | Persisted; immediate disable effect |
| Performance | ≤ 7 ms/person; ≤ 30 ms/10 persons |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Mask Detection |
