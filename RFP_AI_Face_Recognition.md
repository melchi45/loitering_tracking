# REQUEST FOR PROPOSAL (RFP)
# AI Module — Face Detection & Recognition

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-03 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | May 15, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Zone Target Key** | `face` |
| **Status** | Planned (not yet implemented) |
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

| Use Case | Description | Zone Config |
|---|---|---|
| VIP / Blocklist matching | Alert when specific face appears in restricted zone | `["face"]` |
| Anonymous loitering | Track loitering without person re-ID, using face as anchor | `["face"]` |
| Access control support | Face near door/gate → verify authorization | `["face"]` |
| Crowd analytics | Count unique faces per zone per time period | `["face"]` |
| Combined tracking | Use face as supplementary Re-ID signal alongside body Re-ID | `["human", "face"]` |

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

### 5.3 Gallery Management

```json
{
  "galleryId": "blocklist-001",
  "name": "Persons of Interest",
  "faces": [
    { "id": "face-uuid", "name": "UNKNOWN-001", "embedding": [0.12, -0.34, ...], "enrolledAt": "2026-05-01" }
  ]
}
```

API endpoints:
- `POST /api/galleries` — create gallery
- `POST /api/galleries/:id/faces` — enroll face
- `DELETE /api/galleries/:id/faces/:faceId` — remove face
- `GET /api/galleries/:id/search` — 1:N search

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

```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "confidence": 0.89,
  "face": {
    "faceBbox": { "x": 110, "y": 55, "width": 40, "height": 45 },
    "faceId": "face-uuid-or-null",
    "identity": "UNKNOWN-001",
    "matchScore": 0.923,
    "embedding": null
  },
  "isLoitering": true,
  "dwellTime": 42.1
}
```

### 6.3 Face Alert Schema

```json
{
  "type": "face_match",
  "cameraId": "cam-01",
  "objectId": "track-uuid",
  "faceId": "face-uuid",
  "identity": "Person-Of-Interest-001",
  "matchScore": 0.923,
  "galleryId": "blocklist-001",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "faceBbox": { "x": 110, "y": 55, "width": 40, "height": 45 },
  "timestamp": 1715678901234,
  "frame": "base64-jpeg-thumbnail"
}
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
