# RFP AI-09: Fire & Smoke Detection (화재/연기 감지)

**문서 ID**: LTS-2026-AI-09  
**버전**: 1.1  
**작성일**: 2026-05-15  
**수정일**: 2026-05-18  
**상태**: ✅ 구현 완료 (yolov8s_fire_smoke.onnx 설치됨)

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
모델: YOLOv8s (small) — 3-class fine-tuned
출처: github.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection
      (runs/detect/train/weights/best.pt → ONNX export)
파일: server/models/yolov8s_fire_smoke.onnx  (43MB)
출력: [1, 7, 8400]  (4 bbox coords + 3 class scores × 8400 anchors)
클래스: Fire=0, default=1 (무시), smoke=2
```

### 3.2 후처리 파이프라인

```
JPEG Buffer
    │
    ▼ sharp 전처리
  640×640 letterbox (fill=gray114, normalize /255)
    │
    ▼ ONNX 추론
  [1, 7, 8400] raw output
    │
    ▼ 후처리
  confidence filtering (>0.35)
  'default' 클래스 제거 (classIdx=1 skip)
  소문자 정규화 ('Fire' → 'fire')
  NMS (IoU>0.45)
    │
    ▼
  [{className:'fire'|'smoke', confidence, bbox(frame coords)}]
```

### 3.3 클래스 정의

| Index | 원본 클래스명 | 내부 매핑 | 설명 | 표시 색상 |
|:---:|---|---|---|---|
| 0 | `Fire` | `fire` | 화염 (불꽃, 화재) | 🔴 주황-빨간 `rgba(255,80,0)` |
| 1 | `default` | *(skip)* | 미분류 — 후처리에서 제외 | — |
| 2 | `smoke` | `smoke` | 연기 (회색, 흑색 연기) | ⬜ 어두운 회색 `rgba(75,85,99)` |

---

## 4. 공개 모델 소스

### 4.1 사용 모델 (현재 설치 기준)

| 순위 | 모델 | 소스 | ONNX 크기 | 클래스 | 비고 |
|:---:|---|---|---|---|---|
| ✅ **채택** | YOLOv8s fire/smoke | Abonia1/YOLOv8-Fire-and-Smoke-Detection (GitHub) | 43MB | Fire, default, smoke | **현재 설치됨** |
| — | YOLOv8m fire/smoke | keremberke/yolov8m-fire-and-smoke-detection (HuggingFace) | ~52MB | fire, smoke | 저장소 비공개로 다운로드 불가 |
| — | YOLOv10 fire/smoke | TommyNgx/YOLOv10-Fire-and-Smoke-Detection (HuggingFace) | ~30MB | fire, smoke | 대안 후보 |

> **비고**: `keremberke` HuggingFace 저장소가 비공개(401 Unauthorized)로 전환됨. `Abonia1` GitHub 저장소의 학습 완료 가중치(`runs/detect/train/weights/best.pt`)를 ONNX 변환하여 적용.

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

### 5.4 모델 설치 절차 (완료)

현재 `server/models/yolov8s_fire_smoke.onnx` (43MB)가 설치되어 있습니다.

재설치가 필요한 경우 아래 스크립트를 실행합니다 (Python 3.7+, ultralytics 필요):

```bash
# 1. GitHub에서 학습 완료 가중치 다운로드
wget --no-check-certificate \
  "https://raw.githubusercontent.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection/main/runs/detect/train/weights/best.pt" \
  -O /tmp/fire_smoke_best.pt

# 2. ONNX 변환 (Python 3.7 + ultralytics 8.x)
python3 << 'PYEOF'
from ultralytics import YOLO
import shutil

model = YOLO('/tmp/fire_smoke_best.pt')
# 클래스: {0: 'Fire', 1: 'default', 2: 'smoke'}
exported = model.export(format='onnx', imgsz=640, simplify=True)
shutil.copy(exported, 'server/models/yolov8s_fire_smoke.onnx')
print("Saved: server/models/yolov8s_fire_smoke.onnx")
PYEOF
```

> **주의**: 모델 출력이 `[1, 7, 8400]` (3-class)이므로 `fireSmokeService.js`의 `CLASS_NAMES = ['fire', 'default', 'smoke']`와 `SKIP_CLASSES`가 맞춰져 있어야 합니다.

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
| 모델 크기 | YOLOv8s 43MB (ONNX 설치 완료) |
| 알림 쿨다운 | 동일 Zone 동일 클래스 경보는 10초 간격으로 제한 (중복 방지) |
| default 클래스 스킵 | 후처리에서 classIdx=1 제외 — 불필요한 감지 억제 |

---

## 8. 구현 이력

| 날짜 | 내용 |
|---|---|
| 2026-05-18 | `fireSmokeService.js` 구현 완료 |
| 2026-05-18 | `yolov8s_fire_smoke.onnx` (43MB) 설치 — Abonia1/GitHub |
| 2026-05-18 | 3-class 모델 대응: `CLASS_NAMES`, `SKIP_CLASSES`, `NORMALISE` 추가 |
| 2026-05-18 | 서버 재시작 후 `[FireSmokeService] yolov8s_fire_smoke.onnx loaded` 확인 |

## 9. 테스트 계획

| 테스트 | 방법 | 합격 기준 | 상태 |
|---|---|---|:---:|
| 모델 로드 | 서버 시작 로그 확인 | `loaded` 메시지 출력 | ✅ |
| 기능 | 화재 영상 재생 → fire:alert 발생 확인 | 10초 내 경보 | 🔲 |
| 정밀도 | D-Fire test set 추론 | mAP@0.5 ≥ 0.80 | 🔲 |
| 성능 | CPU 단독 640×640 추론 속도 | ≥ 10 FPS | 🔲 |
| 오탐 | 일반 실내/외 영상 24시간 | FPR ≤ 5% | 🔲 |
| 통합 | 로이터링 감지와 동시 동작 | 파이프라인 지연 ≤ 50ms | 🔲 |

---

## 9. 관련 문서

- [README.md — 7.1 Available AI Modules](README.md#71-available-ai-modules-per-zone)
- [RFP_AI_Human_Detection.md](RFP_AI_Human_Detection.md) — AI-01
- [RFP_AI_Vehicle_Detection.md](RFP_AI_Vehicle_Detection.md) — AI-02
- [server/src/services/fireSmokeService.js](server/src/services/fireSmokeService.js)
- [server/src/services/pipelineManager.js](server/src/services/pipelineManager.js)

---

*이 문서는 LTS(Loitering Tracking System) AI 모듈 RFP 시리즈의 일부입니다.*
