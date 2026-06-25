# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# LLM MCP Server

| | |
|---|---|
| **Document ID** | SRS-LTS-MCP-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-06-25 |
| **Parent PRD** | prd/PRD_LLM_MCP_Server.md |
| **Parent RFP** | rfp/RFP_LLM_MCP_Integration.md |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Server Lifecycle](#3-functional-requirements--server-lifecycle)
4. [Functional Requirements — Tool: Loitering Events](#4-functional-requirements--tool-loitering-events)
5. [Functional Requirements — Tool: Alert Management](#5-functional-requirements--tool-alert-management)
6. [Functional Requirements — Tool: Camera & Zone](#6-functional-requirements--tool-camera--zone)
7. [Functional Requirements — Tool: Analytics & Reports](#7-functional-requirements--tool-analytics--reports)
8. [Functional Requirements — Tool: Stats Dashboard](#8-functional-requirements--tool-stats-dashboard)
9. [Functional Requirements — Resources](#9-functional-requirements--resources)
10. [Functional Requirements — HTTP/SSE Transport](#10-functional-requirements--httpsse-transport)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Interface Requirements](#12-interface-requirements)
13. [Constraints & Assumptions](#13-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the **LTS-2026 LLM MCP Server** — a Model Context Protocol adapter that exposes the LTS-2026 Loitering Tracking System to Large Language Model clients. Each requirement is identified by a unique ID (FR-MCP-NNN) traceable to test cases in TC_LLM_MCP_Server.md.

### 1.2 Scope

This document covers:

- Server initialization and transport configuration (stdio and HTTP/SSE)
- Ten registered MCP tools covering event querying, alert management, camera monitoring, and analytics
- Four MCP resources (cameras, active alerts, zone config, system summary)
- Error handling, input validation, and partial-failure degradation
- Integration with Claude Code (stdio) and OpenAI Agents (HTTP/SSE)

Out of scope: real-time video delivery via MCP, LLM inference within the server, user authentication for stdio transport, alert creation, camera add/delete.

### 1.3 Definitions

| Term | Definition |
|---|---|
| MCP | Model Context Protocol — open protocol for LLM tool and resource access |
| Tool | An MCP-registered function callable by an LLM with schema-validated inputs |
| Resource | A read-only URI-addressed data source accessible to an LLM via MCP |
| stdio transport | Process-level MCP communication via stdin/stdout (Claude Code) |
| SSE transport | HTTP Server-Sent Events MCP communication (OpenAI Agents) |
| LTS API | The LTS-2026 Express REST API running on port 3080 |
| Zod | TypeScript-first schema validation library used for tool input schemas |
| `isError` | MCP response field indicating a tool-level error occurred |

---

## 2. System Overview

### 2.1 Component Context

```
┌─────────────────────────────────────────────────────────┐
│                  MCP Client Layer                        │
│   Claude Code │ Claude API │ OpenAI Agents │ ChatGPT    │
└───────────────────────────┬─────────────────────────────┘
                            │  MCP Protocol
                            │  (stdio / HTTP SSE)
┌───────────────────────────▼─────────────────────────────┐
│              LTS MCP Server  (Node.js ESM)               │
│                                                          │
│  create-server.js  — McpServer factory                   │
│  index.js          — transport setup (stdio / http)      │
│  lts-client.js     — HTTP wrapper for LTS REST API       │
│  tools/            — loitering, alerts, cameras,         │
│                       analytics                          │
│  resources.js      — lts:// URI handlers                 │
└───────────────────────────┬─────────────────────────────┘
                            │  HTTP REST (fetch)
┌───────────────────────────▼─────────────────────────────┐
│             LTS-2026 Express API  (:3001)                │
│   /api/cameras  /api/events  /api/alerts  /api/zones    │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Key Design Constraints

- The MCP server is **stateless** — all state lives in the LTS REST API.
- stdout is reserved for MCP protocol messages; all diagnostic logs go to **stderr**.
- Write operations are limited to `acknowledge_alert` and `update_zone_threshold`.
- All LTS API calls use `fetch()` with an 8-second `AbortSignal.timeout`.

---

## 3. Functional Requirements — Server Lifecycle

### FR-MCP-001 — Startup

On process start (`node mcp-server/index.js`):
- The server shall read `LTS_BASE_URL` from the environment (default `http://localhost:3080`).
- A `McpServer` instance shall be created with name `lts-mcp-server`, version `1.0.0`.
- All 11 tools and 5 resources shall be registered before transport connection.
- The server shall log `[LTS MCP] stdio server running — connected to {LTS_BASE_URL}` to **stderr** (not stdout).

### FR-MCP-002 — Transport Selection

The transport mode shall be determined by the `TRANSPORT` environment variable:
- `TRANSPORT=stdio` (default) — connects `StdioServerTransport`.
- `TRANSPORT=http` — starts HTTP/SSE Express server on `MCP_PORT` (default 3002).

### FR-MCP-003 — Environment Variable Configuration

| Variable | Default | Description |
|---|---|---|
| `LTS_BASE_URL` | `http://localhost:3080` | LTS REST API base URL |
| `TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_PORT` | `3002` | HTTP/SSE server listen port |
| `MCP_AUTH_TOKEN` | _(none)_ | Bearer token for HTTP transport (empty = no auth) |
| `MCP_PUBLIC_URL` | `http://localhost:{MCP_PORT}` | Public base URL for `/schema` responses |

### FR-MCP-004 — Error Response Convention

All tool errors shall return:
```json
{ "content": [{ "type": "text", "text": "Error: <message>" }], "isError": true }
```
Network failures shall produce: `"Error: LTS API <status>: <statusText>: <body>"`.

---

## 4. Functional Requirements — Tool: Loitering Events

### FR-MCP-010 — `query_loitering_events`

- **Description**: Query loitering detection events with optional filters.
- **Input Schema** (all optional):
  - `cameraId` (string) — filter by camera ID
  - `from` (string, ISO 8601) — start time filter
  - `to` (string, ISO 8601) — end time filter
  - `minDwellSec` (number) — minimum dwell time in seconds
  - `limit` (integer 1–100, default 20) — max results
- **Behavior**:
  - Calls `GET /api/events` with query params `{ limit: 200, cameraId?, from?, to? }`.
  - Applies `minDwellSec` filter client-side after retrieval.
  - Returns at most `limit` results.
- **Success Output**: `"Found N loitering event(s):\n\nEvent ID: ...\n  Camera: ...\n  Zone: ...\n  Object ID: ...\n  Dwell Time: ...s\n  Start Time: ..."`
- **Empty Output**: `"No loitering events found for the specified filters."`
- **Error**: Returns `isError: true` with message on LTS API failure.

### FR-MCP-011 — `get_tracking_history`

- **Description**: Return the full appearance history for a specific tracked object.
- **Input Schema**:
  - `objectId` (string, required) — the track ID to look up
  - `cameraId` (string, optional) — restrict to a specific camera
- **Behavior**:
  - Calls `GET /api/events?limit=200` (with optional `cameraId`).
  - Filters events where `event.objectId === objectId`.
  - Aggregates: total dwell time, unique cameras, unique zones, first/last seen timestamps.
- **Success Output**: Multi-line text with Appearances, Total Dwell Time, Cameras seen, Zones visited, First seen, Last seen.
- **Not-found Output**: `"No tracking history found for object ID: {objectId}"`

---

## 5. Functional Requirements — Tool: Alert Management

### FR-MCP-020 — `get_active_alerts`

- **Description**: List current unacknowledged loitering alerts.
- **Input Schema** (all optional):
  - `cameraId` (string) — camera filter
  - `limit` (integer 1–50, default 10) — max results
- **Behavior**:
  - Calls `GET /api/alerts?acknowledged=false&limit=100`.
  - Applies optional `cameraId` filter.
  - Returns the most recent `limit` results.
- **Success Output**: `"N active alert(s):\n\nAlert ID: ...\n  Type: LOITERING\n  Camera: ...\n  Zone: ...\n  Dwell Time: ...s\n  Time: ..."`
- **Empty Output**: `"No active alerts at this time. All clear."`

### FR-MCP-021 — `explain_alert`

- **Description**: Comprehensive contextual explanation of a specific alert.
- **Input Schema**:
  - `alertId` (string, required) — Alert UUID
- **Behavior**:
  - Fetches all alerts from `GET /api/alerts?limit=1000` and finds by `id`.
  - Returns `isError: true` with `"Alert not found: {alertId}"` if not found.
  - In parallel (`Promise.allSettled`): fetches camera list, all events (for object history), and zone config for the alert's camera.
  - Computes risk level:
    - `HIGH` if `isNight && isRepeat`
    - `MEDIUM` if `isNight || isRepeat || dwellRatio > 2`
    - `LOW` otherwise
  - Where: `isNight = hour >= 22 || hour < 6`, `isRepeat = objectHistory.length > 3`, `dwellRatio = alert.dwellTime / zone.dwellThreshold`
  - Zone details degrade gracefully to `"Zone details unavailable"` on sub-call failure.
  - Object history degrades gracefully to `"First recorded occurrence"` if no prior events found.
- **Success Output**: Markdown report with sections: Alert Explanation, Incident Details, Zone Configuration, Object History, Risk Assessment.

### FR-MCP-022 — `acknowledge_alert`

- **Description**: Mark an alert as acknowledged.
- **Input Schema**:
  - `alertId` (string, required) — Alert UUID
- **Behavior**: Calls `POST /api/alerts/{alertId}/acknowledge`.
- **Success Output**: `"Alert {alertId} has been acknowledged."`
- **Error**: Returns `isError: true` on API failure (including 404).

---

## 6. Functional Requirements — Tool: Camera & Zone

### FR-MCP-030 — `get_camera_status`

- **Description**: List cameras with pipeline running state and AI status.
- **Input Schema** (all optional):
  - `cameraId` (string) — retrieve a single camera
- **Behavior**:
  - Calls `GET /api/cameras`.
  - If `cameraId` is supplied, filters to just that camera.
  - Formats status as running/stopped and AI enabled/disabled.
- **Success Output**: Multi-line text with running count summary and per-camera: name, ID, type, status, AI flag.

### FR-MCP-031 — `get_zone_config`

- **Description**: Return zone polygon, threshold, target classes, and schedule for a camera.
- **Input Schema**:
  - `cameraId` (string, required) — Camera UUID
- **Behavior**:
  - Calls `GET /api/cameras/{cameraId}/zones`.
  - Returns `"No zones configured for camera: {cameraId}"` if result is empty.
- **Success Output**: Per-zone: name, ID, type, dwell threshold, polygon vertex count, target classes, schedule.

### FR-MCP-032 — `update_zone_threshold`

- **Description**: Update the dwell time threshold for a monitoring zone.
- **Input Schema**:
  - `cameraId` (string, required)
  - `zoneId` (string, required)
  - `dwellThreshold` (integer 5–3600, required)
- **Behavior**: Calls `PUT /api/cameras/{cameraId}/zones/{zoneId}` with `{ dwellThreshold }`.
- **Success Output**: `"Zone {name} threshold updated to {N}s."`
- **Validation**: Zod enforces `dwellThreshold` range 5–3600 at protocol level; values outside range fail before handler invocation.

---

## 7. Functional Requirements — Tool: Analytics & Reports

### FR-MCP-040 — `get_analytics_summary`

- **Description**: Statistical summary of events and alerts for a time window.
- **Input Schema** (all optional):
  - `from` (string, ISO 8601) — default 24 hours ago
  - `to` (string, ISO 8601) — default now
  - `cameraId` (string) — optional camera filter
- **Behavior**:
  - Calls `GET /api/events` and `GET /api/alerts` in parallel.
  - Computes: total events, average dwell time, maximum dwell time, peak hour (0–23), busiest camera, total alerts, acknowledged count, active (unacknowledged) count, alerts grouped by zone.
- **Success Output**: Markdown with sections: Analytics Summary (period), Events, Alerts, Alerts by Zone.

### FR-MCP-041 — `generate_security_report`

- **Description**: Full markdown security report for shift handovers or management review.
- **Input Schema**:
  - `from` (string, ISO 8601, required) — report start
  - `to` (string, ISO 8601, required) — report end
  - `cameraId` (string, optional)
- **Behavior**:
  - Calls `GET /api/events`, `GET /api/alerts`, `GET /api/cameras` in parallel.
  - Filters events/alerts to the `from`–`to` window client-side.
  - Includes up to 20 incidents in the log.
  - Generates recommendations based on: unacknowledged alert ratio, average dwell vs. threshold, peak hour patterns.
- **Success Output**: Markdown with sections: Security Report header, Executive Summary, Incident Log (up to 20), Key Metrics table, Recommendations.

---

## 8. Functional Requirements — Tool: Stats Dashboard

### FR-MCP-042 — `get_stats_dashboard`

- **Description**: Return a comprehensive real-time snapshot of the entire LTS-2026 system, equivalent to reading the Stats Dashboard Panel in the web UI.
- **Input Schema**: None (no parameters required).
- **Behavior**:
  - Calls `GET /api/stats` (single HTTP request).
  - Returns formatted markdown with sections: Cameras, Detection Events, Alerts, Zones, Face ID.
  - Includes 7-day event trend if `data.events.last7days` is present.
  - Includes per-severity alert breakdown if `data.alerts.bySeverity` is present.
- **Success Output**: Markdown report with header `## LTS-2026 Stats Dashboard`, generated timestamp, storage mode, and all sub-sections.
- **Error**: Returns `isError: true` with message on LTS API failure or empty `data`.

---

## 9. Functional Requirements — Resources

### FR-MCP-050 — `lts://cameras` Resource

- **URI**: `lts://cameras`
- **MIME Type**: `application/json`
- **Behavior**: Calls `GET /api/cameras`; returns the full JSON array of `LTSCamera` objects including `pipelineStatus`.
- **On-demand**: No caching; fetches fresh data on every resource read.

### FR-MCP-051 — `lts://alerts/active` Resource

- **URI**: `lts://alerts/active`
- **MIME Type**: `application/json`
- **Behavior**: Calls `GET /api/alerts?acknowledged=false&limit=50`; returns JSON array of unacknowledged `LTSAlert` objects.

### FR-MCP-052 — `lts://zones/{cameraId}` Resource

- **URI**: `lts://zones/{cameraId}` (resource template)
- **MIME Type**: `application/json`
- **Behavior**: Calls `GET /api/cameras/{cameraId}/zones`; returns JSON array of `LTSZone` objects for the specified camera.
- **Template parameter**: `cameraId` (string, required)

### FR-MCP-053 — `lts://system/summary` Resource

- **URI**: `lts://system/summary`
- **MIME Type**: `application/json`
- **Behavior**:
  - Calls `GET /api/cameras`, `GET /api/alerts?acknowledged=false&limit=100`, `GET /api/events?limit=100` via `Promise.allSettled`.
  - Computes and returns a JSON object:
    ```json
    {
      "timestamp": "<ISO>",
      "cameras":  { "total": N, "running": N, "aiEnabled": N },
      "alerts":   { "active": N, "oldest": "<ISO> | null" },
      "events":   { "recent100Count": N, "avgDwellSec": N }
    }
    ```
  - Individual sub-call failures result in zero-values for that section (no full failure).

### FR-MCP-054 — `lts://stats/dashboard` Resource

- **URI**: `lts://stats/dashboard`
- **MIME Type**: `application/json`
- **Behavior**: Calls `GET /api/stats` (single request); returns the full `StatsData` JSON object including `cameras`, `zones`, `events` (with 7-day trend), `alerts` (with severity breakdown), `faces`, and `storage`.
- **Use case**: Allows an LLM to read rich dashboard data as a resource rather than invoking a tool — suitable for context injection at session start.

---

## 10. Functional Requirements — HTTP/SSE Transport

### FR-MCP-060 — SSE Endpoint

- `GET /sse` — opens an SSE stream; creates a new `McpServer` instance per session.
- Sessions are tracked in a `Map<sessionId, SSEServerTransport>`.
- On session close, the entry is removed from the map and a log message is written to stderr.

### FR-MCP-061 — Message Endpoint

- `POST /message?sessionId=XXX` — routes a JSON-RPC message to the matching session.
- Returns `404 { error: 'Session not found' }` if `sessionId` is not in the map.

### FR-MCP-062 — Schema Endpoint

- `GET /schema` — returns a static JSON catalog:
  ```json
  { "name": "lts-mcp-server", "version": "1.0.0", "baseUrl": "<PUBLIC_BASE_URL>",
    "sseUrl": "<PUBLIC_BASE_URL>/sse", "tools": [...], "resources": [...] }
  ```

### FR-MCP-063 — Health Endpoint

- `GET /health` — returns `{ "status": "ok", "transport": "http", "ltsBaseUrl": "<LTS_BASE_URL>" }`.

### FR-MCP-064 — Bearer Authentication

- When `MCP_AUTH_TOKEN` is set, all `/sse` and `/message` requests must include `Authorization: Bearer {token}`.
- Missing or incorrect token returns `401 { "error": "Unauthorized" }`.
- When `MCP_AUTH_TOKEN` is empty, all requests pass through without authentication.

### FR-MCP-065 — CORS

- HTTP transport enables CORS for all origins on all routes.

---

## 10b. Functional Requirements — Extended Tools (v1.1)

### FR-MCP-070 — `get_server_status`

| 항목 | 내용 |
|---|---|
| 기능 | LTS 서버 상태 조회 (health check + 선택적 admin 메트릭) |
| 입력 | `includeMetrics: boolean` (선택, 기본 false) |
| 처리 | `GET /health` 호출; `includeMetrics=true` 시 `GET /admin/system` 추가 호출 |
| 출력 | Status, Mode, Version, Uptime, DB Type, Camera Count, Active Pipelines; `includeMetrics=true` 시 CPU/Memory/GPU |
| 오류 | LTS API 호출 실패 시 `isError: true` 반환 |

### FR-MCP-080 — `add_camera`

| 항목 | 내용 |
|---|---|
| 기능 | 신규 카메라 채널 등록 |
| 입력 | `name`, `url`, `type` (rtsp/youtube/webrtc), `aiEnabled`, `username?`, `password?`, `location?` |
| 처리 | `POST /api/cameras` 호출; RTSP 자격증명은 응답에서 마스킹 처리 |
| 출력 | 생성된 카메라 ID, Name, URL (자격증명 마스킹), Type, AI 상태, Location |
| 오류 | API 오류 시 `isError: true` + 에러 메시지 |

### FR-MCP-081 — `update_camera`

| 항목 | 내용 |
|---|---|
| 기능 | 기존 카메라 채널 설정 업데이트 |
| 입력 | `cameraId` (필수), `name?`, `url?`, `aiEnabled?`, `location?` |
| 처리 | 변경 필드만 body에 포함하여 `PUT /api/cameras/:id` 호출; 필드 없을 시 즉시 "No fields to update" 반환 |
| 출력 | 업데이트 성공 메시지 + 카메라 Name, AI 상태 |
| 오류 | 카메라 미존재 또는 API 오류 시 `isError: true` |

### FR-MCP-082 — `delete_camera`

| 항목 | 내용 |
|---|---|
| 기능 | 카메라 채널 삭제 및 AI 파이프라인 중지 |
| 입력 | `cameraId` (필수) |
| 처리 | `DELETE /api/cameras/:id` 호출; 비가역 작업 — LLM 호출 전 ID 확인 필요 |
| 출력 | 삭제 성공 메시지 |
| 오류 | 미존재 ID 또는 API 오류 시 `isError: true` |

### FR-MCP-083 — `toggle_camera_ai`

| 항목 | 내용 |
|---|---|
| 기능 | 카메라 AI 추론 파이프라인 활성화/비활성화 (스트림 중단 없이) |
| 입력 | `cameraId` (필수), `enabled: boolean` (필수) |
| 처리 | `POST /api/cameras/:id/ai/toggle` 호출 |
| 출력 | AI enabled/disabled 상태 확인 메시지 |
| 오류 | API 오류 시 `isError: true` |

### FR-MCP-090 — `query_onvif_events`

| 항목 | 내용 |
|---|---|
| 기능 | ONVIF 메타데이터 이벤트 조회 (움직임감지, 화재, 라인크로싱, 오디오 알람 등) |
| 입력 | `cameraId?`, `type?`, `severity?`, `from?`, `to?`, `limit (1-200, 기본 50)?`, `ruleName?` |
| 처리 | `GET /api/onvif-events` 호출; `ruleName` 지정 시 클라이언트측 필터 적용 |
| 출력 | 이벤트 목록 (타임스탬프, topicType, cameraId, severity, sourceToken, ruleName, operation) |
| 오류 | API 오류 시 `isError: true` |

### FR-MCP-091 — `get_onvif_event_types`

| 항목 | 내용 |
|---|---|
| 기능 | 시스템에서 ever-seen된 ONVIF topicType 레지스트리 전체 조회 |
| 입력 | 없음 |
| 처리 | `GET /api/onvif-event-types` 호출 |
| 출력 | topicType 목록 (label, count, severity 포함) |
| 오류 | API 오류 시 `isError: true` |

### FR-MCP-100 — `query_analysis_events`

| 항목 | 내용 |
|---|---|
| 기능 | AI 분석 이벤트(배회, 화재, 연기) 조회 |
| 입력 | `cameraId?`, `type (loitering/fire/smoke/all, 기본 all)?`, `from?`, `to?`, `limit (1-500, 기본 50)?` |
| 처리 | `GET /api/analysis/events` 호출 |
| 출력 | 이벤트 목록 (타입별 요약 헤더 포함; type, cameraId, confidence, objectId, zoneId, dwellTime) |
| 오류 | API 오류 시 `isError: true` |

### FR-MCP-101 — `get_detection_tracks`

| 항목 | 내용 |
|---|---|
| 기능 | 객체 감지 트랙 이력 조회 (연속 추적 세션별 체류 시간 포함) |
| 입력 | `cameraId?`, `objectClass?`, `from?`, `to?`, `limit (1-200, 기본 30)?`, `inProgressOnly?` |
| 처리 | `GET /api/analysis/detection-tracks` 호출; `inProgressOnly=true` 시 클라이언트측 필터 |
| 출력 | 트랙 목록 (objectId, class, cameraId, firstSeen, lastSeen, dwellTime, inProgress 플래그) |
| 오류 | API 오류 시 `isError: true` |

### FR-MCP-102 — `get_analysis_metrics`

| 항목 | 내용 |
|---|---|
| 기능 | AI 분석 서버 대시보드 메트릭 조회 |
| 입력 | 없음 |
| 처리 | `GET /api/analysis/metrics` 호출 |
| 출력 | FPS, 모델명, 큐 깊이, GPU 사용률, 클래스별 감지 수, 파이프라인 상태 |
| 오류 | analysis 모드 미활성 등 API 오류 시 `isError: true` |

---

## 11. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-MCP-01 | Performance | Read tool response time ≤ 2 s (p95) on local network |
| NFR-MCP-02 | Performance | `explain_alert` response time ≤ 3 s (3–4 parallel API calls) |
| NFR-MCP-03 | Performance | `generate_security_report` for 30-day window ≤ 5 s |
| NFR-MCP-04 | Scalability | HTTP/SSE transport shall support ≥ 10 concurrent sessions |
| NFR-MCP-05 | Memory | Process RSS shall not exceed 64 MB during normal operation |
| NFR-MCP-06 | Reliability | All tools return `isError: true` with message when LTS API is unreachable; no unhandled exceptions |
| NFR-MCP-07 | Compatibility | Server shall function with `@modelcontextprotocol/sdk` ≥ 1.0.0 and Node.js ≥ 20 (ESM) |
| NFR-MCP-08 | Security | stdout is reserved exclusively for MCP protocol messages; no diagnostic output to stdout |
| NFR-MCP-09 | Security | Secrets are passed only via environment variables; no hardcoded credentials |

---

## 12. Interface Requirements

### 12.1 LTS REST API Dependencies

| MCP Tool / Resource | LTS Endpoint |
|---|---|
| `query_loitering_events` | `GET /api/events?limit=200&cameraId?&from?&to?` |
| `get_tracking_history` | `GET /api/events?limit=200&cameraId?` |
| `get_active_alerts` | `GET /api/alerts?acknowledged=false&limit=100` |
| `explain_alert` | `GET /api/alerts?limit=1000`, `GET /api/cameras`, `GET /api/events?limit=200`, `GET /api/cameras/:id/zones` |
| `acknowledge_alert` | `POST /api/alerts/:id/acknowledge` |
| `get_camera_status` | `GET /api/cameras` |
| `get_zone_config` | `GET /api/cameras/:id/zones` |
| `update_zone_threshold` | `PUT /api/cameras/:id/zones/:zoneId` |
| `get_analytics_summary` | `GET /api/events?limit=1000`, `GET /api/alerts?limit=1000` |
| `generate_security_report` | `GET /api/events?limit=1000`, `GET /api/alerts?limit=1000`, `GET /api/cameras` |
| `lts://cameras` | `GET /api/cameras` |
| `lts://alerts/active` | `GET /api/alerts?acknowledged=false&limit=50` |
| `lts://zones/{cameraId}` | `GET /api/cameras/:id/zones` |
| `lts://system/summary` | `GET /api/cameras`, `GET /api/alerts?limit=100`, `GET /api/events?limit=100` |
| `get_stats_dashboard` | `GET /api/stats` |
| `lts://stats/dashboard` | `GET /api/stats` |
| `get_server_status` | `GET /health`, `GET /admin/system` (선택) |
| `add_camera` | `POST /api/cameras` |
| `update_camera` | `PUT /api/cameras/:id` |
| `delete_camera` | `DELETE /api/cameras/:id` |
| `toggle_camera_ai` | `POST /api/cameras/:id/ai/toggle` |
| `query_onvif_events` | `GET /api/onvif-events` |
| `get_onvif_event_types` | `GET /api/onvif-event-types` |
| `query_analysis_events` | `GET /api/analysis/events` |
| `get_detection_tracks` | `GET /api/analysis/detection-tracks` |
| `get_analysis_metrics` | `GET /api/analysis/metrics` |

### 12.2 Claude Code Integration

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
Registered in `.claude/settings.json`.

### 12.3 VS Code MCP Integration

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
Registered in `.vscode/mcp.json`.

---

## 13. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | The LTS-2026 Express server must be running on `LTS_BASE_URL` before any tool call succeeds |
| C-02 | The MCP server is a single-tenant process; no user session management or multi-tenancy |
| C-03 | All network calls use `AbortSignal.timeout(8000)` — requests exceeding 8 s are aborted |
| C-04 | The `/api/events` endpoint returns events sorted by `createdAt` descending; tools assume this ordering |
| C-05 | `acknowledge_alert` is the only alert-state write operation; alert creation is out of scope |
| C-06 | No local caching of LTS data; every tool call fetches fresh data |
| C-07 | The `package.json` must have `"type": "module"` for ESM imports to function |
| C-08 | MCP protocol stdio is not compatible with `console.log`; all logs must use `console.error` |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for LLM MCP Server |
| 1.1 | 2026-06-25 | LTS Engineering Team | §10b 확장 도구 10종 추가 (FR-MCP-070~102): get_server_status, 카메라 CRUD, ONVIF 이벤트, AI 감지 분석 |
