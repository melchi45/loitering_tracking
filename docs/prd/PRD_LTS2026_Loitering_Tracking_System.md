# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Loitering Detection & Tracking System

| | |
|---|---|
| **Document ID** | PRD-LTS-001 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_LTS2026_Loitering_Tracking_System.md |

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

Deliver an AI-powered end-to-end Loitering Detection and Tracking System that continuously analyzes multi-camera video feeds, automatically identifies individuals exhibiting anomalous dwell-time behavior, and generates actionable alerts — reducing operator cognitive burden and turning reactive CCTV monitoring into proactive intelligent surveillance.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Ingest video from at least 16 concurrent IP camera channels (RTSP/ONVIF) with hardware-accelerated decoding.
- **G2**: Detect persons and objects in real time using YOLOv8/RT-DETR with person mAP@0.5 ≥ 85% and inference latency ≤ 50 ms/frame.
- **G3**: Track objects across frames with stable ID assignment (HOTA ≥ 60, MOTA ≥ 70 on MOT17) using ByteTrack with 8-dim Kalman Filter.
- **G4**: Classify loitering behavior via a configurable composite risk score combining dwell time, revisit count, velocity, pacing, and circular motion.
- **G5**: Provide polygon-based zone management (≥ 50 zones per camera) with per-zone AI attribute target selection.
- **G6**: Deliver a management dashboard with live camera grid, alert history, zone editor, and reporting capabilities accessible via REST and WebSocket APIs.

### 2.2 Non-Goals

- **NG1**: Body-level Re-ID using FastReID or TorchReID (deferred to Phase 3; ArcFace face-based Re-ID is the current scope).
- **NG2**: Human segmentation masks via SAM or Mask2Former (infeasible at real-time throughput in the current Node.js/ONNX architecture).
- **NG3**: Multi-server distributed vector database (Redis Stack / Qdrant upgrade is a future scalability path, not a Phase 1 requirement).
- **NG4**: YOLOv11 or RT-DETR inference (ONNX stability unverified; YOLOv8n COCO is the target model).

---

## 3. User Personas

### Persona 1 — Security Operator
A control-room operator monitoring live feeds across multiple cameras. Needs real-time loitering alerts with visual overlays and audio notifications so they can dispatch a response without reviewing hours of footage.

### Persona 2 — Security Administrator
A security manager responsible for configuring monitored zones, alert thresholds, and escalation policies. Needs a zone editor, per-zone AI attribute configuration, and scheduled reporting.

### Persona 3 — System Integrator / IT Administrator
A technical user responsible for deploying and maintaining the system, integrating it with a VMS (Milestone, Genetec), and managing user roles. Needs REST APIs, webhook support, Docker packaging, and Prometheus health metrics.

---

## 4. Functional Specification

### 4.1 Video Ingestion

- Support RTSP, RTMP, HTTP(S), and local file/stream input.
- Compatible with ONVIF-compliant IP cameras.
- Minimum 16 concurrent channels; target 64.
- Resolution support up to 4K (4096×2160); frame rates 15–30 FPS with adaptive processing.
- Hardware-accelerated decoding via NVIDIA NVDEC, Intel QSV, or VA-API.

### 4.2 Object Detection Pipeline

- Primary model: YOLOv8n ONNX (COCO 80 classes).
- Pre-processing: resize to width=640 px (aspect-ratio preserved), letterbox pad to 640×640.
- Post-processing: inverse coordinate remap to source resolution; NMS (IoU threshold 0.50).
- Per-module selective inference gating: each AI module (person, vehicle, face, PPE, fire/smoke, etc.) individually enabled or disabled at runtime.

### 4.3 Multi-Object Tracking

- ByteTrack with 8-dimensional Kalman Filter (`[x, y, w, h, vx, vy, vw, vh]`).
- Adaptive process noise Q: stationary (×0.5), normal (×1.0), fast (×4.0), occlusion (predict freeze).
- Two-stage Hungarian assignment: high-confidence detections first, then low-confidence to lost tracks.
- Class-aware association: cross-class pairs hard-rejected (score = −1).
- `maxAge` = 90 frames (9 s at 10 FPS); runtime-configurable via `/api/tracker/config`.
- 5-cue weighted association score: IoU (λ=0.60) + ArcFace (λ=0.20) + Color (λ=0.12) + Cloth (λ=0.05) + Accessories (λ=0.03); weights normalized dynamically when a cue is absent.

### 4.4 Loitering Detection Logic

- Dwell time threshold: configurable per zone (default 30 s, range 5–600 s).
- Sliding-window displacement: 10-second rolling window (replaces from-first-position check).
- Pacing score: x-direction reversal count (`min(1, reversals / 10)`).
- Circular motion score: `max(0, 1 − straightLineDisplacement / totalPathLength)`.
- Re-entry / revisit count with configurable reentry window.
- Appearance-based cross-ID revisit detection: ArcFace primary (threshold 0.45), clothing color fallback; 2-minute appearance memory per zone.
- Composite risk score: `riskScore = min(1, dwell×0.35 + revisit×0.30 + lowVelocity×0.15 + pacing×0.12 + circular×0.08)`.
- Per-zone `minRiskScore` threshold for alert suppression (0.0–1.0).

