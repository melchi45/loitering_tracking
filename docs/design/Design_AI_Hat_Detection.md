# DESIGN DOCUMENT
# AI Module — Hat & Helmet Detection

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-HAT-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Hat_Detection.md |

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
┌──────────────────────────────────────────────────────────────────┐
│                          CLIENT (React)                           │
│  VideoAnalyticsTab.tsx                                            │
│      └─ Hat Detection toggle (PUT /api/analytics/config)         │
│  FullscreenCameraView.tsx / CameraView.tsx                        │
│      └─ Canvas overlay badge: HELMET (blue) / NO HELMET (red)    │
│      └─ Detection panel: hat badge per person row                 │
│  App.tsx ────── window.__ltsSocket                                │
│      └─ on('detections') — person objects with .hat attribute     │
└─────────────────────────┬────────────────────────────────────────┘
                          │ HTTP / WebSocket
┌─────────────────────────▼────────────────────────────────────────┐
│                    SERVER (Express + Socket.IO)                    │
│                                                                    │
│  index.js                                                          │
│   ├─ GET/PUT /api/analytics/config → analyticsConfig (hat key)   │
│   └─ GET /api/capabilities → { ai.hat, status.hat }              │
│                                                                    │
│  services/attributePipeline.js                                     │
│   ├─ this._ppe = new ProtectiveEquipService()                     │
│   ├─ load() → _ppe.load()                                         │
│   └─ enrich(detections, jpegBuffer, frameW, frameH, config)       │
│        ├─ if config.hat → run hat pipeline                        │
│        └─ extractHeadRoi() → _bestMatch() → attach det.hat        │
│                                                                    │
│  services/protectiveEquipService.js                                │
│   ├─ detect(jpegBuffer, origW, origH)  — PPE YOLOv8m inference   │
│   └─ returns [{bbox, confidence, classId, className}]             │
│       classId 0 = hardhat, classId 2 = no_hardhat                │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── protectiveEquipService.js  # ProtectiveEquipService (PPE YOLOv8m)
│   │   │   ├── attributePipeline.js       # Compose PPE, face, color attr enrichment
│   │   │   ├── analyticsConfig.js         # hat key in DEFAULT_CONFIG
│   │   │   └── pipelineManager.js         # loads AttributePipeline; emits detections
│   │   └── index.js                       # Express app; capabilities (hat: true)
│   ├── models/
│   │   └── yolov8m_ppe.onnx               # PPE model (shared with mask detection)
│   └── storage/
│       └── analytics.json                 # { hat: false }
│
├── client/
│   └── src/
│       ├── components/
│       │   ├── VideoAnalyticsTab.tsx       # Hat toggle
│       │   ├── FullscreenCameraView.tsx    # HELMET / NO HELMET / HAT? badges
│       │   └── CameraView.tsx             # Canvas overlay hat badges
│       ├── types/
│       │   └── index.ts                   # HatAttribute interface
│       └── i18n/translations/             # 15 language files — hat/helmet keys
│
├── docs/
│   ├── prd/PRD_AI_Hat_Detection.md
│   ├── rfp/RFP_AI_Hat_Detection.md
│   ├── srs/SRS_AI_Hat_Detection.md
│   ├── design/Design_AI_Hat_Detection.md  ← this file
│   └── tc/TC_AI_Hat_Detection.md
│
└── test/
    └── api/
        └── hat_detection.test.js
```

---

## 3. Server-Side Design

### 3.1 ProtectiveEquipService (`server/src/services/protectiveEquipService.js`)

**Class overview:**

| Method / Property | Description |
|---|---|
| `constructor({ modelPath, confThresh, nmsThresh })` | Sets defaults: confThresh=0.30, nmsThresh=0.5 |
| `load()` | Creates ONNX InferenceSession; sets `_ready=true`, `_status='loaded'` |
| `detect(jpegBuffer, origW, origH)` | Full-frame PPE inference; returns all PPE class detections |
| `get ready()` | Returns `_ready` boolean |
| `get status()` | Returns `'not_started'|'missing'|'loaded'|'failed'` |

**PPE class constants:**
```javascript
const PPE_CLASSES = {
  0: 'hardhat',
  1: 'mask',
  2: 'no_hardhat',
  3: 'no_mask',
  4: 'no_safety_vest',
  5: 'ppe_person',
  6: 'safety_cone',
  7: 'safety_vest',
  8: 'machinery',
  9: 'ppe_vehicle',
};
```

**Preprocessing pipeline:**
1. Proportional resize with letterboxing to 640×640 (grey padding: R:114, G:114, B:114)
2. CHW Float32 tensor, normalized to [0, 1]
3. Tensor shape: `[1, 3, 640, 640]`
4. Feed into session; parse output `[1, 4+NC, 8400]`

**Postprocessing:**
1. Parse 8400 anchor boxes: extract cx, cy, bw, bh and NC class scores
2. Filter by `confThresh = 0.30`
3. Map back to original frame coordinates (remove letterbox padding, scale)
4. Apply NMS with `nmsThresh = 0.5`

**State machine:**
```
_status: 'not_started'
  → load() called:
    → model file missing: _status = 'missing'
    → session created OK: _status = 'loaded', _ready = true
    → load throws: _status = 'failed', _ready = false
