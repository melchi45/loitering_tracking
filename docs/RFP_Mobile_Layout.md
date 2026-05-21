# RFP — Mobile Layout (LTS2026-MOB)

**Document version:** 1.0  
**Date:** 2026-05-20  
**Status:** ✅ Implemented

---

## 1. Overview

In a mobile environment (smartphone / tablet), **reuse existing desktop UI components as much as possible** while providing a mobile-friendly layout based on a Bottom Navigation bar.

| Item | Desktop | Mobile |
|------|---------|--------|
| Sidebar | Right fixed panel (drag resize) | ❌ None |
| Tab position | Horizontal tabs at top of sidebar | Bottom fixed navigation bar |
| Content area | Main (camera grid) + Sidebar (tab content) | Single fullscreen area (tab switching) |
| Camera grid | Independent main area | Embedded inside Cameras tab |
| Breakpoint | ≥ 768px | < 768px |

---

## 2. Layout Structure

### 2.1 Mobile Screen Anatomy

```
┌─────────────────────────────────────┐
│  [LTS]  App Title          🔴 ⚙️  │  ← Header (44px, compact)
├─────────────────────────────────────┤
│                                     │
│                                     │
│         Content Area                │  ← flex-1, overflow-y-auto
│   (Renders: currently selected tab content)  │
│                                     │
│                                     │
│                                     │
├─────────────────────────────────────┤
│  📷      🔔      🗺      👁      🤖  │  ← Bottom Navigation (52px, fixed)
│ Cameras Alerts Zones Detect  AI    │
└─────────────────────────────────────┘
```

### 2.2 Header (Mobile)

| Element | Description |
|------|------|
| LTS logo + app name | Fixed on the left |
| Connection status dot | Right of logo, color-coded (green/red) |
| `flex-1` spacer | Empty space |
| Camera count badge | `N/M Live` small text |
| Settings icon | Far right (reuses existing Settings Modal) |
| Layout picker | ❌ Hidden (unnecessary on mobile) |

### 2.3 Content Area (Mobile)

When switching tabs, the corresponding content occupies the entire area.

| Tab | Mobile Content | Reused Component |
|-----|-------------|----------------|
| 📷 Cameras | Top: CameraGrid (default 1-channel, swipe to switch channels) / Bottom: CameraList scroll | `CameraGrid`, `CameraList` |
| 🔔 Alerts | AlertPanel fullscreen | `AlertPanel` |
| 🗺 Zones | Zone guidance message + double-click camera selection hint | Existing Zone guidance JSX |
| 👁 Detections | Camera selection dropdown + DetectionPanel | `DetectionPanel` |
| 🤖 Analytics | VideoAnalyticsTab fullscreen | `VideoAnalyticsTab` |

### 2.4 Bottom Navigation Bar

```
┌──────────────────────────────────────────┐
│  📷      🔔      🗺      👁       🤖     │
│ Cameras  Alerts  Zones  Detect   AI     │
│ [active blue underline on selected tab] │
└──────────────────────────────────────────┘
```

- Height: `h-13` (52px)
- Background: `bg-gray-900 border-t border-gray-700`
- Icon size: `text-xl` (20px)
- Text: `text-[9px]`, selected `text-blue-400`, unselected `text-gray-500`
- Notification badge: Numeric badge at top-right of Alerts tab icon (same logic as existing desktop)

---

## 3. Cameras Tab (Mobile)

### 3.1 Layout

```
┌─────────────────────────────────────┐
│  Header                             │
├─────────────────────────────────────┤
│                                     │
│    CameraGrid                       │
│    (Top 60% — based on current layout) │
│                                     │
├─────────────────────────────────────┤
│  CameraList (Bottom 40%)            │
│  ─ Scrollable camera item list      │
│  ─ Item click → selectCamera        │
│  ─ Double tap → fullscreen overlay  │
├─────────────────────────────────────┤
│  Bottom Nav                         │
└─────────────────────────────────────┘
```

### 3.2 Layout Picker (Mobile)

- **Default layout**: `1` (single 1-channel view)
- Small layout picker button (icon only) placed at top-right of screen
- Shows only simplified options: 1-channel (`1`) / 4-channel (`4`) / 9-channel (`9`)
- `channelOffset` is reset when layout changes

### 3.3 Channel Page Swipe Navigation

When the number of registered cameras exceeds the layout channel count, swipe left/right to switch channel pages.

#### 3.3.1 Swipe Area

- **Entire Cameras tab** (CameraGrid top 58% + CameraList bottom 42%) all detect swipes
- `onTouchStart` / `onTouchEnd` events captured on the tab root `div` → swipe is valid anywhere in the grid and list

#### 3.3.2 Behavior Specification

| Property | Description |
|------|------|
| **Direction** | Swipe left → next page, swipe right → previous page |
| **Threshold** | Minimum horizontal travel distance ≥ 40px |
| **Step unit** | Number of channels in current layout (`def.channels`) |
| **State** | `channelOffset` (App.tsx local state, shared with desktop) |

#### 3.3.3 Page Indicator

```
┬─────────────────────────────────────┐
│  2/5          [Layout▼]  │  ← Top-left: N/M badge / Top-right: layout picker
│                          │
│     CameraGrid (58%)    │
│                          │
│       ● ○ ○ ○ ○           │  ← Bottom center: dot indicator
├─────────────────────────────────────┤
│  CameraList (42%)        │  ← Scrollable list + swipe-active area
└─────────────────────────────────────┘
```

