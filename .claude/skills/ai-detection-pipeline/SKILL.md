---
name: ai-detection-pipeline
description: "LTS-2026 AI 추론 파이프라인 개발 및 디버깅. Use when: YOLOv8 감지 설정, behaviorEngine 배회 점수 조정, attributePipeline 속성 분석(의상·색상·마스크·헬멧), fireSmokeService 화재/연기 감지, 감지 임계값 튜닝, pipelineManager 서비스 추가/수정, AI 모델 교체, 감지 정확도 문제 해결, Human Parsing 기반 정밀 색상 분류(opt-in), Appearance/Body Re-ID(OSNet, opt-in), Cloth-PAR PromptPAR/OpenPAR 모델 선택 및 PromptPAR 사전 메모리 게이트(가용 RAM 부족 시 Cloth 분석 자동 비활성화), Age Estimation(연령 예측, InsightFace GenderAge/ViT Age Classifier admin-selectable, opt-in), Gender Classification(성별 분류, InsightFace GenderAge/ViT Gender Classifier admin-selectable, opt-in), AI Models Active 선택의 서버 재시작 영속화(settings 테이블, DB_TYPE json/mongodb 공통). Covers: detection.js, behaviorEngine.js, attributePipeline.js, pipelineManager.js, trackerConfig.js, tracking.js, colorClothService.js, fireSmokeService.js, protectiveEquipService.js, appearanceReidService.js, ageEstimationService.js, genderClassificationService.js, activeModelConfig.js, qdrantService.js, kmeansColor.js."
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
| `server/src/services/activeModelConfig.js` | AI Models Active 선택 영속화 — `settings` 테이블(row id `activeModels`), family→modelId 맵, 서버 재시작 시 `analysisApi.js`가 자동 복원(§18) |
| `server/src/services/pipelineManager.js` | 서비스 생명주기 관리 |
| `server/src/services/colorClothService.js` | 색상 및 의류 분석 — Phase-3 Human Parsing(`_runHumanParsing()`) 포함, opt-in (`humanParsing` 토글 기본 비활성) |
| `server/src/services/fireSmokeService.js` | 화재·연기 감지 모델 |
| `server/src/services/protectiveEquipService.js` | 안전모·마스크 착용 감지 |
| `server/src/services/faceService.js` | 얼굴 인식 및 Re-ID 임베딩 |
| `server/src/services/appearanceReidService.js` | CrossCamera Phase-2 Appearance/Body Re-ID — OSNet 256D 임베딩 추출, opt-in (모델 파일 미배포 시 자동 비활성) |
| `server/src/services/ageEstimationService.js` | 연령 예측 — InsightFace GenderAge(경량, 직접 ONNX)/ViT Age Classifier(정밀, `hfOptimumExport`) admin-selectable, 얼굴crop 우선·사람crop 폴백, opt-in (`ageEstimation` 토글, Proposed) |
| `server/src/services/genderClassificationService.js` | 성별 분류 — InsightFace GenderAge(Age Estimation과 동일 `genderage.onnx` 파일 공유, 별도 세션)/ViT Gender Classifier(정밀, `hfOptimumExport`) admin-selectable, 얼굴crop 우선·사람crop 폴백, opt-in (`genderClassification` 토글, Proposed) — `pipelineManager.js`와 `analysisApi.js` 양쪽 진입점에 최초 구현부터 연동(§17) |
| `server/src/utils/kmeansColor.js` | K-Means 대표색 클러스터링 — Human Parsing 마스크 픽셀 대표색 추출용, 단위 테스트 완료 |

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

### AI 모델 카탈로그 — 런타임 전환 (YOLO 탐지기 + face/PPE/fire-smoke/cloth-PAR/Human Parsing/Appearance Re-ID/Age Estimation/Gender Classification)

`analysisApi.js`는 `MODEL_CATALOG`(YOLO 20종) + `EXTENDED_CATALOG`(face-detection/face-recognition/ppe/fire-smoke/cloth-par/human-parsing/appearance-reid/age-estimation, `family` 필드로 구분)를 `ALL_MODELS`로 통합 관리합니다. 서버 재시작 없이 모델 다운로드·전환이 가능합니다.

`age-estimation` family는 InsightFace GenderAge(직접 ONNX)와 ViT Age Classifier(HuggingFace `optimum` 기반 신규 `hfOptimumExport` 변환 — 기존 `hfExport`는 ultralytics 전용이라 ViT 같은 non-YOLO 아키텍처를 변환할 수 없어 별도 전략 추가) 두 모델을 admin-selectable로 제공합니다. `_findPythonWithOptimum()`이 `import optimum, transformers`를 확인합니다.

| API | 설명 |
|---|---|
| `GET /api/analysis/models` | 전체 family 카탈로그 조회 (downloaded/active/downloading/converting 상태 포함) |
| `POST /api/analysis/models/switch { modelId }` | family별 활성 모델 핫 스왑 — `_activeFileForEntry()`가 family에 따라 올바른 서비스(`_attrPipeline._color`, `_appearanceReid` 등)로 라우팅. 성공 시 `activeModelConfig.js`가 `settings` 테이블에 영속화(§18) — 서버 재시작 후에도 유지됨 |
| `POST /api/analysis/models/deactivate { modelId }` | family별 활성 모델 언로드(`unload()`/`unloadDetector()`/`unloadRecognizer()`/`unloadPar()`/`unloadHumanParsing()`) — ONNX 세션 release + ready 상태 초기화. YOLO 탐지기 family는 대상 아님(400) — 배회 감지 핵심 파이프라인이라 항상 활성 모델 필요. 성공 시 영속화되어 재시작 후에도 비활성 상태 유지(§18) |
| `POST /api/analysis/models/download { modelId }` | 모델 다운로드 (직접 ONNX 또는 HuggingFace `.pt`→`ultralytics export` 변환); `manualOnly:true` 모델(예: `openpar-resnet50-pa100k`)은 409 반환 — 수동 배치 필요 |

`human-parsing`/`appearance-reid` family는 코드 구현이 완료되어 있으나 모델 파일이 `downloadModels.js`의 `DIRECT_MODELS`에서 기본 `enabled:false`(라이선스 검토 후 수동 활성화) — Admin Dashboard "AI Models" 탭에서 개별 다운로드해야 활성화됨. 상세: `docs/design/Design_AI_AppearanceReID.md` §12.6, `docs/design/Design_AI_Color_Analysis.md` §10.

#### YOLO26 / YOLO12 다운로드 특이사항

Ultralytics는 YOLO26·YOLO12에 대해 `.pt`(PyTorch)만 공식 배포하며 ONNX 미제공. 서버가 자동으로:
1. `.pt` 다운로드 (Ultralytics v8.4.0 릴리스)
2. Python `ultralytics export` 실행 → ONNX 변환 (최대 5분)
3. `.pt` 삭제

Python 인터프리터 자동 탐지 순서:
```
PYTHON_EXEC → PYTHON_EXEC_LINUX → /usr/bin/python3 → python3 → python
```
> 단순 `import ultralytics`가 아닌 **YOLO12 지원 여부**(cfg/models/12 디렉토리 존재)를 검사.
> ultralytics < 8.3.x는 YOLO12 아키텍처 미지원 → 해당 인터프리터 건너뜀.
> 이 서버에서 `/usr/bin/python3` (Python 3.7.5, ultralytics 8.0.145)는 건너뛰고,
> `python3` → `~/.local/bin/python3` (Python 3.11.9, ultralytics 8.4.63)이 선택됨.
> YOLO26은 ultralytics ≥ 8.4.x 필요 — 동일 인터프리터 경로로 지원 가능.

**`_lzma` 컴파일 (시스템 의존성 설정):**
`~/.local/opt/python3.11`은 `_lzma` 없이 빌드됨 → torchvision import 시 오류.
아래 과정으로 수동 컴파일하여 해결:
```bash
# 1. liblzma-dev 헤더 확보 (sudo 없이)
apt-get download liblzma-dev && dpkg -x liblzma-dev_*.deb /tmp/lzma-dev

# 2. CPython 3.11.9 _lzma C 소스 다운로드
curl -sL https://raw.githubusercontent.com/python/cpython/v3.11.9/Modules/_lzmamodule.c -o /tmp/_lzmamodule.c
curl -sL https://raw.githubusercontent.com/python/cpython/v3.11.9/Modules/clinic/_lzmamodule.c.h -o /tmp/clinic/_lzmamodule.c.h

# 3. 컴파일 (system liblzma.so.5 rpath 포함)
PY311_INC=~/.local/opt/python3.11/include/python3.11
gcc -O2 -fPIC -shared \
  -I$PY311_INC -I$PY311_INC/internal \
  -I/tmp/lzma-dev/usr/include -I/tmp \
  /tmp/_lzmamodule.c \
  -L/tmp/lzma-dev/usr/lib/x86_64-linux-gnu \
  -Wl,-rpath,/lib/x86_64-linux-gnu -llzma \
  -o ~/.local/opt/python3.11/lib/python3.11/lib-dynload/_lzma.cpython-311-x86_64-linux-gnu.so
```

**필요 패키지 자동 설치 (2026-07-14)**: `_findPythonWithUltralytics`/`_findPythonWithOptimum`/`_findPythonForPromptPAR`(`analysisApi.js`)는 후보 인터프리터 중 필요 패키지(`ultralytics`/`huggingface_hub`/`optimum-onnx`+`transformers`/`torch`+`torchvision`+`onnx`+`onnxruntime`+`gdown`+`ftfy`+`regex`)를 가진 것을 찾지 못하면, 실행 가능한 첫 인터프리터에 `pip install`을 자동 실행한 뒤 재검사합니다. 설치는 `execFile`(비동기)로 실행되어 서버 이벤트 루프를 막지 않습니다 — torch/torchvision 설치가 수 분 걸려도 다른 카메라·API 요청에는 영향 없습니다. 그래도 실패하면 기존과 동일한 안내 에러를 반환합니다.

