---
name: ai-detection-pipeline
description: "LTS-2026 AI 추론 파이프라인 개발 및 디버깅. Use when: YOLOv8 감지 설정, behaviorEngine 배회 점수 조정, attributePipeline 속성 분석(의상·색상·마스크·헬멧), fireSmokeService 화재/연기 감지, 감지 임계값 튜닝, pipelineManager 서비스 추가/수정, AI 모델 교체, 감지 정확도 문제 해결. Covers: detection.js, behaviorEngine.js, attributePipeline.js, pipelineManager.js, trackerConfig.js, tracking.js, colorClothService.js, fireSmokeService.js, protectiveEquipService.js."
argument-hint: "추가 또는 수정할 AI 기능 (예: loitering threshold, attribute detection, fire smoke)"
---

# AI Detection Pipeline

## 파이프라인 구조

```
RTSP/WebRTC 스트림
  └─► rtspCapture.js / webrtcGateway.js   (프레임 수집)
        └─► detection.js                  (YOLOv8 person/object 감지)
              └─► tracking.js             (ByteTrack 다중 객체 추적)
                    └─► attributePipeline.js  (의상·색상·마스크·헬멧 분석)
                          └─► behaviorEngine.js (배회 위험 점수 산출)
                                └─► zoneManager.js   (구역별 임계값 적용)
                                      └─► alertService.js  (알림 발생)
```

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `server/src/services/detection.js` | YOLOv8 추론, 바운딩 박스 추출 |
| `server/src/services/tracking.js` | ByteTrack 기반 ID 유지 추적 |
| `server/src/services/behaviorEngine.js` | 배회 점수(dwell time, movement pattern) |
| `server/src/services/attributePipeline.js` | 의상·색상·보호장구 속성 분류 |
| `server/src/services/trackerConfig.js` | 추적기 파라미터(IoU threshold, max age) |
| `server/src/services/pipelineManager.js` | 서비스 생명주기 관리 |
| `server/src/services/colorClothService.js` | 색상 및 의류 분석 |
| `server/src/services/fireSmokeService.js` | 화재·연기 감지 모델 |
| `server/src/services/protectiveEquipService.js` | 안전모·마스크 착용 감지 |
| `server/src/services/faceService.js` | 얼굴 인식 및 Re-ID 임베딩 |

## 주요 작업 절차

### 배회 감지 임계값 조정
1. `server/src/services/behaviorEngine.js` 열기
2. `dwellThreshold` (초), `movementRadius` (픽셀), `riskScore` 가중치 수정
3. `server/src/services/zoneManager.js`에서 구역별 오버라이드 확인
4. `storage/lts.json` 또는 MongoDB `zones` 컬렉션에 저장된 설정 확인

### 새 AI 속성 모델 추가
1. `server/src/services/attributePipeline.js`에 새 분류기 함수 추가
2. `server/src/services/pipelineManager.js`에 서비스 등록
3. `server/src/services/detection.js`에서 결과를 추적 객체에 병합
4. `client/src/types/` 에 TypeScript 타입 추가
5. 대시보드 컴포넌트에서 새 속성 표시

### YOLOv8 모델 교체
1. 루트의 `yolov8s.pt`를 새 모델로 교체 (또는 경로 설정 변경)
2. `server/src/services/detection.js`에서 모델 로드 경로 수정
3. 클래스 레이블 매핑 업데이트
4. 신뢰도 임계값(`confThreshold`) 재조정

### combined 모드 분석 메트릭 조회

`pipelineManager.getAnalysisMetrics()` — `GET /api/analysis/metrics` 엔드포인트에서 호출됨:

```js
// 반환 구조 (analysisApi._metrics 와 동일 스키마)
{
  status: 'ok',
  mode: 'combined',
  activeCameras: N,
  results: {
    framesTotal, detectionsTotal, trackedObjectsTotal,
    facesTotal, fireSmokeTotal, loiteringTotal,
  },
  recent: { windowSec, frames, framesPerSec, avgProcessingMs, ... },
  cameras: [{ cameraId, cameraName, framesTotal, avgProcessingMs, ... }],
}
```

