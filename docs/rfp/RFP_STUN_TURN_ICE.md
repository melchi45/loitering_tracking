# RFP: WebRTC Connection Based on STUN / TURN / ICE and ICE Automated Testing

**Document No.**: LTS-2026-007
**Version**: 1.0
**Date**: 2026-05-20
**Classification**: Technical Requirements Specification (RFP)
**Status**: Phase-1 Complete — Socket.IO trigger-based ice-test implementation complete

---

## 1. Overview

### 1.1 Purpose

This document defines the **STUN / TURN / ICE** protocol-based connection architecture used in WebRTC video streaming for the LTS (Loitering Tracking System), and specifies the design and implementation of the `npm run ice-test` tool that automates connection state verification.

### 1.2 Scope

- STUN / TURN / ICE protocol fundamentals and roles
- ICE server configuration structure for the LTS system
- `ice-test` automation tool (3-Phase test)
- Socket.IO-based adaptive WebRTC test trigger approach

---

## 2. STUN / TURN / ICE Protocol Fundamentals

### 2.1 ICE (Interactive Connectivity Establishment) — RFC 8445

ICE is a framework that automatically finds the **optimal network path** between two peers (browser ↔ media server). WebRTC's RTCPeerConnection uses ICE.

#### ICE Operation Phases

```
[1] Gathering  — Each peer collects its own IP/port candidates
                   host candidate  : Local NIC address (direct LAN)
                   srflx candidate : Public IP confirmed via STUN server
                   relay candidate : Relay address provided by TURN server

[2] Signaling  — Exchange candidates with the remote peer via SDP (Offer/Answer)
                   LTS uses Socket.IO as the signaling channel

[3] Checking   — Check connectivity of collected candidate pairs in priority order
                   Attempted in order: host > srflx > relay

[4] Connected  — Select (Nominate) the first successfully connected candidate pair
                   Then begin DTLS handshake → RTP/RTCP transmission on that path
```

#### ICE Candidate Types

| Type | Description | Path | Latency |
|------|------|------|------|
| `host` | Local NIC address (LAN) | Direct | Lowest |
| `srflx` (server reflexive) | Public IP:port reported by STUN server | NAT traversal | Medium |
| `relay` | Relay via TURN server | Via TURN | High |

---

### 2.2 STUN (Session Traversal Utilities for NAT) — RFC 5389 / RFC 8489

STUN is a lightweight UDP protocol that allows a client behind a NAT (router) to **confirm its own public IP:port**.

#### How It Works

```
Client (behind NAT)       NAT              STUN Server
     │                    │                     │
     │──── Binding Req ───►──── Binding Req ───►│
     │     src: 10.0.0.5  │     src: 1.2.3.4    │  ← NAT translates src IP
     │                    │                     │
     │◄─── Binding Res ───◄──── Binding Res ───◄│
     │     XOR-MAPPED: 1.2.3.4:54321           │  ← Notifies public IP
```

- The STUN server is responsible **only for IP notification** and does not relay media
- Most Symmetric NATs cannot connect with STUN alone and require TURN
- Google public STUN: `stun:stun.l.google.com:19302` (falls back to TURN on ICE failure)

#### LTS STUN Configuration (`server/.env`)

```ini
STUN_URLS=stun:stun.l.google.com:19302
# LAN-internal-only STUN (when coturn is installed):
# STUN_URLS=stun:192.168.1.100:3478
```

Multiple servers separated by comma: `STUN_URLS=stun:stun.l.google.com:19302,stun:192.168.1.100:3478`

---

### 2.3 TURN (Traversal Using Relays around NAT) — RFC 5766 / RFC 8656

TURN is a protocol where the **TURN server relays media packets** in environments where two peers cannot connect directly (Symmetric NAT, corporate firewall, etc.).

#### How It Works

```
Browser (corporate firewall)    TURN Server        mediasoup (server)
        │                   │                    │
        │──── ALLOCATE ─────►│                    │
        │◄─── RELAYED ADDR ──│ (x.x.x.x:5000)    │
        │                   │◄──────────────────►│
        │                   │  Media relay        │
```

- The TURN server processes media directly, so **bandwidth costs are incurred**
- If direct connection is possible, ICE selects host/srflx candidates first and TURN is not used
- Protocols: UDP (default), TCP (firewall bypass), TLS/TCP (passes through HTTPS port 443)

#### LTS TURN Configuration (`server/.env`)

```ini
# TURN server 1
TURN_URL=turn:192.168.214.100:3478
TURN_USERNAME=lts-user
TURN_CREDENTIAL=secret

# TURN server 2 (multiple supported: _2, _3, ...)
TURN_URL_2=turns:my-turn.example.com:443
TURN_USERNAME_2=lts
TURN_CREDENTIAL_2=secret2
```