**`optimum[exporters]` → `optimum-onnx` 패키지 분리 (2026-07-14)**: HuggingFace가 ONNX export 기능(`optimum.exporters.onnx`)을 base `optimum` 패키지에서 별도 PyPI 패키지 `optimum-onnx`로 분리했습니다(`optimum.*` 네임스페이스로는 그대로 설치됨, import 경로 불변 — `huggingface/optimum-onnx`). `pip install optimum[exporters]`는 여전히 에러 없이 성공하지만 `optimum.exporters.onnx` 서브모듈은 설치되지 않아, "pip install 성공 + optimum.exporters.onnx는 여전히 없음"이라는 혼란스러운 증상으로 프로덕션에서 재현됨 — 검증 스크립트는 `import optimum`이 아닌 `import optimum.exporters.onnx`를 확인해야 하고, 설치 명령은 `pip install -U optimum-onnx transformers`를 사용해야 합니다.

**HF_TOKEN (gated HuggingFace 저장소)**: `insightface-genderage`(buffalo_l)처럼 플레인 다운로드 URL이 HTTP 401을 반환하기 시작하면(저장소가 gated로 전환됨), `server/.env`에 `HF_TOKEN`을 설정하세요 — `doDownload()`가 `*.huggingface.co` 호스트에 한해 `Authorization: Bearer` 헤더를 자동 첨부합니다. `hfExport`/`hfOptimumExport` 경로(Python `huggingface_hub`/`optimum`)는 별도 코드 변경 없이 동일 환경변수를 자동으로 읽습니다.

**PromptPAR용 Windows CUDA 설치 자동화 (`setup-cuda.windows.ps1`, 2026-07-14)**: PromptPAR export(`exportPromptPAR.py`)는 OpenPAR 모델 코드가 `.cuda()`를 하드코딩해 CPU 폴백이 없음 — NVIDIA GPU가 있는 Windows 머신에서 `powershell -ExecutionPolicy Bypass -File server/src/scripts/setup-cuda.windows.ps1`(관리자 권한 필요)를 실행하면 nvidia-smi로 드라이버 확인 → CUDA Toolkit network installer 자동 다운로드·설치(기본 12.4.1, 드라이버는 이미 있다고 가정하고 기본적으로 건드리지 않음, `-IncludeDriver`로 opt-in) → 매칭되는 CUDA 지원 PyTorch wheel 설치 → `torch.cuda.is_available()` 검증까지 자동화합니다. GPU가 없는 머신에서는 애초에 동작하지 않으므로(CUDA는 NVIDIA 하드웨어 필수), 그 경우 GPU 머신에서 한 번 export한 `openpar_pa100k.onnx`를 대상 서버 `server/models/`에 복사하거나 `openpar-resnet50-pa100k`(manualOnly) 대안을 사용.

#### YOLO26 지원 모델 (mAP COCO val2017 50-95, 2026 출시 — NMS-free 엔드투엔드)

| ID | mAP | CPU (ms) | T4 (ms) | Params |
|---|---|---|---|---|
| yolo26n | 40.9 | 38.9 | 1.7 | 2.4M |
| yolo26s | 48.6 | 87.2 | 2.5 | 9.5M |
| yolo26m | 53.1 | 220.0 | 4.7 | 20.4M |
| yolo26l | 55.0 | 286.2 | 6.2 | 24.8M |
| yolo26x | 57.5 | 525.8 | 11.8 | 55.7M |

#### YOLO12 지원 모델 (mAP COCO val2017 50-95)

| ID | mAP | CPU (ms) | T4 (ms) | Params |
|---|---|---|---|---|
| yolo12n | 40.6 | 58 | 1.6 | 2.6M |
| yolo12s | 48.0 | 95 | 2.7 | 9.3M |
| yolo12m | 52.5 | 192 | 5.0 | 20.2M |
| yolo12l | 53.7 | 250 | 6.5 | 26.4M |
| yolo12x | 55.2 | 490 | 12.0 | 59.1M |

모든 시리즈(v8/11/12/26) 출력 shape `[1, 84, 8400]` — `DetectionService._postprocess()` 변경 없이 호환.

#### 배치 다운로드 스크립트

```bash
cd server && node src/scripts/downloadModels.js
```

- YOLO12 5개 모델 자동 다운로드 + ONNX 변환
- PPE(`yolov8m_ppe.onnx`)·Fire & Smoke(`yolov8s_fire_smoke.onnx`)도 `HF_EXPORT_MODELS`/`exportHfPtToOnnx()`로 자동 다운로드+변환 (HuggingFace Hub `.pt` → `ultralytics export`, `huggingface_hub` Python 패키지 필요)
- cloth-PAR는 두 모델이 admin-selectable: `openpar_pa100k.onnx`(PromptPAR, CLIP ViT-L)는 `pyExport`(`exportPromptPAR.py` — OpenPAR repo clone + Google Drive 체크포인트 + CUDA GPU export, §14 참고)로 자동화되어 있고, `openpar_resnet50_pa100k.onnx`(OpenPAR, ResNet50)는 공개 사전학습 ONNX가 없어 자동화 불가 — `PYTHON_EXPORT_INSTRUCTIONS`에 수동 export 절차만 안내
- 이미 존재하는 파일은 건너뜀

**SDLC 참조:** [SRS_AI_Model_Catalog](../../../docs/srs/SRS_AI_Model_Catalog.md) · [Design_AI_Model_Catalog](../../../docs/design/Design_AI_Model_Catalog.md) · [TC_AI_Model_Catalog](../../../docs/tc/TC_AI_Model_Catalog.md) · `test/api/model_catalog.test.js`

### YOLOv8 모델 교체 (레거시)
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
| RFP | [RFP_AI_Model_Catalog](../../../docs/rfp/RFP_AI_Model_Catalog.md) — YOLOv8/YOLO11/YOLO12 모델 카탈로그·런타임 전환 |
| PRD | [PRD_LTS2026_Loitering_Tracking_System](../../../docs/prd/PRD_LTS2026_Loitering_Tracking_System.md) · [PRD_Object_Tracking](../../../docs/prd/PRD_Object_Tracking.md) · [PRD_AI_Human_Detection](../../../docs/prd/PRD_AI_Human_Detection.md) · [PRD_AI_Vehicle_Detection](../../../docs/prd/PRD_AI_Vehicle_Detection.md) |
| PRD | [PRD_AI_Fire_Smoke_Detection](../../../docs/prd/PRD_AI_Fire_Smoke_Detection.md) · [PRD_AI_Cloth_Analysis](../../../docs/prd/PRD_AI_Cloth_Analysis.md) · [PRD_AI_Color_Analysis](../../../docs/prd/PRD_AI_Color_Analysis.md) · [PRD_AI_Mask_Detection](../../../docs/prd/PRD_AI_Mask_Detection.md) · [PRD_AI_Hat_Detection](../../../docs/prd/PRD_AI_Hat_Detection.md) |
| PRD | [PRD_Distributed_AI_Pipeline](../../../docs/prd/PRD_Distributed_AI_Pipeline.md) — SERVER_MODE 제품 요구사항 |
| PRD | [PRD_AI_Model_Catalog](../../../docs/prd/PRD_AI_Model_Catalog.md) — 15종 YOLO 모델 카탈로그 제품 요구사항 |
| SRS | [SRS_LTS2026_Loitering_Tracking_System](../../../docs/srs/SRS_LTS2026_Loitering_Tracking_System.md) · [SRS_Object_Tracking](../../../docs/srs/SRS_Object_Tracking.md) · [SRS_AI_Human_Detection](../../../docs/srs/SRS_AI_Human_Detection.md) |
| SRS | [SRS_AI_Fire_Smoke_Detection](../../../docs/srs/SRS_AI_Fire_Smoke_Detection.md) · [SRS_AI_Cloth_Analysis](../../../docs/srs/SRS_AI_Cloth_Analysis.md) · [SRS_AI_Color_Analysis](../../../docs/srs/SRS_AI_Color_Analysis.md) · [SRS_AI_Mask_Detection](../../../docs/srs/SRS_AI_Mask_Detection.md) · [SRS_AI_Hat_Detection](../../../docs/srs/SRS_AI_Hat_Detection.md) |
| SRS | [SRS_Distributed_AI_Pipeline](../../../docs/srs/SRS_Distributed_AI_Pipeline.md) — 분산 파이프라인 소프트웨어 요구사항 |
| SRS | [SRS_AI_Model_Catalog](../../../docs/srs/SRS_AI_Model_Catalog.md) — FR-MC-001~022, YOLO12 PT→ONNX 파이프라인 |
| RFP/PRD/SRS/Design/TC | [RFP_AI_Age_Estimation](../../../docs/rfp/RFP_AI_Age_Estimation.md) · [PRD_AI_Age_Estimation](../../../docs/prd/PRD_AI_Age_Estimation.md) · [SRS_AI_Age_Estimation](../../../docs/srs/SRS_AI_Age_Estimation.md) · [Design_AI_Age_Estimation](../../../docs/design/Design_AI_Age_Estimation.md) · [TC_AI_Age_Estimation](../../../docs/tc/TC_AI_Age_Estimation.md) — 연령 예측 듀얼 모델, `hfOptimumExport` 신규 변환 경로 |
| Design | [Design_LTS2026_Loitering_Tracking_System](../../../docs/design/Design_LTS2026_Loitering_Tracking_System.md) · [Design_Object_Tracking](../../../docs/design/Design_Object_Tracking.md) · [Design_AI_Human_Detection](../../../docs/design/Design_AI_Human_Detection.md) |
| Design | [Design_AI_Fire_Smoke_Detection](../../../docs/design/Design_AI_Fire_Smoke_Detection.md) · [Design_AI_Cloth_Analysis](../../../docs/design/Design_AI_Cloth_Analysis.md) · [Design_AI_Color_Analysis](../../../docs/design/Design_AI_Color_Analysis.md) · [Design_AI_Mask_Detection](../../../docs/design/Design_AI_Mask_Detection.md) · [Design_AI_Hat_Detection](../../../docs/design/Design_AI_Hat_Detection.md) |
| Design | [Design_Distributed_AI_Pipeline](../../../docs/design/Design_Distributed_AI_Pipeline.md) — AnalysisClient·AnalysisAPI·SERVER_MODE 설계 |
| Design | [Design_AI_Model_Catalog](../../../docs/design/Design_AI_Model_Catalog.md) — MODEL_CATALOG 구조, 다운로드 파이프라인, 런타임 전환 |
| TC | [TC_AI_Human_Detection](../../../docs/tc/TC_AI_Human_Detection.md) · [TC_Object_Tracking](../../../docs/tc/TC_Object_Tracking.md) · [TC_AI_Fire_Smoke_Detection](../../../docs/tc/TC_AI_Fire_Smoke_Detection.md) |
| TC | [TC_AI_Cloth_Analysis](../../../docs/tc/TC_AI_Cloth_Analysis.md) · [TC_AI_Color_Analysis](../../../docs/tc/TC_AI_Color_Analysis.md) · [TC_AI_Mask_Detection](../../../docs/tc/TC_AI_Mask_Detection.md) · [TC_AI_Hat_Detection](../../../docs/tc/TC_AI_Hat_Detection.md) |
| TC | [TC_Distributed_AI_Pipeline](../../../docs/tc/TC_Distributed_AI_Pipeline.md) — 분산 파이프라인 기능별 테스트 케이스 |
| TC | [TC_AI_Model_Catalog](../../../docs/tc/TC_AI_Model_Catalog.md) — TC-MC-001~011, 모델 카탈로그·전환·YOLO12 변환 |
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
| `routes/analysisApi.js` (MODEL_CATALOG 변경) | `docs/design/Design_AI_Model_Catalog.md`, `docs/srs/SRS_AI_Model_Catalog.md`, `docs/tc/TC_AI_Model_Catalog.md` |
| `scripts/downloadModels.js` (YOLO12 추가) | `docs/design/Design_AI_Model_Catalog.md`, `docs/tc/TC_AI_Model_Catalog.md` |
| `services/ageEstimationService.js` | `docs/design/Design_AI_Age_Estimation.md`, `docs/srs/SRS_AI_Age_Estimation.md`, `docs/tc/TC_AI_Age_Estimation.md`, `docs/design/Design_AI_Model_Catalog.md` §10 |
| `services/genderClassificationService.js` | `docs/design/Design_AI_Gender_Classification.md`, `docs/srs/SRS_AI_Gender_Classification.md`, `docs/tc/TC_AI_Gender_Classification.md`, `docs/mrd/MRD_AI_Gender_Classification.md`, `docs/ops/Gender_Classification_Guide.md` |

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

