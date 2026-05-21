# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Accessories Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-08 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Accessories_Detection.md (LTS-2026-AI-08) |

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

The Accessories Detection module enriches tracked person metadata with carried and worn item information — enabling compound alerts such as "person with large backpack loitering at Gate C for 45 seconds" — and provides abandoned item detection to alert security when items are left unattended in high-risk zones.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect 10 accessory categories (carried items: backpack, handbag, suitcase, umbrella, tie; worn items: glasses, sunglasses, jewelry, gloves, scarf) associated with tracked persons.
- Associate each detected accessory with the nearest tracked person via IoU overlap.
- Detect abandoned items (accessory present without an associated person for longer than a configurable timeout) and emit `abandoned_item` alerts with configurable priority levels.
- Support per-item on/off toggles via the Video Analytics UI and the `/api/analytics/config` API.
- Enable cross-camera person search by accessory type and color (e.g., `GET /api/events?accessory=backpack&accessoryColor=blue`).

### 2.2 Non-Goals

- This module does not perform license-plate or vehicle identification.
- Worn items not covered by COCO 80 (glasses, jewelry, gloves, scarf) are out of scope for Phase-1 and require a dedicated Phase-2 model.
- This module does not implement X-ray or concealed-object detection.

---

## 3. User Personas

**Security Operator** — monitors live camera feeds in airports, transit stations, and shopping malls. Needs instant alerts when bags are left unattended or when a person matching a description ("black backpack, gray suitcase") is spotted loitering.

**Incident Investigator** — searches historical events after an incident. Uses accessory-based queries to narrow down footage across multiple cameras and reconstruct a person's path.

---

## 4. Functional Specification

### 4.1 Phase-1 — COCO Accessory Detection (Complete)

The existing `yolov8n.onnx` (COCO 80-class) detects five accessory classes at zero additional inference cost. Each class has an independent enable/disable toggle in the VideoAnalytics UI.

| Module Key | COCO ID | Class |
|---|---|---|
| `backpack` | 24 | Backpack / school bag |
| `umbrella` | 25 | Open or closed umbrella |
| `handbag` | 26 | Purse, clutch, small bag |
| `tie` | 27 | Necktie |
| `suitcase` | 28 | Rolling luggage |

### 4.2 Phase-2 — Extended Accessory Detection (Planned)

A dedicated fine-tuned model (`accessories_yolov8n_finetune.onnx`) is required to detect the five additional worn categories: glasses, sunglasses, jewelry, gloves, and scarf. A two-stage glasses classifier (MobileNetV3-Small, 64×64 face/head crop, 3-class: `no_glasses`/`glasses`/`sunglasses`) is the recommended approach.

### 4.3 Person-Accessory Association

Each detected accessory bbox is matched to the nearest person bbox using IoU (expanded person bbox × 1.3). Accessories with no IoU match above threshold 0.1 are flagged as unattended candidates.

### 4.4 Abandoned Item Detection

The `AbandonedItemTracker` state machine transitions:
`DETECTED → UNATTENDED (timer) → ABANDONED → emit abandoned_item alert → CLEARED`

Priority levels:
- HIGH (30 s): suitcase, backpack — airport, station, mall zones
- MEDIUM (60 s): handbag, briefcase — office, store zones
- LOW (120 s): umbrella, shopping_bag — any zone

### 4.5 Zone Configuration

Zones use `"targetClasses": ["accessories"]` (backward-compat alias) or individual keys (`"backpack"`, `"suitcase"`, etc.). The `abandonedItemPolicy` block controls per-zone abandoned item behavior.

### 4.6 Alert Events

- **Loitering + accessory**: standard `loitering` alert enriched with `appearance.accessories` array.
- **Abandoned item**: `abandoned_item` event with `accessoryType`, `accessoryColor`, `lastPersonId`, `abandonDurationSec`, `priority`.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime (`onnxruntime-node`) |
| Primary model | `yolov8n.onnx` (COCO 80-class, shared with human/vehicle detection) |
| Phase-2 model | `accessories_yolov8n_finetune.onnx` (10-class, ~6 MB) |
| Glasses classifier | `glasses_classifier.onnx` (MobileNetV3-Small, ~6 MB, optional) |
| Detector input | 640×640 letterboxed JPEG frame |
| Simultaneous items | Up to 50 accessories per frame |
| Accessory overhead latency | < 5 ms/frame total (association + abandoned tracking) |
| Person-association method | IoU on expanded person bbox (scale ×1.3) |
| Temporal smoothing | 5-frame majority vote per accessory per track |
| Abandoned item check | Position displacement < 20 px over timeout window |