The `GET /api/webrtc/ice-config` endpoint provides ICE server configuration to the browser,
and credentials are stored only on the server side.

---

### 2.4 ICE Candidate Selection Criteria

WebRTC sorts ICE candidate pairs using a **priority formula**:

```
priority = (2^24 × type_pref) + (2^8 × local_pref) + (256 − component)
```

| Candidate Type | type_pref | Selection Condition |
|----------|-----------|---------|
| host     | 126       | Direct LAN communication possible — always preferred |
| srflx    | 100       | NAT traversal possible |
| relay    | 0         | Last resort when both of the above fail |

The LTS mediasoup server must specify the LAN IP via the `SERVER_IP` environment variable
so that the browser correctly selects the host candidate:

```ini
# server/.env
SERVER_IP=192.168.214.3
```

---

## 3. LTS ICE Server Configuration Structure

### 3.1 Server Side (`GET /api/webrtc/ice-config`)

```javascript
// server/src/index.js
app.get('/api/webrtc/ice-config', (_req, res) => {
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',').map(s => s.trim()).filter(Boolean);

  const turns = [];
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? '' : `_${i}`;
    const url = (process.env[`TURN_URL${suffix}`] || '').trim();
    if (!url) break;
    turns.push({
      url,
      username:   (process.env[`TURN_USERNAME${suffix}`]   || '').trim(),
      credential: (process.env[`TURN_CREDENTIAL${suffix}`] || '').trim(),
    });
  }
  res.json({ stunUrls, turns });
});
```

### 3.2 Client Side (`useWebRTCConfigStore`)

The browser calls `getIceServers()` in the `useWebRTC` hook and injects the result into RTCPeerConnection:

```typescript
// client/src/hooks/useWebRTC.ts
const iceServers = getIceServers();
const transport = device.createRecvTransport({
  ...transportParams,
  ...(iceServers.length ? { iceServers } : {}),
});
```

`iceServers` array format:
```json
[
  { "urls": ["stun:stun.l.google.com:19302"] },
  { "urls": "turn:192.168.214.100:3478", "username": "lts-user", "credential": "secret" }
]
```

---

## 4. `npm run ice-test` — ICE Automation Test Tool

### 4.1 Overview

`ice-test` is a 3-phase automated testing tool that verifies real WebRTC ICE connections using Playwright browser automation.

```
cd server && npm run ice-test              # headed (shows browser window)
cd server && npm run ice-test:headless     # headless (SSH/CI environment)
node src/scripts/iceTest.js http://192.168.214.3:3001 http://192.168.214.3:5173
```

### 4.2 Architecture: Socket.IO Trigger Approach (v2.0)

```
┌─────────────────────────────────────────────────────────────────┐
│  iceTest.js (Node.js)          Socket.IO over WebSocket         │
│                                                                 │
│  Phase 1: Server check ──────► GET /api/cameras                 │
│           STUN UDP ping ──────► Direct STUN server check        │
│           Enable WebRTC ──────► PUT /api/cameras/:id            │
│                                                                 │
│  Phase 2: ─────────────────────────────────────────────────────│
│                                                                 │
│  ┌─────────────────┐   webrtc:ice-test-start   ┌────────────┐  │
│  │  Playwright      │──────────────────────────►│  Backend   │  │
│  │  Open browser    │                           │  (3001)    │  │
│  │                 │◄──────────────────────────│  Socket.IO │  │
│  │  IceTestTrigger  │   webrtc:ice-test-trigger │            │  │
│  │  Component active│                           └────────────┘  │
│  │                 │                                           │
│  │  RTCPeerConn    │─── ICE Gathering ──► STUN/TURN server   │
│  │  creation detect│─── ICE Checking ──► mediasoup server    │
│  │  (adaptive wait)│─── ICE Connected ─► getStats() collect  │
│  └─────────────────┘                                           │
│                                                                 │
│  Phase 3: ICE candidate type / path / throughput report output  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 Socket.IO Trigger Protocol

#### iceTest.js → Server (Engine.IO v4 raw WebSocket)

Implemented directly with the `ws` module without the `socket.io-client` package:

```
WS connection: ws://SERVER:3001/socket.io/?EIO=4&transport=websocket
         ↓
Server: '0{"sid":"...","pingInterval":25000,...}'  (EIO OPEN)
Client: '40'                                       (SIO CONNECT)
Server: '40{"sid":"..."}'                          (SIO CONNECT ACK)
Client: '42["webrtc:ice-test-start",{"cameraId":"..."}]' (SIO EVENT emit)
         ↓
Server: io.emit('webrtc:ice-test-trigger', { cameraId })
         ↓
