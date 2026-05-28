# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Detection Visualization & Display Module

| | |
|---|---|
| **Document ID** | PRD-LTS-003 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Dashboard_Detection_Display.md (LTS-2026-003 v2.4) |

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

The Detection Visualization & Display Module overlays real-time AI detections onto live camera feeds and presents a structured detection list panel, enabling security operators to immediately identify loitering persons, hazards, and their attributes (mask compliance, helmet status, color, cross-camera identity) without switching screens.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Render bounding boxes, labels, and attribute badges on a canvas overlay for all detected object classes (people, vehicles, accessories, fire/smoke, faces, and 50+ COCO classes).
- Apply consistent color coding per detection class and highlight loitering objects with a red override regardless of class.
- Display a structured per-object detection list (sorted: loitering first, then by dwell time) in the Fullscreen view's left 256px panel.
- Show AI attribute badges (mask, helmet, color, face ID, cross-camera Re-ID) both on canvas and in the detection list.
- Provide a collapsible 8-section detection legend pinned at the bottom of the detection panel.
- Expose a Video Analytics tab in the Dashboard sidebar for per-module AI toggle switches and Kalman tracker configuration.

### 2.2 Non-Goals

- Cloth attribute (PAR) display requires `openpar.onnx` and is deferred to Phase-2; it is defined here but not required for Phase-1 acceptance.
- Per-camera video recording or export is not in scope.
- Historical detection data browsing is not covered by this module.

---

## 3. User Personas

**Security Operator** — monitors live feeds and needs immediate visual confirmation of loitering events, fire/smoke, or mask non-compliance. Relies on color-coded bounding boxes and the LOITER/FIRE badge pulse to draw attention.

**Safety Compliance Officer** — reviews mask and helmet compliance badges in real time. Uses the detection list panel to verify `MASK OK` / `NO MASK` / `HELMET` / `NO HELMET` states and dwell durations.

**System Administrator** — configures which AI modules are active and tunes Kalman tracker parameters via the Video Analytics tab, without restarting cameras.

---

## 4. Functional Specification

### 4.1 Canvas Overlay Rendering

The canvas overlay is drawn on top of the live video inside `CameraView`. For every detection in the current frame:

1. Draw a bounding box using the class color (or red `rgba(239,68,68,0.9)` if `isLoitering=true`).
2. Render a top-left label: `face [FaceId]  conf%` for face class; `className #objectId  conf%` for all others. Font: `bold 12px monospace`, background `rgba(0,0,0,0.7)`.
3. Render attribute badges inside the bbox top-left: mask badge and helmet badge (14px height each, `bold 9px monospace`).
4. Render color attribute below the bbox bottom-left: `↑{upper} ↓{lower}`, gray `#d1d5db`.
5. Render cloth attribute below color line (Phase-2): `cloth ↑{upper} ↓{lower} [{sleeve}]`, violet `#a78bfa`.
6. Render dwell time bottom-right of bbox when `isLoitering=true` OR `dwellTime > 5.0s`: red background for loitering, dark gray otherwise.
7. Draw zone polygons: MONITOR zones in blue (`rgba(59,130,246,0.12)` fill), EXCLUDE zones in amber (`rgba(245,158,11,0.12)` fill), with centroid labels.

**Face detection** is rendered as an independent top-level object (not a sub-box inside person) using a 1.5px dashed `[4,3]` light-blue box with a very light fill.

**Fire/smoke** uses a 3px solid border plus semi-transparent fill background.

### 4.2 Detection List Panel (Fullscreen View)

The Fullscreen view uses a 2-column layout: left `DetectionPanel` (256px, fixed) and right video feed (`flex-1`). The panel has no tab bar.

**Panel header**: Shows object count and loitering count (`N obj  M loiter`).

**Detection rows** are sorted: loitering objects first, then descending `dwellTime`. Each row displays:
- Class name (uppercase), object ID (`#` + first 8 chars) or face ID (`[F1]`)
- Match score for face detections (`sim XX%`) with color thresholds (≥60% green, ≥40% yellow, <40% gray)
- `↔ CROSS-CAM` badge when the face ID is in a cross-camera Re-ID event
- Confidence, dwell time (yellow if > 5s), bbox coordinates (x/y/w/h in 2-column grid)
- AMF metrics for zone-matched objects: risk score, revisit count, velocity, circular motion score
- Attribute badges: LOITER (red), FIRE (orange, pulsing), SMOKE (slate), MASK variants, HELMET variants
- Color attribute: `upper {color} | lower {color}`
- Cloth attribute (Phase-2): violet text
- Face attribute on person: `face XX% [FaceId] identity`

