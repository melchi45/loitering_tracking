# DESIGN DOCUMENT
# Dashboard Analysis Mode UI Adaptation

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-DAM-01 |
| **Version** | 2.0 |
| **Status** | Active |
| **Date** | 2026-07-30 |
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
10. [Analysis Mode Detections & Alerts 탭 (v1.5)](#10-analysis-mode-detections--alerts-탭-v15)

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

> **2026-07-30 갱신**: 이 섹션은 최초 설계 당시의 스냅샷이며, 이후 §10.2가 실제 최신 `TAB_ITEMS` 구성(analysis/combined/streaming 각각 별도 배열)으로 여러 차례 갱신되었다. `analytics` 탭 자체가 v2.0(§10.2)에서 완전히 제거되었으므로, 아래 코드 스니펫의 `analytics` 관련 줄은 더 이상 존재하지 않는다 — 배경 이해용으로만 유지.

`SERVER_MODE` 별 탭 정책 (PRD_Dashboard_Layout.md 4.4절, 최초 설계 당시 기준):
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

## 5. AnalysisServerDashboard 컴포넌트

`client/src/components/AnalysisServerDashboard.tsx` — Analysis 모드 메인 패널 전용 컴포넌트.  
App.tsx 인라인 JSX 변수(`AnalysisServerPanel`)에서 별도 파일로 분리되었으며, `/api/analysis/metrics`를 2초 간격으로 폴링하여 실시간 AI 서버 상태를 표시한다.

### 5.1 섹션 구성

| 순서 | 섹션 | 설명 |
|---|---|---|
| 1 | ANALYSIS FABRIC 헤더 | 소켓 상태, 마지막 응답 시각, 서버 타이틀 |
| 2 | KPI 카드 4개 | 처리량(fps), 입력 트래픽, 평균 추론 시간, 활성 컨텍스트 수 |
| 3 | 현재 분석 중인 항목 | 활성화된 분석 모듈 배지 목록 + 서비스 상태 + 최근 1분 결과 |
| 4 | 누적 분석 결과 | Frames / Detections / Tracked / Faces / Fire-Smoke / Loitering 총계 |
| 5 | 로드된 AI 모델 | ONNX 모델 목록 — 이름·서비스·로드 상태 표시 |
| 6 | 서버 리소스 사용률 | CPU·RAM·Process RSS·GPU 게이지 |
| **7** | **스트림별 부하 테이블** | **카메라별 fps 숫자 + FPS 스파크라인 그래프 / 트래픽 / 추론 시간 / 결과 카운트** |

### 5.2 로드된 AI 모델 섹션 (신규)

`/api/analysis/metrics` 응답의 `models` 배열(`OnnxModel[]`)을 렌더링한다.  
`metrics.models`가 비어있으면 섹션 자체가 숨겨진다.

```typescript
type OnnxModel = {
  name:    string;   // 파일명 (예: "yolov8s.onnx")
  path:    string;   // 절대 경로 (hover tooltip)
  service: string;   // 'detector' | 'ppe' | 'face-detect' | 'face-embed' | 'fire-smoke'
  loaded:  boolean;  // ONNX 세션 로드 성공 여부
  exists:  boolean;  // 파일 시스템 존재 여부
};
```

**서비스 레이블 매핑:**

| `service` | 표시 레이블 |
|---|---|
| `detector` | YOLOv8 — 객체 감지 |
| `ppe` | PPE — 안전모/마스크 |
| `face-detect` | SCRFD — 얼굴 감지 |
| `face-embed` | ArcFace — 얼굴 임베딩 |
| `fire-smoke` | 화재/연기 감지 |

**상태 인디케이터:**

| 조건 | 색상 | 텍스트 |
|---|---|---|
| `loaded && exists` | 초록 (glow) | 정상 로드 |
| `exists && !loaded` | 주황 | 로딩 실패 |
| `!exists` | 빨강 | 파일 없음 |

### 5.3 `/api/analysis/metrics` — `models` 필드

`analysisApi.js`의 `_getLoadedModels()` 함수가 생성한다:

```javascript
function _getLoadedModels() {
  const models = [];
  // detector (YOLOv8)
  if (_detector) {
    const mp = _detector.modelPath;
    models.push({ name: path.basename(mp), path: mp,
                  service: 'detector', loaded: true, exists: fs.existsSync(mp) });
  }
  // attrPipeline → ppe, face-detect, face-embed
  // fireSmokeService → fire-smoke
  return models;
}
```

`services.detector` 필드의 값:
- `'loaded'` — `_detector` 인스턴스 존재
- `'loading'` — `_loadPromise` 진행 중
- `'not-loaded'` — 인스턴스 없음 + 로드 미시작

### 5.4 Per-source 테이블 — FPS 스파크라인 (신규)

스트림별 부하 테이블의 "FPS(1s)" 컬럼을 **"FPS / 추이"** 컬럼으로 확장하여 숫자 값 아래에 SVG 스파크라인 그래프를 표시한다.

#### 데이터 흐름

```
/api/analysis/metrics 폴링 (2초)
       │
       └─► metrics.cameras[].inputFps1s
                  │
                  ▼
      fpsHistory: Map<cameraId, number[]>
      (최대 30개 = 약 60초 이력, 오래된 값 FIFO 제거)
                  │
                  ▼
      FpsSparkline({ data: number[] })
```

#### FpsSparkline 컴포넌트 사양

| 항목 | 값 |
|---|---|
| 크기 | 88 × 26 px SVG |
| 이력 크기 | `FPS_HISTORY_MAX = 30` (약 60초) |
| 렌더링 | SVG `<polyline>` + `<path>` area fill + 마지막 점 `<circle>` |
| 최솟값 보호 | `max = Math.max(...data, 1)` — 전체 0일 때 divide-by-zero 방지 |
| 데이터 부족 | 2개 미만이면 `—` 텍스트 표시 |
| 스트림 없음 | 마지막 점 dot을 slate 색으로 표시 |

```tsx
// 상태 선언 (컴포넌트 내)
const [fpsHistory, setFpsHistory] = useState<Map<string, number[]>>(new Map());

// 폴링 업데이트 (setMetrics와 함께 배치)
setFpsHistory(prev => {
  const next = new Map(prev);
  for (const cam of data.cameras) {
    const hist = next.get(cam.cameraId) ?? [];
    const updated = [...hist, cam.inputFps1s];
    next.set(cam.cameraId, updated.length > FPS_HISTORY_MAX
      ? updated.slice(-FPS_HISTORY_MAX) : updated);
  }
  return next;
});
```

#### 테이블 그리드 변경

| | 변경 전 | 변경 후 |
|---|---|---|
| 헤더 레이블 | `FPS(1s)` | `FPS / 추이` |
| 컬럼 너비 | `0.7fr` | `1.4fr` |
| 셀 내용 | fps 숫자 한 줄 | fps 숫자 + 스파크라인 SVG 스택 |

전체 grid: `[1.4fr_0.7fr_0.7fr_...]` → `[1.4fr_0.7fr_1.4fr_...]`

---

### 5.5 VideoAnalyticsTab — 🔥 Fire / Smoke Sensitivity 패널 (2026-07-30부로 이관됨)

> **2026-07-30 갱신**: `VideoAnalyticsTab.tsx`와 analysis 모드 사이드바의 Analytics 탭 자체가 완전히 제거되었다 (§10.2 v2.0 참고) — 이 섹션이 기술하는 UI/상태는 더 이상 존재하지 않는다. Fire/Smoke Sensitivity 패널(및 Analytics 카테고리 On/Off, Appearance Weights, Tracker/Kalman Settings)은 모두 Admin Dashboard → AI Models 탭(`AiModelsSection`, `client/src/pages/admin/AdminUsersPage.tsx`)의 "Tracking & Sensitivity Tuning" 섹션으로 이동했다. 아래 엔드포인트/`fireSmokeService.js` 변경 내역은 백엔드 계약이 그대로이므로 유효하지만, "VideoAnalyticsTab 상태 및 UI" 서브섹션은 새 위치의 동일한 state/handler로 대체되었다고 이해할 것 — 상세: `docs/design/Design_Admin_Dashboard.md` §4.2, `docs/design/Design_AI_Model_Catalog.md`.

`VideoAnalyticsTab.tsx` 우측 사이드바의 Analytics 탭에 화재/연기 감지 임계값을 런타임으로 조정하는 접이식 패널을 추가한다. (아래는 2026-07-30 이전의 원본 설계 — 배경 이해용으로 유지)

#### 새 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/analysis/config/fire-smoke` | 현재 conf/NMS 임계값 조회 |
| `PATCH` | `/api/analysis/config/fire-smoke` | conf/NMS 임계값 업데이트 |

응답/요청 스키마:
```json
{ "confThreshold": 0.35, "nmsThreshold": 0.45, "available": true }
```

`available: false` 또는 404 응답 시 패널은 렌더링되지 않는다.

#### FireSmokeService 변경

`fireSmokeService.js`의 `CONF_THRESHOLD` / `NMS_THRESHOLD` 모듈 상수를 **인스턴스 프로퍼티**로 승격:

```javascript
// 인스턴스 초기값 (env var에서)
this.confThreshold = CONF_THRESHOLD;
this.nmsThreshold  = NMS_THRESHOLD;

// 런타임 업데이트
setThresholds({ confThreshold, nmsThreshold }) { ... }
```

`_postprocess(data, dims, origW, origH, scale, padL, padT, confThreshold, nmsThreshold)` — 임계값을 파라미터로 전달.

#### VideoAnalyticsTab 상태 및 UI

```typescript
const [fireSmokeConfig, setFireSmokeConfig] = useState<FireSmokeConfig>({ confThreshold: 0.35, nmsThreshold: 0.45 });
const [fireSmokeOpen, setFireSmokeOpen]     = useState(false);
const [fireSmokeAvailable, setFireSmokeAvailable] = useState(false);
```

| 슬라이더 | 범위 | 스텝 | 기본값 | 설명 |
|---|---|---|---|---|
| Conf Threshold | 0.05 ~ 0.95 | 0.05 | 0.35 | 낮을수록 감도 ↑ (false positive 증가) |
| NMS IoU Threshold | 0.10 ~ 0.90 | 0.05 | 0.45 | 낮을수록 겹치는 박스 적게 유지 |

- 슬라이더 변경 시 **300ms debounce** 후 `PATCH /api/analysis/config/fire-smoke` 자동 호출
- Reset Defaults 버튼: `{ confThreshold: 0.35, nmsThreshold: 0.45 }` 으로 복원
- `fireSmokeAvailable = false` (analysis 서버 미연결 또는 모델 없음) 시 패널 비표시

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
└── AccessDeniedPage.tsx            # admin 외 역할 접근 차단 페이지

client/src/components/
└── AnalysisServerDashboard.tsx     # analysis 모드 전용 대시보드 컴포넌트
                                    # (App.tsx 인라인 AnalysisServerPanel에서 분리)
```

### 9.3 index.js React UI 서빙 정책

모든 SERVER_MODE에서 React SPA를 서빙한다. 브라우저는 `GET /health` 응답의 `serverMode` 값으로 적절한 대시보드를 렌더링한다.

```js
// 모든 모드에서 동일하게 React static 서빙
const clientBuildPath = path.resolve(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientBuildPath));
app.get(/^(?!\/api|\/auth|...).*/, (req, res) => res.sendFile(indexHtml));
```

> **과거 이슈**: analysis 모드에서 Socket.IO connect/transport-close 루프가 발생해 일시적으로 UI 서빙을 비활성화했었음. analysisApi.js의 dead `io.emit()` 제거 및 App.tsx 카메라 구독 게이팅(`!isAnalysis`) 완료 후 안전하게 재활성화.

### 9.4 영향받지 않는 파일

- `CameraGrid.tsx`, `CameraView.tsx` — 수정 없음 (렌더링 조건만 App.tsx에서 제어)
- `AlertPanel.tsx`, `ZonesPanel.tsx`, `FaceGalleryTab.tsx` 등 사이드바 컴포넌트 — 수정 없음
- Zustand 스토어 — 수정 없음
- `useSocket.ts` 훅 — 수정 없음

---

## 10. Analysis Mode 이벤트 히스토리 (v1.7)

### 10.1 개요

Analysis 모드에서 AI가 감지한 이벤트(화재, 연기, 배회)를 영구 저장하고, 대시보드 카드 클릭 시 날짜·시간 그룹별 이벤트 히스토리를 오버레이로 표시합니다. 크롭 이미지도 함께 저장·표시됩니다.

### 10.2 사이드바 탭 — analysis 모드 (v2.0 변경)

**변경 이력**:
```
v1.5: [ 🤖 Analytics ] [ 👁 Detections ] [ 🔔 Alerts ]
v1.7: [ 🤖 Analytics ]                   ← Analytics 탭 1개만
v1.8: [ 🤖 Analytics ] [ 👁 Detections ] ← Detections 탭 재도입 (실시간 감지)
v2.0: [ 👁 Detections ]                  ← Analytics 탭 완전 제거, Admin AI Models로 통합
```

**v2.0 (2026-07-30)**: Analytics 탭(`VideoAnalyticsTab.tsx`)이 완전히 삭제되었다 — 카테고리 On/Off 토글 전체 카탈로그(COCO 80종 포함), Appearance Weights, Tracker/Kalman Settings, Fire/Smoke Sensitivity가 모두 Admin Dashboard → AI Models(`AiModelsSection`)로 이관되어, model Active/Deactivate(어떤 ONNX가 각 family를 담당하는지)와 명확히 분리된 "Analytics Categories (On/Off)" 섹션·"Tracking & Sensitivity Tuning" 섹션으로 재구성되었다. analysis 모드 사이드바는 이제 Detections 탭 하나만 남는다. 상세: `docs/design/Design_Admin_Dashboard.md` §4.2 (v1.1), `docs/design/Design_AI_Model_Catalog.md`.

`App.tsx` (v2.0):
```typescript
const ANALYSIS_TABS: SidebarTab[] = ['detections'];
const TAB_ITEMS = isAnalysis
  ? [
      { id: 'detections' as SidebarTab, icon: '👁',  label: t.tabDetections },
    ]
  : [...]; // combined/streaming 탭
