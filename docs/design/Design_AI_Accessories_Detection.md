# DESIGN DOCUMENT
# AI Module — Accessories Detection

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-ACC-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Accessories_Detection.md |

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
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (React)                           │
│  VideoAnalyticsTab.tsx ── PUT /api/analytics/config             │
│      └─ Accessories group (5 checkboxes: backpack, umbrella,    │
│                             handbag, tie, suitcase)             │
│  FullscreenCameraView.tsx                                        │
│      └─ DetectionRow — amber color, 'accessories' category      │
│  App.tsx ──── window.__ltsSocket (Socket.IO client)             │
│      └─ on('detections')   — renders accessory rows             │
│      └─ on('abandoned_item') — renders abandoned item alert     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                    SERVER (Express + Socket.IO)                   │
│                                                                   │
│  index.js                                                         │
│   ├─ GET/PUT /api/analytics/config → analyticsConfig.js          │
│   └─ GET /api/capabilities         → PPE + COCO model status     │
│                                                                   │
│  services/pipelineManager.js                                      │
│   ├─ DetectionService.detect()     — COCO classes 24-28          │
│   ├─ analyticsConfig.isClassEnabled(className)  — per-item gate  │
│   ├─ associateAccessoryToPerson()  — IoU on expanded bbox ×1.3   │
│   ├─ AbandonedItemTracker.update() — state machine               │
│   └─ emit 'detections' + 'abandoned_item'                        │
│                                                                   │
│  services/detection.js                                            │
│   └─ ENABLED_CLASSES: { 24:'backpack', 25:'umbrella',            │
│                          26:'handbag', 27:'tie', 28:'suitcase' } │
│                                                                   │
│  services/analyticsConfig.js                                      │
│   └─ DEFAULT_CONFIG: { backpack:false, umbrella:false,           │
│                         handbag:false, tie:false, suitcase:false }│
│                                                                   │
│  services/behaviorEngine.js                                       │
│   └─ TARGET_CLASS_MAP: { accessories:[...], backpack:[...], ... } │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── detection.js            # YOLOv8n inference; ENABLED_CLASSES includes 24-28
│   │   │   ├── analyticsConfig.js      # Per-item keys: backpack, umbrella, handbag, tie, suitcase
│   │   │   ├── behaviorEngine.js       # TARGET_CLASS_MAP: accessories alias + individual keys
│   │   │   ├── pipelineManager.js      # associateAccessoryToPerson, AbandonedItemTracker
│   │   │   └── tracking.js             # ByteTracker — accessory tracks (zone dwell-time)
│   │   └── index.js                    # Express app; capabilities endpoint
│   ├── models/
│   │   └── yolov8n.onnx                # Shared COCO model (includes classes 24-28)
│   └── storage/
│       └── analytics.json              # Persisted per-item enable state
│
├── client/
│   └── src/
│       ├── components/
│       │   ├── VideoAnalyticsTab.tsx   # Accessories group with 5 per-item checkboxes
│       │   ├── FullscreenCameraView.tsx # Amber detection rows + abandoned item alerts
│       │   └── DashboardDetectionPanel.tsx # CATEGORIES filter includes accessories
│       ├── types/
│       │   └── index.ts                # AccessoryDetection, AbandonedItemEvent types
│       └── i18n/translations/          # 15 language files — accessory label keys
│
├── docs/
│   ├── prd/PRD_AI_Accessories_Detection.md
│   ├── rfp/RFP_AI_Accessories_Detection.md
│   ├── srs/SRS_AI_Accessories_Detection.md
│   ├── design/Design_AI_Accessories_Detection.md  ← this file
│   └── tc/TC_AI_Accessories_Detection.md
│
└── test/
    └── api/
        └── accessories_detection.test.js
