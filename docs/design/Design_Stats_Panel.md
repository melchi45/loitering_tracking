# Design Document — Stats Dashboard Panel
**Document ID**: DESIGN-STATS-001  
**Version**: 1.2  
**Date**: 2026-05-28  
**Based on**: SRS-STATS-001  
**System**: LTS-2026 Loitering Tracking System

> **v1.1 changes**: Added `GET /api/stats/hourly` endpoint; `StatsPanelModal` date-picker + `HourlyStackedChart`; hourly breakdown by detection type (detections / alerts / face matches / events).  
> **v1.2 changes**: Full-screen layout; drill-down navigation state machine (Overview → Section → HourList → ItemDetail); `GET /api/stats/items` endpoint; `BreadcrumbNav`, `SectionDrillView`, `HourListView`, `ItemDetailView` components.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  client/src/App.tsx                                         │
│  ┌────────────────────┐   showStats state                   │
│  │ Header             │   ┌──────────────────────────────┐  │
│  │  […] [📊] [⚙]     │──►│ StatsPanelModal (full screen) │  │
│  └────────────────────┘   │  open={showStats}            │  │
│                            │  onClose={()=>setStats(false)}│  │
│                            └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
      │ /api/stats      │ /api/stats/hourly?date=   │ /api/stats/items?type=&date=&hour=
      ▼                 ▼                            ▼
┌──────────────────────────────────────────────────────────────┐
│  server/src/api/stats.js                                     │
│  buildRouter(db)                                             │
│   ├─ GET /items  ← NEW in v1.2                              │
│   │   ├─ ?type=detections|alerts|matches|events             │
│   │   ├─ ?date=YYYY-MM-DD, ?hour=0-23                      │
│   │   └─ filter by [hourStart, hourEnd) using extractTs     │
│   ├─ GET /hourly  ← NEW in v1.1                              │
│   │   ├─ db.all('detectionSnapshots') → detections/h        │
│   │   ├─ db.all('alerts')             → alerts/h            │
│   │   ├─ db.all('faceMatchHistory')   → matches/h           │
│   │   └─ db.all('events')             → events/h            │
│   └─ GET /                                                    │
│       ├─ db.all('cameras'), zones, events, alerts, faces     │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Backend Design

### 2.1 File: `server/src/api/stats.js`

```
exports: { buildRouter(db) }
  ├─ extractTs(record) — helper: timestamp|createdAt|startTime|capturedAt → Date
  │
  ├─ Router: GET /items  ← NEW in v1.2
  │   ├─ ?type=detections|alerts|matches|events  (required)
  │   ├─ ?date=YYYY-MM-DD                        (required)
  │   ├─ ?hour=0-23                              (required)
  │   ├─ tableMap = { detections:'detectionSnapshots', alerts:'alerts',
  │   │              matches:'faceMatchHistory', events:'events' }
  │   ├─ hourStart = dayStart + hour*3600000
  │   ├─ hourEnd   = hourStart + 3600000
  │   └─ filter: extractTs(row) in [hourStart, hourEnd)
  │
  ├─ Router: GET /hourly  ← NEW in v1.1
  │   (unchanged from v1.1)
  │
  ├─ Router: GET /
  │   (unchanged from v1.0)
  └─ Error handler → 500
```

**Route registration order** (must match listed order to avoid shadowing):
1. `router.get('/items', ...)`
2. `router.get('/hourly', ...)`
3. `router.get('/', ...)`

#### Items Response Schema (v1.2)

```typescript
// GET /api/stats/items?type=TYPE&date=DATE&hour=H
{
  success: true,
  data: {
    type:  'detections' | 'alerts' | 'matches' | 'events';
    date:  string;                        // YYYY-MM-DD
    hour:  number;                        // 0–23
    items: Array<Record<string, unknown>>; // full row objects from DB table
  }
}
```

```typescript
// GET /api/stats/hourly?date=YYYY-MM-DD
{
  success: true,
  data: {
    date: string;           // YYYY-MM-DD (normalized to local day start)
    hours: Array<{
      hour:       number;   // 0–23
      detections: number;   // detectionSnapshots count in that hour
      alerts:     number;   // alerts count
      matches:    number;   // faceMatchHistory count
      events:     number;   // loitering events count
    }>;                     // always 24 elements
    summary: {
      detections: number;
      alerts:     number;
      matches:    number;
      events:     number;
    };
  }
}
```

