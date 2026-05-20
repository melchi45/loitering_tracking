# REQUEST FOR PROPOSAL (RFP)
# AI Module — Animal Detection

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-10 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 20, 2026 |
| **Zone Target Key** | individual keys (`bird`, `cat`, `dog`, `horse`, `sheep`, `cow`, `elephant`, `bear`, `zebra`, `giraffe`) |
| **Status** | **✅ Phase-1 Complete — COCO yolov8n 10-class detection active, per-class on/off in Video Analytics tab** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Animal Taxonomy](#4-animal-taxonomy)
5. [Model Specification](#5-model-specification)
6. [Detection Pipeline](#6-detection-pipeline)
7. [Integration Requirements](#7-integration-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Appendix](#9-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Animal Detection AI Module**, which detects animals in surveillance video and generates alerts when animals intrude restricted zones (server rooms, food preparation areas, sterile facilities, etc.). The module uses the COCO 80-class YOLOv8n model already deployed in the LTS-2026 Loitering Detection & Tracking System — no additional model is required.

### 1.2 Scope

- Detection of 10 COCO animal categories: bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe
- Per-class on/off toggle in the Video Analytics tab
- Integration as zone-level target classes: `"targetClasses": ["dog"]` (or any combination)
- Loitering detection applies to animals — a stray dog dwelling in a zone triggers the same loitering alert logic as a person
- Dashboard Detection Tab: animal detections appear in the merged list with species-specific color codes

### 1.3 Zone Target Key

Each animal class has an independent key. A zone can target a single species (`["dog"]`) or multiple (`["cat", "dog", "bird"]`). When no `targetClasses` are specified (empty array), all enabled classes — including animals — are detected.

---

## 2. Use Cases

| Use Case | Description | Priority |
|---|---|---|
| Stray animal intrusion | Dog/cat enters restricted area (food storage, laboratory) | **High** |
| Wildlife intrusion | Deer, bear enters facility perimeter | **High** |
| Animal loitering alert | Animal dwells in zone exceeding dwell threshold | High |
| Farm / ranch monitoring | Count and track livestock (sheep, cow, horse) | Medium |
| Pest detection | Bird flock on rooftop solar panels / warehouse | Medium |
| Pet monitoring | Indoor camera: alert when pet enters forbidden room | Medium |
| Evidence logging | Auto-clip when animal detected in zone for incident records | Medium |

---

## 3. Technical Requirements

### 3.1 Detection Model

| Item | Specification |
|---|---|
| Model | YOLOv8n (COCO 80-class) — already deployed |
| File | `server/models/yolov8n.onnx` (13 MB) |
| Input resolution | 640×640 px |
| Confidence threshold | ≥ 0.25 (shared with all COCO classes) |
| Animal classes (COCO IDs) | bird(14), cat(15), dog(16), horse(17), sheep(18), cow(19), elephant(20), bear(21), zebra(22), giraffe(23) |

### 3.2 Per-Class Toggle

Animal classes are individually controlled via:
- **Video Analytics tab** (`VideoAnalyticsTab.tsx`): "Animals" group with 10 checkboxes
- **analyticsConfig.js** `DEFAULT_CONFIG`: each class defaults to `false`
- **`/api/analytics/config`** PUT endpoint: persisted in `storage/analytics.json`

### 3.3 Loitering Behavior

The ByteTracker and behavior analysis modules treat animal tracks identically to person/vehicle tracks:
- `dwellTime` accumulates while the animal remains in zone
- `isLoitering = true` when `dwellTime ≥ zone.dwellThreshold`
- `loitering:alert` socket event fired → red row background in Detection panel

---

## 4. Animal Taxonomy

### 4.1 Detected Classes

| COCO ID | Class | Korean | Detection Text Color |
|---------|-------|--------|---------------------|
| 14 | bird | 새 | `text-pink-200` |
| 15 | cat | 고양이 | `text-rose-300` |
| 16 | dog | 개 | `text-rose-400` |
| 17 | horse | 말 | `text-orange-800` |
| 18 | sheep | 양 | `text-gray-100` |
| 19 | cow | 소 | `text-amber-900` |
| 20 | elephant | 코끼리 | `text-gray-500` |
| 21 | bear | 곰 | `text-amber-800` |
| 22 | zebra | 얼룩말 | `text-gray-100` |
| 23 | giraffe | 기린 | `text-amber-600` |

### 4.2 Out-of-Scope (Phase-1)

Species not included in COCO 80: fox, wolf, deer, rabbit, raccoon, snake, crocodile, etc. Phase-2 would require a dedicated wildlife detection model.

---

## 5. Model Specification

### 5.1 Inference Engine

| Item | Value |
|---|---|
| Runtime | ONNX Runtime Node.js (`onnxruntime-node`) |
| Session | Shared with all COCO detections — single `yolov8n.onnx` session |
| Execution | CPU (Intel Core i7, 40 cores); CUDA optional via `onnxOptions` |
| Latency | ~8–12 ms/frame (shared — no additional cost vs. human/vehicle detection) |
| Memory | No additional model memory required |

### 5.2 Confidence Filtering

```javascript
// analyticsConfig.isClassEnabled('dog') → returns true when dog is enabled
detections = result.detections.filter(d => analyticsConfig.isClassEnabled(d.className));
```

The shared COCO detection pipeline calls `isClassEnabled()` for each detection. Disabled animal classes are discarded before entering the tracker.

---

## 6. Detection Pipeline

```
RTSP Frame (JPEG)
  │
  ▼
YOLOv8n inference (yolov8n.onnx) — COCO 80 classes
  │  detections[]: {className, confidence, bbox}
  │  filter: analyticsConfig.isClassEnabled(className)
  ▼
ByteTracker.update()
  │  tracked[]: {objectId, className, dwellTime, ...}
  ▼
BehaviorAnalyzer.update()
  │  isLoitering, riskScore, revisitCount, velocity
  ▼
Socket.IO emit('detections', { cameraId, detections })
  │
  ▼
Client DashboardDetectionPanel
  └─ DetectionRow — species color code + loitering badge if active
```

---

## 7. Integration Requirements

### 7.1 Client — Video Analytics Tab

```
Animals
├─ [☑] Bird       ├─ [☑] Cat
├─ [☑] Dog        ├─ [☑] Horse
├─ [☑] Sheep      ├─ [☑] Cow
├─ [☑] Elephant   ├─ [☑] Bear
├─ [☑] Zebra      └─ [☑] Giraffe
```

Group key: `zoneGroupAnimals` (i18n key, already translated in all 13 supported languages).

### 7.2 Detection Row Appearance

```
┌──────────────────────────────────────────┐
│ dog  #a3b1  conf 87%  dwell 8.3s         │  ← text-rose-400
│      zone "Entrance"                     │
├──────────────────────────────────────────┤
│ [LOITER] dog  #a3b1  conf 87%  dwell 32s │  ← bg-red-900/20 + red badge
└──────────────────────────────────────────┘
```

### 7.3 Zone Configuration Example

```json
{
  "name": "Server Room",
  "type": "MONITOR",
  "dwellThreshold": 10,
  "targetClasses": ["dog", "cat", "bird"]
}
```

### 7.4 REST / Socket API

| Event / Endpoint | Direction | Payload |
|---|---|---|
| `detections` (socket) | Server → Client | `{ cameraId, detections: [{className:'dog', objectId, dwellTime, isLoitering, ...}] }` |
| `loitering:alert` (socket) | Server → Client | `{ cameraId, objectId, className:'dog', zone, dwellTime }` |
| `GET /api/analytics/config` | Client → Server | Returns current per-class enable state |
| `PUT /api/analytics/config` | Client → Server | `{ dog: true, cat: true, ... }` |

---

## 8. Performance Requirements

| Metric | Target | Achieved (Phase-1) |
|---|---|---|
| Detection latency | < 15 ms/frame | ~8–12 ms (shared COCO session) |
| mAP@0.5 — animals | ≥ 50% | YOLOv8n COCO: ~45–55% (class-dependent) |
| False positive rate | < 5% per class | Within COCO benchmark range |
| Additional model memory | 0 MB | 0 MB (reuses yolov8n.onnx) |
| Per-class enable/disable | Real-time | ✅ analyticsConfig toggle |

---

## 9. Appendix

### 9.1 COCO Animal Class YOLO Indices

```
COCO ID → YOLO class index (0-based after mapping):
  bird=14, cat=15, dog=16, horse=17, sheep=18,
  cow=19, elephant=20, bear=21, zebra=22, giraffe=23
```

### 9.2 Implementation Files

| File | Role |
|---|---|
| `server/models/yolov8n.onnx` | Shared COCO detection model (13 MB) |
| `server/src/services/analyticsConfig.js` | Per-class enable/disable, `isClassEnabled()` |
| `server/src/services/detection.js` | YOLOv8n inference, 80-class NMS |
| `server/src/services/tracking.js` | ByteTracker — animal tracks treated same as person |
| `client/src/components/VideoAnalyticsTab.tsx` | zoneGroupAnimals checkbox group |
| `client/src/components/FullscreenCameraView.tsx` | `DetectionRow` color codes, Legend |
| `client/src/components/DashboardDetectionPanel.tsx` | CATEGORIES Animal filter, `?` color legend |
| `storage/analytics.json` | Persisted per-class enable state |

### 9.3 Phase-2 Roadmap (Wildlife / Extended Animals)

| Phase | Scope | Model Candidate |
|---|---|---|
| Phase-2A | Wildlife: deer, fox, raccoon, wolf | YOLOv8s fine-tuned on iNaturalist / LVIS |
| Phase-2B | Insects / pests: rat, cockroach | Specialized pest-detection model |
| Phase-2C | Marine animals | Custom dataset required |

> Phase-2 requires a dedicated model beyond the COCO 80-class set. Loitering alert logic and ByteTracker integration would remain unchanged — only `analyticsConfig` class mapping and `DetectionRow` color codes would need extension.
