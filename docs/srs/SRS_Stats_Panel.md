# Software Requirements Specification — Stats Dashboard Panel
**Document ID**: SRS-STATS-001  
**Version**: 1.2  
**Date**: 2026-05-28  
**Based on**: PRD-STATS-001  
**System**: LTS-2026 Loitering Tracking System

> **v1.1 changes**: Added FR-STATS-024 ~ FR-STATS-030 covering `GET /api/stats/hourly`, `HourlyData` type, `HourlyStackedChart` component, date picker, and NFR-STATS-008.  
> **v1.2 changes**: Added FR-STATS-031 ~ FR-STATS-042 covering full-screen layout, drill-down navigation state machine, `GET /api/stats/items` endpoint, section double-click, hourly bar click, item list, item detail, and NFR-STATS-009~010.

---

## 1. Introduction

### 1.1 Purpose
This document defines the complete software requirements for the server API (`GET /api/stats`) and client component (`StatsPanelModal`) of the Stats Dashboard Panel feature.

### 1.2 Definitions

| Term | Definition |
|---|---|
| Stats API | `GET /api/stats` — REST endpoint that returns system-wide statistics in a single JSON response |
| StatsPanelModal | React statistics panel component displayed as a dashboard overlay |
| db.all(table) | db.js public API — returns the full row array for a table |
| DB_TYPE | Environment variable — `json` or `mongodb` |

---

## 2. Functional Requirements

### 2.1 Backend — `GET /api/stats`

#### FR-STATS-001: Router Registration
- Register `app.use('/api/stats', statsRouter(db))` in `server/src/index.js`
- Export `buildRouter(db)` from the `server/src/api/stats.js` module

#### FR-STATS-002: Response Structure
```json
{
  "success": true,
  "data": {
    "generatedAt": "<ISO 8601>",
    "storage": { "mode": "json|mongodb" },
    "cameras": { ... },
    "zones": { ... },
    "events": { ... },
    "alerts": { ... },
    "faces": { ... }
  }
}
```

#### FR-STATS-003: cameras Aggregation
| Field | Description |
|---|---|
| `total` | `db.all('cameras').length` |
| `byStatus.streaming` | Number of cameras with status `live` or `streaming` |
| `byStatus.stopped` | Number of cameras with status `stopped` or `idle` |
| `byStatus.error` | Number of cameras with status `error` |
| `byStatus.connecting` | Number of cameras with status `connecting` |
| `byType.rtsp` | Number of cameras whose type is not `youtube` |
| `byType.youtube` | Number of cameras with type `youtube` |
| `aiEnabled` | Number of cameras where `aiEnabled === true` |

#### FR-STATS-004: zones Aggregation
| Field | Description |
|---|---|
| `total` | `db.all('zones').length` |
| `byType.MONITOR` | Number of zones with type `MONITOR` (or default) |
| `byType.EXCLUDE` | Number of zones with type `EXCLUDE` |
| `byCamera` | Array of zone counts per camera (top 10), `[{cameraId, cameraName, count}]` |

#### FR-STATS-005: events Aggregation
| Field | Description |
|---|---|
| `total` | `db.all('events').length` |
| `today` | Number of events where `startTime`, `timestamp`, or `createdAt` is after today's midnight |
| `loitering` | Number of events where type contains `loiter` or `isLoitering === true` |
| `last7days` | `[{date: "YYYY-MM-DD", count: number}]` — 7 days including today |

#### FR-STATS-006: alerts Aggregation
| Field | Description |
|---|---|
| `total` | `db.all('alerts').length` |
| `unacknowledged` | Number of alerts where `acknowledged !== true` |
| `today` | Number of alerts created after today's midnight |
| `bySeverity.HIGH` | Number of alerts with severity `HIGH` |
| `bySeverity.MEDIUM` | Number of alerts with severity `MEDIUM` |
| `bySeverity.LOW` | Number of alerts with severity `LOW` or undefined |

#### FR-STATS-007: faces Aggregation
| Field | Description |
|---|---|
| `galleries` | `db.all('faceGalleries').length` |
| `enrolled` | `db.all('faceGalleryFaces').length` |