### 2.2 Registration in `server/src/index.js`

```js
const { buildRouter: statsRouter } = require('./api/stats');
// …after existing routers:
app.use('/api/stats', statsRouter(db));
```

---

## 3. Frontend Design

### 3.1 Component: `client/src/components/StatsPanelModal.tsx`

**Props Interface** (unchanged):
```typescript
interface StatsPanelModalProps {
  open: boolean;
  onClose: () => void;
}
```

**New Types (v1.2)**:
```typescript
type DrillSection = 'hourly' | 'detections' | 'alerts' | 'faceId';

type DrillState =
  | { level: 'overview' }
  | { level: 'section';    section: DrillSection }
  | { level: 'hourList';   section: DrillSection; hour: number }
  | { level: 'itemDetail'; section: DrillSection; hour: number; item: ItemRecord };

type ItemRecord = Record<string, unknown>;

type ItemsFetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; data: Record<string, ItemRecord[]> }; // type key → items
```

**Section config constants**:
```typescript
const SECTION_TYPES: Record<DrillSection, string[]> = {
  hourly:     ['detections', 'alerts', 'matches', 'events'],
  detections: ['detections'],
  alerts:     ['alerts'],
  faceId:     ['matches'],
};
```

**State additions (v1.2)**:
```typescript
const [drill, setDrill]               = useState<DrillState>({ level: 'overview' });
const [itemsState, setItemsState]     = useState<ItemsFetchState>({ status: 'idle' });
const [activeItemType, setActiveItemType] = useState<string>('');
```

**fetchItems helper**:
```typescript
const fetchItems = useCallback((types: string[], date: string, hour: number) => {
  setItemsState({ status: 'loading' });
  Promise.all(
    types.map(type =>
      fetch(`/api/stats/items?type=${type}&date=${encodeURIComponent(date)}&hour=${hour}`)
        .then(r => r.json())
        .then(res => res.success ? { type, items: res.data.items } : { type, items: [] })
        .catch(() => ({ type, items: [] }))
    )
  ).then(results => {
    const map: Record<string, ItemRecord[]> = {};
    for (const r of results) map[r.type] = r.items;
    setItemsState({ status: 'ok', data: map });
    if (results.length > 0) setActiveItemType(results[0].type);
  }).catch(() => setItemsState({ status: 'error' }));
}, []);
```

**Drill navigation handlers**:
```typescript
handleDrillIn(section) → setDrill({ level:'section', section })
handleHourClick(hour)  → fetchItems(types, date, hour)
                          setDrill({ level:'hourList', section, hour })
handleItemClick(item)  → setDrill({ level:'itemDetail', section, hour, item })
handleNavigate(level)  → navigate to overview | section
```

**Render Tree (v1.2 — full-screen)**:
```
<div fixed inset-0 z-50 flex flex-col bg-gray-900>  (full screen)
  ├─ PanelHeader
  │    ├─ BreadcrumbNav (clickable breadcrumb for each drill level)
  │    └─ [refresh] [close]
  └─ ScrollArea (flex-1 overflow-y-auto)
      ├─ [level=overview]  OverviewGrid
      │    ├─ DrillCard(hourly)     ↵ double-click → section
      │    ├─ DrillCard(detections) ↵ double-click → section
      │    ├─ DrillCard(alerts)     ↵ double-click → section
      │    ├─ DrillCard(faceId)     ↵ double-click → section
      │    ├─ StaticCard(cameras)
      │    ├─ StaticCard(zones)
      │    └─ StaticCard(storage)
      ├─ [level=section]   SectionDrillView
      │    ├─ Date picker
      │    ├─ HourlyStackedChart (filtered by section types, bars are clickable)
      │    └─ Summary chips
      ├─ [level=hourList]  HourListView
      │    ├─ Type tabs (one per type, with count badge)
      │    └─ List of items (click → itemDetail)
      └─ [level=itemDetail] ItemDetailView
           ├─ Item type badge + timestamp
           └─ Key-value table (all fields)
```

### 3.2 Hourly Stacked Bar Chart (SVG) — NEW v1.1

