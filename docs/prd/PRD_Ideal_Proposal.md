# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Adaptive Multi-Feature Loitering Detection System

| | |
|---|---|
| **Document ID** | PRD-LTS-005 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Ideal_Proposal.md |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

Build an AI-based Adaptive Multi-Feature Loitering Detection System that combines real-time person detection, human segmentation, appearance Re-ID, semantic attribute detection, and adaptive Kalman filtering to produce a highly accurate, low-false-alarm system capable of identifying loiterers, long-term dwellers, and repeated-visit patterns from RTSP video streams.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Detect persons in real time from RTSP streams at 15–30 FPS supporting multiple concurrent channels.
- **G2**: Segment detected persons to isolate the actual body region from the background, enabling robust clothing and accessory analysis even under partial occlusion.
- **G3**: Extract a 512-dimensional appearance embedding per person and store semantic attributes (upper/lower color, hat, bag, accessories) for stable Re-ID.
- **G4**: Apply an adaptive Kalman Filter with dynamically adjusted process noise based on motion state, appearance confidence, and occlusion status.
- **G5**: Use multi-cue association (IoU + appearance + clothing + mask + temporal consistency) to minimize ID switches during tracking.
- **G6**: Classify loitering behavior using multi-condition logic: zone dwell time, revisit count, low-velocity pattern, and circular/repetitive motion.

### 2.2 Non-Goals

- **NG1**: Real-time human segmentation via SAM or Mask2Former in the current Node.js/ONNX architecture — these models require ~500 ms/frame on CPU and block 10 FPS throughput. A GPU-based NanoSAM path is a future Phase 3 item.
- **NG2**: Python AI worker microservice — the current ONNX Runtime Node.js binding is sufficient for the targeted throughput without a separate IPC process.
- **NG3**: PostgreSQL + Redis + Milvus infrastructure — over-engineered for ≤ 16 cameras; SQLite is the current target with a documented upgrade path.
- **NG4**: Body-level Re-ID using FastReID or TorchReID — requires PyTorch Python-only libraries; ArcFace via ONNX covers face-based Re-ID for the current scope.

---

## 3. User Personas

### Persona 1 — Security Operator
Monitors live multi-camera feeds. Needs reliable loitering alerts with low false-alarm rates so they can focus on genuine threats rather than dismissing spurious notifications.

### Persona 2 — Security System Designer / Integrator
Evaluates the system for deployment in complex real-world environments (shopping malls, transit hubs, parking lots). Needs documented performance benchmarks, configurable thresholds, and an extensible architecture that supports future AI model upgrades.

### Persona 3 — AI/ML Engineer
Maintains and improves the detection and Re-ID models. Needs a modular pipeline where each stage (detection, segmentation, Re-ID, behavior analysis) can be independently updated or replaced.

---

## 4. Functional Specification

### 4.1 Person Detection

- Real-time detection from RTSP streams (H.264/H.265).
- Multi-person support within a single frame.
- Minimum 15 FPS processing throughput per channel.
- Recommended models: YOLOv11, RT-DETR, YOLO-NAS (current implementation: YOLOv8n ONNX).
- Output: bounding box `[x1, y1, x2, y2]` with confidence score.

### 4.2 Human Segmentation

- Generate a per-person segmentation mask within the detection bounding box.
- Enables background removal, clothing region isolation, and partial occlusion handling.
- Recommended models: YOLO-Seg, SAM, Mask2Former.
- Output: binary person mask per detection.
- Current status: deferred (bbox ROI used as fallback); NanoSAM on GPU is planned for Phase 3.

### 4.3 Appearance Feature Extraction

- Extract a 512-dimensional embedding vector from each detected person.
- Attributes to capture:
  - Upper body color (HSV dominant, 11 classes)
  - Lower body color (HSV dominant, 11 classes)
  - Pattern (solid / striped / other)
  - Bag / backpack presence
  - Hat presence and type
  - Other accessories

### 4.4 Semantic Attribute Detection

- Store appearance information as structured semantic metadata alongside the embedding:

```json
{
  "upper_color": "red",
  "lower_color": "black",
  "bag": true,
  "hat": false
}
```

- Improves Re-ID accuracy and system explainability; robust to lighting changes.

