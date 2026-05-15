# RFP: Detection Visualization & Display Module

**문서번호**: LTS-2026-003  
**버전**: 1.0  
**작성일**: 2026-05-15  
**분류**: 기술 요구사항 명세서 (RFP)

---

## 1. 개요

### 1.1 목적

본 문서는 Loitering Detection & Tracking System(LTS)의 **탐지 시각화 및 표시 모듈**에 대한 기술 요구사항을 정의한다. 영상 스트림에서 탐지된 객체 정보를 실시간으로 시각화하는 캔버스 오버레이, 탐지 목록 패널, 범례(Legend) 표시 등 사용자 인터페이스 전반을 포함한다.

### 1.2 적용 범위

- 카메라 뷰 캔버스 오버레이 (BBox, 레이블, 속성 배지)
- 전체화면 뷰 탐지 패널 (왼쪽 사이드 패널)
- 탐지 범례 (색상 코드 기준표)
- Socket.IO 실시간 데이터 수신 및 렌더링

---

## 2. 탐지 클래스 및 색상 코드 표준

### 2.1 인물 / 차량 클래스

| 클래스 | 색상 | HEX | Canvas RGBA | 설명 |
|--------|------|-----|-------------|------|
| person | 초록 | `#22c55e` | `rgba(34,197,94,0.9)` | 일반 인물 |
| bicycle | 노랑 | `#facc15` | `rgba(250,204,21,0.9)` | 자전거 |
| car | 파랑 | `#3b82f6` | `rgba(59,130,246,0.9)` | 승용차 |
| motorcycle | 주황 | `#f97316` | `rgba(249,115,22,0.9)` | 오토바이 |
| bus | 보라 | `#a855f7` | `rgba(168,85,247,0.9)` | 버스 |
| truck | 청록 | `#14b8a6` | `rgba(20,184,166,0.9)` | 트럭 |

### 2.2 소지품 / 액세서리 클래스 (YOLOv8n COCO)

| 클래스 | COCO ID | 색상 | HEX | Canvas RGBA |
|--------|---------|------|-----|-------------|
| backpack | 24 | 황금/앰버 | `#f59e0b` | `rgba(245,158,11,0.9)` |
| umbrella | 25 | 황금/앰버 | `#f59e0b` | `rgba(245,158,11,0.9)` |
| handbag | 26 | 황금/앰버 | `#f59e0b` | `rgba(245,158,11,0.9)` |
| tie | 27 | 황금/앰버 | `#f59e0b` | `rgba(245,158,11,0.9)` |
| suitcase | 28 | 황금/앰버 | `#f59e0b` | `rgba(245,158,11,0.9)` |

### 2.3 화재 / 연기 클래스 (FireSmokeService)

| 클래스 | 색상 | HEX | Canvas RGBA | 특이사항 |
|--------|------|-----|-------------|---------|
| fire | 주황-빨강 | `#ff5000` | `rgba(255,80,0,1.0)` | 반투명 배경 채움 + 굵은 테두리(3px) |
| smoke | 슬레이트 회색 | `#64748b` | `rgba(100,116,139,0.9)` | 반투명 배경 채움 + 굵은 테두리(3px) |

### 2.4 특수 상태

| 상태 | 색상 | HEX | 우선순위 |
|------|------|-----|---------|
| loitering (배회) | 빨강 | `#ef4444` | 최고 (클래스 색상 override) |
| dwell > 5s | 노랑 경고 | `#fde047` | dwellTime 텍스트 강조 |

---

## 3. 캔버스 오버레이 시각화 요구사항

### 3.1 BBox (Bounding Box) 렌더링

```
┌──────────────────────────────┐
│ [className #objectId  conf%] │  ← 상단 레이블 배경 (반투명 검정)
│                              │
│  [MASK OK][HELMET]           │  ← 속성 배지 (좌상단)
│                              │
│                              │
│  ↑red ↓black                 │  ← 색상 속성 (좌하단)
└──────────────────────────────┘ [dwell 12.3s]  ← 우하단 (dwellTime)
```

