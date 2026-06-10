# DESIGN DOCUMENT
# Dashboard Layout — LTS-2026 Loitering Tracking System

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-DL-01 |
| **Version** | 1.2 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_Dashboard_Layout.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Component Tree](#3-component-tree)
4. [State Management Design](#4-state-management-design)
5. [Socket.IO Subscription Design](#5-socketio-subscription-design)
6. [TypeScript Interface Definitions](#6-typescript-interface-definitions)
7. [REST API Integration](#7-rest-api-integration)
8. [Responsive & Mobile Considerations](#8-responsive--mobile-considerations)
9. [Sequence Diagrams](#9-sequence-diagrams)
10. [Error Handling](#10-error-handling)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        App.tsx (Root)                            │
│                                                                  │
│  ┌─────────┐  ┌──────────────────────────────┐  ┌────────────┐ │
│  │ Header  │  │   CameraGrid (flex-1)         │  │  Sidebar   │ │
│  │  44px   │  │   channelOffset + layoutId    │  │  288px     │ │
│  └─────────┘  │   WebRTC video streams        │  │  (resize)  │ │
│               └──────────────────────────────┘  └────────────┘ │
│                                                                  │
│  [Mobile] Bottom Navigation Bar (52px)                          │
│  [Overlay] FullscreenCameraView                                  │
│  [Overlay] DiscoveredCameraPanel                                 │
│  [Modal]   SettingsModal                                         │
└──────────────────────────────────────────────────────────────────┘
```

The App.tsx file is the single root component. It owns all top-level layout state and passes callbacks/data down to child components.

---

## 2. File Structure

```
loitering_tracking/
├── client/
│   └── src/
│       ├── App.tsx                          # Root component — layout shell
│       ├── components/
│       │   ├── CameraGrid.tsx               # Grid + LayoutPicker + paging
│       │   ├── CameraList.tsx               # Scrollable camera row list
│       │   ├── AlertPanel.tsx               # Alerts sidebar tab
│       │   ├── ZonesPanel.tsx               # Zones sidebar tab (hint only)
│       │   ├── DashboardDetectionPanel.tsx  # Detections sidebar tab
│       │   ├── VideoAnalyticsTab.tsx        # Analytics sidebar tab
│       │   ├── AnalysisServerDashboard.tsx  # Analysis mode traffic/result dashboard
│       │   ├── FaceGalleryTab.tsx           # Face ID sidebar tab
│       │   ├── FullscreenCameraView.tsx     # Fullscreen overlay
│       │   ├── DiscoveredCameraPanel.tsx    # Discovery overlay
│       │   ├── CameraEditModal.tsx          # Edit camera modal
│       │   └── CameraView.tsx              # Single camera cell
│       ├── hooks/
│       │   ├── useSocket.ts                 # Socket.IO connection hook
│       │   └── useWebRTC.ts                 # WebRTC peer connection hook
│       ├── stores/
│       │   ├── cameraStore.ts
│       │   ├── alertStore.ts
│       │   ├── discoveryStore.ts
│       │   ├── crossCameraStore.ts
│       │   ├── personTrajectoryStore.ts
│       │   └── webrtcConfigStore.ts
│       ├── i18n/
│       │   └── translations/               # 15 language files
│       └── types/
│           └── index.ts
```

---

## 3. Component Tree

```
App.tsx
├─ [Desktop Header]
│   ├─ LTS logo badge
│   ├─ Application title
│   ├─ Socket.IO connection dot
│   ├─ Live/total camera count
│   ├─ LayoutPicker (dropdown)
│   └─ Settings gear button → SettingsModal
│
├─ [Mobile Header]
│   ├─ LTS logo + title
│   ├─ Connection dot
│   ├─ Camera count badge
│   └─ Settings gear button → SettingsModal
│
├─ [Main Content Area — Desktop]
│   ├─ CameraGrid (flex-1)
│   │   ├─ Camera cells × N (layout dependent)
│   │   ├─ ‹ prev / next › paging buttons
│   │   └─ DiscoveredCameraPanel (absolute overlay, conditional)
│   └─ Sidebar (w-[sidebarWidth] or 44px when collapsed)
│       ├─ Resize handle (4px drag handle, hidden when collapsed)
│       ├─ [Expanded] Tab bar (mode-dependent) + ✕ collapse button
│       ├─ [Expanded] Tab content (active tab only)
│       │   ├─ cameras  → CameraList
│       │   ├─ alerts   → AlertPanel
│       │   ├─ zones    → ZonesPanel
│       │   ├─ detections → DashboardDetectionPanel
│       │   ├─ analytics → VideoAnalyticsTab (hidden in streaming mode)
│       │   └─ faces    → FaceGalleryTab
│       └─ [Collapsed] Icon strip (44px) + Hover flyout panel
│
├─ [Mobile Content Area]
│   └─ Active tab content (full area)
│
├─ [Mobile Bottom Nav] (fixed, 52px)
│   └─ Tab buttons × 5~6 (mode-dependent)
│
├─ FullscreenCameraView (fixed overlay, conditional)
├─ SettingsModal (fixed overlay, conditional)
└─ Statistics Modal
  ├─ StatsPanelModal (combined/streaming)
  └─ AnalysisStatsModal (analysis)
```

### 3.1 Mode-Dependent Navigation Policy

| SERVER_MODE | Cameras Tab | Analytics Tab | Main Area |
|---|---|---|---|
| `combined` | 표시 | 표시 | CameraGrid |
| `streaming` | 표시 | 숨김 | CameraGrid |
| `analysis` | 숨김 | Analytics + Detections | AnalysisServerDashboard |

- `analysis` 모드에서 카메라 레이아웃은 렌더링하지 않으며 메인 영역에 AnalysisServerDashboard를 표시합니다.
- `analysis` 모드의 우측/모바일 탭은 `Analytics`(모듈 설정)와 `Detections`(실시간 감지) 두 개 탭을 제공합니다.
- `analysis` 모드에서 우측 상단 `Statistics` 버튼은 `AnalysisStatsModal`을 열어 `/api/analysis/metrics` 기반 지표만 표시합니다.
- `analysis` 모드에서 `SettingsModal`은 언어 선택만 제공하고 WebRTC/ICE 설정 섹션은 숨깁니다.

### 3.2 Sidebar Collapse / Expand (모든 모드 공통)

사이드바는 **탭 전체 표시(Expanded)** 와 **아이콘 전용 스트립(Collapsed)** 두 가지 상태를 갖습니다.

#### 상태 전환

| 동작 | 결과 |
|------|------|
| 탭 바 우측 **✕** 버튼 클릭 | Expanded → Collapsed (너비 44px) |
| 축소 상태에서 **아이콘 클릭** | Collapsed → Expanded (해당 탭 활성화) |
| 축소 상태에서 **아이콘 hover** | Flyout 패널 표시 (해당 탭 콘텐츠 미리보기) |
| Flyout 패널 **"열기 →"** 클릭 | Collapsed → Expanded (해당 탭 활성화) |

#### Collapsed 상태 (44px 아이콘 스트립)

```
┌────┐
│ 📷 │  ← 활성 탭: 파란 배경
│ 🔔 │  ← 알림 뱃지 유지
│ 🗺 │
│ 👁 │
│ 🪪 │
└────┘
```

- `sidebarCollapsed = true` 시 `<aside>` 너비 44px, Resize handle 비활성화
- 각 아이콘은 `title` 속성으로 툴팁 레이블 표시
- 알림 뱃지(`unreadAlerts > 0`)는 축소 상태에서도 표시 유지

#### Hover Flyout 패널

```
┌─────────────────────────┬────┐
│  [탭 레이블]  [열기 →]  │    │
├─────────────────────────│ 아 │
│                         │ 이 │
│   hoveredTab 콘텐츠     │ 콘 │
│                         │ 스 │
│                         │ 트 │
└─────────────────────────│ 립 │
                          └────┘
```

- `hoveredTab` state: 마우스 진입 시 세팅, 퇴장 시 `null`
- Flyout 패널 자체에도 `onMouseEnter`/`onMouseLeave` 적용 — 패널 위로 마우스 이동 시 사라지지 않음
- `renderTabContent(hoveredTab)` 호출로 선택된 탭만 렌더링
- `z-50`, `absolute right-full` 위치 — 메인 콘텐츠 영역 위에 오버레이

#### 구현 파일

| 파일 | 변경 내용 |
|------|---------|
| `client/src/App.tsx` | `sidebarCollapsed`, `hoveredTab` state 추가; 조건부 렌더링 |
| `renderTabContent(overrideTab?)` | 선택적 override 파라미터로 flyout에서 특정 탭 렌더링 |

---

## 4. State Management Design

### 4.1 App.tsx Local State

| State | Type | Initial Value | Purpose |
|---|---|---|---|
| `isMobile` | `boolean` | `window.innerWidth < 768` | Desktop/mobile mode switch |
| `sidebarTab` | `SidebarTab` | `'cameras'` | Active sidebar tab |
| `sidebarCollapsed` | `boolean` | `false` | Sidebar collapsed to icon-only strip |
| `hoveredTab` | `SidebarTab \| null` | `null` | Tab being hovered in collapsed mode (flyout trigger) |
| `sidebarWidth` | `number` | `288` | Sidebar width in px (desktop only) |
| `isDragging` | `boolean` | `false` | Sidebar resize drag state |
| `layoutId` | `LayoutId` | from localStorage or `'4'` | Current camera grid layout |
| `channelOffset` | `number` | `0` | First camera index in current page |
| `fullscreenCameraId` | `string \| null` | `null` | Camera shown in fullscreen overlay |
| `showSettings` | `boolean` | `false` | Settings modal open state |
| `isConnected` | `boolean` | `false` | Socket.IO connection status |
| `unreadAlerts` | `number` | `0` | Unacknowledged alert count for badge |

### 4.2 Layout Persistence

```typescript
// On mount: restore layout from localStorage
const saved = localStorage.getItem('lts-layout') as LayoutId | null;
const defaultLayout = isMobile ? '1' : '4';
const [layoutId, setLayoutId] = useState<LayoutId>(saved ?? defaultLayout);

// On layout change: persist to localStorage
function handleLayoutChange(id: LayoutId) {
  setLayoutId(id);
  setChannelOffset(0);
  localStorage.setItem('lts-layout', id);
}
```

### 4.3 Sidebar Resize Design

```typescript
// Mouse events on the 4px drag handle
onMouseDown: () => setIsDragging(true)
onMouseMove: (e) => {
  if (!isDragging) return;
  const containerWidth = containerRef.current?.clientWidth ?? 0;
  const newWidth = containerWidth - e.clientX;
  setSidebarWidth(Math.max(180, Math.min(600, newWidth)));
}
onMouseUp: () => setIsDragging(false)
```

### 4.4 Zustand Stores Summary

| Store | Key Fields | Used By |
|---|---|---|
| `cameraStore` | `cameras[]`, `selectedId` | CameraList, CameraGrid, header count |
| `alertStore` | `alerts[]` | AlertPanel, sidebar badge |
| `discoveryStore` | `cameras[]`, `selected`, `scanning` | CameraList Found tab |
| `crossCameraStore` | `events[]` (max 20, 60 s TTL) | DetectionPanel CROSS-CAM badge |
| `personTrajectoryStore` | `trajectories Map` | Analytics tab |
| `webrtcConfigStore` | `enabled`, `stunUrls`, `turns` | SettingsModal, useWebRTC |

---

### 4.5 Analysis Mode Dashboard

- `AnalysisServerDashboard.tsx`는 `/api/analysis/metrics`를 2초 주기로 폴링합니다.
- 메인 패널은 최근 60초 프레임 처리량, 입력 트래픽, 평균 추론 시간, 활성 컨텍스트 수를 카드로 표시합니다.
- 활성화된 분석 모듈 목록과 누적 결과(프레임, detections, tracked, faces, fire/smoke, loitering)를 표시합니다.
- 카메라별 zone 수, 누적 프레임 수, 입력 바이트, 평균 처리 시간, 결과 개수를 표로 표시합니다.

---

## 5. Socket.IO Subscription Design

### 5.1 Connection Hook (`useSocket`)

```typescript
// hooks/useSocket.ts
export function useSocket(url: string) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(url, { transports: ['websocket'] });
    socketRef.current = socket;
    (window as any).__ltsSocket = socket;  // global ref for child components
    return () => socket.disconnect();
  }, [url]);

  return socketRef;
}
```

### 5.2 App-Level Event Subscriptions

| Socket.IO Event | Handler |
|---|---|
| `connect` | `setIsConnected(true)` |
| `disconnect` | `setIsConnected(false)` |
| `camera:status` | `cameraStore.updateCameraStatus(id, status)` |
| `alert:new` | `setUnreadAlerts(n => n + 1)` |
| `face:reidentified` | `crossCameraStore.addEvent(event)` |
| `person:trajectory-update` | `personTrajectoryStore.update(trajectory)` |
| `discovery:result` | `discoveryStore.addOrUpdate(device)` + auto-tab switch |
| `discovery:scanning` | `discoveryStore.setScanning(true/false)` |
| `discovery:cleared` | `discoveryStore.clearFound()` |

---

## 6. TypeScript Interface Definitions

```typescript
// types/index.ts (layout-relevant types)

export type SidebarTab = 'cameras' | 'alerts' | 'zones' | 'detections' | 'analytics' | 'faces';

export type LayoutId =
  | '1' | '2' | '4' | '5' | '8' | '9' | '12' | '16' | '24' | '32' | '64'
  | '1+3' | '1+4' | '1+7' | '1+11' | '1+15'
  | '2+2' | '2+6' | '2+10' | '2+14'
  | '3+5' | '3+9' | '3+13';

export interface LayoutDef {
  id:       LayoutId;
  channels: number;      // total channel slots
  featured: number;      // main-panel channel count (0 for equal grids)
  sub:      number;      // sub-panel channel count
}

export interface Camera {
  id:             string;
  name:           string;
  rtspUrl?:       string;
  youtubeUrl?:    string;
  ip?:            string;
  type?:          'rtsp' | 'youtube';
  status:         'live' | 'offline' | 'error' | 'connecting' | 'reconnecting' | 'streaming' | 'idle';
  aiEnabled?:     boolean;
  webrtcEnabled?: boolean;
  pipelineStatus?: string | null;
}

export interface Alert {
  id:           string;
  cameraId:     string;
  objectId:     number;
  zone?:        string;
  dwellTime:    number;
  timestamp:    number;
  acknowledged: boolean;
}

export interface CrossCameraReIdEvent {
  faceId:      string;
  fromCamera:  string;
  toCamera:    string;
  similarity:  number;
  timestamp:   number;
}
```

---

## 7. REST API Integration

### 7.1 On Mount

```typescript
useEffect(() => {
  // Fetch registered cameras
  fetch('/api/cameras')
    .then(r => r.json())
    .then(d => cameraStore.setCameras(d.data));

  // Fetch active persons for trajectory store
  fetch('/api/persons/active')
    .then(r => r.json())
    .then(d => personTrajectoryStore.setAll(d.data));

  // Fetch WebRTC ICE config if no saved config
  if (!webrtcConfigStore.stunUrls.length) {
    fetch('/api/webrtc/ice-config')
      .then(r => r.json())
      .then(d => webrtcConfigStore.setConfig(d.data));
  }

  if (serverMode === 'analysis') {
    fetch('/api/analysis/metrics')
      .then(r => r.json())
      .then(d => setAnalysisMetrics(d));
  }
}, []);
```

---

## 8. Responsive & Mobile Considerations

### 8.1 Layout Dimensions

| Region | Desktop | Mobile |
|---|---|---|
| Header height | 44 px | 44 px (compact) |
| Sidebar width | 180–600 px (default 288 px) | N/A |
| Bottom nav | N/A | 52 px fixed |
| Main grid | Remaining viewport | 58% of content (Cameras tab) |

### 8.2 Breakpoint Logic

```typescript
// Breakpoint: 768px (Tailwind 'md')
// Detected via window.innerWidth, not CSS
const isMobile = window.innerWidth < 768;
```

### 8.3 Mobile Channel Paging (Swipe)

```typescript
const startXRef = useRef(0);

function onTouchStart(e: React.TouchEvent) {
  startXRef.current = e.touches[0].clientX;
}

function onTouchEnd(e: React.TouchEvent) {
  const delta = e.changedTouches[0].clientX - startXRef.current;
  if (Math.abs(delta) < 40) return;
  const step = LAYOUT_DEFS.find(d => d.id === layoutId)?.channels ?? 1;
  if (delta < 0) setChannelOffset(o => Math.min(o + step, maxOffset));
  else           setChannelOffset(o => Math.max(o - step, 0));
}
```

---

## 9. Sequence Diagrams

### 9.1 Layout Switch

```
User clicks LayoutPicker option
  → handleLayoutChange('9')
  → setLayoutId('9')
  → setChannelOffset(0)
  → localStorage.setItem('lts-layout', '9')
  → CameraGrid re-renders with 9-channel layout
```

### 9.2 Sidebar Resize

```
Mouse down on drag handle
  → setIsDragging(true)
  → mousemove events on document
  → setSidebarWidth(clamp(newWidth, 180, 600))
  → sidebar re-renders at new width
Mouse up
  → setIsDragging(false)
```

### 9.3 Fullscreen Open/Close

```
Double-click on camera cell
  → setFullscreenCameraId(cameraId)
  → FullscreenCameraView renders as fixed overlay

ESC keydown || close button click
  → setFullscreenCameraId(null)
  → overlay unmounts
```

---

## 10. Error Handling

| Scenario | Handling |
|---|---|
| Socket.IO disconnected | `isConnected = false`; red indicator in header; auto-reconnect by socket.io-client |
| localStorage corrupted layout key | Fall back to `'4'` (desktop) or `'1'` (mobile) |
| `/api/cameras` fetch fails | Log error; CameraStore remains empty; shows empty state in camera list |
| Sidebar resize beyond 180/600 px | Clamped via `Math.max(180, Math.min(600, newWidth))` |
| Invalid layoutId from localStorage | Validated against `LAYOUT_DEFS`; falls back to default if not found |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Dashboard Layout |
| 1.1 | 2026-06-10 | Youngho Kim | 사이드바 Collapse/Expand 기능 추가 — ✕ 버튼으로 아이콘 스트립 축소, 클릭 시 복원, hover flyout 패널 |
| 1.2 | 2026-06-10 | Youngho Kim | analysis 모드에 Detections 탭 추가 — `DashboardDetectionPanel` 전역 `detections` 이벤트 수신 |
