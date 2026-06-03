# TEST CASES (TC)
# Mobile Layout

| | |
|---|---|
| **Document ID** | TC-LTS-UI-MOB-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Mobile_Layout.md |
| **Test Scripts** | test/e2e/dashboard_e2e.test.js (Phase-3, shared with Dashboard Layout) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Breakpoint Detection & Mode Switching](#3-test-group-a--breakpoint-detection--mode-switching)
4. [Test Group B — Mobile Header](#4-test-group-b--mobile-header)
5. [Test Group C — Bottom Navigation Bar](#5-test-group-c--bottom-navigation-bar)
6. [Test Group D — Cameras Tab](#6-test-group-d--cameras-tab)
7. [Test Group E — Other Mobile Tabs](#7-test-group-e--other-mobile-tabs)
8. [Test Group F — Mobile Fullscreen Overlay](#8-test-group-f--mobile-fullscreen-overlay)
9. [Test Group G — Edge Cases](#9-test-group-g--edge-cases)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| Unit | breakpoint logic, channelOffset clamping, swipe threshold | Jest + jsdom | `test/unit/mobile_layout.test.js` (Phase-2) |
| Integration | Zustand store continuity across mode switch | React testing | `test/integration/mobile_layout.test.js` (Phase-2) |
| E2E | Mobile viewport interactions, swipe, tabs | Playwright (mobile viewport) | `test/e2e/mobile_layout.test.js` (Phase-3) |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-UI-MOB-001 | TC-A-001 |
| FR-UI-MOB-002 | TC-A-002 |
| FR-UI-MOB-003 | TC-A-003 |
| FR-UI-MOB-004 | TC-A-004 |
| FR-UI-MOB-010 | TC-B-001 |
| FR-UI-MOB-011 | TC-B-002 |
| FR-UI-MOB-012 | TC-B-003 |
| FR-UI-MOB-020 | TC-C-001 |
| FR-UI-MOB-021 | TC-C-002 |
| FR-UI-MOB-022 | TC-C-003 |
| FR-UI-MOB-023 | TC-C-004 |
| FR-UI-MOB-030 | TC-D-001 |
| FR-UI-MOB-031 | TC-D-002 |
| FR-UI-MOB-032 | TC-D-003 |
| FR-UI-MOB-033 | TC-D-004 |
| FR-UI-MOB-034 | TC-D-005 |
| FR-UI-MOB-035 | TC-D-006 |
| FR-UI-MOB-036 | TC-D-007 |
| FR-UI-MOB-037 | TC-D-008 |
| FR-UI-MOB-040 | TC-E-001 |
| FR-UI-MOB-041 | TC-E-002 |
| FR-UI-MOB-042 | TC-E-003 |
| FR-UI-MOB-043 | TC-E-004 |
| FR-UI-MOB-044 | TC-G-001 |
| FR-UI-MOB-050 | TC-F-001 |
| FR-UI-MOB-051 | TC-F-002 |
| FR-UI-MOB-052 | TC-F-003 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| Mobile viewport (375×812) | Mobile tests |
| Desktop viewport (1920×1080) | Desktop/breakpoint tests |
| 5+ camera fixtures | Paging tests |
| Active alert fixture | Badge count test |

---

## 2. Test Environment and Prerequisites

- Browser dashboard at `http://localhost:3080`
- Playwright configured with mobile device emulation (iPhone 12)
- At least 5 cameras registered for paging tests
- Server at `http://localhost:3080`

---

## 3. Test Group A — Breakpoint Detection & Mode Switching

### TC-A-001 — Synchronous isMobile Initialization
- **Input:** Load page on viewport width 375 px
- **Expected:** Mobile layout rendered immediately on first paint; no flash of desktop layout
- **Acceptance:** No desktop sidebar visible on first render; bottom nav present immediately

### TC-A-002 — Resize Listener
- **Input:** Start at 1200 px width (desktop); resize to 400 px (mobile)
- **Expected:** Mobile layout activates; resize back to 1200 px → desktop layout returns
- **Acceptance:** Layout changes on resize; no extra renders when below/above threshold

### TC-A-003 — Mode Switching Shows Correct Elements
- **Input:** Viewport < 768 px
- **Expected:** Desktop right sidebar hidden; bottom navigation bar visible
- **Input 2:** Viewport ≥ 768 px
- **Expected:** Bottom nav hidden; right sidebar visible
- **Acceptance:** Exclusive rendering at both breakpoints

### TC-A-004 — Zustand Store Continuity
- **Input:** Select camera A on desktop (1200 px); resize to 375 px (mobile)
- **Expected:** Selected camera still selected; alert count unchanged
- **Acceptance:** All Zustand store state preserved across mode switch

---

## 4. Test Group B — Mobile Header

### TC-B-001 — Header Layout Elements
- **Input:** Mobile viewport; header visible
- **Expected:** Header = 44 px height; contains LTS logo/title, status dot, camera count badge, settings icon
- **Acceptance:** All 4 elements visible; height measured = 44 px

### TC-B-002 — LayoutPicker Hidden
- **Input:** Mobile header
- **Expected:** LayoutPicker dropdown absent from mobile header
- **Acceptance:** No layout picker visible in mobile header

### TC-B-003 — Settings Modal Access
- **Input:** Tap settings icon in mobile header
- **Expected:** Settings modal opens with language selector and WebRTC STUN/TURN config
- **Acceptance:** Modal visible; both configuration sections present

---

## 5. Test Group C — Bottom Navigation Bar

### TC-C-001 — Bar Structure
- **Input:** Mobile viewport; bottom nav visible
- **Expected:** Fixed bar at bottom, 52 px height, 5 tab buttons (Cameras, Alerts, Zones, Detections, Analytics)
- **Acceptance:** 5 buttons; height = 52 px; fixed to bottom

### TC-C-002 — Tab Active Style
- **Input:** Switch between tabs
- **Expected:** Active tab text in blue (`text-blue-400`); inactive in gray; blue underline indicator at top of active button
- **Acceptance:** Active/inactive colors correct; underline visible only on active tab

### TC-C-003 — Alerts Badge
- **Input:** 3 unacknowledged alerts
- **Expected:** Alerts tab icon shows red badge with "3"
- **Input 2:** 15 unacknowledged alerts
- **Expected:** Badge shows "9+"
- **Acceptance:** Count and overflow behavior correct

### TC-C-004 — Touch Target Size
- **Input:** Measure each tab button
- **Expected:** Each button ≥ 44×44 px
- **Acceptance:** All 5 buttons meet 44×44 px minimum

---

## 6. Test Group D — Cameras Tab

### TC-D-001 — Vertical Split Layout
- **Input:** Mobile viewport; Cameras tab active
- **Expected:** Content area split: CameraGrid (~60% top) + CameraList (~40% bottom)
- **Acceptance:** Both components visible; vertical split present

### TC-D-002 — Default Layout = 1 Channel
- **Input:** Cameras tab on mobile (first load)
- **Expected:** CameraGrid shows 1-channel layout by default
- **Acceptance:** Single camera slot visible on first render

### TC-D-003 — Simplified Layout Picker
- **Input:** Cameras tab; layout picker visible at top-right
- **Expected:** 3 buttons: "1", "4", "9" channel options
- **Input 2:** Tap "4"
- **Expected:** 4-channel grid shown; `channelOffset` reset to 0
- **Acceptance:** Layout changes; offset resets on layout change

### TC-D-004 — Swipe Navigation (≥ 40 px)
- **Input:** 5 cameras; 1-channel layout; swipe left ≥ 40 px
- **Expected:** `channelOffset` advances by 1 (next camera shown)
- **Input 2:** Swipe right ≥ 40 px
- **Expected:** `channelOffset` decreases by 1
- **Acceptance:** Swipe changes camera; both directions work

### TC-D-005 — channelOffset Bounds
- **Input:** 5 cameras; 1-channel layout; swipe left 10 times
- **Expected:** `channelOffset` stops at 4 (last camera); no negative; clamped to `totalCameras - channelCount`
- **Acceptance:** Cannot swipe past last camera; cannot go below 0

### TC-D-006 — Page Dot Indicator
- **Input:** 5 cameras; 1-channel layout (5 pages total)
- **Expected:** 5 dots visible below CameraGrid; current page dot = blue; others = gray
- **Acceptance:** Dots appear when pages ≥ 2; active dot correct

### TC-D-007 — N/M Page Badge
- **Input:** 5 cameras; 1-channel; currently on page 2
- **Expected:** "2/5" badge at top-left of CameraGrid
- **Acceptance:** Badge shows correct current/total pages; only when pages ≥ 2

### TC-D-008 — Double-Tap CameraList Row → Fullscreen
- **Input:** Double-tap a camera row in CameraList
- **Expected:** FullscreenCameraView overlay opens for that camera
- **Acceptance:** Fullscreen overlay for correct camera

---

## 7. Test Group E — Other Mobile Tabs

### TC-E-001 — Alerts Tab
- **Input:** Tap Alerts tab
- **Expected:** AlertPanel shown fullscreen
- **Acceptance:** AlertPanel fills content area; alert rows visible

### TC-E-002 — Zones Tab
- **Input:** Tap Zones tab
- **Expected:** Zone guidance message shown (no ZoneEditor); double-click hint present
- **Acceptance:** Hint text visible; no zone editing controls

### TC-E-003 — Detections Tab
- **Input:** Tap Detections tab
- **Expected:** Camera selection dropdown + DetectionPanel shown fullscreen
- **Acceptance:** Dropdown and panel both visible

### TC-E-004 — Analytics Tab
- **Input:** Tap Analytics tab
- **Expected:** VideoAnalyticsTab shown fullscreen
- **Acceptance:** Analytics tab fills content area

---

## 8. Test Group F — Mobile Fullscreen Overlay

### TC-F-001 — Video/Detection Split
- **Input:** Open fullscreen camera view on mobile
- **Expected:** Vertical split: video (top ~60%) + DetectionPanel (bottom ~40%)
- **Acceptance:** Both components present; vertical layout (not horizontal)

### TC-F-002 — Close and Zone Editor Buttons
- **Input:** Fullscreen overlay open
- **Expected:** "← Back" close button and "Zone Editor" button accessible
- **Acceptance:** Both buttons present; Close returns to Cameras tab; Zone Editor opens ZoneEditor

### TC-F-003 — Double-Tap Grid Cell → Fullscreen
- **Input:** Double-tap camera cell in CameraGrid (mobile Cameras tab)
- **Expected:** FullscreenCameraView overlay opens for that camera
- **Acceptance:** Correct camera opened in fullscreen

---

## 9. Test Group G — Edge Cases

### TC-G-001 — Tab Switch No State Reset
- **Input:** Switch from Cameras tab to Alerts tab and back
- **Expected:** Zustand store state (selected camera, alert count) unchanged
- **Acceptance:** No state initialization on tab switch

### TC-G-002 — Swipe < 40 px Ignored
- **Input:** Swipe left 20 px on Cameras tab
- **Expected:** `channelOffset` unchanged; no page change
- **Acceptance:** Swipe below threshold has no effect

---

## 10. Test Execution Order

```
Group A (breakpoint) → Group B (header) → Group C (bottom nav) → Group D (cameras tab) → Group E (other tabs) → Group F (fullscreen) → Group G (edge cases)
```

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Breakpoint | No flash; correct mode at 767/768 px boundary; store continuity |
| Header | 44 px; all elements; no layout picker |
| Bottom nav | 52 px fixed; 5 tabs; correct active style; 44×44 touch targets |
| Cameras tab | Vertical split; default 1ch; 3-layout picker; swipe ≥ 40 px; dots; badge |
| Other tabs | Each tab shows correct component fullscreen |
| Fullscreen | Video top / DetectionPanel bottom split; both buttons accessible |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Mobile Layout |
