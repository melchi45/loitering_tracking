# PRD — ONVIF Event Timeline Zoom Controls

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** ONVIF Event Timeline — Zoom In / Zoom Out Button Controls  
**Version:** 1.0  
**Date:** 2026-06-30

---

## 1. Overview

Add **+** and **−** on-screen zoom buttons to the `OnvifTimelineInline` control bar so operators can zoom the ONVIF Event Timeline without a mouse scroll wheel.

---

## 2. User Stories

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| US-01 | Security Operator | Click + to zoom in on the timeline | I can inspect events in a narrow time window |
| US-02 | Security Operator | Click − to zoom out | I can see the broader context around an event |
| US-03 | Field Technician | Use zoom controls without a scroll wheel | I can work effectively on a laptop trackpad or kiosk |
| US-04 | Security Operator | See the − button disabled at 1× | I know I am already at the widest view |

---

## 3. Feature Specification

### 3.1 Button Location

The `+` and `−` buttons are placed in the existing control bar, between the zoom level badge and the Refresh button:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [1H][6H][1D][1W][1M][1Y][Custom]  [Event Type ▾]  ←spacer→  [×2.0] [+][−] [↺]  5/12 │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Zoom In (+)

| Property | Value |
|---|---|
| Label | `+` |
| title tooltip | `Zoom in` |
| Action | `applyZoom(1.4)` |
| Enabled | Always |
| Max effect | `zoom` capped at 500× |

### 3.3 Zoom Out (−)

| Property | Value |
|---|---|
| Label | `−` (minus sign, U+2212) |
| title tooltip | `Zoom out` |
| Action | `applyZoom(1/1.4)` |
| Disabled when | `zoom ≤ 1` |
| Visual style when disabled | `opacity-30 cursor-not-allowed` |

### 3.4 Existing Behaviour Unchanged

| Feature | Status |
|---|---|
| Mouse wheel zoom on overview strip | Unchanged |
| Drag-to-pan | Unchanged |
| ◀ ▶ pan buttons (zoom > 1) | Unchanged |
| ✕ reset button (zoom > 1) | Unchanged |
| Zoom badge `×N.N` | Unchanged (still appears when zoom > 1) |

---

## 4. Edge Cases

| Scenario | Behaviour |
|---|---|
| Click + at zoom = 500× | `applyZoom` clamps at 500×; no visible change |
| Click − at zoom = 1× | Button is disabled; click has no effect |
| Click + then range button | Range button resets zoom to 1 and pan to 0 (existing behaviour) |
| Rapid repeated clicks | Each click multiplies zoom by 1.4; pan is reclamped after each |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-30 | 초기 작성 |
