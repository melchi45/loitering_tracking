# RFP AI-09: Fire & Smoke Detection

**Document ID**: LTS-2026-AI-09  
**Version**: 1.1  
**Date**: 2026-05-15  
**Revised**: 2026-05-18  
**Status**: ✅ Implemented (yolov8s_fire_smoke.onnx installed)

---

## 1. Overview

### 1.1 Purpose

An AI module that detects fire and smoke in real time from CCTV video and issues early alerts. Adds safety event detection to the existing Loitering Detection System (LTS).

### 1.2 Application Scenarios

| Category | Scenario | Priority |
|---|---|:---:|
| Indoor | Early fire detection in server rooms, warehouses, factory lines | ★★★ |
| Outdoor | Fire detection in parking lots, open storage, logistics centers | ★★★ |
| Forest Adjacent | Early smoke detection for wildfires | ★★ |
| Kitchen/Cooking Facility | Distinguish cooking smoke from fire smoke | ★★ |

### 1.3 Expected Benefits

- Early detection within **30 seconds** of fire occurrence (reduces time by 5+ minutes compared to sprinkler systems)
- Detection based on flame light characteristics even in night/low-light environments
- Reuses existing CCTV infrastructure (no additional sensors required)

---

## 2. Technical Requirements

### 2.1 Functional Requirements

| ID | Requirement | Level |
|---|---|---|
| FS-01 | YOLOv8-based real-time fire / smoke bbox detection | Required |
| FS-02 | Restrict monitoring area via Zone configuration | Required |
| FS-03 | Immediately emit `fire:alert` Socket.IO event upon detection | Required |
| FS-04 | Configurable detection confidence threshold | Required |
| FS-05 | Display fire/smoke bbox on camera view overlay | Required |
| FS-06 | Display fire/smoke detection items in left Detection panel | Required |
| FS-07 | Operate in night/low-light conditions | Recommended |
| FS-08 | Distinguish smoke from steam | Recommended |

### 2.2 Performance Requirements

| Metric | Target | Notes |
|---|---|---|
| mAP@0.5 | ≥ 0.80 | D-Fire benchmark |
| Processing speed | ≥ 10 FPS (CPU) | 640×640 input |
| Detection latency | ≤ 200ms | JPEG received → event triggered |
| False positive (FPR) | ≤ 5% | Excluding lighting changes / sunlight |
| Fire size | bbox ≥ 32×32px | Including early stage fires |

### 2.3 Non-Functional Requirements

- Model format: ONNX (onnxruntime-node CPU/CUDA compatible)
- Model size: ≤ 100MB (minimize server load)
- Server impact: additional latency to existing pipeline ≤ 50ms
- Operates independently from existing loitering detection

---

## 3. Model Architecture

### 3.1 Selected Model: YOLOv8s Fire & Smoke Detection

```
Input: JPEG frame (640×640 letterbox preprocessing)
Model: YOLOv8s (small) — 3-class fine-tuned
Source: github.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection
      (runs/detect/train/weights/best.pt → ONNX export)
File: server/models/yolov8s_fire_smoke.onnx  (43MB)
Output: [1, 7, 8400]  (4 bbox coords + 3 class scores × 8400 anchors)
Classes: Fire=0, default=1 (skip), smoke=2
```

### 3.2 Post-processing Pipeline

```
JPEG Buffer
    │
    ▼ sharp preprocessing
  640×640 letterbox (fill=gray114, normalize /255)
    │
    ▼ ONNX inference
  [1, 7, 8400] raw output
    │
    ▼ Post-processing
  confidence filtering (>0.35)
  remove 'default' class (classIdx=1 skip)
  lowercase normalization ('Fire' → 'fire')
  NMS (IoU>0.45)
    │
    ▼
  [{className:'fire'|'smoke', confidence, bbox(frame coords)}]
```

### 3.3 Class Definitions

| Index | Original Class | Internal Mapping | Description | Display Color |
|:---:|---|---|---|---|
| 0 | `Fire` | `fire` | Flames (fire) | 🔴 Orange-red `rgba(255,80,0)` |
| 1 | `default` | *(skip)* | Unclassified — excluded in post-processing | — |
| 2 | `smoke` | `smoke` | Smoke (gray, black smoke) | ⬜ Dark gray `rgba(75,85,99)` |

---

## 4. Public Model Sources

### 4.1 Models Used (current installation)

| Rank | Model | Source | ONNX Size | Classes | Notes |
|:---:|---|---|---|---|---|
| ✅ **Selected** | YOLOv8s fire/smoke | Abonia1/YOLOv8-Fire-and-Smoke-Detection (GitHub) | 43MB | Fire, default, smoke | **Currently installed** |
| — | YOLOv8m fire/smoke | keremberke/yolov8m-fire-and-smoke-detection (HuggingFace) | ~52MB | fire, smoke | Repository private, download unavailable |
| — | YOLOv10 fire/smoke | TommyNgx/YOLOv10-Fire-and-Smoke-Detection (HuggingFace) | ~30MB | fire, smoke | Alternative candidate |

> **Note**: The `keremberke` HuggingFace repository has been set to private (401 Unauthorized). Applied by converting the trained weights (`runs/detect/train/weights/best.pt`) from the `Abonia1` GitHub repository to ONNX.

### 4.2 Training Datasets

| Dataset | Size | Link |
|---|---|---|
| D-Fire | 21,000+ images (fire/smoke/no-event) | GitHub: gaiasd/DFireDataset |
| VisiFire | Mixed indoor/outdoor fire video | VisiFire.net |
| Foggia et al. | Outdoor/indoor fire video | Academic dataset |

