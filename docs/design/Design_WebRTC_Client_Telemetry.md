# DESIGN DOCUMENT
# WebRTC Client Telemetry Relay

| | |
|---|---|
| **Document ID** | DESIGN-LTS-WRTC-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-29 |
| **Parent SRS** | srs/SRS_WebRTC_Media_Gateway.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Telemetry Event Model](#2-telemetry-event-model)
3. [Server Design](#3-server-design)
4. [Client Design](#4-client-design)
5. [Subscription and Query Flow](#5-subscription-and-query-flow)
6. [Buffering and Retention](#6-buffering-and-retention)
7. [Operational Use](#7-operational-use)

---

## 1. Architecture Overview

```
Browser useWebRTC hook
  ├─ emits structured telemetry via Socket.IO
  ├─ reports ICE gathering, connection-state, DTLS, consume, play, retry
  └─ stays non-blocking (telemetry failures never stop media setup)

Server webrtcSignaling.js
  ├─ stores telemetry in a bounded ring buffer
  ├─ broadcasts to a telemetry room for live analysis
  └─ serves recent rows via a Socket.IO query event

Debug / operator client
  ├─ subscribes to the telemetry room
  └─ requests recent logs for post-failure analysis
```

---

## 2. Telemetry Event Model

### 2.1 Client Event Contract

| Field | Type | Notes |
|---|---|---|
| `cameraId` | string | Camera being played |
| `level` | string | `debug`, `info`, `warn`, `error` |
| `event` | string | Stable key such as `connection-state` |
| `message` | string | Human-readable diagnostic text |
| `timestamp` | number | Client-side epoch millis |
| `details` | object | Compact state snapshot |
| `transportId` | string | mediasoup transport ID when available |

### 2.2 Stable Event Keys

- `session-start`
- `ice-gathering`
- `connection-state`
- `dtls-connect`
- `dtls-connected`
- `consume-track`
- `ice-stats`
- `connected-after-consume`
- `awaiting-ice`
- `play-warning`
- `play-deferred`
- `producer-closed`
- `stream-unavailable`
- `pipeline-starting`
- `setup-failed`
- `session-stop`

---

## 3. Server Design

### 3.1 Socket.IO Handlers

The server adds three telemetry handlers alongside the existing WebRTC signaling handlers:

| Event | Direction | Purpose |
|---|---|---|
| `webrtc:client-log` | Client → Server | Receive one structured telemetry record |
| `webrtc:telemetry:subscribe` | Client → Server | Join the telemetry room and receive recent records |
| `webrtc:getClientLogs` | Client → Server | Query buffered telemetry by camera or socket |

### 3.2 In-Memory Buffer

- A bounded ring buffer keeps the most recent WebRTC telemetry entries.
- Each entry is sanitized before storage to avoid oversized strings or circular payloads.
- The buffer is intentionally ephemeral; it supports live diagnosis, not archival compliance.

### 3.3 Live Broadcast

- When a record arrives, the server emits `webrtc:telemetry` to the `webrtc:telemetry` Socket.IO room.
- Operator clients can subscribe to that room without affecting media or signaling state.
- Broadcast failures are ignored so telemetry cannot break the media path.

---

## 4. Client Design

### 4.1 Emission Points

The `useWebRTC` hook emits telemetry at these points:

- session start and session stop
- ICE gathering changes
- transport connection-state changes
- DTLS connect request and ack
- consumer creation and track resume
- `video.play()` warnings or deferrals
- timeout, retry, and pipeline-starting branches
- periodic ICE stats snapshots when connected

### 4.2 Non-Blocking Rule

- Telemetry emission must never await server acknowledgement.
- WebRTC setup and retry logic continue even if the Socket.IO server is unavailable.
- The hook treats telemetry as best-effort diagnostics only.

---

## 5. Subscription and Query Flow

```
Operator socket
  ├─ emit webrtc:telemetry:subscribe
  │    ├─ join room webrtc:telemetry
  │    └─ receive recent buffered entries in ack
  └─ emit webrtc:getClientLogs
       └─ receive filtered array by cameraId or socketId
```

---

## 6. Buffering and Retention

- The buffer stores only recent rows and discards the oldest row when full.
- String values are truncated before storage to protect memory usage.
- The telemetry format is optimized for the last-failure analysis window, not historical reporting.

---

## 7. Operational Use

- Open an admin or debugging client and subscribe to the telemetry room.
- Reproduce a WebRTC failure or reconnect scenario.
- Inspect the relay for the exact sequence of ICE and DTLS states.
- Query the server-side buffer for a filtered history when the failure is not currently active.