각 카메라 ctx에 누적되는 통계 필드:
- `framesProcessed` — 추론을 거친 프레임 수
- `bytesReceivedTotal` — 수신 JPEG 총 바이트
- `detectionsTotal / trackedTotal / facesTotal / fireSmokeTotal / loiteringTotal`
- `totalProcessingMs` — 전체 추론 소요 시간
- `recentSamples[]` — 최근 60초 샘플 (fps / avgMs 계산용)

> combined/analysis 모드에서만 ctx 통계가 쌓임. streaming 모드에서는 분석 서버가 직접 관리.

### 파이프라인 성능 디버깅
1. `server/src/services/pipelineManager.js` 로그 레벨 활성화
2. FPS, 추론 시간 메트릭 확인 (`GET /api/analysis/metrics`)
3. `trackerConfig.js`의 `maxAge`, `minHits` 값으로 ID 스위칭 최소화
4. GPU/CPU 부하 확인: `nvidia-smi` 또는 시스템 모니터

## 설정 파라미터 참조

```js
// behaviorEngine.js 핵심 파라미터
{
  dwellThreshold: 30,       // 초 — 이 시간 초과 시 배회 의심
  movementRadius: 50,       // 픽셀 — 정적 판단 반경
  riskWeights: {
    dwell: 0.4,
    stationarity: 0.3,
    returnFrequency: 0.3
  }
}

// trackerConfig.js 핵심 파라미터
{
  iouThreshold: 0.3,
  maxAge: 30,               // 프레임 수 — ID 유지 최대 미감지 허용
  minHits: 3                // 확정 트랙 최소 감지 횟수
}
```

## 관련 문서 (SDLC 참조)

