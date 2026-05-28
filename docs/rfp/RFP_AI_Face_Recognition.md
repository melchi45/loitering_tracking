# REQUEST FOR PROPOSAL (RFP)
# AI Module — Face Detection & Recognition

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-03 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `face` |
| **Status** | **✅ Phase-2 Complete — Named gallery enrollment, photo upload, live match alerts, Missing Persons detection, Face ID UI tab active** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Model Specification](#4-model-specification)
5. [Two-Stage Pipeline](#5-two-stage-pipeline)
6. [Integration Requirements](#6-integration-requirements)
7. [Privacy & Compliance Requirements](#7-privacy--compliance-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Evaluation Criteria](#9-evaluation-criteria)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Face Detection & Recognition AI Module**, a planned enhancement to the LTS-2026 Loitering Detection & Tracking System. The module adds face-level analysis as an additional detection target within configured zones.

### 1.2 Scope

- **Stage 1**: Face detection in full video frames (bounding box + 5-point landmarks)
- **Stage 2**: Face feature extraction for recognition/re-identification
- **Stage 3**: Face attribute analysis (gender estimation, age range, emotion — optional)
- Integration as a zone-level filter: `"targetClasses": ["face"]`
- Privacy-preserving mode: face blurring/anonymization pipeline

### 1.3 Zone Target Key

Zones with `"targetClasses": ["face"]` activate face detection and recognition pipeline. This enables loitering behavior to be correlated with specific individuals or analyzed without relying on full-body detection.

---

## 2. Use Cases

| Use Case | Description | Zone Config | Status |
|---|---|---|---|
| **Missing Persons detection** | Upload reference photo of missing person → receive `missing_person_match` emergency alert when face is seen on any camera | `["face"]` | ✅ Phase-2 |
| VIP / Blocklist matching | Alert when specific face appears in restricted zone | `["face"]` | ✅ Phase-2 |
| Anonymous loitering | Track loitering without person re-ID, using face as anchor | `["face"]` | ✅ Phase-1 |
| Access control support | Face near door/gate → verify authorization | `["face"]` | Phase-3 |
| Crowd analytics | Count unique faces per zone per time period | `["face"]` | Phase-3 |
| Combined tracking | Use face as supplementary Re-ID signal alongside body Re-ID | `["human", "face"]` | ✅ Phase-1 |
| **Cross-camera tracking** | Re-identify the same person across multiple cameras; emit `face:reidentified` event and update trajectory | `["face"]` | ✅ Phase-1 |
| **Person trajectory** | Track a person's movement path across cameras with session-persistent alias (P1, P2, …) | `["face"]` | ✅ Phase-1 |

---

## 3. Technical Requirements

### 3.1 Face Detection

| Requirement | Specification |
|---|---|
| Minimum face size | 20×20 pixels in 1080p |
| Simultaneous faces | Up to 50 per frame |
| Face angles | Frontal (0°) to profile (75°) |
| Occlusion | Detect partially occluded faces (mask, glasses, hat) |
| Output | Face bbox + 5 landmarks (left eye, right eye, nose, left mouth, right mouth) |

### 3.2 Face Recognition

| Requirement | Specification |
|---|---|
| Feature vector | 128-D or 512-D L2-normalized embedding |
| Verification TAR@FAR=0.001 | ≥ 99.0% on LFW |
| 1:N search latency | ≤ 10ms for gallery of 10,000 faces |
| Gallery update | Real-time (no model reload required) |
| Face quality filtering | Reject blurry/occluded faces below quality threshold |

### 3.3 Face Attribute Analysis (Optional)

| Attribute | Classes | Accuracy Target |
|---|---|---|
| Gender | Male / Female | ≥ 90% |
| Age range | 0–10, 11–20, 21–30, 31–45, 46–60, 60+ | ≥ 80% |
| Emotion | Neutral, Happy, Angry, Sad, Surprised, Fearful | ≥ 75% |
| Glasses | Yes / No | ≥ 95% |
| Mask worn | Yes / No | — (see [RFP_AI_Mask_Detection.md](RFP_AI_Mask_Detection.md)) |

---

## 4. Model Specification

### 4.1 Face Detection Model Options

| Model | Architecture | Precision | Recall | Size | Latency |
|---|---|---|---|---|---|
| RetinaFace-MobileNet | MobileNet0.25 backbone | 91.4% | — | ~2MB | ~5ms |
| RetinaFace-ResNet50 | ResNet-50 backbone | 97.0% | — | ~110MB | ~25ms |
| SCRFD-2.5GF | Custom lightweight | 93.8% | — | ~3MB | ~3ms |
| SCRFD-34GF | Custom full model | 96.0% | — | ~28MB | ~12ms |
| YOLOv8n-face | YOLOv8n fine-tuned | 94.2% | — | ~6MB | ~8ms |
| YOLOv8s-face | YOLOv8s fine-tuned | 96.1% | — | ~22MB | ~15ms |

**Recommended**: SCRFD-2.5GF (balance of speed and accuracy for real-time use)

### 4.2 Face Recognition Model Options

| Model | Architecture | LFW Accuracy | IJB-C TAR@FAR=1e-4 | Size |
|---|---|---|---|---|
| ArcFace (ResNet-50) | ResNet-50 + ArcFace loss | 99.77% | 96.98% | ~92MB |
| ArcFace (MobileNet) | MobileNet + ArcFace loss | 99.50% | — | ~14MB |
| CosFace (ResNet-34) | ResNet-34 + CosFace loss | 99.73% | — | ~45MB |
| AdaFace (IR-50) | IR-50 + AdaFace loss | 99.82% | 97.39% | ~92MB |
| MobileFaceNet | MobileNet variant | 99.28% | — | ~4MB |

**Recommended**: ArcFace-MobileNet for edge; ArcFace-ResNet50 for server

### 4.3 Model Input/Output

**Face Detection (SCRFD)**:
```
Input:  [1, 3, 640, 640] float32 (letterboxed)
Output: [N, 15] — x1, y1, x2, y2, score, 5×(lmk_x, lmk_y)
```

**Face Recognition (ArcFace)**:
```
Input:  [1, 3, 112, 112] float32 (aligned face crop)
Output: [1, 512] float32 (L2-normalized embedding)
```

---

## 5. Two-Stage Pipeline

### 5.1 Pipeline Architecture

```
RTSP Frame (JPEG Buffer)
    │
    ▼ Primary Detection (YOLOv8n — person bbox)
    │  [person bboxes from human detection module]
    │
    ▼ Per-person ROI crop (full body region)
    │
    ▼ Stage 1: Face Detection (SCRFD / RetinaFace)
    │  Input: full frame OR person ROI
    │  Output: [{faceBbox, landmarks, faceScore}]
    │
    ▼ Face Quality Filter
    │  Reject: blur score < threshold
    │  Reject: face size < 20×20 px
    │  Reject: face angle > 75°
    │
    ▼ Face Alignment (similarity transform via 5 landmarks)
    │  → 112×112 aligned face crop
    │
    ▼ Stage 2: Face Recognition (ArcFace)
    │  Output: 512-D L2-normalized embedding
    │
    ├─ Gallery Match (1:N cosine similarity search)
    │  → matched identity OR "unknown"
    │
    └─ Attach to tracked person object
       { objectId, className:'person', faceId, embedding, identity }
```

### 5.2 Face Alignment

```javascript
// 5-point similarity transform
const referencePoints = [
  [38.2946, 51.6963],  // left eye
  [73.5318, 51.5014],  // right eye
  [56.0252, 71.7366],  // nose tip
  [41.5493, 92.3655],  // left mouth
  [70.7299, 92.2041],  // right mouth
];
// warpAffine → 112×112 aligned face
```

### 5.3 Cross-Camera Re-ID (Phase-1 Complete)

The shared gallery enables cross-camera person tracking without any additional configuration. When `_assignFaceIds()` finds a cosine-similarity match (≥ 0.35) from a different camera, it:

1. Increments the per-face `transitionCount` in `_crossCameraStats`.
2. Pushes the transition to `crossCameraTransitions` for post-processing.
3. Emits `face:reidentified` Socket.IO event to all clients.
4. Updates the Global Person Registry (`_personTrajectory`) with the new camera segment.

```
Shared Gallery Entry: { faceId, embedding, lastSeenAt, lastCameraId }

On match (sim ≥ 0.35, different camera):
  → crossCameraStats[faceId].transitionCount++
  → emit Socket.IO 'face:reidentified' { faceId, alias, prevCameraId, newCameraId, similarity, timestamp }
  → personTrajectory[faceId].segments.push({ cameraId, objectId, entryTime })
```

**Global Person Registry schema:**
```json
{
  "faceId":          "F3",
  "alias":           "P1",
  "firstSeenAt":     1715678850000,
  "lastSeenAt":      1715678901234,
  "currentCameraId": "cam-02",
  "segments": [
    { "cameraId": "cam-01", "objectId": "track-uuid-a", "entryTime": 1715678850000, "exitTime": 1715678890000 },
    { "cameraId": "cam-02", "objectId": "track-uuid-b", "entryTime": 1715678901000, "exitTime": null }
  ]
}
```

**REST endpoints (Phase-1):**
- `GET /api/faces/cross-camera-stats` — all faces with `transitionCount ≥ 1`
- `GET /api/faces/trajectories?maxAgeMs=300000` — persons active in the last N ms

### 5.4 Gallery Management

**Gallery types (`GalleryType`):**

| Type | Value | Priority | Trigger Event | Use Case |
|---|---|---|---|---|
| Missing Persons | `missing` | Critical | `face_match` + `missing_person_match` | Law enforcement / search operations |
| VIP | `vip` | High | `face_match` | Executive escort, preferential service |
| Blocklist | `blocklist` | High | `face_match` | Banned persons, access denial |
| General | `general` | Normal | `face_match` | Staff, registered visitors |

**Gallery data schema:**
```json
{
  "id":          "gallery-uuid",
  "name":        "Missing Children 2026",
  "description": "Regional police reference set",
  "type":        "missing",
  "createdAt":   "2026-05-26T05:38:40.496Z",
  "faceCount":   3
}
```

**Enrolled face schema:**
```json
{
  "id":        "face-uuid",
  "galleryId": "gallery-uuid",
  "name":      "Kim Minsu",
  "thumbnail": "data:image/jpeg;base64,…",
  "score":     0.94,
  "bbox":      { "x": 110, "y": 55, "width": 80, "height": 90 },
  "createdAt": "2026-05-26T06:12:00.000Z"
}
```

> Raw embeddings are never exposed via REST API (excluded from all list/get responses).

**REST API (Phase-2 Complete):**

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| GET | `/api/galleries` | — | List all galleries with `faceCount` |
| POST | `/api/galleries` | `{ name, description?, type? }` | Create gallery (`type` defaults to `general`) |
| DELETE | `/api/galleries/:id` | — | Delete gallery + all faces (cascade) |
| GET | `/api/galleries/:id/faces` | — | List enrolled faces (no raw embedding) |
| POST | `/api/galleries/:id/faces` | `multipart/form-data`: `photo` (image), `name` (string) | Upload photo → SCRFD detect → ArcFace embed → enroll |
| DELETE | `/api/galleries/:id/faces/:faceId` | — | GDPR right-to-erasure |

---

## 6. Integration Requirements

### 6.1 Zone Filter Integration

```javascript
// behaviorEngine.js — planned extension
const TARGET_CLASS_MAP = {
  human:   ['person'],
  vehicle: ['bicycle', 'car', 'motorcycle', 'bus', 'truck'],
  face:    ['face'],  // triggers face detection sub-pipeline
};
```

### 6.2 Detection Output Extension

**Face detection object (className='face', Phase-1):**
```json
{
  "objectId":   "face-det-uuid",
  "className":  "face",
  "bbox":       { "x": 110, "y": 55, "width": 40, "height": 45 },
  "confidence": 0.91,
  "faceId":     "F3",
  "alias":      "P1",
  "matchScore": 0.923,
  "crossCamera": { "prevCameraId": "cam-01" }
}
```

**Enriched person object (face attributes, Phase-1):**
```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "confidence": 0.89,
  "face": {
    "bbox":      { "x": 110, "y": 55, "width": 40, "height": 45 },
    "faceId":    "F3",
    "alias":     "P1",
    "identity":  null,
    "matchScore": 0.923,
    "embedding": null
  },
  "isLoitering": true,
  "dwellTime": 42.1
}
```

### 6.3 Cross-Camera Re-ID Event (Phase-1 Complete)

```json
{
  "type":         "face:reidentified",
  "faceId":       "F3",
  "alias":        "P1",
  "prevCameraId": "cam-01",
  "newCameraId":  "cam-02",
  "similarity":   0.871,
  "timestamp":    1715678901234
}
```

### 6.4 REST API (Phase-1 Complete)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/faces/cross-camera-stats` | Faces seen on ≥ 2 cameras with transition count |
| GET | `/api/faces/trajectories?maxAgeMs=N` | Person trajectories active in last N ms (default 5 min) |

### 6.5 Named Identity Match Alert (Phase-2 Complete)

#### 6.5.1 `face_match` event — all gallery types

Emitted when any detected face matches a persistent gallery entry (cosine sim ≥ 0.35). Includes `galleryType` so clients can route the alert to appropriate handler.

```json
{
  "faceId":      "F7",
  "cameraId":    "cam-01",
  "identity":    "Kim Minsu",
  "galleryId":   "gallery-uuid",
  "galleryType": "missing",
  "matchScore":  0.872,
  "thumbnail":   "data:image/jpeg;base64,…",
  "timestamp":   1748239140000
}
```

**Cooldown:** 30-second suppression per `${faceId}:${galleryFaceId}` pair to prevent alert flooding during continuous recognition.

#### 6.5.2 `missing_person_match` event — `missing` type only

Emitted **in addition to** `face_match` when `galleryType === 'missing'`. Same payload. Enables external systems (emergency dispatch, push notifications, alarm triggers) to subscribe to a dedicated channel without filtering the general alert stream.

```json
{
  "faceId":      "F7",
  "cameraId":    "cam-03",
  "identity":    "Kim Minsu",
  "galleryId":   "gallery-uuid",
  "galleryType": "missing",
  "matchScore":  0.872,
  "thumbnail":   "data:image/jpeg;base64,…",
  "timestamp":   1748239140000
}
```

**Alert routing table:**

| Gallery Type | Socket.IO Event(s) | UI Icon | UI Color | Cooldown |
|---|---|---|---|---|
| `missing` | `face_match` + `missing_person_match` | 🚨 | Red + flashing banner | 30 s |
| `vip` | `face_match` | ⭐ | Yellow | 30 s |
| `blocklist` | `face_match` | 🚫 | Orange | 30 s |
| `general` | `face_match` | ⚡ | Gray | 30 s |

### 6.6 Missing Persons Detection Flow (Phase-2 Complete)

End-to-end sequence for missing persons use case:

```
[Admin] Upload reference photo
  │ POST /api/galleries/:id/faces  (multipart, photo + name)
  │
  ▼ Server: SCRFD detects face → ArcFace embeds → store in lts.json
  │ pipelineManager.reloadPersistentGallery()  → cache updated
  │
[Camera] New frame arrives
  │ _assignFaceIds() → cosine similarity search vs. _persistentGallery
  │
  ├─ No match → continue
  │
  └─ Match (sim ≥ 0.35) → lookup gallery → galleryType = 'missing'
       │
       ├─ emit 'face_match'           { faceId, cameraId, identity, galleryType: 'missing', matchScore, thumbnail, timestamp }
       │
       └─ emit 'missing_person_match' { same payload }
            │
            ▼ Client: FaceGalleryTab receives event
              ├─ latestMissing state updated
              ├─ Red flashing banner rendered at top of Face ID tab
              ├─ 🔍 N badge in tab header updated
              └─ 🚨 entry added to Live Matches log (red background)
```

---

## 7. Privacy & Compliance Requirements

### 7.1 Legal Compliance

| Regulation | Requirement |
|---|---|
| GDPR (EU) | Explicit consent for face recognition; right to erasure |
| PDPA (Thailand/Korea) | Biometric data classified as sensitive personal data |
| CCPA (California) | Opt-out for biometric data collection |
| Illinois BIPA | Written consent required for face templates |

### 7.2 Privacy-Preserving Features

| Feature | Description | Priority |
|---|---|---|
| Face anonymization | Blur/pixelate face regions before storage or streaming | **Mandatory** |
| Consent overlay | Display consent notice when camera is active | Required by regulation |
| Data minimization | Do not store raw face images — embeddings only | **Mandatory** |
| Embedding expiration | Auto-delete embeddings after configurable retention period | Required |
| Audit log | Log all gallery searches and matches | **Mandatory** |
| Access control | RBAC: only Admins can manage gallery; Operators view alerts only | **Mandatory** |

### 7.3 Anonymization Pipeline (Required)

```
Face Detection Output
    │
    ▼ Privacy Mode Check
    │  if zone.privacyMode === 'blur':
    │    apply Gaussian blur to each faceBbox region in frame
    │    emit blurred frame to Socket.IO (never raw face)
    │
    ▼ Embedding Storage (no raw image)
    │  Store: { objectId, embeddingHash, timestamp }
    │  Purge: after retentionPeriodDays
```

---

## 8. Performance Requirements

### 8.1 Face Detection Accuracy

| Metric | Dataset | Minimum | Target |
|---|---|---|---|
| AP@0.5 | WiderFace Easy | ≥ 95% | ≥ 98% |
| AP@0.5 | WiderFace Medium | ≥ 92% | ≥ 96% |
| AP@0.5 | WiderFace Hard | ≥ 78% | ≥ 88% |

### 8.2 Face Recognition Accuracy

| Metric | Dataset | Minimum | Target |
|---|---|---|---|
| Verification accuracy | LFW | ≥ 99.0% | ≥ 99.7% |
| TAR@FAR=0.01% | IJB-C | ≥ 90% | ≥ 95% |
| 1:100 search accuracy | Internal test | ≥ 95% | ≥ 99% |

### 8.3 Latency Budget

| Stage | Maximum Latency | Notes |
|---|---|---|
| Face detection | 10ms | Per frame, single model pass |
| Face alignment | 1ms | Affine transform |
| Feature extraction | 5ms | Single face crop |
| Gallery search (1:1000) | 5ms | Cosine similarity FAISS |
| **Total face pipeline** | **≤ 25ms** | In addition to primary detection |

### 8.4 Robustness

| Condition | Requirement |
|---|---|
| Illumination variation | Works 50–5,000 lux |
| Face angle | ≤ 75° yaw, ≤ 30° pitch |
| Image quality | JPEG quality ≥ 60 |
| Glasses | Maintain ≥ 85% recognition accuracy |
| Partial mask | Detect face with lower portion masked |

---

## 9. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Face detection accuracy (WiderFace) | 30% | Easy/Medium/Hard benchmark |
| Face recognition (LFW + IJB-C) | 25% | Verification and identification accuracy |
| Privacy compliance | 20% | GDPR/PDPA feature completeness |
| Latency | 15% | Two-stage pipeline on CPU and GPU |
| Integration | 10% | ONNX format, API compatibility |

---

## 10. Appendix

### Appendix A: Reference Model Files

```
server/models/
├── yolov8n.onnx              # Primary detection (existing)
├── scrfd_2.5g.onnx           # Face detection model
├── arcface_mobilenet.onnx    # Face recognition model
└── age_gender_mobilenet.onnx # Attribute model (optional)
```

### Appendix B: Face Quality Metrics

Face quality score should consider:
- **Sharpness** (Laplacian variance ≥ 50)
- **Brightness** (mean pixel value 40–220)
- **Face angle** (yaw ≤ 75°, pitch ≤ 30°)
- **Face size** (≥ 20×20 pixels)
- **Occlusion ratio** (visible face area ≥ 50%)

### Appendix C: Benchmark Datasets

| Dataset | Purpose | Size |
|---|---|---|
| WiderFace | Face detection benchmark | 393,703 annotated faces |
| LFW (Labeled Faces in the Wild) | Face verification | 13,233 face images |
| IJB-C | Face recognition at scale | 138,000 faces, 3,531 subjects |
| AgeDB | Age-invariant recognition | 16,488 faces |

### Appendix E: Implementation History (2026-05)

#### ✅ Phase-1 Complete — Two-Stage Pipeline (SCRFD + ArcFace)

Both models are installed and active. The face recognition toggle in the VideoAnalytics tab enables the full pipeline.

**Installed models:**

| Model | File | Size | Role |
|---|---|---|---|
| SCRFD-2.5GF | `server/models/scrfd_2.5g.onnx` | 3.3 MB | Stage 1 — face detection |
| ArcFace ResNet-50 w600k | `server/models/arcface_w600k_r50.onnx` | 166 MB | Stage 2 — 512-D L2 embedding |

**Files changed (Phase-1):**

| File | Change |
|---|---|
| `server/src/services/faceService.js` | `detectFaces()` (SCRFD, NMS) + `getEmbedding()` (ArcFace 112×112 crop) |
| `server/src/services/attributePipeline.js` | Calls `getEmbedding()` in parallel for all detected faces; returns embeddings in `detectedFaces` |
| `server/src/services/pipelineManager.js` | `_assignFaceIds()` — **server-wide shared** cosine-similarity gallery (threshold 0.35, 30s expiry); cross-camera Re-ID with `face:reidentified` event; Global Person Registry (`_personTrajectory`) with canonical alias (P1, P2…); `getCrossCameraReIdStats()` and `getPersonTrajectories()` REST handlers |
| `server/src/index.js` | `/api/capabilities` — `face: has('scrfd_2.5g.onnx') && has('arcface_w600k_r50.onnx')`; `/api/faces/cross-camera-stats`; `/api/faces/trajectories` |
| `client/src/components/VideoAnalyticsTab.tsx` | Face item label updated to "Face Recognition"; model field shows both models |
| `client/src/components/FullscreenCameraView.tsx` | DetectionRow shows `[faceId]` / `[alias]` and cosine similarity score for face detections |
| `client/src/components/CameraView.tsx` | Canvas bbox label shows `face [F3]  87%` (alias when available) instead of `face #90001  87%` |
| `client/src/types/index.ts` | `Detection` interface — added `faceId?: string`, `alias?: string`, `matchScore?: number`, `crossCamera?: { prevCameraId: string }` |

**Pipeline flow (when `face` module is enabled):**

```
Frame
  ├─ SCRFD-2.5GF (full frame, 640×640 letterbox)
  │    → [{bbox, score, landmarks}]
  ├─ ArcFace ResNet-50 (per-face 112×112 crop, parallel)
  │    → [512-D L2-normalised embedding]
  ├─ _assignFaceIds() — shared gallery across ALL cameras
  │    similarity = dot(emb_a, emb_b)  [L2-normalised → cosine == dot]
  │    threshold  = 0.35
  │    expiry     = 30 s (pruned per call)
  │    → faceId  ('F1', 'F2', …)
  │    → matchScore (cosine similarity vs. gallery entry)
  │    → crossCamera.prevCameraId (if re-ID across cameras)
  ├─ Global Person Registry update
  │    → alias ('P1', 'P2', …) — session-persistent canonical identifier
  │    → PersonTrajectory.segments updated
  ├─ If cross-camera transition detected:
  │    emit Socket.IO 'face:reidentified'
  │      { faceId, alias, prevCameraId, newCameraId, similarity, timestamp }
  └─ Emitted as className='face' detection objects with faceId + alias + matchScore
```

#### ✅ Phase-2 Complete — Named Gallery, Photo Upload, Live Match Alerts, Face ID UI (2026-05-26)

**Files changed (Phase-2):**

| File | Change |
|---|---|
| `server/src/db.js` | Added `faceGalleries` and `faceGalleryFaces` tables to JSON-file store |
| `server/src/api/faceGallery.js` | New router — gallery CRUD + `multer` photo upload + `detectFaces()` + `getEmbedding()` + 64×64 thumbnail + `reloadPersistentGallery()` |
| `server/src/services/pipelineManager.js` | `_persistentGallery` in-memory cache; `_assignFaceIds()` searches persistent gallery per frame; `face_match` Socket.IO event (30 s cooldown); `reloadPersistentGallery()` public method |
| `server/src/index.js` | Mount `faceGalleryRouter` at `/api/galleries`; `reloadPersistentGallery()` on startup (5 s delay) |
| `client/src/components/FaceGalleryTab.tsx` | New **Face ID** sidebar tab — gallery list, create/delete, photo upload drop-zone, enrolled faces grid (4-col), live match log |
| `client/src/App.tsx` | Added `'faces'` to `SidebarTab` type; `FaceGalleryTab` in `renderTabContent()`; socket exposed as `window.__ltsSocket` |
| `client/src/types/index.ts` | Added `FaceGallery`, `EnrolledFace`, `FaceMatchEvent` interfaces |
| `client/src/i18n/translations/*.ts` | `tabFaceGallery` + 16 face gallery keys added to all 15 language files |

**Storage choice (vs. original spec):**
The original RFP specified SQLite. The actual implementation uses the project's existing JSON-file DB (`lts.json`) via `db.js` to avoid additional dependencies. This provides equivalent functionality for the current gallery size (< 10,000 faces). Migration to SQLite or MongoDB remains possible as a Phase-3 upgrade.

#### ✅ Phase-2 Addendum — Missing Persons Gallery Type (2026-05-26)

**Objective:** Support law enforcement / facility security use case where reference photos of missing persons are enrolled and the system raises emergency-grade alerts on detection.

**Design decisions:**

| Decision | Rationale |
|---|---|
| `GalleryType` union type (`general` \| `vip` \| `blocklist` \| `missing`) | Extensible; additional types can be added without schema changes |
| Separate `missing_person_match` event (not just a flag on `face_match`) | External systems (dispatch, push, alarm) can subscribe independently without filtering |
| Same 30 s cooldown for `missing_person_match` | Prevents alert flooding; emergency re-alert fires when face reappears after cooldown |
| Missing galleries rendered first in UI | Visual priority — operators see the highest-urgency galleries without scrolling |
| Eager FaceService startup (`loadFaceServiceEagerly()`) | Enrollment must work even with no active cameras; eliminates "models not loaded" 503 error |

**Files changed:**

| File | Change |
|---|---|
| `server/src/api/faceGallery.js` | `POST /api/galleries` — validates and stores `type` field from request body; defaults to `'general'` |
| `server/src/services/pipelineManager.js` | `_assignFaceIds()` — looks up gallery record for each match, sets `galleryType`, emits `missing_person_match` when `galleryType === 'missing'`; `loadFaceServiceEagerly()` — public method to pre-initialize `_attrPipeline` on startup |
| `server/src/index.js` | Replaced `setTimeout(reloadPersistentGallery, 5000)` with `loadFaceServiceEagerly().then(reloadPersistentGallery)` — models load immediately, gallery reloads after model load completes |
| `client/src/types/index.ts` | `GalleryType = 'general' \| 'vip' \| 'blocklist' \| 'missing'`; `FaceGallery.type: GalleryType`; `FaceMatchEvent.galleryType: GalleryType` |
| `client/src/components/FaceGalleryTab.tsx` | `GALLERY_TYPE_META` (icon/color/badge per type); `GALLERY_TYPE_ORDER` (missing first); `GallerySection` grouped list; type selector dropdown; missing alert banner (`animate-pulse`); missing count badge in header; `MatchLog` type-differentiated styling |
| `client/src/i18n/translations/*.ts` | 7 new keys added to all 15 language files: `galleryTypeMissing`, `galleryTypeVip`, `galleryTypeBlocklist`, `galleryTypeGeneral`, `faceSelectType`, `missingPersonAlert`, `faceNoMatches` |

**Phase-3 items (pending):**

| Feature | Notes |
|---|---|
| `GET /api/galleries/:id/search` explicit search endpoint | Currently live-only; explicit 1:N endpoint not yet exposed |
| Face blur / anonymization | Privacy mode — Gaussian blur on face region before streaming |
| Audit log | Log all gallery searches and identity matches |
| RBAC | Admin-only gallery management endpoints |
| Embedding retention / auto-purge | Configurable retention period cron job |
| Face attribute analysis | Age range, gender estimation (separate model) |
| Push notification on `missing_person_match` | Integration with external dispatch / notification systems |

**Source models researched:**

| Source | Notes |
|---|---|
| JackCui/facefusion (HF) `scrfd_2.5g.onnx` | Selected for detection — 3.3 MB, ONNX ready |
| FoivosPar/Arc2Face (HF) `arcface_w600k_r50.onnx` | Selected for recognition — ArcFace ResNet-50 w600k |

### Appendix D: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection (required upstream) |
| [RFP_AI_Mask_Detection.md](RFP_AI_Mask_Detection.md) | Mask detection (complementary) |
| [RFP_LTS2026_Loitering_Tracking_System.md](RFP_LTS2026_Loitering_Tracking_System.md) | Parent system RFP |

---

> **END OF DOCUMENT — LTS-2026-AI-03**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for AI Face Recognition |
