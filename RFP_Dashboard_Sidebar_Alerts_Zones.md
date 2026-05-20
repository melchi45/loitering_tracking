# RFP: Dashboard Sidebar — Alerts and Zones Panel

**Document No.**: LTS-2026-012  
**Version**: 1.0  
**Date**: 2026-05-19  
**Classification**: Technical Requirements Specification (RFP)  
**Status**: Written based on Phase-1 implementation  
**Related RFPs**: LTS-2026-010 (Dashboard Layout), LTS-2026-011 (Sidebar Cameras), LTS-2026-001 (Loitering Tracking System)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Alerts Panel Diagram](#2-alerts-panel-diagram)
3. [Alerts Panel Header](#3-alerts-panel-header)
4. [Alert Row (AlertRow)](#4-alert-row-alertrow)
5. [Alert Empty State](#5-alert-empty-state)
6. [Alerts Data Model](#6-alerts-data-model)
7. [Zones Tab Configuration](#7-zones-tab-configuration)
8. [Zone Editor (Fullscreen Editor)](#8-zone-editor-fullscreen-editor)
9. [Zone Data Model](#9-zone-data-model)
10. [Zone REST API](#10-zone-rest-api)
11. [Alerts REST API](#11-alerts-rest-api)
12. [State Management](#12-state-management)
13. [Implementation Status](#13-implementation-status)

---

## 1. Overview

### 1.1 Purpose

This document defines the technical requirements for the **Alerts tab** panel and **Zones tab** panel of the LTS Dashboard right sidebar.

- **Alerts panel**: Displays real-time loitering alerts received via Socket.IO and supports acknowledge processing.
- **Zones tab**: Provides an entry point for Zone management; actual Zone editing is performed via the `ZoneEditor` component over the fullscreen camera view.

### 1.2 Scope

- Alerts panel: Real-time alert list, unacknowledged count, individual/bulk acknowledge, empty state UI
- Zones tab: Entry guide hint, Zone Editor fullscreen entry method
- Zone Editor: Polygon drawing, editing, deletion, property setting
- Zone data types and API integration

---

## 2. Alerts Panel Diagram

```
┌──────────────────────────────────┐
│  Alerts  [🔴 N]      [Clear All] │  ← header
├──────────────────────────────────┤
│  ┌──────────────────────────────┐│
│  │ ⚠  CameraName      2m ago   ││  ← AlertRow (unacknowledged)
│  │    Obj #42 · Zone A         ││    background: bg-red-950/20
│  │    Dwell: 45.3s             ││    border: border-red-900/40
│  │                       [Ack] ││
│  └──────────────────────────────┘│
│  ┌──────────────────────────────┐│
│  │ ⚠  CameraName      5m ago   ││  ← AlertRow (acknowledged)
│  │    Obj #31 · Zone B         ││    background: bg-gray-800
│  │    Dwell: 32.1s             ││    opacity: opacity-60
│  └──────────────────────────────┘│
│  ...                             │
│  (max 20 displayed)              │
└──────────────────────────────────┘

[When no alerts]
┌──────────────────────────────────┐
│  Alerts                          │
├──────────────────────────────────┤
│         ✓                        │
│      (no-alerts icon)            │
│         No alerts                │
└──────────────────────────────────┘
```

---

## 3. Alerts Panel Header

### 3.1 Components

```
[Alerts title]  [unacknowledged count badge]     [Clear All button]
```

| Element | Condition | CSS |
|------|------|-----|
| **Title** | Always shown | `text-sm font-bold text-white` |
| **Unacknowledged count badge** | Only when `unacknowledged > 0` | `text-[10px] font-bold bg-red-600 text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center` |
| **Clear All button** | Only when `alerts.length > 0` | `text-[11px] text-gray-400 hover:text-red-400` |

### 3.2 i18n Keys

| Key | English Default |
|----|-----------|
| `alertTitle` | `Alerts` |
| `alertAckAll` | `Clear All` |
| `noAlerts` | `No alerts` |

### 3.3 Clear All Behavior

- Calls `AlertStore.clearAlerts()`
- Immediately deleted from client store only, without REST API call
- Server alert history is preserved

---

## 4. Alert Row (AlertRow)

### 4.1 Row Structure

```
┌───────────────────────────────────────────────────────┐
│  [⚠]   CameraName                        2m ago      │
│         Obj #42  · Zone A                             │
│         Dwell: 45.3s                                  │
│                                               [Ack]   │
└───────────────────────────────────────────────────────┘
```

| Area | Element | Description |
|------|------|------|
| Left | Alert icon ⚠ | Unacknowledged: `text-red-400`, Acknowledged: `text-gray-500` |
| Center top | Camera name | Looked up from CameraStore by `alert.cameraId`. Shows ID if not found |
| Center top right | Relative time | Result of `relativeTime(timestamp)` function |
| Center middle | Object number + zone name | `Obj #{objectId}` + `· {zone}` (if zone exists) |
| Center bottom | Dwell time | `Dwell: {dwellTime.toFixed(1)}s` |
| Right | Ack button | Shown only when unacknowledged |

### 4.2 Time Display Format (relativeTime)

| Elapsed time | Display format |
|---------|---------|
| < 60s | `Ns ago` |
| < 60m | `Nm ago` |
| 1h or more | `Nh ago` |

### 4.3 Unacknowledged Alert Row Style

```css
bg-gray-800 border-red-900/40 bg-red-950/20
```

### 4.4 Acknowledged Alert Row Style

```css
bg-gray-800 border-gray-700 opacity-60
```

### 4.5 Ack (Acknowledge) Button

| Item | Value |
|------|-----|
| Show condition | `!alert.acknowledged` |
| Text | `Ack` |
| CSS | `px-1.5 py-0.5 text-[10px] font-bold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded border border-gray-600` |
| Click behavior | `POST /api/alerts/{id}/acknowledge` → `AlertStore.acknowledgeAlert(id)` local processing even on failure |

### 4.6 Display Limit

- Maximum display: `MAX_VISIBLE = 20` items (newest first)
- Remainder is truncated without scroll (items beyond 20 not shown)

---

## 5. Alert Empty State

Displayed in the center of the panel when there are no alerts:

```
         ✓ (check icon, 8×8 size, 40% opacity)
         
         "No alerts" (i18n: noAlerts)
```

- Icon: `path="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"` (check circle)
- Container: `flex flex-col items-center justify-center h-full text-gray-600 text-xs`

---

## 6. Alerts Data Model

### 6.1 Alert Interface

```typescript
interface Alert {
  id: string;              // UUID
  cameraId: string;        // Camera ID
  objectId: number;        // ByteTracker object number
  zone?: string;           // Triggered zone name (may be absent)
  dwellTime: number;       // Dwell time in seconds (1 decimal place)
  timestamp: number;       // Unix milliseconds
  acknowledged: boolean;   // Whether acknowledged
}
```

### 6.2 Alert Trigger Conditions

| Condition | Description |
|------|------|
| Object dwell time exceeds threshold in zone | `dwellTime >= zone.dwellThreshold` |
| Minimum displacement reached in zone | `displacement >= zone.minDisplacement` |
| Risk score exceeded | `riskScore >= zone.minRiskScore` |
| Zone type | Alert triggered only in `MONITOR` zones (excluding `EXCLUDE`) |

### 6.3 Socket.IO Real-time Reception

```
Event: 'alert'
Payload: Alert object
Handler: AlertStore.addAlert(alert)
```

---

## 7. Zones Tab Configuration

### 7.1 Zones Tab Screen in Sidebar

Clicking the Zones tab does not display the Zone editing UI directly in the Sidebar area.  
Instead, **Zone editing is only available in Fullscreen mode**.  
The Sidebar Zones tab only shows a hint explaining this.

```
┌──────────────────────────────────┐
│                                  │
│         🗺 (map icon)              │
│                                  │
│  Open fullscreen camera view to    │
│  draw and manage detection zones   │
│                                  │
│  [Sub-hint when no cameras]        │
│   Add a camera to get started    │
│                                  │
└──────────────────────────────────┘
```

### 7.2 Hint Text i18n

| Key | English Default |
|----|-----------|
| `zoneHint` | `Open fullscreen camera view to draw and manage detection zones` |
| `addCameraFirst` | `Add a camera to get started` |

### 7.3 Zone Editing Entry Path

```
Dashboard → Double-click Camera Grid cell
  → FullscreenCameraView opens
  → Click "Zone Editor" button at bottom
  → Enter ZoneEditor fullscreen editor
```

---

## 8. Zone Editor (Fullscreen Editor)

### 8.1 Overview

`ZoneEditor` is rendered as a `fixed inset-0 z-[100]` overlay.  
Polygons are drawn and edited directly on the Canvas layer over the camera's last captured frame as background.

### 8.2 Full-Screen Layout Diagram

```
┌──────────────────────────────────────────────────────────┬─────────────────────┐
│                                                          │  CONTROL PANEL      │
│  Background image (JPEG frame)                           │  (w-64, fixed right) │
│                                                          │  [Zone Edit] [×]    │
│         Canvas layer (full)                               ├─────────────────────┤
│                                                          │  [Select] [+ Add]   │
│  ┌──────────────────────┐                               ├─────────────────────┤
│  │  MONITOR zone (blue)   │                               │  [Selected Zone Props] │
│  │  (semi-transparent fill) │                             │  or                 │
│  └──────────────────────┘                               │  [Drawing Settings] │
│                                                          ├─────────────────────┤
│  ┌──────────────────────┐                               │  Saved Zones list   │
│  │  EXCLUDE zone (yellow) │                              └─────────────────────┘
│  └──────────────────────┘                               
│                                                          
└──────────────────────────────────────────────────────────
```

### 8.3 Control Panel Layout (right w-64)

#### 8.3.1 Header

| Element | Description |
|------|------|
| Title | `Zone Edit` (i18n: `zoneEdit`) |
| × button | Exit ZoneEditor → return to FullscreenCameraView |

#### 8.3.2 Mode Tab Buttons

| Mode | Button Text | Active Style |
|------|-----------|-----------|
| `idle` | `Select / Edit` | `bg-gray-700 text-white` |
| `draw` | `+ Add Zone` (i18n: `zoneAdd`) | `bg-blue-800 text-white` |

---

### 8.4 Idle Mode (Select / Edit)

#### 8.4.1 Zone Selected — Properties Panel

| Field | Type | Behavior |
|------|------|------|
| Zone name | text input | `onBlur` + `Enter` key → `PUT /api/cameras/{id}/zones/{zoneId}` |
| Zone type | Badge display (`MONITOR` blue, `EXCLUDE` yellow) | Not editable |
| Vertex count | Read-only text | |
| Deselect button | — | Deselect zone |
| Save Polygon button | — | Save edited polygon (`PUT` API) |

#### 8.4.2 No Zone Selected — Hint

```
Click to select a zone
(i18n: zoneClickToSelect)
```

---

### 8.5 Draw Mode (+ Add Zone)

#### 8.5.1 Drawing Settings Form

| Field | Type | Range/Options | Default | Description |
|------|------|---------|-------|------|
| Zone name | text | — | `"Zone N"` | Zone name to be saved |
| Zone type | Button select | `MONITOR` / `EXCLUDE` | `MONITOR` | Loitering detection vs exclusion |
| Dwell Threshold | range slider | 5–300s | 30s | Minimum dwell time for alert trigger |
| Min Displacement | range slider | 10–200px | 50px | Minimum movement distance |
| Min Risk Score | range slider | 0.00–1.00 (step 0.05) | 0.00 | Minimum risk score (0 = inactive) |

> `Dwell Threshold`, `Min Displacement`, `Min Risk Score` are only shown for `MONITOR` type

#### 8.5.2 Drawing Hints

| State | Hint Message (i18n) |
|------|-----------------|
| 0–2 vertices | `zoneDrawHint` (shown on Canvas) |
| 3 or more vertices | `zoneCanSave` text shown |

#### 8.5.3 Save/Reset Buttons

| Button | Condition | Behavior |
|------|------|------|
| Reset | Always | `drawPoints = []` |
| Save | `drawPoints.length >= 3` | `POST /api/cameras/{id}/zones` |

#### 8.5.4 Drawing Completion Conditions

- Minimum 3 vertices
- Zone name must not be empty

---

### 8.6 Canvas Edit Interactions

#### 8.6.1 Zone Polygon Rendering

| Zone type | Line color | Fill (default) | Fill (selected) |
|---------|--------|-----------|------------|
| `MONITOR` | `#3b82f6` (blue-500) | `rgba(59,130,246,0.15)` | `rgba(59,130,246,0.32)` |
| `EXCLUDE` | `#f59e0b` (amber-500) | `rgba(245,158,11,0.15)` | `rgba(245,158,11,0.32)` |

#### 8.6.2 Vertex Rendering

| Element | Style |
|------|--------|
| Vertex circle | radius 6px, zone color fill + white border |
| Selected vertex | Yellow highlight circle |
| Cursor (dragging) | `grabbing` |
| Cursor (over vertex) | `grab` |
| Cursor (draw mode) | `crosshair` |

#### 8.6.3 Mouse Events

| Event | Behavior |
|--------|------|
| Click (draw mode) | Add vertex |
| Click (idle, over zone) | Select zone |
| Click (idle, over vertex) | Select vertex → move to next click position |
| Double Click | Save after vertex move complete |
| Right Click | Show context menu |
| Drag (vertex) | Real-time vertex position change via drag |

#### 8.6.4 Context Menu (Right-click)

| Item | Condition | Behavior |
|------|------|------|
| Delete Zone | Zone selected | `DELETE /api/cameras/{id}/zones/{zoneId}` |
| Delete Vertex | Vertex selected + 4 or more vertices | Remove vertex + auto-save polygon |

---

### 8.7 Saved Zones List

Displays the saved zone list for the current camera at the bottom of the control panel:

```
SAVED ZONES (N)
─────────────────────────────
[●] Zone A          30s    [✕]
[●] Zone B        EXCLUDE   [✕]
```

| Element | Description |
|------|------|
| Color dot | MONITOR=blue, EXCLUDE=yellow |
| Name | Zone name (truncate) |
| Right text | MONITOR: `{dwellThreshold}s`, EXCLUDE: `EXCLUDE` |
| targetClasses abbreviation | Blue abbreviation shown if target classes exist |
| ✕ button | Delete zone (`DELETE` API) |

---

## 9. Zone Data Model

### 9.1 Zone Interface

```typescript
interface Zone {
  id: string;                             // UUID
  cameraId: string;                       // Camera ID this zone belongs to
  name: string;                           // Zone name
  type: 'MONITOR' | 'EXCLUDE';           // Zone type
  polygon: Array<{ x: number; y: number }>; // Polygon vertex list (frame coordinate system)
  dwellThreshold?: number;                // Dwell time threshold (seconds, MONITOR)
  minDisplacement?: number;               // Minimum movement distance (px, MONITOR)
  reentryWindow?: number;                 // Re-entry allowed window (seconds)
  minRiskScore?: number;                  // Minimum risk score (0–1, MONITOR)
  active?: boolean;                       // Whether active
  targetClasses?: string[];               // Detection target class filter
}
```

### 9.2 Zone Type Definitions

| Type | Color | Description |
|------|------|------|
| `MONITOR` | Blue `#3b82f6` | Zone subject to loitering detection. Alert triggered when dwell time exceeded |
| `EXCLUDE` | Yellow `#f59e0b` | Detection exclusion zone. Objects within this zone are excluded from loitering judgment |

### 9.3 Coordinate System

Polygon coordinates are based on the **frame coordinate system** (px):
- Origin: top-left of frame `(0, 0)`
- Range: `0 ≤ x ≤ frameWidth`, `0 ≤ y ≤ frameHeight`
- Server stores the transmitted absolute px coordinates as-is and uses them in BehaviorEngine

### 9.4 Default Values

| Property | Default | Notes |
|------|-------|------|
| `dwellThreshold` | `30` (s) | Slider range: 5–300 |
| `minDisplacement` | `50` (px) | Slider range: 10–200 |
| `minRiskScore` | `0.0` | 0 = inactive (no risk filter) |
| `active` | `true` | |

---

## 10. Zone REST API

### 10.1 Endpoint List

| Method | Endpoint | Description |
|--------|-----------|------|
| `GET` | `/api/cameras/:cameraId/zones` | Get all zones for the camera |
| `POST` | `/api/cameras/:cameraId/zones` | Create new zone |
| `PUT` | `/api/cameras/:cameraId/zones/:zoneId` | Update zone (name, polygon, properties) |
| `DELETE` | `/api/cameras/:cameraId/zones/:zoneId` | Delete zone |

### 10.2 Zone Creation Request Body

```json
{
  "name": "Zone 1",
  "type": "MONITOR",
  "polygon": [
    { "x": 100, "y": 80 },
    { "x": 400, "y": 80 },
    { "x": 400, "y": 300 },
    { "x": 100, "y": 300 }
  ],
  "dwellThreshold": 30,
  "minDisplacement": 50,
  "minRiskScore": 0.0
}
```

### 10.3 Zone Update Request Body (partial update)

```json
{
  "name": "Zone A Updated",
  "polygon": [...],
  "dwellThreshold": 45
}
```

### 10.4 Response Format

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "cameraId": "uuid",
    "name": "Zone 1",
    "type": "MONITOR",
    "polygon": [...],
    "dwellThreshold": 30,
    "minDisplacement": 50,
    "minRiskScore": 0.0,
    "active": true
  }
}
```

---

## 11. Alerts REST API

### 11.1 Endpoint List

| Method | Endpoint | Description |
|--------|-----------|------|
| `GET` | `/api/alerts` | Get alert list |
| `POST` | `/api/alerts/:id/acknowledge` | Acknowledge alert |

### 11.2 Alert Acknowledgment Response

```json
{
  "success": true
}
```

Even on error, the client calls `AlertStore.acknowledgeAlert(id)` for immediate local processing. This ensures the UI remains responsive even when the server encounters an error.

---

## 12. State Management

### 12.1 AlertStore (Zustand)

| State | Type | Description |
|------|------|------|
| `alerts` | `Alert[]` | Alert list (newest first) |

| Action | Description |
|------|------|
| `addAlert(alert)` | Add alert (insert at front) |
| `acknowledgeAlert(id)` | Set alert `acknowledged: true` |
| `clearAlerts()` | Clear entire alert list |

### 12.2 Socket.IO Events

| Event | Direction | Handler |
|--------|------|------|
| `alert` | S→C | `AlertStore.addAlert()` |
| `loitering` | S→C | Handled in FullscreenCameraView (Canvas overlay) |

### 12.3 Zone State Management

Zone data is managed as **local state of the FullscreenCameraView component**, without a Zustand global store.

| Handler | Description |
|------|------|
| **Initial load** | `GET /api/cameras/{id}/zones` — when FullscreenCameraView mounts |
| **Create** | `onZoneAdded(zone)` callback → add to local state |
| **Update** | `onZoneUpdated(zone)` callback → update local state |
| **Delete** | `onZoneDeleted(zoneId)` callback → remove from local state |

---

## 13. Implementation Status

### 13.1 Alerts Panel — Phase-1 Completed Items

| Item | Status |
|------|------|
| Real-time alert reception (Socket.IO `alert`) | ✅ Done |
| AlertRow structure (icon, camera name, time, object number, zone, dwell) | ✅ Done |
| Unacknowledged/acknowledged style distinction | ✅ Done |
| Relative time display (Xs/Nm/Nh ago) | ✅ Done |
| Ack button (POST + local processing) | ✅ Done |
| Clear All button | ✅ Done |
| Unacknowledged count badge (Sidebar tab and panel header) | ✅ Done |
| Empty state check icon | ✅ Done |
| Maximum 20 display limit | ✅ Done |
| Multilingual (alertTitle, alertAckAll, noAlerts) | ✅ Done |

### 13.2 Zones Tab — Phase-1 Completed Items

| Item | Status |
|------|------|
| Sidebar Zones tab hint screen | ✅ Done |
| ZoneEditor fullscreen editor | ✅ Done |
| MONITOR / EXCLUDE type distinction | ✅ Done |
| Polygon drawing (draw mode) | ✅ Done |
| Polygon select/edit/save (idle mode) | ✅ Done |
| Vertex drag move | ✅ Done |
| Vertex delete (right-click context menu) | ✅ Done |
| Zone delete (right-click / list ✕ button) | ✅ Done |
| Dwell Threshold slider (5–300s) | ✅ Done |
| Min Displacement slider | ✅ Done |
| Min Risk Score slider | ✅ Done |
| Saved Zones list | ✅ Done |
| REST API integration (CRUD) | ✅ Done |
| Background image (last JPEG frame) | ✅ Done |
| Canvas coordinate conversion (frame↔canvas) | ✅ Done |

### 13.3 Not Yet Implemented / Planned Improvements

| Item | Priority | Notes |
|------|---------|------|
| Alert filtering (by camera, zone, date) | Medium | |
| Alert audio notification | Medium | Use `AudioContext` |
| Alert popup toast | Medium | |
| Alert permanent storage and history query | High | DB-based history management |
| Zone targetClasses UI editing | Medium | Currently API-only |
| Zone reentryWindow settings UI | Low | |
| Direct Zone list query from Zones tab | Medium | Currently only available in Fullscreen |
| Bulk Zone copy across multiple cameras | Low | |
| Zone statistics (entry count, average dwell) | Low | |
| Alert rate limit per second (rate-limit UI display) | Medium | |

---

*Document: LTS-2026-012 v1.0 — 2026-05-19*  
*Author: LTS Development Team*
