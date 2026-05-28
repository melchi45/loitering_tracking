# TEST CASES (TC)
# Dashboard Layout

| | |
|---|---|
| **Document ID** | TC-DLY-001 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Dashboard_Layout.md |
| **Test Scripts** | test/e2e/dashboard_e2e.test.js (Phase-3 placeholder) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Desktop Shell & Header](#3-test-group-a--desktop-shell--header)
4. [Test Group B — Sidebar Behavior](#4-test-group-b--sidebar-behavior)
5. [Test Group C — Camera Grid & Layout Picker](#5-test-group-c--camera-grid--layout-picker)
6. [Test Group D — Fullscreen Overlay](#6-test-group-d--fullscreen-overlay)
7. [Test Group E — Mobile Layout Branching](#7-test-group-e--mobile-layout-branching)
8. [Test Group F — Settings & Connectivity](#8-test-group-f--settings--connectivity)
9. [Test Group G — Discovery Panel Overlay](#9-test-group-g--discovery-panel-overlay)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| Unit | localStorage layout restore, breakpoint logic | Jest + jsdom | `test/unit/layout.test.js` (Phase-2) |
| Integration | Socket.IO connection state, camera count update | socket.io-client + React testing | `test/integration/layout.test.js` (Phase-2) |
| E2E | Full dashboard layout in browser | Playwright | `test/e2e/dashboard_layout.test.js` (Phase-3) |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-DLY-001 | TC-A-001 |
| FR-DLY-002 | TC-A-002 |
| FR-DLY-003 | TC-E-001 |
| FR-DLY-004 | TC-B-001 |
| FR-DLY-005 | TC-B-002 |
| FR-DLY-006 | TC-B-003, TC-H-001 |
| FR-DLY-007 | TC-A-003 |
| FR-DLY-008 | TC-C-001 |
| FR-DLY-009 | TC-C-002 |
| FR-DLY-010 | TC-C-003 |
| FR-DLY-011 | TC-D-001 |
| FR-DLY-012 | TC-E-002 |
| FR-DLY-013 | TC-E-003 |
| FR-DLY-014 | TC-E-004 |
| FR-DLY-015 | TC-F-001 |
| FR-DLY-016 | TC-F-002 |
| FR-DLY-017 | TC-C-004 |
| FR-DLY-018 | TC-G-001 |
| FR-DLY-006 (Face Gallery CRUD) | TC-H-002, TC-H-003, TC-H-004, TC-H-005, TC-H-006 |
| FR-DLY-006 (Face match log) | TC-H-007 |
| FR-DLY-006 (Face data persistence) | TC-H-008, TC-H-009 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| Viewport presets (1920×1080, 375×812) | Desktop and mobile layout tests |
| Camera fixtures (5+ cameras) | Grid paging tests |
| localStorage layout key | Layout restore tests |

---

## 2. Test Environment and Prerequisites

- Browser dashboard at `http://localhost:5173`
- Server at `http://localhost:3001`
- At least 5 cameras registered (for paging tests)

---

## 3. Test Group A — Desktop Shell & Header

### TC-A-001 — Full Viewport Shell
- **Input:** Load dashboard on 1920×1080 viewport
- **Expected:** Root div uses `h-screen`, `overflow-hidden`, `bg-gray-900`; no scroll on page
- **Acceptance:** No vertical scrollbar on page; background is gray-900

### TC-A-002 — Desktop Header Contents
- **Input:** Dashboard loaded (width ≥ 768 px)
- **Expected:** Header contains: logo, title, Socket.IO status dot, camera count, layout picker dropdown, settings button
- **Acceptance:** All 6 elements visible in header

### TC-A-003 — CameraGrid in Main Content
- **Input:** Desktop dashboard with 4-camera layout
- **Expected:** Main content area renders `CameraGrid` filling available space
- **Acceptance:** Camera grid fills flex-1 space; no overflow

---

## 4. Test Group B — Sidebar Behavior

### TC-B-001 — Default Sidebar Width
- **Input:** Desktop dashboard loaded
- **Expected:** Right sidebar width is 288 px by default
- **Acceptance:** Measured sidebar width = 288 px

### TC-B-002 — Drag Resize
- **Input:** Drag the 4 px resize handle between sidebar and main area
- **Expected:** Sidebar width adjusts between 180 px and 600 px
- **Acceptance:** Min 180 px; max 600 px; drag updates width in real time

### TC-B-003 — Sidebar Tabs
- **Input:** Desktop sidebar
- **Expected:** 6 tabs visible: Cameras, Alerts, Zones, Detections, Analytics, Face Gallery
- **Acceptance:** All 6 tab labels present; unacknowledged alert badge visible when count > 0

---

## 5. Test Group C — Camera Grid & Layout Picker

### TC-C-001 — Layout Picker Dropdown
- **Input:** Click LayoutPicker in header; select "9 channels"
- **Expected:** Grid immediately shows 9-channel layout
- **Acceptance:** Grid layout changes without page reload

### TC-C-002 — Supported Grid Layouts
- **Input:** Open layout picker
- **Expected:** At least 1, 4, 9, 16 channel layouts available; split layouts (1+3, 1+7) present
- **Acceptance:** All listed layouts selectable

### TC-C-003 — Channel Paging
- **Input:** 5 cameras registered; 4-channel layout selected
- **Expected:** Previous/Next arrows visible; clicking Next shows cameras 5+
- **Acceptance:** Paging arrows appear; click advances channel offset

### TC-C-004 — Layout Restored from localStorage
- **Input:** Select "16 channels"; reload page
- **Expected:** 16-channel layout restored from localStorage
- **Acceptance:** Layout matches pre-reload selection

---

## 6. Test Group D — Fullscreen Overlay

### TC-D-001 — Double-Click Opens Fullscreen
- **Input:** Double-click a camera cell in the grid
- **Expected:** `FullscreenCameraView` full-screen overlay appears; ESC closes it
- **Acceptance:** Overlay covers full viewport; ESC returns to grid

---

## 7. Test Group E — Mobile Layout Branching

### TC-E-001 — Mobile Header (< 768 px)
- **Input:** Viewport width 375 px
- **Expected:** Mobile header shown (no LayoutPicker); bottom navigation bar visible; right sidebar hidden
- **Acceptance:** LayoutPicker absent; BottomNavBar present; sidebar hidden

### TC-E-002 — Bottom Navigation Bar
- **Input:** Mobile viewport
- **Expected:** Fixed 52 px bottom bar with 6 icon+label tab buttons (per FR-DLY-012)

  > Note: SRS_Dashboard_Layout specifies 6 tabs but SRS_Mobile_Layout specifies 5; defer to Mobile_Layout SRS for tab count.

- **Acceptance:** Bottom bar present and fixed at bottom

### TC-E-003 — Mobile Cameras Tab Split
- **Input:** Mobile viewport; Cameras tab active
- **Expected:** CameraGrid (~58%) + CameraList (~42%) vertical split
- **Acceptance:** Both components visible; proportional heights correct

### TC-E-004 — Mobile Swipe Navigation
- **Input:** Mobile viewport; 5 cameras; 1-channel layout; swipe left
- **Expected:** Channel offset advances by 1; next camera shown
- **Acceptance:** Swipe ≥ 40 px triggers page change; dot indicator updates

---

## 8. Test Group F — Settings & Connectivity

### TC-F-001 — Settings Modal
- **Input:** Click settings gear icon
- **Expected:** Modal opens with: language selector, WebRTC STUN/TURN config fields
- **Acceptance:** Both sections present; language change applied immediately

### TC-F-002 — Socket.IO Connection Indicator
- **Input:** Disconnect server; wait 5 seconds
- **Expected:** Connection status dot turns red and stays red ≥ 5 seconds
- **Acceptance:** Red indicator maintained; reconnects on server restart

---

## 9. Test Group G — Discovery Panel Overlay

### TC-G-001 — DiscoveredCameraPanel Overlay
- **Input:** Select a discovered camera in Found tab
- **Expected:** `DiscoveredCameraPanel` appears as overlay in camera grid area with device details
- **Acceptance:** Panel overlay shown; device info visible; "Add as camera" button present

---

## 10. Test Group H — Face ID Sidebar Tab

### TC-H-001 — Face ID Tab Visibility
- **Input:** Dashboard loaded on desktop
- **Expected:** 🪪 FACE ID tab button visible in sidebar tab bar
- **Acceptance:** Tab button with icon 🪪 or label `FACE ID` present; clicking switches content to `FaceGalleryTab`

### TC-H-002 — Gallery List Render
- **Input:** Navigate to 🪪 Face ID tab; at least one named gallery created
- **Expected:** Galleries rendered in priority order: missing → vip → blocklist → general; each shows name, type icon, face count badge
- **Acceptance:** Correct order; correct icons (🔍 ⭐ 🚫 🗃); face count matches enrolled faces

### TC-H-003 — Face Enrollment
- **Input:** Open a gallery; upload valid JPEG photo (≥ 1 face); enter name; click Enroll
- **Expected:** New face card appears in gallery with thumbnail and name
- **Acceptance:** `POST /api/galleries/:id/faces` returns 200; face card with 48×48 thumbnail shown; name ≤ 12 chars displayed

### TC-H-004 — Enrollment Error (No Face)
- **Input:** Upload image with no detectable face
- **Expected:** Error message displayed; face card not added
- **Acceptance:** `POST /api/galleries/:id/faces` returns 4xx; error text shown in UI

### TC-H-005 — Face Deletion
- **Input:** Hover over a face card; click ✕ delete button
- **Expected:** Face card removed from gallery immediately
- **Acceptance:** `DELETE /api/galleries/:id/faces/:faceId` returns 200; face card disappears without page reload

### TC-H-006 — Gallery Deletion
- **Input:** Click 🗑 icon on gallery header; confirm deletion
- **Expected:** Gallery and all enrolled faces removed
- **Acceptance:** `DELETE /api/galleries/:id` returns 200; gallery section disappears

### TC-H-007 — Match Log Real-Time Update
- **Input:** Face match event occurs (camera detects enrolled person)
- **Expected:** New row appears at top of Match Log with timestamp, faceId, name, gallery, score%
- **Acceptance:** Log updates within 1 s of Socket.IO `face_match` event; maximum 50 entries retained

### TC-H-008 — Persistence After Server Restart
- **Input:** Enroll a face; restart server; reload dashboard; navigate to Face ID tab
- **Expected:** Previously enrolled gallery and face card still present
- **Acceptance:** `GET /api/galleries` + `GET /api/galleries/:id/faces` return same data after restart; `storage/lts.json` contains enrolled face

### TC-H-009 — Person Trajectory Persistence
- **Input:** Camera detects person (trajectory P1 created); restart server
- **Expected:** Person trajectory counter continues from last value (no reset to P1)
- **Acceptance:** After restart, `GET /api/persons` returns existing trajectories; new detections continue from persisted alias counter; `storage/face_tracking.json` present on disk

---

## 11. Test Execution Order

```
Group A (shell) → Group B (sidebar) → Group C (grid) → Group D (fullscreen) → Group E (mobile) → Group F (settings) → Group G (discovery) → Group H (face ID)
```

---

## 12. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Shell | Full viewport; no overflow; correct background |
| Header | All 6 desktop elements present; correct mobile elements |
| Sidebar | Default 288 px; 180–600 px drag range; 6 tabs |
| Grid | Layout picker works; paging correct; localStorage restore |
| Fullscreen | Opens on double-click; closes on ESC |
| Mobile | Correct branching at 768 px; bottom nav; swipe works |
| Settings | Modal opens; language switch works; connectivity indicator |
| Face ID | Tab visible; gallery CRUD works; match log updates; data persists across restart |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Dashboard Layout |
