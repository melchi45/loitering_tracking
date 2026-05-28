# TEST CASES (TC)
# LLM/MCP Server Integration

| | |
|---|---|
| **Document ID** | TC-LTS-MCP-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_LLM_MCP_Server.md |
| **Test Scripts** | test/api/mcp_server.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Server Startup & Transport](#3-test-group-a--server-startup--transport)
4. [Test Group B — Loitering & Tracking Tools](#4-test-group-b--loitering--tracking-tools)
5. [Test Group C — Alert Tools](#5-test-group-c--alert-tools)
6. [Test Group D — Camera & Zone Tools](#6-test-group-d--camera--zone-tools)
7. [Test Group E — Analytics & Report Tools](#7-test-group-e--analytics--report-tools)
8. [Test Group F — MCP Resources](#8-test-group-f--mcp-resources)
9. [Test Group G — HTTP SSE Transport](#9-test-group-g--http-sse-transport)
10. [Test Group H — Error Handling & Security](#10-test-group-h--error-handling--security)
11. [Test Execution Order](#11-test-execution-order)
12. [Pass/Fail Criteria](#12-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | HTTP SSE endpoints, /health, /schema | Node.js fetch | `test/api/mcp_server.test.js` |
| Tool invocation | All 10 MCP tools via JSON-RPC | MCP client / Node.js | `test/api/mcp_tools.test.js` (Phase-2) |
| Integration | End-to-end LLM tool call → LTS API response | Claude API mock | `test/integration/mcp_integration.test.js` (Phase-2) |
| E2E | Real LLM (Claude) queries LTS system | Manual | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-MCP-001 | TC-A-001 |
| FR-MCP-002 | TC-A-002 |
| FR-MCP-003 | TC-A-003 |
| FR-MCP-004 | TC-H-001 |
| FR-MCP-010 | TC-B-001 |
| FR-MCP-011 | TC-B-002 |
| FR-MCP-020 | TC-C-001 |
| FR-MCP-021 | TC-C-002 |
| FR-MCP-022 | TC-C-003 |
| FR-MCP-030 | TC-D-001 |
| FR-MCP-031 | TC-D-002 |
| FR-MCP-032 | TC-D-003 |
| FR-MCP-040 | TC-E-001 |
| FR-MCP-041 | TC-E-002 |
| FR-MCP-050 | TC-F-001 |
| FR-MCP-051 | TC-F-002 |
| FR-MCP-052 | TC-F-003 |
| FR-MCP-053 | TC-F-004 |
| FR-MCP-054 | TC-F-005 |
| FR-MCP-042 | TC-I-001 |
| FR-MCP-060 | TC-G-001 |
| FR-MCP-061 | TC-G-002 |
| FR-MCP-062 | TC-G-003 |
| FR-MCP-063 | TC-G-004 |
| FR-MCP-064 | TC-H-002 |
| FR-MCP-065 | TC-G-005 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `LTS_BASE_URL=http://localhost:3001` | MCP server target |
| Sample loitering event fixture | Tool response tests |
| Zone fixture with dwell threshold | `update_zone_threshold` test |
| `MCP_AUTH_TOKEN=test-token` | Auth tests |

---

## 2. Test Environment and Prerequisites

- LTS server running on `http://localhost:3001`
- MCP server started with `LTS_BASE_URL=http://localhost:3001`
- For HTTP SSE tests: `TRANSPORT=http MCP_PORT=3002`
- At least 1 camera, 1 zone, 1 loitering event, 1 active alert

---

## 3. Test Group A — Server Startup & Transport

### TC-A-001 — Startup Registration
- **Input:** Start MCP server; inspect available tools
- **Expected:** 11 tools and 5 resources registered on startup; `LTS_BASE_URL` read from env
- **Acceptance:** Tool list has exactly 11 items; resource list has 5 items

### TC-A-002 — stdio vs HTTP Transport Selection
- **Input:** Start with `TRANSPORT=stdio` (default) and again with `TRANSPORT=http`
- **Expected:** stdio → communicates via stdin/stdout; http → listens on `MCP_PORT`
- **Acceptance:** Correct transport selected based on env var

### TC-A-003 — Environment Variables
- **Input:** Check env vars at startup
- **Expected:** `LTS_BASE_URL`, `TRANSPORT`, `MCP_PORT`, `MCP_AUTH_TOKEN`, `MCP_PUBLIC_URL` all readable
- **Acceptance:** Server starts with defaults when optional vars absent

---

## 4. Test Group B — Loitering & Tracking Tools

### TC-B-001 — query_loitering_events
- **Input:** Invoke tool with `{ cameraId: "cam-1", limit: 5 }`
- **Expected:** Returns up to 5 loitering events for camera cam-1
- **Acceptance:** Response is array; length ≤ 5; each event has required fields

### TC-B-002 — get_tracking_history
- **Input:** Invoke tool with `{ objectId: "obj-001" }`
- **Expected:** Full appearance history for obj-001 with timestamps and statistics
- **Acceptance:** History array returned; statistics include first seen, last seen, total dwell

---

## 5. Test Group C — Alert Tools

### TC-C-001 — get_active_alerts
- **Input:** Invoke `get_active_alerts` with 3 unacknowledged alerts present
- **Expected:** Returns array of 3 unacknowledged alerts
- **Acceptance:** All 3 alerts present; acknowledged alerts not included

### TC-C-002 — explain_alert
- **Input:** Invoke `explain_alert` with valid alert ID
- **Expected:** Returns contextual explanation with risk level (HIGH/MEDIUM/LOW)
- **Acceptance:** `riskLevel` field is one of HIGH/MEDIUM/LOW; explanation text non-empty

### TC-C-003 — acknowledge_alert
- **Input:** Invoke `acknowledge_alert` with valid alert ID
- **Expected:** `POST /api/alerts/{alertId}/acknowledge` called on LTS server; success response
- **Acceptance:** Alert marked as acknowledged; no longer in `get_active_alerts`

---

## 6. Test Group D — Camera & Zone Tools

### TC-D-001 — get_camera_status
- **Input:** Invoke `get_camera_status` with camera ID
- **Expected:** Returns camera pipeline status and AI enabled state
- **Acceptance:** `status` field present; `aiEnabled` boolean present

### TC-D-002 — get_zone_config
- **Input:** Invoke `get_zone_config` with camera ID that has 2 zones
- **Expected:** Returns array of 2 zones with polygons, thresholds, targetClasses
- **Acceptance:** Zone array length = 2; each zone has polygon, dwellThreshold, targetClasses

### TC-D-003 — update_zone_threshold
- **Input:** Invoke `update_zone_threshold` with `{ cameraId, zoneId, dwellThreshold: 120 }`
- **Expected:** Zone threshold updated; value within 5–3600 range accepted
- **Acceptance:** HTTP 200 from LTS; zone returns updated threshold on GET

---

## 7. Test Group E — Analytics & Report Tools

### TC-E-001 — get_analytics_summary
- **Input:** Invoke `get_analytics_summary` with time window "1h"
- **Expected:** Returns event counts, alert counts, and statistics for last 1 hour
- **Acceptance:** Summary contains event count, alert count, and time window

### TC-E-002 — generate_security_report
- **Input:** Invoke `generate_security_report`
- **Expected:** Returns markdown-formatted security report with all sections
- **Acceptance:** Output is valid Markdown; includes camera status, events, alerts sections

---

## 8. Test Group F — MCP Resources

### TC-F-001 — lts://cameras Resource
- **Input:** Request `lts://cameras` resource
- **Expected:** Full camera JSON array returned (no cache)
- **Acceptance:** Array contains all registered cameras

### TC-F-002 — lts://alerts/active Resource
- **Input:** Request `lts://alerts/active` resource
- **Expected:** Unacknowledged alert JSON array
- **Acceptance:** Only unacknowledged alerts present

### TC-F-003 — lts://zones/{cameraId} Resource Template
- **Input:** Request `lts://zones/cam-1`
- **Expected:** Zone list for camera cam-1 returned
- **Acceptance:** Array contains zones for cam-1 only

### TC-F-004 — lts://system/summary Resource
- **Input:** Request `lts://system/summary` resource
- **Expected:** JSON summary with camera count, alert count, event count
- **Acceptance:** All 3 count fields present

### TC-F-005 — lts://stats/dashboard Resource
- **Input:** Request `lts://stats/dashboard` resource
- **Expected:** Full JSON `StatsData` object returned from `GET /api/stats`
- **Acceptance:** Response contains `cameras`, `events`, `alerts`, `zones`, `faces`, `storage` fields; `events.last7days` is an array of 7 entries; `alerts.bySeverity` object present

---

## 9. Test Group G — HTTP SSE Transport

### TC-G-001 — GET /sse Endpoint
- **Input:** HTTP SSE transport; `GET /sse`
- **Expected:** SSE stream opened; session-specific `McpServer` instance created
- **Acceptance:** `text/event-stream` response; session ID assigned

### TC-G-002 — POST /message Routing
- **Input:** `POST /message?sessionId=<session-id>` with JSON-RPC payload
- **Expected:** Message routed to correct session's `McpServer` instance
- **Acceptance:** Correct session receives message; response returned

### TC-G-003 — GET /schema Endpoint
- **Input:** `GET /schema`
- **Expected:** JSON catalog of all tools and resources returned
- **Acceptance:** 11 tools + 5 resources listed

### TC-G-004 — GET /health Endpoint
- **Input:** `GET /health`
- **Expected:** JSON with server status, transport mode, and LTS base URL
- **Acceptance:** All 3 fields present; status = "ok"

### TC-G-005 — CORS Headers
- **Input:** HTTP SSE transport; request from different origin
- **Expected:** CORS headers present on all routes
- **Acceptance:** `Access-Control-Allow-Origin` header present

---

## 10. Test Group H — Error Handling & Security

### TC-H-001 — Tool Error Format
- **Input:** Invoke tool with invalid parameters (e.g., non-existent alert ID)
- **Expected:** Returns `{ content: [...], isError: true }` response
- **Acceptance:** `isError: true` in response; no unhandled exception

### TC-H-002 — Bearer Token Auth (HTTP Transport)
- **Input:** `GET /sse` without Authorization header when `MCP_AUTH_TOKEN` set
- **Expected:** HTTP 401 returned
- **Acceptance:** Unauthorized request rejected; authorized request succeeds

---

## 11. Test Group I — Stats Dashboard Tool

### TC-I-001 — get_stats_dashboard Basic Invocation
- **Input:** Invoke `get_stats_dashboard` with no parameters
- **Expected:** Tool calls `GET /api/stats` once; returns Markdown report with header `## LTS-2026 Stats Dashboard`
- **Acceptance:** Response is non-empty Markdown text; `isError` is absent or false; report contains Cameras, Detection Events, Alerts, Zones, Face ID sections

### TC-I-002 — get_stats_dashboard Field Coverage
- **Input:** Invoke `get_stats_dashboard`; compare output against direct `GET /api/stats` response
- **Expected:** Camera total, streaming count, today’s event count, unacknowledged alert count all match `GET /api/stats` data
- **Acceptance:** All 4 numeric fields match within same request cycle

### TC-I-003 — get_stats_dashboard 7-day Trend
- **Input:** Invoke `get_stats_dashboard` when `events.last7days` has 7 entries
- **Expected:** Output includes `7-day trend:` line with 7 date entries in `YYYY-MM-DD: N` format
- **Acceptance:** Trend line present; exactly 7 date tokens separated by ` | `

### TC-I-004 — get_stats_dashboard Severity Breakdown
- **Input:** Invoke `get_stats_dashboard` when `alerts.bySeverity` has non-zero values
- **Expected:** Output includes Critical, High, Medium, Low severity lines
- **Acceptance:** All 4 severity fields present in output text

### TC-I-005 — get_stats_dashboard API Failure
- **Input:** Invoke `get_stats_dashboard` with LTS server unavailable
- **Expected:** Tool returns `{ isError: true, content: [{ text: 'Error: ...' }] }`
- **Acceptance:** `isError: true` present; no unhandled exception; error message describes failure

---

## 12. Test Execution Order

```
Group A (startup) → Group B (loitering tools) → Group C (alert tools) → Group D (camera/zone) → Group E (analytics) → Group F (resources) → Group G (HTTP SSE) → Group H (security) → Group I (stats dashboard)
```

---

## 13. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Startup | 11 tools + 5 resources registered; transport selection correct |
| Tools | All 11 tools return correct data structures |
| Resources | All 5 resources return correct JSON |
| HTTP SSE | /sse, /message, /schema, /health all work |
| Error handling | `isError: true` on failures; no unhandled exceptions |
| Security | Auth token enforced on HTTP transport |
| Stats Dashboard | `get_stats_dashboard` returns Markdown with all 5 sections; `lts://stats/dashboard` returns full StatsData JSON |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for LLM MCP Server |
