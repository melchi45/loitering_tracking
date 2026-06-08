# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Dashboard Full-Screen Layout and Configuration

| | |
|---|---|
| **Document ID** | PRD-LTS-010 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Dashboard_Layout.md (LTS-2026-010 v2.0) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [UI/UX Requirements](#5-uiux-requirements)
6. [Technical Requirements](#6-technical-requirements)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

The LTS Dashboard provides security operators with a full-screen, real-time multi-camera monitoring interface that supports flexible grid layouts, live alert visibility, and instant access to zone management — all within a single-page dark-themed application requiring no page reloads.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Provide a full-screen dashboard divided into a Top Bar, Camera Grid (main area), and a fixed 288px right Sidebar.
- Support 16 camera layout configurations (equal grid and featured 1-main+sub variants) switchable via a LayoutPicker dropdown.
- Persist the selected layout and user language preference across sessions using `localStorage`.
- Display real-time Socket.IO connection status, live camera count, and unacknowledged alert badges in the Top Bar.
- Enable fullscreen camera overlay (double-click) and a Settings Modal (gear icon) from the Top Bar.
- Support 15 UI languages including RTL (Arabic) via an i18n system with immediate `onChange` application.

### 2.2 Non-Goals

- This document does not cover the internal content of Sidebar tabs (Cameras, Alerts, Zones, Detections, Analytics) — those are specified in their respective RFPs.
- Mobile/tablet responsive layout is out of scope for this PRD (covered by PRD_Mobile_Layout.md).
- Camera drag-and-drop reordering is not required in this release.

---

## 3. User Personas

**Security Operator** — monitors multiple camera feeds simultaneously from a control room workstation. Needs quick access to alerts, layout switching, and fullscreen investigation of individual cameras.

**System Administrator** — configures WebRTC settings, manages language preferences, and ensures the dashboard reflects live connection status. Uses the Settings Modal to manage STUN/TURN servers.

**Site Supervisor** — reviews alert history and zone configurations during shift handovers. Primarily uses the Sidebar tabs without changing layout configurations.

---

## 4. Functional Specification

### 4.1 Top Bar

The Top Bar is a `flex-shrink-0` header (~40px) containing, left to right:
- LTS logo badge (`bg-blue-600 w-6 h-6`)
- App title (i18n key `appTitle`)
- Socket.IO connection status indicator: green pulse (●LIVE) when connected, solid red (●DISC) when disconnected
- Spacer (`flex-1`)
- Live camera count in `{live}/{total} LIVE` format
- LayoutPicker dropdown button
- Settings gear icon button opening the Settings Modal

### 4.2 Camera Grid

The `CameraGrid` component fills the main content area and supports 16 layouts defined by `LayoutId`:

- **Equal Grid**: `1`, `2`, `4`, `5`, `8`, `9`, `12`, `16`, `24`, `32`, `64` — rendered as CSS `display:grid` with `repeat(cols, 1fr)` columns and rows.
- **Featured (1 Main + Sub)**: `1+3`, `1+4`, `1+7`, `1+11`, `1+15` — rendered as CSS `display:flex` with a large main cell and a sub-grid panel.

Camera cell behaviors:
- Single click selects the camera (highlighted with `ring-2 ring-blue-500`)
- Double-click enters the Fullscreen Overlay
- YouTube channels show a red `YT` badge; error state shows a black overlay with restart button (hidden in compact mode)
- Compact mode activates at 16+ channels: hides camera name labels and restart buttons, shows a small channel index chip

Channel page navigation: when registered cameras exceed the layout channel count, `‹` / `›` overlay buttons allow advancing by one layout-page at a time. The `channelOffset` state resets on layout change.

### 4.3 LayoutPicker

A `w-72` dropdown panel showing two sections:
- **Equal Grid**: 1, 2, 4, 5, 8, 9, 12, 16, 24, 32, 64
- **1 Main + Sub**: 1+3, 1+4, 1+7, 1+11, 1+15

Each button shows a 20×20 SVG `LayoutIcon` + label. Active layout uses `bg-blue-600 text-white`. Selected layout persisted to `localStorage` key `lts-layout`; defaults to `'1'` on mobile (`< 768px`) or `'4'` on desktop.

### 4.4 Sidebar

Fixed `w-72` right panel with mode-dependent tabs. The Alerts tab shows a red badge with unacknowledged alert count (shows `9+` when ≥ 10). Active tab: `text-blue-400 border-b-2 border-blue-400`.

**Mode policy (`SERVER_MODE`):**
- `combined`: CAMERAS, ALERTS, ZONES, DETECTIONS, ANALYTICS, 🪪 FACE ID
- `streaming`: CAMERAS, ALERTS, ZONES, DETECTIONS, 🪪 FACE ID (ANALYTICS hidden)
- `analysis`: ALERTS, ZONES, DETECTIONS, ANALYTICS, 🪪 FACE ID (CAMERAS hidden)

| Tab ID | Label | Component | Notes |
|---|---|---|---|
| `cameras` | CAMERAS | `CameraList` | Default active tab |
| `alerts` | ALERTS | `AlertPanel` | Red badge when alerts > 0 |
| `zones` | ZONES | ZoneHint / `ZoneEditor` | — |
| `detections` | DETECTIONS | `DetectionPanel` | Selected camera only |
| `analytics` | ANALYTICS | `VideoAnalyticsTab` | AI enable/disable |
| `faces` | 🪪 FACE ID | `FaceGalleryTab` | Gallery CRUD + real-time match log |

The **Face ID tab** (`faces`) allows operators to:
1. Create named galleries (missing / vip / blocklist / general)
2. Enroll persons by uploading JPEG/PNG photos → SCRFD + ArcFace inference on server
3. View real-time face-match events via Socket.IO `face_match` events
4. Delete individual face cards or whole galleries

All named gallery data persists in `storage/lts.json`; person trajectory metadata (faceId, alias P1/P2…, camera segments) persists in `storage/face_tracking.json` and survives server restarts.

### 4.5 Fullscreen Overlay

`fixed inset-0 z-50 bg-black/90` rendered on camera cell double-click. Contains a `CameraView` (WebRTC or JPEG), a canvas overlay (bounding boxes, labels), a right panel with Detection List and Cross-Camera Re-ID feed, a Zone Editor entry button, and a close button (`×` or `ESC` key).

### 4.6 Settings Modal

`w-96` modal opened via the gear icon. Contains:
- **Language selection**: `<select>` dropdown with 15 languages (flag emoji + name), applied immediately on change, persisted to `localStorage` key `lts-language`.
- **WebRTC settings**: enable/disable toggle, STUN server list, TURN server list (with add/delete), Apply button. Persisted to `localStorage` key `lts-webrtc-config`.

### 4.7 WebRTC ICE Debug Panel

When a camera uses WebRTC and is connected, an `[ICE]` button appears in the top-right of `CameraView`. Clicking toggles a debug panel showing local/remote ICE candidate type (host=green, srflx=yellow, relay=orange), address:port, and bytes sent/received. Stats polled every 3 seconds via `RTCPeerConnection.getStats()`.

### 4.8 Discovered Camera Panel

An `absolute`-positioned overlay above the Camera Grid, shown when a device from the Found tab is selected in `DiscoveryStore`. Closed by calling `select(null)`.

---

## 5. UI/UX Requirements

### 5.1 Layout Dimensions

| Area | Width | Height | CSS |
|------|-------|--------|-----|
| Full app container | 100vw | 100vh | `flex flex-col h-screen overflow-hidden` |
| Top Bar | 100% | ~40px | `flex-shrink-0` |
| Content Row | 100% | Remaining | `flex flex-1 overflow-hidden` |
| Camera Grid | Remaining | 100% | `flex-1 overflow-hidden p-2` |
| Sidebar | 288px | 100% | `w-72 flex-shrink-0` |

### 5.2 Color Theme (Dark)

| Area | Background |
|------|-----------|
| Full app | `bg-gray-900` (#111827) |
| Top Bar, Sidebar | `bg-gray-800` (#1F2937) |
| Empty camera cell | `bg-gray-800` |
| Selected camera cell | `ring-2 ring-blue-500` |

### 5.3 Z-Index Layers

| Layer | z-index |
|-------|---------|
| Base UI | 0 |
| ICE Panel | z-20 |
| Fullscreen Overlay | z-50 |
| Settings Modal | z-50 |

### 5.4 Channel Navigation Buttons

- Previous `‹`: `absolute left-3 top-1/2`, `bg-black/60 w-8 h-14 rounded-r-lg`
- Next `›`: `absolute right-3 top-1/2`, `bg-black/60 w-8 h-14 rounded-l-lg`
- Visible only when navigation is possible (offset > 0 or more pages remain)

### 5.5 i18n Behavior

- Language stored in `localStorage` key `lts-language`; loaded on `I18nProvider` mount
- Arabic (`ar`) triggers `<html dir="rtl">`
- Browser language auto-detected; falls back to `en`

---

## 6. Technical Requirements

### 6.1 Frontend Stack

- React with TypeScript
- Tailwind CSS (dark theme, `bg-gray-800/900` palette)
- Zustand for global state management
- Socket.IO client for real-time camera/alert data
- `localStorage` for layout, language, and WebRTC config persistence

### 6.2 State Stores

| Store | Key State |
|-------|-----------|
| `useCameraStore` | `cameras[]`, `selectedId` |
| `useAlertStore` | `alerts[]` |
| `useDiscoveryStore` | `cameras[]`, `selected`, `scanning` |
| `useCrossCameraStore` | `events[]` |
| `useWebRTCConfigStore` | `enabled`, `stunUrls[]`, `turns[]` |

### 6.3 Socket.IO Events (Dashboard Level)

| Event | Direction | Effect |
|-------|-----------|--------|
| `connect` / `disconnect` | S→C | Update connection status |
| `cameras` | S→C | `setCameras()` |
| `camera:status` | S→C | `updateCameraStatus()` |
| `alert` | S→C | `addAlert()` |
| `cross-camera:reid` | S→C | `addCrossCameraEvent()` |

### 6.4 Performance

- Entire app uses `overflow-hidden` (no page scroll)
- Settings Modal interior uses `overflow-y-auto` with `max-h-[88vh]`
- ICE stats polled at 3-second intervals (not on every frame)

### 6.5 Supported Resolutions

| Resolution | Behavior |
|------------|---------|
| 1920×1080+ | All 16 layouts fully supported |
| 1366×768 | Up to 16 channels recommended |
| < 768px | Mobile layout (see PRD_Mobile_Layout.md) |

---

## 7. Acceptance Criteria

1. The dashboard renders a Top Bar, Camera Grid, and fixed 288px Sidebar at all supported desktop resolutions without horizontal overflow.
2. All 16 layouts (11 equal grid + 5 featured) are selectable from the LayoutPicker dropdown, and the selection persists across page reloads via `localStorage`.
3. The Top Bar connection status indicator transitions between green pulse (connected) and solid red (disconnected) within 1 second of a Socket.IO state change.
4. Double-clicking a camera cell opens the Fullscreen Overlay; pressing `ESC` or clicking `×` closes it.
5. The Alerts tab badge correctly shows the unacknowledged alert count, updating in real time, and displays `9+` when count exceeds 9.
6. The Settings Modal opens from the gear icon, language selection applies immediately to all UI text, and WebRTC settings are saved and restored from `localStorage`.
7. Compact mode (≥ 16 channels) hides camera name labels and YouTube restart buttons and shows a small channel index chip instead.
8. The `‹` / `›` channel navigation buttons appear only when applicable and advance by the current layout's channel count.
9. The ICE debug panel appears only for WebRTC-connected cameras and displays correct candidate type color coding (host=green, srflx=yellow, relay=orange).
10. Arabic language selection applies `dir="rtl"` to the document root without breaking layout.

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|-----------|-------------|--------|-----------|--------|
| M1 | Core layout (Header / Grid / Sidebar) and LayoutPicker | TBD | Phase-1 done | ✅ Complete |
| M2 | Fullscreen Overlay, Settings Modal, ICE Debug Panel | TBD | Phase-1 done | ✅ Complete |
| M3 | Mobile/tablet responsive layout | TBD | - | ⏳ Pending |
| M4 | Alert audio notification | TBD | - | ⏳ Pending |
| M5 | Camera drag-and-drop reorder | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement mobile/tablet responsive layout (see PRD_Mobile_Layout.md for specification)
- [ ] Add alert audio notification integrated with AlertPanel
- [ ] Implement camera drag-and-drop reorder in the Camera Grid
- [ ] Add dashboard widget toggle for optional stats panels
- [ ] Implement native Fullscreen API (`requestFullscreen`) as an alternative to CSS fullscreen approach
- [ ] Add per-camera thumbnail preview in the camera list row
- [ ] Write unit tests for LayoutPicker persistence (localStorage read/write)
- [ ] Write integration tests for Socket.IO connection status indicator state transitions

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Dashboard Layout |
