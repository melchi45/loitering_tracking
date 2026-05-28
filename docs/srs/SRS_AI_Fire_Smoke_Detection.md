# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Fire & Smoke Detection

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-03-FS |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Fire_Smoke_Detection.md |
| **Parent RFP** | rfp/RFP_AI_Fire_Smoke_Detection.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Model & Loading](#3-functional-requirements--model--loading)
4. [Functional Requirements — Preprocessing](#4-functional-requirements--preprocessing)
5. [Functional Requirements — Postprocessing & Output](#5-functional-requirements--postprocessing--output)
6. [Functional Requirements — Class Filtering](#6-functional-requirements--class-filtering)
7. [Functional Requirements — Integration](#7-functional-requirements--integration)
8. [Functional Requirements — Error Handling](#8-functional-requirements--error-handling)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Fire & Smoke Detection module of LTS-2026. Each requirement is identified by a unique ID (FR-FSD-NNN) and is traceable to test cases in TC_AI_Fire_Smoke_Detection.md.

### 1.2 Scope

This document covers:
- Fire and smoke detection using a YOLOv8s model fine-tuned on fire/smoke datasets
- Model lifecycle management (load, status reporting, graceful missing-file handling)
- Image preprocessing (letterbox resize, CHW Float32 tensor)
- Postprocessing (coordinate transformation, confidence filtering, NMS)
- Filtering of the 'default' placeholder class
- Socket.IO emission of fire/smoke detection events

Out of scope: fire suppression integration, alarm relay, multi-camera cross-correlation of fire events.

### 1.3 Definitions

| Term | Definition |
|---|---|
| FireSmokeService | Node.js class managing the YOLOv8s fire/smoke ONNX model |
| SKIP_CLASSES | `Set(['default'])` — the placeholder class present in the model output that must always be ignored |
| Model output shape | `[1, 7, 8400]` — 4 bbox + 3 class scores (fire/default/smoke) × 8400 anchors |
| confThreshold | Confidence score threshold (0.35) below which detections are discarded |
| nmsThreshold | IoU threshold (0.45) for Non-Maximum Suppression |
| Status | Lifecycle state of the service: `'not_started'` \| `'missing'` \| `'loaded'` \| `'failed'` |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP / JPEG Frame
  └─ FireSmokeService.detect()        — YOLOv8s ONNX, classes: fire / smoke
       └─ PipelineManager
            ├─ fireSmokeService.ready   — gate: skip if not ready
            ├─ Merge detections with main detections array
            └─ Socket.IO emit 'detections'  — className 'fire' or 'smoke'
```

### 2.2 Status State Machine

```
'not_started'
    │
    ├─ load() called, .onnx file exists
    │       └─ ONNX session created → 'loaded', _ready = true
    │
    ├─ load() called, .onnx file NOT found
    │       └─ 'missing', _ready = false
    │
    └─ load() called, ONNX session creation throws
            └─ 'failed', _ready = false
```

---

## 3. Functional Requirements — Model & Loading

### FR-FSD-001 — Model File

- The fire/smoke model must be `yolov8s_fire_smoke.onnx` located in `server/models/`
- The model output shape must be `[1, 7, 8400]`: 4 bbox dimensions + 3 class scores (fire=0, default=1, smoke=2) × 8400 anchors
- Path is configurable via the `modelPath` constructor option

### FR-FSD-002 — File Existence Check Before Load

- `FireSmokeService.load()` must check for the model file using `fs.existsSync(this.modelPath)` before attempting to create an ONNX session
- If the file does not exist: log `'[FireSmokeService] yolov8s_fire_smoke.onnx not found — fire/smoke detection disabled'` and set `_status = 'missing'`
- `load()` must return immediately (no error thrown) when the file is missing

### FR-FSD-003 — Successful Load

- When the file exists, `ort.InferenceSession.create()` must be called with `getOnnxSessionOptions()`
- On success: `_session` is set, `_ready = true`, `_status = 'loaded'`
- Log `'[FireSmokeService] yolov8s_fire_smoke.onnx loaded'`

### FR-FSD-004 — Failed Load

- If `ort.InferenceSession.create()` throws: `_status = 'failed'`, `_ready = false`
- Log `'[FireSmokeService] Failed to load model: <error.message>'`
- No unhandled promise rejection; error is caught internally

### FR-FSD-005 — Ready and Status Properties

- `FireSmokeService.ready` (getter) must return `this._ready` (boolean)
- `FireSmokeService.status` (getter) must return `this._status` (string)
- Both getters must be accessible without calling `load()` first; initial values: `ready = false`, `status = 'not_started'`

---

## 4. Functional Requirements — Preprocessing

### FR-FSD-006 — Letterbox Resize

- Input JPEG frame must be letterbox-resized to 640×640 using the formula:
  - `scale = Math.min(640 / origW, 640 / origH)`
  - `scaledW = round(origW * scale)`, `scaledH = round(origH * scale)`
  - `padL = floor((640 - scaledW) / 2)`, `padT = floor((640 - scaledH) / 2)`
- Padding background color: `{ r: 114, g: 114, b: 114 }` (grey)

### FR-FSD-007 — CHW Float32 Tensor

- The padded 640×640 RGB image must be converted to Float32Array shape `[1, 3, 640, 640]`
- Pixel normalization: divide each channel value by 255.0
- Channel layout: planar (all R, then all G, then all B)

---

## 5. Functional Requirements — Postprocessing & Output

### FR-FSD-008 — Anchor Parsing

- The output `[1, 7, 8400]` must be parsed as 8400 anchor boxes
- For each anchor: rows 0–3 are cx, cy, bw, bh; rows 4–6 are class scores for fire(0), default(1), smoke(2)
- The class with the highest score is selected; if score < `confThreshold` (0.35), the anchor is discarded

### FR-FSD-009 — SKIP_CLASSES Filtering

- The 'default' class (classIdx=1) must always be excluded from output regardless of confidence score
- The check `SKIP_CLASSES.has(rawName)` must occur after confidence threshold filtering
- Detections of className 'default' must never appear in the output array

### FR-FSD-010 — Coordinate Transformation

- Bounding box coordinates from model space must be transformed to original frame coordinates:
  - `x1 = (cx - bw/2 - padL) / scale`
  - `y1 = (cy - bh/2 - padT) / scale`
  - `x2 = (cx + bw/2 - padL) / scale`
  - `y2 = (cy + bh/2 - padT) / scale`
- Output must be clamped to `[0, origW]` and `[0, origH]`

### FR-FSD-011 — Output Object Schema

Each fire or smoke detection must produce:

```json
{
  "className":  "fire",
  "confidence": number,
  "bbox": {
    "x":      number,
    "y":      number,
    "width":  number,
    "height": number
  }
}
```

- `className` must be lowercase: `'fire'` or `'smoke'`
- The `NORMALISE` map must ensure case-normalisation: `{ Fire: 'fire', fire: 'fire', smoke: 'smoke' }`

### FR-FSD-012 — NMS

- NMS must be applied to the candidate detections using `nmsThreshold = 0.45`
- Detections are sorted by confidence descending before NMS
- IoU-based suppression collapses duplicate bounding boxes across all classes

---

## 6. Functional Requirements — Class Filtering

### FR-FSD-013 — Fire Class

- Detections where the top class is index 0 ('fire') and `confidence ≥ 0.35` must appear in output with `className: 'fire'`

### FR-FSD-014 — Smoke Class

- Detections where the top class is index 2 ('smoke') and `confidence ≥ 0.35` must appear in output with `className: 'smoke'`

### FR-FSD-015 — Default Class Suppression

- Index 1 ('default') must never appear in output regardless of confidence

---

## 7. Functional Requirements — Integration

### FR-FSD-016 — Guard on Not-Ready

- `detect()` must return an empty array immediately if `_ready === false` or `_session === null`
- This covers `status === 'missing'`, `'failed'`, and `'not_started'`

### FR-FSD-017 — Socket.IO Detections Event

- Fire and smoke detections must be merged into the `detections` Socket.IO event payload alongside human and vehicle detections
- Each fire/smoke detection in the event must include:

```json
{
  "id":          "string (tracker ID)",
  "className":   "fire",
  "confidence":  number,
  "bbox":        { "x": number, "y": number, "width": number, "height": number },
  "isLoitering": false,
  "dwellTime":   0,
  "zoneId":      null,
  "cameraId":    "string"
}
```

### FR-FSD-018 — Status API Endpoint

- `GET /api/capabilities` must include fire/smoke service status:
  ```json
  {
    "ai": {
      "fireSmokeDetection": true,
      "fireSmokeStatus": "loaded"
    }
  }
  ```
- `fireSmokeDetection` must be `false` when status is `'missing'` or `'failed'`

---

## 8. Functional Requirements — Error Handling

### FR-FSD-019 — Inference Error Recovery

- If `_session.run()` throws during detection, the error must be caught, logged as `'[FireSmokeService] Detection error: <message>'`, and an empty array returned
- No unhandled rejection must propagate

### FR-FSD-020 — Graceful Degradation

- When FireSmokeService is not ready, the main detection pipeline must continue operating normally
- Human and vehicle detections must not be affected by fire/smoke service failures

---

## 9. Non-Functional Requirements

### FR-FSD-030 — Inference Latency

- Fire/smoke inference must complete within 200 ms per frame on the target CPU hardware
- YOLOv8s is larger than YOLOv8n; additional latency budget of 50 ms vs. human/vehicle detection

### FR-FSD-031 — Memory Usage

- The YOLOv8s fire/smoke model must consume no more than 768 MB of RAM when loaded

### FR-FSD-032 — Detection Sensitivity

- Minimum confidence threshold of 0.35 is chosen to maximize recall for safety-critical fire detection
- False positive rate must be acceptable for monitoring contexts (< 5% at 0.35 threshold)

### FR-FSD-033 — Model Load Time

- `FireSmokeService.load()` must complete within 15 seconds on the target hardware

---

## 10. Interface Requirements

### 10.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-FSD-018 | GET | `/api/capabilities` | Query fire/smoke detection status |

### 10.2 Socket.IO Events

| Event | Direction | Condition | FR |
|---|---|---|---|
| `detections` | Server→Client | Per-frame fire/smoke detections | FR-FSD-017 |

### 10.3 Internal Service API

```javascript
new FireSmokeService({ modelPath?: string })

load() → Promise<void>

detect(jpegBuffer: Buffer, origW: number, origH: number)
  → Promise<Array<{ className: 'fire'|'smoke', confidence: number, bbox: BBox }>>

get ready(): boolean
get status(): 'not_started' | 'missing' | 'loaded' | 'failed'
```

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Model `yolov8s_fire_smoke.onnx` must be exported from the Abonia1/YOLOv8-Fire-and-Smoke-Detection weights |
| C-02 | The 'default' class is a model artifact; it has no detection meaning and must always be suppressed |
| C-03 | Fire/smoke detection is an optional capability; its absence must not impair other detection modules |
| C-04 | Frame dimensions (`origW`, `origH`) must be passed explicitly; FireSmokeService does not read JPEG metadata |
| C-05 | NMS threshold (0.45) is lower than human/vehicle NMS (0.5) to suppress overlapping fire/smoke detections more aggressively |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Fire Smoke Detection |
