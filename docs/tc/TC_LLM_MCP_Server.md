# TEST CASES (TC)
# LLM/MCP Server Integration

| | |
|---|---|
| **Document ID** | TC-LTS-MCP-01 |
| **Version** | 1.3 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent SRS** | srs/SRS_LLM_MCP_Server.md |
| **Test Scripts** | test/api/mcp_server.test.js, test/api/mcp_server_extended.test.js, mcp-server/test/tools.test.js, mcp-server/test/lts-client.test.js |

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
| FR-MCP-070 | TC-J-001, TC-J-002, TC-J-003 |
| FR-MCP-080 | TC-K-001 |
| FR-MCP-081 | TC-K-002, TC-K-006 |
| FR-MCP-082 | TC-K-004, TC-K-005 |
| FR-MCP-083 | TC-K-003 |
| FR-MCP-090 | TC-L-001, TC-L-002, TC-L-003, TC-L-005 |
| FR-MCP-091 | TC-L-004 |
| FR-MCP-100 | TC-M-001, TC-M-002, TC-M-003 |
| FR-MCP-101 | TC-M-004, TC-M-005 |
| FR-MCP-102 | TC-M-006 |
| FR-MCP-110 | TC-O-001, TC-O-002, TC-O-003, TC-O-004, TC-O-005, TC-O-006 |
| FR-MCP-120 | TC-P-001 |
| FR-MCP-121 | TC-P-002, TC-P-003 |
| FR-MCP-122 | TC-P-004, TC-P-005, TC-P-012 |
| FR-MCP-123 | TC-P-006, TC-P-007, TC-P-012 |
| FR-MCP-124 | TC-P-008, TC-P-009, TC-P-012 |
| FR-MCP-125 | TC-P-010, TC-P-011 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `LTS_BASE_URL=http://localhost:3080` | MCP server target |
| Sample loitering event fixture | Tool response tests |
| Zone fixture with dwell threshold | `update_zone_threshold` test |
| `MCP_AUTH_TOKEN=test-token` | Auth tests |

---

## 2. Test Environment and Prerequisites

- LTS server running on `http://localhost:3080`
- MCP server started with `LTS_BASE_URL=http://localhost:3080`
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

## 12. Test Group J — System Tools (Extended v1.1)

### TC-J-001 — get_server_status Basic

- **SRS:** FR-MCP-070
- **Steps:** Call `get_server_status({ includeMetrics: false })`
- **Expected:** Content array returned; text contains "Status", "Mode", or "Uptime" keywords; `isError` not set

### TC-J-002 — get_server_status with Metrics

- **SRS:** FR-MCP-070
- **Steps:** Call `get_server_status({ includeMetrics: true })`
- **Expected:** Text contains metrics section or "(Metrics unavailable — admin access required)" fallback

### TC-J-003 — get_server_status No Error on Success

- **SRS:** FR-MCP-070
- **Steps:** Call `get_server_status({})` with LTS server running
- **Expected:** `isError` is `undefined` or `false`

---

## 13. Test Group K — Camera CRUD Tools (Extended v1.1)

### TC-K-001 — add_camera Success

- **SRS:** FR-MCP-080
- **Steps:** Call `add_camera({ name: '[MCP-TEST] temp-cam-ext', url: 'rtsp://192.0.2.1:554/test', type: 'rtsp', aiEnabled: false })`
- **Expected:** `isError` not set; response text contains camera ID (8+ hex chars after "ID:")

### TC-K-002 — update_camera Name

- **SRS:** FR-MCP-081
- **Steps:** Call `update_camera({ cameraId: <id from K-001>, name: '[MCP-TEST] renamed-cam' })`
- **Expected:** `isError` not set; success message returned

### TC-K-003 — toggle_camera_ai Enable

- **SRS:** FR-MCP-083
- **Steps:** Call `toggle_camera_ai({ cameraId: <id from K-001>, enabled: true })`
- **Expected:** Response text contains "enabled" or "disabled"

### TC-K-004 — delete_camera Success

- **SRS:** FR-MCP-082
- **Steps:** Call `delete_camera({ cameraId: <id from K-001> })`
- **Expected:** `isError` not set; deletion confirmed

### TC-K-005 — delete_camera Nonexistent

