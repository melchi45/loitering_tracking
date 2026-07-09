# REQUEST FOR PROPOSAL (RFP)
# Object Tracking — Stable Multi-Object ID & Loitering Detection

| | |
|---|---|
| **RFP Reference** | OTS-2026-001 |
| **Issue Date** | May 19, 2026 |
| **Proposal Deadline** | June 30, 2026 at 17:00 KST (UTC+9) |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
   - 1.1 [Purpose](#11-purpose)
   - 1.2 [Background](#12-background)
   - 1.3 [Scope of Work](#13-scope-of-work)
2. [Technical Requirements](#2-technical-requirements)
   - 2.1 [Problem Statement](#21-problem-statement)
   - 2.2 [Pipeline Architecture](#22-pipeline-architecture)
   - 2.3 [Multi-Object Tracking Logic](#23-multi-object-tracking-logic)
   - 2.4 [Kalman Filter Stability](#24-kalman-filter-stability)
   - 2.5 [Multi-Cue Association](#25-multi-cue-association)
   - 2.6 [Cross-ID State Transfer](#26-cross-id-state-transfer)
   - 2.7 [Loitering Detection Logic](#27-loitering-detection-logic)
   - 2.8 [Implementation Roadmap](#28-implementation-roadmap)
3. [Software Architecture Requirements](#3-software-architecture-requirements)
   - 3.1 [System Architecture](#31-system-architecture)
   - 3.2 [Core Components](#32-core-components)
   - 3.3 [API Requirements](#33-api-requirements)
   - 3.4 [Performance Requirements](#34-performance-requirements)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Project Milestones & Deliverables](#6-project-milestones--deliverables)
7. [Proposal Evaluation Criteria](#7-proposal-evaluation-criteria)
8. [Proposal Submission Requirements](#8-proposal-submission-requirements)
9. [Terms and Conditions](#9-terms-and-conditions)
10. [Appendix](#10-appendix)

---

## 1. Project Overview

### 1.1 Purpose

This RFP documents the implemented solution to the **Object ID Stability Problem** in multi-object tracking for loitering detection. It defines the technical requirements for maintaining a consistent object identity across video frames, ensuring that the accumulated dwell time for a loitering subject is never reset due to a tracker ID change.

This document supersedes any prior draft (including the Copilot-generated concept overview) with the actual implementation design, discovered bugs, applied fixes, and architecture decisions derived from the live codebase.

### 1.2 Background

The loitering detection system monitors IP camera streams for objects that remain within a defined zone longer than a configured threshold. The core challenge is that an **object detector** (YOLOv8) assigns no cross-frame identity; without a tracker, every frame produces a brand-new detection with no link to prior frames.

A naive tracker that frequently changes the ID assigned to the same physical object causes the loitering dwell timer to reset to zero on each ID change, making loitering detection functionally impossible for real scenes.

Two critical defects were discovered and resolved in the existing codebase:

1. **Kalman Filter NaN propagation bug** — a JavaScript-specific `Math.max(0, NaN) = NaN` behaviour caused a single numerical instability in the Kalman Filter update step to permanently corrupt a track's bounding box, causing the tracker to create new tracks every frame (observed symptom: active track count growing by +2 to +4 per frame with `bestIou=NaN` log entries).
2. **Incomplete COCO class whitelist** — `detection.js` contained only 27 of 80 COCO class IDs, silently discarding all detections for animals, food, sports equipment, home appliances, and several office objects (mouse, clock, cell phone) even when those classes were explicitly enabled in the analytics configuration.

### 1.3 Scope of Work

This document covers:

- **ByteTracker** JavaScript implementation with 8-dimensional Kalman Filter
- **Multi-cue association**: IoU + ArcFace cosine similarity
- **KF numerical stability**: adaptive process noise, predict freeze, NaN guard
- **BehaviorEngine cross-ID state transfer**: zone appearance gallery
- **Improved loitering logic**: sliding-window displacement, pacing score, composite risk score
- **Full COCO 80-class support** in the detection pipeline
- **HSV-based colour classification** replacing broken RGB range matching
- **Runtime tracker configuration API**: all KF parameters adjustable without restart

---

## 2. Technical Requirements

### 2.1 Problem Statement

When the same physical object receives a different tracker ID between frames, the following chain of failures occurs:

```
Frame 1 → ID aaa  (dwell = 0.1 s — timer starts)
Frame 2 → ID bbb  (dwell = 0.1 s — NEW timer, previous dwell LOST)
Frame 3 → ID ccc  (dwell = 0.1 s — NEW timer again)
→ Loitering alert NEVER fires; subject can loiter indefinitely undetected
```

#### Root Cause 1 — Kalman Filter NaN Propagation

Discovered in `server/src/services/tracking.js`:

```
kf.update() → corrected.x = NaN  (P-matrix numerical drift)
Track.update() → Math.max(0, NaN) = NaN   ← JS-specific: NOT −∞
this.bbox.x = NaN stored in track
predict() → safeVal(predicted.x, this.bbox.x) = NaN  (fallback is also NaN)
_iou(det.bbox, track.bbox) → NaN
scoreMatrix[d][t] = NaN >= threshold → false  (match fails)
→ new Track created every frame
→ activeTracks grows unbounded: 4, 8, 12, 16 …
```

**Observed symptom:** `[Tracker] bestIou=NaN activeTracks=N` with N increasing every frame.

#### Root Cause 2 — Incomplete COCO Class Whitelist

```javascript
// detection.js — BEFORE fix: only 27 of 80 classes allowed
if (!ENABLED_CLASSES[maxClass]) continue;  // silent discard
// mouse (64), cell phone (67), clock (74) were present but many others were not
// animals (14–23), sports (29–38), food (46–55), appliances (68–72) were all missing
```

**Effect:** `analyticsConfig` class toggles had no effect for 53 class IDs.

### 2.2 Pipeline Architecture

The full frame processing pipeline (after fixes) is:

```
RTSP / ONVIF
    │  RTSPCapture — JPEG @ 10 FPS
    ▼
DetectionService
    │  YOLOv8n ONNX inference (INPUT_SIZE=640, letterbox)
    │  COCO 80-class ENABLED_CLASSES whitelist (all 80 IDs)
    │  Confidence filter (default 0.30)
    │  NMS (IoU threshold 0.50)
    ▼
ByteTracker
    │  8-dim Kalman Filter  state = [x, y, w, h, vx, vy, vw, vh]
    │  Adaptive process noise Q (stationary / normal / fast / occlusion)
    │  Multi-cue score  λ_iou × IoU + λ_app × ArcFace cosine
    │  Hungarian assignment (high-conf → lost → unmatched)
    │  maxAge = 90 frames (9 s at 10 FPS)
    ▼
AttributePipeline            ← enrichment BEFORE behavior (order fixed)
    │  SCRFD face detection
    │  ArcFace 512-dim embedding (EMA α=0.9)
    │  PPE: mask / hat (yolov8m_ppe)
    │  Clothing colour (HSV classification, upper + lower torso)
    ▼
BehaviorEngine
    │  Zone polygon point-in-polygon test
    │  Zone appearance gallery (ArcFace + clothing colour)
    │  Cross-ID state transfer (preserves dwell accumulation)
    │  Sliding-window displacement (10 s rolling window)
    │  Pacing score (x-direction reversal count)
    │  Composite risk score (5-factor weighted)
    ▼
Socket.IO → React Dashboard / Alert Database
```

#### Pipeline Order Correction

| Step | Before | After |
|---|---|---|
| 4 | Behavior Engine | Attribute Enrichment (face, PPE, colour) |
| 5 | Attribute Enrichment | Behavior Engine (receives enriched objects) |

**Reason:** ArcFace embedding, mask/hat state, and clothing colour must be available **before** risk scoring occurs each frame — not one frame later.

### 2.3 Multi-Object Tracking Logic

#### 2.3.1 8-Dimensional Kalman Filter

```
State vector:   x = [x, y, w, h, vx, vy, vw, vh]ᵀ
Measurement:    z = [x, y, w, h]ᵀ

Transition matrix F:
  ┌ 1 0 0 0 1 0 0 0 ┐   ← position += velocity × dt
  │ 0 1 0 0 0 1 0 0 │
  │ 0 0 1 0 0 0 1 0 │
  │ 0 0 0 1 0 0 0 1 │
  │ 0 0 0 0 1 0 0 0 │
  │ 0 0 0 0 0 1 0 0 │
  │ 0 0 0 0 0 0 1 0 │
  └ 0 0 0 0 0 0 0 1 ┘

Observation matrix H: [I₄ | 0₄]
Initial covariance P₀:  10 · I₈
Measurement noise R:    measurementNoise · I₄  (default 10.0, runtime-adjustable)
```

#### 2.3.2 Adaptive Process Noise Q

| Motion State | Condition | Q Scale |
|---|---|---|
| Stationary | speed < 5 px/frame | 0.5× |
| Normal | 5 ≤ speed ≤ 30 px/frame | 1.0× |
| Fast | speed > 30 px/frame | 4.0× |
| Occlusion | `framesWithoutHit` > 1 | bbox frozen (predict skipped) |

All thresholds and scales are runtime-configurable via `/api/tracker/config`.

#### 2.3.3 Track Lifecycle

```
new Track(detection) → state: Tracked  (hitStreak = 1)
  │
  ├─ predict() called each frame where no match
  │    framesWithoutHit++ → state: Lost
  │    framesWithoutHit > 1: KF predict skipped (bbox frozen)
  │                          prevents P-matrix covariance blowup
  │
  ├─ matched again → state: Tracked  (ID unchanged)
  │
  └─ framesWithoutHit > maxAge (90) → state: Removed

Returned to pipeline: state === Tracked && hitStreak >= minHits (1)
```

**maxAge = 90 frames (9 seconds at 10 FPS)** — increased from the prior default of 30 frames to allow the same ID to survive prolonged occlusion (e.g., person walking behind a post).

### 2.4 Kalman Filter Stability

#### 2.4.1 Predict Freeze for Lost Tracks

```javascript
predict() {
  this.framesWithoutHit++;
  if (this.framesWithoutHit <= 1) {
    // Last frame had a detection match — normal KF predict
    this.kf.Q = KalmanFilter._eye(8, qScale);
    const predicted = this.kf.predict();
    const safeVal = (v, fb) => isFinite(v) ? v : fb;
    this.bbox = {
      x:      Math.max(0, safeVal(predicted.x,      this.bbox.x)),
      y:      Math.max(0, safeVal(predicted.y,      this.bbox.y)),
      width:  Math.max(1, safeVal(predicted.width,  this.bbox.width)),
      height: Math.max(1, safeVal(predicted.height, this.bbox.height)),
    };
  }
  // framesWithoutHit > 1: bbox held constant, P blowup prevented
}
```

#### 2.4.2 Update NaN Guard

```javascript
update(detection) {
  this.kf.R = KalmanFilter._eye(4, trackerConfig.getConfig().measurementNoise);
  const corrected = this.kf.update(detection.bbox);

  const safeVal = (v, fallback) => isFinite(v) ? v : fallback;
  // Use YOLO detection bbox as fallback — always a valid finite value
  const cx = safeVal(corrected.x,      detection.bbox.x);
  const cy = safeVal(corrected.y,      detection.bbox.y);
  const cw = safeVal(corrected.width,  detection.bbox.width);
  const ch = safeVal(corrected.height, detection.bbox.height);

  if (cx !== corrected.x || cy !== corrected.y) {
    // KF numerical blowup detected → reset filter state
    this.kf.init(detection.bbox);
    this.kf.P = KalmanFilter._eye(8, 10);
  }

  this.bbox = {
    x:      Math.max(0, cx),
    y:      Math.max(0, cy),
    width:  Math.max(1, cw),
    height: Math.max(1, ch),
  };
  // ... hitStreak, framesWithoutHit, state update
}
```

#### 2.4.3 IoU Non-Finite Guard

```javascript
_iou(bboxA, bboxB) {
  const ax1 = bboxA.x, ay1 = bboxA.y,
        ax2 = bboxA.x + bboxA.width, ay2 = bboxA.y + bboxA.height;
  const bx1 = bboxB.x, by1 = bboxB.y,
        bx2 = bboxB.x + bboxB.width, by2 = bboxB.y + bboxB.height;

  // Reject NaN / Infinity inputs — treats the pair as non-overlapping
  if (!isFinite(ax1) || !isFinite(ay1) || !isFinite(ax2) || !isFinite(ay2) ||
      !isFinite(bx1) || !isFinite(by1) || !isFinite(bx2) || !isFinite(by2)) {
    return 0;
  }
  // ... standard IoU math ...
}
```

### 2.5 Multi-Cue Association

#### 2.5.1 Composite Score Matrix

```
score(det_i, track_j) = λ_iou × IoU(det_i, track_j.bbox)
                      + λ_app × IoU × appConf   (ArcFace confidence correction)

λ_iou         = 0.70   (spatial overlap weight)
λ_app         = 0.30   (appearance similarity weight)
scoreThreshold = 0.25   (relaxed from prior 0.30)
```

#### 2.5.2 ArcFace Embedding — Exponential Moving Average

```javascript
// After AttributePipeline enrichment — feedback into tracker
tracker.updateAppearance(obj.objectId, obj.face.embedding);

// Inside Track: EMA update (α = 0.9)
if (!this.embedding) {
  this.embedding = newEmbedding.slice();
} else {
  for (let i = 0; i < this.embedding.length; i++)
    this.embedding[i] = 0.9 * this.embedding[i] + 0.1 * newEmbedding[i];
}
```

If no embedding is available for a track, the score falls back to pure IoU matching automatically.

#### 2.5.3 Cross-Class Hard Reject

Detections and tracks of different classes receive a score of −1, preventing a vehicle from inheriting a person's ID or vice versa.

#### 2.5.4 Assignment Steps (ByteTrack two-stage)

| Stage | Detection Set | Track Set | Method |
|---|---|---|---|
| Step 1 | High-confidence (≥ conf threshold) | All active tracks | Hungarian, score threshold 0.25 |
| Step 2 | Low-confidence (below threshold) | Unmatched Lost tracks | Hungarian, IoU-only threshold 0.50 |
| Step 3 | Unmatched high-conf | — | Create new tracks |
| Step 4 | Still-unmatched tracks | — | Increment `framesWithoutHit` |

### 2.6 Cross-ID State Transfer

When the same physical person is assigned a new tracker ID (e.g., after leaving and re-entering the camera FOV), the **BehaviorEngine zone appearance gallery** recognises the re-appearance and transfers all accumulated loitering state to the new ID.

#### 2.6.1 Zone Appearance Gallery Structure

```javascript
// Per-zone appearance gallery
// zoneId → [{ objectId, embedding, upperColor, lowerColor, lastSeenAt }]
this._zoneGallery = new Map();
```

#### 2.6.2 Matching Priority

| Priority | Method | Condition |
|---|---|---|
| 1 | ArcFace cosine similarity | similarity ≥ 0.45 |
| 2 | Clothing colour (upper + lower both match) | No face embedding available |
| Guard | Same-frame skip | Prevents false positive within single frame |

#### 2.6.3 State Transfer Flow

```javascript
// New ObjectId enters zone
const prevObjectId = this._checkAndEnrollAppearance(zone.id, newId, obj, now);

if (prevObjectId) {
  const prevState = this._state.get(prevObjectId);
  // Full state inheritance: dwell time, trajectory, revisit count
  state = { ...prevState, leftAt: null };
  this._state.delete(prevObjectId);
  // Loitering timer continues accumulating without interruption
}
```

**Effect:** A subject whose ID changes mid-session does not lose any accumulated dwell time; the loitering alert fires at the correct elapsed time.

### 2.7 Loitering Detection Logic

#### 2.7.1 Sliding-Window Displacement

Prior implementation measured displacement from the first recorded position, making it blind to pacing behaviour (where the net displacement is small but actual path length is large).

**Current implementation — 10-second rolling window:**

```javascript
const WIN_MS = 10_000;
const winFrames = state.frames.filter(f => f.timestamp > now - WIN_MS);
const winOrigin = winFrames[0];
let maxDisp = 0;
for (const f of winFrames)
  maxDisp = Math.max(maxDisp, _dist(f, winOrigin));
```

**Effect:** Subjects pacing back and forth within a small area are now correctly classified as loitering.

#### 2.7.2 Pacing Score (x-Direction Reversal)

```javascript
function _pacingScore(frames, minFrames = 10) {
  if (frames.length < minFrames) return 0;
  let reversals = 0, prevSign = 0;
  for (let i = 1; i < frames.length; i++) {
    const dx = frames[i].x - frames[i - 1].x;
    if (Math.abs(dx) < 2) continue;             // ignore sub-pixel jitter
    const sign = Math.sign(dx);
    if (prevSign !== 0 && sign !== prevSign) reversals++;
    prevSign = sign;
  }
  return Math.min(1, reversals / 10);           // saturates at 10 reversals
}
```

#### 2.7.3 Composite Risk Score

| Factor | Weight | Description |
|---|---|---|
| Dwell ratio (`dwellRatio`) | 35% | `dwellTime / dwellThreshold` (saturates at 2×) |
| Revisit ratio (`revisitRatio`) | 30% | Saturates at 5 revisits (cross-ID counts preserved) |
| Low-velocity ratio (`lowVeloRatio`) | 15% | Higher when speed < 80 px/s |
| Pacing score (`pacingScore`) | 12% | x-direction reversal ratio |
| Circular motion (`circScore`) | 8% | Total path length / straight-line displacement |

```javascript
function _riskScore(dwellTime, threshold, revisitCount, velocity, circScore, pacingScore) {
  const dwellRatio   = Math.min(dwellTime / Math.max(threshold, 1), 2) / 2;
  const revisitRatio = Math.min(revisitCount / 5, 1);
  const lowVeloRatio = Math.max(0, 1 - velocity / 80);
  return Math.min(1,
    dwellRatio   * 0.35 +
    revisitRatio * 0.30 +
    lowVeloRatio * 0.15 +
    pacingScore  * 0.12 +
    circScore    * 0.08
  );
}
```

### 2.8 Implementation Roadmap

| Phase | Item | Status |
|:---:|---|:---:|
| 1 | YOLOv8n ONNX detection pipeline | ✅ Done |
| 1 | COCO 80-class ENABLED_CLASSES expansion | ✅ Done |
| 2 | 8-dim Kalman Filter ByteTracker | ✅ Done |
| 2 | Adaptive process noise Q | ✅ Done |
| 2 | KF predict freeze for Lost tracks | ✅ Done |
| 2 | KF update NaN guard + P reset | ✅ Done |
| 2 | IoU non-finite input guard | ✅ Done |
| 3 | ArcFace 512-dim embedding integration | ✅ Done |
| 3 | EMA appearance update (α = 0.9) | ✅ Done |
| 3 | Multi-cue score (IoU + ArcFace) | ✅ Done |
| 4 | Zone appearance gallery | ✅ Done |
| 4 | Cross-ID state transfer | ✅ Done |
| 5 | Sliding-window displacement (10 s) | ✅ Done |
| 5 | Pacing score | ✅ Done |
| 5 | Composite risk score (5-factor) | ✅ Done |
| 6 | Pipeline reorder (enrichment before behavior) | ✅ Done |
| 6 | HSV colour classification | ✅ Done |
| 6 | Runtime tracker config API | ✅ Done |
| 7 | SCRFD face detection | ✅ Done |
| 7 | PPE (mask, hat) detection | ✅ Done |
| 8 | Automated regression tests | 🔲 TODO |
| 8 | HOTA / MOTA benchmark evaluation | 🔲 TODO |

---

## 3. Software Architecture Requirements

### 3.1 System Architecture

```
[IP Cameras — RTSP / ONVIF]
          │
          ▼
[Video Ingestion — RTSPCapture]
          │   JPEG frames @ 10 FPS
          ▼
[Detection Engine — YOLOv8n ONNX]
          │   COCO 80-class, conf ≥ 0.30, NMS IoU 0.50
          ▼
[ByteTracker — 8-dim KF + Multi-Cue Association]
          │   maxAge=90, iouThreshold=0.25, ArcFace EMA
          ▼
[Attribute Pipeline — SCRFD + ArcFace + PPE + HSV Colour]
          │   enrichment happens BEFORE behavior engine
          ▼
[Behavior Engine — Zone Manager + Loitering Logic]
          │   cross-ID state transfer, risk score
          ├──────────────┬──────────────┐
          ▼              ▼              ▼
  [Alert Service]  [Storage Svc]  [API Gateway]
          │              │              │
  [Socket.IO/DB]   [JSON / DB]  [REST + WebSocket]
                                        │
                                 [React Dashboard]
```

### 3.2 Core Components

| Component | File | Responsibility |
|---|---|---|
| Detection Engine | `server/src/services/detection.js` | YOLOv8n ONNX inference, letterbox pre-process, NMS post-process, 80-class whitelist |
| ByteTracker | `server/src/services/tracking.js` | 8-dim KF, adaptive Q, two-stage Hungarian assignment, NaN stability guards |
| Behavior Engine | `server/src/services/behaviorEngine.js` | Zone entry/exit, dwell timer, cross-ID state transfer, risk score, loitering alert |
| Attribute Pipeline | `server/src/services/attributePipeline.js` | SCRFD face detection, ArcFace embedding, PPE classification, clothing colour |
| Colour Classifier | `server/src/services/colorClothService.js` | HSV-based colour naming (replaces broken RGB range matching) |
| Pipeline Manager | `server/src/services/pipelineManager.js` | Per-camera frame orchestration, pipeline step sequencing |
| Tracker Config | `server/src/services/trackerConfig.js` | Persistent KF parameter storage and runtime access |
| Tracker API | `server/src/api/tracker.js` | REST endpoints for GET/PUT/POST tracker configuration |
| Analytics Config | `server/src/services/analyticsConfig.js` | Per-class enable/disable flags, `isClassEnabled()` filter |

#### 3.2.1 Tracker Configuration Parameters

| Parameter | Default | Description |
|---|---|---|
| `maxAge` | 90 | Lost track retention frames (90 frames = 9 s at 10 FPS) |
| `iouThreshold` | 0.25 | Minimum multi-cue score for track association |
| `fastSpeedThreshold` | 30 | Speed (px/frame) above which fast-motion Q scale applies |
| `fastQScale` | 4.0 | Process noise multiplier for fast motion |
| `slowSpeedThreshold` | 5 | Speed (px/frame) below which stationary Q scale applies |
| `slowQScale` | 0.5 | Process noise multiplier for stationary objects |
| `occlusionQScale` | 3.0 | Additional Q multiplier when `framesWithoutHit` > 0 |
| `measurementNoise` | 10.0 | Diagonal value of measurement noise matrix R |
| `iouWeight` | 0.7 | λ_iou — spatial overlap weight in multi-cue score |
| `appWeight` | 0.3 | λ_app — appearance weight in multi-cue score |

#### 3.2.2 COCO 80-Class Support

All 80 COCO class IDs are now included in `ENABLED_CLASSES`. Class-level on/off filtering is delegated entirely to `analyticsConfig.isClassEnabled()`.

| Group | Class IDs | Class Names |
|---|---|---|
| People | 0 | person |
| Vehicles | 1–8 | bicycle, car, motorcycle, airplane, bus, train, truck, boat |
| Infrastructure | 9–13 | traffic light, fire hydrant, stop sign, parking meter, bench |
| Animals | 14–23 | bird, cat, dog, horse, sheep, cow, elephant, bear, zebra, giraffe |
| Accessories | 24–28 | backpack, umbrella, handbag, tie, suitcase |
| Sports | 29–38 | frisbee, skis, snowboard, sports ball, kite, baseball bat, … |
| Food / Drink | 39–55 | bottle, wine glass, cup, fork, knife, spoon, bowl, banana, … |
| Furniture | 56–61 | chair, couch, potted plant, bed, dining table, toilet |
| Electronics | 62–67 | tv, laptop, mouse, remote, keyboard, cell phone |
| Appliances | 68–72 | microwave, oven, toaster, sink, refrigerator |
| Personal Items | 73–79 | book, clock, vase, scissors, teddy bear, hair drier, toothbrush |

#### 3.2.3 HSV Colour Classification

The prior RGB range matching produced incorrect results for mid-saturation colours:

| Example Input | RGB Method | HSV Method (current) |
|---|---|---|
| RGB(170, 151, 112) | `gray` (wrong) | `orange` (correct — s=0.34, h≈37°) |
| RGB(180, 100, 50) | `gray` (wrong) | `brown` (correct — h=20°, v=0.53) |

HSV classification rules:
- Saturation < 0.15 → achromatic (black / white / gray by brightness)
- Hue 10°–50°, value < 0.55 → brown
- Otherwise → hue-angle lookup (red / orange / yellow / green / cyan / blue / purple)

### 3.3 API Requirements

#### 3.3.1 Tracker Configuration REST API

```
GET  /api/tracker/config         — retrieve current KF + association parameters
PUT  /api/tracker/config         — update one or more parameters (partial update supported)
POST /api/tracker/config/reset   — restore factory defaults
```

All changes take effect on the **next processed frame** without server restart.

**Example PUT body:**
```json
{
  "maxAge": 120,
  "iouThreshold": 0.20,
  "measurementNoise": 8.0
}
```

#### 3.3.2 Additional API Endpoints (existing)

- `GET /api/zones` / `POST /api/zones` — zone CRUD
- `GET /api/events` — loitering event history
- `GET /api/cameras` — discovered camera list
- `WebSocket /` (Socket.IO) — real-time frame annotation stream

#### 3.3.3 API Standards

- RESTful, JSON body, HTTP status codes per RFC 9110
- OpenAPI 3.0 documentation (to be generated)
- JWT Bearer token authentication (RBAC: Admin, Operator, Viewer)

### 3.4 Performance Requirements

| KPI | Minimum | Target |
|---|---|---|
| End-to-end alert latency | ≤ 3 s | ≤ 1 s |
| Object ID stability (same person, continuous view) | ≥ 95% frames same ID | ≥ 99% frames same ID |
| Object ID recovery after occlusion (< 9 s) | ≥ 80% same ID restored | ≥ 95% same ID restored |
| Detection precision @ conf 0.30 | ≥ 85% | ≥ 92% |
| False loitering alert rate | ≤ 10% | ≤ 5% |
| Loitering recall (true loiterers alerted) | ≥ 80% | ≥ 90% |
| Concurrent camera channels (CPU-only) | ≥ 4 | ≥ 8 |
| Frame processing throughput | ≥ 10 FPS per channel | ≥ 15 FPS per channel |
| System uptime (SLA) | 99.5% | 99.9% |

---

## 4. Functional Requirements

### 4.1 Object Tracking

- **FR-T1**: Each detected object shall be assigned a unique integer ID that persists across frames as long as the object remains visible or is occluded for fewer than `maxAge` frames.
- **FR-T2**: Tracker shall use an 8-dimensional Kalman Filter with adaptive process noise (stationary / normal / fast motion states).
- **FR-T3**: Kalman Filter numerical instability (NaN or Infinity in state vector) shall be detected and recovered within one frame by falling back to the detection bbox and resetting the P matrix.
- **FR-T4**: Two-stage Hungarian assignment shall be applied: high-confidence detections to all tracks first, then low-confidence detections to unmatched Lost tracks.
- **FR-T5**: Detections and tracks of different object classes shall never be matched (class hard-reject with score = −1).

### 4.2 Appearance-Based Re-Identification

- **FR-A1**: ArcFace 512-dimensional embeddings shall be computed for each detected face and stored per track using an exponential moving average (α = 0.9).
- **FR-A2**: Appearance similarity shall be combined with IoU in the association score matrix: `λ_iou × IoU + λ_app × IoU × appConf`.
- **FR-A3**: If no embedding is available for a track, pure IoU matching shall be applied automatically as a fallback.
- **FR-A4**: BehaviorEngine zone gallery shall use ArcFace cosine similarity (≥ 0.45) as the primary cross-ID identity check, with clothing colour as secondary fallback.

### 4.3 Cross-ID State Transfer

- **FR-C1**: When a new object ID enters a zone and is matched to a previous ID in the zone appearance gallery, all accumulated loitering state (dwell time, trajectory, revisit count) shall be transferred to the new ID.
- **FR-C2**: The previous ID's state entry shall be removed after transfer to prevent double-counting.
- **FR-C3**: Same-frame entries shall be excluded from gallery matching to prevent false positive transfers within a single frame.

### 4.4 Loitering Detection

- **FR-L1**: Loitering shall be declared when `dwellTime ≥ dwellThreshold` AND `maxDisplacement < displacementThreshold` (10-second sliding window).
- **FR-L2**: A composite risk score (0.0–1.0) incorporating dwell ratio, revisit ratio, low-velocity ratio, pacing score, and circular motion score shall be computed for each tracked object in each zone.
- **FR-L3**: Each zone shall support a configurable `minRiskScore` threshold for alert suppression.
- **FR-L4**: Pacing behaviour (back-and-forth motion in x-direction with ≥ 10 reversals) shall contribute to the risk score and can alone trigger escalated alert classification.

**Reference guide unit gap (2026-07-09, `docs/rfp/Loitering_Detection_가이드.md`, absorbed and deleted)**: FR-L1's `displacementThreshold` and the velocity term feeding FR-L2's risk score are pixel-native (`minDisplacement`, `velocity` px/s) — the guide's own rules specify real-world units ("0.2 m/s", "3 m") that cannot currently be configured directly, since no per-camera pixel-to-meter calibration exists. See `docs/design/Design_LTS2026_Loitering_Tracking_System.md` §6.2.1 (Phase 12b-4, Proposed).

### 4.5 Detection Coverage

- **FR-D1**: The detection pipeline shall support all 80 COCO object class IDs without hard-coded exclusions at the detection layer.
- **FR-D2**: Class-level filtering shall be applied exclusively via `analyticsConfig.isClassEnabled()`, ensuring that enabling a class in the analytics configuration takes immediate effect.
- **FR-D3**: Clothing colour classification shall use HSV conversion for all colour decisions, not RGB range matching.

### 4.6 Dashboard & UI

- Live multi-camera grid with bounding boxes, track IDs, and class labels
- Zone editor with polygon drawing and per-zone attribute target selection
- Real-time loitering event log with risk score display
- Alert history with camera, zone, time, and risk score filters
- Tracker configuration panel (live parameter adjustment without restart)

### 4.7 Alerting & Notifications

- In-app real-time alert with Socket.IO push
- Configurable webhook for VMS integration
- Alert suppression / cool-down period per zone
- Risk score displayed alongside alert (enables operator triage)

---

## 5. Non-Functional Requirements

### 5.1 Numerical Stability

- **NFR-S1**: The Kalman Filter implementation shall not propagate NaN or Infinity values into the track bounding box under any operating condition. JavaScript's `Math.max(0, NaN) = NaN` behaviour shall be explicitly guarded against.
- **NFR-S2**: The IoU computation function shall return 0 for any non-finite input without throwing an exception.
- **NFR-S3**: Process noise Q shall be dynamically scaled; accumulated floating-point error in the P matrix shall be bounded by the predict-freeze mechanism for Lost tracks.

### 5.2 Security

- TLS 1.3 for all network communications
- JWT Bearer token authentication with RBAC
- OWASP Top 10 compliance for web interfaces
- Audit logging for all administrative and configuration changes

### 5.3 Scalability & Reliability

- Horizontal scalability: add inference nodes without downtime
- Graceful degradation: alerting remains functional if dashboard is unavailable
- Health check endpoints and Prometheus metrics export
- Automatic reconnection to RTSP streams after network interruption

### 5.4 Maintainability

- All tracker KF parameters shall be runtime-adjustable without code changes or server restart
- Semantic versioning for API and model releases
- Unit tests required for KF update, NaN guard, IoU computation, and association logic
- Integration tests shall use real ONNX inference, not mocked model outputs

### 5.5 Documentation

- System architecture document with component diagrams
- API reference (OpenAPI / Swagger)
- Tracker parameter tuning guide (field scenarios: indoor retail, parking lot, corridor)
- Model card: YOLOv8n COCO benchmarks, known detection limitations
- Troubleshooting guide: NaN propagation, ID instability diagnostics, KF parameter effects

---

## 6. Project Milestones & Deliverables

| Phase | Milestone | Deliverables | Status | Date |
|:---:|---|---|:---:|:---:|
| 1 | Detection Pipeline | YOLOv8n ONNX inference, 80-class COCO support, letterbox + NMS | ✅ Done | Apr 14, 2026 |
| 2 | ByteTracker Core | 8-dim KF, adaptive Q, predict freeze, NaN guard + P reset | ✅ Done | May 5, 2026 |
| 3 | Multi-Cue Association | ArcFace EMA (α=0.9), two-stage Hungarian, class hard-reject | ✅ Done | May 12, 2026 |
| 4 | Behavior Engine | Zone PiP, dwell timer, zone appearance gallery, cross-ID state transfer | ✅ Done | May 14, 2026 |
| 5 | Loitering Logic | Sliding-window displacement (10 s), pacing score, 5-factor risk score | ✅ Done | May 16, 2026 |
| 6 | Attribute Pipeline | SCRFD face detect, ArcFace embed, PPE (mask/hat), HSV colour | ✅ Done | May 19, 2026 |
| 7 | Runtime Config API | `/api/tracker/config` GET/PUT/POST, persistent config storage | ✅ Done | May 19, 2026 |
| 8 | Dashboard Integration | React UI, Socket.IO stream, zone editor, fullscreen detection panel | ✅ Done | May 19, 2026 |
| 9 | QA & Benchmarking | HOTA/MOTA/IDF1 evaluation on MOT17, regression test suite, perf profiling | 🔲 Target | Jun 9, 2026 |
| 10 | Documentation | OpenAPI / Swagger docs, KF tuning guide, model card, troubleshooting guide | 🔲 Target | Jun 23, 2026 |
| 11 | Production Deployment | Docker Compose packaging, Prometheus metrics, SLA verification | 🔲 Target | Jun 30, 2026 |

---

## 7. Proposal Evaluation Criteria

| Evaluation Category | Weight | Max Score |
|---|:---:|:---:|
| Object ID stability — HOTA / MOTA benchmark results | 30% | 30 |
| Kalman Filter design quality and numerical stability | 20% | 20 |
| Cross-ID state transfer accuracy (loitering continuity) | 20% | 20 |
| Loitering detection precision and recall | 15% | 15 |
| Runtime configurability and operational tooling | 10% | 10 |
| Documentation quality and completeness | 5% | 5 |
| **TOTAL** | **100%** | **100** |

---

## 8. Proposal Submission Requirements

### 8.1 Required Documents

1. Executive Summary (max 2 pages)
2. Technical Proposal — tracker architecture, KF design, association algorithm details
3. Benchmark Report — HOTA, MOTA, IDF1 on a representative dataset (MOT17 or custom)
4. ID Stability Test Results — same-subject ID continuity over occlusion sequences
5. Loitering Detection Evaluation — precision, recall, false alarm rate per scenario
6. Project Schedule (Gantt chart or milestone plan)
7. Team Composition (CVs of key personnel with MOT/Re-ID experience)
8. Commercial Proposal (itemised cost breakdown)
9. References from at least 2 deployed multi-camera tracking systems
10. Demo video or live prototype showing cross-ID loitering dwell continuity

### 8.2 Submission Details

| | |
|---|---|
| **Submission Method** | GitHub Pull Request to `melchi45/loitering_tracking` OR email |
| **Submission Deadline** | June 30, 2026 at 17:00 KST (UTC+9) |
| **Format** | PDF (mandatory), ZIP with supporting materials |
| **File Naming** | `RFP_OTS2026_[CompanyName]_Proposal.pdf` |
| **Questions Deadline** | June 15, 2026 (submit via GitHub Issues) |
| **Evaluation Period** | July 1 – July 15, 2026 |
| **Award Notification** | July 22, 2026 |

---

## 9. Terms and Conditions

### 9.1 General Terms

- The issuer reserves the right to reject any or all proposals without explanation.
- Submission of a proposal constitutes acceptance of all RFP terms and conditions.
- Proposals shall remain valid for **90 days** from the submission deadline.
- All submitted materials become the property of the issuer.

### 9.2 Intellectual Property

- All deliverables developed under this contract shall be owned by the issuer.
- Vendors may retain rights to pre-existing IP; pre-existing IP must be clearly identified in the proposal.
- Open-source components must comply with their respective licenses (MIT, Apache 2.0 preferred).
- ArcFace and YOLOv8 model weights must comply with their respective upstream licenses.

### 9.3 Confidentiality

- All RFP materials are confidential and for evaluation purposes only.
- The selected vendor must execute an NDA prior to contract award.
- All system data, video feeds, and personally identifiable information (PII) must be treated as strictly confidential and handled in accordance with applicable privacy regulations (GDPR, PDPA).

---

## 10. Appendix

### Appendix A: Comparison — Prior Concept Draft vs. Current Implementation

| Item | Prior Concept (Copilot draft) | Current Implementation |
|---|---|---|
| Tracking algorithm | ByteTrack recommended (conceptual) | ByteTrack — full JS implementation |
| Kalman Filter | Position prediction mentioned | 8-dim adaptive KF; NaN stability bugs discovered and fixed |
| IoU threshold | Tuning recommended | Runtime-adjustable; default 0.25 |
| Max age | Configurable recommended | 90 frames (9 s); was 30 frames |
| Re-ID | ReID model addition suggested | ArcFace 512-dim + EMA (α=0.9) |
| Re-appearance handling | Not mentioned | Cross-ID state transfer (full dwell preservation) |
| Loitering logic | Not mentioned | Sliding-window displacement + pacing score + 5-factor risk score |
| Numerical stability | Not mentioned | NaN propagation bug discovered and fixed (JS `Math.max(0,NaN)=NaN`) |
| COCO class support | Not mentioned | 80-class full support (was 27-class partial) |
| Colour classification | Not mentioned | HSV-based; gray mis-classification fixed |

### Appendix B: Glossary

| Term | Definition |
|---|---|
| **ByteTrack** | Two-stage multi-object tracker using IoU-based association with a Kalman Filter for motion prediction |
| **Kalman Filter (KF)** | Recursive Bayesian estimator combining motion prediction with noisy measurements to track object position |
| **Process Noise Q** | KF matrix modelling uncertainty in the motion model; scaled adaptively based on observed speed |
| **Measurement Noise R** | KF matrix modelling uncertainty in the sensor (YOLO bbox); fixed diagonal scaled by `measurementNoise` |
| **ArcFace** | Deep face recognition model producing 512-dim L2-normalised embeddings for identity comparison |
| **EMA** | Exponential Moving Average — online embedding update: `new = α × old + (1−α) × current` |
| **NaN propagation** | In JavaScript, `Math.max(0, NaN) = NaN` (not `0`); allows a single bad KF output to permanently corrupt a track |
| **Cross-ID state transfer** | BehaviorEngine mechanism that preserves dwell time when the tracker assigns a new ID to a previously known subject |
| **Pacing score** | Metric quantifying back-and-forth x-direction motion; high pacing without spatial displacement indicates suspicious behaviour |
| **Composite risk score** | Weighted sum of dwell ratio, revisit ratio, low-velocity ratio, pacing score, and circular motion score (0.0–1.0) |
| **HOTA** | Higher Order Tracking Accuracy — balanced evaluation metric combining detection accuracy and association quality |
| **MOTA** | Multiple Object Tracking Accuracy — standard MOT benchmark metric |
| **IDF1** | ID F1 Score — measures the ratio of correctly identified detections over the mean of ground-truth and computed detections |
| **MOT** | Multi-Object Tracking — tracking multiple objects simultaneously across video frames |
| **Re-ID** | Person Re-Identification — matching the same person after occlusion or across different camera views |
| **COCO** | Common Objects in Context — 80-class object detection benchmark dataset |
| **HSV** | Hue-Saturation-Value — colour space used for perceptual colour classification |
| **ONVIF** | Open Network Video Interface Forum — IP camera interoperability standard |
| **RTSP** | Real Time Streaming Protocol — streaming protocol for audio/video delivery |

### Appendix C: Reference Architecture Diagram

```
[IP Cameras — RTSP / ONVIF]
          │
          ▼
  [RTSPCapture — JPEG @ 10 FPS]
          │
          ▼
  [YOLOv8n ONNX — DetectionService]
          │  80-class, conf ≥ 0.30, NMS
          ▼
  [ByteTracker — 8-dim KF]
          │  maxAge=90, iouThreshold=0.25
          │  ArcFace EMA, class hard-reject
          ▼
  [AttributePipeline]
          │  SCRFD + ArcFace + PPE + HSV colour
          │  Feedback: embeddings → ByteTracker
          ▼
  [BehaviorEngine]
          │  Zone gallery, cross-ID transfer
          │  Risk score, loitering alert
          │
    ┌─────┴──────┬──────────────┐
    ▼            ▼              ▼
[Alert DB]  [Storage]    [API Gateway]
                              │
                       [React Dashboard]
                       [Socket.IO stream]
```

### Appendix D: Key Source Files

| Functionality | File |
|---|---|
| YOLO inference + COCO 80-class filter | `server/src/services/detection.js` |
| ByteTracker + 8-dim Kalman Filter + NaN guards | `server/src/services/tracking.js` |
| Behavior analysis + loitering + cross-ID transfer | `server/src/services/behaviorEngine.js` |
| ArcFace / PPE / colour enrichment pipeline | `server/src/services/attributePipeline.js` |
| HSV colour classification | `server/src/services/colorClothService.js` |
| KF + association parameter persistence | `server/src/services/trackerConfig.js` |
| Frame pipeline orchestration | `server/src/services/pipelineManager.js` |
| Tracker REST API | `server/src/api/tracker.js` |
| Per-class analytics configuration | `server/src/services/analyticsConfig.js` |

---

> **END OF DOCUMENT — RFP-OTS-2026-001**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Object Tracking |
| 1.1 | 2026-07-09 | Youngho Kim | §4.4에 픽셀 vs. 미터/초속도 단위계 격차 노트 추가 — `docs/rfp/Loitering_Detection_가이드.md` 흡수 반영, 원본 삭제 |
