# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Object Tracking — Stable Multi-Object ID & Loitering Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-002 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Object_Tracking.md |

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

Provide a numerically stable, class-aware multi-object tracker that maintains consistent object IDs across video frames — eliminating dwell-timer resets caused by ID switches — so that loitering detection reliably fires for any subject who exceeds the configured zone dwell threshold, regardless of brief occlusion or detector jitter.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Implement a ByteTrack tracker with an 8-dimensional Kalman Filter that is fully immune to NaN/Infinity propagation under all operating conditions.
- **G2**: Expand the detection pipeline to support all 80 COCO object classes, with class-level filtering delegated entirely to the analytics configuration layer.
- **G3**: Provide appearance-based (ArcFace) multi-cue association to maintain object IDs through brief occlusion without requiring body-level Re-ID.
- **G4**: Implement cross-ID state transfer in the BehaviorEngine so accumulated loitering dwell time is preserved when a tracker reassigns a new ID to a known subject.
- **G5**: Replace broken RGB-range color matching with HSV-based color classification.
- **G6**: Expose all Kalman Filter parameters via a runtime REST API so operators can tune tracker behavior without server restart.

### 2.2 Non-Goals

- **NG1**: Body-level Re-ID (FastReID/TorchReID) — requires a Python worker; deferred to a future phase.
- **NG2**: Multi-server or Redis-based shared embedding store — single-server in-process gallery is sufficient for ≤ 16 cameras.
- **NG3**: GPU-accelerated TensorRT inference — current ONNX Runtime CPU pipeline meets throughput targets.
- **NG4**: Full HOTA/MOTA benchmark toolchain integration — planned for QA phase but not required for core tracker delivery.

---

## 3. User Personas

### Persona 1 — Security Operator
Monitors live camera feeds and expects reliable loitering alerts. The operator should never see an alert fail because the tracker repeatedly reset the timer for the same person.

### Persona 2 — System Integrator / Developer
Tunes tracker parameters for specific deployment environments (indoor retail, parking lot, corridor). Needs runtime-configurable Kalman Filter parameters and a clear API contract.

### Persona 3 — QA / Validation Engineer
Validates tracker accuracy against benchmark datasets (MOT17) and regression test suites. Needs deterministic, testable pipeline components with clear input/output contracts.

---

## 4. Functional Specification

### 4.1 Detection Pipeline

- YOLOv8n ONNX inference with letterbox pre-processing (INPUT_SIZE=640).
- All 80 COCO class IDs included in `ENABLED_CLASSES`; class-level on/off delegated to `analyticsConfig.isClassEnabled()`.
- Confidence threshold: 0.30 (default); NMS IoU threshold: 0.50.
- Per-detection `color` field (fast pixel-average HSV, ~0.5 ms/person) computed before tracker update.

### 4.2 ByteTracker Core

- **8-dimensional state vector**: `[x, y, w, h, vx, vy, vw, vh]`.
- **Transition matrix F**: constant-velocity model (`position += velocity × dt`).
- **Observation matrix H**: `[I₄ | 0₄]`.
- **Initial covariance P₀**: `10 · I₈`.
- **Measurement noise R**: `measurementNoise · I₄` (default 10.0, runtime-adjustable).
- **`maxAge`**: 90 frames (9 s at 10 FPS); tracks exceeding maxAge are removed.
- **`minHits`**: 1 (track returned to pipeline after first confirmed match).

### 4.3 Adaptive Process Noise Q

| Motion State | Condition | Q Scale |
|---|---|---|
| Stationary | speed < 5 px/frame | 0.5× |
| Normal | 5 ≤ speed ≤ 30 px/frame | 1.0× |
| Fast | speed > 30 px/frame | 4.0× |
| Occlusion | `framesWithoutHit` > 1 | bbox frozen (predict skipped) |

### 4.4 Kalman Filter Numerical Stability

- **Predict freeze**: when `framesWithoutHit > 1`, KF predict is skipped and bbox held constant to prevent P-matrix covariance blowup.
- **Update NaN guard**: if the corrected KF output contains NaN or Infinity, fall back to the YOLO detection bbox and reset the P matrix (`P = 10 · I₈`).
- **IoU non-finite guard**: `_iou()` returns 0 for any non-finite input rather than propagating NaN.
- Root cause addressed: JavaScript's `Math.max(0, NaN) = NaN` behavior is explicitly guarded at every bbox assignment.

### 4.5 Two-Stage Hungarian Assignment

| Stage | Detection Set | Track Set | Score Threshold |
|---|---|---|---|
| Step 1 | High-confidence (≥ conf threshold) | All active tracks | 0.25 (multi-cue) |
| Step 2 | Low-confidence (below threshold) | Unmatched Lost tracks | 0.50 (IoU-only) |
| Step 3 | Unmatched high-conf | — | Create new tracks |
| Step 4 | Still-unmatched tracks | — | Increment `framesWithoutHit` |

