# TEST CASES (TC)
# Face Search Condition Sync — Streaming ↔ Analysis

| | |
|---|---|
| **Document ID** | TC-LTS-FSC-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent SRS** | srs/SRS_Face_Search_Condition_Sync.md |
| **Test Scripts** | test/api/face_search_condition_sync.test.js |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Enrollment Delegation](#3-test-group-a--enrollment-delegation)
4. [Test Group B — Condition Mirror Push/Poll](#4-test-group-b--condition-mirror-pushpoll)
5. [Test Group C — Dashboard Metrics](#5-test-group-c--dashboard-metrics)
6. [Test Execution Order](#6-test-execution-order)
7. [Pass/Fail Criteria](#7-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API | `/api/analysis/face-embed`, `/face-search-conditions`, `/face-search-conditions/sync`, `/metrics` | Node.js + fetch | `test/api/` |

### 1.2 SRS Traceability

Every test case references one or more `FR-FSC-NNN` requirement IDs from `SRS_Face_Search_Condition_Sync.md`.

### 1.3 Dual-Server Requirement

This suite requires a genuinely running `analysis`-mode server reachable at `process.env.ANALYSIS_SERVER_URL` (inherited from the streaming server process the TC runner spawns against). If unset, or the analysis server's `/api/analysis/health` is unreachable, every case in Groups B and C **soft-skips** rather than failing — this mirrors the graceful-degradation pattern already used in `test/api/missing_persons.test.js` for optional dependencies.

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Streaming server running with `SERVER_MODE=streaming` and a valid `ANALYSIS_SERVER_URL`.
- A live `analysis`-mode server reachable at that URL, with `scrfd_2.5g.onnx`/`arcface_w600k_r50.onnx` loaded.

### 2.2 Clean State

- Test setup creates its own gallery/face fixtures and deletes them in `cleanupAll()`, following the `test/api/missing_persons.test.js` pattern.

### 2.3 Dependencies

```
node >= 18
test/fixtures/face_clear.jpg  (existing fixture, reused)
```

---

## 3. Test Group A — Enrollment Delegation

**Script:** `test/api/face_search_condition_sync.test.js`

### TC-FSC-A-001 — Delegated Enrollment Succeeds
- **SRS:** FR-FSC-001, FR-FSC-002, FR-FSC-003
- **Steps:**
  1. Create a gallery on the streaming server under test
  2. `POST /api/galleries/:id/faces` with `photo=face_clear.jpg`
  3. Assert HTTP 201 (not 503) — passes whether the server under test is `combined`/`analysis` (local path) or `streaming` with a live analysis server (delegated path)
  4. Assert `data.embedding === undefined` (never exposed)
- **Cleanup:** DELETE gallery

### TC-FSC-A-002 — `/api/analysis/face-embed` Direct Contract
- **SRS:** FR-FSC-002
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unset → SKIP
  2. `POST {ANALYSIS_SERVER_URL}/api/analysis/face-embed` with raw `face_clear.jpg` body, `Content-Type: image/jpeg`
  3. Assert HTTP 200, `body.success === true`
  4. Assert `body.embedding.length === 512`
  5. Assert `body.thumbnail` starts with `data:image/jpeg;base64,`

### TC-FSC-A-003 — `/face-embed` No-Face Error Parity
- **SRS:** FR-FSC-002
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unset → SKIP
  2. `POST {ANALYSIS_SERVER_URL}/api/analysis/face-embed` with `no_face.jpg`
  3. Assert HTTP 422, `error` contains `'No face detected'`

---

## 4. Test Group B — Condition Mirror Push/Poll

### TC-FSC-B-001 — Push Propagation
- **SRS:** FR-FSC-011, FR-FSC-013, FR-FSC-014
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unreachable → SKIP
  2. Create gallery (type `vip`) + enroll a face on the streaming server under test
  3. Poll `GET {ANALYSIS_SERVER_URL}/api/analysis/face-search-conditions` for up to 6s
  4. Assert the enrolled face's `id` appears with `galleryType === 'vip'`
- **Cleanup:** DELETE gallery (streaming side) — assert the analysis-side mirror also removes it within 6s (push-on-delete)

### TC-FSC-B-002 — No Embedding Over the Wire
- **SRS:** FR-FSC-013
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unreachable → SKIP
  2. Repeat enrollment from TC-FSC-B-001
  3. `GET {ANALYSIS_SERVER_URL}/api/analysis/face-search-conditions`
  4. Assert no entry in `faces[]` contains an `embedding` field

### TC-FSC-B-003 — Poll Self-Heal
- **SRS:** FR-FSC-012, FR-FSC-032
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unreachable → SKIP
  2. Enroll a face, confirm it is mirrored (as TC-FSC-B-001)
  3. Directly delete the mirrored row on the analysis server (bypassing the sync endpoint) if a test-only deletion path is available; otherwise SKIP with reason `'no direct DB access from test process'`
  4. Wait 6s (one poll cycle)
  5. Assert the row is restored by the next `pushReconcile()` interval tick

### TC-FSC-B-004 — Local Rows Never Deleted by Reconcile
- **SRS:** FR-FSC-010, FR-FSC-014, AC-06
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unreachable → SKIP
  2. Directly create a gallery + face on the analysis server's own `/api/galleries` (source `'local'`)
  3. Trigger a reconcile from the streaming side (any mutation)
  4. Assert the locally-added gallery/face on the analysis server still exists afterward
- **Cleanup:** DELETE the locally-added gallery on the analysis server

### TC-FSC-B-005 — Analysis-Registered Condition Pulled Back to Streaming (Bidirectional)
- **SRS:** FR-FSC-013, FR-FSC-014
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unreachable → SKIP
  2. Register a gallery + face directly on the analysis server (same flow as `FaceSearchConditionPanel`'s add-condition form)
  3. Trigger a reconcile round trip from the streaming side and wait up to one poll interval
  4. Assert `GET /api/galleries` on the **streaming** server includes the analysis-registered gallery
- **Cleanup:** DELETE the gallery on the analysis server (its origin)

---

## 5. Test Group C — Dashboard Metrics

### TC-FSC-C-001 — `faceSearch` Field in `/metrics`
- **SRS:** FR-FSC-016
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unreachable → SKIP
  2. `GET {ANALYSIS_SERVER_URL}/api/analysis/metrics`
  3. Assert `body.faceSearch` is an object with `total` (number) and `byType` (object with `missing`/`vip`/`blocklist`/`general` numeric keys)

### TC-FSC-C-002 — Count Matches Detail List
- **SRS:** FR-FSC-015, FR-FSC-016
- **Steps:**
  1. If `ANALYSIS_SERVER_URL` unreachable → SKIP
  2. `GET {ANALYSIS_SERVER_URL}/api/analysis/face-search-conditions` and `GET {ANALYSIS_SERVER_URL}/api/analysis/metrics` in quick succession
  3. Assert `conditions.total === metrics.faceSearch.total`

---

## 6. Test Execution Order

1. Group A (works regardless of a second server being present)
2. Group B (requires the analysis server)
3. Group C (requires the analysis server)

## 7. Pass/Fail Criteria

| Level | Meaning | Action |
|---|---|---|
| FAIL | Enrollment delegation broken, or a `synced` mirror row incorrectly overwrites/deletes a `local` row | **BLOCK** — must fix |
| SKIP | `ANALYSIS_SERVER_URL` unset or analysis server unreachable | Acceptable in single-server (`combined`) CI runs; not acceptable in a genuine streaming+analysis staging run |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — TC for Face Search Condition Sync |
| 1.1 | 2026-07-08 | LTS Engineering Team | Added TC-FSC-B-005 — verifies a condition registered directly on the analysis server is pulled back to the streaming server (bidirectional sync fix) |
