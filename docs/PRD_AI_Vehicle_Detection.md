# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Vehicle Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-02 |
| **Version** | 1.0 |
| **Status** | In Progress |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Vehicle_Detection.md (LTS-2026-AI-02) |

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

The Vehicle Detection module extends the LTS-2026 loitering pipeline to detect and track vehicles (bicycle, car, motorcycle, bus, truck) in configured zones, enabling automated enforcement of no-parking rules, restricted-area monitoring, and unauthorized vehicle access detection.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Detect and classify 5 COCO vehicle categories in real time using the shared YOLOv8n ONNX model.
- **G2**: Feed vehicle detections into ByteTrack for persistent vehicle ID across frames.
- **G3**: Apply loitering dwell-time analysis to vehicles via zone `targetClasses: ["vehicle"]`.
- **G4**: Support combined `["human", "vehicle"]` zone monitoring.
- **G5**: Emit vehicle-specific alerts with `className` for downstream filtering.

### 2.2 Non-Goals

- **NG1**: License plate recognition — optional Phase 2 enhancement.
- **NG2**: Vehicle sub-type classification (sedan, SUV, delivery van) — Phase 2.
- **NG3**: Speed detection or traffic flow analysis.

---

## 3. User Personas

### P1: Parking Enforcement Operator
Monitors designated no-parking zones; needs automatic alerts when a vehicle exceeds the dwell threshold without manual camera review.

### P2: Site Security Manager
Oversees restricted access zones (pedestrian areas, loading bays); requires time-stamped vehicle alert logs for incident reporting.

---

## 4. Functional Specification

### 4.1 Supported Vehicle Classes

| COCO ID | Class | Typical size at 1080p |
|---|---|---|
| 1 | bicycle | 40x70 px |
| 2 | car | 150x80 px |
| 3 | motorcycle | 60x80 px |
| 5 | bus | 300x180 px |
| 7 | truck | 250x150 px |

### 4.2 Zone Activation

`TARGET_CLASS_MAP` maps zone key `"vehicle"` to `["bicycle","car","motorcycle","bus","truck"]`. Zones with `targetClasses: ["vehicle"]` apply dwell-time analysis to all vehicle types.

### 4.3 Loitering Logic

Identical to human loitering pipeline: ByteTrack assigns persistent `objectId`; `BehaviorEngine` accumulates dwell time per zone; alert fired when `dwellTime > dwellThreshold` and `displacement < minDisplacement`.

### 4.4 Zone-Specific Thresholds

| Zone type | Recommended threshold |
|---|---|
| No-parking zone | 120 s |
| Loading zone | 300 s |
| Pedestrian area | 30 s |
| Bus stop | 60 s |

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Model | YOLOv8n ONNX (`server/models/yolov8n.onnx`) — shared with human detection |
| Runtime | Node.js >= 20, `onnxruntime-node` (CPU) |
| Input tensor | `[1, 3, 640, 640]` letterbox-normalised |
| Minimum vehicle size | 64x32 px (bicycle), 80x40 px (car) at 1080p |
| Simultaneous vehicles | Up to 30 per frame |
| Partial occlusion | Detect when >= 40% of vehicle visible |
| Latency (CPU i7) | <= 50 ms/frame |
| mAP@0.5 (average) | >= 50% (baseline YOLOv8n) |

---

## 6. Input / Output Contract

### Detection output (per tracked object)
```json
{
  "bbox": { "x": 320, "y": 200, "width": 200, "height": 120 },
  "confidence": 0.923,
  "classId": 2,
  "className": "car",
  "objectId": "track-uuid"
}
```

### Alert output
```json
{
  "cameraId": "cam-01",
  "objectId": "track-uuid",
  "className": "car",
  "zoneId": "parking-zone-uuid",
  "zoneName": "No-Parking Zone A",
  "dwellTime": 185.3,
  "maxDisplacement": 3.2,
  "timestamp": 1715678901234
}
```

### Zone configuration
```json
{
  "id": "parking-zone-uuid",
  "name": "No-Parking Zone A",
  "type": "MONITOR",
  "targetClasses": ["vehicle"],
  "dwellThreshold": 120,
  "minDisplacement": 10
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Zone activation | Vehicle detections processed only when `targetClasses` includes `"vehicle"` |
| AC-02 | Combined zones | `["human","vehicle"]` zones produce alerts for both person and vehicle loitering |
| AC-03 | Alert className | Alert record contains correct vehicle `className` (car/truck/etc.) |
| AC-04 | ByteTrack persistence | Vehicle `objectId` is stable across >= 30 consecutive frames |
| AC-05 | Occlusion tolerance | Vehicle detected when >= 40% of bbox is visible |
| AC-06 | Detection accuracy | car mAP@0.5 >= 60%, truck >= 55% on COCO val2017 |
| AC-07 | Dashboard display | Vehicle detections render bounding boxes with correct class label |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | COCO vehicle class mapping in DetectionService and BehaviorEngine | 2026-05-18 | 2026-05-18 | Done |
| M2 | Zone `targetClasses: ["vehicle"]` activation and alert generation | 2026-05-20 | 2026-05-20 | Done |
| M3 | Dedicated vehicle model (YOLOv8s-vehicle) for higher accuracy | TBD | - | Pending |

### 8.2 TODO

- [ ] Evaluate YOLOv8s-vehicle fine-tuned model for improved motorcycle/bicycle mAP
- [ ] Implement vehicle sub-type classification: sedan, SUV, delivery van (Phase 2)
- [ ] Integrate optional license plate detection (WPOD-Net ONNX) (Phase 2)
- [ ] Validate mAP@0.5 >= 50% average on COCO val2017 and UA-DETRAC
- [ ] Add vehicle-specific dwell threshold presets to zone creation UI
