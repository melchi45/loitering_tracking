# PRD: Fullscreen Camera View — 탭 확장 & 이력 데이터 통합

**Version:** 1.3
**Status:** Implemented
**SDLC:** [RFP](../rfp/RFP_Fullscreen_Camera_View.md) · [SRS](../srs/SRS_Fullscreen_Camera_View.md) · [Design](../design/Design_Fullscreen_Camera_View.md) · [TC](../tc/TC_Fullscreen_Camera_View.md)

---

## 1. 제품 목표

카메라 전체화면 뷰에서 운영자가 다음을 동시에 확인할 수 있도록 합니다:
- **우측 패널**: 실시간 AI 감지 객체 (항상 표시)
- **하단 탭 1 — Camera Events**: DataChannel RTP 원시 메시지
- **하단 탭 2 — ONVIF Timeline**: DB 저장 ONVIF 이벤트 (서버 재시작 후에도 유지, 커스텀 날짜 범위 지원)
- **하단 탭 3 — Detections**: DB 저장 AI 분석 이벤트 이력 (fire/smoke/loitering)

---

## 2. 사용자 스토리

| ID | 역할 | 시나리오 | 완료 기준 |
|----|------|----------|-----------|
| US-01 | 운영자 | 카메라 클릭 후 우측에 실시간 감지 목록을 보면서 하단 Detections 탭으로 과거 이벤트를 조회하고 싶다 | 우측 DetectionPanel 항상 표시; Detections 탭에서 `/api/analysis/events` 데이터 표시 |
| US-02 | 운영자 | ONVIF Timeline 탭에서 서버 재시작 전 이벤트도 확인하고 싶다 | DB 저장 이벤트가 선택된 범위 내 모두 표시 |
| US-03 | 운영자 | ONVIF 이벤트를 특정 날짜 구간으로 검색하고 싶다 | Custom 버튼 → datetime 입력 → Apply → 해당 범위 데이터 로드 |
| US-04 | 운영자 | 데이터 로딩 중임을 알고 싶다 | SVG 스피너가 서버 응답 전까지 표시 |
| US-05 | 운영자 | Detections 탭에서 화재/연기/배회 이력을 타입별로 필터링하고 싶다 | All/Loitering/Fire/Smoke 드롭다운 필터 작동 |
| US-06 | 운영자 | ONVIF 타임라인에서 어떤 이벤트 유형인지 스크롤 없이 좌측에서 바로 확인하고 싶다 | Name 컬럼이 행 좌측에 항상 표시됨 |
| US-07 | 운영자 | Detections 타임라인에서 각 트랙이 어떤 클래스·ID·인물인지 Gantt 바 없이도 파악하고 싶다 | 좌측 Name 컬럼에 className·objectId·identity 표시 |
| US-08 | 운영자 | Detections Timeline에서 전체 트랙 밀도를 한눈에 파악하고, 필요한 시간대만 클릭해 세부 행을 열고 싶다 | Overview strip에 전체 트랙 미니 바 표시; 클릭 시 세부 행 접기/펼치기 |
| US-09 | 운영자 | ONVIF Timeline(인라인 탭)에서 이벤트 전체 패턴을 빠르게 조망한 후 세부 행을 선택적으로 확인하고 싶다 | ONVIF Inline Overview strip에 전체 이벤트 미니 바 표시; 클릭 시 행 토글 |

---

## 3. 기능 상세

### 3.1 레이아웃 구조

- **데스크톱** (≥768px): `flex-row` — 좌측 비디오 컬럼 + 우측 DetectionPanel 288px 고정
- **모바일** (<768px): `flex-column` — 상단 비디오(60%) + 하단 DetectionPanel(40%)
- `isMobile` 상태: `window.resize` 이벤트로 실시간 업데이트

### 3.2 AnalysisHistoryTab (신규 컴포넌트)

데이터 소스: `GET /api/analysis/events?cameraId=&from=&to=&type=&limit=500`

| UI 요소 | 기능 |
|---------|------|
| 범위 버튼 | `1H` / `6H` / `1D` / `1W` / `All` |
| All 선택 시 | datetime-local Start/End 입력 + Apply 버튼 노출 |
| 타입 필터 | All / 🚶 Loitering / 🔥 Fire / 💨 Smoke |
| 이벤트 행 | 타입 아이콘, 타임스탬프, confidence, dwellTime, riskScore, zoneName |
| 썸네일 | hover 시 `cropData` 이미지 표시 (우측 상단 64×64) |
| 새로고침 | ↺ 버튼으로 재조회 |
| 로딩 | SVG 스피너 |

### 3.3 OnvifTimelineInline 커스텀 범위

`[1H][6H][1D][1W][1M][1Y][Custom]` — 기본 선택: `1H`. Custom 선택 시 날짜 입력 행 추가 노출:

```
From [datetime-local]  To [datetime-local]  [Apply]  [✕]
```

Apply 클릭 전까지 fetch 없음. Apply 클릭 시 지정 범위로 `GET /api/onvif-events?from=…&to=…&limit=1000` 실행.

### 3.4 Timeline Name 컬럼

양쪽 타임라인(ONVIF / Detections) 모두 각 Gantt 행 **좌측에 고정 폭 Name 컬럼**이 추가됩니다.

