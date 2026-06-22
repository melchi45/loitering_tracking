---
name: react-dashboard-dev
description: "LTS-2026 React/TypeScript 대시보드 UI 개발. Use when: 대시보드 컴포넌트 추가/수정, Zustand 스토어 상태 관리, WebSocket 실시간 이벤트 수신, Tailwind CSS 스타일링, 카메라 그리드 뷰 수정, 알림 패널 UI 개선, 구역 편집기 수정, i18n 다국어 텍스트 추가, 검색 UI 구현, 모바일 반응형 레이아웃 조정, Vite 빌드 오류 수정. Covers: client/src/ React components, Zustand stores, hooks, i18n, Vite, Tailwind."
argument-hint: "수정할 UI 영역 (예: camera-grid, alert-panel, zone-editor, face-gallery)"
---

# React Dashboard Development

## 클라이언트 아키텍처

```
client/src/
├── App.tsx                 — 라우팅 루트, 글로벌 레이아웃 (admin role gate 포함)
├── pages/
│   ├── SignInPage.tsx       — 로그인 (MSAL / 로컬 인증)
│   ├── PendingPage.tsx      — 승인 대기 화면
│   ├── AccessDeniedPage.tsx — admin 외 역할 접근 차단
│   └── admin/              — 관리자 페이지
├── components/
│   ├── CameraGrid.tsx       — 다중 카메라 타일 그리드
│   ├── CameraView.tsx       — 단일 카메라 WebRTC 뷰 + 오버레이
│   ├── AlertPanel.tsx       — 실시간 알림 목록
│   ├── ZonesPanel.tsx       — 구역 목록 사이드바
│   ├── ZoneEditor.tsx       — 캔버스 기반 구역 다각형 편집
│   ├── FaceGalleryTab.tsx   — 등록 얼굴 갤러리
│   ├── SearchFullscreen.tsx — 전체화면 감지 검색
│   ├── StatsPanelModal.tsx  — 분석 통계 모달
│   ├── DashboardDetectionPanel.tsx — 실시간 감지 피드 (combined/streaming + analysis 모드 오버레이)
│   ├── AnalysisServerDashboard.tsx — analysis 모드 메인 대시보드 (stat 카드·오버레이 제어)
│   ├── AnalysisLivePanel.tsx       — 실시간 감지 피드 오버레이 (analysis 모드, "감지 이벤트" 카드)
│   ├── AnalysisDetectionPanel.tsx  — 이벤트 히스토리 오버레이 (analysisEvents DB, "알림" 카드)
│   ├── AnalysisEventsTab.tsx       — Detections 탭 이벤트 히스토리 (analysis 모드)
│   ├── AnalysisHistoryTab.tsx      — 저장된 분석 이벤트 이력 (레거시 — FullscreenCameraView에서 미사용)
│   ├── OnvifTimelineInline.tsx     — ONVIF 이벤트 Gantt 타임라인 + 커스텀 날짜 범위 (FullscreenCameraView ONVIF 탭)
│   ├── DetectionsTimelineInline.tsx — ByteTracker 트랙 Gantt 타임라인 (FullscreenCameraView Detections 탭)
│   └── FullscreenCameraView.tsx    — 전체화면 카메라 뷰 (3탭: Camera Events / ONVIF Timeline / Detections)
├── stores/                 — Zustand 상태 스토어
├── hooks/                  — 커스텀 훅
└── i18n/                   — 다국어 리소스
```

## Zustand 스토어 목록

| 스토어 | 관리 상태 |
|---|---|
| `cameraStore.ts` | 카메라 목록, 연결 상태, 활성 스트림 |
| `alertStore.ts` | 활성 알림, 필터, acknowledge 상태 |
| `crossCameraStore.ts` | 크로스 카메라 추적 동선 데이터 |
| `discoveryStore.ts` | ONVIF 탐색 결과 |
| `personTrajectoryStore.ts` | 인물 이동 궤적 히스토리 |
| `authStore.ts` | 사용자 인증 상태, 토큰 |
| `webrtcConfigStore.ts` | ICE/STUN/TURN 설정 |
| `dataChannelStore.ts` | WebRTC DataChannel App RTP 메시지 (messages · counts · history) |
| `onvifEventStore.ts` | ONVIF 이벤트 목록 + 타입 레지스트리 (events: pushEvent·setEvents·clearAll / types: setTypes·addType·clearTypes) |

## 주요 작업 절차

### 새 컴포넌트 추가
1. `client/src/components/` 에 `.tsx` 파일 생성
2. Tailwind CSS 클래스로 스타일링 (별도 CSS 파일 불필요)
3. 필요한 Zustand 스토어 import 및 훅 사용
4. `App.tsx` 또는 부모 컴포넌트에 등록

### WebSocket 실시간 이벤트 수신
```tsx
// 커스텀 훅 패턴 (client/src/hooks/)
import { useEffect } from 'react';
import { useAlertStore } from '../stores/alertStore';

export function useAlertSocket(socket: Socket) {
  const addAlert = useAlertStore(s => s.addAlert);
  useEffect(() => {
    socket.on('alert:new', (alert) => addAlert(alert));
    socket.on('alert:acknowledged', (id) => useAlertStore.getState().acknowledge(id));
    return () => { socket.off('alert:new'); socket.off('alert:acknowledged'); };
  }, [socket]);
}
```

### i18n 텍스트 추가
1. `client/src/i18n/` 폴더의 언어 파일 열기 (`ko.json`, `en.json` 등)
2. 새 키-값 쌍 추가:
   ```json
   { "zone.loiteringAlert": "배회 감지 알림" }
   ```
3. 컴포넌트에서 사용:
   ```tsx
   import { useTranslation } from 'react-i18next';
   const { t } = useTranslation();
   <span>{t('zone.loiteringAlert')}</span>
   ```

### Tailwind 커스텀 스타일
- 설정 파일: `client/tailwind.config.js`
- 커스텀 색상·브레이크포인트 추가 시 `theme.extend` 섹션 수정
- 다크모드: `dark:` 접두어 클래스 사용

### 카메라 그리드 레이아웃 수정
1. `client/src/components/CameraGrid.tsx` 열기
2. 그리드 열 수 변경: `grid-cols-2`, `grid-cols-3`, `grid-cols-4`
3. 반응형: `sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-4`

### 개발 서버 실행
```bash
cd client
npm run dev          # Vite dev server (기본 포트 3080)
npm run build        # 프로덕션 빌드
npm run preview      # 빌드 결과 미리보기
```