**Cross-Camera Re-ID section**: Appears above the legend when `localEvents.length > 0`. Shows up to 5 most recent events in format `[FaceId] cameraName → cameraName similarity%`. Collapsible (default: expanded). Camera names resolved from `useCameraStore`; falls back to first 8 chars of UUID.

**Legend section**: 8 collapsible sections (default: collapsed), pinned at panel bottom, `max-h-64 overflow-y-auto` when expanded:
1. People & Vehicles, 2. Accessories (incl. sports), 3. Animals, 4. Outdoor/Infrastructure, 5. Food/Kitchen, 6. Home Appliances, 7. Indoor/Office, 8. AI Attribute Badges.

### 4.3 Dashboard Detection Tab (All-Camera Aggregated View)

The Detection tab in the Dashboard sidebar shows a merged detection list from all registered cameras:
- A checkbox dropdown at the top filters by camera (All / individual cameras)
- Detections from all enabled cameras are merged and sorted (loitering first, then dwell time descending)
- Each row shows a camera name badge (teal/gray chip)
- Powered by the `useAllDetections(ids)` hook which manages Socket.IO subscriptions per camera

### 4.4 Video Analytics Tab

Located as the 5th tab (`analytics`) in the Dashboard sidebar (`w-72`). Provides:
- Toggle buttons for all AI modules grouped into: People & Vehicles, Accessories, AI Attributes, Hazards, Indoor/Office
- Model availability gating via `GET /api/capabilities` — unavailable models shown as grayed-out with "Not installed" label
- Phase-2 pending items shown as `opacity-35` with "Phase-2" label
- **Kalman/Tracker Settings** collapsible section (default: collapsed) with 6 sliders: Fast Speed Threshold, Fast Q Scale, Slow Speed Threshold, Slow Q Scale, Occlusion Q Scale, Measurement Noise (R). Changes debounced at 300ms and saved via `PUT /api/tracker/config`. Reset button calls `POST /api/tracker/config/reset`.

---

## 5. UI/UX Requirements

### 5.1 Detection Class Color Standards

| Class | Canvas Color | Panel Text |
|-------|-------------|-----------|
| person | `rgba(34,197,94,0.9)` green | `text-green-400` |
| loitering override | `rgba(239,68,68,0.9)` red | `text-red-400`, `bg-red-900/20` row |
| face | `rgba(147,197,253,0.95)` light-blue, dashed | `text-blue-300`, `bg-blue-900/15` row |
| car | `rgba(59,130,246,0.9)` blue | `text-blue-400` |
| fire | `rgba(255,80,0,1.0)` orange-red + fill | `text-orange-500`, `bg-orange-900/25` row |
| smoke | `rgba(100,116,139,0.9)` slate | `text-slate-400`, `bg-slate-800/40` row |
| accessories (backpack, handbag, etc.) | `rgba(245,158,11,0.9)` amber | `text-amber-400` |
| unrecognized fallback | `rgba(156,163,175,0.9)` gray | `text-gray-400` |

### 5.2 Status Badge Styles

| Badge | Tailwind |
|-------|----------|
| LOITER | `bg-red-600 text-white` |
| FIRE | `bg-orange-600 text-white animate-pulse` |
| MASK OK | `bg-green-700 text-green-100` |
| NO MASK | `bg-red-700 text-red-100` |
| MASK? (uncertain) | `bg-gray-600 text-gray-200` |
| HELMET | `bg-blue-700 text-blue-100` |
| NO HELMET | `bg-red-700 text-red-100` |
| HAT? (uncertain) | `bg-gray-600 text-gray-200` |
| CROSS-CAM | `bg-blue-700/70 text-blue-100` |

### 5.3 Fullscreen Layout

Two-column: `DetectionPanel` (256px fixed left) + `CameraView` (`flex-1` right). No tab bar inside the panel.

### 5.4 Kalman Slider Specifications

| Slider | Default | Range | Step |
|--------|---------|-------|------|
| Fast Speed Threshold | 30 | 5–100 | 1 px/f |
| Fast Q Scale | 4.0 | 1.0–10.0 | 0.5 |
| Slow Speed Threshold | 5 | 1–20 | 1 px/f |
| Slow Q Scale | 0.50 | 0.1–1.0 | 0.05 |
| Occlusion Q Scale | 3.0 | 1.0–10.0 | 0.5 |
| Measurement Noise (R) | 10 | 1–50 | 1 |

---

## 6. Technical Requirements

### 6.1 Frontend Stack

- React + TypeScript; canvas rendering via `requestAnimationFrame`
- Tailwind CSS for detection panel and badge styles
- Zustand: `useCrossCameraStore` (max 20 events, 60s expiry), `useCameraStore`
- Socket.IO events: `detections`, `frame`, `loitering`, `fire:alert`, `face:reidentified`