### 5. analysisClient.js — X-LTS-Meta 헤더 Base64 인코딩 (2026-06-09)

**증상:** YouTube 카메라(한글 이름 포함)의 프레임이 분석 서버로 전달되지 않음.
`[AnalysisClient][yt-84b6d] frame 1 error: Invalid character in header content ["X-LTS-Meta"]`

**원인:** `X-LTS-Meta` 헤더에 카메라 이름(한글 등 Non-ASCII 문자)을 raw JSON으로 전송 → Node.js HTTP 모듈이 non-ASCII 헤더 값을 거부.

**수정 (analysisClient.js `_postJpeg`):**
```javascript
// 변경 전
'X-LTS-Meta': metaJson,

// 변경 후
'X-LTS-Meta': Buffer.from(metaJson).toString('base64'),
```

**수정 (analysisApi.js `POST /frame`):**
```javascript
// 변경 전
meta = JSON.parse(req.headers['x-lts-meta'] || '{}');

// 변경 후 (base64 + legacy raw JSON 모두 지원)
const raw = req.headers['x-lts-meta'] || '{}';
const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
meta = JSON.parse(jsonStr);
```

### 6. analysisClient.js — "reconnected" 로그 스팸 수정 (2026-06-09)

**증상:** `[AnalysisClient][cameraId] reconnected to analysis server`가 초당 수십 회 반복 출력됨.

**원인:** `_consecutive` 카운터가 전역(global) — 어떤 카메라 하나가 단발성 실패하면 `_consecutive++`, 다음 성공 시 `_consecutive > 0`이 참이어서 즉시 "reconnected" 로그 출력. circuit breaker 개방과 무관하게 모든 단발 실패마다 발생.

**수정:**
```javascript
// 변경 전
if (this._consecutive > 0) {
  this._consecutive = 0;
  console.log(`[AnalysisClient][${cameraId?.slice(0,8)}] reconnected to analysis server`);
}

// 변경 후: circuit-open 임박 수준(≥2회 연속 실패) 이후 복구 시에만 로그
const wasNearOpen = this._consecutive >= CIRCUIT_OPEN_THRESHOLD - 1;
this._consecutive = 0;
if (wasNearOpen) {
  console.log(`[AnalysisClient][${cameraId?.slice(0,8)}] reconnected to analysis server`);
}
```
- `CIRCUIT_OPEN_THRESHOLD = 3` 이므로, 2회 이상 연속 실패 후 복구될 때만 로그 출력
- 단발성 타임아웃(네트워크 지터, 일시적 지연)은 로그 없이 조용히 처리됨

### 7. analysisApi.js — ECONNABORTED (request aborted) 에러 핸들링 (2026-06-10)

**증상:** analysis 서버 로그에 `BadRequestError: request aborted (ECONNABORTED)` 반복 출력.

**원인:** streaming 서버가 JPEG 바디 전송 중 `ANALYSIS_REQUEST_TIMEOUT_MS` 만료 → 소켓 `destroy()` → analysis 서버 `express.raw()` 에서 `ECONNABORTED` 발생 → 에러 핸들러 없음 → Express 전역 에러.

**수정 1 — `_parseFrameBody` 미들웨어:**
```javascript
function _isAbortError(err) {
  return err?.type === 'request.aborted' || err?.code === 'ECONNABORTED';
}

function _parseFrameBody(req, res, next) {
  const parser = ct === 'image/jpeg'
    ? express.raw({ type: 'image/jpeg', limit: '10mb' })
    : express.json({ limit: '20mb' });
  parser(req, res, (err) => {
    if (err && _isAbortError(err)) { _metrics.errorsTotal++; return; }
    next(err);
  });
}
```

**수정 2 — router 말단 에러 핸들러 (belt-and-suspenders):**
```javascript
router.use((err, req, res, next) => {
  if (_isAbortError(err)) { _metrics.errorsTotal++; return; }
  _metrics.errorsTotal++;
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});
```

- 기능상 무해한 에러 — streaming 서버는 이미 연결을 끊었으므로 응답 불필요
- `errorsTotal` 카운터에만 집계 (대시보드에서 모니터링 가능)
- 재발 빈도 감소: `ANALYSIS_REQUEST_TIMEOUT_MS` 증가로 body 전송 완료 시간 확보

### 8. fireSmokeService.js — 감도 조정 환경변수 (2026-06-10)

**문제:** `CONF_THRESHOLD = 0.35`가 하드코딩되어 역광·야간·초기 단계 연기 환경에서 감지 누락.

**수정:** 환경변수로 재정의 가능하게 변경:

```javascript
// server/src/services/fireSmokeService.js
const CONF_THRESHOLD = Math.min(1, Math.max(0,
  parseFloat(process.env.FIRE_SMOKE_CONF_THRESHOLD ?? '0.35')));
const NMS_THRESHOLD  = Math.min(1, Math.max(0,
  parseFloat(process.env.FIRE_SMOKE_NMS_THRESHOLD  ?? '0.45')));
```

**감도 조정 기준:**

| 환경 | 권장값 |
|---|---|
| 기본 (실외 낮, 명확한 화염) | `0.35` (기본) |
| 초기 단계 연기, 역광, 야간 | `0.20` |
| 최대 감도 (오탐 허용) | `0.10` |

- 서버 재시작 후 로그: `[FireSmokeService] loaded (conf=0.2 nms=0.45)` 로 확인
- `FIRE_SMOKE_NMS_THRESHOLD`: 낮을수록 겹치는 박스 억제 강화 (기본 0.45 권장)

### 8. AnalysisServerDashboard.tsx — FPS 스파크라인 그래프 (2026-06-10)

Per-source 테이블의 FPS 컬럼에 60초 롤링 히스토리 스파크라인을 추가했다.

**구현 포인트:**

```tsx
const FPS_HISTORY_MAX = 30; // 30 samples × 2s poll = 60s

// 폴링 콜백에서 기존 setMetrics와 함께 배치 업데이트
setFpsHistory(prev => {
  const next = new Map(prev);
  for (const cam of data.cameras) {
    const hist = next.get(cam.cameraId) ?? [];
    const updated = [...hist, cam.inputFps1s];
    next.set(cam.cameraId, updated.length > FPS_HISTORY_MAX
      ? updated.slice(-FPS_HISTORY_MAX) : updated);
  }
  return next;
});
```

**FpsSparkline SVG 렌더링:**
- 외부 차트 라이브러리 없이 순수 SVG — `<polyline>` 라인 + `<path>` area fill + 마지막 점 `<circle>`
- 그라디언트 ID 충돌 방지: gradient 대신 `fill="rgba(56,189,248,0.08)"` 사용
- `max = Math.max(...data, 1)` — 전체 0fps 상태에서 divide-by-zero 방지
- 데이터 2개 미만 시 `—` 텍스트 표시
- 그리드 컬럼 `0.7fr → 1.4fr`로 확장, 헤더 `FPS(1s) → FPS / 추이`로 변경