> 구현·수정 전 아래 문서를 확인하고, **코드 변경 시 해당 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_LTS2026_Loitering_Tracking_System](../../../docs/rfp/RFP_LTS2026_Loitering_Tracking_System.md) · [RFP_AI_Human_Detection](../../../docs/rfp/RFP_AI_Human_Detection.md) · [RFP_AI_Vehicle_Detection](../../../docs/rfp/RFP_AI_Vehicle_Detection.md) · [RFP_Object_Tracking](../../../docs/rfp/RFP_Object_Tracking.md) |
| RFP | [RFP_AI_Fire_Smoke_Detection](../../../docs/rfp/RFP_AI_Fire_Smoke_Detection.md) · [RFP_AI_Cloth_Analysis](../../../docs/rfp/RFP_AI_Cloth_Analysis.md) · [RFP_AI_Color_Analysis](../../../docs/rfp/RFP_AI_Color_Analysis.md) · [RFP_AI_Mask_Detection](../../../docs/rfp/RFP_AI_Mask_Detection.md) · [RFP_AI_Hat_Detection](../../../docs/rfp/RFP_AI_Hat_Detection.md) · [RFP_AI_CUDA_Acceleration](../../../docs/rfp/RFP_AI_CUDA_Acceleration.md) |
| RFP | [RFP_Distributed_AI_Pipeline](../../../docs/rfp/RFP_Distributed_AI_Pipeline.md) — 스트리밍/분석 서버 분리 요구사항 |
| PRD | [PRD_LTS2026_Loitering_Tracking_System](../../../docs/prd/PRD_LTS2026_Loitering_Tracking_System.md) · [PRD_Object_Tracking](../../../docs/prd/PRD_Object_Tracking.md) · [PRD_AI_Human_Detection](../../../docs/prd/PRD_AI_Human_Detection.md) · [PRD_AI_Vehicle_Detection](../../../docs/prd/PRD_AI_Vehicle_Detection.md) |
| PRD | [PRD_AI_Fire_Smoke_Detection](../../../docs/prd/PRD_AI_Fire_Smoke_Detection.md) · [PRD_AI_Cloth_Analysis](../../../docs/prd/PRD_AI_Cloth_Analysis.md) · [PRD_AI_Color_Analysis](../../../docs/prd/PRD_AI_Color_Analysis.md) · [PRD_AI_Mask_Detection](../../../docs/prd/PRD_AI_Mask_Detection.md) · [PRD_AI_Hat_Detection](../../../docs/prd/PRD_AI_Hat_Detection.md) |
| PRD | [PRD_Distributed_AI_Pipeline](../../../docs/prd/PRD_Distributed_AI_Pipeline.md) — SERVER_MODE 제품 요구사항 |
| SRS | [SRS_LTS2026_Loitering_Tracking_System](../../../docs/srs/SRS_LTS2026_Loitering_Tracking_System.md) · [SRS_Object_Tracking](../../../docs/srs/SRS_Object_Tracking.md) · [SRS_AI_Human_Detection](../../../docs/srs/SRS_AI_Human_Detection.md) |
| SRS | [SRS_AI_Fire_Smoke_Detection](../../../docs/srs/SRS_AI_Fire_Smoke_Detection.md) · [SRS_AI_Cloth_Analysis](../../../docs/srs/SRS_AI_Cloth_Analysis.md) · [SRS_AI_Color_Analysis](../../../docs/srs/SRS_AI_Color_Analysis.md) · [SRS_AI_Mask_Detection](../../../docs/srs/SRS_AI_Mask_Detection.md) · [SRS_AI_Hat_Detection](../../../docs/srs/SRS_AI_Hat_Detection.md) |
| SRS | [SRS_Distributed_AI_Pipeline](../../../docs/srs/SRS_Distributed_AI_Pipeline.md) — 분산 파이프라인 소프트웨어 요구사항 |
| Design | [Design_LTS2026_Loitering_Tracking_System](../../../docs/design/Design_LTS2026_Loitering_Tracking_System.md) · [Design_Object_Tracking](../../../docs/design/Design_Object_Tracking.md) · [Design_AI_Human_Detection](../../../docs/design/Design_AI_Human_Detection.md) |
| Design | [Design_AI_Fire_Smoke_Detection](../../../docs/design/Design_AI_Fire_Smoke_Detection.md) · [Design_AI_Cloth_Analysis](../../../docs/design/Design_AI_Cloth_Analysis.md) · [Design_AI_Color_Analysis](../../../docs/design/Design_AI_Color_Analysis.md) · [Design_AI_Mask_Detection](../../../docs/design/Design_AI_Mask_Detection.md) · [Design_AI_Hat_Detection](../../../docs/design/Design_AI_Hat_Detection.md) |
| Design | [Design_Distributed_AI_Pipeline](../../../docs/design/Design_Distributed_AI_Pipeline.md) — AnalysisClient·AnalysisAPI·SERVER_MODE 설계 |
| TC | [TC_AI_Human_Detection](../../../docs/tc/TC_AI_Human_Detection.md) · [TC_Object_Tracking](../../../docs/tc/TC_Object_Tracking.md) · [TC_AI_Fire_Smoke_Detection](../../../docs/tc/TC_AI_Fire_Smoke_Detection.md) |
| TC | [TC_AI_Cloth_Analysis](../../../docs/tc/TC_AI_Cloth_Analysis.md) · [TC_AI_Color_Analysis](../../../docs/tc/TC_AI_Color_Analysis.md) · [TC_AI_Mask_Detection](../../../docs/tc/TC_AI_Mask_Detection.md) · [TC_AI_Hat_Detection](../../../docs/tc/TC_AI_Hat_Detection.md) |
| TC | [TC_Distributed_AI_Pipeline](../../../docs/tc/TC_Distributed_AI_Pipeline.md) — 분산 파이프라인 기능별 테스트 케이스 |
| Ops | [ONNX_Runtime_Provider_Diagnostics](../../../docs/ops/ONNX_Runtime_Provider_Diagnostics.md) · [ONNX_Runtime_Source_Build_CUDA13](../../../docs/ops/ONNX_Runtime_Source_Build_CUDA13.md) |
| Ops | [Distributed_AI_Pipeline_Setup](../../../docs/ops/Distributed_AI_Pipeline_Setup.md) — 분산 배포 운영 가이드 |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `detection.js` | `docs/design/Design_AI_Human_Detection.md`, `docs/srs/SRS_AI_Human_Detection.md`, `docs/tc/TC_AI_Human_Detection.md` |
| `tracking.js`, `trackerConfig.js` | `docs/design/Design_Object_Tracking.md`, `docs/srs/SRS_Object_Tracking.md`, `docs/tc/TC_Object_Tracking.md` |
| `behaviorEngine.js` | `docs/design/Design_LTS2026_Loitering_Tracking_System.md`, `docs/srs/SRS_LTS2026_Loitering_Tracking_System.md` |
| `attributePipeline.js`, `colorClothService.js` | `docs/design/Design_AI_Cloth_Analysis.md`, `docs/design/Design_AI_Color_Analysis.md`, `docs/tc/TC_AI_Cloth_Analysis.md`, `docs/tc/TC_AI_Color_Analysis.md` |
| `fireSmokeService.js` | `docs/design/Design_AI_Fire_Smoke_Detection.md`, `docs/srs/SRS_AI_Fire_Smoke_Detection.md`, `docs/tc/TC_AI_Fire_Smoke_Detection.md` |
| `protectiveEquipService.js` | `docs/design/Design_AI_Mask_Detection.md`, `docs/design/Design_AI_Hat_Detection.md`, `docs/tc/TC_AI_Mask_Detection.md`, `docs/tc/TC_AI_Hat_Detection.md` |
| `utils/onnxOptions.js` | `docs/ops/ONNX_Runtime_Provider_Diagnostics.md` |
| `pipelineManager.js` (서비스 추가) | 해당 기능의 PRD + SRS + Design + TC 신규 문서 생성 |
| `pipelineManager.js` (SERVER_MODE 분기 변경) | `docs/design/Design_Distributed_AI_Pipeline.md`, `docs/tc/TC_Distributed_AI_Pipeline.md` |
| `services/analysisClient.js` | `docs/design/Design_Distributed_AI_Pipeline.md`, `docs/srs/SRS_Distributed_AI_Pipeline.md` |
| `routes/analysisApi.js` | `docs/design/Design_Distributed_AI_Pipeline.md`, `docs/srs/SRS_Distributed_AI_Pipeline.md`, `docs/tc/TC_Distributed_AI_Pipeline.md` |

