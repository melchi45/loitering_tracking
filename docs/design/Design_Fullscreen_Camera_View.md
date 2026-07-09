# Design: Fullscreen Camera View

**Version:** 1.9
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
| 상세 패널 | 이벤트 클릭 시 우측 192px 분할 패널 (Parsed / Raw XML), `showDetail && selected` 조건 |
| **Name 컬럼** | **각 행 좌측 `LABEL_W=130px` 고정 폭 — topicLabel (severity 색상, bold) / sourceToken (gray) / [ruleName] (indigo); `OnvifRow.sourceToken`, `OnvifRow.ruleName` 독립 저장** |
| **Name 헤더 행** | **트랙 목록 상단 sticky "Name" 레이블 행 (22px)** |
| **드래그 너비 보정** | **`containerRef.width - LABEL_W` 기준으로 pan 계산** |
| **tick 오프셋** | **tick strip `left: LABEL_W` — Gantt 영역에만 시간 눈금 표시** |
| **Overview strip** | **`OVERVIEW_H=50px` — 모든 이벤트 타입을 severity 색상 미니 바로 오버레이; 스크롤=줌, 클릭=`showDetail` 토글 (▲/▼ 표시)** |
| **Detail rows 토글** | **`showDetail` 상태 (기본 true) — Overview 클릭 시 개별 이벤트 행 접기/펼치기; Tick labels 항상 표시** |
| **point 이벤트 미니 바** | **Overview에서 point event는 2px 수직 바, duration event는 8px 미니 바로 표시** |

#### 3.2.1 2-Panel 레이아웃 구조

```
◀ 130px Name 컬럼 ▶◀──────────── Gantt 영역 (flex-1) ─────────────▶
┌───────────────────┬─────────────────────────────────────────────────┐
│ All Events  ▲     │  ░▌░░░░░░░░░░░▌░░░░░░░░▌░░░░▌░░░░░░░░░░░░░░░░░ │ ← Overview strip (50px)
│  (클릭=접기)      │  ← severity 색상 미니 바 오버레이 (모든 타입)   │   · scroll 휠 → 줌 인/아웃
└───────────────────┴─────────────────────────────────────────────────┘
┌───────────────────┬─────────────────────────────────────────────────┐
│ Motion / cam1     │  ████████████████████████                       │ ← Detail rows
│ LineCrossing/r1   │          ██████████                             │   (showDetail=true 시 표시)
│ TamperDetection   │  ██                                             │   수직 스크롤 (줌 없음)
│  …                │                                                 │
└───────────────────┴─────────────────────────────────────────────────┘
┌───────────────────┬─────────────────────────────────────────────────┐
│ (공백, LABEL_W)   │  08:00      09:00      10:00      11:00         │ ← Tick labels (20px)
└───────────────────┴─────────────────────────────────────────────────┘
```

> **접힌 상태 (`showDetail=false`, All Events ▼ 클릭 후)**

```
┌───────────────────┬─────────────────────────────────────────────────┐
│ All Events  ▼     │  ░▌░░░░░░░░░░░▌░░░░░░░░▌░░░░▌░░░░░░░░░░░░░░░░░ │ ← Overview strip (유지)
└───────────────────┴─────────────────────────────────────────────────┘
┌───────────────────┬─────────────────────────────────────────────────┐
│ (공백, LABEL_W)   │  08:00      09:00      10:00      11:00         │ ← Tick labels (항상 표시)
└───────────────────┴─────────────────────────────────────────────────┘
  ↑ Detail rows 및 상세 패널 DOM 제거됨
```

#### 3.2.2 Overview 미니 바 렌더링 규칙

| 이벤트 종류 | Overview 표현 | 예시 |
|------------|--------------|------|
| **duration 이벤트** (state 변화 있음) | 높이 `MINI_BAR_H=8px` 수평 바 | Motion, LineCrossing |
| **point 이벤트** (순간 발생) | 너비 `2px` × 높이 `12px` 수직 바 | Tamper, DIO |
| 색상 | severity 기반 — `critical`=빨강, `warning`=노랑, `info`=파랑, 기타=회색 | |

#### 3.2.3 인터랙션 명세