### 4.5 Zone Management

- Polygon-based zone definition via drag-and-drop GUI canvas editor.
- Inclusion zones (monitor inside) and exclusion zones (ignore inside).
- Time-based zone activation scheduling (e.g., active 22:00–06:00).
- Minimum 50 configurable zones per camera feed.
- Per-zone AI attribute target selection: Human, Vehicle, Face, Mask, Color, Cloth, Hat, Accessories, Indoor/Office objects.

### 4.6 Per-Zone AI Attribute Detection

- Supported target classes: `human`, `vehicle`, `face`, `mask`, `color`, `cloth`, `hat`, `accessories`, and all 80 COCO indoor/office classes.
- Zone editor provides a checkbox grid; toggling a checkbox auto-saves without manual save action.
- Backward compatibility: zones without `targetClasses` monitor all supported classes.
- Model availability indicators show unavailable models as greyed-out.

### 4.7 Dashboard & UI

- Live multi-camera grid view with overlaid bounding boxes, track IDs, and class labels.
- Real-time loitering event log with thumbnail snapshots and risk score display.
- Zone drawing and configuration interface with full-viewport vertex drag.
- Alert history search with filter by camera, zone, time, and severity.
- User management with RBAC: Admin, Operator, Viewer roles.
- Dark mode and responsive design for desktop and tablet.

### 4.8 Alerting & Notifications

- In-app real-time alert with visual and audio notification.
- Email notification with event snapshot attachment.
- SMS / push notification via configurable webhook.
- VMS integration: Milestone XProtect, Genetec Security Center.
- Alert escalation policy and configurable cool-down period per zone.

### 4.9 Video Evidence Management

- Automatic pre/post event video clip capture (configurable buffer: 10–60 s).
- Clip storage in H.264/H.265 MP4 format.
- Evidence export with chain-of-custody metadata (SHA-256 hash).
- Cloud storage integration: AWS S3, Azure Blob, Google Cloud Storage.
- Retention policy with automatic archiving and deletion.

### 4.10 Reporting & Analytics

- Scheduled PDF/CSV reports: daily, weekly, monthly.
- Trend analysis: loitering frequency per zone, time-of-day patterns.
- Dashboard export to PNG/PDF.
- Custom report builder with date range and zone filters.

---

## 5. Technical Requirements

### 5.1 Runtime & Stack

| Layer | Technology |
|---|---|
| Language | Node.js (current server); Python 3.10+ (future AI worker) |
| Deep Learning Framework | ONNX Runtime (Node.js binding) |
| Inference Models | YOLOv8n ONNX (COCO), SCRFD-2.5G ONNX (face), ArcFace ResNet-50 ONNX, YOLOv8m PPE ONNX |
| Video Processing | FFmpeg / RTSPCapture |
| Backend API | Node.js + Express + Socket.IO |
| Frontend Dashboard | React 18+ with TypeScript |
| Database | SQLite (current) → PostgreSQL at 100+ cameras |
| Container | Docker + Docker Compose |

### 5.2 Performance Requirements

| KPI | Minimum | Target |
|---|---|---|
| End-to-end alert latency | ≤ 3 s | ≤ 1 s |
| System uptime (SLA) | 99.5% | 99.9% |
| Alert precision | ≥ 85% | ≥ 95% |
| Alert recall | ≥ 80% | ≥ 90% |
| Concurrent camera channels | ≥ 16 | ≥ 64 |
| Dashboard page load time | ≤ 3 s | ≤ 1 s |
| Event storage retention | 30 days | 90 days |

### 5.3 ONNX Thread Configuration

- Development: `ONNX_THREADS_DEV=1`, CPU provider.
- CUDA: `ONNX_CUDA=1`, `ONNX_THREADS_CUDA=1`, CUDA+CPU providers.
- Production: `ONNX_THREADS_PROD=0` → `max(2, min(8, floor(CPU_cores / 2)))`.
- Configurable via `server/.env`; applied in `server/src/utils/onnxOptions.js`.

### 5.4 Security Requirements

- End-to-end TLS 1.3 for all network communications.
- AES-256 encryption for stored video evidence.
- OWASP Top 10 compliance for web interfaces.
- GDPR/PDPA compliance: data anonymization and right-to-erasure support.
- Audit logging for all administrative actions.

### 5.5 Deployment Targets

| Mode | Hardware |
|---|---|
| Edge (on-premise) | NVIDIA Jetson Orin / AGX Xavier |
| Server GPU | NVIDIA RTX 4090 / A100 / H100 |
| Cloud | AWS EC2 G4dn / Azure NC-series |
| Hybrid | Edge + Cloud sync |

