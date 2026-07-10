# TEST CASES (TC)
# STUN/TURN ICE Configuration & Testing

| | |
|---|---|
| **Document ID** | TC-LTS-ICE-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_STUN_TURN_ICE.md |
| **Test Scripts** | test/api/webrtc_ice.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — ICE Config Endpoint](#3-test-group-a--ice-config-endpoint)
4. [Test Group B — STUN Configuration](#4-test-group-b--stun-configuration)
5. [Test Group C — TURN Configuration](#5-test-group-c--turn-configuration)
6. [Test Group D — Client ICE Injection](#6-test-group-d--client-ice-injection)
7. [Test Group E — Phase 1: Server Pre-Check](#7-test-group-e--phase-1-server-pre-check)
8. [Test Group F — Phase 2: Browser Automation](#8-test-group-f--phase-2-browser-automation)
9. [Test Group G — Phase 3: Stats Reporting](#9-test-group-g--phase-3-stats-reporting)
10. [Test Group H — Socket.IO Trigger Protocol](#10-test-group-h--socketio-trigger-protocol)
11. [Test Group I — Performance & Security](#11-test-group-i--performance--security)
12. [Test Execution Order](#12-test-execution-order)
13. [Pass/Fail Criteria](#13-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | `GET /api/webrtc/ice-config` endpoint | Node.js fetch | `test/api/webrtc_ice.test.js` |
| Unit | Env parsing for STUN_URLS / TURN_URLS, credential parsing | Jest | `test/unit/ice_config.test.js` (Phase-2) |
| Integration | ice-test 3-phase CLI, Socket.IO trigger | Node.js child_process | `test/integration/ice_test.test.js` (Phase-2) |
| E2E | End-to-end ICE path validation | Manual with Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-ICE-001 | TC-A-001 |
| FR-ICE-002 | TC-A-002 |
| FR-ICE-003 | TC-A-003 |
| FR-ICE-004 | TC-A-004 |
| FR-ICE-010 | TC-B-001 |
| FR-ICE-011 | TC-B-002 |
| FR-ICE-020 | TC-C-001 |
| FR-ICE-021 | TC-C-002 |
| FR-ICE-022 | TC-C-003 |
| FR-ICE-030 | TC-D-001 |
| FR-ICE-031 | TC-D-002 |
| FR-ICE-032 | TC-D-003 |
| FR-ICE-040 | TC-E-001 |
| FR-ICE-041 | TC-E-002 |
| FR-ICE-042 | TC-E-003 |
| FR-ICE-050 | TC-F-001 |
| FR-ICE-051 | TC-F-002 |
| FR-ICE-052 | TC-F-003 |
| FR-ICE-053 | TC-F-004 |
| FR-ICE-054 | TC-F-005 |
| FR-ICE-060 | TC-G-001 |
| FR-ICE-061 | TC-G-002 |
| FR-ICE-062 | TC-G-003 |
| FR-ICE-063 | TC-G-004 |
| FR-ICE-070 | TC-H-001 |
| FR-ICE-071 | TC-H-002 |
| FR-ICE-072 | TC-H-003 |
| FR-ICE-080 | TC-I-001 |
| FR-ICE-081 | TC-I-002 |
| FR-ICE-082 | TC-I-003 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| `STUN_URLS=stun:stun1.example.com:3478,stun:stun2.example.com:3478` | Multi-STUN parse test |
| `TURN_URLS=turn:relay.example.com:3478?transport=udp` | Basic TURN URL |
| `TURN_USERNAME=user`, `TURN_CREDENTIAL=pass` | TURN credential test |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- `GET /health` returns `{ status: 'ok' }`
- For ice-test CLI: `node server/src/scripts/iceTest.js --url http://localhost:3080` must be executable
- For Phase-2 browser tests: Playwright installed

---

## 3. Test Group A — ICE Config Endpoint

### TC-A-001 — Endpoint Exists
- **Input:** `GET /api/webrtc/ice-config` (no auth required)
- **Expected:** HTTP 200
- **Acceptance:** 200 response; no authentication required

### TC-A-002 — Response Schema
- **Input:** `GET /api/webrtc/ice-config` with STUN configured
- **Expected:** Response body: `{ "iceServers": [ { "urls": [...], ... } ] }`
- **Acceptance:** `iceServers` array present; each item has `urls` field

### TC-A-003 — Populated STUN Entry
- **Input:** `STUN_URLS=stun:stun.example.com:3478` set; call endpoint
- **Expected:** Response includes `{ "urls": ["stun:stun.example.com:3478"] }`
- **Acceptance:** STUN URL passed through verbatim

### TC-A-004 — No ICE Servers (Defaults)
- **Input:** No `STUN_URLS`, no `TURN_URLS` set; call endpoint
- **Expected:** Response: `{ "iceServers": [] }` (empty array)
- **Acceptance:** Empty array returned (not null/undefined/error)

---

## 4. Test Group B — STUN Configuration

### TC-B-001 — STUN Role: srflx Only
- **Input:** STUN server configured; ICE negotiation in progress
- **Expected:** STUN produces `srflx` (server-reflexive) candidates only; does NOT relay media
- **Acceptance:** No `relay` candidates from STUN server

### TC-B-002 — UDP Ping (RFC 5389)
- **Input:** `GET /api/webrtc/ice-config` used to get STUN server; Phase-1 pre-check
- **Expected:** Phase-1 sends RFC 5389 UDP binding request to STUN server
- **Acceptance:** Response indicates STUN reachable; binding request/response exchange verified

---

## 5. Test Group C — TURN Configuration

### TC-C-001 — TURN Credentials Not Exposed in Logs
- **Input:** Server started with `TURN_USERNAME` and `TURN_CREDENTIAL`; inspect server stdout/stderr
- **Expected:** Credentials NOT printed to server logs
- **Acceptance:** No credential strings in any log output

### TC-C-002 — TURN URL Format
- **Input:** `TURN_URLS=turn:relay.example.com:3478?transport=udp`; call endpoint
- **Expected:** Response contains `{ "urls": "turn:relay.example.com:3478?transport=udp", "username": "...", "credential": "..." }`
- **Acceptance:** URL, username, credential all present in TURN entry

### TC-C-003 — TURN Fallback (No STUN)
- **Input:** Only TURN configured; no STUN URLs
- **Expected:** `iceServers` contains TURN entry only; no STUN entry
- **Acceptance:** Single TURN entry in response

---

## 6. Test Group D — Client ICE Injection

### TC-D-001 — useWebRTC Hook ICE Injection
- **Input:** Hook initialized; `GET /api/webrtc/ice-config` succeeds
- **Expected:** RTCPeerConnection created with fetched `iceServers` config
- **Acceptance:** `RTCPeerConnection` constructor called with correct `iceServers`

### TC-D-002 — RTCIceServer Format
- **Input:** Inspect `RTCPeerConnection` configuration
- **Expected:** Configuration matches WebRTC spec `RTCIceServer` format: `{ urls: [...], username?: string, credential?: string }`
- **Acceptance:** Spec-compliant ICE server format

### TC-D-003 — SERVER_IP Fallback Candidates
- **Input:** ICE negotiation for local network camera
- **Expected:** `SERVER_IP` env variable used as host candidate hint when external ICE fails
- **Acceptance:** Connection succeeds on local network even without STUN

---

## 7. Test Group E — Phase 1: Server Pre-Check

### TC-E-001 — Phase 1 Execution
- **Input:** Run `node iceTest.js --url http://localhost:3080`
- **Expected:** Phase 1 fetches `/api/webrtc/ice-config`; sends UDP ping to each STUN/TURN server
- **Acceptance:** Phase 1 completes and reports each server as reachable/unreachable

### TC-E-002 — STUN Pre-Check Result
- **Input:** Valid STUN server configured; Phase 1 running
- **Expected:** STUN binding request succeeds; Phase 1 marks STUN as ✅
- **Acceptance:** STUN reachable indicator in Phase 1 output

### TC-E-003 — TURN Pre-Check Result
- **Input:** TURN server configured; Phase 1 running
- **Expected:** Phase 1 verifies TURN reachability (TCP/UDP depending on URL scheme)
- **Acceptance:** TURN reachable/unreachable clearly indicated in Phase 1 output

---

## 8. Test Group F — Phase 2: Browser Automation

### TC-F-001 — Playwright ICE Gathering
- **Input:** Phase 2 of `iceTest.js` with browser automation
- **Expected:** Playwright browser opened; `addInitScript` injects ICE config before page load
- **Acceptance:** Browser opened headlessly; ICE config injected before dashboard loads

### TC-F-002 — addInitScript Injection
- **Input:** Page load with injected ICE config
- **Expected:** `window.__iceConfig` set before any page scripts run
- **Acceptance:** `window.__iceConfig` accessible from page scripts; loaded before DOMContentLoaded

### TC-F-003 — ICE Candidate Gathering
- **Input:** Browser automation with real STUN server
- **Expected:** ICE candidates gathered via `RTCPeerConnection`; at least `host` + `srflx` candidates
- **Acceptance:** Candidates gathered within adaptive timeout (≤ 60 s default)

### TC-F-004 — Adaptive Wait
- **Input:** STUN server with 3-second response time
- **Expected:** Phase 2 waits for candidate gathering completion or timeout; adapts to server latency
- **Acceptance:** Wait adapts; does not time out at fixed 1-second

### TC-F-005 — Headless Mode
- **Input:** Phase 2 running in CI environment (`CI=true`)
- **Expected:** Browser runs headless; no window displayed
- **Acceptance:** Test completes in headless mode; no display required

---

## 9. Test Group G — Phase 3: Stats Reporting

### TC-G-001 — Stats Collection
- **Input:** Phase 3 of ice-test after ICE negotiation
- **Expected:** RTCPeerConnection stats collected via `getStats()`
- **Acceptance:** Stats object contains `candidate-pair` and `local-candidate` entries

### TC-G-002 — Path Classification
- **Input:** ICE negotiation succeeded; inspect Phase 3 output
- **Expected:** Connection path classified as one of: `direct` (host), `srflx` (STUN), `relay` (TURN)
- **Acceptance:** Correct classification based on candidate pair type

### TC-G-003 — ASCII Bar Chart Output
- **Input:** Phase 3 with 3 ICE paths available
- **Expected:** ASCII bar chart printed to console showing path types and quality metrics
- **Acceptance:** Bar chart visible in terminal; paths labeled correctly

### TC-G-004 — Summary Report
- **Input:** All 3 phases complete
- **Expected:** Final summary printed with: server reachability (Phase 1), candidate gathering summary (Phase 2), active path and latency (Phase 3)
- **Acceptance:** All 3 sections present in final output

---

## 10. Test Group H — Socket.IO Trigger Protocol

### TC-H-001 — Socket.IO ice:test Event
- **Input:** Emit `{ "event": "ice:test" }` over Socket.IO
- **Expected:** Server triggers ice-test execution; emits `ice:test:result` event on completion
- **Acceptance:** `ice:test:result` event received with test results

### TC-H-002 — App.tsx Handling
- **Input:** ice:test initiated from App.tsx UI
- **Expected:** App.tsx listens for `ice:test:result`; passes results to test result display component
- **Acceptance:** Results displayed in UI after Socket.IO event received

### TC-H-003 — Headless CI Socket.IO Mode
- **Input:** Socket.IO ice:test in CI environment (no browser)
- **Expected:** Server runs Phases 1 and 2 headlessly; returns structured result JSON via `ice:test:result`
- **Acceptance:** Full result available via Socket.IO without a browser UI

---

## 11. Test Group I — Performance & Security

### TC-I-001 — Phase 2 Time Limit
- **Input:** Full ice-test run (all 3 phases) with typical STUN server
- **Expected:** Phase 2 completes within 60 seconds
- **Acceptance:** `iceTest.js` exits within 60 seconds (not counting Phase-3 manual monitoring)

### TC-I-002 — Headless CI Support
- **Input:** Run `CI=true node iceTest.js ...` without display
- **Expected:** No display required; all phases complete
- **Acceptance:** Zero exit code; no error about missing display

### TC-I-003 — TURN Credentials Not in Response Body
- **Input:** TURN configured; call `GET /api/webrtc/ice-config` and inspect
- **Expected:** Credentials present only in response body (for WebRTC use); NOT logged server-side
- **Acceptance:** Credentials in response (required for WebRTC spec); no credentials in server logs

---

## 12. Test Execution Order

```
Group A (endpoint) → Group B (STUN config) → Group C (TURN config) → Group D (client injection) → Group E (Phase 1 pre-check) → Group F (Phase 2 browser) → Group G (Phase 3 stats) → Group H (Socket.IO trigger) → Group I (performance/security)
```

---

## 13. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| ICE Config Endpoint | 200 response; correct schema; empty array when unconfigured |
| STUN | srflx candidates only; UDP ping succeeds |
| TURN | Credentials not in logs; correct URL format; fallback works |
| Client Injection | RTCPeerConnection receives fetched iceServers |
| Phase 1 | Reachability check for all servers |
| Phase 2 | Browser automation with injection; adaptive wait; headless CI |
| Phase 3 | Stats collected; path classified; ASCII chart; summary |
| Socket.IO | Trigger + result event round-trip; headless mode |
| Performance | Phase 2 ≤ 60 s; headless CI zero exit; no credential exposure |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for STUN TURN ICE |
| 1.1 | 2026-07-10 | LTS Engineering Team | Cross-reference: UI-level test cases for the relocated STUN/TURN/ICE-test surface now live in `TC_ICE_Test_UI.md` Group H and `TC_Admin_Dashboard.md` TC-AD-013~017. |