```

### 3.2 AttributePipeline — Hat Enrichment Block

```javascript
// In attributePipeline.enrich(detections, jpegBuffer, frameW, frameH, config)
if (config.hat !== false && this._ppe.ready) {
  const ppeDetections = await this._ppe.detect(jpegBuffer, frameW, frameH);

  for (const det of detections.filter(d => d.className === 'person')) {
    const headRoi = extractHeadRoi(det.bbox);
    const clampedRoi = clampRoi(headRoi, frameW, frameH);

    // Filter PPE detections to hat-relevant classes (0=hardhat, 2=no_hardhat)
    const hatPpe = ppeDetections.filter(p => p.classId === 0 || p.classId === 2);
    const best  = _bestMatch(hatPpe, clampedRoi);

    if (best === null) {
      det.hat = { className: 'uncertain', confidence: 0, isHelmet: null, safetyCompliant: null };
    } else if (best.classId === 0) {
      det.hat = { className: 'hardhat',    confidence: best.confidence, isHelmet: true,  safetyCompliant: true  };
    } else {
      det.hat = { className: 'no_hardhat', confidence: best.confidence, isHelmet: false, safetyCompliant: false };
    }
  }
}
// If hat module off or model not ready: det.hat remains undefined
```

### 3.3 Head ROI Extraction

```javascript
function extractHeadRoi(personBbox) {
  const headHeight = personBbox.height * 0.28;
  return {
    x:      personBbox.x + personBbox.width  * 0.10,
    y:      personBbox.y - headHeight * 0.10,   // include area above head for tall hats
    width:  personBbox.width  * 0.80,
    height: headHeight * 1.20,
  };
}

function clampRoi(roi, frameW, frameH) {
  const x = Math.max(0, roi.x);
  const y = Math.max(0, roi.y);
  return {
    x, y,
    width:  Math.min(frameW - x, roi.width),
    height: Math.min(frameH - y, roi.height),
  };
}
```

### 3.4 IoU Best-Match Helper

```javascript
function _bestMatch(ppeDetections, headRoi, threshold = 0.1) {
  let best = null;
  let bestIou = threshold;
  for (const p of ppeDetections) {
    const iou = computeIoU(p.bbox, headRoi);
    if (iou > bestIou) {
      bestIou = iou;
      best = p;
    }
  }
  return best;  // null if no match above threshold
}
```

### 3.5 Shared PPE Inference (Hat + Mask)

```javascript
// In attributePipeline.enrich() — single PPE call serves both modules
let ppeDetections = null;
const needsPpe = (config.hat !== false || config.mask !== false) && this._ppe.ready;

if (needsPpe) {
  ppeDetections = await this._ppe.detect(jpegBuffer, frameW, frameH);

  if (config.hat !== false) {
    // process hat enrichment using ppeDetections (classId 0, 2)
  }
  if (config.mask !== false) {
    // process mask enrichment using ppeDetections (classId 1, 3)
  }
}
```

---

## 4. Client-Side Design

### 4.1 HatAttribute TypeScript Interface

```typescript
export interface HatAttribute {
  className:       'hardhat' | 'no_hardhat' | 'uncertain';
  confidence:      number;
  isHelmet:        boolean | null;
  safetyCompliant: boolean | null;
}

// On person detection object:
export interface Detection {
  // ... other fields ...
  hat?: HatAttribute;  // undefined when module disabled / model not loaded
}
```

### 4.2 Hat Badge Rendering Logic

```typescript
// In DetectionRow component
function renderHatBadge(hat?: HatAttribute) {
  if (!hat) return null;  // module off
  if (hat.isHelmet === true)  return <Badge color="blue">HELMET</Badge>;
  if (hat.isHelmet === false) return <Badge color="red">NO HELMET</Badge>;
  return <Badge color="gray">HAT?</Badge>;   // uncertain
}
```

### 4.3 Canvas Overlay Badge

In `CameraView.tsx`, hat badges are rendered above each person bounding box:
```
Person bbox
  ┌──────────────────────────┐
  │                          │
  │     (person content)     │
  │                          │
  └──────────────────────────┘
  ┌──────────┐
  │ HELMET   │  ← blue badge above bbox
  └──────────┘
