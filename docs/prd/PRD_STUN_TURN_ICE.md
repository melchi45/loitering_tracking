# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# WebRTC Connection — STUN / TURN / ICE and ICE Automated Testing

| | |
|---|---|
| **Document ID** | PRD-LTS-007 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_STUN_TURN_ICE.md (LTS-2026-007) |

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

The LTS STUN/TURN/ICE module provides a correctly configured WebRTC connectivity layer that selects the optimal network path (direct LAN, STUN NAT traversal, or TURN relay) between browsers and the mediasoup SFU, and ships a three-phase automated ICE test tool (`npm run ice-test`) that validates the full path using real Playwright browser automation — eliminating the need for manual WebRTC debugging.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Provide a `GET /api/webrtc/ice-config` endpoint that serves STUN and TURN server configuration to the browser, keeping credentials server-side.
- Support multiple STUN and TURN servers via environment variables with a predictable naming convention (`STUN_URLS`, `TURN_URL`, `TURN_URL_2`, etc.).
- Implement the `npm run ice-test` tool that runs a three-phase automated test: server pre-check, Playwright browser automation with adaptive wait, and ICE candidate path analysis with throughput measurement.
- Adopt an adaptive wait strategy in Phase 2 that replaces a fixed 35-second delay with early exit on ICE success or failure, reducing test duration for passing configurations.
- Produce a human-readable report classifying the connection path as Direct LAN (host), STUN NAT traversal (srflx), or TURN relay, with actionable failure guidance.

### 2.2 Non-Goals

- Deployment or management of STUN/TURN server infrastructure (e.g., coturn) is out of scope; the module consumes externally provided server URLs.
- Inter-peer WebRTC connections (browser-to-browser) are not in scope; the module covers browser-to-mediasoup connections only.
- Automated firewall rule provisioning is not in scope; the documentation provides manual UFW commands.

---

## 3. User Personas

**System Administrator** — Configures `SERVER_IP`, `STUN_URLS`, and `TURN_URL*` environment variables. Runs `npm run ice-test` after deployment to verify the ICE path before handing over to operators. Uses the Phase 3 report to confirm the connection is using the Direct LAN path.

**DevOps / CI Engineer** — Runs `npm run ice-test:headless` in a CI pipeline to catch regressions in WebRTC connectivity after infrastructure changes. Needs deterministic pass/fail output with a non-zero exit code on failure.

**Developer** — Uses `npm run ice-test` during local development to diagnose ICE connectivity issues (wrong `SERVER_IP`, closed UDP ports, excess ICE candidates) before involving the infrastructure team.

---

## 4. Functional Specification

### 4.1 ICE Protocol Layer

ICE (Interactive Connectivity Establishment, RFC 8445) operates in four phases: Gathering (collect host, srflx, and relay candidates), Signaling (exchange candidates via Socket.IO SDP), Checking (test candidate pairs in priority order), and Connected (nominate the first successful pair and begin DTLS → RTP).

The LTS system uses the following candidate priority order:

| Type | type_pref | Preferred When |
|---|---|---|
| `host` | 126 | Direct LAN communication possible |
| `srflx` | 100 | NAT traversal via STUN required |
| `relay` | 0 | Last resort; TURN relay only |

### 4.2 STUN Configuration

STUN servers are specified in `server/.env` as a comma-separated list:

```ini
STUN_URLS=stun:stun.l.google.com:19302
# Multiple servers: STUN_URLS=stun:stun.l.google.com:19302,stun:192.168.1.100:3478
```

The `GET /api/webrtc/ice-config` endpoint parses `STUN_URLS` and returns them as an array in the ICE configuration. STUN servers are responsible only for IP notification; they do not relay media.

### 4.3 TURN Configuration

TURN servers are configured per-server with a numeric suffix:

```ini
TURN_URL=turn:192.168.214.100:3478
TURN_USERNAME=lts-user
TURN_CREDENTIAL=secret

TURN_URL_2=turns:my-turn.example.com:443
TURN_USERNAME_2=lts
TURN_CREDENTIAL_2=secret2
```

