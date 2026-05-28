# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Dashboard Sidebar — Alerts and Zones Panel

| | |
|---|---|
| **Document ID** | PRD-LTS-012 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Dashboard_Sidebar_Alerts_Zones.md (LTS-2026-012 v1.0) |

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

The Alerts and Zones panels give security operators a real-time view of loitering alerts with one-click acknowledgment, and provide a guided workflow for drawing and managing detection zones directly over live camera imagery — ensuring that zone configuration is always tied to the actual camera frame with no coordinate ambiguity.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Display real-time loitering alerts received via Socket.IO in a sidebar panel with per-alert acknowledge and bulk clear actions.
- Visually distinguish unacknowledged alerts (red background) from acknowledged alerts (gray, dimmed) for at-a-glance triage.
- Show relative timestamps (Ns/Nm/Nh ago), object IDs, zone names, and dwell times for each alert row.
- Provide a Zones tab hint directing operators to the fullscreen editor; zone drawing and editing must be performed via the `ZoneEditor` component inside the Fullscreen Camera View.
- Support polygon drawing, editing (vertex drag), deletion, and property configuration (name, type, dwell threshold, min displacement, min risk score) through a `ZoneEditor` fullscreen canvas interface.
- Persist zones server-side via a REST API and render them as semi-transparent overlays on the camera canvas.

### 2.2 Non-Goals

- Alert filtering by camera, zone, or date range is not required in this release.
- Alert audio notifications and toast popups are deferred to a future release.
- Zone `targetClasses` editing is not exposed in the UI in this release (API-only).

---

## 3. User Personas

**Security Operator** — receives real-time alerts in the sidebar while monitoring camera feeds. Needs to acknowledge alerts quickly (single button click) and identify which camera/zone triggered each alert.

**Zone Administrator** — enters fullscreen mode to draw MONITOR or EXCLUDE zones precisely over the camera frame. Adjusts dwell thresholds and displacement requirements without developer assistance.

**Site Supervisor** — reviews alert history during shift reviews. Uses the Clear All button to reset the panel after reviewing, knowing server-side history is preserved.

---

## 4. Functional Specification

### 4.1 Alerts Panel

#### 4.1.1 Panel Header

Contains:
- Title text (i18n key `alertTitle`, default "Alerts")
- Unacknowledged count badge (shown only when count > 0): red circle, `min-w-[20px]`, shows number or `9+` if ≥ 10
- "Clear All" button (shown only when `alerts.length > 0`): calls `AlertStore.clearAlerts()`; client-only, server history is preserved

#### 4.1.2 Alert Row Structure

Each row displays (top-to-bottom, left-to-right):
- Warning icon ⚠: `text-red-400` (unacknowledged) or `text-gray-500` (acknowledged)
- Camera name (looked up from CameraStore by `alert.cameraId`; shows raw ID if not found)
- Relative time in `relativeTime(timestamp)` format (< 60s → "Ns ago", < 60m → "Nm ago", ≥ 1h → "Nh ago")
- Object number: `Obj #{objectId}`
- Zone name: `· {zone}` (omitted if absent)
- Dwell time: `Dwell: {dwellTime.toFixed(1)}s`
- "Ack" button: shown only when `!alert.acknowledged`; calls `POST /api/alerts/{id}/acknowledge` then `AlertStore.acknowledgeAlert(id)` (local update proceeds even on API error)

Display limit: maximum 20 alerts (newest first); items beyond 20 are silently truncated.

#### 4.1.3 Empty State

When `alerts.length === 0`: centered check-circle icon (40% opacity) + "No alerts" text (`text-xs text-gray-600`).

#### 4.1.4 Real-time Reception

Socket.IO event `alert` → `AlertStore.addAlert(alert)` (prepends to list).

### 4.2 Zones Tab

The Zones tab in the sidebar does not render the zone editor directly. It shows only a hint text:
- Map icon
- i18n key `zoneHint`: "Open fullscreen camera view to draw and manage detection zones"
- Sub-hint when no cameras exist (i18n key `addCameraFirst`): "Add a camera to get started"

Zone editing entry path: Dashboard → double-click camera cell → `FullscreenCameraView` → click "Zone Editor" button → `ZoneEditor` overlay opens.

### 4.3 Zone Editor

`ZoneEditor` renders as a `fixed inset-0 z-[100]` fullscreen overlay with:
- Background: the camera's last captured JPEG frame
- Canvas layer covering the full area for polygon interaction
- Right control panel (fixed `w-64`)

