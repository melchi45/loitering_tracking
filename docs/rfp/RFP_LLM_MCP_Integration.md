# REQUEST FOR PROPOSAL (RFP)
# LLM Integration via Model Context Protocol (MCP) for Loitering Tracking System

| | |
|---|---|
| **RFP Reference** | LTS-2026-010 |
| **Issue Date** | May 21, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |
| **Related RFPs** | LTS-2026-001 (Core System), LTS-2026-002 (YouTube/RTSP Ingest) |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Background & Motivation](#2-background--motivation)
3. [Technical Requirements](#3-technical-requirements)
4. [MCP Server Specification](#4-mcp-server-specification)
5. [LLM Integration Requirements](#5-llm-integration-requirements)
6. [Security & Authentication](#6-security--authentication)
7. [Performance Requirements](#7-performance-requirements)
8. [Deliverables](#8-deliverables)
9. [Project Milestones](#9-project-milestones)
10. [Evaluation Criteria](#10-evaluation-criteria)
11. [Appendix — Tool & Resource Catalog](#11-appendix--tool--resource-catalog)

---

## 1. Project Overview

### 1.1 Purpose

This RFP solicits development of a **Model Context Protocol (MCP) server** that bridges the LTS-2026 Loitering Tracking System with Large Language Models (LLMs) — specifically Anthropic Claude and OpenAI ChatGPT/Agents. The MCP server shall expose the system's detection data, alert pipeline, and zone configuration as structured tools and resources that LLMs can query and act upon in real time.

### 1.2 Scope

The selected solution shall:

- Implement an MCP-compliant server (`@modelcontextprotocol/sdk`) as a standalone Node.js process
- Connect to the running LTS-2026 REST API (`http://localhost:3080`) as a data source
- Expose tools for event querying, alert management, camera monitoring, and report generation
- Expose resources for cameras, active alerts, zones, and system summary
- Support **stdio transport** (Claude Code / Claude API integration)
- Support **HTTP/SSE transport** (OpenAI Agents / ChatGPT Actions integration)
- Ship with RFP/PRD documentation, unit tests, and a `README.md`

---

## 2. Background & Motivation

### 2.1 System Context

The LTS-2026 system processes live CCTV feeds through a YOLOv8-based detection pipeline, tracks individuals via multi-object tracking (ByteTrack), and raises loitering alerts when configured dwell-time thresholds are exceeded. The system stores events and alerts in a JSON database (`storage/lts.json`) and exposes a REST API on port 3080.

### 2.2 Problem Statement

While the system generates high-quality detection data, it lacks:

- **Natural language querying**: Operators must navigate a dashboard UI; they cannot ask "What happened in Zone B last night?" in plain language.
- **Contextual alert explanation**: Alerts contain raw numerical data (dwellTime, objectId) but no human-readable risk assessment or behavioral context.
- **AI-assisted decision support**: No mechanism for an LLM to proactively analyze patterns, suggest threshold adjustments, or generate shift-handover reports.
- **Agentic workflows**: No way to chain detection data with downstream actions (email drafts, report filing, camera reconfigurations) via LLM agents.

### 2.3 Solution Overview

By implementing the Model Context Protocol, we expose the LTS system as a first-class context provider for any MCP-compatible LLM. Claude Code users gain real-time access to detection data during development; production operators can query the system through Claude.ai or OpenAI Agents; automated agents can poll for anomalies and generate reports on schedule.

```
┌─────────────────────────────────────────────────────────┐
│                  MCP Client Layer                        │
│   Claude Code │ Claude API │ OpenAI Agents │ ChatGPT    │
└───────────────────────────┬─────────────────────────────┘
                            │  MCP Protocol
                            │  (stdio / HTTP SSE)
┌───────────────────────────▼─────────────────────────────┐
│              LTS MCP Server  (lts-mcp-server)           │
│                                                          │
│  Tools:                    Resources:                    │
│  · query_loitering_events  · lts://cameras              │
│  · get_active_alerts       · lts://alerts/active        │
│  · explain_alert           · lts://zones/{cameraId}     │
│  · acknowledge_alert       · lts://system/summary       │
│  · get_camera_status                                     │
│  · get_zone_config                                       │
│  · update_zone_threshold                                 │
│  · get_analytics_summary                                 │
│  · generate_security_report                              │
│  · get_tracking_history                                  │
└───────────────────────────┬─────────────────────────────┘
                            │  HTTP REST
┌───────────────────────────▼─────────────────────────────┐
│             LTS-2026 Express API  (:3001)                │
│   /api/cameras  /api/events  /api/alerts  /api/zones    │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Technical Requirements

### 3.1 Runtime & Platform

| Requirement | Specification |
|---|---|
| Runtime | Node.js ≥ 20 (ESM) |
| Protocol | Model Context Protocol (MCP) v1.x |
| SDK | `@modelcontextprotocol/sdk` ≥ 1.0.0 |
| Schema Validation | `zod` ≥ 3.23 |
| Target OS | Linux (Ubuntu 18.04+), macOS 13+ |
| Transport (primary) | stdio (Claude Code / Claude API) |
| Transport (secondary) | HTTP/SSE (OpenAI Agents / future) |

### 3.2 Dependency Constraints

- **No persistent database**: The MCP server is stateless; all state lives in the LTS REST API.
- **No background polling**: The server is on-demand only; no timers or scheduled jobs.
- **No credentials in code**: All secrets (API keys, base URLs) via environment variables.
- **Zero impact on LTS core**: The MCP server is a read-mostly client; write operations limited to `acknowledge_alert` and `update_zone_threshold`.

### 3.3 Transport Requirements

#### 3.3.1 stdio Transport (Phase 1)

- Standard MCP stdio transport (`StdioServerTransport`)
- Registered in Claude Code `.claude/settings.json` under `mcpServers`
- Launched as `node mcp-server/index.js` with `LTS_BASE_URL` env var

#### 3.3.2 HTTP/SSE Transport (Phase 2)

- Expose MCP over HTTP + Server-Sent Events for OpenAI Agents compatibility
- Listen on configurable port (default: 3002, env: `MCP_PORT`)
- Optional Bearer token authentication (`MCP_AUTH_TOKEN` env var)
- CORS-enabled for browser-based agent UIs

---

## 4. MCP Server Specification

### 4.1 Project Structure

```
mcp-server/
├── package.json          # ESM package, MCP SDK dependency
├── index.js              # Entry point — McpServer + transport setup
├── lts-client.js         # HTTP fetch wrapper for LTS REST API
├── resources.js          # MCP resource registrations
└── tools/
    ├── loitering.js      # query_loitering_events, get_tracking_history
    ├── alerts.js         # get_active_alerts, explain_alert, acknowledge_alert
    ├── cameras.js        # get_camera_status, get_zone_config, update_zone_threshold
    └── analytics.js      # get_analytics_summary, generate_security_report
```

### 4.2 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LTS_BASE_URL` | `http://localhost:3080` | LTS REST API base URL |
| `MCP_PORT` | `3002` | HTTP/SSE transport port (Phase 2) |
| `MCP_AUTH_TOKEN` | _(none)_ | Bearer token for HTTP transport |
| `LOG_LEVEL` | `info` | Logging verbosity |

### 4.3 Tool Specifications

Each tool follows the MCP tool schema: `name`, `description`, `inputSchema` (Zod), `handler`.

#### 4.3.1 `query_loitering_events`

Queries the `/api/events` endpoint with optional filters. Returns structured event data including dwell time, zone name, and camera context.

**Input parameters:**
- `cameraId` (string, optional) — filter by camera
- `from` (ISO 8601 string, optional) — start time
- `to` (ISO 8601 string, optional) — end time
- `minDwellSec` (number, optional) — minimum dwell filter
- `limit` (integer 1–100, optional, default 20)

#### 4.3.2 `get_active_alerts`

Returns unacknowledged alerts sorted by recency. Calls `/api/alerts?acknowledged=false`.

**Input parameters:**
- `cameraId` (string, optional)
- `limit` (integer 1–50, optional, default 10)

#### 4.3.3 `explain_alert`

Fetches an alert and enriches it with: event history, camera metadata, zone configuration, object recurrence pattern, and risk assessment (LOW/MEDIUM/HIGH) computed from dwell ratio, time of day, and repeat appearances.

**Input parameters:**
- `alertId` (string, required)

**Risk model:**

| Factor | Weight |
|---|---|
| Dwell ratio > 2× threshold | HIGH indicator |
| Night hours (22:00–06:00) | Elevated risk |
| Object seen > 3× in 24h | Repeat actor |

#### 4.3.4 `acknowledge_alert`

Posts to `/api/alerts/:id/acknowledge`. Marks alert as reviewed.

**Input parameters:**
- `alertId` (string, required)

#### 4.3.5 `get_camera_status`

Returns all cameras with pipeline running state, AI-enabled flag, and error messages.

**Input parameters:**
- `cameraId` (string, optional) — single camera lookup

#### 4.3.6 `get_zone_config`

Returns zone polygon, dwell threshold, target classes, and schedule for a given camera.

**Input parameters:**
- `cameraId` (string, required)

#### 4.3.7 `update_zone_threshold`

Updates `dwellThreshold` on a zone via `PUT /api/cameras/:cameraId/zones/:zoneId`.

**Input parameters:**
- `cameraId` (string, required)
- `zoneId` (string, required)
- `dwellThreshold` (integer 5–3600, required)

#### 4.3.8 `get_analytics_summary`

Aggregates events and alerts for a time window. Returns: total events, total alerts, avg/max dwell time, peak hour, busiest camera, alerts by zone, acknowledgment rate.

**Input parameters:**
- `from` (ISO 8601, optional, default 24h ago)
- `to` (ISO 8601, optional, default now)
- `cameraId` (string, optional)

#### 4.3.9 `generate_security_report`

Produces a full markdown security report with executive summary, incident log (up to 20 items), key metrics table, and automated recommendations.

**Input parameters:**
- `from` (ISO 8601, required)
- `to` (ISO 8601, required)
- `cameraId` (string, optional)

#### 4.3.10 `get_tracking_history`

Returns aggregated appearance history for a specific tracked object: appearance count, total dwell time, cameras visited, zones visited, first/last seen timestamps.

**Input parameters:**
- `objectId` (string, required)
- `cameraId` (string, optional)

### 4.4 Resource Specifications

| URI | Description | MIME Type |
|---|---|---|
| `lts://cameras` | All cameras with pipeline status | `application/json` |
| `lts://alerts/active` | Unacknowledged alerts (last 50) | `application/json` |
| `lts://zones/{cameraId}` | Zone config for a specific camera | `application/json` |
| `lts://system/summary` | Aggregated system health summary | `application/json` |

---

## 5. LLM Integration Requirements

### 5.1 Claude Code Integration

The MCP server shall be registered in `.claude/settings.json`:

```json
{
  "mcpServers": {
    "lts": {
      "command": "node",
      "args": ["mcp-server/index.js"],
      "env": { "LTS_BASE_URL": "http://localhost:3080" }
    }
  }
}
```

### 5.2 VS Code MCP Integration

Simultaneously registered in `.vscode/mcp.json` for VS Code Copilot/extension compatibility:

```json
{
  "servers": {
    "lts": {
      "command": "node",
      "args": ["mcp-server/index.js"],
      "env": { "LTS_BASE_URL": "http://localhost:3080" },
      "type": "stdio"
    }
  }
}
```

### 5.3 OpenAI Agents Integration (Phase 2)

- HTTP/SSE endpoint at `http://localhost:3002/sse`
- Compatible with OpenAI Agents SDK `MCPServerSse` client
- JSON schema exported at `GET /schema` for manual GPT Action registration

### 5.4 Prompt Engineering Recommendations

The vendor shall supply a `SYSTEM_PROMPT.md` with recommended system prompt fragments to optimize LLM behavior when using the MCP tools, covering:

- How to call `explain_alert` before `acknowledge_alert`
- When to use `get_analytics_summary` vs `query_loitering_events`
- Guidance for generating shift reports with `generate_security_report`

---

## 6. Security & Authentication

### 6.1 API Access

- stdio transport: No authentication required (process isolation)
- HTTP/SSE transport: Optional Bearer token via `MCP_AUTH_TOKEN` env var
- All sensitive config via environment variables, never hardcoded

### 6.2 Write Operation Scope

Write-capable tools are limited to:
- `acknowledge_alert` — marks alert reviewed (non-destructive)
- `update_zone_threshold` — modifies detection sensitivity (operational)

All other tools are read-only.

### 6.3 Input Validation

All tool inputs validated via Zod schemas before reaching the LTS API. Invalid inputs return structured MCP error responses rather than raw HTTP errors.

---

## 7. Performance Requirements

| Metric | Requirement |
|---|---|
| Tool response time | ≤ 2s (p95) for read tools |
| `explain_alert` latency | ≤ 3s (involves 3–4 parallel API calls) |
| `generate_security_report` | ≤ 5s for 30-day window |
| Concurrent MCP connections | ≥ 10 (HTTP/SSE transport) |
| Memory footprint | ≤ 64 MB RSS |

---

## 8. Deliverables

| # | Deliverable | Format |
|---|---|---|
| D1 | MCP server source code | `mcp-server/` directory |
| D2 | RFP document (this document) | `RFP_LLM_MCP_Integration.md` |
| D3 | PRD document | `PRD_LLM_MCP_Server.md` |
| D4 | README with setup instructions | `mcp-server/README.md` |
| D5 | Claude settings integration | `.claude/settings.json` update |
| D6 | VS Code settings integration | `.vscode/mcp.json` update |
| D7 | System prompt guide | `mcp-server/SYSTEM_PROMPT.md` |

---

## 9. Project Milestones

### 9.1 Progress Summary

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Core MCP server: stdio transport + all 10 tools | 2026-05-28 | 2026-05-21 | ✅ Done |
| M2 | Resource handlers, settings integration | 2026-06-07 | 2026-05-21 | ✅ Done |
| M3 | HTTP/SSE transport for OpenAI Agents | 2026-06-14 | 2026-05-21 | ✅ Done |
| M4 | Documentation, system prompt guide | 2026-06-21 | 2026-05-21 | ✅ Done |
| M5 | Final delivery & review | 2026-06-30 | - | 🔄 In Progress |

---

### 9.2 Phase Task Breakdown

#### Phase 1 — M1: Core MCP Server ✅
**Completed:** 2026-05-21 (7 days ahead of schedule)

| # | Task | Status |
|---|---|---|
| 1-1 | `mcp-server/` directory structure and `package.json` | ✅ |
| 1-2 | `lts-client.js` — LTS REST API HTTP wrapper (get / post / put) | ✅ |
| 1-3 | `tools/loitering.js` — `query_loitering_events`, `get_tracking_history` | ✅ |
| 1-4 | `tools/alerts.js` — `get_active_alerts`, `explain_alert`, `acknowledge_alert` | ✅ |
| 1-5 | `tools/cameras.js` — `get_camera_status`, `get_zone_config`, `update_zone_threshold` | ✅ |
| 1-6 | `tools/analytics.js` — `get_analytics_summary`, `generate_security_report` | ✅ |
| 1-7 | `index.js` — `StdioServerTransport` connection and server startup | ✅ |
| 1-8 | `create-server.js` — McpServer factory (dual transport support) | ✅ |

#### Phase 2 — M2: Resources & Settings Integration ✅
**Completed:** 2026-05-21 (17 days ahead of schedule)

| # | Task | Status |
|---|---|---|
| 2-1 | `resources.js` — `lts://cameras`, `lts://alerts/active`, `lts://zones/{cameraId}`, `lts://system/summary` | ✅ |
| 2-2 | `.claude/settings.json` — `lts` MCP server registration (stdio) | ✅ |
| 2-3 | `.vscode/mcp.json` — `lts` (stdio) + `lts-http` (SSE) server registration | ✅ |
| 2-4 | LTS REST API connectivity verification (`/api/cameras`, `/api/events`, `/api/alerts`) | ✅ |

#### Phase 3 — M3: HTTP/SSE Transport ✅
**Completed:** 2026-05-21 (24 days ahead of schedule)

| # | Task | Status |
|---|---|---|
| 3-1 | `index.js` — `TRANSPORT=http` mode branching | ✅ |
| 3-2 | `GET /sse` — SSE connection endpoint (independent McpServer per session) | ✅ |
| 3-3 | `POST /message?sessionId=xxx` — JSON-RPC message handler | ✅ |
| 3-4 | `GET /schema` — Tool/Resource catalog JSON for GPT Action registration | ✅ |
| 3-5 | `GET /health` — Liveness probe endpoint | ✅ |
| 3-6 | `MCP_AUTH_TOKEN` Bearer authentication middleware | ✅ |
| 3-7 | CORS configuration for browser-based agent UIs | ✅ |
| 3-8 | `MCP_PUBLIC_URL` env var for public domain/IP override | ✅ |
| 3-9 | `npm run start:http` / `npm run dev:http` scripts | ✅ |

#### Phase 4 — M4: Documentation ✅
**Completed:** 2026-05-21 (31 days ahead of schedule)

| # | Task | Status |
|---|---|---|
| 4-1 | `RFP_LLM_MCP_Integration.md` — RFP document (D2) | ✅ |
| 4-2 | `PRD_LLM_MCP_Server.md` — PRD document (D3) | ✅ |
| 4-3 | `mcp-server/README.md` — Setup and integration guide (D4) | ✅ |
| 4-4 | `mcp-server/SYSTEM_PROMPT.md` — LLM system prompt guide (D7) | ✅ |
| 4-5 | 34 unit tests (`node:test`, fetch mocking) | ✅ |
| 4-6 | `npm test` script registered, all tests passing | ✅ |

#### Phase 5 — M5: Final Delivery 🔄
**Target:** 2026-06-30

**5-A. Public Deployment / Claude.ai Mobile Integration**

| # | Task | Status |
|---|---|---|
| 5-A-1 | Open firewall port 3002 or set up ngrok tunnel | ⏳ |
| 5-A-2 | HTTPS reverse proxy (nginx + Let's Encrypt) | ⏳ |
| 5-A-3 | Configure `MCP_PUBLIC_URL` and `MCP_AUTH_TOKEN` env vars | ⏳ |
| 5-A-4 | Register SSE URL in claude.ai Settings → Integrations | ⏳ |
| 5-A-5 | Verify tool calls from mobile app | ⏳ |

**5-B. OpenAI Agents E2E Verification**

| # | Task | Status |
|---|---|---|
| 5-B-1 | Connect via `openai.agents.MCPServerSse` to `/sse` | ⏳ |
| 5-B-2 | Bearer auth end-to-end verification | ⏳ |
| 5-B-3 | GPT Action registration via `/schema` | ⏳ |

**5-C. Performance Validation** _(RFP §7 requirements)_

| # | Task | Requirement | Status |
|---|---|---|---|
| 5-C-1 | Read tool response time | ≤ 2s (p95) | ⏳ |
| 5-C-2 | `explain_alert` response time | ≤ 3s | ⏳ |
| 5-C-3 | `generate_security_report` 30-day window | ≤ 5s | ⏳ |
| 5-C-4 | Concurrent SSE sessions | ≥ 10 | ⏳ |
| 5-C-5 | Memory footprint | ≤ 64 MB RSS | ⏳ |

**5-D. Source Control**

| # | Task | Status |
|---|---|---|
| 5-D-1 | git commit `mcp-server/` (all files) | ⏳ |
| 5-D-2 | git commit `PRD_LLM_MCP_Server.md`, `RFP_LLM_MCP_Integration.md` | ⏳ |
| 5-D-3 | git commit `.vscode/mcp.json`, `.claude/settings.json` | ⏳ |

---

### 9.3 Deliverables Checklist

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

---

## 10. Evaluation Criteria

| Criterion | Weight |
|---|---|
| Protocol compliance (MCP spec adherence) | 25% |
| Tool quality (descriptions, schema accuracy) | 25% |
| Code quality (ESM, error handling, readability) | 20% |
| Integration completeness (Claude + OpenAI) | 15% |
| Documentation quality | 15% |

---

## 11. Appendix — Tool & Resource Catalog

### A. Complete Tool Summary

| Tool | Read/Write | Primary Use Case |
|---|---|---|
| `get_server_status` | Read | 서버 상태 진단, 모드/업타임/DB 타입 확인 |
| `query_loitering_events` | Read | Natural language event queries |
| `get_active_alerts` | Read | Real-time alert monitoring |
| `explain_alert` | Read | Alert triage and context |
| `acknowledge_alert` | Write | Alert lifecycle management |
| `get_camera_status` | Read | Infrastructure monitoring |
| `get_zone_config` | Read | Zone rule inspection |
| `add_camera` | Write | 신규 카메라 채널 등록 (LLM 지시로 카메라 추가) |
| `update_camera` | Write | 카메라 설정 업데이트 (이름, URL, AI 활성화) |
| `delete_camera` | Write | 카메라 채널 삭제 및 파이프라인 중지 |
| `toggle_camera_ai` | Write | AI 추론 ON/OFF 토글 (스트림 유지) |
| `update_zone_threshold` | Write | Sensitivity tuning |
| `get_analytics_summary` | Read | KPI dashboards, trend analysis |
| `generate_security_report` | Read | Shift reports, management review |
| `get_tracking_history` | Read | Person-of-interest tracking |
| `query_onvif_events` | Read | ONVIF 이벤트 조회 (화재/움직임/라인크로싱 등) |
| `get_onvif_event_types` | Read | 시스템 ever-seen ONVIF topicType 레지스트리 조회 |
| `query_analysis_events` | Read | AI 감지 이벤트 조회 (배회/화재/연기) |
| `get_detection_tracks` | Read | 객체 감지 트랙 이력 (체류 시간/클래스별) |
| `get_analysis_metrics` | Read | AI 파이프라인 메트릭 (FPS/GPU/모델 정보) |

### B. Example LLM Interaction Flows

**Flow 1: Operator Alert Triage**
```
User: "What's the most urgent alert right now?"
→ LLM calls get_active_alerts()
→ Picks top alert by recency
→ LLM calls explain_alert(alertId)
→ Returns: risk level, zone info, object history
→ LLM recommends: acknowledge or investigate
```

**Flow 2: Morning Shift Handover**
```
User: "Give me a report for last night's shift (22:00–06:00)"
→ LLM calls generate_security_report(from, to)
→ Returns: incident count, open alerts, key metrics, recommendations
```

**Flow 3: Threshold Optimization**
```
User: "Zone B keeps triggering false alarms — why?"
→ LLM calls get_zone_config(cameraId)
→ LLM calls get_analytics_summary(from, to, cameraId)
→ Analysis: avg dwell = 25s, threshold = 20s → too low
→ LLM calls update_zone_threshold(cameraId, zoneId, 45)
→ Confirms: threshold updated
```

### C. API Endpoint Mapping

| MCP Tool / Resource | LTS REST Endpoint |
|---|---|
| `query_loitering_events` | `GET /api/events?cameraId&from&to&limit` |
| `get_tracking_history` | `GET /api/events?limit=200` (client-filtered) |
| `get_active_alerts` | `GET /api/alerts?acknowledged=false&limit` |
| `explain_alert` | `GET /api/alerts`, `GET /api/events/:id`, `GET /api/cameras`, `GET /api/cameras/:id/zones` |
| `acknowledge_alert` | `POST /api/alerts/:id/acknowledge` |
| `get_camera_status` | `GET /api/cameras` |
| `get_zone_config` | `GET /api/cameras/:cameraId/zones` |
| `update_zone_threshold` | `PUT /api/cameras/:cameraId/zones/:id` |
| `get_analytics_summary` | `GET /api/events`, `GET /api/alerts` (client aggregation) |
| `generate_security_report` | `GET /api/events`, `GET /api/alerts`, `GET /api/cameras` |
| `lts://cameras` | `GET /api/cameras` |
| `lts://alerts/active` | `GET /api/alerts?acknowledged=false&limit=50` |
| `lts://zones/{cameraId}` | `GET /api/cameras/:cameraId/zones` |
| `lts://system/summary` | Parallel: cameras + alerts + events |
| `get_server_status` | `GET /health`, `GET /admin/system` (opt) |
| `add_camera` | `POST /api/cameras` |
| `update_camera` | `PUT /api/cameras/:id` |
| `delete_camera` | `DELETE /api/cameras/:id` |
| `toggle_camera_ai` | `POST /api/cameras/:id/ai/toggle` |
| `query_onvif_events` | `GET /api/onvif-events` |
| `get_onvif_event_types` | `GET /api/onvif-event-types` |
| `query_analysis_events` | `GET /api/analysis/events` |
| `get_detection_tracks` | `GET /api/analysis/detection-tracks` |
| `get_analysis_metrics` | `GET /api/analysis/metrics` |

---

### D. Live MCP Demo — Real Session Transcript (2026-05-21)

The following is a real interaction recorded on 2026-05-21 with Claude Code connected to the `lts` MCP server via stdio transport (`~/.mcp.json`). It demonstrates the end-to-end LLM ↔ MCP ↔ LTS pipeline operating on live production data.

---

#### D.0 MCP Server Reconnect

**Command:**
```
/mcp
```

**Output:**
```
⎿  Reconnected to lts.
```

---

#### D.1 Camera Status Query

**User prompt:**
```
What is the camera status?
```

**MCP tool called:** `get_camera_status()`

**LLM response:**

| Field | Value |
|---|---|
| Camera name | TID-A800 |
| Type | RTSP |
| Status | Running |
| AI Inference | Enabled |

> 1 out of 1 camera is operating normally.

---

#### D.2 Daily Event Summary

**User prompt:**
```
Summarize today's events.
```

**MCP tools called:** `query_loitering_events()`, `get_active_alerts()`

**LLM response:**

| Metric | Value |
|---|---|
| Total events | 170 |
| Average dwell time | 601 s (≈ 10 min) |
| Maximum dwell time | 2,555 s (≈ 42 min) |
| Peak hour | 07:00–08:00 |
| Unacknowledged alerts | 170 (0% processed) |

**Key observations:**
- Object `756b762b`: continuous presence in Zone 1 from 08:48 to 09:45 (~1 hour); maximum single dwell 2,555 s (~42 min) — high-risk repeat actor
- Multiple short-dwell objects detected 08:33–09:09 (3–483 s)
- All 170 alerts unacknowledged — immediate review recommended

---

#### D.3 Hourly Event Breakdown

**User prompt:**
```
Can you summarize the camera events by time slot?
```

**MCP tools called:** `query_loitering_events()` × 2 (paginated, 100 + 70 events)

**LLM response — hourly distribution:**

| Time slot | Events | Share |
|---|:---:|:---:|
| 06:00–07:00 | 35 | 21% |
| **07:00–08:00** | **55** | **32% ← peak** |
| 08:00–09:00 | 47 | 28% |
| 09:00–10:00 | 33 | 19% |
| **Total** | **170** | **100%** |

**Per-hour detail:**

**06:00–07:00 (35 events)**
- Mostly short-dwell objects (3–250 s)
- Object `85836196`: continuous re-detection 06:46–06:54, max dwell 629 s
- Objects `3a035125`, `f06848af` entered zone at 06:55–06:59

**07:00–08:00 (55 events — peak)**
- Object `f06848af`: continuous detection 07:02–07:29, cumulative max 2,002 s (~33 min)
- Object `3a035125`: continuous detection 07:01–07:30, max 2,017 s (~34 min)
- Two objects simultaneously present in Zone 1 for 30+ min — highest-risk window of the day
- Short-dwell objects `b3d1c57d`, `82b524f7` appeared 07:31–07:39

**08:00–09:00 (47 events)**
- Object `c8fd82ef`: continuous re-detection 08:00–08:21, max 2,051 s (~34 min) — 2nd longest dwell
- Object `300fb218`: 08:11–08:19, max 902 s (~15 min)
- Object `66c42426`: 08:08–08:15, max 475 s (~8 min)
- ~10-min gap after 08:38; object `756b762b` entered at 08:48 and continued into the 09:xx slot

**09:00–10:00 (33 events)**
- Object `756b762b`: continuous re-detection 09:01–09:30, max 2,555 s (~42 min) — longest dwell of the day
- Object `2dc1e377`: repeated detection 09:40–09:45, max 285 s
- High-risk pattern: 30+ min dwell objects accumulating from 09:07 onwards

**Summary:**

| Finding | Detail |
|---|---|
| Most dangerous time slot | 07:00–08:00 (55 events, 2 simultaneous 34-min objects) |
| Most dangerous object | `756b762b` (42-min dwell, 09:xx slot) |
| Action required | All 170 events unprocessed — prioritise 07:00–08:00 review |

---

> **Note:** This transcript was generated with Claude Code v2.1.146 (Sonnet 4.6) connected to the `lts` MCP server in stdio mode. All data reflects live LTS production state on 2026-05-21. The LLM autonomously selected and sequenced the appropriate MCP tools (`get_camera_status`, `query_loitering_events`, `get_active_alerts`) without explicit tool instructions from the operator.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for LLM MCP Integration |
| 1.1 | 2026-06-25 | LTS Engineering Team | Appendix A 도구 목록 10종 추가 (서버 상태, 카메라 CRUD, ONVIF, AI Detection); Appendix C API 엔드포인트 매핑 업데이트 |
