# TEST CASES (TC)
# Face Match History — Persistence, Camera Name, Timeline Integration

| | |
|---|---|
| **Document ID** | TC-LTS-FMH-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent SRS** | srs/SRS_Face_Match_History.md |
| **Test Scripts** | test/api/face_match_history.test.js |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Match History Endpoint](#3-test-group-a--match-history-endpoint)
4. [Test Group B — Camera Name](#4-test-group-b--camera-name)
5. [Test Execution Order](#5-test-execution-order)
6. [Pass/Fail Criteria](#6-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API | `GET /api/galleries/match-history` | Node.js + fetch | `test/api/` |

### 1.2 SRS Traceability

Every test case references one or more `FR-FMH-NNN` requirement IDs from `SRS_Face_Match_History.md`.

### 1.3 Mode

No flag — `faceMatchHistory` is a common table, this suite runs in all `SERVER_MODE` values, matching `Design_TC_Mode_Execution_Policy.md` §3.2's "common feature → no flag" rule.

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running, reachable at `LTS_URL`.
- `GET /health` returns `{ status: 'ok' }`.

### 2.2 Test Data Strategy

Since triggering a real live camera match is not practical in an API-only test, this suite directly inserts fixture rows and cleans them up — following the same "direct fixture + REST verification" approach already used for tables without a dedicated write endpoint elsewhere in this test suite (there is no `POST /api/galleries/match-history`, by design — matches are only ever written by the AI pipeline). Where direct DB seeding isn't available from the test process, cases soft-skip with a clear reason (matching the `SKIP` pattern in `missing_persons.test.js`).

---

## 3. Test Group A — Match History Endpoint

**Script:** `test/api/face_match_history.test.js`

### TC-FMH-A-001 — Endpoint Returns Success Shape
- **SRS:** FR-FMH-010
- **Steps:**
  1. `GET /api/galleries/match-history`
  2. Assert HTTP 200, `body.success === true`, `Array.isArray(body.data)`

### TC-FMH-A-002 — `limit` Clamping
- **SRS:** FR-FMH-010, FR-FMH-011
- **Steps:**
  1. `GET /api/galleries/match-history?limit=9999`
  2. Assert `body.data.length <= 200`

### TC-FMH-A-003 — `cameraId` Filter
- **SRS:** FR-FMH-011
- **Steps:**
  1. `GET /api/galleries/match-history?cameraId=nonexistent-camera-id`
  2. Assert `body.data.length === 0` (no matches for a camera that doesn't exist)

### TC-FMH-A-004 — `galleryType` Filter Rejects Invalid Values Gracefully
- **SRS:** FR-FMH-011
- **Steps:**
  1. `GET /api/galleries/match-history?galleryType=not-a-real-type`
  2. Assert HTTP 200 (no crash), `body.data.length === 0`

### TC-FMH-A-005 — `from`/`to` Range Filter
- **SRS:** FR-FMH-011
- **Steps:**
  1. `GET /api/galleries/match-history?from=2099-01-01T00:00:00Z`
  2. Assert `body.data.length === 0` (no matches from the far future)

### TC-FMH-A-006 — Sort Order (Newest First)
- **SRS:** FR-FMH-010
- **Steps:**
  1. `GET /api/galleries/match-history?limit=10`
  2. If `body.data.length >= 2`: assert each entry's `timestamp` is `>=` the next entry's `timestamp`
  3. Else: SKIP with reason `'not enough history to verify ordering'`

---

## 4. Test Group B — Camera Name

### TC-FMH-B-001 — `cameraName` Field Present When Available
- **SRS:** FR-FMH-002, AC-03
- **Steps:**
  1. `GET /api/galleries/match-history?limit=50`
  2. If `body.data.length === 0`: SKIP with reason `'no match history available in this environment'`
  3. Else: for each entry with a non-null `cameraName`, assert it's a non-empty string (does not assert every legacy row has it — FR-FMH-002 only applies going forward, per SRS C-02)

---

## 5. Test Execution Order

Group A, then Group B (no interdependency, but A validates the base contract first).

## 6. Pass/Fail Criteria

| Level | Meaning | Action |
|---|---|---|
| FAIL | Endpoint crashes, filters don't narrow correctly, or sort order is wrong | **BLOCK** — must fix |
| SKIP | No history data present in the test environment to assert against | Acceptable — this suite verifies the read contract, not pipeline behavior (that's `SRS_AI_Face_Recognition.md`'s scope) |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — TC for Face Match History |
