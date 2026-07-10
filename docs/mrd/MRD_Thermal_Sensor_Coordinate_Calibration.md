# MRD — Thermal Sensor Coordinate Calibration

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** ThermalOverlay — Sensor Coordinate Calibration
**Version:** 1.0
**Date:** 2026-07-10
**Author:** LTS Engineering Team

---

## 1. Executive Summary

Thermal (radiometry) IP cameras report BoxTemperatureReading hotspot/coldspot coordinates in the **thermal sensor's native resolution** (e.g. 160×120), which is almost always lower than the camera's actual video streaming resolution (e.g. 640×480). `ThermalOverlay` previously scaled these raw coordinates using the video frame resolution as the divisor, so crosshairs collapsed into the top-left corner of the video — at most a 160×120 pixel box inside a 640×480 frame — instead of spreading across the full visible image. Operators need the crosshair to land on the exact point in the video where the hotspot actually is, otherwise they cannot correlate a temperature reading with what they see on screen.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| Thermal crosshair confined to a small corner of the video | Operators cannot tell where the hot/cold spot actually is in the frame |
| No way to tell LTS the sensor's native resolution | System has no way to know the raw coordinate space differs from video resolution |
| Manual/visual estimation of true hotspot location | Delays incident response (e.g. fire hotspot triage), increases operator error |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Operator | Monitors thermal camera feeds for fire/hotspot detection in the live dashboard |
| System Integrator | Adds/configures a new thermal camera model with a known sensor resolution (e.g. 160×120, 384×288) |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Operators must be able to configure a thermal camera's native sensor resolution ("Sensor Coordinate") per camera |
| BR-02 | When configured, raw BoxTemperatureReading coordinates must be scaled onto the actual video resolution before rendering |
| BR-03 | Cameras without a configured sensor resolution must keep the existing (pre-calibration) behavior — no regression |
| BR-04 | Configuration must be available from the existing Camera Edit UI — no separate admin screen |

---

## 5. Success Metrics

- Crosshair markers visually align with the true hotspot/coldspot location across the full video frame, not just a corner, for any camera with Sensor Coordinate configured
- Zero behavior change for cameras that do not set Sensor Coordinate (backward compatible default)
- No additional network/DB load — calibration is a static per-camera field, not a per-frame computation on the server

---

## 6. Out of Scope

- Automatic sensor-resolution detection via ONVIF GetVideoSourceConfiguration or vendor CGI
- Per-area (multi-zone) independent calibration — one sensor resolution applies to the whole camera
- Historical/DB-stored temperature snapshot re-calibration (only live `onvif:temperature` overlay is affected)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-10 | 초기 작성 |
