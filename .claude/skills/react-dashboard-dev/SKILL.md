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
│   ├── DashboardDetectionPanel.tsx — 감지 결과 패널 (combined/streaming)
│   └── AnalysisDetectionPanel.tsx  — Analysis 모드 감지 이벤트 목록 (analysisEvents DB 조회)
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
| `CameraGrid.tsx`, `CameraView.tsx` | `docs/design/Design_Dashboard_Layout.md`, `docs/design/Design_Dashboard_Sidebar_Cameras.md`, `docs/tc/TC_Dashboard_Layout.md` |
| `AlertPanel.tsx` | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/tc/TC_Dashboard_Sidebar_Alerts_Zones.md` |
| `ZonesPanel.tsx`, `ZoneEditor.tsx` | `docs/design/Design_Dashboard_Sidebar_Alerts_Zones.md`, `docs/srs/SRS_Dashboard_Sidebar_Alerts_Zones.md` |
| `FaceGalleryTab.tsx` | `docs/design/Design_Dashboard_Sidebar_Face_ID.md`, `docs/tc/TC_Dashboard_Sidebar_Face_ID.md` |
| `SearchFullscreen.tsx` | `docs/design/Design_Dashboard_Search_Fullscreen.md`, `docs/prd/PRD_Dashboard_Search_Fullscreen.md` |
| `StatsPanelModal.tsx` | `docs/design/Design_Stats_Panel.md`, `docs/prd/PRD_Stats_Panel.md` |
| `DashboardDetectionPanel.tsx` | `docs/design/Design_Dashboard_Detection_Display.md`, `docs/tc/TC_Dashboard_Detection_Display.md` |
| `i18n/translations/*.ts` | 해당 UI 컴포넌트의 Design 문서 UI 텍스트 섹션 |
| `App.tsx` (auth/role 변경) | `docs/design/Design_User_Authentication.md`, `docs/design/Design_Dashboard_Analysis_Mode.md` |
| 새 컴포넌트 추가 | PRD + SRS + Design + TC 문서 신규 작성 또는 관련 문서에 섹션 추가 |

**공통 규칙**
- **새 UI 컴포넌트** → Design 문서에 UI 구조·상태·이벤트 흐름 추가, TC에 렌더링·인터랙션 케이스 추가
- **Zustand 스토어 변경** → SRS 데이터 모델 섹션 업데이트
- **API 연동 변경** → Design의 데이터 플로우 다이어그램 및 TC 업데이트
- **반응형 레이아웃 변경** → `docs/design/Design_Mobile_Layout.md` + `docs/tc/TC_Mobile_Layout.md` 업데이트
- **i18n 키 추가** → 해당 화면의 Design 문서 UI 텍스트 항목 추가

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

## SERVER_MODE 기반 탭 노출 정책 (중요)

- 기준 위치: `client/src/App.tsx` (`serverMode`, `isStreaming`, `TAB_ITEMS`)
- `combined`: Cameras/Analytics 탭 모두 표시
- `streaming`: Analytics 탭 숨김
- `analysis`: 메인 영역은 `AnalysisServerDashboard.tsx`, 우측/모바일 탭은 **1개 탭** 표시:
  - `analytics` (VideoAnalyticsTab — 모듈 설정)
  - 이벤트 히스토리는 대시보드 카드 클릭 → `AnalysisDetectionPanel` 인라인 오버레이로 표시
- 모드 변경으로 현재 활성 탭이 유효하지 않으면 `analytics`로 자동 전환

```typescript
// App.tsx — analysis 탭 가드 (v1.7)
const ANALYSIS_TABS: SidebarTab[] = ['analytics'];
if (isAnalysis && !ANALYSIS_TABS.includes(sidebarTab)) {
  setSidebarTab('analytics');
}

// renderTabContent — analysis 분기
if (isAnalysis) {
  return <VideoAnalyticsTab />;
}
```

## Analysis Mode Dashboard

- `AnalysisServerDashboard.tsx`는 `/api/analysis/metrics`를 주기적으로 조회해 현재 활성 모듈, 입력 트래픽, 요청 동시성, 최근/누적 결과, 카메라별 부하를 보여줍니다.
- 대시보드 카드 클릭 시 **AnalysisDetectionPanel 오버레이** 표시 (사이드바 탭 이동 없음).
- `showEventHistory` 상태로 오버레이 제어; `onNavigateToTab` prop 제거.

```typescript
// AnalysisServerDashboard.tsx
const [showEventHistory, setShowEventHistory] = useState(false);

{showEventHistory && (
  <div className="absolute inset-0 z-20 rounded-[28px] overflow-hidden">
    <AnalysisDetectionPanel onClose={() => setShowEventHistory(false)} />
  </div>
)}
```

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

### alertService EventEmitter 연결 (index.js 버그 수정)

**문제:** Analysis 모드에서 `pipelineManager._alertService`와 `app.get('alertService')`가 **별개의 AlertService 인스턴스**였습니다. `analysisApi.js`가 `app.get('alertService').createAlert()`를 호출해도 socket.io로 전달되지 않아 Alerts 탭이 비어 있었습니다.

**수정 (index.js):**
```javascript
app.set('alertService', alertService);
app.set('db', db);

// index.js 인스턴스의 alert 이벤트를 socket.io로 직접 브로드캐스트
alertService.on('alert', (alert) => io.emit('alert:new', alert));
```

> `app.set('db', db)`도 함께 추가해야 `analysisApi.js` 라우트 핸들러에서 `req.app.get('db')`로 DB에 접근 가능합니다. 빠진 경우 `GET /api/analysis/events`가 503 에러를 반환합니다.
