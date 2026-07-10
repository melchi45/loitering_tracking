# Operations Guide — Thermal Sensor Coordinate Calibration

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** ThermalOverlay — Sensor Coordinate Calibration
**Version:** 1.0
**Date:** 2026-07-10

---

## 1. Overview

Thermal (radiometry) IP cameras report the pixel location of their hottest/coldest spot in the video using the **thermal sensor's own native resolution** (e.g. 160×120), which is usually much lower than the resolution the camera actually streams (e.g. 640×480). If LTS is not told the sensor's native resolution, the hotspot/coldspot crosshair only ever appears inside a small box in the top-left corner of the video instead of spreading across the whole frame.

**Sensor Coordinate** is a per-camera setting that fixes this by telling LTS what resolution the raw coordinates are actually in, so it can scale them onto the real video.

---

## 2. When You Need This

Configure Sensor Coordinate when **both** are true:

1. The camera is a thermal/radiometry camera that sends ONVIF `BoxTemperatureReading` events (see [ONVIF Timeline Guide](ONVIF_Timeline_Guide.md), [Design_Thermal_Radiometry_Overlay.md](../design/Design_Thermal_Radiometry_Overlay.md))
2. The crosshair markers in the live view visually appear confined to a small corner of the video instead of spanning the whole image

If the crosshair already lands on the correct spot across the full frame, leave Sensor Coordinate blank — the camera is already reporting coordinates at full video resolution.

---

## 3. Finding the Sensor's Native Resolution

The sensor resolution is a hardware spec of the thermal module, not something LTS can auto-detect. Check:

- The camera vendor's datasheet/spec sheet (look for "thermal resolution" or "IR resolution" — common values: 160×120, 256×192, 384×288, 640×480)
- The camera's own web admin UI, usually under a thermal/radiometry configuration page
- The raw `MaxTemperatureCoordinatesX/Y` values in the ONVIF Timeline (Raw XML view) — if every reading you observe stays under a certain X/Y ceiling (e.g. never above 160/120) across many frames, that ceiling is a strong hint at the sensor's native resolution

---

## 4. Configuring Sensor Coordinate

1. Open the camera list, click **Edit** on the thermal camera
2. Scroll to the **Sensor Coordinate** section (below the WebRTC Streaming toggle)
3. Enter the sensor's native **Width** and **Height** (e.g. `160` and `120`)
4. Click **Save only** (no reconnect needed — calibration is applied client-side on the next `onvif:temperature` event)
5. Open the camera's live view and confirm the crosshair now moves across the full video frame as the hotspot changes position

To remove calibration, clear both fields and save — this reverts to treating raw coordinates as already matching the video resolution.

---

## 5. Verifying Calibration Is Working

| Check | Expected |
|---|---|
| Live view, hotspot near frame center | Crosshair appears near the center of the visible video, not confined to a corner |
| Live view, hotspot near frame edge | Crosshair appears near the corresponding edge (respecting letterbox bars if the video aspect ratio differs from the panel) |
| Camera with no Sensor Coordinate configured | Crosshair behavior unchanged from before this feature (no regression) |

---

## 6. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Crosshair still confined to a corner after saving | Wrong sensor resolution entered, or saved values didn't take (check `GET /api/cameras/:id` for `thermalSensorWidth/Height`) | Re-check the vendor spec; re-save |
| Crosshair now off-screen entirely | Sensor Coordinate set much larger than the actual raw coordinate range (e.g. entered video resolution instead of sensor resolution) | Lower Width/Height to match the true sensor resolution |
| No crosshair at all | Not a calibration issue — check `appRtpCallbackUrl` registration per [Design_Thermal_Radiometry_Overlay.md](../design/Design_Thermal_Radiometry_Overlay.md) §3.1 first | See that document's troubleshooting invariants |
| Crosshair position looks correct on one axis but not the other | Only one of Width/Height was entered | Enter both values — a single missing axis falls back to `frameWidth`/`frameHeight` for that axis only |

---

## 7. Related Documents

- [Design_Thermal_Radiometry_Overlay.md](../design/Design_Thermal_Radiometry_Overlay.md) §8 — Sensor Coordinate Calibration design
- [SRS_Thermal_Radiometry_Overlay.md](../srs/SRS_Thermal_Radiometry_Overlay.md) §6 — FR-THERMAL-030~033
- [PRD_Thermal_Sensor_Coordinate_Calibration.md](../prd/PRD_Thermal_Sensor_Coordinate_Calibration.md)
- [TC_Thermal_Radiometry_Overlay.md](../tc/TC_Thermal_Radiometry_Overlay.md) — Group F

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-10 | 초기 작성 |