#### FR-STATS-008: Error Handling
- If an exception occurs during aggregation, return `{ success: false, error: "<message>" }` + HTTP 500
- Individual table errors must not block the overall response (aggregate each table within try-catch)

#### FR-STATS-009: Storage Mode
- Returns the value of `process.env.DB_TYPE` as `storage.mode` (default `json`)

---

### 2.2 Frontend — `StatsPanelModal.tsx`

#### FR-STATS-010: Component Props
```typescript
interface StatsPanelModalProps {
  open: boolean;
  onClose: () => void;
}
```

#### FR-STATS-011: Data Fetching
- Call `fetch('/api/stats')` whenever `open` changes to `true`
- Manage three loading states: `loading`, `error`, `data`
- Re-fetch on refresh button click

#### FR-STATS-012: Camera Section Rendering
- Total count, color-coded badges: streaming (green) / stopped (gray) / error (red) / connecting (yellow)
- Display RTSP/YouTube type counts
- Display number of AI-enabled cameras

#### FR-STATS-013: Event Section Rendering
- Tiles for total events, today's events, and loitering event count
- Last 7 days daily bar chart (SVG, relative-height based)
- Date (MM/DD) label above each bar, tooltip showing exact count on hover

#### FR-STATS-014: Alert Section Rendering
- Total alerts, unacknowledged count (highlighted red if > 0)
- HIGH/MEDIUM/LOW color-coded proportional bar

#### FR-STATS-015: Zone Section Rendering
- Total zone count, MONITOR/EXCLUDE counts

#### FR-STATS-016: Face ID Section Rendering
- Number of galleries, number of enrolled faces

#### FR-STATS-017: Storage Info Rendering
- Mode (`json` or `mongodb`) badge
- Display `generatedAt` timestamp

#### FR-STATS-018: Panel Open/Close
- Render overlay when `open={true}`
- Call `onClose()` when backdrop or X button is clicked

#### FR-STATS-019: Header Button (App.tsx modification)
- Add `const [showStats, setShowStats] = useState(false)` state
- Add chart icon button to the header (to the left of settingsBtn)
- Add `<StatsPanelModal open={showStats} onClose={() => setShowStats(false)} />` to `overlays`
- Apply to both desktop and mobile headers

---

### 2.3 Backend — `GET /api/stats/hourly` ← NEW v1.1

#### FR-STATS-024: Endpoint Registration
- Register `router.get('/hourly', ...)` within the same `buildRouter(db)`
- Register **before** the `GET /` router to prevent Express route conflicts

#### FR-STATS-025: Query Parameters
| Parameter | Type | Default | Description |
|---|---|---|---|
| `date` | string (YYYY-MM-DD) | Today | Aggregation target date (24 hours starting from local midnight) |

#### FR-STATS-026: Hourly Aggregation
- Parse the `date` parameter and compute `dayStart = new Date(year, month, day)`
- `dayEnd = dayStart + 86 400 000 ms`
- For each of the 4 tables, extract timestamps using the `extractTs(row)` helper; if within the `[dayStart, dayEnd)` range, increment the count in the corresponding `getHours()` bucket by 1
- Supported tables: `detectionSnapshots` → `detections`, `alerts` → `alerts`, `faceMatchHistory` → `matches`, `events` → `events`

#### FR-STATS-027: Response Structure
```json
{
  "success": true,
  "data": {
    "date": "YYYY-MM-DD",
    "hours": [
      { "hour": 0, "detections": 0, "alerts": 0, "matches": 0, "events": 0 },
      ...
      { "hour": 23, "detections": 0, "alerts": 0, "matches": 0, "events": 0 }
    ],
    "summary": {
      "detections": 0, "alerts": 0, "matches": 0, "events": 0
    }
  }
}
```
- The `hours` array length is always 24 (index = hour, 0–23)

#### FR-STATS-028: Timestamp Extraction Helper
- `extractTs(record)` — checks fields in the order: `timestamp || createdAt || startTime || capturedAt`
- Supports both Unix ms (number) and ISO string
- Returns `null` on parse failure → excluded from aggregation