### 10. db.js — analysisEvents 컬렉션 등록 (2026-06-10)

**배경:** `routes/analysisApi.js`가 화재·연기·배회 이벤트를 `analysisEvents` 컬렉션에 저장하는 기능이 추가됨.

**필수 조건:** `db.js`의 `ALL_TABLES`에 컬렉션 이름이 없으면 `store[table]`이 `undefined`이어서 `db.find()` 호출 시 `TypeError`가 발생함.

**수정 (db.js `ALL_TABLES`):**
```javascript
const ALL_TABLES = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces', 'settings',
  'detectionSnapshots', 'faceMatchHistory',
  'missing_persons', 'missing_person_detections',
  'analysisEvents',   // ← 추가: Analysis Mode 이벤트 영구 저장
];
```

**새 서비스 함수 (analysisApi.js):**
- `async _persistFireSmoke(db, io, cameraId, cameraName, ts, detections, jpegBuffer, fw, fh)` — 화재/연기 이벤트 + 크롭 저장 + `snapshot:new` Socket.IO emit (쿨다운 30초)
- `async _persistLoitering(db, io, cameraId, cameraName, ts, behaviors, jpegBuffer, fw, fh)` — 배회 이벤트 + 크롭 저장 + `snapshot:new` Socket.IO emit (쿨다운 60초)
- `_saveAnalysisEvent(db, event)` — 공통 저장 로직 (최대 500건 유지, 초과 시 가장 오래된 항목 삭제)
- `async _cropThumbnail(jpegBuffer, bbox, fw, fh)` — snapshotSvc.cropJpeg 래퍼, data URI 반환

**실시간 감지 Socket.IO emit 패턴 (analysis 서버):**
```javascript
// POST /api/analysis/process 핸들러
const io = req.app.get('io');

// 1. Global emit — 카메라 룸 없이 연결된 모든 클라이언트에 전달
if (io) {
  const fireSmokeWithId = fireSmoke.map(d => ({ ...d, objectId: d.objectId ?? d.className }));
  io.emit('detections', {
    cameraId, frameId, timestamp: ts,
    detections: [...enrichedObjects, ...faceDetections, ...fireSmokeWithId],
    frameWidth, frameHeight,
  });
}

res.json({ cameraId, frameId, ... });

// 2. Fire-and-forget persist + snapshot:new emit
if (db) {
  if (fireSmoke.length > 0) _persistFireSmoke(db, io, ...).catch(() => {});
  if (behaviors.length > 0) _persistLoitering(db, io, ...).catch(() => {});
}
```

**크롭 emit (persist 함수 내):**
```javascript
// _persistFireSmoke — fire/smoke objectId는 className('fire'|'smoke')을 pseudo-ID로 사용
if (io && cropData) io.emit('snapshot:new', { cameraId, objectId: det.className, className: det.className, timestamp: ts, cropData });

// _persistLoitering — 실제 trackId 사용
if (io && cropData) io.emit('snapshot:new', { cameraId, objectId, className: 'person', timestamp: ts, cropData });
```

**일반 tracked person 크롭 (snapshotSvc 경로):**

analysis 모드에서 combined/streaming과 동일하게 일반 person 크롭을 지원합니다.

```javascript
// res.json() 이후 setImmediate (non-blocking)
if (snapshotSvc.isEnabled() && enrichedObjects.length > 0 && io) {
  setImmediate(async () => {
    for (const det of enrichedObjects) {
      const hasFaceMatch = !!(det.face?.matchScore > 0) || !!det.matchScore;
      if (!snapshotSvc.shouldSave(cameraId, det.objectId, {
        isLoitering: det.isLoitering,
        hasFaceMatch,
        isFireSmoke: false,
        timestamp: new Date(ts).getTime(),
      })) continue;
      const { data: cropBuf } = await snapshotSvc.cropJpeg(buf, det.bbox, fw, fh);
      const snapId = await snapshotSvc.saveSnapshot(db, cam, det, cropBuf, ...);
      io.emit('snapshot:new', { cameraId, snapshotId: snapId, objectId: det.objectId,
                                className: det.className, timestamp: ts,
                                cropData: 'data:image/jpeg;base64,' + cropBuf.toString('base64') });
    }
  });
}
```

조건: `isFirstSeen` (새 객체 첫 등장) | `isLoitering` | `hasFaceMatch` | 또는 SNAPSHOT_INTERVAL_SEC 경과

`analysisEvents` 스키마에 `cropData?: string` 추가 (data:image/jpeg;base64,... 형식)

**Crop 해상도/품질:** `snapshotService.cropJpeg()`(`server/src/services/snapshotService.js`)는 `SNAPSHOT_MAX_DIMENSION`(기본 640px) / `SNAPSHOT_JPEG_QUALITY`(기본 85)로 `sharp`가 리사이즈·재인코딩합니다. `fit:'inside'` + `withoutEnlargement:true`로 비율 유지·업스케일 방지. 클라이언트 상세 뷰(예: `DetectionsTimelineInline`)는 이 crop을 `object-contain`으로 렌더링해 잘림 없이 표시해야 합니다 — 자세한 규칙은 `react-dashboard-dev/SKILL.md`의 "Crop 렌더링 규칙" 참고.

**조회/삭제 API:**
```
GET    /api/analysis/events?limit=N&type=fire,smoke,loitering
DELETE /api/analysis/events
```

> **규칙:** 새 컬렉션을 `db.find/insert/update/delete`로 사용하려면 반드시 `ALL_TABLES`에 먼저 추가해야 합니다. 추가하지 않으면 HTTP 500 에러 발생.

### 9. fireSmokeService.js — 임계값 런타임 변경 (2026-06-10)

**배경:** 환경변수 방식은 서버 재시작이 필요. UI에서 실시간으로 감도를 조정할 수 있도록 임계값을 인스턴스 프로퍼티로 승격.

**변경 내용 (`fireSmokeService.js`):**
```javascript
class FireSmokeService {
  constructor(options = {}) {
    // ...
    this.confThreshold = CONF_THRESHOLD;  // FIRE_SMOKE_CONF_THRESHOLD env var에서 초기화
    this.nmsThreshold  = NMS_THRESHOLD;   // FIRE_SMOKE_NMS_THRESHOLD env var에서 초기화
  }

  setThresholds({ confThreshold, nmsThreshold } = {}) {
    if (confThreshold != null) this.confThreshold = Math.min(1, Math.max(0, Number(confThreshold)));
    if (nmsThreshold  != null) this.nmsThreshold  = Math.min(1, Math.max(0, Number(nmsThreshold)));
  }
}

// _postprocess / _nms: 모듈 상수 대신 파라미터로 받음
function _postprocess(data, dims, origW, origH, scale, padL, padT, confThreshold, nmsThreshold) { ... }
function _nms(boxes, nmsThreshold) { ... }
```

**새 API 엔드포인트 (`analysisApi.js`):**
```
GET  /api/analysis/config/fire-smoke  → { confThreshold, nmsThreshold, available }
PATCH /api/analysis/config/fire-smoke → body: { confThreshold?, nmsThreshold? }
```

**UI (`VideoAnalyticsTab.tsx`):**
- `fireSmokeAvailable` 상태 → GET 결과의 `available` 필드로 결정; false시 패널 비표시
- "🔥 Fire / Smoke Sensitivity" 접이식 섹션 (Appearance Weights 아래, Kalman 위)
- Conf Threshold 슬라이더: 0.05~0.95, step 0.05
- NMS IoU Threshold 슬라이더: 0.10~0.90, step 0.05
- 300ms debounce 후 자동 PATCH, "Reset Defaults" 버튼 제공
- `accent-orange-500` 색상 테마 (화재/연기 강조)

## 최근 운영 변경 (2026-06-17)

### 11. DetectionTrack 생명주기 — 모드별 저장 전략

**배경:** `DetectionsTimelineInline.tsx` 하단 패널에서 Gantt 타임라인이 표시되지 않는 문제. 분석 서버에서 트랙이 저장되지 않았고, streaming 모드에서는 로컬 트랙도 없었음.

#### 11.1 모드별 저장 위치

| 모드 | 트랙 메타데이터 | 스냅샷 크롭 | Timeline 데이터 소스 |
|---|---|---|---|
| `combined` | 로컬 `detectionTracks` | 로컬 `detectionSnapshots` | 로컬 DB 직접 조회 |
| `analysis` | 분석 서버 `detectionTracks` | 분석 서버 `detectionSnapshots` | 로컬 DB 직접 조회 |
| `streaming` | 분석 서버 (primary) + 스트리밍 서버 shadow | 스트리밍 서버 원본 크롭 | 분석 서버 proxy → 로컬 fallback |

#### 11.2 db.js `ALL_TABLES` 필수 항목 (2026-06-17 기준)

```javascript
const ALL_TABLES = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces', 'settings',
  'detectionSnapshots', 'faceMatchHistory',
  'missing_persons', 'missing_person_detections',
  'analysisEvents',
  'detectionTracks',  // ← DetectionsTimeline Gantt 트랙
];
```

**규칙:** 새 컬렉션은 반드시 `ALL_TABLES`에 먼저 추가. 누락 시 `db.find()` TypeError.

#### 11.3 _trackMeta 구조 및 upsert 패턴

