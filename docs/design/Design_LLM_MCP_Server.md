# DESIGN DOCUMENT
# LLM MCP Server

| | |
|---|---|
| **Document ID** | DESIGN-LTS-MCP-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
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
│             LTS-2026 Express API  (port 3001)                    │
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

```
mcp-server/
├── package.json          # "type": "module" (ESM); deps: @modelcontextprotocol/sdk, zod, express, cors
├── index.js              # Entry point: transport selection, Express app (http mode)
├── create-server.js      # McpServer factory; exports TOOL_CATALOG, RESOURCE_CATALOG
├── lts-client.js         # LTSClient class: get(), post(), put() with fetch + AbortSignal
├── resources.js          # Four MCP resource registrations
└── tools/
    ├── loitering.js      # query_loitering_events, get_tracking_history
    ├── alerts.js         # get_active_alerts, explain_alert, acknowledge_alert
    ├── cameras.js        # get_camera_status, get_zone_config, update_zone_threshold
    ├── analytics.js      # get_analytics_summary, generate_security_report
    └── stats.js          # get_stats_dashboard
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
| `LTS_BASE_URL` | `http://localhost:3001` | `index.js` → `createServer(baseUrl)` |
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