#### 3.1.1 테두리 스타일
- **일반 객체**: 2px 실선, 클래스 색상
- **배회 중 (isLoitering=true)**: 2px 실선, 빨강 (`rgba(239,68,68,0.9)`)
- **화재/연기**: 3px 실선 + 반투명 배경 채움

#### 3.1.2 레이블
- 위치: BBox 상단 좌측 (-20px offset)
- 형식: `{className} #{objectId}  {conf}%`
- 폰트: `bold 12px monospace`
- 배경: `rgba(0,0,0,0.7)` 반투명 블록

#### 3.1.3 DwellTime 표시
- 위치: BBox 우하단 외부
- 조건: `isLoitering === true` 또는 `dwellTime > 5.0`
- 배경: 배회 시 빨강(`rgba(239,68,68,0.85)`), 일반 시 어두운 회색
- 폰트: `bold 10px monospace`

### 3.2 AI 속성 배지 (Attribute Badges)

#### 3.2.1 마스크 배지

| 상태 | 표시 텍스트 | 배경색 |
|------|------------|--------|
| `mask_correct` | MASK OK | `rgba(34,197,94,0.85)` (초록) |
| `no_mask` | NO MASK | `rgba(239,68,68,0.85)` (빨강) |
| `mask_incorrect` | MASK? | `rgba(234,179,8,0.85)` (노랑) |

#### 3.2.2 헬멧/모자 배지

| 상태 | 표시 텍스트 | 배경색 |
|------|------------|--------|
| `isHelmet = true` | HELMET | `rgba(59,130,246,0.85)` (파랑) |
| `isHelmet = false` | HAT | `rgba(107,114,128,0.85)` (회색) |

- 위치: BBox 내부 좌상단 (y+2, 순서대로 가로 배치)
- 폰트: `bold 9px monospace`
- 높이: 14px

### 3.3 색상 속성 표시 (Color Analysis)

- 위치: BBox 내부 좌하단 (y+h-15)
- 형식: `↑{upper} ↓{lower}` (상의 색상, 하의 색상)
- 폰트: `9px monospace`
- 배경: `rgba(0,0,0,0.72)`
- 텍스트 색상: `#d1d5db` (밝은 회색)

### 3.4 얼굴 감지 내부 BBox

- 조건: `det.face` 존재 시
- 스타일: 파선(dash) 스타일 `[3,2]` 사각형
- 색상: `rgba(147,197,253,0.9)` (밝은 파랑)
- 선 굵기: 1.5px
- 좌표: 얼굴 bbox 픽셀 좌표 (frame 기준, scale 적용)

---

## 4. Zone 오버레이 요구사항

### 4.1 Zone 폴리곤 색상

| Zone 타입 | 채움색 | 테두리색 |
|-----------|--------|---------|
| MONITOR | `rgba(59,130,246,0.12)` (파랑) | `rgba(59,130,246,0.8)` |
| EXCLUSION | `rgba(245,158,11,0.12)` (앰버) | `rgba(245,158,11,0.8)` |

### 4.2 Zone 레이블
- 위치: 폴리곤 중심 좌표 (centroid)
- 배경: `rgba(0,0,0,0.65)` 반투명 블록
- 텍스트: MONITOR=`#60a5fa`, EXCLUSION=`#fbbf24`
- 폰트: `bold 10px sans-serif`

---

## 5. 탐지 목록 패널 (Detection Panel) 요구사항

### 5.1 패널 구성 (전체화면 뷰 기준)

