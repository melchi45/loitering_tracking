# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Fire & Smoke Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-09 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Fire_Smoke_Detection.md (LTS-2026-AI-09) |

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

The Fire & Smoke Detection module adds real-time safety event detection to the LTS-2026 system, providing early fire and smoke alerts from existing CCTV cameras — targeting detection within 30 seconds of fire occurrence — without requiring additional hardware sensors.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect fire and smoke in real time using a YOLOv8s fine-tuned model (`yolov8s_fire_smoke.onnx`, 43 MB).
- Emit `fire:alert` Socket.IO events immediately upon detection in a configured zone.
- Support zone-level activation via `targetClasses: ["fire"]` and `targetClasses: ["smoke"]`.
- Display fire and smoke bounding boxes on the camera view overlay with distinct colors (fire: orange-red, smoke: dark gray).
- List fire/smoke detections in the Detection Panel with appropriate color coding.

### 2.2 Non-Goals

- The module does not distinguish cooking smoke from fire smoke (recommended enhancement only).
- Thermal or infrared camera sensor integration is out of scope.
- Historical fire trend analytics is out of scope.

---

## 3. User Personas

**Facility Safety Officer** — monitors server rooms, warehouses, and factory lines via CCTV. Needs instant alerts when fire or smoke is detected, well before a sprinkler system activates.

**Security Control Room Operator** — watches multiple camera feeds simultaneously. Needs clear visual overlays (color-coded bounding boxes) and audible alert notifications when fire or smoke is detected in any monitored zone.

---

## 4. Functional Specification

### 4.1 Model Classes

| Index | Original Class | Internal Name | Display Color |
|---|---|---|---|
| 0 | `Fire` | `fire` | Orange-red `rgba(255,80,0)` |
| 1 | `default` | *(skipped)* | — |
| 2 | `smoke` | `smoke` | Dark gray `rgba(75,85,99)` |

The `default` class (index 1) is excluded in post-processing via `SKIP_CLASSES`.

### 4.2 Post-Processing Pipeline

1. JPEG frame preprocessed to 640×640 letterbox (gray fill 114, normalized /255) via `sharp`.
2. ONNX inference produces `[1, 7, 8400]` output (4 bbox coords + 3 class scores × 8400 anchors).
3. Confidence filtering (threshold > 0.35).
4. `default` class (index 1) skipped.
5. Class name normalized to lowercase (`'Fire'` → `'fire'`).
6. NMS applied (IoU > 0.45).
7. Output: `[{className:'fire'|'smoke', confidence, bbox}]` in original frame coordinates.

### 4.3 Pipeline Integration

Fire/smoke detection runs as an independent step after the primary loitering pipeline in `pipelineManager.js`:
1. Primary detection (YOLOv8n COCO)
2. ByteTracker
3. BehaviorEngine
4. AttributePipeline
5. **FireSmokeService.detect()** ← full-frame, independent
6. Merge fire/smoke bbox into detections array
7. Zone intersection check → emit `fire:alert`
8. Emit `detections` socket event

### 4.4 Alert Deduplication

Alerts for the same zone and class are limited to one per 10-second interval to prevent alert flooding.

### 4.5 Zone Activation

Zones include `"fire"` and/or `"smoke"` in `targetClasses`. When neither is configured, fire/smoke detection is skipped for that zone.

### 4.6 Client Integration

- **Zone Editor**: fire and smoke checkboxes, enabled when `ai.fire` / `ai.smoke` capabilities are present.
- **CameraView overlay**: fire = orange-red bbox, smoke = gray bbox.
- **Detection Panel**: fire/smoke items highlighted in respective colors.
- **Legend**: fire (orange) and smoke (gray) entries added.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime (`onnxruntime-node`) |
| Model file | `server/models/yolov8s_fire_smoke.onnx` (43 MB) |
| Model source | Abonia1/YOLOv8-Fire-and-Smoke-Detection (GitHub) |
| Model output shape | `[1, 7, 8400]` (3-class YOLOv8) |
| Input resolution | 640×640 px letterboxed |
| Confidence threshold | > 0.35 |
| NMS IoU threshold | > 0.45 |
| Processing speed | ≥ 10 FPS on CPU (640×640 input) |
| Detection latency | ≤ 200 ms (JPEG received → event emitted) |
| Pipeline overhead | ≤ 50 ms additional latency on existing pipeline |
| Model size | 43 MB (≤ 100 MB requirement met) |
| mAP@0.5 target | ≥ 0.80 on D-Fire benchmark |
| False positive rate | ≤ 5% (excluding lighting changes / sunlight) |
| Min fire size | bbox ≥ 32×32 px |
| Alert cooldown | 10 s per zone per class |

