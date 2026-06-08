# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Distributed AI Pipeline (스트리밍 서버 / AI 분석 서버 분리)

| | |
|---|---|
| **Document ID** | SRS-LTS-DAP-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Parent PRD** | [prd/PRD_Distributed_AI_Pipeline.md](../prd/PRD_Distributed_AI_Pipeline.md) |
| **Parent RFP** | [rfp/RFP_Distributed_AI_Pipeline.md](../rfp/RFP_Distributed_AI_Pipeline.md) |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — 서버 모드 선택](#3-functional-requirements--서버-모드-선택)
4. [Functional Requirements — Streaming 서버 동작](#4-functional-requirements--streaming-서버-동작)
5. [Functional Requirements — Analysis 서버 동작](#5-functional-requirements--analysis-서버-동작)
6. [Functional Requirements — 백프레셔 및 오류 처리](#6-functional-requirements--백프레셔-및-오류-처리)
7. [Functional Requirements — 헬스 및 관찰가능성](#7-functional-requirements--헬스-및-관찰가능성)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Interface Requirements — API 엔드포인트 명세](#9-interface-requirements--api-엔드포인트-명세)
10. [Environment Variable Specification](#10-environment-variable-specification)
11. [Constraints & Assumptions](#11-constraints--assumptions)
12. [SRS-TC Traceability Matrix](#12-srs-tc-traceability-matrix)

---

## 1. Introduction

### 1.1 Purpose

이 SRS는 LTS-2026의 Distributed AI Pipeline 기능에 대한 검증 가능한 기능 요구사항을 정의합니다. 각 요구사항은 고유한 `FR-DAP-NNN` ID로 식별되며 TC_Distributed_AI_Pipeline.md의 테스트 케이스로 추적됩니다.

### 1.2 Scope

이 문서는 다음 범위를 포함합니다:
- `SERVER_MODE` 환경변수에 의한 세 가지 운영 모드 선택 및 동작
- `streaming` 모드에서 `analysisClient.js`를 통한 HTTP POST 프레임 전송
- `analysis` 모드에서 `analysisApi.js`를 통한 `/api/analysis/frame` 및 `/api/analysis/health` 엔드포인트
- 백프레셔(`ANALYSIS_MAX_CONCURRENT`) 및 타임아웃(`ANALYSIS_REQUEST_TIMEOUT_MS`) 처리
- 분석 서버 장애 시 graceful degradation
- per-camera ByteTracker / BehaviorEngine 컨텍스트 메모리 관리

범위 외: mTLS, gRPC, 다중 분석 서버 로드 밸런싱, 자동 수평 확장

### 1.3 Definitions

| 용어 | 정의 |
|---|---|
| `combined` | 기존 단일 서버 모드 — 캡처·추론·스트리밍을 모두 로컬에서 처리 |
| `streaming` | 카메라 캡처 및 WebRTC/Socket.IO 스트리밍 전담; AI 추론은 외부 분석 서버로 위임 |
| `analysis` | AI 추론 전담; 카메라 캡처 없음; HTTP 엔드포인트로 프레임 수신 |
| `analysisClient.js` | streaming 서버에서 analysis 서버로 HTTP 요청을 보내는 클라이언트 모듈 |
| `analysisApi.js` | analysis 서버에서 `/api/analysis/frame`, `/api/analysis/health`를 제공하는 Express 라우터 |
| per-camera context | analysis 서버에서 cameraId별로 유지하는 ByteTracker + BehaviorEngine 인스턴스 쌍 |
| backpressure | 동시 요청 한도(`ANALYSIS_MAX_CONCURRENT`) 초과 시 신규 프레임을 즉시 드롭하는 메커니즘 |
| graceful degradation | 분석 서버 장애 시 AI 오버레이 없이 스트리밍만 계속하는 동작 |

---

## 2. System Overview

### 2.1 현재 아키텍처

단일 `PipelineManager` 인스턴스가 카메라별로 캡처 백엔드(FFmpeg / GStreamer / PyAV) → DetectionService(YOLOv8) → ByteTracker → BehaviorEngine → AlertService 파이프라인을 직접 실행합니다.

### 2.2 신규 아키텍처

`SERVER_MODE` 환경변수를 기준으로 시작 시 모드를 결정하고 `PipelineManager` 및 `index.js`가 분기됩니다.

```
SERVER_MODE=combined  → 기존 PipelineManager 전체 실행 (변경 없음)

SERVER_MODE=streaming → PipelineManager에서 AI 추론 단계 제거 →
                        analysisClient.js로 HTTP POST 전송 →
                        응답 데이터로 오버레이 합성

SERVER_MODE=analysis  → 카메라 캡처 초기화 없음 →
                        analysisApi.js 라우터 등록 →
                        /api/analysis/frame 수신 → 추론 → JSON 응답
```

---

## 3. Functional Requirements — 서버 모드 선택

### FR-DAP-001: 환경변수 기반 모드 선택

서버는 시작 시 `process.env.SERVER_MODE`를 읽어 다음 세 값 중 하나로 동작해야 한다:
- `combined` (기본값 — 환경변수 미설정 또는 빈 값 포함)
- `streaming`
- `analysis`

지원하지 않는 값 입력 시 서버는 에러 메시지와 함께 프로세스를 종료해야 한다(`process.exit(1)`).

### FR-DAP-002: combined 모드 하위 호환

`combined` 모드에서 `index.js`와 `pipelineManager.js`의 모든 기존 코드 경로는 변경 없이 실행되어야 한다. 신규 분기 코드는 `streaming` 또는 `analysis` 모드에서만 활성화된다.

### FR-DAP-003: streaming 모드 캡처 유지

`streaming` 모드에서 카메라 캡처(FFmpeg / GStreamer / PyAV 백엔드), WebRTC 미디어 처리, Socket.IO 프레임 전송은 `combined` 모드와 동일하게 동작해야 한다.

### FR-DAP-004: analysis 모드 캡처/Discovery 스킵

`analysis` 모드에서 카메라 캡처 백엔드 초기화와 자동 discovery(UDP/ONVIF 백그라운드 스캔, discovery REST/Socket 트리거)를 생략해야 한다.

### FR-DAP-006: 모드별 Dashboard 탭 정책

- `combined`: Cameras, Analytics 탭 모두 표시
- `streaming`: Cameras 탭 표시, Analytics 탭 숨김
- `analysis`: Cameras 탭 숨김, Analytics 탭 표시, 메인 영역은 CameraGrid 대신 Analysis 모드 상태 패널 표시

### FR-DAP-005: streaming 모드 시작 검증

`SERVER_MODE=streaming`으로 시작 시 `ANALYSIS_SERVER_URL` 환경변수가 비어 있어도 서버는 종료되지 않아야 한다.
이 경우 서버는 monitoring-only 모드(영상 스트리밍만 활성, AI 분석 결과 비활성)로 동작해야 하며,
원격 분석 URL이 설정된 경우에만 HTTP 분석 요청을 전송해야 한다.

### FR-DAP-007: streaming 모드 로컬 AI 모델 eager-load 금지

`SERVER_MODE=streaming`에서 서버 시작 시 `loadFaceServiceEagerly()` 경로를 실행하지 않아야 하며,
AttributePipeline/Face/PAR/FireSmoke 모델 세션을 선로딩하지 않아야 한다.

---

## 4. Functional Requirements — Streaming 서버 동작

### FR-DAP-010: 프레임 HTTP POST 전송

`streaming` 모드에서 `PipelineManager`의 `frame` 이벤트 핸들러는 AI 추론 단계 대신 `analysisClient.analyzeFrame(payload)`를 호출해야 한다. 페이로드 구조:

```json
{
  "cameraId": "<string uuid>",
  "frameId": "<number>",
  "timestamp": "<ISO8601 string>",
  "frame": "<base64 JPEG string>",
  "zones": "<array of zone objects>",
  "analyticsConfig": "<object>"
}
```

### FR-DAP-011: 분석 결과 오버레이 적용

`analyzeFrame()` 성공 응답의 `detections`, `tracked`, `behaviors`, `fireSmoke` 데이터를 `combined` 모드에서 추론 결과를 사용하는 것과 동일한 방식으로 Socket.IO / WebRTC DataChannel에 전송해야 한다.

`streaming` 모드에서는 추가로 `detectedFaces` 응답을 사용하여 Face ID 매칭(`face_match`)과 크롭 생성, 스냅샷 저장 파이프라인을 수행해야 한다.

### FR-DAP-012: 분석 요청 타임아웃

각 HTTP 분석 요청은 `ANALYSIS_REQUEST_TIMEOUT_MS` (기본값 `5000`) 밀리초 이내에 완료되어야 한다. 타임아웃 초과 시 해당 프레임의 분석 결과를 폐기하고 스트리밍은 계속한다.

### FR-DAP-013: 분석 서버 연결 실패 처리

HTTP 연결 오류(ECONNREFUSED, ECONNRESET, EHOSTUNREACH 등) 발생 시 해당 프레임을 조용히 폐기하고 오류를 카운터에 기록한다. 스트리밍 파이프라인을 중단하거나 카메라 상태를 오프라인으로 변경하지 않는다.

---

## 5. Functional Requirements — Analysis 서버 동작

### FR-DAP-020: 추론 엔드포인트

`analysis` 및 `combined` 모드의 Express 앱에 `POST /api/analysis/frame` 엔드포인트가 등록되어야 한다.

**요청 Content-Type:** `application/json`

**요청 본문:**
```json
{
  "cameraId": "<string>",
  "frameId": "<number>",
  "timestamp": "<ISO8601>",
  "frame": "<base64 JPEG>",
  "zones": [...],
  "analyticsConfig": {...}
}
```

**성공 응답 (200 OK):**
```json
{
  "cameraId": "<string>",
  "frameId": "<number>",
  "timestamp": "<ISO8601>",
  "detections": [...],
  "tracked": [...],
  "behaviors": [...],
  "fireSmoke": [...]
}
```

**오류 응답:**
- `400 Bad Request` — 필수 필드(`cameraId`, `frame`) 누락
- `503 Service Unavailable` — 동시 요청 한도 초과 (백프레셔)

### FR-DAP-021: Per-Camera 컨텍스트 생성

최초 cameraId 요청 수신 시 해당 cameraId에 대한 `ByteTracker` 인스턴스와 `BehaviorEngine` 인스턴스를 생성하여 Map에 저장해야 한다.

### FR-DAP-022: Per-Camera 컨텍스트 유지

동일 cameraId의 연속 요청은 기존 `ByteTracker`와 `BehaviorEngine` 인스턴스를 재사용해야 한다. 각 요청 처리 후 마지막 요청 시각(`lastSeenAt`)을 업데이트해야 한다.

### FR-DAP-023: Per-Camera 컨텍스트 자동 정리

`analysis` 서버는 주기적(60초 간격)으로 컨텍스트 Map을 순회하여 `lastSeenAt`이 현재 시각 기준 5분(300,000ms) 이상 경과한 항목을 삭제해야 한다.

### FR-DAP-024: DetectionService 공유

`analysis` 서버의 `DetectionService`(YOLOv8 ONNX 모델)는 모든 cameraId 요청에서 공유되어야 한다. 카메라별로 별도의 모델 인스턴스를 생성하지 않는다.

### FR-DAP-025: 추론 파이프라인 순서

`POST /api/analysis/frame` 처리 순서:
1. `cameraId`로 per-camera 컨텍스트 조회 또는 생성
2. Base64 디코딩 → JPEG Buffer 변환
3. `DetectionService.detect(jpegBuffer)` — YOLOv8 추론
4. `analyticsConfig`에 따라 활성화된 서비스만 실행:
   - `ByteTracker.update(detections)` — 객체 추적
   - `BehaviorEngine.update(tracked, zones)` — 배회 점수 산출
   - `FireSmokeService.analyze(jpegBuffer)` (활성화된 경우)
5. 결과 JSON 조합 후 응답

---

## 6. Functional Requirements — 백프레셔 및 오류 처리

### FR-DAP-030: 동시 요청 한도 적용 (streaming 모드)

`analysisClient.js`는 현재 진행 중인 HTTP 요청 수(`concurrentRequests`)를 추적해야 한다. 신규 요청 시 `concurrentRequests >= ANALYSIS_MAX_CONCURRENT`이면 해당 프레임을 **즉시 드롭**하고 `droppedFrames` 카운터를 증가시켜야 한다.

### FR-DAP-031: 동시 요청 한도 적용 (analysis 모드)

`analysisApi.js`는 현재 처리 중인 추론 요청 수를 추적해야 한다. 신규 요청 시 한도 초과이면 `503 Service Unavailable`을 반환해야 한다.

```json
{
  "error": "Too many concurrent analysis requests",
  "concurrentRequests": 4,
  "limit": 4
}
```

### FR-DAP-032: 에러 격리

`analysisClient.js`의 HTTP 요청 오류(네트워크 오류, 타임아웃, 4xx/5xx 응답)는 `PipelineManager`의 카메라 파이프라인 상태에 영향을 주지 않아야 한다. 오류는 `console.warn`으로 기록하고 해당 프레임 결과만 폐기한다.

---

## 7. Functional Requirements — 헬스 및 관찰가능성

### FR-DAP-040: 헬스 엔드포인트

`analysis` 모드에서 `GET /api/analysis/health` 응답:

```json
{
  "status": "ok",
  "mode": "analysis",
  "activeCameras": 3,
  "concurrentRequests": 1,
  "maxConcurrent": 4,
  "processedFrames": 12345,
  "droppedFrames": 42,
  "timeoutFrames": 0,
  "uptime": 3600
}
```

`streaming` 모드에서 `GET /api/analysis/health` 응답 (analysisClient 통계):

```json
{
  "status": "ok",
  "mode": "streaming",
  "analysisServerUrl": "http://192.168.1.200:3001",
  "concurrentRequests": 2,
  "maxConcurrent": 4,
  "sentFrames": 5678,
  "droppedFrames": 10,
  "timeoutFrames": 3,
  "errorFrames": 0
}
```

### FR-DAP-041: 시작 로그

서버 시작 시 다음 형식으로 모드를 콘솔에 출력해야 한다:
```
[Server] SERVER_MODE=streaming | ANALYSIS_SERVER_URL=http://192.168.1.200:3001
[Server] SERVER_MODE=analysis  | ANALYSIS_MAX_CONCURRENT=4
[Server] SERVER_MODE=combined  | (all-in-one mode)
```

---

## 8. Non-Functional Requirements

| ID | 분류 | 요구사항 | 측정 방법 |
|---|---|---|---|
| NFR-DAP-001 | 레이턴시 | 분석 요청 왕복 시간 p95 ≤ 200ms (LAN 환경) | `analysisClient.js` 내부 측정값, `health` API 노출 |
| NFR-DAP-002 | 동시성 | 동시 처리 요청 ≤ `ANALYSIS_MAX_CONCURRENT` (기본값 4) | FR-DAP-030, FR-DAP-031 |
| NFR-DAP-003 | 하위 호환 | `combined` 모드에서 기존 API 테스트 100% 통과 | TC-DAP-001 |
| NFR-DAP-004 | 가용성 | streaming 모드에서 analysis 서버 장애 시 스트리밍 중단 없음 | TC-DAP-004 |
| NFR-DAP-005 | 메모리 | analysis 모드에서 비활성 5분 후 per-camera 컨텍스트 해제 | TC-DAP-007 |
| NFR-DAP-006 | 보안 | analysis 서버 엔드포인트에 인증 미적용 (내부망 신뢰 모델) | 방화벽으로 외부 차단 권장 |
| NFR-DAP-007 | 관찰가능성 | `health` API가 드롭·타임아웃 카운터를 포함해야 함 | FR-DAP-040 |
| NFR-DAP-008 | 시작 시간 | analysis 모드 서버 시작 완료(ONNX 모델 로드 포함) ≤ 30초 | 측정 로그 |

---

## 9. Interface Requirements — API 엔드포인트 명세

### 9.1 POST /api/analysis/frame

| 항목 | 내용 |
|---|---|
| **경로** | `POST /api/analysis/frame` |
| **모드** | `analysis` 전용 |
| **Content-Type** | `application/json` |
| **인증** | 없음 (내부망 신뢰) |
| **최대 요청 크기** | 10MB (`express.json({ limit: '10mb' })`) |

**요청 필드:**

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `cameraId` | string (UUID) | 필수 | 카메라 고유 식별자 |
| `frameId` | number | 필수 | 프레임 시퀀스 번호 |
| `timestamp` | string (ISO8601) | 필수 | 프레임 캡처 시각 |
| `frame` | string (base64) | 필수 | JPEG 이미지 base64 인코딩 |
| `zones` | array | 선택 | 구역 객체 배열 (BehaviorEngine 입력) |
| `analyticsConfig` | object | 선택 | 활성화된 모듈 플래그 |

**응답 필드 (200 OK):**

| 필드 | 타입 | 설명 |
|---|---|---|
| `cameraId` | string | 요청과 동일 |
| `frameId` | number | 요청과 동일 |
| `timestamp` | string | 처리 완료 시각 (ISO8601) |
| `detections` | array | YOLOv8 감지 결과 |
| `tracked` | array | ByteTracker 추적 결과 |
| `behaviors` | array | BehaviorEngine 배회 점수 결과 |
| `fireSmoke` | array | FireSmokeService 감지 결과 |

### 9.2 GET /api/analysis/health

| 항목 | 내용 |
|---|---|
| **경로** | `GET /api/analysis/health` |
| **모드** | `analysis`, `streaming` |
| **인증** | 없음 |
| **응답** | `application/json` |

---

## 10. Environment Variable Specification

| 환경변수 | 타입 | 기본값 | 유효값 | 설명 |
|---|---|---|---|---|
| `SERVER_MODE` | string | `combined` | `combined`, `streaming`, `analysis` | 서버 운영 모드 선택 |
| `ANALYSIS_SERVER_URL` | URL string | (없음) | 유효한 HTTP/HTTPS URL | streaming 모드에서 분석 서버 기본 URL (필수) |
| `ANALYSIS_REQUEST_TIMEOUT_MS` | integer | `5000` | 500 – 30000 | 분석 HTTP 요청 타임아웃 (밀리초) |
| `ANALYSIS_MAX_CONCURRENT` | integer | `4` | 1 – 32 | 최대 동시 분석 요청 수 |

**server/.env.example 추가 예시:**
```dotenv
# ── Distributed AI Pipeline ───────────────────────────────────────────────────
# SERVER_MODE=combined   : (기본값) 단일 서버 — 모든 기능 로컬 실행
# SERVER_MODE=streaming  : 스트리밍 전담 — AI 추론을 외부 analysis 서버로 위임
# SERVER_MODE=analysis   : AI 추론 전담 — /api/analysis/frame 엔드포인트 노출
SERVER_MODE=combined

# URL of the analysis server (required when SERVER_MODE=streaming).
ANALYSIS_SERVER_URL=http://localhost:3001

# Timeout for each HTTP analysis request in milliseconds.
ANALYSIS_REQUEST_TIMEOUT_MS=5000

# Maximum number of concurrent analysis HTTP requests.
# Frames arriving when this limit is reached are dropped (backpressure).
ANALYSIS_MAX_CONCURRENT=4
```

---

## 11. Constraints & Assumptions

1. **CommonJS 전용**: `analysisClient.js`, `analysisApi.js`는 `require()` / `module.exports` 사용 (`import`/`export` 금지)
2. **Node.js 18+**: `fetch` API를 네이티브로 사용하거나 `node-fetch`를 사용한다. 기존 프로젝트의 HTTP 클라이언트 패턴을 따름
3. **동일 네트워크**: streaming 서버와 analysis 서버는 저레이턴시 LAN(≤ 1ms RTT)에서 운영됨을 가정
4. **JPEG 프레임 크기**: 단일 프레임 base64 인코딩 크기는 최대 5MB로 가정 (1080p JPEG 기준)
5. **YOLOv8 입력 크기**: analysis 서버의 DetectionService는 640×640 해상도로 추론 수행
6. **AlertService 위치**: `combined` 및 `analysis` 모드에서만 AlertService가 실행됨. `streaming` 모드에서는 분석 서버에서 behaviors 데이터를 수신하면 스트리밍 서버의 AlertService가 처리
7. **하위 호환**: 기존 `pipelineManager.js`의 1019줄 코드를 직접 수정하지 않고 모드 분기 로직을 최소 침습적으로 추가

---

## 12. SRS-TC Traceability Matrix

| SRS 요구사항 | 테스트 케이스 |
|---|---|
| FR-DAP-001 | TC-DAP-001 |
| FR-DAP-002 | TC-DAP-001 |
| FR-DAP-003 | TC-DAP-002 |
| FR-DAP-004 | TC-DAP-003 |
| FR-DAP-005 | TC-DAP-001, TC-DAP-002 |
| FR-DAP-010 | TC-DAP-002 |
| FR-DAP-011 | TC-DAP-008 |
| FR-DAP-012 | TC-DAP-004 |
| FR-DAP-013 | TC-DAP-004 |
| FR-DAP-020 | TC-DAP-003 |
| FR-DAP-021 | TC-DAP-006 |
| FR-DAP-022 | TC-DAP-006 |
| FR-DAP-023 | TC-DAP-007 |
| FR-DAP-024 | TC-DAP-003 |
| FR-DAP-025 | TC-DAP-003 |
| FR-DAP-030 | TC-DAP-005 |
| FR-DAP-031 | TC-DAP-005 |
| FR-DAP-032 | TC-DAP-004 |
| FR-DAP-040 | TC-DAP-005 |
| FR-DAP-041 | TC-DAP-001, TC-DAP-002, TC-DAP-003 |
| NFR-DAP-001 | TC-DAP-003 |
| NFR-DAP-004 | TC-DAP-004 |
| NFR-DAP-005 | TC-DAP-007 |
