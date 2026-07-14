# RFP: Dashboard Sidebar — Cameras Panel

**Document No.**: LTS-2026-011  
**Version**: 1.2  
**Date**: 2026-07-14  
**Classification**: Technical Requirements Specification (RFP)  
**Status**: Written based on Phase-1 implementation  
**Related RFPs**: LTS-2026-010 (Dashboard Layout), LTS-2026-001 (Loitering Tracking System)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Panel Diagram](#2-panel-diagram)
3. [Panel Header](#3-panel-header)
4. [Sub-Tab Structure (Added / Found)](#4-sub-tab-structure-added--found)
5. [Added Tab — Registered Camera List](#5-added-tab--registered-camera-list)
6. [Found Tab — Auto-discovered Camera List](#6-found-tab--auto-discovered-camera-list)
7. [Camera Add Modal](#7-camera-add-modal)
8. [Camera Edit Modal (CameraEditModal)](#8-camera-edit-modal-cameraeditmodal)
9. [Discovered Camera Panel (Overlay)](#9-discovered-camera-panel-overlay)
10. [REST API Integration](#10-rest-api-integration)
11. [State Management](#11-state-management)
12. [Implementation Status](#12-implementation-status)

---

## 1. Overview

### 1.1 Purpose

This document defines the technical requirements for the **Cameras tab** panel of the LTS Dashboard right sidebar. The Cameras panel is responsible for displaying the list of IP cameras and YouTube virtual channels registered in the system, and managing cameras auto-discovered via ONVIF/WiseNet UDP protocols.

### 1.2 Scope

- Added tab: Registered camera list, status display, select/reconnect/edit/delete
- Found tab: Auto-discovered camera list, search filter, detail overlay
- Manual camera add Modal (RTSP / YouTube)
- Camera edit Modal
- Discovered Camera Panel overlay

---

## 2. Panel Diagram

### 2.1 Full Layout

```
┌──────────────────────────────────┐
│  Cameras  ●  [+ Add]            │  ← Header (flex, border-b)
├──────────────────────────────────┤
│  [Added (N)]  [Found (N)]        │  ← Sub-tabs
├──────────────────────────────────┤
│  ┌──────────────────────────────┐│
│  │ ● CameraName          ✎ ↺ ✕ ││  ← Camera row (Added tab)
│  │   192.168.x.x               ││
│  └──────────────────────────────┘│
│  ┌──────────────────────────────┐│
│  │ ● CameraName   [YT] ✎ ↺ ✕  ││
│  └──────────────────────────────┘│
│  ...                             │
└──────────────────────────────────┘

[When Found tab selected]
┌──────────────────────────────────┐
│  Scanning… [●]       [Clean]    │  ← Found header
├──────────────────────────────────┤
│  🔍 [Model, IP, MAC, port...]    │  ← Search bar
├──────────────────────────────────┤
│  ● DeviceName         [SUNAPI]  │
│    Hanwha · 192.168.1.10 [ONVIF]│
│  ● DeviceName2        [ONVIF]   │
│  ...                             │
└──────────────────────────────────┘
```

---

## 3. Panel Header

### 3.1 Components

| Element | Description | CSS |
|------|------|-----|
| **Title** | `"Cameras"` (fixed text) | `text-sm font-bold text-white` |
| **Connection status dot** | Socket.IO connection state | `w-2 h-2 rounded-full` + color |
| **+ Add button** | Open camera add Modal | `bg-green-700 hover:bg-green-600 text-white text-[11px]` |

### 3.2 Connection Status Dot

| State | Color | Animation |
|------|------|-----------|
| Connected | `bg-green-500` | `animate-pulse` |
| Disconnected | `bg-red-500` | None |

---

## 4. Sub-Tab Structure (Added / Found)

### 4.1 Tab Buttons

| Tab | Display | Count |
|----|------|--------|
| `added` | `Added (N)` | Number of registered cameras |
| `found` | `Found (N)` | Number of discovered devices |

- Active tab: `text-blue-400 border-b-2 border-blue-400`
- Inactive tab: `text-gray-500 hover:text-gray-300`
- Font size: `text-[11px] font-semibold uppercase`

### 4.2 Found Tab Scanning Indicator

Blue animated dot displayed to the left of the Found tab label while scanning.
```
Absolute position within tab: left-2 top-1/2 -translate-y-1/2
CSS: w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping
```

### 4.3 Auto Tab Switch on Discovery

When the first discovered device (`discovery:result` event) is received from the server, **automatically switches to the Found tab** (limited to once via `autoSwitched` flag) — but **only when the operator has no registered cameras yet** (`cameras.length === 0`). Once at least one camera exists in the Added list, the panel stays pinned to Added: neither the first nor any subsequent `discovery:result` event auto-switches away from it, regardless of the `autoSwitched` flag's state (including after it has been reset by "Clean," §6.1).

This condition exists specifically so that Found-tab activity — new devices appearing, or an operator clicking "Clean" to restart a scan — never yanks focus away from an Added list the operator is actively working in.

### 4.4 Auto Tab Switch Back to Added on Camera Registration

When a camera is registered from the Found tab (via "Add as Camera" or Camera Add modal pre-filled from a discovered device), the panel shall **automatically switch back to the Added tab** so the operator can immediately see the newly registered camera in context.

- Mechanism: React `useEffect` watches `cameras.length`; when the count increases while the Found sub-tab is active, it switches to the Added sub-tab.
- This one-shot behavior applies only when the user is currently on the Found tab; no switch occurs if the user is already on the Added tab.

---

## 5. Added Tab — Registered Camera List

### 5.1 Empty List State

When there are no registered cameras:
```
No cameras yet. Use + Add or select from Found.
```
- Color: `text-xs text-gray-500 text-center mt-6`

### 5.2 Camera Row Structure

```
┌─────────────────────────────────────────────┐
│  [●]  CameraName        [✎] [↺] [AI] [✕]  │  ← RTSP camera
│       192.168.x.x                           │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│  [●]  CameraName  [YT]  [✎] [↺] [AI] [✕]  │  ← YouTube channel
│       https://www.youtube.com/watch?v=…     │
└─────────────────────────────────────────────┘
```

| Element | Description |
|------|------|
| **StatusDot** | Left-side status color circle |
| **Camera name** | `text-xs font-semibold text-white truncate` |
| **YT badge** | Shown only for YouTube channels. `bg-red-700 text-white text-[9px]` |
| **Sub info row** | `text-[10px] text-gray-400 truncate` below name — varies by type (§5.2.1) |
| **Action button group** | Shown on hover only (`opacity-0 group-hover:opacity-100`) |

#### 5.2.1 Sub Info Row — Display Rules by Type

The second line below the camera name displays different information depending on camera type.

| Camera type | Sub info | Condition |
|------------|---------|------|
| **RTSP** (`type !== 'youtube'`) | `cam.ip` — IP address | Shown only when `cam.ip` exists |
| **YouTube** (`type === 'youtube'`) | `cam.youtubeUrl` — Original YouTube URL | Shown only when `cam.youtubeUrl` exists |

- CSS: `text-[10px] text-gray-400 truncate` (ellipsis when width exceeded)
- YouTube URL hover tooltip: full URL viewable via `title={cam.youtubeUrl}`
- Examples:
  - RTSP: `192.168.1.100`
  - YouTube: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`

#### 5.2.1 StatusDot Color Specification

| Camera status | Color | HEX |
|------------|------|-----|
| `live` | Green | `bg-green-500` |
| `error` | Red | `bg-red-500` |
| `offline` | Gray | `bg-gray-500` |
| `connecting`, `streaming`, `reconnecting`, `idle` | Yellow | `bg-yellow-500` |

#### 5.2.2 Action Button Specification

| Button | Icon | Behavior | Active color | Inactive color |
|------|--------|------|---------|---------|
| Edit | `✎` | Open `CameraEditModal` | `hover:text-blue-400` | — |
| Reconnect | `↺` | `/api/cameras/{id}/stream/reconnect` POST | `hover:text-yellow-400` | — |
| AI Toggle | `AI` | `POST /api/cameras/{id}/ai/toggle` — enable/disable AI inference | `text-green-400` | `text-gray-600` |
| Delete | `✕` | Confirm dialog → `/api/cameras/{id}` DELETE | `hover:text-red-400` | — |

#### 5.2.3 AI Toggle Button Specification

The **AI** button enables or disables per-camera AI inference (YOLO detection, ByteTrack tracking, BehaviorEngine) without restarting the video stream.

| State | Appearance | Tooltip |
|-------|-----------|---------|
| **AI On** (default) | `text-green-400 hover:text-green-300` | `AI On — click to disable` |
| **AI Off** | `text-gray-600 hover:text-gray-400` | `AI Off — click to enable` |

- Persisted to DB (`aiEnabled` field in camera record). Default: `true`.
- Running pipeline context updated immediately via `pipelineManager.setAiEnabled()` — no restart needed.
- When AI is off: raw JPEG frames are still streamed to the client; detection/tracking/alerts are suspended.
- API: `POST /api/cameras/:id/ai/toggle` → `{ success: true, aiEnabled: boolean }`

#### 5.2.4 Reconnecting State

Shows `"Reconnecting…"` text for 2 seconds after reconnect request:
- `text-[9px] text-yellow-400 animate-pulse`

### 5.3 Click Behavior

| Event | Behavior |
|--------|------|
| **Single click** | Select camera (change `selectedId` in CameraStore) |
| **Double-click** | Camera reconnect request (single/double distinguished by 300ms delay) |
| **Right-click (context menu)** | Open `CameraEditModal` directly |

### 5.4 Selected Camera Row Style

```css
bg-blue-900/50 border-blue-600
```

### 5.5 Unselected Camera Row Style

```css
bg-gray-800 border-gray-700 hover:bg-gray-700 hover:border-gray-600
```

---

## 6. Found Tab — Auto-discovered Camera List

### 6.1 Found Header Bar

```
┌────────────────────────────────────┐
│  [● Scanning…] or [N device(s) found]   [Clean] │
└────────────────────────────────────┘
```

| State | Display |
|------|------|
| Scanning | `● Scanning…` (blue dot ping animation) |
| Scan complete | `N device(s) found` (gray text) |
| No devices | `Waiting…` |

**Clean button**: Reset discovery results + send `discovery:rescan` Socket event

### 6.2 Search Bar

```
┌─────────────────────────────────────┐
│  🔍  [Model, IP, MAC, port, URL…] × │
└─────────────────────────────────────┘
```

#### 6.2.1 Searchable Fields

| Field key | Display label |
|---------|-----------|
| `Model` | Model |
| `Manufacturer` | Manufacturer |
| `IPAddress` | IP |
| `MACAddress` | MAC |
| `Gateway` | Gateway |
| `SubnetMask` | Subnet |
| `HttpPort` | HTTP |
| `HttpsPort` | HTTPS |
| `Port` | RTSP Port |
| `URL` | DDNS |
| `rtspUrl` | RTSP URL |

#### 6.2.2 Virtual Category Search

In addition to string search, supports keyword matching for boolean/enum fields:

| Keyword | Match condition | Label |
|--------|----------|-------|
| `onvif` | `SupportOnvif=true` or `source=onvif/both` | ONVIF |
| `sunapi`, `wisenet`, `hanwha` | `SupportSunapi=true` | SUNAPI |
| `udp`, `wisenet`, `hanwha` | `source=udp/both` | WiseNet |

#### 6.2.3 Search Result Count

Displays `N / M match` at bottom when search query entered:
- `text-[10px] text-gray-500`

#### 6.2.4 X Button (Clear Search)

Shown at right end only when search query exists. Click sets `searchQuery = ''`.

### 6.3 Discovered Device Row Structure

```
┌─────────────────────────────────────────────┐
│  [●] DeviceName                [SUNAPI]     │
│      Manufacturer · IPAddress  [ONVIF]      │
│      [match badge] [match badge]            │
└─────────────────────────────────────────────┘
```

| Element | Description |
|------|------|
| **Blue dot** | `w-1.5 h-1.5 rounded-full bg-blue-400` |
| **Device name** | Shows `IPAddress` if no `Model` |
| **Sub-text** | `Manufacturer · IPAddress` |
| **Matching field badges** | Field names matched to search query (yellow badge) |
| **SUNAPI badge** | `bg-green-900 text-green-400` |
| **ONVIF badge** | `bg-purple-900 text-purple-300` |

#### 6.3.1 Badge Display Conditions

| Badge | Condition |
|------|------|
| SUNAPI | `(source === 'udp' || source === 'both') && SupportSunapi` |
| ONVIF | `source === 'onvif' || source === 'both' || SupportOnvif` |

### 6.4 Discovered Device Click Behavior

Click calls `DiscoveryStore.select(cam)` → shows `DiscoveredCameraPanel` overlay.  
Re-clicking an already selected device deselects it.

---

## 7. Camera Add Modal

Displayed on **+ Add** button click in header. `fixed inset-0 z-50 bg-black/70` overlay.

### 7.1 Source Type Selection

Select the addition method at the top of the Modal:

| Type | Display | Description |
|------|------|------|
| `rtsp` | RTSP / ONVIF | Manual IP camera addition |
| `youtube` | YouTube | Add YouTube stream virtual channel |

### 7.2 RTSP Camera Add Form

| Field | Type | Required | Description |
|------|------|------|------|
| Name | text | ✅ | Camera display name |
| RTSP URL | text | ✅ | `rtsp://...` format |
| Username | text | ❌ | RTSP auth username |
| Password | password | ❌ | RTSP auth password |
| WebRTC Enabled | checkbox/toggle | ❌ | Whether to use mediasoup WebRTC stream |

**WebRTC Enabled toggle**: Default `false`. When enabled, server uses `RtpIngestion` + mediasoup pipeline.

**Submit API**: `POST /api/cameras`  
**On success**: Calls `CameraStore.addCamera()` → switch to Added tab

#### 7.2.1 Error Handling

| Condition | Error message |
|------|------------|
| Name or URL not entered | `"Name and RTSP URL are required."` |
| API error | Server response message |

### 7.3 YouTube Channel Add Form

| Field | Type | Required | Default | Description |
|------|------|------|-------|------|
| Channel Name | text | ✅ | — | Channel display name |
| YouTube URL | text | ✅ | — | YouTube page URL |
| Resolution | select | ✅ | `1080p` | `1080p` / `720p` / `480p` |
| Bitrate | number | ✅ | `2000` | kbps |
| Repeat Playback | checkbox | ❌ | `false` | Auto-restart when video ends (`repeatPlayback`) |

**Repeat Playback behavior**: When checkbox enabled, if the YouTube video ends normally (FFmpeg exit code 0), the restart counter is reset and the video immediately restarts. Bypasses the MAX_RESTARTS(5) limit for infinite loop playback.

**Submit API**: `POST /api/youtube-streams`  
**Response**: Runs `yt-dlp` + FFmpeg in the background → polls for status

#### 7.3.1 YouTube Add Progress State

Does not complete immediately after submission; server is preparing the stream. Client checks via polling:

| Stage | Display |
|------|------|
| Starting | `"Starting stream… Xs"` (elapsed time count) |
| `live` status confirmed | Close Modal |
| Error | Show error message |

#### 7.3.2 YouTube Add Error Codes

| Error code | Display message |
|----------|-----------|
| `INVALID_YOUTUBE_URL` | `Invalid YouTube URL.` |
| `YT_DLP_FAILED` | `Unable to retrieve video. It may be private or deleted.` |
| `MAX_STREAMS_REACHED` | `Maximum number of YouTube streams reached.` |
| `STREAM_TIMEOUT` | `Stream start timed out. Please try again.` |

---

## 8. Camera Edit Modal (CameraEditModal)

Entered via the **✎ (edit)** button in the camera row or right-click menu. `z-50` overlay.

### 8.1 RTSP Camera Edit Form

| Field | Type | Description |
|------|------|------|
| Name | text | Change camera display name |
| RTSP URL | text | Change stream URL |
| Username | text | Change RTSP auth username |
| Password | password | Change RTSP auth password (empty = no change) |
| WebRTC Enabled | toggle | Switch WebRTC pipeline |

**Two save buttons**:

| Button | API | Description |
|------|-----|------|
| Save | `PUT /api/cameras/{id}` | Save only |
| Save & Reconnect | `PUT /api/cameras/{id}` + `POST /api/cameras/{id}/stream/reconnect` | Save then reconnect stream |

**WebRTC change detection**: If only `webrtcEnabled` changes without URL or auth changes, the server auto-restarts the pipeline.

### 8.2 YouTube Channel Edit Form

| Field | Type | Description |
|------|------|------|
| Channel Name | text | Change channel name |
| YouTube URL | text | Change URL (stream restarts on change) |
| Resolution | select | Change resolution (stream restarts on change) |
| Bitrate | number | Change bitrate (kbps) |
| Repeat Playback | checkbox | Auto-restart when video ends (`repeatPlayback`) |

**Submit API**: `PATCH /api/youtube-streams/{id}`

### 8.3 Save Feedback

| State | Display |
|------|------|
| Saving | `"Saving…"` (button disabled) |
| Save success | `"Saved."` or `"Saved & reconnecting…"` (Modal closes after 0.8s) |
| Error | Red error message |

---

## 9. Discovered Camera Panel (Overlay)

Displayed as an overlay above the Camera Grid when a device from the Found tab is clicked.

### 9.1 Position

- `absolute` (relative to Camera Grid area)
- Position: bottom-right or top-left (depending on implementation)
- Component: `DiscoveredCameraPanel`

### 9.2 Displayed Information

| Item | Description |
|------|------|
| Device name / model | `Model` or `IPAddress` |
| Manufacturer | `Manufacturer` |
| IP address | `IPAddress` |
| MAC address | `MACAddress` |
| RTSP URL | `rtspUrl` |
| ONVIF / SUNAPI support | Badge display |
| HTTP / HTTPS Port | `HttpPort`, `HttpsPort` |
| Firmware version | `FirmwareVersion` (if present) |

### 9.3 Action Buttons

| Button | Behavior |
|------|------|
| **Add as camera** | Auto-fill camera add Modal with device info and open |
| **Close** | `DiscoveryStore.select(null)` |

---

## 10. REST API Integration

### 10.1 Camera-related APIs

| Method | Endpoint | Description |
|--------|-----------|------|
| `GET` | `/api/cameras` | Get registered camera list |
| `POST` | `/api/cameras` | Add camera |
| `PUT` | `/api/cameras/:id` | Update camera info |
| `DELETE` | `/api/cameras/:id` | Delete camera |
| `POST` | `/api/cameras/:id/stream/reconnect` | Reconnect stream |
| `POST` | `/api/cameras/:id/ai/toggle` | Toggle AI inference on/off |

### 10.2 YouTube Stream API

| Method | Endpoint | Description |
|--------|-----------|------|
| `POST` | `/api/youtube-streams` | Start adding YouTube channel |
| `GET` | `/api/youtube-streams/:id/status` | Poll stream status |
| `PATCH` | `/api/youtube-streams/:id` | Update YouTube channel info |
| `POST` | `/api/youtube-streams/:id/restart` | Restart stream |

### 10.3 Camera Add Request Body

```json
{
  "name": "string (required)",
  "rtspUrl": "string (required)",
  "username": "string (optional)",
  "password": "string (optional)",
  "webrtcEnabled": "boolean (optional, default: false)"
}
```

### 10.4 Camera Update Request Body

```json
{
  "name": "string (optional)",
  "rtspUrl": "string (optional)",
  "username": "string (optional)",
  "password": "string (optional, null = keep existing)",
  "webrtcEnabled": "boolean (optional)"
}
```

---

## 11. State Management

### 11.1 CameraStore (Zustand)

| State | Type | Description |
|------|------|------|
| `cameras` | `Camera[]` | Registered camera list |
| `selectedId` | `string \| null` | Currently selected camera ID |

| Action | Description |
|------|------|
| `setCameras(cameras)` | Set entire list (on initial server load) |
| `addCamera(camera)` | Add camera |
| `updateCamera(id, fields)` | Update camera info |
| `removeCamera(id)` | Remove camera |
| `updateCameraStatus(id, status)` | Change status |
| `selectCamera(id)` | Select camera |

### 11.2 DiscoveryStore (Zustand)

| State | Type | Description |
|------|------|------|
| `cameras` | `DiscoveredCamera[]` | Discovered device list |
| `selected` | `DiscoveredCamera \| null` | Selected discovered device |
| `scanning` | `boolean` | Whether scan is in progress |

### 11.3 Socket.IO Events

| Event | Direction | Handler |
|--------|------|------|
| `cameras` | S→C | `setCameras()` |
| `camera:status` | S→C | `updateCameraStatus()` |
| `discovery:result` | S→C | `addOrUpdate()` + auto tab switch |
| `discovery:scanning` | S→C | `setScanning()` |
| `discovery:cleared` | S→C | `clearFound()` |
| `discovery:rescan` | C→S | Request scan reset and restart |

---

## 12. Implementation Status

### 12.1 Phase-1 Completed Items

| Item | Status |
|------|------|
| Added tab camera list | ✅ Done |
| StatusDot 5 colors | ✅ Done |
| Camera row action buttons (edit/reconnect/delete) | ✅ Done |
| Double-click reconnect | ✅ Done |
| YouTube channel YT badge | ✅ Done |
| Camera add Modal (RTSP) | ✅ Done |
| Camera add Modal (YouTube) | ✅ Done |
| YouTube stream polling progress state | ✅ Done |
| Camera edit Modal (RTSP/YouTube) | ✅ Done |
| Found tab discovery list | ✅ Done |
| Found tab search bar (string + category) | ✅ Done |
| SUNAPI/ONVIF badge | ✅ Done |
| Auto tab switch (on first device found) | ✅ Done |
| Auto tab switch back to Added after camera registration | ✅ Done |
| Discovered Camera Panel overlay | ✅ Done |
| WebRTC Enabled toggle (per camera) | ✅ Done |

### 12.2 Not Yet Implemented / Planned Improvements

| Item | Priority | Notes |
|------|---------|------|
| Camera drag & drop reorder | Medium | |
| Camera group/channel distinction | Low | |
| RTSP URL pre-validation | Medium | |
| Camera thumbnail preview (within list row) | Low | |
| Bulk delete multiple cameras | Low | |
| ONVIF auth integration (auto RTSP URL generation) | Medium | Via `DiscoveredCameraPanel` |
| YouTube live channel support | Low | Currently VOD/live URL |

---

*Document: LTS-2026-011 v1.0 — 2026-05-19*  
*Author: LTS Development Team*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Dashboard Sidebar Cameras |
| 1.1 | 2026-06-16 | LTS Engineering Team | §4.4 추가 — Found 탭에서 카메라 등록 시 Added 탭 자동 전환 요구사항; §12.1 구현 완료 항목 추가 |
| 1.2 | 2026-07-14 | LTS Engineering Team | §4.3 정정 — 등록된 카메라가 이미 있는 경우(`cameras.length > 0`) Found 탭 자동 전환을 금지하도록 조건 추가 (Streaming 서버 Dashboard에서 Found 패널이 반복적으로 포커스를 뺏어가던 버그 수정) |
