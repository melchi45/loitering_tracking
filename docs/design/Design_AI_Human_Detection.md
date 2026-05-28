# DESIGN DOCUMENT
# AI Module — Human Detection

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Human_Detection.md |

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
│           ├─ Socket.IO: 'detections' event                  │
│           └─ REST: fetch('/api/capabilities')               │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)             │
│                                                              │
│  index.js                                                    │
│   ├─ GET /api/capabilities  → capabilities handler          │
│   └─ GET /api/analytics/config → analyticsConfig handler    │
│                                                              │
│  services/pipelineManager.js                                 │
│   ├─ _detectionService: DetectionService                    │
│   ├─ analyticsConfig.isClassEnabled(0)  — person gate       │
│   ├─ ZoneManager.matchZone(bbox)        — zone assignment   │
│   ├─ TrackingService.update(detections) — dwell tracking    │
│   └─ io.emit('detections', payload)    — per-frame push     │
│                                                              │
│  services/detection.js                                       │
│   ├─ load()       — ONNX InferenceSession (yolov8n.onnx)    │
│   ├─ detect()     — preprocess + inference + postprocess    │
│   ├─ _preprocess()  — letterbox resize, CHW Float32         │
│   ├─ _postprocess() — filter class 0, coord transform, NMS  │
│   └─ _nms()         — IoU-based suppression                 │
│                                                              │
│  models/                                                     │
│   └─ yolov8n.onnx  (YOLOv8n COCO 80-class)                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── detection.js          # DetectionService — YOLOv8n ONNX
│   │   │   ├── pipelineManager.js    # Frame pipeline + person gating
│   │   │   └── attributePipeline.js  # Attribute enrichment (color, face, ppe)
│   │   └── index.js                  # Express app + capabilities endpoint
│   ├── models/
│   │   └── yolov8n.onnx              # COCO 80-class YOLOv8n model
│   └── storage/
│       └── lts.json                  # Persistent config store
│
├── client/
│   └── src/
│       ├── components/
│       │   └── DetectionOverlay.tsx  # Renders person bounding boxes
│       └── types/
│           └── index.ts              # Detection, BBox TypeScript types
│
├── docs/
│   ├── srs/SRS_AI_Human_Detection.md
│   └── design/Design_AI_Human_Detection.md  ← this file
│
└── test/
    └── api/
        └── human_detection.test.js
```

---

## 3. Server-Side Design

### 3.1 DetectionService (`server/src/services/detection.js`)

**Responsibilities:**
- Load and hold the ONNX InferenceSession for YOLOv8n
- Expose `detect(jpegBuffer, originalSize?)` returning detections for all 80 COCO classes
- Person-class filtering (classId === 0) is one part of the returned output

**Key design points:**

| Method | Input | Output | Notes |
|---|---|---|---|
| `load()` | — | `Promise<void>` | Idempotent; uses `_loading` promise to serialize concurrent calls |
| `detect(buf, size?)` | JPEG Buffer, optional `{width, height}` | `{ detections, frameWidth, frameHeight }` | Calls `load()` lazily if needed |
| `_preprocess(buf)` | JPEG Buffer | `{ tensor, scaledW, scaledH, padLeft, padTop, srcW, srcH }` | Letterbox → CHW Float32 |
| `_postprocess(data, dims, ...)` | Raw model output + geometry params | `Detection[]` | Filters ENABLED_CLASSES, confidence, NMS |
| `_nms(detections)` | Detection candidates | Filtered `Detection[]` | Sorted by confidence DESC, IoU ≥ iouThreshold suppressed |

**State machine:**

```
constructor()
  → _session = null, _loading = null

load() called:
  → _session already set: return (no-op)
  → _loading in progress: return same promise (no duplicate session)
  → otherwise: ort.InferenceSession.create() → _session set

detect() called:
  → _session null: calls load() first (lazy init)
  → runs _preprocess() → _session.run() → _postprocess()
  → returns { detections[], frameWidth, frameHeight }