```

---

## 3. Server-Side Design

### 3.1 DetectionService (`server/src/services/detection.js`)

Accessories require no changes to the inference path. The `ENABLED_CLASSES` map already includes COCO IDs 24–28.

**ENABLED_CLASSES map (accessories portion):**
```javascript
const ENABLED_CLASSES = {
  // ... persons, vehicles, animals ...
  24: 'backpack',
  25: 'umbrella',
  26: 'handbag',
  27: 'tie',
  28: 'suitcase',
  // ...
};
```

Detection objects for accessories use the same schema as all other COCO classes:
```javascript
{ bbox: {x, y, width, height}, confidence, classId: 24-28, className: 'backpack'|... }
```

### 3.2 AnalyticsConfig (`server/src/services/analyticsConfig.js`)

**DEFAULT_CONFIG additions (Phase-1):**
```javascript
const DEFAULT_CONFIG = {
  // ... other keys ...
  backpack:    false,
  umbrella:    false,
  handbag:     false,
  tie:         false,
  suitcase:    false,
  glasses:     false,  // Phase-2 UI placeholder (not in MODULE_CLASSES)
  sunglasses:  false,  // Phase-2 UI placeholder (not in MODULE_CLASSES)
};
```

**MODULE_CLASSES map:**
```javascript
const MODULE_CLASSES = {
  // ... other entries ...
  backpack:   ['backpack'],
  umbrella:   ['umbrella'],
  handbag:    ['handbag'],
  tie:        ['tie'],
  suitcase:   ['suitcase'],
  // glasses and sunglasses intentionally absent until Phase-2 model available
};
```

**`isClassEnabled(className)` logic:**
```javascript
isClassEnabled(className) {
  // Find the module key that maps to this className
  for (const [key, classes] of Object.entries(MODULE_CLASSES)) {
    if (classes.includes(className) && this._config[key] === true) return true;
  }
  return false;
}
```

### 3.3 BehaviorEngine (`server/src/services/behaviorEngine.js`)

**TARGET_CLASS_MAP additions:**
```javascript
const TARGET_CLASS_MAP = {
  human:       ['person'],
  vehicle:     ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  accessories: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase'], // backward-compat alias
  backpack:    ['backpack'],
  umbrella:    ['umbrella'],
  handbag:     ['handbag'],
  suitcase:    ['suitcase'],
  tie:         ['tie'],
  // animal keys ...
};
```

### 3.4 PipelineManager — Person-Accessory Association

**`associateAccessoryToPerson(accessoryBbox, personBboxes, threshold = 0.1)`:**

```javascript
function associateAccessoryToPerson(accessoryBbox, personBboxes, threshold = 0.1) {
  let bestPerson = null;
  let bestIou = threshold;
  for (const person of personBboxes) {
    const expanded = expandBbox(person.bbox, 1.3);
    const iou = computeIoU(accessoryBbox, expanded);
    if (iou > bestIou) {
      bestIou = iou;
      bestPerson = person;
    }
  }
  return bestPerson;  // null if no match above threshold
}

function expandBbox(bbox, scale) {
  const dw = bbox.width  * (scale - 1) / 2;
  const dh = bbox.height * (scale - 1) / 2;
  return { x: bbox.x - dw, y: bbox.y - dh, width: bbox.width * scale, height: bbox.height * scale };
}
```

**Per-frame accessory enrichment flow:**
```javascript
// In PipelineManager._processFrame()
const persons    = detections.filter(d => d.className === 'person');
const accessories = detections.filter(d => ['backpack','umbrella','handbag','tie','suitcase'].includes(d.className));

for (const accessory of accessories) {
  const owner = associateAccessoryToPerson(accessory.bbox, persons);
  if (owner) {
    owner.accessories = owner.accessories || [];
    owner.accessories.push({ type: accessory.className, confidence: accessory.confidence, bbox: accessory.bbox, color: null });
  } else {
    abandonedItemTracker.update(accessory, persons, Date.now(), cameraId, zoneId);
  }
}
```

### 3.5 AbandonedItemTracker

**State machine:**
```
DETECTED → UNATTENDED → ABANDONED → CLEARED
```

**Class structure:**
```javascript
class AbandonedItemTracker {
  // accessoryId → { bbox, firstSeenAloneAt, lastPositions: [], alertEmitted, priority }
  _state = new Map();