```
chartW = 370px, barW = (chartW - 23 gaps) / 24, chartH = 80px

for each hour (0–23):
  stack segments bottom-up in order: detections → alerts → matches → events
  each segment height = (count / maxStackedTotal) * chartH
  colors: detections=#3b82f6 (blue), alerts=#ef4444 (red),
          matches=#06b6d4 (cyan), events=#f59e0b (amber)
  hour label every 4h (00, 04, 08, 12, 16, 20) — text below bar
  <title> native tooltip: "HH:00 — Det:N Alert:N Match:N Event:N"

Edge case: all counts === 0 → display "No activity on this date."
```

**Empty state**: When all 24 hours have zero activity, render a plain text
message instead of an empty chart to avoid a misleading zero-height SVG.

### 3.3 7-Day Bar Chart (SVG)

(unchanged from v1.0)

### 3.4 Severity Bar (CSS)

(unchanged from v1.0)

### 3.5 BreadcrumbNav (NEW v1.2)

```
BreadcrumbNav({ drill, selectedDate, onNavigate })
  renders: [Statistics] › [Section] › [HH:00] › [Detail]
  each segment is a <button> or <span>
  └─ active (last) segment: text-white, not clickable
  └─ parent segments: text-blue-400, clickable, navigate to that level
```

### 3.6 OverviewGrid (NEW v1.2)

```
grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-6
  drillable cards: cursor-pointer + ring on hover + "double-click to explore" badge
  static cards:    no hover affordance (cameras, zones, storage)
```

### 3.7 SectionDrillView (NEW v1.2)

```
date picker (max=today)
hourlyStackedChart with filtered types:
  - 'hourly'     → all 4 types
  - 'detections' → detections only (#3b82f6)
  - 'alerts'     → alerts only (#ef4444)
  - 'faceId'     → matches only (#06b6d4)
bars: onClick={handleHourClick} + cursor-pointer + hover highlight
```

### 3.8 HourListView (NEW v1.2)

```
type tabs (when multiple types): [Detections(N)] [Alerts(N)] ...
item list:
  each row: type-colored badge | timestamp | cameraName | primary field
  click row → ItemDetailView
empty state: "No items in this hour"
```

### 3.9 ItemDetailView (NEW v1.2)

```
type badge + formatted timestamp header
key-value table:
  - keys: camelCase/snake_case → Title Case label
  - timestamps: toLocaleString()
  - booleans: "Yes" (green) / "No" (gray) badge
  - long strings: word-break
  - snapshotPath / imagePath: render <img> if value is a path string
```

### 3.10 Stats Button in App.tsx

```typescript
// Add state
const [showStats, setShowStats] = useState(false);

// statsBtn JSX (same pattern as settingsBtn)
const statsBtn = (
  <button onClick={() => setShowStats(true)} ... title="Statistics">
    <svg>/* bar-chart icon */</svg>
  </button>
);

// Desktop header: {statsBtn} {settingsBtn}
// Mobile header:  {statsBtn} {settingsBtn}

// Add to overlays:
{showStats && <StatsPanelModal open={showStats} onClose={() => setShowStats(false)} />}
```

---

## 4. UI/UX Design

### 4.1 Color Coding

| Status/Severity | Color | Tailwind class |
|---|---|---|
| streaming/online | green | `bg-green-500`, `text-green-400` |
| stopped/offline | gray | `bg-gray-500`, `text-gray-400` |
| error | red | `bg-red-500`, `text-red-400` |
| connecting | yellow | `bg-yellow-500`, `text-yellow-400` |
| HIGH severity | red | `bg-red-500` |
| MEDIUM severity | yellow | `bg-yellow-400` |
| LOW severity | green | `bg-green-500` |
| MONITOR zone | blue | `bg-blue-500` |
| EXCLUDE zone | orange | `bg-orange-500` |

### 4.2 Full-Screen Overview Layout (v1.2)

