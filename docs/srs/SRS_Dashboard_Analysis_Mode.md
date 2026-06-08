# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Dashboard Analysis Mode UI Adaptation

| | |
|---|---|
| **Document ID** | SRS-LTS-DAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Parent PRD** | [prd/PRD_Dashboard_Analysis_Mode.md](../prd/PRD_Dashboard_Analysis_Mode.md) |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — 서버 모드 감지](#3-functional-requirements--서버-모드-감지)
4. [Functional Requirements — 헤더 UI 조건부 렌더링](#4-functional-requirements--헤더-ui-조건부-렌더링)
5. [Functional Requirements — 메인 영역 분기](#5-functional-requirements--메인-영역-분기)
6. [Functional Requirements — 사이드바 탭 필터링](#6-functional-requirements--사이드바-탭-필터링)
7. [Functional Requirements — 모바일 레이아웃](#7-functional-requirements--모바일-레이아웃)
8. [Functional Requirements — i18n](#8-functional-requirements--i18n)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements — API 변경](#10-interface-requirements--api-변경)
11. [SRS-TC Traceability Matrix](#11-srs-tc-traceability-matrix)

---

## 1. Introduction

### 1.1 Purpose

이 SRS는 LTS-2026 Dashboard의 Analysis Mode UI Adaptation 기능에 대한 검증 가능한 기능 요구사항을 정의합니다. 각 요구사항은 고유한 `FR-DAM-NNN` ID로 식별되며 TC_Dashboard_Analysis_Mode.md의 테스트 케이스로 추적됩니다.

### 1.2 Scope

- `GET /health` 응답에 `serverMode` 필드 노출
- 클라이언트의 서버 모드 자동 감지 및 UI 조건부 렌더링
- `analysis` 모드 전용 헤더 배지, 메인 영역 패널, 사이드바 탭 구성
- 15개 언어 i18n 키 추가

범위 외: 서버 모드 동적 전환, analysis 서버 성능 통계 실시간 폴링

### 1.3 Definitions

| 용어 | 정의 |
|---|---|
| `combined` 모드 | 카메라 캡처와 AI 추론을 단일 서버에서 수행 (기본값) |
| `analysis` 모드 | AI 추론 전용 서버. 카메라 캡처 없음 |
| `streaming` 모드 | 카메라 캡처 전용 서버. AI 추론을 외부 analysis 서버에 위임 |
| `isAnalysis` | `serverMode === 'analysis'` 조건을 나타내는 React 파생 변수 |

---

## 2. System Overview

브라우저 Dashboard(`App.tsx`)는 마운트 시 `GET /health`를 호출하여 `serverMode` 필드를 읽는다. `serverMode === 'analysis'`인 경우 `isAnalysis = true`로 설정하고 해당 조건에 따라 UI 요소를 조건부 렌더링한다. 서버 재시작 없이는 모드가 변경되지 않으므로 마운트 1회 호출로 충분하다.

```
Browser mount
    │
    ▼
GET /health
    │ { serverMode: "analysis" }
    ▼
setServerMode("analysis")
setSidebarTab("alerts")   ← cameras → alerts
    │
    ▼
isAnalysis = true
    │
    ├── 헤더 배지 표시
    ├── 카메라 수 / 레이아웃 피커 숨김
    ├── 메인 영역 → AnalysisServerPanel
    └── TAB_ITEMS에서 cameras 탭 제거
```

---

## 3. Functional Requirements — 서버 모드 감지

### FR-DAM-001: `/health` serverMode 노출
서버는 `GET /health` 응답 JSON에 `serverMode` 필드를 포함해야 한다.

- 허용값: `"combined"`, `"streaming"`, `"analysis"`
- 기본값: `"combined"` (`SERVER_MODE` 환경변수 미설정 시)

```json
{
  "status": "ok",
  "uptime": 36.5,
  "timestamp": "2026-06-08T00:00:00.000Z",
  "db": "connected",
  "serverMode": "analysis"
}
```

### FR-DAM-002: 클라이언트 마운트 시 모드 감지
`Dashboard` 컴포넌트는 마운트 시(`useEffect([], [])`) `GET /health`를 1회 호출하고, 응답의 `serverMode` 값을 `serverMode` state에 저장해야 한다.

### FR-DAM-003: 감지 실패 시 폴백
`GET /health` 호출이 실패하거나 `serverMode` 필드가 없으면 `serverMode`는 `null`로 유지되고 combined 모드와 동일한 UI를 렌더링해야 한다.

### FR-DAM-004: analysis 모드 초기 탭 전환
`serverMode === 'analysis'` 감지 시 `sidebarTab` 상태를 `'alerts'`로 설정해야 한다. (기본값 `'cameras'`에서 전환)

---

## 4. Functional Requirements — 헤더 UI 조건부 렌더링

### FR-DAM-010: analysis 모드 배지 표시
`isAnalysis === true`인 경우 데스크톱 및 모바일 헤더 타이틀 옆에 amber 색상 배지를 표시해야 한다.

- 배지 내용: 정보 아이콘 + `t('serverModeAnalysis')` 텍스트 (데스크톱)
- 배지 내용: `t('serverModeAnalysis')` 텍스트 (모바일, 아이콘 제거)
- `isAnalysis === false`인 경우 배지를 렌더링하지 않아야 한다.

### FR-DAM-011: 카메라 수 숨김
`isAnalysis === true`인 경우 데스크톱 및 모바일 헤더의 카메라 수 표시(`X/Y live`)를 숨겨야 한다.

### FR-DAM-012: 레이아웃 피커 숨김
`isAnalysis === true`인 경우 데스크톱 헤더의 레이아웃 피커(`LayoutPicker`) 컴포넌트를 렌더링하지 않아야 한다.

### FR-DAM-013: 헤더 기능 유지
`isAnalysis === true`인 경우에도 검색 바, 통계 버튼, 설정 버튼, 사용자 메뉴는 그대로 표시해야 한다.

---

## 5. Functional Requirements — 메인 영역 분기

### FR-DAM-020: analysis 모드 메인 영역 전환
`isAnalysis === true`인 경우 데스크톱 메인 영역(`<main>`)에서 카메라 그리드(`CameraGrid`), 페이지 이동 버튼, `DiscoveredCameraPanel`을 렌더링하지 않아야 한다.

### FR-DAM-021: 분석 서버 상태 패널 표시
`isAnalysis === true`인 경우 메인 영역에 `AnalysisServerPanel` 인라인 컴포넌트를 렌더링해야 한다.

**패널 필수 요소:**
- amber 아이콘 및 `t('serverModeAnalysis')` 제목
- `t('serverModeAnalysisDesc')` 설명 텍스트
- 소켓 연결 상태 카드 (`connected` 변수 기반 실시간 반영)
- 서버 모드 카드 (`"analysis"` 고정 텍스트)

### FR-DAM-022: combined 모드 메인 영역 유지
`isAnalysis === false`인 경우 기존 카메라 그리드, 페이지 이동 버튼, `DiscoveredCameraPanel` 동작이 변경되지 않아야 한다.

---

## 6. Functional Requirements — 사이드바 탭 필터링

### FR-DAM-030: analysis 모드 카메라 탭 제거
`isAnalysis === true`인 경우 `TAB_ITEMS` 배열에서 `id === 'cameras'` 항목을 제외해야 한다.

데스크톱 사이드바 탭 바 및 모바일 하단 내비게이션 바 모두 적용된다.

### FR-DAM-031: analysis 모드 유지 탭
`isAnalysis === true`인 경우 다음 탭은 변경 없이 유지되어야 한다:
`alerts`, `zones`, `detections`, `analytics`, `faces`

### FR-DAM-032: combined 모드 탭 유지
`isAnalysis === false`인 경우 기존 6개 탭(`cameras`, `alerts`, `zones`, `detections`, `analytics`, `faces`) 모두 표시되어야 한다.

---

## 7. Functional Requirements — 모바일 레이아웃

### FR-DAM-040: 모바일 카메라 수 숨김
`isAnalysis === true`인 경우 모바일 헤더의 카메라 수 표시를 렌더링하지 않아야 한다.

### FR-DAM-041: 모바일 카메라 탭 콘텐츠 제거
`isAnalysis === true`인 경우 모바일 콘텐츠 영역에서 카메라 그리드+목록 스와이프 뷰 분기를 진입하지 않아야 한다. 모든 탭은 풀스크린 탭 콘텐츠로 렌더링된다.

---

## 8. Functional Requirements — i18n

### FR-DAM-050: serverModeAnalysis 키 추가
15개 언어 파일(`en`, `ko`, `ar`, `de`, `es`, `fr`, `hi`, `id`, `ja`, `pt`, `ru`, `tr`, `vi`, `zh-CN`, `zh-TW`) 모두에 `serverModeAnalysis` 키가 존재해야 한다.

- `en`: `"Analysis Server"`
- `ko`: `"분석 전용 서버"`

### FR-DAM-051: serverModeAnalysisDesc 키 추가
15개 언어 파일 모두에 `serverModeAnalysisDesc` 키가 존재해야 한다.

- `en`: `"This server processes AI inference only. Camera streams are managed by a separate streaming server."`
- `ko`: `"이 서버는 AI 추론만 처리합니다. 카메라 스트림은 별도의 스트리밍 서버에서 관리됩니다."`

### FR-DAM-052: TypeScript 빌드 오류 없음
i18n 파일 변경 후 `npm run build`가 TypeScript 타입 오류 없이 성공해야 한다.

---

## 9. Non-Functional Requirements

### NFR-DAM-001: 성능
`/health` 호출은 페이지 최초 로드 시 1회만 수행되어야 한다. 폴링(주기적 재호출)을 하지 않는다.

### NFR-DAM-002: 하위 호환성
`serverMode` 필드 추가로 인해 `/health` 응답의 기존 필드(`status`, `uptime`, `timestamp`, `db`)가 변경되지 않아야 한다.

### NFR-DAM-003: 렌더링 지연
`/health` 응답이 오기 전까지 (`serverMode === null`) 기존 combined UI가 표시되어야 한다. 응답 수신 후 조건부 렌더링이 즉시 적용되어야 한다.

---

## 10. Interface Requirements — API 변경

### `GET /health` 응답 스펙

| 필드 | 타입 | 설명 |
|---|---|---|
| `status` | `string` | 서버 상태 ("ok") |
| `uptime` | `number` | 프로세스 업타임 (초) |
| `timestamp` | `string` | ISO 8601 날짜 |
| `db` | `string` | DB 연결 상태 |
| `serverMode` *(신규)* | `string` | 서버 운영 모드 ("combined" \| "streaming" \| "analysis") |

---

## 11. SRS-TC Traceability Matrix

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
