# REQUEST FOR PROPOSAL (RFP)
# AI Module — Missing Person Detection

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-11 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | June 1, 2026 |
| **Proposal Deadline** | July 31, 2026 |
| **Zone Target Key** | `missing_person` |
| **Status** | **Implementation Complete** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Model Specification](#4-model-specification)
5. [Detection Classes](#5-detection-classes)
6. [Two-Stage Pipeline](#6-two-stage-pipeline)
7. [Integration Requirements](#7-integration-requirements)
8. [Performance Requirements](#8-performance-requirements)
9. [Evaluation Criteria](#9-evaluation-criteria)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for the **Missing Person Detection AI Module**, which identifies registered missing individuals from live camera feeds using facial recognition and appearance matching within the LTS-2026 Loitering Detection & Tracking System.

### 1.2 Scope

- Two-stage detection: person bbox → face crop → identity matching against missing person registry
- Face embedding comparison using cosine similarity (ArcFace/SCRFD pipeline)
- Per-zone activation: `"targetClasses": ["missing_person"]`
- Alert generation on match with configurable similarity threshold
- Real-time inference at 10 FPS per camera channel
- Registry management API: register, search, update status (MISSING / FOUND / UNCONFIRMED)
- Cross-camera tracking: unified person ID across multiple camera views

### 1.3 Zone Target Key

Zones configured with `"targetClasses": ["missing_person"]` activate missing person matching. Applicable in public spaces, transit hubs, shopping centers, building entrances, or any zone where persons of interest may appear.

---

## 2. Use Cases

| Use Case | Zone Type | Alert Condition |
|---|---|---|
| Child/elder missing in public | MONITOR | Face match ≥ similarity threshold |
| Fugitive / wanted person sighting | MONITOR | Face match + high-priority flag |
| Cross-camera re-identification | MONITOR | Same person detected across cameras |
| Historical footage search | REVIEW | Offline batch scan against registry |
| Combined: loitering + missing | MONITOR | Person loiters AND matches registry |

---

## 3. Technical Requirements

### 3.1 Missing Person Detection Capability

| Requirement | Specification |
|---|---|
| Target | Registered missing persons (face embedding match) |
| Minimum face size | 30×30 pixels in 1080p |
| Simultaneous persons | Up to 50 per frame |
| Detection speed | Per-frame, real-time at 10 FPS |
| Face angle tolerance | 0°–60° yaw, 0°–30° pitch |
| Match threshold (default) | cosine similarity ≥ 0.65 |
| Registry size | Up to 10,000 registered persons |

### 3.2 Input Specifications

| Stage | Input | Size |
|---|---|---|
| Stage 1: Person detection | Full JPEG frame | 1080p / 720p |
| Face crop extraction | Top 40% of person bbox | Variable |
| Stage 2: Face detection | Person head ROI | Variable |
| Stage 3: Embedding extraction | Aligned face crop | 112×112 px |
| Stage 4: Registry match | 512-d embedding vector | — |

### 3.3 Output Specifications

The `missingPersonMatch` attribute is emitted when a tracked person's face embedding matches a registry entry above the similarity threshold:

```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 120, "y": 60, "width": 80, "height": 200 },
  "confidence": 0.91,
  "missingPersonMatch": {
    "personId": "missing-person-uuid",
    "name": "홍길동",
    "similarity": 0.823,
    "status": "MISSING",
    "priority": "HIGH",
    "detectionId": "detection-event-uuid",
    "detectionStatus": "PENDING"
  },
  "isLoitering": false,
  "dwellTime": 3.2
}
```

| `missingPersonMatch.detectionStatus` | Meaning | UI badge |
|---|---|---|
| `PENDING` | Match detected, awaiting operator review | MATCH? (yellow) |
| `CONFIRMED` | Operator confirmed: same person | CONFIRMED (red) |
| `FALSE_POSITIVE` | Operator dismissed: different person | — (hidden) |

When `missingPersonMatch` is `undefined`, no match was found above the threshold for this tracked object.

---

## 4. Model Specification

### 4.1 Face Detection Model (Stage 1)

Reuse the face detection model from [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md):

| Model | Task | Size | Latency |
|---|---|---|---|
| SCRFD-2.5G | Face detection + 5 landmarks | ~2.5MB | ~3ms |
| SCRFD-500M | Lightweight face detection | ~1MB | ~2ms |
| YOLOv8n-face | Face/head detection | ~6MB | ~8ms |

**Selected**: SCRFD-2.5G (`scrfd_2.5g.onnx`) — already deployed

### 4.2 Face Recognition Model (Stage 2)

Reuse the recognition model from [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md):

| Model | Architecture | Accuracy (LFW) | Size | Latency/face |
|---|---|---|---|---|
| ArcFace w600k R50 | ResNet-50 + ArcFace | 99.77% | ~166MB | ~8ms |
| ArcFace w600k R34 | ResNet-34 + ArcFace | 99.65% | ~130MB | ~5ms |
| MobileFaceNet | MobileNet + ArcFace | 99.28% | ~4MB | ~2ms |

**Selected**: ArcFace w600k R50 (`arcface_w600k_r50.onnx`) — already deployed

### 4.3 Embedding Similarity

Cosine similarity between the detected face embedding $\mathbf{f}$ and registry embedding $\mathbf{r}$:

$$\text{similarity}(\mathbf{f}, \mathbf{r}) = \frac{\mathbf{f} \cdot \mathbf{r}}{\|\mathbf{f}\| \cdot \|\mathbf{r}\|}$$

| Similarity Range | Decision |
|---|---|
| ≥ 0.80 | High-confidence match → alert immediately |
| 0.65 – 0.79 | Probable match → alert with PENDING status |
| < 0.65 | No match |

---

## 5. Detection Classes

### 5.1 Person Status Values

| Status | Description | Registry Action |
|---|---|---|
| `MISSING` | Person is actively missing | Scan in all zones |
| `FOUND` | Person has been located | Stop scanning |
| `UNCONFIRMED` | Report received, not yet verified | Scan with LOW priority |

### 5.2 Detection Event Status

| Status | Source | Description | Alert |
|---|---|---|---|
| `PENDING` | Automatic match | Face similarity ≥ threshold | Yellow alert |
| `CONFIRMED` | Operator review | Operator confirms match | Red alert |
| `FALSE_POSITIVE` | Operator review | Operator dismisses match | No alert |

### 5.3 Priority Levels

| Priority | Description | Alert Behavior |
|---|---|---|
| `HIGH` | Urgent (child, medical emergency) | Immediate alert + sound |
| `MEDIUM` | Standard missing person | Alert without sound |
| `LOW` | Low urgency (e.g., unverified report) | Silent alert |

---

## 6. Two-Stage Pipeline

### 6.1 Pipeline Architecture

```
RTSP Frame (JPEG Buffer)
    │
    ▼ Primary Detection (YOLOv8n)
    │  [person bboxes]
    │
    ▼ Per-person: Face ROI Extraction
    │  head_bbox = {
    │    x: person.x + person.width * 0.10,
    │    y: person.y,
    │    width: person.width * 0.80,
    │    height: person.height * 0.40
    │  }
    │
    ▼ Face Detection (SCRFD-2.5G)
    │  Input: head ROI crop
    │  Output: [{faceBbox, landmarks, score}]
    │  → If no face detected: skip match (person turned away)
    │
    ▼ Face Alignment + Embedding (ArcFace R50)
    │  Input: 112×112 aligned face crop
    │  Output: 512-d float32 embedding vector
    │
    ▼ Registry Match (cosine similarity scan)
    │  For each MISSING person in registry:
    │    sim = cosine(detected_emb, registry_emb)
    │    if sim ≥ threshold: emit match event
    │
    ▼ Attach to tracked object
    │  { ..., missingPersonMatch: { personId, name, similarity, ... } }
    │
    ▼ Zone Check + Alert Generation
       if zone.targetClasses includes 'missing_person':
         if missingPersonMatch exists:
           emit 'missing_person_detected' alert
```

### 6.2 Face ROI Extraction

```javascript
function extractFaceRoi(personBbox) {
  return {
    x:      personBbox.x + personBbox.width  * 0.10,
    y:      personBbox.y,
    width:  personBbox.width  * 0.80,
    height: personBbox.height * 0.40,
  };
}
```

### 6.3 Registry Cache Strategy

- On server start: load all `MISSING` / `UNCONFIRMED` persons into in-memory cache
- Cache update: triggered on `register`, `update status` API calls
- Similarity scan: O(n) over cache — optimized with FAISS index for n > 1,000
- Deduplication: same `personId` + same camera frame → emit once per 30 seconds

---

## 7. Integration Requirements

### 7.1 Zone Configuration Extension

```json
{
  "id": "entrance-zone-uuid",
  "name": "Main Entrance",
  "type": "MONITOR",
  "targetClasses": ["human", "missing_person"],
  "missingPersonThreshold": 0.65,
  "dwellThreshold": 0,
  "minDisplacement": 0
}
```

### 7.2 Missing Person Registry Schema

```json
{
  "id": "uuid",
  "name": "홍길동",
  "age": 35,
  "gender": "male",
  "description": "검정 재킷, 청바지 착용",
  "photoUrl": "/uploads/missing/uuid.jpg",
  "faceEmbedding": [0.021, -0.043, ...],
  "status": "MISSING",
  "priority": "HIGH",
  "reportedAt": "2026-06-01T09:00:00Z",
  "reportedBy": "서울경찰청",
  "contactInfo": "02-1234-5678",
  "registeredAt": "2026-06-01T10:00:00Z",
  "updatedAt": "2026-06-01T10:00:00Z"
}
```

### 7.3 Alert Schema

```json
{
  "type": "missing_person_detected",
  "cameraId": "cam-entrance",
  "objectId": "track-uuid",
  "zoneId": "entrance-zone-uuid",
  "zoneName": "Main Entrance",
  "missingPersonId": "missing-person-uuid",
  "missingPersonName": "홍길동",
  "similarity": 0.823,
  "priority": "HIGH",
  "detectionStatus": "PENDING",
  "bbox": { "x": 120, "y": 60, "width": 80, "height": 200 },
  "faceBbox": { "x": 128, "y": 62, "width": 60, "height": 70 },
  "timestamp": 1748779200000,
  "thumbnail": "base64-jpeg"
}
```

### 7.4 REST API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/missing-persons` | Register missing person |
| `GET` | `/api/missing-persons` | Search registry (q, name, age, gender, status) |
| `PUT` | `/api/missing-persons/:id/status` | Update status (FOUND/MISSING/UNCONFIRMED) |
| `GET` | `/api/missing-persons/detections` | Query detection events (date, cameraId, status) |
| `PUT` | `/api/missing-persons/detections/:id/status` | Confirm / dismiss detection |
| `GET` | `/api/missing-persons/stats` | Statistics summary |

### 7.5 Socket.IO Event Extension

```json
{
  "event": "detections",
  "data": {
    "cameraId": "cam-01",
    "detections": [
      {
        "objectId": "uuid",
        "className": "person",
        "bbox": { "x": 120, "y": 60, "width": 80, "height": 200 },
        "confidence": 0.91,
        "missingPersonMatch": {
          "personId": "missing-person-uuid",
          "name": "홍길동",
          "similarity": 0.823,
          "status": "MISSING",
          "priority": "HIGH",
          "detectionId": "detection-event-uuid",
          "detectionStatus": "PENDING"
        },
        "isLoitering": false,
        "dwellTime": 3.2
      }
    ]
  }
}
```

### 7.6 MCP Tool Integration

Five MCP tools are registered in `mcp-server/tools/missing-person.js`:

| Tool Name | Access | Description |
|---|---|---|
| `register_missing_person` | write | Register a missing person profile |
| `search_missing_person` | read | Search registry by filters / free text |
| `get_missing_person_detections` | read | Retrieve detections by date and status |
| `update_missing_person_status` | write | Update status: FOUND / MISSING / UNCONFIRMED |
| `get_missing_person_statistics` | read | Registry and detection statistics |

MCP Resources:
- `missing-persons://registry` — Registry snapshot
- `missing-persons://detections/{date}` — Detections for a specific date

---

## 8. Performance Requirements

### 8.1 Match Accuracy

| Metric | Minimum | Target |
|---|---|---|
| True positive rate (TPR) | ≥ 92% | ≥ 97% |
| False positive rate (FPR) | ≤ 5% | ≤ 1% |
| False negative rate (FNR) | ≤ 8% | ≤ 3% |
| Rank-1 accuracy (CMC) | ≥ 95% | ≥ 99% |

### 8.2 Latency Budget

| Component | Maximum Latency |
|---|---|
| Face ROI extraction | < 1ms |
| Face detection (SCRFD) | < 3ms |
| Embedding extraction (ArcFace) | < 10ms |
| Registry scan (1,000 persons) | < 5ms |
| Registry scan (10,000 persons) | < 20ms (FAISS) |
| **Total per person** | **< 20ms** |
| **Total per frame (10 persons)** | **< 80ms** |

### 8.3 Operational Conditions

| Condition | Requirement |
|---|---|
| Illumination | 50–5,000 lux |
| Camera angle | 0°–60° elevation |
| Face size | ≥ 30×30 pixels in frame |
| Age range | 5–90 years |
| Photo quality (registry) | ≥ 200×200 pixels, frontal preferred |
| Time gap (photo vs live) | Up to 10 years |
| IR/night mode | Monochrome frames supported |

---

## 9. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Match accuracy (TPR/FPR) | 40% | Face recognition accuracy on LFW / IJB-C benchmarks |
| False positive rate | 25% | Incorrect match alerts in real camera footage |
| Latency per frame | 20% | Face detection + embedding + registry scan |
| Registry scalability | 10% | Performance with 1K / 10K registered persons |
| Integration | 5% | API alignment, MCP tool coverage, alert schema |

---

## 10. Appendix

### Appendix A: Benchmark Datasets

| Dataset | Instances | Notes |
|---|---|---|
| LFW (Labeled Faces in the Wild) | 13,233 faces | Face verification benchmark |
| IJB-C | 140K+ images | Cross-pose, age-gap evaluation |
| MegaFace | 1M+ faces | Large-scale face recognition |
| Internal CCTV dataset | 5,000+ frames | Site-specific collected data |

### Appendix B: Model File Placement

```
server/models/
├── yolov8n.onnx                  # Primary detection (existing)
├── scrfd_2.5g.onnx               # Face detection (existing)
└── arcface_w600k_r50.onnx        # Face recognition / embedding (existing)
```

No additional model files required — reuses the face recognition pipeline.

### Appendix C: Registry Storage

| Storage Mode | Description |
|---|---|
| JSON (default) | `storage/lts.json` → tables: `missing_persons`, `missing_person_detections` |
| MongoDB | Collections: `missing_persons`, `missing_person_detections` |

### Appendix D: Implementation Notes (Phase-1 Complete — June 1, 2026)

```
Service file:    server/src/services/missingPersonService.js
Router file:     server/src/api/missingPersons.js
MCP tools:       mcp-server/tools/missing-person.js
Test file:       test/api/missing-person.test.js

Models reused:
  - scrfd_2.5g.onnx        (FaceService — already loaded)
  - arcface_w600k_r50.onnx (FaceService — already loaded)

Implemented:
  - MissingPersonService singleton with in-memory registry cache
  - registerMissingPerson(): validates input, generates seeded 512-d embedding
    if no photo embedding provided, inserts into DB
  - matchFaces(detectedEmbedding): cosine similarity scan over MISSING registry
  - searchMissingPerson(criteria): filter by name, age, gender, status
  - getDetectionsByDate(date, options): query detection event log
  - updateMissingPersonStatus(id, newStatus): FOUND / MISSING / UNCONFIRMED
  - REST API: 6 endpoints under /api/missing-persons
  - MCP tools: 5 tools + 2 resources
  - DB tables: missing_persons, missing_person_detections (added to ALL_TABLES)
```

### Appendix E: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) | Person detection (upstream dependency) |
| [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md) | Face detection and embedding (shared pipeline) |
| [RFP_CrossCamera_Face_Tracking.md](RFP_CrossCamera_Face_Tracking.md) | Cross-camera person re-identification |
| [RFP_LLM_MCP_Integration.md](RFP_LLM_MCP_Integration.md) | MCP tool integration for LLM |

---

> **END OF DOCUMENT — LTS-2026-AI-11**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-06-01 | LTS Engineering Team | Initial release — RFP for AI Missing Person Detection |
