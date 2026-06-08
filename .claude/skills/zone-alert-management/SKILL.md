---
name: zone-alert-management
description: "LTS-2026 보안 구역 설정 및 알림 관리. Use when: 침입 감지 구역 생성/수정/삭제, 구역별 배회 임계값 설정, 알림 규칙(시간대·요일·우선순위) 구성, 알림 확인(acknowledge) 처리, 구역 다각형 좌표 편집, 알림 에스컬레이션 정책 설정, 사이드바 구역·알림 UI 수정, 대시보드 알림 필터링. Covers: zoneManager.js, alertService.js, Dashboard sidebar zones/alerts components."
argument-hint: "구역 이름 또는 알림 규칙 유형 (예: restricted-zone, loitering-alert)"
---

# Zone & Alert Management

## 구조 개요

```
구역 설정 (Polygon 좌표)
  └─► zoneManager.js  ─── 구역별 임계값·스케줄 관리
        └─► behaviorEngine.js  ─── 구역 내 배회 점수 산출
              └─► alertService.js  ─── 알림 생성·에스컬레이션
                    └─► WebSocket broadcast  ─── 대시보드 실시간 표시
                          └─► MongoDB alerts 컬렉션  ─── 영구 저장
```

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `server/src/services/zoneManager.js` | 구역 CRUD, 다각형 좌표, 임계값 저장 |
| `server/src/services/alertService.js` | 알림 생성, 에스컬레이션, acknowledge |
| `server/src/services/behaviorEngine.js` | 구역 내 배회 점수 계산 |
| `storage/lts.json` | 구역·임계값 로컬 파일 스토리지 (MongoDB 미사용 시) |
| `client/src/components/` | 사이드바 구역·알림 UI 컴포넌트 |

## 주요 작업 절차

### 새 구역 생성
1. 대시보드에서 카메라 뷰 위에 다각형 좌표 지정 (UI) 또는 API 호출:
   ```http
   POST /api/zones
   Content-Type: application/json

   {
     "name": "정문 출입구",
     "cameraId": "cam_01",
     "polygon": [[10,20],[200,20],[200,300],[10,300]],
     "loiteringThreshold": 45,
     "schedule": {
       "enabled": true,
       "weekdays": [1,2,3,4,5],
       "startTime": "09:00",
       "endTime": "18:00"
     },
     "priority": "high"
   }
   ```
2. `server/src/services/zoneManager.js`에서 구역 유효성 검사 로직 확인
3. 저장 후 `GET /api/zones` 로 등록 확인

### 구역 임계값 수정
```http
PATCH /api/zones/:id
{ "loiteringThreshold": 60, "priority": "critical" }
```
- MCP 도구 사용 시: `mcp_lts_update_zone_threshold`

### 알림 확인(Acknowledge) 처리
```http
PATCH /api/alerts/:id/acknowledge
{ "acknowledgedBy": "operator_id", "note": "현장 확인 완료" }
```
- MCP 도구 사용 시: `mcp_lts_acknowledge_alert`
- WebSocket 이벤트 `alert:acknowledged` 브로드캐스트 확인

### 알림 에스컬레이션 정책 구성
1. `server/src/services/alertService.js`의 에스컬레이션 규칙 수정:
   ```js
   // 미확인 알림 n분 경과 시 에스컬레이션
   escalationRules: [
     { delayMinutes: 5, action: 'notify_supervisor' },
     { delayMinutes: 15, action: 'notify_manager' }
   ]
   ```
2. 알림 수신 채널(이메일·Webhook) 설정 확인

### 구역 다각형 UI 편집
1. `client/src/components/` 구역 편집기 컴포넌트 확인
2. Canvas 또는 SVG 오버레이 좌표 정규화 (카메라 해상도 기준)
3. 좌표 저장 API 연동: `PUT /api/zones/:id`

## 알림 우선순위 및 상태

