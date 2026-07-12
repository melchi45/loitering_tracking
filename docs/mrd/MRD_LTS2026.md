# MARKET REQUIREMENTS DOCUMENT (MRD)
# Loitering Detection & Tracking System — LTS-2026

| | |
|---|---|
| **Document Reference** | MRD-LTS2026-001 |
| **Document Type** | Market Requirements Document |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-05-28 |
| **Review Cycle** | Quarterly |
| **Status** | **✅ Active — reflects Phase 1–11 delivered capabilities** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Market Problem](#2-market-problem)
3. [Market Opportunity](#3-market-opportunity)
4. [Target Market & Customer Segments](#4-target-market--customer-segments)
5. [Competitive Landscape](#5-competitive-landscape)
6. [Product Scope & Module Inventory](#6-product-scope--module-inventory)
7. [Business Requirements](#7-business-requirements)
8. [Market Use Cases](#8-market-use-cases)
9. [Regulatory & Compliance Requirements](#9-regulatory--compliance-requirements)
10. [Success Metrics (Market KPIs)](#10-success-metrics-market-kpis)
11. [Roadmap Alignment](#11-roadmap-alignment)
12. [Assumptions & Constraints](#12-assumptions--constraints)
13. [References](#13-references)

---

## 1. Executive Summary

**LTS-2026** is an AI-powered, multi-camera **Loitering Detection and Tracking System** built for security operations environments. It continuously ingests RTSP video streams from IP cameras, applies a multi-stage AI inference pipeline to detect persons and objects, tracks them with persistent identity across frames, and classifies loitering behavior using a composite behavioral risk score. Results are surfaced through a real-time web dashboard and a REST + WebSocket API.

The system addresses a clear market need: traditional CCTV monitoring is reactive, operator-dependent, and error-prone. LTS-2026 shifts surveillance from reactive review to **proactive automated alerting**, enabling security teams to respond before incidents escalate.

**Current maturity**: Phases 1–11 are complete, delivering a fully operational system including AI detection, multi-object tracking, behavioral analysis, cross-camera face Re-ID, user authentication, and a React management dashboard.

---

## 2. Market Problem

### 2.1 Core Problem

Physical security operations centers rely on human operators to watch live CCTV feeds. This creates four compounding problems:

| Problem | Industry Impact |
|---|---|
| **Operator fatigue** | Attention span drops ~50% after 20 minutes of continuous monitoring; critical incidents are missed |
| **Alert overload** | Traditional motion-detection systems generate excessive false alarms, leading to alert fatigue and ignored warnings |
| **Reactive posture** | Incidents are reviewed after the fact from recordings rather than being caught in real time |
| **Manual reporting** | Security reports require manual log review, consuming operator time and introducing documentation gaps |

### 2.2 Specific Pain Points by Stakeholder

| Stakeholder | Pain Point |
|---|---|
| Control-room operator | Cannot watch 16+ cameras simultaneously; relies on incident reports after the fact |
| Security manager | No visibility into behavioral patterns across shifts; can't enforce zone-specific policies programmatically |
| IT / System integrator | Proprietary VMS platforms lock customers into vendor ecosystems; REST API access is limited or expensive |
| Facilities manager | High cost of manned guard patrols; no objective data to justify staffing decisions |
| Privacy / compliance officer | Face recognition systems often lack GDPR-compliant data controls and audit trails |

### 2.3 Market Gap

Existing solutions fall into two categories:

1. **Enterprise VMS platforms** (Milestone, Genetec, AXIS Camera Station): Feature-rich but expensive (USD 200–800 per channel license), closed-source, require dedicated hardware appliances.
2. **Cloud-based video analytics SaaS** (BriefCam, Avigilon, Intellivision): Subscription-based, require cloud video upload (bandwidth, latency, privacy risk), limited on-premise deployment options.

**LTS-2026 fills the gap**: open-source-friendly, on-premise, edge-deployable, no per-channel license fee, REST API-first, and extensible with custom AI models.

---

## 3. Market Opportunity

### 3.1 Total Addressable Market (TAM)

The global **video surveillance market** was valued at approximately **USD 52 billion in 2024** and is projected to reach **USD 95 billion by 2030** (CAGR ~10.5%). The AI-powered video analytics sub-segment — where LTS-2026 competes — is growing faster at **CAGR ~23%**, driven by:

- Expansion of IP camera deployments (estimated 1 billion+ cameras globally by 2025)
- Increased adoption of edge AI inference (ONNX Runtime, NVIDIA Jetson)
- Regulatory pressure for proactive security compliance

### 3.2 Serviceable Addressable Market (SAM)

LTS-2026 targets deployments requiring **on-premise, real-time behavioral analytics** for **4–64 IP camera channels**, covering:

- Commercial properties: retail chains, office campuses, logistics hubs
- Public facilities: transit stations, hospitals, universities, government buildings
- Industrial sites: warehouses, construction sites, critical infrastructure perimeters
- Smart city / municipal surveillance

Estimated SAM: **USD 8–12 billion** (mid-market enterprise and SMB segments).

### 3.3 Serviceable Obtainable Market (SOM)

Targeting OEM partnerships with IP camera vendors (ONVIF ecosystem) and VMS integration partners:

- **Year 1**: 10–30 pilot deployments, 2–3 OEM partner agreements
- **Year 2**: 100+ production deployments, SDK licensing to 5+ integrators
- **Year 3**: Regional channel partner network across APAC / EMEA

---

## 4. Target Market & Customer Segments

### 4.1 Primary Segments

#### Segment A — Physical Security Operations
| Attribute | Detail |
|---|---|
| Profile | Enterprise security operations centers; 16–64 camera deployments |
| Decision maker | Chief Security Officer (CSO), Security Operations Manager |
| Key need | Real-time loitering alerts, behavioral pattern reports, zone-based policy enforcement |
| Budget | USD 10,000–100,000 per site (hardware + integration) |
| Geography | Global; initial focus APAC (Korea, Japan, Southeast Asia) |

#### Segment B — IP Camera OEM / System Integrators
| Attribute | Detail |
|---|---|
| Profile | Camera manufacturers (Hanwha Vision, Dahua, Hikvision, Axis) and VMS vendors embedding AI analytics |
| Decision maker | Product Manager, VP Engineering |
| Key need | Embeddable AI SDK, ONVIF compatibility, ONNX model portability, REST API |
| Budget | OEM licensing model; volume-based |
| Geography | Korea, China, Europe |

#### Segment C — Smart City / Municipal
| Attribute | Detail |
|---|---|
| Profile | City governments, transit authorities, police departments |
| Decision maker | CTO, Smart City Program Director |
| Key need | GDPR-compliant facial recognition, audit trails, multi-agency dashboard sharing, heatmap visualization |
| Budget | Government procurement; typically USD 50,000–500,000 per city zone |
| Geography | EU, APAC, Middle East |

#### Segment D — Industrial Safety
| Attribute | Detail |
|---|---|
| Profile | Manufacturing plants, logistics warehouses, oil & gas facilities |
| Decision maker | EHS (Environment, Health & Safety) Manager, Plant Operations Director |
| Key need | Hard hat / PPE compliance monitoring, intrusion detection in exclusion zones, RTSP-native operation |
| Budget | USD 5,000–50,000 per facility |
| Geography | Global industrial markets |

### 4.2 User Personas

| Persona | Role | Primary Need | Usage Frequency |
|---|---|---|---|
| **Alex** — Security Operator | Control-room analyst | Live loitering alerts with visual bbox overlay; quick camera-switching | Continuous (shift-based) |
| **Sam** — Security Administrator | Zone policy manager | Zone editor, AI attribute configuration, alert threshold tuning | Daily |
| **Jordan** — System Integrator | IT / DevOps | REST API integration, Docker deployment, ONVIF camera onboarding | Per-deployment |
| **Morgan** — Compliance Officer | Privacy / legal | GDPR data retention controls, face blur, audit log export | Weekly / quarterly |
| **Taylor** — Executive | CSO / VP Security | High-level dashboard KPIs, weekly reports, incident trend analysis | Weekly |

---

## 5. Competitive Landscape

### 5.1 Competitive Matrix

| Solution | On-Premise | Open API | Per-Channel Cost | AI Modules | Real-Time Loitering | Edge Deploy | Face Re-ID |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **LTS-2026** | ✅ | ✅ REST + WS | Free (OSS) | 11 modules | ✅ | ✅ ONNX | ✅ ArcFace |
| Milestone XProtect | ✅ | Limited | USD 200–800/ch | Add-on only | ❌ Plugin | ❌ | 3rd-party |
| Genetec Security Center | ✅ | Limited | USD 300–600/ch | Add-on | Partial | ❌ | 3rd-party |
| BriefCam (cloud) | Hybrid | Partial | USD 100–300/ch/mo | Yes | ✅ | ❌ | ✅ |
| Avigilon / Motorola | ✅ | Limited | Bundled HW | Yes | ✅ | Partial | ✅ |
| AWS Rekognition Video | ❌ Cloud | ✅ | USD 0.10/min | Limited | ❌ Batch | ❌ | ✅ |
| Azure Video Analyzer | ❌ Cloud | ✅ | Usage-based | Limited | ❌ | Edge (IoT) | Partial |
| Hanwha WiseNet AI | ✅ | Partial | Bundled HW | 5 modules | Partial | ✅ | ❌ |

### 5.2 Differentiation

LTS-2026's primary differentiators:

1. **No per-channel license fee** — deployable at any scale without escalating cost
2. **Modular AI pipeline** — 11 independently toggleable AI modules; enable only what you need
3. **Composite behavioral scoring** — 5-factor risk score (dwell / revisit / velocity / pacing / circular) beyond simple dwell-time threshold
4. **Cross-camera face Re-ID** — ArcFace 512-D embedding shared gallery; `face:reidentified` event in real time
5. **Edge-native ONNX** — all AI inference runs locally via ONNX Runtime (no cloud dependency)
6. **LLM integration via MCP** — natural language interaction with system data through Model Context Protocol server

---

## 6. Product Scope & Module Inventory

All modules defined below correspond to completed SDLC chains (RFP → PRD → SRS → Design → TC) in `docs/`.

### 6.1 Core System Modules

| Module | Document ID | Status | Description |
|---|---|:---:|---|
| Loitering Detection & Tracking | LTS-2026-001 | ✅ Phase 1–11 | End-to-end system — RTSP ingestion, MOT, behavioral scoring, dashboard |
| IP Camera Discovery | CAM-LTS2026-001 | ✅ Complete | UDP broadcast + ONVIF WS-Discovery; camera registration |
| Object Tracking (MOT) | TRK-LTS2026-001 | ✅ Complete | ByteTrack + 8-dim KF; 5-cue association; adaptive Kalman |
| Cross-Camera Face Tracking | XCAM-LTS2026-001 | ✅ Complete | Shared ArcFace gallery; `face:reidentified` Socket.IO event |
| Detection Snapshot & Search | SNAP-LTS2026-001 | ✅ Complete | JPEG crop per track bbox (640×640/q85); `GET /api/search`; fullscreen search UI |
| User Authentication | AUTH-LTS2026-001 | ✅ Complete | JWT RS256; RBAC; bcrypt; Google OAuth 2.0; admin approval workflow |
| Storage / MongoDB | STORE-LTS2026-001 | ✅ Complete | Dual-mode JSON + MongoDB 5.0; atomic write; debounced persistence |
| HTTPS / TLS | TLS-LTS2026-001 | ✅ Complete | TLS on port 3443; self-signed / mkcert / Let's Encrypt / reverse proxy |
| LLM / MCP Server | MCP-LTS2026-001 | ✅ Complete | stdio + HTTP/SSE MCP server; 21 tools; natural language dashboard query; 카메라 CRUD, ONVIF 이벤트, AI 감지 분석 (v1.1) |
| WebRTC Media Gateway | WRTC-LTS2026-001 | ✅ Complete | mediasoup SFU; STUN/TURN ICE; browser live video |
| STUN / TURN / ICE | ICE-LTS2026-001 | ✅ Complete | coturn; ICE candidate test suite; multi-subnet TURN |
| YouTube / RTSP Ingest | YT-LTS2026-001 | ✅ Complete | yt-dlp RTSP/HLS ingest; stream monitoring; auto-restart |

### 6.2 AI Detection Modules

| Module ID | AI Module | Model | Status | Zone Key |
|---|---|---|:---:|---|
| AI-01 | Human (Person) Detection | YOLOv8n ONNX COCO class 0 | ✅ Phase 1 | `human` |
| AI-02 | Vehicle Detection | YOLOv8n ONNX COCO classes 1,2,3,5,7 | ✅ Phase 1 | `vehicle` |
| AI-03 | Face Detection & Recognition | SCRFD-2.5G + ArcFace ResNet-50 | ✅ Phase 2 | `face` |
| AI-04 | Mask Detection | YOLOv8m PPE ONNX (mask/no_mask) | ✅ Phase 1 | `mask` |
| AI-05 | Color Analysis | Pixel-averaging HSV, 11 color classes | ✅ Phase 1 | `color` |
| AI-06 | Clothing Analysis | PromptPAR (PA100k, CLIP ViT-L) or OpenPAR (ResNet50) ONNX, admin-selectable, 26 attributes — PromptPAR memory-gated (auto-disables `cloth` if free RAM insufficient) | ✅ Phase 2 | `cloth` |
| AI-07 | Hat / Helmet Detection | YOLOv8m PPE ONNX (hardhat/no_hardhat) | ✅ Phase 1 | `hat` |
| AI-08 | Accessories Detection | YOLOv8n COCO (backpack/umbrella/handbag/tie/suitcase) | ✅ Phase 1 | `accessories` |
| AI-09 | Fire & Smoke Detection | YOLOv8s Fire/Smoke ONNX (3-class) | ✅ Phase 1 | `fire`, `smoke` |
| AI-10 | Animal Detection | YOLOv8n COCO (15 animal classes) | ✅ Phase 1 | `animal` |
| AI-11 | Mask Detection (Face) | PPE head-crop IoU matching | ✅ Phase 1 | `mask` |

### 6.3 Dashboard & UI Modules

| Module | Status | Description |
|---|:---:|---|
| Dashboard Layout | ✅ Complete | Responsive sidebar + camera grid; mobile-adaptive |
| Dashboard Detection Display | ✅ Complete | Real-time bbox overlay; detection panel; alert badges |
| Sidebar — Cameras | ✅ Complete | Camera list; add/remove; pipeline start/stop; status indicators |
| Sidebar — Alerts & Zones | ✅ Complete | Zone polygon editor; alert history; threshold configuration |
| Sidebar — Face ID | ✅ Complete | Named gallery enrollment; photo upload; live match alerts; Missing Persons |
| Stats Panel | ✅ Complete | Full-screen stats dashboard; drill-down navigation (Overview → Section → HourList → ItemDetail) |
| Search & Fullscreen | ✅ Complete | Full-screen search; type filter chips; date/time range; i18n |
| Mobile Layout | ✅ Complete | Touch-optimized responsive layout; swipe navigation |
| Fullscreen Camera View | ✅ Complete | 3-tab panel (Camera Events / ONVIF Timeline / Detections); real-time DetectionPanel (right); mobile-adaptive |
| Detections Timeline | ✅ Complete | Gantt-style ByteTracker lifecycle history (loitering-risk tracks only); zoom/pan; custom date range; detail-panel crop rendered `object-contain` (no cropping) |
| ONVIF Timeline (Custom Range) | ✅ Complete | Custom datetime-local range picker added to OnvifTimelineInline; SVG spinner; `Custom` button |

### 6.4 Planned Modules (Roadmap)

| Module | Target Phase | Planned Date | Milestone Ref |
|---|:---:|---|---|
| Video Recording (DVR/NVR) + Playback API | Phase 12 | Jul 28, 2026 | [M1, M2](../design/Design_RTSP_WebRTC_Architecture.md#milestone-1--영상-녹화-및-세그먼트-저장-p1) |
| Vector DB Face Re-ID (Qdrant/pgvector) | Phase 12b | Aug 11, 2026 | [M3](../design/Design_RTSP_WebRTC_Architecture.md#milestone-3--qdrant-벡터-db-기반-얼굴-re-id-고도화-p2) |
| Human Parsing 기반 정밀 색상 분류 (SCHP/SegFormer 모델 카탈로그, Phase-3) — ✅ 코드 구현 완료(opt-in, 2026-07-09) · K-Means 대표색 추출로 기존 고정 ROI 개선 (모델 불필요, Phase-1.5) — 📝 미구현 | Phase 12b-2 | 2026-07-09 (Phase-3) / TBD (Phase-1.5) | [Design_AI_Color_Analysis.md §10](../design/Design_AI_Color_Analysis.md#10-phase-3-proposed-architecture--human-parsing-model-catalog), [§11](../design/Design_AI_Color_Analysis.md#11-phase-15-proposed--k-means-dominant-color-on-the-existing-fixed-roi-no-model) |
| Appearance/Body Re-ID 임베딩 모델 + Vector DB 확장 (Qdrant `appearance_embeddings`, 얼굴용 M3와 별도 컬렉션) — ✅ 코드 구현 완료(opt-in, 2026-07-09), 장시간 재등장 조회(kNN)는 미배선 | Phase 12b-3 | 2026-07-09 | [Design_AI_AppearanceReID.md §12](../design/Design_AI_AppearanceReID.md#12-phase-2-개선-제안--실제-re-id-임베딩-모델-도입) |
| 카메라별 픽셀→실세계 미터 캘리브레이션 (Loitering 가이드 Rule 2 "0.2m/s", "3m" 실측 단위 대응) — 📝 미구현, Proposed | Phase 12b-4 | TBD | [SRS_LTS2026 §6](../srs/SRS_LTS2026_Loitering_Tracking_System.md#6-functional-requirements--loitering-detection) |
| 알림(Alert) 레코드 속성 첨부 — Loitering/Intrusion 알림에 색상(상의/하의) 첨부, 성별은 범위 외 (ReID·색상분석 가이드 §3 "이벤트 설명" 대응) — 📝 미구현, Proposed | Phase 12b-5 | TBD | [Design_AI_AppearanceReID.md §12.7](../design/Design_AI_AppearanceReID.md#127-reid_및_색상분석_활용가이드md-최종-정합성-확인-및-삭제-전-격차-재검토-2026-07-09) |
| RTCP Adaptive Streaming (PLI/NACK/REMB) | Phase 12c | Aug 25, 2026 | [M4](../design/Design_RTSP_WebRTC_Architecture.md#milestone-4--rtcp-피드백-처리-nack--pli--remb-p2) |
| Distributed Cluster Mode (Kafka + GPU Pool) | Phase 12d | Sep 8, 2026 | [M5](../design/Design_RTSP_WebRTC_Architecture.md#milestone-5--분산-클러스터-모드-p3) |
| PTZ Control (ONVIF) | Phase 13 | Sep 22, 2026 | — |
| Notification Hub (Email/SMS/Slack/Teams) | Phase 14 | Oct 6, 2026 | — |
| Heatmap & Path Visualization | Phase 15 | Oct 20, 2026 | [Loitering 가이드 §4 대응](../srs/SRS_LTS2026_Loitering_Tracking_System.md#6-functional-requirements--loitering-detection) — Track 좌표 누적 → Heatmap → 체류 밀집 구역 분석 |
| Advanced AI (Fall / Fight / Running) | Phase 16 | Nov 3, 2026 | — |
| Auto Reports (PDF / Excel) | Phase 17 | Nov 17, 2026 | — |
| Map Layout (Floor plan / Satellite) | Phase 18 | Dec 1, 2026 | — |
| Privacy & Audit (GDPR, Face Blur) | Phase 19 | Dec 15, 2026 | — |
| AI Model Management | Phase 20 | Jan 5, 2027 | — |
| Production Deployment Package | Phase 21 | Jan 19, 2027 | — |

---

## 7. Business Requirements

### 7.1 Deployment Model

| Requirement | Detail |
|---|---|
| BR-001 | System SHALL be deployable entirely on-premise with no mandatory cloud dependency |
| BR-002 | System SHALL support Docker Compose single-host deployment as the primary delivery format |
| BR-003 | System SHALL support ARM64 and x86-64 architectures (ONNX Runtime CPU mode as baseline) |
| BR-004 | System SHALL operate on commodity server hardware (minimum: 8-core CPU, 16 GB RAM, 100 Mbps NIC) |
| BR-005 | System SHALL remain operational without internet connectivity after initial model download |

### 7.2 Integration & Interoperability

| Requirement | Detail |
|---|---|
| BR-006 | System SHALL expose a documented REST API for all CRUD operations and analytics queries |
| BR-007 | System SHALL support Socket.IO WebSocket events for real-time alert streaming to third-party consumers |
| BR-008 | System SHALL be compatible with all ONVIF Profile S / Profile T compliant cameras |
| BR-009 | System SHALL provide an MCP server interface enabling LLM agents to query system state in natural language |
| BR-010 | System SHALL export alert data in JSON and CSV formats for integration with SIEM platforms |

### 7.3 Commercial Requirements

| Requirement | Detail |
|---|---|
| BR-011 | Core system SHALL be releasable under an open-source-compatible license enabling OEM embedding |
| BR-012 | System SHALL support multi-tenant configuration where each tenant manages its own camera pool and zones |
| BR-013 | Licensing model SHALL NOT impose per-channel fees in the base deployment tier |
| BR-014 | System SHALL provide an SDK / API surface sufficient for third-party plugin development (AI model upload, custom alert hooks) |

### 7.4 Support & Maintenance

| Requirement | Detail |
|---|---|
| BR-015 | System SHALL provide structured SDLC documentation (RFP/PRD/SRS/Design/TC) for each module |
| BR-016 | System SHALL maintain a test coverage target of ≥ 80% for Phase-1 REST API test scripts |
| BR-017 | System SHALL log all security-relevant events (authentication, admin actions, camera changes) to an immutable audit trail |

### 7.5 Storage & Startup Integrity

| Requirement | Detail |
|---|---|
| BR-018 | 운영자가 `DB_TYPE=mongodb`를 선택한 경우, 서버는 시작 시 MongoDB 연결 가능성을 반드시 검증해야 합니다 |
| BR-019 | `DB_TYPE=mongodb`에서 MongoDB 연결 불가 시, 서버는 즉시 종료(exit code 1)하고 진단 메시지를 출력해야 합니다. lts.json으로의 무음 fallback은 허용되지 않습니다 |
| BR-020 | `DB_TYPE=mongodb`에서 `MONGODB_URI`가 미설정된 경우, 서버 시작이 즉시 거부되어야 합니다 |

### 7.6 Operator UI — Timeline Readability

| Requirement | Detail |
|---|---|
| BR-021 | 전체화면 채널 뷰 하단의 **ONVIF Timeline 인라인 탭(`OnvifTimelineInline`)**, **ONVIF Timeline 오버레이(`OnvifTimelineOverlay`)**, **Detections Timeline(`DetectionsTimelineInline`)** 모두 각 행 좌측에 고정 폭 **Name 컬럼**을 표시해야 합니다. Name 컬럼은 행의 이름(이벤트 유형 / 객체 클래스)과 식별자(sourceToken · objectId · identity)를 운영자가 빠르게 식별할 수 있도록 제공해야 합니다 |
| BR-022 | 모든 ONVIF Timeline(인라인·오버레이) Name 컬럼 헤더는 "Name" sticky 레이블 행(22px)으로 표시되어야 하며, ONVIF Overlay 헤더 카메라 ID 뱃지는 카메라 표시 이름(displayName)을 우선 표시해야 합니다 |

### 7.7 ONVIF Event Lifecycle — Camera Disconnect

| Requirement | Detail |
|---|---|
| BR-023 | 카메라가 명시적으로 중지(stopCamera)될 때, 해당 카메라의 미결(state=true) ONVIF 이벤트는 자동으로 종료 처리되어야 합니다. 서버는 각 미결 이벤트에 대해 합성(synthetic) `state=false` 종료 이벤트를 DB에 삽입하고 Socket.IO로 브로드캐스트해야 합니다. 이를 통해 운영자는 카메라 연결 해제 후에도 ONVIF Timeline에서 이벤트가 무기한 "진행 중"으로 표시되는 현상을 방지할 수 있습니다 |

### 7.8 Timeline 2-Panel Overview & Collapse

| Requirement | Detail |
|---|---|
| BR-024 | **Detections Timeline(`DetectionsTimelineInline`)** 상단에 Overview strip(높이 50px)을 제공해야 합니다. Overview strip은 현재 뷰포트 내 모든 감지 트랙을 클래스별 색상 미니 바(높이 8px)로 오버레이 표시하며, 스크롤 휠로 줌 인/아웃을 제어합니다 |
| BR-025 | Overview strip 클릭(드래그 없음) 시 개별 트랙 행(Detail rows)을 접기/펼치기 토글할 수 있어야 합니다. 행이 접혀 있어도 Overview strip과 Tick 레이블(시간 눈금)은 항상 표시됩니다. 상세 패널(스냅샷 뷰어)은 행이 펼쳐져 있고 트랙이 선택된 경우에만 표시됩니다 |
| BR-026 | **ONVIF Timeline Inline(`OnvifTimelineInline`)** 도 동일한 2-panel 구조(Overview strip + Detail rows + 항상 표시 Tick labels)를 갖춰야 합니다. ONVIF Overview는 모든 이벤트 타입을 오버레이 표시하며, point 이벤트는 2px 수직 바, duration 이벤트는 8px 높이 미니 바로 렌더링합니다 |

### 7.9 Detection Crop Quality & Detail-View Rendering

| Requirement | Detail |
|---|---|
| BR-027 | 저장되는 감지 crop 이미지(`detectionSnapshots.cropData`)는 원본 영상 대비 시각적으로 뚜렷이 구분되는 저화질(블록·번짐)을 발생시키지 않아야 합니다. 서버는 `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY` 기본값을 640px/quality 85로 제공하며, 배포 환경별로 `.env`를 통해 조정할 수 있어야 합니다 |
| BR-028 | Crop을 확대(enlarge)하여 보여주는 모든 상세 뷰(Detections Timeline 우측 상세정보 패널 등)는 저장된 crop의 전체 영역을 잘림 없이 표시해야 합니다(`object-fit: contain`). 타임라인 필름스트립처럼 작은 고정 크기 마커로만 쓰이는 영역은 이 요구사항의 대상이 아닙니다 |

---

## 8. Market Use Cases

### UC-001 — Retail Theft Prevention
**Actor**: Retail chain security manager  
**Scenario**: A person enters a restricted stockroom corridor and lingers for more than 90 seconds. LTS-2026 detects the loitering event via AI-01 (Human), applies the composite risk score (dwell + pacing), and pushes an alert to the operator dashboard with a live video thumbnail.  
**Business Value**: Reduces shrinkage; enables remote multi-site monitoring without on-site guards.

### UC-002 — Transit Hub Perimeter Monitoring
**Actor**: Public transit authority  
**Scenario**: A person repeatedly enters and exits a restricted maintenance zone. LTS-2026 detects high revisit count and re-entry behavior via cross-ID appearance matching and increments the risk score accordingly.  
**Business Value**: Reduces unauthorized access incidents; documented evidence for law enforcement.

### UC-003 — Industrial PPE Compliance
**Actor**: Manufacturing plant EHS manager  
**Scenario**: Workers enter a construction zone without hard hats. AI-07 (Hat Detection) flags `safetyCompliant: false` on tracked individuals, triggering an alert and logging an evidence snapshot.  
**Business Value**: Demonstrates regulatory compliance; reduces workplace injury liability.

### UC-004 — Hospital / Healthcare Facility
**Actor**: Hospital security administrator  
**Scenario**: An unescorted visitor lingers near a medication storage room. AI-03 (Face) cross-references against the enrolled Missing Persons gallery and generates a Face ID match alert.  
**Business Value**: Patient and medication security; HIPAA-aligned access control documentation.

### UC-005 — Smart City / Municipality
**Actor**: Municipal surveillance command center  
**Scenario**: An operator asks the LLM-integrated MCP interface: *"How many loitering events occurred at Camera 3 last night after midnight?"* — the MCP server queries the analytics API and returns a structured natural language response.  
**Business Value**: Reduces operator training burden; enables NLP-driven incident investigation.

### UC-006 — Data Center / Server Room Security
**Actor**: IT security manager  
**Scenario**: After-hours access to a data center aisle triggers a loitering alert. The system cross-checks against user authentication logs and captures a detection snapshot for audit.  
**Business Value**: Zero-trust physical security posture; tamper-evident audit trail.

### UC-007 — OEM Camera Integration
**Actor**: IP camera manufacturer (e.g., Hanwha Vision)  
**Scenario**: Embed LTS-2026 AI analytics engine as an on-camera NVR analytics module, exposing a REST API to the manufacturer's VMS.  
**Business Value**: Adds AI behavioral analytics to existing camera hardware without additional servers.

---

## 9. Regulatory & Compliance Requirements

| Domain | Requirement | LTS-2026 Status |
|---|---|:---:|
| **GDPR (EU)** | Right to erasure — ability to delete specific face embeddings and detection snapshots | 🔲 Phase 19 |
| **GDPR** | Data retention controls — configurable snapshot retention period | 🔲 Phase 19 |
| **GDPR** | Face blurring / anonymization mode for jurisdictions prohibiting biometric processing | 🔲 Phase 19 |
| **NDAA (US)** | Prohibition on Huawei / Hikvision / Dahua hardware (procurement policy; software-agnostic) | N/A |
| **ONVIF Profile S/T** | Camera interoperability without proprietary SDKs | ✅ Implemented |
| **ISO 27001** | Audit logging of all authentication events | ✅ Phase 11 |
| **OWASP Top 10** | Security hardening — JWT RS256, bcrypt, HttpOnly cookies, HSTS, no SQL injection surface | ✅ Phase 11/16 |
| **CCPA (California)** | Biometric data disclosure and opt-out capability | 🔲 Phase 19 |
| **Korean PIPA** | Personal information processing policy; consent for face data collection | 🔲 Phase 19 |

---

## 10. Success Metrics (Market KPIs)

### 10.1 Technical Performance KPIs

| KPI | Target | Current Status |
|---|:---:|:---:|
| Concurrent camera channels supported | ≥ 16 | ✅ 9 active (tested) |
| AI inference latency per frame | ≤ 50 ms | ✅ ~25–35 ms (YOLOv8n CPU) |
| Person mAP@0.5 | ≥ 85% | ✅ YOLOv8n COCO ≥ 87% |
| Loitering alert false positive rate | ≤ 10% | 🔲 Benchmark pending (Phase 10) |
| System uptime (continuous operation) | ≥ 99.5% / 24h | ✅ Stable in dev environment |
| Face Re-ID cross-camera accuracy | ≥ 80% recall | ✅ ArcFace similarity ≥ 0.35 threshold |
| REST API p95 response time | ≤ 200 ms | ✅ Verified via test suite |

### 10.2 Business KPIs

| KPI | Year 1 Target | Measurement Method |
|---|:---:|---|
| Pilot deployments | ≥ 10 sites | Deployment registry |
| OEM partnership agreements | ≥ 2 | Signed MOUs |
| Phase-1 API test coverage | ≥ 80% pass rate | `node test/run_all.js` |
| SDLC documentation coverage | 100% modules | `docs/README.md` module table |
| GitHub repository stars | ≥ 500 | GitHub Insights |
| Community contributions (PRs merged) | ≥ 20 | GitHub contribution graph |

---

## 11. Roadmap Alignment

The following table maps planned market releases to engineering phases and target customer segments:

| Release | Phases | Target Date | Primary Customer Segment | Key Differentiator |
|---|---|:---:|---|---|
| **v1.0 — Core Platform** | 1–11 | May 28, 2026 | Security operations, OEM integrators | Full AI pipeline + auth + MongoDB |
| **v1.1 — Recording & Notifications** | 12–14 | Aug 25, 2026 | Retail, transit, industrial | DVR/NVR, Email/SMS/Teams alerts |
| **v1.2 — Analytics & Heatmaps** | 15–17 | Oct 6, 2026 | Smart city, municipal | Heatmap, path visualization, auto PDF reports |
| **v1.3 — Map & Privacy** | 18–19 | Nov 3, 2026 | EU/GDPR markets, healthcare | Floor plan layout, face blur, GDPR controls |
| **v2.0 — Production Release** | 20–21 | Dec 1, 2026 | All segments | AI model mgmt, OpenAPI docs, Prometheus metrics |

---

## 12. Assumptions & Constraints

### 12.1 Assumptions

| ID | Assumption |
|---|---|
| A-001 | Target deployment environments have at least one server with x86-64 CPU (AVX support required for MongoDB 5.0) and 16 GB RAM |
| A-002 | IP cameras are ONVIF Profile S or T compliant and accessible on the same LAN or via VPN |
| A-003 | Network bandwidth is sufficient for RTSP streams (≥ 2 Mbps per 1080p channel) |
| A-004 | ONNX Runtime CPU inference is acceptable for ≤ 16 cameras; GPU acceleration will be addressed in Phase 16 (Advanced AI) |
| A-005 | Google OAuth 2.0 is the primary social login provider; Microsoft Entra ID support is available but not configured by default |
| A-006 | MongoDB 5.0+ is available in the deployment environment, or the system falls back to JSON file storage |
| A-007 | The MCP Server is used for internal operator tooling and LLM integrations; it is not exposed to the public internet |

### 12.2 Constraints

| ID | Constraint |
|---|---|
| C-001 | All AI inference must run via ONNX Runtime in the Node.js process; no Python subprocess dependencies in v1.0 |
| C-002 | Real-time video is delivered over WebRTC (mediasoup); the system does not provide HLS/DASH VOD streaming in v1.0 |
| C-003 | Face recognition is limited to frontal faces with ≥ 40% visibility (SCRFD constraint) |
| C-004 | The system does not perform body-level Re-ID (FastReID/TorchReID) in v1.0; face-based ArcFace Re-ID is the current scope |
| C-005 | GDPR face anonymization and data retention controls are deferred to Phase 19 (v1.3) |
| C-006 | Deployment targets Ubuntu 18.04 LTS or later; Windows and macOS are development-only environments |

---

## 13. References

| Document | Path | Relationship |
|---|---|---|
| RFP — Loitering Tracking System | `docs/rfp/RFP_LTS2026_Loitering_Tracking_System.md` | Parent RFP |
| PRD — Loitering Tracking System | `docs/prd/PRD_LTS2026_Loitering_Tracking_System.md` | Product requirements |
| SRS — Loitering Tracking System | `docs/srs/SRS_LTS2026_Loitering_Tracking_System.md` | Software requirements spec |
| Design — Loitering Tracking System | `docs/design/Design_LTS2026_Loitering_Tracking_System.md` | Technical design |
| RFP — User Authentication | `docs/rfp/RFP_User_Authentication.md` | Auth module |
| RFP — Storage / MongoDB | `docs/rfp/RFP_DB_Layer.md` | Storage module |
| RFP — LLM / MCP Integration | `docs/rfp/RFP_LLM_MCP_Integration.md` | LLM integration |
| RFP — WebRTC Media Gateway | `docs/rfp/RFP_WebRTC_Media_Gateway.md` | Streaming module |
| RFP — Cross-Camera Face Tracking | `docs/rfp/RFP_CrossCamera_Face_Tracking.md` | Re-ID module |
| RFP — HTTPS / TLS | `docs/rfp/RFP_HTTPS_TLS.md` | Security module |
| RFP — Stats Panel | `docs/rfp/RFP_Stats_Panel.md` | Analytics UI |
| RFP — Detection Snapshot & Search | `docs/rfp/RFP_Detection_Snapshot_Search.md` | Evidence capture |
| Ops — MongoDB Setup | `docs/ops/MongoDB_Setup.md` | Deployment guide |
| Ops — HTTPS / TLS Setup | `docs/ops/HTTPS_TLS_Setup.md` | Deployment guide |
| Ops — MCP Server Setup | `docs/ops/MCP_Server_Setup.md` | Integration guide |
| Design — RTSP/WebRTC Architecture | `docs/design/Design_RTSP_WebRTC_Architecture.md` | 현재 ingest-daemon + MediaMTX WHEP 아키텍처 및 M1–M5 Milestone |
| RFP — RTSP/WebRTC Architecture | `docs/rfp/RFP_RTSP_WebRTC_Architecture.md` | 캡처 백엔드·릴레이·Object Storage·Vector DB 기술 선정 근거 |
| PRD — RTSP/WebRTC Architecture | `docs/prd/PRD_RTSP_WebRTC_Architecture.md` | M1–M5 제품 요구사항 |
| SRS — RTSP/WebRTC Architecture | `docs/srs/SRS_RTSP_WebRTC_Architecture.md` | 기능 요구사항 상세 명세 |
| TC — RTSP/WebRTC Architecture | `docs/tc/TC_RTSP_WebRTC_Architecture.md` | 테스트 케이스 33개 |
| Ops — RTSP/WebRTC Architecture Setup | `docs/ops/RTSP_WebRTC_Architecture_Setup.md` | ingest-daemon·MediaMTX·MinIO·Qdrant 운영 가이드 |
| Root README | `README.md` | System overview and quick start |
| SDLC Index | `docs/README.md` | Documentation hierarchy |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — MRD synthesized from all docs/rfp, docs/prd, and codebase status as of Phase 1–11 completion |
| 1.1 | 2026-06-11 | LTS Engineering Team | §6.4 Phase 12b/12c/12d 추가 (M3 Qdrant, M4 RTCP, M5 Cluster); §13 RTSP/WebRTC Architecture 문서 6종 참조 추가 |
| 1.2 | 2026-06-16 | LTS Engineering Team | §6.3 Fullscreen Camera View·Detections Timeline·ONVIF Custom Range 3개 모듈 신규 등재 (DetectionsTimelineInline + ByteTracker 생명주기 DB 저장 + detectionTracks API) |
| 1.3 | 2026-06-25 | LTS Engineering Team | §6.1 LLM/MCP 도구 수 15→21 업데이트 (카메라 CRUD 4종 + ONVIF 2종 + AI Detection 3종 + server status 1종 추가, MCP-LTS2026-001 v1.1) |
| 1.4 | 2026-06-26 | LTS Engineering Team | §7.5 Storage & Startup Integrity 추가: BR-018~020 — DB_TYPE=mongodb 시 MongoDB 필수 확인 + exit(1) |
| 1.5 | 2026-06-26 | LTS Engineering Team | §7.6 Operator UI — Timeline Readability 추가: BR-021~022 — ONVIF·Detections Timeline 좌측 Name 컬럼 요구사항 |
| 1.6 | 2026-06-26 | LTS Engineering Team | §7.7 ONVIF Event Lifecycle 추가: BR-023 — 카메라 연결 해제 시 미결 ONVIF 이벤트 자동 종료 요구사항 |
| 1.7 | 2026-06-26 | LTS Engineering Team | §7.6 BR-021~022 명세 보완 — `OnvifTimelineInline`(인라인 탭) 및 `OnvifTimelineOverlay` 모두 Name 컬럼 적용 대상 명시 |
| 1.8 | 2026-06-26 | LTS Engineering Team | §7.8 Timeline 2-Panel Overview & Collapse 추가: BR-024~026 — Detections·ONVIF Timeline Inline 2-panel 구조(Overview strip + Detail rows + 항상 표시 Tick labels) 및 접기/펼치기 요구사항 |
| 1.9 | 2026-07-09 | Youngho Kim | §6.4 로드맵에 Phase 12b-2(Human Parsing 색상 분류), Phase 12b-3(Appearance/Body Re-ID + Vector DB 확장) 2행 추가 — 4개 참고 가이드 문서 격차 분석 반영 |
| 1.10 | 2026-07-09 | Youngho Kim | 코드 동기화 — §6.4 Phase 12b-2/12b-3 완료일 반영 (Human Parsing·Appearance Re-ID 코드 구현 완료, opt-in; Phase-1.5·장시간 재등장 조회는 미구현으로 명시) |
| 1.11 | 2026-07-09 | Youngho Kim | §6.4 Heatmap & Path Visualization 행에 Loitering 가이드 §4 대응 관계 명시 — 원본 가이드 삭제 전 최종 반영 확인 |
| 1.12 | 2026-07-09 | Youngho Kim | §6.4 Phase 12b-2 행에 Phase-1.5(K-Means, 모델 불필요) 추가 — CCTV_IPTV_상의하의_색상분류_가이드.md 최종 반영 확인 |
| 1.13 | 2026-07-09 | Youngho Kim | 원본 가이드 `docs/rfp/CCTV_IPTV_상의하의_색상분류_가이드.md` 삭제 완료 — 내용 전체가 관련 Design 문서에 반영되었음을 확인 |
| 1.14 | 2026-07-09 | Youngho Kim | 이력 표 1.10 중복 버전 번호 정정(재번호); §6.4에 Phase 12b-4(카메라별 픽셀-미터 캘리브레이션, Proposed, 미구현) 로드맵 행 추가 — `Loitering_Detection_가이드.md` Rule 2 실측 단위 격차 대응 |
| 1.15 | 2026-07-09 | Youngho Kim | 원본 가이드 `docs/rfp/Loitering_Detection_가이드.md` 삭제 완료 — 내용 전체가 SRS §6, §6.4 로드맵 및 관련 RFP/PRD/Design/TC 문서에 반영되었음을 확인 |
| 1.16 | 2026-07-09 | Youngho Kim | §6.4에 Phase 12b-5(알림 레코드 속성 첨부, Proposed, 미구현) 로드맵 행 추가; 원본 가이드 `docs/rfp/ReID_및_색상분석_활용가이드.md` 삭제 완료 — 내용 전체가 Design_AI_AppearanceReID.md §12, SRS_CrossCamera_Face_Tracking.md §14, 관련 RFP/PRD/TC 문서에 반영되었음을 확인 |
| 1.17 | 2026-07-09 | LTS Engineering Team | §6.3/6.1 Detections Timeline·Detection Snapshot 설명에 화질 개선(640×640/q85) 반영; §7.9 신규 — BR-027~028 crop 화질 및 상세정보 패널 잘림 방지(`object-contain`) 요구사항 추가 |
| 1.18 | 2026-07-12 | LTS Engineering Team | AI-06 Clothing Analysis 행 갱신 — PromptPAR(PA100k, CLIP ViT-L)/OpenPAR(ResNet50) 2개 admin-selectable 모델 및 PromptPAR 사전 메모리 게이트(가용 RAM 부족 시 `cloth` 자동 비활성화) 반영 |
