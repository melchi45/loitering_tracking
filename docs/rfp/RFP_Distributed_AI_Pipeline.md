# RFP — Distributed AI Pipeline (스트리밍 서버 / AI 분석 서버 분리)

| | |
|---|---|
| **Document ID** | RFP-LTS-DAP-01 |
| **Version** | 1.0 |
| **Date** | 2026-06-08 |
| **Project** | Loitering Detection & Tracking System (LTS-2026) |
| **Status** | Draft |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement — 현재 아키텍처의 한계](#2-problem-statement--현재-아키텍처의-한계)
3. [Proposed Architecture](#3-proposed-architecture)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Technical Evaluation Criteria](#6-technical-evaluation-criteria)
7. [Out of Scope](#7-out-of-scope)
8. [Related Documents](#8-related-documents)
9. [Glossary](#9-glossary)

---

## 1. Overview

LTS-2026 시스템은 현재 단일 Node.js 서버 프로세스에서 다음 세 가지 역할을 동시에 수행합니다:

1. **카메라 스트림 캡처** — RTSP/ONVIF 카메라로부터 JPEG 프레임 수집 (FFmpeg / GStreamer / PyAV 백엔드)
2. **AI 추론** — YOLOv8 ONNX 감지 → ByteTrack 추적 → BehaviorEngine 배회 점수 산출 → 속성 분석(의상·색상·PPE)
3. **WebRTC 스트리밍** — mediasoup SFU를 통해 브라우저 클라이언트에 H.264 비디오·JPEG 프레임 전송

이 구조는 단일 머신에서는 효율적이지만, **AI 추론은 GPU 가속이 필요한 고비용 연산**으로서 스트리밍 레이턴시와 GPU 리소스를 경쟁적으로 소비합니다. 본 RFP는 `SERVER_MODE` 환경변수를 통해 **스트리밍 서버**와 **AI 분석 서버**를 선택적으로 분리 배포할 수 있는 Distributed AI Pipeline 기능 도입을 요청합니다.

---

## 2. Problem Statement — 현재 아키텍처의 한계

### 2.1 현재 데이터 플로우

```
[IP Camera]
    │  RTSP
    ▼
[Node.js 단일 서버]
    ├─ FFmpeg subprocess (JPEG 추출)
    ├─ YOLOv8 ONNX 추론 (CPU/GPU)
    ├─ ByteTrack + BehaviorEngine
    ├─ Socket.IO JPEG 전송 → 브라우저
    └─ mediasoup SFU → 브라우저
```

### 2.2 확인된 문제점

| 문제 | 설명 |
|---|---|
| **GPU 리소스 경쟁** | AI 추론(CUDA)과 WebRTC 미디어 인코딩이 동일 GPU를 경쟁적으로 사용하여 프레임 드롭 및 추론 지연 발생 |
| **수평 확장 불가** | 카메라 수 증가 시 스트리밍 서버를 복제해도 AI 추론 부하가 함께 확장되어 GPU 서버 비용 급증 |
| **GPU 서버 분리 불가** | 고성능 GPU 서버(A100, H100)를 AI 전용으로 배치하고 저비용 CPU 서버에서 스트리밍을 처리하는 구성이 불가 |
| **단일 장애점** | AI 추론 오류(ONNX 크래시 등)가 스트리밍 서비스 전체를 중단시킬 수 있음 |
| **네트워크 최적화 한계** | 스트리밍과 AI 추론 결과 전달이 같은 프로세스 내 메모리 호출로만 가능하여 분산 배치 시 IPC 오버헤드 불가피 |

---

## 3. Proposed Architecture

### 3.1 세 가지 운영 모드

`server/.env`의 `SERVER_MODE` 환경변수로 모드를 선택합니다.

```
SERVER_MODE=combined   # (기본값) 현재 동작 유지 — 하위 호환
SERVER_MODE=streaming  # 스트리밍 전담 서버
SERVER_MODE=analysis   # AI 추론 전담 서버
```

### 3.2 분리 배포 구성도

```
┌─────────────────────────────────────────────────────┐
│              STREAMING SERVER (CPU 서버)              │
│  SERVER_MODE=streaming                               │
│                                                       │
│  [RTSP Camera] → FFmpeg → JPEG 프레임                │
│       │                                               │
│       ├─ HTTP POST /api/analysis/frame  ──────────►  │
│       │         (Base64 JPEG + zones)                │
│       │                                               │
│  ◄────┤  HTTP 200 JSON (detections + behaviors)      │
│       │                                               │
│       └─ WebRTC/Socket.IO → [Browser Client]         │
└─────────────────────────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   ANALYSIS SERVER   │
              │   (GPU 서버)        │
              │  SERVER_MODE=       │
              │     analysis        │
              │                     │
              │  /api/analysis/frame│
              │  YOLOv8 ONNX (CUDA) │
              │  ByteTrack          │
              │  BehaviorEngine     │
              │  AttributePipeline  │
              │  FireSmokeService   │
              └─────────────────────┘
```

### 3.3 통신 프로토콜

**Streaming → Analysis (HTTP POST):**
```json
{
  "cameraId": "uuid",
  "frameId": 123,
  "timestamp": "2026-06-08T10:00:00.000Z",
  "frame": "<base64 JPEG>",
  "zones": [...zone objects...],
  "analyticsConfig": { "detection": true, "behavior": true }
}
```

**Analysis → Streaming (HTTP 200 JSON):**
```json
{
  "cameraId": "uuid",
  "frameId": 123,
  "timestamp": "2026-06-08T10:00:00.000Z",
  "detections": [...],
  "tracked": [...],
  "behaviors": [...],
  "fireSmoke": [...]
}
```

---

## 4. Functional Requirements

### 4.1 핵심 기능 요구사항

| ID | 요구사항 | 우선순위 |
|---|---|---|
| FR-DAP-01 | `SERVER_MODE` 환경변수로 `combined` / `streaming` / `analysis` 세 모드 중 하나를 선택 가능해야 한다. | Must |
| FR-DAP-02 | `combined` 모드에서는 현재 동작과 완전히 동일하게 동작해야 한다 (하위 호환). | Must |
| FR-DAP-03 | `streaming` 모드에서는 각 카메라 프레임을 `ANALYSIS_SERVER_URL`로 HTTP POST 전송해야 한다. | Must |
| FR-DAP-04 | `analysis` 모드에서는 `POST /api/analysis/frame` 엔드포인트를 통해 추론 요청을 처리해야 한다. | Must |
| FR-DAP-05 | `streaming` 모드에서 분석 서버가 응답하지 않을 경우, 스트리밍은 중단 없이 계속되어야 한다 (graceful degradation). | Must |
| FR-DAP-06 | `analysis` 모드에서 카메라별 ByteTracker 및 BehaviorEngine 상태를 독립적으로 메모리에 유지해야 한다. | Must |
| FR-DAP-07 | 동시 분석 요청 수가 `ANALYSIS_MAX_CONCURRENT` 한도를 초과하면 해당 프레임을 드롭(백프레셔)해야 한다. | Must |
| FR-DAP-08 | `analysis` 모드에서 5분간 프레임이 수신되지 않은 카메라의 상태(tracker, behavior context)를 자동 정리해야 한다. | Should |
| FR-DAP-09 | `GET /api/analysis/health` 엔드포인트로 분석 서버 상태를 조회할 수 있어야 한다. | Should |
| FR-DAP-10 | `streaming` 모드에서 분석 결과를 받아 WebRTC/Socket.IO 스트림에 오버레이로 합성해야 한다. | Must |
| FR-DAP-11 | Startup TC 실행기(`TcRunnerService`)는 `SERVER_MODE=streaming` 시 AI 전용 테스트 스위트(`ai_detection_modules`, `analytics_config`, `model_catalog`)를 실행하지 않고 `skip` 상태로 DB에 저장해야 한다. 해당 스위트는 Admin Dashboard Audit UI에서도 숨겨야 한다. | Must |

### 4.2 신규 생성 파일

| 파일 | 역할 |
|---|---|
| `server/src/services/analysisClient.js` | streaming 서버에서 analysis 서버로 HTTP 요청을 전송하는 클라이언트 서비스 |
| `server/src/routes/analysisApi.js` | analysis 서버에서 `/api/analysis/frame` 및 `/api/analysis/health` 엔드포인트를 제공하는 라우터 |

---

## 5. Non-Functional Requirements

| ID | 분류 | 요구사항 |
|---|---|---|
| NFR-DAP-01 | 레이턴시 | 분석 요청 전송부터 응답 수신까지 p95 기준 200ms 이내 |
| NFR-DAP-02 | 동시성 | 분석 서버 동시 처리 요청 수: `ANALYSIS_MAX_CONCURRENT` (기본값 4) 이하 |
| NFR-DAP-03 | 하위 호환 | `combined` 모드에서 기존 기능 회귀 없음 (기존 테스트 전체 통과) |
| NFR-DAP-04 | 가용성 | `streaming` 모드에서 분석 서버 장애 시 WebRTC/JPEG 스트리밍은 계속 동작 |
| NFR-DAP-05 | 보안 | 분석 서버에 대한 직접 외부 접근 차단; 내부 네트워크 전용 운영 권장 |
| NFR-DAP-06 | 메모리 | `analysis` 모드에서 비활성 카메라 컨텍스트를 5분 이내 자동 해제 |
| NFR-DAP-07 | 관찰가능성 | 분석 요청 성공/실패/드롭 카운터를 `/api/analysis/health` 응답에 포함 |

---

## 6. Technical Evaluation Criteria

제안서 평가 시 아래 기준으로 평가합니다.

| 기준 | 가중치 | 설명 |
|---|---|---|
| 하위 호환성 | 30% | `combined` 모드에서 기존 테스트 100% 통과 |
| 레이턴시 성능 | 25% | p95 분석 왕복 200ms 이내 달성 여부 |
| 백프레셔 구현 | 20% | 동시 요청 초과 시 프레임 드롭 정확성 |
| 상태 유지 정확성 | 15% | tracker ID 연속성, BehaviorEngine 상태 일관성 |
| 운영 용이성 | 10% | 환경변수 설정만으로 모드 전환 가능 |

---

## 7. Out of Scope

- WebSocket/gRPC/AMQP 기반 통신 프로토콜 (HTTP REST로 1차 구현)
- analysis 서버 자동 스케일아웃 (Kubernetes HPA 등)
- 분석 결과 캐싱 레이어
- mTLS 인증을 통한 서버 간 통신 보안 (향후 고려)
- 다중 analysis 서버 로드 밸런싱

---

## 8. Related Documents

| 문서 | 경로 |
|---|---|
| PRD | [prd/PRD_Distributed_AI_Pipeline.md](../prd/PRD_Distributed_AI_Pipeline.md) |
| SRS | [srs/SRS_Distributed_AI_Pipeline.md](../srs/SRS_Distributed_AI_Pipeline.md) |
| Design | [design/Design_Distributed_AI_Pipeline.md](../design/Design_Distributed_AI_Pipeline.md) |
| TC | [tc/TC_Distributed_AI_Pipeline.md](../tc/TC_Distributed_AI_Pipeline.md) |
| Ops | [ops/Distributed_AI_Pipeline_Setup.md](../ops/Distributed_AI_Pipeline_Setup.md) |
| 기존 PipelineManager 설계 | [design/Design_LTS2026_Loitering_Tracking_System.md](../design/Design_LTS2026_Loitering_Tracking_System.md) |
| RTSP 캡처 백엔드 설정 | [ops/RTSP_Capture_Backend_Setup.md](../ops/RTSP_Capture_Backend_Setup.md) |

---

## 9. Glossary

| 용어 | 설명 |
|---|---|
| `SERVER_MODE` | 서버 운영 모드를 선택하는 환경변수 (`combined` / `streaming` / `analysis`) |
| `ANALYSIS_SERVER_URL` | streaming 서버가 프레임을 전송할 analysis 서버의 기본 URL |
| `ANALYSIS_MAX_CONCURRENT` | analysis 서버에서 동시에 처리 가능한 최대 추론 요청 수 |
| `ANALYSIS_REQUEST_TIMEOUT_MS` | streaming 서버에서 분석 요청 타임아웃 (밀리초) |
| Graceful Degradation | 분석 서버 장애 시 스트리밍을 계속 유지하되 AI 오버레이만 제거하는 동작 |
| Backpressure | 처리 용량 초과 요청을 드롭하여 서버 과부하를 방지하는 메커니즘 |
| Per-Camera Context | analysis 서버에서 카메라별로 독립적으로 관리하는 ByteTracker + BehaviorEngine 상태 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-08 | 초기 작성 |
| 1.1 | 2026-06-24 | FR-DAP-11 추가: streaming 모드에서 analysis-only TC 스위트 스킵 및 Audit UI 필터링 요구사항 |
