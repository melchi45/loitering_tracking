# TEST CASES (TC)
# AI Module — Color Analysis

| | |
|---|---|
| **Document ID** | TC-LTS-AI-05 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Color_Analysis.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D, F) |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Capabilities (Color Always Available)](#3-test-group-a--capabilities-color-always-available)
4. [Test Group B — Analytics Config (Color Zone Gate)](#4-test-group-b--analytics-config-color-zone-gate)
5. [Test Group C — HSV Classification Logic Validation](#5-test-group-c--hsv-classification-logic-validation)
6. [Test Group D — ROI and API Schema Verification](#6-test-group-d--roi-and-api-schema-verification)
7. [Test Group E — Error Handling & Edge Cases](#7-test-group-e--error-handling--edge-cases)
8. [Test Execution Order](#8-test-execution-order)
9. [Pass/Fail Criteria](#9-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API | Capabilities + analytics config REST endpoints | Node.js + built-in fetch | `test/api/` |
| Unit | `rgbToColorName()` pure function classification | Node.js direct import | `test/unit/` (Phase-3) |
| Integration | Socket.IO `detections` event color field | Node.js + socket.io-client | `test/integration/` (Phase-3) |

### 1.2 SRS Traceability

Every test case references one or more FR-CLR-NNN requirement IDs from SRS_AI_Color_Analysis.md.

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `GET /api/capabilities` | colorAnalysis availability (always true) |
| `GET /api/analytics/config` | 'color' feature enable state |
| `PUT /api/analytics/config` | Toggle color analysis |
| RGB test vectors | HSV classification boundary testing |

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3001`
- `GET /health` returns `{ status: 'ok' }`
- Color analysis requires no ONNX model — available immediately on startup

### 2.2 Clean State

- Analytics config for 'color' feature must be enabled before each group
- Tests that disable 'color' must restore state in cleanup

### 2.3 Dependencies

```
node >= 18
No external test framework — built-in fetch only
```

---

## 3. Test Group A — Capabilities (Color Always Available)

**Script:** `test/api/color_analysis.test.js`

### TC-A-001 — Capabilities Endpoint Returns colorAnalysis Field
- **SRS:** FR-CLR-010
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200
  3. Assert `body.ai` exists
  4. Assert `'colorAnalysis' in body.ai`

### TC-A-002 — colorAnalysis Always True (No Model Required)
- **SRS:** FR-CLR-010
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.colorAnalysis === true`
  3. (Must be true regardless of PAR/ONNX model availability)

### TC-A-003 — colorAnalysis True Even When clothAnalysis False
- **SRS:** FR-CLR-010, FR-CLT-002
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert `body.ai.colorAnalysis === true`
  3. (True regardless of clothAnalysis value — independent feature)

### TC-A-004 — Capabilities Response Is JSON with Correct Content-Type
- **SRS:** FR-CLR-010
- **Steps:**
  1. `GET /api/capabilities`
  2. Assert HTTP 200
  3. Assert `Content-Type` includes `application/json`

### TC-A-005 — colorMethod Field Present (if available)
- **SRS:** FR-CLR-001
- **Steps:**
  1. `GET /api/capabilities`
  2. If `body.ai.colorMethod` present: Assert value is `'hsv-pixel-average'` or similar
  3. Skip assertion if field not exposed (implementation detail)

---

## 4. Test Group B — Analytics Config (Color Zone Gate)

**Script:** `test/api/color_analysis.test.js`

### TC-B-001 — GET Analytics Config Returns Color Feature State
- **SRS:** FR-CLR-014
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert HTTP 200
  3. Assert color feature state is accessible in response

### TC-B-002 — Color Feature Enabled by Default
- **SRS:** FR-CLR-014
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert color analysis is in enabled state

### TC-B-003 — PUT Analytics Config Disables Color Analysis
- **SRS:** FR-CLR-014
- **Steps:**
  1. `PUT /api/analytics/config` `{ "feature": "color", "enabled": false }` (or equivalent)
  2. Assert HTTP 200, `success === true`
  3. `GET /api/analytics/config` → Assert color disabled
- **Cleanup:** Re-enable color

### TC-B-004 — PUT Analytics Config Re-enables Color Analysis
- **SRS:** FR-CLR-014
- **Steps:**
  1. Disable color
  2. `PUT /api/analytics/config` `{ "feature": "color", "enabled": true }`
  3. Assert HTTP 200
  4. `GET /api/analytics/config` → Assert color enabled

### TC-B-005 — Disabling Color Does Not Disable Cloth
- **SRS:** FR-CLR-014 (independence from cloth feature)
- **Steps:**
  1. `PUT /api/analytics/config` `{ "feature": "color", "enabled": false }`
  2. `GET /api/analytics/config` → Assert cloth feature state unchanged
- **Cleanup:** Re-enable color

### TC-B-006 — Color Config Change Does Not Affect Human Class (classId 0)
- **SRS:** FR-CLR-014
- **Steps:**
  1. Read initial state of classId 0 (person)
  2. `PUT /api/analytics/config` `{ "feature": "color", "enabled": false }`
  3. `GET /api/analytics/config` → Assert classId 0 (person) `enabled === true` unchanged
- **Cleanup:** Re-enable color

---

## 5. Test Group C — HSV Classification Logic Validation

**Note:** These tests exercise the `rgbToColorName()` function directly where possible, or verify its expected outputs through the API layer.

### TC-C-001 — Pure Black Classification
- **SRS:** FR-CLR-002
- **Input:** RGB (5, 5, 5) — very low brightness, low saturation
- **Expected:** `'black'`
- **Method:** Direct function test or verified via documented boundary
- **Boundary:** `v = max(5/255, ...) = 0.02 < 0.25` with `s < 0.15` → black

### TC-C-002 — Pure White Classification
- **SRS:** FR-CLR-002
- **Input:** RGB (250, 250, 252) — near white
- **Expected:** `'white'`
- **Boundary:** `v ≈ 0.99 > 0.80`, `s ≈ 0.01 < 0.15` → white

### TC-C-003 — Gray Classification
- **SRS:** FR-CLR-002
- **Input:** RGB (128, 128, 128) — neutral gray
- **Expected:** `'gray'`
- **Boundary:** `s = 0`, `v = 0.50`, falls between 0.25 and 0.80 → gray

### TC-C-004 — Red Classification (Low Hue)
- **SRS:** FR-CLR-003
- **Input:** RGB (230, 20, 20) — strong red
- **Expected:** `'red'`
- **Boundary:** `h ≈ 0°`, `s > 0.15` → red (h < 15)

### TC-C-005 — Blue Classification
- **SRS:** FR-CLR-003
- **Input:** RGB (20, 80, 230) — strong blue
- **Expected:** `'blue'`
- **Boundary:** `h ≈ 220°` ∈ [195, 260) → blue

### TC-C-006 — Green Classification
- **SRS:** FR-CLR-003
- **Input:** RGB (20, 200, 50) — strong green
- **Expected:** `'green'`
- **Boundary:** `h ≈ 130°` ∈ [75, 150) → green

### TC-C-007 — Brown Classification (Dark Orange)
- **SRS:** FR-CLR-004
- **Input:** RGB (100, 55, 20) — dark brown
- **Expected:** `'brown'`
- **Boundary:** `h ≈ 25°` ∈ [10, 50), `v ≈ 0.39 < 0.55` → brown (exception fires before orange)

### TC-C-008 — Orange Classification (Not Brown — High Brightness)
- **SRS:** FR-CLR-003, FR-CLR-004
- **Input:** RGB (255, 140, 0) — vivid orange
- **Expected:** `'orange'`
- **Boundary:** `h ≈ 33°` ∈ [15, 50), `v ≈ 1.0 ≥ 0.55` → orange (brown exception fails v check)

### TC-C-009 — 11-Color Taxonomy Completeness
- **SRS:** FR-CLR-001
- **Steps:** Verify all 11 valid color names are reachable:
  - black, white, gray, red, orange, yellow, green, cyan, blue, purple, brown
  - Each must be producible from some RGB input

### TC-C-010 — No Color Name Outside Taxonomy
- **SRS:** FR-CLR-001
- **Steps:** For each boundary input tested in TC-C-001 through TC-C-008:
  - Assert returned value is one of the 11 valid color names
  - Assert no 'undefined', null, or unlisted string returned

---

## 6. Test Group D — ROI and API Schema Verification

### TC-D-001 — colorAnalysis in Capabilities Never Changes Without Server Restart
- **SRS:** FR-CLR-010
- **Steps:**
  1. `GET /api/capabilities` × 3
  2. Assert `colorAnalysis === true` in all 3 responses

### TC-D-002 — Color Capability Independent of ONNX Model Presence
- **SRS:** FR-CLR-010
- **Steps:**
  1. `GET /api/capabilities`
  2. Note `clothAnalysis` value (may be false if PAR absent)
  3. Assert `colorAnalysis === true` regardless of `clothAnalysis` value

### TC-D-003 — Analytics Config Contains Color and Cloth as Separate Features
- **SRS:** FR-CLR-014, FR-CLT-017
- **Steps:**
  1. `GET /api/analytics/config`
  2. Assert 'color' and 'cloth' are independently configurable
  3. Disabling one does not disable the other (verified by state check)

---

## 7. Test Group E — Error Handling & Edge Cases

### TC-E-001 — Server Fully Operational Without Any ONNX Model
- **SRS:** FR-CLR-010
- **Steps:**
  1. `GET /health` → Assert 200
  2. `GET /api/capabilities` → Assert 200, `colorAnalysis === true`
  3. `GET /api/analytics/config` → Assert 200
  4. (Color works with zero ONNX models loaded)

### TC-E-002 — PUT Config with Empty Body Returns Error
- **SRS:** FR-CLR-014
- **Steps:**
  1. `PUT /api/analytics/config` with empty body `{}`
  2. Assert HTTP 400 or `success === false` (not 500)

### TC-E-003 — Multiple Sequential GET Config Requests are Consistent
- **SRS:** FR-CLR-014
- **Steps:**
  1. `GET /api/analytics/config` × 5 sequentially
  2. Assert all responses identical
  3. Assert `colorAnalysis` field unchanged across requests

### TC-E-004 — PUT Color Enable=false Does Not Crash Server
- **SRS:** FR-CLR-014
- **Steps:**
  1. `PUT /api/analytics/config` `{ "feature": "color", "enabled": false }`
  2. Assert HTTP 200
  3. `GET /health` → Assert 200 (server still running)
  4. `GET /api/capabilities` → Assert 200
- **Cleanup:** Re-enable color

---

## 8. Test Execution Order

```
Phase 1 — Prerequisite Checks
  TC-A-001  Capabilities accessible
  TC-A-002  colorAnalysis always true
  TC-A-003  colorAnalysis true even when cloth unavailable

Phase 2 — Capabilities Full Validation (Group A)
  TC-A-004, TC-A-005

Phase 3 — Analytics Config Read (Group B read-only)
  TC-B-001, TC-B-002

Phase 4 — Analytics Config Write (Group B mutating)
  TC-B-003 → TC-B-006
  (Each test cleans up before proceeding)

Phase 5 — HSV Classification Verification (Group C)
  TC-C-001 → TC-C-010
  (All read-only boundary tests — no server state change)

Phase 6 — ROI & Schema (Group D)
  TC-D-001 → TC-D-003

Phase 7 — Error Handling (Group E)
  TC-E-001 → TC-E-004
  (TC-E-004 restores color enabled state)
```

---

## 9. Pass/Fail Criteria

### 9.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Capabilities | 100% (5/5) | Yes |
| B — Analytics Config | 100% (6/6) | Yes |
| C — HSV Classification | 100% (10/10) | Yes |
| D — ROI & Schema | 100% (3/3) | Yes |
| E — Error Handling | ≥ 75% (3/4) | Yes |

### 9.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-A-005 (colorMethod field) | Only if API does not expose this field |
| TC-C-001 through TC-C-010 | Unit test environment required for direct function testing |

### 9.3 Failure Response

| Severity | Condition | Action |
|---|---|---|
| Critical | TC-A-002 fails (colorAnalysis false) | Phase-1 color broken; blocking release |
| Critical | TC-A-003 fails | colorAnalysis incorrectly tied to PAR model state |
| High | TC-C-007 fails (brown misclassified) | HSV classification regression |
| High | TC-C-010 fails (invalid color returned) | Taxonomy boundary broken |
| Medium | TC-B-005 fails (cloth affected by color toggle) | Config independence violated |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Color Analysis |