## TypeScript 타입 위치
- `client/src/types/` — 감지 결과, 알림, 카메라, 구역 등 공통 타입
- 서버 API 응답 타입은 이 폴더에서 정의 후 컴포넌트에서 import

## 관련 문서 (SDLC 참조)

> 구현·수정 전 아래 문서를 확인하고, **코드 변경 시 해당 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_Dashboard_Layout](../../../docs/rfp/RFP_Dashboard_Layout.md) · [RFP_Dashboard_Detection_Display](../../../docs/rfp/RFP_Dashboard_Detection_Display.md) · [RFP_Dashboard_Sidebar_Cameras](../../../docs/rfp/RFP_Dashboard_Sidebar_Cameras.md) · [RFP_Dashboard_Sidebar_Alerts_Zones](../../../docs/rfp/RFP_Dashboard_Sidebar_Alerts_Zones.md) |
| RFP | [RFP_Dashboard_Sidebar_Face_ID](../../../docs/rfp/RFP_Dashboard_Sidebar_Face_ID.md) · [RFP_Mobile_Layout](../../../docs/rfp/RFP_Mobile_Layout.md) · [RFP_Stats_Panel](../../../docs/rfp/RFP_Stats_Panel.md) · [RFP_Detection_Snapshot_Search](../../../docs/rfp/RFP_Detection_Snapshot_Search.md) |
| PRD | [PRD_Dashboard_Layout](../../../docs/prd/PRD_Dashboard_Layout.md) · [PRD_Dashboard_Detection_Display](../../../docs/prd/PRD_Dashboard_Detection_Display.md) · [PRD_Dashboard_Sidebar_Cameras](../../../docs/prd/PRD_Dashboard_Sidebar_Cameras.md) |
| PRD | [PRD_Dashboard_Sidebar_Alerts_Zones](../../../docs/prd/PRD_Dashboard_Sidebar_Alerts_Zones.md) · [PRD_Dashboard_Sidebar_Face_ID](../../../docs/prd/PRD_Dashboard_Sidebar_Face_ID.md) · [PRD_Dashboard_Search_Fullscreen](../../../docs/prd/PRD_Dashboard_Search_Fullscreen.md) · [PRD_Mobile_Layout](../../../docs/prd/PRD_Mobile_Layout.md) · [PRD_Stats_Panel](../../../docs/prd/PRD_Stats_Panel.md) |
| SRS | [SRS_Dashboard_Layout](../../../docs/srs/SRS_Dashboard_Layout.md) · [SRS_Dashboard_Sidebar_Cameras](../../../docs/srs/SRS_Dashboard_Sidebar_Cameras.md) · [SRS_Dashboard_Sidebar_Alerts_Zones](../../../docs/srs/SRS_Dashboard_Sidebar_Alerts_Zones.md) · [SRS_Mobile_Layout](../../../docs/srs/SRS_Mobile_Layout.md) |
| Design | [Design_Dashboard_Layout](../../../docs/design/Design_Dashboard_Layout.md) · [Design_Dashboard_Detection_Display](../../../docs/design/Design_Dashboard_Detection_Display.md) · [Design_Dashboard_Sidebar_Cameras](../../../docs/design/Design_Dashboard_Sidebar_Cameras.md) |
| Design | [Design_Dashboard_Sidebar_Alerts_Zones](../../../docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md) · [Design_Dashboard_Sidebar_Face_ID](../../../docs/design/Design_Dashboard_Sidebar_Face_ID.md) · [Design_Dashboard_Search_Fullscreen](../../../docs/design/Design_Dashboard_Search_Fullscreen.md) · [Design_Mobile_Layout](../../../docs/design/Design_Mobile_Layout.md) · [Design_Stats_Panel](../../../docs/design/Design_Stats_Panel.md) |
| TC | [TC_Dashboard_Layout](../../../docs/tc/TC_Dashboard_Layout.md) · [TC_Dashboard_Detection_Display](../../../docs/tc/TC_Dashboard_Detection_Display.md) · [TC_Dashboard_Sidebar_Cameras](../../../docs/tc/TC_Dashboard_Sidebar_Cameras.md) · [TC_Dashboard_Sidebar_Alerts_Zones](../../../docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md) · [TC_Mobile_Layout](../../../docs/tc/TC_Mobile_Layout.md) |
| TC | [TC_Dashboard_Sidebar_Face_ID](../../../docs/tc/TC_Dashboard_Sidebar_Face_ID.md) · [TC_Detection_Snapshot_Search](../../../docs/tc/TC_Detection_Snapshot_Search.md) |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `CameraList.tsx` (탭 자동전환·로컬 상태) | `docs/design/Design_Dashboard_Sidebar_Cameras.md` §4.3, §9 시퀀스 다이어그램 · `docs/srs/SRS_Dashboard_Sidebar_Cameras.md` FR-UI-CAM-003/004 · `docs/tc/TC_Dashboard_Sidebar_Cameras.md` TC-A-003/004 |
| `CameraList.tsx`, `DiscoveredCameraPanel.tsx` | `docs/design/Design_Dashboard_Sidebar_Cameras.md`, `docs/tc/TC_Dashboard_Sidebar_Cameras.md`, `docs/rfp/RFP_Dashboard_Sidebar_Cameras.md`, `docs/prd/PRD_Dashboard_Sidebar_Cameras.md` |
| `CameraGrid.tsx`, `CameraView.tsx` | `docs/design/Design_Dashboard_Layout.md`, `docs/design/Design_Dashboard_Sidebar_Cameras.md`, `docs/tc/TC_Dashboard_Layout.md` |
| `AlertPanel.tsx` | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md` |
| `ZonesPanel.tsx`, `ZoneEditor.tsx` | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/srs/SRS_Dashboard_Sidebar_Alerts_Zones.md` |
| `FaceGalleryTab.tsx` | `docs/design/Design_Dashboard_Sidebar_Face_ID.md`, `docs/tc/TC_Dashboard_Sidebar_Face_ID.md` |
| `SearchFullscreen.tsx` | `docs/design/Design_Dashboard_Search_Fullscreen.md`, `docs/prd/PRD_Dashboard_Search_Fullscreen.md` |
| `StatsPanelModal.tsx` | `docs/design/Design_Stats_Panel.md`, `docs/prd/PRD_Stats_Panel.md` |
| `DashboardDetectionPanel.tsx` | `docs/design/Design_Dashboard_Detection_Display.md`, `docs/tc/TC_Dashboard_Detection_Display.md` |
| `FullscreenCameraView.tsx` | `docs/design/Design_Fullscreen_Camera_View.md`, `docs/design/Design_DataChannel_CameraEvents.md`, `docs/design/Design_Dashboard_Layout.md`, `docs/design/Design_ONVIF_Timeline.md` |
| `DetectionsTimelineInline.tsx` | `docs/design/Design_Fullscreen_Camera_View.md` §3.3, `docs/tc/TC_Fullscreen_Camera_View.md` TC-04~09 |
| `OnvifTimelineInline.tsx` | `docs/design/Design_ONVIF_Timeline.md` §5.3, `docs/design/Design_Fullscreen_Camera_View.md` §3.2 |
| `dataChannelStore.ts` | `docs/design/Design_DataChannel_CameraEvents.md` |
| `OnvifTimelineOverlay.tsx` | `docs/design/Design_ONVIF_Timeline.md` |
| `onvifEventStore.ts` | `docs/design/Design_ONVIF_Timeline.md` §4.3 |
| `SearchFullscreen.tsx` (ONVIF button) | `docs/design/Design_ONVIF_Timeline.md`, `docs/design/Design_Dashboard_Search_Fullscreen.md` |
| `i18n/translations/*.ts` | 해당 UI 컴포넌트의 Design 문서 UI 텍스트 섹션 |
| `App.tsx` (auth/role 변경) | `docs/design/Design_User_Authentication.md`, `docs/design/Design_Dashboard_Analysis_Mode.md` |
| **`pages/admin/AdminUsersPage.tsx`** (Admin Dashboard) | **`docs/design/Design_Admin_Dashboard.md`** — 섹션 추가/삭제·레이아웃·API 변경 시 |
| `pages/admin/AdminUsersPage.tsx` (Users 섹션) | `docs/design/Design_Admin_Dashboard.md` §4.1 |
| `pages/admin/AdminUsersPage.tsx` (AI Models 섹션) | `docs/design/Design_Admin_Dashboard.md` §4.2 · `docs/design/Design_AI_Model_Catalog.md` · `docs/srs/SRS_Admin_Dashboard.md` §4 |
| `pages/admin/AdminUsersPage.tsx` (ONVIF 섹션) | `docs/design/Design_Admin_Dashboard.md` §4.4 · `docs/design/Design_ONVIF_Timeline.md` §3.4 |
| `pages/admin/AdminUsersPage.tsx` (Audit 섹션) | `docs/design/Design_Admin_Dashboard.md` §4.5 |
| 새 컴포넌트 추가 | PRD + SRS + Design + TC 문서 신규 작성 또는 관련 문서에 섹션 추가 |

