# Product Requirements Document — Stats Dashboard Panel
**Document ID**: PRD-STATS-001  
**Version**: 1.0  
**Date**: 2026-05-27  
**Product**: LTS-2026 Loitering Tracking System  
**Feature**: Stats Dashboard Panel

---

## 1. Problem Statement

A monitoring operator must navigate through at least 6 tabs (Cameras, Alerts, Zones, Detections, Analytics, Face ID) sequentially to understand the current system operating status. This slows down the initial response time when an anomaly is detected, and the "situational awareness" capability to view the overall status in a single view is absent.

---

## 2. Goals

| Goal | Success Metric |
|---|---|
| Reduce time to understand operational status | View all key metrics with a single click |
| Monitor AI/camera system status | Instantly recognize per-camera status via color coding |
| Visualize event trends | 7-day bar chart visualization |
| Display DB mode | Show JSON/MongoDB operating mode in UI |

---

## 3. User Stories

### US-01: View Status Summary
> As a monitoring operator, when I click the 📊 icon in the header, I want to see camera connection status, alert status, and detection event counts on a single screen, so that I can quickly navigate to the relevant section when an anomaly occurs.

### US-02: View Event Trends
> As a monitoring operator, I want to see the detection event occurrence trends for the last 7 days as a bar chart, so that I can identify patterns by day of the week or time of day.

### US-03: Alert Severity Distribution
> As a monitoring operator, I want to see the ratio of unacknowledged alerts and HIGH/MEDIUM/LOW severity levels by color, so that I can quickly prioritize my response.

### US-04: Face ID Enrollment Status
> As a system administrator, I want to view the number of registered galleries and enrolled faces, so that I can monitor the Face ID data status.

### US-05: Confirm DB Mode
> As a system administrator, I want to confirm whether the current data is being served from JSON DB or MongoDB.

---

## 4. Feature Breakdown

### 4.1 Header Stats Button
- Location: Right side of the desktop/mobile header, to the left of the Settings (⚙) button
- Icon: Bar chart SVG (similar to 📊)
- Clicking displays the `StatsPanelModal` overlay

### 4.2 StatsPanelModal

**Layout**: Right slide-in panel (or center modal) — fixed width 420px, full height

**Section composition**:

| Section | Display Content |
|---|---|
| Camera Status | Total count, streaming/stopped/error/connecting color badges, RTSP/YouTube distinction |
| Detection Events | Total events, today's events, loitering detection count, last 7-day bar chart |
| Alert Status | Total alerts, unacknowledged count, HIGH(red)/MEDIUM(yellow)/LOW(green) ratio bar |
| Zone Status | Total zone count, by MONITOR/EXCLUDE type |
| Face ID | Gallery count, enrolled face count |
| Storage | DB mode (json/mongodb) + last update time |

**Interactions**:
- Refresh (↺) button in the panel header
- Close by clicking outside the panel or the X button
- Skeleton or spinner while loading

### 4.3 Backend API
- Endpoint: `GET /api/stats`
- Returns all aggregated data in a single response
- No authentication required (internal network)

---

## 5. Design Principles

1. **Zero dependencies** — No external chart library additions
2. **Read-only** — Stats panel cannot modify data
3. **On-demand** — API called only when panel is opened (no background polling)
4. **Graceful degradation** — Display error message on API failure, maintain app functionality

---

## 6. Out of Scope

- Real-time automatic refresh (polling/WebSocket)
- Date range filtering
- CSV/PDF export
- Per-camera drill-down detail view

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | The panel opens within 300ms when the 📊 button is clicked |
| AC-02 | Data is correctly displayed in all 6 sections |
| AC-03 | Date labels are displayed on the last 7-day bar chart |
| AC-04 | Unacknowledged alert count is highlighted in red when greater than 0 |
| AC-05 | Closes by clicking outside the panel |
| AC-06 | API is re-called when the refresh button is clicked |
| AC-07 | An "Unable to load data" message is displayed on API error |
| AC-08 | Functions correctly on mobile (< 768px) as well |

---

*Document approved by: LTS Product Team*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Stats Panel |
