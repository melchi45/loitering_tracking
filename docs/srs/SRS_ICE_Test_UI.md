# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# In-App ICE Connectivity Test UI

| | |
|---|---|
| **Document ID** | SRS-LTS-ICE-UI-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-07-10 |
| **Parent PRD** | prd/PRD_ICE_Test_UI.md |
| **Parent SRS** | srs/SRS_STUN_TURN_ICE.md |
| **Related TC** | tc/TC_ICE_Test_UI.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Server Endpoints](#3-functional-requirements--server-endpoints)
4. [Functional Requirements — Client ICE Gathering (Phase 1)](#4-functional-requirements--client-ice-gathering-phase-1)
5. [Functional Requirements — Server Transport Test (Phase 2)](#5-functional-requirements--server-transport-test-phase-2)
6. [Functional Requirements — UI Controls](#6-functional-requirements--ui-controls)
7. [Functional Requirements — Report Download](#7-functional-requirements--report-download)
8. [Functional Requirements — i18n](#8-functional-requirements--i18n)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the verifiable functional requirements for the In-App ICE Connectivity Test UI feature of LTS-2026. Each requirement is identified by FR-ICE-UI-NNN and is traceable to TC_ICE_Test_UI.md.

### 1.2 Scope

This document covers:

- `POST /api/webrtc/ice-test` — server endpoint creating a temporary mediasoup test transport
- `DELETE /api/webrtc/ice-test/:testId` — cleanup endpoint
- Two-phase ICE connectivity test running inside the browser
- Real-time log display with auto-scroll
- Report download as a `.txt` file
- Abort mechanism for in-progress tests
- i18n keys for all 15 supported locales

Out of scope: Full DTLS handshake verification, media flow throughput measurement, CLI ice-test tool (covered by SRS_STUN_TURN_ICE.md).

### 1.3 Definitions

| Term | Definition |
|------|------------|
| ICE | Interactive Connectivity Establishment — IETF RFC 8445 |
| STUN | Session Traversal Utilities for NAT — RFC 8489 |
| TURN | Traversal Using Relays around NAT — RFC 8656 |
| srflx | Server-Reflexive ICE candidate — discovered via STUN binding |
| relay | Relay ICE candidate — allocated via TURN |
| host | Host ICE candidate — local network interface |
| mediasoup | Node.js WebRTC SFU library used by LTS-2026 |
| WebRtcTransport | mediasoup object representing a server-side ICE+DTLS endpoint |
| RTCPeerConnection | Browser WebRTC API |

---

## 2. System Overview

```
Browser (Settings Modal)                   LTS Server (Express)
─────────────────────────                  ────────────────────
[Run ICE Test] clicked
        │
        ├─ Phase 1 ──────────────────────────────────────────────────
        │   RTCPeerConnection({ iceServers: [stun, turn...] })
        │   createDataChannel + createOffer + setLocalDescription
        │   ← onicecandidate  (host / srflx / relay candidates)
        │   ← onicecandidateerror
        │   ← icegatheringstate='complete' (or 15 s timeout)
        │
        ├─ Phase 2 ──────────────────────────────────────────────────
        │   POST /api/webrtc/ice-test ──────────────────────────────►
        │                             ◄──── { testId, iceCandidates… }
        │   Log server ICE candidates
        │   DELETE /api/webrtc/ice-test/:testId ──────────────────►
        │
        └─ Display log / enable Download + Clear buttons
```

---

## 3. Functional Requirements — Server Endpoints

### FR-ICE-UI-001
`POST /api/webrtc/ice-test` SHALL be registered in `server/src/index.js` after the existing `/api/webrtc/ice-config` endpoint.

### FR-ICE-UI-002
`POST /api/webrtc/ice-test` SHALL return HTTP 503 with `{ "error": "..." }` when `webrtcGateway.enabled` is `false`.

### FR-ICE-UI-003
`POST /api/webrtc/ice-test` SHALL call `webrtcGateway.getOrCreateRouter('__ice-test__')` and create a `WebRtcTransport` with the same `listenIps`, `enableUdp`, `enableTcp`, `preferUdp` parameters as a normal camera transport.

### FR-ICE-UI-004
The response payload SHALL include `testId` (unique string), `transportId`, `iceParameters`, `iceCandidates`, and `dtlsParameters`.

### FR-ICE-UI-005
Each test transport SHALL be stored in an in-memory `Map` keyed by `testId` and SHALL be automatically closed and removed after 90 seconds to prevent resource leaks.

### FR-ICE-UI-006
`DELETE /api/webrtc/ice-test/:testId` SHALL close the transport and remove the entry from the map. It SHALL return HTTP 200 `{ "ok": true }` regardless of whether the `testId` was found (idempotent).

### FR-ICE-UI-007
Transport creation errors SHALL be caught and returned as HTTP 500 with `{ "error": "<message>" }`.

---

## 4. Functional Requirements — Client ICE Gathering (Phase 1)

### FR-ICE-UI-010
Phase 1 SHALL construct an `RTCIceServer[]` array from the **current draft values** in the settings form (i.e., values that may not yet have been saved via Apply).

### FR-ICE-UI-011
Phase 1 SHALL create an `RTCPeerConnection` with the constructed `iceServers`.

### FR-ICE-UI-012
Phase 1 SHALL add a `DataChannel` with label `'lts-ice-check'` to trigger ICE gathering.

### FR-ICE-UI-013
Phase 1 SHALL call `createOffer()` followed by `setLocalDescription()`.

### FR-ICE-UI-014
Phase 1 SHALL log each `onicecandidate` event with: timestamp, `+` indicator, candidate type (`host`/`srflx`/`relay`), address, port, and protocol.

### FR-ICE-UI-015
Phase 1 SHALL log each `onicecandidateerror` event with: `!` indicator, error code, server URL, and error text.

### FR-ICE-UI-016
Phase 1 SHALL complete when `icegatheringstate === 'complete'` is observed OR after a 15-second timeout, whichever comes first.

### FR-ICE-UI-017
Phase 1 SHALL log a summary block listing counts for `host`, `srflx`, and `relay` candidates. `srflx` count > 0 SHALL produce `✓ STUN reachable`; count = 0 SHALL produce `✗ STUN unreachable or no STUN configured`. `relay` count > 0 SHALL produce `✓ TURN reachable`; count = 0 with TURN servers configured SHALL produce `✗ TURN unreachable`; with no TURN servers configured SHALL produce `(no TURN configured)`.

### FR-ICE-UI-018
Phase 1 SHALL close the `RTCPeerConnection` after gathering.

---

## 5. Functional Requirements — Server Transport Test (Phase 2)

### FR-ICE-UI-020
Phase 2 SHALL be skipped if the abort flag is set before it starts.

### FR-ICE-UI-021
Phase 2 SHALL call `POST /api/webrtc/ice-test` and log the result.

### FR-ICE-UI-022
On success, Phase 2 SHALL log: `✓ Transport created: id=<first 8 chars>`, `Server ICE candidates: N`, and each candidate's type, IP, port, and protocol.

### FR-ICE-UI-023
On failure (non-2xx or `data.error`), Phase 2 SHALL log `✗ <error message>`.

### FR-ICE-UI-024
Phase 2 SHALL always call `DELETE /api/webrtc/ice-test/:testId` in a `finally` block if a `testId` was obtained, and SHALL log `Server transport cleaned up.` after cleanup.

---

## 6. Functional Requirements — UI Controls

### FR-ICE-UI-030
The Settings Modal SHALL render an "ICE CONNECTIVITY TEST" section header below the Apply button within the WebRTC settings group.

### FR-ICE-UI-031
A primary action button SHALL display `t.settingsIceTestRun` when idle and `t.settingsIceTestRunning` during an active test.

### FR-ICE-UI-032
Clicking the button while idle SHALL start the ICE test.

### FR-ICE-UI-033
Clicking the button while a test is running SHALL set the abort flag (`iceAbortRef.current = true`) and transition the test to abort at the next checkpoint.

### FR-ICE-UI-034
The log textarea SHALL only be rendered when `iceLog.length > 0`.

### FR-ICE-UI-035
The log textarea SHALL be `readOnly`, use a monospace font, display green text on a near-black background (terminal aesthetic), and have a fixed height with vertical scroll.

### FR-ICE-UI-036
The log textarea SHALL auto-scroll to the bottom on each new log entry using `requestAnimationFrame`.

### FR-ICE-UI-037
"Download Report" and "Clear" buttons SHALL only be rendered when `iceLog.length > 0`.

---

## 7. Functional Requirements — Report Download

### FR-ICE-UI-040
Clicking "Download Report" SHALL create a `Blob` from `iceLog.join('\n')` with MIME type `text/plain`.

### FR-ICE-UI-041
The downloaded filename SHALL follow the pattern `ice-test-report-<ISO-8601-datetime>.txt` (colons replaced with hyphens).

### FR-ICE-UI-042
The download SHALL be triggered via a dynamically created `<a>` element and SHALL revoke the object URL after triggering.

---

## 8. Functional Requirements — i18n

### FR-ICE-UI-050
The following five keys SHALL be added to the `Translations` interface in `en.ts` and populated in all 15 locale files:

| Key | English Value |
|-----|---------------|
| `settingsIceTest` | `'ICE Connectivity Test'` |
| `settingsIceTestRun` | `'Run ICE Test'` |
| `settingsIceTestRunning` | `'Testing… (click to abort)'` |
| `settingsIceTestDownload` | `'Download Report'` |
| `settingsIceTestClear` | `'Clear'` |

### FR-ICE-UI-051
Korean locale (`ko.ts`) SHALL provide Korean-language translations for all five keys.

### FR-ICE-UI-052
All other locales SHALL at minimum provide the English string as a placeholder (TypeScript compilation SHALL succeed with no type errors).

---

## 9. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | TypeScript compilation SHALL produce zero errors after all changes. |
| NFR-02 | Test transport auto-expiry SHALL not exceed 90 s to avoid port exhaustion. |
| NFR-03 | The 15-second Phase 1 gather timeout SHALL prevent the UI hanging indefinitely. |
| NFR-04 | TURN credential values SHALL NOT appear in the log output. |
| NFR-05 | The ICE test UI SHALL NOT affect the normal camera WebRTC pipeline. |
| NFR-06 | Server endpoints SHALL be reachable without authentication (same policy as `/api/webrtc/ice-config`). |

---

## 10. Interface Requirements

### 10.1 UI Component
- File: `client/src/App.tsx` — `SettingsModal` function component
- State variables: `iceRunning: boolean`, `iceLog: string[]`, `iceLogRef: RefObject<HTMLTextAreaElement>`, `iceAbortRef: MutableRefObject<boolean>`
- Functions: `runIceTest(): Promise<void>`, `downloadIceReport(): void`

### 10.2 Server Module
- File: `server/src/index.js`
- New routes: `POST /api/webrtc/ice-test`, `DELETE /api/webrtc/ice-test/:testId`
- Depends on: `webrtcGateway` (already imported)

### 10.3 i18n
- Type definition: `client/src/i18n/translations/en.ts` — `Translations` interface
- Locale files: all `.ts` files in `client/src/i18n/translations/`

---

## 11. Constraints & Assumptions

1. The browser must support `RTCPeerConnection`, `RTCDataChannel`, and `RTCPeerConnectionIceErrorEvent` (all modern browsers since Chrome 28, Firefox 22, Safari 11).
2. `mediasoup` must be installed and the WebRTC gateway must have been initialised successfully for Phase 2 to succeed.
3. The test transport uses a shared `'__ice-test__'` router ID. Concurrent ICE tests from multiple browser sessions will share the same router but create separate transports (each with a unique `testId`).
4. The TURN credential is included in `RTCIceServer` for Phase 1 gather operations but is never echoed back in the log output.

---

## 12. v1.1 Amendment — Relocated to Administrator Dashboard

**Date:** 2026-07-10

#### FR-ICE-UI-090 — Mode-Dependent Settings Modal Content

The Settings Modal (`App.tsx` `SettingsModal`) MUST render its full WebRTC/STUN/TURN/ICE-Test UI (§4–§7) only when `serverMode === 'combined'`. For `serverMode === 'streaming'` or `serverMode === 'analysis'`, the modal MUST render only the language selector, plus a note that WebRTC/ICE settings are managed in the Administrator Dashboard, plus (for `role === 'admin'` users) a button that navigates there.

#### FR-ICE-UI-091 — Administrator Dashboard WebRTC / ICE Section

For `serverMode !== 'analysis'`, the Administrator Dashboard MUST provide a "WebRTC / ICE" navigation section implementing the same STUN/TURN configuration and two-phase ICE test described in §3–§7, reusing `useWebRTCConfigStore` so state stays consistent with the Settings Modal (relevant only for `combined` mode, where both surfaces are simultaneously reachable).

#### FR-ICE-UI-092 — No Change to Server Contract

The relocation MUST NOT change the `POST /api/webrtc/ice-test` / `DELETE /api/webrtc/ice-test/:testId` contract (§3) or the client-side two-phase test algorithm (§4–§5) — only the UI location and mode-based visibility change.

Detail: `docs/design/Design_Admin_Dashboard.md` §4.3, `docs/srs/SRS_Admin_Dashboard.md` §8.

---

## Revision History

| Version | Date | Description |
|---|---|---|
| 1.0 | 2026-06-05 | Initial release — SRS for In-App ICE Connectivity Test UI |
| 1.1 | 2026-07-10 | §12 amendment — FR-ICE-UI-090~092: relocated to Administrator Dashboard for streaming/analysis modes, combined mode unchanged |