```

`renderTabContent()` (analysis 분기, v1.9):
```typescript
function renderTabContent(overrideTab?: SidebarTab) {
  const tab = overrideTab ?? sidebarTab;
  if (tab === 'detections') return isAnalysis ? <AnalysisEventsTab /> : <DashboardDetectionPanel />;
  // ...
}
```

**Detections 탭 동작 (analysis 모드, v1.9)**:
- `AnalysisEventsTab`이 `/api/analysis/events` 폴링 → 날짜·시간별 이벤트 히스토리 표시 (배회/화재/연기)
- 실시간 감지 피드(`DashboardDetectionPanel`)는 **별도 UI**로 이동 → `AnalysisLivePanel` 오버레이 참조 (Section 10.4a)

### 10.3 AnalysisDetectionPanel — 이벤트 히스토리 브라우저 (v1.7 재작성)

**파일**: `client/src/components/AnalysisDetectionPanel.tsx`

**Props**: `{ onClose?: () => void }`

**기능 (v1.7 — 날짜 그룹별 히스토리 브라우저)**:
- `GET /api/analysis/events?limit=200` 폴링 (5초, 자동/일시정지 토글)
- 날짜별 그룹핑 (`useMemo`): 최신 날짜 순 정렬
- `EventRow` 클릭 시 확장: 메타 정보 + 크롭 이미지 표시
- 이벤트 타입 필터 (`전체 / 🔥 화재 / 💨 연기 / 🚶 배회`)
- 이벤트 전체 삭제 (`DELETE /api/analysis/events`)
- `onClose` prop 제공 시 닫기 버튼 표시 (오버레이 모드)
- 크롭 이미지 클릭 → 새 탭에서 원본 확대 표시

**날짜 그룹 UI 구조**:
```
┌─────────────────────────────────────────┐
│  2026년 6월 10일 화요일 (3건)            │ ← date header
├─────────────────────────────────────────┤
│  🔥 화재  카메라01  14:23:05      ▾     │ ← EventRow (collapsed)
│  🚶 배회  카메라02  14:20:11      ▾     │
│  💨 연기  카메라01  14:15:44      ▾     │
├─────────────────────────────────────────┤
│  2026년 6월 9일 월요일 (7건)            │
│  ...                                    │
└─────────────────────────────────────────┘
```

**EventRow 확장 시**:
```
┌─────────────────────────────────────────┐
│  🔥 화재  카메라01  14:23:05      ▲     │
│─────────────────────────────────────────│
│  신뢰도: 87.3%                          │
│  bbox (120, 80, 64×48)                  │
│  [24×24 크롭 이미지] 감지 영역 스냅샷.  │
│                      클릭하면 확대합니다│
└─────────────────────────────────────────┘
```

### 10.4 AnalysisServerDashboard 오버레이 (v1.9)

v1.9부터 두 가지 오버레이가 공존합니다:

| 오버레이 | 컴포넌트 | 트리거 stat 카드 | 내용 |
|---|---|---|---|
| 이벤트 히스토리 | `AnalysisDetectionPanel` | 알림 (배회 누적) | DB 저장 이벤트 (배회/화재/연기) |
| 실시간 감지 피드 | `AnalysisLivePanel` | **감지 이벤트 (누적)** | 실시간 감지 피드 (`DashboardDetectionPanel`) |

```typescript
// AnalysisServerDashboard.tsx (v1.9)
const [showEventHistory,   setShowEventHistory]   = useState(false);
const [showLiveDetections, setShowLiveDetections] = useState(false);

