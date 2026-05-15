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

### 2.3 Multi-Object Tracking (MOT)

- Support state-of-the-art tracking algorithms: **ByteTrack**, **StrongSORT**, **DeepSORT**, **BoT-SORT**
- Persistent ID assignment across frames with re-identification (Re-ID)
- Track lifecycle management: initiation, maintenance, occlusion recovery, termination
- Tracking accuracy: **HOTA >= 60**, **MOTA >= 70** on MOT17 benchmark
- Trajectory smoothing and prediction using Kalman Filter or similar
- **Class-aware association**: IoU matching constrained to same object class — prevents ID theft between vehicles and persons ✅ *Implemented*
- Cross-camera tracking support for overlapping FOV scenarios *(TODO — Phase 3)*

#### 2.3.1 Current Implementation Status

| Feature | Status | Notes |
|---|:---:|---|
| ByteTrack (IoU-based) | ✅ | `server/src/services/tracking.js` |
| Class-aware IoU matching | ✅ | Same class required for association |
| 8-dim Kalman Filter | ✅ | [x,y,w,h,vx,vy,vw,vh] state vector |
| Adaptive Kalman (dynamic Q/R) | 🔲 TODO | NaN instability in near-singular matrix inversion |
| Multi-cue association (IoU + Appearance) | 🔲 TODO | Requires ArcFace embedding feedback loop into tracker |
| Cross-camera Re-ID | 🔲 TODO | Requires shared embedding store (Redis/Qdrant) |

### 2.4 Loitering Detection Logic

The loitering detection engine shall implement configurable behavioral analysis:

- **Dwell time threshold**: configurable per zone (default: 30 seconds, range: 5s–600s)
- **Spatial clustering**: detect stationary or low-displacement tracks
- **Speed and displacement analysis**: flag individuals with velocity < threshold in defined zones ✅ *Implemented*
- **Re-entry detection**: count and flag repeated entries within a time window ✅ *Implemented*
- **Revisit count**: increment counter each time object re-enters zone within `reentryWindow` ✅ *Implemented*
- **Circular motion pattern**: detect repetitive loop trajectories ✅ *Implemented*
- **Composite risk score**: weighted combination of dwell/revisit/velocity/circular ✅ *Implemented*
- **Crowd density filtering**: adjust sensitivity based on scene density *(TODO — Phase 3)*
- **False alarm suppression**: ignore transient stops *(TODO — configurable via minDisplacement)*

#### 2.4.1 Composite Risk Score Formula

```
riskScore = min(1,
  (dwellTime / dwellThreshold)     × 0.40   // how long vs. threshold
  + min(revisitCount / 5, 1)       × 0.30   // repeated zone entries (saturates at 5)
  + max(0, 1 − velocity / 80)      × 0.20   // low speed = high risk (80 px/s reference)
  + circularScore                  × 0.10   // loop / repetitive path indicator
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
| Class-aware IoU matching | P0 | ✅ Done | 1 line |
| Revisit count + re-entry window | P0 | ✅ Done | BehaviorEngine |
| Velocity + circular motion analysis | P0 | ✅ Done | BehaviorEngine |
| Composite risk score | P0 | ✅ Done | BehaviorEngine |
| Adaptive Kalman (motion-based Q/R) | P1 | 🔲 TODO | tracking.js — fix NaN in _inv4 |
| Multi-cue matching (IoU + appearance) | P1 | 🔲 TODO | Embed ArcFace into tracker feedback loop |
| Body-level ReID embedding (not face) | P2 | 🔲 TODO | FastReID or TorchReID (Python worker needed) |
| Human segmentation mask | P3 | 🔲 TODO | SAM/NanoSAM — GPU required for real-time |
| Cross-camera Re-ID | P3 | 🔲 TODO | Shared Redis/Qdrant embedding store |
| Heatmap visualization | P2 | 🔲 TODO | Canvas overlay, /api/cameras/:id/heatmap |
| Suspicious score threshold per zone | P1 | 🔲 TODO | Zone schema: `minRiskScore` field |

#### 2.4a.3 Adaptive Kalman Filter Specification *(TODO — P1)*

> **Status**: Blocked by near-singular matrix inversion NaN in `_inv4()` for small bboxes.  
> See `server/src/services/tracking.js` Track.predict() TODO comment.

Dynamic process noise Q adjustment:

```
if (velocity > 30 px/s):   Q *= 4    // fast moving — trust model less
if (velocity < 5 px/s):    Q *= 0.5  // stationary — tighten prediction
if (occluded):             covariance *= 3  // prediction dominant during occlusion
if (appearanceConf < 0.5): covariance *= 2  // weak appearance match
```

#### 2.4a.4 Multi-Cue Association Specification *(TODO — P1)*

> **Status**: Blocked by architecture — ArcFace embeddings computed post-tracking.  
> Fix: feed enriched object embeddings back into ByteTracker via `tracker.updateEmbeddings(enrichedObjects)`.

```
associationScore = 0.40 × IoU
                 + 0.40 × cosine_similarity(arcface_embedding_A, arcface_embedding_B)
                 + 0.20 × attribute_similarity(color_A, color_B)