### 4.5 Kalman Motion Tracking

- State vector: `[x, y, w, h, vx, vy]` (6-dimensional; 8-dimensional in current implementation).
- Functions: position prediction, missed-detection compensation, movement smoothing, ID continuity maintenance.

### 4.6 Adaptive Kalman Filter

Dynamic adjustment of process noise based on runtime conditions:

| Condition | Adjustment |
|---|---|
| Fast acceleration detected | Increase process noise Q |
| Object stationary | Decrease process noise Q |
| Appearance matching confidence low | Increase covariance (higher uncertainty) |
| Occlusion detected | Increase prediction weight, decrease measurement weight |

All thresholds runtime-configurable via `/api/tracker/config`.

### 4.7 Multi-Cue Association

Association score between each detection and each active track combines:

```
Score = 0.4 × IoU
      + 0.4 × Appearance similarity
      + 0.2 × Semantic attribute match (cloth + mask + accessories)
```

- Minimizes ID switches during brief occlusion or overlap.
- Falls back to pure IoU when appearance embedding is unavailable.
- Cross-class pairs hard-rejected (score = −1).

### 4.8 Loitering Detection Logic

Multi-condition behavioral analysis:

| Condition | Description |
|---|---|
| Zone dwell time | Duration of continuous presence within a defined zone |
| Revisit count | Number of repeated entries to the same zone |
| Low-velocity pattern | Sustained low movement speed |
| Circular motion pattern | Repetitive loop or pacing trajectory |

Alert output example:
```json
{
  "event":      "loitering",
  "track_id":   15,
  "zone":       "A1",
  "dwell_time": 240,
  "risk_score": 0.84
}
```

Track state stored per subject:
```json
{
  "track_id":   101,
  "timestamp":  1710000000,
  "bbox":       [x1, y1, x2, y2],
  "embedding":  [],
  "cloth_color": "black",
  "bag":        true,
  "zone":       "A",
  "dwell_time": 122
}
```

### 4.9 Additional Features

- **Heatmap visualization**: display dwell-time hotspots as a canvas overlay per camera.
- **Cross-camera Re-ID**: track the same person across multiple cameras using the shared ArcFace gallery.
- **Suspicious score**: numeric risk score (0.0–1.0) surfaced per tracked object per zone.

---

## 5. Technical Requirements

### 5.1 Recommended Technology Stack

| Layer | Technology |
|---|---|
| Detection | Ultralytics YOLO, RT-DETR |
| Segmentation | SAM, Mask2Former (Phase 3) |
| Tracking | ByteTrack, DeepSORT, OC-SORT |
| Re-ID | ArcFace (ONNX, current); FastReID / TorchReID (Phase 3) |
| Backend | Node.js; Python AI Worker (Phase 3) |
| Streaming | FFmpeg, GStreamer |
| Database | SQLite (current) → PostgreSQL + Redis + Milvus/Qdrant (scale-out) |

### 5.2 Performance Goals

| Item | Target |
|---|---|
| Detection FPS | 15–30 FPS per channel |
| Tracking accuracy (MOTA) | > 0.75 |
| Re-ID accuracy | > 85% |
| False alarm rate | < 10% |
| Multi-person tracking | Supported (≥ 16 simultaneous channels) |

### 5.3 Input Specifications

| Property | Requirement |
|---|---|
| Protocol | RTSP stream |
| Codec | H.264 / H.265 |
| Channels | Multi-channel concurrent support |
| Resolution | Up to 4K; AI inference downscaled to 640 px width |

### 5.4 Implementation Phases

| Phase | Content |
|---|---|
| Phase 1 | YOLO + ByteTrack — basic detection and tracking |
| Phase 2 | Add appearance embedding (ArcFace via ONNX) |
| Phase 3 | Add clothing / accessory semantic attribute detection |
| Phase 4 | Apply adaptive Kalman Filter with motion-based dynamic Q |
| Phase 5 | Add behavior analysis (loitering logic, risk scoring) |

---

## 6. API / Interface Contract

### 6.1 Loitering Alert Event (Socket.IO)

```json
{
  "event":      "loitering",
  "track_id":   15,
  "zone":       "A1",
  "dwell_time": 240,
  "risk_score": 0.84
}
```

