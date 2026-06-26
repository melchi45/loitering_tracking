# RFP: Fullscreen Camera View — 탭 확장 & 이력 데이터 통합

**Version:** 1.4
**Status:** Fulfilled
**SDLC:** [PRD](../prd/PRD_Fullscreen_Camera_View.md) · [SRS](../srs/SRS_Fullscreen_Camera_View.md) · [Design](../design/Design_Fullscreen_Camera_View.md) · [TC](../tc/TC_Fullscreen_Camera_View.md)

---

## 1. 배경 및 목적

LTS-2026의 메인 대시보드에서 카메라를 선택하면 전체화면 오버레이(FullscreenCameraView)가 표시됩니다.
현재 구현은 우측에 항상 표시되는 실시간 AI 감지 패널(DetectionPanel)과 두 개의 하단 탭(Camera Events / ONVIF Timeline)으로 구성되어 있습니다.

운영자 요구사항:
1. **ONVIF 이벤트 이력 조회**: 서버 재시작 후에도 과거 ONVIF 이벤트가 표시되어야 함 (기본 범위 1H, 프리셋 1H/6H/1D/1W/1M/1Y)
2. **커스텀 날짜 범위**: 프리셋 외에 임의 Start/End 날짜를 지정해 이벤트 검색
3. **분석 이벤트 이력 탭**: 저장된 AI 감지 이벤트(loitering/fire/smoke)를 별도 탭에서 조회
4. **실시간 감지 유지**: 우측 DetectionPanel은 항상 보이며 실시간 데이터를 표시

---

## 2. 요구사항 범위

### 2.1 포함 범위 (In Scope)

| 번호 | 기능 |
|------|------|
| REQ-01 | FullscreenCameraView에 세 번째 하단 탭 "Detections" 추가 |
| REQ-02 | 하단 Detections 탭은 서버 저장 분석 이벤트(`/api/analysis/events`) 이력 표시 |
| REQ-03 | 우측 DetectionPanel은 기존 위치를 유지하며 실시간 Socket.IO 데이터 표시 |
| REQ-04 | ONVIF Timeline에 Custom 날짜 범위 입력(Start/End) 기능 추가 |
| REQ-05 | 서버 데이터 조회 중 로딩 표시기(스피너) 표시 |
| REQ-06 | `/api/analysis/events`에 `cameraId`, `from`, `to` 필터 파라미터 추가 |
| REQ-07 | 분석 이벤트 조회 limit 상한 500으로 상향 |
| REQ-08 | ONVIF Timeline 및 Detections Timeline 각 행 좌측에 고정 폭 Name 컬럼 표시 (이벤트 유형·객체 클래스·식별자·identity 포함) |
| REQ-09 | ONVIF Timeline 헤더 카메라 ID 뱃지를 카메라 표시 이름(displayName)으로 우선 표시 |
| REQ-10 | `DetectionsTimelineInline` 상단에 Overview strip(50px) 추가 — 뷰포트 내 전체 트랙을 클래스별 미니 바(8px)로 오버레이 표시, 스크롤=줌 인터랙션, 클릭=Detail rows 접기/펼치기 토글 |
| REQ-11 | `OnvifTimelineInline` 도 동일한 2-panel 구조 적용 — Overview strip에 모든 이벤트 타입 오버레이 (point 이벤트=2px 수직 바, duration=8px 미니 바), Tick 레이블 항상 표시 |

### 2.2 제외 범위 (Out of Scope)

- ONVIF 이벤트 편집/삭제 UI
- 분석 이벤트 알림 통지 기능
- DetectionPanel의 레이아웃 변경

---

## 3. 기술 제약

- 서버: Node.js CommonJS (`server/src/routes/analysisApi.js`)
- 클라이언트: React 18 + TypeScript + Tailwind CSS + Zustand
- 클라이언트 빌드: Vite — `client/dist/` 정적 파일로 서빙 (HMR 없음)
- 빌드 명령: `cd client && npm run build`
- 기존 ONVIF Timeline 컴포넌트 (`OnvifTimelineInline.tsx`) 재사용

---

## 4. 납품물

| 납품물 | 파일 |
|--------|------|
| 서버 API 확장 | `server/src/routes/analysisApi.js` |
| 신규 컴포넌트 | `client/src/components/AnalysisHistoryTab.tsx` |
| 기존 컴포넌트 수정 | `client/src/components/FullscreenCameraView.tsx` |
| 기존 컴포넌트 수정 | `client/src/components/OnvifTimelineInline.tsx` (Name 컬럼 + OnvifRow.sourceToken/ruleName 독립 저장) |
| 기존 컴포넌트 수정 | `client/src/components/OnvifTimelineOverlay.tsx` (Name 컬럼 헤더 + cameraName 표시) |
| 기존 컴포넌트 수정 | `client/src/components/DetectionsTimelineInline.tsx` (Name 컬럼 + 2-panel Overview strip + showDetail 토글 + ResizeObserver) |
| 기존 컴포넌트 수정 | `client/src/components/OnvifTimelineInline.tsx` (2-panel Overview strip + showDetail 토글) |
| 클라이언트 빌드 | `client/dist/` |
| SDLC 문서 | PRD · SRS · Design · TC |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — Fullscreen Camera View 탭 확장 및 이력 데이터 통합 RFP |
| 1.1 | 2026-06-24 | 범위 프리셋 `1H`/`6H` 추가 반영 — 기본 범위 1D → 1H 업데이트; REQ 설명 수정 |
| 1.2 | 2026-06-26 | REQ-08/09 추가 — ONVIF·Detections Timeline 좌측 Name 컬럼 및 cameraName 표시 요구사항 |
| 1.3 | 2026-06-26 | §4 납품물 `OnvifTimelineInline.tsx` 설명에 Name 컬럼 + OnvifRow 독립 저장 명시 — 누락 보완 |
| 1.4 | 2026-06-26 | REQ-10~11 추가 — Detections·ONVIF Timeline 2-panel Overview strip + Detail rows 접기/펼치기 토글 요구사항; §4 납품물 업데이트 |