```javascript
// 모든 모드에서 ctx에 초기화
ctx._trackMeta = new Map();
// key = String(track.id) — UUID  ← rt.objectId 아님! (rt.id 사용)
// value = { firstSeenAt, lastSeenAt, className, maxRiskScore, isLoitering,
//           confidence, faceId, identity, zoneId, zoneName, color, cloth }

// combined/analysis: popRemovedTracks() 직후 처리
const removedBatch = tracker.popRemovedTracks(); // await 이전에 호출 필수!
for (const rt of removedBatch) {
  const trackKey = String(rt.id); // rt.objectId는 undefined!
  const meta = ctx._trackMeta.get(trackKey);
  if (!meta) continue;
  ctx._trackMeta.delete(trackKey);
  // dwellMs >= 1000 || isLoitering || riskScore >= 0.3 이면 저장
}

// streaming: _processRemoteResult()에서 remoteTracked 순회
for (const obj of remoteTracked) {
  const id = String(obj.objectId); // analysis 서버가 부여한 UUID
  ctx._trackMeta.set(id, { ... });
}
```

#### 11.4 Active Flush Timer (30s, 모든 모드)

```javascript
// 현재 프레임 내 객체 → inProgress: true upsert
// streaming 모드에서 stale 트랙(15s 미갱신) → inProgress: false finalize + _trackMeta 제거
const isStale = nowMs - meta.lastSeenAt > 15_000;
if (isStale && SERVER_MODE === 'streaming') {
  // finalize to detectionTracks(inProgress: false)
  ctx._trackMeta.delete(trackKey);
}
```

#### 11.5 Streaming 모드 스냅샷 원본 크롭

```javascript
// _processRemoteResult() 내 — 이미 구현된 코드
const { data: cropBuf } = await snapshotSvc.cropJpeg(
  _buf,             // 원본 카메라 JPEG (full resolution)
  det.bbox,         // analysis 서버가 원본 해상도 좌표로 스케일백한 bbox
  remoteFrameWidth, // analysis 서버가 반환한 원본 프레임 폭
  remoteFrameHeight
);
// ✅ 640px YOLO 내부 해상도가 아닌 원본 해상도에서 크롭
```

#### 11.6 analysisProxy.js 로컬 Fallback

```javascript
// GET /api/analysis/detection-tracks
// 1순위: analysis 서버 proxy
// 2순위 (연결 오류/타임아웃/5xx): 스트리밍 서버 로컬 detectionTracks DB
// 응답 필드: { tracks, total, source: 'local-streaming' }

// GET /api/analysis/detection-snapshots 동일 fallback 적용
```

**코드 위치:**
- `server/src/routes/analysisProxy.js` — `proxyGetWithFallback()`, `_localDetectionTracks()`, `_localDetectionSnapshots()`
- `server/src/services/pipelineManager.js` — `_processRemoteResult()` 내 `_trackMeta` 업데이트, active flush timer stale 처리
- `server/src/routes/analysisApi.js` — analysis 모드 트랙 저장 (`_trackMeta`, `popRemovedTracks()`, active flush)

---

### 12. detection.js — 다중 채널 동시 추론 시 채널 데이터 오염 버그 수정 (2026-06-23)

**증상:** analysis 서버에서 간헐적으로 Camera A의 감지 결과가 Camera B의 cameraId로 전달됨. 특히 카메라 수가 많을수록(4채널 이상) 빈도 증가.

**원인:** `DetectionService._preprocess()` 내부의 CHW Float32Array 입력 버퍼(`this._float32Buf`)를 생성자에서 단 한 번 할당하고 모든 호출에서 재사용.

```
// 레이스 컨디션 시나리오 (analysis 서버, 다중 카메라 동시 요청)
Camera A: _preprocess() → _float32Buf ← Camera A 픽셀 쓰기 완료
Camera B: _preprocess() → _float32Buf ← Camera B 픽셀로 덮어씀  ← 레이스!
Camera A: session.run()  → Camera B 픽셀로 추론 → A cameraId로 B 결과 반환
```

combined 모드 `pipelineManager.js`는 `ctx._inferring = true` 플래그로 카메라별 추론을 직렬화하므로 공유 버퍼가 안전했음. 그러나 analysis 서버의 `POST /api/analysis/frame`은 직렬화 없이 동시에 처리됨.

**수정 (`server/src/services/detection.js`):**
```javascript
// 수정 전 — constructor에 공유 버퍼, _preprocess에서 재사용
// this._float32Buf = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
// const float32 = this._float32Buf;

// 수정 후 — 호출마다 독립 할당
const float32 = new Float32Array(3 * numPixels);
```

**주의:** `ort.Tensor`는 TypedArray의 참조를 보유하므로, `detect()` 스코프에서 `tensor` 변수가 살아있는 동안 `float32` 버퍼가 GC되지 않음 → 안전.

**SRS:** FR-DAP-027 / **TC:** TC-DAP-009 (`test/api/distributed_pipeline.test.js`)

---

### 13. TcRunnerService — Analysis-only 스위트 Streaming 모드 스킵 (2026-06-24)

**배경:** `ai_detection_modules.test.js`, `analytics_config.test.js`, `model_catalog.test.js` 세 스위트는 `/api/analytics/config`, `/api/analysis/models` 등 로컬 AI 파이프라인 API에 의존한다. `SERVER_MODE=streaming` 서버는 이 API를 보유하지 않으므로, 해당 스위트가 실행되면 항상 실패하거나 오탐(false positive)을 생성한다.

**구현:**

1. **TcRunnerService.js** — `SUITES` 항목에 `analysisOnly: true` 플래그 추가, `_run()` 내부에서 `SERVER_MODE=streaming` 시 스킵:
   ```javascript
   { file: 'test/api/ai_detection_modules.test.js', ..., analysisOnly: true },
   { file: 'test/api/analytics_config.test.js', ..., analysisOnly: true },
   { file: 'test/api/model_catalog.test.js', ..., analysisOnly: true },
   // _run() 내부:
   if (isStreaming && suite.analysisOnly) {
     _save(runId, runAt, suite, 'TC-SKIP',
       `${suite.label} — skipped (SERVER_MODE=streaming, Analysis Server only)`, 'skip', null);
     continue;
   }
   ```

2. **테스트 스크립트 자체 skip** — `ai_detection_modules.test.js`, `analytics_config.test.js` 두 파일 모두 `main()` 진입 시 `/health`로 `serverMode` 확인 후 streaming이면 `exit 0`:
   ```javascript
   const serverMode = await getServerMode();
   if (serverMode === 'streaming') {
     console.log('⊘ TC-XXX-SKIP: ... skipped (SERVER_MODE=streaming, Analysis Server only)');
     process.exit(0);
   }
   ```

3. **AdminUsersPage.tsx TcResultsPanel** — `isStreaming` prop 추가, Analysis-only 스위트 결과 필터링:
   ```typescript
   const ANALYSIS_ONLY_SUITES = [
     'ai_detection_modules.test.js', 'analytics_config.test.js', 'model_catalog.test.js',
   ];
   const visibleResults = isStreaming
     ? filtered.filter(r => !ANALYSIS_ONLY_SUITES.some(s => r.suiteFile.includes(s)))
     : filtered;
   ```
   streaming 모드 시 노란 안내 배너 표시.

**코드 위치:**
- `server/src/services/TcRunnerService.js` — `analysisOnly` 플래그, `_run()` 스킵 로직
- `test/api/ai_detection_modules.test.js` — `getServerMode()` + main() 조기 종료
- `test/api/analytics_config.test.js` — 동일
- `client/src/pages/admin/AdminUsersPage.tsx` — `TcResultsPanel` `isStreaming` prop + 필터 + 배너

**SRS:** FR-DAP-028 / **TC:** TC-DAP-013 / **PRD:** AC-DAP-10 / **RFP:** FR-DAP-11

## 최근 운영 변경 (2026-07-12)

### 14. colorClothService.js — PromptPAR 사전 메모리 게이트 + OpenPAR 선택형 활성화

**배경:** PromptPAR(PA100k, CLIP ViT-L 백본, ~1.2GB)는 DirectML에서 추론 중 `DXGI_ERROR_DEVICE_REMOVED`가 발생해 CPU로 강제 실행된다(`forceCpu: true`). CPU 실행은 체크포인트+ONNX Runtime 세션 버퍼가 모두 시스템 RAM을 소비하므로, 가용 RAM이 부족한 상태에서 로드를 시도하면 서버 프로세스 전체가 OOM으로 죽을 위험이 있다. 이를 막기 위해 로드/전환 전에 가용 메모리를 먼저 확인하고, 부족하면 로그를 남기고 Cloth 분석을 자동으로 끄도록 변경했다. 동시에, 메모리 게이트가 없는 대안으로 OpenPAR(ResNet50, 동일 PA100k 26-attribute taxonomy)를 두 번째 `cloth-par` 모델로 추가해 Admin Dashboard에서 선택할 수 있게 했다.

**구현 (`colorClothService.js`):**
```javascript
const PROMPTPAR_MIN_FREE_MEM_MB = Number(process.env.PROMPTPAR_MIN_FREE_MEM_MB) || 2048;
const PROMPTPAR_GATED_FILENAMES = new Set(['openpar_pa100k.onnx']); // OpenPAR 파일명은 미포함 — 게이트 미적용

function checkPromptParMemory() {
  const freeMB = Math.round(os.freemem() / (1024 * 1024));
  return { ok: freeMB >= PROMPTPAR_MIN_FREE_MEM_MB, freeMB, requiredMB: PROMPTPAR_MIN_FREE_MEM_MB };
}

// load() / reloadPar() 양쪽에서 호출
_checkPromptParGate(filePath) {
  if (!_isPromptParFile(filePath)) return true;         // OpenPAR 등은 항상 통과
  const mem = checkPromptParMemory();
  if (mem.ok) return true;
  console.warn(`[ColorClothService] PromptPAR 수행 불가능: 가용 메모리 부족 (free=${mem.freeMB}MB < required=${mem.requiredMB}MB) — Cloth 분석을 비활성화합니다.`);
  require('./analyticsConfig').setConfig({ cloth: false });  // 실패해도 try/catch로 무시
  return false;
}
```

