# Request for Proposal — Stats Dashboard Panel
**Document ID**: LTS-2026-STATS-001  
**Version**: 1.0  
**Date**: 2026-05-27  
**Project**: LTS-2026 Loitering Tracking System  
**Classification**: Internal

---

## 1. Introduction

The LTS-2026 operations team proposes the design, implementation, and testing of the **Stats Dashboard Panel** feature, which enables on-site monitoring personnel to instantly grasp the overall operational status of the system with a single click on the statistics icon in the top-right corner of the dashboard.

The current LTS-2026 dashboard provides functional tabs for camera live view, alert panel, zone editing, and AI detection results, but lacks a single view — a **statistical aggregate view** — that presents camera connection status, detection event trends, alert severity distribution, Face ID enrollment status, and more at a glance.

---

## 2. Background & Business Need

| Problem | Impact |
|---|---|
| Understanding operational status requires navigating multiple tabs sequentially | Delayed initial response, risk of oversight |
| Cannot verify DB storage status (JSON/MongoDB) from the UI | Reduced trust in data integrity |
| No visualization of event/alert trends | Unable to analyze operational patterns |

---

## 3. Scope of Work

The proposing party must provide a fully functional solution that includes the following:

1. **Backend REST API** — `GET /api/stats`
   - Operates identically on both JSON DB and MongoDB
   - Aggregates statistics for cameras, zones, events, alerts, Face ID, and storage

2. **Frontend stats panel component** (`StatsPanelModal`)
   - Activated by clicking the chart icon in the top-right corner of the dashboard header
   - Per-section cards: Camera status, Detection events, Alerts, Zones, Face ID
   - Last 7-day event bar chart (SVG, no external libraries)
   - Responsive for desktop and mobile

3. **Automated tests** — `test/api/stats_panel.test.js`

4. **SDLC documents** — PRD, SRS, Design, TC

---

## 4. Functional Requirements Summary

| ID | Required Feature |
|---|---|
| F-01 | Provide a 📊 icon button in the top-right of the header |
| F-02 | Display a slide-in overlay panel on click |
| F-03 | Show total camera count, by status (streaming/stopped/error/connecting), and by type (RTSP/YouTube) |
| F-04 | Show total zone count by type (MONITOR/EXCLUDE) |
| F-05 | Show total event count, today's count, loitering detection count, and daily bar chart for the last 7 days |
| F-06 | Show total alert count, unacknowledged count, and count by severity (HIGH/MEDIUM/LOW) |
| F-07 | Show Face ID gallery count and enrolled face count |
| F-08 | Show storage mode (json/mongodb) |
| F-09 | Provide a manual refresh button |
| F-10 | Close by clicking outside the panel or via a close button |

---

## 5. Non-Functional Requirements Summary

| Item | Requirement |
|---|---|
| API response time | Within 300 ms (local DB baseline) |
| Component bundle size | No external chart libraries |
| Accessibility | WCAG AA color contrast |
| Browser support | Chrome 120+, Firefox 120+, Edge 120+ |

---

## 6. Deliverables

1. `server/src/api/stats.js`
2. `client/src/components/StatsPanelModal.tsx`
3. `client/src/App.tsx` modification (button + overlay)
4. `test/api/stats_panel.test.js`
5. SDLC document set (PRD, SRS, Design, TC)

---

## 7. Timeline Expectation

Design, implementation, and testing expected to be completed within a single sprint (2 weeks).

---

*Document prepared by: LTS Engineering Team*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Stats Panel |