  update(accessory, persons, timestamp, cameraId, zoneId) {
    const id = this._getAccessoryId(accessory.bbox);
    const associated = associateAccessoryToPerson(accessory.bbox, persons);

    if (associated) {
      this._clearState(id);   // CLEARED
      return null;
    }

    const entry = this._getOrCreate(id, accessory, timestamp);
    entry.lastPositions.push({ x: accessory.bbox.x, y: accessory.bbox.y, t: timestamp });

    const elapsed = (timestamp - entry.firstSeenAloneAt) / 1000;
    const timeout = ABANDON_TIMEOUTS[this._getPriority(accessory.className)];
    const stable  = this._isPositionStable(entry.lastPositions);

    if (elapsed >= timeout && stable && !entry.alertEmitted) {
      entry.alertEmitted = true;
      return this._buildAlert(accessory, entry, cameraId, zoneId);  // → ABANDONED
    }
    return null;  // UNATTENDED
  }

  _isPositionStable(positions) {
    if (positions.length < 2) return true;
    const first = positions[0], last = positions[positions.length - 1];
    return Math.hypot(last.x - first.x, last.y - first.y) < 20;
  }

  _getPriority(className) {
    if (['suitcase', 'backpack'].includes(className)) return 'high';
    if (['handbag'].includes(className)) return 'medium';
    return 'low';  // umbrella, tie
  }
}

const ABANDON_TIMEOUTS = { high: 30, medium: 60, low: 120 };
```

---

## 4. Client-Side Design

### 4.1 VideoAnalyticsTab — Accessories Group

```
Accessories Group (i18n: zoneGroupAccessories)
├─ [☐] Backpack      (i18n: accessoryBackpack)
├─ [☐] Umbrella      (i18n: accessoryUmbrella)
├─ [☐] Handbag       (i18n: accessoryHandbag)
├─ [☐] Tie           (i18n: accessoryTie)
├─ [☐] Suitcase      (i18n: accessorySuitcase)
├─ [☐] Glasses   [Phase-2 — pending]
└─ [☐] Sunglasses [Phase-2 — pending]
```

Phase-2 items (glasses, sunglasses) are displayed with a "pending" indicator and their checkboxes are disabled.

### 4.2 Detection Row Appearance

Accessory detections are colored **amber** in the detection panel:

```
┌─────────────────────────────────────────────────────────┐
│ backpack  #x12a  conf 91%  dwell 0s       │ amber text  │
│      zone "Gate C"                        │             │
├─────────────────────────────────────────────────────────┤
│ [LOITER] suitcase  conf 88%  dwell 48s    │ amber+red   │
└─────────────────────────────────────────────────────────┘
```

### 4.3 Abandoned Item Alert Banner

When an `abandoned_item` event is received via Socket.IO:
```
┌────────────────────────────────────────────────────────────┐
│  ⚠ ABANDONED ITEM — suitcase at Gate C  [HIGH PRIORITY]   │
│  Unattended for 31 seconds                [Acknowledge]    │
└────────────────────────────────────────────────────────────┘
```

### 4.4 TypeScript Interfaces

```typescript
export interface AccessoryDetection {
  type:       string;    // 'backpack' | 'umbrella' | 'handbag' | 'tie' | 'suitcase'
  confidence: number;
  bbox:       BBox;
  color:      string | null;   // null in Phase-1
}

export interface AbandonedItemEvent {
  type:               'abandoned_item';
  cameraId:           string;
  accessoryType:      string;
  accessoryColor:     string | null;
  lastPersonId:       string | null;
  abandonDurationSec: number;
  bbox:               BBox;
  zoneId:             string | null;
  priority:           'high' | 'medium' | 'low';
  timestamp:          number;
}
```

---

## 5. Data Model

### 5.1 analytics.json (per-item accessory keys)

```json
{
  "backpack":   false,
  "umbrella":   false,
  "handbag":    false,
  "tie":        false,
  "suitcase":   false,
  "glasses":    false,
  "sunglasses": false
}
```

### 5.2 AbandonedItemTracker._state (in-memory)

```typescript
Map<accessoryId, {
  bbox:             BBox;
  className:        string;
  firstSeenAloneAt: number;   // Unix ms
  lastPositions:    Array<{x: number, y: number, t: number}>;
  alertEmitted:     boolean;
  priority:         'high' | 'medium' | 'low';
  lastPersonId:     string | null;
}>
```

Entries are pruned when `Date.now() - firstSeenAloneAt > 5 * 60 * 1000` (5 minutes).

---

## 6. API Design

### 6.1 Analytics Config — Accessory Keys

```
GET  /api/analytics/config
  → 200: { success: true, data: { backpack: false, umbrella: false, handbag: false, tie: false, suitcase: false, ... } }

