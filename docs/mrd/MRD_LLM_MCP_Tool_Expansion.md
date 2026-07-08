# MRD — LLM MCP Server Tool Coverage Expansion

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** MCP Tool Gap Closure — AI Config, Search, Face Gallery, ONVIF Snapshot
**Version:** 1.0
**Date:** 2026-07-08
**Author:** LTS Engineering Team

---

## 1. Executive Summary

A SRS/Design coverage review of the LTS MCP server (2026-07-08) compared the 29 MCP tools then registered in `mcp-server/create-server.js` against the REST API surface documented in `docs/srs/` and `docs/design/`. Several capabilities that already exist as REST endpoints — the YOLO model catalog, fire/smoke detection thresholds, tracker parameters, unified full-text search, face-gallery listing, and ONVIF event-time snapshots — had no corresponding MCP tool, meaning an LLM operator could not reach them without a human switching to the web dashboard.

This feature adds 6 new **read-only** MCP tools (`get_model_catalog`, `get_fire_smoke_config`, `get_tracker_config`, `search_all`, `list_face_galleries`, `get_onvif_snapshot`), bringing the catalog to 35 tools / 7 resources, and documents the gap across the project's PRD/SRS/Design/TC/RFP chain for `LLM MCP Server`.

Two further gaps identified in the same review — admin-gated capabilities (audit log, TC test results, user management) and write-oriented actions (YouTube stream lifecycle, camera network discovery trigger, face enrollment) — are explicitly **out of scope** for this pass; see §7.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| An LLM operator cannot check which YOLO model is active, or switch/monitor a download, without the web dashboard | Breaks the "operate LTS entirely through the LLM" value proposition the MCP server was built for |
| Fire/smoke and tracker tuning values are invisible to the LLM | An operator asking "why do we get so many false loitering alerts" cannot get the tracker's own IoU/process-noise parameters as a starting point for diagnosis |
| No single-call search tool | Free-text questions ("find anything about the guy in the red jacket") required manually chaining `query_analysis_events` + `get_active_alerts` + `get_object_snapshots`, each with different filter shapes |
| No visibility into face galleries | `search_person`/`query_face_trajectories` assume the caller already knows a gallery exists; there was no way to list what's configured or audit enrollment counts |
| ONVIF events could be queried but not visually verified | `query_onvif_events` returns metadata only; confirming what a fire/motion alarm actually looked like required the dashboard's ONVIF timeline UI |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Operator (via LLM) | Wants a single natural-language interface for triage, search, and diagnosis without switching to the dashboard |
| AI / DevOps Engineer | Uses the LLM to check which detection model and thresholds are live before troubleshooting a pipeline issue |
| Security Manager | Uses `search_all` / `list_face_galleries` for audit and reporting conversations with the LLM |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | The LLM must be able to retrieve the YOLO model catalog (variants, benchmarks, download status, active model) without a dashboard visit |
| BR-02 | The LLM must be able to read (not necessarily write, this pass) fire/smoke detection thresholds and tracker parameters |
| BR-03 | The LLM must be able to run one unified free-text search across alerts, detections, faces, events, and cross-camera match history in a single tool call |
| BR-04 | The LLM must be able to list configured face galleries and their enrollment counts before calling `search_person` or `query_face_trajectories` |
| BR-05 | The LLM must be able to retrieve the camera frame captured at the moment a specific ONVIF event fired, for visual verification |
| BR-06 | New tools must follow the existing MCP tool conventions exactly: Zod input schema, `{ content, isError? }` return shape, registered in `TOOL_CATALOG` with an `access` tag, and covered by unit tests in `mcp-server/test/tools.test.js` |
| BR-07 | Admin-gated REST routes (`/admin/*`) must NOT be wrapped as MCP tools until the MCP server has a way to authenticate as a service account — `LTSClient` currently sends no Authorization header at all |

---

## 5. Success Metrics

- All 6 new tools return `isError: true` (not an unhandled exception) when the LTS server is unreachable or the underlying REST route 404s (e.g. `get_model_catalog` against a streaming-mode server)
- `TOOL_CATALOG` count matches the actual number of `server.tool()` registrations performed by `createServer()` (verified by test)
- Zero new tools call an `/admin/*` route

---

## 6. Known Issues — Resolved

| Date | Issue | Resolution |
|---|---|---|
| 2026-07-08 | `mcp-server/test/tools.test.js` asserted `TOOL_CATALOG.length === 10` and `RESOURCE_CATALOG.length === 4` — both counts had been stale since the v1.1 extended-tools bump (actual was already 29/7 before this feature's 6 additions), so the test suite could never have caught a `TOOL_CATALOG` / `createServer()` registration mismatch. | Updated assertions to the current counts (35 tools / 7 resources) and added a "no duplicate tool names" check. See `mcp-server/test/tools.test.js`. |
| 2026-07-08 | `docs/srs/SRS_LLM_MCP_Server.md`'s version header read `1.1` while its own Document History table already recorded a `1.2` entry (query_face_trajectories, added 2026-06-25) — the header had never been bumped when that entry was added. | Corrected header to `1.3` alongside this feature's own additions, rather than leaving the pre-existing header/history mismatch in place. |
| 2026-07-08 | Six REST endpoints (`/api/analysis/models`, `/api/analysis/config/fire-smoke`, `/api/tracker/config`, `/api/search`, `/api/galleries`, `/api/onvif-snapshots`) existed in the codebase with no MCP tool, SRS FR, PRD tool reference, Design module-design entry, or TC test case — i.e. a capability documented nowhere in the MCP-facing SDLC chain despite being fully implemented server-side. | Closed via this feature: 6 new tools + SRS §10d (FR-MCP-120~125) + PRD §7c + Design §6.13~6.15 + TC §17b (Group P, TC-P-001~012) + this MRD. |

---

## 7. Out of Scope

- Admin-gated MCP tools (audit log, TC test results, user approval workflow) — blocked on `LTSClient` gaining a service-account credential and the `/admin/*` routes accepting it; tracked as a follow-up, not part of this feature
- Write-oriented tools identified in the same review — YouTube stream lifecycle (`add_youtube_stream` etc.), camera network discovery trigger (`discover_cameras`), model hot-swap (`switch_detection_model`), face enrollment (multipart photo upload does not map cleanly to an MCP tool call) — deferred to a future proposal once the read-only tools in this feature have been validated in use
- Backfilling the pre-existing SRS/PRD/Design/TC documentation gaps for tools added in v1.1/v1.2 (e.g. `query_face_trajectories`'s missing PRD §7 entry, the SRS §12.1 REST-mapping table's missing rows for `get_server_status`/camera-CRUD/ONVIF/detection tools) — flagged during the same review but out of scope for this specific tool-addition pass; each doc's Document History notes where the gap remains

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-08 | 초기 작성 — SRS/Design 커버리지 점검 결과에 따른 MCP 도구 6종 추가(get_model_catalog, get_fire_smoke_config, get_tracker_config, search_all, list_face_galleries, get_onvif_snapshot) 기록 |
