# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Face Detection & Recognition

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-03 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Face_Recognition.md (LTS-2026-AI-03) |

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

The Face Detection & Recognition module adds face-level identity anchoring to the LTS-2026 tracking pipeline — enabling loitering behavior to be linked to specific face IDs, supporting VIP/blocklist matching, and providing privacy-preserving person tracking — while enforcing GDPR/PDPA compliance requirements for biometric data handling.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect faces in full frames using SCRFD-2.5GF (bounding box + 5-point landmarks).
- Extract 512-D L2-normalized ArcFace embeddings per detected face.
- Assign persistent per-camera face IDs via in-memory cosine-similarity gallery (threshold 0.35, 30 s expiry).
- Emit `faceId` and `matchScore` on face detection objects for display in the detection panel and canvas overlay.
- Provide privacy-preserving anonymization (face blur) and mandatory audit logging for all gallery searches.

### 2.2 Non-Goals

- Persistent named face gallery (SQLite) and 1:N gallery search API are Phase-2 features not covered in Phase-1.
- Face attribute analysis (age range, gender, emotion) is an optional Phase-2 addition and not required for initial release.
- This module does not perform crowd demographic analytics.

---

## 3. User Personas

**Security Administrator** — manages VIP and blocklist face galleries. Needs to enroll, update, and delete face templates via API, with full audit trail. Must comply with GDPR right-to-erasure requirements.

**Security Operator** — monitors live camera feeds and receives face-match alerts when a person of interest appears in a zone. Does not manage galleries; views alert notifications and `faceId` labels on the detection panel.

---

## 4. Functional Specification

### 4.1 Phase-1 Pipeline (Complete)

```
Frame
 ├─ SCRFD-2.5GF (full frame, 640×640 letterbox) → [{bbox, score, landmarks}]
 ├─ ArcFace ResNet-50 (per-face 112×112 aligned crop) → [512-D L2-normalized embedding]
 ├─ Cosine-similarity gallery (per camera, in-memory)
 │    threshold = 0.35,  expiry = 30 s
 │    → faceId ('F1', 'F2', …), matchScore
 └─ Emitted as className='face' detection objects
```

### 4.2 Face Quality Filter

Faces are rejected (skipped) when:
- Sharpness (Laplacian variance) < 50
- Brightness outside 40–220 mean pixel value
- Face size < 20×20 px
- Yaw angle > 75° or pitch > 30°
- Visible face area < 50%

### 4.3 Face Alignment

5-point similarity transform maps detected landmarks to 112×112 reference alignment for ArcFace input.

### 4.4 Gallery Management (Phase-2)

REST API for named galleries:
- `POST /api/galleries` — create gallery
- `POST /api/galleries/:id/faces` — enroll face
- `DELETE /api/galleries/:id/faces/:faceId` — remove face (GDPR erasure)
- `GET /api/galleries/:id/search` — 1:N search

### 4.5 Privacy & Compliance Requirements

| Feature | Status |
|---|---|
| Face anonymization (Gaussian blur on faceBbox before streaming) | Mandatory — Phase-2 |
| Raw face images never stored — embeddings only | Mandatory |
| Embedding auto-delete after configurable retention period | Mandatory |
| Audit log for all gallery searches and matches | Mandatory |
| RBAC: Admins manage gallery, Operators view alerts only | Mandatory |
| Consent overlay when camera is active | Required by regulation |

### 4.6 Zone Activation

