# DESIGN DOCUMENT
# AI Module — Animal Detection

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-ANI-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Animal_Detection.md |

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
┌───────────────────────────────────────────────────────────────────┐
│                           CLIENT (React)                           │
│  VideoAnalyticsTab.tsx                                             │
│      └─ zoneGroupAnimals: 10 per-species checkboxes               │
│         PUT /api/analytics/config → { dog: true, cat: true, ... } │
│  DashboardDetectionPanel.tsx                                       │
│      └─ CATEGORIES filter: Animals group                          │
│  FullscreenCameraView.tsx                                          │
│      └─ DetectionRow — species color code + loitering badge       │
│  App.tsx ──── window.__ltsSocket                                   │
│      └─ on('detections')      — animal rows per camera            │
│      └─ on('loitering:alert') — animal loitering notification     │
└──────────────────────────┬────────────────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────▼────────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)                    │
│                                                                     │
│  index.js                                                           │
│   ├─ GET/PUT /api/analytics/config → analyticsConfig.js            │
│   └─ GET /api/capabilities         → { ai: { animalDetection } }   │
│                                                                     │
│  services/pipelineManager.js                                        │
│   ├─ DetectionService.detect()    — COCO classes 14-23             │
│   ├─ analyticsConfig.isClassEnabled(species) — per-species gate    │
│   ├─ ByteTracker.update()         — dwell-time tracking            │
│   ├─ BehaviorAnalyzer.update()    — isLoitering flag               │
│   └─ emit 'detections' / 'loitering:alert'                        │
│                                                                     │
│  services/detection.js                                              │
│   └─ ENABLED_CLASSES: { 14:'bird', 15:'cat', ..., 23:'giraffe' }  │
│                                                                     │
│  services/analyticsConfig.js                                        │
│   └─ DEFAULT_CONFIG: all 10 species keys default to false          │
└───────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── detection.js         # ENABLED_CLASSES: 14-23 (bird→giraffe)
│   │   │   ├── analyticsConfig.js   # 10 species keys in DEFAULT_CONFIG
│   │   │   ├── behaviorEngine.js    # TARGET_CLASS_MAP: per-species keys
│   │   │   ├── tracking.js          # ByteTracker — animal tracks same as persons
│   │   │   └── pipelineManager.js   # isClassEnabled gate, zone matching, loitering
│   │   └── index.js                 # Express app; capabilities endpoint
│   ├── models/
│   │   └── yolov8n.onnx             # Shared COCO model (animal classes 14-23 included)
│   └── storage/
│       └── analytics.json           # Persisted per-species enable state
│
├── client/
│   └── src/
│       ├── components/
│       │   ├── VideoAnalyticsTab.tsx        # Animals group (10 checkboxes)
│       │   ├── FullscreenCameraView.tsx     # Species color codes, loitering badge
│       │   └── DashboardDetectionPanel.tsx  # CATEGORIES includes Animals filter
│       ├── types/
│       │   └── index.ts                     # AnimalDetection type
│       └── i18n/translations/               # 15 language files — animal species keys
│
├── docs/
│   ├── prd/PRD_AI_Animal_Detection.md
│   ├── rfp/RFP_AI_Animal_Detection.md
│   ├── srs/SRS_AI_Animal_Detection.md
│   ├── design/Design_AI_Animal_Detection.md  ← this file
│   └── tc/TC_AI_Animal_Detection.md
│
└── test/
    └── api/
        └── animal_detection.test.js