```
┌────────────────────────────────────────────────────────────┐
│  📊 Statistics               ← breadcrumb │  [↺]  [×] │
├────────────────────────────────────────────────────────────┤
│ OVERVIEW GRID (2-3 columns responsive)                    │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ │
│ │ 🔍 HOURLY    │ │ 📸 DETECTIONS│ │ ⚠️ ALERTS    │ │
│ │ [chart]      │ │ [7-day chart]│ │ [severity]  │ │
│ │ ↵ dbl-click  │ │ ↵ dbl-click  │ │ ↵ dbl-click  │ │
│ └────────────────┘ └────────────────┘ └────────────────┘ │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ │
│ │ 📷 FACE ID   │ │ 📹 CAMERAS  │ │ 🗘 ZONES    │ │
│ │ galleries/  │ │ [status dots]│ │ [by type]   │ │
│ │ ↵ dbl-click  │ │ (static)    │ │ (static)    │ │
│ └────────────────┘ └────────────────┘ └────────────────┘ │
│ ┌───────────────────────────────────────────────────┐ │
│ │ 🗄 STORAGE                              (static) │ │
│ └───────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 4.3 Section Drill Layout (Level 1)

```
┌────────────────────────────────────────────────────────────┐
│  📊 Statistics › Detections     ← breadcrumb     [↺] [×]│
├────────────────────────────────────────────────────────────┤
│ Date [2026-05-28 ▼]  Summary: [Det:87]                  │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Hourly bars (filtered to section type)            │ │
│  │ [click a bar to see items for that hour]          │ │
│  │     ↑ hovered bar shows “14:00 — 5 items” tooltip  │ │
│  └─────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 4.4 Hour List Layout (Level 2)

```
┌────────────────────────────────────────────────────────────┐
│ 📊 Statistics › Hourly › 14:00  ← breadcrumb      [↺] [×]│
├────────────────────────────────────────────────────────────┤
│ [Detections(5)] [Alerts(2)] [Face Match(1)] [Events(3)]   │
├────────────────────────────────────────────────────────────┤
│ [Det] 14:05  cam1  person  conf:92%    →           │
│ [Det] 14:18  cam2  vehicle conf:87%    →           │
│ [Det] 14:32  cam1  person  conf:95%    →           │
│ ...                                               │
└────────────────────────────────────────────────────────────┘
```

### 4.5 Item Detail Layout (Level 3)

```
┌────────────────────────────────────────────────────────────┐
│ 📊 Statistics › Hourly › 14:00 › Detail       [↺] [×]│
├────────────────────────────────────────────────────────────┤
│ [Detection] 2026-05-28 14:05:32                           │
│                                                           │
│  ID          abc-123                                      │
│  Camera      Front Gate                                   │
│  Class       person                                       │
│  Confidence  92%                                          │
│  AI Enabled  [Yes]                                        │
│  Captured At 2026-05-28 14:05:32                          │
│  [snapshot image if snapshotPath available]               │
└────────────────────────────────────────────────────────────┘
```

---

## 5. File Changes Summary

| File | Change Type | Description |
|---|---|---|
| `server/src/api/stats.js` | Modified (v1.2) | Added `GET /items` endpoint |
| `client/src/components/StatsPanelModal.tsx` | Modified (v1.2) | Full-screen layout; DrillState; BreadcrumbNav; OverviewGrid; SectionDrillView; HourListView; ItemDetailView |

---

## 6. Test Strategy

| Layer | File | Test Method |
|---|---|---|
| API | `test/api/stats_panel.test.js` | Jest + supertest, DB fixture-based |
| Component | (Phase-3) | Jest + React Testing Library |
| E2E | (Phase-3) | Playwright |

---

## 7. MCP Server Integration Design

> **Reference**: SRS-STATS-001 §6 (FR-STATS-020 ~ FR-STATS-023), SRS-LTS-MCP-01 §8 FR-MCP-042, §9 FR-MCP-054

### 7.1 Integration Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                          Data Consumers                                  │
│                                                                       │
│  ┌─────────────────────────┐      ┌──────────────────────────────┐   │
│  │  Web Browser (Human)    │      │  LLM Client (AI Agent)       │   │
│  │  StatsPanelModal.tsx    │      │  Claude / OpenAI Agents      │   │
│  └────────────┬────────────┘      └──────────────┬───────────────┘   │
│               │ fetch('/api/stats')               │ MCP Protocol      │
│               │                                  │ (JSON-RPC 2.0)    │
└───────────────┼──────────────────────────────────┼───────────────────┘
                │                                  │
                │                    ┌─────────────▼─────────────┐
                │                    │  mcp-server/ (port 3002)  │
                │                    │  ┌─────────────────────┐  │
                │                    │  │ tools/stats.js      │  │
                │                    │  │ get_stats_dashboard │  │
                │                    │  └──────────┬──────────┘  │
                │                    │  ┌──────────▼──────────┐  │
                │                    │  │ resources.js        │  │
                │                    │  │ lts://stats/dashboard│ │
                │                    │  └──────────┬──────────┘  │
                │                    └─────────────┼─────────────┘
                │                                  │ GET /api/stats
                ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  server/src/api/stats.js — GET /api/stats                            │