| 컴포넌트 | Name 컬럼 너비 | 표시 내용 |
|---------|:---:|---|
| `OnvifTimelineInline` | 130px (`LABEL_W`) | 상단: topicLabel (severity 색상, bold) / 중간: sourceToken (gray, 있을 때) / 하단: [ruleName] (indigo, 있을 때) |
| `OnvifTimelineOverlay` | 130px (기존 `ROW_LABEL_W`) | 상단: topicLabel (색상 강조) / 중간: sourceToken / 하단: [ruleName] |
| `DetectionsTimelineInline` | 100px (`LABEL_W`) | 상단: className (classColor 색상) / 중간: #objectId_last6 / 하단: identity (있을 때) |

**추가 변경사항:**
- ONVIF Timeline Overlay 헤더 카메라 ID 뱃지 → `cameraName`(useCameraStore) 우선 표시 (없으면 cameraId 앞 8자)
- 모든 타임라인에 "Name" 레이블 sticky 헤더 행(22px) 추가
- `OnvifTimelineInline.OnvifRow` 인터페이스에 `sourceToken`, `ruleName` 필드 독립 추가
- `OnvifTimelineInline` · Detections Timeline: 드래그 너비 계산을 `containerWidth - LABEL_W`로 보정, tick strip을 `left: LABEL_W`로 오프셋

### 3.6 Timeline 2-Panel Overview & Collapse

`DetectionsTimelineInline` 및 `OnvifTimelineInline` 모두 아래 **3단 flex-col 구조**로 변경됩니다:

```
┌──────────────────────────────────────────────────────────────────┐
│  Controls (range / filter / refresh)                             │
├──────────┬───────────────────────────────────────────────────────┤
│ All      │ [mini colored bars, all tracks/events overlaid]       │ ← OVERVIEW (50px)
│ Tracks   │                                        scroll=zoom   │   click=toggle ▲/▼
│          │                               ▲ or ▼ indicator       │
├──────────┼───────────────────────────────────────────────────────┤
│ Name     │                               (sticky header, 22px)  │ ← shown when expanded
│ person   │ ████████████████████                                  │ ← detail rows
│ car      │        ██████                                         │   scroll=vertical
├──────────┴───────────────────────────────────────────────────────┤
│          │ 08:00    09:00    10:00    11:00                       │ ← tick labels (항상 표시)
└──────────┴───────────────────────────────────────────────────────┘
```

| 영역 | 높이 | 인터랙션 |
|------|------|---------|
| Overview strip | 50px (`OVERVIEW_H`) | 스크롤 휠 = 줌; 클릭 = `showDetail` 토글 |
| Detail rows | `flex-1 min-h-0` (접기 시 숨김) | 수직 스크롤만 (줌 없음) |
| Tick labels | 20px (`TICK_H`), `flex-shrink-0` | 항상 표시 |

**Detections Overview 미니 바**: 클래스별 `classColor`로 색상 구분, `MINI_BAR_H=8px`, `opacity=0.65` (inProgress=0.45)

**ONVIF Overview 미니 바**: severity 색상 (`info=indigo / warning=amber / critical=red`), point event=2px 수직 바, duration=8px 미니 바, "All Events" 레이블

**containerW 추적**: `ResizeObserver` → `ganttW = containerW - LABEL_W` 로 계산 (getBoundingClientRect 호출 제거)

**Detail panel** (`showDetail && selected` 조건): 행이 접혀있으면 detail 패널도 자동으로 닫힘

### 3.5 API 확장 (`/api/analysis/events`)

추가된 쿼리 파라미터:

| 파라미터 | 타입 | 설명 |
|----------|------|------|
| `cameraId` | string | 특정 카메라 이벤트만 조회 |
| `from` | ISO 8601 | 시작 시각 (이상) |
| `to` | ISO 8601 | 종료 시각 (이하) |
| `limit` | number | 최대 결과 수 (기존 200 → 500) |

---

## 4. 비기능 요구사항

| 항목 | 기준 |
|------|------|
| 응답성 | 반응형 레이아웃 768px 기준 전환 |
| 데이터 신선도 | 우측 DetectionPanel: Socket.IO 실시간; 하단 탭: REST 조회 기반 |
| 빌드 요구 | 코드 변경 후 `cd client && npm run build` 필수 |
| TypeScript | `strict` 모드 컴파일 오류 0 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — Fullscreen Camera View 탭 확장 PRD |
| 1.1 | 2026-06-24 | OnvifTimelineInline 범위 프리셋 `[1H][6H][1D][1W][1M][1Y][Custom]`으로 업데이트, 기본값 1H |
| 1.2 | 2026-06-26 | US-06/07 추가, §3.4 Timeline Name 컬럼 추가 — ONVIF Overlay·Detections 좌측 Name 컬럼 + cameraName 표시 |
| 1.3 | 2026-06-26 | §3.4 `OnvifTimelineInline` Name 컬럼 누락 보완 — 인라인 탭(FullscreenCameraView 하단)에도 동일 Name 컬럼 구현; OnvifRow.sourceToken/ruleName 독립 저장 명세 추가 |
| 1.4 | 2026-06-26 | US-08~09 추가; §3.6 Timeline 2-Panel Overview & Collapse 신규 — Detections·ONVIF Inline 3단 flex-col 구조 (Overview strip 50px + Detail rows + Tick labels 항상 표시), showDetail 토글, containerW ResizeObserver, ganttW 계산 명세 |