---

## 6. Input / Output Contract

**Input:**
- JPEG frame buffer from RTSP pipeline.
- Original frame dimensions (`origW`, `origH`) for coordinate scaling.

**FireSmokeService interface:**
```javascript
class FireSmokeService {
  async load()                         // Load model (graceful skip if file missing)
  get ready()                          // → boolean
  async detect(jpegBuf, origW, origH)  // → [{className, confidence, bbox}]
}
```

**Output detection objects:**
```json
[
  { "className": "fire",  "confidence": 0.87, "bbox": { "x": 200, "y": 100, "width": 80, "height": 60 } },
  { "className": "smoke", "confidence": 0.71, "bbox": { "x": 150, "y": 80,  "width": 120, "height": 90 } }
]
```

**Socket.IO `fire:alert` event:**
```json
{
  "cameraId": "cam-uuid",
  "className": "fire",
  "confidence": 0.87,
  "zone": "Warehouse Zone A",
  "timestamp": 1715000000000
}
```

**Capabilities endpoint additions:**
```json
{ "ai": { "fire": true, "smoke": true } }
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Model load | Server startup log contains `[FireSmokeService] yolov8s_fire_smoke.onnx loaded` |
| AC-02 | Fire detection functional | Play fire video clip → `fire:alert` event received within 10 s |
| AC-03 | mAP@0.5 accuracy | ≥ 0.80 on D-Fire test set |
| AC-04 | Processing speed | CPU-only 640×640 inference runs at ≥ 10 FPS |
| AC-05 | False positive rate | FPR ≤ 5% over 24-hour general indoor/outdoor video |
| AC-06 | Pipeline integration | Simultaneous loitering detection pipeline delay ≤ 50 ms |
| AC-07 | `default` class suppressed | No detections with `className === 'default'` appear in any output |
| AC-08 | Alert deduplication | Same zone same class produces at most 1 alert per 10-second window |
| AC-09 | Visual overlay | Fire bounding box rendered in orange-red; smoke in dark gray on CameraView canvas |
| AC-10 | Zone filter | If zone does not include `"fire"` in `targetClasses`, no `fire:alert` is emitted for that zone |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | `fireSmokeService.js` implementation + model installed | 2026-05-18 | 2026-05-18 | ✅ Complete |
| M2 | Functional test: fire video → alert within 10 s | TBD | - | ⏳ Pending |
| M3 | Precision benchmark on D-Fire test set (mAP@0.5 ≥ 0.80) | TBD | - | ⏳ Pending |
| M4 | False positive validation: 24-hour general video FPR ≤ 5% | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Run functional test: play fire/smoke video clip, verify `fire:alert` Socket.IO event within 10 s
- [ ] Run D-Fire benchmark inference — measure mAP@0.5 and compare against ≥ 0.80 target
- [ ] Run 24-hour false positive test on general indoor/outdoor surveillance footage
- [ ] Run performance test: measure FPS on target CPU hardware (Intel Core i7)
- [ ] Run pipeline integration test: verify total added latency ≤ 50 ms
- [ ] Add fire/smoke checkboxes to Zone Editor UI (enabled only when `ai.fire`/`ai.smoke` capabilities present)
- [ ] Add fire/smoke entries to CameraView legend (orange and gray color squares)
- [ ] Verify alert deduplication: same zone same class limited to 1 alert per 10 s
- [ ] Evaluate TommyNgx/YOLOv10-Fire-and-Smoke-Detection (~30 MB) as a lighter alternative model

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for AI Fire Smoke Detection |
