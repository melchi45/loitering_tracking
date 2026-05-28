# DESIGN DOCUMENT
# Dashboard — Detection Visualization & Display Module

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-DD-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_Dashboard_Detection_Display.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Component Tree](#3-component-tree)
4. [State Management Design](#4-state-management-design)
5. [Socket.IO Subscription Design](#5-socketio-subscription-design)
6. [TypeScript Interface Definitions](#6-typescript-interface-definitions)
7. [REST API Integration](#7-rest-api-integration)
8. [Canvas Rendering Design](#8-canvas-rendering-design)
9. [Responsive & Mobile Considerations](#9-responsive--mobile-considerations)
10. [Error Handling](#10-error-handling)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                            │
│                                                                  │
│  CameraView.tsx                                                  │
│   ├─ <video> or <canvas> (WebRTC / JPEG frame)                  │
│   └─ <canvas> (overlay — bboxes, labels, zone polygons)          │
│                                                                  │
│  FullscreenCameraView.tsx                                        │
│   ├─ DetectionPanel.tsx (256px fixed left)                       │
│   │    ├─ Detection rows (sorted: loitering-first)               │
│   │    ├─ Cross-Camera Re-ID section (useCrossCameraStore)       │
│   │    └─ Collapsible legend (8 sections)                        │
│   └─ CameraView.tsx (flex-1 right)                              │
│                                                                  │
│  DashboardDetectionPanel.tsx (sidebar Detections tab)            │
│   ├─ Camera filter dropdown                                      │
│   └─ useAllDetections(cameraIds) → merged + sorted list          │
│                                                                  │
│  VideoAnalyticsTab.tsx (sidebar Analytics tab)                   │
│   ├─ AI module toggles (GET/PUT /api/analytics/config)           │
│   └─ Kalman slider section (GET/PUT /api/tracker/config)         │
└──────────────────────────────────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼─────────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)                  │
│  Socket.IO: 'detections', 'frame', 'loitering', 'fire:alert'    │
│  REST: /api/analytics/config, /api/tracker/config, /api/capab.   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── client/
│   └── src/
│       ├── components/
│       │   ├── CameraView.tsx              # Canvas overlay + video stream
│       │   ├── FullscreenCameraView.tsx    # Two-column fullscreen layout
│       │   ├── DashboardDetectionPanel.tsx # Sidebar aggregated detections tab
│       │   └── VideoAnalyticsTab.tsx       # Analytics toggles + Kalman sliders
│       ├── hooks/
│       │   └── useAllDetections.ts         # Multi-camera Socket.IO subscriptions
│       └── stores/
│           └── crossCameraStore.ts         # Re-ID events (max 20, 60s TTL)
└── docs/
    ├── srs/SRS_Dashboard_Detection_Display.md
    ├── design/Design_Dashboard_Detection_Display.md  ← this file
    └── tc/TC_Dashboard_Detection_Display.md
```

---

## 3. Component Tree

```
CameraView
├─ <video> / <canvas> (stream)
└─ <canvas> (overlay, absolute positioned)
    ├─ drawBoundingBox(det, color)
    ├─ drawLabel(det)
    ├─ drawAttributeBadges(det)
    ├─ drawDwellTime(det)
    ├─ drawColorAttribute(det)
    └─ drawZonePolygons(zones[])

FullscreenCameraView
├─ DetectionPanel (w-64 fixed left)
│   ├─ Header: "N obj  M loiter"
│   ├─ Detection rows (sorted)
│   │   └─ DetectionRow × N
│   │       ├─ className + objectId/faceId
│   │       ├─ matchScore (face only)
│   │       ├─ CROSS-CAM badge (conditional)
│   │       ├─ confidence + dwellTime
│   │       ├─ bbox coordinates grid
│   │       ├─ AMF metrics (zone-matched only)
│   │       └─ attribute badges
│   ├─ Cross-Camera Re-ID section (conditional, collapsible)
│   └─ Legend (collapsible, default collapsed, max-h-64)
│       └─ 8 sections
└─ CameraView (flex-1)

DashboardDetectionPanel (sidebar)
├─ Camera filter dropdown
└─ Merged detection list (all enabled cameras)
    └─ DetectionRow × N (+ camera name badge)

VideoAnalyticsTab (sidebar)
├─ AI module toggle groups
│   ├─ People & Vehicles
│   ├─ Accessories
│   ├─ AI Attributes
│   ├─ Hazards
│   └─ Indoor/Office
└─ Kalman/Tracker Settings (collapsible)
    ├─ Sliders × 6
    └─ Reset button
```

---

## 4. State Management Design

### 4.1 CameraView State

| State | Type | Purpose |
|---|---|---|
| `detections` | `Detection[]` | Current frame detections from Socket.IO |
| `frameUrl` | `string \| null` | Last JPEG frame URL for canvas background |
| `zones` | `Zone[]` | Camera zones for polygon overlay |

### 4.2 DashboardDetectionPanel State

| State | Type | Purpose |
|---|---|---|
| `enabledCameras` | `Set<string>` | Camera IDs currently shown in list |
| `allDetections` | `Detection[]` | Merged + sorted detections from all enabled cameras |

### 4.3 VideoAnalyticsTab State

| State | Type | Purpose |
|---|---|---|
| `config` | `Record<string, boolean>` | AI module toggle states |
| `capabilities` | `Record<string, boolean>` | Model availability from server |
| `trackerConfig` | `TrackerConfig` | Kalman slider values |
| `debounceTimer` | `ReturnType<typeof setTimeout>` | 300 ms debounce for slider changes |

### 4.4 CrossCameraStore (Zustand)

```typescript
interface CrossCameraStore {
  events:   CrossCameraReIdEvent[];  // max 20, pruned by 60s TTL
  addEvent: (event: CrossCameraReIdEvent) => void;
  clear:    () => void;
}
```

### 4.5 useAllDetections Hook

```typescript
// hooks/useAllDetections.ts
export function useAllDetections(cameraIds: string[]): Detection[] {
  const [detMap, setDetMap] = useState<Map<string, Detection[]>>(new Map());

  useEffect(() => {
    const socket = (window as any).__ltsSocket;
    const handlers: Array<() => void> = [];

    for (const id of cameraIds) {
      const handler = (data: { cameraId: string; detections: Detection[] }) => {
        if (data.cameraId !== id) return;
        setDetMap(prev => new Map(prev).set(id, data.detections));
      };
      socket.on('detections', handler);
      handlers.push(() => socket.off('detections', handler));
    }
    return () => handlers.forEach(fn => fn());
  }, [cameraIds.join(',')]);

  // Merge: loitering first, then descending dwellTime
  return useMemo(() => {
    const all = [...detMap.values()].flat();
    return all.sort((a, b) => {
      if (a.isLoitering !== b.isLoitering) return a.isLoitering ? -1 : 1;
      return b.dwellTime - a.dwellTime;
    });
  }, [detMap]);
}
```

---

## 5. Socket.IO Subscription Design

### 5.1 Per-Camera Detections

```typescript
// In CameraView.tsx
useEffect(() => {
  const socket = (window as any).__ltsSocket;
  const handler = (data: { cameraId: string; detections: Detection[] }) => {
    if (data.cameraId !== cameraId) return;
    setDetections(data.detections);
    requestAnimationFrame(() => drawOverlay(canvasRef.current, data.detections, zones));
  };
  socket.on('detections', handler);
  return () => socket.off('detections', handler);
}, [cameraId, zones]);
```

### 5.2 Cross-Camera Re-ID

```typescript
// In App.tsx
socket.on('face:reidentified', (event: CrossCameraReIdEvent) => {
  crossCameraStore.addEvent(event);
});
```

### 5.3 Fire Alert

```typescript
socket.on('fire:alert', (data: { cameraId: string; zone: string }) => {
  // Triggers FIRE badge pulse in DetectionPanel for the relevant camera
  setFireAlerts(prev => ({ ...prev, [data.cameraId]: Date.now() }));
});
```

---

## 6. TypeScript Interface Definitions

```typescript
interface Detection {
  objectId:       string;
  className:      string;
  confidence:     number;
  bbox:           BBox;
  isLoitering:    boolean;
  dwellTime:      number;
  faceId?:        string;
  matchScore?:    number;
  crossCamera?:   boolean;
  riskScore?:     number;
  revisitCount?:  number;
  velocity?:      number;
  circularScore?: number;
  face?:          { identity?: string; faceId?: string; matchScore?: number };
  mask?:          { label: 'MASK OK' | 'NO MASK' | 'MASK?' };
  hat?:           { label: 'HELMET' | 'NO HELMET' | 'HAT?' };
  color?:         { upper: string; lower: string };
  cloth?:         { upper: string; lower: string; sleeve: string };
}

interface BBox {
  x: number; y: number; width: number; height: number;
}

interface TrackerConfig {
  fastSpeedThreshold: number;   // default 30
  fastQScale:         number;   // default 4.0
  slowSpeedThreshold: number;   // default 5
  slowQScale:         number;   // default 0.50
  occlusionQScale:    number;   // default 3.0
  measurementNoise:   number;   // default 10
}

// Detection class → canvas color mapping
const CLASS_COLORS: Record<string, string> = {
  person:   'rgba(34,197,94,0.9)',
  face:     'rgba(147,197,253,0.95)',
  car:      'rgba(59,130,246,0.9)',
  fire:     'rgba(255,80,0,1.0)',
  smoke:    'rgba(100,116,139,0.9)',
  backpack: 'rgba(245,158,11,0.9)',
  handbag:  'rgba(245,158,11,0.9)',
  _default: 'rgba(156,163,175,0.9)',
  _loiter:  'rgba(239,68,68,0.9)',
};
```

---

## 7. REST API Integration

### 7.1 VideoAnalyticsTab — On Mount

```typescript
useEffect(() => {
  Promise.all([
    fetch('/api/analytics/config').then(r => r.json()),
    fetch('/api/capabilities').then(r => r.json()),
    fetch('/api/tracker/config').then(r => r.json()),
  ]).then(([config, caps, tracker]) => {
    setConfig(config.data);
    setCapabilities(caps.data);
    setTrackerConfig(tracker.data);
  });
}, []);
```

### 7.2 AI Toggle

```typescript
async function handleToggle(moduleKey: string, enabled: boolean) {
  const newConfig = { ...config, [moduleKey]: enabled };
  setConfig(newConfig);  // optimistic update
  await fetch('/api/analytics/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newConfig),
  });
}
```

### 7.3 Kalman Slider Change (Debounced)

```typescript
function handleSliderChange(key: keyof TrackerConfig, value: number) {
  const updated = { ...trackerConfig, [key]: value };
  setTrackerConfig(updated);

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    fetch('/api/tracker/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
  }, 300);
}
```

### 7.4 Kalman Reset

```typescript
async function handleReset() {
  const res = await fetch('/api/tracker/config/reset', { method: 'POST' });
  const data = await res.json();
  setTrackerConfig(data.data);  // restore defaults from server
}
```

---

## 8. Canvas Rendering Design

### 8.1 Drawing Pipeline

```
Socket.IO 'detections' event received
  → setDetections(newDetections)
  → requestAnimationFrame(drawOverlay)
      → clearRect(canvas)
      → for each detection:
          drawZonePolygons(zones)    // once, before detections
          drawBoundingBox(det)
          drawLabel(det)
          drawAttributeBadges(det)
          drawColorAttribute(det)
          drawDwellTime(det)
```

### 8.2 Frame-Drop Guard

```typescript
let _inferring = false;

socket.on('frame', async (data) => {
  if (_inferring) return;  // skip if previous frame still processing
  _inferring = true;
  try {
    await processFrame(data);
  } finally {
    _inferring = false;
  }
});
```

### 8.3 Face Detection Rendering

```typescript
function drawFaceBox(ctx: CanvasRenderingContext2D, det: Detection) {
  ctx.strokeStyle = 'rgba(147,197,253,0.95)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(det.bbox.x, det.bbox.y, det.bbox.width, det.bbox.height);
  ctx.setLineDash([]);
}
```

---

## 9. Responsive & Mobile Considerations

### 9.1 Fullscreen Layout Adaptation

```typescript
// FullscreenCameraView.tsx
const isMobile = window.innerWidth < 768;

return isMobile ? (
  // Vertical split: video top, panel bottom
  <div className="flex flex-col h-full">
    <CameraView className="h-[60%]" />
    <DetectionPanel className="h-[40%] overflow-y-auto" />
  </div>
) : (
  // Horizontal split: panel left, video right
  <div className="flex h-full">
    <DetectionPanel className="w-64 shrink-0 overflow-y-auto" />
    <CameraView className="flex-1" />
  </div>
);
```

### 9.2 Dashboard Detection Tab on Mobile

The DashboardDetectionPanel is shown fullscreen in the Detections mobile tab, removing the fixed 256 px width constraint.

---

## 10. Error Handling

| Scenario | Handling |
|---|---|
| `GET /api/analytics/config` fails | Log error; toggles remain at last known state (or all disabled) |
| `GET /api/capabilities` fails | All modules shown as available (no gating); log warning |
| `PUT /api/tracker/config` fails | Slider values revert to last saved state; show error toast |
| `POST /api/tracker/config/reset` fails | Slider values not changed; show error message |
| Canvas context not available | Guard: `if (!ctx) return;` before every draw call |
| Detection payload missing fields | Guard: optional chaining (`det.mask?.label`) throughout render functions |
| Cross-camera store exceeds 20 events | `addEvent` prunes the oldest entry before inserting |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Dashboard Detection Display |
