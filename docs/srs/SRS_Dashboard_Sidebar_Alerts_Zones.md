# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Dashboard Sidebar — Alerts and Zones Panel

| | |
|---|---|
| **Document ID** | SRS-LTS-UI-AZ-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_Dashboard_Sidebar_Alerts_Zones.md |
| **Parent RFP** | rfp/RFP_Dashboard_Sidebar_Alerts_Zones.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Alerts Panel](#3-functional-requirements--alerts-panel)
4. [Functional Requirements — Zones Tab Hint](#4-functional-requirements--zones-tab-hint)
5. [Functional Requirements — Zone Editor](#5-functional-requirements--zone-editor)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [Interface Requirements](#7-interface-requirements)
8. [Constraints & Assumptions](#8-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the Alerts Panel and Zone Editor components of LTS-2026. Each requirement is identified by a unique ID (FR-UI-AZ-NNN) and is directly traceable to test cases in TC_Dashboard_Sidebar_Alerts_Zones.md.

### 1.2 Scope

This document covers:
- Real-time alert reception, display, acknowledgment, and bulk clear
- Zones tab hint directing operators to the fullscreen zone editor
- Zone Editor fullscreen canvas interface (draw, edit, delete, save polygon)
- Zone configuration (name, type, thresholds) and REST API persistence

Out of scope: alert filtering by camera/zone/date (Phase-2), alert audio notifications (Phase-2), `targetClasses` UI editing (API-only).

### 1.3 Definitions

| Term | Definition |
|---|---|
| Alert | A loitering event record: `{ id, cameraId, objectId, zone?, dwellTime, timestamp, acknowledged }` |
| Zone | A detection boundary: `{ id, cameraId, name, type, polygon, dwellThreshold, minDisplacement, minRiskScore }` |
| MONITOR Zone | Zone type that generates loitering alerts when thresholds are exceeded |
| EXCLUDE Zone | Zone type that suppresses detections within the polygon boundary |
| AlertStore | Zustand store holding `alerts[]` with `addAlert`, `acknowledgeAlert`, `clearAlerts` actions |
| ZoneEditor | Fullscreen canvas overlay for polygon draw/edit, accessible only from FullscreenCameraView |

---

## 2. System Overview

```
Socket.IO 'alert' event
  └─ AlertStore.addAlert()
       └─ AlertPanel (sidebar Alerts tab)
            ├─ Unacknowledged count badge
            ├─ Alert rows (newest first, max 20)
            └─ POST /api/alerts/:id/acknowledge

FullscreenCameraView
  └─ ZoneEditor (fixed inset-0 z-[100])
       ├─ Canvas (draw, select, drag vertices)
       └─ REST API: GET/POST/PUT/DELETE /api/cameras/:cameraId/zones
```

---

## 3. Functional Requirements — Alerts Panel

### FR-UI-AZ-001 — Real-Time Alert Reception

The AlertPanel shall subscribe to the Socket.IO `alert` event via `window.__ltsSocket` and call `AlertStore.addAlert(alert)` to prepend the alert to the list.

### FR-UI-AZ-002 — Panel Header — Unacknowledged Count Badge

The panel header shall display the title (i18n key `alertTitle`) and an unacknowledged count badge only when count > 0. The badge shall be a red circle (`min-w-[20px]`) showing the count or `9+` if count ≥ 10.

### FR-UI-AZ-003 — Panel Header — Clear All Button

A "Clear All" button shall appear in the header only when `alerts.length > 0`. Clicking it shall call `AlertStore.clearAlerts()`, emptying the client-side list. No DELETE API call shall be made; server-side history is preserved.

### FR-UI-AZ-004 — Alert Row Display Fields

Each alert row shall display the following fields:
- Warning icon ⚠: `text-red-400` when unacknowledged, `text-gray-500` when acknowledged
- Camera name: looked up from `CameraStore` by `alert.cameraId`; shows raw ID if not found
- Relative timestamp: `relativeTime(timestamp)` format (< 60 s → "Ns ago", < 60 m → "Nm ago", ≥ 1 h → "Nh ago")
- Object number: `Obj #{objectId}`
- Zone name: `· {zone}` (omitted if absent)
- Dwell time: `Dwell: {dwellTime.toFixed(1)}s`
- Ack button: shown only when `!alert.acknowledged`

### FR-UI-AZ-005 — Alert Row Visual States

| State | CSS |
|---|---|
| Unacknowledged | `bg-gray-800 border-red-900/40 bg-red-950/20` |
| Acknowledged | `bg-gray-800 border-gray-700 opacity-60` |

### FR-UI-AZ-006 — Alert Acknowledgment

Clicking the "Ack" button shall:
1. Call `POST /api/alerts/:id/acknowledge`
2. Call `AlertStore.acknowledgeAlert(id)` to set the acknowledged state in local store immediately

Local update shall proceed even if the API call fails.

### FR-UI-AZ-007 — Display Limit

The panel shall display a maximum of 20 alerts (newest first). Items beyond 20 shall be silently truncated.

### FR-UI-AZ-008 — Empty State

When `alerts.length === 0`, the panel shall display a centered check-circle icon (40% opacity) and "No alerts" text (`text-xs text-gray-600`).

---

## 4. Functional Requirements — Zones Tab Hint

### FR-UI-AZ-010 — Zones Tab Sidebar Content

The Zones tab in the sidebar shall not render the zone editor directly. It shall display only:
- A map icon
- i18n key `zoneHint`: "Open fullscreen camera view to draw and manage detection zones"

### FR-UI-AZ-011 — No Camera Sub-Hint

When no cameras are registered, the Zones tab shall additionally display the sub-hint (i18n key `addCameraFirst`): "Add a camera to get started".

### FR-UI-AZ-012 — Zone Editor Entry Path

The ZoneEditor shall only be accessible via: Dashboard → double-click camera cell → FullscreenCameraView → click "Zone Editor" button.

---

## 5. Functional Requirements — Zone Editor

### FR-UI-AZ-020 — Zone Editor Overlay

`ZoneEditor` shall render as a `fixed inset-0 z-[100]` fullscreen overlay with:
- Background: the camera's last captured JPEG frame
- Canvas layer covering the full area for polygon interaction
- Right control panel (fixed `w-64`)

### FR-UI-AZ-021 — Control Panel Header

The ZoneEditor control panel shall show a title "Zone Edit" (i18n `zoneEdit`) and an `×` button that exits `ZoneEditor` and returns to `FullscreenCameraView`.

### FR-UI-AZ-022 — Mode Switching

The ZoneEditor shall support two modes:

| Mode | Button | Active Style |
|---|---|---|
| `idle` | "Select / Edit" | `bg-gray-700 text-white` |
| `draw` | "+ Add Zone" | `bg-blue-800 text-white` |

### FR-UI-AZ-023 — Idle Mode — Zone Properties Panel

When a zone is selected in idle mode, the panel shall show:
- Editable name input (saved on blur or Enter via `PUT /api/cameras/:id/zones/:zoneId`)
- Zone type badge: MONITOR (blue) or EXCLUDE (yellow), read-only
- Vertex count (read-only)
- Deselect button
- "Save Polygon" button

When no zone is selected in idle mode, hint text (i18n `zoneClickToSelect`) shall be displayed.

### FR-UI-AZ-024 — Draw Mode — Drawing Settings

| Field | Range/Options | Default |
|---|---|---|
| Zone name | text input | "Zone N" |
| Zone type | MONITOR / EXCLUDE | MONITOR |
| Dwell Threshold | 5–300 s (slider) | 30 s |
| Min Displacement | 10–200 px (slider) | 50 px |
| Min Risk Score | 0.00–1.00 step 0.05 | 0.00 |

Dwell Threshold, Min Displacement, and Min Risk Score sliders shall be hidden when zone type is EXCLUDE.

### FR-UI-AZ-025 — Draw Mode — Minimum Vertices for Save

In draw mode, the "Save" button shall be enabled only when ≥ 3 vertices have been placed and the zone name is non-empty. A Reset button shall clear `drawPoints`.

### FR-UI-AZ-026 — Zone Creation API Call

Saving a new polygon shall call `POST /api/cameras/:cameraId/zones` with the polygon array, name, type, and threshold fields. On success the zone shall be added to the saved zones list.

### FR-UI-AZ-027 — Canvas Interaction Behaviors

| Action | Behavior |
|---|---|
| Click (draw mode) | Add vertex to `drawPoints` |
| Click (idle, over zone) | Select zone |
| Click (idle, over vertex) | Select vertex for move |
| Drag (vertex) | Real-time vertex position update |
| Double-click | Confirm vertex move |
| Right-click | Context menu: "Delete Zone" / "Delete Vertex" |

"Delete Vertex" shall only be available when the selected zone has ≥ 4 vertices; deleting a vertex shall trigger an auto-save of the updated polygon.

### FR-UI-AZ-028 — Zone Polygon Visual Styles

| Zone/State | Fill | Border |
|---|---|---|
| MONITOR (default) | `rgba(59,130,246,0.15)` | `#3b82f6` |
| MONITOR (selected) | `rgba(59,130,246,0.32)` | `#3b82f6` |
| EXCLUDE (default) | `rgba(245,158,11,0.15)` | `#f59e0b` |
| EXCLUDE (selected) | `rgba(245,158,11,0.32)` | `#f59e0b` |

Vertex circles: radius 6 px, zone color fill + white border. Selected vertex: yellow highlight. Cursor states: `crosshair` (draw), `grab` (over vertex), `grabbing` (dragging).

### FR-UI-AZ-029 — Zone Edit API Calls

Saving an edited polygon (vertex drag + "Save Polygon") shall call `PUT /api/cameras/:cameraId/zones/:zoneId`.

### FR-UI-AZ-030 — Zone Deletion

Right-clicking a selected zone and confirming "Delete Zone" shall call `DELETE /api/cameras/:cameraId/zones/:zoneId`. The zone shall be removed from the saved zones list on success.

### FR-UI-AZ-031 — Saved Zones List

The bottom of the right panel shall list all saved zones for the current camera with:
- Color dot (MONITOR=blue, EXCLUDE=yellow)
- Zone name
- Dwell threshold label for MONITOR zones, or "EXCLUDE" label for EXCLUDE zones
- `✕` delete button

### FR-UI-AZ-032 — Zone Loading on Editor Open

When `ZoneEditor` opens, it shall call `GET /api/cameras/:cameraId/zones` to load existing zones and render them on the canvas.

### FR-UI-AZ-033 — Zone Label on Canvas

Zone labels shall be rendered at the polygon centroid: `bold 10px sans-serif`, `rgba(0,0,0,0.65)` background, MONITOR text `#60a5fa`, EXCLUDE text `#fbbf24`.

### FR-UI-AZ-034 — Internationalization

All user-visible strings in the Alerts and Zones panels shall use i18n keys from `useI18n` and shall support all 15 configured languages without layout overflow.

---

## 6. Non-Functional Requirements

### 6.1 Performance

- Alert rows shall render within 100 ms of receiving the Socket.IO `alert` event
- Zone polygon save (POST/PUT) shall complete within 2 seconds on the local network
- Canvas vertex drag shall update at ≥ 30 fps (≤ 33 ms per frame) during polygon editing

### 6.2 Reliability

- Alert acknowledgment local update shall succeed even when the REST API call fails (offline resilience)
- Zone data shall be re-fetched on ZoneEditor open to ensure consistency with server state

### 6.3 Responsiveness

- The Alerts panel header and rows shall be fully visible at sidebar widths from 180 px to 600 px
- Touch targets (Ack button, zone mode buttons, Save) shall be ≥ 44 × 44 px

### 6.4 Internationalization

- All user-visible strings shall use i18n keys; 15 languages supported
- Keys include: `alertTitle`, `zoneHint`, `addCameraFirst`, `zoneEdit`, `zoneClickToSelect`

---

## 7. Interface Requirements

### 7.1 REST API Summary

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/alerts` | Fetch alert list (used on mount) |
| POST | `/api/alerts/:id/acknowledge` | Acknowledge an alert |
| GET | `/api/cameras/:cameraId/zones` | Fetch all zones for a camera |
| POST | `/api/cameras/:cameraId/zones` | Create a zone |
| PUT | `/api/cameras/:cameraId/zones/:zoneId` | Update a zone |
| DELETE | `/api/cameras/:cameraId/zones/:zoneId` | Delete a zone |

### 7.2 Socket.IO Events Consumed

| Event | Direction | Handler |
|---|---|---|
| `alert` | S→C | `AlertStore.addAlert()` |
| `loitering` | S→C | Canvas overlay in FullscreenCameraView |

### 7.3 TypeScript Data Models

```typescript
interface Alert {
  id:           string;
  cameraId:     string;
  objectId:     number;
  zone?:        string;
  dwellTime:    number;     // seconds
  timestamp:    number;     // Unix ms
  acknowledged: boolean;
}

interface Zone {
  id:               string;
  cameraId:         string;
  name:             string;
  type:             'MONITOR' | 'EXCLUDE';
  polygon:          Array<{ x: number; y: number }>;
  dwellThreshold?:  number;   // default 30 s
  minDisplacement?: number;   // default 50 px
  minRiskScore?:    number;   // default 0.0
  active?:          boolean;  // default true
  targetClasses?:   string[];
}
```

---

## 8. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Zone editing (draw/edit) is only accessible via the FullscreenCameraView — not directly from the sidebar Zones tab |
| C-02 | `AlertStore` is in-memory (Zustand); clearing alerts via "Clear All" does not delete server-side history |
| C-03 | Zone polygon coordinates are in frame-pixel space, origin top-left |
| C-04 | Only MONITOR zones generate alerts; EXCLUDE zones suppress detections within the polygon |
| C-05 | `targetClasses` editing is API-only in this release; not exposed in the ZoneEditor UI |
| C-06 | Alert display is capped at 20 items; scroll-based pagination is not implemented in this release |
| C-07 | `window.__ltsSocket` must be populated by App.tsx before AlertPanel mounts |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Dashboard Sidebar Alerts Zones |
