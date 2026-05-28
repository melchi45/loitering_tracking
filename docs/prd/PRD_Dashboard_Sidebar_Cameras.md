# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Dashboard Sidebar — Cameras Panel

| | |
|---|---|
| **Document ID** | PRD-LTS-011 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Dashboard_Sidebar_Cameras.md (LTS-2026-011 v1.3) |

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

The Cameras Panel gives operators a single, always-accessible control surface for managing IP cameras and YouTube virtual channels — including manual registration, editing, reconnection, AI toggle, and automatic discovery via ONVIF/WiseNet UDP — without leaving the dashboard.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Display all registered cameras (RTSP and YouTube) in a scrollable list with real-time status color coding and hover-revealed action buttons (edit, reconnect, AI toggle, delete).
- Support manual camera addition (RTSP and YouTube) and editing via Modal dialogs.
- Enable per-camera AI inference toggle (enable/disable detection pipeline without restarting the video stream).
- Discover cameras automatically via ONVIF and WiseNet UDP protocols and display them in a "Found" sub-tab with a searchable, filterable list.
- Show a `DiscoveredCameraPanel` overlay on discovered device selection with device details and a one-click "Add as camera" action.

### 2.2 Non-Goals

- Camera drag-and-drop reorder is not required in this release.
- Bulk deletion of multiple cameras is not in scope.
- RTSP URL pre-validation before submission is deferred.

---

## 3. User Personas

**Security Operator** — adds cameras to monitor, selects cameras by clicking their row to drive the Camera Grid, and reconnects misbehaving streams without leaving the dashboard.

**Network/IT Administrator** — uses the Found tab to discover ONVIF/WiseNet cameras on the network, reviews device details (IP, MAC, firmware, RTSP URL), and registers them with a single click.

**System Administrator** — manages per-camera AI inference toggle to reduce server load on cameras that do not require detection, and configures WebRTC streaming mode per camera.

---

## 4. Functional Specification

### 4.1 Panel Header

Contains, left to right:
- Title: "Cameras" (`text-sm font-bold text-white`)
- Connection status dot: green pulse (`bg-green-500 animate-pulse`) when Socket.IO connected, solid red (`bg-red-500`) when disconnected
- "+ Add" button: opens Camera Add Modal (`bg-green-700 hover:bg-green-600 text-[11px]`)

### 4.2 Sub-Tab Structure

Two sub-tabs: **Added (N)** and **Found (N)**, where N is the respective count. Active: `text-blue-400 border-b-2 border-blue-400`. Inactive: `text-gray-500 hover:text-gray-300`. Font: `text-[11px] font-semibold uppercase`.

A blue animated ping dot (`w-1.5 h-1.5 bg-blue-400 animate-ping`) appears inside the Found tab label while scanning.

**Auto tab switch**: When the first `discovery:result` Socket.IO event is received, the panel automatically switches to the Found tab (one-time, controlled by `autoSwitched` flag).

### 4.3 Added Tab — Registered Camera List

#### 4.3.1 Empty State

"No cameras yet. Use + Add or select from Found." (`text-xs text-gray-500 text-center mt-6`)

#### 4.3.2 Camera Row

Each row contains:
- **StatusDot**: color circle reflecting camera status (see §5.1)
- **Camera name**: `text-xs font-semibold text-white truncate`
- **YT badge**: shown for YouTube channels only — `bg-red-700 text-white text-[9px]`
- **Sub-info line**: for RTSP cameras, shows `cam.ip`; for YouTube cameras, shows `cam.youtubeUrl` (truncated, full URL on hover via `title` attribute)
- **Action button group**: hidden until row hover (`opacity-0 group-hover:opacity-100`) — Edit (`✎`), Reconnect (`↺`), AI Toggle (`AI`), Delete (`✕`)

#### 4.3.3 Action Button Behaviors

| Button | API | Effect |
|--------|-----|--------|
| Edit `✎` | Opens `CameraEditModal` | — |
| Reconnect `↺` | `POST /api/cameras/{id}/stream/reconnect` | Shows "Reconnecting…" for 2s (`text-[9px] text-yellow-400 animate-pulse`) |
| AI Toggle `AI` | `POST /api/cameras/{id}/ai/toggle` | Toggles AI inference; green when on, gray when off |
| Delete `✕` | Confirm → `DELETE /api/cameras/{id}` | Removes from list |

**AI Toggle detail**: Default `true`. When disabled, raw JPEG frames continue streaming but detection/tracking/alerts are suspended. `pipelineManager.setAiEnabled()` is called server-side without pipeline restart.

#### 4.3.4 Click Behaviors

| Event | Behavior |
|-------|---------|
| Single click | `CameraStore.selectCamera(id)` |
| Double-click | Reconnect (distinguished from single-click by 300ms delay) |
| Right-click | Open `CameraEditModal` directly |

