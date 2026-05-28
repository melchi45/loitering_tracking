# DESIGN DOCUMENT
# AI Module — Vehicle Detection

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Vehicle_Detection.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design](#3-server-side-design)
4. [Client-Side Design](#4-client-side-design)
5. [Data Model](#5-data-model)
6. [API Design](#6-api-design)
7. [Sequence Diagrams](#7-sequence-diagrams)
8. [Configuration & Environment](#8-configuration--environment)
9. [Error Handling](#9-error-handling)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                        │
│  App.tsx ──────────── window.__ltsSocket (Socket.IO client) │
│      └─ DetectionOverlay / LiveFeedTab                      │
│           ├─ Socket.IO: 'detections' event (classId 1–8)    │
│           └─ REST: fetch('/api/capabilities')               │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)             │
│                                                              │
│  index.js                                                    │
│   ├─ GET /api/capabilities → vehicle class list             │
│   └─ GET /api/analytics/config → per-class enable/disable   │
│                                                              │
│  services/pipelineManager.js                                 │
│   ├─ SHARED _detectionService: DetectionService             │
│   ├─ analyticsConfig.isClassEnabled(classId 1–8)            │
│   ├─ ZoneManager.matchZone(bbox, 'vehicle')                 │
│   ├─ TrackingService.update(vehicleDetections)              │
│   └─ io.emit('detections', payload)                         │
│                                                              │
│  services/detection.js  [SHARED with Human Detection]       │
│   ├─ Single YOLOv8n ONNX inference pass                     │
│   └─ Returns all 80 COCO classes; vehicle routing           │
│        done in PipelineManager (classId 1–8)                │
│                                                              │
│  models/                                                     │
│   └─ yolov8n.onnx  (shared; full 80-class COCO)            │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── detection.js          # DetectionService — shared YOLOv8n ONNX
│   │   │   └── pipelineManager.js    # Vehicle class routing (classId 1–8)
│   │   └── index.js                  # Express app + capabilities endpoint
│   ├── models/
│   │   └── yolov8n.onnx              # COCO 80-class (shared with human detection)
│   └── storage/
│       └── lts.json                  # analyticsConfig persistent state
│
├── client/
│   └── src/
│       ├── components/
│       │   └── DetectionOverlay.tsx  # Renders vehicle bounding boxes
│       └── types/
│           └── index.ts              # Detection TypeScript types
│
├── docs/
│   ├── srs/SRS_AI_Vehicle_Detection.md
│   └── design/Design_AI_Vehicle_Detection.md  ← this file
│
└── test/
    └── api/
        └── vehicle_detection.test.js
```

---

## 3. Server-Side Design

### 3.1 DetectionService (Shared — `server/src/services/detection.js`)

**Key design decision: Shared inference pass**

A single ONNX inference call on each JPEG frame returns detections for all 80 COCO classes. Vehicle detection does not incur additional inference latency beyond human detection. The `detect()` method returns all classes; PipelineManager routes classId 1–8 to the vehicle processing path.

**COCO vehicle class mapping (classId → className):**

| classId | className   | Road-relevant |
|---------|-------------|---------------|
| 1       | bicycle     | Yes           |
| 2       | car         | Yes           |
| 3       | motorcycle  | Yes           |
| 4       | airplane    | No            |
| 5       | bus         | Yes           |
| 6       | train       | No            |
| 7       | truck       | Yes           |
| 8       | boat        | No            |

**Road-relevant vehicle set** (used for `targetClass: 'vehicle'` zone loitering):
```javascript
const ROAD_VEHICLES = new Set(['bicycle', 'car', 'motorcycle', 'bus', 'truck']);
```

**Model class count warning:**
```javascript
if (numClasses < 10) {
  console.warn(`[Detection] Only ${numClasses} class(es) detected — model may be a single-class fine-tune. Vehicles require a full COCO model.`);
}
```

### 3.2 PipelineManager Vehicle Routing

**Per-frame vehicle routing logic:**

```
All detections from DetectionService.detect()
  │
  ├─ filter: classId in {1,2,3,4,5,6,7,8}
  │
  ├─ for each vehicle detection:
  │     ├─ analyticsConfig.isClassEnabled(classId)  → false: suppress
  │     ├─ size filter: width < 20 OR height < 20 → discard
  │     ├─ ZoneManager.matchZone(bbox, 'vehicle')
  │     │     └─ zone match only if className in ROAD_VEHICLES
  │     ├─ TrackingService.update() → {id, dwellTime, isLoitering}
  │     └─ isLoitering && className in ROAD_VEHICLES → emit 'zone_alert'
  │
  └─ io.emit('detections', mergedPayload)  ← persons + vehicles combined
```

**Key design properties:**

| Property | Value |
|---|---|
| Inference sharing | Single `detect()` call per frame covers all vehicles |
| Per-class gating | `analyticsConfig.isClassEnabled(classId)` per vehicle type |
| Zone key | `'vehicle'` in zone config maps to ROAD_VEHICLES set |
| Non-road vehicles | airplane, train, boat appear in detections but not in zone loitering |

### 3.3 Analytics Config Class Gating

```javascript
// Per-class enable/disable example
analyticsConfig.setClassEnabled(4, false);  // disable airplane
analyticsConfig.setClassEnabled(6, false);  // disable train

// In PipelineManager per-vehicle:
if (!analyticsConfig.isClassEnabled(det.classId)) continue;
```

**Enabled/disabled state persisted to `storage/lts.json`** and reloaded on server restart.

---

## 4. Client-Side Design

### 4.1 Detection Overlay — Vehicle Rendering

**Socket.IO event handler:**
```typescript
socket.on('detections', (frame: DetectionFrame) => {
  const vehicles = frame.detections.filter(d =>
    [1,2,3,4,5,6,7,8].includes(d.classId)
  );
  // Render vehicle bboxes with class-specific colors:
  // car → blue, motorcycle → cyan, bus → purple, truck → orange, bicycle → yellow
});
```

**Zone alert handler:**
```typescript
socket.on('zone_alert', (alert: ZoneAlert) => {
  if (ROAD_VEHICLES.has(alert.className)) {
    // Show loitering vehicle alert notification
  }
});
```

### 4.2 Analytics Config Panel

- Checkbox per vehicle class to enable/disable via `PUT /api/analytics/config`
- UI reflects current state from `GET /api/analytics/config`
- Changes take effect on next processed frame (no server restart required)

---

## 5. Data Model

### 5.1 Vehicle Detection Object (from `detect()`)

```typescript
interface VehicleDetection {
  bbox:       { x: number; y: number; width: number; height: number };
  confidence: number;
  classId:    1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  className:  'bicycle' | 'car' | 'motorcycle' | 'airplane' | 'bus' | 'train' | 'truck' | 'boat';
}
```

### 5.2 Tracked Vehicle (Socket.IO `detections` event)

```typescript
interface TrackedVehicle {
  id:          string;
  bbox:        BBox;
  confidence:  number;
  classId:     number;    // 1–8
  className:   string;    // specific vehicle type
  isLoitering: boolean;
  dwellTime:   number;
  zoneId:      string | null;
  cameraId:    string;
}
```

### 5.3 Zone Alert Event

```typescript
interface ZoneAlert {
  zoneId:    string;
  cameraId:  string;
  className: string;    // e.g. 'car'
  trackerId: string;
  dwellTime: number;
  timestamp: number;
}
```

### 5.4 Analytics Config Entry

```typescript
interface ClassConfig {
  classId:   number;
  className: string;
  enabled:   boolean;
}
```

---

## 6. API Design

### 6.1 Capabilities Endpoint

```
GET /api/capabilities
→ 200:
{
  "ai": {
    "humanDetection": true,
    "vehicleDetection": true,
    "vehicleClasses": ["bicycle","car","motorcycle","bus","truck","airplane","train","boat"],
    "modelName": "yolov8n.onnx"
  }
}

Model missing (vehicleDetection follows humanDetection):
{
  "ai": {
    "humanDetection": false,
    "vehicleDetection": false
  }
}
```

### 6.2 Analytics Config

```
GET /api/analytics/config
→ 200:
{
  "classes": {
    "1": { "enabled": true,  "className": "bicycle" },
    "2": { "enabled": true,  "className": "car" },
    "3": { "enabled": true,  "className": "motorcycle" },
    "4": { "enabled": false, "className": "airplane" },
    "5": { "enabled": true,  "className": "bus" },
    "6": { "enabled": false, "className": "train" },
    "7": { "enabled": true,  "className": "truck" },
    "8": { "enabled": false, "className": "boat" }
  }
}

PUT /api/analytics/config
  Body: { "classId": 4, "enabled": false }
→ 200: { "success": true }
```

### 6.3 Socket.IO Events

| Event | Direction | Condition |
|---|---|---|
| `detections` | Server → Client | Per-frame vehicle detections (classId 1–8, after gating) |
| `zone_alert` | Server → Client | Road-relevant vehicle loitering threshold exceeded |

---

## 7. Sequence Diagrams

### 7.1 Shared Inference Per Frame

```
Camera JPEG Frame
  │
  ├─ DetectionService.detect(jpegBuffer, frameSize)
  │     ├─ Single ONNX inference → all 80 classes
  │     └─ Returns: detections[] with classId 0–79
  │
  ├─ PipelineManager — route by classId
  │     ├─ classId === 0 → human detection path
  │     └─ classId in {1..8} → vehicle detection path
  │           ├─ analyticsConfig.isClassEnabled(classId)
  │           ├─ ZoneManager.matchZone(bbox, 'vehicle')
  │           │     └─ zoneMatch only if className in ROAD_VEHICLES
  │           ├─ TrackingService.update(vehicles)
  │           └─ isLoitering → emit 'zone_alert'
  │
  └─ io.emit('detections', { persons[], vehicles[], ... })
```

### 7.2 Analytics Config Toggle

```
Client                     Server
  │                           │
  │──PUT /api/analytics/config │
  │   { classId:4, enabled:false }
  │                           │
  │                           ├─ analyticsConfig.setClassEnabled(4, false)
  │                           ├─ persist to lts.json
  │                           └─ next frame: airplane detections suppressed
  │<── 200 { success: true } ─│
```

---

## 8. Configuration & Environment

### 8.1 Environment Variables

```bash
YOLO_MODEL=models/yolov8n.onnx     # Shared model path
CONFIDENCE_THRESHOLD=0.45          # Applies to all COCO classes
NMS_IOU_THRESHOLD=0.5              # NMS IoU (inter-class suppression allowed)
PORT=3001
```

### 8.2 Road-Vehicle Zone Mapping

```javascript
// pipelineManager.js — zone class key to className set mapping
const ZONE_CLASS_MAP = {
  'vehicle': new Set(['bicycle', 'car', 'motorcycle', 'bus', 'truck']),
  'human':   new Set(['person']),
};
```

### 8.3 Default Analytics Config (all vehicle classes enabled on fresh install)

```javascript
// analyticsConfig defaults
const DEFAULT_CLASS_ENABLED = {
  0: true,   // person
  1: true,   // bicycle
  2: true,   // car
  3: true,   // motorcycle
  4: false,  // airplane (not road-relevant; disabled by default)
  5: true,   // bus
  6: false,  // train   (not road-relevant; disabled by default)
  7: true,   // truck
  8: false,  // boat    (not road-relevant; disabled by default)
};
```

---

## 9. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| `yolov8n.onnx` missing | `DetectionService.load()` | `_session = null`; `vehicleDetection: false` in capabilities |
| Single-class model loaded | `_postprocess()` | Warning logged; vehicle classes simply absent from output |
| Per-class disabled | PipelineManager gate | That classId suppressed; other classes unaffected |
| Inference error | `detect()` try/catch | Returns `{ detections: [], ... }`; no crash |
| Zone config missing `targetClass` | PipelineManager | All road-relevant vehicles match zone by default |
| Concurrent detection calls | Independent tensor allocs | Each `detect()` call uses own Float32Array; no shared state |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Vehicle Detection |
