# DESIGN DOCUMENT
# AI Module — Fire & Smoke Detection

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-06 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Fire_Smoke_Detection.md |

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
│      └─ AlertPanel / LiveFeedTab                            │
│           ├─ Socket.IO: 'detections' event (className fire/smoke)
│           └─ REST: fetch('/api/capabilities')               │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)             │
│                                                              │
│  index.js                                                    │
│   └─ GET /api/capabilities → fireSmokeDetection status      │
│                                                              │
│  services/pipelineManager.js                                 │
│   ├─ _fireSmokeService: FireSmokeService                    │
│   ├─ fireSmokeService.ready  — gate: skip if not ready      │
│   ├─ FireSmokeService.detect(jpegBuf, origW, origH)         │
│   └─ Merge fire/smoke into io.emit('detections', payload)   │
│                                                              │
│  services/fireSmokeService.js                               │
│   ├─ load()         — file check + ONNX session create      │
│   ├─ detect()       — preprocess + inference + postprocess  │
│   ├─ _postprocess() — anchor parsing, NMS, class filter     │
│   ├─ get ready()    — boolean                               │
│   └─ get status()   — 'not_started'|'missing'|'loaded'|'failed'
│                                                              │
│  models/                                                     │
│   └─ yolov8s_fire_smoke.onnx  (YOLOv8s, 3 classes)         │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── fireSmokeService.js    # FireSmokeService — YOLOv8s ONNX
│   │   │   └── pipelineManager.js    # Fire/smoke detection integration
│   │   └── index.js                  # Express app + capabilities endpoint
│   ├── models/
│   │   ├── yolov8n.onnx               # Human/vehicle detection (separate)
│   │   └── yolov8s_fire_smoke.onnx    # Fire/smoke detection (optional)
│   └── storage/
│       └── lts.json
│
├── client/
│   └── src/
│       ├── components/
│       │   └── AlertPanel.tsx         # Fire/smoke alert display
│       └── types/
│           └── index.ts
│
├── docs/
│   ├── srs/SRS_AI_Fire_Smoke_Detection.md
│   └── design/Design_AI_Fire_Smoke_Detection.md  ← this file
│
└── test/
    └── api/
        └── fire_smoke_detection.test.js
```

---

## 3. Server-Side Design

### 3.1 FireSmokeService (`server/src/services/fireSmokeService.js`)

**Responsibilities:**
- Optional fire/smoke model lifecycle (load, status, graceful missing-file handling)
- Per-frame detection: letterbox preprocess, ONNX inference, postprocess with SKIP_CLASSES
- Expose `ready` and `status` properties for upstream gating

**Key design points:**

| Method/Property | Input | Output | Notes |
|---|---|---|---|
| `load()` | — | `Promise<void>` | File check first; sets `_status`, `_ready` |
| `detect(buf, origW, origH)` | JPEG Buffer, frame dims | `Array<{className, confidence, bbox}>` | Returns `[]` if not ready; invalid/missing frame dims fallback to JPEG metadata |
| `get ready()` | — | `boolean` | `true` only when `_status === 'loaded'` |
| `get status()` | — | `string` | `'not_started'` \| `'missing'` \| `'loaded'` \| `'failed'` |

**Status state machine:**

```
Initial: _status = 'not_started', _ready = false

load() called:
  │
  ├─ fs.existsSync(modelPath) === false
  │     → _status = 'missing'
  │       log: '[FireSmokeService] yolov8s_fire_smoke.onnx not found — fire/smoke detection disabled'
  │       return (no throw)
  │
  ├─ ort.InferenceSession.create() succeeds
  │     → _session set
  │       _ready = true
  │       _status = 'loaded'
  │       log: '[FireSmokeService] yolov8s_fire_smoke.onnx loaded'
  │
  └─ ort.InferenceSession.create() throws
        → _status = 'failed'
          log: '[FireSmokeService] Failed to load model: <err.message>'
          (exception does NOT propagate)
```

**Model class definitions:**
```javascript
const CLASS_NAMES  = ['fire', 'default', 'smoke'];  // indices 0, 1, 2
const SKIP_CLASSES = new Set(['default']);           // index 1 always suppressed
const NORMALISE    = { Fire: 'fire', fire: 'fire', smoke: 'smoke', default: 'default' };
```

**Preprocessing pipeline:**

```
Input: jpegBuffer, origW, origH

Letterbox resize to 640×640:
  scale  = Math.min(640 / origW, 640 / origH)
  scaledW = Math.round(origW * scale)
  scaledH = Math.round(origH * scale)
  padL   = Math.floor((640 - scaledW) / 2)
  padT   = Math.floor((640 - scaledH) / 2)

