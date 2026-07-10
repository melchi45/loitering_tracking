# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# In-App ICE Connectivity Test UI

| | |
|---|---|
| **Document ID** | PRD-LTS-ICE-UI-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-07-10 |
| **Related Design** | design/Design_ICE_Test_UI.md |
| **Related SRS** | srs/SRS_ICE_Test_UI.md |
| **Related TC** | tc/TC_ICE_Test_UI.md |
| **Parent PRD** | prd/PRD_STUN_TURN_ICE.md |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

When network administrators configure STUN/TURN servers in the LTS-2026 settings panel, they currently have no immediate way to verify that those servers are reachable from the browser or that the LTS server's WebRTC port range is accessible. They must wait until an actual camera stream fails or succeed to notice misconfiguration.

The **In-App ICE Connectivity Test UI** solves this by placing a "Run ICE Test" button directly inside the Settings Modal (top-right gear icon → WebRTC section). Clicking the button runs a two-phase ICE connectivity check without requiring any external tool, CLI access, or network expertise:

- **Phase 1** — The browser creates a local `RTCPeerConnection` using the configured STUN/TURN servers and gathers ICE candidates. The presence of `srflx` (server-reflexive) candidates confirms STUN reachability; `relay` candidates confirm TURN reachability.
- **Phase 2** — The browser calls `POST /api/webrtc/ice-test`, which asks the LTS server to create a temporary mediasoup `WebRtcTransport` and returns its ICE candidates and transport parameters, confirming that the server's WebRTC port range is open and functional.

All results appear in a scrollable log box. The operator can download the full report as a `.txt` file for offline analysis or support tickets.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Provide a **one-click ICE test button** inside the Settings Modal, visible whenever the WebRTC section is visible.
- Run a **two-phase test** without page reload or external tooling.
- Display **real-time streaming log** of candidate events and phase summaries.
- Provide a **download button** to export the log as a timestamped `.txt` report.
- Support **abort** during a running test (clicking the button again while running).
- Support **all 15 UI languages** (i18n keys added for all locales).
- Add a **server-side test endpoint** (`POST /api/webrtc/ice-test`, `DELETE /api/webrtc/ice-test/:testId`) that is safe, resource-bounded (auto-expiry in 90 s), and gated by WebRTC gateway availability.

### 2.2 Non-Goals

- Does not replace the `npm run ice-test` Playwright CLI tool (which does full browser-automation E2E testing).
- Does not measure media throughput (bytes/s) — only ICE candidate types and transport creation.
- Does not test browser-to-browser WebRTC connections.
- Does not automatically fix misconfigured STUN/TURN servers.
- Does not expose TURN credentials in the log output.

---

## 3. User Personas

| Persona | Goal | Pain point addressed |
|---------|------|---------------------|
| Network Admin | Verify STUN/TURN config before deployment | No current in-UI feedback on ICE reachability |
| Field Technician | Confirm camera streams will work on-site | Must currently wait for a camera failure |
| QA Engineer | Validate WebRTC config as part of release checklist | Previously required CLI access and Playwright install |
| Support Engineer | Collect diagnostic data for a ticket | Can now download a timestamped report in one click |

---

## 4. Functional Specification

### 4.1 UI Placement

The ICE test section appears at the bottom of the WebRTC settings area in the Settings Modal, below the Apply button. It is always visible when the WebRTC settings section is rendered (not gated on the Enable toggle).

### 4.2 Section Layout

