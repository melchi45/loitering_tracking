# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Dashboard Analysis Mode UI Adaptation

| | |
|---|---|
| **Document ID** | PRD-LTS-DAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Related Design** | [design/Design_Dashboard_Analysis_Mode.md](../design/Design_Dashboard_Analysis_Mode.md) |
| **Related SRS** | [srs/SRS_Dashboard_Analysis_Mode.md](../srs/SRS_Dashboard_Analysis_Mode.md) |
| **Parent Feature** | [PRD_Distributed_AI_Pipeline.md](PRD_Distributed_AI_Pipeline.md) |

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [User Stories](#5-user-stories)
6. [Technical Requirements](#6-technical-requirements)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)
9. [Related Documents](#9-related-documents)

---

## 1. Product Vision

`SERVER_MODE=analysis`로 실행 중인 분석 서버에 브라우저로 접속할 때, 카메라 스트리밍과 관련된 불필요한 UI 요소를 숨기고 AI 분석 결과 모니터링에 필요한 화면만 표시한다. `/health` 엔드포인트로 서버 모드를 자동 감지하여 별도 사용자 설정 없이 적절한 UI로 전환된다.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- 서버 시작 시 `/health` 응답의 `serverMode` 필드를 통해 운영 모드를 자동 감지
- `analysis` 모드 진입 시 카메라 스트리밍 관련 UI 요소를 완전히 숨김
- `analysis` 모드에서 헤더에 모드 식별 배지("분석 전용 서버")를 표시
- 메인 영역에 분석 서버 상태 패널(소켓 연결 상태, 모드 정보)을 표시
- 사이드바 탭에서 카메라 탭을 제거하고 알림·구역·감지·분석·얼굴 탭만 표시
- `combined` 모드에서는 기존 UI를 100% 그대로 유지
- 15개 언어 i18n 지원

### 2.2 Non-Goals

- analysis 서버에서 카메라 스트림을 직접 표시하는 기능
- 서버 모드 동적 전환 (재시작 없이 모드 변경)
- analysis 서버 실시간 통계 폴링 대시보드 (별도 기능으로 분리)

---

## 3. User Personas

**AI 서버 운영자**
GPU 서버에서 `SERVER_MODE=analysis`로 실행된 분석 서버에 브라우저로 접속하여 알림 현황, 감지 이벤트, 구역 설정 상태를 모니터링한다. 카메라 그리드나 스트림 관련 UI는 불필요하며 혼란을 유발한다.

**시스템 통합 엔지니어**
`streaming` 서버와 `analysis` 서버를 별도 머신에 배포하고, 각 서버의 대시보드에서 역할에 맞는 화면만 보이는지 검증한다. 서버 모드가 헤더에 명확히 표시되어야 한다.

---

## 4. Functional Specification

### 4.1 서버 모드 자동 감지

| 항목 | 설명 |
|---|---|
| **감지 방법** | 브라우저 마운트 시 `GET /health` 호출 |
| **응답 필드** | `serverMode: "combined" \| "streaming" \| "analysis"` |
| **적용 시점** | 페이지 로드 시 1회 |
| **오류 시 동작** | 기본값 `null` 유지 → combined 모드와 동일한 UI 표시 |

### 4.2 헤더 배지 표시

- `serverMode === 'analysis'` 시 앱 타이틀 옆에 amber 색상 배지 표시
- 배지 텍스트: `t('serverModeAnalysis')` (i18n)
- 배지 아이콘: 정보 아이콘 (SVG)

### 4.3 헤더 요소 조건부 숨김 (`analysis` 모드)

| 요소 | 동작 |
|---|---|
| 카메라 수 (`X/Y live`) | 숨김 |
| 레이아웃 피커 | 숨김 |
| 검색 바 | 유지 |
| 통계 버튼 | 유지 |
| 설정 버튼 | 유지 |
| 사용자 메뉴 | 유지 |

### 4.4 메인 영역 — 분석 서버 상태 패널

`analysis` 모드에서 카메라 그리드 대신 중앙 정렬 상태 패널을 표시한다.

**패널 구성:**
- 아이콘 + 모드명 ("분석 전용 서버")
- 설명 텍스트 (`t('serverModeAnalysisDesc')`)
- 소켓 연결 상태 카드 (connected/disconnected)
- 서버 모드 카드 ("analysis")

### 4.5 사이드바 탭 필터링

| 탭 | `combined` | `analysis` |
|---|---|---|
| 카메라 (📷) | 표시 | **숨김** |
| 알림 (🔔) | 표시 | 표시 |
| 구역 (🗺) | 표시 | 표시 |
| 감지목록 (👁) | 표시 | 표시 |
| 분석 (🤖) | 표시 | 표시 |
| 얼굴 인식 (🪪) | 표시 | 표시 |

### 4.6 초기 탭 선택

- `analysis` 모드 감지 시 사이드바 기본 탭을 `cameras` → `alerts`로 자동 전환

### 4.7 모바일 레이아웃 적용

- 카메라 수 표시 제거
- 카메라 탭 스와이프 뷰(그리드 58% + 목록 42%) 제거
- 카메라 탭 항목 하단 내비게이션에서 제거

---

## 5. User Stories

### US-DAM-01: 서버 모드 자동 인식
```
As a AI 서버 운영자,
I want 브라우저에서 분석 서버에 접속할 때
자동으로 분석 모드 UI로 전환되기를 원한다.
So that 별도 설정 없이 역할에 맞는 화면을 볼 수 있다.
```

### US-DAM-02: 불필요한 UI 숨김
```
As a AI 서버 운영자,
I want analysis 모드에서 카메라 그리드와 카메라 탭이 보이지 않기를 원한다.
So that 혼란 없이 알림·감지·구역 정보에 집중할 수 있다.
```

### US-DAM-03: 분석 서버 모드 식별
```
As a 시스템 통합 엔지니어,
I want 헤더에서 현재 서버가 analysis 모드임을 즉시 확인할 수 있기를 원한다.
So that 잘못된 서버에 접속했을 때 빠르게 인식할 수 있다.
```

### US-DAM-04: 분석 관련 기능 유지
```
As a AI 서버 운영자,
I want analysis 모드에서도 알림 확인, 구역 관리, 얼굴 갤러리를 사용할 수 있기를 원한다.
So that 분석 결과를 기반으로 운영 업무를 수행할 수 있다.
```

---

## 6. Technical Requirements

### 6.1 수정 파일

| 파일 | 변경 내용 |
|---|---|
| `server/src/index.js` | `/health` 응답에 `serverMode` 필드 추가 |
| `client/src/App.tsx` | `serverMode` 상태 추가, 조건부 UI 렌더링 |
| `client/src/i18n/translations/en.ts` | `serverModeAnalysis`, `serverModeAnalysisDesc` 키 추가 |
| `client/src/i18n/translations/ko.ts` | 동일 키 한국어 번역 추가 |
| `client/src/i18n/translations/*.ts` | 나머지 13개 언어 파일에 키 추가 |

### 6.2 `/health` 응답 스펙 변경

**Before:**
```json
{ "status": "ok", "uptime": 36.5, "timestamp": "...", "db": "connected" }
```

**After:**
```json
{ "status": "ok", "uptime": 36.5, "timestamp": "...", "db": "connected", "serverMode": "analysis" }
```

### 6.3 하위 호환성

- `serverMode` 필드가 없거나 `null`인 경우 기존 combined UI 동작 유지
- `combined` / `streaming` 모드에서 UI 변경 없음

---

## 7. Acceptance Criteria

### AC-DAM-01: 서버 모드 감지
- [ ] 페이지 로드 시 `/health` API가 호출되고 `serverMode` 필드가 수신됨
- [ ] `serverMode: "analysis"` 수신 시 분석 모드 UI로 전환됨
- [ ] `/health` 호출 실패 시 combined UI로 폴백됨

### AC-DAM-02: 헤더 배지
- [ ] `analysis` 모드에서 타이틀 옆에 amber 배지가 표시됨
- [ ] 배지에 "분석 전용 서버" (ko) / "Analysis Server" (en) 텍스트가 표시됨
- [ ] `combined` 모드에서 배지가 표시되지 않음

### AC-DAM-03: 헤더 요소 숨김
- [ ] `analysis` 모드에서 카메라 수 (`X/Y live`) 표시가 없음
- [ ] `analysis` 모드에서 레이아웃 피커가 없음
- [ ] `combined` 모드에서 두 요소가 정상 표시됨

### AC-DAM-04: 메인 영역 패널
- [ ] `analysis` 모드에서 카메라 그리드가 표시되지 않음
- [ ] `analysis` 모드에서 분석 서버 상태 패널이 중앙에 표시됨
- [ ] 패널에 소켓 연결 상태가 실시간으로 반영됨

### AC-DAM-05: 사이드바 탭
- [ ] `analysis` 모드에서 카메라(📷) 탭이 없음
- [ ] `analysis` 모드에서 알림·구역·감지·분석·얼굴 탭이 정상 동작
- [ ] `analysis` 모드 진입 시 기본 탭이 알림(🔔)으로 설정됨

### AC-DAM-06: 모바일
- [ ] `analysis` 모드 모바일에서 카메라 수 표시 없음
- [ ] `analysis` 모드 모바일에서 하단 내비게이션에 카메라 탭 없음

### AC-DAM-07: i18n
- [ ] 15개 언어 파일에 `serverModeAnalysis`, `serverModeAnalysisDesc` 키 존재
- [ ] 빌드 오류 없이 TypeScript 컴파일 성공

---

## 8. Milestones & TODO

| 단계 | 작업 | 상태 |
|---|---|---|
| M1 | `/health` 엔드포인트에 `serverMode` 추가 | ✅ 완료 |
| M2 | `App.tsx` — `serverMode` 상태 및 `/health` fetch 추가 | ✅ 완료 |
| M3 | i18n 키 (`serverModeAnalysis`, `serverModeAnalysisDesc`) 15개 언어 추가 | ✅ 완료 |
| M4 | 헤더 배지, 헤더 요소 조건부 숨김 구현 | ✅ 완료 |
| M5 | 메인 영역 분석 서버 상태 패널 구현 | ✅ 완료 |
| M6 | 사이드바 탭 필터링 및 초기 탭 전환 구현 | ✅ 완료 |
| M7 | 모바일 레이아웃 적용 | ✅ 완료 |
| M8 | 클라이언트 빌드 검증 (`npm run build`) | ✅ 완료 |

---

## 9. Related Documents

| 문서 | 경로 |
|---|---|
| SRS | [srs/SRS_Dashboard_Analysis_Mode.md](../srs/SRS_Dashboard_Analysis_Mode.md) |
| Design | [design/Design_Dashboard_Analysis_Mode.md](../design/Design_Dashboard_Analysis_Mode.md) |
| TC | [tc/TC_Dashboard_Analysis_Mode.md](../tc/TC_Dashboard_Analysis_Mode.md) |
| 상위 PRD | [prd/PRD_Distributed_AI_Pipeline.md](PRD_Distributed_AI_Pipeline.md) |
| Dashboard Layout | [design/Design_Dashboard_Layout.md](../design/Design_Dashboard_Layout.md) |
