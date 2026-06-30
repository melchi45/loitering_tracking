# Operations Guide — ONVIF Event Timeline

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** ONVIF Event Timeline (OnvifTimelineInline)  
**Version:** 1.0  
**Date:** 2026-06-30

---

## 1. Overview

The ONVIF Event Timeline visualises ONVIF metadata events (motion, fire detection, line crossing, etc.) on a scrollable, zoomable horizontal Gantt timeline. It is embedded in the **FullscreenCameraView → ONVIF Timeline** tab.

---

## 2. Accessing the Timeline

1. Open any camera in fullscreen (click the expand icon or double-click a camera tile)
2. Select the **ONVIF Timeline** tab at the top of the fullscreen view

---

## 3. Time Range Presets

| Button | Window |
|---|---|
| 1H | Last 1 hour |
| 6H | Last 6 hours |
| 1D | Last 24 hours |
| 1W | Last 7 days |
| 1M | Last 30 days |
| 1Y | Last 365 days |
| Custom | User-defined from / to date-time |

Clicking a preset **resets zoom to 1× and pan to 0** (shows the full range).

---

## 4. Zoom Controls

The timeline supports three zoom input methods:

### 4.1 On-Screen Buttons (v2.8+)

`[+]` and `[−]` buttons appear in the control bar to the left of the Refresh button.

| Button | Action |
|---|---|
| **+** | Zoom in — narrows the visible time window by ×1.4 |
| **−** | Zoom out — widens the visible time window by ÷1.4; disabled (grayed) at 1× |

Each click is equivalent to one mouse wheel tick.

### 4.2 Mouse Wheel

Scroll **up** on the overview strip to zoom in; scroll **down** to zoom out. The overview strip is the single-row bar at the top of the timeline area.

### 4.3 Keyboard (OnvifTimelineOverlay only)

`↑` / `↓` keys zoom in/out when the overlay is in focus.

---

## 5. Zoom Indicator

When zoom > 1×, a badge `×N.N` appears in the control bar between the Event Type filter and the zoom buttons. The badge disappears when zoom returns to 1×.

---

## 6. Panning

When zoom > 1, a pan bar appears below the timeline:

| Control | Action |
|---|---|
| **◀** button | Pan toward older events |
| **▶** button | Pan toward newer events |
| **Drag** on overview strip | Pan freely |
| **✕** button | Reset zoom to 1× and pan to 0 |

---

## 7. Event Type Filter

The `[Event Type ▾]` dropdown filters which event types are shown. Selecting a type hides all other rows. Reset to `All Types` to show everything.

---

## 8. Event Detail

Click any event icon (bar segment) to open the detail panel on the right:

- **Parsed view**: structured ONVIF event data (topic, state, source token, items)
- **Raw XML**: toggle to see the raw ONVIF XML payload

Click **✕** in the detail panel to close it.

---

## 9. Custom Date Range

1. Click **Custom** in the preset row
2. A From / To date-time input row appears below the control bar
3. Fill both fields and click **Apply**
4. Click **✕** next to Apply to clear the custom range

---

## 10. Refresh

Click **↺** to reload events from the server with the current range and filter settings.

---

## 11. Snapshot Preview

For events where a camera frame was captured at event start (state=true), a thumbnail appears in the detail panel. Click the thumbnail to zoom in.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-30 | 초기 작성 — 줌 버튼 추가 포함 전체 가이드 |
