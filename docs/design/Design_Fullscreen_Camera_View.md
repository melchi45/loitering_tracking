# Design: Fullscreen Camera View

**Version:** 1.0
**Status:** Implemented
**Related:** [Design_Dashboard_Layout.md](Design_Dashboard_Layout.md) · [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md) · [Design_Dashboard_Detection_Display.md](Design_Dashboard_Detection_Display.md)

---

## 1. Overview

Fullscreen Camera View는 메인 대시보드에서 카메라를 클릭(또는 탭)했을 때 표시되는 전체화면 오버레이입니다.
`FullscreenCameraView.tsx` 단일 파일에 구현되며, 비디오 스트림과 세 개의 하단 탭(Camera Events / ONVIF Timeline / Detections)으로 구성됩니다.

---

## 2. 레이아웃 구조

### Camera Events 탭 선택 시 (160px)
```
┌──────────────────────────────────────────────────────────────────┐
│  [cameraName]                                         [✕ Close]  │
├──────────────────────────────────────────────────────────────────┤
│                     WebRTC Video (flex-1)                        │
├──────────────────────────────────────────────────────────────────┤
│  [Camera Events]  [ONVIF Timeline]  [Detections]                 │
├──────────────────────────────────────────────────────────────────┤
│  CameraEventsTab (full width, 160px)                             │
└──────────────────────────────────────────────────────────────────┘
```

### ONVIF Timeline 탭 선택 시 (300px, 분할 뷰)
```
┌──────────────────────────────────────────────────────────────────┐
│  [cameraName]                                         [✕ Close]  │
├──────────────────────────────────────────────────────────────────┤
│                     WebRTC Video (flex-1)                        │
├──────────────────────────────────────────────────────────────────┤
│  [Camera Events]  [ONVIF Timeline]  [Detections]                 │
├────────────────────────────────────────┬─────────────────────────┤
│  OnvifTimelineInline  (flex:1)         │  DetectionPanel (224px) │
│  타임라인 바 + 이벤트 목록 + 상세 패널  │  AI 감지 목록           │
└────────────────────────────────────────┴─────────────────────────┘
```

### Detections 탭 선택 시 (300px, 전체 폭)
```
┌──────────────────────────────────────────────────────────────────┐
│  [cameraName]                                         [✕ Close]  │
├──────────────────────────────────────────────────────────────────┤
│                     WebRTC Video (flex-1)                        │
├──────────────────────────────────────────────────────────────────┤
│  [Camera Events]  [ONVIF Timeline]  [Detections]                 │
├──────────────────────────────────────────────────────────────────┤
│  DetectionPanel (full width, 300px)                              │
└──────────────────────────────────────────────────────────────────┘
```

| 영역 | 구현 | 설명 |
|------|------|------|
| Header | `<header>` | 카메라 이름 + 닫기 버튼 (Esc 키도 닫힘) |
| Video | `CameraView` | WebRTC WHEP 스트림 + AI 오버레이 바운딩박스 |
| Tab bar | `<button>` × 3 | 탭 전환 (border-b-2 언더라인 스타일) |
| Tab content | 조건부 렌더링 | ONVIF 탭만 분할 뷰, 나머지는 단일 컴포넌트 |

---

## 3. 탭 상세

### 3.1 Camera Events 탭 (`CameraEventsTab`)

| 항목 | 값 |
|------|----|
| 탭 색상 | `border-blue-500 / text-blue-300` |
| 높이 | 160px |
| 데이터 소스 | `useDataChannelStore` (DataChannel App RTP 메시지) |
| 자동 스크롤 | 신규 메시지 수신 시 하단으로 스크롤 |

DataChannel을 통해 RTSP Application RTP로 전달된 ONVIF XML 메타데이터 원시 스트림을 시간·시퀀스·페이로드 형식으로 표시합니다.

### 3.2 ONVIF Timeline 탭 (`OnvifTimelineInline` + `DetectionPanel` 분할 뷰)