Browser: socket.on('webrtc:ice-test-trigger') → IceTestTrigger activated
```

#### Server Handler (`server/src/index.js`)

```javascript
socket.on('webrtc:ice-test-start', ({ cameraId } = {}) => {
  io.emit('webrtc:ice-test-trigger', { cameraId });
});
socket.on('webrtc:ice-test-done', () => {
  io.emit('webrtc:ice-test-stop');
});
```

#### Client Handler (`client/src/App.tsx`)

```typescript
socket.on('webrtc:ice-test-trigger', ({ cameraId }) => setIceTestCameraId(cameraId));
socket.on('webrtc:ice-test-stop',    ()              => setIceTestCameraId(null));
```

When the `IceTestTrigger` component is activated, the `useWebRTC(cameraId, true)` hook is called to start the actual mediasoup WebRTC connection, and Playwright detects the RTCPeerConnection of this connection.

---

### 4.4 Detailed Specification per Phase

#### Phase 1 — Server Pre-check

| Check Item | Method | Success Criteria |
|----------|------|---------|
| Server response | `GET /api/cameras` (HTTP) | HTTP 200 |
| WebRTC camera check | Filter cameras list | Camera with `webrtcEnabled: true` exists |
| Auto-enable WebRTC | `PUT /api/cameras/:id` | Temporarily enables first camera if none found |
| Wait for pipeline ready | Poll `GET /api/cameras/:id` (15s) | `pipelineStatus.running: true` |
| ICE server config check | `GET /api/webrtc/ice-config` | Print STUN/TURN count |
| STUN UDP ping | `dgram` socket + STUN Binding Request (RFC 5389) | STUN response received |

STUN UDP ping targets only LAN STUN servers; Google public STUN is skipped.

**STUN Binding Request Packet Structure:**

```
Byte 0-1:  0x0001      — STUN Message Type: Binding Request
Byte 2-3:  0x0000      — Message Length (0 bytes, no attributes)
Byte 4-7:  0x2112A442  — Magic Cookie (RFC 5389 fixed value)
Byte 8-19: Transaction ID (12 bytes, random)
```

#### Phase 2 — Browser Automation (Adaptive Wait)

v2.0 **discards the fixed 35-second wait** and replaces it with the following 2-step adaptive approach:

| Step | Wait Condition | Max Time | Early Exit |
|------|----------|---------|---------|
| **Loopback injection** | Create PC × 2 + SDP exchange via `page.evaluate()` | Immediate (synchronous) | mediasoup-client not needed |
| **Phase A** | Confirm RTCPeerConnection creation | 3 seconds | Proceed to Phase B immediately upon confirmation |
| **Phase B** | Wait for ICE `connectionState === 'connected'` | 30 seconds | Exit immediately upon connection |

**Loopback ICE Injection (default path):**
Two `RTCPeerConnection` instances are created directly in the browser page via `page.evaluate()` and local SDP is exchanged. The STUN/TURN server configuration from `/api/webrtc/ice-config` is used as-is. Since mediasoup-client is not used at all, the headless Chrome `UnsupportedError: device not supported` codec detection issue is bypassed. The Socket.IO trigger (IceTestTrigger) runs in parallel and test results are unaffected if it fails.

If no PC is created within 3 seconds in Phase A:
- Both loopback injection failure and IceTestTrigger not working — fail immediately
- Save screenshot: `/tmp/lts-ice-test-fail.png`
- (Previously: waited unconditionally for 35 seconds before failing)

If `connectionState === 'failed'` / `'closed'` is detected in Phase B, fail immediately without waiting 30 seconds.

**RTCPeerConnection Interceptor (Playwright addInitScript):**

```javascript
window.__lts_rtcPCs = [];
window.__lts_rtcEvents = [];

