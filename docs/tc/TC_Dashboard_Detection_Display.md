# TEST CASES (TC)
# Dashboard Detection Display

| | |
|---|---|
| **Document ID** | TC-LTS-UI-DD-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Dashboard_Detection_Display.md |
| **Test Scripts** | test/e2e/dashboard_e2e.test.js (Phase-3 placeholder) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Canvas Bounding Box Rendering](#3-test-group-a--canvas-bounding-box-rendering)
4. [Test Group B — Detection Panel (Fullscreen)](#4-test-group-b--detection-panel-fullscreen)
5. [Test Group C — Sidebar Detection Tab](#5-test-group-c--sidebar-detection-tab)
6. [Test Group D — Video Analytics Tab](#6-test-group-d--video-analytics-tab)
7. [Test Group E — Attribute Badges](#7-test-group-e--attribute-badges)
8. [Test Group F — Edge Cases and i18n](#8-test-group-f--edge-cases-and-i18n)
9. [Test Execution Order](#9-test-execution-order)
10. [Pass/Fail Criteria](#10-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| Unit | Canvas rendering functions, color mapping | Jest + jsdom | `test/unit/canvas_render.test.js` (Phase-2) |
| Integration | Socket.IO `detections` event → UI update | socket.io-client + React testing | `test/integration/detection_display.test.js` (Phase-2) |
| E2E | Full dashboard with live detections | Playwright | `test/e2e/dashboard_detection.test.js` (Phase-3) |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-UI-DD-001 | TC-A-001 |
| FR-UI-DD-002 | TC-A-002 |
| FR-UI-DD-003 | TC-A-003 |
| FR-UI-DD-004 | TC-A-004 |
| FR-UI-DD-005 | TC-E-001 |
| FR-UI-DD-006 | TC-E-002 |
| FR-UI-DD-007 | TC-A-005 |
| FR-UI-DD-008 | TC-A-006 |
| FR-UI-DD-009 | TC-A-007 |
| FR-UI-DD-010 | TC-A-008 |
| FR-UI-DD-020 | TC-B-001 |
| FR-UI-DD-021 | TC-B-002 |
| FR-UI-DD-022 | TC-B-003 |
| FR-UI-DD-023 | TC-B-004 |
| FR-UI-DD-024 | TC-B-005 |
| FR-UI-DD-025 | TC-E-003 |
| FR-UI-DD-026 | TC-B-006 |
| FR-UI-DD-027 | TC-B-007 |
| FR-UI-DD-030 | TC-C-001 |
| FR-UI-DD-031 | TC-C-002 |
| FR-UI-DD-032 | TC-C-003 |
| FR-UI-DD-033 | TC-C-004 |
| FR-UI-DD-040 | TC-D-001 |
| FR-UI-DD-041 | TC-D-002 |
| FR-UI-DD-042 | TC-D-003 |
| FR-UI-DD-043 | TC-D-004 |
| FR-UI-DD-044 | TC-D-005 |
| FR-UI-DD-045 | TC-D-006 |
| FR-UI-DD-046 | TC-D-007 |
| FR-UI-DD-047 | TC-F-001 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| Mock `detections` event payload | Canvas rendering + panel tests |
| Mock `loitering_alert` event | Loitering indicator tests |
| Camera fixture (2+ cameras) | Multi-camera sidebar filter test |
| i18n locale fixture | i18n key tests |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- At least 1 camera registered and running (for integration tests)
- Browser dashboard open at `http://localhost:3080` (Playwright E2E)

---

## 3. Test Group A — Canvas Bounding Box Rendering

### TC-A-001 — Render Latency
- **Input:** `detections` Socket.IO event received
- **Expected:** All bounding boxes rendered on canvas within 5 ms of event receipt
- **Acceptance:** Canvas repaint measured ≤ 5 ms (requestAnimationFrame timing)

### TC-A-002 — Class Color Mapping
- **Input:** Detections with classes: person, car, face
- **Expected:** person → green, car → blue, face → cyan dashed box
- **Acceptance:** Stroke color matches spec for each class

### TC-A-003 — Loitering Color Override
- **Input:** Detection with `isLoitering: true` and class `person`
- **Expected:** Bounding box rendered in `rgba(239,68,68,0.9)` (red) regardless of class
- **Acceptance:** Red box overrides class color when loitering

### TC-A-004 — Top-Left Label
- **Input:** Detection with `className: "person"`, `objectId: "obj-001"`, `confidence: 0.92`
- **Expected:** Label rendered at top-left of bbox: "person #obj-001 92%"
- **Acceptance:** Label content and position correct

### TC-A-005 — Dwell Time Display
- **Input:** Detection with `isLoitering: true` and `dwellTime: 42.5`
- **Expected:** Elapsed time displayed at bottom-right of bbox: "42.5s"
- **Acceptance:** Display triggered when `isLoitering=true` OR `dwellTime > 5.0`

### TC-A-006 — Zone Polygon Overlay
- **Input:** Camera with MONITOR zone (blue) and EXCLUDE zone (orange)
- **Expected:** Both zone polygons drawn on canvas with correct colors and center label
- **Acceptance:** MONITOR=blue, EXCLUDE=orange; label at polygon centroid

### TC-A-007 — Face Independent BBox
- **Input:** Face detection within a person bbox
- **Expected:** Face rendered as independent bounding box, not as sub-box inside person
- **Acceptance:** Face bbox drawn at face coordinates, not nested

### TC-A-008 — Fire/Smoke BBox
- **Input:** Fire detection
- **Expected:** 3 px border + semi-transparent background; FIRE badge with `animate-pulse`
- **Acceptance:** Badge animated; thick border present

---

## 4. Test Group B — Detection Panel (Fullscreen)

### TC-B-001 — Two-Column Fullscreen Layout
- **Input:** Open fullscreen camera view
- **Expected:** `DetectionPanel` (256 px left) + `CameraView` (right) layout
- **Acceptance:** Panel fixed at 256 px; remaining width for video

### TC-B-002 — Header Count Format
- **Input:** 5 detections, 2 loitering
- **Expected:** Header shows "5 obj  2 loiter"
- **Acceptance:** Exact format match

### TC-B-003 — Row Sort Order
- **Input:** Mix of loitering and non-loitering detections
- **Expected:** Loitering rows first, then sorted by `dwellTime` descending
- **Acceptance:** First row has `isLoitering: true`; subsequent rows by descending dwell

### TC-B-004 — Detection Row Content
- **Input:** Detection row with all fields
- **Expected:** Row shows: `className`, `objectId`, confidence, `dwellTime`, bbox coords, AMF metrics
- **Acceptance:** All fields visible in row

### TC-B-005 — Loitering Row Background
- **Input:** Detection with `isLoitering: true`
- **Expected:** Row background `bg-red-900/20` applied
- **Acceptance:** Correct class applied

### TC-B-006 — Cross-Camera Re-ID Section
- **Input:** At least 1 `face:reidentified` local event
- **Expected:** "Cross-Camera Re-ID" section visible with up to 5 recent events
- **Acceptance:** Section appears; maximum 5 events shown

### TC-B-007 — Detection Legend Collapsed by Default
- **Input:** Open fullscreen view
- **Expected:** Detection legend is collapsed at bottom; expand shows `max-h-64 overflow-y-auto`
- **Acceptance:** Legend collapsed on mount; expandable on click

---

## 5. Test Group C — Sidebar Detection Tab

### TC-C-001 — Unified Detection List
- **Input:** Sidebar Detection tab; 2 cameras active
- **Expected:** Detections from both cameras shown in unified list
- **Acceptance:** Detections from all active cameras visible

### TC-C-002 — Camera Filter Dropdown
- **Input:** Camera filter checkbox dropdown
- **Expected:** Per-camera enable/disable checkboxes shown
- **Acceptance:** Unchecking camera X removes its detections from list

### TC-C-003 — useAllDetections Hook
- **Input:** 3 camera IDs subscribed via `useAllDetections(ids)`
- **Expected:** Combined sorted list of detections across all 3 cameras
- **Acceptance:** Detections from all 3 cameras present; sorted by loitering then dwell

### TC-C-004 — Camera Name Badge
- **Input:** Detection from "Camera A" (live) and "Camera B" (offline)
- **Expected:** "Camera A" badge in teal; "Camera B" badge in gray
- **Acceptance:** Correct badge color per camera status

---

## 6. Test Group D — Video Analytics Tab

### TC-D-001 — Analytics Tab Position
- **Input:** Sidebar with all tabs visible
- **Expected:** Analytics is the 5th tab with label "analytics"
- **Acceptance:** Tab order correct; tab ID matches

### TC-D-002 — AI Module Toggle Buttons
- **Input:** VideoAnalyticsTab rendered
- **Expected:** Toggle buttons organized in groups: Person/Vehicle, Accessories, AI Attributes, Hazard, Indoor/Office
- **Acceptance:** All groups and buttons present

### TC-D-003 — Capabilities Check
- **Input:** Server with `ai.animal: false` in capabilities
- **Expected:** Animal detection toggle shown as disabled/grayed
- **Acceptance:** Disabled state matches capabilities response

### TC-D-004 — Phase-2 Module Label
- **Input:** Phase-2 module in analytics tab
- **Expected:** Module shows `opacity-35` + "Phase-2" label; toggle not functional
- **Acceptance:** Toggle click has no effect; "Phase-2" text present

### TC-D-005 — Kalman Slider Controls
- **Input:** Expand Kalman tracker settings section
- **Expected:** 6 sliders visible (default collapsed state initially)
- **Acceptance:** Section expands; 6 sliders shown

### TC-D-006 — Slider Debounce Save
- **Input:** Move slider; wait 300 ms
- **Expected:** `PUT /api/tracker/config` called once after 300 ms debounce
- **Acceptance:** API call timing measured; no duplicate calls during drag

### TC-D-007 — Reset Button
- **Input:** Click "Reset" button in Kalman settings
- **Expected:** `POST /api/tracker/config/reset` called; UI restored to defaults
- **Acceptance:** Sliders return to default values

---

## 7. Test Group E — Attribute Badges

### TC-E-001 — Mask Attribute Badge
- **Input:** Person with `mask.status: 'no_mask'`
- **Expected:** "NO MASK" badge rendered inside bbox at 14 px height
- **Acceptance:** Badge position, text, and height correct

### TC-E-002 — Color Attribute Display
- **Input:** Person with `color: { upper: 'blue', lower: 'black' }`
- **Expected:** "↑blue ↓black" rendered at bbox bottom-left
- **Acceptance:** Correct format and position

### TC-E-003 — All Badge Types
- **Input:** Dashboard with all badge types present
- **Expected:** LOITER (red), FIRE (orange animated), MASK OK/NO MASK/MASK?, HELMET/NO HELMET/HAT?, CROSS-CAM (purple) all render correctly
- **Acceptance:** All badge labels and colors match specification

---

## 8. Test Group F — Edge Cases and i18n

### TC-F-001 — All Strings Use i18n Keys
- **Input:** Switch language to Korean (`ko`)
- **Expected:** All Detection panel labels, badge text, and tab names translate
- **Acceptance:** No hardcoded English strings visible after language switch

---

## 9. Test Execution Order

```
Group A (canvas) → Group B (fullscreen panel) → Group C (sidebar) → Group D (analytics tab) → Group E (badges) → Group F (i18n)
```

---

## 10. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Canvas rendering | ≤ 5 ms per frame; correct colors; correct label format |
| Detection panel | Correct 2-col layout; correct sort; all row fields |
| Sidebar detection | Multi-camera unified list; correct badge colors |
| Video analytics | All toggles present; capabilities respected; slider debounce |
| Badges | All badge types render with correct labels and colors |
| i18n | All UI strings translateable |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Dashboard Detection Display |