**공통 규칙**
- **새 UI 컴포넌트** → Design 문서에 UI 구조·상태·이벤트 흐름 추가, TC에 렌더링·인터랙션 케이스 추가
- **Zustand 스토어 변경** → SRS 데이터 모델 섹션 업데이트
- **API 연동 변경** → Design의 데이터 플로우 다이어그램 및 TC 업데이트
- **반응형 레이아웃 변경** → `docs/design/Design_Mobile_Layout.md` + `docs/tc/TC_Mobile_Layout.md` 업데이트
- **i18n 키 추가** → 해당 화면의 Design 문서 UI 텍스트 항목 추가

## Admin Dashboard (`pages/admin/AdminUsersPage.tsx`)

**설계 문서:** [Design_Admin_Dashboard.md](../../../docs/design/Design_Admin_Dashboard.md)  
**SRS:** [SRS_Admin_Dashboard.md](../../../docs/srs/SRS_Admin_Dashboard.md)  
**TC:** [TC_Admin_Dashboard.md](../../../docs/tc/TC_Admin_Dashboard.md)

`admin` 역할 전용 관리 화면. 단일 파일에 좌측 사이드바 + 4개 섹션을 포함합니다.

진입점: App.tsx 프로필 드롭다운 → **"Admin Dashboard"** (admin 역할 전용)

### 레이아웃

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Admin Dashboard                                    [Admin]    │
├──────────────────┬──────────────────────────────────────────────┤
│  👥 Users        │  섹션 콘텐츠 (scrollable)                    │
│  🤖 AI Models    │                                              │
│  📡 ONVIF        │                                              │
│  📋 Audit Log    │                                              │
└──────────────────┴──────────────────────────────────────────────┘
  w-52 sidebar