```

**Preprocessing flow:**

```
JPEG Buffer
  → sharp.metadata()         — get srcW, srcH
  → scale = min(640/srcW, 640/srcH)
  → sharp.resize(scaledW, scaledH)
       .extend({ background: {r:114,g:114,b:114} })   — letterbox pad
       .removeAlpha()
       .raw()
  → Float32Array[3 × 640 × 640]
       channel layout: all-R | all-G | all-B (planar CHW)
       each value = pixel / 255.0
  → ort.Tensor('float32', float32, [1, 3, 640, 640])
```

**Person-class postprocessing:**

```
Output tensor [1, 84, 8400]:
  for each anchor b in 0..8399:
    cx, cy, bw, bh = data[0..3 × 8400 + b]
    class scores = data[4..83 × 8400 + b]
    maxClass = argmax(scores)
    if maxClass not in ENABLED_CLASSES → skip
    if score < confidenceThreshold → skip
    transform coords to original frame space
    push to candidates

NMS(_nms) → kept detections
```

**Person-specific output (classId === 0):**
- PipelineManager reads `detections` and routes classId === 0 results to the human-detection path
- Minimum size filter: width < 32 or height < 64 discards noise (applied in PipelineManager)

### 3.2 PipelineManager (`server/src/services/pipelineManager.js`)

**Human detection integration:**

| Step | Logic |
|---|---|
| 1. `detect()` called | All 80-class detections returned |
| 2. Class 0 gate | `analyticsConfig.isClassEnabled(0)` — if false, persons suppressed |
| 3. Size filter | Discard person boxes: width < 32 or height < 64 |
| 4. Zone match | `ZoneManager.matchZone(bbox)` assigns `zoneId` |
| 5. Track | `TrackingService.update(persons)` — dwell time computed |
| 6. Enrich | `attributePipeline.enrich(...)` — color, face, PPE attached |
| 7. Emit | `io.emit('detections', payload)` |

---

## 4. Client-Side Design

### 4.1 Detection Overlay Component

**Socket.IO subscription (App.tsx):**
```typescript
// window.__ltsSocket receives 'detections' event
socket.on('detections', (payload: DetectionFrame) => {
  // payload.detections[].className === 'person' items
  // rendered as bounding boxes on the live feed canvas
});
```

**Person detection rendering:**
- Bounding boxes drawn on canvas overlay
- Color coding: green for persons not loitering, red for loitering
- Confidence label displayed above each box
- `isLoitering` flag drives color and alert badge display

### 4.2 Capabilities Check

```typescript
// On mount, check human detection availability
const caps = await fetch('/api/capabilities').then(r => r.json());
if (!caps.ai?.humanDetection) {
  // Show "model not loaded" warning in UI
}
```

---

## 5. Data Model

### 5.1 Detection Object (returned by `detect()`)

```typescript
interface Detection {
  bbox:       { x: number; y: number; width: number; height: number };
  confidence: number;     // 0.0 – 1.0
  classId:    0;          // person
  className:  'person';
}
```

### 5.2 Enriched Detection (Socket.IO `detections` event payload)

```typescript
interface TrackedPerson {
  id:          string;    // tracker-assigned ID
  bbox:        BBox;
  confidence:  number;
  classId:     0;
  className:   'person';
  isLoitering: boolean;
  dwellTime:   number;    // seconds in current zone
  zoneId:      string | null;
  cameraId:    string;
  color?:      { upper: string; lower: string; upperRgb: number[]; lowerRgb: number[] };
  face?:       { bbox: BBox; score: number };
}
```

### 5.3 DetectionFrame (Socket.IO event shape)

```typescript
interface DetectionFrame {
  cameraId:   string;
  timestamp:  number;     // Unix ms
  frameWidth: number;
  frameHeight: number;
  detections: TrackedPerson[];
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
    "modelName": "yolov8n.onnx",
    "vehicleDetection": true,
    "vehicleClasses": ["bicycle", "car", "motorcycle", "bus", "truck", "airplane", "train", "boat"]
  }
}

