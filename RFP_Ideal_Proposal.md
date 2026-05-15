# Adaptive Multi-Feature Loitering Detection System

## 개요

본 문서는 RTSP 기반 영상 스트림에서 사람의 배회(loitering) 행동을 탐지하기 위한 AI 기반 Adaptive Multi-Feature Tracking 시스템의 구현 방향 및 RFP(Request For Proposal)를 정의한다.

기존 Kalman Filter 기반 tracking 시스템의 한계를 개선하기 위해:

- Human Detection
- Human Segmentation
- Appearance ReID
- Cloth / Accessory Detection
- Adaptive Kalman Filtering

을 결합한 구조를 사용한다.

---

# 기존 Kalman Filter 기반 Loitering Detection의 문제점

기존 구조:

```text
위치 기반 추적
→ 일정 시간 체류
→ Loitering 판단
```

문제점:

- Detection 흔들림
- Tracking ID 변경
- Occlusion 발생
- 재등장 시 다른 사람으로 인식
- 느린 움직임에서 오탐 증가
- 고정 Kalman parameter의 한계

즉:

- 너무 예민하거나
- 너무 둔감한

문제가 발생한다.

---

# 개선 방향

## 핵심 아이디어

단순 위치 추적이 아닌:

```text
위치 + 외형 + 행동 + 시간
```

을 함께 사용하는 것이다.

---

# 전체 시스템 구조

```text
RTSP Input
   ↓
Frame Capture
   ↓
Human Detection
   ↓
Human Segmentation
   ↓
Appearance Feature Extraction
   ↓
Accessory / Cloth Detection
   ↓
Kalman Motion Tracking
   ↓
ReID Association
   ↓
Behavior Analysis
   ↓
Loitering Detection
   ↓
Alert / Event API
```

---

# 1. Human Detection

## 목적

영상에서 사람을 검출한다.

## 권장 모델

- YOLOv11
- RT-DETR
- YOLO-NAS

## 출력 예시

```json
{
  "bbox": [x1, y1, x2, y2],
  "confidence": 0.95
}
```

---

# 2. Human Segmentation

## 목적

Bounding box 내부에서 실제 사람 영역을 분리한다.

## 장점

- 배경 제거
- 의복 분리
- Accessory 분석 가능
- Partial Occlusion 대응

## 권장 모델

- YOLO-Seg
- Segment Anything Model (SAM)
- Mask2Former

## 출력

```text
person mask
```

---

# 3. Appearance Feature Extraction

## 목적

사람의 외형 특징을 embedding vector로 변환한다.

## 추출 항목

- 상의 색상
- 하의 색상
- 패턴
- 체형
- 가방
- 모자
- 액세서리

## 예시

```text
person_embedding[512]
```

---

# 4. Semantic Attribute Detection

## 목적

외형 정보를 semantic metadata로 저장한다.

## 예시

```json
{
  "upper_color": "red",
  "lower_color": "black",
  "bag": true,
  "hat": false
}
```

## 장점

- Explainability 증가
- ReID 정확도 향상
- 조명 변화 대응

---

# 5. Kalman Motion Tracking

## 목적

사람의 이동 상태를 예측한다.

## 상태 벡터

```text
[x, y, w, h, vx, vy]
```

## 기능

- 위치 예측
- Detection 누락 보정
- 이동 smoothing
- ID continuity 유지

---

# 6. Adaptive Kalman Filter

## 문제

고정 noise parameter 사용 시:

- 빠른 움직임에서 tracking loss
- 정지 상태에서 과도한 민감도
- Occlusion 상황에서 오류

발생 가능

---

# 개선 방법

## Motion 기반 동적 조정

- 급가속 → process noise 증가
- 정지 → process noise 감소

---

## Appearance Confidence 기반 조정

Appearance matching confidence가 낮을 경우:

- covariance 증가
- uncertainty 증가

---

## Occlusion 기반 조정

가려짐 발생 시:

- prediction weight 증가
- measurement weight 감소

---

# 7. Multi-Cue Association

## 목적

Tracking ID를 안정적으로 유지한다.

## 기존 방식

```text
IOU 기반 매칭
```

## 개선 방식