### 2.4 Frontend (v1.1 Addition) — Hourly Breakdown

#### FR-STATS-029: Date Picker
- `selectedDate` state within `StatsPanelModal` (`string`, initial value = today `YYYY-MM-DD`)
- `<input type="date">` element — `max` attribute = today's date (prevents future date selection)
- Call `fetchHourly(date)` immediately on date change

#### FR-STATS-030: HourlyStackedChart
- SVG-based 24-bar stacked bar chart (no external libraries, compliant with NFR-STATS-004)
- Each bar = total height per hour, color-coded: Detections=blue, Alerts=red, Face Match=cyan, Events=amber
- X-axis labels: `00`, `04`, `08`, `12`, `16`, `20` (4-hour intervals)
- `<title>` attribute: `"HH:00 — Det:N Alert:N Match:N Event:N"` native tooltip
- Empty date (total = 0) → replaced with "No activity on this date." text
- On Refresh button click, call `fetchStats()` and `fetchHourly(selectedDate)` simultaneously

---

### 2.5 Frontend (v1.2) — Full-Screen Layout

#### FR-STATS-031: Full-Screen Container
- `StatsPanelModal` shall occupy the entire viewport (`fixed inset-0 z-50`)
- Replace the previous right-side slide panel (`max-w-[420px]`) with a full-screen layout
- Layout: flex column (Header + scrollable Body)
- Overview body shall use a responsive grid: `grid-cols-1 md:grid-cols-2 xl:grid-cols-3`

#### FR-STATS-032: No Backdrop Required
- Full-screen mode has no semi-transparent backdrop behind the panel
- The [×] button and keyboard Escape key close the panel

---

### 2.6 Frontend (v1.2) — Drill-Down Navigation

#### FR-STATS-033: Drill State Machine

```
Level 0 (overview)
  └─ double-click section card → Level 1 (section)
       └─ click hourly bar → Level 2 (hourList)
            └─ click list item → Level 3 (itemDetail)
```

```typescript
type DrillSection = 'hourly' | 'detections' | 'alerts' | 'faceId';
type DrillState =
  | { level: 'overview' }
  | { level: 'section';    section: DrillSection }
  | { level: 'hourList';   section: DrillSection; hour: number }
  | { level: 'itemDetail'; section: DrillSection; hour: number; item: ItemRecord };
```

#### FR-STATS-034: Breadcrumb Navigation
- Header shall display a breadcrumb reflecting the current drill level:
  - Level 0: `Statistics`
  - Level 1: `Statistics › {section label}`
  - Level 2: `Statistics › {section label} › {HH}:00`
  - Level 3: `Statistics › {section label} › {HH}:00 › Detail`
- Each breadcrumb segment is a clickable link to navigate to that level
- Pressing [ESC] navigates one level up; if at Level 0, closes the panel

#### FR-STATS-035: Section Double-Click (Level 0 → Level 1)
- Sections that support drill-in: **Hourly Breakdown**, **Detections**, **Alerts**, **Face ID**
- Double-clicking a drillable section card navigates to Level 1 for that section
- Non-drillable sections (Cameras, Zones, Storage) do not respond to double-click
- Each drillable card shows a `↵ double-click to explore` hint badge

#### FR-STATS-036: Section View (Level 1)
- Display: date picker + hourly stacked chart filtered to the section's data types
  - `hourly` → all 4 types (detections, alerts, matches, events)
  - `detections` → detections only
  - `alerts` → alerts only  
  - `faceId` → face matches only
- Each bar in the chart is clickable (single-click) to navigate to Level 2
- Hovering a bar highlights it and shows a tooltip: `HH:00 — N items`

#### FR-STATS-037: Hour Item List (Level 2)
- Call `GET /api/stats/items?type=TYPE&date=DATE&hour=H` for each type in the section
- Display items in a tab bar (one tab per type with count badge) when section has multiple types
- Each list row shows: item type badge, timestamp, camera name, and primary field (class/severity/person/event type)
- Click a list row → Level 3 (item detail)
- Show "No items" message if the list is empty

