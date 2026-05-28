# Test Cases — Stats Dashboard Panel
**Document ID**: TC-STATS-001  
**Version**: 1.2  
**Date**: 2026-05-28  
**Based on**: SRS-STATS-001, DESIGN-STATS-001  
**Test Scripts**: `test/api/stats_panel.test.js`

---

## 1. Test Scope

| Target | Scope |
|---|---|
| `GET /api/stats` | Accuracy of camera, zone, event, alert, and Face ID aggregations; error handling |
| `StatsPanelModal` | Rendering, data fetching, interaction (Phase-3) |
| `App.tsx` header | Stats button exists; opens panel on click (Phase-3) |

---

## 2. Test Groups

### Group A — API Basic Response

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-A01 | 200 response | Server running | `GET /api/stats` | HTTP 200, `success: true`, `data` object present | P1 |
| TC-STATS-001-A02 | Response structure validation | Server running | Inspect response keys after `GET /api/stats` | All of `generatedAt`, `storage`, `cameras`, `zones`, `events`, `alerts`, `faces` present | P1 |
| TC-STATS-001-A03 | generatedAt ISO format | Server running | `GET /api/stats` | `data.generatedAt` is a valid ISO 8601 string | P2 |
| TC-STATS-001-A04 | storage.mode returned | `DB_TYPE=json` environment | `GET /api/stats` | `data.storage.mode === 'json'` | P1 |

### Group B — Camera Statistics

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-B01 | No cameras | cameras table empty | `GET /api/stats` | `cameras.total === 0`, all byStatus values 0 | P1 |
| TC-STATS-001-B02 | Streaming camera count | Inject 2 cameras with status=`live` | `GET /api/stats` | `cameras.byStatus.streaming === 2` | P1 |
| TC-STATS-001-B03 | Error camera count | Inject 1 camera with status=`error` | `GET /api/stats` | `cameras.byStatus.error === 1` | P1 |
| TC-STATS-001-B04 | YouTube camera count | Inject 2 cameras with type=`youtube` | `GET /api/stats` | `cameras.byType.youtube === 2` | P1 |
| TC-STATS-001-B05 | AI-enabled camera count | Inject 3 cameras with `aiEnabled: true` | `GET /api/stats` | `cameras.aiEnabled === 3` | P2 |

### Group C — Zone Statistics

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-C01 | No zones | zones table empty | `GET /api/stats` | `zones.total === 0` | P1 |
| TC-STATS-001-C02 | MONITOR/EXCLUDE classification | Inject 3 MONITOR, 2 EXCLUDE | `GET /api/stats` | `byType.MONITOR === 3`, `byType.EXCLUDE === 2` | P1 |
| TC-STATS-001-C03 | byCamera aggregation | Inject 3 zones for cameraId A, 2 for B | `GET /api/stats` | `byCamera[0].count >= byCamera[1].count` (descending) | P2 |
| TC-STATS-001-C04 | byCamera top 10 limit | Inject 1 zone for each of 15 cameras | `GET /api/stats` | `zones.byCamera.length <= 10` | P2 |

### Group D — Event Statistics

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-D01 | No events | events table empty | `GET /api/stats` | `events.total === 0`, `today === 0` | P1 |
| TC-STATS-001-D02 | Today's event count | Inject 3 events after today's midnight | `GET /api/stats` | `events.today === 3` | P1 |
| TC-STATS-001-D03 | Loitering event count | Inject 2 events with `isLoitering: true` | `GET /api/stats` | `events.loitering >= 2` | P1 |
| TC-STATS-001-D04 | last7days 7 entries | Inject arbitrary events | `GET /api/stats` | `events.last7days.length === 7` | P1 |
| TC-STATS-001-D05 | last7days date order | Inject arbitrary events | `GET /api/stats` | `last7days[0].date < last7days[6].date` (ascending) | P1 |
| TC-STATS-001-D06 | last7days YYYY-MM-DD format | Inject arbitrary events | `GET /api/stats` | Each item's `date` field matches `YYYY-MM-DD` pattern | P2 |

### Group E — Alert Statistics

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-E01 | No alerts | alerts table empty | `GET /api/stats` | `alerts.total === 0`, `unacknowledged === 0` | P1 |
| TC-STATS-001-E02 | Unacknowledged alert count | Inject 4 alerts with `acknowledged: false` | `GET /api/stats` | `alerts.unacknowledged === 4` | P1 |
| TC-STATS-001-E03 | HIGH severity count | Inject 2 alerts with `severity: 'HIGH'` | `GET /api/stats` | `alerts.bySeverity.HIGH === 2` | P1 |
| TC-STATS-001-E04 | MEDIUM severity count | Inject 3 alerts with `severity: 'MEDIUM'` | `GET /api/stats` | `alerts.bySeverity.MEDIUM === 3` | P1 |
| TC-STATS-001-E05 | Alerts with undefined severity treated as LOW | Inject 2 alerts without severity | `GET /api/stats` | Included in `alerts.bySeverity.LOW` | P2 |