```

### 섹션 구조

```typescript
type AdminSection = 'users' | 'ai-models' | 'onvif' | 'audit';
// useState<AdminSection>('users') — 사이드바 탭 전환
```

| 섹션 | 컴포넌트 | 주요 API |
|------|---------|---------|
| 👥 Users | `UsersSection` | GET/PATCH/DELETE `/admin/users` |
| 🤖 AI Models | `AiModelsSection` | GET/POST `/api/analysis/models`, GET/PUT `/api/analytics/config`, GET `/api/capabilities` |
| 📡 ONVIF | `OnvifSection` | GET/DELETE `/api/onvif-event-types` |
| 📋 Audit Log | `AuditSection` | GET `/admin/audit?limit=200` |

### AiModelsSection 구현 포인트

**YOLO Detection Model 카탈로그:**
- `GET /api/analysis/models` → `{ activeFile, catalog[] }` — 응답 키는 `catalog` (not `models`)
- 각 항목: `exists`(다운로드 여부), `active`(활성 여부), `downloading`, `converting`, `downloadPercent`, `downloadError`
- 시리즈 순서: YOLO12 → YOLO11 → YOLOv8 (15개 모델 총)
- `POST /api/analysis/models/switch { modelId }` → 모델 전환
- `POST /api/analysis/models/download { modelId }` → 다운로드 시작; YOLO12는 PT→ONNX 자동 변환
- 폴링: `setInterval(fetchCatalog, 2000)` — 다운로드/변환 중인 모델이 있을 때만 활성

**YOLO12 다운로드 버튼 레이블:** `↓ PT→ONNX` (서버가 자동 변환)

**AI Analysis Modules (ADMIN_MODULE_GROUPS):**
- Core: Human, Vehicle
- AI Attributes: Face, Color, Cloth, Mask, Hat
- Hazard: Fire, Smoke
- `GET /api/analytics/config` + `GET /api/capabilities` → 활성화 상태 및 가용성 로드
- `PUT /api/analytics/config { [id]: boolean }` → 토글

### 공유 서브컴포넌트 (동일 파일 내)

| 컴포넌트 | 역할 |
|---------|------|
| `SectionHeader` | 섹션 제목 + 부제목 |
| `StatCard` | 숫자 요약 카드 (blue/red/yellow) |
| `ErrorBar` | 에러 배너 |
| `EmptyState` | 빈 상태 메시지 |

### 코드 수정 시 동기화 의무

| 변경 내용 | 업데이트 필요 문서 |
|----------|-----------------|
| 사이드바 섹션 추가·삭제 | `Design_Admin_Dashboard.md` §3 NAV 표 |
| Users 섹션 기능 변경 | `Design_Admin_Dashboard.md` §4.1 · `SRS_Admin_Dashboard.md` §5 |
| AI Models 섹션 변경 | `Design_Admin_Dashboard.md` §4.2 · `Design_AI_Model_Catalog.md` · `SRS_Admin_Dashboard.md` §4 |
| ONVIF 섹션 변경 | `Design_Admin_Dashboard.md` §4.4 · `Design_ONVIF_Timeline.md` §3.4 |
| Audit 섹션 변경 | `Design_Admin_Dashboard.md` §4.5 |
| 공유 컴포넌트 추가 | `Design_Admin_Dashboard.md` §5 |
| API 엔드포인트 변경 | `Design_Admin_Dashboard.md` §6 · `CLAUDE.md` API 표 |

---

## App.tsx 라우팅 구조 (현재)

```tsx
// App 컴포넌트 렌더링 분기
if (initializing)               → 로딩 스피너
if (auth.page === 'signin')     → SignInPage
if (auth.page === 'pending')    → PendingPage
if (auth.page === 'admin')      → AdminUsersPage
if (user.role !== 'admin')      → AccessDeniedPage   // admin 전용 gate
return                          → Dashboard
```

Dashboard 내부 URL 분기 (combined 모드):
- `window.location.pathname === '/'`        → Streaming Dashboard
- `window.location.pathname === '/analysis'` → Analysis Dashboard
- `history.pushState` + `currentPath` state로 URL 전환 (react-router-dom 불필요)

Profile 드롭다운 메뉴 항목 (combined 모드에서만 추가):
```
Profile → setShowProfile(true)
User Management → auth.navigateTo('admin')   [admin만]
──────────────────────────────               [combined만]
Streaming Dashboard → navigateDashboard('/')
Analysis Dashboard  → navigateDashboard('/analysis')
──────────────────────────────
Sign Out → auth.logout()
```

## 사이드바 Collapse / Expand (모든 모드 공통)

탭 바 우측 **✕** 버튼으로 사이드바를 44px 아이콘 스트립으로 축소할 수 있습니다.

```
[Expanded]                   [Collapsed — 44px]
┌──────────────────────┐     ┌────┐
│ 📷 Cameras  ✕        │     │ 📷 │ ← 클릭: 해당 탭으로 복원
│ 🔔 Alerts            │     │ 🔔 │ ← hover: flyout 미리보기 패널
│ 🗺 Zones             │     │ 🗺 │
│ 👁 Detections        │     │ 👁 │
│ 🪪 Face Gallery      │     │ 🪪 │
├──────────────────────┤     └────┘
│  탭 콘텐츠           │
└──────────────────────┘
```

### 관련 state (App.tsx)
| state | 타입 | 설명 |
|-------|------|------|
| `sidebarCollapsed` | `boolean` | 아이콘 스트립 모드 여부 |
| `hoveredTab` | `SidebarTab \| null` | hover 중인 탭 (flyout 트리거) |

### 핵심 동작 요약
- `sidebarCollapsed = true` 시 `<aside>` 너비 44px, resize handle 비활성화
- Collapsed 아이콘 클릭 → 해당 탭 선택 + 복원
- Collapsed 아이콘 hover → `hoveredTab` 세팅 → `absolute right-full` flyout 패널 (너비 = `sidebarWidth`)
- Flyout 패널 자체에도 `onMouseEnter`/`onMouseLeave` 적용 (마우스 이동 시 유지)
- Flyout 안 **"열기 →"** 버튼 → 완전 복원
- `renderTabContent(overrideTab?)` — 선택적 override로 flyout에 특정 탭 렌더링

### 코드 수정 시 유의
- Collapse 상태 변경 시 `docs/design/Design_Dashboard_Layout.md` Section 3.2 업데이트
- 새 탭 추가 시 `TAB_ITEMS` 배열과 `renderTabContent()` 동시 수정

---

## SERVER_MODE 기반 탭 노출 정책 (중요)

- 기준 위치: `client/src/App.tsx` (`serverMode`, `isStreaming`, `TAB_ITEMS`)
- `combined`: Cameras/Analytics 탭 모두 표시
- `streaming`: Analytics 탭 숨김
- `analysis`: 메인 영역은 `AnalysisServerDashboard.tsx`, 우측/모바일 탭은 **2개 탭** 표시:
  - `analytics` (VideoAnalyticsTab — 모듈 설정)
  - `detections` (**AnalysisEventsTab** — 이벤트 히스토리 날짜 그룹)
  - 실시간 감지 피드는 대시보드 "감지 이벤트" 카드 클릭 → `AnalysisLivePanel` 오버레이로 표시
  - 이벤트 히스토리는 대시보드 "알림" 카드 클릭 → `AnalysisDetectionPanel` 오버레이로 표시
- 모드 변경으로 현재 활성 탭이 유효하지 않으면 `analytics`로 자동 전환

```typescript
// renderTabContent — analysis 분기
if (tab === 'detections') return isAnalysis ? <AnalysisEventsTab /> : <DashboardDetectionPanel />;
```

## Analysis Mode Dashboard

- `AnalysisServerDashboard.tsx`는 `/api/analysis/metrics`를 주기적으로 조회해 현재 활성 모듈, 입력 트래픽, 요청 동시성, 최근/누적 결과, 카메라별 부하를 보여줍니다.
- **두 가지 오버레이** 상태로 인라인 패널 제어:

| stat 카드 | 열리는 오버레이 | 컴포넌트 |
|---|---|---|
| 감지 이벤트 (누적) | `showLiveDetections` | `AnalysisLivePanel` (실시간 감지 피드) |
| 알림 (배회 누적) | `showEventHistory` | `AnalysisDetectionPanel` (이벤트 히스토리) |

```typescript
// AnalysisServerDashboard.tsx
const [showEventHistory,   setShowEventHistory]   = useState(false);
const [showLiveDetections, setShowLiveDetections] = useState(false);

