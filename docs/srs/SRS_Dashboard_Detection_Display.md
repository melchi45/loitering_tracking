# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Dashboard — Detection Visualization & Display Module

| | |
|---|---|
| **Document ID** | SRS-LTS-UI-DD-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_Dashboard_Detection_Display.md |
| **Parent RFP** | rfp/RFP_Dashboard_Detection_Display.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Canvas Overlay Rendering](#3-functional-requirements--canvas-overlay-rendering)
4. [Functional Requirements — Detection List Panel](#4-functional-requirements--detection-list-panel)
5. [Functional Requirements — Dashboard Detection Tab](#5-functional-requirements--dashboard-detection-tab)
6. [Functional Requirements — Video Analytics Tab](#6-functional-requirements--video-analytics-tab)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [Interface Requirements](#8-interface-requirements)
9. [Constraints & Assumptions](#9-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the Detection Visualization & Display Module of LTS-2026. Each requirement carries a unique ID (FR-UI-DD-NNN) and is directly traceable to test cases in TC_Dashboard_Detection_Display.md.

### 1.2 Scope

This document covers:
- Real-time bounding-box and label canvas overlay on live camera feeds
- Detection list panel inside the Fullscreen Camera View
- Aggregated detection list in the Dashboard sidebar Detection tab
- Video Analytics tab with AI module toggles and Kalman tracker settings

Out of scope: cloth attribute (PAR) display (Phase-2), video recording/export, historical detection browsing.

### 1.3 Definitions

| Term | Definition |
|---|---|
| Detection | An AI-detected object with `objectId`, `className`, `confidence`, `bbox`, `isLoitering`, `dwellTime` fields |
| CameraView | React component that renders a live video stream inside a camera grid cell |
| DetectionPanel | React component listing detections sorted by loitering-first, then descending dwell time |
| AMF Metrics | Advanced Motion Features: `riskScore`, `revisitCount`, `velocity`, `circularScore` |
| Cross-Camera Re-ID | A face recognized on a different camera; exposes `↔ CROSS-CAM` badge |
| LOITER | State where `isLoitering === true` |

---

## 2. System Overview

```
Socket.IO 'detections' event
  └─ CameraView (canvas overlay + frame)
       └─ FullscreenCameraView
            └─ DetectionPanel (256 px fixed left panel)

Socket.IO 'detections' event (all cameras)
  └─ useAllDetections(cameraIds) hook
       └─ DashboardDetectionPanel (sidebar tab)

REST API
  ├─ GET  /api/analytics/config  → VideoAnalyticsTab toggles
  ├─ PUT  /api/analytics/config  → save toggle states
  ├─ GET  /api/capabilities       → model availability gating
  ├─ GET  /api/tracker/config    → Kalman slider values
  ├─ PUT  /api/tracker/config    → save slider changes
  └─ POST /api/tracker/config/reset → reset to defaults
```

---

## 3. Functional Requirements — Canvas Overlay Rendering

### FR-UI-DD-001 — Bounding Box Per Detection

The canvas overlay shall draw a bounding box for every detection in the current frame within 5 ms of frame receipt, using `requestAnimationFrame`.

### FR-UI-DD-002 — Detection Class Color Coding

Each bounding box shall use a class-specific color:

| Class | Canvas Color |
|---|---|
| person | `rgba(34,197,94,0.9)` green |
| loitering override | `rgba(239,68,68,0.9)` red |
| face | `rgba(147,197,253,0.95)` light-blue, 1.5 px dashed `[4,3]` |
| car | `rgba(59,130,246,0.9)` blue |
| fire | `rgba(255,80,0,1.0)` orange-red, 3 px border + fill |
| smoke | `rgba(100,116,139,0.9)` slate |
| accessories (backpack, handbag, etc.) | `rgba(245,158,11,0.9)` amber |
| unrecognized fallback | `rgba(156,163,175,0.9)` gray |

### FR-UI-DD-003 — Loitering Override Color

When `detection.isLoitering === true`, the bounding box color shall be overridden to `rgba(239,68,68,0.9)` regardless of the object class.

### FR-UI-DD-004 — Label Rendering

The overlay shall render a top-left label for each detection:
- Face class: `face [FaceId]  conf%`
- All other classes: `className #objectId  conf%`
- Font: `bold 12px monospace`; background: `rgba(0,0,0,0.7)`

### FR-UI-DD-005 — Attribute Badges on Canvas

The overlay shall render attribute badges inside the bbox top-left (14 px height each, `bold 9px monospace`):
- Mask badge (MASK OK / NO MASK / MASK?)
- Helmet badge (HELMET / NO HELMET / HAT?)

### FR-UI-DD-006 — Color Attribute Line

The overlay shall render the color attribute below the bbox bottom-left in format `↑{upper} ↓{lower}`, using gray `#d1d5db`.

### FR-UI-DD-007 — Dwell Time Display

Dwell time shall be rendered at the bottom-right of the bbox when `isLoitering === true` OR `dwellTime > 5.0 s`:
- Red background when loitering
- Dark gray background otherwise

### FR-UI-DD-008 — Zone Polygon Overlay

The canvas shall render zone polygons:
- MONITOR zones: `rgba(59,130,246,0.12)` fill, `#3b82f6` border, centroid label in `#60a5fa`
- EXCLUDE zones: `rgba(245,158,11,0.12)` fill, `#f59e0b` border, centroid label in `#fbbf24`
- Label font: `bold 10px sans-serif`, background `rgba(0,0,0,0.65)`

### FR-UI-DD-009 — Face Detection as Independent Box

Face detections shall be rendered as top-level independent bounding boxes using a 1.5 px dashed `[4,3]` light-blue box with a very light fill — not as a sub-box inside a person bbox.

### FR-UI-DD-010 — Fire/Smoke Visual Style

Fire/smoke bounding boxes shall use a 3 px solid border and a semi-transparent fill background. The FIRE badge shall include `animate-pulse` animation.

---

## 4. Functional Requirements — Detection List Panel

### FR-UI-DD-020 — Fullscreen Two-Column Layout

The Fullscreen Camera View shall use a two-column layout: `DetectionPanel` (256 px fixed left) and `CameraView` (`flex-1` right). No tab bar shall appear inside the panel.

### FR-UI-DD-021 — Panel Header Count Display

The DetectionPanel header shall display object count and loitering count in the format `N obj  M loiter`.

### FR-UI-DD-022 — Detection Row Sort Order

Detection rows shall be sorted: loitering objects first, then descending `dwellTime`.

### FR-UI-DD-023 — Detection Row Content

Each detection row shall display:
- Class name (uppercase) and object ID (`#` + first 8 chars) or face ID (`[F1]`)
- Match score for face detections (`sim XX%`), color-coded: ≥ 60% green, ≥ 40% yellow, < 40% gray
- `↔ CROSS-CAM` badge when `faceId` is present in `useCrossCameraStore` events for the current camera
- Confidence and dwell time (yellow if > 5 s)
- Bbox coordinates (x/y/w/h in 2-column grid)
- AMF metrics (`riskScore`, `revisitCount`, `velocity`, `circularScore`) only for zone-matched objects
- Attribute badges: LOITER (red), FIRE (orange pulsing), SMOKE (slate), MASK variants, HELMET variants
- Color attribute: `upper {color} | lower {color}`

### FR-UI-DD-024 — Loitering Row Style

Loitering detection rows shall have a `bg-red-900/20` background.

### FR-UI-DD-025 — Status Badge Styles

| Badge | Tailwind |
|---|---|
| LOITER | `bg-red-600 text-white` |
| FIRE | `bg-orange-600 text-white animate-pulse` |
| MASK OK | `bg-green-700 text-green-100` |
| NO MASK | `bg-red-700 text-red-100` |
| MASK? | `bg-gray-600 text-gray-200` |
| HELMET | `bg-blue-700 text-blue-100` |
| NO HELMET | `bg-red-700 text-red-100` |
| HAT? | `bg-gray-600 text-gray-200` |
| CROSS-CAM | `bg-blue-700/70 text-blue-100` |

### FR-UI-DD-026 — Cross-Camera Re-ID Section

The DetectionPanel shall display a collapsible Cross-Camera Re-ID section (default: expanded) above the legend when `localEvents.length > 0`. It shall show up to 5 most recent events in format `[FaceId] cameraName → cameraName similarity%`. Camera names are resolved from `useCameraStore`; falls back to first 8 chars of UUID.

### FR-UI-DD-027 — Collapsible Detection Legend

The legend shall be collapsed by default and pinned at the bottom of the panel. When expanded, it shall be `max-h-64 overflow-y-auto`. It shall contain 8 sections: People & Vehicles, Accessories, Animals, Outdoor/Infrastructure, Food/Kitchen, Home Appliances, Indoor/Office, AI Attribute Badges.

---

## 5. Functional Requirements — Dashboard Detection Tab

### FR-UI-DD-030 — Aggregated All-Camera Detection List

The Detection tab in the Dashboard sidebar shall display a merged detection list from all registered cameras.

### FR-UI-DD-031 — Camera Filter Dropdown

A checkbox dropdown at the top of the Detection tab shall allow filtering by camera (All / individual cameras). The "All Cameras" label shall update to "N / M cameras" on partial selection.

### FR-UI-DD-032 — Socket.IO Subscription Per Camera

The `useAllDetections(ids)` hook shall manage Socket.IO `detections` subscriptions per camera and merge results into a unified sorted list.

### FR-UI-DD-033 — Camera Name Badge Per Row

Each detection row in the aggregated list shall show a camera name badge (teal chip when live, gray chip otherwise).

---

## 6. Functional Requirements — Video Analytics Tab

### FR-UI-DD-040 — Tab Placement

The Video Analytics tab shall be the 5th tab (`analytics`) in the Dashboard sidebar.

### FR-UI-DD-041 — AI Module Toggle Buttons

The tab shall provide toggle buttons for all AI modules grouped as: People & Vehicles, Accessories, AI Attributes, Hazards, Indoor/Office. State is persisted via `PUT /api/analytics/config`.

### FR-UI-DD-042 — Model Availability Gating

Module toggles shall be gated by `GET /api/capabilities`. Unavailable models shall render as `opacity-35` with "Not installed" label and shall not be interactable.

### FR-UI-DD-043 — Phase-2 Module Indication

Phase-2 pending items (e.g., cloth/PAR) shall render as `opacity-35` with a "Phase-2" label and shall not be toggled.

### FR-UI-DD-044 — Kalman Tracker Settings

The tab shall include a collapsible "Kalman/Tracker Settings" section (default: collapsed) containing 6 sliders:

| Slider | Default | Range | Step |
|---|---|---|---|
| Fast Speed Threshold | 30 | 5–100 | 1 px/f |
| Fast Q Scale | 4.0 | 1.0–10.0 | 0.5 |
| Slow Speed Threshold | 5 | 1–20 | 1 px/f |
| Slow Q Scale | 0.50 | 0.1–1.0 | 0.05 |
| Occlusion Q Scale | 3.0 | 1.0–10.0 | 0.5 |
| Measurement Noise (R) | 10 | 1–50 | 1 |

### FR-UI-DD-045 — Kalman Change Debounce

Slider changes shall be debounced at 300 ms and persisted via `PUT /api/tracker/config`.

### FR-UI-DD-046 — Kalman Reset

A Reset button shall call `POST /api/tracker/config/reset` and restore all slider values to their defaults in the UI.

### FR-UI-DD-047 — Internationalization

All user-visible strings in the Detection Display module shall use i18n keys from `useI18n` and shall support all 15 configured languages without layout overflow.

---

## 7. Non-Functional Requirements

### 7.1 Performance

- Canvas overlay latency shall be < 5 ms after frame receipt (via `requestAnimationFrame`)
- Detection list update rate shall be ≤ 1 update per frame at 60 fps
- Maximum simultaneous objects rendered per camera: 100
- An inference frame-drop guard (`_inferring` flag) shall skip frames when previous inference is still running
- Fire alert cooldown: 10 seconds per camera+zone+class

### 7.2 Responsiveness

- The DetectionPanel shall be fully visible at all supported viewport widths (≥ 320 px)
- Touch targets for collapse toggle buttons shall be ≥ 44 × 44 px
- On mobile the fullscreen overlay shall switch to a vertical split (video top 60%, DetectionPanel bottom 40%)

### 7.3 Accessibility

- Attribute badges shall include a `title` or `aria-label` for screen reader compatibility
- Color coding shall not be the sole means of conveying information; text labels shall always accompany colored badges

### 7.4 Internationalization

- All user-visible strings shall be sourced from the i18n store and shall support all 15 configured languages

---

## 8. Interface Requirements

### 8.1 Socket.IO Events Consumed

| Event | Source | Purpose |
|---|---|---|
| `detections` | Server→Client | Per-camera detection array for canvas overlay and list |
| `frame` | Server→Client | JPEG frame for canvas rendering |
| `loitering` | Server→Client | Loitering alert payload |
| `fire:alert` | Server→Client | Fire detection alert |
| `face:reidentified` | Server→Client | Cross-camera Re-ID event for `useCrossCameraStore` |

### 8.2 REST API Summary

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/analytics/config` | Fetch AI module enable/disable states |
| PUT | `/api/analytics/config` | Update AI module states |
| GET | `/api/capabilities` | Fetch model availability |
| GET | `/api/tracker/config` | Fetch Kalman parameters |
| PUT | `/api/tracker/config` | Update Kalman parameters |
| POST | `/api/tracker/config/reset` | Reset Kalman parameters to defaults |

### 8.3 TypeScript Detection Interface

```typescript
interface Detection {
  objectId:      string;
  className:     string;
  confidence:    number;
  bbox:          { x: number; y: number; width: number; height: number };
  isLoitering:   boolean;
  dwellTime:     number;       // seconds
  faceId?:       string;
  matchScore?:   number;
  crossCamera?:  boolean;
  riskScore?:    number;
  revisitCount?: number;
  velocity?:     number;
  circularScore?:number;
  face?:         { identity?: string; faceId?: string; matchScore?: number };
  mask?:         { label: 'MASK OK' | 'NO MASK' | 'MASK?' };
  hat?:          { label: 'HELMET' | 'NO HELMET' | 'HAT?' };
  color?:        { upper: string; lower: string };
  cloth?:        { upper: string; lower: string; sleeve: string };  // Phase-2
}
```

---

## 9. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Canvas rendering uses `requestAnimationFrame`; no separate render thread |
| C-02 | `useCrossCameraStore` holds a maximum of 20 events with a 60-second expiry |
| C-03 | Cloth attribute (PAR) canvas and panel rendering is deferred to Phase-2 |
| C-04 | `window.__ltsSocket` must be populated by App.tsx before DetectionPanel components mount |
| C-05 | Model availability is checked once on mount via `GET /api/capabilities`; not live-polled |
| C-06 | Kalman slider debounce timer is component-local; navigating away before 300 ms may discard a change |
| C-07 | Maximum 100 detections per camera frame; excess are silently discarded by the pipeline |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Dashboard Detection Display |