```
┌─────────────────────────────────────┐
│ DETECTIONS          3 obj  1 loiter │  ← 헤더
├─────────────────────────────────────┤
│ PERSON               [LOITER] #a1b2 │
│ conf 96%  dwell 15.2s               │
│ x 120  y 80  w 60  h 120            │
│ upper red  lower blue               │  ← color
│ face 89%                            │  ← face score
├─────────────────────────────────────┤
│ CAR                           #c3d4 │
│ conf 78%  dwell 2.0s                │
│ x 200  y 300  w 80  h 50            │
├─────────────────────────────────────┤
│ FIRE         [FIRE 🔴]        #e5f6 │
│ conf 91%  dwell 0.0s                │
├─────────────────────────────────────┤
│ ── 객체 클래스 ────────────────────  │
│ ■ person   ■ bicycle                │
│ ■ car      ■ motorcycle             │
│ ■ bus      ■ truck                  │
│ ■ fire     ■ smoke                  │
│ ■ loitering ■ 소지품                │
│   (backpack·umbrella·handbag·       │
│    tie·suitcase)                    │
│ ── AI 속성 뱃지 ────────────────── │
│ [MASK OK]  [NO MASK]                │
│ [HELMET]   [HAT]                    │
│ ⬚ face bbox   ↑↓ color             │
└─────────────────────────────────────┘
```

### 5.2 탐지 행 색상 코드

| 클래스 | 텍스트 색상 | 행 배경 |
|--------|------------|--------|
| person (배회) | `text-red-400` | `bg-red-900/20` |
| person | `text-green-400` | - |
| bicycle | `text-yellow-400` | - |
| car | `text-blue-400` | - |
| motorcycle | `text-orange-400` | - |
| bus | `text-purple-400` | - |
| truck | `text-teal-400` | - |
| fire | `text-orange-500` | `bg-orange-900/25` |
| smoke | `text-slate-400` | `bg-slate-800/40` |
| backpack/umbrella/handbag/tie/suitcase | `text-amber-400` | - |

### 5.3 정렬 기준
1. **배회 중 객체** 최우선 (isLoitering = true)
2. **dwellTime 내림차순** (오래 머문 객체 상위)

### 5.4 표시 필드 (객체별)

| 필드 | 표시 조건 | 형식 |
|------|----------|------|
| className | 항상 | 대문자 |
| objectId | 항상 | `#` + 앞 8자리 |
| confidence | 항상 | `conf XX%` |
| dwellTime | 항상 | `dwell X.Xs` (>5s: 노랑 강조) |
| bbox | 항상 | x, y, w, h 픽셀값 |
| mask | `det.mask` 존재 시 | MASK OK / NO MASK / MASK BAD 배지 |
| hat | `det.hat` 존재 시 | HELMET / HAT 배지 |
| color | `det.color` 존재 시 | `upper {color} \| lower {color}` |
| face | `det.face` 존재 시 | `face XX%` (+ identity 있을 시 이름) |

### 5.5 특수 배지

| 배지 | 조건 | 색상 |
|------|------|------|
| LOITER | `isLoitering === true` | `bg-red-600` |
| FIRE | `className === 'fire'` | `bg-orange-600 animate-pulse` |
| SMOKE | `className === 'smoke'` | `bg-slate-600` |
| MASK OK | `mask.status === 'mask_correct'` | `bg-green-700` |
| MASK BAD | `mask.status === 'mask_incorrect'` | `bg-yellow-700` |
| NO MASK | `mask.status === 'no_mask'` | `bg-red-700` |
| HELMET | `hat.isHelmet === true` | `bg-blue-700` |
| HAT | `hat.isHelmet === false` | `bg-gray-600` |

---

## 6. 범례 (Legend) 요구사항

### 6.1 범례 구성 요소

범례는 탐지 패널 하단 고정 영역에 표시되며 두 섹션으로 구성된다.

#### 섹션 1: 객체 클래스 (Object Classes)
```
─ 객체 클래스 ──────────
■ person      ■ bicycle
■ car         ■ motorcycle
■ bus         ■ truck
■ fire        ■ smoke
■ loitering   ■ 소지품
  (backpack · umbrella · handbag · tie · suitcase)
```

#### 섹션 2: AI 속성 배지 (AI Attribute Badges)
```
─ AI 속성 뱃지 ──────────
[MASK OK]  [NO MASK]
[HELMET]   [HAT]
⬚ face bbox    ↑↓ color
```

