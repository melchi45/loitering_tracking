# Design: Fullscreen Camera View

**Version:** 1.6
**Status:** Implemented
**Related:** [Design_Dashboard_Layout.md](Design_Dashboard_Layout.md) · [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md) · [Design_Dashboard_Detection_Display.md](Design_Dashboard_Detection_Display.md)
**SDLC:** [RFP](../rfp/RFP_Fullscreen_Camera_View.md) · [PRD](../prd/PRD_Fullscreen_Camera_View.md) · [SRS](../srs/SRS_Fullscreen_Camera_View.md) · [TC](../tc/TC_Fullscreen_Camera_View.md)

---

## 1. Overview

Fullscreen Camera View는 메인 대시보드에서 카메라를 클릭(또는 탭)했을 때 표시되는 전체화면 오버레이입니다.
`FullscreenCameraView.tsx` 단일 파일에 구현되며 다음 두 영역으로 구성됩니다:
- **좌/상단 — 비디오 컬럼**: WebRTC 스트림 + 3개 하단 탭 (Camera Events / ONVIF Timeline / Detections)
- **우/하단 — 실시간 DetectionPanel** (항상 표시, 데스크톱 288px / 모바일 40%)

---

## 2. 레이아웃 구조 (v1.2 기준)

### 데스크톱 (flex-row, `window.innerWidth >= 768`)

```
┌─────────────────────────────────────────────┬───────────────────┐
│  [cameraName]                    [✕ Close]  │                   │
├─────────────────────────────────────────────┤  DetectionPanel   │
│                                             │  (288px 고정)     │
│          WebRTC Video (flex-1)              │                   │
│                                             │  실시간 AI 감지   │
├─────────────────────────────────────────────┤  (objectTracked)  │
│  [Camera Events] [ONVIF Timeline][Detections│                   │
├─────────────────────────────────────────────┤                   │
│  탭 콘텐츠 (높이 가변)                       │                   │
└─────────────────────────────────────────────┴───────────────────┘
```

### 모바일 (flex-column, `window.innerWidth < 768`)

```
┌──────────────────────────────────┐
│  [cameraName]          [✕ Close] │
├──────────────────────────────────┤
│  WebRTC Video  (flex: 0 0 60%)   │
├──────────────────────────────────┤
│  [Cam Events][ONVIF][Detections] │
├──────────────────────────────────┤
│  탭 콘텐츠 (높이 가변)            │
├──────────────────────────────────┤
│  DetectionPanel (flex: 0 0 40%)  │
└──────────────────────────────────┘
```

| 영역 | 구현 | 설명 |
|------|------|------|
| 외부 컨테이너 | `display:flex; flexDirection: row\|column` | `isMobile` 상태로 방향 전환 |
| Header | `<div>` flex row | 카메라 이름 + 닫기 버튼 (Esc 키도 닫힘) |
| Video | `CameraView` | WebRTC WHEP 스트림 + AI 오버레이 바운딩박스 |
| Tab bar | `<button>` × 3 | `border-b-2` 언더라인 스타일 |
| Tab content | 조건부 렌더링 | 탭별 단일 컴포넌트 (분할 없음) |
| Right panel | `DetectionPanel` | 항상 표시, 실시간 데이터 |

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

### 3.2 ONVIF Timeline 탭 (`OnvifTimelineInline`)

| 항목 | 값 |
|------|----|
| 탭 색상 | `border-indigo-500 / text-indigo-300` |
| 높이 | 200px |
| 데이터 소스 | `GET /api/onvif-events` (DB 저장 데이터) + `onvif:event` Socket.IO |
| 범위 프리셋 | `1H` · `6H` · `1D` · `1W` · `1M` · `1Y` · `Custom` (기본: `1H`) |
| 커스텀 범위 | `datetime-local` Start/End 입력 + Apply 버튼 |
| 상세 패널 | 이벤트 클릭 시 우측 192px 분할 패널 (Parsed / Raw XML) |
| **Name 컬럼** | **각 행 좌측 `LABEL_W=130px` 고정 폭 — topicLabel (severity 색상, bold) / sourceToken (gray) / [ruleName] (indigo); `OnvifRow.sourceToken`, `OnvifRow.ruleName` 독립 저장** |
| **Name 헤더 행** | **트랙 목록 상단 sticky "Name" 레이블 행 (22px)** |
| **드래그 너비 보정** | **`containerRef.width - LABEL_W` 기준으로 pan 계산** |
| **tick 오프셋** | **tick strip `left: LABEL_W` — Gantt 영역에만 시간 눈금 표시** |