```

---

## 3. Server-Side Design

### 3.1 DetectionService (`server/src/services/detection.js`)

No changes to the inference engine are required. Animal classes 14–23 are already part of `ENABLED_CLASSES`:

```javascript
const ENABLED_CLASSES = {
  // ... persons, vehicles, accessories ...
  14: 'bird',
  15: 'cat',
  16: 'dog',
  17: 'horse',
  18: 'sheep',
  19: 'cow',
  20: 'elephant',
  21: 'bear',
  22: 'zebra',
  23: 'giraffe',
  // ...
};
```

Animal detections use the standard detection schema:
```javascript
{
  bbox:       { x, y, width, height },
  confidence: number,     // ≥ 0.25 threshold
  classId:    14-23,
  className:  'bird' | 'cat' | 'dog' | 'horse' | 'sheep' |
              'cow' | 'elephant' | 'bear' | 'zebra' | 'giraffe'
}
```

### 3.2 AnalyticsConfig (`server/src/services/analyticsConfig.js`)

**DEFAULT_CONFIG additions:**
```javascript
const DEFAULT_CONFIG = {
  // ... other keys ...
  bird:      false,
  cat:       false,
  dog:       false,
  horse:     false,
  sheep:     false,
  cow:       false,
  elephant:  false,
  bear:      false,
  zebra:     false,
  giraffe:   false,
};
```

**MODULE_CLASSES map (animals):**
```javascript
const MODULE_CLASSES = {
  // ... other entries ...
  bird:      ['bird'],
  cat:       ['cat'],
  dog:       ['dog'],
  horse:     ['horse'],
  sheep:     ['sheep'],
  cow:       ['cow'],
  elephant:  ['elephant'],
  bear:      ['bear'],
  zebra:     ['zebra'],
  giraffe:   ['giraffe'],
};
```

### 3.3 BehaviorEngine (`server/src/services/behaviorEngine.js`)

**TARGET_CLASS_MAP (animal keys):**
```javascript
const TARGET_CLASS_MAP = {
  human:    ['person'],
  vehicle:  ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  accessories: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase'],
  // Animal keys — each maps to a single species
  bird:     ['bird'],
  cat:      ['cat'],
  dog:      ['dog'],
  horse:    ['horse'],
  sheep:    ['sheep'],
  cow:      ['cow'],
  elephant: ['elephant'],
  bear:     ['bear'],
  zebra:    ['zebra'],
  giraffe:  ['giraffe'],
};
```

A zone with `targetClasses: ["dog", "cat"]` must match both `dog` and `cat` entries from this map.

### 3.4 PipelineManager — Animal Gating

```javascript
// In _processFrame()
const allDetections = await detectionService.detect(jpegBuffer, frameW, frameH);

// Class-level gating — animals included
const enabled = allDetections.detections.filter(d =>
  analyticsConfig.isClassEnabled(d.className)
);

// Animals flow through the same ByteTracker + BehaviorAnalyzer path
const tracked = byteTracker.update(enabled);
const analyzed = behaviorAnalyzer.update(tracked, zones, timestamp);

// Emit enriched detections (animals included in the array)
socket.emit('detections', { cameraId, detections: analyzed });

// Loitering alerts for animals
for (const det of analyzed) {
  if (det.isLoitering && det.wasLoiteringLastFrame === false) {
    socket.emit('loitering:alert', {
      cameraId, objectId: det.id, className: det.className,
      zone: det.zoneName, dwellTime: det.dwellTime
    });
  }
}
```

---

## 4. Client-Side Design

### 4.1 VideoAnalyticsTab — Animals Group

```
Animals  (i18n key: zoneGroupAnimals)
├─ [☐] Bird       ├─ [☐] Cat
├─ [☐] Dog        ├─ [☐] Horse
├─ [☐] Sheep      ├─ [☐] Cow
├─ [☐] Elephant   ├─ [☐] Bear
├─ [☐] Zebra      └─ [☐] Giraffe
```

Each checkbox calls `PUT /api/analytics/config` with `{ [species]: boolean }`.

### 4.2 Species Color Codes (DetectionRow)

```typescript
const ANIMAL_COLORS: Record<string, string> = {
  bird:     'text-pink-200',
  cat:      'text-rose-300',
  dog:      'text-rose-400',
  horse:    'text-orange-800',
  sheep:    'text-gray-100',
  cow:      'text-amber-900',
  elephant: 'text-gray-500',
  bear:     'text-amber-800',
  zebra:    'text-gray-100',
  giraffe:  'text-amber-600',
};
```

### 4.3 Detection Row Example

```
┌─────────────────────────────────────────────────────────────┐
│ dog  #b7c2  conf 87%  dwell 8.3s        │ text-rose-400     │
│      zone "Server Room"                 │                   │
├─────────────────────────────────────────────────────────────┤
│ [LOITER] dog  #b7c2  conf 87%  dwell 32s│ bg-red-900/20     │
└─────────────────────────────────────────────────────────────┘
```

### 4.4 TypeScript Types

```typescript
// Reuses existing Detection interface; className carries species name
export interface Detection {
  id:          string;
  className:   string;   // 'dog' | 'cat' | etc.
  confidence:  number;
  bbox:        BBox;
  dwellTime:   number;
  isLoitering: boolean;
  zoneId:      string | null;
  cameraId:    string;
}
```

---

## 5. Data Model

### 5.1 analytics.json (animals portion)

```json
{
  "bird":     false,
  "cat":      false,
  "dog":      false,
  "horse":    false,
  "sheep":    false,
  "cow":      false,
  "elephant": false,
  "bear":     false,
  "zebra":    false,
  "giraffe":  false
}
```

### 5.2 ByteTracker Track Entry (animal)

Animal tracks use the same structure as person tracks; `className` carries the species:
```typescript
{
  id:            string;       // 'track-uuid'
  className:     string;       // e.g., 'dog'
  bbox:          BBox;
  confidence:    number;
  dwellTime:     number;       // seconds in current zone
  isLoitering:   boolean;
  zoneId:        string | null;
  lastSeenAt:    number;       // Unix ms
}
```

---

## 6. API Design

### 6.1 Analytics Config — Animal Keys

```
GET  /api/analytics/config
  → 200: { success: true, data: { bird: false, cat: false, dog: false, ... } }