- **서버 시작 시(`load()`):** 게이트 실패 시 조용히 스킵(`_parReady` 유지 `false`) — 서버는 정상 기동
- **런타임 전환 시(`reloadPar()`, `POST /api/analysis/models/switch`):** 게이트 실패 시 `throw` — `analysisApi.js`의 기존 catch 블록이 HTTP 500으로 변환, Admin Dashboard 에러 배너에 표시
- OpenPAR(`openpar_resnet50_pa100k.onnx`)는 `PROMPTPAR_GATED_FILENAMES`에 없으므로 게이트가 항상 통과 — 메모리 부족 시 대체 활성화 경로로 사용

**카탈로그 추가 (`analysisApi.js` `EXTENDED_CATALOG`):**
```javascript
{ id: 'openpar-resnet50-pa100k', label: 'OpenPAR (ResNet50, PA100k)', family: 'cloth-par',
  series: 'Cloth Attribute (PAR)', file: 'openpar_resnet50_pa100k.onnx', size: 224,
  manualOnly: true, docRef: 'https://github.com/Event-AHU/OpenPAR', license: 'See OpenPAR repository' },
```

**UI:** `AdminUsersPage.tsx`의 `AiModelsSection()`은 family/series 기준으로 이미 제네릭하게 렌더링하므로 별도 UI 구현 없이 두 번째 행이 자동으로 나타남 — Cloth Attribute (PAR) 시리즈 아래 PromptPAR/OpenPAR가 각각 독립된 Activate 버튼과 함께 표시됨. 시리즈 footnote에 ≥2GB RAM 요구사항과 OpenPAR 대안을 안내하는 문구 추가.

**환경변수:** `PROMPTPAR_MIN_FREE_MEM_MB` (기본 `2048`) — `server/.env`에서 재정의 가능.

**회귀 테스트:** `test/api/model_catalog.test.js` Group A(TC-MC-017, catalog 구성)·Group D(TC-MC-018/019, 메모리 게이트 유닛 테스트 — `os.freemem()` monkey-patch, 실제 ONNX 파일/서버 불필요).

