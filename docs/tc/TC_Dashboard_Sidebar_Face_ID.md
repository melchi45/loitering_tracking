# TEST CASES (TC)
# Dashboard Sidebar — Face ID Panel

| | |
|---|---|
| **Document ID** | TC-LTS-UI-FACE-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Dashboard_Sidebar_Face_ID.md (v1.1) |
| **Test Scripts** | test/api/face_gallery.test.js, test/api/face_enrollment.test.js, test/api/missing_persons.test.js, test/api/face_match_history.test.js (planned) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Gallery Management](#3-test-group-a--gallery-management)
4. [Test Group B — Face Enrollment](#4-test-group-b--face-enrollment)
5. [Test Group C — Match Log & Socket.IO](#5-test-group-c--match-log--socketio)
6. [Test Group D — Missing Person Alert](#6-test-group-d--missing-person-alert)
7. [Test Group E — Data Persistence](#7-test-group-e--data-persistence)
8. [Test Group F — Gallery Type System](#8-test-group-f--gallery-type-system)
9. [Test Group G — Edge Cases](#9-test-group-g--edge-cases)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)
12. [Test Group H — Live Match Crop (v1.1)](#12-test-group-h--live-match-crop-v11)
13. [Test Group I — Face Match History Search (v1.1)](#13-test-group-i--face-match-history-search-v11)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| API (REST) | Gallery CRUD, face enrollment, delete | Node.js fetch | `test/api/face_gallery.test.js` |
| API (REST) | Face enrollment with real photo, model check | Node.js fetch | `test/api/face_enrollment.test.js` |
| API (REST) | Missing person gallery management | Node.js fetch | `test/api/missing_persons.test.js` |
| Integration | Socket.IO `face_match` → match log update | socket.io-client | `test/integration/face_id.test.js` (Phase-2) |
| E2E | Drag-drop upload, confirm dialogs, match log render | Playwright | `test/e2e/face_id.test.js` (Phase-3) |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-UI-FACE-001 | TC-A-001 |
| FR-UI-FACE-002 | TC-A-002 |
| FR-UI-FACE-003 | TC-F-001 |
| FR-UI-FACE-004 | TC-F-002 |
| FR-UI-FACE-005 | TC-A-003 |
| FR-UI-FACE-006 | TC-F-003 |
| FR-UI-FACE-007 | TC-A-004 |
| FR-UI-FACE-008 | TC-F-004 |
| FR-UI-FACE-009 | TC-A-005 |
| FR-UI-FACE-010 | TC-A-006 |
| FR-UI-FACE-020 | TC-B-001 |
| FR-UI-FACE-021 | TC-B-002 (Phase-3 E2E) |
| FR-UI-FACE-022 | TC-B-002 (Phase-3 E2E) |
| FR-UI-FACE-023 | TC-B-002 (Phase-3 E2E) |
| FR-UI-FACE-024 | TC-B-003 |
| FR-UI-FACE-025 | TC-B-004 |
| FR-UI-FACE-026 | TC-B-001 |
| FR-UI-FACE-027 | TC-B-001 |
| FR-UI-FACE-028 | TC-B-005, TC-G-001 |
| FR-UI-FACE-029 | TC-B-006 |
| FR-UI-FACE-030 | TC-B-007 |
| FR-UI-FACE-040 | TC-C-001 (Phase-2) |
| FR-UI-FACE-041 | TC-C-002 (Phase-2) |
| FR-UI-FACE-042 | TC-C-003 (Phase-2) |
| FR-UI-FACE-043 | TC-C-004 (Phase-2) |
| FR-UI-FACE-044 | TC-C-005 (Phase-3 E2E) |
| FR-UI-FACE-045 | TC-C-006 (Phase-3 E2E) |
| FR-UI-FACE-050 | TC-D-001 (Phase-2) |
| FR-UI-FACE-051 | TC-D-002 (Phase-2) |
| FR-UI-FACE-052 | TC-D-003 (Phase-2) |
| FR-UI-FACE-053 | TC-D-004 (Phase-3 E2E) |
| FR-UI-FACE-060 | TC-E-001 |
| FR-UI-FACE-061 | TC-E-002 |
| FR-UI-FACE-062 | TC-E-003 |
| FR-UI-FACE-063 | TC-E-004 |
| FR-UI-FACE-064 | TC-E-005 |

### 1.3 Test Data

| File | Description | Required |
|---|---|---|
| `test/fixtures/face_clear.jpg` | Clear frontal face photo for enrollment | ✅ Manual placement |
| `test/fixtures/no_face.jpg` | Image with no human face | ✅ Auto-generated (gray JPEG) |
| `test/fixtures/face_side.jpg` | Side-angle face photo | ⚠ Optional (Phase-2) |
| `test/fixtures/multi_face.jpg` | Photo with multiple faces | ⚠ Optional (Phase-2) |

---

## 2. Test Environment and Prerequisites

```
Server running:      http://localhost:3001
ONNX models:         server/models/scrfd_2.5g.onnx + arcface_w600k_r50.onnx
                     (TC-B-001 requires models; others work without)
Storage writable:    storage/ directory writable
```

**Pre-test cleanup**: TC-A / TC-B groups create galleries and faces that may persist between test runs. Tests should delete their own test data in cleanup steps.

---

## 3. Test Group A — Gallery Management

### TC-A-001 — Face ID Tab Registration

- **SRS**: FR-UI-FACE-001
- **API**: `GET /api/galleries`
- **Input**: Server is running; `GET /api/galleries`
- **Expected**: HTTP 200; response body `{ success: true, data: [] }` (or array of galleries)
- **Acceptance**: Status 200; `success === true`; `data` is an array

### TC-A-002 — Gallery Fetch on Mount

- **SRS**: FR-UI-FACE-002
- **API**: `GET /api/galleries`
- **Input**: `GET /api/galleries`
- **Expected**: Returns current gallery list; no server error
- **Acceptance**: HTTP 200; `success === true`

### TC-A-003 — Gallery Create and Retrieve

- **SRS**: FR-UI-FACE-007
- **API**: `POST /api/galleries`, `GET /api/galleries`
- **Input**: `POST /api/galleries` with `{ name: "Test Gallery", type: "general" }`
- **Expected**: HTTP 201 or 200; returned object has `id`, `name`, `type`, `faceCount: 0`; subsequent `GET` returns the new gallery
- **Acceptance**: `j.success === true`; `j.data.name === "Test Gallery"`; `j.data.type === "general"`; `j.data.faceCount === 0`

### TC-A-004 — Gallery Create with All Types

- **SRS**: FR-UI-FACE-007, FR-UI-FACE-008
- **API**: `POST /api/galleries` × 4
- **Input**: Create galleries with types `missing`, `vip`, `blocklist`, `general`
- **Expected**: All 4 created successfully; `GET /api/galleries` returns all 4
- **Acceptance**: 4 successful responses; `GET` returns array of length ≥ 4 including all types

### TC-A-005 — Gallery Delete

- **SRS**: FR-UI-FACE-009
- **API**: `POST /api/galleries`, `DELETE /api/galleries/:id`, `GET /api/galleries`
- **Input**: Create gallery → delete it
- **Expected**: `DELETE` returns `{ success: true }`; subsequent `GET` does not include the deleted gallery
- **Acceptance**: `DELETE` status 200; `success === true`; gallery absent from subsequent `GET`

### TC-A-006 — Empty Gallery List

- **SRS**: FR-UI-FACE-010
- **API**: `GET /api/galleries`
- **Input**: `GET /api/galleries` when no galleries exist (or all deleted)
- **Expected**: HTTP 200; `data` is an empty array `[]`
- **Acceptance**: `data.length === 0`

---

## 4. Test Group B — Face Enrollment

### TC-B-001 — Enroll Face (Success Path)

- **SRS**: FR-UI-FACE-026, FR-UI-FACE-027
- **API**: `POST /api/galleries/:id/faces`
- **Input**: Valid gallery ID; multipart form with `photo = test/fixtures/face_clear.jpg`, `name = "Alice"`
- **Expected**: HTTP 200; `{ success: true, data: { id, galleryId, name: "Alice", thumbnail, createdAt } }`; thumbnail is a base64 data URI
- **Acceptance**: `j.success === true`; `j.data.name === "Alice"`; `j.data.thumbnail` starts with `"data:image/jpeg;base64,"`
- **Prerequisite**: ONNX models loaded; `test/fixtures/face_clear.jpg` present

### TC-B-002 — Drag-Drop and Preview (E2E Phase-3)

- **SRS**: FR-UI-FACE-021, FR-UI-FACE-022, FR-UI-FACE-023
- **Tool**: Playwright
- **Input**: Drag a JPEG file onto the upload area
- **Expected**: Border changes to blue; preview image displayed; [Enroll] becomes enabled
- **Acceptance**: Phase-3 — Playwright test
- **Status**: ⏳ Phase-3

### TC-B-003 — Name Defaults to "Unknown"

- **SRS**: FR-UI-FACE-024
- **API**: `POST /api/galleries/:id/faces`
- **Input**: Multipart with `photo` set, `name` field omitted
- **Expected**: Enrolled face name defaults to `"Unknown"`
- **Acceptance**: `j.data.name === "Unknown"`

### TC-B-004 — Enroll Button Disabled Without File (E2E Phase-3)

- **SRS**: FR-UI-FACE-025
- **Tool**: Playwright
- **Status**: ⏳ Phase-3

### TC-B-005 — Enroll Error: No Face Detected

- **SRS**: FR-UI-FACE-028
- **API**: `POST /api/galleries/:id/faces`
- **Input**: Valid gallery; `photo = test/fixtures/no_face.jpg` (gray image, no face)
- **Expected**: HTTP 400 or error response; `j.success === false`
- **Acceptance**: Non-2xx status OR `j.success === false`; error message present
- **Note**: Requires ONNX models. If models not loaded, expects HTTP 503 — also acceptable.

### TC-B-006 — Face Card List After Enrollment

- **SRS**: FR-UI-FACE-029
- **API**: `GET /api/galleries/:id/faces`
- **Input**: Gallery with enrolled face; `GET /api/galleries/:id/faces`
- **Expected**: Returns array with at least 1 face; each face has `id`, `name`, `thumbnail`, `createdAt`; `embedding` field NOT present in response
- **Acceptance**: `j.success === true`; `j.data.length >= 1`; `j.data[0].embedding === undefined`

### TC-B-007 — Delete Enrolled Face

- **SRS**: FR-UI-FACE-030
- **API**: `POST /api/galleries/:id/faces`, `DELETE /api/galleries/:id/faces/:faceId`, `GET /api/galleries/:id/faces`
- **Input**: Enroll a face → delete it
- **Expected**: `DELETE` returns `{ success: true }`; `GET` face list no longer contains deleted face
- **Acceptance**: `DELETE` status 200; face absent from subsequent `GET /faces`

---

## 5. Test Group C — Match Log & Socket.IO

### TC-C-001 — Socket.IO face_match Subscription (Phase-2)

- **SRS**: FR-UI-FACE-040
- **Tool**: socket.io-client
- **Input**: Connect to Socket.IO server; emit `face_match` test event
- **Expected**: Client state `matchLog` contains the event within 1 second
- **Status**: ⏳ Phase-2

### TC-C-002 — Match Log Max 50 Entries (Phase-2)

- **SRS**: FR-UI-FACE-041
- **Input**: Emit 55 `face_match` events in rapid succession
- **Expected**: `matchLog` state contains exactly 50 entries (oldest pruned)
- **Status**: ⏳ Phase-2

### TC-C-003 — Match Log Row Content (Phase-2)

- **SRS**: FR-UI-FACE-042
- **Input**: Emit `face_match` event with known fields
- **Expected**: Log row displays person name, score%, cameraId, timestamp
- **Status**: ⏳ Phase-2

### TC-C-004 — Match Log Row Color by Type (Phase-2)

- **SRS**: FR-UI-FACE-043
- **Input**: Emit `face_match` events for each of 4 gallery types
- **Expected**: Row background matches type color spec
- **Status**: ⏳ Phase-2

### TC-C-005 — Match Log Empty State (Phase-3 E2E)

- **SRS**: FR-UI-FACE-044
- **Status**: ⏳ Phase-3

### TC-C-006 — Match Log Scroll Container (Phase-3 E2E)

- **SRS**: FR-UI-FACE-045
- **Status**: ⏳ Phase-3

---

## 6. Test Group D — Missing Person Alert

### TC-D-001 — Missing Person Banner Trigger (Phase-2)

- **SRS**: FR-UI-FACE-050
- **Input**: Emit `face_match` event with `galleryType: "missing"`
- **Expected**: Alert banner appears at top of panel
- **Status**: ⏳ Phase-2

### TC-D-002 — Missing Person Banner Content (Phase-2)

- **SRS**: FR-UI-FACE-051
- **Input**: `face_match` event with `identity: "Alice", matchScore: 0.942, cameraId: "CAM-1"`
- **Expected**: Banner shows "Alice", "94.2%", "CAM-1"
- **Status**: ⏳ Phase-2

### TC-D-003 — Missing Person Banner Style (Phase-2)

- **SRS**: FR-UI-FACE-052
- **Expected**: Banner has `animate-pulse` CSS class; background is red
- **Status**: ⏳ Phase-2

### TC-D-004 — Missing Count Badge (Phase-3 E2E)

- **SRS**: FR-UI-FACE-053
- **Status**: ⏳ Phase-3

---

## 7. Test Group E — Data Persistence

### TC-E-001 — Gallery Persists After Server Restart

- **SRS**: FR-UI-FACE-060
- **API**: `POST /api/galleries`, restart server, `GET /api/galleries`
- **Input**: Create gallery; restart Node.js server process; call `GET /api/galleries`
- **Expected**: Gallery is present in the response after restart
- **Acceptance**: `data` array contains the gallery created before restart

### TC-E-002 — Face Record Persists After Server Restart

- **SRS**: FR-UI-FACE-061
- **API**: `POST /api/galleries/:id/faces`, restart, `GET /api/galleries/:id/faces`
- **Input**: Enroll face; restart server; list faces
- **Expected**: Enrolled face (name, thumbnail) is present after restart
- **Acceptance**: Face with correct name and non-empty thumbnail present in response

### TC-E-003 — Persistent Gallery Reload After Enrollment

- **SRS**: FR-UI-FACE-062
- **API**: `POST /api/galleries/:id/faces`
- **Input**: Enroll a face in a named gallery
- **Expected**: Server's in-memory `_persistentGallery` is reloaded; subsequent live-camera matching uses the new embedding
- **Acceptance**: API returns 200 + face record; `GET /api/galleries/:id/faces` shows the new face

### TC-E-004 — face_tracking.json Created on New Detection

- **SRS**: FR-UI-FACE-063
- **Input**: At least one camera active and detecting persons
- **Expected**: `storage/face_tracking.json` exists with `faceCounter >= 1`
- **Acceptance**: File exists; JSON parses without error; `faceCounter` is a positive integer

### TC-E-005 — Trajectory Counter Continues After Restart

- **SRS**: FR-UI-FACE-064
- **Input**: Note `faceCounter` from `face_tracking.json`; restart server; wait for new detection
- **Expected**: New face IDs (F-number) continue from the value before restart, not reset to F1
- **Acceptance**: After restart, if `faceCounter` was N before restart, new face IDs are ≥ F-N

---

## 8. Test Group F — Gallery Type System

### TC-F-001 — Display Order: Missing First

- **SRS**: FR-UI-FACE-003
- **API**: `GET /api/galleries`
- **Input**: Create galleries of types: `general`, `vip`, `missing`, `blocklist` (in that order)
- **Expected**: `GET /api/galleries` returns all 4; client renders them in order: missing → vip → blocklist → general
- **Acceptance**: API returns all 4 galleries; type order verified in response

### TC-F-002 — Missing Type Section Header

- **SRS**: FR-UI-FACE-004
- **Input**: Gallery of type `missing` exists
- **Expected**: Section header for `missing` type is visible with 🔍 icon
- **Acceptance**: Phase-3 E2E for UI verification; API verification: gallery type returned correctly

### TC-F-003 — Type-Based Left Border (Phase-3 E2E)

- **SRS**: FR-UI-FACE-006
- **Status**: ⏳ Phase-3

### TC-F-004 — Gallery Type Selector Options

- **SRS**: FR-UI-FACE-008
- **Input**: `POST /api/galleries` with each valid type
- **Expected**: All 4 types accepted: `missing`, `vip`, `blocklist`, `general`
- **Acceptance**: HTTP 200 for each type; returned `type` matches input

---

## 9. Test Group G — Edge Cases

### TC-G-001 — Enroll to Non-Existent Gallery

- **SRS**: FR-UI-FACE-028
- **API**: `POST /api/galleries/nonexistent-id/faces`
- **Input**: Valid photo; invalid gallery ID
- **Expected**: HTTP 404; `{ success: false }`
- **Acceptance**: Status 404 or error body with `success: false`

### TC-G-002 — Delete Non-Existent Gallery

- **API**: `DELETE /api/galleries/nonexistent-id`
- **Expected**: HTTP 404 or `{ success: false }`
- **Acceptance**: Non-2xx or `success: false`

### TC-G-003 — Delete Non-Existent Face

- **API**: `DELETE /api/galleries/:id/faces/nonexistent-face-id`
- **Input**: Valid gallery; invalid face ID
- **Expected**: HTTP 404 or `{ success: false }`
- **Acceptance**: Non-2xx or `success: false`

### TC-G-004 — Create Gallery with Empty Name

- **API**: `POST /api/galleries` with `{ name: "", type: "general" }`
- **Expected**: HTTP 400 or server stores the gallery with empty name
- **Acceptance**: Either 400 (rejected) or 200 with `name === ""` (permissive) — document actual behavior

### TC-G-005 — Gallery Delete Cascades to Faces

- **API**: `POST /api/galleries`, `POST /api/galleries/:id/faces` × 2, `DELETE /api/galleries/:id`, `GET /api/galleries/:id/faces`
- **Input**: Create gallery → enroll 2 faces → delete gallery → list faces
- **Expected**: `GET /api/galleries/:id/faces` returns 404 or empty list
- **Acceptance**: Enrolled faces no longer accessible after gallery deletion

---

## 10. Test Execution Order

```
Group A (gallery management)
  → Group B (face enrollment) [requires models for TC-B-001]
  → Group E (persistence) [may require server restart]
  → Group F (type system)
  → Group G (edge cases)
  → Group C (Socket.IO) [Phase-2]
  → Group D (missing alert) [Phase-2]
```

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Gallery CRUD | Create/List/Delete APIs return correct status codes and data shapes |
| Face Enrollment | Enroll with valid photo returns face card with name and thumbnail |
| Error Handling | No-face photo and invalid IDs return appropriate error responses |
| Type System | All 4 gallery types accepted; display order verified via API |
| Persistence | Galleries and faces survive server restart; trajectory counter continues |
| Socket.IO (Phase-2) | Match log updates within 1 s of event; max 50 entries enforced |
| Missing Alert (Phase-2) | Banner appears on missing-type match; banner is red and pulsing |
| E2E (Phase-3) | Drag-drop upload works; confirm dialogs dismiss correctly |

---

## 12. Test Group H — Live Match Crop (v1.1)

**Scope**: Verify that `face_match` events emitted by the server include `liveCropData`, and that the `FaceGalleryTab` MatchLog displays both thumbnails.

**SRS refs**: FR-UI-FACE-080, FR-UI-FACE-081, FR-UI-FACE-082, FR-UI-FACE-083

### TC-H-001 — face_match event includes liveCropData

| Field | Value |
|---|---|
| **ID** | TC-H-001 |
| **Priority** | P1 |
| **Type** | API / Integration |
| **SRS Ref** | FR-UI-FACE-080 |

**Preconditions**: Server running with `SNAPSHOT_ENABLED=true`; at least one enrolled face; live camera active.

**Steps**:
1. Connect a Socket.IO client to the server.
2. Subscribe to `face_match` event.
3. Wait for the pipeline to match an enrolled face (or simulate by injecting a mock frame that triggers a match).
4. Capture the received event payload.

**Expected Result**:
- Event contains `liveCropData` field.
- Value is a string starting with `data:image/jpeg;base64,`.
- Base64 decodes to a valid JPEG (non-empty, first bytes `FF D8 FF`).

---

### TC-H-002 — face_match without sharp falls back gracefully

| Field | Value |
|---|---|
| **ID** | TC-H-002 |
| **Priority** | P2 |
| **Type** | Integration |
| **SRS Ref** | FR-UI-FACE-082 |

**Preconditions**: `SNAPSHOT_ENABLED=false` or `snapshotSvc.isEnabled()` returns false.

**Steps**:
1. Disable snapshots (`SNAPSHOT_ENABLED=false`).
2. Restart server; wait for a face match event.
3. Inspect event payload.

**Expected Result**:
- `face_match` event is still emitted.
- `liveCropData` field is absent (or `undefined`).
- No error thrown; server logs no uncaught exception.

---

### TC-H-003 — MatchLog shows both enrolled photo and live crop

| Field | Value |
|---|---|
| **ID** | TC-H-003 |
| **Priority** | P1 |
| **Type** | UI / E2E |
| **SRS Ref** | FR-UI-FACE-083 |

**Preconditions**: Browser open on dashboard; Face ID tab visible; live face match occurring.

**Steps**:
1. Navigate to the `faces` sidebar tab.
2. Observe the MatchLog after a `face_match` event arrives.

**Expected Result**:
- Match log row shows **two** 28×28 images: enrolled photo (from `thumbnail`) and live crop (from `liveCropData`).
- Both images load without broken-image icons.
- Hovering an image shows title attribute (`"Enrolled"` / `"Live"`).

---

### TC-H-004 — MatchLog shows placeholder when liveCropData absent

| Field | Value |
|---|---|
| **ID** | TC-H-004 |
| **Priority** | P2 |
| **Type** | UI / Unit |
| **SRS Ref** | FR-UI-FACE-083 |

**Steps**:
1. Inject a synthetic `face_match` event via Socket.IO with `liveCropData: undefined`.
2. Observe the MatchLog row.

**Expected Result**:
- Enrolled photo renders normally.
- Live crop slot shows `👤` placeholder icon instead of a broken image.

---

### TC-H-005 — Crop does not block frame processing

| Field | Value |
|---|---|
| **ID** | TC-H-005 |
| **Priority** | P2 |
| **Type** | Performance |
| **SRS Ref** | FR-UI-FACE-081 |

**Steps**:
1. Enable DEBUG logging; monitor frame-processing timestamp gaps.
2. Trigger 5 consecutive face match events in rapid succession.
3. Measure time between consecutive frame-processed log lines.

**Expected Result**:
- Frame processing interval does not increase by more than 5 ms when face matches occur.
- `face_match` events are emitted within 100 ms of the frame being processed.

---

## 13. Test Group I — Face Match History Search (v1.1)

**Scope**: Verify `faceMatchHistory` persistence, `GET /api/search?types=matches`, and SearchBar navigation.

**SRS refs**: FR-UI-FACE-084, FR-UI-FACE-085, FR-UI-FACE-086, FR-UI-FACE-087

### TC-I-001 — face_match event is persisted to faceMatchHistory

| Field | Value |
|---|---|
| **ID** | TC-I-001 |
| **Priority** | P1 |
| **Type** | API / Integration |
| **SRS Ref** | FR-UI-FACE-084 |

**Steps**:
1. Note the current count of `faceMatchHistory` records (via `storage/lts.json` or debug endpoint).
2. Trigger a face match event.
3. Wait 500 ms; re-read `storage/lts.json`.

**Expected Result**:
- `faceMatchHistory` array has one more entry.
- New record contains all required fields: `id`, `faceId`, `cameraId`, `identity`, `galleryId`, `galleryType`, `matchScore`, `thumbnail`, `timestamp`, `createdAt`.
- If crop succeeded, record also contains `liveCropData`.

---

### TC-I-002 — GET /api/search?types=matches returns match results

| Field | Value |
|---|---|
| **ID** | TC-I-002 |
| **Priority** | P1 |
| **Type** | API |
| **SRS Ref** | FR-UI-FACE-085 |

**Steps**:
1. Ensure at least one `faceMatchHistory` record exists for identity "John Doe".
2. `GET /api/search?q=John&types=matches`.

**Expected Result**:
- HTTP 200.
- Response is an array; at least one entry has `_type: 'match'`, `identity` containing "John".
- Entry contains `liveCropData` (non-null when crop was available), `thumbnail`, `galleryType`, `matchScore`, `cameraId`, `timestamp`.

---

### TC-I-003 — Search returns partial name match

| Field | Value |
|---|---|
| **ID** | TC-I-003 |
| **Priority** | P2 |
| **Type** | API |
| **SRS Ref** | FR-UI-FACE-085 |

**Steps**:
1. `GET /api/search?q=joh&types=matches` (lowercase partial).

**Expected Result**:
- Returns the same entry for "John Doe" (case-insensitive substring match).

---

### TC-I-004 — GET /api/search?types=faces includes match history

| Field | Value |
|---|---|
| **ID** | TC-I-004 |
| **Priority** | P2 |
| **Type** | API |
| **SRS Ref** | FR-UI-FACE-086 |

**Steps**:
1. `GET /api/search?q=John&types=faces`.

**Expected Result**:
- Results include both `_type: 'face'` entries (from `faceGalleryFaces`) and `_type: 'match'` entries (from `faceMatchHistory`) for the query "John".

---

### TC-I-005 — SearchBar match result click navigates to faces tab

| Field | Value |
|---|---|
| **ID** | TC-I-005 |
| **Priority** | P1 |
| **Type** | UI / E2E |
| **SRS Ref** | FR-UI-FACE-087 |

**Steps**:
1. Open the dashboard; click the SearchBar (or press Ctrl+K).
2. Type "John" — wait for results to appear.
3. Click a result with `_type: 'match'`.

**Expected Result**:
- The sidebar tab switches to the `faces` tab.
- `FaceGalleryTab` is rendered and visible.
- SearchBar closes.

---

### TC-I-006 — Empty search returns no match results

| Field | Value |
|---|---|
| **ID** | TC-I-006 |
| **Priority** | P2 |
| **Type** | API |
| **SRS Ref** | FR-UI-FACE-085 |

**Steps**:
1. `GET /api/search?q=NONEXISTENT_PERSON_XYZ&types=matches`.

**Expected Result**:
- HTTP 200; response is an empty array `[]`.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Dashboard Sidebar Face ID |