```

#### 2.4a.5 Out-of-Scope Items *(Current Architecture)*

The following items from the Adaptive Loitering Detection RFP are **not feasible** within the current Node.js/ONNX single-server architecture:

| Item | Reason | Alternative |
|---|---|---|
| Human Segmentation (SAM, Mask2Former) | ~500ms/frame CPU — blocks 10 FPS pipeline | Use bbox ROI; consider NanoSAM on GPU Phase-3 |
| Python AI Worker | Major rewrite; IPC overhead | Current ONNX Runtime in Node.js sufficient |
| PostgreSQL + Redis + Milvus | Over-engineered for ≤ 16 cameras | SQLite (current) → PostgreSQL at 100+ cameras |
| YOLOv11 / RT-DETR | ONNX stability unverified | YOLOv8n COCO (current) performs well |
| Body-level FastReID / TorchReID | PyTorch-only Python libs | ArcFace via ONNX covers face-based Re-ID |

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
| Human | `human` | YOLOv8n ONNX (COCO class 0: person) | **Available** |
| Vehicle | `vehicle` | YOLOv8n ONNX (COCO classes: bicycle/1, car/2, motorcycle/3, bus/5, truck/7) | **Available** |
| Face | `face` | Dedicated face detection model (e.g., RetinaFace / YOLOv8-face) | Planned |
| Mask | `mask` | Attribute classifier (head-crop ROI → mask/no-mask) | Planned |
| Color | `color` | Appearance attribute model (upper/lower body color) | Planned |
| Cloth | `cloth` | Clothing type/style attribute model | Planned |
| Hat | `hat` | Head-accessory attribute model | Planned |
| Accessories | `accessories` | General accessory attribute model | Planned |

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
  "targetClasses": ["human", "vehicle"],
  "active": true
}
```

#### 2.6.5 Functional Requirements for AI Attribute Selection

- **Zone Editor UI**: Per-zone checkbox grid to select/deselect each AI attribute target
- **Immediate persistence**: toggling a checkbox auto-saves to the backend without requiring a manual save action
- **Backward compatibility**: zones without `targetClasses` (or with an empty array) monitor all supported classes
- **Planned model indicators**: unavailable models shown as greyed-out in the UI with a "준비중" (in preparation) badge
- **Real-time filter**: the behavior engine applies `targetClasses` filter each frame — no restart required

#### 2.6.6 Indoor / Office Object Detection ✅ *Implemented*

YOLOv8n COCO 80-class 모델은 사람·차량 외에 사무 환경의 다양한 실내 객체를 즉시 감지할 수 있습니다. 추가 모델 설치 없이 활성화됩니다.

**지원 실내 / 사무 객체 클래스**

| 한국어 | COCO 클래스명 | targetClass ID | 색상 코드 | 상태 |
|---|---|---|---|:---:|
| 의자 | `chair` | `chair` | violet `#8b5cf6` | ✅ |
| 소파 | `couch` | `couch` | violet-400 `#a78bfa` | ✅ |
| 책상/탁자 | `dining table` | `diningtable` | emerald `#10b981` | ✅ |
| 침대 | `bed` | (furniture 그룹) | indigo `#6366f1` | ✅ |
| TV/모니터 | `tv` | `tv` | sky `#0ea5e9` | ✅ |
| 노트북 | `laptop` | `laptop` | cyan `#06b6d4` | ✅ |
| 마우스 | `mouse` | `mouse` | amber-300 `#fbbf24` | ✅ |
| 키보드 | `keyboard` | `keyboard` | pink `#ec4899` | ✅ |
| 휴대폰 | `cell phone` | `cellphone` | red-400 `#f87171` | ✅ |
| 시계 | `clock` | `clock` | emerald-400 `#34d399` | ✅ |
| 컵 | `cup` | `cup` | orange `#fb923c` | ✅ |
| 병 | `bottle` | `bottle` | lime `#a3e635` | ✅ |
| 책 | `book` | `book` | violet-300 `#c4b5fd` | ✅ |
| 화병 | `vase` | (default) | pink-400 `#f472b6` | ✅ |
| 리모컨 | `remote` | (default) | gray-300 `#d1d5db` | ✅ |

**그룹 targetClass 매핑**

```
furniture  → chair, couch, dining table, bed
computer   → laptop, tv, keyboard, mouse, cell phone
```

**활용 시나리오**

| 시나리오 | Zone 설정 | 설명 |
|---|---|---|
| 자산 도난 방지 | `laptop`, `keyboard`, `clock` | 사무기기 구역 내 미등록 반출 감지 |
| 책상 점유 감지 | `diningtable`, `chair` | 회의실·카페 내 장시간 점유 체류 경보 |
| 분실물 탐지 | `bottle`, `cup`, `book` | 지정 구역 내 물건 장시간 정치 감지 |
| 컴퓨터 보안 구역 | `computer` | 컴퓨터 주변 비인가 접근 감지 |
| 스마트폰 반입 금지 구역 | `cellphone` | 보안 구역 내 휴대폰 소지 감지 |

**시각적 표현 사양**

- Bounding box: 각 클래스별 고유 색상 (위 표 참조), 실선 2px
- 라벨: `className #objectId  confidence%` 형식
- Detection 패널: 클래스별 색상 코드 표시
- Zone 편집기: "실내/사무 객체" 그룹으로 분류하여 표시

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
