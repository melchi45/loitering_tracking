# Software Requirements Specification
## Dashboard Layout — LTS-2026 Loitering Tracking System

| Field          | Value                                                      |
|----------------|------------------------------------------------------------|
| Document ID    | SRS-DLY-001                                                |
| Version        | 1.0                                                        |
| Date           | 2026-05-26                                                 |
| Parent RFP     | RFP_Dashboard_Layout.md                                    |
| Parent PRD     | PRD_Dashboard_Layout.md                                    |
| Status         | Approved                                                   |

---

## Table of Contents

1. Introduction
2. Scope
3. Functional Requirements (FR-DLY)
4. UI Specification
5. Socket.IO Events Consumed
6. REST API Used
7. Non-Functional Requirements

---

## 1. Introduction

This document specifies the requirements for the Dashboard Layout module of the LTS-2026 system. The layout governs the overall page structure rendered by `App.tsx`, including the header, collapsible sidebar, main camera grid, layout picker, fullscreen overlay, and responsive breakpoints.

---

## 2. Scope

- **In scope:** Desktop layout (≥ 768 px), mobile layout (< 768 px), header bar, sidebar tabs, camera grid area, layout picker, fullscreen modal, sidebar resize handle, channel paging, settings modal.
- **Out of scope:** Camera video decoding, zone polygon drawing, alert business logic.

---

## 3. Functional Requirements

### FR-DLY-001 — Application Shell
The application shall render a full-viewport shell (`h-screen`, `overflow-hidden`) with a dark background (`bg-gray-900`) on page load.

### FR-DLY-002 — Desktop Header Bar
On desktop (≥ 768 px) the header shall display: LTS logo badge, application title, Socket.IO connection status indicator (green pulsing dot when connected, red when disconnected), live camera count, layout picker, and settings gear button.

### FR-DLY-003 — Mobile Header Bar
On mobile (< 768 px) the header shall display: LTS logo badge, application title, connection status dot, live/total camera count, and settings gear button. The layout picker shall appear as a floating overlay inside the camera grid area.

### FR-DLY-004 — Sidebar Structure (Desktop)
The sidebar shall be rendered on the right side of the main area with a default width of 288 px and shall support resizing via a drag handle between 180 px and 600 px.

### FR-DLY-005 — Sidebar Resize Handle
A 4 px wide vertical divider between the main area and sidebar shall change color on hover (blue) and support mouse-drag resizing. Width shall be persisted within the current session.

### FR-DLY-006 — Sidebar Tab Navigation
The sidebar shall expose six tabs: Cameras, Alerts, Zones, Detections, Analytics, Face Gallery. The active tab shall be visually distinguished by a blue bottom border and blue text color. The Alerts tab shall display an unread count badge (red circle) when unacknowledged alerts exist.

### FR-DLY-007 — Camera Grid Area
The main content area shall render a `CameraGrid` component that fills all remaining horizontal and vertical space after header and sidebar are accounted for.

### FR-DLY-008 — Layout Picker
The header shall include a `LayoutPicker` dropdown showing grouped layout options: Equal Grid, 1 Main+Sub, 2 Main+Sub, 3 Main+Sub. Selecting a layout shall update the grid immediately and persist the choice to `localStorage` under key `lts-layout`.

### FR-DLY-009 — Supported Layout Modes
The system shall support the following grid channel counts: 1, 2, 4, 5, 8, 9, 12, 16, 24, 32, 64, and featured split layouts: 1+3, 1+4, 1+7, 1+11, 1+15, 2+2, 2+6, 2+10, 2+14, 3+5, 3+9, 3+13.

### FR-DLY-010 — Channel Paging (Desktop)
When the total number of registered cameras exceeds the current layout channel count, previous/next arrow buttons shall appear on the left and right edges of the grid, allowing the user to page through camera channels.

### FR-DLY-011 — Fullscreen Mode
Double-clicking a camera cell in the grid shall open `FullscreenCameraView` as a fixed overlay covering the full viewport. Pressing ESC or clicking the close button shall dismiss it.

### FR-DLY-012 — Mobile Bottom Navigation
On mobile the bottom navigation bar shall be 52 px high and display six icon+label buttons corresponding to the six sidebar tabs. The active tab shall show a blue indicator bar at the top of the button.

### FR-DLY-013 — Mobile Camera Tab Layout
When the active mobile tab is "Cameras," the screen shall be divided vertically: camera grid occupying 58% and camera list occupying 42% of the content area height.

