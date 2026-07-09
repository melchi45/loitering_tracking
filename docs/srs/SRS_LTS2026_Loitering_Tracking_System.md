# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# LTS-2026 Loitering Tracking System — Main System

| | |
|---|---|
| **Document ID** | SRS-LTS-MAIN-01 |
| **Version** | 1.2 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_LTS2026_Loitering_Tracking_System.md |
| **Parent RFP** | rfp/RFP_LTS2026_Loitering_Tracking_System.md |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Video Ingestion](#3-functional-requirements--video-ingestion)
4. [Functional Requirements — Object Detection](#4-functional-requirements--object-detection)
5. [Functional Requirements — Multi-Object Tracking](#5-functional-requirements--multi-object-tracking)
6. [Functional Requirements — Loitering Detection](#6-functional-requirements--loitering-detection)
7. [Functional Requirements — Zone Management](#7-functional-requirements--zone-management)
8. [Functional Requirements — Alert & Notification](#8-functional-requirements--alert--notification)
9. [Functional Requirements — Dashboard & UI](#9-functional-requirements--dashboard--ui)
10. [Functional Requirements — REST API](#10-functional-requirements--rest-api)
11. [Functional Requirements — Real-Time Events](#11-functional-requirements--real-time-events)
12. [Functional Requirements — Storage & Persistence](#12-functional-requirements--storage--persistence)
13. [Non-Functional Requirements](#13-non-functional-requirements)
14. [Interface Requirements](#14-interface-requirements)
15. [Constraints & Assumptions](#15-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS specifies the top-level, system-wide functional and non-functional requirements for the **LTS-2026 Loitering Detection and Tracking System**. It serves as the master requirements document, with per-subsystem SRS documents (Object Tracking, Face Recognition, etc.) providing detailed requirements for individual modules.

Each requirement is identified by a unique ID (FR-MAIN-NNN) traceable to acceptance criteria in PRD_LTS2026_Loitering_Tracking_System.md.

### 1.2 Scope

This document covers:

- Video ingestion from IP cameras (RTSP/ONVIF) and YouTube sources
- YOLOv8-based object detection pipeline
- ByteTrack multi-object tracking with Kalman Filter state estimation
- Composite risk-score-based loitering detection
- Polygon-based zone management (MONITOR and EXCLUDE types)
- Real-time alert generation and notification delivery
- React-based management dashboard
- REST API and Socket.IO real-time event interface
- JSON-file persistent storage (lts.json)
- LLM integration via MCP server (see SRS-LTS-MCP-01)

Out of scope: body-level Re-ID (FastReID/TorchReID), human segmentation masks, multi-server distributed vector databases, YOLOv11/RT-DETR inference.

### 1.3 Definitions

| Term | Definition |
|---|---|
| RTSP | Real Time Streaming Protocol — IP camera video streaming |
| ONVIF | Open Network Video Interface Forum — IP camera interoperability standard |
| MOT | Multi-Object Tracking — tracking multiple objects simultaneously across frames |
| ByteTrack | IoU-based multi-object tracker using Hungarian assignment |
| KalmanFilter | 8-dimensional linear state estimator for smooth track prediction |
| BehaviorEngine | Module computing dwell time, risk score, and loitering flag per tracked object |
| MONITOR zone | Zone where loitering dwell/risk logic is applied |
| EXCLUDE zone | Zone where all detections are suppressed |
| riskScore | Composite floating-point score [0, 1] indicating loitering risk |
| MCP | Model Context Protocol — LLM integration layer (separate process) |
| Socket.IO | WebSocket-based real-time event library |
| lts.json | JSON-file database storing all persistent system state |

---

## 2. System Overview

### 2.1 High-Level Component Pipeline

```
[IP Cameras / YouTube]
        │  RTSP / RTMP / HTTP
        ▼
[Video Ingestion Service]
   PipelineManager + RTSPCapture / YouTubeStreamService
        │  decoded frames (JPEG buffer, 10 FPS)
        ▼
[Object Detection — YOLOv8n ONNX]
   detection.js — 640×640 letterbox, NMS IoU 0.50
        │  detections: { bbox, class, confidence }[]
        ▼
[Attribute Enrichment — AttributePipeline]
   Face (SCRFD + ArcFace), PPE (YOLOv8m), Color, Cloth
        │  enriched objects with face embedding, color, hat, mask
        ▼
[Multi-Object Tracking — ByteTracker + KalmanFilter]
   tracking.js — 5-cue weighted score (IoU + Face + Color + Cloth + Acc)
        │  tracked objects: { objectId, bbox, class, trackLifetime }[]
        ▼
[Behavior Analysis — BehaviorEngine]
   behaviorEngine.js — dwell, revisit, velocity, pacing, circular, riskScore
        │  behavioral data per object
        ▼
[Zone Evaluation — ZoneManager]
   Ray-cast point-in-polygon, MONITOR/EXCLUDE logic, schedule check
        │  isLoitering, zoneId, dwellTime per object
        ▼
[Alert Service — AlertService]
   alertService.js — deduplication, persistence, notification
        │  loitering_alert events
        ▼
[Socket.IO Emission]    [REST API]          [Storage — lts.json]
  detections            /api/cameras         cameras, zones,
  loitering_alert       /api/events          events, alerts
  detections:summary    /api/alerts          faceGalleries
                        /api/zones
                        /api/tracker/config
        │
        ▼
[React Dashboard]
  Live camera grid, zone editor, alert panel, analytics, Face ID tab

        │  (separate process)
        ▼
[LTS MCP Server — mcp-server/]
  LLM tools and resources (see SRS-LTS-MCP-01)
```

### 2.2 Startup Sequence

1. `webrtcGateway.init()` — initialize mediasoup WebRTC gateway
2. `initDB()` — load/create `storage/lts.json`
3. Construct `ZoneManager`, `AlertService`, `PipelineManager`
4. Mount all REST API routes
5. `pipelineManager.loadFaceServiceEagerly()` — load SCRFD + ArcFace ONNX
6. `pipelineManager.reloadPersistentGallery()` — cache DB face embeddings
7. `YouTubeStreamService.init()` — restore YouTube cameras from DB
8. `httpServer.listen(PORT)` — begin serving (default port 3080)
9. Auto-start all enabled cameras from DB

---

## 3. Functional Requirements — Video Ingestion

### FR-MAIN-001 — RTSP Input

The system shall accept RTSP streams from ONVIF-compliant IP cameras via the `RTSPCapture` service. Connection parameters (URL, credentials) shall be stored in the database and survive server restart.

### FR-MAIN-002 — YouTube/HTTP Input

The system shall accept YouTube live stream URLs and HTTP(S) video URLs via the `YouTubeStreamService`. YouTube stream URL resolution (yt-dlp) shall be performed at stream start and cached for the session.

### FR-MAIN-003 — Concurrent Channels

The system shall support at least 16 concurrent camera pipelines, each processing independently.

### FR-MAIN-004 — Frame Rate Handling

Each pipeline shall target approximately 10 FPS for AI processing. Frames beyond the target rate shall be dropped to maintain pipeline throughput.

### FR-MAIN-005 — Pipeline Lifecycle

Each camera pipeline shall support independent start, stop, and restart operations without affecting other active pipelines. Pipeline status (`running`, `error`) shall be queryable via `GET /api/cameras`.

---

## 4. Functional Requirements — Object Detection

### FR-MAIN-010 — Primary Detection Model

The system shall use YOLOv8n ONNX (COCO 80-class) as the primary object detection model. The model shall be loaded at runtime from `server/models/yolov8n.onnx`.

### FR-MAIN-011 — Pre-Processing

Frames shall be:
1. Resized to width = 640 px (aspect ratio preserved).
2. Letterbox-padded to 640×640 with grey (0.5) fill.
3. Converted to float32 NCHW tensor normalized to [0, 1].

### FR-MAIN-012 — Post-Processing

Model outputs shall be:
1. Remapped from 640×640 space back to original frame resolution (inverse letterbox transform).
2. Filtered by NMS with IoU threshold 0.50.

### FR-MAIN-013 — Selective Inference Gating

Each AI sub-module (human, vehicle, face, mask, hat, color, cloth, fire/smoke, accessories) shall be independently enabled or disabled at runtime. Disabled modules shall skip inference entirely (no post-hoc filtering).

### FR-MAIN-014 — ONNX Thread Configuration

Thread count shall be configurable via environment variables:
- `NODE_ENV=development`: `ONNX_THREADS_DEV` (default 1), CPU provider.
- `ONNX_CUDA=1`: `ONNX_THREADS_CUDA` (default 1), CUDA + CPU providers.
- Production: `ONNX_THREADS_PROD=0` → `max(2, min(8, floor(CPU_cores / 2)))`.

---

## 5. Functional Requirements — Multi-Object Tracking

### FR-MAIN-020 — ByteTrack Algorithm

The system shall implement ByteTrack with IoU-based Hungarian assignment across all detected objects per frame.

### FR-MAIN-021 — Kalman Filter State

Each track shall maintain an 8-dimensional Kalman Filter state `[x, y, w, h, vx, vy, vw, vh]` for smooth prediction.

### FR-MAIN-022 — Persistent Object ID

Each track shall be assigned a UUID (`objectId`) at creation that persists through missed-frame buffering.

### FR-MAIN-023 — 5-Cue Association Score

Track-detection association shall use a weighted 5-cue score:
```
score = (λ_iou × IoU + λ_face × FaceSim + λ_color × ColorSim
       + λ_cloth × ClothSim + λ_acc × AccSim) / Σ(active λ)
```
Default weights: IoU=0.60, Face=0.20, Color=0.12, Cloth=0.05, Acc=0.03.
Weights shall be runtime-configurable via `PUT /api/tracker/config`. Class-mismatched pairs are hard-rejected (score = −1).

### FR-MAIN-024 — Adaptive Kalman Noise

Process noise Q shall scale dynamically:
- Fast motion (velocity > 30 px/f): Q × 4.0
- Stationary (velocity < 5 px/f): Q × 0.5
- Occluded (`framesWithoutHit > 1`): covariance × 3.0

### FR-MAIN-025 — Track Lost Buffer

Lost tracks (unmatched in a frame) shall be retained for a configurable `maxAge` (default 90 frames ≈ 9 s at 10 FPS) before pruning.

### FR-MAIN-026 — Cross-Camera Face Re-ID

A shared in-process face gallery (`_sharedFaceGallery`) shall maintain face embeddings across all active camera pipelines. When a face previously seen on camera A appears on camera B (cosine similarity ≥ 0.35), a `face:reidentified` Socket.IO event shall be emitted to all clients.

---

## 6. Functional Requirements — Loitering Detection

### FR-MAIN-030 — Dwell Time

The system shall compute dwell time as elapsed seconds since the object first entered the current zone visit, using real-world frame timestamps.

### FR-MAIN-031 — Sliding-Window Displacement

Displacement shall be computed over a 10-second rolling window, not from the zone entry point. An object pacing within a small area shall trigger loitering detection even if total path length is large.

### FR-MAIN-032 — Revisit Count

Re-entry of the same tracked object into a zone within the zone's `reentryWindow` seconds shall increment `revisitCount`.

### FR-MAIN-033 — Appearance-Based Cross-ID Revisit

When a new `objectId` enters a zone, the system shall check the zone's 2-minute appearance gallery for a prior face match (ArcFace cosine ≥ 0.45, primary) or clothing color match (fallback). A match pre-seeds `revisitCount = 1` to account for ID switches.

### FR-MAIN-034 — Pacing Score

`pacingScore = min(1, reversals / 10)` where `reversals` is the count of x-direction sign changes over the position history buffer.

### FR-MAIN-035 — Circular Score

`circularScore = max(0, 1 − straightLineDisplacement / totalPathLength)` computed over up to 300 frames.

### FR-MAIN-036 — Composite Risk Score

```
riskScore = min(1,
  (dwellTime / dwellThreshold)   × 0.35
  + min(revisitCount / 5, 1)     × 0.30
  + max(0, 1 − velocity / 80)    × 0.15
  + pacingScore                  × 0.12
  + circularScore                × 0.08
)
```

### FR-MAIN-037 — Loitering Flag

`isLoitering = true` when `dwellTime >= zone.dwellThreshold`, independent of `riskScore`.

### FR-MAIN-038 — Alert Suppression by Zone Risk Threshold

A zone's `minRiskScore` (0.0–1.0, default 0.0) gates loitering alert emission. Objects must satisfy both `isLoitering = true` and `riskScore >= minRiskScore` to trigger an alert.

### 가이드 대비 정합성 확인 (2026-07-09)

참고 가이드 `docs/rfp/Loitering_Detection_가이드.md`는 실무 권장 규칙으로 다음 3가지를 제시한다: Rule 1(체류시간 > 60초), Rule 2(체류시간 > 30초 AND 평균 속도 < 0.2m/s), Rule 3(ROI 재진입 횟수 > 5회). 현재 구현(FR-MAIN-030~038)은 이 3가지 규칙 요소를 모두 포함하며, 단순 AND 조건이 아니라 **가중 합산 리스크 점수**(FR-MAIN-036)로 통합해 오히려 가이드보다 더 세밀하게 처리한다:

| 가이드 규칙 | 현재 구현 대응 |
|---|---|
| Rule 1 — 체류시간 > 60초 | `zone.dwellThreshold` (FR-MAIN-037, `isLoitering` 판정 기준) |
| Rule 2 — 체류시간 + 평균 속도 | `riskScore`의 velocity 항(FR-MAIN-036, 15% 가중) — AND 조건 대신 연속 가중치로 대체 |
| Rule 3 — ROI 재진입 횟수 > 5회 | `revisitCount`/`reentryWindow` (FR-MAIN-032), `riskScore`의 25% 가중 |
| (가이드 미언급) | `pacingScore`(FR-MAIN-034), `circularScore`(FR-MAIN-035) — 가이드에 없는 추가 행동 패턴 신호 |

**결론**: 배회 감지 규칙 엔진은 가이드 대비 격차가 없으며, 오히려 초과 구현된 상태다. AI 기반 배회 감지(ST-GCN/Trajectory Transformer/ActionFormer)는 가이드 자체가 "실무에서는 과도한 경우가 많음"이라고 명시하므로 도입 제안에서 제외한다.

**Heatmap 기반 분석 (가이드 §4) — 별도 로드맵 항목으로 이미 존재, 미구현**: 가이드는 Track 좌표 누적 → Heatmap 생성 → 체류 밀집 구역 분석을 장기 통계/핫스팟 탐지 용도로 별도 제시한다. 이는 현재 FR-MAIN-030~038의 실시간 배회 판정과는 무관한 별개 기능이며, `docs/mrd/MRD_LTS2026.md` §6.4 로드맵에 "Heatmap & Path Visualization | Phase 15"로 이미 계획되어 있다 (Track 좌표는 이미 `pacingScore`/`circularScore` 계산용 position history buffer에 누적되고 있어 — FR-MAIN-034/035 — 재사용 가능한 데이터 소스가 이미 존재함). 별도 SRS 문서화는 Phase 15 착수 시점에 진행하며, 본 절에서는 가이드와의 대응 관계만 확인한다.

**Re-ID 적용 (가이드 §"Re-ID 적용") — 단일 카메라 내 occlusion 시 ID 유지**: 가이드는 "Tracking만 사용할 경우 가림(Occlusion)이나 재등장 시 ID가 변경될 수 있다"며 OSNet Re-ID를 통한 동일인 유지를 권장한다. 현재 FR-MAIN-033(Appearance-Based Cross-ID Revisit)이 이를 부분적으로 구현하고 있으나, 얼굴 매칭이 우선이고 실패 시 "의상 색상 매칭(fallback)"에 의존한다 — 이 fallback이 정확히 `Design_AI_AppearanceReID.md` §12에서 격차로 지적한 "색상만으로는 동일 제복 착용자 구분 불가" 문제를 그대로 안고 있다. 즉 §12에서 제안한 OSNet 임베딩 모델 도입은 크로스카메라 Re-ID뿐 아니라 FR-MAIN-033의 단일 카메라 내 occlusion 복원력도 함께 개선할 것으로 예상된다 — 별도 FR 추가 없이 교차참조로 기록한다.

---

## 7. Functional Requirements — Zone Management

### FR-MAIN-040 — Zone Types

The system shall support `MONITOR` zones (apply dwell/behavior logic) and `EXCLUDE` zones (suppress all detections; no events emitted).

### FR-MAIN-041 — Polygon Definition

Zones shall be defined as polygons of at least 3 `{x, y}` vertices. Zones with fewer than 3 points shall be rejected with HTTP 400.

### FR-MAIN-042 — Zone Scheduling

Zones may define a schedule (`startTime`, `endTime`, `days`). Outside the active schedule window, the zone shall not apply loitering logic.

### FR-MAIN-043 — Per-Zone Target Classes

Each zone may define a `targetClasses` array. Only objects of listed classes shall be evaluated for dwell/risk logic in that zone. Empty or absent `targetClasses` means all classes are monitored.

### FR-MAIN-044 — Zone Capacity

The system shall support at least 50 configurable zones per camera feed.

### FR-MAIN-045 — Zone Persistence

Zone creation, updates, and deletion shall be persisted to `lts.json` and survive server restart without re-configuration.

---

## 8. Functional Requirements — Alert & Notification

### FR-MAIN-050 — Loitering Alert Generation

The system shall emit a `loitering_alert` Socket.IO event within 500 ms of `isLoitering` transitioning to `true` for an object meeting the zone's `minRiskScore` threshold.

### FR-MAIN-051 — Alert Deduplication

The system shall not emit duplicate `loitering_alert` events for the same object and zone within a configurable cooldown window.

### FR-MAIN-052 — Alert Persistence

Each loitering alert shall be stored in `lts.json` with fields: `id`, `eventId`, `cameraId`, `objectId`, `zoneId`, `zoneName`, `type`, `dwellTime`, `timestamp`, `acknowledged`.

### FR-MAIN-053 — Alert Acknowledgment

An operator shall be able to acknowledge an alert via `POST /api/alerts/:id/acknowledge`. Acknowledged alerts shall be excluded from `GET /api/alerts?acknowledged=false`.

### FR-MAIN-054 — End-to-End Alert Latency

Time from dwell threshold crossing to `loitering_alert` Socket.IO emission shall not exceed 3 seconds under normal operating conditions.

---

## 9. Functional Requirements — Dashboard & UI

### FR-MAIN-060 — Live Camera Grid

The dashboard shall display a live multi-camera grid with annotated bounding boxes, track IDs, class labels, and loitering indicators overlaid on each video feed.

### FR-MAIN-061 — Zone Editor

The dashboard shall provide a drag-and-drop polygon canvas editor for creating and editing zones, supporting full-viewport vertex dragging and at least 50 zones per camera.

### FR-MAIN-062 — Alert Panel

The dashboard shall display a real-time alert log with camera, zone, dwell time, risk score, and acknowledgment controls.

### FR-MAIN-063 — AI Attribute Controls

The dashboard shall provide per-zone checkboxes to enable/disable individual AI attribute target classes. Toggle changes shall take effect on the next processed frame without server restart.

### FR-MAIN-064 — Video Analytics Sidebar

The dashboard shall provide a Video Analytics sidebar with tracker configuration controls (appearance weights, Kalman parameters) that map to `PUT /api/tracker/config`.

### FR-MAIN-065 — Face ID Tab

The dashboard shall provide a Face ID sidebar tab for gallery management, face enrollment, and live match monitoring (see SRS_AI_Face_Recognition.md for detailed requirements).

### FR-MAIN-066 — Internationalisation

The dashboard shall support at least 15 languages: en, ko, ja, zh-CN, zh-TW, es, fr, de, pt, ru, ar, hi, id, tr, vi.

---

## 10. Functional Requirements — REST API

### FR-MAIN-070 — Camera Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/cameras` | List all cameras with pipeline status |
| POST | `/api/cameras` | Register a new camera |
| GET | `/api/cameras/:id` | Get a single camera |
| PUT | `/api/cameras/:id` | Update camera configuration |
| DELETE | `/api/cameras/:id` | Remove a camera and stop its pipeline |
| POST | `/api/cameras/:id/start` | Start the camera pipeline |
| POST | `/api/cameras/:id/stop` | Stop the camera pipeline |

### FR-MAIN-071 — Zone Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/cameras/:id/zones` | List zones for a camera |
| POST | `/api/cameras/:id/zones` | Create a zone |
| PUT | `/api/cameras/:id/zones/:zoneId` | Update a zone |
| DELETE | `/api/cameras/:id/zones/:zoneId` | Delete a zone |

### FR-MAIN-072 — Events & Alerts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/events` | Query loitering events (filterable by camera, time, limit) |
| GET | `/api/alerts` | Query alerts (filterable by acknowledged, camera, limit) |
| POST | `/api/alerts/:id/acknowledge` | Acknowledge an alert |

### FR-MAIN-073 — Tracker Configuration

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/tracker/config` | Read current tracker parameters |
| PUT | `/api/tracker/config` | Update tracker parameters |
| POST | `/api/tracker/config/reset` | Reset tracker to defaults |

### FR-MAIN-074 — System

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | System health check |
| GET | `/api/capabilities` | AI module availability and status |
| GET | `/api/crosscamera/stats` | Cross-camera Re-ID transition statistics |

All REST endpoints shall respond within 500 ms under normal load. All success responses shall use the wrapper `{ success: true, data: ... }`. All error responses shall use `{ success: false, error: "<message>" }`.

---

## 11. Functional Requirements — Real-Time Events

### FR-MAIN-080 — `detections` Event

- **Direction**: Server → Client
- **Trigger**: Each processed frame per active camera
- **Payload**: `{ cameraId, timestamp, objects: [{ objectId, bbox, class, riskScore, dwellTime, isLoitering, face?, color?, mask?, hat? }] }`

### FR-MAIN-081 — `loitering_alert` Event

- **Direction**: Server → Client (broadcast to all connected clients)
- **Trigger**: `isLoitering` transitions to `true` and `riskScore >= zone.minRiskScore`
- **Payload**: `{ alertId, objectId, cameraId, zoneId, zoneName, dwellTime, riskScore, timestamp, bbox }`

### FR-MAIN-082 — `detections:summary` Event

- **Direction**: Server → Client
- **Trigger**: Each processed frame per active camera
- **Payload**: `{ cameraId, timestamp, activeCount, loiteringCount, zones: [{ zoneId, name, objectCount }] }`

### FR-MAIN-083 — `face:reidentified` Event

- **Direction**: Server → Client (broadcast)
- **Trigger**: Same face (cosine similarity ≥ 0.35) detected on a different camera than last seen
- **Payload**: `{ faceId, prevCameraId, newCameraId, newObjectId, similarity, timestamp }`

---

## 12. Functional Requirements — Storage & Persistence

### FR-MAIN-090 — JSON File Store

All persistent data shall be stored in `storage/lts.json` using the internal `db.js` module. Tables: `cameras`, `zones`, `events`, `alerts`, `faceGalleries`, `faceGalleryFaces`, `trackerConfig`.

### FR-MAIN-091 — Event Retention

Loitering events and alerts shall be stored indefinitely until explicitly deleted. The system shall provide query-time filtering by time range and camera to manage result set size.

### FR-MAIN-092 — Tracker Config Persistence

Tracker configuration (appearance weights, Kalman parameters) shall be persisted to `storage/tracker.json` and applied immediately without server restart.

---

## 13. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-MAIN-01 | Performance | End-to-end alert latency ≤ 3 s from dwell threshold crossing to Socket.IO emission |
| NFR-MAIN-02 | Performance | Detection inference latency ≤ 50 ms/frame on target hardware (YOLOv8n ONNX) |
| NFR-MAIN-03 | Performance | Dashboard page load time ≤ 3 s on a 10 Mbps connection |
| NFR-MAIN-04 | Performance | REST API response time ≤ 500 ms under normal load |
| NFR-MAIN-05 | Accuracy | Person detection mAP@0.5 ≥ 85% on a representative test set |
| NFR-MAIN-06 | Accuracy | Object ID stability ≥ 95% for same person in continuous view without occlusion |
| NFR-MAIN-07 | Accuracy | Alert precision ≥ 85%; alert recall ≥ 80% |
| NFR-MAIN-08 | Scalability | At least 16 concurrent camera pipelines without frame drops > 10% |
| NFR-MAIN-09 | Reliability | System uptime SLA ≥ 99.5% |
| NFR-MAIN-10 | Security | TLS 1.3 for all network communications in production |
| NFR-MAIN-11 | Compliance | GDPR right-to-erasure: face embeddings permanently deleted on API request |
| NFR-MAIN-12 | Maintainability | Unit + integration test suite targeting > 80% code coverage |

---

## 14. Interface Requirements

### 14.1 Video Input Interfaces

| Interface | Protocol | Notes |
|---|---|---|
| IP Camera (ONVIF) | RTSP | Credential-based; stored in DB |
| YouTube Live | HTTPS / yt-dlp | URL resolved at stream start |
| Local file/stream | HTTP / file:// | Test and development use |

### 14.2 Client Interfaces

| Interface | Technology | Notes |
|---|---|---|
| Dashboard | React 18+ TypeScript, Socket.IO client | Served at `/` from Express static |
| REST API | HTTP/JSON | Base path `/api/` |
| Real-time events | Socket.IO v4 | Port 3001 (same as HTTP) |

### 14.3 External Integrations (Phase 4+)

| Integration | Interface | Status |
|---|---|---|
| Milestone XProtect VMS | Webhook / SDK | Pending |
| Genetec Security Center | Webhook | Pending |
| Email notification | SMTP | Pending |
| Prometheus metrics | `/metrics` endpoint | Pending |
| LTS MCP Server | Node.js child process | Implemented (see SRS-LTS-MCP-01) |

---

## 15. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Storage backend is JSON file (`lts.json`); not suitable for > 100 cameras or > 1 M events without migration to PostgreSQL |
| C-02 | ONNX Runtime Node.js binding is required; GPU inference requires CUDA toolkit and matching onnxruntime-node build |
| C-03 | All frame processing is synchronous per pipeline; each camera pipeline runs in its own async loop |
| C-04 | Zone polygons are defined in the same pixel coordinate space as detection output (original frame resolution) |
| C-05 | Face Re-ID gallery is in-memory and resets on server restart; persistent cross-session identity requires DB enrollment |
| C-06 | Node.js single-process architecture limits true parallelism; GPU inference provides the primary throughput gain |
| C-07 | `objectId` uniqueness is guaranteed by UUID v4; IDs do not persist across server restarts |
| C-08 | YouTube stream URL resolution depends on yt-dlp being installed and accessible in PATH |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for LTS2026 Loitering Tracking System |
| 1.1 | 2026-07-09 | Youngho Kim | §6에 가이드(`Loitering_Detection_가이드.md`) 대비 정합성 확인 노트 추가 — 격차 없음, 오히려 초과 구현 확인 |
| 1.2 | 2026-07-09 | Youngho Kim | §6 정합성 노트에 Heatmap 분석(MRD Phase 15 교차참조) 및 FR-MAIN-033 occlusion 복원력(Design_AI_AppearanceReID.md §12 교차참조) 추가 — 원본 가이드 삭제 전 최종 반영 확인 |