│   ├─ db.all('cameras') / db.all('zones') / db.all('events')         │
│   ├─ db.all('alerts') / db.all('faceGalleries') / db.all('faces')   │
│   └─ → { success: true, data: StatsData }                           │
└──────────────────────────────────────────────────────────────────────┘
```

**Key Principle**: Both the Web UI and MCP use the same single `GET /api/stats` endpoint. The MCP layer is responsible only for response format conversion (JSON → Markdown or JSON pass-through).

---

### 7.2 MCP Tool Design: `get_stats_dashboard`

**File**: `mcp-server/tools/stats.js`  
**Registration Function**: `registerStatsTools(server, client)`

#### Call Flow

```
LLM: tools/call get_stats_dashboard {}
          │
          ▼
registerStatsTools() handler
    └─ client.get('/api/stats')          // AbortSignal.timeout(8000)
          │
          ├─ Success: data = response.data
          │    └─ buildMarkdownReport(data)
          │         → "## LTS-2026 Stats Dashboard\n..."
          │         → { content: [{ type: 'text', text: report }] }
          │
          └─ Failure: err.message
               → { content: [{ type: 'text', text: 'Error: ...' }], isError: true }
```

#### Markdown Output Structure

```
## LTS-2026 Stats Dashboard
**Generated:** <generatedAt ISO>
**Storage Mode:** json|mongodb

### Cameras
- Total: N | Streaming: N | Stopped: N | Error: N | Connecting: N
- RTSP: N | YouTube: N | AI Enabled: N

### Detection Events
- Total: N | Today: N | Loitering: N
- 7-day trend: YYYY-MM-DD: N, YYYY-MM-DD: N, ...

### Alerts
- Total: N | Unacknowledged: N | Today: N
- By severity — High: N | Medium: N | Low: N

### Zones
- Total: N | Monitor: N | Exclude: N

### Face ID
- Galleries: N | Enrolled Faces: N
```

#### Relationship with Web UI

| Item | Web UI (`StatsPanelModal`) | MCP Tool (`get_stats_dashboard`) |
|---|---|---|
| Data source | `GET /api/stats` | `GET /api/stats` (same) |
| Output format | React JSX + Tailwind CSS | Markdown text |
| Consumer | Human (browser) | LLM AI agent |
| Trigger | User clicks 📊 button | LLM tool call |
| Error handling | Render error message on screen | Return `isError: true` |

---

### 7.3 MCP Resource Design: `lts://stats/dashboard`

**File**: `mcp-server/resources.js`

#### Registration Code

```javascript
server.resource(
  'stats-dashboard',
  'lts://stats/dashboard',
  { mimeType: 'application/json', description: 'Full aggregated stats dashboard ...' },
  async () => {
    const { data } = await client.get('/api/stats');
    return {
      contents: [{
        uri: 'lts://stats/dashboard',
        text: JSON.stringify(data, null, 2),
        mimeType: 'application/json',
      }],
    };
  }
);
```

#### Differences from `lts://system/summary` Resource

| Item | `lts://system/summary` | `lts://stats/dashboard` |
|---|---|---|
| Data | Camera/zone/alert summary (list-based) | Aggregated statistics (number-based) |
| Output format | JSON (list summary) | JSON (StatsData schema) |
| Primary use | Status overview | Quantitative analysis/reporting |
| API calls | Multiple endpoints | Single `GET /api/stats` |

---

### 7.4 Implementation File Mapping

| SDLC Layer | File | Role |
|---|---|---|
| **API** | `server/src/api/stats.js` | Aggregation logic, JSON response generation |
| **MCP Tool** | `mcp-server/tools/stats.js` | Markdown format conversion, tool registration |
| **MCP Resource** | `mcp-server/resources.js` | JSON pass-through, resource registration |
| **MCP Entry** | `mcp-server/create-server.js` | Call `registerStatsTools()`, catalog registration |
| **Web UI** | `client/src/components/StatsPanelModal.tsx` | Visual rendering |

---

*Document prepared by: LTS Engineering Team*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Stats Panel |