- Dots (●○) and N/M badge are shown only when there are 2 or more pages
- Current page dot: `bg-blue-400`, inactive: `bg-gray-600`

#### 3.3.4 Behavior Example

5 cameras registered, layout `1` (1-channel):
```
5 pages — 5 dots displayed
Swipe left → show CAM2 (offset=1)
Swipe left → show CAM3 (offset=2)
Swipe right → show CAM2 (offset=1)
```

## 4. Detections Tab (Mobile)

```
┌─────────────────────────────────────┐
│  Camera  [Dropdown selection]        │  ← Camera selection dropdown (reused)
├─────────────────────────────────────┤
│  DetectionPanel                     │
│  ─ Category filter bar              │
│  ─ Detection list (scrollable)      │
│  ─ Cross-Camera Re-ID feed          │
│  ─ Legend (collapsed/expanded)      │
├─────────────────────────────────────┤
│  Bottom Nav                         │
└─────────────────────────────────────┘
```

---

## 5. Fullscreen Camera Overlay (Mobile)

Reuses the existing `FullscreenCameraView` component as-is.

- Double tap (double click) sets `fullscreenCameraId` → overlay displayed
- Close overlay: `✕` button (same as existing)
- DetectionPanel is displayed as a slide panel at the bottom of the overlay on mobile  
  (Overlay layout is vertical split: top video 60% / bottom DetectionPanel 40%)

---

## 6. Breakpoint & Detection

### 6.1 Breakpoint

| Device | Width | Layout |
|---------|------|---------|
| Mobile | < 768px | Mobile Layout (Bottom Nav) |
| Desktop | ≥ 768px | Desktop Layout (Right Sidebar) |

### 6.2 Detection Method

```ts
// React state + resize listener
const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

useEffect(() => {
  const handler = () => setIsMobile(window.innerWidth < 768);
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}, []);
```

---

## 7. Reused Components

| Component | File | Mobile Reuse Method |
|---------|------|-----------------|
| `CameraGrid` | `CameraGrid.tsx` | Embedded in top area of Cameras tab |
| `CameraList` | `CameraList.tsx` | Scrollable list in bottom area of Cameras tab |
| `AlertPanel` | `AlertPanel.tsx` | Alerts tab fullscreen |
| `DetectionPanel` | `FullscreenCameraView.tsx` (export) | Detections tab fullscreen |
| `VideoAnalyticsTab` | `VideoAnalyticsTab.tsx` | Analytics tab fullscreen |
| `FullscreenCameraView` | `FullscreenCameraView.tsx` | Overlay on double tap |
| `LayoutPicker` | `App.tsx` (inline) | ❌ Hidden on mobile (simplified) |
| Settings Modal | `App.tsx` (inline) | Same modal on settings icon click |

---

## 8. FullscreenCameraView — Mobile Orientation

On mobile, the FullscreenCameraView overlay changes to a vertical split:

```
┌─────────────────────────────────────┐
│  Camera Name                    [✕] │  ← Header
├─────────────────────────────────────┤
│                                     │
│         CameraView (60%)            │  ← Video area
│                                     │
├─────────────────────────────────────┤
│  DetectionPanel (40%)               │  ← Detection panel (bottom)
│  (scrollable)                       │
└─────────────────────────────────────┘
```

- Desktop: horizontal split (video left / DetectionPanel right)
- Mobile: vertical split (video top / DetectionPanel bottom)

---

## 9. State Management

Mobile and desktop share the **same Zustand store**.  
State is preserved when switching layouts.

| Store | Shared | Notes |
|-------|---------|------|
| `cameraStore` | ✅ Shared | selectedId, cameras list |
| `alertStore` | ✅ Shared | Notification list, unread count |
| `crossCameraStore` | ✅ Shared | Re-ID events |
| `discoveryStore` | ✅ Shared | ONVIF search results |
| `webrtcConfigStore` | ✅ Shared | WebRTC settings |
| `sidebarTab` (local) | ✅ Shared | `SidebarTab` state, used as Bottom Nav tab on mobile |
| `sidebarWidth` (local) | ❌ Not used on mobile | Desktop only |
| `isMobile` (local) | - | window resize detection |

---

## 10. Implementation Status

| Item | Status | Notes |
|------|------|------|
| `isMobile` detection | ✅ | `App.tsx` — useEffect + resize listener |
| Mobile Header | ✅ | Layout picker hidden, compact header |
| Bottom Navigation | ✅ | 5 tabs, including notification badge |
| Cameras tab (mobile) | ✅ | CameraGrid + CameraList vertical split |
| Alerts tab (mobile) | ✅ | AlertPanel fullscreen reuse |
| Zones tab (mobile) | ✅ | Existing guidance JSX reuse |
| Detections tab (mobile) | ✅ | Dropdown + DetectionPanel reuse |
| Analytics tab (mobile) | ✅ | VideoAnalyticsTab reuse |
| Fullscreen Overlay (mobile) | ✅ | `flex-col` vertical split (60/40) |
| Desktop layout | ✅ | Existing behavior preserved (≥ 768px) |