---

## 6. Input / Output Contract

**Input:**
- Full JPEG frame (1080p) from RTSP pipeline.
- Person bbox list `[{objectId, bbox, className:'person'}]` from YOLOv8n primary detection.
- Raw COCO detection results including classes 24–28.

**Output per tracked person:**
```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "accessories": [
    { "type": "backpack", "confidence": 0.91, "bbox": {...}, "color": "blue" },
    { "type": "glasses",  "confidence": 0.76, "bbox": {...}, "color": "black" }
  ],
  "abandonedItem": null
}
```

**Abandoned item event:**
```json
{
  "type": "abandoned_item",
  "cameraId": "cam-platform",
  "accessoryType": "suitcase",
  "accessoryColor": "black",
  "lastPersonId": "track-uuid",
  "abandonDurationSec": 31,
  "priority": "high"
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | COCO accessory classes detected | backpack, handbag, suitcase, umbrella, tie detected in live feed with mAP@0.5 ≥ 53% average |
| AC-02 | Per-item toggle | Each accessory class can be independently enabled/disabled via PUT `/api/analytics/config`; disabled classes produce no detections |
| AC-03 | Person-accessory association | Accessory correctly linked to overlapping person in ≥ 88% of cases in test set |
| AC-04 | Abandoned item — true detection | ≥ 90% of truly abandoned items trigger `abandoned_item` alert within ±5 s of timeout |
| AC-05 | Abandoned item — false alarm | False alarm rate ≤ 5% when a person remains within proximity threshold |
| AC-06 | Latency overhead | Accessory pipeline adds ≤ 5 ms to per-frame processing time |
| AC-07 | Alert schema | `abandoned_item` event contains `accessoryType`, `priority`, `abandonDurationSec`, and zone fields |
| AC-08 | Person search API | `GET /api/events?accessory=backpack&accessoryColor=blue` returns matching events |
| AC-09 | UI color coding | Accessory detections appear in amber in the detection panel and canvas overlay |
| AC-10 | Phase-2 placeholders | `glasses` and `sunglasses` toggles visible in UI but marked as pending until Phase-2 model is available |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase-1: COCO accessory detection with per-item UI toggles | 2026-05-18 | 2026-05-18 | ✅ Complete |
| M2 | Person-accessory association and abandoned item state machine | TBD | - | ⏳ Pending |
| M3 | Phase-2: Dedicated 10-class accessory model + glasses classifier | TBD | - | ⏳ Pending |
| M4 | Abandoned item alert integration with alert service and UI | TBD | - | ⏳ Pending |
| M5 | Person search API for accessory/color queries | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement `AbandonedItemTracker` class with state machine (DETECTED → UNATTENDED → ABANDONED → CLEARED)
- [ ] Add `associateAccessoryToPerson()` function using IoU on expanded person bbox
- [ ] Emit `abandoned_item` Socket.IO event from pipeline with priority levels per item type
- [ ] Extend zone schema with `abandonedItemPolicy` block (timeoutSec, alertPriority, itemTypes)
- [ ] Add `appearance.accessories` array to loitering alert schema
- [ ] Implement `GET /api/events?accessory=&accessoryColor=` search endpoint
- [ ] Apply 5-frame majority vote temporal smoothing per accessory per track
- [ ] Train or source `accessories_yolov8n_finetune.onnx` (10-class) for Phase-2 worn items
- [ ] Train or source `glasses_classifier.onnx` (MobileNetV3-Small, 3-class) for Phase-2
- [ ] Add Phase-2 glasses/sunglasses entries to `MODULE_CLASSES` once model is available
- [ ] Write benchmark evaluation against AVSS 2007 and i-LIDS abandoned baggage datasets