// 이벤트 히스토리 오버레이
{showEventHistory && (
  <div className="absolute inset-0 z-20 rounded-[28px] overflow-hidden">
    <AnalysisDetectionPanel onClose={() => setShowEventHistory(false)} />
  </div>
)}

// 실시간 감지 피드 오버레이
{showLiveDetections && (
  <div className="absolute inset-0 z-20 rounded-[28px] overflow-hidden">
    <AnalysisLivePanel onClose={() => setShowLiveDetections(false)} />
  </div>
)}
```

- "감지 이벤트 (누적)" 카드 → `setShowLiveDetections(true)` (v1.9 변경)
- "알림 (배회 누적)" 카드 → `setShowEventHistory(true)` (유지)

### 10.4a AnalysisLivePanel — 실시간 감지 피드 오버레이 (v1.9 신규)

**파일**: `client/src/components/AnalysisLivePanel.tsx`

**Props**: `{ onClose?: () => void }`

**역할**: `DashboardDetectionPanel`을 analysis 대시보드 내부 전체화면 오버레이로 감싸는 래퍼 컴포넌트.  
실시간 감지 피드를 Detections 탭이 아닌 stat 카드 클릭으로 접근하도록 연결합니다.

**기능 (DashboardDetectionPanel 포함)**:
- 실시간 탐지 목록: `detections` Socket.IO 이벤트 → `useAllDetections` 훅
- 스냅샷 썸네일: `snapshot:new` 이벤트 → `cropMap` 인메모리 캐시
- Person Trails: `person:trajectory-update` 이벤트 → `usePersonTrajectoryStore`
- Cross-Camera Re-ID 피드: `face:reidentified` → `useCrossCameraStore`
- 의상 Re-ID: `clothing:reidentified` → `useClothingReIdStore`
- 카메라 미등록(analysis 모드) 시 `cameraId.slice(0, 8)` 약칭으로 표시

**구현 패턴**:
```tsx
// AnalysisLivePanel.tsx
export default function AnalysisLivePanel({ onClose }: Props) {
  return (
    <div className="relative flex flex-col h-full bg-gray-950 overflow-hidden">
      {onClose && (
        <button onClick={onClose} className="absolute top-2 right-2 z-10 ...">✕</button>
      )}
      <DashboardDetectionPanel />
    </div>
  );
}
```

**UI 레이아웃**:
```
┌─────────────────────────────────────────────────┐
│  [카메라 필터]  obj:12  loiter:2            ✕   │ ← DashboardDetectionPanel 상단 바 + 오른쪽 상단 닫기 버튼
├─────────────────────────────────────────────────┤
│  [PERSON] [FIRE] [FACE] [ALL]                   │ ← 카테고리 필터
├─────────────────────────────────────────────────┤
│  [thumbnail] person·1s  P1 X-CAM                │
│  [thumbnail] person·5s  LOITER                  │
│  ...                                            │ ← 실시간 감지 목록
├─────────────────────────────────────────────────┤
│  ▼ Person Trails (3)                            │
│    P1 [F123] cam1 → ►cam2  total 2m30s          │
├─────────────────────────────────────────────────┤
│  ▼ Cross-Camera Re-ID (2)                       │
│    P1 [F123] cam1 → cam2  92%                   │
└─────────────────────────────────────────────────┘
```

### 10.5 analysisEvents 크롭 이미지 저장 (v1.7)

**`server/src/routes/analysisApi.js`** 변경:

```javascript
const snapshotSvc = require('../services/snapshotService');

