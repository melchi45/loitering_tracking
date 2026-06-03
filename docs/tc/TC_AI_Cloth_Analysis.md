# TEST CASES (TC)
# AI Module — Cloth Analysis

| | |
|---|---|
| **Document ID** | TC-LTS-AI-04 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Cloth_Analysis.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D, F) |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Capabilities & Phase Status](#3-test-group-a--capabilities--phase-status)
4. [Test Group B — Analytics Config (Cloth Zone Gate)](#4-test-group-b--analytics-config-cloth-zone-gate)
5. [Test Group C — Phase-1 Behavior Verification](#5-test-group-c--phase-1-behavior-verification)
6. [Test Group D — Phase-2 PAR Model Status](#6-test-group-d--phase-2-par-model-status)
7. [Test Group E — Error Handling & Edge Cases](#7-test-group-e--error-handling--edge-cases)
8. [Test Execution Order](#8-test-execution-order)
9. [Pass/Fail Criteria](#9-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API | Capabilities + analytics config REST endpoints | Node.js + built-in fetch | `test/api/` |
| Integration | Socket.IO `detections` event cloth field validation | Node.js + socket.io-client | `test/integration/` (Phase-3) |
| E2E | PAR inference output validation | Manual + real camera frame | Phase-3 |

### 1.2 SRS Traceability

Every test case references one or more FR-CLT-NNN requirement IDs from SRS_AI_Cloth_Analysis.md.

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `GET /api/capabilities` | clothAnalysis phase status |
| `GET /api/analytics/config` | 'cloth' feature enable state |
| `PUT /api/analytics/config` | Toggle cloth analysis |

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `GET /health` returns `{ status: 'ok' }`
- `server/models/yolov8n.onnx` present (person detection required)

### 2.2 Phase Awareness

Tests are written to pass in both Phase-1 (no PAR model) and Phase-2 (PAR model present). Phase-specific tests are labeled accordingly.

### 2.3 Dependencies

```
node >= 18
No external test framework — built-in fetch only
```

---

## 3. Test Group A — Capabilities & Phase Status

**Script:** `test/api/cloth_analysis.test.js`

### TC-A-001 — Capabilities Endpoint Accessible
- **SRS:** FR-CLT-003
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200
  3. Assert response is JSON

### TC-A-002 — Capabilities Contains ai Object
- **SRS:** FR-CLT-003, FR-CLT-004
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai` is an object
  3. Assert `body.ai` is not null

### TC-A-003 — clothAnalysis Field Present in Capabilities
- **SRS:** FR-CLT-003
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `'clothAnalysis' in body.ai` OR `body.ai.clothAnalysis !== undefined`
  3. Assert `typeof body.ai.clothAnalysis === 'boolean'`

### TC-A-004 — colorAnalysis Always True (Phase-1 Available)
- **SRS:** FR-CLT-002, FR-CLR-010
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.colorAnalysis === true`
  3. (Color analysis is always available regardless of PAR model)

### TC-A-005 — clothAnalysis Phase Indicator (if present)
- **SRS:** FR-CLT-001, FR-CLT-003
- **Steps:**
  1. `GET /api/capabilities`
  2. If `clothAnalysisPhase` field present: Assert value is 1 or 2
  3. If `clothAnalysis === false`: Assert phase is 1 (PAR model not loaded)

---

## 4. Test Group B — Analytics Config (Cloth Zone Gate)

**Script:** `test/api/cloth_analysis.test.js`

### TC-B-001 — GET Analytics Config Returns Cloth Feature State
- **SRS:** FR-CLT-017, FR-CLT-018
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert HTTP 200
  3. Assert response contains cloth feature information (via 'cloth' key or feature flags)

### TC-B-002 — Cloth Feature Defaults to Enabled State
- **SRS:** FR-CLT-017
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert cloth analysis is enabled by default (or confirm current state is documented)

### TC-B-003 — PUT Analytics Config — Disable Cloth Analysis
- **SRS:** FR-CLT-017
- **Steps:**
  1. `PUT /api/analytics/config` body `{ "feature": "cloth", "enabled": false }` (or equivalent)
  2. Assert HTTP 200, `success === true`
  3. `GET /api/analytics/config` → Assert cloth disabled
- **Cleanup:** Re-enable cloth

### TC-B-004 — PUT Analytics Config — Re-enable Cloth Analysis
- **SRS:** FR-CLT-017
- **Steps:**
  1. Disable cloth (from TC-B-003)
  2. `PUT /api/analytics/config` body `{ "feature": "cloth", "enabled": true }`
  3. Assert HTTP 200
  4. `GET /api/analytics/config` → Assert cloth enabled

### TC-B-005 — Disabling Cloth Does Not Disable Color
- **SRS:** FR-CLT-002, FR-CLT-017
- **Steps:**
  1. `PUT /api/analytics/config` `{ "feature": "cloth", "enabled": false }`
  2. `GET /api/analytics/config`
  3. Assert color feature remains enabled
  4. `GET /api/capabilities` → Assert `colorAnalysis` still true
- **Cleanup:** Re-enable cloth

---

## 5. Test Group C — Phase-1 Behavior Verification

### TC-C-001 — Phase-1: clothAnalysis false When openpar.onnx Absent
- **SRS:** FR-CLT-001, FR-CLT-003
- **Condition:** `server/models/openpar.onnx` NOT present
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.clothAnalysis === false`
  3. Assert `body.ai.colorAnalysis === true` (color still works)

### TC-C-002 — Phase-1: colorAnalysis Always Available
- **SRS:** FR-CLT-002, FR-CLR-010
- **Steps:**
  1. `GET /api/capabilities`
  2. Regardless of clothAnalysis value: Assert `body.ai.colorAnalysis === true`

### TC-C-003 — Phase-1: Server Starts Successfully Without PAR Model
- **SRS:** FR-CLT-001, FR-CLT-005
- **Steps:**
  1. `GET /health` → Assert HTTP 200, `status: 'ok'`
  2. `GET /api/capabilities` → Assert HTTP 200
  3. Assert no 503 or 500 responses
  4. (Verifies graceful degradation — server fully functional without PAR model)

### TC-C-004 — Phase-1: humanDetection Unaffected by PAR Model Absence
- **SRS:** FR-CLT-001
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.humanDetection === true` (not impacted by cloth model absence)

---

## 6. Test Group D — Phase-2 PAR Model Status

### TC-D-001 — Phase-2: clothAnalysis True When openpar.onnx Present
- **SRS:** FR-CLT-005, FR-CLT-006
- **Condition:** `server/models/openpar.onnx` IS present and loaded
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.clothAnalysis === true`
  3. Assert `body.ai.clothAnalysisPhase === 2` (if field present)

### TC-D-002 — Phase-2: Cloth Status Reflects Loaded State
- **SRS:** FR-CLT-003, FR-CLT-006
- **Condition:** PAR model loaded
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.clothAnalysis === true`
  3. Assert `body.ai.colorAnalysis === true`

### TC-D-003 — Phase-2: Analytics Config Accessible When PAR Loaded
- **SRS:** FR-CLT-017
- **Condition:** PAR model loaded
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert HTTP 200
  3. Assert cloth feature appears in config

---

## 7. Test Group E — Error Handling & Edge Cases

### TC-E-001 — PUT Config Missing Feature Key Returns Error
- **SRS:** FR-CLT-017
- **Steps:**
  1. `PUT /api/analytics/config` body `{ "enabled": false }` (no feature/classId)
  2. Assert HTTP 400 or `success === false`

### TC-E-002 — Capabilities Idempotent Across Multiple Requests
- **SRS:** FR-CLT-003
- **Steps:**
  1. `GET /api/capabilities` × 5 in sequence
  2. Assert all return HTTP 200
  3. Assert `clothAnalysis` value is identical across all responses

### TC-E-003 — Cloth Config Change Does Not Affect Human Detection Config
- **SRS:** FR-CLT-017 (independence)
- **Steps:**
  1. Read initial state of classId 0 (person)
  2. `PUT /api/analytics/config` to disable cloth
  3. `GET /api/analytics/config` → Assert classId 0 (person) unchanged
- **Cleanup:** Re-enable cloth

### TC-E-004 — Server Responds to All Endpoints When Cloth Model Missing
- **SRS:** FR-CLT-001, FR-CLT-004
- **Steps:**
  1. `GET /health` → Assert 200
  2. `GET /api/capabilities` → Assert 200
  3. `GET /api/analytics/config` → Assert 200
  4. (All standard endpoints operational regardless of PAR model state)

---

## 8. Test Execution Order

```
Phase 1 — Prerequisite Checks
  TC-A-001  Capabilities accessible
  TC-A-002  ai object present
  TC-A-004  colorAnalysis always true

Phase 2 — Capabilities & Phase Status (Group A)
  TC-A-003, TC-A-005

Phase 3 — Analytics Config Read (Group B read-only)
  TC-B-001, TC-B-002

Phase 4 — Analytics Config Write (Group B mutating)
  TC-B-003, TC-B-004, TC-B-005

Phase 5 — Phase-1 Verification (Group C)
  TC-C-001 through TC-C-004
  (skip TC-C-001 if PAR model IS present)

Phase 6 — Phase-2 Verification (Group D)
  TC-D-001 through TC-D-003
  (skip if PAR model NOT present)

Phase 7 — Error Handling (Group E)
  TC-E-001 through TC-E-004
```

---

## 9. Pass/Fail Criteria

### 9.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Capabilities | 100% (5/5) | Yes |
| B — Analytics Config | 100% (5/5) | Yes |
| C — Phase-1 Behavior | 100% (4/4) | Yes |
| D — Phase-2 PAR Status | 100% when PAR present; Skip when absent | Yes (when applicable) |
| E — Error Handling | ≥ 80% (3/4) | Yes |

### 9.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-C-001 | Only when openpar.onnx is absent |
| TC-D-001, TC-D-002, TC-D-003 | Only when openpar.onnx is present |

### 9.3 Failure Response

| Severity | Condition | Action |
|---|---|---|
| Critical | TC-A-004 fails (colorAnalysis false) | Color service broken; blocking |
| Critical | TC-C-003 fails (server crash without PAR) | Phase-1 startup regression; immediate fix |
| High | TC-B-003/TC-B-004 fail | Cloth toggle broken |
| Medium | TC-D-001 fails (Phase-2 clothAnalysis not true) | PAR model not exposing status correctly |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Cloth Analysis |
