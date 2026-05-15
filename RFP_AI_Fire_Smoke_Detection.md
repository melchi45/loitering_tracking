# RFP AI-09: Fire & Smoke Detection (화재/연기 감지)

**문서 ID**: LTS-2026-AI-09  
**버전**: 1.0  
**작성일**: 2026-05-15  
**상태**: 🔲 준비중 (모델 다운로드 필요)

---

## 1. 개요 (Overview)

### 1.1 목적

CCTV 영상에서 실시간으로 화재(Fire) 및 연기(Smoke)를 감지하여 조기 경보를 발령하는 AI 모듈. 기존 로이터링 감지 시스템(LTS)에 안전 이벤트 탐지 기능을 추가한다.

### 1.2 적용 시나리오

| 구분 | 시나리오 | 우선순위 |
|---|---|:---:|
| 건물 내부 | 서버실, 창고, 공장 라인 화재 조기 감지 | ★★★ |
| 야외 | 주차장, 야적장, 물류센터 화재 감지 | ★★★ |
| 산림 인접 | 산불 초기 연기 감지 | ★★ |
| 주방/조리시설 | 조리 연기와 화재 연기 구분 | ★★ |

### 1.3 기대 효과

- 화재 발생 후 **30초 이내** 조기 탐지 (기존 스프링클러 비교 5분 이상 단축)
- 야간/저조도 환경에서도 화염 빛 특성 기반 감지
- 기존 CCTV 인프라 재활용 (추가 센서 불필요)

---

## 2. 기술 요구사항

### 2.1 기능 요구사항

| ID | 요구사항 | 수준 |
|---|---|---|
| FS-01 | YOLOv8 기반 실시간 화재(fire) / 연기(smoke) bbox 탐지 | 필수 |
| FS-02 | Zone 설정으로 감시 영역 제한 | 필수 |
| FS-03 | 감지 즉시 `fire:alert` Socket.IO 이벤트 발생 | 필수 |
| FS-04 | 감지 신뢰도(confidence) 임계값 설정 가능 | 필수 |
| FS-05 | 화재/연기 bbox를 카메라 뷰 오버레이에 표시 | 필수 |
| FS-06 | 좌측 Detection 패널에 fire/smoke 탐지 항목 표시 | 필수 |
| FS-07 | 야간/저조도 조건에서도 동작 | 권장 |
| FS-08 | 연기(smoke)와 수증기(steam) 구분 | 권장 |

### 2.2 성능 요구사항

| 지표 | 목표값 | 비고 |
|---|---|---|
| mAP@0.5 | ≥ 0.80 | D-Fire 기준 |
| 처리 속도 | ≥ 10 FPS (CPU) | 640×640 입력 |
| 탐지 지연 | ≤ 200ms | JPEG 수신→이벤트 발생 |
| 오탐 (FPR) | ≤ 5% | 조명 변화·태양광 제외 |
| 화재 크기 | bbox ≥ 32×32px | 화재 초기 단계 포함 |

### 2.3 비기능 요구사항

- 모델 포맷: ONNX (onnxruntime-node CPU/CUDA 호환)
- 모델 크기: ≤ 100MB (서버 부담 최소화)
- 서버 영향: 기존 파이프라인 추가 지연 ≤ 50ms
- 기존 로이터링 감지와 독립적으로 동작

---

## 3. 모델 아키텍처

### 3.1 채택 모델: YOLOv8s Fire & Smoke Detection

```
입력: JPEG 프레임 (640×640 letter-box 전처리)
모델: YOLOv8s (small) — fire/smoke 2-class fine-tuned
출력: [1, 6, 8400]  (4 bbox coords + 2 class scores × 8400 anchors)
클래스: fire=0, smoke=1
```

### 3.2 후처리 파이프라인

```
JPEG Buffer
    │
    ▼ sharp 전처리
  640×640 letterbox (fill=gray114, normalize /255)
    │
    ▼ ONNX 추론
  [1, 6, 8400] raw output
    │
    ▼ 후처리
  confidence filtering (>0.35)
  NMS (IoU>0.45)
    │
    ▼
  [{className, confidence, bbox(frame coords)}]
```

### 3.3 클래스 정의

| Index | 클래스 | 설명 | 표시 색상 |
|:---:|---|---|---|
| 0 | `fire` | 화염 (불꽃, 화재) | 🔴 주황-빨간 `rgba(255,80,0)` |
| 1 | `smoke` | 연기 (회색, 흑색 연기) | ⬜ 어두운 회색 `rgba(75,85,99)` |

---

## 4. 공개 모델 소스

### 4.1 즉시 사용 가능한 모델 (추천 순서)

| 순위 | 모델 | 소스 | 크기 | 클래스 | 비고 |
|:---:|---|---|---|---|---|
| 1 | YOLOv8m fire/smoke | keremberke/yolov8m-fire-and-smoke-detection (HuggingFace) | ~52MB | fire, smoke | **추천** |
| 2 | YOLOv8n fire/smoke | Abonia1/YOLOv8-Fire-and-Smoke-Detection (GitHub) | ~6MB | fire, smoke | 경량 |
| 3 | YOLOv10 fire/smoke | TommyNgx/YOLOv10-Fire-and-Smoke-Detection (HuggingFace) | ~30MB | fire, smoke | YOLOv10 기반 |