| 인터랙션 | 대상 영역 | 동작 |
|---------|---------|------|
| `scroll` (휠) | Overview strip **전용** | `viewMs` 줌 인/아웃 (×1.4 배율), Detail rows에는 전파 안 됨 |
| `mousedown` + drag | Overview strip | `viewStart` 이동 (패닝), `ganttW = containerW - LABEL_W` 기준 |
| `click` (드래그 없음) | Overview strip "All Events" 라벨 영역 | `showDetail` 토글 (▲→▼ / ▼→▲); `hasDraggedRef` 체크로 드래그와 구분 |
| `click` | Detail rows 개별 이벤트 바 | `selected` 상태 → 우측 상세 패널(192px) 열림 |
| `scroll` | Detail rows | 수직 스크롤만 (`overflow-y-auto`), 줌 없음 |

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
| 시각화 방식 | 3단 flex-col — ① Overview strip 50px (전체 트랙 미니 바) + ② Detail rows (Gantt 행) + ③ Tick labels 20px |
| 막대 색상 | 빨강=isLoitering, 초록=person, 파랑=car, 청록=truck, 기타 회색 |
| 줌/팬 | Overview 스크롤 휠(×1.4) + Overview 드래그 + ◀▶ 버튼 + ✕ 리셋 |
| 상세 패널 | 막대 클릭 시 우측 200px 패널 (`showDetail && selected` 조건) |
| 로딩 표시 | SVG 스피너 (서버 조회 중 표시) |
| **Name 컬럼** | **각 행 좌측 100px(`LABEL_W`) 고정 폭 — className (색상) / #objectId_last6 (mono) / identity (indigo, optional)** |
| **Name 헤더 행** | **트랙 목록 상단 sticky "Name" 레이블 행 (20px)** |
| **tick 오프셋** | **tick strip `left: LABEL_W`로 오프셋 — Gantt 영역에만 렌더링; `flex-shrink-0`으로 항상 표시** |
| **Overview strip** | **`OVERVIEW_H=50px` — 클래스별 색상 미니 바(`MINI_BAR_H=8px`) 오버레이; 스크롤=줌, 클릭=`showDetail` 토글 (▲/▼ 표시)** |
| **Detail rows 토글** | **`showDetail` 상태 (기본 true) — 접기 시 Detail rows + Detail panel 숨김, Overview + Tick 유지** |
| **containerW 추적** | **`ResizeObserver` → `containerW` 상태 → `ganttW = containerW - LABEL_W`** |

#### 3.3.1 2-Panel 레이아웃 구조

```
◀ 100px Name 컬럼 ▶◀──────────── Gantt 영역 (flex-1) ─────────────▶
┌─────────────────┬───────────────────────────────────────────────────┐
│ All Tracks  ▲   │  ██░░░░░░░░████░░░░░░░░███░░░░░░░░░░░░░███░░░░░░ │ ← Overview strip (50px)
│  (클릭=접기)    │  ← 클래스별 색상 미니 바(8px) 오버레이 (전체 트랙) │   · scroll 휠 → 줌 인/아웃
└─────────────────┴───────────────────────────────────────────────────┘
┌─────────────────┬───────────────────────────────────────────────────┐
│ person          │  ████████████████████████████                     │ ← Detail rows
│ #a1b2c3         │                                                   │   (showDetail=true 시 표시)
│ car             │          ██████████████                           │   수직 스크롤 (줌 없음)
│ #d4e5f6         │                                                   │
│ person(배회)    │  ████████████████████████████████████████████████ │   ← isLoitering: 빨강
│  …              │                                                   │
└─────────────────┴───────────────────────────────────────────────────┘
┌─────────────────┬───────────────────────────────────────────────────┐
│ (공백, LABEL_W) │  08:00      09:00      10:00      11:00           │ ← Tick labels (20px)
└─────────────────┴───────────────────────────────────────────────────┘
```

> **접힌 상태 (`showDetail=false`, All Tracks ▼ 클릭 후)**

```
┌─────────────────┬───────────────────────────────────────────────────┐
│ All Tracks  ▼   │  ██░░░░░░░░████░░░░░░░░███░░░░░░░░░░░░░███░░░░░░ │ ← Overview strip (유지)
└─────────────────┴───────────────────────────────────────────────────┘
┌─────────────────┬───────────────────────────────────────────────────┐
│ (공백, LABEL_W) │  08:00      09:00      10:00      11:00           │ ← Tick labels (항상 표시)
└─────────────────┴───────────────────────────────────────────────────┘
  ↑ Detail rows 및 상세 패널(200px) DOM 제거됨
```

#### 3.3.2 Overview 미니 바 색상 규칙

| 조건 | 색상 | 비고 |
|------|------|------|
| `isLoitering=true` | 빨강 (`#ef4444`) | 배회 감지 객체 우선 |
| class=`person` | 초록 (`#22c55e`) | |
| class=`car` | 파랑 (`#3b82f6`) | |
| class=`truck` | 청록 (`#06b6d4`) | |
| 기타 | 회색 (`#6b7280`) | |
| `inProgress=true` (진행 중) | opacity `0.45` (완료 트랙은 `0.65`) | |

#### 3.3.3 인터랙션 명세

| 인터랙션 | 대상 영역 | 동작 |
|---------|---------|------|
| `scroll` (휠) | Overview strip **전용** | `viewMs` 줌 인/아웃 (×1.4 배율), Detail rows에는 전파 안 됨 |
| `mousedown` + drag | Overview strip | `viewStart` 이동 (패닝), `ganttW = containerW - LABEL_W` 기준 (`ResizeObserver`) |
| `click` (드래그 없음) | Overview strip "All Tracks" 라벨 영역 | `showDetail` 토글 (▲→▼ / ▼→▲); `hasDraggedRef` 체크 (`DRAG_THRESHOLD=4px`) |
| `click` | Detail rows 개별 트랙 바 | `selected` 상태 → 우측 상세 패널(200px) 열림 (`showDetail=true`일 때만) |
| `scroll` | Detail rows | 수직 스크롤만 (`overflow-y-auto`), 줌 없음 |
| ◀ / ▶ 버튼 | 헤더 컨트롤 | `viewStart` ±`viewMs/3` 패닝 |
| ✕ 버튼 | 헤더 컨트롤 | `viewStart`·`viewMs` 초기값으로 리셋 |