PUT  /api/analytics/config
  Body: { "backpack": true, "suitcase": true }
  → 200: { success: true, data: <updated config> }
```

### 6.2 Capabilities — Accessory Fields

```
GET  /api/capabilities
  → 200: {
      "ai": {
        "backpack":  true,
        "umbrella":  true,
        "handbag":   true,
        "tie":       true,
        "suitcase":  true
      }
    }
```

All 5 values are `true` when `yolov8n.onnx` is loaded (model is shared; if loaded, all COCO classes can be detected).

---

## 7. Sequence Diagrams

### 7.1 Per-Frame Accessory Detection & Association

```
Camera Frame    DetectionService    PipelineManager    AbandonedItemTracker    Socket.IO
     │                │                   │                    │                  │
     │──JPEG buf──────>│                  │                    │                  │
     │                │──detect()         │                    │                  │
     │                │   (classes 0,24-28│                    │                  │
     │                │<──{persons+accs}──│                    │                  │
     │                │                  │──isClassEnabled()  │                  │
     │                │                  │──filter disabled   │                  │
     │                │                  │──associateAccessoryToPerson()         │
     │                │                  │  → attach to person.accessories[]     │
     │                │                  │──unmatched → tracker.update()──────>  │
     │                │                  │                    │──check timeout    │
     │                │                  │<─── events[] ──────│  + stability      │
     │                │                  │──emit 'detections'─────────────────>  │
     │                │                  │──emit 'abandoned_item' (if any)──────>│
```

### 7.2 Analytics Config Update

```
Client                Server (index.js)    analyticsConfig.js    analytics.json
  │                         │                    │                    │
  │── PUT /api/analytics/config ──────────────>  │                    │
  │   { backpack: true }    │                    │                    │
  │                         │──update()──────────>│                   │
  │                         │                    │──persist()─────────>│
  │                         │<── updated config ─│                    │
  │<── 200 { data: config }─│                    │                    │
  │                         │                    │                    │
  │ (next frame)            │                    │                    │
  │                         │──isClassEnabled('backpack') → true      │
```

---

## 8. Configuration & Environment

### 8.1 Analytics Config Keys

```javascript
// analyticsConfig.js DEFAULT_CONFIG (accessories)
backpack:   false,   // COCO class 24
umbrella:   false,   // COCO class 25
handbag:    false,   // COCO class 26
tie:        false,   // COCO class 27
suitcase:   false,   // COCO class 28
glasses:    false,   // Phase-2 placeholder (UI only)
sunglasses: false,   // Phase-2 placeholder (UI only)
```

### 8.2 AbandonedItemTracker Constants

```javascript
const ABANDON_TIMEOUTS = { high: 30, medium: 60, low: 120 };   // seconds
const PROXIMITY_THRESHOLD = 150;     // pixels — max distance for person-item association
const POSITION_STABILITY_PX = 20;   // pixels — max displacement for "stable" classification
const TRACKER_PRUNE_MS = 5 * 60_000; // 5 minutes — max age for orphaned tracker entries
```

### 8.3 Association Parameters

```javascript
const PERSON_BBOX_EXPAND_SCALE = 1.3;  // expand person bbox before IoU matching
const ASSOCIATION_IOU_THRESHOLD = 0.1; // minimum IoU for person-accessory match
```

---

## 9. Error Handling

| Scenario | Handler | Response |
|---|---|---|
| `yolov8n.onnx` missing | `DetectionService.load()` | `_session = null`; accessory keys all `false` in capabilities |
| ONNX inference throws | `detect()` catch block | Returns `{ detections: [] }`; abandoned tracker skipped |
| Empty person list for association | `associateAccessoryToPerson()` null check | All accessories flagged unattended |
| Invalid analyticsConfig key in PUT | `analyticsConfig.update()` | Unknown keys silently ignored |
| AbandonedItemTracker entry collision | Map key is stable bbox hash | Second update refreshes existing entry |
| Zone `abandonedItemPolicy` absent | Default values used | `timeoutSec` defaults per priority level |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Accessories Detection |
