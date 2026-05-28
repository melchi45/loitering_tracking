# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Vehicle Detection

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Vehicle_Detection.md |
| **Parent RFP** | rfp/RFP_AI_Vehicle_Detection.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Model & Inference](#3-functional-requirements--model--inference)
4. [Functional Requirements — Preprocessing](#4-functional-requirements--preprocessing)
5. [Functional Requirements — Postprocessing & Output](#5-functional-requirements--postprocessing--output)
6. [Functional Requirements — Multi-Class Vehicle Output](#6-functional-requirements--multi-class-vehicle-output)
7. [Functional Requirements — Integration & Zone Filtering](#7-functional-requirements--integration--zone-filtering)
8. [Functional Requirements — Error Handling](#8-functional-requirements--error-handling)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Vehicle Detection module of LTS-2026. Each requirement is identified by a unique ID (FR-VDT-NNN) and is directly traceable to test cases in TC_AI_Vehicle_Detection.md.

### 1.2 Scope

This document covers:
- Real-time multi-class vehicle detection using the shared YOLOv8n ONNX model
- Detection of COCO classes 1–8: bicycle, car, motorcycle, airplane, bus, train, truck, boat
- Zone-level filtering using targetClass `'vehicle'` mapped to road-relevant vehicle types
- Analytics configuration gating per class ID
- Socket.IO emission of enriched vehicle detection results

Out of scope: license plate recognition, vehicle speed estimation, vehicle colour attribute analysis, person detection (covered by SRS-LTS-AI-01).

### 1.3 Definitions

| Term | Definition |
|---|---|
| DetectionService | Shared Node.js class (same instance as Human Detection) running YOLOv8n |
| Vehicle classes | COCO class IDs 1–8 mapped to: bicycle(1), car(2), motorcycle(3), airplane(4), bus(5), train(6), truck(7), boat(8) |
| Road-relevant vehicles | Subset of vehicle classes used for zone loitering: bicycle, car, motorcycle, bus, truck |
| analyticsConfig | Server-side object; `isClassEnabled(classId)` gates per-class output |
| Zone targetClass | `'vehicle'` key in zone config maps to road-relevant vehicle classNames |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP / JPEG Frame
  └─ DetectionService.detect()           — YOLOv8n ONNX, 80 COCO classes
       └─ PipelineManager
            ├─ analyticsConfig.isClassEnabled(classId)  — per-class gate (IDs 1–8)
            ├─ ZoneManager.matchZone(bbox, 'vehicle')    — zone assignment
            ├─ TrackingService.update(detections)        — dwell-time per vehicle
            └─ Socket.IO emit 'detections'               — enriched objects to clients
```

### 2.2 Shared Model Instance

The Vehicle Detection module shares the `DetectionService` instance with Human Detection. A single YOLOv8n model inference call returns detections for all 80 COCO classes. Class-level routing (person vs. vehicle vs. other) is performed in PipelineManager after inference.

---

## 3. Functional Requirements — Model & Inference

### FR-VDT-001 — Shared Model File

- Vehicle detection uses the same `yolov8n.onnx` model as Human Detection (SRS-LTS-AI-01)
- Model input: `[1, 3, 640, 640]` Float32 NCHW; model output: `[1, 84, 8400]`
- No separate model file is required for vehicle detection

### FR-VDT-002 — Model Loading

- Model loading follows the same procedure as FR-HDT-002 (shared DetectionService instance)
- If the model is already loaded (session exists), vehicle detection is immediately available

### FR-VDT-003 — Confidence Threshold

- The default confidence threshold for vehicle detections must be `0.45` (shared with human detection via `CONFIDENCE_THRESHOLD` env var)
- Each vehicle class uses the same threshold; no per-class threshold differentiation

### FR-VDT-004 — NMS IoU Threshold

- NMS IoU threshold is `0.5` (shared with human detection via `NMS_IOU_THRESHOLD` env var)
- NMS is applied across all detected classes simultaneously; inter-class suppression is allowed

---

## 4. Functional Requirements — Preprocessing

### FR-VDT-005 — Letterbox Preprocessing

- Preprocessing follows the exact same letterbox procedure as FR-HDT-006 through FR-HDT-008
- The same preprocessed tensor is used for both human and vehicle detections in a single inference pass
- No additional preprocessing is required for vehicle-specific detection

---

## 5. Functional Requirements — Postprocessing & Output

### FR-VDT-006 — Vehicle Class Filtering

- After NMS, only detections where `classId` is in `{1, 2, 3, 4, 5, 6, 7, 8}` are considered vehicle detections
- Each classId maps to a specific vehicle className as follows:

| classId | className |
|---|---|
| 1 | bicycle |
| 2 | car |
| 3 | motorcycle |
| 4 | airplane |
| 5 | bus |
| 6 | train |
| 7 | truck |
| 8 | boat |

### FR-VDT-007 — Per-Class Output Object

Each vehicle detection must carry its specific className (not a generic 'vehicle' label):

```json
{
  "bbox":       { "x": number, "y": number, "width": number, "height": number },
  "confidence": number,
  "classId":    2,
  "className":  "car"
}
```

### FR-VDT-008 — Coordinate Transformation

- Coordinate transformation follows FR-HDT-011 exactly (letterbox removal + scale-back to original frame)
- Output coordinates are in original frame pixel space

### FR-VDT-009 — Analytics Config Gating Per Class

- For each detected vehicle, PipelineManager must call `analyticsConfig.isClassEnabled(classId)`
- If a specific class is disabled (e.g., `isClassEnabled(4)` returns false for `airplane`), that detection must be suppressed
- Different vehicle types may be independently enabled or disabled via analyticsConfig

### FR-VDT-010 — Number Classes Warning

- If the model output has fewer than 10 class dimensions, the service must log a warning:
  `'[Detection] Only N class(es) detected — model may be a single-class fine-tune. Vehicles require a full COCO model.'`
- Detection must still proceed; vehicle classes simply will not appear

---

## 6. Functional Requirements — Multi-Class Vehicle Output

### FR-VDT-011 — Simultaneous Multi-Class Detection

- A single frame may contain detections from multiple vehicle classes simultaneously (e.g., both a car and a bicycle)
- Each detection is reported as a separate object with its own classId, className, bbox, and confidence

### FR-VDT-012 — Road-Relevant Vehicle Zone Mapping

- Zone configurations with `targetClass: 'vehicle'` must match only road-relevant vehicle types: `['bicycle', 'car', 'motorcycle', 'bus', 'truck']`
- Non-road vehicles (`airplane`, `train`, `boat`) must not trigger zone loitering alerts for `'vehicle'` zones
- The mapping from zone key to className list must be defined in the zone configuration or PipelineManager

### FR-VDT-013 — Detection Count Per Frame

- The service must support detecting up to 20 vehicles of mixed classes per frame
- NMS handles de-duplication of overlapping bounding boxes within each class

### FR-VDT-014 — Minimum Detection Size

- Vehicle detections with `width < 20` or `height < 20` pixels (in original frame coordinates) may be discarded
- Minimum size thresholds may differ from human detection given the different aspect ratios of vehicles

---

## 7. Functional Requirements — Integration & Zone Filtering

### FR-VDT-015 — Socket.IO Vehicle Detection Event

- Vehicle detections must be included in the `detections` Socket.IO event payload
- Each vehicle detection in the event must include enriched fields:

```json
{
  "id":          "string (tracker ID)",
  "bbox":        { "x": number, "y": number, "width": number, "height": number },
  "confidence":  number,
  "classId":     number,
  "className":   "car",
  "isLoitering": boolean,
  "dwellTime":   number,
  "zoneId":      "string | null",
  "cameraId":    "string"
}
```

### FR-VDT-016 — Zone Loitering for Vehicles

- Vehicles whose centroid falls within a zone boundary for longer than the zone's dwell threshold must have `isLoitering: true`
- Zone-level alerts must be emitted via `zone_alert` Socket.IO event when a vehicle begins loitering

### FR-VDT-017 — Capabilities Endpoint

- `GET /api/capabilities` must report vehicle detection status
- Response must include `{ ai: { vehicleDetection: true, vehicleClasses: ["bicycle","car","motorcycle","bus","truck","airplane","train","boat"] } }`

### FR-VDT-018 — Analytics Config Class Enable List

- `GET /api/analytics/config` must expose which vehicle classIds are currently enabled
- Client UI must reflect enabled/disabled vehicle classes in the analytics configuration panel

---

## 8. Functional Requirements — Error Handling

### FR-VDT-019 — Missing Model File

- Vehicle detection follows the same error handling as FR-HDT-021
- If `yolov8n.onnx` is missing, `GET /api/capabilities` must reflect `vehicleDetection: false`

### FR-VDT-020 — Inference Error Recovery

- Inference errors for vehicle classes follow the same recovery pattern as FR-HDT-022
- An empty detections array is returned; no unhandled rejection is propagated

---

## 9. Non-Functional Requirements

### FR-VDT-030 — Inference Latency

- Since vehicle detection shares the inference pass with human detection, no additional per-frame latency is incurred beyond FR-HDT-030 (≤ 150 ms total)

### FR-VDT-031 — Class Coverage

- All 8 COCO vehicle class IDs (1–8) must be detectable in a single inference pass without model modification

### FR-VDT-032 — Concurrency

- Concurrent detection calls from multiple camera pipelines must each produce independent, correctly-routed vehicle detection arrays

### FR-VDT-033 — Accuracy

- Minimum precision for `car` class: ≥ 85% on COCO val2017
- Minimum precision for `truck` and `bus`: ≥ 80% on COCO val2017

---

## 10. Interface Requirements

### 10.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-VDT-017 | GET | `/api/capabilities` | Query vehicle detection capability and class list |
| FR-VDT-018 | GET | `/api/analytics/config` | Retrieve analytics class enable/disable configuration |

### 10.2 Socket.IO Events

| Event | Direction | Condition | FR |
|---|---|---|---|
| `detections` | Server→Client | Per-frame vehicle detections (classId 1–8) | FR-VDT-015 |
| `zone_alert` | Server→Client | Vehicle loitering threshold exceeded in zone | FR-VDT-016 |

### 10.3 Zone Configuration Schema

```json
{
  "id":          "string",
  "name":        "string",
  "targetClass": "vehicle",
  "dwellThresholdSec": number,
  "polygon":     [{"x": number, "y": number}]
}
```

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Vehicle detection requires the full 80-class COCO `yolov8n.onnx`; single-class fine-tunes will not produce vehicle detections |
| C-02 | Road-vehicle zone filtering (classNames: bicycle, car, motorcycle, bus, truck) excludes airplane, train, boat by design |
| C-03 | Each frame incurs only one ONNX inference call regardless of how many class types are expected |
| C-04 | analyticsConfig is authoritative for enabling/disabling individual vehicle classes at runtime |
| C-05 | Zone `targetClass: 'vehicle'` must be defined in zone JSON; zones without targetClass receive all detections |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Vehicle Detection |