### 4.4 Camera Add Modal

Opened via the "+ Add" header button. `fixed inset-0 z-50 bg-black/70`.

#### 4.4.1 RTSP Camera Add

Fields: Name (required), RTSP URL (required), Username, Password, WebRTC Enabled toggle (default `false`).

Submit: `POST /api/cameras`. On success: `CameraStore.addCamera()` → switch to Added tab.

Error cases: missing name/URL → `"Name and RTSP URL are required."`; API error → server message.

#### 4.4.2 YouTube Channel Add

Fields: Channel Name (required), YouTube URL (required), Resolution (select: 1080p/720p/480p, default 1080p), Bitrate (number, default 2000 kbps), Repeat Playback (checkbox, default `false`).

**Repeat Playback**: When enabled, video restarts immediately on natural end (FFmpeg exit code 0), bypassing the MAX_RESTARTS(5) limit.

Submit: `POST /api/youtube-streams`. Stream preparation is async; client polls for status showing elapsed time ("Starting stream… Xs"). Modal closes when `live` status is confirmed.

YouTube error codes: `INVALID_YOUTUBE_URL`, `YT_DLP_FAILED`, `MAX_STREAMS_REACHED`, `STREAM_TIMEOUT` — each mapped to a user-facing message.

### 4.5 Camera Edit Modal

Opened via `✎` button or right-click. Contains the same fields as Add, pre-populated with current values.

**RTSP save options**:
- "Save" → `PUT /api/cameras/{id}`
- "Save & Reconnect" → `PUT /api/cameras/{id}` then `POST /api/cameras/{id}/stream/reconnect`

If only `webrtcEnabled` changes (no URL or auth change), server auto-restarts the pipeline.

**YouTube edit**: `PATCH /api/youtube-streams/{id}`.

Save feedback: "Saving…" (button disabled) → "Saved." or "Saved & reconnecting…" → Modal closes after 0.8s. Errors shown as red text.

### 4.6 Found Tab — Auto-discovered Camera List

#### 4.6.1 Found Header

Shows scan status: "● Scanning…" (blue ping dot) while active, "N device(s) found" on completion, "Waiting…" if no devices found.

"Clean" button: resets discovery results and sends `discovery:rescan` Socket event.

#### 4.6.2 Search Bar

Full-text search across 11 device fields: Model, Manufacturer, IPAddress, MACAddress, Gateway, SubnetMask, HttpPort, HttpsPort, Port (RTSP), URL (DDNS), rtspUrl.

Virtual category search keywords:
- `onvif` → matches `SupportOnvif=true` or `source=onvif/both`
- `sunapi`, `wisenet`, `hanwha` → matches `SupportSunapi=true`
- `udp`, `wisenet`, `hanwha` → matches `source=udp/both`

Matched field names are shown as yellow badges on each row. Result count shown as "N / M match" (`text-[10px] text-gray-500`). Clear (`×`) button appears when a query is active.

#### 4.6.3 Discovered Device Row

- Blue dot + device name (falls back to IP if no Model)
- Sub-text: `Manufacturer · IPAddress`
- SUNAPI badge (`bg-green-900 text-green-400`) and ONVIF badge (`bg-purple-900 text-purple-300`) based on device capabilities

Click → `DiscoveryStore.select(cam)` → shows `DiscoveredCameraPanel` overlay. Re-click deselects.

### 4.7 Discovered Camera Panel (Overlay)

Positioned `absolute` relative to the Camera Grid. Displays: device name/model, manufacturer, IP, MAC, RTSP URL, ONVIF/SUNAPI support, HTTP/HTTPS ports, firmware version.

Action buttons:
- "Add as camera": auto-fills and opens Camera Add Modal with device data
- "Close": `DiscoveryStore.select(null)`

---

## 5. UI/UX Requirements

### 5.1 StatusDot Color Specification

| Status | Color |
|--------|-------|
| `live` | `bg-green-500` |
| `error` | `bg-red-500` |
| `offline` | `bg-gray-500` |
| `connecting`, `streaming`, `reconnecting`, `idle` | `bg-yellow-500` |

### 5.2 Selected Camera Row Style

```css
bg-blue-900/50 border-blue-600
```

### 5.3 Unselected Camera Row Style

```css
bg-gray-800 border-gray-700 hover:bg-gray-700 hover:border-gray-600
```

### 5.4 AI Toggle Button Appearance

| State | CSS | Tooltip |
|-------|-----|---------|
| AI On | `text-green-400 hover:text-green-300` | "AI On — click to disable" |
| AI Off | `text-gray-600 hover:text-gray-400` | "AI Off — click to enable" |

---

## 6. Technical Requirements