**SDLC 참조:** [Design_AI_Cloth_Analysis.md §11](../../../docs/design/Design_AI_Cloth_Analysis.md#11-model-choice--memory-gate) · [Design_AI_Model_Catalog.md §8](../../../docs/design/Design_AI_Model_Catalog.md#8-cloth-par-model-choice--promptpar-memory-gate) · [SRS_AI_Cloth_Analysis.md §12](../../../docs/srs/SRS_AI_Cloth_Analysis.md) (FR-CLT-022~028) · [TC_AI_Model_Catalog.md](../../../docs/tc/TC_AI_Model_Catalog.md) (TC-MC-017~019)

### 15. ageEstimationService.js — 연령 예측 신규 모듈, `hfOptimumExport` PT→ONNX 변환 전략 도입 (2026-07-12)

**배경:** 기존 `ageGroup`(3단계, `colorClothService.js`의 PA100k 부산물)과 별개로, 전용 연령 예측 모델을 Admin Dashboard에서 다운로드·활성화할 수 있어야 한다는 요구가 있었다. 기존 PT→ONNX 변환 파이프라인(`hfExport`)은 전부 `ultralytics.YOLO(pt).export()` 기반이라 ViT 분류기 같은 non-YOLO HuggingFace Transformers 아키텍처는 변환할 수 없었다 — 이를 위해 HuggingFace `optimum` 라이브러리를 사용하는 새 소스 전략(`hfOptimumExport`)을 신설했다.

**구현 (`analysisApi.js` `EXTENDED_CATALOG`):**
```javascript
{
  id: 'insightface-genderage', label: 'InsightFace GenderAge (buffalo_l)',
  family: 'age-estimation', series: 'Age Estimation',
  file: 'genderage.onnx', size: 96,
  url: 'https://huggingface.co/JackCui/facefusion/resolve/main/gender_age.onnx', // 실제 URL 재검증 필요
  license: 'InsightFace non-commercial research license',
},
{
  id: 'vit-age-classifier', label: 'ViT Age Classifier (nateraw)',
  family: 'age-estimation', series: 'Age Estimation',
  file: 'vit_age_classifier.onnx', size: 224,
  hfOptimumExport: { repo: 'nateraw/vit-age-classifier' },
  classMap: VIT_AGE_BUCKET_CLASSES,
},
```

`/models/download` 핸들러의 신규 `entry.hfOptimumExport` 분기:
```javascript
} else if (entry.hfOptimumExport) {
  const pyExec = _findPythonWithOptimum();  // import optimum, transformers
  const script = [
    'from optimum.exporters.onnx import main_export',
    `main_export(model_name_or_path=${JSON.stringify(entry.hfOptimumExport.repo)}, output=${JSON.stringify(tmpDir)}, task="image-classification")`,
  ].join('; ');
  // ... execFile, then copy tmpDir/model.onnx → filePath
}
```

**서비스 (`ageEstimationService.js`, `appearanceReidService.js`를 구조 템플릿으로 사용):** `load()/reload()/ready/status` 패턴 동일. `estimateAge(jpegBuffer, bbox, {isFaceCrop})`이 활성 모델 파일명(`genderage.onnx` vs `vit_age_classifier.onnx`)으로 전처리/후처리를 분기 — InsightFace는 96×96 BGR 회귀 출력, ViT는 224×224 RGB ImageNet 정규화 + 9-bucket softmax argmax.

**파이프라인 연동 (`pipelineManager.js`):** 얼굴 bbox 우선(`obj.face?.bbox`), 없으면 person bbox(`obj.bbox`) 폴백. `_getAgeEstimate()`가 objectId별 4초 캐시(`_ageEstimateCache`)로 매 프레임 재추론을 방지 — `_getAppearanceEmbedding()`과 동일 패턴. `tracking.js`의 `Track`에는 `color`/`cloth`/`accessories`와 동일하게 `estimatedAge` 필드 + `updateEstimatedAge()`를 추가했다(주의: 이 필드는 재식별 유사도 스코어러에서 아직 사용되지 않으며, 클라이언트에 실제로 노출되는 값은 `attrObjects`에 매 프레임 부착되는 값이다 — 최초 설계 문서에 "sticky-attribute 목록"이라는 존재하지 않는 개념으로 서술했다가 구현 중 발견하여 정정함, `Design_AI_Age_Estimation.md` §7/§9 참조).

**UI:** `AdminUsersPage.tsx`의 `AiModelsSection()`이 family/series 기준 제네릭 렌더링이므로 `EXTENDED_SERIES_ORDER`/`PROPOSED_SERIES`/`ModelCatalogEntry.family`/`ADMIN_MODULE_GROUPS` 상수 4곳만 갱신 — 별도 컴포넌트 불필요.

**opt-in:** `analyticsConfig.ageEstimation` 기본 `false`. 비활성 시 크롭 추출·추론이 전혀 발생하지 않음.

**회귀 테스트:** `test/api/model_catalog.test.js`(TC-MC-020, family 구성) · `test/api/age_estimation.test.js`(TC-AGE-007~009, `AgeEstimationService` 단위 테스트 — ONNX 세션을 스텁 처리해 실제 모델 파일/서버 불필요, sharp로 합성 JPEG 생성해 크롭 파이프라인까지 검증; TC-AGE-014a, `getAnalysisMetrics()`의 `services.ageEstimation` 진단 필드 — `Object.create(PipelineManager.prototype)`로 생성자 우회, `STORAGE_PATH`를 스크래치 디렉토리로 돌려 `analyticsConfig.getConfig()`가 필요로 하는 DB 싱글톤만 최소 초기화).

**UI 표시·영속화·크로스서버 진단 (2026-07-14, 실사용 갭 발견 후 수정 — 상세는 `Design_AI_Age_Estimation.md` §12 라인 플로우 참고):** `estimatedAge`는 2026-07-12부터 계산되어 실시간 `detections` Socket.IO 이벤트에는 실렸지만, `detectionTracks`/`detectionSnapshots` DB에 저장되지도 클라이언트 어디에도 렌더링되지도 않던 상태였음 — `pipelineManager.js`의 `ctx._trackMeta` 3곳과 `snapshotService.js`의 `attributes`에 추가해 영속화하고, `CameraView.tsx`/`FullscreenCameraView.tsx`/`DetectionsTimelineInline.tsx`/`SearchFullscreen.tsx` 4곳에 표시를 추가해 해결. 이어서 `SERVER_MODE=streaming` 배포에서 원격 analysis 서버가 실제로 모델을 로드했는지 확인할 방법이 없던 2차 갭도 발견 — `getAnalysisMetrics()`(`/api/analysis/metrics`가 실제로 노출하는 함수, `getServiceStatus()`와는 별개)의 `services` 객체에 `ageEstimation` 키가 통째로 누락되어 있었음(`not_started`조차 없이 키 자체가 없음) → 필드 추가로 진단 가능하게 수정.

**실제 근본 원인 (같은 날 라이브 재검증에서 확정, 위 두 수정과 별개):** "streaming 모드는 스프레드 전달이라 필드 유실이 구조적으로 불가능하다"는 최초 진단은 틀렸다. `pipelineManager.js`의 `_processRemoteResult()`에 임시 진단 로그를 추가해 실제 트래픽으로 확인한 결과, 원격에서 온 person 객체가 `objectId,bbox,confidence,state,className,firstSeenAt`뿐이고 `color`/`cloth`/`face`/`estimatedAge`가 전부 없었음(단, `color`/`cloth`는 DB엔 정상 저장 중이었다는 게 결정적 단서). 코드를 직접 읽어보니 `analysisApi.js`의 `POST /frame` 핸들러(streaming이 위임하는 실제 처리 경로)는 `_attrPipeline.enrich()`로 face/color/cloth는 처리하면서 **Age Estimation 호출 자체가 없었다** — `_ageEstimation`은 모델 카탈로그 switch/download/deactivate 엔드포인트에서만 쓰이고 있었다. 즉 `pipelineManager.js`의 로컬 카메라 루프에만 구현되고 HTTP 프레임 위임 경로엔 이식되지 않은 구조적 결함 — 토글·모델로드·연결상태와 무관하게 streaming 배포에서는 100% 안 나오는 상태였다. `analysisApi.js`에 동일 face/body 폴백 + 4초 캐시(모듈-레벨 `_ageEstimateCache`/`AGE_ESTIMATION_INTERVAL_MS`) 로직을 신규 추가해 수정(FR-AGE-033).

**SDLC 참조:** [RFP_AI_Age_Estimation.md](../../../docs/rfp/RFP_AI_Age_Estimation.md) · [PRD_AI_Age_Estimation.md](../../../docs/prd/PRD_AI_Age_Estimation.md) · [SRS_AI_Age_Estimation.md](../../../docs/srs/SRS_AI_Age_Estimation.md) (FR-AGE-001~033) · [Design_AI_Age_Estimation.md](../../../docs/design/Design_AI_Age_Estimation.md) (§12 라인 플로우, §12.1 근본 원인) · [Design_AI_Model_Catalog.md §4.2d/§10](../../../docs/design/Design_AI_Model_Catalog.md) · [TC_AI_Age_Estimation.md](../../../docs/tc/TC_AI_Age_Estimation.md) (TC-AGE-001~015) · [MRD_AI_Age_Estimation.md](../../../docs/mrd/MRD_AI_Age_Estimation.md) · [Age_Estimation_Guide.md](../../../docs/ops/Age_Estimation_Guide.md) (운영 진단 절차)

## 최근 운영 변경 (2026-07-13)

### 16. AI Models — Runtime Model Deactivate (`POST /api/analysis/models/deactivate`)

**배경:** Admin Dashboard의 AI Models 탭에서 각 family는 Activate만 가능했고, 한번 활성화된 모델을 다시 언로드할 방법이 없었다 — 메모리/VRAM을 회수하려면 서버를 재시작해야 했다. YOLO 탐지기를 제외한 8개 확장 family(face-detection/face-recognition/ppe/fire-smoke/cloth-par ×2/human-parsing ×2/appearance-reid/age-estimation)에 대해 "Active → Deactivate" 버튼을 추가했다.

**서비스별 `unload()` 계열 메서드 (기존 `reload()`와 대칭, 세션 release 패턴은 `colorClothService.js`의 `reloadHumanParsing()`이 이미 쓰던 `session.release?.()`를 모든 서비스에 일관 적용):**

```javascript
// faceService.js — SCRFD(face-detection)와 ArcFace(face-recognition)는 독립적으로 언로드
unloadDetector()   { this._scrfd?.release?.();   this._scrfd = null;   this._ready = false; this._status = 'not_started'; }
unloadRecognizer() { this._arcface?.release?.(); this._arcface = null; }  // _ready/_status는 SCRFD 전용이라 건드리지 않음

// protectiveEquipService.js / fireSmokeService.js / appearanceReidService.js / ageEstimationService.js — 동일 패턴
unload() { this._session?.release?.(); this._session = null; this._ready = false; this._status = 'not_started'; }

// colorClothService.js — cloth-par와 human-parsing 별도 언로드
unloadPar()          { this._parSession?.release?.(); this._parSession = null; this._parReady = false; }
unloadHumanParsing() { this._hpSession?.release?.();  this._hpSession = null;  this._hpClassMap = null; this._hpReady = false; this._parseCache.clear(); }
```

`reloadPar()`도 이번에 함께 수정 — 기존에는 새 세션으로 교체하기 전 이전 `_parSession`을 release하지 않는 누수가 있었음(`reloadHumanParsing()`은 이미 release하고 있었음); 대칭을 맞춰 수정.

**API (`analysisApi.js`):** `POST /models/switch` 바로 아래에 `POST /models/deactivate` 라우트 신설 — `entry.family`로 동일한 dispatch 패턴을 사용하되, YOLO 탐지기(`family === undefined`)는 `default` 분기에서 400을 반환(핵심 감지 파이프라인은 항상 활성 모델 필요). `_attrPipeline?._color?.unloadPar()`처럼 optional chaining만 사용 — `/models/switch`와 달리 파일 존재 여부나 `AttributePipeline` 로드 여부를 검사하지 않음(아무것도 활성화되지 않은 상태에서 호출해도 안전한 no-op).

**UI (`AdminUsersPage.tsx`):** `AiModelsSection()`에 `deactivateModel(id)` 함수 추가(`switchModel`과 동일 패턴, `/models/deactivate` POST). 확장 family 테이블(YOLO Detection Model 테이블 제외)에서 `m.active`일 때 기존 정적 "Active" 라벨 대신 **Deactivate** 버튼 렌더링.

**analyticsConfig와의 관계:** Deactivate는 `cloth`/`humanParsing` 등 analytics 토글을 전혀 건드리지 않는다 — 토글은 "이 속성을 원한다"는 의도이고, ready 플래그는 "지금 로드되어 있다"는 사실이라 서로 독립적이다. 모델이 없으면 enrichment가 조용히 `null`/absent를 반환하는 기존 Phase-1 우아한 저하 패턴을 그대로 재사용한다.

**회귀 테스트:** `test/api/model_catalog.test.js` Group E(TC-MC-023) — 각 서비스에 스텁 세션(`{ release: spy }`)을 주입해 실제 ONNX 파일이나 서버 없이 `release()` 호출·상태 초기화를 검증하는 유닛 테스트.

**SDLC 참조:** [Design_AI_Model_Catalog.md §5b](../../../docs/design/Design_AI_Model_Catalog.md#5b-runtime-model-deactivate) · [SRS_AI_Model_Catalog.md §3.6](../../../docs/srs/SRS_AI_Model_Catalog.md) (FR-MC-026~030) · [TC_AI_Model_Catalog.md](../../../docs/tc/TC_AI_Model_Catalog.md) (TC-MC-023~025)

### 17. genderClassificationService.js — 성별 분류 신규 모듈, Age Estimation의 스트리밍 갭을 최초 구현부터 회피 (2026-07-14)

**배경:** `cloth.gender`(PA100k byproduct)와 독립적인 전용 성별 분류 모듈. Age Estimation과 완전히 동일한 구조로 설계하되, Age Estimation이 2026-07-12~07-14에 겪은 사고(§16 이전 섹션들 참고 — `analysisApi.js`의 `POST /frame` 핸들러에 추론 호출이 아예 없었던 구조적 결함)를 **최초 구현부터 피하기 위해 두 진입점(`pipelineManager.js` 로컬 루프 + `analysisApi.js` `/frame` 핸들러)을 동시에 작성**했다.

**모델 카탈로그 (`analysisApi.js`):**

```javascript
{
  id: 'insightface-genderage-gender', label: 'InsightFace GenderAge (buffalo_l)',
  family: 'gender-classification', series: 'Gender Classification',
  file: 'genderage.onnx', size: 96, // Age Estimation의 insightface-genderage와 동일 파일
  url: 'https://huggingface.co/JackCui/facefusion/resolve/main/gender_age.onnx',
  license: 'InsightFace non-commercial research license (acceptable — non-commercial project)',
},
{
  id: 'vit-gender-classifier', label: 'ViT Gender Classifier (rizvandwiki)',
  family: 'gender-classification', series: 'Gender Classification',
  file: 'vit_gender_classifier.onnx', size: 224,
  hfOptimumExport: { repo: 'rizvandwiki/gender-classification-2' }, // 검증된 실존 HF 모델, 99.1% eval accuracy
  license: 'See Hugging Face model card', classMap: VIT_GENDER_CLASSES,
},
```

`vit-gender-classifier`의 `hfOptimumExport` 변환은 **새 로직이 아니라** Age Estimation의 ViT Age Classifier가 이미 검증한 제네릭 `/models/download` 분기(family를 구분하지 않음, `task="image-classification"`)를 그대로 재사용한다.

**서비스 (`genderClassificationService.js`, `ageEstimationService.js`를 구조 템플릿으로 사용):** `load()/reload()/unload()/ready/status` 패턴 동일. `classifyGender(jpegBuffer, bbox, {isFaceCrop})`이 활성 모델 파일명(`genderage.onnx` vs `vit_gender_classifier.onnx`)으로 전처리/후처리를 분기 — 두 변형 모두 2-class softmax(`{value:'male'|'female', confidence}`), Age Estimation의 회귀/버킷 분기보다 단순함. InsightFace 변형은 `output[0:2]`(gender 채널)를 argmax — `output[2]`(age 채널, Age Estimation이 사용)는 이 서비스에서 읽지 않는다. **중요:** `insightface-genderage-gender`는 Age Estimation의 `insightface-genderage`와 **동일한 `genderage.onnx` 파일**을 가리키지만, 두 서비스는 세션을 공유하지 않고 각자 독립적으로 로드한다(의도된 설계 — 서비스 간 결합도 최소화).

**두 진입점 동시 구현 (핵심 설계 결정):**
1. `pipelineManager.js` 로컬 카메라 루프 — Age Estimation 블록 바로 뒤에 동일 패턴(`this._genderClassifyCache`, `GENDER_CLASSIFICATION_INTERVAL_MS=4000`)으로 추가.
2. `analysisApi.js`의 `POST /frame` 핸들러 — `_attrPipeline.enrich()` 호출 직후, Age Estimation 블록 바로 뒤에 **모듈-레벨** 캐시(`_genderClassifyCache` Map, `analysisApi.js`는 클래스 인스턴스가 아니므로 `this.*` 대신 모듈 스코프)로 동일 로직 추가.

두 곳 모두 `o.face?.bbox || o.bbox` face-우선/body-폴백 패턴, 4초 캐시, `estimatedGender` 필드명 통일.

**영속화:** `pipelineManager.js`의 `ctx._trackMeta` 전 지점(신규/기존 트랙, 3개 flush 분기) + `snapshotService.js`의 `attributes`에 `estimatedGender` 추가 — `detectionTracks`/`detectionSnapshots` 양쪽 영속화. `tracking.js`의 `Track`에 `estimatedGender` 필드 + `updateEstimatedGender()` 메서드(`updateEstimatedAge()`와 동일 패턴).

**진단 필드:** `pipelineManager.js`의 `getServiceStatus()`/`getAnalysisMetrics()` **및** `analysisApi.js`의 독립 `/metrics` 폴백 응답(pipelineManager 미등록 시) 양쪽의 `services` 객체에 `genderClassification` 키 추가 — Age Estimation은 전자만 먼저 고쳐졌었으나(2026-07-14), 이번엔 두 응답 형태를 동시에 반영.

**UI:** `AdminUsersPage.tsx`의 `AiModelsSection()`이 family/series 기준 제네릭 렌더링이므로 `EXTENDED_SERIES_ORDER`/`PROPOSED_SERIES`/`ModelCatalogEntry.family`/`ADMIN_MODULE_GROUPS` 상수 4곳만 갱신. 클라이언트 4곳(`CameraView.tsx` 캔버스 오버레이·fuchsia색, `FullscreenCameraView.tsx` DetectionRow, `DetectionsTimelineInline.tsx` 상세 패널, `SearchFullscreen.tsx` 검색 결과)에 표시 — `cloth.gender`(PAR)와 라벨로 구분("Gender (PAR)" vs "Gender (Est.)"/"Gender Classification").

**opt-in:** `analyticsConfig.genderClassification` 기본 `false`. 비활성 시 크롭 추출·추론이 전혀 발생하지 않음.

**회귀 테스트:** `test/api/model_catalog.test.js`(TC-GEN-001, family 구성) · `test/api/gender_classification.test.js`(TC-GEN-007~009, `GenderClassificationService` 단위 테스트; TC-GEN-014a, `getAnalysisMetrics()`의 `services.genderClassification` 진단 필드 — `age_estimation.test.js`의 Group E와 동일한 `Object.create(PipelineManager.prototype)` + `STORAGE_PATH` 스크래치 디렉토리 패턴 재사용).

**SDLC 참조:** [RFP_AI_Gender_Classification.md](../../../docs/rfp/RFP_AI_Gender_Classification.md) · [PRD_AI_Gender_Classification.md](../../../docs/prd/PRD_AI_Gender_Classification.md) · [SRS_AI_Gender_Classification.md](../../../docs/srs/SRS_AI_Gender_Classification.md) (FR-GEN-001~033) · [Design_AI_Gender_Classification.md](../../../docs/design/Design_AI_Gender_Classification.md) (§12 라인 플로우) · [TC_AI_Gender_Classification.md](../../../docs/tc/TC_AI_Gender_Classification.md) (TC-GEN-001~015, TC-GEN-015가 Age Estimation 사고 재발 방지 회귀 가드) · [MRD_AI_Gender_Classification.md](../../../docs/mrd/MRD_AI_Gender_Classification.md) · [Gender_Classification_Guide.md](../../../docs/ops/Gender_Classification_Guide.md)

### 18. activeModelConfig.js — AI Models Active 선택 서버 재시작 영속화 (2026-07-14)

**배경:** Admin Dashboard → AI Models 탭에서 Activate/Deactivate한 모델(예: Cloth Attribute → OpenPAR, Human Parsing → SegFormer B2 Clothes, Age Estimation → ViT Age Classifier, Gender Classification → ViT Gender Classifier, YOLO Detection Model → YOLO12n)이 서버 재시작 시 전부 초기화되던 문제. 원인은 `analysisApi.js`의 `_loadServices()`가 매번 인자 없이 `new DetectionService()`/`new AttributePipeline()`/... 를 호출해 각 서비스가 자신의 하드코딩된(또는 `YOLO_MODEL` env) 기본 모델을 다시 로드했기 때문 — "Active"는 순수 인메모리 상태였고 어디에도 저장되지 않았다.

**저장소:** 신규 `server/src/services/activeModelConfig.js` — `trackerConfig.js`/`analyticsConfig.js`와 동일하게 `settings` 테이블(row id `activeModels`)을 사용, `DB_TYPE`(json/mongodb) 불문 동일 API. **새 테이블/컬렉션·`ALL_TABLES` 변경 불필요** — `settings`는 이미 범용 key-value 저장소였다. Row는 `{ id: 'activeModels', [family]: modelId|null }` — YOLO 탐지기(`family === undefined`)는 고정 키 `DETECTOR_FAMILY_KEY`(`'yolo-detector'`)로 저장. `modelId`는 "이 모델로 복원", `null`은 "명시적으로 Deactivate됨(재시작 시 자동 로드 금지)", 키 자체가 없으면 "한 번도 설정된 적 없음(기존 하드코딩 기본값 유지)" — 세 상태를 구분한다.

```javascript
// server/src/services/activeModelConfig.js
getActiveModels()                 // → { [family]: modelId|null, ... }
setActiveModel(family, modelId)   // POST /models/switch 성공 시 호출
clearActiveModel(family)          // POST /models/deactivate 성공 시 호출 — null 기록(키 삭제 아님)
```

**리팩터링 (`analysisApi.js`):** `/models/switch`·`/models/deactivate`에 인라인되어 있던 family별 `switch (entry.family) {...}` 로직을 각각 `_applyModelSwitch(entry, filePath)`(async)·`_applyModelDeactivate(entry)`(sync) 공용 함수로 추출 — 실패 시 `ModelSwitchError(status, message)`를 throw해 기존 HTTP 상태 코드(409 `AttributePipeline not loaded`, 400 `YOLO 탐지기 Deactivate 불가`)를 그대로 보존. 각 라우트 핸들러는 이제 (1) 공용 함수 호출 (2) **성공했을 때만** `activeModelConfig.setActiveModel()`/`clearActiveModel()` 호출 (3) 응답 순서로 동작 — 실패한 요청은 절대 영속화되지 않는다.

**시작 시 복원:** `_loadServices()`가 모든 family를 기존 하드코딩 기본값으로 로드 완료한 **직후**, 신규 `_restoreActiveModels()`가 `activeModelConfig.getActiveModels()`를 읽어 재생한다 — `modelId`면 `_applyModelSwitch()`(라이브 switch와 완전히 동일한 코드 경로, human-parsing의 `classMap`/`inputSize`·PromptPAR 메모리 게이트 포함), `null`이면 `_applyModelDeactivate()`(YOLO 탐지기는 항상 예외로 스킵)를 호출한다. 카탈로그에서 사라진 modelId나 디스크에서 삭제된 파일은 경고 로그만 남기고 스킵 — 복원 실패가 서버 기동을 막지 않는다.

**제네릭 설계 — family 신규 추가 시 영속화 자체는 무료:** 복원 루프가 `entry.family` + 이미 존재하는 `ALL_MODELS`/`_applyModelSwitch`/`_applyModelDeactivate`만으로 동작하므로, 새 AI model family를 추가할 때 필요한 건 기존과 동일하게 `EXTENDED_CATALOG` 항목 + switch/deactivate 케이스 한 줄씩뿐 — 영속화를 위한 추가 코드는 전혀 필요 없다.

**범위 제한:** `analysisApi.js`의 공유 서비스 인스턴스(`SERVER_MODE=analysis`/`combined`가 `POST /api/analysis/frame` 처리에 사용)만 대상. `pipelineManager.js`가 `combined` 모드 로컬 카메라 추론에 쓰는 별도 서비스 인스턴스는 원래부터 `/models/switch`의 영향을 받지 않던 기존 갭이라 이번에도 대상 밖(문서에 명시, 코드 변경 없음) — 보고된 시나리오(`SERVER_MODE=analysis`, 로컬 카메라 없음)에는 영향 없음.

**회귀 테스트:** `test/api/model_catalog.test.js` Group F(TC-MC-026/027) — `DB_TYPE=json` + 스크래치 `STORAGE_PATH`로 격리된 DB에 대해 `activeModelConfig.js`를 직접 호출해 switch/deactivate/미설정 3가지 상태가 `settings` 테이블 raw JSON에 정확히 반영되는지 검증(실제 서버·ONNX 파일 불필요).

**SDLC 참조:** [MRD_AI_Model_Active_Persistence.md](../../../docs/mrd/MRD_AI_Model_Active_Persistence.md) · [RFP_AI_Model_Catalog.md](../../../docs/rfp/RFP_AI_Model_Catalog.md) (FR-RFP-MC-015) · [PRD_AI_Model_Catalog.md](../../../docs/prd/PRD_AI_Model_Catalog.md) (§4.6, AC-12) · [SRS_AI_Model_Catalog.md](../../../docs/srs/SRS_AI_Model_Catalog.md) (§3.7 FR-MC-031~035) · [Design_AI_Model_Catalog.md §11](../../../docs/design/Design_AI_Model_Catalog.md#11-active-model-persistence-server-restart-survival) · [TC_AI_Model_Catalog.md](../../../docs/tc/TC_AI_Model_Catalog.md) (TC-MC-026~030) · [Distributed_AI_Pipeline_Setup.md §1.4](../../../docs/ops/Distributed_AI_Pipeline_Setup.md)
