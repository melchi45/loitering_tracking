# REQUEST FOR PROPOSAL (RFP)
# Loitering Detection & Tracking System

| | |
|---|---|
| **RFP Reference** | LTS-2026-001 |
| **Issue Date** | May 14, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Technical Requirements](#2-technical-requirements)
3. [Software Architecture Requirements](#3-software-architecture-requirements)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
   - 2.6 [Per-Zone AI Attribute Detection](#26-per-zone-ai-attribute-detection)
6. [Project Milestones & Deliverables](#6-project-milestones--deliverables)
7. [Proposal Evaluation Criteria](#7-proposal-evaluation-criteria)
8. [Proposal Submission Requirements](#8-proposal-submission-requirements)
9. [Terms and Conditions](#9-terms-and-conditions)
10. [Appendix](#10-appendix)

---

## 1. Project Overview

### 1.1 Purpose

This Request for Proposal (RFP) seeks qualified vendors and development partners to design, develop, and deliver a robust AI-powered **Loitering Detection and Tracking System**. The system shall provide real-time detection, classification, and alerting for individuals exhibiting loitering behavior across monitored areas using computer vision and machine learning technologies.

### 1.2 Background

Security and surveillance environments increasingly demand intelligent, automated monitoring solutions that can reduce the cognitive burden on human operators. Traditional CCTV monitoring is reactive, expensive, and prone to human error. An AI-driven loitering detection system addresses these challenges by continuously analyzing video feeds and generating actionable alerts when anomalous dwell-time behavior is observed.

### 1.3 Scope of Work

The selected vendor shall deliver a complete end-to-end system including:

- Real-time video ingestion from IP cameras (RTSP/ONVIF)
- Multi-object detection and person tracking across frames
- Loitering behavior classification with configurable time thresholds
- Zone-based monitoring with geofencing support
- Alert generation and notification pipeline
- Management dashboard and reporting interface
- REST API for third-party integration
- Deployment support for edge devices and cloud infrastructure

---

## 2. Technical Requirements

### 2.1 Video Input & Ingestion

- Support RTSP, RTMP, HTTP(S), and local file/stream input
- Compatible with ONVIF-compliant IP cameras
- Multi-channel concurrent processing (minimum **16 channels** simultaneously)
- Resolution support: 720p, 1080p, 4K (up to 4096×2160)
- Frame rate handling: 15–30 FPS input; adaptive processing
- Hardware-accelerated decoding (NVIDIA NVDEC, Intel QSV, VA-API)

### 2.2 Object Detection

The system shall incorporate a state-of-the-art object detection pipeline meeting the following specifications:

| Metric | Minimum Requirement | Target Performance |
|---|---|---|
| Detection Model | YOLOv8 / RT-DETR | YOLOv9 / DINO |
| Person mAP@0.5 | >= 85% | >= 92% |
| Inference Latency | <= 50ms / frame | <= 25ms / frame |
| False Positive Rate | <= 5% | <= 2% |
| Occlusion Handling | Partial (>40% visible) | Heavy (>20% visible) |

#### 2.2.1 Inference Pre-processing

To ensure consistent inference performance regardless of source resolution, all frames are downscaled before being passed to the AI model:

- **Input downscaling**: Each frame is resized to **width = 640 px** (aspect ratio preserved; e.g., a 2560×1920 source becomes 640×480) before any AI inference.
- **Letterbox padding**: The downscaled frame is padded to a square **640×640** tensor (grey border) to satisfy fixed-size model input requirements.
- **Output coordinate remapping**: Bounding box coordinates produced by the model are inversely transformed — letterbox padding is removed and coordinates are scaled back to the original frame resolution — so that all reported positions are proportionally correct relative to the source video.
- **Selective inference gating**: Each AI module (person, vehicle, face, PPE, fire/smoke, etc.) can be individually enabled or disabled at runtime. When a module is disabled, the corresponding inference step is skipped entirely rather than filtered post-hoc, eliminating unnecessary GPU/CPU cycles. ✅ *Implemented*

### 2.3 Multi-Object Tracking (MOT)

- Support state-of-the-art tracking algorithms: **ByteTrack**, **StrongSORT**, **DeepSORT**, **BoT-SORT**
- Persistent ID assignment across frames with re-identification (Re-ID)
- Track lifecycle management: initiation, maintenance, occlusion recovery, termination
- Tracking accuracy: **HOTA >= 60**, **MOTA >= 70** on MOT17 benchmark
- Trajectory smoothing and prediction using Kalman Filter or similar
- **Class-aware association**: IoU matching constrained to same object class — prevents ID theft between vehicles and persons ✅ *Implemented*
- Cross-camera tracking support for overlapping FOV scenarios — face-based Re-ID implemented via shared ArcFace gallery (see §2.3.2); body-level Re-ID deferred to Phase 3

#### 2.3.1 Current Implementation Status

| Feature | Status | Notes |
|---|:---:|---|
| ByteTrack (IoU-based) | ✅ | `server/src/services/tracking.js` |
| Class-aware IoU matching | ✅ | Same class required for association |
| 8-dim Kalman Filter | ✅ | [x,y,w,h,vx,vy,vw,vh] state vector; connected to Track |
| Adaptive Kalman (dynamic Q/R) | ✅ | Implemented — velocity from kf.x[4/5], occlusion via framesWithoutHit |
| Multi-cue association (IoU + Face + Color + Cloth + Acc) | ✅ P2 | 5-cue dynamic-weight scorer; fast pre-tracking colour; λ_iou/face/color/cloth/acc via `/api/tracker/config` + UI |
| Cross-camera Re-ID | ✅ P3 | Shared in-process ArcFace gallery across all cameras — see §2.3.2 |

#### 2.3.2 Cross-Camera Re-ID Architecture

> **Status**: ✅ Fully implemented (in-process, single-server) — server: `server/src/services/pipelineManager.js`; client: `client/src/stores/crossCameraStore.ts`, `client/src/components/FullscreenCameraView.tsx`

**Problem**: The original design kept a separate face gallery per camera (`_faceGalleries: Map<cameraId, entries[]>`), making it impossible to recognise a person who moved between cameras.

**Solution — Option A: Shared In-Process Gallery**

The per-camera galleries have been replaced by a single `_sharedFaceGallery` array that is shared across all active camera pipelines in the same server process. Each gallery entry now carries a `lastCameraId` field:

```
_sharedFaceGallery: [
  { faceId, embedding, lastSeenAt, lastCameraId },
  ...
]
```

When `_assignFaceIds(cameraId, detectedFaces, timestamp)` finds a cosine-similarity match (threshold ≥ 0.35) for a face whose `lastCameraId` differs from the current `cameraId`, it:

1. Defers emission (stores the pending transition with `faceBbox` for objectId resolution).
2. The caller (`_processFrame`) matches the face bbox back to the enriched person track in `attrObjects` via `_bboxClose()` (±3 px tolerance), then emits `face:reidentified` to **all** connected clients with the resolved `newObjectId`:

   ```json
   {
     "faceId":       "F7",
     "prevCameraId": "<uuid-of-camera-A>",
     "newCameraId":  "<uuid-of-camera-B>",
     "newObjectId":  42,
     "similarity":   0.82,
     "timestamp":    1716015600000
   }
   ```

   `newObjectId` is the ByteTracker `objectId` of the person currently visible in camera B who was re-identified. `null` if the face could not be matched to a person track (e.g. YOLO missed the body).

3. Updates `lastCameraId` and `lastSeenAt` on the gallery entry.
4. Increments a per-face `transitionCount` in `_crossCameraStats`.

The returned face object also includes a `crossCamera: { prevCameraId }` field for the current frame's detection payload.

**Stats endpoint**: `GET /api/crosscamera/stats`

```json
{
  "totalTransitions": 3,
  "uniqueFaces": 2,
  "faces": [
    {
      "faceId": "F7",
      "firstCameraId": "<camera-A-uuid>",
      "lastCameraId":  "<camera-B-uuid>",
      "transitionCount": 2,
      "lastSeenAt": 1716015600000
    }
  ]
}
```

**Client-Side UI Components**

| Component | File | Description |
|---|---|---|
| `CrossCameraReIdEvent` type | `client/src/types/index.ts` | TypeScript interface for `face:reidentified` Socket.IO payload — includes optional `newObjectId: number \| null` |
| `useCrossCameraStore` | `client/src/stores/crossCameraStore.ts` | Zustand store; holds last 20 events, auto-expires after 60 s |
| Global Socket listener | `client/src/App.tsx` | Subscribes to `face:reidentified` on the singleton socket and dispatches to the store |
| Cross-Camera Re-ID feed | `client/src/components/FullscreenCameraView.tsx` | Displayed in the Detection panel footer (Detections tab) when at least one cross-camera event involves the current camera; shows `[faceId] CameraName → CameraName #objectId sim%` — `#objectId` is the tracker ID of the person in the destination camera (yellow, shown when `newObjectId` is present); camera names resolved from `useCameraStore` |
| CROSS-CAM badge | `client/src/components/FullscreenCameraView.tsx` | Added to face `DetectionRow` when the face's ID matches a cross-camera event from/to the current camera |

**Upgrade Path**

| Scale | Recommended Store | Notes |
|---|---|---|
| ≤ 16 cameras, 1 server | In-process shared gallery (current) | Zero external dependencies |
| Multi-process / multi-server | Redis Stack (RediSearch HNSW) | Add `ioredis`; use `FT.SEARCH … KNN` with 512-D vector index |
| Cloud / distributed | Qdrant (vector DB) | Add `@qdrant/js-client-rest`; replace gallery with Qdrant collection `face_embeddings` |

For Redis Stack upgrade, each face embedding is stored as a Redis hash with a 512-D FLOAT32 BLOB field and an HNSW index (M=16, efConstruction=200). Similarity search uses `FT.SEARCH idx:faces "*=>[KNN 1 @embedding $vec AS score]"`.

### 2.4 Loitering Detection Logic

The loitering detection engine shall implement configurable behavioral analysis:

- **Dwell time threshold**: configurable per zone (default: 30 seconds, range: 5s–600s)
- **Spatial clustering**: detect stationary or low-displacement tracks
- **Sliding-window displacement**: 10-second rolling window displacement replaces from-first-position check — catches pacing persons who pace back and forth within a zone ✅ *Implemented (Phase-2 upgrade)*
- **Speed and displacement analysis**: flag individuals with velocity < threshold in defined zones ✅ *Implemented*
- **Re-entry detection**: count and flag repeated entries within a time window ✅ *Implemented*
- **Revisit count**: increment counter each time object re-enters zone within `reentryWindow` ✅ *Implemented*
- **Appearance-based cross-ID revisit**: detect re-entry of the same person even when the tracker assigns a new ID — matched via ArcFace embedding (primary) or clothing colour (fallback); 2-minute appearance memory per zone ✅ *Implemented (Phase-2 upgrade)*
- **Pacing detection**: count x-direction movement reversals to detect back-and-forth pacing behaviour ✅ *Implemented (Phase-2 upgrade)*
- **Circular motion pattern**: detect repetitive loop trajectories ✅ *Implemented*
- **Composite risk score**: weighted combination of dwell/revisit/velocity/pacing/circular ✅ *Implemented (updated weights)*
- **Crowd density filtering**: adjust sensitivity based on scene density *(TODO — Phase 3)*
- **False alarm suppression**: ignore transient stops *(TODO — configurable via minDisplacement)*

#### 2.4.1 Composite Risk Score Formula

```
riskScore = min(1,
  (dwellTime / dwellThreshold)     × 0.35   // how long vs. threshold
  + min(revisitCount / 5, 1)       × 0.30   // repeated zone entries (includes cross-ID via appearance)
  + max(0, 1 − velocity / 80)      × 0.15   // low speed = high risk (80 px/s reference)
  + pacingScore                    × 0.12   // x-direction reversal rate (back-and-forth)
  + circularScore                  × 0.08   // loop / repetitive path indicator
)
```

Risk score thresholds (recommended):

| Score | Level | Suggested Action |
|:---:|---|---|
| 0.0 – 0.39 | Low | Log only |
| 0.40 – 0.69 | Medium | Visual alert in dashboard |
| 0.70 – 1.00 | High | Push notification + audio alert |

#### 2.4.2 Circular Motion Score

```
circularScore = max(0, 1 − straightLineDisplacement / totalPathLength)
```

A score > 0.4 indicates repetitive/loop movement. Computed over the full position history buffer (up to 300 frames ≈ 30 seconds at 10 FPS).

#### 2.4.3 Pacing Score *(Phase-2 — Implemented)*

```
reversals     = count of x-direction sign changes in the position history
pacingScore   = min(1, reversals / 10)
```

Counts the number of times the horizontal movement direction reverses (left→right or right→left). A person pacing back and forth in a small area generates many reversals at low displacement — a pattern that was previously missed by the circular score (which requires a loop, not a line).

#### 2.4.4 Sliding-Window Displacement *(Phase-2 — Implemented)*

**Problem with the original implementation**: displacement was computed as the maximum distance from the *first* position in the zone. A person who enters, walks 100 px to one side, and then paces back and forth near that point would have `maxDisp = 100 px` — exceeding the typical `minDisplacement = 50 px` threshold and never triggering loitering detection, even after dwelling for many minutes.

**Solution**: displacement is now computed over a **10-second rolling window**. The maximum distance moved *within the last 10 seconds* is compared to `minDisplacement`. A person who has been pacing in a confined area for 5 minutes will have a small recent displacement and correctly trigger the loitering condition.

#### 2.4.5 Appearance-Based Cross-ID Revisit Detection *(Phase-2 — Implemented)*

**Problem**: when the tracker temporarily loses a person and re-acquires them as a new ID, the revisit counter resets to zero — prior zone dwell time is discarded.

**Solution**: each zone maintains a 2-minute appearance gallery. When a new tracker ID enters a zone, the system checks for a prior appearance via:
1. **ArcFace cosine similarity** (primary) — threshold 0.45; requires face detection to be enabled
2. **Clothing colour matching** (fallback) — upper + lower colour string match from ColorClothService

If a match is found under a different objectId, `revisitCount` is pre-seeded to 1 (the effective threshold is halved on the next frame via the existing re-entry window logic). This ensures the risk score reflects cumulative zone presence even across tracker ID switches.

#### 2.4.6 AI-Attribute-Enriched Risk Scoring Pipeline *(Phase-2 — Implemented)*

**Problem**: previously, `BehaviorEngine.update()` ran *before* `AttributePipeline.enrich()`, meaning face embeddings, mask/hat status, and clothing colour were not available for risk scoring.

**Solution**: the pipeline order has been corrected:

```
Detection → Tracking → Attribute Enrichment → Behavior Analysis → Emission
```

Attributes available during `BehaviorEngine.update()`:

| Attribute | Source | Usage |
|---|---|---|
| `face.embedding` | ArcFace (512-dim) | Cross-ID revisit matching in zone gallery |
| `color.upper`, `color.lower` | ColorClothService | Colour-based fallback revisit matching |
| `mask.status` | PPE ONNX model | Future: face-hidden risk modifier |
| `hat.safetyCompliant` | PPE ONNX model | Future: environment-specific risk modifier |

### 2.4a Adaptive Multi-Feature Tracking *(from Adaptive Loitering Detection RFP)*

Based on the limitations of pure position-based tracking, the following improvements are planned:

#### 2.4a.1 Problem Statement

| Issue | Impact |
|---|---|
| Detection jitter | False dwell-time accumulation |
| Tracking ID switch | Person lost → re-counted as new entry |
| Occlusion | Track lost during brief obstruction |
| Re-appearance | Same person counted as new person |
| Slow movement ambiguity | Overly sensitive loitering trigger |
| Fixed Kalman noise | Under/over-reaction to motion changes |

#### 2.4a.2 Implementation Roadmap

| Feature | Priority | Status | Effort |
|---|:---:|:---:|---|
| Class-aware IoU matching | P0 | ✅ Done | tracking.js |
| Revisit count + re-entry window | P0 | ✅ Done | BehaviorEngine |
| Velocity + circular motion analysis | P0 | ✅ Done | BehaviorEngine |
| Composite risk score | P0 | ✅ Done | BehaviorEngine |
| Kalman Filter — basic (static Q) | P1 | ✅ Done | _inv4 NaN guard fixed; KF wired into Track |
| Suspicious score threshold per zone | P1 | ✅ Done | `minRiskScore` field in zone schema + BehaviorEngine gate |
| Multi-cue matching (IoU + Face + Color + Cloth + Acc) | P2 | ✅ Done | 5-cue dynamic-weight scorer; fast pre-tracking colour extraction; λ weights via `/api/tracker/config` + Appearance Weights UI |
| Adaptive Kalman (motion-based Q/R) | P1 | ✅ Done | Velocity from kf.x[4/5]; occlusion via framesWithoutHit |
| Sliding-window displacement check | P2 | ✅ Done | 10-second rolling window in BehaviorEngine — fixes pacing detection — see §2.4.4 |
| Pacing score (x-reversal detection) | P2 | ✅ Done | `_pacingScore()` in BehaviorEngine; weight 12% in risk score — see §2.4.3 |
| Appearance-based cross-ID revisit | P2 | ✅ Done | Per-zone gallery; ArcFace primary + colour fallback; 2-min expiry — see §2.4.5 |
| AI-attribute-enriched behavior pipeline | P2 | ✅ Done | Attribute enrichment before BehaviorEngine.update(); face/color available for risk — see §2.4.6 |
| Body-level ReID embedding (not face) | P2 | 🔲 TODO | FastReID or TorchReID — Python worker needed |
| Heatmap visualization | P2 | 🔲 TODO | Canvas overlay, /api/cameras/:id/heatmap |
| Human segmentation mask | P3 | 🔲 TODO | SAM/NanoSAM — GPU required for real-time |
| Cross-camera Re-ID | P3 | 🟡 Done (in-process) | Shared ArcFace gallery; `face:reidentified` event; `/api/crosscamera/stats` — see §2.3.2 |

#### 2.4a.3 Adaptive Kalman Filter Specification *(P1 — Implemented)*

> **Status**: ✅ Fully implemented — `_inv4()` NaN guard; KalmanFilter wired into `Track.predict()` / `Track.update()`; all Q/R parameters are **runtime-configurable** via `/api/tracker/config` and the Video Analytics tab UI.

**Runtime-Configurable Parameters** (`GET / PUT /api/tracker/config`):

| Parameter | Default | Range | Effect |
|---|:---:|---|---|
| `fastSpeedThreshold` | 30 px/f | 5–100 | Speed above = fast motion branch |
| `fastQScale` | 4.0× | 1.0–10.0 | Q multiplier for fast tracks (trust measurements more) |
| `slowSpeedThreshold` | 5 px/f | 1–20 | Speed below = stationary branch |
| `slowQScale` | 0.5× | 0.1–1.0 | Q multiplier for stationary tracks (tighten prediction) |
| `occlusionQScale` | 3.0× | 1.0–10.0 | Additional Q multiplier during occlusion (`framesWithoutHit > 1`) |
| `measurementNoise` | 10 | 1–50 | R diagonal value — higher = trust prediction more vs. measurements |

Settings are persisted to `storage/tracker.json` and applied immediately to the next frame without server restart.

Dynamic process noise Q adjustment:

```
if (velocity > 30 px/s):   Q *= 4    // fast moving — trust model less
if (velocity < 5 px/s):    Q *= 0.5  // stationary — tighten prediction
if (occluded):             covariance *= 3  // prediction dominant during occlusion
if (appearanceConf < 0.5): covariance *= 2  // weak appearance match
```

#### 2.4a.4 Multi-Cue Association Specification *(✅ Done — P2, v2.5)*

> **Status**: ✅ Implemented — `server/src/services/tracking.js` + `pipelineManager.js` + `VideoAnalyticsTab.tsx` Appearance Weights panel.

##### 5-Cue Weighted Score

Association between each detection and each track is scored by combining up to five independent cues. Every cue is independently optional — if either the detection or the track lacks data for a given cue, that cue is dropped and the remaining weights are **re-normalised** so the total score remains in [0, 1].

```
score(det_i, track_j) = Σ( λ_k × sim_k ) / Σ( λ_k  for active cues k )
```

| Cue | sim_k | λ default | Active when |
|---|---|:---:|---|
| **IoU** | Intersection-over-Union of bboxes | 0.60 | Always (baseline) |
| **Face** | ArcFace cosine similarity (EMA) | 0.20 | track.embedding set **and** det.embedding set (requires face model) |
| **Color** | RGB Euclidean distance [0,1] on upper+lower body | 0.12 | color enabled; fast pixel avg computed pre-tracking |
| **Cloth** | PAR cloth-type exact-match [0,1] on upper+lower | 0.05 | openpar.onnx loaded; track.cloth and det.cloth both present |
| **Accessories** | hat/mask boolean agreement [0,1] | 0.03 | PPE model enabled; both track.accessories and det.accessories present |

Class mismatch (e.g. car vs. person) always hard-rejects the pair (score = −1).

##### Pipeline Architecture — Two-Stage Appearance Feedback

```
Frame N
 ├─ YOLO detect → raw_detections
 ├─ [NEW] Fast colour extraction (avgColor, ~0.5 ms/person, no model)
 │    → det.color attached to each person detection
 ├─ tracker.update(raw_detections)          ← 5-cue score uses track attrs from frame N−1
 ├─ attributePipeline.enrich(tracked)       ← face embedding + PAR cloth + PPE hat/mask
 └─ tracker.update*(objectId, ...)          ← store colour/cloth/acc/embedding for frame N+1
      updateAppearance(id, embedding)
      updateColor(id, color)
      updateCloth(id, cloth)
      updateAccessories(id, {hat, mask})

Frame N+1
 ├─ YOLO detect → raw_detections (det.color pre-computed again)
 └─ tracker.update(...)   ← 5-cue score now has BOTH det.color AND track.color
```

**Why pre-tracking fast colour?**  
GPU-based enrichment (face, cloth, accessories) runs *after* `tracker.update()` so those values arrive one frame late. Pixel-averaging for colour is fast enough (~0.5 ms/person) to run *before* tracking, providing immediate det-vs-track colour comparison without changing the enrichment pipeline.

##### Similarity Functions

```
ColorSim(a, b):
  rgbDist(r1, r2) = 1 − min(√(ΔR²+ΔG²+ΔB²) / 441.67, 1)   // 441.67 = max RGB distance
  return (rgbDist(a.upperRgb, b.upperRgb) + rgbDist(a.lowerRgb, b.lowerRgb)) / 2

ClothSim(a, b):
  for field in [upper, lower]:
    if both known:  score += (a.field == b.field ? 1 : 0)
  return score / count  (0.5 if no known fields)

AccSim(a, b):
  for field in [hat, mask]:
    if both present: score += (a.field == b.field ? 1 : 0)
  return score / count  (0.5 if no common fields)

FaceSim(a, b):
  return dot(a.embedding, b.embedding)        // cosine sim of L2-normalised ArcFace vecs
  × max(0, 1 − embeddingAge × 0.1)            // age decay over 10 frames
```

##### ArcFace Embedding — Exponential Moving Average

```
track.embedding = 0.9 × track.embedding + 0.1 × new_embedding
```

EMA smooths frame-to-frame ArcFace variability while converging quickly to a stable face representation.

##### Runtime-Configurable Parameters

All weights are persisted to `storage/tracker.json` and applied immediately via `GET / PUT /api/tracker/config`. The **Appearance Weights** panel in the Video Analytics sidebar provides per-cue sliders with a real-time proportional bar chart.

| Parameter | Default | Range | Effect |
|---|:---:|---|---|
| `iouWeight` | 0.60 | 0.0–1.0 | Spatial overlap — baseline cue, always active |
| `faceWeight` | 0.20 | 0.0–1.0 | ArcFace cosine similarity (when face model on) |
| `colorWeight` | 0.12 | 0.0–1.0 | Upper/lower body RGB distance (fast, no model) |
| `clothWeight` | 0.05 | 0.0–1.0 | PAR cloth-type exact match (when openpar.onnx loaded) |
| `accWeight` | 0.03 | 0.0–1.0 | Hat/Mask presence agreement (when PPE model on) |

##### Fallback Behaviour

| Situation | Effective scoring |
|---|---|
| No face model, no colour, no cloth, no accessories | Pure IoU (all weight collapses to λ_iou) |
| Only colour available | IoU + Colour (λ_iou + λ_color, normalised) |
| All 5 cues active | Full 5-cue score as above |

##### Key Benefit: Re-ID After Brief Occlusion

When a person goes behind an object for several frames (IoU → 0, track goes Lost), the stored colour and cloth attributes allow re-association even without positional overlap:

- "Blue shirt + black trousers" track re-matches the same combination appearing 10 frames later
- Without colour/cloth, a new objectId would be assigned (ID switch)
- With 5-cue scoring, the colour + cloth similarity compensates for the IoU gap

#### 2.4a.5 Out-of-Scope Items *(Current Architecture)*

The following items from the Adaptive Loitering Detection RFP are **not feasible** within the current Node.js/ONNX single-server architecture:

| Item | Reason | Alternative |
|---|---|---|
| Human Segmentation (SAM, Mask2Former) | ~500ms/frame CPU — blocks 10 FPS pipeline | Use bbox ROI; consider NanoSAM on GPU Phase-3 |
| Python AI Worker | Major rewrite; IPC overhead | Current ONNX Runtime in Node.js sufficient |
| PostgreSQL + Redis + Milvus | Over-engineered for ≤ 16 cameras | SQLite (current) → PostgreSQL at 100+ cameras; Redis Stack for multi-server Re-ID (see §2.3.2) |
| YOLOv11 / RT-DETR | ONNX stability unverified | YOLOv8n COCO (current) performs well |
| Body-level FastReID / TorchReID | PyTorch-only Python libs | ArcFace via ONNX covers face-based Re-ID (cross-camera via shared gallery — §2.3.2) |

### 2.5 Zone Management

- Polygon-based zone definition via GUI (drag-and-drop interface)
- Support for **inclusion zones** (monitor inside) and **exclusion zones** (ignore inside)
- Time-based zone activation scheduling (e.g., active 22:00–06:00 only)
- Per-zone sensitivity and threshold configuration
- Minimum **50 configurable zones** per camera feed

### 2.6 Per-Zone AI Attribute Detection

The system shall support per-zone AI attribute-based object filtering, allowing operators to designate which categories of objects trigger loitering analysis within each zone.

#### 2.6.1 Supported Detection Targets

Each zone must independently configure which AI detection targets are active. When no targets are selected, all supported classes are monitored (backward-compatible default).

| Target Class | Label | Detection Model | Status |
|---|---|---|:---:|
| Human | `human` | YOLOv8n ONNX (COCO class 0: person) | ✅ Implemented |
| Vehicle | `vehicle` | YOLOv8n ONNX (COCO classes: bicycle/1, car/2, motorcycle/3, bus/5, truck/7) | ✅ Implemented |
| Face | `face` | SCRFD-2.5G ONNX (full-frame) + ArcFace ResNet-50 (512-D embeddings, stable face ID) | ✅ Implemented |
| Mask | `mask` | YOLOv8m PPE ONNX — head-crop IoU match → mask / no_mask + confidence | ✅ Implemented |
| Color | `color` | Pixel-averaging on upper/lower body crop (HSV dominant color, 11 classes) | ✅ Implemented |
| Cloth | `cloth` | Clothing type classifier (PAR model, upper/lower garment category) | ✅ Implemented |
| Hat | `hat` | YOLOv8m PPE ONNX — hardhat / no_hardhat + safetyCompliant flag | ✅ Implemented |
| Accessories | `accessories` | YOLOv8n COCO — backpack/24, umbrella/25, handbag/26, tie/27, suitcase/28 | ✅ Implemented |

#### 2.6.2 AI Model Pipeline for Each Attribute

```
Frame Buffer
    │
    ▼
Primary Detection (YOLOv8n)
    │  person / vehicle bboxes
    ├──────────────────────────────────────────────────────────────┐
    ▼                                                              ▼
Human/Vehicle tracking                                     ROI Crop per bbox
(ByteTrack)                                                        │
    │                                                     ┌────────▼────────────────┐
    ▼                                                     │   Attribute Inference   │
Per-Zone Class Filter                                     │  (face / mask / color / │
    │  targetClasses: ['human', 'vehicle']                │   cloth / hat / access) │
    ▼                                                     └────────────────────────-┘
Behavior Engine                                                    │
    │                                                     Attribute tags attached
    ▼                                                     to tracked object
Alert / Loitering Event
```

#### 2.6.3 Model Specifications for Planned Attribute Models

| Model | Input | Architecture | Output | Latency Target |
|---|---|---|---|---|
| Face Detection | Full frame | RetinaFace / YOLOv8-face ONNX | Face bboxes + landmarks | ≤ 20ms |
| Mask Detection | Cropped head ROI (112×112) | MobileNetV2 binary classifier | mask / no-mask + confidence | ≤ 5ms/crop |
| Color Analysis | Cropped body ROI (64×128) | ResNet-18 multi-label | upper/lower body color (11 classes) | ≤ 8ms/crop |
| Clothing Type | Cropped body ROI (128×256) | EfficientNet-B0 | clothing category (12 classes) | ≤ 10ms/crop |
| Hat Detection | Cropped head ROI (64×64) | MobileNetV3-small | hat / no-hat + hat type (8 classes) | ≤ 4ms/crop |
| Accessories | Cropped upper-body ROI | YOLOv8n-pose + classifier | bag / glasses / jewelry / etc. | ≤ 15ms/crop |

#### 2.6.4 Zone Configuration Schema (Extended)

```json
{
  "zoneId": "zone-uuid",
  "cameraId": "cam-01",
  "name": "Entrance A",
  "type": "MONITOR",
  "polygon": [{"x": 100, "y": 150}, {"x": 400, "y": 150}, {"x": 400, "y": 500}, {"x": 100, "y": 500}],
  "dwellThreshold": 30,
  "minDisplacement": 50,
  "reentryWindow": 120,
  "minRiskScore": 0.0,
  "targetClasses": ["human", "vehicle"],
  "active": true
}
```

> **`minRiskScore`** (0.0–1.0, default 0.0): minimum composite risk score required to emit a loitering alert for this zone. Setting to 0.6 filters out low-confidence loitering events and only triggers alerts for objects with elevated dwell time, repeated entries, or circular movement patterns. The loitering badge in the UI is displayed for all objects meeting the dwell/displacement threshold regardless of this value.

#### 2.6.5 Functional Requirements for AI Attribute Selection

- **Zone Editor UI**: Per-zone checkbox grid to select/deselect each AI attribute target
- **Immediate persistence**: toggling a checkbox auto-saves to the backend without requiring a manual save action
- **Backward compatibility**: zones without `targetClasses` (or with an empty array) monitor all supported classes
- **Model availability indicators**: unavailable models shown as greyed-out in the UI with a "Not Available" badge
- **Real-time filter**: the behavior engine applies `targetClasses` filter each frame — no restart required

#### 2.6.6 Indoor / Office Object Detection ✅ *Implemented*

The YOLOv8n COCO 80-class model detects a wide range of indoor and office objects in addition to persons and vehicles. No additional model installation is required — these classes are activated via zone `targetClasses` configuration.

**Supported Indoor / Office Object Classes**

| Object | COCO Class Name | targetClass ID | Color | Status |
|---|---|---|---|:---:|
| Chair | `chair` | `chair` | violet `#8b5cf6` | ✅ |
| Couch / Sofa | `couch` | `couch` | violet-400 `#a78bfa` | ✅ |
| Desk / Table | `dining table` | `diningtable` | emerald `#10b981` | ✅ |
| Bed | `bed` | (`furniture` group) | indigo `#6366f1` | ✅ |
| TV / Monitor | `tv` | `tv` | sky `#0ea5e9` | ✅ |
| Laptop | `laptop` | `laptop` | cyan `#06b6d4` | ✅ |
| Mouse | `mouse` | `mouse` | amber-300 `#fbbf24` | ✅ |
| Keyboard | `keyboard` | `keyboard` | pink `#ec4899` | ✅ |
| Cell Phone | `cell phone` | `cellphone` | red-400 `#f87171` | ✅ |
| Clock | `clock` | `clock` | emerald-400 `#34d399` | ✅ |
| Cup | `cup` | `cup` | orange `#fb923c` | ✅ |
| Bottle | `bottle` | `bottle` | lime `#a3e635` | ✅ |
| Book | `book` | `book` | violet-300 `#c4b5fd` | ✅ |
| Vase | `vase` | (default) | pink-400 `#f472b6` | ✅ |
| Remote | `remote` | (default) | gray-300 `#d1d5db` | ✅ |

**Group targetClass Mapping**

```
furniture  → chair, couch, dining table, bed
computer   → laptop, tv, keyboard, mouse, cell phone
```

**Usage Scenarios**

| Scenario | Zone targetClasses | Description |
|---|---|---|
| Asset theft prevention | `laptop`, `keyboard`, `clock` | Detect unauthorized removal of office equipment from a monitored area |
| Desk / seat occupancy | `diningtable`, `chair` | Alert on prolonged unattended occupation of seats in meeting rooms or cafes |
| Lost property detection | `bottle`, `cup`, `book` | Detect items left unattended in a designated zone for an extended period |
| Computer security zone | `computer` | Detect unauthorized access near computing equipment |
| No-phone zone enforcement | `cellphone` | Detect mobile phones in restricted security areas |

**Visual Representation Specification**

- Bounding box: class-specific color (see table above), solid 2px border
- Label: `className #objectId  confidence%` format
- Detection panel: color-coded chip per object class
- Zone editor: objects listed under the "Indoor / Office" group

---

### 2.7 Hardware & Deployment

The system shall support flexible deployment topologies:

| Deployment Mode | Specification | Notes |
|---|---|---|
| Edge (On-premise) | NVIDIA Jetson Orin / AGX Xavier | Low-latency, air-gapped |
| Server GPU | NVIDIA RTX 4090 / A100 / H100 | High channel count |
| Cloud | AWS EC2 G4dn / Azure NC-series | Scalable, managed |
| Hybrid | Edge + Cloud sync | Offline-resilient |

---

## 3. Software Architecture Requirements

### 3.1 Technology Stack

Preferred technology stack (alternatives will be evaluated):

| Layer | Technology |
|---|---|
| Language | Python 3.10+ (core pipeline), C++ (performance-critical modules) |
| Deep Learning Framework | PyTorch >= 2.0 with TorchScript / ONNX export |
| Inference Runtime | TensorRT 8.x+, ONNX Runtime, OpenVINO |
| Video Processing | FFmpeg, GStreamer, OpenCV 4.x |
| Backend API | FastAPI or gRPC with Protocol Buffers |
| Frontend Dashboard | React 18+ with TypeScript |
| Database | PostgreSQL (metadata), InfluxDB / TimescaleDB (time-series events) |
| Message Queue | Apache Kafka or Redis Streams |
| Container | Docker + Docker Compose / Kubernetes (K3s for edge) |

### 3.2 System Architecture

The system shall follow a modular microservices-inspired architecture:

```
[IP Cameras]
     │
     ▼
[Video Ingestion Service]
     │  (stream management, decode, frame buffering)
     ▼
[Detection Engine]
     │  (object detection inference pipeline)
     ▼
[Tracking Engine]
     │  (MOT with Re-ID module)
     ▼
[Behavior Analysis Engine]
     │  (loitering logic, zone management)
     ├──────────────┬──────────────┐
     ▼              ▼              ▼
[Alert Service] [Storage Svc] [API Gateway]
     │              │              │
[VMS/SMS/Email] [S3 / DB]  [Dashboard/REST]
```

**Core Components:**

1. **Video Ingestion Service** — stream management, decode, frame buffering
2. **Detection Engine** — object detection inference pipeline
3. **Tracking Engine** — MOT with Re-ID module
4. **Behavior Analysis Engine** — loitering logic, zone management
5. **Alert & Notification Service** — event queue, webhook, email, SMS
6. **Storage Service** — event database, video clip archiving
7. **API Gateway** — REST/WebSocket API, authentication, rate limiting
8. **Dashboard** — web-based management and monitoring UI

### 3.3 API Requirements

- RESTful API with **OpenAPI 3.0 (Swagger)** documentation
- WebSocket endpoint for real-time event streaming
- Authentication: **JWT Bearer tokens** with role-based access control (RBAC)
- Endpoints: camera management, zone configuration, events, alerts, reports, system health
- Webhook support for third-party VMS integration (Milestone, Genetec, Axis Camera Station)

### 3.4 Performance Requirements

| KPI | Minimum | Target |
|---|---|---|
| End-to-end alert latency | <= 3 seconds | <= 1 second |
| System uptime (SLA) | 99.5% | 99.9% |
| Alert accuracy (Precision) | >= 85% | >= 95% |
| Alert sensitivity (Recall) | >= 80% | >= 90% |
| Concurrent camera channels | >= 16 | >= 64 |
| Dashboard page load time | <= 3 seconds | <= 1 second |
| Event storage retention | 30 days | 90 days |

#### 3.4.1 ONNX Runtime Thread Configuration *(Implemented — v1.1)*

By default, each ONNX `InferenceSession` spawns one intra-op worker thread per logical CPU core. With 5 active models this results in `5 × CPU_cores` threads. The server controls this via `server/src/utils/onnxOptions.js` and `server/.env`:

| Mode | Env Condition | `intraOpNumThreads` | `executionProviders` |
|------|--------------|:-------------------:|----------------------|
| Development | `NODE_ENV=development` | `ONNX_THREADS_DEV` (default **1**) | `['cpu']` |
| CUDA | `ONNX_CUDA=1` | `ONNX_THREADS_CUDA` (default **1**) | `['cuda', 'cpu']` |
| Production | *(default)* | `ONNX_THREADS_PROD` (default **0 = auto**) | `['cpu']` |

- `ONNX_THREADS_PROD=0` → `max(2, min(8, floor(CPU_cores / 2)))`
- `npm run dev` sets `NODE_ENV=development` automatically via `nodemon.json`
- CUDA fallback: if CUDA provider is unavailable at runtime, falls back to CPU silently
- Applies to: `detection.js`, `faceService.js` (×2), `fireSmokeService.js`, `protectiveEquipService.js`, `colorClothService.js`

---

## 4. Functional Requirements

### 4.1 Dashboard & UI

- Live multi-camera grid view with overlaid bounding boxes and tracks
- Real-time loitering event log with thumbnail snapshots
- Zone drawing and configuration interface (polygon canvas editor with full-viewport vertex drag)
- **Per-zone AI attribute target selection**: checkbox panel for Human, Vehicle, Face, Mask, Color, Cloth, Hat, Accessories
- Alert history search with filter by camera, zone, time, severity
- Heatmap visualization of dwell-time across scene
- User management with RBAC (Admin, Operator, Viewer roles)
- Dark mode and responsive design (desktop and tablet)

### 4.2 Alerting & Notifications

- In-app real-time alert with visual and audio notification
- Email notification with event snapshot attachment
- SMS / push notification via configurable webhook
- VMS integration: push events to Milestone XProtect, Genetec Security Center
- Alert escalation policy: configurable escalation chains
- Alert suppression / cool-down period per zone

### 4.3 Video Evidence Management

- Automatic pre/post event video clip capture (configurable buffer: 10–60s)
- Clip storage in **H.264/H.265 MP4** format
- Evidence export with chain-of-custody metadata (SHA-256 hash)
- Cloud storage integration: AWS S3, Azure Blob, Google Cloud Storage
- Retention policy management with automatic archiving and deletion

### 4.4 Reporting & Analytics

- Scheduled PDF/CSV reports: daily, weekly, monthly
- Trend analysis: loitering frequency per zone, time-of-day patterns
- Operator performance metrics: alert acknowledgment rate, response time
- Custom report builder with date range and zone filters
- Dashboard export to PNG/PDF

---

## 5. Non-Functional Requirements

### 5.1 Security

- End-to-end **TLS 1.3** encryption for all network communications
- **AES-256** encryption for stored video evidence
- OWASP Top 10 compliance for web interfaces
- Penetration testing report required prior to acceptance
- **GDPR / PDPA** compliance: data anonymization and right-to-erasure support
- Audit logging for all administrative actions

### 5.2 Scalability & Reliability

- Horizontal scalability: add inference nodes without downtime
- Graceful degradation: maintain alerting function if dashboard is unavailable
- Automatic failover for critical services
- Health check endpoints and **Prometheus** metrics export
- Kubernetes Horizontal Pod Autoscaler (HPA) support

### 5.3 Maintainability

- Comprehensive unit and integration test suite (**> 80% code coverage**)
- CI/CD pipeline with automated testing (GitHub Actions)
- Semantic versioning and automated changelog generation
- Docker images for all services with multi-arch support (amd64, arm64)
- Infrastructure-as-Code: Helm charts or Terraform modules

### 5.4 Documentation

- System architecture document with component diagrams
- Installation and deployment guide (Docker, Kubernetes, bare-metal)
- User manual for dashboard operators
- API reference documentation (OpenAPI / Swagger)
- Model card: training data, performance benchmarks, known limitations
- Maintenance and troubleshooting guide

---

## 6. Project Milestones & Deliverables

| Phase | Milestone | Deliverables | Target Date |
|:---:|---|---|:---:|
| 1 | Project Kickoff | Project plan, architecture doc, environment setup | Week 2 |
| 2 | Core Pipeline | Detection + Tracking engine, unit tests | Week 6 |
| 3 | Loitering Logic | Behavior engine, zone manager, alert service | Week 10 |
| 4 | Dashboard Alpha | Web UI, API gateway, DB schema | Week 14 |
| 5 | Integration | Full system integration, VMS connectors, notifications | Week 18 |
| 6 | UAT & QA | Performance testing, security audit, bug fixes | Week 22 |
| 7 | Deployment | Production deployment, documentation, training | Week 24 |

---

## 7. Proposal Evaluation Criteria

| Evaluation Category | Weight | Max Score |
|---|:---:|:---:|
| Technical approach & architecture design | 30% | 30 |
| AI/ML model performance & accuracy benchmarks | 25% | 25 |
| Relevant experience & portfolio / case studies | 20% | 20 |
| Cost proposal & value for money | 15% | 15 |
| Project timeline & delivery confidence | 10% | 10 |
| **TOTAL** | **100%** | **100** |

---

## 8. Proposal Submission Requirements

### 8.1 Required Documents

1. Executive Summary (max 2 pages)
2. Company Profile and Relevant Experience
3. Technical Proposal (detailed architecture, methodology, tech stack)
4. AI Model Performance Report (benchmarks, dataset, evaluation metrics)
5. Project Schedule (Gantt chart or milestone plan)
6. Team Composition (CVs of key personnel)
7. Commercial Proposal (itemized cost breakdown)
8. References from at least 2 similar deployed projects
9. Prototype / Proof-of-Concept (demo video or live demo preferred)

### 8.2 Submission Details

| | |
|---|---|
| **Submission Method** | GitHub Pull Request to `melchi45/loitering_tracking` OR email |
| **Submission Deadline** | June 30, 2026 at 17:00 KST (UTC+9) |
| **Format** | PDF (mandatory), ZIP with supporting materials |
| **File Naming** | `RFP_LTS2026_[CompanyName]_Proposal.pdf` |
| **Questions Deadline** | June 15, 2026 (submit via GitHub Issues) |
| **Evaluation Period** | July 1 – July 15, 2026 |
| **Award Notification** | July 22, 2026 |

---

## 9. Terms and Conditions

### 9.1 General Terms

- The issuer reserves the right to reject any or all proposals without explanation.
- Submission of a proposal constitutes acceptance of all RFP terms and conditions.
- Proposals shall remain valid for **90 days** from submission deadline.
- All submitted materials become the property of the issuer.

### 9.2 Intellectual Property

- All deliverables developed under this contract shall be owned by the issuer.
- Vendor may retain rights to pre-existing IP; must clearly identify in proposal.
- Open-source components must comply with their respective licenses (MIT, Apache 2.0 preferred).

### 9.3 Confidentiality

- All RFP materials are confidential and for evaluation purposes only.
- Selected vendor must execute an NDA prior to contract award.
- All system data, video feeds, and customer information must be treated as confidential.

---

## 10. Appendix

### Appendix A: Glossary

| Term | Definition |
|---|---|
| **Loitering** | The act of remaining in a location for a period longer than deemed normal without apparent purpose |
| **MOT** | Multi-Object Tracking — tracking multiple objects simultaneously across video frames |
| **Re-ID** | Person Re-Identification — matching the same person across different camera views or after occlusion |
| **HOTA** | Higher Order Tracking Accuracy — a balanced tracking evaluation metric combining detection and association |
| **MOTA** | Multiple Object Tracking Accuracy — standard MOT evaluation metric |
| **mAP** | Mean Average Precision — standard detection evaluation metric |
| **TensorRT** | NVIDIA's SDK for high-performance deep learning inference |
| **VMS** | Video Management System — software for managing CCTV cameras and recordings |
| **ONVIF** | Open Network Video Interface Forum — IP camera interoperability standard |
| **RTSP** | Real Time Streaming Protocol — protocol for streaming audio/video |
| **Edge Device** | Computing hardware deployed on-premise close to camera sources (e.g., NVIDIA Jetson) |
| **Geofencing** | Virtual perimeter definition within a video frame for zone-based monitoring |

### Appendix B: Reference Architecture Diagram

Vendors are encouraged to propose their own architecture. The reference below illustrates the expected system topology:

```
[IP Cameras]  ──►  [Video Ingestion]  ──►  [Detection Engine]  ──►  [Tracking Engine]
                                                                             │
                                                                [Behavior Analysis Engine]
                                                           ┌─────────────────┼──────────────────┐
                                                           ▼                 ▼                  ▼
                                                    [Alert Service]  [Storage Service]   [API Gateway]
                                                           │                 │                  │
                                                  [VMS / SMS / Email]    [S3 / DB]    [Dashboard / REST]
```

---

> **END OF DOCUMENT — RFP-LTS-2026-001**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*