### 4.6 Multi-Cue Association Score

```
score(det_i, track_j) = λ_iou × IoU + λ_app × IoU × appConf
```

- `λ_iou = 0.70`, `λ_app = 0.30` (defaults; runtime-adjustable).
- Class mismatch → score = −1 (hard reject).
- No face embedding available → pure IoU fallback.

### 4.7 ArcFace Embedding — EMA Update

```
track.embedding = 0.9 × track.embedding + 0.1 × new_embedding
```

Embedding feedback from `AttributePipeline` is applied after enrichment, providing stable per-track identity across frames.

### 4.8 Cross-ID State Transfer

When a new tracker ID enters a zone and matches a prior entry in the zone appearance gallery (ArcFace cosine ≥ 0.45 primary, clothing color fallback), all accumulated loitering state (dwell time, trajectory, revisit count) is transferred to the new ID and the old entry is removed.

Same-frame entries are excluded from gallery matching to prevent false-positive transfers.

### 4.9 Loitering Detection Logic

- **Dwell condition**: `dwellTime ≥ dwellThreshold` AND `10s-window maxDisplacement < minDisplacement`.
- **Pacing score**: x-direction reversal count, saturates at 10 reversals → score 1.0.
- **Circular motion score**: `max(0, 1 − straightLineDisplacement / totalPathLength)`.
- **Composite risk score** (5 factors, weights sum to 1.0): dwell 35%, revisit 30%, low-velocity 15%, pacing 12%, circular 8%.
- Per-zone `minRiskScore` gate: alert suppressed if risk score < threshold.

### 4.10 HSV Color Classification

- Saturation < 0.15 → achromatic branch (black/white/gray by brightness).
- Hue 10°–50°, value < 0.55 → brown.
- Otherwise → hue-angle lookup: red/orange/yellow/green/cyan/blue/purple.
- Replaces prior RGB range matching which misclassified mid-saturation colors.

### 4.11 Pipeline Order

```
Detection → Fast Color Extraction → ByteTracker → Attribute Enrichment → BehaviorEngine → Emission
```

Attribute enrichment (face embedding, PPE, clothing) runs before BehaviorEngine so all attributes are available during risk scoring.

---

## 5. Technical Requirements

### 5.1 Runtime & Stack

| Component | Technology |
|---|---|
| Server runtime | Node.js |
| Inference | ONNX Runtime (Node.js binding) |
| Models | YOLOv8n COCO, SCRFD-2.5G, ArcFace ResNet-50, YOLOv8m PPE |
| API layer | Express + Socket.IO |
| Config persistence | `storage/tracker.json` (JSON flat file) |

### 5.2 Performance Requirements

| KPI | Minimum | Target |
|---|---|---|
| Object ID stability (continuous view) | ≥ 95% frames same ID | ≥ 99% frames same ID |
| Object ID recovery after occlusion (< 9 s) | ≥ 80% same ID restored | ≥ 95% same ID restored |
| Detection precision @ conf 0.30 | ≥ 85% | ≥ 92% |
| False loitering alert rate | ≤ 10% | ≤ 5% |
| Loitering recall | ≥ 80% | ≥ 90% |
| Frame throughput (CPU-only) | ≥ 10 FPS / channel | ≥ 15 FPS / channel |
| Concurrent camera channels (CPU-only) | ≥ 4 | ≥ 8 |
| End-to-end alert latency | ≤ 3 s | ≤ 1 s |

### 5.3 Numerical Stability Requirements

- KF implementation must not propagate NaN or Infinity into the track bounding box under any operating condition.
- `_iou()` must return 0 (not throw) for non-finite inputs.
- Predict-freeze mechanism must bound accumulated floating-point error in the P matrix for Lost tracks.

### 5.4 Key Source Files

| Functionality | File |
|---|---|
| YOLO inference + COCO 80-class filter | `server/src/services/detection.js` |
| ByteTracker + 8-dim KF + NaN guards | `server/src/services/tracking.js` |
| Behavior analysis + loitering + cross-ID transfer | `server/src/services/behaviorEngine.js` |
| ArcFace / PPE / color enrichment pipeline | `server/src/services/attributePipeline.js` |
| HSV color classification | `server/src/services/colorClothService.js` |
| KF + association parameter persistence | `server/src/services/trackerConfig.js` |
| Frame pipeline orchestration | `server/src/services/pipelineManager.js` |
| Tracker REST API | `server/src/api/tracker.js` |
| Per-class analytics configuration | `server/src/services/analyticsConfig.js` |

---

## 6. API / Interface Contract

### 6.1 Tracker Configuration REST API

```
GET  /api/tracker/config         — retrieve current KF + association parameters
PUT  /api/tracker/config         — update one or more parameters (partial update)
POST /api/tracker/config/reset   — restore factory defaults
```