{showLiveDetections && (
  <div className="absolute inset-0 z-20 rounded-[28px] overflow-hidden">
    <AnalysisLivePanel onClose={() => setShowLiveDetections(false)} />
  </div>
)}
{showEventHistory && (
  <div className="absolute inset-0 z-20 rounded-[28px] overflow-hidden">
    <AnalysisDetectionPanel onClose={() => setShowEventHistory(false)} />
  </div>
)}
```

## AnalysisLivePanel — 실시간 감지 피드 오버레이 (신규)

**Props**: `{ onClose?: () => void }`

**역할**: `DashboardDetectionPanel`을 analysis 대시보드 내부 오버레이로 래핑. "감지 이벤트 (누적)" stat 카드와 연결.

**포함 기능**: 실시간 탐지 목록 · 스냅샷 썸네일 · Person Trails · Cross-Camera Re-ID · 의상 Re-ID

## AnalysisDetectionPanel — 날짜 그룹별 히스토리 브라우저 (v1.7)

**Props**: `{ onClose?: () => void }`

**기능**:
- `GET /api/analysis/events?limit=200` 폴링 (5초, 자동/일시정지 토글)
- `useMemo`로 날짜별 그룹핑, 최신 날짜 순 정렬
- `EventRow`: 클릭 시 확장, 메타 정보 + `cropData` 이미지 표시
- 이벤트 타입 필터 (전체/화재/연기/배회)
- `DELETE /api/analysis/events` 전체 삭제
- `onClose` prop 있을 때 닫기 버튼 표시 (오버레이 모드)
- 크롭 이미지 클릭 → 새 탭에서 원본 확대

## DashboardDetectionPanel — 실시간 감지 (SERVER_MODE별)

`DashboardDetectionPanel`은 `useAllDetections` 훅으로 `detections` Socket.IO 이벤트를 수신합니다.

| 모드 | 이벤트 소스 | 크롭 소스 | 카메라 구독 필요 |
|---|---|---|---|
| combined | PipelineManager 로컬 추론 → `.to(cameraId)` | snapshotSvc (isLoitering/isFirstSeen/hasFaceMatch/isFireSmoke) | ✅ |
| streaming | `_processRemoteResult` → `.to(cameraId)` | snapshotSvc (동일 조건) | ✅ (analysis 서버 연결 필수) |
| analysis | `analysisApi.js` → `io.emit()` global | `_persistFireSmoke`/`_persistLoitering` | ❌ (global 수신) |

**주의사항 (streaming 모드)**: analysis 서버가 연결되어 있지 않으면 `_processRemoteResult`가 호출되지 않아 `detections` 이벤트가 발생하지 않습니다.

## useAllDetections — 전체 수신 모드 (analysis 서버 지원)

```typescript
// client/src/hooks/useAllDetections.ts
const handleDetections = (ev: DetectionsEvent) => {
  // analysis 서버 모드: 카메라 없음 → subscribedRef.size = 0 → 전체 수신
  if (subscribedRef.current.size > 0 && !subscribedRef.current.has(ev.cameraId)) return;
  setDetMap(prev => { ... });
};
```

- `combined`/`streaming`: 구독된 카메라 ID만 필터링 (기존 동작 유지)
- `analysis`: 구독 없음(size=0) → 모든 `detections` 이벤트 수용 (global emit 대응)
- 카메라 이름: analysis 모드에서는 카메라가 DB에 없어 `cameraId.slice(0, 8)` 약칭 표시

### alertService EventEmitter 연결 (index.js 버그 수정)

**문제:** Analysis 모드에서 `pipelineManager._alertService`와 `app.get('alertService')`가 **별개의 AlertService 인스턴스**였습니다. `analysisApi.js`가 `app.get('alertService').createAlert()`를 호출해도 socket.io로 전달되지 않아 Alerts 탭이 비어 있었습니다.

**수정 (index.js):**
```javascript
app.set('alertService', alertService);
app.set('db', db);
app.set('io', io);  // analysisApi에서 Socket.IO emit 가능하도록

// index.js 인스턴스의 alert 이벤트를 socket.io로 직접 브로드캐스트
alertService.on('alert', (alert) => io.emit('alert:new', alert));
```

> `app.set('io', io)` — `analysisApi.js`가 `req.app.get('io')`로 Socket.IO에 접근해 `detections`/`snapshot:new` 이벤트를 emit합니다.

## CameraEventsTab — DataChannel App RTP 뷰어 (FullscreenCameraView 내부)

**위치:** `client/src/components/FullscreenCameraView.tsx` (export function)  
**스토어:** `client/src/stores/dataChannelStore.ts`  
**설계 문서:** [Design_DataChannel_CameraEvents.md](../../../docs/design/Design_DataChannel_CameraEvents.md)

### 데이터 파이프라인 요약

```
RTSP data/subtitle track
  → ingest_daemon.py _app_rtp_loop()
  → POST /api/internal/apprtp/:cameraId  { pt, timestamp, seq, payload }
  → mediasoupEngine.js sendAppRtp()
  → mediasoup dataProducer.send()
  → 브라우저 pc.ondatachannel dc.onmessage
  → dataChannelStore.pushMessage()
  → CameraEventsTab history[cameraId] 구독
```

### dataChannelStore 핵심 필드

| 필드 | 스로틀 | 설명 |
|------|--------|------|
| `messages` | 없음 | 카메라별 최신 1개 메시지 |
| `counts` | 없음 | 총 수신 건수 (UI 배지) |
| `history` | 200ms / max 100 | 렌더링용 최근 이력 |

### 레이아웃 (FullscreenCameraView)

```
┌──────────────────────────────┬─────────────┐
│ Header                        │             │
├──────────────────────────────┤  Detection  │
│ CameraView (flex-1 min-h-0)  │  Panel      │
├──────────────────────────────┤             │
│ [Camera Events] tab bar      │             │
├──────────────────────────────┤             │
│ CameraEventsTab (160px)      │             │
└──────────────────────────────┴─────────────┘
```

### 확장 가이드

새 탭(예: "Statistics") 추가 시:
1. `videoTab` state 타입에 새 값 추가: `useState<'events' | 'stats'>('events')`
2. 탭 바 `<button>` 추가 (기존 패턴 복사)
3. `{videoTab === 'stats' && <StatsTab cameraId={cameraId} />}` 조건부 렌더

### Samsung ONVIF 메타데이터 payload 해석

`payload`는 Base64 인코딩된 원본 RTP 패킷 바이트입니다.  
Samsung 카메라는 ONVIF XML을 RTP data 트랙으로 전송하며, `decodePayload()` 함수로  
UTF-8 텍스트를 추출해 최대 200자 미리보기를 표시합니다.  
원본 바이너리가 필요하면: `atob(msg.payload)` → `Uint8Array`로 처리하세요.  
ONVIF 이벤트 토픽·XML 구조: [Design_ONVIF_Metadata_Pipeline.md](../../../docs/design/Design_ONVIF_Metadata_Pipeline.md)

---

## Client Log Backchannel — 브라우저 콘솔·WebRTC 통계 수집

**설계 문서:** [Design_Client_Log_Backchannel.md](../../../docs/design/Design_Client_Log_Backchannel.md)

### 개요

`client/src/clientLogger.ts`가 두 가지 기능을 Socket.IO 백채널로 제공합니다:

| 기능 | Socket.IO 이벤트 | 서버 수집 |
|------|----------------|---------|
| 콘솔 로그 캡처 | `client:log` | `client_logs` (최대 10,000건) |
| WebRTC 통계 | `client:webrtc-stats` | `client_webrtc_stats` (최대 5,000건) |

### 진입점 및 등록

```typescript
// client/src/main.tsx
import { initClientLogger } from './clientLogger';
initClientLogger();  // 앱 시작 즉시 — 이후 모든 console.* intercept됨

