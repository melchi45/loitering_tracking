# TEST CASES (TC)
# AI Module — Vehicle Detection

| | |
|---|---|
| **Document ID** | TC-LTS-AI-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Vehicle_Detection.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D, F) |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Capabilities & Vehicle Class List](#3-test-group-a--capabilities--vehicle-class-list)
4. [Test Group B — Analytics Config Per-Class Gating](#4-test-group-b--analytics-config-per-class-gating)
5. [Test Group C — Multi-Class Vehicle Output Schema](#5-test-group-c--multi-class-vehicle-output-schema)
6. [Test Group D — Road-Relevant Vehicle Zone Mapping](#6-test-group-d--road-relevant-vehicle-zone-mapping)
7. [Test Group E — Error Handling & Edge Cases](#7-test-group-e--error-handling--edge-cases)
8. [Test Execution Order](#8-test-execution-order)
9. [Pass/Fail Criteria](#9-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API | REST endpoints (capabilities, analytics config) | Node.js + built-in fetch | `test/api/` |
| Integration | Per-class detection routing | Node.js + socket.io-client | `test/integration/` (Phase-3) |
| E2E | Live camera with mixed vehicle types | Manual | Phase-3 |

### 1.2 SRS Traceability

Every test case references one or more FR-VDT-NNN requirement IDs from SRS_AI_Vehicle_Detection.md.

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `GET /api/capabilities` | vehicleDetection flag + vehicleClasses list |
| `GET /api/analytics/config` | Per-class (1–8) enable state |
| `PUT /api/analytics/config` | Toggle individual vehicle classes |

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `server/models/yolov8n.onnx` present and loaded (shared with human detection)
- `GET /health` returns `{ status: 'ok' }`
- `GET /api/capabilities` returns `{ ai: { vehicleDetection: true } }`

### 2.2 Clean State

- All vehicle class configs (1–8) restored to default enabled state before each group
- Tests that modify per-class config must restore state via cleanup

### 2.3 Dependencies

```
node >= 18
No external test framework — built-in fetch only
```

---

## 3. Test Group A — Capabilities & Vehicle Class List

**Script:** `test/api/vehicle_detection.test.js`

### TC-A-001 — Capabilities Endpoint Returns vehicleDetection Field
- **SRS:** FR-VDT-017
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200
  3. Assert `typeof body.ai.vehicleDetection === 'boolean'`

### TC-A-002 — vehicleDetection True When Model Loaded
- **SRS:** FR-VDT-017
- **Precondition:** `yolov8n.onnx` present
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.vehicleDetection === true`

### TC-A-003 — vehicleClasses Array Present
- **SRS:** FR-VDT-017
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `Array.isArray(body.ai.vehicleClasses)` (when vehicleDetection is true)

### TC-A-004 — vehicleClasses Contains All 8 COCO Vehicle Names
- **SRS:** FR-VDT-017, FR-VDT-006
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `vehicleClasses` contains all of: `['bicycle','car','motorcycle','bus','truck','airplane','train','boat']`
  3. Assert `vehicleClasses.length === 8`

### TC-A-005 — vehicleClasses Contains Road-Relevant Subset
- **SRS:** FR-VDT-012
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `vehicleClasses` includes `'bicycle'`, `'car'`, `'motorcycle'`, `'bus'`, `'truck'`
  3. Assert all 5 road-relevant classes present

### TC-A-006 — Capabilities JSON Content-Type
- **SRS:** FR-VDT-017
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200 with `Content-Type: application/json`

---

## 4. Test Group B — Analytics Config Per-Class Gating

**Script:** `test/api/vehicle_detection.test.js`

### TC-B-001 — GET Analytics Config Contains Vehicle Classes 1–8
- **SRS:** FR-VDT-018
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert HTTP 200
  3. Assert entries for classIds 1, 2, 3, 4, 5, 6, 7, 8 present

### TC-B-002 — All Vehicle Classes Enabled by Default
- **SRS:** FR-VDT-009, FR-VDT-018
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert car (classId 2) is `enabled === true`
  3. Assert motorcycle (classId 3) is `enabled === true`
  4. Assert bus (classId 5) is `enabled === true`
  5. Assert truck (classId 7) is `enabled === true`

### TC-B-003 — Disable Airplane Class (classId 4)
- **SRS:** FR-VDT-009
- **Steps:**
  1. `PUT /api/analytics/config` `{ "classId": 4, "enabled": false }`
  2. Assert HTTP 200, `success === true`
  3. `GET /api/analytics/config` → Assert classId 4 `enabled === false`
  4. Assert classId 2 (car) remains `enabled === true` (no cross-class effect)
- **Cleanup:** Re-enable classId 4

### TC-B-004 — Disable and Re-enable Car Class
- **SRS:** FR-VDT-009, FR-VDT-018
- **Steps:**
  1. `PUT /api/analytics/config` `{ "classId": 2, "enabled": false }`
  2. Assert `enabled === false`
  3. `PUT /api/analytics/config` `{ "classId": 2, "enabled": true }`
  4. Assert `enabled === true`
  5. Assert other classes unaffected (motorcycle, bus, truck still enabled)

### TC-B-005 — Disable Multiple Classes Independently
- **SRS:** FR-VDT-009
- **Steps:**
  1. `PUT /api/analytics/config` `{ "classId": 4, "enabled": false }`
  2. `PUT /api/analytics/config` `{ "classId": 6, "enabled": false }`
  3. `PUT /api/analytics/config` `{ "classId": 8, "enabled": false }`
  4. `GET /api/analytics/config`
  5. Assert classId 4, 6, 8 all `enabled === false`
  6. Assert classId 2, 3, 5, 7 still `enabled === true`
- **Cleanup:** Re-enable 4, 6, 8

### TC-B-006 — Analytics Config Returns className for Each Vehicle
- **SRS:** FR-VDT-006, FR-VDT-018
- **Steps:**
  1. `GET /api/analytics/config`
  2. For classId 2: Assert `className === 'car'`
  3. For classId 3: Assert `className === 'motorcycle'`
  4. For classId 5: Assert `className === 'bus'`
  5. For classId 7: Assert `className === 'truck'`

---

## 5. Test Group C — Multi-Class Vehicle Output Schema

### TC-C-001 — Analytics Config Distinguishes Person and Vehicle Classes
- **SRS:** FR-VDT-006, FR-HDT-010
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert classId 0 entry is `'person'`
  3. Assert classId 2 entry is `'car'`
  4. Assert classId 0 and classId 2 are distinct entries

### TC-C-002 — All 8 Vehicle ClassIds Present in Config
- **SRS:** FR-VDT-006, FR-VDT-031
- **Steps:**
  1. `GET /api/analytics/config`
  2. For each classId in [1,2,3,4,5,6,7,8]: Assert entry present
  3. Assert each entry has `className` field matching expected COCO name

### TC-C-003 — Vehicle classId to className Mapping Correct
- **SRS:** FR-VDT-006
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert: 1→bicycle, 2→car, 3→motorcycle, 4→airplane, 5→bus, 6→train, 7→truck, 8→boat

### TC-C-004 — Capabilities and Analytics Config Agree on vehicleDetection
- **SRS:** FR-VDT-017, FR-VDT-018
- **Steps:**
  1. `GET /api/capabilities` → Note `vehicleDetection` value
  2. `GET /api/analytics/config` → Note presence of vehicle class entries
  3. Assert: when `vehicleDetection === true`, vehicle classes 1–8 present in config

---

## 6. Test Group D — Road-Relevant Vehicle Zone Mapping

### TC-D-001 — Road Vehicles Subset Identifiable from Config
- **SRS:** FR-VDT-012
- **Steps:**
  1. `GET /api/analytics/config`
  2. Collect classNames for classIds 1, 2, 3, 5, 7
  3. Assert all of `['bicycle','car','motorcycle','bus','truck']` present
  4. Confirm classIds 4 (airplane), 6 (train), 8 (boat) have distinct classNames

### TC-D-002 — Non-Road Vehicle Classes Present but Separable
- **SRS:** FR-VDT-012
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert classId 4 className is `'airplane'`
  3. Assert classId 6 className is `'train'`
  4. Assert classId 8 className is `'boat'`
  5. Confirm these are not in the road-relevant set

---

## 7. Test Group E — Error Handling & Edge Cases

### TC-E-001 — PUT Config for Non-Existent ClassId
- **SRS:** FR-VDT-009
- **Steps:**
  1. `PUT /api/analytics/config` `{ "classId": 99, "enabled": false }`
  2. Assert HTTP 400 or `success === false` (not a 500)

### TC-E-002 — GET Config is Idempotent (Multiple Reads)
- **SRS:** FR-VDT-018
- **Steps:**
  1. `GET /api/analytics/config` × 5 in sequence
  2. Assert all 5 responses are identical JSON
  3. Assert all return HTTP 200

### TC-E-003 — Class 0 Config Change Does Not Affect Vehicle Classes
- **SRS:** FR-VDT-009 (independence)
- **Steps:**
  1. Read initial state of classId 2 (car)
  2. `PUT /api/analytics/config` `{ "classId": 0, "enabled": false }` (disable person)
  3. `GET /api/analytics/config` → Assert classId 2 (car) state unchanged
- **Cleanup:** Re-enable classId 0

### TC-E-004 — Concurrent PUT Requests for Different Classes
- **SRS:** FR-VDT-032
- **Steps:**
  1. Send simultaneously: disable classId 4, disable classId 6, disable classId 8
  2. Wait for all to complete
  3. `GET /api/analytics/config` → Assert all three are disabled
  4. Assert classId 2 (car) still enabled (no collision)
- **Cleanup:** Re-enable 4, 6, 8

### TC-E-005 — vehicleDetection false When Model Missing
- **SRS:** FR-VDT-019
- **Condition:** Test in environment without model file (or mock)
- **Steps:**
  1. `GET /api/capabilities`
  2. If `vehicleDetection === false`: Assert `body.ai.vehicleDetection === false`
  3. Assert server still responds HTTP 200 (no crash)

---

## 8. Test Execution Order

```
Phase 1 — Prerequisite Checks
  TC-A-001  Capabilities accessible
  TC-A-002  vehicleDetection true
  TC-A-003  vehicleClasses array present

Phase 2 — Vehicle Class List (Group A)
  TC-A-004, TC-A-005, TC-A-006

Phase 3 — Analytics Config Read (Group B read-only)
  TC-B-001, TC-B-002, TC-B-006

Phase 4 — Analytics Config Write (Group B mutating)
  TC-B-003 → TC-B-005
  (Each test restores state in cleanup)

Phase 5 — Output Schema (Group C)
  TC-C-001 → TC-C-004

Phase 6 — Zone Mapping (Group D)
  TC-D-001, TC-D-002

Phase 7 — Error Handling (Group E)
  TC-E-001 → TC-E-005
  (TC-E-003, TC-E-004 restore state in cleanup)
```

---

## 9. Pass/Fail Criteria

### 9.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Capabilities | 100% (6/6) | Yes |
| B — Analytics Config | 100% (6/6) | Yes |
| C — Multi-Class Schema | 100% (4/4) | Yes |
| D — Zone Mapping | 100% (2/2) | Yes |
| E — Error Handling | ≥ 80% (4/5) | Yes |

### 9.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-E-005 (model missing) | Only runnable in separate test environment without model |
| TC-E-004 (concurrent PUT) | CI with strict resource limits |

### 9.3 Failure Response

| Severity | Condition | Action |
|---|---|---|
| Critical | TC-A-002 fails (vehicleDetection false) | Verify model loaded; check capabilities handler |
| Critical | TC-A-004 fails (vehicle class list incomplete) | API contract violated; fix before release |
| High | TC-B-003 through TC-B-005 fail | Per-class config broken; cannot enable/disable vehicles |
| Medium | TC-C-003 fails (mapping wrong) | classId→className mapping error; fix in capabilities handler |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Vehicle Detection |