### 6.2 범례 색상 명세

| 항목 | 색상 클래스 | 설명 |
|------|------------|------|
| person | `text-green-400` | 초록 |
| bicycle | `text-yellow-400` | 노랑 |
| car | `text-blue-400` | 파랑 |
| motorcycle | `text-orange-400` | 주황 |
| bus | `text-purple-400` | 보라 |
| truck | `text-teal-400` | 청록 |
| fire | `text-orange-500` | 주황-빨강 |
| smoke | `text-slate-400` | 슬레이트 회색 |
| loitering | `text-red-400` | 빨강 |
| 소지품 | `text-amber-400` | 앰버/황금 |
| MASK OK | `bg-green-700 text-green-100` | 초록 배지 |
| NO MASK | `bg-red-700 text-red-100` | 빨강 배지 |
| HELMET | `bg-blue-700 text-blue-100` | 파랑 배지 |
| HAT | `bg-gray-600 text-gray-200` | 회색 배지 |
| face bbox | `text-blue-400` | 밝은 파랑 파선 |
| color | `text-gray-400` | 회색 텍스트 |

---

## 7. Socket.IO 이벤트 데이터 명세

### 7.1 `detections` 이벤트 페이로드

```typescript
interface DetectionsPayload {
  cameraId:    string;
  frameId:     number;
  timestamp:   number;       // Unix ms
  frameWidth:  number;       // pixels
  frameHeight: number;       // pixels
  detections:  Detection[];
}

interface Detection {
  objectId:    number;       // ByteTracker ID (1-79999) or 80000+ (fire/smoke)
  className:   string;       // COCO class name or 'fire'/'smoke'
  confidence:  number;       // 0.0 ~ 1.0
  bbox:        BBox;         // pixel coords in original frame
  isLoitering: boolean;
  dwellTime:   number;       // seconds
  // AI 속성 (optional)
  face?:       FaceAttribute;
  mask?:       MaskAttribute;
  hat?:        HatAttribute;
  color?:      ColorAttribute;
  cloth?:      ClothAttribute;
}

interface BBox {
  x: number; y: number; width: number; height: number;
}

interface FaceAttribute {
  bbox:      BBox;
  score:     number;         // 0.0 ~ 1.0
  identity?: string;         // 얼굴 인식 이름 (ArcFace)
}

interface MaskAttribute {
  status:     'mask_correct' | 'mask_incorrect' | 'no_mask';
  confidence: number;
}

interface HatAttribute {
  className:  string;        // 'hardhat' | 'no_hardhat'
  confidence: number;
  isHelmet:   boolean;
}

interface ColorAttribute {
  upper: string;             // e.g. 'red', 'blue', 'black'
  lower: string;
}

interface ClothAttribute {
  [key: string]: unknown;    // Phase-2 clothing attribute (reserved)
}
```

### 7.2 objectId 범위

| 범위 | 출처 | 설명 |
|------|------|------|
| 1 ~ 79,999 | ByteTracker | 인물/차량/소지품 추적 ID |
| 80,000+ | FireSmokeService | `80000 + (frameId % 1000) * 10 + i` |

---

## 8. 성능 요구사항

| 항목 | 요구사항 |
|------|---------|
| 오버레이 렌더링 지연 | 프레임 수신 후 < 5ms |
| 탐지 목록 업데이트 | 60fps 기준 프레임당 1회 이하 |
| 범례 표시 | 항상 고정 표시 (스크롤 불필요) |
| 최대 동시 표시 객체 | 카메라당 100개 (DOM 렌더링 한계) |

---

## 9. 구현 현황 및 체크리스트

### 9.1 캔버스 오버레이 (`CameraView.tsx`)