- **SRS:** FR-MCP-082
- **Steps:** Call `delete_camera({ cameraId: 'nonexistent-cam-00000000' })`
- **Expected:** `isError: true` OR response text contains "error" or "not found"

### TC-K-006 — update_camera No Fields

- **SRS:** FR-MCP-081
- **Steps:** Call `update_camera({ cameraId: 'any-id' })` — no other fields
- **Expected:** Response text contains "No fields to update"

---

## 14. Test Group L — ONVIF Event Tools (Extended v1.1)

### TC-L-001 — query_onvif_events Basic

- **SRS:** FR-MCP-090
- **Steps:** Call `query_onvif_events({ limit: 10 })`
- **Expected:** content is array; first element text is string; `isError` not set

### TC-L-002 — query_onvif_events Type Filter

- **SRS:** FR-MCP-090
- **Steps:** Call `query_onvif_events({ type: 'motionAlarm', limit: 5 })`
- **Expected:** `isError` not set; returns results or "No ONVIF events found" message

### TC-L-003 — query_onvif_events Time Range

- **SRS:** FR-MCP-090
- **Steps:** Call with `from` = 24h ago ISO8601, `to` = now ISO8601
- **Expected:** `isError` not set

### TC-L-004 — get_onvif_event_types Registry

- **SRS:** FR-MCP-091
- **Steps:** Call `get_onvif_event_types({})`
- **Expected:** content is array; text is string; `isError` not set

### TC-L-005 — query_onvif_events RuleName Filter Miss

- **SRS:** FR-MCP-090
- **Steps:** Call `query_onvif_events({ ruleName: '__no_such_rule__', limit: 20 })`
- **Expected:** `isError` not set; "No ONVIF events found" returned (not an error)

---

## 15. Test Group M — AI Detection Tools (Extended v1.1)

### TC-M-001 — query_analysis_events Basic

- **SRS:** FR-MCP-100
- **Steps:** Call `query_analysis_events({ limit: 10 })`
- **Expected:** content is array; text is string

### TC-M-002 — query_analysis_events Loitering Filter

- **SRS:** FR-MCP-100
- **Steps:** Call `query_analysis_events({ type: 'loitering', limit: 10 })`
- **Expected:** `isError` not set

### TC-M-003 — query_analysis_events Fire Filter

- **SRS:** FR-MCP-100
- **Steps:** Call `query_analysis_events({ type: 'fire', limit: 10 })`
- **Expected:** `isError` not set

### TC-M-004 — get_detection_tracks Basic

- **SRS:** FR-MCP-101
- **Steps:** Call `get_detection_tracks({ limit: 10 })`
- **Expected:** content is array; text is string

### TC-M-005 — get_detection_tracks inProgressOnly

- **SRS:** FR-MCP-101
- **Steps:** Call `get_detection_tracks({ inProgressOnly: true, limit: 10 })`
- **Expected:** `isError` not set; only tracks with `inProgress: true` returned (or empty message)

### TC-M-006 — get_analysis_metrics

- **SRS:** FR-MCP-102
- **Steps:** Call `get_analysis_metrics({})`
- **Expected:** content is array; text is string (may return error if not in analysis mode — acceptable)

---

## 16. Test Group N — TOOL_CATALOG Completeness

### TC-N-catalog — All New Tools in Catalog

- **SRS:** FR-MCP-070 ~ FR-MCP-102, FR-MCP-110
- **Steps:** Import `TOOL_CATALOG` from `create-server.js`; check for all 11 new tool names
- **Expected:** `get_server_status`, `add_camera`, `update_camera`, `delete_camera`, `toggle_camera_ai`, `query_onvif_events`, `get_onvif_event_types`, `query_analysis_events`, `get_detection_tracks`, `get_analysis_metrics`, `query_face_trajectories` — all present in catalog

### TC-N-access-tags — Access Tags

- **Steps:** Iterate TOOL_CATALOG; check each entry has `access === 'read'` or `access === 'write'`
- **Expected:** All entries have a valid access tag

---

## 17. Test Group O — Face Trajectory MCP Tool (v1.2)

### TC-O-001 — query_face_trajectories 기본 응답

- **SRS:** FR-MCP-110
- **Steps:** Call `query_face_trajectories({})` via MockMcpServer; mock `GET /api/analysis/face-trajectories` returns `{ trajectories: [], total: 0 }`
- **Expected:** Tool returns text `"No face trajectory records found..."` (empty result path)

