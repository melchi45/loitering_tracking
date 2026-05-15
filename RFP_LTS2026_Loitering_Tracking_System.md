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
- Cross-camera tracking support for overlapping FOV scenarios

### 2.4 Loitering Detection Logic

The loitering detection engine shall implement configurable behavioral analysis:

- **Dwell time threshold**: configurable per zone (default: 30 seconds, range: 5s–600s)
- **Spatial clustering**: detect stationary or low-displacement tracks
- **Speed and displacement analysis**: flag individuals with velocity < threshold in defined zones
- **Re-entry detection**: count and flag repeated entries within a time window
- **Crowd density filtering**: adjust sensitivity based on scene density
- **False alarm suppression**: ignore transient stops (traffic lights, phone use patterns)

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