### 6.2 Socket.IO `detections` Payload

Key fields on `Detection` objects:
- `objectId`, `className`, `confidence`, `bbox`, `isLoitering`, `dwellTime`
- `faceId?`, `matchScore?`, `crossCamera?` (face-related)
- `riskScore?`, `revisitCount?`, `velocity?`, `circularScore?` (AMF/zone-matched)
- `face?`, `mask?`, `hat?`, `color?`, `cloth?` (attribute enrichment)

### 6.3 API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/analytics/config` | Fetch module enable/disable states |
| PUT | `/api/analytics/config` | Update module states |
| GET | `/api/capabilities` | Fetch model availability |
| GET | `/api/tracker/config` | Fetch Kalman parameters |
| PUT | `/api/tracker/config` | Update Kalman parameters |
| POST | `/api/tracker/config/reset` | Reset to defaults |

### 6.4 Performance Requirements

| Item | Requirement |
|------|------------|
| Canvas overlay latency | < 5ms after frame receipt (requestAnimationFrame) |
| Detection list update rate | ≤ 1 update per frame at 60fps |
| Max simultaneous objects rendered | 100 per camera |
| Inference frame-drop guard | Skip frame if previous inference still running (`_inferring` flag) |
| Fire alert cooldown | 10 seconds per camera+zone+class |

### 6.5 Required Model Files

| File | Size | Purpose |
|------|------|---------|
| `yolov8n.onnx` | ~6 MB | Person/vehicle/accessory/indoor detection |
| `scrfd_2.5g.onnx` | ~3.2 MB | Face detection |
| `yolov8m_ppe.onnx` | ~99 MB | Mask/helmet PPE detection |
| `arcface_w600k_r50.onnx` | ~249 MB | Face recognition embeddings |
| `yolov8s_fire_smoke.onnx` | ~22 MB | Fire/smoke detection |
| `openpar.onnx` (Phase-2) | ~90 MB | Cloth attribute (PAR) |

---

## 7. Acceptance Criteria

1. Bounding boxes render on the canvas within 5ms of frame receipt, using correct class colors; loitering objects render with a red border override regardless of class.
2. Face detections render as independent top-level bounding boxes with a 1.5px dashed light-blue style (not as a sub-box inside person bbox).
3. Fire/smoke bounding boxes render with a 3px border and semi-transparent fill, and the FIRE badge pulses (`animate-pulse`).
4. The detection list is sorted: loitering objects first, then descending `dwellTime`. Loitering rows have a `bg-red-900/20` background.
5. AMF metrics (risk score, revisit count, velocity, circular score) appear only for zone-matched objects.
6. The `↔ CROSS-CAM` badge appears on face rows whose `faceId` is present in `useCrossCameraStore` events involving the current camera.
7. The legend is collapsed by default and expands to show all 8 sections with a scrollable `max-h-64` container.
8. The Video Analytics tab correctly gates toggle availability based on `GET /api/capabilities`; missing models render as `opacity-35` with "Not installed".
9. Kalman slider changes are debounced 300ms and persisted; the Reset button restores all default values.
10. The Dashboard Detection tab checkbox filter correctly shows/hides per-camera rows, and the "All Cameras" label updates to "N / M cameras" on partial selection.

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|-----------|-------------|--------|-----------|--------|
| M1 | Canvas overlay (all Phase-1 classes, badges, dwell time) | TBD | Phase-1 done | ✅ Complete |
| M2 | Detection list panel (2-column fullscreen, legend, cross-cam) | TBD | Phase-1 done | ✅ Complete |
| M3 | Video Analytics tab + Kalman settings | TBD | Phase-1 done | ✅ Complete |
| M4 | Dashboard aggregated detection tab (all-camera merged view) | TBD | Phase-1 done | ✅ Complete |
| M5 | Phase-2: cloth attribute (PAR) canvas + panel display | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement cloth attribute (PAR) canvas rendering (`cloth ↑upper ↓lower [sleeve]`, violet `#a78bfa`) — requires `openpar.onnx`
- [ ] Implement cloth attribute display in the detection list panel (violet `text-violet-300`)
- [ ] Add glasses/sunglasses accessory detection (Phase-2 classifier)
- [ ] Add unit tests for canvas color-coding logic (all detection classes)
- [ ] Add unit tests for detection list sort order (loitering + dwell time)
- [ ] Verify `face:reidentified` Socket.IO event correctly populates `useCrossCameraStore` and triggers CROSS-CAM badge
- [ ] Test Kalman reset endpoint and confirm all slider values return to defaults in UI

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Dashboard Detection Display |
