# DESIGN DOCUMENT
# AI Module — Mask Detection

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-MSK-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Mask_Detection.md |

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
│      └─ Mask Detection toggle (PUT /api/analytics/config)        │
│  FullscreenCameraView.tsx / CameraView.tsx                        │
│      └─ Canvas overlay: MASK OK (green) / NO MASK (red) / MASK?  │
│      └─ Detection panel: mask badge per person row               │
│  App.tsx ────── window.__ltsSocket                                │
│      └─ on('detections')      — person objects with .mask attr   │
│      └─ on('mask_violation')  — compliance alert payload         │
└─────────────────────────┬────────────────────────────────────────┘
                          │ HTTP / WebSocket
┌─────────────────────────▼────────────────────────────────────────┐
│                    SERVER (Express + Socket.IO)                    │
│                                                                    │
│  index.js                                                          │
│   ├─ GET/PUT /api/analytics/config → analyticsConfig (mask key)  │
│   └─ GET /api/capabilities → { ai.mask, status.mask }            │
│                                                                    │
│  services/attributePipeline.js                                     │
│   ├─ this._ppe = new ProtectiveEquipService()                     │
│   └─ enrich(detections, jpegBuffer, frameW, frameH, config)       │
│        ├─ if config.mask → run mask pipeline                      │
│        └─ extractHeadRoi() → _bestMatch() → attach det.mask       │
│                                                                    │
│  services/protectiveEquipService.js                                │
│   ├─ detect(jpegBuffer, origW, origH) — PPE YOLOv8m inference    │
│   └─ returns [{bbox, confidence, classId, className}]             │
│       classId 1 = mask, classId 3 = no_mask                      │
│                                                                    │
│  services/pipelineManager.js                                       │
│   └─ zone compliance check → emit 'mask_violation'               │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── protectiveEquipService.js  # ProtectiveEquipService (PPE YOLOv8m, shared)
│   │   │   ├── attributePipeline.js       # Mask enrichment block + zone compliance
│   │   │   ├── analyticsConfig.js         # mask key in DEFAULT_CONFIG
│   │   │   └── pipelineManager.js         # emit 'mask_violation' alert
│   │   └── index.js                       # Express app; capabilities (mask: true)
│   ├── models/
│   │   └── yolov8m_ppe.onnx               # PPE model (shared with hat detection)
│   └── storage/
│       └── analytics.json                 # { mask: false }
│
├── client/
│   └── src/
│       ├── components/
│       │   ├── VideoAnalyticsTab.tsx       # Mask toggle
│       │   ├── FullscreenCameraView.tsx    # MASK OK / NO MASK / MASK? badges
│       │   └── CameraView.tsx             # Canvas overlay mask badges
│       ├── types/
│       │   └── index.ts                   # MaskAttribute, MaskViolationEvent types
│       └── i18n/translations/             # 15 language files — mask badge keys
│
├── docs/
│   ├── prd/PRD_AI_Mask_Detection.md
│   ├── rfp/RFP_AI_Mask_Detection.md
│   ├── srs/SRS_AI_Mask_Detection.md
│   ├── design/Design_AI_Mask_Detection.md  ← this file
│   └── tc/TC_AI_Mask_Detection.md
│
└── test/
    └── api/
        └── mask_detection.test.js
