# TEST CASES (TC)
# AI Module — Accessories Detection

| | |
|---|---|
| **Document ID** | TC-LTS-AI-ACC-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Accessories_Detection.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D, F) |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Analytics Config (Per-Item Toggles)](#3-test-group-a--analytics-config-per-item-toggles)
4. [Test Group B — Capabilities Endpoint](#4-test-group-b--capabilities-endpoint)
5. [Test Group C — Detection Output Schema](#5-test-group-c--detection-output-schema)
6. [Test Group D — Zone Configuration (targetClass alias)](#6-test-group-d--zone-configuration-targetclass-alias)
7. [Test Group E — Abandoned Item Alert](#7-test-group-e--abandoned-item-alert)
8. [Test Group F — Edge Cases & Error Handling](#8-test-group-f--edge-cases--error-handling)
9. [Test Execution Order](#9-test-execution-order)
10. [Pass/Fail Criteria](#10-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API (Unit) | REST endpoints: analytics config, capabilities | Node.js + node-fetch | `test/api/` |
| Integration | Enable accessory → verify detection in socket event | Node.js + Socket.IO client | `test/api/` |
| E2E | Full pipeline with live/recorded video | Manual | Phase-3 |

### 1.2 SRS Traceability

Every test case references one or more FR-ACC-NNN requirement IDs from SRS_AI_Accessories_Detection.md.

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| PUT body `{ backpack: true }` | Enable single accessory |
| PUT body `{ backpack: false, umbrella: false, handbag: false, tie: false, suitcase: false }` | Disable all accessories |
| Zone config with `targetClasses: ["accessories"]` | Backward-compat alias test |
| Zone config with `targetClasses: ["backpack"]` | Individual item zone test |

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `server/models/yolov8n.onnx` present
- `GET /health` returns `{ status: 'ok' }`

### 2.2 Clean State

- All accessory keys reset to `false` before each test group
- Zone state restored after zone-related tests

### 2.3 Dependencies

```
node >= 18
Server running on BASE_URL (default: http://localhost:3080)
```

---

## 3. Test Group A — Analytics Config (Per-Item Toggles)

**Script:** `test/api/accessories_detection.test.js`

### TC-A-001 — GET analytics/config returns accessory keys
- **SRS:** FR-ACC-005, FR-ACC-006
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert HTTP 200
  3. Assert `data.backpack === false` (default)
  4. Assert `data.umbrella === false`
  5. Assert `data.handbag === false`
  6. Assert `data.tie === false`
  7. Assert `data.suitcase === false`

### TC-A-002 — PUT enables backpack
- **SRS:** FR-ACC-005, FR-ACC-008
- **Steps:**
  1. `PUT /api/analytics/config` body `{ backpack: true }`
  2. Assert HTTP 200
  3. `GET /api/analytics/config`
  4. Assert `data.backpack === true`
- **Cleanup:** PUT `{ backpack: false }`

### TC-A-003 — PUT enables all 5 accessory items
- **SRS:** FR-ACC-005, FR-ACC-008
- **Steps:**
  1. `PUT /api/analytics/config` body `{ backpack: true, umbrella: true, handbag: true, tie: true, suitcase: true }`
  2. Assert HTTP 200
  3. `GET /api/analytics/config`
  4. Assert all 5 keys are `true`
- **Cleanup:** Disable all

### TC-A-004 — PUT persists across GET requests
- **SRS:** FR-ACC-008
- **Steps:**
  1. PUT `{ suitcase: true }`
  2. GET → assert `suitcase === true`
  3. GET again → assert still `suitcase === true` (no state drift)
- **Cleanup:** PUT `{ suitcase: false }`

### TC-A-005 — Disable single item while others remain enabled
- **SRS:** FR-ACC-005
- **Steps:**
  1. PUT `{ backpack: true, handbag: true }`
  2. PUT `{ backpack: false }`
  3. GET → assert `backpack === false`, `handbag === true`
- **Cleanup:** Disable all

### TC-A-006 — GET returns glasses and sunglasses as false (Phase-2 placeholders)
- **SRS:** FR-ACC-005 (Phase-2 keys exist in config but not MODULE_CLASSES)
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert `data.glasses === false`
  3. Assert `data.sunglasses === false`

---

## 4. Test Group B — Capabilities Endpoint

**Script:** `test/api/accessories_detection.test.js`

### TC-B-001 — GET capabilities returns per-item fields
- **SRS:** FR-ACC-020
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200
  3. Assert `body.ai.backpack` is boolean
  4. Assert `body.ai.umbrella` is boolean
  5. Assert `body.ai.handbag` is boolean
  6. Assert `body.ai.tie` is boolean
  7. Assert `body.ai.suitcase` is boolean

### TC-B-002 — Capabilities reflect model loaded state
- **SRS:** FR-ACC-020, FR-ACC-021
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert all 5 accessory capability fields are `true` (yolov8n.onnx present)
  3. (Model-absent variant): If test env has no model, assert all 5 are `false`

---

## 5. Test Group C — Detection Output Schema

**Script:** `test/api/accessories_detection.test.js`

### TC-C-001 — Enable backpack; verify className in config response
- **SRS:** FR-ACC-004, FR-ACC-005
- **Steps:**
  1. `PUT /api/analytics/config` `{ backpack: true }`
  2. `GET /api/analytics/config`
  3. Assert `data.backpack === true`
- **Cleanup:** Disable

### TC-C-002 — Detection schema has required accessory fields
- **SRS:** FR-ACC-012
- **Steps (integration):**
  1. Enable backpack
  2. Connect Socket.IO client
  3. Register `detections` handler
  4. Wait for frame with backpack detection (or inject mock frame)
  5. Assert detection has: `bbox`, `confidence`, `classId` (24), `className` (`backpack`)
  6. Assert `0 ≤ confidence ≤ 1`
  7. Assert `bbox.width > 0` and `bbox.height > 0`
- **Cleanup:** Disable backpack

### TC-C-003 — Disabled class not emitted in detections
- **SRS:** FR-ACC-005, FR-ACC-006
- **Steps (integration):**
  1. Disable all accessory keys via PUT
  2. Connect Socket.IO, listen for `detections` events for 3 seconds
  3. Assert no detection object has `className === 'backpack'` (or any accessory class)

---

## 6. Test Group D — Zone Configuration (targetClass alias)

**Script:** `test/api/accessories_detection.test.js`

### TC-D-001 — GET analytics/config — zone group keys present
- **SRS:** FR-ACC-007
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert all individual keys (`backpack`, `umbrella`, `handbag`, `tie`, `suitcase`) are present

### TC-D-002 — PUT individual accessory key updates correctly
- **SRS:** FR-ACC-007, FR-ACC-008
- **Steps:**
  1. `PUT /api/analytics/config` `{ umbrella: true }`
  2. `GET /api/analytics/config`
  3. Assert `data.umbrella === true`
  4. Assert all other accessory keys are unchanged (or false if reset)
- **Cleanup:** PUT `{ umbrella: false }`

### TC-D-003 — Multiple accessory keys update independently
- **SRS:** FR-ACC-005
- **Steps:**
  1. PUT `{ backpack: true }` → assert backpack true
  2. PUT `{ suitcase: true }` → assert suitcase true, backpack still true
  3. PUT `{ backpack: false }` → assert backpack false, suitcase still true
- **Cleanup:** Disable all

---

## 7. Test Group E — Abandoned Item Alert

**Script:** `test/api/accessories_detection.test.js` (integration section)

### TC-E-001 — abandoned_item Socket.IO event schema
- **SRS:** FR-ACC-016
- **Condition:** Integration test — requires camera with visible accessory left unattended
- **Steps:**
  1. Connect Socket.IO client; register `abandoned_item` handler
  2. (Mock or wait for) an abandonment scenario
  3. Assert event payload has: `type`, `cameraId`, `accessoryType`, `priority`, `abandonDurationSec`, `timestamp`
  4. Assert `type === 'abandoned_item'`
  5. Assert `priority` is one of `'high'`, `'medium'`, `'low'`
  6. Assert `abandonDurationSec >= 0`

### TC-E-002 — High-priority items (suitcase/backpack) use correct timeout
- **SRS:** FR-ACC-014
- **Steps (configuration check):**
  1. Verify server-side configuration: ABANDON_TIMEOUTS.high === 30 (seconds)
  2. Assert `suitcase` and `backpack` map to `'high'` priority
  3. (Integration) If abandonedItem emitted for suitcase: assert `priority === 'high'`

---

## 8. Test Group F — Edge Cases & Error Handling

**Script:** `test/api/accessories_detection.test.js`

### TC-F-001 — Unknown key in PUT is ignored
- **SRS:** FR-ACC-023
- **Steps:**
  1. `PUT /api/analytics/config` `{ backpack: true, unknown_key: true }`
  2. Assert HTTP 200
  3. `GET /api/analytics/config`
  4. Assert `data.backpack === true`
  5. Assert `data.unknown_key` is `undefined` or absent
- **Cleanup:** Disable backpack

### TC-F-002 — PUT with empty body doesn't reset config
- **SRS:** FR-ACC-008
- **Steps:**
  1. PUT `{ backpack: true }`
  2. PUT `{}` (empty body)
  3. GET → assert `backpack` is still `true`
- **Cleanup:** Disable

### TC-F-003 — Capabilities endpoint structure is stable
- **SRS:** FR-ACC-020
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert response is HTTP 200 with JSON body
  3. Assert `body.ai` exists and is an object
  4. Assert all 5 accessory keys present in `body.ai`

### TC-F-004 — Server health check
- **SRS:** General prerequisite
- **Steps:**
  1. `GET /health`
  2. Assert HTTP 200
  3. Assert `body.status === 'ok'`

---

## 9. Test Execution Order

```
Phase 1 — Prerequisites
  TC-F-004  Server health check
  TC-B-001  Capabilities endpoint structure

Phase 2 — Analytics Config (Group A)
  TC-A-001 through TC-A-006
  (reads and writes config; cleanup after each)

Phase 3 — Capabilities (Group B)
  TC-B-002
  Prerequisite: Group A must pass (config is writable)

Phase 4 — Detection Output Schema (Group C)
  TC-C-001 through TC-C-003
  Prerequisite: Server must be processing camera frames

Phase 5 — Zone Config (Group D)
  TC-D-001 through TC-D-003

Phase 6 — Abandoned Item Alert (Group E)
  TC-E-001, TC-E-002
  Note: Full integration tests require camera feed; may be skipped in unit test runs

Phase 7 — Edge Cases (Group F)
  TC-F-001 through TC-F-003
```

---

## 10. Pass/Fail Criteria

### 10.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Analytics Config | 100% (6/6) | Yes |
| B — Capabilities | 100% (2/2) | Yes |
| C — Detection Schema | 100% (3/3) | Yes (TC-C-002 may be skipped without camera) |
| D — Zone Config | 100% (3/3) | Yes |
| E — Abandoned Item | ≥ 50% (1/2) | No (integration-dependent) |
| F — Edge Cases | 100% (4/4) | Yes |

### 10.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-C-002 (detection schema) | No active camera feed in test environment |
| TC-C-003 (disabled class check) | No active camera feed |
| TC-E-001 (abandoned_item event) | Cannot reproduce unattended scenario in unit test |
| TC-E-002 (timeout integration) | Long-running; skip in CI |

### 10.3 Failure Response

| Severity | Condition | Action |
|---|---|---|
| Critical | Any Group A or B failure | Block release; fix before merge |
| High | Any Group C or D failure | Block release |
| Medium | Group E failures | Log as issue; schedule for integration test phase |
| Low | Group F failures | Investigate; non-blocking for unit test pass |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Accessories Detection |