async function _cropThumbnail(jpegBuffer, bbox, fw, fh) {
  if (!jpegBuffer || !bbox || !fw || !fh) return null;
  try {
    const { data } = await snapshotSvc.cropJpeg(jpegBuffer, bbox, fw, fh);
    return 'data:image/jpeg;base64,' + data.toString('base64');
  } catch { return null; }
}
```

- `_persistFireSmoke` / `_persistLoitering` → async, `jpegBuffer, fw, fh` 파라미터 추가
- `cropData: await _cropThumbnail(...)` 를 이벤트 객체에 저장
- persist 호출을 `res.json()` 이후 fire-and-forget으로 이동 (HTTP 응답 지연 방지)

```javascript
res.json({ cameraId, frameId, ... });
// ── Persist after response (non-blocking) ─
if (db) {
  if (fireSmoke.length > 0) _persistFireSmoke(..., jpegBuffer, frameWidth, frameHeight).catch(() => {});
  if (behaviors.length > 0) _persistLoitering(..., jpegBuffer, frameWidth, frameHeight).catch(() => {});
}
```

**이벤트 스키마** (`analysisEvents` 컬렉션) — v1.7 추가 필드:
```json
{
  "id": "uuid",
  "type": "fire | smoke | loitering",
  "cameraId": "string",
  "cameraName": "string",
  "timestamp": "ISO 8601",
  "confidence": 0.0-1.0,
  "bbox": { "x", "y", "width", "height" },
  "objectId": 0,
  "dwellTime": 0.0,
  "zoneId": "string",
  "zoneName": "string",
  "riskScore": 0.0-1.0,
  "cropData": "data:image/jpeg;base64,..."   // ← v1.7 신규
}
```

### 10.6 API 엔드포인트 (변경 없음)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/analysis/events` | 최근 분석 이벤트 조회 (query: `limit`, `type`) |
| DELETE | `/api/analysis/events` | 모든 분석 이벤트 삭제 |

