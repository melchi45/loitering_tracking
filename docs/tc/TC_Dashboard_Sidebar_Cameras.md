# TEST CASES (TC)
# Dashboard Sidebar — Cameras

| | |
|---|---|
| **Document ID** | TC-LTS-UI-CAM-01 |
| **Version** | 1.2 |
| **Status** | Active |
| **Date** | 2026-07-14 |
| **Parent SRS** | srs/SRS_Dashboard_Sidebar_Cameras.md |
| **Test Scripts** | test/api/sidebar_cameras.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Camera Panel Header & Sub-Tabs](#3-test-group-a--camera-panel-header--sub-tabs)
4. [Test Group B — Added Cameras List](#4-test-group-b--added-cameras-list)
5. [Test Group C — Add Camera Modal](#5-test-group-c--add-camera-modal)
6. [Test Group D — Found Cameras Tab](#6-test-group-d--found-cameras-tab)
7. [Test Group E — DiscoveredCameraPanel Overlay](#7-test-group-e--discoveredcamerapanel-overlay)
8. [Test Group F — Edit Camera Modal](#8-test-group-f--edit-camera-modal)
9. [Test Group G — Edge Cases](#9-test-group-g--edge-cases)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | Camera CRUD, YouTube stream | Node.js fetch | `test/api/sidebar_cameras.test.js` |
| Integration | Socket.IO `discovery:result` → Found tab auto-switch | socket.io-client | `test/integration/sidebar_cameras.test.js` (Phase-2) |
| E2E | Add Camera modal, Edit, Delete interactions | Playwright | `test/e2e/sidebar_cameras.test.js` (Phase-3) |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-UI-CAM-001 | TC-A-001 |
| FR-UI-CAM-002 | TC-A-002 |
| FR-UI-CAM-003 | TC-A-003 |
| FR-UI-CAM-010 | TC-B-001 |
| FR-UI-CAM-011 | TC-B-002 |
| FR-UI-CAM-012 | TC-B-003 |
| FR-UI-CAM-013 | TC-B-004 |
| FR-UI-CAM-014 | TC-B-005 |
| FR-UI-CAM-015 | TC-B-006 |
| FR-UI-CAM-016 | TC-B-007 |
| FR-UI-CAM-020 | TC-C-001 |
| FR-UI-CAM-021 | TC-C-002 |
| FR-UI-CAM-022 | TC-C-003 |
| FR-UI-CAM-023 | TC-C-004 |
| FR-UI-CAM-024 | TC-C-005 |
| FR-UI-CAM-025 | TC-C-006 |
| FR-UI-CAM-026 | TC-F-001 |
| FR-UI-CAM-027 | TC-F-002 |
| FR-UI-CAM-028 | TC-F-003 |
| FR-UI-CAM-029 | TC-F-004 |
| FR-UI-CAM-030 | TC-D-001 |
| FR-UI-CAM-031 | TC-D-002 |
| FR-UI-CAM-032 | TC-D-003 |
| FR-UI-CAM-033 | TC-D-004 |
| FR-UI-CAM-004 | TC-A-004 |
| FR-UI-CAM-003 | TC-A-005 |
| FR-UI-CAM-040 | TC-E-001 |
| FR-UI-CAM-041 | TC-E-002 |
| FR-UI-CAM-042 | TC-E-003 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| Camera fixture (name, rtspUrl) | Add/Edit camera tests |
| YouTube stream fixture (name, URL, resolution) | YouTube tab tests |
| Mock `discovery:result` event | Found tab auto-switch test |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- Dashboard accessible at `http://localhost:3080`
- Clean camera state (no cameras) for add tests

---

## 3. Test Group A — Camera Panel Header & Sub-Tabs

### TC-A-001 — Panel Header Elements
- **Input:** Cameras tab active in sidebar
- **Expected:** Header shows title, connection status dot, "+ Add" button
- **Acceptance:** All 3 elements present

### TC-A-002 — Added/Found Sub-Tab Structure
- **Input:** Cameras sidebar with no discovery results yet
- **Expected:** "Added(N)" and "Found(N)" sub-tabs visible; N reflects counts
- **Acceptance:** Both sub-tabs present; counts correct

### TC-A-003 — Auto-Switch to Found on First Result (zero cameras registered)
- **SRS:** FR-UI-CAM-003
- **Input:** No cameras registered (`cameras.length === 0`); `discovery:result` Socket.IO event received (first one)
- **Expected:** Sidebar switches to Found sub-tab automatically
- **Acceptance:** One-time auto-switch occurs; subsequent results don't re-switch

### TC-A-004 — Auto-Switch Back to Added on Camera Registration
- **SRS:** FR-UI-CAM-004
- **Input:** Found sub-tab is active; user registers a camera (via "Add as camera" or Camera Add modal pre-filled from discovered device); `POST /api/cameras` succeeds; `cameras` array length increases by 1
- **Expected:** Panel automatically switches to Added sub-tab
- **Acceptance:** Added tab becomes active within one render cycle; newly registered camera is visible in the list; no manual tab click required
- **Test script:** `test/api/sidebar_cameras.test.js` — TC-A-004 (Phase-3 UI/E2E; REST API layer skipped)
- **Cross-ref:** Design_Dashboard_Sidebar_Cameras.md §9.4

### TC-A-005 — No Auto-Switch to Found Once Cameras Are Registered
- **SRS:** FR-UI-CAM-003
- **Input:** At least one camera already registered (`cameras.length >= 1`); user is on the Added tab; a `discovery:result` event arrives. Repeat with "Clean" clicked first (which resets `autoSwitched` to `false` and re-triggers `discovery:rescan`), then another `discovery:result` arrives.
- **Expected:** In both cases, the panel remains on the Added sub-tab; the Found tab's count badge updates in the background only
- **Acceptance:** `setSubTab('found')` is never invoked while `cameras.length >= 1`, regardless of `autoSwitched` state; regression guard against the panel repeatedly stealing focus from Added
- **Test script:** `test/api/sidebar_cameras.test.js` — TC-A-005 (Phase-3 UI/E2E; REST API layer skipped)
- **Cross-ref:** Design_Dashboard_Sidebar_Cameras.md §9.5

---

## 4. Test Group B — Added Cameras List

### TC-B-001 — Empty State
- **Input:** No cameras registered
- **Expected:** Added tab shows guidance/hint text; no camera rows
- **Acceptance:** Empty state message displayed

### TC-B-002 — Camera Row Content
- **Input:** Camera registered (name, status, type)
- **Expected:** Row shows StatusDot, name, YT badge (if YouTube), sub-info
- **Acceptance:** All required elements present per camera

### TC-B-003 — StatusDot Color
- **Input:** Cameras with statuses: live, error, offline, connecting
- **Expected:** live → green, error → red, offline → gray, other → yellow
- **Acceptance:** All 4 color states correct

### TC-B-004 — Action Buttons
- **Input:** Camera row hover/active; click Edit, Reconnect, AI Toggle, Delete
- **Expected:** Each action triggers correct API call or modal
- **Acceptance:** Edit → edit modal; Reconnect → `POST /:id/reconnect`; AI Toggle → `PUT /:id`; Delete → `DELETE /:id`

### TC-B-005 — AI Toggle Visual State
- **Input:** Camera with AI enabled and another with AI disabled
- **Expected:** AI On → green indicator; AI Off → gray indicator; tooltip reflects state
- **Acceptance:** Colors and tooltips correct

### TC-B-006 — Click Behaviors
- **Input:** Single-click camera row; double-click; right-click
- **Expected:** Single-click → select camera; double-click → reconnect; right-click → edit modal
- **Acceptance:** All 3 behaviors work correctly

### TC-B-007 — Selected Camera Highlight
- **Input:** Click on camera row
- **Expected:** Selected row shows `bg-blue-900/50 border-blue-600` style
- **Acceptance:** Correct CSS classes applied to selected row

---

## 5. Test Group C — Add Camera Modal

### TC-C-001 — Modal Overlay
- **Input:** Click "+ Add" button
- **Expected:** Modal appears as `fixed inset-0 z-50 bg-black/70` overlay
- **Acceptance:** Full viewport overlay visible

### TC-C-002 — RTSP Tab Fields
- **Input:** RTSP tab in Add Camera modal
- **Expected:** Name, RTSP URL, username, password, WebRTC toggle fields present
- **Acceptance:** All 5 fields visible

### TC-C-003 — RTSP Validation
- **Input:** Submit form without name or RTSP URL
- **Expected:** Validation error messages displayed; no API call
- **Acceptance:** Error messages shown; form not submitted

### TC-C-004 — YouTube Tab Fields
- **Input:** YouTube tab in Add Camera modal
- **Expected:** Channel name, YouTube URL, resolution dropdown, bitrate, Repeat Playback checkbox
- **Acceptance:** All 5 fields present

### TC-C-005 — YouTube Error Code Mapping
- **Input:** Submit YouTube URL that results in `INVALID_YOUTUBE_URL`
- **Expected:** User-friendly error message shown in modal
- **Acceptance:** Technical error code replaced with human-readable message

### TC-C-006 — Repeat Playback Behavior
- **Input:** Create YouTube stream with Repeat Playback = true; stream ends naturally
- **Expected:** Stream restarts automatically; restart count resets to 0
- **Acceptance:** Stream continues looping; no error state

---

## 6. Test Group D — Found Cameras Tab

### TC-D-001 — Found Tab Header Status
- **Input:** Discovery scanning in progress
- **Expected:** "● Scanning…" indicator; "Clean" button present
- **Acceptance:** Scanning indicator visible during scan

### TC-D-002 — Search Bar
- **Input:** Type "onvif" in search bar
- **Expected:** Only ONVIF devices shown; non-ONVIF devices filtered out
- **Acceptance:** Virtual keyword "onvif" filters correctly

### TC-D-003 — Discovered Device Row
- **Input:** Device with name, manufacturer, IP, SUNAPI and ONVIF badges
- **Expected:** Name/manufacturer/IP shown; SUNAPI and ONVIF badges present when applicable
- **Acceptance:** All row elements render

### TC-D-004 — Device Row Click
- **Input:** Click discovered device row
- **Expected:** `DiscoveryStore.select(cam)` called; `DiscoveredCameraPanel` overlay shown
- **Acceptance:** Panel appears with device details

---

## 7. Test Group E — DiscoveredCameraPanel Overlay

### TC-E-001 — Overlay Position
- **Input:** Select discovered camera
- **Expected:** `DiscoveredCameraPanel` appears as absolute overlay relative to camera grid area
- **Acceptance:** Panel positioned over camera grid area

### TC-E-002 — "Add as Camera" Button
- **Input:** Click "Add as camera" in panel
- **Expected:** Camera Add modal opens with device data pre-filled (name, RTSP URL)
- **Acceptance:** Modal fields populated from device data

### TC-E-003 — Close Panel
- **Input:** Click "Close" button
- **Expected:** `DiscoveryStore.select(null)` called; panel hidden
- **Acceptance:** Panel disappears; `select(null)` invoked

---

## 8. Test Group F — Edit Camera Modal

### TC-F-001 — Edit Modal Pre-fill
- **Input:** Right-click camera row → Edit
- **Expected:** Edit modal opens with current camera values pre-filled
- **Acceptance:** All fields populated with existing data

### TC-F-002 — webrtcEnabled Only Change
- **Input:** Change only `webrtcEnabled` field in edit modal; save
- **Expected:** Server auto-restarts pipeline without full reconnect
- **Acceptance:** No manual reconnect required; pipeline updates

### TC-F-003 — YouTube PATCH
- **Input:** Edit YouTube camera (change bitrate); save
- **Expected:** `PATCH /api/youtube-streams/:id` called (not PUT /api/cameras)
- **Acceptance:** Correct endpoint used for YouTube camera edit

### TC-F-004 — Save Feedback
- **Input:** Click "Save" in edit modal
- **Expected:** Button shows "Saving…" then "Saved." then modal closes after 0.8 seconds
- **Acceptance:** 3-stage feedback; auto-close timing correct

---

## 9. Test Group G — Edge Cases

### TC-G-001 — Concurrent Add + Discovery
- **Input:** Start discovery; simultaneously add camera manually
- **Expected:** Both operations succeed without conflict; Added list updates correctly
- **Acceptance:** No race condition; both results visible

---

## 10. Test Execution Order

```
Group A (header/tabs) → Group B (added list) → Group C (add modal) → Group D (found tab) → Group E (panel) → Group F (edit modal) → Group G (edge)
```

Clean up: delete test cameras after Group B, C, F.

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Panel structure | Header elements; sub-tabs; auto-switch on discovery |
| Camera list | Correct row content; status colors; action buttons |
| Add modal | All fields present; validation works; YouTube tab complete |
| Found tab | Search filter; device rows; panel overlay |
| Edit modal | Pre-filled; correct API endpoint; feedback timing |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Dashboard Sidebar Cameras |
| 1.1 | 2026-06-16 | LTS Engineering Team | TC-A-004 추가 — Found→Added 자동 전환 테스트 케이스; SRS Traceability FR-UI-CAM-004 → TC-A-004 추가 |
| 1.2 | 2026-07-14 | LTS Engineering Team | TC-A-003 조건 명시(등록 카메라 0대일 때만); TC-A-005 신규 추가 — 카메라 등록 후에는 Clean 이후에도 Found로 자동 전환되지 않음을 검증; SRS Traceability FR-UI-CAM-003 → TC-A-005 추가 |