### Group F — Face ID Statistics

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-F01 | No galleries | faceGalleries empty | `GET /api/stats` | `faces.galleries === 0` | P1 |
| TC-STATS-001-F02 | Gallery count | Inject 3 faceGalleries | `GET /api/stats` | `faces.galleries === 3` | P1 |
| TC-STATS-001-F03 | Enrolled face count | Inject 10 faceGalleryFaces | `GET /api/stats` | `faces.enrolled === 10` | P1 |

### Group G — Error Handling

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-G01 | Internal error → 500 | Mock db.all to force throw | `GET /api/stats` | HTTP 500, `success: false`, `error` string | P1 |
| TC-STATS-001-G02 | Response is always JSON | Normal server | `GET /api/stats` | Content-Type: `application/json` | P1 |

### Group H — Integration (Phase-3)

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-H01 | 📊 button click opens panel | Browser, app loaded | Click 📊 icon in header | StatsPanelModal rendered | P1 |
| TC-STATS-001-H02 | X button closes panel | Panel open | Click X button | Panel closed | P1 |
| TC-STATS-001-H03 | Backdrop click closes panel | Panel open | Click outside panel | Panel closed | P1 |
| TC-STATS-001-H04 | Refresh button works | Panel open | Click ↺ button | Both `/api/stats` and `/api/stats/hourly` re-called | P2 |
| TC-STATS-001-H05 | 7-day bar chart rendered | Event data exists | Open panel | 7 bar elements present | P2 |

---

### Group I — Hourly Breakdown API (`GET /api/stats/hourly`) — NEW v1.1

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-I01 | 200 response | Server running | `GET /api/stats/hourly` | HTTP 200, `success: true`, `data` object present | P1 |
| TC-STATS-001-I02 | 24 hour buckets | Server running | `GET /api/stats/hourly` | `data.hours.length === 24` | P1 |
| TC-STATS-001-I03 | hour field range | Server running | `GET /api/stats/hourly` | `hours[0].hour === 0`, `hours[23].hour === 23` | P1 |
| TC-STATS-001-I04 | hour fields present | Server running | `GET /api/stats/hourly` | Each element has `detections`, `alerts`, `matches`, `events` (all numbers) | P1 |
| TC-STATS-001-I05 | summary present | Server running | `GET /api/stats/hourly` | `data.summary` has `detections`, `alerts`, `matches`, `events` | P1 |
| TC-STATS-001-I06 | date field returned | Server running | `GET /api/stats/hourly?date=2026-05-28` | `data.date === '2026-05-28'` | P1 |
| TC-STATS-001-I07 | detections bucketed by hour | Inject snapshot at 14:30 on target date | `GET /api/stats/hourly?date=<target>` | `hours[14].detections >= 1` | P1 |
| TC-STATS-001-I08 | alerts bucketed by hour | Inject alert at 09:00 on target date | `GET /api/stats/hourly?date=<target>` | `hours[9].alerts >= 1` | P1 |
| TC-STATS-001-I09 | matches bucketed by hour | Inject faceMatchHistory at 23:00 on target date | `GET /api/stats/hourly?date=<target>` | `hours[23].matches >= 1` | P1 |
| TC-STATS-001-I10 | events bucketed by hour | Inject loitering event at 00:00 on target date | `GET /api/stats/hourly?date=<target>` | `hours[0].events >= 1` | P1 |
| TC-STATS-001-I11 | summary equals sum of hours | Inject records across multiple hours | `GET /api/stats/hourly?date=<target>` | `summary.detections === sum(hours[*].detections)` for all fields | P1 |
| TC-STATS-001-I12 | previous day date param | Server running | `GET /api/stats/hourly?date=2000-01-01` | HTTP 200, all hours have 0 counts | P2 |
| TC-STATS-001-I13 | default date = today | Server running | `GET /api/stats/hourly` (no param) | `data.date === today's YYYY-MM-DD` | P2 |
| TC-STATS-001-I14 | records outside date excluded | Inject record yesterday | `GET /api/stats/hourly?date=<today>` | Count for that type not inflated by yesterday's record | P2 |

---