```
┌─────────────────────────────────────────────────┐
│  ICE CONNECTIVITY TEST          [Download] [Clear]│
│  ┌─────────────────────────────────────────────┐  │
│  │  Run ICE Test  (or "Testing… (click to abort)")│  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │ [10:23:45.123] === Phase 1: ICE Candidate …│  │
│  │ [10:23:45.200]   + host  192.168.1.50:48120 │  │
│  │ [10:23:45.890]   + srflx 203.0.113.5:48120  │  │
│  │ [10:23:46.100] --- Phase 1 Summary ---       │  │
│  │ [10:23:46.100]   srflx (STUN): 1  ✓ reachable│  │
│  │ ...                                          │  │
│  └─────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 4.3 ICE Test Flow

**Phase 1 — Client ICE Gathering**

1. Build `RTCIceServer[]` from the current draft values in the form (not the saved/applied values), so the operator can test before saving.
2. Create `RTCPeerConnection({ iceServers })`.
3. Add a `DataChannel` named `lts-ice-check` to trigger candidate gathering.
4. Call `createOffer()` → `setLocalDescription()`.
5. Collect all `onicecandidate` events; log each candidate's type, address, port, and protocol.
6. Collect `onicecandidateerror` events and log error code, URL, and text.
7. Wait for `icegatheringstate === 'complete'` or a 15-second timeout.
8. Log a summary: counts for `host`, `srflx`, `relay`; pass/fail indicator per category.
9. Close the RTCPeerConnection.

**Phase 2 — Server Transport Test**

1. `POST /api/webrtc/ice-test` → server creates a temporary `WebRtcTransport` and returns `{ testId, transportId, iceParameters, iceCandidates, dtlsParameters }`.
2. Log the number of server-side ICE candidates and each candidate's details.
3. `DELETE /api/webrtc/ice-test/:testId` to clean up the temporary transport.
4. Log success or failure with HTTP status.

### 4.4 Abort Behaviour

When the user clicks the button while a test is running, `iceAbortRef.current` is set to `true`. The running test checks this flag before Phase 2 and stops early if set. The log shows `Aborted.`.

### 4.5 Download Report

Clicking "Download Report" triggers a browser download of a `.txt` file named `ice-test-report-<ISO-timestamp>.txt` containing the full log, one line per entry.

### 4.6 Clear

Clicking "Clear" empties the log area. Download and Clear buttons are only rendered when the log is non-empty.

---

## 5. Technical Requirements

| Req ID | Requirement |
|--------|-------------|
| TR-01 | ICE test MUST use `RTCPeerConnection` Web API — no native code, no external library. |
| TR-02 | Server endpoint MUST be gated on `webrtcGateway.enabled` and return HTTP 503 if mediasoup is unavailable. |
| TR-03 | Test transport MUST auto-close after 90 s to prevent resource leaks. |
| TR-04 | Test transport MUST be created using the same `listenIps` as a normal camera transport. |
| TR-05 | The client MUST always call `DELETE /api/webrtc/ice-test/:testId` after Phase 2, even on error. |
| TR-06 | TURN credentials MUST NOT appear in the log output. |
| TR-07 | Log area MUST auto-scroll to the latest line during a running test. |
| TR-08 | All five i18n keys MUST be present in all 15 supported locales. |

---

## 6. API / Interface Contract

### `POST /api/webrtc/ice-test`

**Request**: No body required.

**Success Response** (HTTP 200):
```json
{
  "testId": "icetest-1717600000000-abc123",
  "transportId": "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh",
  "iceParameters": { "usernameFragment": "...", "password": "...", "iceLite": false },
  "iceCandidates": [
    { "foundation": "...", "ip": "192.168.1.100", "port": 40000,
      "priority": 2130706431, "protocol": "udp", "type": "host" }
  ],
  "dtlsParameters": { "role": "auto", "fingerprints": [...] }
}
```

**Error Response** (HTTP 503 — mediasoup unavailable):
```json
{ "error": "WebRTC gateway not available (mediasoup not initialised)" }
```

**Error Response** (HTTP 500 — transport creation failed):
```json
{ "error": "<mediasoup error message>" }
```

### `DELETE /api/webrtc/ice-test/:testId`

**Request**: No body required.

**Response** (HTTP 200):
```json
{ "ok": true }
```

Note: Returns 200 even if `testId` is not found (idempotent cleanup).

---

## 7. Acceptance Criteria

| ID | Criterion |
|----|-----------|
| AC-01 | "Run ICE Test" button visible in Settings Modal → WebRTC section. |
| AC-02 | Clicking the button starts Phase 1 candidate gathering; log lines appear in real time. |
| AC-03 | `srflx` candidates appear when a reachable STUN server is configured. |
| AC-04 | `relay` candidates appear when a reachable TURN server is configured. |
| AC-05 | Phase 2 log shows server ICE candidates when mediasoup is running. |
| AC-06 | Phase 2 log shows HTTP 503 / error message when mediasoup is not available. |
| AC-07 | Clicking the button during a test aborts after the current phase. |
| AC-08 | "Download Report" triggers a `.txt` file download with the full log. |
| AC-09 | "Clear" empties the log area. |
| AC-10 | TypeScript compilation succeeds with no errors after changes. |
| AC-11 | All 15 locale files contain the five new i18n keys. |

---

## 8. Milestones & TODO

| Milestone | Status | Date |
|-----------|--------|------|
| PRD approved | Complete | 2026-06-05 |
| SRS written | Complete | 2026-06-05 |
| Design document written | Complete | 2026-06-05 |
| TC written | Complete | 2026-06-05 |
| Server endpoints implemented | Complete | 2026-06-05 |
| Client UI implemented | Complete | 2026-06-05 |
| i18n keys added (all 15 locales) | Complete | 2026-06-05 |
| TypeScript build verified | Complete | 2026-06-05 |
| Relocated to Admin Dashboard for streaming/analysis modes | Complete | 2026-07-10 |

---

## 9. v1.1 Amendment — Relocated to Administrator Dashboard

**Date:** 2026-07-10

The ICE Test UI (and the WebRTC/STUN/TURN configuration it tests) moved out of the per-dashboard Settings Modal for **streaming** and **analysis** server modes, into a new "WebRTC / ICE" section of the Administrator Dashboard (`AdminUsersPage.tsx`). This keeps the Settings Modal to Language-only for those modes, consistent with the analysis-mode-only simplification that already existed before this change.

- **combined** mode: unchanged — the Settings Modal keeps the full WebRTC/STUN/TURN/ICE Test UI described in §4 above, for quick single-server access.
- **streaming** mode: this UI (§4) now lives exclusively in Admin Dashboard → WebRTC / ICE. The Settings Modal shows Language plus a note directing admins there.
- **analysis** mode: Admin Dashboard hides the WebRTC / ICE nav item entirely — analysis servers have no camera capture and no use for STUN/TURN/ICE.
- Both surfaces (Settings Modal and Admin Dashboard section) read/write the same `useWebRTCConfigStore`, so configuration stays consistent regardless of which one is used.

No change to the server-side `POST /api/webrtc/ice-test` contract (§6) or the two-phase test flow (§4.3) — only the UI's location moved.

See `PRD_Admin_Dashboard`-equivalent coverage in `docs/design/Design_Admin_Dashboard.md` §4.3, `docs/srs/SRS_Admin_Dashboard.md` §8 (FR-AD-070~075), `docs/tc/TC_Admin_Dashboard.md` TC-AD-013~017.

---

## Revision History

| Version | Date | Description |
|---|---|---|
| 1.0 | 2026-06-05 | Initial release — PRD for In-App ICE Connectivity Test UI |
| 1.1 | 2026-07-10 | §9 amendment — relocated to Administrator Dashboard for streaming/analysis modes; combined mode unchanged |
