# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Human Detection

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Human_Detection.md |
| **Parent RFP** | rfp/RFP_AI_Human_Detection.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Model & Inference](#3-functional-requirements--model--inference)
4. [Functional Requirements — Preprocessing](#4-functional-requirements--preprocessing)
5. [Functional Requirements — Postprocessing & Output](#5-functional-requirements--postprocessing--output)
6. [Functional Requirements — Integration & Zone Filtering](#6-functional-requirements--integration--zone-filtering)
7. [Functional Requirements — Error Handling](#7-functional-requirements--error-handling)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Interface Requirements](#9-interface-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Human Detection module of LTS-2026. Each requirement is identified by a unique ID (FR-HDT-NNN) and is directly traceable to test cases in TC_AI_Human_Detection.md.

### 1.2 Scope

This document covers:
- Real-time person detection using YOLOv8n running on ONNX Runtime
- Image preprocessing (letterbox resize, CHW Float32 tensor construction)
- Postprocessing (bounding box coordinate transformation, confidence filtering, NMS)
- Zone-based filtering via analyticsConfig class gating
- Socket.IO emission of enriched detection results
- Error handling for missing model files and inference failures

Out of scope: person re-identification, face recognition, loitering dwell-time calculation (handled by PipelineManager), attribute enrichment.

### 1.3 Definitions

| Term | Definition |
|---|---|
| DetectionService | Node.js class wrapping the YOLOv8n ONNX model |
| Letterboxing | Proportional resize with grey padding (114,114,114) to reach 640×640 |
| NMS | Non-Maximum Suppression — removes overlapping boxes of the same class |
| CHW | Channel-Height-Width tensor layout (NCHW with batch=1) |
| COCO class 0 | The `person` class in the MS-COCO 80-class taxonomy |
| Zone targetClass | String key in zone configuration used to gate classes; `'human'` maps to `className === 'person'` |
| analyticsConfig | Server-side configuration object; `isClassEnabled(classId)` returns boolean |
| isLoitering | Boolean flag set by PipelineManager when dwellTime exceeds zone threshold |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP / JPEG Frame
  └─ DetectionService.detect()       — YOLOv8n ONNX, class 0 (person)
       └─ PipelineManager
            ├─ analyticsConfig.isClassEnabled(0)   — gate: is 'person' enabled?
            ├─ ZoneManager.matchZone(bbox)          — zone assignment
            ├─ TrackingService.update(detections)   — dwell-time tracking
            └─ Socket.IO emit 'detections'          — enriched objects to clients
```

### 2.2 Startup Sequence

```
Server start
  1. DetectionService constructed (modelPath from env or default)
  2. DetectionService.load()     — ONNX InferenceSession created
  3. PipelineManager.start()     — cameras registered
  4. Per-frame loop begins
  5. HTTP server listens on PORT
```

---

## 3. Functional Requirements — Model & Inference

### FR-HDT-001 — Model File

- The detection model must be `yolov8n.onnx` located in `server/models/`
- Path is overridable via environment variable `YOLO_MODEL` (relative to `server/` directory)
- The model must accept input shape `[1, 3, 640, 640]` (NCHW Float32)
- The model output shape must be `[1, 84, 8400]` (4 bbox coords + 80 class scores × 8400 anchors)

### FR-HDT-002 — Model Loading

- `DetectionService.load()` must create an ONNX `InferenceSession` using `ort.InferenceSession.create()`
- Loading must use session options from `getOnnxSessionOptions()` (CPU execution provider)
- If `_session` is already set, subsequent calls to `load()` must be no-ops (idempotent)
- A concurrent call to `load()` while loading is in progress must await the same promise (no duplicate sessions)

### FR-HDT-003 — Lazy Load on First Inference

- If `detect()` is called before `load()`, the service must call `load()` automatically before running inference
- The service must not throw an unhandled error when lazy-loading

### FR-HDT-004 — Confidence Threshold

- The default confidence threshold must be `0.45` for the human detection module (overridable via `CONFIDENCE_THRESHOLD` env var or constructor option)
- Anchor boxes with maximum class score below this threshold must be discarded before NMS

### FR-HDT-005 — NMS IoU Threshold

- The default NMS IoU threshold must be `0.5` (overridable via `NMS_IOU_THRESHOLD` env var or constructor option)
- Two boxes of any class with IoU ≥ threshold must result in the lower-confidence box being suppressed

---

## 4. Functional Requirements — Preprocessing

### FR-HDT-006 — JPEG Decode

- Input to `detect()` is a raw JPEG `Buffer`
- The service must decode the JPEG using `sharp` to obtain pixel dimensions (`width`, `height`)
- If JPEG metadata is unavailable, dimensions must default to 640×640

### FR-HDT-007 — Letterbox Resize

- The image must be proportionally scaled so the longest side equals 640 pixels
- Scale factor: `Math.min(640 / srcW, 640 / srcH)`
- The scaled image must be padded symmetrically with grey (R:114, G:114, B:114) to reach exactly 640×640
- Padding amounts: `padLeft = floor((640 - scaledW) / 2)`, `padTop = floor((640 - scaledH) / 2)`

### FR-HDT-008 — CHW Tensor Construction

- The preprocessed 640×640 RGB image must be converted to a `Float32Array` of length 3 × 640 × 640
- Channel layout: all R values, then all G values, then all B values (planar CHW)
- Normalization: each pixel channel divided by 255.0 to produce values in range [0.0, 1.0]
- The tensor must be wrapped as `ort.Tensor('float32', float32, [1, 3, 640, 640])`

---

## 5. Functional Requirements — Postprocessing & Output

### FR-HDT-009 — Anchor Box Parsing

- The output tensor `[1, 84, 8400]` must be parsed as 8400 anchor boxes
- For each anchor: extract cx, cy, bw, bh from rows 0–3; extract 80 class scores from rows 4–83
- The class with the maximum score is selected as the detected class

### FR-HDT-010 — Person Class Filter

- Only anchor boxes where the max-score class is `classId === 0` (COCO 'person') must proceed to coordinate transformation
- Non-person classes (classId 1–79) must be filtered out for the human detection output path

### FR-HDT-011 — Coordinate Transformation

- Bounding box coordinates from the model output are in the 640×640 letterboxed model space
- The service must map coordinates back to the original frame pixel space:
  - Remove letterbox padding: subtract `padLeft` from x-coords, `padTop` from y-coords
  - Scale back: multiply x by `origW / scaledW`, y by `origH / scaledH`
  - Clamp: x1 ≥ 0, y1 ≥ 0, x2 ≤ origW, y2 ≤ origH
- Output bbox fields: `{ x, y, width, height }` in original frame pixel coordinates

### FR-HDT-012 — Minimum Detection Size

- Detections with `width < 32` or `height < 64` (in original frame coordinates) must be discarded
- This ensures noise from distant or partially-visible persons is suppressed

### FR-HDT-013 — Output Object Schema

Each detected person must produce an object with the following fields:

```json
{
  "bbox":       { "x": number, "y": number, "width": number, "height": number },
  "confidence": number,
  "classId":    0,
  "className":  "person"
}
```

### FR-HDT-014 — Maximum Detections Per Frame

- The service must support detecting up to 50 persons per frame
- NMS ensures that duplicate boxes for the same person are collapsed to one

### FR-HDT-015 — Partial Occlusion Tolerance

- The model must correctly detect persons with up to 40% of their body occluded
- This is a model-level requirement; no software suppression of partially-visible persons may occur

### FR-HDT-016 — Return Structure

- `detect(jpegBuffer, originalSize)` must return `{ detections: Array, frameWidth: number, frameHeight: number }`
- `detections` is the NMS-filtered array of person detection objects
- `frameWidth` and `frameHeight` reflect the original (unscaled) frame dimensions

---

## 6. Functional Requirements — Integration & Zone Filtering

### FR-HDT-017 — Analytics Config Gating

- Before passing detections downstream, PipelineManager must call `analyticsConfig.isClassEnabled(0)` for class ID 0 (person)
- If the class is disabled, all person detections must be suppressed and not emitted to clients

### FR-HDT-018 — Zone Class Key Mapping

- Zone configurations with `targetClass: 'human'` must match detection objects where `className === 'person'`
- The mapping `'human' → 'person'` must be consistent across all zone filtering logic

### FR-HDT-019 — Socket.IO Detections Event

- Detected persons must be included in the `detections` Socket.IO event emitted by PipelineManager
- Each detection in the event payload must include the following enriched fields:

```json
{
  "id":         "string (tracker ID)",
  "bbox":       { "x": number, "y": number, "width": number, "height": number },
  "confidence": number,
  "classId":    0,
  "className":  "person",
  "isLoitering": boolean,
  "dwellTime":  number,
  "zoneId":     "string | null",
  "cameraId":   "string"
}
```

### FR-HDT-020 — Capabilities Endpoint

- `GET /api/capabilities` must include a field indicating human detection status
- Response must include `{ ai: { humanDetection: true } }` when the model is loaded
- If the model failed to load, the value must be `false`

---

## 7. Functional Requirements — Error Handling

### FR-HDT-021 — Missing Model File

- If `yolov8n.onnx` does not exist at startup, the load must fail gracefully with a console warning
- The service must not crash the server process; `_session` remains `null`
- `GET /api/capabilities` must reflect `humanDetection: false`

### FR-HDT-022 — Inference Error Recovery

- If an ONNX inference call throws, the `detect()` method must catch the error, log it, and return `{ detections: [], frameWidth: 0, frameHeight: 0 }`
- The error must not propagate to the caller as an unhandled rejection

### FR-HDT-023 — Invalid JPEG Input

- If `jpegBuffer` is not a valid JPEG, `sharp` will throw; the service must catch this and return an empty detections array

---

## 8. Non-Functional Requirements

### FR-HDT-030 — Inference Latency

- End-to-end detection latency (preprocess + inference + postprocess) must not exceed 150 ms per frame on the target hardware (CPU: Intel Core i7 or equivalent)

### FR-HDT-031 — Memory Usage

- The loaded ONNX model must consume no more than 512 MB of RAM
- Tensor allocations must be released after each inference call; no memory leak across frames

### FR-HDT-032 — Concurrency

- The service must support concurrent `detect()` calls from multiple camera pipelines
- Each call constructs independent tensor allocations; `_session.run()` is awaited per call

### FR-HDT-033 — Accuracy

- Minimum precision: ≥ 85% on COCO val2017 `person` class
- Minimum recall: ≥ 80% for standing adults at distances 2–15 m in standard surveillance resolution

### FR-HDT-034 — Model Load Time

- `DetectionService.load()` must complete within 10 seconds on the target hardware

---

## 9. Interface Requirements

### 9.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-HDT-020 | GET | `/api/capabilities` | Query human detection capability status |

**Response schema for `/api/capabilities`:**
```json
{
  "ai": {
    "humanDetection": true,
    "modelName": "yolov8n.onnx"
  }
}
```

### 9.2 Socket.IO Events

| Event | Direction | Payload | Condition |
|---|---|---|---|
| `detections` | Server→Client | `DetectionFrame` (see FR-HDT-019) | Emitted per frame when persons detected |

### 9.3 Internal Service API

```javascript
// Constructor
new DetectionService({ modelPath, confidenceThreshold, iouThreshold })

// Methods
detect(jpegBuffer: Buffer, originalSize?: { width: number, height: number })
  → Promise<{ detections: Detection[], frameWidth: number, frameHeight: number }>

load() → Promise<void>
```

---

## 10. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Model `yolov8n.onnx` must be present in `server/models/` before server start |
| C-02 | Input frames must be JPEG-encoded; raw pixel buffers are not accepted by `detect()` |
| C-03 | The ONNX Runtime CPU execution provider is used; GPU inference is out of scope |
| C-04 | Zone configuration is managed externally; DetectionService has no knowledge of zones |
| C-05 | The 80 COCO classes are all available in the model; class gating is done at PipelineManager level |
| C-06 | `originalSize` parameter must reflect the JPEG frame dimensions, not the camera stream resolution if they differ |
| C-07 | NMS is applied globally across all classes, not per-class |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Human Detection |
