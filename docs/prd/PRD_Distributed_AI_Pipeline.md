# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Distributed AI Pipeline (스트리밍 서버 / AI 분석 서버 분리)

| | |
|---|---|
| **Document ID** | PRD-LTS-DAP-01 |
| **Version** | 1.1 |
| **Status** | Draft |
| **Date** | 2026-06-08 |
| **Related RFP** | [rfp/RFP_Distributed_AI_Pipeline.md](../rfp/RFP_Distributed_AI_Pipeline.md) |

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [User Stories](#5-user-stories)
6. [Technical Requirements](#6-technical-requirements)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)
9. [Related Documents](#9-related-documents)

---

## 1. Product Vision

`SERVER_MODE` 환경변수 한 줄로 LTS-2026 서버를 **카메라 스트리밍 전담 서버** 또는 **AI 분석 전담 서버**로 역할을 분리하여, GPU 서버와 스트리밍 서버를 독립적으로 확장할 수 있도록 한다. 기존 `combined` 모드는 완전히 보존하여 단일 서버 운영 환경에서 즉시 업그레이드 가능한 하위 호환성을 제공한다.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- `SERVER_MODE=combined` 기본값으로 **현재 동작을 100% 유지**하여 기존 설치 환경에서 재설정 없이 업그레이드 가능
- `SERVER_MODE=streaming`에서 카메라 JPEG 프레임을 HTTP POST로 분석 서버에 전달하고, 분석 결과(detections, tracked, behaviors, fireSmoke)를 WebRTC/Socket.IO 오버레이로 합성
- `SERVER_MODE=streaming`에서 분석 서버 응답의 `detectedFaces`를 사용해 Face ID 매칭, face crop 생성, snapshot 저장까지 수행
- `SERVER_MODE=streaming`에서는 서버 시작 시 로컬 분석 모델(AttributePipeline/Face/PAR/FireSmoke) eager load를 수행하지 않음
- `SERVER_MODE=analysis`에서 `POST /api/analysis/frame` 엔드포인트를 통해 순수 AI 추론(YOLOv8 → ByteTrack → BehaviorEngine → AttributePipeline → FireSmokeService)을 수행하고 JSON 응답 반환
- `SERVER_MODE=analysis`에서 카메라 Discovery 기능을 비활성화하고, Dashboard 메인 영역에 Analysis 모드 상태 패널을 표시
- 분석 서버 장애 시 스트리밍 서버는 AI 오버레이 없이 계속 스트리밍 유지 (graceful degradation)
- `ANALYSIS_MAX_CONCURRENT` 초과 요청을 프레임 드롭으로 처리하는 백프레셔 구현
- 분석 서버에서 카메라별 ByteTracker / BehaviorEngine 상태를 메모리에 유지하여 tracker ID 연속성 보장
- `GET /api/analysis/health`로 분석 서버 상태 및 통계 조회

### 2.2 Non-Goals

- WebSocket / gRPC / AMQP 기반 프레임 전송 (HTTP REST 1차 구현)
- 분석 서버 자동 수평 확장 (Kubernetes HPA 등)
- 스트리밍 서버와 분석 서버 간 mTLS 인증
- 다중 분석 서버 로드 밸런싱
- 분석 결과 캐싱 레이어

---

## 3. User Personas

**시스템 관리자 (System Administrator)**
환경변수 `.env` 파일을 수정하여 서버 모드를 전환합니다. GPU 서버와 스트리밍 서버를 별도 머신에 배포하여 비용을 최적화하고자 합니다.

**DevOps 엔지니어**
Docker Compose 또는 쿠버네티스에서 `streaming` 컨테이너와 `analysis` 컨테이너를 분리하여 독립적으로 스케일합니다. 분석 서버의 GPU 자원 활용률을 모니터링합니다.

**현장 운영자 (Operator)**
`streaming` 모드에서 분석 서버가 재시작 중이더라도 카메라 영상을 계속 확인할 수 있어야 합니다. AI 오버레이가 일시적으로 사라지더라도 스트리밍 자체는 끊기지 않아야 합니다.

**AI 개발자**
`analysis` 모드에서 AI 서비스(YOLOv8 모델, BehaviorEngine 파라미터)를 독립적으로 교체·테스트합니다. 스트리밍 서버를 재시작할 필요 없이 분석 서버만 재배포합니다.

---

## 4. Functional Specification

### 4.1 SERVER_MODE 선택 기능

| 항목 | 설명 |
|---|---|
| **환경변수** | `SERVER_MODE` (server/.env) |
| **허용값** | `combined` (기본값), `streaming`, `analysis` |
| **적용 시점** | 서버 프로세스 시작 시 |
| **동적 변경** | 미지원 (재시작 필요) |

**동작 요약:**

| 모드 | 카메라 캡처 | AI 추론 | HTTP 분석 클라이언트 | 분석 API 엔드포인트 |
|---|---|---|---|---|
| `combined` | O (로컬) | O (로컬) | X | O |
| `streaming` | O (로컬) | X | O (외부 전송) | X |
| `analysis` | X | O (로컬) | X | O |

### 4.1.1 Dashboard 탭 정책

| 모드 | Cameras Tab | Analytics Tab | 메인 영역 |
|---|---|---|---|
| `combined` | 표시 | 표시 | CameraGrid |
| `streaming` | 표시 | 숨김 | CameraGrid |
| `analysis` | 숨김 | 표시 | Analysis 모드 안내 패널 |

### 4.2 분석 서버 URL 설정

- 환경변수: `ANALYSIS_SERVER_URL`
- 예시: `http://192.168.1.200:3001`
- `streaming` 모드에서만 참조됨
- 미설정 시에도 서버는 시작되며 영상 스트리밍은 유지됨 (monitoring-only)
- 미설정 시 AI 분석 결과(`detections`, `behaviors`, `face_match`)는 수신되지 않음

### 4.3 백프레셔 처리

- 환경변수: `ANALYSIS_MAX_CONCURRENT` (기본값: `4`)
- 현재 진행 중인 HTTP 분석 요청이 한도에 도달하면 신규 프레임을 **즉시 드롭**
- 드롭된 프레임 수를 카운터로 추적 (`health` API로 노출)
- 드롭 발생 시 `console.warn` 로그 출력

### 4.4 분석 요청 타임아웃

- 환경변수: `ANALYSIS_REQUEST_TIMEOUT_MS` (기본값: `5000`)
- 타임아웃 초과 시 해당 프레임 결과를 폐기하고 스트리밍 계속
- 타임아웃 카운터를 `health` API로 노출

### 4.5 Per-Camera 상태 유지 (analysis 모드)

- 각 `cameraId`별로 `ByteTracker` + `BehaviorEngine` 인스턴스를 Map으로 관리
- 마지막 프레임 수신 후 **5분** 경과 시 해당 카메라 컨텍스트 자동 삭제
- 컨텍스트 삭제 이후 동일 cameraId 프레임이 수신되면 새 컨텍스트 생성

### 4.6 분석 API 엔드포인트 (analysis 모드)

**추론 엔드포인트:**
- `POST /api/analysis/frame` — JPEG 프레임 수신 및 추론 결과 반환

**헬스 엔드포인트:**
- `GET /api/analysis/health` — 분석 서버 상태 및 통계 반환

---

## 5. User Stories

### US-DAP-01: 환경변수로 모드 전환
```
As a 시스템 관리자,
I want server/.env에서 SERVER_MODE를 변경하고 서버를 재시작하여
두 종류의 서버 중 하나로 동작하게 할 수 있다.
So that GPU 서버와 스트리밍 서버를 물리적으로 분리할 수 있다.
```

### US-DAP-02: 분석 서버 장애 시 스트리밍 유지
```
As a 현장 운영자,
I want 분석 서버가 재시작 중이거나 응답하지 않을 때도
카메라 영상이 끊기지 않고 표시되기를 원한다.
So that 분석 서버 장애가 현장 감시에 영향을 주지 않는다.
```

### US-DAP-03: AI 서비스 독립 배포
```
As a AI 개발자,
I want 분석 서버(SERVER_MODE=analysis)만 재시작하여
새 YOLOv8 모델이나 BehaviorEngine 파라미터를 테스트할 수 있다.
So that 스트리밍 서버를 재시작하지 않고 AI 업데이트를 롤아웃할 수 있다.
```

### US-DAP-04: 백프레셔로 GPU 과부하 방지
```
As a DevOps 엔지니어,
I want ANALYSIS_MAX_CONCURRENT 설정으로 동시 추론 요청 수를 제한하여
GPU 서버가 과부하 상태에 빠지는 것을 방지할 수 있다.
So that 분석 서버가 안정적으로 운영된다.
```

### US-DAP-05: 분석 서버 상태 모니터링
```
As a DevOps 엔지니어,
I want GET /api/analysis/health를 통해 현재 동시 요청 수, 처리 건수,
드롭 건수, 타임아웃 건수를 확인할 수 있다.
So that 분석 서버의 성능 상태를 실시간으로 파악할 수 있다.
```

---

## 6. Technical Requirements

### 6.1 신규 파일

| 파일 | 역할 |
|---|---|
| `server/src/services/analysisClient.js` | HTTP POST 클라이언트: 동시성 제어, 타임아웃, 백프레셔, 에러 핸들링 |
| `server/src/routes/analysisApi.js` | Express 라우터: `POST /api/analysis/frame`, `GET /api/analysis/health` |

### 6.2 수정 파일

| 파일 | 변경 내용 |
|---|---|
| `server/src/services/pipelineManager.js` | `SERVER_MODE` 확인 후 AI 추론 단계를 `analysisClient.js`로 위임 (streaming 모드) 또는 제거 (analysis 모드) |
| `server/src/index.js` | `SERVER_MODE=analysis` 시 `analysisApi.js` 라우터 등록; 카메라 캡처 초기화 스킵 |
| `server/.env.example` | 신규 환경변수 4개 추가 |

### 6.3 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SERVER_MODE` | `combined` | 서버 운영 모드 |
| `ANALYSIS_SERVER_URL` | (없음) | analysis 서버 기본 URL (streaming 모드 필수) |
| `ANALYSIS_REQUEST_TIMEOUT_MS` | `5000` | 분석 요청 타임아웃 (ms) |
| `ANALYSIS_MAX_CONCURRENT` | `4` | 최대 동시 분석 요청 수 |

### 6.4 하위 호환성 보장

- `SERVER_MODE=combined` (또는 환경변수 미설정) 시 기존 코드 경로를 100% 그대로 실행
- 기존 `pipelineManager.js` 로직에서 `streaming` 모드 분기는 `if (serverMode === 'streaming')` 조건 블록으로 캡슐화
- `analysis` 모드에서는 `pipelineManager.js`의 카메라 캡처·스트리밍 코드 경로를 진입하지 않음

---

## 7. Acceptance Criteria

### AC-DAP-01: combined 모드 하위 호환
- [ ] `SERVER_MODE=combined`(또는 미설정)으로 시작 시 기존 테스트(`npm test`) 전체 통과
- [ ] 기존 카메라 추가, 알림 확인, 구역 설정 API 정상 동작

### AC-DAP-02: streaming 모드 프레임 전송
- [ ] `SERVER_MODE=streaming`으로 시작 시 카메라 프레임이 `ANALYSIS_SERVER_URL/api/analysis/frame`으로 HTTP POST 전송됨
- [ ] 응답 받은 detections, tracked, behaviors가 WebRTC/Socket.IO 오버레이에 반영됨

### AC-DAP-03: analysis 모드 추론 응답
- [ ] `SERVER_MODE=analysis`로 시작 시 `POST /api/analysis/frame`이 200 JSON 응답을 반환함
- [ ] 응답에 `detections`, `tracked`, `behaviors`, `fireSmoke` 필드가 포함됨

### AC-DAP-04: graceful degradation
- [ ] streaming 모드에서 analysis 서버 연결 실패 시 스트리밍 프레임 전송이 계속됨 (카메라 상태 유지)
- [ ] AI 오버레이(detections)는 표시되지 않으나 스트림 자체는 끊기지 않음

### AC-DAP-05: 백프레셔
- [ ] `ANALYSIS_MAX_CONCURRENT=2`로 설정 후 동시에 3개 이상의 요청 발생 시 초과 프레임이 드롭됨
- [ ] `GET /api/analysis/health`의 `droppedFrames` 카운터가 증가함

### AC-DAP-08: 감지 트랙 영구 저장 (DetectionsTimeline)
- [ ] `combined`/`analysis` 모드에서 1초 이상 체류한 추적 객체가 종료 시 `detectionTracks` DB에 `inProgress: false`로 저장됨
- [ ] `streaming` 모드에서 분석 서버 응답의 `tracked` 객체 정보를 스트리밍 서버 로컬 DB에 shadow copy로 저장됨
- [ ] 스트리밍 서버에서 30초 간격 active flush로 현재 프레임 내 객체가 `inProgress: true`로 저장됨
- [ ] 분석 서버 다운 시 15초 후 미갱신 트랙이 `inProgress: false`로 자동 종료됨
- [ ] `/api/analysis/detection-tracks` 프록시 실패 시 스트리밍 서버 로컬 DB로 fallback 제공됨
- [ ] 원본 해상도 JPEG 프레임에서 bbox 정보로 크롭한 스냅샷이 스트리밍 서버 `detectionSnapshots`에 저장됨

### AC-DAP-09: 스냅샷 원본 크롭 (Streaming 모드)
- [ ] streaming 모드에서 크롭 이미지는 분석 서버의 640px 재인코딩 프레임이 아닌 스트리밍 서버의 원본 해상도 JPEG에서 생성됨
- [ ] bbox 좌표는 분석 서버에서 원본 프레임 해상도로 스케일백된 좌표를 사용함

### AC-DAP-06: per-camera 상태 유지
- [ ] analysis 모드에서 동일 cameraId 연속 프레임에 대해 tracker objectId가 연속적으로 증가함
- [ ] 5분 비활성 후 새 프레임 수신 시 새 컨텍스트가 생성됨 (tracker가 1번 ID부터 재시작)

### AC-DAP-07: 헬스 엔드포인트
- [ ] `GET /api/analysis/health`가 `{ status, mode, activeCameras, concurrentRequests, processedFrames, droppedFrames, timeoutFrames }` 구조로 응답함

---

## 8. Milestones & TODO

| 단계 | 작업 | 담당 |
|---|---|---|
| M1 | `analysisClient.js` 구현 (HTTP POST, 동시성, 타임아웃, 백프레셔) | Backend |
| M2 | `analysisApi.js` 구현 (`/frame`, `/health` 엔드포인트) | Backend |
| M3 | `pipelineManager.js` 분기 로직 추가 (`streaming` / `analysis` / `combined`) | Backend |
| M4 | `index.js` 모드별 초기화 분기 | Backend |
| M5 | `server/.env.example` 환경변수 추가 | Config |
| M6 | 테스트 케이스 작성 및 실행 (TC-DAP-001 ~ TC-DAP-008) | QA |
| M7 | 운영 가이드 검토 및 Docker Compose 예시 업데이트 | DevOps |

---

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-08 | 초기 작성 |
| 1.1 | 2026-06-17 | DetectionsTimeline 트랙 영구 저장 요구사항(AC-DAP-08~09), 스냅샷 원본 크롭 정책 추가 |

---

## 9. Related Documents

| 문서 | 경로 |
|---|---|
| RFP | [rfp/RFP_Distributed_AI_Pipeline.md](../rfp/RFP_Distributed_AI_Pipeline.md) |
| SRS | [srs/SRS_Distributed_AI_Pipeline.md](../srs/SRS_Distributed_AI_Pipeline.md) |
| Design | [design/Design_Distributed_AI_Pipeline.md](../design/Design_Distributed_AI_Pipeline.md) |
| TC | [tc/TC_Distributed_AI_Pipeline.md](../tc/TC_Distributed_AI_Pipeline.md) |
| Ops | [ops/Distributed_AI_Pipeline_Setup.md](../ops/Distributed_AI_Pipeline_Setup.md) |
