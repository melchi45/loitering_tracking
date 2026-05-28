# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Human (Person) Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-01 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Human_Detection.md (LTS-2026-AI-01) |

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

The Human Detection module is the primary detection component of the LTS-2026 Loitering Detection & Tracking System — providing real-time person bounding boxes from RTSP video frames at 10 FPS per channel, serving as the upstream dependency for all downstream tracking, behavior analysis, and appearance attribute modules.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect individual persons (full body and partial body) in JPEG frames at 10 FPS per camera channel.
- Output full-body bounding boxes in original frame pixel coordinates with confidence scores.
- Apply confidence thresholding and NMS post-processing to produce clean, non-duplicate detections.
- Support multi-person detection of up to 50 persons simultaneously per frame.
- Provide a clear upgrade path from YOLOv8n (baseline) to YOLOv8s/m for higher accuracy sites.

### 2.2 Non-Goals

- This module is not responsible for person tracking or identity persistence across frames — that is handled by ByteTracker.
- Person re-identification across cameras is out of scope for this module.
- This module does not classify person attributes (clothing, age, gender) — those are downstream attribute modules.

---

## 3. User Personas

**System Integrator** — deploys the LTS system at surveillance sites. Needs a reliable, well-documented ONNX model interface that integrates with the existing Node.js pipeline without API changes. Prefers small model size for edge deployment on Jetson hardware.

**Site Administrator** — configures detection zones and sensitivity thresholds. Needs accurate person detection under their specific site conditions (lighting, camera angle, crowd density) and the ability to tune confidence thresholds via environment variables.

---

## 4. Functional Specification

### 4.1 Current Baseline Implementation

| Component | Detail |
|---|---|
| Model | YOLOv8n ONNX (~6 MB) |
| Runtime | `onnxruntime-node` (CPU) |
| Input tensor | `[1, 3, 640, 640]` normalized RGB |
| Output tensor | `[1, 84, 8400]` — 4 bbox coords + 80 COCO class scores |
| Preprocessing | Letterbox resize + gray padding (114, 114, 114) via `sharp` |
| Post-processing | NMS (IoU ≥ 0.5), confidence threshold 0.45 |
| Coordinate output | Bboxes in original JPEG frame pixel space |
| Person class | COCO class ID 0 (`person`) |

Baseline performance on Intel Core i7-12700 (CPU-only): ~15 ms/frame, person AP@0.5 ~54%.

### 4.2 Preprocessing Pipeline

1. Parse JPEG SOF header to obtain actual frame W×H without full decode.
2. Letterbox-resize frame to 640×640 with gray (114,114,114) padding.
3. Normalize pixel values to [0,1].
4. Run YOLOv8n inference.
5. Filter class 0 (person) scores ≥ confidence threshold.
6. Convert cx,cy,w,h → x1,y1,x2,y2 (letterbox space).
7. Remove padding offsets (padLeft, padTop) and scale back to original frame coordinates.
8. Apply NMS.

### 4.3 Zone Filtering Integration

Zones with `"targetClasses": ["human"]` apply loitering analysis only to `className === 'person'` detections. All other classes are ignored by the behavior engine for that zone.

### 4.4 Confidence Thresholds

```
Confidence threshold : 0.45  (env: CONFIDENCE_THRESHOLD)
IoU threshold        : 0.5   (env: NMS_IOU_THRESHOLD)
Max detections       : 300   per frame
```

### 4.5 Upgrade Path

| Model | COCO mAP@0.5:0.95 | Size | Use Case |
|---|---|---|---|
| YOLOv8n (current) | 37.3 | 6 MB | Edge / low-resource |
| YOLOv8s | 44.9 | 22 MB | Improved accuracy |
| YOLOv8m | 50.2 | 49 MB | High-density crowds |

Any upgrade must be ONNX-compatible with the existing `detectionService.detect(jpegBuffer)` interface.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, `onnxruntime-node` |
| Execution provider | CPU (baseline); CUDA/TensorRT optional |
| Model format | ONNX opset 11+ |
| Model input | `[1, 3, 640, 640]` float32 |
| Model output | `[1, 84, 8400]` float32 |
| Frame formats | 720p, 1080p, 4K JPEG |
| Min person size | 32×64 px in 1080p |
| Occlusion tolerance | ≥ 40% body visible |
| Simultaneous persons | Up to 50 per frame |
| Latency target — CPU | ≤ 50 ms/frame (target: 20 ms) |
| Latency target — GPU | ≤ 15 ms/frame (target: 8 ms) |
| Concurrent channels — CPU | 4 |
| Concurrent channels — GPU | 16 |
| Model loading | Lazy, shared singleton across all pipeline instances |

---

## 6. Input / Output Contract

**Input:**
- JPEG buffer from RTSP FFmpeg capture.
- Frame resolution inferred from JPEG SOF header.

**`detectionService.detect(jpegBuffer)` return value:**
```json
{
  "detections": [
    {
      "bbox": { "x": 120, "y": 85, "width": 65, "height": 190 },
      "confidence": 0.891,
      "classId": 0,
      "className": "person"
    }
  ],
  "frameWidth": 1920,
  "frameHeight": 1080
}
```

All bbox coordinates are in original JPEG frame pixel space.

**Socket.IO `detections` event (after ByteTracker + BehaviorEngine):**
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

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Person AP@0.5 | ≥ 54% on COCO val2017 (minimum); ≥ 65% target |
| AC-02 | Site precision | ≥ 85% precision on site-specific test dataset |
| AC-03 | Site recall | ≥ 80% recall on site-specific test dataset |
| AC-04 | False positive rate | ≤ 5% per frame |
| AC-05 | CPU latency | ≤ 50 ms/frame on Intel Core i7 |
| AC-06 | GPU latency | ≤ 15 ms/frame on NVIDIA RTX 3080 |
| AC-07 | Multi-person | ≥ 50 persons detected simultaneously without missed detections due to NMS |
| AC-08 | Occlusion | Detect persons with ≥ 40% body visible |
| AC-09 | Night / IR | Functional with IR-illuminated monochrome frames |
| AC-10 | API compatibility | Model upgrade (YOLOv8n → YOLOv8s) requires zero changes to downstream ByteTracker or BehaviorEngine code |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Baseline: YOLOv8n ONNX person detection with letterbox preprocessing and NMS | 2026-05-01 | 2026-05-01 | ✅ Complete |
| M2 | Benchmark on COCO val2017 and site-specific dataset | TBD | - | ⏳ Pending |
| M3 | Evaluate YOLOv8s/m upgrade for high-density crowd sites | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Run formal benchmark on COCO val2017 — measure person AP@0.5 and compare against ≥ 54% minimum
- [ ] Run benchmark on CrowdHuman dataset for dense-crowd performance
- [ ] Collect and annotate ≥ 1,000 site-specific frames; measure precision/recall
- [ ] Evaluate YOLOv8s as drop-in replacement — run latency and accuracy comparison
- [ ] Test CUDA execution provider path on NVIDIA GPU hardware
- [ ] Measure concurrent channel capacity on target deployment hardware (CPU and GPU)
- [ ] Test IR/night-mode frames for monochrome input compatibility
- [ ] Verify JPEG SOF header parsing correctness for non-standard aspect ratios and 4K input
- [ ] Document environment variable configuration (`CONFIDENCE_THRESHOLD`, `NMS_IOU_THRESHOLD`) in deployment guide

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for AI Human Detection |