| 기능 | 상태 | 비고 |
|------|------|------|
| BBox 렌더링 | ✅ 완료 | |
| 클래스 색상 코드 (person~truck) | ✅ 완료 | |
| 소지품 클래스 색상 (amber) | ✅ 완료 | backpack/umbrella/handbag/tie/suitcase |
| fire/smoke 색상 + 배경 채움 | ✅ 완료 | |
| loitering 빨강 override | ✅ 완료 | |
| 레이블 (class + id + conf) | ✅ 완료 | |
| dwellTime 표시 | ✅ 완료 | |
| MASK 배지 | ✅ 완료 | |
| HELMET/HAT 배지 | ✅ 완료 | |
| 색상 속성 (↑upper ↓lower) | ✅ 완료 | |
| 얼굴 파선 내부 bbox | ✅ 완료 | |
| Zone 폴리곤 오버레이 | ✅ 완료 | |

### 9.2 탐지 목록 패널 (`FullscreenCameraView.tsx`)

| 기능 | 상태 | 비고 |
|------|------|------|
| 객체 행 렌더링 | ✅ 완료 | |
| 클래스 텍스트 색상 | ✅ 완료 | |
| 소지품 amber 색상 | ✅ 완료 | text-amber-400 |
| fire/smoke 배경 색상 | ✅ 완료 | |
| LOITER 배지 | ✅ 완료 | |
| FIRE/SMOKE 배지 | ✅ 완료 | |
| MASK 배지 | ✅ 완료 | |
| HELMET/HAT 배지 | ✅ 완료 | |
| 색상 속성 표시 | ✅ 완료 | |
| 얼굴 스코어 표시 | ✅ 완료 | |
| 범례 - 인물/차량/fire/smoke | ✅ 완료 | |
| 범례 - 소지품 클래스 (amber) | ✅ 완료 | |
| 범례 - loitering 표시 | ✅ 완료 | |
| 범례 - AI 속성 배지 | ✅ 완료 | |
| 범례 - face bbox 안내 | ✅ 완료 | |
| 범례 - color 안내 | ✅ 완료 | |

### 9.3 데이터 파이프라인

| 기능 | 상태 | 비고 |
|------|------|------|
| YOLOv8n 인물/차량/소지품 탐지 | ✅ 완료 | |
| ByteTracker 객체 추적 | ✅ 완료 | |
| BehaviorEngine 배회 분석 | ✅ 완료 | |
| SCRFD 얼굴 탐지 | ✅ 완료 (모델 필요) | `scrfd_2.5g.onnx` |
| YOLOv8m PPE 마스크/헬멧 탐지 | ✅ 완료 (모델 필요) | `yolov8m_ppe.onnx` |
| Phase-1 색상 분석 | ✅ 완료 | 픽셀 평균, 모델 불필요 |
| ArcFace 얼굴 인식 | 🔲 준비중 | `arcface_w600k_r50.onnx` |
| FireSmokeService | ✅ 완료 (모델 필요) | `yolov8s_fire_smoke.onnx` |

---

## 10. 모델 파일 요구사항

| 파일명 | 크기 | 위치 | 기능 |
|--------|------|------|------|
| `yolov8n.onnx` | ~6MB | `server/models/` | 인물/차량/소지품 탐지 |
| `scrfd_2.5g.onnx` | ~3.2MB | `server/models/` | 얼굴 탐지 |
| `yolov8m_ppe.onnx` | ~99MB | `server/models/` | 마스크/헬멧 탐지 |
| `arcface_w600k_r50.onnx` | ~249MB | `server/models/` | 얼굴 인식 |
| `yolov8s_fire_smoke.onnx` | ~22MB | `server/models/` | 화재/연기 탐지 |

모델 파일은 `/api/capabilities` 엔드포인트를 통해 존재 여부를 확인할 수 있으며, 모델이 없는 경우 해당 AI 기능은 자동으로 비활성화된다.

---

## 11. 참고 문서

- [RFP_AI_Detection.md](./RFP_AI_Detection.md) — 1차 AI 모듈 (인물/차량/속성) 명세
- [RFP_AI_Fire_Smoke_Detection.md](./RFP_AI_Fire_Smoke_Detection.md) — 화재/연기 탐지 명세
- [README.md](./README.md) — 시스템 전체 아키텍처