### TC-O-002 — query_face_trajectories faceId 필터

- **SRS:** FR-MCP-110
- **Steps:** Call `query_face_trajectories({ faceId: 'F3' })`; mock returns 1 trajectory record with `faceId: 'F3'`
- **Expected:** Output contains `Face F3`

### TC-O-003 — query_face_trajectories cameraId 필터 전달

- **SRS:** FR-MCP-110
- **Steps:** Call `query_face_trajectories({ cameraId: 'cam-abc' })`; verify the HTTP GET request includes `?cameraId=cam-abc`
- **Expected:** Query param forwarded correctly

### TC-O-004 — query_face_trajectories limit 준수

- **SRS:** FR-MCP-110
- **Steps:** Call `query_face_trajectories({ limit: 10 })`; mock returns 5 records
- **Expected:** Output shows 5 records; `Found 5 face trajectory record(s)`

---

## 17b. Test Group P — Config / Search / Face Gallery / ONVIF Snapshot Tools (v1.3)

> 2026-07-08 SRS/Design 커버리지 점검에서 추가된 6개 도구(FR-MCP-120~125)에 대한 테스트.
> 소스: `mcp-server/test/tools.test.js` (mocked unit tests, 46개 assertion) +
> `test/api/mcp_server_extended.test.js` Group P (live-server integration, 12개 케이스).

### TC-P-001 — get_model_catalog 텍스트 반환

- **SRS:** FR-MCP-120
- **Steps:** Mock `GET /api/analysis/models` → `{ activeFile, catalog: [...] }`; call `get_model_catalog({})`
- **Expected:** 활성 모델 파일명과 각 모델 status(ACTIVE/downloaded/not downloaded)가 텍스트에 포함됨

### TC-P-002 — get_fire_smoke_config 임계값 반환

- **SRS:** FR-MCP-121
- **Steps:** Mock `{ confThreshold: 0.35, nmsThreshold: 0.45, available: true }`; call `get_fire_smoke_config({})`
- **Expected:** 출력에 `confThreshold`/`nmsThreshold` 값 포함

### TC-P-003 — get_fire_smoke_config 서비스 미로드

- **SRS:** FR-MCP-121
- **Steps:** Mock `{ available: false }`; call `get_fire_smoke_config({})`
- **Expected:** "not loaded" 안내 메시지 반환, `isError` 미설정

### TC-P-004 — get_tracker_config 전체 조회

- **SRS:** FR-MCP-122
- **Steps:** Mock `{ data: { maxAge: 90, iouThreshold: 0.25 } }`; call `get_tracker_config({})`
- **Expected:** 모든 키-값이 출력에 포함

### TC-P-005 — get_tracker_config 단일 키 조회

- **SRS:** FR-MCP-122
- **Steps:** Call `get_tracker_config({ key: 'iouThreshold' })`
- **Expected:** 출력이 정확히 `"iouThreshold = 0.25"`

### TC-P-006 — search_all 혼합 결과 포맷팅

- **SRS:** FR-MCP-123
- **Steps:** Mock `/api/search` 응답에 `_type: 'detection'`과 `_type: 'alert'` 레코드 포함; call `search_all({ q: '...' })`
- **Expected:** 출력에 `[detection]`, `[alert]`, `OPEN`(미확인 알림) 라벨 포함

### TC-P-007 — search_all 결과 없음

- **SRS:** FR-MCP-123
- **Steps:** Mock `{ total: 0, results: [] }`; call `search_all({ q: 'nothing' })`
- **Expected:** "No results" 메시지 반환

### TC-P-008 — list_face_galleries 전체 목록

- **SRS:** FR-MCP-124
- **Steps:** Mock 2개 갤러리(VIP, Watchlist) 반환; call `list_face_galleries({})`
- **Expected:** 두 갤러리 이름 모두 출력에 포함

### TC-P-009 — list_face_galleries 타입 필터

- **SRS:** FR-MCP-124
- **Steps:** Call `list_face_galleries({ type: 'vip' })`
- **Expected:** VIP만 포함, Watchlist(blocklist)는 제외

### TC-P-010 — get_onvif_snapshot 이미지 콘텐츠 반환

