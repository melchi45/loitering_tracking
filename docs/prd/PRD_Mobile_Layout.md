# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Mobile Layout

| | |
|---|---|
| **Document ID** | PRD-LTS-MOB |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Mobile_Layout.md (LTS2026-MOB v1.0) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [UI/UX Requirements](#5-uiux-requirements)
6. [Technical Requirements](#6-technical-requirements)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

The mobile layout adapts the LTS Dashboard for smartphones and tablets (screen widths below 768px) by replacing the desktop sidebar with a bottom navigation bar and stacking content vertically — maximizing the camera view area while keeping all monitoring and management features accessible through tab switching.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect viewport width at runtime and switch to a mobile layout when `window.innerWidth < 768px`, responding to resize events.
- Replace the right sidebar with a fixed-height (52px) bottom navigation bar with 5 tabs: Cameras, Alerts, Zones, Detections, Analytics.
- On the Cameras tab, display the Camera Grid in the top 60% of the content area and the scrollable Camera List in the bottom 40%.
- Support swipe-left/right gesture navigation through camera channel pages when registered cameras exceed the current layout's channel count.
- Show a page indicator (dot pagination + N/M badge) when 2 or more pages exist.
- Adapt the Fullscreen Camera Overlay to a vertical split (video top 60%, DetectionPanel bottom 40%) on mobile.
- Reuse all existing desktop components without modification wherever possible.

### 2.2 Non-Goals

- The desktop layout (≥ 768px) must not be affected by mobile-specific changes.
- Tablet-specific intermediate layouts (e.g., split-view at 768–1024px) are not defined in this release.
- Touch-based zone drawing in the ZoneEditor is not explicitly specified for mobile in this release.

---

## 3. User Personas

**Field Security Guard** — monitors camera feeds on a tablet or smartphone while on patrol. Needs to quickly swipe between camera pages and tap into fullscreen for incident investigation.

**Shift Supervisor (Mobile)** — reviews alerts and acknowledgement state from a mobile device during rounds. Uses the Alerts tab full-screen to triage notifications.

**Remote Administrator** — checks analytics configuration and detection status from a phone. Uses the Analytics tab fullscreen to verify module states without accessing a workstation.

---

## 4. Functional Specification

### 4.1 Breakpoint Detection

```typescript
const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

useEffect(() => {
  const handler = () => setIsMobile(window.innerWidth < 768);
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}, []);
```

When `isMobile === true`, the desktop right sidebar is hidden and the bottom navigation bar is shown. All Zustand stores are shared between mobile and desktop modes.

### 4.2 Mobile Header

The top header bar is compact (44px) and contains:
- LTS logo + app title (left)
- Connection status dot (right of logo)
- `flex-1` spacer
- Camera count badge (`N/M Live`, small text)
- Settings icon (far right) — opens the same Settings Modal as desktop

**LayoutPicker is hidden** on mobile; layout selection is handled by a simplified picker in the Cameras tab.

### 4.3 Bottom Navigation Bar

Fixed at the bottom of the screen (52px, `bg-gray-900 border-t border-gray-700`). Contains 5 tabs:

| Tab | Icon | Content |
|-----|------|---------|
| Cameras | 📷 | CameraGrid (top) + CameraList (bottom) |
| Alerts | 🔔 | AlertPanel fullscreen |
| Zones | 🗺 | Zone guidance message + double-click hint |
| Detections | 👁 | Camera selection dropdown + DetectionPanel |
| Analytics | 🤖 | VideoAnalyticsTab fullscreen |

- Icon: `text-xl` (20px)
- Label: `text-[9px]`; active: `text-blue-400`; inactive: `text-gray-500`
- Active tab: blue underline indicator
- Alerts tab: numeric notification badge at top-right of icon (same logic as desktop sidebar badge)

### 4.4 Cameras Tab (Mobile)

#### 4.4.1 Layout

Vertical split inside content area:
- **Top 60%**: `CameraGrid` — defaults to layout `1` (single channel)
- **Bottom 40%**: `CameraList` — scrollable; camera item click → `selectCamera`; double-tap → fullscreen overlay

#### 4.4.2 Simplified Layout Picker

A small icon-only button at top-right of the screen. Offers only three options: `1` (1-channel), `4` (4-channel), `9` (9-channel). `channelOffset` resets when layout changes.

#### 4.4.3 Channel Page Swipe Navigation

When registered cameras exceed the current layout's channel count, swipe gestures switch channel pages:

| Property | Value |
|----------|-------|
| Swipe direction | Left → next page, Right → previous page |
| Threshold | Minimum horizontal travel ≥ 40px |
| Step unit | Number of channels in current layout (`def.channels`) |
| Swipe detection area | Entire Cameras tab (CameraGrid + CameraList) |
| State variable | `channelOffset` (shared with desktop `‹`/`›` buttons) |

Touch events captured via `onTouchStart` / `onTouchEnd` on the Cameras tab root `div`.

#### 4.4.4 Page Indicator

Shown only when total pages ≥ 2:
- **Dot pagination**: positioned at the bottom center of the CameraGrid area. Current page: `bg-blue-400`; inactive: `bg-gray-600`.
- **N/M badge**: shown at top-left of the CameraGrid.

### 4.5 Detections Tab (Mobile)

Contains:
- Camera selection dropdown (same component as desktop)
- `DetectionPanel` fullscreen (category filter bar, scrollable detection list, Cross-Camera Re-ID feed, collapsible legend)

### 4.6 Fullscreen Camera Overlay (Mobile)

Reuses the existing `FullscreenCameraView` component. On mobile, the layout switches to vertical split:
- **Top 60%**: `CameraView` (video)
- **Bottom 40%**: `DetectionPanel` (scrollable)

Desktop uses horizontal split (video left / DetectionPanel right); mobile uses vertical split (video top / DetectionPanel bottom). The close button (`✕`) and zone editor entry button remain available.

---

## 5. UI/UX Requirements

### 5.1 Mobile Screen Anatomy

```
┌─────────────────────────────────────┐
│  Header (44px compact)              │
├─────────────────────────────────────┤
│                                     │
│         Content Area                │
│         (flex-1, overflow-y-auto)   │
│                                     │
├─────────────────────────────────────┤
│  Bottom Navigation (52px, fixed)    │
└─────────────────────────────────────┘
```

### 5.2 Bottom Navigation Bar Dimensions

| Property | Value |
|----------|-------|
| Height | `h-13` (52px) |
| Background | `bg-gray-900 border-t border-gray-700` |
| Icon size | `text-xl` |
| Label font | `text-[9px]` |
| Active color | `text-blue-400` |
| Inactive color | `text-gray-500` |

### 5.3 Cameras Tab Split Ratios

| Area | Height |
|------|--------|
| CameraGrid | ~60% of content area |
| CameraList | ~40% of content area |

### 5.4 Fullscreen Overlay Split (Mobile)

| Area | Height |
|------|--------|
| CameraView (video) | 60% |
| DetectionPanel | 40% |

### 5.5 Page Dot Indicator

- Current page dot: `bg-blue-400`
- Inactive dot: `bg-gray-600`
- Displayed below the CameraGrid area, horizontally centered
- Visible only when pages ≥ 2

---

## 6. Technical Requirements

### 6.1 Breakpoint

| Width | Layout |
|-------|--------|
| < 768px | Mobile (Bottom Nav, vertical content) |
| ≥ 768px | Desktop (Right Sidebar) |

### 6.2 Reused Components

All existing desktop components are reused without modification:

| Component | Mobile Reuse |
|-----------|-------------|
| `CameraGrid` | Embedded in Cameras tab top area |
| `CameraList` | Cameras tab bottom scrollable area |
| `AlertPanel` | Alerts tab fullscreen |
| `DetectionPanel` | Detections tab and Fullscreen overlay bottom panel |
| `VideoAnalyticsTab` | Analytics tab fullscreen |
| `FullscreenCameraView` | Overlay on double-tap, vertical split on mobile |
| Settings Modal | Opened via header settings icon |

### 6.3 Shared State

All Zustand stores are shared between mobile and desktop layouts:

| Store | Shared |
|-------|--------|
| `cameraStore` | Yes — `selectedId`, `cameras` |
| `alertStore` | Yes — alert list, unread count |
| `crossCameraStore` | Yes — Re-ID events |
| `discoveryStore` | Yes — ONVIF discovery results |
| `webrtcConfigStore` | Yes — WebRTC settings |
| `sidebarTab` (local state) | Yes — serves as Bottom Nav active tab on mobile |
| `channelOffset` (local state) | Yes — shared with desktop page navigation |
| `sidebarWidth` (local) | Desktop only, not used on mobile |

### 6.4 Touch Event Handling

Swipe detection on the Cameras tab:
- Capture `onTouchStart` (record `startX`)
- On `onTouchEnd`, compute `deltaX = endX - startX`
- If `Math.abs(deltaX) >= 40`: swipe left → increment `channelOffset`, swipe right → decrement `channelOffset` (clamped to valid range)

### 6.5 Resize Handling

`window.addEventListener('resize', handler)` where `handler` updates `isMobile` state. Effect cleanup removes the listener on unmount. State is initialized synchronously from `window.innerWidth` to avoid flash of wrong layout.

---

## 7. Acceptance Criteria

1. When the viewport width is below 768px, the right sidebar is hidden and the bottom navigation bar is displayed; the layout switches back to desktop when the viewport reaches 768px or above.
2. The mobile header hides the LayoutPicker and shows the compact form with logo, connection dot, camera count, and settings icon.
3. Switching bottom navigation tabs renders the correct full-area content component for each tab (AlertPanel, DetectionPanel, VideoAnalyticsTab, zone guidance, or Cameras split view).
4. The Alerts tab notification badge on the bottom nav updates in real time to show the unacknowledged alert count.
5. On the Cameras tab, the CameraGrid occupies approximately the top 60% and the CameraList occupies the bottom 40% of the content area.
6. Swiping left on the Cameras tab advances `channelOffset` by the current layout's channel count; swiping right decreases it. A swipe of less than 40px horizontal travel is ignored.
7. The page dot indicator appears only when total pages ≥ 2, the current page dot is blue, and the indicator updates immediately after each swipe.
8. The simplified layout picker offers only 1, 4, and 9-channel options; selecting a layout resets `channelOffset` to 0.
9. Double-tapping a camera in the CameraGrid or CameraList opens the Fullscreen overlay with a vertical split (video top 60%, DetectionPanel bottom 40%).
10. All Zustand store state (selectedCamera, alert count, cross-camera events) is preserved when switching between mobile tabs.

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|-----------|-------------|--------|-----------|--------|
| M1 | Breakpoint detection, mobile header, bottom navigation bar | TBD | Phase-1 done | ✅ Complete |
| M2 | Cameras tab (CameraGrid + CameraList split, simplified picker) | TBD | Phase-1 done | ✅ Complete |
| M3 | Swipe navigation, dot indicator, page N/M badge | TBD | Phase-1 done | ✅ Complete |
| M4 | Fullscreen overlay vertical split on mobile | TBD | Phase-1 done | ✅ Complete |
| M5 | Tablet-specific intermediate layout (768–1024px) | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Define and implement tablet-specific intermediate layout for widths 768–1024px
- [ ] Add touch support for the ZoneEditor canvas (touch-based vertex add and drag)
- [ ] Validate swipe gesture behavior on iOS Safari (check passive event listener compatibility)
- [ ] Test bottom navigation notification badge at breakpoint transitions (no duplicate renders)
- [ ] Verify that `channelOffset` resets correctly when switching from desktop `‹`/`›` navigation to mobile swipe in the same session
- [ ] Add E2E tests for swipe left/right channel navigation (Playwright / Cypress mobile viewport)
- [ ] Add E2E tests for double-tap fullscreen entry on mobile
- [ ] Evaluate and implement pull-to-refresh on the Alerts tab for manual alert list refresh

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Mobile Layout |
