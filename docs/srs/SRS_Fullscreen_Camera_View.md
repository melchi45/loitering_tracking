# SRS: Fullscreen Camera View — 탭 확장 & 이력 데이터 통합

**Version:** 1.2
**Status:** Implemented
**SDLC:** [RFP](../rfp/RFP_Fullscreen_Camera_View.md) · [PRD](../prd/PRD_Fullscreen_Camera_View.md) · [Design](../design/Design_Fullscreen_Camera_View.md) · [TC](../tc/TC_Fullscreen_Camera_View.md)

---

## 1. 범위

본 문서는 FullscreenCameraView 탭 확장 기능의 소프트웨어 요구사항을 정의합니다.
구현 파일: `client/src/components/FullscreenCameraView.tsx`, `AnalysisHistoryTab.tsx`, `OnvifTimelineInline.tsx`, `server/src/routes/analysisApi.js`

---

## 2. 기능 요구사항

### FR-01: 우측 DetectionPanel 항상 표시

- **SRS-01-1**: `FullscreenCameraView`는 외부 컨테이너를 `flex-row`(데스크톱) 또는 `flex-column`(모바일)으로 배치한다
- **SRS-01-2**: 우측 패널 `DetectionPanel`은 탭 선택에 관계없이 항상 표시된다
- **SRS-01-3**: 데스크톱(≥768px): 우측 패널 width = 288px, borderLeft; 모바일(<768px): flex `0 0 40%`, borderTop
- **SRS-01-4**: `isMobile` 상태는 `window.resize` 이벤트에서 실시간으로 갱신된다

### FR-02: 하단 탭 구성

- **SRS-02-1**: 하단 탭은 `Camera Events` / `ONVIF Timeline` / `Detections` 세 개로 구성된다
- **SRS-02-2**: 기본 선택 탭은 `ONVIF Timeline`이다
- **SRS-02-3**: 탭별 하단 패널 높이: Events=160px, ONVIF=200px, Detections=300px

### FR-03: AnalysisHistoryTab

- **SRS-03-1**: Detections 탭은 `AnalysisHistoryTab` 컴포넌트를 렌더링한다
- **SRS-03-2**: `AnalysisHistoryTab`은 마운트 시 `GET /api/analysis/events?cameraId=…` 를 호출한다
- **SRS-03-3**: 범위 프리셋 버튼 `1H` / `6H` / `1D` / `1W` / `All`을 제공한다
- **SRS-03-4**: `All` 선택 시 `datetime-local` Start/End 입력 및 Apply 버튼이 표시된다
- **SRS-03-5**: Apply 클릭 시 `from` / `to` 파라미터로 서버 재조회한다
- **SRS-03-6**: 타입 필터 드롭다운 `All Types` / `loitering` / `fire` / `smoke`를 제공한다
- **SRS-03-7**: 서버 조회 중 SVG 스피너를 표시한다
- **SRS-03-8**: 이벤트 행 hover 시 `cropData` 필드가 있으면 썸네일(64×64)을 표시한다
- **SRS-03-9**: ↺ 버튼으로 현재 범위와 필터를 유지하며 재조회한다

### FR-04: OnvifTimelineInline 커스텀 범위

- **SRS-04-1**: `OnvifTimelineInline`은 `1H`/`6H`/`1D`/`1W`/`1M`/`1Y`/`Custom` 범위 버튼을 제공하며 기본값은 `1H`이다
- **SRS-04-2**: `Custom` 선택 시 `datetime-local` Start(From) / End(To) 입력 행이 컨트롤 행 아래에 표시된다
- **SRS-04-3**: `Custom` 상태에서 `customApplied`가 null이면 서버 fetch를 실행하지 않는다
- **SRS-04-4**: Apply 클릭 시 `customApplied = { from, to }` 를 설정하고 fetch를 실행한다
- **SRS-04-5**: fetch URL: `GET /api/onvif-events?cameraId=…&from=…&to=…&limit=1000`
- **SRS-04-6**: Custom 모드의 `viewRangeEnd = new Date(customApplied.to).getTime()` (프리셋: `Date.now()`)
- **SRS-04-7**: 로딩 표시기는 `…` 텍스트 대신 SVG 스피너(`animate-spin`)를 사용한다
- **SRS-04-8**: ✕ 버튼 클릭 시 `customApplied = null`, Start/End 초기화, 전체 이벤트 재조회

### FR-06: Timeline Name 컬럼

#### ONVIF Timeline (`OnvifTimelineOverlay`)