The server iterates suffix `1`, `2`, `3`, … until `TURN_URL_<n>` is not set. Credentials are never sent to the browser in plaintext; they are served only via the `GET /api/webrtc/ice-config` endpoint (server-side only).

### 4.4 CLIENT_IP Injection

The browser's `useWebRTC` hook calls `getIceServers()` from `useWebRTCConfigStore` and injects the result into the mediasoup-client `createRecvTransport()` call:

```typescript
const iceServers = getIceServers();
const transport = device.createRecvTransport({
  ...transportParams,
  ...(iceServers.length ? { iceServers } : {}),
});
```

### 4.5 ice-test Tool: Three-Phase Automation

The `npm run ice-test` tool (`server/src/scripts/iceTest.js`) performs:

#### Phase 1 — Server Pre-check

| Check | Method | Success Criteria |
|---|---|---|
| Server response | `GET /api/cameras` | HTTP 200 |
| WebRTC camera check | Filter cameras list | At least one camera with `webrtcEnabled: true` |
| Auto-enable WebRTC | `PUT /api/cameras/:id` | Temporarily enables first camera if none found |
| Pipeline readiness | Poll `GET /api/cameras/:id` (15 s) | `pipelineStatus.running: true` |
| ICE server config | `GET /api/webrtc/ice-config` | Print STUN/TURN count |
| STUN UDP ping | RFC 5389 Binding Request via `dgram` socket | STUN response received (LAN STUN servers only; Google STUN skipped) |

STUN Binding Request packet structure: bytes 0–1 = `0x0001` (Binding Request), bytes 2–3 = `0x0000` (length), bytes 4–7 = `0x2112A442` (Magic Cookie), bytes 8–19 = 12-byte random transaction ID.

#### Phase 2 — Browser Automation (Adaptive Wait)

The test opens a Playwright browser page and injects an `RTCPeerConnection` interceptor via `addInitScript` that captures all PC instances and ICE events into `window.__lts_rtcPCs` and `window.__lts_rtcEvents`.

Two parallel mechanisms create an RTCPeerConnection:

1. **Loopback injection (default)**: Two `RTCPeerConnection` instances created directly in the page via `page.evaluate()`; local SDP exchanged immediately. Uses the STUN/TURN config from `/api/webrtc/ice-config`. Does not require mediasoup-client. This path bypasses the headless Chrome `UnsupportedError: device not supported` codec detection issue.

2. **Socket.IO trigger (IceTestTrigger)**: `iceTest.js` connects to the server via raw Engine.IO v4 WebSocket (`ws` module) and emits `webrtc:ice-test-start` with a `cameraId`. The server emits `webrtc:ice-test-trigger` to all clients; the `IceTestTrigger` component in `App.tsx` activates `useWebRTC(cameraId)` to start a full mediasoup session. Playwright detects the resulting `RTCPeerConnection`.

Adaptive wait steps:

| Step | Wait Condition | Max Time | Early Exit |
|---|---|---|---|
| Phase A | Confirm `RTCPeerConnection` creation | 3 s | Proceed immediately on detection |
| Phase B | Wait for `connectionState === 'connected'` | 30 s | Exit immediately on `connected`; also exit immediately on `failed` or `closed` |

If no `RTCPeerConnection` is detected within 3 seconds, the test fails immediately and saves a screenshot to `/tmp/lts-ice-test-fail.png`.

After test completion, `iceTest.js` emits `webrtc:ice-test-done` to trigger server cleanup via `io.emit('webrtc:ice-test-stop')`.

#### Phase 3 — ICE Candidate Report

The report includes:
- Local candidate type (host/srflx/relay), protocol, and IP:Port
- Remote candidate type and IP:Port
- Connection path classification: Direct LAN / STUN NAT traversal / TURN relay
- Throughput measurement: `getStats()` called 5 times at 2-second intervals; cumulative bytes received and speed (kbps)
- ASCII bar chart of receive trend

### 4.6 Socket.IO Trigger Protocol

```
WS: ws://SERVER:3001/socket.io/?EIO=4&transport=websocket
Client → Server: 42["webrtc:ice-test-start", {"cameraId": "..."}]
Server → All:    42["webrtc:ice-test-trigger", {"cameraId": "..."}]
Client → Server: 42["webrtc:ice-test-done"]
Server → All:    42["webrtc:ice-test-stop"]
```

