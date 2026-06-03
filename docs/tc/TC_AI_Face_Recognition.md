# TEST CASES (TC)
# AI Module — Face Detection & Recognition

| | |
|---|---|
| **Document ID** | TC-LTS-AI-03 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Face_Recognition.md |
| **Test Scripts** | test/api/face_gallery.test.js, test/api/face_enrollment.test.js, test/api/missing_persons.test.js, test/integration/face_pipeline.test.js (Phase-2 planned) |

---

## Table of Contents
1. [Test Strategy](#1-test-strategy)
2. [Test Environment & Prerequisites](#2-test-environment--prerequisites)
3. [Test Group A — Gallery CRUD API](#3-test-group-a--gallery-crud-api)
4. [Test Group B — Face Enrollment API](#4-test-group-b--face-enrollment-api)
5. [Test Group C — Missing Persons Detection](#5-test-group-c--missing-persons-detection)
6. [Test Group D — Live Matching & Socket.IO Events](#6-test-group-d--live-matching--socketio-events)
7. [Test Group E — Cross-Camera Re-ID API](#7-test-group-e--cross-camera-re-id-api)
8. [Test Group F — UI Behaviour](#8-test-group-f--ui-behaviour)
9. [Test Group G — Edge Cases & Error Handling](#9-test-group-g--edge-cases--error-handling)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API (Unit) | Individual REST endpoints | Node.js + node-fetch | `test/api/` |
| Integration | Multi-step flows (enroll + match) | Node.js + test images | `test/integration/` |
| E2E | Full pipeline from camera frame | Manual / Playwright | `test/e2e/` (Phase-3) |

### 1.2 SRS Traceability

Every test case references one or more FR-FAC-NNN requirement IDs from SRS_AI_Face_Recognition.md.

### 1.3 Test Data

| Artifact | Location | Purpose |
|---|---|---|
| `test/fixtures/face_clear.jpg` | 200×200 frontal face photo | Valid enrollment |
| `test/fixtures/face_side.jpg` | Side-angle face photo | Angle-filtered enrollment |
| `test/fixtures/no_face.jpg` | Scene without a face | No-face error case |
| `test/fixtures/multi_face.jpg` | Photo with ≥2 faces | Largest-face selection |
| `test/fixtures/blurry_face.jpg` | Low-sharpness face | Quality filter case |
| `test/fixtures/large_file.bin` | 11 MB binary file | File size limit test |

---

## 2. Test Environment & Prerequisites

### 2.1 Server State

- Server running on `http://localhost:3080`
- `server/models/scrfd_2.5g.onnx` and `server/models/arcface_w600k_r50.onnx` present
- `GET /health` returns `{ status: 'ok' }`
- `GET /api/capabilities` returns `{ ai: { face: true } }`

### 2.2 Clean State

- Each test group starts with no galleries (`GET /api/galleries` → `data: []`)
- Test setup deletes all galleries created during the previous run

### 2.3 Dependencies

```
node >= 18
npm packages: node-fetch, form-data (or native FormData in Node 18+)
```

---

## 3. Test Group A — Gallery CRUD API

**Script:** `test/api/face_gallery.test.js`

### TC-A-001 — Create Gallery (general type, default)
- **SRS:** FR-FAC-002, FR-FAC-004
- **Steps:**
  1. `POST /api/galleries` body `{ name: 'Test Gallery' }`
  2. Assert HTTP 201
  3. Assert `data.type === 'general'`
  4. Assert `data.faceCount === 0`
  5. Assert `data.id` is a valid UUID
- **Cleanup:** DELETE created gallery

### TC-A-002 — Create Gallery (missing type)
- **SRS:** FR-FAC-002, FR-FAC-030
- **Steps:**
  1. `POST /api/galleries` body `{ name: 'Missing Test', type: 'missing' }`
  2. Assert HTTP 201
  3. Assert `data.type === 'missing'`
- **Cleanup:** DELETE created gallery

### TC-A-003 — Create Gallery (vip type)
- **SRS:** FR-FAC-002
- **Steps:** Same as TC-A-002 with `type: 'vip'`

### TC-A-004 — Create Gallery (blocklist type)
- **SRS:** FR-FAC-002
- **Steps:** Same as TC-A-002 with `type: 'blocklist'`

### TC-A-005 — Create Gallery — Invalid Type Defaults to General
- **SRS:** FR-FAC-002, FR-FAC-004
- **Steps:**
  1. `POST /api/galleries` body `{ name: 'Test', type: 'vvip' }`
  2. Assert HTTP 201
  3. Assert `data.type === 'general'`  ← silently defaulted

### TC-A-006 — Create Gallery — Missing Name → 400
- **SRS:** FR-FAC-002
- **Steps:**
  1. `POST /api/galleries` body `{ description: 'no name' }`
  2. Assert HTTP 400
  3. Assert `success === false`
  4. Assert `error === 'name is required'`

### TC-A-007 — Create Gallery — Empty Name → 400
- **SRS:** FR-FAC-002
- **Steps:**
  1. `POST /api/galleries` body `{ name: '   ' }` (whitespace only)
  2. Assert HTTP 400

### TC-A-008 — List Galleries — Empty
- **SRS:** FR-FAC-001
- **Steps:**
  1. `GET /api/galleries`
  2. Assert HTTP 200
  3. Assert `data` is an array
  4. Assert `data.length === 0` (clean state)

### TC-A-009 — List Galleries — Returns All Types
- **SRS:** FR-FAC-001, FR-FAC-004
- **Steps:**
  1. Create 4 galleries: general, vip, blocklist, missing
  2. `GET /api/galleries`
  3. Assert `data.length === 4`
  4. Assert each `data[i].type` is correct
  5. Assert `data[i].faceCount === 0` for all
- **Cleanup:** DELETE all 4 galleries

### TC-A-010 — List Galleries — Sorted by createdAt DESC
- **SRS:** FR-FAC-001
- **Steps:**
  1. Create gallery A, wait 100 ms, create gallery B
  2. `GET /api/galleries`
  3. Assert `data[0].name === 'B'` (newest first)
- **Cleanup:** DELETE both

### TC-A-011 — Delete Gallery → 200
- **SRS:** FR-FAC-003
- **Steps:**
  1. Create gallery
  2. `DELETE /api/galleries/:id`
  3. Assert HTTP 200, `success === true`
  4. `GET /api/galleries` → Assert gallery is gone

### TC-A-012 — Delete Gallery — Cascade Deletes Faces
- **SRS:** FR-FAC-003
- **Steps:**
  1. Create gallery, enroll 1 face
  2. `DELETE /api/galleries/:id`
  3. Assert HTTP 200
  4. (Internal verification) DB should have 0 faceGalleryFaces for that galleryId

### TC-A-013 — Delete Gallery — Not Found → 404
- **SRS:** FR-FAC-003
- **Steps:**
  1. `DELETE /api/galleries/00000000-0000-0000-0000-000000000000`
  2. Assert HTTP 404

---

## 4. Test Group B — Face Enrollment API

**Script:** `test/api/face_enrollment.test.js`

### TC-B-001 — Enroll Face — Success
- **SRS:** FR-FAC-010 through FR-FAC-014
- **Steps:**
  1. Create gallery
  2. `POST /api/galleries/:id/faces` multipart: `photo=face_clear.jpg`, `name=Kim Minsu`
  3. Assert HTTP 201
  4. Assert `data.name === 'Kim Minsu'`
  5. Assert `data.thumbnail` starts with `data:image/jpeg;base64,`
  6. Assert `data.embedding === undefined` (not exposed)
  7. Assert `data.id` is UUID
  8. `GET /api/galleries` → gallery `faceCount === 1`
- **Cleanup:** DELETE gallery

### TC-B-002 — Enroll Face — Default Name 'Unknown'
- **SRS:** FR-FAC-014
- **Steps:**
  1. Enroll with `photo=face_clear.jpg`, no `name` field
  2. Assert `data.name === 'Unknown'`
- **Cleanup:** DELETE gallery

### TC-B-003 — Enroll Face — Gallery Not Found → 404
- **SRS:** FR-FAC-010
- **Steps:**
  1. `POST /api/galleries/nonexistent-id/faces` with valid photo
  2. Assert HTTP 404

### TC-B-004 — Enroll Face — No Photo Field → 400
- **SRS:** FR-FAC-010
- **Steps:**
  1. `POST /api/galleries/:id/faces` with no file field
  2. Assert HTTP 400
  3. Assert `error === 'photo field is required'`

### TC-B-005 — Enroll Face — No Face in Photo → 422
- **SRS:** FR-FAC-011
- **Steps:**
  1. `POST /api/galleries/:id/faces` with `photo=no_face.jpg`
  2. Assert HTTP 422
  3. Assert `error` contains 'No face detected'

### TC-B-006 — Enroll Face — File Too Large → 400
- **SRS:** FR-FAC-010
- **Steps:**
  1. `POST /api/galleries/:id/faces` with `large_file.bin` (11 MB)
  2. Assert HTTP 400 or 413

### TC-B-007 — Enroll Face — Multi-Face Photo → Largest Selected
- **SRS:** FR-FAC-011
- **Steps:**
  1. `POST /api/galleries/:id/faces` with `photo=multi_face.jpg`
  2. Assert HTTP 201 (no error — one face selected)
  3. Assert `data.bbox.width > 0`
- **Cleanup:** DELETE gallery

### TC-B-008 — List Faces — Returns Enrolled Faces
- **SRS:** FR-FAC-016
- **Steps:**
  1. Create gallery, enroll 2 faces
  2. `GET /api/galleries/:id/faces`
  3. Assert `data.length === 2`
  4. For each: Assert `embedding === undefined`
  5. Assert sorted by `createdAt` DESC

### TC-B-009 — List Faces — Gallery Not Found → 404
- **SRS:** FR-FAC-016
- **Steps:**
  1. `GET /api/galleries/nonexistent/faces`
  2. Assert HTTP 404

### TC-B-010 — Delete Face → 200
- **SRS:** FR-FAC-017
- **Steps:**
  1. Create gallery, enroll face (get faceId from response)
  2. `DELETE /api/galleries/:galleryId/faces/:faceId`
  3. Assert HTTP 200
  4. `GET /api/galleries/:id/faces` → Assert `data.length === 0`
  5. `GET /api/galleries` → Assert gallery `faceCount === 0`

### TC-B-011 — Delete Face — Not Found → 404
- **SRS:** FR-FAC-017
- **Steps:**
  1. `DELETE /api/galleries/:id/faces/00000000-0000-0000-0000-000000000000`
  2. Assert HTTP 404

### TC-B-012 — Delete Face — Wrong Gallery → 404
- **SRS:** FR-FAC-017
- **Steps:**
  1. Create gallery A and gallery B; enroll face in A
  2. `DELETE /api/galleries/{galleryB.id}/faces/{faceA.id}` (mismatched)
  3. Assert HTTP 404

---

## 5. Test Group C — Missing Persons Detection

**Script:** `test/api/missing_persons.test.js`

### TC-C-001 — Create Missing Gallery — Type Stored Correctly
- **SRS:** FR-FAC-030
- **Steps:**
  1. `POST /api/galleries` `{ name: 'Missing Test', type: 'missing' }`
  2. `GET /api/galleries` → find created gallery
  3. Assert `gallery.type === 'missing'`

### TC-C-002 — Enroll Face in Missing Gallery
- **SRS:** FR-FAC-030, FR-FAC-014
- **Steps:**
  1. Create missing gallery
  2. Enroll face
  3. Assert HTTP 201
  4. `GET /api/galleries/:id/faces` → Assert `data.length === 1`

### TC-C-003 — missing_person_match Event Emitted on Match
- **SRS:** FR-FAC-031
- **Steps:**
  1. Connect Socket.IO client to server
  2. Register listener for `missing_person_match`
  3. Create missing gallery, enroll reference face
  4. Simulate camera frame containing the enrolled face (integration test)
  5. Assert `missing_person_match` event received within 5 s
  6. Assert event payload: `galleryType === 'missing'`, `identity === enrolled name`

### TC-C-004 — face_match Also Emitted for Missing Gallery
- **SRS:** FR-FAC-033
- **Steps:**
  1. As TC-C-003 but also register `face_match` listener
  2. Assert both `face_match` and `missing_person_match` received
  3. Assert both have identical payloads

### TC-C-005 — face_match Only (vip) — No missing_person_match
- **SRS:** FR-FAC-033
- **Steps:**
  1. Create vip gallery, enroll reference face
  2. Simulate camera frame with enrolled face
  3. Assert `face_match` received with `galleryType === 'vip'`
  4. Assert `missing_person_match` NOT received within 2 s

### TC-C-006 — face_match galleryType Field Correct Per Type
- **SRS:** FR-FAC-021
- **Steps:**
  1. Create 4 galleries (one per type), enroll same-person photo in each
  2. Simulate camera frames
  3. Collect `face_match` events
  4. Assert each event's `galleryType` matches the enrolled gallery type

### TC-C-007 — 30-Second Cooldown — No Duplicate Events
- **SRS:** FR-FAC-031, FR-FAC-021
- **Steps:**
  1. Create missing gallery, enroll face
  2. Simulate frame match event → collect `missing_person_match` (event 1)
  3. Simulate another frame match within 5 s → Assert NO second event emitted
  4. (Long-running variant): Wait 31 s → simulate match → Assert second event emitted
- **Note:** TC-C-007b (wait 31 s) is a long-running test; skip in CI

---

## 6. Test Group D — Live Matching & Socket.IO Events

**Script:** `test/integration/face_pipeline.test.js`

### TC-D-001 — face_match Event Payload Schema
- **SRS:** FR-FAC-021
- **Steps:**
  1. Receive `face_match` event (from TC-C-003 setup)
  2. Assert payload has fields: `faceId`, `cameraId`, `identity`, `galleryId`, `galleryType`, `matchScore`, `thumbnail`, `timestamp`
  3. Assert `matchScore` is number in range [0.35, 1.0]
  4. Assert `thumbnail` starts with `data:image/jpeg;base64,`
  5. Assert `timestamp` is Unix ms (> 1700000000000)

### TC-D-002 — Persistent Gallery Reloaded After Enroll
- **SRS:** FR-FAC-014, FR-FAC-020
- **Steps:**
  1. Before enrollment: note no match events
  2. Enroll face → `reloadPersistentGallery()` called
  3. Simulate camera frame → Assert match event received
  4. (Confirms _persistentGallery is updated without server restart)

### TC-D-003 — Persistent Gallery Reloaded After Delete
- **SRS:** FR-FAC-017, FR-FAC-020
- **Steps:**
  1. Enroll face, confirm match event received
  2. DELETE face → `reloadPersistentGallery()` called
  3. Simulate camera frame → Assert NO match event within 3 s

---

## 7. Test Group E — Cross-Camera Re-ID API

**Script:** `test/api/face_gallery.test.js` (appended)

### TC-E-001 — Cross-Camera Stats Endpoint
- **SRS:** FR-FAC-043
- **Steps:**
  1. `GET /api/faces/cross-camera-stats`
  2. Assert HTTP 200
  3. Assert `success === true`
  4. Assert `data` is an array

### TC-E-002 — Trajectories Endpoint
- **SRS:** FR-FAC-043
- **Steps:**
  1. `GET /api/faces/trajectories`
  2. Assert HTTP 200
  3. Assert `success === true`
  4. Assert `data` is an array

### TC-E-003 — Trajectories maxAgeMs Parameter
- **SRS:** FR-FAC-043
- **Steps:**
  1. `GET /api/faces/trajectories?maxAgeMs=60000`
  2. Assert HTTP 200
  3. Assert all returned persons have `lastSeenAt > Date.now() - 60000`

---

## 8. Test Group F — UI Behaviour

**Type:** Manual / Playwright (Phase-3 automation)

### TC-F-001 — Gallery Type Selector Dropdown
- **SRS:** FR-FAC-051
- **Steps:**
  1. Navigate to Face ID tab
  2. Click type selector button (default icon 🗃)
  3. Assert dropdown shows 4 options: 🔍 Missing Persons, ⭐ VIP, 🚫 Blocklist, 🗃 General
  4. Select 🔍 Missing Persons → button icon changes to 🔍

### TC-F-002 — Gallery List Ordering
- **SRS:** FR-FAC-052
- **Steps:**
  1. Create galleries in order: general, missing, vip
  2. Assert gallery list renders: missing section → vip section → general section

### TC-F-003 — Missing Person Alert Banner
- **SRS:** FR-FAC-053
- **Steps:**
  1. Emit `missing_person_match` via Socket.IO test client
  2. Assert red flashing banner appears at top of Face ID tab within 1 s
  3. Assert banner shows identity name and camera ID

### TC-F-004 — Missing Count Badge
- **SRS:** FR-FAC-053
- **Steps:**
  1. Create missing gallery, enroll 2 faces
  2. Navigate to Face ID tab
  3. Assert 🔍 2 badge appears in tab header with `animate-pulse` class

### TC-F-005 — Live Matches Type Styling
- **SRS:** FR-FAC-056
- **Steps:**
  1. Receive `face_match` events for each gallery type
  2. Assert 🚨 icon for missing (red background)
  3. Assert ⭐ icon for vip (yellow background)
  4. Assert 🚫 icon for blocklist (orange background)
  5. Assert ⚡ icon for general (gray background)

### TC-F-006 — Face Enrollment UI Flow
- **SRS:** FR-FAC-054, FR-FAC-055
- **Steps:**
  1. Select gallery
  2. Drag a photo into upload zone → Preview appears
  3. Enter name → Click Enroll
  4. Assert face card appears in grid with thumbnail and name
  5. Hover card → ✕ button visible
  6. Click ✕ → Card removed from grid

### TC-F-007 — i18n — Korean Language
- **SRS:** FR-FAC-057
- **Steps:**
  1. Switch to Korean language
  2. Assert tab label = 'Face Recognition'
  3. Assert gallery type labels = 'Missing', 'VIP', 'Blocklist', 'General'
  4. Assert alert banner text = 'Missing person detected'

---

## 9. Test Group G — Edge Cases & Error Handling

**Script:** `test/api/face_enrollment.test.js` (error section)

### TC-G-001 — FaceService Not Ready → 503
- **SRS:** FR-FAC-015
- **Condition:** Models not yet loaded (startup race)
- **Steps:**
  1. (In test: temporarily override getFaceService to return null)
  2. `POST /api/galleries/:id/faces` with valid photo
  3. Assert HTTP 503
  4. Assert `error === 'Face service not available — models not loaded'`
- **Note:** Cannot easily trigger in production since models load eagerly; test via mock

### TC-G-002 — Unsupported MIME Type → 400
- **SRS:** FR-FAC-010
- **Steps:**
  1. `POST /api/galleries/:id/faces` with `photo=test.pdf`
  2. Assert HTTP 400 (multer rejects non-image types)

### TC-G-003 — Enroll to Deleted Gallery → 404
- **SRS:** FR-FAC-010
- **Steps:**
  1. Create gallery, note ID
  2. Delete gallery
  3. `POST /api/galleries/:id/faces` with valid photo
  4. Assert HTTP 404

### TC-G-004 — Server Restart — Persistent Gallery Reloaded
- **SRS:** FR-FAC-014 (persistence), startup sequence
- **Steps:**
  1. Enroll face in gallery
  2. Restart server
  3. `GET /api/galleries/:id/faces` → Assert face still present
  4. Confirm face is in `_persistentGallery` (visible via match test)

### TC-G-005 — Concurrent Enrollments — No Race Condition
- **SRS:** FR-FAC-014
- **Steps:**
  1. Send 5 simultaneous `POST /api/galleries/:id/faces` requests
  2. Assert all return 201 (or appropriate error, no 500)
  3. `GET /api/galleries/:id/faces` → Assert count matches successful enrollments

### TC-G-006 — Delete Gallery While Matching In Progress
- **SRS:** FR-FAC-032
- **Steps:**
  1. Enroll face in missing gallery
  2. Delete gallery
  3. Simulate camera frame that would have matched
  4. Assert no unhandled exception in server log
  5. Assert if `face_match` emitted, `galleryType` defaults to `'general'`

---

## 10. Test Execution Order

Execute test groups in the following order to ensure clean state and dependency satisfaction:

```
Phase 1 — Prerequisite Checks
  TC-ENV-001  Server health check (GET /health → 200)
  TC-ENV-002  Face capability check (GET /api/capabilities → face: true)
  TC-ENV-003  Clean state check (GET /api/galleries → data: [])

Phase 2 — Gallery CRUD (Group A)
  TC-A-001 through TC-A-013

Phase 3 — Face Enrollment (Group B)
  TC-B-001 through TC-B-012
  Prerequisite: Group A must pass (gallery creation works)

Phase 4 — Missing Persons (Group C)
  TC-C-001 through TC-C-006
  Prerequisite: Group B must pass (enrollment works)
  TC-C-007 (cooldown test) — optional, long-running

Phase 5 — Live Matching Integration (Group D)
  TC-D-001 through TC-D-003
  Prerequisite: Groups B, C must pass

Phase 6 — Cross-Camera Stats API (Group E)
  TC-E-001 through TC-E-003
  (independent of Groups B–D)

Phase 7 — Edge Cases (Group G)
  TC-G-001 through TC-G-006

Phase 8 — UI Tests (Group F)
  Manual or Playwright — run last, after all API tests pass
```

---

## 11. Pass/Fail Criteria

### 11.1 Release Criteria

| Group | Required Pass Rate | Blocking |
|---|---|---|
| A — Gallery CRUD | 100% (13/13) | Yes |
| B — Face Enrollment | 100% (12/12) | Yes |
| C — Missing Persons | 100% (6/6 + optional TC-C-007) | Yes |
| D — Live Matching | 100% (3/3) | Yes |
| E — Cross-Camera API | 100% (3/3) | Yes |
| G — Edge Cases | ≥ 80% (5/6) | Yes |
| F — UI Behaviour | ≥ 70% (5/7) | No (Phase-3) |

### 11.2 Known Skip Conditions

| Test | Skip Condition |
|---|---|
| TC-C-007b (31 s cooldown) | CI pipeline with time limit |
| TC-G-001 (503 mock) | Without test framework mocking support |
| Group F (Playwright) | No headless browser available |

### 11.3 Failure Response

| Severity | Condition | Action |
|---|---|---|
| Critical | Any Group A or B failure | Block release; fix before merge |
| High | Any Group C or D failure | Block release; fix before merge |
| Medium | Group G ≥ 2 failures | Investigate; may block depending on nature |
| Low | Group F failures | Log as issue; schedule for Phase-3 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for AI Face Recognition |