**공통 규칙**
- **새 기능 추가** → PRD + SRS + Design + TC 문서 모두 신규 작성 또는 기존 문서에 항목 추가
- **버그 수정** → 스펙 오류가 원인이면 SRS·Design 수정, TC에 회귀 케이스 추가
- **임계값·파라미터 변경** → SRS 제약 조건 섹션 반영 + TC 경계값 업데이트
- **AI 모델 교체** → Design 아키텍처 섹션 + SRS 성능 요구사항 + TC 정확도 기준 업데이트

## 최근 운영 변경 (2026-06-05)

- ONNX provider startup diagnostics가 추가되어 서버 시작 시 지원 backend를 1회 점검합니다.
- 구현 위치:
  - `server/src/index.js` (startup check 실행)
  - `server/src/utils/onnxOptions.js` (provider 선택/비활성화 로직)
- 동작 요약:
  - `ONNX_CUDA=1`인데 CUDA backend가 없으면 CUDA를 런타임에서 비활성화하고 CPU 폴백
  - Windows에서 `ONNX_CUDA=0`이면 `['dml','cpu']` 우선 시도
  - DML 미지원 시 CPU 폴백으로 반복 경고/실패 최소화
- 운영 문서: `docs/ops/ONNX_Runtime_Provider_Diagnostics.md`

## 최근 운영 변경 (2026-06-08)

- `SERVER_MODE=streaming`에서는 서버 시작 시 `pipelineManager.loadFaceServiceEagerly()`를 호출하지 않습니다.
- 목적: streaming 노드에서 로컬 PAR/ArcFace/FireSmoke 모델 선로딩을 방지하고, 분석은 원격 `ANALYSIS_SERVER_URL`로만 위임합니다.
- 구현 위치:
  - `server/src/index.js` (streaming 모드 eager-load 스킵)
  - `server/src/services/pipelineManager.js` (`loadFaceServiceEagerly()` 내부 2차 가드)
- 회귀 테스트:
  - `test/api/streaming_mode_model_skip.test.js`
  - `docs/tc/TC_Streaming_Model_Load_Policy.md`