// client/src/hooks/useWebRTC.ts
registerPeerConnection(pc, cameraId);  // PC 생성 직후 — cameraId 태깅
```

### REST API (조회 전용)

```
GET    /api/client-logs?level=error&sessionId=&from=&to=&limit=200
GET    /api/client-logs/webrtc?cameraId=&pcId=&limit=100
DELETE /api/client-logs
DELETE /api/client-logs/webrtc
```

### WebRTCPCSummary (StatsPanelModal)

`getWebRTCSnapshotAsync()` — 현재 활성 PC 전체의 RTT·PacketLoss·FPS·BytesReceived 요약.  
`client/src/components/StatsPanelModal.tsx`에서 호출.

### 코드 수정 시 문서 동기화

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `clientLogger.ts` (새 이벤트/기능) | `Design_Client_Log_Backchannel.md` §4·§6 |
| `streamHandler.js` (client:log 핸들러) | `Design_Client_Log_Backchannel.md` §5.1 |
| `routes/clientLogs.js` (API 변경) | `Design_Client_Log_Backchannel.md` §5.2, `CLAUDE.md` API 표 |
| `db.js` (client_logs 스키마) | `Design_Client_Log_Backchannel.md` §5.3 |

---

## ONVIF Event Timeline

**설계 문서:** [Design_ONVIF_Timeline.md](../../../docs/design/Design_ONVIF_Timeline.md)  
**파이프라인 문서:** [Design_ONVIF_Metadata_Pipeline.md](../../../docs/design/Design_ONVIF_Metadata_Pipeline.md)

### 개요

ONVIF 메타데이터 이벤트를 DB에 저장(`onvif_events` 테이블)하고,
전체화면 오버레이 타임라인 UI로 시각화합니다.

| 파일 | 역할 |
|------|------|
| `server/src/services/onvifParser.js` | 정규식 기반 ONVIF XML 파서 (TOPIC_MAP) |
| `server/src/routes/internalApi.js` | App RTP 수신 → ONVIF 파싱 → 상태 변화 저장 |
| `server/src/routes/onvifApi.js` | `GET/DELETE /api/onvif-events` |
| `client/src/utils/onvifParser.ts` | 브라우저 DOMParser 기반 ONVIF XML 파서 |
| `client/src/stores/onvifEventStore.ts` | Zustand 스토어 (`pushEvent`, `setEvents`, `clearAll`) |
| `client/src/components/OnvifTimelineOverlay.tsx` | 전체화면 타임라인 오버레이 (SearchFullscreen용) |
| `client/src/components/OnvifTimelineInline.tsx`  | 컴팩트 인라인 타임라인 (FullscreenCameraView 탭 패널용) |

### 진입점

1. **FullscreenCameraView.tsx** — 하단 패널 "ONVIF Timeline" **탭** (`videoTab='onvif'`) → `OnvifTimelineInline` 렌더
2. **SearchFullscreen.tsx** — 필터 행 "ONVIF Timeline" 버튼 → `OnvifTimelineOverlay` 전체화면 오버레이

### OnvifTimelineInline 레이아웃 — DetectionsTimelineInline 동일 스타일

`state=true/false` 쌍 이벤트는 수평 Gantt 바 + 인라인 프레임 썸네일, 상태 없는 이벤트는 다이아몬드 포인트 마커로 렌더링합니다.
각 `topicType:sourceToken` 조합이 별도의 행(row)으로 표시됩니다.

```
┌──────────────────────────────────────────────────────────────────┐
│ [1D][1W][1M][1Y][Custom]  [Event Type ▾]   ×2.0   5/12          │ ← control
├──────────────────────────────────────────────────────────────────┤
│ callRequest (Tok1) │ [███ motionAlarm 15s ██████]    │ detail     │ BAR (16px)
│                    │     [📷]                        │ 220px      │ SNAP (30px)
│ motionAlarm        │ [████ 3s ████]                  │            │
│                    │ [📷]                            │            │
├────────────────────┼────────────────────────────────┤            │
│    <tick labels>   │                                │            │
└──────────────────────────────────────────────────────────────────┘
```

**레이아웃 상수 (Inline / Overlay):**

| 상수 | Inline | Overlay |
|------|--------|---------|
| `ROW_H`   | 52px  | 68px  |
| `BAR_H`   | 16px  | 22px  |
| `BAR_TOP` | 4px   | 6px   |
| `SNAP_H`  | 30px  | 36px  |
| `SNAP_W`  | 44px  | 56px  |
| `SNAP_TOP`| `BAR_TOP+BAR_H+2` | `BAR_TOP+BAR_H+4` |

- **완료 인터벌**: `SEV_COLOR[sev]cc` 배경 + `1px solid` 테두리; 바 내부에 `topicLabel + duration` 라벨
- **진행 중** (`inProgress=true`): `SEV_COLOR[sev]88` + `1px dashed` 테두리; 라벨에 `↦` 프리픽스
- **포인트 이벤트** (state 없음): 45° 다이아몬드 마커

**스냅샷 인라인 필름스트립:**
- `snapCache: Map<string, string>` — intervalId → frameData URL
- `fetchedRef: Set<string>` — 중복 fetch 방지
- 뷰포트 내 보이는 bar가 바뀌면 `useEffect`에서 자동 lazy-fetch
- 캐시 후 `startTs` x좌표 위치에 `<img>` 렌더링 (바 아래 `SNAP_TOP` 위치)
- 상세 패널: `snapCache.get(selected.id)` 로 표시 (별도 fetch 불필요)

구현: `{selected && <div style={{ width: DETAIL_W }}>…</div>}` — `selected` null 시 DOM에서 완전히 제거됩니다.

### 드래그 패닝 (OnvifTimelineInline)

마우스 클릭-드래그로 타임라인 뷰를 이동합니다.

**수식:**
```
newPan = startPan + (currentX − startX) / containerWidth / zoom
```
- 드래그 ← (dx < 0) → pan 감소 → viewEnd가 현재 시각에 가까워짐 → **최신 이벤트 노출**
- 드래그 → (dx > 0) → pan 증가 → viewEnd가 과거로 이동 → **과거 이벤트 노출**

**클릭 vs 드래그 구분:**
- `DRAG_THRESHOLD_PX = 4` 이상 이동 시 `hasDraggedRef.current = true`
- 이벤트 아이콘 `onClick`: `hasDraggedRef.current` 가 true이면 선택 무시
- 이벤트 아이콘 `onMouseDown`: `stopPropagation()` — 컨테이너 드래그 시작 차단

### Event Type 필터

두 컴포넌트 모두 `[Event Type ▾]`(또는 `<select>`) 드롭다운으로 타임라인 이벤트를 특정 타입으로 필터링합니다.

- **옵션 목록**: `onvifEventStore.types` (전역 레지스트리) — 현재 범위에 없는 타입도 표시
- **기본값**: `All Types` (빈 문자열 — 필터 없음)

| 항목 | OnvifTimelineInline | OnvifTimelineOverlay |
|------|--------------------|--------------------|
| UI 위치 | 상단 컨트롤 행 `[Event Type ▾]` | 헤더 Range selector 우측 `<select>` |
| 타입 변경 시 | `selected` 이벤트 초기화 | 자동 필터링만 |

설계 상세: [Design_ONVIF_Timeline.md §5.5 / §5.8](../../../docs/design/Design_ONVIF_Timeline.md)

### ONVIF 이벤트 타입 전역 레지스트리

현재 범위에 없는 이벤트 타입도 필터 드롭다운에 표시하기 위해 별도 DB 테이블(`onvif_event_types`)에 ever-seen 타입을 영구 저장합니다.

| 항목 | 내용 |
|------|------|
| DB 테이블 | `onvif_event_types` (row cap 없음, ~20개 이내) |
| 자동 등록 | `internalApi.js`가 신규 `topicType` 최초 감지 시 삽입 |
| 소켓 이벤트 | `onvif:type-registered` — 신규 타입 등록 즉시 브로드캐스트 |
| REST | `GET /api/onvif-event-types`, `DELETE /api/onvif-event-types` |
| 범위 | 전역 (카메라 종속 없음 — 카메라 삭제 후에도 유지) |
| 관리 | Admin 페이지 → "ONVIF Event Type Registry" 섹션에서 조회·초기화 |

클라이언트 로드 순서 (두 컴포넌트 공통):
```
OnvifTimelineInline mount (또는 OnvifTimelineOverlay mount)
  → GET /api/onvif-event-types → setTypes(...)   [전역 타입 레지스트리]
  → socket.on('onvif:type-registered', addType)  [실시간 신규 타입 수신]
  → GET /api/onvif-events?from=…               → setEvents(...)
  → socket.on('onvif:event', pushEvent)
