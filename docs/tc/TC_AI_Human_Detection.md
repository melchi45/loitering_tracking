# TEST CASES (TC)
# AI Module — Human Detection

| | |
|---|---|
| **Document ID** | TC-LTS-AI-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Human_Detection.md |
| **Test Scripts** | test/api/human_detection.test.js |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Capabilities & Health API](#3-test-group-a--capabilities--health-api)
4. [Test Group B — Analytics Config (Human Class Gate)](#4-test-group-b--analytics-config-human-class-gate)
5. [Test Group C — Detection Output Schema](#5-test-group-c--detection-output-schema)
6. [Test Group D — Error Handling & Edge Cases](#6-test-group-d--error-handling--edge-cases)
7. [Test Execution Order](#7-test-execution-order)
8. [Pass/Fail Criteria](#8-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API | REST endpoints (capabilities, analytics config) | Node.js + built-in fetch | `test/api/` |
| Integration | Socket.IO `detections` event schema | Node.js + socket.io-client | `test/integration/` (Phase-3) |
| E2E | Live camera pipeline with person in frame | Manual | Phase-3 |

### 1.2 SRS Traceability

Every test case references one or more FR-HDT-NNN requirement IDs from SRS_AI_Human_Detection.md.

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `GET /api/capabilities` | Confirm humanDetection capability status |
| `GET /api/analytics/config` | Read class 0 (person) enable state |
| `PUT /api/analytics/config` | Toggle person class detection |
| `GET /health` | Server health verification |

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `server/models/yolov8n.onnx` present and loaded
- `GET /health` returns `{ status: 'ok' }`
- `GET /api/capabilities` returns `{ ai: { humanDetection: true } }`

### 2.2 Clean State

- Analytics config for class 0 (person) must be enabled before each test group run
- Restore class 0 enabled state after any test that modifies it

### 2.3 Dependencies

```
node >= 18
No external test framework — built-in fetch only
```

---

## 3. Test Group A — Capabilities & Health API

**Script:** `test/api/human_detection.test.js`

### TC-A-001 — Server Health Check
- **SRS:** (prerequisite)
- **Steps:**
  1. `GET /health`
  2. Assert HTTP 200
  3. Assert `body.status === 'ok'`

### TC-A-002 — Capabilities Endpoint Returns humanDetection Field
- **SRS:** FR-HDT-020
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200
  3. Assert `body.ai` exists
  4. Assert `typeof body.ai.humanDetection === 'boolean'`

### TC-A-003 — humanDetection True When Model Loaded
- **SRS:** FR-HDT-020
- **Precondition:** `yolov8n.onnx` present in `server/models/`
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.humanDetection === true`

### TC-A-004 — Capabilities Response Schema Includes modelName
- **SRS:** FR-HDT-020
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.modelName` is a string (when humanDetection is true)
  3. Assert `body.ai.modelName` contains 'yolov8n'

### TC-A-005 — Capabilities Response is JSON
- **SRS:** FR-HDT-020
- **Steps:**
  1. `GET /api/capabilities` with `Accept: application/json`
  2. Assert HTTP 200
  3. Assert response `Content-Type` includes `application/json`

---

## 4. Test Group B — Analytics Config (Human Class Gate)

**Script:** `test/api/human_detection.test.js`

### TC-B-001 — GET Analytics Config Returns Class 0 Entry
- **SRS:** FR-HDT-017
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert HTTP 200
  3. Assert response contains class 0 entry
  4. Assert `body.classes['0'].className === 'person'` (or equivalent field)

### TC-B-002 — Class 0 Enabled by Default
- **SRS:** FR-HDT-017
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert class 0 (person) `enabled === true`

### TC-B-003 — PUT Analytics Config Disables Class 0
- **SRS:** FR-HDT-017
- **Steps:**
  1. `PUT /api/analytics/config` body `{ "classId": 0, "enabled": false }`
  2. Assert HTTP 200
  3. Assert `body.success === true`
  4. `GET /api/analytics/config` → Assert class 0 `enabled === false`
- **Cleanup:** Re-enable class 0

### TC-B-004 — PUT Analytics Config Re-enables Class 0
- **SRS:** FR-HDT-017
- **Steps:**
  1. Disable class 0 (from TC-B-003)
  2. `PUT /api/analytics/config` body `{ "classId": 0, "enabled": true }`
  3. Assert HTTP 200, `success === true`
  4. `GET /api/analytics/config` → Assert class 0 `enabled === true`

### TC-B-005 — PUT Analytics Config — Invalid classId Returns Error
- **SRS:** FR-HDT-017
- **Steps:**
  1. `PUT /api/analytics/config` body `{ "classId": 999, "enabled": false }`
  2. Assert HTTP 400 or `success === false`

### TC-B-006 — PUT Analytics Config — Missing classId Returns Error
- **SRS:** FR-HDT-017
- **Steps:**
  1. `PUT /api/analytics/config` body `{ "enabled": false }` (no classId)
  2. Assert HTTP 400 or `success === false`

---

## 5. Test Group C — Detection Output Schema

**Note:** These tests verify the REST API and capabilities schema. Full detection pipeline tests with real JPEG frames are integration-level (Phase-3).

### TC-C-001 — Capabilities ai Object Structure
- **SRS:** FR-HDT-020, FR-HDT-016
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai` is an object
  3. Assert `'humanDetection' in body.ai`
  4. Assert `typeof body.ai.humanDetection === 'boolean'`

### TC-C-002 — Analytics Config Contains Person Class Schema
- **SRS:** FR-HDT-013, FR-HDT-017
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert class 0 entry has `className` field
  3. Assert `className` value is `'person'`

### TC-C-003 — Analytics Config Contains All Expected Fields
- **SRS:** FR-HDT-017, FR-HDT-019
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert response is JSON object
  3. Assert `body.classes` or `body.enabled` (config structure) is accessible
  4. Assert person class (0) is enumerated in the config

### TC-C-004 — Confidence Threshold Reflected in Config (if exposed)
- **SRS:** FR-HDT-004
- **Steps:**
  1. `GET /api/analytics/config` or `GET /api/capabilities`
  2. If `confidenceThreshold` field present: Assert value is a number in range [0, 1]
  3. Skip if not exposed (implementation detail)

---

## 6. Test Group D — Error Handling & Edge Cases

### TC-D-001 — Capabilities Endpoint Accessible Without Auth
- **SRS:** FR-HDT-020
- **Steps:**
  1. `GET /api/capabilities` with no Authorization header
  2. Assert HTTP 200 (not 401/403)

### TC-D-002 — Analytics Config Accessible Without Auth
- **SRS:** FR-HDT-017
- **Steps:**
  1. `GET /api/analytics/config` with no Authorization header
  2. Assert HTTP 200

### TC-D-003 — PUT Analytics Config — Non-Boolean enabled Handled
- **SRS:** FR-HDT-017
- **Steps:**
  1. `PUT /api/analytics/config` body `{ "classId": 0, "enabled": "yes" }`
  2. Assert response is not HTTP 500 (400 or coerced to boolean is acceptable)
- **Cleanup:** Ensure class 0 remains enabled

### TC-D-004 — Concurrent GET /api/capabilities Requests
- **SRS:** FR-HDT-032
- **Steps:**
  1. Send 10 concurrent `GET /api/capabilities` requests
  2. Assert all return HTTP 200
  3. Assert all `body.ai.humanDetection` are identical (no race condition)

### TC-D-005 — Analytics Config State Persists Across GET Requests
- **SRS:** FR-HDT-017
- **Steps:**
  1. `PUT /api/analytics/config` `{ classId: 0, enabled: false }`
  2. `GET /api/analytics/config` × 3 in sequence
  3. Assert all three responses show class 0 `enabled === false`
- **Cleanup:** Re-enable class 0

---

## 7. Test Execution Order

```
Phase 1 — Prerequisite Checks
  TC-A-001  Server health (GET /health → 200)
  TC-A-002  Capabilities endpoint accessible
  TC-A-003  humanDetection === true

Phase 2 — Capabilities Schema (Group A)
  TC-A-004, TC-A-005

Phase 3 — Analytics Config Read (Group B read-only)
  TC-B-001, TC-B-002

Phase 4 — Analytics Config Write (Group B mutating)
  TC-B-003 → TC-B-006
  (Each test restores class 0 enabled state before next)

Phase 5 — Output Schema Verification (Group C)
  TC-C-001 → TC-C-004

Phase 6 — Error Handling (Group D)
  TC-D-001 → TC-D-005
  (TC-D-005 restores class 0 enabled state after)
```

---

## 8. Pass/Fail Criteria

### 8.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Capabilities | 100% (5/5) | Yes |
| B — Analytics Config | 100% (6/6) | Yes |
| C — Detection Schema | 100% (4/4) | Yes |
| D — Error Handling | ≥ 80% (4/5) | Yes |

### 8.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-C-004 (confidence threshold) | Only if not exposed via API |
| TC-D-004 (concurrency) | CI environments with strict resource limits |

### 8.3 Failure Response

| Severity | Condition | Action |
|---|---|---|
| Critical | TC-A-003 fails (humanDetection false) | Verify model file present; check load logs |
| Critical | TC-B-003 fails (PUT config broken) | Analytics config API broken; block release |
| High | Any Group C failure | Detection schema contract violated |
| Medium | TC-D-003 or TC-D-005 failures | Investigate config state management |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Human Detection |
