# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# WebRTC Connection — STUN / TURN / ICE

| | |
|---|---|
| **Document ID** | SRS-LTS-ICE-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_STUN_TURN_ICE.md |
| **Parent RFP** | rfp/RFP_STUN_TURN_ICE.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — ICE Configuration Endpoint](#3-functional-requirements--ice-configuration-endpoint)
4. [Functional Requirements — STUN Configuration](#4-functional-requirements--stun-configuration)
5. [Functional Requirements — TURN Configuration](#5-functional-requirements--turn-configuration)
6. [Functional Requirements — Client ICE Injection](#6-functional-requirements--client-ice-injection)
7. [Functional Requirements — ice-test Tool Phase 1](#7-functional-requirements--ice-test-tool-phase-1)
8. [Functional Requirements — ice-test Tool Phase 2](#8-functional-requirements--ice-test-tool-phase-2)
9. [Functional Requirements — ice-test Tool Phase 3](#9-functional-requirements--ice-test-tool-phase-3)
10. [Functional Requirements — Socket.IO Trigger Protocol](#10-functional-requirements--socketio-trigger-protocol)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Interface Requirements](#12-interface-requirements)
13. [Constraints & Assumptions](#13-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the verifiable functional requirements for the STUN/TURN/ICE connectivity layer and the automated ice-test tool of LTS-2026. Each requirement is identified by FR-ICE-NNN and is traceable to TC_STUN_TURN_ICE.md.

### 1.2 Scope

This document covers:
- `GET /api/webrtc/ice-config` endpoint for serving ICE server configuration
- STUN and TURN server configuration via environment variables
- Client-side ICE server injection into mediasoup-client `createRecvTransport`
- `npm run ice-test` three-phase automated ICE connectivity test tool
- Socket.IO trigger protocol for browser-side ICE test activation

Out of scope: deployment/management of STUN/TURN server infrastructure (coturn), browser-to-browser connections, automated firewall rule provisioning.

### 1.3 Definitions

| Term | Definition |
|---|---|
| ICE | Interactive Connectivity Establishment (RFC 8445) — NAT traversal protocol for WebRTC |
| STUN | Session Traversal Utilities for NAT (RFC 5389) — discovers public IP/port of a client |
| TURN | Traversal Using Relays around NAT (RFC 5766) — relays media when direct paths fail |
| host candidate | ICE candidate from a directly reachable network interface |
| srflx candidate | Server-reflexive ICE candidate discovered via STUN (public IP behind NAT) |
| relay candidate | ICE candidate routed through a TURN relay |
| coturn | Open-source TURN server implementation |
| ice-test | LTS automated 3-phase ICE validation tool (`server/src/scripts/iceTest.js`) |
| adaptive wait | Early-exit wait strategy replacing fixed timeouts in Phase 2 |

---

## 2. System Overview

### 2.1 ICE Protocol Flow

```
Browser                    Server (mediasoup)            STUN/TURN
   │                              │                           │
   │─── GET /api/webrtc/ice-config ──────────────────────────│
   │<── { stunUrls, turns } ──────│                           │
   │                              │                           │
   │─── webrtc:createTransport ──>│                           │
   │<── { iceParameters, iceCandidates, dtlsParameters } ────│
   │                              │                           │
   │─── ICE Gathering ────────────────────────────────────>  │
   │     (host + srflx via STUN + relay via TURN)             │
   │                              │                           │
   │─── ICE Connectivity Checks ─>│ (candidate pair testing) │
   │<── Connection Nominated ─────│                           │
   │                              │                           │
   │─── webrtc:connectTransport ─>│ (DTLS fingerprint)       │
   │<── DTLS-SRTP established ────│                           │
   │<── RTP/RTCP flowing ─────────│                           │
```

### 2.2 ice-test Tool Architecture

```
iceTest.js (Node.js)
  Phase 1 — Server Pre-check
    ├─ GET /api/cameras          (HTTP 200 check)
    ├─ GET /api/webrtc/ice-config (print STUN/TURN count)
    ├─ STUN UDP ping             (dgram, RFC 5389 Binding Request)
    └─ PUT /api/cameras/:id      (auto-enable WebRTC if needed)

  Phase 2 — Browser Automation (Playwright)
    ├─ addInitScript             (RTCPeerConnection interceptor)
    ├─ Loopback RTCPeerConnection (default path)
    │   └─ page.evaluate()       (create 2 PCs, exchange SDP)
    └─ Socket.IO trigger path    (ws module, Engine.IO v4)
        └─ webrtc:ice-test-start → server → webrtc:ice-test-trigger
    Adaptive wait:
        Phase A: wait RTCPeerConnection created (max 3s)
        Phase B: wait connectionState=connected (max 30s, early exit on failed)

  Phase 3 — ICE Candidate Report
    ├─ getStats() × 5 at 2s intervals
    ├─ Connection path classification (host/srflx/relay)
    └─ ASCII bar chart + throughput report
```

---

## 3. Functional Requirements — ICE Configuration Endpoint

### FR-ICE-001 — Endpoint Availability

- `GET /api/webrtc/ice-config` must be available on the LTS HTTP server.
- The endpoint must respond with HTTP 200 and `Content-Type: application/json`.
- No authentication is required for this endpoint.

### FR-ICE-002 — Response Schema

- The response must contain:
  ```json
  {
    "stunUrls": ["stun:..."],
    "turns": [
      { "url": "turn:...", "username": "...", "credential": "..." }
    ]
  }
  ```
- `stunUrls` must be an array (empty array when `STUN_URLS` is not set).
- `turns` must be an array (empty array when no `TURN_URL*` variables are set).

### FR-ICE-003 — STUN URL Parsing

- `STUN_URLS` environment variable contains a comma-separated list of STUN server URLs.
- Each comma-separated entry must be trimmed and included as a string in `stunUrls`.
- When `STUN_URLS` contains two URLs, the response must contain both.

### FR-ICE-004 — TURN URL Parsing

- The server must iterate `TURN_URL`, `TURN_URL_2`, `TURN_URL_3`, … stopping at the first missing index.
- Each present `TURN_URL_<n>` must produce a TURN entry with corresponding `TURN_USERNAME_<n>` and `TURN_CREDENTIAL_<n>`.
- `TURN_URL` (no suffix) is treated as index 1 equivalent.
- Credentials must be served via this endpoint only and must not be hardcoded in client-side code.

---

## 4. Functional Requirements — STUN Configuration

### FR-ICE-010 — STUN Server Role

- STUN servers are responsible only for IP notification (srflx candidate discovery); they must not relay media.
- The default STUN URL must be `stun:stun.l.google.com:19302` when `STUN_URLS` is not set.

### FR-ICE-011 — STUN UDP Ping (ice-test Phase 1)

- The ice-test tool must send an RFC 5389 Binding Request UDP packet to each LAN STUN server.
- Packet structure: bytes 0–1 = `0x0001`, bytes 2–3 = `0x0000`, bytes 4–7 = `0x2112A442` (Magic Cookie), bytes 8–19 = 12-byte random transaction ID.
- Public STUN servers (e.g., `stun.l.google.com`) must be skipped (LAN-only ping).
- A successful STUN response within 3 seconds is a passing result.

---

## 5. Functional Requirements — TURN Configuration

### FR-ICE-020 — TURN Server Credentials

- TURN credentials (`username`, `credential`) must be served from `GET /api/webrtc/ice-config` and must never appear in client-side source code or browser-accessible static files.

### FR-ICE-021 — TURN URL Formats

- Both `turn:` and `turns:` (TURN over TLS/TCP on port 443) URL schemes must be supported.
- Multiple TURN servers must be supported via numbered suffix convention (`TURN_URL_2`, `TURN_URL_3`, etc.).

### FR-ICE-022 — TURN Fallback Behavior

- When `TURN_URL` is not configured, the `turns` array in the response must be empty and the browser falls back to `host` or `srflx` candidates without error.

---

## 6. Functional Requirements — Client ICE Injection

### FR-ICE-030 — useWebRTC Hook Integration

- The browser's `useWebRTC` hook must call `getIceServers()` from `useWebRTCConfigStore` before creating the `RecvTransport`.
- The resolved ICE servers array must be injected into `device.createRecvTransport()`:
  ```typescript
  const transport = device.createRecvTransport({
    ...transportParams,
    ...(iceServers.length ? { iceServers } : {}),
  });
  ```

### FR-ICE-031 — Browser iceServers Array Format

- The browser must receive ICE servers in standard `RTCIceServer` format:
  ```json
  [
    { "urls": ["stun:stun.l.google.com:19302"] },
    { "urls": "turn:192.168.214.100:3478", "username": "lts-user", "credential": "secret" }
  ]
  ```

### FR-ICE-032 — ICE Candidate Count

- With `SERVER_IP` correctly set on a single-NIC server, `chrome://webrtc-internals` must show exactly 2 ICE candidates (1 UDP + 1 TCP) for the mediasoup `WebRtcTransport`.

---

## 7. Functional Requirements — ice-test Tool Phase 1

### FR-ICE-040 — Server Pre-check

- Phase 1 must attempt `GET /api/cameras` and fail immediately with a clear error message if the server is not reachable.
- Phase 1 must retrieve and print the count of STUN and TURN servers from `GET /api/webrtc/ice-config`.

### FR-ICE-041 — WebRTC Camera Check

- Phase 1 must filter the camera list for cameras with `webrtcEnabled: true`.
- If no camera has `webrtcEnabled: true`, Phase 1 must auto-enable WebRTC on the first available camera via `PUT /api/cameras/:id`.
- Pipeline readiness must be polled via `GET /api/cameras/:id` for up to 15 seconds until `pipelineStatus.running: true`.

### FR-ICE-042 — Phase 1 STUN UDP Ping

- See FR-ICE-011.
- Phase 1 must skip the ping for STUN URLs that resolve to public IPs; ping is LAN-only.

---

## 8. Functional Requirements — ice-test Tool Phase 2

### FR-ICE-050 — Playwright Browser Automation

- Phase 2 must open a Playwright browser page and inject an `RTCPeerConnection` interceptor via `addInitScript` that captures all PC instances and ICE events into `window.__lts_rtcPCs` and `window.__lts_rtcEvents`.

### FR-ICE-051 — Loopback RTCPeerConnection (Default Path)

- Phase 2 must create two `RTCPeerConnection` instances via `page.evaluate()` with local SDP exchange.
- This path must use STUN/TURN config from `/api/webrtc/ice-config`.
- This path must not require mediasoup-client and must bypass the headless Chrome `UnsupportedError: device not supported` codec detection issue.

### FR-ICE-052 — Socket.IO Trigger Path

- Phase 2 must optionally connect to the server via raw Engine.IO v4 WebSocket (`ws` module) and emit `webrtc:ice-test-start` with a `cameraId`.
- The server must emit `webrtc:ice-test-trigger` to all clients; the `IceTestTrigger` component must activate `useWebRTC(cameraId)`.
- Playwright must detect the resulting `RTCPeerConnection`.

### FR-ICE-053 — Adaptive Wait Strategy

Phase 2 must implement a two-step adaptive wait:

| Step | Condition | Max Time | Early Exit |
|---|---|---|---|
| Phase A | RTCPeerConnection created | 3 s | Proceed immediately on detection |
| Phase B | `connectionState === 'connected'` | 30 s | Exit immediately on `connected`, `failed`, or `closed` |

- If no `RTCPeerConnection` is detected within 3 seconds, the test must fail immediately and save a screenshot to `/tmp/lts-ice-test-fail.png`.

### FR-ICE-054 — Phase 2 Cleanup

- After test completion, `iceTest.js` must emit `webrtc:ice-test-done` to trigger server cleanup via `io.emit('webrtc:ice-test-stop')`.

---

## 9. Functional Requirements — ice-test Tool Phase 3

### FR-ICE-060 — ICE Candidate Report

- Phase 3 must report:
  - Local candidate type (host/srflx/relay), protocol, and IP:Port.
  - Remote candidate type and IP:Port.
  - Connection path classification.

### FR-ICE-061 — Path Classification

| Result | Local Candidate Type | Meaning |
|---|---|---|
| `PASS — Direct LAN` | `host` | Optimal path |
| `PASS — STUN NAT traversal` | `srflx` | NAT traversal succeeded |
| `PASS — TURN relay` | `relay` | Working but suboptimal |

### FR-ICE-062 — Throughput Measurement

- `getStats()` must be called 5 times at 2-second intervals.
- Cumulative bytes received and speed (kbps) must be reported.
- An ASCII bar chart of receive trend must be printed.

### FR-ICE-063 — Failure Diagnostics

The report must include actionable guidance for known failure conditions:

| Failure Message | Cause | Action |
|---|---|---|
| `No server response` | Backend not running | Start server |
| `RTCPeerConnection not created` | Trigger not installed | Check `App.tsx` IceTestTrigger |
| `ICE state: failed` | STUN/TURN unreachable | Open firewall UDP 40000–49999 |
| `ICE connection failed (30s timeout)` | mediasoup UDP port unreachable | Set `SERVER_IP` |
| `TURN relay path` | `SERVER_IP` not set | Set `SERVER_IP=<LAN IP>` |

---

## 10. Functional Requirements — Socket.IO Trigger Protocol

### FR-ICE-070 — Server Handlers

- `socket.on('webrtc:ice-test-start', ({ cameraId }) => io.emit('webrtc:ice-test-trigger', { cameraId }))` must be registered in `server/src/index.js`.
- `socket.on('webrtc:ice-test-done', () => io.emit('webrtc:ice-test-stop'))` must be registered in `server/src/index.js`.

### FR-ICE-071 — Client Handlers

- `App.tsx` must listen for `webrtc:ice-test-trigger` and set `iceTestCameraId` state.
- `App.tsx` must listen for `webrtc:ice-test-stop` and reset `iceTestCameraId` to `null`.
- The `IceTestTrigger` component must render `useWebRTC(iceTestCameraId)` when `iceTestCameraId` is non-null.

### FR-ICE-072 — Headless Mode

- `npm run ice-test:headless` must produce identical pass/fail output to headed mode.
- The headless mode must exit with code 0 on success and non-zero on failure (suitable for CI).

---

## 11. Non-Functional Requirements

### FR-ICE-080 — Test Duration

- For a passing LAN configuration, `npm run ice-test` must complete within 60 seconds total (all three phases).
- Adaptive wait eliminates the fixed 35-second delay; average expected duration is 15–20 seconds.

### FR-ICE-081 — CI Compatibility

- `npm run ice-test:headless` must run in headless Linux CI environments without a display.
- Non-zero exit code on failure is required for CI pipeline integration.

### FR-ICE-082 — TURN Credential Security

- TURN credentials must never appear in browser-accessible static files or client-side JavaScript bundles.
- Credentials are served exclusively via `GET /api/webrtc/ice-config` at request time.

---

## 12. Interface Requirements

### 12.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-ICE-001 | GET | `/api/webrtc/ice-config` | Serve STUN/TURN ICE configuration |

### 12.2 Socket.IO Events (ice-test Protocol)

| Event | Direction | Description |
|---|---|---|
| `webrtc:ice-test-start` | Node.js→Server | Initiate ICE test for a cameraId |
| `webrtc:ice-test-trigger` | Server→All Clients | Browser IceTestTrigger activates |
| `webrtc:ice-test-done` | Node.js→Server | Test complete; request cleanup |
| `webrtc:ice-test-stop` | Server→All Clients | Browser cleans up IceTestTrigger state |

### 12.3 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_IP` | `localhost` | Server LAN IP for mediasoup ICE candidates |
| `PORT` | `3001` | Backend HTTP/Socket.IO port |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN server URLs |
| `TURN_URL` | (none) | TURN server URL (turn: or turns:) |
| `TURN_USERNAME` | (none) | TURN authentication username |
| `TURN_CREDENTIAL` | (none) | TURN authentication password |
| `TURN_URL_2`, `_3`, … | (none) | Additional TURN servers |
| `MEDIASOUP_RTC_MIN_PORT` | `40000` | mediasoup UDP port range start |
| `MEDIASOUP_RTC_MAX_PORT` | `49999` | mediasoup UDP port range end |

---

## 13. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Deployment of coturn or other STUN/TURN infrastructure is out of scope; URLs are provided by the operator |
| C-02 | The firewall must allow UDP 40000–49999 inbound on the server host (`sudo ufw allow 40000:49999/udp`) |
| C-03 | `playwright` npm package must be installed in `server/` for Phase 2 automation |
| C-04 | `ws` npm package must be installed in `server/` for Engine.IO v4 WebSocket in the Socket.IO trigger path |
| C-05 | `SERVER_IP` must be set to the LAN IP; omission causes slow ICE (15+ candidates) or fallback to TURN relay |
| C-06 | The `IceTestTrigger` component in `App.tsx` must be present for the Socket.IO trigger path to work |
| C-07 | Google STUN (`stun.l.google.com`) is skipped for UDP ping since it is a public internet server |
| C-08 | Phase 2 loopback injection is the default path to avoid headless Chrome codec detection issues |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for STUN TURN ICE |