---

## 5. Implementation Plan

### 5.1 Server — FireSmokeService

**File**: `server/src/services/fireSmokeService.js`

```javascript
// Core interface
class FireSmokeService {
  async load()                         // Load model (graceful skip if file missing)
  get ready()                          // → boolean
  async detect(jpegBuf, origW, origH)  // → [{className, confidence, bbox}]
}
```

**Pipeline integration point** (`pipelineManager.js`):
```
1. Receive JPEG frame
2. Primary Detection (YOLOv8n COCO — person/vehicle)
3. ByteTracker → tracked objects
4. BehaviorEngine → loitering analysis
5. AttributePipeline → face/mask/hat/color enrichment
6. ▶ FireSmokeService.detect() ← added here (full-frame, independent execution)
7. Merge results → add fire/smoke bbox to detections array
8. Zone intersection check → fire:alert event triggered
9. Emit detections socket
```

### 5.2 Fire Alert Event

```javascript
// Socket.IO event: 'fire:alert'
{
  cameraId:   "uuid",
  className:  "fire" | "smoke",
  confidence: 0.87,
  zone:       "Zone A",
  timestamp:  1715000000000
}
```

### 5.3 Client

- **Zone Editor**: Add fire / smoke checkboxes (enabled when model exists)
- **CameraView overlay**: fire=orange-red bbox, smoke=gray bbox + background overlay
- **FullscreenView DetectionPanel**: fire/smoke items highlighted in red/gray
- **Legend**: ■ fire (orange), ■ smoke (gray) added

### 5.4 Model Installation Procedure (Complete)

Currently `server/models/yolov8s_fire_smoke.onnx` (43MB) is installed.

If reinstallation is needed, run the script below (requires Python 3.7+, ultralytics):

```bash
# 1. Download trained weights from GitHub
wget --no-check-certificate \
  "https://raw.githubusercontent.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection/main/runs/detect/train/weights/best.pt" \
  -O /tmp/fire_smoke_best.pt

# 2. Convert to ONNX (Python 3.7 + ultralytics 8.x)
python3 << 'PYEOF'
from ultralytics import YOLO
import shutil

model = YOLO('/tmp/fire_smoke_best.pt')
# Classes: {0: 'Fire', 1: 'default', 2: 'smoke'}
exported = model.export(format='onnx', imgsz=640, simplify=True)
shutil.copy(exported, 'server/models/yolov8s_fire_smoke.onnx')
print("Saved: server/models/yolov8s_fire_smoke.onnx")
PYEOF
```

> **Note**: Since the model output is `[1, 7, 8400]` (3-class), `fireSmokeService.js` must have `CLASS_NAMES = ['fire', 'default', 'smoke']` and `SKIP_CLASSES` aligned.

---

## 6. Endpoints and Events

### 6.1 Existing Endpoint Changes

| Endpoint | Change |
|---|---|
| `GET /api/capabilities` | Added `ai.fire`, `ai.smoke` fields |
| `GET /health` | No change |

### 6.2 New Socket.IO Events

| Event | Direction | Payload |
|---|---|---|
| `fire:alert` | Server→Client | `{cameraId, className, confidence, zone, timestamp}` |

---

## 7. Performance Optimization

| Optimization | Method |
|---|---|
| Frame skip | Same frame-drop processing as existing `_inferring` guard |
| Zone filtering | Skip detection if fire/smoke not in `targetClasses` |
| Model size | YOLOv8s 43MB (ONNX installed) |
| Alert cooldown | Alerts for same zone same class limited to 10-second intervals (deduplication) |
| Default class skip | classIdx=1 excluded in post-processing — suppresses unnecessary detections |

---

## 8. Implementation History

| Date | Description |
|---|---|
| 2026-05-18 | `fireSmokeService.js` implementation complete |
| 2026-05-18 | `yolov8s_fire_smoke.onnx` (43MB) installed — Abonia1/GitHub |
| 2026-05-18 | 3-class model support: added `CLASS_NAMES`, `SKIP_CLASSES`, `NORMALISE` |
| 2026-05-18 | Confirmed `[FireSmokeService] yolov8s_fire_smoke.onnx loaded` after server restart |

## 9. Test Plan

| Test | Method | Pass Criteria | Status |
|---|---|---|:---:|
| Model load | Check server startup log | `loaded` message output | ✅ |
| Functional | Play fire video → verify fire:alert | Alert within 10 seconds | 🔲 |
| Precision | D-Fire test set inference | mAP@0.5 ≥ 0.80 | 🔲 |
| Performance | CPU-only 640×640 inference speed | ≥ 10 FPS | 🔲 |
| False positive | 24-hour general indoor/outdoor video | FPR ≤ 5% | 🔲 |
| Integration | Simultaneous operation with loitering detection | Pipeline delay ≤ 50ms | 🔲 |

---

## 9. Related Documents

- [README.md — 7.1 Available AI Modules](README.md#71-available-ai-modules-per-zone)
- [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) — AI-01
- [RFP_AI_Vehicle_Detection.md](RFP_AI_Vehicle_Detection.md) — AI-02
- [server/src/services/fireSmokeService.js](server/src/services/fireSmokeService.js)
- [server/src/services/pipelineManager.js](server/src/services/pipelineManager.js)

---

*This document is part of the LTS (Loitering Tracking System) AI module RFP series.*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for AI Fire Smoke Detection |
