# TEST CASES (TC)
# Dashboard Analysis Mode UI Adaptation

| | |
|---|---|
| **Document ID** | TC-LTS-DAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Parent SRS** | [srs/SRS_Dashboard_Analysis_Mode.md](../srs/SRS_Dashboard_Analysis_Mode.md) |
| **Parent Design** | [design/Design_Dashboard_Analysis_Mode.md](../design/Design_Dashboard_Analysis_Mode.md) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — 서버 모드 감지](#3-test-group-a--서버-모드-감지)
4. [Test Group B — 헤더 UI 조건부 렌더링](#4-test-group-b--헤더-ui-조건부-렌더링)
5. [Test Group C — 메인 영역 분기](#5-test-group-c--메인-영역-분기)
6. [Test Group D — 사이드바 탭 필터링](#6-test-group-d--사이드바-탭-필터링)
7. [Test Group E — 모바일 레이아웃](#7-test-group-e--모바일-레이아웃)
8. [Test Group F — i18n](#8-test-group-f--i18n)
9. [Test Execution Order](#9-test-execution-order)
10. [Pass/Fail Criteria](#10-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|---|---|---|---|
| Unit | `/health` 응답 필드 검증 | Jest + supertest | `test/api/health.test.js` |
| Integration | `serverMode` 수신 후 UI 상태 전환 | React Testing Library | `test/integration/analysisMode.test.js` |
| E2E | 브라우저 전체 흐름 | Playwright | `test/e2e/analysis_mode.test.js` (Phase-3) |

### 1.2 SRS Traceability

| SRS 요구사항 | 테스트 케이스 |
|---|---|
| FR-DAM-001 | TC-A-001 |
| FR-DAM-002 | TC-A-002 |
| FR-DAM-003 | TC-A-003 |
| FR-DAM-004 | TC-A-004 |
| FR-DAM-010 | TC-B-001, TC-B-002 |
| FR-DAM-011 | TC-B-003 |
| FR-DAM-012 | TC-B-004 |
| FR-DAM-013 | TC-B-005 |
| FR-DAM-020 | TC-C-001 |
| FR-DAM-021 | TC-C-002, TC-C-003 |
| FR-DAM-022 | TC-C-004 |
| FR-DAM-030 | TC-D-001 |
| FR-DAM-031 | TC-D-002 |
| FR-DAM-032 | TC-D-003 |
| FR-DAM-040 | TC-E-001 |
| FR-DAM-041 | TC-E-002 |
| FR-DAM-050 | TC-F-001 |
| FR-DAM-051 | TC-F-002 |
| FR-DAM-052 | TC-F-003 |

---

## 2. Test Environment and Prerequisites

| 항목 | 조건 |
|---|---|
| Analysis 서버 | `SERVER_MODE=analysis npm run start` (포트 3443) |
| Combined 서버 | `SERVER_MODE=combined npm run start` (또는 미설정) |
| 브라우저 | Chrome 120+ |
| 뷰포트 (데스크톱) | 1920×1080 |
| 뷰포트 (모바일) | 390×844 (iPhone 14 기준) |

---

## 3. Test Group A — 서버 모드 감지

### TC-A-001: `/health` serverMode 필드 존재
**SRS:** FR-DAM-001

| 항목 | 내용 |
|---|---|
| **목적** | `/health` 응답에 `serverMode` 필드가 포함되는지 확인 |
| **전제 조건** | 서버 실행 중 |
| **입력** | `GET /health` |
| **기대 결과** | 응답 JSON에 `serverMode` 필드가 존재하고 `"combined"`, `"streaming"`, `"analysis"` 중 하나의 값을 가짐 |
| **검증 방법** | `curl -sk https://localhost:3443/health \| jq .serverMode` |

---

### TC-A-002: analysis 서버에서 serverMode 감지
**SRS:** FR-DAM-002

| 항목 | 내용 |
|---|---|
| **목적** | `SERVER_MODE=analysis` 서버의 `/health`에서 클라이언트가 `serverMode`를 올바르게 읽는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis` 서버 실행 |
| **입력** | 브라우저에서 `https://localhost:3443` 접속 |
| **기대 결과** | 페이지 로드 직후 `serverMode` state가 `"analysis"`로 설정됨 (React DevTools 확인) |
| **검증 방법** | 브라우저 DevTools Network 탭에서 `/health` 요청 및 응답 확인, React DevTools로 state 확인 |

---

### TC-A-003: /health 실패 시 폴백
**SRS:** FR-DAM-003

| 항목 | 내용 |
|---|---|
| **목적** | `/health` 호출 실패 시 combined UI가 표시되는지 확인 |
| **전제 조건** | 서버 실행 중, DevTools에서 `/health` 요청을 Block 설정 |
| **입력** | 브라우저에서 페이지 접속 (Network request blocked) |
| **기대 결과** | 분석 서버 배지 없음, 카메라 그리드 표시, 카메라 탭 존재 |
| **검증 방법** | Chrome DevTools → Network → Request Blocking 후 페이지 로드 |

---

### TC-A-004: analysis 모드 초기 탭 전환
**SRS:** FR-DAM-004

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드 감지 후 사이드바 초기 탭이 alerts인지 확인 |
| **전제 조건** | `SERVER_MODE=analysis` 서버 실행 |
| **입력** | 브라우저에서 접속 (localStorage 초기화 후) |
| **기대 결과** | 페이지 로드 후 사이드바에 알림 패널(AlertPanel)이 기본 표시됨 |
| **검증 방법** | 화면 확인 — 카메라 목록이 아닌 알림 목록이 기본 표시 |

---

## 4. Test Group B — 헤더 UI 조건부 렌더링

### TC-B-001: analysis 모드 배지 — 데스크톱
**SRS:** FR-DAM-010

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 헤더 배지가 표시되는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis`, 뷰포트 1920×1080 |
| **기대 결과** | 앱 타이틀("LTS") 옆에 amber 색상 배지와 "분석 전용 서버" / "Analysis Server" 텍스트가 표시됨 |

---

### TC-B-002: combined 모드 배지 미표시
**SRS:** FR-DAM-010

| 항목 | 내용 |
|---|---|
| **목적** | combined 모드에서 분석 서버 배지가 없는지 확인 |
| **전제 조건** | `SERVER_MODE=combined` (또는 미설정) |
| **기대 결과** | 헤더에 amber 배지 없음 |

---

### TC-B-003: analysis 모드 카메라 수 숨김
**SRS:** FR-DAM-011

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 `X/Y live` 카메라 수 표시가 없는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis` |
| **기대 결과** | 헤더에 `live` 텍스트 또는 카메라 수 표시 없음 |

---

### TC-B-004: analysis 모드 레이아웃 피커 숨김
**SRS:** FR-DAM-012

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 레이아웃 선택 드롭다운이 없는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis` |
| **기대 결과** | 헤더에 레이아웃 피커 버튼(`1▾`, `4▾` 등) 없음 |

---

### TC-B-005: analysis 모드 헤더 기능 유지
**SRS:** FR-DAM-013

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 검색·통계·설정·사용자 메뉴가 정상 동작하는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis`, 로그인 상태 |
| **기대 결과** | 검색 바 입력 가능, 통계 버튼 클릭 시 모달 열림, 설정 버튼 동작, 사용자 메뉴 표시 |

---

## 5. Test Group C — 메인 영역 분기

### TC-C-001: analysis 모드 카메라 그리드 미표시
**SRS:** FR-DAM-020

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 카메라 그리드가 렌더링되지 않는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis`, 카메라 등록 있음 |
| **기대 결과** | 메인 영역에 카메라 타일 없음, 페이지 이동 버튼(◄ ►) 없음 |

---

### TC-C-002: 분석 서버 상태 패널 표시
**SRS:** FR-DAM-021

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 상태 패널이 중앙에 표시되는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis` |
| **기대 결과** | 메인 영역 중앙에 amber 아이콘 + "분석 전용 서버" 제목 + 설명 텍스트 표시 |

---

### TC-C-003: 패널 소켓 연결 상태 실시간 반영
**SRS:** FR-DAM-021

| 항목 | 내용 |
|---|---|
| **목적** | 패널의 소켓 상태 카드가 연결 상태를 실시간 반영하는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis`, Socket.IO 연결됨 |
| **입력** | 서버 일시 중단 후 재연결 |
| **기대 결과** | 연결 중 녹색 pulse 표시 → 서버 중단 시 빨간 점으로 변경 → 재연결 시 녹색 복귀 |

---

### TC-C-004: combined 모드 메인 영역 유지
**SRS:** FR-DAM-022

| 항목 | 내용 |
|---|---|
| **목적** | combined 모드에서 카메라 그리드가 정상 표시되는지 확인 |
| **전제 조건** | `SERVER_MODE=combined`, 카메라 2개 이상 등록 |
| **기대 결과** | 카메라 타일 그리드 표시, 레이아웃 전환 동작 |

---

## 6. Test Group D — 사이드바 탭 필터링

### TC-D-001: analysis 모드 카메라 탭 미표시
**SRS:** FR-DAM-030

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 카메라(📷) 탭이 없는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis` |
| **기대 결과** | 사이드바 탭 바에 카메라 탭 아이콘/버튼 없음 |

---

### TC-D-002: analysis 모드 나머지 탭 정상 동작
**SRS:** FR-DAM-031

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드에서 알림·구역·감지·분석·얼굴 탭이 모두 클릭 가능하고 해당 컴포넌트가 렌더링되는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis` |
| **기대 결과** | 각 탭 클릭 시 AlertPanel / ZonesPanel / DashboardDetectionPanel / VideoAnalyticsTab / FaceGalleryTab 렌더링 |

---

### TC-D-003: combined 모드 6개 탭 모두 표시
**SRS:** FR-DAM-032

| 항목 | 내용 |
|---|---|
| **목적** | combined 모드에서 카메라 탭이 포함된 6개 탭이 모두 표시되는지 확인 |
| **전제 조건** | `SERVER_MODE=combined` |
| **기대 결과** | 탭 바에 📷🔔🗺👁🤖🪪 6개 탭 모두 존재 |

---

## 7. Test Group E — 모바일 레이아웃

### TC-E-001: 모바일 카메라 수 미표시 (analysis 모드)
**SRS:** FR-DAM-040

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드 모바일 헤더에서 카메라 수가 없는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis`, 뷰포트 390×844 |
| **기대 결과** | 모바일 헤더에 카메라 수 표시 없음 |

---

### TC-E-002: 모바일 analysis 모드 카메라 탭 제거
**SRS:** FR-DAM-041

| 항목 | 내용 |
|---|---|
| **목적** | analysis 모드 모바일 하단 내비게이션에 카메라 탭이 없고 그리드 뷰가 렌더링되지 않는지 확인 |
| **전제 조건** | `SERVER_MODE=analysis`, 뷰포트 390×844 |
| **기대 결과** | 하단 내비 탭 수: 5개 (cameras 제외), 카메라 그리드 스와이프 영역 없음 |

---

## 8. Test Group F — i18n

### TC-F-001: serverModeAnalysis 키 15개 언어 존재
**SRS:** FR-DAM-050

| 항목 | 내용 |
|---|---|
| **목적** | 모든 언어 파일에 `serverModeAnalysis` 키가 존재하는지 확인 |
| **검증 방법** | `grep -l "serverModeAnalysis" client/src/i18n/translations/*.ts \| wc -l` → 15 |

---

### TC-F-002: serverModeAnalysisDesc 키 15개 언어 존재
**SRS:** FR-DAM-051

| 항목 | 내용 |
|---|---|
| **목적** | 모든 언어 파일에 `serverModeAnalysisDesc` 키가 존재하는지 확인 |
| **검증 방법** | `grep -l "serverModeAnalysisDesc" client/src/i18n/translations/*.ts \| wc -l` → 15 |

---

### TC-F-003: TypeScript 빌드 성공
**SRS:** FR-DAM-052

| 항목 | 내용 |
|---|---|
| **목적** | i18n 키 추가 후 빌드가 오류 없이 성공하는지 확인 |
| **검증 방법** | `cd client && npm run build` → 출력에 `✓ built in` 포함, TypeScript 오류 0 |

---

## 9. Test Execution Order

```
TC-F-003 (빌드 확인) → TC-A-001 → TC-A-002 → TC-A-003 → TC-A-004
→ TC-B-001 → TC-B-002 → TC-B-003 → TC-B-004 → TC-B-005
→ TC-C-001 → TC-C-002 → TC-C-003 → TC-C-004
→ TC-D-001 → TC-D-002 → TC-D-003
→ TC-E-001 → TC-E-002
→ TC-F-001 → TC-F-002
```

---

## 10. Pass/Fail Criteria

### 합격 기준
- 그룹 A ~ F 모든 테스트 케이스 Pass
- TypeScript 빌드 오류 0건
- i18n 키 누락 없음 (15개 언어 파일 × 2 키)

### 차단 결함 (Blocker)
- `serverMode === 'analysis'`임에도 카메라 그리드가 표시되는 경우
- `combined` 모드에서 카메라 탭이 사라지는 경우
- TypeScript 빌드 실패

### 경미한 결함 (Minor)
- 배지 스타일 색상 미세 차이
- 모바일 레이아웃 소폭 정렬 차이