---

## 6. API / Interface Contract

### 6.1 REST Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/cameras` | List all registered cameras |
| `GET/POST` | `/api/zones` | List / create monitoring zones |
| `GET/PUT/DELETE` | `/api/zones/:id` | Read / update / delete a zone |
| `GET` | `/api/events` | Loitering event history (filterable) |
| `GET/PUT` | `/api/tracker/config` | Read / update tracker KF parameters |
| `POST` | `/api/tracker/config/reset` | Restore tracker defaults |
| `GET` | `/api/crosscamera/stats` | Cross-camera Re-ID transition statistics |
| `GET` | `/health` | System health check |

### 6.2 WebSocket (Socket.IO) Events

| Event | Direction | Payload |
|---|---|---|
| `frame:annotated` | Server → Client | Annotated frame with detection objects |
| `alert:loitering` | Server → Client | Loitering alert with risk score and snapshot |
| `face:reidentified` | Server → Client | Cross-camera Re-ID transition event |

### 6.3 Zone Configuration Schema

```json
{
  "zoneId": "zone-uuid",
  "cameraId": "cam-uuid",
  "name": "Entrance A",
  "type": "MONITOR",
  "polygon": [{"x": 100, "y": 150}, {"x": 400, "y": 150}],
  "dwellThreshold": 30,
  "minDisplacement": 50,
  "reentryWindow": 120,
  "minRiskScore": 0.0,
  "targetClasses": ["human", "vehicle"],
  "active": true
}
```

### 6.4 Loitering Alert Payload

```json
{
  "alertId": "uuid",
  "cameraId": "cam-uuid",
  "zoneId": "zone-uuid",
  "objectId": 42,
  "riskScore": 0.78,
  "dwellTime": 65,
  "revisitCount": 2,
  "snapshotUrl": "/evidence/alert-uuid.jpg",
  "timestamp": 1716015600000
}
```

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | System processes at least 16 concurrent RTSP camera streams without frame drops above 10%. |
| AC-02 | Person detection mAP@0.5 ≥ 85% on a representative test set; inference latency ≤ 50 ms/frame. |
| AC-03 | Object ID stability ≥ 95% for the same person in continuous view without occlusion. |
| AC-04 | Loitering alert fires within 3 seconds of the dwell threshold being exceeded. |
| AC-05 | Composite risk score is computed correctly for at least 5 behavioral scenarios (pacing, dwell, revisit, slow-velocity, circular). |
| AC-06 | Zone polygon editor supports at least 50 zones per camera; changes persist without server restart. |
| AC-07 | AI attribute toggles (per-module enable/disable) take effect on the next processed frame. |
| AC-08 | Alert notification is delivered via email and webhook within 10 seconds of alert generation. |
| AC-09 | Cross-camera Re-ID emits `face:reidentified` event when the same face transitions between cameras. |
| AC-10 | Dashboard page loads in ≤ 3 seconds on a 10 Mbps connection. |
| AC-11 | All API endpoints return responses in ≤ 500 ms under normal load. |
| AC-12 | Video evidence clips are stored in H.264 MP4 format with SHA-256 hash metadata. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Core detection + tracking pipeline (YOLOv8n + ByteTrack + KF) | Week 6 | May 2026 | ✅ Done |
| M2 | Behavior engine + zone manager + alert service | Week 10 | May 2026 | ✅ Done |
| M3 | Dashboard alpha + API gateway + DB schema | Week 14 | May 2026 | ✅ Done |
| M4 | Full system integration + VMS connectors + notifications | Week 18 | TBD | ⏳ Pending |
| M5 | UAT & QA — performance testing + security audit | Week 22 | TBD | ⏳ Pending |
| M6 | Production deployment + documentation + training | Week 24 | TBD | ⏳ Pending |

### 8.2 TODO

- [ ] Implement HOTA/MOTA/IDF1 benchmark evaluation on MOT17 dataset
- [ ] Add automated regression test suite (unit + integration) targeting > 80% code coverage
- [ ] Complete VMS webhook integration for Milestone XProtect and Genetec Security Center
- [ ] Implement heatmap visualization overlay (`/api/cameras/:id/heatmap`)
- [ ] Add crowd density filtering for loitering sensitivity adjustment (Phase 3)
- [ ] Implement body-level Re-ID embedding using FastReID or TorchReID (Phase 3)
- [ ] Add Prometheus metrics export endpoint and Kubernetes HPA support
- [ ] Generate OpenAPI 3.0 (Swagger) documentation for all REST endpoints
- [ ] Complete Docker multi-arch (amd64/arm64) image builds and Helm charts
- [ ] Implement PDF/CSV scheduled reporting pipeline
- [ ] Add retention policy management with automatic archiving and deletion
- [ ] Complete security audit and penetration testing prior to production acceptance

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for LTS2026 Loitering Tracking System |
