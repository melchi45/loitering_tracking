# RFP: Fullscreen Camera View — 탭 확장 & 이력 데이터 통합

**Version:** 1.0
**Status:** Fulfilled
**SDLC:** [PRD](../prd/PRD_Fullscreen_Camera_View.md) · [SRS](../srs/SRS_Fullscreen_Camera_View.md) · [Design](../design/Design_Fullscreen_Camera_View.md) · [TC](../tc/TC_Fullscreen_Camera_View.md)

---

## 1. 배경 및 목적

LTS-2026의 메인 대시보드에서 카메라를 선택하면 전체화면 오버레이(FullscreenCameraView)가 표시됩니다.
현재 구현은 우측에 항상 표시되는 실시간 AI 감지 패널(DetectionPanel)과 두 개의 하단 탭(Camera Events / ONVIF Timeline)으로 구성되어 있습니다.

운영자 요구사항:
1. **ONVIF 이벤트 이력 조회**: 서버 재시작 후에도 과거 ONVIF 이벤트가 표시되어야 함 (현재는 기본 1D 범위만 적용)
2. **커스텀 날짜 범위**: 프리셋(1D/1W/1M/1Y) 외에 임의 Start/End 날짜를 지정해 이벤트 검색
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
| 기존 컴포넌트 수정 | `client/src/components/OnvifTimelineInline.tsx` |
| 클라이언트 빌드 | `client/dist/` |
| SDLC 문서 | PRD · SRS · Design · TC |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — Fullscreen Camera View 탭 확장 및 이력 데이터 통합 RFP |