#### 4.3.1 Control Panel Header

- Title: "Zone Edit" (i18n `zoneEdit`)
- `×` button to exit `ZoneEditor` and return to `FullscreenCameraView`

#### 4.3.2 Mode Switching

| Mode | Button | Active Style |
|------|--------|-------------|
| `idle` | "Select / Edit" | `bg-gray-700 text-white` |
| `draw` | "+ Add Zone" | `bg-blue-800 text-white` |

#### 4.3.3 Idle Mode — Zone Properties Panel

When a zone is selected:
- Editable name input (saved on blur or Enter via `PUT /api/cameras/{id}/zones/{zoneId}`)
- Zone type badge: MONITOR (blue), EXCLUDE (yellow) — read-only display
- Vertex count (read-only)
- Deselect button
- "Save Polygon" button

When no zone is selected: hint text (i18n `zoneClickToSelect`).

#### 4.3.4 Draw Mode — Drawing Settings

| Field | Range/Options | Default |
|-------|--------------|---------|
| Zone name | text | "Zone N" |
| Zone type | MONITOR / EXCLUDE | MONITOR |
| Dwell Threshold | 5–300s (slider) | 30s |
| Min Displacement | 10–200px (slider) | 50px |
| Min Risk Score | 0.00–1.00 step 0.05 | 0.00 |

Dwell Threshold, Min Displacement, and Min Risk Score are only shown for MONITOR type.

Save requires ≥ 3 vertices and a non-empty zone name. Reset button clears `drawPoints`.

#### 4.3.5 Canvas Interactions

| Action | Behavior |
|--------|---------|
| Click (draw mode) | Add vertex |
| Click (idle, over zone) | Select zone |
| Click (idle, over vertex) | Select vertex → move on next click |
| Drag (vertex) | Real-time vertex drag |
| Double-click | Confirm vertex move |
| Right-click | Context menu: "Delete Zone" / "Delete Vertex" |

"Delete Vertex" only available when selected zone has ≥ 4 vertices; deletes vertex and auto-saves polygon.

#### 4.3.6 Saved Zones List

Bottom of right panel: lists all saved zones for the current camera with color dot (MONITOR=blue, EXCLUDE=yellow), name, dwell threshold or "EXCLUDE" label, and a `✕` delete button.

---

## 5. UI/UX Requirements

### 5.1 Alert Row Styles

| State | CSS |
|-------|-----|
| Unacknowledged | `bg-gray-800 border-red-900/40 bg-red-950/20` |
| Acknowledged | `bg-gray-800 border-gray-700 opacity-60` |

### 5.2 Zone Polygon Rendering on Canvas

| Zone Type | Fill | Border |
|-----------|------|--------|
| MONITOR (default) | `rgba(59,130,246,0.15)` | `#3b82f6` |
| MONITOR (selected) | `rgba(59,130,246,0.32)` | `#3b82f6` |
| EXCLUDE (default) | `rgba(245,158,11,0.15)` | `#f59e0b` |
| EXCLUDE (selected) | `rgba(245,158,11,0.32)` | `#f59e0b` |

Vertex circles: radius 6px, zone color fill + white border. Selected vertex: yellow highlight. Cursor states: `crosshair` (draw), `grab` (over vertex), `grabbing` (dragging).

### 5.3 Zone Label

Rendered at polygon centroid: `bold 10px sans-serif`, `rgba(0,0,0,0.65)` background, MONITOR text `#60a5fa`, EXCLUDE text `#fbbf24`.

### 5.4 Ack Button Style

`px-1.5 py-0.5 text-[10px] font-bold bg-gray-700 hover:bg-gray-600 text-gray-200 rounded border border-gray-600`

---

## 6. Technical Requirements

### 6.1 Alert Data Model

```typescript
interface Alert {
  id: string;           // UUID
  cameraId: string;
  objectId: number;
  zone?: string;
  dwellTime: number;    // seconds
  timestamp: number;    // Unix ms
  acknowledged: boolean;
}
```

Alert trigger conditions: `dwellTime >= zone.dwellThreshold`, `displacement >= zone.minDisplacement`, `riskScore >= zone.minRiskScore`. Only MONITOR zones generate alerts.

### 6.2 Zone Data Model