const _Native = window.RTCPeerConnection;
window.RTCPeerConnection = new Proxy(_Native, {
  construct(Target, args) {
    const pc = Reflect.construct(Target, args);
    window.__lts_rtcPCs.push(pc);
    // connectionstatechange, iceconnectionstatechange, icegatheringstatechange,
    // icecandidate events are recorded in __lts_rtcEvents
    return pc;
  },
});
```

#### Phase 3 — ICE Candidate Report

| Item | Content |
|------|------|
| Local Candidate | Type (host/srflx/relay) + protocol + IP:Port |
| Remote Candidate | Type + IP:Port |
| Path determination | host=Direct LAN, srflx=STUN NAT traversal, relay=TURN relay |
| Traffic measurement | `getStats()` 5 times × 2-second intervals → cumulative received + speed (kbps) |
| Receive trend | ASCII bar chart |

---

### 4.5 Test Result Interpretation

#### Success Cases

| Result | Local Type | Meaning |
|------|-----------|------|
| `PASS` — Direct LAN | `host` | Optimal path. Server and client are on the same LAN |
| `PASS` — STUN NAT traversal | `srflx` | NAT traversal succeeded. Slightly higher latency than direct LAN |
| `PASS` — TURN relay | `relay` | Working but inefficient. Recommended to investigate why host connection is unavailable |

#### Failure Cases and Actions

| Error Message | Cause | Action |
|-----------|------|------|
| `No server response` | Backend not running | `cd server && npm run dev` |
| `RTCPeerConnection not created` | IceTestTrigger not installed or pipeline not running | Check App.tsx IceTestTrigger, inspect camera RTSP URL |
| `ICE state: failed` | STUN/TURN unreachable or firewall | Open UFW port: `sudo ufw allow 40000:49999/udp` |
| `ICE connection failed (30s timeout)` | mediasoup WebRTC port not open | Check `server/.env → SERVER_IP=<LAN IP>` |
| `TURN relay path` | `SERVER_IP` not set | Set `server/.env → SERVER_IP=192.168.x.x` |

---

## 5. mediasoup WebRTC Port Configuration

mediasoup uses a UDP port range for media transmission:

```ini
# server/.env
MEDIASOUP_RTC_MIN_PORT=40000
MEDIASOUP_RTC_MAX_PORT=49999
```

Open firewall (within LAN):
```bash
sudo ufw allow 40000:49999/udp
```

---

## 6. Full List of Environment Variables

| Variable | Default | Description |
|------|--------|------|
| `SERVER_IP` | `localhost` | Server LAN IP (included in host ICE candidates) |
| `PORT` | `3001` | Backend HTTP/Socket.IO port |
| `VITE_PORT` | `5173` | Vite development server port |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Specify multiple STUN servers separated by comma |
| `TURN_URL` | (none) | TURN server URL (turn: or turns:) |
| `TURN_USERNAME` | (none) | TURN authentication username |
| `TURN_CREDENTIAL` | (none) | TURN authentication password |
| `TURN_URL_2`, `_3`, … | (none) | Second and subsequent TURN servers (sequential numbers) |
| `MEDIASOUP_RTC_MIN_PORT` | `40000` | mediasoup RTP/RTCP minimum port |
| `MEDIASOUP_RTC_MAX_PORT` | `49999` | mediasoup RTP/RTCP maximum port |

---

## 7. Implementation Checklist

### 7.1 Server

| Feature | Status | File |
|------|------|------|
| `GET /api/webrtc/ice-config` — Provide STUN/TURN configuration | ✅ Complete | `server/src/index.js` |
| `webrtc:ice-test-start` Socket.IO handler | ✅ Complete | `server/src/index.js` |
| `webrtc:ice-test-done` Socket.IO handler | ✅ Complete | `server/src/index.js` |
| mediasoup WebRTC gateway | ✅ Complete | `server/src/services/webrtcGateway.js` |

### 7.2 Client

| Feature | Status | File |
|------|------|------|
| `useWebRTCConfigStore` — ICE server configuration store | ✅ Complete | `client/src/stores/webrtcConfigStore.ts` |
| `useWebRTC` hook — mediasoup-client connection | ✅ Complete | `client/src/hooks/useWebRTC.ts` |
| `IceTestTrigger` component | ✅ Complete | `client/src/App.tsx` |
| `webrtc:ice-test-trigger` Socket.IO receive | ✅ Complete | `client/src/App.tsx` |
| `webrtc:ice-test-stop` Socket.IO receive (cleanup) | ✅ Complete | `client/src/App.tsx` |

### 7.3 ice-test Script

| Feature | Status | Notes |
|------|------|------|
| Phase 1: Server check + STUN UDP ping | ✅ Complete | `server/src/scripts/iceTest.js` |
| Phase 1: Auto-enable WebRTC camera | ✅ Complete | |
| Phase 2: Playwright browser automation | ✅ Complete | |
| Phase 2: RTCPeerConnection interceptor injection | ✅ Complete | addInitScript |
| Phase 2: Socket.IO trigger (Engine.IO v4 raw ws) | ✅ Complete | socket.io-client not required |
| Phase 2: Adaptive wait (PC creation 8s + ICE connection 30s) | ✅ Complete | Replaced old fixed 35s |
| Phase 2: ICE failed/closed immediate exit | ✅ Complete | |
| Phase 3: ICE candidate type analysis + path determination | ✅ Complete | |
| Phase 3: getStats() throughput measurement | ✅ Complete | 5 times × 2s |
| Send webrtc:ice-test-done after test completion | ✅ Complete | App cleanup trigger |

---

## 8. Related Documents

- [RFP_LTS2026_WebRTC_Media_Gateway.md](./RFP_LTS2026_WebRTC_Media_Gateway.md) — mediasoup gateway design
- [README.md](./README.md) — System-wide configuration guide

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for STUN TURN ICE |