PUT  /api/analytics/config
  Body: { "dog": true, "cat": true }
  → 200: { success: true, data: <updated config> }
```

### 6.2 Capabilities

```
GET  /api/capabilities
  → 200: {
      "ai": { "animalDetection": true },
      "status": { "animalDetection": "loaded" }
    }
```

`animalDetection` is `true` when `yolov8n.onnx` is loaded (animals require no separate model).

---

## 7. Sequence Diagrams

### 7.1 Animal Detection with Loitering Alert

```
Camera Frame    DetectionService    PipelineManager    ByteTracker    BehaviorAnalyzer    Socket.IO
     │                │                   │                │                 │                │
     │──JPEG buf──────>│                  │                │                 │                │
     │                │──detect()         │                │                 │                │
     │                │<──{animals+others}│                │                 │                │
     │                │                  │──isClassEnabled('dog') → true     │                │
     │                │                  │──filter disabled classes           │                │
     │                │                  │──byteTracker.update()──────────>  │                │
     │                │                  │<──{tracked objects}────────────   │                │
     │                │                  │──behaviorAnalyzer.update()────────────────────>   │
     │                │                  │<──{isLoitering: true for dog}──────────────────   │
     │                │                  │──emit 'detections'──────────────────────────────> │
     │                │                  │──emit 'loitering:alert' (dog)──────────────────>  │
```

### 7.2 Per-Species Toggle Update

```
Client                Server              analyticsConfig     analytics.json
  │                      │                     │                   │
  │── PUT /api/analytics/config ────────────>  │                   │
  │   { "dog": true }    │                     │                   │
  │                      │──config.update()────>│                  │
  │                      │                     │──write()──────────>│
  │<── 200 { data } ─────│                     │                   │
  │                      │                     │                   │
  │ (next frame)         │                     │                   │
  │                      │──isClassEnabled('dog') → true           │
```

---

## 8. Configuration & Environment

### 8.1 Animal Detection Thresholds

```javascript
// detection.js — shared confidence threshold
const CONFIDENCE_THRESHOLD = process.env.CONFIDENCE_THRESHOLD
  ? parseFloat(process.env.CONFIDENCE_THRESHOLD) : 0.25;

// ByteTracker — same parameters as person/vehicle tracking
const TRACKER_CONFIG = {
  iouThreshold: 0.3,
  minHits:      2,
  maxAge:       30,   // frames before track is removed
};
```

### 8.2 Zone Configuration Example

```json
{
  "name": "Server Room",
  "type": "MONITOR",
  "dwellThreshold": 10,
  "targetClasses": ["dog", "cat", "bird"]
}
```

---

## 9. Error Handling

| Scenario | Handler | Response |
|---|---|---|
| `yolov8n.onnx` missing | `DetectionService.load()` | `_session = null`; `animalDetection: false` in capabilities |
| ONNX inference throws | `detect()` catch block | Returns `{ detections: [] }`; animal tracking skipped for frame |
| Unknown species key in PUT config | `analyticsConfig.update()` | Key silently ignored; valid keys applied |
| Animal track TTL exceeded | ByteTracker prune | Track removed; dwell-time reset on re-entry |
| Zone without targetClasses | BehaviorEngine default | All enabled classes (including animals) match |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Animal Detection |