상세 설계: [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md)

### 3.3 Detections 탭 (`DetectionsTimelineInline`)

| 항목 | 값 |
|------|----|
| 탭 색상 | `border-emerald-500 / text-emerald-300` |
| 높이 | 300px |
| 데이터 소스 | `GET /api/analysis/detection-tracks` (ByteTracker 생명주기 DB 저장 — isLoitering=true 또는 riskScore≥0.3 트랙만) |
| 범위 프리셋 | `1H` · `6H` · `1D` · `1W` · `Custom` |
| 커스텀 범위 | `datetime-local` From/To 입력 + Apply/✕ 버튼 |
| 클래스 필터 | `All / Person / Car / Truck / Bus / Motorcycle` 드롭다운 |
| 시각화 방식 | Gantt 스타일 수평 막대 — X축=시간, 막대 폭=dwell 구간 |
| 막대 색상 | 빨강=isLoitering, 초록=person, 파랑=car, 청록=truck, 기타 회색 |
| 줌/팬 | 스크롤 휠(×1.4) + 드래그 + ◀▶ 버튼 + ✕ 리셋 |
| 상세 패널 | 막대 클릭 시 우측 192px 패널 (Track#·First/Last·Dwell·Risk·Loitering·Conf·Face·Zone·Color·Cloth) |
| 로딩 표시 | SVG 스피너 (서버 조회 중 표시) |
| **Name 컬럼** | **각 행 좌측 100px(`LABEL_W`) 고정 폭 — className (색상) / #objectId_last6 (mono) / identity (indigo, optional)** |
| **Name 헤더 행** | **트랙 목록 상단 sticky "Name" 레이블 행 (20px)** |
| **tick 오프셋** | **tick strip `left: LABEL_W`로 오프셋 — Gantt 영역에만 렌더링** |

> **우측 항상표시 패널의 `DetectionPanel`과 데이터 구분:**
> - 우측 패널 `DetectionPanel`: **실시간** Socket.IO `objectTracked` 이벤트 (현재 프레임 감지 객체)
> - 하단 Detections 탭 `DetectionsTimelineInline`: **저장된** ByteTracker 트랙 생명주기 이력 (배회 위험 객체만)

> **`/api/analysis/events`와 `/api/analysis/detection-tracks` 구분:**
> - `/api/analysis/events`: 쿨다운 게이팅된 Alert 트리거 이벤트 (화재/연기 30초, 배회 60초 쿨다운)
> - `/api/analysis/detection-tracks`: ByteTracker가 추적한 모든 객체의 출현~소멸 구간 이력

---

## 4. 탭 상태 관리

```typescript
const [videoTab, setVideoTab] = useState<'events' | 'onvif' | 'detections'>('onvif');
const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
```

- 기본 탭: `'onvif'` (ONVIF Timeline이 기본 선택)
- `isMobile`: `window.addEventListener('resize', ...)` 로 실시간 감지
- 탭별 하단 패널 높이:

| 탭 | 높이 |
|----|------|
| `events` | 160px |
| `onvif` | 200px |
| `detections` | 300px |

---

## 5. 주요 컴포넌트 목록

| 컴포넌트 | 파일 | Export | 역할 |
|---------|------|--------|------|
| `FullscreenCameraView` | `FullscreenCameraView.tsx` | default | 전체 레이아웃 조율, 탭·모바일 상태 관리 |
| `DetectionPanel` | `FullscreenCameraView.tsx` | named | 실시간 AI 감지 목록 (우측 항상표시) |
| `DetectionRow` | `FullscreenCameraView.tsx` | named | 개별 감지 객체 행 |
| `CameraEventsTab` | `FullscreenCameraView.tsx` | named | DataChannel RTP 메시지 목록 |
| `OnvifTimelineInline` | `OnvifTimelineInline.tsx` | default | ONVIF 타임라인 + 커스텀 범위 |
| `DetectionsTimelineInline` | `DetectionsTimelineInline.tsx` | default | ByteTracker 트랙 Gantt 타임라인 (배회 위험 이력) |
| `AnalysisHistoryTab` | `AnalysisHistoryTab.tsx` | default | 저장된 분석 이벤트 이력 (미사용 — 레거시) |

---

## 6. 키보드 단축키

| 키 | 동작 |
|----|------|
| `Escape` | FullscreenCameraView 닫기 (`onClose()` 호출) |

---

## 7. 레이아웃 변경 이력

| 버전 | 변경 | 상세 |
|------|------|------|
| 초기 | DetectionPanel 위치 | 항상 보이는 우측 패널 (288px) |
| 중간 | 잘못된 변경 | DetectionPanel을 탭으로 내리고 우측 패널 제거 |
| v1.2 | **복구 + 확장** | 우측 DetectionPanel 복구; Detections 탭 = AnalysisHistoryTab(저장 이력); ONVIF 탭 단일 뷰 200px |
| v1.3 | **Detections 탭 교체** | AnalysisHistoryTab(`/api/analysis/events`) → DetectionsTimelineInline(`/api/analysis/detection-tracks`); ByteTracker 생명주기 Gantt 타임라인으로 교체 |
| v1.5 | **Name 컬럼 추가** | ONVIF Timeline (Overlay) 및 Detections Timeline 좌측 Name 컬럼 추가; ONVIF 헤더 cameraName 표시; Detections tick 오프셋 보정 |
| v1.6 | **OnvifTimelineInline Name 컬럼 추가** | `OnvifTimelineInline`(인라인 탭)에도 Name 컬럼 구현 — `LABEL_W=130px`, `OnvifRow.sourceToken/ruleName` 독립 저장, sticky 헤더, 드래그 너비·tick 오프셋 보정 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — FullscreenCameraView 3탭 구조 문서화 |
| 1.1 | 2026-06-16 | ONVIF 탭을 분할 뷰(좌: ONVIF Timeline + 우: DetectionPanel 224px)로 변경; 높이 300px |
| 1.2 | 2026-06-16 | 레이아웃 대규모 정정 — 우측 DetectionPanel 복구(항상표시), Detections 탭을 AnalysisHistoryTab(저장 이벤트)으로 교체, ONVIF 탭 단일 뷰 200px, isMobile 반응형 복구, SDLC 상호참조 추가 |
| 1.3 | 2026-06-16 | Detections 탭 교체: AnalysisHistoryTab → DetectionsTimelineInline (ByteTracker 생명주기 Gantt), 컴포넌트 목록 업데이트, detectionTracks API 구분 설명 추가 |
| 1.4 | 2026-06-24 | ONVIF Timeline 범위 프리셋 `1H` · `6H` 추가, 기본값 1D → 1H; Detections Timeline 범위 프리셋 동기화 확인 |
| 1.5 | 2026-06-26 | §3.2/3.3 Name 컬럼 추가 — ONVIF Overlay(130px, sticky Name 헤더, cameraName 표시) + Detections(100px LABEL_W, tick 오프셋 보정, 드래그 너비 보정); §7 변경 이력 업데이트 |
| 1.6 | 2026-06-26 | §3.2 `OnvifTimelineInline` Name 컬럼 누락 보완 — LABEL_W=130px, OnvifRow sourceToken/ruleName 독립 저장, 드래그 너비·tick 오프셋 보정; §3.2 헤더 카메라명(Overlay 전용) 항목 제거 |
