# RFP: Dashboard Full-Screen Layout and Configuration

**Document No.**: LTS-2026-010  
**Version**: 2.0  
**Date**: 2026-05-19  
**Classification**: Technical Requirements Specification (RFP)  
**Status**: Phase-2 multi-screen layout implementation reflected  
**Related RFPs**: LTS-2026-001 (Loitering Tracking System), LTS-2026-003 (Detection Display)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Full Screen Layout Diagram](#2-full-screen-layout-diagram)
3. [Top Bar (Header)](#3-top-bar-header)
4. [Camera Grid (Main Area)](#4-camera-grid-main-area)
   - 4.1 Multi-screen layout definition
   - 4.2 Equal Grid rendering
   - 4.3 Featured (1 Main + Sub) rendering
   - 4.4 LayoutPicker dropdown
   - 4.5 Camera cell behavior
   - 4.6 Compact mode
   - 4.7 Discovered Camera Panel
5. [Sidebar (Right Panel)](#5-sidebar-right-panel)
6. [Fullscreen Overlay](#6-fullscreen-overlay)
7. [Settings Modal](#7-settings-modal)
8. [Responsive & Layout Constraints](#8-responsive--layout-constraints)
9. [Internationalization (i18n) Support](#9-internationalization-i18n-support)
10. [State Management Structure](#10-state-management-structure)
11. [Implementation Status](#11-implementation-status)

---

## 1. Overview

### 1.1 Purpose

This document defines the technical requirements for the **Dashboard full-screen layout** of the Loitering Detection & Tracking System (LTS). It targets the single-page dashboard interface that allows operators to monitor multiple camera feeds in real time, review alerts, and manage zones.

### 1.2 Scope

- Full screen area division (Header / Camera Grid / Sidebar)
- Top Bar component and behavior specification
- Camera Grid layout switching (1 / 4 / 9 / 16 split)
- Sidebar tab structure (Cameras / Alerts / Zones)
- Fullscreen overlay entry/exit
- Settings Modal entry
- Multilingual (i18n) UI text handling

---

## 2. Full Screen Layout Diagram

### 2.1 Layout Structure (ASCII)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TOP BAR  (height: ~40px, flex-shrink-0)                                   │
│  [LTS]  Loitering Tracking System   ●LIVE   0/1 live  [Layout▼]  [⚙]   │
└─────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────┬──────────────────────────────────┐
│                                          │  SIDEBAR  (width: 288px / w-72) │
│                                          │  ┌────┬──────┬─────┬──────┬────┐│
│                                          │  │CAMS│ALERTS│ZONES│DETCT│🪪  ││
│        CAMERA GRID (flex-1)              │  └────┴──────┴─────┴──────┴────┘│
│        (1×1 / 2×2 / 3×3 / 4×4)         │                                  │
│                                          │  [Active Tab Content]            │
│                                          │  • CameraList                   │
│                                          │  • AlertPanel                   │
│                                          │  • ZoneHint / ZoneEditor        │
│                                          │  • DetectionPanel               │
│                                          │  • FaceGalleryTab (🪪 Face ID)  │
└──────────────────────────────────────────┴──────────────────────────────────┘
```

### 2.2 Key Area Dimensions

| Area | Width | Height | CSS Class |
|------|------|------|-----------|
| Full app container | 100vw | 100vh | `flex flex-col h-screen overflow-hidden` |
| Top Bar | 100% | `auto` (≈40px) | `flex-shrink-0` |
| Content Row | 100% | Remaining | `flex flex-1 overflow-hidden` |
| Camera Grid (main) | Remaining | 100% | `flex-1 overflow-hidden p-2` |
| Sidebar | 288px fixed | 100% | `w-72 flex-shrink-0` |

### 2.3 Color Theme

The entire UI uses a dark theme by default.

| Area | Background | Border |
|------|--------|--------|
| Full app background | `bg-gray-900` (#111827) | — |
| Top Bar, Sidebar | `bg-gray-800` (#1F2937) | `border-gray-700` (#374151) |
| Camera cell (empty) | `bg-gray-800` (#1F2937) | — |
| Camera cell (video) | `bg-gray-900` (#111827) | — |
| Selected camera cell | — | `ring-2 ring-blue-500` |

---

## 3. Top Bar (Header)

### 3.1 Components (left→right order)

```
[Logo] [App Title]   [Connection Status]   ────────────   [Camera Count] [Layout] [Settings]
```

| Element | Description | Implementation |
|------|------|------|
| **Logo badge** | `LTS` text, `bg-blue-600` 6×6 icon | `w-6 h-6 bg-blue-600 rounded` |
| **App title** | i18n `appTitle` key | `text-sm font-bold text-white` |
| **Connection status** | Socket.IO connection — green pulse (●LIVE) / red (●DISC) | `w-2.5 h-2.5 rounded-full animate-pulse` |
| **Spacer** | Fills remaining space | `flex-1` |
| **Camera count** | `{live}/{total} LIVE` format | `text-xs text-gray-400` |
| **Layout picker** | Dropdown button → select from 16 layouts | `LayoutPicker` component |
| **Settings icon** | Gear SVG → opens SettingsModal | `hover:bg-gray-700` |

### 3.2 Connection Status Display Specification

| State | Color | Animation | Text |
|------|------|-----------|--------|
| Connected | `bg-green-500` | `animate-pulse` | i18n `connected` |
| Disconnected | `bg-red-500` | None | i18n `disconnected` |

### 3.3 Layout Picker (LayoutPicker)

- A **dropdown button** that displays the currently selected layout as SVG icon + label
- Click opens `w-72` dropdown panel; clicking outside closes it
- **Persistence**: Selected layout is saved to `localStorage` key `lts-layout` on every change. On app load, the stored value is read first; if absent, defaults to `'1'` (mobile `< 768 px`) or `'4'` (desktop).
- Dropdown panel internal structure:

```
┌─────────────────────────────────────────────┐
│  Equal Grid                                 │
│  [1] [2] [4] [5] [8] [9] [12] [16] [24]    │
│  [32] [64]                                  │
├─────────────────────────────────────────────┤
│  1 Main + Sub                               │
│  [1+3] [1+4] [1+7] [1+11] [1+15]           │
└─────────────────────────────────────────────┘
```

- Each layout button: SVG mini icon (20×20) + layout ID label (`text-[9px]`)
- Active layout: `bg-blue-600 text-white`
- Inactive: `bg-gray-700 text-gray-300 hover:bg-gray-600`
- `LayoutIcon` component: visualizes each layout as SVG grid/split

---

## 4. Camera Grid (Main Area)

### 4.1 Multi-Screen Layout Definition

The `CameraGrid` component supports 16 layouts. Layouts are divided into two types.

#### 4.1.1 Layout Type (LayoutId)

```typescript
type LayoutId =
  | '1' | '2' | '4' | '1+3' | '5' | '1+4'
  | '8' | '1+7' | '9' | '12' | '1+11'
  | '16' | '1+15' | '24' | '32' | '64';
```

#### 4.1.2 Equal Grid Layout

Equal grid — all cells are the same size.

| LayoutId | Channels | Grid | Cells | Empty Cells |
|----------|--------|--------|-------|-------|
| `1`  | 1  | 1×1 | 1  | — |
| `2`  | 2  | 2×1 | 2  | — |
| `4`  | 4  | 2×2 | 4  | — |
| `5`  | 5  | 3×2 | 6  | 1 (last) |
| `8`  | 8  | 4×2 | 8  | — |
| `9`  | 9  | 3×3 | 9  | — |
| `12` | 12 | 4×3 | 12 | — |
| `16` | 16 | 4×4 | 16 | — |
| `24` | 24 | 6×4 | 24 | — |
| `32` | 32 | 8×4 | 32 | — |
| `64` | 64 | 8×8 | 64 | — |

#### 4.1.3 Featured (1 Main + Sub) Layout

Places 1 main camera (large) on the left and N sub cameras (small grid) on the right.

| LayoutId | Channels | Main ratio | Sub columns | Sub rows |
|----------|---------|----------|-----------|----------|
| `1+3`  | 4  | 75% (flex 3:1) | 1 | 3 |
| `1+4`  | 5  | 75% (flex 3:1) | 1 | 4 |
| `1+7`  | 8  | 60% (flex 3:2) | 2 | 4 |
| `1+11` | 12 | 60% (flex 3:2) | 2 | 6 |
| `1+15` | 16 | 60% (flex 3:2) | 3 | 5 |

### 4.2 Equal Grid Rendering

```
Container: display:grid
  gridTemplateColumns: repeat(cols, 1fr)
  gridTemplateRows:    repeat(rows, 1fr)
  gap: 4px (gap-1)
```

- Container: `w-full h-full` — fills the main area 100%
- Each cell has no `aspect-video` — height auto-determined by row ratio
- Specify `gridTemplateRows` for even height distribution

### 4.3 Featured (1 Main + Sub) Rendering

```
Container: display:flex, gap:4px
  ┌─── Main cell (flex: mainFlex) ────┬── Sub panel (flex: subFlex) ──┐
  │                                  │  display:grid                 │
  │   CameraCell (cameras[0])        │  gridTemplateColumns:         │
  │                                  │    repeat(subCols, 1fr)        │
  │                                  │  gridTemplateRows:             │
  │                                  │    repeat(subRows, 1fr)        │
  │                                  │  cameras[1..N]                │
  └──────────────────────────────────┴───────────────────────────────┘
```

- Ratio controlled via `flex: mainFlex` / `flex: subFlex` inline styles
- Main cell always has `compact=false` (shows camera name)
- Sub cells have `compact=true` when subCount > 7

### 4.4 LayoutPicker Dropdown

→ See §3.3

### 4.5 Camera Cell Behavior

| Event | Behavior |
|--------|------|
| **Click** | Select camera (`selectCamera`) — toggles selection; deselects if already selected |
| **Double click** | Switch to Fullscreen Overlay |

| Camera type | Special display |
|------------|-----------|
| YouTube virtual channel | `YT` red badge in top-right |
| YouTube + status=error | Black overlay + "⚠ Error" + restart button (button hidden in compact mode) |
| Unregistered empty cell | Gray background + slot number (number hidden in compact mode) |
| Selected camera | `ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-900` |

### 4.6 Compact Mode

Compact mode is activated when channel count ≥ 16.

| Element | Normal mode | Compact mode |
|------|----------|-------------|
| Camera name label | Cell bottom gradient + name | **Hidden** |
| Channel index | Hidden | Small chip in top-left (7px font) |
| Empty cell slot number | Center display | **Hidden** |
| YouTube restart button | Shown | **Hidden** |

### 4.7 Discovered Camera Panel

Displayed as an overlay above the main area when a camera discovered via ONVIF/UDP is selected.

- Component: `DiscoveredCameraPanel`
- Position: `absolute` (relative to Camera Grid)
- Close: calls `select(null)` on DiscoveryStore

### 4.8 Camera Cell — WebRTC ICE Debug Panel

When a camera is connected via WebRTC, an **[ICE]** button appears in the top-right corner of the `CameraView` component. Clicking the button toggles the ICE Debug Panel.

#### 4.8.1 Layout

```
┌────────────────────────────────────────────────────┐
│  ● live  [WebRTC]  [ICE]          [Camera Name]    │  ← top overlay badges
│           ┌────────────────────────────────┐       │
│           │ ─ local                        │       │
│           │ [host] UDP 192.168.214.3:42351 │       │
│           │   host (LAN)                   │       │
│           │ ─ remote                       │       │
│           │ [host] 192.168.214.32:51234    │       │
│           │ ↑ 1.2 MB  ↓ 45.3 MB           │       │
│  (video)  └────────────────────────────────┘       │
└────────────────────────────────────────────────────┘
```

#### 4.8.2 ICE Candidate Type Color Coding

| Badge | Candidate Type | Meaning | Color |
|:---:|---|---|:---:|
| `[host]` | host | Direct LAN connection (optimal) | `text-green-400` |
| `[srflx]` | srflx | Public IP obtained via STUN (NAT traversal) | `text-yellow-400` |
| `[relay]` | relay | Traffic routed via TURN server | `text-orange-400` |

#### 4.8.3 Panel Behavior

| Property | Value |
|---|---|
| **Trigger** | `[ICE]` button click (top-right badge area, visible only when `webrtcState === 'connected'`) |
| **Position** | `absolute top-9 right-2`, `z-20` |
| **Stats source** | `RTCPeerConnection.getStats()` — polled every 3 seconds inside `useWebRTC` hook |
| **Fields displayed** | local type/protocol/address:port, remote address:port, bytes sent/received |
| **Data format** | bytes auto-formatted: B / KB / MB |
| **State** | `showIcePanel` (local React state in `CameraView`) |

#### 4.8.4 Button State

| State | CSS |
|---|---|
| Panel closed | `bg-gray-700/70 text-gray-400 hover:text-cyan-300` |
| Panel open | `bg-cyan-600/80 text-white` |

#### 4.8.5 Implementation Reference

- Component: `client/src/components/CameraView.tsx`
- Hook: `client/src/hooks/useWebRTC.ts` — `iceStats` field
- Type: `IceStats` — `{ localType, localProtocol, localAddress, localPort, remoteType, remoteAddress, remotePort, bytesSent, bytesReceived }`

### 4.9 Channel Page Navigation (Desktop)

When the number of registered cameras exceeds the layout channel count, page navigation buttons (`‹` / `›`) are overlaid on the left/right sides of the camera grid.

#### 4.9.1 Button Display Conditions

| Button | Display Condition | Click Behavior |
|------|----------|-----------|
| **Previous `‹`** | `channelOffset > 0` | `channelOffset -= def.channels` (min 0) |
| **Next `›`** | `channelOffset + def.channels < cameras.length` | `channelOffset += def.channels` (max `cameras.length - def.channels`) |

#### 4.9.2 Navigation Unit

- Navigation unit: number of channels in the current layout (`def.channels`)
- Example: layout `4` moves 4 channels at a time, layout `9` moves 9 channels at a time

#### 4.9.3 State Management

| State | Initial Value | Reset Condition |
|------|--------|----------|
| `channelOffset` | `0` | Auto-reset on layout change |

- Shares the same `channelOffset` state as the mobile swipe offset

#### 4.9.4 Button Styles

| Button | Position | CSS |
|------|------|-----|
| Previous `‹` | `absolute left-3 top-1/2 -translate-y-1/2` | `bg-black/60 hover:bg-black/80 text-white w-8 h-14 rounded-r-lg` |
| Next `›` | `absolute right-3 top-1/2 -translate-y-1/2` | `bg-black/60 hover:bg-black/80 text-white w-8 h-14 rounded-l-lg` |

#### 4.9.5 Behavior Example

10 cameras registered, layout `4` (4 channels):
```
Initial state:  [CAM1][CAM2][CAM3][CAM4]  offset=0   › shown
› click:        [CAM5][CAM6][CAM7][CAM8]  offset=4  ‹ › shown
› click:        [CAM9][CAM10][  ][  ]     offset=8   ‹ shown
```

#### 4.9.6 Implementation Files

- `client/src/App.tsx` — `channelOffset` state, `‹`/`›` button rendering
- `client/src/components/CameraGrid.tsx` — offset applied via `startIndex` prop

---

## 5. Sidebar (Right Panel)

### 5.1 Structure

```
┌──────────────────────────────────────────────────┐
│  [CAMS][ALERTS][ZONES][DETECT][🪪 FACE ID]       │  ← 5 tabs (flex-1 each)
├──────────────────────────────────────────────────┤
│                                                  │
│      Active Tab Content                          │  ← flex-1, overflow-hidden
│                                                  │
└──────────────────────────────────────────────────┘
```

- Width: `w-72` (288px) fixed, resizable via drag handle
- Background: `bg-gray-800`
- Divider: `border-l border-gray-700`

### 5.2 Tab Button Specification

| Tab ID | Icon | Display Text | i18n Key | Badge |
|-------|------|-----------|---------|------|
| `cameras` | — | CAMERAS | `tabCameras` | None |
| `alerts` | — | ALERTS | `tabAlerts` | Unacknowledged count (red circle) |
| `zones` | — | ZONES | `tabZones` | None |
| `detections` | — | DETECTIONS | `tabDetections` | None |
| `faces` | 🪪 | FACE ID | `tabFaceGallery` | None |

**Active tab**: `text-blue-400 border-b-2 border-blue-400`  
**Inactive tab**: `text-gray-500 hover:text-gray-300`  

**Alerts badge**: If there are 1 or more unacknowledged alerts, a red circle badge is displayed in the top-right of the tab
- 9 or fewer: shows number
- 10 or more: shows `9+`
- CSS: `w-4 h-4 text-[9px] font-bold bg-red-600 rounded-full`

### 5.3 Tab Content Components

| Tab | Component | Reference RFP / SRS |
|----|---------|----------|
| `cameras` | `CameraList` | LTS-2026-011 (Sidebar Cameras) |
| `alerts` | `AlertPanel` | LTS-2026-012 (Sidebar Alerts & Zones) |
| `zones` | Zone Hint text / `ZoneEditor` | LTS-2026-012 |
| `detections` | `DetectionPanel` | §4.8 — Detection overlay for selected camera |
| `faces` | `FaceGalleryTab` | LTS-2026-013 (Face ID Sidebar) — §5.4 below |

> See each RFP document for detailed specifications.

### 5.4 Face ID Sidebar Tab (🪪 `faces`)

The Face ID tab is fully specified in its own dedicated RFP document:

> **→ [RFP_Dashboard_Sidebar_Face_ID.md](RFP_Dashboard_Sidebar_Face_ID.md) (LTS-2026-013)**

Key summary:
- Four gallery types: 🔍 missing · ⭐ vip · 🚫 blocklist · 🗃 general
- Face enrollment via SCRFD-2.5GF detection + ArcFace ResNet-50 embedding
- Real-time match log via Socket.IO `face_match` event (max 50 entries)
- Flashing missing-person alert banner on `galleryType === 'missing'` match
- Persistence: named galleries in `storage/lts.json`; person trajectories in `storage/face_tracking.json`
- Component: `client/src/components/FaceGalleryTab.tsx`
- API: `server/src/api/faceGallery.js`

---


---

## 6. Fullscreen Overlay

### 6.1 Overview

Double-clicking a camera cell renders the full-screen overlay (`FullscreenCameraView`).

### 6.2 Structure

```
┌──────────────────────────────────────────────────────────────────┐
│  FULLSCREEN OVERLAY (fixed inset-0 z-50 bg-black/90)            │
│                                                                  │
│  ┌─────────────────────────────────┬───────────────────────────┐│
│  │    CameraView (flex-1)          │  RIGHT PANEL (w-72)       ││
│  │    (WebRTC video or JPEG img)   │  ┌────────────────────┐  ││
│  │                                 │  │  Detection List     │  ││
│  │  ┌──────────────────────┐       │  │  (object list + attributes) │  ││
│  │  │  Canvas Overlay      │       │  ├────────────────────┤  ││
│  │  │  (bbox, labels)      │       │  │  Cross-Camera       │  ││
│  │  └──────────────────────┘       │  │  Re-ID feed        │  ││
│  │                                 │  ├────────────────────┤  ││
│  │  [Zone Editor Button]  [Close X]│  │  Object Legend     │  ││
│  └─────────────────────────────────┤  └────────────────────┘  ││
│                                    └───────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### 6.3 Behavior Requirements

| Element | Specification |
|------|------|
| **Entry** | Double-click Camera Grid cell |
| **Exit** | Click × button in top-right or press `ESC` key |
| **Video** | `CameraView` — same WebRTC or JPEG mode |
| **Detection overlay** | Canvas layer — bounding box, labels, attribute badges |
| **Detection List** | Right panel — detected object list, dwell time, risk score |
| **Cross-Camera** | Right panel — collapsible section shows cross-camera ReID events |
| **Zone Editor** | Bottom button switches to Zone edit mode |
| **Video Analytics** | AI module enable/disable toggle panel (below Detection List) |

### 6.4 Zone Editor Entry

- Clicking the `Zone Editor` button inside FullscreenCameraView switches to the `ZoneEditor` component
- Returns to `CameraView` after editing is complete

---

## 7. Settings Modal

### 7.1 Overview

Clicking the Settings icon (⚙) in the Top Bar renders `SettingsModal` as a Modal Overlay.

### 7.2 Structure

```
┌──────────────────────────────────┐
│  SETTINGS MODAL                  │
│  (fixed z-50, bg-black/60 bg)    │
├──────────────────────────────────┤
│  Header: "Settings" + × button     │
├──────────────────────────────────┤
│  ┌─── <form autoComplete=off> ─┐ │
│  │  [Language selection section]  │ │
│  │  ─────────────────          │ │
│  │  [WebRTC section]             │ │
│  │  • Enable/Disable toggle      │ │
│  │  • STUN server list (add/delete) │ │
│  │  • TURN server list (add/delete) │ │
│  │  • Apply button               │ │
│  └─────────────────────────────┘ │
├──────────────────────────────────┤
│  Footer: "Close" button            │
└──────────────────────────────────┘
```

### 7.3 Size and Behavior

| Property | Value |
|------|-----|
| Width | `w-96` (384px) |
| Max height | `max-h-[88vh]` |
| Background overlay | `bg-black/60` |
| Overlay click | Close modal |
| Prevent form submit | `onSubmit={e => e.preventDefault()}` |

### 7.4 Language Selection Section

- Supported languages: 15 (ko, en, zh-CN, zh-TW, ja, es, fr, de, pt, ru, ar, hi, id, tr, vi)
- **UI: `<select>` dropdown** (changed from previous button list → dropdown)
- Each option: `flag emoji + language name` (e.g., `🇰🇷 Korean`)
- Applied immediately on selection (`onChange` → `setLang`)
- Style: `bg-gray-700 border-gray-600`, custom chevron icon overlay

```tsx
<select value={lang} onChange={(e) => setLang(e.target.value as LangCode)}
  className="w-full appearance-none bg-gray-700 border border-gray-600 ..."
>
  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
</select>
```

### 7.5 WebRTC Settings Section

| Item | Type | Description |
|------|------|------|
| WebRTC Enable | Toggle | Whether to use mediasoup WebRTC stream |
| STUN servers | String array | URL list (add/delete) |
| TURN servers | Object array | `{ url, username, credential }` list |
| Apply button | Button | Save to `localStorage` + save confirmation feedback |

- TURN credential field: `type="password"`, `autoComplete="new-password"`
- Settings persistence: Zustand store + `localStorage` key `lts-webrtc-config`

---

## 8. Responsive & Layout Constraints

### 8.1 Supported Resolutions

| Resolution | Layout Behavior |
|--------|-------------|
| 1920×1080 and above | All layouts fully supported (including 64 channels) |
| 1366×768 | Recommended up to 16 channels; cells shrink for 24/32/64 channels |
| Mobile (< 768px) | Mobile Layout — Bottom Nav, swipe channel navigation (see RFP_Mobile_Layout.md) |

### 8.2 Overflow Handling

- Entire app: `overflow-hidden` (no scroll)
- Sidebar: `overflow-hidden` (scroll inside tab content)
- Settings Modal interior: `overflow-y-auto`

### 8.3 z-index Layers

| Layer | z-index | Description |
|--------|---------|------|
| Base UI | 0 | Grid, Sidebar |
| Discovered Camera Panel | `absolute` | Above main area |
| ICE Panel | `z-20` | Above video, within CameraView |
| Fullscreen Overlay | `z-50` | Above entire app |
| Settings Modal | `z-50` | Topmost |

---

## 9. Internationalization (i18n) Support

### 9.1 Supported Languages

15 languages supported. Default: browser language detection → falls back to `en`.

| Language | Code | Direction |
|------|------|------|
| Korean | `ko` | LTR |
| English | `en` | LTR |
| 中文(简体) | `zh-CN` | LTR |
| 中文(繁體) | `zh-TW` | LTR |
| 日本語 | `ja` | LTR |
| Español | `es` | LTR |
| Français | `fr` | LTR |
| Deutsch | `de` | LTR |
| Português | `pt` | LTR |
| Русский | `ru` | LTR |
| العربية | `ar` | **RTL** |
| हिन्दी | `hi` | LTR |
| Bahasa Indonesia | `id` | LTR |
| Türkçe | `tr` | LTR |
| Tiếng Việt | `vi` | LTR |

### 9.2 Key i18n Keys (Dashboard common)

| Key | English Default | Usage Location |
|----|-----------|---------|
| `appTitle` | `Loitering Tracking System` | Top Bar |
| `connected` | `Connected` | Top Bar status |
| `disconnected` | `Disconnected` | Top Bar status |
| `live` | `live` | Camera count |
| `tabCameras` | `Cameras` | Sidebar tab |
| `tabAlerts` | `Alerts` | Sidebar tab |
| `tabZones` | `Zones` | Sidebar tab |
| `settings` | `Settings` | Top Bar tooltip |
| `zoneHint` | `Open fullscreen camera view to draw and manage detection zones` | Zones tab hint |
| `addCameraFirst` | `Add a camera to get started` | Zones tab sub-hint |

### 9.3 Language Persistence

- Storage: `localStorage` key `lts-language`
- Applied: loaded immediately when `I18nProvider` mounts
- RTL (Arabic): dynamically applies `<html dir="rtl">`

---

## 10. State Management Structure

### 10.1 Zustand Store List

| Store | File | Key State |
|--------|------|---------|
| `useCameraStore` | `stores/cameraStore.ts` | `cameras[]`, `selectedId` |
| `useAlertStore` | `stores/alertStore.ts` | `alerts[]` |
| `useDiscoveryStore` | `stores/discoveryStore.ts` | `cameras[]`, `selected`, `scanning` |
| `useCrossCameraStore` | `stores/crossCameraStore.ts` | `events[]` |
| `useWebRTCConfigStore` | `stores/webrtcConfigStore.ts` | `enabled`, `stunUrls[]`, `turns[]` |

> **Detections tab**: subscribes to `selectedId` (selected camera) from `useCameraStore` — when a camera is selected, that camera's DetectionPanel is displayed in the sidebar.

### 10.2 Socket.IO Events (Dashboard level)

| Event | Direction | Handler Location |
|--------|------|---------|
| `connect` | Server→Client | `connected` state update |
| `disconnect` | Server→Client | `connected = false` |
| `cameras` | Server→Client | `setCameras()` |
| `camera:status` | Server→Client | `updateCameraStatus()` |
| `alert` | Server→Client | `addAlert()` |
| `cross-camera:reid` | Server→Client | `addCrossCameraEvent()` |
| `discovery:result` | Server→Client | Handled in CameraList |
| `discovery:scanning` | Server→Client | Handled in CameraList |

---

## 11. Implementation Status

### 11.1 Phase-1 Completed Items

| Item | Status | Notes |
|------|------|------|
| Full layout structure (Header/Grid/Sidebar) | ✅ Done | `App.tsx` |
| Top Bar (logo, connection status, count, layout picker, settings) | ✅ Done | |
| Camera Grid — Equal Grid (1/2/4/5/8/9/12/16/24/32/64) | ✅ Done | `CameraGrid.tsx` |
| Camera Grid — Featured Layout (1+3/1+4/1+7/1+11/1+15) | ✅ Done | `CameraGrid.tsx` |
| LayoutPicker dropdown (SVG icons + 16 layout group selection) | ✅ Done | `App.tsx` |
| Compact mode (16+ channels — minimize overlays) | ✅ Done | `CameraGrid.tsx` |
| Camera Grid double-click Fullscreen entry | ✅ Done | |
| Sidebar tab structure (Cameras/Alerts/Zones/Detections/Analytics) | ✅ Done | 5-tab layout |
| Alerts tab badge (unacknowledged count) | ✅ Done | |
| Fullscreen Overlay | ✅ Done | `FullscreenCameraView.tsx` |
| Settings Modal (language, WebRTC) | ✅ Done | |
| 15-language multilingual support | ✅ Done | |
| WebRTC settings persistence (localStorage) | ✅ Done | |
| Dark theme | ✅ Done | Tailwind CSS gray-800/900 |
| WebRTC ICE Debug Panel (§4.8) | ✅ Done | `CameraView.tsx` — [ICE] button + `iceStats` from `useWebRTC` |
| Detection List moved to right panel (§6.2) | ✅ Done | `FullscreenCameraView.tsx` — `w-72` right panel |
| Cross-Camera Re-ID: camera name display | ✅ Done | `FullscreenCameraView.tsx` — `prevCameraId`/`newCameraId` resolved to camera names via `useCameraStore`; UUID fallback + hover tooltip |
| Layout persistence (localStorage) | ✅ Done | `App.tsx` — `localStorage` key `lts-layout`; restored on init with mobile/desktop default fallback |

### 11.2 Not Yet Implemented / Planned Improvements

| Item | Priority | Notes |
|------|---------|------|
| Mobile/tablet responsive layout | Medium | Currently desktop only |
| Camera drag & drop reorder | Low | |
| Dashboard widget toggle (stats panel etc.) | Low | |
| Alert audio notification | Medium | AlertPanel integration required |
| Fullscreen API (`requestFullscreen`) | Low | Currently CSS fullscreen approach |

---

*Document: LTS-2026-010 v1.0 — 2026-05-19*  
*Author: LTS Development Team*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Dashboard Layout |