```text
Motion Similarity
+
Appearance Similarity
+
Cloth Similarity
+
Mask Similarity
+
Temporal Consistency
```

## 예시

```text
Score =
0.4 × IOU
+
0.4 × Appearance
+
0.2 × Attribute
```

---

# 8. Loitering Detection

## 목적

특정 영역에서 장시간 체류하거나 반복 방문하는 행동을 탐지한다.

---

# 권장 판단 요소

## Zone Dwell Time

특정 영역 체류 시간

---

## Revisit Count

동일 영역 반복 방문 횟수

---

## Low Velocity Pattern

낮은 이동 속도 유지

---

## Circular Motion Pattern

반복 이동 경로 탐지

---

# 상태 저장 예시

```json
{
  "track_id": 101,
  "timestamp": 171000000,
  "bbox": [x1,y1,x2,y2],
  "embedding": [],
  "cloth_color": "black",
  "bag": true,
  "zone": "A",
  "dwell_time": 122
}
```

---

# 추천 기술 스택

## Detection

- Ultralytics YOLO
- RT-DETR

---

## Segmentation

- SAM
- Mask2Former

---

# Tracking

- DeepSORT
- ByteTrack
- OC-SORT

---

# ReID

- FastReID
- TorchReID

---

# Backend

- Node.js
- Python AI Worker

---

# Streaming

- FFmpeg
- GStreamer

---

# Database

- PostgreSQL
- Redis
- Milvus / Qdrant

---

# 권장 구현 단계

# 1단계

```text
YOLO + DeepSORT
```

기본 tracking 구현

---

# 2단계

Appearance embedding 추가

---

# 3단계

Cloth / accessory detection 추가

---

# 4단계

Adaptive Kalman 적용

---

# 5단계

Behavior analysis 및 loitering logic 추가

---

# 성능 목표

| 항목 | 목표 |
|---|---|
| Detection FPS | 15~30 FPS |
| Tracking Accuracy | MOTA > 0.75 |
| ReID Accuracy | >85% |
| False Alarm | <10% |
| Multi-Person Tracking | 지원 |

---

# RFP (Request For Proposal)

## 프로젝트명

AI 기반 Adaptive Multi-Feature Loitering Detection System

---

# 프로젝트 목적

실시간 RTSP 영상 기반에서:

- 사람 검출
- 다중 객체 추적
- Appearance ReID
- Adaptive Kalman Filtering

을 이용하여:

- 배회자
- 장시간 체류자
- 반복 방문 패턴

을 탐지하는 시스템 구축

---

# 주요 요구사항

## 입력

- RTSP Stream
- H264/H265 지원
- Multi-channel 지원

---

# 기능 요구사항

## Human Detection

- 실시간 detection
- 다중 인원 지원
- 최소 15 FPS 이상

---

## Segmentation

- person mask 생성
- partial occlusion 대응

---

## Tracking

- Tracking ID 유지
- ID switch 최소화
- Kalman prediction 적용

---

## Appearance ReID

지원 항목:

- upper/lower clothes
- cloth color
- backpack
- hat
- accessory

---

## Adaptive Kalman

동적 parameter 조정:

- motion variance
- occlusion
- appearance confidence

기반 adaptive covariance 적용

---

## Loitering Detection

복합 조건 기반 판단:

- dwell time
- revisit count
- low velocity
- repetitive motion

---

# 이벤트 출력 예시

```json
{
  "event": "loitering",
  "track_id": 15,
  "zone": "A1",
  "dwell_time": 240,
  "risk_score": 0.84
}
```

---

# 추가 권장 기능

## Heatmap

배회 hotspot 시각화

---

## Cross-Camera ReID

카메라 간 동일 인물 추적

---

## Suspicious Score

행동 위험도 점수화

---

# 결론

본 시스템은 단순 Kalman 기반 위치 추적을 넘어:

```text
Motion + Appearance + Behavior
```

를 결합한 Adaptive Intelligent Tracking 구조를 목표로 한다.

이를 통해:

- Tracking 안정성 향상
- ReID 정확도 증가
- False Alarm 감소
- 실제 환경 대응력 강화

를 달성할 수 있다.