sharp(jpegBuffer)
  .resize(scaledW, scaledH, { fit: 'fill' })
  .extend({ top:padT, bottom:..., left:padL, right:...,
            background: { r:114, g:114, b:114 } })
  .removeAlpha()
  .raw()
  .toBuffer()

CHW Float32Array [1, 3, 640, 640]:
  float32[i]           = rawBuf[i*3]   / 255  (R channel)
  float32[numPx + i]   = rawBuf[i*3+1] / 255  (G channel)
  float32[2*numPx + i] = rawBuf[i*3+2] / 255  (B channel)
```

**Postprocessing pipeline:**

```
Output tensor [1, 7, 8400]:
  rows 0–3: cx, cy, bw, bh
  rows 4–6: class scores (fire=0, default=1, smoke=2)

for each anchor i in 0..8399:
  maxScore = max(scores[4..6])
  classIdx = argmax(scores[4..6])
  if maxScore < 0.35 → skip
  rawName = CLASS_NAMES[classIdx]
  if SKIP_CLASSES.has(rawName) → skip  ← 'default' filtered here

  x1 = (cx - bw/2 - padL) / scale
  y1 = (cy - bh/2 - padT) / scale
  x2 = (cx + bw/2 - padL) / scale
  y2 = (cy + bh/2 - padT) / scale

  Clamp: x1,y1 ≥ 0; x2 ≤ origW; y2 ≤ origH

  push { className: NORMALISE[rawName], confidence: maxScore, bbox }

NMS(_nms):
  sort by confidence DESC
  IoU ≥ 0.45 → suppress lower-confidence box
```

### 3.2 PipelineManager Integration

**Fire/smoke detection guard and merge:**

```javascript
// Per-frame detection
let fireSmokeDetections = [];
if (this._fireSmokeService?.ready) {
  fireSmokeDetections = await this._fireSmokeService.detect(
    jpegBuffer, frameWidth, frameHeight
  );
}

// Merge with main detection array
const allDetections = [
  ...personAndVehicleDetections,
  ...fireSmokeDetections.map(d => ({
    ...d,
    id:          generateId(),
    isLoitering: false,
    dwellTime:   0,
    zoneId:      null,
    cameraId,
  })),
];

io.emit('detections', { cameraId, detections: allDetections });
```

**Key design:** Fire/smoke detections are merged into the same `detections` event as persons and vehicles. No separate Socket.IO event channel is needed.

---

## 4. Client-Side Design

### 4.1 Alert Panel — Fire/Smoke Display

**Socket.IO fire/smoke detection handling:**
```typescript
socket.on('detections', (frame: DetectionFrame) => {
  const fireDetections  = frame.detections.filter(d => d.className === 'fire');
  const smokeDetections = frame.detections.filter(d => d.className === 'smoke');

  if (fireDetections.length > 0) {
    // Show flashing red alert: "Fire detected in camera <id>"
    triggerFireAlert(frame.cameraId, fireDetections);
  }
  if (smokeDetections.length > 0) {
    // Show amber alert: "Smoke detected"
    triggerSmokeAlert(frame.cameraId, smokeDetections);
  }
});
```

**Bounding box rendering:**
- Fire detections: red bounding box with flame icon
- Smoke detections: amber/gray bounding box with smoke icon
- Confidence label shown above each box

### 4.2 Capabilities Check

```typescript
const caps = await fetch('/api/capabilities').then(r => r.json());
if (!caps.ai?.fireSmokeDetection) {
  // Show "Fire & smoke detection unavailable (model not loaded)"
} else {
  // Show status: caps.ai.fireSmokeStatus ('loaded')
}
```

---

## 5. Data Model

### 5.1 Fire/Smoke Detection (from `detect()`)

```typescript
interface FireSmokeDetection {
  className:  'fire' | 'smoke';
  confidence: number;    // ≥ 0.35
  bbox: {
    x:      number;
    y:      number;
    width:  number;
    height: number;
  };
}
```

### 5.2 Enriched Detection (Socket.IO `detections` event)

```typescript
interface TrackedFireSmoke {
  id:          string;
  className:   'fire' | 'smoke';
  confidence:  number;
  bbox:        BBox;
  isLoitering: false;    // always false — fire/smoke are not tracked for dwell
  dwellTime:   0;
  zoneId:      null;
  cameraId:    string;
}
```

### 5.3 Service Status Values

```typescript
type FireSmokeStatus = 'not_started' | 'missing' | 'loaded' | 'failed';
```

---

## 6. API Design

### 6.1 Capabilities Endpoint

```
GET /api/capabilities
→ 200 (model loaded):
{
  "ai": {
    "fireSmokeDetection": true,
    "fireSmokeStatus": "loaded"
  }
}