### 4.7 Test Result Interpretation

| Result | Local Candidate Type | Meaning |
|---|---|---|
| `PASS — Direct LAN` | `host` | Optimal path; server and client on same LAN |
| `PASS — STUN NAT traversal` | `srflx` | NAT traversal succeeded; acceptable latency |
| `PASS — TURN relay` | `relay` | Working but suboptimal; investigate missing host path |

| Failure Message | Cause | Action |
|---|---|---|
| `No server response` | Backend not running | Start server: `cd server && npm run dev` |
| `RTCPeerConnection not created` | Trigger not installed or pipeline not running | Check `App.tsx` `IceTestTrigger`; verify camera RTSP URL |
| `ICE state: failed` | STUN/TURN unreachable or firewall | Open firewall: `sudo ufw allow 40000:49999/udp` |
| `ICE connection failed (30s timeout)` | mediasoup UDP port not reachable | Set `SERVER_IP` in `server/.env` |
| `TURN relay path` | `SERVER_IP` not set | Set `SERVER_IP=<LAN IP>` in `server/.env` |

---

## 5. Technical Requirements

### 5.1 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_IP` | `localhost` | Server LAN IP — included in mediasoup host ICE candidates |
| `PORT` | `3001` | Backend HTTP/Socket.IO port |
| `VITE_PORT` | `5173` | Vite development server port |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN server URLs |
| `TURN_URL` | (none) | TURN server URL (`turn:` or `turns:`) |
| `TURN_USERNAME` | (none) | TURN authentication username |
| `TURN_CREDENTIAL` | (none) | TURN authentication password |
| `TURN_URL_2`, `_3`, … | (none) | Additional TURN servers |
| `MEDIASOUP_RTC_MIN_PORT` | `40000` | mediasoup RTP/RTCP minimum UDP port |
| `MEDIASOUP_RTC_MAX_PORT` | `49999` | mediasoup RTP/RTCP maximum UDP port |

### 5.2 mediasoup WebRTC Transport Configuration

```js
{
  listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.SERVER_IP }],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
}
```

### 5.3 Firewall Requirements

```bash
sudo ufw allow 40000:49999/udp
```

### 5.4 Tool Dependencies

- `playwright` — browser automation for Phase 2
- `ws` — raw WebSocket for Engine.IO v4 Socket.IO trigger
- `dgram` — Node.js built-in; STUN UDP ping in Phase 1

### 5.5 Run Commands

```bash
cd server && npm run ice-test              # Headed mode (shows browser window)
cd server && npm run ice-test:headless     # Headless mode (SSH / CI)
node src/scripts/iceTest.js http://<SERVER>:3001 http://<SERVER>:5173
```

---

## 6. API / Interface Contract

### 6.1 GET /api/webrtc/ice-config

Returns ICE server configuration to the browser. Credentials are served here rather than hardcoded in the client.

**Response 200:**
```json
{
  "stunUrls": ["stun:stun.l.google.com:19302"],
  "turns": [
    {
      "url": "turn:192.168.214.100:3478",
      "username": "lts-user",
      "credential": "secret"
    }
  ]
}
```

Browser `iceServers` array format:
```json
[
  { "urls": ["stun:stun.l.google.com:19302"] },
  { "urls": "turn:192.168.214.100:3478", "username": "lts-user", "credential": "secret" }
]
```

### 6.2 Socket.IO Events (ice-test Tool)

| Event | Direction | Description |
|---|---|---|
| `webrtc:ice-test-start` | Node.js → Server | Initiate ICE test for a specific `cameraId` |
| `webrtc:ice-test-trigger` | Server → All Clients | Browser `IceTestTrigger` activates WebRTC session |
| `webrtc:ice-test-done` | Node.js → Server | Test complete; request cleanup |
| `webrtc:ice-test-stop` | Server → All Clients | Browser cleans up `IceTestTrigger` state |

### 6.3 Server Handlers