#### FR-STATS-038: Item Detail View (Level 3)
- Display all fields of the selected item as a key-value table
- Keys are formatted as human-readable labels (camelCase → Title Case, snake_case → Title Case)
- Timestamp fields are formatted as `YYYY-MM-DD HH:mm:ss`
- Boolean fields display as `Yes` / `No` badges
- If the item has a `snapshotPath` or `imagePath` field, display the image (if the path is accessible)

#### FR-STATS-039: Drill-Down Sections Config

| Section | Label | Types fetched on drill |
|---|---|---|
| `hourly` | Hourly Breakdown | detections, alerts, matches, events |
| `detections` | Detections | detections |
| `alerts` | Alerts | alerts |
| `faceId` | Face ID | matches |

---

### 2.7 Backend (v1.2) — `GET /api/stats/items`

#### FR-STATS-040: Endpoint Registration
- Register `router.get('/items', ...)` in `buildRouter(db)`
- Must be registered **before** `router.get('/', ...)` to avoid path shadowing

#### FR-STATS-041: Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | `detections` \| `alerts` \| `matches` \| `events` |
| `date` | string (YYYY-MM-DD) | Yes | Target date |
| `hour` | number (0–23) | Yes | Target hour (local time) |

Invalid `type`, missing `date`, or out-of-range `hour` → HTTP 400 + `{ success: false, error: "..." }`

#### FR-STATS-042: Response Structure

```typescript
// GET /api/stats/items?type=TYPE&date=DATE&hour=H
{
  success: true,
  data: {
    type:  string;      // echoed back
    date:  string;      // YYYY-MM-DD
    hour:  number;      // 0-23
    items: Array<Record<string, unknown>>;  // full rows from DB table
  }
}
```

Table mapping:
- `detections` → `detectionSnapshots`
- `alerts`     → `alerts`
- `matches`    → `faceMatchHistory`
- `events`     → `events`

Filter: include rows where `extractTs(row)` falls in `[hourStart, hourEnd)` (local time)

---

| ID | Category | Requirement |
|---|---|---|
| NFR-STATS-001 | Performance | API response time ≤ 300ms (JSON DB, local) |
| NFR-STATS-002 | Performance | Component mount time ≤ 100ms |
| NFR-STATS-003 | Reliability | No full app crash on API error |
| NFR-STATS-004 | Maintainability | No additional external chart library dependencies allowed |
| NFR-STATS-005 | Compatibility | Chrome 120+, Firefox 120+, Edge 120+ |
| NFR-STATS-006 | Accessibility | Color contrast meets WCAG AA standard |
| NFR-STATS-007 | Security | Stats API is read-only; DB modification is not allowed |
| NFR-STATS-008 | Performance | `GET /api/stats/hourly` response time ≤ 300ms (JSON DB, local) |
| NFR-STATS-009 | Performance | `GET /api/stats/items` response time ≤ 500ms (JSON DB, local) |
| NFR-STATS-010 | UX | Drill-down navigation depth (Level 0 → 3) shall not require page reload |

---

## 4. Interface Specifications

### 4.1 API Response Schema

```typescript
interface StatsResponse {
  success: boolean;
  data: {
    generatedAt: string;           // ISO 8601
    storage: { mode: 'json' | 'mongodb' };
    cameras: {
      total: number;
      byStatus: { streaming: number; stopped: number; error: number; connecting: number };
      byType:   { rtsp: number; youtube: number };
      aiEnabled: number;
    };
    zones: {
      total: number;
      byType:  { MONITOR: number; EXCLUDE: number };
      byCamera: Array<{ cameraId: string; cameraName: string; count: number }>;
    };
    events: {
      total: number;
      today: number;
      loitering: number;
      last7days: Array<{ date: string; count: number }>;
    };
    alerts: {
      total: number;
      unacknowledged: number;
      today: number;
      bySeverity: { HIGH: number; MEDIUM: number; LOW: number };
    };
    faces: { galleries: number; enrolled: number };
  };
}
```

---

## 5. Data Flow