| 우선순위 | 색상 | 배회 임계값 |
|---|---|---|
| `low` | 파란색 | 60초 이상 |
| `medium` | 노란색 | 30–60초 |
| `high` | 주황색 | 15–30초 |
| `critical` | 빨간색 | 15초 미만 |

| 상태 | 설명 |
|---|---|
| `active` | 진행 중 미확인 |
| `acknowledged` | 운영자 확인 완료 |
| `resolved` | 자동 또는 수동 해제 |

## 관련 MCP 도구
- `mcp_lts_get_zone_config` — 구역 설정 조회
- `mcp_lts_update_zone_threshold` — 임계값 수정
- `mcp_lts_get_active_alerts` — 활성 알림 조회
- `mcp_lts_acknowledge_alert` — 알림 확인 처리
- `mcp_lts_query_loitering_events` — 배회 이벤트 조회

## 관련 문서 (SDLC 참조)

> 구현·수정 전 아래 문서를 확인하고, **코드 변경 시 해당 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_LTS2026_Loitering_Tracking_System](../../../docs/rfp/RFP_LTS2026_Loitering_Tracking_System.md) · [RFP_Dashboard_Sidebar_Alerts_Zones](../../../docs/rfp/RFP_Dashboard_Sidebar_Alerts_Zones.md) |
| PRD | [PRD_LTS2026_Loitering_Tracking_System](../../../docs/prd/PRD_LTS2026_Loitering_Tracking_System.md) · [PRD_Dashboard_Sidebar_Alerts_Zones](../../../docs/prd/PRD_Dashboard_Sidebar_Alerts_Zones.md) |
| SRS | [SRS_LTS2026_Loitering_Tracking_System](../../../docs/srs/SRS_LTS2026_Loitering_Tracking_System.md) · [SRS_Dashboard_Sidebar_Alerts_Zones](../../../docs/srs/SRS_Dashboard_Sidebar_Alerts_Zones.md) |
| Design | [Design_Dashboard_Sidebar_Alerts_Zones](../../../docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md) · [Design_LTS2026_Loitering_Tracking_System](../../../docs/design/Design_LTS2026_Loitering_Tracking_System.md) |
| TC | [TC_LTS2026_Loitering_Tracking_System](../../../docs/tc/TC_LTS2026_Loitering_Tracking_System.md) · [TC_Dashboard_Sidebar_Alerts_Zones](../../../docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md) |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `zoneManager.js` (구역 CRUD·다각형) | `docs/design/Design_LTS2026_Loitering_Tracking_System.md`, `docs/srs/SRS_LTS2026_Loitering_Tracking_System.md`, `docs/tc/TC_LTS2026_Loitering_Tracking_System.md` |
| `alertService.js` (알림 생성·에스컬레이션) | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/srs/SRS_LTS2026_Loitering_Tracking_System.md`, `docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md` |
| `behaviorEngine.js` (배회 점수 로직) | `docs/design/Design_LTS2026_Loitering_Tracking_System.md`, `docs/srs/SRS_LTS2026_Loitering_Tracking_System.md` |
| `client/…/ZonesPanel.tsx`, `ZoneEditor.tsx` | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md` |
| 알림 우선순위·임계값 기준 변경 | `docs/srs/SRS_LTS2026_Loitering_Tracking_System.md` (요구사항 표 반영) + TC 경계값 업데이트 |
| 에스컬레이션 정책 변경 | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md` 에스컬레이션 시퀀스 다이어그램 업데이트 |

**공통 규칙**
- **새 알림 유형 추가** → PRD + SRS + Design + TC 문서 모두 해당 유형 항목 추가
- **구역 스키마 변경** → SRS 데이터 모델 섹션 + Design API 명세 + TC 업데이트
- **에스컬레이션 정책 변경** → Design 시퀀스 다이어그램 + SRS 비기능 요구사항 반영
- **MCP 도구 동작 변경** → `docs/design/Design_LLM_MCP_Server.md` 도구 목록 업데이트
