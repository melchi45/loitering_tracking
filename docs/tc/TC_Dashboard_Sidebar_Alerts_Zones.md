# TEST CASES (TC)
# Dashboard Sidebar — Alerts & Zones

| | |
|---|---|
| **Document ID** | TC-LTS-UI-AZ-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Dashboard_Sidebar_Alerts_Zones.md |
| **Test Scripts** | test/api/sidebar_alerts_zones.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Alert Panel Display](#3-test-group-a--alert-panel-display)
4. [Test Group B — Alert Acknowledgment](#4-test-group-b--alert-acknowledgment)
5. [Test Group C — Zone Sidebar & Hint](#5-test-group-c--zone-sidebar--hint)
6. [Test Group D — ZoneEditor Functionality](#6-test-group-d--zoneeditor-functionality)
7. [Test Group E — Edge Cases and i18n](#7-test-group-e--edge-cases-and-i18n)
8. [Test Execution Order](#8-test-execution-order)
9. [Pass/Fail Criteria](#9-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | `/api/alerts/:id/acknowledge` | Node.js fetch | `test/api/alerts_zones.test.js` |
| Integration | Socket.IO `alert` event → UI update | socket.io-client + React testing | `test/integration/alerts.test.js` (Phase-2) |
| E2E | Full ZoneEditor canvas interaction | Playwright | `test/e2e/zone_editor.test.js` (Phase-3) |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-UI-AZ-001 | TC-A-001 |
| FR-UI-AZ-002 | TC-A-002 |
| FR-UI-AZ-003 | TC-A-003 |
| FR-UI-AZ-004 | TC-A-004 |
| FR-UI-AZ-005 | TC-A-005 |
| FR-UI-AZ-006 | TC-B-001 |
| FR-UI-AZ-007 | TC-A-006 |
| FR-UI-AZ-008 | TC-A-007 |
| FR-UI-AZ-010 | TC-C-001 |
| FR-UI-AZ-011 | TC-C-002 |
| FR-UI-AZ-012 | TC-C-003 |
| FR-UI-AZ-020 | TC-D-001 |
| FR-UI-AZ-021 | TC-D-002 |
| FR-UI-AZ-022 | TC-D-003 |
| FR-UI-AZ-023 | TC-D-004 |
| FR-UI-AZ-024 | TC-D-005 |
| FR-UI-AZ-025 | TC-D-006 |
| FR-UI-AZ-026 | TC-D-007 |
| FR-UI-AZ-027 | TC-D-008 |
| FR-UI-AZ-028 | TC-D-009 |
| FR-UI-AZ-029 | TC-D-010 |
| FR-UI-AZ-030 | TC-D-011 |
| FR-UI-AZ-031 | TC-D-012 |
| FR-UI-AZ-032 | TC-D-013 |
| FR-UI-AZ-033 | TC-D-014 |
| FR-UI-AZ-034 | TC-E-001 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `loitering_alert` fixture (id, cameraId, objectId, zoneName, dwellTime) | Alert display tests |
| Camera fixture with MONITOR + EXCLUDE zones | Zone editor tests |
| Sample polygon (4-point rectangle) | Valid zone creation |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3001`
- At least 1 camera registered with zones
- `GET /health` returns `{ status: 'ok' }`

---

## 3. Test Group A — Alert Panel Display

### TC-A-001 — Real-Time Alert from Socket.IO
- **Input:** Server emits `alert` Socket.IO event
- **Expected:** Alert added to top of `AlertStore`; immediately visible in panel
- **Acceptance:** New alert appears at top of list within 100 ms

### TC-A-002 — Unacknowledged Alert Count Badge
- **Input:** 5 unacknowledged alerts
- **Expected:** Panel header badge shows "5"
- **Acceptance:** Badge shows correct count; badge hidden when count = 0

### TC-A-003 — "Clear All" Button
- **Input:** Alerts present; click "Clear All"
- **Expected:** Alert list cleared on client side
- **Acceptance:** Panel shows empty state after clear; count badge removed

### TC-A-004 — Alert Row Content
- **Input:** Alert with cameraName, relativeTime, objectId, zoneName, dwellTime
- **Expected:** All fields visible in alert row
- **Acceptance:** Warning icon + camera name + relative time + object # + zone name + dwell time all present

### TC-A-005 — Acknowledged vs Unacknowledged Styling
- **Input:** Mix of acknowledged and unacknowledged alerts
- **Expected:** Unacknowledged rows use distinct background (higher opacity); acknowledged rows dimmed
- **Acceptance:** Visual difference between acked and unacked rows

### TC-A-006 — 20 Alert Maximum
- **Input:** 25 alerts received
- **Expected:** Only 20 displayed; oldest silently dropped
- **Acceptance:** List length ≤ 20

### TC-A-007 — Empty State
- **Input:** No alerts present
- **Expected:** Check icon + "No alerts" message shown
- **Acceptance:** Empty state displays correctly

---

## 4. Test Group B — Alert Acknowledgment

### TC-B-001 — Acknowledge Single Alert
- **Input:** Click "Ack" button on alert row
- **Expected:** `POST /api/alerts/:id/acknowledge` called; row immediately updates to acknowledged state
- **Acceptance:** HTTP 200 from server; row style changes immediately (no reload)

---

## 5. Test Group C — Zone Sidebar & Hint

### TC-C-001 — Zones Tab Shows Hint Only
- **Input:** Switch to Zones tab in sidebar
- **Expected:** Zone editor controls NOT shown; only hint/guide text displayed
- **Acceptance:** No ZoneEditor UI in sidebar; hint text present

### TC-C-002 — No Camera Registered Hint
- **Input:** Zones tab; no cameras registered
- **Expected:** "Add a camera to get started" sub-hint visible
- **Acceptance:** Sub-hint text matches spec

### TC-C-003 — ZoneEditor Access Path
- **Input:** Double-click camera → open fullscreen → click "Zone Editor"
- **Expected:** ZoneEditor opens as full-screen overlay
- **Acceptance:** ZoneEditor not accessible from sidebar directly; only via fullscreen path

---

## 6. Test Group D — ZoneEditor Functionality

### TC-D-001 — Full-Screen Overlay
- **Input:** Open ZoneEditor
- **Expected:** `fixed inset-0 z-[100]` overlay; background is latest JPEG frame from camera
- **Acceptance:** ZoneEditor covers full viewport; camera frame visible as background

### TC-D-002 — ZoneEditor Header
- **Input:** ZoneEditor opened
- **Expected:** "Zone Edit" title and close button in control panel header
- **Acceptance:** Title + close button present

### TC-D-003 — Two Modes (idle / draw)
- **Input:** ZoneEditor opens in idle mode
- **Expected:** `idle` mode shows zone selection/edit; `+ Add Zone` button switches to `draw` mode
- **Acceptance:** Mode switch works; controls change between modes

### TC-D-004 — idle Mode Zone Selection
- **Input:** Click existing zone polygon; idle mode
- **Expected:** Zone name edit field, type badge, vertex count, and Save button shown
- **Acceptance:** All 4 elements visible on zone selection

### TC-D-005 — draw Mode Controls
- **Input:** Enter draw mode
- **Expected:** Zone name input, type selector, Dwell Threshold, Min Displacement, Min Risk Score fields shown
- **Acceptance:** All 5 configuration fields present

### TC-D-006 — Save Button Activation
- **Input:** draw mode; add 2 vertices; enter zone name
- **Expected:** Save button disabled; add 3rd vertex; Save button enabled
- **Acceptance:** Save button enabled only when vertices ≥ 3 AND name non-empty

### TC-D-007 — Save New Zone
- **Input:** Draw 4-point polygon; enter name "TestZone"; click Save
- **Expected:** `POST /api/cameras/:cameraId/zones` called; zone appears in zone list
- **Acceptance:** HTTP 201; zone visible in right panel list

### TC-D-008 — Canvas Click / Draw Interactions
- **Input:** Single click on canvas in draw mode
- **Expected:** Vertex added at click position
- **Acceptance:** Vertex count increases by 1

### TC-D-009 — Canvas Zone Visual Style
- **Input:** Canvas with MONITOR and EXCLUDE zones
- **Expected:** MONITOR zone in blue; EXCLUDE in orange; selected zone has highlight
- **Acceptance:** Colors match MONITOR=blue, EXCLUDE=orange

### TC-D-010 — Edit Existing Zone
- **Input:** Drag vertex in idle mode; click "Save Polygon"
- **Expected:** `PUT /api/cameras/:cameraId/zones/:zoneId` called with updated polygon
- **Acceptance:** HTTP 200; zone vertices updated in canvas

### TC-D-011 — Delete Zone
- **Input:** Right-click zone → "Delete Zone" → confirm
- **Expected:** `DELETE /api/cameras/:cameraId/zones/:zoneId` called; zone removed from canvas and list
- **Acceptance:** HTTP 200; zone gone from both canvas and list

### TC-D-012 — Zone List in Right Panel
- **Input:** ZoneEditor with 3 zones
- **Expected:** Zone list shows color dot, name, threshold/type label, delete button for each zone
- **Acceptance:** All 3 zones listed with correct info

### TC-D-013 — Load Zones on ZoneEditor Open
- **Input:** Open ZoneEditor
- **Expected:** `GET /api/cameras/:cameraId/zones` called; existing zones loaded to canvas
- **Acceptance:** Zones drawn on canvas matching database records

### TC-D-014 — Zone Label Position
- **Input:** Canvas with zone polygons
- **Expected:** Zone label rendered at polygon centroid (center of mass)
- **Acceptance:** Label inside polygon; MONITOR=blue label, EXCLUDE=orange label

---

## 7. Test Group E — Edge Cases and i18n

### TC-E-001 — i18n for Alert and Zone Panel
- **Input:** Switch language to Japanese (`ja`)
- **Expected:** All alert labels, zone hint text, ZoneEditor controls translate
- **Acceptance:** No hardcoded English strings; all 15 supported languages work

---

## 8. Test Execution Order

```
Group A (alerts) → Group B (ack) → Group C (zone sidebar) → Group D (zone editor) → Group E (i18n)
```

Zone editor tests create zones that must be deleted after group completion.

---

## 9. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Alert panel | Real-time display; correct row content; 20-item max |
| Acknowledgment | API called; immediate visual update |
| Zone sidebar | Hint only; no editor in sidebar |
| ZoneEditor | Full overlay; both modes work; CRUD operations succeed |
| i18n | All strings translate across 15 languages |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Dashboard Sidebar Alerts Zones |