```
Client                      Server                     DB (JSON/MongoDB)
  │                            │                            │
  │  open=true                 │                            │
  │─────────────────────────── │                            │
  │  GET /api/stats            │                            │
  │───────────────────────────►│                            │
  │                            │  db.all('cameras')         │
  │                            │───────────────────────────►│
  │                            │  db.all('zones')           │
  │                            │───────────────────────────►│
  │                            │  db.all('events')          │
  │                            │───────────────────────────►│
  │                            │  db.all('alerts')          │
  │                            │───────────────────────────►│
  │                            │  db.all('faceGalleries')   │
  │                            │───────────────────────────►│
  │                            │  db.all('faceGalleryFaces')│
  │                            │───────────────────────────►│
  │                            │◄───────────────────────────│
  │◄───────────────────────────│  { success, data }         │
  │  render StatsPanelModal    │                            │
```

---

*Document prepared by: LTS Engineering Team*

---

## 6. MCP Integration Requirements

> **Background**: The LTS-2026 MCP Server (see SRS-LTS-MCP-01 §8. FR-MCP-042/054) exposes the same `GET /api/stats` endpoint as Stats Dashboard Panel via MCP tools and resources. This section defines the MCP integration requirements from the Stats API perspective.

### 6.1 Integration Overview

```
LLM Client (Claude / OpenAI Agents)
          │  MCP Protocol (JSON-RPC 2.0)
          ▼
LTS MCP Server (mcp-server/)
    ├─ Tool: get_stats_dashboard    → GET /api/stats  → StatsData (Markdown format)
    └─ Resource: lts://stats/dashboard → GET /api/stats → StatsData (JSON)
          │
          ▼
Stats REST API (server/src/api/stats.js)
    └─ GET /api/stats → { success, data: StatsData }
```

### 6.2 MCP Tool Requirements

#### FR-STATS-020: `get_stats_dashboard` Tool Response Format
- The `get_stats_dashboard` tool in `mcp-server/tools/stats.js` MUST consume the `data` field from `GET /api/stats` and convert it into a human-readable Markdown report.
- The report MUST include the following sections: Cameras, Detection Events, Alerts, Zones, Face ID.
- If the `data.events.last7days` array exists, the report MUST include a `7-day trend:` line.
- If the `data.alerts.bySeverity` object exists, the report MUST include Critical/High/Medium/Low lines.

#### FR-STATS-021: MCP Tool Error Propagation
- If the `GET /api/stats` call fails or `data` is null/undefined, the tool MUST return `{ isError: true, content: [{ text: "Error: ..." }] }`.
- MCP tool errors MUST follow the same format as LTS API errors (`"Error: LTS API {status}: ..."`).

### 6.3 MCP Resource Requirements

#### FR-STATS-022: `lts://stats/dashboard` Resource
- The resource MUST be registered under the URI `lts://stats/dashboard` in `mcp-server/resources.js`.
- MIME Type: `application/json`
- On resource read, call `GET /api/stats` and return the entire `data` field serialized as `JSON.stringify(data, null, 2)`.
- No caching: a new API call MUST be made on every resource read.

#### FR-STATS-023: Compatibility Guarantee
- The response structure of `GET /api/stats` (the `StatsResponse.data` schema, see §4.1) MUST maintain backward compatibility.
- Renaming or removing existing fields affects the MCP tool response format; the MCP tool code (`mcp-server/tools/stats.js`) MUST be updated simultaneously before any such change.

### 6.4 Traceability

| SRS Requirement | MCP Document Reference | Implementation File |
|---|---|---|
| FR-STATS-020 | SRS-LTS-MCP-01 §8 FR-MCP-042 | `mcp-server/tools/stats.js` |
| FR-STATS-021 | SRS-LTS-MCP-01 §3 FR-MCP-004 | `mcp-server/tools/stats.js` |
| FR-STATS-022 | SRS-LTS-MCP-01 §9 FR-MCP-054 | `mcp-server/resources.js` |
| FR-STATS-023 | SRS-LTS-MCP-01 §13 C-04 | `server/src/api/stats.js` |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Stats Panel |