**analysisProxy.js** (streaming 모드): `GET /api/analysis/events` 프록시 유지

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-08 | 초기 작성 — Analysis Mode UI 분기, AnalysisServerPanel 인라인 컴포넌트, i18n, /health API |
| 1.1 | 2026-06-09 | combined 모드 URL 분기(`/analysis`), AccessDeniedPage, Profile 드롭다운 대시보드 전환 추가 |
| 1.2 | 2026-06-10 | Section 5 재작성: AnalysisServerDashboard.tsx 분리, ONNX 모델 섹션(5.2·5.3) 추가 |
| 1.3 | 2026-06-10 | Section 5.4 추가: Per-source 테이블에 FpsSparkline 그래프 컬럼 추가 |
| 1.4 | 2026-06-10 | Section 5.5 추가: VideoAnalyticsTab Fire/Smoke Sensitivity 슬라이더 패널, `/api/analysis/config/fire-smoke` 엔드포인트, fireSmokeService 인스턴스 프로퍼티 승격 |
| 1.5 | 2026-06-10 | Section 10 추가: Analysis Mode Detections/Alerts 사이드바 탭, AnalysisDetectionPanel, 이벤트 DB 저장, /api/analysis/events 엔드포인트, AnalysisServerDashboard 클릭 가능 카드 |
| 1.6 | 2026-06-10 | 버그 수정 반영: `db.js` ALL_TABLES에 `analysisEvents` 추가 (HTTP 500 수정), `index.js`에서 alertService EventEmitter를 socket.io에 직접 연결 (Alerts 탭 실시간 전파 수정), `app.set('db', db)` 추가 |
| 1.7 | 2026-06-10 | Section 10 전면 재작성: analysis 모드 탭 analytics 단일화, AnalysisDetectionPanel 날짜 그룹별 히스토리 브라우저로 재구현, AnalysisServerDashboard 내부 오버레이 방식, cropData 크롭 이미지 저장·표시 |
| 1.8 | 2026-06-10 | Section 10.2 업데이트: analysis 모드에 Detections 탭 재도입 (`DashboardDetectionPanel` + global `io.emit()` 수신) |
| 1.9 | 2026-06-10 | Section 10.2/10.4/10.4a 업데이트: 실시간 감지 피드를 Detections 탭에서 분리 — `AnalysisLivePanel` 신규 컴포넌트 도입, "감지 이벤트 (누적)" 카드 클릭 시 오버레이로 표시. Detections 탭은 `AnalysisEventsTab` (히스토리)으로 복귀 |
| 2.0 | 2026-07-30 | Section 5.5/10.2 갱신 — Analytics 탭(`VideoAnalyticsTab.tsx`) 완전 제거, 내용 전부(카테고리 On/Off 전체 카탈로그·Appearance Weights·Tracker/Kalman·Fire/Smoke Sensitivity) Admin Dashboard → AI Models(`AiModelsSection`)로 이관 및 Active/Deactivate와 명확히 분리. analysis 모드 사이드바는 Detections 탭 1개만 남음 |

