# PRD: Fullscreen Camera View — 탭 확장 & 이력 데이터 통합

**Version:** 1.0
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

`[1D][1W][1M][1Y][Custom]` — Custom 선택 시 날짜 입력 행 추가 노출:

```
From [datetime-local]  To [datetime-local]  [Apply]  [✕]
```

Apply 클릭 전까지 fetch 없음. Apply 클릭 시 지정 범위로 `GET /api/onvif-events?from=…&to=…&limit=1000` 실행.

### 3.4 API 확장 (`/api/analysis/events`)

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
