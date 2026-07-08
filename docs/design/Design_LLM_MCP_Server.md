# DESIGN DOCUMENT
# LLM MCP Server

| | |
|---|---|
| **Document ID** | DESIGN-LTS-MCP-01 |
| **Version** | 1.3 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent SRS** | srs/SRS_LLM_MCP_Server.md |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Module Design — Entry Point](#3-module-design--entry-point)
4. [Module Design — LTS Client](#4-module-design--lts-client)
5. [Module Design — Server Factory](#5-module-design--server-factory)
6. [Module Design — Tools](#6-module-design--tools)
7. [Module Design — Resources](#7-module-design--resources)
8. [Data Models](#8-data-models)
9. [Sequence Diagrams](#9-sequence-diagrams)
10. [Error Handling Design](#10-error-handling-design)
11. [Configuration & Environment](#11-configuration--environment)
12. [Integration Design](#12-integration-design)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                   MCP Client Layer                               │
│   Claude Code (stdio)  │  OpenAI Agents (SSE)  │  ChatGPT       │
└────────────────────────┬────────────────────────────────────────┘
                         │  MCP Protocol (JSON-RPC 2.0)
              ┌──────────┴──────────┐
              │  stdio transport    │  HTTP/SSE transport
              │  StdioServerTransport│  SSEServerTransport
              └──────────┬──────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                  LTS MCP Server  (Node.js ESM process)           │
│                                                                  │
│  index.js              — transport setup; env var config         │
│  create-server.js      — McpServer factory (tools + resources)   │
│  lts-client.js         — LTSClient HTTP wrapper (fetch)          │
│                                                                  │
│  tools/loitering.js    — query_loitering_events                  │
│                          get_tracking_history                    │
│  tools/alerts.js       — get_active_alerts                       │
│                          explain_alert                           │
│                          acknowledge_alert                       │
│  tools/cameras.js      — get_camera_status                       │
│                          get_zone_config                         │
│                          update_zone_threshold                   │
│  tools/analytics.js    — get_analytics_summary                   │
│                          generate_security_report                │
│  tools/stats.js        — get_stats_dashboard                     │
│  resources.js          — lts://cameras                          │
│                          lts://alerts/active                     │
│                          lts://zones/{cameraId}                  │
│                          lts://system/summary                    │
│                          lts://stats/dashboard                   │
└────────────────────────┬────────────────────────────────────────┘
                         │  HTTP fetch (AbortSignal.timeout 8s)
┌────────────────────────▼────────────────────────────────────────┐
│             LTS-2026 Express API  (port 3080)                    │
│   /api/cameras  /api/events  /api/alerts  /api/cameras/:id/zones│
└─────────────────────────────────────────────────────────────────┘
```

### 1.1 Design Principles

| Principle | Implementation |
|---|---|
| Stateless | No local cache; every tool call fetches fresh data from LTS API |
| Fail-soft | `Promise.allSettled` used for multi-call tools; sub-failures degrade gracefully |
| Protocol-clean | All logs to `stderr`; stdout reserved exclusively for MCP JSON-RPC |
| Per-session isolation | Each SSE session creates its own `McpServer` instance via `createServer()` |
| Schema-first validation | Zod schemas defined inline in each tool registration |

---

## 2. File Structure

> v1.3 기준 — 35 tools / 7 resources. §6/§7의 세부 모듈 설계는 v1.0 5개 도구 모듈만 다루고
> 이후 확장분(v1.1~v1.3)은 §6.10 이후에 이어 붙는 형태로 유지된다.

```
mcp-server/
├── package.json          # "type": "module" (ESM); deps: @modelcontextprotocol/sdk, zod, express, cors
├── index.js              # Entry point: transport selection, Express app (http mode)
├── create-server.js      # McpServer factory; exports TOOL_CATALOG, RESOURCE_CATALOG
├── lts-client.js         # LTSClient class: get(), post(), put(), patch(), delete() with fetch + AbortSignal
├── resources.js          # lts://cameras, lts://alerts/active, lts://zones/{cameraId},
│                         # lts://system/summary, lts://stats/dashboard
├── test/
│   ├── tools.test.js     # Tool handler unit tests (MockMcpServer + mockClient)
│   └── lts-client.test.js
└── tools/
    ├── loitering.js      # query_loitering_events, get_tracking_history, query_face_trajectories
    ├── alerts.js         # get_active_alerts, explain_alert, acknowledge_alert
    ├── cameras.js        # get_camera_status, get_zone_config, update_zone_threshold,
    │                     # add_camera, update_camera, delete_camera, toggle_camera_ai
    ├── analytics.js      # get_analytics_summary, generate_security_report
    ├── stats.js          # get_stats_dashboard
    ├── snapshots.js      # get_object_snapshots, search_person
    ├── system.js         # get_server_status
    ├── onvif.js          # query_onvif_events, get_onvif_event_types, get_onvif_snapshot (v1.3)
    ├── detections.js     # query_analysis_events, get_detection_tracks, get_analysis_metrics
    ├── missing-person.js # register_missing_person, search_missing_person,
    │                     # get_missing_person_detections, update_missing_person_status,
    │                     # get_missing_person_statistics + missing-persons:// resources
    ├── config.js         # get_model_catalog, get_fire_smoke_config, get_tracker_config (v1.3)
    ├── search.js         # search_all (v1.3)
    └── faces.js          # list_face_galleries (v1.3)
```

---

## 3. Module Design — Entry Point (`index.js`)

### 3.1 Transport Branching

```javascript
const TRANSPORT = process.env.TRANSPORT || 'stdio';

if (TRANSPORT === 'http') {
  // Express app with SSE sessions
  const sessions = new Map();   // sessionId → SSEServerTransport
  app.get('/sse', requireAuth, async (req, res) => {
    const server    = createServer(BASE_URL);    // new McpServer per connection
    const transport = new SSEServerTransport('/message', res);
    sessions.set(transport.sessionId, transport);
    transport.onclose = () => sessions.delete(transport.sessionId);
    await server.connect(transport);
  });
  app.post('/message', requireAuth, async (req, res) => {
    const transport = sessions.get(req.query.sessionId);
    if (!transport) return res.status(404).json({ error: 'Session not found' });
    await transport.handlePostMessage(req, res);
  });
} else {
  // stdio — one server for the process lifetime
  const server    = createServer(BASE_URL);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

### 3.2 HTTP Mode Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/sse` | GET | Open SSE stream (new McpServer per session) |
| `/message` | POST | Route JSON-RPC to session by `?sessionId=` |
| `/schema` | GET | Static tool/resource catalog JSON |
| `/health` | GET | Liveness probe |

### 3.3 Bearer Authentication Middleware

```javascript
function requireAuth(req, res, next) {
  if (!MCP_AUTH_TOKEN) return next();           // no token configured → allow all
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${MCP_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

---

## 4. Module Design — LTS Client (`lts-client.js`)

### 4.1 Class Interface

```javascript
class LTSClient {
  constructor(baseUrl)                           // strips trailing slash
  async get(path, params = {})                   // appends query string; throws on non-2xx
  async post(path, body = {})                    // JSON body; throws on non-2xx
  async put(path, body = {})                     // JSON body; throws on non-2xx
}
```

### 4.2 Error Propagation

All methods throw `Error('LTS API {status} {statusText}: {body}')` on non-2xx responses. This is caught in each tool handler and returned as `{ isError: true, content: [...] }`.

### 4.3 Timeout Handling

All fetch calls use `AbortSignal.timeout(8000)`. Network errors (ECONNREFUSED, ETIMEDOUT) bubble up as native `Error` objects with `AbortError` or `TypeError` types.

---

## 5. Module Design — Server Factory (`create-server.js`)

### 5.1 `createServer(baseUrl)` Function

```javascript
export function createServer(baseUrl) {
  const server = new McpServer({ name: 'lts-mcp-server', version: '1.0.0', ... });
  const client = new LTSClient(baseUrl);

  registerLoiteringTools(server, client);
  registerAlertTools(server, client);
  registerCameraTools(server, client);
  registerAnalyticsTools(server, client);
  registerStatsTools(server, client);
  registerResources(server, client);

  return server;
}
```

### 5.2 Static Catalogs (for `GET /schema`)

`TOOL_CATALOG` — array of `{ name, access: 'read'|'write', description }` for all 11 tools.
`RESOURCE_CATALOG` — array of `{ uri, description }` for all 5 resources.

---

## 6. Module Design — Tools

### 6.1 Tool Registration Pattern

Each tool is registered using the `server.tool(name, description, zodSchema, handler)` API:

```javascript
server.tool(
  'tool_name',
  'Human-readable description for LLM',
  { param: z.string().optional().describe('...') },   // Zod input schema
  async (inputs) => {
    try {
      const data = await client.get('/api/...');
      return { content: [{ type: 'text', text: formatOutput(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);
```

### 6.2 Tool: `query_loitering_events` (loitering.js)

**API call**: `GET /api/events?limit=200&cameraId?&from?&to?`

**Client-side processing**:
1. Filter by `minDwellSec` if supplied: `events.filter(e => e.dwellTime >= minDwellSec)`.
2. Slice to `limit` (default 20).

**Output format**: One block per event with Event ID, Camera, Zone, Object ID, Dwell Time, Start Time.

### 6.3 Tool: `get_tracking_history` (loitering.js)

**API call**: `GET /api/events?limit=200&cameraId?`

**Aggregation logic**:
```javascript
const history    = events.filter(e => e.objectId === objectId);
const totalDwell = history.reduce((s, e) => s + (e.dwellTime || 0), 0);
const cameras    = [...new Set(history.map(e => e.cameraId))];
const zones      = [...new Set(history.map(e => e.zoneName || e.zoneId).filter(Boolean))];
const firstSeen  = history[history.length - 1]?.startTime;
const lastSeen   = history[0]?.startTime;
```

### 6.4 Tool: `get_active_alerts` (alerts.js)

**API call**: `GET /api/alerts?acknowledged=false&limit=100`

**Client-side processing**: Optional `cameraId` filter; sliced to `limit` (default 10).

**Timestamp normalization**: `typeof a.timestamp === 'number' ? a.timestamp : Date.parse(a.timestamp)` handles both Unix ms and ISO string formats.

### 6.5 Tool: `explain_alert` (alerts.js)

**Parallel data fetching**:
```javascript
const [eventResult, camerasResult, eventsResult] = await Promise.allSettled([
  alert.eventId ? client.get(`/api/events/${alert.eventId}`) : Promise.resolve(null),
  client.get('/api/cameras'),
  client.get('/api/events', { limit: 200 }),
]);
// Zone config fetched separately (may fail silently)
```

**Risk computation**:
```
dwellRatio = alert.dwellTime / zone.dwellThreshold  (defaults to 1 if no zone)
isNight    = hour >= 22 || hour < 6
isRepeat   = objectHistory.length > 3
riskLevel  = isNight && isRepeat → HIGH
           | isNight || isRepeat || dwellRatio > 2 → MEDIUM
           | LOW
```

### 6.6 Tool: `get_analytics_summary` (analytics.js)

**Parallel API calls**: Events and alerts fetched simultaneously via `Promise.allSettled`.

**Computed fields**:
- `avgDwellSec = totalDwellSec / eventCount`
- `maxDwellSec = max(events.map(e => e.dwellTime))`
- `peakHour` = hour (0–23) with most events; computed by grouping `startTime` by hour.
- `busiestCamera` = cameraId with most events.
- `alertsByZone` = `Map<zoneName, count>` built from alerts.

### 6.7 Tool: `generate_security_report` (analytics.js)

**Parallel API calls**: Events, alerts, cameras fetched via `Promise.allSettled`.

**Report sections**:
1. Header: Generated timestamp, period from→to, optional camera filter.
2. Executive Summary: event count, alert count, unacknowledged count.
3. Incident Log: up to 20 events, each with ID, time, camera, zone, dwell, object ID.
4. Key Metrics table: avg dwell, max dwell, peak hour, camera count.
5. Recommendations: generated based on thresholds (unacknowledged ratio, avg dwell vs. 30s default, night activity).

### 6.8 Tools: Camera & Zone (cameras.js)

| Tool | API Call | Key Logic |
|---|---|---|
| `get_camera_status` | `GET /api/cameras` | Format per-camera status; filter if `cameraId` supplied |
| `get_zone_config` | `GET /api/cameras/:id/zones` | Return zone list; empty → not-configured message |
| `update_zone_threshold` | `PUT /api/cameras/:id/zones/:zoneId { dwellThreshold }` | Zod validates 5–3600; returns zone name from response |
| `add_camera` | `POST /api/cameras` | RTSP 자격증명은 응답에서 `:***@` 패턴으로 마스킹 |
| `update_camera` | `PUT /api/cameras/:id` | 변경 필드만 body에 포함; 빈 body 시 즉시 early return |
| `delete_camera` | `DELETE /api/cameras/:id` | 비가역 — LLM은 호출 전 ID 확인 필요 |
| `toggle_camera_ai` | `POST /api/cameras/:id/ai/toggle { enabled }` | 스트림 중단 없이 AI 파이프라인만 토글 |

### 6.9 Tool: `get_stats_dashboard` (stats.js)

**API call**: `GET /api/stats` (single request, no parameters required)

**No input schema**: The tool takes no arguments — it always returns system-wide aggregated stats.

**Response transformation**:

```javascript
const { data } = await client.get('/api/stats');
// Formats data.cameras, data.events (7-day trend), data.alerts (by severity),
// data.zones, data.faces, data.storage into a Markdown report.
```

**Output structure** (Markdown):
```
## LTS-2026 Stats Dashboard
**Generated:** <ISO timestamp>
**Storage Mode:** json | mongodb

### Cameras
- Total:          N
- Streaming:      N
- Stopped:        N
- AI Enabled:     N

### Detection Events
- Total:          N
- Today:          N
- Loitering:      N
- 7-day trend:    YYYY-MM-DD: N | ... (7 entries)

### Alerts
- Total:          N
- Unacknowledged: N
- Today:          N
- Critical:       N
- High:           N
- Medium:         N
- Low:            N

### Zones
- Total:          N
- <TYPE>:         N  (per zone type)

### Face ID
- Galleries:      N
- Enrolled Faces: N
```

**Relation to Stats Dashboard Panel**: The web UI's `StatsPanelModal` component calls the same `GET /api/stats` endpoint. `get_stats_dashboard` exposes identical data to LLM clients via MCP, enabling natural language queries such as "How many cameras are streaming?" or "What is the unacknowledged alert count?".

### 6.10 Tool: `get_server_status` (system.js)

**API calls**: `GET /health` + optional `GET /admin/system`

```javascript
// includeMetrics=false (기본)
const health = await client.get('/health');
// Format: Status, Mode, Version, Uptime, DB Type, Cameras, Active Pipelines

// includeMetrics=true → 추가 호출
try {
  const metrics = await client.get('/admin/system');
  // CPU usage%, Memory RSS/Heap, GPU info
} catch {
  // "/admin/system" 권한 없을 시 fallback 메시지 출력 (오류 아님)
}
```

**Design note**: `includeMetrics` 기본값이 `false`인 이유 — `/admin/system`은 admin 권한 필요, `/health`는 누구나 접근 가능. 두 단계 설계로 비권한 LLM도 기본 상태 조회 가능.

### 6.11 Tools: ONVIF Events (onvif.js)

| Tool | API Call | Key Logic |
|---|---|---|
| `query_onvif_events` | `GET /api/onvif-events` | API-side 필터(cameraId/type/severity/from/to/limit) + 클라이언트측 `ruleName` 필터 |
| `get_onvif_event_types` | `GET /api/onvif-event-types` | Ever-seen topicType 레지스트리 전체 반환 |
| `get_onvif_snapshot` (v1.3) | `GET /api/onvif-snapshots` | `frameData` data URL에서 `data:image/...;base64,` 접두어 제거 후 MCP `image` content 블록으로 반환; 프레임 없으면 텍스트 안내 |

**`query_onvif_events` `ruleName` 필터 설계**:
- `/api/onvif-events` API는 `ruleName` 쿼리 파라미터 미지원
- `ruleName` 지정 시 API 응답 전체를 fetch 후 클라이언트측에서 필터링
- 단점: `limit` 제한이 ruleName 필터 전에 적용됨 → 필요 시 limit 증가 권고

### 6.12 Tools: AI Detection (detections.js)

| Tool | API Call | Key Logic |
|---|---|---|
| `query_analysis_events` | `GET /api/analysis/events` | type=all 시 파라미터 미전송; 타입별 count 헤더 생성 |
| `get_detection_tracks` | `GET /api/analysis/detection-tracks` | `inProgressOnly` 클라이언트측 필터; API는 `class` 파라미터 사용 |
| `get_analysis_metrics` | `GET /api/analysis/metrics` | analysis/combined 모드 전용; non-analysis 시 `isError: true` |

### 6.13 Tools: AI / Detection Config (config.js) — v1.3

| Tool | API Call | Key Logic |
|---|---|---|
| `get_model_catalog` | `GET /api/analysis/models` | `active` 플래그로 ▶ 마커, `downloading`/`exists`로 status 문자열 합성; combined/analysis 모드 전용 (streaming 프록시 미지원) |
| `get_fire_smoke_config` | `GET /api/analysis/config/fire-smoke` | `available: false` 시 서비스 미로드 안내로 조기 반환 |
| `get_tracker_config` | `GET /api/tracker/config` | `key` 파라미터로 단일 필드만 반환하는 선택적 축소 조회 지원 |

### 6.14 Tool: `search_all` (search.js) — v1.3

- `GET /api/search`를 그대로 래핑하되, `_type`(detection/alert/face/event/match)별로 서로 다른 한 줄 요약 포맷터를 적용해 LLM이 결과 유형을 즉시 구분할 수 있도록 함
- `query_analysis_events` + `get_active_alerts` + `get_object_snapshots`를 개별 호출·수동 병합하는 대신 자유 텍스트 질의 1회로 대체하는 것이 설계 목적

### 6.15 Tool: `list_face_galleries` (faces.js) — v1.3

- `GET /api/galleries` 응답(`faceCount` 포함)을 그대로 나열하며, `type` 파라미터로 클라이언트측 필터링
- 얼굴 임베딩(`embedding`)이나 썸네일은 반환하지 않음 — 갤러리 존재 여부·크기 확인용 (개인정보 최소 노출 원칙)

---

## 7. Module Design — Resources (`resources.js`)

### 7.1 Static Resources

```javascript
server.resource(
  'resource-name',
  'lts://uri',
  { mimeType: 'application/json', description: '...' },
  async () => ({
    contents: [{ uri: 'lts://uri', text: JSON.stringify(data, null, 2), mimeType: 'application/json' }]
  })
);
```

### 7.2 Resource Template (zone config)

```javascript
server.resource(
  'zones',
  new ResourceTemplate('lts://zones/{cameraId}', { list: undefined }),
  { mimeType: 'application/json', description: '...' },
  async (uri, { cameraId }) => {
    const { data } = await client.get(`/api/cameras/${cameraId}/zones`);
    return { contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), ... }] };
  }
);
```

### 7.3 `lts://system/summary` — Parallel Aggregation

```javascript
const [camerasRes, alertsRes, eventsRes] = await Promise.allSettled([
  client.get('/api/cameras'),
  client.get('/api/alerts', { acknowledged: 'false', limit: 100 }),
  client.get('/api/events', { limit: 100 }),
]);
// Each .status === 'fulfilled' → use .value.data || []
// Each .status === 'rejected' → default to []
const summary = {
  timestamp: new Date().toISOString(),
  cameras:  { total, running, aiEnabled },
  alerts:   { active, oldest },
  events:   { recent100Count, avgDwellSec },
};
```

### 7.4 `lts://stats/dashboard` — Full Aggregated Stats

```javascript
server.resource(
  'stats-dashboard',
  'lts://stats/dashboard',
  { mimeType: 'application/json', description: 'Full aggregated stats dashboard' },
  async () => {
    const { data } = await client.get('/api/stats');
    return {
      contents: [{ uri: 'lts://stats/dashboard', text: JSON.stringify(data, null, 2),
                   mimeType: 'application/json' }],
    };
  }
);
```

**Difference from `lts://system/summary`**: `system/summary` performs three separate API calls and computes lightweight aggregates. `stats/dashboard` is a single call to `GET /api/stats` which returns the full pre-computed `StatsData` object including 7-day event trend, per-severity alert breakdown, zone type distribution, Face ID enrollment counts, and storage mode — matching the Stats Dashboard Panel UI exactly.

**Use case for LLMs**: Injecting this resource at session start gives an LLM full situational awareness of the LTS-2026 deployment without requiring multiple tool calls.

---

## 8. Data Models

### 8.1 LTSCamera

```typescript
interface LTSCamera {
  id:             string;
  name:           string;
  url:            string;
  type:           'rtsp' | 'youtube' | string;
  aiEnabled:      boolean;
  bitrate?:       number;
  pipelineStatus: { running: boolean; error?: string } | null;
  createdAt:      string;
}
```

### 8.2 LTSAlert

```typescript
interface LTSAlert {
  id:           string;
  eventId:      string;
  cameraId:     string;
  objectId:     string;
  zoneId:       string | null;
  zoneName:     string | null;
  type:         'LOITERING' | string;
  dwellTime:    number;
  timestamp:    number | string;   // Unix ms or ISO 8601
  acknowledged: boolean;
}
```

### 8.3 LTSEvent

```typescript
interface LTSEvent {
  id:        string;
  cameraId:  string;
  objectId:  string;
  zoneId:    string | null;
  zoneName:  string | null;
  startTime: string;
  dwellTime: number;
  clipPath?: string;
  createdAt: string;
}
```

### 8.4 LTSZone

```typescript
interface LTSZone {
  id:              string;
  cameraId:        string;
  name:            string;
  type:            'MONITOR' | 'EXCLUDE';
  polygon:         Array<{ x: number; y: number }>;
  dwellThreshold:  number;
  minDisplacement?: number;
  reentryWindow?:  number;
  targetClasses:   string[];
  schedule?:       object;
  createdAt:       string;
}
```

---

## 9. Sequence Diagrams

### 9.1 stdio Tool Call Flow

```
LLM (Claude Code)            MCP SDK              Tool Handler         LTS API
      │                          │                     │                  │
      │── tool_call(name,args) ──►│                     │                  │
      │                          │── Zod validate args ─►│                 │
      │                          │                     │── fetch(url,8s) ──►│
      │                          │                     │◄── JSON response ──│
      │                          │                     │ formatOutput()     │
      │◄── tool_result(text) ────│◄── { content } ─────│                  │
```

### 9.2 `explain_alert` Parallel Fetch

```
Handler
  │
  │── client.get('/api/alerts?limit=1000') ──────────────────────────────►
  │◄── allAlerts[] ─────────────────────────────────────────────────────
  │  alert = allAlerts.find(id === alertId)
  │
  │── Promise.allSettled([
  │     client.get('/api/events/{eventId}'),   ──────────────────────────►
  │     client.get('/api/cameras'),             ──────────────────────────►
  │     client.get('/api/events?limit=200'),    ──────────────────────────►
  │   ])                                        ◄── (parallel responses) ──
  │
  │── client.get('/api/cameras/{cameraId}/zones')  ──────────────────────►
  │◄── zones[] (or catch silently) ─────────────────────────────────────
  │
  │  computeRisk() → riskLevel
  │  buildMarkdownReport()
  │◄── { content: [{ type:'text', text: report }] }
```

### 9.3 HTTP/SSE Session Lifecycle

```
OpenAI Agent             Express (/sse)           MCP Server Instance
     │                        │                           │
     │── GET /sse ────────────►│                           │
     │                        │── createServer(baseUrl) ──►│ (new instance)
     │                        │── new SSEServerTransport ──►│
     │                        │── sessions.set(sid, trn) │
     │◄── SSE stream ─────────│                           │
     │                        │                           │
     │── POST /message?sid=X ─►│                           │
     │                        │── transport.handlePost ────►│
     │                        │                            │── tool handler
     │◄── SSE event ──────────│◄── tool_result ────────────│
     │                        │                           │
     │── [connection close] ──►│                           │
     │                        │── sessions.delete(sid) ──►│ (GC'd)
```

---

## 10. Error Handling Design

### 10.1 Tool Error Wrapper

Every tool handler wraps logic in `try/catch` and returns:
```javascript
catch (err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}
```

### 10.2 LTS API Error Propagation

`LTSClient` throws `Error('LTS API {status} {statusText}: {body}')`. Tools do not need to inspect the error type; the message is forwarded directly to the LLM.

### 10.3 Partial Failure in Multi-Call Tools

Tools using `Promise.allSettled` handle per-call failures as follows:

| Tool | Failed sub-call | Degradation |
|---|---|---|
| `explain_alert` | Zone config | Returns `"Zone details unavailable"` |
| `explain_alert` | Object history | Returns `"First recorded occurrence"` |
| `explain_alert` | Camera info | Falls back to raw `cameraId` string |
| `lts://system/summary` | Any call | Section shows zero-values |
| `generate_security_report` | Any call | Section shows empty list or zero |

### 10.4 Not-Found Handling

Tools that look up specific IDs by filtering a list:
- `explain_alert`: scans all alerts by `id`; returns `isError: true` + `"Alert not found: {id}"` if absent.
- `get_zone_config`: zone list empty → `"No zones configured for camera: {id}"` (not `isError`).

---

## 11. Configuration & Environment

### 11.1 Environment Variables

| Variable | Default | Used in |
|---|---|---|
| `LTS_BASE_URL` | `http://localhost:3080` | `index.js` → `createServer(baseUrl)` |
| `TRANSPORT` | `stdio` | `index.js` |
| `MCP_PORT` | `3002` | `index.js` (HTTP mode) |
| `MCP_AUTH_TOKEN` | _(empty)_ | `index.js` (HTTP mode) |
| `MCP_PUBLIC_URL` | `http://localhost:{MCP_PORT}` | `index.js` `/schema` endpoint |

### 11.2 `package.json` Key Fields

```json
{
  "type": "module",
  "scripts": {
    "start":      "node index.js",
    "dev":        "node --watch index.js",
    "start:http": "TRANSPORT=http node index.js",
    "dev:http":   "TRANSPORT=http node --watch index.js",
    "test":       "node --test test/**/*.test.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": ">=1.0.0",
    "zod": ">=3.23.0",
    "express": ">=4.18.0",
    "cors": ">=2.8.5"
  }
}
```

---

## 12. Integration Design

### 12.1 Claude Code — stdio

The server is registered in `.claude/settings.json` as an MCP server. Claude Code spawns `node mcp-server/index.js` with the `LTS_BASE_URL` environment variable. Claude Code discovers all 10 tools and 4 resources automatically from the server's MCP handshake.

### 12.2 VS Code / GitHub Copilot — stdio

Registered in `.vscode/mcp.json` under `"servers"`. Same stdio launch config as Claude Code.

### 12.3 OpenAI Agents SDK — HTTP/SSE

```python
from openai.agents import MCPServerSse

mcp_server = MCPServerSse(
    url="http://localhost:3002/sse",
    headers={"Authorization": f"Bearer {MCP_AUTH_TOKEN}"}
)
```

The OpenAI agent connects to `/sse`, which creates a new server instance per session. The `/schema` endpoint provides a static catalog for manual GPT Action registration.

### 12.4 Claude.ai Mobile — HTTP/SSE via Public URL

The `MCP_PUBLIC_URL` environment variable overrides the base URL in `/schema` responses, enabling routing through an ngrok tunnel or reverse proxy for mobile Claude.ai connections.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for LLM MCP Server |
| 1.1 | 2026-06-25 | LTS Engineering Team | §6.10~6.12 확장 도구 3그룹 추가 (system.js, onvif.js, detections.js); §6.8 카메라 CRUD 4종 추가; 버전 1.1 |
| 1.3 | 2026-07-08 | LTS Engineering Team | §2 File Structure 전체 갱신 (test/, missing-person.js, config.js, search.js, faces.js 반영); §6.11에 get_onvif_snapshot 추가; §6.13~6.15 신규 모듈 설계 추가 (config.js/search.js/faces.js); 버전 1.1→1.3 (v1.2 query_face_trajectories 항목은 이전 리비전에서 누락되어 있었음 — 이번 갱신에서 §2에 함께 반영) |