```javascript
// server/src/index.js
socket.on('webrtc:ice-test-start', ({ cameraId } = {}) => {
  io.emit('webrtc:ice-test-trigger', { cameraId });
});
socket.on('webrtc:ice-test-done', () => {
  io.emit('webrtc:ice-test-stop');
});
```

### 6.4 Client Handlers (App.tsx)

```typescript
socket.on('webrtc:ice-test-trigger', ({ cameraId }) => setIceTestCameraId(cameraId));
socket.on('webrtc:ice-test-stop',    ()              => setIceTestCameraId(null));
```

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-1 | `GET /api/webrtc/ice-config` returns a JSON object with `stunUrls` array and `turns` array populated from environment variables. |
| AC-2 | With `STUN_URLS=stun:stun.l.google.com:19302,stun:example.com:3478`, the response contains both STUN URLs. |
| AC-3 | With `TURN_URL`, `TURN_URL_2` set, the response contains two TURN entries with correct `url`, `username`, and `credential` fields. |
| AC-4 | `npm run ice-test` Phase 1 exits immediately with a clear error message if the backend server is not reachable. |
| AC-5 | Phase 1 STUN UDP ping succeeds for a LAN STUN server; Google public STUN is skipped. |
| AC-6 | Phase 1 auto-enables WebRTC on the first available camera if none has `webrtcEnabled: true`; the flag is restored or noted for operator action. |
| AC-7 | Phase 2 creates an `RTCPeerConnection` within 3 seconds via loopback injection; the test does not wait the full 3-second window if the PC is created sooner. |
| AC-8 | Phase 2 exits immediately when `connectionState === 'failed'` without waiting for the 30-second timeout. |
| AC-9 | Phase 2 saves a screenshot to `/tmp/lts-ice-test-fail.png` when `RTCPeerConnection` is not created within 3 seconds. |
| AC-10 | Phase 3 correctly classifies a same-LAN connection as "Direct LAN (host candidate)". |
| AC-11 | Phase 3 reports `getStats()` throughput over 5 × 2-second intervals; non-zero bytes received for an active stream. |
| AC-12 | With `SERVER_IP` correctly set on a single-NIC server, `chrome://webrtc-internals` shows exactly 2 ICE candidates (1 UDP + 1 TCP) for the mediasoup WebRtcTransport. |
| AC-13 | `npm run ice-test:headless` produces identical pass/fail output to headed mode and exits with code 0 on success, non-zero on failure. |
| AC-14 | When `TURN_URL` is not configured, the `turns` array in the ICE config response is empty and the browser falls back to host/srflx candidates. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | `GET /api/webrtc/ice-config` endpoint; STUN/TURN env var parsing | TBD | 2026-05-20 | ✅ Done |
| M2 | `ice-test` Phase 1 (server check, STUN UDP ping, camera auto-enable) | TBD | 2026-05-20 | ✅ Done |
| M3 | `ice-test` Phase 2 (Playwright, adaptive wait, Socket.IO trigger) | TBD | 2026-05-20 | ✅ Done |
| M4 | `ice-test` Phase 3 (ICE candidate report, throughput measurement) | TBD | 2026-05-20 | ✅ Done |
| M5 | CI integration and documentation | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Add `npm run ice-test:headless` npm script to `server/package.json` if not already present
- [ ] Integrate `ice-test:headless` into CI pipeline with non-zero exit code enforcement
- [ ] Document STUN/TURN environment variable setup in `server/.env.example`
- [ ] Add auto-restore of `webrtcEnabled` flag after Phase 1 auto-enable (avoid leaving cameras permanently enabled)
- [ ] Add LAN STUN server detection logic: skip ping if STUN URL resolves to a public IP
- [ ] Validate `RTCPeerConnection` interceptor works on Firefox and Safari (Playwright cross-browser)
- [ ] Add Phase 3 ASCII bar chart output to the CI-friendly headless report format
- [ ] Test `ice-test` against a coturn TURN server with `turns:` (TLS/TCP on port 443)
- [ ] Confirm `webrtc:ice-test-done` cleanup correctly resets `IceTestTrigger` state in production builds
- [ ] Update README with `npm run ice-test` usage, expected output, and troubleshooting guide

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for STUN TURN ICE |
