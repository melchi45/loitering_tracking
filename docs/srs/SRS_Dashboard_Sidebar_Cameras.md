# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Dashboard Sidebar — Cameras Panel

| | |
|---|---|
| **Document ID** | SRS-LTS-UI-CAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_Dashboard_Sidebar_Cameras.md |
| **Parent RFP** | rfp/RFP_Dashboard_Sidebar_Cameras.md |
| **Child Design** | design/Design_Dashboard_Sidebar_Cameras.md |
| **Child TC** | tc/TC_Dashboard_Sidebar_Cameras.md |
| **Test Script** | test/api/sidebar_cameras.test.js |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Panel Header](#3-functional-requirements--panel-header)
4. [Functional Requirements — Added Tab (Registered Cameras)](#4-functional-requirements--added-tab-registered-cameras)
5. [Functional Requirements — Camera Add/Edit Modals](#5-functional-requirements--camera-addedit-modals)
6. [Functional Requirements — Found Tab (Camera Discovery)](#6-functional-requirements--found-tab-camera-discovery)
7. [Functional Requirements — Discovered Camera Panel](#7-functional-requirements--discovered-camera-panel)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Interface Requirements](#9-interface-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the Cameras Panel of LTS-2026. Each requirement is identified by a unique ID (FR-UI-CAM-NNN) and is directly traceable to test cases in TC_Dashboard_Sidebar_Cameras.md.

### 1.2 Scope

This document covers:
- Panel header with connection status and add button
- Added sub-tab: registered camera list, status dots, action buttons
- Camera Add and Edit modals (RTSP and YouTube)
- Found sub-tab: ONVIF/UDP discovery, search/filter, device rows
- DiscoveredCameraPanel overlay for device details

Out of scope: camera drag-and-drop reorder (Phase-2), bulk deletion, RTSP URL pre-validation (Phase-2).

### 1.3 Definitions

| Term | Definition |
|---|---|
| CameraStore | Zustand store: `cameras[]`, `selectedId`, actions `setCameras`, `addCamera`, `updateCamera`, `removeCamera`, `updateCameraStatus`, `selectCamera` |
| DiscoveryStore | Zustand store: `cameras[]`, `selected`, `scanning` |
| StatusDot | Color-coded circle indicating camera pipeline status |
| pipelineStatus | Live status returned by `pipelineManager.getCameraStatus()` |
| RTSP Camera | A camera stream sourced from an RTSP URL |
| YouTube Channel | A virtual camera stream ingested via yt-dlp from a YouTube URL |

---

## 2. System Overview

```
App.tsx
  └─ Cameras Panel (sidebar tab)
       ├─ Added Sub-Tab
       │    └─ Camera rows (CameraStore.cameras[])
       │         ├─ POST /api/cameras            (add)
       │         ├─ PUT  /api/cameras/:id        (edit)
       │         ├─ DELETE /api/cameras/:id      (delete)
       │         ├─ POST /api/cameras/:id/stream/reconnect
       │         └─ POST /api/cameras/:id/ai/toggle
       └─ Found Sub-Tab
            └─ Discovered device rows (DiscoveryStore.cameras[])
                 └─ Socket.IO: discovery:result, discovery:scanning, discovery:cleared
```

---

## 3. Functional Requirements — Panel Header

### FR-UI-CAM-001 — Panel Header Structure

The Cameras Panel header shall display, left to right:
- Title "Cameras" (`text-sm font-bold text-white`)
- Connection status dot: green pulsing (`bg-green-500 animate-pulse`) when Socket.IO connected, solid red (`bg-red-500`) when disconnected
- "+ Add" button (`bg-green-700 hover:bg-green-600 text-[11px]`) that opens the Camera Add Modal

### FR-UI-CAM-002 — Sub-Tab Structure

The panel shall have two sub-tabs: **Added (N)** and **Found (N)**, where N is the respective camera count.

- Active tab: `text-blue-400 border-b-2 border-blue-400`
- Inactive tab: `text-gray-500 hover:text-gray-300`
- Font: `text-[11px] font-semibold uppercase`

A blue animated ping dot (`w-1.5 h-1.5 bg-blue-400 animate-ping`) shall appear inside the Found tab label while scanning is active.

### FR-UI-CAM-003 — Auto Tab Switch on Discovery

When the first `discovery:result` Socket.IO event is received, the panel shall automatically switch to the Found tab. This auto-switch shall occur only once per discovery session (controlled by `autoSwitched` flag).

### FR-UI-CAM-004 — Auto Tab Switch Back to Added on Camera Registration

When the number of registered cameras increases (i.e., a new camera is successfully added) while the Found sub-tab is currently active, the panel shall automatically switch back to the Added sub-tab.

- Implementation: `CameraList.tsx` maintains a `prevCamerasLen` ref; a `useEffect` that depends on `[cameras.length, tab]` detects the count increase and calls `setTab('added')`.
- Condition: Applies only when `tab === 'found'` at the moment the count increases.
- No switch occurs if the user is already on the Added tab when the camera is added.

---

## 4. Functional Requirements — Added Tab (Registered Cameras)

### FR-UI-CAM-010 — Empty State

When no cameras are registered, the Added tab shall display: "No cameras yet. Use + Add or select from Found." (`text-xs text-gray-500 text-center mt-6`).

### FR-UI-CAM-011 — Camera Row Fields

Each registered camera row shall display:
- StatusDot: color circle reflecting camera status (see §8 color spec)
- Camera name: `text-xs font-semibold text-white truncate`
- YT badge: shown for YouTube channels only — `bg-red-700 text-white text-[9px]`
- Sub-info line: `cam.ip` for RTSP cameras; truncated `cam.youtubeUrl` for YouTube cameras (full URL on hover via `title` attribute)
- Action buttons: hidden until row hover (`opacity-0 group-hover:opacity-100`)

### FR-UI-CAM-012 — StatusDot Color Specification

| Status | Color |
|---|---|
| `live` | `bg-green-500` |
| `error` | `bg-red-500` |
| `offline` | `bg-gray-500` |
| `connecting`, `streaming`, `reconnecting`, `idle` | `bg-yellow-500` |

Status shall update in real time via Socket.IO `camera:status` events dispatched to `CameraStore.updateCameraStatus()`.

### FR-UI-CAM-013 — Action Button Behaviors

| Button | Label | API | Effect |
|---|---|---|---|
| Edit | `✎` | Opens `CameraEditModal` | — |
| Reconnect | `↺` | `POST /api/cameras/:id/stream/reconnect` | Shows "Reconnecting…" for 2 s (`text-[9px] text-yellow-400 animate-pulse`) |
| AI Toggle | `AI` | `POST /api/cameras/:id/ai/toggle` | Toggles AI inference; green (`text-green-400`) when on, gray (`text-gray-600`) when off |
| Delete | `✕` | Confirm → `DELETE /api/cameras/:id` | Removes from list |

### FR-UI-CAM-014 — AI Toggle Visual States

| State | CSS | Tooltip |
|---|---|---|
| AI On | `text-green-400 hover:text-green-300` | "AI On — click to disable" |
| AI Off | `text-gray-600 hover:text-gray-400` | "AI Off — click to enable" |

AI Toggle default is `true` (enabled). When disabled, raw JPEG frames continue streaming but detection/tracking/alerts are suspended.

### FR-UI-CAM-015 — Camera Row Click Behaviors

| Event | Behavior |
|---|---|
| Single click | `CameraStore.selectCamera(id)` |
| Double-click | Reconnect (distinguished from single-click by 300 ms delay) |
| Right-click | Open `CameraEditModal` directly |

### FR-UI-CAM-016 — Selected Camera Row Style

The currently selected camera row shall apply `bg-blue-900/50 border-blue-600`. Unselected rows shall apply `bg-gray-800 border-gray-700 hover:bg-gray-700 hover:border-gray-600`.

---

## 5. Functional Requirements — Camera Add/Edit Modals

### FR-UI-CAM-020 — Camera Add Modal Container

The Camera Add Modal shall render as `fixed inset-0 z-50 bg-black/70` when opened.

### FR-UI-CAM-021 — RTSP Camera Add Fields

The RTSP Camera Add form shall provide: Name (required), RTSP URL (required), Username, Password, WebRTC Enabled toggle (default `false`).

Submit shall call `POST /api/cameras`. On success: `CameraStore.addCamera()` and switch to Added tab.

### FR-UI-CAM-022 — RTSP Validation Error

Missing Name or RTSP URL shall display the error message `"Name and RTSP URL are required."`. API errors shall display the server-returned message.

### FR-UI-CAM-023 — YouTube Channel Add Fields

The YouTube Channel Add form shall provide: Channel Name (required), YouTube URL (required), Resolution (1080p/720p/480p, default 1080p), Bitrate (number, default 2000 kbps), Repeat Playback (checkbox, default `false`).

Submit shall call `POST /api/youtube-streams`. While the server prepares the stream, elapsed time shall be shown as "Starting stream… Xs". The modal shall close when `live` status is confirmed.

### FR-UI-CAM-024 — YouTube Error Codes

The following YouTube error codes shall be mapped to user-facing messages: `INVALID_YOUTUBE_URL`, `YT_DLP_FAILED`, `MAX_STREAMS_REACHED`, `STREAM_TIMEOUT`.

### FR-UI-CAM-025 — Repeat Playback Behavior

When Repeat Playback is enabled, the video stream shall restart immediately on natural end (FFmpeg exit code 0), bypassing the MAX_RESTARTS(5) limit.

### FR-UI-CAM-026 — Camera Edit Modal Pre-Population

The Camera Edit Modal shall pre-populate all fields with the current camera values. For RTSP cameras it shall provide two save options:
- "Save" → `PUT /api/cameras/:id`
- "Save & Reconnect" → `PUT /api/cameras/:id` then `POST /api/cameras/:id/stream/reconnect`

### FR-UI-CAM-027 — Camera Edit Auto-Restart

If only `webrtcEnabled` changes (no URL or auth change), the server shall auto-restart the pipeline.

### FR-UI-CAM-028 — YouTube Edit

YouTube camera editing shall call `PATCH /api/youtube-streams/:id`.

### FR-UI-CAM-029 — Edit Modal Save Feedback

The save button shall show "Saving…" (disabled) → "Saved." or "Saved & reconnecting…", then the modal shall close after 0.8 s. Errors shall be displayed as red text.

---

## 6. Functional Requirements — Found Tab (Camera Discovery)

### FR-UI-CAM-030 — Found Tab Header

The Found tab header shall display:
- "● Scanning…" (blue ping dot) while `DiscoveryStore.scanning === true`
- "N device(s) found" on scan completion
- "Waiting…" if no devices found
- "Clean" button that resets discovery results and sends `discovery:rescan` Socket event

### FR-UI-CAM-031 — Full-Text Search Bar

A search bar shall filter the discovered device list across 11 fields: Model, Manufacturer, IPAddress, MACAddress, Gateway, SubnetMask, HttpPort, HttpsPort, Port (RTSP), URL (DDNS), rtspUrl.

Virtual category keywords shall apply additional filtering:
- `onvif` → matches `SupportOnvif=true` or `source=onvif/both`
- `sunapi`, `wisenet`, `hanwha` → matches `SupportSunapi=true`
- `udp`, `wisenet`, `hanwha` → matches `source=udp/both`

Matched field names shall be shown as yellow badges on each row. Result count shall show as "N / M match" (`text-[10px] text-gray-500`). A clear (`×`) button shall appear when a query is active.

### FR-UI-CAM-032 — Discovered Device Row

Each discovered device row shall display:
- Blue dot + device name (falls back to IP if no Model)
- Sub-text: `Manufacturer · IPAddress`
- SUNAPI badge (`bg-green-900 text-green-400`) based on `SupportSunapi`
- ONVIF badge (`bg-purple-900 text-purple-300`) based on `SupportOnvif`

### FR-UI-CAM-033 — Device Row Click — Show Panel

Clicking a discovered device row shall call `DiscoveryStore.select(cam)` and show the `DiscoveredCameraPanel` overlay. Clicking the same row again shall deselect and hide the overlay.

---

## 7. Functional Requirements — Discovered Camera Panel

### FR-UI-CAM-040 — Panel Positioning and Content

`DiscoveredCameraPanel` shall be positioned `absolute` relative to the Camera Grid. It shall display: device name/model, manufacturer, IP, MAC, RTSP URL, ONVIF/SUNAPI support, HTTP/HTTPS ports, firmware version.

### FR-UI-CAM-041 — Add as Camera Action

The "Add as camera" button shall auto-fill the Camera Add Modal with the device's data (name, RTSP URL, IP) and open the modal.

### FR-UI-CAM-042 — Close Action

The "Close" button shall call `DiscoveryStore.select(null)`, hiding the overlay.

---

## 8. Non-Functional Requirements

### 8.1 Performance

- The camera list shall re-render within 100 ms of receiving a `camera:status` Socket.IO event
- The search filter in the Found tab shall respond within 50 ms of keystroke

### 8.2 Reliability

- Camera deletion shall call `DELETE /api/cameras/:id` only after user confirmation
- Reconnect shall show a "Reconnecting…" indicator for exactly 2 seconds regardless of API response time

### 8.3 Responsiveness

- Camera rows and action buttons shall be fully visible at sidebar widths from 180 px to 600 px
- Touch targets for action buttons shall be ≥ 44 × 44 px

### 8.4 Internationalization

- All user-visible strings shall use i18n keys from `useI18n` and shall support all 15 configured languages

---

## 9. Interface Requirements

### 9.1 REST API Summary

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/cameras` | Fetch registered cameras on mount |
| POST | `/api/cameras` | Add RTSP camera |
| PUT | `/api/cameras/:id` | Update camera config |
| DELETE | `/api/cameras/:id` | Delete camera |
| POST | `/api/cameras/:id/stream/reconnect` | Reconnect stream |
| POST | `/api/cameras/:id/ai/toggle` | Toggle AI inference |
| POST | `/api/youtube-streams` | Add YouTube channel |
| GET | `/api/youtube-streams/:id/status` | Poll YouTube stream status |
| PATCH | `/api/youtube-streams/:id` | Update YouTube channel |

### 9.2 Socket.IO Events

| Event | Direction | Handler |
|---|---|---|
| `cameras` | S→C | `CameraStore.setCameras()` |
| `camera:status` | S→C | `CameraStore.updateCameraStatus()` |
| `discovery:result` | S→C | `DiscoveryStore.addOrUpdate()` + auto tab switch |
| `discovery:scanning` | S→C | `DiscoveryStore.setScanning()` |
| `discovery:cleared` | S→C | `DiscoveryStore.clearFound()` |
| `discovery:rescan` | C→S | Request scan reset and restart |

### 9.3 Camera Add Request Body

```typescript
interface CameraAddRequest {
  name:           string;   // required
  rtspUrl:        string;   // required
  username?:      string;
  password?:      string;
  webrtcEnabled?: boolean;  // default: false
}
```

---

## 10. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Camera passwords are never exposed in `GET /api/cameras` responses |
| C-02 | AI toggle default is `true`; `aiEnabled` is stored in the DB alongside camera config |
| C-03 | YouTube stream preparation is asynchronous; the client polls `GET /api/youtube-streams/:id/status` |
| C-04 | ONVIF/UDP discovery results are delivered solely via Socket.IO; no REST endpoint returns discovered devices |
| C-05 | Camera drag-and-drop reorder is deferred to Phase-2 |
| C-06 | RTSP URL pre-validation before submission is deferred to Phase-2 |
| C-07 | Bulk deletion of multiple cameras is not in scope for this release |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Dashboard Sidebar Cameras |
| 1.1 | 2026-06-16 | LTS Engineering Team | FR-UI-CAM-004 추가 — Found 탭 활성 상태에서 카메라 등록 시 Added 탭 자동 전환 요구사항 |