- **SRS-06-1**: `OnvifTimelineOverlay`는 스크롤 가능한 트랙 행 영역 상단에 sticky "Name" 컬럼 헤더 행(높이 22px)을 표시한다
- **SRS-06-2**: 헤더 행의 좌측 구획(width = `ROW_LABEL_W` = 130px)에 "Name" 텍스트를 표시한다
- **SRS-06-3**: `OnvifTimelineOverlay`는 `useCameraStore`에서 `cameraId`에 해당하는 카메라 이름을 조회한다
- **SRS-06-4**: 헤더 카메라 ID 뱃지는 `cameraName`이 존재하면 `cameraName`을, 없으면 `cameraId.slice(0, 8)`을 표시한다

#### Detections Timeline (`DetectionsTimelineInline`)

- **SRS-06-5**: `DetectionsTimelineInline`은 각 트랙 행의 좌측에 `LABEL_W = 100px` 고정 폭 Name 컬럼을 표시한다
- **SRS-06-6**: Name 컬럼 상단에 "Name" sticky 헤더 행(높이 20px)을 표시한다
- **SRS-06-7**: Name 컬럼 각 행은 `className`(classColor 색상, bold), `#objectId_last6`(mono, gray), `identity`(indigo, 있을 때만)를 표시한다
- **SRS-06-8**: 드래그 패닝 너비 계산은 `containerRef.getBoundingClientRect().width - LABEL_W`를 사용한다
- **SRS-06-9**: tick 레이블 strip은 `left: LABEL_W`에서 시작하여 Gantt 영역에만 렌더링된다
- **SRS-06-10**: 스냅샷 필름스트립 `pct` 계산은 `(containerWidth - LABEL_W)`를 기준으로 한다

### FR-05: API 확장 (`GET /api/analysis/events`)

- **SRS-05-1**: `cameraId` 쿼리 파라미터로 특정 카메라 이벤트만 필터링한다
- **SRS-05-2**: `from` ISO 8601 파라미터로 시작 시각(이상) 필터링한다
- **SRS-05-3**: `to` ISO 8601 파라미터로 종료 시각(이하) 필터링한다
- **SRS-05-4**: `limit` 파라미터 최대값을 200 → 500으로 상향한다
- **SRS-05-5**: 이벤트는 `timestamp` 내림차순으로 반환된다

---

## 3. 비기능 요구사항

| ID | 항목 | 기준 |
|----|------|------|
| NFR-01 | TypeScript 컴파일 | `strict` 모드 오류 0 |
| NFR-02 | 반응형 | 768px 기준 데스크톱/모바일 레이아웃 전환 |
| NFR-03 | 빌드 | `npm run build` 1회로 완전 빌드 |
| NFR-04 | 데이터 최신성 | 우측 DetectionPanel은 Socket.IO 실시간 (0ms 지연); AnalysisHistoryTab은 명시적 새로고침 기반 |
| NFR-05 | UX | 로딩 중 스피너 표시로 사용자에게 진행상태 안내 |

---

## 4. 컴포넌트-요구사항 추적 매트릭스

| 요구사항 | 파일 | 라인 범위 |
|---------|------|-----------|
| SRS-01-1~4 | `FullscreenCameraView.tsx` | `FullscreenCameraView` 함수 |
| SRS-02-1~3 | `FullscreenCameraView.tsx` | 탭 바 및 content 조건 렌더링 |
| SRS-03-1~9 | `AnalysisHistoryTab.tsx` | 전체 |
| SRS-04-1~8 | `OnvifTimelineInline.tsx` | 상태, fetch effect, 컨트롤 행 |
| SRS-05-1~5 | `server/src/routes/analysisApi.js` | `GET /api/analysis/events` 핸들러 |
| SRS-06-1~4 | `OnvifTimelineOverlay.tsx` | useCameraStore import, cameraName 조회, Name 헤더 행 |
| SRS-06-5~10 | `DetectionsTimelineInline.tsx` | LABEL_W 상수, Name 컬럼 렌더링, 너비 계산 보정 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — Fullscreen Camera View 탭 확장 SRS |
| 1.1 | 2026-06-24 | SRS-04-1 업데이트 — OnvifTimelineInline 범위 버튼 1H/6H 추가, 기본값 1D → 1H |
| 1.2 | 2026-06-26 | FR-06 추가 — ONVIF·Detections Timeline Name 컬럼 SRS (SRS-06-1~10); 추적 매트릭스 업데이트 |