```

---

## 3. Server-Side Design

### 3.1 ProtectiveEquipService (`server/src/services/protectiveEquipService.js`)

The `ProtectiveEquipService` is fully shared between hat (AI-07) and mask (AI-04) detection. It provides a single `detect()` call returning all PPE class detections; the attribute pipeline filters by classId for each module.

**PPE class constants (mask-relevant):**
```javascript
const PPE_CLASSES = {
  1: 'mask',      // → mask.status = 'mask_correct'
  3: 'no_mask',   // → mask.status = 'no_mask'
  // (other PPE classes used by hat module)
};
```

**Key methods:**

| Method | Input | Output | Notes |
|---|---|---|---|
| `load()` | — | `Promise<void>` | Creates ONNX session; sets `_ready = true` on success |
| `detect(buf, origW, origH)` | JPEG Buffer, frame dims | `Array<{bbox, confidence, classId, className}>` | Full-frame PPE inference, letterbox preprocess, NMS |
| `get ready()` | — | `boolean` | True only when model loaded successfully |
| `get status()` | — | `string` | `'not_started'|'missing'|'loaded'|'failed'` |

### 3.2 AttributePipeline — Mask Enrichment Block

```javascript
// In attributePipeline.enrich() — mask block
if (config.mask !== false && this._ppe.ready) {
  // ppeDetections may already be available from hat block (shared call)
  if (!ppeDetections) {
    ppeDetections = await this._ppe.detect(jpegBuffer, frameW, frameH);
  }

  // Filter to mask-relevant PPE classes
  const maskPpe = ppeDetections.filter(p => p.classId === 1 || p.classId === 3);

  for (const det of detections.filter(d => d.className === 'person')) {
    const headRoi = extractMaskHeadRoi(det.bbox);
    const clamped = clampRoi(headRoi, frameW, frameH);

    // Skip if head too small for reliable classification
    if (clamped.width < 30 || clamped.height < 30) {
      det.mask = { status: 'uncertain', confidence: 0 };
      continue;
    }

    const best = _bestMatch(maskPpe, clamped);
    if (best === null) {
      det.mask = { status: 'uncertain', confidence: 0 };
    } else if (best.classId === 1) {
      det.mask = { status: 'mask_correct', confidence: best.confidence };
    } else {
      det.mask = { status: 'no_mask',      confidence: best.confidence };
    }
  }
}
// If mask module off or model not ready: det.mask remains undefined
```

### 3.3 Head ROI Extraction (Mask)

```javascript
// Mask head ROI formula — slightly different from hat ROI
function extractMaskHeadRoi(personBbox) {
  return {
    x:      personBbox.x + personBbox.width  * 0.15,
    y:      personBbox.y,
    width:  personBbox.width  * 0.70,
    height: personBbox.height * 0.35,
  };
}
```

The mask ROI starts at the person's y-coordinate (no hat-above-head margin needed) and uses a slightly wider inset (0.15 vs 0.10 for hat) to center on the face area.

### 3.4 Zone Compliance Check

```javascript
// In pipelineManager._processFrame(), after attribute enrichment
function isMaskCompliant(maskStatus, zonePolicy) {
  if (zonePolicy === 'mandatory')   return maskStatus === 'mask_correct';
  if (zonePolicy === 'recommended') return maskStatus !== 'no_mask';
  return true;   // 'none' policy
}

for (const det of enriched) {
  if (det.className !== 'person' || !det.mask) continue;
  const zone = zoneManager.matchZone(det.bbox);
  if (!zone || !zone.targetClasses.includes('mask')) continue;
  if (det.mask.status === 'uncertain') continue;   // never alert on uncertain

  const policy = zone.maskPolicy || 'none';
  if (!isMaskCompliant(det.mask.status, policy)) {
    socket.emit('mask_violation', {
      type:           'mask_violation',
      cameraId,
      objectId:       det.id,
      zoneId:         zone.id,
      maskStatus:     det.mask.status,
      maskConfidence: det.mask.confidence,
      dwellTime:      det.dwellTime,
      timestamp:      Date.now(),
    });
  }
}
```

---

## 4. Client-Side Design

### 4.1 MaskAttribute TypeScript Interface

```typescript
export interface MaskAttribute {
  status:     'mask_correct' | 'no_mask' | 'uncertain';
  confidence: number;
}

export interface MaskViolationEvent {
  type:           'mask_violation';
  cameraId:       string;
  objectId:       string;
  zoneId:         string;
  maskStatus:     'no_mask';
  maskConfidence: number;
  dwellTime:      number;
  timestamp:      number;
}

// On person detection object:
export interface Detection {
  // ... other fields ...
  mask?: MaskAttribute;   // undefined when module disabled / model not loaded
}
```

### 4.2 Mask Badge Rendering

```typescript
function renderMaskBadge(mask?: MaskAttribute) {
  if (!mask) return null;  // module off
  if (mask.status === 'mask_correct') return <Badge color="green">MASK OK</Badge>;
  if (mask.status === 'no_mask')      return <Badge color="red">NO MASK</Badge>;
  return <Badge color="gray">MASK?</Badge>;  // uncertain
}
```

### 4.3 Mask Violation Alert Panel

```
┌────────────────────────────────────────────────────────────────┐
│  🚫 MASK VIOLATION — Person #x7a9  [Zone: Hospital Entrance]  │
│  Status: NO MASK  |  Confidence: 96%  |  Dwell: 8.3s          │
└────────────────────────────────────────────────────────────────┘
```

### 4.4 Canvas Overlay Badge

```
Person bbox
  ┌──────────────────────────┐
  │                          │
  │     (person content)     │
  │                          │
  └──────────────────────────┘
  ┌───────────┐
  │ NO MASK   │  ← red badge above bbox
  └───────────┘