### FR-DLY-014 — Swipe Gesture for Channel Paging (Mobile)
On the mobile Cameras tab the user shall be able to swipe left/right (minimum 40 px delta) to advance or retreat the channel page offset by one page. Page indicators (dots) and a numeric counter badge shall reflect the current page.

### FR-DLY-015 — Settings Modal
Clicking the settings gear button shall open a modal dialog containing language selection and WebRTC STUN/TURN configuration. The modal shall close on backdrop click or the Close button.

### FR-DLY-016 — Connection Status Persistence
The Socket.IO connection status indicator shall update in real time. When disconnected for more than 5 seconds a visible red indicator shall remain until reconnection is established.

### FR-DLY-017 — Layout Persistence on Reload
On page load the system shall restore the previously saved layout from `localStorage`. If no saved layout exists and the viewport is mobile (< 768 px), the default layout shall be '1'; otherwise '4'.

### FR-DLY-018 — Discovered Camera Overlay
When a discovered camera device is selected in the Found tab, a `DiscoveredCameraPanel` overlay shall appear anchored within the camera grid area and dismissed via its close button.

---

## 4. UI Specification

### 4.1 Layout Dimensions

| Region        | Desktop                         | Mobile                        |
|---------------|---------------------------------|-------------------------------|
| Header height | 44 px (py-2 + content)         | 44 px                         |
| Sidebar width | 180–600 px (default 288 px)    | N/A (bottom nav)              |
| Bottom nav    | N/A                             | 52 px                         |
| Main grid     | Remaining viewport              | 58% of content height         |

### 4.2 Color Tokens

| Element            | Tailwind Class         | Hex Approx |
|--------------------|------------------------|------------|
| Background         | bg-gray-900            | #111827    |
| Header/Sidebar bg  | bg-gray-800            | #1f2937    |
| Divider            | border-gray-700        | #374151    |
| Active tab         | text-blue-400          | #60a5fa    |
| Alert badge        | bg-red-600             | #dc2626    |
| Connected dot      | bg-green-500           | #22c55e    |

### 4.3 Interaction States

- Sidebar drag handle: default `bg-gray-700`, hover `bg-blue-500`, active drag `bg-blue-400`
- Layout picker button: active layout `bg-blue-600 text-white`, others `bg-gray-700 text-gray-300`
- Tab button: active `text-blue-400 border-b-2 border-blue-400`, inactive `text-gray-500`

---

## 5. Socket.IO Events Consumed

| Event Name               | Purpose                                           |
|--------------------------|---------------------------------------------------|
| `camera:status`          | Update camera live/offline status dot in header   |
| `alert:new`              | Increment unread alert badge on Alerts tab        |
| `face:reidentified`      | Propagate to cross-camera store                   |
| `person:trajectory-update` | Update person trail store                       |
| `discovery:result`       | Add device to discovered camera list              |
| `discovery:scanning`     | Show/hide scanning indicator in sidebar           |
| `discovery:cleared`      | Clear discovered camera list                      |
| `webrtc:ice-test-trigger`| Activate hidden ICE test video component          |
| `webrtc:ice-test-stop`   | Deactivate ICE test component                     |

---

## 6. REST API Used

| Method | Endpoint              | Purpose                                        |
|--------|-----------------------|------------------------------------------------|
| GET    | /api/cameras          | Fetch registered cameras on mount              |
| GET    | /api/persons/active   | Hydrate person trajectory store on mount       |
| GET    | /api/webrtc/ice-config | Seed STUN/TURN servers if no saved config     |

---

## 7. Non-Functional Requirements

### 7.1 Performance
- Initial render shall complete within 2 seconds on a modern browser with cached assets.
- Layout switch shall reflow the grid within 100 ms of selection.
- Sidebar drag shall track mouse position with no perceptible lag (< 16 ms per frame).

### 7.2 Accessibility
- All interactive elements shall have a `title` attribute or ARIA label.
- Focus shall remain trapped inside the settings modal while it is open.
- Color contrast ratio for all text on dark backgrounds shall meet WCAG 2.1 AA (4.5:1 minimum).

### 7.3 Responsiveness
- The desktop/mobile breakpoint shall be `768 px` (md breakpoint), detected via `window.innerWidth` and updated on `resize` events.
- The layout shall not produce horizontal scrolling at any supported viewport width.
- Touch targets on mobile shall be a minimum of 44 × 44 px.

### 7.4 Internationalization
- All user-visible strings shall be sourced from the i18n store (`useI18n`) and shall support all 15 configured languages without layout overflow.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Dashboard Layout |
