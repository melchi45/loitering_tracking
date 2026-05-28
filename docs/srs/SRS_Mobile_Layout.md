# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Mobile Layout

| | |
|---|---|
| **Document ID** | SRS-LTS-UI-MOB-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_Mobile_Layout.md |
| **Parent RFP** | rfp/RFP_Mobile_Layout.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Breakpoint Detection](#3-functional-requirements--breakpoint-detection)
4. [Functional Requirements — Mobile Header](#4-functional-requirements--mobile-header)
5. [Functional Requirements — Bottom Navigation Bar](#5-functional-requirements--bottom-navigation-bar)
6. [Functional Requirements — Cameras Tab](#6-functional-requirements--cameras-tab)
7. [Functional Requirements — Other Mobile Tabs](#7-functional-requirements--other-mobile-tabs)
8. [Functional Requirements — Mobile Fullscreen Overlay](#8-functional-requirements--mobile-fullscreen-overlay)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the Mobile Layout of LTS-2026. Each requirement is identified by a unique ID (FR-UI-MOB-NNN) and is directly traceable to test cases in TC_Mobile_Layout.md.

### 1.2 Scope

This document covers:
- Runtime breakpoint detection and mobile/desktop mode switching
- Compact mobile header
- Bottom navigation bar with 5 tabs and notification badges
- Cameras tab vertical split (CameraGrid / CameraList)
- Swipe-left/right channel page navigation with dot indicators
- Simplified layout picker (1, 4, 9 channels)
- Mobile fullscreen overlay vertical split (video top / DetectionPanel bottom)
- Shared Zustand store state between mobile and desktop modes

Out of scope: tablet intermediate layout at 768–1024 px (Phase-2), touch-based zone drawing in ZoneEditor.

### 1.3 Definitions

| Term | Definition |
|---|---|
| isMobile | Boolean state: `window.innerWidth < 768` |
| channelOffset | Integer: first camera index shown in the current layout page |
| Bottom Navigation Bar | Fixed 52 px bar at bottom of mobile viewport replacing the desktop sidebar |
| Page | A set of `def.channels` cameras shown in the grid at one time |
| Swipe Threshold | Minimum horizontal touch travel of 40 px required to trigger a page change |

---

## 2. System Overview

```
App.tsx
  ├─ isMobile = window.innerWidth < 768
  │
  ├─ [Desktop: isMobile=false]
  │    └─ Right sidebar (width 180–600 px)
  │
  └─ [Mobile: isMobile=true]
       ├─ Compact Header (44 px)
       ├─ Content Area (flex-1, overflow-y-auto)
       │    └─ Active tab content (Cameras / Alerts / Zones / Detections / Analytics)
       └─ Bottom Navigation Bar (52 px, fixed)
```

All Zustand stores (`cameraStore`, `alertStore`, `crossCameraStore`, `discoveryStore`, `webrtcConfigStore`) are shared between mobile and desktop modes.

---

## 3. Functional Requirements — Breakpoint Detection

### FR-UI-MOB-001 — Mobile State Initialization

On component mount, `isMobile` shall be initialized synchronously from `window.innerWidth < 768` to avoid a flash of the wrong layout.

### FR-UI-MOB-002 — Resize Listener

A `resize` event listener shall update `isMobile` whenever `window.innerWidth` changes. The listener shall be removed on component unmount.

### FR-UI-MOB-003 — Mobile/Desktop Mode Switching

When `isMobile === true`, the desktop right sidebar shall be hidden and the bottom navigation bar shall be shown. When `isMobile === false`, the bottom navigation bar shall be hidden and the right sidebar shall be shown. Mode switching shall be seamless on resize.

### FR-UI-MOB-004 — Store Continuity on Mode Switch

All Zustand store state (selected camera, alert count, cross-camera events) shall be preserved when switching between mobile and desktop modes via resize.

---

## 4. Functional Requirements — Mobile Header

### FR-UI-MOB-010 — Header Layout (Mobile)

The mobile header bar shall be 44 px high and contain, left to right:
- LTS logo + app title
- Connection status dot (right of logo)
- `flex-1` spacer
- Camera count badge (`N/M Live`, small text)
- Settings icon (far right)

### FR-UI-MOB-011 — LayoutPicker Hidden on Mobile

The LayoutPicker dropdown shall be hidden in the mobile header. Layout selection shall be handled by the simplified picker in the Cameras tab.

### FR-UI-MOB-012 — Settings Modal Access

The settings icon in the mobile header shall open the same Settings Modal used on desktop (language selection + WebRTC STUN/TURN configuration).

---

## 5. Functional Requirements — Bottom Navigation Bar

### FR-UI-MOB-020 — Bar Structure

The bottom navigation bar shall be fixed at the bottom of the viewport (`position: fixed; bottom: 0`), 52 px high, with background `bg-gray-900 border-t border-gray-700`. It shall contain 5 tabs:

| Tab | Icon | Content Component |
|---|---|---|
| Cameras | 📷 | CameraGrid (top) + CameraList (bottom) |
| Alerts | 🔔 | AlertPanel fullscreen |
| Zones | 🗺 | Zone guidance message + double-click hint |
| Detections | 👁 | Camera selection dropdown + DetectionPanel |
| Analytics | 🤖 | VideoAnalyticsTab fullscreen |

### FR-UI-MOB-021 — Tab Label Style

- Icon: `text-xl` (20 px)
- Label: `text-[9px]`
- Active: `text-blue-400`; Inactive: `text-gray-500`
- Active tab: blue underline indicator at top of button

### FR-UI-MOB-022 — Alerts Tab Notification Badge

The Alerts tab icon shall display a numeric badge at its top-right showing the unacknowledged alert count, using the same logic as the desktop sidebar badge (red circle, shows `9+` if count ≥ 10). The badge shall update in real time.

### FR-UI-MOB-023 — Touch Target Size

Each bottom navigation button shall be at least 44 × 44 px to meet touch target requirements.

---

## 6. Functional Requirements — Cameras Tab

### FR-UI-MOB-030 — Vertical Split Layout

On the Cameras tab, the content area shall be divided vertically:
- Top area (~60%): `CameraGrid` component
- Bottom area (~40%): `CameraList` component (scrollable)

### FR-UI-MOB-031 — Default Layout on Mobile

The CameraGrid in the mobile Cameras tab shall default to layout `1` (single channel).

### FR-UI-MOB-032 — Simplified Layout Picker

A small icon-only button at the top-right of the Cameras tab shall offer three layout options: `1` (1-channel), `4` (4-channel), `9` (9-channel). Selecting a layout shall reset `channelOffset` to 0.

### FR-UI-MOB-033 — Swipe Left/Right Channel Navigation

When registered cameras exceed the current layout's channel count, the entire Cameras tab (CameraGrid + CameraList) shall respond to swipe gestures:
- Swipe left (deltaX ≤ -40 px): advance `channelOffset` by current layout's channel count
- Swipe right (deltaX ≥ +40 px): decrease `channelOffset` by current layout's channel count
- Swipes of < 40 px horizontal travel shall be ignored

Touch events shall be captured via `onTouchStart` / `onTouchEnd` on the Cameras tab root `div`.

### FR-UI-MOB-034 — channelOffset Bounds

`channelOffset` shall be clamped: minimum 0, maximum `(totalCameras - channelCount)` rounded up to the nearest page boundary.

### FR-UI-MOB-035 — Page Dot Indicator

When total pages ≥ 2, a dot indicator shall be displayed at the bottom center of the CameraGrid area:
- Current page dot: `bg-blue-400`
- Inactive page dots: `bg-gray-600`
- The indicator shall update immediately after each swipe

### FR-UI-MOB-036 — N/M Page Badge

A `N/M` badge (current page / total pages) shall be displayed at the top-left of the CameraGrid when total pages ≥ 2.

### FR-UI-MOB-037 — CameraList Double-Tap Fullscreen

Double-tapping a camera row in the CameraList shall open the FullscreenCameraView overlay for that camera.

---

## 7. Functional Requirements — Other Mobile Tabs

### FR-UI-MOB-040 — Alerts Tab

The Alerts tab shall render `AlertPanel` fullscreen in the content area.

### FR-UI-MOB-041 — Zones Tab

The Zones tab shall render a zone guidance message with double-click hint (same text as the desktop sidebar Zones tab).

### FR-UI-MOB-042 — Detections Tab

The Detections tab shall contain a camera selection dropdown and `DetectionPanel` in fullscreen mode (category filter bar, scrollable detection list, Cross-Camera Re-ID feed, collapsible legend).

### FR-UI-MOB-043 — Analytics Tab

The Analytics tab shall render `VideoAnalyticsTab` fullscreen.

### FR-UI-MOB-044 — Tab State Persistence

Switching between bottom navigation tabs shall not reset any Zustand store state (alerts, selected camera, detection data, etc.).

---

## 8. Functional Requirements — Mobile Fullscreen Overlay

### FR-UI-MOB-050 — Vertical Split Fullscreen

On mobile, the Fullscreen Camera overlay shall use a vertical split:
- Top 60%: `CameraView` (video)
- Bottom 40%: `DetectionPanel` (scrollable)

On desktop the same `FullscreenCameraView` component uses a horizontal split (video left / DetectionPanel right).

### FR-UI-MOB-051 — Fullscreen Close and Zone Editor

The close button (`✕`) and zone editor entry button shall remain accessible in the mobile fullscreen overlay.

### FR-UI-MOB-052 — Fullscreen Entry from CameraGrid

Double-tapping a camera cell in the CameraGrid on the Cameras tab shall open the FullscreenCameraView overlay.

---

## 9. Non-Functional Requirements

### 9.1 Responsiveness

- The mobile layout shall render correctly on viewport widths from 320 px to 767 px
- The desktop layout shall not be affected by mobile-specific code changes
- The layout shall not produce horizontal scrolling at any supported mobile viewport width
- Font sizes and icon sizes shall remain legible (minimum 9 px label text) at 320 px width

### 9.2 Performance

- Layout switch on resize shall reflow within 100 ms of `window.resize` event
- Swipe-triggered page change shall update the grid within 50 ms of touch end
- Bottom navigation tab switch shall render the target component within 100 ms

### 9.3 Touch Interaction

- Swipe detection shall be passive (non-blocking) to avoid interfering with native scroll
- Touch targets for all interactive elements shall be ≥ 44 × 44 px
- The simplified layout picker button shall be reachable with a single thumb while holding the device

### 9.4 Accessibility

- All bottom navigation buttons shall have an `aria-label` attribute
- Active tab shall have `aria-current="page"` or equivalent ARIA state
- The Alerts badge shall have an `aria-label` describing the unread count

### 9.5 Internationalization

- All user-visible strings shall use i18n keys from `useI18n` and shall support all 15 configured languages

---

## 10. Interface Requirements

### 10.1 Touch Event Handling

```typescript
// Swipe detection on Cameras tab
onTouchStart: (e) => { startX = e.touches[0].clientX; }
onTouchEnd:   (e) => {
  const deltaX = e.changedTouches[0].clientX - startX;
  if (Math.abs(deltaX) >= 40) {
    if (deltaX < 0) setChannelOffset(prev => Math.min(prev + channels, maxOffset));
    else            setChannelOffset(prev => Math.max(prev - channels, 0));
  }
}
```

### 10.2 Breakpoint Detection

```typescript
const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

useEffect(() => {
  const handler = () => setIsMobile(window.innerWidth < 768);
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}, []);
```

### 10.3 Reused Desktop Components

| Component | Mobile Usage |
|---|---|
| `CameraGrid` | Cameras tab top 60% |
| `CameraList` | Cameras tab bottom 40% |
| `AlertPanel` | Alerts tab fullscreen |
| `DetectionPanel` | Detections tab and Fullscreen overlay bottom panel |
| `VideoAnalyticsTab` | Analytics tab fullscreen |
| `FullscreenCameraView` | Overlay on double-tap, vertical split on mobile |
| Settings Modal | Opened via header settings icon |

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | The 768 px breakpoint is detected via `window.innerWidth`, not CSS media queries |
| C-02 | All Zustand stores are shared between mobile and desktop; no mobile-specific stores are created |
| C-03 | `sidebarWidth` is a desktop-only concept; it is not used or shown in mobile mode |
| C-04 | The simplified layout picker offers only 1, 4, and 9-channel options on mobile |
| C-05 | Tablet-specific intermediate layout (768–1024 px) is deferred to Phase-2 |
| C-06 | Touch-based zone drawing in ZoneEditor is not specified for mobile in this release |
| C-07 | `channelOffset` state is shared between desktop `‹`/`›` buttons and mobile swipe navigation |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Mobile Layout |
