# DESIGN DOCUMENT
# Dashboard Analysis Mode UI Adaptation

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-DAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Parent SRS** | [srs/SRS_Dashboard_Analysis_Mode.md](../srs/SRS_Dashboard_Analysis_Mode.md) |
| **Parent PRD** | [prd/PRD_Dashboard_Analysis_Mode.md](../prd/PRD_Dashboard_Analysis_Mode.md) |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Changes — App.tsx](#2-component-changes--apptsx)
3. [Server API Changes — /health](#3-server-api-changes--health)
4. [UI Layout — Analysis Mode vs Combined Mode](#4-ui-layout--analysis-mode-vs-combined-mode)
5. [AnalysisServerPanel 인라인 컴포넌트](#5-analysisserverpanel-인라인-컴포넌트)
6. [i18n 변경](#6-i18n-변경)
7. [Data Flow](#7-data-flow)
8. [Sequence Diagrams](#8-sequence-diagrams)
9. [File & Module Layout](#9-file--module-layout)

---

## 1. Architecture Overview

```
Browser (App.tsx)
       │
       │ mount
       ▼
GET /health ──────────────────────────────► server/src/index.js
                                                    │
                                            { serverMode: SERVER_MODE }
       │
       ◄──────────────────────────────────────────
       │
setServerMode(data.serverMode)
setSidebarTab("alerts")  [analysis 모드만]
       │
       ▼
isAnalysis = (serverMode === 'analysis')
       │
       ├─[true]──► Analysis Mode UI
       │           ├─ 헤더 배지 표시
       │           ├─ 카메라 수 / 레이아웃 피커 숨김
       │           ├─ main 영역 → AnalysisServerPanel
       │           └─ TAB_ITEMS = [alerts, zones, detections, analytics, faces]
       │
       └─[false]─► Combined Mode UI (기존 동작 100% 유지)
                   ├─ 헤더: 카메라 수 + 레이아웃 피커 표시
                   ├─ main 영역 → CameraGrid
                   └─ TAB_ITEMS = [cameras, alerts, zones, detections, analytics, faces]
```

---

## 2. Component Changes — App.tsx

### 2.1 신규 State

```tsx
const [serverMode, setServerMode] = useState<string | null>(null);
```

- `null`: `/health` 응답 대기 중 또는 호출 실패 → combined UI 렌더링
- `"analysis"`: 분석 모드 UI 전환
- `"combined"` / `"streaming"`: combined UI 유지

### 2.2 신규 State — URL 기반 경로

```tsx
const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
```

combined 모드에서 두 대시보드를 URL로 구분하기 위해 추가.

```tsx
function navigateDashboard(path: '/' | '/analysis') {
  window.history.pushState({}, '', path);
  setCurrentPath(path);
}
```

`react-router-dom` 없이 `history.pushState` 패턴을 사용 — SPA fallback 라우팅과 호환.

streaming 모드에서 `/analysis` 접근 시 자동으로 `/`로 리다이렉트:

```tsx
useEffect(() => {
  if (serverMode === 'streaming' && currentPath === '/analysis') {
    window.history.replaceState({}, '', '/');
    setCurrentPath('/');
  }
}, [serverMode, currentPath]);
```

### 2.3 신규 파생 변수

```tsx
const isAnalysis = serverMode === 'analysis' ||
  (serverMode === 'combined' && currentPath === '/analysis');

const isCombined = serverMode === 'combined';
```

| 조건 | isAnalysis | 표시 UI |
|---|---|---|
| `serverMode === 'analysis'` | true | Analysis Dashboard |
| `serverMode === 'combined' && path === '/analysis'` | true | Analysis Dashboard |
| `serverMode === 'combined' && path === '/'` | false | Streaming Dashboard |
| `serverMode === 'streaming'` | false | Streaming Dashboard |

모든 조건부 렌더링은 `isAnalysis` 단일 변수를 기준으로 한다.

### 2.3 `/health` Fetch (useEffect)

```tsx
useEffect(() => {
  fetch('/health')
    .then((r) => r.json())
    .then((data: { serverMode?: string }) => {
      if (data.serverMode) {
        setServerMode(data.serverMode);
        if (data.serverMode === 'analysis') setSidebarTab('alerts');
      }
    })
    .catch(() => {});
}, []);
```

의존성 배열이 비어 있어 마운트 시 1회만 실행된다.

### 2.4 TAB_ITEMS 조건부 구성

`SERVER_MODE` 별 탭 정책 (PRD_Dashboard_Layout.md 4.4절):
- `combined`: 전체 탭 표시
- `streaming`: CAMERAS, ALERTS, ZONES, DETECTIONS, FACE ID — **ANALYTICS 숨김**
- `analysis`: ALERTS, ZONES, DETECTIONS, ANALYTICS, FACE ID — **CAMERAS 숨김**

```tsx
const isAnalysis = serverMode === 'analysis';
const isStreaming = serverMode === 'streaming';
const TAB_ITEMS = [
  !isAnalysis && { id: 'cameras' as SidebarTab, icon: '📷', label: t.tabCameras },
  { id: 'alerts'     as SidebarTab, icon: '🔔', label: t.tabAlerts },
  { id: 'zones'      as SidebarTab, icon: '🗺',  label: t.tabZones },
  { id: 'detections' as SidebarTab, icon: '👁',  label: t.tabDetections },
  !isStreaming && { id: 'analytics'  as SidebarTab, icon: '🤖', label: t.tabVideoAnalytics },
  { id: 'faces'      as SidebarTab, icon: '🪪',  label: t.tabFaceGallery },
].filter(Boolean) as { id: SidebarTab; icon: string; label: string }[];
```

모드 전환 시 현재 탭이 숨겨진 탭이면 유효한 탭으로 이동:

```tsx
useEffect(() => {
  if (serverMode === 'analysis' && sidebarTab === 'cameras') setSidebarTab('alerts');
  if (serverMode === 'streaming' && sidebarTab === 'analytics') setSidebarTab('detections');
}, [serverMode, sidebarTab]);
```

### 2.5 Admin 전용 접근 제어

`App` 컴포넌트에서 role 체크를 수행한다:

```tsx
// App.tsx — 라우팅 분기
if (auth.page === 'signin')  return <SignInPage />;
if (auth.page === 'pending') return <PendingPage />;
if (auth.page === 'admin')   return <AdminUsersPage />;
if (auth.user?.role !== 'admin') return <AccessDeniedPage />; // ← role gate
return <Dashboard />;
```

- `role === 'admin'`인 경우에만 Streaming/Analysis Dashboard 진입 가능
- `operator`, `viewer` 역할은 `AccessDeniedPage` 렌더링
- `AUTH_ENABLED=false` (개발 모드)에서는 role이 `'admin'`으로 고정되므로 영향 없음

`client/src/pages/AccessDeniedPage.tsx`:
- 현재 로그인 계정(email, role) 표시
- "다른 계정으로 로그인" 버튼 → `auth.logout()` 호출

### 2.6 Profile 드롭다운 — 대시보드 전환 (combined 모드)

combined 모드에서 Profile 아이콘 드롭다운 메뉴에 대시보드 전환 버튼 추가:

```
Profile 드롭다운
├── 👤 Profile
├── 👥 User Management   (admin만)
├── ──────────────────── (combined 모드만)
├── 📹 Streaming Dashboard   ← navigateDashboard('/')
└── ⊞  Analysis Dashboard    ← navigateDashboard('/analysis')
```

- `isCombined` 조건 시에만 렌더링 (단일 모드에서는 표시 안 함)
- 현재 활성 대시보드는 색상 강조(파란색/amber) + `●` 마커
- 활성 대시보드 버튼은 `cursor-default` (클릭 불필요)

### 2.7 데스크톱 헤더 조건부 렌더링

```tsx
{/* Analysis 모드 배지 */}
{serverMode === 'analysis' && (
  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full
    bg-amber-500/20 border border-amber-500/40 text-amber-400 text-xs font-medium">
    <svg className="w-3 h-3 flex-shrink-0" ...정보 아이콘... />
    {t.serverModeAnalysis}
  </span>
)}

{/* 카메라 수 — analysis 모드에서 숨김 */}
{!isAnalysis && (
  <span className="text-xs text-gray-400">
    {cameras.filter(...).length}/{cameras.length} {t.live}
  </span>
)}

{/* 레이아웃 피커 — analysis 모드에서 숨김 */}
{!isAnalysis && (
  <LayoutPicker current={layout} onChange={...} />
)}
```

### 2.6 데스크톱 메인 영역 분기

```tsx
<main className="flex-1 overflow-hidden p-2 relative">
  {isAnalysis ? AnalysisServerPanel : (() => {
    // 기존 CameraGrid + 페이지 이동 버튼 + DiscoveredCameraPanel
  })()}
</main>
```

### 2.7 모바일 조건부 분기

```tsx
{!isAnalysis && sidebarTab === 'cameras' ? (
  // 카메라 그리드 + CameraList 스와이프 뷰
) : (
  // 풀스크린 탭 콘텐츠
)}
```

---

## 3. Server API Changes — /health

### 3.1 수정 파일

**`server/src/index.js`** — `/health` 핸들러

```js
app.get('/health', (req, res) => {
  res.json({
    status:     'ok',
    uptime:     process.uptime(),
    timestamp:  new Date().toISOString(),
    db:         'connected',
    serverMode: SERVER_MODE,          // ← 신규 필드
  });
});
```

`SERVER_MODE`는 모듈 스코프 상수(`const SERVER_MODE = process.env.SERVER_MODE || 'combined'`)이므로 런타임 추가 비용 없음.

---

## 4. UI Layout — Analysis Mode vs Combined Mode

### 4.1 데스크톱 레이아웃 비교

```
── Combined Mode ──────────────────────────────────────────────────
┌─────────────────────────────────────────────────────────────────┐
│ [LTS] LTS Dashboard   ●Connected  [Search]  3/5 live [4▾] [📊][⚙][👤] │
├───────────────────────────────────────┬─────────────────────────┤
│                                       │ [📷][🔔][🗺][👁][🤖][🪪] │
│         CameraGrid                    ├─────────────────────────┤
│   (카메라 스트림 타일)                  │                         │
│                                       │   사이드바 탭 콘텐츠      │
│                              ◄  ►    │                         │
└───────────────────────────────────────┴─────────────────────────┘

── Analysis Mode ──────────────────────────────────────────────────
┌─────────────────────────────────────────────────────────────────┐
│ [LTS] LTS Dashboard [분석 전용 서버]  ●Connected  [Search] [📊][⚙][👤] │
├───────────────────────────────────────┬─────────────────────────┤
│                                       │ [🔔][🗺][👁][🤖][🪪]   │
│      ⬡  분석 전용 서버                 ├─────────────────────────┤
│   이 서버는 AI 추론만 처리합니다.        │                         │
│                                       │   사이드바 탭 콘텐츠      │
│   [Socket: Connected] [Mode: analysis]│                         │
└───────────────────────────────────────┴─────────────────────────┘
```

### 4.2 모바일 레이아웃 비교

```
── Combined Mode ──────    ── Analysis Mode ──────
┌─────────────────────┐    ┌─────────────────────┐
│[LTS] LTS  ● 3/5live │    │[LTS] LTS [분석서버] ● │
│                     │    │                     │
│   (Camera Grid /    │    │   (탭 콘텐츠 풀스크린) │
│    Camera List)     │    │                     │
│                     │    │                     │
├─────────────────────┤    ├─────────────────────┤
│[📷][🔔][🗺][👁][🤖][🪪]│    │[🔔][🗺][👁][🤖][🪪]  │
└─────────────────────┘    └─────────────────────┘
```

---

## 5. AnalysisServerPanel 인라인 컴포넌트

`AnalysisServerPanel`은 별도 파일이 아닌 `App.tsx` 내 인라인 JSX 변수로 정의된다. 이 패널은 재사용될 용도가 없고 `connected`, `t` 등 Dashboard 컴포넌트 스코프 변수를 직접 참조하기 때문이다.

```tsx
const AnalysisServerPanel = (
  <div className="flex flex-col h-full items-center justify-center gap-6 p-8 text-center">
    {/* 아이콘 + 타이틀 */}
    <div className="flex flex-col items-center gap-3">
      <div className="w-14 h-14 rounded-full bg-amber-500/20 border border-amber-500/40
        flex items-center justify-center">
        <svg className="w-7 h-7 text-amber-400" ...파이프라인 아이콘... />
      </div>
      <div>
        <p className="text-base font-semibold text-amber-400">{t.serverModeAnalysis}</p>
        <p className="text-xs text-gray-400 mt-1 max-w-xs">{t.serverModeAnalysisDesc}</p>
      </div>
    </div>

    {/* 상태 카드 2개 */}
    <div className="grid grid-cols-2 gap-3 w-full max-w-sm text-left">
      <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Socket</p>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
          <span className={`text-xs font-medium ${connected ? 'text-green-400' : 'text-red-400'}`}>
            {connected ? t.connected : t.disconnected}
          </span>
        </div>
      </div>
      <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Mode</p>
        <span className="text-xs font-medium text-amber-400">analysis</span>
      </div>
    </div>
  </div>
);
```

---

## 6. i18n 변경

### 6.1 신규 키

| 키 | en | ko |
|---|---|---|
| `serverModeAnalysis` | `"Analysis Server"` | `"분석 전용 서버"` |
| `serverModeAnalysisDesc` | `"This server processes AI inference only. Camera streams are managed by a separate streaming server."` | `"이 서버는 AI 추론만 처리합니다. 카메라 스트림은 별도의 스트리밍 서버에서 관리됩니다."` |

### 6.2 적용 위치

- `serverModeAnalysis`: 헤더 배지 텍스트, AnalysisServerPanel 제목
- `serverModeAnalysisDesc`: AnalysisServerPanel 설명 텍스트

### 6.3 파일 목록

```
client/src/i18n/translations/
├── en.ts    ← serverModeAnalysis + serverModeAnalysisDesc
├── ko.ts    ← 한국어 번역
├── ar.ts, de.ts, es.ts, fr.ts, hi.ts, id.ts, ja.ts
├── pt.ts, ru.ts, tr.ts, vi.ts, zh-CN.ts, zh-TW.ts
   (나머지 13개: "Analysis Server" 영문 기본값 사용)
```

---

## 7. Data Flow

### 7.1 페이지 로드 플로우

```
Browser                          Server (/health)
   │                                   │
   │ [mount]                           │
   │                                   │
   │ GET /health ─────────────────────►│
   │                                   │ SERVER_MODE 환경변수 읽기
   │                        JSON ◄─────│ { serverMode: "analysis" }
   │                                   │
   │ setServerMode("analysis")         │
   │ setSidebarTab("alerts")           │
   │                                   │
   │ [re-render]                       │
   │ isAnalysis = true                 │
   │ → AnalysisServerPanel             │
   │ → TAB_ITEMS (cameras 제외)        │
   │ → 헤더 배지 표시                   │
```

### 7.2 소켓 연결 상태 반영

AnalysisServerPanel 내 소켓 상태는 기존 `useSocket()` 훅의 `connected` 값을 그대로 참조한다. 별도 구독 로직 없음.

---

## 8. Sequence Diagrams

### 8.1 정상 흐름 (analysis 서버 접속)

```
Browser           /health API         App.tsx render
   │                  │                    │
   │ mount            │                    │
   │─────────────────►│                    │
   │                  │ { serverMode: "analysis" }
   │◄─────────────────│                    │
   │                  │                    │
   │ setServerMode("analysis")             │
   │ setSidebarTab("alerts")               │
   │                                       │
   │ ─────────────────────────────────────►│
   │                                  isAnalysis=true
   │                                  헤더 배지 렌더링
   │                                  AnalysisServerPanel 렌더링
   │                                  TAB_ITEMS [🔔🗺👁🤖🪪]
```

### 8.2 폴백 흐름 (/health 실패)

```
Browser           /health API         App.tsx render
   │                  │                    │
   │ mount            │                    │
   │─────────────────►│                    │
   │                  │ (네트워크 오류)      │
   │◄─────────────────│ catch(() => {})    │
   │                                       │
   │ serverMode = null (변경 없음)          │
   │ ─────────────────────────────────────►│
   │                                  isAnalysis=false
   │                                  기존 combined UI
```

---

## 9. File & Module Layout

### 9.1 수정 파일

```
server/src/
└── index.js                  # /health 응답에 serverMode 필드 추가

client/src/
├── App.tsx                   # serverMode state, isAnalysis 분기, AnalysisServerPanel
└── i18n/translations/
    ├── en.ts                 # serverModeAnalysis + serverModeAnalysisDesc 추가
    ├── ko.ts                 # 한국어 번역 추가
    └── *.ts (×13)            # 나머지 언어 파일에 키 추가
```

### 9.2 신규 파일

```
client/src/pages/
└── AccessDeniedPage.tsx   # admin 외 역할 접근 차단 페이지
```

AnalysisServerPanel은 App.tsx 내 인라인 JSX 변수로 별도 파일 없음.

### 9.3 영향받지 않는 파일

- `CameraGrid.tsx`, `CameraView.tsx` — 수정 없음 (렌더링 조건만 App.tsx에서 제어)
- `AlertPanel.tsx`, `ZonesPanel.tsx`, `FaceGalleryTab.tsx` 등 사이드바 컴포넌트 — 수정 없음
- Zustand 스토어 — 수정 없음
- `useSocket.ts` 훅 — 수정 없음