→ 200 (model missing):
{
  "ai": {
    "fireSmokeDetection": false,
    "fireSmokeStatus": "missing"
  }
}

→ 200 (load failed):
{
  "ai": {
    "fireSmokeDetection": false,
    "fireSmokeStatus": "failed"
  }
}
```

### 6.2 Socket.IO Events

| Event | Direction | Condition |
|---|---|---|
| `detections` | Server → Client | Fire/smoke detections merged with person/vehicle detections per frame |

---

## 7. Sequence Diagrams

### 7.1 Startup — Model Present

```
Server start
  │
  ├─ FireSmokeService constructed
  │     → _status = 'not_started', _ready = false
  │
  ├─ FireSmokeService.load()
  │     ├─ fs.existsSync('yolov8s_fire_smoke.onnx') → true
  │     ├─ ort.InferenceSession.create(...)
  │     └─ _session set, _ready = true, _status = 'loaded'
  │
  └─ GET /api/capabilities → fireSmokeDetection: true, fireSmokeStatus: 'loaded'
```

### 7.2 Startup — Model Missing

```
Server start
  │
  ├─ FireSmokeService.load()
  │     ├─ fs.existsSync('yolov8s_fire_smoke.onnx') → false
  │     └─ _status = 'missing', log warning
  │
  ├─ Human/vehicle detection continues normally (not affected)
  └─ GET /api/capabilities → fireSmokeDetection: false, fireSmokeStatus: 'missing'
```

### 7.3 Per-Frame Detection with Fire

```
Camera JPEG Frame
  │
  ├─ (Human/vehicle detections run as normal)
  │
  ├─ FireSmokeService.ready === true
  │     └─ FireSmokeService.detect(jpegBuffer, origW, origH)
  │           ├─ Letterbox → CHW Float32 [1,3,640,640]
  │           ├─ _session.run({ images: tensor })
  │           ├─ _postprocess([1,7,8400]):
  │           │     ├─ anchor score ≥ 0.35, classIdx=0 (fire) → keep
  │           │     ├─ anchor score ≥ 0.35, classIdx=1 (default) → SKIP
  │           │     ├─ coord transform to original frame
  │           │     └─ NMS (threshold 0.45)
  │           └─ [{ className:'fire', confidence:0.87, bbox:{...} }]
  │
  ├─ PipelineManager merges fire into allDetections
  └─ io.emit('detections', { ..., detections: [...persons, ...vehicles, ...fire] })
```

---

## 8. Configuration & Environment

### 8.1 Model Path

```javascript
// fireSmokeService.js constructor default
const modelsDir = path.resolve(__dirname, '..', '..', 'models');
this.modelPath  = options.modelPath || path.join(modelsDir, 'yolov8s_fire_smoke.onnx');
```

### 8.2 Detection Thresholds

```javascript
const CONF_THRESHOLD = 0.35;   // Lower than human detection (0.45) for better recall
const NMS_THRESHOLD  = 0.45;   // Lower than human NMS (0.5) to suppress overlapping boxes
```

### 8.3 Model Export Command

```bash
python3 -c "
  from ultralytics import YOLO
  from huggingface_hub import hf_hub_download
  import shutil
  pt = hf_hub_download('keremberke/yolov8m-fire-and-smoke-detection', 'best.pt')
  YOLO(pt).export(format='onnx', imgsz=640, simplify=True)
  shutil.copy(pt.replace('.pt','.onnx'), 'server/models/yolov8s_fire_smoke.onnx')
"
```

### 8.4 ONNX Session Options

```javascript
// Shared getOnnxSessionOptions() from utils/onnxOptions.js
{
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
}
```

---

## 9. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| Model file missing at startup | `load()` existsSync check | `_status = 'missing'`; log; return (no throw); `fireSmokeDetection: false` in capabilities |
| ONNX session creation fails | `load()` try/catch | `_status = 'failed'`; warn log; `_ready = false` |
| `detect()` called when not ready | Guard: `if (!this._ready) return []` | Empty array; main pipeline unaffected |
| Inference `_session.run()` throws | `detect()` try/catch | Log `[FireSmokeService] Detection error: ...`; return `[]` |
| 'default' class detected | `SKIP_CLASSES.has(rawName)` filter | Suppressed before output regardless of confidence |
| Case mismatch in class name | `NORMALISE` map | `Fire` → `'fire'`, ensures lowercase output |
| fire/smoke service missing at runtime | PipelineManager guard | Human/vehicle detections continue normally; fire/smoke simply absent |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Fire Smoke Detection |