```

---

## 5. Data Model

### 5.1 analytics.json (hat key)

```json
{
  "hat": false
}
```

### 5.2 Capabilities Response

```json
{
  "ai":     { "hat": true },
  "status": { "hat": "loaded" }
}
```

---

## 6. API Design

### 6.1 Hat Toggle

```
GET  /api/analytics/config
  → 200: { success: true, data: { hat: false, ... } }

PUT  /api/analytics/config
  Body: { "hat": true }
  → 200: { success: true, data: { hat: true, ... } }
```

### 6.2 Capabilities

```
GET  /api/capabilities
  → 200: {
      "ai":     { "hat": true },
      "status": { "hat": "loaded" | "available" | "missing" | "failed" }
    }
```

---

## 7. Sequence Diagrams

### 7.1 Per-Frame Hat Detection

```
Camera Frame    DetectionService    AttributePipeline    ProtectiveEquipService    Socket.IO
     │                │                   │                       │                   │
     │──JPEG buf──────>│                  │                       │                   │
     │                │──detect()         │                       │                   │
     │                │<──person bboxes── │                       │                   │
     │                │                  │──if config.hat         │                   │
     │                │                  │──ppe.detect(buf)───────────────────────>  │
     │                │                  │<────{hardhat/no_hardhat dets}─────────    │
     │                │                  │──For each person:                         │
     │                │                  │   extractHeadRoi()                        │
     │                │                  │   _bestMatch(hatPpe, headRoi)             │
     │                │                  │   det.hat = { isHelmet, ... }             │
     │                │                  │──emit 'detections'─────────────────────>  │
```

### 7.2 Shared Hat + Mask PPE Inference

```
AttributePipeline           ProtectiveEquipService
     │                              │
     │  config.hat=true             │
     │  config.mask=true            │
     │──ppe.detect(buf) once ──────>│
     │<── ppeDetections[] ──────────│
     │                              │
     │  // hat block (classId 0, 2)
     │  hatPpe = ppeDetections.filter(p => p.classId === 0 || p.classId === 2)
     │  // mask block (classId 1, 3)
     │  maskPpe = ppeDetections.filter(p => p.classId === 1 || p.classId === 3)
     │  // single inference, two results
```

---

## 8. Configuration & Environment

### 8.1 ProtectiveEquipService Constructor Defaults

```javascript
{
  modelPath:  path.resolve(__dirname, '..', '..', 'models', 'yolov8m_ppe.onnx'),
  confThresh: 0.30,   // minimum PPE detection confidence
  nmsThresh:  0.5,    // NMS IoU threshold
}
```

### 8.2 Head ROI Parameters

```javascript
const HEAD_ROI_HEIGHT_RATIO    = 0.28;   // head height = 28% of person bbox height
const HEAD_ROI_X_INSET_RATIO   = 0.10;   // 10% inset from left
const HEAD_ROI_WIDTH_RATIO     = 0.80;   // 80% of person bbox width
const HEAD_ROI_ABOVE_MARGIN    = 0.10;   // extend 10% above head top
const HEAD_ROI_HEIGHT_MARGIN   = 1.20;   // scale head height up 20% for tall hats
const BEST_MATCH_IOU_THRESHOLD = 0.1;    // minimum IoU for hat-to-head match
```

---

## 9. Error Handling

| Scenario | Handler | Response |
|---|---|---|
| `yolov8m_ppe.onnx` missing | `ProtectiveEquipService.load()` | `_status = 'missing'`; all `hat` fields remain `undefined` |
| PPE model load fails (OOM, corrupt) | `load()` catch block | `_status = 'failed'`; `capabilities.status.hat = 'failed'` |
| PPE `detect()` throws | `attributePipeline.enrich()` catch | `hat = { isHelmet: null, className: 'uncertain', confidence: 0 }` |
| Head ROI zero area after clamping | `clampRoi()` check | `hat = uncertain` |
| Person bbox outside frame | `clampRoi()` | Coordinates clamped; detection proceeds |
| Config `hat: true` but model not ready | `needsPpe` gate check | PPE call skipped; `hat = undefined` |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Hat Detection |
