# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Animal Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-10 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Animal_Detection.md (LTS-2026-AI-10) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [Input / Output Contract](#6-input--output-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

The Animal Detection module extends the LTS-2026 Loitering Detection & Tracking System to detect and track 10 COCO animal species in surveillance video, enabling automatic alerts when animals intrude restricted zones (server rooms, food preparation areas, sterile facilities) and applying the same loitering dwell-time analysis used for persons and vehicles — with zero additional model overhead.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect 10 COCO animal categories (bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe) using the already-deployed `yolov8n.onnx` model.
- Provide per-class on/off toggles in the Video Analytics tab and via `/api/analytics/config`.
- Apply identical loitering dwell-time analysis to animal tracks (ByteTracker + BehaviorAnalyzer).
- Emit `loitering:alert` Socket.IO events when an animal exceeds the zone dwell threshold.
- Display animal detections in the Dashboard Detection Panel with species-specific color codes.

### 2.2 Non-Goals

- Species outside the COCO 80-class set (fox, deer, rabbit, raccoon, snake, etc.) are out of scope for Phase-1 and require a dedicated Phase-2 wildlife model.
- The module does not perform animal behavior analysis beyond basic dwell-time loitering detection.
- Animal Re-ID (individual animal re-identification across cameras) is not in scope.

---

## 3. User Personas

**Facility Security Manager** — responsible for server rooms, laboratories, and food preparation areas. Needs immediate alerts when stray animals (cats, dogs, birds) enter restricted zones, with automatic evidence clipping for incident records.

**Farm / Ranch Operator** — uses surveillance cameras to monitor livestock movement across paddocks. Needs per-species class filtering and dwell-time tracking to identify animals lingering in dangerous areas (near machinery, roads).

---

## 4. Functional Specification

### 4.1 Detected Animal Classes

| COCO ID | Class | Detection Text Color |
|---|---|---|
| 14 | bird | `text-pink-200` |
| 15 | cat | `text-rose-300` |
| 16 | dog | `text-rose-400` |
| 17 | horse | `text-orange-800` |
| 18 | sheep | `text-gray-100` |
| 19 | cow | `text-amber-900` |
| 20 | elephant | `text-gray-500` |
| 21 | bear | `text-amber-800` |
| 22 | zebra | `text-gray-100` |
| 23 | giraffe | `text-amber-600` |

### 4.2 Per-Class Toggle

Each animal class is individually controlled via:
- `VideoAnalyticsTab.tsx` — "Animals" group with 10 checkboxes (i18n key: `zoneGroupAnimals`).
- `analyticsConfig.js` — each class defaults to `false` in `DEFAULT_CONFIG`.
- `PUT /api/analytics/config` — persisted in `storage/analytics.json`.

Disabled animal classes are discarded in `isClassEnabled()` before entering the ByteTracker.

### 4.3 Loitering Behavior

Animal tracks are processed identically to person and vehicle tracks:
- `dwellTime` accumulates while the animal remains inside a zone polygon.
- `isLoitering = true` when `dwellTime ≥ zone.dwellThreshold`.
- `loitering:alert` Socket.IO event is emitted → detection row shows red background and loitering badge.

### 4.4 Zone Configuration

Zones target individual species or combinations:
```json
{ "name": "Server Room", "targetClasses": ["dog", "cat", "bird"], "dwellThreshold": 10 }
```
An empty `targetClasses` array enables all classes including animals.

### 4.5 Dashboard Integration

Animal detections appear in the merged detection list in `DashboardDetectionPanel.tsx` with species-specific color codes and an optional loitering badge.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime (`onnxruntime-node`) |
| Model | `yolov8n.onnx` (COCO 80-class, 13 MB) — shared, no additional model required |
| Inference input | 640×640 px letterboxed frame |
| Confidence threshold | ≥ 0.25 (shared with all COCO classes) |
| Inference latency | ~8–12 ms/frame (shared session, no additional cost) |
| Additional model memory | 0 MB |
| Execution provider | CPU (Intel Core i7, 40 cores); CUDA optional |
| Tracker | ByteTracker — animal tracks treated identically to person tracks |
| Per-class enable | `analyticsConfig.isClassEnabled(className)` called per detection |

---

## 6. Input / Output Contract

**Input:**
- JPEG frame from RTSP pipeline (640×640 after letterbox preprocessing).
- `analyticsConfig` state — per-class enable flags for all 10 animal classes.

**Output per detection (Socket.IO `detections` event):**
```json
{
  "cameraId": "cam-01",
  "detections": [
    {
      "objectId": "track-uuid",
      "className": "dog",
      "confidence": 0.87,
      "bbox": { "x": 200, "y": 150, "width": 80, "height": 100 },
      "dwellTime": 32.0,
      "isLoitering": true,
      "zoneId": "zone-uuid"
    }
  ]
}
```

**Loitering alert (Socket.IO `loitering:alert`):**
```json
{
  "cameraId": "cam-01",
  "objectId": "track-uuid",
  "className": "dog",
  "zone": "Server Room",
  "dwellTime": 32.0
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | All 10 animal classes detected | bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe produce detections when enabled |
| AC-02 | Per-class toggle — disable | Disabling a class via PUT `/api/analytics/config` produces zero detections for that species within 1 frame |
| AC-03 | Per-class toggle — enable | Enabling a class causes detections to appear in the next processed frame |
| AC-04 | Dwell time accumulation | `dwellTime` increments continuously while animal remains within zone polygon |
| AC-05 | Loitering alert fired | `loitering:alert` event emitted when `dwellTime ≥ zone.dwellThreshold` |
| AC-06 | Detection latency | Frame processing latency remains ≤ 15 ms/frame with animals enabled |
| AC-07 | Color codes | Each species renders with the correct Tailwind color class in the detection panel |
| AC-08 | Zero additional memory | No second ONNX session is created; model memory stays at yolov8n baseline |
| AC-09 | mAP baseline | Animal class detections achieve ≥ 45% mAP@0.5 average across all 10 classes on COCO val2017 |
| AC-10 | Zone species filter | Zone with `targetClasses: ["dog"]` triggers loitering analysis only for dogs, not other species |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase-1: 10-class COCO animal detection with per-class UI toggles | 2026-05-20 | 2026-05-20 | ✅ Complete |
| M2 | Loitering analysis validation for animal tracks | TBD | - | ⏳ Pending |
| M3 | Phase-2: Wildlife model for species outside COCO 80 | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Verify dwell-time accumulation accuracy for fast-moving animals (cat, bird) in zone boundary edge cases
- [ ] Add `DetectionRow` color rendering test coverage for all 10 animal classes
- [ ] Add i18n translations for all 10 animal class names across all 13 supported languages
- [ ] Define zone-level recommended dwell thresholds per animal type (e.g., bird: 5 s, bear: 3 s)
- [ ] Evaluate Phase-2A wildlife model options (YOLOv8s fine-tuned on iNaturalist/LVIS) for deer, fox, raccoon, wolf
- [ ] Add animal class filter to `DashboardDetectionPanel` CATEGORIES list
- [ ] Write integration test: enable dog class, play dog-entry video clip, verify loitering alert within expected dwell time

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for AI Animal Detection |