### Group J — Items API (`GET /api/stats/items`) — NEW v1.2

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-J01 | 200 response — detections | Server running | `GET /api/stats/items?type=detections&date=2026-05-28&hour=14` | HTTP 200, `success: true`, `data.items` is an array | P1 |
| TC-STATS-001-J02 | 200 response — alerts | Server running | `GET /api/stats/items?type=alerts&date=2026-05-28&hour=9` | HTTP 200, `data.type === 'alerts'`, `data.hour === 9` | P1 |
| TC-STATS-001-J03 | 200 response — matches | Server running | `GET /api/stats/items?type=matches&date=2026-05-28&hour=23` | HTTP 200, `data.type === 'matches'` | P1 |
| TC-STATS-001-J04 | 200 response — events | Server running | `GET /api/stats/items?type=events&date=2026-05-28&hour=0` | HTTP 200, `data.type === 'events'` | P1 |
| TC-STATS-001-J05 | Items filtered by hour | Inject snapshot at 14:30 on target date | `GET /api/stats/items?type=detections&date=<target>&hour=14` | `data.items.length >= 1`, item timestamp is within 14:00–15:00 | P1 |
| TC-STATS-001-J06 | Items in wrong hour excluded | Inject snapshot at 14:30 | `GET /api/stats/items?type=detections&date=<target>&hour=15` | `data.items.length === 0` (or item not included) | P1 |
| TC-STATS-001-J07 | Response date/hour echoed | Server running | `GET /api/stats/items?type=alerts&date=2026-05-28&hour=7` | `data.date === '2026-05-28'`, `data.hour === 7` | P1 |
| TC-STATS-001-J08 | Invalid type → 400 | Server running | `GET /api/stats/items?type=INVALID&date=2026-05-28&hour=1` | HTTP 400, `success: false`, `error` string | P1 |
| TC-STATS-001-J09 | Missing date param → 400 | Server running | `GET /api/stats/items?type=detections&hour=1` | HTTP 400, `success: false` | P1 |
| TC-STATS-001-J10 | Missing hour param → 400 | Server running | `GET /api/stats/items?type=detections&date=2026-05-28` | HTTP 400, `success: false` | P1 |
| TC-STATS-001-J11 | Out-of-range hour → 400 | Server running | `GET /api/stats/items?type=detections&date=2026-05-28&hour=24` | HTTP 400, `success: false` | P1 |
| TC-STATS-001-J12 | Empty result for no-match date | Server running | `GET /api/stats/items?type=detections&date=2000-01-01&hour=0` | HTTP 200, `data.items.length === 0` | P2 |
| TC-STATS-001-J13 | Response is always JSON | Normal server | `GET /api/stats/items?type=detections&date=2026-05-28&hour=0` | Content-Type: `application/json` | P2 |
| TC-STATS-001-J14 | Items include full row fields | Inject snapshot with extra fields | `GET /api/stats/items?type=detections&date=<target>&hour=H` | Returned item contains all fields from the DB row | P2 |

---

### Group K — Full-Screen & Drill-Down UI (Phase-3 E2E) — NEW v1.2