```typescript
interface Zone {
  id: string;
  cameraId: string;
  name: string;
  type: 'MONITOR' | 'EXCLUDE';
  polygon: Array<{ x: number; y: number }>;
  dwellThreshold?: number;   // default 30s
  minDisplacement?: number;  // default 50px
  minRiskScore?: number;     // default 0.0
  active?: boolean;          // default true
  targetClasses?: string[];
}
```

Polygon coordinates are in the frame coordinate system (px), origin top-left.

### 6.3 REST API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/alerts` | Fetch alert list |
| POST | `/api/alerts/:id/acknowledge` | Acknowledge alert |
| GET | `/api/cameras/:cameraId/zones` | Fetch all zones |
| POST | `/api/cameras/:cameraId/zones` | Create zone |
| PUT | `/api/cameras/:cameraId/zones/:zoneId` | Update zone |
| DELETE | `/api/cameras/:cameraId/zones/:zoneId` | Delete zone |

### 6.4 State Management

**AlertStore (Zustand)**:
- `alerts: Alert[]` — newest first
- `addAlert(alert)`, `acknowledgeAlert(id)`, `clearAlerts()`

**Zone state**: managed as local state in `FullscreenCameraView` (no global Zustand store). Loaded on mount via `GET /api/cameras/{id}/zones`; updated via `onZoneAdded`, `onZoneUpdated`, `onZoneDeleted` callbacks.

### 6.5 Socket.IO Events

| Event | Direction | Handler |
|-------|-----------|---------|
| `alert` | S→C | `AlertStore.addAlert()` |
| `loitering` | S→C | Handled in `FullscreenCameraView` canvas overlay |

---

## 7. Acceptance Criteria

1. Real-time alerts received via Socket.IO `alert` event appear immediately at the top of the alerts list with correct camera name, relative time, object ID, zone name, and dwell time.
2. Unacknowledged alert rows render with a red-tinted background (`bg-red-950/20`); acknowledged rows render with `opacity-60`.
3. Clicking "Ack" calls `POST /api/alerts/{id}/acknowledge` and immediately sets the row to acknowledged state in the UI, even if the API call fails.
4. The "Clear All" button empties the client-side alerts list without making a DELETE API call to the server.
5. The Zones tab in the sidebar shows only the hint text (no zone editor); the ZoneEditor is accessible only through the fullscreen camera view.
6. In `ZoneEditor` draw mode, clicking 3 or more canvas points enables the "Save" button; saving calls `POST /api/cameras/{id}/zones` and adds the zone to the saved zones list.
7. Existing zone polygons can be edited via vertex drag; "Save Polygon" calls `PUT /api/cameras/{id}/zones/{zoneId}`.
8. Right-clicking a selected zone shows a context menu with "Delete Zone" option; confirming calls `DELETE /api/cameras/{id}/zones/{zoneId}`.
9. MONITOR zone polygons render in blue; EXCLUDE zone polygons render in amber; both use correct fill and border colors.
10. Dwell Threshold, Min Displacement, and Min Risk Score sliders are hidden when zone type is EXCLUDE.

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|-----------|-------------|--------|-----------|--------|
| M1 | Alerts panel (real-time list, ack, clear, empty state) | TBD | Phase-1 done | ✅ Complete |
| M2 | Zone Editor (draw, edit, delete, save, REST API) | TBD | Phase-1 done | ✅ Complete |
| M3 | Alert filtering (by camera, zone, date) | TBD | - | ⏳ Pending |
| M4 | Alert audio notification and toast popup | TBD | - | ⏳ Pending |
| M5 | Zone statistics (entry count, average dwell) | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement alert filtering by camera, zone, and date range in the Alerts panel
- [ ] Add alert audio notification using `AudioContext`
- [ ] Add alert popup toast for new unacknowledged alerts
- [ ] Implement persistent alert history storage and query (database-backed)
- [ ] Expose `targetClasses` field in the Zone Editor UI (currently API-only)
- [ ] Add `reentryWindow` settings UI in the Zone Editor
- [ ] Allow direct zone list query from the Zones tab (without requiring fullscreen entry)
- [ ] Add bulk zone copy across multiple cameras
- [ ] Display alert rate limit indicator in the UI
- [ ] Write unit tests for `relativeTime()` format function (< 60s, < 60m, ≥ 1h boundaries)
- [ ] Write integration tests for Zone CRUD operations via REST API

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Dashboard Sidebar Alerts Zones |
