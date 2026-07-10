# TEST CASES (TC)
# In-App ICE Connectivity Test UI

| | |
|---|---|
| **Document ID** | TC-LTS-ICE-UI-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-07-10 |
| **Parent SRS** | srs/SRS_ICE_Test_UI.md |
| **Related Design** | design/Design_ICE_Test_UI.md |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Server Endpoint: POST /api/webrtc/ice-test](#3-test-group-a--server-endpoint-post-apiwebrtcice-test)
4. [Test Group B — Server Endpoint: DELETE /api/webrtc/ice-test/:testId](#4-test-group-b--server-endpoint-delete-apiwebrtcice-testtestid)
5. [Test Group C — Phase 1: ICE Candidate Gathering](#5-test-group-c--phase-1-ice-candidate-gathering)
6. [Test Group D — Phase 2: Server Transport Test](#6-test-group-d--phase-2-server-transport-test)
7. [Test Group E — UI Controls](#7-test-group-e--ui-controls)
8. [Test Group F — Report Download](#8-test-group-f--report-download)
9. [Test Group G — i18n Coverage](#9-test-group-g--i18n-coverage)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | `POST/DELETE /api/webrtc/ice-test` | Jest / Node.js fetch | `test/api/webrtc_ice_test_ui.test.js` (Phase-2) |
| Unit | `runIceTest()` logic, candidate categorisation | Jest + jsdom | `test/unit/iceTestUI.test.js` (Phase-2) |
| Integration | Full two-phase flow with real mediasoup | Manual / Playwright | Phase-2 |
| E2E | Browser UI — button click → log → download | Manual | This document (manual steps) |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-ICE-UI-001 | TC-A-001 |
| FR-ICE-UI-002 | TC-A-002 |
| FR-ICE-UI-003 | TC-A-003 |
| FR-ICE-UI-004 | TC-A-004 |
| FR-ICE-UI-005 | TC-A-005 |
| FR-ICE-UI-006 | TC-B-001, TC-B-002 |
| FR-ICE-UI-007 | TC-A-006 |
| FR-ICE-UI-010 | TC-C-001 |
| FR-ICE-UI-011 | TC-C-002 |
| FR-ICE-UI-012 | TC-C-002 |
| FR-ICE-UI-013 | TC-C-002 |
| FR-ICE-UI-014 | TC-C-003 |
| FR-ICE-UI-015 | TC-C-004 |
| FR-ICE-UI-016 | TC-C-005, TC-C-006 |
| FR-ICE-UI-017 | TC-C-007 |
| FR-ICE-UI-018 | TC-C-008 |
| FR-ICE-UI-020 | TC-D-001 |
| FR-ICE-UI-021 | TC-D-002 |
| FR-ICE-UI-022 | TC-D-003 |
| FR-ICE-UI-023 | TC-D-004 |
| FR-ICE-UI-024 | TC-D-005 |
| FR-ICE-UI-030 | TC-E-001 |
| FR-ICE-UI-031 | TC-E-002, TC-E-003 |
| FR-ICE-UI-032 | TC-E-004 |
| FR-ICE-UI-033 | TC-E-005 |
| FR-ICE-UI-034 | TC-E-006 |
| FR-ICE-UI-035 | TC-E-007 |
| FR-ICE-UI-036 | TC-E-008 |
| FR-ICE-UI-037 | TC-E-009 |
| FR-ICE-UI-040 | TC-F-001 |
| FR-ICE-UI-041 | TC-F-002 |
| FR-ICE-UI-042 | TC-F-003 |
| FR-ICE-UI-050 | TC-G-001 |
| FR-ICE-UI-051 | TC-G-002 |
| FR-ICE-UI-052 | TC-G-003 |

---

## 2. Test Environment and Prerequisites

- LTS server running at `http://localhost:3001` (or configured port)
- `mediasoup` installed and WebRTC gateway initialised
- React client running at `http://localhost:5173`
- At least one STUN server configured (e.g., `stun:stun.l.google.com:19302`)
- Network access to the configured STUN server

---

## 3. Test Group A — Server Endpoint: POST /api/webrtc/ice-test

### TC-A-001 — Endpoint is registered

| | |
|---|---|
| **SRS** | FR-ICE-UI-001 |
| **Precondition** | LTS server is running with mediasoup enabled |
| **Steps** | `POST http://localhost:3001/api/webrtc/ice-test` |
| **Expected** | HTTP 200; JSON body contains `testId`, `transportId`, `iceParameters`, `iceCandidates`, `dtlsParameters` |

### TC-A-002 — Returns 503 when mediasoup unavailable

| | |
|---|---|
| **SRS** | FR-ICE-UI-002 |
| **Precondition** | `webrtcGateway.enabled === false` (mediasoup not installed or init failed) |
| **Steps** | `POST /api/webrtc/ice-test` |
| **Expected** | HTTP 503; `{ "error": "WebRTC gateway not available (mediasoup not initialised)" }` |

### TC-A-003 — Transport uses correct listenIps

| | |
|---|---|
| **SRS** | FR-ICE-UI-003 |
| **Steps** | `POST /api/webrtc/ice-test`; inspect `iceCandidates` array |
| **Expected** | `iceCandidates` contains at least one entry; `ip` values match server interface addresses |

### TC-A-004 — Response payload structure

| | |
|---|---|
| **SRS** | FR-ICE-UI-004 |
| **Steps** | `POST /api/webrtc/ice-test`; validate JSON schema |
| **Expected** | `testId` matches pattern `/^icetest-\d+-[a-z0-9]{6}$/`; `transportId` is UUID-like; `iceParameters` has `usernameFragment` and `password`; `iceCandidates` is array |

### TC-A-005 — Transport auto-expires after 90 s

| | |
|---|---|
| **SRS** | FR-ICE-UI-005 |
| **Precondition** | Test environment allows 90 s wait |
| **Steps** | `POST /api/webrtc/ice-test`; wait 91 s; attempt `DELETE /api/webrtc/ice-test/:testId` |
| **Expected** | `DELETE` returns `{ "ok": true }` (not found is idempotent); transport was already cleaned up |

### TC-A-006 — Transport creation failure returns 500

| | |
|---|---|
| **SRS** | FR-ICE-UI-007 |
| **Precondition** | Simulate `router.createWebRtcTransport()` throwing (e.g., by overriding in test) |
| **Steps** | `POST /api/webrtc/ice-test` |
| **Expected** | HTTP 500; `{ "error": "<message>" }` |

---

## 4. Test Group B — Server Endpoint: DELETE /api/webrtc/ice-test/:testId

### TC-B-001 — Cleanup known testId

| | |
|---|---|
| **SRS** | FR-ICE-UI-006 |
| **Steps** | 1. `POST /api/webrtc/ice-test` → obtain `testId`; 2. `DELETE /api/webrtc/ice-test/:testId` |
| **Expected** | HTTP 200; `{ "ok": true }`; subsequent `DELETE` with same `testId` also returns 200 |

### TC-B-002 — Cleanup unknown testId (idempotent)

| | |
|---|---|
| **SRS** | FR-ICE-UI-006 |
| **Steps** | `DELETE /api/webrtc/ice-test/nonexistent-id` |
| **Expected** | HTTP 200; `{ "ok": true }` |

---

## 5. Test Group C — Phase 1: ICE Candidate Gathering

### TC-C-001 — Uses draft form values (not saved config)

| | |
|---|---|
| **SRS** | FR-ICE-UI-010 |
| **Precondition** | Open Settings Modal; change STUN URL to a different value without clicking Apply |
| **Steps** | Click "Run ICE Test" |
| **Expected** | Log header shows the unsaved STUN URL (draft value), not the previously saved URL |

### TC-C-002 — RTCPeerConnection created with data channel and offer

| | |
|---|---|
| **SRS** | FR-ICE-UI-011, FR-ICE-UI-012, FR-ICE-UI-013 |
| **Steps** | Run ICE test; open DevTools → Application → WebRTC internals (chrome://webrtc-internals) |
| **Expected** | A new `RTCPeerConnection` is visible; a `DataChannel` named `lts-ice-check` is present; local description is set |

### TC-C-003 — Host candidates logged

| | |
|---|---|
| **SRS** | FR-ICE-UI-014 |
| **Precondition** | Any network interface present |
| **Steps** | Run ICE test; inspect log |
| **Expected** | At least one line matching `+ host  <IP>:<port>  proto=udp` or `proto=tcp` |

### TC-C-004 — ICE error events logged

| | |
|---|---|
| **SRS** | FR-ICE-UI-015 |
| **Precondition** | Configure an unreachable STUN URL (e.g., `stun:192.0.2.1:3478`) |
| **Steps** | Run ICE test |
| **Expected** | Log contains a line starting with `! ICE error: code=` |

### TC-C-005 — Completes on gathering state complete

| | |
|---|---|
| **SRS** | FR-ICE-UI-016 |
| **Precondition** | STUN server reachable |
| **Steps** | Run ICE test; observe Phase 1 completion time |
| **Expected** | Phase 1 completes in under 15 s without `ICE gathering timed out` message |

### TC-C-006 — Falls back to 15 s timeout

| | |
|---|---|
| **SRS** | FR-ICE-UI-016 |
| **Precondition** | Configure a valid but unreachable STUN/TURN that delays `icegatheringstate='complete'` |
| **Steps** | Run ICE test; wait |
| **Expected** | After ~15 s, log shows `ICE gathering timed out after 15 s`; test proceeds to Phase 2 |

### TC-C-007 — Summary counts and pass/fail indicators

| | |
|---|---|
| **SRS** | FR-ICE-UI-017 |
| **Precondition** | Reachable STUN configured; TURN configured |
| **Steps** | Run ICE test |
| **Expected** | Summary block shows `host`, `srflx`, `relay` counts; `srflx` count > 0 shows `✓ STUN reachable`; `relay` count > 0 shows `✓ TURN reachable` |

### TC-C-008 — RTCPeerConnection closed after Phase 1

| | |
|---|---|
| **SRS** | FR-ICE-UI-018 |
| **Steps** | Run ICE test; open chrome://webrtc-internals; check after Phase 1 completes |
| **Expected** | The `RTCPeerConnection` shows `connectionState: closed` |

---

## 6. Test Group D — Phase 2: Server Transport Test

### TC-D-001 — Phase 2 skipped on abort

| | |
|---|---|
| **SRS** | FR-ICE-UI-020 |
| **Steps** | 1. Click "Run ICE Test"; 2. Immediately click the button again (abort) before Phase 2 starts |
| **Expected** | Log shows `Aborted.` without any Phase 2 lines |

### TC-D-002 — Phase 2 calls POST endpoint

| | |
|---|---|
| **SRS** | FR-ICE-UI-021 |
| **Steps** | Run ICE test with mediasoup enabled; monitor network requests in DevTools |
| **Expected** | A `POST /api/webrtc/ice-test` request is made after Phase 1 completes |

### TC-D-003 — Success: transport id and candidates logged

| | |
|---|---|
| **SRS** | FR-ICE-UI-022 |
| **Steps** | Run ICE test; inspect log Phase 2 section |
| **Expected** | Log contains `✓ Transport created: id=<8 chars>`; `Server ICE candidates: N`; one line per candidate |

### TC-D-004 — Failure: error logged

| | |
|---|---|
| **SRS** | FR-ICE-UI-023 |
| **Precondition** | mediasoup not available (HTTP 503) |
| **Steps** | Run ICE test |
| **Expected** | Phase 2 log contains `✗ Server transport creation failed: WebRTC gateway not available` |

### TC-D-005 — Cleanup always called

| | |
|---|---|
| **SRS** | FR-ICE-UI-024 |
| **Steps** | Run ICE test; monitor network requests |
| **Expected** | A `DELETE /api/webrtc/ice-test/:testId` request is made after Phase 2 (success or failure); log shows `Server transport cleaned up.` |

---

## 7. Test Group E — UI Controls

### TC-E-001 — ICE test section visible in Settings Modal

| | |
|---|---|
| **SRS** | FR-ICE-UI-030 |
| **Steps** | Open Settings Modal (gear icon); scroll to bottom |
| **Expected** | Section with `ICE CONNECTIVITY TEST` header and "Run ICE Test" button is visible |

### TC-E-002 — Button label when idle

| | |
|---|---|
| **SRS** | FR-ICE-UI-031 |
| **Steps** | Open Settings Modal without running a test |
| **Expected** | Button shows `Run ICE Test` (English) or locale equivalent |

### TC-E-003 — Button label when running

| | |
|---|---|
| **SRS** | FR-ICE-UI-031 |
| **Steps** | Click "Run ICE Test"; observe button immediately |
| **Expected** | Button shows `Testing… (click to abort)` (English) or locale equivalent; button color changes to yellow/amber |

### TC-E-004 — Button starts test when idle

| | |
|---|---|
| **SRS** | FR-ICE-UI-032 |
| **Steps** | Click "Run ICE Test" |
| **Expected** | Log lines begin appearing; `iceRunning = true` |

### TC-E-005 — Button aborts when running

| | |
|---|---|
| **SRS** | FR-ICE-UI-033 |
| **Steps** | Click "Run ICE Test"; before Phase 2 starts, click button again |
| **Expected** | Test is aborted; `iceRunning = false`; log shows `Aborted.` |

### TC-E-006 — Log area hidden when no log

| | |
|---|---|
| **SRS** | FR-ICE-UI-034 |
| **Steps** | Open Settings Modal (first open, no previous test) |
| **Expected** | No log textarea visible |

### TC-E-007 — Log area styling

| | |
|---|---|
| **SRS** | FR-ICE-UI-035 |
| **Steps** | Run ICE test; inspect log area appearance |
| **Expected** | Dark/black background; green monospace text; scrollable; read-only |

### TC-E-008 — Log auto-scrolls

| | |
|---|---|
| **SRS** | FR-ICE-UI-036 |
| **Steps** | Run ICE test; scroll to middle of log during test; observe |
| **Expected** | Log textarea automatically scrolls to bottom on each new line |

### TC-E-009 — Download/Clear buttons visible after test

| | |
|---|---|
| **SRS** | FR-ICE-UI-037 |
| **Steps** | Complete an ICE test |
| **Expected** | "Download Report" and "Clear" buttons appear next to the section header |

---

## 8. Test Group F — Report Download

### TC-F-001 — Download creates Blob correctly

| | |
|---|---|
| **SRS** | FR-ICE-UI-040 |
| **Steps** | Run ICE test; click "Download Report" |
| **Expected** | Browser download dialog appears; file contains all log lines joined by newline |

### TC-F-002 — Filename format

| | |
|---|---|
| **SRS** | FR-ICE-UI-041 |
| **Steps** | Click "Download Report"; observe filename |
| **Expected** | Filename matches `ice-test-report-YYYY-MM-DDTHH-MM-SS.txt` (colons replaced with hyphens) |

### TC-F-003 — Object URL revoked after download

| | |
|---|---|
| **SRS** | FR-ICE-UI-042 |
| **Steps** | Click "Download Report"; check for memory leaks via DevTools Memory tab |
| **Expected** | No long-lived Blob URLs remain after download trigger |

---

## 9. Test Group G — i18n Coverage

### TC-G-001 — All 5 keys in Translations interface

| | |
|---|---|
| **SRS** | FR-ICE-UI-050 |
| **Steps** | Open `client/src/i18n/translations/en.ts`; search for `settingsIceTest` |
| **Expected** | All 5 keys (`settingsIceTest`, `settingsIceTestRun`, `settingsIceTestRunning`, `settingsIceTestDownload`, `settingsIceTestClear`) present in `en.ts` |

### TC-G-002 — Korean translations present

| | |
|---|---|
| **SRS** | FR-ICE-UI-051 |
| **Steps** | Open `client/src/i18n/translations/ko.ts`; verify 5 keys with Korean text |
| **Expected** | `settingsIceTest: 'ICE 연결 테스트'`, `settingsIceTestRun: 'ICE 테스트 실행'`, etc. |

### TC-G-003 — TypeScript compilation succeeds

| | |
|---|---|
| **SRS** | FR-ICE-UI-052 |
| **Steps** | Run `npx tsc --noEmit` in `client/` directory |
| **Expected** | Zero TypeScript errors |

---

## 10. Test Execution Order

For manual E2E testing:

1. TC-G-003 — TypeScript compilation (prerequisite)
2. TC-A-001 — Server endpoint registered
3. TC-A-002 — 503 when mediasoup down
4. TC-B-001, TC-B-002 — DELETE endpoint
5. TC-E-001 — Modal UI visible
6. TC-E-002 — Button label idle
7. TC-E-006 — Log hidden initially
8. TC-C-001 — Draft values used
9. TC-E-004 — Button starts test
10. TC-E-003 — Button label running
11. TC-C-003 — Host candidates logged
12. TC-C-005 — Phase 1 completes without timeout
13. TC-C-007 — Summary indicators
14. TC-D-002 — POST request made
15. TC-D-003 — Success response logged
16. TC-D-005 — Cleanup request made
17. TC-E-009 — Download/Clear buttons appear
18. TC-E-007 — Log styling
19. TC-E-008 — Auto-scroll
20. TC-F-001, TC-F-002 — Download
21. TC-E-005 — Abort during test

---

## 11. Pass/Fail Criteria

### Overall Pass

All of the following must hold:
- TC-G-003: Zero TypeScript errors
- TC-A-001: Server endpoint returns 200 with all required fields
- TC-A-002: Server returns 503 when mediasoup unavailable
- TC-B-001: Cleanup endpoint returns 200
- TC-E-001: ICE test section visible in Settings Modal
- TC-C-003: Host candidates appear in log
- TC-D-003: Server transport success logged (requires mediasoup running)
- TC-D-005: Cleanup always called
- TC-F-002: Download filename matches pattern
- TC-G-001: All 5 keys in en.ts
- TC-G-002: Korean translations in ko.ts

### Acceptable with Known Limitation

- TC-C-004 (ICE error logging): Pass if log contains `! ICE error:` when STUN is unreachable. May be flaky on networks that drop UDP silently.
- TC-C-006 (15 s timeout): Pass if timeout message appears within 16 s. May take longer on heavily loaded CI runners.
- TC-A-005 (90 s auto-expiry): Can be skipped in fast-feedback cycles; mark as deferred to nightly tests.

---

## 12. Test Group H — Administrator Dashboard Relocation (v1.1)

### TC-H-001: Settings Modal Content by Server Mode

**Steps:** Open the Settings Modal against `combined`, `streaming`, and `analysis` servers in turn.
**Expected:**
- `combined`: full WebRTC/STUN/TURN/ICE Test UI present (unchanged)
- `streaming` / `analysis`: only Language selector + relocation note (+ "Go to Admin Dashboard" button for admin users)

### TC-H-002: Admin Dashboard WebRTC / ICE Section Renders Identical Test Flow

**Steps:** In Admin Dashboard → WebRTC / ICE, run the ICE test.
**Expected:** Same two-phase log format as the Settings Modal (Group C/D above); Download Report and Clear behave identically (Group F).

### TC-H-003: Shared State Between Modal and Admin Section (combined mode only)

**Steps:** In `combined` mode, add a TURN server via Admin Dashboard → WebRTC / ICE, click Apply; then open the Settings Modal.
**Expected:** The new TURN server appears in the modal's TURN list without a page reload (`useWebRTCConfigStore` shared state).

### TC-H-004: WebRTC / ICE Nav Item Hidden in Analysis Mode

**Steps:** Load Admin Dashboard against a `SERVER_MODE=analysis` server.
**Expected:** No "WebRTC / ICE" item in the sidebar.

---

## Revision History

| Version | Date | Description |
|---|---|---|
| 1.0 | 2026-06-05 | Initial release — Test cases for In-App ICE Connectivity Test UI |
| 1.1 | 2026-07-10 | Added Group H (TC-H-001~004) — Administrator Dashboard relocation for streaming/analysis modes |
