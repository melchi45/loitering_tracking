# REQUEST FOR PROPOSAL (RFP)
# AI Module — Vehicle Detection

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-02 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `vehicle` |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Current Implementation](#2-current-implementation)
3. [Technical Requirements](#3-technical-requirements)
4. [Model Specification](#4-model-specification)
5. [Vehicle Class Taxonomy](#5-vehicle-class-taxonomy)
6. [Integration Requirements](#6-integration-requirements)
7. [Performance Requirements](#7-performance-requirements)
8. [Evaluation Criteria](#8-evaluation-criteria)
9. [Appendix](#9-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Vehicle Detection AI Module**, which detects and classifies vehicles in video frames within the LTS-2026 Loitering Detection & Tracking System. Vehicle loitering detection is applicable to parking surveillance, restricted area monitoring, and unauthorized vehicle access detection.

### 1.2 Scope

- Detection of 5 vehicle categories: bicycle, car, motorcycle, bus, truck
- Per-zone vehicle loitering analysis (e.g., illegally parked vehicles, vehicles in pedestrian zones)
- Vehicle type classification for targeted zone rules
- Integration with ByteTrack for persistent vehicle ID
- Downstream behavior analysis identical to human loitering pipeline

### 1.3 Zone Target Key

Zones configured with `"targetClasses": ["vehicle"]` apply loitering analysis to all detected vehicle types (bicycle, car, motorcycle, bus, truck). Combined `["human", "vehicle"]` monitors both persons and vehicles.

---

## 2. Current Implementation

| Component | Detail |
|---|---|
| Model | YOLOv8n ONNX (shared with human detection) |
| COCO Classes | bicycle(1), car(2), motorcycle(3), bus(5), truck(7) |
| Runtime | onnxruntime-node (CPU) |
| Zone filter key | `"vehicle"` |
| className values | `"bicycle"`, `"car"`, `"motorcycle"`, `"bus"`, `"truck"` |

```javascript
// server/src/services/detection.js
const ENABLED_CLASSES = {
  0: 'person',
  1: 'bicycle',
  2: 'car',
  3: 'motorcycle',
  5: 'bus',
  7: 'truck',
};
```

```javascript
// server/src/services/behaviorEngine.js
const TARGET_CLASS_MAP = {
  human:   ['person'],
  vehicle: ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
};
```

---

## 3. Technical Requirements

### 3.1 Detection Capability

| Requirement | Specification |
|---|---|
| Vehicle categories | bicycle, car, motorcycle, bus, truck |
| Minimum vehicle size | 64×32 pixels (bicycle), 80×40 pixels (car) in 1080p |
| Simultaneous vehicles | Up to 30 per frame |
| Partial occlusion | Detect when ≥ 40% visible (parked cars behind poles, etc.) |
| Stationary vehicles | Reliably detect non-moving vehicles (no motion blur advantage) |

### 3.2 Input Specifications

| Parameter | Specification |
|---|---|
| Input format | JPEG buffer (from RTSP FFmpeg capture) |
| Frame resolution | 720p, 1080p, 4K |
| Model input | 640×640 normalized RGB tensor `[1, 3, 640, 640]` |
| Preprocessing | Letterbox resize + gray padding (114, 114, 114) |

### 3.3 Output Specifications

```json
[
  {
    "bbox": { "x": 320, "y": 200, "width": 200, "height": 120 },
    "confidence": 0.923,
    "classId": 2,
    "className": "car"
  },
  {
    "bbox": { "x": 100, "y": 280, "width": 60, "height": 90 },
    "confidence": 0.741,
    "classId": 3,
    "className": "motorcycle"
  }
]
```

### 3.4 Extended Output (Proposed)

Vendors may propose enhanced output including:

```json
{
  "bbox": { "x": 320, "y": 200, "width": 200, "height": 120 },
  "confidence": 0.923,
  "classId": 2,
  "className": "car",
  "vehicleType": "sedan",
  "color": "white",
  "licensePlateRegion": { "x": 340, "y": 290, "width": 80, "height": 20 }
}
```

---

## 4. Model Specification

### 4.1 Baseline: YOLOv8n (Shared Detection Model)

| Property | Value |
|---|---|
| Architecture | YOLOv8n |
| COCO mAP@0.5:0.95 | 37.3 |
| Car AP@0.5 | ~62% |
| Truck AP@0.5 | ~58% |
| Bus AP@0.5 | ~67% |
| Motorcycle AP@0.5 | ~48% |
| Bicycle AP@0.5 | ~30% |

### 4.2 Dedicated Vehicle Models

For higher accuracy and vehicle-specific features, proposals may include dedicated vehicle models:

| Model | Focus | mAP@0.5 (vehicles) | Size |
|---|---|---|---|
| YOLOv8n (baseline) | General COCO | ~52% avg | 6MB |
| YOLOv8s-vehicle (fine-tuned) | Vehicle-only | ~70% avg | 22MB |
| YOLOv8m-traffic | Traffic scene | ~75% avg | 49MB |
| NanoDet-Plus | Lightweight vehicle | ~65% avg | 3MB |

### 4.3 License Plate Detection (Optional Enhancement)

For applications requiring license plate identification:

| Model | Type | Output |
|---|---|---|
| WPOD-Net ONNX | License plate localization | Plate bbox + perspective correction |
| LPRNet ONNX | License plate OCR | Plate text string |
| YOLOv8n-LPD | Plate detection | Plate bbox |

---

## 5. Vehicle Class Taxonomy

### 5.1 COCO Vehicle Classes (Currently Supported)

| COCO ID | Class | Description | Typical Size (1080p) |
|---|---|---|---|
| 1 | bicycle | Pedal bicycle, e-bike | 40×70 px |
| 2 | car | Passenger car, SUV, van | 150×80 px |
| 3 | motorcycle | Motorbike, scooter | 60×80 px |
| 5 | bus | City bus, coach, minibus | 300×180 px |
| 7 | truck | Pickup, delivery van, semi-truck | 250×150 px |

### 5.2 Extended Vehicle Sub-types (Proposed)

| Sub-type | Parent Class | Use Case |
|---|---|---|
| sedan | car | Specific parking rule enforcement |
| SUV | car | Height-based zone restrictions |
| electric_scooter | bicycle | Micro-mobility monitoring |
| ambulance | car/truck | Emergency vehicle exemption |
| delivery_van | truck | Delivery zone time limits |
| motorcycle_sidecar | motorcycle | — |

### 5.3 Zone-Specific Vehicle Rules

Vehicle loitering thresholds typically differ from person thresholds:

| Zone Type | Typical Threshold | Rationale |
|---|---|---|
| No-parking zone | 120s | Legal parking grace period |
| Loading zone | 300s | Delivery operations |
| Pedestrian area | 30s | Immediate alert for any vehicle |
| Bus stop | 60s | Bus dwell expected |

---

## 6. Integration Requirements

### 6.1 Pipeline Integration

```
RTSP Frame (JPEG Buffer)
    │
    ▼ DetectionService.detect(jpegBuffer)
    │  returns: [{ className: 'car', bbox, confidence }, ...]
    │
    ▼ ByteTracker.update(detections)
    │  assigns persistent objectId to each vehicle track
    │  preserves: className across frames
    │
    ▼ BehaviorEngine.update(cameraId, tracked, timestamp)
    │  zone.targetClasses = ['vehicle']
    │  → applies dwell logic to car/truck/bus/motorcycle/bicycle
    │  → emits 'loitering' when vehicle exceeds dwellThreshold
    │
    ▼ AlertService.createAlert(event)
    │  stores alert with className for filtering
    │
    ▼ Socket.IO emit('detections', enrichedObjects)
```

### 6.2 Alert Schema

```json
{
  "cameraId": "cam-01",
  "objectId": "uuid",
  "className": "car",
  "zoneId": "parking-zone-uuid",
  "zoneName": "No-Parking Zone A",
  "dwellTime": 185.3,
  "maxDisplacement": 3.2,
  "bbox": { "x": 320, "y": 200, "width": 200, "height": 120 },
  "timestamp": 1715678901234
}
```

### 6.3 Zone Configuration

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

## 7. Performance Requirements

### 7.1 Detection Accuracy

| Vehicle Class | Minimum mAP@0.5 | Target mAP@0.5 |
|---|---|---|
| car | ≥ 60% | ≥ 75% |
| truck | ≥ 55% | ≥ 70% |
| bus | ≥ 60% | ≥ 75% |
| motorcycle | ≥ 45% | ≥ 60% |
| bicycle | ≥ 30% | ≥ 50% |
| **Average** | **≥ 50%** | **≥ 66%** |

### 7.2 Latency

| Hardware | Maximum | Target |
|---|---|---|
| CPU (Core i7) | 50ms/frame | 20ms |
| GPU (RTX 3080) | 15ms/frame | 8ms |
| Jetson Orin (edge) | 30ms/frame | 15ms |

### 7.3 Operational Conditions

| Condition | Requirement |
|---|---|
| Day/Night | Functional under IR illumination |
| Rain/Fog | Maintain ≥ 70% of nominal accuracy |
| Headlight glare | Detect vehicles despite lens flare |
| Distance | Detect up to 50m from camera at 1080p |
| Speed | Detect stationary AND moving vehicles (up to 80 km/h) |

---

## 8. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Detection accuracy (mAP) | 35% | COCO + traffic-specific datasets |
| Latency | 20% | CPU and GPU benchmarks |
| Vehicle sub-type classification | 15% | Optional: sedan/SUV/van accuracy |
| Robustness | 15% | Night, rain, occlusion scenarios |
| License plate detection (optional) | 10% | Plate localization accuracy |
| Integration effort | 5% | ONNX drop-in compatibility |

---

## 9. Appendix

### Appendix A: Benchmark Datasets

| Dataset | Focus | Instances |
|---|---|---|
| COCO val2017 | General vehicle detection | ~37K vehicles |
| UA-DETRAC | Traffic surveillance vehicles | 8,250 sequences |
| CityPersons | Urban scene vehicles | — |
| Cityscapes | Urban scene vehicles + persons | 5,000 frames |

### Appendix B: Loitering vs. Normal Vehicle Behavior

| Behavior | Duration | Classification |
|---|---|---|
| Drive-through | < 5s in zone | Normal |
| Temporary stop | 5s – threshold | Monitoring |
| Loitering | > dwellThreshold + low displacement | ALERT |
| Parked (in no-parking zone) | > dwellThreshold | ALERT |

### Appendix C: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection module |
| [RFP_LTS2026_Loitering_Tracking_System.md](RFP_LTS2026_Loitering_Tracking_System.md) | Parent system RFP |

---

> **END OF DOCUMENT — LTS-2026-AI-02**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