Zones with `"targetClasses": ["face"]` activate the full face detection and recognition pipeline. Combined with `"human"` enables joint body + face tracking.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime (`onnxruntime-node`) |
| Face detection model | `scrfd_2.5g.onnx` (SCRFD-2.5GF, 3.3 MB) |
| Face recognition model | `arcface_w600k_r50.onnx` (ArcFace ResNet-50, 166 MB) |
| Detector input | `[1, 3, 640, 640]` float32 letterboxed |
| Detector output | `[N, 15]` — x1, y1, x2, y2, score, 5×(lmk_x, lmk_y) |
| Recognizer input | `[1, 3, 112, 112]` float32 aligned face crop |
| Recognizer output | `[1, 512]` float32 L2-normalized embedding |
| Gallery similarity | Cosine similarity (dot product of L2-normalized vectors) |
| Gallery threshold | 0.35 (per-camera in-memory) |
| Gallery expiry | 30 s |
| Total face pipeline latency | ≤ 25 ms in addition to primary detection |
| Minimum face size | 20×20 px in 1080p |

---

## 6. Input / Output Contract

**Input:**
- JPEG frame buffer (1080p) from RTSP pipeline.
- Person bbox list from primary detection (optional — face detection runs on full frame).

**Output per face detection (appended to person object):**
```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "face": {
    "faceBbox": { "x": 110, "y": 55, "width": 40, "height": 45 },
    "faceId": "F3",
    "identity": null,
    "matchScore": 0.923,
    "embedding": null
  }
}
```

**Face match alert (Phase-2):**
```json
{
  "type": "face_match",
  "cameraId": "cam-01",
  "objectId": "track-uuid",
  "faceId": "face-uuid",
  "identity": "Person-Of-Interest-001",
  "matchScore": 0.923,
  "galleryId": "blocklist-001",
  "timestamp": 1715678901234
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Face detection accuracy — easy | AP@0.5 ≥ 95% on WiderFace Easy |
| AC-02 | Face detection accuracy — hard | AP@0.5 ≥ 78% on WiderFace Hard |
| AC-03 | Face recognition accuracy | Verification accuracy ≥ 99.0% on LFW |
| AC-04 | 1:N search latency | Gallery search ≤ 5 ms for 1,000-face gallery |
| AC-05 | Total pipeline latency | Face pipeline adds ≤ 25 ms to per-frame time |
| AC-06 | Face ID persistence | Same face assigned consistent `faceId` across ≥ 10 consecutive frames |
| AC-07 | Face ID display | Canvas overlay and detection panel show `face [F3] 87%` format |
| AC-08 | Model capabilities endpoint | `/api/capabilities` returns `face: true` when both model files are present |
| AC-09 | No raw face storage | Server never writes raw face image crops to disk or emits them in socket events |
| AC-10 | Quality filter | Blurry (Laplacian < 50) or small (< 20×20 px) faces are rejected before embedding extraction |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase-1: SCRFD face detection + ArcFace embedding + per-camera in-memory gallery | 2026-05-18 | 2026-05-18 | ✅ Complete |
| M2 | Phase-2: Persistent SQLite face gallery + named identity enrollment | TBD | - | ⏳ Pending |
| M3 | Phase-2: VIP/blocklist alert — `face_match` Socket.IO event | TBD | - | ⏳ Pending |
| M4 | Phase-2: Face blur/anonymization privacy mode | TBD | - | ⏳ Pending |
| M5 | Phase-2: Face attribute analysis (age range, gender) | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement persistent SQLite face gallery (survive server restarts)
- [ ] Implement `POST /api/galleries` and `POST /api/galleries/:id/faces` enrollment endpoints
- [ ] Implement `GET /api/galleries/:id/search` 1:N FAISS cosine similarity search
- [ ] Implement `DELETE /api/galleries/:id/faces/:faceId` for GDPR right-to-erasure
- [ ] Implement face anonymization — Gaussian blur applied to `faceBbox` regions before Socket.IO emission
- [ ] Add `zone.privacyMode` field and conditional blur routing in `pipelineManager.js`
- [ ] Implement audit log for all gallery searches and identity matches
- [ ] Add RBAC checks: admin-only gallery management endpoints
- [ ] Add embedding retention period configuration with auto-purge cron job
- [ ] Source or train `age_gender_mobilenet.onnx` for Phase-2 optional attribute analysis
