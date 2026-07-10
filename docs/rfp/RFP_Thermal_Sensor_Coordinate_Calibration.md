# RFP — Thermal Sensor Coordinate Calibration

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** ThermalOverlay — Sensor Coordinate Calibration
**Version:** 1.0
**Date:** 2026-07-10

---

## 1. Background

`ThermalOverlay.tsx` renders BoxTemperatureReading hotspot/coldspot crosshairs by normalizing raw `maxTempX/Y`/`minTempX/Y` pixel coordinates against `frameWidth`/`frameHeight` (the video frame resolution delivered via the `frame`/`detections` socket events, e.g. 640×480) inside `toScreen()`. In practice, the ONVIF radiometry module reports coordinates in the **thermal sensor's own native resolution** (e.g. 160×120), which is smaller than and unrelated to the video streaming resolution. Dividing raw coordinates by the wrong denominator confines every crosshair to the sensor's resolution box in the corner of the rendered video instead of spreading proportionally across it.

The `Camera` record has no field describing the sensor's native resolution, and the Camera Edit modal has no way to enter one.

---

## 2. Scope

Add a **Sensor Coordinate** (width × height) setting to the Camera Edit modal for IP/RTSP cameras, persist it on the `Camera` record, and use it in `ThermalOverlay` to correctly scale raw radiometry coordinates onto the actual video resolution before mapping them to screen pixels.

---

## 3. Functional Requirements

### 3.1 Camera Schema

- Add `thermalSensorWidth` and `thermalSensorHeight` (integer, nullable) fields to the `Camera` record.
- `null`/unset means "no calibration" — coordinates are assumed to already match the video resolution (current behavior).

### 3.2 Camera Edit UI

- `CameraEditModal.tsx` (RTSP/IP camera form only — not the YouTube form) SHALL expose two number inputs labeled **Sensor Coordinate**: Width and Height.
- Leaving both blank SHALL persist `null`/`null` (no calibration).
- Values SHALL be sent in the `PUT /api/cameras/:id` request body alongside existing fields.

### 3.3 Coordinate Calibration

- `ThermalOverlay` SHALL accept `sensorWidth`/`sensorHeight` props (sourced from `Camera.thermalSensorWidth/Height`).
- `toScreen(px, py, ...)` SHALL normalize `px`/`py` against `sensorWidth`/`sensorHeight` (not `frameWidth`/`frameHeight`) to compute the 0–1 fraction, then map that fraction onto the letterboxed render area computed from `frameWidth`/`frameHeight`.
- When `sensorWidth`/`sensorHeight` are not configured, they SHALL fall back to `frameWidth`/`frameHeight` — i.e., identical output to the pre-calibration implementation.

### 3.4 Persistence API

- `POST /api/cameras` and `PUT /api/cameras/:id` SHALL accept optional `thermalSensorWidth`/`thermalSensorHeight` in the request body and persist them via the existing schema-less `db.insert`/`db.update`.
- Sending an empty value clears calibration (`null`).

---

## 4. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Backward compatibility | Cameras without Sensor Coordinate configured render identically to before this change |
| Consistency | Same calibration logic applies uniformly regardless of camera vendor/model |
| Performance | Calibration is a pure client-side arithmetic change — no added network round-trips or server-side per-frame work |

---

## 5. UI Mockup

```
Camera Edit Modal (RTSP form):
  ...
  ── WebRTC Streaming toggle ──
  ── Sensor Coordinate ──────────────────────────
  Thermal sensor's native resolution (e.g. 160 x 120).
  Leave blank if the camera already reports temperature
  coordinates at full video resolution.
  [ Width (e.g. 160) ]   [ Height (e.g. 120) ]
  ────────────────────────────────────────────────
  [Cancel] [Save only] [Save & Reconnect]
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-10 | 초기 작성 |