- `SERVER_MODE=streaming`에서 `ANALYSIS_SERVER_URL`이 비어 있어도 서버는 종료되지 않습니다.
- 이 경우 monitoring-only(영상 스트리밍만 유지, 원격 AI 결과 미수신)로 동작합니다.

## 최근 운영 변경 (2026-06-09)

### 1. analysisApi.js — Eager Loading (Promise Mutex 패턴)

**변경 전 문제:** 모델을 첫 요청 시 lazy 로딩했고, 로딩 중(`_servicesLoading=true`) 두 번째 요청이 200ms 대기 후 재시도하는 spin-wait 패턴이 있어 동시 요청 시 모델이 중복 로드될 경합 조건(race condition)이 존재했음. 또한 로딩 중 streaming 서버의 100ms 짧은 타임아웃 요청들이 모두 실패해 circuit breaker가 열림.

**변경 후:**
```javascript
let _loadPromise = null;

async function _ensureServices() {
  if (_servicesReady) return;
  if (!_loadPromise) _loadPromise = _loadServices();  // 한 번만 생성
  await _loadPromise;                                  // 모든 호출자가 같은 Promise를 기다림
}

// 서버 시작 직후 사전 로딩 시작
setImmediate(() => { _ensureServices().catch(...); });
```
- `setImmediate()` — 이벤트 루프 첫 tick에서 로딩 시작. 첫 요청 전 ONNX 모델이 준비됨
- Promise mutex — 동시 요청 시에도 `_loadServices()`는 단 한 번만 실행

### 2. pipelineManager.js — ANALYSIS_FPS per-camera 레이트 리미터

```javascript
const _ANALYSIS_FPS         = Math.max(0, parseFloat(process.env.ANALYSIS_FPS || '0'));
const _ANALYSIS_INTERVAL_MS = _ANALYSIS_FPS > 0 ? 1000 / _ANALYSIS_FPS : 0;

// frame 핸들러 내 (streaming 모드)
if (_ANALYSIS_INTERVAL_MS > 0) {
  if (timestamp - ctx._lastAnalysisQueueAt < _ANALYSIS_INTERVAL_MS) return;
}
ctx._lastAnalysisQueueAt = timestamp;
```

- `ANALYSIS_FPS=0` (기본값, 권장): 레이트 리미터 비활성 → analysis 서버 추론 속도가 직접 처리량 결정
- `ANALYSIS_FPS=N`: 카메라당 N fps로 하드 캡 → 원격 서버/대역폭 제한 환경용
- 추론이 빨라지면 (GPU 업그레이드, 모듈 비활성화) fps가 자동으로 증가 — 코드 변경 불필요

### 3. analyticsConfig.js — isEnabled() 알 수 없는 키 버그 수정

**변경 전:** `return _getOrInit()[moduleId] !== false;`
→ DB에 존재하지 않는 키(undefined)도 `!== false` 조건을 통과해 `true` 반환. 잘못된 DB 키나 테스트 키가 활성화된 것처럼 처리되어 불필요한 추론이 실행됨.

**변경 후:**
```javascript
function isEnabled(moduleId) {
  const cfg = _getOrInit();
  if (!(moduleId in DEFAULT_CONFIG)) return false;  // 알 수 없는 모듈은 항상 비활성
  return cfg[moduleId] !== false;
}
```
- `DEFAULT_CONFIG`에 없는 모듈 ID는 무조건 비활성 처리
- DB 가비지 키(`__tc_f001_test_key__` 등)가 추론 파이프라인에 영향을 주지 않음

### 4. ANALYSIS_REQUEST_TIMEOUT_MS 올바른 설정 기준

- **잘못된 설정 (100ms):** ONNX 추론(150~1400ms)이 완료되기 전 타임아웃 → 모든 요청 실패 → circuit breaker 작동 (15초 차단) → 반복
- **올바른 설정:** 최악 추론 시간의 3배 이상. CPU 전용이면 5000ms, GPU면 2000ms
- `ANALYSIS_REQUEST_TIMEOUT_MS` < 실제 추론 시간이면 모든 프레임이 드롭되고 분석이 완전히 중단됨