Model missing:
{
  "ai": {
    "humanDetection": false
  }
}
```

### 6.2 Analytics Config

```
GET /api/analytics/config
→ 200:
{
  "classes": {
    "0": { "enabled": true,  "className": "person" },
    "2": { "enabled": true,  "className": "car" },
    ...
  }
}

PUT /api/analytics/config
  Body: { "classId": 0, "enabled": false }
→ 200: { "success": true }
```

### 6.3 Socket.IO Events

| Event | Direction | Trigger |
|---|---|---|
| `detections` | Server → Client | Every processed frame with person detections |
| `zone_alert` | Server → Client | Person enters loitering state in a zone |

---

## 7. Sequence Diagrams

### 7.1 Startup Sequence

```
Server start
  │
  ├─ DetectionService constructed (modelPath resolved)
  ├─ DetectionService.load() called
  │     └─ ort.InferenceSession.create('yolov8n.onnx')
  │          ├─ success → _session set
  │          └─ failure → _session = null, console.warn
  ├─ PipelineManager.start(cameras[])
  │     └─ per camera: startFrameLoop()
  └─ HTTP server.listen(PORT)
```

### 7.2 Per-Frame Human Detection

```
Camera JPEG Frame
  │
  ├─ DetectionService.detect(jpegBuffer, {width, height})
  │     ├─ _preprocess(): letterbox → CHW tensor
  │     ├─ _session.run({ images: tensor })
  │     └─ _postprocess(): parse [1,84,8400], filter class 0, NMS
  │          └─ { detections: [{bbox, confidence, classId:0, className:'person'},...] }
  │
  ├─ PipelineManager
  │     ├─ analyticsConfig.isClassEnabled(0) → true
  │     ├─ size filter (w≥32, h≥64)
  │     ├─ ZoneManager.matchZone() → zoneId
  │     ├─ TrackingService.update() → {id, dwellTime, isLoitering}
  │     ├─ AttributePipeline.enrich() → color, face attrs
  │     └─ io.emit('detections', enrichedFrame)
  │
  └─ Client receives 'detections' event, renders bboxes
```

---

## 8. Configuration & Environment

### 8.1 Environment Variables

```bash
YOLO_MODEL=models/yolov8n.onnx        # Model path (relative to server/)
CONFIDENCE_THRESHOLD=0.45             # Detection confidence cutoff
NMS_IOU_THRESHOLD=0.5                 # NMS IoU threshold
PORT=3001                             # Express server port
```

### 8.2 Constructor Options

```javascript
// detection.js constructor defaults
new DetectionService({
  modelPath:           path.resolve(__dirname, '..', '..', process.env.YOLO_MODEL || 'models/yolov8n.onnx'),
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.45'),
  iouThreshold:        parseFloat(process.env.NMS_IOU_THRESHOLD    || '0.5'),
})
```

### 8.3 ONNX Session Options

```javascript
// utils/onnxOptions.js
function getOnnxSessionOptions() {
  return {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  };
}
```

---

## 9. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| `yolov8n.onnx` missing at startup | `DetectionService.load()` | `_session = null`; `GET /api/capabilities` returns `humanDetection: false` |
| ONNX inference throws | `detect()` try/catch | Returns `{ detections: [], frameWidth: 0, frameHeight: 0 }` |
| Invalid JPEG buffer | `sharp.metadata()` throws | Caught in `_preprocess()`; returns empty detections |
| Concurrent `load()` calls | `_loading` promise guard | All callers await same promise; single session created |
| Lazy load failure | `detect()` catch | Returns empty result; server continues |
| `analyticsConfig` disables class 0 | PipelineManager gate | Persons suppressed from output; no crash |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Human Detection |
