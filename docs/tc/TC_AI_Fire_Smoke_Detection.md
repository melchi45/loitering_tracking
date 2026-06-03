# TEST CASES (TC)
# AI Module — Fire & Smoke Detection

| | |
|---|---|
| **Document ID** | TC-LTS-AI-06 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Fire_Smoke_Detection.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D, F) |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Capabilities & Status API](#3-test-group-a--capabilities--status-api)
4. [Test Group B — Service Status State Machine](#4-test-group-b--service-status-state-machine)
5. [Test Group C — Detection Output Schema](#5-test-group-c--detection-output-schema)
6. [Test Group D — Graceful Degradation](#6-test-group-d--graceful-degradation)
7. [Test Group E — Error Handling & Edge Cases](#7-test-group-e--error-handling--edge-cases)
8. [Test Execution Order](#8-test-execution-order)
9. [Pass/Fail Criteria](#9-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API | Capabilities + status REST endpoints | Node.js + built-in fetch | `test/api/` |
| Integration | Socket.IO `detections` event fire/smoke fields | Node.js + socket.io-client | `test/integration/` (Phase-3) |
| E2E | Live frame with fire/smoke visible | Manual | Phase-3 |

### 1.2 SRS Traceability

Every test case references one or more FR-FSD-NNN requirement IDs from SRS_AI_Fire_Smoke_Detection.md.

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `GET /api/capabilities` | fireSmokeDetection flag + fireSmokeStatus |
| `GET /health` | Server still operational when model missing |

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `GET /health` returns `{ status: 'ok' }`
- Fire/smoke model may or may not be present — tests cover both states

### 2.2 Phase Awareness

Tests are written to pass in both scenarios:
- **Model present:** `fireSmokeDetection: true`, `fireSmokeStatus: 'loaded'`
- **Model absent:** `fireSmokeDetection: false`, `fireSmokeStatus: 'missing'`

Tests labeled `[MODEL REQUIRED]` or `[MODEL ABSENT]` indicate which state is needed.

### 2.3 Dependencies

```
node >= 18
No external test framework — built-in fetch only
```

---

## 3. Test Group A — Capabilities & Status API

**Script:** `test/api/fire_smoke_detection.test.js`

### TC-A-001 — Server Health Check
- **SRS:** (prerequisite)
- **Steps:**
  1. `GET /health`
  2. Assert HTTP 200
  3. Assert `body.status === 'ok'`

### TC-A-002 — Capabilities Endpoint Accessible
- **SRS:** FR-FSD-018
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200
  3. Assert response is JSON

### TC-A-003 — Capabilities Contains fireSmokeDetection Field
- **SRS:** FR-FSD-018
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai` is an object
  3. Assert `'fireSmokeDetection' in body.ai`
  4. Assert `typeof body.ai.fireSmokeDetection === 'boolean'`

### TC-A-004 — Capabilities Contains fireSmokeStatus Field
- **SRS:** FR-FSD-018, FR-FSD-005
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.fireSmokeStatus` is a string
  3. Assert value is one of: `'not_started'`, `'missing'`, `'loaded'`, `'failed'`

### TC-A-005 — fireSmokeDetection True When Model Loaded [MODEL REQUIRED]
- **SRS:** FR-FSD-003, FR-FSD-018
- **Condition:** `server/models/yolov8s_fire_smoke.onnx` is present
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.fireSmokeDetection === true`
  3. Assert `body.ai.fireSmokeStatus === 'loaded'`

### TC-A-006 — fireSmokeDetection False When Model Missing [MODEL ABSENT]
- **SRS:** FR-FSD-002, FR-FSD-018
- **Condition:** `server/models/yolov8s_fire_smoke.onnx` NOT present
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.fireSmokeDetection === false`
  3. Assert `body.ai.fireSmokeStatus === 'missing'`

### TC-A-007 — Capabilities fireSmokeDetection and fireSmokeStatus Are Consistent
- **SRS:** FR-FSD-018
- **Steps:**
  1. `GET /api/capabilities`
  2. If `fireSmokeDetection === true`: Assert `fireSmokeStatus === 'loaded'`
  3. If `fireSmokeDetection === false`: Assert `fireSmokeStatus` ∈ `['missing', 'failed', 'not_started']`

---

## 4. Test Group B — Service Status State Machine

### TC-B-001 — Status Not 'not_started' After Server Ready
- **SRS:** FR-FSD-005
- **Steps:**
  1. Wait for server to be ready (health check passes)
  2. `GET /api/capabilities`
  3. Assert `body.ai.fireSmokeStatus !== 'not_started'`
  4. (Server startup must have triggered `load()`)

### TC-B-002 — Status 'missing' When Model File Absent [MODEL ABSENT]
- **SRS:** FR-FSD-002
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.fireSmokeStatus === 'missing'`

### TC-B-003 — Status 'loaded' When Model File Present [MODEL REQUIRED]
- **SRS:** FR-FSD-003
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.fireSmokeStatus === 'loaded'`

### TC-B-004 — ready Property Matches fireSmokeDetection
- **SRS:** FR-FSD-005
- **Steps:**
  1. `GET /api/capabilities`
  2. `fireSmokeDetection === true` ↔ status must be `'loaded'`
  3. `fireSmokeDetection === false` ↔ status must be `'missing'` or `'failed'`

### TC-B-005 — Capabilities Status Idempotent (Multiple Reads)
- **SRS:** FR-FSD-005, FR-FSD-018
- **Steps:**
  1. `GET /api/capabilities` × 5 in sequence
  2. Assert `fireSmokeDetection` value identical across all 5 responses
  3. Assert `fireSmokeStatus` value identical across all 5 responses

---

## 5. Test Group C — Detection Output Schema

### TC-C-001 — Capabilities ai Object Schema
- **SRS:** FR-FSD-018
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.fireSmokeDetection` is boolean
  3. Assert `body.ai.fireSmokeStatus` is string
  4. Assert no 500 or unexpected error

### TC-C-002 — Fire/Smoke classNames are Lowercase
- **SRS:** FR-FSD-011
- **Description:** Verify the NORMALISE map contract (fire → 'fire', smoke → 'smoke')
- **Method:** Check API documentation / verify expected values via capabilities endpoint
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `fireSmokeStatus` field uses lowercase string values
  3. (Runtime class name check deferred to integration test)

### TC-C-003 — Capabilities Does Not Expose 'default' Class
- **SRS:** FR-FSD-009, FR-FSD-015
- **Steps:**
  1. `GET /api/capabilities`
  2. If `vehicleClasses` or similar arrays present: Assert `'default'` is NOT in any class list
  3. Assert 'default' appears nowhere in capabilities response

### TC-C-004 — Fire and Smoke Listed Separately from Vehicle Classes
- **SRS:** FR-FSD-017
- **Steps:**
  1. `GET /api/capabilities`
  2. If `vehicleClasses` present: Assert it does NOT contain `'fire'` or `'smoke'`
  3. (Fire/smoke are separate detection module, not COCO classes)

---

## 6. Test Group D — Graceful Degradation

### TC-D-001 — Server Operational When Model Missing [MODEL ABSENT]
- **SRS:** FR-FSD-020
- **Steps:**
  1. `GET /health` → Assert 200, `status: 'ok'`
  2. `GET /api/capabilities` → Assert 200
  3. Assert `humanDetection` and `vehicleDetection` are not affected

### TC-D-002 — humanDetection Unaffected by Fire/Smoke Status
- **SRS:** FR-FSD-020
- **Steps:**
  1. `GET /api/capabilities`
  2. Note `fireSmokeDetection` value (true or false)
  3. Assert `humanDetection` is true regardless of fire/smoke status

### TC-D-003 — vehicleDetection Unaffected by Fire/Smoke Status
- **SRS:** FR-FSD-020
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `vehicleDetection` is true regardless of `fireSmokeDetection` value

### TC-D-004 — All Standard Endpoints Operational Regardless of Fire/Smoke Model
- **SRS:** FR-FSD-020
- **Steps:**
  1. `GET /health` → Assert 200
  2. `GET /api/capabilities` → Assert 200
  3. `GET /api/analytics/config` → Assert 200
  4. All endpoints must work whether or not `yolov8s_fire_smoke.onnx` is present

---

## 7. Test Group E — Error Handling & Edge Cases

### TC-E-001 — Capabilities Endpoint Not Affected by Repeated Requests
- **SRS:** FR-FSD-018
- **Steps:**
  1. `GET /api/capabilities` × 10 in rapid succession
  2. Assert all return HTTP 200
  3. Assert all `fireSmokeStatus` values are identical

### TC-E-002 — fireSmokeStatus Not 'not_started' After Any Startup Sequence
- **SRS:** FR-FSD-002, FR-FSD-003
- **Steps:**
  1. Allow 5 seconds after server start
  2. `GET /api/capabilities`
  3. Assert `fireSmokeStatus !== 'not_started'`
  4. (load() must have been called during startup)

### TC-E-003 — No 500 Error on Capabilities When Model Failed to Load
- **SRS:** FR-FSD-004
- **Steps:**
  1. (If `fireSmokeStatus === 'failed'`):
  2. `GET /api/capabilities` → Assert HTTP 200 (not 500)
  3. Assert `fireSmokeDetection === false`
  4. Assert server handles failed model gracefully

### TC-E-004 — Concurrent Capabilities Requests Don't Cause Inconsistency
- **SRS:** FR-FSD-005
- **Steps:**
  1. Send 10 concurrent `GET /api/capabilities` requests
  2. Assert all return HTTP 200
  3. Assert all `fireSmokeDetection` values are identical
  4. Assert all `fireSmokeStatus` values are identical

### TC-E-005 — Health Endpoint Distinct From Capabilities
- **SRS:** (infrastructure)
- **Steps:**
  1. `GET /health` → Assert 200, `{ status: 'ok' }`
  2. `GET /api/capabilities` → Assert 200, has `ai` object
  3. Assert health endpoint does NOT contain fire/smoke status
  4. Assert capabilities endpoint DOES contain fire/smoke status

---

## 8. Test Execution Order

```
Phase 1 — Prerequisite Checks
  TC-A-001  Server health
  TC-A-002  Capabilities accessible
  TC-A-003  fireSmokeDetection field present
  TC-A-004  fireSmokeStatus field present and valid value

Phase 2 — Status Consistency (Group A remaining)
  TC-A-005 or TC-A-006 (depending on model presence)
  TC-A-007  Consistency check

Phase 3 — State Machine Verification (Group B)
  TC-B-001  Status not 'not_started'
  TC-B-002 or TC-B-003 (model absent vs present)
  TC-B-004, TC-B-005

Phase 4 — Detection Schema (Group C)
  TC-C-001 → TC-C-004
  (All read-only, no state changes)

Phase 5 — Graceful Degradation (Group D)
  TC-D-001 → TC-D-004
  (Model-absent tests require environment without model)

Phase 6 — Error Handling (Group E)
  TC-E-001 → TC-E-005
```

---

## 9. Pass/Fail Criteria

### 9.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Capabilities | 100% of applicable tests | Yes |
| B — Service Status | 100% (5/5) | Yes |
| C — Detection Schema | 100% (4/4) | Yes |
| D — Graceful Degradation | 100% (4/4) | Yes |
| E — Error Handling | ≥ 80% (4/5) | Yes |

### 9.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-A-005 | Only when yolov8s_fire_smoke.onnx IS present |
| TC-A-006, TC-B-002, TC-D-001 | Only when yolov8s_fire_smoke.onnx is ABSENT |
| TC-E-003 (failed status) | Only when model is present but corrupt |
| TC-E-004 (concurrent) | CI environments with strict resource limits |

### 9.3 Failure Response

| Severity | Condition | Action |
|---|---|---|
| Critical | TC-A-003 fails (no fireSmokeDetection field) | API contract broken; fix capabilities handler |
| Critical | TC-D-002/TC-D-003 fail (human/vehicle affected) | Fire/smoke isolation broken; blocking |
| High | TC-B-001 fails (status is 'not_started') | `load()` not called at startup; regression |
| High | TC-A-007 fails (status inconsistency) | `fireSmokeDetection` and `fireSmokeStatus` out of sync |
| Medium | TC-E-002 fails | Startup timing issue; investigate load order |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Fire Smoke Detection |