```

---

## 5. Data Model

### 5.1 analytics.json (mask key)

```json
{
  "mask": false
}
```

### 5.2 Zone Configuration Extension

```json
{
  "id":            "entrance-zone-uuid",
  "name":          "Hospital Entrance",
  "type":          "MONITOR",
  "targetClasses": ["human", "mask"],
  "maskPolicy":    "mandatory",
  "dwellThreshold": 5
}
```

### 5.3 Capabilities Response

```json
{
  "ai":     { "mask": true },
  "status": { "mask": "loaded" }
}
```

---

## 6. API Design

### 6.1 Mask Toggle

```
GET  /api/analytics/config
  → 200: { success: true, data: { mask: false, ... } }

PUT  /api/analytics/config
  Body: { "mask": true }
  → 200: { success: true, data: { mask: true, ... } }
```

### 6.2 Capabilities

```
GET  /api/capabilities
  → 200: {
      "ai":     { "mask": true },
      "status": { "mask": "loaded" | "available" | "missing" | "failed" }
    }
```

---

## 7. Sequence Diagrams

### 7.1 Per-Frame Mask Detection

```
Camera Frame    DetectionService    AttributePipeline    ProtectiveEquipService    Socket.IO
     │                │                   │                       │                   │
     │──JPEG buf──────>│                  │                       │                   │
     │                │──detect()         │                       │                   │
     │                │<──person bboxes── │                       │                   │
     │                │                  │──if config.mask        │                   │
     │                │                  │──ppe.detect(buf)───────────────────────>  │
     │                │                  │<──{mask/no_mask dets}─────────────────    │
     │                │                  │──For each person:                         │
     │                │                  │   extractMaskHeadRoi()                    │
     │                │                  │   size check (≥30×30)                     │
     │                │                  │   _bestMatch(maskPpe, headRoi)            │
     │                │                  │   det.mask = { status, confidence }       │
     │                │                  │──zone compliance check                    │
     │                │                  │──emit 'detections'─────────────────────>  │
     │                │                  │──emit 'mask_violation' (if any)──────────>│
```

### 7.2 Zone Compliance — Mandatory Policy

```
PipelineManager                  ZoneManager              Socket.IO
     │                                │                       │
     │  det.mask.status = 'no_mask'  │                       │
     │──matchZone(det.bbox)──────────>│                       │
     │<── zone { maskPolicy:'mandatory' }─────────────────   │
     │  isMaskCompliant('no_mask','mandatory') → false        │
     │──emit 'mask_violation' { ... }─────────────────────>   │
```

---

## 8. Configuration & Environment

### 8.1 ProtectiveEquipService Defaults

```javascript
{
  modelPath:  path.resolve(__dirname, '..', '..', 'models', 'yolov8m_ppe.onnx'),
  confThresh: 0.30,
  nmsThresh:  0.5,
}
```

### 8.2 Mask Head ROI Parameters

```javascript
const MASK_HEAD_ROI_X_INSET      = 0.15;   // 15% inset from left of person bbox
const MASK_HEAD_ROI_WIDTH_RATIO  = 0.70;   // 70% of person bbox width
const MASK_HEAD_ROI_HEIGHT_RATIO = 0.35;   // 35% of person bbox height (face region)
const MIN_HEAD_SIZE_PX           = 30;     // minimum ROI dimension for classification
const BEST_MATCH_IOU_THRESHOLD   = 0.1;    // minimum IoU for mask-to-head match
```

### 8.3 Zone Policy Constants

```javascript
const MASK_POLICIES = {
  mandatory:   'mandatory',   // only mask_correct is compliant
  recommended: 'recommended', // mask_correct or uncertain is compliant
  none:        'none',        // monitoring only, no alerts
};
```

---

## 9. Error Handling

| Scenario | Handler | Response |
|---|---|---|
| `yolov8m_ppe.onnx` missing | `ProtectiveEquipService.load()` | `_status = 'missing'`; all `mask` fields remain `undefined` |
| PPE model load fails (OOM, corrupt) | `load()` catch block | `_status = 'failed'`; `capabilities.status.mask = 'failed'` |
| PPE `detect()` throws | `attributePipeline.enrich()` catch | `mask = { status: 'uncertain', confidence: 0 }` for all persons |
| Head ROI too small (< 30×30) | `enrich()` size check | `mask = { status: 'uncertain', confidence: 0 }` |
| `uncertain` status in mandatory zone | `isMaskCompliant()` check | No `mask_violation` emitted |
| Zone without `maskPolicy` | Default `'none'` applied | No alerts for mask status |
| Config `mask: true` but model not ready | `needsPpe` gate check | PPE call skipped; `mask = undefined` |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Mask Detection |
