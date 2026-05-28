# DESIGN DOCUMENT
# Dashboard Sidebar — Cameras Panel

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-CAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_Dashboard_Sidebar_Cameras.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Component Tree](#3-component-tree)
4. [State Management Design](#4-state-management-design)
5. [Socket.IO Subscription Design](#5-socketio-subscription-design)
6. [TypeScript Interface Definitions](#6-typescript-interface-definitions)
7. [REST API Integration](#7-rest-api-integration)
8. [Responsive & Mobile Considerations](#8-responsive--mobile-considerations)
9. [Sequence Diagrams](#9-sequence-diagrams)
10. [Error Handling](#10-error-handling)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                            │
│  CameraList.tsx (sidebar Cameras tab)                            │
│   ├─ Sub-tabs: Added (N) | Found (N)                            │
│   ├─ Added: CameraStore.cameras[] → camera rows                 │
│   │    ├─ CameraEditModal.tsx                                    │
│   │    └─ REST: POST/PUT/DELETE /api/cameras                     │
│   └─ Found: DiscoveryStore.cameras[] → device rows              │
│        └─ DiscoveredCameraPanel.tsx (overlay)                    │
└──────────────────────────────────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼─────────────────────────────────────────┐
│  Server                                                           │
│  GET/POST/PUT/DELETE /api/cameras                                │
│  POST /api/cameras/:id/stream/reconnect                          │
│  POST /api/cameras/:id/ai/toggle                                 │
│  POST/GET/PATCH /api/youtube-streams                             │
│  Socket.IO: cameras, camera:status, discovery:*                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── client/
│   └── src/
│       ├── components/
│       │   ├── CameraList.tsx              # Added + Found sub-tabs
│       │   ├── CameraEditModal.tsx         # Add/Edit camera modal
│       │   └── DiscoveredCameraPanel.tsx   # Discovery overlay
│       └── stores/
│           ├── cameraStore.ts              # Registered cameras + selectedId
│           └── discoveryStore.ts           # ONVIF/UDP discovered devices
└── server/
    └── src/
        └── api/
            └── cameras.js                  # All /api/cameras endpoints
```

---

## 3. Component Tree

```
CameraList (sidebar Cameras tab)
├─ Panel Header
│   ├─ Title "Cameras"
│   ├─ Connection status dot
│   └─ "+ Add" button → CameraEditModal (add mode)
├─ Sub-tab bar
│   ├─ Added (N) tab
│   └─ Found (N) tab + scanning ping dot
├─ [Added tab content]
│   ├─ Empty state (conditional)
│   └─ Camera rows × N
│       ├─ StatusDot
│       ├─ Camera name + YT badge
│       ├─ Sub-info (IP or YouTube URL)
│       └─ Action buttons (hover-revealed)
│           ├─ ✎ Edit → CameraEditModal (edit mode)
│           ├─ ↺ Reconnect
│           ├─ AI Toggle
│           └─ ✕ Delete
└─ [Found tab content]
    ├─ Found header (scan status + Clean button)
    ├─ Search bar
    └─ Device rows × N
        ├─ Blue dot + device name
        ├─ Manufacturer · IP
        └─ SUNAPI / ONVIF badges

CameraEditModal (shared add/edit)
├─ RTSP tab
│   ├─ Name input
│   ├─ RTSP URL input
│   ├─ Username/Password inputs
│   ├─ WebRTC toggle
│   └─ Save / Save & Reconnect / Cancel buttons
└─ YouTube tab
    ├─ Channel Name input
    ├─ YouTube URL input
    ├─ Resolution select
    ├─ Bitrate input
    ├─ Repeat Playback checkbox
    └─ Add / Cancel buttons

DiscoveredCameraPanel (absolute overlay)
├─ Device details
│   ├─ Name, Model, Manufacturer
│   ├─ IP, MAC
│   ├─ RTSP URL
│   ├─ ONVIF / SUNAPI support
│   ├─ HTTP/HTTPS ports
│   └─ Firmware version
└─ Action buttons
    ├─ "Add as camera" → opens CameraEditModal pre-filled
    └─ "Close"
```

---

## 4. State Management Design

### 4.1 CameraStore (Zustand)

```typescript
interface CameraStore {
  cameras:              Camera[];
  selectedId:           string | null;
  setCameras:           (cameras: Camera[]) => void;
  addCamera:            (camera: Camera) => void;
  updateCamera:         (id: string, updates: Partial<Camera>) => void;
  removeCamera:         (id: string) => void;
  updateCameraStatus:   (id: string, status: Camera['status']) => void;
  selectCamera:         (id: string | null) => void;
}
```

### 4.2 DiscoveryStore (Zustand)

```typescript
interface DiscoveryStore {
  cameras:     DiscoveredCamera[];
  selected:    DiscoveredCamera | null;
  scanning:    boolean;
  addOrUpdate: (cam: DiscoveredCamera) => void;
  clearFound:  () => void;
  setScanning: (v: boolean) => void;
  select:      (cam: DiscoveredCamera | null) => void;
}
```

### 4.3 CameraList Local State

| State | Type | Purpose |
|---|---|---|
| `subTab` | `'added' \| 'found'` | Active sub-tab |
| `autoSwitched` | `boolean` | One-time auto-switch to Found tab flag |
| `searchQuery` | `string` | Found tab search input value |
| `reconnectingId` | `string \| null` | Camera showing "Reconnecting…" indicator |

### 4.4 CameraEditModal Local State

| State | Type | Purpose |
|---|---|---|
| `mode` | `'add' \| 'edit'` | Modal mode |
| `camType` | `'rtsp' \| 'youtube'` | Active camera type tab |
| `name`, `rtspUrl`, `username`, `password`, `webrtcEnabled` | form fields | RTSP form state |
| `ytName`, `ytUrl`, `resolution`, `bitrate`, `repeat` | form fields | YouTube form state |
| `saving` | `boolean` | Save in progress |
| `error` | `string \| null` | API error message |
| `startupElapsed` | `number` | Seconds since YouTube stream start |

---

## 5. Socket.IO Subscription Design

### 5.1 Camera Status Updates

```typescript
// In App.tsx or CameraList.tsx
socket.on('cameras', (cameras: Camera[]) => {
  cameraStore.setCameras(cameras);
});

socket.on('camera:status', (data: { id: string; status: Camera['status'] }) => {
  cameraStore.updateCameraStatus(data.id, data.status);
});
```

### 5.2 Discovery Events

```typescript
socket.on('discovery:result', (device: DiscoveredCamera) => {
  discoveryStore.addOrUpdate(device);
  if (!autoSwitched) {
    setSubTab('found');
    setAutoSwitched(true);
  }
});

socket.on('discovery:scanning', (scanning: boolean) => {
  discoveryStore.setScanning(scanning);
});

socket.on('discovery:cleared', () => {
  discoveryStore.clearFound();
});
```

---

## 6. TypeScript Interface Definitions

```typescript
interface Camera {
  id:             string;
  name:           string;
  rtspUrl?:       string;
  youtubeUrl?:    string;
  ip?:            string;
  mac?:           string;
  httpPort?:      number;
  type?:          'rtsp' | 'youtube';
  status:         'live' | 'offline' | 'error' | 'connecting' | 'reconnecting' | 'streaming' | 'idle';
  aiEnabled?:     boolean;    // default: true
  webrtcEnabled?: boolean;    // default: false
  bitrate?:       number;     // YouTube only (kbps)
  resolution?:    string;     // YouTube only
  repeat?:        boolean;    // YouTube only
  pipelineStatus?: string | null;
}

interface DiscoveredCamera {
  Model?:           string;
  Manufacturer?:    string;
  IPAddress:        string;
  MACAddress?:      string;
  Gateway?:         string;
  SubnetMask?:      string;
  HttpPort?:        number;
  HttpsPort?:       number;
  rtspUrl?:         string;
  SupportOnvif?:    boolean;
  SupportSunapi?:   boolean;
  source?:          'onvif' | 'udp' | 'both';
  firmware?:        string;
}

// StatusDot color mapping
const STATUS_COLORS: Record<Camera['status'], string> = {
  live:         'bg-green-500',
  error:        'bg-red-500',
  offline:      'bg-gray-500',
  connecting:   'bg-yellow-500',
  streaming:    'bg-yellow-500',
  reconnecting: 'bg-yellow-500',
  idle:         'bg-yellow-500',
};
```

---

## 7. REST API Integration

### 7.1 On Mount — Fetch Cameras

```typescript
useEffect(() => {
  fetch('/api/cameras')
    .then(r => r.json())
    .then(d => cameraStore.setCameras(d.data));
}, []);
```

### 7.2 Add RTSP Camera

```typescript
async function handleAddRTSP() {
  setSaving(true);
  setError(null);
  const res = await fetch('/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, rtspUrl, username, password, webrtcEnabled }),
  });
  const data = await res.json();
  if (!data.success) { setError(data.error); setSaving(false); return; }
  cameraStore.addCamera(data.data);
  setSubTab('added');
  onClose();
}
```

### 7.3 Reconnect Camera

```typescript
async function handleReconnect(cameraId: string) {
  setReconnectingId(cameraId);
  await fetch(`/api/cameras/${cameraId}/stream/reconnect`, { method: 'POST' });
  setTimeout(() => setReconnectingId(null), 2000);
}
```

### 7.4 AI Toggle

```typescript
async function handleAiToggle(camera: Camera) {
  const res = await fetch(`/api/cameras/${camera.id}/ai/toggle`, { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    cameraStore.updateCamera(camera.id, { aiEnabled: data.aiEnabled });
  }
}
```

### 7.5 Delete Camera

```typescript
async function handleDelete(cameraId: string) {
  if (!window.confirm('Delete this camera?')) return;
  await fetch(`/api/cameras/${cameraId}`, { method: 'DELETE' });
  cameraStore.removeCamera(cameraId);
}
```

### 7.6 YouTube Stream Add (with Polling)

```typescript
async function handleAddYouTube() {
  setSaving(true);
  const res = await fetch('/api/youtube-streams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ytName, url: ytUrl, resolution, bitrate, repeat }),
  });
  const data = await res.json();
  if (!data.success) { setError(data.error); setSaving(false); return; }

  // Poll for live status
  const streamId = data.data.id;
  const interval = setInterval(async () => {
    setStartupElapsed(e => e + 1);
    const status = await fetch(`/api/youtube-streams/${streamId}/status`).then(r => r.json());
    if (status.data?.status === 'live') {
      clearInterval(interval);
      cameraStore.addCamera(status.data);
      onClose();
    }
  }, 1000);
}
```

### 7.7 Found Tab Search Logic

```typescript
const SEARCH_FIELDS = [
  'Model', 'Manufacturer', 'IPAddress', 'MACAddress',
  'Gateway', 'SubnetMask', 'HttpPort', 'HttpsPort',
  'Port', 'URL', 'rtspUrl',
] as const;

const VIRTUAL_KEYWORDS: Record<string, (cam: DiscoveredCamera) => boolean> = {
  onvif:   cam => !!(cam.SupportOnvif || cam.source === 'onvif' || cam.source === 'both'),
  sunapi:  cam => !!(cam.SupportSunapi),
  wisenet: cam => !!(cam.SupportSunapi || cam.source === 'udp' || cam.source === 'both'),
  hanwha:  cam => !!(cam.SupportSunapi || cam.source === 'udp' || cam.source === 'both'),
  udp:     cam => !!(cam.source === 'udp' || cam.source === 'both'),
};
```

---

## 8. Responsive & Mobile Considerations

- On mobile, `CameraList` is rendered in the bottom 40% of the Cameras tab (below CameraGrid)
- Camera rows are fully readable at 320 px width; `truncate` class prevents overflow on names
- `CameraEditModal` renders as `fixed inset-0 z-50`; it is accessible on mobile
- Touch targets for action buttons (Edit, Reconnect, AI, Delete) are ≥ 44 px via padding
- `DiscoveredCameraPanel` is positioned absolute relative to the Camera Grid; on mobile it may cover most of the grid area by design

---

## 9. Sequence Diagrams

### 9.1 Add RTSP Camera

```
User clicks "+ Add"
  → CameraEditModal opens (add mode, rtsp tab)
User fills Name + RTSP URL → clicks "Save"
  → POST /api/cameras → 201 { data: camera }
  → cameraStore.addCamera(camera)
  → setSubTab('added')
  → modal closes
```

### 9.2 Discovery Auto-Switch

```
Server starts ONVIF/UDP scan
  → discovery:scanning (true) → DiscoveryStore.setScanning(true)
  → [ping dot appears in Found tab label]
  → discovery:result (device) → DiscoveryStore.addOrUpdate(device)
  → [autoSwitched === false] → setSubTab('found'); setAutoSwitched(true)
  → discovery:scanning (false) → DiscoveryStore.setScanning(false)
```

### 9.3 Edit Camera with Reconnect

```
User clicks ✎ (edit)
  → CameraEditModal opens (edit mode, pre-populated)
User changes RTSP URL → clicks "Save & Reconnect"
  → PUT /api/cameras/:id → server restarts pipeline
  → POST /api/cameras/:id/stream/reconnect
  → cameraStore.updateCamera(id, updates)
  → modal closes after 0.8s
```

---

## 10. Error Handling

| Scenario | Handling |
|---|---|
| `GET /api/cameras` fails on mount | Log error; CameraStore remains empty; empty state shown |
| `POST /api/cameras` fails | Set `error` state in modal; button re-enabled |
| `PUT /api/cameras/:id` fails | Set `error` state; "Saving…" reverses to "Save" |
| `DELETE /api/cameras/:id` fails | Log error; camera row not removed from local state |
| `POST /api/cameras/:id/ai/toggle` fails | Log error; AI badge reverts to previous state |
| YouTube `YT_DLP_FAILED` error | Show localized message in modal |
| YouTube polling times out | Show `STREAM_TIMEOUT` error; allow retry |
| Discovery:result for already-known IP | `addOrUpdate` deduplicates by IP or MAC address |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Dashboard Sidebar Cameras |
