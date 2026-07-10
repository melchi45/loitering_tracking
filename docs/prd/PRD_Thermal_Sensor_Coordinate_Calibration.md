# PRD — Thermal Sensor Coordinate Calibration

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** ThermalOverlay — Sensor Coordinate Calibration
**Version:** 1.0
**Date:** 2026-07-10

---

## 1. Overview

Add a per-camera **Sensor Coordinate** (native thermal sensor resolution, e.g. 160×120) setting so `ThermalOverlay` can correctly scale raw ONVIF radiometry hotspot/coldspot coordinates onto the actual video resolution (e.g. 640×480), instead of assuming raw coordinates already match the video frame size.

---

## 2. User Stories

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| US-01 | System Integrator | Enter the thermal sensor's native resolution when editing a camera | LTS knows how to scale raw radiometry coordinates for that camera |
| US-02 | Security Operator | See the hotspot/coldspot crosshair land on the correct spot in the video | I can visually correlate a temperature alert with what's actually in the frame |
| US-03 | System Integrator | Leave Sensor Coordinate blank for cameras that already report full-resolution coordinates | I don't have to configure anything for cameras that don't need calibration |

---

## 3. Feature Specification

### 3.1 Camera Edit Modal — Sensor Coordinate Section

Location: `CameraEditModal.tsx`, RTSP/IP camera form, below the WebRTC Streaming toggle.

| Property | Value |
|---|---|
| Label | Sensor Coordinate |
| Inputs | Two `number` inputs: Width, Height |
| Placeholder | `Width (e.g. 160)` / `Height (e.g. 120)` |
| Helper text | "Thermal sensor's native resolution (e.g. 160 x 120). Leave blank if the camera already reports temperature coordinates at full video resolution." |
| Empty value | Persists as `null` (no calibration) |
| Persisted field | `Camera.thermalSensorWidth` / `Camera.thermalSensorHeight` |

Not shown on the YouTube camera edit form (thermal calibration is an IP-camera-only concept).

### 3.2 Data Model

```typescript
interface Camera {
  // ...existing fields
  thermalSensorWidth?: number | null;
  thermalSensorHeight?: number | null;
}
```

### 3.3 Calibration Behavior

| Scenario | Behavior |
|---|---|
| `thermalSensorWidth`/`Height` both set (e.g. 160×120), video is 640×480 | Raw coordinate `(px, py)` in 160×120 space is normalized to a 0–1 fraction, then mapped onto the full letterboxed video render area — crosshair spreads across the entire visible frame |
| `thermalSensorWidth`/`Height` unset (`null`) | `ThermalOverlay` falls back to `frameWidth`/`frameHeight` as the normalization base — identical to pre-calibration behavior |
| Only one of width/height set | Treated as unset for that axis (component falls back per-axis to `frameWidth`/`frameHeight`) |

### 3.4 API

| Endpoint | Change |
|---|---|
| `PUT /api/cameras/:id` | Accepts optional `thermalSensorWidth`, `thermalSensorHeight` in body; `0`/empty string persists as `null` |
| `POST /api/cameras` | Accepts the same optional fields at camera creation time |

---

## 4. Edge Cases

| Scenario | Behaviour |
|---|---|
| Sensor Coordinate saved as 0×0 | Treated as not configured (`0` is falsy) — falls back to `frameWidth`/`frameHeight` |
| Camera has Sensor Coordinate but video resolution (`frameWidth`/`frameHeight`) not yet known (e.g. stream not started) | `toScreen()` returns off-screen coordinates (`-9999, -9999`) — same guard as before, since `frameWidth`/`frameHeight` are still required for the letterbox render area |
| Operator edits Sensor Coordinate mid-session | Takes effect on the next `onvif:temperature` event — no reconnect/pipeline restart needed (client-side rendering only) |
| Camera type is YouTube | Sensor Coordinate fields not shown; field remains `null` |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-10 | 초기 작성 |
