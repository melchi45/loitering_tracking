# REQUEST FOR PROPOSAL (RFP)
# AI Module — Human (Person) Detection

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-01 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `human` |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Current Implementation](#2-current-implementation)
3. [Technical Requirements](#3-technical-requirements)
4. [Model Specification](#4-model-specification)
5. [Integration Requirements](#5-integration-requirements)
6. [Performance Requirements](#6-performance-requirements)
7. [Evaluation Criteria](#7-evaluation-criteria)
8. [Appendix](#8-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Human (Person) Detection AI Module**, the primary detection component of the LTS-2026 Loitering Detection & Tracking System. The module detects individual persons in video frames and provides bounding boxes for downstream tracking and behavior analysis.

### 1.2 Scope

- Real-time person detection at **10 FPS** per camera channel
- Letterbox preprocessing for variable-resolution input
- Full-body bounding box output in original frame pixel coordinates
- Confidence-thresholded output with NMS post-processing
- COCO class ID **0** (`person`) from YOLOv8n/YOLOv8s

### 1.3 Zone Target Key

Zones configured with `"targetClasses": ["human"]` apply loitering analysis only to detected persons. All other detected objects (vehicles, etc.) are excluded from behavioral analysis in that zone.

---

## 2. Current Implementation

The following is already implemented and deployed as the baseline:

| Component | Detail |
|---|---|
| Model | YOLOv8n ONNX (~6MB) |
| Runtime | onnxruntime-node (CPU) |
| Input | 640×640 normalized RGB `[1, 3, 640, 640]` |
| Output | `[1, 84, 8400]` — 4 bbox coords + 80 COCO class scores |
| Preprocessing | Letterbox resize + gray padding (114, 114, 114) via `sharp` |
| Post-processing | NMS (IoU ≥ 0.5), confidence threshold 0.45 |
| Dimension fix | JPEG SOF header parse → actual frame W×H (no full decode) |
| Frame coords | Bboxes scaled back from letterboxed 640×640 to original JPEG size |

```javascript
// server/src/services/detection.js
const ENABLED_CLASSES = {
  0: 'person',
  // ... vehicles
};
```

**Baseline performance** (Intel Core i7-12700, CPU-only):

| Metric | Measured |
|---|---|
| Inference latency | ~15ms/frame |
| mAP@0.5 (COCO val) | 37.3 (YOLOv8n) |
| Person AP@0.5 | ~54% |

---

## 3. Technical Requirements

### 3.1 Detection Capability

| Requirement | Specification |
|---|---|
| Target class | Person (full body, partial body) |
| Minimum person size | 32×64 pixels in 1080p frame |
| Occlusion tolerance | Detect when ≥ 40% of body is visible |
| Multi-person | Detect up to 50 persons simultaneously |
| Crowd scenes | Maintain accuracy when persons overlap |

### 3.2 Input Specifications

| Parameter | Specification |
|---|---|
| Input format | JPEG buffer (from RTSP FFmpeg capture) |
| Frame resolution | 720p (1280×720), 1080p (1920×1080), 4K (3840×2160) |
| Model input | 640×640 normalized RGB tensor `[1, 3, 640, 640]` |
| Preprocessing | Letterbox resize with gray padding (114, 114, 114) |
| Batch size | 1 (real-time, sequential) |

### 3.3 Output Specifications

Each detected person produces:

```json
{
  "bbox": { "x": 120, "y": 85, "width": 65, "height": 190 },
  "confidence": 0.891,
  "classId": 0,
  "className": "person"
}
```

Coordinates are in original JPEG frame pixel space (e.g., 1920×1080), not model input space.

### 3.4 Runtime Environment

- **Platform**: Node.js 18+ (onnxruntime-node)
- **Execution provider**: CPU (baseline); CUDA/TensorRT optional
- **Concurrency**: Sequential per camera channel; multiple cameras in parallel
- **Model loading**: Lazy, shared singleton across all pipeline instances

---

## 4. Model Specification

### 4.1 Baseline Model: YOLOv8n

| Property | Value |
|---|---|
| Architecture | CSPDarknet + C2f + PANet + Detect head |
| Parameters | 3.2M |
| GFLOPs | 8.7 |
| Input size | 640×640 |
| COCO mAP@0.5:0.95 | 37.3 |
| COCO mAP@0.5 | 53.0 |
| Format | ONNX opset 11+ |
| File size | ~6MB |

### 4.2 Upgrade Path: YOLOv8s / YOLOv8m

| Model | Parameters | GFLOPs | COCO mAP@0.5:0.95 | Size |
|---|---|---|---|---|
| YOLOv8n | 3.2M | 8.7 | 37.3 | 6MB |
| YOLOv8s | 11.2M | 28.6 | 44.9 | 22MB |
| YOLOv8m | 25.9M | 78.9 | 50.2 | 49MB |
| YOLOv8l | 43.7M | 165.2 | 52.9 | 83MB |

### 4.3 Proposed Upgrade: RT-DETR or YOLOv9

For higher accuracy without significant latency increase on GPU:

| Model | mAP@0.5:0.95 | Latency (A100 GPU) |
|---|---|---|
| RT-DETR-R50 | 53.1 | ~4ms |
| YOLOv9-C | 53.0 | ~8ms |
| YOLOv10-M | 51.3 | ~5ms |

### 4.4 NMS Configuration

```
Confidence threshold : 0.45  (env: CONFIDENCE_THRESHOLD)
IoU threshold        : 0.5   (env: NMS_IOU_THRESHOLD)
Max detections       : 300   per frame
```

### 4.5 Post-Processing Pipeline

```
Model output [1, 84, 8400]
    │
    ▼ Extract class 0 (person) scores
    │ Filter: score ≥ confidence_threshold
    │
    ▼ Convert cx,cy,w,h → x1,y1,x2,y2 (letterbox space)
    │ Remove padding offset (padLeft, padTop)
    │ Scale back → original frame coordinates
    │
    ▼ NMS (IoU ≥ iouThreshold)
    │
    ▼ Output: [{bbox, confidence, classId:0, className:'person'}]
```

---

## 5. Integration Requirements

### 5.1 Pipeline Integration

```
RTSP Frame (JPEG Buffer)
    │
    ▼ DetectionService.detect(jpegBuffer)
    │  returns: { detections: [...], frameWidth, frameHeight }
    │
    ▼ ByteTracker.update(detections)
    │  persists objectId across frames
    │  preserves: className, bbox, confidence
    │
    ▼ BehaviorEngine.update(cameraId, trackedObjects, timestamp)
    │  filter: classMatchesZone(obj.className, zone.targetClasses)
    │  → 'human' zones only process className === 'person'
    │
    ▼ Socket.IO emit('detections', { ..., detections: enrichedObjects })
```

### 5.2 Zone Filtering

The behavior engine applies per-zone class filtering:

```javascript
// If zone.targetClasses = ['human']:
classMatchesZone('person', ['human'])   // → true  (applies dwell logic)
classMatchesZone('car',    ['human'])   // → false (skipped)
```

### 5.3 API Contract

**Zone configuration** (PUT `/api/cameras/:id/zones/:zoneId`):
```json
{ "targetClasses": ["human"] }
```

**Detection event** (Socket.IO `detections`):
```json
{
  "objectId": "uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "confidence": 0.87,
  "isLoitering": true,
  "dwellTime": 35.2,
  "zoneId": "zone-uuid"
}
```

---

## 6. Performance Requirements

### 6.1 Detection Accuracy

| Metric | Minimum | Target |
|---|---|---|
| Person AP@0.5 (COCO val2017) | ≥ 54% | ≥ 65% |
| Precision (site-specific) | ≥ 85% | ≥ 92% |
| Recall (site-specific) | ≥ 80% | ≥ 90% |
| False Positive Rate | ≤ 5% | ≤ 2% |

### 6.2 Latency

| Hardware | Maximum Latency | Target |
|---|---|---|
| Intel Core i7 (CPU) | 50ms / frame | 20ms |
| NVIDIA RTX 3080 (GPU) | 15ms / frame | 8ms |
| NVIDIA Jetson Orin (edge) | 25ms / frame | 12ms |

### 6.3 Scalability

| Configuration | Concurrent Channels |
|---|---|
| CPU-only (Core i7) | 4 |
| GPU (RTX 3080) | 16 |
| GPU (A100) | 64 |

### 6.4 Robustness

| Condition | Requirement |
|---|---|
| Illumination | Works under 10–10,000 lux |
| Night / IR | Functional with IR-illuminated frames |
| Partial occlusion | Detect when 40%+ visible |
| Motion blur | Handle up to 30ms shutter equivalent blur |
| Angle | Detect from 0° to 75° camera elevation |

---

## 7. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Accuracy (AP@0.5) | 35% | Benchmark on COCO val2017 + site-specific dataset |
| Inference latency | 25% | Measured on target hardware (CPU + GPU) |
| Robustness | 20% | Accuracy under lighting/occlusion/angle variations |
| Integration effort | 10% | Drop-in ONNX replacement, no API changes required |
| Model size | 10% | Smaller model preferred for edge deployment |

---

## 8. Appendix

### Appendix A: COCO Person Class Statistics

```
COCO val2017 — class 0 (person):
  Total instances : 262,465
  Crowd instances : 8,091
  Size breakdown  : small (<32²px) 30%, medium 35%, large 35%
```

### Appendix B: Inference Code Interface

The vendor must deliver an ONNX model compatible with the existing inference wrapper:

```javascript
// server/src/services/detection.js — expected interface
const result = await detectionService.detect(jpegBuffer);
// result = { detections: [{bbox, confidence, classId, className}], frameWidth, frameHeight }
```

### Appendix C: Test Dataset Requirements

Vendors must provide benchmark results on:

1. **COCO val2017** — standard benchmark
2. **CrowdHuman** — dense crowd person detection
3. **Site-specific dataset** — minimum 1,000 annotated frames from target environment

### Appendix D: Model File Placement

```
server/models/
├── yolov8n.onnx           # Current baseline (person + vehicles)
└── human_detection.onnx   # Proposed replacement (person-optimized)
```

---

> **END OF DOCUMENT — LTS-2026-AI-01**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
