# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# LTS-2026 LLM MCP Server

| | |
|---|---|
| **Document ID** | PRD-LTS-MCP-001 |
| **Version** | 1.1 |
| **Status** | In Progress — M1–M4 Complete |
| **Date** | May 21, 2026 |
| **Author** | LTS-2026 Engineering |
| **Related RFP** | LTS-2026-010 |

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [User Stories](#4-user-stories)
5. [Functional Specification](#5-functional-specification)
6. [Data Models](#6-data-models)
7. [Tool API Reference](#7-tool-api-reference)
8. [Resource API Reference](#8-resource-api-reference)
9. [Error Handling](#9-error-handling)
10. [Acceptance Criteria](#10-acceptance-criteria)
11. [Out of Scope](#11-out-of-scope)
12. [Milestones & Implementation Status](#12-milestones--implementation-status)

---

## 1. Product Vision

**For** security operators and AI engineers working with the LTS-2026 system,  
**the LTS MCP Server is** a Model Context Protocol adapter  
**that** enables Large Language Models (Claude, ChatGPT) to query detection events, triage alerts, and generate reports using natural language  
**unlike** direct REST API access or dashboard-only interfaces,  
**our product** provides a structured, schema-validated, LLM-native interface that transforms raw detection data into actionable intelligence.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Allow any MCP-compatible LLM to query loitering events, alerts, and camera status without custom prompting.
- **G2**: Enable rich contextual alert explanation that surfaces behavioral patterns, zone configs, and risk levels.
- **G3**: Support natural language shift reports and analytics summaries with zero manual data export.
- **G4**: Integrate natively with Claude Code (stdio) and OpenAI Agents (HTTP/SSE).
- **G5**: Zero modification to the existing LTS-2026 Express API or database.

### 2.2 Non-Goals

- **NG1**: Real-time video streaming or frame delivery via MCP.
- **NG2**: LLM-based object detection (AI inference remains in the core pipeline).
- **NG3**: User authentication/multi-tenancy — the MCP server is a single-tenant process.
- **NG4**: Alert creation or camera management (add/remove cameras) — read-mostly design.
- **NG5**: Mobile app or web UI for the MCP server itself.

---

## 3. User Personas

### P1: Security Operator (Primary)

- **Role**: Monitors CCTV dashboard during shift, responds to loitering alerts
- **Tech level**: Non-technical; comfortable with dashboards, not REST APIs
- **Need**: Quick answers to "what happened" questions without navigating multiple screens
- **Pain**: Alert overload; no context for why an alert fired
- **How MCP helps**: Natural language queries via Claude.ai or ChatGPT; explain_alert gives immediate context

### P2: AI / DevOps Engineer (Secondary)

- **Role**: Develops and maintains the LTS pipeline; uses Claude Code daily
- **Tech level**: Expert
- **Need**: Access to real-time detection data while editing pipeline code
- **How MCP helps**: Registered as Claude Code MCP server; query live data during development without switching context

### P3: Security Manager (Tertiary)

- **Role**: Reviews incidents, prepares reports for compliance
- **Tech level**: Low-medium
- **Need**: Weekly/shift reports without manual data extraction
- **How MCP helps**: `generate_security_report` produces ready-to-share markdown in seconds

### P4: LLM Agent / Automation (System)

- **Role**: Automated agent running on schedule (e.g., nightly report, hourly alert digest)
- **Tech level**: N/A (code)
- **Need**: Programmatic access to LTS data for agentic workflows
- **How MCP helps**: Tool + resource interface enables agent loops without bespoke API clients

---

## 4. User Stories

### 4.1 Alert Triage

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-001 | As a security operator, I want to ask "what are the current alerts?" so that I can quickly see what needs attention | `get_active_alerts` returns unacknowledged alerts in < 2s with camera/zone/time |
| US-002 | As a security operator, I want to understand why a specific alert fired so that I can decide whether to investigate | `explain_alert` returns risk level, zone config, object history, and time context |
| US-003 | As a security operator, I want to acknowledge an alert via natural language so that I don't need to switch to the dashboard | `acknowledge_alert` calls the API and confirms success |

### 4.2 Event Querying

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-004 | As an operator, I want to query "loitering events in Zone A last night" so that I can review overnight activity | `query_loitering_events` accepts natural-language-mapped params (from/to, cameraId) |
| US-005 | As an engineer, I want to look up the full history of a tracked object so that I can verify tracking accuracy | `get_tracking_history` returns all appearances, cameras visited, dwell totals |

### 4.3 Camera & Zone Management

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-006 | As an engineer, I want to check which cameras are online so that I can diagnose pipeline issues | `get_camera_status` shows running state and AI-enabled flag |
| US-007 | As an engineer, I want to inspect zone polygon and dwell threshold for a camera so that I can tune false-positive rates | `get_zone_config` returns full zone config |
| US-008 | As an operator, I want to increase a zone's dwell threshold when a zone is generating too many false alarms | `update_zone_threshold` validates range (5–3600s) and calls the PUT endpoint |

### 4.4 Analytics & Reporting

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-009 | As a manager, I want a statistical summary of the last 24 hours so that I can see trends at a glance | `get_analytics_summary` returns event count, avg/max dwell, peak hour, alerts by zone |
| US-010 | As a manager, I want a formatted shift report (22:00–06:00) so that I can brief the day team | `generate_security_report` returns full markdown with incident log and recommendations |

### 4.5 Resources

| ID | Story | Acceptance Criteria |
|---|---|---|
| US-011 | As an LLM agent, I want to read the camera list as a resource so that I can reference camera names in my responses | `lts://cameras` resource returns JSON array of cameras |
| US-012 | As an LLM agent, I want to read active alerts as a resource so that I can proactively flag issues | `lts://alerts/active` returns unacknowledged alerts |

---

## 5. Functional Specification

### 5.1 Server Initialization

On startup (`node mcp-server/index.js`):
1. Read `LTS_BASE_URL` from environment (default `http://localhost:3001`)
2. Instantiate `McpServer` with name `lts-mcp-server`, version `1.0.0`
3. Register all tools (loitering, alerts, cameras, analytics)
4. Register all resources (cameras, alerts/active, zones template, system/summary)
5. Connect `StdioServerTransport` and begin handling requests
6. Log `[LTS MCP] Server running — connected to {LTS_BASE_URL}` to stderr

### 5.2 Tool Invocation Flow

```
LLM Client → MCP Protocol → Tool Handler → LTS HTTP Client → LTS REST API
                                  ↓
                         Zod Input Validation
                                  ↓
                          fetch(LTS_BASE_URL + path)
                                  ↓
                        Format Response Text
                                  ↓
                      { content: [{ type: 'text', text }] }
```

### 5.3 Error Response Convention

All tool errors return:
```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true
}
```

Network errors (LTS server unavailable) produce:
```
Error: LTS API 503: Service Unavailable
```

### 5.4 Parallel Data Fetching

Tools that require multiple API calls (`explain_alert`, `generate_security_report`) use `Promise.all` for parallelism. Individual sub-call failures are caught and result in partial data with a fallback message rather than full failure.

---

## 6. Data Models

### 6.1 LTS Event (from `/api/events`)

```typescript
interface LTSEvent {
  id: string;           // UUID
  cameraId: string;     // Camera reference
  objectId: string;     // Tracked object ID
  zoneId: string | null;
  zoneName: string | null;
  startTime: string;    // ISO 8601
  dwellTime: number;    // Seconds
  clipPath?: string;    // Video clip path if recorded
  createdAt: string;    // ISO 8601
}
```

### 6.2 LTS Alert (from `/api/alerts`)

```typescript
interface LTSAlert {
  id: string;           // UUID
  eventId: string;      // Associated event UUID
  cameraId: string;
  objectId: string;
  zoneId: string | null;
  zoneName: string | null;
  type: 'LOITERING' | string;
  dwellTime: number;    // Seconds
  timestamp: number | string;  // Unix ms or ISO 8601
  acknowledged: boolean;
}
```

### 6.3 LTS Camera (from `/api/cameras`)

```typescript
interface LTSCamera {
  id: string;           // UUID
  name: string;
  url: string;          // RTSP/HTTP/YouTube URL
  type: 'rtsp' | 'youtube' | string;
  aiEnabled: boolean;
  bitrate?: number;     // kbps
  pipelineStatus: {
    running: boolean;
    error?: string;
  } | null;
  createdAt: string;
}
```

### 6.4 LTS Zone (from `/api/cameras/:id/zones`)

```typescript
interface LTSZone {
  id: string;           // UUID
  cameraId: string;
  name: string;
  type: 'MONITOR' | 'EXCLUDE';
  polygon: Array<{ x: number; y: number }>;  // Normalized 0–1
  dwellThreshold: number;   // Seconds (default 30)
  minDisplacement?: number;
  reentryWindow?: number;
  targetClasses: string[];  // ['human', 'vehicle', ...]
  schedule?: object;
  createdAt: string;
}
```

---

## 7. Tool API Reference

### `query_loitering_events`

```
Description: Query loitering detection events with optional filters.
             Returns events where tracked objects exceeded dwell thresholds.

Input:
  cameraId?    : string       — Camera ID filter
  from?        : string       — ISO 8601 start time
  to?          : string       — ISO 8601 end time
  minDwellSec? : number       — Minimum dwell time (seconds)
  limit?       : integer(1–100) — Max results (default: 20)

Output (success):
  "Found N loitering event(s):\n
   Event ID: <id>\n  Camera: <cameraId>\n  Zone: <zoneName>\n
   Object ID: <objectId>\n  Dwell Time: <N>s\n  Start Time: <ISO>"

Output (empty):
  "No loitering events found for the specified filters."
```

### `get_active_alerts`

```
Description: Get current unacknowledged loitering alerts sorted by recency.

Input:
  cameraId? : string        — Camera filter
  limit?    : integer(1–50) — Max results (default: 10)

Output:
  "N active alert(s):\n
   Alert ID: <id>\n  Type: LOITERING\n  Camera: <id>\n
   Zone: <name>\n  Dwell Time: <N>s\n  Time: <ISO>"
```

### `explain_alert`

```
Description: Comprehensive contextual explanation of a specific alert.
             Fetches alert + event + camera + zone data in parallel.

Input:
  alertId : string — Alert UUID (required)

Output (markdown):
  ## Alert Explanation
  **Alert ID:** ...  **Status:** Active/Acknowledged
  **Triggered At:** ISO (time-of-day label)

  ### Incident Details
  - Type / Camera / Zone / Dwell Time / Object ID

  ### Zone Configuration
  - Type / Dwell Threshold / Polygon Points / Schedule

  ### Object History
  - Total appearances / First seen / Cameras visited
  - ⚠️ Repeat behavior detected (if > 3 appearances)

  ### Risk Assessment
  - Risk Level: LOW | MEDIUM | HIGH
  - Contributing factors (dwell ratio, night hours, repeat actor)
```

### `acknowledge_alert`

```
Description: Mark an alert as acknowledged (reviewed and handled).

Input:
  alertId : string — Alert UUID (required)

Output:
  "Alert <id> has been acknowledged."
```

### `get_camera_status`

```
Description: List cameras with pipeline running state and AI status.

Input:
  cameraId? : string — Optional single camera lookup

Output:
  "Cameras: N/M running\n
   Camera: <name>  ID: ...  Type: rtsp  Status: 🟢 Running  AI: Yes"
```

### `get_zone_config`

```
Description: Zone polygon, threshold, target classes, and schedule for a camera.

Input:
  cameraId : string — Camera UUID (required)

Output:
  "N zone(s) for camera <id>:\n
   Zone: <name> (<id>)  Type: MONITOR  Dwell Threshold: 30s
   Polygon: 4 points  Target Classes: human"
```

### `update_zone_threshold`

```
Description: Update dwell threshold for a zone (5–3600 seconds).
             Use to tune sensitivity and reduce false positives.

Input:
  cameraId       : string       — Camera UUID (required)
  zoneId         : string       — Zone UUID (required)
  dwellThreshold : integer(5–3600) — New threshold in seconds (required)

Output:
  "Zone <name> threshold updated to <N>s."
```

### `get_analytics_summary`

```
Description: Statistical summary of events and alerts for a time window.

Input:
  from?     : string — ISO 8601 (default: 24h ago)
  to?       : string — ISO 8601 (default: now)
  cameraId? : string — Optional camera filter

Output (markdown):
  ## Analytics Summary
  **Period:** ...

  ### Events
  - Total / Avg dwell / Max dwell / Peak hour / Busiest camera

  ### Alerts
  - Total / Acknowledged / Active (unacknowledged)

  ### Alerts by Zone
  - Zone A: N  Zone B: N  ...
```

### `generate_security_report`

```
Description: Full markdown security report for shift handovers or management review.

Input:
  from      : string — ISO 8601 start (required)
  to        : string — ISO 8601 end (required)
  cameraId? : string — Optional camera filter

Output (markdown):
  # Security Report
  **Generated:** ISO  **Period:** from → to

  ## Executive Summary
  N events / M alerts / K unacknowledged

  ## Incident Log
  ### Incident 1 ... (up to 20)

  ## Key Metrics
  | Metric | Value | (table)

  ## Recommendations
  ⚠️ or ✅ based on computed conditions
```

### `get_tracking_history`

```
Description: Aggregated tracking history for a specific object ID.

Input:
  objectId  : string — Track ID (required)
  cameraId? : string — Optional camera filter

Output:
  "Tracking History for Object: <id>
   Appearances: N  Total Dwell: Ns
   Cameras seen: cam1, cam2
   Zones visited: Zone A, Zone B
   First seen: ISO  Last seen: ISO"
```

---

## 8. Resource API Reference

### `lts://cameras`

```
Type:      Static resource
MIME:      application/json
Refresh:   On-demand (no caching)
Content:   JSON array of LTSCamera objects (pipelineStatus included)
```

### `lts://alerts/active`

```
Type:      Static resource
MIME:      application/json
Refresh:   On-demand
Content:   JSON array of LTSAlert objects where acknowledged = false (limit 50)
```

### `lts://zones/{cameraId}`

```
Type:      Resource template
MIME:      application/json
Params:    cameraId (string)
Content:   JSON array of LTSZone objects for the given camera
```

### `lts://system/summary`

```
Type:      Static resource
MIME:      application/json
Content:
{
  "timestamp": "ISO",
  "cameras": { "total": N, "running": N, "aiEnabled": N },
  "alerts":  { "active": N, "oldest": "ISO" },
  "events":  { "last100Count": N, "avgDwellSec": N }
}
```

---

## 9. Error Handling

### 9.1 LTS Server Unavailable

When `fetch()` throws a network error (ECONNREFUSED, ETIMEDOUT):
- Tool returns `isError: true`
- Message: `"Error: LTS server unavailable at http://localhost:3001 — ensure the server is running (npm run dev)"`

### 9.2 Resource Not Found

When a queried ID does not exist in the database:
- `explain_alert` with unknown ID: `"Alert not found: <id>"`
- `get_zone_config` with no zones: `"No zones configured for camera: <id>"`

### 9.3 Invalid Input

Zod validation errors surface as MCP protocol-level errors before the handler is invoked (SDK default behavior). Additional semantic validation (e.g., `dwellThreshold` range) is enforced at the Zod schema level.

### 9.4 Partial Failure in `explain_alert`

If zone or event sub-calls fail, `explain_alert` degrades gracefully:
- Zone config: `"Zone details unavailable"`
- Object history: `"First occurrence for this object"`
- Camera info: Falls back to raw `cameraId`

---

## 10. Acceptance Criteria

### AC-001: Server Startup
- [ ] `node mcp-server/index.js` starts without errors when `LTS_BASE_URL` is set
- [ ] Server logs connection info to stderr (not stdout — stdout is reserved for MCP protocol)
- [ ] Server appears in Claude Code's MCP server list after settings update

### AC-002: Tool Coverage
- [ ] All 10 tools registered and callable via MCP protocol
- [ ] Each tool returns structured text content on success
- [ ] Each tool returns `isError: true` on LTS API failure

### AC-003: Tool Correctness
- [ ] `query_loitering_events` results match `/api/events` filtered data
- [ ] `get_active_alerts` returns only `acknowledged: false` alerts
- [ ] `explain_alert` risk level is HIGH when object appears >3× AND hour >= 22
- [ ] `acknowledge_alert` results in alert disappearing from `get_active_alerts`
- [ ] `update_zone_threshold` change is reflected in subsequent `get_zone_config`

### AC-004: Resource Correctness
- [ ] `lts://cameras` returns valid JSON array matching `/api/cameras`
- [ ] `lts://alerts/active` contains only unacknowledged alerts
- [ ] `lts://zones/{cameraId}` returns zones for the specified camera only
- [ ] `lts://system/summary` JSON structure matches schema in §8

### AC-005: Error Resilience
- [ ] All tools return `isError: true` with descriptive message when LTS is down
- [ ] `explain_alert` with unknown ID returns not-found message (no crash)
- [ ] `update_zone_threshold` with `dwellThreshold = 4` fails Zod validation

### AC-006: Integration
- [ ] Claude Code discovers server after `.claude/settings.json` update
- [ ] VS Code discovers server after `.vscode/mcp.json` update
- [ ] `LTS_BASE_URL` env var correctly overrides default `http://localhost:3001`

### AC-007: Performance
- [ ] `get_active_alerts` responds in < 2s on local network
- [ ] `explain_alert` responds in < 3s (parallel sub-calls via Promise.all)
- [ ] `generate_security_report` for 7-day window responds in < 5s

---

## 11. Out of Scope

| Feature | Reason |
|---|---|
| Video frame extraction or thumbnail delivery | Binary data not suited for MCP text content |
| LLM inference within the MCP server | Inference remains in detection pipeline |
| Camera add/delete/update | Scope limited to operational tools (ack, threshold) |
| User session management | Single-tenant stdio process |
| Alert creation | Alerts generated only by detection pipeline |
| Historical data export (CSV, PDF) | `generate_security_report` covers markdown; CSV/PDF is a future enhancement |
| Push notifications to LLM | MCP is pull-based; real-time push requires webhook integration (separate RFP) |

---

## 12. Milestones & Implementation Status

> Full task breakdown by phase: [`RFP_LLM_MCP_Integration.md §9`](../RFP_LLM_MCP_Integration.md#9-project-milestones)

### 12.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| **M1** | Core MCP Server: stdio + 10 tools | 2026-05-28 | 2026-05-21 | ✅ Done |
| **M2** | Resource handlers + Settings integration | 2026-06-07 | 2026-05-21 | ✅ Done |
| **M3** | HTTP/SSE transport (OpenAI Agents) | 2026-06-14 | 2026-05-21 | ✅ Done |
| **M4** | Documentation + System prompt guide | 2026-06-21 | 2026-05-21 | ✅ Done |
| **M5** | Final delivery & review | 2026-06-30 | - | 🔄 In Progress |

### 12.2 Phase Implementation Summary

#### Phase 1 — Core MCP Server ✅ (M1)
- `lts-client.js`: LTS REST API HTTP wrapper
- `tools/loitering.js`: `query_loitering_events`, `get_tracking_history`
- `tools/alerts.js`: `get_active_alerts`, `explain_alert`, `acknowledge_alert`
- `tools/cameras.js`: `get_camera_status`, `get_zone_config`, `update_zone_threshold`
- `tools/analytics.js`: `get_analytics_summary`, `generate_security_report`
- `create-server.js`: McpServer factory (dual transport support)

#### Phase 2 — Resources & Settings ✅ (M2)
- `resources.js`: 4 MCP resources (`lts://cameras`, `lts://alerts/active`, `lts://zones/{cameraId}`, `lts://system/summary`)
- `.claude/settings.json`: `lts` MCP server registration (stdio)
- `.vscode/mcp.json`: `lts` (stdio) + `lts-http` (SSE) registration

#### Phase 3 — HTTP/SSE Transport ✅ (M3)
- `index.js`: `TRANSPORT=http` mode — Express + `SSEServerTransport`
- `GET /sse` + `POST /message`: OpenAI `MCPServerSse` compatible
- `GET /schema`: Tool/resource catalog for GPT Action registration
- `GET /health`: Liveness probe
- `MCP_AUTH_TOKEN` Bearer auth + CORS
- `MCP_PUBLIC_URL`: Public domain/IP override support

#### Phase 4 — Documentation ✅ (M4)
- `mcp-server/README.md`: Setup, run, and integration guide (D4)
- `mcp-server/SYSTEM_PROMPT.md`: LLM system prompt guide, 6 sections (D7)
- 34 unit tests (`node:test`, LTSClient + tool handlers)
- `npm test` script, all tests passing

#### Phase 5 — Final Delivery 🔄 (M5, target: 2026-06-30)

**5-A. Public Deployment / Claude.ai Mobile** ⏳
- [ ] Open firewall port 3002 or set up ngrok tunnel
- [ ] HTTPS reverse proxy (nginx + Let's Encrypt)
- [ ] Set `MCP_PUBLIC_URL` and `MCP_AUTH_TOKEN` env vars
- [ ] Register SSE URL in claude.ai Integrations
- [ ] Verify tool calls from mobile app

**5-B. OpenAI Agents E2E Verification** ⏳
- [ ] Connect via `MCPServerSse` library
- [ ] Bearer auth end-to-end verification
- [ ] GPT Action registration via `/schema`

**5-C. Performance Validation** ⏳ _(RFP §7)_
- [ ] Read tool response ≤ 2s (p95)
- [ ] `explain_alert` ≤ 3s
- [ ] `generate_security_report` 30-day window ≤ 5s
- [ ] Concurrent SSE sessions ≥ 10
- [ ] Memory footprint ≤ 64 MB RSS

**5-D. Source Control** ⏳
- [ ] git commit `mcp-server/`
- [ ] git commit `PRD_LLM_MCP_Server.md`, `RFP_LLM_MCP_Integration.md`
- [ ] git commit `.vscode/mcp.json`, `.claude/settings.json`

### 12.3 Deliverables Checklist

| # | Deliverable | Path | Status |
|---|---|---|---|
| D1 | MCP server source code | `mcp-server/` | ✅ |
| D2 | RFP document | `RFP_LLM_MCP_Integration.md` | ✅ |
| D3 | PRD document | `PRD_LLM_MCP_Server.md` | ✅ |
| D4 | README (setup & integration guide) | `mcp-server/README.md` | ✅ |
| D5 | Claude Code settings integration | `.claude/settings.json` | ✅ |
| D6 | VS Code settings integration | `.vscode/mcp.json` | ✅ |
| D7 | LLM system prompt guide | `mcp-server/SYSTEM_PROMPT.md` | ✅ |

**Deliverables complete: 7 / 7 (100%)**
