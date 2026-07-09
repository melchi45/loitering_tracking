# TEST CASES (TC)
# AI Module — Color Analysis

| | |
|---|---|
| **Document ID** | TC-LTS-AI-05 |
| **Version** | 1.3 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Color_Analysis.md |
| **Test Scripts** | test/api/ai_detection_modules.test.js (Groups A, B, D) — Group F is Planned, no script yet |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Capabilities (Color Always Available)](#3-test-group-a--capabilities-color-always-available)
4. [Test Group B — Analytics Config (Color Zone Gate)](#4-test-group-b--analytics-config-color-zone-gate)
5. [Test Group C — HSV Classification Logic Validation](#5-test-group-c--hsv-classification-logic-validation)
6. [Test Group D — ROI and API Schema Verification](#6-test-group-d--roi-and-api-schema-verification)
7. [Test Group E — Error Handling & Edge Cases](#7-test-group-e--error-handling--edge-cases)
8. [Test Group F — Phase-3 Human Parsing (Planned)](#8-test-group-f--phase-3-human-parsing-planned)
9. [Test Group G — Phase-1.5 K-Means Dominant Color (Planned)](#9-test-group-g--phase-15-k-means-dominant-color-planned)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

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

- Server running on `http://localhost:3080`
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

## 8. Test Group F — Phase-3 Human Parsing (Planned)

> **Status: Planned — not yet implemented.** No runnable test script exists for this group; it is recorded here as a specification for future implementation, derived from gap analysis against the CCTV/IPTV 상의하의 색상분류 guide (now-consolidated, original deleted 2026-07-09) and `docs/rfp/ReID_및_색상분석_활용가이드.md` (2026-07-09). These test IDs are **not** registered in `test/tc_runner_cli.js` / `server/src/services/TcRunnerService.js` — doing so before the corresponding code exists would violate this project's TDD convention (registering a suite against a nonexistent test file).

### TC-F-001 (Planned) — humanParsing Toggle Round-Trips via Analytics Config
- **SRS:** FR-CLR-022
- **Steps:** `PUT /api/analytics/config` with `humanParsing: true`, then `GET` → assert persisted; repeat with `false`

### TC-F-002 (Planned) — Model Catalog Lists Human Parsing Family Entries
- **SRS:** FR-CLR-023
- **Steps:** `GET /api/analysis/models` → assert entries with `family: 'human-parsing'` (SCHP, SegFormer) are present with `classMap` metadata

### TC-F-003 (Planned) — Only One Human Parsing Model Active at a Time
- **SRS:** FR-CLR-023
- **Steps:** Activate SCHP entry, then activate SegFormer entry → assert SCHP is no longer marked `active`

### TC-F-004 (Planned) — Throttled Execution Does Not Re-run Model Within Interval
- **SRS:** FR-CLR-024
- **Steps:** Trigger enrichment twice for the same `objectId` within `HP_INTERVAL_MS` → assert second call returns cached `color` object (same reference/timestamp), model not invoked twice

### TC-F-005 (Planned) — Cache Entry Removed on Track Drop
- **SRS:** FR-CLR-024
- **Steps:** Force a track to expire (age out) → assert `dropTrack(objectId)` removes the corresponding cache entry (verified indirectly: next detection of a new track reusing an old ID does not inherit stale cached color)

### TC-F-006 (Planned) — Fallback to Phase-1 When Mask Pixel Count Below Threshold
- **SRS:** FR-CLR-025
- **Steps:** Supply a person crop where the parsed mask yields < 20 pixels for a region → assert that region's color falls back to the Phase-1 fixed-fraction average rather than an unreliable K-Means result

### TC-F-007 (Planned) — Output Schema Carries `source` Field
- **SRS:** FR-CLR-026
- **Steps:** With `humanParsing` enabled and model active, assert `color.source === 'human-parsing'`; with it disabled, assert `source` is absent or `'legacy'`

### TC-F-008 (Planned) — Graceful Degrade When Model File Absent
- **SRS:** FR-CLR-022, C-08
- **Steps:** With `humanParsing: true` but no model file on disk → assert Phase-1 color output is still produced (no crash, no missing `color` field) and `GET /api/capabilities` reports the model as not loaded

---

## 9. Test Group G — Phase-1.5 K-Means Dominant Color (Planned)

> **Status: Planned — not yet implemented.** No runnable test script exists for this group. Recorded per gap analysis against `docs/rfp/CCTV_IPTV_상의하의_색상분류_가이드.md` §4 (2026-07-09). See `docs/design/Design_AI_Color_Analysis.md` §11, `docs/srs/SRS_AI_Color_Analysis.md` §12 (FR-CLR-028~029). Not registered in `test/tc_runner_cli.js` / `TcRunnerService.js` — same TDD-convention reason as Group F.

### TC-G-001 (Planned) — K-Means Reduction Produces Same Schema as Plain Mean
- **SRS:** FR-CLR-028
- **Steps:** Call the Phase-1.5 reduction path on a synthetic ROI pixel set → assert return shape is still `{upper, lower, upperRgb, lowerRgb}` (FR-CLR-009 unchanged)

### TC-G-002 (Planned) — K-Means Output Differs from Plain Mean on a Bimodal ROI
- **SRS:** FR-CLR-028
- **Steps:** Construct an ROI pixel set with two distinct color clusters of unequal size (e.g. 80% red-ish, 20% blue-ish, mirroring `kmeansColor.test.js`'s existing bimodal fixture) → assert the K-Means result is closer to the majority cluster's centroid than the plain mean would be

### TC-G-003 (Planned) — Fallback to Plain Mean Below Minimum Pixel Count
- **SRS:** FR-CLR-029
- **Steps:** Supply an ROI patch small enough that the resized pixel count falls below `dominantColor()`'s 20-pixel floor → assert the region's color falls back to the existing plain-mean result rather than `null`/error

### TC-G-004 (Planned) — ROI Geometry Unchanged
- **SRS:** FR-CLR-028
- **Steps:** Assert the upper/lower ROI rectangles computed for a given bbox are identical to the FR-CLR-005/FR-CLR-006 formulas before and after the Phase-1.5 change (only the reduction step differs)

### TC-G-005 (Planned) — No New Analytics Config Toggle
- **SRS:** FR-CLR-028
- **Steps:** `GET /api/analytics/config` → assert no new `color`-related key was added for this change (Phase-1.5 is not gated separately from the existing always-on `color` feature)

---

## 10. Test Execution Order

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

Phase 8 — Phase-3 Human Parsing (Group F, Planned — not yet executable)
  TC-F-001 → TC-F-008

Phase 9 — Phase-1.5 K-Means Dominant Color (Group G, Planned — not yet executable)
  TC-G-001 → TC-G-005
```

---

## 11. Pass/Fail Criteria

### 11.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Capabilities | 100% (5/5) | Yes |
| B — Analytics Config | 100% (6/6) | Yes |
| C — HSV Classification | 100% (10/10) | Yes |
| D — ROI & Schema | 100% (3/3) | Yes |
| E — Error Handling | ≥ 75% (3/4) | Yes |
| F — Phase-3 Human Parsing | N/A (planned, no test script yet) | No |
| G — Phase-1.5 K-Means Dominant Color | N/A (planned, no test script yet) | No |

### 11.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-A-005 (colorMethod field) | Only if API does not expose this field |
| TC-C-001 through TC-C-010 | Unit test environment required for direct function testing |

### 11.3 Failure Response

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
| 1.1 | 2026-07-09 | Youngho Kim | Added Test Group F (Phase-3 Human Parsing, Planned) — TC-F-001~008, not yet registered in runnable SUITES |
| 1.2 | 2026-07-09 | Youngho Kim | Added Test Group G (Phase-1.5 K-Means Dominant Color, Planned) — TC-G-001~005, not yet registered in runnable SUITES; renumbered §9/§10 → §10/§11 |
| 1.3 | 2026-07-09 | Youngho Kim | Source guide `docs/rfp/CCTV_IPTV_상의하의_색상분류_가이드.md` deleted — full content confirmed reflected in Groups F–G, in-doc citation updated to archival note |