| 항목 | 값 |
|------|----|
| 탭 색상 | `border-indigo-500 / text-indigo-300` |
| 높이 | 300px |
| 좌측 | `OnvifTimelineInline` (`flex:1`) — ONVIF 이벤트 타임라인 |
| 우측 | `DetectionPanel` (224px) — AI 실시간 감지 목록 |
| 데이터 소스 | `GET /api/onvif-events` + `onvif:event` Socket.IO |
| 상세 패널 | 이벤트 클릭 시 오른쪽 192px 패널 조건부 표시 |

ONVIF Timeline 탭은 분할 뷰로 구성됩니다:
- 좌측: ONVIF 이벤트 타임라인 (이벤트 타입 필터 + 타임바 + 이벤트 목록 + 클릭시 상세 패널)
- 우측: DetectionPanel (AI 실시간 감지 목록, 카테고리 필터, Person Trails 등)

이 분할 뷰를 통해 ONVIF 이벤트와 AI 감지 결과를 동시에 확인할 수 있습니다.
상세 설계: [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md)

### 3.3 Detections 탭 (`DetectionPanel`)

| 항목 | 값 |
|------|----|
| 탭 색상 | `border-emerald-500 / text-emerald-300` |
| 높이 | 300px |
| 데이터 소스 | `useCamera(cameraId).detections` (Socket.IO `objectTracked` 실시간) |

실시간 AI 감지 결과를 표시합니다. 이전에는 항상 보이는 우측 패널(288px)이었으나, 세 번째 탭으로 이동하여 비디오가 전체 너비를 사용합니다.

**DetectionPanel 내부 구성:**

| 섹션 | 설명 |
|------|------|
| 카테고리 필터 바 | 객체 종류별 on/off 토글 (Person·Vehicle·Fire·Smoke 등) |
| 감지 목록 | 배회 위험도 순 정렬, 각 객체의 클래스·신뢰도·배회시간·위험점수·얼굴/의상 속성 |
| Person Trails | 이 카메라를 방문한 인물의 크로스카메라 이동 경로 (collapsible) |
| Cross-Camera Re-ID | 얼굴 Re-ID + 의상 Appearance Re-ID 이벤트 목록 (collapsible) |
| Appearance Re-ID | 의상 속성 세부 정보 (collapsible) |

---

## 4. 탭 상태 관리

```typescript
const [videoTab, setVideoTab] = useState<'events' | 'onvif' | 'detections'>('onvif');
```

- 기본 탭: `'onvif'` (ONVIF Timeline이 기본 선택)
- 탭 전환 시 이전 탭 컴포넌트 언마운트 → 새 탭 마운트 (조건부 렌더링)
- 탭별 하단 패널 높이는 `style={{ height: ... }}` 인라인으로 제어

---

## 5. 키보드 단축키

| 키 | 동작 |
|----|------|
| `Escape` | FullscreenCameraView 닫기 (`onClose()` 호출) |

`window.addEventListener('keydown', ...)` 마운트 시 등록, 언마운트 시 해제.

---

## 6. 주요 컴포넌트 목록

모두 `FullscreenCameraView.tsx` 내에 정의됩니다 (default export + named exports):

| 컴포넌트 | Export | 역할 |
|---------|--------|------|
| `FullscreenCameraView` | default | 전체 레이아웃 조율, 탭 상태 관리 |
| `DetectionPanel` | named | AI 실시간 감지 목록 (Detections 탭) |
| `DetectionRow` | named | 개별 감지 객체 행 |
| `CameraEventsTab` | named | DataChannel RTP 메시지 목록 (Camera Events 탭) |

---

## 7. 레이아웃 변경 이력

| 변경 | 이전 | 이후 |
|------|------|------|
| DetectionPanel 위치 | 항상 보이는 우측 패널 (288px) | 세 번째 하단 탭 (300px 높이) |
| 비디오 너비 | `flex: 1` (우측 패널 288px 제외) | `flex: 1` (전체 너비) |
| 모바일 레이아웃 | column 방향 (video 60% + detection 40%) | 단일 컬럼 (video + 하단 탭) |
| isMobile 상태 | 사용 (우측 패널 배치 제어) | 제거 (단일 레이아웃) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — FullscreenCameraView 3탭 구조 문서화 |
| 1.1 | 2026-06-16 | ONVIF 탭을 분할 뷰(좌: ONVIF Timeline + 우: DetectionPanel 224px)로 변경; 높이 300px |