- **SRS:** FR-MCP-125
- **Steps:** Mock snapshot에 `frameData: 'data:image/jpeg;base64,AAAA'` 포함; call `get_onvif_snapshot({})`
- **Expected:** `content` 배열에 `type: 'image'`, `data: 'AAAA'` (data URL 접두어 제거됨) 블록 존재

### TC-P-011 — get_onvif_snapshot 결과 없음

- **SRS:** FR-MCP-125
- **Steps:** Mock `{ total: 0, snapshots: [] }`; call `get_onvif_snapshot({})`
- **Expected:** "No ONVIF snapshots" 메시지 반환

### TC-P-012 — REST 통합: /api/tracker/config, /api/galleries, /api/search (live server)

- **SRS:** FR-MCP-122, FR-MCP-123, FR-MCP-124
- **Steps:** `GET /api/tracker/config`, `GET /api/galleries`, `GET /api/search?q=...` (HTTP 200 기대), `GET /api/search` 파라미터 없이 호출 (HTTP 400 기대)
- **Expected:** 모든 엔드포인트가 예상 상태 코드와 스키마(`success`/`data`/`results` 배열)로 응답

---

## 18. Test Execution Order (v1.3)

```
[Suite 1 — mcp_server.test.js]
Group A (startup) → Group B (loitering) → Group C (alerts) → Group D (camera/zone) → Group E (analytics) → Group F (resources) → Group G (HTTP SSE) → Group H (security) → Group I (stats dashboard)

[Suite 2 — mcp_server_extended.test.js]
Group J (system) → Group K (camera CRUD) → Group L (ONVIF events) → Group M (AI detections) → Group N (catalog) → Group O (face trajectories) → Group P (config/search/face gallery/onvif snapshot)

[Suite 3 — mcp-server/test/*.test.js (mocked unit tests, run via `node --test`)]
tools.test.js (46 assertions incl. Group P equivalents) → lts-client.test.js
```

---

## 19. Pass/Fail Criteria (v1.3)

| Category | Pass Condition |
|---|---|
| Startup | 35 tools + 7 resources registered; transport selection correct |
| System Tool | `get_server_status` returns status text; `isError` not set on success |
| Camera CRUD | add/update/delete/toggle all succeed on valid inputs; error returned for invalid IDs |
| ONVIF Tools | `query_onvif_events`, `get_onvif_event_types`, `get_onvif_snapshot` return text; no crash on empty results or bad filters |
| Detection Tools | All three tools return text content; `get_analysis_metrics` gracefully handles non-analysis mode |
| Face Trajectory Tool | `query_face_trajectories` returns trajectory records; empty result handled gracefully |
| Config/Search/Gallery Tools (v1.3) | `get_model_catalog`/`get_fire_smoke_config` degrade gracefully outside combined/analysis mode; `get_tracker_config` supports single-key lookup; `search_all` requires `q`; `list_face_galleries` supports type filter |
| Catalog | All 35 tools present with valid access tags; no duplicate names |
| Error handling | `isError: true` on failures; no unhandled exceptions |
| Security | Auth token enforced on HTTP transport; RTSP credentials masked in `add_camera` response; admin-gated routes (audit log, TC results) intentionally NOT exposed as MCP tools (no service-account credential) |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for LLM MCP Server |
| 1.1 | 2026-06-25 | LTS Engineering Team | Groups J~N 추가 (확장 도구 v1.1): System, Camera CRUD, ONVIF, AI Detections, Catalog (FR-MCP-070~102 추적); TC-LTS-MCP-02 연계 |
| 1.2 | 2026-06-25 | LTS Engineering Team | Group O 추가 (TC-O-001~O-004) — query_face_trajectories (FR-MCP-110); §18 실행 순서·§19 Pass/Fail 기준 업데이트 |
| 1.3 | 2026-07-08 | LTS Engineering Team | §17b Group P 추가 (TC-P-001~012) — get_model_catalog/get_fire_smoke_config/get_tracker_config/search_all/list_face_galleries/get_onvif_snapshot (FR-MCP-120~125); mcp-server/test/tools.test.js·test/api/mcp_server_extended.test.js 양쪽에 테스트 구현; §1.2 트레이서빌리티에 FR-MCP-110/120~125 행 추가(기존 누락분 포함); §18/§19를 35 tools/7 resources 기준으로 갱신 |