Changes take effect on the next processed frame without server restart.

### 6.2 Tracker Configuration Parameters

| Parameter | Default | Range | Description |
|---|---|---|---|
| `maxAge` | 90 | 10–300 | Lost track retention frames |
| `iouThreshold` | 0.25 | 0.1–0.9 | Minimum multi-cue score for association |
| `fastSpeedThreshold` | 30 | 5–100 | Speed (px/frame) above which fast Q scale applies |
| `fastQScale` | 4.0 | 1.0–10.0 | Process noise multiplier for fast motion |
| `slowSpeedThreshold` | 5 | 1–20 | Speed (px/frame) below which stationary Q scale applies |
| `slowQScale` | 0.5 | 0.1–1.0 | Process noise multiplier for stationary objects |
| `occlusionQScale` | 3.0 | 1.0–10.0 | Q multiplier when `framesWithoutHit` > 0 |
| `measurementNoise` | 10.0 | 1–50 | Diagonal of measurement noise matrix R |
| `iouWeight` | 0.70 | 0.0–1.0 | Spatial overlap weight |
| `appWeight` | 0.30 | 0.0–1.0 | Appearance weight |

### 6.3 Example PUT Body

```json
{
  "maxAge": 120,
  "iouThreshold": 0.20,
  "measurementNoise": 8.0
}
```

### 6.4 Additional Existing API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET/POST` | `/api/zones` | Zone CRUD |
| `GET` | `/api/events` | Loitering event history |
| `GET` | `/api/cameras` | Discovered camera list |
| `WebSocket /` | Socket.IO | Real-time frame annotation stream |

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | Active track count does not grow unboundedly (no `bestIou=NaN` log entries) when a camera stream is running. |
| AC-02 | A person occluded for fewer than 9 seconds re-emerges with the same tracker ID ≥ 80% of the time. |
| AC-03 | All 80 COCO class IDs are detectable; enabling a class via `analyticsConfig` takes effect on the next frame without restart. |
| AC-04 | RGB(170, 151, 112) is classified as `orange` (not `gray`) using HSV color classification. |
| AC-05 | A person who paces back and forth within a zone for the configured dwell threshold triggers a loitering alert. |
| AC-06 | Cross-ID state transfer preserves accumulated dwell time when a subject re-enters a zone with a new tracker ID. |
| AC-07 | `PUT /api/tracker/config` with a valid JSON body returns 200 and the updated config is applied on the next frame. |
| AC-08 | `POST /api/tracker/config/reset` restores all parameters to factory defaults. |
| AC-09 | Loitering alert precision ≥ 85% and recall ≥ 80% on the project's test video dataset. |
| AC-10 | No NaN or Infinity values appear in tracked object bounding boxes under normal operating conditions. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | YOLOv8n ONNX detection pipeline + 80-class COCO support | Apr 14, 2026 | Apr 14, 2026 | ✅ Done |
| M2 | ByteTracker 8-dim KF + adaptive Q + NaN guard | May 5, 2026 | May 5, 2026 | ✅ Done |
| M3 | Multi-cue association (ArcFace EMA + two-stage Hungarian) | May 12, 2026 | May 12, 2026 | ✅ Done |
| M4 | BehaviorEngine zone gallery + cross-ID state transfer | May 14, 2026 | May 14, 2026 | ✅ Done |
| M5 | Sliding-window displacement + pacing score + 5-factor risk score | May 16, 2026 | May 16, 2026 | ✅ Done |
| M6 | Attribute pipeline order fix + HSV color + runtime config API | May 19, 2026 | May 19, 2026 | ✅ Done |
| M7 | QA benchmarking (HOTA/MOTA/IDF1 on MOT17) + regression tests | Jun 9, 2026 | - | ⏳ Pending |
| M8 | OpenAPI documentation + KF tuning guide + model card | Jun 23, 2026 | - | ⏳ Pending |
| M9 | Production deployment + Docker Compose + Prometheus + SLA verification | Jun 30, 2026 | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement automated regression test suite for KF update, NaN guard, IoU computation, and association logic
- [ ] Run HOTA/MOTA/IDF1 evaluation on MOT17 benchmark dataset
- [ ] Profile per-channel frame throughput and identify bottlenecks beyond 8 concurrent channels
- [ ] Generate OpenAPI 3.0 documentation for tracker configuration API
- [ ] Write KF parameter tuning guide for common field scenarios (indoor retail, parking lot, corridor)
- [ ] Write model card for YOLOv8n COCO: training data, known detection limitations, benchmark results
- [ ] Write troubleshooting guide: NaN propagation diagnostics, ID instability root causes, KF parameter effects
- [ ] Package all services in Docker Compose with Prometheus metrics export
- [ ] Verify SLA (99.5% uptime) under sustained load testing

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Object Tracking |
