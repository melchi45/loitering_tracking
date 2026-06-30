# RFP — ONVIF Event Timeline Zoom Controls

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** ONVIF Event Timeline — Zoom In / Zoom Out Button Controls  
**Version:** 1.0  
**Date:** 2026-06-30

---

## 1. Background

`OnvifTimelineInline` (embedded in `FullscreenCameraView` → ONVIF Timeline tab) currently exposes zoom only via mouse scroll wheel on the overview strip. This is inaccessible without a wheel device. The component already maintains a `zoom` state (1–500×) and an `applyZoom(factor)` helper. The request is to expose this via explicit on-screen buttons.

---

## 2. Scope

Add two buttons — **+** (zoom in) and **−** (zoom out) — in the existing control bar of `OnvifTimelineInline.tsx`, placed immediately to the left of the Refresh (↺) button.

---

## 3. Functional Requirements

### 3.1 Button Placement

```
[1H][6H][1D][1W][1M][1Y][Custom]  [Event Type ▾]    [×2.0]  [+] [−] [↺]  5/12
```

- `+` and `−` buttons appear to the left of the Refresh button
- `×N.N` zoom badge (already present when zoom > 1) remains to the left of `+`

### 3.2 Zoom In (+)

- Factor: `×1.4` per click (same as one mouse wheel tick upward)
- Maximum zoom: `500×` (existing cap in `applyZoom`)
- Always enabled (at max zoom, additional clicks have no visible effect)

### 3.3 Zoom Out (−)

- Factor: `÷1.4` per click (same as one mouse wheel tick downward)
- Minimum zoom: `1×` — button SHALL be visually disabled (`opacity-30`, `cursor-not-allowed`) when `zoom ≤ 1`
- Clicking at `zoom = 1` SHALL be a no-op

### 3.4 Interaction with Existing Controls

- Button zoom SHALL call the same `applyZoom()` helper used by the wheel handler → no divergent logic
- Pan bar, ◀ ▶ buttons, drag-pan, and Reset button remain unchanged
- Zoom level badge updates immediately

### 3.5 Accessibility

- `title` attribute: `"Zoom in"` / `"Zoom out"` for tooltip
- Buttons use `button` element (keyboard focusable)

---

## 4. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Consistency | Same zoom factor (1.4×) as wheel interaction |
| Layout | Must not cause the control bar to wrap or overflow on typical 1280px+ width screens |
| Performance | No additional state, no extra renders beyond what `applyZoom()` already triggers |

---

## 5. UI Mockup

```
Control bar (before):
  [1H][6H][1D]…  [Event Type ▾]  [×2.0]  [↺]  5/12

Control bar (after):
  [1H][6H][1D]…  [Event Type ▾]  [×2.0]  [+] [−] [↺]  5/12
                                           ↑   ↑
                                       zoom in  zoom out
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-30 | 초기 작성 |