```

### 상태 변화 저장 로직 (서버)

```javascript
// internalApi.js — _lastStates Map (per cameraId:topic:sourceToken)
if (lastState !== parsed.state) {
  _lastStates.set(dedupKey, parsed.state);
  db.insert('onvif_events', event);
  io.emit('onvif:event', event);
}
```

Samsung 카메라는 33~38 pkt/s 속도로 같은 State를 반복 전송합니다.
dedup 없이 저장하면 1일 기준 ~14M 행이 발생합니다.

### 타임라인 줌/팬 수식

```
viewSpan  = rangeMs / zoomLevel
viewEnd   = now − panFraction × rangeMs
viewStart = viewEnd − viewSpan
itemX     = (eventTs − viewStart) / viewSpan   // [0..1]
```

### Gantt 인터벌 로직

```typescript
// buildIntervals(events, nowMs) — state=true/false 쌍으로 인터벌 구성
// key = cameraId:topicType:sourceToken
// state='true':
//   Map[key] already open → skip (coalesce, 원본 startTs 유지)
//   Map[key] empty        → open new interval (inProgress=true, endTs=nowMs)
// state='false' → close Map[key], set endTs, push; 없으면 point marker
// no state      → point marker (isPoint=true)
// flush         → remaining open = inProgress
//
// Coalesce: start→start→start→end 시퀀스는 단일 인터벌로 합산
// (서버 재시작 후 _lastStates 초기화로 인한 artifact)
```

### ONVIF 스냅샷

| 항목 | 내용 |
|------|------|
| 저장 시점 | ONVIF `state=true` 이벤트 수신 즉시 (`setImmediate`) |
| 데이터 소스 | `pipelineManager.getLatestFrame(cameraId)` → `ctx._latestJpeg` |
| DB 테이블 | `onvif_snapshots` (row cap 2,000) |
| REST | `GET /api/onvif-snapshots?eventId=&cameraId=&topicType=&from=&to=&limit=` |
| 클라이언트 렌더링 | 뷰포트 내 bar 변경 → lazy-fetch → `snapCache` → bar 아래 인라인 `<img>` (DetectionsTimelineInline 필름스트립 스타일) |
| 상세 패널 | `snapCache.get(selected.id)` — 별도 fetch 없이 이미 캐시된 이미지 사용 |

### REST API

```
GET  /api/onvif-events?cameraId=&type=&severity=&from=&to=&limit=500
DELETE /api/onvif-events?cameraId=   (생략 시 전체 삭제)
GET  /api/onvif-snapshots?eventId=&cameraId=&topicType=&from=&to=&limit=50
```

### Socket.IO 이벤트

| 이벤트 | 방향 | 구독 컴포넌트 | 설명 |
|--------|------|------------|------|
| `onvif:event` | Server → Client | Inline + Overlay | 상태 변화 ONVIF 이벤트 (OnvifEvent 객체) → `pushEvent()` |
| `onvif:type-registered` | Server → Client | Inline + Overlay | 신규 topicType 최초 감지 시 브로드캐스트 → `addType()` (드롭다운 자동 추가) |

### 코드 수정 시 문서 동기화

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `OnvifTimelineOverlay.tsx` (전체화면 UI + Gantt + Type 필터) | `Design_ONVIF_Timeline.md` §5·§5.9 |
| `OnvifTimelineInline.tsx` (인라인 UI + Gantt, 드래그 패닝, 타입 필터) | `Design_ONVIF_Timeline.md` §5.3·§5.9 |
| `AdminUsersPage.tsx` (Admin Dashboard 전체) | `Design_ONVIF_Timeline.md` §3.4 |
| `onvifEventStore.ts` (스토어 필드) | `Design_ONVIF_Timeline.md` §4.3 |
| `onvifApi.js` (API 파라미터) | `Design_ONVIF_Timeline.md` §3.3, `CLAUDE.md` API 표 |
| `onvifParser.js` (TOPIC_MAP) | `Design_ONVIF_Metadata_Pipeline.md` §2 |
| `db.js` (`onvif_events`, `onvif_snapshots` 스키마) | `Design_ONVIF_Timeline.md` §2.1 |
| `pipelineManager.js` (`_latestJpeg`, `getLatestFrame`) | `Design_ONVIF_Timeline.md` §5.9 |
| `internalApi.js` (스냅샷 저장 로직) | `Design_ONVIF_Timeline.md` §5.9 |

---

## Detections Timeline (`DetectionsTimelineInline`)

**설계 문서:** [Design_Fullscreen_Camera_View.md §3.3](../../../docs/design/Design_Fullscreen_Camera_View.md)  
**TC:** [TC_Fullscreen_Camera_View.md TC-04~15](../../../docs/tc/TC_Fullscreen_Camera_View.md)

### 개요

FullscreenCameraView의 "Detections" 탭에 표시되는 Gantt 스타일 타임라인. ByteTracker 트랙 생명주기(`firstSeenAt` → `lastSeenAt`)를 수평 막대로 시각화합니다.

**ONVIF Timeline과의 차이점:**

| 항목 | ONVIF Timeline | Detections Timeline |
|------|---------------|---------------------|
| 데이터 | 순간 이벤트 (점) | 객체 존재 구간 (막대) |
| API | `/api/onvif-events` | `/api/analysis/detection-tracks` |
| 서버 소스 | ONVIF XML 파싱 | ByteTracker `popRemovedTracks()` |
| 저장 기준 | 모든 상태 변화 | isLoitering=true 또는 riskScore≥0.3 |

### detectionTracks DB 스키마

```javascript
{
  id: string,           // UUID
  cameraId: string,
  cameraName: string,
  objectId: number,     // ByteTracker trackId
  className: string,    // 'person', 'car', ...
  firstSeenAt: number,  // Unix ms (Track 생성 시각)
  lastSeenAt: number,   // Unix ms (TrackState.Removed 시각)
  dwellTime: number,    // ms
  maxRiskScore: number, // 0~1
  isLoitering: boolean,
  confidence: number,
  faceId: string | null,
  identity: string | null,
  zoneId: string | null,
  zoneName: string | null,
  color: string | null,
  cloth: string | null,
  createdAt: string     // ISO 8601
}
```

DB cap: 10,000 rows (FIFO 삭제).

### 서버 구현 파일

| 파일 | 역할 |
|------|------|
| `server/src/services/tracking.js` | `Track.firstSeenAt`, `ByteTracker.popRemovedTracks()` |
| `server/src/services/pipelineManager.js` | `ctx._trackMeta` Map, 트랙 종료 시 DB 저장 |
| `server/src/routes/analysisApi.js` | `GET/DELETE /api/analysis/detection-tracks` |

### REST API

```
GET  /api/analysis/detection-tracks?cameraId=&class=&from=ISO&to=ISO&limit=1000
DELETE /api/analysis/detection-tracks
```

응답: `{ tracks: DetectionTrack[], total: number }`

### 코드 수정 시 문서 동기화

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `DetectionsTimelineInline.tsx` (UI 변경) | `Design_Fullscreen_Camera_View.md` §3.3, `TC_Fullscreen_Camera_View.md` §2 |
| `tracking.js` (`popRemovedTracks` 변경) | `Design_Fullscreen_Camera_View.md` §3.3 서버 구현 표 |
| `pipelineManager.js` (저장 기준 변경) | `Design_Fullscreen_Camera_View.md` §3.3 저장 기준 설명 |
| `analysisApi.js` (API 파라미터 변경) | `CLAUDE.md` API 표, `Design_Fullscreen_Camera_View.md` §3.3 |

### 최근 변경 (2026-06-17) — 모드별 데이터 저장 및 fallback

#### DetectionTrack inProgress 필드

```typescript
interface DetectionTrack {
  id: string;
  cameraId: string;
  objectId: string;      // UUID (ByteTracker track.id)
  className: string;
  firstSeenAt: string;   // ISO8601
  lastSeenAt: string;    // ISO8601
  dwellTime: number;     // ms
  maxRiskScore: number;
  isLoitering: boolean;
  inProgress?: boolean;  // true = 현재 프레임 내 (Gantt 대시 스타일)
  // ... faceId, identity, zoneId, etc.
}
```

`inProgress: true` 트랙은 Gantt 바에서 `opacity 0.88 + dashed border`로 구분 표시됩니다.

#### 모드별 데이터 소스

| SERVER_MODE | `/api/analysis/detection-tracks` | `/api/analysis/detection-snapshots` |
|---|---|---|
| `combined` | 로컬 DB | 로컬 DB |
| `analysis` | 로컬 DB | 로컬 DB |
| `streaming` | analysis 서버 proxy → **로컬 fallback** | analysis 서버 proxy → **로컬 fallback** |

fallback 응답에는 `source: 'local-streaming'` 필드가 포함됩니다.

#### Detections Timeline 데이터가 없을 때 체크리스트

1. `storage/lts.json`에 `detectionTracks` 키가 있는가? (db.js `ALL_TABLES` 누락 → TypeError)
2. 트랙 저장 조건 충족 여부: `isLoitering || riskScore >= 0.3 || dwellTime >= 1000ms`
3. `streaming` 모드: analysis 서버에 새 코드가 배포되었는가? (`analysisApi.js` track saving)
4. `streaming` 모드: analysis 서버 다운 시 로컬 fallback으로 자동 전환되는가?
5. objectId가 `"undefined"` 문자열로 저장되지 않았는가? (raw Track은 `.id` 사용, `.objectId` 아님)
