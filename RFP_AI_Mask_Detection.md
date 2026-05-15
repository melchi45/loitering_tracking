# REQUEST FOR PROPOSAL (RFP)
# AI Module — Mask Detection

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-04 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `mask` |
| **Status** | Planned (not yet implemented) |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Model Specification](#4-model-specification)
5. [Detection Classes](#5-detection-classes)
6. [Two-Stage Pipeline](#6-two-stage-pipeline)
7. [Integration Requirements](#7-integration-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Evaluation Criteria](#9-evaluation-criteria)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Mask Detection AI Module**, which determines whether individuals are wearing facial masks within configured surveillance zones. The module operates as a downstream attribute classifier following primary person detection, and is integrated into the LTS-2026 Loitering Detection & Tracking System.

### 1.2 Scope

- Two-stage detection: person bbox → head crop → mask classification
- Three-class classification: mask worn correctly, mask worn incorrectly, no mask
- Per-zone activation: `"targetClasses": ["mask"]`
- Alert generation for mask non-compliance in designated zones
- Real-time inference at 10 FPS per camera channel

### 1.3 Zone Target Key

Zones configured with `"targetClasses": ["mask"]` activate mask compliance monitoring. Applicable in healthcare facilities, clean rooms, laboratories, or any zone where mask wearing is mandatory.

---

## 2. Use Cases

| Use Case | Zone Type | Alert Condition |
|---|---|---|
| Hospital entrance compliance | MONITOR | Person detected without mask |
| Factory clean room access | MONITOR | Person with incorrectly worn mask |
| Public transport zone | MONITOR | No-mask alert + loitering |
| Combined: loitering + mask | MONITOR | Person loiters AND wears no mask |
| Exclusion: masked visitors | EXCLUDE | Suppress alerts for masked persons |

---

## 3. Technical Requirements

### 3.1 Mask Detection Capability

| Requirement | Specification |
|---|---|
| Target | Facial mask (surgical, KF94, N95, cloth, face shield) |
| Minimum head size | 30×30 pixels in 1080p |
| Simultaneous persons | Up to 50 per frame |
| Detection speed | Per-frame, real-time at 10 FPS |
| Face angle tolerance | 0°–60° yaw, 0°–30° pitch |
| Partial masks | Classify as "incorrectly worn" |

### 3.2 Input Specifications

| Stage | Input | Size |
|---|---|---|
| Stage 1: Person detection | Full JPEG frame | 1080p / 720p |
| Head crop extraction | Top 30% of person bbox | Variable |
| Stage 2: Mask classification | Normalized head ROI | 112×112 px |

### 3.3 Output Specifications

```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "confidence": 0.89,
  "mask": {
    "status": "no_mask",
    "confidence": 0.962,
    "headBbox": { "x": 110, "y": 52, "width": 40, "height": 48 }
  },
  "isLoitering": false,
  "dwellTime": 8.3
}
```

---

## 4. Model Specification

### 4.1 Head/Face Detection Model (Stage 1)

Use the face detection model from [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md) (SCRFD or YOLOv8n-face), or use a head detector when face features are not required:

| Model | Task | Size | Latency |
|---|---|---|---|
| SCRFD-500M | Face detection | ~1MB | ~2ms |
| YOLOv8n-face | Face/head detection | ~6MB | ~8ms |
| Head-Detector (custom) | Head detection (no landmarks needed) | ~3MB | ~4ms |

### 4.2 Mask Classification Model (Stage 2)

| Model | Architecture | Accuracy | Size | Latency/crop |
|---|---|---|---|---|
| MobileNetV2 (3-class) | MobileNetV2 | 97.2% | ~14MB | ~3ms |
| EfficientNet-B0 (3-class) | EfficientNet-B0 | 98.1% | ~20MB | ~4ms |
| MobileNetV3-Small (3-class) | MobileNetV3-S | 96.5% | ~6MB | ~2ms |
| ResNet-18 (3-class) | ResNet-18 | 98.5% | ~45MB | ~5ms |
| YOLO-Mask (single-stage) | YOLOv8n fine-tuned | 96.8% | ~6MB | ~10ms |

**Recommended**: MobileNetV3-Small for edge; EfficientNet-B0 for server

### 4.3 Single-Stage Alternative

A single-stage model detects and classifies masks directly on the full frame (no separate head crop required):

| Model | Architecture | mAP@0.5 | Size |
|---|---|---|---|
| YOLOv8n-mask | Fine-tuned on mask dataset | ~94% | ~6MB |
| YOLOv8s-mask | Higher accuracy | ~97% | ~22MB |

---

## 5. Detection Classes

### 5.1 Three-Class Classification

| Class ID | Class Name | Description | Alert |
|---|---|---|---|
| 0 | `mask_correct` | Mask covering nose and mouth | None |
| 1 | `mask_incorrect` | Mask worn below nose, chin mask, etc. | Warning |
| 2 | `no_mask` | No face covering | Alert |

### 5.2 Extended Classification (Optional)

| Class | Description |
|---|---|
| `surgical_mask` | Standard surgical/medical mask |
| `n95_kf94` | Respirator-grade mask (KF94/N95/FFP2) |
| `cloth_mask` | Fabric/cloth face covering |
| `face_shield` | Transparent face shield |
| `mask_incorrect` | Mask present but worn incorrectly |
| `no_mask` | No face covering |

### 5.3 Compliance Logic

```javascript
// Zone compliance check
function isMaskCompliant(maskStatus, zonePolicy) {
  if (zonePolicy === 'mandatory') {
    return maskStatus === 'mask_correct';
  }
  if (zonePolicy === 'recommended') {
    return maskStatus !== 'no_mask';
  }
  return true; // no policy
}
```

---

## 6. Two-Stage Pipeline

### 6.1 Pipeline Architecture

```
RTSP Frame (JPEG Buffer)
    │
    ▼ Primary Detection (YOLOv8n)
    │  [person bboxes]
    │
    ▼ Per-person: Head ROI Extraction
    │  head_bbox = {
    │    x: person.x + person.width * 0.15,
    │    y: person.y,
    │    width: person.width * 0.7,
    │    height: person.height * 0.35
    │  }
    │
    ▼ Head/Face Detection (SCRFD-500M)
    │  Input: head ROI crop
    │  Output: [{faceBbox, score}]
    │  → If no face detected: skip mask check (person turned away)
    │
    ▼ Mask Classifier (MobileNetV3)
    │  Input: 112×112 aligned face/head crop
    │  Output: [P(mask_correct), P(mask_incorrect), P(no_mask)]
    │
    ▼ Attach to tracked object
    │  { ..., mask: { status, confidence } }
    │
    ▼ Zone Compliance Check
    │  if zone.targetClasses includes 'mask':
    │    if !isMaskCompliant(mask.status, zone.maskPolicy):
    │      emit 'mask_violation' alert
```

### 6.2 Head ROI Extraction

```javascript
function extractHeadRoi(personBbox) {
  return {
    x:      personBbox.x + personBbox.width  * 0.15,
    y:      personBbox.y,
    width:  personBbox.width  * 0.70,
    height: personBbox.height * 0.35,
  };
}
```

### 6.3 Batch Processing Optimization

When multiple persons are detected in a frame, batch the head crops:
```
Batch size: up to 8 crops per inference call
→ reduces per-person latency from ~2ms to ~0.5ms
```

---

## 7. Integration Requirements

### 7.1 Zone Configuration Extension

```json
{
  "id": "entrance-zone-uuid",
  "name": "Hospital Entrance",
  "type": "MONITOR",
  "targetClasses": ["human", "mask"],
  "maskPolicy": "mandatory",
  "dwellThreshold": 5,
  "minDisplacement": 200
}
```

### 7.2 Alert Schema

```json
{
  "type": "mask_violation",
  "cameraId": "cam-entrance",
  "objectId": "track-uuid",
  "zoneId": "entrance-zone-uuid",
  "zoneName": "Hospital Entrance",
  "maskStatus": "no_mask",
  "maskConfidence": 0.962,
  "dwellTime": 8.3,
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "timestamp": 1715678901234,
  "thumbnail": "base64-jpeg"
}
```

### 7.3 Socket.IO Event Extension

```json
{
  "event": "detections",
  "data": {
    "cameraId": "cam-01",
    "detections": [
      {
        "objectId": "uuid",
        "className": "person",
        "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
        "confidence": 0.89,
        "mask": {
          "status": "no_mask",
          "confidence": 0.962,
          "headBbox": { "x": 110, "y": 52, "width": 40, "height": 48 }
        },
        "isLoitering": false,
        "dwellTime": 8.3
      }
    ]
  }
}
```

---

## 8. Performance Requirements

### 8.1 Classification Accuracy

| Metric | Minimum | Target |
|---|---|---|
| Overall accuracy (3-class) | ≥ 95% | ≥ 98% |
| `no_mask` precision | ≥ 96% | ≥ 99% |
| `no_mask` recall | ≥ 94% | ≥ 98% |
| `mask_incorrect` accuracy | ≥ 85% | ≥ 93% |
| False alert rate | ≤ 3% | ≤ 1% |

### 8.2 Latency Budget

| Component | Maximum Latency |
|---|---|
| Head ROI extraction | < 1ms |
| Head detection (SCRFD) | < 3ms |
| Mask classification | < 3ms |
| **Total per person** | **< 7ms** |
| **Total per frame (10 persons)** | **< 30ms** (batch: < 10ms) |

### 8.3 Operational Conditions

| Condition | Requirement |
|---|---|
| Illumination | 50–5,000 lux |
| Camera angle | 0°–60° elevation |
| Face size | ≥ 30×30 pixels in frame |
| Mask types | Surgical, N95, KF94, cloth, shield |
| IR/night mode | Monochrome frames supported |

---

## 9. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Classification accuracy | 40% | 3-class accuracy on MaskedFace-Net / MAFA |
| False positive rate | 25% | `no_mask` false alerts in real camera footage |
| Latency per frame | 20% | Including head crop + classification |
| Mask type coverage | 10% | Accuracy across surgical / N95 / cloth / shield |
| Integration | 5% | ONNX compatibility, API alignment |

---

## 10. Appendix

### Appendix A: Benchmark Datasets

| Dataset | Instances | Notes |
|---|---|---|
| MaskedFace-Net | 137,016 faces | Correct/incorrect/no mask labels |
| MAFA | 30,811 faces | Masked face detection |
| WIDER FACE | 393,703 faces | Base face detection benchmark |
| Real-Mask (internal) | 5,000+ frames | Site-specific collected data |

### Appendix B: Model File Placement

```
server/models/
├── yolov8n.onnx              # Primary detection (existing)
├── scrfd_500m.onnx           # Head/face detection
└── mask_classifier.onnx     # Mask classification (MobileNetV3)
```

### Appendix C: Zone maskPolicy Values

| Policy | Description |
|---|---|
| `"mandatory"` | Only `mask_correct` is compliant |
| `"recommended"` | `mask_correct` or `mask_incorrect` are compliant |
| `"none"` | Monitoring only, no alerts |

### Appendix D: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection (upstream dependency) |
| [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md) | Face detection (can share head crop) |
| [RFP_AI_Hat_Detection.md](RFP_AI_Hat_Detection.md) | Hat detection (same head ROI pipeline) |

---

> **END OF DOCUMENT — LTS-2026-AI-04**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