| TC | Test Name | Pre-condition | Test Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| TC-STATS-001-K01 | Stats panel is full-screen | Browser, app loaded | Click 📊 icon, observe panel | Panel occupies entire viewport (no side-panel, no max-w constraint) | P1 |
| TC-STATS-001-K02 | Overview grid shows 7 sections | Panel open, data loaded | Observe overview | 7 section cards visible (Hourly, Detections, Alerts, Face ID, Cameras, Zones, Storage) | P1 |
| TC-STATS-001-K03 | Drillable cards show hint badge | Panel open at overview | Inspect Hourly/Detections/Alerts/Face ID cards | Each shows `double-click to explore` hint | P2 |
| TC-STATS-001-K04 | Non-drillable cards have no hint | Panel open at overview | Inspect Cameras/Zones/Storage cards | No hint badge; no pointer cursor | P2 |
| TC-STATS-001-K05 | Double-click Hourly → section view | Overview level | Double-click Hourly Breakdown card | Navigates to section view; breadcrumb shows `Statistics › Hourly Breakdown` | P1 |
| TC-STATS-001-K06 | Double-click Detections → section view | Overview level | Double-click Detections card | Navigates to section view; breadcrumb shows `Statistics › Detections` | P1 |
| TC-STATS-001-K07 | Double-click Alerts → section view | Overview level | Double-click Alerts card | Section view shows alerts-only hourly chart | P1 |
| TC-STATS-001-K08 | Double-click Face ID → section view | Overview level | Double-click Face ID card | Section view shows face-matches hourly chart | P1 |
| TC-STATS-001-K09 | Click hourly bar → hour list | Section view, data exists | Click a non-empty bar in hourly chart | Navigates to hour list; breadcrumb shows `Statistics › {Section} › HH:00` | P1 |
| TC-STATS-001-K10 | Hour list shows type tabs | Hour list level, multiple types | Open Hourly section, click bar with mixed items | Type tabs visible (Detections / Alerts / Face Match / Events) with count badges | P1 |
| TC-STATS-001-K11 | Switching type tab changes list | Hour list with multiple types | Click different type tab | List updates to show items of selected type | P1 |
| TC-STATS-001-K12 | Click list item → item detail | Hour list, items present | Click first item in list | Navigates to item detail; breadcrumb shows `… › Detail` | P1 |
| TC-STATS-001-K13 | Item detail shows key-value table | Item detail level | Inspect detail view | All item fields displayed as key-value rows | P1 |
| TC-STATS-001-K14 | Timestamp fields formatted | Item detail level | Inspect timestamp fields | Displayed as `YYYY-MM-DD HH:mm:ss` | P2 |
| TC-STATS-001-K15 | Boolean fields formatted | Item detail, boolean field | Inspect boolean field | Displayed as `Yes` (green) or `No` (gray) badge | P2 |
| TC-STATS-001-K16 | Breadcrumb click navigates up | At item detail level | Click `Statistics` in breadcrumb | Returns to overview (Level 0) | P1 |
| TC-STATS-001-K17 | Breadcrumb click to section | At item detail level | Click section name in breadcrumb | Returns to section view (Level 1) | P1 |
| TC-STATS-001-K18 | Empty hour shows no-items message | Hour list, empty hour clicked | Click bar for hour with 0 items | `No items in this hour` message displayed | P2 |
| TC-STATS-001-K19 | Date change refreshes section chart | Section view | Change date picker value | Hourly chart re-fetched and updated for new date | P1 |
| TC-STATS-001-K20 | ESC key navigates up one level | At any drill level > 0 | Press Escape | Navigates one level up (or closes if at Level 0) | P2 |

```javascript
// fixtures/stats_fixture.js (example)
const cameras = [
  { id: 'cam1', name: 'Front Gate', status: 'live', type: 'rtsp', aiEnabled: true },
  { id: 'cam2', name: 'Parking',    status: 'stopped', type: 'rtsp', aiEnabled: false },
  { id: 'cam3', name: 'YouTube',    status: 'streaming', type: 'youtube', aiEnabled: false },
];
const zones = [
  { id: 'z1', cameraId: 'cam1', type: 'MONITOR', name: 'Zone A' },
  { id: 'z2', cameraId: 'cam1', type: 'EXCLUDE', name: 'Zone B' },
  { id: 'z3', cameraId: 'cam2', type: 'MONITOR', name: 'Zone C' },
];
const events = [
  { id: 'e1', cameraId: 'cam1', startTime: new Date().toISOString(), isLoitering: true },
  { id: 'e2', cameraId: 'cam1', startTime: new Date().toISOString(), isLoitering: false },
];
const alerts = [
  { id: 'a1', acknowledged: false, severity: 'HIGH', timestamp: Date.now() },
  { id: 'a2', acknowledged: true,  severity: 'LOW',  timestamp: Date.now() },
];

// Hourly breakdown fixtures (v1.1)
const TARGET_DATE = '2026-05-28';

// detectionSnapshot at 14:30
const snapshotsHourly = [
  { id: 's1', capturedAt: `${TARGET_DATE}T14:30:00.000Z` },
];
// alert at 09:00
const alertsHourly = [
  { id: 'ah1', acknowledged: false, severity: 'HIGH', timestamp: new Date(`${TARGET_DATE}T09:00:00.000Z`).getTime() },
];
// faceMatchHistory at 23:00
const faceMatchHourly = [
  { id: 'fm1', createdAt: `${TARGET_DATE}T23:00:00.000Z` },
];
// loitering event at 00:05
const eventsHourly = [
  { id: 'eh1', startTime: `${TARGET_DATE}T00:05:00.000Z`, isLoitering: true },
];
```

---

## 4. Pass/Fail Criteria

- **Pass**: HTTP status code, response structure, and aggregation values all match expected results
- **Fail**: Expected result mismatch, timeout (> 2000ms), unhandled exception

---

## 5. Test Execution

```bash
# Run all Stats API tests
npx jest test/api/stats_panel.test.js --verbose

# Run full server tests
npm test
```

---

*Document prepared by: LTS Engineering Team*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Stats Panel |