### 6.2 Track State Record

```json
{
  "track_id":    101,
  "timestamp":   1710000000,
  "bbox":        [x1, y1, x2, y2],
  "embedding":   [],
  "cloth_color": "black",
  "bag":         true,
  "zone":        "A",
  "dwell_time":  122
}
```

### 6.3 Detection Output

```json
{
  "bbox":       [x1, y1, x2, y2],
  "confidence": 0.95
}
```

### 6.4 Tracker Configuration REST API

```
GET  /api/tracker/config         — retrieve current adaptive KF parameters
PUT  /api/tracker/config         — update parameters (partial update supported)
POST /api/tracker/config/reset   — restore factory defaults
```

### 6.5 Zone Configuration Schema

```json
{
  "zoneId":         "zone-uuid",
  "name":           "Zone A1",
  "polygon":        [{"x": 100, "y": 150}, ...],
  "dwellThreshold": 30,
  "minRiskScore":   0.5,
  "targetClasses":  ["human"]
}
```

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | Person detection runs at ≥ 15 FPS per channel on target hardware. |
| AC-02 | Tracking MOTA > 0.75 measured on a representative video dataset. |
| AC-03 | Re-ID accuracy > 85% for appearance-based person matching across occlusion events. |
| AC-04 | False loitering alarm rate < 10% over a representative test video set. |
| AC-05 | Adaptive Kalman Filter correctly increases Q for fast-moving objects and decreases Q for stationary objects. |
| AC-06 | Loitering alert fires correctly for each of the four conditions: dwell time, revisit count, low velocity, and circular motion. |
| AC-07 | Multi-cue association score uses all available cues (IoU + appearance + semantic attributes); degrades gracefully when cues are absent. |
| AC-08 | System supports ≥ 16 concurrent RTSP camera channels without frame drops exceeding 10%. |
| AC-09 | Heatmap visualization renders correctly in the dashboard for active camera feeds. |
| AC-10 | Cross-camera Re-ID correctly links the same person across at least 2 cameras in a controlled test scenario. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase 1 — YOLO detection + ByteTrack basic tracking | TBD | May 2026 | ✅ Done |
| M2 | Phase 2 — ArcFace 512-dim appearance embedding integration | TBD | May 2026 | ✅ Done |
| M3 | Phase 3 — Semantic attribute detection (cloth, hat, bag, accessories) | TBD | May 2026 | ✅ Done |
| M4 | Phase 4 — Adaptive Kalman Filter (motion-based dynamic Q/R) | TBD | May 2026 | ✅ Done |
| M5 | Phase 5 — Multi-condition loitering logic + composite risk score | TBD | May 2026 | ✅ Done |
| M6 | Human segmentation mask (NanoSAM on GPU) | TBD | - | ⏳ Pending |
| M7 | Body-level Re-ID (FastReID / TorchReID) | TBD | - | ⏳ Pending |
| M8 | Heatmap visualization canvas overlay | TBD | - | ⏳ Pending |
| M9 | Full benchmark evaluation (MOTA, Re-ID accuracy, false alarm rate) | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement human segmentation mask generation (YOLO-Seg as first step; NanoSAM GPU as Phase 3 target)
- [ ] Implement body-level Re-ID embedding extraction using FastReID or TorchReID via a Python worker
- [ ] Implement heatmap visualization canvas overlay at `/api/cameras/:id/heatmap`
- [ ] Implement crowd density filtering to adjust loitering sensitivity in dense scenes
- [ ] Evaluate MOTA on a representative multi-person video dataset and document results
- [ ] Evaluate Re-ID accuracy (> 85% target) on occlusion test sequences
- [ ] Measure false alarm rate (< 10% target) on a representative loitering test set
- [ ] Implement pattern detection for clothing (solid / striped / other)
- [ ] Add temporal consistency cue to multi-cue association score
- [ ] Evaluate NanoSAM inference latency on target GPU hardware for real-time feasibility
- [ ] Document upgrade path from SQLite to PostgreSQL + Redis + Milvus for large-scale deployments
- [ ] Write model cards for all ONNX models used: training data, known limitations, benchmark results

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Ideal Proposal |
