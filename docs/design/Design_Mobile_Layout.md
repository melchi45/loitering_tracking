# DESIGN DOCUMENT
# Mobile Layout

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UI-MOB-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Mobile_Layout.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Breakpoint Detection Design](#3-breakpoint-detection-design)
4. [Mobile Header Design](#4-mobile-header-design)
5. [Bottom Navigation Bar Design](#5-bottom-navigation-bar-design)
6. [Cameras Tab Design](#6-cameras-tab-design)
7. [Other Mobile Tabs Design](#7-other-mobile-tabs-design)
8. [Mobile Fullscreen Overlay Design](#8-mobile-fullscreen-overlay-design)
9. [Zustand Store Sharing Strategy](#9-zustand-store-sharing-strategy)
10. [Component Tree](#10-component-tree)
11. [CSS / Tailwind Specification](#11-css--tailwind-specification)

---

## 1. Architecture Overview

```
App.tsx
│
├─ isMobile = (window.innerWidth < 768)     ← runtime breakpoint
│
├─ [Desktop: isMobile=false]
│    ├─ Header (with LayoutPicker)
│    ├─ Main content (CameraGrid)
│    └─ Right Sidebar (180–600 px resizable)
│         └─ 6 tabs: Cameras / Alerts / Zones / Detections / Analytics / Face
│
└─ [Mobile: isMobile=true]
     ├─ MobileHeader (44 px)
     │    └─ Logo, title, StatusDot, camera count, settings icon
     ├─ Content Area (flex-1, overflow-y-auto)
     │    └─ Active tab content based on mobileTab state
     │         ├─ [cameras]     MobileCamerasTab
     │         ├─ [alerts]      AlertPanel
     │         ├─ [zones]       ZoneGuidanceMessage
     │         ├─ [detections]  CameraDropdown + DetectionPanel
     │         └─ [analytics]   VideoAnalyticsTab
     └─ BottomNavBar (52 px, position:fixed bottom-0)
          └─ 5 tab buttons: 📷 Cameras | 🔔 Alerts | 🗺 Zones | 👁 Detections | 🤖 Analytics

Shared Zustand stores (same instances for both modes):
  cameraStore, alertStore, crossCameraStore, discoveryStore, webrtcConfigStore
```

---

## 2. File Structure

```
client/src/
├── App.tsx                         # isMobile state + resize listener + top-level branch
├── components/
│   ├── MobileHeader.tsx            # 44 px mobile header bar
│   ├── BottomNavBar.tsx            # 52 px fixed bottom navigation
│   ├── MobileCamerasTab.tsx        # CameraGrid + CameraList vertical split
│   └── FullscreenCameraView.tsx    # Shared; mobile adds DetectionPanel split
└── stores/
    ├── cameraStore.ts              # selectedCamera, cameras[]
    ├── alertStore.ts               # alerts[], unacknowledgedCount
    ├── crossCameraStore.ts         # cross-camera events
    ├── discoveryStore.ts           # discovered cameras
    └── webrtcConfigStore.ts        # ICE servers
```

---

## 3. Breakpoint Detection Design

### 3.1 State Initialization (App.tsx)

```typescript
// Synchronous init to prevent flash of wrong layout
const [isMobile, setIsMobile] = useState<boolean>(
  () => window.innerWidth < 768
)

useEffect(() => {
  const handler = () => setIsMobile(window.innerWidth < 768)
  window.addEventListener('resize', handler)
  return () => window.removeEventListener('resize', handler)
}, [])
```

### 3.2 Layout Branch

```tsx
return (
  <div className="h-screen overflow-hidden bg-gray-900 flex flex-col">
    {isMobile ? (
      <>
        <MobileHeader />
        <main className="flex-1 overflow-y-auto">
          {mobileTab === 'cameras'    && <MobileCamerasTab />}
          {mobileTab === 'alerts'     && <AlertPanel fullscreen />}
          {mobileTab === 'zones'      && <ZoneGuidanceMessage />}
          {mobileTab === 'detections' && <MobileDetectionsTab />}
          {mobileTab === 'analytics'  && <VideoAnalyticsTab />}
        </main>
        <BottomNavBar activeTab={mobileTab} onTabChange={setMobileTab} />
      </>
    ) : (
      <>
        <DesktopHeader />
        <div className="flex-1 flex overflow-hidden">
          <CameraGrid />
          <ResizableSidebar />
        </div>
      </>
    )}
    {/* Shared overlays */}
    {fullscreenCamera && <FullscreenCameraView isMobile={isMobile} />}
  </div>
)
```

---

## 4. Mobile Header Design

### 4.1 Layout Specification

```
┌─────────────────────────────────────────────────────┐  44 px
│ [LTS logo] LTS-2026  ●  ──────────  2/4 Live  ⚙    │
│ ←logo+title→ ←dot→  ←spacer→  ←cam count→ ←settings│
└─────────────────────────────────────────────────────┘
```

### 4.2 Component Implementation

```tsx
// MobileHeader.tsx
export function MobileHeader() {
  const { cameras } = useCameraStore()
  const liveCount = cameras.filter(c => c.status === 'live').length

  return (
    <header className="h-11 bg-gray-900 border-b border-gray-700 flex items-center px-3 gap-2 flex-shrink-0">
      {/* Logo + title */}
      <span className="text-blue-400 font-bold text-sm">LTS</span>
      <span className="text-gray-200 text-sm font-medium">LTS-2026</span>

      {/* Connection status dot */}
      <ConnectionStatusDot />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Camera count */}
      <span className="text-gray-400 text-xs">
        {liveCount}/{cameras.length} Live
      </span>

      {/* Settings */}
      <button
        onClick={() => setSettingsOpen(true)}
        className="p-1 text-gray-400 hover:text-white"
        aria-label="Settings"
      >
        <GearIcon className="w-5 h-5" />
      </button>
    </header>
  )
}
```

---

## 5. Bottom Navigation Bar Design

### 5.1 Layout Specification

```
┌──────────────────────────────────────────────────────┐  52 px
│  📷      🔔🔴    🗺       👁        🤖              │
│Cameras  Alerts  Zones  Detections  Analytics         │
│   ▔▔▔       (active tab: blue top border)            │
└──────────────────────────────────────────────────────┘
position: fixed; bottom: 0; left: 0; right: 0
bg-gray-900; border-t border-gray-700
```

### 5.2 Component Implementation

```tsx
// BottomNavBar.tsx
const TABS = [
  { id: 'cameras',    icon: '📷', label: 'Cameras' },
  { id: 'alerts',     icon: '🔔', label: 'Alerts'  },
  { id: 'zones',      icon: '🗺', label: 'Zones'   },
  { id: 'detections', icon: '👁', label: 'Detections' },
  { id: 'analytics',  icon: '🤖', label: 'Analytics' },
] as const

export function BottomNavBar({ activeTab, onTabChange }) {
  const { unacknowledgedCount } = useAlertStore()

  return (
    <nav className="fixed bottom-0 inset-x-0 h-[52px] bg-gray-900 border-t border-gray-700 flex z-40">
      {TABS.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 relative
            min-h-[44px] min-w-[44px]
            ${activeTab === tab.id ? 'text-blue-400' : 'text-gray-500'}`}
        >
          {/* Active indicator */}
          {activeTab === tab.id && (
            <div className="absolute top-0 left-1/4 right-1/4 h-0.5 bg-blue-400 rounded-b" />
          )}

          {/* Icon */}
          <span className="text-xl leading-none">{tab.icon}</span>

          {/* Alert badge */}
          {tab.id === 'alerts' && unacknowledgedCount > 0 && (
            <span className="absolute top-1 right-1/4 bg-red-500 text-white text-[9px] rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5">
              {unacknowledgedCount >= 10 ? '9+' : unacknowledgedCount}
            </span>
          )}

          {/* Label */}
          <span className="text-[9px] leading-none">{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}
```

---

## 6. Cameras Tab Design

### 6.1 Layout Specification

```
┌─────────────────────────────────────────────────────┐
│  CameraGrid (~60%)                    [layout: 1/4/9]│  ←  top area
│  ┌───────────────────────────────────┐               │
│  │  Camera Feed (WebRTC / JPEG)      │               │
│  │                                   │               │
│  │             [1/3] •••             │  ←page badges │
│  └───────────────────────────────────┘               │
├─────────────────────────────────────────────────────┤
│  CameraList (~40%, scrollable)                       │  ←  bottom area
│  ┌─ ● CAM1 (live)  ─ 2 detections ──────────────┐   │
│  ├─ ● CAM2 (live)  ─ 0 detections ──────────────┤   │
│  └─ ○ CAM3 (offline) ───────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 6.2 MobileCamerasTab Implementation

```tsx
// MobileCamerasTab.tsx
export function MobileCamerasTab() {
  const [layout, setLayout] = useState<1|4|9>(1)
  const [channelOffset, setChannelOffset] = useState(0)
  const { cameras } = useCameraStore()
  const touchStartX = useRef(0)

  const channelCount = layout
  const totalPages = Math.ceil(cameras.length / channelCount)
  const currentPage = Math.floor(channelOffset / channelCount)

  // Swipe handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
  }
  const handleTouchEnd = (e: React.TouchEvent) => {
    const delta = e.changedTouches[0].clientX - touchStartX.current
    if (Math.abs(delta) < 40) return  // ignore < 40px
    if (delta < 0 && channelOffset + channelCount < cameras.length) {
      // Swipe left: next page
      setChannelOffset(prev => Math.min(prev + channelCount, cameras.length - channelCount))
    }
    if (delta > 0 && channelOffset > 0) {
      // Swipe right: prev page
      setChannelOffset(prev => Math.max(0, prev - channelCount))
    }
  }

  return (
    <div className="flex flex-col h-full" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {/* CameraGrid: ~60% */}
      <div className="flex-[3] relative overflow-hidden">
        {/* Simplified layout picker */}
        <div className="absolute top-2 right-2 z-10 flex gap-1">
          {[1, 4, 9].map(n => (
            <button
              key={n}
              onClick={() => { setLayout(n as 1|4|9); setChannelOffset(0) }}
              className={`w-7 h-7 text-xs rounded ${layout === n ? 'bg-blue-600' : 'bg-gray-700'}`}
            >
              {n}
            </button>
          ))}
        </div>

        {/* Page badge */}
        {totalPages >= 2 && (
          <div className="absolute top-2 left-2 z-10 bg-black/50 text-white text-xs px-1.5 py-0.5 rounded">
            {currentPage + 1}/{totalPages}
          </div>
        )}

        <CameraGrid
          layout={layout}
          channelOffset={channelOffset}
          isMobile
        />

        {/* Dot indicator */}
        {totalPages >= 2 && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
            {Array.from({ length: totalPages }, (_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${i === currentPage ? 'bg-blue-400' : 'bg-gray-600'}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* CameraList: ~40% */}
      <div className="flex-[2] overflow-y-auto border-t border-gray-700">
        <CameraList onDoubleTap={(cam) => openFullscreen(cam)} />
      </div>
    </div>
  )
}
```

---

## 7. Other Mobile Tabs Design

### 7.1 Alerts Tab

```tsx
// Renders AlertPanel with fullscreen=true
{mobileTab === 'alerts' && (
  <AlertPanel className="h-full overflow-y-auto" />
)}
```

### 7.2 Zones Tab

```tsx
// Guidance only (zone editing only accessible via FullscreenCameraView)
{mobileTab === 'zones' && (
  <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-3">
    <MapIcon className="w-12 h-12 text-gray-600" />
    <p className="text-gray-400 text-sm">
      To edit zones, double-click a camera to open fullscreen view,
      then tap "Zone Editor".
    </p>
  </div>
)}
```

### 7.3 Detections Tab

```tsx
{mobileTab === 'detections' && (
  <div className="flex flex-col h-full">
    <div className="p-2 border-b border-gray-700">
      <select
        value={selectedCameraId}
        onChange={e => setSelectedCameraId(e.target.value)}
        className="w-full bg-gray-800 text-gray-200 rounded p-1.5 text-sm"
      >
        {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
    <div className="flex-1 overflow-y-auto">
      <DetectionPanel cameraId={selectedCameraId} />
    </div>
  </div>
)}
```

### 7.4 Analytics Tab

```tsx
{mobileTab === 'analytics' && (
  <VideoAnalyticsTab className="h-full overflow-y-auto" />
)}
```

### 7.5 Tab State Preservation

Tab switching does **not** reset Zustand store state. Only local component state (e.g., selected camera within Detections tab) is preserved via `useState` with the component's lifecycle.

---

## 8. Mobile Fullscreen Overlay Design

### 8.1 Layout

```
┌─────────────────────────────────────┐
│  [← Back]  Camera Name  [Zone Edit] │  ←  top bar
├─────────────────────────────────────┤
│                                     │
│         Video Feed (~60%)           │  ←  WebRTC / JPEG
│                                     │
├─────────────────────────────────────┤
│         DetectionPanel (~40%)       │  ←  live detections
│                                     │
└─────────────────────────────────────┘
```

### 8.2 FullscreenCameraView — Mobile Props

```tsx
// FullscreenCameraView.tsx
export function FullscreenCameraView({ isMobile }: { isMobile: boolean }) {
  return (
    <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col">
      {/* Top bar */}
      <div className="h-10 flex items-center px-3 border-b border-gray-700 flex-shrink-0">
        <button onClick={closeFullscreen} className="text-gray-400 mr-3">← Back</button>
        <span className="text-gray-200 text-sm font-medium flex-1">{camera.name}</span>
        <button onClick={openZoneEditor} className="text-blue-400 text-sm">Zone Editor</button>
      </div>

      {/* Video + DetectionPanel split */}
      <div className={`flex-1 overflow-hidden ${isMobile ? 'flex flex-col' : 'flex'}`}>
        <div className={isMobile ? 'flex-[3]' : 'flex-1'}>
          <CameraView camera={camera} />
        </div>
        <div className={isMobile ? 'flex-[2] border-t' : 'w-64 border-l'}>
          <DetectionPanel cameraId={camera.id} />
        </div>
      </div>
    </div>
  )
}
```

---

## 9. Zustand Store Sharing Strategy

All stores are singletons — the same store instance is used by both mobile and desktop components.

```
Mobile components          Desktop components
      │                          │
      └────────┬─────────────────┘
               ▼
        Zustand store (singleton)
        ├─ cameraStore       (cameras, selectedCamera, pipeline states)
        ├─ alertStore        (alerts[], unacknowledgedCount)
        ├─ crossCameraStore  (cross-camera events)
        ├─ discoveryStore    (discovered devices)
        └─ webrtcConfigStore (ICE servers)
```

No state is lost during mobile ↔ desktop transition caused by viewport resize.

---

## 10. Component Tree

```
App.tsx
├─ [mobile=true]
│   ├─ MobileHeader
│   │   ├─ ConnectionStatusDot
│   │   └─ SettingsModal (shared)
│   ├─ [mobileTab='cameras']
│   │   └─ MobileCamerasTab
│   │       ├─ CameraGrid (isMobile=true)
│   │       └─ CameraList (mobile)
│   ├─ [mobileTab='alerts']   → AlertPanel
│   ├─ [mobileTab='zones']    → ZoneGuidanceMessage
│   ├─ [mobileTab='detections'] → MobileDetectionsTab
│   │   ├─ CameraDropdown
│   │   └─ DetectionPanel
│   ├─ [mobileTab='analytics'] → VideoAnalyticsTab
│   └─ BottomNavBar
│
└─ [mobile=false]
    ├─ DesktopHeader (LayoutPicker)
    ├─ CameraGrid
    └─ ResizableSidebar
        └─ SidebarTabs (Cameras/Alerts/Zones/Detections/Analytics/Face)

[shared overlay — both modes]
└─ FullscreenCameraView (isMobile prop)
    ├─ CameraView
    ├─ DetectionPanel
    └─ ZoneEditor (modal)
```

---

## 11. CSS / Tailwind Specification

### 11.1 Mobile Header

| Element | Class |
|---|---|
| Container | `h-11 bg-gray-900 border-b border-gray-700 flex items-center px-3 gap-2 flex-shrink-0` |
| Logo text | `text-blue-400 font-bold text-sm` |
| Title text | `text-gray-200 text-sm font-medium` |
| Camera count | `text-gray-400 text-xs` |
| Settings button | `p-1 text-gray-400 hover:text-white` |

### 11.2 Bottom Navigation Bar

| Element | Class |
|---|---|
| Container | `fixed bottom-0 inset-x-0 h-[52px] bg-gray-900 border-t border-gray-700 flex z-40` |
| Tab button (base) | `flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] min-w-[44px]` |
| Tab active color | `text-blue-400` |
| Tab inactive color | `text-gray-500` |
| Active top indicator | `absolute top-0 left-1/4 right-1/4 h-0.5 bg-blue-400 rounded-b` |
| Tab icon | `text-xl leading-none` |
| Tab label | `text-[9px] leading-none` |
| Alert badge | `absolute top-1 right-1/4 bg-red-500 text-white text-[9px] rounded-full min-w-[14px] h-[14px]` |

### 11.3 Mobile Main Content

| Element | Class |
|---|---|
| Content area | `flex-1 overflow-y-auto` |
| Bottom padding (accounts for nav bar) | `pb-[52px]` (applied to content area) |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Mobile Layout |