### 4.2 학습 데이터셋

| 데이터셋 | 규모 | 링크 |
|---|---|---|
| D-Fire | 21,000+ 이미지 (fire/smoke/no-event) | GitHub: gaiasd/DFireDataset |
| VisiFire | 복합 실내외 화재 영상 | VisiFire.net |
| Foggia et al. | 야외/실내 화재 영상 | 학술 데이터셋 |

---

## 5. 구현 계획

### 5.1 서버 — FireSmokeService

**파일**: `server/src/services/fireSmokeService.js`

```javascript
// 핵심 인터페이스
class FireSmokeService {
  async load()                         // 모델 로드 (파일 없으면 graceful skip)
  get ready()                          // → boolean
  async detect(jpegBuf, origW, origH)  // → [{className, confidence, bbox}]
}
```

**파이프라인 통합 위치** (`pipelineManager.js`):
```
1. JPEG 프레임 수신
2. Primary Detection (YOLOv8n COCO — person/vehicle)
3. ByteTracker → tracked objects
4. BehaviorEngine → loitering analysis
5. AttributePipeline → face/mask/hat/color enrichment
6. ▶ FireSmokeService.detect() ← 여기 추가 (full-frame, 독립 실행)
7. 결과 병합 → fire/smoke bbox를 detections 배열에 추가
8. Zone 교차 확인 → fire:alert 이벤트 발생
9. detections 소켓 emit
```

### 5.2 화재 경보 이벤트

```javascript
// Socket.IO 이벤트: 'fire:alert'
{
  cameraId:   "uuid",
  className:  "fire" | "smoke",
  confidence: 0.87,
  zone:       "Zone A",
  timestamp:  1715000000000
}
```

### 5.3 클라이언트

- **Zone Editor**: fire / smoke 체크박스 추가 (모델 존재 시 활성화)
- **CameraView 오버레이**: fire=주황-빨간 bbox, smoke=회색 bbox + 배경 오버레이
- **FullscreenView DetectionPanel**: fire/smoke 항목 적색/회색 강조
- **범례**: ■ fire (주황), ■ smoke (회색) 추가

### 5.4 모델 다운로드 스크립트

```bash
# Python export (ultralytics 필요)
python3 << 'PYEOF'
from ultralytics import YOLO
from huggingface_hub import hf_hub_download
import shutil, os

pt = hf_hub_download(
    repo_id="keremberke/yolov8m-fire-and-smoke-detection",
    filename="best.pt")
YOLO(pt).export(format="onnx", imgsz=640, simplify=True)
onnx = pt.replace(".pt", ".onnx")
dest = os.path.join("server/models", "yolov8s_fire_smoke.onnx")
shutil.copy(onnx, dest)
print("Saved:", dest)
PYEOF
```

---

## 6. 엔드포인트 및 이벤트

### 6.1 기존 엔드포인트 변경

| 엔드포인트 | 변경 내용 |
|---|---|
| `GET /api/capabilities` | `ai.fire`, `ai.smoke` 필드 추가 |
| `GET /health` | 변경 없음 |

### 6.2 새 Socket.IO 이벤트

| 이벤트 | 방향 | 페이로드 |
|---|---|---|
| `fire:alert` | Server→Client | `{cameraId, className, confidence, zone, timestamp}` |

---

## 7. 성능 최적화

| 최적화 | 방법 |
|---|---|
| 프레임 스킵 | 기존 `_inferring` guard와 동일한 frame-drop 처리 |
| Zone 필터링 | `targetClasses`에 fire/smoke 없으면 탐지 건너뜀 |
| 모델 크기 | YOLOv8s(~52MB) 기본, YOLOv8n(~6MB) 경량 옵션 |
| 알림 쿨다운 | 동일 Zone 동일 클래스 경보는 10초 간격으로 제한 (중복 방지) |

---

## 8. 테스트 계획

| 테스트 | 방법 | 합격 기준 |
|---|---|---|
| 기능 | 화재 영상 재생 → fire:alert 발생 확인 | 10초 내 경보 |
| 정밀도 | D-Fire test set 추론 | mAP@0.5 ≥ 0.80 |
| 성능 | CPU 단독 640×640 추론 속도 | ≥ 10 FPS |
| 오탐 | 일반 실내/외 영상 24시간 | FPR ≤ 5% |
| 통합 | 로이터링 감지와 동시 동작 | 파이프라인 지연 ≤ 50ms |

---

## 9. 관련 문서

- [README.md — 7.1 Available AI Modules](README.md#71-available-ai-modules-per-zone)
- [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) — AI-01
- [RFP_AI_Vehicle_Detection.md](RFP_AI_Vehicle_Detection.md) — AI-02
- [server/src/services/fireSmokeService.js](server/src/services/fireSmokeService.js)
- [server/src/services/pipelineManager.js](server/src/services/pipelineManager.js)

---

*이 문서는 LTS(Loitering Tracking System) AI 모듈 RFP 시리즈의 일부입니다.*