> **우측 항상표시 패널의 `DetectionPanel`과 데이터 구분:**
> - 우측 패널 `DetectionPanel`: **실시간** Socket.IO `objectTracked` 이벤트 (현재 프레임 감지 객체)
> - 하단 Detections 탭 `DetectionsTimelineInline`: **저장된** ByteTracker 트랙 생명주기 이력 (배회 위험 객체만)

> **`/api/analysis/events`와 `/api/analysis/detection-tracks` 구분:**
> - `/api/analysis/events`: 쿨다운 게이팅된 Alert 트리거 이벤트 (화재/연기 30초, 배회 60초 쿨다운)
> - `/api/analysis/detection-tracks`: ByteTracker가 추적한 모든 객체의 출현~소멸 구간 이력

#### 3.3.4 상세정보 패널 Crop 렌더링 (화질 & 잘림 방지)

Streaming 모드에서 Detections 타임라인 crop이 흐릿하게 보이고, 상세 패널 확대 미리보기가 세로로 긴 인물 crop의 상하를 잘라내는 문제를 개선했다.

**원인:** 저장 단계(`snapshotService.cropJpeg`)가 320×320px/quality 70으로 다운스케일했고, 클라이언트가 `object-cover` + 고정 높이 박스로 렌더링해 원본 crop의 상/하단이 화면 밖으로 잘려나갔다.

| 위치 | 파일:라인 | 변경 |
|---|---|---|
| Crop 저장 해상도/품질 | `server/src/services/snapshotService.js` L33-34 | `MAX_DIM` 320→640, `JPEG_QUALITY` 70→85 (여전히 `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY` env로 오버라이드 가능) |
| 확대 미리보기 (`zoomedSnap`) | `DetectionsTimelineInline.tsx` L781-802 | `object-cover` + `maxHeight:120` 고정 → `object-contain` + `style.aspectRatio = cropWidth/cropHeight`(폴백 `1/1`) + `maxHeight:260` 안전 상한. 박스 높이가 실제 crop 비율을 따라가며, 상한에 걸려도 letterbox만 발생하고 이미지는 잘리지 않음 |
| crop 썸네일 그리드 (3열) | `DetectionsTimelineInline.tsx` L804-830 | `object-cover` → `object-contain` + `bg-black`; 셀 고정 높이 52px(그리드 균일성)은 유지하되 letterbox로 잘림 방지 |
| Gantt 필름스트립 마커 (28×34px) | `DetectionsTimelineInline.tsx` L689-725 | **변경 없음** — 타임라인 스크러버 아이콘 용도로 `object-cover` 유지 (상세정보 패널의 대상 아님) |

> 관련 SDLC: `SRS_Fullscreen_Camera_View.md` FR-08, `Design_Detection_Snapshot_Search.md` §14, `PRD_Detection_Snapshot_Search.md` §6.3

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
| v1.7 | **2-Panel Overview & Collapse** | `DetectionsTimelineInline` · `OnvifTimelineInline` 모두 3단 flex-col 구조로 전환 — Overview strip 50px(미니 바 오버레이, 줌/토글) + Detail rows(접기/펼치기) + Tick labels(항상 표시); `showDetail` 상태; `ResizeObserver` containerW; `ganttW = containerW - LABEL_W` |
| v1.9 | **Crop 화질 & 상세정보 패널 잘림 방지** | Crop 저장 해상도/품질 상향(640×640/q85); Detections 상세정보 패널 확대 미리보기·썸네일 그리드 `object-cover` → `object-contain` + 동적 `aspectRatio` 전환 (필름스트림 마커는 제외) |

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
| 1.7 | 2026-06-26 | §3.2/3.3 2-panel Overview & Collapse 반영 — 양 컴포넌트 3단 flex-col 구조 (Overview 50px, Detail rows 토글, Tick labels 항상 표시); showDetail 상태, ResizeObserver containerW, ganttW 계산, ONVIF point/duration 미니 바 구분; §7 변경 이력 업데이트 |
| 1.8 | 2026-06-26 | §3.2.1~3.2.3 ONVIF Timeline 2-panel UI 레이아웃 다이어그램 추가 (펼침/접힘 ASCII, Overview 미니 바 렌더링 규칙, 인터랙션 명세); §3.3.1~3.3.3 Detections Timeline 동일 구조로 추가 |
| 1.9 | 2026-07-09 | §3.3.4 신규 — Detections crop 화질 상향(640×640/q85) 및 상세정보 패널 `object-contain` 동적 레이아웃(잘림 방지); §7 변경 이력 업데이트 |