### 6.1 REST API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/cameras` | Fetch registered cameras |
| POST | `/api/cameras` | Add RTSP camera |
| PUT | `/api/cameras/:id` | Update camera |
| DELETE | `/api/cameras/:id` | Delete camera |
| POST | `/api/cameras/:id/stream/reconnect` | Reconnect stream |
| POST | `/api/cameras/:id/ai/toggle` | Toggle AI inference |
| POST | `/api/youtube-streams` | Add YouTube channel |
| GET | `/api/youtube-streams/:id/status` | Poll stream status |
| PATCH | `/api/youtube-streams/:id` | Update YouTube channel |
| POST | `/api/youtube-streams/:id/restart` | Restart YouTube stream |

### 6.2 State Management

**CameraStore (Zustand)**:
- `cameras: Camera[]`, `selectedId: string | null`
- Actions: `setCameras`, `addCamera`, `updateCamera`, `removeCamera`, `updateCameraStatus`, `selectCamera`

**DiscoveryStore (Zustand)**:
- `cameras: DiscoveredCamera[]`, `selected: DiscoveredCamera | null`, `scanning: boolean`

### 6.3 Socket.IO Events

| Event | Direction | Handler |
|-------|-----------|---------|
| `cameras` | S→C | `setCameras()` |
| `camera:status` | S→C | `updateCameraStatus()` |
| `discovery:result` | S→C | `addOrUpdate()` + auto tab switch |
| `discovery:scanning` | S→C | `setScanning()` |
| `discovery:cleared` | S→C | `clearFound()` |
| `discovery:rescan` | C→S | Request scan reset and restart |

### 6.4 Camera Add Request Body

```json
{
  "name": "string (required)",
  "rtspUrl": "string (required)",
  "username": "string (optional)",
  "password": "string (optional)",
  "webrtcEnabled": "boolean (optional, default: false)"
}
```

---

## 7. Acceptance Criteria

1. All registered cameras appear in the Added tab list with correct StatusDot color reflecting their current status, updated in real time via Socket.IO `camera:status` events.
2. Clicking a camera row sets it as `selectedId` in CameraStore and highlights it with `bg-blue-900/50 border-blue-600`.
3. The "+ Add" Modal allows adding RTSP cameras with required Name and RTSP URL fields; missing fields show `"Name and RTSP URL are required."`.
4. YouTube channel addition shows progress ("Starting stream… Xs") while the server prepares the stream; the Modal closes automatically when `live` status is confirmed.
5. The AI toggle button immediately reflects the new state (`text-green-400` when on, `text-gray-600` when off) after `POST /api/cameras/{id}/ai/toggle` responds successfully.
6. The reconnect button shows a 2-second "Reconnecting…" pulsing indicator after click.
7. The Found tab auto-switches when the first `discovery:result` event is received, and does not auto-switch again for subsequent events.
8. The search bar in the Found tab correctly filters devices by text fields (Model, IP, MAC, etc.) and by virtual category keywords (`onvif`, `sunapi`, `hanwha`); matched field names appear as yellow badges.
9. Clicking a discovered device shows the `DiscoveredCameraPanel` overlay with its details and "Add as camera" pre-fills the Camera Add Modal.
10. The Camera Edit Modal pre-populates all fields with current values; "Save & Reconnect" calls both `PUT /api/cameras/{id}` and `POST /api/cameras/{id}/stream/reconnect` sequentially.

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|-----------|-------------|--------|-----------|--------|
| M1 | Added tab: camera list, StatusDot, action buttons | TBD | Phase-1 done | ✅ Complete |
| M2 | Camera Add/Edit Modals (RTSP + YouTube), WebRTC toggle | TBD | Phase-1 done | ✅ Complete |
| M3 | Found tab: ONVIF/UDP discovery, search, panel overlay | TBD | Phase-1 done | ✅ Complete |
| M4 | Camera drag-and-drop reorder | TBD | - | ⏳ Pending |
| M5 | RTSP URL pre-validation and ONVIF auth integration | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement camera drag-and-drop reorder in the camera list
- [ ] Add RTSP URL format pre-validation (pattern check before API submission)
- [ ] Integrate ONVIF authentication in `DiscoveredCameraPanel` for auto RTSP URL generation
- [ ] Add camera thumbnail preview (small snapshot image) inside each camera row
- [ ] Implement bulk delete for multiple selected cameras
- [ ] Add YouTube live channel support (currently VOD/live URL only)
- [ ] Add camera group/channel distinction for organizing cameras into logical groups
- [ ] Write unit tests for StatusDot color mapping (all 5 status values)
- [ ] Write integration tests for YouTube stream add flow (polling + live confirmation)
- [ ] Write tests for discovery search — text matching and virtual category keyword matching

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Dashboard Sidebar Cameras |
